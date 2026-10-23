import { describe, expect, test } from "vitest";
import {
	files_folder_table_query_clean,
	files_folder_table_query_close_open_quote,
	files_folder_table_query_field_text,
	files_folder_table_query_forms,
	files_folder_table_query_get_add_problem,
	files_folder_table_query_MAX_LENGTH,
	files_folder_table_query_parse,
	files_folder_table_query_parse_token,
	files_folder_table_query_to_filter,
	files_folder_table_query_to_sort,
	files_folder_table_query_with_filter,
	files_folder_table_query_with_sort,
	type files_folder_table_query_FilterToken,
} from "./files-folder-table-query.ts";
import {
	files_search_query_format_value,
	files_search_query_parse,
	files_search_query_SYNTAX_EXAMPLES,
} from "./files-search-query.ts";
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
	test("reads the search box value forms", () => {
		expect(parse_filter("file.name:report*")).toEqual({
			kind: "filter",
			raw: "file.name:report*",
			field: "name",
			op: "starts_with",
			value: "report",
		});
		expect(parse_filter("metadata.status:open")).toMatchObject({ field: "metadata.status", op: "is", value: "open" });
		expect(parse_filter("metadata.status:op*")).toMatchObject({ op: "starts_with", value: "op" });
		expect(parse_filter("metadata.status:*")).toMatchObject({ op: "present", value: null });
		expect(parse_filter("frontmatter.a.b:x*")).toMatchObject({ field: "frontmatter.a.b", value: "x" });
		expect(parse_filter("file.extension:md")).toMatchObject({ field: "extension", op: "is", value: "md" });
		expect(parse_filter("!file.extension:*")).toMatchObject({ field: "extension", op: "missing", value: null });
		expect(parse_filter("!file.size:*")).toMatchObject({ field: "size", op: "missing", value: null });
		expect(parse_filter("file.updated:2026-09-04")).toMatchObject({ op: "on", value: "2026-09-04" });
	});

	test("moves a strict size or a day bound to its whole neighbour", () => {
		const opValue = (raw: string) => {
			const token = parse_filter(raw);
			return `${token.op} ${token.value}`;
		};

		expect(opValue("file.size:1024")).toBe("is 1024");
		expect(opValue("file.size:>=1024")).toBe("at_least 1024");
		expect(opValue("file.size:>1024")).toBe("at_least 1025");
		expect(opValue("file.size:<=1024")).toBe("at_most 1024");
		expect(opValue("file.size:<1024")).toBe("at_most 1023");
		expect(files_folder_table_query_parse_token("file.size:<0").problem).toBe(
			"Enter a whole number of bytes, zero or more",
		);
		expect(opValue("file.updated:<2026-09-04")).toBe("before 2026-09-04");
		expect(opValue("file.updated:<=2026-09-04")).toBe("before 2026-09-05");
		expect(opValue("file.updated:>2026-09-04")).toBe("after 2026-09-04");
		expect(opValue("file.updated:>=2026-09-04")).toBe("after 2026-09-03");
		// The shift crosses month and year ends.
		expect(opValue("file.created:<=2026-12-31")).toBe("before 2027-01-01");
		expect(opValue("file.created:>=2026-03-01")).toBe("after 2026-02-28");
	});

	test("names every field once, and refuses the old file.ext", () => {
		expect(files_folder_table_query_parse_token("file.ext:md").problem).toContain("Unknown file field");
		for (const field of ["name", "extension", "size", "created", "updated", "updated_by"]) {
			expect(files_folder_table_query_field_text(field)).toBe(`file.${field}`);
		}
		expect(files_folder_table_query_field_text("metadata.status")).toBe("metadata.status");
		expect(files_folder_table_query_field_text("frontmatter.title")).toBe("frontmatter.title");
	});

	test("keeps a colon in the value, and reads a quoted value", () => {
		expect(parse_filter("metadata.id:a:b:c").value).toBe("a:b:c");
		expect(parse_filter('file.name:"my report"*').value).toBe("my report");
		expect(parse_filter('metadata.note:"say \\"hi\\""').value).toBe('say "hi"');
		expect(files_folder_table_query_parse_token('metadata.note:"a"b').problem).toBe(
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

	test("reads a value the bar formats back as the same exact value", () => {
		for (const value of ["report", "a:b", "my report", 'say "hi"', "op*", ">2"]) {
			const token = parse_filter(`metadata.x:${files_search_query_format_value(value)}`);
			expect(token).toMatchObject({ op: "is", value });
		}
	});

	test("refuses a token the table cannot run", () => {
		const problems = (raw: string) => files_folder_table_query_parse_token(raw).problem;

		expect(problems("report")).toBe("Type a filter like file.name:report*, or a sort like sort_by:file.updated:desc");
		expect(problems("status:open")).toBe("Type a filter like file.name:report*, or a sort like sort_by:file.updated:desc");
		// The old operation words read as a value now, and the table says what it takes.
		expect(problems("file.name:starts_with:x")).toBe("Filter names by their start, like file.name:report*");
		expect(problems("file.size:at_least:1")).toBe("Enter a whole number of bytes, zero or more");
		expect(problems("!file.name:x*")).toBe("Use ! only for a missing value, like !file.extension:* or !file.size:*");
		expect(problems("!metadata.status:*")).toBe(
			"Use ! only for a missing value, like !file.extension:* or !file.size:*",
		);
		expect(problems("file.path:/tasks/**")).toBe("The folder table shows one folder. Use file.path in the search box");
		expect(problems("file.content:report")).toBe("Search contents in the search box");
		expect(problems("file.link:public")).toBe("Find public links in the search box");
		expect(problems("file.name:report")).toBe("Filter names by their start, like file.name:report*");
		expect(problems("file.extension:*")).toBe(
			"Write an extension like file.extension:md, or use !file.extension:* for none",
		);
		expect(problems("metadata.priority:>2")).toBe(
			"The folder table compares this field with a value, like metadata.status:open, open*, or *",
		);
		expect(problems("metadata.status:")).toBe("Filter needs a value right after the colon. Use * for any value");
		expect(problems("file.size:1KB")).toBe("Enter a whole number of bytes, zero or more");
		expect(problems("file.size:-1")).toBe("Enter a whole number of bytes, zero or more");
		expect(problems("file.updated:2026-02-31")).toBe("Enter a valid calendar day like 2026-09-04");
		expect(problems("file.updated:yesterday")).toBe("Enter a valid calendar day like 2026-09-04");
		// A file field names its own form, not the search box's `*`, which the table refuses there.
		expect(problems("file.size:")).toBe("Enter a whole number of bytes, zero or more");
		expect(problems("file.updated:")).toBe("Enter a valid calendar day like 2026-09-04");
		expect(problems("metadata.status:!done")).toBe(
			"Use ! only for a missing value, like !file.extension:* or !file.size:*",
		);
		// The next day after the last calendar day is not a day the browser can read.
		expect(problems("file.updated:<=9999-12-31")).toBe("Enter a valid calendar day like 2026-09-04");
		// The sort key writes a number with its length first, so the prefix cannot end in a digit.
		expect(problems("file.name:file1*")).toBe(
			"'Starts with' cannot end with a number here. Remove the last digits, or use an exact value",
		);
		expect(problems("metadata.version:v2*")).toBe(
			"'Starts with' cannot end with a number here. Remove the last digits, or use an exact value",
		);
		expect(problems("metadata.version:2")).toBeNull();
		expect(problems('file.name:6"*')).toBe('Put the value in quotes to use a " in it');
		expect(problems('file.name:"6\\""*')).toBeNull();
		expect(problems("sort_by:file.name")).toBe("Write sort_by:<field>:asc or sort_by:<field>:desc");
		expect(problems("sort_by:file.name:up")).toBe("A sort direction is asc or desc");
		expect(problems("sort_by:name:asc")).toBe("Start the field with file., metadata. or frontmatter.");
	});

	test("updated_by is a column only", () => {
		expect(files_folder_table_query_parse_token("file.updated_by:x").problem).toBe(
			"Unknown file field. Use file.name, file.updated, file.created, file.extension, file.size",
		);
		expect(files_folder_table_query_parse_token("sort_by:file.updated_by:asc").token).toBeNull();
	});
});

describe("files_folder_table_query_parse", () => {
	const PAIR_PROBLEM = "Use one filter, or 'name starts with' plus one 'is' filter";

	test("keeps one filter and one sort, and lists what it drops", () => {
		const parsed = files_folder_table_query_parse(
			"file.size:>=1 sort_by:file.size:desc free file.extension:md sort_by:file.size:asc",
		);

		expect(parsed.filter?.raw).toBe("file.size:>=1");
		expect(parsed.namePrefix).toBeNull();
		expect(parsed.sorts.map((sort) => sort.raw)).toEqual(["sort_by:file.size:desc"]);
		expect(parsed.rejected).toEqual([
			{
				raw: "free",
				problem: "Type a filter like file.name:report*, or a sort like sort_by:file.updated:desc",
			},
			{ raw: "file.extension:md", problem: PAIR_PROBLEM },
			{ raw: "sort_by:file.size:asc", problem: "The folder table sorts by one field" },
		]);
	});

	test.each(["file.name:rep* file.extension:md", "file.extension:md file.name:rep*", "file.name:rep* !file.size:*"])(
		"keeps a name prefix plus one 'is' filter in either order: %s",
		(query) => {
			const parsed = files_folder_table_query_parse(query);

			expect(parsed.namePrefix?.raw).toBe("file.name:rep*");
			expect(parsed.rejected).toEqual([]);
			expect(files_folder_table_query_clean(query)).toBe(query);
		},
	);

	test.each([
		["file.name:rep*", "file.size:>=1"],
		["file.name:rep*", "metadata.status:*"],
		["file.name:rep*", "file.updated:2026-09-04"],
		["file.name:rep*", "file.name:other*"],
		["file.extension:md", "file.size:1"],
		["file.extension:md file.name:rep*", "metadata.status:open"],
	])("refuses other filter pairs: %s + %s", (kept, refused) => {
		expect(files_folder_table_query_parse(`${kept} ${refused}`).rejected).toEqual([
			{ raw: refused, problem: PAIR_PROBLEM },
		]);
	});

	test("a filter fixes the sort field, and filters win over sorts", () => {
		const problems = (query: string) =>
			files_folder_table_query_parse(query).rejected.map((token) => `${token.raw}: ${token.problem}`);

		expect(problems("sort_by:file.name:asc file.updated:2026-09-04")).toEqual([
			"sort_by:file.name:asc: Remove the filter to sort by file.name",
		]);
		expect(problems("file.updated:2026-09-04 sort_by:file.updated:desc")).toEqual([]);
		expect(problems("file.size:<=5 sort_by:file.size:desc")).toEqual([]);
		expect(problems("file.size:5 sort_by:file.size:desc")).toEqual([
			"sort_by:file.size:desc: Remove the filter to sort by file.size",
		]);
		expect(problems("metadata.status:op* sort_by:metadata.status:asc")).toEqual([]);
		expect(problems("metadata.status:open sort_by:file.name:desc")).toEqual([]);
		expect(problems("metadata.status:* sort_by:metadata.other:desc")).toEqual([
			"sort_by:metadata.other:desc: Remove the filter to sort by metadata.other",
		]);
	});

	test("closes an open quote in the last token", () => {
		const parsed = files_folder_table_query_parse('metadata.note:"my rep');
		expect(parsed.filter).toMatchObject({ raw: 'metadata.note:"my rep"', value: "my rep" });
		// A bare quote inside a value is not closed. It stays as typed and is refused.
		expect(files_folder_table_query_close_open_quote('metadata.note:6"')).toBe('metadata.note:6"');
		expect(files_folder_table_query_parse('metadata.note:6"').rejected.map((token) => token.raw)).toEqual([
			'metadata.note:6"',
		]);
	});
});

describe("files_folder_table_query_clean", () => {
	test("drops what cannot run and keeps the order", () => {
		expect(
			files_folder_table_query_clean(
				"  sort_by:file.size:desc   nonsense metadata.a:1 metadata.b:2 sort_by:file.size:asc !x:y  sort_by:file.name:asc ",
			),
		).toBe("metadata.a:1 sort_by:file.name:asc");
		expect(files_folder_table_query_clean("")).toBe("");
		expect(files_folder_table_query_clean("   ")).toBe("");
	});

	test("cleaning a clean query changes nothing", () => {
		for (const query of [
			"",
			"file.name:report* sort_by:file.name:desc",
			'metadata.note:"a b" sort_by:file.name:asc',
			"junk sort_by:file.name:up metadata.x:1 metadata.y:2",
			'metadata.note:"open',
			"file.name:rep* file.extension:md sort_by:file.name:desc",
		]) {
			const once = files_folder_table_query_clean(query);
			expect(files_folder_table_query_clean(once)).toBe(once);
			expect(files_folder_table_query_parse(once).rejected).toEqual([]);
		}
	});
});

describe("files_folder_table_query_get_add_problem", () => {
	test("says why a token cannot join the query, and nothing when it can", () => {
		const query = "file.extension:md sort_by:file.name:desc";

		expect(files_folder_table_query_get_add_problem(query, "file.size:1")).toBe(
			"Use one filter, or 'name starts with' plus one 'is' filter",
		);
		expect(files_folder_table_query_get_add_problem(query, "file.name:a*")).toBeNull();
		expect(files_folder_table_query_get_add_problem(query, "sort_by:file.updated:asc")).toBe(
			"Remove the filter to sort by file.updated",
		);
		expect(files_folder_table_query_get_add_problem(query, "sort_by:file.name:asc")).toBe(
			"The folder table sorts by one field",
		);
		expect(files_folder_table_query_get_add_problem("", "file.size:1")).toBeNull();
		expect(files_folder_table_query_get_add_problem("", "oops")).not.toBeNull();
		expect(
			files_folder_table_query_get_add_problem("a".repeat(files_folder_table_query_MAX_LENGTH), "file.size:1"),
		).toBe("The filter and sort text is too long");
	});
});

describe("files_folder_table_query_with_filter and with_sort", () => {
	test("replace one part and keep the other when the filter allows it", () => {
		const query = "file.name:a* sort_by:file.name:desc";

		expect(files_folder_table_query_with_filter(query, "file.extension:md")).toBe(
			"file.extension:md sort_by:file.name:desc",
		);
		// A range filter orders by its own field, so the name sort goes.
		expect(files_folder_table_query_with_filter(query, "file.size:>=1")).toBe("file.size:>=1");
		expect(files_folder_table_query_with_filter(query, null)).toBe("sort_by:file.name:desc");

		expect(files_folder_table_query_with_sort(query, [{ field: "name", direction: "asc" }])).toBe(
			"file.name:a* sort_by:file.name:asc",
		);
		expect(files_folder_table_query_with_sort(query, [{ field: "size", direction: "asc" }])).toBe("file.name:a*");
		expect(files_folder_table_query_with_sort(query, [])).toBe("file.name:a*");
		expect(
			files_folder_table_query_with_sort("file.extension:md file.name:a*", [{ field: "name", direction: "desc" }]),
		).toBe("file.extension:md file.name:a* sort_by:file.name:desc");
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
		expect(files_folder_table_query_to_sort(files_folder_table_query_parse("file.name:a*"))).toBeNull();
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
			["file.name:Rep*", { kind: "name", field: "name", op: "starts_with", value: "Rep" }],
			["file.extension:md", { kind: "extension", field: "extension", op: "is", value: "md" }],
			["!file.extension:*", { kind: "extension", field: "extension", op: "missing" }],
			[
				"file.updated:2026-09-04",
				{ kind: "date", field: "updated", op: "on", start: Date.UTC(2026, 8, 4), end: Date.UTC(2026, 8, 5) },
			],
			[
				"file.created:<2026-09-04",
				{ kind: "date", field: "created", op: "before", start: Date.UTC(2026, 8, 4), end: Date.UTC(2026, 8, 5) },
			],
			["file.size:>=1024", { kind: "size", field: "size", op: "at_least", value: 1024 }],
			["!file.size:*", { kind: "size", field: "size", op: "missing" }],
			["metadata.status:open", { kind: "text", field: "metadata.status", op: "is", value: "open" }],
			["metadata.status:op*", { kind: "text", field: "metadata.status", op: "starts_with", value: "op" }],
			["frontmatter.due:*", { kind: "text", field: "frontmatter.due", op: "present" }],
		];

		for (const [raw, expected] of cases) {
			const filter = files_folder_table_query_to_filter(parse_filter(raw), get_day_bounds);
			expect(filter).toEqual(expected);
			expect(files_table_filter_is_valid(filter!)).toBe(true);
		}
		expect(files_folder_table_query_to_filter(null, get_day_bounds)).toBeNull();
	});

	test("is null when the day cannot be turned into bounds", () => {
		expect(files_folder_table_query_to_filter(parse_filter("file.updated:2026-09-04"), () => null)).toBeNull();
	});
});

describe("files_folder_table_query_forms", () => {
	test("every form with a sample value parses for its field", () => {
		const samples: Record<string, string> = {
			"file.name": "a*",
			"file.extension": "md",
			"file.updated": "2026-09-04",
			"file.size": "1",
			"metadata.x": "a",
		};
		for (const [fieldText, sample] of Object.entries(samples)) {
			for (const form of files_folder_table_query_forms(fieldText)) {
				const raw = form.needsValue ? `${form.token}${sample}` : form.token;
				expect(files_folder_table_query_parse_token(raw).problem, raw).toBeNull();
			}
		}
	});
});

describe("files_search_query_SYNTAX_EXAMPLES", () => {
	test("every example runs in each input that shows it", () => {
		for (const row of files_search_query_SYNTAX_EXAMPLES) {
			if (row.inputs.includes("search")) {
				const problems = files_search_query_parse(row.example).filters.map((filter) => filter.problem);
				expect(problems, row.example).toEqual(problems.map(() => null));
			}
			if (row.inputs.includes("table")) {
				expect(files_folder_table_query_get_add_problem("", row.example), row.example).toBeNull();
			}
		}
	});
});
