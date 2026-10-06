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
		expect(parse_filter("file.name:starts_with:report")).toEqual({
			kind: "filter",
			raw: "file.name:starts_with:report",
			field: "name",
			op: "starts_with",
			value: "report",
		});
		expect(parse_filter("metadata.status:present")).toMatchObject({ field: "metadata.status", value: null });
		expect(parse_filter("frontmatter.a.b:starts_with:x")).toMatchObject({ field: "frontmatter.a.b", value: "x" });
	});

	test("names every field once, and refuses the old file.ext", () => {
		expect(parse_filter("file.extension:is:md")).toMatchObject({ field: "extension", op: "is", value: "md" });
		expect(files_folder_table_query_parse_token("file.ext:is:md").problem).toContain("Unknown file field");
		for (const field of ["name", "extension", "size", "created", "updated", "updated_by"]) {
			expect(files_folder_table_query_field_text(field)).toBe(`file.${field}`);
		}
		expect(files_folder_table_query_field_text("metadata.status")).toBe("metadata.status");
		expect(files_folder_table_query_field_text("frontmatter.title")).toBe("frontmatter.title");
	});

	test("keeps a colon in the value, and reads a quoted value", () => {
		expect(parse_filter("metadata.id:is:a:b:c").value).toBe("a:b:c");
		expect(parse_filter('file.name:starts_with:"my report"').value).toBe("my report");
		expect(parse_filter('metadata.note:is:"say \\"hi\\""').value).toBe('say "hi"');
		expect(files_folder_table_query_parse_token('file.name:starts_with:"a"b').problem).toBe(
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
			"Type a filter like file.name:starts_with:report, or a sort like sort_by:file.updated:desc",
		);
		expect(problems("!file.name:starts_with:x")).toBe("Not is not available in the folder table");
		expect(problems("status:is:open")).toBe("Start the field with file., metadata. or frontmatter.");
		expect(problems("file.path:is:x")).toBe(
			"Unknown file field. Use file.name, file.updated, file.created, file.extension, file.size",
		);
		expect(problems("metadata.a:b:is:x")).toBe("Use one of is, starts_with, present");
		expect(problems("metadata.a:missing")).toBe("Use one of is, starts_with, present");
		expect(problems("file.name:is:x")).toBe("Use one of starts_with");
		expect(problems("file.name:contains:x")).toBe("Use one of starts_with");
		expect(problems("file.name:starts_with")).toBe("starts_with needs a value, like starts_with:value");
		expect(problems("metadata.status:present:x")).toBe("present takes no value");
		expect(problems("file.size:is:1KB")).toBe("Enter a whole number of bytes, zero or more");
		expect(problems("file.size:is:-1")).toBe("Enter a whole number of bytes, zero or more");
		expect(problems("file.updated:on:2026-02-31")).toBe("Enter a valid calendar day like 2026-09-04");
		expect(problems("file.updated:on:yesterday")).toBe("Enter a valid calendar day like 2026-09-04");
		expect(problems("file.name:starts_with:")).toBe("Enter 1 to 1,024 characters");
		// The sort key writes a number with its length first, so the prefix cannot end in a digit.
		expect(problems("file.name:starts_with:file1")).toBe(
			"'Starts with' cannot end with a number here. Remove the last digits, or use 'is'.",
		);
		expect(problems("metadata.version:starts_with:v2")).toBe(
			"'Starts with' cannot end with a number here. Remove the last digits, or use 'is'.",
		);
		expect(problems("metadata.version:is:2")).toBeNull();
		expect(problems('file.name:starts_with:6"')).toBe('Put the value in quotes to use a " in it');
		expect(problems('file.name:starts_with:"6\\""')).toBeNull();
		expect(problems("sort_by:file.name")).toBe("Write sort_by:<field>:asc or sort_by:<field>:desc");
		expect(problems("sort_by:file.name:up")).toBe("A sort direction is asc or desc");
		expect(problems("sort_by:name:asc")).toBe("Start the field with file., metadata. or frontmatter.");
	});

	test("updated_by is a column only", () => {
		expect(files_folder_table_query_parse_token("file.updated_by:is:x").problem).toBe(
			"Unknown file field. Use file.name, file.updated, file.created, file.extension, file.size",
		);
		expect(files_folder_table_query_parse_token("sort_by:file.updated_by:asc").token).toBeNull();
	});
});

describe("files_folder_table_query_parse", () => {
	const PAIR_PROBLEM = "Use one filter, or 'name starts with' plus one 'is' filter.";

	test("keeps one filter and one sort, and lists what it drops", () => {
		const parsed = files_folder_table_query_parse(
			"file.size:at_least:1 sort_by:file.size:desc free file.extension:is:md sort_by:file.size:asc",
		);

		expect(parsed.filter?.raw).toBe("file.size:at_least:1");
		expect(parsed.namePrefix).toBeNull();
		expect(parsed.sorts.map((sort) => sort.raw)).toEqual(["sort_by:file.size:desc"]);
		expect(parsed.rejected).toEqual([
			{
				raw: "free",
				problem: "Type a filter like file.name:starts_with:report, or a sort like sort_by:file.updated:desc",
			},
			{ raw: "file.extension:is:md", problem: PAIR_PROBLEM },
			{ raw: "sort_by:file.size:asc", problem: "The folder table sorts by one field" },
		]);
	});

	test.each(["file.name:starts_with:rep file.extension:is:md", "file.extension:is:md file.name:starts_with:rep"])(
		"keeps 'name starts with' plus one 'is' filter in either order: %s",
		(query) => {
			const parsed = files_folder_table_query_parse(query);

			expect(parsed.filter?.raw).toBe("file.extension:is:md");
			expect(parsed.namePrefix?.raw).toBe("file.name:starts_with:rep");
			expect(parsed.rejected).toEqual([]);
			expect(files_folder_table_query_clean(query)).toBe(query);
		},
	);

	test.each([
		["file.name:starts_with:rep", "file.size:at_least:1"],
		["file.name:starts_with:rep", "metadata.status:present"],
		["file.name:starts_with:rep", "file.updated:on:2026-09-04"],
		["file.name:starts_with:rep", "file.name:starts_with:other"],
		["file.extension:is:md", "file.size:is:1"],
		["file.extension:is:md file.name:starts_with:rep", "metadata.status:is:open"],
	])("refuses other filter pairs: %s + %s", (kept, refused) => {
		expect(files_folder_table_query_parse(`${kept} ${refused}`).rejected).toEqual([
			{ raw: refused, problem: PAIR_PROBLEM },
		]);
	});

	test("a filter fixes the sort field, and filters win over sorts", () => {
		const problems = (query: string) =>
			files_folder_table_query_parse(query).rejected.map((token) => `${token.raw}: ${token.problem}`);

		expect(problems("sort_by:file.name:asc file.updated:on:2026-09-04")).toEqual([
			"sort_by:file.name:asc: Remove the filter to sort by file.name",
		]);
		expect(problems("file.updated:on:2026-09-04 sort_by:file.updated:desc")).toEqual([]);
		expect(problems("file.size:at_most:5 sort_by:file.size:desc")).toEqual([]);
		expect(problems("file.size:is:5 sort_by:file.size:desc")).toEqual([
			"sort_by:file.size:desc: Remove the filter to sort by file.size",
		]);
		expect(problems("metadata.status:starts_with:op sort_by:metadata.status:asc")).toEqual([]);
		expect(problems("metadata.status:is:open sort_by:file.name:desc")).toEqual([]);
		expect(problems("metadata.status:present sort_by:metadata.other:desc")).toEqual([
			"sort_by:metadata.other:desc: Remove the filter to sort by metadata.other",
		]);
	});

	test("closes an open quote in the last token", () => {
		const parsed = files_folder_table_query_parse('file.name:starts_with:"my rep');
		expect(parsed.filter).toMatchObject({ raw: 'file.name:starts_with:"my rep"', value: "my rep" });
		// A bare quote inside a value is not closed. It stays as typed and is refused.
		expect(files_folder_table_query_close_open_quote('file.name:starts_with:6"')).toBe('file.name:starts_with:6"');
		expect(files_folder_table_query_parse('file.name:starts_with:6"').rejected.map((token) => token.raw)).toEqual([
			'file.name:starts_with:6"',
		]);
	});
});

describe("files_folder_table_query_clean", () => {
	test("drops what cannot run and keeps the order", () => {
		expect(
			files_folder_table_query_clean(
				"  sort_by:file.size:desc   nonsense metadata.a:is:1 metadata.b:is:2 sort_by:file.size:asc !x:y  sort_by:file.name:asc ",
			),
		).toBe("metadata.a:is:1 sort_by:file.name:asc");
		expect(files_folder_table_query_clean("")).toBe("");
		expect(files_folder_table_query_clean("   ")).toBe("");
	});

	test("cleaning a clean query changes nothing", () => {
		for (const query of [
			"",
			"file.name:starts_with:report sort_by:file.name:desc",
			'metadata.note:is:"a b" sort_by:file.name:asc',
			"junk sort_by:file.name:up metadata.x:is:1 metadata.y:is:2",
			'file.name:starts_with:"open',
			"file.name:starts_with:rep file.extension:is:md sort_by:file.name:desc",
		]) {
			const once = files_folder_table_query_clean(query);
			expect(files_folder_table_query_clean(once)).toBe(once);
			expect(files_folder_table_query_parse(once).rejected).toEqual([]);
		}
	});
});

describe("files_folder_table_query_get_add_problem", () => {
	test("says why a token cannot join the query, and nothing when it can", () => {
		const query = "file.extension:is:md sort_by:file.name:desc";

		expect(files_folder_table_query_get_add_problem(query, "file.size:is:1")).toBe(
			"Use one filter, or 'name starts with' plus one 'is' filter.",
		);
		expect(files_folder_table_query_get_add_problem(query, "file.name:starts_with:a")).toBeNull();
		expect(files_folder_table_query_get_add_problem(query, "sort_by:file.updated:asc")).toBe(
			"Remove the filter to sort by file.updated",
		);
		expect(files_folder_table_query_get_add_problem(query, "sort_by:file.name:asc")).toBe(
			"The folder table sorts by one field",
		);
		expect(files_folder_table_query_get_add_problem("", "file.size:is:1")).toBeNull();
		expect(files_folder_table_query_get_add_problem("", "oops")).not.toBeNull();
		expect(
			files_folder_table_query_get_add_problem("a".repeat(files_folder_table_query_MAX_LENGTH), "file.size:is:1"),
		).toBe("The filter and sort text is too long");
	});
});

describe("files_folder_table_query_with_filter and with_sort", () => {
	test("replace one part and keep the other when the filter allows it", () => {
		const query = "file.name:starts_with:a sort_by:file.name:desc";

		expect(files_folder_table_query_with_filter(query, "file.extension:is:md")).toBe(
			"file.extension:is:md sort_by:file.name:desc",
		);
		// A range filter orders by its own field, so the name sort goes.
		expect(files_folder_table_query_with_filter(query, "file.size:at_least:1")).toBe("file.size:at_least:1");
		expect(files_folder_table_query_with_filter(query, null)).toBe("sort_by:file.name:desc");

		expect(files_folder_table_query_with_sort(query, [{ field: "name", direction: "asc" }])).toBe(
			"file.name:starts_with:a sort_by:file.name:asc",
		);
		expect(files_folder_table_query_with_sort(query, [{ field: "size", direction: "asc" }])).toBe(
			"file.name:starts_with:a",
		);
		expect(files_folder_table_query_with_sort(query, [])).toBe("file.name:starts_with:a");
		expect(
			files_folder_table_query_with_sort("file.extension:is:md file.name:starts_with:a", [
				{ field: "name", direction: "desc" },
			]),
		).toBe("file.extension:is:md file.name:starts_with:a sort_by:file.name:desc");
		// Only the first clause is kept.
		expect(
			files_folder_table_query_with_sort("", [
				{ field: "extension", direction: "asc" },
				{ field: "metadata.status", direction: "desc" },
			]),
		).toBe("sort_by:file.extension:asc");
	});
});

describe("files_folder_table_query_to_sort", () => {
	test("is null with no sort token, and the one clause otherwise", () => {
		expect(files_folder_table_query_to_sort(files_folder_table_query_parse("file.name:starts_with:a"))).toBeNull();
		expect(
			files_folder_table_query_to_sort(
				files_folder_table_query_parse("sort_by:file.extension:asc sort_by:file.name:desc"),
			),
		).toEqual([{ field: "extension", direction: "asc" }]);
	});
});

describe("files_folder_table_query_to_filter", () => {
	test("builds a filter the table accepts for each kind", () => {
		const cases: Array<[string, unknown]> = [
			["file.name:starts_with:Rep", { kind: "name", field: "name", op: "starts_with", value: "Rep" }],
			["file.extension:is:md", { kind: "extension", field: "extension", op: "is", value: "md" }],
			["file.extension:missing", { kind: "extension", field: "extension", op: "missing" }],
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
			["metadata.status:starts_with:op", { kind: "text", field: "metadata.status", op: "starts_with", value: "op" }],
			["frontmatter.due:present", { kind: "text", field: "frontmatter.due", op: "present" }],
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

		expect(ops("name")).toEqual(["starts_with"]);
		expect(ops("extension")).toEqual(["is", "missing"]);
		expect(ops("updated")).toEqual(["on", "before", "after"]);
		expect(ops("size")).toEqual(["is", "at_least", "at_most", "missing"]);
		expect(ops("metadata.x")).toEqual(["is", "starts_with", "present"]);
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
