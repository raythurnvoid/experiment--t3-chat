// Fixtures shared by the files_pending_update_runs_copy test files.
import { expect, vi } from "vitest";
import type { FunctionArgs } from "convex/server";
import { api, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { files_pending_nodes_db_create } from "./files_pending_nodes.ts";
import { files_db_patch_pending_update } from "../server/files.ts";
import {
	test_convex,
	test_db_get_overlay_job,
	test_db_get_review_state,
	test_db_get_slot_cohort,
	test_finish_pending_update_run,
	test_mocks_fill_db_with,
	test_progress_guard,
	test_run_with_flush,
} from "./setup.test.ts";

export async function fixture() {
	const t = test_convex({ transactionLimits: true });
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId };
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const source = await t.mutation(internal.files_nodes.create_folder_node_by_path, { ...scope, path: "/source" });
	if (source._nay) throw new Error(source._nay.message);
	return { t, db, scope, asUser, sourceId: source._yay.nodeId };
}

export async function copied_folders(args: {
	f: Awaited<ReturnType<typeof fixture>>;
	count: number;
	parent?: Doc<"files_pending_nodes">["parent"];
}): Promise<Doc<"files_pending_updates">[]> {
	const { f, count, parent = { kind: "root" } } = args;

	if (count > 100) {
		const [first] = await copied_folders({ f, count: 1, parent });
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
		for (let offset = 1; offset < count; offset += 32) {
			proposals.push(
				...(await test_run_with_flush(f.t, async (ctx) => {
					const page = [];
					for (let index = offset; index < Math.min(offset + 32, count); index++) {
						const id = await ctx.db.insert("files_pending_nodes", {
							...template.nodeFields,
							name: `copy-${String(index).padStart(5, "0")}`,
						});
						// The clone keeps the template's `expiresAt`. The template's create already
						// scheduled the owner's expiry check.
						const pendingUpdateId = await ctx.db.insert("files_pending_updates", {
							...proposalFields,
							target: { kind: "private", id },
						});
						await ctx.db.insert("files_private_storage_reservations", {
							...template.reservationFields,
							resource: { kind: "node", id },
						});
						const proposal = (await ctx.db.get("files_pending_updates", pendingUpdateId))!;
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
			...(await test_run_with_flush(f.t, async (ctx) => {
				const page = [];
				for (let index = offset; index < Math.min(offset + 32, count); index++) {
					const created = await files_pending_nodes_db_create(ctx, {
						...f.scope,
						parent,
						name: `copy-${String(index).padStart(5, "0")}`,
						kind: "folder",
					});
					if (created._nay) throw new Error(created._nay.message);
					await files_db_patch_pending_update({
						ctx,
						pendingUpdateId: created._yay.pendingUpdateId,
						value: {
							createIntent: { kind: "folder", metadata: [] },
							copiedFrom: { target: { kind: "saved", id: f.sourceId }, path: "/source", sourceWritePolicy: null },
						},
					});
					const proposal = await ctx.db.get("files_pending_updates", created._yay.pendingUpdateId);
					if (!proposal) throw new Error("Expected the copied proposal");
					page.push(proposal);
				}
				return page;
			})),
		);
	}
	return proposals;
}

export async function start_review(f: Awaited<ReturnType<typeof fixture>>, proposals: Doc<"files_pending_updates">[]) {
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

export async function agent_copied_folders() {
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

export async function pending_move(args: {
	f: Awaited<ReturnType<typeof fixture>>;
	target: Doc<"files_pending_updates">["target"];
	destParent: FunctionArgs<typeof internal.files_pending_updates.upsert_file_pending_move_in_db>["destParent"];
	destName: string;
}) {
	const { f, target, destName, destParent } = args;

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

export async function review_clock(f: Awaited<ReturnType<typeof fixture>>) {
	return (await f.t.run((ctx) => ctx.db.query("files_pending_review_versions").first()))?.revision ?? 0;
}

export async function next_overlay_job(f: Awaited<ReturnType<typeof fixture>>) {
	// This test fixture owns the jobs. Parked jobs wake only after cohort cleanup.
	return await f.t.run((ctx) => test_db_get_overlay_job(ctx, f.db));
}

export async function produce_plan_page(
	f: Awaited<ReturnType<typeof fixture>>,
	runId: Id<"files_pending_update_runs">,
) {
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
		const run = await f.t.run((ctx) => ctx.db.get("files_pending_update_runs", runId));
		if (!run) throw new Error("Expected the review run");
		const produced = await f.t.mutation(internal.files_pending_update_plan_producer.advance, {
			runId,
			fence: run.fence,
			planEpoch: run.planEpoch,
		});
		if (produced._nay) throw new Error(produced._nay.message);
		if (!produced._yay.waiting) return produced._yay.plan;
	}
	throw new Error("No review plan page became ready");
}

export async function unit_for(
	f: Awaited<ReturnType<typeof fixture>>,
	runId: Id<"files_pending_update_runs">,
	proposal: Doc<"files_pending_updates">,
) {
	return await f.t.run(async (ctx) => {
		const item = await ctx.db
			.query("files_pending_update_run_items")
			.withIndex("by_run_pendingUpdate", (q) => q.eq("runId", runId).eq("pendingUpdateId", proposal._id))
			.unique();
		if (!item?.unitId) throw new Error("Expected the proposal's review unit");
		return (await ctx.db.get("files_pending_update_run_units", item.unitId))!;
	});
}

export async function plan_review(f: Awaited<ReturnType<typeof fixture>>, runId: Id<"files_pending_update_runs">) {
	for (let pass = 0; pass < 3_000; pass++) {
		const job = await next_overlay_job(f);
		if (job) {
			await f.t.mutation(internal.files_pending_overlay.run_job, {
				kind: job.kind,
				key: job.key,
				nextAttemptAt: job.nextAttemptAt,
			});
			continue;
		}
		const run = await f.t.run((ctx) => ctx.db.get("files_pending_update_runs", runId));
		if (!run) throw new Error("Expected the review run");
		if (run.step !== "planning") return run;
		await f.t.action(internal.files_pending_update_runs.plan, { runId, fence: run.fence });
	}
	throw new Error("Planning did not finish");
}

export async function save_next(f: Awaited<ReturnType<typeof fixture>>, runId: Id<"files_pending_update_runs">) {
	const before = await f.asUser.query(api.files_pending_update_runs.get, { membershipId: f.db.membershipId, runId });
	const progress = test_progress_guard();
	// The running Move that advance already saw. Until it completes, advance only schedules its next step.
	let advancedCohortId: Id<"files_move_cohorts"> | null = null;
	for (let pass = 0; pass < 50_000; pass++) {
		// All reads of one pass in one transaction.
		const state = await f.t.run(async (ctx) => ({
			...(await test_db_get_review_state(ctx, runId)),
			slotCohort: await test_db_get_slot_cohort(ctx, f.db),
		}));
		const { job, activity } = state;
		progress(
			state,
			`Review step ${state.run.step}, job ${job?.kind ?? "none"}, Move ${state.cohort ? `${state.cohort.phase}/${state.cohort.workPhase} step ${state.cohort.step}` : "none"}`,
		);
		if (job) {
			await f.t.mutation(internal.files_pending_overlay.run_job, {
				kind: job.kind,
				key: job.key,
				nextAttemptAt: job.nextAttemptAt,
			});
			continue;
		}
		if ((activity?.progress?.completed ?? 0) > (before?.activity.progress?.completed ?? 0) && !state.slotCohort) {
			if (state.unit?.cohortId)
				await f.t.mutation(internal.files_pending_update_runs.settle_cohort, { cohortId: state.unit.cohortId });
			return true;
		}
		let { run, unit, cohort } = state;
		// Like test_finish_pending_update_run: skip advance while the Move it already saw still runs.
		if (
			!cohort ||
			cohort._id !== advancedCohortId ||
			cohort.phase === "complete" ||
			!activity ||
			activity.deadlineAt <= Date.now()
		) {
			await f.t.mutation(internal.files_pending_update_runs.advance, { runId });
			({ run, unit, cohort } = await f.t.run((ctx) => test_db_get_review_state(ctx, runId)));
			advancedCohortId = cohort && cohort.phase !== "complete" ? cohort._id : null;
		}
		if (run.step === "finished") return false;
		if (!unit?.cohortId) continue;
		if (!cohort) throw new Error("Expected the review cohort");
		if (cohort.phase === "complete")
			await f.t.mutation(internal.files_pending_update_runs.settle_cohort, { cohortId: cohort._id });
		else await f.t.action(internal.files_move_cohorts.run, { cohortId: cohort._id, step: cohort.step });
	}
	throw new Error("No review unit became ready");
}

export async function finish_review(args: {
	f: Awaited<ReturnType<typeof fixture>>;
	runId: Id<"files_pending_update_runs">;
	count: number;
	stepMs?: number;
}) {
	const { f, runId, count, stepMs = 0 } = args;
	if (stepMs) {
		for (let index = 0; index < count; index++) {
			vi.setSystemTime(Date.now() + stepMs);
			if (!(await save_next(f, runId))) break;
		}
	}
	await test_finish_pending_update_run(f.asUser, runId);
	return await f.asUser.query(api.files_pending_update_runs.get, { membershipId: f.db.membershipId, runId });
}
