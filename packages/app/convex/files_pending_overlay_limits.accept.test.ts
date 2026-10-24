// Measure Accept cohort steps, including the pending overlay flush.
//
// Vitest hides the logs of passing tests. Run with `--silent=false --reporter=default` to see the
// numbers. In an agent shell Vitest picks a reporter that hides them even with `--silent=false`.
//
// The Metadata cleanup tests are in files_pending_overlay_limits.accept_metadata.test.ts, so the two files
// can run at the same time.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { advance as advance_review } from "./files_pending_update_runs.ts";
import { upsert_file_pending_archive_in_db } from "./files_pending_updates.ts";
import { test_convex, test_create_saved_text_file, test_mocks_fill_db_with, test_spy_handler } from "./setup.test.ts";
import { files_ROOT_ID } from "../server/files.ts";
import { files_MAX_TEXT_CONTENT_BYTES, files_NAME_MAX_LENGTH, files_PATH_MAX_LENGTH } from "../shared/files.ts";
import {
	budget_recorder,
	finish_scheduled,
	measure_cohort,
	mock_overlay_limits_storage,
	transaction_cost,
} from "./files_pending_overlay_limits.setup.test.ts";

beforeEach(mock_overlay_limits_storage);
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("cohort Accept transaction budgets", () => {
	test("measures a linked public Accept through publication and cleanup", async () => {
		const t = test_convex({ transactionLimits: true });
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId };
		const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const nodes: Id<"files_nodes">[] = [];
		for (let index = 0; index < 3; index++) {
			const nodeId = await test_create_saved_text_file(t, {
				membershipId: db.membershipId,
				path: `/inbox/note-${index}.md`,
				textContent: [
					"---",
					...Array.from({ length: 20 }, (_, key) => `field${key}: value-${key}`),
					"---",
					"",
					"Saved text.",
				].join("\n"),
			});
			nodes.push(nodeId);
		}
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		const parentId = (await t.run((ctx) => ctx.db.get("files_nodes", nodes[0]!)))!.parentId;
		if (parentId === files_ROOT_ID) throw new Error("Expected the native inbox folder");
		const draft = async (index: number, destName: string) => {
			const proposal = await t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
				...scope,
				target: { kind: "saved", id: nodes[index]! },
				destParent: { kind: "saved", id: parentId },
				destName,
			});
			if (proposal._nay) throw new Error(proposal._nay.message);
		};
		await draft(0, "temporary-draft-name.md");
		await draft(2, "note-0.md");
		await draft(1, "note-2.md");
		await draft(0, "note-1.md");
		const proposals = await t.run((ctx) =>
			Promise.all(
				nodes.map((nodeId) =>
					ctx.db
						.query("files_pending_updates")
						.withIndex("by_user_target", (q) =>
							q.eq("userId", db.userId).eq("target.kind", "saved").eq("target.id", nodeId),
						)
						.unique(),
				),
			),
		);
		const { peaks, record } = budget_recorder();
		measure_cohort(record);
		test_spy_handler(advance_review, async (handler, ctx, args) => {
			const before = await ctx.meta.getTransactionMetrics();
			const result = await handler(ctx, args);
			record("review/advance", transaction_cost(before, await ctx.meta.getTransactionMetrics()));
			return result;
		});
		const started = await asOwner.mutation(api.files_pending_update_runs.start, {
			membershipId: db.membershipId,
			requestId: crypto.randomUUID(),
			kind: "accept",
			expectedItemCount: 3,
			items: proposals.map((proposal) => ({
				pendingUpdateId: proposal!._id,
				reviewedRevision: proposal!.revision,
				selectedContentStateId: null,
			})),
		});
		if (started._nay) throw new Error(started._nay.message);
		const { runId } = started._yay;
		expect(
			await asOwner.mutation(api.files_pending_update_runs.seal, { membershipId: db.membershipId, runId }),
		).toEqual({ _yay: null });
		await finish_scheduled(
			t,
			async () =>
				(await asOwner.query(api.files_pending_update_runs.get, { membershipId: db.membershipId, runId }))?.run.step ===
				"finished",
		);
		expect(
			(await asOwner.query(api.files_pending_update_runs.get, { membershipId: db.membershipId, runId }))?.activity,
			"the measured linked Accept completes through native cohort workers",
		).toMatchObject({ status: "succeeded", progress: { completed: 3 } });
		expect(peaks.get("cohort/publish")?.calls, "linked Accept uses one cohort switch").toBe(1);
		expect(peaks.get("cohort/finish_nodes")?.calls).toBeGreaterThan(0);
		const saved = await t.run((ctx) => Promise.all(nodes.map((nodeId) => ctx.db.get("files_nodes", nodeId))));
		expect(saved.map((node) => node?.name)).toEqual(["note-1.md", "note-2.md", "note-0.md"]);
		expect(saved.every((node) => node?.moveCohortId === undefined)).toBe(true);
		console.info(
			"linked public Accept phase peaks, with the metadata catalog",
			JSON.stringify(Object.fromEntries(peaks)),
		);
	}, 180_000);

	test("measures an accepted delete of a file with a full-size text edit", async () => {
		const t = test_convex({ transactionLimits: true });
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId };
		const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const nodeId = await test_create_saved_text_file(t, {
			membershipId: db.membershipId,
			path: "/inbox/edited.md",
			textContent: "Saved text.\n",
		});
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		const target = { kind: "saved", id: nodeId } as const;
		const batch = await t.mutation(internal.files_pending_updates.create_file_pending_update_operation_batch_internal, {
			...scope,
			target,
			expectedPendingContentVersion: (await t.run((ctx) => ctx.db.get("files_nodes", target.id)))!.pendingContentVersion,
		});
		if (batch._nay) throw new Error(batch._nay.message);
		// A full-size edit of short lines, so the text makes many chunks.
		const text = Array.from({ length: files_MAX_TEXT_CONTENT_BYTES / 16 }, (_, index) =>
			index.toString(36).padStart(15, "-"),
		).join("\n");
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
				target,
				operationBatchId: batch._yay.operationBatchId,
			}),
		).toEqual({ _yay: null });
		expect(
			(await t.mutation(internal.files_pending_updates.upsert_file_pending_archive_in_db, { ...scope, target }))._nay,
		).toBeUndefined();
		const proposal = (await t.run((ctx) => ctx.db.query("files_pending_updates").collect())).find(
			(row) => row.target.id === nodeId,
		)!;
		expect(proposal.pendingArchive && proposal.content).toBeTruthy();
		const pendingDocs = async () =>
			await t.run(async (ctx) =>
				[
					...(await ctx.db.query("files_plain_text_chunks").collect()),
					...(await ctx.db.query("files_text_chunks").collect()),
				].filter((row) => "pendingUpdateId" in row && row.pendingUpdateId === proposal._id),
			);
		expect((await pendingDocs()).length).toBeGreaterThan(1000);
		const { peaks, record } = budget_recorder();
		measure_cohort(record);
		const started = await asOwner.mutation(api.files_pending_update_runs.start, {
			membershipId: db.membershipId,
			requestId: crypto.randomUUID(),
			kind: "accept",
			expectedItemCount: 1,
			items: [
				{
					pendingUpdateId: proposal._id,
					reviewedRevision: proposal.revision,
					selectedContentStateId: proposal.content?.unstagedStateId ?? null,
				},
			],
		});
		if (started._nay) throw new Error(started._nay.message);
		const { runId } = started._yay;
		expect(
			await asOwner.mutation(api.files_pending_update_runs.seal, { membershipId: db.membershipId, runId }),
		).toEqual({ _yay: null });
		await finish_scheduled(
			t,
			async () =>
				(await asOwner.query(api.files_pending_update_runs.get, { membershipId: db.membershipId, runId }))?.run.step ===
				"finished",
		);
		expect(
			(await asOwner.query(api.files_pending_update_runs.get, { membershipId: db.membershipId, runId }))?.activity,
		).toMatchObject({ status: "succeeded", progress: { completed: 1 } });
		expect((await t.run((ctx) => ctx.db.get("files_nodes", nodeId)))?.archiveOperationId).not.toBeNull();
		// The finish deletes a few chunks with the draft. A background drain deletes the rest after the Move.
		await finish_scheduled(t, async () => (await pendingDocs()).length === 0);
		expect(await pendingDocs(), "no pending index doc outlives the draft").toEqual([]);
		expect(peaks.get("cohort/finish_nodes")?.calls).toBeGreaterThan(0);
		console.info("accepted delete with a full-size edit, phase peaks", JSON.stringify(Object.fromEntries(peaks)));
	}, 900_000);

	test("keeps the draft delete of a full-size edit at the longest path under the budget", async () => {
		const t = test_convex({ transactionLimits: true });
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId };
		// Every plain text chunk stores this path, and the delete patches every chunk.
		const path = `/${Array.from({ length: 3 }, (_, index) => String(index).repeat(files_NAME_MAX_LENGTH)).join("/")}/${"e".repeat(files_NAME_MAX_LENGTH - 3)}.md`;
		expect(path).toHaveLength(files_PATH_MAX_LENGTH);
		const nodeId = await test_create_saved_text_file(t, { membershipId: db.membershipId, path, textContent: "Saved." });
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		const target = { kind: "saved", id: nodeId } as const;
		const batch = await t.mutation(internal.files_pending_updates.create_file_pending_update_operation_batch_internal, {
			...scope,
			target,
			expectedPendingContentVersion: (await t.run((ctx) => ctx.db.get("files_nodes", target.id)))!.pendingContentVersion,
		});
		if (batch._nay) throw new Error(batch._nay.message);
		const text = Array.from({ length: files_MAX_TEXT_CONTENT_BYTES / 16 }, (_, index) =>
			index.toString(36).padStart(15, "-"),
		).join("\n");
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
				target,
				operationBatchId: batch._yay.operationBatchId,
			}),
		).toEqual({ _yay: null });
		const { peaks, record } = budget_recorder();
		test_spy_handler(upsert_file_pending_archive_in_db, async (handler, ctx, args) => {
			const before = await ctx.meta.getTransactionMetrics();
			const result = await handler(ctx, args);
			record("draft delete", transaction_cost(before, await ctx.meta.getTransactionMetrics()));
			return result;
		});
		expect(
			(await t.mutation(internal.files_pending_updates.upsert_file_pending_archive_in_db, { ...scope, target }))._nay,
		).toBeUndefined();
		expect(peaks.get("draft delete")?.calls).toBe(1);
		console.info("draft delete at the longest path", JSON.stringify(Object.fromEntries(peaks)));
	}, 300_000);
});
