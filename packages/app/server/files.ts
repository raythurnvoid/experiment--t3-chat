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
import type { Doc, Id } from "../convex/_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../convex/_generated/server";
import {
	files_pending_update_has_yjs_content,
	files_pending_path_overlay_build,
	files_pending_path_overlay_translate_path,
	files_pending_path_overlay_pick_visible_entry,
	files_ROOT_ID,
} from "../shared/files.ts";
import {
	organizations_is_global_organization_id,
	organizations_is_reserved_workspace_id,
} from "../shared/organizations.ts";
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
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		nodeId: Id<"files_nodes">;
	},
) {
	const fileNode = await ctx.db.get("files_nodes", args.nodeId);
	if (!fileNode || fileNode.organizationId !== args.organizationId || fileNode.workspaceId !== args.workspaceId) {
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
			.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
				q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("fileNodeId", args.nodeId),
			)
			.order("asc")
			.collect(),

		ctx.db.get("files_yjs_docs_last_sequences", fileNode.yjsLastSequenceId),
	]);

	if (
		!yjsSnapshotDoc ||
		yjsSnapshotDoc.organizationId !== args.organizationId ||
		yjsSnapshotDoc.workspaceId !== args.workspaceId
	) {
		const errorMessage = "fileNode.yjsSnapshotId points to a missing or mismatched files_yjs_snapshots doc";
		const errorData = {
			nodeId: args.nodeId,
			yjsSnapshotId: fileNode.yjsSnapshotId,
			yjsSnapshotDoc,
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
		};
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}

	if (
		!yjsLastSequenceDoc ||
		yjsLastSequenceDoc.organizationId !== args.organizationId ||
		yjsLastSequenceDoc.workspaceId !== args.workspaceId
	) {
		const errorMessage =
			"fileNode.yjsLastSequenceId points to a missing or mismatched files_yjs_docs_last_sequences doc";
		const errorData = {
			nodeId: args.nodeId,
			yjsLastSequenceId: fileNode.yjsLastSequenceId,
			yjsLastSequenceDoc,
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
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
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
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
		pendingUpdateById.organizationId === args.organizationId &&
		pendingUpdateById.workspaceId === args.workspaceId &&
		pendingUpdateById.userId === args.userId &&
		pendingUpdateById.fileNodeId === args.nodeId
			? pendingUpdateById
			: await ctx.db
					.query("files_pending_updates")
					.withIndex("by_organization_workspace_user_fileNode", (q) =>
						q
							.eq("organizationId", args.organizationId)
							.eq("workspaceId", args.workspaceId)
							.eq("userId", args.userId)
							.eq("fileNodeId", args.nodeId),
					)
					.first();

	return pendingUpdate;
}

/**
 * Indexed read of one user's pending update docs. Shared by the FE list query and the
 * pending path overlay reads so both always see the same docs.
 */
export async function files_db_list_pending_updates_for_user(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: string;
	},
) {
	return await ctx.db
		.query("files_pending_updates")
		.withIndex("by_organization_workspace_user_fileNode", (q) =>
			q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("userId", args.userId),
		)
		.order("asc")
		.collect();
}

/**
 * Load one user's pending update docs plus the active nodes their move/replace fields
 * reference — the exact inputs `files_pending_path_overlay_build` needs. Full docs,
 * overfetched on purpose so one read serves every overlay consumer.
 */
export async function files_db_get_pending_path_overlay_data(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: string;
	},
) {
	const pendingUpdates = await files_db_list_pending_updates_for_user(ctx, args);

	const referencedNodeIds = new Set<Id<"files_nodes">>();
	for (const pendingUpdate of pendingUpdates) {
		if (pendingUpdate.pendingMove) {
			referencedNodeIds.add(pendingUpdate.fileNodeId);
			if (pendingUpdate.pendingMove.destParentId !== files_ROOT_ID) {
				referencedNodeIds.add(pendingUpdate.pendingMove.destParentId);
			}
			if (pendingUpdate.pendingMove.replacesNodeId) {
				referencedNodeIds.add(pendingUpdate.pendingMove.replacesNodeId);
			}
		}
		if (pendingUpdate.copiedFrom?.archivesSourceOnAccept) {
			referencedNodeIds.add(pendingUpdate.copiedFrom.nodeId);
		}
		if (pendingUpdate.pendingArchive) {
			referencedNodeIds.add(pendingUpdate.fileNodeId);
		}
	}

	// Archived or out-of-scope nodes stay out of the map, so the overlay treats their
	// docs as missing and the affected docs go inert on the next build.
	const referencedNodes = (
		await Promise.all([...referencedNodeIds].map((nodeId) => ctx.db.get("files_nodes", nodeId)))
	).filter(
		(node): node is Doc<"files_nodes"> =>
			node != null &&
			node.organizationId === args.organizationId &&
			node.workspaceId === args.workspaceId &&
			node.archiveOperationId === undefined,
	);

	return { pendingUpdates, referencedNodes };
}

/**
 * Build the user's pending path overlay from direct db reads.
 */
export async function files_db_build_pending_path_overlay(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: string;
	},
) {
	const overlayData = await files_db_get_pending_path_overlay_data(ctx, args);
	return files_pending_path_overlay_build({
		pendingUpdates: overlayData.pendingUpdates,
		nodesById: new Map(overlayData.referencedNodes.map((node) => [node._id, node])),
	});
}

/**
 * Path lookup that can see one user's pending path overlay.
 *
 * Without `overlayUserId` this is the plain committed lookup. With it, the requested path is
 * translated through the user's pending moves first: a claimed destination resolves to the
 * moved node's committed doc (returned unchanged — callers display the requested path), a
 * vacated or replaced path reads as missing, and an unrelated live node found at the path
 * stays visible. Committed nodes inside a moved folder's subtree follow the folder, so their
 * old descendant paths read as missing too. Reserved scopes never have pending docs, so the
 * overlay is skipped there.
 */
export async function files_db_get_visible_node_by_path(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		path: string;
		overlayUserId?: Id<"users">;
	},
): Promise<Doc<"files_nodes"> | null> {
	if (args.path === "/") {
		return null;
	}

	const lookup = (path: string) =>
		ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
				q
					.eq("organizationId", args.organizationId)
					.eq("workspaceId", args.workspaceId)
					.eq("path", path)
					.eq("archiveOperationId", undefined),
			)
			.first();

	const overlayUserId = args.overlayUserId;
	if (
		overlayUserId == null ||
		organizations_is_global_organization_id(args.organizationId) ||
		organizations_is_reserved_workspace_id(args.workspaceId)
	) {
		return await lookup(args.path);
	}

	const overlay = await files_db_build_pending_path_overlay(ctx, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		userId: overlayUserId,
	});
	const translated = files_pending_path_overlay_translate_path(overlay, args.path);
	if (translated.kind === "redirected") {
		// A pending move claims this path: present the moved node here, doc unchanged.
		return await lookup(translated.committedPath);
	}

	const occupant = await lookup(args.path);
	if (!occupant) {
		return null;
	}
	const pick = files_pending_path_overlay_pick_visible_entry(overlay, {
		requestedPath: args.path,
		occupantNodeId: occupant._id,
	});
	if (pick !== "occupant") {
		return null;
	}
	if (translated.kind === "hidden") {
		// A live occupant under a hidden verdict is a committed descendant of a moved folder:
		// it follows its ancestor to the destination, so its old path reads as missing here.
		// (Exact-path hides always surface the moved/replaced node itself, which `pick` drops.)
		return null;
	}
	return occupant;
}

/**
 * Return the pending update's content proposal (the 4 Yjs fields, set together or not at all),
 * or `null` for move-only pending update docs.
 */
export function files_pending_update_content_of(
	pendingUpdate: Pick<
		Doc<"files_pending_updates">,
		"baseYjsSequence" | "baseYjsUpdate" | "stagedBranchYjsUpdate" | "unstagedBranchYjsUpdate"
	>,
) {
	if (!files_pending_update_has_yjs_content(pendingUpdate)) {
		return null;
	}

	return {
		baseYjsSequence: pendingUpdate.baseYjsSequence,
		baseYjsUpdate: pendingUpdate.baseYjsUpdate,
		stagedBranchYjsUpdate: pendingUpdate.stagedBranchYjsUpdate,
		unstagedBranchYjsUpdate: pendingUpdate.unstagedBranchYjsUpdate,
	};
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
			args.delayMs ?? 4 * 60 * 60 * 1000, // 4 hours
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
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: string;
		delayMs?: number;
	},
) {
	const pendingUpdates = await ctx.db
		.query("files_pending_updates")
		.withIndex("by_organization_workspace_user_fileNode", (q) =>
			q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("userId", args.userId),
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
