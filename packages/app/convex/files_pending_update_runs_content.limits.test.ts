// The connected text unit above the old 20 MiB allowance is in
// files_pending_update_runs_content.limits_connected.test.ts, so the two files can run at the same time.
import { Workpool } from "@convex-dev/workpool";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, components, internal } from "./_generated/api.js";
import { quotas_db_ensure } from "./quotas.ts";
import { test_drain_billing_usage_event_outbox } from "./setup.test.ts";
import {
	finish_review,
	fixture,
	mock_review_storage,
	private_node,
	saved_text,
	set_upload_duration_ms,
	start_review,
} from "./files_pending_update_runs_content.setup.test.ts";

beforeEach(mock_review_storage);

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("review job content", () => {
	test.each([false, true])(
		"saves text above private storage caps and settles its holds (anonymous: %s)",
		async (anonymous) => {
			const f = await fixture(anonymous);
			const enqueue = vi.spyOn(Workpool.prototype, "enqueueAction");
			const proposal = await private_node({ f, path: "/draft.txt", text: "selected content\n" });
			const beforeBilling = await f.t.run((ctx) => ctx.db.query("billing_usage_snapshots").first());
			await f.t.run(async (ctx) => {
				for (const quotaName of ["files_private_user_bytes", "files_private_workspace_bytes"] as const) {
					const id = await quotas_db_ensure(ctx, { ...f.scope, quotaName, now: Date.now() });
					await ctx.db.patch("quotas", id, { maxCount: 0 });
				}
			});
			const batch = await f.asUser.mutation(api.files_pending_updates.create_file_pending_update_operation_batch, {
				membershipId: f.db.membershipId,
				target: proposal.target,
			});
			if (batch._nay) throw new Error(batch._nay.message);
			expect(
				(
					await f.t.mutation(internal.files_pending_updates.stage_file_pending_update_text_input_internal, {
						...f.scope,
						operationBatchId: batch._yay.operationBatchId,
						role: "unstaged",
						text: "extra bytes",
					})
				)._nay?.name,
			).toBe("storage_full");
			await f.t.mutation(internal.files_pending_updates.retire_file_pending_update_operation_batch, {
				operationBatchId: batch._yay.operationBatchId,
			});
			const runId = await start_review({ f, proposals: [proposal] });
			const result = await finish_review({ f, runId });
			expect(result?.activity).toMatchObject({ status: "succeeded", progress: { completed: 1 } });
			const saved = await f.t.run((ctx) => ctx.db.query("files_nodes").unique());
			if (!saved) throw new Error("Expected the saved text");
			expect(await saved_text(f, saved._id)).toBe("selected content\n");
			const content = await f.t.run((ctx) => ctx.db.query("files_move_cohort_content").unique());
			expect(content).toMatchObject({ nodeId: saved._id, sealed: true });
			const holds = await f.t.run((ctx) => ctx.db.query("files_private_storage_reservations").collect());
			const publicationHolds = holds.filter((hold) => hold.cohortContentId === content!._id && hold.publicationBatchId);
			expect(publicationHolds.length).toBeGreaterThan(0);
			for (const hold of publicationHolds) expect(hold.publicationBatchId).toBe(content!.operationBatchId);
			const savedAssets = publicationHolds.filter((hold) => hold.resource.kind === "asset");
			expect(savedAssets.length).toBeGreaterThan(0);
			for (const hold of savedAssets) expect(hold.settlement).toMatchObject({ kind: "saved", savedNodeId: saved._id });
			const quotas = await f.t.run((ctx) => ctx.db.query("quotas").collect());
			for (const quota of quotas.filter(
				(quota) =>
					quota.quotaName === "files_private_user_bytes" || quota.quotaName === "files_private_workspace_bytes",
			)) {
				const heldBytes = holds
					.filter(
						(hold) =>
							hold.settlement.kind === "held" &&
							hold.cohortContentId === undefined &&
							hold.resource.kind !== "node" &&
							(hold.userQuotaId === quota._id || hold.workspaceQuotaId === quota._id),
					)
					.reduce((total, hold) => total + hold.byteCount, 0);
				expect(quota.usedCount).toBe(heldBytes);
			}
			await test_drain_billing_usage_event_outbox(f.t);
			const billingCalls = enqueue.mock.calls.filter((call) => getFunctionName(call[1]) === "billing:ingest_events");
			const afterBilling = await f.t.run((ctx) => ctx.db.query("billing_usage_snapshots").first());
			if (anonymous) {
				expect(billingCalls).toHaveLength(0);
				expect(afterBilling?.meter?.consumedUnits).toBe(beforeBilling!.meter!.consumedUnits + 1);
				expect(afterBilling?.meter?.balance).toBe(beforeBilling!.meter!.balance - 1);
			} else {
				expect(billingCalls).toHaveLength(1);
				expect(billingCalls[0]![2]).toMatchObject({
					events: [{ name: "file_save", metadata: { amount: 1, nodeId: saved._id } }],
				});
				expect(afterBilling).toEqual(beforeBilling);
				const index = enqueue.mock.calls.indexOf(billingCalls[0]!);
				const workId = await enqueue.mock.results[index]!.value;
				expect(
					await f.t.query((ctx) => new Workpool(components.billing_workpool_usage_event, {}).status(ctx, workId)),
				).toMatchObject({ state: "pending" });
			}
		},
	);

	test.each([false, true])(
		"saves a connected content unit above the old commit budget (anonymous: %s)",
		async (anonymous) => {
			const f = await fixture(anonymous);
			const parent = await private_node({ f, path: "/large" });
			const children = [];
			// The old commit saved the whole unit in one transaction, and 64 files went over its budget. Now the
			// Move does one item or a page of 8 per step, so no step grows with the unit: 16 files fill every page
			// of 8 twice and still do many times more work in total than one transaction allows.
			for (let index = 0; index < 16; index++)
				children.push(await private_node({ f, path: `/large/file-${index}.txt`, text: `file ${index}\n` }));
			const proposals = [parent, ...children];
			const beforeBilling = await f.t.run((ctx) => ctx.db.query("billing_usage_snapshots").first());
			const enqueue = vi.spyOn(Workpool.prototype, "enqueueAction");
			// Each upload advances time while the same reviewed group stays active.
			set_upload_duration_ms(1_200);
			const runId = await start_review({ f, proposals });
			const startedAt = Date.now();
			const result = await finish_review({ f, runId });
			expect(Date.now() - startedAt).toBeGreaterThan(0);
			expect(Date.now() - startedAt).toBeLessThan(5 * 60 * 1000);
			expect(result?.activity, "the whole connected Save passes the old commit budget").toMatchObject({
				status: "succeeded",
				progress: { completed: 17, blocked: 0 },
			});
			expect(result?.run.unitCount).toBe(1);
			expect(await f.t.run((ctx) => ctx.db.query("files_pending_update_run_units").collect())).toMatchObject([
				{ kind: "cohort", status: "completed", itemCount: 17 },
			]);
			const saved = await f.t.run((ctx) => ctx.db.query("files_nodes").collect());
			expect(saved).toHaveLength(17);
			const savedParent = saved.find((node) => node.path === "/large");
			expect(savedParent).toMatchObject({ kind: "folder", parentId: "root" });
			for (let index = 0; index < 16; index++) {
				const node = saved.find((row) => row.path === `/large/file-${index}.txt`);
				expect(node).toMatchObject({ kind: "file", parentId: savedParent!._id });
				expect(await saved_text(f, node!._id)).toBe(`file ${index}\n`);
			}
			expect(await f.t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect())).toHaveLength(17);
			expect(await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect())).toEqual([]);
			const holds = await f.t.run((ctx) => ctx.db.query("files_private_storage_reservations").collect());
			const publicationHolds = holds.filter((hold) => hold.publicationBatchId && hold.cohortContentId);
			expect(publicationHolds.length).toBeGreaterThan(0);
			expect(
				publicationHolds.filter((hold) => hold.resource.kind === "asset" && hold.settlement.kind === "saved"),
			).toHaveLength(32);
			await test_drain_billing_usage_event_outbox(f.t);
			const billingCalls = enqueue.mock.calls.filter((call) => getFunctionName(call[1]) === "billing:ingest_events");
			// The outbox drainer sends the events in batches of up to 100.
			const billedEvents = billingCalls.flatMap((call) => (call[2] as { events: unknown[] }).events);
			const afterBilling = await f.t.run((ctx) => ctx.db.query("billing_usage_snapshots").first());
			if (anonymous) {
				expect(billingCalls).toHaveLength(0);
				expect(afterBilling?.meter?.consumedUnits).toBe(beforeBilling!.meter!.consumedUnits + 16);
				expect(afterBilling?.meter?.balance).toBe(beforeBilling!.meter!.balance - 16);
			} else {
				expect(billedEvents).toHaveLength(16);
				expect(afterBilling).toEqual(beforeBilling);
				expect(billedEvents).toEqual(
					expect.arrayContaining(
						saved
							.filter((node) => node.kind === "file")
							.map((node) =>
								expect.objectContaining({
									name: "file_save",
									metadata: expect.objectContaining({ amount: 1, nodeId: node._id }),
								}),
							),
					),
				);
				for (const call of billingCalls) {
					const index = enqueue.mock.calls.indexOf(call);
					const workId = await enqueue.mock.results[index]!.value;
					expect(
						await f.t.query((ctx) => new Workpool(components.billing_workpool_usage_event, {}).status(ctx, workId)),
					).toMatchObject({ state: "pending" });
				}
			}
		},
		7_200_000,
	);
});
