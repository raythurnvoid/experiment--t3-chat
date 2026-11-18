import { afterEach, expect, test, vi } from "vitest";
import { test_create_saved_placement_fixture } from "../server/files-saved-placement.test-fixtures.ts";
import { internal } from "./_generated/api.js";
import { test_mocks_fill_db_with } from "./setup.test.ts";
import { mock_transfer_storage } from "./files_transfer.setup.test.ts";

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

test("stripping slot counters twice preserves work, files, history and native cursors", async () => {
	mock_transfer_storage();
	const f = await test_create_saved_placement_fixture();
	const { t, db, nodeId, cohortId } = f;
	const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId };
	const { slotId, idleId, indexSlotId, archiveId, indexIds } = await t.run(async (ctx) => {
		const slot = await ctx.db
			.query("files_move_workspace_slots")
			.withIndex("by_workspace", (q) =>
				q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId),
			)
			.unique();
		if (!slot?.cohortId) throw new Error("Expected the active Move slot");
		await ctx.db.patch("files_move_workspace_slots", slot._id, { generation: 9 });
		await ctx.db.patch("files_move_cohorts", cohortId, { slotGeneration: 9 });
		const archiveId = await ctx.db.insert("files_archive_runs", {
			...scope,
			userId: db.userId,
			kind: "restore",
			force: false,
			archiveOperationId: "archive",
			rootNodeIds: [nodeId],
			restoreRoots: [{ nodeId, treePath: "/old.txt" }],
			phase: "apply",
			checkCursor: { rootIndex: 1, treePath: "" },
			discoverTreePaths: [],
			applyRootIndex: 1,
			active: true,
			skipOperationId: null,
			conflict: null,
			choice: null,
			applyToRemaining: { file: null, folder: null },
			revision: 7,
			requestFirstRunId: null,
			checkNamedItem: null,
			refusedItems: [],
			ending: {
				status: "failed",
				errorMessage: "Source changed",
				errorCode: "failed",
				rootIndex: 1,
				cursor: "saved-position",
				generation: 17,
			},
		});
		const indexTenant = await test_mocks_fill_db_with.membership(ctx, { organizationName: "index-tenant" });
		const idleTenant = await test_mocks_fill_db_with.membership(ctx, { organizationName: "idle-tenant" });
		const idleId = await ctx.db.insert("files_move_workspace_slots", {
			organizationId: idleTenant.organizationId,
			workspaceId: idleTenant.workspaceId,
			cohortId: null,
			generation: 11,
			placementGeneration: 5,
		});
		const indexIds = [];
		for (const old of [{ slotGeneration: null }, { slotGeneration: 0 }, { slotGeneration: 3, admitted: false }]) {
			indexIds.push(
				await ctx.db.insert("files_index_runs", {
					organizationId: indexTenant.organizationId,
					workspaceId: indexTenant.workspaceId,
					fileNodeId: nodeId,
					contentHeadId: null,
					previousHeadId: null,
					indexRevision: 4,
					contentRevision: 3,
					chunkCount: 7,
					textKind: "rich_text",
					phase: "cleanup_candidates",
					cursor: "index-position",
					nextPosition: 6,
					step: 8,
					generation: 22,
					nextAttemptAt: 1,
					scheduledId: null,
					published: false,
					aborting: true,
					error: null,
					placement: {
						parentId: "root",
						kind: "file",
						name: "old.txt",
						sortName: "old.txt",
						path: "/old.txt",
						treePath: "/old.txt",
						archiveOperationId: null,
						restrictedScopeNodeId: null,
						isRestrictedScopeRoot: false,
					},
					...old,
				}),
			);
		}
		const indexSlotId = await ctx.db.insert("files_move_workspace_slots", {
			organizationId: indexTenant.organizationId,
			workspaceId: indexTenant.workspaceId,
			cohortId: null,
			indexRunId: indexIds[1]!,
			visibleView: "before",
			migrationDirection: "to_normal",
			generation: 8,
			placementGeneration: 3,
		});
		return { slotId: slot._id, idleId, indexSlotId, archiveId, indexIds };
	});
	const snapshot = () =>
		t.run(async (ctx) => ({
			slots: await Promise.all(
				[slotId, idleId, indexSlotId].map(async (id) => (await ctx.db.get("files_move_workspace_slots", id))!),
			),
			move: (await ctx.db.get("files_move_cohorts", cohortId))!,
			restore: (await ctx.db.get("files_archive_runs", archiveId))!,
			index: await Promise.all(indexIds.map(async (id) => (await ctx.db.get("files_index_runs", id))!)),
			files: await ctx.db.query("files_nodes").collect(),
			activities: await ctx.db.query("activities").collect(),
			copyItems: await ctx.db.query("files_transfer_items").collect(),
		}));
	const before = await snapshot();
	for (let pass = 0; pass < 2; pass++) {
		for (const migrate of [
			internal.migrations.backfill_index_admitted,
			internal.migrations.strip_move_slot_generation,
			internal.migrations.strip_archive_ending_generation,
			internal.migrations.strip_files_slot_generations,
		]) {
			let cursor: string | null = null;
			for (;;) {
				const page: { continueCursor: string; isDone: boolean } = await t.run(async (ctx) => {
					const before = await ctx.meta.getTransactionMetrics();
					const result = await ctx.runMutation(migrate, { cursor, batchSize: 2, oneBatchOnly: true, dryRun: false });
					const after = await ctx.meta.getTransactionMetrics();
					if (pass === 1) expect(after.documentsWritten.used).toBe(before.documentsWritten.used);
					return result;
				});
				if (page.isDone) break;
				cursor = page.continueCursor;
			}
		}
		const { slotGeneration: _moveGeneration, ...move } = before.move;
		const { generation: _endingGeneration, ...ending } = before.restore.ending!;
		expect(await snapshot()).toEqual({
			...before,
			slots: before.slots.map((slot) => {
				const { generation: _old, ...fields } = slot;
				if ("placementGeneration" in fields) delete fields.placementGeneration;
				return fields;
			}),
			move,
			restore: { ...before.restore, ending },
			index: before.index.map(({ slotGeneration, ...run }) => ({
				...run,
				admitted: run.admitted ?? slotGeneration != null,
			})),
		});
	}
});
