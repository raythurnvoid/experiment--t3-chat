// Measure paged Move steps, including the pending overlay flush. Keep a 25% margin when choosing
// each Move step's size.
//
// Vitest hides the logs of passing tests. Run with `--silent=false --reporter=default` to see the
// numbers. In an agent shell Vitest picks a reporter that hides them even with `--silent=false`.
// The full maximum Move fixture runs with `test:files:full-size`.
// Two smaller Move tests split its sizes for the default run. The owner tests are in
// files_pending_overlay_limits.move_owners.test.ts, so the two files can run at the same time.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import { files_ROOT_ID } from "../server/files.ts";
import {
	finish_scheduled,
	mock_overlay_limits_storage,
	transaction_cost,
} from "./files_pending_overlay_limits.setup.test.ts";
import { MAX_DRAFT_OWNERS, measure_paged_move } from "./files_pending_overlay_limits.move.setup.test.ts";

beforeEach(mock_overlay_limits_storage);
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("paged Move transaction budgets", () => {
	test("Scheduled Move progress ignores old worker history", async () => {
		const t = test_convex({ transactionLimits: true });
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const folders: Id<"files_nodes">[] = [];
		for (const path of ["/source", "/target"]) {
			const created = await asOwner.mutation(api.files_nodes.create_folder_node, {
				membershipId: db.membershipId,
				parentId: files_ROOT_ID,
				path,
			});
			if (created._nay) throw new Error(created._nay.message);
			folders.push(created._yay.nodeId);
		}
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		const started = await asOwner.mutation(api.files_transfer.accept_input, {
			membershipId: db.membershipId,
			requestId: "move-with-old-worker-history",
			kind: "move",
			expectedSourceCount: 1,
			sourceIds: [folders[0]!],
			targetParentId: folders[1]!,
		});
		if (started._nay) throw new Error(started._nay.message);
		const { runId } = started._yay;
		const historyDelay = 24 * 60 * 60 * 1000;
		const historyDueAt = Date.now() + historyDelay;
		const scheduledCount = await t.run(async (ctx) => {
			const before = await ctx.meta.getTransactionMetrics();
			for (let index = 0; index < 500; index++) {
				const jobId = await ctx.scheduler.runAfter(historyDelay, internal.files_transfer.advance, { runId });
				await ctx.scheduler.cancel(jobId);
			}
			return transaction_cost(before, await ctx.meta.getTransactionMetrics()).functionsScheduled;
		});
		expect(scheduledCount).toBe(500);
		// Canceled jobs keep their history. Their fake timers stay past this Move.
		const history = await t.run(async (ctx) =>
			(await ctx.db.system.query("_scheduled_functions").collect()).filter((job) => job.scheduledTime === historyDueAt),
		);
		expect(history).toHaveLength(500);
		expect(history.every((job) => job.state.kind === "canceled")).toBe(true);
		const run = t.run;
		let peakDocumentsRead = 0;
		t.run = async <Output>(func: Parameters<typeof run<Output>>[0]) =>
			await run(async (ctx) => {
				const before = await ctx.meta.getTransactionMetrics();
				const result = await func(ctx);
				const after = await ctx.meta.getTransactionMetrics();
				peakDocumentsRead = Math.max(peakDocumentsRead, transaction_cost(before, after).documentsRead);
				return result;
			});
		try {
			await finish_scheduled(t, async () =>
				(await asOwner.query(api.files_transfer_queries.get, { membershipId: db.membershipId, runId }))?.activity.finishedAt !== undefined,
			);
		} finally {
			t.run = run;
		}
		expect(await asOwner.query(api.files_transfer_queries.get, { membershipId: db.membershipId, runId })).toMatchObject({
			activity: { status: "succeeded", progress: { completed: 1, failed: 0, canceled: 0 } },
		});
		expect((await t.run((ctx) => ctx.db.get("files_nodes", folders[0]!)))?.path).toBe("/target/source");
		expect(Date.now()).toBeLessThan(historyDueAt);
		expect(peakDocumentsRead, "Scheduled Move progress must not read old worker history").toBeLessThan(32);
	}, 120_000);

	// The full size: 16 owners with 896 metadata docs each and a large text make about 8,700 Move steps.
	// It runs only in `test:files:full-size`. The steps
	// work in pages, so one step's cost does not grow with the owner count, the doc count or the text
	// size. The two tests below split these sizes and reach the same peak per phase (checked once
	// against this test).
	test(
		"measures scheduled phases with maximum metadata, draft copies, shares and links",
		{ tags: ["full-size"], timeout: 7_200_000 },
		async () => {
			await measure_paged_move({ owners: MAX_DRAFT_OWNERS, keys: 128, lines: 12_000 });
		},
	);

	// The maximum metadata with one owner. 200 lines make about 12 text chunks, more than one page of
	// 8. A larger text only adds steps, and saving it takes most of the full test's fixture time.
	test("measures scheduled phases with maximum metadata, shares, links and one draft copy", async () => {
		await measure_paged_move({ owners: 1, keys: 128, lines: 200, dense: true });
	}, 1_200_000);
});
