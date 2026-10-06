import { compareValues } from "convex/values";
import { describe, expect, test } from "vitest";

import type { files_metadata_Value } from "./files-metadata.ts";
import {
	files_sort_compare,
	files_sort_field_is_valid,
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
		expect(files_sort_field_is_valid("metadata.slack-message-id")).toBe(true);
		expect(files_sort_field_is_valid("frontmatter.source.channel")).toBe(true);
	});

	test("refuses other fields", () => {
		expect(files_sort_field_is_valid("status")).toBe(false);
		expect(files_sort_field_is_valid("metadata.a.b")).toBe(false);
		expect(files_sort_field_is_valid(`metadata.${"a".repeat(200)}`)).toBe(false);
	});
});

describe("files_sort_compare", () => {
	const key = (args: { sort: files_sort_Sort; name: string; status?: string | null }) => {
		const { sort, status = "same", name } = args;

		return files_sort_key_of({
			sort,
			facts: { kind: "file", name, createdAt: 1, updatedAt: 2, extension: "md", contentByteSize: 3 },
			metadataParts: new Map([["metadata.status", status]]),
		});
	};

	test.each(["asc", "desc"] as const)("orders by the value, then file.name, in the %s direction", (direction) => {
		const sort: files_sort_Sort = [{ field: "metadata.status", direction }];
		expect(
			files_sort_compare({ a: key({ sort, name: "b", status: "a" }), b: key({ sort, name: "a", status: "b" }), sort }),
		).toBe(direction === "asc" ? -1 : 1);
		expect(files_sort_compare({ a: key({ sort, name: "a" }), b: key({ sort, name: "b" }), sort })).toBe(
			direction === "asc" ? -1 : 1,
		);
	});

	test.each(["asc", "desc"] as const)("keeps missing values last, in file.name asc order, with %s", (direction) => {
		const sort: files_sort_Sort = [{ field: "metadata.status", direction }];
		expect(
			files_sort_compare({ a: key({ sort, name: "z", status: "a" }), b: key({ sort, name: "a", status: null }), sort }),
		).toBe(-1);
		expect(
			files_sort_compare({
				a: key({ sort, name: "a", status: null }),
				b: key({ sort, name: "b", status: null }),
				sort,
			}),
		).toBe(-1);
	});

	test("reverses file.name desc", () => {
		const sort: files_sort_Sort = [{ field: "name", direction: "desc" }];
		expect(files_sort_compare({ a: key({ sort, name: "a" }), b: key({ sort, name: "b" }), sort })).toBe(1);
	});

	test("keeps single file.created equal-time ties", () => {
		const sort: files_sort_Sort = [{ field: "created", direction: "desc" }];
		expect(files_sort_compare({ a: key({ sort, name: "a" }), b: key({ sort, name: "b" }), sort })).toBe(0);
	});
});

describe("files_sort_key_of", () => {
	const facts = { kind: "file" as const, name: "File2.10", createdAt: 1, updatedAt: 2, extension: "10", contentByteSize: 0 };

	test("keeps raw file.extension and exact index suffixes", () => {
		expect(files_sort_key_of({ sort: [{ field: "extension", direction: "asc" }], facts, metadataParts: new Map() })).toEqual(
			{
				parts: [["10", "file012.0210", "File2.10"]],
				nameKey: ["file012.0210", "File2.10"],
			},
		);
		expect(
			files_sort_key_of({ sort: [{ field: "created", direction: "asc" }], facts, metadataParts: new Map() }).parts,
		).toEqual([[1]]);
		expect(
			files_sort_key_of({ sort: [{ field: "size", direction: "desc" }], facts, metadataParts: new Map() }).parts,
		).toEqual([[0, "file012.0210", "File2.10"]]);
		expect(
			files_sort_key_of({
				sort: [{ field: "metadata.x", direction: "desc" }],
				facts,
				metadataParts: new Map([["metadata.x", "a0210"]]),
			}).parts,
		).toEqual([["a0210", "file012.0210", "File2.10"]]);
	});

	test("keeps folder file.extension and file.size missing", () => {
		for (const field of ["extension", "size"]) {
			expect(
				files_sort_key_of({
					sort: [{ field, direction: "desc" }],
					facts: { ...facts, kind: "folder" },
					metadataParts: new Map(),
				}).parts,
			).toEqual([null]);
		}
	});

	test("raw numeric and accented extensions agree with the index in both directions", () => {
		for (const direction of ["asc", "desc"] as const) {
			const sort: files_sort_Sort = [{ field: "extension", direction }];
			const make = (extension: string) =>
				files_sort_key_of({ sort, facts: { ...facts, name: `a.${extension}`, extension }, metadataParts: new Map() });
			expect(files_sort_compare({ a: make("10"), b: make("2"), sort })).toBe(direction === "asc" ? -1 : 1);
			expect(Math.sign(files_sort_compare({ a: make("é"), b: make("e"), sort }))).toBe(direction === "asc" ? 1 : -1);
		}
	});
});

describe("files_sort_is_valid", () => {
	test("accepts one valid field", () => {
		expect(files_sort_is_valid([{ field: "name", direction: "asc" }])).toBe(true);
		expect(files_sort_is_valid([{ field: "metadata.x", direction: "desc" }])).toBe(true);
	});

	test("refuses empty, more than one clause, and invalid fields", () => {
		for (const sort of [
			[],
			[
				{ field: "metadata.x", direction: "desc" as const },
				{ field: "name", direction: "asc" as const },
			],
			[{ field: "bad", direction: "asc" as const }],
			[{ field: "type", direction: "asc" as const }],
		]) {
			expect(files_sort_is_valid(sort)).toBe(false);
		}
	});
});
