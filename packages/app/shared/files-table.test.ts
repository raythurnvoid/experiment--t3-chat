import { describe, expect, test } from "vitest";
import {
	files_table_column_is_valid,
	files_table_DEFAULT_COLUMNS,
	files_table_MAX_COLUMNS,
	files_table_filter_is_valid,
	files_table_filter_matches,
	type files_table_Filter,
} from "./files-table.ts";

const FACTS = { name: "Résumé 007.md", createdAt: 100, updatedAt: 200, type: "md", contentByteSize: 42 };

describe("files_table_column_is_valid", () => {
	test.each(["name", "updated_by", "updated", "created", "type", "size", "metadata.rank", "frontmatter.rank"])(
		"accepts %s",
		(field) => expect(files_table_column_is_valid(field)).toBe(true),
	);
	test.each(["actions", "rank", "metadata.", "metadata.invalid key", "metadata." + "a".repeat(300)])(
		"rejects %s",
		(field) => expect(files_table_column_is_valid(field)).toBe(false),
	);
	test("keeps the default three data columns within the cap", () => {
		expect(files_table_DEFAULT_COLUMNS).toEqual(["name", "updated_by", "updated"]);
		expect(files_table_MAX_COLUMNS).toBe(8);
	});
});

describe("files_table_filter_is_valid", () => {
	test.each<files_table_Filter>([
		{ kind: "name", field: "name", op: "contains", value: "x" },
		{ kind: "name", field: "name", op: "starts_with", value: "x".repeat(1024) },
		{ kind: "type", field: "type", op: "is", value: "MD" },
		{ kind: "type", field: "type", op: "missing" },
		{ kind: "date", field: "created", op: "on", start: 0, end: 23 * 60 * 60 * 1000 },
		{ kind: "date", field: "updated", op: "after", start: 0, end: 25 * 60 * 60 * 1000 },
		{ kind: "size", field: "size", op: "is", value: 0 },
		{ kind: "size", field: "size", op: "missing" },
		{ kind: "text", field: "metadata.status", op: "is", value: "false" },
		{ kind: "text", field: "frontmatter.status", op: "present" },
	])("accepts $kind/$op", (filter) => expect(files_table_filter_is_valid(filter)).toBe(true));

	test.each<files_table_Filter>([
		{ kind: "name", field: "name", op: "contains", value: "" },
		{ kind: "type", field: "type", op: "is", value: "x".repeat(1025) },
		{ kind: "text", field: "name", op: "missing" },
		{ kind: "text", field: "status", op: "missing" },
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

describe("files_table_filter_matches", () => {
	test("matches Name case and accents without changing digits or cutting text", () => {
		expect(
			files_table_filter_matches({
				filter: { kind: "name", field: "name", op: "contains", value: "RESUME 007" },
				facts: FACTS,
			}),
		).toBe(true);
		expect(
			files_table_filter_matches({
				filter: { kind: "name", field: "name", op: "starts_with", value: "résu" },
				facts: FACTS,
			}),
		).toBe(true);
		expect(
			files_table_filter_matches({
				filter: { kind: "name", field: "name", op: "contains", value: "7.md" },
				facts: FACTS,
			}),
		).toBe(true);
		expect(
			files_table_filter_matches({
				filter: { kind: "name", field: "name", op: "contains", value: "resume 7" },
				facts: FACTS,
			}),
		).toBe(false);
		expect(
			files_table_filter_matches({
				filter: { kind: "name", field: "name", op: "starts_with", value: "007" },
				facts: FACTS,
			}),
		).toBe(false);
		expect(
			files_table_filter_matches({
				filter: { kind: "name", field: "name", op: "contains", value: "END🚀" },
				facts: { ...FACTS, name: "x".repeat(1024) + "end🚀" },
			}),
		).toBe(true);
	});

	test("compares lower-case Type without removing a leading dot", () => {
		expect(
			files_table_filter_matches({ filter: { kind: "type", field: "type", op: "is", value: "MD" }, facts: FACTS }),
		).toBe(true);
		expect(
			files_table_filter_matches({ filter: { kind: "type", field: "type", op: "is", value: ".md" }, facts: FACTS }),
		).toBe(false);
		expect(files_table_filter_matches({ filter: { kind: "type", field: "type", op: "missing" }, facts: FACTS })).toBe(
			false,
		);
		expect(
			files_table_filter_matches({
				filter: { kind: "type", field: "type", op: "missing" },
				facts: { ...FACTS, type: null },
			}),
		).toBe(true);
		expect(
			files_table_filter_matches({
				filter: { kind: "type", field: "type", op: "is", value: "md" },
				facts: { ...FACTS, type: null },
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

	test("compares Size and keeps unknown values separate from zero", () => {
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
		expect(
			files_table_filter_matches({
				filter: { kind: "text", field: "metadata.status", op: "missing" },
				facts: FACTS,
				scalar,
			}),
		).toBe(false);
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

	test("matches only the given scalar and keeps missing values separate from text", () => {
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
		expect(
			files_table_filter_matches({
				filter: { kind: "text", field: "metadata.status", op: "is", value: "false" },
				facts: FACTS,
				scalar: null,
			}),
		).toBe(false);
		expect(
			files_table_filter_matches({
				filter: { kind: "text", field: "metadata.status", op: "missing" },
				facts: FACTS,
				scalar: null,
			}),
		).toBe(true);
		expect(
			files_table_filter_matches({
				filter: { kind: "text", field: "metadata.status", op: "present" },
				facts: FACTS,
				scalar: null,
			}),
		).toBe(false);
	});
});
