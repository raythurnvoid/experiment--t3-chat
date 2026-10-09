import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import { activities_db_require_by_source_id } from "./activities_db.ts";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import { files_transfer_db_delete_run_batch, files_transfer_db_record_cohort_publication } from "./files_transfer.ts";
import { test_create_saved_placement_fixture as fixture } from "../server/files-saved-placement.test-fixtures.ts";

beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("move-cohort-test" as never);
	vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined as never);
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (key = "") => ({
		key,
		url: "https://r2.test/upload",
	}));
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(null, { status: 200 })),
	);
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function origin(f: Fixture) {
	return await f.t.run(async (ctx) => {
		const item = (await ctx.db.get("files_transfer_items", f.itemId))!;
		const run = (await ctx.db.get("files_transfer_runs", item.runId))!;
		const activity = await activities_db_require_by_source_id(ctx, run._id);
		// The fixture supplies the cohort. Pin its real public Transfer origin.
		await ctx.db.patch("files_move_cohorts", f.cohortId, { fence: run.revision, attemptFence: item.attempt });
		return { run, item, activity };
	});
}

async function release(f: Fixture) {
	await f.materializeNode(f.nodeId);
	await f.t.run(async (ctx) => {
		const claims = await ctx.db
			.query("files_move_slot_claims")
			.withIndex("by_cohort", (q) => q.eq("cohortId", f.cohortId))
			.collect();
		for (const claim of claims) await ctx.db.delete("files_move_slot_claims", claim._id);
		const slot = (await ctx.db
			.query("files_move_workspace_slots")
			.withIndex("by_workspace", (q) => q.eq("organizationId", f.db.organizationId).eq("workspaceId", f.db.workspaceId))
			.unique())!;
		await ctx.db.patch("files_move_workspace_slots", slot._id, { cohortId: null });
		await ctx.db.patch("files_move_cohorts", f.cohortId, { phase: "complete", workPhase: "complete" });
	});
}

test("publication records the chosen identity once after Stop and access loss", async () => {
	const f = await fixture();
	const { run, activity } = await origin(f);
	await f.publish();
	await f.t.run(async (ctx) => {
		await ctx.db.patch("activities", activity._id, {
			status: "stopping",
			errorCode: "canceled",
			stopRequestedAt: Date.now(),
		});
		await ctx.db.patch("organizations_workspaces_users", f.db.membershipId, { active: false });
	});
	await f.t.run((ctx) => files_transfer_db_record_cohort_publication(ctx, { cohortId: f.cohortId }));
	await f.t.run((ctx) => files_transfer_db_record_cohort_publication(ctx, { cohortId: f.cohortId }));
	expect(
		await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.itemId)),
		"accepted publication keeps its exact completion receipt",
	).toMatchObject({
		state: "completed",
		outputTarget: { kind: "saved", id: f.nodeId },
		outputPath: "/target/new.txt",
		outcome: "moved",
	});
	expect(await f.t.run((ctx) => ctx.db.get("activities", activity._id))).toMatchObject({
		status: "stopping",
		progress: { completed: 1 },
	});
	await f.t.mutation(internal.files_transfer.advance, { runId: run._id });
	expect(
		(await f.t.run((ctx) => ctx.db.get("activities", activity._id)))?.status,
		"Stop waits for physical repair after publication",
	).toBe("stopping");
	expect(
		await f.t.run((ctx) => files_transfer_db_delete_run_batch(ctx, { runId: run._id, batchSize: 8 })),
		"run deletion waits for the same accepted cohort",
	).toEqual({ done: false, deletedCount: 0 });
	await release(f);
	await f.t.mutation(internal.files_transfer.settle_cohort, { cohortId: f.cohortId });
	await f.t.mutation(internal.files_transfer.advance, { runId: run._id });
	expect(await f.t.run((ctx) => ctx.db.get("activities", activity._id))).toMatchObject({
		status: "canceled",
		progress: { completed: 1, canceled: 0 },
	});
});

test("Stop before publication leaves the pending item until cohort abort finishes", async () => {
	const f = await fixture();
	const { run, activity } = await origin(f);
	expect(await f.asUser.mutation(api.files_transfer.stop, { membershipId: f.db.membershipId, runId: run._id })).toEqual(
		{ _yay: null },
	);
	expect(
		(await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.itemId)))?.state,
		"Stop keeps an unfinished cohort input",
	).toBe("pending");
	expect(await f.t.run((ctx) => ctx.db.get("files_move_cohorts", f.cohortId))).toMatchObject({
		phase: "aborting",
		visibleView: "before",
		publishedAt: null,
	});
	expect((await f.t.run((ctx) => ctx.db.get("activities", activity._id)))?.status).toBe("stopping");
	await release(f);
	await f.t.mutation(internal.files_transfer.settle_cohort, { cohortId: f.cohortId });
	await f.t.mutation(internal.files_transfer.advance, { runId: run._id });
	expect((await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.itemId)))?.state).toBe("canceled");
	expect((await f.t.run((ctx) => ctx.db.get("files_nodes", f.nodeId)))?.path).toBe("/old.txt");
});

test("an unpublished destination conflict pauses only after cleanup", async () => {
	const f = await fixture();
	const { run, activity } = await origin(f);
	await f.t.run((ctx) =>
		ctx.db.patch("files_move_cohorts", f.cohortId, {
			phase: "aborting",
			errorCode: "destination_changed",
			errorMessage: "The destination changed.",
		}),
	);
	await f.t.mutation(internal.files_transfer.settle_cohort, { cohortId: f.cohortId });
	expect((await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.itemId)))?.state).toBe("pending");
	await release(f);
	await f.t.mutation(internal.files_transfer.settle_cohort, { cohortId: f.cohortId });
	await f.t.mutation(internal.files_transfer.settle_cohort, { cohortId: f.cohortId });
	expect(await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.itemId))).toMatchObject({
		state: "conflict",
		conflictKind: "destination_changed",
	});
	expect(await f.t.run((ctx) => ctx.db.get("activities", activity._id))).toMatchObject({
		status: "awaiting_input",
		progress: { blocked: 1, completed: 0 },
	});
	expect((await f.t.run((ctx) => ctx.db.get("files_transfer_runs", run._id)))?.revision).toBe(run.revision + 1);
});

test("another accepted Move waits for the workspace cohort before reading its sources", async () => {
	const f = await fixture();
	const original = await origin(f);
	const other = await f.t.run((ctx) =>
		test_mocks_fill_db_with.membership(ctx, { organizationName: "personal", workspaceName: "home" }),
	);
	expect(
		await f.asUser.mutation(api.organizations.invite_user_to_organization_workspace, {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			userIdToAdd: other.userId,
		}),
	).toEqual({ _yay: null });
	const membership = await f.t.run((ctx) =>
		ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_workspace_user_active", (q) =>
				q.eq("workspaceId", f.db.workspaceId).eq("userId", other.userId).eq("active", true),
			)
			.unique(),
	);
	if (!membership) throw new Error("Expected the invited member");
	const asOther = f.t.withIdentity({ issuer: "https://clerk.test", external_id: other.userId });
	const started = await asOther.mutation(api.files_transfer.start, {
		membershipId: membership._id,
		requestId: "other-move",
		kind: "move",
		sourceIds: [f.nodeId],
		expectedSourceCount: 1,
		targetParentId: "root",
	});
	if (started._nay) throw new Error(started._nay.message);
	const runId = started._yay.runId;
	expect(await asOther.mutation(api.files_transfer.seal, { membershipId: membership._id, runId })).toEqual({
		_yay: null,
	});
	await f.t.mutation(internal.files_transfer.advance, { runId });
	expect(
		(await f.t.run((ctx) => ctx.db.get("files_transfer_runs", runId)))?.selection?.cursor,
		"another cohort parks source selection",
	).toBe(-1);
	expect((await f.t.run((ctx) => ctx.db.get("files_move_cohorts", f.cohortId)))?.phase).toBe("staging");
	await f.publish();
	await f.t.run((ctx) => files_transfer_db_record_cohort_publication(ctx, { cohortId: f.cohortId }));
	const receipt = await f.asUser.query(api.files_transfer.list_items, {
		membershipId: f.db.membershipId,
		runId: original.run._id,
		state: "completed",
		paginationOpts: { cursor: null, numItems: 8 },
	});
	expect(receipt?.page[0]?.source, "receipt source does not expose the old physical header").toBeNull();
	expect(receipt?.page[0]?.movedNodeId).toBe(f.nodeId);
	await release(f);
	await f.t.mutation(internal.files_transfer.advance, { runId });
	expect(
		await f.t.run((ctx) =>
			ctx.db
				.query("files_transfer_selection_items")
				.withIndex("by_run_order", (q) => q.eq("runId", runId))
				.first(),
		),
	).toMatchObject({ path: "/target/new.txt" });
});

test("a public saved Move enters and finishes the bounded cohort producer", async () => {
	const t = test_convex({ transactionLimits: true });
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const source = await t.mutation(internal.files_nodes.create_folder_node_by_path, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: db.userId,
		path: "/source",
	});
	const target = await t.mutation(internal.files_nodes.create_folder_node_by_path, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: db.userId,
		path: "/target",
	});
	if (source._nay || target._nay) throw new Error("Expected native saved folders");
	const started = await asUser.mutation(api.files_transfer.start, {
		membershipId: db.membershipId,
		requestId: "native-cohort",
		kind: "move",
		sourceIds: [source._yay.nodeId],
		expectedSourceCount: 1,
		targetParentId: target._yay.nodeId,
	});
	if (started._nay) throw new Error(started._nay.message);
	const runId = started._yay.runId;
	expect(await asUser.mutation(api.files_transfer.seal, { membershipId: db.membershipId, runId })).toEqual({
		_yay: null,
	});
	let cohortId = null;
	for (let step = 0; step < 8; step++) {
		await t.mutation(internal.files_transfer.advance, { runId });
		cohortId = await t.run(
			async (ctx) =>
				(
					await ctx.db
						.query("files_move_workspace_slots")
						.withIndex("by_workspace", (q) =>
							q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId),
						)
						.unique()
				)?.cohortId ?? null,
		);
		if (cohortId) break;
	}
	expect(cohortId, "saved Move enters the bounded cohort producer").not.toBeNull();
	await t.finishAllScheduledFunctions(vi.runAllTimers, 1_000);
	expect(
		await asUser.query(api.files_transfer.get, { membershipId: db.membershipId, runId }),
		"the native saved Move completes after cohort cleanup",
	).toMatchObject({ activity: { status: "succeeded", progress: { completed: 1, canceled: 0, failed: 0 } } });
	const moved = await t.run((ctx) => ctx.db.get("files_nodes", source._yay.nodeId));
	expect(moved).toMatchObject({
		parentId: target._yay.nodeId,
		path: "/target/source",
	});
	expect(moved?.moveCohortId).toBeUndefined();
});
