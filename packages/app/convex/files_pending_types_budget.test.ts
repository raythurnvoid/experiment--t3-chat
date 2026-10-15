import type { TransactionMetrics } from "convex/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { internal } from "./_generated/api.js";
import { fixture, insert_saved_node } from "./files_pending_overlay.setup.test.ts";
import { run_job } from "./files_pending_overlay.ts";
import { upsert_file_pending_archive_in_db } from "./files_pending_updates.ts";
import { test_db_hold_move_slot, test_seed_folder_chain, test_spy_handler } from "./setup.test.ts";
import { files_type_query_db_get_readiness } from "../server/files-type-query.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

test(
	"a deep draft delete yields and restores typed-search readiness during another Move",
	{ timeout: 120_000 },
	async () => {
		const f = await fixture(true);
		const chain = await test_seed_folder_chain(f.t, {
			scope: f.u,
			createdBy: f.u.userId,
			parentId: "root",
			parentPath: "",
			startDepth: 1,
			depth: 510,
			restrictedScopeNodeId: null,
		});
		const parentId = chain.id;
		if (parentId === "root") throw new Error("Expected a saved folder chain");
		const leaf = await f.t.run(
			async (ctx) =>
				await insert_saved_node(ctx, f.u, {
					parent: await ctx.db.get("files_nodes", parentId),
					name: "b",
					kind: "file",
				}),
		);
		expect(leaf.path.length).toBe(1022);
		// An unrelated Move adds selected-view lookups but does not reserve this tree.
		await f.t.run((ctx) => test_db_hold_move_slot(ctx, f.db));
		const costs: TransactionMetrics[] = [];
		for (const mutation of [upsert_file_pending_archive_in_db, run_job])
			test_spy_handler(mutation, async (handler, ctx, args) => {
				const result = await handler(ctx, args);
				costs.push(await ctx.meta.getTransactionMetrics());
				return result;
			});

		const proposed = await f.t.mutation(internal.files_pending_updates.upsert_file_pending_archive_in_db, {
			...f.u,
			target: { kind: "saved", id: leaf._id },
		});
		expect(proposed._nay, "deep draft write stays within transaction limits").toBeUndefined();
		expect(await f.t.run((ctx) => files_type_query_db_get_readiness(ctx.db, f.u))).toEqual({ state: "updating" });
		await f.settle();
		const final = await f.t.run(async (ctx) => ({
			readiness: await files_type_query_db_get_readiness(ctx.db, f.u),
			hide: await ctx.db
				.query("files_pending_hides")
				.withIndex("by_savedNode_user", (q) => q.eq("savedNodeId", leaf._id).eq("userId", f.u.userId))
				.unique(),
			work: await ctx.db.query("files_pending_overlay_resolve_work").collect(),
			jobs: await ctx.db.query("files_pending_overlay_jobs").collect(),
		}));
		expect(final.readiness).toEqual({ state: "ready" });
		expect(final.hide?.savedNodeId).toBe(leaf._id);
		expect(final.work).toEqual([]);
		expect(final.jobs).toEqual([]);
		expect(costs.length).toBeGreaterThan(1);
		for (const metrics of costs) {
			expect(Object.keys(metrics)).toHaveLength(7);
			for (const [name, metric] of Object.entries(metrics))
				expect(metric.remaining, `${name} must keep room after each producer or worker step`).toBeGreaterThanOrEqual(0);
		}
	},
);
