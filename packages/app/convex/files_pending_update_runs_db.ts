// Shared database bodies. Keep editor and action work on their current owners.

import { internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { activities_db_require_by_source_id, activities_is_active } from "./activities_db.ts";
import { should_never_happen } from "../shared/shared-utils.ts";

export const files_pending_update_runs_RUN_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Count publication once. Repair may finish after the parent review stops.
 */
export async function files_pending_update_runs_db_record_cohort_publication(
	ctx: MutationCtx,
	args: { cohortId: Id<"files_move_cohorts"> },
) {
	const cohort = await ctx.db.get("files_move_cohorts", args.cohortId);
	if (!cohort || cohort.origin.kind !== "review" || cohort.publishedAt === null) return;
	const unit = await ctx.db.get("files_pending_update_run_units", cohort.origin.unitId);
	const run = await ctx.db.get("files_pending_update_runs", cohort.origin.runId);
	if (!run || !unit || unit.runId !== run._id || unit.cohortId !== cohort._id || unit.publicationRecorded) return;
	if (run.step !== "running" || run.fence !== cohort.fence || unit.attemptFence !== cohort.attemptFence)
		throw should_never_happen("A stopped review cannot publish a new cohort", args);
	const activity = await activities_db_require_by_source_id(ctx, run._id);
	await ctx.db.patch("files_pending_update_run_units", unit._id, { publicationRecorded: true });
	await ctx.db.patch("activities", activity._id, {
		progress: { ...activity.progress!, completed: activity.progress!.completed + unit.itemCount },
		updatedAt: Date.now(),
	});
}

/**
 * Resume a review that waited for another Move. Only the Activity sweep moved its deadline while it
 * waited, so that deadline may have passed: move it. Moving `updatedAt` keeps recover from starting a
 * second plan before this one runs.
 */
export async function files_pending_update_runs_db_resume_parked(
	ctx: MutationCtx,
	args: { runId: Id<"files_pending_update_runs">; fence: number },
) {
	const run = await ctx.db.get("files_pending_update_runs", args.runId);
	if (run?.fence !== args.fence || (run.step !== "planning" && run.step !== "running")) return;
	const activity = await activities_db_require_by_source_id(ctx, run._id);
	if (!activities_is_active(activity.status)) return;
	const now = Date.now();
	await ctx.db.patch("activities", activity._id, { updatedAt: now, deadlineAt: now + files_pending_update_runs_RUN_TIMEOUT_MS });
	await ctx.db.patch("files_pending_update_runs", run._id, { updatedAt: now });
	if (run.step === "planning")
		await ctx.scheduler.runAfter(0, internal.files_pending_update_runs.plan, { runId: run._id, fence: run.fence });
	else await ctx.scheduler.runAfter(0, internal.files_pending_update_runs.advance, { runId: run._id });
}
