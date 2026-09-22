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
import type { WithoutSystemFields } from "convex/server";
import type { Doc, Id } from "../convex/_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../convex/_generated/server";
import {
	files_pending_update_has_asset_content,
	files_pending_update_has_yjs_content,
	files_MAX_YJS_WIRE_BYTES,
} from "../shared/files.ts";
import { Result } from "common/errors-as-values-utils.ts";
import { should_never_happen } from "./server-utils.ts";
import {
	files_private_storage_db_reserve,
	files_private_storage_db_release_deleted_resource,
} from "../convex/files_private_storage.ts";
import { files_media_dependencies_db_retire } from "../convex/files_media_dependencies.ts";

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
		userId: Id<"users">;
		target: Doc<"files_pending_updates">["target"];
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
		pendingUpdateById.target.kind === args.target.kind &&
		pendingUpdateById.target.id === args.target.id
			? pendingUpdateById
			: await ctx.db
					.query("files_pending_updates")
					.withIndex("by_organization_workspace_user_target", (q) =>
						q
							.eq("organizationId", args.organizationId)
							.eq("workspaceId", args.workspaceId)
							.eq("userId", args.userId)
							.eq("target.kind", args.target.kind)
							.eq("target.id", args.target.id),
					)
					.first();

	return pendingUpdate;
}

/**
 * Every proposal write invalidates an older paged review of this owner's draft set.
 */
export async function files_db_advance_pending_review_version(
	ctx: MutationCtx,
	args: { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces">; userId: Id<"users"> },
) {
	const version = await ctx.db
		.query("files_pending_review_versions")
		.withIndex("by_organization_workspace_user", (q) =>
			q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("userId", args.userId),
		)
		.first();
	if (version) {
		await ctx.db.patch("files_pending_review_versions", version._id, { revision: version.revision + 1 });
	} else {
		await ctx.db.insert("files_pending_review_versions", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			revision: 1,
		});
	}
}

export async function files_db_insert_pending_update(
	ctx: MutationCtx,
	value: WithoutSystemFields<Doc<"files_pending_updates">>,
) {
	await files_db_advance_pending_review_version(ctx, value);
	return await ctx.db.insert("files_pending_updates", value);
}

export async function files_db_patch_pending_update(
	ctx: MutationCtx,
	pendingUpdateId: Id<"files_pending_updates">,
	value: Partial<WithoutSystemFields<Doc<"files_pending_updates">>>,
) {
	const proposal = await ctx.db.get("files_pending_updates", pendingUpdateId);
	if (!proposal) throw should_never_happen("Pending update disappeared before its write", { pendingUpdateId });
	await files_db_advance_pending_review_version(ctx, proposal);
	await ctx.db.patch("files_pending_updates", pendingUpdateId, value);
}

export async function files_db_delete_pending_update(
	ctx: MutationCtx,
	pendingUpdateId: Id<"files_pending_updates">,
	options?: { reviewAlreadyFenced: true },
) {
	const proposal = await ctx.db.get("files_pending_updates", pendingUpdateId);
	if (!proposal) return;
	// Paged cleanup follows the root's logical Discard, which already changed this clock.
	if (!options?.reviewAlreadyFenced) await files_db_advance_pending_review_version(ctx, proposal);
	if (proposal.mediaDependencySetId) {
		const set = await ctx.db.get("files_media_dependency_sets", proposal.mediaDependencySetId);
		if (set)
			await files_media_dependencies_db_retire(ctx, {
				setId: set._id,
				generation: set.generation,
				owner: { kind: "proposal", pendingUpdateId },
			});
	}
	await ctx.db.delete("files_pending_updates", pendingUpdateId);
}

/**
 * Look up a saved path. Owner paths are resolved by the bounded reader in files_visible.
 */
export async function files_db_get_visible_node_by_path(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		path: string;
	},
): Promise<Doc<"files_nodes"> | null> {
	if (args.path === "/") {
		return null;
	}

	return await ctx.db
		.query("files_nodes")
		.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
			q
				.eq("organizationId", args.organizationId)
				.eq("workspaceId", args.workspaceId)
				.eq("path", args.path)
				.eq("archiveOperationId", null),
		)
		.first();
}

/**
 * Return the proposal's base and three branch ids, or null for a structural-only doc.
 * Load branch bytes with `files_db_load_pending_update_yjs_state_bytes` or the one-page queries.
 */
export function files_pending_update_content_of(pendingUpdate: Pick<Doc<"files_pending_updates">, "content">) {
	return pendingUpdate.content ?? null;
}

/**
 * Return branches built from a saved Yjs sequence, or null for any other base.
 */
export function files_pending_update_yjs_content_of(pendingUpdate: Pick<Doc<"files_pending_updates">, "content">) {
	if (!files_pending_update_has_yjs_content(pendingUpdate)) {
		return null;
	}

	return pendingUpdate.content;
}

/**
 * Return branches built from a saved content asset, or null for any other base.
 */
export function files_pending_update_asset_content_of(pendingUpdate: Pick<Doc<"files_pending_updates">, "content">) {
	if (!files_pending_update_has_asset_content(pendingUpdate)) {
		return null;
	}

	return pendingUpdate.content;
}

/**
 * Whether the pending update doc owns pending chunk docs: a content proposal, or a whole-file
 * copy of a text file (its staged text is chunked too). A move-only doc and a copy of a stored
 * file have none, so their file's committed chunks stay the ones to read and search.
 */
export function files_pending_update_has_pending_chunks(
	pendingUpdate: Pick<Doc<"files_pending_updates">, "content" | "pendingReplacement">,
) {
	return pendingUpdate.content !== undefined || pendingUpdate.pendingReplacement?.yjsRootKind !== undefined;
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
		userId: Id<"users">;
		target: Doc<"files_pending_update_yjs_states">["target"];
		update: ArrayBuffer;
		/**
		 * Absent for a state built for a file with collaboration off, which has no lineage.
		 */
		lineageGeneration?: number;
	} & (
		| { pendingUpdateId: Id<"files_pending_updates">; role: "base" | "staged" | "unstaged" }
		| { transferItemId: Id<"files_transfer_items"> }
	),
) {
	// A Yjs state encode is never empty (the empty document encodes as 2 bytes), so every state
	// has at least one non-empty page.
	const bytes = new Uint8Array(args.update);
	const pageCount = Math.ceil(bytes.byteLength / files_MAX_YJS_WIRE_BYTES);

	const stateId = await ctx.db.insert("files_pending_update_yjs_states", {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		userId: args.userId,
		target: args.target,
		owner:
			"transferItemId" in args
				? { kind: "transfer_capture", itemId: args.transferItemId }
				: {
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
	const reserved = await files_private_storage_db_reserve(ctx, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		userId: args.userId,
		resource: { kind: "state", id: stateId },
		byteCount: bytes.byteLength,
	});
	if (reserved._nay) {
		await ctx.db.delete("files_pending_update_yjs_states", stateId);
		return reserved;
	}

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

	return Result({ _yay: stateId });
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

	for (const stateDoc of stateDocs) {
		const pages = await ctx.db
			.query("files_pending_update_yjs_state_pages")
			.withIndex("by_state_pageIndex", (q) => q.eq("stateId", stateDoc._id))
			.collect();
		await Promise.all(pages.map((page) => ctx.db.delete("files_pending_update_yjs_state_pages", page._id)));
		await ctx.db.delete("files_pending_update_yjs_states", stateDoc._id);
		await files_private_storage_db_release_deleted_resource(ctx, { kind: "state", id: stateDoc._id });
	}
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
	await files_private_storage_db_release_deleted_resource(ctx, { kind: "trusted_stage", id: stage._id });
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
			cleanupTask.scheduledFunctionId
				? files_db_cancel_scheduled_function_if_present(ctx, cleanupTask.scheduledFunctionId)
				: undefined,
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
		expiresAt?: number;
	},
) {
	const existing = await ctx.db
		.query("files_pending_updates_cleanup_tasks")
		.withIndex("by_pendingUpdate", (q) => q.eq("pendingUpdateId", args.pendingUpdateId))
		.unique();
	const now = Date.now();
	const expiresAt = Math.max(existing?.expiresAt ?? 0, args.expiresAt ?? now + (args.delayMs ?? 4 * 60 * 60 * 1000));
	const expiryGeneration = (existing?.expiryGeneration ?? 0) + 1;
	const cleanupTaskId =
		existing?._id ??
		(await ctx.db.insert("files_pending_updates_cleanup_tasks", {
			pendingUpdateId: args.pendingUpdateId,
			scheduledFunctionId: null,
			expectedUpdatedAt: args.expectedUpdatedAt,
			expiresAt,
			expiryGeneration,
		}));
	// A held, due proposal retries without pretending that its content was edited.
	const scheduledFunctionId = await ctx.scheduler.runAt(
		Math.max(expiresAt, now + (args.expiresAt === undefined ? 0 : (args.delayMs ?? 0))),
		internal.files_pending_updates.remove_file_pending_update_if_expired,
		{ cleanupTaskId, expiryGeneration },
	);
	await ctx.db.patch("files_pending_updates_cleanup_tasks", cleanupTaskId, {
		scheduledFunctionId,
		expectedUpdatedAt: args.expectedUpdatedAt,
		expiresAt,
		expiryGeneration,
	});
	if (existing?.scheduledFunctionId)
		await files_db_cancel_scheduled_function_if_present(ctx, existing.scheduledFunctionId);
}

export async function files_db_reschedule_pending_update_cleanup_for_user(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
		delayMs?: number;
	},
) {
	const pendingUpdates = await ctx.db
		.query("files_pending_updates")
		.withIndex("by_organization_workspace_user_target", (q) =>
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
