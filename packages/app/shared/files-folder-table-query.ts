// The folder table bar language. A query is a list of whitespace-separated tokens. A token is one
// filter or one sort. The folder table runs one filter, or a `file.name` prefix plus one "is"
// filter, and one sort. A filter fixes the order (`files_table_filter_order_field`), so a sort for
// another field is dropped while a filter is on.
//
// - Filter: the search box tokens (`files-search-query.ts`), read by `files_search_query_read_token`,
//   so a token means the same in both: `file.name:report*`, `file.extension:md`, `file.size:>=1024`,
//   `file.updated:<2026-09-04`, `metadata.status:open`, `metadata.status:*`. `!file.extension:*` and
//   `!file.size:*` ask for the rows with no value. Each one maps to one `files_table_Filter`.
// - Sort: `sort_by:<field>:<asc|desc>`, like `sort_by:file.updated:desc`.
//
// A field starts with its namespace: `file.name`, `file.updated`, `file.created`, `file.extension`,
// `file.size`, `metadata.<key>` or `frontmatter.<path>`. A key holds no colon, so a field never needs
// quotes.
//
// The browser turns a day into a start and an end, because a day is a local calendar day. So the
// request builder takes that function from the caller, and this file stays free of the clock.
import { files_metadata_parse_maybe_date } from "./files-metadata.ts";
import {
	files_search_query_close_open_quote,
	files_search_query_parse_field,
	files_search_query_read_token,
	files_search_query_split_tokens,
} from "./files-search-query.ts";
import {
	files_sort_field_is_built_in,
	files_sort_field_is_valid,
	files_sort_MAX_CLAUSES,
	type files_sort_Sort,
} from "./files-sort.ts";
import {
	files_table_filter_is_valid,
	files_table_filter_order_field,
	files_table_filter_takes_name_prefix,
	files_table_starts_with_ends_in_digit,
	type files_table_Filter,
} from "./files-table.ts";

const SORT_KEY = "sort_by";
const VALUE_MAX_LENGTH = 1024;

/**
 * The longest query the URL `filter` param keeps. The route drops a longer one, so a token that
 * would pass this length cannot join the query.
 */
export const files_folder_table_query_MAX_LENGTH = 2000;

const DAY_REGEX = /^\d{4}-\d{2}-\d{2}$/u;
const WHOLE_NUMBER_REGEX = /^\d+$/u;
// A quote that starts a value and is not closed yet, like `file.name:"my rep`.
const OPEN_VALUE_QUOTE_REGEX = /(?:^|:)"(?:[^"\\]|\\.)*$/u;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const SIZE_PROBLEM = "Enter a whole number of bytes, zero or more";
const DAY_PROBLEM = "Enter a valid calendar day like 2026-09-04";
const NOT_PROBLEM = "Use ! only for a missing value, like !file.extension:* or !file.size:*";
// The search box runs these fields. The folder table is already one folder, and its index has no text.
const SEARCH_ONLY_FILE_FIELD_PROBLEMS = new Map([
	["path", "The folder table shows one folder. Use file.path in the search box"],
	["content", "Search contents in the search box"],
	["link", "Find public links in the search box"],
]);

/**
 * The `file.` names the table accepts. Each one is also the id of its table field, so `file.extension`
 * is the `extension` field.
 */
export const files_folder_table_query_FILE_FIELDS = ["name", "updated", "created", "extension", "size"] as const;

/**
 * One way to write a filter on a field, for the bar's "How to compare" suggestions. `token` is the
 * start of the token, like `file.size:>=` or `!file.size:*`.
 */
export type files_folder_table_query_Form = {
	token: string;
	/**
	 * The form as the user reads it, like `:>=bytes`.
	 */
	label: string;
	hint: string;
	needsValue: boolean;
};

export type files_folder_table_query_FilterToken = {
	kind: "filter";
	raw: string;
	/**
	 * The table field id: `name`, `updated`, `created`, `extension`, `size`, `metadata.<key>` or
	 * `frontmatter.<path>`.
	 */
	field: string;
	/**
	 * The `files_table_Filter` operation the token maps to, like `at_least` for `file.size:>=1024`.
	 */
	op: string;
	/**
	 * The value the operation compares with, or null for an operation that takes none. A strict
	 * comparison is moved to its whole-number or whole-day neighbour, so `file.size:>1024` holds
	 * `1025` and `file.updated:<=2026-09-04` holds `2026-09-05`.
	 */
	value: string | null;
};

export type files_folder_table_query_SortToken = {
	kind: "sort";
	raw: string;
	field: string;
	direction: "asc" | "desc";
};

export type files_folder_table_query_Token = files_folder_table_query_FilterToken | files_folder_table_query_SortToken;

export type files_folder_table_query_Parsed = {
	/**
	 * The kept tokens, in the order they were written.
	 */
	tokens: files_folder_table_query_Token[];
	/**
	 * The kept filter, or null. With a name prefix this is the "is" filter.
	 */
	filter: files_folder_table_query_FilterToken | null;
	/**
	 * The `file.name` prefix token, like `file.name:report*`, kept next to an "is" filter, or null.
	 */
	namePrefix: files_folder_table_query_FilterToken | null;
	/**
	 * The kept sort, at most one.
	 */
	sorts: files_folder_table_query_SortToken[];
	/**
	 * The tokens that were dropped, each with the reason in user-facing words.
	 */
	rejected: Array<{ raw: string; problem: string }>;
};

/**
 * The ways to write a filter on a table field. Each one maps to a `files_table_Filter` operation.
 * `fieldText` is the field as typed, like `file.size` or `metadata.status`.
 */
export function files_folder_table_query_forms(fieldText: string): files_folder_table_query_Form[] {
	const field = files_folder_table_query_parse_field(fieldText).field;
	const form = (token: string, label: string, hint: string, needsValue = true) => ({ token, label, hint, needsValue });
	if (field === "name") {
		return [form(`${fieldText}:`, ":value*", "starts with")];
	}
	if (field === "extension") {
		return [form(`${fieldText}:`, ":value", "is"), form(`!${fieldText}:*`, "!…:*", "has no extension", false)];
	}
	if (field === "updated" || field === "created") {
		return [
			form(`${fieldText}:`, ":day", "on"),
			form(`${fieldText}:<`, ":<day", "before"),
			form(`${fieldText}:<=`, ":<=day", "on or before"),
			form(`${fieldText}:>`, ":>day", "after"),
			form(`${fieldText}:>=`, ":>=day", "on or after"),
		];
	}
	if (field === "size") {
		return [
			form(`${fieldText}:`, ":bytes", "is"),
			form(`${fieldText}:>=`, ":>=bytes", "at least"),
			form(`${fieldText}:<=`, ":<=bytes", "at most"),
			form(`${fieldText}:>`, ":>bytes", "more than"),
			form(`${fieldText}:<`, ":<bytes", "less than"),
			form(`!${fieldText}:*`, "!…:*", "has no size", false),
		];
	}
	return [
		form(`${fieldText}:`, ":value", "is"),
		form(`${fieldText}:`, ":value*", "starts with"),
		form(`${fieldText}:*`, ":*", "has a value", false),
	];
}

/**
 * The one name of a table field. The key and the label the user sees are this same text: `extension`
 * is `file.extension`, `metadata.x` stays as it is. The file.updated_by column has no token, but it
 * has this name.
 */
export function files_folder_table_query_field_text(field: string) {
	return files_sort_field_is_built_in(field) || field === "updated_by" ? `file.${field}` : field;
}

/**
 * Read a field name from a token into a table field id. Returns a problem for a name the table
 * cannot filter or sort by.
 */
export function files_folder_table_query_parse_field(
	text: string,
): { field: string; problem: null } | { field: null; problem: string } {
	const parsed = files_search_query_parse_field(text, files_folder_table_query_FILE_FIELDS);
	if (parsed === null) {
		return { field: null, problem: "Start the field with file., metadata. or frontmatter." };
	}
	if (parsed.problem !== null) {
		return { field: null, problem: parsed.problem };
	}

	const field = parsed.key.namespace === "file" ? parsed.key.name : `${parsed.key.namespace}.${parsed.key.name}`;
	if (!files_sort_field_is_valid(field)) {
		return { field: null, problem: "This field name is too long" };
	}

	return { field, problem: null };
}

function is_day(value: string) {
	return DAY_REGEX.test(value) && !value.startsWith("0000") && files_metadata_parse_maybe_date(value) !== null;
}

/**
 * The calendar day `days` days after `day`. Both are `YYYY-MM-DD` days, not instants, so UTC math
 * is exact here.
 */
function shift_day(day: string, days: number) {
	return new Date(Date.parse(`${day}T00:00:00Z`) + days * ONE_DAY_MS).toISOString().slice(0, 10);
}

/**
 * Map one read token to a table operation and its value, or say why the table cannot run it.
 */
function read_filter(
	field: string,
	read: NonNullable<ReturnType<typeof files_search_query_read_token>>,
): { op: string; value: string | null; problem: null } | { problem: string } {
	const { match } = read;

	// `!field:*` (no value) is the only NOT, and only file.extension and file.size have a "missing" index.
	if (read.negated) {
		return match.op === "exists" && (field === "extension" || field === "size")
			? { op: "missing", value: null, problem: null }
			: { problem: NOT_PROBLEM };
	}
	// A bare quote would open a quoted run when the query is split again, and it would swallow the
	// tokens after it.
	if (!read.valueText.startsWith('"') && read.valueText.includes('"')) {
		return { problem: 'Put the value in quotes to use a " in it' };
	}

	// The search box words its value problems for search, like "Use * for any value". So each file
	// field below gives its own problem, and only a metadata value uses the search box's problem.
	if (field === "size") {
		if (match.op !== "eq" && match.op !== "range") {
			return { problem: "Compare a size like file.size:1024 or file.size:>=1024, or use !file.size:* for none" };
		}
		if (
			read.valueProblem !== null ||
			!WHOLE_NUMBER_REGEX.test(match.value) ||
			!Number.isSafeInteger(Number(match.value))
		) {
			return { problem: SIZE_PROBLEM };
		}
		const size = Number(match.value);
		if (match.op === "eq") return { op: "is", value: String(size), problem: null };
		// Sizes are whole bytes, so a strict bound is the next whole number.
		const bound =
			match.comparator === "gte"
				? { op: "at_least", size }
				: match.comparator === "gt"
					? { op: "at_least", size: size + 1 }
					: match.comparator === "lte"
						? { op: "at_most", size }
						: { op: "at_most", size: size - 1 };
		return bound.size >= 0 && Number.isSafeInteger(bound.size)
			? { op: bound.op, value: String(bound.size), problem: null }
			: { problem: SIZE_PROBLEM };
	}

	if (field === "updated" || field === "created") {
		if (match.op !== "eq" && match.op !== "range") {
			return { problem: "Compare a day like file.updated:2026-09-04 or file.updated:>=2026-09-04" };
		}
		if (read.valueProblem !== null || !is_day(match.value)) {
			return { problem: DAY_PROBLEM };
		}
		if (match.op === "eq") return { op: "on", value: match.value, problem: null };
		// `before` ends at the start of its day and `after` starts at the end of its day, so `<=` and
		// `>=` move to the next and the previous day.
		const bound =
			match.comparator === "lt"
				? { op: "before", day: match.value }
				: match.comparator === "lte"
					? { op: "before", day: shift_day(match.value, 1) }
					: match.comparator === "gt"
						? { op: "after", day: match.value }
						: { op: "after", day: shift_day(match.value, -1) };
		// The move can leave the calendar, like `<=9999-12-31`. The browser could not turn that day
		// into a time, so the table would run no filter.
		return is_day(bound.day) ? { op: bound.op, value: bound.day, problem: null } : { problem: DAY_PROBLEM };
	}

	if (field === "name" && match.op !== "prefix") {
		return { problem: "Filter names by their start, like file.name:report*" };
	}
	if (field === "extension" && (match.op !== "eq" || read.valueProblem !== null)) {
		return { problem: "Write an extension like file.extension:md, or use !file.extension:* for none" };
	}
	// Only a metadata or frontmatter field is left here once it is not an exact value or a prefix.
	if (match.op === "exists") {
		return { op: "present", value: null, problem: null };
	}
	if (match.op === "range") {
		return { problem: "The folder table compares this field with a value, like metadata.status:open, open*, or *" };
	}
	// A value that starts with `!` reads as NOT, and the table has NOT only for a missing value.
	if (match.op === "eq" && !match.quoted && match.value.startsWith("!")) {
		return { problem: NOT_PROBLEM };
	}
	if (read.valueProblem !== null) {
		return { problem: read.valueProblem };
	}
	if (match.value.length === 0 || match.value.length > VALUE_MAX_LENGTH) {
		return { problem: `Enter 1 to ${VALUE_MAX_LENGTH.toLocaleString("en-US")} characters` };
	}
	if (match.op === "prefix" && files_table_starts_with_ends_in_digit(match.value)) {
		return { problem: "'Starts with' cannot end with a number here. Remove the last digits, or use an exact value" };
	}

	return { op: match.op === "prefix" ? "starts_with" : "is", value: match.value, problem: null };
}

/**
 * Read one token. Returns the token, or the reason it cannot be one. This does not look at the
 * other tokens, so it cannot tell that a second filter is one too many.
 */
export function files_folder_table_query_parse_token(
	raw: string,
): { token: files_folder_table_query_Token; problem: null } | { token: null; problem: string } {
	if (raw.startsWith(`${SORT_KEY}:`)) {
		const parts = raw.slice(SORT_KEY.length + 1).split(":");
		if (parts.length !== 2) {
			return { token: null, problem: `Write ${SORT_KEY}:<field>:asc or ${SORT_KEY}:<field>:desc` };
		}

		const field = files_folder_table_query_parse_field(parts[0]!);
		if (field.problem !== null) {
			return { token: null, problem: field.problem };
		}
		if (parts[1] !== "asc" && parts[1] !== "desc") {
			return { token: null, problem: "A sort direction is asc or desc" };
		}

		return { token: { kind: "sort", raw, field: field.field, direction: parts[1] }, problem: null };
	}

	const read = files_search_query_read_token(raw, files_folder_table_query_FILE_FIELDS);
	if (read === null) {
		return {
			token: null,
			problem: `Type a filter like file.name:report*, or a sort like ${SORT_KEY}:file.updated:desc`,
		};
	}

	const searchOnlyProblem = read.key.namespace === "file" ? SEARCH_ONLY_FILE_FIELD_PROBLEMS.get(read.key.name) : null;
	if (searchOnlyProblem) {
		return { token: null, problem: searchOnlyProblem };
	}
	const field = files_folder_table_query_parse_field(read.keyText);
	if (field.problem !== null) {
		return { token: null, problem: field.problem };
	}

	const filter = read_filter(field.field, read);
	if (filter.problem !== null) {
		return { token: null, problem: filter.problem };
	}

	return { token: { kind: "filter", raw, field: field.field, op: filter.op, value: filter.value }, problem: null };
}

/**
 * Close a quote the user left open at the end of the last token. Only a quote that starts a value is
 * closed. A bare quote inside a value stays as typed, and the parser refuses it with a reason.
 */
export function files_folder_table_query_close_open_quote(token: string) {
	return OPEN_VALUE_QUOTE_REGEX.test(token) ? files_search_query_close_open_quote(token) : token;
}

/**
 * Read a query. A token that is not valid, a filter that cannot join the kept ones, a second sort,
 * and a sort the filter does not allow are all dropped and listed in `rejected`. Filters are read
 * before sorts, so a filter always wins over a sort for another field.
 */
export function files_folder_table_query_parse(query: string): files_folder_table_query_Parsed {
	const { tokens: rawTokens, openQuote } = files_search_query_split_tokens(query.trim());
	const parsed: files_folder_table_query_Parsed = { tokens: [], filter: null, namePrefix: null, sorts: [], rejected: [] };

	const results = rawTokens.map((rawToken, index) => {
		// A quote left open runs to the end of the query. Close it, so the token stays one token.
		const raw =
			openQuote && index === rawTokens.length - 1 ? files_folder_table_query_close_open_quote(rawToken) : rawToken;
		return { raw, result: files_folder_table_query_parse_token(raw) };
	});
	const kept = new Set<files_folder_table_query_Token>();
	for (const pass of ["filter", "sort"] as const) {
		for (const { raw, result } of results) {
			// Invalid tokens are reported once, in the filter pass.
			if ((result.token?.kind ?? "filter") !== pass) continue;

			const problem = result.problem ?? get_conflict_problem(parsed, result.token);
			if (problem !== null) {
				parsed.rejected.push({ raw, problem });
				continue;
			}

			const token = result.token!;
			kept.add(token);
			if (token.kind === "sort") {
				parsed.sorts.push(token);
			} else if (parsed.filter === null) {
				parsed.filter = token;
			} else if (token.field === "name") {
				parsed.namePrefix = token;
			} else {
				// The name prefix came first. The "is" filter is the main one.
				parsed.namePrefix = parsed.filter;
				parsed.filter = token;
			}
		}
	}
	// Keep the tokens in the order they were written.
	parsed.tokens = results.flatMap(({ result }) => (result.token && kept.has(result.token) ? [result.token] : []));

	return parsed;
}

/**
 * Why a valid token cannot join the tokens kept so far, or null when it can.
 */
function get_conflict_problem(
	parsed: Pick<files_folder_table_query_Parsed, "filter" | "namePrefix" | "sorts">,
	token: files_folder_table_query_Token | null,
) {
	if (token === null) {
		return null;
	}
	if (token.kind === "filter") {
		if (parsed.filter === null) return null;
		const canPair =
			parsed.namePrefix === null &&
			((token.field === "name" && files_table_filter_takes_name_prefix(parsed.filter)) ||
				(parsed.filter.field === "name" && files_table_filter_takes_name_prefix(token)));
		return canPair ? null : "Use one filter, or 'name starts with' plus one 'is' filter";
	}
	if (parsed.filter !== null && token.field !== files_table_filter_order_field(parsed.filter)) {
		return `Remove the filter to sort by ${files_folder_table_query_field_text(token.field)}`;
	}
	return parsed.sorts.length >= files_sort_MAX_CLAUSES ? "The folder table sorts by one field" : null;
}

/**
 * Why a token cannot join a query, or null when it can. The token must be valid on its own.
 */
export function files_folder_table_query_get_add_problem(query: string, raw: string) {
	const result = files_folder_table_query_parse_token(raw);
	if (result.problem !== null) {
		return result.problem;
	}

	if (query.length + 1 + raw.length > files_folder_table_query_MAX_LENGTH) {
		return "The filter and sort text is too long";
	}

	return get_conflict_problem(files_folder_table_query_parse(query), result.token);
}

/**
 * Join tokens with one space, the way the URL holds them.
 */
export function files_folder_table_query_serialize(tokens: Array<Pick<files_folder_table_query_Token, "raw">>) {
	return tokens.map((token) => token.raw).join(" ");
}

/**
 * The query with every token that cannot run dropped. The URL holds this string, so a hand-edited
 * link is fixed by dropping the bad tokens. Cleaning a clean query gives the same query.
 */
export function files_folder_table_query_clean(query: string) {
	return files_folder_table_query_serialize(files_folder_table_query_parse(query).tokens);
}

/**
 * The query with its filter replaced. Pass null to drop the filter.
 */
export function files_folder_table_query_with_filter(query: string, filterRaw: string | null) {
	const parsed = files_folder_table_query_parse(query);
	return files_folder_table_query_clean(
		[...(filterRaw === null ? [] : [filterRaw]), ...parsed.sorts.map((sort) => sort.raw)].join(" "),
	);
}

/**
 * The query with its sort replaced. A sort the filter does not allow is dropped.
 */
export function files_folder_table_query_with_sort(query: string, sort: files_sort_Sort) {
	const parsed = files_folder_table_query_parse(query);
	const sortTokens = sort.map(
		(clause) => `${SORT_KEY}:${files_folder_table_query_field_text(clause.field)}:${clause.direction}`,
	);
	const filterTokens = [parsed.filter, parsed.namePrefix].flatMap((token) => (token ? [token.raw] : []));
	return files_folder_table_query_clean([...filterTokens, ...sortTokens].join(" "));
}

/**
 * The sort the sort tokens ask for, or null when there is none. Null means "use the saved sort".
 */
export function files_folder_table_query_to_sort(parsed: Pick<files_folder_table_query_Parsed, "sorts">) {
	return parsed.sorts.length === 0
		? null
		: parsed.sorts.map((sort): files_sort_Sort[number] => ({ field: sort.field, direction: sort.direction }));
}

/**
 * The table filter a filter token asks for, or null when there is none. `getDayBounds` turns a
 * day like `2026-09-04` into the start and the end of that local day. It is a parameter because
 * the browser knows the time zone and this file does not.
 */
export function files_folder_table_query_to_filter(
	token: files_folder_table_query_FilterToken | null,
	getDayBounds: (day: string) => { start: number; end: number } | null,
): files_table_Filter | null {
	if (token === null) {
		return null;
	}

	const { field, op, value } = token;
	let filter: files_table_Filter | null = null;
	if (field === "name") {
		filter = { kind: "name", field, op: "starts_with", value: value! };
	} else if (field === "extension") {
		filter =
			op === "missing" ? { kind: "extension", field, op } : { kind: "extension", field, op: "is", value: value! };
	} else if (field === "updated" || field === "created") {
		const bounds = getDayBounds(value!);
		filter = bounds && { kind: "date", field, op: op as "on" | "before" | "after", ...bounds };
	} else if (field === "size") {
		filter =
			op === "missing"
				? { kind: "size", field, op }
				: { kind: "size", field, op: op as "is" | "at_least" | "at_most", value: Number(value) };
	} else {
		filter =
			op === "present"
				? { kind: "text", field, op }
				: { kind: "text", field, op: op as "is" | "starts_with", value: value! };
	}

	return filter !== null && files_table_filter_is_valid(filter) ? filter : null;
}
