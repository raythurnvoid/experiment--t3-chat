import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { FunctionArgs } from "convex/server";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { advance, run } from "./files_move_cohorts.ts";
import { test_convex, test_finish_transfer_run, test_mocks_fill_db_with, test_spy_handler } from "./setup.test.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

async function fixture(depth = 2, childCount = 0) {
	const t = test_convex({ transactionLimits: true });
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const folder = async (path: string, parentId: Id<"files_nodes"> | "root") => {
		const created = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId,
			path,
		});
		if (created._nay) throw new Error(created._nay.message);
		return created._yay.nodeId;
	};
	let parentId: Id<"files_nodes"> | "root" = "root";
	for (let index = 1; index < depth; index++) {
		parentId = await folder(`level-${index}`, parentId);
	}
	const sourceId = await folder("source", parentId);
	const childIds: Id<"files_nodes">[] = [];
	// Respect the normal folder write rate during setup.
	for (let index = 0; index < childCount; index++) {
		vi.setSystemTime(Date.now() + 2_000);
		childIds.push(await folder(`child-${index}`, sourceId));
	}
	const targetId = await folder("/target", "root");
	const started = await asUser.mutation(api.files_transfer.start, {
		membershipId: db.membershipId,
		requestId: crypto.randomUUID(),
		kind: "move",
		expectedSourceCount: 1,
		sourceIds: [sourceId],
		targetParentId: targetId,
	});
	if (started._nay) throw new Error(started._nay.message);
	expect(
		await asUser.mutation(api.files_transfer.seal, { membershipId: db.membershipId, runId: started._yay.runId }),
	).toEqual({ _yay: null });
	for (let pass = 0; pass < 10; pass++) {
		await t.mutation(internal.files_transfer.advance, { runId: started._yay.runId });
		const cohort = await t.run((ctx) => ctx.db.query("files_move_cohorts").first());
		if (cohort) return { t, asUser, db, sourceId, childIds, targetId, cohort, ...started._yay };
	}
	throw new Error("Transfer did not start a Move group");
}

test.each([2, 3])("an empty folder at depth %i publishes in three transactions", async (depth) => {
	const f = await fixture(depth);
	let actions = 0;
	let transactions = 0;
	let throughPublication = 0;
	test_spy_handler(run, async (handler, ctx, args) => {
		actions++;
		return await handler(ctx, args);
	});
	test_spy_handler(advance, async (handler, ctx, args) => {
		const { cohortId } = args as { cohortId: Id<"files_move_cohorts"> };
		const before = (await ctx.db.get("files_move_cohorts", cohortId))!;
		transactions++;
		if (before.publishedAt === null) throughPublication++;
		return await handler(ctx, args);
	});
	await test_finish_transfer_run(f.asUser, f.runId);
	expect(await f.t.run((ctx) => ctx.db.get("files_nodes", f.sourceId))).toMatchObject({
		parentId: f.targetId,
		path: "/target/source",
	});
	expect(await f.t.run((ctx) => ctx.db.get("activities", f.activityId))).toMatchObject({
		status: "succeeded",
	});
	expect(throughPublication, "small Move joins exact work before publication").toBeLessThanOrEqual(3);
	expect(transactions, "small Move joins exact cleanup work too").toBeLessThanOrEqual(5);
	expect(actions, "one action carries the committed Move steps").toBe(1);
});

test("an action yields its committed step when the time budget ends", async () => {
	const f = await fixture();
	const before = f.cohort;
	const owner = (await f.t.run((ctx) => ctx.db.system.get(before.runJob!.id)))!;
	let transactions = 0;
	test_spy_handler(advance, async (handler, ctx, args) => {
		transactions++;
		const result = await handler(ctx, args);
		vi.setSystemTime(Date.now() + 5_001);
		return result;
	});
	await f.t.action(
		internal.files_move_cohorts.run,
		owner.args[0] as FunctionArgs<typeof internal.files_move_cohorts.run>,
	);
	const after = (await f.t.run((ctx) => ctx.db.get("files_move_cohorts", before._id)))!;
	expect(transactions, "the time budget ends the action after a committed transaction").toBe(1);
	expect(after.step).toBeGreaterThan(before.step);
	expect(after.publishedAt).toBeNull();
	expect(after.runJob!.generation).toBeGreaterThan(before.runJob!.generation);
	const successor = (await f.t.run((ctx) => ctx.db.system.get(after.runJob!.id)))!;
	expect(successor.state.kind).toBe("pending");
	expect(successor.args[0], "the successor owns the committed step").toMatchObject({
		cohortId: before._id,
		step: after.step,
		runGeneration: after.runJob!.generation,
		mode: "chain",
	});
});

test("an action hands off after 128 committed advances", async () => {
	const f = await fixture(2, 128);
	const before = f.cohort;
	await f.t.run(async (ctx) => {
		for (const job of await ctx.db.system.query("_scheduled_functions").collect())
			if (job.state.kind === "pending" && job._id !== before.runJob!.id) await ctx.scheduler.cancel(job._id);
	});
	let transactions = 0;
	test_spy_handler(advance, async (handler, ctx, args) => {
		transactions++;
		return await handler(ctx, args);
	});
	vi.advanceTimersByTime(0);
	await f.t.finishInProgressScheduledFunctions();
	const after = (await f.t.run((ctx) => ctx.db.get("files_move_cohorts", before._id)))!;
	expect(transactions, "the call budget hands off after 128 committed advances").toBe(128);
	expect(after.step).toBeGreaterThan(before.step);
	expect(after.phase).not.toBe("complete");
	expect(after.runJob!.generation).toBeGreaterThan(before.runJob!.generation);
	expect((await f.t.run((ctx) => ctx.db.system.get(before.runJob!.id)))!.state.kind).toBe("success");
	const successor = (await f.t.run((ctx) => ctx.db.system.get(after.runJob!.id)))!;
	expect(successor.state.kind).toBe("pending");
	expect(successor.args[0], "the successor resumes the last committed step").toMatchObject({
		cohortId: before._id,
		step: after.step,
		runGeneration: after.runJob!.generation,
		mode: "chain",
	});
	await test_finish_transfer_run(f.asUser, f.runId);
	expect(await f.t.run((ctx) => ctx.db.get("files_nodes", f.sourceId))).toMatchObject({
		parentId: f.targetId,
		path: "/target/source",
	});
	for (const childId of f.childIds) {
		const child = (await f.t.run((ctx) => ctx.db.get("files_nodes", childId)))!;
		expect(child.parentId).toBe(f.sourceId);
		expect(child.path).toBe(`/target/source/${child.name}`);
	}
	for (const table of ["files_move_source_reservations", "files_move_slot_claims", "files_move_asset_claims"] as const)
		expect(
			await f.t.run((ctx) =>
				ctx.db
					.query(table)
					.withIndex("by_cohort", (q) => q.eq("cohortId", before._id))
					.first(),
			),
			`the completed Move releases ${table}`,
		).toBeNull();
	expect(await f.t.run((ctx) => ctx.db.get("activities", f.activityId))).toMatchObject({ status: "succeeded" });
});

test("a thrown transaction after progress aborts from the current step", async () => {
	const f = await fixture();
	let transactions = 0;
	test_spy_handler(advance, async (handler, ctx, args) => {
		transactions++;
		if (transactions === 2) throw new Error("Move test failure after one committed transaction");
		return await handler(ctx, args);
	});
	const error = vi.spyOn(console, "error").mockImplementation(() => {});
	const owner = (await f.t.run((ctx) => ctx.db.system.get(f.cohort.runJob!.id)))!;
	await f.t.action(
		internal.files_move_cohorts.run,
		owner.args[0] as FunctionArgs<typeof internal.files_move_cohorts.run>,
	);
	expect(
		await f.t.run((ctx) => ctx.db.get("files_move_cohorts", f.cohort._id)),
		"the failed current step enters abort",
	).toMatchObject({ phase: "aborting", errorCode: "move_step_failed", publishedAt: null });
	await test_finish_transfer_run(f.asUser, f.runId);
	const cohort = (await f.t.run((ctx) => ctx.db.query("files_move_cohorts").first()))!;
	expect(error).toHaveBeenCalled();
	expect(cohort, "the failed current step aborts and releases its claims").toMatchObject({
		phase: "complete",
		errorCode: "move_step_failed",
		publishedAt: null,
	});
	expect(await f.t.run((ctx) => ctx.db.get("files_nodes", f.sourceId))).toMatchObject({
		path: "/level-1/source",
	});
});
