import { describe, expect, test } from "vitest";
import {
	files_table_column_is_valid,
	files_table_DEFAULT_COLUMNS,
	files_table_MAX_COLUMNS,
	files_table_filter_is_valid,
	files_table_filter_matches,
	files_table_filter_order_field,
	files_table_filter_takes_name_prefix,
	files_table_starts_with_ends_in_digit,
	files_table_updated_by_text,
	type files_table_Filter,
} from "./files-table.ts";

const FACTS = { name: "Résumé 007.md", createdAt: 100, updatedAt: 200, extension: "md", contentByteSize: 42 };

describe("files_table_column_is_valid", () => {
	test.each(["name", "updated_by", "updated", "created", "extension", "size", "metadata.rank", "frontmatter.rank"])(
		"accepts %s",
		(field) => expect(files_table_column_is_valid(field)).toBe(true),
	);
	test.each(["actions", "rank", "type", "metadata.", "metadata.invalid key", "metadata." + "a".repeat(300)])(
		"rejects %s",
		(field) => expect(files_table_column_is_valid(field)).toBe(false),
	);
	test("keeps the default three data columns within the cap", () => {
		expect(files_table_DEFAULT_COLUMNS).toEqual(["name", "updated_by", "updated"]);
		expect(files_table_MAX_COLUMNS).toBe(8);
	});
});

describe("files_table_updated_by_text", () => {
	test("shows the name, or Unknown when no name is found", () => {
		expect(files_table_updated_by_text("Ada Lovelace")).toBe("Ada Lovelace");
		expect(files_table_updated_by_text(null)).toBe("Unknown");
	});
});

describe("files_table_starts_with_ends_in_digit", () => {
	test("checks the sort key, so an accent mark after a digit does not hide it", () => {
		expect(files_table_starts_with_ends_in_digit("file1")).toBe(true);
		expect(files_table_starts_with_ends_in_digit("file1\u{301}")).toBe(true);
		expect(files_table_starts_with_ends_in_digit("file1a")).toBe(false);
	});
});

describe("files_table_filter_is_valid", () => {
	test.each<files_table_Filter>([
		{ kind: "name", field: "name", op: "starts_with", value: "x".repeat(1024) },
		{ kind: "name", field: "name", op: "starts_with", value: "file1a" },
		{ kind: "extension", field: "extension", op: "is", value: "MD" },
		{ kind: "extension", field: "extension", op: "missing" },
		{ kind: "date", field: "created", op: "on", start: 0, end: 23 * 60 * 60 * 1000 },
		{ kind: "date", field: "updated", op: "after", start: 0, end: 25 * 60 * 60 * 1000 },
		{ kind: "size", field: "size", op: "is", value: 0 },
		{ kind: "size", field: "size", op: "missing" },
		{ kind: "text", field: "metadata.status", op: "is", value: "false" },
		{ kind: "text", field: "metadata.version", op: "is", value: "2" },
		{ kind: "text", field: "frontmatter.status", op: "present" },
	])("accepts $kind/$op", (filter) => expect(files_table_filter_is_valid(filter)).toBe(true));

	test.each<files_table_Filter>([
		{ kind: "name", field: "name", op: "starts_with", value: "" },
		// The sort key writes a number with its length first, so a prefix that ends in a digit is not one range.
		{ kind: "name", field: "name", op: "starts_with", value: "file1" },
		{ kind: "text", field: "metadata.version", op: "starts_with", value: "v2" },
		{ kind: "extension", field: "extension", op: "is", value: "x".repeat(1025) },
		{ kind: "text", field: "name", op: "present" },
		{ kind: "text", field: "status", op: "present" },
		{ kind: "text", field: "metadata.", op: "present" },
		{ kind: "text", field: "metadata.status", op: "is", value: "" },
		{ kind: "size", field: "size", op: "is", value: -1 },
		{ kind: "size", field: "size", op: "at_least", value: 0.5 },
		{ kind: "size", field: "size", op: "at_most", value: Infinity },
		{ kind: "size", field: "size", op: "is", value: NaN },
		{ kind: "date", field: "updated", op: "on", start: 0, end: 22 * 60 * 60 * 1000 },
		{ kind: "date", field: "created", op: "before", start: 0, end: 26 * 60 * 60 * 1000 },
		{ kind: "date", field: "created", op: "after", start: Infinity, end: Infinity },
		{ kind: "date", field: "updated", op: "on", start: 0, end: NaN },
	])("rejects invalid $kind/$op: $value", (filter) => expect(files_table_filter_is_valid(filter)).toBe(false));
});

// Each filter with its order field and whether `name starts with` can join it.
const FILTER_ORDERS: Array<[files_table_Filter, string, boolean]> = [
	[{ kind: "name", field: "name", op: "starts_with", value: "re" }, "name", false],
	[{ kind: "extension", field: "extension", op: "is", value: "md" }, "name", true],
	[{ kind: "extension", field: "extension", op: "missing" }, "name", true],
	[{ kind: "date", field: "updated", op: "on", start: 0, end: 24 * 60 * 60 * 1000 }, "updated", false],
	[{ kind: "date", field: "created", op: "before", start: 0, end: 24 * 60 * 60 * 1000 }, "created", false],
	[{ kind: "size", field: "size", op: "is", value: 1 }, "name", true],
	[{ kind: "size", field: "size", op: "missing" }, "name", true],
	[{ kind: "size", field: "size", op: "at_least", value: 1 }, "size", false],
	[{ kind: "size", field: "size", op: "at_most", value: 1 }, "size", false],
	[{ kind: "text", field: "metadata.status", op: "is", value: "ready" }, "name", true],
	[{ kind: "text", field: "metadata.status", op: "starts_with", value: "re" }, "metadata.status", false],
	[{ kind: "text", field: "metadata.status", op: "present" }, "metadata.status", false],
];

describe("files_table_filter_order_field", () => {
	test.each(FILTER_ORDERS)("%j orders by %s", (filter, field) => {
		expect(files_table_filter_order_field(filter)).toBe(field);
	});
});

describe("files_table_filter_takes_name_prefix", () => {
	test.each(FILTER_ORDERS)("%j (order %s) takes a name prefix: %s", (filter, _field, takesNamePrefix) => {
		expect(files_table_filter_takes_name_prefix(filter)).toBe(takesNamePrefix);
	});
});

describe("files_table_filter_matches", () => {
	test("matches the start of file.name, ignoring case and accents", () => {
		expect(
			files_table_filter_matches({
				filter: { kind: "name", field: "name", op: "starts_with", value: "RÉSU" },
				facts: FACTS,
			}),
		).toBe(true);
		expect(
			files_table_filter_matches({
				filter: { kind: "name", field: "name", op: "starts_with", value: "sum" },
				facts: FACTS,
			}),
		).toBe(false);
	});

	test("compares lower-case file.extension without removing a leading dot", () => {
		expect(
			files_table_filter_matches({ filter: { kind: "extension", field: "extension", op: "is", value: "MD" }, facts: FACTS }),
		).toBe(true);
		expect(
			files_table_filter_matches({ filter: { kind: "extension", field: "extension", op: "is", value: ".md" }, facts: FACTS }),
		).toBe(false);
		expect(files_table_filter_matches({ filter: { kind: "extension", field: "extension", op: "missing" }, facts: FACTS })).toBe(
			false,
		);
		expect(
			files_table_filter_matches({
				filter: { kind: "extension", field: "extension", op: "missing" },
				facts: { ...FACTS, extension: null },
			}),
		).toBe(true);
		expect(
			files_table_filter_matches({
				filter: { kind: "extension", field: "extension", op: "is", value: "md" },
				facts: { ...FACTS, extension: null },
			}),
		).toBe(false);
	});

	test.each(["created", "updated"] as const)("uses exact day boundaries for %s", (field) => {
		const filter: files_table_Filter = { kind: "date", field, op: "on", start: 100, end: 200 };
		const at = (time: number) => ({ ...FACTS, createdAt: time, updatedAt: time });
		expect(files_table_filter_matches({ filter, facts: at(99) })).toBe(false);
		expect(files_table_filter_matches({ filter, facts: at(100) })).toBe(true);
		expect(files_table_filter_matches({ filter, facts: at(199) })).toBe(true);
		expect(files_table_filter_matches({ filter, facts: at(200) })).toBe(false);
		expect(files_table_filter_matches({ filter: { ...filter, op: "before" }, facts: at(99) })).toBe(true);
		expect(files_table_filter_matches({ filter: { ...filter, op: "before" }, facts: at(100) })).toBe(false);
		expect(files_table_filter_matches({ filter: { ...filter, op: "after" }, facts: at(199) })).toBe(false);
		expect(files_table_filter_matches({ filter: { ...filter, op: "after" }, facts: at(200) })).toBe(true);
	});

	test("compares file.size and keeps unknown values separate from zero", () => {
		for (const op of ["is", "at_least", "at_most"] as const) {
			expect(files_table_filter_matches({ filter: { kind: "size", field: "size", op, value: 42 }, facts: FACTS })).toBe(
				true,
			);
			expect(
				files_table_filter_matches({
					filter: { kind: "size", field: "size", op, value: 0 },
					facts: { ...FACTS, contentByteSize: null },
				}),
			).toBe(false);
		}
		expect(
			files_table_filter_matches({ filter: { kind: "size", field: "size", op: "at_least", value: 43 }, facts: FACTS }),
		).toBe(false);
		expect(
			files_table_filter_matches({ filter: { kind: "size", field: "size", op: "at_most", value: 41 }, facts: FACTS }),
		).toBe(false);
		expect(
			files_table_filter_matches({
				filter: { kind: "size", field: "size", op: "missing" },
				facts: { ...FACTS, contentByteSize: null },
			}),
		).toBe(true);
		expect(
			files_table_filter_matches({
				filter: { kind: "size", field: "size", op: "missing" },
				facts: { ...FACTS, contentByteSize: 0 },
			}),
		).toBe(false);
		expect(
			files_table_filter_matches({
				filter: { kind: "size", field: "size", op: "is", value: 0 },
				facts: { ...FACTS, contentByteSize: 0 },
			}),
		).toBe(true);
	});

	test.each([false, 0, ""])("keeps %s as a present scalar", (scalar) => {
		expect(
			files_table_filter_matches({
				filter: { kind: "text", field: "metadata.status", op: "present" },
				facts: FACTS,
				scalar,
			}),
		).toBe(true);
		if (scalar !== "") {
			expect(
				files_table_filter_matches({
					filter: { kind: "text", field: "metadata.status", op: "is", value: String(scalar) },
					facts: FACTS,
					scalar,
				}),
			).toBe(true);
		}
	});

	test("matches only the given scalar, and a missing value matches nothing", () => {
		expect(
			files_table_filter_matches({
				filter: { kind: "text", field: "metadata.status", op: "is", value: "READY" },
				facts: FACTS,
				scalar: "réady",
			}),
		).toBe(true);
		expect(
			files_table_filter_matches({
				filter: { kind: "text", field: "metadata.status", op: "starts_with", value: "REA" },
				facts: FACTS,
				scalar: "réady",
			}),
		).toBe(true);
		expect(
			files_table_filter_matches({
				filter: { kind: "text", field: "metadata.status", op: "is", value: "ready" },
				facts: FACTS,
				scalar: "ready later",
			}),
		).toBe(false);
		// Like the index range, `is` compares sort keys, so leading zeros do not count.
		expect(
			files_table_filter_matches({
				filter: { kind: "text", field: "metadata.status", op: "is", value: "7" },
				facts: FACTS,
				scalar: "007",
			}),
		).toBe(true);
		expect(
			files_table_filter_matches({
				filter: { kind: "text", field: "metadata.status", op: "is", value: "false" },
				facts: FACTS,
				scalar: null,
			}),
		).toBe(false);
		expect(
			files_table_filter_matches({
				filter: { kind: "text", field: "metadata.status", op: "present" },
				facts: FACTS,
				scalar: null,
			}),
		).toBe(false);
	});
});
