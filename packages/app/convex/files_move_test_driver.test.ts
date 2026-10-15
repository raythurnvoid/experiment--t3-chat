import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { files_nodes_db_create_private_node_by_path } from "./files_nodes.ts";
import {
	test_convex,
	test_finish_pending_update_run,
	test_finish_transfer_run,
	test_mocks_fill_db_with,
	test_run_with_flush,
	test_spy_handler,
} from "./setup.test.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

async function fixture(ownerCount: number) {
	const t = test_convex({ transactionLimits: true });
	const db = await t.run(ctx => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId };
	const folders = [];
	for (const path of ["/source", "/target", "/unrelated"]) {
		const created = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: "root",
			path,
		});
		if (created._nay) throw new Error(created._nay.message);
		folders.push(created._yay.nodeId);
	}
	const owners = [db.userId];
	for (let index = 1; index < ownerCount; index++) {
		const userId = await t.run(ctx => ctx.db.insert("users", { clerkUserId: `driver-owner-${index}` }));
		vi.setSystemTime(Date.now() + 10_000);
		expect(await asUser.mutation(api.organizations.invite_user_to_organization_workspace, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userIdToAdd: userId,
		})).toEqual({ _yay: null });
		owners.push(userId);
	}
	// A batch touching several owners uses the real deferred overlay producer.
	const drafts = await test_run_with_flush(t, async ctx => {
		const drafts = [];
		for (const [index, userId] of owners.entries()) {
			const created = await files_nodes_db_create_private_node_by_path(ctx, {
				...scope,
				userId,
				path: `/source/draft-${index}`,
				kind: "folder",
			});
			if (created._nay || created._yay.target.kind !== "private" || !created._yay.pendingUpdateId)
				throw new Error("Expected the private folder proposal");
			drafts.push({ ...created._yay, pendingUpdateId: created._yay.pendingUpdateId });
		}
		return drafts;
	});
	return { t, db, asUser, scope, owners, sourceId: folders[0]!, targetId: folders[1]!, unrelatedId: folders[2]!, drafts };
}

async function queued_rename(f: Awaited<ReturnType<typeof fixture>>) {
	// Queue another owner's Rename. The driver must leave it queued.
	const userId = f.owners[1]!;
	const membership = await f.t.run(ctx => ctx.db.query("organizations_workspaces_users")
		.withIndex("by_workspace_user_active", q => q.eq("workspaceId", f.db.workspaceId).eq("userId", userId).eq("active", true)).unique());
	if (!membership) throw new Error("Expected the invited owner's membership");
	const renamed = await f.t.withIdentity({ issuer: "https://clerk.test", external_id: userId }).mutation(api.files_nodes.rename_node, {
		membershipId: membership._id,
		requestId: "unrelated-rename",
		nodeId: f.unrelatedId,
		path: "renamed",
	});
	if (renamed._nay) throw new Error(renamed._nay.message);
	if (!renamed._yay) throw new Error("Expected the Rename job");
	return renamed._yay;
}

async function review_first_draft(f: Awaited<ReturnType<typeof fixture>>) {
	const proposal = await f.t.run(ctx => ctx.db.get("files_pending_updates", f.drafts[0]!.pendingUpdateId));
	if (!proposal) throw new Error("Expected the draft before Review");
	const started = await f.asUser.mutation(api.files_pending_update_runs.start, {
		membershipId: f.db.membershipId,
		requestId: "review-after-move",
		kind: "accept",
		expectedItemCount: 1,
		items: [{ pendingUpdateId: proposal._id, reviewedRevision: proposal.revision, selectedContentStateId: null }],
	});
	if (started._nay) throw new Error(started._nay.message);
	expect(await f.asUser.mutation(api.files_pending_update_runs.seal, {
		membershipId: f.db.membershipId,
		runId: started._yay.runId,
	})).toEqual({ _yay: null });
	return started._yay;
}

test("Handler spies keep two installed wrappers", async () => {
	const calls: string[] = [];
	const registered = {
		_handler: async (_ctx: MutationCtx, _args: unknown) => {
			calls.push("original");
			return null;
		},
	};
	for (const name of ["first", "second"]) test_spy_handler(registered, async (handler, ctx, args) => {
		calls.push(name);
		expect(calls.filter(call => call === name), "Each installed handler wrapper runs once").toHaveLength(1);
		return await handler(ctx, args);
	});
	expect(await registered._handler({} as MutationCtx, {})).toBeNull();
	expect(calls).toEqual(["second", "first", "original"]);
});

test("Move completion wakes every owner page before the next Review", async () => {
	const f = await fixture(9);
	const started = await f.asUser.mutation(api.files_transfer.accept_input, {
		membershipId: f.db.membershipId,
		requestId: "move-with-owner-jobs",
		kind: "move",
		expectedSourceCount: 1,
		sourceIds: [f.sourceId],
		targetParentId: f.targetId,
	});
	if (started._nay) throw new Error(started._nay.message);
	const { runId, activityId } = started._yay;
	expect(await f.asUser.mutation(api.files_transfer.seal, { membershipId: f.db.membershipId, runId })).toEqual({ _yay: null });
	const cohort = async () => await f.t.run(ctx => ctx.db.query("files_move_cohorts")
		.withIndex("by_origin_run", q => q.eq("origin.kind", "transfer").eq("origin.runId", runId)).first());
	while (!(await cohort())) {
		const before = await f.t.run(ctx => ctx.db.get("files_transfer_runs", runId));
		await f.t.mutation(internal.files_transfer.advance, { runId });
		if (!(await cohort())) expect(await f.t.run(ctx => ctx.db.get("files_transfer_runs", runId))).not.toEqual(before);
	}
	const cohortId = (await cohort())!._id;
	// The real worker holds the source before owner jobs can park on this Move.
	const reservation = () => f.t.run(ctx => ctx.db.query("files_move_source_reservations")
		.withIndex("by_source", q => q.eq("source.kind", "saved").eq("source.id", f.sourceId)).unique());
	while (!(await reservation())) {
		const before = (await cohort())!;
		await f.t.action(internal.files_move_run.run, {
			cohortId, step: before.step, runGeneration: before.runJob?.generation ?? null, mode: "step",
		});
		expect((await cohort())?.step).not.toBe(before.step);
	}
	expect(await reservation()).toMatchObject({ cohortId, mode: "subtree" });
	const jobs = await f.t.run(ctx => ctx.db.query("files_pending_overlay_jobs")
		.withIndex("by_org_ws", q => q.eq("organizationId", f.db.organizationId).eq("workspaceId", f.db.workspaceId)).collect());
	expect(jobs).toHaveLength(9);
	for (const job of jobs) await f.t.mutation(internal.files_pending_overlay.run_job, {
		kind: job.kind,
		key: job.key,
		nextAttemptAt: job.nextAttemptAt,
	});
	const blocked_jobs = () => f.t.run(ctx => ctx.db.query("files_pending_overlay_jobs")
		.withIndex("by_blockedCohort", q => q.eq("blockedByCohortId", cohortId)).collect());
	expect(await blocked_jobs()).toHaveLength(9);
	const rename = await queued_rename(f);
	const now = Date.now();
	let scheduleOnlyAdvances = 0;
	test_spy_handler((await import("./files_transfer.ts")).advance, async (handler, ctx, args) => {
		if ((args as { runId: typeof runId }).runId === runId) {
			const activity = await ctx.db.get("activities", activityId);
			const cohort = await ctx.db.get("files_move_cohorts", cohortId);
			if (activity?.status === "running" && cohort && cohort.phase !== "complete") scheduleOnlyAdvances++;
		}
		return await handler(ctx, args);
	});
	const run = f.asUser.run;
	let earlyCompletionProbes = 0;
	// The driver already has this running cohort in its fresh state read.
	f.asUser.run = async <Output>(func: Parameters<typeof run<Output>>[0]) => {
		const result = await run(func);
		if (result !== null && typeof result === "object" && "_id" in result && result._id === cohortId &&
			"workPhase" in result && result.workPhase !== "release" && result.workPhase !== "complete") earlyCompletionProbes++;
		return result;
	};
	try {
		await test_finish_transfer_run(f.asUser, runId);
	} finally {
		f.asUser.run = run;
	}
	expect(earlyCompletionProbes, "Move completion must not probe an owned cohort before release").toBe(0);
	expect(scheduleOnlyAdvances, "Running cohort pages must not add schedule-only Transfer advances").toBe(0);
	expect(await blocked_jobs(), "Move completion must drain every owner wake page").toEqual([]);
	expect(await f.t.run(ctx => ctx.db.get("activities", activityId))).toMatchObject({ status: "succeeded" });
	const review = await review_first_draft(f);
	await test_finish_pending_update_run(f.asUser, review.runId);
	expect(await f.t.run(ctx => ctx.db.get("activities", review.activityId))).toMatchObject({ status: "succeeded" });
	expect(await f.t.run(ctx => ctx.db.query("files_pending_review_fact_state")
		.withIndex("by_workspace", q => q.eq("organizationId", f.db.organizationId).eq("workspaceId", f.db.workspaceId)).unique()))
		.toMatchObject({ pendingJobCount: 0 });
	expect(await f.t.run(ctx => ctx.db.get("activities", rename.activityId))).toMatchObject({ status: "queued" });
	expect((await f.t.run(ctx => ctx.db.get("files_nodes", f.unrelatedId)))?.path).toBe("/unrelated");
	expect(Date.now()).toBe(now);
});

test("Review completion runs due overlay work before a deferred job without firing other timers", async () => {
	const f = await fixture(2);
	const jobs = await f.t.run(ctx => ctx.db.query("files_pending_overlay_jobs")
		.withIndex("by_org_ws", q => q.eq("organizationId", f.db.organizationId).eq("workspaceId", f.db.workspaceId)).collect());
	expect(jobs).toHaveLength(2);
	const deferred = jobs[0]!;
	const dueAt = Date.now() + 100;
	await f.t.run(async ctx => {
		await ctx.scheduler.cancel(deferred.scheduledFunctionId);
		const scheduledFunctionId = await ctx.scheduler.runAt(dueAt, internal.files_pending_overlay.run_job, {
			kind: deferred.kind,
			key: deferred.key,
			nextAttemptAt: dueAt,
		});
		await ctx.db.patch("files_pending_overlay_jobs", deferred._id, { nextAttemptAt: dueAt, scheduledFunctionId });
	});
	const keys: string[] = [];
	test_spy_handler((await import("./files_pending_overlay.ts")).run_job, async (handler, ctx, args) => {
		keys.push((args as { key: string }).key);
		return await handler(ctx, args);
	});
	const rename = await queued_rename(f);
	const review = await review_first_draft(f);
	await expect(test_finish_pending_update_run(f.asUser, review.runId), "A deferred overlay job must finish before Review").resolves.toBeUndefined();
	expect(keys[0], "A future job must not hide already due overlay work").toBe(jobs[1]!.key);
	expect(await f.t.run(ctx => ctx.db.get("files_pending_overlay_jobs", deferred._id))).toBeNull();
	expect(await f.t.run(ctx => ctx.db.get("activities", review.activityId))).toMatchObject({ status: "succeeded" });
	expect(await f.t.run(ctx => ctx.db.get("activities", rename.activityId))).toMatchObject({ status: "queued" });
	expect((await f.t.run(ctx => ctx.db.get("files_nodes", f.unrelatedId)))?.path).toBe("/unrelated");
	expect(Date.now()).toBe(dueAt);
});

test("Move driver still drives Stop while a cohort owns the workspace", async () => {
	const f = await fixture(1);
	// Enough real children leave the initial budget unfinished for Stop.
	const child = await f.asUser.mutation(api.files_nodes.create_folder_node, {
		membershipId: f.db.membershipId,
		parentId: f.sourceId,
		path: "child",
	});
	if (child._nay) throw new Error(child._nay.message);
	const children = [{ id: child._yay.nodeId, path: "/source/child" }];
	for (let index = 0; index < 64; index++) {
		if (index % 10 === 0) vi.setSystemTime(Date.now() + 60_000);
		const path = `child-${index.toString().padStart(2, "0")}`;
		const created = await f.asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: f.db.membershipId,
			parentId: f.sourceId,
			path,
		});
		if (created._nay) throw new Error(created._nay.message);
		children.push({ id: created._yay.nodeId, path: `/source/${path}` });
	}
	const started = await f.asUser.mutation(api.files_transfer.accept_input, {
		membershipId: f.db.membershipId,
		requestId: "stop-owned-cohort",
		kind: "move",
		expectedSourceCount: 1,
		sourceIds: [f.sourceId],
		targetParentId: f.targetId,
	});
	if (started._nay) throw new Error(started._nay.message);
	const { runId, activityId } = started._yay;
	expect(await f.asUser.mutation(api.files_transfer.seal, { membershipId: f.db.membershipId, runId })).toEqual({ _yay: null });
	let stoppingAdvances = 0;
	test_spy_handler((await import("./files_transfer.ts")).advance, async (handler, ctx, args) => {
		if ((args as { runId: typeof runId }).runId === runId && (await ctx.db.get("activities", activityId))?.status === "stopping")
			stoppingAdvances++;
		return await handler(ctx, args);
	});
	let stopSent = false;
	await test_finish_transfer_run(f.asUser, runId, async () => {
		if (stopSent) return;
		const cohort = await f.t.run(ctx => ctx.db.query("files_move_cohorts")
			.withIndex("by_origin_run", q => q.eq("origin.kind", "transfer").eq("origin.runId", runId)).first());
		if (!cohort) return;
		expect(cohort, "Stop starts before publication").toMatchObject({ publishedAt: null, visibleView: "before" });
		stopSent = true;
		expect(await f.asUser.mutation(api.files_transfer.stop, { membershipId: f.db.membershipId, runId })).toEqual({ _yay: null });
	});
	expect(stopSent).toBe(true);
	expect(stoppingAdvances, "Stop must still advance an owned Move cohort").toBeGreaterThan(0);
	expect(await f.t.run(ctx => ctx.db.get("activities", activityId))).toMatchObject({ status: "canceled" });
	expect((await f.t.run(ctx => ctx.db.get("files_nodes", f.sourceId)))?.path).toBe("/source");
	const keptChild = await f.t.run(ctx => ctx.db.get("files_nodes", child._yay.nodeId));
	expect(keptChild?.path).toBe("/source/child");
	expect(keptChild?.moveCohortId).toBeUndefined();
	const keptChildren = await f.t.run(ctx => Promise.all(children.map(child => ctx.db.get("files_nodes", child.id))));
	expect(keptChildren.map(child => child?.path)).toEqual(children.map(child => child.path));
	expect(keptChildren.every(child => child?.moveCohortId === undefined)).toBe(true);
});

test.each(["Transfer", "Review"] as const)("%s driver finishes its owned Move before a waiting scope repair", async kind => {
	const f = await fixture(1);
	const transfer = kind === "Transfer" ? await f.asUser.mutation(api.files_transfer.accept_input, {
		membershipId: f.db.membershipId,
		requestId: "move-with-scope-repair",
		kind: "move",
		expectedSourceCount: 1,
		sourceIds: [f.sourceId],
		targetParentId: f.targetId,
	}) : null;
	if (transfer?._nay) throw new Error(transfer._nay.message);
	if (transfer?._yay) expect(await f.asUser.mutation(api.files_transfer.seal, {
		membershipId: f.db.membershipId,
		runId: transfer._yay.runId,
	})).toEqual({ _yay: null });
	const review = kind === "Review" ? await review_first_draft(f) : null;
	const started = transfer?._yay ?? review;
	if (!started) throw new Error("Expected the owned Move job");
	const now = Date.now();
	let restrictSent = false;
	let restrictionSucceeded = false;
	let repairId: Id<"files_subtree_ops"> | null = null;
	let parked = false;
	const run = f.asUser.run;
	f.asUser.run = async <Output>(func: Parameters<typeof run<Output>>[0]) => {
		const result = await run(func);
		// Restrict after the snapshot ends, while the published Move still holds the workspace.
		if (!restrictSent && result !== null && typeof result === "object" && "run" in result && "activity" in result) {
			const { cohort, slot } = await run(async ctx => ({
				cohort: await ctx.db.query("files_move_cohorts")
					.withIndex("by_origin_run", q => q.eq("origin.kind", kind === "Transfer" ? "transfer" : "review")
						.eq("origin.runId", started.runId)).order("desc").first(),
				slot: await ctx.db.query("files_move_workspace_slots")
					.withIndex("by_workspace", q => q.eq("organizationId", f.db.organizationId).eq("workspaceId", f.db.workspaceId)).unique(),
			}));
			if (cohort && cohort.publishedAt !== null && cohort.phase !== "complete" && slot?.cohortId === cohort._id) {
				restrictSent = true;
				const restricted = await f.asUser.mutation(api.files_sharing.restrict_node, {
					membershipId: f.db.membershipId,
					nodeId: f.unrelatedId,
				});
				restrictionSucceeded = !restricted._nay;
				const { op, waiter } = await run(async ctx => {
					const op = await ctx.db.query("files_subtree_ops")
						.withIndex("by_organization_workspace_kind_status", q => q.eq("organizationId", f.db.organizationId)
							.eq("workspaceId", f.db.workspaceId).eq("kind", "scope").eq("status", "running")).first();
					const waiter = op ? await ctx.db.query("files_move_waiters")
						.withIndex("by_worker", q => q.eq("worker.kind", "subtree").eq("worker.id", op._id)).unique() : null;
					return { op, waiter };
				});
				repairId = op?._id ?? null;
				parked = waiter?.cohortId === cohort._id;
			}
		}
		return result;
	};
	const finished = (async () => {
		if (transfer?._yay) await test_finish_transfer_run(f.asUser, transfer._yay.runId, undefined, { stepwise: true });
		else if (review) await test_finish_pending_update_run(f.asUser, review.runId, { stepwise: true });
		return await f.t.run(ctx => ctx.db.get("activities", started.activityId));
	})();
	try {
		await finished.catch(() => undefined);
	} finally {
		f.asUser.run = run;
	}
	expect(restrictSent, "The public restriction must run while the owned Move holds the workspace").toBe(true);
	expect(restrictionSucceeded).toBe(true);
	expect(parked, "The real scope repair must wait for the owned Move").toBe(true);
	await expect(finished, `${kind} finishes its owned Move before a scope repair waiting on it`).resolves.toMatchObject({ status: "succeeded" });
	if (!repairId) throw new Error("Expected the parked scope repair");
	expect(await f.t.run(ctx => ctx.db.get("files_subtree_ops", repairId!)), "The parked scope repair must finish").toBeNull();
	expect(await f.t.run(ctx => ctx.db.query("files_move_waiters")
		.withIndex("by_worker", q => q.eq("worker.kind", "subtree").eq("worker.id", repairId!)).unique())).toBeNull();
	expect(await f.t.run(ctx => ctx.db.get("files_nodes", f.unrelatedId))).toMatchObject({
		path: "/unrelated",
		restrictedScopeNodeId: f.unrelatedId,
	});
	if (transfer?._yay) {
		expect(await f.t.run(ctx => ctx.db.get("files_nodes", f.sourceId))).toMatchObject({ path: "/target/source" });
		expect(await f.t.run(ctx => ctx.db.query("files_pending_places")
			.withIndex("by_pendingUpdate", q => q.eq("pendingUpdateId", f.drafts[0]!.pendingUpdateId)
				.eq("moveView.cohortId", undefined).eq("moveView.view", undefined)).unique())).toMatchObject({
			ownerTreePath: "/target/source/draft-0/",
			isVisible: true,
		});
	} else {
		const receipt = await f.t.run(ctx => ctx.db.query("files_pending_node_publish_receipts")
			.withIndex("by_privateNode", q => q.eq("privateNodeId", f.drafts[0]!.createdNodeIds[0]!)).first());
		if (!receipt) throw new Error("Expected the saved draft receipt");
		expect(await f.t.run(ctx => ctx.db.get("files_nodes", receipt.savedNodeId))).toMatchObject({ path: "/source/draft-0" });
		expect(await f.t.run(ctx => ctx.db.get("files_pending_updates", f.drafts[0]!.pendingUpdateId))).toBeNull();
	}
	expect(Date.now()).toBe(now);
});

test("Copy driver completes an empty saved folder", async () => {
	const t = test_convex({ transactionLimits: true });
	const db = await t.run(ctx => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const folders: Id<"files_nodes">[] = [];
	for (const path of ["/copy-empty", "/target"]) {
		const created = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: "root",
			path,
		});
		if (created._nay) throw new Error(created._nay.message);
		folders.push(created._yay.nodeId);
	}
	const started = await asUser.mutation(api.files_transfer.accept_input, {
		membershipId: db.membershipId,
		requestId: "copy-empty-folder",
		kind: "copy",
		expectedSourceCount: 1,
		sourceIds: [folders[0]!],
		targetParentId: folders[1]!,
	});
	if (started._nay) throw new Error(started._nay.message);
	const { runId, activityId } = started._yay;
	expect(await asUser.mutation(api.files_transfer.seal, { membershipId: db.membershipId, runId })).toEqual({ _yay: null });
	await expect((async () => {
		await test_finish_transfer_run(asUser, runId);
		return await t.run(ctx => ctx.db.get("activities", activityId));
	})(), "An empty saved folder Copy completes after its discovery page").resolves.toMatchObject({
		status: "succeeded",
		progress: { unit: "files", discovered: 1, total: 1, completed: 1, skipped: 0, failed: 0, blocked: 0, canceled: 0 },
	});
	const item = await t.run(ctx => ctx.db.query("files_transfer_items")
		.withIndex("by_run_source", q => q.eq("runId", runId).eq("source.kind", "saved").eq("source.id", folders[0]!)).unique());
	expect(item).toMatchObject({ state: "completed", outputPath: "/target/copy-empty" });
	const outputTarget = item?.outputTarget;
	if (outputTarget?.kind !== "saved") throw new Error("Expected the saved Copy output");
	expect(await t.run(ctx => ctx.db.get("files_nodes", outputTarget.id))).toMatchObject({
		kind: "folder",
		parentId: folders[1]!,
		path: "/target/copy-empty",
	});
});

test("Review driver prepares a saved Discard unit", async () => {
	const t = test_convex({ transactionLimits: true });
	const db = await t.run(ctx => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const created = await asUser.mutation(api.files_nodes.create_folder_node, {
		membershipId: db.membershipId,
		parentId: "root",
		path: "/discard-delete",
	});
	if (created._nay) throw new Error(created._nay.message);
	const target = { kind: "saved", id: created._yay.nodeId } as const;
	expect(await t.mutation(internal.files_pending_updates.upsert_file_pending_archive_in_db, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: db.userId,
		target,
	})).toMatchObject({ _yay: { outcome: "proposed" } });
	const proposal = await t.run(ctx => ctx.db.query("files_pending_updates")
		.withIndex("by_user_target", q => q.eq("userId", db.userId).eq("target.kind", target.kind).eq("target.id", target.id)).unique());
	if (!proposal) throw new Error("Expected the Delete proposal");
	const started = await asUser.mutation(api.files_pending_update_runs.start, {
		membershipId: db.membershipId,
		requestId: "discard-saved-delete",
		kind: "discard",
		expectedItemCount: 1,
		items: [{ pendingUpdateId: proposal._id, reviewedRevision: proposal.revision, selectedContentStateId: null }],
	});
	if (started._nay) throw new Error(started._nay.message);
	const { runId, activityId } = started._yay;
	expect(await asUser.mutation(api.files_pending_update_runs.seal, { membershipId: db.membershipId, runId })).toEqual({ _yay: null });
	const now = Date.now();
	await expect((async () => {
		await test_finish_pending_update_run(asUser, runId);
		return await t.run(ctx => ctx.db.get("activities", activityId));
	})(), "A saved Delete Discard must finish its native preparation").resolves.toMatchObject({
		status: "succeeded",
		progress: { completed: 1, blocked: 0, failed: 0, canceled: 0 },
	});
	expect(await t.run(ctx => ctx.db.get("files_pending_updates", proposal._id))).toBeNull();
	expect(await t.run(ctx => ctx.db.get("files_pending_update_runs", runId))).toMatchObject({ unitCount: 1, finishedUnitCount: 1 });
	expect(await t.run(ctx => ctx.db.get("files_nodes", target.id))).toMatchObject({ path: "/discard-delete", archiveOperationId: null });
	expect(Date.now()).toBe(now);
});

test("Review driver tracks a copied parent's dependency page", async () => {
	const t = test_convex({ transactionLimits: true });
	const db = await t.run(ctx => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const folders = [];
	for (const path of ["/source", "/source/child", "/target"]) {
		const created = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: "root",
			path,
		});
		if (created._nay) throw new Error(created._nay.message);
		folders.push(created._yay.nodeId);
	}
	const thread = await asUser.mutation(api.ai_chat.thread_create, {
		membershipId: db.membershipId,
		clientGeneratedId: "copy-review-driver",
		lastMessageAt: Date.now(),
	});
	if (thread._nay) throw new Error(thread._nay.message);
	const copied = await t.mutation(internal.files_transfer.start_for_agent, {
		membershipId: db.membershipId,
		threadId: thread._yay.threadId,
		requestId: "copy-review-driver",
		kind: "copy",
		sourceWorkspace: "current",
		destinationWorkspace: "current",
		expectedSourceCount: 1,
		sources: [{ kind: "saved", id: folders[0]! }],
		targetParent: { kind: "saved", id: folders[2]! },
		targetPath: "/target",
		targetName: null,
		missingParentNames: [],
		conflictPolicy: { file: "error", folder: "error" },
	});
	if (copied._nay) throw new Error(copied._nay.message);
	expect(await t.mutation(internal.files_transfer.seal_for_agent, {
		membershipId: db.membershipId,
		threadId: thread._yay.threadId,
		runId: copied._yay.runId,
	})).toEqual({ _yay: null });
	await test_finish_transfer_run(asUser, copied._yay.runId);
	expect(await t.run(ctx => ctx.db.get("activities", copied._yay.activityId))).toMatchObject({ status: "succeeded", progress: { completed: 2 } });
	// This native Copy produces exactly the two proposals selected below.
	const proposals = await t.run(ctx => ctx.db.query("files_pending_updates").collect());
	expect(proposals).toHaveLength(2);
	expect(proposals.every(proposal => proposal.copiedFrom && proposal.createIntent?.kind === "folder")).toBe(true);
	const started = await asUser.mutation(api.files_pending_update_runs.start, {
		membershipId: db.membershipId,
		requestId: "save-copy-driver",
		kind: "accept",
		expectedItemCount: 2,
		items: proposals.toReversed().map(proposal => ({ pendingUpdateId: proposal._id, reviewedRevision: proposal.revision, selectedContentStateId: null })),
	});
	if (started._nay) throw new Error(started._nay.message);
	const { runId, activityId } = started._yay;
	expect(await asUser.mutation(api.files_pending_update_runs.seal, { membershipId: db.membershipId, runId })).toEqual({ _yay: null });
	const now = Date.now();
	let scheduleOnlyAdvances = 0;
	test_spy_handler((await import("./files_pending_update_runs.ts")).advance, async (handler, ctx, args) => {
		if ((args as { runId: typeof runId }).runId === runId) {
			const unit = await ctx.db.query("files_pending_update_run_units")
				.withIndex("by_run_status_deleteLast_order", q => q.eq("runId", runId).eq("status", "preparing")).first();
			const cohort = unit?.cohortId ? await ctx.db.get("files_move_cohorts", unit.cohortId) : null;
			if (cohort && cohort.phase !== "complete") scheduleOnlyAdvances++;
		}
		return await handler(ctx, args);
	});
	const cohortIds = new Set<string>();
	test_spy_handler((await import("./files_move_run.ts")).run, async (handler, ctx, args) => {
		cohortIds.add((args as { cohortId: string }).cohortId);
		return await handler(ctx, args);
	});
	const run = asUser.run;
	let earlyCompletionProbes = 0;
	asUser.run = async <Output>(func: Parameters<typeof run<Output>>[0]) => {
		const result = await run(func);
		// Check outside the worker so an action cannot hide this failure.
		expect(scheduleOnlyAdvances, "Running cohort pages must not add schedule-only Review advances").toBe(0);
		if (result !== null && typeof result === "object" && "_id" in result &&
			typeof result._id === "string" && cohortIds.has(result._id) && "workPhase" in result &&
			result.workPhase !== "release" && result.workPhase !== "complete") earlyCompletionProbes++;
		expect(earlyCompletionProbes, "Review completion must not probe an owned cohort before release").toBe(0);
		return result;
	};
	const finished = (async () => {
		await test_finish_pending_update_run(asUser, runId);
		return await t.run(ctx => ctx.db.get("activities", activityId));
	})();
	try {
		await finished.catch(() => undefined);
	} finally {
		asUser.run = run;
	}
	expect(scheduleOnlyAdvances, "Running cohort pages must not add schedule-only Review advances").toBe(0);
	expect(earlyCompletionProbes, "Review completion must not probe an owned cohort before release").toBe(0);
	await expect(finished, "Copy Review must finish both parent-first units after its dependency page").resolves.toMatchObject({
		status: "succeeded",
		progress: { completed: 2, blocked: 0, failed: 0, canceled: 0 },
	});
	expect(await t.run(ctx => ctx.db.get("files_pending_update_runs", runId))).toMatchObject({ unitCount: 2, finishedUnitCount: 2 });
	expect(await t.run(ctx => ctx.db.query("files_pending_node_publish_receipts").collect())).toHaveLength(2);
	expect(await t.run(ctx => ctx.db.query("files_pending_updates").collect())).toEqual([]);
	expect((await t.run(ctx => ctx.db.query("files_nodes").collect())).map(node => node.path).sort()).toEqual([
		"/source", "/source/child", "/target", "/target/source", "/target/source/child",
	]);
	expect(Date.now()).toBe(now);
});
