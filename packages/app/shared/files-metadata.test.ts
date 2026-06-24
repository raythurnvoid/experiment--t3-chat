import { describe, expect, test } from "vitest";
import { files_metadata_extract_frontmatter, files_metadata_parse_search_where_json } from "./files-metadata.ts";

describe("files_metadata_extract_frontmatter", () => {
	test("returns empty metadata when no closed leading frontmatter exists", () => {
		expect(files_metadata_extract_frontmatter("# Title\n")).toEqual({ fields: [], values: [] });
		expect(files_metadata_extract_frontmatter("---\nfrom: alice\n")).toEqual({ fields: [], values: [] });
		expect(files_metadata_extract_frontmatter("x\n---\nfrom: alice\n---\n")).toEqual({ fields: [], values: [] });
		expect(files_metadata_extract_frontmatter("--- yaml\nfrom: alice\n---\n")).toEqual({ fields: [], values: [] });
	});

	test("extracts scalar frontmatter values with YAML 1.2 core semantics", () => {
		const metadata = files_metadata_extract_frontmatter(
			[
				"---",
				"from: alice@example.com",
				"amount: 120.5",
				"hasAttachments: true",
				"legacyYes: yes",
				"date: 2024-01-02",
				"---",
				"Body",
			].join("\n"),
		);

		expect(metadata.fields).toEqual([
			"frontmatter.from",
			"frontmatter.amount",
			"frontmatter.hasAttachments",
			"frontmatter.legacyYes",
			"frontmatter.date",
		]);
		expect(metadata.values).toEqual([
			{ qualifiedField: "frontmatter.from", valueKind: "string", value: "alice@example.com" },
			{ qualifiedField: "frontmatter.amount", valueKind: "number", value: 120.5 },
			{ qualifiedField: "frontmatter.hasAttachments", valueKind: "boolean", value: true },
			{ qualifiedField: "frontmatter.legacyYes", valueKind: "string", value: "yes" },
			{ qualifiedField: "frontmatter.date", valueKind: "string", value: "2024-01-02" },
		]);
	});

	test("extracts arrays as repeated primitive values and deduplicates duplicates", () => {
		const metadata = files_metadata_extract_frontmatter(
			["---", "cc:", "  - bob@example.com", "  - bob@example.com", "  - jane@example.com", "---", ""].join("\n"),
		);

		expect(metadata.fields).toEqual(["frontmatter.cc"]);
		expect(metadata.values).toEqual([
			{ qualifiedField: "frontmatter.cc", valueKind: "string", value: "bob@example.com" },
			{ qualifiedField: "frontmatter.cc", valueKind: "string", value: "jane@example.com" },
		]);
	});

	test("normalizes non-breaking spaces in visual YAML indentation", () => {
		const metadata = files_metadata_extract_frontmatter(
			["---", "cc:", "\u00a0 - bob@example.com", "\u00a0 - jane@example.com", "subject: alpha\u00a0beta", "---", ""].join(
				"\n",
			),
		);

		expect(metadata.fields).toEqual(["frontmatter.cc", "frontmatter.subject"]);
		expect(metadata.values).toEqual([
			{ qualifiedField: "frontmatter.cc", valueKind: "string", value: "bob@example.com" },
			{ qualifiedField: "frontmatter.cc", valueKind: "string", value: "jane@example.com" },
			{ qualifiedField: "frontmatter.subject", valueKind: "string", value: "alpha\u00a0beta" },
		]);
	});

	test("flattens safe nested object keys and skips unsafe key segments", () => {
		const metadata = files_metadata_extract_frontmatter(
			["---", "sender:", "  name: Alice", "  bad.key: skipped", "  team-id: ops", "---", ""].join("\n"),
		);

		expect(metadata.fields).toEqual(["frontmatter.sender", "frontmatter.sender.name", "frontmatter.sender.team-id"]);
		expect(metadata.values).toEqual([
			{ qualifiedField: "frontmatter.sender.name", valueKind: "string", value: "Alice" },
			{ qualifiedField: "frontmatter.sender.team-id", valueKind: "string", value: "ops" },
		]);
	});

	test("keeps null and object arrays as presence-only metadata", () => {
		const metadata = files_metadata_extract_frontmatter(
			["---", "nullable: null", "attachments:", "  - name: invoice.pdf", "---", ""].join("\n"),
		);

		expect(metadata.fields).toEqual(["frontmatter.nullable", "frontmatter.attachments"]);
		expect(metadata.values).toEqual([]);
	});

	test("drops invalid YAML, duplicate keys, aliases, and anchors", () => {
		expect(files_metadata_extract_frontmatter("---\na: [\n---\n")).toEqual({ fields: [], values: [] });
		expect(files_metadata_extract_frontmatter("---\na: 1\na: 2\n---\n")).toEqual({ fields: [], values: [] });
		expect(files_metadata_extract_frontmatter("---\na: &x 1\nb: *x\n---\n")).toEqual({ fields: [], values: [] });
	});

	test("keeps explicit tagged values as presence-only metadata", () => {
		const metadata = files_metadata_extract_frontmatter("---\ndate: !!timestamp 2024-01-02\n---\n");

		expect(metadata.fields).toEqual(["frontmatter.date"]);
		expect(metadata.values).toEqual([]);
	});
});

describe("files_metadata_parse_search_where_json", () => {
	test("accepts one positive indexed predicate", () => {
		expect(files_metadata_parse_search_where_json('{"exists":"frontmatter.cc"}')).toEqual({
			_yay: { op: "exists", qualifiedField: "frontmatter.cc" },
		});
		expect(files_metadata_parse_search_where_json('{"eq":["frontmatter.amount",120.5]}')).toEqual({
			_yay: { op: "eq", qualifiedField: "frontmatter.amount", value: 120.5 },
		});
		expect(files_metadata_parse_search_where_json('{"prefix":["frontmatter.subject","Inv"]}')).toEqual({
			_yay: { op: "prefix", qualifiedField: "frontmatter.subject", value: "Inv" },
		});
		expect(files_metadata_parse_search_where_json('{"range":["frontmatter.amount",{"gte":100,"lt":500}]}')).toEqual({
			_yay: { op: "range", qualifiedField: "frontmatter.amount", gte: 100, lt: 500 },
		});
	});

	test("rejects boolean, negative, unqualified, unknown-kind, and non-primitive filters", () => {
		expect(files_metadata_parse_search_where_json('{"and":[{"exists":"frontmatter.cc"}]}')._nay?.message).toContain(
			"one indexed field predicate",
		);
		expect(files_metadata_parse_search_where_json('{"neq":["frontmatter.cc","bob"]}')._nay?.message).toContain(
			"positive predicates",
		);
		expect(files_metadata_parse_search_where_json('{"exists":"cc"}')._nay?.message).toContain("must be qualified");
		expect(files_metadata_parse_search_where_json('{"exists":"email.from"}')._nay?.message).toContain(
			"Unsupported metadata kind",
		);
		expect(files_metadata_parse_search_where_json('{"eq":["frontmatter.cc",["bob"]]}')._nay?.message).toContain(
			"not searchable",
		);
		expect(files_metadata_parse_search_where_json('{"prefix":["frontmatter.amount",12]}')._nay?.message).toContain(
			"string values only",
		);
	});

	test("rejects extra predicate keys instead of silently dropping them", () => {
		expect(
			files_metadata_parse_search_where_json('{"eq":["frontmatter.from","a@b.com"],"eq2":0}')._nay?.message,
		).toContain("one indexed field predicate");
		expect(
			files_metadata_parse_search_where_json('{"eq":["frontmatter.priority",3],"exists":"frontmatter.from"}')._nay
				?.message,
		).toContain("one indexed field predicate");
	});

	test("range errors point at the bounds-object shape with an example", () => {
		// [field, min, max] and [field, n] are the shapes agents actually try; both must show the example.
		expect(files_metadata_parse_search_where_json('{"range":["frontmatter.estimate",5,120]}')._nay?.message).toContain(
			'{"range":["frontmatter.estimate",{"gte":5,"lte":120}]}',
		);
		expect(files_metadata_parse_search_where_json('{"range":["frontmatter.estimate",5]}')._nay?.message).toContain(
			"bounds object",
		);
	});
});
