// Producers own the work. Activities own its lifecycle. Both change in one transaction.

import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v } from "convex/values";
import { doc } from "convex-helpers/validators";
import type { Doc, Id } from "./_generated/dataModel.js";
import { internal } from "./_generated/api.js";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import { activities_get_controls, activities_is_active } from "./activities_db.ts";
import { files_transfer_db_delete_run_batch, files_transfer_db_request_stop } from "./files_transfer.ts";
import {
	files_pending_update_runs_db_delete_run_batch,
	files_pending_update_runs_db_request_stop,
} from "./files_pending_update_runs.ts";
import { plugins_runtime_db_delete_run_history, plugins_runtime_db_timeout_run } from "./plugins_runtime.ts";
import { organizations_db_get_membership } from "./organizations.ts";
import {
	access_control_db_authorize_membership,
	access_control_db_filter_readable_file_nodes,
} from "./access_control.ts";
import app_convex_schema from "./schema.ts";
import { convex_error, v_result } from "../server/convex-utils.ts";
import { server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";
import { should_never_happen } from "../shared/shared-utils.ts";
import { Result } from "common/errors-as-values-utils.ts";

// Make Convex reuse the loaded module between calls, so warm calls skip the module load cost.
// Does NOT work for http actions (see http.ts). No mutable module-level state allowed here.
export const experimental_reuseContext = true;

/**
 * Each page bounds both the scan and its access checks.
 */
const ACTIVITIES_LIST_MAX = 50;

/**
 * Keep only the activities the user may see.
 *
 * Plugin activities follow file access. Those with no named file require workspace read.
 * Transfer activities contain no file paths and are visible only to their requester.
 *
 * Every read and dismiss uses the same checks, including pages consumed by hidden entries.
 */
async function db_filter_visible_activities(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Doc<"activities">["organizationId"];
		workspaceId: Doc<"activities">["workspaceId"];
		userId: Id<"users">;
		activities: readonly Doc<"activities">[];
		/**
		 * Whether the caller proved workspace-wide `content.read`.
		 */
		hasWorkspaceRead: boolean;
	},
) {
	// Each node named on the page is looked up once, and the filter answers once per restricted scope.
	const candidates = args.activities.filter(
		(activity) => activity.feedVisible && (activity.visibility !== "requester" || activity.userId === args.userId),
	);
	const targetNodeIds = [...new Set(candidates.flatMap((activity) => activity.targets.map((target) => target.id)))];
	if (targetNodeIds.length === 0) {
		return candidates.filter((activity) => activity.visibility === "requester" || args.hasWorkspaceRead);
	}

	const targetNodes = (await Promise.all(targetNodeIds.map((nodeId) => ctx.db.get("files_nodes", nodeId)))).filter(
		(fileNode) => fileNode !== null,
	);
	const targetNodeById = new Map(targetNodes.map((fileNode) => [fileNode._id, fileNode] as const));
	const readableNodeIds = new Set(
		(
			await access_control_db_filter_readable_file_nodes(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				userId: args.userId,
				nodes: targetNodes,
				hasWorkspaceRead: args.hasWorkspaceRead,
			})
		).map((fileNode) => fileNode._id),
	);

	return candidates.filter((activity) => {
		// Transfer activities belong to their requester and contain no file names or paths.
		if (activity.visibility === "requester") return true;

		// Hidden plugin work can start without a file, but feed opt-in still requires one.
		if (activity.targets.length === 0) {
			return args.hasWorkspaceRead;
		}

		// One hidden or moved file is enough to drop the whole activity. The stored path, title, target
		// message, and error belong to the old location, so current access cannot make them safe to show.
		return activity.targets.every(
			(target) => readableNodeIds.has(target.id) && targetNodeById.get(target.id)?.path === target.path,
		);
	});
}

async function db_list_visible_page(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
		hasWorkspaceRead: boolean;
		section: "active" | "history";
		paginationOpts: { cursor: string | null; numItems: number };
	},
) {
	const page = await ctx.db
		.query("activities")
		.withIndex("by_organization_workspace_feedVisible_finishedAt_updatedAt", (q) => {
			const scope = q
				.eq("organizationId", args.organizationId)
				.eq("workspaceId", args.workspaceId)
				.eq("feedVisible", true);
			return args.section === "active" ? scope.eq("finishedAt", undefined) : scope.gt("finishedAt", undefined);
		})
		.order("desc")
		.paginate({ ...args.paginationOpts, numItems: Math.min(ACTIVITIES_LIST_MAX, args.paginationOpts.numItems) });
	const visible = await db_filter_visible_activities(ctx, { ...args, activities: page.page });
	const states = await Promise.all(
		visible.map((activity) =>
			ctx.db
				.query("activities_user_states")
				.withIndex("by_user_activity", (q) => q.eq("userId", args.userId).eq("activityId", activity._id))
				.unique(),
		),
	);
	return {
		...page,
		page: visible
			.filter((_activity, index) => states[index] === null)
			.map((activity) => ({
				...activity,
				controls: activities_get_controls(activity, args.userId),
			})),
	};
}

export const list_page = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		section: v.union(v.literal("active"), v.literal("history")),
		paginationOpts: paginationOptsValidator,
	},
	returns: paginationResultValidator(
		v.object({
			...doc(app_convex_schema, "activities").fields,
			controls: v.object({
				canStop: v.boolean(),
				canRetry: v.boolean(),
				canDismiss: v.boolean(),
			}),
		}),
	),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) throw convex_error({ message: "Unauthenticated" });
		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) return { page: [], isDone: true, continueCursor: "" };
		const authorized = await access_control_db_authorize_membership(ctx, {
			userAuth,
			membership,
			permission: "content.read",
		});
		return await db_list_visible_page(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: userAuth.id,
			hasWorkspaceRead: !authorized._nay,
			section: args.section,
			paginationOpts: args.paginationOpts,
		});
	},
});

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
			case "plugin_run":
				return Result({ _nay: { message: "This activity cannot be stopped" } });
			default:
				throw should_never_happen("Unknown Activity source", activity.source satisfies never);
		}
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
		const [visible] = await db_filter_visible_activities(ctx, {
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
		const page = await db_list_visible_page(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: userAuth.id,
			hasWorkspaceRead: !authorized._nay,
			section: "history",
			paginationOpts: { cursor: args.cursor, numItems: ACTIVITIES_LIST_MAX },
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
		for (const activity of activities) {
			switch (activity.source.kind) {
				case "files_pending_update_run": {
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
				default:
					throw should_never_happen("Unknown Activity source", activity.source satisfies never);
			}
		}
		const processedCount = activities.length;
		const done = processedCount < batchSize;
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
		let pendingCleanup = false;

		for (const status of ["succeeded", "partial", "failed", "canceled", "timed_out"] as const) {
			if (processedCount >= batchSize || deletedCount >= 50) break;

			const activities = await ctx.db
				.query("activities")
				.withIndex("by_status_expiresAt", (q) => q.eq("status", status).gte("expiresAt", 0).lte("expiresAt", now))
				.take(batchSize - processedCount);

			for (const activity of activities) {
				if (deletedCount >= 50) {
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
					default:
						throw should_never_happen("Unknown Activity source", activity.source satisfies never);
				}

				deletedCount += deletion.deletedCount;
				pendingCleanup ||= !deletion.done;
				processedCount += 1;
			}
		}

		const done = processedCount < batchSize && deletedCount < 50 && !pendingCleanup;
		if (!done && !args._test_disableReschedule) {
			await ctx.scheduler.runAfter(0, internal.activities.cleanup_history, {
				batchSize: args.batchSize,
				_test_now: args._test_now,
			});
		}

		return { deletedCount, done };
	},
});
