import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { test_create_saved_text_file, test_move_nodes } from "./setup.test.ts";
import { files_subtree_ops_STEP_MAX_NODES } from "./files_subtree_ops.ts";
import {
	fixture,
	mock_share_storage,
	reset_rate_limits,
	seed_big_folder,
	type Fixture,
} from "./files_share_links.setup.test.ts";

// Fake timers keep scheduled op steps from running, so a test can look at a folder while its op runs.
beforeEach(mock_share_storage);

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

function get_node(f: Fixture, nodeId: Id<"files_nodes">) {
	return f.t.run(async (ctx) => (await ctx.db.get("files_nodes", nodeId))!);
}

/** Make the folder at `path` with one file in it, and return the folder id. */
async function seed_folder(f: Fixture, path: string) {
	const fileId = await test_create_saved_text_file(f.t, { membershipId: f.db.membershipId, path: `${path}/x.md` });
	return (await get_node(f, fileId)).parentId as Id<"files_nodes">;
}

async function set_restricted(f: Fixture, nodeId: Id<"files_nodes">, restricted: boolean) {
	await reset_rate_limits(f.t, [f.db.userId]);
	const result = await f.asOwner.mutation(
		restricted ? api.files_sharing.restrict_node : api.files_sharing.unrestrict_node,
		{ membershipId: f.db.membershipId, nodeId },
	);
	expect(result._nay).toBeUndefined();
}

test("restricting a folder in an open folder stores an explicit null parent scope", async () => {
	const f = await fixture();
	const folderId = await seed_folder(f, "/a");

	await set_restricted(f, folderId, true);

	const root = await get_node(f, folderId);
	expect(root.parentScopeNodeId).toBe(null);
	// The small folder's op ends in the same call.
	expect(root.scopeOpId).toBeUndefined();
});

test("restricting a folder inside a restricted folder points at that folder", async () => {
	const f = await fixture();
	const outerId = await seed_folder(f, "/a");
	const innerId = await seed_folder(f, "/a/b");

	await set_restricted(f, outerId, true);
	await set_restricted(f, innerId, true);

	expect((await get_node(f, innerId)).parentScopeNodeId).toBe(outerId);
});

test("unrestrict keeps the boundary until the job ends, then removes it", async () => {
	const f = await fixture();
	const { folderId } = await seed_big_folder(f, files_subtree_ops_STEP_MAX_NODES + 1);
	await set_restricted(f, folderId, true);
	await f.t.finishAllScheduledFunctions(vi.runAllTimers);

	await set_restricted(f, folderId, false);

	// The walk still has to find this former root while its op runs.
	const running = await get_node(f, folderId);
	expect(running.isRestrictedScopeRoot).toBe(false);
	expect(running.parentScopeNodeId).toBe(null);
	expect(running.scopeOpId).toBeDefined();

	await f.t.finishAllScheduledFunctions(vi.runAllTimers);
	const done = await get_node(f, folderId);
	expect(done.parentScopeNodeId).toBeUndefined();
	expect(done.scopeOpId).toBeUndefined();
});

test("a second running op on the same root keeps the boundary until the newer op ends", async () => {
	const f = await fixture();
	const { folderId } = await seed_big_folder(f, files_subtree_ops_STEP_MAX_NODES + 1);
	await set_restricted(f, folderId, true);
	const firstOpId = (await get_node(f, folderId)).scopeOpId!;
	expect(firstOpId).toBeDefined();

	await set_restricted(f, folderId, false);
	const secondOpId = (await get_node(f, folderId)).scopeOpId!;
	expect(secondOpId).not.toBe(firstOpId);

	// Run only the first op to its end. Its end must not remove the boundary of the newer op.
	for (let step = 0; step < 10; step++) {
		const walk = await f.t.run((ctx) =>
			ctx.db
				.query("files_subtree_op_walks")
				.filter((q) => q.eq(q.field("opId"), firstOpId))
				.first(),
		);
		if (!walk) break;
		await f.t.mutation(internal.files_subtree_ops.advance, { opId: firstOpId, step: walk.step });
	}
	expect(await f.t.run((ctx) => ctx.db.get("files_subtree_ops", firstOpId))).toBeNull();
	const afterFirst = await get_node(f, folderId);
	expect(afterFirst.parentScopeNodeId).toBe(null);
	expect(afterFirst.scopeOpId).toBe(secondOpId);

	await f.t.finishAllScheduledFunctions(vi.runAllTimers);
	const done = await get_node(f, folderId);
	expect(done.parentScopeNodeId).toBeUndefined();
	expect(done.scopeOpId).toBeUndefined();
});

test("unrestricting a file removes its boundary at once", async () => {
	const f = await fixture();
	await set_restricted(f, f.nodeId, true);
	expect((await get_node(f, f.nodeId)).parentScopeNodeId).toBe(null);

	// A file gets no op, so nothing would remove the field later.
	await set_restricted(f, f.nodeId, false);

	const file = await get_node(f, f.nodeId);
	expect(file.parentScopeNodeId).toBeUndefined();
	expect(file.scopeOpId).toBeUndefined();
});

test("moving a restricted folder into another restricted folder updates its parent scope", async () => {
	const f = await fixture();
	const targetId = await seed_folder(f, "/a");
	const movedId = await seed_folder(f, "/b");
	await set_restricted(f, targetId, true);
	await set_restricted(f, movedId, true);
	expect((await get_node(f, movedId)).parentScopeNodeId).toBe(null);

	await reset_rate_limits(f.t, [f.db.userId]);
	const moved = await test_move_nodes(f.t, f.asOwner, {
		membershipId: f.db.membershipId,
		itemIds: [movedId],
		targetParentId: targetId,
	});
	expect(moved._nay).toBeUndefined();

	const node = await get_node(f, movedId);
	expect(node.parentId).toBe(targetId);
	expect(node.parentScopeNodeId).toBe(targetId);
});

test("moving a file into a folder whose unrestrict op runs keeps that folder's boundary", async () => {
	const f = await fixture();
	const { folderId } = await seed_big_folder(f, files_subtree_ops_STEP_MAX_NODES + 1);
	await set_restricted(f, folderId, true);
	await f.t.finishAllScheduledFunctions(vi.runAllTimers);
	await set_restricted(f, folderId, false);
	const opId = (await get_node(f, folderId)).scopeOpId!;

	// A real Move waits for running scope ops, so in production the unrestrict happens during the Move.
	// The test helper runs every running op first, so park this one to get the same state.
	await f.t.run((ctx) => ctx.db.patch("files_subtree_ops", opId, { status: "queued" }));
	await reset_rate_limits(f.t, [f.db.userId]);
	const moved = await test_move_nodes(f.t, f.asOwner, {
		membershipId: f.db.membershipId,
		itemIds: [f.nodeId],
		targetParentId: folderId,
	});
	expect(moved._nay).toBeUndefined();
	expect((await get_node(f, f.nodeId)).parentId).toBe(folderId);

	// The Move does not rewrite the folder's children, so the folder stays a boundary while its op runs.
	const folder = await get_node(f, folderId);
	expect(folder.parentScopeNodeId).toBe(null);
	expect(folder.scopeOpId).toBe(opId);

	await f.t.run((ctx) => ctx.db.patch("files_subtree_ops", opId, { status: "running" }));
	await f.t.finishAllScheduledFunctions(vi.runAllTimers);
	expect((await get_node(f, folderId)).parentScopeNodeId).toBeUndefined();
});

test("restoring a restricted folder points at the area where it lands", async () => {
	const f = await fixture();
	const parentId = await seed_folder(f, "/p");
	const childId = await seed_folder(f, "/p/r");
	await set_restricted(f, parentId, true);
	await set_restricted(f, childId, true);
	expect((await get_node(f, childId)).parentScopeNodeId).toBe(parentId);

	// Archive the child first, so it can come back alone. Its parent stays archived, so it lands at the top.
	for (const nodeId of [childId, parentId]) {
		await reset_rate_limits(f.t, [f.db.userId]);
		const archived = await f.asOwner.mutation(api.files_nodes.archive_nodes, {
			membershipId: f.db.membershipId,
			nodeIds: [String(nodeId)],
		});
		expect(archived._nay).toBeUndefined();
		await f.t.finishAllScheduledFunctions(vi.runAllTimers);
	}

	await reset_rate_limits(f.t, [f.db.userId]);
	const restored = await f.asOwner.mutation(api.files_nodes.unarchive_nodes, {
		membershipId: f.db.membershipId,
		nodeIds: [String(childId)],
	});
	expect(restored._nay).toBeUndefined();
	await f.t.finishAllScheduledFunctions(vi.runAllTimers);

	const node = await get_node(f, childId);
	expect(node.archiveOperationId).toBe(null);
	expect(node.parentId).toBe("root");
	expect(node.parentScopeNodeId).toBe(null);
});

test("the boundary index lists only the restricted folders directly inside a scope", async () => {
	const f = await fixture();
	const aId = await seed_folder(f, "/a");
	const bId = await seed_folder(f, "/a/b");
	const cId = await seed_folder(f, "/a/b/c");
	// An open folder inside a restricted one is not a boundary.
	await seed_folder(f, "/a/open");
	for (const nodeId of [aId, bId, cId]) await set_restricted(f, nodeId, true);

	const inside = (parentScopeNodeId: Id<"files_nodes"> | null) =>
		f.t.run(async (ctx) =>
			(
				await ctx.db
					.query("files_nodes")
					.withIndex("by_org_ws_parentScope_archive_treePath", (q) =>
						q
							.eq("organizationId", f.db.organizationId)
							.eq("workspaceId", f.db.workspaceId)
							.eq("moveCohortId", undefined)
							.eq("parentScopeNodeId", parentScopeNodeId)
							.eq("archiveOperationId", null),
					)
					.collect()
			).map((node) => node._id),
		);
	expect(await inside(null)).toEqual([aId]);
	expect(await inside(aId)).toEqual([bId]);
	expect(await inside(bId)).toEqual([cId]);
	expect(await inside(cId)).toEqual([]);
});

test("a tree read does not return parentScopeNodeId or scopeOpId", async () => {
	const f = await fixture();
	const { folderId } = await seed_big_folder(f, files_subtree_ops_STEP_MAX_NODES + 1);
	await set_restricted(f, folderId, true);
	// The op still runs, so the doc has both fields.
	const stored = await get_node(f, folderId);
	expect(stored.parentScopeNodeId).toBe(null);
	expect(stored.scopeOpId).toBeDefined();

	const read = await f.asOwner.query(api.files_tree.get_file_node_for_membership, {
		membershipId: f.db.membershipId,
		fileNodeId: String(folderId),
	});
	expect(read?._id).toBe(folderId);
	expect(read).not.toHaveProperty("parentScopeNodeId");
	expect(read).not.toHaveProperty("scopeOpId");
});
