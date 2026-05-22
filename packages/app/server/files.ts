/**
 * Server-side file helpers for files.
 *
 * This module runs in the Convex runtime and must NOT import from:
 * - src/ (client code)
 * - vendor/ UI libraries (novel, liveblocks, React)
 *
 * Only imports from packages that work server-side.
 */

import { internal } from "../convex/_generated/api.js";
import type { Id } from "../convex/_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../convex/_generated/server";
import { should_never_happen } from "./server-utils.ts";

export * from "../shared/files.ts";

async function files_db_cancel_scheduled_function_if_present(
	ctx: MutationCtx,
	scheduledFunctionId: Id<"_scheduled_functions">,
) {
	await ctx.scheduler.cancel(scheduledFunctionId).catch((error) => {
		if (error instanceof Error && error.message.includes("non-existent document")) {
			return;
		}

		throw error;
	});
}

async function files_db_delete_pending_update_cleanup_task_if_present(
	ctx: MutationCtx,
	cleanupTaskId: Id<"files_pending_updates_cleanup_tasks">,
) {
	await ctx.db.delete("files_pending_updates_cleanup_tasks", cleanupTaskId).catch((error) => {
		if (error instanceof Error && error.message.includes("non-existent doc")) {
			return;
		}

		throw error;
	});
}

export async function files_db_get_yjs_content_and_sequence(
	ctx: QueryCtx | MutationCtx,
	args: {
		workspaceId: string;
		projectId: string;
		nodeId: Id<"files_nodes">;
	},
) {
	const fileNode = await ctx.db.get("files_nodes", args.nodeId);
	if (!fileNode || fileNode.workspaceId !== args.workspaceId || fileNode.projectId !== args.projectId) {
		return null;
	}

	if (!fileNode.yjsSnapshotId) {
		const errorMessage = "fileNode.yjsSnapshotId is not set";
		const errorData = {
			nodeId: args.nodeId,
			yjsSnapshotId: fileNode.yjsSnapshotId,
		};
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}

	if (!fileNode.yjsLastSequenceId) {
		const errorMessage = "fileNode.yjsLastSequenceId is not set";
		const errorData = {
			nodeId: args.nodeId,
			yjsLastSequenceId: fileNode.yjsLastSequenceId,
		};
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}

	const [yjsSnapshotDoc, yjsUpdatesDocs, yjsLastSequenceDoc] = await Promise.all([
		ctx.db.get("files_yjs_snapshots", fileNode.yjsSnapshotId),
		ctx.db
			.query("files_yjs_updates")
			.withIndex("by_workspace_project_file_sequence", (q) =>
				q.eq("workspaceId", args.workspaceId).eq("projectId", args.projectId).eq("nodeId", args.nodeId),
			)
			.order("asc")
			.collect(),

		ctx.db.get("files_yjs_docs_last_sequences", fileNode.yjsLastSequenceId),
	]);

	if (
		!yjsSnapshotDoc ||
		yjsSnapshotDoc.workspaceId !== args.workspaceId ||
		yjsSnapshotDoc.projectId !== args.projectId
	) {
		const errorMessage = "fileNode.yjsSnapshotId points to a missing or mismatched files_yjs_snapshots doc";
		const errorData = {
			nodeId: args.nodeId,
			yjsSnapshotId: fileNode.yjsSnapshotId,
			yjsSnapshotDoc,
			workspaceId: args.workspaceId,
			projectId: args.projectId,
		};
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}

	if (
		!yjsLastSequenceDoc ||
		yjsLastSequenceDoc.workspaceId !== args.workspaceId ||
		yjsLastSequenceDoc.projectId !== args.projectId
	) {
		const errorMessage =
			"fileNode.yjsLastSequenceId points to a missing or mismatched files_yjs_docs_last_sequences doc";
		const errorData = {
			nodeId: args.nodeId,
			yjsLastSequenceId: fileNode.yjsLastSequenceId,
			yjsLastSequenceDoc,
			workspaceId: args.workspaceId,
			projectId: args.projectId,
		};
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}

	const incrementalYjsUpdatesDocs = yjsUpdatesDocs.filter((u) => u.sequence > yjsSnapshotDoc.sequence).reverse();
	return {
		file: fileNode,
		yjsSnapshotDoc,
		yjsLastSequenceDoc,
		yjsUpdatesDocs,
		incrementalYjsUpdatesDocs,
		yjsSequence: yjsLastSequenceDoc.lastSequence,
	};
}
export async function files_db_get_pending_update(
	ctx: QueryCtx | MutationCtx,
	args: {
		workspaceId: string;
		projectId: string;
		userId: string;
		nodeId: Id<"files_nodes">;
		pendingUpdateId?: Id<"files_pending_updates">;
	},
) {
	const pendingUpdateById = args.pendingUpdateId
		? await ctx.db.get("files_pending_updates", args.pendingUpdateId)
		: null;
	const pendingUpdate =
		pendingUpdateById &&
		pendingUpdateById.workspaceId === args.workspaceId &&
		pendingUpdateById.projectId === args.projectId &&
		pendingUpdateById.userId === args.userId &&
		pendingUpdateById.nodeId === args.nodeId
			? pendingUpdateById
			: await ctx.db
					.query("files_pending_updates")
					.withIndex("by_workspace_project_user_file", (q) =>
						q
							.eq("workspaceId", args.workspaceId)
							.eq("projectId", args.projectId)
							.eq("userId", args.userId)
							.eq("nodeId", args.nodeId),
					)
					.first();

	return pendingUpdate;
}

export async function files_db_cancel_pending_update_cleanup_tasks(
	ctx: MutationCtx,
	args: {
		pendingUpdateId: Id<"files_pending_updates">;
	},
) {
	const cleanupTasks = await ctx.db
		.query("files_pending_updates_cleanup_tasks")
		.withIndex("by_pendingUpdate", (q) => q.eq("pendingUpdateId", args.pendingUpdateId))
		.collect();

	await Promise.all([
		...cleanupTasks.map((cleanupTask) =>
			files_db_cancel_scheduled_function_if_present(ctx, cleanupTask.scheduledFunctionId),
		),
		...cleanupTasks.map((cleanupTask) => files_db_delete_pending_update_cleanup_task_if_present(ctx, cleanupTask._id)),
	]);
}

export async function files_db_schedule_pending_update_cleanup(
	ctx: MutationCtx,
	args: {
		pendingUpdateId: Id<"files_pending_updates">;
		expectedUpdatedAt: number;
		delayMs?: number;
	},
) {
	// Refresh the pending update lifetime on every write. Keep one cleanup task per doc
	// and replace the older scheduled run whenever the doc changes.
	const [existingCleanupTasks, scheduledFunctionId] = await Promise.all([
		ctx.db
			.query("files_pending_updates_cleanup_tasks")
			.withIndex("by_pendingUpdate", (q) => q.eq("pendingUpdateId", args.pendingUpdateId))
			.collect(),
		ctx.scheduler.runAfter(
			args.delayMs ?? 4 * 60 * 60 * 1000,
			internal.files_pending_updates.remove_file_pending_update_if_expired,
			{
				pendingUpdateId: args.pendingUpdateId,
				expectedUpdatedAt: args.expectedUpdatedAt,
			},
		),
	]);

	await Promise.all([
		ctx.db.insert("files_pending_updates_cleanup_tasks", {
			pendingUpdateId: args.pendingUpdateId,
			scheduledFunctionId,
			expectedUpdatedAt: args.expectedUpdatedAt,
		}),
		...existingCleanupTasks.map((cleanupTask) =>
			files_db_cancel_scheduled_function_if_present(ctx, cleanupTask.scheduledFunctionId),
		),
		...existingCleanupTasks.map((cleanupTask) =>
			files_db_delete_pending_update_cleanup_task_if_present(ctx, cleanupTask._id),
		),
	]);
}

export async function files_db_reschedule_pending_update_cleanup_for_user(
	ctx: MutationCtx,
	args: {
		workspaceId: string;
		projectId: string;
		userId: string;
		delayMs?: number;
	},
) {
	const pendingUpdates = await ctx.db
		.query("files_pending_updates")
		.withIndex("by_workspace_project_user_file", (q) =>
			q.eq("workspaceId", args.workspaceId).eq("projectId", args.projectId).eq("userId", args.userId),
		)
		.collect();

	await Promise.all(
		pendingUpdates.map((pendingUpdate) =>
			files_db_schedule_pending_update_cleanup(ctx, {
				pendingUpdateId: pendingUpdate._id,
				expectedUpdatedAt: pendingUpdate.updatedAt,
				delayMs: args.delayMs,
			}),
		),
	);
}
