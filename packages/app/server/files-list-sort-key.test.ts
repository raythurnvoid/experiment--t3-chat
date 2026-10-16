import { describe, expect, test } from "vitest";
import { compareValues } from "convex/values";
import {
	files_sort_compare,
	files_sort_key_of,
	type files_sort_RowKey,
	type files_sort_Sort,
} from "../shared/files-sort.ts";
import { files_list_sort_key_encode } from "./files-list-sort-key.ts";

type Row = { key: files_sort_RowKey; createdAt: number; nodeId: string };

function compare(a: Row, b: Row, sort: files_sort_Sort) {
	const primary = files_sort_compare({ a: a.key, b: b.key, sort });
	const direction = a.key.parts[0] === null || sort[0]!.direction === "asc" ? 1 : -1;
	return primary || direction * compareValues([a.createdAt, a.nodeId], [b.createdAt, b.nodeId]);
}

function sign(value: number) {
	return value === 0 ? 0 : Math.sign(value);
}

describe("files_list_sort_key_encode", () => {
	const names = [
		"a",
		"A",
		"a\0",
		"a\0b",
		"file2",
		"file002",
		"file10",
		"é",
		"e\u0301",
		"\uE000",
		"😀",
		"𐀀",
		"z".repeat(300),
	];
	for (const field of ["name", "created", "updated", "extension", "size", "metadata.rank"]) {
		for (const direction of ["asc", "desc"] as const) {
			test(`${field} ${direction} matches the app comparator and stable ties`, () => {
				const sort: files_sort_Sort = [{ field, direction }];
				const rows: Row[] = names.flatMap((name, index) =>
					[0, 1].map((tie) => ({
						key: files_sort_key_of({
							sort,
							facts: {
								kind: index % 5 === 0 ? "folder" : "file",
								name,
								createdAt: index % 3,
								updatedAt: index % 4,
								extension: index % 3 === 0 ? null : ["md", "txt", "😀"][index % 3]!,
								contentByteSize: index % 3 === 0 ? null : index % 4,
							},
							metadataParts: new Map([["metadata.rank", index % 4 === 0 ? null : ["2", "10", "é", "😀"][index % 4]!]]),
						}),
						createdAt: index % 3,
						nodeId: `${tie}:${index}`,
					})),
				);
				for (const a of rows) {
					for (const b of rows) {
						expect(
							sign(
								compareValues(files_list_sort_key_encode({ ...a, sort }), files_list_sort_key_encode({ ...b, sort })),
							),
							"Encoded bytes must preserve the app comparator and stable ties",
						).toBe(sign(compare(a, b, sort)));
					}
				}
			});
		}
	}

	test("keeps Convex numeric order and signed zero in both directions", () => {
		const values = [
			-Infinity,
			-Number.MAX_VALUE,
			-1,
			-Number.MIN_VALUE,
			-0,
			0,
			Number.MIN_VALUE,
			1,
			Number.MAX_VALUE,
			Infinity,
		];
		for (const direction of ["asc", "desc"] as const) {
			const sort: files_sort_Sort = [{ field: "size", direction }];
			for (const a of values) {
				for (const b of values) {
					const left: Row = { key: { parts: [[a]], nameKey: ["same", "same"] }, createdAt: 0, nodeId: "same" };
					const right: Row = { ...left, key: { ...left.key, parts: [[b]] } };
					expect(
						sign(
							compareValues(
								files_list_sort_key_encode({ ...left, sort }),
								files_list_sort_key_encode({ ...right, sort }),
							),
						),
					).toBe(sign(compare(left, right, sort)));
				}
			}
		}
	});

	test("uses original creation time before opposite node IDs", () => {
		for (const direction of ["asc", "desc"] as const) {
			const sort: files_sort_Sort = [{ field: "name", direction }];
			const a: Row = { key: { parts: [["same", "same"]], nameKey: ["same", "same"] }, createdAt: 1, nodeId: "z" };
			const b: Row = { ...a, createdAt: 2, nodeId: "a" };
			expect(
				sign(compareValues(files_list_sort_key_encode({ ...a, sort }), files_list_sort_key_encode({ ...b, sort }))),
				"Original creation time must precede the node ID tie",
			).toBe(sign(compare(a, b, sort)));
		}
	});

	test("keeps tuple ends distinct from zero bytes and empty values", () => {
		const sort: files_sort_Sort = [{ field: "name", direction: "asc" }];
		const parts: Array<Array<string | number | null>> = [
			[],
			[null],
			[0],
			[0, ""],
			[""],
			["", ""],
			["a"],
			["a\0"],
			["a", "b"],
		];
		const rows: Row[] = parts.map((part, index) => ({
			key: { parts: [part], nameKey: ["same", "same"] },
			createdAt: 0,
			nodeId: String(index),
		}));
		for (const a of rows) {
			for (const b of rows) {
				expect(
					sign(compareValues(files_list_sort_key_encode({ ...a, sort }), files_list_sort_key_encode({ ...b, sort }))),
				).toBe(sign(compare(a, b, sort)));
			}
		}
	});

	test("keeps large full keys ordered without expanding them into arguments", () => {
		const prefix = "x\0".repeat(128 * 1024);
		for (const direction of ["asc", "desc"] as const) {
			const sort: files_sort_Sort = [{ field: "name", direction }];
			const a: Row = { key: { parts: [[`${prefix}a`]], nameKey: ["same", "same"] }, createdAt: 1, nodeId: "z" };
			const b: Row = { ...a, key: { ...a.key, parts: [[`${prefix}b`]] } };
			expect(
				sign(compareValues(files_list_sort_key_encode({ ...a, sort }), files_list_sort_key_encode({ ...b, sort }))),
			).toBe(sign(compare(a, b, sort)));
		}
	});

	test("refuses NaN and leaves source keys unchanged", () => {
		const sort: files_sort_Sort = [{ field: "size", direction: "desc" }];
		const row: Row = { key: { parts: [[42]], nameKey: ["same", "same"] }, createdAt: 1, nodeId: "a" };
		const before = structuredClone(row);
		files_list_sort_key_encode({ ...row, sort });
		expect(row).toEqual(before);
		expect(() => files_list_sort_key_encode({ ...row, key: { ...row.key, parts: [[NaN]] }, sort })).toThrow(RangeError);
	});
});
