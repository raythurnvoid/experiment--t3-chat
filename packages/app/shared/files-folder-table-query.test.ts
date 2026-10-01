import { describe, expect, test } from "vitest";
import {
	files_folder_table_query_clean,
	files_folder_table_query_close_open_quote,
	files_folder_table_query_field_text,
	files_folder_table_query_format_value,
	files_folder_table_query_get_add_problem,
	files_folder_table_query_MAX_LENGTH,
	files_folder_table_query_operations,
	files_folder_table_query_parse,
	files_folder_table_query_parse_token,
	files_folder_table_query_to_filter,
	files_folder_table_query_to_sort,
	files_folder_table_query_with_filter,
	files_folder_table_query_with_sort,
	type files_folder_table_query_FilterToken,
} from "./files-folder-table-query.ts";
import { files_sort_MAX_CLAUSES } from "./files-sort.ts";
import { files_table_filter_is_valid } from "./files-table.ts";

// A fixed day span, so the tests do not depend on the time zone.
function get_day_bounds(day: string) {
	const start = Date.parse(`${day}T00:00:00Z`);
	return Number.isNaN(start) ? null : { start, end: start + 24 * 60 * 60 * 1000 };
}

function parse_filter(raw: string) {
	const result = files_folder_table_query_parse_token(raw);
	expect(result.problem).toBeNull();
	expect(result.token?.kind).toBe("filter");
	return result.token as files_folder_table_query_FilterToken;
}

describe("files_folder_table_query_parse_token", () => {
	test("reads a filter token with and without a value", () => {
		expect(parse_filter("file.name:contains:report")).toEqual({
			kind: "filter",
			raw: "file.name:contains:report",
			field: "name",
			op: "contains",
			value: "report",
		});
		expect(parse_filter("metadata.status:present")).toMatchObject({ field: "metadata.status", value: null });
		expect(parse_filter("frontmatter.a.b:starts_with:x")).toMatchObject({ field: "frontmatter.a.b", value: "x" });
	});

	test("maps the extension to the type field", () => {
		expect(parse_filter("file.ext:is:md")).toMatchObject({ field: "type", op: "is", value: "md" });
		expect(files_folder_table_query_field_text("type")).toBe("file.ext");
		expect(files_folder_table_query_field_text("metadata.status")).toBe("metadata.status");
	});

	test("keeps a colon in the value, and reads a quoted value", () => {
		expect(parse_filter("metadata.id:is:a:b:c").value).toBe("a:b:c");
		expect(parse_filter('file.name:contains:"my report"').value).toBe("my report");
		expect(parse_filter('metadata.note:is:"say \\"hi\\""').value).toBe('say "hi"');
		expect(files_folder_table_query_parse_token('file.name:contains:"a"b').problem).toBe(
			"Nothing can follow the closing quote",
		);
	});

	test("reads a sort token", () => {
		expect(files_folder_table_query_parse_token("sort_by:file.updated:desc")).toEqual({
			token: { kind: "sort", raw: "sort_by:file.updated:desc", field: "updated", direction: "desc" },
			problem: null,
		});
		expect(files_folder_table_query_parse_token("sort_by:metadata.plugin-name:asc").token).toMatchObject({
			field: "metadata.plugin-name",
		});
	});

	test("refuses a token the table cannot run", () => {
		const problems = (raw: string) => files_folder_table_query_parse_token(raw).problem;

		expect(problems("report")).toBe(
			"Type a filter like file.name:contains:report, or a sort like sort_by:file.updated:desc",
		);
		expect(problems("!file.name:contains:x")).toBe("Not is not available in the folder table");
		expect(problems("status:is:open")).toBe("Start the field with file., metadata. or frontmatter.");
		expect(problems("file.path:is:x")).toBe(
			"Unknown file field. Use file.name, file.updated, file.created, file.ext, file.size",
		);
		expect(problems("metadata.a:b:is:x")).toBe("Use one of is, starts_with, present, missing");
		expect(problems("file.name:is:x")).toBe("Use one of contains, starts_with");
		expect(problems("file.name:contains")).toBe("contains needs a value, like contains:value");
		expect(problems("metadata.status:present:x")).toBe("present takes no value");
		expect(problems("file.size:is:1KB")).toBe("Enter a whole number of bytes, zero or more");
		expect(problems("file.size:is:-1")).toBe("Enter a whole number of bytes, zero or more");
		expect(problems("file.updated:on:2026-02-31")).toBe("Enter a valid calendar day like 2026-09-04");
		expect(problems("file.updated:on:yesterday")).toBe("Enter a valid calendar day like 2026-09-04");
		expect(problems("file.name:contains:")).toBe("Enter 1 to 1,024 characters");
		expect(problems('file.name:contains:6"')).toBe('Put the value in quotes to use a " in it');
		expect(problems('file.name:contains:"6\\""')).toBeNull();
		expect(problems("sort_by:file.name")).toBe("Write sort_by:<field>:asc or sort_by:<field>:desc");
		expect(problems("sort_by:file.name:up")).toBe("A sort direction is asc or desc");
		expect(problems("sort_by:name:asc")).toBe("Start the field with file., metadata. or frontmatter.");
	});

	test("updated_by is a column only", () => {
		expect(files_folder_table_query_parse_token("file.updated_by:is:x").problem).toBe(
			"Unknown file field. Use file.name, file.updated, file.created, file.ext, file.size",
		);
		expect(files_folder_table_query_parse_token("sort_by:file.updated_by:asc").token).toBeNull();
	});
});

describe("files_folder_table_query_parse", () => {
	test("keeps one filter and the sorts in order, and lists what it drops", () => {
		const parsed = files_folder_table_query_parse(
			"file.name:contains:report sort_by:file.updated:desc free file.size:is:1 sort_by:file.name:asc sort_by:file.updated:asc",
		);

		expect(parsed.filter?.raw).toBe("file.name:contains:report");
		expect(parsed.sorts.map((sort) => sort.raw)).toEqual(["sort_by:file.updated:desc", "sort_by:file.name:asc"]);
		expect(parsed.rejected.map((token) => token.raw)).toEqual(["free", "file.size:is:1", "sort_by:file.updated:asc"]);
		expect(parsed.rejected.map((token) => token.problem)).toEqual([
			"Type a filter like file.name:contains:report, or a sort like sort_by:file.updated:desc",
			"The folder table can use one filter at a time",
			"Each sort field can be used once",
		]);
	});

	test("keeps the first sorts up to the limit and drops the rest", () => {
		const tokens = Array.from({ length: files_sort_MAX_CLAUSES + 2 }, (_, index) => `sort_by:metadata.k${index}:asc`);
		const parsed = files_folder_table_query_parse(tokens.join(" "));

		expect(parsed.sorts).toHaveLength(files_sort_MAX_CLAUSES);
		expect(parsed.rejected.map((token) => token.raw)).toEqual(tokens.slice(files_sort_MAX_CLAUSES));
		expect(parsed.rejected[0]!.problem).toBe(`Use at most ${files_sort_MAX_CLAUSES} sorts`);
	});

	test("closes an open quote in the last token", () => {
		const parsed = files_folder_table_query_parse('file.name:contains:"my rep');
		expect(parsed.filter).toMatchObject({ raw: 'file.name:contains:"my rep"', value: "my rep" });
		// A bare quote inside a value is not closed. It stays as typed and is refused.
		expect(files_folder_table_query_close_open_quote('file.name:contains:6"')).toBe('file.name:contains:6"');
		expect(files_folder_table_query_parse('file.name:contains:6"').rejected.map((token) => token.raw)).toEqual([
			'file.name:contains:6"',
		]);
	});
});

describe("files_folder_table_query_clean", () => {
	test("drops what cannot run and keeps the order", () => {
		expect(
			files_folder_table_query_clean(
				"  sort_by:file.size:desc   nonsense metadata.a:is:1 metadata.b:is:2 sort_by:file.size:asc !x:y  sort_by:file.name:asc ",
			),
		).toBe("sort_by:file.size:desc metadata.a:is:1 sort_by:file.name:asc");
		expect(files_folder_table_query_clean("")).toBe("");
		expect(files_folder_table_query_clean("   ")).toBe("");
	});

	test("cleaning a clean query changes nothing", () => {
		for (const query of [
			"",
			"file.name:contains:report sort_by:file.updated:desc",
			'metadata.note:is:"a b" sort_by:metadata.plugin-name:asc',
			"junk sort_by:file.name:up metadata.x:is:1 metadata.y:is:2",
			'file.name:contains:"open',
		]) {
			const once = files_folder_table_query_clean(query);
			expect(files_folder_table_query_clean(once)).toBe(once);
			expect(files_folder_table_query_parse(once).rejected).toEqual([]);
		}
	});
});

describe("files_folder_table_query_get_add_problem", () => {
	test("says why a token cannot join the query, and nothing when it can", () => {
		const query = "file.name:contains:x sort_by:file.updated:desc";

		expect(files_folder_table_query_get_add_problem(query, "file.size:is:1")).toBe(
			"The folder table can use one filter at a time",
		);
		expect(files_folder_table_query_get_add_problem(query, "sort_by:file.updated:asc")).toBe(
			"Each sort field can be used once",
		);
		expect(files_folder_table_query_get_add_problem(query, "sort_by:file.size:asc")).toBeNull();
		expect(files_folder_table_query_get_add_problem("", "file.size:is:1")).toBeNull();
		expect(files_folder_table_query_get_add_problem("", "oops")).not.toBeNull();
		expect(
			files_folder_table_query_get_add_problem("a".repeat(files_folder_table_query_MAX_LENGTH), "file.size:is:1"),
		).toBe("The filter and sort text is too long");
	});
});

describe("files_folder_table_query_with_filter and with_sort", () => {
	test("replace one part and keep the other", () => {
		const query = "file.name:contains:a sort_by:file.size:desc";

		expect(files_folder_table_query_with_filter(query, "file.ext:is:md")).toBe("file.ext:is:md sort_by:file.size:desc");
		expect(files_folder_table_query_with_filter(query, null)).toBe("sort_by:file.size:desc");

		expect(
			files_folder_table_query_with_sort(query, [
				{ field: "type", direction: "asc" },
				{ field: "metadata.status", direction: "desc" },
			]),
		).toBe("file.name:contains:a sort_by:file.ext:asc sort_by:metadata.status:desc");
		expect(files_folder_table_query_with_sort(query, [])).toBe("file.name:contains:a");
		// Only the first clauses up to the limit are kept.
		const manyClauses = Array.from({ length: files_sort_MAX_CLAUSES + 1 }, (_, index) => ({
			field: `metadata.k${index}`,
			direction: "asc" as const,
		}));
		expect(files_folder_table_query_parse(files_folder_table_query_with_sort("", manyClauses)).sorts).toHaveLength(
			files_sort_MAX_CLAUSES,
		);
	});
});

describe("files_folder_table_query_to_sort", () => {
	test("is null with no sort token, and the clauses otherwise", () => {
		expect(files_folder_table_query_to_sort(files_folder_table_query_parse("file.name:contains:a"))).toBeNull();
		expect(
			files_folder_table_query_to_sort(files_folder_table_query_parse("sort_by:file.ext:asc sort_by:file.name:desc")),
		).toEqual([
			{ field: "type", direction: "asc" },
			{ field: "name", direction: "desc" },
		]);
	});
});

describe("files_folder_table_query_to_filter", () => {
	test("builds a filter the table accepts for each kind", () => {
		const cases: Array<[string, unknown]> = [
			["file.name:starts_with:Rep", { kind: "name", field: "name", op: "starts_with", value: "Rep" }],
			["file.ext:is:md", { kind: "type", field: "type", op: "is", value: "md" }],
			["file.ext:missing", { kind: "type", field: "type", op: "missing" }],
			[
				"file.updated:on:2026-09-04",
				{ kind: "date", field: "updated", op: "on", start: Date.UTC(2026, 8, 4), end: Date.UTC(2026, 8, 5) },
			],
			[
				"file.created:before:2026-09-04",
				{ kind: "date", field: "created", op: "before", start: Date.UTC(2026, 8, 4), end: Date.UTC(2026, 8, 5) },
			],
			["file.size:at_least:1024", { kind: "size", field: "size", op: "at_least", value: 1024 }],
			["file.size:missing", { kind: "size", field: "size", op: "missing" }],
			["metadata.status:is:open", { kind: "text", field: "metadata.status", op: "is", value: "open" }],
			["frontmatter.due:present", { kind: "text", field: "frontmatter.due", op: "present" }],
			["metadata.status:missing", { kind: "text", field: "metadata.status", op: "missing" }],
		];

		for (const [raw, expected] of cases) {
			const filter = files_folder_table_query_to_filter(parse_filter(raw), get_day_bounds);
			expect(filter).toEqual(expected);
			expect(files_table_filter_is_valid(filter!)).toBe(true);
		}
		expect(files_folder_table_query_to_filter(null, get_day_bounds)).toBeNull();
	});

	test("is null when the day cannot be turned into bounds", () => {
		expect(files_folder_table_query_to_filter(parse_filter("file.updated:on:2026-09-04"), () => null)).toBeNull();
	});
});

describe("files_folder_table_query_operations", () => {
	test("allows each field only the operations the table can run", () => {
		const ops = (field: string) => files_folder_table_query_operations(field).map((operation) => operation.op);

		expect(ops("name")).toEqual(["contains", "starts_with"]);
		expect(ops("type")).toEqual(["is", "missing"]);
		expect(ops("updated")).toEqual(["on", "before", "after"]);
		expect(ops("size")).toEqual(["is", "at_least", "at_most", "missing"]);
		expect(ops("metadata.x")).toEqual(["is", "starts_with", "present", "missing"]);
	});
});

describe("files_folder_table_query_format_value", () => {
	test("quotes a value only when the parser needs it", () => {
		expect(files_folder_table_query_format_value("report")).toBe("report");
		expect(files_folder_table_query_format_value("a:b")).toBe("a:b");
		expect(files_folder_table_query_format_value("my report")).toBe('"my report"');
		expect(files_folder_table_query_format_value('say "hi"')).toBe('"say \\"hi\\""');
		expect(files_folder_table_query_format_value("")).toBe('""');

		for (const value of ["my report", 'say "hi"', "a:b"]) {
			const token = parse_filter(`metadata.x:is:${files_folder_table_query_format_value(value)}`);
			expect(token.value).toBe(value);
		}
	});
});
