import { describe, expect, test } from "vitest";
import {
	files_search_query_file_updated_matches,
	files_search_query_folder_path,
	files_search_query_format_key,
	files_search_query_format_value,
	files_search_query_MAX_FILTERS,
	files_search_query_parse,
	files_search_query_qualified_field_is_valid,
	files_search_query_qualified_fields,
	files_search_query_serialize,
	files_search_query_to_plans,
	files_search_query_typing_token,
	type files_search_query_Filter,
} from "./files-search-query.ts";

function parse_one(query: string): files_search_query_Filter {
	const parsed = files_search_query_parse(query);
	expect(parsed.filters).toHaveLength(1);
	return parsed.filters[0]!;
}

describe("files_search_query_parse", () => {
	test("splits filters from free text and keeps the raw token", () => {
		const parsed = files_search_query_parse("  recall status:open  bot ");

		expect(parsed.text).toBe("recall bot");
		expect(parsed.openQuote).toBe(false);
		expect(parsed.filters).toEqual([
			{
				raw: "status:open",
				negated: false,
				key: { namespace: "any", name: "status" },
				match: { op: "eq", value: "open", quoted: false },
				problem: null,
			},
		]);
	});

	test("reads every value form", () => {
		expect(parse_one("status:*").match).toEqual({ op: "exists" });
		expect(parse_one("title:Recall*").match).toEqual({ op: "prefix", value: "Recall" });
		expect(parse_one("priority:>2").match).toEqual({ op: "range", comparator: "gt", value: "2" });
		expect(parse_one("priority:>=2").match).toEqual({ op: "range", comparator: "gte", value: "2" });
		expect(parse_one("due:<2026-10-01").match).toEqual({ op: "range", comparator: "lt", value: "2026-10-01" });
		expect(parse_one("due:<=2026-09-30").match).toEqual({ op: "range", comparator: "lte", value: "2026-09-30" });
		expect(parse_one('assignee:"Denys Voloshyn"').match).toEqual({
			op: "eq",
			value: "Denys Voloshyn",
			quoted: true,
		});
		expect(parse_one('note:"say \\"hi\\""').match).toEqual({ op: "eq", value: 'say "hi"', quoted: true });
	});

	test("reads negation and the reserved namespaces", () => {
		const negated = parse_one("!status:done");
		expect(negated.negated).toBe(true);
		expect(negated.raw).toBe("!status:done");

		expect(parse_one("frontmatter.status:open").key).toEqual({ namespace: "frontmatter", name: "status" });
		expect(parse_one("metadata.status:open").key).toEqual({ namespace: "metadata", name: "status" });
		expect(parse_one("file.path:/tasks").key).toEqual({ namespace: "file", name: "path" });
		expect(parse_one("sender.name:Alice").key).toEqual({ namespace: "any", name: "sender.name" });
		// A bare key spelled like a namespace is still a bare key. Only the dotted form is reserved.
		expect(parse_one("file:x").key).toEqual({ namespace: "any", name: "file" });
	});

	test("quotes a key that holds a colon", () => {
		const filter = parse_one('"slack:message-id":123');
		expect(filter.key).toEqual({ namespace: "any", name: "slack:message-id" });
		expect(filter.match).toEqual({ op: "eq", value: "123", quoted: false });
		expect(filter.problem).toBeNull();
		// The `!` sits before the quote, like before a bare key.
		const negated = parse_one('!"slack:message-id":123');
		expect(negated.negated).toBe(true);
		expect(negated.key).toEqual({ namespace: "any", name: "slack:message-id" });
		expect(negated.match).toEqual({ op: "eq", value: "123", quoted: false });
		expect(negated.problem).toBeNull();
	});

	test("keeps text that only looks like a filter as free text", () => {
		expect(files_search_query_parse("-status:done").filters).toEqual([]);
		expect(files_search_query_parse("-status:done").text).toBe("-status:done");
		expect(files_search_query_parse("a/b:c").filters).toEqual([]);
		expect(files_search_query_parse("http://localhost:5173/w/personal/home/files?nodeId=abc")).toEqual({
			filters: [],
			text: "http://localhost:5173/w/personal/home/files?nodeId=abc",
			openQuote: false,
		});
		// A link pasted after a chip is still a link, not a filter on the key `http`.
		const withChip = files_search_query_parse("status:open https://localhost:5173/w/personal/home/files?nodeId=abc");
		expect(withChip.filters.map((filter) => filter.raw)).toEqual(["status:open"]);
		expect(withChip.text).toBe("https://localhost:5173/w/personal/home/files?nodeId=abc");
	});

	test("caps the number of filters and keeps the extra ones as problems", () => {
		const tokens = Array.from({ length: files_search_query_MAX_FILTERS + 1 }, (_, index) => `k${index}:v`);
		const parsed = files_search_query_parse(tokens.join(" "));

		expect(parsed.filters).toHaveLength(files_search_query_MAX_FILTERS + 1);
		expect(parsed.filters[files_search_query_MAX_FILTERS - 1]!.problem).toBeNull();
		expect(parsed.filters[files_search_query_MAX_FILTERS]!.problem).toBe(
			`At most ${files_search_query_MAX_FILTERS} filters in one search`,
		);
		expect(files_search_query_to_plans(parsed.filters[files_search_query_MAX_FILTERS]!)).toEqual([]);
	});

	test("reports why a filter cannot run and still keeps it", () => {
		// `status: open` is the YAML habit. The message says where the value has to go.
		expect(parse_one("status:").problem).toBe("Filter needs a value right after the colon. Use * for any value");
		expect(parse_one("priority:>high").problem).toBe(
			"Ranges need a number or a date like 2026-09-04. Quote the value to search it as text",
		);
		// The generic range hint says to quote the value, so a bound that already is gets its own message.
		expect(parse_one('due:>"2026-09-04"').problem).toBe(
			"Ranges take the number or the date without quotes, like priority:>2",
		);
		expect(parse_one("due:>'2026-09-04'").problem).toBe(
			"Ranges take the number or the date without quotes, like priority:>2",
		);
		expect(parse_one("due:>2026-09-04").problem).toBeNull();
		expect(parse_one("file.size:3").problem).toBe(
			"Unknown file field. Use file.path, file.name, file.ext, file.kind, file.updated",
		);
		// The key problem comes before the value problem, and the cap before both.
		expect(parse_one("file.size:").problem).toBe(
			"Unknown file field. Use file.path, file.name, file.ext, file.kind, file.updated",
		);
		const capped = files_search_query_parse(
			[...Array.from({ length: files_search_query_MAX_FILTERS }, (_, index) => `k${index}:v`), "file.size:"].join(" "),
		);
		expect(capped.filters[files_search_query_MAX_FILTERS]!.problem).toBe(
			`At most ${files_search_query_MAX_FILTERS} filters in one search`,
		);
		expect(parse_one("file.name:*.md").problem).toBe(
			"file.name finds names that contain the value. Put * only at the end",
		);
		expect(parse_one("file.ext:*.md").problem).toBe("file.ext takes an extension like md. Put * only at the end");
		expect(parse_one("file.kind:image").problem).toBe("file.kind is file or folder");
		expect(parse_one("file.name:>2").problem).toBe("file.name does not support ranges");
		expect(parse_one("file.path:tasks*").problem).toBe("file.path takes a folder path, without *");
		expect(parse_one("file.updated:>2026").problem).toBe(
			"file.updated needs a day like file.updated:2026-09-04 or a range like file.updated:>2026-09-01",
		);
		expect(parse_one("file.updated:2026-09").problem).toBe(
			"file.updated needs a day like file.updated:2026-09-04 or a range like file.updated:>2026-09-01",
		);
		// The file message wins over the generic range hint, whose advice to quote would not help.
		expect(parse_one("file.updated:>abc").problem).toBe(
			"file.updated needs a day like file.updated:2026-09-04 or a range like file.updated:>2026-09-01",
		);
		expect(parse_one("file.path:*").problem).toBe("file.path needs a value");
		expect(parse_one("frontmatter.a..b:x").problem).toBe(
			"Frontmatter keys use letters, digits, _ and -, joined by dots",
		);
		expect(parse_one("metadata.a.b:x").problem).toBe("Metadata keys use letters, digits, _, - and :");
		// Quoting a key the grammar refuses does not help, so no message says to quote it.
		expect(parse_one('"a b":x').problem).toBe(
			"Keys use letters, digits, _, - and :. Dots join the parts of a frontmatter key",
		);
		expect(parse_one("a..b:x").problem).toBe(
			"Keys use letters, digits, _, - and :. Dots join the parts of a frontmatter key",
		);
		expect(parse_one('status:"open"x').problem).toBe("Nothing can follow the closing quote");
		expect(parse_one("assignee:'Denys").problem).toBe('Use double quotes, like status:"in progress"');
		expect(parse_one("status:!done").problem).toBe("Put ! before the key, like !status:done");
		expect(parse_one("status:!=done").problem).toBe("Put ! before the key, like !status:done");
		expect(parse_one("priority:=2").problem).toBe("Drop the =. A plain value is an exact match, like priority:2");
		// `priority:> 2` ends the token at the space, so the bound is missing.
		expect(parse_one("priority:>=").problem).toBe("Put the number or the date right after >=, like priority:>=2");
		// A file field explains its own empty value, instead of "use *" that the field then refuses.
		expect(parse_one("file.kind:").problem).toBe("file.kind needs a value");
		expect(parse_one("file.path:").problem).toBe("file.path needs a value");
		// A prefix is refused even when it is a whole kind name: the matcher compares whole kinds.
		expect(parse_one("file.kind:file*").problem).toBe("file.kind is file or folder");
		expect(parse_one("file.ext:m*").problem).toBeNull();
		expect(parse_one("file.updated:2026-02-31").problem).toBe(
			"file.updated needs a day like file.updated:2026-09-04 or a range like file.updated:>2026-09-01",
		);
	});

	test("file.kind ignores case, and file.updated takes a day or a date range", () => {
		expect(parse_one("file.kind:Folder").problem).toBeNull();
		expect(parse_one("file.updated:2026-09-04").problem).toBeNull();
		expect(parse_one("file.updated:>2026-09-04T10:00").problem).toBeNull();
	});

	test("closes an open quote in the last token and still flags it", () => {
		const parsed = files_search_query_parse('status:open assignee:"Denys Vol');
		expect(parsed.openQuote).toBe(true);
		expect(parsed.filters.map((filter) => filter.raw)).toEqual(["status:open", 'assignee:"Denys Vol"']);
		expect(parsed.filters[1]!.match).toEqual({ op: "eq", value: "Denys Vol", quoted: true });
		expect(files_search_query_parse('"hi status:open').text).toBe('"hi status:open"');
		// A backslash right before the added quote would escape it, so it is escaped first.
		expect(parse_one('note:"abc\\').raw).toBe('note:"abc\\\\"');
		expect(parse_one('note:"abc\\').match).toEqual({ op: "eq", value: "abc\\", quoted: true });
		// Two backslashes are one escaped backslash, so the added quote stays a quote.
		expect(parse_one('note:"abc\\\\').raw).toBe('note:"abc\\\\"');
		expect(parse_one('note:"abc\\\\').match).toEqual({ op: "eq", value: "abc\\", quoted: true });
	});

	test("keeps the quotes around free text", () => {
		expect(files_search_query_parse('"raw media" notes').text).toBe('"raw media" notes');
	});

	test("splits on tabs and newlines, and an empty quoted key is free text", () => {
		const parsed = files_search_query_parse("status:open\tbot\nnote");
		expect(parsed.filters.map((filter) => filter.raw)).toEqual(["status:open"]);
		expect(parsed.text).toBe("bot note");
		expect(files_search_query_parse('"":x').filters).toEqual([]);
		expect(files_search_query_parse('"":x').text).toBe('"":x');
	});

	test("a quoted key may carry its namespace inside or outside the quotes", () => {
		for (const query of ['"metadata.slack:message-id":123', 'metadata."slack:message-id":123']) {
			const filter = parse_one(query);
			expect(filter.key).toEqual({ namespace: "metadata", name: "slack:message-id" });
			expect(filter.problem).toBeNull();
		}
		// A frontmatter path cannot hold a colon, so the same key under frontmatter has a problem.
		expect(parse_one('frontmatter."a:b":x').problem).not.toBeNull();
	});

	test("only a quote and a backslash are escapes inside a quoted value", () => {
		expect(parse_one('path:"C:\\Program Files"').match).toEqual({
			op: "eq",
			value: "C:\\Program Files",
			quoted: true,
		});
		expect(parse_one('note:"say \\"hi\\" \\\\ end"').match).toEqual({
			op: "eq",
			value: 'say "hi" \\ end',
			quoted: true,
		});
	});

	test("a star after the closing quote asks for a prefix with spaces", () => {
		expect(parse_one('title:"Recall the"*').match).toEqual({ op: "prefix", value: "Recall the" });
		expect(parse_one('title:"Recall the"*').problem).toBeNull();
		// Inside the quotes the star is text.
		expect(parse_one('title:"Recall the*"').match).toEqual({ op: "eq", value: "Recall the*", quoted: true });
		expect(parse_one('title:""*').problem).toBe("Nothing can follow the closing quote");
	});

	test("accepts unicode keys", () => {
		expect(parse_one("città:Roma").key).toEqual({ namespace: "any", name: "città" });
		expect(parse_one("città:Roma").problem).toBeNull();
	});
});

describe("files_search_query_serialize", () => {
	test("writes chips first and the text last", () => {
		const parsed = files_search_query_parse("recall status:open !type:bug");
		expect(files_search_query_serialize(parsed)).toBe("status:open !type:bug recall");
	});

	test("serializing the parsed text a second time gives the same text", () => {
		for (const query of [
			'  status:open   assignee:"Denys Voloshyn"  recall  ',
			'"slack:message-id":123 città:Roma',
			"priority:>high file.size:3 status:",
			'assignee:"open quote',
			'assignee:"Den\\',
			'assignee:"Den\\\\',
			'path:"C:\\Program Files" title:"Recall the"*',
			'"raw media" notes',
			"http://localhost:5173/w/personal/home/files?nodeId=abc",
			"",
		]) {
			const parsed = files_search_query_parse(query);
			const once = files_search_query_serialize(parsed);
			const reparsed = files_search_query_parse(once);
			const twice = files_search_query_serialize(reparsed);
			expect(twice).toBe(once);
			// A serializer that dropped a chip or the text would still reach a fixed point.
			expect(reparsed.filters.map((filter) => filter.raw)).toEqual(parsed.filters.map((filter) => filter.raw));
			expect(reparsed.text).toBe(parsed.text);
		}
	});

	test("a chip made from an open quote does not swallow the chips after it", () => {
		const filters = [
			...files_search_query_parse('assignee:"Denys').filters,
			...files_search_query_parse("status:open").filters,
		];
		const reparsed = files_search_query_parse(files_search_query_serialize({ filters, text: "" }));
		expect(reparsed.filters.map((filter) => filter.raw)).toEqual(['assignee:"Denys"', "status:open"]);
	});
});

describe("files_search_query_typing_token", () => {
	test("is the last token, or nothing after a space, and keeps a quoted run together", () => {
		expect(files_search_query_typing_token("status:op")).toEqual({ start: 0, token: "status:op" });
		expect(files_search_query_typing_token("recall status:op")).toEqual({ start: 7, token: "status:op" });
		expect(files_search_query_typing_token("status:open ")).toEqual({ start: 12, token: "" });
		expect(files_search_query_typing_token('recall assignee:"Denys V')).toEqual({
			start: 7,
			token: 'assignee:"Denys V',
		});
		// A space inside an open quote is part of the value, not the end of the token.
		expect(files_search_query_typing_token('assignee:"Denys ')).toEqual({ start: 0, token: 'assignee:"Denys ' });
		expect(files_search_query_typing_token("")).toEqual({ start: 0, token: "" });
	});
});

describe("files_search_query_qualified_field_is_valid", () => {
	test("accepts the fields the grammar can name and nothing else", () => {
		expect(files_search_query_qualified_field_is_valid("frontmatter.source.channel")).toBe(true);
		expect(files_search_query_qualified_field_is_valid("metadata.slack:message-id")).toBe(true);
		expect(files_search_query_qualified_field_is_valid("frontmatter.a..b")).toBe(false);
		expect(files_search_query_qualified_field_is_valid("metadata.a.b")).toBe(false);
		expect(files_search_query_qualified_field_is_valid("status")).toBe(false);
		expect(files_search_query_qualified_field_is_valid("frontmatter.")).toBe(false);
	});
});

describe("files_search_query_file_updated_matches", () => {
	const match = (query: string) => parse_one(query).match;
	// The tree shows local dates, so a day literal is a local day.
	const day = new Date(2026, 8, 4).getTime();
	const nextDay = new Date(2026, 8, 5).getTime();

	test("the tests run in a zone where local time differs from UTC", () => {
		// `vitest.config.ts` pins `TZ` to Europe/London. On a UTC machine `new Date(2026, 8, 4)` is
		// `Date.UTC(2026, 8, 4)`, so a matcher that read the literal as UTC would pass every test here.
		expect(new Date(2026, 8, 4).getTimezoneOffset()).toBe(-60);
	});

	test("a day literal means that whole local day", () => {
		expect(files_search_query_file_updated_matches(match("file.updated:2026-09-04"), day)).toBe(true);
		expect(files_search_query_file_updated_matches(match("file.updated:2026-09-04"), nextDay - 1)).toBe(true);
		expect(files_search_query_file_updated_matches(match("file.updated:2026-09-04"), nextDay)).toBe(false);
		expect(files_search_query_file_updated_matches(match("file.updated:2026-09-04"), day - 1)).toBe(false);
	});

	test("a range keeps a full timestamp as it is and widens a day literal to the whole local day", () => {
		const noonUtc = Date.UTC(2026, 8, 4, 12);
		expect(files_search_query_file_updated_matches(match("file.updated:>2026-09-04T12:00:00Z"), noonUtc)).toBe(false);
		expect(files_search_query_file_updated_matches(match("file.updated:>=2026-09-04T12:00:00Z"), noonUtc)).toBe(true);
		expect(files_search_query_file_updated_matches(match("file.updated:<2026-09-04T12:00:00Z"), noonUtc)).toBe(false);
		expect(files_search_query_file_updated_matches(match("file.updated:<2026-09-04T12:00:00Z"), noonUtc - 1)).toBe(
			true,
		);
		expect(files_search_query_file_updated_matches(match("file.updated:<=2026-09-04T12:00:00Z"), noonUtc)).toBe(true);
		expect(files_search_query_file_updated_matches(match("file.updated:<=2026-09-04"), nextDay - 1)).toBe(true);
		expect(files_search_query_file_updated_matches(match("file.updated:<=2026-09-04"), nextDay)).toBe(false);
		expect(files_search_query_file_updated_matches(match("file.updated:>2026-09-04"), nextDay - 1)).toBe(false);
		expect(files_search_query_file_updated_matches(match("file.updated:>2026-09-04"), nextDay)).toBe(true);
		expect(files_search_query_file_updated_matches(match("file.updated:>=2026-09-04"), day)).toBe(true);
		expect(files_search_query_file_updated_matches(match("file.updated:>=2026-09-04"), day - 1)).toBe(false);
		expect(files_search_query_file_updated_matches(match("file.updated:<2026-09-04"), day)).toBe(false);
		expect(files_search_query_file_updated_matches(match("file.updated:<2026-09-04"), day - 1)).toBe(true);
	});

	test("a time with no zone is local, like the day literal", () => {
		const halfPastMidnight = new Date(2026, 8, 4, 0, 30).getTime();
		expect(files_search_query_file_updated_matches(match("file.updated:>=2026-09-04T00:00"), halfPastMidnight)).toBe(
			true,
		);
		expect(files_search_query_file_updated_matches(match("file.updated:>=2026-09-04T00:00"), day - 1)).toBe(false);
		expect(files_search_query_file_updated_matches(match("file.updated:<2026-09-04T00:30"), halfPastMidnight)).toBe(
			false,
		);
		expect(
			files_search_query_file_updated_matches(match("file.updated:<=2026-09-04T00:30:00.000"), halfPastMidnight),
		).toBe(true);
	});

	test("a day literal on a daylight-saving day keeps its 25 hours", () => {
		// London leaves summer time on 2026-10-25, so that local day is 25 hours long.
		const longDay = new Date(2026, 9, 25).getTime();
		const dayAfter = new Date(2026, 9, 26).getTime();
		expect(dayAfter - longDay).toBe(25 * 60 * 60 * 1000);
		expect(files_search_query_file_updated_matches(match("file.updated:2026-10-25"), dayAfter - 1)).toBe(true);
		expect(files_search_query_file_updated_matches(match("file.updated:<=2026-10-25"), dayAfter - 1)).toBe(true);
		expect(files_search_query_file_updated_matches(match("file.updated:>2026-10-25"), dayAfter - 1)).toBe(false);
		expect(files_search_query_file_updated_matches(match("file.updated:>2026-10-25"), dayAfter)).toBe(true);
	});

	test("never matches a shape the parser refuses", () => {
		expect(files_search_query_file_updated_matches(match("file.updated:*"), 1)).toBe(false);
		expect(files_search_query_file_updated_matches(match("file.updated:2026-09"), 1)).toBe(false);
		// `new Date(2026, 1, 31)` would roll over to March 3, so the timestamp sits inside that day.
		expect(
			files_search_query_file_updated_matches(match("file.updated:2026-02-31"), new Date(2026, 2, 3, 12).getTime()),
		).toBe(false);
	});
});

describe("files_search_query_folder_path", () => {
	test("adds the leading slash, drops the trailing one, and keeps the root", () => {
		expect(files_search_query_folder_path("/")).toBe("/");
		expect(files_search_query_folder_path("/tasks/")).toBe("/tasks");
		expect(files_search_query_folder_path("tasks")).toBe("/tasks");
		expect(files_search_query_folder_path("//")).toBe("/");
		expect(files_search_query_folder_path("/tasks/sub//")).toBe("/tasks/sub");
	});
});

describe("files_search_query_format_key", () => {
	test("quotes only a key the grammar rejects", () => {
		expect(files_search_query_format_key("status")).toBe("status");
		expect(files_search_query_format_key("sender.name")).toBe("sender.name");
		expect(files_search_query_format_key("slack:message-id")).toBe('"slack:message-id"');
		expect(parse_one(`${files_search_query_format_key("slack:message-id")}:1`).key.name).toBe("slack:message-id");
	});
});

describe("files_search_query_format_value", () => {
	test("reads back as the same eq match", () => {
		for (const value of [
			"open",
			"Denys Voloshyn",
			'say "hi"',
			"",
			"*",
			"Recall*",
			">2",
			"12:30",
			"'x",
			"!done",
			"=2",
			"C:\\Program Files\\",
			'a\\"b',
		]) {
			const filter = parse_one(`status:${files_search_query_format_value(value)}`);
			expect(filter.problem).toBeNull();
			expect(filter.match).toMatchObject({ op: "eq", value });
		}
		expect(files_search_query_format_value("open")).toBe("open");
		expect(files_search_query_format_value("Denys Voloshyn")).toBe('"Denys Voloshyn"');
	});
});

describe("files_search_query_qualified_fields", () => {
	test("asks both metadata kinds for a bare key and one for an explicit key", () => {
		expect(files_search_query_qualified_fields({ namespace: "any", name: "status" })).toEqual([
			"frontmatter.status",
			"metadata.status",
		]);
		expect(files_search_query_qualified_fields({ namespace: "any", name: "sender.name" })).toEqual([
			"frontmatter.sender.name",
		]);
		expect(files_search_query_qualified_fields({ namespace: "any", name: "slack:message-id" })).toEqual([
			"metadata.slack:message-id",
		]);
		expect(files_search_query_qualified_fields({ namespace: "metadata", name: "status" })).toEqual(["metadata.status"]);
		expect(files_search_query_qualified_fields({ namespace: "file", name: "path" })).toEqual([]);
	});
});

describe("files_search_query_to_plans", () => {
	test("expands an unquoted literal to every kind it could be", () => {
		expect(files_search_query_to_plans(parse_one("frontmatter.priority:3"))).toEqual([
			{ op: "eq", qualifiedField: "frontmatter.priority", value: "3" },
			{ op: "eq", qualifiedField: "frontmatter.priority", value: 3 },
		]);
		expect(files_search_query_to_plans(parse_one("frontmatter.regression:true"))).toEqual([
			{ op: "eq", qualifiedField: "frontmatter.regression", value: "true" },
			{ op: "eq", qualifiedField: "frontmatter.regression", value: true },
		]);
		expect(files_search_query_to_plans(parse_one("frontmatter.reported:2026-09-04"))).toEqual([
			{ op: "eq", qualifiedField: "frontmatter.reported", value: "2026-09-04" },
			{
				op: "range",
				qualifiedField: "frontmatter.reported",
				valueKind: "maybe_date",
				gte: Date.UTC(2026, 8, 4),
				lt: Date.UTC(2026, 8, 5),
			},
		]);
		expect(files_search_query_to_plans(parse_one("frontmatter.status:open"))).toEqual([
			{ op: "eq", qualifiedField: "frontmatter.status", value: "open" },
		]);
	});

	test("a quoted literal asks the string kind only", () => {
		expect(files_search_query_to_plans(parse_one('frontmatter.priority:"3"'))).toEqual([
			{ op: "eq", qualifiedField: "frontmatter.priority", value: "3" },
		]);
	});

	test("reads the YAML spellings of numbers and booleans", () => {
		expect(files_search_query_to_plans(parse_one("frontmatter.done:True"))).toEqual([
			{ op: "eq", qualifiedField: "frontmatter.done", value: "True" },
			{ op: "eq", qualifiedField: "frontmatter.done", value: true },
		]);
		expect(files_search_query_to_plans(parse_one("frontmatter.weight:.5"))).toEqual([
			{ op: "eq", qualifiedField: "frontmatter.weight", value: ".5" },
			{ op: "eq", qualifiedField: "frontmatter.weight", value: 0.5 },
		]);
		expect(files_search_query_to_plans(parse_one("frontmatter.n:1e3"))).toEqual([
			{ op: "eq", qualifiedField: "frontmatter.n", value: "1e3" },
			{ op: "eq", qualifiedField: "frontmatter.n", value: 1000 },
		]);
		// Hex and octal are core-schema integers too. Binary is not, so it stays text.
		expect(files_search_query_to_plans(parse_one("frontmatter.count:0x10"))).toEqual([
			{ op: "eq", qualifiedField: "frontmatter.count", value: "0x10" },
			{ op: "eq", qualifiedField: "frontmatter.count", value: 16 },
		]);
		expect(files_search_query_to_plans(parse_one("frontmatter.count:0o17"))).toEqual([
			{ op: "eq", qualifiedField: "frontmatter.count", value: "0o17" },
			{ op: "eq", qualifiedField: "frontmatter.count", value: 15 },
		]);
		expect(files_search_query_to_plans(parse_one("frontmatter.count:0b101"))).toEqual([
			{ op: "eq", qualifiedField: "frontmatter.count", value: "0b101" },
		]);
		expect(files_search_query_to_plans(parse_one("frontmatter.count:>0x10"))).toEqual([
			{ op: "range", qualifiedField: "frontmatter.count", valueKind: "number", gt: 16 },
		]);
		expect(parse_one("weight:>.5").problem).toBeNull();
	});

	test("a date without a time keeps the whole day inside a range", () => {
		expect(files_search_query_to_plans(parse_one("frontmatter.due:<=2026-09-30"))).toEqual([
			{ op: "range", qualifiedField: "frontmatter.due", valueKind: "maybe_date", lt: Date.UTC(2026, 9, 1) },
		]);
		expect(files_search_query_to_plans(parse_one("frontmatter.due:>2026-09-04"))).toEqual([
			{ op: "range", qualifiedField: "frontmatter.due", valueKind: "maybe_date", gte: Date.UTC(2026, 8, 5) },
		]);
		// `>=` and `<` need no widening: the day start is already the bound.
		expect(files_search_query_to_plans(parse_one("frontmatter.due:>=2026-09-04"))).toEqual([
			{ op: "range", qualifiedField: "frontmatter.due", valueKind: "maybe_date", gte: Date.UTC(2026, 8, 4) },
		]);
		expect(files_search_query_to_plans(parse_one("frontmatter.due:<2026-09-04"))).toEqual([
			{ op: "range", qualifiedField: "frontmatter.due", valueKind: "maybe_date", lt: Date.UTC(2026, 8, 4) },
		]);
		expect(files_search_query_to_plans(parse_one("frontmatter.due:>2026-09-04T10:00:00Z"))).toEqual([
			{ op: "range", qualifiedField: "frontmatter.due", valueKind: "maybe_date", gt: Date.UTC(2026, 8, 4, 10) },
		]);
	});

	test("an impossible calendar date is a string only", () => {
		expect(files_search_query_to_plans(parse_one("frontmatter.reported:2026-02-31"))).toEqual([
			{ op: "eq", qualifiedField: "frontmatter.reported", value: "2026-02-31" },
		]);
	});

	test("a date with a time asks for that instant too", () => {
		expect(files_search_query_to_plans(parse_one("frontmatter.due:2026-09-04T10:00Z"))).toEqual([
			{ op: "eq", qualifiedField: "frontmatter.due", value: "2026-09-04T10:00Z" },
			{
				op: "range",
				qualifiedField: "frontmatter.due",
				valueKind: "maybe_date",
				gte: Date.UTC(2026, 8, 4, 10),
				lte: Date.UTC(2026, 8, 4, 10),
			},
		]);
		expect(files_search_query_to_plans(parse_one('frontmatter.due:"2026-09-04T10:00Z"'))).toEqual([
			{ op: "eq", qualifiedField: "frontmatter.due", value: "2026-09-04T10:00Z" },
		]);
		expect(files_search_query_to_plans(parse_one("due:2026-09-04T10:00Z"))).toHaveLength(4);
	});

	test("a negated filter asks the same plans as the positive one", () => {
		expect(files_search_query_to_plans(parse_one("!status:open"))).toEqual(
			files_search_query_to_plans(parse_one("status:open")),
		);
	});

	test("builds exists, prefix and range plans", () => {
		expect(files_search_query_to_plans(parse_one("metadata.status:*"))).toEqual([
			{ op: "exists", qualifiedField: "metadata.status" },
		]);
		expect(files_search_query_to_plans(parse_one("metadata.title:Recall*"))).toEqual([
			{ op: "prefix", qualifiedField: "metadata.title", value: "Recall" },
		]);
		expect(files_search_query_to_plans(parse_one("frontmatter.priority:>=2"))).toEqual([
			{ op: "range", qualifiedField: "frontmatter.priority", valueKind: "number", gte: 2 },
		]);
		expect(files_search_query_to_plans(parse_one("frontmatter.due:<2026-10-01"))).toEqual([
			{ op: "range", qualifiedField: "frontmatter.due", valueKind: "maybe_date", lt: Date.UTC(2026, 9, 1) },
		]);
	});

	test("a bare key with a number or date literal gives four plans at most", () => {
		const plans = files_search_query_to_plans(parse_one("priority:3"));
		expect(plans).toHaveLength(4);
		expect(plans.map((plan) => plan.qualifiedField)).toEqual([
			"frontmatter.priority",
			"frontmatter.priority",
			"metadata.priority",
			"metadata.priority",
		]);
		expect(files_search_query_to_plans(parse_one("reported:2026-09-04"))).toHaveLength(4);
	});

	test("an invalid filter and a file filter give no plans", () => {
		expect(files_search_query_to_plans(parse_one("priority:>high"))).toEqual([]);
		expect(files_search_query_to_plans(parse_one("file.path:/tasks"))).toEqual([]);
	});
});
