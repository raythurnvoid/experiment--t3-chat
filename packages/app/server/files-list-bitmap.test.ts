import { describe, expect, test } from "vitest";
import {
	files_list_bitmap_decode,
	files_list_bitmap_encode,
	files_list_bitmap_from_offsets,
	files_list_bitmap_offsets,
} from "./files-list-bitmap.ts";

describe("files_list_bitmap_encode", () => {
	test.each([1, 64, 511, 512, 8192])("bitmap keeps all %i members through its stored format", (count) => {
		const offsets = Array.from({ length: count }, (_, index) => index);
		const container = files_list_bitmap_from_offsets(offsets);
		expect(container.kind).toBe(count < 512 ? "sparse" : "dense");
		const encoded = files_list_bitmap_encode(container);
		expect(encoded.byteLength).toBe(3 + (count < 512 ? 2 * count : 1024));
		const decoded = files_list_bitmap_decode(encoded, 0);
		expect(decoded.bytesRead).toBe(encoded.byteLength);
		expect(files_list_bitmap_offsets(decoded.container)).toEqual(offsets);
	});

	test("sparse offsets and count use the exact big-endian wire order", () => {
		const encoded = files_list_bitmap_encode(files_list_bitmap_from_offsets([8191, 1, 256]));
		expect([...new Uint8Array(encoded)]).toEqual([0, 0, 3, 0, 1, 1, 0, 31, 255]);
	});

	test("dense offsets keep their original bit positions", () => {
		const offsets = [...Array.from({ length: 511 }, (_, index) => index), 8191];
		const encoded = files_list_bitmap_encode(files_list_bitmap_from_offsets(offsets));
		const bytes = new Uint8Array(encoded);
		expect([...bytes.slice(0, 3)]).toEqual([1, 2, 0]);
		expect(bytes[3 + 63], "Dense offsets use the original bit positions").toBe(127);
		expect(bytes[3 + 1023], "The highest offset uses the last byte's high bit").toBe(128);
		expect(files_list_bitmap_offsets(files_list_bitmap_decode(encoded, 0).container)).toEqual(offsets);
	});

	test("packed decode stops at the exact container end", () => {
		const first = files_list_bitmap_encode(files_list_bitmap_from_offsets([0, 8191]));
		const second = files_list_bitmap_encode(files_list_bitmap_from_offsets([2, 4, 8]));
		const page = new Uint8Array(5 + first.byteLength + second.byteLength + 2);
		page.fill(170);
		page.set(new Uint8Array(first), 5);
		page.set(new Uint8Array(second), 5 + first.byteLength);
		const a = files_list_bitmap_decode(page.buffer, 5);
		const b = files_list_bitmap_decode(page.buffer, 5 + a.bytesRead);
		expect(files_list_bitmap_offsets(a.container)).toEqual([0, 8191]);
		expect(files_list_bitmap_offsets(b.container)).toEqual([2, 4, 8]);
		expect(5 + a.bytesRead + b.bytesRead).toBe(page.byteLength - 2);
	});

	test("container conversion keeps input and retained page bytes unchanged", () => {
		const input = [8, 0, 7];
		const sparse = files_list_bitmap_from_offsets(input);
		expect(input).toEqual([8, 0, 7]);
		const offsets = files_list_bitmap_offsets(sparse);
		offsets[0] = 100;
		expect(files_list_bitmap_offsets(sparse)).toEqual([0, 7, 8]);

		const dense = files_list_bitmap_from_offsets(Array.from({ length: 512 }, (_, index) => index));
		const stored = files_list_bitmap_encode(dense);
		const before = [...new Uint8Array(stored)];
		const decoded = files_list_bitmap_decode(stored, 0).container;
		if (decoded.kind !== "dense" || dense.kind !== "dense") throw new Error("Expected a dense block");
		new Uint8Array(decoded.bytes)[0] = 0;
		expect([...new Uint8Array(stored)], "Decoded blocks must not change retained page bytes").toEqual(before);
		new Uint8Array(dense.bytes)[0] = 0;
		expect([...new Uint8Array(stored)]).toEqual(before);
	});

	test("refuses a missing sparse array value", () => {
		expect(() => files_list_bitmap_encode({ kind: "sparse", offsets: new Array<number>(1) })).toThrow(RangeError);
	});
});

describe("files_list_bitmap_from_offsets", () => {
	test.each([[], [1, 1], [-1], [8192], [1.5], [NaN], [Infinity]].map((offsets) => ({ offsets })))(
		"refuses invalid block offsets $offsets",
		({ offsets }) => {
			expect(() => files_list_bitmap_from_offsets(offsets)).toThrow(RangeError);
		},
	);
});

describe("files_list_bitmap_decode", () => {
	test.each(
		[
			[0, 0, 0],
			[2, 0, 1, 0, 1],
			[0, 0, 2, 0, 1],
			[0, 0, 2, 0, 1, 0, 1],
			[0, 0, 2, 0, 2, 0, 1],
			[0, 0, 1, 32, 0],
			[1, 2, 0],
		].map((input) => ({ input })),
	)("refuses invalid stored container $input", ({ input }) => {
		expect(() => files_list_bitmap_decode(new Uint8Array(input).buffer, 0)).toThrow(RangeError);
	});

	test("refuses a dense header whose count differs from its bits", () => {
		const encoded = files_list_bitmap_encode(
			files_list_bitmap_from_offsets(Array.from({ length: 512 }, (_, index) => index)),
		);
		new Uint8Array(encoded)[3] = 0;
		expect(() => files_list_bitmap_decode(encoded, 0)).toThrow("Invalid dense list bitmap");
	});

	test("refuses a noncanonical sparse or dense encoding", () => {
		const sparse = new ArrayBuffer(3 + 512 * 2);
		const view = new DataView(sparse);
		view.setUint16(1, 512);
		expect(() => files_list_bitmap_decode(sparse, 0)).toThrow("Invalid sparse list bitmap");

		const dense = new ArrayBuffer(1027);
		new Uint8Array(dense)[0] = 1;
		new DataView(dense).setUint16(1, 511);
		expect(() => files_list_bitmap_decode(dense, 0)).toThrow("Invalid dense list bitmap");
		expect(() =>
			files_list_bitmap_encode({ kind: "sparse", offsets: Array.from({ length: 512 }, (_, index) => index) }),
		).toThrow(RangeError);
		expect(() => files_list_bitmap_encode({ kind: "dense", bytes: new ArrayBuffer(1024), count: 512 })).toThrow(
			RangeError,
		);
	});

	test.each([-1, 0.5, 1, NaN])("refuses an invalid header position %s", (offset) => {
		expect(() => files_list_bitmap_decode(new ArrayBuffer(3), offset)).toThrow(RangeError);
	});
});
