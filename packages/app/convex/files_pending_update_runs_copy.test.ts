import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Workpool } from "@convex-dev/workpool";
import type { FunctionArgs } from "convex/server";
import { api, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { files_pending_nodes_db_create } from "./files_pending_nodes.ts";
import { files_pending_update_runs_db_delete_run_batch } from "./files_pending_update_runs.ts";
import { files_db_patch_pending_update, files_db_schedule_pending_update_cleanup } from "../server/files.ts";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";

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

async function fixture() {
	const t = test_convex({ transactionLimits: true });
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId };
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const source = await t.mutation(internal.files_nodes.create_folder_node_by_path, { ...scope, path: "/source" });
	if (source._nay) throw new Error(source._nay.message);
	return { t, db, scope, asUser, sourceId: source._yay.nodeId };
}

async function copied_folders(
	f: Awaited<ReturnType<typeof fixture>>,
	count: number,
	parent: Doc<"files_pending_nodes">["parent"] = { kind: "root" },
): Promise<Doc<"files_pending_updates">[]> {
	if (count > 100) {
		const [first] = await copied_folders(f, 1, parent);
		if (!first || first.target.kind !== "private") throw new Error("Expected a copied folder template");
		const privateId = first.target.id;
		const template = await f.t.run(async (ctx) => {
			const node = await ctx.db.get("files_pending_nodes", privateId);
			const reservation = await ctx.db
				.query("files_private_storage_reservations")
				.withIndex("by_resource", (q) => q.eq("resource.kind", "node").eq("resource.id", privateId))
				.unique();
			if (!node || !reservation) throw new Error("Expected the real folder reservation");
			const { _id: _nodeId, _creationTime: _nodeTime, ...nodeFields } = node;
			const { _id: _reservationId, _creationTime: _reservationTime, ...reservationFields } = reservation;
			return { nodeFields, reservationFields };
		});
		const { _id: _proposalId, _creationTime: _proposalTime, ...proposalFields } = first;
		const proposals = [first];
		// Clone the real producer shape in bounded writes; keep the same quota accounting.
		for (let offset = 1; offset < count; offset += 100) {
			proposals.push(
				...(await f.t.run(async (ctx) => {
					const page = [];
					for (let index = offset; index < Math.min(offset + 100, count); index++) {
						const id = await ctx.db.insert("files_pending_nodes", {
							...template.nodeFields,
							name: `copy-${String(index).padStart(5, "0")}`,
						});
						const pendingUpdateId = await ctx.db.insert("files_pending_updates", {
							...proposalFields,
							target: { kind: "private", id },
						});
						await ctx.db.insert("files_private_storage_reservations", {
							...template.reservationFields,
							resource: { kind: "node", id },
						});
						const proposal = (await ctx.db.get("files_pending_updates", pendingUpdateId))!;
						await files_db_schedule_pending_update_cleanup(ctx, {
							pendingUpdateId,
							expectedUpdatedAt: proposal.updatedAt,
						});
						page.push(proposal);
					}
					const quota = await ctx.db.get("quotas", template.reservationFields.userQuotaId);
					if (!quota) throw new Error("Expected the node quota");
					await ctx.db.patch("quotas", quota._id, { usedCount: quota.usedCount + page.length });
					return page;
				})),
			);
		}
		return proposals;
	}
	const proposals: Doc<"files_pending_updates">[] = [];
	// Match the transfer's folder publication, including the private storage reservation.
	for (let offset = 0; offset < count; offset += 32) {
		proposals.push(
			...(await f.t.run(async (ctx) => {
				const page = [];
				for (let index = offset; index < Math.min(offset + 32, count); index++) {
					const created = await files_pending_nodes_db_create(ctx, {
						...f.scope,
						parent,
						name: `copy-${String(index).padStart(5, "0")}`,
						kind: "folder",
					});
					if (created._nay) throw new Error(created._nay.message);
					await files_db_patch_pending_update(ctx, created._yay.pendingUpdateId, {
						createIntent: { kind: "folder", metadata: [] },
						copiedFrom: { target: { kind: "saved", id: f.sourceId }, path: "/source", sourceWritePolicy: null },
					});
					const proposal = await ctx.db.get("files_pending_updates", created._yay.pendingUpdateId);
					if (!proposal) throw new Error("Expected the copied proposal");
					await files_db_schedule_pending_update_cleanup(ctx, {
						pendingUpdateId: proposal._id,
						expectedUpdatedAt: proposal.updatedAt,
					});
					page.push(proposal);
				}
				return page;
			})),
		);
	}
	return proposals;
}

async function start_review(f: Awaited<ReturnType<typeof fixture>>, proposals: Doc<"files_pending_updates">[]) {
	const items = proposals.map((proposal) => ({
		pendingUpdateId: proposal._id,
		reviewedRevision: proposal.revision,
		selectedContentStateId: proposal.content?.unstagedStateId ?? null,
	}));
	const started = await f.asUser.mutation(api.files_pending_update_runs.start, {
		membershipId: f.db.membershipId,
		requestId: crypto.randomUUID(),
		kind: "accept",
		expectedItemCount: items.length,
		items: items.slice(0, 100),
	});
	expect(started._nay).toBeUndefined();
	if (started._nay) throw new Error(started._nay.message);
	const args = { membershipId: f.db.membershipId, runId: started._yay.runId };
	for (let offset = 100; offset < items.length; offset += 100)
		expect(
			await f.asUser.mutation(api.files_pending_update_runs.append_items, {
				...args,
				offset,
				items: items.slice(offset, offset + 100),
			}),
		).toEqual({ _yay: null });
	expect(await f.asUser.mutation(api.files_pending_update_runs.seal, args)).toEqual({ _yay: null });
	return started._yay;
}

async function agent_copied_folders() {
	const f = await fixture();
	const sources = [f.sourceId];
	for (const path of ["/source-two", "/source-three"]) {
		const made = await f.t.mutation(internal.files_nodes.create_folder_node_by_path, { ...f.scope, path });
		if (made._nay) throw new Error(made._nay.message);
		sources.push(made._yay.nodeId);
	}
	const target = await f.t.mutation(internal.files_nodes.create_folder_node_by_path, { ...f.scope, path: "/target" });
	if (target._nay) throw new Error(target._nay.message);
	const thread = await f.asUser.mutation(api.ai_chat.thread_create, {
		membershipId: f.db.membershipId,
		clientGeneratedId: "review-isolation",
		lastMessageAt: Date.now(),
	});
	if (thread._nay) throw new Error(thread._nay.message);
	const copy = await f.t.mutation(internal.files_transfer.start_for_agent, {
		membershipId: f.db.membershipId,
		threadId: thread._yay.threadId,
		requestId: "review-isolation",
		kind: "copy",
		sourceWorkspace: "current",
		destinationWorkspace: "current",
		expectedSourceCount: sources.length,
		sources: sources.map((id) => ({ kind: "saved" as const, id })),
		targetParent: { kind: "saved", id: target._yay.nodeId },
		targetPath: "/target",
		targetName: null,
		missingParentNames: [],
		conflictPolicy: { file: "error", folder: "error" },
	});
	if (copy._nay) throw new Error(copy._nay.message);
	expect(
		await f.t.mutation(internal.files_transfer.seal_for_agent, {
			membershipId: f.db.membershipId,
			threadId: thread._yay.threadId,
			runId: copy._yay.runId,
		}),
	).toEqual({ _yay: null });
	for (let pass = 0; pass < 60; pass++) {
		await f.t.mutation(internal.files_transfer.advance, { runId: copy._yay.runId });
		const activity = await f.t.run((ctx) => ctx.db.get("activities", copy._yay.activityId));
		if (activity?.status === "succeeded") break;
		if (pass === 59) throw new Error("Copy did not finish");
	}
	const copies = await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect());
	expect(copies).toHaveLength(3);
	expect(copies.every((proposal) => proposal.copiedFrom && proposal.createIntent?.kind === "folder")).toBe(true);
	return { ...f, copies, targetId: target._yay.nodeId };
}

async function pending_move(
	f: Awaited<ReturnType<typeof fixture>>,
	target: Doc<"files_pending_updates">["target"],
	destParent: FunctionArgs<typeof internal.files_pending_updates.upsert_file_pending_move_in_db>["destParent"],
	destName: string,
) {
	const moved = await f.t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
		...f.scope,
		target,
		destParent,
		destName,
	});
	if (moved._nay) throw new Error(moved._nay.message);
	const proposal = await f.t.run(async (ctx) =>
		(await ctx.db.query("files_pending_updates").collect()).find((row) => row.target.id === target.id),
	);
	if (!proposal) throw new Error("Expected the pending move");
	return proposal;
}

async function review_clock(f: Awaited<ReturnType<typeof fixture>>) {
	return (await f.t.run((ctx) => ctx.db.query("files_pending_review_versions").first()))?.revision ?? 0;
}

async function plan_review(f: Awaited<ReturnType<typeof fixture>>, runId: Id<"files_pending_update_runs">) {
	for (let pass = 0; pass < 3_000; pass++) {
		const run = await f.t.run((ctx) => ctx.db.get("files_pending_update_runs", runId));
		if (!run) throw new Error("Expected the review run");
		if (run.step !== "planning") return run;
		if (!run.plan) throw new Error("Expected the review plan");
		if (run.expectedItemCount > 1_000 && pass % 100 === 0)
			console.info("Copy Save scale plan", { phase: run.plan.phase, unitCount: run.unitCount, pass });
		await f.t.action(internal.files_pending_update_runs.plan, { runId, fence: run.fence });
	}
	throw new Error("Planning did not finish");
}

async function save_next(f: Awaited<ReturnType<typeof fixture>>, runId: Id<"files_pending_update_runs">) {
	for (let pass = 0; pass < 300; pass++) {
		await f.t.mutation(internal.files_pending_update_runs.advance, { runId });
		const run = await f.t.run((ctx) => ctx.db.get("files_pending_update_runs", runId));
		if (!run) throw new Error("Expected the review run");
		if (run.step === "finished") return false;
		const unit = await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_update_run_units")
				.withIndex("by_run_status_deleteLast_order", (q) => q.eq("runId", runId).eq("status", "preparing"))
				.first(),
		);
		if (!unit) continue;
		await f.t.action(internal.files_pending_update_runs.prepare_unit, {
			runId,
			fence: run.fence,
			unitId: unit._id,
			attemptFence: unit.attemptFence,
		});
		return true;
	}
	throw new Error("No review unit became ready");
}

async function finish_review(
	f: Awaited<ReturnType<typeof fixture>>,
	runId: Id<"files_pending_update_runs">,
	count: number,
	stepMs = 0,
) {
	for (let pass = 0; pass <= count + 5; pass++) {
		if (count > 1_000 && pass % 1_000 === 0) console.info("Copy Save scale worker", { pass, count });
		if (stepMs) vi.setSystemTime(Date.now() + stepMs);
		if (!(await save_next(f, runId)))
			return await f.asUser.query(api.files_pending_update_runs.get, { membershipId: f.db.membershipId, runId });
	}
	throw new Error("Review did not finish");
}

describe("scalable Copy Save", () => {
	test.each([false, true].flatMap((ordinary) => [false, true].map((edit) => ({ ordinary, edit }))))(
		"isolates a changed Copy during planning (ordinary=$ordinary edit=$edit)",
		async ({ ordinary, edit }) => {
			const f = await agent_copied_folders();
			const selected = [...f.copies];
			if (ordinary) {
				const moved = await f.t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
					...f.scope,
					target: { kind: "saved", id: f.sourceId },
					destParent: { kind: "root" },
					destName: "ordinary-renamed",
				});
				if (moved._nay) throw new Error(moved._nay.message);
				const proposal = await f.t.run(async (ctx) =>
					(await ctx.db.query("files_pending_updates").collect()).find((row) => row.target.id === f.sourceId),
				);
				if (!proposal) throw new Error("Expected the ordinary rename");
				selected.push(proposal);
			}
			const { runId } = await start_review(f, selected);
			const classified = await f.t.mutation(internal.files_pending_update_runs.classify_plan_page, { runId, fence: 0 });
			expect(classified._yay?.plan).toMatchObject({ phase: "atomic", atomicItemCount: ordinary ? 1 : 0 });
			if (edit) {
				const changed = await f.t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
					...f.scope,
					target: f.copies[0]!.target,
					destParent: { kind: "saved", id: f.targetId },
					destName: "changed-copy",
				});
				if (changed._nay) throw new Error(changed._nay.message);
			}
			const planned = await plan_review(f, runId);
			expect(planned.reviewVersion).toBe(classified._yay?.reviewVersion);
			const result = await finish_review(f, runId, selected.length);
			expect(result?.activity).toMatchObject({
				status: edit ? "partial" : "succeeded",
				progress: { completed: selected.length - (edit ? 1 : 0), blocked: edit ? 1 : 0, failed: 0 },
			});
			expect(result?.run.revalidateRemaining).toBe(edit);
			const receipts = await f.t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect());
			const savedCopies = edit ? f.copies.slice(1) : f.copies;
			expect(receipts.map((receipt) => receipt.privateNodeId).sort()).toEqual(
				savedCopies.map((copy) => copy.target.id).sort(),
			);
			const saved = await f.t.run((ctx) => ctx.db.query("files_nodes").collect());
			expect(saved.map((node) => node.path).sort()).toEqual(
				[
					ordinary ? "/ordinary-renamed" : "/source",
					"/source-two",
					"/source-three",
					"/target",
					...savedCopies.map((copy) => `/target${copy.copiedFrom!.path}`),
				].sort(),
			);
			for (const receipt of receipts)
				expect(saved.find((node) => node._id === receipt.savedNodeId)).toMatchObject({
					publishedFromPrivateNodeId: receipt.privateNodeId,
					archiveOperationId: null,
				});
			const pending = await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect());
			expect(pending).toHaveLength(edit ? 1 : 0);
			if (edit) expect(pending[0]).toMatchObject({ _id: f.copies[0]!._id, revision: f.copies[0]!.revision + 1 });
		},
	);

	test.each(["planning", "running"].flatMap((at) => [false, true].map((edit) => ({ at, edit }))))(
		"keeps the ordinary selected revision check (at=$at edit=$edit)",
		async ({ at, edit }) => {
			const f = await fixture();
			const move = {
				...f.scope,
				target: { kind: "saved" as const, id: f.sourceId },
				destParent: { kind: "root" as const },
			};
			expect(
				(
					await f.t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
						...move,
						destName: "reviewed",
					})
				)._nay,
			).toBeUndefined();
			const proposal = await f.t.run((ctx) => ctx.db.query("files_pending_updates").unique());
			if (!proposal) throw new Error("Expected the ordinary proposal");
			const { runId } = await start_review(f, [proposal]);
			expect(
				(await f.t.mutation(internal.files_pending_update_runs.classify_plan_page, { runId, fence: 0 }))._yay?.plan,
			).toMatchObject({ phase: "atomic", atomicItemCount: 1 });
			if (at === "running") await plan_review(f, runId);
			if (edit)
				expect(
					(
						await f.t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
							...move,
							destName: "unreviewed",
						})
					)._nay,
				).toBeUndefined();
			await plan_review(f, runId);
			expect((await finish_review(f, runId, 1))?.activity).toMatchObject({
				status: edit ? "failed" : "succeeded",
				progress: { completed: edit ? 0 : 1, blocked: edit ? 1 : 0 },
			});
			expect(await f.t.run((ctx) => ctx.db.get("files_nodes", f.sourceId))).toMatchObject({
				path: edit ? "/source" : "/reviewed",
				archiveOperationId: null,
			});
			expect(await f.t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect())).toEqual([]);
			const pending = await f.t.run((ctx) => ctx.db.get("files_pending_updates", proposal._id));
			if (edit)
				expect(pending).toMatchObject({ revision: proposal.revision + 1, pendingMove: { destName: "unreviewed" } });
			else expect(pending).toBeNull();
		},
	);

	test("keeps Copies independent when an unselected Move enters one after classification", async () => {
		const f = await agent_copied_folders();
		const rename = await pending_move(f, { kind: "saved", id: f.sourceId }, { kind: "root" }, "ordinary-renamed");
		const { runId } = await start_review(f, [...f.copies, rename]);
		expect(
			(await f.t.mutation(internal.files_pending_update_runs.classify_plan_page, { runId, fence: 0 }))._yay?.plan,
		).toMatchObject({ phase: "atomic", atomicItemCount: 1 });
		const sourceTwo = await f.t.run(async (ctx) =>
			(await ctx.db.query("files_nodes").collect()).find((node) => node.path === "/source-two"),
		);
		if (!sourceTwo) throw new Error("Expected the second source");
		const entering = await pending_move(f, { kind: "saved", id: sourceTwo._id }, f.copies[0]!.target, "entered");
		const planned = await plan_review(f, runId);
		expect(planned).toMatchObject({ unitCount: 4, plan: { phase: "ready", atomicItemCount: 1 } });
		expect(await review_clock(f)).toBeGreaterThan(planned.reviewVersion);

		const result = await finish_review(f, runId, 4);
		expect(result?.activity).toMatchObject({ status: "succeeded", progress: { completed: 4, blocked: 0, failed: 0 } });
		// The ordinary rename saved only after its own check under a clock newer than the seal.
		expect(result?.run.revalidateRemaining).toBe(true);
		const units = await f.t.run((ctx) => ctx.db.query("files_pending_update_run_units").collect());
		const atomic = units.find((unit) => unit.kind === "atomic");
		expect(atomic).toMatchObject({ itemCount: 1, status: "completed", errorCode: null });
		expect(atomic?.validatedReviewVersion).toBeGreaterThan(planned.reviewVersion);
		expect(units.filter((unit) => unit.kind === "copy")).toHaveLength(3);
		const receipts = await f.t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect());
		expect(receipts.map((receipt) => receipt.privateNodeId).sort()).toEqual(
			f.copies.map((copy) => copy.target.id).sort(),
		);
		expect((await f.t.run((ctx) => ctx.db.query("files_nodes").collect())).map((node) => node.path).sort()).toEqual(
			[
				"/ordinary-renamed",
				"/source-two",
				"/source-three",
				"/target",
				...f.copies.map((copy) => `/target${copy.copiedFrom!.path}`),
			].sort(),
		);
		// The unselected Move was not added to any Save and stays pending as it was.
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect())).toMatchObject([
			{ _id: entering._id, revision: entering.revision, pendingMove: { destName: "entered" } },
		]);
	});

	test("blocks a Copy that gains an ordinary link after classification together with that link", async () => {
		const f = await agent_copied_folders();
		const rename = await pending_move(f, { kind: "saved", id: f.sourceId }, { kind: "root" }, "ordinary-renamed");
		const { runId } = await start_review(f, [...f.copies, rename]);
		expect(
			(await f.t.mutation(internal.files_pending_update_runs.classify_plan_page, { runId, fence: 0 }))._yay?.plan,
		).toMatchObject({ phase: "atomic", atomicItemCount: 1 });
		// The Copy now lives below the folder that the selected rename moves.
		const linked = await pending_move(f, f.copies[0]!.target, { kind: "saved", id: f.sourceId }, "linked-copy");
		const planned = await plan_review(f, runId);
		expect(planned).toMatchObject({ unitCount: 3, plan: { phase: "ready", atomicItemCount: 2 } });
		const units = await f.t.run((ctx) => ctx.db.query("files_pending_update_run_units").collect());
		expect(units.find((unit) => unit.kind === "atomic")).toMatchObject({ itemCount: 2, errorCode: "needs_review" });

		const result = await finish_review(f, runId, 4);
		expect(result?.activity).toMatchObject({ status: "partial", progress: { completed: 2, blocked: 2, failed: 0 } });
		const items = await f.asUser.query(api.files_pending_update_runs.list_items, {
			membershipId: f.db.membershipId,
			runId,
			paginationOpts: { cursor: null, numItems: 100 },
		});
		expect(items.page.map((item) => item.status)).toEqual(["needs_review", "completed", "completed", "needs_review"]);
		const savedCopies = f.copies.slice(1);
		const receipts = await f.t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect());
		expect(receipts.map((receipt) => receipt.privateNodeId).sort()).toEqual(
			savedCopies.map((copy) => copy.target.id).sort(),
		);
		// Nothing published around the changed Copy: the rename and the Copy both stay pending.
		expect((await f.t.run((ctx) => ctx.db.query("files_nodes").collect())).map((node) => node.path).sort()).toEqual(
			[
				"/source",
				"/source-two",
				"/source-three",
				"/target",
				...savedCopies.map((copy) => `/target${copy.copiedFrom!.path}`),
			].sort(),
		);
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", rename._id))).toEqual(rename);
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", f.copies[0]!._id))).toEqual(linked);
		expect(linked.revision).toBe(f.copies[0]!.revision + 1);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect())).toHaveLength(2);
	});

	test("blocks the ordinary subset when one ordinary change is revised after classification", async () => {
		const f = await agent_copied_folders();
		const sourceTwo = await f.t.run(async (ctx) =>
			(await ctx.db.query("files_nodes").collect()).find((node) => node.path === "/source-two"),
		);
		if (!sourceTwo) throw new Error("Expected the second source");
		const rename = await pending_move(f, { kind: "saved", id: f.sourceId }, { kind: "root" }, "ordinary-renamed");
		const other = await pending_move(f, { kind: "saved", id: sourceTwo._id }, { kind: "root" }, "two-renamed");
		const { runId } = await start_review(f, [...f.copies, rename, other]);
		expect(
			(await f.t.mutation(internal.files_pending_update_runs.classify_plan_page, { runId, fence: 0 }))._yay?.plan,
		).toMatchObject({ phase: "atomic", atomicItemCount: 2 });
		const revised = await pending_move(f, { kind: "saved", id: f.sourceId }, { kind: "root" }, "unreviewed");
		const planned = await plan_review(f, runId);
		expect(planned).toMatchObject({ unitCount: 4, plan: { phase: "ready", atomicItemCount: 2 } });
		// The revised rename's reviewed links are unknown, so the other ordinary rename waits too.
		const units = await f.t.run((ctx) => ctx.db.query("files_pending_update_run_units").collect());
		expect(units.find((unit) => unit.kind === "atomic")).toMatchObject({ itemCount: 2, errorCode: "needs_review" });

		const result = await finish_review(f, runId, 5);
		expect(result?.activity).toMatchObject({ status: "partial", progress: { completed: 3, blocked: 2, failed: 0 } });
		const receipts = await f.t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect());
		expect(receipts.map((receipt) => receipt.privateNodeId).sort()).toEqual(
			f.copies.map((copy) => copy.target.id).sort(),
		);
		expect((await f.t.run((ctx) => ctx.db.query("files_nodes").collect())).map((node) => node.path).sort()).toEqual(
			[
				"/source",
				"/source-two",
				"/source-three",
				"/target",
				...f.copies.map((copy) => `/target${copy.copiedFrom!.path}`),
			].sort(),
		);
		expect(revised).toMatchObject({ revision: rename.revision + 1, pendingMove: { destName: "unreviewed" } });
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", rename._id))).toEqual(revised);
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", other._id))).toEqual(other);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect())).toHaveLength(2);
	});

	test.each([false, true])(
		"keeps an ordinary Move and its child in one unit beside a changed Copy (occupied: %s)",
		async (occupied) => {
			const f = await agent_copied_folders();
			const folder = await f.t.mutation(internal.files_nodes.create_folder_node_by_path, {
				...f.scope,
				path: "/ordinary",
			});
			if (folder._nay) throw new Error(folder._nay.message);
			const move = await pending_move(f, { kind: "saved", id: folder._yay.nodeId }, { kind: "root" }, "moved");
			// The pending view shows the saved folder at "/moved", so the child's parent is that saved folder.
			const created = await f.t.mutation(internal.files_nodes.create_private_node_by_path, {
				...f.scope,
				kind: "folder",
				path: "/moved/child",
			});
			if (created._nay || !created._yay.pendingUpdateId) throw new Error("Expected the ordinary child");
			const child = await f.t.run((ctx) => ctx.db.get("files_pending_updates", created._yay.pendingUpdateId!));
			if (!child) throw new Error("Expected the ordinary child proposal");
			const { runId } = await start_review(f, [...f.copies, move, child]);
			expect(
				(await f.t.mutation(internal.files_pending_update_runs.classify_plan_page, { runId, fence: 0 }))._yay?.plan,
			).toMatchObject({ phase: "atomic", atomicItemCount: 2 });
			await pending_move(f, f.copies[0]!.target, { kind: "saved", id: f.targetId }, "changed-copy");
			const planned = await plan_review(f, runId);
			expect(planned).toMatchObject({ unitCount: 4, plan: { phase: "ready", atomicItemCount: 2 } });
			const atomicUnit = (await f.t.run((ctx) => ctx.db.query("files_pending_update_run_units").collect())).find(
				(unit) => unit.kind === "atomic",
			);
			expect(atomicUnit).toMatchObject({ itemCount: 2, errorCode: null });
			// A late saved occupant makes the child's Save refuse after the parent was parked.
			if (occupied)
				expect(
					(
						await f.t.mutation(internal.files_nodes.create_folder_node_by_path, {
							...f.scope,
							path: "/ordinary/child",
						})
					)._nay,
				).toBeUndefined();
			const before = await f.t.run((ctx) => ctx.db.get("files_nodes", folder._yay.nodeId));

			const result = await finish_review(f, runId, 5);
			expect(result?.activity).toMatchObject({
				status: "partial",
				progress: { completed: occupied ? 2 : 4, blocked: occupied ? 3 : 1, failed: 0 },
			});
			expect(result?.run.revalidateRemaining).toBe(true);
			const unit = await f.t.run((ctx) => ctx.db.get("files_pending_update_run_units", atomicUnit!._id));
			expect(unit).toMatchObject({ status: occupied ? "blocked" : "completed" });
			if (!occupied) expect(unit?.validatedReviewVersion).toBeGreaterThan(planned.reviewVersion);
			const savedCopies = f.copies.slice(1);
			const receipts = await f.t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect());
			expect(receipts.map((receipt) => receipt.privateNodeId).sort()).toEqual(
				[...savedCopies.map((copy) => copy.target.id), ...(occupied ? [] : [child.target.id])].sort(),
			);
			expect((await f.t.run((ctx) => ctx.db.query("files_nodes").collect())).map((node) => node.path).sort()).toEqual(
				[
					...(occupied ? ["/ordinary", "/ordinary/child"] : ["/moved", "/moved/child"]),
					"/source",
					"/source-two",
					"/source-three",
					"/target",
					...savedCopies.map((copy) => `/target${copy.copiedFrom!.path}`),
				].sort(),
			);
			// The refused unit rolled back its parking rename, so the saved folder is unchanged.
			if (occupied) expect(await f.t.run((ctx) => ctx.db.get("files_nodes", folder._yay.nodeId))).toEqual(before);
			const pending = await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect());
			expect(pending.map((proposal) => proposal._id).sort()).toEqual(
				[f.copies[0]!._id, ...(occupied ? [move._id, child._id] : [])].sort(),
			);
			if (occupied) {
				expect(pending.find((proposal) => proposal._id === move._id)).toEqual(move);
				expect(pending.find((proposal) => proposal._id === child._id)).toEqual(child);
			}
		},
	);

	test("keeps an ordinary Move with its child when the child moves away before classification", async () => {
		const f = await agent_copied_folders();
		const folder = await f.t.mutation(internal.files_nodes.create_folder_node_by_path, {
			...f.scope,
			path: "/ordinary",
		});
		if (folder._nay) throw new Error(folder._nay.message);
		const move = await pending_move(f, { kind: "saved", id: folder._yay.nodeId }, { kind: "root" }, "moved");
		const created = await f.t.mutation(internal.files_nodes.create_private_node_by_path, {
			...f.scope,
			kind: "folder",
			path: "/moved/child",
		});
		if (created._nay || !created._yay.pendingUpdateId) throw new Error("Expected the ordinary child");
		const child = await f.t.run((ctx) => ctx.db.get("files_pending_updates", created._yay.pendingUpdateId!));
		if (!child) throw new Error("Expected the ordinary child proposal");
		const { runId } = await start_review(f, [...f.copies, move, child]);
		// The child moves out after seal. Its current path no longer shows the reviewed link to the Move,
		// so only the revised selection itself can keep the pair together.
		const revised = await pending_move(f, child.target, { kind: "root" }, "moved-away-child");
		const planned = await plan_review(f, runId);
		expect(planned).toMatchObject({ unitCount: 4, plan: { phase: "ready", atomicItemCount: 2 } });
		const units = await f.t.run((ctx) => ctx.db.query("files_pending_update_run_units").collect());
		expect(units.find((unit) => unit.kind === "atomic")).toMatchObject({ itemCount: 2, errorCode: "needs_review" });

		const result = await finish_review(f, runId, 5);
		expect(result?.activity).toMatchObject({ status: "partial", progress: { completed: 3, blocked: 2, failed: 0 } });
		const receipts = await f.t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect());
		expect(receipts.map((receipt) => receipt.privateNodeId).sort()).toEqual(
			f.copies.map((copy) => copy.target.id).sort(),
		);
		// The reviewed Move never saves without its reviewed child.
		expect((await f.t.run((ctx) => ctx.db.query("files_nodes").collect())).map((node) => node.path).sort()).toEqual(
			[
				"/ordinary",
				"/source",
				"/source-two",
				"/source-three",
				"/target",
				...f.copies.map((copy) => `/target${copy.copiedFrom!.path}`),
			].sort(),
		);
		expect(revised.revision).toBe(child.revision + 1);
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", move._id))).toEqual(move);
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", child._id))).toEqual(revised);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect())).toHaveLength(2);
	});

	test.each([false, true])("keeps Copies with the reviewed Move of their folder (revised: %s)", async (revised) => {
		const f = await agent_copied_folders();
		const move = await pending_move(f, { kind: "saved", id: f.targetId }, { kind: "root" }, "target-renamed");
		const { runId } = await start_review(f, [...f.copies, move]);
		expect(
			(await f.t.mutation(internal.files_pending_update_runs.classify_plan_page, { runId, fence: 0 }))._yay?.plan,
		).toMatchObject({ phase: "atomic", atomicItemCount: 1 });
		const changed = revised
			? await pending_move(f, { kind: "saved", id: f.targetId }, { kind: "root" }, "target-revised")
			: null;
		const planned = await plan_review(f, runId);
		// The Copies were reviewed below the renamed folder, so they join its unit in both cases.
		expect(planned).toMatchObject({ unitCount: 1, plan: { phase: "ready", atomicItemCount: 4 } });
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_update_run_units").collect())).toMatchObject([
			{ kind: "atomic", itemCount: 4, errorCode: revised ? "needs_review" : null },
		]);

		const result = await finish_review(f, runId, 4);
		expect(result?.activity).toMatchObject({
			status: revised ? "failed" : "succeeded",
			progress: { completed: revised ? 0 : 4, blocked: revised ? 4 : 0, failed: 0 },
		});
		const receipts = await f.t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect());
		expect(receipts.map((receipt) => receipt.privateNodeId).sort()).toEqual(
			revised ? [] : f.copies.map((copy) => copy.target.id).sort(),
		);
		const folder = revised ? "/target" : "/target-renamed";
		expect((await f.t.run((ctx) => ctx.db.query("files_nodes").collect())).map((node) => node.path).sort()).toEqual(
			[
				"/source",
				"/source-two",
				"/source-three",
				folder,
				...(revised ? [] : f.copies.map((copy) => `${folder}${copy.copiedFrom!.path}`)),
			].sort(),
		);
		const pending = await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect());
		if (!changed) expect(pending).toEqual([]);
		else {
			expect(changed.revision).toBe(move.revision + 1);
			expect(pending.sort((a, b) => a._creationTime - b._creationTime)).toEqual([...f.copies, changed]);
		}
	});

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
			const move = await pending_move(f, { kind: "saved", id: child._yay.nodeId }, { kind: "root" }, "b-moved");
			const { runId } = await start_review(f, [...f.copies, move]);
			expect(
				(await f.t.mutation(internal.files_pending_update_runs.classify_plan_page, { runId, fence: 0 }))._yay?.plan,
			).toMatchObject({ phase: "atomic", atomicItemCount: 1 });
			const parentMove = unselected
				? await pending_move(f, { kind: "saved", id: parent._yay.nodeId }, { kind: "root" }, "a-moved")
				: null;
			const planned = await plan_review(f, runId);
			expect(planned).toMatchObject({ step: "running", unitCount: 4, plan: { phase: "ready", atomicItemCount: 1 } });
			expect(
				(await f.t.run((ctx) => ctx.db.query("files_pending_update_run_units").collect())).find(
					(unit) => unit.kind === "atomic",
				),
			).toMatchObject({
				itemCount: 1,
				errorCode: unselected ? "needs_review" : null,
				errorMessage: unselected ? "This action also affects unselected changes. Review them together." : null,
			});

			const result = await finish_review(f, runId, 4);
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
		const move = await pending_move(f, { kind: "saved", id: child._yay.nodeId }, { kind: "root" }, "b-moved");
		const { runId } = await start_review(f, [...f.copies, move]);
		await f.t.mutation(internal.files_pending_update_runs.classify_plan_page, { runId, fence: 0 });
		const parentMove = await pending_move(f, { kind: "saved", id: parent._yay.nodeId }, { kind: "root" }, "a-moved");
		expect(
			await f.t.mutation(internal.files_pending_update_runs.block_atomic_plan_page, {
				runId,
				fence: 0,
				cursor: null,
				message: "This action also affects unselected changes. Review them together.",
				unreviewedIds: [parentMove._id],
			}),
		).toMatchObject({ _yay: { isDone: true } });

		// Lose every planning action. The third recovery fails the whole run.
		for (let attempt = 0; attempt < 3; attempt++) {
			vi.setSystemTime(Date.now() + 6 * 60 * 1000);
			await f.t.mutation(internal.files_pending_update_runs.recover, {});
		}
		const result = await f.asUser.query(api.files_pending_update_runs.get, { membershipId: f.db.membershipId, runId });
		expect(result?.activity).toMatchObject({ status: "failed", errorCode: "attempt_expired" });
		expect(result?.run.needsReviewIds).toEqual([parentMove._id]);
	});

	test("keeps the ordinary unit blocked when a long block scan resumes in a new planning action", async () => {
		const f = await agent_copied_folders();
		const parent = await f.t.mutation(internal.files_nodes.create_folder_node_by_path, { ...f.scope, path: "/a" });
		if (parent._nay) throw new Error(parent._nay.message);
		const child = await f.t.mutation(internal.files_nodes.create_folder_node_by_path, { ...f.scope, path: "/a/b" });
		if (child._nay) throw new Error(child._nay.message);
		const move = await pending_move(f, { kind: "saved", id: child._yay.nodeId }, { kind: "root" }, "b-moved");
		const parentMove = await pending_move(f, { kind: "saved", id: parent._yay.nodeId }, { kind: "root" }, "a-moved");
		// Unrelated unselected proposals after the needed parent Move. One planning action scans 32 pages,
		// so the block scan stops and a new action must resume it on the block path.
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
		// A second, independent ordinary rename. A normal plan would give it its own unit, so a resumed
		// action that forgot the blocked unit would no longer match it.
		const rename = await pending_move(f, { kind: "saved", id: f.sourceId }, { kind: "root" }, "ordinary-renamed");
		const { runId } = await start_review(f, [...f.copies, move, rename]);
		const planned = await plan_review(f, runId);
		expect(planned).toMatchObject({ step: "running", unitCount: 4, needsReviewIds: [parentMove._id] });
		expect(
			(await f.t.run((ctx) => ctx.db.query("files_pending_update_run_units").collect())).find(
				(unit) => unit.kind === "atomic",
			),
		).toMatchObject({ itemCount: 2, errorCode: "needs_review" });

		const result = await finish_review(f, runId, 5);
		expect(result?.activity).toMatchObject({ status: "partial", progress: { completed: 3, blocked: 2, failed: 0 } });
		const receipts = await f.t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect());
		expect(receipts.map((receipt) => receipt.privateNodeId).sort()).toEqual(
			f.copies.map((copy) => copy.target.id).sort(),
		);
		const saved = (await f.t.run((ctx) => ctx.db.query("files_nodes").collect())).map((node) => node.path);
		expect(saved).toEqual(expect.arrayContaining(["/a/b", "/source"]));
		expect(saved).not.toEqual(expect.arrayContaining(["/b-moved"]));
		expect(saved).not.toEqual(expect.arrayContaining(["/ordinary-renamed"]));
		for (const proposal of [move, rename, parentMove])
			expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", proposal._id))).toEqual(proposal);
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
		expect(await plan_review(f, runId)).toMatchObject({ unitCount: 2, plan: { atomicItemCount: 0 } });
		expect((await finish_review(f, runId, 2))?.activity).toMatchObject({
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
		const [parent] = await copied_folders(f, 1);
		if (!parent || parent.target.kind !== "private") throw new Error("Expected the copied parent");
		const [sibling] = await copied_folders(f, 1, parent.target);
		const created = await f.t.mutation(internal.files_nodes.create_private_node_by_path, {
			...f.scope,
			kind: "folder",
			path: "/copy-00000/ordinary",
		});
		if (created._nay || !created._yay.pendingUpdateId) throw new Error("Expected the ordinary child");
		const ordinary = await f.t.run((ctx) => ctx.db.get("files_pending_updates", created._yay.pendingUpdateId!));
		if (!ordinary) throw new Error("Expected the ordinary proposal");
		const { runId } = await start_review(f, [sibling!, ordinary, parent]);
		expect(await plan_review(f, runId)).toMatchObject({ unitCount: 2, plan: { atomicItemCount: 2 } });
		const units = await f.t.run((ctx) => ctx.db.query("files_pending_update_run_units").collect());
		expect(units.find((unit) => unit.kind === "atomic")).toMatchObject({ itemCount: 2 });
		expect(units.find((unit) => unit.kind === "copy")).toMatchObject({ itemCount: 1, status: "waiting" });
		expect((await finish_review(f, runId, 3))?.activity).toMatchObject({
			status: "succeeded",
			progress: { completed: 3 },
		});
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect())).toHaveLength(3);
	});

	test("a changed parent blocks only its child and leaves another Copy free to save", async () => {
		const f = await fixture();
		const [parent, independent] = await copied_folders(f, 2);
		if (!parent || parent.target.kind !== "private") throw new Error("Expected the copied parent");
		const [child] = await copied_folders(f, 1, parent.target);
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
		expect((await finish_review(f, runId, 3))?.activity).toMatchObject({
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

	test("resumes the exact classification cursor after a lost planning action", async () => {
		const f = await fixture();
		const copies = await copied_folders(f, 20);
		const { runId } = await start_review(f, copies);
		await f.t.mutation(internal.files_pending_update_runs.classify_plan_page, { runId, fence: 0 });
		const before = await f.t.run((ctx) => ctx.db.get("files_pending_update_runs", runId));
		expect(before?.plan).toMatchObject({ phase: "classify", atomicItemCount: 0 });
		if (!before?.plan) throw new Error("Expected the review plan");
		expect(before.plan.cursor).not.toBeNull();
		vi.setSystemTime(Date.now() + 5 * 60 * 1000);
		await f.t.mutation(internal.files_pending_update_runs.recover, {});
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_update_runs", runId))).toMatchObject({
			fence: 1,
			plan: before!.plan,
		});
		expect(
			await f.t.mutation(internal.files_pending_update_runs.classify_plan_page, { runId, fence: 0 }),
		).toMatchObject({ _nay: { name: "stopped" } });
		expect(await plan_review(f, runId)).toMatchObject({ unitCount: 20, plannedItemCount: 20 });
		expect((await finish_review(f, runId, 20, 1_200))?.activity).toMatchObject({
			status: "succeeded",
			progress: { completed: 20 },
		});
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect())).toHaveLength(20);
	});

	test("extends the idle deadline on Save progress but still expires an idle remainder", async () => {
		const f = await fixture();
		const copies = await copied_folders(f, 3);
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

	// Keep this at 1,000 Copy outputs. Our Save reads a fixed number of docs per step, but convex-test scans
	// every doc in its in-memory database for each query, even an indexed one. So the test time grows with
	// the square of the size: 1,000 outputs take about 1.5 minutes, and 10,000 take more than 2 hours.
	test(
		"saves 1,000 Copy outputs beside one ordinary edit",
		async () => {
			const f = await fixture();
			const copies = await copied_folders(f, 1_000);
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
				plan: { phase: "ready", atomicItemCount: 1 },
			});
			const startedAt = Date.now();
			// Step the clock 2 seconds per worker pass so the Save runs longer than 30 minutes of app time.
			const result = await finish_review(f, runId, 1_001, 2_000);
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
		10 * 60 * 1_000,
	);

	test("starts a Save above the Discard limit", async () => {
		const f = await fixture();
		const [copy] = await copied_folders(f, 1);
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
		const [parent] = await copied_folders(f, 1);
		if (!parent || parent.target.kind !== "private") throw new Error("Expected the private parent");
		const [child, sibling] = await copied_folders(f, 2, parent.target);
		const { runId } = await start_review(f, [child!, parent]);
		expect(await plan_review(f, runId)).toMatchObject({ step: "running", unitCount: 2 });
		expect(await save_next(f, runId)).toBe(true);
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", parent._id))).toBeNull();
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", child!._id))).toEqual(child);
		expect((await finish_review(f, runId, 2))?.activity).toMatchObject({
			status: "succeeded",
			progress: { completed: 2 },
		});
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", sibling!._id))).toEqual(sibling);
		const saved = await f.t.run((ctx) => ctx.db.query("files_nodes").collect());
		expect(saved.map((node) => node.path).sort()).toEqual(["/copy-00000", "/copy-00000/copy-00000", "/source"]);
	});

	test("Stop after one Copy keeps its saved node and the unsaved remainder", async () => {
		const f = await fixture();
		const copies = await copied_folders(f, 3);
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
		const [parent] = await copied_folders(f, 1);
		if (!parent || parent.target.kind !== "private") throw new Error("Expected the private parent");
		const children = await copied_folders(f, 25, parent.target);
		const { runId, activityId } = await start_review(f, [...children, parent]);
		await plan_review(f, runId);
		expect(await save_next(f, runId)).toBe(true);
		const readEdges = async () =>
			await f.t.run((ctx) => ctx.db.query("files_pending_update_run_dependencies").collect());
		expect((await readEdges()).filter((edge) => edge.settled)).toHaveLength(0);
		await f.t.mutation(internal.files_pending_update_runs.advance, { runId });
		expect((await readEdges()).filter((edge) => edge.settled)).toHaveLength(8);
		await f.t.mutation(internal.files_pending_update_runs.advance, { runId });
		expect((await readEdges()).filter((edge) => edge.settled)).toHaveLength(16);
		expect((await finish_review(f, runId, 26, 1_200))?.activity).toMatchObject({
			status: "succeeded",
			progress: { completed: 26 },
		});
		expect((await readEdges()).filter((edge) => edge.settled)).toHaveLength(25);
		const units = await f.t.run((ctx) => ctx.db.query("files_pending_update_run_units").collect());
		expect(units.every((unit) => unit.remainingPrerequisiteCount === 0 && unit.dependentsSettled)).toBe(true);
		const saved = await f.t.run((ctx) => ctx.db.query("files_nodes").collect());
		const receipts = await f.t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect());
		expect(saved).toHaveLength(27);
		expect(receipts).toHaveLength(26);
		for (let page = 0; page < 30; page++) {
			const removed = await f.t.run((ctx) => files_pending_update_runs_db_delete_run_batch(ctx, { runId }));
			if (removed.done) break;
			if (page === 29) throw new Error("History cleanup did not finish");
		}
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_update_runs", runId))).toBeNull();
		expect(await f.t.run((ctx) => ctx.db.get("activities", activityId))).toBeNull();
		expect(await readEdges()).toEqual([]);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_update_run_units").collect())).toEqual([]);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_update_run_items").collect())).toEqual([]);
		expect(await f.t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(saved);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect())).toEqual(receipts);
	});

	test("holds exact appended selections and hands Stop remainder to one fixed review deadline", async () => {
		const f = await fixture();
		const copies = await copied_folders(f, 2);
		const cleanup = await f.t.run((ctx) => ctx.db.query("files_pending_updates_cleanup_tasks").collect());
		expect(cleanup).toHaveLength(2);
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
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_updates_cleanup_tasks").collect())).toEqual(cleanup);
		vi.setSystemTime(Date.now() + 6 * 60 * 1000);
		for (const task of cleanup)
			await f.t.mutation(internal.files_pending_updates.remove_file_pending_update_if_expired, {
				cleanupTaskId: task._id,
				expiryGeneration: task.expiryGeneration,
			});
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect())).toEqual(copies);
		expect(
			await f.asUser.mutation(api.activities.request_stop, { membershipId: f.db.membershipId, activityId }),
		).toEqual({ _yay: null });
		const run = await f.t.run((ctx) => ctx.db.get("files_pending_update_runs", runId));
		const activity = await f.t.run((ctx) => ctx.db.get("activities", activityId));
		expect(run?.outputReviewUntil).toBe(activity!.finishedAt! + 4 * 60 * 60 * 1000);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_holds").collect())).toHaveLength(2);
		const beforeRelease = await f.t.run((ctx) => ctx.db.get("files_pending_updates_cleanup_tasks", cleanup[0]!._id));
		await f.t.mutation(internal.files_pending_updates.remove_file_pending_update_if_expired, {
			cleanupTaskId: beforeRelease!._id,
			expiryGeneration: beforeRelease!.expiryGeneration,
		});
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", copies[0]!._id))).toEqual(copies[0]);
		await f.t.mutation(internal.files_pending_holds.release_producer, {
			producer: { kind: "files_pending_update_run", id: runId },
		});
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_holds").collect())).toEqual([]);
		const afterRelease = await f.t.run((ctx) => ctx.db.query("files_pending_updates_cleanup_tasks").collect());
		expect(afterRelease.every((task) => task.expiresAt === run!.outputReviewUntil)).toBe(true);
		for (const task of cleanup)
			await f.t.mutation(internal.files_pending_updates.remove_file_pending_update_if_expired, {
				cleanupTaskId: task._id,
				expiryGeneration: task.expiryGeneration,
			});
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect())).toEqual(copies);
		expect(await f.t.run((ctx) => ctx.db.query("files_nodes").collect())).toHaveLength(1);
	});
});
