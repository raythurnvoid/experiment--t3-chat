import { isAlias, isMap, isScalar, isSeq, parseDocument, type Node as YamlNode } from "yaml";

const FRONTMATTER_START = "---\n";
const FRONTMATTER_REGEX = /^---\n([\s\S]*?)\n---(?:\n|$)/u;
const FIELD_SEGMENT_REGEX = /^[A-Za-z0-9_-]+$/u;

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

export type files_metadata_Value =
	| { qualifiedField: string; valueKind: "string"; value: string }
	| { qualifiedField: string; valueKind: "number"; value: number }
	| { qualifiedField: string; valueKind: "boolean"; value: boolean }
	| { qualifiedField: string; valueKind: "maybe_date"; value: number };

type ExtractedMetadata = {
	fields: string[];
	values: files_metadata_Value[];
};

export type files_metadata_SearchPlan =
	| { op: "exists"; qualifiedField: string }
	| { op: "eq"; qualifiedField: string; value: string | number | boolean }
	| { op: "prefix"; qualifiedField: string; value: string }
	| {
			op: "range";
			qualifiedField: string;
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
const MAYBE_DATE_REGEX = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})?)?$/u;

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
	if (!isScalar(node) || typeof node.value !== "string" || !FIELD_SEGMENT_REGEX.test(node.value)) {
		return null;
	}
	return node.value;
}

function scalar_metadata_value(qualifiedField: string, node: YamlNode | null): files_metadata_Value | null {
	if (!isScalar(node) || node.tag != null) {
		return null;
	}
	const value = node.value;
	if (typeof value === "string") {
		return { qualifiedField, valueKind: "string", value };
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		return { qualifiedField, valueKind: "number", value };
	}
	if (typeof value === "boolean") {
		return { qualifiedField, valueKind: "boolean", value };
	}
	return null;
}

function primitive_value_key(value: files_metadata_Value) {
	return `${value.qualifiedField}\u0000${value.valueKind}\u0000${String(value.value)}`;
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
		qualifiedField: value.qualifiedField,
		valueKind: "maybe_date",
		value: timestamp,
	};
	mut_values.set(primitive_value_key(dateValue), dateValue);
}

function collect_metadata_from_node(args: {
	node: YamlNode | null;
	qualifiedField: string;
	mut_fields: Set<string>;
	mut_values: Map<string, files_metadata_Value>;
}) {
	// Every visited field is searchable by presence; only plain scalars and scalar array items add value indexes.
	args.mut_fields.add(args.qualifiedField);

	if (args.node === null || isAlias(args.node) || args.node.tag != null) {
		return;
	}

	const scalarValue = scalar_metadata_value(args.qualifiedField, args.node);
	if (scalarValue) {
		add_value_with_maybe_date(args.mut_values, scalarValue);
		return;
	}

	if (isSeq(args.node)) {
		for (const item of args.node.items) {
			const itemNode = node_or_null(item);
			const itemValue = scalar_metadata_value(args.qualifiedField, itemNode);
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
				qualifiedField: `${args.qualifiedField}.${segment}`,
				mut_fields: args.mut_fields,
				mut_values: args.mut_values,
			});
		}
	}
}

export function files_metadata_extract_frontmatter(markdown: string): ExtractedMetadata {
	const body = extract_frontmatter_body(markdown);
	if (body === null) {
		return empty_extracted_metadata();
	}

	const doc = parseDocument(normalize_frontmatter_indentation(body), {
		version: "1.2",
		schema: "core",
		// Keep explicit YAML tags unresolved so tagged values become presence-only metadata.
		resolveKnownTags: false,
	});
	if (doc.errors.length > 0) {
		return empty_extracted_metadata();
	}

	const root = doc.contents;
	// Aliases can duplicate values outside the written field path, so treat anchored docs like invalid frontmatter.
	if (!isMap(root) || node_has_anchor_or_alias(root)) {
		return empty_extracted_metadata();
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
			qualifiedField: `frontmatter.${segment}`,
			mut_fields: fields,
			mut_values: values,
		});
	}

	return {
		fields: [...fields],
		values: [...values.values()],
	};
}

// #endregion frontmatter extraction
