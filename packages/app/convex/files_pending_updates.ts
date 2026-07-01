import {
	query,
	action,
	internalAction,
	internalMutation,
	internalQuery,
	type ActionCtx,
	type MutationCtx,
} from "./_generated/server.js";
import type { Id } from "./_generated/dataModel.js";
import type { RegisteredMutation, RegisteredQuery } from "convex/server";
import { v } from "convex/values";
import { doc } from "convex-helpers/validators";
import type { app_convex_Doc } from "../src/lib/app-convex-client.ts";
import { server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";
import { convex_error, v_result } from "../server/convex-utils.ts";
import app_convex_schema from "./schema.ts";
import { api, internal } from "./_generated/api.js";
import { files_db_yjs_push_update, type get_file_content_materialization_state_Result } from "./files_nodes.ts";
import { billing_event } from "../server/billing.ts";
import { billing_db_check_credits, billing_pick_billed_user_id, billing_ingest_events } from "./billing.ts";
import { composite_id, should_never_happen } from "../shared/shared-utils.ts";
import { Result } from "../src/lib/errors-as-values-utils.ts";
import { organizations_db_get_membership } from "./organizations.ts";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";
import {
	files_db_cancel_pending_update_cleanup_tasks,
	files_db_get_pending_update,
	files_db_schedule_pending_update_cleanup,
	files_yjs_doc_apply_array_buffer_update,
	files_yjs_doc_create_from_array_buffer_update,
	files_yjs_doc_clone,
	files_yjs_doc_get_markdown,
	files_yjs_doc_update_from_markdown,
	files_yjs_compute_diff_update_from_yjs_doc,
	files_u8_to_array_buffer,
	files_u8_equals,
} from "../server/files.ts";
import { files_chunk_markdown } from "../server/files-markdown-chunking-mastra.ts";
import { files_get_utf8_byte_size } from "../shared/files.ts";
import { r2_fetch_object_from_bucket } from "./r2.ts";
import { files_metadata_db_delete_pending, files_metadata_db_replace_pending } from "./files_metadata.ts";
import { Doc as YDoc, encodeStateAsUpdate } from "yjs";

function files_pending_update_encode_yjs_state_update(args: { yjsDoc: YDoc }) {
	return files_u8_to_array_buffer(encodeStateAsUpdate(args.yjsDoc));
}

function files_pending_update_reconstruct_branch_docs(pendingUpdate: app_convex_Doc<"files_pending_updates">) {
	return {
		baseYjsSequence: pendingUpdate.baseYjsSequence,
		baseYjsDoc: files_yjs_doc_create_from_array_buffer_update(pendingUpdate.baseYjsUpdate),
		stagedBranchYjsDoc: files_yjs_doc_create_from_array_buffer_update(pendingUpdate.stagedBranchYjsUpdate),
		unstagedBranchYjsDoc: files_yjs_doc_create_from_array_buffer_update(pendingUpdate.unstagedBranchYjsUpdate),
	};
}

async function files_pending_update_action_get_latest_file_yjs_state(
	ctx: ActionCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		nodeId: app_convex_Doc<"files_pending_updates">["fileNodeId"];
	},
) {
	const state = (await ctx.runQuery(
		internal.files_nodes.get_file_content_materialization_state,
		args,
	)) as get_file_content_materialization_state_Result;
	if (!state) {
		return Result({
			_nay: {
				message: "Not found",
			},
		});
	}

	if (!state.yjsSnapshotAsset.r2Key) {
		const errorMessage = "yjsSnapshotAsset.r2Key is not set";
		const errorData = {
			nodeId: args.nodeId,
			assetId: state.yjsSnapshotAsset._id,
		};
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}

	const baseSnapshotUpdate = await r2_fetch_object_from_bucket({ key: state.yjsSnapshotAsset.r2Key }).then((response) =>
		response.arrayBuffer(),
	);
	const baseYjsDoc = files_yjs_doc_create_from_array_buffer_update(baseSnapshotUpdate, {
		additionalIncrementalArrayBufferUpdates: state.yjsUpdatesDocs
			.filter((update) => update.sequence > state.yjsSnapshotDoc.sequence)
			.map((update) => update.update),
	});

	return Result({
		_yay: {
			baseYjsSequence: state.yjsLastSequenceDoc.lastSequence,
			baseYjsUpdate: files_pending_update_encode_yjs_state_update({
				yjsDoc: baseYjsDoc,
			}),
		},
	});
}

async function files_pending_update_upsert_last_sequence_saved(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: string;
		nodeId: app_convex_Doc<"files_pending_updates_last_sequence_saved">["fileNodeId"];
		lastSequenceSaved: number;
		updatedAt: number;
	},
) {
	const existingRow = await ctx.db
		.query("files_pending_updates_last_sequence_saved")
		.withIndex("by_organization_workspace_user_fileNode", (q) =>
			q
				.eq("organizationId", args.organizationId)
				.eq("workspaceId", args.workspaceId)
				.eq("userId", args.userId)
				.eq("fileNodeId", args.nodeId),
		)
		.first();

	if (!existingRow) {
		await ctx.db.insert("files_pending_updates_last_sequence_saved", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			fileNodeId: args.nodeId,
			lastSequenceSaved: args.lastSequenceSaved,
			updatedAt: args.updatedAt,
		});
		return;
	}

	await ctx.db.patch("files_pending_updates_last_sequence_saved", existingRow._id, {
		lastSequenceSaved: args.lastSequenceSaved,
		updatedAt: args.updatedAt,
	});
}

export const get_by_file_node = internalQuery({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		fileNodeId: v.id("files_nodes"),
	},
	returns: v.union(doc(app_convex_schema, "files_pending_updates"), v.null()),
	handler: async (ctx, args) => {
		return await ctx.db
			.query("files_pending_updates")
			.withIndex("by_organization_workspace_user_fileNode", (q) =>
				q
					.eq("organizationId", args.organizationId)
					.eq("workspaceId", args.workspaceId)
					.eq("userId", args.userId)
					.eq("fileNodeId", args.fileNodeId),
			)
			.first();
	},
});

export type files_pending_updates_get_by_file_node_Result =
	typeof get_by_file_node extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

async function files_pending_update_db_delete_chunks(
	ctx: MutationCtx,
	args: { pendingUpdateId: Id<"files_pending_updates"> },
) {
	const [markdownChunks, plainTextChunks] = await Promise.all([
		ctx.db
			.query("files_markdown_chunks")
			.withIndex("by_pendingUpdate_chunkIndex", (q) => q.eq("pendingUpdateId", args.pendingUpdateId))
			.collect(),
		ctx.db
			.query("files_plain_text_chunks")
			.withIndex("by_pendingUpdate_chunkIndex", (q) => q.eq("pendingUpdateId", args.pendingUpdateId))
			.collect(),
	]);
	await Promise.all([
		...plainTextChunks.map((chunk) => ctx.db.delete("files_plain_text_chunks", chunk._id)),
		...markdownChunks.map((chunk) => ctx.db.delete("files_markdown_chunks", chunk._id)),
		files_metadata_db_delete_pending(ctx, args),
	]);
}

/**
 * Replace the pending Markdown chunk docs, plain-text chunk docs, and metadata docs for `unstaged` Markdown.
 * Run this in the same mutation as the pending update doc write so reads/search never see stale indexed docs.
 */
async function files_pending_update_db_replace_chunks(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: string;
		nodeId: Id<"files_nodes">;
		pendingUpdateId: Id<"files_pending_updates">;
		unstagedMarkdown: string;
	},
) {
	await files_pending_update_db_delete_chunks(ctx, { pendingUpdateId: args.pendingUpdateId });

	const chunks = await files_chunk_markdown(args.unstagedMarkdown);
	if (chunks._nay) {
		return chunks;
	}

	const fileNode = await ctx.db.get("files_nodes", args.nodeId);
	if (!fileNode || fileNode.organizationId !== args.organizationId || fileNode.workspaceId !== args.workspaceId) {
		console.error("Failed to replace pending update chunks: fileNode is missing or mismatched", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId: args.nodeId,
			pendingUpdateId: args.pendingUpdateId,
			fileNode,
		});
		return Result({ _yay: null });
	}

	const markdownChunkIds = await Promise.all(
		chunks._yay.map((chunk) =>
			ctx.db.insert("files_markdown_chunks", {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				sourceKind: "pending",
				userId: args.userId,
				fileNodeId: args.nodeId,
				pendingUpdateId: args.pendingUpdateId,
				chunkIndex: chunk.chunkIndex,
				markdownChunk: chunk.markdownChunk,
				startIndex: chunk.startIndex,
				endIndex: chunk.endIndex,
				lineStart: chunk.lineStart,
				lineEnd: chunk.lineEnd,
				chunkFlags: chunk.chunkFlags,
			}),
		),
	);

	await Promise.all(
		chunks._yay.map((chunk, index) =>
			ctx.db.insert("files_plain_text_chunks", {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				fileNodeId: args.nodeId,
				sourceKind: "pending",
				userId: args.userId,
				pendingUpdateId: args.pendingUpdateId,
				markdownChunkId: markdownChunkIds[index],
				path: fileNode.path,
				archiveOperationId: fileNode.archiveOperationId,
				chunkIndex: chunk.chunkIndex,
				plainTextChunk: chunk.plainTextChunk,
				markdownChunk: chunk.markdownChunk,
				startIndex: chunk.startIndex,
				endIndex: chunk.endIndex,
				lineStart: chunk.lineStart,
				lineEnd: chunk.lineEnd,
				chunkFlags: chunk.chunkFlags,
				hasChunkAbove: index > 0,
				hasChunkBelow: index < chunks._yay.length - 1,
			}),
		),
	);

	await files_metadata_db_replace_pending(ctx, args);

	return Result({ _yay: null });
}

/**
 * Chunk and metadata maintenance must not fail the pending update doc write: the doc is the source of truth.
 * A failure only degrades chunk-backed reads, search, and metadata search until the next upsert.
 * Stale chunks and metadata docs were already deleted, so indexed search misses instead of seeing outdated content.
 */
function files_pending_update_log_replace_chunks_nay(
	chunksReplaced: Awaited<ReturnType<typeof files_pending_update_db_replace_chunks>>,
	context: { pendingUpdateId: Id<"files_pending_updates">; nodeId: Id<"files_nodes"> },
) {
	if (chunksReplaced._nay) {
		console.error("Failed to replace pending update chunks and metadata docs", { chunksReplaced, ...context });
	}
}

function files_pending_update_workspace_markdown_to_branch(args: { mut_yjsDoc: YDoc; markdown: string }) {
	const currentMarkdown = files_yjs_doc_get_markdown({
		yjsDoc: args.mut_yjsDoc,
	});
	if (currentMarkdown._nay) {
		return currentMarkdown;
	}

	if (currentMarkdown._yay === args.markdown) {
		return Result({ _yay: false });
	}

	return files_yjs_doc_update_from_markdown({
		mut_yjsDoc: args.mut_yjsDoc,
		markdown: args.markdown,
	});
}

function files_pending_update_docs_match_content(args: { leftYjsDoc: YDoc; rightYjsDoc: YDoc }) {
	const leftMarkdown = files_yjs_doc_get_markdown({
		yjsDoc: args.leftYjsDoc,
	});
	if (leftMarkdown._nay) {
		return leftMarkdown;
	}

	const rightMarkdown = files_yjs_doc_get_markdown({
		yjsDoc: args.rightYjsDoc,
	});
	if (rightMarkdown._nay) {
		return rightMarkdown;
	}

	return Result({
		_yay: leftMarkdown._yay === rightMarkdown._yay,
	});
}

function files_pending_update_branch_docs_have_changes(args: {
	baseYjsDoc: YDoc;
	stagedBranchYjsDoc: YDoc;
	unstagedBranchYjsDoc: YDoc;
}) {
	const stagedMatchesBase = files_pending_update_docs_match_content({
		leftYjsDoc: args.baseYjsDoc,
		rightYjsDoc: args.stagedBranchYjsDoc,
	});
	if (stagedMatchesBase._nay) {
		return stagedMatchesBase;
	}

	const unstagedMatchesBase = files_pending_update_docs_match_content({
		leftYjsDoc: args.baseYjsDoc,
		rightYjsDoc: args.unstagedBranchYjsDoc,
	});
	if (unstagedMatchesBase._nay) {
		return unstagedMatchesBase;
	}

	return Result({
		_yay: !(stagedMatchesBase._yay && unstagedMatchesBase._yay),
	});
}

function files_pending_update_branch_docs_match_existing_doc(args: {
	existingPendingUpdate: app_convex_Doc<"files_pending_updates"> | null;
	baseYjsSequence: number;
	baseYjsUpdate: ArrayBuffer;
	stagedBranchYjsUpdate: ArrayBuffer;
	unstagedBranchYjsUpdate: ArrayBuffer;
}) {
	if (!args.existingPendingUpdate) {
		return false;
	}

	return (
		args.existingPendingUpdate.baseYjsSequence === args.baseYjsSequence &&
		files_u8_equals(new Uint8Array(args.existingPendingUpdate.baseYjsUpdate), new Uint8Array(args.baseYjsUpdate)) &&
		files_u8_equals(
			new Uint8Array(args.existingPendingUpdate.stagedBranchYjsUpdate),
			new Uint8Array(args.stagedBranchYjsUpdate),
		) &&
		files_u8_equals(
			new Uint8Array(args.existingPendingUpdate.unstagedBranchYjsUpdate),
			new Uint8Array(args.unstagedBranchYjsUpdate),
		)
	);
}

async function files_pending_update_resolve_branch_docs(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: string;
		nodeId: app_convex_Doc<"files_pending_updates">["fileNodeId"];
		pendingUpdateId?: app_convex_Doc<"files_pending_updates">["_id"];
		baseYjsSequence?: number;
		baseYjsUpdate?: ArrayBuffer;
	},
) {
	const existingPendingUpdate = await files_db_get_pending_update(ctx, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		userId: args.userId,
		nodeId: args.nodeId,
		pendingUpdateId: args.pendingUpdateId,
	});

	if (existingPendingUpdate) {
		return Result({
			_yay: {
				existingPendingUpdate,
				...files_pending_update_reconstruct_branch_docs(existingPendingUpdate),
			},
		});
	}

	const baseYjsSequence = args.baseYjsSequence;
	const baseYjsUpdate = args.baseYjsUpdate;
	if (baseYjsSequence === undefined || baseYjsUpdate === undefined) {
		return Result({
			_nay: {
				message: "R2-backed pending update base must be resolved by an action",
			},
		});
	}

	const baseYjsDoc = files_yjs_doc_create_from_array_buffer_update(baseYjsUpdate);

	return Result({
		_yay: {
			existingPendingUpdate: null,
			baseYjsSequence,
			baseYjsDoc,
			stagedBranchYjsDoc: files_yjs_doc_clone({
				yjsDoc: baseYjsDoc,
			}),
			unstagedBranchYjsDoc: files_yjs_doc_clone({
				yjsDoc: baseYjsDoc,
			}),
		},
	});
}

async function files_pending_update_upsert_branch_docs(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: string;
		nodeId: app_convex_Doc<"files_pending_updates">["fileNodeId"];
		existingPendingUpdate: app_convex_Doc<"files_pending_updates"> | null;
		baseYjsSequence: number;
		baseYjsDoc: YDoc;
		stagedBranchYjsDoc: YDoc;
		unstagedBranchYjsDoc: YDoc;
		unstagedMarkdown: string;
		unstagedBranchChanged: boolean;
	},
) {
	const branchDocsHaveChanges = files_pending_update_branch_docs_have_changes({
		baseYjsDoc: args.baseYjsDoc,
		stagedBranchYjsDoc: args.stagedBranchYjsDoc,
		unstagedBranchYjsDoc: args.unstagedBranchYjsDoc,
	});
	if (branchDocsHaveChanges._nay) {
		return Result({
			_nay: {
				message: "Failed to compare pending update branches with base",
				cause: branchDocsHaveChanges._nay,
			},
		});
	}

	if (!branchDocsHaveChanges._yay) {
		if (args.existingPendingUpdate) {
			await Promise.all([
				files_db_cancel_pending_update_cleanup_tasks(ctx, {
					pendingUpdateId: args.existingPendingUpdate._id,
				}),
				files_pending_update_db_delete_chunks(ctx, {
					pendingUpdateId: args.existingPendingUpdate._id,
				}),
				ctx.db.delete("files_pending_updates", args.existingPendingUpdate._id),
			]);
		}

		return Result({ _yay: null });
	}

	const baseYjsUpdate = files_pending_update_encode_yjs_state_update({
		yjsDoc: args.baseYjsDoc,
	});
	const stagedBranchYjsUpdate = files_pending_update_encode_yjs_state_update({
		yjsDoc: args.stagedBranchYjsDoc,
	});
	const unstagedBranchYjsUpdate = files_pending_update_encode_yjs_state_update({
		yjsDoc: args.unstagedBranchYjsDoc,
	});

	if (
		files_pending_update_branch_docs_match_existing_doc({
			existingPendingUpdate: args.existingPendingUpdate,
			baseYjsSequence: args.baseYjsSequence,
			baseYjsUpdate,
			stagedBranchYjsUpdate,
			unstagedBranchYjsUpdate,
		})
	) {
		return Result({ _yay: null });
	}

	const now = Date.now();
	const unstagedSize = files_get_utf8_byte_size(args.unstagedMarkdown);

	if (!args.existingPendingUpdate) {
		const pendingUpdateId = await ctx.db.insert("files_pending_updates", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			fileNodeId: args.nodeId,
			baseYjsSequence: args.baseYjsSequence,
			baseYjsUpdate,
			stagedBranchYjsUpdate,
			unstagedBranchYjsUpdate,
			size: unstagedSize,
			updatedAt: now,
		});
		await files_db_schedule_pending_update_cleanup(ctx, {
			pendingUpdateId,
			expectedUpdatedAt: now,
		});
		const chunksReplaced = await files_pending_update_db_replace_chunks(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			nodeId: args.nodeId,
			pendingUpdateId,
			unstagedMarkdown: args.unstagedMarkdown,
		});
		files_pending_update_log_replace_chunks_nay(chunksReplaced, { pendingUpdateId, nodeId: args.nodeId });
	} else {
		await Promise.all([
			ctx.db.patch("files_pending_updates", args.existingPendingUpdate._id, {
				baseYjsSequence: args.baseYjsSequence,
				baseYjsUpdate,
				stagedBranchYjsUpdate,
				unstagedBranchYjsUpdate,
				...(args.unstagedBranchChanged ? { size: unstagedSize } : {}),
				updatedAt: now,
			}),
			// Reset the pending update expiry so active pending work stays preserved.
			files_db_schedule_pending_update_cleanup(ctx, {
				pendingUpdateId: args.existingPendingUpdate._id,
				expectedUpdatedAt: now,
			}),
		]);
		// Staged-only changes (e.g. Accept all) keep the unstaged content intact, so the existing
		// pending Markdown/plain-text chunk docs and metadata docs stay correct and rebuilding them would be wasted writes.
		if (args.unstagedBranchChanged) {
			const chunksReplaced = await files_pending_update_db_replace_chunks(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				userId: args.userId,
				nodeId: args.nodeId,
				pendingUpdateId: args.existingPendingUpdate._id,
				unstagedMarkdown: args.unstagedMarkdown,
			});
			files_pending_update_log_replace_chunks_nay(chunksReplaced, {
				pendingUpdateId: args.existingPendingUpdate._id,
				nodeId: args.nodeId,
			});
		}
	}

	return Result({ _yay: null });
}

async function files_pending_update_upsert_updates(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: string;
		nodeId: app_convex_Doc<"files_pending_updates">["fileNodeId"];
		pendingUpdateId?: app_convex_Doc<"files_pending_updates">["_id"];
		baseYjsSequence?: number;
		baseYjsUpdate?: ArrayBuffer;
		stagedMarkdown?: string;
		unstagedMarkdown: string;
	},
) {
	const file = await ctx.db.get("files_nodes", args.nodeId);
	if (!file || file.organizationId !== args.organizationId || file.workspaceId !== args.workspaceId) {
		return Result({ _nay: { message: "Not found" } });
	}

	const branchDocsResult = await files_pending_update_resolve_branch_docs(ctx, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		userId: args.userId,
		nodeId: file._id,
		pendingUpdateId: args.pendingUpdateId,
		baseYjsSequence: args.baseYjsSequence,
		baseYjsUpdate: args.baseYjsUpdate,
	});
	if (branchDocsResult._nay) {
		return branchDocsResult;
	}

	const { existingPendingUpdate, baseYjsSequence, baseYjsDoc, stagedBranchYjsDoc, unstagedBranchYjsDoc } =
		branchDocsResult._yay;

	if (args.stagedMarkdown !== undefined) {
		const stagedBranchProjection = files_pending_update_workspace_markdown_to_branch({
			mut_yjsDoc: stagedBranchYjsDoc,
			markdown: args.stagedMarkdown,
		});
		if (stagedBranchProjection._nay) {
			return Result({
				_nay: {
					message: "Failed to workspace staged markdown into pending branch",
					cause: stagedBranchProjection._nay,
				},
			});
		}
	}

	const unstagedBranchProjection = files_pending_update_workspace_markdown_to_branch({
		mut_yjsDoc: unstagedBranchYjsDoc,
		markdown: args.unstagedMarkdown,
	});
	if (unstagedBranchProjection._nay) {
		return Result({
			_nay: {
				message: "Failed to workspace unstaged markdown into pending branch",
				cause: unstagedBranchProjection._nay.cause,
			},
		});
	}

	return await files_pending_update_upsert_branch_docs(ctx, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		userId: args.userId,
		nodeId: file._id,
		existingPendingUpdate,
		baseYjsSequence,
		baseYjsDoc,
		stagedBranchYjsDoc,
		unstagedBranchYjsDoc,
		unstagedMarkdown: args.unstagedMarkdown,
		// `false` means the branch already matched this markdown.
		unstagedBranchChanged: unstagedBranchProjection._yay !== false,
	});
}

export const remove_file_pending_update_if_expired = internalMutation({
	args: {
		pendingUpdateId: v.id("files_pending_updates"),
		expectedUpdatedAt: v.number(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		// Guard scheduled cleanup with `expectedUpdatedAt`: if the doc changed after you
		// created the task, treat this run as stale and do not delete the newer pending state.
		const cleanupTasks = await ctx.db
			.query("files_pending_updates_cleanup_tasks")
			.withIndex("by_pendingUpdate", (q) => q.eq("pendingUpdateId", args.pendingUpdateId))
			.collect();

		const matchingCleanupTasks = cleanupTasks.filter(
			(cleanupTask) => cleanupTask.expectedUpdatedAt === args.expectedUpdatedAt,
		);
		await Promise.all(
			matchingCleanupTasks.map((cleanupTask) => ctx.db.delete("files_pending_updates_cleanup_tasks", cleanupTask._id)),
		);

		const pendingUpdate = await ctx.db.get("files_pending_updates", args.pendingUpdateId);
		if (!pendingUpdate) {
			return null;
		}
		if (pendingUpdate.updatedAt !== args.expectedUpdatedAt) {
			return null;
		}

		await Promise.all([
			ctx.db.delete("files_pending_updates", pendingUpdate._id),
			files_pending_update_db_delete_chunks(ctx, {
				pendingUpdateId: pendingUpdate._id,
			}),
			...cleanupTasks
				.filter((cleanupTask) => cleanupTask.expectedUpdatedAt !== args.expectedUpdatedAt)
				.map((cleanupTask) => ctx.db.delete("files_pending_updates_cleanup_tasks", cleanupTask._id)),
		]);
		return null;
	},
});

export const upsert_file_pending_update_in_db = internalMutation({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		nodeId: v.id("files_nodes"),
		pendingUpdateId: v.optional(v.id("files_pending_updates")),
		baseYjsSequence: v.optional(v.number()),
		baseYjsUpdate: v.optional(v.bytes()),
		stagedMarkdown: v.optional(v.string()),
		unstagedMarkdown: v.string(),
	},
	returns: v_result({
		_yay: v.null(),
	}),
	handler: async (ctx, args) => {
		return await files_pending_update_upsert_updates(ctx, args);
	},
});

export type upsert_file_pending_update_in_db_Result =
	typeof upsert_file_pending_update_in_db extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

async function action_upsert_file_pending_update_in_db(
	ctx: ActionCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
		nodeId: Id<"files_nodes">;
		pendingUpdateId?: Id<"files_pending_updates"> | undefined;
		baseYjsSequence: number;
		baseYjsUpdate: ArrayBuffer;
		stagedMarkdown?: string | undefined;
		unstagedMarkdown: string;
	},
) {
	const result = (await ctx.runMutation(
		internal.files_pending_updates.upsert_file_pending_update_in_db,
		args,
	)) as upsert_file_pending_update_in_db_Result;

	return result;
}

export const upsert_file_pending_update = action({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
		pendingUpdateId: v.optional(v.id("files_pending_updates")),
		stagedMarkdown: v.optional(v.string()),
		unstagedMarkdown: v.string(),
	},
	returns: v_result({
		_yay: v.null(),
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}
		const membership = await ctx.runQuery(api.organizations.get_membership, {
			membershipId: args.membershipId,
		});
		if (!membership || membership.userId !== userAuth.id) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "files_pending_update_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const base = await files_pending_update_action_get_latest_file_yjs_state(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			nodeId: args.nodeId,
		});
		if (base._nay) {
			return Result({ _nay: base._nay });
		}

		const upserted = await action_upsert_file_pending_update_in_db(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: userAuth.id,
			nodeId: args.nodeId,
			pendingUpdateId: args.pendingUpdateId,
			baseYjsSequence: base._yay.baseYjsSequence,
			baseYjsUpdate: base._yay.baseYjsUpdate,
			stagedMarkdown: args.stagedMarkdown,
			unstagedMarkdown: args.unstagedMarkdown,
		});
		if (upserted._nay) {
			return Result({ _nay: upserted._nay });
		}

		return Result({ _yay: null });
	},
});

export const upsert_file_pending_update_internal_action = internalAction({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		nodeId: v.id("files_nodes"),
		pendingUpdateId: v.optional(v.id("files_pending_updates")),
		stagedMarkdown: v.optional(v.string()),
		unstagedMarkdown: v.string(),
	},
	returns: v_result({
		_yay: v.null(),
	}),
	handler: async (ctx, args) => {
		const base = await files_pending_update_action_get_latest_file_yjs_state(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId: args.nodeId,
		});
		if (base._nay) {
			return Result({ _nay: base._nay });
		}

		const upserted = await action_upsert_file_pending_update_in_db(ctx, {
			...args,
			baseYjsSequence: base._yay.baseYjsSequence,
			baseYjsUpdate: base._yay.baseYjsUpdate,
		});
		if (upserted._nay) {
			return Result({ _nay: upserted._nay });
		}

		return Result({ _yay: null });
	},
});

export const persist_file_pending_update_rebased_state_in_db = internalMutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
		pendingUpdateId: v.optional(v.id("files_pending_updates")),
		baseYjsSequence: v.number(),
		baseYjsUpdate: v.bytes(),
		latestBaseYjsSequence: v.number(),
		latestBaseYjsUpdate: v.bytes(),
		stagedBranchYjsUpdate: v.bytes(),
		unstagedBranchYjsUpdate: v.bytes(),
	},
	returns: v_result({
		_yay: v.object({
			pendingUpdate: v.union(doc(app_convex_schema, "files_pending_updates"), v.null()),
		}),
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}
		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const existingPendingUpdate = await files_db_get_pending_update(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: userAuth.id,
			nodeId: args.nodeId,
			pendingUpdateId: args.pendingUpdateId,
		});
		if (
			args.baseYjsSequence !== args.latestBaseYjsSequence ||
			!files_u8_equals(new Uint8Array(args.baseYjsUpdate), new Uint8Array(args.latestBaseYjsUpdate))
		) {
			return Result({
				_nay: {
					message: "Pending update base is stale and must be rebuilt from the latest live file state",
				},
			});
		}

		const baseYjsDoc = files_yjs_doc_create_from_array_buffer_update(args.baseYjsUpdate);
		const stagedBranchYjsDoc = files_yjs_doc_create_from_array_buffer_update(args.stagedBranchYjsUpdate);
		const unstagedBranchYjsDoc = files_yjs_doc_create_from_array_buffer_update(args.unstagedBranchYjsUpdate);

		const branchDocsHaveChanges = files_pending_update_branch_docs_have_changes({
			baseYjsDoc,
			stagedBranchYjsDoc,
			unstagedBranchYjsDoc,
		});
		if (branchDocsHaveChanges._nay) {
			return Result({
				_nay: {
					message: "Failed to compare rebased pending update branches with base",
					cause: branchDocsHaveChanges._nay,
				},
			});
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "files_pending_update_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		if (!branchDocsHaveChanges._yay) {
			if (existingPendingUpdate) {
				await Promise.all([
					files_db_cancel_pending_update_cleanup_tasks(ctx, {
						pendingUpdateId: existingPendingUpdate._id,
					}),
					files_pending_update_db_delete_chunks(ctx, {
						pendingUpdateId: existingPendingUpdate._id,
					}),
					ctx.db.delete("files_pending_updates", existingPendingUpdate._id),
				]);
			}

			return Result({
				_yay: {
					pendingUpdate: null,
				},
			});
		}

		if (
			files_pending_update_branch_docs_match_existing_doc({
				existingPendingUpdate,
				baseYjsSequence: args.baseYjsSequence,
				baseYjsUpdate: args.baseYjsUpdate,
				stagedBranchYjsUpdate: args.stagedBranchYjsUpdate,
				unstagedBranchYjsUpdate: args.unstagedBranchYjsUpdate,
			})
		) {
			return Result({
				_yay: {
					pendingUpdate: existingPendingUpdate,
				},
			});
		}

		const unstagedMarkdown = files_yjs_doc_get_markdown({ yjsDoc: unstagedBranchYjsDoc });
		if (unstagedMarkdown._nay) {
			return Result({
				_nay: {
					message: "Failed to serialize rebased unstaged branch for pending update",
					cause: unstagedMarkdown._nay,
				},
			});
		}
		const now = Date.now();
		let pendingUpdateId = existingPendingUpdate?._id ?? null;

		if (!existingPendingUpdate) {
			pendingUpdateId = await ctx.db.insert("files_pending_updates", {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: userAuth.id,
				fileNodeId: args.nodeId,
				baseYjsSequence: args.baseYjsSequence,
				baseYjsUpdate: args.baseYjsUpdate,
				stagedBranchYjsUpdate: args.stagedBranchYjsUpdate,
				unstagedBranchYjsUpdate: args.unstagedBranchYjsUpdate,
				size: files_get_utf8_byte_size(unstagedMarkdown._yay),
				updatedAt: now,
			});
		} else {
			await Promise.all([
				ctx.db.patch("files_pending_updates", existingPendingUpdate._id, {
					baseYjsSequence: args.baseYjsSequence,
					baseYjsUpdate: args.baseYjsUpdate,
					stagedBranchYjsUpdate: args.stagedBranchYjsUpdate,
					unstagedBranchYjsUpdate: args.unstagedBranchYjsUpdate,
					size: files_get_utf8_byte_size(unstagedMarkdown._yay),
					updatedAt: now,
				}),
				// Refresh the expiry window from this latest doc version because rebasing
				// changes the authoritative pending snapshot.
				files_db_schedule_pending_update_cleanup(ctx, {
					pendingUpdateId: existingPendingUpdate._id,
					expectedUpdatedAt: now,
				}),
			]);
		}
		const schedulePendingUpdateCleanupPromise =
			pendingUpdateId && !existingPendingUpdate
				? // Reset the pending update expiry on rebase.
					files_db_schedule_pending_update_cleanup(ctx, {
						pendingUpdateId,
						expectedUpdatedAt: now,
					})
				: null;

		// Rebase rewrites the unstaged branch, so always refresh pending Markdown/plain-text chunk docs and metadata docs.
		if (pendingUpdateId) {
			const chunksReplaced = await files_pending_update_db_replace_chunks(ctx, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: userAuth.id,
				nodeId: args.nodeId,
				pendingUpdateId,
				unstagedMarkdown: unstagedMarkdown._yay,
			});
			files_pending_update_log_replace_chunks_nay(chunksReplaced, { pendingUpdateId, nodeId: args.nodeId });
		}

		const [, nextPendingUpdate] = await Promise.all([
			schedulePendingUpdateCleanupPromise,
			pendingUpdateId ? ctx.db.get("files_pending_updates", pendingUpdateId) : Promise.resolve(null),
		]);
		if (!nextPendingUpdate) {
			return Result({
				_nay: {
					message: "Failed to read persisted rebased pending update doc",
				},
			});
		}

		return Result({
			_yay: {
				pendingUpdate: nextPendingUpdate,
			},
		});
	},
});

export type persist_file_pending_update_rebased_state_in_db_Result =
	typeof persist_file_pending_update_rebased_state_in_db extends RegisteredMutation<
		infer _Visibility,
		infer _Args,
		infer ReturnValue
	>
		? Awaited<ReturnValue>
		: never;

async function action_persist_file_pending_update_rebased_state_in_db(
	ctx: ActionCtx,
	args: {
		membershipId: app_convex_Doc<"organizations_workspaces_users">["_id"];
		nodeId: app_convex_Doc<"files_pending_updates">["fileNodeId"];
		pendingUpdateId?: app_convex_Doc<"files_pending_updates">["_id"] | undefined;
		baseYjsSequence: number;
		baseYjsUpdate: ArrayBuffer;
		latestBaseYjsSequence: number;
		latestBaseYjsUpdate: ArrayBuffer;
		stagedBranchYjsUpdate: ArrayBuffer;
		unstagedBranchYjsUpdate: ArrayBuffer;
	},
) {
	const result = (await ctx.runMutation(
		internal.files_pending_updates.persist_file_pending_update_rebased_state_in_db,
		args,
	)) as persist_file_pending_update_rebased_state_in_db_Result;

	return result;
}

export const persist_file_pending_update_rebased_state = action({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
		pendingUpdateId: v.optional(v.id("files_pending_updates")),
		baseYjsSequence: v.number(),
		baseYjsUpdate: v.bytes(),
		stagedBranchYjsUpdate: v.bytes(),
		unstagedBranchYjsUpdate: v.bytes(),
	},
	returns: v_result({
		_yay: v.object({
			pendingUpdate: v.union(doc(app_convex_schema, "files_pending_updates"), v.null()),
		}),
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}
		const membership = await ctx.runQuery(api.organizations.get_membership, {
			membershipId: args.membershipId,
		});
		if (!membership || membership.userId !== userAuth.id) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const latestBase = await files_pending_update_action_get_latest_file_yjs_state(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			nodeId: args.nodeId,
		});
		if (latestBase._nay) {
			return Result({ _nay: latestBase._nay });
		}

		const persisted = await action_persist_file_pending_update_rebased_state_in_db(ctx, {
			...args,
			latestBaseYjsSequence: latestBase._yay.baseYjsSequence,
			latestBaseYjsUpdate: latestBase._yay.baseYjsUpdate,
		});
		if (persisted._nay) {
			return Result({ _nay: persisted._nay });
		}

		return Result({ _yay: persisted._yay });
	},
});

export const get_file_pending_update = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
		pendingUpdateId: v.optional(v.id("files_pending_updates")),
	},
	returns: v.union(doc(app_convex_schema, "files_pending_updates"), v.null()),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			throw convex_error({ message: "Unauthenticated" });
		}
		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return null;
		}

		return await files_db_get_pending_update(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: userAuth.id,
			nodeId: args.nodeId,
			pendingUpdateId: args.pendingUpdateId,
		});
	},
});

export const get_file_pending_update_internal = internalQuery({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		nodeId: v.id("files_nodes"),
		pendingUpdateId: v.optional(v.id("files_pending_updates")),
	},
	returns: v.union(doc(app_convex_schema, "files_pending_updates"), v.null()),
	handler: async (ctx, args) => {
		return await files_db_get_pending_update(ctx, args);
	},
});

export const list_files_pending_updates = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
	},
	returns: v.array(doc(app_convex_schema, "files_pending_updates")),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			throw convex_error({ message: "Unauthenticated" });
		}
		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return [];
		}

		const filesPendingUpdates = await ctx.db
			.query("files_pending_updates")
			.withIndex("by_organization_workspace_user_fileNode", (q) =>
				q.eq("organizationId", membership.organizationId).eq("workspaceId", membership.workspaceId).eq("userId", userAuth.id),
			)
			.order("asc")
			.collect();

		return filesPendingUpdates;
	},
});

export const get_file_pending_update_last_sequence_saved = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
	},
	returns: v.union(doc(app_convex_schema, "files_pending_updates_last_sequence_saved"), v.null()),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			throw convex_error({ message: "Unauthenticated" });
		}
		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return null;
		}

		return await ctx.db
			.query("files_pending_updates_last_sequence_saved")
			.withIndex("by_organization_workspace_user_fileNode", (q) =>
				q
					.eq("organizationId", membership.organizationId)
					.eq("workspaceId", membership.workspaceId)
					.eq("userId", userAuth.id)
					.eq("fileNodeId", args.nodeId),
			)
			.first();
	},
});

export const save_file_pending_update_in_db = internalMutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
		pendingUpdateId: v.optional(v.id("files_pending_updates")),
		baseYjsSequence: v.number(),
		baseYjsUpdate: v.bytes(),
	},
	returns: v_result({
		_yay: v.object({
			newSequence: v.union(v.number(), v.null()),
		}),
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "save_file_pending_update", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const user = await ctx.db.get("users", userAuth.id);
		if (!user) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}
		const membership = await organizations_db_get_membership(ctx, {
			userId: user._id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const pendingUpdate = await files_db_get_pending_update(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: user._id,
			nodeId: args.nodeId,
			pendingUpdateId: args.pendingUpdateId,
		});

		if (!pendingUpdate) {
			return Result({
				_nay: {
					message: "Not found",
				},
			});
		}

		const reconstructedBranchDocs = files_pending_update_reconstruct_branch_docs(pendingUpdate);
		const baseYjsDoc = reconstructedBranchDocs.baseYjsDoc;
		const stagedBranchYjsDoc = reconstructedBranchDocs.stagedBranchYjsDoc;
		const unstagedBranchYjsDoc = reconstructedBranchDocs.unstagedBranchYjsDoc;
		const latestFileYjsDoc = files_yjs_doc_create_from_array_buffer_update(args.baseYjsUpdate);

		const remoteUpdateFromBase = files_yjs_compute_diff_update_from_yjs_doc({
			yjsDoc: latestFileYjsDoc,
			yjsBeforeDoc: baseYjsDoc,
		});
		if (remoteUpdateFromBase) {
			const remoteUpdateFromBaseArrayBuffer = files_u8_to_array_buffer(remoteUpdateFromBase);
			files_yjs_doc_apply_array_buffer_update(stagedBranchYjsDoc, remoteUpdateFromBaseArrayBuffer);
			files_yjs_doc_apply_array_buffer_update(unstagedBranchYjsDoc, remoteUpdateFromBaseArrayBuffer);
		}

		const diffUpdateForLatestFileYjsDoc = files_yjs_compute_diff_update_from_yjs_doc({
			yjsDoc: stagedBranchYjsDoc,
			yjsBeforeDoc: latestFileYjsDoc,
		});

		let newSequence: number | null = null;
		const liveFileYjsDocAfterSave = files_yjs_doc_clone({
			yjsDoc: latestFileYjsDoc,
		});
		if (diffUpdateForLatestFileYjsDoc) {
			const organization = await ctx.db.get("organizations", membership.organizationId);
			if (!organization) {
				const errorMessage = "membership.organizationId points to a missing organizations doc";
				const errorData = {
					membershipId: membership._id,
					organizationId: membership.organizationId,
					workspaceId: membership.workspaceId,
					nodeId: args.nodeId,
					pendingUpdateId: args.pendingUpdateId,
				};
				console.error(errorMessage, errorData);
				throw should_never_happen(errorMessage, errorData);
			}
			const billedUserId = billing_pick_billed_user_id({
				userId: user._id,
				organization,
			});
			const billedUser = await ctx.db.get("users", billedUserId);
			if (!billedUser) {
				const errorMessage = "billedUserId points to a missing users doc";
				const errorData = {
					userId: user._id,
					organizationId: organization._id,
					billedUserId,
				};
				console.error(errorMessage, errorData);
				throw should_never_happen(errorMessage, errorData);
			}

			const check = await billing_db_check_credits(ctx, {
				userId: billedUser._id,
				minimumRequiredCents: 1,
			});
			if (!check.hasCredits) {
				return Result({
					_nay: {
						message: "Insufficient funds",
					},
				});
			}
			const result = await files_db_yjs_push_update(ctx, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				nodeId: args.nodeId,
				update: files_u8_to_array_buffer(diffUpdateForLatestFileYjsDoc),
				sessionId: `files_pending_update:${user._id}`,
				userId: user._id,
			});
			if (result._nay) {
				return result;
			}

			newSequence = result._yay.newSequence;
			await billing_ingest_events(ctx, {
				billedUserEvents: [
					{
						billedUser,
						event: billing_event({
							name: "file_save",
							externalCustomerId: billedUser._id,
							externalMemberId: user._id,
							externalId: composite_id(
								"billing",
								"file_save",
								billedUser._id,
								user._id,
								membership.organizationId,
								membership.workspaceId,
								args.nodeId,
								result._yay.newSequence,
							),
							metadata: {
								amount: 1,
								actorUserId: user._id,
								billedUserId: billedUser._id,
								organizationId: membership.organizationId,
								workspaceId: membership.workspaceId,
								nodeId: args.nodeId,
								yjsSequence: String(result._yay.newSequence),
							},
						}),
					},
				],
			});
			files_yjs_doc_apply_array_buffer_update(
				liveFileYjsDocAfterSave,
				files_u8_to_array_buffer(diffUpdateForLatestFileYjsDoc),
			);
		}

		const unstagedMatchesSavedBase = files_pending_update_docs_match_content({
			leftYjsDoc: liveFileYjsDocAfterSave,
			rightYjsDoc: unstagedBranchYjsDoc,
		});
		if (unstagedMatchesSavedBase._nay) {
			return Result({
				_nay: {
					message: "Failed to compare unstaged pending branch with saved file content",
					cause: unstagedMatchesSavedBase._nay,
				},
			});
		}

		const now = Date.now();
		const nextBaseYjsSequence = newSequence ?? args.baseYjsSequence;

		if (unstagedMatchesSavedBase._yay) {
			await Promise.all([
				files_pending_update_upsert_last_sequence_saved(ctx, {
					organizationId: membership.organizationId,
					workspaceId: membership.workspaceId,
					userId: user._id,
					nodeId: args.nodeId,
					lastSequenceSaved: nextBaseYjsSequence,
					updatedAt: now,
				}),
				files_db_cancel_pending_update_cleanup_tasks(ctx, {
					pendingUpdateId: pendingUpdate._id,
				}),
				files_pending_update_db_delete_chunks(ctx, {
					pendingUpdateId: pendingUpdate._id,
				}),
				ctx.db.delete("files_pending_updates", pendingUpdate._id),
			]);

			return Result({
				_yay: {
					newSequence,
				},
			});
		}

		const nextBaseYjsUpdate = files_pending_update_encode_yjs_state_update({
			yjsDoc: liveFileYjsDocAfterSave,
		});
		const unstagedMarkdownAfterRemoteDrift = remoteUpdateFromBase
			? files_yjs_doc_get_markdown({ yjsDoc: unstagedBranchYjsDoc })
			: null;
		if (unstagedMarkdownAfterRemoteDrift?._nay) {
			return Result({
				_nay: {
					message: "Failed to serialize unstaged branch after partial save",
					cause: unstagedMarkdownAfterRemoteDrift._nay,
				},
			});
		}

		await Promise.all([
			ctx.db.patch("files_pending_updates", pendingUpdate._id, {
				baseYjsSequence: nextBaseYjsSequence,
				baseYjsUpdate: nextBaseYjsUpdate,
				stagedBranchYjsUpdate: nextBaseYjsUpdate,
				unstagedBranchYjsUpdate: files_pending_update_encode_yjs_state_update({
					yjsDoc: unstagedBranchYjsDoc,
				}),
				...(unstagedMarkdownAfterRemoteDrift
					? { size: files_get_utf8_byte_size(unstagedMarkdownAfterRemoteDrift._yay) }
					: {}),
				updatedAt: now,
			}),
			// Partial saves must keep the pending update alive. Reset the expire of the pending update doc.
			files_db_schedule_pending_update_cleanup(ctx, {
				pendingUpdateId: pendingUpdate._id,
				expectedUpdatedAt: now,
			}),
			files_pending_update_upsert_last_sequence_saved(ctx, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: user._id,
				nodeId: args.nodeId,
				lastSequenceSaved: nextBaseYjsSequence,
				updatedAt: now,
			}),
		]);

		// Remote drift merged into the unstaged branch changes its content, so pending Markdown/plain-text chunk docs and metadata docs
		// must be rebuilt; without drift the unstaged content is unchanged by a partial save.
		if (unstagedMarkdownAfterRemoteDrift) {
			const unstagedMarkdown = unstagedMarkdownAfterRemoteDrift;
			const chunksReplaced = await files_pending_update_db_replace_chunks(ctx, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: user._id,
				nodeId: args.nodeId,
				pendingUpdateId: pendingUpdate._id,
				unstagedMarkdown: unstagedMarkdown._yay,
			});
			files_pending_update_log_replace_chunks_nay(chunksReplaced, {
				pendingUpdateId: pendingUpdate._id,
				nodeId: args.nodeId,
			});
		}

		return Result({
			_yay: {
				newSequence,
			},
		});
	},
});

export type save_file_pending_update_in_db_Result =
	typeof save_file_pending_update_in_db extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

async function action_save_file_pending_update_in_db(
	ctx: ActionCtx,
	args: {
		membershipId: app_convex_Doc<"organizations_workspaces_users">["_id"];
		nodeId: app_convex_Doc<"files_pending_updates">["fileNodeId"];
		pendingUpdateId?: app_convex_Doc<"files_pending_updates">["_id"] | undefined;
		baseYjsSequence: number;
		baseYjsUpdate: ArrayBuffer;
	},
) {
	const result = (await ctx.runMutation(
		internal.files_pending_updates.save_file_pending_update_in_db,
		args,
	)) as save_file_pending_update_in_db_Result;

	return result;
}

export const save_file_pending_update = action({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
		pendingUpdateId: v.optional(v.id("files_pending_updates")),
	},
	returns: v_result({
		_yay: v.object({
			newSequence: v.union(v.number(), v.null()),
		}),
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}
		const membership = await ctx.runQuery(api.organizations.get_membership, {
			membershipId: args.membershipId,
		});
		if (!membership || membership.userId !== userAuth.id) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const base = await files_pending_update_action_get_latest_file_yjs_state(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			nodeId: args.nodeId,
		});
		if (base._nay) {
			return Result({ _nay: base._nay });
		}

		const saved = await action_save_file_pending_update_in_db(ctx, {
			...args,
			baseYjsSequence: base._yay.baseYjsSequence,
			baseYjsUpdate: base._yay.baseYjsUpdate,
		});
		if (saved._nay) {
			return Result({ _nay: saved._nay });
		}

		return Result({ _yay: saved._yay });
	},
});
