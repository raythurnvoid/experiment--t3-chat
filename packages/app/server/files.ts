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
	files_MAX_YJS_WIRE_BYTES,
} from "../shared/files.ts";
import {
	organizations_is_global_organization_id,
	organizations_is_reserved_workspace_id,
} from "../shared/organizations.ts";
import { Result } from "common/errors-as-values-utils.ts";
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
 * Return the pending update's content proposal (the canonical content group: base sequence,
 * lineage generation, and the three paged-state ids, set together or not at all), or `null`
 * for move-only pending update docs. The state bytes live in the paged families; load them
 * with `files_db_load_pending_update_yjs_state_bytes` or the one-page queries.
 */
export function files_pending_update_content_of(
	pendingUpdate: Pick<
		Doc<"files_pending_updates">,
		"baseYjsSequence" | "baseLineageGeneration" | "baseStateId" | "stagedStateId" | "unstagedStateId"
	>,
) {
	if (!files_pending_update_has_yjs_content(pendingUpdate)) {
		return null;
	}

	return {
		baseYjsSequence: pendingUpdate.baseYjsSequence,
		baseLineageGeneration: pendingUpdate.baseLineageGeneration,
		baseStateId: pendingUpdate.baseStateId,
		stagedStateId: pendingUpdate.stagedStateId,
		unstagedStateId: pendingUpdate.unstagedStateId,
	};
}

/**
 * Digest for a paged pending-state family. Not cryptographic: it only has to detect a torn or
 * mixed page family when a state is reassembled. Two FNV-1a 32-bit passes with different seeds,
 * joined as hex.
 */
export function files_pending_update_yjs_state_digest(bytes: Uint8Array) {
	let hashA = 0x811c9dc5;
	let hashB = 0x1000193;
	for (const byte of bytes) {
		hashA = Math.imul(hashA ^ byte, 0x01000193) >>> 0;
		hashB = Math.imul(hashB ^ byte, 0x01000193) >>> 0;
	}
	return `${hashA.toString(16).padStart(8, "0")}${hashB.toString(16).padStart(8, "0")}`;
}

/**
 * Insert one sealed paged Yjs state family (metadata doc plus its pages) owned by a pending
 * update doc. The whole family commits in the caller's mutation, so it is sealed on insert.
 */
export async function files_db_insert_pending_update_yjs_state(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: string;
		fileNodeId: Id<"files_nodes">;
		pendingUpdateId: Id<"files_pending_updates">;
		role: "base" | "staged" | "unstaged";
		update: ArrayBuffer;
		lineageGeneration: number;
	},
) {
	// A Yjs state encode is never empty (the empty document encodes as 2 bytes), so every state
	// has at least one non-empty page.
	const bytes = new Uint8Array(args.update);
	const pageCount = Math.ceil(bytes.byteLength / files_MAX_YJS_WIRE_BYTES);

	const stateId = await ctx.db.insert("files_pending_update_yjs_states", {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		userId: args.userId,
		fileNodeId: args.fileNodeId,
		owner: {
			kind: "active",
			pendingUpdateId: args.pendingUpdateId,
			role: args.role,
		},
		lineageGeneration: args.lineageGeneration,
		sealed: true,
		pageCount,
		totalBytes: bytes.byteLength,
		digest: files_pending_update_yjs_state_digest(bytes),
	});

	for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
		const pageStart = pageIndex * files_MAX_YJS_WIRE_BYTES;
		await ctx.db.insert("files_pending_update_yjs_state_pages", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			stateId,
			pageIndex,
			bytes: bytes.slice(pageStart, pageStart + files_MAX_YJS_WIRE_BYTES).buffer as ArrayBuffer,
		});
	}

	return stateId;
}

/**
 * Reassemble one paged state's bytes from its pages inside a query/mutation transaction.
 * Verify contiguous page indexes and the stored totals/digest so a torn or mixed family is
 * refused instead of silently reconstructed wrong. Bounded by the sealed-state cap the seal
 * enforced (one state is at most 4 MiB), so only load one or two states per transaction.
 */
export async function files_db_load_pending_update_yjs_state_bytes(
	ctx: QueryCtx | MutationCtx,
	args: { stateDoc: Doc<"files_pending_update_yjs_states"> },
) {
	const pages = await ctx.db
		.query("files_pending_update_yjs_state_pages")
		.withIndex("by_state_pageIndex", (q) => q.eq("stateId", args.stateDoc._id))
		.collect();

	if (pages.length !== args.stateDoc.pageCount) {
		return Result({
			_nay: { name: "nay" as const, message: "Pending state pages are incomplete" },
		});
	}

	const bytes = new Uint8Array(args.stateDoc.totalBytes);
	let offset = 0;
	for (const [index, page] of pages.entries()) {
		if (page.pageIndex !== index || offset + page.bytes.byteLength > bytes.byteLength) {
			return Result({
				_nay: { name: "nay" as const, message: "Pending state pages are incomplete" },
			});
		}
		bytes.set(new Uint8Array(page.bytes), offset);
		offset += page.bytes.byteLength;
	}

	if (offset !== args.stateDoc.totalBytes || files_pending_update_yjs_state_digest(bytes) !== args.stateDoc.digest) {
		return Result({
			_nay: { name: "nay" as const, message: "Pending state pages are incomplete" },
		});
	}

	return Result({ _yay: bytes });
}

/**
 * Move every active paged state family a pending update doc owns to a durable cleanup task
 * instead of deleting the pages inline. A family can hold 12 MiB of pages, and deleted docs
 * count against the mutation's write budget, so the final commits only re-own metadata here
 * and a bounded scheduled continuation (the pending-state sweeper) drains the pages later.
 */
export async function files_db_retire_pending_update_yjs_states(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		pendingUpdateId: Id<"files_pending_updates">;
	},
) {
	const stateDocs = await ctx.db
		.query("files_pending_update_yjs_states")
		.withIndex("by_owner_pendingUpdate", (q) => q.eq("owner.pendingUpdateId", args.pendingUpdateId))
		.collect();
	if (stateDocs.length === 0) {
		return;
	}

	const cleanupTaskId = await ctx.db.insert("files_pending_update_state_cleanup_tasks", {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		createdAt: Date.now(),
	});
	await Promise.all(
		stateDocs.map((stateDoc) =>
			ctx.db.patch("files_pending_update_yjs_states", stateDoc._id, {
				owner: { kind: "retired", cleanupTaskId },
			}),
		),
	);
	await ctx.scheduler.runAfter(0, internal.files_pending_updates.cleanup_expired_pending_state_rows, {});
}

/**
 * Retire an operation batch family right away after a handled refusal. Physically deleting the
 * family here could blow the mutation's write budget (an input plus output set can hold 24 MiB
 * of pages), so expire the batch and its temporary states instead and run the bounded sweeper
 * now. TTL cleanup stays the crash/abandon fallback; this is the immediate path.
 */
export async function files_db_expire_pending_update_operation_batch(
	ctx: MutationCtx,
	args: { operationBatchId: Id<"files_pending_update_operation_batches"> },
) {
	const batch = await ctx.db.get("files_pending_update_operation_batches", args.operationBatchId);
	if (!batch) {
		return;
	}

	const [textInputs, batchStates] = await Promise.all([
		ctx.db
			.query("files_pending_update_text_inputs")
			.withIndex("by_operationBatch", (q) => q.eq("operationBatchId", batch._id))
			.collect(),
		ctx.db
			.query("files_pending_update_yjs_states")
			.withIndex("by_owner_operationBatch", (q) => q.eq("owner.operationBatchId", batch._id))
			.collect(),
	]);
	await Promise.all([
		ctx.db.patch("files_pending_update_operation_batches", batch._id, { expiresAt: 0 }),
		...textInputs.map((textInput) => ctx.db.patch("files_pending_update_text_inputs", textInput._id, { expiresAt: 0 })),
		...batchStates.map((stateDoc) =>
			stateDoc.owner.kind === "temporary"
				? ctx.db.patch("files_pending_update_yjs_states", stateDoc._id, {
						owner: { ...stateDoc.owner, expiresAt: 0 },
					})
				: null,
		),
	]);
	await ctx.scheduler.runAfter(0, internal.files_pending_updates.cleanup_expired_pending_state_rows, {});
}

/**
 * Delete every active paged state family a pending update doc owns (metadata docs plus pages).
 * Runs beside every write that clears or deletes the doc's content proposal.
 */
export async function files_db_delete_pending_update_yjs_states(
	ctx: MutationCtx,
	args: {
		pendingUpdateId: Id<"files_pending_updates">;
	},
) {
	const stateDocs = await ctx.db
		.query("files_pending_update_yjs_states")
		.withIndex("by_owner_pendingUpdate", (q) => q.eq("owner.pendingUpdateId", args.pendingUpdateId))
		.collect();

	await Promise.all(
		stateDocs.map(async (stateDoc) => {
			const pages = await ctx.db
				.query("files_pending_update_yjs_state_pages")
				.withIndex("by_state_pageIndex", (q) => q.eq("stateId", stateDoc._id))
				.collect();
			await Promise.all(pages.map((page) => ctx.db.delete("files_pending_update_yjs_state_pages", page._id)));
			await ctx.db.delete("files_pending_update_yjs_states", stateDoc._id);
		}),
	);
}

/**
 * Load and consume one staged trusted Yjs update (pending Accept, public fill, snapshot
 * restore). The stage is deleted in the consuming transaction, so a commit that later refuses
 * still burns it — a refused commit must be rebuilt and restaged, never replayed.
 */
export async function files_db_consume_trusted_yjs_update_stage(
	ctx: MutationCtx,
	args: {
		stageId: Id<"files_yjs_trusted_update_stages">;
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
		nodeId: Id<"files_nodes">;
		kind: Doc<"files_yjs_trusted_update_stages">["kind"];
	},
) {
	const stage = await ctx.db.get("files_yjs_trusted_update_stages", args.stageId);
	if (
		!stage ||
		stage.organizationId !== args.organizationId ||
		stage.workspaceId !== args.workspaceId ||
		stage.userId !== args.userId ||
		stage.fileNodeId !== args.nodeId ||
		stage.kind !== args.kind ||
		stage.expiresAt <= Date.now()
	) {
		return Result({ _nay: { name: "nay" as const, message: "Not found" } });
	}

	await ctx.db.delete("files_yjs_trusted_update_stages", stage._id);
	return Result({ _yay: stage.update });
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
