import { describe, expect, test } from "vitest";
import { pagination_fan_out_paginate } from "./pagination.ts";

/**
 * Pages through an array with a numeric string cursor, honoring `numItems`,
 * mimicking a paginated indexed query.
 */
async function run_array_page(pageArgs: { source: string[]; innerCursor: string | null; numItems: number }) {
	const start = pageArgs.innerCursor == null ? 0 : Number(pageArgs.innerCursor);
	const items = pageArgs.source.slice(start, start + pageArgs.numItems);
	const end = start + items.length;
	return { items, continueCursor: String(end), isDone: end >= pageArgs.source.length };
}

describe("pagination_fan_out_paginate", () => {
	test("concatenates sources in order and finishes when everything fits one page", async () => {
		const result = await pagination_fan_out_paginate({
			scope: "test",
			sources: [
				{ key: "a", fingerprint: "1", source: ["a1", "a2"] },
				{ key: "b", fingerprint: "1", source: ["b1"] },
			],
			cursor: null,
			limit: 10,
			runPage: run_array_page,
		});
		if (result._nay) throw new Error("expected _yay");
		expect(result._yay).toEqual({ items: ["a1", "a2", "b1"], continueCursor: null, isDone: true });
	});

	test("returns a mid-source continuation cursor and resumes from it", async () => {
		const sources = [
			{ key: "a", fingerprint: "1", source: ["a1", "a2", "a3"] },
			{ key: "b", fingerprint: "1", source: ["b1", "b2", "b3"] },
		];
		const page1 = await pagination_fan_out_paginate({
			scope: "test",
			sources,
			cursor: null,
			limit: 4,
			runPage: run_array_page,
		});
		if (page1._nay) throw new Error("expected _yay");
		expect(page1._yay.items).toEqual(["a1", "a2", "a3", "b1"]);
		expect(page1._yay.isDone).toBe(false);

		const page2 = await pagination_fan_out_paginate({
			scope: "test",
			sources,
			cursor: page1._yay.continueCursor,
			limit: 4,
			runPage: run_array_page,
		});
		if (page2._nay) throw new Error("expected _yay");
		expect(page2._yay).toEqual({ items: ["b2", "b3"], continueCursor: null, isDone: true });
	});

	test("filling the limit at a source boundary resumes the next source fresh", async () => {
		const sources = [
			{ key: "a", fingerprint: "1", source: ["a1", "a2"] },
			{ key: "b", fingerprint: "1", source: ["b1"] },
		];
		const page1 = await pagination_fan_out_paginate({
			scope: "test",
			sources,
			cursor: null,
			limit: 2,
			runPage: run_array_page,
		});
		if (page1._nay) throw new Error("expected _yay");
		expect(page1._yay.items).toEqual(["a1", "a2"]);
		expect(page1._yay.isDone).toBe(false);

		const page2 = await pagination_fan_out_paginate({
			scope: "test",
			sources,
			cursor: page1._yay.continueCursor,
			limit: 2,
			runPage: run_array_page,
		});
		if (page2._nay) throw new Error("expected _yay");
		expect(page2._yay).toEqual({ items: ["b1"], continueCursor: null, isDone: true });
	});

	test("rejects malformed cursors and cursors from another scope", async () => {
		const sources = [{ key: "a", fingerprint: "1", source: ["a1", "a2"] }];
		const malformed = await pagination_fan_out_paginate({
			scope: "test",
			sources,
			cursor: "not a fan-out cursor",
			limit: 1,
			runPage: run_array_page,
		});
		expect(malformed._nay?.message).toBe("invalid cursor");

		const otherScopePage = await pagination_fan_out_paginate({
			scope: "other",
			sources,
			cursor: null,
			limit: 1,
			runPage: run_array_page,
		});
		if (otherScopePage._nay) throw new Error("expected _yay");
		const crossScope = await pagination_fan_out_paginate({
			scope: "test",
			sources,
			cursor: otherScopePage._yay.continueCursor,
			limit: 1,
			runPage: run_array_page,
		});
		expect(crossScope._nay?.message).toBe("invalid cursor");
	});

	test("rejects cursors when the source listing changed", async () => {
		const page1 = await pagination_fan_out_paginate({
			scope: "test",
			sources: [{ key: "a", fingerprint: "1", source: ["a1", "a2"] }],
			cursor: null,
			limit: 1,
			runPage: run_array_page,
		});
		if (page1._nay) throw new Error("expected _yay");

		const upgraded = await pagination_fan_out_paginate({
			scope: "test",
			sources: [{ key: "a", fingerprint: "2", source: ["a1", "a2"] }],
			cursor: page1._yay.continueCursor,
			limit: 1,
			runPage: run_array_page,
		});
		expect(upgraded._nay?.message).toBe("listing changed");
	});

	test("caps runPage calls per invocation and returns a continuation", async () => {
		let calls = 0;
		const result = await pagination_fan_out_paginate({
			scope: "test",
			sources: [{ key: "a", fingerprint: "1", source: null }],
			cursor: null,
			limit: 10,
			// Simulates an inner query whose scan budget keeps expiring before
			// it finds anything, which would otherwise loop forever.
			runPage: async () => {
				calls++;
				return { items: [], continueCursor: String(calls), isDone: false };
			},
		});
		if (result._nay) throw new Error("expected _yay");
		expect(calls).toBe(32);
		expect(result._yay.items).toEqual([]);
		expect(result._yay.isDone).toBe(false);
		const cursor = JSON.parse(String(result._yay.continueCursor)) as { sourceKey: string; innerCursor: string };
		expect(cursor.sourceKey).toBe("a");
		expect(cursor.innerCursor).toBe("32");
	});
});
