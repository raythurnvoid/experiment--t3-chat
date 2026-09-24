// "Apply to contents" sets a folder's protection rule on every item inside it. A big folder does not
// fit in one mutation, so a background job walks the folder in path order, a few items per step.

import { v } from "convex/values";
import { doc } from "convex-helpers/validators";
import { Result } from "common/errors-as-values-utils.ts";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { internalMutation, mutation, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import {
	access_control_db_authorize_membership,
	access_control_db_filter_readable_file_nodes,
} from "./access_control.ts";
import {
	activities_db_delete,
	activities_db_finish,
	activities_db_require_by_source_id,
	activities_db_start,
	activities_get_result_status,
	activities_is_active,
} from "./activities_db.ts";
import { files_media_validation_db_advance_version } from "./files_media_validation.ts";
import {
	files_nodes_db_authorize_write_policy_management,
	files_nodes_db_require_write_policy_management,
	type files_nodes_WriteContext,
} from "./files_nodes.ts";
import { organizations_db_get_membership } from "./organizations.ts";
import {
	organizations_membership_lifetimes_db_ensure,
	organizations_membership_lifetimes_db_get,
} from "./organizations_membership_lifetimes.ts";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";
import app_convex_schema from "./schema.ts";
import { v_result } from "../server/convex-utils.ts";
import { path_tree_prefix_upper_bound, server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";
import { should_never_happen } from "../shared/shared-utils.ts";

// Make Convex reuse the loaded module between calls, so warm calls skip the module load cost.
// Does NOT work for http actions (see http.ts). No mutable module-level state allowed here.
export const experimental_reuseContext = true;

/**
 * A step ends after this many counted items. The requester sees progress live, so every step must
 * count the same number of items whatever is hidden. Otherwise the gaps would count hidden items.
 */
const STEP_MAX_COUNTED = 50;

/**
 * A step also ends after this many checked items, so a long run of hidden items stays inside one
 * mutation's read limits.
 */
const STEP_MAX_CHECKED = 200;

/**
 * A step also ends after reading this many nodes. The contents of a hidden folder are read but not
 * checked, so the check limit alone does not limit the reads.
 */
const STEP_MAX_READ = 1_000;

const PAGE_SIZE = 50;
const RUN_TIMEOUT_MS = 30 * 60 * 1000;

async function db_require_activity(ctx: QueryCtx | MutationCtx, runId: Id<"files_write_policy_runs">) {
	const activity = await activities_db_require_by_source_id(ctx, runId);
	if (!activity.progress || !activity.membershipId || activity.membershipLifetime === undefined) {
		const errorMessage = "Protection activity is missing progress or membership";
		const errorData = { runId, activityId: activity._id };
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}
	return {
		...activity,
		progress: activity.progress,
		membershipId: activity.membershipId,
		membershipLifetime: activity.membershipLifetime,
	};
}

/**
 * Recheck the membership the job started with. A leave and re-join gives a new lifetime, so it stops
 * the job even though the person is a member again.
 */
async function db_get_run_membership(
	ctx: QueryCtx | MutationCtx,
	run: Doc<"files_write_policy_runs">,
	activity: Awaited<ReturnType<typeof db_require_activity>>,
) {
	const user = await ctx.db.get("users", run.userId);
	if (!user || user.deletedAt !== undefined) return null;

	const workspace = await ctx.db.get("organizations_workspaces", run.workspaceId);
	if (!workspace || workspace.organizationId !== run.organizationId || workspace.pluginDataPurgeStartedAt !== undefined)
		return null;

	const lifetime = await organizations_membership_lifetimes_db_get(ctx, {
		workspaceId: run.workspaceId,
		userId: run.userId,
	});
	if (
		!lifetime?.active ||
		lifetime.membershipId !== activity.membershipId ||
		lifetime.lifetime !== activity.membershipLifetime
	)
		return null;

	return await organizations_db_get_membership(ctx, { userId: run.userId, membershipId: activity.membershipId });
}

/**
 * Add the counts that earlier steps kept on the run (`unpublishedProgress`) to the Activity progress.
 */
function with_unpublished_progress(
	progress: Awaited<ReturnType<typeof db_require_activity>>["progress"],
	run: Doc<"files_write_policy_runs">,
) {
	const unpublished = run.unpublishedProgress ?? { completed: 0, skipped: 0, blocked: 0 };
	return {
		...progress,
		completed: progress.completed + unpublished.completed,
		skipped: progress.skipped + unpublished.skipped,
		blocked: progress.blocked + unpublished.blocked,
		discovered: progress.discovered + unpublished.completed + unpublished.skipped + unpublished.blocked,
	};
}

/**
 * Finish the job before its walk ends. First show the counts that earlier steps kept on the run, so
 * "Stopped. N items were updated." counts every item the job really updated.
 */
async function db_finish_run_early(
	ctx: MutationCtx,
	run: Doc<"files_write_policy_runs">,
	args: Omit<Parameters<typeof activities_db_finish>[1], "sourceId">,
) {
	const activity = await db_require_activity(ctx, run._id);
	if (!activities_is_active(activity.status)) return;

	await ctx.db.patch("activities", activity._id, { progress: with_unpublished_progress(activity.progress, run) });
	await activities_db_finish(ctx, { sourceId: run._id, ...args });
}

async function db_fail_run(ctx: MutationCtx, run: Doc<"files_write_policy_runs">, errorMessage: string, now: number) {
	await db_finish_run_early(ctx, run, { status: "failed", errorMessage, errorCode: "failed", now });
}

/**
 * Finish the job at once. It has no worker to wait for, so it never stays in `stopping`.
 * Items already updated keep the new rule.
 */
export async function files_write_policy_runs_db_request_stop(
	ctx: MutationCtx,
	args: { runId: Id<"files_write_policy_runs">; reason: "user" | "timeout"; now: number },
) {
	const run = await ctx.db.get("files_write_policy_runs", args.runId);
	if (!run) return;

	await db_finish_run_early(ctx, run, {
		status: args.reason === "timeout" ? "timed_out" : "canceled",
		errorMessage: args.reason === "timeout" ? "The protection update reached its time limit." : null,
		errorCode: args.reason === "timeout" ? "timed_out" : "canceled",
		now: args.now,
	});
}

export const start = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
		writePolicy: doc(app_convex_schema, "files_nodes").fields.writePolicy,
	},
	returns: v_result({ _yay: v.object({ activityId: v.id("activities") }) }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "files_tree_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const authorized = await files_nodes_db_authorize_write_policy_management(ctx, {
			userAuth,
			membershipId: args.membershipId,
			nodeId: args.nodeId,
		});
		if (authorized._nay) {
			return authorized;
		}
		const { membership, node: folder } = authorized._yay;
		if (folder.kind !== "folder") {
			return Result({ _nay: { message: "Only folders have contents to update." } });
		}

		// A data-only reset keeps the members while it deletes the workspace files. Start no job then.
		const workspace = await ctx.db.get("organizations_workspaces", membership.workspaceId);
		if (!workspace || workspace.pluginDataPurgeStartedAt !== undefined) {
			return Result({ _nay: { message: "Permission denied" } });
		}

		// The new rule itself needs one writer check, on the folder being confirmed.
		const writerAllowed = await files_nodes_db_require_write_policy_management(ctx, {
			organizationId: folder.organizationId,
			workspaceId: folder.workspaceId,
			writeContext: {
				writer: { kind: "user", userId: userAuth.id },
				actorUserId: userAuth.id,
				resourceScope: { kind: "workspace" },
				policyReach: "ancestors",
			},
			target: { kind: "node", node: folder },
			writePolicy: args.writePolicy,
		});
		if (writerAllowed._nay) {
			return writerAllowed;
		}

		// One job per person and workspace. It bounds what one rate-limit token can start.
		for (const status of ["queued", "running"] as const) {
			const active = await ctx.db
				.query("activities")
				.withIndex("by_user_workspace_source_kind_status", (q) =>
					q
						.eq("userId", userAuth.id)
						.eq("workspaceId", membership.workspaceId)
						.eq("source.kind", "files_write_policy_run")
						.eq("status", status),
				)
				.first();
			if (active) {
				return Result({ _nay: { name: "busy", message: "Another protection update is still running." } });
			}
		}

		const now = Date.now();
		const runId = await ctx.db.insert("files_write_policy_runs", {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: userAuth.id,
			folderId: folder._id,
			folderTreePath: folder.treePath,
			writePolicy: args.writePolicy,
			cursor: null,
		});
		// Keep targets empty. The Activity must not name the folder or anything inside it.
		const activityId = await activities_db_start(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: userAuth.id,
			membershipId: membership._id,
			membershipLifetime: await organizations_membership_lifetimes_db_ensure(ctx, membership),
			source: { kind: "files_write_policy_run", id: runId },
			title: "Apply protection to folder contents",
			targets: [],
			visibility: "requester",
			feedVisible: true,
			status: "queued",
			resultKind: "saved",
			progress: {
				unit: "items",
				discovered: 0,
				total: null,
				completed: 0,
				skipped: 0,
				failed: 0,
				blocked: 0,
				canceled: 0,
			},
			deadlineAt: now + RUN_TIMEOUT_MS,
			now,
		});
		await ctx.scheduler.runAfter(0, internal.files_write_policy_runs.advance, { runId });

		return Result({ _yay: { activityId } });
	},
});

export const advance = internalMutation({
	args: { runId: v.id("files_write_policy_runs") },
	returns: v.null(),
	handler: async (ctx, args) => {
		const run = await ctx.db.get("files_write_policy_runs", args.runId);
		if (!run) return null;

		// Stop and the deadline finish the Activity. A step scheduled before that does nothing.
		const activity = await db_require_activity(ctx, run._id);
		if (!activities_is_active(activity.status)) return null;
		const now = Date.now();
		if (activity.deadlineAt <= now) {
			await files_write_policy_runs_db_request_stop(ctx, { runId: run._id, reason: "timeout", now });
			return null;
		}

		// Check again every step. Items updated before a failed check keep the new rule.
		const membership = await db_get_run_membership(ctx, run, activity);
		if (!membership) {
			await db_fail_run(ctx, run, "You can no longer change this folder's protection.", now);
			return null;
		}
		const folder = await ctx.db.get("files_nodes", run.folderId);
		if (!folder || folder.archiveOperationId !== null || folder.treePath !== run.folderTreePath) {
			await db_fail_run(ctx, run, "The folder moved or was archived during the update. Run it again.", now);
			return null;
		}
		const writeContext: files_nodes_WriteContext = {
			writer: { kind: "user", userId: run.userId },
			actorUserId: run.userId,
			resourceScope: { kind: "workspace" },
			policyReach: "ancestors",
		};
		const folderManaged = await files_nodes_db_require_write_policy_management(ctx, {
			organizationId: run.organizationId,
			workspaceId: run.workspaceId,
			writeContext,
			target: { kind: "node", node: folder },
			writePolicy: run.writePolicy,
		});
		if (folderManaged._nay) {
			await db_fail_run(ctx, run, "You can no longer change this folder's protection.", now);
			return null;
		}

		if (activity.status === "queued") {
			await ctx.db.patch("activities", activity._id, {
				status: "running",
				startedAt: now,
				deadlineAt: now + RUN_TIMEOUT_MS,
				updatedAt: now,
			});
		}

		// A member whose role gives no workspace read can still read the folders shared with them.
		const workspaceRead = await access_control_db_authorize_membership(ctx, {
			userAuth: { id: run.userId },
			membership,
			permission: "content.read",
		});

		// Carry the counts that earlier steps did not show yet, so this step fills them up to 50.
		const progress = with_unpublished_progress(activity.progress, run);
		let cursor = run.cursor;
		let readCount = 0;
		let checkedCount = 0;
		// Start with the items that earlier steps counted but did not show.
		let countedCount = progress.discovered - activity.progress.discovered;
		let isUpdated = false;
		let isFolderDone = false;
		while (
			!isFolderDone &&
			countedCount < STEP_MAX_COUNTED &&
			checkedCount < STEP_MAX_CHECKED &&
			readCount < STEP_MAX_READ
		) {
			// Active nodes inside the folder, in path order. Archived items keep their rules.
			const pageCursor = cursor;
			const page = await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_archiveOperation_treePath", (q) => {
					const scope = q
						.eq("organizationId", run.organizationId)
						.eq("workspaceId", run.workspaceId)
						.eq("archiveOperationId", null);
					const lower =
						pageCursor === null
							? scope.gt("treePath", run.folderTreePath)
							: pageCursor.inclusive
								? scope.gte("treePath", pageCursor.treePath)
								: scope.gt("treePath", pageCursor.treePath);
					return lower.lt("treePath", path_tree_prefix_upper_bound(run.folderTreePath));
				})
				.take(PAGE_SIZE);
			readCount += page.length;
			isFolderDone = page.length === 0;

			// The hidden folder whose contents the rest of this page skips.
			let hiddenFolderTreePath: string | null = null;
			for (const node of page) {
				if (hiddenFolderTreePath !== null && node.treePath.startsWith(hiddenFolderTreePath)) continue;
				if (countedCount >= STEP_MAX_COUNTED || checkedCount >= STEP_MAX_CHECKED) break;
				checkedCount += 1;
				cursor = { treePath: node.treePath, inclusive: false };

				const managed = await files_nodes_db_require_write_policy_management(ctx, {
					organizationId: run.organizationId,
					workspaceId: run.workspaceId,
					writeContext,
					target: { kind: "node", node },
					writePolicy: run.writePolicy,
				});
				// An item the person can manage but not read is still updated, like any managed item.
				if (!managed._nay) {
					if (JSON.stringify(node.writePolicy) === JSON.stringify(run.writePolicy)) {
						progress.skipped += 1;
					} else {
						await ctx.db.patch("files_nodes", node._id, { writePolicy: run.writePolicy });
						progress.completed += 1;
						isUpdated = true;
					}
					progress.discovered += 1;
					countedCount += 1;
					continue;
				}

				// Count an item the person can see but not manage. Walk on into a folder like that:
				// items inside it may have their own grant.
				const [readable] = await access_control_db_filter_readable_file_nodes(ctx, {
					organizationId: run.organizationId,
					workspaceId: run.workspaceId,
					userId: run.userId,
					nodes: [node],
					hasWorkspaceRead: !workspaceRead._nay,
				});
				if (readable) {
					progress.blocked += 1;
					progress.discovered += 1;
					countedCount += 1;
					continue;
				}

				// Never count or name a hidden item. Skip a hidden folder with everything inside it, like
				// `chmod -R` skips a folder it cannot read. Its contents come right after it in path order.
				// So skip them in this page, and let the next page start at the first path after them.
				// Only a folder's `treePath` ends with "/", so this never skips the siblings of a hidden file.
				if (node.kind === "folder") {
					hiddenFolderTreePath = node.treePath;
					cursor = { treePath: path_tree_prefix_upper_bound(node.treePath), inclusive: true };
				}
			}
		}

		if (isUpdated) {
			await files_media_validation_db_advance_version(ctx, run);
		}

		if (isFolderDone) {
			await ctx.db.patch("activities", activity._id, { progress: { ...progress, total: progress.discovered } });
			await activities_db_finish(ctx, {
				sourceId: run._id,
				status: activities_get_result_status(progress),
				errorMessage: null,
				now,
			});
			return null;
		}

		// A step that ended before 50 counted items stopped at the check or read limit, so it passed hidden
		// items. Keep its counts on the run and leave the Activity as it is. Otherwise the progress or
		// the times would show how many hidden items the step passed.
		if (countedCount < STEP_MAX_COUNTED) {
			await ctx.db.patch("files_write_policy_runs", run._id, {
				cursor,
				unpublishedProgress: {
					completed: progress.completed - activity.progress.completed,
					skipped: progress.skipped - activity.progress.skipped,
					blocked: progress.blocked - activity.progress.blocked,
				},
			});
		} else {
			await ctx.db.patch("files_write_policy_runs", run._id, { cursor, unpublishedProgress: undefined });
			await ctx.db.patch("activities", activity._id, {
				progress,
				deadlineAt: now + RUN_TIMEOUT_MS,
				updatedAt: now,
			});
		}
		await ctx.scheduler.runAfter(0, internal.files_write_policy_runs.advance, args);
		return null;
	},
});

/**
 * Deletion callers drain this before deleting memberships and files. History cleanup calls it too.
 */
export async function files_write_policy_runs_db_delete_run_batch(
	ctx: MutationCtx,
	args: { runId: Id<"files_write_policy_runs"> },
) {
	const run = await ctx.db.get("files_write_policy_runs", args.runId);
	if (!run) return { done: true, deletedCount: 0 };

	// Stop first, so a step that is already scheduled writes nothing.
	await files_write_policy_runs_db_request_stop(ctx, { runId: run._id, reason: "user", now: Date.now() });
	const activity = await activities_db_require_by_source_id(ctx, run._id);
	const deletedActivity = await activities_db_delete(ctx, activity._id);
	if (!deletedActivity.done) return deletedActivity;

	await ctx.db.delete("files_write_policy_runs", run._id);
	return { done: true, deletedCount: deletedActivity.deletedCount + 1 };
}
