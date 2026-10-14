// Producers own the work. Activities own its lifecycle. Both change in one transaction.

import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel.js";
import { internal } from "./_generated/api.js";
import type { MutationCtx } from "./_generated/server.js";
import { internalMutation, mutation } from "./functions.ts";
import {
	activities_feed_LIST_MAX,
	activities_feed_db_filter_visible,
	activities_feed_db_list_visible_page,
} from "./activities_feed.ts";
import { activities_db_delete, activities_get_controls, activities_is_active } from "./activities_db.ts";
import { ai_chat_files_db_delete_job_batch, ai_chat_files_db_request_job_stop } from "./ai_chat_files.ts";
import { files_transfer_db_delete_run_batch, files_transfer_db_request_stop } from "./files_transfer.ts";
import {
	files_pending_update_runs_db_delete_run_batch,
	files_pending_update_runs_db_request_stop,
	files_pending_update_runs_db_resume_parked,
} from "./files_pending_update_runs.ts";
import {
	files_write_policy_runs_db_delete_run_batch,
	files_write_policy_runs_db_request_stop,
} from "./files_write_policy_runs.ts";
import { files_archive_runs_db_delete_run_batch, files_archive_runs_db_request_stop } from "./files_archive_runs.ts";
import { files_subtree_ops_db_recover, files_subtree_ops_RECOVER_AFTER_MS } from "./files_subtree_ops.ts";
import { files_move_cohorts_db_retry_repair_now } from "./files_move_cohorts.ts";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";
import { plugins_runtime_db_delete_run_history, plugins_runtime_db_timeout_run } from "./plugins_runtime.ts";
import { organizations_db_get_membership } from "./organizations_memberships_db.ts";
import { access_control_db_authorize_membership } from "./access_control.ts";
import { v_result } from "../server/convex-utils.ts";
import { server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";
import { should_never_happen } from "../shared/shared-utils.ts";
import { files_MOVE_REPAIR_STUCK_CODE } from "../shared/files.ts";
import { files_move_reservations_db_pause_worker } from "../server/files-move-reservations.ts";
import { Result } from "common/errors-as-values-utils.ts";

// Make Convex reuse the loaded module between calls, so warm calls skip the module load cost.
// Does NOT work for http actions (see http.ts). No mutable module-level state allowed here.
export const experimental_reuseContext = true;

/**
 * A Bash job row can hold a 700 KiB result, and a row's size is unknown until it is read. The
 * cron passes read at most this many job rows each, and reschedule for the rest.
 */
const ACTIVITIES_BASH_JOB_ROWS_MAX = 8;

/**
 * A review or folder protection run waiting for a Move gets this much time again at each sweep.
 */
const MOVE_WAIT_DEADLINE_MS = 30 * 60 * 1000;

export const request_stop = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		activityId: v.id("activities"),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) return Result({ _nay: { message: "Unauthenticated" } });
		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) return Result({ _nay: { message: "Unauthorized" } });
		const activity = await ctx.db.get("activities", args.activityId);
		if (
			!activity ||
			activity.organizationId !== membership.organizationId ||
			activity.workspaceId !== membership.workspaceId ||
			activity.visibility !== "requester" ||
			activity.userId !== userAuth.id ||
			!activity.feedVisible
		) {
			return Result({ _nay: { message: "Activity not found" } });
		}
		// A repeated Stop remains successful after the first request has settled.
		if (!activities_is_active(activity.status) || activity.status === "stopping") return Result({ _yay: null });
		// Archive, move, and restrict have no Stop. A restore has Stop only while it waits for a clash choice.
		if (!activities_get_controls(activity, userAuth.id).canStop) {
			return Result({ _nay: { message: "This activity cannot be stopped" } });
		}
		switch (activity.source.kind) {
			case "files_pending_update_run": {
				await files_pending_update_runs_db_request_stop(ctx, {
					runId: activity.source.id,
					reason: "user",
					now: Date.now(),
				});
				break;
			}
			case "files_transfer_run": {
				await files_transfer_db_request_stop(ctx, { runId: activity.source.id, reason: "user", now: Date.now() });
				break;
			}
			case "files_write_policy_run": {
				await files_write_policy_runs_db_request_stop(ctx, {
					runId: activity.source.id,
					reason: "user",
					now: Date.now(),
				});
				break;
			}
			case "files_archive_run": {
				await files_archive_runs_db_request_stop(ctx, {
					runId: activity.source.id,
					reason: "user",
					now: Date.now(),
				});
				break;
			}
			case "ai_chat_bash_job": {
				await ai_chat_files_db_request_job_stop(ctx, {
					invocationId: activity.source.id,
					reason: "user",
					now: Date.now(),
				});
				break;
			}
			case "plugin_run":
			case "files_subtree_op":
				return Result({ _nay: { message: "This activity cannot be stopped" } });
			default:
				throw should_never_happen("Unknown Activity source", activity.source satisfies never);
		}
		return Result({ _yay: null });
	},
});

/**
 * "Try again now" on a Move whose repair keeps failing. Only the person who started it can use it.
 */
export const retry_move_repair = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		activityId: v.id("activities"),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) return Result({ _nay: { message: "Unauthenticated" } });
		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) return Result({ _nay: { message: "Unauthorized" } });
		const activity = await ctx.db.get("activities", args.activityId);
		if (
			!activity ||
			activity.organizationId !== membership.organizationId ||
			activity.workspaceId !== membership.workspaceId ||
			activity.visibility !== "requester" ||
			activity.userId !== userAuth.id ||
			!activity.feedVisible ||
			(activity.source.kind !== "files_transfer_run" && activity.source.kind !== "files_pending_update_run")
		) {
			return Result({ _nay: { message: "Activity not found" } });
		}
		// The repair already went on, or the Move ended.
		if (activity.errorCode !== files_MOVE_REPAIR_STUCK_CODE) return Result({ _yay: null });
		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "files_tree_write", key: userAuth.id });
		if (rateLimit) return Result({ _nay: { message: rateLimit.message } });
		// A run has one group at a time, and it is the newest one.
		const runId = activity.source.id;
		const cohort = await ctx.db
			.query("files_move_cohorts")
			.withIndex("by_origin_run", (q) =>
				q
					.eq("origin.kind", activity.source.kind === "files_transfer_run" ? "transfer" : "review")
					.eq("origin.runId", runId),
			)
			.order("desc")
			.first();
		if (cohort) await files_move_cohorts_db_retry_repair_now(ctx, cohort);
		return Result({ _yay: null });
	},
});

export const archive_activity = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		activityId: v.id("activities"),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) return Result({ _nay: { message: "Unauthenticated" } });
		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) return Result({ _nay: { message: "Unauthorized" } });
		const activity = await ctx.db.get("activities", args.activityId);
		if (
			!activity ||
			activity.organizationId !== membership.organizationId ||
			activity.workspaceId !== membership.workspaceId
		) {
			return Result({ _nay: { message: "Activity not found" } });
		}
		const authorized = await access_control_db_authorize_membership(ctx, {
			userAuth,
			membership,
			permission: "content.read",
		});
		const [visible] = await activities_feed_db_filter_visible(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: userAuth.id,
			activities: [activity],
			hasWorkspaceRead: !authorized._nay,
		});
		if (!visible) return Result({ _nay: { message: "Activity not found" } });
		if (activities_is_active(activity.status)) return Result({ _nay: { message: "Activity is still running" } });
		const state = await ctx.db
			.query("activities_user_states")
			.withIndex("by_user_activity", (q) => q.eq("userId", userAuth.id).eq("activityId", activity._id))
			.unique();
		if (!state) {
			await ctx.db.insert("activities_user_states", {
				userId: userAuth.id,
				activityId: activity._id,
				dismissedAt: Date.now(),
			});
		}
		return Result({ _yay: null });
	},
});

export const archive_all_activities = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		cursor: v.union(v.string(), v.null()),
	},
	returns: v_result({
		_yay: v.object({ count: v.number(), isDone: v.boolean(), continueCursor: v.string() }),
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) return Result({ _nay: { message: "Unauthenticated" } });
		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) return Result({ _nay: { message: "Unauthorized" } });
		const authorized = await access_control_db_authorize_membership(ctx, {
			userAuth,
			membership,
			permission: "content.read",
		});
		const page = await activities_feed_db_list_visible_page(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: userAuth.id,
			hasWorkspaceRead: !authorized._nay,
			section: "history",
			paginationOpts: { cursor: args.cursor, numItems: activities_feed_LIST_MAX },
		});
		const now = Date.now();
		await Promise.all(
			page.page.map((activity) =>
				ctx.db.insert("activities_user_states", {
					userId: userAuth.id,
					activityId: activity._id,
					dismissedAt: now,
				}),
			),
		);
		return Result({ _yay: { count: page.page.length, isDone: page.isDone, continueCursor: page.continueCursor } });
	},
});

/**
 * A run that waits for a Move has no live step, and the Move's release wakes it. While it waits, its
 * deadline only moves, like a subtree op's. A long Move cannot make it time out. If the Move already
 * ended, its wake was lost: resume the run here, like the wake does.
 */
async function db_keep_move_waiter(
	ctx: MutationCtx,
	activity: Doc<"activities">,
	worker:
		| { kind: "review"; id: Id<"files_pending_update_runs"> }
		| { kind: "write_policy"; id: Id<"files_write_policy_runs"> },
	now: number,
) {
	const waiter = await ctx.db
		.query("files_move_waiters")
		.withIndex("by_worker", (q) => q.eq("worker.kind", worker.kind).eq("worker.id", worker.id))
		.unique();
	if (!waiter) return false;
	// This deletes the waiter doc when no Move holds the workspace.
	if (
		await files_move_reservations_db_pause_worker(ctx, { worker: waiter.worker, check: { wholeWorkspace: activity } })
	)
		await ctx.db.patch("activities", activity._id, { deadlineAt: now + MOVE_WAIT_DEADLINE_MS });
	else if (waiter.worker.kind === "review")
		await files_pending_update_runs_db_resume_parked(ctx, { runId: waiter.worker.id, fence: waiter.worker.fence });
	else if (worker.kind === "write_policy") {
		// Move the passed deadline first. The step stops a run whose deadline passed.
		await ctx.db.patch("activities", activity._id, { updatedAt: now, deadlineAt: now + MOVE_WAIT_DEADLINE_MS });
		await ctx.scheduler.runAfter(0, internal.files_write_policy_runs.advance, { runId: worker.id });
	}
	return true;
}

/**
 * Producers fence their own writes before finishing an expired Activity.
 */
export const recover_expired = internalMutation({
	args: {
		_test_now: v.optional(v.number()),
		batchSize: v.optional(v.number()),
		_test_disableReschedule: v.optional(v.boolean()),
	},
	returns: v.object({ processedCount: v.number(), done: v.boolean() }),
	handler: async (ctx, args) => {
		const now = args._test_now ?? Date.now();
		const batchSize = Math.max(1, Math.min(args.batchSize ?? 50, 50));
		const activities: Doc<"activities">[] = [];
		// Read the page before dispatch: a queued transfer can become stopping in this mutation.
		for (const status of ["queued", "running", "awaiting_input", "stopping"] as const) {
			if (activities.length >= batchSize) break;
			activities.push(
				...(await ctx.db
					.query("activities")
					.withIndex("by_status_deadlineAt", (q) => q.eq("status", status).lte("deadlineAt", now))
					.take(batchSize - activities.length)),
			);
		}
		let processedCount = 0;
		let bashJobCount = 0;
		let deferred = false;
		for (const activity of activities) {
			// Job rows past the cap wait for the reschedule.
			if (activity.source.kind === "ai_chat_bash_job" && bashJobCount >= ACTIVITIES_BASH_JOB_ROWS_MAX) {
				deferred = true;
				continue;
			}
			switch (activity.source.kind) {
				case "files_pending_update_run": {
					if (await db_keep_move_waiter(ctx, activity, { kind: "review", id: activity.source.id }, now)) break;
					await files_pending_update_runs_db_request_stop(ctx, { runId: activity.source.id, reason: "timeout", now });
					break;
				}
				case "plugin_run": {
					await plugins_runtime_db_timeout_run(ctx, { runId: activity.source.id, now });
					break;
				}
				case "files_transfer_run": {
					await files_transfer_db_request_stop(ctx, { runId: activity.source.id, reason: "timeout", now });
					break;
				}
				case "files_write_policy_run": {
					if (await db_keep_move_waiter(ctx, activity, { kind: "write_policy", id: activity.source.id }, now)) break;
					await files_write_policy_runs_db_request_stop(ctx, { runId: activity.source.id, reason: "timeout", now });
					break;
				}
				case "files_archive_run": {
					await files_archive_runs_db_request_stop(ctx, { runId: activity.source.id, reason: "timeout", now });
					break;
				}
				// A move or scope op has no Stop. Its deadline only schedules the step again.
				case "files_subtree_op": {
					await ctx.db.patch("activities", activity._id, { deadlineAt: now + files_subtree_ops_RECOVER_AFTER_MS });
					await files_subtree_ops_db_recover(ctx, { opId: activity.source.id });
					break;
				}
				case "ai_chat_bash_job": {
					bashJobCount += 1;
					await ai_chat_files_db_request_job_stop(ctx, { invocationId: activity.source.id, reason: "timeout", now });
					break;
				}
				default:
					throw should_never_happen("Unknown Activity source", activity.source satisfies never);
			}
			processedCount += 1;
		}
		const done = processedCount < batchSize && !deferred;
		// Stopping work may still hold an upload lease. The next cron can retry it without a busy loop.
		if (!done && activities.some((activity) => activity.status !== "stopping") && !args._test_disableReschedule) {
			await ctx.scheduler.runAfter(0, internal.activities.recover_expired, {
				batchSize: args.batchSize,
				_test_now: args._test_now,
			});
		}
		return { processedCount, done };
	},
});

/**
 * Keep producer receipts until the producer and its viewer state can be deleted together.
 * Expiry means old enough to try; the producer still checks whether deletion is safe.
 */
export const cleanup_history = internalMutation({
	args: {
		_test_now: v.optional(v.number()),
		batchSize: v.optional(v.number()),
		_test_disableReschedule: v.optional(v.boolean()),
	},
	returns: v.object({ deletedCount: v.number(), done: v.boolean() }),
	handler: async (ctx, args) => {
		const now = args._test_now ?? Date.now();
		const batchSize = Math.max(1, Math.min(args.batchSize ?? 50, 50));
		let processedCount = 0;
		let deletedCount = 0;
		let bashJobCount = 0;
		let pendingCleanup = false;
		let reviewCleanupProgress = false;

		for (const status of ["succeeded", "partial", "failed", "canceled", "timed_out"] as const) {
			if (
				processedCount >= batchSize ||
				deletedCount >= 50 ||
				bashJobCount >= ACTIVITIES_BASH_JOB_ROWS_MAX ||
				reviewCleanupProgress
			) break;

			// A blocked Activity uses a slot too. A full blocked batch leaves later history for the next run.
			const activities = await ctx.db
				.query("activities")
				.withIndex("by_status_expiresAt", (q) => q.eq("status", status).gte("expiresAt", 0).lte("expiresAt", now))
				.take(batchSize - processedCount);

			for (const activity of activities) {
				if (deletedCount >= 50) {
					pendingCleanup = true;
					break;
				}
				// The arm cannot cap itself: it runs inside the loop over five statuses.
				if (activity.source.kind === "ai_chat_bash_job" && bashJobCount >= ACTIVITIES_BASH_JOB_ROWS_MAX) {
					pendingCleanup = true;
					break;
				}

				let deletion;
				switch (activity.source.kind) {
					case "files_pending_update_run": {
						deletion = await files_pending_update_runs_db_delete_run_batch(ctx, { runId: activity.source.id });
						break;
					}
					case "plugin_run": {
						deletion = await plugins_runtime_db_delete_run_history(ctx, {
							runId: activity.source.id,
							activityId: activity._id,
						});
						break;
					}
					case "files_transfer_run": {
						deletion = await files_transfer_db_delete_run_batch(ctx, { runId: activity.source.id, batchSize: 50 });
						break;
					}
					case "files_write_policy_run": {
						deletion = await files_write_policy_runs_db_delete_run_batch(ctx, { runId: activity.source.id });
						break;
					}
					case "files_archive_run": {
						deletion = await files_archive_runs_db_delete_run_batch(ctx, { runId: activity.source.id });
						break;
					}
					// The op row is deleted when its walk ends, so only the Activity is left.
					case "files_subtree_op": {
						deletion = await activities_db_delete(ctx, activity._id);
						break;
					}
					case "ai_chat_bash_job": {
						bashJobCount += 1;
						deletion = await ai_chat_files_db_delete_job_batch(ctx, {
							invocationId: activity.source.id,
							batchSize: 50,
						});
						break;
					}
					default:
						throw should_never_happen("Unknown Activity source", activity.source satisfies never);
				}

				deletedCount += deletion.deletedCount;
				pendingCleanup ||= !deletion.done;
				processedCount += 1;
				// Continue a Review's child cleanup in a new transaction before later histories.
				if (activity.source.kind === "files_pending_update_run" && !deletion.done && deletion.deletedCount > 0) {
					reviewCleanupProgress = true;
					break;
				}
			}
		}

		const done = processedCount < batchSize && deletedCount < 50 && !pendingCleanup;
		// A pass that deletes nothing waits for other work, such as a Retry copying its item list.
		// Keep expiry unchanged. The daily cron retries; once the block clears, cleanup can continue.
		if (!done && deletedCount > 0 && !args._test_disableReschedule) {
			await ctx.scheduler.runAfter(0, internal.activities.cleanup_history, {
				batchSize: args.batchSize,
				_test_now: args._test_now,
			});
		}

		return { deletedCount, done };
	},
});

// Keep loaded clients working until the new feed query reaches them.
export { list_page } from "./activities_feed.ts";
