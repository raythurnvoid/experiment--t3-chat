import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../convex/_generated/api.js";
import { test_convex, test_mocks_fill_db_with } from "../convex/setup.test.ts";
import {
	files_pending_review_facts_db_get_state,
	files_pending_review_facts_db_pin_structure,
} from "./files-pending-review-facts.ts";

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

async function fixture() {
	const t = test_convex();
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const create_folder = async (path: string) => {
		const created = await asOwner.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: "root",
			path,
		});
		if (created._nay) throw new Error(created._nay.message);
	};
	const state = () => t.run((ctx) => files_pending_review_facts_db_get_state(ctx.db, db));
	const pin = () => t.run((ctx) => files_pending_review_facts_db_pin_structure(ctx.db, db));
	return { create_folder, state, pin };
}

describe("files_pending_review_facts_db_pin_structure", () => {
	test("a saved create with no live pin writes no fact state", async () => {
		const f = await fixture();
		await f.create_folder("first");
		expect(await f.state()).toBeNull();
	});

	test("a saved create during a live pin advances the revision", async () => {
		const f = await fixture();
		const pinned = await f.pin();
		await f.create_folder("first");
		expect((await f.state())?.structureRevision).toBe(pinned.structureRevision + 1);
	});

	test.each([
		{ name: "after a lapse", elapsedMs: 10 * 60 * 1000, advances: true },
		{ name: "within the skew margin", elapsedMs: 10 * 60 * 1000 - 30 * 1000, advances: true },
		{ name: "in the second half of a live pin", elapsedMs: 6 * 60 * 1000, advances: false },
	])("a pin $name moves the revision: $advances", async ({ elapsedMs, advances }) => {
		const f = await fixture();
		const pinned = await f.pin();
		vi.setSystemTime(Date.now() + elapsedMs);
		const renewed = await f.pin();
		expect(renewed.structureRevision).toBe(pinned.structureRevision + (advances ? 1 : 0));
		expect(renewed).toMatchObject({ structurePinnedUntil: Date.now() + 10 * 60 * 1000 });
	});
});
