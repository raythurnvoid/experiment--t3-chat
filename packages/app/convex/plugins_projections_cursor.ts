import { compareValues } from "convex/values";

/**
 * Inclusive change-feed fence for `plugins_data` `updatedAt` scans.
 *
 * The store query uses `gte("updatedAt", cursor.updatedAt)`. Same-millisecond writes share one
 * `Date.now()` and Convex orders those ties by `_id`, not by `key`. Skipping by key, or advancing
 * with `newest + 1`, would drop or duplicate docs. Keep the last applied `_id` and skip only docs
 * that are still on that millisecond with `_id <= lastId`.
 */
export type plugins_ProjectionCursor = {
	updatedAt: number;
	lastId: string;
};

export type plugins_ProjectionChangeDoc = {
	_id: string;
	updatedAt: number;
};

/**
 * Drop docs this cursor has already applied. Keep later milliseconds, and later `_id`s on the
 * same millisecond.
 */
export function plugins_projections_skip_already_applied<T extends plugins_ProjectionChangeDoc>(
	docs: T[],
	cursor: plugins_ProjectionCursor | null,
): T[] {
	if (cursor === null) {
		return docs;
	}

	return docs.filter((doc) => {
		if (doc.updatedAt !== cursor.updatedAt) {
			return doc.updatedAt > cursor.updatedAt;
		}

		return compareValues(doc._id, cursor.lastId) > 0;
	});
}

/**
 * Advance to the last doc that was applied. An empty page keeps the previous cursor so a later
 * retry does not restart the collection.
 */
export function plugins_projections_next_cursor<T extends plugins_ProjectionChangeDoc>(
	lastApplied: T | null,
	previous: plugins_ProjectionCursor | null,
): plugins_ProjectionCursor | null {
	if (lastApplied === null) {
		return previous;
	}

	return { updatedAt: lastApplied.updatedAt, lastId: lastApplied._id };
}

/**
 * How many extra docs a change page must read past `limit`.
 *
 * One store write batch is at most 50 documents and they share one `Date.now()`. Reading 50 extra
 * docs means a same-millisecond group the cursor already applied cannot fill the page and hide the
 * next documents — including the page-size-1 case used in tests.
 */
export const plugins_PROJECTION_CHANGE_TIE_EXTRA = 50;

if (process.env.NODE_ENV === "test" && import.meta.vitest) {
	const { describe, expect, test } = import.meta.vitest;

	describe("plugins_projections_skip_already_applied", () => {
		test("keeps every doc when the cursor is empty", () => {
			const docs = [
				{ _id: "b", updatedAt: 10 },
				{ _id: "a", updatedAt: 10 },
			];
			expect(plugins_projections_skip_already_applied(docs, null)).toEqual(docs);
		});

		test("keeps a later millisecond and a later id on the same millisecond", () => {
			const cursor = { updatedAt: 10, lastId: "a" };
			const docs = [
				{ _id: "a", updatedAt: 10 },
				{ _id: "b", updatedAt: 10 },
				{ _id: "c", updatedAt: 11 },
			];
			expect(plugins_projections_skip_already_applied(docs, cursor)).toEqual([
				{ _id: "b", updatedAt: 10 },
				{ _id: "c", updatedAt: 11 },
			]);
		});

		test("does not skip by key: a later key with an earlier _id on the same millisecond is already applied", () => {
			const cursor = { updatedAt: 10, lastId: "m" };
			const docs = [
				{ _id: "k", updatedAt: 10, key: "z-later-key" },
				{ _id: "m", updatedAt: 10, key: "a-earlier-key" },
				{ _id: "n", updatedAt: 10, key: "b-mid-key" },
			];
			expect(plugins_projections_skip_already_applied(docs, cursor)).toEqual([
				{ _id: "n", updatedAt: 10, key: "b-mid-key" },
			]);
		});
	});

	describe("plugins_projections_next_cursor", () => {
		test("stores the last applied id, not newest plus one", () => {
			expect(
				plugins_projections_next_cursor({ _id: "a", updatedAt: 10 }, null),
			).toEqual({ updatedAt: 10, lastId: "a" });
		});

		test("keeps the previous cursor when nothing was applied", () => {
			const previous = { updatedAt: 10, lastId: "a" };
			expect(plugins_projections_next_cursor(null, previous)).toEqual(previous);
		});
	});
}
