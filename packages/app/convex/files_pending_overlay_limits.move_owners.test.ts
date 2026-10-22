// Measure paged Move steps, including the pending overlay flush. Keep a 25% margin when choosing
// each Move step's size.
//
// Vitest hides the logs of passing tests. Run with `--silent=false --reporter=default` to see the
// numbers. In an agent shell Vitest picks a reporter that hides them even with `--silent=false`.
// Split from files_pending_overlay_limits.move.test.ts, so the two files can run at the same time.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { accept_input as accept_transfer_input, advance as advance_transfer } from "./files_transfer.ts";
import { test_convex, test_create_saved_text_file, test_mocks_fill_db_with, test_spy_handler } from "./setup.test.ts";
import {
	add_member,
	budget_recorder,
	finish_scheduled,
	insert_saved_node,
	measure_cohort,
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
	// The owner cap with two keys: 14 metadata docs, two pages per owner.
	test("measures scheduled phases with the most draft copies, shares and links", async () => {
		await measure_paged_move({ owners: MAX_DRAFT_OWNERS, keys: 2, lines: 200 });
	}, 600_000);

	test("moves one saved file while six owners have large pending content", async () => {
		const t = test_convex({ transactionLimits: true });
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const nodeId = await test_create_saved_text_file(t, {
			membershipId: db.membershipId,
			path: "/project/heavy.md",
			textContent: "Saved content.\n",
		});
		const seeded = await t.run(async (ctx) => {
			const target = await insert_saved_node(ctx, db, { parent: null, name: "target", kind: "folder" });
			const users: Id<"users">[] = [];
			for (let index = 0; index < 6; index++) users.push(await add_member(ctx, db, `clerk_heavy_content_${index}`));
			return { target, users };
		});
		await t.finishAllScheduledFunctions(vi.runAllTimers, 5_000);
		const text = "x".repeat(800 * 1024);
		for (const userId of seeded.users) {
			const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId };
			const batch = await t.mutation(
				internal.files_pending_updates.create_file_pending_update_operation_batch_internal,
				{
					...scope,
					target: { kind: "saved", id: nodeId },
				},
			);
			if (batch._nay) throw new Error(batch._nay.message);
			expect(
				await t.mutation(internal.files_pending_updates.stage_file_pending_update_text_input_internal, {
					...scope,
					operationBatchId: batch._yay.operationBatchId,
					role: "unstaged",
					text,
				}),
			).toEqual({ _yay: null });
			expect(
				await t.action(internal.files_pending_updates.upsert_file_pending_update_internal_action, {
					...scope,
					target: { kind: "saved", id: nodeId },
					operationBatchId: batch._yay.operationBatchId,
				}),
			).toEqual({ _yay: null });
		}
		const read_pending_chunks = async (ctx: MutationCtx) =>
			await ctx.db
				.query("files_plain_text_chunks")
				.withIndex("by_organization_workspace_target_chunkIndex", (q) =>
					q
						.eq("organizationId", db.organizationId)
						.eq("workspaceId", db.workspaceId)
						.eq("target.kind", "saved")
						.eq("target.id", nodeId),
				)
				.collect();
		await t.run(async (ctx) => {
			const chunks = await read_pending_chunks(ctx);
			expect(new Set(chunks.map((chunk) => (chunk.sourceKind === "pending" ? chunk.userId : null))).size).toBe(6);
			expect(
				chunks.reduce((sum, chunk) => sum + new TextEncoder().encode(chunk.plainTextChunk).byteLength, 0),
			).toBeGreaterThan(4 * 1024 * 1024);
		});
		const { peaks, record } = budget_recorder();
		measure_cohort(record);
		test_spy_handler(accept_transfer_input, async (handler, ctx, args) => {
			const before = await ctx.meta.getTransactionMetrics();
			const result = await handler(ctx, args);
			record("accept", transaction_cost(before, await ctx.meta.getTransactionMetrics()));
			return result;
		});
		const started = await asOwner.mutation(api.files_transfer.accept_input, {
			membershipId: db.membershipId,
			requestId: "move-six-heavy-drafts",
			kind: "move",
			expectedSourceCount: 1,
			sourceIds: [nodeId],
			targetParentId: seeded.target._id,
		});
		if (started._nay) throw new Error(started._nay.message);
		const { runId } = started._yay;
		test_spy_handler(advance_transfer, async (handler, ctx, args) => {
			const run = (await ctx.db.get("files_transfer_runs", runId))!;
			const before = await ctx.meta.getTransactionMetrics();
			const result = await handler(ctx, args);
			const cost = transaction_cost(before, await ctx.meta.getTransactionMetrics());
			record(`transfer/${run.step}`, cost);
			return result;
		});
		await finish_scheduled(
			t,
			async () =>
				(await asOwner.query(api.files_transfer_status.get, { membershipId: db.membershipId, runId }))?.activity.finishedAt !==
				undefined,
		);
		const receipt = await asOwner.query(api.files_transfer_status.get, { membershipId: db.membershipId, runId });
		expect(peaks.get("accept")?.calls, "the large draft budget includes automatic acceptance").toBe(1);
		console.info(
			"singleton Move with six native 800KiB drafts",
			JSON.stringify({ phases: Object.fromEntries(peaks), receipt }),
		);
		expect(receipt, "one saved root must move with six supported pending content branches").toMatchObject({
			activity: { status: "succeeded", progress: { completed: 1, failed: 0, canceled: 0 } },
		});
		await t.run(async (ctx) => {
			const chunks = await read_pending_chunks(ctx);
			expect(new Set(chunks.map((chunk) => (chunk.sourceKind === "pending" ? chunk.userId : null))).size).toBe(6);
			expect(chunks.every((chunk) => chunk.path === "/target/heavy.md")).toBe(true);
		});
	}, 900_000);
});
