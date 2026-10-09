import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import { advance, seal } from "./files_transfer.ts";
import { test_convex, test_mocks_fill_db_with, test_spy_handler } from "./setup.test.ts";
import { files_TRANSFER_SELECTION_PAGE_SIZE } from "../shared/files.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

async function create_fixture() {
	const t = test_convex({ transactionLimits: true });
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const create_folder = async (path: string) => {
		const created = await t.mutation(internal.files_nodes.create_folder_node_by_path, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			path,
		});
		if (created._nay) throw new Error(created._nay.message);
		return created._yay.nodeId;
	};
	const targetId = await create_folder("/target");
	const sourceId = await create_folder("/source");
	const childId = await create_folder("/source/child");
	return { t, db, asUser, targetId, sourceId, childId };
}

async function upload_repeated_source(fixture: Awaited<ReturnType<typeof create_fixture>>, count: number) {
	const { asUser, db, sourceId, targetId } = fixture;
	// Each request holds at most 100 ids. This tests input positions, not distinct roots.
	const page = Array.from({ length: files_TRANSFER_SELECTION_PAGE_SIZE }, () => sourceId);
	const startedAt = vi.getRealSystemTime();
	const started = await asUser.mutation(api.files_transfer.start, {
		membershipId: db.membershipId,
		requestId: `repeated-input-${count}`,
		kind: "move",
		expectedSourceCount: count,
		sourceIds: page.slice(0, count),
		targetParentId: targetId,
	});
	expect(started._nay, "Move accepts the first source page").toBeUndefined();
	if (started._nay) throw new Error(started._nay.message);
	for (let offset = page.length; offset < count; offset += page.length) {
		expect(
			await asUser.mutation(api.files_transfer.append_sources, {
				membershipId: db.membershipId,
				runId: started._yay.runId,
				offset,
				sourceIds: page.slice(0, Math.min(page.length, count - offset)),
			}),
			`Move accepts source positions at ${offset}`,
		).toEqual({ _yay: null });
		if ((offset + page.length) % 10_000 === 0)
			console.info("Move input positions admitted", {
				count: offset + page.length,
				elapsedMs: vi.getRealSystemTime() - startedAt,
			});
	}
	return started._yay;
}

describe("paged Move input scale", () => {
	test("completes 1001 duplicate input positions as one root through real scheduled steps", async () => {
		const fixture = await create_fixture();
		const { t, db, asUser, sourceId, targetId, childId } = fixture;
		const { runId } = await upload_repeated_source(fixture, 1_001);
		expect(await asUser.mutation(api.files_transfer.seal, { membershipId: db.membershipId, runId })).toEqual({
			_yay: null,
		});
		await t.finishAllScheduledFunctions(vi.runAllTimers, 5_000);
		expect(
			await asUser.query(api.files_transfer.get, { membershipId: db.membershipId, runId }),
			"duplicate input completes one root",
		).toMatchObject({
			activity: { status: "succeeded", progress: { discovered: 1, total: 1, completed: 1, failed: 0, canceled: 0 } },
		});
		expect(
			await asUser.query(api.files_transfer.list_items, {
				membershipId: db.membershipId,
				runId,
				state: "completed",
				paginationOpts: { cursor: null, numItems: 100 },
			}),
		).toMatchObject({ isDone: true, page: [{ movedNodeId: sourceId }] });
		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_nodes", sourceId)).toMatchObject({ parentId: targetId, path: "/target/source" });
			expect(await ctx.db.get("files_nodes", childId)).toMatchObject({ path: "/target/source/child" });
		});
	}, 180_000);

	test("seals 100000 input positions and keeps selection and normalization reads paged", async () => {
		const fixture = await create_fixture();
		const { t, db, asUser, sourceId } = fixture;
		const count = 100_000;
		const { runId, activityId } = await upload_repeated_source(fixture, count);
		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_transfer_runs", runId)).toMatchObject({
				step: "uploading",
				selection: { expectedCount: count, count, cursor: -1 },
			});
			for (const order of [0, 8_191, 8_192, count - 1]) {
				expect(
					await ctx.db
						.query("files_transfer_selection_items")
						.withIndex("by_run_order", (q) => q.eq("runId", runId).eq("order", order))
						.first(),
				).toMatchObject({
					order,
					source: { kind: "saved", id: sourceId },
				});
			}
		});
		test_spy_handler(seal, async (handler, ctx, args) => {
			const before = await ctx.meta.getTransactionMetrics();
			const result = await handler(ctx, args);
			const after = await ctx.meta.getTransactionMetrics();
			expect(after.documentsRead.used - before.documentsRead.used, "seal does not collect the input").toBeLessThan(100);
			return result;
		});
		await expect(
			asUser.mutation(api.files_transfer.seal, { membershipId: db.membershipId, runId }),
			"100000 source positions seal without an array or read-limit error",
		).resolves.toEqual({ _yay: null });
		const phases = new Set<string>();
		test_spy_handler(advance, async (handler, ctx, args) => {
			const run = (await ctx.db.get("files_transfer_runs", runId))!;
			const before = await ctx.meta.getTransactionMetrics();
			const result = await handler(ctx, args);
			const after = await ctx.meta.getTransactionMetrics();
			phases.add(run.step);
			expect(after.documentsRead.used - before.documentsRead.used, `${run.step} reads one page`).toBeLessThan(256);
			expect(after.bytesRead.used - before.bytesRead.used, `${run.step} bytes stay bounded`).toBeLessThan(128 * 1024);
			return result;
		});
		await expect(
			t.mutation(internal.files_transfer.advance, { runId }),
			"selection reads a page at 100000 positions",
		).resolves.toBeNull();
		await t.run(async (ctx) => {
			const run = (await ctx.db.get("files_transfer_runs", runId))!;
			expect(run.step).toBe("select");
			expect(run.selection!.cursor).toBeGreaterThanOrEqual(0);
			expect(run.selection!.cursor).toBeLessThan(count - 1);
			// Seek this phase fixture to its last duplicate. Full scheduler completion is tested above.
			await ctx.db.patch("files_transfer_runs", runId, { selection: { ...run.selection!, cursor: count - 2 } });
		});
		await t.mutation(internal.files_transfer.advance, { runId });
		expect(await t.run((ctx) => ctx.db.get("files_transfer_runs", runId))).toMatchObject({
			step: "normalize",
			selection: { cursor: -1 },
		});
		await expect(
			t.mutation(internal.files_transfer.advance, { runId }),
			"normalization reads a page at 100000 positions",
		).resolves.toBeNull();
		await t.run(async (ctx) => {
			const run = (await ctx.db.get("files_transfer_runs", runId))!;
			expect(run.step).toBe("normalize");
			expect(run.selection!.cursor).toBeGreaterThanOrEqual(0);
			expect(run.selection!.cursor).toBeLessThan(count - 1);
			await ctx.db.patch("files_transfer_runs", runId, { selection: { ...run.selection!, cursor: count - 2 } });
		});
		await t.mutation(internal.files_transfer.advance, { runId });
		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_transfer_runs", runId)).toMatchObject({
				step: "plan",
				selection: { expectedCount: count, count, cursor: count - 1 },
			});
			expect(await ctx.db.get("activities", activityId)).toMatchObject({
				progress: { discovered: 1, total: 1, completed: 0 },
			});
			expect(
				await ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_order", (q) => q.eq("runId", runId))
					.take(2),
			).toMatchObject([{ source: { kind: "saved", id: sourceId }, discoveryDone: true }]);
		});
		expect(phases).toEqual(new Set(["select", "normalize"]));
	}, 600_000);
});
