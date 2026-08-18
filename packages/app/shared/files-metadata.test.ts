import { describe, expect, test } from "vitest";
import {
	files_metadata_apply_set_and_remove,
	files_metadata_extract_frontmatter,
	files_metadata_extract_entries,
	files_metadata_parse_maybe_date,
	files_metadata_parse_entries_yaml,
	files_metadata_preflight_frontmatter,
	files_metadata_stringify_entries_yaml,
	files_metadata_validate_entries,
	files_metadata_validate_remove_keys,
	type files_metadata_Entry,
} from "./files-metadata.ts";

describe("files_metadata_extract_frontmatter", () => {
	test("returns empty metadata when no closed leading frontmatter exists", () => {
		expect(files_metadata_extract_frontmatter("# Title\n")._yay).toEqual({ fields: [], values: [] });
		expect(files_metadata_extract_frontmatter("---\nfrom: alice\n")._yay).toEqual({ fields: [], values: [] });
		expect(files_metadata_extract_frontmatter("x\n---\nfrom: alice\n---\n")._yay).toEqual({ fields: [], values: [] });
		expect(files_metadata_extract_frontmatter("--- yaml\nfrom: alice\n---\n")._yay).toEqual({ fields: [], values: [] });
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

		expect(metadata._yay?.fields).toEqual([
			"frontmatter.from",
			"frontmatter.amount",
			"frontmatter.hasAttachments",
			"frontmatter.legacyYes",
			"frontmatter.date",
		]);
		expect(metadata._yay?.values).toEqual([
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

		expect(metadata._yay?.fields).toEqual(["frontmatter.cc"]);
		expect(metadata._yay?.values).toEqual([
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

		expect(metadata._yay?.fields).toEqual(["frontmatter.cc", "frontmatter.subject"]);
		expect(metadata._yay?.values).toEqual([
			{ qualifiedField: "frontmatter.cc", valueKind: "string", value: "bob@example.com" },
			{ qualifiedField: "frontmatter.cc", valueKind: "string", value: "jane@example.com" },
			{ qualifiedField: "frontmatter.subject", valueKind: "string", value: "alpha\u00a0beta" },
		]);
	});

	test("flattens safe nested object keys and skips unsafe key segments", () => {
		const metadata = files_metadata_extract_frontmatter(
			["---", "sender:", "  name: Alice", "  bad.key: skipped", "  team-id: ops", "---", ""].join("\n"),
		);

		expect(metadata._yay?.fields).toEqual(["frontmatter.sender", "frontmatter.sender.name", "frontmatter.sender.team-id"]);
		expect(metadata._yay?.values).toEqual([
			{ qualifiedField: "frontmatter.sender.name", valueKind: "string", value: "Alice" },
			{ qualifiedField: "frontmatter.sender.team-id", valueKind: "string", value: "ops" },
		]);
	});

	test("keeps null and object arrays as presence-only metadata", () => {
		const metadata = files_metadata_extract_frontmatter(
			["---", "nullable: null", "attachments:", "  - name: invoice.pdf", "---", ""].join("\n"),
		);

		expect(metadata._yay?.fields).toEqual(["frontmatter.nullable", "frontmatter.attachments"]);
		expect(metadata._yay?.values).toEqual([]);
	});

	test("drops invalid YAML, duplicate keys, aliases, and anchors", () => {
		expect(files_metadata_extract_frontmatter("---\na: [\n---\n")._yay).toEqual({ fields: [], values: [] });
		expect(files_metadata_extract_frontmatter("---\na: 1\na: 2\n---\n")._yay).toEqual({ fields: [], values: [] });
		expect(files_metadata_extract_frontmatter("---\na: &x 1\nb: *x\n---\n")._yay).toEqual({ fields: [], values: [] });
	});

	test("returns a Result for deep nesting in a small file, instead of throwing", () => {
		// Flow style needs no indentation, so 1000 levels fit in about 5 KB. That depth is enough to
		// fill Node's stack, which is the runtime this test runs in; the Convex runtime needs more.
		// Every caller is a file save, so a throw here would stop the user saving their own text.
		const markdown = `---\na: ${"{b: ".repeat(1000)}v${"}".repeat(1000)}\n---\n`;
		expect(markdown.length).toBeLessThan(16 * 1024);
		expect(() => files_metadata_extract_frontmatter(markdown)).not.toThrow();
		expect(files_metadata_extract_frontmatter(markdown)._nay?.message).toBe("Failed to parse frontmatter");
	});

	test("keeps the preflight counts on the yay branch and reports an unreadable parse", () => {
		const preflight = files_metadata_preflight_frontmatter("---\ntitle: Hello\n---\n");
		expect(preflight._yay?.fieldCount).toBe(1);
		expect(preflight._yay?.indexDocumentCount).toBe(2);

		const unreadable = `---\na: ${"{b: ".repeat(1000)}v${"}".repeat(1000)}\n---\n`;
		expect(files_metadata_preflight_frontmatter(unreadable)._nay?.message).toBe("Failed to parse frontmatter");
	});

	test("keeps explicit tagged values as presence-only metadata", () => {
		const metadata = files_metadata_extract_frontmatter("---\ndate: !!timestamp 2024-01-02\n---\n");

		expect(metadata._yay?.fields).toEqual(["frontmatter.date"]);
		expect(metadata._yay?.values).toEqual([]);
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

		expect(metadata._yay?.values).toEqual([
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

		expect(metadata._yay?.values).toEqual([
			{ qualifiedField: "frontmatter.times", valueKind: "string", value: "2026-07-29T14:30:00Z" },
			{ qualifiedField: "frontmatter.times", valueKind: "maybe_date", value: Date.UTC(2026, 6, 29, 14, 30) },
			{ qualifiedField: "frontmatter.times", valueKind: "string", value: "2026-07-29T15:30:00+01:00" },
		]);
	});

	test("indexes the epoch itself, which a falsiness check would drop", () => {
		const metadata = files_metadata_extract_frontmatter(["---", "startedAt: 1970-01-01", "---", ""].join("\n"));

		expect(metadata._yay?.values).toEqual([
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
		expect(metadata._yay?.values).toEqual([
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

describe("files_metadata_parse_entries_yaml", () => {
	test("parses a flat map of scalar values", () => {
		const parsed = files_metadata_parse_entries_yaml(
			["created-by: alice", "slack:message-id: C123.456", "count: 12", "archived: false"].join("\n"),
		);

		expect(parsed._yay?.entries).toEqual([
			{ key: "created-by", value: "alice" },
			{ key: "slack:message-id", value: "C123.456" },
			{ key: "count", value: 12 },
			{ key: "archived", value: false },
		]);
	});

	test("keeps the plain strings that pre-1.2 YAML would have read as booleans or dates", () => {
		const parsed = files_metadata_parse_entries_yaml(["a: no", "b: yes", "c: 2026-08-18", "d: on"].join("\n"));

		expect(parsed._yay?.entries).toEqual([
			{ key: "a", value: "no" },
			{ key: "b", value: "yes" },
			{ key: "c", value: "2026-08-18" },
			{ key: "d", value: "on" },
		]);
	});

	test("keeps a number whose text does not survive a round trip as the text the user typed", () => {
		const parsed = files_metadata_parse_entries_yaml(
			["padded: 1.10", "hex: 0x10", "octalish: 010", "exponent: 1e3", "negativeZero: -0"].join("\n"),
		);

		expect(parsed._yay?.entries).toEqual([
			{ key: "padded", value: "1.10" },
			{ key: "hex", value: "0x10" },
			{ key: "octalish", value: "010" },
			{ key: "exponent", value: "1e3" },
			{ key: "negativeZero", value: "-0" },
		]);
	});

	// The round-trip rule catches these before the finiteness check in the validator ever sees them,
	// so an infinity or NaN literal is stored as the text the user typed instead of being refused.
	test("keeps an infinity or NaN literal as text", () => {
		const parsed = files_metadata_parse_entries_yaml(["infinite: .inf", "notANumber: .nan"].join("\n"));

		expect(parsed._yay?.entries).toEqual([
			{ key: "infinite", value: ".inf" },
			{ key: "notANumber", value: ".nan" },
		]);
	});

	test("keeps a number whose text does survive a round trip as a number", () => {
		const parsed = files_metadata_parse_entries_yaml(["amount: 120.5", "count: 12", "flag: true"].join("\n"));

		expect(parsed._yay?.entries).toEqual([
			{ key: "amount", value: 120.5 },
			{ key: "count", value: 12 },
			{ key: "flag", value: true },
		]);
	});

	// Only the capital letter would be lost, and a string here would drop the key out of every
	// boolean value search, so the round-trip rule stays off booleans.
	test("keeps a capitalized boolean as a boolean", () => {
		const parsed = files_metadata_parse_entries_yaml(["shipped: True", "draft: FALSE"].join("\n"));

		expect(parsed._yay?.entries).toEqual([
			{ key: "shipped", value: true },
			{ key: "draft", value: false },
		]);
	});

	test("reads a key that YAML types as a number or a boolean as the text the user wrote", () => {
		const parsed = files_metadata_parse_entries_yaml(["2026: planned", "true: kept"].join("\n"));

		expect(parsed._yay?.entries).toEqual([
			{ key: "2026", value: "planned" },
			{ key: "true", value: "kept" },
		]);
	});

	test("accepts keys that are not written in English", () => {
		const parsed = files_metadata_parse_entries_yaml(["città: roma", "作者: yamada"].join("\n"));

		expect(parsed._yay?.entries).toEqual([
			{ key: "città", value: "roma" },
			{ key: "作者", value: "yamada" },
		]);
	});

	test("treats an empty document as no metadata", () => {
		expect(files_metadata_parse_entries_yaml("")._yay?.entries).toEqual([]);
		expect(files_metadata_parse_entries_yaml("\n\n")._yay?.entries).toEqual([]);
		expect(files_metadata_parse_entries_yaml("# only a comment\n")._yay?.entries).toEqual([]);
	});

	test("refuses anything that is not a flat map of scalars", () => {
		expect(files_metadata_parse_entries_yaml("- a\n- b")._nay?.message).toBe(
			"Metadata must be a YAML map of keys to values",
		);
		expect(files_metadata_parse_entries_yaml("a: [1, 2]")._nay?.message).toBe(
			'Metadata key "a" must have a text, number, or true/false value',
		);
		expect(files_metadata_parse_entries_yaml("a:\n  b: 1")._nay?.message).toBe(
			'Metadata key "a" must have a text, number, or true/false value',
		);
		expect(files_metadata_parse_entries_yaml("a:")._nay?.message).toBe(
			'Metadata key "a" must have a text, number, or true/false value',
		);
		expect(files_metadata_parse_entries_yaml("a: !!str 1")._nay?.message).toBe(
			'Metadata key "a" must have a text, number, or true/false value',
		);
		expect(files_metadata_parse_entries_yaml("a: &anchor 1\nb: *anchor")._nay?.message).toBe(
			'Metadata key "b" must have a text, number, or true/false value',
		);
	});

	// The library adds the offending lines and a caret below its message. Keep one line, because the
	// panel and the toast both collapse the whitespace that frame is drawn with.
	test("refuses invalid YAML and duplicate keys, with a one-line reason", () => {
		expect(files_metadata_parse_entries_yaml("a: [1, 2")._nay?.message).toMatch(/^Metadata must be valid YAML: /u);
		expect(files_metadata_parse_entries_yaml("a: 1\na: 2")._nay?.message).toBe(
			"Metadata must be valid YAML: Map keys must be unique at line 2, column 1:",
		);
	});

	test("returns a Result for deep nesting inside the YAML byte cap, instead of throwing", () => {
		const nested = `${"{".repeat(2000)}a: 1${"}".repeat(2000)}`;
		expect(nested.length).toBeLessThan(16 * 1024);
		expect(() => files_metadata_parse_entries_yaml(nested)).not.toThrow();
		expect(files_metadata_parse_entries_yaml(nested)._nay).toBeTruthy();
	});

	test("refuses a key outside the metadata key grammar", () => {
		expect(files_metadata_parse_entries_yaml("a.b: 1")._nay?.message).toBe(
			'Metadata key "a.b" may contain only letters, numbers, "_", "-" and ":"',
		);
		expect(files_metadata_parse_entries_yaml("with space: 1")._nay?.message).toBe(
			'Metadata key "with space" may contain only letters, numbers, "_", "-" and ":"',
		);
	});

	test("refuses a document over the byte cap before parsing it", () => {
		const oversized = `key: ${"x".repeat(16 * 1024)}`;

		expect(files_metadata_parse_entries_yaml(oversized)._nay?.message).toBe("Metadata must be at most 16 KiB when written as YAML");
	});
});

describe("files_metadata_validate_entries", () => {
	test("refuses more keys than the cap allows", () => {
		const entries = Array.from({ length: 129 }, (_unused, index) => ({ key: `k${index}`, value: index }));

		expect(files_metadata_validate_entries(entries)._nay?.message).toBe("Metadata can have at most 128 keys");
		expect(files_metadata_validate_entries(entries.slice(0, 128))._nay).toBeUndefined();
	});

	test("refuses an oversized key without quoting it back", () => {
		const message = files_metadata_validate_entries([{ key: "k".repeat(129), value: 1 }])._nay?.message;

		expect(message).toBe("Metadata keys must be at most 128 characters");
		expect(message).not.toContain("kkk");
	});

	test("refuses an oversized string value and a non-finite number", () => {
		expect(files_metadata_validate_entries([{ key: "a", value: "v".repeat(1025) }])._nay?.message).toBe(
			'Metadata key "a" has a value longer than 1024 characters',
		);
		expect(files_metadata_validate_entries([{ key: "a", value: Number.POSITIVE_INFINITY }])._nay?.message).toBe(
			'Metadata key "a" must have a finite number value',
		);
	});

	// Live QA caught this: the model read `metadata.status` from `meta get` and passed it back here.
	test("names the bare key when a caller passes the search field name", () => {
		expect(files_metadata_validate_entries([{ key: "metadata.status", value: "draft" }])._nay?.message).toBe(
			'Metadata key "metadata.status" is a search field name. Pass the bare key "status" instead',
		);
	});

	test("refuses the same key set twice", () => {
		expect(
			files_metadata_validate_entries([
				{ key: "a", value: 1 },
				{ key: "a", value: 2 },
			])._nay?.message,
		).toBe('Metadata key "a" is set twice');
	});

	// The agent writes entries directly, so without this the agent could store a map that stays under
	// the key and value caps but no longer fits the YAML document the panel is allowed to save.
	test("refuses a map that would not fit the panel's YAML cap", () => {
		const entries = Array.from({ length: 32 }, (_unused, index) => ({
			key: `key-${index}`,
			value: "x".repeat(1000),
		}));

		expect(files_metadata_validate_entries(entries)._nay?.message).toBe(
			"Metadata must be at most 16 KiB when written as YAML",
		);
	});
});

describe("files_metadata_apply_set_and_remove", () => {
	test("keeps an existing key in place and appends a new one", () => {
		const current: files_metadata_Entry[] = [
			{ key: "created-by", value: "slack" },
			{ key: "priority", value: 1 },
		];

		expect(files_metadata_apply_set_and_remove(current, { set: [{ key: "created-by", value: "agent" }], remove: [] })).toEqual([
			{ key: "created-by", value: "agent" },
			{ key: "priority", value: 1 },
		]);
		expect(files_metadata_apply_set_and_remove(current, { set: [{ key: "status", value: "draft" }], remove: [] })).toEqual([
			{ key: "created-by", value: "slack" },
			{ key: "priority", value: 1 },
			{ key: "status", value: "draft" },
		]);
	});

	test("removes keys, ignores a key that is not there, and can empty the map", () => {
		const current: files_metadata_Entry[] = [
			{ key: "created-by", value: "slack" },
			{ key: "priority", value: 1 },
		];

		expect(files_metadata_apply_set_and_remove(current, { set: [], remove: ["priority", "missing"] })).toEqual([
			{ key: "created-by", value: "slack" },
		]);
		expect(files_metadata_apply_set_and_remove(current, { set: [], remove: ["created-by", "priority"] })).toEqual([]);
	});

	test("removes a key that is also set, whether or not the file already has it", () => {
		expect(
			files_metadata_apply_set_and_remove([{ key: "created-by", value: "slack" }], {
				set: [{ key: "created-by", value: "agent" }],
				remove: ["created-by"],
			}),
		).toEqual([]);
		expect(
			files_metadata_apply_set_and_remove([], { set: [{ key: "status", value: "draft" }], remove: ["status"] }),
		).toEqual([]);
	});

	// The same key twice used to resolve differently for an existing key than for a new one, which
	// made the stored value depend on something the caller cannot see.
	test("keeps the last value for a key the caller listed twice", () => {
		expect(
			files_metadata_apply_set_and_remove([{ key: "status", value: "old" }], {
				set: [
					{ key: "status", value: "first" },
					{ key: "status", value: "second" },
				],
				remove: [],
			}),
		).toEqual([{ key: "status", value: "second" }]);
		expect(
			files_metadata_apply_set_and_remove([], {
				set: [
					{ key: "status", value: "first" },
					{ key: "status", value: "second" },
				],
				remove: [],
			}),
		).toEqual([{ key: "status", value: "second" }]);
	});
});

describe("files_metadata_stringify_entries_yaml", () => {
	test("round trips a map back to the same entries, in the stored order", () => {
		const entries: files_metadata_Entry[] = [
			{ key: "zebra", value: "last" },
			{ key: "created-by", value: "alice" },
			{ key: "slack:message-id", value: "C123.456" },
			{ key: "padded", value: "1.10" },
			{ key: "looks-boolean", value: "true" },
			{ key: "looks-number", value: "12" },
			{ key: "amount", value: 120.5 },
			{ key: "archived", value: false },
			{ key: "when", value: "2026-08-18" },
		];

		const yamlText = files_metadata_stringify_entries_yaml(entries);

		expect(files_metadata_parse_entries_yaml(yamlText)._yay?.entries).toEqual(entries);
		expect(yamlText.startsWith("zebra:")).toBe(true);
	});

	test("writes an empty map as an empty document", () => {
		expect(files_metadata_stringify_entries_yaml([])).toBe("");
	});
});

describe("files_metadata_extract_entries", () => {
	test("writes one field doc and one value doc per key, plus a maybe_date companion", () => {
		const indexDocs = files_metadata_extract_entries([
			{ key: "created-by", value: "alice" },
			{ key: "sent-at", value: "2026-08-18" },
			{ key: "count", value: 12 },
			{ key: "archived", value: true },
		]);

		expect(indexDocs.fields).toEqual([
			"metadata.created-by",
			"metadata.sent-at",
			"metadata.count",
			"metadata.archived",
		]);
		expect(indexDocs.values).toEqual([
			{ qualifiedField: "metadata.created-by", valueKind: "string", value: "alice" },
			{ qualifiedField: "metadata.sent-at", valueKind: "string", value: "2026-08-18" },
			{ qualifiedField: "metadata.sent-at", valueKind: "maybe_date", value: Date.UTC(2026, 7, 18) },
			{ qualifiedField: "metadata.count", valueKind: "number", value: 12 },
			{ qualifiedField: "metadata.archived", valueKind: "boolean", value: true },
		]);
	});

	test("keeps metadata fields separate from a frontmatter field with the same name", () => {
		const indexDocs = files_metadata_extract_entries([{ key: "title", value: "From metadata" }]);
		const frontmatter = files_metadata_extract_frontmatter("---\ntitle: From frontmatter\n---\n");

		expect(indexDocs.fields).toEqual(["metadata.title"]);
		expect(frontmatter._yay?.fields).toEqual(["frontmatter.title"]);
	});
});

describe("files_metadata_validate_remove_keys", () => {
	// A removed key is never stored, so nothing else checks it. Without this the caller is told the
	// write succeeded while the key it named is still there.
	test("refuses a key that could never have been stored", () => {
		expect(files_metadata_validate_remove_keys(["metadata.status"])._nay?.message).toBe(
			'Metadata key "metadata.status" is a search field name. Pass the bare key "status" instead',
		);
		expect(files_metadata_validate_remove_keys(["with space"])._nay?.message).toBe(
			'Metadata key "with space" may contain only letters, numbers, "_", "-" and ":"',
		);
		expect(files_metadata_validate_remove_keys(["x".repeat(129)])._nay?.message).toBe(
			"Metadata keys must be at most 128 characters",
		);
	});

	test("accepts bare keys, including one that is not there", () => {
		expect(files_metadata_validate_remove_keys(["status", "slack:message-id", "missing"])._yay).toEqual([
			"status",
			"slack:message-id",
			"missing",
		]);
	});
});
