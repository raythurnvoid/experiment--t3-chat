// Producers share Activity state without importing the handlers that dispatch back to them.

import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import { should_never_happen } from "../shared/shared-utils.ts";

/**
 * Maximum predicted duration, separate from the execution deadline.
 */
export const ACTIVITIES_ESTIMATE_MAX_MS = 5 * 60 * 1000;

export function activities_is_active(status: Doc<"activities">["status"]) {
	return status === "queued" || status === "running" || status === "awaiting_input" || status === "stopping";
}

/**
 * Use this only when the work finished on its own. Stop and deadlines set their own terminal status.
 */
export function activities_get_result_status(
	progress: Pick<NonNullable<Doc<"activities">["progress"]>, "completed" | "failed" | "blocked" | "canceled">,
) {
	if (progress.failed + progress.blocked + progress.canceled === 0) return "succeeded";
	if (progress.completed > 0) return "partial";
	return progress.failed + progress.blocked > 0 ? "failed" : "canceled";
}

/**
 * Call after the query has checked the Activity's scope and visibility.
 */
export function activities_get_controls(activity: Doc<"activities">, userId: Id<"users">) {
	return {
		canStop:
			activity.visibility === "requester" &&
			activity.userId === userId &&
			activities_is_active(activity.status) &&
			activity.status !== "stopping",
		// A null total means the transfer stopped before it found all its files. Retry reuses that
		// partial list and never lists folders again, so it would make a partial folder copy.
		canRetry:
			activity.source.kind === "files_transfer_run" &&
			activity.userId === userId &&
			!activities_is_active(activity.status) &&
			activity.progress?.total != null &&
			(activity.progress?.failed ?? 0) + (activity.progress?.blocked ?? 0) + (activity.progress?.canceled ?? 0) > 0,
		canDismiss: !activities_is_active(activity.status),
	};
}

export async function activities_db_start(
	ctx: MutationCtx,
	args: {
		organizationId: Doc<"activities">["organizationId"];
		workspaceId: Doc<"activities">["workspaceId"];
		userId: Doc<"activities">["userId"];
		membershipId?: Doc<"activities">["membershipId"];
		membershipLifetime?: Doc<"activities">["membershipLifetime"];
		source: Doc<"activities">["source"];
		title: Doc<"activities">["title"];
		targets: Doc<"activities">["targets"];
		visibility: Doc<"activities">["visibility"];
		feedVisible: boolean;
		status: "queued" | "running";
		resultKind: Doc<"activities">["resultKind"];
		progress?: Doc<"activities">["progress"];
		deadlineAt: number;
		now: number;
	},
) {
	return await ctx.db.insert("activities", {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		userId: args.userId,
		membershipId: args.membershipId,
		membershipLifetime: args.membershipLifetime,
		status: args.status,
		visibility: args.visibility,
		feedVisible: args.feedVisible,
		source: args.source,
		title: args.title,
		resultKind: args.resultKind,
		progress: args.progress,
		errorMessage: null,
		targets: args.targets,
		deadlineAt: args.deadlineAt,
		startedAt: args.status === "running" ? args.now : undefined,
		updatedAt: args.now,
	});
}

export async function activities_db_get_by_source_id(
	ctx: QueryCtx | MutationCtx,
	sourceId: Doc<"activities">["source"]["id"],
) {
	return await ctx.db
		.query("activities")
		.withIndex("by_source_id", (q) => q.eq("source.id", sourceId))
		.unique();
}

export async function activities_db_require_by_source_id(
	ctx: QueryCtx | MutationCtx,
	sourceId: Doc<"activities">["source"]["id"],
) {
	const activity = await activities_db_get_by_source_id(ctx, sourceId);
	if (!activity) {
		const errorMessage = "Job points to a missing activities doc";
		const errorData = { sourceId };
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}
	return activity;
}

/**
 * Delete viewer state in bounded passes before releasing the producer's history.
 */
export async function activities_db_delete(ctx: MutationCtx, activityId: Id<"activities">) {
	const states = await ctx.db
		.query("activities_user_states")
		.withIndex("by_activity", (q) => q.eq("activityId", activityId))
		.take(50);
	await Promise.all(states.map((state) => ctx.db.delete("activities_user_states", state._id)));
	if (states.length === 50) return { done: false, deletedCount: states.length };
	await ctx.db.delete("activities", activityId);
	return { done: true, deletedCount: states.length + 1 };
}

export async function activities_db_finish(
	ctx: MutationCtx,
	args: {
		sourceId: Doc<"activities">["source"]["id"];
		status: "succeeded" | "partial" | "failed" | "canceled" | "timed_out";
		errorMessage: Doc<"activities">["errorMessage"];
		errorCode?: string;
		now: number;
	},
) {
	const activity = await activities_db_get_by_source_id(ctx, args.sourceId);
	if (!activity || !activities_is_active(activity.status)) {
		return;
	}
	await ctx.db.patch("activities", activity._id, {
		status: args.status,
		errorMessage: args.errorMessage,
		errorCode: args.errorCode,
		finishedAt: args.now,
		expiresAt: args.now + (activity.source.kind === "plugin_run" ? 30 : 7) * 24 * 60 * 60 * 1000,
		updatedAt: args.now,
	});
}

export async function activities_db_add_target(
	ctx: MutationCtx,
	args: {
		sourceId: Doc<"activities">["source"]["id"];
		target: Doc<"activities">["targets"][number];
		now: number;
	},
) {
	const activity = await activities_db_get_by_source_id(ctx, args.sourceId);
	if (!activity || !activities_is_active(activity.status)) {
		return;
	}

	// A `touch` and the write that follows it name the same file. Keep the target list free of
	// duplicates, and still bump `updatedAt` so the repeated call advances the job.
	await ctx.db.patch("activities", activity._id, {
		targets:
			activity.targets.length < 20 && !activity.targets.some((target) => target.id === args.target.id)
				? [...activity.targets, args.target]
				: activity.targets,
		updatedAt: args.now,
	});
}
