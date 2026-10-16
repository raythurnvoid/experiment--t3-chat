import { describe, expect, test } from "vitest";
import { files_list_bitmap_from_offsets, files_list_bitmap_offsets } from "./files-list-bitmap.ts";
import { files_list_set_block_combine } from "./files-list-set-block.ts";

describe("files_list_set_block_combine", () => {
	const cases = [
		{ name: "both empty", left: [], right: [] },
		{ name: "left empty", left: [], right: [0, 8191] },
		{ name: "right empty", left: [0, 8191], right: [] },
		{ name: "sparse overlap", left: [0, 7, 8191], right: [0, 8, 8191] },
		{ name: "sparse disjoint", left: [0, 2, 8190], right: [1, 3, 8191] },
		{ name: "dense and sparse", left: Array.from({ length: 512 }, (_, index) => index), right: [0, 511, 8191] },
		{ name: "sparse and dense", left: [0, 511, 8191], right: Array.from({ length: 512 }, (_, index) => index) },
		{
			name: "dense overlap",
			left: Array.from({ length: 1024 }, (_, index) => index),
			right: Array.from({ length: 1024 }, (_, index) => index + 512),
		},
		{
			name: "full block",
			left: Array.from({ length: 8192 }, (_, index) => index),
			right: Array.from({ length: 512 }, (_, index) => index * 2),
		},
	];

	for (const operation of ["union", "intersection", "difference"] as const) {
		test.each(cases)(`${operation} keeps exact IDs for $name`, ({ left, right }) => {
			const a = new Set(left);
			const b = new Set(right);
			const expected = [...new Set([...left, ...right])]
				.filter((id) =>
					operation === "union"
						? a.has(id) || b.has(id)
						: operation === "intersection"
							? a.has(id) && b.has(id)
							: a.has(id) && !b.has(id),
				)
				.sort((a, b) => a - b);
			const result = files_list_set_block_combine({
				left: left.length === 0 ? null : files_list_bitmap_from_offsets(left),
				right: right.length === 0 ? null : files_list_bitmap_from_offsets(right),
				operation,
			});
			expect(result === null ? [] : files_list_bitmap_offsets(result)).toEqual(expected);
			if (expected.length !== 0) expect(result?.kind).toBe(expected.length < 512 ? "sparse" : "dense");
		});
	}

	test("an equal count is not an exact human and service intersection", () => {
		const result = files_list_set_block_combine({
			left: files_list_bitmap_from_offsets([1, 3]),
			right: files_list_bitmap_from_offsets([2, 4]),
			operation: "intersection",
		});
		expect(result, "Disjoint human and service IDs must produce no eligible block").toBeNull();
	});

	test("union promotes at 512 members and difference returns to sparse", () => {
		const first = files_list_bitmap_from_offsets(Array.from({ length: 256 }, (_, index) => index));
		const second = files_list_bitmap_from_offsets(Array.from({ length: 256 }, (_, index) => index + 256));
		const union = files_list_set_block_combine({ left: first, right: second, operation: "union" });
		expect(union?.kind).toBe("dense");
		const difference = files_list_set_block_combine({ left: union, right: second, operation: "difference" });
		expect(difference?.kind).toBe("sparse");
		expect(files_list_bitmap_offsets(difference!)).toEqual(files_list_bitmap_offsets(first));
	});

	test("keeps both inputs and returned blocks separate", () => {
		const left = files_list_bitmap_from_offsets(Array.from({ length: 512 }, (_, index) => index));
		const right = files_list_bitmap_from_offsets([0, 8191]);
		const beforeLeft = files_list_bitmap_offsets(left);
		const beforeRight = files_list_bitmap_offsets(right);
		const result = files_list_set_block_combine({ left, right, operation: "union" });
		if (result?.kind !== "dense") throw new Error("Expected a dense block");
		new Uint8Array(result.bytes).fill(0);
		expect(files_list_bitmap_offsets(left)).toEqual(beforeLeft);
		expect(files_list_bitmap_offsets(right)).toEqual(beforeRight);
	});
});
