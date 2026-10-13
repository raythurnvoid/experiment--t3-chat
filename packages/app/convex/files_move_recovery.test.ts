import { Workpool } from "@convex-dev/workpool";
import { R2 } from "@convex-dev/r2";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { getFunctionName, type FunctionArgs } from "convex/server";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { run } from "./files_move_run.ts";
import { test_convex, test_mocks_fill_db_with, test_spy_handler } from "./setup.test.ts";
import { files_u8_to_array_buffer } from "../server/files.ts";

beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("move-recovery-test-work" as never);
	vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined as never);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

async function fixture(t = test_convex({ transactionLimits: true }), organizationName = "test-organization") {
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx, { organizationName }));
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const folder = async (path: string, parentId: Id<"files_nodes"> | "root" = "root") => {
		const created = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId,
			path,
		});
		if (created._nay) throw new Error(created._nay.message);
		return created._yay.nodeId;
	};
	const sourceId = await folder("/source");
	const targetId = await folder("/target");
	// Initial work and the first action each stop at a real child page.
	const childId = await folder("child", sourceId);
	const grandchildId = await folder("grandchild", childId);
	const started = await asUser.mutation(api.files_transfer.accept_input, {
		membershipId: db.membershipId,
		requestId: crypto.randomUUID(),
		kind: "move",
		sourceIds: [sourceId],
		expectedSourceCount: 1,
		targetParentId: targetId,
	});
	if (started._nay) throw new Error(started._nay.message);
	const { runId, activityId } = started._yay;
	expect(await asUser.mutation(api.files_transfer.seal, { membershipId: db.membershipId, runId })).toEqual({
		_yay: null,
	});
	const slot = () =>
		t.run((ctx) =>
			ctx.db
				.query("files_move_workspace_slots")
				.withIndex("by_workspace", (q) => q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId))
				.unique(),
		);
	for (let pass = 0; pass < 10 && !(await slot())?.cohortId; pass++)
		await t.mutation(internal.files_transfer.advance, { runId });
	const cohortId = (await slot())?.cohortId;
	if (!cohortId) throw new Error("The Move did not start a group");
	return { t, db, asUser, cohortId, activityId, sourceId, targetId, childId, grandchildId };
}

async function preparing_fixture() {
	const objects = new Map<string, string | ArrayBuffer>();
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (key = "") => ({
		key,
		url: `https://r2.test/upload?key=${encodeURIComponent(key)}`,
	}));
	vi.spyOn(R2.prototype, "getUrl").mockImplementation(
		async (key) => `https://r2.test/object?key=${encodeURIComponent(key)}`,
	);
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			const parsed = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
			const key = parsed.searchParams.get("key")!;
			if (parsed.pathname === "/upload") {
				const body = init?.body;
				if (typeof body === "string" || body instanceof ArrayBuffer) objects.set(key, body);
				else if (body instanceof Uint8Array) objects.set(key, files_u8_to_array_buffer(body));
				else return new Response(null, { status: 400 });
				return new Response(null, { status: 200 });
			}
			const body = objects.get(key);
			return body === undefined ? new Response(null, { status: 404 }) : new Response(body);
		}),
	);
	const t = test_convex({ transactionLimits: true });
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId };
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const created = await t.mutation(internal.files_nodes.create_private_node_by_path, {
		...scope,
		path: "/draft.txt",
		kind: "file",
	});
	if (created._nay || !created._yay.pendingUpdateId || !created._yay.operationBatchId)
		throw new Error("Expected a private text draft");
	for (const role of ["staged", "unstaged"] as const) {
		const staged = await t.mutation(internal.files_pending_updates.stage_file_pending_update_text_input_internal, {
			...scope,
			operationBatchId: created._yay.operationBatchId,
			role,
			text: "accepted text",
		});
		if (staged._nay) throw new Error(staged._nay.message);
	}
	const ready = await t.action(internal.files_pending_updates.upsert_file_pending_update_internal_action, {
		...scope,
		target: created._yay.target,
		pendingUpdateId: created._yay.pendingUpdateId,
		operationBatchId: created._yay.operationBatchId,
	});
	if (ready._nay) throw new Error(ready._nay.message);
	const proposal = (await t.run((ctx) => ctx.db.get("files_pending_updates", created._yay.pendingUpdateId!)))!;
	const started = await asUser.mutation(api.files_pending_update_runs.start, {
		membershipId: db.membershipId,
		requestId: crypto.randomUUID(),
		kind: "accept",
		expectedItemCount: 1,
		items: [
			{
				pendingUpdateId: proposal._id,
				reviewedRevision: proposal.revision,
				selectedContentStateId: proposal.content!.stagedStateId,
			},
		],
	});
	if (started._nay) throw new Error(started._nay.message);
	const { runId, activityId } = started._yay;
	expect(await asUser.mutation(api.files_pending_update_runs.seal, { membershipId: db.membershipId, runId })).toEqual({
		_yay: null,
	});
	for (let pass = 0; pass < 100; pass++) {
		const cohort = await t.run((ctx) =>
			ctx.db
				.query("files_move_cohorts")
				.withIndex("by_origin_run", (q) => q.eq("origin.kind", "review").eq("origin.runId", runId))
				.first(),
		);
		if (cohort) return { t, cohortId: cohort._id, activityId };
		const job = await t.run((ctx) =>
			ctx.db
				.query("files_pending_overlay_jobs")
				.withIndex("by_org_ws", (q) => q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId))
				.first(),
		);
		if (job) {
			if (job.nextAttemptAt > Date.now()) vi.setSystemTime(job.nextAttemptAt);
			await t.mutation(internal.files_pending_overlay.run_job, {
				kind: job.kind,
				key: job.key,
				nextAttemptAt: job.nextAttemptAt,
			});
			continue;
		}
		const review = (await t.run((ctx) => ctx.db.get("files_pending_update_runs", runId)))!;
		if (review.step === "planning")
			await t.action(internal.files_pending_update_runs.plan, { runId, fence: review.fence });
		else await t.mutation(internal.files_pending_update_runs.advance, { runId });
	}
	throw new Error("Save did not start a Move group");
}

function run_jobs(t: ReturnType<typeof test_convex>, cohortId: Id<"files_move_cohorts">) {
	return t.run(async (ctx) =>
		(await ctx.db.system.query("_scheduled_functions").collect()).filter(
			(job) => job.name.endsWith("files_move_run:run") && job.args[0]?.cohortId === cohortId,
		),
	);
}

async function drain_recovery(t: ReturnType<typeof test_convex>) {
	const pages: FunctionArgs<typeof internal.files_move_cohorts.recover_page>[] = [];
	for (let pass = 0; pass < 1_000; pass++) {
		const job = await t.run(async (ctx) =>
			(await ctx.db.system.query("_scheduled_functions").collect()).find(
				(job) => job.name.endsWith("files_move_cohorts:recover_page") && job.state.kind === "pending",
			),
		);
		if (!job) return pages;
		const args = job.args[0] as FunctionArgs<typeof internal.files_move_cohorts.recover_page>;
		// Deliver only recovery pages. Leave Move runs and expiry timers queued.
		await t.run((ctx) => ctx.scheduler.cancel(job._id));
		await t.mutation(internal.files_move_cohorts.recover_page, args);
		pages.push(args);
	}
	throw new Error("Move recovery did not finish paging");
}

describe("Move cohort recovery", () => {
	test("replaces a lost run and publishes from the stored step", async () => {
		const f = await fixture();
		const old = (await run_jobs(f.t, f.cohortId)).find((job) => job.state.kind === "pending")!;
		const before = (await f.t.run((ctx) => ctx.db.get("files_move_cohorts", f.cohortId)))!;
		await f.t.run((ctx) => ctx.scheduler.cancel(old._id));
		vi.setSystemTime(Date.now() + 3 * 60_000);
		await f.t.mutation(internal.files_move_cohorts.recover, {});
		await drain_recovery(f.t);
		const replacements = (await run_jobs(f.t, f.cohortId)).filter((job) => job.state.kind === "pending");
		expect(replacements, "a lost owned run gets one replacement").toHaveLength(1);
		const replacement = replacements[0]!;
		const current = (await f.t.run((ctx) => ctx.db.get("files_move_cohorts", f.cohortId)))!;
		expect(replacement._id).not.toBe(old._id);
		expect(current.runJob).toMatchObject({ id: replacement._id, step: before.step });
		expect(replacement.args[0]).toMatchObject({
			cohortId: f.cohortId,
			step: before.step,
			runGeneration: current.runJob!.generation,
		});
		await f.t.action(
			internal.files_move_run.run,
			replacement.args[0] as FunctionArgs<typeof internal.files_move_run.run>,
		);
		for (let pass = 0; pass < 100; pass++) {
			const cohort = (await f.t.run((ctx) => ctx.db.get("files_move_cohorts", f.cohortId)))!;
			if (cohort.phase === "complete") break;
			const job = (await f.t.run((ctx) => ctx.db.system.get(cohort.runJob!.id)))!;
			await f.t.action(
				internal.files_move_run.run,
				job.args[0] as FunctionArgs<typeof internal.files_move_run.run>,
			);
		}
		expect(await f.t.run((ctx) => ctx.db.get("files_move_cohorts", f.cohortId))).toMatchObject({
			phase: "complete",
			errorCode: null,
		});
		expect((await f.t.run((ctx) => ctx.db.get("files_move_cohorts", f.cohortId)))!.publishedAt).not.toBeNull();
		expect(await f.t.run((ctx) => ctx.db.get("files_nodes", f.sourceId))).toMatchObject({ path: "/target/source" });
	});

	test("recovers a committed step after its action loses the reply", async () => {
		const f = await fixture();
		const before = (await f.t.run((ctx) => ctx.db.get("files_move_cohorts", f.cohortId)))!;
		expect(before).toMatchObject({ phase: "staging", publishedAt: null });
		const owned = (await f.t.run((ctx) => ctx.db.system.get(before.runJob!.id)))!;
		await f.t.run(async (ctx) => {
			for (const job of await ctx.db.system.query("_scheduled_functions").collect())
				if (job.state.kind === "pending" && job._id !== owned._id) await ctx.scheduler.cancel(job._id);
		});
		let lostReplies = 0;
		let committed = before;
		vi.spyOn(console, "error").mockImplementation(() => {});
		test_spy_handler(run, async (handler, ctx, args) => {
			const runMutation = ctx.runMutation.bind(ctx);
			vi.spyOn(ctx, "runMutation").mockImplementation(async (...mutationArgs) => {
				const reference = mutationArgs[0];
				const result = await runMutation(reference, mutationArgs[1], mutationArgs[2]);
				if (lostReplies === 0 && getFunctionName(reference) === "files_move_cohorts:advance") {
					// Lose the reply only after the real transaction commits.
					committed = (await f.t.run((ctx) => ctx.db.get("files_move_cohorts", f.cohortId)))!;
					expect(result).toMatchObject({ kind: "next" });
					lostReplies++;
					throw new Error("Move test lost the committed advance reply");
				}
				return result;
			});
			return await handler(ctx, args);
		});
		vi.advanceTimersByTime(0);
		await f.t.finishInProgressScheduledFunctions();
		expect(lostReplies).toBe(1);
		expect(committed.step).toBeGreaterThan(before.step);
		expect(committed.runJob).toMatchObject({ id: owned._id, step: committed.step });
		expect((await f.t.run((ctx) => ctx.db.system.get(owned._id)))!.state.kind).toBe("success");
		expect(
			await f.t.run((ctx) => ctx.db.get("files_move_cohorts", f.cohortId)),
			"a lost reply preserves committed progress",
		).toEqual(committed);
		expect(committed).toMatchObject({ publishedAt: null, errorCode: null });
		expect((await run_jobs(f.t, f.cohortId)).filter((job) => job.state.kind === "pending")).toEqual([]);
		expect(
			await f.asUser.query(api.files_nodes.get_authorized_by_path, {
				membershipId: f.db.membershipId,
				path: "/source",
			}),
		).toMatchObject({ nodeId: f.sourceId });
		expect(
			await f.t.run((ctx) =>
				ctx.db
					.query("files_move_source_reservations")
					.withIndex("by_cohort", (q) => q.eq("cohortId", f.cohortId))
					.first(),
			),
		).not.toBeNull();
		const activity = (await f.t.run((ctx) => ctx.db.get("activities", f.activityId)))!;
		vi.setSystemTime(Date.now() + 3 * 60_000);
		await f.t.mutation(internal.files_move_cohorts.recover, {});
		await drain_recovery(f.t);
		const replacements = (await run_jobs(f.t, f.cohortId)).filter((job) => job.state.kind === "pending");
		expect(replacements, "a lost committed reply gets one replacement").toHaveLength(1);
		const recovered = (await f.t.run((ctx) => ctx.db.get("files_move_cohorts", f.cohortId)))!;
		expect(recovered.runJob!.generation).toBeGreaterThan(committed.runJob!.generation);
		expect(replacements[0]!.args[0]).toMatchObject({
			cohortId: f.cohortId,
			step: committed.step,
			runGeneration: recovered.runJob!.generation,
		});
		expect(recovered.deadlineAt).toBe(committed.deadlineAt);
		expect((await f.t.run((ctx) => ctx.db.get("activities", f.activityId)))!.deadlineAt).toBe(activity.deadlineAt);
		for (let pass = 0; pass < 20; pass++) {
			vi.advanceTimersByTime(0);
			await f.t.finishInProgressScheduledFunctions();
			const cohort = (await f.t.run((ctx) => ctx.db.get("files_move_cohorts", f.cohortId)))!;
			const activity = (await f.t.run((ctx) => ctx.db.get("activities", f.activityId)))!;
			if (cohort.phase === "complete" && activity.status === "succeeded") break;
		}
		const completed = (await f.t.run((ctx) => ctx.db.get("files_move_cohorts", f.cohortId)))!;
		expect(completed).toMatchObject({ phase: "complete", errorCode: null });
		expect(completed.runJob).toBeUndefined();
		expect(await f.t.run((ctx) => ctx.db.get("activities", f.activityId))).toMatchObject({ status: "succeeded" });
		const source = (await f.t.run((ctx) => ctx.db.get("files_nodes", f.sourceId)))!;
		expect(source).toMatchObject({
			path: "/target/source",
			parentId: f.targetId,
		});
		expect(source.moveCohortId).toBeUndefined();
		const child = (await f.t.run((ctx) => ctx.db.get("files_nodes", f.childId)))!;
		expect(child).toMatchObject({ parentId: f.sourceId, path: "/target/source/child" });
		expect(child.moveCohortId).toBeUndefined();
		const grandchild = (await f.t.run((ctx) => ctx.db.get("files_nodes", f.grandchildId)))!;
		expect(grandchild).toMatchObject({ parentId: f.childId, path: "/target/source/child/grandchild" });
		expect(grandchild.moveCohortId).toBeUndefined();
		expect(
			await f.asUser.query(api.files_nodes.get_authorized_by_path, {
				membershipId: f.db.membershipId,
				path: "/source",
			}),
		).toBeNull();
		expect(
			await f.asUser.query(api.files_nodes.get_authorized_by_path, {
				membershipId: f.db.membershipId,
				path: "/target/source",
			}),
		).toMatchObject({ nodeId: f.sourceId });
		expect(
			(
				await f.t.run((ctx) =>
					ctx.db
						.query("files_move_workspace_slots")
						.withIndex("by_workspace", (q) =>
							q.eq("organizationId", f.db.organizationId).eq("workspaceId", f.db.workspaceId),
						)
						.unique(),
				)
			)?.cohortId,
		).toBeNull();
		for (const table of [
			"files_move_source_reservations",
			"files_move_slot_claims",
			"files_move_asset_claims",
		] as const)
			expect(
				await f.t.run((ctx) =>
					ctx.db
						.query(table)
						.withIndex("by_cohort", (q) => q.eq("cohortId", f.cohortId))
						.first(),
				),
				`the completed Move releases ${table}`,
			).toBeNull();
	});

	test("recovery kicks keep the original cohort and Activity deadlines", async () => {
		const f = await fixture();
		const before = (await f.t.run((ctx) => ctx.db.get("files_move_cohorts", f.cohortId)))!;
		const activity = (await f.t.run((ctx) => ctx.db.get("activities", f.activityId)))!;
		for (const minutes of [3, 8]) {
			const job = (await run_jobs(f.t, f.cohortId)).find((job) => job.state.kind === "pending")!;
			await f.t.run((ctx) => ctx.scheduler.cancel(job._id));
			vi.setSystemTime(before.operationTime + minutes * 60_000);
			await f.t.mutation(internal.files_move_cohorts.recover, {});
			await drain_recovery(f.t);
			expect(
				await f.t.run((ctx) => ctx.db.get("files_move_cohorts", f.cohortId)),
				"retrying transport must not extend the Move lease",
			).toMatchObject({
				step: before.step,
				deadlineAt: before.deadlineAt,
			});
			expect(await f.t.run((ctx) => ctx.db.get("activities", f.activityId))).toMatchObject({
				deadlineAt: activity.deadlineAt,
			});
			expect((await run_jobs(f.t, f.cohortId)).filter((job) => job.state.kind === "pending")).toHaveLength(1);
		}
	});

	test("leaves an in-progress run alone after the idle cutoff", async () => {
		const f = await fixture();
		const owned = (await run_jobs(f.t, f.cohortId)).find((job) => job.state.kind === "pending")!;
		const before = (await f.t.run((ctx) => ctx.db.get("files_move_cohorts", f.cohortId)))!;
		await f.t.run(async (ctx) => {
			for (const job of await ctx.db.system.query("_scheduled_functions").collect())
				if (job.state.kind === "pending" && job._id !== owned._id) await ctx.scheduler.cancel(job._id);
		});
		let release!: () => void;
		let entered!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let starts = 0;
		test_spy_handler(run, async (handler, ctx, args) => {
			starts++;
			entered();
			await blocked;
			return await handler(ctx, args);
		});
		try {
			vi.advanceTimersByTime(0);
			await started;
			expect((await f.t.run((ctx) => ctx.db.system.get(owned._id)))!.state.kind).toBe("inProgress");
			vi.setSystemTime(Date.now() + 3 * 60_000);
			await f.t.mutation(internal.files_move_cohorts.recover, {});
			await drain_recovery(f.t);
			expect(
				(await run_jobs(f.t, f.cohortId)).filter((job) => job.state.kind === "pending"),
				"healthy owned work must not get a duplicate kick",
			).toEqual([]);
			expect(await f.t.run((ctx) => ctx.db.get("files_move_cohorts", f.cohortId))).toMatchObject({
				runJob: before.runJob,
				step: before.step,
				deadlineAt: before.deadlineAt,
			});
			expect(starts).toBe(1);
		} finally {
			release();
			await f.t.finishInProgressScheduledFunctions();
		}
	});

	test("recovers every lost group across more than two pages", async () => {
		const t = test_convex({ transactionLimits: true });
		const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
		for (let index = 0; index < 65; index++) fixtures.push(await fixture(t, `recovery-${index}`));
		const before = await t.run((ctx) => Promise.all(fixtures.map((f) => ctx.db.get("files_move_cohorts", f.cohortId))));
		expect(
			before.map((cohort) => ({ phase: cohort!.phase, publishedAt: cohort!.publishedAt })),
			"all lost groups still await publication",
		).toEqual(fixtures.map(() => ({ phase: "staging", publishedAt: null })));
		await t.run(async (ctx) => {
			for (const job of await ctx.db.system.query("_scheduled_functions").collect())
				if (job.name.endsWith("files_move_run:run") && job.state.kind === "pending")
					await ctx.scheduler.cancel(job._id);
		});
		vi.setSystemTime(Date.now() + 3 * 60_000);
		const cutoff = Date.now();
		await t.mutation(internal.files_move_cohorts.recover, {});
		const pages = await drain_recovery(t);
		const recovered = await t.run((ctx) =>
			Promise.all(fixtures.map((f) => ctx.db.get("files_move_cohorts", f.cohortId))),
		);
		const pending = await t.run(async (ctx) =>
			(await ctx.db.system.query("_scheduled_functions").collect()).filter(
				(job) => job.name.endsWith("files_move_run:run") && job.state.kind === "pending",
			),
		);
		expect(pending, "every lost group must get its own replacement").toHaveLength(fixtures.length);
		for (let index = 0; index < fixtures.length; index++) {
			const cohort = recovered[index]!;
			const jobs = pending.filter((job) => job.args[0]?.cohortId === cohort._id);
			expect(jobs, `group ${index + 1} has one replacement`).toHaveLength(1);
			expect(cohort.runJob).toMatchObject({ id: jobs[0]!._id, step: before[index]!.step });
			expect(cohort.deadlineAt).toBe(before[index]!.deadlineAt);
		}
		expect(pages.filter((page) => page.phase === "staging").length).toBeGreaterThan(2);
		expect(
			pages.every((page) => page.now === cutoff),
			"one pass keeps its original cutoff",
		).toBe(true);
		expect([...new Set(pages.map((page) => page.phase))]).toEqual([
			"planning",
			"staging",
			"validating",
			"ready",
			"published",
			"aborting",
			"finishing",
			"complete",
		]);
	}, 120_000);

	test("does not restart healthy content preparation after the idle cutoff", async () => {
		const f = await preparing_fixture();
		const owned = (await run_jobs(f.t, f.cohortId)).find((job) => job.state.kind === "pending")!;
		await f.t.run(async (ctx) => {
			for (const job of await ctx.db.system.query("_scheduled_functions").collect())
				if (job.state.kind === "pending" && job._id !== owned._id) await ctx.scheduler.cancel(job._id);
		});
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const pendingUpdates = await import("./files_pending_updates.ts");
		const prepare = pendingUpdates.files_pending_updates_action_prepare_content;
		let starts = 0;
		vi.spyOn(pendingUpdates, "files_pending_updates_action_prepare_content").mockImplementation(async (ctx, args) => {
			starts++;
			await blocked;
			return await prepare(ctx, args);
		});
		try {
			// Let scheduled handoffs run, then pause after the preparation fence commits.
			for (let pass = 0; pass < 100 && starts === 0; pass++) {
				vi.advanceTimersByTime(0);
				await f.t.run((ctx) => ctx.db.get("files_move_cohorts", f.cohortId));
			}
			const before = (await f.t.run((ctx) => ctx.db.get("files_move_cohorts", f.cohortId)))!;
			const activity = (await f.t.run((ctx) => ctx.db.get("activities", f.activityId)))!;
			expect(
				starts,
				`Preparation did not start: ${before.phase}/${before.workPhase}, ` +
					`${before.errorCode ?? activity.status}, ${before.errorMessage ?? "no cohort error"}`,
			).toBe(1);
			const content = (await f.t.run((ctx) =>
				ctx.db
					.query("files_move_cohort_content")
					.withIndex("by_cohort_node", (q) => q.eq("cohortId", f.cohortId))
					.first(),
			))!;
			expect(content.phase).toBe("preparing");
			expect(content.preparationFence).toBeGreaterThan(0);
			expect((await f.t.run((ctx) => ctx.db.system.get(owned._id)))!.state.kind).toBe("inProgress");
			vi.setSystemTime(Date.now() + 3 * 60_000);
			await f.t.mutation(internal.files_move_cohorts.recover, {});
			await drain_recovery(f.t);
			expect(
				(await run_jobs(f.t, f.cohortId)).filter((job) => job.state.kind === "pending"),
				"a healthy preparation must not get a second action",
			).toEqual([]);
			expect(
				await f.t.run((ctx) => ctx.db.get("files_move_cohort_content", content._id)),
				"recovery must keep the same preparing batch and fence",
			).toEqual(content);
			expect(await f.t.run((ctx) => ctx.db.get("files_move_cohorts", f.cohortId))).toEqual(before);
			expect((await f.t.run((ctx) => ctx.db.get("activities", f.activityId)))!.deadlineAt).toBe(activity.deadlineAt);
			expect(starts).toBe(1);
		} finally {
			release();
			await f.t.finishInProgressScheduledFunctions();
		}
	}, 120_000);

	test("old deliveries cannot advance or resume a replacement at the same step", async () => {
		const f = await fixture();
		const old = (await run_jobs(f.t, f.cohortId)).find((job) => job.state.kind === "pending")!;
		const oldArgs = old.args[0] as FunctionArgs<typeof internal.files_move_run.run>;
		await f.t.run((ctx) => ctx.scheduler.cancel(old._id));
		vi.setSystemTime(Date.now() + 3 * 60_000);
		await f.t.mutation(internal.files_move_cohorts.recover, {});
		await drain_recovery(f.t);
		const before = (await f.t.run((ctx) => ctx.db.get("files_move_cohorts", f.cohortId)))!;
		expect(before.runJob!.generation).toBeGreaterThan(oldArgs.runGeneration!);
		await f.t.action(internal.files_move_run.run, oldArgs);
		await f.t.mutation(internal.files_move_cohorts.resume, {
			cohortId: oldArgs.cohortId,
			step: oldArgs.step,
			runGeneration: oldArgs.runGeneration,
			error: { name: "move_step_failed", message: "The old action failed." },
		});
		await f.t.mutation(internal.files_move_cohorts.handoff, {
			cohortId: oldArgs.cohortId,
			step: oldArgs.step,
			runGeneration: oldArgs.runGeneration,
		});
		expect(
			await f.t.run((ctx) => ctx.db.get("files_move_cohorts", f.cohortId)),
			"old ownership cannot change replacement work",
		).toEqual(before);
		expect((await run_jobs(f.t, f.cohortId)).filter((job) => job.state.kind === "pending")).toHaveLength(1);
	});
});
