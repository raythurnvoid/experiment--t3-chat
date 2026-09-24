import { compareValues } from "convex/values";
import { describe, expect, test } from "vitest";

import type { files_metadata_Value } from "./files-metadata.ts";
import {
	files_sort_compare,
	files_sort_field_is_valid,
	files_sort_text_key,
	files_sort_value_of,
} from "./files-sort.ts";

const sort_names = (names: string[]) =>
	[...names].sort((a, b) => files_sort_compare([files_sort_text_key(a), a], [files_sort_text_key(b), b], "asc"));

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
	test("orders numbers before strings and null before numbers, like an index", () => {
		expect(files_sort_compare([null, "a"], [1, "a"], "asc")).toBe(-1);
		expect(files_sort_compare([1, "a"], ["0", "a"], "asc")).toBe(-1);
	});

	test("reverses the whole tuple when descending", () => {
		expect(files_sort_compare(["a", "x"], ["a", "y"], "desc")).toBe(1);
		expect(files_sort_compare(["b"], ["a"], "desc")).toBe(-1);
	});
});
