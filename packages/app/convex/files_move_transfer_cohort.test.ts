import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import { activities_db_require_by_source_id } from "./activities_db.ts";
import { test_convex, test_finish_transfer_run, test_mocks_fill_db_with } from "./setup.test.ts";
import { files_transfer_db_delete_run_batch, files_transfer_db_record_cohort_publication } from "./files_transfer.ts";
import { create_folder_fixture } from "./files_transfer.setup.test.ts";
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
		await ctx.db.replace("files_move_workspace_slots", slot._id, {
			organizationId: slot.organizationId,
			workspaceId: slot.workspaceId,
			cohortId: null,
			generation: slot.generation,
		});
		await ctx.db.patch("files_move_cohorts", f.cohortId, { phase: "complete", workPhase: "complete" });
	});
}

test("publication records the chosen identity once after Stop and access loss", async () => {
	const t = test_convex({ transactionLimits: true });
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const folder = async (path: string) => {
		const created = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: "root",
			path,
		});
		if (created._nay) throw new Error(created._nay.message);
		return created._yay.nodeId;
	};
	const nodeId = await folder("/source");
	const parentId = await folder("/target");
	const childId = await folder("/source/child");
	const started = await asUser.mutation(api.files_transfer.accept_input, {
		membershipId: db.membershipId,
		requestId: crypto.randomUUID(),
		kind: "move",
		sourceIds: [nodeId],
		expectedSourceCount: 1,
		targetParentId: parentId,
	});
	if (started._nay) throw new Error(started._nay.message);
	const { runId, activityId } = started._yay;
	const readCohort = () =>
		t.run((ctx) =>
			ctx.db
				.query("files_move_cohorts")
				.withIndex("by_origin_run", (q) => q.eq("origin.kind", "transfer").eq("origin.runId", runId))
				.first(),
		);
	let cohort = await readCohort();
	for (let pass = 0; !cohort || cohort.publishedAt === null; pass++) {
		if (pass === 1_000) throw new Error("The saved Move did not publish");
		if (cohort)
			await t.action(internal.files_move_run.run, {
				cohortId: cohort._id,
				step: cohort.step,
				runGeneration: cohort.runJob?.generation ?? null,
				mode: "step",
			});
		else await t.mutation(internal.files_transfer.advance, { runId });
		cohort = await readCohort();
	}
	if (cohort.origin.kind !== "transfer") throw new Error("Expected the public Transfer origin");
	const cohortId = cohort._id;
	const itemId = cohort.origin.itemId;
	expect(cohort, "the real publication leaves physical repair unfinished").toMatchObject({
		phase: "published",
		workPhase: "finish_content",
		visibleView: "after",
	});
	const receipt = await t.run((ctx) => ctx.db.get("files_transfer_items", itemId));
	expect(receipt, "accepted publication keeps its exact completion receipt").toMatchObject({
		state: "completed",
		outputTarget: { kind: "saved", id: nodeId },
		outputPath: "/target/source",
		outcome: "moved",
	});
	expect(await asUser.mutation(api.files_transfer.stop, { membershipId: db.membershipId, runId })).toEqual({
		_yay: null,
	});
	await t.run((ctx) => ctx.db.patch("organizations_workspaces_users", db.membershipId, { active: false }));
	await t.run((ctx) => files_transfer_db_record_cohort_publication(ctx, { cohortId }));
	await t.run((ctx) => files_transfer_db_record_cohort_publication(ctx, { cohortId }));
	expect(
		await t.run((ctx) => ctx.db.get("files_transfer_items", itemId)),
		"publication replay after Stop and access loss keeps the full receipt",
	).toEqual(receipt);
	expect(await t.run((ctx) => ctx.db.get("activities", activityId))).toMatchObject({
		status: "stopping",
		progress: { completed: 1 },
	});
	await t.mutation(internal.files_transfer.advance, { runId });
	expect(
		(await t.run((ctx) => ctx.db.get("activities", activityId)))?.status,
		"Stop waits for physical repair after publication",
	).toBe("stopping");
	expect(
		await t.run((ctx) => files_transfer_db_delete_run_batch(ctx, { runId, batchSize: 8 })),
		"run deletion waits for the same accepted cohort",
	).toEqual({ done: false, deletedCount: 0 });
	await test_finish_transfer_run(asUser, runId);
	expect(await t.run((ctx) => ctx.db.get("activities", activityId))).toMatchObject({
		status: "canceled",
		progress: { completed: 1, canceled: 0 },
	});
	expect(await t.run((ctx) => ctx.db.get("files_move_cohorts", cohortId))).toMatchObject({ phase: "complete" });
	const source = (await t.run((ctx) => ctx.db.get("files_nodes", nodeId)))!;
	const child = (await t.run((ctx) => ctx.db.get("files_nodes", childId)))!;
	expect(source).toMatchObject({ parentId, path: "/target/source" });
	expect(child).toMatchObject({ parentId: nodeId, path: "/target/source/child" });
	expect(source.moveCohortId).toBeUndefined();
	expect(child.moveCohortId).toBeUndefined();
});

test.each(["finish", "access_loss"] as const)("resumes a public Move after owner closure (%s)", async (end) => {
	const { t, db, asUser, folders } = await create_folder_fixture(["/source"]);
	const nodeId = folders.get("/source")!;
	const parentId = folders.get("/target")!;
	const userId = await t.run((ctx) => ctx.db.insert("users", { clerkUserId: `closure-${end}` }));
	expect(
		await asUser.mutation(api.organizations.invite_user_to_organization_workspace, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userIdToAdd: userId,
		}),
	).toEqual({ _yay: null });
	const membership = await t.run((ctx) =>
		ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_workspace_user_active", (q) =>
				q.eq("workspaceId", db.workspaceId).eq("userId", userId).eq("active", true),
			)
			.unique(),
	);
	if (!membership) throw new Error("Expected the invited mover");
	const asMember = t.withIdentity({ issuer: "https://clerk.test", external_id: userId });
	expect(
		await asMember.query(api.access_control.get_current_user_workspace_permission, {
			membershipId: membership._id,
			permission: "content.write",
		}),
	).toBe(true);
	const proposed = await t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId,
		target: { kind: "saved", id: nodeId },
		destParent: { kind: "root" },
		destName: "draft-source",
	});
	if (proposed._nay) throw new Error(proposed._nay.message);
	const proposal = await t.run((ctx) =>
		ctx.db
			.query("files_pending_updates")
			.withIndex("by_user_target", (q) => q.eq("userId", userId).eq("target.kind", "saved").eq("target.id", nodeId))
			.unique(),
	);
	if (!proposal) throw new Error("Expected the mover's pending proposal");
	const overlay = await import("../server/files-pending-overlay.ts");
	const canJoin = overlay.files_pending_overlay_db_can_join_step;
	// Keep the public admission and its stored work; yield before owner closure runs.
	const join = vi.spyOn(overlay, "files_pending_overlay_db_can_join_step").mockImplementation(async (ctx, limitFactor) => {
		const allowed = await canJoin(ctx, limitFactor);
		const slot = await ctx.db
			.query("files_move_workspace_slots")
			.withIndex("by_workspace", (q) => q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId))
			.unique();
		const cohort = slot?.cohortId ? await ctx.db.get("files_move_cohorts", slot.cohortId) : null;
		return allowed && cohort?.workPhase !== "owners_closure";
	});
	const started = await asMember.mutation(api.files_transfer.accept_input, {
		membershipId: membership._id,
		requestId: `closure-${end}`,
		kind: "move",
		sourceIds: [nodeId],
		expectedSourceCount: 1,
		targetParentId: parentId,
	});
	if (started._nay) throw new Error(started._nay.message);
	const { runId, activityId } = started._yay;
	const readCohort = () =>
		t.run((ctx) =>
			ctx.db
				.query("files_move_cohorts")
				.withIndex("by_origin_run", (q) => q.eq("origin.kind", "transfer").eq("origin.runId", runId))
				.unique(),
		);
	let cohort = await readCohort();
	for (let pass = 0; !cohort || cohort.workPhase !== "owners_closure"; pass++) {
		if (pass === 1_000) throw new Error("The public Move did not reach owner closure");
		if (cohort)
			await t.action(internal.files_move_run.run, {
				cohortId: cohort._id,
				step: cohort.step,
				runGeneration: cohort.runJob?.generation ?? null,
				mode: "step",
			});
		else await t.mutation(internal.files_transfer.advance, { runId });
		cohort = await readCohort();
	}
	join.mockRestore();
	const cohortId = cohort._id;
	const readItem = () =>
		t.run((ctx) =>
			ctx.db
				.query("files_move_cohort_items")
				.withIndex("by_cohort_order", (q) => q.eq("cohortId", cohortId).eq("order", 0))
				.unique(),
		);
	const item = await readItem();
	expect(item, "the public handoff keeps the selected transfer item planned").toMatchObject({
		status: "planned",
		pendingUpdateId: null,
		contentId: null,
		target: { kind: "saved", id: nodeId },
	});
	expect(
		await t.run((ctx) =>
			ctx.db
				.query("files_move_owner_work")
				.withIndex("by_cohort_status_order", (q) => q.eq("cohortId", cohortId).eq("status", "queued"))
				.first(),
		),
		"the real pending proposal leaves owner closure work",
	).not.toBeNull();
	await t.action(internal.files_move_run.run, {
		cohortId,
		step: cohort.step,
		runGeneration: cohort.runJob?.generation ?? null,
		mode: "step",
	});
	cohort = await readCohort();
	expect(cohort, "processing an owner does not finish closure").toMatchObject({
		workPhase: "owners_closure",
		publishedAt: null,
		visibleView: "before",
	});
	expect((await readItem())?.status, "incomplete owner closure keeps the transfer item planned").toBe("planned");
	if (!cohort) throw new Error("Expected the pending owner closure");
	for (let pass = 0; cohort.workPhase === "owners_closure"; pass++) {
		if (pass === 1_000) throw new Error("Owner closure did not finish");
		await t.action(internal.files_move_run.run, {
			cohortId,
			step: cohort.step,
			runGeneration: cohort.runJob?.generation ?? null,
			mode: "step",
		});
		cohort = await readCohort();
		if (!cohort) throw new Error("Expected the resumed Move cohort");
	}
	expect(await readItem(), "completed owner closure stages the exact transfer item").toMatchObject({
		_id: item!._id,
		status: "staged",
		contentId: null,
	});
	expect(cohort, "completed owner closure leaves side work unpublished").toMatchObject({
		workPhase: "sides",
		phase: "staging",
		publishedAt: null,
		visibleView: "before",
	});
	expect(await t.run((ctx) => ctx.db.get("files_nodes", nodeId))).toMatchObject({ path: "/source", moveCohortId: cohortId });
	if (end === "access_loss") {
		const organization = await t.run((ctx) => ctx.db.get("organizations", db.organizationId));
		if (!organization?.defaultWorkspaceId) throw new Error("Expected the default workspace");
		expect(
			await asUser.mutation(api.access_control.set_user_role, {
				organizationId: db.organizationId,
				workspaceId: organization.defaultWorkspaceId,
				userId,
				role: "viewer",
			}),
		).toEqual({ _yay: null });
		expect(
			await asMember.query(api.access_control.get_current_user_workspace_permission, {
				membershipId: membership._id,
				permission: "content.write",
			}),
			"the public role change removes current write access",
		).toBe(false);
	}
	await test_finish_transfer_run(asMember, runId);
	expect(await readCohort()).toMatchObject({
		phase: "complete",
		visibleView: end === "finish" ? "after" : "before",
		publishedAt: end === "finish" ? expect.any(Number) : null,
	});
	const saved = await t.run((ctx) => ctx.db.get("files_nodes", nodeId));
	expect(saved).toMatchObject({
		_id: nodeId,
		path: end === "finish" ? "/target/source" : "/source",
	});
	expect(saved?.moveCohortId).toBeUndefined();
	expect(await t.run((ctx) => ctx.db.get("activities", activityId))).toMatchObject({
		progress: { completed: end === "finish" ? 1 : 0 },
	});
	expect(
		await t.run((ctx) => ctx.db.get("files_pending_updates", proposal._id)),
		"the saved Move keeps the pending proposal",
	).toEqual(proposal);
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
	const started = await asOther.mutation(api.files_transfer.accept_input, {
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
	const receipt = await f.asUser.query(api.files_transfer_status.list_items, {
		membershipId: f.db.membershipId,
		runId: original.run._id,
		state: "completed",
		paginationOpts: { cursor: null, numItems: 8 },
	});
	// Results are job history: the receipt keeps the path the job recorded, not the current one.
	expect(receipt?.page[0]?.source).toEqual({ target: { kind: "saved", id: f.nodeId }, path: "/old.txt", name: "old.txt" });
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
	const started = await asUser.mutation(api.files_transfer.accept_input, {
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
		await asUser.query(api.files_transfer_status.get, { membershipId: db.membershipId, runId }),
		"the native saved Move completes after cohort cleanup",
	).toMatchObject({ activity: { status: "succeeded", progress: { completed: 1, canceled: 0, failed: 0 } } });
	const moved = await t.run((ctx) => ctx.db.get("files_nodes", source._yay.nodeId));
	expect(moved).toMatchObject({
		parentId: target._yay.nodeId,
		path: "/target/source",
	});
	expect(moved?.moveCohortId).toBeUndefined();
});
