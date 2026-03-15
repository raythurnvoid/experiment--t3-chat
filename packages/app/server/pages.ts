/**
 * Server-side pages functions.
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

export * from "../shared/pages.ts";

async function pages_db_cancel_scheduled_function_if_present(
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

async function pages_db_delete_pending_edit_cleanup_task_if_present(
	ctx: MutationCtx,
	cleanupTaskId: Id<"pages_pending_edits_cleanup_tasks">,
) {
	await ctx.db.delete("pages_pending_edits_cleanup_tasks", cleanupTaskId).catch((error) => {
		if (error instanceof Error && error.message.includes("non-existent doc")) {
			return;
		}

		throw error;
	});
}

export async function pages_db_get_yjs_content_and_sequence(
	ctx: QueryCtx | MutationCtx,
	args: {
		workspaceId: string;
		projectId: string;
		pageId: Id<"pages">;
	},
) {
	const page = await ctx.db.get("pages", args.pageId);
	if (!page || page.workspaceId !== args.workspaceId || page.projectId !== args.projectId) {
		return null;
	}

	if (!page.yjsSnapshotId || !page.yjsLastSequenceId) {
		console.error(
			should_never_happen(
				"[pages_db_get_yjs_content_and_sequence] Missing page.yjsSnapshotId or page.yjsLastSequenceId",
				{
					pageId: args.pageId,
					yjsSnapshotId: page.yjsSnapshotId,
					yjsLastSequenceId: page.yjsLastSequenceId,
				},
			),
		);
		return null;
	}

	const [yjsSnapshotDoc, yjsUpdatesDocs, yjsLastSequenceDoc] = await Promise.all([
		ctx.db.get("pages_yjs_snapshots", page.yjsSnapshotId),
		ctx.db
			.query("pages_yjs_updates")
			.withIndex("by_workspace_project_page_id_sequence", (q) =>
				q.eq("workspace_id", args.workspaceId).eq("project_id", args.projectId).eq("page_id", args.pageId),
			)
			.order("asc")
			.collect(),

		ctx.db.get("pages_yjs_docs_last_sequences", page.yjsLastSequenceId),
	]);

	if (
		!yjsSnapshotDoc ||
		yjsSnapshotDoc.workspace_id !== args.workspaceId ||
		yjsSnapshotDoc.project_id !== args.projectId ||
		!yjsLastSequenceDoc ||
		yjsLastSequenceDoc.workspace_id !== args.workspaceId ||
		yjsLastSequenceDoc.project_id !== args.projectId
	) {
		console.error(
			should_never_happen("[pages_db_get_yjs_content_and_sequence] Missing yjsSnapshotDoc or yjsLastSequenceDoc", {
				pageId: args.pageId,
				yjsSnapshotDoc: yjsSnapshotDoc,
				yjsLastSequenceDoc: yjsLastSequenceDoc,
				workspaceId: args.workspaceId,
				projectId: args.projectId,
			}),
		);

		return null;
	}

	const incrementalYjsUpdatesDocs = yjsUpdatesDocs.filter((u) => u.sequence > yjsSnapshotDoc.sequence).reverse();

	return {
		page,
		yjsSnapshotDoc,
		yjsLastSequenceDoc,
		yjsUpdatesDocs,
		incrementalYjsUpdatesDocs,
		yjsSequence: yjsLastSequenceDoc.last_sequence,
	};
}

export async function pages_db_cancel_pending_edit_cleanup_tasks(
	ctx: MutationCtx,
	args: {
		pendingEditId: Id<"pages_pending_edits">;
	},
) {
	const cleanupTasks = await ctx.db
		.query("pages_pending_edits_cleanup_tasks")
		.withIndex("by_pendingEditId", (q) => q.eq("pendingEditId", args.pendingEditId))
		.collect();

	await Promise.all([
		...cleanupTasks.map((cleanupTask) =>
			pages_db_cancel_scheduled_function_if_present(ctx, cleanupTask.scheduledFunctionId),
		),
		...cleanupTasks.map((cleanupTask) =>
			pages_db_delete_pending_edit_cleanup_task_if_present(ctx, cleanupTask._id),
		),
	]);
}

export async function pages_db_schedule_pending_edit_cleanup(
	ctx: MutationCtx,
	args: {
		pendingEditId: Id<"pages_pending_edits">;
		expectedUpdatedAt: number;
		delayMs?: number;
	},
) {
	// Refresh the pending edit lifetime on every write. Keep one cleanup task per row
	// and replace the older scheduled run whenever the row changes.
	const [existingCleanupTasks, scheduledFunctionId] = await Promise.all([
		ctx.db
			.query("pages_pending_edits_cleanup_tasks")
			.withIndex("by_pendingEditId", (q) => q.eq("pendingEditId", args.pendingEditId))
			.collect(),
		ctx.scheduler.runAfter(
			args.delayMs ?? 4 * 60 * 60 * 1000,
			internal.pages_pending_edits.remove_pages_pending_edit_if_expired,
			{
				pendingEditId: args.pendingEditId,
				expectedUpdatedAt: args.expectedUpdatedAt,
			},
		),
	]);

	await Promise.all([
		ctx.db.insert("pages_pending_edits_cleanup_tasks", {
			pendingEditId: args.pendingEditId,
			scheduledFunctionId,
			expectedUpdatedAt: args.expectedUpdatedAt,
		}),
		...existingCleanupTasks.map((cleanupTask) =>
			pages_db_cancel_scheduled_function_if_present(ctx, cleanupTask.scheduledFunctionId),
		),
		...existingCleanupTasks.map((cleanupTask) =>
			pages_db_delete_pending_edit_cleanup_task_if_present(ctx, cleanupTask._id),
		),
	]);
}

export async function pages_db_reschedule_pending_edit_cleanup_for_user(
	ctx: MutationCtx,
	args: {
		workspaceId: string;
		projectId: string;
		userId: string;
		delayMs?: number;
	},
) {
	const pendingEdits = await ctx.db
		.query("pages_pending_edits")
		.withIndex("by_workspace_project_user_page", (q) =>
			q.eq("workspaceId", args.workspaceId).eq("projectId", args.projectId).eq("userId", args.userId),
		)
		.collect();

	await Promise.all(
		pendingEdits.map((pendingEdit) =>
			pages_db_schedule_pending_edit_cleanup(ctx, {
				pendingEditId: pendingEdit._id,
				expectedUpdatedAt: pendingEdit.updatedAt,
				delayMs: args.delayMs,
			}),
		),
	);
}
