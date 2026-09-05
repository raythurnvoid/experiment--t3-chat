// The search box language. A query is a list of whitespace-separated tokens. A token that reads
// `key:value` is a filter. Every other token is free text, and the free text keeps today's shape
// rules (name, path, node id, pasted link) in the sidebar.
//
// Filters:
// - `status:open` equality. `status:*` the key exists. `title:Recall*` string prefix, and
//   `title:"Recall the"*` for a prefix with spaces.
// - `priority:>2`, `due:<=2026-09-30` ranges on numbers or ISO dates.
// - `!status:done` negation. `assignee:"Denys Voloshyn"` quotes a value with spaces.
// - `"slack:message-id":123` quotes a key that holds a colon.
// - `file.path:/tasks`, `file.name:x`, `file.ext:md`, `file.kind:folder`, `file.updated:>DATE`
//   filter on file fields. `frontmatter.x` and `metadata.x` name one namespace. A bare key asks
//   both metadata kinds.
//
// The first dotted segment `file`, `frontmatter` and `metadata` is reserved. A frontmatter key
// literally named `file` is written `frontmatter.file`.
//
// A query holds at most `files_search_query_MAX_FILTERS` filters. The search box runs one server
// query per filter, so a pasted link with thousands of `key:value` tokens must not open thousands
// of subscriptions. Filters past the cap keep a `problem` and run nothing.
import {
	files_metadata_FIELD_SEGMENT_REGEX,
	files_metadata_FRONTMATTER_FIELD_PREFIX,
	files_metadata_METADATA_FIELD_PREFIX,
	files_metadata_METADATA_KEY_REGEX,
	files_metadata_parse_maybe_date,
	type files_metadata_SearchPlan,
} from "./files-metadata.ts";

export const files_search_query_MAX_FILTERS = 20;

export const files_search_query_FILE_FIELDS = ["path", "name", "ext", "kind", "updated"] as const;

export type files_search_query_Key = {
	/**
	 * `any` is a bare key: it asks `frontmatter.<name>` and `metadata.<name>` together.
	 */
	namespace: "file" | "frontmatter" | "metadata" | "any";
	name: string;
};

type FilterMatch =
	| { op: "exists" }
	| {
			op: "eq";
			value: string;
			/**
			 * A quoted value asks for the string kind only. An unquoted `3` also asks for the number 3.
			 */
			quoted: boolean;
	  }
	| { op: "prefix"; value: string }
	| { op: "range"; comparator: "gt" | "gte" | "lt" | "lte"; value: string };

export type files_search_query_Filter = {
	/**
	 * The exact token text. Serializing writes it back unchanged, so the `q` URL param round-trips.
	 */
	raw: string;
	negated: boolean;
	key: files_search_query_Key;
	match: FilterMatch;
	/**
	 * Why the filter cannot run, in user-facing words, or null when it can. An invalid filter is
	 * shown as a chip with this reason and matches nothing.
	 */
	problem: string | null;
};

type ParsedQuery = {
	filters: files_search_query_Filter[];
	/**
	 * The free-text tokens joined by one space.
	 */
	text: string;
	/**
	 * True when the query ends inside an open quote. Space must not commit a chip then, because the
	 * user is still typing the quoted value. Enter commits what was typed, with the quote closed.
	 */
	openQuote: boolean;
};

const KEY_REGEX = /^[\p{L}\p{N}_][\p{L}\p{N}_.-]*$/u;
// The YAML core schema's number and boolean spellings, so a value the frontmatter parser stored as
// a number or a boolean (`.5`, `1e3`, `0x10`, `True`) can be typed the same way in a filter.
// `Number()` reads every spelling here, the hex and octal ones included.
const NUMBER_LITERAL_REGEX = /^(?:[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|0o[0-7]+|0x[0-9a-fA-F]+)$/u;
const BOOLEAN_LITERALS = new Map([
	["true", true],
	["True", true],
	["TRUE", true],
	["false", false],
	["False", false],
	["FALSE", false],
]);
const DATE_ONLY_LITERAL_REGEX = /^\d{4}-\d{2}-\d{2}$/u;
// A date with a time and no zone, like `2026-09-04T10:00`. `files_metadata_parse_maybe_date`
// reads it as UTC. `file.updated` reads it as local time.
const LOCAL_TIME_LITERAL_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/u;
const MAX_FILTERS_PROBLEM = `At most ${files_search_query_MAX_FILTERS} filters in one search`;
const FILE_FIELD_PREFIX = "file.";
const RANGE_COMPARATORS = [
	["gte", ">="],
	["lte", "<="],
	["gt", ">"],
	["lt", "<"],
] as const;
const FILE_FIELDS = new Set<string>(files_search_query_FILE_FIELDS);
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// #region tokenizer

/**
 * Split on whitespace, keeping quoted runs together. Each token keeps its exact source text.
 */
function split_tokens(query: string) {
	const tokens: string[] = [];
	let start = -1;
	let inQuote = false;

	for (let index = 0; index < query.length; index++) {
		const char = query[index];
		if (inQuote) {
			// A backslash escapes the next char inside quotes, so `\"` does not close the quote.
			if (char === "\\") {
				index++;
			} else if (char === '"') {
				inQuote = false;
			}
			continue;
		}
		if (char === '"') {
			inQuote = true;
			if (start < 0) {
				start = index;
			}
			continue;
		}
		if (char === " " || char === "\t" || char === "\n" || char === "\r") {
			if (start >= 0) {
				tokens.push(query.slice(start, index));
				start = -1;
			}
			continue;
		}
		if (start < 0) {
			start = index;
		}
	}
	if (start >= 0) {
		tokens.push(query.slice(start));
	}

	return { tokens, openQuote: inQuote };
}

/**
 * Read one quoted string that starts at `start`. Returns the unescaped text and the index right
 * after the closing quote. An unterminated quote runs to the end of the token.
 */
function read_quoted(token: string, start: number) {
	let text = "";
	let index = start + 1;
	while (index < token.length) {
		const char = token[index];
		// Only a quote and a backslash can be escaped. Any other backslash is text, so a typed
		// Windows path keeps its backslashes.
		if (char === "\\" && (token[index + 1] === '"' || token[index + 1] === "\\")) {
			text += token[index + 1];
			index += 2;
			continue;
		}
		if (char === '"') {
			return { text, end: index + 1 };
		}
		text += char;
		index++;
	}
	return { text, end: token.length };
}

/**
 * Close a quote the user left open, for the last token of a query. A backslash right before the
 * added quote would escape it, so an unescaped trailing backslash is escaped first.
 */
function close_open_quote(token: string) {
	const trailingBackslashes = /\\*$/u.exec(token)![0].length;
	return trailingBackslashes % 2 === 1 ? `${token}\\"` : `${token}"`;
}

/**
 * Split a token into its key part and value part, or return null when it is free text. The key
 * is either a quoted string or a run of key characters, and it must be followed by `:`.
 */
function split_key_value(token: string) {
	// A pasted app link is free text. The sidebar unwraps it into the node id or path it carries,
	// and the `:` after `http` must not turn it into a filter on the key `http`.
	if (token.startsWith("http://") || token.startsWith("https://")) {
		return null;
	}

	const negated = token.startsWith("!");
	let index = negated ? 1 : 0;
	let key: string;

	// A quoted key skips the key grammar here: quotes exist for keys that hold a colon, and
	// `parse_key` still checks the name against each metadata kind's own grammar. The quotes may
	// wrap the whole key or only the part after a typed namespace: `"metadata.a:b":x` and
	// `metadata."a:b":x` are the same filter.
	const quotedNamespace = /^(?:frontmatter|metadata)\.(?=")/u.exec(token.slice(index))?.[0] ?? "";
	const quotedKey = token[index + quotedNamespace.length] === '"';
	if (quotedKey) {
		const quoted = read_quoted(token, index + quotedNamespace.length);
		key = `${quotedNamespace}${quoted.text}`;
		index = quoted.end;
	} else {
		const colonIndex = token.indexOf(":", index);
		if (colonIndex < 0) {
			return null;
		}
		key = token.slice(index, colonIndex);
		if (!KEY_REGEX.test(key)) {
			return null;
		}
		index = colonIndex;
	}

	if (key.length === 0 || token[index] !== ":") {
		return null;
	}

	return { negated, key, value: token.slice(index + 1) };
}

// #endregion tokenizer

// #region key and value rules

function frontmatter_name_is_valid(name: string) {
	return name.split(".").every((segment) => files_metadata_FIELD_SEGMENT_REGEX.test(segment));
}

function metadata_name_is_valid(name: string) {
	return files_metadata_METADATA_KEY_REGEX.test(name);
}

/**
 * True when a stored qualified field (`frontmatter.<path>` or `metadata.<key>`) is one this
 * grammar can name. The search doors refuse any other field, because the app never sends one.
 */
export function files_search_query_qualified_field_is_valid(qualifiedField: string) {
	if (qualifiedField.startsWith(files_metadata_FRONTMATTER_FIELD_PREFIX)) {
		return frontmatter_name_is_valid(qualifiedField.slice(files_metadata_FRONTMATTER_FIELD_PREFIX.length));
	}
	if (qualifiedField.startsWith(files_metadata_METADATA_FIELD_PREFIX)) {
		return metadata_name_is_valid(qualifiedField.slice(files_metadata_METADATA_FIELD_PREFIX.length));
	}
	return false;
}

function parse_key(key: string): { key: files_search_query_Key; problem: string | null } {
	if (key.startsWith(FILE_FIELD_PREFIX)) {
		const name = key.slice(FILE_FIELD_PREFIX.length);
		return {
			key: { namespace: "file", name },
			problem: FILE_FIELDS.has(name)
				? null
				: `Unknown file field. Use ${files_search_query_FILE_FIELDS.map((field) => `file.${field}`).join(", ")}`,
		};
	}
	if (key.startsWith(files_metadata_FRONTMATTER_FIELD_PREFIX)) {
		const name = key.slice(files_metadata_FRONTMATTER_FIELD_PREFIX.length);
		return {
			key: { namespace: "frontmatter", name },
			problem: frontmatter_name_is_valid(name) ? null : "Frontmatter keys use letters, digits, _ and -, joined by dots",
		};
	}
	if (key.startsWith(files_metadata_METADATA_FIELD_PREFIX)) {
		const name = key.slice(files_metadata_METADATA_FIELD_PREFIX.length);
		return {
			key: { namespace: "metadata", name },
			problem: metadata_name_is_valid(name) ? null : "Metadata keys use letters, digits, _, - and :",
		};
	}
	// Quoting a key the grammar refuses does not help, so the message never says to quote it.
	return {
		key: { namespace: "any", name: key },
		problem:
			frontmatter_name_is_valid(key) || metadata_name_is_valid(key)
				? null
				: "Keys use letters, digits, _, - and :. Dots join the parts of a frontmatter key",
	};
}

function parse_value(value: string): { match: FilterMatch; problem: string | null } {
	if (value === "*") {
		return { match: { op: "exists" }, problem: null };
	}

	for (const [comparator, symbol] of RANGE_COMPARATORS) {
		if (!value.startsWith(symbol)) {
			continue;
		}
		const literal = value.slice(symbol.length);
		const isNumber = NUMBER_LITERAL_REGEX.test(literal);
		const isDate = files_metadata_parse_maybe_date(literal) !== null;
		let problem: string | null = null;
		if (!isNumber && !isDate) {
			// `priority:> 2` ends the token at the space, so the bound is missing, not wrong.
			if (literal.length === 0) {
				problem = `Put the number or the date right after ${symbol}, like priority:${symbol}2`;
			} else if (literal.startsWith('"') || literal.startsWith("'")) {
				// The generic hint says to quote the value. That points the wrong way when it already is.
				problem = `Ranges take the number or the date without quotes, like priority:${symbol}2`;
			} else {
				problem = "Ranges need a number or a date like 2026-09-04. Quote the value to search it as text";
			}
		}
		return { match: { op: "range", comparator, value: literal }, problem };
	}

	// Single quotes are not quotes here, so `assignee:'Denys Voloshyn'` would end at the space and
	// search for `'Denys` with no warning. A `!` or `=` on the value side is a habit from other
	// search boxes: negation goes before the key, and a plain value is already an exact match.
	if (value.startsWith("'")) {
		return {
			match: { op: "eq", value, quoted: false },
			problem: 'Use double quotes, like status:"in progress"',
		};
	}
	if (value.startsWith("!")) {
		return {
			match: { op: "eq", value, quoted: false },
			problem: "Put ! before the key, like !status:done",
		};
	}
	if (value.startsWith("=")) {
		return {
			match: { op: "eq", value, quoted: false },
			problem: "Drop the =. A plain value is an exact match, like priority:2",
		};
	}

	if (value.startsWith('"')) {
		const quoted = read_quoted(value, 0);
		// A `*` right after the closing quote asks for a prefix, like `Recall*` does for one word.
		if (quoted.text.length > 0 && quoted.end === value.length - 1 && value[quoted.end] === "*") {
			return { match: { op: "prefix", value: quoted.text }, problem: null };
		}
		// `""` stays a value: a stored empty string is listed by the value catalog and must be
		// searchable back.
		return {
			match: { op: "eq", value: quoted.text, quoted: true },
			problem: quoted.end !== value.length ? "Nothing can follow the closing quote" : null,
		};
	}

	if (value.length === 0) {
		return {
			match: { op: "eq", value: "", quoted: false },
			problem: "Filter needs a value right after the colon. Use * for any value",
		};
	}

	if (value.endsWith("*") && value.length > 1) {
		return { match: { op: "prefix", value: value.slice(0, -1) }, problem: null };
	}

	return { match: { op: "eq", value, quoted: false }, problem: null };
}

/**
 * The local start and end of a day literal such as `2026-09-04`, or null for any other value. The
 * end is the next day's start, so a daylight-saving change does not shorten or stretch the day.
 */
function local_day_bounds(value: string) {
	if (!DATE_ONLY_LITERAL_REGEX.test(value) || files_metadata_parse_maybe_date(value) === null) {
		return null;
	}
	const [year, month, day] = value.split("-").map(Number) as [number, number, number];
	return { start: new Date(year, month - 1, day).getTime(), end: new Date(year, month - 1, day + 1).getTime() };
}

/**
 * File fields have their own rules: a path is a folder, a kind is one of two words, and the
 * updated time is a day or a range.
 */
function file_field_problem(name: string, match: FilterMatch) {
	// Elsewhere a range bound can be a number or a date. An updated time is always a date, so
	// `file.updated:>2026` does not pass as a number, and `file.updated:>abc` gets this message
	// instead of the generic range hint.
	if (name === "updated") {
		if (match.op === "eq" && local_day_bounds(match.value) !== null) {
			return null;
		}
		if (match.op === "range" && files_metadata_parse_maybe_date(match.value) !== null) {
			return null;
		}
		return "file.updated needs a day like file.updated:2026-09-04 or a range like file.updated:>2026-09-01";
	}
	if (match.op === "range") {
		return `file.${name} does not support ranges`;
	}
	if (match.op === "exists" || match.value.length === 0) {
		return `file.${name} needs a value`;
	}
	// Users type `*.md` out of a glob habit. A leading `*` is searched as a literal star and finds
	// nothing.
	if (name === "name" && match.value.startsWith("*")) {
		return "file.name finds names that contain the value. Put * only at the end";
	}
	if (name === "ext" && match.value.startsWith("*")) {
		return "file.ext takes an extension like md. Put * only at the end";
	}
	if (name === "kind" && (match.op === "prefix" || !["file", "folder"].includes(match.value.toLowerCase()))) {
		return "file.kind is file or folder";
	}
	if (name === "path" && match.op === "prefix") {
		return "file.path takes a folder path, without *";
	}
	return null;
}

// #endregion key and value rules

// #region query text

export function files_search_query_parse(query: string): ParsedQuery {
	const { tokens, openQuote } = split_tokens(query.trim());
	const filters: files_search_query_Filter[] = [];
	const textTokens: string[] = [];

	for (const [index, token] of tokens.entries()) {
		// A quote left open runs to the end of the query. Close it in the token, so a chip made from
		// it stays one token when the chips are joined and read back.
		const closedToken = openQuote && index === tokens.length - 1 ? close_open_quote(token) : token;
		const keyValue = split_key_value(closedToken);
		if (!keyValue) {
			// Free text keeps its quotes, so the text reads back as typed. The sidebar's name search
			// ignores them.
			textTokens.push(closedToken);
			continue;
		}

		const parsedKey = parse_key(keyValue.key);
		const parsedValue = parse_value(keyValue.value);
		// A file field explains its own value first, so `file.kind:` does not say "use *" while
		// `file.kind:*` says "needs a value".
		const problem =
			(filters.length >= files_search_query_MAX_FILTERS ? MAX_FILTERS_PROBLEM : null) ??
			parsedKey.problem ??
			(parsedKey.key.namespace === "file" ? file_field_problem(parsedKey.key.name, parsedValue.match) : null) ??
			parsedValue.problem;

		filters.push({
			raw: closedToken,
			negated: keyValue.negated,
			key: parsedKey.key,
			match: parsedValue.match,
			problem,
		});
	}

	return { filters, text: textTokens.join(" "), openQuote };
}

export function files_search_query_serialize(parsed: Pick<ParsedQuery, "filters" | "text">) {
	return [...parsed.filters.map((filter) => filter.raw), parsed.text.trim()]
		.filter((part) => part.length > 0)
		.join(" ");
}

function quote(text: string) {
	return `"${text.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
}

/**
 * Write a key the way the parser reads it back: bare when the key grammar accepts it, quoted
 * otherwise (a flat metadata key like `slack:message-id` holds a colon).
 */
export function files_search_query_format_key(name: string) {
	return KEY_REGEX.test(name) ? name : quote(name);
}

/**
 * Write a value the way the parser reads it back as one `eq` match. Quote it when it holds
 * whitespace or a quote, is empty, or would be read as an operator (`*`, a trailing `*`, a
 * leading `>`, `<`, `'`, `!`, or `=`).
 */
export function files_search_query_format_value(value: string) {
	if (value.length === 0 || /[\s"]/u.test(value) || value.endsWith("*") || /^[<>'!=]/u.test(value)) {
		return quote(value);
	}

	return value;
}

/**
 * The token the user is typing: the last token of the text, or nothing when the text ends after a
 * token. Quoted runs count as one token, so a value like `"Denys V` keeps its value suggestions.
 */
export function files_search_query_typing_token(text: string) {
	const { tokens, openQuote } = split_tokens(text);
	const lastToken = tokens[tokens.length - 1];
	if (lastToken === undefined || (!openQuote && /[ \t\n\r]$/u.test(text))) {
		return { start: text.length, token: "" };
	}
	return { start: text.length - lastToken.length, token: lastToken };
}

// #endregion query text

// #region search plans

/**
 * The comparison a range literal means on a number line: the number itself, or the timestamp of
 * a date. A date without a time names a whole UTC day, like the `eq` case in
 * `files_search_query_to_plans` below, so `<=2026-09-30` keeps the whole 30th and `>2026-09-04`
 * starts on the 5th. `null` for a literal that is neither, which `parse_value` already reports as
 * a problem.
 */
function range_bound(
	match: Extract<FilterMatch, { op: "range" }>,
): { comparator: (typeof match)["comparator"]; bound: number } | null {
	if (NUMBER_LITERAL_REGEX.test(match.value)) {
		return { comparator: match.comparator, bound: Number(match.value) };
	}

	const timestamp = files_metadata_parse_maybe_date(match.value);
	if (timestamp === null) {
		return null;
	}
	if (DATE_ONLY_LITERAL_REGEX.test(match.value)) {
		if (match.comparator === "lte") {
			return { comparator: "lt", bound: timestamp + ONE_DAY_MS };
		}
		if (match.comparator === "gt") {
			return { comparator: "gte", bound: timestamp + ONE_DAY_MS };
		}
	}

	return { comparator: match.comparator, bound: timestamp };
}

/**
 * The instant a time literal with no zone, like `2026-09-04T00:00`, means in the user's time zone.
 * Null for a date-only literal, a time with a zone, or anything else. The UTC parse checks the
 * calendar and the fraction, and its parts are then read back as local wall-clock time.
 */
function local_time_bound(value: string) {
	if (!LOCAL_TIME_LITERAL_REGEX.test(value)) {
		return null;
	}
	const utcTimestamp = files_metadata_parse_maybe_date(value);
	if (utcTimestamp === null) {
		return null;
	}
	const utc = new Date(utcTimestamp);
	return new Date(
		utc.getUTCFullYear(),
		utc.getUTCMonth(),
		utc.getUTCDate(),
		utc.getUTCHours(),
		utc.getUTCMinutes(),
		utc.getUTCSeconds(),
		utc.getUTCMilliseconds(),
	).getTime();
}

/**
 * Match `file.updated` on the client. The tree shows local dates, so a day literal means that whole
 * day in the user's time zone, on either side of a range too, and a time with no zone is local as
 * well. A time with a zone is taken as it is. Any other shape never matches, because
 * `file_field_problem` refuses it.
 */
export function files_search_query_file_updated_matches(match: FilterMatch, updatedAt: number) {
	if (match.op === "eq") {
		const day = local_day_bounds(match.value);
		return day !== null && updatedAt >= day.start && updatedAt < day.end;
	}
	if (match.op !== "range") {
		return false;
	}
	const day = local_day_bounds(match.value);
	if (day !== null) {
		switch (match.comparator) {
			case "gt":
				return updatedAt >= day.end;
			case "gte":
				return updatedAt >= day.start;
			case "lt":
				return updatedAt < day.start;
			case "lte":
				return updatedAt < day.end;
		}
	}
	const bound = local_time_bound(match.value) ?? range_bound(match)?.bound ?? null;
	if (bound === null) {
		return false;
	}
	switch (match.comparator) {
		case "gt":
			return updatedAt > bound;
		case "gte":
			return updatedAt >= bound;
		case "lt":
			return updatedAt < bound;
		case "lte":
			return updatedAt <= bound;
	}
}

/**
 * Turn a `file.path` value into the folder path the tree and the index store: a leading `/`,
 * no trailing `/`, and `/` alone for the root. Slashes alone, like `//`, mean the root too.
 */
export function files_search_query_folder_path(value: string) {
	const path = value.startsWith("/") ? value : `/${value}`;
	return path.replace(/\/+$/u, "") || "/";
}

/**
 * The qualified fields a filter asks the metadata index for. A bare key asks both metadata kinds,
 * but only the kinds whose key grammar accepts the name: `sender.name` cannot be a flat metadata key.
 * `file.*` keys never reach the index.
 */
export function files_search_query_qualified_fields(key: files_search_query_Key) {
	switch (key.namespace) {
		case "file":
			return [];
		case "frontmatter":
			return [`${files_metadata_FRONTMATTER_FIELD_PREFIX}${key.name}`];
		case "metadata":
			return [`${files_metadata_METADATA_FIELD_PREFIX}${key.name}`];
		case "any": {
			const fields: string[] = [];
			if (frontmatter_name_is_valid(key.name)) {
				fields.push(`${files_metadata_FRONTMATTER_FIELD_PREFIX}${key.name}`);
			}
			if (metadata_name_is_valid(key.name)) {
				fields.push(`${files_metadata_METADATA_FIELD_PREFIX}${key.name}`);
			}
			return fields;
		}
	}
}

/**
 * Turn one valid metadata filter into index search plans, one per qualified field and value
 * kind. An unquoted literal asks every kind it could be: `3` is the number 3 or the text "3",
 * `true` is a boolean or text, `2026-09-04` is text or any maybe_date inside that UTC day, and
 * `2026-09-04T10:00Z` is text or the maybe_date at that instant. A kind the key never used has no
 * docs, so an extra plan never adds a wrong file.
 *
 * At most 2 fields x 2 kinds = 4 plans.
 */
export function files_search_query_to_plans(filter: files_search_query_Filter): files_metadata_SearchPlan[] {
	const plans: files_metadata_SearchPlan[] = [];
	if (filter.problem !== null) {
		return plans;
	}

	for (const qualifiedField of files_search_query_qualified_fields(filter.key)) {
		const match = filter.match;
		switch (match.op) {
			case "exists":
				plans.push({ op: "exists", qualifiedField });
				break;
			case "prefix":
				plans.push({ op: "prefix", qualifiedField, value: match.value });
				break;
			case "range": {
				const range = range_bound(match);
				// `parse_value` already refused a literal that is neither a number nor a date.
				if (range !== null) {
					plans.push({
						op: "range",
						qualifiedField,
						valueKind: NUMBER_LITERAL_REGEX.test(match.value) ? "number" : "maybe_date",
						[range.comparator]: range.bound,
					});
				}
				break;
			}
			case "eq": {
				plans.push({ op: "eq", qualifiedField, value: match.value });
				if (match.quoted) {
					break;
				}
				const booleanValue = BOOLEAN_LITERALS.get(match.value);
				if (NUMBER_LITERAL_REGEX.test(match.value)) {
					plans.push({ op: "eq", qualifiedField, value: Number(match.value) });
				} else if (booleanValue !== undefined) {
					plans.push({ op: "eq", qualifiedField, value: booleanValue });
				} else if (DATE_ONLY_LITERAL_REGEX.test(match.value)) {
					const dayStart = files_metadata_parse_maybe_date(match.value);
					if (dayStart !== null) {
						plans.push({
							op: "range",
							qualifiedField,
							valueKind: "maybe_date",
							gte: dayStart,
							lt: dayStart + ONE_DAY_MS,
						});
					}
				} else {
					// A date with a time names one instant, and the stored spelling can differ from the typed
					// one (`10:00Z` and `10:00:00Z`). So ask the maybe_date kind at that instant too.
					const instant = files_metadata_parse_maybe_date(match.value);
					if (instant !== null) {
						plans.push({
							op: "range",
							qualifiedField,
							valueKind: "maybe_date",
							gte: instant,
							lte: instant,
						});
					}
				}
				break;
			}
		}
	}

	return plans;
}

// #endregion search plans
