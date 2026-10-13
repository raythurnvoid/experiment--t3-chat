import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { advance as advance_cohort } from "./files_move_cohorts.ts";
import { accept_input, append_input, advance } from "./files_transfer.ts";
import { test_convex, test_finish_transfer_run, test_mocks_fill_db_with, test_spy_handler } from "./setup.test.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

async function fixture() {
	const t = test_convex({ transactionLimits: true });
	const scope = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: scope.userId });
	const target = await asUser.mutation(api.files_nodes.create_folder_node, {
		membershipId: scope.membershipId,
		parentId: "root",
		path: "target",
	});
	if (target._nay) throw new Error(target._nay.message);
	let parentId: Id<"files_nodes"> | "root" = "root";
	// Each public call adds at most 32 folders. The full stored chain can be deeper.
	for (let depth = 0; depth < 511; depth += 32) {
		const created = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: scope.membershipId,
			parentId,
			path: Array.from({ length: Math.min(32, 511 - depth) }, () => "a").join("/"),
		});
		if (created._nay) throw new Error(created._nay.message);
		parentId = created._yay.nodeId;
	}
	const sourceIds: Id<"files_nodes">[] = [];
	const sourcePaths = Array.from({ length: 8 }, (_, index) => `${"/a".repeat(511)}/${index}`);
	for (let index = 0; index < 8; index++) {
		const created = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: scope.membershipId,
			parentId,
			path: String(index),
		});
		if (created._nay) throw new Error(created._nay.message);
		sourceIds.push(created._yay.nodeId);
	}
	for (const [index, sourceId] of sourceIds.entries()) {
		expect(sourcePaths[index]).toHaveLength(1024);
		expect(
			await t.run((ctx) => ctx.db.get("files_nodes", sourceId)),
			"public creation made the complete source path",
		).toMatchObject({ _id: sourceId, parentId, path: sourcePaths[index], name: String(index) });
		const children = await asUser.query(api.files_nodes.list_tree_children, {
			membershipId: scope.membershipId,
			parentId: sourceId,
			kind: "folder",
			archived: false,
			restricted: false,
			paginationOpts: { cursor: null, numItems: 1 },
		});
		expect(children, "every deep selected folder is empty before acceptance").toMatchObject({ page: [], isDone: true });
	}
	return { t, scope, asUser, targetId: target._yay.nodeId, sourceIds, sourcePaths };
}

function track_costs() {
	const costs: Array<{ name: string; metrics: Awaited<ReturnType<MutationCtx["meta"]["getTransactionMetrics"]>> }> = [];
	const walks: Array<{ beforeCursor: number; afterCursor: number; before: number; after?: number }> = [];
	let cursor = -1;
	let discovered = 0;
	let unfinished: (typeof walks)[number] | undefined;
	for (const [name, registered] of [
		["accept_input", accept_input],
		["append_input", append_input],
		["advance", advance],
		["cohort advance", advance_cohort],
	] as const)
		test_spy_handler(registered, async (handler, ctx, args) => {
			const db = new Proxy(ctx.db, {
				get(target, key) {
					const member: unknown = Reflect.get(target, key);
					if (typeof member !== "function") return member;
					if (key !== "patch") return member.bind(target);
					return (...patchArgs: unknown[]) => {
						if (patchArgs[0] === "files_transfer_runs") {
							const update = patchArgs[2] as Partial<Doc<"files_transfer_runs">>;
							if (update.selection?.normalizingParentPath) {
								unfinished = { beforeCursor: cursor, afterCursor: update.selection.cursor, before: discovered };
								walks.push(unfinished);
							}
							if (update.selection) cursor = update.selection.cursor;
						}
						if (patchArgs[0] === "activities") {
							const update = patchArgs[2] as Partial<Doc<"activities">>;
							if (update.progress) {
								discovered = update.progress.discovered;
								if (unfinished) unfinished.after = discovered;
								unfinished = undefined;
							}
						}
						return Reflect.apply(member, target, patchArgs);
					};
				},
			});
			const result = await handler({ ...ctx, db }, args);
			// The registered wrapper has finished its final overlay and catalog flush.
			costs.push({ name, metrics: await ctx.meta.getTransactionMetrics() });
			return result;
		});
	return { costs, walks };
}

function expect_costs({ costs, walks }: ReturnType<typeof track_costs>) {
	expect(costs.length, "the real registered mutations were measured").toBeGreaterThan(0);
	expect(walks.length, "the real worker saves unfinished parent walks").toBeGreaterThan(0);
	for (const walk of walks) {
		expect(walk.afterCursor, "an unfinished logical Normalize slice keeps its input cursor").toBe(walk.beforeCursor);
		expect(walk.after, "an unfinished logical Normalize slice leaves discovered unchanged").toBe(walk.before);
	}
	const peaks = new Map<string, number>();
	for (const { name, metrics } of costs) {
		expect(Object.keys(metrics)).toHaveLength(7);
		for (const [key, metric] of Object.entries(metrics)) {
			expect(metric.used, `${name}: ${key} includes final flush and leaves 25% free`).toBeLessThan(
				(metric.used + metric.remaining) * 0.75,
			);
			peaks.set(key, Math.max(peaks.get(key) ?? 0, metric.used));
		}
	}
	console.info("deep source Normalize peaks", JSON.stringify(Object.fromEntries(peaks)));
}

async function read_continuation(f: Awaited<ReturnType<typeof fixture>>, runId: Id<"files_transfer_runs">) {
	const state = await f.t.run(async (ctx) => {
		const run = await ctx.db.get("files_transfer_runs", runId);
		if (!run?.selection?.normalizingParentPath) throw new Error("Expected a real unfinished Normalize walk");
		const activity = await ctx.db
			.query("activities")
			.withIndex("by_source_id", (q) => q.eq("source.id", runId))
			.unique();
		const next = await ctx.db
			.query("files_transfer_selection_items")
			.withIndex("by_run_order", (q) => q.eq("runId", runId).gt("order", run.selection!.cursor))
			.first();
		const items = await ctx.db
			.query("files_transfer_items")
			.withIndex("by_run_order", (q) => q.eq("runId", runId))
			.collect();
		return { run, activity, next, items };
	});
	expect(state.run.step).toBe("normalize");
	if (!state.next?.path || !state.activity) throw new Error("Expected the unfinished input and its Activity");
	const remainingParent = state.run.selection!.normalizingParentPath!;
	expect(state.next.order, "the continuation belongs to the first input after the cursor").toBe(
		state.run.selection!.cursor + 1,
	);
	expect(
		state.next.path.startsWith(remainingParent + "/"),
		"the remaining parent belongs to the frozen source path",
	).toBe(true);
	const checked =
		state.next.path.slice(0, state.next.path.lastIndexOf("/")).split("/").length - remainingParent.split("/").length;
	expect(checked, "the unfinished source has made parent-check progress").toBeGreaterThan(0);
	expect(checked % 32, "the next unchecked parent follows complete 32-check slices").toBe(0);
	expect(
		state.items.some((item) => item.source.id === state.next!.source.id),
		"an unfinished source is not discovered",
	).toBe(false);
	expect(state.activity.progress.discovered, "only completed inputs increase discovered").toBe(state.items.length);
	expect(state.activity.progress.completed).toBe(0);
	return state;
}

describe("Transfer source normalization", () => {
	test("normalizes eight supported 1,024-character source paths within the transaction limits", async () => {
		const f = await fixture();
		const costs = track_costs();
		const args = {
			membershipId: f.scope.membershipId,
			requestId: "deep-eight-sources",
			kind: "move" as const,
			expectedSourceCount: 8,
			sourceIds: f.sourceIds,
			targetParentId: f.targetId,
		};
		const acceptance = f.asUser.mutation(api.files_transfer.accept_input, args);
		await expect(
			acceptance,
			"complete deep input acceptance stays within the real mutation limits",
		).resolves.toMatchObject({
			_yay: { runId: expect.any(String), activityId: expect.any(String) },
		});
		const accepted = await acceptance;
		if (accepted._nay) throw new Error(accepted._nay.message);
		const { runId, activityId } = accepted._yay;
		let partial = await read_continuation(f, runId);
		expect(
			partial.activity!.progress.discovered,
			"the unfinished source leaves discovered at the completed input count",
		).toBe(partial.run.selection!.cursor + 1);
		expect(partial.items.map((item) => item.source.id)).toEqual(
			f.sourceIds.slice(0, partial.run.selection!.cursor + 1),
		);
		while (true) {
			await f.t.mutation(internal.files_transfer.advance, { runId });
			const run = await f.t.run((ctx) => ctx.db.get("files_transfer_runs", runId));
			if (run?.step !== "normalize") break;
			const next = await read_continuation(f, runId);
			if (next.run.selection!.cursor === partial.run.selection!.cursor)
				expect(next.activity!.progress.discovered, "a resumed unfinished source leaves discovered unchanged").toBe(
					partial.activity!.progress.discovered,
				);
			expect(
				[next.run.selection!.cursor, next.run.selection!.normalizingParentPath],
				"each registered continuation makes durable input or parent progress",
			).not.toEqual([partial.run.selection!.cursor, partial.run.selection!.normalizingParentPath]);
			expect(next.items.map((item) => item.source.id)).toEqual(f.sourceIds.slice(0, next.run.selection!.cursor + 1));
			partial = next;
		}
		const normalized = await f.t.run((ctx) => ctx.db.get("files_transfer_runs", runId));
		expect(normalized?.selection).toMatchObject({ expectedCount: 8, count: 8, cursor: 7 });
		expect(
			normalized?.selection?.normalizingParentPath,
			"finished Normalize clears its saved parent walk",
		).toBeUndefined();
		await test_finish_transfer_run(f.asUser, runId);
		const items = await f.t.run((ctx) =>
			ctx.db
				.query("files_transfer_items")
				.withIndex("by_run_order", (q) => q.eq("runId", runId))
				.collect(),
		);
		expect(
			items.map((item) => ({ order: item.order, source: item.source, state: item.state })),
			"all eight roots finish once in input order",
		).toEqual(f.sourceIds.map((id, order) => ({ order, source: { kind: "saved", id }, state: "completed" })));
		for (const [index, sourceId] of f.sourceIds.entries()) {
			const node = await f.t.run((ctx) => ctx.db.get("files_nodes", sourceId));
			expect(node).toMatchObject({
				_id: sourceId,
				parentId: f.targetId,
				name: String(index),
				path: `/target/${index}`,
			});
			expect(node?.moveCohortId).toBeUndefined();
		}
		expect(await f.t.run((ctx) => ctx.db.get("activities", activityId))).toMatchObject({
			status: "succeeded",
			progress: { discovered: 8, total: 8, completed: 8, failed: 0, canceled: 0 },
		});
		expect_costs(costs);
	}, 120_000);

	test("a later selected parent covers deep children and exact replay keeps the saved walk", async () => {
		const f = await fixture();
		const ancestorPath = "/a".repeat(400);
		const ancestor = await f.t.run((ctx) =>
			ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", f.scope.organizationId)
						.eq("workspaceId", f.scope.workspaceId)
						.eq("moveCohortId", undefined)
						.eq("path", ancestorPath)
						.eq("archiveOperationId", null),
				)
				.unique(),
		);
		if (!ancestor) throw new Error("Expected the publicly created selected parent");
		const costs = track_costs();
		const accepted = await f.asUser.mutation(api.files_transfer.accept_input, {
			membershipId: f.scope.membershipId,
			requestId: "later-deep-parent",
			kind: "move",
			expectedSourceCount: 10,
			sourceIds: f.sourceIds,
			targetParentId: f.targetId,
		});
		if (accepted._nay) throw new Error(accepted._nay.message);
		const { runId, activityId } = accepted._yay;
		expect((await f.t.run((ctx) => ctx.db.get("files_transfer_runs", runId)))?.step).toBe("uploading");
		const page = { membershipId: f.scope.membershipId, runId, offset: 8, sourceIds: [f.sourceIds[0]!, ancestor._id] };
		const finalAppend = f.asUser.mutation(api.files_transfer.append_input, page);
		await expect(finalAppend, "complete deep input append stays within the real mutation limits").resolves.toEqual({
			_yay: null,
		});
		const partial = await read_continuation(f, runId);
		expect(partial.items, "covered children and their duplicate create no root item").toEqual([]);
		expect(partial.activity!.progress.discovered).toBe(0);
		const scheduled = await f.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
		expect(await f.asUser.mutation(api.files_transfer.append_input, page)).toEqual({ _yay: null });
		expect(
			(await f.t.run((ctx) => ctx.db.get("files_transfer_runs", runId)))?.selection,
			"exact replay does not restart a parent walk",
		).toEqual(partial.run.selection);
		expect((await f.t.run((ctx) => ctx.db.get("activities", activityId)))?.progress).toEqual(
			partial.activity!.progress,
		);
		expect(await f.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).toEqual(scheduled);
		await test_finish_transfer_run(f.asUser, runId);
		const run = await f.t.run((ctx) => ctx.db.get("files_transfer_runs", runId));
		expect(run?.selection).toMatchObject({ expectedCount: 10, count: 10, cursor: 9 });
		expect(
			run?.selection?.normalizingParentPath,
			"coverage and duplicate completion clear the saved walk",
		).toBeUndefined();
		const items = await f.t.run((ctx) =>
			ctx.db
				.query("files_transfer_items")
				.withIndex("by_run_order", (q) => q.eq("runId", runId))
				.collect(),
		);
		expect(items.map((item) => ({ order: item.order, source: item.source, state: item.state }))).toEqual([
			{ order: 0, source: { kind: "saved", id: ancestor._id }, state: "completed" },
		]);
		expect(await f.t.run((ctx) => ctx.db.get("files_nodes", ancestor._id))).toMatchObject({
			_id: ancestor._id,
			parentId: f.targetId,
			name: "a",
			path: "/target/a",
		});
		for (const [index, sourceId] of f.sourceIds.entries()) {
			const node = await f.t.run((ctx) => ctx.db.get("files_nodes", sourceId));
			expect(node).toMatchObject({
				_id: sourceId,
				name: String(index),
				path: `/target/a${f.sourcePaths[index]!.slice(ancestorPath.length)}`,
			});
			expect(node?.moveCohortId).toBeUndefined();
		}
		expect(await f.t.run((ctx) => ctx.db.get("activities", activityId))).toMatchObject({
			status: "succeeded",
			progress: { discovered: 1, total: 1, completed: 1, failed: 0, canceled: 0 },
		});
		expect_costs(costs);
	}, 120_000);

	test("public Stop between deep Normalize slices keeps every source and exact replay does not restart work", async () => {
		const f = await fixture();
		const costs = track_costs();
		const args = {
			membershipId: f.scope.membershipId,
			requestId: "stop-deep-normalize",
			kind: "move" as const,
			expectedSourceCount: 8,
			sourceIds: f.sourceIds,
			targetParentId: f.targetId,
		};
		const accepted = await f.asUser.mutation(api.files_transfer.accept_input, args);
		if (accepted._nay) throw new Error(accepted._nay.message);
		const { runId, activityId } = accepted._yay;
		const partial = await read_continuation(f, runId);
		expect(await f.asUser.mutation(api.files_transfer.stop, { membershipId: f.scope.membershipId, runId })).toEqual({
			_yay: null,
		});
		await test_finish_transfer_run(f.asUser, runId);
		const scheduled = await f.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
		expect(await f.asUser.mutation(api.files_transfer.accept_input, args)).toEqual(accepted);
		expect(
			await f.asUser.mutation(api.files_transfer.append_input, {
				membershipId: f.scope.membershipId,
				runId,
				offset: 0,
				sourceIds: f.sourceIds,
			}),
		).toEqual({ _yay: null });
		expect(
			await f.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect()),
			"stopped replay adds no owner",
		).toEqual(scheduled);
		expect((await f.t.run((ctx) => ctx.db.get("files_transfer_runs", runId)))?.selection).toEqual(
			partial.run.selection,
		);
		expect(await f.t.run((ctx) => ctx.db.get("activities", activityId))).toMatchObject({
			status: "canceled",
			progress: { completed: 0, failed: 0, canceled: partial.items.length },
		});
		expect(
			await f.t.run((ctx) =>
				ctx.db
					.query("files_move_cohorts")
					.withIndex("by_origin_run", (q) => q.eq("origin.kind", "transfer").eq("origin.runId", runId))
					.first(),
			),
			"Stop before Normalize finishes never publishes a cohort",
		).toBeNull();
		for (const [index, sourceId] of f.sourceIds.entries()) {
			const node = await f.t.run((ctx) => ctx.db.get("files_nodes", sourceId));
			expect(node).toMatchObject({ _id: sourceId, name: String(index), path: f.sourcePaths[index] });
			expect(node?.moveCohortId).toBeUndefined();
		}
		expect_costs(costs);
	}, 120_000);
});
