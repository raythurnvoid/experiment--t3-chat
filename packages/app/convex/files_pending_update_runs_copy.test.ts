import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Workpool } from "@convex-dev/workpool";
import { api, internal } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel.js";
import { files_pending_update_runs_db_delete_run_batch } from "./files_pending_update_runs.ts";
import {
	fixture,
	copied_folders,
	start_review,
	agent_copied_folders,
	pending_move,
	next_overlay_job,
	produce_plan_page,
	unit_for,
	plan_review,
	save_next,
	finish_review,
} from "./files_pending_update_runs_copy.setup.test.ts";

beforeEach(() => {
	vi.useFakeTimers();
	let workCount = 0;
	// These tests drive the real worker directly, without running the queue component.
	vi.spyOn(Workpool.prototype, "enqueueAction").mockImplementation(async () => `copy-save-${++workCount}` as never);
	vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined as never);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("scalable Copy Save", () => {
	test.each([false, true])(
		"blocks only the ordinary unit when it needs an unselected change made during planning (unselected: %s)",
		async (unselected) => {
			const f = await agent_copied_folders();
			const parent = await f.t.mutation(internal.files_nodes.create_folder_node_by_path, { ...f.scope, path: "/a" });
			if (parent._nay) throw new Error(parent._nay.message);
			const child = await f.t.mutation(internal.files_nodes.create_folder_node_by_path, {
				...f.scope,
				path: "/a/b",
			});
			if (child._nay) throw new Error(child._nay.message);
			const move = await pending_move({
				f,
				target: { kind: "saved", id: child._yay.nodeId },
				destParent: { kind: "root" },
				destName: "b-moved",
			});
			const { runId } = await start_review(f, [...f.copies, move]);
			expect(await produce_plan_page(f, runId)).toMatchObject({ producerPhase: "source_ancestors", itemCount: 4 });
			const parentMove = unselected
				? await pending_move({
						f,
						target: { kind: "saved", id: parent._yay.nodeId },
						destParent: { kind: "root" },
						destName: "a-moved",
					})
				: null;
			const planned = await plan_review(f, runId);
			expect(planned).toMatchObject({ step: "running", unitCount: 4 });
			expect(await unit_for(f, runId, move)).toMatchObject({
				itemCount: 1,
				errorCode: unselected ? "needs_review" : null,
				errorMessage: unselected ? "This action also affects an unselected change. Review them together." : null,
			});

			const result = await finish_review({ f, runId, count: 4 });
			expect(result?.activity).toMatchObject({
				status: unselected ? "partial" : "succeeded",
				progress: { completed: unselected ? 3 : 4, blocked: unselected ? 1 : 0, failed: 0 },
			});
			expect(result?.run.needsReviewIds).toEqual(parentMove ? [parentMove._id] : []);
			const receipts = await f.t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect());
			expect(receipts.map((receipt) => receipt.privateNodeId).sort()).toEqual(
				f.copies.map((copy) => copy.target.id).sort(),
			);
			expect((await f.t.run((ctx) => ctx.db.query("files_nodes").collect())).map((node) => node.path).sort()).toEqual(
				[
					"/a",
					unselected ? "/a/b" : "/b-moved",
					"/source",
					"/source-two",
					"/source-three",
					"/target",
					...f.copies.map((copy) => `/target${copy.copiedFrom!.path}`),
				].sort(),
			);
			// The unselected parent Move is never added to this Save.
			const pending = await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect());
			expect(pending.sort((a, b) => a._creationTime - b._creationTime)).toEqual(parentMove ? [move, parentMove] : []);
		},
	);

	test("keeps the blocked unselected change when planning later fails as a whole", async () => {
		const f = await agent_copied_folders();
		const parent = await f.t.mutation(internal.files_nodes.create_folder_node_by_path, { ...f.scope, path: "/a" });
		if (parent._nay) throw new Error(parent._nay.message);
		const child = await f.t.mutation(internal.files_nodes.create_folder_node_by_path, { ...f.scope, path: "/a/b" });
		if (child._nay) throw new Error(child._nay.message);
		const move = await pending_move({
			f,
			target: { kind: "saved", id: child._yay.nodeId },
			destParent: { kind: "root" },
			destName: "b-moved",
		});
		const { runId } = await start_review(f, [...f.copies, move]);
		const parentMove = await pending_move({
			f,
			target: { kind: "saved", id: parent._yay.nodeId },
			destParent: { kind: "root" },
			destName: "a-moved",
		});
		for (let pass = 0; pass < 100; pass++) {
			const job = await next_overlay_job(f);
			if (job) {
				await f.t.mutation(internal.files_pending_overlay.run_job, {
					kind: job.kind,
					key: job.key,
					nextAttemptAt: job.nextAttemptAt,
				});
				continue;
			}
			const produced = await f.t.mutation(internal.files_pending_update_plan_producer.advance, {
				runId,
				fence: 0,
				planEpoch: 0,
			});
			if (produced._nay) throw new Error(produced._nay.message);
			const blocked = await f.t.run((ctx) =>
				ctx.db
					.query("files_pending_update_plan_items")
					.withIndex("by_plan_target", (q) =>
						q.eq("planId", produced._yay.plan._id).eq("target.kind", move.target.kind).eq("target.id", move.target.id),
					)
					.unique(),
			);
			if (blocked?.errorCode === "needs_review") break;
			if (pass === 99) throw new Error("Expected the unselected parent to block planning");
		}

		// Lose every planning action. The third recovery fails the whole run.
		for (let attempt = 0; attempt < 3; attempt++) {
			vi.setSystemTime(Date.now() + 6 * 60 * 1000);
			await f.t.mutation(internal.files_pending_update_runs.recover, {});
		}
		const result = await f.asUser.query(api.files_pending_update_runs.get, { membershipId: f.db.membershipId, runId });
		expect(result?.activity).toMatchObject({ status: "failed", errorCode: "attempt_expired" });
		expect(result?.run.needsReviewIds).toEqual([parentMove._id]);
	});

	test("keeps a blocked unit across planner pages without blocking an unrelated Move", async () => {
		const f = await agent_copied_folders();
		const parent = await f.t.mutation(internal.files_nodes.create_folder_node_by_path, { ...f.scope, path: "/a" });
		if (parent._nay) throw new Error(parent._nay.message);
		const child = await f.t.mutation(internal.files_nodes.create_folder_node_by_path, { ...f.scope, path: "/a/b" });
		if (child._nay) throw new Error(child._nay.message);
		const move = await pending_move({
			f,
			target: { kind: "saved", id: child._yay.nodeId },
			destParent: { kind: "root" },
			destName: "b-moved",
		});
		const parentMove = await pending_move({
			f,
			target: { kind: "saved", id: parent._yay.nodeId },
			destParent: { kind: "root" },
			destName: "a-moved",
		});
		// More unrelated proposals than a planner page must not join the exact ancestor lookup.
		for (let index = 0; index < 260; index++) {
			const made = await f.t.mutation(internal.files_nodes.create_folder_node_by_path, {
				...f.scope,
				path: `/filler-${String(index).padStart(3, "0")}`,
			});
			if (made._nay) throw new Error(made._nay.message);
			const archived = await f.t.mutation(internal.files_pending_updates.upsert_file_pending_archive_in_db, {
				...f.scope,
				target: { kind: "saved", id: made._yay.nodeId },
			});
			if (archived._nay) throw new Error(archived._nay.message);
		}
		// This independent Move has its own connected unit.
		const rename = await pending_move({
			f,
			target: { kind: "saved", id: f.sourceId },
			destParent: { kind: "root" },
			destName: "ordinary-renamed",
		});
		const { runId } = await start_review(f, [...f.copies, move, rename]);
		const firstPage = await produce_plan_page(f, runId);
		expect(firstPage).toMatchObject({ producerPhase: "source_ancestors", itemCount: 5 });
		const planned = await plan_review(f, runId);
		expect(planned).toMatchObject({ step: "running", unitCount: 5, needsReviewIds: [parentMove._id] });
		expect(await unit_for(f, runId, move)).toMatchObject({ itemCount: 1, errorCode: "needs_review" });
		expect(await unit_for(f, runId, rename)).toMatchObject({ itemCount: 1, errorCode: null });

		const result = await finish_review({ f, runId, count: 5 });
		expect(result?.activity).toMatchObject({ status: "partial", progress: { completed: 4, blocked: 1, failed: 0 } });
		const receipts = await f.t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect());
		expect(receipts.map((receipt) => receipt.privateNodeId).sort()).toEqual(
			f.copies.map((copy) => copy.target.id).sort(),
		);
		const saved = (await f.t.run((ctx) => ctx.db.query("files_nodes").collect())).map((node) => node.path);
		expect(saved).toEqual(expect.arrayContaining(["/a/b", "/ordinary-renamed"]));
		expect(saved).not.toEqual(expect.arrayContaining(["/b-moved", "/source"]));
		for (const proposal of [move, parentMove])
			expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", proposal._id))).toEqual(proposal);
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", rename._id))).toBeNull();
	});

	test("saves the proposals produced by an agent Copy in separate parent-first units", async () => {
		const f = await fixture();
		const destination = await f.t.mutation(internal.files_nodes.create_folder_node_by_path, {
			...f.scope,
			path: "/target",
		});
		if (destination._nay) throw new Error(destination._nay.message);
		expect(
			(await f.t.mutation(internal.files_nodes.create_folder_node_by_path, { ...f.scope, path: "/source/child" }))._nay,
		).toBeUndefined();
		const thread = await f.asUser.mutation(api.ai_chat.thread_create, {
			membershipId: f.db.membershipId,
			clientGeneratedId: "copy-save",
			lastMessageAt: Date.now(),
		});
		if (thread._nay) throw new Error(thread._nay.message);
		const started = await f.t.mutation(internal.files_transfer.start_for_agent, {
			membershipId: f.db.membershipId,
			threadId: thread._yay.threadId,
			requestId: "copy-save",
			kind: "copy",
			sourceWorkspace: "current",
			destinationWorkspace: "current",
			expectedSourceCount: 1,
			sources: [{ kind: "saved", id: f.sourceId }],
			targetParent: { kind: "saved", id: destination._yay.nodeId },
			targetPath: "/target",
			targetName: null,
			missingParentNames: [],
			conflictPolicy: { file: "error", folder: "error" },
		});
		if (started._nay) throw new Error(started._nay.message);
		expect(
			await f.t.mutation(internal.files_transfer.seal_for_agent, {
				membershipId: f.db.membershipId,
				threadId: thread._yay.threadId,
				runId: started._yay.runId,
			}),
		).toEqual({ _yay: null });
		for (let step = 0; step < 60; step++) {
			await f.t.mutation(internal.files_transfer.advance, { runId: started._yay.runId });
			const activity = await f.t.run((ctx) => ctx.db.get("activities", started._yay.activityId));
			if (activity?.status === "succeeded") break;
			if (step === 59) throw new Error("Copy did not finish");
		}
		const proposals = await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect());
		expect(proposals).toHaveLength(2);
		expect(
			proposals.every((proposal) => proposal.copiedFrom !== undefined && proposal.createIntent?.kind === "folder"),
		).toBe(true);
		const { runId } = await start_review(f, proposals.toReversed());
		expect(await plan_review(f, runId)).toMatchObject({ step: "running", unitCount: 2 });
		expect((await finish_review({ f, runId, count: 2 }))?.activity).toMatchObject({
			status: "succeeded",
			progress: { completed: 2 },
		});
		expect((await f.t.run((ctx) => ctx.db.query("files_nodes").collect())).map((node) => node.path).sort()).toEqual([
			"/source",
			"/source/child",
			"/target",
			"/target/source",
			"/target/source/child",
		]);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect())).toHaveLength(2);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect())).toEqual([]);
	});

	test("keeps an ordinary child coupled to its copied parent, not to its copied sibling", async () => {
		const f = await fixture();
		const [parent] = await copied_folders({ f, count: 1 });
		if (!parent || parent.target.kind !== "private") throw new Error("Expected the copied parent");
		const [sibling] = await copied_folders({ f, count: 1, parent: parent.target });
		const created = await f.t.mutation(internal.files_nodes.create_private_node_by_path, {
			...f.scope,
			kind: "folder",
			path: "/copy-00000/ordinary",
		});
		if (created._nay || !created._yay.pendingUpdateId) throw new Error("Expected the ordinary child");
		const ordinary = await f.t.run((ctx) => ctx.db.get("files_pending_updates", created._yay.pendingUpdateId!));
		if (!ordinary) throw new Error("Expected the ordinary proposal");
		const { runId } = await start_review(f, [sibling!, ordinary, parent]);
		expect(await plan_review(f, runId)).toMatchObject({ step: "running", unitCount: 2 });
		const parentUnit = await unit_for(f, runId, parent);
		expect(parentUnit).toMatchObject({ kind: "cohort", itemCount: 2 });
		expect((await unit_for(f, runId, ordinary))._id).toBe(parentUnit._id);
		expect(await unit_for(f, runId, sibling!)).toMatchObject({ kind: "cohort", itemCount: 1, status: "waiting" });
		expect((await finish_review({ f, runId, count: 3 }))?.activity).toMatchObject({
			status: "succeeded",
			progress: { completed: 3 },
		});
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect())).toHaveLength(3);
	});

	test("a changed parent blocks only its child and leaves another Copy free to save", async () => {
		const f = await fixture();
		const [parent, independent] = await copied_folders({ f, count: 2 });
		if (!parent || parent.target.kind !== "private") throw new Error("Expected the copied parent");
		const [child] = await copied_folders({ f, count: 1, parent: parent.target });
		const { runId } = await start_review(f, [child!, parent, independent!]);
		await plan_review(f, runId);
		expect(
			(
				await f.t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
					...f.scope,
					target: parent.target,
					destParent: { kind: "root" },
					destName: "changed-parent",
				})
			)._nay,
		).toBeUndefined();
		expect((await finish_review({ f, runId, count: 3 }))?.activity).toMatchObject({
			status: "partial",
			progress: { completed: 1, blocked: 2 },
		});
		expect((await f.t.run((ctx) => ctx.db.query("files_nodes").collect())).map((node) => node.path).sort()).toEqual([
			"/copy-00001",
			"/source",
		]);
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", parent._id))).toMatchObject({
			revision: parent.revision + 1,
		});
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", child!._id))).toEqual(child);
		const items = await f.asUser.query(api.files_pending_update_runs.list_items, {
			membershipId: f.db.membershipId,
			runId,
			paginationOpts: { cursor: null, numItems: 100 },
		});
		expect(items.page.map((item) => item.status)).toEqual(["needs_review", "needs_review", "completed"]);
	});

	test("resumes the exact facts cursor after a lost planning action", async () => {
		const f = await fixture();
		// One more Copy than a plan page of 8, so the producer saves a cursor before the lost action.
		const copies = await copied_folders({ f, count: 9 });
		const { runId } = await start_review(f, copies);
		const graph = await produce_plan_page(f, runId);
		const before = await f.t.run((ctx) => ctx.db.get("files_pending_update_runs", runId));
		expect(graph).toMatchObject({ producerPhase: "facts", itemCount: 8 });
		expect(graph.producerCursor).not.toBeNull();
		vi.setSystemTime(Date.now() + 5 * 60 * 1000);
		await f.t.mutation(internal.files_pending_update_runs.recover, {});
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_update_runs", runId))).toMatchObject({
			fence: 1,
			graphPlanId: before!.graphPlanId,
		});
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_update_plans", graph._id))).toEqual(graph);
		expect(
			await f.t.mutation(internal.files_pending_update_plan_producer.advance, { runId, fence: 0, planEpoch: 0 }),
		).toMatchObject({ _nay: { name: "stopped" } });
		expect(await plan_review(f, runId)).toMatchObject({ unitCount: 9, plannedItemCount: 9 });
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_update_plans", graph._id))).toMatchObject({
			fence: 1,
			itemCount: 9,
			phase: "ready",
		});
		expect((await finish_review({ f, runId, count: 9, stepMs: 1_200 }))?.activity).toMatchObject({
			status: "succeeded",
			progress: { completed: 9 },
		});
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect())).toHaveLength(9);
	}, 300_000);

	test("extends the idle deadline on Save progress but still expires an idle remainder", async () => {
		const f = await fixture();
		const copies = await copied_folders({ f, count: 3 });
		const { runId } = await start_review(f, copies);
		await plan_review(f, runId);
		expect(await save_next(f, runId)).toBe(true);
		vi.setSystemTime(Date.now() + 29 * 60 * 1000);
		expect(await save_next(f, runId)).toBe(true);
		const active = await f.asUser.query(api.files_pending_update_runs.get, { membershipId: f.db.membershipId, runId });
		expect(active?.activity.deadlineAt).toBe(Date.now() + 30 * 60 * 1000);
		vi.setSystemTime(Date.now() + 31 * 60 * 1000);
		await f.t.mutation(internal.files_pending_update_runs.advance, { runId });
		const result = await f.asUser.query(api.files_pending_update_runs.get, { membershipId: f.db.membershipId, runId });
		expect(result?.activity).toMatchObject({ status: "timed_out", progress: { completed: 2, canceled: 1 } });
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect())).toHaveLength(2);
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", copies[2]!._id))).toEqual(copies[2]);
	});

	// Keep all 1,000 Copy outputs. Save and the test fork read indexed pages.
	// Run this large check with test:files:full-size.
	test(
		"saves 1,000 Copy outputs beside one ordinary edit",
		{ tags: ["full-size"], timeout: 0 },
		async () => {
			const f = await fixture();
			const copies = await copied_folders({ f, count: 1_000 });
			console.info("Copy Save scale ready proposals", copies.length);
			const moved = await f.t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
				...f.scope,
				target: { kind: "saved", id: f.sourceId },
				destParent: { kind: "root" },
				destName: "renamed-source",
			});
			if (moved._nay) throw new Error(moved._nay.message);
			const ordinary = await f.t.run((ctx) =>
				ctx.db
					.query("files_pending_updates")
					.withIndex("by_organization_workspace_user_target", (q) =>
						q
							.eq("organizationId", f.scope.organizationId)
							.eq("workspaceId", f.scope.workspaceId)
							.eq("userId", f.scope.userId)
							.eq("target.kind", "saved")
							.eq("target.id", f.sourceId),
					)
					.unique(),
			);
			if (!ordinary) throw new Error("Expected the ordinary rename");
			const { runId } = await start_review(f, [...copies, ordinary]);
			console.info("Copy Save scale sealed selection", copies.length + 1);
			expect(await plan_review(f, runId)).toMatchObject({
				step: "running",
				unitCount: 1_001,
				plannedItemCount: 1_001,
			});
			const startedAt = Date.now();
			// Each completed output takes 2 seconds, so the Save lasts over 30 minutes of app time.
			const result = await finish_review({ f, runId, count: 1_001, stepMs: 2_000 });
			expect(Date.now() - startedAt).toBeGreaterThan(30 * 60 * 1000);
			expect(result?.activity).toMatchObject({
				status: "succeeded",
				progress: { completed: 1_001, blocked: 0, failed: 0 },
			});
			let cursor: string | null = null;
			let published = 0;
			while (true) {
				const page = await f.t.run((ctx) =>
					ctx.db.query("files_pending_node_publish_receipts").paginate({ cursor, numItems: 100 }),
				);
				const savedNodes = await f.t.run((ctx) =>
					Promise.all(page.page.map((receipt) => ctx.db.get("files_nodes", receipt.savedNodeId))),
				);
				for (const [index, receipt] of page.page.entries()) {
					const saved = savedNodes[index];
					expect(saved).toMatchObject({ publishedFromPrivateNodeId: receipt.privateNodeId, archiveOperationId: null });
					published++;
				}
				if (page.isDone) break;
				cursor = page.continueCursor;
			}
			expect(published).toBe(1_000);
			expect(await f.t.run((ctx) => ctx.db.query("files_pending_updates").first())).toBeNull();
			expect(await f.t.run((ctx) => ctx.db.get("files_nodes", f.sourceId))).toMatchObject({ path: "/renamed-source" });
		},
	);

	test("starts a Save above the Discard limit", async () => {
		const f = await fixture();
		const [copy] = await copied_folders({ f, count: 1 });
		if (!copy) throw new Error("Expected the Copy proposal");
		const args = {
			membershipId: f.db.membershipId,
			expectedItemCount: 10_001,
			items: [{ pendingUpdateId: copy._id, reviewedRevision: copy.revision, selectedContentStateId: null }],
		};

		const saved = await f.asUser.mutation(api.files_pending_update_runs.start, {
			...args,
			requestId: "save",
			kind: "accept",
		});
		expect(saved._nay).toBeUndefined();

		const discarded = await f.asUser.mutation(api.files_pending_update_runs.start, {
			...args,
			requestId: "discard",
			kind: "discard",
		});
		expect(discarded._nay).toMatchObject({ name: "invalid_selection" });
	});

	test("saves a copied parent first and keeps unselected siblings pending", async () => {
		const f = await fixture();
		const [parent] = await copied_folders({ f, count: 1 });
		if (!parent || parent.target.kind !== "private") throw new Error("Expected the private parent");
		const [child, sibling] = await copied_folders({ f, count: 2, parent: parent.target });
		const { runId } = await start_review(f, [child!, parent]);
		expect(await plan_review(f, runId)).toMatchObject({ step: "running", unitCount: 2 });
		expect(await save_next(f, runId)).toBe(true);
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", parent._id))).toBeNull();
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", child!._id))).toEqual(child);
		expect((await finish_review({ f, runId, count: 2 }))?.activity).toMatchObject({
			status: "succeeded",
			progress: { completed: 2 },
		});
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", sibling!._id))).toEqual(sibling);
		const saved = await f.t.run((ctx) => ctx.db.query("files_nodes").collect());
		expect(saved.map((node) => node.path).sort()).toEqual(["/copy-00000", "/copy-00000/copy-00000", "/source"]);
	});

	test("Stop after one Copy keeps its saved node and the unsaved remainder", async () => {
		const f = await fixture();
		const copies = await copied_folders({ f, count: 3 });
		const { runId, activityId } = await start_review(f, copies);
		await plan_review(f, runId);
		expect(await save_next(f, runId)).toBe(true);
		expect(
			await f.asUser.mutation(api.activities.request_stop, { membershipId: f.db.membershipId, activityId }),
		).toEqual({ _yay: null });
		await f.t.mutation(internal.files_pending_update_runs.advance, { runId });
		const result = await f.asUser.query(api.files_pending_update_runs.get, { membershipId: f.db.membershipId, runId });
		expect(result?.activity).toMatchObject({ status: "canceled", progress: { completed: 1, canceled: 2 } });
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect())).toHaveLength(1);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect())).toEqual(copies.slice(1));
		expect((await f.t.run((ctx) => ctx.db.query("files_nodes").collect())).map((node) => node.path).sort()).toEqual([
			"/copy-00000",
			"/source",
		]);
	});

	test("settles parent prerequisites in pages and deletes history without deleting saved outputs", async () => {
		const f = await fixture();
		const [parent] = await copied_folders({ f, count: 1 });
		if (!parent || parent.target.kind !== "private") throw new Error("Expected the private parent");
		// One more child than a page of 8 edges, so the parent settles its children in two pages.
		const children = await copied_folders({ f, count: 9, parent: parent.target });
		const { runId, activityId } = await start_review(f, [...children, parent]);
		await plan_review(f, runId);
		expect(await save_next(f, runId)).toBe(true);
		const readEdges = async () =>
			await f.t.run((ctx) => ctx.db.query("files_pending_update_run_dependencies").collect());
		expect((await readEdges()).filter((edge) => edge.settled)).toHaveLength(0);
		await f.t.mutation(internal.files_pending_update_runs.advance, { runId });
		expect((await readEdges()).filter((edge) => edge.settled)).toHaveLength(8);
		await f.t.mutation(internal.files_pending_update_runs.advance, { runId });
		expect((await readEdges()).filter((edge) => edge.settled)).toHaveLength(9);
		expect((await finish_review({ f, runId, count: 10, stepMs: 1_200 }))?.activity).toMatchObject({
			status: "succeeded",
			progress: { completed: 10 },
		});
		expect((await readEdges()).filter((edge) => edge.settled)).toHaveLength(9);
		const units = await f.t.run((ctx) => ctx.db.query("files_pending_update_run_units").collect());
		expect(units.every((unit) => unit.remainingPrerequisiteCount === 0 && unit.dependentsSettled)).toBe(true);
		const saved = await f.t.run((ctx) => ctx.db.query("files_nodes").collect());
		const receipts = await f.t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect());
		expect(saved).toHaveLength(11);
		expect(receipts).toHaveLength(10);
		for (let page = 0; page < 1_000; page++) {
			const removed = await f.t.run((ctx) => files_pending_update_runs_db_delete_run_batch(ctx, { runId }));
			if (removed.done) break;
			if (page === 999) throw new Error("History cleanup did not finish");
		}
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_update_runs", runId))).toBeNull();
		expect(await f.t.run((ctx) => ctx.db.get("activities", activityId))).toBeNull();
		expect(await readEdges()).toEqual([]);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_update_run_units").collect())).toEqual([]);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_update_run_items").collect())).toEqual([]);
		expect(await f.t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(saved);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect())).toEqual(receipts);
	}, 7_200_000);

	test("holds exact appended selections and hands Stop remainder to one fixed review deadline", async () => {
		const f = await fixture();
		const copies = await copied_folders({ f, count: 2 });
		expect(copies.every((copy) => copy.expiresAt === copy.updatedAt + 4 * 60 * 60 * 1000)).toBe(true);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_update_expiry_checks").collect())).toHaveLength(1);
		const expire = () => f.t.mutation(internal.files_pending_updates.expire_file_pending_updates, f.scope);
		// Compare drafts without `expiresAt`, because the expiry job may move it later on a held draft.
		const withoutExpiry = (proposals: (Doc<"files_pending_updates"> | null)[]) =>
			proposals.map((proposal) => {
				if (!proposal) return null;
				const { expiresAt: _expiresAt, ...rest } = proposal;
				return rest;
			});
		vi.setSystemTime(Date.now() + (3 * 60 + 55) * 60 * 1000);
		const item = (proposal: Doc<"files_pending_updates">) => ({
			pendingUpdateId: proposal._id,
			reviewedRevision: proposal.revision,
			selectedContentStateId: null,
		});
		const started = await f.asUser.mutation(api.files_pending_update_runs.start, {
			membershipId: f.db.membershipId,
			requestId: "held-selection",
			kind: "accept",
			expectedItemCount: 2,
			items: [item(copies[0]!)],
		});
		if (started._nay) throw new Error(started._nay.message);
		const { runId, activityId } = started._yay;
		const page = { membershipId: f.db.membershipId, runId, offset: 1, items: [item(copies[1]!)] };
		expect(await f.asUser.mutation(api.files_pending_update_runs.append_items, page)).toEqual({ _yay: null });
		const holds = await f.t.run((ctx) => ctx.db.query("files_pending_holds").collect());
		expect(holds).toHaveLength(2);
		expect(holds.every((hold) => hold.role === "review" && hold.producer.id === runId)).toBe(true);
		expect(await f.asUser.mutation(api.files_pending_update_runs.append_items, page)).toEqual({ _yay: null });
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_holds").collect())).toEqual(holds);
		// Starting and appending the review does not move the drafts' expiry.
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect())).toEqual(copies);

		// The drafts are due, but the running review holds them. The job keeps them and tries again later.
		vi.setSystemTime(Date.now() + 6 * 60 * 1000);
		await expire();
		const held = await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect());
		expect(withoutExpiry(held)).toEqual(withoutExpiry(copies));
		expect(held.every((proposal) => proposal.expiresAt === Date.now() + 60_000)).toBe(true);
		expect(
			await f.asUser.mutation(api.activities.request_stop, { membershipId: f.db.membershipId, activityId }),
		).toEqual({ _yay: null });
		const run = await f.t.run((ctx) => ctx.db.get("files_pending_update_runs", runId));
		const activity = await f.t.run((ctx) => ctx.db.get("activities", activityId));
		expect(run?.outputReviewUntil).toBe(activity!.finishedAt! + 4 * 60 * 60 * 1000);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_holds").collect())).toHaveLength(2);

		// The review stopped, but its fixed review deadline still keeps the drafts.
		vi.setSystemTime(Date.now() + 60_000);
		await expire();
		expect(withoutExpiry([await f.t.run((ctx) => ctx.db.get("files_pending_updates", copies[0]!._id))])).toEqual(
			withoutExpiry([copies[0]!]),
		);
		await f.t.mutation(internal.files_pending_holds.release_producer, {
			producer: { kind: "files_pending_update_run", id: runId },
		});
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_holds").collect())).toEqual([]);
		const afterRelease = await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect());
		expect(afterRelease.every((proposal) => proposal.expiresAt === run!.outputReviewUntil)).toBe(true);
		await expire();
		expect(withoutExpiry(await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect()))).toEqual(
			withoutExpiry(copies),
		);
		expect(await f.t.run((ctx) => ctx.db.query("files_nodes").collect())).toHaveLength(1);
	});
});
