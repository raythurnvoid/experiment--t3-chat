import { Document, isAlias, isMap, isScalar, isSeq, parseDocument, type Node as YamlNode } from "yaml";

import { Result } from "common/errors-as-values-utils.ts";
import { files_get_utf8_byte_size } from "./files.ts";

const FRONTMATTER_START = "---\n";
const FRONTMATTER_REGEX = /^---\n([\s\S]*?)\n---(?:\n|$)/u;
export const files_metadata_FIELD_SEGMENT_REGEX = /^[A-Za-z0-9_-]+$/u;

/**
 * Prefix for Markdown frontmatter fields. A save uses this prefix to replace
 * only the frontmatter docs and keep metadata written next to the file.
 */
export const files_metadata_FRONTMATTER_FIELD_PREFIX = "frontmatter.";

/**
 * Prefix for metadata fields written next to a file by a user or an agent.
 * These values do not come from the file's content.
 */
export const files_metadata_METADATA_FIELD_PREFIX = "metadata.";

/**
 * The lowercase copy of a key (`fieldPathLower`), for prefix search without case. It lowers one
 * character at a time, so the copy of a prefix is always a prefix of the key's copy. A whole-string
 * `toLowerCase` depends on context: a Greek sigma at the end lowers to `ς`, inside a word to `σ`.
 */
export function files_metadata_catalog_lower(text: string) {
	return [...text].map((char) => char.toLowerCase()).join("");
}

/**
 * Product cap on how many frontmatter fields one file can index. Each field becomes one metadata
 * doc insert in the save transaction, and the 900 KB content cap alone would allow thousands.
 *
 * Value docs have no matching count limit. Arrays and maybe_date companions can write more than
 * one value doc per field.
 *
 * Do not add a thrown limit check to the insert helpers. Committed inserts run in a workpool that
 * retries forever, so that error would block later files. Follow the byte cap in
 * `files_nodes_content.ts` instead, which reports the failure rather than throwing.
 */
export const files_metadata_MAX_FRONTMATTER_FIELDS = 128;

/**
 * Product cap on the TOTAL metadata docs one file's frontmatter can index: one doc per field
 * plus one doc per value, including every `maybe_date` companion. The field cap alone does not
 * bound this. A single array field with hundreds of unique scalar values (each date-like string
 * adding a companion) would still exceed the per-transaction doc-write limit.
 */
export const files_metadata_MAX_FRONTMATTER_INDEX_DOCUMENTS = 512;

/**
 * Longest field path the index keeps. Search and sort never ask for a longer one, and every value
 * doc copies the path, so a longer frontmatter key keeps its Markdown but gets no index docs.
 */
export const files_metadata_FIELD_PATH_MAX_LENGTH = 160;

/**
 * Longest string value a search can ask for, measured in JavaScript string units. Search copies
 * keep one unit more, or two to keep an emoji whole. A search cannot equal a cut copy, and every
 * supported prefix still matches. Full reads and metadata writes use separate limits.
 */
export const files_metadata_SEARCH_VALUE_MAX_LENGTH = 1024;

export type files_metadata_Value =
	| { fieldPath: string; valueKind: "string"; value: string }
	| { fieldPath: string; valueKind: "number"; value: number }
	| { fieldPath: string; valueKind: "boolean"; value: boolean }
	| { fieldPath: string; valueKind: "maybe_date"; value: number };

type ExtractedMetadata = {
	fields: string[];
	values: files_metadata_Value[];
};

export type files_metadata_SearchPlan =
	| { op: "exists"; fieldPath: string }
	| { op: "eq"; fieldPath: string; value: string | number | boolean }
	| { op: "prefix"; fieldPath: string; value: string }
	| {
			op: "range";
			fieldPath: string;
			/**
			 * Which value docs the range scans: plain numbers, or maybe_date timestamps. Bounds are
			 * always epoch milliseconds for maybe_date; date strings are parsed before the plan is built.
			 */
			valueKind: "number" | "maybe_date";
			gte?: number;
			gt?: number;
			lte?: number;
			lt?: number;
	  };

// #region maybe date

// Keep this regex fully anchored and omit the m flag. A block scalar has a trailing newline, so it
// must not match.
const MAYBE_DATE_REGEX =
	/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})?)?$/u;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * Recognize a date-like string and return its timestamp in epoch milliseconds, or null.
 * The result is a guess from the string shape, which is why the indexed kind is called
 * maybe_date. Only ISO-8601 shapes are accepted: YYYY-MM-DD, optionally followed by a
 * T time with optional seconds, fraction, and Z or +-HH:MM offset.
 *
 * Callers must check `=== null`, never falsiness: 0 is the valid epoch for
 * 1970-01-01T00:00:00Z.
 *
 * Extraction and `meta search` range-bound parsing must share this exact rule, or query
 * bounds could match docs the index never wrote.
 */
export function files_metadata_parse_maybe_date(value: string) {
	const match = MAYBE_DATE_REGEX.exec(value);
	if (!match) {
		return null;
	}
	const [, year, month, day, hour, minute, second, fraction, offset] = match;

	// Validate calendar components from the captures instead of trusting Date.parse to reject
	// them. V8 rolls an invalid day like 2026-02-31 over to the next month instead of returning
	// NaN, and rollover-vs-NaN is implementation-defined across engines.
	const monthNumber = Number(month);
	if (monthNumber < 1 || monthNumber > 12) {
		return null;
	}
	const yearNumber = Number(year);
	const isLeapYear = yearNumber % 4 === 0 && (yearNumber % 100 !== 0 || yearNumber % 400 === 0);
	const daysInMonth = monthNumber === 2 && isLeapYear ? 29 : DAYS_IN_MONTH[monthNumber - 1];
	const dayNumber = Number(day);
	if (dayNumber < 1 || dayNumber > daysInMonth) {
		return null;
	}
	if (hour !== undefined && (Number(hour) > 23 || Number(minute) > 59)) {
		return null;
	}
	if (second !== undefined && Number(second) > 59) {
		return null;
	}
	if (offset !== undefined && offset !== "Z" && (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4, 6)) > 59)) {
		return null;
	}

	// Truncate long fractions to milliseconds because Date.parse only accepts 3 fraction digits.
	// Add Z to an offset-less datetime, which keeps the indexed value independent of the runtime
	// timezone. Leave date-only strings unchanged because Date.parse treats them as UTC.
	let normalized = `${year}-${month}-${day}`;
	if (hour !== undefined) {
		normalized += `T${hour}:${minute}`;
		if (second !== undefined) {
			normalized += `:${second}`;
			if (fraction !== undefined) {
				normalized += `.${fraction.slice(0, 3)}`;
			}
		}
		normalized += offset ?? "Z";
	}
	const timestamp = Date.parse(normalized);
	return Number.isFinite(timestamp) ? timestamp : null;
}

// #endregion maybe date

// #region frontmatter extraction

function empty_extracted_metadata(): ExtractedMetadata {
	return { fields: [], values: [] };
}

function extract_frontmatter_body(markdown: string) {
	if (!markdown.startsWith(FRONTMATTER_START)) {
		return null;
	}
	return FRONTMATTER_REGEX.exec(markdown)?.[1] ?? null;
}

function normalize_frontmatter_indentation(body: string) {
	return body
		.split("\n")
		.map((line) => {
			// Normalize visual indentation only; NBSPs inside scalar values are user content.
			const indentation = /^[ \u00a0]+(?=(?:-\s|[A-Za-z0-9_-]+:))/u.exec(line)?.[0];
			if (!indentation || !indentation.includes("\u00a0")) {
				return line;
			}
			return `${indentation.replaceAll("\u00a0", " ")}${line.slice(indentation.length)}`;
		})
		.join("\n");
}

function node_or_null(value: unknown): YamlNode | null {
	if (value === null || isAlias(value) || isScalar(value) || isMap(value) || isSeq(value)) {
		return value;
	}
	return null;
}

function node_has_anchor_or_alias(node: YamlNode | null): boolean {
	if (node === null) {
		return false;
	}
	if (isAlias(node)) {
		return true;
	}
	if ("anchor" in node && typeof node.anchor === "string" && node.anchor.length > 0) {
		return true;
	}
	if (isMap(node)) {
		return node.items.some(
			(pair) => node_has_anchor_or_alias(node_or_null(pair.key)) || node_has_anchor_or_alias(node_or_null(pair.value)),
		);
	}
	if (isSeq(node)) {
		return node.items.some((item) => node_has_anchor_or_alias(node_or_null(item)));
	}
	return false;
}

function scalar_key_segment(node: YamlNode | null) {
	if (!isScalar(node) || typeof node.value !== "string" || !files_metadata_FIELD_SEGMENT_REGEX.test(node.value)) {
		return null;
	}
	return node.value;
}

function scalar_metadata_value(fieldPath: string, node: YamlNode | null): files_metadata_Value | null {
	if (!isScalar(node) || node.tag != null) {
		return null;
	}
	const value = node.value;
	if (typeof value === "string") {
		return { fieldPath, valueKind: "string", value };
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		return { fieldPath, valueKind: "number", value };
	}
	if (typeof value === "boolean") {
		return { fieldPath, valueKind: "boolean", value };
	}
	return null;
}

// Cut a long string to one character more than a search value can have. Never end on half of a
// surrogate pair: the cut value must stay longer than any search value.
function index_string_value(value: string) {
	const end = files_metadata_SEARCH_VALUE_MAX_LENGTH + 1;
	if (value.length <= end) {
		return value;
	}
	const last = value.charCodeAt(end - 1);
	return value.slice(0, last >= 0xd800 && last <= 0xdbff ? end + 1 : end);
}

/**
 * Keep a table preview short without changing its scalar type.
 */
export function files_metadata_scalar_preview(value: string | number | boolean) {
	if (typeof value !== "string") {
		return { value, isPreview: false };
	}

	let end = 0;
	let count = 0;
	for (const character of value) {
		if (count === 256) {
			return { value: value.slice(0, end), isPreview: true };
		}
		end += character.length;
		count++;
	}
	return { value, isPreview: false };
}

function primitive_value_key(value: files_metadata_Value) {
	return `${value.fieldPath}\u0000${value.valueKind}\u0000${String(value.value)}`;
}

// Keep the string value searchable as before, and add one maybe_date companion value when the
// string looks like a date, so the field also supports date-range search. Two spellings of the
// same instant dedupe into one maybe_date value through the valueKind-namespaced key.
function add_value_with_maybe_date(mut_values: Map<string, files_metadata_Value>, value: files_metadata_Value) {
	mut_values.set(primitive_value_key(value), value);

	if (value.valueKind !== "string") {
		return;
	}
	const timestamp = files_metadata_parse_maybe_date(value.value);
	if (timestamp === null) {
		return;
	}
	const dateValue: files_metadata_Value = {
		fieldPath: value.fieldPath,
		valueKind: "maybe_date",
		value: timestamp,
	};
	mut_values.set(primitive_value_key(dateValue), dateValue);
}

/**
 * Build short search copies after full values have been read and deduplicated.
 */
export function files_metadata_search_values(metadata: {
	fields: readonly string[];
	values: readonly files_metadata_Value[];
}): ExtractedMetadata {
	const fields = metadata.fields.filter((fieldPath) => fieldPath.length <= files_metadata_FIELD_PATH_MAX_LENGTH);
	const values = new Map<string, files_metadata_Value>();
	for (const value of metadata.values) {
		if (value.fieldPath.length > files_metadata_FIELD_PATH_MAX_LENGTH) {
			continue;
		}
		const searchValue = value.valueKind === "string" ? { ...value, value: index_string_value(value.value) } : value;
		values.set(primitive_value_key(searchValue), searchValue);
	}
	return { fields, values: [...values.values()] };
}

function collect_metadata_from_node(args: {
	node: YamlNode | null;
	fieldPath: string;
	mut_fields: Set<string>;
	mut_values: Map<string, files_metadata_Value>;
}) {
	// A longer key is never searched, and its nested keys are longer still.
	if (args.fieldPath.length > files_metadata_FIELD_PATH_MAX_LENGTH) {
		return;
	}
	// Every visited field is searchable by presence; only plain scalars and scalar array items add value indexes.
	args.mut_fields.add(args.fieldPath);

	if (args.node === null || isAlias(args.node) || args.node.tag != null) {
		return;
	}

	const scalarValue = scalar_metadata_value(args.fieldPath, args.node);
	if (scalarValue) {
		add_value_with_maybe_date(args.mut_values, scalarValue);
		return;
	}

	if (isSeq(args.node)) {
		for (const item of args.node.items) {
			const itemNode = node_or_null(item);
			const itemValue = scalar_metadata_value(args.fieldPath, itemNode);
			if (itemValue) {
				add_value_with_maybe_date(args.mut_values, itemValue);
			}
		}
		return;
	}

	if (isMap(args.node)) {
		for (const pair of args.node.items) {
			const segment = scalar_key_segment(node_or_null(pair.key));
			if (!segment) {
				continue;
			}
			collect_metadata_from_node({
				node: node_or_null(pair.value),
				fieldPath: `${args.fieldPath}.${segment}`,
				mut_fields: args.mut_fields,
				mut_values: args.mut_values,
			});
		}
	}
}

export function files_metadata_extract_frontmatter(markdown: string) {
	const body = extract_frontmatter_body(markdown);
	if (body === null) {
		return Result({ _yay: empty_extracted_metadata() });
	}

	// The parser reads one nesting level by calling itself again, and it sets no depth limit. Deep
	// enough frontmatter fills the stack and throws. The depth that does it depends on the runtime:
	// Node gives up around 1000 levels, the Convex runtime reads 1000 and throws by 5000 (both
	// measured 2026-08-18). Flow style needs no indentation, so 5000 levels of `a: {b: {b: ...` fit
	// in 25 KB. The byte caps do not stop it, because the file is small and only its depth is big.
	// Every caller below is a file save, so an escaping throw would fail the save itself and the
	// user could not store their own text.
	//
	// Report it instead of throwing, and keep it separate from the `doc.errors` case below. Broken
	// YAML really has no metadata, so returning nothing for it is right. Here the frontmatter may
	// be perfectly good and we simply could not read it, so the file loses metadata it should have
	// had. Each caller decides what that is worth.
	//
	// Catch everything: the thrown type changes with the parser options (`RangeError` with these,
	// `SyntaxError` with others), so matching on the type would miss cases.
	let doc: ReturnType<typeof parseDocument>;
	try {
		doc = parseDocument(normalize_frontmatter_indentation(body), {
			version: "1.2",
			schema: "core",
			// Keep explicit YAML tags unresolved so tagged values become presence-only metadata.
			resolveKnownTags: false,
		});
	} catch (error) {
		return Result({ _nay: { message: "Failed to parse frontmatter", cause: error } });
	}

	if (doc.errors.length > 0) {
		return Result({ _yay: empty_extracted_metadata() });
	}

	const root = doc.contents;
	// Aliases can duplicate values outside the written field path, so treat anchored docs like invalid frontmatter.
	if (!isMap(root) || node_has_anchor_or_alias(root)) {
		return Result({ _yay: empty_extracted_metadata() });
	}

	const fields = new Set<string>();
	const values = new Map<string, files_metadata_Value>();
	for (const pair of root.items) {
		const segment = scalar_key_segment(node_or_null(pair.key));
		if (!segment) {
			continue;
		}
		collect_metadata_from_node({
			node: node_or_null(pair.value),
			fieldPath: `${files_metadata_FRONTMATTER_FIELD_PREFIX}${segment}`,
			mut_fields: fields,
			mut_values: values,
		});
	}

	return Result({
		_yay: {
			fields: [...fields],
			values: [...values.values()],
		},
	});
}

/**
 * The one pure extraction/preflight both save paths run BEFORE any canonical write. It returns
 * full values for previews, short search copies, and the counts the index caps gate on. The
 * index-document count includes one doc per field and value, including `maybe_date` companions.
 * Committed materialization settles a marker and pending creation/rebase returns a refusal when
 * either count is over. The insert helpers keep their late throws only as impossible backstops.
 *
 * Returns `_nay` when the frontmatter could not be parsed at all. Save paths must not fail on it:
 * index no frontmatter and let the file save.
 */
export function files_metadata_preflight_frontmatter(markdown: string) {
	const extracted = files_metadata_extract_frontmatter(markdown);
	if (extracted._nay) {
		return extracted;
	}

	const fullMetadata = extracted._yay;
	const metadata = files_metadata_search_values(fullMetadata);
	return Result({
		_yay: {
			fullMetadata,
			metadata,
			fieldCount: metadata.fields.length,
			indexDocumentCount: metadata.fields.length + metadata.values.length,
		},
	});
}

export function files_metadata_frontmatter_exceeds_index_caps(preflight: {
	fieldCount: number;
	indexDocumentCount: number;
}) {
	return (
		preflight.fieldCount > files_metadata_MAX_FRONTMATTER_FIELDS ||
		preflight.indexDocumentCount > files_metadata_MAX_FRONTMATTER_INDEX_DOCUMENTS
	);
}

// #endregion frontmatter extraction

// #region metadata entries

/**
 * Product cap on how many metadata keys one file can carry. Each key writes one field doc and one
 * value doc, and a date-like string value adds one maybe_date companion, so 128 keys write at most
 * 384 index docs. That stays under the frontmatter index-document cap above.
 */
const MAX_METADATA_KEYS = 128;

/**
 * The key becomes part of `fieldPath`, an equality field in every search index.
 */
const MAX_METADATA_KEY_LENGTH = 128;

/**
 * Full metadata text can hold up to 32 KiB of valid UTF-8. Search copies stay short.
 */
export const files_metadata_MAX_STRING_VALUE_BYTES = 32 * 1024;

/**
 * Cap on the whole YAML document the modal sends, checked before anything parses it. The agent
 * writes entries instead of YAML, so its door measures the document those entries would make.
 */
export const files_metadata_MAX_YAML_BYTES = 128 * 1024;

/**
 * Metadata keys are conventions, not rules, so this grammar is deliberately wide: `created-by` and
 * `città` are both ordinary keys, because letters are not limited to English. The dot is left out,
 * because `metadata.a.b` would read like the real nesting that `frontmatter.a.b` means. The colon
 * is left out, because the search bars split a field from its operator and value at the first
 * colon, so a key never needs quotes there.
 *
 * `bash-meta-command.ts` (`meta search`) and `files-search-query.ts` (the search box) import this
 * grammar, so a key a user can write stays a key that can be searched for.
 */
export const files_metadata_METADATA_KEY_REGEX = /^[\p{L}\p{N}_-]+$/u;

/**
 * One metadata key and its scalar value. The map is flat: no nesting, no arrays, no null.
 */
export type files_metadata_Entry = {
	key: string;
	value: string | number | boolean;
};

/**
 * Read one YAML scalar as a metadata value, or return null when it is not a plain scalar.
 *
 * YAML 1.2 core resolves `1.10` to 1.1, `0x10` to 16, and `010` to 10. Storing those numbers would
 * not give the user back the text they typed, and a version or an id written that way would change
 * meaning. So when the number printed back is not the same text the user typed, keep the raw text
 * as a string instead. `Scalar.source` is the exact text the user wrote.
 *
 * Booleans do not get that treatment. `True` resolves to true and only the capital letter is lost,
 * so keeping the text would turn a value the user meant as a boolean into a string that
 * `meta search --where '{"eq":[...,true]}'` can never find.
 */
function scalar_entry_value(node: YamlNode | null) {
	if (!isScalar(node) || node.tag != null) {
		return null;
	}

	const value = node.value;
	if (typeof value === "string" || typeof value === "boolean") {
		return value;
	}
	if (typeof value === "number") {
		const source = node.source ?? String(value);
		return String(value) === source ? value : source;
	}

	return null;
}

/**
 * Apply an agent's set/remove request to the map the file has now.
 *
 * A key that already exists keeps its position, so setting one key does not reshuffle the YAML the
 * user sees in the modal. New keys are appended where the agent first named them.
 */
export function files_metadata_apply_set_and_remove(
	currentEntries: files_metadata_Entry[],
	args: { set: files_metadata_Entry[]; remove: string[] },
) {
	const removedKeys = new Set(args.remove);
	// A key the agent listed twice keeps its last value, whether or not the file already has that key.
	const setByKey = new Map(args.set.map((entry) => [entry.key, entry.value]));

	// A key listed in both set and remove is removed. Remove wins, so a confused call can never leave
	// behind a key the agent asked to delete.
	const entries = currentEntries
		.filter((entry) => !removedKeys.has(entry.key))
		.map((entry) => (setByKey.has(entry.key) ? { key: entry.key, value: setByKey.get(entry.key)! } : entry));

	const existingKeys = new Set(entries.map((entry) => entry.key));
	for (const [key, value] of setByKey) {
		if (!existingKeys.has(key) && !removedKeys.has(key)) {
			existingKeys.add(key);
			entries.push({ key, value });
		}
	}

	return entries;
}

/**
 * Say what is wrong with one metadata key, or return null when the key is fine.
 */
function metadata_key_problem(key: string) {
	// Check the length before any message quotes the key, so an oversized key is never echoed back.
	if (key.length > MAX_METADATA_KEY_LENGTH) {
		return `Metadata keys must be at most ${MAX_METADATA_KEY_LENGTH} characters`;
	}

	// `meta get` and `meta search` print the search field name `metadata.<key>`. A caller who copies
	// that name into a write sends a key that can never exist. Name the bare key to pass, because the
	// grammar message below does not explain this mistake.
	if (key.startsWith(files_metadata_METADATA_FIELD_PREFIX)) {
		const bareKey = key.slice(files_metadata_METADATA_FIELD_PREFIX.length);
		return `Metadata key "${key}" is a search field name. Pass the bare key "${bareKey}" instead`;
	}
	if (!files_metadata_METADATA_KEY_REGEX.test(key)) {
		return `Metadata key "${key}" may contain only letters, numbers, "_" and "-"`;
	}

	return null;
}

/**
 * Check the keys a caller asked to remove.
 *
 * A removed key is never stored, so nothing downstream ever looks at it. Without this check a key
 * that cannot exist removes nothing and the call still reports success, which reads as "the key is
 * still there" to whoever asked.
 */
export function files_metadata_validate_remove_keys(removeKeys: string[]) {
	for (const key of removeKeys) {
		const problem = metadata_key_problem(key);
		if (problem !== null) {
			return Result({ _nay: { message: problem } });
		}
	}

	return Result({ _yay: removeKeys });
}

/**
 * Check a flat metadata map against the product caps and the key grammar.
 *
 * Both write doors run this: the modal's YAML goes through the parser below, and the agent's
 * set/remove goes through here directly, so one rule set covers both.
 */
export function files_metadata_validate_entries(entries: files_metadata_Entry[]) {
	if (entries.length > MAX_METADATA_KEYS) {
		return Result({ _nay: { message: `Metadata can have at most ${MAX_METADATA_KEYS} keys` } });
	}

	const seenKeys = new Set<string>();
	for (const entry of entries) {
		const problem = metadata_key_problem(entry.key);
		if (problem !== null) {
			return Result({ _nay: { message: problem } });
		}
		if (seenKeys.has(entry.key)) {
			return Result({ _nay: { message: `Metadata key "${entry.key}" is set twice` } });
		}
		seenKeys.add(entry.key);

		const value = entry.value;
		if (typeof value === "string") {
			if (!value.isWellFormed()) {
				return Result({ _nay: { message: `Metadata key "${entry.key}" must have valid Unicode text` } });
			}
			if (files_get_utf8_byte_size(value) > files_metadata_MAX_STRING_VALUE_BYTES) {
				return Result({
					_nay: {
						message: `Metadata key "${entry.key}" must have a text value of at most ${files_metadata_MAX_STRING_VALUE_BYTES / 1024} KiB in UTF-8`,
					},
				});
			}
		}

		if (typeof value === "number" && !Number.isFinite(value)) {
			return Result({ _nay: { message: `Metadata key "${entry.key}" must have a finite number value` } });
		}
	}

	// The modal caps the YAML document it sends, so the agent must respect that same cap. Otherwise the
	// agent could write a map that the modal renders but refuses to save, and the user would have to
	// delete somebody else's keys to fix their own typo. Measure the document both doors would show.
	if (files_get_utf8_byte_size(files_metadata_stringify_entries_yaml(entries)) > files_metadata_MAX_YAML_BYTES) {
		return Result({
			_nay: { message: `Metadata must be at most ${files_metadata_MAX_YAML_BYTES / 1024} KiB when written as YAML` },
		});
	}

	return Result({ _yay: { entries } });
}

/**
 * Parse the YAML typed in the Properties modal into the flat map that gets stored.
 *
 * YAML is only the edit format, so this runs on the server too: the modal runs it first to show a
 * mistake without spending a rate-limit token, and the mutation runs it again as the real door.
 * Every `_nay.message` here is shown to the user as written.
 */
export function files_metadata_parse_entries_yaml(metadataYaml: string) {
	// Cap the bytes first. Every message below can quote a key, and this is what bounds it.
	if (files_get_utf8_byte_size(metadataYaml) > files_metadata_MAX_YAML_BYTES) {
		return Result({
			_nay: { message: `Metadata must be at most ${files_metadata_MAX_YAML_BYTES / 1024} KiB when written as YAML` },
		});
	}

	// The parser walks nested collections with recursion, so a deeply nested document overflows the
	// stack and throws instead of reporting an error. The byte cap does not stop it: 2000 nested `{`
	// fit in 4 KB. A user can paste anything into the modal, so answer with a refusal instead of
	// crashing the modal or failing the mutation with an unexpected error.
	let doc: ReturnType<typeof parseDocument>;
	try {
		doc = parseDocument(metadataYaml, {
			// Pin YAML 1.2 core. Under it `yes`, `no`, `on` and `2026-08-18` stay plain strings. An older
			// version or a wider schema would read them as booleans and dates, so a stored value would
			// change meaning. The stringifier below pins the same pair.
			version: "1.2",
			schema: "core",
			// Keep explicit YAML tags unresolved so this strict app-owned format can refuse them.
			resolveKnownTags: false,
		});
	} catch {
		return Result({ _nay: { message: "Metadata must be valid YAML" } });
	}

	if (doc.errors.length > 0) {
		// The library appends the offending lines and a caret under the message. That frame loses its
		// shape once HTML collapses the whitespace, so keep the first line, which names line and column.
		const [firstLine] = doc.errors[0]!.message.split("\n");
		return Result({ _nay: { message: `Metadata must be valid YAML: ${firstLine}` } });
	}

	const entries: files_metadata_Entry[] = [];

	const root = doc.contents;
	// An empty editor means the file has no metadata. An empty document parses to a null scalar.
	if (root === null || (isScalar(root) && root.value === null)) {
		return Result({ _yay: { entries } });
	}
	if (!isMap(root)) {
		return Result({ _nay: { message: "Metadata must be a YAML map of keys to values" } });
	}

	for (const pair of root.items) {
		const keyNode = node_or_null(pair.key);
		if (!isScalar(keyNode) || keyNode.tag != null) {
			return Result({ _nay: { message: "Metadata keys must be plain text" } });
		}

		// A metadata key is always text, but YAML types an unquoted `2026` as a number and `true` as a
		// boolean. Take the text the user wrote, so a year or an id works without quoting it.
		const key = typeof keyNode.value === "string" ? keyNode.value : (keyNode.source ?? "");

		const value = scalar_entry_value(node_or_null(pair.value));
		if (value === null) {
			return Result({
				_nay: { message: `Metadata key "${key}" must have a text, number, or true/false value` },
			});
		}

		entries.push({ key, value });
	}

	return files_metadata_validate_entries(entries);
}

/**
 * Write the stored map back as the YAML the modal edits. Keys keep the order they were stored in.
 *
 * Build the document with `Document.set` instead of a plain object, so a key such as `__proto__`
 * stays an ordinary key.
 */
export function files_metadata_stringify_entries_yaml(entries: files_metadata_Entry[]) {
	if (entries.length === 0) {
		return "";
	}

	// Same version and schema as the parser, so what the modal shows parses back to the same map.
	const doc = new Document({}, { version: "1.2", schema: "core" });
	for (const entry of entries) {
		doc.set(entry.key, entry.value);
	}

	// Keep every value on one line, so the text the modal shows parses back to the same map.
	return doc.toString({ lineWidth: 0 });
}

function metadata_index_value(fieldPath: string, value: files_metadata_Entry["value"]): files_metadata_Value {
	if (typeof value === "string") {
		return { fieldPath, valueKind: "string", value };
	}
	if (typeof value === "number") {
		return { fieldPath, valueKind: "number", value };
	}

	return { fieldPath, valueKind: "boolean", value };
}

/**
 * Read full scalar values from one file's metadata. A date-like string also gets the maybe_date
 * companion that range search needs, exactly like frontmatter. Search writers project these values
 * through `files_metadata_search_values` before storing index docs.
 */
export function files_metadata_extract_entries(entries: files_metadata_Entry[]) {
	const fields: string[] = [];
	const values = new Map<string, files_metadata_Value>();
	for (const entry of entries) {
		const fieldPath = `${files_metadata_METADATA_FIELD_PREFIX}${entry.key}`;
		fields.push(fieldPath);
		add_value_with_maybe_date(values, metadata_index_value(fieldPath, entry.value));
	}

	return { fields, values: [...values.values()] };
}

// #endregion metadata entries
