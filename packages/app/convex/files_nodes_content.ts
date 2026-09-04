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
	mutation,
	query,
	type ActionCtx,
	type MutationCtx,
	type QueryCtx,
} from "./_generated/server.js";
import type { Doc, Id } from "./_generated/dataModel";
import { type RegisteredAction, type RegisteredMutation, type RegisteredQuery } from "convex/server";
import type { Editor } from "@tiptap/core";
import { path_join, server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";
import { v, type Infer } from "convex/values";
import {
	files_ROOT_ID,
	files_INITIAL_CONTENT,
	files_u8_to_array_buffer,
	files_MAX_TEXT_CONTENT_BYTES,
	files_MAX_YJS_RECONSTRUCTED_STATE_BYTES,
	files_MAX_YJS_REPAIR_RECONSTRUCTED_STATE_BYTES,
	files_MAX_UNMATERIALIZED_YJS_UPDATE_BYTES,
	files_MAX_UNMATERIALIZED_YJS_UPDATE_COUNT,
	files_editable_text_refusal_message,
	files_get_editable_text_content_type,
	files_get_editable_text_yjs_root_kind,
	files_get_utf8_byte_size,
	files_normalize_text_document_input,
	files_node_has_editable_text_content,
	files_node_has_editable_yjs_state,
	files_pending_update_content_of,
	files_db_consume_trusted_yjs_update_stage,
	files_db_get_visible_node_by_path,
	files_db_load_pending_update_yjs_state_bytes,
	type files_ContentType,
	type files_SpecialFileName,
	type files_YjsRootKind,
} from "../server/files.ts";
import {
	files_yjs_create_empty_state_update,
	files_yjs_doc_apply_array_buffer_update,
	files_yjs_doc_create_from_array_buffer_update,
	files_yjs_doc_create_from_tiptap_editor,
	files_yjs_doc_get_plain_text,
	files_yjs_compute_diff_update_from_state_vector,
} from "../shared/files-yjs.ts";
import {
	files_headless_tiptap_editor_create,
	files_headless_tiptap_editor_set_content_from_markdown,
	files_yjs_doc_create_from_text,
	files_yjs_doc_get_text,
	files_yjs_doc_update_from_text,
} from "../shared/files-tiptap.ts";
import { files_chunk_markdown } from "../server/files-markdown-chunking-mastra.ts";
import { files_chunk_plain_text } from "../server/files-plain-text-chunking.ts";
import { Result, Result_all } from "common/errors-as-values-utils.ts";
import { encodeStateVector, encodeStateAsUpdate, mergeUpdates } from "yjs";
import { composite_id, should_never_happen } from "../shared/shared-utils.ts";
import { path_extract_segments_from, path_name_of } from "../shared/paths.ts";
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
import {
	files_metadata_db_delete_committed_frontmatter,
	files_metadata_db_insert_committed,
	files_metadata_entry_fields,
} from "./files_metadata.ts";
import {
	files_metadata_frontmatter_exceeds_index_caps,
	files_metadata_preflight_frontmatter,
	type files_metadata_Entry,
} from "../shared/files-metadata.ts";
import {
	files_pending_updates_db_drop_content_for_node,
	type files_pending_updates_stage_trusted_yjs_update_Result,
} from "./files_pending_updates.ts";
import {
	r2_PUT_MAY_ARRIVE_MARGIN_MS,
	r2_create_asset_key,
	r2_delete_object,
	r2_enqueue_object_deletion_job,
	r2_fetch_object_from_bucket,
	r2_fetch_object_range_from_bucket,
	r2_put_object,
} from "./r2_client.ts";
import {
	authorize_file_write,
	cancel_file_content_materialization,
	db_get_file_content_materialization_db_state,
	db_get_file_snapshot_content,
	db_upsert_file_stats,
	enqueue_file_content_materialization,
	file_content_materialization_header_validator,
	file_content_materialization_state_validator,
	files_READ_RANGE_MAX_LINES,
	files_line_range_from_text,
	files_merge_contiguous_chunks,
	files_node_require_writable,
	files_nodes_db_create_node_recursively_at_path,
	files_tail_lines_from_text,
	yjs_reserve_and_increment_last_sequence,
	type files_nodes_read_committed_file_chunk_stats_Result,
	type files_nodes_read_committed_file_chunks_line_range_Result,
	type files_nodes_read_file_content_from_chunks_Result,
	type get_file_content_materialization_header_Result,
	type get_file_content_materialization_state_Result,
	type get_file_next_yjs_update_Result,
} from "./files_nodes.ts";

// Make Convex reuse the loaded module between calls, so warm calls skip the module load cost.
// Does NOT work for http actions (see http.ts). No mutable module-level state allowed here.
export const experimental_reuseContext = true;

/**
 * Find the caller's active membership in one workspace.
 *
 * The doors in this module that the agent and the operator reach carry `userId` plus the tenant
 * ids instead of a `membershipId`, because those callers never hold one. They still must prove
 * the user is a real active member of that workspace before the write.
 */
async function db_get_active_membership_in_workspace(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
	},
) {
	return await ctx.db
		.query("organizations_workspaces_users")
		.withIndex("by_user_organization_workspace_active", (q) =>
			q
				.eq("userId", args.userId)
				.eq("organizationId", args.organizationId)
				.eq("workspaceId", args.workspaceId)
				.eq("active", true),
		)
		.first();
}

/**
 * Insert a paired set of committed `files_text_chunks` + `files_plain_text_chunks` for one file node.
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
			textChunk: string;
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
	const textChunkIds = await Promise.all(
		args.chunks.map(async (chunk) => {
			const shared = {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				fileNodeId: args.nodeId,
				sourceKind: "committed" as const,
				...(args.yjsSequence === undefined ? {} : { yjsSequence: args.yjsSequence }),
				chunkIndex: chunk.chunkIndex,
				startIndex: chunk.startIndex,
				endIndex: chunk.endIndex,
				lineStart: chunk.lineStart,
				lineEnd: chunk.lineEnd,
				chunkFlags: chunk.chunkFlags,
			};
			return await ctx.db.insert("files_text_chunks", { ...shared, textChunk: chunk.textChunk });
		}),
	);

	await Promise.all(
		args.chunks.map((chunk, index) =>
			ctx.db.insert("files_plain_text_chunks", {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				fileNodeId: args.nodeId,
				sourceKind: "committed",
				...(args.yjsSequence === undefined ? {} : { yjsSequence: args.yjsSequence }),
				textChunkId: textChunkIds[index]!,
				chunkIndex: chunk.chunkIndex,
				path: args.path,
				archiveOperationId: args.archiveOperationId,
				plainTextChunk: chunk.plainTextChunk,
				textChunk: chunk.textChunk,
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
		/**
		 * The chunker shape for this content. This argument REPLACES the old `contentType`
		 * derivation — the branch below is exhaustive on the closed union and on nothing else, so
		 * an unrecognised media type can never reach a throw inside the infinite-retry workpool.
		 * Editable nodes read it from `files_nodes.yjsRootKind`; read-only mounts pass the
		 * `"plain_text"` literal because a mount has no Yjs document to have a shape.
		 */
		rootKind: files_YjsRootKind;
		textContent: string;
		/**
		 * Repair-only escape: commit the chunks of a text whose frontmatter is over the index
		 * caps without inserting metadata docs, so the insert helper's over-cap backstop cannot
		 * throw mid-repair. The caller keeps the frontmatter marker pair set instead.
		 */
		skipFrontmatterIndex?: boolean;
	},
) {
	const chunks =
		args.rootKind === "rich_text"
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

	// Frontmatter is a rich-text (Markdown) concept only: a `.yaml` opening with `---` is plain
	// text and must not be frontmatter-indexed.
	if (args.rootKind === "rich_text" && !args.skipFrontmatterIndex) {
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
		/** Left out by the non-collaborative replace door: that file has no Yjs sequence. */
		yjsSequence?: number;
		textContent: string;
		/** Forwarded to `db_insert_file_text_content`; see the comment on its declaration. */
		skipFrontmatterIndex?: boolean;
	},
) {
	const fileNode = await ctx.db.get("files_nodes", args.nodeId);
	if (
		!fileNode ||
		fileNode.organizationId !== args.organizationId ||
		fileNode.workspaceId !== args.workspaceId ||
		!files_node_has_editable_text_content(fileNode)
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
			.query("files_text_chunks")
			.withIndex("by_organization_workspace_source_fileNode_yjsSeq_chunk", (q) =>
				q
					.eq("organizationId", args.organizationId)
					.eq("workspaceId", args.workspaceId)
					.eq("sourceKind", "committed")
					.eq("fileNodeId", args.nodeId),
			)
			.collect(),
		files_metadata_db_delete_committed_frontmatter(ctx, args),
	]).then(([plainTextChunkDocs, textChunkDocs]) =>
		Promise.all([
			...plainTextChunkDocs.map((doc) => ctx.db.delete("files_plain_text_chunks", doc._id)),
			...textChunkDocs.map((doc) => ctx.db.delete("files_text_chunks", doc._id)),
		]),
	);

	return db_insert_file_text_content(ctx, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		nodeId: args.nodeId,
		path: fileNode.path,
		archiveOperationId: fileNode.archiveOperationId,
		yjsSequence: args.yjsSequence,
		// Every replace targets an editable text node, collaborative or not, and the node owns the shape.
		rootKind: fileNode.yjsRootKind,
		textContent: args.textContent,
		skipFrontmatterIndex: args.skipFrontmatterIndex,
	});
}

export function files_nodes_create_yjs_snapshot_update_from_text(args: {
	text: string;
	/** The shape of the Yjs document this snapshot seeds; the body branches on it below. */
	rootKind: files_YjsRootKind;
}) {
	if (!args.text) {
		return Result({ _yay: files_u8_to_array_buffer(files_yjs_create_empty_state_update()) });
	}

	// The plain branch never constructs a Tiptap editor: the branch point is here, not inside
	// the Tiptap-only helpers below (threading `rootKind` through them would be a pass-through).
	if (args.rootKind === "plain_text") {
		const yjsDoc = files_yjs_doc_create_from_text({ text: args.text, rootKind: "plain_text" });
		if ("_nay" in yjsDoc) {
			return yjsDoc;
		}
		return Result({ _yay: files_u8_to_array_buffer(encodeStateAsUpdate(yjsDoc)) });
	}

	const editor = files_headless_tiptap_editor_create();
	if (editor._nay) {
		return editor;
	}

	const markdownContentSet = files_headless_tiptap_editor_set_content_from_markdown({
		markdown: args.text,
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
		/**
		 * The shape of this node's text. The writable and non-collaborative branches both write it
		 * as `files_nodes.yjsRootKind`; the read-only branch ignores it, because a mount has no Yjs
		 * document and always chunks as plain text.
		 */
		rootKind: files_YjsRootKind;
		textContent: string;
		readOnly: boolean;
		/**
		 * Create the file with committed content only and no Yjs document. The caller then needs no
		 * `yjsSnapshotAssetId`, because there is no snapshot to upload.
		 */
		nonCollaborative?: boolean;
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
			// Read-only mounts chunk as plain text, to the same boundaries as before the chunker
			// dispatched on this argument. `args.rootKind` is ignored here: a mount has no Yjs
			// document to have a shape, so the literal is the mount branch's answer.
			rootKind: "plain_text",
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

	// A non-collaborative file gets committed chunks and nothing else: no Yjs snapshot, no sequence
	// doc, no update log. It still stores `yjsRootKind`, so it chunks under its real shape and a
	// Markdown file keeps its frontmatter index — unlike the read-only mount branch above, which
	// forces plain text.
	if (args.nonCollaborative === true) {
		await db_insert_file_text_content(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId: args.nodeId,
			path: args.path,
			archiveOperationId: args.archiveOperationId,
			rootKind: args.rootKind,
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

		await ctx.db.patch("files_nodes", args.nodeId, {
			yjsRootKind: args.rootKind,
			nonCollaborative: true,
		});

		return;
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
			unmaterializedUpdateCount: 0,
			unmaterializedUpdateBytes: 0,
			lineageGeneration: 0,
		}),
		db_insert_file_text_content(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId: args.nodeId,
			path: args.path,
			archiveOperationId: args.archiveOperationId,
			yjsSequence: initialYjsSequence,
			rootKind: args.rootKind,
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
		// Record the shape beside the other Yjs pointers, in the same mutation that created the
		// document, so the node and its document can never be born disagreeing.
		yjsRootKind: args.rootKind,
	});
}

/**
 * Create a deletion job for each unpublished R2 asset. Then delete the asset docs.
 * Do both in the transaction that refuses the write, so a crash cannot lose the cleanup work.
 * The action already finished each R2 upload to its known key, even when `r2Key` is not set.
 * Keep missing or published assets. No upload can arrive later, so the deletion job needs no wait time.
 */
async function db_hand_unpublished_assets_to_deletion_ledger(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		assetIds: ReadonlyArray<Id<"files_r2_assets">>;
		reason: "failed_create" | "read_only_create" | "read_only_snapshot_restore" | "read_only_yjs_repair";
	},
) {
	for (const assetId of args.assetIds) {
		const asset = await ctx.db.get("files_r2_assets", assetId);
		if (!asset || asset.r2Key !== undefined) {
			continue;
		}

		// Add the job before deleting the doc. Both changes save together.
		// The deletion job now owns this R2 file.
		await r2_enqueue_object_deletion_job(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			r2Key: r2_create_asset_key({
				organizationId: asset.organizationId,
				workspaceId: asset.workspaceId,
				assetId: asset._id,
			}),
			reason: args.reason,
		});
		await ctx.db.delete("files_r2_assets", asset._id);
	}
}

/**
 * Find the current lock for a new file path.
 * Walk active children under `parentId`, like the create function does.
 *
 * - `anchorNode` is the deepest existing parent. It stores the nearest lock.
 * - `targetNode` is the active node at the final path, if one exists.
 * - `prefixPaths` contains every path part from root to the final path.
 *
 * Return null when the parent is missing or the path is empty. The create would also fail.
 */
async function db_resolve_create_destination_read_only_state(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		parentId: Doc<"files_nodes">["parentId"];
		path: string;
	},
) {
	const pathSegments = path_extract_segments_from(args.path);
	if (pathSegments.length === 0) {
		return null;
	}

	let anchorNode: Doc<"files_nodes"> | null = null;
	let currentParentPath: string;
	if (args.parentId === files_ROOT_ID) {
		currentParentPath = "/";
	} else {
		const parentNode = await ctx.db.get("files_nodes", args.parentId);
		if (
			!parentNode ||
			parentNode.organizationId !== args.organizationId ||
			parentNode.workspaceId !== args.workspaceId ||
			parentNode.kind !== "folder"
		) {
			return null;
		}
		anchorNode = parentNode;
		currentParentPath = parentNode.path;
	}

	let currentParentId: Doc<"files_nodes">["parentId"] = args.parentId;
	const prefixPaths: string[] = [];
	let targetNode: Doc<"files_nodes"> | null = null;

	// After one path part is missing, every deeper part is also missing.
	// Only build their paths after that.
	let missingSegments = false;

	for (const [i, name] of pathSegments.entries()) {
		const isLeaf = i === pathSegments.length - 1;
		let existing: Doc<"files_nodes"> | null = null;
		if (!missingSegments) {
			existing = await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_parent_name_archiveOperation", (q) =>
					q
						.eq("organizationId", args.organizationId)
						.eq("workspaceId", args.workspaceId)
						.eq("parentId", currentParentId)
						.eq("name", name)
						.eq("archiveOperationId", undefined),
				)
				.first();
		}

		if (existing) {
			prefixPaths.push(existing.path);
			currentParentPath = existing.path;
			if (isLeaf) {
				targetNode = existing;
			} else if (existing.kind === "folder") {
				anchorNode = existing;
				currentParentId = existing._id;
			} else {
				// This path part is a file. Nothing can exist below it, so the create will fail.
				missingSegments = true;
			}
		} else {
			missingSegments = true;
			currentParentPath = path_join(currentParentPath, name);
			prefixPaths.push(currentParentPath);
		}
	}

	return { anchorNode, targetNode, prefixPaths };
}

/**
 * Check the destination before the action writes R2 files.
 * `create_file_node` checks the destination and its lock again in the final transaction.
 */
export const get_create_file_node_write_preflight = internalQuery({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		parentId: v.union(v.id("files_nodes"), v.literal(files_ROOT_ID)),
		path: v.string(),
	},
	returns: v.union(
		v.null(),
		v.object({
			anchorReadOnlyScopeNodeId: v.union(v.id("files_nodes"), v.null()),
			targetNodeId: v.union(v.id("files_nodes"), v.null()),
		}),
	),
	handler: async (ctx, args) => {
		const membership = await ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_active_user_organization_workspace", (q) =>
				q
					.eq("active", true)
					.eq("userId", args.userId)
					.eq("organizationId", args.organizationId)
					.eq("workspaceId", args.workspaceId),
			)
			.first();
		if (!membership) {
			return null;
		}

		// Check access on the parent before reading deeper path data.
		// Do not reveal a hidden child or its lock.
		const authorized = await authorize_file_write(ctx, {
			userAuth: { id: args.userId },
			membership,
			nodeId: args.parentId,
		});
		if (authorized._nay) {
			return null;
		}

		const destination = await db_resolve_create_destination_read_only_state(ctx, args);
		if (!destination) {
			return null;
		}

		// Check access on every existing path part before returning lock or conflict data.
		// The final create walks the same path again.
		for (const prefixPath of destination.prefixPaths) {
			const segment = await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", args.organizationId)
						.eq("workspaceId", args.workspaceId)
						.eq("path", prefixPath)
						.eq("archiveOperationId", undefined),
				)
				.first();
			if (!segment) {
				break;
			}
			const segmentAuthorized = await authorize_file_write(ctx, {
				userAuth: { id: args.userId },
				membership,
				nodeId: segment._id,
			});
			if (segmentAuthorized._nay) {
				return null;
			}
		}

		return {
			anchorReadOnlyScopeNodeId: destination.anchorNode?.readOnlyScopeNodeId ?? null,
			targetNodeId: destination.targetNode?._id ?? null,
		};
	},
});

type get_create_file_node_write_preflight_Result =
	typeof get_create_file_node_write_preflight extends RegisteredQuery<
		infer _Visibility,
		infer _Args,
		infer ReturnValue
	>
		? Awaited<ReturnValue>
		: never;

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
		/**
		 * The document shape written on the node for writable files. Read-only mount files have
		 * no Yjs document, so their callers pass the mount literal and the insert ignores it.
		 */
		rootKind: v.union(v.literal("rich_text"), v.literal("plain_text")),
		readOnly: v.boolean(),
		mountId: v.optional(v.id("github_mounts")),
		syncRunId: v.optional(v.string()),
		/** Tenant assets already uploaded to R2. Add deletion jobs when this mutation refuses them. */
		unpublishedAssetIds: v.optional(v.array(v.id("files_r2_assets"))),
		/**
		 * File metadata that says where the file came from, written on the created file only. Only
		 * `create_file_node_internal` passes it, for the reserved-scope mirrors. The eager-create
		 * path must never pass it. A node with committed `metadata.` docs can no longer be
		 * hard-deleted, so discarding the proposal would leave the empty file behind forever.
		 */
		metadata: v.optional(v.array(v.object(files_metadata_entry_fields))),
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
			 * Folders created by this mutation, deepest first. Reused folders are not included.
			 */
			createdAncestorIds: v.array(v.id("files_nodes")),
		}),
	}),
	handler: async (ctx, args) => {
		const authorUserId = args.userId === users_SYSTEM_AUTHOR ? null : args.userId;
		const authorOrganizationId = ctx.db.normalizeId("organizations", String(args.organizationId));
		const authorWorkspaceId = ctx.db.normalizeId("organizations_workspaces", String(args.workspaceId));
		let authorMembership: Doc<"organizations_workspaces_users"> | null = null;

		// Reserved scopes use other cleanup and never pass tenant asset ids.
		if (args.unpublishedAssetIds && (!authorOrganizationId || !authorWorkspaceId)) {
			const errorMessage = "create_file_node unpublishedAssetIds requires a tenant scope";
			const errorData = { organizationId: args.organizationId, workspaceId: args.workspaceId, path: args.path };
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}

		// The action uploaded the R2 files before this mutation.
		// If this mutation refuses them, save their deletion jobs before deleting their asset docs.
		// A later crash cannot lose those jobs.
		const refuse = async (nay: { name?: string; message: string }) => {
			if (args.unpublishedAssetIds && authorOrganizationId && authorWorkspaceId) {
				await db_hand_unpublished_assets_to_deletion_ledger(ctx, {
					organizationId: authorOrganizationId,
					workspaceId: authorWorkspaceId,
					assetIds: args.unpublishedAssetIds,
					reason: "read_only_create",
				});
			}
			return Result({ _nay: nay });
		};

		if ((args.mountId == null) !== (args.syncRunId == null)) {
			return await refuse({ message: "External mount sync run requires mountId and syncRunId" });
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
				return await refuse({ message: "External mount sync was superseded" });
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
		if (authorUserId && authorOrganizationId && authorWorkspaceId) {
			authorMembership = await ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_active_user_organization_workspace", (q) =>
					q
						.eq("active", true)
						.eq("userId", authorUserId)
						.eq("organizationId", authorOrganizationId)
						.eq("workspaceId", authorWorkspaceId),
				)
				.first();
			if (!authorMembership) {
				return await refuse({ message: "Permission denied" });
			}

			const authorized = await authorize_file_write(ctx, {
				userAuth: { id: authorUserId },
				membership: authorMembership,
				nodeId: args.parentId,
			});
			if (authorized._nay) {
				return await refuse({ message: "Permission denied" });
			}
		}

		// Check the current destination again before the first insert.
		if (args.unpublishedAssetIds && authorOrganizationId && authorWorkspaceId) {
			const destination = await db_resolve_create_destination_read_only_state(ctx, {
				organizationId: authorOrganizationId,
				workspaceId: authorWorkspaceId,
				parentId: args.parentId,
				path: args.path,
			});
			if (!destination) {
				return await refuse({ message: "Not found" });
			}

			// Check access on every existing path part again.
			// A path part may have become restricted during the upload. Keep it hidden.
			if (!authorUserId || !authorMembership) {
				return await refuse({ message: "Permission denied" });
			}
			for (const prefixPath of destination.prefixPaths) {
				const segment = await ctx.db
					.query("files_nodes")
					.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
						q
							.eq("organizationId", authorOrganizationId)
							.eq("workspaceId", authorWorkspaceId)
							.eq("path", prefixPath)
							.eq("archiveOperationId", undefined),
					)
					.first();
				if (!segment) {
					break;
				}
				const segmentAuthorized = await authorize_file_write(ctx, {
					userAuth: { id: authorUserId },
					membership: authorMembership,
					nodeId: segment._id,
				});
				if (segmentAuthorized._nay) {
					return await refuse({ message: "Permission denied" });
				}
			}

			const anchorWritable = files_node_require_writable({
				readOnlyScopeNodeId: destination.anchorNode?.readOnlyScopeNodeId,
			});
			if (anchorWritable._nay) {
				return await refuse(anchorWritable._nay);
			}

			// A normal create needs an empty target path.
			// An archived replacement may share its path with an active node.
			if (destination.targetNode !== null && args.archiveOperationId === undefined) {
				return await refuse({ name: "nay", message: "This file already exists." });
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
			metadata: args.metadata,
			now,
			mut_createdAncestorIds: createdAncestorIds,
		});
		// The walk finds any conflict, access error, or lock before its first insert.
		// The refusal cannot leave part of a new folder tree behind.
		if (nodeIdResult._nay) {
			return await refuse(nodeIdResult._nay);
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
			rootKind: args.rootKind,
			textContent: args.textContent,
			readOnly: args.readOnly,
			yjsSnapshotAssetId: args.yjsSnapshotAssetId,
			userId: args.userId,
			now,
		});

		// Publish all editable-file data in the same transaction that creates the node.
		// A crash leaves either no file or one complete file with its first version snapshot.
		if (!args.readOnly) {
			if (!args.yjsSnapshotAssetId || !authorOrganizationId || !authorWorkspaceId || !authorUserId) {
				const errorMessage = "Editable file creation requires tenant asset ids and author";
				const errorData = { nodeId: insertedNode._id, yjsSnapshotAssetId: args.yjsSnapshotAssetId };
				console.error(errorMessage, errorData);
				throw should_never_happen(errorMessage, errorData);
			}
			const [yjsSnapshotAsset, versionSnapshotAsset] = await Promise.all([
				ctx.db.get("files_r2_assets", args.yjsSnapshotAssetId),
				ctx.db.get("files_r2_assets", args.assetId),
			]);
			if (!yjsSnapshotAsset || !versionSnapshotAsset) {
				const errorMessage = "Editable file creation asset id points to a missing files_r2_assets doc";
				const errorData = {
					nodeId: insertedNode._id,
					yjsSnapshotAssetId: args.yjsSnapshotAssetId,
					versionSnapshotAssetId: args.assetId,
				};
				console.error(errorMessage, errorData);
				throw should_never_happen(errorMessage, errorData);
			}
			await files_nodes_db_finalize_editable_text_node_creation(ctx, {
				organizationId: authorOrganizationId,
				workspaceId: authorWorkspaceId,
				nodeId: insertedNode._id,
				userId: authorUserId,
				yjsSnapshot: { assetId: args.yjsSnapshotAssetId, size: yjsSnapshotAsset.size },
				versionSnapshotAssetId: args.assetId,
				versionSnapshotSize: versionSnapshotAsset.size,
			});
		}

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

		return Result({
			_yay: {
				nodeId: nodeIdResult._yay,
				createdCommittedSequence,
				createdAncestorIds,
			},
		});
	},
});

/**
 * Publish an editable text file and its first version snapshot.
 * `node.assetId` points to the first version snapshot. Editable files have no current-content asset.
 * Set `r2Key` and size on both assets, then add the snapshot doc.
 * Call this inside the final publish mutation. Reserved scopes cannot call it.
 */
export async function files_nodes_db_finalize_editable_text_node_creation(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		nodeId: Id<"files_nodes">;
		userId: Id<"users">;
		/**
		 * Absent for a non-collaborative file. That file has no Yjs document, so there is no
		 * snapshot object to publish and no asset to point at one.
		 */
		yjsSnapshot?: { assetId: Id<"files_r2_assets">; size: number };
		versionSnapshotAssetId: Id<"files_r2_assets">;
		versionSnapshotSize: number;
	},
) {
	const now = Date.now();
	const yjsSnapshot = args.yjsSnapshot;

	await Promise.all([
		yjsSnapshot
			? ctx.db.patch("files_r2_assets", yjsSnapshot.assetId, {
					r2Key: r2_create_asset_key({
						organizationId: args.organizationId,
						workspaceId: args.workspaceId,
						assetId: yjsSnapshot.assetId,
					}),
					size: yjsSnapshot.size,
					unfinalizedExpiresAt: undefined,
					updatedAt: now,
				})
			: Promise.resolve(null),
		ctx.db.patch("files_r2_assets", args.versionSnapshotAssetId, {
			r2Key: r2_create_asset_key({
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				assetId: args.versionSnapshotAssetId,
			}),
			size: args.versionSnapshotSize,
			unfinalizedExpiresAt: undefined,
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

export const cleanup_file_node_creation_assets = internalMutation({
	args: {
		assetIds: v.array(v.id("files_r2_assets")),
		r2Keys: v.array(v.string()),
		durableTenantScope: v.optional(
			v.object({
				organizationId: v.id("organizations"),
				workspaceId: v.id("organizations_workspaces"),
			}),
		),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		if (args.durableTenantScope) {
			await db_hand_unpublished_assets_to_deletion_ledger(ctx, {
				...args.durableTenantScope,
				assetIds: args.assetIds,
				reason: "failed_create",
			});
			return null;
		}

		// Reserved mount assets cannot use deletion jobs that need a tenant.
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

		// Say where a mirrored file came from, so `meta search` can tell a GitHub mount file from a
		// plugin source file. The workspace the file lands in is the only thing that separates them.
		const metadata: files_metadata_Entry[] = [
			{
				key: "source",
				value: args.workspaceId === organizations_GLOBAL_GITHUB_WORKSPACE_ID ? "github-mount" : "plugin-source",
			},
		];

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
			const mountRoot = mount.pendingCommitSha == null ? null : `/${mount.name}/${mount.pendingCommitSha}/`;
			if (mountRoot === null || !args.path.startsWith(mountRoot)) {
				return Result({ _nay: { message: "External mount path does not belong to the pending sync root" } });
			}
			// The stored path starts with the mount name and the commit sha. Keep what follows, so the
			// file also carries the path the repository itself uses.
			metadata.push({ key: "repo-path", value: args.path.slice(mountRoot.length) });
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
					// A mount file has no Yjs document to have a shape; the read-only branch chunks
					// with its own mount literal and ignores this value.
					rootKind: "plain_text",
					readOnly: true,
					mountId: args.mountId,
					syncRunId: args.syncRunId,
					metadata,
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

type action_create_file_node_Result =
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

async function action_create_file_node(
	ctx: ActionCtx,
	args: {
		userId: Id<"users">;
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		parentId: Doc<"files_nodes">["parentId"];
		path: string;
		textContent: string;
		/** The stored media type and document shape; callers derive both from the same name. */
		contentType: files_ContentType;
		rootKind: files_YjsRootKind;
		archiveOperationId?: Doc<"files_nodes">["archiveOperationId"];
	},
): Promise<action_create_file_node_Result> {
	// Check the destination before writing any asset doc or R2 file.
	const preflight = (await ctx.runQuery(internal.files_nodes_content.get_create_file_node_write_preflight, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		userId: args.userId,
		parentId: args.parentId,
		path: args.path,
	})) as get_create_file_node_write_preflight_Result;
	if (!preflight) {
		return Result({ _nay: { message: "Not found" } });
	}

	// Refuse a locked destination before there is anything to clean up.
	// The deepest existing parent stores the nearest lock.
	const anchorWritable = files_node_require_writable({
		readOnlyScopeNodeId: preflight.anchorReadOnlyScopeNodeId ?? undefined,
	});
	if (anchorWritable._nay) {
		return anchorWritable;
	}

	// Refuse an occupied target here so no R2 work is needed.
	if (preflight.targetNodeId !== null && args.archiveOperationId === undefined) {
		return Result({ _nay: { name: "nay", message: "This file already exists." } });
	}

	const snapshotUpdate = files_nodes_create_yjs_snapshot_update_from_text({
		text: args.textContent,
		rootKind: args.rootKind,
	});
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
			size: files_get_utf8_byte_size(args.textContent),
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
			durableTenantScope: {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
			},
		});
	};

	// Editable files do not store their current content in R2. Reads use the committed chunks.
	// We only upload the Yjs snapshot and the first version snapshot. The node points at the
	// version snapshot: the newest snapshot always holds the file's current bytes.
	const putResults = await Promise.allSettled([
		r2_put_object(ctx, {
			key: yjsSnapshotR2Key,
			body: snapshotUpdate._yay,
			contentType: "application/octet-stream" satisfies files_ContentType,
		}),
		r2_put_object(ctx, {
			key: versionSnapshotR2Key,
			body: args.textContent,
			// Downloads use this version snapshot, so store the file type on it.
			contentType: args.contentType,
		}),
	]);
	const failedPut = putResults.find((result) => result.status === "rejected");
	if (failedPut?.status === "rejected") {
		// Wait for both PUTs before starting cleanup.
		// Otherwise, a late PUT could recreate an R2 file after its asset doc and deletion job are gone.
		await cleanupCreatedAssets();
		console.error("Failed to write initial file content assets", {
			error: failedPut.reason,
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
		contentType: args.contentType,
		assetId: versionSnapshotAssetId,
		yjsSnapshotAssetId,
		textContent: args.textContent,
		rootKind: args.rootKind,
		readOnly: false,
		archiveOperationId: args.archiveOperationId,
		unpublishedAssetIds: assetIds,
	})) as create_file_node_Result;
	// The mutation already added deletion jobs and deleted both asset docs when it refused.
	// Do not start the same cleanup again here.
	if (created._nay) {
		return created;
	}

	return Result({
		_yay: {
			nodeId: created._yay.nodeId,
			createdCommittedSequence: created._yay.createdCommittedSequence,
			createdAncestorIds: created._yay.createdAncestorIds,
		},
	});
}

export const create_text_node = action({
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

		// The public create action stays Markdown-only by product rule. Plain text
		// files enter the workspace by upload or by an agent write only.
		const created = await action_create_file_node(ctx, {
			userId: userAuth.id,
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			parentId: args.parentId,
			textContent: files_INITIAL_CONTENT,
			contentType: "text/markdown;charset=utf-8" satisfies files_ContentType,
			rootKind: "rich_text",
			path: args.path,
		});
		if (created._nay) {
			return created;
		}

		// The creation-time sequence capture is internal plumbing; keep the public shape.
		return Result({ _yay: { nodeId: created._yay.nodeId } });
	},
});

export const get_file_text_content_db_state_by_path = internalQuery({
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
			/**
			 * The node's current content asset, set only when collaboration is off for this file.
			 * That file is saved by replacing the whole text, and its save uses this asset as the
			 * base it must still be sitting on. Null for every other file, including a read-only
			 * mount, so a caller cannot mistake one for a file it may replace.
			 */
			nonCollaborativeBaseAssetId: v.union(v.id("files_r2_assets"), v.null()),
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
		// directly and leave `content` undefined so `get_file_last_available_text_content_by_path`
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
				nonCollaborativeBaseAssetId: null,
			};
		}

		// A non-collaborative file passes here too. It has no materialization state, so the
		// committed-chunks merge at the end of this handler is what serves its text.
		if (!files_node_has_editable_text_content(fileNode)) return null;

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
		let pendingUpdateContent = pendingUpdate ? files_pending_update_content_of(pendingUpdate) : null;
		// A stale-generation proposal was built against a document history that a repair has
		// since replaced. The commit gate refuses it, so its text must not be served as the
		// file's current pending content either: treat it as no pending content and resolve
		// from the committed tree. The doc keeps its `pendingUpdateId` below, so the agent's
		// next write mixes onto it and rebuilds the family from the live state.
		//
		// A non-collaborative file has no last-sequence doc and, by the same rule, no pending
		// content, so the second condition skips a lookup that would find nothing.
		if (pendingUpdateContent && fileNode.yjsLastSequenceId) {
			const lastSequenceDoc = await ctx.db.get("files_yjs_docs_last_sequences", fileNode.yjsLastSequenceId);
			if (!lastSequenceDoc || lastSequenceDoc.lineageGeneration !== pendingUpdateContent.baseLineageGeneration) {
				pendingUpdateContent = null;
			}
		}
		if (pendingUpdate && pendingUpdateContent) {
			// Rebuild the pending branch from its canonical unstaged paged state (a full state, so
			// no base merge is needed). On any refusal the pending read is NULL — the agent reports
			// the file as unavailable — never the committed text: falling through to committed
			// content is what would make an `edit_file` overwrite the user's whole proposal.
			const unstagedStateDoc = await ctx.db.get(
				"files_pending_update_yjs_states",
				pendingUpdateContent.unstagedStateId,
			);
			if (
				!unstagedStateDoc ||
				unstagedStateDoc.organizationId !== organizationId ||
				unstagedStateDoc.workspaceId !== workspaceId
			) {
				console.error("Pending update content group points to a missing state doc", {
					nodeId: fileNode._id,
					pendingUpdateId: pendingUpdate._id,
					unstagedStateId: pendingUpdateContent.unstagedStateId,
				});
				return null;
			}
			const unstagedBytes = await files_db_load_pending_update_yjs_state_bytes(ctx, {
				stateDoc: unstagedStateDoc,
			});
			if (unstagedBytes._nay) {
				console.error("Failed to reconstruct pending state from files_pending_update_yjs_state_pages", {
					nay: { message: unstagedBytes._nay.message },
					nodeId: fileNode._id,
					pendingUpdateId: pendingUpdate._id,
				});
				return null;
			}

			const yjsDoc = files_yjs_doc_create_from_array_buffer_update(files_u8_to_array_buffer(unstagedBytes._yay));
			const text = files_yjs_doc_get_text({ yjsDoc, rootKind: fileNode.yjsRootKind });
			if (text._nay) {
				console.error("Failed to reconstruct text from files_pending_updates", {
					nay: { message: text._nay.message },
					nodeId: fileNode._id,
				});
				return null;
			}

			return {
				content: text._yay,
				asset: null,
				nodeId: fileNode._id,
				displayNodeId: fileNode._id,
				pendingUpdateId: pendingUpdate._id,
				materializationState: null,
				nonCollaborativeBaseAssetId: null,
			};
		}

		const asset = fileNode.assetId
			? await ctx.db
					.get("files_r2_assets", fileNode.assetId)
					.then((asset) =>
						asset && asset.organizationId === organizationId && asset.workspaceId === workspaceId ? asset : null,
					)
			: null;

		const nonCollaborativeBaseAssetId = fileNode.nonCollaborative === true ? fileNode.assetId : null;

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
				.query("files_text_chunks")
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
					nonCollaborativeBaseAssetId,
				};
			}
		}

		return {
			asset,
			nodeId: fileNode._id,
			displayNodeId: fileNode._id,
			pendingUpdateId: pendingUpdate?._id ?? null,
			materializationState,
			nonCollaborativeBaseAssetId,
		};
	},
});

type get_file_text_content_db_state_by_path_Result =
	typeof get_file_text_content_db_state_by_path extends RegisteredQuery<
		infer _Visibility,
		infer _Args,
		infer ReturnValue
	>
		? Awaited<ReturnValue>
		: never;

type get_file_last_available_text_content_by_path_Result = {
	content: string;
	nodeId: Id<"files_nodes">;
	displayNodeId: Id<"files_nodes">;
	pendingUpdateId: Id<"files_pending_updates"> | null;
	nonCollaborativeBaseAssetId: Id<"files_r2_assets"> | null;
} | null;

export const get_file_last_available_text_content_by_path = internalAction({
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
			/** See the same field on `get_file_text_content_db_state_by_path`. */
			nonCollaborativeBaseAssetId: v.union(v.id("files_r2_assets"), v.null()),
		}),
		v.null(),
	),
	handler: async (ctx, args): Promise<get_file_last_available_text_content_by_path_Result> => {
		const contentState = (await ctx.runQuery(internal.files_nodes_content.get_file_text_content_db_state_by_path, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			path: args.path,
			pendingUpdateId: args.pendingUpdateId,
			includePending: args.includePending,
			overlayUserId: args.overlayUserId,
			maxBytes: args.maxBytes,
		})) as get_file_text_content_db_state_by_path_Result;
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
			nonCollaborativeBaseAssetId: contentState.nonCollaborativeBaseAssetId,
		};
	},
});

export type files_nodes_get_file_last_available_text_content_by_path_Result =
	typeof get_file_last_available_text_content_by_path extends RegisteredAction<
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
	const state = (await ctx.runQuery(internal.files_nodes_content.get_file_text_content_db_state_by_path, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		userId: args.userId,
		path: args.path,
		pendingUpdateId: args.pendingUpdateId,
		overlayUserId: args.overlayUserId,
	})) as get_file_text_content_db_state_by_path_Result;
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
		const state = (await ctx.runQuery(internal.files_nodes_content.get_file_text_content_db_state_by_path, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			path: args.path,
			pendingUpdateId: args.pendingUpdateId,
			overlayUserId: args.overlayUserId,
		})) as get_file_text_content_db_state_by_path_Result;
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
 * Create an editable text file at a trusted path, for the agent write flows (bash redirects,
 * cp, touch). The classifier decides the stored media type and document shape from the path's
 * file name; unknown extensions refuse with the classifier's rule. The public create action and
 * the sidebar New-file flow stay Markdown-only on purpose.
 *
 * Trust callers to validate and normalize `path` before calling this action.
 */
export const create_file_by_path = internalAction({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		path: v.string(),
		textContent: v.optional(v.string()),
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
			 * Folders created with this file, deepest first. Reused folders are not included.
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

		// Extension decides everything: the media type and the document shape come from the same
		// name, so they can never disagree, and an unwritable extension refuses before any write.
		const fileName = path_name_of(args.path);
		const contentType = files_get_editable_text_content_type(fileName);
		const rootKind = files_get_editable_text_yjs_root_kind(fileName);
		if (contentType === null || rootKind === null) {
			return Result({ _nay: { message: files_editable_text_refusal_message(fileName) } });
		}

		const created = await action_create_file_node(ctx, {
			userId: args.userId,
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			parentId: files_ROOT_ID,
			path: args.path,
			textContent: args.textContent ?? "",
			contentType,
			rootKind,
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
		const result = await action_create_file_node(ctx, {
			userId: args.userId,
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			parentId: files_ROOT_ID,
			path: "README.md" satisfies files_SpecialFileName,
			// Keep the auto-created home file consistent with user-created Markdown files.
			textContent: files_INITIAL_CONTENT,
			contentType: "text/markdown;charset=utf-8" satisfies files_ContentType,
			rootKind: "rich_text",
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
		expectedYjsLastSequenceId: Id<"files_yjs_docs_last_sequences">;
	},
) {
	// Trusted server-built bytes skip door 1's content scan, but every writer goes through the
	// shared reserve gate: doc byte caps, durable-marker refusal, and the aggregate budget.
	const reserved = await yjs_reserve_and_increment_last_sequence(ctx, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		nodeId: args.nodeId,
		userId: args.userId,
		expectedYjsLastSequenceId: args.expectedYjsLastSequenceId,
		updateByteLength: args.restoreUpdate.byteLength,
	});
	if (reserved._nay) {
		return reserved;
	}
	const newSequenceData = reserved._yay;

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

	return Result({ _yay: newSequenceData.lastSequence });
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
	// Read text under the node's stored shape. The getter's first-statement
	// guard refuses a document whose text is not addressable under that shape.
	const markdown = files_yjs_doc_get_text({
		yjsDoc,
		rootKind: args.state.fileNode.yjsRootKind,
	});

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
 * Replace the current content of an editable text file in place, keeping the same nodeId.
 * The caller has already validated the node (editable, same scope) and PUT the new content bytes
 * at the content snapshot asset's deterministic key. `fillUpdateStageId` points at the staged
 * server-built Yjs diff (kind `public_fill`) computed against the doc state the caller
 * reconstructed; open editors apply it as a remote change. The caller omits it when the diff is
 * empty (the new content equals the current content). Staging keeps this mutation's registered
 * envelope at one large value: the `textContent` text.
 */
export async function files_nodes_db_fill_text_node_content(
	ctx: MutationCtx,
	args: {
		// Editable files only exist in real tenant scopes, so the caller passes the already
		// scope-checked ids instead of the node's wider reserved-scope union fields.
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		// A non-collaborative file has no Yjs pointers, so they stay optional here. It also never
		// carries a `fillUpdateStageId`: there is no document for a diff to apply to.
		fileNode: Doc<"files_nodes"> & {
			assetId: NonNullable<Doc<"files_nodes">["assetId"]>;
		};
		userId: Id<"users">;
		textContent: string;
		contentSnapshotAssetId: Id<"files_r2_assets">;
		contentSize: number;
		fillUpdateStageId?: Id<"files_yjs_trusted_update_stages">;
		expectedYjsLastSequenceId?: Id<"files_yjs_docs_last_sequences">;
	},
) {
	const now = Date.now();
	const { organizationId, workspaceId } = args;

	await Promise.all([
		ctx.db.patch("files_r2_assets", args.contentSnapshotAssetId, {
			r2Key: r2_create_asset_key({ organizationId, workspaceId, assetId: args.contentSnapshotAssetId }),
			size: args.contentSize,
			unfinalizedExpiresAt: undefined,
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

	// A non-collaborative file leaves this undefined: its committed chunks belong to no sequence.
	let yjsSequence: number | undefined;
	if (args.fillUpdateStageId) {
		// Consume the staged trusted update, then run the shared reserve gate. Throw, do not
		// return `_nay`: the writes above already pointed the node at the new content snapshot in
		// this same mutation, so a returned refusal would commit that state without its Yjs update.
		const fillUpdate = await files_db_consume_trusted_yjs_update_stage(ctx, {
			stageId: args.fillUpdateStageId,
			organizationId,
			workspaceId,
			userId: args.userId,
			nodeId: args.fileNode._id,
			kind: "public_fill",
		});
		if (fillUpdate._nay) {
			throw convex_error({ message: fillUpdate._nay.message });
		}
		if (!args.expectedYjsLastSequenceId) {
			throw should_never_happen("Collaborative fill has no expected Yjs lineage", {
				nodeId: args.fileNode._id,
			});
		}
		// Trusted server-built bytes skip door 1's content scan, but every writer goes through
		// the shared reserve gate.
		const reserved = await yjs_reserve_and_increment_last_sequence(ctx, {
			organizationId,
			workspaceId,
			nodeId: args.fileNode._id,
			userId: args.userId,
			expectedYjsLastSequenceId: args.expectedYjsLastSequenceId,
			updateByteLength: fillUpdate._yay.byteLength,
		});
		if (reserved._nay) {
			throw convex_error({ message: reserved._nay.message });
		}
		const newSequenceData = reserved._yay;
		await ctx.db.insert("files_yjs_updates", {
			organizationId,
			workspaceId,
			fileNodeId: args.fileNode._id,
			sequence: newSequenceData.lastSequence,
			update: fillUpdate._yay,
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
	} else if (files_node_has_editable_yjs_state(args.fileNode)) {
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
		textContent: args.textContent,
	});
}

const FILE_CONTENT_CLEANUP_BATCH_SIZE = 32;

async function db_delete_covered_file_content_docs(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		nodeId: Id<"files_nodes">;
		throughSequence: number;
	},
) {
	const coveredUpdateDocs = await ctx.db
		.query("files_yjs_updates")
		.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
			q
				.eq("organizationId", args.organizationId)
				.eq("workspaceId", args.workspaceId)
				.eq("fileNodeId", args.nodeId)
				.lte("sequence", args.throughSequence),
		)
		.take(FILE_CONTENT_CLEANUP_BATCH_SIZE);
	await Promise.all(coveredUpdateDocs.map((doc) => ctx.db.delete("files_yjs_updates", doc._id)));

	if (coveredUpdateDocs.length === FILE_CONTENT_CLEANUP_BATCH_SIZE) {
		return true;
	}

	// Delete the settled jobs only after the final update batch so each continuation stays small.
	const materializationJobDocs = await ctx.db
		.query("files_content_materialization_jobs")
		.withIndex("by_fileNode", (q) => q.eq("fileNodeId", args.nodeId))
		.collect();
	await Promise.all(
		materializationJobDocs
			.filter((doc) => doc.targetSequence <= args.throughSequence)
			.map((doc) => ctx.db.delete("files_content_materialization_jobs", doc._id)),
	);

	return false;
}

export const finalize_file_content_materialization = internalMutation({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		nodeId: v.id("files_nodes"),
		userId: v.id("users"),
		expectedYjsSnapshotId: v.id("files_yjs_snapshots"),
		expectedYjsLastSequenceId: v.id("files_yjs_docs_last_sequences"),
		sequence: v.number(),
		targetSequence: v.number(),
		text: v.string(),
		versionSnapshotAssetId: v.id("files_r2_assets"),
		textSize: v.number(),
		yjsSnapshotSize: v.number(),
		_errors: v.optional(
			v.object({
				message: v.literal("Failed to materialize file content"),
			}),
		),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		// The header carries every doc except the update log. The covered log is never loaded
		// here: one allowed update doc may itself be 930,000 bytes, and the bounded continuation
		// scheduled below deletes the covered docs after this transaction commits.
		const header = (await ctx.runQuery(internal.files_nodes.get_file_content_materialization_header, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId: args.nodeId,
			targetSequence: args.targetSequence,
		})) as get_file_content_materialization_header_Result;
		if (!header) {
			return Result({ _yay: null });
		}

		if (
			header.fileNode.yjsSnapshotId !== args.expectedYjsSnapshotId ||
			header.fileNode.yjsLastSequenceId !== args.expectedYjsLastSequenceId ||
			header.yjsSnapshotDoc._id !== args.expectedYjsSnapshotId ||
			header.yjsLastSequenceDoc._id !== args.expectedYjsLastSequenceId ||
			header.yjsLastSequenceDoc.lastSequence !== args.sequence ||
			args.sequence !== args.targetSequence
		) {
			return Result({ _yay: null });
		}

		const now = Date.now();

		// This materialization covers every update up to `args.sequence`. Recompute the aggregate
		// counters from the docs that stay unmaterialized (pushed while this run was in flight),
		// so they become exact at every successful finalization even for files whose older
		// updates were never counted. The writers' reserve budget bounds this read.
		const remainingUpdatesDocs = await ctx.db
			.query("files_yjs_updates")
			.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
				q
					.eq("organizationId", args.organizationId)
					.eq("workspaceId", args.workspaceId)
					.eq("fileNodeId", args.nodeId)
					.gt("sequence", args.sequence),
			)
			.collect();

		const dbWriteResult = Result_all(
			await Promise.all([
				// Point the node at the new version snapshot. It now holds the file's current
				// bytes, so downloads sign it and reads use its size as the byte cap.
				// Reaching here means the content fit, its text was read under its declared
				// shape, and the frontmatter fit its caps — so clear every earlier durable
				// refusal marker.
				ctx.db.patch("files_nodes", args.nodeId, {
					assetId: args.versionSnapshotAssetId,
					contentTooLargeByteSize: undefined,
					contentShapeMismatchAt: undefined,
					contentYjsStateTooLargeByteSize: undefined,
					contentFrontmatterTooLargeFieldCount: undefined,
					contentFrontmatterTooLargeIndexDocumentCount: undefined,
				}),
				ctx.db.patch("files_yjs_docs_last_sequences", header.yjsLastSequenceDoc._id, {
					unmaterializedUpdateCount: remainingUpdatesDocs.length,
					unmaterializedUpdateBytes: remainingUpdatesDocs.reduce(
						(total, updateData) => total + updateData.update.byteLength,
						0,
					),
				}),
				ctx.db.patch("files_r2_assets", header.yjsSnapshotAsset._id, {
					r2Key: r2_create_asset_key({
						organizationId: args.organizationId,
						workspaceId: args.workspaceId,
						assetId: header.yjsSnapshotAsset._id,
					}),
					size: args.yjsSnapshotSize,
					unfinalizedExpiresAt: undefined,
					updatedAt: now,
				}),
				ctx.db.patch("files_r2_assets", args.versionSnapshotAssetId, {
					r2Key: r2_create_asset_key({
						organizationId: args.organizationId,
						workspaceId: args.workspaceId,
						assetId: args.versionSnapshotAssetId,
					}),
					size: args.textSize,
					unfinalizedExpiresAt: undefined,
					updatedAt: now,
				}),
				ctx.db.patch("files_yjs_snapshots", header.yjsSnapshotDoc._id, {
					sequence: args.sequence,
					updatedBy: users_SYSTEM_AUTHOR,
					updatedAt: now,
				}),
				db_replace_file_chunks(ctx, {
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					nodeId: args.nodeId,
					yjsSequence: args.sequence,
					textContent: args.text,
				}),
				store_version_snapshot(ctx, {
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					nodeId: args.nodeId,
					assetId: args.versionSnapshotAssetId,
					userId: args.userId,
				}),
			]),
		);

		if (dbWriteResult._nay) {
			const errorMessage = "Failed to materialize file content" satisfies NonNullable<
				(typeof args)["_errors"]
			>["message"];
			console.error(errorMessage, {
				dbWriteResult,
			});
			// Throw so Convex rolls back every related write above. Returning `_nay` would commit
			// the node and snapshot changes after chunk replacement had already failed.
			throw convex_error({
				message: errorMessage,
				cause: dbWriteResult._nay,
			});
		}

		// The advanced snapshot sequence already hides every covered update doc from readers. They
		// filter on `sequence > snapshot.sequence`, so bounded batches delete the update docs and
		// their settled job docs after this commit instead of loading them into this transaction.
		await ctx.scheduler.runAfter(0, internal.files_nodes_content.cleanup_file_materialization_covered_rows, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId: args.nodeId,
			expectedYjsLastSequenceId: args.expectedYjsLastSequenceId,
			throughSequence: args.sequence,
		});

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
 * Delete the update docs a finalized materialization covered, plus its settled job docs, in
 * bounded batches. The finalize commit already advanced the snapshot sequence past these docs,
 * so readers ignore them; this only reclaims storage without loading the whole covered log into
 * one transaction.
 */
export const cleanup_file_materialization_covered_rows = internalMutation({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		nodeId: v.id("files_nodes"),
		expectedYjsLastSequenceId: v.id("files_yjs_docs_last_sequences"),
		throughSequence: v.number(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const fileNode = await ctx.db.get("files_nodes", args.nodeId);
		if (
			!fileNode ||
			fileNode.organizationId !== args.organizationId ||
			fileNode.workspaceId !== args.workspaceId ||
			fileNode.yjsLastSequenceId !== args.expectedYjsLastSequenceId
		) {
			return null;
		}

		if (await db_delete_covered_file_content_docs(ctx, args)) {
			await ctx.scheduler.runAfter(0, internal.files_nodes_content.cleanup_file_materialization_covered_rows, args);
			return null;
		}

		return null;
	},
});

/**
 * Settle a materialization that produced text over `files_MAX_TEXT_CONTENT_BYTES`.
 *
 * Retrying cannot make the content smaller. So this records why the node stopped advancing and
 * deletes the job doc instead of failing. It does not cancel the workpool item, the same way
 * `finalize_file_content_materialization` does not. A later run for the same sequence just marks
 * the node again.
 */
export const mark_file_content_too_large = internalMutation({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		nodeId: v.id("files_nodes"),
		expectedYjsSnapshotId: v.id("files_yjs_snapshots"),
		expectedYjsLastSequenceId: v.id("files_yjs_docs_last_sequences"),
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
		if (
			state.fileNode.yjsSnapshotId !== args.expectedYjsSnapshotId ||
			state.fileNode.yjsLastSequenceId !== args.expectedYjsLastSequenceId ||
			state.yjsSnapshotDoc._id !== args.expectedYjsSnapshotId ||
			state.yjsLastSequenceDoc._id !== args.expectedYjsLastSequenceId ||
			state.yjsLastSequenceDoc.lastSequence !== args.sequence ||
			args.sequence !== args.targetSequence
		) {
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

/**
 * Settle a materialization whose text could not be read under the node's declared shape.
 *
 * A returned `_nay` is a successful workpool completion, so nothing retries — without a marker
 * the snapshot would stay behind `lastSequence` forever and readers would report a missing
 * file. This records why the node stopped advancing; readers report it and
 * `repair_file_yjs_state_from_visible_text` is the named recovery. Same staleness gate and job
 * settlement as `mark_file_content_too_large`; the next successful finalization clears the
 * marker.
 */
export const mark_file_content_shape_mismatch = internalMutation({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		nodeId: v.id("files_nodes"),
		expectedYjsSnapshotId: v.id("files_yjs_snapshots"),
		expectedYjsLastSequenceId: v.id("files_yjs_docs_last_sequences"),
		sequence: v.number(),
		targetSequence: v.number(),
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
		// already replaced this job; its own materialization decides again.
		if (
			state.fileNode.yjsSnapshotId !== args.expectedYjsSnapshotId ||
			state.fileNode.yjsLastSequenceId !== args.expectedYjsLastSequenceId ||
			state.yjsSnapshotDoc._id !== args.expectedYjsSnapshotId ||
			state.yjsLastSequenceDoc._id !== args.expectedYjsLastSequenceId ||
			state.yjsLastSequenceDoc.lastSequence !== args.sequence ||
			args.sequence !== args.targetSequence
		) {
			return null;
		}

		const jobs = await ctx.db
			.query("files_content_materialization_jobs")
			.withIndex("by_fileNode", (q) => q.eq("fileNodeId", args.nodeId))
			.collect();

		await Promise.all([
			ctx.db.patch("files_nodes", args.nodeId, {
				contentShapeMismatchAt: Date.now(),
			}),
			...jobs
				.filter((job) => job.targetSequence <= args.targetSequence)
				.map((job) => ctx.db.delete("files_content_materialization_jobs", job._id)),
		]);

		return null;
	},
});

/**
 * Settles a materialization whose reconstructed Yjs state (or stored snapshot) exceeds the
 * 4 MiB cap. Retrying cannot make the state smaller; only the operator repair can. Same
 * staleness gate and clearing rule as the shape marker above.
 */
export const mark_file_content_yjs_state_too_large = internalMutation({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		nodeId: v.id("files_nodes"),
		expectedYjsSnapshotId: v.id("files_yjs_snapshots"),
		expectedYjsLastSequenceId: v.id("files_yjs_docs_last_sequences"),
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

		if (
			state.fileNode.yjsSnapshotId !== args.expectedYjsSnapshotId ||
			state.fileNode.yjsLastSequenceId !== args.expectedYjsLastSequenceId ||
			state.yjsSnapshotDoc._id !== args.expectedYjsSnapshotId ||
			state.yjsLastSequenceDoc._id !== args.expectedYjsLastSequenceId ||
			state.yjsLastSequenceDoc.lastSequence !== args.sequence ||
			args.sequence !== args.targetSequence
		) {
			return null;
		}

		const jobs = await ctx.db
			.query("files_content_materialization_jobs")
			.withIndex("by_fileNode", (q) => q.eq("fileNodeId", args.nodeId))
			.collect();

		await Promise.all([
			ctx.db.patch("files_nodes", args.nodeId, {
				contentYjsStateTooLargeByteSize: args.byteSize,
			}),
			...jobs
				.filter((job) => job.targetSequence <= args.targetSequence)
				.map((job) => ctx.db.delete("files_content_materialization_jobs", job._id)),
		]);

		return null;
	},
});

/**
 * Settle a materialization whose rendered Markdown text carries more frontmatter than the caps
 * allow (`files_metadata_MAX_FRONTMATTER_FIELDS` fields, or
 * `files_metadata_MAX_FRONTMATTER_INDEX_DOCUMENTS` total index documents including `maybe_date`
 * companions). Retrying cannot shrink the frontmatter, and letting the insert helper throw would
 * block the infinite-retry workpool for every other file. Same staleness gate and job settlement
 * as the other markers; the next successful finalization clears both fields.
 */
export const mark_file_content_frontmatter_too_large = internalMutation({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		nodeId: v.id("files_nodes"),
		expectedYjsSnapshotId: v.id("files_yjs_snapshots"),
		expectedYjsLastSequenceId: v.id("files_yjs_docs_last_sequences"),
		sequence: v.number(),
		targetSequence: v.number(),
		fieldCount: v.number(),
		indexDocumentCount: v.number(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const header = (await ctx.runQuery(internal.files_nodes.get_file_content_materialization_header, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId: args.nodeId,
			targetSequence: args.targetSequence,
		})) as get_file_content_materialization_header_Result;
		if (!header) {
			return null;
		}

		// Use the same staleness gate as `finalize_file_content_materialization`. A newer push
		// already replaced this job; its own materialization decides again.
		if (
			header.fileNode.yjsSnapshotId !== args.expectedYjsSnapshotId ||
			header.fileNode.yjsLastSequenceId !== args.expectedYjsLastSequenceId ||
			header.yjsSnapshotDoc._id !== args.expectedYjsSnapshotId ||
			header.yjsLastSequenceDoc._id !== args.expectedYjsLastSequenceId ||
			header.yjsLastSequenceDoc.lastSequence !== args.sequence ||
			args.sequence !== args.targetSequence
		) {
			return null;
		}

		const jobs = await ctx.db
			.query("files_content_materialization_jobs")
			.withIndex("by_fileNode", (q) => q.eq("fileNodeId", args.nodeId))
			.collect();

		await Promise.all([
			ctx.db.patch("files_nodes", args.nodeId, {
				contentFrontmatterTooLargeFieldCount: args.fieldCount,
				contentFrontmatterTooLargeIndexDocumentCount: args.indexDocumentCount,
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
		// The header freezes `throughSequence = targetSequence` and returns no update log: one
		// allowed update doc may itself be 930,000 bytes, so the log is read one doc per call
		// below. A concurrent `S+1` push is ignored by this run — its own job covers it.
		const header = (await ctx.runQuery(internal.files_nodes.get_file_content_materialization_header, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId: args.nodeId,
			targetSequence: args.targetSequence,
		})) as get_file_content_materialization_header_Result;
		if (!header) {
			return Result({ _yay: null });
		}

		// Snapshot-size preflight before any GET: a stored base over the reconstructed-state cap
		// cannot materialize, and downloading it first would only pay for the refusal.
		if (header.yjsSnapshotAsset.size > files_MAX_YJS_RECONSTRUCTED_STATE_BYTES) {
			await ctx.runMutation(internal.files_nodes_content.mark_file_content_yjs_state_too_large, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				nodeId: args.nodeId,
				expectedYjsSnapshotId: header.yjsSnapshotDoc._id,
				expectedYjsLastSequenceId: header.yjsLastSequenceDoc._id,
				sequence: header.throughSequence,
				targetSequence: args.targetSequence,
				byteSize: header.yjsSnapshotAsset.size,
			});
			return Result({
				_nay: {
					name: "nay",
					message: `Yjs state exceeds ${files_MAX_YJS_RECONSTRUCTED_STATE_BYTES}-byte limit`,
				},
			});
		}

		if (!header.yjsSnapshotAsset.r2Key) {
			const errorMessage = "materialization yjsSnapshotAsset r2Key is not set";
			const errorData = {
				nodeId: args.nodeId,
				yjsSnapshotAssetId: header.yjsSnapshotAsset._id,
			};
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}

		const baseSnapshotUpdate = await r2_fetch_object_from_bucket({ key: header.yjsSnapshotAsset.r2Key }).then(
			(response) => response.arrayBuffer(),
		);

		// Apply the covered update docs one at a time, bounded by the frozen `throughSequence`,
		// and re-check the caps after every applied update so a poisoned log settles instead of
		// growing without bound.
		const yjsDoc = files_yjs_doc_create_from_array_buffer_update(baseSnapshotUpdate);
		let appliedSequence = header.yjsSnapshotDoc.sequence;
		let aggregateUpdateCount = 0;
		let aggregateUpdateBytes = 0;
		while (appliedSequence < header.throughSequence) {
			const next = (await ctx.runQuery(internal.files_nodes.get_file_next_yjs_update, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				nodeId: args.nodeId,
				afterSequence: appliedSequence,
				throughSequence: header.throughSequence,
			})) as get_file_next_yjs_update_Result;

			// Rows already compacted behind a newer snapshot mean this run is stale; the newer
			// job owns the file. Do not finalize a partial reconstruction.
			if (next.kind === "done") {
				return Result({ _yay: null });
			}
			// A gap or duplicate is a broken log; reconstruction from it would commit wrong
			// content. No marker: no supported flow produces it. Do not throw — this pool
			// retries forever and a throw would block every other file.
			if (next.kind === "gap") {
				const errorMessage = "files_yjs_updates log has a sequence gap";
				console.error(errorMessage, {
					nodeId: args.nodeId,
					expectedSequence: next.expectedSequence,
					foundSequence: next.foundSequence,
				});
				return Result({ _nay: { name: "nay", message: errorMessage } });
			}

			files_yjs_doc_apply_array_buffer_update(yjsDoc, next.row.update);
			appliedSequence = next.row.sequence;
			aggregateUpdateCount += 1;
			aggregateUpdateBytes += next.row.update.byteLength;

			// The writers enforce this budget at reserve time; this is the backstop for docs
			// written before the budget existed. Over budget is not a durable content property,
			// so no marker: the next push re-enqueues and the operator can repair if it repeats.
			if (
				aggregateUpdateCount > files_MAX_UNMATERIALIZED_YJS_UPDATE_COUNT ||
				aggregateUpdateBytes > files_MAX_UNMATERIALIZED_YJS_UPDATE_BYTES
			) {
				const errorMessage = "Unmaterialized update log exceeds the aggregate budget";
				console.error(errorMessage, {
					nodeId: args.nodeId,
					aggregateUpdateCount,
					aggregateUpdateBytes,
				});
				return Result({ _nay: { name: "nay", message: errorMessage } });
			}

			// The incremental reconstructed-state cap: tombstones can make a legal full state much
			// larger than any wire value, and a state past 4 MiB needs the operator repair.
			const reconstructedStateBytes = encodeStateAsUpdate(yjsDoc).byteLength;
			if (reconstructedStateBytes > files_MAX_YJS_RECONSTRUCTED_STATE_BYTES) {
				await ctx.runMutation(internal.files_nodes_content.mark_file_content_yjs_state_too_large, {
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					nodeId: args.nodeId,
					expectedYjsSnapshotId: header.yjsSnapshotDoc._id,
					expectedYjsLastSequenceId: header.yjsLastSequenceDoc._id,
					sequence: header.throughSequence,
					targetSequence: args.targetSequence,
					byteSize: reconstructedStateBytes,
				});
				return Result({
					_nay: {
						name: "nay",
						message: `Yjs state exceeds ${files_MAX_YJS_RECONSTRUCTED_STATE_BYTES}-byte limit`,
					},
				});
			}
		}

		const sequence = appliedSequence;
		const snapshotUpdate = files_u8_to_array_buffer(encodeStateAsUpdate(yjsDoc));

		// Read text under the node's stored shape. A refusal is durable because retrying cannot
		// change what the document holds. Settle the shape marker and complete the workpool item.
		const rootKind = header.fileNode.yjsRootKind;
		const extractedText = files_yjs_doc_get_text({ yjsDoc, rootKind });
		if (extractedText._nay) {
			console.warn("Materialization could not read text from the Yjs document", {
				nodeId: args.nodeId,
				rootKind,
				sequence,
				message: extractedText._nay.message,
				cause: extractedText._nay.cause,
			});
			await ctx.runMutation(internal.files_nodes_content.mark_file_content_shape_mismatch, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				nodeId: args.nodeId,
				expectedYjsSnapshotId: header.yjsSnapshotDoc._id,
				expectedYjsLastSequenceId: header.yjsLastSequenceDoc._id,
				sequence,
				targetSequence: args.targetSequence,
			});
			return Result({ _nay: { name: "nay", message: extractedText._nay.message } });
		}

		// The Yjs path is the one write path the cap cannot cover earlier. `yjs_push_update` only
		// ever sees a delta, so this is the first point where the whole text exists. Check
		// before `insert_asset` and the R2 writes below, so an over-cap run leaves no orphan asset.
		//
		// Do not throw for over-cap content. This action runs in a workpool with `maxParallelism: 1`
		// and infinite retries, so a throw would retry forever and block materialization for every
		// other file.
		const markdownByteSize = files_get_utf8_byte_size(extractedText._yay);
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
				expectedYjsSnapshotId: header.yjsSnapshotDoc._id,
				expectedYjsLastSequenceId: header.yjsLastSequenceDoc._id,
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

		// Frontmatter preflight, after reconstruction and before any asset insert or R2 upload:
		// over-cap frontmatter is a durable content property, so settle the marker and complete
		// the workpool item instead of letting the insert helper's late throw retry forever.
		// Only rich text has frontmatter; a `.yaml` starting with `---` is plain text.
		if (rootKind === "rich_text") {
			const frontmatter = files_metadata_preflight_frontmatter(extractedText._yay);
			// Unreadable frontmatter is not a reason to refuse the user's own content. Materialize
			// normally with no frontmatter index; the insert helper skips it for the same reason.
			// No marker is set, because the markers describe over-cap frontmatter and the file
			// would show a count it does not have.
			if (frontmatter._nay) {
				console.warn("Materializing without frontmatter metadata: the frontmatter could not be parsed", {
					nodeId: args.nodeId,
					sequence,
					error: frontmatter._nay,
				});
			} else if (files_metadata_frontmatter_exceeds_index_caps(frontmatter._yay)) {
				const errorMessage = "Frontmatter exceeds the index caps";
				console.warn(errorMessage, {
					nodeId: args.nodeId,
					sequence,
					fieldCount: frontmatter._yay.fieldCount,
					indexDocumentCount: frontmatter._yay.indexDocumentCount,
				});
				await ctx.runMutation(internal.files_nodes_content.mark_file_content_frontmatter_too_large, {
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					nodeId: args.nodeId,
					expectedYjsSnapshotId: header.yjsSnapshotDoc._id,
					expectedYjsLastSequenceId: header.yjsLastSequenceDoc._id,
					sequence,
					targetSequence: args.targetSequence,
					fieldCount: frontmatter._yay.fieldCount,
					indexDocumentCount: frontmatter._yay.indexDocumentCount,
				});
				return Result({ _nay: { name: "nay", message: errorMessage } });
			}
		}

		const versionSnapshotAssetId = (await ctx.runMutation(internal.r2.insert_asset, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			kind: "content_snapshot",
			size: markdownByteSize,
			createdBy: args.userId,
		})) as Id<"files_r2_assets">;

		const versionSnapshotR2Key = r2_create_asset_key({
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			assetId: versionSnapshotAssetId,
		});

		// The current text lives in the committed chunk tables, not in R2. So we only upload
		// the Yjs snapshot and the new version snapshot here. The version snapshot's stored type
		// comes from the classifier over the node NAME — never from the client-declared
		// `contentType` — because the snapshot signer serves whatever type the object carries.
		await Promise.all([
			r2_put_object(ctx, {
				key: header.yjsSnapshotAsset.r2Key,
				body: snapshotUpdate,
				contentType: "application/octet-stream" satisfies files_ContentType,
			}),
			r2_put_object(ctx, {
				key: versionSnapshotR2Key,
				body: extractedText._yay,
				contentType:
					files_get_editable_text_content_type(header.fileNode.name) ??
					("application/octet-stream" satisfies files_ContentType),
			}),
		]);

		const finalizationResult = (await ctx.runMutation(
			internal.files_nodes_content.finalize_file_content_materialization,
			{
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				nodeId: args.nodeId,
				userId: args.userId,
				expectedYjsSnapshotId: header.yjsSnapshotDoc._id,
				expectedYjsLastSequenceId: header.yjsLastSequenceDoc._id,
				sequence,
				targetSequence: args.targetSequence,
				text: extractedText._yay,
				versionSnapshotAssetId,
				textSize: markdownByteSize,
				yjsSnapshotSize: snapshotUpdate.byteLength,
			},
		)) as finalize_file_content_materialization_Result;
		if (finalizationResult._nay) {
			return finalizationResult;
		}

		return Result({ _yay: null });
	},
});

/**
 * Read everything the replace door needs to refuse early, before it writes an asset doc or uploads
 * anything. The final mutation checks all of it again, because this query and that mutation are two
 * separate transactions.
 */
export const get_replace_file_content_preflight = internalQuery({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		nodeId: v.id("files_nodes"),
	},
	returns: v.union(
		v.object({
			rootKind: v.union(v.literal("rich_text"), v.literal("plain_text")),
			name: v.string(),
			assetId: v.id("files_r2_assets"),
			readOnlyScopeNodeId: v.union(v.id("files_nodes"), v.null()),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const membership = await db_get_active_membership_in_workspace(ctx, args);
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

		const fileNode = await ctx.db.get("files_nodes", args.nodeId);
		if (
			!fileNode ||
			fileNode.organizationId !== args.organizationId ||
			fileNode.workspaceId !== args.workspaceId ||
			fileNode.nonCollaborative !== true ||
			!files_node_has_editable_text_content(fileNode)
		) {
			return null;
		}

		return {
			rootKind: fileNode.yjsRootKind,
			name: fileNode.name,
			assetId: fileNode.assetId,
			readOnlyScopeNodeId: fileNode.readOnlyScopeNodeId ?? null,
		};
	},
});

type get_replace_file_content_preflight_Result =
	typeof get_replace_file_content_preflight extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * `v_result` infers `_nay.message` as the exact literal union its validator saw, so an action that
 * can refuse with more messages than its final mutation cannot be annotated with that mutation's
 * result type. The public content doors all answer `null` on success and a free-form refusal
 * message, so they share this hand-written shape instead.
 */
type files_content_public_action_Result =
	| { _yay: null; _nay?: undefined }
	| {
			_nay: { name?: string; message: string };
			_yay?: undefined;
	  };

/**
 * The replace door answers with the file's new content asset instead of `null`.
 *
 * An editor that stays open saves again from the same buffer, and the next save must name the
 * asset this one wrote. Waiting for the reactive node doc to arrive would refuse a quick second
 * save as stale.
 */
type files_replace_file_content_Result =
	| { _yay: { assetId: Id<"files_r2_assets"> }; _nay?: undefined }
	| {
			_nay: { name?: string; message: string };
			_yay?: undefined;
	  };

/**
 * Save the whole text of a non-collaborative file.
 *
 * This is an action and not a mutation because the save writes a version-history entry, and a
 * version entry needs its bytes in R2 first. A Convex mutation cannot reach R2, so the action
 * uploads and the mutation below publishes, the same split the materializer uses.
 *
 * A non-collaborative file has no Yjs document to merge with, so each save replaces the whole
 * text. The exact base-asset check refuses a save that would overwrite a newer one it never saw.
 *
 * The two doors below both run this body. They differ only in how they learn the tenant and the
 * user: the person's door resolves the membership it was handed, the agent's door is already
 * carrying the ids the chat route accepted.
 */
async function action_replace_file_content(
	ctx: ActionCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
		nodeId: Id<"files_nodes">;
		text: string;
		baseAssetId: Id<"files_r2_assets">;
	},
): Promise<files_replace_file_content_Result> {
	const preflight = (await ctx.runQuery(internal.files_nodes_content.get_replace_file_content_preflight, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		userId: args.userId,
		nodeId: args.nodeId,
	})) as get_replace_file_content_preflight_Result;
	if (!preflight) {
		return Result({ _nay: { message: "Not found" } });
	}
	const writable = files_node_require_writable({
		readOnlyScopeNodeId: preflight.readOnlyScopeNodeId ?? undefined,
	});
	if (writable._nay) {
		return writable;
	}
	if (preflight.assetId !== args.baseAssetId) {
		return Result({
			_nay: { message: "This file changed while you were saving. Copy your local changes before reloading, then try again." },
		});
	}
	const creditCheck = await ctx.runQuery(internal.billing.check_credits, {
		userId: args.userId,
		organizationId: args.organizationId,
		minimumRequiredCents: 1,
	});
	if (!creditCheck.hasCredits) {
		return Result({ _nay: { message: "Insufficient funds" } });
	}

	// Normalize once before every byte count and representation write. Monaco strips a leading BOM
	// while loading, so storing one would make an untouched file look dirty in the editor.
	const text = files_normalize_text_document_input(args.text);

	// Refuse over-cap text here, while the whole text is in hand and nothing has been written.
	// The Yjs door cannot do this — it only ever sees a delta, so its cap check lives in the
	// materializer and leaves a durable marker behind. This door has no such excuse, and a
	// marker would describe unmaterialized state that does not exist here.
	const textByteSize = files_get_utf8_byte_size(text);
	if (textByteSize > files_MAX_TEXT_CONTENT_BYTES) {
		return Result({
			_nay: { message: `Text content exceeds ${files_MAX_TEXT_CONTENT_BYTES}-byte limit` },
		});
	}

	// Same reasoning for frontmatter. Without this check the insert helper reaches its own
	// backstop and throws, which would roll the whole save back with an unhelpful message.
	// Only rich text has frontmatter; a `.yaml` opening with `---` is plain text. The refusal and
	// its words match `files_pending_update_check_frontmatter_caps`, the other door where somebody
	// hands over a whole text and can shorten it after reading the message.
	if (preflight.rootKind === "rich_text") {
		const frontmatter = files_metadata_preflight_frontmatter(text);
		// Unreadable frontmatter is not a reason to refuse the user's own content. Save it and
		// skip the index, the same way the materializer does.
		if (frontmatter._yay && files_metadata_frontmatter_exceeds_index_caps(frontmatter._yay)) {
			return Result({ _nay: { message: "Too many frontmatter fields" } });
		}
	}

	const versionSnapshotAssetId = (await ctx.runMutation(internal.r2.insert_asset, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		kind: "content_snapshot",
		size: textByteSize,
		createdBy: args.userId,
	})) as Id<"files_r2_assets">;

	const versionSnapshotR2Key = r2_create_asset_key({
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		assetId: versionSnapshotAssetId,
	});

	// The stored type comes from the classifier over the node NAME, never from a client-declared
	// type, because the snapshot signer serves whatever type the object carries.
	await r2_put_object(ctx, {
		key: versionSnapshotR2Key,
		body: text,
		contentType:
			files_get_editable_text_content_type(preflight.name) ??
			("application/octet-stream" satisfies files_ContentType),
	});

	const finalized = (await ctx.runMutation(internal.files_nodes_content.finalize_file_content_replacement, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		userId: args.userId,
		nodeId: args.nodeId,
		text,
		textSize: textByteSize,
		baseAssetId: args.baseAssetId,
		versionSnapshotAssetId,
	})) as finalize_file_content_replacement_Result;
	if (finalized._nay) {
		// The upload above is now unreferenced. Hand its key to the deletion ledger in one
		// mutation so a crash right here cannot leave the object in the bucket forever.
		await ctx.runMutation(internal.files_nodes_content.cleanup_file_node_creation_assets, {
			assetIds: [versionSnapshotAssetId],
			r2Keys: [versionSnapshotR2Key],
			durableTenantScope: {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
			},
		});
		return finalized;
	}

	// The version snapshot the node now points at is the base of this caller's next save.
	return Result({ _yay: { assetId: versionSnapshotAssetId } });
}

/**
 * Read the whole committed text of a file with collaboration turned off, plus the asset that text
 * came from.
 *
 * A collaborative file is loaded from its Yjs document instead, so this door refuses one. The
 * editor saves with `replace_file_content`, and that door refuses a base asset that is no longer
 * the file's current one. Reading the text and the asset in the same query is what keeps the pair
 * consistent: two separate reads could straddle somebody else's save.
 */
export const get_non_collaborative_file_content = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
	},
	returns: v_result({
		_yay: v.object({
			text: v.string(),
			assetId: v.id("files_r2_assets"),
			yjsRootKind: v.union(v.literal("rich_text"), v.literal("plain_text")),
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

		const authorized = await access_control_db_authorize_node(ctx, {
			userAuth,
			membership,
			nodeId: args.nodeId,
			permission: "content.read",
		});
		if (authorized._nay) {
			return authorized;
		}

		const fileNode = await ctx.db.get("files_nodes", args.nodeId);
		if (
			!fileNode ||
			fileNode.organizationId !== membership.organizationId ||
			fileNode.workspaceId !== membership.workspaceId ||
			fileNode.nonCollaborative !== true ||
			!files_node_has_editable_text_content(fileNode)
		) {
			return Result({ _nay: { message: "Not found" } });
		}

		const asset = await ctx.db.get("files_r2_assets", fileNode.assetId);
		if (!asset || asset.organizationId !== fileNode.organizationId || asset.workspaceId !== fileNode.workspaceId) {
			const errorMessage = "fileNode.assetId points to a missing or mismatched files_r2_assets doc";
			const errorData = { nodeId: fileNode._id, assetId: fileNode.assetId };
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}

		const chunks = await ctx.db
			.query("files_text_chunks")
			.withIndex("by_organization_workspace_source_fileNode_yjsSeq_chunk", (q) =>
				q
					.eq("organizationId", membership.organizationId)
					.eq("workspaceId", membership.workspaceId)
					.eq("sourceKind", "committed")
					.eq("fileNodeId", fileNode._id),
			)
			.collect();
		// An empty file stores no chunk at all, so an empty result is only real when the asset says
		// the file has no bytes. Otherwise the chunks are missing and the editor must not open on a
		// stand-in document: every later save would replace the real text with what it shows.
		const text = chunks.length > 0 ? files_merge_contiguous_chunks(chunks) : asset.size === 0 ? "" : null;
		if (text == null) {
			return Result({ _nay: { message: "Not found" } });
		}

		return Result({ _yay: { text, assetId: fileNode.assetId, yjsRootKind: fileNode.yjsRootKind } });
	},
});

export const replace_file_content = action({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
		text: v.string(),
		/** The `node.assetId` the caller's editor loaded. A newer save makes this one stale. */
		baseAssetId: v.id("files_r2_assets"),
	},
	returns: v_result({ _yay: v.object({ assetId: v.id("files_r2_assets") }) }),
	// The annotation breaks same-file generated-API circularity.
	handler: async (ctx, args): Promise<files_replace_file_content_Result> => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "files_tree_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		// An action cannot read the database, so the membership comes back through a query, the
		// same way `create_text_node` resolves the tenant it was handed.
		const membership = (await ctx.runQuery(api.organizations.get_membership, {
			membershipId: args.membershipId,
		})) as Doc<"organizations_workspaces_users"> | null;
		if (!membership || membership.userId !== userAuth.id) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		return await action_replace_file_content(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: userAuth.id,
			nodeId: args.nodeId,
			text: args.text,
			baseAssetId: args.baseAssetId,
		});
	},
});

/**
 * The agent's door onto the same save.
 *
 * The chat route already accepted this user and tenant, and the file tools carry those ids instead
 * of a membership, so this door takes them directly. It keeps its own rate limit: an agent loop can
 * call it much faster than a person clicking Save.
 */
export const replace_file_content_internal_action = internalAction({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		nodeId: v.id("files_nodes"),
		text: v.string(),
		/** The `node.assetId` the agent's read returned. A newer save makes this one stale. */
		baseAssetId: v.id("files_r2_assets"),
	},
	returns: v_result({ _yay: v.object({ assetId: v.id("files_r2_assets") }) }),
	// The annotation breaks same-file generated-API circularity.
	handler: async (ctx, args): Promise<files_replace_file_content_Result> => {
		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "files_tree_write", key: args.userId });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		return await action_replace_file_content(ctx, args);
	},
});

export const finalize_file_content_replacement = internalMutation({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		nodeId: v.id("files_nodes"),
		text: v.string(),
		textSize: v.number(),
		baseAssetId: v.id("files_r2_assets"),
		versionSnapshotAssetId: v.id("files_r2_assets"),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const user = await ctx.db.get("users", args.userId);
		if (!user) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}
		// Ask again in the transaction that writes. The action checked the same things, but a
		// membership can end or a grant can be taken away while the text was uploading.
		const membership = await db_get_active_membership_in_workspace(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: user._id,
		});
		if (!membership) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const authorized = await access_control_db_authorize_node(ctx, {
			userAuth: { id: user._id },
			membership,
			nodeId: args.nodeId,
			permission: "content.write",
		});
		if (authorized._nay) {
			return authorized;
		}

		const fileNode = await ctx.db.get("files_nodes", args.nodeId);
		if (
			!fileNode ||
			fileNode.organizationId !== args.organizationId ||
			fileNode.workspaceId !== args.workspaceId ||
			fileNode.nonCollaborative !== true ||
			!files_node_has_editable_text_content(fileNode)
		) {
			return Result({ _nay: { message: "Not found" } });
		}

		// Check the lock after access and before the first write, like every other write door.
		const writable = files_node_require_writable(fileNode);
		if (writable._nay) {
			return writable;
		}

		// Another save landed while this one was uploading. Refuse instead of overwriting text the
		// caller never saw, and let them reload and try again.
		if (fileNode.assetId !== args.baseAssetId) {
			return Result({
				_nay: { message: "This file changed while you were saving. Copy your local changes before reloading, then try again." },
			});
		}

		const organization = await ctx.db.get("organizations", membership.organizationId);
		if (!organization) {
			const errorMessage = "membership.organizationId points to a missing organizations doc";
			const errorData = {
				membershipId: membership._id,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				nodeId: args.nodeId,
			};
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}
		const billedUserId = billing_pick_billed_user_id({ userId: user._id, organization });
		const billedUser = await ctx.db.get("users", billedUserId);
		if (!billedUser) {
			const errorMessage = "billedUserId points to a missing users doc";
			const errorData = { userId: user._id, organizationId: organization._id, billedUserId };
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}

		// A save costs the same here as through the Yjs door. Without this charge, turning
		// collaboration off would be the free way to run a metered operation.
		const check = await billing_db_check_credits(ctx, { userId: billedUser._id, minimumRequiredCents: 1 });
		if (!check.hasCredits) {
			return Result({ _nay: { message: "Insufficient funds" } });
		}

		const now = Date.now();
		const dbWriteResult = Result_all(
			await Promise.all([
				// Point the node at the new version snapshot. It now holds the file's current bytes,
				// so downloads sign it and reads use its size as the byte cap.
				ctx.db.patch("files_nodes", args.nodeId, {
					assetId: args.versionSnapshotAssetId,
					contentFrontmatterTooLargeFieldCount: undefined,
					contentFrontmatterTooLargeIndexDocumentCount: undefined,
					updatedBy: user._id,
					updatedAt: now,
				}),
				ctx.db.patch("files_r2_assets", args.versionSnapshotAssetId, {
					r2Key: r2_create_asset_key({
						organizationId: membership.organizationId,
						workspaceId: membership.workspaceId,
						assetId: args.versionSnapshotAssetId,
					}),
					size: args.textSize,
					unfinalizedExpiresAt: undefined,
					updatedAt: now,
				}),
				db_replace_file_chunks(ctx, {
					organizationId: membership.organizationId,
					workspaceId: membership.workspaceId,
					nodeId: args.nodeId,
					textContent: args.text,
				}),
				store_version_snapshot(ctx, {
					organizationId: membership.organizationId,
					workspaceId: membership.workspaceId,
					nodeId: args.nodeId,
					assetId: args.versionSnapshotAssetId,
					userId: user._id,
				}),
			]),
		);

		if (dbWriteResult._nay) {
			const errorMessage = "Failed to replace file content";
			console.error(errorMessage, { dbWriteResult, nodeId: args.nodeId });
			// Throw so Convex rolls back every write above. Returning `_nay` would commit the node
			// and asset changes after chunk replacement had already failed.
			throw convex_error({ message: errorMessage, cause: dbWriteResult._nay });
		}

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
							args.versionSnapshotAssetId,
						),
						metadata: {
							amount: 1,
							actorUserId: user._id,
							billedUserId: billedUser._id,
							organizationId: fileNode.organizationId,
							workspaceId: fileNode.workspaceId,
							nodeId: args.nodeId,
							version: args.versionSnapshotAssetId,
						},
					}),
				},
			],
		});

		return Result({ _yay: null });
	},
});

type finalize_file_content_replacement_Result =
	typeof finalize_file_content_replacement extends RegisteredMutation<
		infer _Visibility,
		infer _Args,
		infer ReturnValue
	>
		? Awaited<ReturnValue>
		: never;

export const restore_snapshot = internalMutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
		snapshotId: v.id("files_snapshots"),
		sessionId: v.string(),
		snapshotMarkdownContent: v.string(),
		/**
		 * The staged server-built restore update (kind `snapshot_restore`), so this commit call
		 * carries only one large value (`snapshotMarkdownContent`). Consumed here.
		 */
		restoreUpdateStageId: v.optional(v.id("files_yjs_trusted_update_stages")),
		expectedYjsSnapshotId: v.id("files_yjs_snapshots"),
		expectedYjsLastSequenceId: v.id("files_yjs_docs_last_sequences"),
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
		if (
			fileNode.yjsSnapshotId !== args.expectedYjsSnapshotId ||
			fileNode.yjsLastSequenceId !== args.expectedYjsLastSequenceId
		) {
			await db_hand_unpublished_assets_to_deletion_ledger(ctx, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				assetIds: [args.currentSnapshotAssetId, args.restoredSnapshotAssetId],
				reason: "failed_create",
			});
			return Result({ _nay: { message: "This file changed while the snapshot was being restored. Try again." } });
		}

		// Check read-only after access and before every write.
		// If the file is read-only, add deletion jobs for both uploaded snapshots and delete their asset docs.
		// The staged restore update expires through its normal cleanup.
		const writable = files_node_require_writable(fileNode);
		if (writable._nay) {
			await db_hand_unpublished_assets_to_deletion_ledger(ctx, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				assetIds: [args.currentSnapshotAssetId, args.restoredSnapshotAssetId],
				reason: "read_only_snapshot_restore",
			});
			return writable;
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

		// Consume the staged restore update. The delete commits even when a later step throws is
		// not a concern here (a throw rolls the whole transaction back), and a refused consume
		// happens before any other write.
		let restoreUpdate: ArrayBuffer | null = null;
		if (args.restoreUpdateStageId) {
			const consumed = await files_db_consume_trusted_yjs_update_stage(ctx, {
				stageId: args.restoreUpdateStageId,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: userAuth.id,
				nodeId: args.nodeId,
				kind: "snapshot_restore",
			});
			if (consumed._nay) {
				return Result({ _nay: { message: consumed._nay.message } });
			}
			restoreUpdate = consumed._yay;
		}

		const now = Date.now();
		const userId = userAuth.id;

		// Restoring snapshots can be destructive and we defensively store
		// the current state as a backup snapshot
		// so the user can revert to it if needed.
		const [, , , , , restoredYjsSequenceResult] = await Promise.all([
			ctx.db.patch("files_r2_assets", args.currentSnapshotAssetId, {
				r2Key: r2_create_asset_key({
					organizationId: membership.organizationId,
					workspaceId: membership.workspaceId,
					assetId: args.currentSnapshotAssetId,
				}),
				size: args.currentSnapshotSize,
				unfinalizedExpiresAt: undefined,
				updatedAt: now,
			}),
			ctx.db.patch("files_r2_assets", args.restoredSnapshotAssetId, {
				r2Key: r2_create_asset_key({
					organizationId: membership.organizationId,
					workspaceId: membership.workspaceId,
					assetId: args.restoredSnapshotAssetId,
				}),
				size: args.restoredSnapshotSize,
				unfinalizedExpiresAt: undefined,
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

			restoreUpdate
				? db_insert_snapshot_restore_update(ctx, {
						organizationId: membership.organizationId,
						workspaceId: membership.workspaceId,
						userId,
						nodeId: args.nodeId,
						snapshotId: args.snapshotId,
						restoreUpdate,
						expectedYjsLastSequenceId: args.expectedYjsLastSequenceId,
					})
				: Promise.resolve(null),
		]);

		// Throw, do not return `_nay`: the asset patches above already pointed the node at the
		// restored snapshot in this same mutation, so a returned refusal would commit that
		// half-restored state without its Yjs update. The reserve refusal messages are stable and
		// user-facing, so the thrown message is the one the user should see.
		let restoredYjsSequence: number | null = null;
		if (restoredYjsSequenceResult) {
			if (restoredYjsSequenceResult._nay) {
				throw convex_error({ message: restoredYjsSequenceResult._nay.message });
			}
			restoredYjsSequence = restoredYjsSequenceResult._yay;
		}

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
					textContent: args.snapshotMarkdownContent,
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
								version: String(restoredYjsSequence),
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
	// The annotation breaks same-file generated-API circularity. It also carries the staging
	// mutation's refusal branch because the action forwards that `_nay` unchanged.
	handler: async (
		ctx,
		args,
	): Promise<
		restore_snapshot_Result | Extract<files_pending_updates_stage_trusted_yjs_update_Result, { _nay: object }>
	> => {
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

		// Check the current lock before staging or writing assets and R2 files.
		// The final mutation checks it again.
		const nodeWritable = files_node_require_writable(materializationState.fileNode);
		if (nodeWritable._nay) {
			return nodeWritable;
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
		// Shape-aware setter: the shape comes from the node, and the setter's first-statement
		// guard refuses a document whose text is not addressable under that shape.
		const restoredYjsDocProjection = files_yjs_doc_update_from_text({
			mut_yjsDoc: currentContent._yay.yjsDoc,
			text: snapshotMarkdownContent,
			rootKind: materializationState.fileNode.yjsRootKind,
		});
		if (restoredYjsDocProjection._nay) {
			const errorMessage = "Failed to apply the restored snapshot text to the file's Yjs doc";
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

		// Stage the one server-built restore update so the commit mutation carries only ids plus
		// the one bounded snapshot text. The stage is consumed on commit; an abandoned stage is
		// TTL-swept.
		let restoreUpdateStageId: Id<"files_yjs_trusted_update_stages"> | undefined;
		if (restoreUpdate) {
			const restoreUpdateBuffer = files_u8_to_array_buffer(restoreUpdate);
			const staged = (await ctx.runMutation(internal.files_pending_updates.stage_trusted_yjs_update, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: userAuth.id,
				nodeId: args.nodeId,
				kind: "snapshot_restore",
				update: restoreUpdateBuffer,
			})) as files_pending_updates_stage_trusted_yjs_update_Result;
			if (staged._nay) {
				// Return the staging refusal unchanged; the handler annotation carries this branch.
				return staged;
			}
			restoreUpdateStageId = staged._yay.stageId;
		}

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
			restoreUpdateStageId,
			expectedYjsSnapshotId: materializationState.yjsSnapshotDoc._id,
			expectedYjsLastSequenceId: materializationState.yjsLastSequenceDoc._id,
			currentSnapshotAssetId,
			currentSnapshotSize: files_get_utf8_byte_size(currentContent._yay.markdown),
			restoredSnapshotAssetId,
			restoredSnapshotSize: files_get_utf8_byte_size(snapshotMarkdownContent),
			skipRateLimit: true,
		})) as restore_snapshot_Result;
	},
});

// #endregion snapshots

// #region yjs repair
// Operator recovery for a file whose materialization refused durably (shape mismatch, a Yjs
// state past the 4 MiB cap, or over-cap frontmatter whose update budget tripped). Replaces the
// whole Yjs history with one fresh compact document
// built from the file's visible text, and every committed representation with it, atomically.
// Runbook: export the Yjs snapshot/update assets first; run through the convex-admin-ops skill;
// editors for the node must close/reload before writes resume.

export const get_data_for_yjs_repair = internalQuery({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		nodeId: v.id("files_nodes"),
		authorUserId: v.id("users"),
	},
	returns: v.union(file_content_materialization_header_validator, v.null()),
	handler: async (ctx, args) => {
		// The author must be a real member of the node's tenant: the repair records them as the
		// author of the new version, and an id outside the tenant would forge history.
		const membership = await db_get_active_membership_in_workspace(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.authorUserId,
		});
		if (!membership) {
			return null;
		}

		const state = await db_get_file_content_materialization_db_state(ctx, args);
		if (!state) {
			return null;
		}

		return {
			fileNode: state.fileNode,
			yjsSnapshotDoc: state.yjsSnapshotDoc,
			yjsLastSequenceDoc: state.yjsLastSequenceDoc,
			asset: state.asset,
			yjsSnapshotAsset: state.yjsSnapshotAsset,
			// Freeze the repair target at the current last sequence; the final mutation rechecks
			// it so any concurrent write makes the repair stale instead of merging onto it.
			throughSequence: state.yjsLastSequenceDoc.lastSequence,
		};
	},
});

type get_data_for_yjs_repair_Result =
	typeof get_data_for_yjs_repair extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

export const repair_file_yjs_state_from_visible_text = internalAction({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		nodeId: v.id("files_nodes"),
		/** Recorded as the author of the repair's new version; must be a member of the tenant. */
		authorUserId: v.id("users"),
		/**
		 * `latest_state` (default) reconstructs the current document under the repair-only 16 MiB
		 * cap and keeps its visible text. `last_committed` discards unmaterialized updates and
		 * rebuilds from the committed content; it requires the explicit acknowledgement flag and
		 * never happens automatically.
		 */
		source: v.optional(v.union(v.literal("latest_state"), v.literal("last_committed"))),
		acknowledgeDiscardUnmaterialized: v.optional(v.boolean()),
	},
	returns: v_result({
		_yay: v.object({
			sequence: v.number(),
			lineageGeneration: v.number(),
			textByteSize: v.number(),
		}),
	}),
	handler: async (ctx, args) => {
		const source = args.source ?? "latest_state";
		if (source === "last_committed" && args.acknowledgeDiscardUnmaterialized !== true) {
			return Result({
				_nay: { message: "last_committed discards unmaterialized updates and needs the acknowledgement flag" },
			});
		}

		const data = (await ctx.runQuery(internal.files_nodes_content.get_data_for_yjs_repair, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId: args.nodeId,
			authorUserId: args.authorUserId,
		})) as get_data_for_yjs_repair_Result;
		if (!data) {
			return Result({ _nay: { message: "Not found" } });
		}

		const fileNode = data.fileNode;
		const rootKind = fileNode.yjsRootKind;

		// Repair changes user content, so the operator must unlock the file first.
		// Check before writing assets and R2 files, then check again in the final mutation.
		const nodeWritable = files_node_require_writable(fileNode);
		if (nodeWritable._nay) {
			return nodeWritable;
		}
		// The frontmatter markers qualify too: a frontmatter-marked file whose update budget
		// tripped can no longer accept the fitting edit that would clear the marker, and its
		// visible text is under the text cap, so a latest_state repair is lossless. The
		// too-large-text marker stays out on purpose — its visible text is over the cap, so its
		// documented exit is `last_committed` with the acknowledgement flag.
		const hasDurableMarker =
			fileNode.contentShapeMismatchAt !== undefined ||
			fileNode.contentYjsStateTooLargeByteSize !== undefined ||
			fileNode.contentFrontmatterTooLargeFieldCount !== undefined ||
			fileNode.contentFrontmatterTooLargeIndexDocumentCount !== undefined;

		// The default source requires the matching durable marker: without one, normal
		// materialization still owns the file and a repair would race it.
		if (source === "latest_state" && !hasDurableMarker) {
			return Result({ _nay: { message: "File carries no durable repair marker" } });
		}

		let visibleText: string;
		if (source === "latest_state") {
			// Refuse a base over the repair-only cap before any GET.
			if (data.yjsSnapshotAsset.size > files_MAX_YJS_REPAIR_RECONSTRUCTED_STATE_BYTES) {
				return Result({
					_nay: {
						message: `Yjs state exceeds the ${files_MAX_YJS_REPAIR_RECONSTRUCTED_STATE_BYTES}-byte repair limit; export and repair from last_committed`,
					},
				});
			}
			if (!data.yjsSnapshotAsset.r2Key) {
				return Result({ _nay: { message: "Yjs snapshot asset has no stored object" } });
			}

			const baseSnapshotUpdate = await r2_fetch_object_from_bucket({ key: data.yjsSnapshotAsset.r2Key }).then(
				(response) => response.arrayBuffer(),
			);
			const yjsDoc = files_yjs_doc_create_from_array_buffer_update(baseSnapshotUpdate);

			// Reuse the immutable-sequence reader up to the frozen target, under the repair cap.
			let appliedSequence = data.yjsSnapshotDoc.sequence;
			while (appliedSequence < data.throughSequence) {
				const next = (await ctx.runQuery(internal.files_nodes.get_file_next_yjs_update, {
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					nodeId: args.nodeId,
					afterSequence: appliedSequence,
					throughSequence: data.throughSequence,
				})) as get_file_next_yjs_update_Result;
				if (next.kind === "done") {
					break;
				}
				if (next.kind === "gap") {
					return Result({ _nay: { message: "files_yjs_updates log has a sequence gap; repair from last_committed" } });
				}
				files_yjs_doc_apply_array_buffer_update(yjsDoc, next.row.update);
				appliedSequence = next.row.sequence;
				if (encodeStateAsUpdate(yjsDoc).byteLength > files_MAX_YJS_REPAIR_RECONSTRUCTED_STATE_BYTES) {
					return Result({
						_nay: {
							message: `Yjs state exceeds the ${files_MAX_YJS_REPAIR_RECONSTRUCTED_STATE_BYTES}-byte repair limit; export and repair from last_committed`,
						},
					});
				}
			}

			// Try the stored shape's normal text reader first. Repair may run because that reader
			// refuses, so fall back to a plain root's `toString()`; embeds and child types add no
			// text. A rich document with no rich root has empty visible text.
			const extractedText = files_yjs_doc_get_text({ yjsDoc, rootKind });
			if (extractedText._nay) {
				visibleText =
					rootKind === "plain_text" ? files_yjs_doc_get_plain_text({ yjsDoc }) : "";
			} else {
				visibleText = extractedText._yay;
			}
		} else {
			// last_committed: the newest version snapshot asset holds exactly the committed
			// chunk text (finalization writes both in one transaction), so read it back instead
			// of re-merging chunk docs.
			if (!data.asset.r2Key) {
				return Result({ _nay: { message: "Committed content asset has no stored object" } });
			}
			const committedBytes = await r2_fetch_object_from_bucket({ key: data.asset.r2Key }).then((response) =>
				response.arrayBuffer(),
			);
			// Fatal decoder: repairing from silently replaced bytes would launder corruption.
			try {
				visibleText = new TextDecoder("utf-8", { fatal: true }).decode(committedBytes);
			} catch (error) {
				console.error("Committed content asset is not valid UTF-8", { nodeId: args.nodeId, error });
				return Result({ _nay: { message: "Committed content is not valid UTF-8" } });
			}
		}

		// The normal visible cap still applies: repair may not commit text a normal save could not.
		const textByteSize = files_get_utf8_byte_size(visibleText);
		if (textByteSize > files_MAX_TEXT_CONTENT_BYTES) {
			return Result({ _nay: { message: `Visible text exceeds ${files_MAX_TEXT_CONTENT_BYTES}-byte limit` } });
		}

		// Build the fresh expected-root document. This is a new lineage on purpose: pending
		// proposals built against the old history become visibly stale through the generation
		// bump in the final mutation.
		const replacementDoc = files_yjs_doc_create_from_text({ text: visibleText, rootKind });
		if ("_nay" in replacementDoc) {
			return Result({ _nay: { message: replacementDoc._nay.message } });
		}
		const replacementState = encodeStateAsUpdate(replacementDoc);
		if (replacementState.byteLength > files_MAX_YJS_RECONSTRUCTED_STATE_BYTES) {
			return Result({
				_nay: { message: `Compact replacement exceeds ${files_MAX_YJS_RECONSTRUCTED_STATE_BYTES}-byte limit` },
			});
		}

		// Upload both replacements to fresh unfinalized assets and keys. A stale or refused
		// final mutation deletes them below; a crash leaves them to the unfinalized-asset sweeper.
		const [yjsSnapshotAssetId, contentSnapshotAssetId] = (await Promise.all([
			ctx.runMutation(internal.r2.insert_asset, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				kind: "yjs_snapshot",
				size: replacementState.byteLength,
				createdBy: args.authorUserId,
			}),
			ctx.runMutation(internal.r2.insert_asset, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				kind: "content_snapshot",
				size: textByteSize,
				createdBy: args.authorUserId,
			}),
		])) as [Id<"files_r2_assets">, Id<"files_r2_assets">];
		const yjsSnapshotR2Key = r2_create_asset_key({
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			assetId: yjsSnapshotAssetId,
		});
		const contentSnapshotR2Key = r2_create_asset_key({
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			assetId: contentSnapshotAssetId,
		});
		await Promise.all([
			r2_put_object(ctx, {
				key: yjsSnapshotR2Key,
				body: files_u8_to_array_buffer(replacementState),
				contentType: "application/octet-stream" satisfies files_ContentType,
			}),
			r2_put_object(ctx, {
				key: contentSnapshotR2Key,
				body: visibleText,
				contentType: "text/markdown;charset=utf-8" satisfies files_ContentType,
			}),
		]);

		const finalized = (await ctx.runMutation(internal.files_nodes_content.finalize_file_yjs_repair, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId: args.nodeId,
			authorUserId: args.authorUserId,
			source,
			acknowledgeDiscardUnmaterialized: args.acknowledgeDiscardUnmaterialized ?? false,
			targetSequence: data.throughSequence,
			expectedYjsSnapshotId: data.yjsSnapshotDoc._id,
			expectedYjsLastSequenceId: data.yjsLastSequenceDoc._id,
			expectedLineageGeneration: data.yjsLastSequenceDoc.lineageGeneration,
			text: visibleText,
			textByteSize,
			yjsSnapshotAssetId,
			yjsSnapshotSize: replacementState.byteLength,
			contentSnapshotAssetId,
			supersededYjsAssetId: data.yjsSnapshotAsset._id,
		})) as finalize_file_yjs_repair_Result;

		if (finalized._nay) {
			// A read-only refusal already added deletion jobs and deleted both asset docs.
			// Other refusals delete both new uploads here. A crash leaves them for normal cleanup.
			if (finalized._nay.name !== "read_only") {
				await ctx.runMutation(internal.files_nodes_content.delete_unfinalized_repair_assets, {
					assetIds: [yjsSnapshotAssetId, contentSnapshotAssetId],
				});
			}
			return finalized;
		}

		return Result({
			_yay: {
				sequence: data.throughSequence,
				lineageGeneration: finalized._yay.lineageGeneration,
				textByteSize,
			},
		});
	},
});

export const finalize_file_yjs_repair = internalMutation({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		nodeId: v.id("files_nodes"),
		authorUserId: v.id("users"),
		source: v.union(v.literal("latest_state"), v.literal("last_committed")),
		acknowledgeDiscardUnmaterialized: v.boolean(),
		targetSequence: v.number(),
		expectedYjsSnapshotId: v.id("files_yjs_snapshots"),
		expectedYjsLastSequenceId: v.id("files_yjs_docs_last_sequences"),
		expectedLineageGeneration: v.number(),
		/** One bounded text value; every other input travels as ids/scalars. */
		text: v.string(),
		textByteSize: v.number(),
		yjsSnapshotAssetId: v.id("files_r2_assets"),
		yjsSnapshotSize: v.number(),
		contentSnapshotAssetId: v.id("files_r2_assets"),
		supersededYjsAssetId: v.id("files_r2_assets"),
	},
	returns: v_result({ _yay: v.object({ lineageGeneration: v.number() }) }),
	handler: async (ctx, args) => {
		// Recheck everything the action decided on: tenant, membership, node, marker or
		// acknowledgement, exact target sequence, lineage generation, asset ownership and sizes.
		// Any mismatch means the world moved between the action's read and this commit.
		const membership = await db_get_active_membership_in_workspace(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.authorUserId,
		});
		if (!membership) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		if (args.textByteSize !== files_get_utf8_byte_size(args.text)) {
			return Result({ _nay: { message: "Text size does not match" } });
		}

		const state = await db_get_file_content_materialization_db_state(ctx, args);
		if (!state) {
			return Result({ _nay: { message: "Not found" } });
		}

		// Repair changes user content, so refuse a read-only file before the first write.
		// The repair files are already in R2. Add deletion jobs and delete the asset docs
		// in this transaction, so a later crash cannot lose cleanup.
		const writable = files_node_require_writable(state.fileNode);
		if (writable._nay) {
			await db_hand_unpublished_assets_to_deletion_ledger(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				assetIds: [args.yjsSnapshotAssetId, args.contentSnapshotAssetId],
				reason: "read_only_yjs_repair",
			});
			return writable;
		}

		if (state.yjsLastSequenceDoc.lastSequence !== args.targetSequence) {
			return Result({ _nay: { message: "Stale repair: the file advanced" } });
		}
		if (
			state.fileNode.yjsSnapshotId !== args.expectedYjsSnapshotId ||
			state.fileNode.yjsLastSequenceId !== args.expectedYjsLastSequenceId ||
			state.yjsSnapshotDoc._id !== args.expectedYjsSnapshotId ||
			state.yjsLastSequenceDoc._id !== args.expectedYjsLastSequenceId ||
			state.yjsLastSequenceDoc.lineageGeneration !== args.expectedLineageGeneration
		) {
			return Result({ _nay: { message: "Stale repair: the lineage advanced" } });
		}
		// Same eligibility as the action: the frontmatter markers qualify for latest_state.
		const hasDurableMarker =
			state.fileNode.contentShapeMismatchAt !== undefined ||
			state.fileNode.contentYjsStateTooLargeByteSize !== undefined ||
			state.fileNode.contentFrontmatterTooLargeFieldCount !== undefined ||
			state.fileNode.contentFrontmatterTooLargeIndexDocumentCount !== undefined;
		if (args.source === "latest_state" && !hasDurableMarker) {
			return Result({ _nay: { message: "File carries no durable repair marker" } });
		}
		if (args.source === "last_committed" && !args.acknowledgeDiscardUnmaterialized) {
			return Result({ _nay: { message: "last_committed needs the acknowledgement flag" } });
		}

		const [yjsSnapshotAsset, contentSnapshotAsset] = await Promise.all([
			ctx.db.get("files_r2_assets", args.yjsSnapshotAssetId),
			ctx.db.get("files_r2_assets", args.contentSnapshotAssetId),
		]);
		if (
			!yjsSnapshotAsset ||
			yjsSnapshotAsset.organizationId !== args.organizationId ||
			yjsSnapshotAsset.workspaceId !== args.workspaceId ||
			yjsSnapshotAsset.kind !== "yjs_snapshot" ||
			yjsSnapshotAsset.size !== args.yjsSnapshotSize ||
			!contentSnapshotAsset ||
			contentSnapshotAsset.organizationId !== args.organizationId ||
			contentSnapshotAsset.workspaceId !== args.workspaceId ||
			contentSnapshotAsset.kind !== "content_snapshot" ||
			contentSnapshotAsset.size !== args.textByteSize
		) {
			return Result({ _nay: { message: "Repair assets do not match" } });
		}

		const now = Date.now();
		const nextLineageGeneration = args.expectedLineageGeneration + 1;
		// Rotate the exact token even though the numeric sequence stays the same. Every writer and
		// worker that started before this repair then fails its existing exact-id check.
		const nextYjsLastSequenceId = await ctx.db.insert("files_yjs_docs_last_sequences", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			fileNodeId: args.nodeId,
			lastSequence: args.targetSequence,
			unmaterializedUpdateCount: 0,
			unmaterializedUpdateBytes: 0,
			lineageGeneration: nextLineageGeneration,
		});

		// Mirror the materializer's frontmatter preflight. A frontmatter-marked file usually
		// still carries over-cap frontmatter at repair time, and letting the metadata insert
		// helper's backstop throw would roll the whole repair back and leave the file
		// deadlocked. When the frontmatter is over the caps, commit the chunks without the
		// metadata index and keep the marker pair set with the fresh counts; the user's next
		// fitting edit clears them through normal materialization.
		const repairRootKind = state.fileNode.yjsRootKind;
		const frontmatter = repairRootKind === "rich_text" ? files_metadata_preflight_frontmatter(args.text) : null;
		// Unreadable frontmatter is not over-cap, so leave the markers alone. The repair commits
		// the chunks with no frontmatter index, which is what the insert helper does too.
		if (frontmatter?._nay) {
			console.warn("Repairing without frontmatter metadata: the frontmatter could not be parsed", {
				nodeId: state.fileNode._id,
				error: frontmatter._nay,
			});
		}

		// Keep the counts only while they are over the caps, so the marker writes below read them
		// straight from here and a fitting file cannot leave a stale count behind.
		const frontmatterOverCapCounts =
			frontmatter?._yay != null && files_metadata_frontmatter_exceeds_index_caps(frontmatter._yay)
				? frontmatter._yay
				: null;

		// There is nothing to index when the frontmatter is over the caps or could not be read.
		const skipFrontmatterIndex = frontmatterOverCapCounts !== null || frontmatter?._nay != null;

		// Reuse the finalization shape: swap the Yjs pointer, finalize both assets, replace the
		// committed chunks, record the new version, clear the markers, reset the counters and
		// bump the lineage. Covered update docs and job docs stay out of this transaction — the
		// scheduled continuation below deletes them, and they are unreachable behind the new
		// snapshot sequence meanwhile. Pending proposals are untouched: every pending read,
		// rebase and Accept checks the lineage generation, so old proposals become visibly stale.
		const repairWriteResult = Result_all(
			await Promise.all([
				ctx.db.patch("files_yjs_snapshots", state.yjsSnapshotDoc._id, {
					sequence: args.targetSequence,
					assetId: args.yjsSnapshotAssetId,
					updatedBy: args.authorUserId,
					updatedAt: now,
				}),
				ctx.db.delete("files_yjs_docs_last_sequences", state.yjsLastSequenceDoc._id),
				ctx.db.patch("files_r2_assets", args.yjsSnapshotAssetId, {
					r2Key: r2_create_asset_key({
						organizationId: args.organizationId,
						workspaceId: args.workspaceId,
						assetId: args.yjsSnapshotAssetId,
					}),
					unfinalizedExpiresAt: undefined,
					updatedAt: now,
				}),
				ctx.db.patch("files_r2_assets", args.contentSnapshotAssetId, {
					r2Key: r2_create_asset_key({
						organizationId: args.organizationId,
						workspaceId: args.workspaceId,
						assetId: args.contentSnapshotAssetId,
					}),
					unfinalizedExpiresAt: undefined,
					updatedAt: now,
				}),
				ctx.db.patch("files_nodes", args.nodeId, {
					assetId: args.contentSnapshotAssetId,
					yjsLastSequenceId: nextYjsLastSequenceId,
					contentTooLargeByteSize: undefined,
					contentShapeMismatchAt: undefined,
					contentYjsStateTooLargeByteSize: undefined,
					contentFrontmatterTooLargeFieldCount: frontmatterOverCapCounts?.fieldCount,
					contentFrontmatterTooLargeIndexDocumentCount: frontmatterOverCapCounts?.indexDocumentCount,
					updatedBy: args.authorUserId,
					updatedAt: now,
				}),
				store_version_snapshot(ctx, {
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					nodeId: args.nodeId,
					assetId: args.contentSnapshotAssetId,
					userId: args.authorUserId,
				}),
				db_replace_file_chunks(ctx, {
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					nodeId: args.nodeId,
					yjsSequence: args.targetSequence,
					textContent: args.text,
					skipFrontmatterIndex,
				}),
			]),
		);
		if (repairWriteResult._nay) {
			// Throw so Convex rolls back every related write above; returning would commit a
			// half-repaired file.
			throw convex_error({
				message: "Failed to finalize the Yjs repair",
				cause: repairWriteResult._nay,
			});
		}

		// The previous content asset stays owned by its files_snapshots history doc under normal
		// retention. Only the superseded Yjs asset is reference-checked and durably removed, in
		// the bounded continuation with the covered docs.
		await ctx.scheduler.runAfter(0, internal.files_nodes_content.cleanup_file_yjs_covered_rows, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId: args.nodeId,
			throughSequence: args.targetSequence,
			supersededYjsAssetId: args.supersededYjsAssetId,
			expectedActiveYjsLastSequenceId: nextYjsLastSequenceId,
			putMayArriveUntil: now + FILE_MATERIALIZATION_LATE_PUT_WINDOW_MS,
		});

		return Result({ _yay: { lineageGeneration: nextLineageGeneration } });
	},
});

type finalize_file_yjs_repair_Result =
	typeof finalize_file_yjs_repair extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * Bounded post-commit cleanup after a file's Yjs snapshot is replaced or removed: delete the
 * covered update docs and job docs in batches, then reference-check and remove the superseded Yjs
 * snapshot asset. Used by the repair and by turning collaboration off. Safe to rerun.
 */
export const cleanup_file_yjs_covered_rows = internalMutation({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		nodeId: v.id("files_nodes"),
		throughSequence: v.number(),
		supersededYjsAssetId: v.id("files_r2_assets"),
		expectedActiveYjsLastSequenceId: v.optional(v.id("files_yjs_docs_last_sequences")),
		nonCollaborativeCleanupYjsLastSequenceId: v.optional(v.id("files_yjs_docs_last_sequences")),
		/**
		 * Hold the R2 deletion job until this time when a materialization worker may still be
		 * running. That worker reads its header first and writes the snapshot object afterwards, so
		 * it can put the object back after this cleanup deletes it.
		 */
		putMayArriveUntil: v.optional(v.number()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const fileNode = await ctx.db.get("files_nodes", args.nodeId);
		const sameTenant =
			fileNode?.organizationId === args.organizationId && fileNode.workspaceId === args.workspaceId;
		// Row cleanup must belong either to the current collaborative lineage or to the exact OFF
		// barrier. Asset cleanup stays independent because its own reference check is safe.
		const canDeleteCoveredRows = args.nonCollaborativeCleanupYjsLastSequenceId
			? sameTenant &&
				fileNode.nonCollaborative === true &&
				fileNode.collaborationCleanupYjsLastSequenceId === args.nonCollaborativeCleanupYjsLastSequenceId
			: sameTenant &&
				args.expectedActiveYjsLastSequenceId !== undefined &&
				fileNode.yjsLastSequenceId === args.expectedActiveYjsLastSequenceId;

		if (canDeleteCoveredRows && (await db_delete_covered_file_content_docs(ctx, args))) {
			await ctx.scheduler.runAfter(0, internal.files_nodes_content.cleanup_file_yjs_covered_rows, args);
			return null;
		}

		// Reference-check the superseded Yjs asset before removal: after the swap no snapshot
		// doc should point at it, but a stale rerun of this cleanup must not delete a live asset.
		const supersededAsset = await ctx.db.get("files_r2_assets", args.supersededYjsAssetId);
		if (supersededAsset) {
			const referencingSnapshot = await ctx.db
				.query("files_yjs_snapshots")
				.withIndex("by_asset", (q) => q.eq("assetId", args.supersededYjsAssetId))
				.first();
			if (!referencingSnapshot) {
				if (supersededAsset.r2Key) {
					if (
						organizations_is_global_organization_id(supersededAsset.organizationId) ||
						organizations_is_reserved_workspace_id(supersededAsset.workspaceId)
					) {
						await r2_delete_object(ctx, supersededAsset.r2Key);
					} else {
						// Add a deletion job before deleting the last doc that tracks this exact key.
						// The component retry cannot confirm that the old R2 file is gone.
						await r2_enqueue_object_deletion_job(ctx, {
							organizationId: supersededAsset.organizationId,
							workspaceId: supersededAsset.workspaceId,
							r2Key: supersededAsset.r2Key,
							reason: "untracked_asset_event",
							putMayArriveUntil: args.putMayArriveUntil,
						});
					}
				}
				await ctx.db.delete("files_r2_assets", args.supersededYjsAssetId);
			}
		}

		if (canDeleteCoveredRows && args.nonCollaborativeCleanupYjsLastSequenceId) {
			// Clear this only after the final old update/job batch and old asset are handled. A
			// duplicate continuation sees the missing marker and cannot cross into a fresh lineage.
			await ctx.db.patch("files_nodes", args.nodeId, {
				collaborationCleanupYjsLastSequenceId: undefined,
			});
		}

		return null;
	},
});

/**
 * Delete new repair assets after the final mutation refuses.
 * Delete only unpublished assets, so a late repeated call cannot delete a published asset.
 * Add tenant asset keys to the deletion jobs before deleting their docs.
 * Reserved scopes use the component cleanup because deletion jobs need real tenant ids.
 */
export const delete_unfinalized_repair_assets = internalMutation({
	args: {
		assetIds: v.array(v.id("files_r2_assets")),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		await Promise.all(
			args.assetIds.map(async (assetId) => {
				const asset = await ctx.db.get("files_r2_assets", assetId);
				if (asset && asset.r2Key === undefined) {
					const r2Key = r2_create_asset_key({
						organizationId: asset.organizationId,
						workspaceId: asset.workspaceId,
						assetId: asset._id,
					});
					if (
						organizations_is_global_organization_id(asset.organizationId) ||
						organizations_is_reserved_workspace_id(asset.workspaceId)
					) {
						await r2_delete_object(ctx, r2Key);
					} else {
						await r2_enqueue_object_deletion_job(ctx, {
							organizationId: asset.organizationId,
							workspaceId: asset.workspaceId,
							r2Key,
							reason: "failed_create",
						});
					}
					await ctx.db.delete("files_r2_assets", assetId);
				}
			}),
		);
		return null;
	},
});
// #endregion yjs repair

// #region collaboration toggle
// Turn the Yjs document of one editable text file off or on.
//
// OFF is destructive and needs an explicit acknowledgement: it deletes the whole collaborative
// history and every comment anchored inside the document. The committed text and the version
// history survive, and the file is still editable through the replace door.
//
// ON is cheap and safe: it builds one fresh compact document from the committed text.

/**
 * How long a deletion job waits before removing the old Yjs snapshot object.
 *
 * A materialization worker reads its header first and writes the snapshot object several steps
 * later. Turning collaboration off cancels that worker, but a worker that is already running keeps
 * going and can put the object back after this mutation deleted it. A Convex action runs for at
 * most ten minutes, so wait past that plus the usual margin.
 */
const FILE_MATERIALIZATION_LATE_PUT_WINDOW_MS = 10 * 60 * 1000 + r2_PUT_MAY_ARRIVE_MARGIN_MS;

export const set_file_non_collaborative = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
		/**
		 * The caller saw the warning and accepted it. This cannot be undone: the edit history and
		 * the comments anchored in the document are deleted for everybody.
		 */
		acknowledgeDropCollaborativeHistory: v.boolean(),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		// Make the caller say the word before anything is read or written, the same gate the repair
		// puts on its own lossy exit.
		if (!args.acknowledgeDropCollaborativeHistory) {
			return Result({
				_nay: { message: "Turning collaboration off deletes the edit history and needs the acknowledgement flag" },
			});
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "files_tree_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		// Changing the mode changes how the file is written, so it needs the same permission as
		// writing the file.
		const authorized = await access_control_db_authorize_node(ctx, {
			userAuth,
			membership,
			nodeId: args.nodeId,
			permission: "content.write",
		});
		if (authorized._nay) {
			return authorized;
		}

		const fileNode = await ctx.db.get("files_nodes", args.nodeId);
		if (
			!fileNode ||
			fileNode.organizationId !== membership.organizationId ||
			fileNode.workspaceId !== membership.workspaceId
		) {
			return Result({ _nay: { message: "Not found" } });
		}

		// Already off. Repeated calls succeed, like `set_node_read_only`.
		if (fileNode.nonCollaborative === true) {
			return Result({ _yay: null });
		}

		if (!files_node_has_editable_yjs_state(fileNode)) {
			return Result({ _nay: { message: "Not found" } });
		}

		// Check the lock after access and before the first write, like every other write door.
		const writable = files_node_require_writable(fileNode);
		if (writable._nay) {
			return writable;
		}

		const [yjsSnapshotDoc, yjsLastSequenceDoc, pendingUpdates] = await Promise.all([
			ctx.db.get("files_yjs_snapshots", fileNode.yjsSnapshotId),
			ctx.db.get("files_yjs_docs_last_sequences", fileNode.yjsLastSequenceId),
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_fileNode", (q) => q.eq("fileNodeId", args.nodeId))
				.collect(),
		]);
		if (!yjsSnapshotDoc || !yjsLastSequenceDoc) {
			const errorMessage = "A Yjs pointer on the file node points to a missing doc";
			const errorData = {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				nodeId: args.nodeId,
				yjsSnapshotId: fileNode.yjsSnapshotId,
				yjsLastSequenceId: fileNode.yjsLastSequenceId,
			};
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}

		// An eager-created node is a brand-new file nobody has accepted yet. A node with no
		// `yjsLastSequenceId` can never be hard-deleted again, because the eager-node delete check
		// refuses one, so discard, expiry and account deletion would all skip it and the sidebar
		// would keep showing it as "Added" forever. Ask the user to finish that decision first.
		if (pendingUpdates.some((pendingUpdate) => pendingUpdate.eagerCreated)) {
			return Result({ _nay: { message: "Accept or discard this new file before turning collaboration off." } });
		}

		// The committed text only ever reaches the last MATERIALIZED sequence, so deleting the
		// updates now would silently drop everything typed after it.
		const hasNonRecoverableMarker =
			fileNode.contentShapeMismatchAt !== undefined ||
			fileNode.contentYjsStateTooLargeByteSize !== undefined ||
			fileNode.contentTooLargeByteSize !== undefined;
		// A non-recoverable marked file can never materialize on its own again, so telling the user
		// to wait would be a lie. The frontmatter pair stays out: a later fitting edit can clear it.
		// The settle marker `contentTooLargeByteSize` counts here too, unlike in the repair gate
		// above: its own settlement deleted the jobs, so nothing will ever close the gap.
		if (yjsLastSequenceDoc.lastSequence > yjsSnapshotDoc.sequence && !hasNonRecoverableMarker) {
			return Result({ _nay: { message: "This file is still saving. Try again in a moment." } });
		}

		await cancel_file_content_materialization(ctx, { nodeId: args.nodeId });

		const now = Date.now();
		const discardsUnmaterializedState = yjsLastSequenceDoc.lastSequence > yjsSnapshotDoc.sequence;
		await Promise.all([
			ctx.db.delete("files_yjs_snapshots", yjsSnapshotDoc._id),
			ctx.db.delete("files_yjs_docs_last_sequences", yjsLastSequenceDoc._id),
			// Clear both pointers in the same mutation that deletes their docs. A node left holding
			// one pointer to a deleted doc makes the materialization header throw into a pool that
			// retries forever, which would stop materialization for every file in the deployment.
			//
			// Three markers go too, because all three describe the document that is being deleted.
			// `contentTooLargeByteSize` is set when the text INSIDE the document grew past the cap,
			// so the committed text this toggle keeps is the older one that still fit. Leaving the
			// marker would show a permanent "too large" banner on a file that is now small. The
			// frontmatter pair stays when it describes the committed text. Clear it when this
			// toggle discards a marked newer document and keeps an older committed snapshot.
			ctx.db.patch("files_nodes", args.nodeId, {
				nonCollaborative: true,
				collaborationCleanupYjsLastSequenceId: yjsLastSequenceDoc._id,
				yjsSnapshotId: undefined,
				yjsLastSequenceId: undefined,
				contentShapeMismatchAt: undefined,
				contentYjsStateTooLargeByteSize: undefined,
				contentTooLargeByteSize: undefined,
				...(discardsUnmaterializedState
					? {
							contentFrontmatterTooLargeFieldCount: undefined,
							contentFrontmatterTooLargeIndexDocumentCount: undefined,
						}
					: {}),
				updatedBy: userAuth.id,
				updatedAt: now,
			}),
			files_pending_updates_db_drop_content_for_node(ctx, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				nodeId: args.nodeId,
			}),
		]);

		// The update log can be long, so a bounded continuation deletes it and then removes the
		// superseded Yjs snapshot asset. The updates are unreachable already: nothing points at
		// them any more.
		await ctx.scheduler.runAfter(0, internal.files_nodes_content.cleanup_file_yjs_covered_rows, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			nodeId: args.nodeId,
			throughSequence: yjsLastSequenceDoc.lastSequence,
			supersededYjsAssetId: yjsSnapshotDoc.assetId,
			nonCollaborativeCleanupYjsLastSequenceId: yjsLastSequenceDoc._id,
			putMayArriveUntil: now + FILE_MATERIALIZATION_LATE_PUT_WINDOW_MS,
		});

		return Result({ _yay: null });
	},
});

async function db_file_has_remaining_yjs_history(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		nodeId: Id<"files_nodes">;
	},
) {
	const [remainingSnapshot, remainingUpdate] = await Promise.all([
		ctx.db
			.query("files_yjs_snapshots")
			.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
				q
					.eq("organizationId", args.organizationId)
					.eq("workspaceId", args.workspaceId)
					.eq("fileNodeId", args.nodeId),
			)
			.first(),
		ctx.db
			.query("files_yjs_updates")
			.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
				q
					.eq("organizationId", args.organizationId)
					.eq("workspaceId", args.workspaceId)
					.eq("fileNodeId", args.nodeId),
			)
			.first(),
	]);
	return remainingSnapshot !== null || remainingUpdate !== null;
}

export const get_set_file_collaborative_preflight = internalQuery({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
		userId: v.id("users"),
	},
	returns: v.union(
		v.object({
			organizationId: v.id("organizations"),
			workspaceId: v.id("organizations_workspaces"),
			rootKind: v.union(v.literal("rich_text"), v.literal("plain_text")),
			/** The file already has a Yjs document, so the action answers success and stops. */
			alreadyCollaborative: v.boolean(),
			/** `null` when the file is writable. The action refuses a locked file before it uploads. */
			readOnlyScopeNodeId: v.union(v.id("files_nodes"), v.null()),
			cleanupInProgress: v.boolean(),
			assetId: v.id("files_r2_assets"),
			assetR2Key: v.union(v.string(), v.null()),
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

		const fileNode = await ctx.db.get("files_nodes", args.nodeId);
		if (
			!fileNode ||
			fileNode.organizationId !== membership.organizationId ||
			fileNode.workspaceId !== membership.workspaceId ||
			!files_node_has_editable_text_content(fileNode)
		) {
			return null;
		}

		const asset = await ctx.db.get("files_r2_assets", fileNode.assetId);
		if (!asset) {
			const errorMessage = "fileNode.assetId points to a missing files_r2_assets doc";
			const errorData = {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				nodeId: args.nodeId,
				assetId: fileNode.assetId,
			};
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}

		const cleanupInProgress =
			fileNode.collaborationCleanupYjsLastSequenceId !== undefined &&
			(await db_file_has_remaining_yjs_history(ctx, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				nodeId: args.nodeId,
			}));

		return {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			rootKind: fileNode.yjsRootKind,
			alreadyCollaborative: fileNode.nonCollaborative !== true,
			readOnlyScopeNodeId: fileNode.readOnlyScopeNodeId ?? null,
			cleanupInProgress,
			assetId: fileNode.assetId,
			assetR2Key: asset.r2Key ?? null,
		};
	},
});

type get_set_file_collaborative_preflight_Result =
	typeof get_set_file_collaborative_preflight extends RegisteredQuery<
		infer _Visibility,
		infer _Args,
		infer ReturnValue
	>
		? Awaited<ReturnValue>
		: never;

/**
 * Turn collaboration on for a non-collaborative file.
 *
 * This is the creation path, not the repair path. The repair patches Yjs docs the file already has,
 * and this file has none, so every write it does would target a missing doc. What this door borrows
 * from the repair is the split where the action uploads to R2 and the mutation publishes, the
 * frontmatter preflight, and `db_replace_file_chunks` instead of a plain chunk insert.
 */
export const set_file_collaborative = action({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
	},
	returns: v_result({ _yay: v.null() }),
	// The annotation breaks same-file generated-API circularity.
	handler: async (ctx, args): Promise<files_content_public_action_Result> => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "files_tree_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const preflight = (await ctx.runQuery(internal.files_nodes_content.get_set_file_collaborative_preflight, {
			membershipId: args.membershipId,
			nodeId: args.nodeId,
			userId: userAuth.id,
		})) as get_set_file_collaborative_preflight_Result;
		if (!preflight) {
			return Result({ _nay: { message: "Not found" } });
		}

		// Already on. Repeated calls succeed, like the other toggle.
		if (preflight.alreadyCollaborative) {
			return Result({ _yay: null });
		}
		if (preflight.cleanupInProgress) {
			return Result({ _nay: { message: "The old collaboration history is still being removed. Try again in a moment." } });
		}

		// Refuse a locked file here, before the two uploads below. The finalize mutation asks the
		// same question again, because somebody can lock the file while the objects upload; this
		// check only keeps the common refusal from writing two objects the cleanup must delete.
		const writable = files_node_require_writable({ readOnlyScopeNodeId: preflight.readOnlyScopeNodeId ?? undefined });
		if (writable._nay) {
			return writable;
		}

		// The content asset holds exactly the committed chunk text: every door that writes the
		// chunks writes this object in the same transaction. Read it back instead of stitching the
		// chunk docs together again.
		if (!preflight.assetR2Key) {
			return Result({ _nay: { message: "Committed content has no stored object" } });
		}
		const committedBytes = await r2_fetch_object_from_bucket({ key: preflight.assetR2Key }).then((response) =>
			response.arrayBuffer(),
		);
		let committedText: string;
		// Fatal decoder: building a document from silently replaced bytes would launder corruption.
		try {
			committedText = new TextDecoder("utf-8", { fatal: true }).decode(committedBytes);
		} catch (error) {
			console.error("Committed content asset is not valid UTF-8", { nodeId: args.nodeId, error });
			return Result({ _nay: { message: "Committed content is not valid UTF-8" } });
		}

		const yjsDoc = files_yjs_doc_create_from_text({ text: committedText, rootKind: preflight.rootKind });
		if ("_nay" in yjsDoc) {
			return Result({ _nay: { message: yjsDoc._nay.message } });
		}
		const snapshotUpdate = encodeStateAsUpdate(yjsDoc);
		if (snapshotUpdate.byteLength > files_MAX_YJS_RECONSTRUCTED_STATE_BYTES) {
			return Result({
				_nay: { message: `Compact document exceeds ${files_MAX_YJS_RECONSTRUCTED_STATE_BYTES}-byte limit` },
			});
		}

		// Commit the text the new document produces, not the text that went in. Building a rich
		// document normalizes Markdown, and committing the old text would leave the chunks and the
		// document disagreeing from the first minute.
		const normalizedText = files_yjs_doc_get_text({ yjsDoc, rootKind: preflight.rootKind });
		if (normalizedText._nay) {
			return Result({ _nay: { message: normalizedText._nay.message } });
		}
		const textByteSize = files_get_utf8_byte_size(normalizedText._yay);
		if (textByteSize > files_MAX_TEXT_CONTENT_BYTES) {
			return Result({ _nay: { message: `Text content exceeds ${files_MAX_TEXT_CONTENT_BYTES}-byte limit` } });
		}

		// Upload both objects to fresh unfinalized assets. A refused final mutation deletes them
		// below; a crash leaves them to the unfinalized-asset sweeper.
		const [yjsSnapshotAssetId, contentSnapshotAssetId] = (await Promise.all([
			ctx.runMutation(internal.r2.insert_asset, {
				organizationId: preflight.organizationId,
				workspaceId: preflight.workspaceId,
				kind: "yjs_snapshot",
				size: snapshotUpdate.byteLength,
				createdBy: userAuth.id,
			}),
			ctx.runMutation(internal.r2.insert_asset, {
				organizationId: preflight.organizationId,
				workspaceId: preflight.workspaceId,
				kind: "content_snapshot",
				size: textByteSize,
				createdBy: userAuth.id,
			}),
		])) as [Id<"files_r2_assets">, Id<"files_r2_assets">];
		const yjsSnapshotR2Key = r2_create_asset_key({
			organizationId: preflight.organizationId,
			workspaceId: preflight.workspaceId,
			assetId: yjsSnapshotAssetId,
		});
		const contentSnapshotR2Key = r2_create_asset_key({
			organizationId: preflight.organizationId,
			workspaceId: preflight.workspaceId,
			assetId: contentSnapshotAssetId,
		});
		await Promise.all([
			r2_put_object(ctx, {
				key: yjsSnapshotR2Key,
				body: files_u8_to_array_buffer(snapshotUpdate),
				contentType: "application/octet-stream" satisfies files_ContentType,
			}),
			r2_put_object(ctx, {
				key: contentSnapshotR2Key,
				body: normalizedText._yay,
				contentType: "text/markdown;charset=utf-8" satisfies files_ContentType,
			}),
		]);

		const finalized = (await ctx.runMutation(internal.files_nodes_content.finalize_file_collaboration_enable, {
			membershipId: args.membershipId,
			nodeId: args.nodeId,
			text: normalizedText._yay,
			textSize: textByteSize,
			baseAssetId: preflight.assetId,
			yjsSnapshotAssetId,
			yjsSnapshotSize: snapshotUpdate.byteLength,
			contentSnapshotAssetId,
		})) as finalize_file_collaboration_enable_Result;
		if (finalized._nay) {
			// Both uploads are now unreferenced. Hand their keys to the deletion ledger in one
			// mutation so a crash right here cannot leave the objects in the bucket forever.
			await ctx.runMutation(internal.files_nodes_content.cleanup_file_node_creation_assets, {
				assetIds: [yjsSnapshotAssetId, contentSnapshotAssetId],
				r2Keys: [yjsSnapshotR2Key, contentSnapshotR2Key],
				durableTenantScope: {
					organizationId: preflight.organizationId,
					workspaceId: preflight.workspaceId,
				},
			});
			return finalized;
		}

		return Result({ _yay: null });
	},
});

export const finalize_file_collaboration_enable = internalMutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
		text: v.string(),
		textSize: v.number(),
		baseAssetId: v.id("files_r2_assets"),
		yjsSnapshotAssetId: v.id("files_r2_assets"),
		yjsSnapshotSize: v.number(),
		contentSnapshotAssetId: v.id("files_r2_assets"),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
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

		const authorized = await access_control_db_authorize_node(ctx, {
			userAuth,
			membership,
			nodeId: args.nodeId,
			permission: "content.write",
		});
		if (authorized._nay) {
			return authorized;
		}

		const fileNode = await ctx.db.get("files_nodes", args.nodeId);
		if (
			!fileNode ||
			fileNode.organizationId !== membership.organizationId ||
			fileNode.workspaceId !== membership.workspaceId ||
			!files_node_has_editable_text_content(fileNode)
		) {
			return Result({ _nay: { message: "Not found" } });
		}

		// Check the lock after access and before the first write, like every other write door.
		const writable = files_node_require_writable(fileNode);
		if (writable._nay) {
			return writable;
		}

		// Two toggles running at once would otherwise both insert a snapshot doc, and the second
		// node patch would orphan the first pair. The flag is the gate: only one call can find it
		// still set.
		if (fileNode.nonCollaborative !== true) {
			return Result({ _nay: { message: "This file is already collaborative. Reload it and try again." } });
		}
		// A cleanup can delete its last Yjs doc and fail before it clears the marker. Check the docs
		// again in this transaction so a real cleanup still blocks while a stale marker does not.
		if (
			fileNode.collaborationCleanupYjsLastSequenceId !== undefined &&
			(await db_file_has_remaining_yjs_history(ctx, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				nodeId: args.nodeId,
			}))
		) {
			return Result({
				_nay: { message: "The old collaboration history is still being removed. Try again in a moment." },
			});
		}

		// A save landed while this toggle was uploading, so the document was built from text that is
		// no longer current.
		if (fileNode.assetId !== args.baseAssetId) {
			return Result({
				_nay: { message: "This file changed while you were saving. Copy your local changes before reloading, then try again." },
			});
		}

		// Mirror the materializer's frontmatter preflight. A file whose committed frontmatter is
		// over the caps must still get its document; letting the metadata insert helper's backstop
		// throw would roll the whole toggle back. Commit the chunks with no metadata index and keep
		// the marker pair set with fresh counts instead.
		const frontmatter = fileNode.yjsRootKind === "rich_text" ? files_metadata_preflight_frontmatter(args.text) : null;
		// Unreadable frontmatter is not over-cap, so leave the markers alone.
		if (frontmatter?._nay) {
			console.warn("Turning collaboration on without frontmatter metadata: the frontmatter could not be parsed", {
				nodeId: args.nodeId,
				error: frontmatter._nay,
			});
		}
		const frontmatterOverCapCounts =
			frontmatter?._yay != null && files_metadata_frontmatter_exceeds_index_caps(frontmatter._yay)
				? frontmatter._yay
				: null;
		const skipFrontmatterIndex = frontmatterOverCapCounts !== null || frontmatter?._nay != null;

		const now = Date.now();
		const [yjsSnapshotId, yjsLastSequenceId] = await Promise.all([
			ctx.db.insert("files_yjs_snapshots", {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				fileNodeId: args.nodeId,
				sequence: 0,
				assetId: args.yjsSnapshotAssetId,
				createdBy: user._id,
				updatedBy: user._id,
				updatedAt: now,
			}),
			ctx.db.insert("files_yjs_docs_last_sequences", {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				fileNodeId: args.nodeId,
				lastSequence: 0,
				unmaterializedUpdateCount: 0,
				unmaterializedUpdateBytes: 0,
				lineageGeneration: 0,
			}),
		]);

		const enableWriteResult = Result_all(
			await Promise.all([
				// Point the node at the new document and at the text that document produced. The
				// text markers go: the action proved the text fits, and the frontmatter counts are
				// rewritten from this same text.
				ctx.db.patch("files_nodes", args.nodeId, {
					nonCollaborative: undefined,
					collaborationCleanupYjsLastSequenceId: undefined,
					yjsSnapshotId,
					yjsLastSequenceId,
					assetId: args.contentSnapshotAssetId,
					contentTooLargeByteSize: undefined,
					contentFrontmatterTooLargeFieldCount: frontmatterOverCapCounts?.fieldCount,
					contentFrontmatterTooLargeIndexDocumentCount: frontmatterOverCapCounts?.indexDocumentCount,
					updatedBy: user._id,
					updatedAt: now,
				}),
				ctx.db.patch("files_r2_assets", args.yjsSnapshotAssetId, {
					r2Key: r2_create_asset_key({
						organizationId: membership.organizationId,
						workspaceId: membership.workspaceId,
						assetId: args.yjsSnapshotAssetId,
					}),
					size: args.yjsSnapshotSize,
					unfinalizedExpiresAt: undefined,
					updatedAt: now,
				}),
				ctx.db.patch("files_r2_assets", args.contentSnapshotAssetId, {
					r2Key: r2_create_asset_key({
						organizationId: membership.organizationId,
						workspaceId: membership.workspaceId,
						assetId: args.contentSnapshotAssetId,
					}),
					size: args.textSize,
					unfinalizedExpiresAt: undefined,
					updatedAt: now,
				}),
				db_replace_file_chunks(ctx, {
					organizationId: membership.organizationId,
					workspaceId: membership.workspaceId,
					nodeId: args.nodeId,
					yjsSequence: 0,
					textContent: args.text,
					skipFrontmatterIndex,
				}),
				// Record the normalized text as a version. Building the document can rewrite
				// Markdown, so the user needs the pre-toggle text back if the rewrite surprises them,
				// and the new content asset needs a history doc that owns it. Do not charge an edit
				// credit because this mode conversion does not add new user text.
				store_version_snapshot(ctx, {
					organizationId: membership.organizationId,
					workspaceId: membership.workspaceId,
					nodeId: args.nodeId,
					assetId: args.contentSnapshotAssetId,
					userId: user._id,
				}),
			]),
		);
		if (enableWriteResult._nay) {
			const errorMessage = "Failed to turn collaboration on";
			console.error(errorMessage, { enableWriteResult, nodeId: args.nodeId });
			// Throw so Convex rolls back every write above, the two inserts included. Returning
			// `_nay` would commit a node pointing at a document whose chunks failed to write.
			throw convex_error({ message: errorMessage, cause: enableWriteResult._nay });
		}

		return Result({ _yay: null });
	},
});

type finalize_file_collaboration_enable_Result =
	typeof finalize_file_collaboration_enable extends RegisteredMutation<
		infer _Visibility,
		infer _Args,
		infer ReturnValue
	>
		? Awaited<ReturnValue>
		: never;
// #endregion collaboration toggle
