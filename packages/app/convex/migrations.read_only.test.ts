import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Workpool } from "@convex-dev/workpool";
import { omit } from "convex-helpers";
import type { WithoutSystemFields } from "convex/server";
import { api, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { test_convex, test_mocks, test_mocks_fill_db_with } from "./setup.test.ts";
import { files_tree_db_get_public_node_fields } from "./files_tree_db.ts";
import { files_nodes_db_copied_from_policy_fields } from "./files_write_policy_db.ts";

const batch = { oneBatchOnly: true, dryRun: false, cursor: null, batchSize: 25 } as const;

beforeEach(() => {
	vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("migration-test" as never);
});
afterEach(() => vi.restoreAllMocks());

test("backfill preserves rows and gives each old rule one stable decision", async () => {
	const t = test_convex({ transactionLimits: true });
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const policies: Doc<"files_nodes">["writePolicy"][] = [
		null,
		{ mode: "read_only" },
		{ mode: "writer", writers: [{ kind: "user", userId: db.userId }] },
	];
	const ids = await t.run(async (ctx) => {
		const result = [];
		for (const [index, writePolicy] of policies.entries())
			result.push(await ctx.db.insert("files_nodes", {
				...test_mocks.files.base(), organizationId: db.organizationId, workspaceId: db.workspaceId,
				createdBy: db.userId, updatedBy: db.userId, parentId: "root", name: `item-${index}`,
				path: `/item-${index}`, treePath: `/item-${index}/`, writePolicy,
				archiveOperationId: index === 1 ? "old-archive" : null,
			}));
		return result;
	});
	const before = await t.run(async (ctx) => Promise.all(ids.map((id) => ctx.db.get("files_nodes", id))));
	await t.mutation(internal.migrations.backfill_read_only_nodes, batch);
	const after = await t.run(async (ctx) => Promise.all(ids.map((id) => ctx.db.get("files_nodes", id))));
	expect(after[0]).toMatchObject({ readOnly: false, readOnlyDecisionId: null });
	for (const row of after.slice(1)) {
		expect(row?.readOnly).toBe(true);
		expect(row?.readOnlyDecisionId).toEqual(expect.any(String));
	}
	expect(after[1]?.readOnlyDecisionId).not.toBe(after[2]?.readOnlyDecisionId);
	expect(after.map((row) => omit(row!, ["readOnly", "readOnlyDecisionId"]))).toEqual(before);
	await t.mutation(internal.migrations.backfill_read_only_nodes, batch);
	expect(await t.run(async (ctx) => Promise.all(ids.map((id) => ctx.db.get("files_nodes", id))))).toEqual(after);
});

test("preview rolls back an actual patch and returns only counts", async () => {
	const t = test_convex();
	const db = await t.run((ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const id = db.files.file_root_1._id;
	const before = await t.run((ctx) => ctx.db.get("files_nodes", id));
	await expect(t.mutation(internal.migrations.preview_read_only, {
		migration: "nodes", cursor: null, batchSize: 25,
	})).rejects.toThrow("READ_ONLY_PREVIEW");
	expect(await t.run((ctx) => ctx.db.get("files_nodes", id))).toEqual(before);
	await t.mutation(internal.migrations.backfill_read_only_nodes, batch);
	expect(await t.run((ctx) => ctx.db.get("files_nodes", id))).toMatchObject({
		readOnly: false, readOnlyDecisionId: null,
	});
});

test("backfill rejects a partial decision pair without replacing it", async () => {
	const t = test_convex();
	const db = await t.run((ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const id = db.files.file_root_1._id;
	await t.run((ctx) => ctx.db.patch("files_nodes", id, { readOnly: false }));
	await expect(t.mutation(internal.migrations.backfill_read_only_nodes, batch))
		.rejects.toThrow("does not match the old rule");
	expect(await t.run((ctx) => ctx.db.get("files_nodes", id))).toMatchObject({ readOnly: false });
	expect((await t.run((ctx) => ctx.db.get("files_nodes", id)))?.readOnlyDecisionId).toBeUndefined();
});

test("old create and policy setters dual-write while public node fields stay old", async () => {
	const t = test_convex();
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const created = await asUser.mutation(api.files_nodes.create_folder_node, {
		membershipId: db.membershipId, parentId: "root", path: "bridge",
	});
	if (created._nay) throw new Error(created._nay.message);
	const id = created._yay.nodeId;
	const read = () => t.run((ctx) => ctx.db.get("files_nodes", id));
	expect(await read()).toMatchObject({ writePolicy: null, readOnly: false, readOnlyDecisionId: null });
	const set = (writePolicy: Doc<"files_nodes">["writePolicy"]) => asUser.mutation(api.files_nodes.set_node_write_policy, {
		membershipId: db.membershipId, nodeId: id, writePolicy,
	});
	expect((await set({ mode: "read_only" }))._nay).toBeUndefined();
	const first = await read();
	expect(first?.readOnly).toBe(true);
	expect(first?.readOnlyDecisionId).toEqual(expect.any(String));
	expect((await set({ mode: "writer", writers: [{ kind: "user", userId: db.userId }] }))._nay).toBeUndefined();
	expect((await read())?.readOnlyDecisionId).toBe(first?.readOnlyDecisionId);
	expect((await set(null))._nay).toBeUndefined();
	expect(await read()).toMatchObject({ readOnly: false, readOnlyDecisionId: null });
	expect((await set({ mode: "read_only" }))._nay).toBeUndefined();
	expect((await read())?.readOnlyDecisionId).not.toBe(first?.readOnlyDecisionId);
	const visible = files_tree_db_get_public_node_fields((await read())!, "read_only");
	expect(visible).toHaveProperty("writePolicyState", "read_only");
	expect(visible).not.toHaveProperty("readOnly");
	expect(visible).not.toHaveProperty("readOnlyDecisionId");
});

test("copy capture preserves the first old source rule", () => {
	expect(files_nodes_db_copied_from_policy_fields({
		prev: { sourceWritePolicy: null }, sourceWritePolicy: { mode: "read_only" },
	})).toEqual({ sourceWritePolicy: null, sourceReadOnly: false });
	expect(files_nodes_db_copied_from_policy_fields({ sourceWritePolicy: { mode: "read_only" } }))
		.toEqual({ sourceWritePolicy: { mode: "read_only" }, sourceReadOnly: true });
	expect(files_nodes_db_copied_from_policy_fields({})).toEqual({});
});

test("draft and captured headers retain content and missing source snapshots", async () => {
	const t = test_convex();
	const db = await t.run((ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const target = { kind: "saved" as const, id: db.files.file_root_1._id };
	const header: WithoutSystemFields<Doc<"files_pending_updates">> = {
		organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId,
		target, revision: 4, size: 0, updatedAt: 100, expiresAt: 200,
		pendingArchive: { fromPath: "/old-place" },
		copiedFrom: { target, path: "/source", sourceWritePolicy: { mode: "read_only" } },
	};
	const ids = await t.run(async (ctx) => {
		const proposal = await ctx.db.insert("files_pending_updates", header);
		const unknown = await ctx.db.insert("files_pending_updates", {
			...header, copiedFrom: { target, path: "/unknown" },
		});
		const review = await ctx.db.insert("files_pending_update_run_items", {
			runId: "999999files_pending_update_runs" as Id<"files_pending_update_runs">, order: 0, pendingUpdateId: proposal,
			reviewedRevision: 4, reviewHeader: omit(header, ["updatedAt", "expiresAt", "threadIds", "indexRevision", "moveCohortId"]),
			reviewSource: null, selectedContentStateId: null, planKind: null, privateVersion: null,
			target, unitId: null, billedUserId: null, prepared: null, expectedPath: "/old-place",
			expectedDestinationParentPath: null,
		});
		const cohort = await ctx.db.insert("files_move_cohort_items", {
			cohortId: "999999files_move_cohorts" as Id<"files_move_cohorts">, order: 0,
			origin: { kind: "review", itemId: review }, target, pendingUpdateId: proposal,
			reviewedRevision: 4, selectedContentStateId: null, privateVersion: null,
			nodeRecordId: "999999files_move_cohort_nodes" as Id<"files_move_cohort_nodes">, afterProposal: header,
			contentId: null, replacementItemId: null, status: "materialized", validatedEpoch: 1, billingState: "sent",
		});
		const receipt = await ctx.db.insert("files_pending_node_publish_receipts", {
			organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId,
			privateNodeId: "999999files_pending_nodes" as Id<"files_pending_nodes">, creationGeneration: 1,
			structuralRevision: 2, proposalRevision: 4, savedNodeId: target.id,
			copiedWritePolicy: { mode: "read_only" }, copiedPath: "/old-place", createdAt: 100,
		});
		return { proposal, unknown, review, cohort, receipt };
	});
	const receiptBefore = await t.run((ctx) => ctx.db.get("files_pending_node_publish_receipts", ids.receipt));
	for (const fn of [
		internal.migrations.backfill_read_only_pending,
		internal.migrations.backfill_read_only_cohort_items,
		internal.migrations.backfill_read_only_review_items,
	]) await t.mutation(fn, batch);
	await t.run(async (ctx) => {
		expect(await ctx.db.get("files_pending_updates", ids.proposal)).toMatchObject({
			...header, copiedFrom: { ...header.copiedFrom, sourceReadOnly: true },
		});
		expect((await ctx.db.get("files_pending_updates", ids.unknown))?.copiedFrom).toEqual({ target, path: "/unknown" });
		expect((await ctx.db.get("files_move_cohort_items", ids.cohort))?.afterProposal?.copiedFrom?.sourceReadOnly).toBe(true);
		expect((await ctx.db.get("files_pending_update_run_items", ids.review))?.reviewHeader?.copiedFrom?.sourceReadOnly).toBe(true);
		expect(await ctx.db.get("files_pending_node_publish_receipts", ids.receipt)).toEqual(receiptBefore);
	});
});

test("old plain stages keep unknown intent and service receipts keep their hash", async () => {
	const t = test_convex();
	const db = await t.run((ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const ids = await t.run(async (ctx) => {
		const stage = await ctx.db.insert("public_api_file_write_stages", {
			organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId,
			path: "/pending", overwrite: "fail", contentType: "text/plain", yjsRootKind: "plain_text",
			yjsSnapshotAssetId: "999998files_r2_assets" as Id<"files_r2_assets">,
			contentSnapshotAssetId: "999999files_r2_assets" as Id<"files_r2_assets">, expiresAt: 200, updatedAt: 100,
		});
		const target = await ctx.db.insert("plugin_service_storage_targets", {
			organizationId: db.organizationId, workspaceId: db.workspaceId,
			installationId: "999999plugins_workspace_installations" as Id<"plugins_workspace_installations">,
			idempotencyKey: "same-key", targetKey: "same-target", requestFingerprint: "unchanged-hash",
			readOnly: true, nonCollaborative: true, destinationPath: "/", destinationNodeId: db.files.file_root_1._id,
			destinationEpoch: 1, path: "/file", contentType: "text/plain", declaredBytes: 10, actualBytes: 10,
			chargedBytes: 10, nodeId: db.files.file_root_1_child_1._id, assetId: "999999files_r2_assets" as Id<"files_r2_assets">,
			state: "committed", createdBy: db.userId, updatedAt: 100,
		});
		return { stage, target };
	});
	const before = await t.run((ctx) => ctx.db.get("plugin_service_storage_targets", ids.target));
	await t.mutation(internal.migrations.backfill_read_only_write_stages, batch);
	await t.mutation(internal.migrations.backfill_read_only_service_targets, batch);
	const stage = await t.run((ctx) => ctx.db.get("public_api_file_write_stages", ids.stage));
	expect(stage?.force).toBe(false);
	expect(stage?.requestReadOnly).toBeUndefined();
	const target = await t.run((ctx) => ctx.db.get("plugin_service_storage_targets", ids.target));
	expect(target?.force).toBe(false);
	expect(omit(target!, ["force"])).toEqual(before);
	await t.run((ctx) => ctx.db.patch("plugin_service_storage_targets", ids.target, { force: true }));
	await expect(t.mutation(internal.migrations.backfill_read_only_service_targets, batch))
		.rejects.toThrow("cannot gain force");
});

test("job histories gain only their default mode and keep retry hashes", async () => {
	const t = test_convex();
	const db = await t.run((ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId };
	const ids = await t.run(async (ctx) => {
		const transfer = await ctx.db.insert("files_transfer_runs", {
			...scope, userId: db.userId,
			sourceScope: { ...scope, membershipId: db.membershipId, membershipLifetime: 1 },
			destinationScope: { ...scope, membershipId: db.membershipId, membershipLifetime: 1 },
			requestId: "old-request", requestHash: "exact-old-hash", kind: "copy",
			sourceView: "saved", publication: "saved", origin: { kind: "clipboard" },
			targetParent: { kind: "root" }, targetPath: "/", targetName: null, missingParentNames: [],
			preparedParent: null, fixedDeadline: false, conflictPolicy: { file: "ask", folder: "ask" },
			step: "apply", planCursor: null, reserveCursor: null, retryOf: null, retryCursor: null,
			revision: 0, inFlight: 0, applyToRemaining: { file: null, folder: null },
		});
		const archive = await ctx.db.insert("files_archive_runs", {
			...scope, userId: db.userId, kind: "restore", archiveOperationId: "old-operation",
			rootNodeIds: [], phase: "apply", checkCursor: { rootIndex: 0, treePath: "" },
			discoverTreePaths: [], applyRootIndex: 0, active: false, skipOperationId: null, conflict: null,
			choice: null, applyToRemaining: { file: null, folder: null }, revision: 1,
			requestFirstRunId: null, checkNamedItem: null, refusedItems: [],
		});
		const restoreItem = await ctx.db.insert("files_archive_run_items", {
			runId: archive, order: 0, path: "/old", newPath: "/new",
		});
		const bulk = await ctx.db.insert("files_write_policy_runs", {
			...scope, userId: db.userId, folderId: db.files.file_root_1._id,
			folderTreePath: db.files.file_root_1.treePath,
			writePolicy: { mode: "read_only" }, cursor: null,
		});
		return { transfer, archive, restoreItem, bulk };
	});
	const before = await t.run(async (ctx) => ({
		transfer: await ctx.db.get("files_transfer_runs", ids.transfer),
		archive: await ctx.db.get("files_archive_runs", ids.archive),
		restoreItem: await ctx.db.get("files_archive_run_items", ids.restoreItem),
		bulk: await ctx.db.get("files_write_policy_runs", ids.bulk),
	}));
	for (const fn of [
		internal.migrations.backfill_read_only_transfers, internal.migrations.backfill_read_only_archives,
		internal.migrations.backfill_read_only_restore_items, internal.migrations.backfill_read_only_bulk_runs,
	]) await t.mutation(fn, batch);
	await t.run(async (ctx) => {
		expect(await ctx.db.get("files_transfer_runs", ids.transfer)).toEqual({ ...before.transfer, force: false });
		expect(await ctx.db.get("files_archive_runs", ids.archive)).toEqual({ ...before.archive, force: false });
		expect(await ctx.db.get("files_archive_run_items", ids.restoreItem)).toEqual({ ...before.restoreItem, kind: "restore" });
		expect(await ctx.db.get("files_write_policy_runs", ids.bulk)).toEqual({ ...before.bulk, targetReadOnly: true });
	});
});

test("stage backfill uses the recorded external intent and leaves the receipt fields unchanged", async () => {
	const t = test_convex();
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const externalFileWrite = {
		writerId: "999999plugins_external_file_writers" as Id<"plugins_external_file_writers">,
		writerGeneration: 2, operationId: "same-operation", sequence: 8, contentHash: "same-hash",
		expectedNodeId: null, expectedContentRevision: null, expectedReaderRevision: null,
		serviceSecretHash: "same-secret-hash", tokenHash: "same-token-hash",
		contentType: "text/plain", nonCollaborative: true, requestReadOnly: true,
	};
	const id = await t.run((ctx) => ctx.db.insert("public_api_file_write_stages", {
		organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId,
		path: "/pending", overwrite: "fail", contentType: "text/plain", yjsRootKind: "plain_text",
		yjsSnapshotAssetId: "999998files_r2_assets" as Id<"files_r2_assets">,
		contentSnapshotAssetId: "999999files_r2_assets" as Id<"files_r2_assets">,
		expiresAt: 200, updatedAt: 100, externalFileWrite,
	}));
	await t.mutation(internal.migrations.backfill_read_only_write_stages, batch);
	const after = await t.run((ctx) => ctx.db.get("public_api_file_write_stages", id));
	expect(after).toMatchObject({
		force: false, requestReadOnly: true, externalFileWrite: { ...externalFileWrite, force: false },
	});
	await t.mutation(internal.migrations.backfill_read_only_write_stages, batch);
	expect(await t.run((ctx) => ctx.db.get("public_api_file_write_stages", id))).toEqual(after);
});

test("node migration resumes its native cursor across full batches", async () => {
	const t = test_convex({ transactionLimits: true });
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const ids = await t.run(async (ctx) => {
		const result = [];
		for (let index = 0; index < 27; index++)
			result.push(await ctx.db.insert("files_nodes", {
				...test_mocks.files.base(), organizationId: db.organizationId, workspaceId: db.workspaceId,
				createdBy: db.userId, updatedBy: db.userId, parentId: "root",
				name: `item-${index}`, path: `/item-${index}`, treePath: `/item-${index}/`,
				writePolicy: { mode: "read_only" },
			}));
		return result;
	});
	let cursor: string | null = null;
	let processed = 0;
	let pages = 0;
	for (;;) {
		const result: { processed: number; isDone: boolean; continueCursor: string } = await t.mutation(
			internal.migrations.backfill_read_only_nodes, { ...batch, cursor },
		);
		expect(result.processed).toBeLessThanOrEqual(25);
		processed += result.processed;
		pages++;
		if (result.isDone) break;
		cursor = result.continueCursor;
	}
	expect(pages).toBeGreaterThan(1);
	expect(processed).toBeGreaterThanOrEqual(27);
	for (const id of ids)
		expect(await t.run((ctx) => ctx.db.get("files_nodes", id))).toMatchObject({
			readOnly: true, readOnlyDecisionId: expect.any(String),
		});
});
