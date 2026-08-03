import { describe, expect, test } from "vitest";
import { files_metadata_extract_frontmatter, files_metadata_parse_maybe_date } from "./files-metadata.ts";

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
			{ qualifiedField: "frontmatter.date", valueKind: "maybe_date", value: Date.UTC(2024, 0, 2) },
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

	test("indexes date-like strings a second time as maybe_date values", () => {
		const metadata = files_metadata_extract_frontmatter(
			[
				"---",
				'realStartTime: "2026-07-29T14:30:36.264Z"',
				"days:",
				"  - 2026-07-27",
				"  - 2026-07-28",
				"meeting:",
				'  end: "2026-07-29T15:00:00Z"',
				"---",
				"Body",
			].join("\n"),
		);

		expect(metadata.values).toEqual([
			{ qualifiedField: "frontmatter.realStartTime", valueKind: "string", value: "2026-07-29T14:30:36.264Z" },
			{ qualifiedField: "frontmatter.realStartTime", valueKind: "maybe_date", value: Date.UTC(2026, 6, 29, 14, 30, 36, 264) },
			{ qualifiedField: "frontmatter.days", valueKind: "string", value: "2026-07-27" },
			{ qualifiedField: "frontmatter.days", valueKind: "maybe_date", value: Date.UTC(2026, 6, 27) },
			{ qualifiedField: "frontmatter.days", valueKind: "string", value: "2026-07-28" },
			{ qualifiedField: "frontmatter.days", valueKind: "maybe_date", value: Date.UTC(2026, 6, 28) },
			{ qualifiedField: "frontmatter.meeting.end", valueKind: "string", value: "2026-07-29T15:00:00Z" },
			{ qualifiedField: "frontmatter.meeting.end", valueKind: "maybe_date", value: Date.UTC(2026, 6, 29, 15, 0, 0) },
		]);
	});

	test("dedupes two spellings of the same instant into one maybe_date value", () => {
		const metadata = files_metadata_extract_frontmatter(
			["---", "times:", '  - "2026-07-29T14:30:00Z"', '  - "2026-07-29T15:30:00+01:00"', "---", ""].join("\n"),
		);

		expect(metadata.values).toEqual([
			{ qualifiedField: "frontmatter.times", valueKind: "string", value: "2026-07-29T14:30:00Z" },
			{ qualifiedField: "frontmatter.times", valueKind: "maybe_date", value: Date.UTC(2026, 6, 29, 14, 30) },
			{ qualifiedField: "frontmatter.times", valueKind: "string", value: "2026-07-29T15:30:00+01:00" },
		]);
	});

	test("indexes the epoch itself, which a falsiness check would drop", () => {
		const metadata = files_metadata_extract_frontmatter(["---", "startedAt: 1970-01-01", "---", ""].join("\n"));

		expect(metadata.values).toEqual([
			{ qualifiedField: "frontmatter.startedAt", valueKind: "string", value: "1970-01-01" },
			{ qualifiedField: "frontmatter.startedAt", valueKind: "maybe_date", value: 0 },
		]);
	});

	test("keeps non-date and invalid-date strings as string values only", () => {
		const metadata = files_metadata_extract_frontmatter(
			["---", "badDay: 2026-02-31", "looseDate: 2026-7-9", "compact: 20260729", "block: |", "  2026-07-29", "---", ""].join(
				"\n",
			),
		);

		// Keep the block scalar's trailing newline to prove it is not parsed as a date.
		expect(metadata.values).toEqual([
			{ qualifiedField: "frontmatter.badDay", valueKind: "string", value: "2026-02-31" },
			{ qualifiedField: "frontmatter.looseDate", valueKind: "string", value: "2026-7-9" },
			{ qualifiedField: "frontmatter.compact", valueKind: "number", value: 20260729 },
			{ qualifiedField: "frontmatter.block", valueKind: "string", value: "2026-07-29\n" },
		]);
	});
});

describe("files_metadata_parse_maybe_date", () => {
	test("parses accepted ISO-8601 shapes to epoch milliseconds", () => {
		expect(files_metadata_parse_maybe_date("2026-07-29")).toBe(Date.UTC(2026, 6, 29));
		expect(files_metadata_parse_maybe_date("2026-07-29T14:30")).toBe(Date.UTC(2026, 6, 29, 14, 30));
		expect(files_metadata_parse_maybe_date("2026-07-29T14:30:36")).toBe(Date.UTC(2026, 6, 29, 14, 30, 36));
		expect(files_metadata_parse_maybe_date("2026-07-29T14:30:36.264Z")).toBe(Date.UTC(2026, 6, 29, 14, 30, 36, 264));
		expect(files_metadata_parse_maybe_date("2026-07-29T15:30:00+01:00")).toBe(Date.UTC(2026, 6, 29, 14, 30));
		expect(files_metadata_parse_maybe_date("2026-07-29T13:30:00-01:00")).toBe(Date.UTC(2026, 6, 29, 14, 30));
		// Cover a datetime without seconds and a fraction shorter than milliseconds.
		expect(files_metadata_parse_maybe_date("2026-07-29T15:30+01:00")).toBe(Date.UTC(2026, 6, 29, 14, 30));
		expect(files_metadata_parse_maybe_date("2026-07-29T14:30:36.2Z")).toBe(Date.UTC(2026, 6, 29, 14, 30, 36, 200));
		// A fraction longer than milliseconds is accepted, not rejected. V8 truncates the extra digits
		// by itself, so this case pins the regex rather than the slice.
		expect(files_metadata_parse_maybe_date("2026-07-29T14:30:36.2643333Z")).toBe(Date.UTC(2026, 6, 29, 14, 30, 36, 264));
		expect(files_metadata_parse_maybe_date("2029-02-29T00:00:00Z")).toBeNull();
		expect(files_metadata_parse_maybe_date("2028-02-29T00:00:00Z")).toBe(Date.UTC(2028, 1, 29));
		// Keep zero as a valid timestamp. Callers must check === null, not falsiness.
		expect(files_metadata_parse_maybe_date("1970-01-01")).toBe(0);
	});

	test("rejects invalid calendar dates instead of trusting Date.parse rollover", () => {
		// Validate every component from the string. V8 rolls some invalid dates forward and rejects
		// others, and other engines may choose differently.
		expect(files_metadata_parse_maybe_date("2026-02-31")).toBeNull();
		expect(files_metadata_parse_maybe_date("2026-04-31")).toBeNull();
		expect(files_metadata_parse_maybe_date("2026-13-01")).toBeNull();
		expect(files_metadata_parse_maybe_date("2026-00-10")).toBeNull();
		expect(files_metadata_parse_maybe_date("2026-07-00")).toBeNull();
		expect(files_metadata_parse_maybe_date("2026-07-29T24:00")).toBeNull();
		expect(files_metadata_parse_maybe_date("2026-07-29T14:60")).toBeNull();
		expect(files_metadata_parse_maybe_date("2026-07-29T14:30:60")).toBeNull();
		expect(files_metadata_parse_maybe_date("2026-07-29T14:30:00+24:00")).toBeNull();
		expect(files_metadata_parse_maybe_date("2026-07-29T14:30:00+01:60")).toBeNull();
	});

	test("rejects strings that only look close to a date", () => {
		expect(files_metadata_parse_maybe_date("2026-7-9")).toBeNull();
		expect(files_metadata_parse_maybe_date("20260729")).toBeNull();
		expect(files_metadata_parse_maybe_date("2026-07-29x")).toBeNull();
		expect(files_metadata_parse_maybe_date("x2026-07-29")).toBeNull();
		expect(files_metadata_parse_maybe_date("2026-07-29\n")).toBeNull();
		expect(files_metadata_parse_maybe_date("2026-07-29Z")).toBeNull();
		expect(files_metadata_parse_maybe_date("2026-07-29 14:30")).toBeNull();
		expect(files_metadata_parse_maybe_date("July 29, 2026")).toBeNull();
		expect(files_metadata_parse_maybe_date("")).toBeNull();
	});
});
