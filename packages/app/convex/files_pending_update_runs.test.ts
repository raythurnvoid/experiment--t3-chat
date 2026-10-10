import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Workpool } from "@convex-dev/workpool";
import { getFunctionName, type FunctionReturnType } from "convex/server";
import { api, components, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { test_convex, test_move_nodes, test_mocks, test_mocks_fill_db_with } from "./setup.test.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";
import {
	files_pending_update_runs_db_delete_run_batch,
	files_pending_update_runs_db_record_cohort_publication,
} from "./files_pending_update_runs.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

async function fixture() {
	const t = test_convex({ transactionLimits: true });
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId };
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	return { t, db, scope, asUser };
}

async function private_folder(f: Awaited<ReturnType<typeof fixture>>, path: string) {
	const created = await f.t.mutation(internal.files_nodes.create_private_node_by_path, {
		...f.scope,
		kind: "folder",
		path,
	});
	if (created._nay || !created._yay.pendingUpdateId) throw new Error("Expected a private folder");
	const proposal = await f.t.run((ctx) => ctx.db.get("files_pending_updates", created._yay.pendingUpdateId!));
	if (!proposal) throw new Error("Expected the new proposal");
	return proposal;
}

async function saved_folder(f: Awaited<ReturnType<typeof fixture>>, name: string) {
	return await f.t.run((ctx) =>
		ctx.db.insert("files_nodes", {
			...test_mocks.files.base(),
			organizationId: f.scope.organizationId,
			workspaceId: f.scope.workspaceId,
			createdBy: f.scope.userId,
			updatedBy: f.scope.userId,
			parentId: "root",
			name,
			path: `/${name}`,
			treePath: `/${name}/`,
		}),
	);
}

async function start_review(args: {
	f: Awaited<ReturnType<typeof fixture>>;
	kind: "accept" | "discard";
	proposals: Doc<"files_pending_updates">[];
	/** Parent folders that Discard removes only when nothing else is left inside. */
	onlyIfEmpty?: Doc<"files_pending_updates">[];
	plan?: boolean;
}) {
	const { f, kind, proposals, onlyIfEmpty = [], plan = true } = args;

	const started = await f.asUser.mutation(api.files_pending_update_runs.start, {
		membershipId: f.db.membershipId,
		requestId: crypto.randomUUID(),
		kind,
		expectedItemCount: onlyIfEmpty.length + proposals.length,
		items: [
			...onlyIfEmpty.map((proposal) => ({
				pendingUpdateId: proposal._id,
				reviewedRevision: proposal.revision,
				selectedContentStateId: null,
				onlyIfEmpty: true as const,
			})),
			...proposals.map((proposal) => ({
				pendingUpdateId: proposal._id,
				reviewedRevision: proposal.revision,
				selectedContentStateId: kind === "accept" ? (proposal.content?.unstagedStateId ?? null) : null,
			})),
		],
	});
	if (started._nay) throw new Error(started._nay.message);
	const sealed = await f.asUser.mutation(api.files_pending_update_runs.seal, {
		membershipId: f.db.membershipId,
		runId: started._yay.runId,
	});
	expect(sealed).toEqual({ _yay: null });
	if (plan)
		for (let pass = 0; pass < 1_000; pass++) {
			const job = await f.t.run((ctx) =>
				ctx.db
					.query("files_pending_overlay_jobs")
					.withIndex("by_org_ws", (q) =>
						q.eq("organizationId", f.scope.organizationId).eq("workspaceId", f.scope.workspaceId),
					)
					.first(),
			);
			if (job)
				await f.t.mutation(internal.files_pending_overlay.run_job, {
					kind: job.kind,
					key: job.key,
					nextAttemptAt: job.nextAttemptAt,
				});
			else await f.t.action(internal.files_pending_update_runs.plan, { runId: started._yay.runId, fence: 0 });
			const run = await f.t.run((ctx) => ctx.db.get("files_pending_update_runs", started._yay.runId));
			if (run?.step !== "planning") break;
			if (pass === 999) throw new Error("Review planning did not finish");
		}
	return started._yay;
}

async function finish_review(f: Awaited<ReturnType<typeof fixture>>, runId: Id<"files_pending_update_runs">) {
	for (let pass = 0; pass < 10_000; pass++) {
		await f.t.mutation(internal.files_pending_update_runs.advance, { runId });
		const run = await f.t.run((ctx) => ctx.db.get("files_pending_update_runs", runId));
		if (!run) throw new Error("Expected the review run");
		if (run.step === "finished")
			return await f.asUser.query(api.files_pending_update_runs.get, { membershipId: f.db.membershipId, runId });
		const unit = await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_update_run_units")
				.withIndex("by_run_status_deleteLast_order", (q) => q.eq("runId", runId).eq("status", "preparing"))
				.first(),
		);
		if (!unit) continue;
		if (unit.kind === "cohort") {
			if (!unit.cohortId) continue;
			const cohort = await f.t.run((ctx) => ctx.db.get("files_move_cohorts", unit.cohortId!));
			if (!cohort) throw new Error("Expected the review cohort");
			if (cohort.phase === "complete")
				await f.t.mutation(internal.files_pending_update_runs.settle_cohort, { cohortId: cohort._id });
			else await f.t.action(internal.files_move_cohorts.run, { cohortId: cohort._id, step: cohort.step });
			continue;
		}
		await f.t.action(internal.files_pending_update_runs.prepare_unit, {
			runId,
			fence: run.fence,
			unitId: unit._id,
			attemptFence: unit.attemptFence,
		});
	}
	throw new Error("Review did not finish");
}

describe("review jobs", () => {
	test("routes Accept to one durable cohort and aborts it before releasing review holds", async () => {
		const f = await fixture();
		const proposal = await private_folder(f, "/cohort-draft");
		const enqueue = vi.spyOn(Workpool.prototype, "enqueueAction");
		const review = await start_review({ f, kind: "accept", proposals: [proposal] });
		await f.t.mutation(internal.files_pending_update_runs.advance, { runId: review.runId });
		const unit = await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_update_run_units")
				.withIndex("by_run_order", (q) => q.eq("runId", review.runId))
				.unique(),
		);
		if (!unit?.cohortId) throw new Error("Expected the durable review cohort");
		expect(unit.kind, "Accept uses the cohort executor").toBe("cohort");
		expect(enqueue).not.toHaveBeenCalled();
		await f.t.action(internal.files_pending_update_runs.prepare_unit, {
			runId: review.runId,
			fence: 0,
			unitId: unit._id,
			attemptFence: unit.attemptFence,
		});
		expect(await f.t.run((ctx) => ctx.db.query("files_move_cohorts").collect())).toHaveLength(1);
		await f.asUser.mutation(api.activities.request_stop, {
			membershipId: f.db.membershipId,
			activityId: review.activityId,
		});
		const stopped = await f.t.run((ctx) => ctx.db.get("files_move_cohorts", unit.cohortId!));
		expect(stopped?.phase, "Stop reaches the unpublished cohort").toBe("aborting");
		await f.t.run((ctx) => ctx.db.patch("files_move_cohorts", unit.cohortId!, { phase: "complete" }));
		await f.t.mutation(internal.files_pending_update_runs.settle_cohort, { cohortId: unit.cohortId });
		const activity = await f.t.run((ctx) => ctx.db.get("activities", review.activityId));
		expect(activity?.progress).toMatchObject({ completed: 0, canceled: 1, blocked: 0 });
	});

	test("counts cohort publication once and keeps it after Stop during repair", async () => {
		const f = await fixture();
		const proposal = await private_folder(f, "/published-cohort");
		const review = await start_review({ f, kind: "accept", proposals: [proposal] });
		await f.t.mutation(internal.files_pending_update_runs.advance, { runId: review.runId });
		const unit = await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_update_run_units")
				.withIndex("by_run_order", (q) => q.eq("runId", review.runId))
				.unique(),
		);
		if (!unit?.cohortId) throw new Error("Expected the durable review cohort");
		// Exercise the publication callback before the separate repair callback.
		await f.t.run(async (ctx) => {
			await ctx.db.patch("files_move_cohorts", unit.cohortId!, {
				publishedAt: Date.now(),
				phase: "published",
				visibleView: "after",
			});
			await files_pending_update_runs_db_record_cohort_publication(ctx, { cohortId: unit.cohortId! });
			await files_pending_update_runs_db_record_cohort_publication(ctx, { cohortId: unit.cohortId! });
		});
		expect(
			(await f.t.run((ctx) => ctx.db.get("activities", review.activityId)))?.progress?.completed,
			"publication is counted before repair finishes",
		).toBe(1);
		expect((await f.t.run((ctx) => ctx.db.get("files_pending_update_run_units", unit._id)))?.status).toBe("preparing");
		await f.asUser.mutation(api.activities.request_stop, {
			membershipId: f.db.membershipId,
			activityId: review.activityId,
		});
		expect((await f.t.run((ctx) => ctx.db.get("files_move_cohorts", unit.cohortId!)))?.phase).toBe("published");
		await f.t.run((ctx) => ctx.db.patch("files_move_cohorts", unit.cohortId!, { phase: "complete" }));
		await f.t.mutation(internal.files_pending_update_runs.settle_cohort, { cohortId: unit.cohortId });
		await f.t.mutation(internal.files_pending_update_runs.settle_cohort, { cohortId: unit.cohortId });
		expect(
			(await f.t.run((ctx) => ctx.db.get("activities", review.activityId)))?.progress,
			"Stop and repair do not count publication twice",
		).toMatchObject({ completed: 1, canceled: 0, blocked: 0 });
		expect((await f.t.run((ctx) => ctx.db.get("files_pending_update_run_units", unit._id)))?.status).toBe("completed");
	});

	test("keeps review history until its active cohort finishes repair", async () => {
		const f = await fixture();
		const proposal = await private_folder(f, "/cleanup-cohort");
		const review = await start_review({ f, kind: "accept", proposals: [proposal] });
		await f.t.mutation(internal.files_pending_update_runs.advance, { runId: review.runId });
		const unit = await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_update_run_units")
				.withIndex("by_run_order", (q) => q.eq("runId", review.runId))
				.unique(),
		);
		if (!unit?.cohortId) throw new Error("Expected the review cohort");
		const before = await f.t.run(async (ctx) => ({
			items: await ctx.db.query("files_pending_update_run_items").collect(),
			plans: await ctx.db.query("files_pending_update_plans").collect(),
			holds: await ctx.db.query("files_pending_holds").collect(),
		}));
		expect(await f.t.run((ctx) => files_pending_update_runs_db_delete_run_batch(ctx, { runId: review.runId }))).toEqual(
			{ done: false, deletedCount: 0 },
		);
		expect((await f.t.run((ctx) => ctx.db.get("files_move_cohorts", unit.cohortId!)))?.phase).toBe("aborting");
		expect(
			await f.t.run(async (ctx) => ({
				items: await ctx.db.query("files_pending_update_run_items").collect(),
				plans: await ctx.db.query("files_pending_update_plans").collect(),
				holds: await ctx.db.query("files_pending_holds").collect(),
			})),
			"repair keeps the review rows and holds",
		).toEqual(before);
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_update_run_units", unit._id))).toEqual(unit);
		// The cohort worker owns repair. This test starts history cleanup after its completion callback.
		await f.t.run((ctx) => ctx.db.patch("files_move_cohorts", unit.cohortId!, { phase: "complete" }));
		for (let pass = 0; pass < 100; pass++) {
			const result = await f.t.run((ctx) =>
				files_pending_update_runs_db_delete_run_batch(ctx, { runId: review.runId }),
			);
			if (result.done) {
				expect(
					await f.t.run((ctx) => ctx.db.get("files_pending_update_runs", review.runId)),
					"completed repair allows history cleanup",
				).toBeNull();
				expect(await f.t.run((ctx) => ctx.db.query("files_pending_update_plans").collect())).toEqual([]);
				return;
			}
		}
		throw new Error("Review cleanup did not finish");
	});

	test("queues preparation in the shared two-worker pool and cancels it on Stop", async () => {
		const base = await fixture();
		const enqueue = vi.spyOn(Workpool.prototype, "enqueueAction");
		const cancel = vi.spyOn(Workpool.prototype, "cancel");
		const runs = [];
		for (let index = 0; index < 3; index++) {
			const db = await base.t.run((ctx) =>
				test_mocks_fill_db_with.membership(ctx, { organizationName: `worker-${index}` }),
			);
			const f = {
				t: base.t,
				db,
				scope: { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId },
				asUser: base.t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId }),
			};
			const proposal = await private_folder(f, "/draft");
			const run = await start_review({ f, kind: "discard", proposals: [proposal] });
			await f.t.mutation(internal.files_pending_update_runs.advance, { runId: run.runId });
			runs.push({ f, ...run });
		}
		const calls = enqueue.mock.calls.flatMap((call, index) =>
			getFunctionName(call[1]) === "files_pending_update_runs:prepare_unit" ? [index] : [],
		);
		expect(calls).toHaveLength(3);
		const pool = new Workpool(components.files_transfer_workpool, {});
		for (const index of calls) {
			const queue = enqueue.mock.contexts[index];
			if (!(queue instanceof Workpool)) throw new Error("Expected the review Workpool");
			expect(queue.options.maxParallelism).toBe(2);
			const workId = await enqueue.mock.results[index]!.value;
			expect(await base.t.query((ctx) => pool.status(ctx, workId))).toMatchObject({ state: "pending" });
		}
		const first = runs[0]!;
		expect(
			await first.f.asUser.mutation(api.activities.request_stop, {
				membershipId: first.f.db.membershipId,
				activityId: first.activityId,
			}),
		).toEqual({ _yay: null });
		const firstWorkId = await enqueue.mock.results[calls[0]!]!.value;
		expect(cancel.mock.calls.map((call) => call[1])).toEqual([firstWorkId]);
		const firstUnit = await base.t.run((ctx) =>
			ctx.db
				.query("files_pending_update_run_units")
				.withIndex("by_run_order", (q) => q.eq("runId", first.runId))
				.unique(),
		);
		await base.t.action(internal.files_pending_update_runs.prepare_unit, {
			runId: first.runId,
			fence: 0,
			unitId: firstUnit!._id,
			attemptFence: firstUnit!.attemptFence,
		});
		expect(await base.t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual([]);
		const scheduled = await base.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
		expect(scheduled.filter((job) => job.name === "files_pending_update_runs:prepare_unit")).toEqual([]);
	});

	test("returns the active IDs when the review lane is busy", async () => {
		const f = await fixture();
		const first = await private_folder(f, "/first");
		const second = await private_folder(f, "/second");
		const running = await start_review({ f, kind: "accept", proposals: [first] });
		const reply = await f.asUser.mutation(api.files_pending_update_runs.start, {
			membershipId: f.db.membershipId,
			requestId: crypto.randomUUID(),
			kind: "accept",
			expectedItemCount: 1,
			items: [{ pendingUpdateId: second._id, reviewedRevision: second.revision, selectedContentStateId: null }],
		});
		expect(reply._nay).toMatchObject({ name: "busy", data: running });
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_update_runs").collect())).toHaveLength(1);
	});

	test("lets a Copy start while a review is running", async () => {
		const f = await fixture();
		const first = await private_folder(f, "/first");
		const running = await start_review({ f, kind: "discard", proposals: [first] });
		const source = await saved_folder(f, "source");
		const target = await saved_folder(f, "target");

		// Each lane admits its own job. They only meet later, in the shared two-worker pool.
		const copy = await f.asUser.mutation(api.files_transfer.start, {
			membershipId: f.db.membershipId,
			requestId: "copy-next-to-review",
			kind: "copy",
			expectedSourceCount: 1,
			sourceIds: [source],
			targetParentId: target,
		});
		expect(copy._nay).toBeUndefined();
		if (copy._nay) return;
		const active = await f.asUser.query(api.activities.list_page, {
			membershipId: f.db.membershipId,
			section: "active",
			paginationOpts: { cursor: null, numItems: 50 },
		});
		expect(active.page.map((activity) => activity.source.id).sort()).toEqual([running.runId, copy._yay.runId].sort());
	});

	test("replays a repeated review request and page and refuses a changed one", async () => {
		const f = await fixture();
		const first = await private_folder(f, "/first");
		const second = await private_folder(f, "/second");
		const item = (proposal: Doc<"files_pending_updates">) => ({
			pendingUpdateId: proposal._id,
			reviewedRevision: proposal.revision,
			selectedContentStateId: null,
		});
		const args = {
			membershipId: f.db.membershipId,
			requestId: "review-request",
			kind: "discard" as const,
			expectedItemCount: 2,
			items: [item(first)],
		};

		// A retried send must land on the same run instead of starting a second review.
		const started = await f.asUser.mutation(api.files_pending_update_runs.start, args);
		if (started._nay) throw new Error(started._nay.message);
		expect(await f.asUser.mutation(api.files_pending_update_runs.start, args)).toEqual(started);
		expect(
			(await f.asUser.mutation(api.files_pending_update_runs.start, { ...args, items: [item(second)] }))._nay,
		).toMatchObject({ name: "request_changed", message: "This request ID was already used for a different review." });

		// The same page sent twice is one receipt, but the same position with other changes is not.
		const page = { membershipId: f.db.membershipId, runId: started._yay.runId, offset: 1, items: [item(second)] };
		expect(await f.asUser.mutation(api.files_pending_update_runs.append_items, page)).toEqual({ _yay: null });
		expect(await f.asUser.mutation(api.files_pending_update_runs.append_items, page)).toEqual({ _yay: null });
		expect(
			(await f.asUser.mutation(api.files_pending_update_runs.append_items, { ...page, items: [item(first)] }))._nay,
		).toMatchObject({
			name: "request_changed",
			message: "This review page was already sent with different changes.",
		});

		const run = await f.t.run((ctx) => ctx.db.get("files_pending_update_runs", started._yay.runId));
		expect(run).toMatchObject({ itemCount: 2 });
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_update_run_items").collect())).toHaveLength(2);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_update_runs").collect())).toHaveLength(1);
	});

	test.each(["accept", "discard"] as const)(
		"keeps unchanged units after an unrelated owner edit (%s)",
		async (kind) => {
			const f = await fixture();
			const first = await private_folder(f, "/first");
			const second = await private_folder(f, "/second");
			const { runId } = await start_review({ f, kind, proposals: [first, second] });
			const unrelated = await private_folder(f, "/unrelated");
			const result = await finish_review(f, runId);
			expect(result?.activity).toMatchObject({ status: "succeeded", progress: { completed: 2 } });
			expect(result?.run).toMatchObject({ unitCount: 2, finishedUnitCount: 2 });
			expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", unrelated._id))).toEqual(unrelated);
			const nodes = await f.t.run((ctx) => ctx.db.query("files_nodes").collect());
			expect(nodes.map((node) => node.path).sort()).toEqual(kind === "accept" ? ["/first", "/second"] : []);
		},
	);

	test("rechecks later private Discard units after an earlier unit adopts the changed owner clock", async () => {
		const f = await fixture();
		const first = await private_folder(f, "/first");
		const parent = await private_folder(f, "/parent");
		const children = [];
		for (let index = 0; index < 10; index++) children.push(await private_folder(f, `/parent/child-${index}`));
		const { runId } = await start_review({ f, kind: "discard", proposals: [first, parent, ...children] });
		const unselected = await private_folder(f, "/parent/new-child");
		const result = await finish_review(f, runId);
		expect(result?.activity).toMatchObject({ status: "partial", progress: { completed: 1, blocked: 11 } });
		expect(result?.run.needsReviewIds).toEqual([unselected._id]);
		const nodes = await f.t.run((ctx) => ctx.db.query("files_pending_nodes").collect());
		expect(nodes.filter((node) => node.state === "discarded").map((node) => node.name)).toEqual(["first"]);
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", unselected._id))).toEqual(unselected);
	});

	test("blocks a changed reviewed revision after an unrelated unit commits", async () => {
		const f = await fixture();
		const first = await private_folder(f, "/first");
		const second = await private_folder(f, "/second");
		const { runId } = await start_review({ f, kind: "accept", proposals: [first, second] });
		expect(
			(
				await f.t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
					...f.scope,
					target: second.target,
					destParent: { kind: "root" },
					destName: "changed",
				})
			)._nay,
		).toBeUndefined();
		const result = await finish_review(f, runId);
		expect(result?.activity).toMatchObject({ status: "partial", progress: { completed: 1, blocked: 1 } });
		expect(await f.t.run((ctx) => ctx.db.query("files_nodes").collect())).toMatchObject([{ path: "/first" }]);
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", second._id))).toMatchObject({
			revision: second.revision + 1,
		});
	});

	test("does not revalidate later units for this run's own commits", async () => {
		const f = await fixture();
		const first = await private_folder(f, "/first");
		const second = await private_folder(f, "/second");
		const { runId } = await start_review({ f, kind: "accept", proposals: [first, second] });
		const result = await finish_review(f, runId);
		expect(result?.activity).toMatchObject({ status: "succeeded", progress: { completed: 2 } });
		expect(result?.run).toMatchObject({ revalidateRemaining: false, unitCount: 2 });
	});

	test.each(["selection page", "proposal page", "seal", "commit"] as const)(
		"does not adopt a clock change at the %s",
		async (at) => {
			const f = await fixture();
			const parent = await private_folder(f, "/parent");
			const children = [];
			for (let index = 0; index < 10; index++) children.push(await private_folder(f, `/parent/child-${index}`));
			const { runId } = await start_review({ f, kind: "discard", proposals: [parent, ...children] });
			await private_folder(f, "/unrelated");
			await f.t.mutation(internal.files_pending_update_runs.advance, { runId });
			const unit = await f.t.run((ctx) => ctx.db.query("files_pending_update_run_units").first());
			if (!unit) throw new Error("Expected a review unit");
			const worker = { runId, fence: 0, unitId: unit._id, attemptFence: unit.attemptFence };
			const review = await f.t.mutation(internal.files_pending_update_runs.begin_unit_review, worker);
			if (review._nay) throw new Error(review._nay.message);
			expect(review._yay.required).toBe(true);
			const revalidation = {
				unitId: unit._id,
				attemptFence: unit.attemptFence,
				reviewVersion: review._yay.reviewVersion,
			};
			let selectionCursor: string | null = null;
			while (true) {
				const page: FunctionReturnType<typeof internal.files_pending_update_runs.get_plan_selection_page> =
					await f.t.query(internal.files_pending_update_runs.get_plan_selection_page, {
						runId,
						fence: 0,
						revalidation,
						cursor: selectionCursor,
					});
				if (page._nay) throw new Error(page._nay.message);
				selectionCursor = page._yay.continueCursor;
				if (page._yay.isDone || at === "selection page") break;
			}
			let proposalCursor: string | null = null;
			if (at !== "selection page")
				while (true) {
					const page: FunctionReturnType<typeof internal.files_pending_update_runs.get_plan_proposals_page> =
						await f.t.query(internal.files_pending_update_runs.get_plan_proposals_page, {
							runId,
							fence: 0,
							revalidation,
							cursor: proposalCursor,
						});
					if (page._nay) throw new Error(page._nay.message);
					proposalCursor = page._yay.continueCursor;
					if (page._yay.isDone || at === "proposal page") break;
				}
			if (at === "commit")
				expect(
					await f.t.mutation(internal.files_pending_update_runs.seal_unit_review, {
						runId,
						fence: 0,
						...revalidation,
					}),
				).toEqual({ _yay: null });
			const unselected = await private_folder(f, "/parent/new-child");
			if (at === "selection page" || at === "proposal page") {
				const page =
					at === "selection page"
						? await f.t.query(internal.files_pending_update_runs.get_plan_selection_page, {
								runId,
								fence: 0,
								revalidation,
								cursor: selectionCursor,
							})
						: await f.t.query(internal.files_pending_update_runs.get_plan_proposals_page, {
								runId,
								fence: 0,
								revalidation,
								cursor: proposalCursor,
							});
				expect(page._nay).toMatchObject({ name: "review_changed" });
			}
			if (at === "seal")
				expect(
					await f.t.mutation(internal.files_pending_update_runs.seal_unit_review, {
						runId,
						fence: 0,
						...revalidation,
					}),
				).toMatchObject({ _nay: { name: "review_changed" } });
			await expect(f.t.mutation(internal.files_pending_update_runs.commit_unit, worker)).rejects.toThrow(
				"Pending changes changed",
			);
			await f.t.mutation(internal.files_pending_update_runs.fail_unit, {
				...worker,
				code: "review_changed",
				message: "Retry this selection.",
			});
			const result = await finish_review(f, runId);
			expect(result?.activity).toMatchObject({ status: "failed", progress: { completed: 0, blocked: 11 } });
			expect(result?.run.needsReviewIds).toEqual([unselected._id]);
			expect(
				(await f.t.run((ctx) => ctx.db.query("files_pending_nodes").collect())).every(
					(node) => node.state === "active",
				),
			).toBe(true);
		},
	);

	test("bounds repeated clock changes to three attempts", async () => {
		const f = await fixture();
		const parent = await private_folder(f, "/parent");
		const { runId } = await start_review({ f, kind: "discard", proposals: [parent] });
		for (let index = 0; index < 3; index++) {
			await f.t.mutation(internal.files_pending_update_runs.advance, { runId });
			const unit = await f.t.run((ctx) => ctx.db.query("files_pending_update_run_units").first());
			if (!unit) throw new Error("Expected a review unit");
			const worker = { runId, fence: 0, unitId: unit._id, attemptFence: unit.attemptFence };
			const review = await f.t.mutation(internal.files_pending_update_runs.begin_unit_review, worker);
			if (review._nay) throw new Error(review._nay.message);
			if (review._yay.required) {
				const revalidation = {
					unitId: unit._id,
					attemptFence: unit.attemptFence,
					reviewVersion: review._yay.reviewVersion,
				};
				for (const query of [
					internal.files_pending_update_runs.get_plan_selection_page,
					internal.files_pending_update_runs.get_plan_proposals_page,
				]) {
					expect(await f.t.query(query, { runId, fence: 0, revalidation, cursor: null })).toMatchObject({
						_yay: { isDone: true },
					});
				}
				expect(
					await f.t.mutation(internal.files_pending_update_runs.seal_unit_review, { runId, fence: 0, ...revalidation }),
				).toEqual({ _yay: null });
			}
			await private_folder(f, `/unrelated-${index}`);
			await expect(f.t.mutation(internal.files_pending_update_runs.commit_unit, worker)).rejects.toThrow(
				"Pending changes changed",
			);
			await f.t.mutation(internal.files_pending_update_runs.fail_unit, {
				...worker,
				code: "review_changed",
				message: "Retry this selection.",
			});
		}
		const result = await finish_review(f, runId);
		expect(result?.activity).toMatchObject({ status: "failed", progress: { completed: 0, blocked: 1 } });
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_update_run_units").collect())).toMatchObject([
			{ status: "blocked", attemptCount: 3, errorCode: "needs_review" },
		]);
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", parent._id))).toEqual(parent);
	});

	test.each([false, true])(
		"requires the moved child archive in the selected set (included: %s)",
		async (includeChild) => {
			const f = await fixture();
			const nodes = await f.t.run(async (ctx) => {
				const base = {
					...test_mocks.files.base(),
					organizationId: f.scope.organizationId,
					workspaceId: f.scope.workspaceId,
					createdBy: f.scope.userId,
					updatedBy: f.scope.userId,
				};
				const destinationId = await ctx.db.insert("files_nodes", {
					...base,
					parentId: "root",
					name: "a",
					sortName: files_sort_text_key("a"),
					path: "/a",
					treePath: "/a/",
				});
				const sourceId = await ctx.db.insert("files_nodes", {
					...base,
					parentId: "root",
					name: "b",
					sortName: files_sort_text_key("b"),
					path: "/b",
					treePath: "/b/",
				});
				const childId = await ctx.db.insert("files_nodes", {
					...base,
					parentId: sourceId,
					name: "child",
					sortName: files_sort_text_key("child"),
					path: "/b/child",
					treePath: "/b/child/",
					pathDepth: 2,
				});
				return { destinationId, sourceId, childId };
			});
			const childArchive = await f.t.mutation(internal.files_pending_updates.upsert_file_pending_archive_in_db, {
				...f.scope,
				target: { kind: "saved", id: nodes.childId },
			});
			expect(childArchive._nay).toBeUndefined();
			expect(
				(
					await f.t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
						...f.scope,
						target: { kind: "saved", id: nodes.sourceId },
						destParent: { kind: "saved", id: nodes.destinationId },
						destName: "b",
					})
				)._nay,
			).toBeUndefined();
			expect(
				(
					await f.t.mutation(internal.files_pending_updates.upsert_file_pending_archive_in_db, {
						...f.scope,
						target: { kind: "saved", id: nodes.destinationId },
					})
				)._nay,
			).toBeUndefined();
			const proposals = await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect());
			const child = proposals.find((proposal) => proposal.target.id === nodes.childId)!;
			const before = await f.t.run((ctx) => ctx.db.query("files_nodes").collect());
			const { runId } = await start_review({
				f,
				kind: "accept",
				proposals: proposals.filter((proposal) => includeChild || proposal._id !== child._id),
			});
			const result = await finish_review(f, runId);
			if (includeChild) {
				const units = await f.t.run((ctx) => ctx.db.query("files_pending_update_run_units").collect());
				expect(units).toMatchObject([{ status: "completed", errorMessage: null }]);
				expect(result?.activity).toMatchObject({ status: "succeeded", progress: { completed: 3 } });
				expect(await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect())).toEqual([]);
				const saved = await f.t.run((ctx) => ctx.db.query("files_nodes").collect());
				expect(saved).toHaveLength(3);
				expect(saved.every((node) => node.archiveOperationId !== null)).toBe(true);
				return;
			}
			// Only the ordinary unit waits. The unselected child is reported, never added to the Save.
			expect(result?.activity).toMatchObject({ status: "failed", progress: { completed: 0 } });
			expect(await f.t.run((ctx) => ctx.db.query("files_pending_update_run_units").collect())).toMatchObject([
				{ status: "blocked", errorCode: "needs_review" },
			]);
			expect(result?.run.needsReviewIds).toEqual([child._id]);
			expect(await f.t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(before);
			expect(await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect())).toEqual(proposals);
		},
	);

	test("saves a private parent and child in one unit, regardless of selection order", async () => {
		const f = await fixture();
		const parent = await private_folder(f, "/parent");
		const child = await private_folder(f, "/parent/child");
		const { runId } = await start_review({ f, kind: "accept", proposals: [child, parent] });
		const result = await finish_review(f, runId);
		expect(result?.activity).toMatchObject({ status: "succeeded", progress: { completed: 2 } });
		expect(result?.run).toMatchObject({ unitCount: 1, finishedUnitCount: 1 });
		const saved = await f.t.run((ctx) => ctx.db.query("files_nodes").collect());
		expect(saved.map((node) => node.path).sort()).toEqual(["/parent", "/parent/child"]);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect())).toEqual([]);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect())).toHaveLength(2);
	});

	test("rechecks affected proposals when a saved move changes the archive's children", async () => {
		const f = await fixture();
		const parentId = await saved_folder(f, "parent");
		const childId = await saved_folder(f, "child");
		for (const id of [parentId, childId])
			expect(
				(
					await f.t.mutation(internal.files_pending_updates.upsert_file_pending_archive_in_db, {
						...f.scope,
						target: { kind: "saved", id },
					})
				)._nay,
			).toBeUndefined();
		const proposals = await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect());
		const parent = proposals.find((proposal) => proposal.target.id === parentId)!;
		const { runId } = await start_review({ f, kind: "accept", proposals: [parent] });
		const reviewVersion = await f.t.run((ctx) => ctx.db.query("files_pending_review_versions").first());
		expect(
			(
				await test_move_nodes(f.t, f.asUser, {
						membershipId: f.db.membershipId,
						itemIds: [childId],
						targetParentId: parentId,
					})
			)._nay,
		).toBeUndefined();
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_review_versions").first())).toEqual(reviewVersion);
		const beforeReview = await f.t.run((ctx) => ctx.db.query("files_nodes").collect());
		const result = await finish_review(f, runId);
		expect(result?.activity).toMatchObject({ status: "failed", progress: { completed: 0, blocked: 1 } });
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_update_run_units").collect())).toMatchObject([
			{ status: "blocked", errorCode: "needs_review" },
		]);
		expect(await f.t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(beforeReview);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect())).toEqual(proposals);
	});

	test("saves a reviewed private folder before archiving its saved parent", async () => {
		const f = await fixture();
		const parentId = await saved_folder(f, "parent");
		await private_folder(f, "/parent/child");
		expect(
			(
				await f.t.mutation(internal.files_pending_updates.upsert_file_pending_archive_in_db, {
					...f.scope,
					target: { kind: "saved", id: parentId },
				})
			)._nay,
		).toBeUndefined();
		const proposals = await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect());
		const { runId } = await start_review({ f, kind: "accept", proposals });
		const result = await finish_review(f, runId);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_update_run_units").collect())).toMatchObject([
			{ status: "completed", errorMessage: null },
		]);
		expect(result?.activity).toMatchObject({ status: "succeeded", progress: { completed: 2 } });
		const saved = await f.t.run((ctx) => ctx.db.query("files_nodes").collect());
		expect(saved.map((node) => node.path)).toEqual(["/parent", "/parent/child"]);
		// The archived parent and everything under it must share one archive operation, so a later
		// unarchive brings back exactly the nodes that went away together.
		const archiveOperationIds = new Set(saved.map((node) => node.archiveOperationId));
		expect(archiveOperationIds.size).toBe(1);
		expect(saved[0]?.archiveOperationId).not.toBeNull();
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect())).toEqual([]);
	});

	test("accepts a delete of x and a move of y onto the name x in one unit", async () => {
		const f = await fixture();
		const xId = await saved_folder(f, "x");
		const yId = await saved_folder(f, "y");
		expect(
			(
				await f.t.mutation(internal.files_pending_updates.upsert_file_pending_archive_in_db, {
					...f.scope,
					target: { kind: "saved", id: xId },
				})
			)._nay,
		).toBeUndefined();
		expect(
			(
				await f.t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
					...f.scope,
					target: { kind: "saved", id: yId },
					destParent: { kind: "root" },
					destName: "x",
				})
			)._nay,
		).toBeUndefined();
		const proposals = await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect());

		const { runId } = await start_review({ f, kind: "accept", proposals });
		const result = await finish_review(f, runId);

		expect(result?.activity).toMatchObject({ status: "succeeded", progress: { completed: 2 } });
		expect(result?.run).toMatchObject({ unitCount: 1, finishedUnitCount: 1 });
		const saved = await f.t.run((ctx) => ctx.db.query("files_nodes").collect());
		expect(saved.map((node) => [node._id, node.path, node.archiveOperationId !== null])).toEqual([
			[xId, "/x", true],
			[yId, "/x", false],
		]);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect())).toEqual([]);
	});

	test("a reviewed delete of a folder with many side docs archives its first step within the unit budget", async () => {
		const f = await fixture();
		const parentId = await saved_folder(f, "big");
		// 150 files with 20 metadata docs each: one archive step patches about 3,150 docs.
		await f.t.run(async (ctx) => {
			for (let index = 0; index < 150; index++) {
				const name = `f${String(index).padStart(3, "0")}.md`;
				const fileNodeId = await ctx.db.insert("files_nodes", {
					...test_mocks.files.base(),
					organizationId: f.scope.organizationId,
					workspaceId: f.scope.workspaceId,
					createdBy: f.scope.userId,
					updatedBy: f.scope.userId,
					parentId,
					name,
					sortName: files_sort_text_key(name),
					kind: "file",
					path: `/big/${name}`,
					treePath: `/big/${name}`,
					pathDepth: 2,
				});
				for (let field = 0; field < 20; field++) {
					await ctx.db.insert("files_metadata_docs", {
						organizationId: f.scope.organizationId,
						workspaceId: f.scope.workspaceId,
						fileNodeId,
						sourceKind: "committed",
						yjsSequence: 1,
						path: `/big/${name}`,
						treePath: `/big/${name}`,
						fieldPath: `frontmatter.tag${field}`,
						docKind: "field",
					});
				}
			}
		});
		expect(
			(
				await f.t.mutation(internal.files_pending_updates.upsert_file_pending_archive_in_db, {
					...f.scope,
					target: { kind: "saved", id: parentId },
				})
			)._nay,
		).toBeUndefined();
		const proposals = await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect());

		const { runId } = await start_review({ f, kind: "accept", proposals });
		await finish_review(f, runId);

		expect(await f.t.run((ctx) => ctx.db.query("files_pending_update_run_units").collect())).toMatchObject([
			{ status: "completed", errorMessage: null },
		]);
		// The archive job goes on in the background after the review.
		const archiveRun = await f.t.run((ctx) => ctx.db.query("files_archive_runs").first());
		expect(archiveRun?.active).toBe(true);
	});

	test("does not discard an unselected ready child", async () => {
		const f = await fixture();
		const parent = await private_folder(f, "/parent");
		const child = await private_folder(f, "/parent/child");
		const { runId } = await start_review({ f, kind: "discard", proposals: [parent] });
		const result = await finish_review(f, runId);
		expect(result?.activity).toMatchObject({ status: "failed", progress: { completed: 0, blocked: 1 } });
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_update_run_units").collect())).toMatchObject([
			{ status: "blocked", errorCode: "needs_review" },
		]);
		expect(result?.run.needsReviewIds).toEqual([child._id]);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_nodes").collect())).toMatchObject([
			{ state: "active" },
			{ state: "active" },
		]);
	});

	// Discard all sends the hidden parent folders of the shown drafts this way. The list may not show
	// every draft inside, for example another chat's.
	test("removes only-if-empty parent folders that end up empty, deepest first", async () => {
		const f = await fixture();
		const outer = await private_folder(f, "/f");
		const inner = await private_folder(f, "/f/g");
		const shown = await private_folder(f, "/f/g/x");
		// /k keeps its other draft, so only its empty inner folder goes.
		const keptOuter = await private_folder(f, "/k");
		const keptInner = await private_folder(f, "/k/g");
		const keptShown = await private_folder(f, "/k/g/x");
		await private_folder(f, "/k/other");
		const { runId } = await start_review({
			f,
			kind: "discard",
			proposals: [shown, keptShown],
			onlyIfEmpty: [outer, inner, keptOuter, keptInner],
		});
		expect((await finish_review(f, runId))?.activity.status).toBe("succeeded");
		const nodes = await f.t.run((ctx) => ctx.db.query("files_pending_nodes").collect());
		expect(nodes.map((node) => [node.name, node.state])).toEqual([
			["f", "discarded"],
			["g", "discarded"],
			["x", "discarded"],
			["k", "active"],
			["g", "discarded"],
			["x", "discarded"],
			["other", "active"],
		]);
	});

	test("keeps an only-if-empty parent folder that still holds another draft", async () => {
		const f = await fixture();
		const folder = await private_folder(f, "/qa");
		const shown = await private_folder(f, "/qa/x");
		await private_folder(f, "/qa/other-chat");
		const { runId } = await start_review({ f, kind: "discard", proposals: [shown], onlyIfEmpty: [folder] });
		expect((await finish_review(f, runId))?.activity.status).toBe("succeeded");
		const nodes = await f.t.run((ctx) => ctx.db.query("files_pending_nodes").collect());
		expect(Object.fromEntries(nodes.map((node) => [node.name, node.state]))).toEqual({
			qa: "active",
			x: "discarded",
			"other-chat": "active",
		});
	});

	test.each([
		{ discardMove: false, folderState: "active" },
		{ discardMove: true, folderState: "discarded" },
	])(
		"keeps an only-if-empty parent folder with a move into it unless that move is discarded too (discardMove: $discardMove)",
		async ({ discardMove, folderState }) => {
			const f = await fixture();
			const folder = await private_folder(f, "/qa");
			const shown = await private_folder(f, "/qa/x");
			const savedId = await saved_folder(f, "saved");
			const moved = await f.t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
				...f.scope,
				target: { kind: "saved", id: savedId },
				destParent: folder.target,
				destName: "saved",
			});
			expect(moved._nay).toBeUndefined();
			const move = await f.t.run((ctx) =>
				ctx.db
					.query("files_pending_updates")
					.filter((q) => q.eq(q.field("target.id"), savedId))
					.first(),
			);
			const { runId } = await start_review({
				f,
				kind: "discard",
				proposals: discardMove ? [move!, shown] : [shown],
				onlyIfEmpty: [folder],
			});
			expect((await finish_review(f, runId))?.activity.status).toBe("succeeded");
			const nodes = await f.t.run((ctx) => ctx.db.query("files_pending_nodes").collect());
			expect(Object.fromEntries(nodes.map((node) => [node.name, node.state]))).toEqual({
				qa: folderState,
				x: "discarded",
			});
		},
	);

	test("counts the whole approved Discard at the root fence and keeps cleanup running after Stop", async () => {
		const f = await fixture();
		const parent = await private_folder(f, "/parent");
		const child = await private_folder(f, "/parent/child");
		const { runId, activityId } = await start_review({ f, kind: "discard", proposals: [parent, child] });
		const result = await finish_review(f, runId);
		expect(result?.activity).toMatchObject({ status: "succeeded", progress: { completed: 2 } });
		const beforeCleanup = await f.t.run((ctx) => ctx.db.query("files_pending_nodes").collect());
		expect(beforeCleanup.map((node) => node.state)).toEqual(["discarded", "active"]);
		await f.asUser.mutation(api.activities.request_stop, { membershipId: f.db.membershipId, activityId });
		const task = await f.t.run((ctx) => ctx.db.query("files_pending_node_cleanup_tasks").first());
		if (!task) throw new Error("Expected durable cleanup");
		await f.t.mutation(internal.files_pending_nodes.cleanup_discarded_node, { privateNodeId: task.privateNodeId });
		if (child.target.kind !== "private") throw new Error("Expected a private child");
		const childId = child.target.id;
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_nodes", childId))).toMatchObject({ state: "discarded" });
		expect(
			(await f.asUser.query(api.files_pending_update_runs.get, { membershipId: f.db.membershipId, runId }))?.activity
				.status,
		).toBe("succeeded");
	});

	test("Stop before preparation leaves every private proposal pending", async () => {
		const f = await fixture();
		const parent = await private_folder(f, "/parent");
		const { runId, activityId } = await start_review({ f, kind: "accept", proposals: [parent] });
		await f.asUser.mutation(api.activities.request_stop, { membershipId: f.db.membershipId, activityId });
		await f.t.mutation(internal.files_pending_update_runs.advance, { runId });
		expect(
			(await f.asUser.query(api.files_pending_update_runs.get, { membershipId: f.db.membershipId, runId }))?.activity,
		).toMatchObject({ status: "canceled", progress: { completed: 0, canceled: 1 } });
		expect(await f.t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual([]);
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", parent._id))).toEqual(parent);
	});

	test("late planning delivery keeps the timeout result", async () => {
		const f = await fixture();
		const parent = await private_folder(f, "/parent");
		const { runId } = await start_review({ f, kind: "accept", proposals: [parent], plan: false });
		vi.setSystemTime(Date.now() + 30 * 60 * 1000);
		await f.t.action(internal.files_pending_update_runs.plan, { runId, fence: 0 });
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", parent._id))).toEqual(parent);
		expect(await f.t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual([]);
		const result = await f.asUser.query(api.files_pending_update_runs.get, { membershipId: f.db.membershipId, runId });
		expect(result?.activity).toMatchObject({
			status: "timed_out",
			progress: { completed: 0, blocked: 0, canceled: 1 },
		});
	});

	test.each([false, true])("late Discard preparation keeps its retry (watchdog first: %s)", async (watchdogFirst) => {
		const f = await fixture();
		const parent = await private_folder(f, "/parent");
		const { runId } = await start_review({ f, kind: "discard", proposals: [parent] });
		await f.t.mutation(internal.files_pending_update_runs.advance, { runId });
		const unit = await f.t.run((ctx) => ctx.db.query("files_pending_update_run_units").unique());
		if (!unit) throw new Error("Expected the first attempt");
		const delivery = { runId, fence: 0, unitId: unit._id, attemptFence: unit.attemptFence };
		vi.setSystemTime(Date.now() + 5 * 60 * 1000);
		if (watchdogFirst) await f.t.mutation(internal.files_pending_update_runs.advance, { runId });
		await f.t.action(internal.files_pending_update_runs.prepare_unit, delivery);
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", parent._id))).toEqual(parent);
		expect(await f.t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual([]);
		await f.t.mutation(internal.files_pending_update_runs.advance, { runId });
		const result = await finish_review(f, runId);
		expect(result?.activity).toMatchObject({ status: "succeeded", progress: { completed: 1 } });
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_update_run_units").unique())).toMatchObject({
			attemptCount: 2,
		});
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_nodes").collect())).toMatchObject([
			{ state: "discarded" },
		]);
	});

	test("stops after three expired Discard preparation attempts", async () => {
		const f = await fixture();
		const parent = await private_folder(f, "/parent");
		const { runId } = await start_review({ f, kind: "discard", proposals: [parent] });
		for (let attempt = 1; attempt <= 3; attempt++) {
			await f.t.mutation(internal.files_pending_update_runs.advance, { runId });
			const unit = await f.t.run((ctx) => ctx.db.query("files_pending_update_run_units").unique());
			if (!unit) throw new Error("Expected a preparation attempt");
			expect(unit.attemptCount).toBe(attempt);
			vi.setSystemTime(Date.now() + 5 * 60 * 1000);
			await f.t.action(internal.files_pending_update_runs.prepare_unit, {
				runId,
				fence: 0,
				unitId: unit._id,
				attemptFence: unit.attemptFence,
			});
			await f.t.mutation(internal.files_pending_update_runs.advance, { runId });
		}
		const result = await finish_review(f, runId);
		expect(result?.activity).toMatchObject({ status: "failed", progress: { completed: 0, failed: 1 } });
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_update_run_units").unique())).toMatchObject({
			attemptCount: 3,
			errorCode: "attempt_expired",
		});
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", parent._id))).toEqual(parent);
		expect(await f.t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual([]);
	});

	test("recovers a lost planning action and fences its old delivery", async () => {
		const f = await fixture();
		const parent = await private_folder(f, "/parent");
		const { runId } = await start_review({ f, kind: "accept", proposals: [parent], plan: false });
		vi.setSystemTime(Date.now() + 5 * 60 * 1000);
		await f.t.mutation(internal.files_pending_update_runs.recover, {});
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_update_runs", runId))).toMatchObject({
			step: "planning",
			planningAttempts: 2,
			fence: 1,
		});
		await f.t.action(internal.files_pending_update_runs.plan, { runId, fence: 0 });
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_update_run_units").collect())).toEqual([]);
		await f.t.action(internal.files_pending_update_runs.plan, { runId, fence: 1 });
		expect((await finish_review(f, runId))?.activity).toMatchObject({
			status: "succeeded",
			progress: { completed: 1 },
		});
		expect(await f.t.run((ctx) => ctx.db.query("files_nodes").collect())).toMatchObject([{ path: "/parent" }]);
	});

	test("keeps finished review history for seven days and removes it in batches", async () => {
		const f = await fixture();
		const parent = await private_folder(f, "/parent");
		const child = await private_folder(f, "/parent/child");
		const { runId, activityId } = await start_review({ f, kind: "accept", proposals: [parent, child] });
		const result = await finish_review(f, runId);
		if (!result) throw new Error("Expected the finished review");
		expect(result.activity.status).toBe("succeeded");
		expect(result.activity.expiresAt).toBe(result.activity.finishedAt! + 7 * 24 * 60 * 60 * 1000);
		const savedBefore = await f.t.run((ctx) => ctx.db.query("files_nodes").collect());
		const scheduledBefore = await f.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
		vi.setSystemTime(result.activity.expiresAt! - 1);
		await f.t.mutation(internal.files_pending_update_runs.recover, {});
		expect(await f.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).toEqual(scheduledBefore);
		expect(await f.t.mutation(internal.activities.cleanup_history, { _test_disableReschedule: true })).toEqual({
			deletedCount: 0,
			done: true,
		});
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_update_runs", runId))).toEqual(result.run);
		vi.setSystemTime(Date.now() + 1);
		await f.t.mutation(internal.files_pending_update_runs.recover, {});
		expect(await f.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).toEqual(scheduledBefore);
		await f.t.mutation(internal.activities.cleanup_history, { _test_disableReschedule: true });
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_update_runs", runId))).not.toBeNull();
		for (let pass = 0; pass < 100; pass++) {
			await f.t.mutation(internal.activities.cleanup_history, { _test_disableReschedule: true });
			if (!(await f.t.run((ctx) => ctx.db.get("activities", activityId)))) break;
			if (pass === 99) throw new Error("Review history cleanup did not finish");
		}
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_update_runs", runId))).toBeNull();
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_holds").collect())).toEqual([]);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_update_run_items").collect())).toEqual([]);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_update_run_units").collect())).toEqual([]);
		expect(await f.t.run((ctx) => ctx.db.get("activities", activityId))).toBeNull();
		expect(await f.t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(savedBefore);
	});

	test("stops after three lost planning attempts without changing drafts", async () => {
		const f = await fixture();
		const parent = await private_folder(f, "/parent");
		const { runId } = await start_review({ f, kind: "accept", proposals: [parent], plan: false });
		for (let pass = 0; pass < 3; pass++) {
			vi.setSystemTime(Date.now() + 5 * 60 * 1000);
			await f.t.mutation(internal.files_pending_update_runs.recover, {});
		}
		const result = await f.asUser.query(api.files_pending_update_runs.get, { membershipId: f.db.membershipId, runId });
		expect(result?.run).toMatchObject({ step: "finished", planningAttempts: 3 });
		expect(result?.activity).toMatchObject({
			status: "failed",
			errorCode: "attempt_expired",
			progress: { completed: 0, blocked: 1 },
		});
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", parent._id))).toEqual(parent);
		expect(await f.t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual([]);
	});

	test.each(["user", "workspace"] as const)(
		"purges active review workers before proposals, one item at a time (%s)",
		async (scope) => {
			const f = await fixture();
			const savedId = await saved_folder(f, "saved");
			const parent = await private_folder(f, "/parent");
			const child = await private_folder(f, "/parent/child");
			const { runId, activityId } = await start_review({ f, kind: "accept", proposals: [parent, child] });
			await f.t.mutation(internal.files_pending_update_runs.advance, { runId });
			const unit = await f.t.run((ctx) => ctx.db.query("files_pending_update_run_units").first());
			if (!unit) throw new Error("Expected an active unit");
			const control = await f.t.run((ctx) =>
				test_mocks_fill_db_with.membership(ctx, { organizationName: "review-purge-control" }),
			);
			const controlDraft = await f.t.mutation(internal.files_nodes.create_private_node_by_path, {
				organizationId: control.organizationId,
				workspaceId: control.workspaceId,
				userId: control.userId,
				path: "/control",
				kind: "folder",
			});
			if (controlDraft._nay) throw new Error(controlDraft._nay.message);
			let requestId: Id<"data_deletion_requests"> | null = null;
			if (scope === "workspace") {
				expect(
					(await f.asUser.mutation(api.organizations.delete_workspace, { workspaceId: f.db.workspaceId }))._nay,
				).toBeUndefined();
				const request = await f.t.run((ctx) => ctx.db.query("data_deletion_requests").collect());
				requestId = request.find((doc) => doc.scope === "workspace" && doc.workspaceId === f.db.workspaceId)!._id;
			}
			async function purge() {
				if (requestId)
					return (
						await f.t.mutation(internal.data_deletion.process_workspace_deletion_request, {
							requestId,
							_test_batchSize: 1,
						})
					).done;
				return await f.t.mutation(internal.data_deletion.finalize_user_deletion_data, {
					userId: f.db.userId,
					deleteUserRecord: true,
					_test_batchSize: 1,
					_test_disableReschedule: true,
				});
			}
			const holdsBefore = await f.t.run((ctx) => ctx.db.query("files_pending_holds").collect());
			expect(await purge()).toBe(false);
			expect(await f.t.run((ctx) => ctx.db.query("files_pending_holds").collect())).toEqual(holdsBefore);
			expect(await f.t.run((ctx) => ctx.db.query("files_pending_update_run_items").collect())).toHaveLength(2);
			expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", parent._id))).toEqual(parent);
			await f.t.action(internal.files_pending_update_runs.prepare_unit, {
				runId,
				fence: 0,
				unitId: unit._id,
				attemptFence: unit.attemptFence,
			});
			expect(await f.t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect())).toEqual([]);
			let done = false;
			for (let pass = 0; pass < 150 && !done; pass++) {
				if (unit.cohortId) {
					const cohort = await f.t.run((ctx) => ctx.db.get("files_move_cohorts", unit.cohortId!));
					if (cohort && cohort.phase !== "complete")
						await f.t.action(internal.files_move_cohorts.run, { cohortId: cohort._id, step: cohort.step });
				}
				done = await purge();
			}
			expect(done).toBe(true);
			for (const table of [
				"files_pending_update_runs",
				"files_pending_update_run_items",
				"files_pending_update_run_units",
			] as const)
				expect(await f.t.run((ctx) => ctx.db.query(table).collect())).toEqual([]);
			expect(await f.t.run((ctx) => ctx.db.get("activities", activityId))).toBeNull();
			expect(
				await f.t.run((ctx) => ctx.db.get("files_pending_updates", controlDraft._yay.pendingUpdateId!)),
			).not.toBeNull();
			const saved = await f.t.run((ctx) => ctx.db.get("files_nodes", savedId));
			if (scope === "user") expect(saved).toMatchObject({ path: "/saved", archiveOperationId: null });
			else expect(saved).toBeNull();
		},
	);
});
