import { compareValues } from "convex/values";

/**
 * Inclusive change-feed fence for `plugins_data` `updatedAt` scans.
 *
 * The store query uses `gte("updatedAt", cursor.updatedAt)`. Same-millisecond writes share one
 * `Date.now()`, and Convex orders those index ties by the appended `_creationTime` then `_id`.
 * `_id` is random, so comparing ids alone would skip a doc created after the fence whose id
 * happens to sort before it. Keep the applied doc's `(creationTime, id)` pair and skip only docs
 * at or before that pair on the fence millisecond.
 *
 * `lastCreationTime` is optional because the field arrived on populated cursor records. A cursor
 * without it keeps every tied doc, which re-marks channels dirty once — idempotent, never lossy.
 *
 * A patch to an existing key can still sort behind a same-millisecond fence because it keeps its
 * original `_creationTime`. Every accepted projected store mutation therefore also writes the exact
 * dirty channel in its own transaction. This merged feed remains the bounded recovery path for
 * older data and interrupted projection state.
 */
export type plugins_ProjectionCursor = {
	updatedAt: number;
	lastCreationTime?: number;
	lastId: string;
};

export type plugins_ProjectionChangeDoc = {
	_id: string;
	_creationTime: number;
	updatedAt: number;
};

/**
 * Drop docs this cursor has already applied. Keep later milliseconds, and later
 * `(creationTime, id)` pairs on the same millisecond.
 */
export function plugins_projections_skip_already_applied<T extends plugins_ProjectionChangeDoc>(
	docs: T[],
	cursor: plugins_ProjectionCursor | null,
): T[] {
	if (cursor === null) {
		return docs;
	}

	const lastCreationTime = cursor.lastCreationTime;
	return docs.filter((doc) => {
		if (doc.updatedAt !== cursor.updatedAt) {
			return doc.updatedAt > cursor.updatedAt;
		}

		// Old cursor shape without a creation time: re-apply the tied docs instead of guessing.
		if (lastCreationTime === undefined) {
			return true;
		}

		if (doc._creationTime !== lastCreationTime) {
			return doc._creationTime > lastCreationTime;
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

	return { updatedAt: lastApplied.updatedAt, lastCreationTime: lastApplied._creationTime, lastId: lastApplied._id };
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
				{ _id: "b", _creationTime: 1, updatedAt: 10 },
				{ _id: "a", _creationTime: 2, updatedAt: 10 },
			];
			expect(plugins_projections_skip_already_applied(docs, null)).toEqual(docs);
		});

		test("keeps a later millisecond and a later creation on the same millisecond", () => {
			const cursor = { updatedAt: 10, lastCreationTime: 100, lastId: "a" };
			const docs = [
				{ _id: "a", _creationTime: 100, updatedAt: 10 },
				{ _id: "b", _creationTime: 101, updatedAt: 10 },
				{ _id: "c", _creationTime: 102, updatedAt: 11 },
			];
			expect(plugins_projections_skip_already_applied(docs, cursor)).toEqual([
				{ _id: "b", _creationTime: 101, updatedAt: 10 },
				{ _id: "c", _creationTime: 102, updatedAt: 11 },
			]);
		});

		test("does not skip by key: a later key created before the fence is already applied", () => {
			const cursor = { updatedAt: 10, lastCreationTime: 100, lastId: "m" };
			const docs = [
				{ _id: "k", _creationTime: 90, updatedAt: 10, key: "z-later-key" },
				{ _id: "m", _creationTime: 100, updatedAt: 10, key: "a-earlier-key" },
				{ _id: "n", _creationTime: 110, updatedAt: 10, key: "b-mid-key" },
			];
			expect(plugins_projections_skip_already_applied(docs, cursor)).toEqual([
				{ _id: "n", _creationTime: 110, updatedAt: 10, key: "b-mid-key" },
			]);
		});

		test("re-applies ties for an old cursor that has no creation time", () => {
			const cursor = { updatedAt: 10, lastId: "m" };
			const docs = [
				{ _id: "m", _creationTime: 100, updatedAt: 10 },
				{ _id: "n", _creationTime: 110, updatedAt: 10 },
				{ _id: "b", _creationTime: 50, updatedAt: 9 },
			];
			expect(plugins_projections_skip_already_applied(docs, cursor)).toEqual([
				{ _id: "m", _creationTime: 100, updatedAt: 10 },
				{ _id: "n", _creationTime: 110, updatedAt: 10 },
			]);
		});

		test("breaks a creation-time tie by id: only a greater id passes the fence", () => {
			// Convex `_creationTime` values can collide, and the index then orders by `_id`. On a
			// full tie only the id decides which side of the fence a doc is on.
			const cursor = { updatedAt: 10, lastCreationTime: 100, lastId: "m" };
			const docs = [
				{ _id: "a", _creationTime: 100, updatedAt: 10 },
				{ _id: "m", _creationTime: 100, updatedAt: 10 },
				{ _id: "z", _creationTime: 100, updatedAt: 10 },
			];
			expect(plugins_projections_skip_already_applied(docs, cursor)).toEqual([
				{ _id: "z", _creationTime: 100, updatedAt: 10 },
			]);
		});

		test("keeps a later-created doc whose random id sorts before the fence id", () => {
			// Index ties on `updatedAt` order by `_creationTime`, and `_id` is random. A doc
			// created after the fence doc can carry a smaller id, and skipping it loses a change.
			const cursor = { updatedAt: 10, lastCreationTime: 100, lastId: "z" };
			const docs = [
				{ _id: "z", _creationTime: 100, updatedAt: 10 },
				{ _id: "a", _creationTime: 101, updatedAt: 10 },
			];
			expect(plugins_projections_skip_already_applied(docs, cursor)).toEqual([
				{ _id: "a", _creationTime: 101, updatedAt: 10 },
			]);
		});
	});

	describe("plugins_projections_next_cursor", () => {
		test("stores the last applied creation time and id, not newest plus one", () => {
			expect(plugins_projections_next_cursor({ _id: "a", _creationTime: 100, updatedAt: 10 }, null)).toEqual({
				updatedAt: 10,
				lastCreationTime: 100,
				lastId: "a",
			});
		});

		test("keeps the previous cursor when nothing was applied", () => {
			const previous = { updatedAt: 10, lastId: "a" };
			expect(plugins_projections_next_cursor(null, previous)).toEqual(previous);
		});
	});
}
