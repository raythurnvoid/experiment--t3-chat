// File content creation, materialization, snapshot restore, and content-read fallbacks.
//
// Lives in its own module because this code needs the tiptap Markdown pipeline
// (`shared/files-tiptap.ts`) and mastra chunking (`server/files-markdown-chunking-mastra.ts`),
// which are heavy to evaluate. Keeping it out of `files_nodes.ts` keeps the hot file-tree
// module cheap to load.

import {
	action,
	internalAction,
	internalMutation,
	internalQuery,
	type ActionCtx,
	type MutationCtx,
} from "./_generated/server.js";
import type { Doc, Id } from "./_generated/dataModel";
import { type RegisteredAction, type RegisteredMutation, type RegisteredQuery } from "convex/server";
import type { Editor } from "@tiptap/core";
import { server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";
import { v, type Infer } from "convex/values";
import {
	files_ROOT_ID,
	files_INITIAL_CONTENT,
	files_u8_to_array_buffer,
	files_MAX_TEXT_CONTENT_BYTES,
	files_get_utf8_byte_size,
	files_node_has_editable_yjs_state,
	files_pending_update_content_of,
	files_db_get_visible_node_by_path,
	type files_ContentType,
	type files_SpecialFileName,
} from "../server/files.ts";
import {
	files_yjs_create_empty_state_update,
	files_yjs_doc_create_from_array_buffer_update,
	files_yjs_doc_create_from_tiptap_editor,
	files_yjs_compute_diff_update_from_state_vector,
} from "../shared/files-yjs.ts";
import {
	files_headless_tiptap_editor_create,
	files_headless_tiptap_editor_set_content_from_markdown,
	files_yjs_doc_get_markdown,
	files_yjs_doc_update_from_markdown,
} from "../shared/files-tiptap.ts";
import { files_chunk_markdown } from "../server/files-markdown-chunking-mastra.ts";
import { files_chunk_plain_text } from "../server/files-plain-text-chunking.ts";
import { Result, Result_all } from "common/errors-as-values-utils.ts";
import { encodeStateVector, encodeStateAsUpdate, mergeUpdates } from "yjs";
import { composite_id, should_never_happen } from "../shared/shared-utils.ts";
import {
	organizations_is_global_organization_id,
	organizations_is_reserved_workspace_id,
	organizations_GLOBAL_ORGANIZATION_ID,
	organizations_GLOBAL_GITHUB_WORKSPACE_ID,
	organizations_GLOBAL_PLUGINS_WORKSPACE_ID,
} from "../shared/organizations.ts";
import { users_SYSTEM_AUTHOR } from "../shared/users.ts";
import app_convex_schema from "./schema.ts";
import { api, internal } from "./_generated/api.js";
import { doc } from "convex-helpers/validators";
import { billing_event } from "../server/billing.ts";
import { convex_error, v_result } from "../server/convex-utils.ts";
import { organizations_db_get_membership } from "./organizations.ts";
import { access_control_db_authorize_node, access_control_db_filter_readable_file_nodes } from "./access_control.ts";
import { billing_db_check_credits, billing_pick_billed_user_id, billing_ingest_events } from "./billing_db.ts";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";
import { files_metadata_db_delete_committed, files_metadata_db_insert_committed } from "./files_metadata.ts";
import {
	r2_create_asset_key,
	r2_delete_object,
	r2_fetch_object_from_bucket,
	r2_fetch_object_range_from_bucket,
	r2_put_object,
} from "./r2_client.ts";
import {
	authorize_file_write,
	db_get_file_content_materialization_db_state,
	db_get_file_snapshot_content,
	db_upsert_file_stats,
	enqueue_file_content_materialization,
	file_content_materialization_state_validator,
	files_READ_RANGE_MAX_LINES,
	files_line_range_from_text,
	files_merge_contiguous_chunks,
	files_nodes_db_create_node_recursively_at_path,
	files_tail_lines_from_text,
	yjs_increment_or_create_last_sequence,
	type files_nodes_read_committed_file_chunk_stats_Result,
	type files_nodes_read_committed_file_chunks_line_range_Result,
	type files_nodes_read_file_content_from_chunks_Result,
	type get_file_content_materialization_state_Result,
} from "./files_nodes.ts";

// Make Convex reuse the loaded module between calls, so warm calls skip the module load cost.
// Does NOT work for http actions (see http.ts). No mutable module-level state allowed here.
export const experimental_reuseContext = true;

/**
 * Insert a paired set of committed `files_markdown_chunks` + `files_plain_text_chunks` for one file node.
 * Editable Markdown materialization passes a real `yjsSequence`; read-only text materialization omits it.
 * Caller supplies the already-computed chunk array and the denormalized `path`/`archiveOperationId` for the
 * plain-text docs. Does not touch `file_stats` or `files_metadata_docs` — callers own those.
 */
async function db_insert_committed_text_chunks(
	ctx: MutationCtx,
	args: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		nodeId: Id<"files_nodes">;
		path: string;
		archiveOperationId?: string;
		yjsSequence?: number;
		chunks: ReadonlyArray<{
			chunkIndex: number;
			markdownChunk: string;
			plainTextChunk: string;
			startIndex: number;
			endIndex: number;
			lineStart: number;
			lineEnd: number;
			chunkFlags: number;
		}>;
	},
) {
	// An empty chunk list naturally performs no inserts.
	const markdownChunkIds = await Promise.all(
		args.chunks.map((chunk) =>
			ctx.db.insert("files_markdown_chunks", {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				fileNodeId: args.nodeId,
				sourceKind: "committed",
				...(args.yjsSequence === undefined ? {} : { yjsSequence: args.yjsSequence }),
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
		args.chunks.map((chunk, index) =>
			ctx.db.insert("files_plain_text_chunks", {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				fileNodeId: args.nodeId,
				sourceKind: "committed",
				...(args.yjsSequence === undefined ? {} : { yjsSequence: args.yjsSequence }),
				markdownChunkId: markdownChunkIds[index],
				chunkIndex: chunk.chunkIndex,
				path: args.path,
				archiveOperationId: args.archiveOperationId,
				plainTextChunk: chunk.plainTextChunk,
				markdownChunk: chunk.markdownChunk,
				startIndex: chunk.startIndex,
				endIndex: chunk.endIndex,
				lineStart: chunk.lineStart,
				lineEnd: chunk.lineEnd,
				chunkFlags: chunk.chunkFlags,
				hasChunkAbove: index > 0,
				hasChunkBelow: index < args.chunks.length - 1,
			}),
		),
	);
}

export async function db_insert_file_text_content(
	ctx: MutationCtx,
	args: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		nodeId: Id<"files_nodes">;
		path: string;
		archiveOperationId?: string;
		yjsSequence?: number;
		contentType: Doc<"files_nodes">["contentType"];
		textContent: string;
	},
) {
	const isMarkdown = args.contentType?.startsWith("text/markdown") ?? false;
	const isPlainText = args.contentType?.startsWith("text/plain") ?? false;
	if (!isMarkdown && !isPlainText) {
		const errorMessage = "Unsupported text content type";
		const errorData = {
			contentType: args.contentType,
			nodeId: args.nodeId,
		};
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}

	const chunks = isMarkdown
		? await files_chunk_markdown(args.textContent)
		: Result({ _yay: files_chunk_plain_text(args.textContent) });
	if (chunks._nay) {
		return chunks;
	}

	await db_insert_committed_text_chunks(ctx, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		nodeId: args.nodeId,
		path: args.path,
		archiveOperationId: args.archiveOperationId,
		yjsSequence: args.yjsSequence,
		chunks: chunks._yay,
	});

	if (isMarkdown) {
		await files_metadata_db_insert_committed(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId: args.nodeId,
			yjsSequence: args.yjsSequence,
			markdownContent: args.textContent,
		});
	}

	const counts = files_compute_wc_counts(args.textContent);
	await db_upsert_file_stats(ctx, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		nodeId: args.nodeId,
		lineCount: counts.lineCount,
		wordCount: counts.wordCount,
		charCount: counts.charCount,
	});

	return Result({ _yay: null });
}

export async function db_replace_file_chunks(
	ctx: MutationCtx,
	args: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		nodeId: Id<"files_nodes">;
		yjsSequence: number;
		markdownContent: string;
	},
) {
	const fileNode = await ctx.db.get("files_nodes", args.nodeId);
	if (
		!fileNode ||
		fileNode.organizationId !== args.organizationId ||
		fileNode.workspaceId !== args.workspaceId ||
		fileNode.kind !== "file"
	) {
		const errorMessage = "db_replace_file_chunks expected a file node in the same organization/workspace";
		console.error(errorMessage, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId: args.nodeId,
			fileNode,
		});
		throw should_never_happen(errorMessage);
	}

	// Delete existing committed chunk/metadata docs.
	await Promise.all([
		ctx.db
			.query("files_plain_text_chunks")
			.withIndex("by_organization_workspace_source_fileNode_yjsSequence_chunkIndex", (q) =>
				q
					.eq("organizationId", args.organizationId)
					.eq("workspaceId", args.workspaceId)
					.eq("sourceKind", "committed")
					.eq("fileNodeId", args.nodeId),
			)
			.collect(),
		ctx.db
			.query("files_markdown_chunks")
			.withIndex("by_organization_workspace_source_fileNode_yjsSeq_chunk", (q) =>
				q
					.eq("organizationId", args.organizationId)
					.eq("workspaceId", args.workspaceId)
					.eq("sourceKind", "committed")
					.eq("fileNodeId", args.nodeId),
			)
			.collect(),
		files_metadata_db_delete_committed(ctx, args),
	]).then(([plainTextChunkDocs, markdownChunkDocs]) =>
		Promise.all([
			...plainTextChunkDocs.map((doc) => ctx.db.delete("files_plain_text_chunks", doc._id)),
			...markdownChunkDocs.map((doc) => ctx.db.delete("files_markdown_chunks", doc._id)),
		]),
	);

	return db_insert_file_text_content(ctx, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		nodeId: args.nodeId,
		path: fileNode.path,
		archiveOperationId: fileNode.archiveOperationId,
		yjsSequence: args.yjsSequence,
		contentType: "text/markdown;charset=utf-8",
		textContent: args.markdownContent,
	});
}

export function files_nodes_create_yjs_snapshot_update_from_markdown(markdownContent: string) {
	if (!markdownContent) {
		return Result({ _yay: files_u8_to_array_buffer(files_yjs_create_empty_state_update()) });
	}

	const editor = files_headless_tiptap_editor_create();
	if (editor._nay) {
		return editor;
	}

	const markdownContentSet = files_headless_tiptap_editor_set_content_from_markdown({
		markdown: markdownContent,
		mut_editor: editor._yay,
	});
	if (markdownContentSet._nay) {
		return markdownContentSet;
	}

	return Result({
		_yay: files_u8_to_array_buffer(
			yjs_create_state_update_from_tiptap_editor({
				tiptapEditor: editor._yay,
			}),
		),
	});
}

/**
 * Insert the content docs for a just-created file node, in the same mutation that inserted the
 * node (`db_insert_node` in files_nodes.ts with `expectsTextContent: true`). Read-only files get
 * committed chunks + real stats only; editable files also get their Yjs snapshot doc, the
 * last-sequence doc, and the node patch linking both. This is the former `db_insert_node` text
 * branch; it lives here because chunking needs mastra. Failures throw so Convex rolls back the
 * node and every related doc created in the mutation.
 */
export async function files_nodes_db_insert_file_content_docs(
	ctx: MutationCtx,
	args: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		nodeId: Id<"files_nodes">;
		path: string;
		/** Only used for error logging when the editable content docs fail to insert. */
		parentId?: Doc<"files_nodes">["parentId"];
		archiveOperationId?: Doc<"files_nodes">["archiveOperationId"];
		contentType: Doc<"files_nodes">["contentType"];
		textContent: string;
		readOnly: boolean;
		yjsSnapshotAssetId?: Id<"files_r2_assets">;
		userId: Doc<"files_nodes">["createdBy"];
		now: number;
	},
) {
	const initialYjsSequence = 0;

	if (args.readOnly === true) {
		await db_insert_file_text_content(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId: args.nodeId,
			path: args.path,
			archiveOperationId: args.archiveOperationId,
			contentType: args.contentType,
			textContent: args.textContent,
		}).then((chunks) => {
			if (chunks._nay) {
				throw convex_error({
					message: "Failed to chunk",
					cause: chunks._nay,
				});
			}
			return chunks;
		});

		return;
	}

	// Writable files need editable Yjs docs, so they cannot live in the reserved global organization.
	// Reserved external resources are identified by organizationId; SYSTEM and the reserved workspace id are
	// valid only inside that global organization.
	if (organizations_is_global_organization_id(args.organizationId)) {
		const errorMessage = "Editable text content requires a real organizationId";
		const errorData = { organizationId: args.organizationId, workspaceId: args.workspaceId, nodeId: args.nodeId };
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}
	if (organizations_is_reserved_workspace_id(args.workspaceId)) {
		const errorMessage = "Editable text content requires a real workspaceId";
		const errorData = { organizationId: args.organizationId, workspaceId: args.workspaceId, nodeId: args.nodeId };
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}
	if (args.userId === users_SYSTEM_AUTHOR) {
		const errorMessage = "Editable text content requires a real user id";
		const errorData = { organizationId: args.organizationId, workspaceId: args.workspaceId, nodeId: args.nodeId };
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}

	if (!args.yjsSnapshotAssetId) {
		const errorMessage = "fileNode.yjsSnapshotId asset is not set";
		const errorData = {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId: args.nodeId,
		};
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}
	const yjsSnapshotAssetId = args.yjsSnapshotAssetId;

	const [yjs_snapshot_id, yjs_last_sequence_id] = await Promise.all([
		ctx.db.insert("files_yjs_snapshots", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			fileNodeId: args.nodeId,
			sequence: 0,
			assetId: yjsSnapshotAssetId,
			createdBy: args.userId,
			updatedBy: args.userId,
			updatedAt: args.now,
		}),
		ctx.db.insert("files_yjs_docs_last_sequences", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			fileNodeId: args.nodeId,
			lastSequence: initialYjsSequence,
		}),
		db_insert_file_text_content(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId: args.nodeId,
			path: args.path,
			archiveOperationId: args.archiveOperationId,
			yjsSequence: initialYjsSequence,
			contentType: args.contentType,
			textContent: args.textContent,
		}).then((chunks) => {
			if (chunks._nay) {
				throw convex_error({
					message: "Failed to chunk",
					cause: chunks._nay,
				});
			}
			return chunks;
		}),
	] as const).catch((error) => {
		const errorMessage = "Failed to create file content docs";
		console.error(errorMessage, {
			error,
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			parentId: args.parentId,
			nodeId: args.nodeId,
			yjsSequence: initialYjsSequence,
		});
		// Throw so Convex rolls back the node and all related file docs created in this mutation.
		throw convex_error({
			message: errorMessage,
			cause: error,
		});
	});

	await ctx.db.patch("files_nodes", args.nodeId, {
		yjsLastSequenceId: yjs_last_sequence_id,
		yjsSnapshotId: yjs_snapshot_id,
	});
}

export const create_file_node = internalMutation({
	args: {
		userId: doc(app_convex_schema, "files_nodes").fields.createdBy,
		organizationId: doc(app_convex_schema, "files_nodes").fields.organizationId,
		workspaceId: doc(app_convex_schema, "files_nodes").fields.workspaceId,
		parentId: v.union(v.id("files_nodes"), v.literal(files_ROOT_ID)),
		path: v.string(),
		contentType: doc(app_convex_schema, "files_nodes").fields.contentType,
		assetId: v.id("files_r2_assets"),
		yjsSnapshotAssetId: v.optional(v.id("files_r2_assets")),
		archiveOperationId: v.optional(v.string()),
		textContent: v.string(),
		readOnly: v.boolean(),
		mountId: v.optional(v.id("github_mounts")),
		syncRunId: v.optional(v.string()),
	},
	returns: v_result({
		_yay: v.object({
			nodeId: v.id("files_nodes"),
			/**
			 * The node's committed Yjs last sequence, captured in this same mutation. Eager-create
			 * callers stamp their pending update doc with it, so a save landing after this mutation
			 * always advances the node past the stamp and the hard-delete gate fails closed.
			 * Undefined when the node has no Yjs docs (read-only files).
			 */
			createdCommittedSequence: v.optional(v.number()),
			/**
			 * `_id`s of the intermediate folders this mutation created (reused folders are
			 * skipped), ordered deepest first; empty when no folder was created. Eager-create
			 * callers hand them to the compensation mutation so a failed proposal upsert can
			 * remove them too.
			 */
			createdAncestorIds: v.array(v.id("files_nodes")),
		}),
	}),
	handler: async (ctx, args) => {
		if ((args.mountId == null) !== (args.syncRunId == null)) {
			return Result({ _nay: { message: "External mount sync run requires mountId and syncRunId" } });
		}
		if (args.mountId != null && args.syncRunId != null) {
			// Recheck inside the node-creation transaction. The mount may be replaced
			// after the action's first check.
			const mount = await ctx.db.get("github_mounts", args.mountId);
			if (
				!mount ||
				mount.status !== "running" ||
				mount.syncRunId !== args.syncRunId ||
				mount.pendingCommitSha == null ||
				!args.path.startsWith(`/${mount.name}/${mount.pendingCommitSha}/`)
			) {
				return Result({ _nay: { message: "External mount sync was superseded" } });
			}
		}
		// Every caller here is an action: it proved this permission in an earlier transaction and then
		// went off to write R2 objects. A role taken away in that gap would still land a file. The walk
		// below only asks `access_control_db_can_act_on_file_node`, which waves an open node through on
		// the promise that the workspace permission was already proved — and that promise is exactly
		// what goes stale. So ask again, here, in the transaction that writes. SYSTEM writes come from
		// trusted server flows and have no user to ask about.
		//
		// The reserved global scopes (mount mirrors, plugin sources) have no memberships to ask about,
		// so they are skipped here the same way the node check skips them.
		const authorUserId = args.userId === users_SYSTEM_AUTHOR ? null : args.userId;
		const authorOrganizationId = ctx.db.normalizeId("organizations", String(args.organizationId));
		const authorWorkspaceId = ctx.db.normalizeId("organizations_workspaces", String(args.workspaceId));
		if (authorUserId && authorOrganizationId && authorWorkspaceId) {
			const membership = await ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_active_user_organization_workspace", (q) =>
					q
						.eq("active", true)
						.eq("userId", authorUserId)
						.eq("organizationId", authorOrganizationId)
						.eq("workspaceId", authorWorkspaceId),
				)
				.first();
			if (!membership) {
				return Result({ _nay: { message: "Permission denied" } });
			}

			const authorized = await authorize_file_write(ctx, {
				userAuth: { id: authorUserId },
				membership,
				nodeId: args.parentId,
			});
			if (authorized._nay) {
				return Result({ _nay: { message: "Permission denied" } });
			}
		}

		const createdAncestorIds: Array<Id<"files_nodes">> = [];
		const now = Date.now();
		const nodeIdResult = await files_nodes_db_create_node_recursively_at_path(ctx, {
			userId: args.userId,
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			parentId: args.parentId,
			path: args.path,
			kind: "file",
			contentType: args.contentType,
			assetId: args.assetId,
			archiveOperationId: args.archiveOperationId,
			expectsTextContent: true,
			now,
			mut_createdAncestorIds: createdAncestorIds,
		});
		if (nodeIdResult._nay) {
			return nodeIdResult;
		}
		// The helper records shallowest first; compensation walks deepest first.
		createdAncestorIds.reverse();

		// The leaf's stored path can differ from `args.path` (segments resolved under `parentId`),
		// so read it back from the created node before inserting the content docs.
		const insertedNode = await ctx.db.get("files_nodes", nodeIdResult._yay);
		if (!insertedNode) {
			const errorMessage = "created file node is missing right after insert";
			const errorData = { nodeId: nodeIdResult._yay };
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}

		// Same mutation as the node insert: a content-docs failure throws and rolls back the node.
		await files_nodes_db_insert_file_content_docs(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId: insertedNode._id,
			path: insertedNode.path,
			parentId: args.parentId,
			archiveOperationId: insertedNode.archiveOperationId,
			contentType: args.contentType,
			textContent: args.textContent,
			readOnly: args.readOnly,
			yjsSnapshotAssetId: args.yjsSnapshotAssetId,
			userId: args.userId,
			now,
		});

		// Capture the committed last sequence inside the creating transaction: no save can land
		// between the node creation and this read, so the value is the true creation-time state.
		let createdCommittedSequence: number | undefined;
		const createdNode = await ctx.db.get("files_nodes", nodeIdResult._yay);
		if (createdNode?.yjsLastSequenceId) {
			const yjsLastSequenceDoc = await ctx.db.get("files_yjs_docs_last_sequences", createdNode.yjsLastSequenceId);
			if (yjsLastSequenceDoc) {
				createdCommittedSequence = yjsLastSequenceDoc.lastSequence;
			}
		}

		return Result({ _yay: { nodeId: nodeIdResult._yay, createdCommittedSequence, createdAncestorIds } });
	},
});

/**
 * Final step of creating an editable Markdown file. Editable files have no content asset:
 * `node.assetId` points at the first version snapshot. This sets r2Key + size on the Yjs
 * snapshot and version snapshot assets, and inserts the version snapshot in `files_snapshots`.
 * The arg types only accept real org/workspace ids, so reserved scopes cannot reach this.
 */
export async function files_nodes_db_finalize_markdown_node_creation(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		nodeId: Id<"files_nodes">;
		userId: Id<"users">;
		yjsSnapshotAssetId: Id<"files_r2_assets">;
		yjsSnapshotSize: number;
		versionSnapshotAssetId: Id<"files_r2_assets">;
		versionSnapshotSize: number;
	},
) {
	const now = Date.now();

	await Promise.all([
		ctx.db.patch("files_r2_assets", args.yjsSnapshotAssetId, {
			r2Key: r2_create_asset_key({
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				assetId: args.yjsSnapshotAssetId,
			}),
			size: args.yjsSnapshotSize,
			updatedAt: now,
		}),
		ctx.db.patch("files_r2_assets", args.versionSnapshotAssetId, {
			r2Key: r2_create_asset_key({
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				assetId: args.versionSnapshotAssetId,
			}),
			size: args.versionSnapshotSize,
			updatedAt: now,
		}),
		ctx.db.insert("files_snapshots", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			fileNodeId: args.nodeId,
			assetId: args.versionSnapshotAssetId,
			createdBy: args.userId,
			archivedAt: -1,
		}),
	]);

	return Result({ _yay: null });
}

export const finalize_markdown_node_creation = internalMutation({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		nodeId: v.id("files_nodes"),
		userId: v.id("users"),
		yjsSnapshotAssetId: v.id("files_r2_assets"),
		yjsSnapshotSize: v.number(),
		versionSnapshotAssetId: v.id("files_r2_assets"),
		versionSnapshotSize: v.number(),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		return await files_nodes_db_finalize_markdown_node_creation(ctx, args);
	},
});

export const cleanup_file_node_creation_assets = internalMutation({
	args: {
		assetIds: v.array(v.id("files_r2_assets")),
		r2Keys: v.array(v.string()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		for (const r2Key of args.r2Keys) {
			await r2_delete_object(ctx, r2Key);
		}

		for (const assetId of args.assetIds) {
			const asset = await ctx.db.get("files_r2_assets", assetId);
			if (asset) {
				await ctx.db.delete("files_r2_assets", asset._id);
			}
		}

		return null;
	},
});

/**
 * Internal file-node creation for reserved read-only source content (GitHub mirrors and plugin
 * source snapshots).
 *
 * Creates a read-only text file at `path` in the GLOBAL organization under the requested reserved
 * workspace scope, using the SYSTEM user id, one content asset, and no Yjs or version snapshot docs.
 */
export const create_file_node_internal = internalAction({
	args: {
		workspaceId: v.union(
			v.literal(organizations_GLOBAL_GITHUB_WORKSPACE_ID),
			v.literal(organizations_GLOBAL_PLUGINS_WORKSPACE_ID),
		),
		path: v.string(),
		rawText: v.string(),
		mountId: v.optional(v.id("github_mounts")),
		syncRunId: v.optional(v.string()),
	},
	returns: v_result({ _yay: v.object({ nodeId: v.id("files_nodes") }) }),
	handler: async (ctx, args) => {
		if ((args.mountId == null) !== (args.syncRunId == null)) {
			return Result({ _nay: { message: "External mount sync run requires mountId and syncRunId" } });
		}
		if (args.mountId != null && args.syncRunId != null) {
			// Sync-run validation is a GitHub-mirror concept; plugin source publishes never pass it.
			if (args.workspaceId !== organizations_GLOBAL_GITHUB_WORKSPACE_ID) {
				return Result({ _nay: { message: "External mount sync run requires the GITHUB workspace scope" } });
			}
			const mount = await ctx.runQuery(internal.github_mounts.get_mount, { mountId: args.mountId });
			if (!mount || mount.syncRunId !== args.syncRunId || mount.status !== "running") {
				return Result({ _nay: { message: "External mount sync was superseded" } });
			}
			// Materialized paths always live inside the run's pending commit root `/<name>/<sha>/...`.
			if (mount.pendingCommitSha == null || !args.path.startsWith(`/${mount.name}/${mount.pendingCommitSha}/`)) {
				return Result({ _nay: { message: "External mount path does not belong to the pending sync root" } });
			}
		}

		const byteSize = files_get_utf8_byte_size(args.rawText);
		if (byteSize > files_MAX_TEXT_CONTENT_BYTES) {
			return Result({
				_nay: {
					name: "nay",
					message: `Text content exceeds ${files_MAX_TEXT_CONTENT_BYTES}-byte limit`,
				},
			});
		}

		const assetId = await ctx.runMutation(internal.r2.insert_asset, {
			organizationId: organizations_GLOBAL_ORGANIZATION_ID,
			workspaceId: args.workspaceId,
			kind: "content",
			size: byteSize,
			createdBy: users_SYSTEM_AUTHOR,
		});

		const r2Key = r2_create_asset_key({
			organizationId: organizations_GLOBAL_ORGANIZATION_ID,
			workspaceId: args.workspaceId,
			assetId,
		});

		try {
			await r2_put_object(ctx, {
				key: r2Key,
				body: args.rawText,
				contentType: "text/plain;charset=utf-8" satisfies files_ContentType,
			});
		} catch (error) {
			await ctx.runMutation(internal.files_nodes_content.cleanup_file_node_creation_assets, {
				assetIds: [assetId],
				r2Keys: [r2Key],
			});
			console.error("Failed to write external source file asset", { error, assetId, path: args.path });
			return Result({ _nay: { message: "Failed to create external source file" } });
		}

		// Concurrent mount materialization races on shared folder creation (read-then-insert in
		// files_nodes_db_create_node_recursively_at_path), which Convex surfaces as a commit-time write conflict.
		// Retry the node-creation mutation a few times — the conflicting writer commits the folder, so a
		// retry reads it and proceeds — reusing the same asset so a transient conflict leaks no orphan.
		let created: create_file_node_Result | null = null;
		let lastCreateError: unknown = null;
		for (let attempt = 0; attempt < 5 && created === null; attempt++) {
			try {
				created = (await ctx.runMutation(internal.files_nodes_content.create_file_node, {
					userId: users_SYSTEM_AUTHOR,
					organizationId: organizations_GLOBAL_ORGANIZATION_ID,
					workspaceId: args.workspaceId,
					parentId: files_ROOT_ID,
					path: args.path,
					assetId,
					contentType: "text/plain;charset=utf-8" satisfies files_ContentType,
					textContent: args.rawText,
					readOnly: true,
					mountId: args.mountId,
					syncRunId: args.syncRunId,
				})) as create_file_node_Result;
			} catch (error) {
				lastCreateError = error;
			}
		}
		if (created === null) {
			await ctx.runMutation(internal.files_nodes_content.cleanup_file_node_creation_assets, {
				assetIds: [assetId],
				r2Keys: [r2Key],
			});
			console.error("Failed to create external source file node after retries", {
				error: lastCreateError,
				path: args.path,
			});
			return Result({ _nay: { message: "Failed to create external source file node" } });
		}
		if (created._nay) {
			await ctx.runMutation(internal.files_nodes_content.cleanup_file_node_creation_assets, {
				assetIds: [assetId],
				r2Keys: [r2Key],
			});
			return created;
		}

		const createdNodeId = created._yay?.nodeId;
		if (!createdNodeId) {
			await ctx.runMutation(internal.files_nodes_content.cleanup_file_node_creation_assets, {
				assetIds: [assetId],
				r2Keys: [r2Key],
			});
			return Result({ _nay: { message: "Failed to create external source file node" } });
		}

		// Set r2Key + size on the content asset. The node already points at this asset.
		await ctx.runMutation(internal.r2.patch_asset, {
			assetId,
			r2Key,
			size: byteSize,
		});

		return Result({ _yay: { nodeId: createdNodeId } });
	},
});

type create_file_node_Result =
	typeof create_file_node extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

export type files_nodes_create_file_node_internal_Result =
	typeof create_file_node_internal extends RegisteredAction<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

type action_create_markdown_node_Result =
	| {
			_yay: {
				nodeId: Id<"files_nodes">;
				createdCommittedSequence?: number;
				createdAncestorIds: Id<"files_nodes">[];
			};
			_nay?: undefined;
	  }
	| {
			_nay: {
				name?: string;
				message: string;
				cause?: unknown;
				data?: unknown;
				stack?: string;
			};
			_yay?: undefined;
	  };

async function action_create_markdown_node(
	ctx: ActionCtx,
	args: {
		userId: Id<"users">;
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		parentId: Doc<"files_nodes">["parentId"];
		path: string;
		markdownContent: string;
		archiveOperationId?: Doc<"files_nodes">["archiveOperationId"];
	},
): Promise<action_create_markdown_node_Result> {
	const snapshotUpdate = files_nodes_create_yjs_snapshot_update_from_markdown(args.markdownContent);
	if (snapshotUpdate._nay) {
		return snapshotUpdate;
	}

	const [yjsSnapshotAssetId, versionSnapshotAssetId] = (await Promise.all([
		ctx.runMutation(internal.r2.insert_asset, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			kind: "yjs_snapshot",
			size: snapshotUpdate._yay.byteLength,
			createdBy: args.userId,
		}),
		ctx.runMutation(internal.r2.insert_asset, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			kind: "content_snapshot",
			size: files_get_utf8_byte_size(args.markdownContent),
			createdBy: args.userId,
		}),
	])) as [Id<"files_r2_assets">, Id<"files_r2_assets">];

	const yjsSnapshotR2Key = r2_create_asset_key({
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		assetId: yjsSnapshotAssetId,
	});
	const versionSnapshotR2Key = r2_create_asset_key({
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		assetId: versionSnapshotAssetId,
	});

	const assetIds = [yjsSnapshotAssetId, versionSnapshotAssetId];
	const cleanupCreatedAssets = async () => {
		await ctx.runMutation(internal.files_nodes_content.cleanup_file_node_creation_assets, {
			assetIds,
			r2Keys: [yjsSnapshotR2Key, versionSnapshotR2Key],
		});
	};

	// Editable files do not store their current content in R2. Reads use the committed chunks.
	// We only upload the Yjs snapshot and the first version snapshot. The node points at the
	// version snapshot: the newest snapshot always holds the file's current bytes.
	try {
		await Promise.all([
			r2_put_object(ctx, {
				key: yjsSnapshotR2Key,
				body: snapshotUpdate._yay,
				contentType: "application/octet-stream" satisfies files_ContentType,
			}),
			r2_put_object(ctx, {
				key: versionSnapshotR2Key,
				body: args.markdownContent,
				contentType: "text/markdown;charset=utf-8" satisfies files_ContentType,
			}),
		]);
	} catch (error) {
		await cleanupCreatedAssets();
		console.error("Failed to write initial Markdown file assets", {
			error,
			yjsSnapshotAssetId,
			versionSnapshotAssetId,
		});
		return Result({ _nay: { message: "Failed to create file" } });
	}

	const created = (await ctx.runMutation(internal.files_nodes_content.create_file_node, {
		userId: args.userId,
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		parentId: args.parentId,
		path: args.path,
		contentType: "text/markdown;charset=utf-8" satisfies files_ContentType,
		assetId: versionSnapshotAssetId,
		yjsSnapshotAssetId,
		textContent: args.markdownContent,
		readOnly: false,
		archiveOperationId: args.archiveOperationId,
	})) as create_file_node_Result;
	if (created._nay) {
		await cleanupCreatedAssets();
		return created;
	}

	await ctx.runMutation(internal.files_nodes_content.finalize_markdown_node_creation, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		nodeId: created._yay.nodeId,
		userId: args.userId,
		yjsSnapshotAssetId,
		yjsSnapshotSize: snapshotUpdate._yay.byteLength,
		versionSnapshotAssetId,
		versionSnapshotSize: files_get_utf8_byte_size(args.markdownContent),
	});

	return Result({
		_yay: {
			nodeId: created._yay.nodeId,
			createdCommittedSequence: created._yay.createdCommittedSequence,
			createdAncestorIds: created._yay.createdAncestorIds,
		},
	});
}

export const create_markdown_node = action({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		parentId: v.union(v.id("files_nodes"), v.literal(files_ROOT_ID)),
		path: v.string(),
	},
	returns: v_result({ _yay: v.object({ nodeId: v.id("files_nodes") }) }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "files_tree_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const membership = (await ctx.runQuery(api.organizations.get_membership, {
			membershipId: args.membershipId,
		})) as Doc<"organizations_workspaces_users"> | null;
		if (!membership || membership.userId !== userAuth.id) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		// An action cannot read the database, so the permission check goes through a query. It asks
		// about the folder the file goes into, like the two create mutations do, so a grant on a
		// restricted folder still lets its people add files there.
		const allowed = await ctx.runQuery(api.files_nodes.get_current_user_file_write_permission, {
			membershipId: args.membershipId,
			nodeId: args.parentId,
		});
		if (!allowed) {
			return Result({ _nay: { message: "Permission denied" } });
		}

		const created = await action_create_markdown_node(ctx, {
			userId: userAuth.id,
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			parentId: args.parentId,
			markdownContent: files_INITIAL_CONTENT,
			path: args.path,
		});
		if (created._nay) {
			return created;
		}

		// The creation-time sequence capture is internal plumbing; keep the public shape.
		return Result({ _yay: { nodeId: created._yay.nodeId } });
	},
});

export const get_file_markdown_content_db_state_by_path = internalQuery({
	args: {
		organizationId: doc(app_convex_schema, "files_nodes").fields.organizationId,
		workspaceId: doc(app_convex_schema, "files_nodes").fields.workspaceId,
		userId: v.id("users"),
		path: v.string(),
		pendingUpdateId: v.optional(v.id("files_pending_updates")),
		includePending: v.optional(v.boolean()),
		/** When set, resolve `path` through this user's pending path overlay (their pending moves). */
		overlayUserId: v.optional(v.id("users")),
		/**
		 * Max byte size for merging the committed chunks below. If the file is bigger, we skip the
		 * merge and return no `content`, so the caller can reject using `asset.size` without
		 * loading the file body.
		 */
		maxBytes: v.optional(v.number()),
	},
	returns: v.union(
		v.object({
			content: v.optional(v.string()),
			asset: v.union(doc(app_convex_schema, "files_r2_assets"), v.null()),
			nodeId: v.id("files_nodes"),
			displayNodeId: v.id("files_nodes"),
			pendingUpdateId: v.union(v.id("files_pending_updates"), v.null()),
			materializationState: v.union(file_content_materialization_state_validator, v.null()),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		// Translate the path through the overlay first; the per-user pending-content logic
		// below then runs on the resolved node, so content-plus-move docs compose.
		const fileNode = await files_db_get_visible_node_by_path(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			path: args.path,
			overlayUserId: args.overlayUserId,
		});

		if (fileNode == null) return null;
		if (fileNode.kind !== "file") return null;

		// Same reason as in `read_file_content_from_chunks`: `userId` is the person asking, and this is
		// the second door onto file bytes.
		const [readableNode] = await access_control_db_filter_readable_file_nodes(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			nodes: [fileNode],
		});
		if (!readableNode) return null;

		// External (reserved) scope: no Yjs/pending/materialization. Read the linked R2 content asset
		// directly and leave `content` undefined so `get_file_last_available_markdown_content_by_path`
		// falls into its raw-R2 `.text()` branch.
		if (
			organizations_is_global_organization_id(args.organizationId) ||
			organizations_is_reserved_workspace_id(args.workspaceId)
		) {
			const asset = fileNode.assetId
				? await ctx.db
						.get("files_r2_assets", fileNode.assetId)
						.then((asset) =>
							asset && asset.organizationId === args.organizationId && asset.workspaceId === args.workspaceId
								? asset
								: null,
						)
				: null;
			return {
				asset,
				nodeId: fileNode._id,
				displayNodeId: fileNode._id,
				pendingUpdateId: null,
				materializationState: null,
			};
		}

		if (!files_node_has_editable_yjs_state(fileNode)) return null;

		// Tenant scope (the guards above narrowed both ids to real ids): bind them so the narrowing
		// also reaches the `withIndex` callbacks — TS drops property narrowing at closure boundaries.
		const organizationId = args.organizationId;
		const workspaceId = args.workspaceId;

		const pendingUpdateById =
			args.includePending === false
				? null
				: args.pendingUpdateId
					? await ctx.db.get("files_pending_updates", args.pendingUpdateId)
					: null;
		const pendingUpdate =
			args.includePending === false
				? null
				: pendingUpdateById &&
					  pendingUpdateById.organizationId === organizationId &&
					  pendingUpdateById.workspaceId === workspaceId &&
					  pendingUpdateById.userId === args.userId &&
					  pendingUpdateById.fileNodeId === fileNode._id
					? pendingUpdateById
					: await ctx.db
							.query("files_pending_updates")
							.withIndex("by_organization_workspace_user_fileNode", (q) =>
								q
									.eq("organizationId", organizationId)
									.eq("workspaceId", workspaceId)
									.eq("userId", args.userId)
									.eq("fileNodeId", fileNode._id),
							)
							.first();
		// Move-only docs carry no content; keep returning their `pendingUpdateId` below so
		// write_file/edit_file mix onto them, while content resolves from the committed tree.
		const pendingUpdateContent = pendingUpdate ? files_pending_update_content_of(pendingUpdate) : null;
		if (pendingUpdate && pendingUpdateContent) {
			// Rebuild the pending branch from its recorded base so readers see the same document
			// the pending-update save/rebase flow will later persist.
			const yjsDoc = files_yjs_doc_create_from_array_buffer_update(pendingUpdateContent.baseYjsUpdate, {
				additionalIncrementalArrayBufferUpdates: [pendingUpdateContent.unstagedBranchYjsUpdate],
			});

			const markdown = files_yjs_doc_get_markdown({ yjsDoc });
			if (markdown._yay !== undefined) {
				return {
					content: markdown._yay,
					asset: null,
					nodeId: fileNode._id,
					displayNodeId: fileNode._id,
					pendingUpdateId: pendingUpdate._id,
					materializationState: null,
				};
			}

			console.error("Failed to reconstruct markdown from files_pending_updates", {
				nay: markdown._nay,
				nodeId: fileNode._id,
			});
		}

		const asset = fileNode.assetId
			? await ctx.db
					.get("files_r2_assets", fileNode.assetId)
					.then((asset) =>
						asset && asset.organizationId === organizationId && asset.workspaceId === workspaceId ? asset : null,
					)
			: null;

		const materializationState = pendingUpdateContent
			? null
			: await db_get_file_content_materialization_db_state(ctx, {
					organizationId,
					workspaceId,
					nodeId: fileNode._id,
				});

		// Editable files do not store their current content in R2. Reads use the committed
		// chunks. Merge the chunks here, except in two cases: the Yjs log is newer than the
		// snapshot (the caller rebuilds the content from Yjs), or the content is bigger than the
		// caller's byte cap.
		if (
			(!materializationState ||
				materializationState.yjsLastSequenceDoc.lastSequence <= materializationState.yjsSnapshotDoc.sequence) &&
			asset &&
			(args.maxBytes === undefined || asset.size <= args.maxBytes)
		) {
			const chunks = await ctx.db
				.query("files_markdown_chunks")
				.withIndex("by_organization_workspace_source_fileNode_yjsSeq_chunk", (q) =>
					q
						.eq("organizationId", organizationId)
						.eq("workspaceId", workspaceId)
						.eq("sourceKind", "committed")
						.eq("fileNodeId", fileNode._id),
				)
				.collect();
			const committedContent = chunks.length > 0 ? files_merge_contiguous_chunks(chunks) : asset.size === 0 ? "" : null;
			if (committedContent != null) {
				return {
					content: committedContent,
					asset: null,
					nodeId: fileNode._id,
					displayNodeId: fileNode._id,
					pendingUpdateId: pendingUpdate?._id ?? null,
					materializationState: null,
				};
			}
		}

		return {
			asset,
			nodeId: fileNode._id,
			displayNodeId: fileNode._id,
			pendingUpdateId: pendingUpdate?._id ?? null,
			materializationState,
		};
	},
});

type get_file_markdown_content_db_state_by_path_Result =
	typeof get_file_markdown_content_db_state_by_path extends RegisteredQuery<
		infer _Visibility,
		infer _Args,
		infer ReturnValue
	>
		? Awaited<ReturnValue>
		: never;

type get_file_last_available_markdown_content_by_path_Result = {
	content: string;
	nodeId: Id<"files_nodes">;
	displayNodeId: Id<"files_nodes">;
	pendingUpdateId: Id<"files_pending_updates"> | null;
} | null;

export const get_file_last_available_markdown_content_by_path = internalAction({
	args: {
		organizationId: doc(app_convex_schema, "files_nodes").fields.organizationId,
		workspaceId: doc(app_convex_schema, "files_nodes").fields.workspaceId,
		userId: v.id("users"),
		path: v.string(),
		pendingUpdateId: v.optional(v.id("files_pending_updates")),
		includePending: v.optional(v.boolean()),
		/** When set, resolve `path` through this user's pending path overlay (their pending moves). */
		overlayUserId: v.optional(v.id("users")),
		maxBytes: v.optional(v.number()),
	},
	returns: v.union(
		v.object({
			content: v.string(),
			nodeId: v.id("files_nodes"),
			displayNodeId: v.id("files_nodes"),
			pendingUpdateId: v.union(v.id("files_pending_updates"), v.null()),
		}),
		v.null(),
	),
	handler: async (ctx, args): Promise<get_file_last_available_markdown_content_by_path_Result> => {
		const contentState = (await ctx.runQuery(internal.files_nodes_content.get_file_markdown_content_db_state_by_path, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			path: args.path,
			pendingUpdateId: args.pendingUpdateId,
			includePending: args.includePending,
			overlayUserId: args.overlayUserId,
			maxBytes: args.maxBytes,
		})) as get_file_markdown_content_db_state_by_path_Result;
		if (!contentState) {
			return null;
		}

		const maxBytes = args.maxBytes;
		const content_exceeds_max_bytes = (content: string) =>
			maxBytes !== undefined && files_get_utf8_byte_size(content) > maxBytes;
		const materializationState = contentState.materializationState;
		let content: string;
		if (contentState.content !== undefined) {
			content = contentState.content;
		} else if (
			materializationState &&
			materializationState.yjsLastSequenceDoc.lastSequence > materializationState.yjsSnapshotDoc.sequence
		) {
			if (maxBytes !== undefined && materializationState.asset.size > maxBytes) {
				return null;
			}

			content = await files_nodes_reconstruct_latest_file_content_from_materialization_state({
				state: materializationState,
			}).then((reconstructed) => {
				if (reconstructed._nay) {
					throw convex_error({
						message: "Failed to reconstruct latest file content",
						cause: reconstructed._nay,
					});
				}

				return reconstructed._yay.markdown;
			});
		} else {
			const asset = contentState.asset;
			if (maxBytes !== undefined && asset && asset.size > maxBytes) {
				return null;
			}

			content = asset?.r2Key
				? await r2_fetch_object_from_bucket({ key: asset.r2Key }).then((response) => response.text())
				: "";
		}

		if (content_exceeds_max_bytes(content)) {
			return null;
		}

		return {
			content,
			nodeId: contentState.nodeId,
			displayNodeId: contentState.displayNodeId,
			pendingUpdateId: contentState.pendingUpdateId,
		};
	},
});

export type files_nodes_get_file_last_available_markdown_content_by_path_Result =
	typeof get_file_last_available_markdown_content_by_path extends RegisteredAction<
		infer _Visibility,
		infer _Args,
		infer ReturnValue
	>
		? Awaited<ReturnValue>
		: never;

// Leading/trailing byte window for the in-memory/windowed read fallbacks (see the read caps
// comment next to `files_READ_RANGE_MAX_LINES` in files_nodes.ts).
const files_READ_RANGE_SCAN_MAX_BYTES = 8 * 1024;

/**
 * Compute `wc` counts for a full text in one pass: lineCount = newline count (`wc -l`), wordCount =
 * whitespace-delimited words (`wc -w`), charCount = Unicode code points (`wc -m`, not UTF-16 units,
 * so emoji/astral chars count as one). Used both at materialization (to store exact counts on the
 * node) and on the windowed fallback (lower-bound counts for unmaterialized content), so the two
 * paths share identical semantics. Allocation-free except the word split.
 */
function files_compute_wc_counts(text: string) {
	let lineCount = 0;
	let charCount = 0;
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code === 10) lineCount++; // "\n"
		// Skip the trailing half of a surrogate pair so the pair counts as one code point.
		if (code < 0xdc00 || code > 0xdfff) charCount++;
	}
	const trimmed = text.trim();
	const wordCount = trimmed.length === 0 ? 0 : trimmed.split(/\s+/u).length;
	return { lineCount, wordCount, charCount };
}

async function files_resolve_readable_content_or_window(
	ctx: ActionCtx,
	args: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		userId: Id<"users">;
		path: string;
		pendingUpdateId?: Id<"files_pending_updates">;
		overlayUserId?: Id<"users">;
	},
): Promise<{ nodeId: Id<"files_nodes">; text: string; fetchedAllBytes: boolean; totalBytes: number } | null> {
	const state = (await ctx.runQuery(internal.files_nodes_content.get_file_markdown_content_db_state_by_path, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		userId: args.userId,
		path: args.path,
		pendingUpdateId: args.pendingUpdateId,
		overlayUserId: args.overlayUserId,
	})) as get_file_markdown_content_db_state_by_path_Result;
	if (!state) {
		return null;
	}
	const materializationState = state.materializationState;
	// Pending user edit, or stale snapshot: full content is (or must be) in memory.
	if (state.content !== undefined) {
		return {
			nodeId: state.nodeId,
			text: state.content,
			fetchedAllBytes: true,
			totalBytes: files_get_utf8_byte_size(state.content),
		};
	}
	if (
		materializationState &&
		materializationState.yjsLastSequenceDoc.lastSequence > materializationState.yjsSnapshotDoc.sequence
	) {
		const reconstructed = await files_nodes_reconstruct_latest_file_content_from_materialization_state({
			state: materializationState,
		});
		if (reconstructed._nay) {
			throw convex_error({ message: "Failed to reconstruct latest file content", cause: reconstructed._nay });
		}
		return {
			nodeId: state.nodeId,
			text: reconstructed._yay.markdown,
			fetchedAllBytes: true,
			totalBytes: files_get_utf8_byte_size(reconstructed._yay.markdown),
		};
	}
	// Committed and up to date: bounded byte-range read of the content object (leading window).
	const asset = state.asset;
	if (!asset?.r2Key) {
		return { nodeId: state.nodeId, text: "", fetchedAllBytes: true, totalBytes: 0 };
	}
	const totalBytes = asset.size;
	const endInclusive = Math.max(0, Math.min(files_READ_RANGE_SCAN_MAX_BYTES, totalBytes) - 1);
	const response = await r2_fetch_object_range_from_bucket({ key: asset.r2Key, start: 0, endInclusive });
	const bytes = new Uint8Array(await response.arrayBuffer());
	const text = new TextDecoder("utf-8").decode(bytes);
	return { nodeId: state.nodeId, text, fetchedAllBytes: bytes.byteLength >= totalBytes, totalBytes };
}

/**
 * Read a line range of a file without pulling the whole thing. The chunk query handles the latest
 * user-visible chunk source: pending chunks first, then committed chunks when the materialized
 * snapshot is current. Unmaterialized/stale content falls back to a slice of the in-memory
 * reconstruction, or a single bounded R2 byte-range read (a leading window capped at
 * `files_READ_RANGE_SCAN_MAX_BYTES`) for committed-but-window-only fallbacks. Backs `head -n N`
 * (startLine 1) and `sed -n 'A,Bp'` (startLine A). `scanTruncated` is only ever true on the
 * windowed fallback path.
 */
export const read_file_line_range = internalAction({
	args: {
		organizationId: doc(app_convex_schema, "files_nodes").fields.organizationId,
		workspaceId: doc(app_convex_schema, "files_nodes").fields.workspaceId,
		userId: v.id("users"),
		path: v.string(),
		startLine: v.number(),
		maxLines: v.number(),
		pendingUpdateId: v.optional(v.id("files_pending_updates")),
		/** When set, resolve `path` through this user's pending path overlay (their pending moves). */
		overlayUserId: v.optional(v.id("users")),
	},
	returns: v.union(
		v.object({
			nodeId: v.id("files_nodes"),
			content: v.string(),
			moreLines: v.boolean(),
			scanTruncated: v.boolean(),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const startLine = Math.max(1, Math.trunc(args.startLine));
		const maxLines = Math.max(1, Math.min(files_READ_RANGE_MAX_LINES, Math.trunc(args.maxLines)));
		const chunked = (await ctx.runQuery(internal.files_nodes.read_file_content_from_chunks, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			path: args.path,
			pendingUpdateId: args.pendingUpdateId,
			overlayUserId: args.overlayUserId,
			mode: {
				kind: "lines",
				startLine,
				maxLines,
			},
		})) as files_nodes_read_file_content_from_chunks_Result;
		if (chunked) {
			return {
				nodeId: chunked.nodeId,
				content: chunked.content,
				moreLines: chunked.moreLines,
				scanTruncated: false,
			};
		}
		// Fallback: in-memory reconstruction (pending/stale) or a bounded leading R2 window.
		const resolved = await files_resolve_readable_content_or_window(ctx, args);
		if (!resolved) {
			return null;
		}
		const range = files_line_range_from_text(resolved.text, startLine, maxLines);
		// Stopped on the byte window (not line count / EOF): output may be partial.
		const scanTruncated = !resolved.fetchedAllBytes && range.linesReturned < maxLines;
		return {
			nodeId: resolved.nodeId,
			content: range.content,
			moreLines: range.moreLines || !resolved.fetchedAllBytes,
			scanTruncated,
		};
	},
});

export type files_nodes_read_file_line_range_Result =
	typeof read_file_line_range extends RegisteredAction<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * Read the last `maxLines` lines of a file. For committed content this reads a bounded
 * trailing byte window via an R2 range request (so the file is not pulled in full); for
 * pending/unmaterialized content it slices the in-memory reconstruction. Backs `tail -n N`.
 */
export const read_file_tail_lines = internalAction({
	args: {
		organizationId: doc(app_convex_schema, "files_nodes").fields.organizationId,
		workspaceId: doc(app_convex_schema, "files_nodes").fields.workspaceId,
		userId: v.id("users"),
		path: v.string(),
		maxLines: v.number(),
		pendingUpdateId: v.optional(v.id("files_pending_updates")),
		/** When set, resolve `path` through this user's pending path overlay (their pending moves). */
		overlayUserId: v.optional(v.id("users")),
	},
	returns: v.union(
		v.object({
			nodeId: v.id("files_nodes"),
			content: v.string(),
			// True when lines precede the returned tail (the view is a partial end-of-file window).
			moreLines: v.boolean(),
			scanTruncated: v.boolean(),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const maxLines = Math.max(1, Math.min(files_READ_RANGE_MAX_LINES, Math.trunc(args.maxLines)));
		// Committed-current content: read the trailing lines from the last materialized chunks.
		const chunked = (await ctx.runQuery(internal.files_nodes.read_committed_file_chunks_line_range, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			path: args.path,
			startLine: 1,
			maxLines,
			fromEnd: true,
			pendingUpdateId: args.pendingUpdateId,
			overlayUserId: args.overlayUserId,
		})) as files_nodes_read_committed_file_chunks_line_range_Result;
		if (chunked.usable) {
			return { nodeId: chunked.nodeId, content: chunked.content, moreLines: chunked.moreLines, scanTruncated: false };
		}
		// Fallback: in-memory reconstruction (pending/stale) or a bounded trailing R2 window.
		const state = (await ctx.runQuery(internal.files_nodes_content.get_file_markdown_content_db_state_by_path, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			path: args.path,
			pendingUpdateId: args.pendingUpdateId,
			overlayUserId: args.overlayUserId,
		})) as get_file_markdown_content_db_state_by_path_Result;
		if (!state) {
			return null;
		}
		const materializationState = state.materializationState;

		// Pending/stale: full content in memory.
		if (state.content !== undefined) {
			const tail = files_tail_lines_from_text(state.content, maxLines);
			return { nodeId: state.nodeId, content: tail.content, moreLines: tail.moreAbove, scanTruncated: false };
		}
		if (
			materializationState &&
			materializationState.yjsLastSequenceDoc.lastSequence > materializationState.yjsSnapshotDoc.sequence
		) {
			const reconstructed = await files_nodes_reconstruct_latest_file_content_from_materialization_state({
				state: materializationState,
			});
			if (reconstructed._nay) {
				throw convex_error({ message: "Failed to reconstruct latest file content", cause: reconstructed._nay });
			}
			const tail = files_tail_lines_from_text(reconstructed._yay.markdown, maxLines);
			return { nodeId: state.nodeId, content: tail.content, moreLines: tail.moreAbove, scanTruncated: false };
		}

		// Committed: read a bounded trailing window from the end of the R2 object.
		const asset = state.asset;
		if (!asset?.r2Key) {
			return { nodeId: state.nodeId, content: "", moreLines: false, scanTruncated: false };
		}
		const totalBytes = asset.size;
		const start = Math.max(0, totalBytes - files_READ_RANGE_SCAN_MAX_BYTES);
		const response = await r2_fetch_object_range_from_bucket({ key: asset.r2Key, start, endInclusive: totalBytes - 1 });
		const bytes = new Uint8Array(await response.arrayBuffer());
		const text = new TextDecoder("utf-8").decode(bytes);
		const tail = files_tail_lines_from_text(text, maxLines);
		// If the trailing window didn't reach the start of the file, the earliest returned line
		// could be partial — only relevant for files larger than the scan window.
		const scanTruncated = start > 0;
		return { nodeId: state.nodeId, content: tail.content, moreLines: tail.moreAbove || start > 0, scanTruncated };
	},
});

export type files_nodes_read_file_tail_lines_Result =
	typeof read_file_tail_lines extends RegisteredAction<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * Line/word/char/byte counts for a file without a guaranteed full read. `byteCount` is the
 * true size; line/word/char counts come from a bounded leading window, so `exact` is false
 * when the file is larger than the scan window (counts are then lower bounds). Backs `wc` on
 * large files so the agent learns a file's size (e.g. line count) instead of over-paging.
 */
export const read_file_content_stats = internalAction({
	args: {
		organizationId: doc(app_convex_schema, "files_nodes").fields.organizationId,
		workspaceId: doc(app_convex_schema, "files_nodes").fields.workspaceId,
		userId: v.id("users"),
		path: v.string(),
		pendingUpdateId: v.optional(v.id("files_pending_updates")),
		/** When set, resolve `path` through this user's pending path overlay (their pending moves). */
		overlayUserId: v.optional(v.id("users")),
	},
	returns: v.union(
		v.object({
			nodeId: v.id("files_nodes"),
			lineCount: v.number(),
			wordCount: v.number(),
			charCount: v.number(),
			byteCount: v.number(),
			exact: v.boolean(),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		// Committed-current content: count exactly from the materialized chunks (the verbatim document).
		const chunked = (await ctx.runQuery(internal.files_nodes.read_committed_file_chunk_stats, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			path: args.path,
			pendingUpdateId: args.pendingUpdateId,
			overlayUserId: args.overlayUserId,
		})) as files_nodes_read_committed_file_chunk_stats_Result;
		if (chunked.usable) {
			return {
				nodeId: chunked.nodeId,
				lineCount: chunked.lineCount,
				wordCount: chunked.wordCount,
				charCount: chunked.charCount,
				byteCount: chunked.byteCount,
				exact: true,
			};
		}
		// Fallback: in-memory reconstruction (pending/stale) or a bounded leading R2 window (counts
		// are then lower bounds, flagged via `exact: false`).
		const resolved = await files_resolve_readable_content_or_window(ctx, args);
		if (!resolved) {
			return null;
		}
		// Same wc semantics as the materialized path, but on a possibly-partial window (lower bounds).
		const counts = files_compute_wc_counts(resolved.text);
		return {
			nodeId: resolved.nodeId,
			lineCount: counts.lineCount,
			wordCount: counts.wordCount,
			charCount: counts.charCount,
			byteCount: resolved.totalBytes,
			exact: resolved.fetchedAllBytes,
		};
	},
});

export type files_nodes_read_file_content_stats_Result =
	typeof read_file_content_stats extends RegisteredAction<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * Create a Markdown file at a trusted path.
 *
 * Trust callers to validate and normalize `path` before calling this mutation.
 */
export const create_file_by_path = internalAction({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		path: v.string(),
		markdownContent: v.optional(v.string()),
	},
	returns: v_result({
		_yay: v.object({
			nodeId: v.id("files_nodes"),
			created: v.boolean(),
			/**
			 * The node's committed Yjs last sequence, captured in the mutation that created the
			 * node. Eager-create callers pass it to the pending-update upsert as the immutable
			 * `eagerCreated.committedSequence` stamp. Only set when `created` is true.
			 */
			createdCommittedSequence: v.optional(v.number()),
			/**
			 * `_id`s of the intermediate folders created for this path (reused folders are
			 * skipped), ordered deepest first; empty when no folder was created. Eager-create
			 * callers hand them to `remove_eager_created_node_if_safe` so a failed proposal
			 * upsert also removes the folders it committed.
			 */
			createdAncestorIds: v.array(v.id("files_nodes")),
		}),
	}),
	handler: async (ctx, args) => {
		const activeFileNode = (await ctx.runQuery(internal.files_nodes.get_by_path, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			visibilityUserId: args.userId,
			path: args.path,
		})) as Doc<"files_nodes"> | null;
		if (activeFileNode?.kind === "file") {
			// `created: false` marks a pre-existing file. Callers that need a fresh node (e.g.
			// pending-copy destinations, which are later hard-deleted) must treat this as a conflict.
			return Result({ _yay: { nodeId: activeFileNode._id, created: false, createdAncestorIds: [] } });
		}

		const created = await action_create_markdown_node(ctx, {
			userId: args.userId,
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			parentId: files_ROOT_ID,
			path: args.path,
			markdownContent: args.markdownContent ?? "",
		});
		if (created._nay) {
			return created;
		}

		return Result({
			_yay: {
				nodeId: created._yay.nodeId,
				created: true,
				createdCommittedSequence: created._yay.createdCommittedSequence,
				createdAncestorIds: created._yay.createdAncestorIds,
			},
		});
	},
});

export type files_nodes_create_file_by_path_Result =
	typeof create_file_by_path extends RegisteredAction<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

// #region home file

/**
 * Seeds the initial README.md for a freshly created workspace. Scheduled from the
 * workspace-creation mutations; after that the file is a normal file (rename, move,
 * archive all work on it).
 */
export const create_home_file = internalAction({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const result = await action_create_markdown_node(ctx, {
			userId: args.userId,
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			parentId: files_ROOT_ID,
			path: "README.md" satisfies files_SpecialFileName,
			// Keep the auto-created home file consistent with user-created Markdown files.
			markdownContent: files_INITIAL_CONTENT,
		});
		if (result._nay) {
			console.error("Failed to create home file", { result, args });
		}
		return null;
	},
});

// #endregion home file

function yjs_create_state_update_from_tiptap_editor(args: { tiptapEditor: Editor }) {
	const yjsDoc = files_yjs_doc_create_from_tiptap_editor({
		tiptapEditor: args.tiptapEditor,
	});
	return encodeStateAsUpdate(yjsDoc);
}

// #region snapshots

const store_version_snapshot_args_schema = v.object({
	organizationId: v.id("organizations"),
	workspaceId: v.id("organizations_workspaces"),
	nodeId: v.id("files_nodes"),
	assetId: v.id("files_r2_assets"),
	userId: v.id("users"),
});

function yjs_merge_updates_to_array_buffer(updates: Uint8Array[]) {
	return files_u8_to_array_buffer(mergeUpdates(updates));
}

async function db_insert_snapshot_restore_update(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
		nodeId: Id<"files_nodes">;
		snapshotId: Id<"files_snapshots">;
		restoreUpdate: ArrayBuffer;
	},
) {
	const newSequenceData = await yjs_increment_or_create_last_sequence(ctx, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		nodeId: args.nodeId,
	});

	await ctx.db.insert("files_yjs_updates", {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		fileNodeId: args.nodeId,
		sequence: newSequenceData.lastSequence,
		update: args.restoreUpdate,
		origin: {
			type: "USER_SNAPSHOT_RESTORE",
			snapshotId: args.snapshotId,
		},
		createdBy: args.userId,
		createdAt: Date.now(),
	});

	await enqueue_file_content_materialization(ctx, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		nodeId: args.nodeId,
		userId: args.userId,
		targetSequence: newSequenceData.lastSequence,
		delayMs: 0,
	});

	return newSequenceData.lastSequence;
}

async function store_version_snapshot(ctx: MutationCtx, args: Infer<typeof store_version_snapshot_args_schema>) {
	const snapshotId = await ctx.db.insert("files_snapshots", {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		fileNodeId: args.nodeId,
		assetId: args.assetId,
		createdBy: args.userId,
		archivedAt: -1,
	});

	return snapshotId;
}

export async function files_nodes_reconstruct_latest_file_content_from_materialization_state(args: {
	state: NonNullable<get_file_content_materialization_state_Result>;
}) {
	if (!args.state.yjsSnapshotAsset.r2Key) {
		const errorMessage = "yjsSnapshotAsset.r2Key is not set";
		const errorData = {
			nodeId: args.state.fileNode._id,
			assetId: args.state.yjsSnapshotAsset._id,
		};
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}

	const baseSnapshotUpdate = await r2_fetch_object_from_bucket({ key: args.state.yjsSnapshotAsset.r2Key }).then(
		(response) => response.arrayBuffer(),
	);
	const updatesAfterSnapshot = args.state.yjsUpdatesDocs.filter(
		(update) => update.sequence > args.state.yjsSnapshotDoc.sequence,
	);
	const snapshotUpdate = yjs_merge_updates_to_array_buffer([
		new Uint8Array(baseSnapshotUpdate),
		...updatesAfterSnapshot.map((update) => new Uint8Array(update.update)),
	]);

	const yjsDoc = files_yjs_doc_create_from_array_buffer_update(snapshotUpdate);
	const markdown = files_yjs_doc_get_markdown({ yjsDoc });

	if (markdown._nay) {
		return markdown;
	}

	return Result({
		_yay: {
			yjsDoc,
			markdown: markdown._yay,
			snapshotUpdate,
			sequence: args.state.yjsLastSequenceDoc.lastSequence,
		},
	});
}

/**
 * Replace the current content of an editable Markdown file in place, keeping the same nodeId.
 * The caller has already validated the node (editable, same scope) and PUT the new content bytes
 * at the content snapshot asset's deterministic key. `fillUpdate` is a Yjs diff update computed
 * against the doc state the caller reconstructed; open editors apply it as a remote change.
 * The caller omits it when the diff is empty (the new content equals the current content).
 */
export async function files_nodes_db_fill_markdown_node_content(
	ctx: MutationCtx,
	args: {
		// Editable files only exist in real tenant scopes, so the caller passes the already
		// scope-checked ids instead of the node's wider reserved-scope union fields.
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		fileNode: Doc<"files_nodes"> & {
			assetId: NonNullable<Doc<"files_nodes">["assetId"]>;
			yjsSnapshotId: NonNullable<Doc<"files_nodes">["yjsSnapshotId"]>;
			yjsLastSequenceId: NonNullable<Doc<"files_nodes">["yjsLastSequenceId"]>;
		};
		userId: Id<"users">;
		markdownContent: string;
		contentSnapshotAssetId: Id<"files_r2_assets">;
		contentSize: number;
		fillUpdate?: ArrayBuffer;
	},
) {
	const now = Date.now();
	const { organizationId, workspaceId } = args;

	await Promise.all([
		ctx.db.patch("files_r2_assets", args.contentSnapshotAssetId, {
			r2Key: r2_create_asset_key({ organizationId, workspaceId, assetId: args.contentSnapshotAssetId }),
			size: args.contentSize,
			updatedAt: now,
		}),
		// Store the new content as a version snapshot and point the node at it: the newest
		// snapshot always holds the file's current bytes.
		store_version_snapshot(ctx, {
			organizationId,
			workspaceId,
			nodeId: args.fileNode._id,
			assetId: args.contentSnapshotAssetId,
			userId: args.userId,
		}),
		ctx.db.patch("files_nodes", args.fileNode._id, {
			assetId: args.contentSnapshotAssetId,
			updatedBy: args.userId,
			updatedAt: now,
		}),
	]);

	let yjsSequence: number;
	if (args.fillUpdate) {
		const newSequenceData = await yjs_increment_or_create_last_sequence(ctx, {
			organizationId,
			workspaceId,
			nodeId: args.fileNode._id,
		});
		await ctx.db.insert("files_yjs_updates", {
			organizationId,
			workspaceId,
			fileNodeId: args.fileNode._id,
			sequence: newSequenceData.lastSequence,
			update: args.fillUpdate,
			// Non-user origin so open editor sessions apply the update as a remote change.
			origin: { type: "USER_AI_EDIT" },
			createdBy: args.userId,
			createdAt: now,
		});
		await enqueue_file_content_materialization(ctx, {
			organizationId,
			workspaceId,
			nodeId: args.fileNode._id,
			userId: args.userId,
			targetSequence: newSequenceData.lastSequence,
			delayMs: 0,
		});
		yjsSequence = newSequenceData.lastSequence;
	} else {
		const yjsLastSequenceDoc = await ctx.db.get("files_yjs_docs_last_sequences", args.fileNode.yjsLastSequenceId);
		if (!yjsLastSequenceDoc) {
			const errorMessage = "fileNode.yjsLastSequenceId points to a missing files_yjs_docs_last_sequences doc";
			const errorData = {
				fileNodeId: args.fileNode._id,
				yjsLastSequenceId: args.fileNode.yjsLastSequenceId,
			};
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}
		yjsSequence = yjsLastSequenceDoc.lastSequence;
	}

	return await db_replace_file_chunks(ctx, {
		organizationId,
		workspaceId,
		nodeId: args.fileNode._id,
		yjsSequence,
		markdownContent: args.markdownContent,
	});
}

export const finalize_file_content_materialization = internalMutation({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		nodeId: v.id("files_nodes"),
		userId: v.id("users"),
		sequence: v.number(),
		targetSequence: v.number(),
		markdown: v.string(),
		versionSnapshotAssetId: v.id("files_r2_assets"),
		markdownSize: v.number(),
		yjsSnapshotSize: v.number(),
		_errors: v.optional(
			v.object({
				message: v.literal("Failed to materialize file content"),
			}),
		),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const state = (await ctx.runQuery(internal.files_nodes.get_file_content_materialization_state, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId: args.nodeId,
		})) as get_file_content_materialization_state_Result;
		if (!state) {
			return Result({ _yay: null });
		}

		if (state.yjsLastSequenceDoc.lastSequence !== args.sequence || args.sequence !== args.targetSequence) {
			return Result({ _yay: null });
		}

		const now = Date.now();

		const dbWriteResult = Result_all(
			await Promise.all([
				// Point the node at the new version snapshot. It now holds the file's current
				// bytes, so downloads sign it and reads use its size as the byte cap.
				// Reaching here means the content fit, so clear any earlier over-cap marker.
				ctx.db.patch("files_nodes", args.nodeId, {
					assetId: args.versionSnapshotAssetId,
					contentTooLargeByteSize: undefined,
				}),
				ctx.db.patch("files_r2_assets", state.yjsSnapshotAsset._id, {
					r2Key: r2_create_asset_key({
						organizationId: args.organizationId,
						workspaceId: args.workspaceId,
						assetId: state.yjsSnapshotAsset._id,
					}),
					size: args.yjsSnapshotSize,
					updatedAt: now,
				}),
				ctx.db.patch("files_r2_assets", args.versionSnapshotAssetId, {
					r2Key: r2_create_asset_key({
						organizationId: args.organizationId,
						workspaceId: args.workspaceId,
						assetId: args.versionSnapshotAssetId,
					}),
					size: args.markdownSize,
					updatedAt: now,
				}),
				ctx.db.patch("files_yjs_snapshots", state.yjsSnapshotDoc._id, {
					sequence: args.sequence,
					updatedBy: users_SYSTEM_AUTHOR,
					updatedAt: now,
				}),
				...state.yjsUpdatesDocs
					.filter((updateData) => updateData.sequence <= args.sequence)
					.map((updateData) => ctx.db.delete("files_yjs_updates", updateData._id)),
				db_replace_file_chunks(ctx, {
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					nodeId: args.nodeId,
					yjsSequence: args.sequence,
					markdownContent: args.markdown,
				}),
				store_version_snapshot(ctx, {
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					nodeId: args.nodeId,
					assetId: args.versionSnapshotAssetId,
					userId: args.userId,
				}),
				ctx.db
					.query("files_content_materialization_jobs")
					.withIndex("by_fileNode", (q) => q.eq("fileNodeId", args.nodeId))
					.collect()
					.then((jobs) =>
						Promise.all(
							jobs
								.filter((job) => job.targetSequence <= args.targetSequence)
								.map((job) => ctx.db.delete("files_content_materialization_jobs", job._id)),
						),
					),
			]),
		);

		if (dbWriteResult._nay) {
			const errorMessage = "Failed to materialize file content" satisfies NonNullable<
				(typeof args)["_errors"]
			>["message"];
			console.error(errorMessage, {
				dbWriteResult,
			});
			return Result({
				_nay: {
					name: "nay",
					message: errorMessage,
				},
			});
		}

		return Result({ _yay: null });
	},
});

type finalize_file_content_materialization_Result =
	typeof finalize_file_content_materialization extends RegisteredMutation<
		infer _Visibility,
		infer _Args,
		infer ReturnValue
	>
		? Awaited<ReturnValue>
		: never;

/**
 * Settles a materialization that produced Markdown over `files_MAX_TEXT_CONTENT_BYTES`.
 *
 * Retrying cannot make the content smaller. So this records why the node stopped advancing and
 * deletes the job row instead of failing. It does not cancel the workpool item, the same way
 * `finalize_file_content_materialization` does not. A later run for the same sequence just marks
 * the node again.
 */
export const mark_file_content_too_large = internalMutation({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		nodeId: v.id("files_nodes"),
		sequence: v.number(),
		targetSequence: v.number(),
		byteSize: v.number(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const state = (await ctx.runQuery(internal.files_nodes.get_file_content_materialization_state, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId: args.nodeId,
		})) as get_file_content_materialization_state_Result;
		if (!state) {
			return null;
		}

		// Use the same staleness gate as `finalize_file_content_materialization`. A newer push
		// already replaced this job. Its own materialization decides whether the content fits.
		if (state.yjsLastSequenceDoc.lastSequence !== args.sequence || args.sequence !== args.targetSequence) {
			return null;
		}

		const jobs = await ctx.db
			.query("files_content_materialization_jobs")
			.withIndex("by_fileNode", (q) => q.eq("fileNodeId", args.nodeId))
			.collect();

		await Promise.all([
			ctx.db.patch("files_nodes", args.nodeId, {
				contentTooLargeByteSize: args.byteSize,
			}),
			...jobs
				.filter((job) => job.targetSequence <= args.targetSequence)
				.map((job) => ctx.db.delete("files_content_materialization_jobs", job._id)),
		]);

		return null;
	},
});

export const materialize_file_content = internalAction({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		nodeId: v.id("files_nodes"),
		userId: v.id("users"),
		targetSequence: v.number(),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const state = (await ctx.runQuery(internal.files_nodes.get_file_content_materialization_state, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId: args.nodeId,
		})) as get_file_content_materialization_state_Result;
		if (!state) {
			return Result({ _yay: null });
		}

		const reconstructed = await files_nodes_reconstruct_latest_file_content_from_materialization_state({ state });
		if (reconstructed._nay) {
			return reconstructed;
		}

		const sequence = reconstructed._yay.sequence;

		// The Yjs path is the one write path the cap cannot cover earlier. `yjs_push_update` only
		// ever sees a delta, so this is the first point where the whole Markdown exists. Check
		// before `insert_asset` and the R2 writes below, so an over-cap run leaves no orphan asset.
		//
		// Do not throw for over-cap content. This action runs in a workpool with `maxParallelism: 1`
		// and infinite retries, so a throw would retry forever and block materialization for every
		// other file.
		const markdownByteSize = files_get_utf8_byte_size(reconstructed._yay.markdown);
		if (markdownByteSize > files_MAX_TEXT_CONTENT_BYTES) {
			const errorMessage = `Text content exceeds ${files_MAX_TEXT_CONTENT_BYTES}-byte limit`;
			console.warn(errorMessage, {
				nodeId: args.nodeId,
				sequence,
				markdownByteSize,
			});
			await ctx.runMutation(internal.files_nodes_content.mark_file_content_too_large, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				nodeId: args.nodeId,
				sequence,
				targetSequence: args.targetSequence,
				byteSize: markdownByteSize,
			});
			return Result({
				_nay: {
					name: "nay",
					message: errorMessage,
				},
			});
		}

		const versionSnapshotAssetId = (await ctx.runMutation(internal.r2.insert_asset, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			kind: "content_snapshot",
			size: markdownByteSize,
			createdBy: args.userId,
		})) as Id<"files_r2_assets">;

		if (!state.yjsSnapshotAsset.r2Key) {
			const errorMessage = "materialization yjsSnapshotAsset r2Key is not set";
			const errorData = {
				nodeId: args.nodeId,
				yjsSnapshotAssetId: state.yjsSnapshotAsset._id,
				versionSnapshotAssetId,
			};
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}
		const versionSnapshotR2Key = r2_create_asset_key({
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			assetId: versionSnapshotAssetId,
		});

		// The current markdown lives in the committed chunk tables, not in R2. So we only upload
		// the Yjs snapshot and the new version snapshot here.
		await Promise.all([
			r2_put_object(ctx, {
				key: state.yjsSnapshotAsset.r2Key,
				body: reconstructed._yay.snapshotUpdate,
				contentType: "application/octet-stream" satisfies files_ContentType,
			}),
			r2_put_object(ctx, {
				key: versionSnapshotR2Key,
				body: reconstructed._yay.markdown,
				contentType: "text/markdown;charset=utf-8" satisfies files_ContentType,
			}),
		]);

		const finalizationResult = (await ctx.runMutation(
			internal.files_nodes_content.finalize_file_content_materialization,
			{
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				nodeId: args.nodeId,
				userId: args.userId,
				sequence,
				targetSequence: args.targetSequence,
				markdown: reconstructed._yay.markdown,
				versionSnapshotAssetId,
				markdownSize: markdownByteSize,
				yjsSnapshotSize: reconstructed._yay.snapshotUpdate.byteLength,
			},
		)) as finalize_file_content_materialization_Result;
		if (finalizationResult._nay) {
			return finalizationResult;
		}

		return Result({ _yay: null });
	},
});

export const restore_snapshot = internalMutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
		snapshotId: v.id("files_snapshots"),
		sessionId: v.string(),
		snapshotMarkdownContent: v.string(),
		restoreUpdate: v.optional(v.bytes()),
		currentSnapshotAssetId: v.id("files_r2_assets"),
		currentSnapshotSize: v.number(),
		restoredSnapshotAssetId: v.id("files_r2_assets"),
		restoredSnapshotSize: v.number(),
		skipRateLimit: v.optional(v.boolean()),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		if (!args.skipRateLimit) {
			const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "files_snapshot_write", key: userAuth.id });
			if (rateLimit) {
				return Result({ _nay: { message: rateLimit.message } });
			}
		}

		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const authorized = await access_control_db_authorize_node(ctx, {
			userAuth,
			membership,
			nodeId: args.nodeId,
			permission: "content.write",
		});
		if (authorized._nay) {
			return authorized;
		}

		const [snapshotContent, fileNode] = await Promise.all([
			db_get_file_snapshot_content(ctx, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				nodeId: args.nodeId,
				snapshotId: args.snapshotId,
			}),
			ctx.db.get("files_nodes", args.nodeId).then((fileNode) => {
				if (
					!fileNode ||
					fileNode.organizationId !== membership.organizationId ||
					fileNode.workspaceId !== membership.workspaceId
				) {
					return null;
				}

				return fileNode;
			}),
		]);

		if (!snapshotContent || !files_node_has_editable_yjs_state(fileNode)) {
			return Result({
				_nay: {
					name: "nay",
					message: "Not found",
				},
			});
		}

		const userDoc = await ctx.db.get("users", userAuth.id);
		if (!userDoc) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const organization = await ctx.db.get("organizations", membership.organizationId);
		if (!organization) {
			const errorMessage = "membership.organizationId points to a missing organizations doc";
			const errorData = {
				membershipId: membership._id,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				nodeId: args.nodeId,
				snapshotId: args.snapshotId,
			};
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}
		const billedUserId = billing_pick_billed_user_id({
			userId: userAuth.id,
			organization,
		});
		const billedUser = await ctx.db.get("users", billedUserId);
		if (!billedUser) {
			const errorMessage = "billedUserId points to a missing users doc";
			const errorData = {
				userId: userAuth.id,
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

		const now = Date.now();
		const userId = userAuth.id;

		// Restoring snapshots can be destructive and we defensively store
		// the current state as a backup snapshot
		// so the user can revert to it if needed.
		const [, , , , , restoredYjsSequence] = await Promise.all([
			ctx.db.patch("files_r2_assets", args.currentSnapshotAssetId, {
				r2Key: r2_create_asset_key({
					organizationId: membership.organizationId,
					workspaceId: membership.workspaceId,
					assetId: args.currentSnapshotAssetId,
				}),
				size: args.currentSnapshotSize,
				updatedAt: now,
			}),
			ctx.db.patch("files_r2_assets", args.restoredSnapshotAssetId, {
				r2Key: r2_create_asset_key({
					organizationId: membership.organizationId,
					workspaceId: membership.workspaceId,
					assetId: args.restoredSnapshotAssetId,
				}),
				size: args.restoredSnapshotSize,
				updatedAt: now,
			}),
			// Store current state as a backup snapshot
			store_version_snapshot(ctx, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				nodeId: args.nodeId,
				assetId: args.currentSnapshotAssetId,
				userId,
			}),

			// Store the restored content as a new snapshot
			store_version_snapshot(ctx, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				nodeId: args.nodeId,
				assetId: args.restoredSnapshotAssetId,
				userId,
			}),

			ctx.db.patch("files_nodes", fileNode._id, {
				// Point the node at the restored snapshot: it now holds the file's current bytes.
				// The queued materialization will later point it at its own fresh snapshot.
				assetId: args.restoredSnapshotAssetId,
				updatedBy: userId,
				updatedAt: now,
			}),

			args.restoreUpdate
				? db_insert_snapshot_restore_update(ctx, {
						organizationId: membership.organizationId,
						workspaceId: membership.workspaceId,
						userId,
						nodeId: args.nodeId,
						snapshotId: args.snapshotId,
						restoreUpdate: args.restoreUpdate,
					})
				: Promise.resolve(null),
		]);

		const yjsLastSequenceDoc = await ctx.db.get("files_yjs_docs_last_sequences", fileNode.yjsLastSequenceId);
		if (!yjsLastSequenceDoc) {
			const errorMessage = "fileNode.yjsLastSequenceId points to a missing files_yjs_docs_last_sequences doc";
			const errorData = {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				nodeId: args.nodeId,
				yjsLastSequenceId: fileNode.yjsLastSequenceId,
				yjsLastSequenceDoc,
			};
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}

		const restoreFileResult = Result_all(
			await Promise.all([
				db_replace_file_chunks(ctx, {
					organizationId: membership.organizationId,
					workspaceId: membership.workspaceId,
					nodeId: args.nodeId,
					yjsSequence: yjsLastSequenceDoc.lastSequence,
					markdownContent: args.snapshotMarkdownContent,
				}),
			]),
		);

		// Throw, do not return `_nay`. A Convex mutation that returns normally commits, and by this line
		// the writes above already pointed the node at the restored snapshot, while
		// `db_replace_file_chunks` deleted the committed chunks before failing to write the new ones.
		// Returning would keep the file with no committed text. Only chunking the Markdown can fail here,
		// and this Markdown is a snapshot the app itself wrote and chunked once already, so a failure is
		// a broken invariant and not something the caller can answer. The action still reports
		// "Failed to restore file" for the failures it can see before any write.
		if (restoreFileResult._nay) {
			const errorMessage = "Failed to replace the file chunks while restoring a snapshot";
			const errorData = {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				nodeId: args.nodeId,
				snapshotId: args.snapshotId,
				nay: restoreFileResult._nay,
			};
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}

		if (restoredYjsSequence !== null) {
			await billing_ingest_events(ctx, {
				billedUserEvents: [
					{
						billedUser,
						event: billing_event({
							name: "file_save",
							externalCustomerId: billedUser._id,
							externalMemberId: userAuth.id,
							externalId: composite_id(
								"billing",
								"file_save",
								billedUser._id,
								userAuth.id,
								membership.organizationId,
								membership.workspaceId,
								args.nodeId,
								restoredYjsSequence,
							),
							metadata: {
								amount: 1,
								actorUserId: userAuth.id,
								billedUserId: billedUser._id,
								organizationId: membership.organizationId,
								workspaceId: membership.workspaceId,
								nodeId: args.nodeId,
								yjsSequence: String(restoredYjsSequence),
							},
						}),
					},
				],
			});
		}

		return Result({
			_yay: null,
		});
	},
});

type restore_snapshot_Result =
	typeof restore_snapshot extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

export const get_data_for_restore_snapshot = internalQuery({
	args: {
		userId: v.id("users"),
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
		snapshotId: v.id("files_snapshots"),
	},
	returns: v.union(
		v.object({
			membership: doc(app_convex_schema, "organizations_workspaces_users"),
			snapshotContent: v.union(
				v.object({
					asset: doc(app_convex_schema, "files_r2_assets"),
					snapshotId: v.id("files_snapshots"),
					_creationTime: v.number(),
				}),
				v.null(),
			),
			materializationState: v.union(file_content_materialization_state_validator, v.null()),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const membership = await organizations_db_get_membership(ctx, {
			userId: args.userId,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return null;
		}

		const authorized = await access_control_db_authorize_node(ctx, {
			userAuth: { id: args.userId },
			membership,
			nodeId: args.nodeId,
			permission: "content.write",
		});
		if (authorized._nay) {
			return null;
		}

		const [snapshotContent, materializationState] = await Promise.all([
			db_get_file_snapshot_content(ctx, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				nodeId: args.nodeId,
				snapshotId: args.snapshotId,
			}),
			db_get_file_content_materialization_db_state(ctx, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				nodeId: args.nodeId,
			}),
		]);

		return {
			membership,
			snapshotContent,
			materializationState,
		};
	},
});

type get_data_for_restore_snapshot_Result =
	typeof get_data_for_restore_snapshot extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

export const restore_snapshot_r2 = action({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
		snapshotId: v.id("files_snapshots"),
		sessionId: v.string(),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args): Promise<restore_snapshot_Result> => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "files_snapshot_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const data = (await ctx.runQuery(internal.files_nodes_content.get_data_for_restore_snapshot, {
			userId: userAuth.id,
			membershipId: args.membershipId,
			nodeId: args.nodeId,
			snapshotId: args.snapshotId,
		})) as get_data_for_restore_snapshot_Result;
		if (!data) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const { membership, snapshotContent, materializationState } = data;
		if (!snapshotContent) {
			return Result({ _nay: { name: "nay", message: "Not found" } });
		}
		if (!materializationState) {
			return Result({ _nay: { name: "nay", message: "Not found" } });
		}

		const creditCheck = await ctx.runQuery(internal.billing.check_credits, {
			userId: userAuth.id,
			organizationId: membership.organizationId,
			minimumRequiredCents: 1,
		});
		if (!creditCheck.hasCredits) {
			return Result({
				_nay: {
					message: "Insufficient funds",
				},
			});
		}

		if (!snapshotContent.asset.r2Key) {
			const errorMessage = "snapshot.assetId points to an asset without r2Key";
			const errorData = {
				nodeId: args.nodeId,
				snapshotId: args.snapshotId,
				assetId: snapshotContent.asset._id,
			};
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}

		const snapshotMarkdownContent = await r2_fetch_object_from_bucket({ key: snapshotContent.asset.r2Key }).then(
			(response) => response.text(),
		);
		const currentContent = await files_nodes_reconstruct_latest_file_content_from_materialization_state({
			state: materializationState,
		});
		// Nothing is written yet here, so this could return `_nay`. It throws instead because there is
		// nothing for the caller to do: the file's own committed content will not rebuild, retrying does
		// the same thing again, and a "Failed to restore file" message would hide a broken invariant
		// behind something that reads like a normal refusal. The restore mutation throws for the same
		// reason.
		if (currentContent._nay) {
			const errorMessage = "Failed to reconstruct current file content before restoring a snapshot";
			const errorData = {
				nodeId: args.nodeId,
				snapshotId: args.snapshotId,
				nay: currentContent._nay,
			};
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}
		const yjsBeforeStateVector = encodeStateVector(currentContent._yay.yjsDoc);
		const restoredYjsDocProjection = files_yjs_doc_update_from_markdown({
			mut_yjsDoc: currentContent._yay.yjsDoc,
			markdown: snapshotMarkdownContent,
		});
		if (restoredYjsDocProjection._nay) {
			const errorMessage = "Failed to apply the restored snapshot Markdown to the file's Yjs doc";
			const errorData = {
				nodeId: args.nodeId,
				snapshotId: args.snapshotId,
				nay: restoredYjsDocProjection._nay,
			};
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}
		const restoreUpdate = files_yjs_compute_diff_update_from_state_vector({
			yjsDoc: restoredYjsDocProjection._yay,
			yjsBeforeStateVector,
		});

		const [currentSnapshotAssetId, restoredSnapshotAssetId] = (await Promise.all([
			ctx.runMutation(internal.r2.insert_asset, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				kind: "content_snapshot",
				size: files_get_utf8_byte_size(currentContent._yay.markdown),
				createdBy: userAuth.id,
			}),
			ctx.runMutation(internal.r2.insert_asset, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				kind: "content_snapshot",
				size: files_get_utf8_byte_size(snapshotMarkdownContent),
				createdBy: userAuth.id,
			}),
		])) as [Id<"files_r2_assets">, Id<"files_r2_assets">];

		const currentSnapshotR2Key = r2_create_asset_key({
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			assetId: currentSnapshotAssetId,
		});
		const restoredSnapshotR2Key = r2_create_asset_key({
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			assetId: restoredSnapshotAssetId,
		});

		// Editable files have no current-content object in R2. The restore mutation replaces the
		// committed chunks, and the queued materialization refreshes the Yjs snapshot. Only two
		// version snapshots go to R2: a backup of the current state, and the restored content.
		await Promise.all([
			r2_put_object(ctx, {
				key: currentSnapshotR2Key,
				body: currentContent._yay.markdown,
				contentType: "text/markdown;charset=utf-8" satisfies files_ContentType,
			}),
			r2_put_object(ctx, {
				key: restoredSnapshotR2Key,
				body: snapshotMarkdownContent,
				contentType: "text/markdown;charset=utf-8" satisfies files_ContentType,
			}),
		]);

		return (await ctx.runMutation(internal.files_nodes_content.restore_snapshot, {
			membershipId: args.membershipId,
			nodeId: args.nodeId,
			snapshotId: args.snapshotId,
			sessionId: args.sessionId,
			snapshotMarkdownContent,
			restoreUpdate: restoreUpdate ? files_u8_to_array_buffer(restoreUpdate) : undefined,
			currentSnapshotAssetId,
			currentSnapshotSize: files_get_utf8_byte_size(currentContent._yay.markdown),
			restoredSnapshotAssetId,
			restoredSnapshotSize: files_get_utf8_byte_size(snapshotMarkdownContent),
			skipRateLimit: true,
		})) as restore_snapshot_Result;
	},
});

// #endregion snapshots
