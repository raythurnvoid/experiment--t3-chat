import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { FunctionArgs } from "convex/server";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import {
	fixture as archive_fixture,
	archive,
	run_to_end,
	folder,
	read_node,
	seed_tree,
	step,
} from "./files_archive_runs.setup.test.ts";
import { files_trash_requests_db_delete_batch, files_trash_requests_db_get_summary } from "./files_trash_requests.ts";
import { files_archive_runs_db_delete_run_batch } from "./files_archive_runs.ts";
import { files_pending_list_db_get_summary } from "./files_pending_list.ts";
import { activities_db_finish } from "./activities_db.ts";
import { files_archive_operation_id_cutoff } from "../shared/files.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

async function fixture() {
	const f = await archive_fixture();
	const thread = await f.asOwner.mutation(api.ai_chat.thread_create, {
		membershipId: f.db.membershipId,
		clientGeneratedId: crypto.randomUUID(),
		lastMessageAt: Date.now(),
	});
	if (thread._nay) throw new Error(thread._nay.message);
	const captured = await f.t.mutation(internal.ai_chat_workspaces.capture, {
		userId: f.db.userId,
		membershipId: f.db.membershipId,
	});
	if (captured._nay) throw new Error(captured._nay.message);
	const common = {
		userId: f.db.userId,
		membershipId: f.db.membershipId,
		agentSource: { ...f.db, threadId: thread._yay.threadId, membershipLifetime: captured._yay.membershipLifetime },
	};
	return { ...f, common };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function propose(f: Fixture, request: FunctionArgs<typeof internal.files_trash_requests.propose>["request"]) {
	const proposed = await f.t.mutation(internal.files_trash_requests.propose, { ...f.common, request });
	if (proposed._nay) throw new Error(proposed._nay.message);
	return proposed._yay.requestId;
}

async function deleted_folder(f: Fixture, path: string) {
	const nodeId = await folder(f, path);
	expect(await archive(f, [nodeId])).toEqual({ _yay: null });
	return { nodeId, archiveOperationId: (await read_node(f, nodeId)).archiveOperationId! };
}

async function approve(
	f: Fixture,
	requestIds: Id<"files_trash_requests">[],
	afterReviewRunId: Id<"files_pending_update_runs"> | null = null,
) {
	const started = await f.asOwner.mutation(api.files_trash_requests.start, {
		membershipId: f.db.membershipId,
		requestId: crypto.randomUUID(),
		kind: "accept",
		expectedItemCount: requestIds.length,
		requestIds,
		afterReviewRunId,
	});
	if (started._nay) throw new Error(started._nay.message);
	expect(
		await f.asOwner.mutation(api.files_trash_requests.seal, {
			membershipId: f.db.membershipId,
			batchId: started._yay.batchId,
		}),
	).toEqual({ _yay: null });
	return started._yay.batchId;
}

async function finish(f: Fixture, batchId: Id<"files_trash_request_batches">) {
	for (let count = 0; count < 1000; count++) {
		await f.t.mutation(internal.files_trash_requests.advance, { batchId });
		const batch = await f.t.run((ctx) => ctx.db.get("files_trash_request_batches", batchId));
		if (!batch?.active) return;
		if (batch.currentRequestId) {
			const request = await f.t.run((ctx) => ctx.db.get("files_trash_requests", batch.currentRequestId!));
			if (request?.archiveRunId) await step(f, request.archiveRunId);
		}
	}
	throw new Error("Trash batch did not finish");
}

async function view(f: Fixture, requestId: Id<"files_trash_requests">) {
	return await f.asOwner.query(api.files_trash_requests.get_request, { membershipId: f.db.membershipId, requestId });
}

describe("Trash requests", () => {
	test("proposal and cancel change only requests; summaries and sources follow them", async () => {
		const f = await fixture();
		const item = await deleted_folder(f, "/docs");
		const before = await read_node(f, item.nodeId);
		const requestId = await propose(f, { kind: "restore", ...item });
		expect(await read_node(f, item.nodeId)).toEqual(before);
		expect(await view(f, requestId)).toMatchObject({ status: "waiting", path: "/docs", canAccept: true });
		const count = () =>
			f.t.run(async (ctx) =>
				files_trash_requests_db_get_summary({
					ctx,
					membership: (await ctx.db.get("organizations_workspaces_users", f.db.membershipId))!,
					listKey: "all",
				}),
			);
		expect(await count()).toEqual({ count: 1 });
		expect(
			await f.t.run(async (ctx) =>
				files_pending_list_db_get_summary({
					ctx,
					membership: (await ctx.db.get("organizations_workspaces_users", f.db.membershipId))!,
					listKey: "all",
				}),
			),
		).toEqual({ count: 1, truncated: false });
		expect(
			(
				await f.asOwner.query(api.files_trash_requests.list_sources, {
					membershipId: f.db.membershipId,
					paginationOpts: { numItems: 10, cursor: null },
				})
			).page,
		).toHaveLength(1);
		expect(await f.t.mutation(internal.files_trash_requests.cancel_for_agent, { ...f.common, requestId })).toEqual({
			_yay: null,
		});
		expect(await count()).toEqual({ count: 0 });
		expect(
			await f.t.run(async (ctx) =>
				files_pending_list_db_get_summary({
					ctx,
					membership: (await ctx.db.get("organizations_workspaces_users", f.db.membershipId))!,
					listKey: "all",
				}),
			),
		).toEqual({ count: 0, truncated: false });
		expect(await read_node(f, item.nodeId)).toEqual(before);
	});

	test("repeated approval starts one child and keeps its synchronous result until Dismiss", async () => {
		const f = await fixture();
		const item = await deleted_folder(f, "/docs");
		const requestId = await propose(f, { kind: "restore", ...item });
		const args = {
			membershipId: f.db.membershipId,
			requestId: crypto.randomUUID(),
			kind: "accept" as const,
			expectedItemCount: 1,
			requestIds: [requestId],
			afterReviewRunId: null,
		};
		const started = await f.asOwner.mutation(api.files_trash_requests.start, args);
		expect(await f.asOwner.mutation(api.files_trash_requests.start, args)).toEqual(started);
		const batchId = started._yay!.batchId;
		for (let index = 0; index < 2; index++)
			expect(
				await f.asOwner.mutation(api.files_trash_requests.seal, { membershipId: f.db.membershipId, batchId }),
			).toEqual({ _yay: null });
		await finish(f, batchId);
		await finish(f, batchId);
		expect((await read_node(f, item.nodeId)).archiveOperationId).toBeNull();
		expect(await view(f, requestId)).toMatchObject({
			status: "finished",
			outcome: { status: "succeeded" },
			canAccept: false,
			canDismiss: true,
		});
		const runs = await f.t.run((ctx) => ctx.db.query("files_archive_runs").collect());
		expect(runs.filter((run) => run.trashRequestId === requestId)).toHaveLength(1);
		expect(
			await f.asOwner.mutation(api.files_trash_requests.dismiss, { membershipId: f.db.membershipId, requestId }),
		).toEqual({ _yay: null });
		expect(await view(f, requestId)).toBeNull();
	});

	test("occupied folder name is a no-op and blocks later Empty while independent restores continue", async () => {
		const f = await fixture();
		const item = await deleted_folder(f, "/docs");
		const other = await deleted_folder(f, "/other");
		const restoreId = await propose(f, { kind: "restore", ...item });
		const otherId = await propose(f, { kind: "restore", ...other });
		const emptyId = await propose(f, { kind: "empty", area: null });
		const replacement = await folder(f, "/docs");
		vi.setSystemTime(Date.now() + 1000);
		await finish(f, await approve(f, [emptyId, restoreId, otherId]));
		expect((await read_node(f, item.nodeId)).archiveOperationId).toBe(item.archiveOperationId);
		expect((await read_node(f, replacement)).archiveOperationId).toBeNull();
		expect((await read_node(f, other.nodeId)).archiveOperationId).toBeNull();
		expect(await view(f, restoreId)).toMatchObject({ outcome: { status: "noop" } });
		expect(await view(f, emptyId)).toMatchObject({ outcome: { status: "blocked" } });
	});

	test("a restore queued behind purge does not allow later Empty when its source disappears", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "purging", folderCount: 2, filesPerFolder: 55 });
		await run_to_end(f, (await archive(f, [tree.topId]))._yay!);
		const kept = await deleted_folder(f, "/keep");
		const restoreId = await propose(f, {
			kind: "restore",
			nodeId: tree.topId,
			archiveOperationId: (await read_node(f, tree.topId)).archiveOperationId!,
		});
		const emptyId = await propose(f, { kind: "empty", area: null });
		const purged = await f.asOwner.mutation(api.files_nodes.purge_nodes, {
			membershipId: f.db.membershipId,
			nodeIds: [tree.topId],
		});
		if (purged._nay || !purged._yay.runId) throw new Error("Expected a purge job");
		expect((await f.t.run((ctx) => ctx.db.get("files_archive_runs", purged._yay!.runId!)))?.active).toBe(true);
		vi.setSystemTime(Date.now() + 1000);
		const batchId = await approve(f, [restoreId, emptyId]);
		await f.t.mutation(internal.files_trash_requests.advance, { batchId });
		expect(await view(f, restoreId)).toMatchObject({ status: "running" });
		for (let pass = 0; pass < 100; pass++) if (!(await step(f, purged._yay.runId))?.active) break;
		expect(await read_node(f, tree.topId)).toBeNull();
		await finish(f, batchId);
		expect(await view(f, restoreId), "a restore that changed nothing is a no-op").toMatchObject({
			outcome: { status: "noop" },
		});
		expect(await view(f, emptyId)).toMatchObject({ outcome: { status: "blocked" } });
		expect(await read_node(f, kept.nodeId)).not.toBeNull();
	});

	test("a pinned request never acts on a later delete", async () => {
		const f = await fixture();
		const item = await deleted_folder(f, "/docs");
		const requestId = await propose(f, { kind: "purge", ...item });
		await f.asOwner.mutation(api.files_nodes.unarchive_nodes, {
			membershipId: f.db.membershipId,
			nodeIds: [item.nodeId],
		});
		vi.setSystemTime(Date.now() + 1000);
		expect(await archive(f, [item.nodeId])).toEqual({ _yay: null });
		const newer = (await read_node(f, item.nodeId)).archiveOperationId;
		expect(newer).not.toBe(item.archiveOperationId);
		await finish(f, await approve(f, [requestId]));
		expect(await f.t.run((ctx) => ctx.db.get("files_nodes", item.nodeId))).toMatchObject({ archiveOperationId: newer });
		expect(await view(f, requestId)).toMatchObject({ outcome: { status: "noop" } });
	});

	test("Empty freezes its cutoff at approval and excludes later deletes", async () => {
		const f = await fixture();
		const old = await deleted_folder(f, "/old");
		const requestId = await propose(f, { kind: "empty", area: null });
		vi.setSystemTime(Date.now() + 1000);
		const approvedAt = Date.now();
		const batchId = await approve(f, [requestId]);
		vi.setSystemTime(Date.now() + 1000);
		const newer = await deleted_folder(f, "/new");
		await finish(f, batchId);
		expect(await f.t.run((ctx) => ctx.db.get("files_nodes", old.nodeId))).toBeNull();
		expect(await f.t.run((ctx) => ctx.db.get("files_nodes", newer.nodeId))).not.toBeNull();
		const result = (await view(f, requestId))!;
		expect((await f.t.run((ctx) => ctx.db.get("files_archive_runs", result.archiveRunId!)))?.emptyArchive?.cutoff).toBe(
			files_archive_operation_id_cutoff(approvedAt),
		);
	});

	test("paged intake is idempotent, refuses incomplete Seal, and does not include newer requests", async () => {
		const f = await fixture();
		const item = await deleted_folder(f, "/docs");
		const first = await propose(f, { kind: "restore", ...item });
		const second = await propose(f, { kind: "purge", ...item });
		const started = await f.asOwner.mutation(api.files_trash_requests.start, {
			membershipId: f.db.membershipId,
			requestId: crypto.randomUUID(),
			kind: "accept",
			expectedItemCount: 2,
			requestIds: [first],
			afterReviewRunId: null,
		});
		const batchId = started._yay!.batchId;
		expect(
			(await f.asOwner.mutation(api.files_trash_requests.seal, { membershipId: f.db.membershipId, batchId }))._nay,
		).toBeDefined();
		const page = { membershipId: f.db.membershipId, batchId, offset: 1, requestIds: [second] };
		expect(await f.asOwner.mutation(api.files_trash_requests.append_items, page)).toEqual({ _yay: null });
		expect(await f.asOwner.mutation(api.files_trash_requests.append_items, page)).toEqual({ _yay: null });
		const newer = await propose(f, { kind: "empty", area: null });
		expect(
			await f.asOwner.mutation(api.files_trash_requests.seal, { membershipId: f.db.membershipId, batchId }),
		).toEqual({ _yay: null });
		await finish(f, batchId);
		expect(await view(f, newer)).toMatchObject({ status: "waiting" });
		expect(await view(f, second)).toMatchObject({ outcome: { status: "noop" } });
	});

	test("requests of one kind run in creation order even when selected in reverse", async () => {
		const f = await fixture();
		const item = await deleted_folder(f, "/ordered");
		const older = await propose(f, { kind: "restore", ...item });
		const newer = await propose(f, { kind: "restore", ...item });
		await finish(f, await approve(f, [newer, older]));
		expect(await view(f, older)).toMatchObject({ outcome: { status: "succeeded" } });
		expect(await view(f, newer)).toMatchObject({ outcome: { status: "noop" } });
	});

	test("canceling a queued restore keeps the running child linked and blocks deletion", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "big", folderCount: 2, filesPerFolder: 20 });
		const archived = await archive(f, [tree.topId]);
		await run_to_end(f, archived._yay!);
		const item = { nodeId: tree.topId, archiveOperationId: (await read_node(f, tree.topId)).archiveOperationId! };
		const first = await propose(f, { kind: "restore", ...item });
		const canceled = await propose(f, { kind: "restore", ...item });
		const empty = await propose(f, { kind: "empty", area: null });
		const batchId = await approve(f, [first, canceled, empty]);
		await f.t.mutation(internal.files_trash_requests.advance, { batchId });
		expect(await view(f, first)).toMatchObject({ status: "running" });
		expect(
			await f.t.mutation(internal.files_trash_requests.cancel_for_agent, { ...f.common, requestId: canceled }),
		).toEqual({ _yay: null });
		expect((await f.t.run((ctx) => ctx.db.get("files_trash_request_batches", batchId)))?.currentRequestId).toBe(first);
		await finish(f, batchId);
		expect(await view(f, first)).toMatchObject({ outcome: { status: "succeeded" } });
		expect(await view(f, empty)).toMatchObject({ outcome: { status: "blocked" } });
	});

	test("loss of membership after approval blocks all new work", async () => {
		const f = await fixture();
		const item = await deleted_folder(f, "/docs");
		const requestId = await propose(f, { kind: "purge", ...item });
		const batchId = await approve(f, [requestId]);
		await f.t.run((ctx) => ctx.db.patch("organizations_workspaces_users", f.db.membershipId, { active: false }));
		await finish(f, batchId);
		expect(await f.t.run((ctx) => ctx.db.get("files_nodes", item.nodeId))).not.toBeNull();
		expect(await f.t.run((ctx) => ctx.db.get("files_trash_requests", requestId))).toMatchObject({
			status: "finished",
			outcome: { status: "blocked" },
		});
	});

	test("a delayed Empty retains late archive completion proof through history cleanup", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "late", folderCount: 2, filesPerFolder: 10 });
		const archived = await archive(f, [tree.topId]);
		expect(archived._yay).not.toBeNull();
		const requestId = await propose(f, { kind: "empty", area: null });
		vi.setSystemTime(Date.now() + 1000);
		const batchId = await approve(f, [requestId]);
		vi.setSystemTime(Date.now() + 1000);
		for (let pass = 0; pass < 100; pass++) if (!(await step(f, archived._yay!.runId))?.active) break;
		vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60 * 1000);
		expect(
			await f.t.run((ctx) => files_archive_runs_db_delete_run_batch(ctx, { runId: archived._yay!.runId })),
		).toEqual({ done: false, deletedCount: 0 });
		expect(await f.t.run((ctx) => ctx.db.get("activities", archived._yay!.activityId))).not.toBeNull();
		await finish(f, batchId);
		expect(await f.t.run((ctx) => ctx.db.get("files_nodes", tree.topId))).not.toBeNull();
		expect(await view(f, requestId)).toMatchObject({ outcome: { status: "succeeded" } });
	});

	test("ordinary review is awaited by Activity status and a failed review blocks deletion", async () => {
		const f = await fixture();
		const item = await deleted_folder(f, "/docs");
		const draft = await f.t.mutation(internal.files_nodes.create_private_node_by_path, {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			userId: f.db.userId,
			path: "/new",
			kind: "folder",
		});
		if (draft._nay) throw new Error(draft._nay.message);
		const proposal = (await f.t.run((ctx) => ctx.db.get("files_pending_updates", draft._yay.pendingUpdateId!)))!;
		const review = await f.asOwner.mutation(api.files_pending_update_runs.start, {
			membershipId: f.db.membershipId,
			requestId: crypto.randomUUID(),
			kind: "accept",
			expectedItemCount: 1,
			items: [{ pendingUpdateId: proposal._id, reviewedRevision: proposal.revision, selectedContentStateId: null }],
		});
		if (review._nay) throw new Error(review._nay.message);
		const requestId = await propose(f, { kind: "purge", ...item });
		const batchId = await approve(f, [requestId], review._yay.runId);
		await f.t.mutation(internal.files_trash_requests.advance, { batchId });
		expect(await view(f, requestId)).toMatchObject({ status: "queued" });
		await f.t.run(async (ctx) => {
			await ctx.db.patch("files_pending_update_runs", review._yay.runId, { step: "finished" });
			await ctx.db.patch("activities", review._yay.activityId, { status: "stopping" });
		});
		await f.t.mutation(internal.files_trash_requests.advance, { batchId });
		expect(await view(f, requestId)).toMatchObject({ status: "queued" });
		await f.t.run((ctx) =>
			activities_db_finish(ctx, {
				sourceId: review._yay.runId,
				status: "partial",
				errorMessage: "One draft failed",
				now: Date.now(),
			}),
		);
		await finish(f, batchId);
		expect(await view(f, requestId)).toMatchObject({ outcome: { status: "blocked" } });
		expect(await f.t.run((ctx) => ctx.db.get("files_nodes", item.nodeId))).not.toBeNull();
	});

	test("account cleanup removes requests, batches, and exact summaries without changing Trash", async () => {
		const f = await fixture();
		const item = await deleted_folder(f, "/docs");
		const requestId = await propose(f, { kind: "restore", ...item });
		await approve(f, [requestId]);
		for (let pass = 0; pass < 10; pass++)
			if ((await f.t.run((ctx) => files_trash_requests_db_delete_batch(ctx, { userId: f.db.userId }))).done) break;
		expect(await f.t.run((ctx) => ctx.db.query("files_trash_requests").collect())).toEqual([]);
		expect(await f.t.run((ctx) => ctx.db.query("files_trash_request_batches").collect())).toEqual([]);
		expect(await f.t.run((ctx) => ctx.db.query("files_trash_request_summaries").collect())).toEqual([]);
		expect((await read_node(f, item.nodeId)).archiveOperationId).toBe(item.archiveOperationId);
	});

	test("Stop waits for restore repair, keeps completed work, and blocks later deletion", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "stop", folderCount: 3, filesPerFolder: 20 });
		const archived = await archive(f, [tree.topId]);
		await run_to_end(f, archived._yay!);
		const requestId = await propose(f, {
			kind: "restore",
			nodeId: tree.topId,
			archiveOperationId: (await read_node(f, tree.topId)).archiveOperationId!,
		});
		const empty = await propose(f, { kind: "empty", area: null });
		const batchId = await approve(f, [requestId, empty]);
		await f.t.mutation(internal.files_trash_requests.advance, { batchId });
		const runId = (await view(f, requestId))!.archiveRunId!;
		for (let pass = 0; pass < 100; pass++) {
			const run = await step(f, runId);
			if (run?.phase === "apply" && (await read_node(f, tree.topId)).archiveOperationId === null) break;
		}
		expect(await view(f, requestId)).toMatchObject({ status: "running" });
		expect(
			await f.asOwner.mutation(api.files_trash_requests.stop, { membershipId: f.db.membershipId, requestId }),
		).toEqual({ _yay: null });
		await finish(f, batchId);
		expect(await view(f, requestId)).toMatchObject({ status: "finished", outcome: { status: "partial" } });
		expect((await read_node(f, tree.topId)).archiveOperationId).toBeNull();
		expect(await view(f, empty)).toMatchObject({ outcome: { status: "blocked" } });
	});

	test("an active restore is reported as busy even after its root becomes live", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "busy", folderCount: 3, filesPerFolder: 20 });
		const archived = await archive(f, [tree.topId]);
		await run_to_end(f, archived._yay!);
		const requestId = await propose(f, {
			kind: "restore",
			nodeId: tree.topId,
			archiveOperationId: (await read_node(f, tree.topId)).archiveOperationId!,
		});
		const restoring = await f.asOwner.mutation(api.files_nodes.unarchive_nodes, {
			membershipId: f.db.membershipId,
			nodeIds: [tree.topId],
		});
		if (restoring._nay || !restoring._yay) throw new Error("Expected a restore job");
		const activity = await f.t.run((ctx) =>
			ctx.db
				.query("files_archive_runs")
				.withIndex("by_organization_workspace", (q) =>
					q.eq("organizationId", f.db.organizationId).eq("workspaceId", f.db.workspaceId),
				)
				.filter((q) => q.eq(q.field("kind"), "restore"))
				.first(),
		);
		for (let pass = 0; pass < 100; pass++) {
			await step(f, activity!._id);
			if ((await read_node(f, tree.topId)).archiveOperationId === null) break;
		}
		await finish(f, await approve(f, [requestId]));
		expect(await view(f, requestId)).toMatchObject({
			outcome: { status: "blocked", message: expect.stringContaining("running job") },
		});
	});

	test("current access masks stored result details and another owner cannot cancel a request", async () => {
		const f = await fixture();
		const item = await deleted_folder(f, "/private-name");
		const requestId = await propose(f, { kind: "restore", ...item });
		await folder(f, "/private-name");
		await finish(f, await approve(f, [requestId]));
		expect((await view(f, requestId))?.outcome?.message).toContain("private-name");
		await f.t.run(async (ctx) => {
			const newOwner = await ctx.db.insert("users", { clerkUserId: "new-owner" });
			await ctx.db.patch("organizations", f.db.organizationId, { ownerUserId: newOwner });
			const assignments = await ctx.db
				.query("access_control_role_assignments")
				.withIndex("by_user_organization_workspace", (q) => q.eq("userId", f.db.userId))
				.collect();
			for (const assignment of assignments) await ctx.db.delete("access_control_role_assignments", assignment._id);
		});
		expect(await view(f, requestId)).toMatchObject({
			path: null,
			locked: true,
			outcome: { message: "Permission denied. Ask for access to see this result." },
		});
		const otherUserId = await f.t.run((ctx) => ctx.db.insert("users", { clerkUserId: "unrelated-request-viewer" }));
		// An unrelated user has no authority in this database, even with the right request ID.
		expect(
			(
				await f.t
					.withIdentity({ issuer: "https://clerk.test", external_id: otherUserId })
					.mutation(api.files_trash_requests.discard, { membershipId: f.db.membershipId, requestId })
			)._nay,
		).toBeDefined();
		expect(await f.t.run((ctx) => ctx.db.get("files_trash_requests", requestId))).not.toBeNull();
	});

	test("lost wake recovery resumes approved work and abandoned intake releases only its claims", async () => {
		const f = await fixture();
		const item = await deleted_folder(f, "/docs");
		const requestId = await propose(f, { kind: "restore", ...item });
		const startArgs = {
			membershipId: f.db.membershipId,
			requestId: crypto.randomUUID(),
			kind: "accept" as const,
			expectedItemCount: 2,
			requestIds: [requestId],
			afterReviewRunId: null,
		};
		const started = await f.asOwner.mutation(api.files_trash_requests.start, startArgs);
		vi.setSystemTime(Date.now() + 6 * 60 * 1000);
		await f.t.mutation(internal.files_trash_requests.recover, {});
		await finish(f, started._yay!.batchId);
		expect(await view(f, requestId)).toMatchObject({ status: "waiting", canAccept: true });
		expect
			.soft(
				(await f.asOwner.mutation(api.files_trash_requests.start, startArgs))._nay,
				"a recovered intake cannot replay as a successful approval",
			)
			.toBeDefined();
		expect
			.soft(
				(
					await f.asOwner.mutation(api.files_trash_requests.seal, {
						membershipId: f.db.membershipId,
						batchId: started._yay!.batchId,
					})
				)._nay,
				"an unapproved finished batch cannot be sealed",
			)
			.toBeDefined();
		const batchId = await approve(f, [requestId]);
		vi.setSystemTime(Date.now() + 6 * 60 * 1000);
		await f.t.mutation(internal.files_trash_requests.recover, {});
		await finish(f, batchId);
		expect(await view(f, requestId)).toMatchObject({ outcome: { status: "succeeded" } });
	});

	test("idle expiry follows owner activity and never expires an approved queued request", async () => {
		const f = await fixture();
		const item = await deleted_folder(f, "/docs");
		const waiting = await propose(f, { kind: "restore", ...item });
		const queued = await propose(f, { kind: "purge", ...item });
		await approve(f, [queued]);
		vi.setSystemTime(Date.now() + 5 * 60 * 60 * 1000);
		await f.t.run(async (ctx) => {
			const activity = await ctx.db
				.query("users_last_active")
				.withIndex("by_user", (q) => q.eq("userId", f.db.userId))
				.first();
			if (activity) await ctx.db.patch("users_last_active", activity._id, { lastActiveAt: Date.now() });
			else await ctx.db.insert("users_last_active", { userId: f.db.userId, lastActiveAt: Date.now() });
		});
		await f.t.mutation(internal.files_trash_requests.recover, {});
		expect(await view(f, waiting)).not.toBeNull();
		vi.setSystemTime(Date.now() + 5 * 60 * 60 * 1000);
		await f.t.mutation(internal.files_trash_requests.recover, {});
		expect(await view(f, waiting)).toBeNull();
		expect(await view(f, queued)).toMatchObject({ status: "queued" });
	});
});
