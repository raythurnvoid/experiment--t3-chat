// The search box language. A query is a list of whitespace-separated tokens. A token that reads
// `key:value` is a filter. Every other token is free text, and the free text keeps today's shape
// rules (name, path, node id, pasted link) in the sidebar.
//
// Filters:
// - `metadata.status:open` equality. `metadata.status:*` the key exists. `metadata.title:Recall*`
//   string prefix, and `metadata.title:"Recall the"*` for a prefix with spaces.
// - `metadata.priority:>2`, `frontmatter.due:<=2026-09-30` ranges on numbers or ISO dates.
// - `metadata.assignee:"Denys Voloshyn"` quotes a value with spaces.
// - `file.path:/tasks` is a folder, or an exact path when nothing else is searched.
//   `frontmatter.x` and `metadata.x` name one metadata kind.
// - `file.link:public` lists the files that have a public link. It takes no other value.
//
// Every key starts with its namespace: `file.`, `frontmatter.` or `metadata.`. A token like
// `status:open` has no namespace, so it is free text. A key holds no colon, so it never needs quotes.
// The folder table bar reads the same field names (`files-folder-table-query.ts`).
//
// A search is one thing plus an optional folder: the free text or one filter, and one `file.path`.
// The server answers one clause at a time, so every other chip gets a `problem` and runs nothing.
// So do a negated chip (`!metadata.status:done`) and the `file.*` chips the box no longer runs.
import {
	files_metadata_FIELD_SEGMENT_REGEX,
	files_metadata_FRONTMATTER_FIELD_PREFIX,
	files_metadata_METADATA_FIELD_PREFIX,
	files_metadata_METADATA_KEY_REGEX,
	files_metadata_parse_maybe_date,
	type files_metadata_SearchPlan,
} from "./files-metadata.ts";

/**
 * Longest qualified field path (`metadata.<key>`, `frontmatter.<path>`) the search and sort doors
 * accept.
 */
export const files_search_query_FIELD_PATH_MAX_LENGTH = 160;

export const files_search_query_FILE_FIELDS = ["path", "link"] as const;

export type files_search_query_Key = {
	namespace: "file" | "frontmatter" | "metadata";
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
const FIELD_NAMESPACE_REGEX = /^(?:file|frontmatter|metadata)\./u;
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
const FILE_FIELD_PREFIX = "file.";
// The search box no longer runs these chips. The folder table bar still filters on these fields.
const REMOVED_FILE_FIELD_PROBLEMS = new Map([
	["name", "Type the name as plain text."],
	["extension", "file.extension is not supported in search. Use the folder table filters."],
	["kind", "file.kind is not supported in search. Use the folder table filters."],
	["updated", "file.updated is not supported in search. Use the folder table filters."],
]);
const ONE_CLAUSE_PROBLEM = "Search for words or one filter, not both. You can add a folder.";
const FOLDER_RANGE_PROBLEM = "A folder works with names, key:value and key:*. Remove the folder to search ranges.";
const FOLDER_TOO_DEEP_PROBLEM = "This folder is too deep to search inside. Search a folder higher up.";
// The server can search inside a folder only up to this many levels below the root.
const FOLDER_SEARCH_MAX_DEPTH = 12;
const RANGE_COMPARATORS = [
	["gte", ">="],
	["lte", "<="],
	["gt", ">"],
	["lt", "<"],
] as const;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// #region tokenizer

/**
 * Split on whitespace, keeping quoted runs together. Each token keeps its exact source text.
 */
export function files_search_query_split_tokens(query: string) {
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
export function files_search_query_read_quoted(token: string, start: number) {
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
export function files_search_query_close_open_quote(token: string) {
	const trailingBackslashes = /\\*$/u.exec(token)![0].length;
	return trailingBackslashes % 2 === 1 ? `${token}\\"` : `${token}"`;
}

/**
 * Split a token into its key part and value part, or return null when it is free text. The key
 * is a run of key characters that starts with `file.`, `frontmatter.` or `metadata.`, and it must
 * be followed by `:`. A key without a namespace, like `status`, is free text.
 */
function split_key_value(token: string) {
	const negated = token.startsWith("!");
	const keyStart = negated ? 1 : 0;
	const colonIndex = token.indexOf(":", keyStart);
	if (colonIndex < 0) {
		return null;
	}

	const key = token.slice(keyStart, colonIndex);
	if (!KEY_REGEX.test(key) || !FIELD_NAMESPACE_REGEX.test(key)) {
		return null;
	}

	return { negated, key, value: token.slice(colonIndex + 1) };
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
export function files_search_query_field_path_is_valid(fieldPath: string) {
	if (fieldPath.startsWith(files_metadata_FRONTMATTER_FIELD_PREFIX)) {
		return frontmatter_name_is_valid(fieldPath.slice(files_metadata_FRONTMATTER_FIELD_PREFIX.length));
	}
	if (fieldPath.startsWith(files_metadata_METADATA_FIELD_PREFIX)) {
		return metadata_name_is_valid(fieldPath.slice(files_metadata_METADATA_FIELD_PREFIX.length));
	}
	return false;
}

/**
 * Read a field name such as `file.name`, `metadata.status` or `frontmatter.due`. `fileFields` is the
 * list of `file.` names the caller accepts, because the sidebar and the folder table differ. Returns
 * null for a name with no namespace. A known namespace with a bad name returns a problem.
 */
export function files_search_query_parse_field(
	field: string,
	fileFields: readonly string[],
): { key: files_search_query_Key; problem: string | null } | null {
	if (field.startsWith(FILE_FIELD_PREFIX)) {
		const name = field.slice(FILE_FIELD_PREFIX.length);
		return {
			key: { namespace: "file", name },
			problem: fileFields.includes(name)
				? null
				: `Unknown file field. Use ${fileFields.map((fileField) => `file.${fileField}`).join(", ")}`,
		};
	}
	if (field.startsWith(files_metadata_FRONTMATTER_FIELD_PREFIX)) {
		const name = field.slice(files_metadata_FRONTMATTER_FIELD_PREFIX.length);
		return {
			key: { namespace: "frontmatter", name },
			problem: frontmatter_name_is_valid(name) ? null : "Frontmatter keys use letters, digits, _ and -, joined by dots",
		};
	}
	if (field.startsWith(files_metadata_METADATA_FIELD_PREFIX)) {
		const name = field.slice(files_metadata_METADATA_FIELD_PREFIX.length);
		return {
			key: { namespace: "metadata", name },
			problem: metadata_name_is_valid(name) ? null : "Metadata keys use letters, digits, _ and -",
		};
	}
	return null;
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
				problem = `Put the number or the date right after ${symbol}, like metadata.priority:${symbol}2`;
			} else if (literal.startsWith('"') || literal.startsWith("'")) {
				// The generic hint says to quote the value. That points the wrong way when it already is.
				problem = `Ranges take the number or the date without quotes, like metadata.priority:${symbol}2`;
			} else {
				problem = "Ranges need a number or a date like 2026-09-04. Quote the value to search it as text";
			}
		}
		return { match: { op: "range", comparator, value: literal }, problem };
	}

	// Single quotes are not quotes here, so `assignee:'Denys Voloshyn'` would end at the space and
	// search for `'Denys` with no warning. A `!` or `=` on the value side is a habit from other
	// search boxes: search has no NOT, and a plain value is already an exact match.
	if (value.startsWith("'")) {
		return {
			match: { op: "eq", value, quoted: false },
			problem: 'Use double quotes, like metadata.status:"in progress"',
		};
	}
	if (value.startsWith("!")) {
		return {
			match: { op: "eq", value, quoted: false },
			problem: ONE_CLAUSE_PROBLEM,
		};
	}
	if (value.startsWith("=")) {
		return {
			match: { op: "eq", value, quoted: false },
			problem: "Drop the =. A plain value is an exact match, like metadata.priority:2",
		};
	}

	if (value.startsWith('"')) {
		const quoted = files_search_query_read_quoted(value, 0);
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
 * File fields have their own rules: a path is a folder and a link is `public`.
 */
function file_field_problem(name: string, match: FilterMatch) {
	if (match.op === "range") {
		return `file.${name} does not support ranges`;
	}
	if (match.op === "exists" || match.value.length === 0) {
		return `file.${name} needs a value`;
	}
	if (name === "path" && match.op === "prefix") {
		return "file.path takes a folder path, without *";
	}
	// The Files tree knows only one link state, so `public` is the only value. Case does not matter,
	// like `file.kind`.
	if (name === "link" && (match.op === "prefix" || match.value.toLowerCase() !== "public")) {
		return "file.link takes public, like file.link:public";
	}
	return null;
}

// #endregion key and value rules

// #region query text

export function files_search_query_parse(query: string): ParsedQuery {
	const { tokens, openQuote } = files_search_query_split_tokens(query.trim());
	const filters: files_search_query_Filter[] = [];
	const textTokens: string[] = [];

	for (const [index, token] of tokens.entries()) {
		// A quote left open runs to the end of the query. Close it in the token, so a chip made from
		// it stays one token when the chips are joined and read back.
		const closedToken = openQuote && index === tokens.length - 1 ? files_search_query_close_open_quote(token) : token;
		const keyValue = split_key_value(closedToken);
		if (!keyValue) {
			// Free text keeps its quotes, so the text reads back as typed. The sidebar's name search
			// ignores them.
			textTokens.push(closedToken);
			continue;
		}

		// `split_key_value` only returns a key with a namespace, so the field always parses.
		const parsedKey = files_search_query_parse_field(keyValue.key, files_search_query_FILE_FIELDS)!;
		const parsedValue = parse_value(keyValue.value);
		// A removed chip says so before "Unknown file field". A file field explains its own value
		// next, so `file.path:` does not say "use *" while `file.path:*` says "needs a value".
		const problem =
			(parsedKey.key.namespace === "file" ? REMOVED_FILE_FIELD_PROBLEMS.get(parsedKey.key.name) : null) ??
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

	// Keep one clause (the free text or the first filter) and one folder. A chip that already has
	// its own problem does not take a place.
	let hasClause = textTokens.length > 0;
	let folder: files_search_query_Filter | null = null;
	for (const filter of filters) {
		if (filter.problem !== null) {
			continue;
		}
		const isFolder = filter.key.namespace === "file" && filter.key.name === "path";
		if (filter.negated || (isFolder ? folder !== null : hasClause)) {
			filter.problem = ONE_CLAUSE_PROBLEM;
		} else if (isFolder) {
			folder = filter;
		} else {
			hasClause = true;
		}
	}

	// A folder alone is an exact path. With a clause it scopes the search, and the server can
	// scope only words, `key:value` and `key:*`, and only so many levels deep.
	if (folder !== null && hasClause) {
		// A folder chip without a problem is always an `eq` match. The check narrows the type.
		const folderPath = folder.match.op === "eq" ? files_search_query_folder_path(folder.match.value) : "/";
		if (folderPath.split("/").filter((part) => part.length > 0).length > FOLDER_SEARCH_MAX_DEPTH) {
			folder.problem = FOLDER_TOO_DEEP_PROBLEM;
		}
		for (const filter of filters) {
			if (
				filter.problem === null &&
				filter.key.namespace !== "file" &&
				(filter.match.op === "prefix" || filter.match.op === "range")
			) {
				filter.problem = FOLDER_RANGE_PROBLEM;
			}
		}
	}

	return { filters, text: textTokens.join(" "), openQuote };
}

export function files_search_query_serialize(parsed: Pick<ParsedQuery, "filters" | "text">) {
	return [...parsed.filters.map((filter) => filter.raw), parsed.text.trim()]
		.filter((part) => part.length > 0)
		.join(" ");
}

/**
 * Wrap a text in double quotes. A backslash and a double quote inside it are escaped.
 */
export function files_search_query_quote(text: string) {
	return `"${text.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
}

/**
 * Write a value the way the parser reads it back as one `eq` match. Quote it when it holds
 * whitespace or a quote, is empty, or would be read as an operator (`*`, a trailing `*`, a
 * leading `>`, `<`, `'`, `!`, or `=`).
 */
export function files_search_query_format_value(value: string) {
	if (value.length === 0 || /[\s"]/u.test(value) || value.endsWith("*") || /^[<>'!=]/u.test(value)) {
		return files_search_query_quote(value);
	}

	return value;
}

/**
 * The token the user is typing: the last token of the text, or nothing when the text ends after a
 * token. Quoted runs count as one token, so a value like `"Denys V` keeps its value suggestions.
 */
export function files_search_query_typing_token(text: string) {
	const { tokens, openQuote } = files_search_query_split_tokens(text);
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
 * Turn a `file.path` value into the folder path the tree and the index store: a leading `/`,
 * no trailing `/`, and `/` alone for the root. Slashes alone, like `//`, mean the root too.
 */
export function files_search_query_folder_path(value: string) {
	const path = value.startsWith("/") ? value : `/${value}`;
	return path.replace(/\/+$/u, "") || "/";
}

/**
 * The qualified field a filter asks the metadata index for. `file.*` keys never reach the index.
 */
export function files_search_query_field_paths(key: files_search_query_Key) {
	switch (key.namespace) {
		case "file":
			return [];
		case "frontmatter":
			return [`${files_metadata_FRONTMATTER_FIELD_PREFIX}${key.name}`];
		case "metadata":
			return [`${files_metadata_METADATA_FIELD_PREFIX}${key.name}`];
	}
}

/**
 * Turn one valid metadata filter into index search plans, one per value kind. A qualified key
 * names exactly one field. An unquoted literal asks every kind it could be: `3` is the number 3
 * or the text "3", `true` is a boolean or text, `2026-09-04` is text or any maybe_date inside that
 * UTC day, and `2026-09-04T10:00Z` is text or the maybe_date at that instant. A kind the key never
 * used has no docs, so an extra plan never adds a wrong file.
 *
 * At most 2 plans.
 */
export function files_search_query_to_plans(filter: files_search_query_Filter): files_metadata_SearchPlan[] {
	const plans: files_metadata_SearchPlan[] = [];
	if (filter.problem !== null) {
		return plans;
	}

	for (const fieldPath of files_search_query_field_paths(filter.key)) {
		const match = filter.match;
		switch (match.op) {
			case "exists":
				plans.push({ op: "exists", fieldPath });
				break;
			case "prefix":
				plans.push({ op: "prefix", fieldPath, value: match.value });
				break;
			case "range": {
				const range = range_bound(match);
				// `parse_value` already refused a literal that is neither a number nor a date.
				if (range !== null) {
					plans.push({
						op: "range",
						fieldPath,
						valueKind: NUMBER_LITERAL_REGEX.test(match.value) ? "number" : "maybe_date",
						[range.comparator]: range.bound,
					});
				}
				break;
			}
			case "eq": {
				plans.push({ op: "eq", fieldPath, value: match.value });
				if (match.quoted) {
					break;
				}
				const booleanValue = BOOLEAN_LITERALS.get(match.value);
				if (NUMBER_LITERAL_REGEX.test(match.value)) {
					plans.push({ op: "eq", fieldPath, value: Number(match.value) });
				} else if (booleanValue !== undefined) {
					plans.push({ op: "eq", fieldPath, value: booleanValue });
				} else if (DATE_ONLY_LITERAL_REGEX.test(match.value)) {
					const dayStart = files_metadata_parse_maybe_date(match.value);
					if (dayStart !== null) {
						plans.push({
							op: "range",
							fieldPath,
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
							fieldPath,
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
