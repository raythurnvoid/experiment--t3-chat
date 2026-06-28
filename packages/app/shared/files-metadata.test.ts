import { describe, expect, test } from "vitest";
import { files_metadata_extract_frontmatter } from "./files-metadata.ts";

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
