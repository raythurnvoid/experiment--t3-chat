// Split from files_pending_update_runs_content.limits.test.ts, so the two files can run at the same time.
import { Workpool } from "@convex-dev/workpool";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { quotas_db_ensure } from "./quotas.ts";
import { test_drain_billing_usage_event_outbox } from "./setup.test.ts";
import {
	finish_review,
	fixture,
	mock_review_storage,
	private_node,
	saved_text,
	start_review,
} from "./files_pending_update_runs_content.setup.test.ts";
import { files_MAX_TEXT_CONTENT_BYTES } from "../shared/files.ts";

beforeEach(mock_review_storage);

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("review job content", () => {
	test("saves a connected text unit above the old 20 MiB preparation allowance", async () => {
		const f = await fixture();
		const parent = await private_node({ f, path: "/full" });
		const children = [];
		// Each saved file holds 2 assets and 1 text input of 900,000 bytes, so 8 files hold 21.6 MB, just above
		// 20 MiB (7 files hold 18.9 MB). A 3-byte character fills the byte cap with a third of the 1,200-character
		// chunks of ASCII text, so the Move steps that write chunks in pages of 8 run 3 times less often.
		const text = "中".repeat(files_MAX_TEXT_CONTENT_BYTES / 3);
		for (let index = 0; index < 8; index++)
			children.push(await private_node({ f, path: `/full/file-${index}.txt`, text }));
		const proposals = [parent, ...children];
		const beforeBilling = await f.t.run((ctx) => ctx.db.query("billing_usage_snapshots").first());
		const enqueue = vi.spyOn(Workpool.prototype, "enqueueAction");
		await f.t.run(async (ctx) => {
			for (const quotaName of ["files_private_user_bytes", "files_private_workspace_bytes"] as const) {
				const id = await quotas_db_ensure(ctx, { ...f.scope, quotaName, now: Date.now() });
				await ctx.db.patch("quotas", id, { maxCount: 0 });
			}
		});
		const result = await finish_review({ f, runId: await start_review({ f, proposals }) });
		expect(result?.activity, "the whole connected Save passes the old preparation allowance").toMatchObject({
			status: "succeeded",
			progress: { completed: 9, blocked: 0 },
		});
		expect(result?.run.unitCount).toBe(1);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_update_run_units").collect())).toMatchObject([
			{ kind: "cohort", status: "completed", itemCount: 9 },
		]);
		const saved = await f.t.run((ctx) => ctx.db.query("files_nodes").collect());
		expect(saved).toHaveLength(9);
		expect(saved.find((node) => node.path === "/full")).toMatchObject({ kind: "folder", parentId: "root" });
		for (let index = 0; index < 8; index++) {
			const node = saved.find((node) => node.path === `/full/file-${index}.txt`);
			expect(node).toMatchObject({ kind: "file", parentId: saved.find((row) => row.path === "/full")!._id });
			expect(await saved_text(f, node!._id)).toBe(text);
		}
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect())).toHaveLength(9);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect())).toEqual([]);
		expect(await f.t.run((ctx) => ctx.db.query("billing_usage_snapshots").first())).toEqual(beforeBilling);
		await test_drain_billing_usage_event_outbox(f.t);
		const billedEvents = enqueue.mock.calls
			.filter((call) => getFunctionName(call[1]) === "billing:ingest_events")
			.flatMap((call) => (call[2] as { events: unknown[] }).events);
		expect(billedEvents).toHaveLength(8);
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
		const holds = await f.t.run((ctx) => ctx.db.query("files_private_storage_reservations").collect());
		const contents = await f.t.run((ctx) => ctx.db.query("files_move_cohort_content").collect());
		expect(contents).toHaveLength(9);
		const publicationHolds = holds.filter((hold) => hold.publicationBatchId && hold.cohortContentId);
		const publicationBytes = publicationHolds.reduce((sum, hold) => sum + hold.byteCount, 0);
		expect(publicationBytes, "cohort output is not capped by the one-Save allowance").toBeGreaterThan(20 * 1024 * 1024);
		for (const hold of publicationHolds) {
			const content = contents.find((row) => row._id === hold.cohortContentId);
			expect(hold.publicationBatchId).toBe(content?.operationBatchId);
			if (hold.resource.kind === "asset")
				expect(hold.settlement).toMatchObject({ kind: "saved", savedNodeId: content?.nodeId });
		}
		const quotas = await f.t.run((ctx) => ctx.db.query("quotas").collect());
		for (const quota of quotas.filter(
			(quota) => quota.quotaName === "files_private_user_bytes" || quota.quotaName === "files_private_workspace_bytes",
		)) {
			const heldBytes = holds
				.filter(
					(hold) =>
						hold.settlement.kind === "held" &&
						hold.cohortContentId === undefined &&
						hold.resource.kind !== "node" &&
						(hold.userQuotaId === quota._id || hold.workspaceQuotaId === quota._id),
				)
				.reduce((sum, hold) => sum + hold.byteCount, 0);
			expect(quota.usedCount).toBe(heldBytes);
		}
	}, 7_200_000);
});
