import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { internal } from "./_generated/api.js";
import { mock_nodes_content_storage } from "./files_nodes_content.setup.test.ts";
import { test_create_saved_placement_fixture } from "../server/files-saved-placement.test-fixtures.ts";
import { files_content_heads_db_wrap } from "../server/files-content-heads.ts";

beforeEach(() => {
	vi.useFakeTimers();
	mock_nodes_content_storage();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

test("owner backfill preserves source rows and maps cleanup work once", async () => {
	const f = await test_create_saved_placement_fixture({ transactionLimits: true });
	const initial = await f.t.run(async (ctx) => {
		const head = await ctx.db.get("files_saved_content_heads", f.saved.contentHeadId!);
		if (!head || !f.saved.assetId || !f.saved.yjsLastSequenceId) throw new Error("Expected a saved live document");
		expect(head.yjsContentHeadId, "legacy writers name their own live owner").toBe(head._id);
		await ctx.db.patch("files_saved_content_heads", head._id, { yjsContentHeadId: undefined });
		const taskId = await ctx.db.insert("files_yjs_cleanup_tasks", {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			fileNodeId: f.nodeId,
			throughSequence: 0,
			supersededYjsAssetId: f.saved.assetId,
			putMayArriveUntil: null,
			historyPending: true,
		});
		const waiterId = await ctx.db.insert("files_move_waiters", {
			cohortId: f.cohortId,
			createdAt: Date.now(),
			worker: {
				kind: "content_cleanup",
				id: f.saved.yjsLastSequenceId,
				nodeId: f.nodeId,
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				throughSequence: 0,
			},
		});
		return {
			head,
			taskId,
			waiterId,
			exact: await ctx.db.query("files_text_chunks").collect(),
			updates: await ctx.db.query("files_yjs_updates").collect(),
			snapshots: await ctx.db.query("files_snapshots").collect(),
		};
	});
	const args = { oneBatchOnly: true, cursor: null, batchSize: 100, dryRun: false };
	await f.t.mutation(internal.migrations.backfill_saved_content_yjs_owner, args);
	await f.t.mutation(internal.migrations.backfill_yjs_cleanup_owner, args);
	await f.t.mutation(internal.migrations.backfill_yjs_waiter_owner, args);
	const read = () =>
		f.t.run(async (ctx) => ({
			head: await ctx.db.get("files_saved_content_heads", initial.head._id),
			task: await ctx.db.get("files_yjs_cleanup_tasks", initial.taskId),
			waiter: await ctx.db.get("files_move_waiters", initial.waiterId),
			exact: await ctx.db.query("files_text_chunks").collect(),
			updates: await ctx.db.query("files_yjs_updates").collect(),
			snapshots: await ctx.db.query("files_snapshots").collect(),
		}));
	const after = await read();
	expect(after.head?.yjsContentHeadId, "backfill keeps the original live log owner").toBe(initial.head._id);
	expect(after.head, "backfill changes no other source header field").toEqual(initial.head);
	expect(after.task?.logOwnerId, "old cleanup keeps its source owner").toBe(initial.head._id);
	expect(after.waiter?.worker).toMatchObject({ logOwnerId: initial.head._id });
	expect(after.exact).toEqual(initial.exact);
	expect(after.updates).toEqual(initial.updates);
	expect(after.snapshots).toEqual(initial.snapshots);
	await f.t.mutation(internal.migrations.backfill_saved_content_yjs_owner, args);
	await f.t.mutation(internal.migrations.backfill_yjs_cleanup_owner, args);
	await f.t.mutation(internal.migrations.backfill_yjs_waiter_owner, args);
	expect(await read(), "a repeated backfill is unchanged").toEqual(after);
	expect(
		await f.t.query(internal.migrations.audit_saved_content_yjs_owners, {
			paginationOpts: { cursor: null, numItems: 100 },
		}),
	).toMatchObject({ isDone: true, missing: [], invalid: [] });
	for (const table of ["tasks", "waiters"] as const)
		expect(
			await f.t.query(internal.migrations.audit_yjs_cleanup_owners, {
				table,
				paginationOpts: { cursor: null, numItems: 100 },
			}),
		).toMatchObject({ isDone: true, missing: [] });
});

test("new legacy cleanup writes keep the owner and missing files keep their accepted wake", async () => {
	const f = await test_create_saved_placement_fixture({ transactionLimits: true });
	const ids = await f.t.run(async (raw) => {
		const ctx = { ...raw, ...files_content_heads_db_wrap(raw) };
		const taskId = await ctx.db.insert("files_yjs_cleanup_tasks", {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			fileNodeId: f.nodeId,
			throughSequence: 0,
			supersededYjsAssetId: f.saved.assetId!,
			putMayArriveUntil: null,
			historyPending: true,
		});
		const waiterId = await ctx.db.insert("files_move_waiters", {
			cohortId: f.cohortId,
			createdAt: Date.now(),
			worker: {
				kind: "content_cleanup",
				id: f.saved.yjsLastSequenceId!,
				nodeId: f.nodeId,
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				throughSequence: 0,
			},
		});
		expect((await raw.db.get("files_yjs_cleanup_tasks", taskId))?.logOwnerId).toBe(f.saved.contentHeadId);
		expect((await raw.db.get("files_move_waiters", waiterId))?.worker).toMatchObject({
			logOwnerId: f.saved.contentHeadId,
		});
		const waiter = (await raw.db.get("files_move_waiters", waiterId))!;
		if (waiter.worker.kind !== "content_cleanup") throw new Error("Expected cleanup work");
		await raw.db.patch("files_move_waiters", waiterId, { worker: { ...waiter.worker, logOwnerId: undefined } });
		await raw.db.patch("files_yjs_cleanup_tasks", taskId, { logOwnerId: undefined });
		await raw.db.delete("files_nodes", f.nodeId);
		return { taskId, waiterId };
	});
	const args = { oneBatchOnly: true, cursor: null, batchSize: 100, dryRun: false };
	await f.t.mutation(internal.migrations.backfill_yjs_cleanup_owner, args);
	await f.t.mutation(internal.migrations.backfill_yjs_waiter_owner, args);
	await f.t.run(async (ctx) => {
		expect(await ctx.db.get("files_yjs_cleanup_tasks", ids.taskId)).toMatchObject({
			logOwnerId: null,
			historyPending: false,
		});
		expect(
			await ctx.db.get("files_move_waiters", ids.waiterId),
			"missing-file work still waits for normal settlement",
		).not.toBeNull();
		const scheduled = await ctx.db.system.query("_scheduled_functions").collect();
		expect(
			scheduled.some((job) => job.name === "files_move_cohorts:wake_waiters" && job.state.kind === "pending"),
		).toBe(true);
	});
	expect(
		await f.t.query(internal.migrations.audit_yjs_cleanup_owners, {
			table: "waiters",
			paginationOpts: { cursor: null, numItems: 100 },
		}),
		"strict cutover stays blocked until the old waiter has settled",
	).toMatchObject({ missing: [ids.waiterId] });
});
