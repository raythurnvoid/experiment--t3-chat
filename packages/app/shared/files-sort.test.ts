import { compareValues } from "convex/values";
import { describe, expect, test } from "vitest";

import type { files_metadata_Value } from "./files-metadata.ts";
import {
	files_sort_compare,
	files_sort_field_is_valid,
	files_sort_execution_fields,
	files_sort_is_valid,
	files_sort_key_of,
	files_sort_text_key,
	files_sort_value_of,
	type files_sort_Sort,
} from "./files-sort.ts";

const sort_names = (names: string[]) =>
	[...names].sort((a, b) => compareValues([files_sort_text_key(a), a], [files_sort_text_key(b), b]));

describe("files_sort_text_key", () => {
	test("sorts names alphabetically, ignoring case and accents, with numbers by value", () => {
		expect(sort_names(["B.md", "a.md", "file10.md", "file2.md", "É.md"])).toEqual([
			"a.md",
			"B.md",
			"É.md",
			"file2.md",
			"file10.md",
		]);
	});

	test("sorts an accented letter with its plain letter", () => {
		expect(sort_names(["Eb", "Éa", "eC"])).toEqual(["Éa", "Eb", "eC"]);
	});

	test("breaks ties by the raw name", () => {
		expect(sort_names(["file007", "file7", "a.md", "A.md"])).toEqual(["A.md", "a.md", "file007", "file7"]);
		expect(files_sort_text_key("file007")).toBe(files_sort_text_key("file7"));
	});

	test("writes digit runs with their length", () => {
		expect(files_sort_text_key("2")).toBe("012");
		expect(files_sort_text_key("10")).toBe("0210");
		expect(files_sort_text_key("007")).toBe("017");
		expect(files_sort_text_key("000")).toBe("010");
	});

	test("keeps 99 digits of a longer run", () => {
		const key = files_sort_text_key("1".repeat(120));
		expect(key).toBe(`99${"1".repeat(99)}`);
		expect(sort_names(["9".repeat(98), "1".repeat(120)])).toEqual(["9".repeat(98), "1".repeat(120)]);
	});

	test("never cuts an emoji in half", () => {
		for (let offset = 250; offset <= 260; offset++) {
			const key = files_sort_text_key(`${"a".repeat(offset)}😀😀😀😀😀😀😀😀`);
			expect(Array.from(key)).toHaveLength(256);
			expect(key.isWellFormed()).toBe(true);
		}
	});
});

describe("files_sort_value_of", () => {
	const text_value = (value: files_metadata_Value["value"]) =>
		files_sort_value_of([
			typeof value === "string"
				? { fieldPath: "metadata.x", valueKind: "string", value }
				: typeof value === "number"
					? { fieldPath: "metadata.x", valueKind: "number", value }
					: { fieldPath: "metadata.x", valueKind: "boolean", value },
		])!.sortValue;

	test("sorts numbers and booleans as text", () => {
		expect(text_value(1000)).toBe(files_sort_text_key("1000"));
		expect(text_value(true)).toBe("true");
		expect(text_value(false)).toBe("false");
		// Whole numbers sort by value, because digit runs do.
		expect(compareValues(text_value(9), text_value(10))).toBe(-1);
	});

	test("sorts ISO dates in one format in time order", () => {
		expect(compareValues(text_value("2026-09-04"), text_value("2026-10-01"))).toBe(-1);
		expect(compareValues(text_value("2026-09-04T09:00Z"), text_value("2026-09-04T10:00Z"))).toBe(-1);
	});

	test("uses the first list item and skips maybe_date values", () => {
		expect(
			files_sort_value_of([
				{ fieldPath: "frontmatter.tags", valueKind: "maybe_date", value: 0 },
				{ fieldPath: "frontmatter.tags", valueKind: "string", value: "Zeta" },
				{ fieldPath: "frontmatter.tags", valueKind: "string", value: "alpha" },
			]),
		).toEqual({ sortValue: "zeta", displayValue: "Zeta" });
	});

	test("returns null for a field without a plain value", () => {
		expect(files_sort_value_of([])).toBeNull();
	});
});

describe("files_sort_field_is_valid", () => {
	test("accepts built-in fields and searchable field paths", () => {
		expect(files_sort_field_is_valid("size")).toBe(true);
		expect(files_sort_field_is_valid("metadata.slack:message-id")).toBe(true);
		expect(files_sort_field_is_valid("frontmatter.source.channel")).toBe(true);
	});

	test("refuses other fields", () => {
		expect(files_sort_field_is_valid("status")).toBe(false);
		expect(files_sort_field_is_valid("metadata.a.b")).toBe(false);
		expect(files_sort_field_is_valid(`metadata.${"a".repeat(200)}`)).toBe(false);
	});
});

describe("files_sort_compare", () => {
	const key = (sort: files_sort_Sort, name: string, status: string | null = "same", priority: string | null = null) =>
		files_sort_key_of(
			sort,
			{ kind: "file", name, createdAt: 1, updatedAt: 2, type: "md", contentByteSize: 3 },
			new Map([
				["metadata.status", status],
				["metadata.priority", priority],
			]),
		);

	test.each(["asc", "desc"] as const)("keeps Name independent of a %s primary direction", (direction) => {
		const sort: files_sort_Sort = [
			{ field: "metadata.status", direction },
			{ field: "name", direction: "desc" },
		];
		expect(files_sort_compare(key(sort, "a"), key(sort, "b"), sort)).toBe(1);
		expect(files_sort_compare(key(sort, "a", "a"), key(sort, "b", "b"), sort)).toBe(direction === "asc" ? -1 : 1);
	});

	test.each(["asc", "desc"] as const)("keeps missing primary and secondary last with %s", (direction) => {
		const sort: files_sort_Sort = [
			{ field: "metadata.status", direction },
			{ field: "metadata.priority", direction },
		];
		expect(files_sort_compare(key(sort, "z", "a"), key(sort, "a", null), sort)).toBe(-1);
		expect(files_sort_compare(key(sort, "z", "a", "x"), key(sort, "a", "a", null), sort)).toBe(-1);
		expect(files_sort_compare(key(sort, "z", null, "x"), key(sort, "a", null, null), sort)).toBe(-1);
		expect(Math.sign(files_sort_compare(key(sort, "a", null, null), key(sort, "z", null, null), sort))).toBe(-1);
	});

	test("uses the third clause before final Name asc", () => {
		const sort: files_sort_Sort = [
			{ field: "metadata.status", direction: "desc" },
			{ field: "metadata.priority", direction: "desc" },
			{ field: "name", direction: "desc" },
		];
		expect(files_sort_compare(key(sort, "a", "same", "same"), key(sort, "b", "same", "same"), sort)).toBe(1);
	});

	test("reverses a single present suffix but keeps single missing Name asc", () => {
		const sort: files_sort_Sort = [{ field: "metadata.status", direction: "desc" }];
		expect(files_sort_compare(key(sort, "a"), key(sort, "b"), sort)).toBe(1);
		expect(files_sort_compare(key(sort, "a", null), key(sort, "b", null), sort)).toBe(-1);
	});

	test("keeps single Created equal-time ties", () => {
		const sort: files_sort_Sort = [{ field: "created", direction: "desc" }];
		expect(files_sort_compare(key(sort, "a"), key(sort, "b"), sort)).toBe(0);
	});
});

describe("files_sort_key_of", () => {
	const facts = { kind: "file" as const, name: "File2.10", createdAt: 1, updatedAt: 2, type: "10", contentByteSize: 0 };

	test("keeps raw Type and exact one-clause suffixes", () => {
		expect(files_sort_key_of([{ field: "type", direction: "asc" }], facts, new Map())).toEqual({
			parts: [["10", "file012.0210", "File2.10"]],
			nameKey: ["file012.0210", "File2.10"],
		});
		expect(files_sort_key_of([{ field: "created", direction: "asc" }], facts, new Map()).parts).toEqual([[1]]);
		expect(files_sort_key_of([{ field: "size", direction: "desc" }], facts, new Map()).parts).toEqual([
			[0, "file012.0210", "File2.10"],
		]);
	});

	test("keeps metadata encoded and scalar parts before a later Name", () => {
		const sort: files_sort_Sort = [
			{ field: "metadata.x", direction: "desc" },
			{ field: "name", direction: "asc" },
			{ field: "updated", direction: "desc" },
		];
		expect(files_sort_key_of(sort, facts, new Map([["metadata.x", "a0210"]])).parts).toEqual([
			["a0210"],
			["file012.0210", "File2.10"],
			null,
		]);
	});

	test("keeps folder Type and Size missing at their original positions", () => {
		const sort: files_sort_Sort = [
			{ field: "type", direction: "desc" },
			{ field: "size", direction: "asc" },
			{ field: "updated", direction: "desc" },
		];
		expect(files_sort_key_of(sort, { ...facts, kind: "folder" }, new Map()).parts).toEqual([null, null, [2]]);
		expect(
			files_sort_key_of([{ field: "size", direction: "desc" }], { ...facts, kind: "folder" }, new Map()).parts,
		).toEqual([null]);
	});

	test("raw numeric and accented extensions agree with the index in both directions", () => {
		for (const direction of ["asc", "desc"] as const) {
			const sort: files_sort_Sort = [
				{ field: "type", direction },
				{ field: "name", direction: "asc" },
			];
			const make = (type: string) => files_sort_key_of(sort, { ...facts, name: `a.${type}`, type }, new Map());
			expect(files_sort_compare(make("10"), make("2"), sort)).toBe(direction === "asc" ? -1 : 1);
			expect(Math.sign(files_sort_compare(make("é"), make("e"), sort))).toBe(direction === "asc" ? 1 : -1);
		}
	});
});

describe("files_sort_is_valid", () => {
	test("accepts one to three distinct valid fields", () => {
		expect(files_sort_is_valid([{ field: "name", direction: "asc" }])).toBe(true);
		expect(
			files_sort_is_valid([
				{ field: "metadata.x", direction: "desc" },
				{ field: "created", direction: "asc" },
				{ field: "name", direction: "desc" },
			]),
		).toBe(true);
	});

	test("refuses empty, long, duplicate and invalid fields", () => {
		for (const sort of [
			[],
			["name", "updated", "created", "size"].map((field) => ({ field, direction: "asc" as const })),
			[
				{ field: "name", direction: "asc" as const },
				{ field: "name", direction: "desc" as const },
			],
			[{ field: "bad", direction: "asc" as const }],
		]) {
			expect(files_sort_is_valid(sort)).toBe(false);
		}
	});
});

describe("files_sort_execution_fields", () => {
	test("removes multi-sort folder Type/Size without changing the saved list", () => {
		const sort: files_sort_Sort = [
			{ field: "type", direction: "desc" },
			{ field: "size", direction: "asc" },
			{ field: "updated", direction: "desc" },
		];
		expect(files_sort_execution_fields(sort, "folder")).toEqual([sort[2]]);
		expect(files_sort_execution_fields(sort, "file")).toEqual(sort);
		expect(sort).toHaveLength(3);
		expect(files_sort_execution_fields(sort.slice(0, 2), "folder")).toEqual([]);
	});

	test("stops after Name and keeps single-field choices", () => {
		const sort: files_sort_Sort = [
			{ field: "name", direction: "desc" },
			{ field: "metadata.x", direction: "asc" },
		];
		expect(files_sort_execution_fields(sort, "file")).toEqual([sort[0]]);
		expect(files_sort_execution_fields([{ field: "size", direction: "desc" }], "folder")).toEqual([
			{ field: "size", direction: "desc" },
		]);
	});
});
