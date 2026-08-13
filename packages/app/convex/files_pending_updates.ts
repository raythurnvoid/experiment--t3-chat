import {
	query,
	action,
	internalAction,
	internalMutation,
	internalQuery,
	mutation,
	type ActionCtx,
	type MutationCtx,
	type QueryCtx,
} from "./_generated/server.js";
import type { Id } from "./_generated/dataModel.js";
import type { RegisteredAction, RegisteredMutation, RegisteredQuery } from "convex/server";
import { v } from "convex/values";
import { doc } from "convex-helpers/validators";
import type { app_convex_Doc } from "../src/lib/app-convex-client.ts";
import { path_join, server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";
import { convex_error, v_result } from "../server/convex-utils.ts";
import app_convex_schema from "./schema.ts";
import { api, internal } from "./_generated/api.js";
import {
	files_db_yjs_push_update,
	files_node_require_writable,
	files_nodes_db_apply_pending_move,
	files_nodes_db_archive_nodes,
	files_nodes_db_can_act_on_swept_nodes,
	files_nodes_db_collect_descendants,
	files_nodes_db_hard_delete_node,
	files_nodes_db_is_eager_node_safe_to_hard_delete,
	files_nodes_db_remove_created_ancestor_folders_if_safe,
	files_nodes_db_require_subtree_writable,
	files_nodes_db_require_swept_nodes_writable,
	files_nodes_db_resolve_parent_read_only_scope,
	files_nodes_db_validate_pending_move_target_for_proposal,
	authorize_leaving_restricted_scope,
	files_yjs_NODE_NEEDS_REPAIR_MESSAGE,
	type get_file_content_materialization_header_Result,
	type get_file_next_yjs_update_Result,
} from "./files_nodes.ts";
import { billing_event } from "../server/billing.ts";
import { billing_db_check_credits, billing_pick_billed_user_id, billing_ingest_events } from "./billing_db.ts";
import { composite_id, should_never_happen } from "../shared/shared-utils.ts";
import { Result } from "common/errors-as-values-utils.ts";
import { organizations_db_get_membership } from "./organizations.ts";
import {
	access_control_db_authorize_membership,
	access_control_db_authorize_node,
	access_control_db_can_act_on_file_node,
	access_control_db_filter_readable_file_nodes,
} from "./access_control.ts";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";
import {
	files_ROOT_ID,
	files_db_cancel_pending_update_cleanup_tasks,
	files_db_expire_pending_update_operation_batch,
	files_db_get_pending_path_overlay_data,
	files_db_get_pending_update,
	files_db_insert_pending_update_yjs_state,
	files_db_list_pending_updates_for_user,
	files_db_load_pending_update_yjs_state_bytes,
	files_db_retire_pending_update_yjs_states,
	files_db_schedule_pending_update_cleanup,
	files_node_has_editable_yjs_state,
	files_pending_update_content_of,
	files_pending_update_yjs_state_digest,
	files_u8_to_array_buffer,
	files_u8_equals,
} from "../server/files.ts";
import {
	files_yjs_doc_apply_array_buffer_update,
	files_yjs_doc_create_from_array_buffer_update,
	files_yjs_doc_clone,
	files_yjs_compute_diff_update_from_yjs_doc,
	files_yjs_decode_v1_update,
	files_yjs_doc_check_text_addressable,
	files_yjs_doc_plain_text_root_map_size,
} from "../shared/files-yjs.ts";
import { files_yjs_doc_get_text, files_yjs_doc_update_from_text } from "../shared/files-tiptap.ts";
import { files_chunk_markdown } from "../server/files-markdown-chunking-mastra.ts";
import { files_chunk_plain_text } from "../server/files-plain-text-chunking.ts";
import {
	files_MAX_TEXT_CONTENT_BYTES,
	files_MAX_YJS_RECONSTRUCTED_STATE_BYTES,
	files_MAX_YJS_WIRE_BYTES,
	files_get_utf8_byte_size,
	files_normalize_text_document_input,
	type files_YjsRootKind,
} from "../shared/files.ts";
import {
	files_metadata_frontmatter_exceeds_index_caps,
	files_metadata_preflight_frontmatter,
} from "../shared/files-metadata.ts";
import { r2_fetch_object_from_bucket } from "./r2_client.ts";
import { files_metadata_db_delete_pending, files_metadata_db_replace_pending } from "./files_metadata.ts";
import { Doc as YDoc, encodeStateAsUpdate } from "yjs";

// Make Convex reuse the loaded module between calls, so warm calls skip the module load cost.
// Does NOT work for http actions (see http.ts). No mutable module-level state allowed here.
export const experimental_reuseContext = true;

function files_pending_update_encode_yjs_state_update(args: { yjsDoc: YDoc }) {
	return files_u8_to_array_buffer(encodeStateAsUpdate(args.yjsDoc));
}

/**
 * Door 2, part (i) for one client-supplied whole document state: non-empty (the empty document
 * encodes as the canonical two bytes, never zero — a stored zero-byte value poisons the next
 * merge, and a dirty zero-byte legacy field must be refused here, not crash), bounded by the
 * reconstructed-state cap, and the shared encoding rules (V2 refusal, catch-and-refuse on
 * malformed bytes).
 *
 * This is deliberately NOT door 1's content whitelist: a whole state legitimately carries what
 * an incremental plain-text diff never should — most importantly the tolerated second root of a
 * both-roots document — and the whitelist here would refuse a state this feature calls legal,
 * permanently and with no marker.
 */
function files_pending_update_check_whole_state_bytes(args: { stateBytes: ArrayBuffer }) {
	if (args.stateBytes.byteLength === 0) {
		return Result({ _nay: { message: "Empty state" } });
	}
	if (args.stateBytes.byteLength > files_MAX_YJS_RECONSTRUCTED_STATE_BYTES) {
		return Result({ _nay: { message: `State exceeds ${files_MAX_YJS_RECONSTRUCTED_STATE_BYTES}-byte limit` } });
	}

	const decoded = files_yjs_decode_v1_update({ update: new Uint8Array(args.stateBytes) });
	if (decoded._nay) {
		return decoded;
	}

	return Result({ _yay: null });
}

/**
 * Door 2, part (ii) for one reconstructed branch document, per the node's `rootKind`.
 *
 * Plain branch: the parity check PLUS `plainTextRoot._map.size === 0`. Parity alone is not
 * enough — a `Y.Map` named `plain_text` passes parity reading `""`, and Accept would then
 * publish `""` over the file. Door 1 closes the same hole for incremental updates by refusing
 * `parentSub` items; the two doors must stay symmetric or the asymmetry becomes a permanent
 * brick (one door keeps accepting a state the other refuses forever).
 *
 * Rich branch: NOT parity (vacuously true on a Markdown branch — `getText` would coerce an
 * absent root and read `""`); door 1's rich-text answer instead: refuse when the plain-text
 * root is present and the rich-text root is absent. The shared predicate reads `share` before
 * any accessor, which is why this must run before any getter call on the same document.
 */
function files_pending_update_check_branch_doc_shape(args: { yjsDoc: YDoc; rootKind: files_YjsRootKind }) {
	const addressable = files_yjs_doc_check_text_addressable({ yjsDoc: args.yjsDoc, rootKind: args.rootKind });
	if (addressable._nay) {
		return addressable;
	}

	if (args.rootKind === "plain_text" && files_yjs_doc_plain_text_root_map_size({ yjsDoc: args.yjsDoc }) !== 0) {
		return Result({
			_nay: { message: "Update does not match the file shape", cause: { refusedMapSlots: true } },
		});
	}

	return Result({ _yay: null });
}

/**
 * Stable staleness refusal shared by the rebase and save flows: the proposal's base no longer
 * matches the latest live state (a newer commit or a lineage repair landed) and the client must
 * re-read before writing.
 */
const PENDING_BASE_STALE_MESSAGE = "Pending update base is stale and must be rebuilt from the latest live file state";

/** Lifetime of one pending-state operation batch and everything staged under it. */
const PENDING_OPERATION_BATCH_TTL_MS = 30 * 60 * 1000;

/**
 * How long a batch may sit with no staging or sealing before a new batch-create by the same
 * user takes it over. A live client stages page after page within seconds, so two minutes of
 * silence means the old client crashed or lost its network; without the takeover the user would
 * wait out the full 30-minute TTL. The TTL sweep stays the fallback for users who never retry.
 */
const PENDING_OPERATION_BATCH_IDLE_TAKEOVER_MS = 2 * 60 * 1000;

/** A paged state holds at most this many pages (5 x 930,000 bytes covers the 4 MiB state cap). */
const PENDING_STATE_MAX_PAGES_PER_STATE = 5;

/** One batch phase (input or output) holds at most this many page bytes across its three states. */
const PENDING_STATE_MAX_PHASE_TOTAL_BYTES = 12 * 1024 * 1024;

/**
 * Reconstruct the latest live file state in action memory, reading only through the frozen
 * `targetSequence`: the materialization header plus one update doc per query call, because one
 * allowed update doc may itself be 930,000 bytes so an aggregate read has no bounded envelope. A
 * concurrent push past `targetSequence` never changes what this run reads; the commit mutation
 * rechecks the sequence and refuses if the live document moved.
 */
async function files_pending_update_action_get_latest_file_yjs_state(
	ctx: ActionCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		nodeId: app_convex_Doc<"files_pending_updates">["fileNodeId"];
		targetSequence: number;
	},
) {
	const header = (await ctx.runQuery(internal.files_nodes.get_file_content_materialization_header, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		nodeId: args.nodeId,
		targetSequence: args.targetSequence,
	})) as get_file_content_materialization_header_Result;
	if (!header) {
		return Result({
			_nay: {
				message: "Not found",
			},
		});
	}

	// While a durable shape/state marker is set the file is not accepting new edits, and an
	// oversized snapshot asset must never be downloaded: preflight the size before any GET.
	if (
		header.fileNode.contentShapeMismatchAt !== undefined ||
		header.fileNode.contentYjsStateTooLargeByteSize !== undefined ||
		header.yjsSnapshotAsset.size > files_MAX_YJS_RECONSTRUCTED_STATE_BYTES
	) {
		return Result({ _nay: { message: files_yjs_NODE_NEEDS_REPAIR_MESSAGE } });
	}

	if (!header.yjsSnapshotAsset.r2Key) {
		const errorMessage = "yjsSnapshotAsset.r2Key is not set";
		const errorData = {
			nodeId: args.nodeId,
			assetId: header.yjsSnapshotAsset._id,
		};
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}

	const baseSnapshotUpdate = await r2_fetch_object_from_bucket({ key: header.yjsSnapshotAsset.r2Key }).then(
		(response) => response.arrayBuffer(),
	);
	const baseYjsDoc = files_yjs_doc_create_from_array_buffer_update(baseSnapshotUpdate);

	let afterSequence = header.yjsSnapshotDoc.sequence;
	while (afterSequence < header.throughSequence) {
		const next = (await ctx.runQuery(internal.files_nodes.get_file_next_yjs_update, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId: args.nodeId,
			afterSequence,
			throughSequence: header.throughSequence,
		})) as get_file_next_yjs_update_Result;
		// `done` before reaching `throughSequence` means the covered-doc cleanup deleted the
		// walked update docs behind a newer snapshot while this walk ran. The partial document must not
		// be returned labeled with the full sequence — a commit built on it would write content
		// the user never produced — so refuse and let the caller retry against the new snapshot.
		// Use the same rule as the materializer's one-doc loop in files_nodes_content.ts.
		if (next.kind === "done") {
			console.error("Refusing a partial file state reconstruction: the update log ended early", {
				nodeId: args.nodeId,
				afterSequence,
				throughSequence: header.throughSequence,
			});
			return Result({ _nay: { message: "Failed to load file state" } });
		}
		// Reconstruction over a broken log would build wrong content; refuse instead.
		if (next.kind === "gap") {
			console.error("Refusing to reconstruct file state over a broken update log", {
				nodeId: args.nodeId,
				expectedSequence: next.expectedSequence,
				foundSequence: next.foundSequence,
			});
			return Result({ _nay: { message: "Failed to load file state" } });
		}
		files_yjs_doc_apply_array_buffer_update(baseYjsDoc, next.row.update);
		afterSequence = next.row.sequence;
	}

	const baseYjsUpdate = files_pending_update_encode_yjs_state_update({ yjsDoc: baseYjsDoc });
	if (baseYjsUpdate.byteLength > files_MAX_YJS_RECONSTRUCTED_STATE_BYTES) {
		return Result({ _nay: { message: files_yjs_NODE_NEEDS_REPAIR_MESSAGE } });
	}

	return Result({
		_yay: {
			baseYjsSequence: header.throughSequence,
			baseYjsDoc,
			baseYjsUpdate,
		},
	});
}

/**
 * Reassemble one paged state's bytes in action memory, one page-sized query call at a time (a
 * page may itself be 930,000 bytes, so no aggregate query returns a whole state). The digest
 * recheck catches a family torn by a concurrent write between page reads.
 */
async function action_load_pending_state_bytes(
	ctx: ActionCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
		stateId: Id<"files_pending_update_yjs_states">;
	},
) {
	const firstPage = (await ctx.runQuery(internal.files_pending_updates.get_file_pending_update_state_page_internal, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		userId: args.userId,
		stateId: args.stateId,
		pageIndex: 0,
	})) as get_file_pending_update_state_page_internal_Result;
	if (!firstPage) {
		return Result({ _nay: { message: "Not found" } });
	}

	const chunks: Uint8Array[] = [new Uint8Array(firstPage.bytes)];
	for (let pageIndex = 1; pageIndex < firstPage.pageCount; pageIndex++) {
		const page = (await ctx.runQuery(internal.files_pending_updates.get_file_pending_update_state_page_internal, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			stateId: args.stateId,
			pageIndex,
		})) as get_file_pending_update_state_page_internal_Result;
		if (!page) {
			return Result({ _nay: { message: "Not found" } });
		}
		chunks.push(new Uint8Array(page.bytes));
	}

	const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
	const bytes = new Uint8Array(totalLength);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	if (totalLength !== firstPage.totalBytes || files_pending_update_yjs_state_digest(bytes) !== firstPage.digest) {
		return Result({ _nay: { message: "Not found" } });
	}

	return Result({ _yay: bytes });
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
	const [textChunks, plainTextChunks] = await Promise.all([
		ctx.db
			.query("files_text_chunks")
			.withIndex("by_pendingUpdate_chunkIndex", (q) => q.eq("pendingUpdateId", args.pendingUpdateId))
			.collect(),
		ctx.db
			.query("files_plain_text_chunks")
			.withIndex("by_pendingUpdate_chunkIndex", (q) => q.eq("pendingUpdateId", args.pendingUpdateId))
			.collect(),
	]);
	await Promise.all([
		...plainTextChunks.map((chunk) => ctx.db.delete("files_plain_text_chunks", chunk._id)),
		...textChunks.map((chunk) => ctx.db.delete("files_text_chunks", chunk._id)),
		files_metadata_db_delete_pending(ctx, args),
	]);
}

/**
 * The pending half of the frontmatter caps: refuse BEFORE any canonical proposal, state, chunk,
 * or metadata write. The commit mutations run this among their first content checks; on the
 * returned refusal the calling action retires the staged input batch, so nothing durable is left
 * behind. The insert helper's late throw stays only as an impossible backstop. Returns the
 * refusal `_nay` Result, or `null` when the text passes (plain text has no frontmatter at all).
 */
function files_pending_update_check_frontmatter_caps(args: {
	fileNode: { yjsRootKind: files_YjsRootKind };
	unstagedText: string;
}) {
	if (args.fileNode.yjsRootKind !== "rich_text") {
		return null;
	}

	const preflight = files_metadata_preflight_frontmatter(args.unstagedText);
	if (files_metadata_frontmatter_exceeds_index_caps(preflight)) {
		return Result({ _nay: { message: "Too many frontmatter fields" } });
	}

	return null;
}

/**
 * Replace the pending exact-text chunk docs, plain-text search docs, and metadata docs for the
 * `unstaged` text.
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
		unstagedText: string;
	},
) {
	await files_pending_update_db_delete_chunks(ctx, { pendingUpdateId: args.pendingUpdateId });

	const fileNode = await ctx.db.get("files_nodes", args.nodeId);
	if (
		!fileNode ||
		fileNode.organizationId !== args.organizationId ||
		fileNode.workspaceId !== args.workspaceId ||
		!files_node_has_editable_yjs_state(fileNode)
	) {
		console.error("Failed to replace pending update chunks: fileNode is missing or mismatched", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId: args.nodeId,
			pendingUpdateId: args.pendingUpdateId,
			fileNode,
		});
		return Result({ _yay: null });
	}

	// The node owns the shape (a pending update is a proposal FOR a node), and the chunker
	// dispatches on it: a pending proposal on a `.json` must chunk as plain text.
	const rootKind = fileNode.yjsRootKind;
	const chunks =
		rootKind === "rich_text"
			? await files_chunk_markdown(args.unstagedText)
			: Result({ _yay: files_chunk_plain_text(args.unstagedText) });
	if (chunks._nay) {
		return chunks;
	}

	const textChunkIds = await Promise.all(
		chunks._yay.map(async (chunk) => {
			const shared = {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				sourceKind: "pending" as const,
				userId: args.userId,
				fileNodeId: args.nodeId,
				pendingUpdateId: args.pendingUpdateId,
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
		chunks._yay.map((chunk, index) =>
			ctx.db.insert("files_plain_text_chunks", {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				fileNodeId: args.nodeId,
				sourceKind: "pending",
				userId: args.userId,
				pendingUpdateId: args.pendingUpdateId,
				textChunkId: textChunkIds[index]!,
				path: fileNode.path,
				archiveOperationId: fileNode.archiveOperationId,
				chunkIndex: chunk.chunkIndex,
				plainTextChunk: chunk.plainTextChunk,
				textChunk: chunk.textChunk,
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

	// Frontmatter is a rich-text (Markdown) concept only: a `.yaml` proposal opening with `---`
	// must not be frontmatter-indexed. The stale pending metadata docs were already deleted above.
	if (rootKind === "rich_text") {
		await files_metadata_db_replace_pending(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			nodeId: args.nodeId,
			pendingUpdateId: args.pendingUpdateId,
			unstagedText: args.unstagedText,
		});
	}

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

/**
 * Drop a doc's pending move and settle the doc: content-plus-move and copy docs keep their
 * content proposal (a copiedFrom doc must never be deleted here, or the eager-created
 * destination node would be left orphaned), move-only docs are deleted with their chunks
 * and cleanup tasks.
 */
async function files_pending_update_db_settle_move_row(
	ctx: MutationCtx,
	args: { pendingUpdate: app_convex_Doc<"files_pending_updates"> },
) {
	const { pendingUpdate } = args;
	if (files_pending_update_content_of(pendingUpdate) || pendingUpdate.copiedFrom) {
		const now = Date.now();
		await Promise.all([
			ctx.db.patch("files_pending_updates", pendingUpdate._id, {
				pendingMove: undefined,
				updatedAt: now,
			}),
			files_db_schedule_pending_update_cleanup(ctx, {
				pendingUpdateId: pendingUpdate._id,
				expectedUpdatedAt: now,
			}),
		]);
	} else {
		await Promise.all([
			files_db_cancel_pending_update_cleanup_tasks(ctx, {
				pendingUpdateId: pendingUpdate._id,
			}),
			files_pending_update_db_delete_chunks(ctx, {
				pendingUpdateId: pendingUpdate._id,
			}),
			ctx.db.delete("files_pending_updates", pendingUpdate._id),
		]);
	}
}

/**
 * Drop a doc's pending delete and settle the doc: docs that still carry a content proposal
 * or copy provenance keep it (the row degrades back to a content/copy row), delete-only
 * docs are deleted with their chunks and cleanup tasks.
 */
async function files_pending_update_db_settle_archive_row(
	ctx: MutationCtx,
	args: { pendingUpdate: app_convex_Doc<"files_pending_updates"> },
) {
	const { pendingUpdate } = args;
	if (files_pending_update_content_of(pendingUpdate) || pendingUpdate.copiedFrom) {
		const now = Date.now();
		await Promise.all([
			ctx.db.patch("files_pending_updates", pendingUpdate._id, {
				pendingArchive: undefined,
				updatedAt: now,
			}),
			files_db_schedule_pending_update_cleanup(ctx, {
				pendingUpdateId: pendingUpdate._id,
				expectedUpdatedAt: now,
			}),
		]);
	} else {
		await Promise.all([
			files_db_cancel_pending_update_cleanup_tasks(ctx, {
				pendingUpdateId: pendingUpdate._id,
			}),
			files_pending_update_db_delete_chunks(ctx, {
				pendingUpdateId: pendingUpdate._id,
			}),
			ctx.db.delete("files_pending_updates", pendingUpdate._id),
		]);
	}
}

function files_pending_update_workspace_text_to_branch(args: {
	mut_yjsDoc: YDoc;
	text: string;
	rootKind: files_YjsRootKind;
}) {
	const currentText = files_yjs_doc_get_text({
		yjsDoc: args.mut_yjsDoc,
		rootKind: args.rootKind,
	});
	if (currentText._nay) {
		return currentText;
	}

	if (currentText._yay === args.text) {
		return Result({ _yay: false });
	}

	return files_yjs_doc_update_from_text({
		mut_yjsDoc: args.mut_yjsDoc,
		text: args.text,
		rootKind: args.rootKind,
	});
}

function files_pending_update_docs_match_content(args: {
	leftYjsDoc: YDoc;
	rightYjsDoc: YDoc;
	rootKind: files_YjsRootKind;
}) {
	const leftText = files_yjs_doc_get_text({
		yjsDoc: args.leftYjsDoc,
		rootKind: args.rootKind,
	});
	if (leftText._nay) {
		return leftText;
	}

	const rightText = files_yjs_doc_get_text({
		yjsDoc: args.rightYjsDoc,
		rootKind: args.rootKind,
	});
	if (rightText._nay) {
		return rightText;
	}

	return Result({
		_yay: leftText._yay === rightText._yay,
	});
}

// #region pending state staging
// The door-2 staging pipeline: one 30-minute operation batch per user/node, bounded state pages
// and one-value text inputs staged under it, one-role sealing that runs the door checks, and the
// final commits that atomically swap canonical state ids. No registered call in this region
// carries more than one large value, and no canonical write happens before the full door.
//
// Deliberate permission design: the page-stage, text-input, and seal mutations check BATCH
// OWNERSHIP only. Node `content.write` is enforced once at batch creation and re-enforced at
// every commit that swaps sealed states into canonical docs, so staged bytes grant nothing by
// themselves. Any future path that commits sealed states MUST re-check `content.write`; the
// whole safety of this pipeline rests on that commit gate.

async function db_get_owned_operation_batch(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: string;
		operationBatchId: Id<"files_pending_update_operation_batches">;
		now: number;
	},
) {
	const batch = await ctx.db.get("files_pending_update_operation_batches", args.operationBatchId);
	if (
		!batch ||
		batch.organizationId !== args.organizationId ||
		batch.workspaceId !== args.workspaceId ||
		batch.userId !== args.userId ||
		batch.expiresAt <= args.now
	) {
		return null;
	}
	return batch;
}

async function db_get_operation_batch_states(
	ctx: QueryCtx | MutationCtx,
	args: { operationBatchId: Id<"files_pending_update_operation_batches"> },
) {
	// At most three input plus three output states per batch (one per role and phase).
	return await ctx.db
		.query("files_pending_update_yjs_states")
		.withIndex("by_owner_operationBatch", (q) => q.eq("owner.operationBatchId", args.operationBatchId))
		.collect();
}

async function db_create_operation_batch(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: string;
		nodeId: Id<"files_nodes">;
	},
) {
	const now = Date.now();

	// One active batch per user/node. A refused admission is a visible `_nay` instead of a
	// silent queue: two interleaved operations on one proposal would tear each other's staging.
	const existingBatches = await ctx.db
		.query("files_pending_update_operation_batches")
		.withIndex("by_organization_workspace_user_fileNode", (q) =>
			q
				.eq("organizationId", args.organizationId)
				.eq("workspaceId", args.workspaceId)
				.eq("userId", args.userId)
				.eq("fileNodeId", args.nodeId),
		)
		.collect();
	const activeBatches = existingBatches.filter((batch) => batch.expiresAt > now);
	// A crashed client leaves its batch active until the TTL. This create is the same user
	// starting over, so take over a batch that has staged nothing for the idle window; only a
	// recently active batch still refuses.
	if (
		activeBatches.some((batch) => now - batch.lastActivityAt < PENDING_OPERATION_BATCH_IDLE_TAKEOVER_MS)
	) {
		return Result({ _nay: { message: "A pending update operation for this file is already in progress" } });
	}
	for (const batch of activeBatches) {
		await files_db_expire_pending_update_operation_batch(ctx, { operationBatchId: batch._id });
	}

	const expiresAt = now + PENDING_OPERATION_BATCH_TTL_MS;
	const operationBatchId = await ctx.db.insert("files_pending_update_operation_batches", {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		userId: args.userId,
		fileNodeId: args.nodeId,
		expiresAt,
		updatedAt: now,
		lastActivityAt: now,
	});

	return Result({ _yay: { operationBatchId, expiresAt } });
}

async function db_stage_operation_batch_state_page(
	ctx: MutationCtx,
	args: {
		batch: app_convex_Doc<"files_pending_update_operation_batches">;
		phase: "input" | "output";
		role: "base" | "staged" | "unstaged";
		pageIndex: number;
		bytes: ArrayBuffer;
	},
) {
	// Bounded-value checks BEFORE any insert.
	if (args.bytes.byteLength === 0) {
		return Result({ _nay: { message: "Empty state page" } });
	}
	if (args.bytes.byteLength > files_MAX_YJS_WIRE_BYTES) {
		return Result({ _nay: { message: `State page exceeds ${files_MAX_YJS_WIRE_BYTES}-byte limit` } });
	}

	const batchStates = await db_get_operation_batch_states(ctx, { operationBatchId: args.batch._id });
	const phaseStates = batchStates.filter(
		(stateDoc) => stateDoc.owner.kind === "temporary" && stateDoc.owner.phase === args.phase,
	);
	const existingState =
		phaseStates.find((stateDoc) => stateDoc.owner.kind === "temporary" && stateDoc.owner.role === args.role) ?? null;
	if (existingState?.sealed) {
		return Result({ _nay: { message: "State is already sealed" } });
	}
	if (existingState && existingState.pageCount >= PENDING_STATE_MAX_PAGES_PER_STATE) {
		return Result({ _nay: { message: "State has too many pages" } });
	}

	// Contiguity: pages arrive in order with no holes, so `pageCount` is the next expected index.
	const expectedPageIndex = existingState?.pageCount ?? 0;
	if (args.pageIndex !== expectedPageIndex) {
		return Result({ _nay: { message: "State pages must be staged in order" } });
	}

	// The three roles cap the phase at three states; this caps the phase's total page bytes.
	const phaseTotalBytes = phaseStates.reduce((sum, stateDoc) => sum + stateDoc.totalBytes, 0);
	if (phaseTotalBytes + args.bytes.byteLength > PENDING_STATE_MAX_PHASE_TOTAL_BYTES) {
		return Result({ _nay: { message: `Staged states exceed ${PENDING_STATE_MAX_PHASE_TOTAL_BYTES}-byte limit` } });
	}

	let stateId = existingState?._id ?? null;
	if (stateId === null) {
		stateId = await ctx.db.insert("files_pending_update_yjs_states", {
			organizationId: args.batch.organizationId,
			workspaceId: args.batch.workspaceId,
			userId: args.batch.userId,
			fileNodeId: args.batch.fileNodeId,
			owner: {
				kind: "temporary",
				operationBatchId: args.batch._id,
				phase: args.phase,
				role: args.role,
				expiresAt: args.batch.expiresAt,
			},
			// The real generation is stamped at seal time, when the current value is read anyway.
			lineageGeneration: 0,
			sealed: false,
			pageCount: 0,
			totalBytes: 0,
			digest: "",
		});
	}

	await Promise.all([
		ctx.db.insert("files_pending_update_yjs_state_pages", {
			organizationId: args.batch.organizationId,
			workspaceId: args.batch.workspaceId,
			stateId,
			pageIndex: args.pageIndex,
			bytes: args.bytes,
		}),
		ctx.db.patch("files_pending_update_yjs_states", stateId, {
			pageCount: expectedPageIndex + 1,
			totalBytes: (existingState?.totalBytes ?? 0) + args.bytes.byteLength,
		}),
		// Liveness signal for the same-user idle takeover in `db_create_operation_batch`.
		ctx.db.patch("files_pending_update_operation_batches", args.batch._id, { lastActivityAt: Date.now() }),
	]);

	return Result({ _yay: { stateId } });
}

/**
 * The one-role seal: reload the state's pages, verify completeness, then run door 2 on the
 * reassembled state — part (i) whole-state byte checks, part (ii) reconstruction, part (iii)
 * the per-`rootKind` shape rule (one branch, never both) — plus the visible-text cap.
 * Only this seal may mark a state valid; the final commits re-check digests and never reload
 * pages. Permission and batch-scope refusals happen in the callers before any decode here.
 */
async function db_seal_operation_batch_state(
	ctx: MutationCtx,
	args: {
		batch: app_convex_Doc<"files_pending_update_operation_batches">;
		phase: "input" | "output";
		role: "base" | "staged" | "unstaged";
		expectedTotalBytes: number;
	},
) {
	const fileNode = await ctx.db.get("files_nodes", args.batch.fileNodeId);
	if (
		!fileNode ||
		fileNode.organizationId !== args.batch.organizationId ||
		fileNode.workspaceId !== args.batch.workspaceId ||
		!files_node_has_editable_yjs_state(fileNode)
	) {
		return Result({ _nay: { message: "Not found" } });
	}
	const rootKind = fileNode.yjsRootKind;

	const batchStates = await db_get_operation_batch_states(ctx, { operationBatchId: args.batch._id });
	const state =
		batchStates.find(
			(stateDoc) =>
				stateDoc.owner.kind === "temporary" && stateDoc.owner.phase === args.phase && stateDoc.owner.role === args.role,
		) ?? null;
	if (!state) {
		return Result({ _nay: { message: "Not found" } });
	}
	if (state.sealed) {
		return Result({ _nay: { message: "State is already sealed" } });
	}
	if (state.totalBytes !== args.expectedTotalBytes) {
		return Result({ _nay: { message: "Staged state is incomplete" } });
	}

	const pages = await ctx.db
		.query("files_pending_update_yjs_state_pages")
		.withIndex("by_state_pageIndex", (q) => q.eq("stateId", state._id))
		.collect();
	if (pages.length !== state.pageCount || state.pageCount === 0) {
		return Result({ _nay: { message: "Staged state is incomplete" } });
	}
	const bytes = new Uint8Array(state.totalBytes);
	let offset = 0;
	for (const [index, page] of pages.entries()) {
		if (page.pageIndex !== index || offset + page.bytes.byteLength > bytes.byteLength) {
			return Result({ _nay: { message: "Staged state is incomplete" } });
		}
		bytes.set(new Uint8Array(page.bytes), offset);
		offset += page.bytes.byteLength;
	}
	if (offset !== state.totalBytes) {
		return Result({ _nay: { message: "Staged state is incomplete" } });
	}

	// Door 2 part (i): non-empty whole state, reconstructed-state cap, encoding rules.
	const stateBytes = files_u8_to_array_buffer(bytes);
	const checkedBytes = files_pending_update_check_whole_state_bytes({ stateBytes });
	if (checkedBytes._nay) {
		return checkedBytes;
	}

	// Door 2 parts (ii)+(iii): reconstruct and run the per-`rootKind` shape rule. `applyUpdate`
	// can still throw on bytes the decoder accepted; catch-and-refuse, never catch-and-continue.
	let yjsDoc: YDoc;
	try {
		yjsDoc = files_yjs_doc_create_from_array_buffer_update(stateBytes);
	} catch (error) {
		return Result({ _nay: { name: "nay", message: "Malformed update", cause: error } });
	}
	const checkedShape = files_pending_update_check_branch_doc_shape({ yjsDoc, rootKind });
	if (checkedShape._nay) {
		return checkedShape;
	}

	// Check the visible-text cap because this branch text is what chunks, search, and save carry.
	const text = files_yjs_doc_get_text({ yjsDoc, rootKind });
	if (text._nay) {
		return text;
	}
	if (files_get_utf8_byte_size(text._yay) > files_MAX_TEXT_CONTENT_BYTES) {
		return Result({ _nay: { message: `Text content exceeds ${files_MAX_TEXT_CONTENT_BYTES}-byte limit` } });
	}

	// Stamp the current lineage generation: the final commit rechecks it, so a repair that lands
	// between seal and commit makes the whole operation visibly stale instead of silently merging.
	const lastSequenceDoc = await ctx.db.get("files_yjs_docs_last_sequences", fileNode.yjsLastSequenceId);
	if (!lastSequenceDoc) {
		return Result({ _nay: { message: "Not found" } });
	}
	const lineageGeneration = lastSequenceDoc.lineageGeneration;

	const digest = files_pending_update_yjs_state_digest(bytes);
	await Promise.all([
		ctx.db.patch("files_pending_update_yjs_states", state._id, {
			sealed: true,
			digest,
			lineageGeneration,
		}),
		// Liveness signal for the same-user idle takeover in `db_create_operation_batch`.
		ctx.db.patch("files_pending_update_operation_batches", args.batch._id, { lastActivityAt: Date.now() }),
	]);

	return Result({
		_yay: { stateId: state._id, digest, totalBytes: state.totalBytes, lineageGeneration },
	});
}

async function db_stage_operation_batch_text_input(
	ctx: MutationCtx,
	args: {
		batch: app_convex_Doc<"files_pending_update_operation_batches">;
		role: "staged" | "unstaged";
		text: string;
	},
) {
	// This is the request boundary for BOTH pending content branches (the staged role is the one
	// published on save), and every upsert writer funnels through it. Normalize before the byte
	// count so the branch document, the pending chunks, and the stored size all see the same
	// LF-normalized, BOM-stripped string.
	const text = files_normalize_text_document_input(args.text);
	if (files_get_utf8_byte_size(text) > files_MAX_TEXT_CONTENT_BYTES) {
		return Result({ _nay: { message: `Text content exceeds ${files_MAX_TEXT_CONTENT_BYTES}-byte limit` } });
	}

	const existingTextInputs = await ctx.db
		.query("files_pending_update_text_inputs")
		.withIndex("by_operationBatch", (q) => q.eq("operationBatchId", args.batch._id))
		.collect();
	const existingTextInput = existingTextInputs.find((textInput) => textInput.role === args.role) ?? null;
	if (existingTextInput) {
		await ctx.db.patch("files_pending_update_text_inputs", existingTextInput._id, {
			text,
			expiresAt: args.batch.expiresAt,
		});
	} else {
		await ctx.db.insert("files_pending_update_text_inputs", {
			organizationId: args.batch.organizationId,
			workspaceId: args.batch.workspaceId,
			userId: args.batch.userId,
			fileNodeId: args.batch.fileNodeId,
			operationBatchId: args.batch._id,
			role: args.role,
			text,
			expiresAt: args.batch.expiresAt,
		});
	}
	// Liveness signal for the same-user idle takeover in `db_create_operation_batch`.
	await ctx.db.patch("files_pending_update_operation_batches", args.batch._id, { lastActivityAt: Date.now() });

	return Result({ _yay: null });
}

export const create_file_pending_update_operation_batch = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
	},
	returns: v_result({
		_yay: v.object({
			operationBatchId: v.id("files_pending_update_operation_batches"),
			expiresAt: v.number(),
		}),
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "files_pending_update_write", key: userAuth.id });
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

		const authorized = await access_control_db_authorize_node(ctx, {
			userAuth,
			membership,
			nodeId: args.nodeId,
			permission: "content.write",
		});
		if (authorized._nay) {
			return authorized;
		}

		// Refuse before staging pending Yjs input for a read-only file. Check again in the final write.
		const nodeWritable = files_node_require_writable(authorized._yay.fileNode);
		if (nodeWritable._nay) {
			return nodeWritable;
		}

		return await db_create_operation_batch(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: userAuth.id,
			nodeId: args.nodeId,
		});
	},
});

/**
 * Server-driven batch creation for the agent upsert and accept flows. No rate limit: the one
 * public call that reaches these flows already passed its own limit. The one-active-batch
 * admission rule still applies.
 */
export const create_file_pending_update_operation_batch_internal = internalMutation({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		nodeId: v.id("files_nodes"),
	},
	returns: v_result({
		_yay: v.object({
			operationBatchId: v.id("files_pending_update_operation_batches"),
			expiresAt: v.number(),
		}),
	}),
	handler: async (ctx, args) => {
		return await db_create_operation_batch(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			nodeId: args.nodeId,
		});
	},
});

export type create_file_pending_update_operation_batch_internal_Result =
	typeof create_file_pending_update_operation_batch_internal extends RegisteredMutation<
		infer _Visibility,
		infer _Args,
		infer ReturnValue
	>
		? Awaited<ReturnValue>
		: never;

export const stage_file_pending_update_state_page = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		operationBatchId: v.id("files_pending_update_operation_batches"),
		role: v.union(v.literal("base"), v.literal("staged"), v.literal("unstaged")),
		pageIndex: v.number(),
		bytes: v.bytes(),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "files_pending_update_write", key: userAuth.id });
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

		const batch = await db_get_owned_operation_batch(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: userAuth.id,
			operationBatchId: args.operationBatchId,
			now: Date.now(),
		});
		if (!batch) {
			return Result({ _nay: { message: "Not found" } });
		}

		const staged = await db_stage_operation_batch_state_page(ctx, {
			batch,
			// Clients stage inputs only; outputs are staged by the server-side actions.
			phase: "input",
			role: args.role,
			pageIndex: args.pageIndex,
			bytes: args.bytes,
		});
		if (staged._nay) {
			// A handled staging refusal ends this operation, so retire the family immediately like
			// the seal does; the TTL sweep stays only the crash/abandon fallback.
			await files_db_expire_pending_update_operation_batch(ctx, { operationBatchId: batch._id });
			return Result({ _nay: { message: staged._nay.message } });
		}

		return Result({ _yay: null });
	},
});

export const stage_file_pending_update_state_page_internal = internalMutation({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		operationBatchId: v.id("files_pending_update_operation_batches"),
		phase: v.union(v.literal("input"), v.literal("output")),
		role: v.union(v.literal("base"), v.literal("staged"), v.literal("unstaged")),
		pageIndex: v.number(),
		bytes: v.bytes(),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const batch = await db_get_owned_operation_batch(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			operationBatchId: args.operationBatchId,
			now: Date.now(),
		});
		if (!batch) {
			return Result({ _nay: { message: "Not found" } });
		}

		const staged = await db_stage_operation_batch_state_page(ctx, {
			batch,
			phase: args.phase,
			role: args.role,
			pageIndex: args.pageIndex,
			bytes: args.bytes,
		});
		if (staged._nay) {
			return Result({ _nay: { message: staged._nay.message } });
		}

		return Result({ _yay: null });
	},
});

export type stage_file_pending_update_state_page_internal_Result =
	typeof stage_file_pending_update_state_page_internal extends RegisteredMutation<
		infer _Visibility,
		infer _Args,
		infer ReturnValue
	>
		? Awaited<ReturnValue>
		: never;

export const seal_file_pending_update_state = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		operationBatchId: v.id("files_pending_update_operation_batches"),
		role: v.union(v.literal("base"), v.literal("staged"), v.literal("unstaged")),
		expectedTotalBytes: v.number(),
	},
	returns: v_result({ _yay: v.object({ stateId: v.id("files_pending_update_yjs_states") }) }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "files_pending_update_write", key: userAuth.id });
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

		const batch = await db_get_owned_operation_batch(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: userAuth.id,
			operationBatchId: args.operationBatchId,
			now: Date.now(),
		});
		if (!batch) {
			return Result({ _nay: { message: "Not found" } });
		}

		const sealed = await db_seal_operation_batch_state(ctx, {
			batch,
			phase: "input",
			role: args.role,
			expectedTotalBytes: args.expectedTotalBytes,
		});
		if (sealed._nay) {
			// A handled seal refusal retires the whole temporary family immediately; the TTL sweep
			// stays only the crash/abandon fallback. The expiry writes commit with this `_nay` on
			// purpose. Log the cause and return a message-only `_nay`; a `cause` field would fail
			// the `v_result` returns validator this Result crosses.
			await files_db_expire_pending_update_operation_batch(ctx, { operationBatchId: batch._id });
			console.warn("Refused to seal pending update state", {
				nodeId: batch.fileNodeId,
				role: args.role,
				error: sealed._nay,
			});
			return Result({ _nay: { message: sealed._nay.message } });
		}

		return Result({ _yay: { stateId: sealed._yay.stateId } });
	},
});

export const seal_file_pending_update_state_internal = internalMutation({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		operationBatchId: v.id("files_pending_update_operation_batches"),
		phase: v.union(v.literal("input"), v.literal("output")),
		role: v.union(v.literal("base"), v.literal("staged"), v.literal("unstaged")),
		expectedTotalBytes: v.number(),
	},
	returns: v_result({
		_yay: v.object({
			stateId: v.id("files_pending_update_yjs_states"),
			digest: v.string(),
			lineageGeneration: v.number(),
		}),
	}),
	handler: async (ctx, args) => {
		const batch = await db_get_owned_operation_batch(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			operationBatchId: args.operationBatchId,
			now: Date.now(),
		});
		if (!batch) {
			return Result({ _nay: { message: "Not found" } });
		}

		const sealed = await db_seal_operation_batch_state(ctx, {
			batch,
			phase: args.phase,
			role: args.role,
			expectedTotalBytes: args.expectedTotalBytes,
		});
		if (sealed._nay) {
			// Same retire-immediately rule as the public seal. Log-and-strip the cause.
			await files_db_expire_pending_update_operation_batch(ctx, { operationBatchId: batch._id });
			console.warn("Refused to seal pending update state", {
				nodeId: batch.fileNodeId,
				role: args.role,
				error: sealed._nay,
			});
			return Result({ _nay: { message: sealed._nay.message } });
		}

		return Result({
			_yay: {
				stateId: sealed._yay.stateId,
				digest: sealed._yay.digest,
				lineageGeneration: sealed._yay.lineageGeneration,
			},
		});
	},
});

export type seal_file_pending_update_state_internal_Result =
	typeof seal_file_pending_update_state_internal extends RegisteredMutation<
		infer _Visibility,
		infer _Args,
		infer ReturnValue
	>
		? Awaited<ReturnValue>
		: never;

export const stage_file_pending_update_text_input = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		operationBatchId: v.id("files_pending_update_operation_batches"),
		role: v.union(v.literal("staged"), v.literal("unstaged")),
		text: v.string(),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "files_pending_update_write", key: userAuth.id });
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

		const batch = await db_get_owned_operation_batch(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: userAuth.id,
			operationBatchId: args.operationBatchId,
			now: Date.now(),
		});
		if (!batch) {
			return Result({ _nay: { message: "Not found" } });
		}

		const staged = await db_stage_operation_batch_text_input(ctx, { batch, role: args.role, text: args.text });
		if (staged._nay) {
			// Same retire-immediately rule as the page staging above: a refused text ends this
			// operation, and a fresh batch must be admitted for the retry.
			await files_db_expire_pending_update_operation_batch(ctx, { operationBatchId: batch._id });
		}
		return staged;
	},
});

export const stage_file_pending_update_text_input_internal = internalMutation({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		operationBatchId: v.id("files_pending_update_operation_batches"),
		role: v.union(v.literal("staged"), v.literal("unstaged")),
		text: v.string(),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const batch = await db_get_owned_operation_batch(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			operationBatchId: args.operationBatchId,
			now: Date.now(),
		});
		if (!batch) {
			return Result({ _nay: { message: "Not found" } });
		}

		return await db_stage_operation_batch_text_input(ctx, { batch, role: args.role, text: args.text });
	},
});

export type stage_file_pending_update_text_input_internal_Result =
	typeof stage_file_pending_update_text_input_internal extends RegisteredMutation<
		infer _Visibility,
		infer _Args,
		infer ReturnValue
	>
		? Awaited<ReturnValue>
		: never;

/**
 * Retire a batch family after an action-side refusal. Actions cannot write, so every handled
 * refusal in the upsert/rebase/accept actions runs this to keep "refusals retire the family
 * immediately" true instead of leaning on the 30-minute TTL.
 */
export const retire_file_pending_update_operation_batch = internalMutation({
	args: {
		operationBatchId: v.id("files_pending_update_operation_batches"),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		await files_db_expire_pending_update_operation_batch(ctx, { operationBatchId: args.operationBatchId });
		return null;
	},
});

export const get_file_pending_update_state_page_internal = internalQuery({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		stateId: v.id("files_pending_update_yjs_states"),
		pageIndex: v.number(),
	},
	returns: v.union(
		v.object({
			bytes: v.bytes(),
			pageCount: v.number(),
			totalBytes: v.number(),
			digest: v.string(),
			sealed: v.boolean(),
			lineageGeneration: v.number(),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const state = await ctx.db.get("files_pending_update_yjs_states", args.stateId);
		if (
			!state ||
			state.organizationId !== args.organizationId ||
			state.workspaceId !== args.workspaceId ||
			state.userId !== args.userId
		) {
			return null;
		}

		const page = await ctx.db
			.query("files_pending_update_yjs_state_pages")
			.withIndex("by_state_pageIndex", (q) => q.eq("stateId", state._id).eq("pageIndex", args.pageIndex))
			.first();
		if (!page) {
			return null;
		}

		return {
			bytes: page.bytes,
			pageCount: state.pageCount,
			totalBytes: state.totalBytes,
			digest: state.digest,
			sealed: state.sealed,
			lineageGeneration: state.lineageGeneration,
		};
	},
});

export type get_file_pending_update_state_page_internal_Result =
	typeof get_file_pending_update_state_page_internal extends RegisteredQuery<
		infer _Visibility,
		infer _Args,
		infer ReturnValue
	>
		? Awaited<ReturnValue>
		: never;

/**
 * One page of one of the caller's own pending states, for the diff and pending panels. One page
 * per call is the whole contract: a page may itself be 930,000 bytes, so no query returns a
 * full state.
 */
export const get_file_pending_update_state_page = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
		stateId: v.id("files_pending_update_yjs_states"),
		pageIndex: v.number(),
	},
	returns: v.union(
		v.object({
			bytes: v.bytes(),
			pageCount: v.number(),
			totalBytes: v.number(),
			digest: v.string(),
		}),
		v.null(),
	),
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

		const authorized = await access_control_db_authorize_node(ctx, {
			userAuth,
			membership,
			nodeId: args.nodeId,
			permission: "content.read",
		});
		if (authorized._nay) {
			return null;
		}

		// Only the caller's own state families on the requested node are readable.
		const state = await ctx.db.get("files_pending_update_yjs_states", args.stateId);
		if (
			!state ||
			state.organizationId !== membership.organizationId ||
			state.workspaceId !== membership.workspaceId ||
			state.userId !== userAuth.id ||
			state.fileNodeId !== args.nodeId
		) {
			return null;
		}

		const page = await ctx.db
			.query("files_pending_update_yjs_state_pages")
			.withIndex("by_state_pageIndex", (q) => q.eq("stateId", state._id).eq("pageIndex", args.pageIndex))
			.first();
		if (!page) {
			return null;
		}

		return {
			bytes: page.bytes,
			pageCount: state.pageCount,
			totalBytes: state.totalBytes,
			digest: state.digest,
		};
	},
});

export const get_file_pending_update_text_input_internal = internalQuery({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		operationBatchId: v.id("files_pending_update_operation_batches"),
		role: v.union(v.literal("staged"), v.literal("unstaged")),
	},
	returns: v.union(v.object({ text: v.string() }), v.null()),
	handler: async (ctx, args) => {
		const batch = await db_get_owned_operation_batch(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			operationBatchId: args.operationBatchId,
			now: Date.now(),
		});
		if (!batch) {
			return null;
		}

		const textInputs = await ctx.db
			.query("files_pending_update_text_inputs")
			.withIndex("by_operationBatch", (q) => q.eq("operationBatchId", batch._id))
			.collect();
		const textInput = textInputs.find((row) => row.role === args.role) ?? null;
		if (!textInput) {
			return null;
		}

		return { text: textInput.text };
	},
});

export type get_file_pending_update_text_input_internal_Result =
	typeof get_file_pending_update_text_input_internal extends RegisteredQuery<
		infer _Visibility,
		infer _Args,
		infer ReturnValue
	>
		? Awaited<ReturnValue>
		: never;

/**
 * Stage one server-built trusted Yjs update ahead of its commit mutation (pending Accept,
 * public fill, snapshot restore), so the commit call carries only ids and at most one bounded
 * text value. One stage per user/node/kind; consumed on commit, TTL-swept when abandoned.
 */
export const stage_trusted_yjs_update = internalMutation({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		nodeId: v.id("files_nodes"),
		kind: v.union(v.literal("pending_accept"), v.literal("public_fill"), v.literal("snapshot_restore")),
		update: v.bytes(),
	},
	returns: v_result({ _yay: v.object({ stageId: v.id("files_yjs_trusted_update_stages") }) }),
	handler: async (ctx, args) => {
		// The staged value later becomes one `files_yjs_updates` doc, so it obeys the doc caps here
		// already: a stage that could never commit should not be storable.
		if (args.update.byteLength === 0) {
			return Result({ _nay: { message: "Empty update" } });
		}
		if (args.update.byteLength > files_MAX_YJS_WIRE_BYTES) {
			return Result({ _nay: { message: "Update too large" } });
		}

		const existingStages = await ctx.db
			.query("files_yjs_trusted_update_stages")
			.withIndex("by_organization_workspace_user_fileNode", (q) =>
				q
					.eq("organizationId", args.organizationId)
					.eq("workspaceId", args.workspaceId)
					.eq("userId", args.userId)
					.eq("fileNodeId", args.nodeId),
			)
			.collect();
		await Promise.all(
			existingStages
				.filter((stage) => stage.kind === args.kind)
				.map((stage) => ctx.db.delete("files_yjs_trusted_update_stages", stage._id)),
		);

		const stageId = await ctx.db.insert("files_yjs_trusted_update_stages", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			fileNodeId: args.nodeId,
			kind: args.kind,
			update: args.update,
			expiresAt: Date.now() + PENDING_OPERATION_BATCH_TTL_MS,
		});

		return Result({ _yay: { stageId } });
	},
});

export type files_pending_updates_stage_trusted_yjs_update_Result =
	typeof stage_trusted_yjs_update extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * Delete a trusted Yjs stage when the final write refuses before using it.
 */
export const retire_trusted_yjs_update_stage = internalMutation({
	args: {
		stageId: v.id("files_yjs_trusted_update_stages"),
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		nodeId: v.id("files_nodes"),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const stage = await ctx.db.get("files_yjs_trusted_update_stages", args.stageId);
		if (
			stage &&
			stage.organizationId === args.organizationId &&
			stage.workspaceId === args.workspaceId &&
			stage.userId === args.userId &&
			stage.fileNodeId === args.nodeId
		) {
			await ctx.db.delete("files_yjs_trusted_update_stages", stage._id);
		}
		return null;
	},
});

/**
 * The shared preflight for the upsert, rebase, and accept actions: every scalar the action
 * needs for its cheap refusals, and no state bytes. Internal — the caller resolved `userId`
 * from auth.
 */
export const get_data_for_pending_content_operation = internalQuery({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		nodeId: v.id("files_nodes"),
		operationBatchId: v.optional(v.id("files_pending_update_operation_batches")),
		pendingUpdateId: v.optional(v.id("files_pending_updates")),
	},
	returns: v.union(
		v.object({
			fileNode: doc(app_convex_schema, "files_nodes"),
			lastSequence: v.number(),
			lineageGeneration: v.number(),
			batch: v.union(doc(app_convex_schema, "files_pending_update_operation_batches"), v.null()),
			inputStates: v.array(doc(app_convex_schema, "files_pending_update_yjs_states")),
			textInputRoles: v.array(v.union(v.literal("staged"), v.literal("unstaged"))),
			existingPendingUpdate: v.union(doc(app_convex_schema, "files_pending_updates"), v.null()),
			currentCanonicalStates: v.array(doc(app_convex_schema, "files_pending_update_yjs_states")),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const fileNode = await ctx.db.get("files_nodes", args.nodeId);
		if (
			!fileNode ||
			fileNode.organizationId !== args.organizationId ||
			fileNode.workspaceId !== args.workspaceId ||
			!files_node_has_editable_yjs_state(fileNode)
		) {
			return null;
		}

		const lastSequenceDoc = await ctx.db.get("files_yjs_docs_last_sequences", fileNode.yjsLastSequenceId);
		if (!lastSequenceDoc) {
			const errorMessage = "fileNode.yjsLastSequenceId points to a missing files_yjs_docs_last_sequences doc";
			const errorData = { nodeId: args.nodeId, yjsLastSequenceId: fileNode.yjsLastSequenceId };
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}

		const batch = args.operationBatchId
			? await db_get_owned_operation_batch(ctx, {
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					userId: args.userId,
					operationBatchId: args.operationBatchId,
					now: Date.now(),
				})
			: null;
		const [inputStates, textInputs, existingPendingUpdate] = await Promise.all([
			batch
				? db_get_operation_batch_states(ctx, { operationBatchId: batch._id }).then((states) =>
						states.filter((stateDoc) => stateDoc.owner.kind === "temporary" && stateDoc.owner.phase === "input"),
					)
				: Promise.resolve([]),
			batch
				? ctx.db
						.query("files_pending_update_text_inputs")
						.withIndex("by_operationBatch", (q) => q.eq("operationBatchId", batch._id))
						.collect()
				: Promise.resolve([]),
			files_db_get_pending_update(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				userId: args.userId,
				nodeId: args.nodeId,
				pendingUpdateId: args.pendingUpdateId,
			}),
		]);

		const currentCanonicalStates = existingPendingUpdate
			? await ctx.db
					.query("files_pending_update_yjs_states")
					.withIndex("by_owner_pendingUpdate", (q) => q.eq("owner.pendingUpdateId", existingPendingUpdate._id))
					.collect()
			: [];

		return {
			fileNode,
			lastSequence: lastSequenceDoc.lastSequence,
			lineageGeneration: lastSequenceDoc.lineageGeneration,
			batch,
			inputStates,
			textInputRoles: textInputs.map((textInput) => textInput.role),
			existingPendingUpdate,
			currentCanonicalStates,
		};
	},
});

export type get_data_for_pending_content_operation_Result =
	typeof get_data_for_pending_content_operation extends RegisteredQuery<
		infer _Visibility,
		infer _Args,
		infer ReturnValue
	>
		? Awaited<ReturnValue>
		: never;
// #endregion pending state staging

/**
 * Delete an eager-created file only when it and its new parent folders are writable now.
 * Check every node before the first delete. If one node is read-only, keep the whole new path.
 */
async function files_pending_update_db_remove_eager_created_node_if_safe(
	ctx: MutationCtx,
	args: { pendingUpdate: app_convex_Doc<"files_pending_updates"> },
) {
	const eagerCreated = args.pendingUpdate.eagerCreated;
	if (!eagerCreated) {
		return false;
	}

	const node = await ctx.db.get("files_nodes", args.pendingUpdate.fileNodeId);
	if (
		!node ||
		node.organizationId !== args.pendingUpdate.organizationId ||
		node.workspaceId !== args.pendingUpdate.workspaceId ||
		files_node_require_writable(node)._nay
	) {
		return false;
	}

	for (const ancestorId of eagerCreated.createdAncestorIds ?? []) {
		const ancestor = await ctx.db.get("files_nodes", ancestorId);
		if (!ancestor) {
			continue;
		}
		if (
			ancestor.organizationId !== args.pendingUpdate.organizationId ||
			ancestor.workspaceId !== args.pendingUpdate.workspaceId ||
			files_node_require_writable(ancestor)._nay
		) {
			return false;
		}
	}

	const safeToHardDelete = await files_nodes_db_is_eager_node_safe_to_hard_delete(ctx, {
		organizationId: args.pendingUpdate.organizationId,
		workspaceId: args.pendingUpdate.workspaceId,
		nodeId: args.pendingUpdate.fileNodeId,
		pendingUpdate: args.pendingUpdate,
	});
	if (!safeToHardDelete) {
		return false;
	}

	await files_nodes_db_hard_delete_node(ctx, {
		organizationId: args.pendingUpdate.organizationId,
		workspaceId: args.pendingUpdate.workspaceId,
		nodeId: args.pendingUpdate.fileNodeId,
	});
	await files_nodes_db_remove_created_ancestor_folders_if_safe(ctx, {
		organizationId: args.pendingUpdate.organizationId,
		workspaceId: args.pendingUpdate.workspaceId,
		userId: args.pendingUpdate.userId,
		createdAncestorIds: eagerCreated.createdAncestorIds ?? [],
	});
	return true;
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

		if (pendingUpdate.eagerCreated) {
			if (await files_pending_update_db_remove_eager_created_node_if_safe(ctx, { pendingUpdate })) {
				// Expired eager-create proposal: remove the eager-created destination node entirely. The
				// hard delete also removes this doc, its chunks, and the remaining cleanup tasks.
				return null;
			}
			// The node became a real file (committed content or another user's draft):
			// fall through and delete only this doc.
		}

		await Promise.all([
			ctx.db.delete("files_pending_updates", pendingUpdate._id),
			files_db_retire_pending_update_yjs_states(ctx, {
				organizationId: pendingUpdate.organizationId,
				workspaceId: pendingUpdate.workspaceId,
				pendingUpdateId: pendingUpdate._id,
			}),
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

/** How many docs each expired-pending-state sweep surface handles per run before rescheduling. */
const PENDING_STATE_SWEEP_BATCH_SIZE = 32;

/**
 * 15-minute cron sweep for the crash/abandon fallback of the paged pending-state machinery:
 * expired temporary states, expired operation batches (with their text inputs and temporary
 * families), orphaned expired text inputs, expired trusted-update stages, and retired-state
 * cleanup tasks. Every handled refusal retires its family immediately; this sweep only covers
 * the paths a crash or an abandoned tab left behind.
 */
export const cleanup_expired_pending_state_rows = internalMutation({
	args: {
		_test_now: v.optional(v.number()),
		_test_disableReschedule: v.optional(v.boolean()),
	},
	returns: v.object({
		deletedCount: v.number(),
		done: v.boolean(),
	}),
	handler: async (ctx, args) => {
		const now = args._test_now ?? Date.now();
		let deletedCount = 0;
		let sawFullBatch = false;

		const deleteStateFamily = async (stateId: Id<"files_pending_update_yjs_states">) => {
			const pages = await ctx.db
				.query("files_pending_update_yjs_state_pages")
				.withIndex("by_state_pageIndex", (q) => q.eq("stateId", stateId))
				.collect();
			await Promise.all(pages.map((page) => ctx.db.delete("files_pending_update_yjs_state_pages", page._id)));
			await ctx.db.delete("files_pending_update_yjs_states", stateId);
			deletedCount += 1 + pages.length;
		};

		// Expired temporary states. Only the `temporary` owner variant has `owner.expiresAt`, and
		// docs without the field sort BEFORE every number on this index — the range MUST bound
		// from below (`gte(0)`), or the sweep would also return (and delete) every active and
		// retired state.
		const expiredStates = await ctx.db
			.query("files_pending_update_yjs_states")
			.withIndex("by_owner_expiresAt", (q) => q.gte("owner.expiresAt", 0).lte("owner.expiresAt", now))
			.take(PENDING_STATE_SWEEP_BATCH_SIZE);
		for (const state of expiredStates) {
			await deleteStateFamily(state._id);
		}
		sawFullBatch ||= expiredStates.length === PENDING_STATE_SWEEP_BATCH_SIZE;

		// Expired operation batches: delete the batch with its text inputs and any temporary
		// state families still owned by it.
		const expiredBatches = await ctx.db
			.query("files_pending_update_operation_batches")
			.withIndex("by_expiresAt", (q) => q.lte("expiresAt", now))
			.take(PENDING_STATE_SWEEP_BATCH_SIZE);
		for (const batch of expiredBatches) {
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
			await Promise.all(textInputs.map((textInput) => ctx.db.delete("files_pending_update_text_inputs", textInput._id)));
			for (const state of batchStates) {
				await deleteStateFamily(state._id);
			}
			await ctx.db.delete("files_pending_update_operation_batches", batch._id);
			deletedCount += 1 + textInputs.length;
		}
		sawFullBatch ||= expiredBatches.length === PENDING_STATE_SWEEP_BATCH_SIZE;

		// Orphaned expired text inputs whose batch is already gone.
		const expiredTextInputs = await ctx.db
			.query("files_pending_update_text_inputs")
			.withIndex("by_expiresAt", (q) => q.lte("expiresAt", now))
			.take(PENDING_STATE_SWEEP_BATCH_SIZE);
		await Promise.all(expiredTextInputs.map((textInput) => ctx.db.delete("files_pending_update_text_inputs", textInput._id)));
		deletedCount += expiredTextInputs.length;
		sawFullBatch ||= expiredTextInputs.length === PENDING_STATE_SWEEP_BATCH_SIZE;

		// Expired trusted-update stages (pending Accept / public fill / snapshot restore).
		const expiredTrustedStages = await ctx.db
			.query("files_yjs_trusted_update_stages")
			.withIndex("by_expiresAt", (q) => q.lte("expiresAt", now))
			.take(PENDING_STATE_SWEEP_BATCH_SIZE);
		await Promise.all(expiredTrustedStages.map((stage) => ctx.db.delete("files_yjs_trusted_update_stages", stage._id)));
		deletedCount += expiredTrustedStages.length;
		sawFullBatch ||= expiredTrustedStages.length === PENDING_STATE_SWEEP_BATCH_SIZE;

		// Drain retired-state cleanup tasks. The drain must tolerate a task whose states another
		// path (user finalize, data deletion) already removed, and still delete the task doc —
		// otherwise the task would sit forever as a false signal of pending work.
		const cleanupTasks = await ctx.db
			.query("files_pending_update_state_cleanup_tasks")
			.take(PENDING_STATE_SWEEP_BATCH_SIZE);
		for (const cleanupTask of cleanupTasks) {
			const retiredStates = await ctx.db
				.query("files_pending_update_yjs_states")
				.withIndex("by_owner_cleanupTask", (q) => q.eq("owner.cleanupTaskId", cleanupTask._id))
				.take(PENDING_STATE_SWEEP_BATCH_SIZE);
			for (const state of retiredStates) {
				await deleteStateFamily(state._id);
			}
			// Keep the task while it may still own more states than this bounded pass read.
			if (retiredStates.length === PENDING_STATE_SWEEP_BATCH_SIZE) {
				sawFullBatch = true;
				continue;
			}
			await ctx.db.delete("files_pending_update_state_cleanup_tasks", cleanupTask._id);
			deletedCount += 1;
		}
		sawFullBatch ||= cleanupTasks.length === PENDING_STATE_SWEEP_BATCH_SIZE;

		const done = !sawFullBatch;
		if (!done && !args._test_disableReschedule) {
			await ctx.scheduler.runAfter(0, internal.files_pending_updates.cleanup_expired_pending_state_rows, {
				_test_now: args._test_now,
			});
		}

		return { deletedCount, done };
	},
});

/**
 * Settle a no-change content write: the branch texts match their base, so nothing new is
 * proposed. A doc under a move proposal degrades to move-only; any other doc is deleted. The
 * operation batch is always consumed. `expectedUpdatedAt` guards the race where the doc changed
 * after the action read it — a newer proposal must never be destroyed by a stale no-change.
 */
export const settle_file_pending_update_no_change_in_db = internalMutation({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		nodeId: v.id("files_nodes"),
		operationBatchId: v.id("files_pending_update_operation_batches"),
		pendingUpdateId: v.optional(v.id("files_pending_updates")),
		expectedUpdatedAt: v.optional(v.number()),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const file = await ctx.db.get("files_nodes", args.nodeId);
		if (
			!file ||
			file.organizationId !== args.organizationId ||
			file.workspaceId !== args.workspaceId ||
			!files_node_has_editable_yjs_state(file)
		) {
			return Result({ _nay: { message: "Not found" } });
		}
		if (
			!(await access_control_db_can_act_on_file_node(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				userId: args.userId,
				fileNode: file,
				permission: "content.write",
			}))
		) {
			return Result({ _nay: { message: "Permission denied" } });
		}
		const writable = files_node_require_writable(file);
		if (writable._nay) {
			return writable;
		}

		// Consume the batch either way: this call ends the operation.
		await files_db_expire_pending_update_operation_batch(ctx, { operationBatchId: args.operationBatchId });

		const pendingUpdate = await files_db_get_pending_update(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			nodeId: args.nodeId,
			pendingUpdateId: args.pendingUpdateId,
		});
		if (!pendingUpdate) {
			return Result({ _yay: null });
		}
		if (args.pendingUpdateId != null && pendingUpdate._id !== args.pendingUpdateId) {
			return Result({ _yay: null });
		}
		if (args.expectedUpdatedAt !== undefined && pendingUpdate.updatedAt !== args.expectedUpdatedAt) {
			return Result({ _yay: null });
		}

		if (pendingUpdate.pendingMove) {
			// Content collapsed back to base under a move proposal: degrade to a move-only doc,
			// keep the doc. Only docs that are neither eager-created nor replace-moves reach here,
			// so copiedFrom is stale provenance — clear it.
			const now = Date.now();
			await Promise.all([
				ctx.db.patch("files_pending_updates", pendingUpdate._id, {
					baseYjsSequence: undefined,
					baseLineageGeneration: undefined,
					baseStateId: undefined,
					stagedStateId: undefined,
					unstagedStateId: undefined,
					copiedFrom: undefined,
					size: 0,
					updatedAt: now,
				}),
				files_db_retire_pending_update_yjs_states(ctx, {
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					pendingUpdateId: pendingUpdate._id,
				}),
				files_pending_update_db_delete_chunks(ctx, {
					pendingUpdateId: pendingUpdate._id,
				}),
				files_db_schedule_pending_update_cleanup(ctx, {
					pendingUpdateId: pendingUpdate._id,
					expectedUpdatedAt: now,
				}),
			]);

			return Result({ _yay: null });
		}

		await Promise.all([
			files_db_cancel_pending_update_cleanup_tasks(ctx, {
				pendingUpdateId: pendingUpdate._id,
			}),
			files_db_retire_pending_update_yjs_states(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				pendingUpdateId: pendingUpdate._id,
			}),
			files_pending_update_db_delete_chunks(ctx, {
				pendingUpdateId: pendingUpdate._id,
			}),
			ctx.db.delete("files_pending_updates", pendingUpdate._id),
		]);

		return Result({ _yay: null });
	},
});

export type settle_file_pending_update_no_change_in_db_Result =
	typeof settle_file_pending_update_no_change_in_db extends RegisteredMutation<
		infer _Visibility,
		infer _Args,
		infer ReturnValue
	>
		? Awaited<ReturnValue>
		: never;

/**
 * Same-bytes refresh: the new branches byte-match the stored canonical family, so only the
 * doc's 4h lifetime (and the contributor set) refreshes. The operation batch is consumed.
 */
export const refresh_file_pending_update_in_db = internalMutation({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		nodeId: v.id("files_nodes"),
		operationBatchId: v.id("files_pending_update_operation_batches"),
		pendingUpdateId: v.id("files_pending_updates"),
		expectedUpdatedAt: v.number(),
		threadId: v.optional(v.id("ai_chat_threads")),
	},
	returns: v_result({
		_yay: v.object({
			pendingUpdate: v.union(doc(app_convex_schema, "files_pending_updates"), v.null()),
		}),
	}),
	handler: async (ctx, args) => {
		const file = await ctx.db.get("files_nodes", args.nodeId);
		if (
			!file ||
			file.organizationId !== args.organizationId ||
			file.workspaceId !== args.workspaceId ||
			!files_node_has_editable_yjs_state(file)
		) {
			return Result({ _nay: { message: "Not found" } });
		}
		if (
			!(await access_control_db_can_act_on_file_node(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				userId: args.userId,
				fileNode: file,
				permission: "content.write",
			}))
		) {
			return Result({ _nay: { message: "Permission denied" } });
		}
		const writable = files_node_require_writable(file);
		if (writable._nay) {
			return writable;
		}

		await files_db_expire_pending_update_operation_batch(ctx, { operationBatchId: args.operationBatchId });

		const pendingUpdate = await ctx.db.get("files_pending_updates", args.pendingUpdateId);
		if (
			!pendingUpdate ||
			pendingUpdate.organizationId !== args.organizationId ||
			pendingUpdate.workspaceId !== args.workspaceId ||
			pendingUpdate.userId !== args.userId ||
			pendingUpdate.updatedAt !== args.expectedUpdatedAt
		) {
			return Result({ _yay: { pendingUpdate: null } });
		}

		// Same-bytes rewrites still count as activity: refresh the doc's 4h lifetime, or the
		// cleanup task scheduled for the old updatedAt expires the untouched proposal. An identical
		// re-write from another chat still means that chat touched the file.
		const nextThreadIds =
			args.threadId && !pendingUpdate.threadIds?.includes(args.threadId)
				? [...(pendingUpdate.threadIds ?? []), args.threadId]
				: undefined;
		const now = Date.now();
		await Promise.all([
			ctx.db.patch("files_pending_updates", pendingUpdate._id, {
				...(nextThreadIds ? { threadIds: nextThreadIds } : {}),
				updatedAt: now,
			}),
			files_db_schedule_pending_update_cleanup(ctx, {
				pendingUpdateId: pendingUpdate._id,
				expectedUpdatedAt: now,
			}),
		]);

		return Result({
			_yay: {
				pendingUpdate: { ...pendingUpdate, ...(nextThreadIds ? { threadIds: nextThreadIds } : {}), updatedAt: now },
			},
		});
	},
});

export type refresh_file_pending_update_in_db_Result =
	typeof refresh_file_pending_update_in_db extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * Validate the batch-owned sealed states an action is about to commit. The commit never reloads
 * pages; the sealed metadata (digest, generation) is the contract, and the seal mutation is the
 * only writer that can have produced it.
 */
async function db_validate_batch_states_for_commit(
	ctx: MutationCtx,
	args: {
		batch: app_convex_Doc<"files_pending_update_operation_batches">;
		phase: "input" | "output";
		baseLineageGeneration: number;
		states: Array<{
			role: "base" | "staged" | "unstaged";
			stateId: Id<"files_pending_update_yjs_states">;
			digest: string;
		}>;
	},
) {
	for (const expected of args.states) {
		const state = await ctx.db.get("files_pending_update_yjs_states", expected.stateId);
		if (
			!state ||
			state.owner.kind !== "temporary" ||
			state.owner.operationBatchId !== args.batch._id ||
			state.owner.phase !== args.phase ||
			state.owner.role !== expected.role ||
			!state.sealed ||
			state.digest !== expected.digest ||
			state.lineageGeneration !== args.baseLineageGeneration
		) {
			return Result({ _nay: { message: "Not found" } });
		}
	}

	return Result({ _yay: null });
}

/**
 * The atomic canonical swap: retire the doc's previous state families to a durable cleanup
 * task, re-own the three sealed batch states as the doc's active canonical family, and consume
 * the batch with its text inputs. Metadata-only writes — no page is loaded or deleted here.
 */
async function db_swap_canonical_states_and_consume_batch(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		pendingUpdateId: Id<"files_pending_updates">;
		batch: app_convex_Doc<"files_pending_update_operation_batches">;
		baseStateId: Id<"files_pending_update_yjs_states">;
		stagedStateId: Id<"files_pending_update_yjs_states">;
		unstagedStateId: Id<"files_pending_update_yjs_states">;
	},
) {
	// Retire the old family FIRST: the retire helper finds it through the owner index, and the
	// new states join that index the moment they are re-owned below.
	await files_db_retire_pending_update_yjs_states(ctx, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		pendingUpdateId: args.pendingUpdateId,
	});

	const ownStates: Array<[Id<"files_pending_update_yjs_states">, "base" | "staged" | "unstaged"]> = [
		[args.baseStateId, "base"],
		[args.stagedStateId, "staged"],
		[args.unstagedStateId, "unstaged"],
	];
	const textInputs = await ctx.db
		.query("files_pending_update_text_inputs")
		.withIndex("by_operationBatch", (q) => q.eq("operationBatchId", args.batch._id))
		.collect();
	await Promise.all([
		...ownStates.map(([stateId, role]) =>
			ctx.db.patch("files_pending_update_yjs_states", stateId, {
				owner: { kind: "active", pendingUpdateId: args.pendingUpdateId, role },
			}),
		),
		...textInputs.map((textInput) => ctx.db.delete("files_pending_update_text_inputs", textInput._id)),
		ctx.db.delete("files_pending_update_operation_batches", args.batch._id),
	]);
}

/**
 * The upsert flow's final commit. Receives sealed output state ids/scalars plus the one bounded
 * `unstagedText`; rechecks ownership, generation, and the doc's identity; then inserts or
 * patches the doc, swaps the canonical family, consumes the batch, and rebuilds pending chunks.
 */
export const commit_file_pending_update_upsert_in_db = internalMutation({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		nodeId: v.id("files_nodes"),
		operationBatchId: v.id("files_pending_update_operation_batches"),
		pendingUpdateId: v.optional(v.id("files_pending_updates")),
		/** `null` means the action saw no doc; a number is the read doc's `updatedAt` race guard. */
		expectedUpdatedAt: v.union(v.number(), v.null()),
		baseYjsSequence: v.number(),
		baseLineageGeneration: v.number(),
		/** Source file ids found before the action builds this replace proposal. */
		expectedSourceNodeIds: v.array(v.id("files_nodes")),
		baseStateId: v.id("files_pending_update_yjs_states"),
		stagedStateId: v.id("files_pending_update_yjs_states"),
		unstagedStateId: v.id("files_pending_update_yjs_states"),
		baseStateDigest: v.string(),
		stagedStateDigest: v.string(),
		unstagedStateDigest: v.string(),
		unstagedText: v.string(),
		unstagedBranchChanged: v.boolean(),
		copiedFrom: v.optional(
			v.object({ nodeId: v.id("files_nodes"), path: v.string(), archivesSourceOnAccept: v.optional(v.boolean()) }),
		),
		/**
		 * The committed last sequence captured by the mutation that eagerly created the node for
		 * this proposal (write_file/cp on a new path). Internal-only: never expose it to clients,
		 * or a caller could forge a stamp that lets discard/expiry hard-delete a real file.
		 */
		eagerCreatedCommittedSequence: v.optional(v.number()),
		/** Parent folders created with the file, deepest first. */
		eagerCreatedAncestorIds: v.optional(v.array(v.id("files_nodes"))),
		/** Chat thread making this write; appended (deduped) to the doc's contributor set. */
		threadId: v.optional(v.id("ai_chat_threads")),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const file = await ctx.db.get("files_nodes", args.nodeId);
		if (
			!file ||
			file.organizationId !== args.organizationId ||
			file.workspaceId !== args.workspaceId ||
			!files_node_has_editable_yjs_state(file)
		) {
			return Result({ _nay: { message: "Not found" } });
		}

		// The node question, asked in the transaction that writes: without it a read-only sharee
		// could stage a change on a restricted file and only be refused at accept, hours later.
		if (
			!(await access_control_db_can_act_on_file_node(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				userId: args.userId,
				fileNode: file,
				permission: "content.write",
			}))
		) {
			return Result({ _nay: { message: "Permission denied" } });
		}

		// Check the lock again in this final write. Old lock history does not matter.
		const nodeWritable = files_node_require_writable(file);
		if (nodeWritable._nay) {
			return nodeWritable;
		}

		if (args.copiedFrom?.archivesSourceOnAccept) {
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
				return Result({ _nay: { message: "Permission denied" } });
			}
			const currentSourceChain = await files_pending_update_db_collect_replace_source_chain(ctx, {
				membership,
				copiedFrom: args.copiedFrom,
				userId: args.userId,
			});
			if (currentSourceChain._nay) {
				return currentSourceChain;
			}
			const currentSourceNodeIds = currentSourceChain._yay.chain.map((sourceNode) => sourceNode._id);
			if (
				currentSourceNodeIds.length !== args.expectedSourceNodeIds.length ||
				currentSourceNodeIds.some((sourceNodeId, index) => sourceNodeId !== args.expectedSourceNodeIds[index])
			) {
				return Result({ _nay: { message: "Pending update changed, retry the write" } });
			}
		} else if (args.expectedSourceNodeIds.length > 0) {
			return Result({ _nay: { message: "Pending update changed, retry the write" } });
		}

		// The one bounded text this commit carries; the branch states were capped at seal.
		if (files_get_utf8_byte_size(args.unstagedText) > files_MAX_TEXT_CONTENT_BYTES) {
			return Result({ _nay: { message: `Text content exceeds ${files_MAX_TEXT_CONTENT_BYTES}-byte limit` } });
		}

		// Frontmatter caps, before any write: the calling action retires the staged input batch
		// on this refusal, so nothing durable is left behind.
		const frontmatterRefusal = files_pending_update_check_frontmatter_caps({
			fileNode: file,
			unstagedText: args.unstagedText,
		});
		if (frontmatterRefusal) {
			return frontmatterRefusal;
		}

		// Refuse cross-class copies: cp and mv -f name their source node here, and a
		// Markdown source must not land in a plain text file or the reverse — the copied text
		// would be re-parsed under the wrong document shape. A bare string carries no class, so
		// this comparison only exists when `copiedFrom` is present; a source that disappeared
		// mid-action skips it (the content is already plain text either way).
		if (args.copiedFrom) {
			const copySourceNode = await ctx.db.get("files_nodes", args.copiedFrom.nodeId);
			if (
				copySourceNode &&
				copySourceNode.organizationId === args.organizationId &&
				copySourceNode.workspaceId === args.workspaceId &&
				files_node_has_editable_yjs_state(copySourceNode) &&
				files_node_has_editable_yjs_state(file) &&
				copySourceNode.yjsRootKind !== file.yjsRootKind
			) {
				const describe_class = (rootKind: "rich_text" | "plain_text") =>
					rootKind === "rich_text" ? "a Markdown (.md) file" : "a plain text file";
				return Result({
					_nay: {
						message: `File classes do not match: the source is ${describe_class(copySourceNode.yjsRootKind)} and the destination is ${describe_class(file.yjsRootKind)}. Copy Markdown into a .md path and plain text into a plain text path.`,
					},
				});
			}
		}

		const batch = await db_get_owned_operation_batch(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			operationBatchId: args.operationBatchId,
			now: Date.now(),
		});
		if (!batch || batch.fileNodeId !== args.nodeId) {
			return Result({ _nay: { message: "Not found" } });
		}

		// A lineage repair between the action's read and this commit makes the whole staged
		// operation stale: the outputs were built against a document that no longer exists.
		const lastSequenceDoc = file.yjsLastSequenceId
			? await ctx.db.get("files_yjs_docs_last_sequences", file.yjsLastSequenceId)
			: null;
		if (!lastSequenceDoc || lastSequenceDoc.lineageGeneration !== args.baseLineageGeneration) {
			return Result({ _nay: { message: PENDING_BASE_STALE_MESSAGE } });
		}

		const stateValidation = await db_validate_batch_states_for_commit(ctx, {
			batch,
			phase: "output",
			baseLineageGeneration: args.baseLineageGeneration,
			states: [
				{ role: "base", stateId: args.baseStateId, digest: args.baseStateDigest },
				{ role: "staged", stateId: args.stagedStateId, digest: args.stagedStateDigest },
				{ role: "unstaged", stateId: args.unstagedStateId, digest: args.unstagedStateDigest },
			],
		});
		if (stateValidation._nay) {
			return stateValidation;
		}

		const existingPendingUpdate = await files_db_get_pending_update(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			nodeId: args.nodeId,
			pendingUpdateId: args.pendingUpdateId,
		});
		// Only the exact doc state the action worked from: a doc that appeared, disappeared, or
		// changed since then would be clobbered by branches built on the old substrate.
		if (args.expectedUpdatedAt === null) {
			if (existingPendingUpdate) {
				return Result({ _nay: { message: "Pending update changed, retry the write" } });
			}
		} else if (
			!existingPendingUpdate ||
			(args.pendingUpdateId != null && existingPendingUpdate._id !== args.pendingUpdateId) ||
			existingPendingUpdate.updatedAt !== args.expectedUpdatedAt
		) {
			return Result({ _nay: { message: "Pending update changed, retry the write" } });
		}

		// The node can be archived between the action's read and this commit: a new doc on it
		// could never be saved, so reject before any write. An existing doc must stay editable
		// and discardable — docs legitimately survive on archived files.
		if (!existingPendingUpdate && file.archiveOperationId !== undefined) {
			return Result({ _nay: { message: "Not found" } });
		}

		// Stamp the eager create with the sequence the creator captured in the mutation that
		// created the node — never a read taken here. See the eager-create field docs.
		const eagerCreated: app_convex_Doc<"files_pending_updates">["eagerCreated"] =
			args.eagerCreatedCommittedSequence !== undefined
				? {
						committedSequence: args.eagerCreatedCommittedSequence,
						...(args.eagerCreatedAncestorIds !== undefined
							? { createdAncestorIds: args.eagerCreatedAncestorIds }
							: {}),
					}
				: undefined;

		// The newest structural intent wins: a replace-move archives its source on accept, so the
		// source's own stale pending move (mv a→b before mv -f b→c) must not survive it.
		if (args.copiedFrom?.archivesSourceOnAccept) {
			const sourcePendingUpdate = await files_db_get_pending_update(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				userId: args.userId,
				nodeId: args.copiedFrom.nodeId,
			});
			if (sourcePendingUpdate?.pendingMove) {
				await files_pending_update_db_settle_move_row(ctx, { pendingUpdate: sourcePendingUpdate });
			}
		}

		const now = Date.now();
		const unstagedSize = files_get_utf8_byte_size(args.unstagedText);
		// Contributor set: an agent write records its thread once per doc; client writes pass no
		// threadId and the patches below leave the field out, so the array survives them.
		const nextThreadIds =
			args.threadId && !existingPendingUpdate?.threadIds?.includes(args.threadId)
				? [...(existingPendingUpdate?.threadIds ?? []), args.threadId]
				: undefined;

		let pendingUpdateId: Id<"files_pending_updates">;
		if (!existingPendingUpdate) {
			pendingUpdateId = await ctx.db.insert("files_pending_updates", {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				userId: args.userId,
				fileNodeId: args.nodeId,
				baseYjsSequence: args.baseYjsSequence,
				baseLineageGeneration: args.baseLineageGeneration,
				baseStateId: args.baseStateId,
				stagedStateId: args.stagedStateId,
				unstagedStateId: args.unstagedStateId,
				...(args.copiedFrom ? { copiedFrom: args.copiedFrom } : {}),
				...(eagerCreated ? { eagerCreated } : {}),
				...(nextThreadIds ? { threadIds: nextThreadIds } : {}),
				size: unstagedSize,
				updatedAt: now,
			});
		} else {
			pendingUpdateId = existingPendingUpdate._id;
			await ctx.db.patch("files_pending_updates", pendingUpdateId, {
				baseYjsSequence: args.baseYjsSequence,
				baseLineageGeneration: args.baseLineageGeneration,
				baseStateId: args.baseStateId,
				stagedStateId: args.stagedStateId,
				unstagedStateId: args.unstagedStateId,
				// The newest structural intent wins: a later cp/mv -f re-records where the content
				// comes from (and whether accepting archives that source).
				...(args.copiedFrom ? { copiedFrom: args.copiedFrom } : {}),
				// Never overwrite an existing eagerCreated: its committedSequence stamp must stay immutable.
				...(eagerCreated && !existingPendingUpdate.eagerCreated ? { eagerCreated } : {}),
				...(nextThreadIds ? { threadIds: nextThreadIds } : {}),
				...(args.unstagedBranchChanged ? { size: unstagedSize } : {}),
				updatedAt: now,
			});
		}

		await db_swap_canonical_states_and_consume_batch(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			pendingUpdateId,
			batch,
			baseStateId: args.baseStateId,
			stagedStateId: args.stagedStateId,
			unstagedStateId: args.unstagedStateId,
		});
		await files_db_schedule_pending_update_cleanup(ctx, {
			pendingUpdateId,
			expectedUpdatedAt: now,
		});

		// Staged-only changes (e.g. Accept all) keep the unstaged content intact, so the existing
		// pending chunk docs and metadata docs stay correct and rebuilding them would be wasted writes.
		if (!existingPendingUpdate || args.unstagedBranchChanged) {
			const chunksReplaced = await files_pending_update_db_replace_chunks(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				userId: args.userId,
				nodeId: args.nodeId,
				pendingUpdateId,
				unstagedText: args.unstagedText,
			});
			files_pending_update_log_replace_chunks_nay(chunksReplaced, { pendingUpdateId, nodeId: args.nodeId });
		}

		return Result({ _yay: null });
	},
});

export type commit_file_pending_update_upsert_in_db_Result =
	typeof commit_file_pending_update_upsert_in_db extends RegisteredMutation<
		infer _Visibility,
		infer _Args,
		infer ReturnValue
	>
		? Awaited<ReturnValue>
		: never;

/**
 * The shared upsert flow behind the public and internal upsert actions. The texts were staged
 * one value per call under the batch; this action clones the proposal's existing branch family
 * (or the latest live state) and applies the bounded text edits to those clones — never a fresh
 * `Y.Doc` built from the text, which would break the live lineage the accept diff depends on —
 * then stages/seals the three outputs page by page and commits with ids/scalars plus only the
 * unstaged text.
 */
async function action_upsert_file_pending_update(
	ctx: ActionCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
		nodeId: Id<"files_nodes">;
		operationBatchId: Id<"files_pending_update_operation_batches">;
		pendingUpdateId?: Id<"files_pending_updates"> | undefined;
		/** The `updatedAt` the reviewing client decoded; see the review-anchor check below. */
		reviewedUpdatedAt?: number;
		copiedFrom?: app_convex_Doc<"files_pending_updates">["copiedFrom"];
		eagerCreatedCommittedSequence?: number;
		eagerCreatedAncestorIds?: Array<Id<"files_nodes">>;
		threadId?: Id<"ai_chat_threads">;
	},
) {
	const retireBatch = async () => {
		await ctx.runMutation(internal.files_pending_updates.retire_file_pending_update_operation_batch, {
			operationBatchId: args.operationBatchId,
		});
	};

	const data = (await ctx.runQuery(internal.files_pending_updates.get_data_for_pending_content_operation, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		userId: args.userId,
		nodeId: args.nodeId,
		operationBatchId: args.operationBatchId,
		pendingUpdateId: args.pendingUpdateId,
	})) as get_data_for_pending_content_operation_Result;
	if (!data) {
		return Result({ _nay: { message: "Not found" } });
	}
	if (!data.batch) {
		return Result({ _nay: { message: "Not found" } });
	}

	// Check the lock before loading Yjs state. The final write checks it again.
	const fileWritable = files_node_require_writable(data.fileNode);
	if (fileWritable._nay) {
		await retireBatch();
		return fileWritable;
	}

	let expectedSourceNodeIds: Array<Id<"files_nodes">> = [];
	if (args.copiedFrom?.archivesSourceOnAccept) {
		const sourcePreflight = (await ctx.runQuery(
			internal.files_pending_updates.preflight_replace_source_chain_writable,
			{
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				userId: args.userId,
				copiedFrom: args.copiedFrom,
			},
		)) as preflight_replace_source_chain_writable_Result;
		if (sourcePreflight._nay) {
			await retireBatch();
			return sourcePreflight;
		}
		expectedSourceNodeIds = sourcePreflight._yay.sourceNodeIds;
	}

	// Only the exact doc the caller targeted: a provided id that resolves to a doc with a
	// different id means a new proposal replaced it, and writing would overwrite the new
	// proposal's branches with the dead proposal's stale content. A dead id with no current doc
	// still falls through to the create path (the normal new-proposal flow).
	const existingPendingUpdate = data.existingPendingUpdate;
	if (args.pendingUpdateId != null && existingPendingUpdate && existingPendingUpdate._id !== args.pendingUpdateId) {
		await retireBatch();
		return Result({ _nay: { message: "Not found" } });
	}

	// Review-anchored writes (the sidebar Accept): the client decoded and showed the proposal at
	// exactly this `updatedAt`. If the doc changed since — the agent revised the proposal —
	// publishing the reviewed text would silently drop that revision, so refuse and let the
	// user review the new version. The commit gate re-checks this same read transactionally,
	// so together the two checks anchor the commit to exactly the reviewed version. Callers
	// that do not review (agent flows) omit the arg.
	if (
		args.reviewedUpdatedAt !== undefined &&
		(!existingPendingUpdate || existingPendingUpdate.updatedAt !== args.reviewedUpdatedAt)
	) {
		await retireBatch();
		return Result({ _nay: { message: "Pending changes were revised, review the latest version" } });
	}

	if (!data.textInputRoles.includes("unstaged")) {
		await retireBatch();
		return Result({ _nay: { message: "Pending update text is not staged" } });
	}
	const unstagedTextRow = (await ctx.runQuery(internal.files_pending_updates.get_file_pending_update_text_input_internal, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		userId: args.userId,
		operationBatchId: args.operationBatchId,
		role: "unstaged",
	})) as get_file_pending_update_text_input_internal_Result;
	const stagedTextRow = data.textInputRoles.includes("staged")
		? ((await ctx.runQuery(internal.files_pending_updates.get_file_pending_update_text_input_internal, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				userId: args.userId,
				operationBatchId: args.operationBatchId,
				role: "staged",
			})) as get_file_pending_update_text_input_internal_Result)
		: null;
	if (!unstagedTextRow) {
		await retireBatch();
		return Result({ _nay: { message: "Pending update text is not staged" } });
	}

	const rootKind = data.fileNode.yjsRootKind;

	// Substrate: the proposal's existing branch family when it lives on the current lineage
	// generation, otherwise a fresh clone family of the latest live state. A stale-generation
	// family (a repair replaced the document since) is unusable as a merge substrate, so the
	// newest write intent starts from the current live document and the commit retires the old
	// family. Move-only docs have no family and take the live branch too.
	const existingContent = existingPendingUpdate ? files_pending_update_content_of(existingPendingUpdate) : null;
	let baseYjsSequence: number;
	let baseYjsDoc: YDoc;
	let stagedBranchYjsDoc: YDoc;
	let unstagedBranchYjsDoc: YDoc;
	if (existingContent && existingContent.baseLineageGeneration === data.lineageGeneration) {
		const [baseBytes, stagedBytes, unstagedBytes] = await Promise.all([
			action_load_pending_state_bytes(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				userId: args.userId,
				stateId: existingContent.baseStateId,
			}),
			action_load_pending_state_bytes(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				userId: args.userId,
				stateId: existingContent.stagedStateId,
			}),
			action_load_pending_state_bytes(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				userId: args.userId,
				stateId: existingContent.unstagedStateId,
			}),
		]);
		if (baseBytes._nay || stagedBytes._nay || unstagedBytes._nay) {
			await retireBatch();
			return Result({ _nay: { message: "Not found" } });
		}
		baseYjsSequence = existingContent.baseYjsSequence;
		baseYjsDoc = files_yjs_doc_create_from_array_buffer_update(files_u8_to_array_buffer(baseBytes._yay));
		stagedBranchYjsDoc = files_yjs_doc_create_from_array_buffer_update(files_u8_to_array_buffer(stagedBytes._yay));
		unstagedBranchYjsDoc = files_yjs_doc_create_from_array_buffer_update(files_u8_to_array_buffer(unstagedBytes._yay));
	} else {
		const base = await files_pending_update_action_get_latest_file_yjs_state(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId: args.nodeId,
			targetSequence: data.lastSequence,
		});
		if (base._nay) {
			await retireBatch();
			return Result({ _nay: { message: base._nay.message } });
		}
		baseYjsSequence = base._yay.baseYjsSequence;
		baseYjsDoc = base._yay.baseYjsDoc;
		stagedBranchYjsDoc = files_yjs_doc_clone({ yjsDoc: baseYjsDoc });
		unstagedBranchYjsDoc = files_yjs_doc_clone({ yjsDoc: baseYjsDoc });
	}

	if (stagedTextRow) {
		const stagedBranchProjection = files_pending_update_workspace_text_to_branch({
			mut_yjsDoc: stagedBranchYjsDoc,
			text: stagedTextRow.text,
			rootKind,
		});
		if (stagedBranchProjection._nay) {
			// Log the cause and return a message-only `_nay`; a `cause` field would fail the
			// `v_result` returns validators this Result crosses.
			console.error("Failed to apply staged text to pending branch", {
				error: stagedBranchProjection._nay,
				nodeId: args.nodeId,
			});
			await retireBatch();
			return Result({ _nay: { message: "Failed to apply staged text to pending branch" } });
		}
	}

	const unstagedBranchProjection = files_pending_update_workspace_text_to_branch({
		mut_yjsDoc: unstagedBranchYjsDoc,
		text: unstagedTextRow.text,
		rootKind,
	});
	if (unstagedBranchProjection._nay) {
		// Log the cause and return a message-only `_nay`; a `cause` field would fail the
		// `v_result` returns validators this Result crosses.
		console.error("Failed to apply unstaged text to pending branch", {
			error: unstagedBranchProjection._nay,
			nodeId: args.nodeId,
		});
		await retireBatch();
		return Result({ _nay: { message: "Failed to apply unstaged text to pending branch" } });
	}
	// `false` means the branch already matched this text.
	const unstagedBranchChanged = unstagedBranchProjection._yay !== false;

	const [baseText, stagedText, unstagedText] = [
		files_yjs_doc_get_text({ yjsDoc: baseYjsDoc, rootKind }),
		files_yjs_doc_get_text({ yjsDoc: stagedBranchYjsDoc, rootKind }),
		files_yjs_doc_get_text({ yjsDoc: unstagedBranchYjsDoc, rootKind }),
	];
	if (baseText._nay || stagedText._nay || unstagedText._nay) {
		console.error("Failed to compare pending update branches with base", {
			error: baseText._nay ?? stagedText._nay ?? unstagedText._nay,
			nodeId: args.nodeId,
		});
		await retireBatch();
		return Result({ _nay: { message: "Failed to compare pending update branches with base" } });
	}

	// No-change docs normally delete/degrade, but two kinds must persist: eager-created docs
	// (empty write_file / empty-source copy) store base == staged == unstaged so the family
	// survives and the eager-created node stays discardable; `mv -f` replace-moves must exist to
	// accept, because accepting an identical-content replace still archives the source.
	const hasChanges = stagedText._yay !== baseText._yay || unstagedText._yay !== baseText._yay;
	if (
		!hasChanges &&
		!existingPendingUpdate?.eagerCreated &&
		args.eagerCreatedCommittedSequence === undefined &&
		!args.copiedFrom?.archivesSourceOnAccept &&
		!existingPendingUpdate?.copiedFrom?.archivesSourceOnAccept
	) {
		const settled = (await ctx.runMutation(internal.files_pending_updates.settle_file_pending_update_no_change_in_db, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			nodeId: args.nodeId,
			operationBatchId: args.operationBatchId,
			pendingUpdateId: existingPendingUpdate?._id,
			expectedUpdatedAt: existingPendingUpdate?.updatedAt,
		})) as settle_file_pending_update_no_change_in_db_Result;
		if (settled._nay) {
			await retireBatch();
		}
		return settled;
	}

	// Encode the three outputs. The seal re-checks the caps; refusing here first keeps the
	// oversized bytes out of the page tables entirely.
	const outputs = [
		{ role: "base" as const, update: files_pending_update_encode_yjs_state_update({ yjsDoc: baseYjsDoc }) },
		{ role: "staged" as const, update: files_pending_update_encode_yjs_state_update({ yjsDoc: stagedBranchYjsDoc }) },
		{
			role: "unstaged" as const,
			update: files_pending_update_encode_yjs_state_update({ yjsDoc: unstagedBranchYjsDoc }),
		},
	];
	for (const output of outputs) {
		if (output.update.byteLength > files_MAX_YJS_RECONSTRUCTED_STATE_BYTES) {
			await retireBatch();
			return Result({
				_nay: { message: `State exceeds ${files_MAX_YJS_RECONSTRUCTED_STATE_BYTES}-byte limit` },
			});
		}
	}

	// Same-bytes fast path: identical branches and already-recorded structural intent only
	// refresh the doc's lifetime (and contributor set) instead of rewriting the family.
	const existingCopiedFrom = existingPendingUpdate?.copiedFrom;
	const copiedFromAlreadyRecorded =
		args.copiedFrom === undefined ||
		(existingCopiedFrom != null &&
			existingCopiedFrom.nodeId === args.copiedFrom.nodeId &&
			existingCopiedFrom.path === args.copiedFrom.path &&
			(existingCopiedFrom.archivesSourceOnAccept ?? false) === (args.copiedFrom.archivesSourceOnAccept ?? false));
	const eagerCreatedAlreadyRecorded =
		args.eagerCreatedCommittedSequence === undefined || existingPendingUpdate?.eagerCreated !== undefined;
	const outputDigests = new Map(
		outputs.map((output) => [output.role, files_pending_update_yjs_state_digest(new Uint8Array(output.update))]),
	);
	const currentDigests = new Map(
		data.currentCanonicalStates.flatMap((stateDoc) =>
			stateDoc.owner.kind === "active" ? [[stateDoc.owner.role, stateDoc.digest] as const] : [],
		),
	);
	if (
		copiedFromAlreadyRecorded &&
		eagerCreatedAlreadyRecorded &&
		existingPendingUpdate &&
		existingContent &&
		existingContent.baseYjsSequence === baseYjsSequence &&
		existingContent.baseLineageGeneration === data.lineageGeneration &&
		outputDigests.get("base") === currentDigests.get("base") &&
		outputDigests.get("staged") === currentDigests.get("staged") &&
		outputDigests.get("unstaged") === currentDigests.get("unstaged")
	) {
		const refreshed = (await ctx.runMutation(internal.files_pending_updates.refresh_file_pending_update_in_db, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			nodeId: args.nodeId,
			operationBatchId: args.operationBatchId,
			pendingUpdateId: existingPendingUpdate._id,
			expectedUpdatedAt: existingPendingUpdate.updatedAt,
			threadId: args.threadId,
		})) as refresh_file_pending_update_in_db_Result;
		if (refreshed._nay) {
			await retireBatch();
		}
		return refreshed;
	}

	// Stage and seal the three outputs page by page, one bounded value per call.
	const sealedByRole = new Map<"base" | "staged" | "unstaged", { stateId: Id<"files_pending_update_yjs_states">; digest: string }>();
	let sealedLineageGeneration = data.lineageGeneration;
	for (const output of outputs) {
		const bytes = new Uint8Array(output.update);
		for (let pageIndex = 0; pageIndex * files_MAX_YJS_WIRE_BYTES < bytes.byteLength; pageIndex++) {
			const pageStart = pageIndex * files_MAX_YJS_WIRE_BYTES;
			const staged = (await ctx.runMutation(internal.files_pending_updates.stage_file_pending_update_state_page_internal, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				userId: args.userId,
				operationBatchId: args.operationBatchId,
				phase: "output",
				role: output.role,
				pageIndex,
				bytes: bytes.slice(pageStart, pageStart + files_MAX_YJS_WIRE_BYTES).buffer as ArrayBuffer,
			})) as stage_file_pending_update_state_page_internal_Result;
			if (staged._nay) {
				await retireBatch();
				return Result({ _nay: { message: staged._nay.message } });
			}
		}

		const sealed = (await ctx.runMutation(internal.files_pending_updates.seal_file_pending_update_state_internal, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			operationBatchId: args.operationBatchId,
			phase: "output",
			role: output.role,
			expectedTotalBytes: output.update.byteLength,
		})) as seal_file_pending_update_state_internal_Result;
		if (sealed._nay) {
			// The seal already retired the batch family on refusal.
			return Result({ _nay: { message: sealed._nay.message } });
		}
		sealedByRole.set(output.role, { stateId: sealed._yay.stateId, digest: sealed._yay.digest });
		sealedLineageGeneration = sealed._yay.lineageGeneration;
	}

	// A repair between preflight and seal moves the generation; the commit would refuse anyway,
	// so refuse here with the stale message instead of a confusing ownership error.
	if (sealedLineageGeneration !== data.lineageGeneration) {
		await retireBatch();
		return Result({ _nay: { message: PENDING_BASE_STALE_MESSAGE } });
	}

	const base = sealedByRole.get("base");
	const staged = sealedByRole.get("staged");
	const unstaged = sealedByRole.get("unstaged");
	if (!base || !staged || !unstaged) {
		await retireBatch();
		return Result({ _nay: { message: "Not found" } });
	}

	// A commit that throws (for example the frontmatter field cap) rolls its own writes back,
	// but the batch and the sealed output family live in already-committed mutations. Retire
	// them before rethrowing, or the abandoned batch would block this user/node until the TTL.
	let committed: commit_file_pending_update_upsert_in_db_Result;
	try {
		committed = (await ctx.runMutation(internal.files_pending_updates.commit_file_pending_update_upsert_in_db, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			nodeId: args.nodeId,
			operationBatchId: args.operationBatchId,
			pendingUpdateId: existingPendingUpdate?._id,
			expectedUpdatedAt: existingPendingUpdate?.updatedAt ?? null,
			baseYjsSequence,
			baseLineageGeneration: data.lineageGeneration,
			expectedSourceNodeIds,
			baseStateId: base.stateId,
			stagedStateId: staged.stateId,
			unstagedStateId: unstaged.stateId,
			baseStateDigest: base.digest,
			stagedStateDigest: staged.digest,
			unstagedStateDigest: unstaged.digest,
			unstagedText: unstagedText._yay,
			unstagedBranchChanged,
			copiedFrom: args.copiedFrom,
			eagerCreatedCommittedSequence: args.eagerCreatedCommittedSequence,
			eagerCreatedAncestorIds: args.eagerCreatedAncestorIds,
			threadId: args.threadId,
		})) as commit_file_pending_update_upsert_in_db_Result;
	} catch (error) {
		await retireBatch();
		throw error;
	}
	// A commit refusal ends this operation too: without the retire, the surviving batch would
	// refuse this user/node's next operation ("already in progress") until the TTL.
	if (committed._nay) {
		await retireBatch();
	}

	return committed;
}

export const upsert_file_pending_update = action({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
		operationBatchId: v.id("files_pending_update_operation_batches"),
		pendingUpdateId: v.optional(v.id("files_pending_updates")),
		/**
		 * The `updatedAt` of the proposal version the user reviewed before this write. When set,
		 * the upsert refuses if the proposal was revised after that read, so an Accept can never
		 * silently publish over a revision the user did not see. Callers that do not review
		 * (agent flows) omit it.
		 */
		reviewedUpdatedAt: v.optional(v.number()),
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

		// No rate limit here: batch creation and every staging call already counted against the
		// same limit, so counting the finishing action too would cut the real write budget.
		const allowed = await ctx.runQuery(api.files_nodes.get_current_user_file_write_permission, {
			membershipId: args.membershipId,
			nodeId: args.nodeId,
		});
		if (!allowed) {
			return Result({ _nay: { message: "Permission denied" } });
		}

		const upserted = await action_upsert_file_pending_update(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: userAuth.id,
			nodeId: args.nodeId,
			operationBatchId: args.operationBatchId,
			pendingUpdateId: args.pendingUpdateId,
			reviewedUpdatedAt: args.reviewedUpdatedAt,
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
		/**
		 * The batch this write staged its `stagedText`/`unstagedText` under (one value per call,
		 * via the internal batch/text staging mutations), so this registered call never carries
		 * two large values.
		 */
		operationBatchId: v.id("files_pending_update_operation_batches"),
		pendingUpdateId: v.optional(v.id("files_pending_updates")),
		copiedFrom: v.optional(
			v.object({ nodeId: v.id("files_nodes"), path: v.string(), archivesSourceOnAccept: v.optional(v.boolean()) }),
		),
		/**
		 * The committed last sequence captured by the mutation that eagerly created the node for
		 * this proposal (write_file/cp on a new path). Internal-only: never expose it to clients,
		 * or a caller could forge a stamp that lets discard/expiry hard-delete a real file.
		 */
		eagerCreatedCommittedSequence: v.optional(v.number()),
		/** Parent folders created with the file, deepest first. */
		eagerCreatedAncestorIds: v.optional(v.array(v.id("files_nodes"))),
		/** Chat thread making this write; appended (deduped) to the doc's contributor set. */
		threadId: v.optional(v.id("ai_chat_threads")),
	},
	returns: v_result({
		_yay: v.null(),
	}),
	handler: async (ctx, args) => {
		const upserted = await action_upsert_file_pending_update(ctx, args);
		if (upserted._nay) {
			return Result({ _nay: upserted._nay });
		}

		return Result({ _yay: null });
	},
});

export type upsert_file_pending_update_internal_action_Result =
	typeof upsert_file_pending_update_internal_action extends RegisteredAction<
		infer _Visibility,
		infer _Args,
		infer ReturnValue
	>
		? Awaited<ReturnValue>
		: never;

export const upsert_file_pending_move_in_db = internalMutation({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		nodeId: v.id("files_nodes"),
		destParentId: v.union(v.id("files_nodes"), v.literal(files_ROOT_ID)),
		destName: v.string(),
		/**
		 * Allow a replace proposal when an active occupant owns the destination — file-onto-file
		 * (`mv -f`), or folder-onto-EMPTY-folder (rename() semantics, no -f needed, so folder
		 * moves always send it).
		 */
		replace: v.optional(v.boolean()),
		/** Chat thread making this write; appended (deduped) to the doc's contributor set. */
		threadId: v.optional(v.id("ai_chat_threads")),
	},
	returns: v_result({
		_yay: v.object({
			fromPath: v.string(),
			destPath: v.string(),
			replacesExistingOccupant: v.boolean(),
			/** True when the mv targeted the node's committed path and only cancelled its pending move. */
			cancelledExistingMove: v.boolean(),
		}),
	}),
	handler: async (ctx, args) => {
		const sourceNode = await ctx.db.get("files_nodes", args.nodeId);
		if (
			!sourceNode ||
			sourceNode.organizationId !== args.organizationId ||
			sourceNode.workspaceId !== args.workspaceId ||
			sourceNode.archiveOperationId !== undefined
		) {
			return Result({ _nay: { message: "Not found" } });
		}

		// The caller proved workspace write. Ask the restricted source node in this transaction before
		// cancelling, inserting, or patching a pending move.
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
			return Result({ _nay: { message: "Permission denied" } });
		}

		const authorized = await access_control_db_authorize_node(ctx, {
			userAuth: { id: args.userId },
			membership,
			nodeId: args.nodeId,
			permission: "content.write",
		});
		if (authorized._nay) {
			return Result({ _nay: { message: "Permission denied" } });
		}

		// mv back to the committed source path cancels the pending move instead of failing
		// the "Source and destination are the same" validation.
		let destParentPath: string | null = "/";
		if (args.destParentId !== files_ROOT_ID) {
			const destParent = await ctx.db.get("files_nodes", args.destParentId);
			destParentPath =
				destParent && destParent.organizationId === args.organizationId && destParent.workspaceId === args.workspaceId
					? destParent.path
					: null;
		}
		if (destParentPath != null && path_join(destParentPath, args.destName) === sourceNode.path) {
			const pendingUpdateToCancel = await files_db_get_pending_update(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				userId: args.userId,
				nodeId: args.nodeId,
			});
			if (pendingUpdateToCancel?.pendingMove) {
				await files_pending_update_db_settle_move_row(ctx, { pendingUpdate: pendingUpdateToCancel });
				return Result({
					_yay: {
						fromPath: sourceNode.path,
						destPath: sourceNode.path,
						replacesExistingOccupant: false,
						cancelledExistingMove: true,
					},
				});
			}
		}

		// A move changes the source, its descendants, and the destination folder.
		// Require all of them to be writable when creating the proposal.
		// Canceling an old move stays allowed because it only removes this user's pending proposal.
		const sourceWritable = files_node_require_writable(sourceNode);
		if (sourceWritable._nay) {
			return sourceWritable;
		}
		const subtreeWritable = await files_nodes_db_require_subtree_writable(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			node: sourceNode,
		});
		if (subtreeWritable._nay) {
			return subtreeWritable;
		}

		const destReadOnlyScopeNodeId = await files_nodes_db_resolve_parent_read_only_scope(ctx, {
			parentId: args.destParentId,
		});
		const destWritable = files_node_require_writable({ readOnlyScopeNodeId: destReadOnlyScopeNodeId });
		if (destWritable._nay) {
			return destWritable;
		}

		// Proposal-time validation runs against the proposer's visible tree: a sibling with a
		// pending move away does not conflict, and two proposals cannot claim one visible path.
		const validated = await files_nodes_db_validate_pending_move_target_for_proposal(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId: args.nodeId,
			destParentId: args.destParentId,
			destName: args.destName,
			replaceTarget: args.replace ? "any-active-occupant" : undefined,
			userId: args.userId,
		});
		if (validated._nay) {
			return validated;
		}
		const { node, destPath, replacesNode } = validated._yay;

		// Accepting a replace move archives the old destination and its descendants.
		// Refuse the proposal if any of those nodes is read-only.
		if (replacesNode) {
			const occupantWritable = files_node_require_writable(replacesNode);
			if (occupantWritable._nay) {
				return occupantWritable;
			}
			const occupantSubtreeWritable = await files_nodes_db_require_subtree_writable(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				userId: args.userId,
				node: replacesNode,
			});
			if (occupantSubtreeWritable._nay) {
				return occupantSubtreeWritable;
			}
		}

		const existingPendingUpdate = await files_db_get_pending_update(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			nodeId: args.nodeId,
		});

		const now = Date.now();
		const pendingMove = {
			destParentId: args.destParentId,
			destName: args.destName,
			fromPath: node.path,
			...(replacesNode ? { replacesNodeId: replacesNode._id } : {}),
		};
		// Contributor set: an agent mv records its thread once per doc; client moves pass no threadId.
		const nextThreadIds =
			args.threadId && !existingPendingUpdate?.threadIds?.includes(args.threadId)
				? [...(existingPendingUpdate?.threadIds ?? []), args.threadId]
				: undefined;
		if (!existingPendingUpdate) {
			const pendingUpdateId = await ctx.db.insert("files_pending_updates", {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				userId: args.userId,
				fileNodeId: args.nodeId,
				pendingMove,
				...(nextThreadIds ? { threadIds: nextThreadIds } : {}),
				size: 0,
				updatedAt: now,
			});
			await files_db_schedule_pending_update_cleanup(ctx, {
				pendingUpdateId,
				expectedUpdatedAt: now,
			});
		} else {
			// mv after write_file makes the doc content-plus-move; mv after mv replaces the proposal.
			await Promise.all([
				ctx.db.patch("files_pending_updates", existingPendingUpdate._id, {
					pendingMove,
					...(nextThreadIds ? { threadIds: nextThreadIds } : {}),
					updatedAt: now,
				}),
				files_db_schedule_pending_update_cleanup(ctx, {
					pendingUpdateId: existingPendingUpdate._id,
					expectedUpdatedAt: now,
				}),
			]);
		}

		return Result({
			_yay: {
				fromPath: node.path,
				destPath,
				replacesExistingOccupant: replacesNode != null,
				cancelledExistingMove: false,
			},
		});
	},
});

export type upsert_file_pending_move_in_db_Result =
	typeof upsert_file_pending_move_in_db extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

export const upsert_file_pending_archive_in_db = internalMutation({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		nodeId: v.id("files_nodes"),
		/** Chat thread making this write; appended (deduped) to the doc's contributor set. */
		threadId: v.optional(v.id("ai_chat_threads")),
	},
	returns: v_result({
		_yay: v.object({
			fromPath: v.string(),
			nodeKind: v.union(v.literal("file"), v.literal("folder")),
			/** "cancelled_added_file": the node was the user's own unaccepted eager create; it was hard-deleted, nothing pends. */
			outcome: v.union(v.literal("proposed"), v.literal("cancelled_added_file")),
		}),
	}),
	handler: async (ctx, args) => {
		const node = await ctx.db.get("files_nodes", args.nodeId);
		if (
			!node ||
			node.organizationId !== args.organizationId ||
			node.workspaceId !== args.workspaceId ||
			node.archiveOperationId !== undefined
		) {
			return Result({ _nay: { message: "Not found" } });
		}

		// The caller is an action, and the only thing it proved was workspace write at the chat
		// boundary. That says nothing about a restricted file: a read grant would be enough to reach
		// here and propose deleting somebody's file. Ask the node itself, in the transaction that
		// writes, the same way `create_file_node` and `create_folder_node_by_path` do.
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
			return Result({ _nay: { message: "Permission denied" } });
		}

		const authorized = await access_control_db_authorize_node(ctx, {
			userAuth: { id: args.userId },
			membership,
			nodeId: args.nodeId,
			permission: "content.write",
		});
		if (authorized._nay) {
			return Result({ _nay: { message: "Permission denied" } });
		}

		// Accepting a delete archives the node and all its descendants.
		// Require all of them to be writable before creating the proposal.
		// Run this before canceling an eager `rm`. Discard can still remove this user's pending proposal.
		const nodeWritable = files_node_require_writable(node);
		if (nodeWritable._nay) {
			return nodeWritable;
		}
		const subtreeWritable = await files_nodes_db_require_subtree_writable(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			node,
		});
		if (subtreeWritable._nay) {
			return subtreeWritable;
		}

		const existingPendingUpdate = await files_db_get_pending_update(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			nodeId: args.nodeId,
		});

		// rm on the user's own unaccepted Added file cancels it like Discard: the eager-created
		// node is hard-deleted when the safety gate passes. A gate failure (content committed,
		// another user's draft, ...) falls through to a normal delete proposal.
		if (existingPendingUpdate?.eagerCreated) {
			if (await files_pending_update_db_remove_eager_created_node_if_safe(ctx, { pendingUpdate: existingPendingUpdate })) {
				return Result({ _yay: { fromPath: node.path, nodeKind: node.kind, outcome: "cancelled_added_file" } });
			}
		}

		const now = Date.now();
		// Contributor set: an agent rm records its thread once per doc; client deletes pass no threadId.
		const nextThreadIds =
			args.threadId && !existingPendingUpdate?.threadIds?.includes(args.threadId)
				? [...(existingPendingUpdate?.threadIds ?? []), args.threadId]
				: undefined;
		if (!existingPendingUpdate) {
			const pendingUpdateId = await ctx.db.insert("files_pending_updates", {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				userId: args.userId,
				fileNodeId: args.nodeId,
				pendingArchive: { fromPath: node.path },
				...(nextThreadIds ? { threadIds: nextThreadIds } : {}),
				size: 0,
				updatedAt: now,
			});
			await files_db_schedule_pending_update_cleanup(ctx, {
				pendingUpdateId,
				expectedUpdatedAt: now,
			});
		} else {
			// rm after mv replaces the move (a delete supersedes it); rm after write keeps the
			// content branches on the doc (ignored on accept, restored as a Modified row on discard).
			await Promise.all([
				ctx.db.patch("files_pending_updates", existingPendingUpdate._id, {
					pendingArchive: { fromPath: node.path },
					pendingMove: undefined,
					...(nextThreadIds ? { threadIds: nextThreadIds } : {}),
					updatedAt: now,
				}),
				files_db_schedule_pending_update_cleanup(ctx, {
					pendingUpdateId: existingPendingUpdate._id,
					expectedUpdatedAt: now,
				}),
			]);
		}

		return Result({ _yay: { fromPath: node.path, nodeKind: node.kind, outcome: "proposed" } });
	},
});

export type upsert_file_pending_archive_in_db_Result =
	typeof upsert_file_pending_archive_in_db extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

export const apply_file_pending_move = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
	},
	returns: v_result({
		_yay: v.null(),
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
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

		// Against the node, not the workspace: this applies a move to one file, so the file is what
		// decides. A restricted file is only movable by somebody the share list lets write it.
		const authorized = await access_control_db_authorize_node(ctx, {
			userAuth,
			membership,
			nodeId: args.nodeId,
			permission: "content.write",
		});
		if (authorized._nay) {
			return authorized;
		}

		const pendingUpdate = await files_db_get_pending_update(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: userAuth.id,
			nodeId: args.nodeId,
		});
		if (!pendingUpdate) {
			// A swap cycle accept settles the other members' docs too; the bulk accept
			// flow still calls accept for them, so a missing doc is a no-op success.
			return Result({ _yay: null });
		}
		if (!pendingUpdate.pendingMove) {
			// Bulk retries re-run the whole accept with a stale doc snapshot; a doc whose
			// move was already applied is a no-op success so the content step can proceed.
			return Result({ _yay: null });
		}

		// The destination decides too: dropping a file into a folder is a write to that folder, and at
		// the root it is a write to the workspace. `move_nodes` asks both legs; this applies the same
		// move, so without the second leg a grant on one folder would be enough to push a file into
		// somebody else's restricted folder, or out of one into the open tree.
		const destParentId = pendingUpdate.pendingMove.destParentId;
		const authorizedDestination =
			destParentId === files_ROOT_ID
				? await access_control_db_authorize_membership(ctx, {
						userAuth,
						membership,
						permission: "content.write",
					})
				: await access_control_db_authorize_node(ctx, {
						userAuth,
						membership,
						nodeId: destParentId,
						permission: "content.write",
					});
		if (authorizedDestination._nay) {
			return authorizedDestination;
		}

		// The third leg: a move that takes the node out of its restricted folder changes who can read
		// it, so it needs `manage` on that folder and not just write.
		const authorizedLeaving = await authorize_leaving_restricted_scope(ctx, {
			userAuth,
			membership,
			fileNode: authorized._yay.fileNode,
			destParentId,
		});
		if (authorizedLeaving._nay) {
			return authorizedLeaving;
		}

		const applied = await files_nodes_db_apply_pending_move(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			nodeId: args.nodeId,
			destParentId: pendingUpdate.pendingMove.destParentId,
			destName: pendingUpdate.pendingMove.destName,
			userId: userAuth.id,
			updatedBy: userAuth.id,
			// The same two questions asked above for the clicked node: the node being moved, and the
			// folder it lands in. A grant on one of them says nothing about the other.
			authorizeCycleMember: async ({ node, destParentId: memberDestParentId }) => {
				const authorizedMember = await access_control_db_authorize_node(ctx, {
					userAuth,
					membership,
					nodeId: node._id,
					permission: "content.write",
				});
				if (authorizedMember._nay) {
					return false;
				}

				const authorizedMemberDestination =
					memberDestParentId === files_ROOT_ID
						? await access_control_db_authorize_membership(ctx, {
								userAuth,
								membership,
								permission: "content.write",
							})
						: await access_control_db_authorize_node(ctx, {
								userAuth,
								membership,
								nodeId: memberDestParentId,
								permission: "content.write",
							});
				if (authorizedMemberDestination._nay) {
					return false;
				}

				// A cycle member leaves its restricted folder the same way the clicked node can, and it was
				// never named by the user, so it has to pass the same third leg.
				const authorizedMemberLeaving = await authorize_leaving_restricted_scope(ctx, {
					userAuth,
					membership,
					fileNode: node,
					destParentId: memberDestParentId,
				});
				return !authorizedMemberLeaving._nay;
			},
		});
		if (applied._nay) {
			// Leave the doc intact so the user can retry or discard after a conflict
			// (for example a folder occupying the destination path).
			return Result({ _nay: applied._nay });
		}

		await files_pending_update_db_settle_move_row(ctx, { pendingUpdate });
		// A swap cycle applies the other members' moves too: settle their docs the same way.
		for (const cycleMemberPendingUpdate of applied._yay.cycleMemberPendingUpdates) {
			await files_pending_update_db_settle_move_row(ctx, { pendingUpdate: cycleMemberPendingUpdate });
		}

		return Result({ _yay: null });
	},
});

export const apply_file_pending_archive = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
	},
	returns: v_result({
		_yay: v.null(),
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
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

		const authorized = await access_control_db_authorize_node(ctx, {
			userAuth,
			membership,
			nodeId: args.nodeId,
			permission: "content.write",
		});
		if (authorized._nay) {
			return authorized;
		}

		const pendingUpdate = await files_db_get_pending_update(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: userAuth.id,
			nodeId: args.nodeId,
		});
		if (!pendingUpdate?.pendingArchive) {
			// Already settled (another tab accepted or discarded it): a no-op success.
			return Result({ _yay: null });
		}

		const node = await ctx.db.get("files_nodes", args.nodeId);
		if (
			!node ||
			node.organizationId !== membership.organizationId ||
			node.workspaceId !== membership.workspaceId ||
			node.archiveOperationId !== undefined
		) {
			// The node is gone or already archived (e.g. the sidebar Archive action ran first):
			// nothing left to archive, so the whole proposal doc is dead — drop it.
			await Promise.all([
				files_db_cancel_pending_update_cleanup_tasks(ctx, {
					pendingUpdateId: pendingUpdate._id,
				}),
				files_db_retire_pending_update_yjs_states(ctx, {
					organizationId: membership.organizationId,
					workspaceId: membership.workspaceId,
					pendingUpdateId: pendingUpdate._id,
				}),
				files_pending_update_db_delete_chunks(ctx, {
					pendingUpdateId: pendingUpdate._id,
				}),
				ctx.db.delete("files_pending_updates", pendingUpdate._id),
			]);
			return Result({ _yay: null });
		}

		// Check the lock again when accepting. Keep the proposal if a new lock blocks the write.
		const nodeWritable = files_node_require_writable(node);
		if (nodeWritable._nay) {
			return nodeWritable;
		}

		// Load children again because the folder may have changed after the proposal.
		// Follow node ids so an older archived tree with the same path stays separate.
		const nodeIdsToArchive = [node._id];
		if (node.kind === "folder") {
			const descendantFileNodes = await files_nodes_db_collect_descendants(ctx, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				parentId: node._id,
			});
			const activeDescendants = descendantFileNodes.filter(
				(descendantFileNode) => descendantFileNode.archiveOperationId === undefined,
			);

			// Same rule as `archive_nodes`: the check above asked about this folder, and the sweep can
			// reach a restricted folder nested inside it that the caller was never given.
			if (
				!(await files_nodes_db_can_act_on_swept_nodes(ctx, {
					organizationId: membership.organizationId,
					workspaceId: membership.workspaceId,
					userId: userAuth.id,
					rootScopeNodeId: node.restrictedScopeNodeId,
					nodes: activeDescendants,
					permission: "content.write",
				}))
			) {
				return Result({ _nay: { message: "Permission denied" } });
			}

			// Access was checked above, so a read-only descendant can return the clear lock error.
			for (const descendantFileNode of activeDescendants) {
				const descendantWritable = files_node_require_writable(descendantFileNode);
				if (descendantWritable._nay) {
					return descendantWritable;
				}
			}

			// Do not hide a read-only archived descendant under this newly archived folder.
			// The user may not see that node, so return a general error if it blocks the write.
			const archivedDescendants = descendantFileNodes.filter(
				(descendantFileNode) => descendantFileNode.archiveOperationId !== undefined,
			);
			const archivedProtected = await files_nodes_db_require_swept_nodes_writable(ctx, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: userAuth.id,
				nodes: archivedDescendants,
			});
			if (archivedProtected._nay) {
				return archivedProtected;
			}

			for (const descendantFileNode of activeDescendants) {
				nodeIdsToArchive.push(descendantFileNode._id);
			}
		}

		// One operation id for the whole delete, so Unarchive restores it as one unit.
		await files_nodes_db_archive_nodes(ctx, {
			nodeIds: nodeIdsToArchive,
			updatedBy: userAuth.id,
			now: Date.now(),
		});

		// Remove the acting user's docs on the archived nodes (this delete row plus their own
		// now-dead rows on descendants). Other users' docs stay untouched; they go inert
		// through the archived-node filters, like any sidebar archive.
		for (const archivedNodeId of nodeIdsToArchive) {
			const archivedNodePendingUpdate =
				archivedNodeId === pendingUpdate.fileNodeId
					? pendingUpdate
					: await files_db_get_pending_update(ctx, {
							organizationId: membership.organizationId,
							workspaceId: membership.workspaceId,
							userId: userAuth.id,
							nodeId: archivedNodeId,
						});
			if (!archivedNodePendingUpdate) {
				continue;
			}
			await Promise.all([
				files_db_cancel_pending_update_cleanup_tasks(ctx, {
					pendingUpdateId: archivedNodePendingUpdate._id,
				}),
				files_db_retire_pending_update_yjs_states(ctx, {
					organizationId: membership.organizationId,
					workspaceId: membership.workspaceId,
					pendingUpdateId: archivedNodePendingUpdate._id,
				}),
				files_pending_update_db_delete_chunks(ctx, {
					pendingUpdateId: archivedNodePendingUpdate._id,
				}),
				ctx.db.delete("files_pending_updates", archivedNodePendingUpdate._id),
			]);
		}

		return Result({ _yay: null });
	},
});

export const discard_file_pending_structural = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
	},
	returns: v_result({
		_yay: v.null(),
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
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

		const pendingUpdate = await files_db_get_pending_update(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: userAuth.id,
			nodeId: args.nodeId,
		});

		// Throwing your own draft away hands nobody anything, so it does not need `content.write`.
		// Access can be taken away after the draft exists, and refusing then would leave that person
		// stuck looking at their own text on a file they may no longer edit until it expires hours
		// later, with no button that works. Only the permission half is waived: a node from another
		// workspace is still "Not found", and every branch below touches this caller's own doc.
		const authorized = await access_control_db_authorize_node(ctx, {
			userAuth,
			membership,
			nodeId: args.nodeId,
			permission: "content.write",
		});
		if (authorized._nay && !(pendingUpdate && authorized._nay.message === "Permission denied")) {
			return authorized;
		}

		if (!pendingUpdate) {
			// Already gone (another tab discarded or accepted it): a no-op success.
			return Result({ _yay: null });
		}

		if (pendingUpdate.pendingArchive) {
			// Discarding a delete never touches the node: clear the proposal; a doc that
			// still carries content degrades back to a Modified row.
			await files_pending_update_db_settle_archive_row(ctx, { pendingUpdate });
			return Result({ _yay: null });
		}

		if (pendingUpdate.copiedFrom || pendingUpdate.eagerCreated) {
			if (await files_pending_update_db_remove_eager_created_node_if_safe(ctx, { pendingUpdate })) {
				// Discarding an eager-create proposal removes the eager-created destination node
				// entirely; the hard delete subsumes this doc and its chunks.
				return Result({ _yay: null });
			}

			// The node is a real file (pre-existing replace target, committed content, or another
			// user's draft): drop only this proposal and keep the node.
			await Promise.all([
				files_db_cancel_pending_update_cleanup_tasks(ctx, {
					pendingUpdateId: pendingUpdate._id,
				}),
				files_db_retire_pending_update_yjs_states(ctx, {
					organizationId: membership.organizationId,
					workspaceId: membership.workspaceId,
					pendingUpdateId: pendingUpdate._id,
				}),
				files_pending_update_db_delete_chunks(ctx, {
					pendingUpdateId: pendingUpdate._id,
				}),
				ctx.db.delete("files_pending_updates", pendingUpdate._id),
			]);
			return Result({ _yay: null });
		}

		if (!pendingUpdate.pendingMove) {
			// No structural aspect left (a content-only doc): a no-op success.
			return Result({ _yay: null });
		}

		if (files_pending_update_content_of(pendingUpdate)) {
			// Content-plus-move doc: drop the move proposal, keep the content proposal.
			const now = Date.now();
			await Promise.all([
				ctx.db.patch("files_pending_updates", pendingUpdate._id, {
					pendingMove: undefined,
					updatedAt: now,
				}),
				files_db_schedule_pending_update_cleanup(ctx, {
					pendingUpdateId: pendingUpdate._id,
					expectedUpdatedAt: now,
				}),
			]);
		} else {
			await Promise.all([
				files_db_cancel_pending_update_cleanup_tasks(ctx, {
					pendingUpdateId: pendingUpdate._id,
				}),
				files_pending_update_db_delete_chunks(ctx, {
					pendingUpdateId: pendingUpdate._id,
				}),
				ctx.db.delete("files_pending_updates", pendingUpdate._id),
			]);
		}

		return Result({ _yay: null });
	},
});

export const discard_file_pending_content = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
		pendingUpdateId: v.id("files_pending_updates"),
	},
	returns: v_result({
		_yay: v.null(),
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "files_pending_update_write", key: userAuth.id });
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

		const pendingUpdate = await files_db_get_pending_update(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: userAuth.id,
			nodeId: args.nodeId,
			pendingUpdateId: args.pendingUpdateId,
		});

		// Let users discard their own draft after losing `content.write`. Keep the membership and node
		// checks, and require the exact pending-update id so a stale click cannot touch the doc that
		// replaced it.
		const authorized = await access_control_db_authorize_node(ctx, {
			userAuth,
			membership,
			nodeId: args.nodeId,
			permission: "content.write",
		});
		if (authorized._nay && !(pendingUpdate && authorized._nay.message === "Permission denied")) {
			return authorized;
		}

		if (!pendingUpdate) {
			return Result({ _yay: null });
		}
		if (pendingUpdate._id !== args.pendingUpdateId) {
			return Result({ _nay: { message: "Not found" } });
		}

		const content = files_pending_update_content_of(pendingUpdate);
		if (!content) {
			return Result({ _yay: null });
		}

		const fileNode = await ctx.db.get("files_nodes", args.nodeId);
		if (
			!fileNode ||
			fileNode.organizationId !== membership.organizationId ||
			fileNode.workspaceId !== membership.workspaceId ||
			!files_node_has_editable_yjs_state(fileNode)
		) {
			return Result({ _nay: { message: "Not found" } });
		}
		const rootKind = fileNode.yjsRootKind;

		// Discard only unstaged edits. Keep the staged branch so the user can still accept it
		// later: the unstaged family becomes a copy of the staged one.
		const [baseStateDoc, stagedStateDoc] = await Promise.all([
			ctx.db.get("files_pending_update_yjs_states", content.baseStateId),
			ctx.db.get("files_pending_update_yjs_states", content.stagedStateId),
		]);
		if (!baseStateDoc || !stagedStateDoc) {
			const errorMessage = "pendingUpdate content group points to a missing files_pending_update_yjs_states doc";
			const errorData = {
				nodeId: args.nodeId,
				pendingUpdateId: pendingUpdate._id,
				baseStateId: content.baseStateId,
				stagedStateId: content.stagedStateId,
			};
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}
		const [baseBytes, stagedBytes] = await Promise.all([
			files_db_load_pending_update_yjs_state_bytes(ctx, { stateDoc: baseStateDoc }),
			files_db_load_pending_update_yjs_state_bytes(ctx, { stateDoc: stagedStateDoc }),
		]);
		if (baseBytes._nay || stagedBytes._nay) {
			console.error("Failed to reconstruct pending states while discarding pending content", {
				error: baseBytes._nay ?? stagedBytes._nay,
				nodeId: args.nodeId,
				pendingUpdateId: pendingUpdate._id,
			});
			return Result({ _nay: { message: "Failed to discard pending content" } });
		}

		const baseYjsDoc = files_yjs_doc_create_from_array_buffer_update(files_u8_to_array_buffer(baseBytes._yay));
		const stagedBranchYjsDoc = files_yjs_doc_create_from_array_buffer_update(files_u8_to_array_buffer(stagedBytes._yay));
		const baseText = files_yjs_doc_get_text({ yjsDoc: baseYjsDoc, rootKind });
		const stagedText = files_yjs_doc_get_text({ yjsDoc: stagedBranchYjsDoc, rootKind });
		if (baseText._nay || stagedText._nay) {
			console.error("Failed to read pending branches while discarding pending content", {
				error: baseText._nay ?? stagedText._nay,
				nodeId: args.nodeId,
				pendingUpdateId: pendingUpdate._id,
			});
			return Result({ _nay: { message: "Failed to discard pending content" } });
		}

		// Reverting unstaged to staged can collapse the whole proposal back to base. The same
		// no-change rules as the upsert flow apply: eager-created docs and replace-moves persist.
		if (
			stagedText._yay === baseText._yay &&
			!pendingUpdate.eagerCreated &&
			!pendingUpdate.copiedFrom?.archivesSourceOnAccept
		) {
			if (pendingUpdate.pendingMove) {
				const now = Date.now();
				await Promise.all([
					ctx.db.patch("files_pending_updates", pendingUpdate._id, {
						baseYjsSequence: undefined,
						baseLineageGeneration: undefined,
						baseStateId: undefined,
						stagedStateId: undefined,
						unstagedStateId: undefined,
						copiedFrom: undefined,
						size: 0,
						updatedAt: now,
					}),
					files_db_retire_pending_update_yjs_states(ctx, {
						organizationId: membership.organizationId,
						workspaceId: membership.workspaceId,
						pendingUpdateId: pendingUpdate._id,
					}),
					files_pending_update_db_delete_chunks(ctx, {
						pendingUpdateId: pendingUpdate._id,
					}),
					files_db_schedule_pending_update_cleanup(ctx, {
						pendingUpdateId: pendingUpdate._id,
						expectedUpdatedAt: now,
					}),
				]);
				return Result({ _yay: null });
			}

			await Promise.all([
				files_db_cancel_pending_update_cleanup_tasks(ctx, {
					pendingUpdateId: pendingUpdate._id,
				}),
				files_db_retire_pending_update_yjs_states(ctx, {
					organizationId: membership.organizationId,
					workspaceId: membership.workspaceId,
					pendingUpdateId: pendingUpdate._id,
				}),
				files_pending_update_db_delete_chunks(ctx, {
					pendingUpdateId: pendingUpdate._id,
				}),
				ctx.db.delete("files_pending_updates", pendingUpdate._id),
			]);
			return Result({ _yay: null });
		}

		// Replace the unstaged family with a copy of the staged bytes (bounded by the sealed-state
		// cap) and retire the old unstaged family to a durable cleanup task.
		const now = Date.now();
		const newUnstagedStateId = await files_db_insert_pending_update_yjs_state(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: userAuth.id,
			fileNodeId: args.nodeId,
			pendingUpdateId: pendingUpdate._id,
			role: "unstaged",
			update: files_u8_to_array_buffer(stagedBytes._yay),
			lineageGeneration: content.baseLineageGeneration,
		});
		const cleanupTaskId = await ctx.db.insert("files_pending_update_state_cleanup_tasks", {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			createdAt: now,
		});
		await Promise.all([
			ctx.db.patch("files_pending_update_yjs_states", content.unstagedStateId, {
				owner: { kind: "retired", cleanupTaskId },
			}),
			ctx.db.patch("files_pending_updates", pendingUpdate._id, {
				unstagedStateId: newUnstagedStateId,
				size: files_get_utf8_byte_size(stagedText._yay),
				updatedAt: now,
			}),
			files_db_schedule_pending_update_cleanup(ctx, {
				pendingUpdateId: pendingUpdate._id,
				expectedUpdatedAt: now,
			}),
			ctx.scheduler.runAfter(0, internal.files_pending_updates.cleanup_expired_pending_state_rows, {}),
		]);
		const chunksReplaced = await files_pending_update_db_replace_chunks(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: userAuth.id,
			nodeId: args.nodeId,
			pendingUpdateId: pendingUpdate._id,
			unstagedText: stagedText._yay,
		});
		files_pending_update_log_replace_chunks_nay(chunksReplaced, {
			pendingUpdateId: pendingUpdate._id,
			nodeId: args.nodeId,
		});

		return Result({ _yay: null });
	},
});

/**
 * The rebase flow's final commit. The action validated and reconstructed everything in memory;
 * this mutation rechecks the doc's identity, the live sequence/generation, and the sealed input
 * states' ownership/digests, then atomically swaps the canonical family. Update-only: a missing
 * doc means the proposal was discarded or fully accepted while the operation was in flight.
 */
export const commit_file_pending_update_rebase_in_db = internalMutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
		pendingUpdateId: v.id("files_pending_updates"),
		operationBatchId: v.id("files_pending_update_operation_batches"),
		expectedUpdatedAt: v.number(),
		baseYjsSequence: v.number(),
		baseLineageGeneration: v.number(),
		baseStateId: v.id("files_pending_update_yjs_states"),
		stagedStateId: v.id("files_pending_update_yjs_states"),
		unstagedStateId: v.id("files_pending_update_yjs_states"),
		baseStateDigest: v.string(),
		stagedStateDigest: v.string(),
		unstagedStateDigest: v.string(),
		unstagedText: v.string(),
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

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "files_pending_update_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
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

		// Check the lock again in this final write.
		const nodeWritable = files_node_require_writable(authorized._yay.fileNode);
		if (nodeWritable._nay) {
			return nodeWritable;
		}

		// The one bounded text this commit carries; the branch states were capped at seal.
		if (files_get_utf8_byte_size(args.unstagedText) > files_MAX_TEXT_CONTENT_BYTES) {
			return Result({ _nay: { message: `Text content exceeds ${files_MAX_TEXT_CONTENT_BYTES}-byte limit` } });
		}

		const existingPendingUpdate = await files_db_get_pending_update(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: userAuth.id,
			nodeId: args.nodeId,
			pendingUpdateId: args.pendingUpdateId,
		});
		// Update-only, and only the exact doc the client synced: a missing doc means the
		// proposal was discarded or fully accepted while this sync was in flight; a doc with a
		// different id means a new proposal replaced it, and patching that doc would overwrite
		// it with the dead proposal's branches. Inserting would resurrect the dead proposal.
		if (!existingPendingUpdate || existingPendingUpdate._id !== args.pendingUpdateId) {
			return Result({ _nay: { message: "Not found" } });
		}

		// A revert in another tab can degrade the doc to move-only: patching the dead
		// content branches back would resurrect the reverted proposal.
		const existingContent = files_pending_update_content_of(existingPendingUpdate);
		if (!existingContent) {
			return Result({ _nay: { message: "Not found" } });
		}

		// Only the exact doc state the action worked from.
		if (existingPendingUpdate.updatedAt !== args.expectedUpdatedAt) {
			return Result({ _nay: { message: "Pending update changed, retry the write" } });
		}

		// The doc's base only advances to live sequences, so a captured base below it means
		// the sync inputs predate the doc's last save (e.g. another tab's save landing while
		// this sync was in flight). Reject before any write; the caller must re-read.
		if (args.baseYjsSequence < existingContent.baseYjsSequence) {
			return Result({ _nay: { message: "Stale save" } });
		}

		const fileNode = await ctx.db.get("files_nodes", args.nodeId);
		if (
			!fileNode ||
			fileNode.organizationId !== membership.organizationId ||
			fileNode.workspaceId !== membership.workspaceId ||
			!files_node_has_editable_yjs_state(fileNode)
		) {
			return Result({ _nay: { message: "Not found" } });
		}

		// Frontmatter caps, before any write: the calling action retires the staged input batch
		// on this refusal, so nothing durable is left behind.
		const frontmatterRefusal = files_pending_update_check_frontmatter_caps({
			fileNode,
			unstagedText: args.unstagedText,
		});
		if (frontmatterRefusal) {
			return frontmatterRefusal;
		}

		// The live document must still be exactly where the action read it: a commit or a
		// lineage repair that landed during the action makes the staged operation stale.
		const lastSequenceDoc = await ctx.db.get("files_yjs_docs_last_sequences", fileNode.yjsLastSequenceId);
		if (
			lastSequenceDoc?.lastSequence !== args.baseYjsSequence ||
			lastSequenceDoc.lineageGeneration !== args.baseLineageGeneration
		) {
			return Result({ _nay: { message: PENDING_BASE_STALE_MESSAGE } });
		}

		const batch = await db_get_owned_operation_batch(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: userAuth.id,
			operationBatchId: args.operationBatchId,
			now: Date.now(),
		});
		if (!batch || batch.fileNodeId !== args.nodeId) {
			return Result({ _nay: { message: "Not found" } });
		}

		const stateValidation = await db_validate_batch_states_for_commit(ctx, {
			batch,
			phase: "input",
			baseLineageGeneration: args.baseLineageGeneration,
			states: [
				{ role: "base", stateId: args.baseStateId, digest: args.baseStateDigest },
				{ role: "staged", stateId: args.stagedStateId, digest: args.stagedStateDigest },
				{ role: "unstaged", stateId: args.unstagedStateId, digest: args.unstagedStateDigest },
			],
		});
		if (stateValidation._nay) {
			return stateValidation;
		}

		const now = Date.now();
		await ctx.db.patch("files_pending_updates", existingPendingUpdate._id, {
			baseYjsSequence: args.baseYjsSequence,
			baseLineageGeneration: args.baseLineageGeneration,
			baseStateId: args.baseStateId,
			stagedStateId: args.stagedStateId,
			unstagedStateId: args.unstagedStateId,
			size: files_get_utf8_byte_size(args.unstagedText),
			updatedAt: now,
		});
		await db_swap_canonical_states_and_consume_batch(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			pendingUpdateId: existingPendingUpdate._id,
			batch,
			baseStateId: args.baseStateId,
			stagedStateId: args.stagedStateId,
			unstagedStateId: args.unstagedStateId,
		});
		// Refresh the expiry window from this latest doc version because rebasing changes the
		// authoritative pending snapshot.
		await files_db_schedule_pending_update_cleanup(ctx, {
			pendingUpdateId: existingPendingUpdate._id,
			expectedUpdatedAt: now,
		});

		// Rebase rewrites the unstaged branch, so always refresh pending chunk and metadata docs.
		const chunksReplaced = await files_pending_update_db_replace_chunks(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: userAuth.id,
			nodeId: args.nodeId,
			pendingUpdateId: existingPendingUpdate._id,
			unstagedText: args.unstagedText,
		});
		files_pending_update_log_replace_chunks_nay(chunksReplaced, {
			pendingUpdateId: existingPendingUpdate._id,
			nodeId: args.nodeId,
		});

		const nextPendingUpdate = await ctx.db.get("files_pending_updates", existingPendingUpdate._id);
		if (!nextPendingUpdate) {
			return Result({ _nay: { message: "Failed to read persisted rebased pending update doc" } });
		}

		return Result({
			_yay: {
				pendingUpdate: nextPendingUpdate,
			},
		});
	},
});

export type commit_file_pending_update_rebase_in_db_Result =
	typeof commit_file_pending_update_rebase_in_db extends RegisteredMutation<
		infer _Visibility,
		infer _Args,
		infer ReturnValue
	>
		? Awaited<ReturnValue>
		: never;

/**
 * The rebase flow's public entry. The client staged its three full branch states as pages under
 * an operation batch and sealed each role (the seal ran door 2); this action runs the cheap
 * permission/stale/not-found/batch/sequence/generation refusals, reassembles the sealed inputs
 * in memory, reconstructs the latest live base only through the frozen `baseYjsSequence`,
 * compares, and commits by metadata id. The sealed input states become the canonical family —
 * verbatim, preserving the live lineage they were built on. Rebuilding them as fresh `Y.Doc`s
 * from their text would duplicate text at the next accept's state-vector diff.
 */
export const persist_file_pending_update_rebased_state = action({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
		operationBatchId: v.id("files_pending_update_operation_batches"),
		pendingUpdateId: v.optional(v.id("files_pending_updates")),
		baseYjsSequence: v.number(),
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

		// No rate limit here. The commit mutation counts against the same limit, so counting
		// again would cut every user's real save budget in half. A refused caller costs us only the
		// permission query. An action cannot read the database, so that check goes through a query,
		// and it asks about this file, not the workspace, so a grant on a restricted folder still saves.
		const allowed = await ctx.runQuery(api.files_nodes.get_current_user_file_write_permission, {
			membershipId: args.membershipId,
			nodeId: args.nodeId,
		});
		if (!allowed) {
			return Result({ _nay: { message: "Permission denied" } });
		}

		const retireBatch = async () => {
			await ctx.runMutation(internal.files_pending_updates.retire_file_pending_update_operation_batch, {
				operationBatchId: args.operationBatchId,
			});
		};

		const data = (await ctx.runQuery(internal.files_pending_updates.get_data_for_pending_content_operation, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: userAuth.id,
			nodeId: args.nodeId,
			operationBatchId: args.operationBatchId,
			pendingUpdateId: args.pendingUpdateId,
		})) as get_data_for_pending_content_operation_Result;
		if (!data || !data.batch) {
			return Result({ _nay: { message: "Not found" } });
		}

		// Check the lock before loading Yjs state. The final write checks it again.
		const fileWritable = files_node_require_writable(data.fileNode);
		if (fileWritable._nay) {
			await retireBatch();
			return fileWritable;
		}

		// Every cheap refusal precedes any state decode: staleness first.
		if (data.lastSequence !== args.baseYjsSequence) {
			await retireBatch();
			return Result({ _nay: { message: PENDING_BASE_STALE_MESSAGE } });
		}

		// Update-only, and only the exact doc the client synced (see the commit mutation).
		const existingPendingUpdate = data.existingPendingUpdate;
		if (!existingPendingUpdate || (args.pendingUpdateId != null && existingPendingUpdate._id !== args.pendingUpdateId)) {
			await retireBatch();
			return Result({ _nay: { message: "Not found" } });
		}
		const existingContent = files_pending_update_content_of(existingPendingUpdate);
		if (!existingContent) {
			await retireBatch();
			return Result({ _nay: { message: "Not found" } });
		}
		if (args.baseYjsSequence < existingContent.baseYjsSequence) {
			await retireBatch();
			return Result({ _nay: { message: "Stale save" } });
		}

		// All three sealed input states must exist on the current lineage generation. The seal
		// already ran door 2 (whole-state bytes, per-`rootKind` shape, visible cap) per state.
		const inputByRole = new Map(
			data.inputStates.flatMap((stateDoc) =>
				stateDoc.owner.kind === "temporary" ? [[stateDoc.owner.role, stateDoc] as const] : [],
			),
		);
		const baseInput = inputByRole.get("base");
		const stagedInput = inputByRole.get("staged");
		const unstagedInput = inputByRole.get("unstaged");
		if (!baseInput?.sealed || !stagedInput?.sealed || !unstagedInput?.sealed) {
			await retireBatch();
			return Result({ _nay: { message: "Pending update states are not sealed" } });
		}
		if (
			baseInput.lineageGeneration !== data.lineageGeneration ||
			stagedInput.lineageGeneration !== data.lineageGeneration ||
			unstagedInput.lineageGeneration !== data.lineageGeneration
		) {
			await retireBatch();
			return Result({ _nay: { message: PENDING_BASE_STALE_MESSAGE } });
		}

		const [baseBytes, stagedBytes, unstagedBytes] = await Promise.all([
			action_load_pending_state_bytes(ctx, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: userAuth.id,
				stateId: baseInput._id,
			}),
			action_load_pending_state_bytes(ctx, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: userAuth.id,
				stateId: stagedInput._id,
			}),
			action_load_pending_state_bytes(ctx, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: userAuth.id,
				stateId: unstagedInput._id,
			}),
		]);
		if (baseBytes._nay || stagedBytes._nay || unstagedBytes._nay) {
			await retireBatch();
			return Result({ _nay: { message: "Not found" } });
		}

		// Reconstruct the latest live base only through the frozen sequence and require the
		// client's base to byte-match it: the branches were built on that exact state, so a
		// mismatch means the client must re-read before rebasing.
		const latestBase = await files_pending_update_action_get_latest_file_yjs_state(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			nodeId: args.nodeId,
			targetSequence: args.baseYjsSequence,
		});
		if (latestBase._nay) {
			await retireBatch();
			return Result({ _nay: { message: latestBase._nay.message } });
		}
		if (!files_u8_equals(baseBytes._yay, new Uint8Array(latestBase._yay.baseYjsUpdate))) {
			await retireBatch();
			return Result({ _nay: { message: PENDING_BASE_STALE_MESSAGE } });
		}

		const rootKind = data.fileNode.yjsRootKind;
		const baseYjsDoc = files_yjs_doc_create_from_array_buffer_update(files_u8_to_array_buffer(baseBytes._yay));
		const stagedBranchYjsDoc = files_yjs_doc_create_from_array_buffer_update(files_u8_to_array_buffer(stagedBytes._yay));
		const unstagedBranchYjsDoc = files_yjs_doc_create_from_array_buffer_update(
			files_u8_to_array_buffer(unstagedBytes._yay),
		);
		const [baseText, stagedText, unstagedText] = [
			files_yjs_doc_get_text({ yjsDoc: baseYjsDoc, rootKind }),
			files_yjs_doc_get_text({ yjsDoc: stagedBranchYjsDoc, rootKind }),
			files_yjs_doc_get_text({ yjsDoc: unstagedBranchYjsDoc, rootKind }),
		];
		if (baseText._nay || stagedText._nay || unstagedText._nay) {
			// Log the cause and return a message-only `_nay`; a `cause` field would fail the
			// `v_result` returns validators this Result crosses.
			console.error("Failed to compare rebased pending update branches with base", {
				error: baseText._nay ?? stagedText._nay ?? unstagedText._nay,
				nodeId: args.nodeId,
				pendingUpdateId: existingPendingUpdate._id,
			});
			await retireBatch();
			return Result({ _nay: { message: "Failed to compare rebased pending update branches with base" } });
		}

		// No-change docs normally delete/degrade, but two kinds must persist: eager-created docs
		// store base == staged == unstaged so the family survives and the eager-created node stays
		// discardable; `mv -f` replace-moves must exist to accept, because accepting an
		// identical-content replace still archives the source.
		const hasChanges = stagedText._yay !== baseText._yay || unstagedText._yay !== baseText._yay;
		if (!hasChanges && !existingPendingUpdate.eagerCreated && !existingPendingUpdate.copiedFrom?.archivesSourceOnAccept) {
			const settled = (await ctx.runMutation(internal.files_pending_updates.settle_file_pending_update_no_change_in_db, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: userAuth.id,
				nodeId: args.nodeId,
				operationBatchId: args.operationBatchId,
				pendingUpdateId: existingPendingUpdate._id,
				expectedUpdatedAt: existingPendingUpdate.updatedAt,
			})) as settle_file_pending_update_no_change_in_db_Result;
			if (settled._nay) {
				await retireBatch();
				return Result({ _nay: settled._nay });
			}
			return Result({ _yay: { pendingUpdate: null } });
		}

		// Same-bytes rewrites still count as activity: refresh the doc's 4h lifetime, or the
		// cleanup task scheduled for the old updatedAt expires the untouched proposal.
		const currentDigests = new Map(
			data.currentCanonicalStates.flatMap((stateDoc) =>
				stateDoc.owner.kind === "active" ? [[stateDoc.owner.role, stateDoc.digest] as const] : [],
			),
		);
		if (
			existingContent.baseYjsSequence === args.baseYjsSequence &&
			existingContent.baseLineageGeneration === data.lineageGeneration &&
			baseInput.digest === currentDigests.get("base") &&
			stagedInput.digest === currentDigests.get("staged") &&
			unstagedInput.digest === currentDigests.get("unstaged")
		) {
			const refreshed = (await ctx.runMutation(internal.files_pending_updates.refresh_file_pending_update_in_db, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: userAuth.id,
				nodeId: args.nodeId,
				operationBatchId: args.operationBatchId,
				pendingUpdateId: existingPendingUpdate._id,
				expectedUpdatedAt: existingPendingUpdate.updatedAt,
			})) as refresh_file_pending_update_in_db_Result;
			if (refreshed._nay) {
				await retireBatch();
				return Result({ _nay: refreshed._nay });
			}
			return Result({ _yay: { pendingUpdate: refreshed._yay.pendingUpdate } });
		}

		// A commit that throws (for example the frontmatter field cap in the chunk rebuild) rolls
		// its own writes back, but the batch and sealed input family live in already-committed
		// mutations. Retire them before rethrowing, or the abandoned batch would block this
		// user/node until the TTL.
		let committed: commit_file_pending_update_rebase_in_db_Result;
		try {
			committed = (await ctx.runMutation(internal.files_pending_updates.commit_file_pending_update_rebase_in_db, {
				membershipId: args.membershipId,
				nodeId: args.nodeId,
				pendingUpdateId: existingPendingUpdate._id,
				operationBatchId: args.operationBatchId,
				expectedUpdatedAt: existingPendingUpdate.updatedAt,
				baseYjsSequence: args.baseYjsSequence,
				baseLineageGeneration: data.lineageGeneration,
				baseStateId: baseInput._id,
				stagedStateId: stagedInput._id,
				unstagedStateId: unstagedInput._id,
				baseStateDigest: baseInput.digest,
				stagedStateDigest: stagedInput.digest,
				unstagedStateDigest: unstagedInput.digest,
				unstagedText: unstagedText._yay,
			})) as commit_file_pending_update_rebase_in_db_Result;
		} catch (error) {
			await retireBatch();
			throw error;
		}
		if (committed._nay) {
			// A commit refusal ends this operation too: without the retire, the surviving batch
			// would refuse this user/node's next operation ("already in progress") until the TTL.
			await retireBatch();
			return Result({ _nay: committed._nay });
		}

		return Result({ _yay: committed._yay });
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

		const authorized = await access_control_db_authorize_node(ctx, {
			userAuth,
			membership,
			nodeId: args.nodeId,
			permission: "content.read",
		});
		if (authorized._nay) {
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

		// A failed check does not end the query here, same as `list_tree`. The drafts a guest wrote inside
		// the one folder they hold are their own: without them they cannot save or discard what they typed.
		const authorized = await access_control_db_authorize_membership(ctx, {
			userAuth,
			membership,
			permission: "content.read",
		});

		const pendingUpdates = await files_db_list_pending_updates_for_user(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: userAuth.id,
		});

		// These are the caller's own drafts, so they were readable when they were written. They are
		// filtered anyway, because access can be taken away after the draft exists: the pending-changes
		// panel must not keep showing the name and path of a file the caller has since lost.
		const pendingNodes = (
			await Promise.all(pendingUpdates.map((pendingUpdate) => ctx.db.get("files_nodes", pendingUpdate.fileNodeId)))
		).filter((fileNode) => fileNode !== null);
		const readableNodeIds = new Set(
			(
				await access_control_db_filter_readable_file_nodes(ctx, {
					organizationId: membership.organizationId,
					workspaceId: membership.workspaceId,
					userId: userAuth.id,
					nodes: pendingNodes,
					hasWorkspaceRead: !authorized._nay,
				})
			).map((fileNode) => fileNode._id),
		);

		return pendingUpdates.filter((pendingUpdate) => readableNodeIds.has(pendingUpdate.fileNodeId));
	},
});

/**
 * One user's pending update docs plus the nodes their move/replace fields reference —
 * the inputs the pending path overlay is built from. Server callers (bash, AI tools)
 * fetch this once per user; Convex caches it per args until the docs change.
 */
export const get_pending_path_overlay_data = internalQuery({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
	},
	returns: v.object({
		pendingUpdates: v.array(doc(app_convex_schema, "files_pending_updates")),
		referencedNodes: v.array(doc(app_convex_schema, "files_nodes")),
	}),
	handler: async (ctx, args) => {
		return await files_db_get_pending_path_overlay_data(ctx, args);
	},
});

export type files_pending_updates_get_pending_path_overlay_data_Result =
	typeof get_pending_path_overlay_data extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

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

		const authorized = await access_control_db_authorize_node(ctx, {
			userAuth,
			membership,
			nodeId: args.nodeId,
			permission: "content.read",
		});
		if (authorized._nay) {
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

/**
 * A replace-move is a copy that must also archive its source when accepted. A full save
 * always runs this — even an identical-content save that publishes nothing, because
 * accepting the replace must still consume the source. A partial save runs this only when
 * it published staged content; one that publishes nothing only clears the provenance (the
 * proposal degrades to a plain edit). When the archived source's own doc is again a
 * replace-move, the deeper sources are archived too (chained mv -f). Each hop no-ops when
 * its source is gone, archived, or out of scope.
 */
async function files_pending_update_db_archive_replace_source_chain(
	ctx: MutationCtx,
	args: {
		membership: app_convex_Doc<"organizations_workspaces_users">;
		copiedFrom: app_convex_Doc<"files_pending_updates">["copiedFrom"];
		updatedBy: Id<"users">;
		now: number;
	},
) {
	// Walk the whole replace chain (mv -f a b, then mv -f b c): the accepted content was copied
	// from the visible chain result, so accepting the head consumes every hop. The visited set
	// bounds the walk if provenance ever loops.
	const visitedNodeIds = new Set<Id<"files_nodes">>();
	let copiedFrom = args.copiedFrom;
	while (copiedFrom?.archivesSourceOnAccept && !visitedNodeIds.has(copiedFrom.nodeId)) {
		visitedNodeIds.add(copiedFrom.nodeId);
		const sourceNode = await ctx.db.get("files_nodes", copiedFrom.nodeId);
		if (
			!sourceNode ||
			sourceNode.organizationId !== args.membership.organizationId ||
			sourceNode.workspaceId !== args.membership.workspaceId ||
			sourceNode.kind !== "file" ||
			sourceNode.archiveOperationId !== undefined
		) {
			return;
		}

		// The caller was authorized for the file being saved. This is the other end of a replace-move,
		// found through the proposal's provenance, and a proposal can outlive the access that created
		// it — so it is asked about now, at the moment it would be archived. Asked through the
		// membership: the file being saved can be a restricted one this caller holds a grant on, which
		// says nothing about an open source, and the raw helper waves every open node through.
		const authorizedSource = await access_control_db_authorize_membership(ctx, {
			userAuth: { id: args.updatedBy },
			membership: args.membership,
			permission: "content.write",
			fileNode: sourceNode,
		});
		if (authorizedSource._nay) {
			return;
		}

		await files_nodes_db_archive_nodes(ctx, { nodeIds: [sourceNode._id], updatedBy: args.updatedBy, now: args.now });

		// The acting user's leftover doc on the source must not stay acceptable on the archived
		// file: it is either a pre-mv content edit whose content the replace proposal already
		// carries, or itself a replace-move doc (chained mv -f) whose own source the next hop
		// archives. Other users' docs stay untouched.
		const sourcePendingUpdate = await files_db_get_pending_update(ctx, {
			organizationId: args.membership.organizationId,
			workspaceId: args.membership.workspaceId,
			userId: args.updatedBy,
			nodeId: sourceNode._id,
		});
		if (!sourcePendingUpdate) {
			return;
		}
		await Promise.all([
			files_db_cancel_pending_update_cleanup_tasks(ctx, {
				pendingUpdateId: sourcePendingUpdate._id,
			}),
			files_db_retire_pending_update_yjs_states(ctx, {
				organizationId: args.membership.organizationId,
				workspaceId: args.membership.workspaceId,
				pendingUpdateId: sourcePendingUpdate._id,
			}),
			files_pending_update_db_delete_chunks(ctx, {
				pendingUpdateId: sourcePendingUpdate._id,
			}),
			ctx.db.delete("files_pending_updates", sourcePendingUpdate._id),
		]);
		copiedFrom = sourcePendingUpdate.copiedFrom;
	}
}

/**
 * Find each source file that this replace save will archive.
 * Check access and the current lock, but do not write yet.
 * Stop at the same place as the archive step.
 */
async function files_pending_update_db_collect_replace_source_chain(
	ctx: QueryCtx,
	args: {
		membership: app_convex_Doc<"organizations_workspaces_users">;
		copiedFrom: app_convex_Doc<"files_pending_updates">["copiedFrom"];
		userId: Id<"users">;
	},
) {
	const chain: app_convex_Doc<"files_nodes">[] = [];
	const visitedNodeIds = new Set<Id<"files_nodes">>();
	let copiedFrom = args.copiedFrom;
	while (copiedFrom?.archivesSourceOnAccept && !visitedNodeIds.has(copiedFrom.nodeId)) {
		visitedNodeIds.add(copiedFrom.nodeId);
		const sourceNode = await ctx.db.get("files_nodes", copiedFrom.nodeId);
		if (
			!sourceNode ||
			sourceNode.organizationId !== args.membership.organizationId ||
			sourceNode.workspaceId !== args.membership.workspaceId ||
			sourceNode.kind !== "file" ||
			sourceNode.archiveOperationId !== undefined
		) {
			break;
		}

		const authorizedSource = await access_control_db_authorize_membership(ctx, {
			userAuth: { id: args.userId },
			membership: args.membership,
			permission: "content.write",
			fileNode: sourceNode,
		});
		if (authorizedSource._nay) {
			return authorizedSource;
		}

		const sourceWritable = files_node_require_writable(sourceNode);
		if (sourceWritable._nay) {
			return sourceWritable;
		}

		chain.push(sourceNode);

		const sourcePendingUpdate = await files_db_get_pending_update(ctx, {
			organizationId: args.membership.organizationId,
			workspaceId: args.membership.workspaceId,
			userId: args.userId,
			nodeId: sourceNode._id,
		});
		if (!sourcePendingUpdate) {
			break;
		}
		copiedFrom = sourcePendingUpdate.copiedFrom;
	}
	return Result({ _yay: { chain } });
}

/**
 * Refuse when any source file this replace proposal will archive is read-only now.
 */
export const preflight_replace_source_chain_writable = internalQuery({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		copiedFrom: v.object({
			nodeId: v.id("files_nodes"),
			path: v.string(),
			archivesSourceOnAccept: v.optional(v.boolean()),
		}),
	},
	returns: v_result({ _yay: v.object({ sourceNodeIds: v.array(v.id("files_nodes")) }) }),
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
			return Result({ _nay: { message: "Permission denied" } });
		}

		const sourceChain = await files_pending_update_db_collect_replace_source_chain(ctx, {
			membership,
			copiedFrom: args.copiedFrom,
			userId: args.userId,
		});
		if (sourceChain._nay) {
			return sourceChain;
		}

		return Result({ _yay: { sourceNodeIds: sourceChain._yay.chain.map((sourceNode) => sourceNode._id) } });
	},
});

export type preflight_replace_source_chain_writable_Result =
	typeof preflight_replace_source_chain_writable extends RegisteredQuery<
		infer _Visibility,
		infer _Args,
		infer ReturnValue
	>
		? Awaited<ReturnValue>
		: never;

/**
 * Refuse when any source file this save will archive is read-only now.
 */
export const preflight_save_file_pending_update_writable = internalQuery({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		userId: v.id("users"),
		nodeId: v.id("files_nodes"),
		pendingUpdateId: v.id("files_pending_updates"),
	},
	returns: v_result({ _yay: v.object({ sourceNodeIds: v.array(v.id("files_nodes")) }) }),
	handler: async (ctx, args) => {
		const membership = await ctx.db.get("organizations_workspaces_users", args.membershipId);
		if (!membership || membership.userId !== args.userId) {
			return Result({ _nay: { message: "Not found" } });
		}

		const pendingUpdate = await files_db_get_pending_update(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: args.userId,
			nodeId: args.nodeId,
			pendingUpdateId: args.pendingUpdateId,
		});
		if (!pendingUpdate || pendingUpdate._id !== args.pendingUpdateId) {
			return Result({ _nay: { message: "Not found" } });
		}

		const sourceChain = await files_pending_update_db_collect_replace_source_chain(ctx, {
			membership,
			copiedFrom: pendingUpdate.copiedFrom,
			userId: args.userId,
		});
		if (sourceChain._nay) {
			return sourceChain;
		}

		return Result({ _yay: { sourceNodeIds: sourceChain._yay.chain.map((sourceNode) => sourceNode._id) } });
	},
});

export type preflight_save_file_pending_update_writable_Result =
	typeof preflight_save_file_pending_update_writable extends RegisteredQuery<
		infer _Visibility,
		infer _Args,
		infer ReturnValue
	>
		? Awaited<ReturnValue>
		: never;

export const save_file_pending_update_in_db = internalMutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
		pendingUpdateId: v.id("files_pending_updates"),
		expectedUpdatedAt: v.number(),
		baseYjsSequence: v.number(),
		baseLineageGeneration: v.number(),
		/** Source file ids found before this save starts. */
		expectedSourceNodeIds: v.array(v.id("files_nodes")),
		/** The staged accept diff to publish through door 1; absent when nothing staged changed. */
		trustedStageId: v.optional(v.id("files_yjs_trusted_update_stages")),
		/**
		 * Present when unstaged edits survive the save: the sealed output family that replaces
		 * the canonical states (base = staged = the live state after the save, unstaged = the
		 * merged unstaged branch), plus the one bounded text that rebuilds pending chunks when
		 * remote drift changed the unstaged content.
		 */
		partial: v.optional(
			v.object({
				operationBatchId: v.id("files_pending_update_operation_batches"),
				baseStateId: v.id("files_pending_update_yjs_states"),
				stagedStateId: v.id("files_pending_update_yjs_states"),
				unstagedStateId: v.id("files_pending_update_yjs_states"),
				baseStateDigest: v.string(),
				stagedStateDigest: v.string(),
				unstagedStateDigest: v.string(),
				unstagedText: v.string(),
				unstagedTextChanged: v.boolean(),
			}),
		),
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

		// The target file can be archived (or removed) after the proposal, e.g. from the Files UI.
		// Fail before any writes, or the save would bill, publish onto the archived file, and a
		// replace-move would still archive its source with no active result. The doc stays intact.
		const targetNode = await ctx.db.get("files_nodes", args.nodeId);
		if (
			!targetNode ||
			targetNode.organizationId !== membership.organizationId ||
			targetNode.workspaceId !== membership.workspaceId ||
			!files_node_has_editable_yjs_state(targetNode) ||
			targetNode.archiveOperationId !== undefined
		) {
			return Result({ _nay: { message: "Not found" } });
		}

		const authorized = await access_control_db_authorize_membership(ctx, {
			userAuth,
			membership,
			permission: "content.write",
			fileNode: targetNode,
		});
		if (authorized._nay) {
			return authorized;
		}

		// Check the lock again before any save writes. Old lock history does not matter.
		const targetWritable = files_node_require_writable(targetNode);
		if (targetWritable._nay) {
			return targetWritable;
		}

		const pendingUpdate = await files_db_get_pending_update(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: user._id,
			nodeId: args.nodeId,
			pendingUpdateId: args.pendingUpdateId,
		});

		// Only the exact doc the action worked from: a missing doc means the proposal was
		// discarded or fully accepted while this save was in flight; a doc with a different id
		// means a new proposal replaced it, and saving that doc would publish (and for a
		// replace-move, accept) a proposal the user never accepted. A changed `updatedAt` means
		// another write landed mid-action, and the staged diff no longer describes the branches.
		if (!pendingUpdate || pendingUpdate._id !== args.pendingUpdateId) {
			return Result({
				_nay: {
					message: "Not found",
				},
			});
		}
		if (pendingUpdate.updatedAt !== args.expectedUpdatedAt) {
			return Result({ _nay: { message: "Stale save" } });
		}

		// A pending delete supersedes the content proposal: publishing under it would commit
		// content onto a file the user is about to archive. Discard the delete first.
		if (pendingUpdate.pendingArchive) {
			return Result({
				_nay: {
					message: "File has a pending delete",
				},
			});
		}

		const pendingUpdateContent = files_pending_update_content_of(pendingUpdate);
		if (!pendingUpdateContent) {
			// Move-only docs have nothing to publish; Accept goes through
			// apply_file_pending_move instead.
			return Result({
				_nay: {
					message: "No content to save",
				},
			});
		}

		// Load the replace sources again in this final write.
		// Check access and the current lock for every source before changing anything.
		const currentSourceChain = await files_pending_update_db_collect_replace_source_chain(ctx, {
			membership,
			copiedFrom: pendingUpdate.copiedFrom,
			userId: user._id,
		});
		if (currentSourceChain._nay) {
			return currentSourceChain;
		}
		const currentSourceNodeIds = currentSourceChain._yay.chain.map((sourceNode) => sourceNode._id);
		if (
			currentSourceNodeIds.length !== args.expectedSourceNodeIds.length ||
			currentSourceNodeIds.some((sourceNodeId, index) => sourceNodeId !== args.expectedSourceNodeIds[index])
		) {
			return Result({ _nay: { message: "Stale save" } });
		}

		// The file must still have the Yjs sequence used to build this diff.
		// Refuse before writes or billing if another save or repair changed that sequence.
		const lastSequenceDoc = targetNode.yjsLastSequenceId
			? await ctx.db.get("files_yjs_docs_last_sequences", targetNode.yjsLastSequenceId)
			: null;
		if (lastSequenceDoc?.lastSequence !== args.baseYjsSequence) {
			return Result({
				_nay: {
					message: "Stale save",
				},
			});
		}
		if (lastSequenceDoc.lineageGeneration !== args.baseLineageGeneration) {
			return Result({ _nay: { message: PENDING_BASE_STALE_MESSAGE } });
		}

		// Validate the partial-output family before any write, so a refusal leaves nothing behind.
		let partialBatch: app_convex_Doc<"files_pending_update_operation_batches"> | null = null;
		if (args.partial) {
			if (files_get_utf8_byte_size(args.partial.unstagedText) > files_MAX_TEXT_CONTENT_BYTES) {
				return Result({ _nay: { message: `Text content exceeds ${files_MAX_TEXT_CONTENT_BYTES}-byte limit` } });
			}
			// Frontmatter caps on the surviving unstaged text, before any write; the calling
			// action retires the partial-output batch on this refusal.
			const frontmatterRefusal = files_pending_update_check_frontmatter_caps({
				fileNode: targetNode,
				unstagedText: args.partial.unstagedText,
			});
			if (frontmatterRefusal) {
				return frontmatterRefusal;
			}
			partialBatch = await db_get_owned_operation_batch(ctx, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: user._id,
				operationBatchId: args.partial.operationBatchId,
				now: Date.now(),
			});
			if (!partialBatch || partialBatch.fileNodeId !== args.nodeId) {
				return Result({ _nay: { message: "Not found" } });
			}
			const stateValidation = await db_validate_batch_states_for_commit(ctx, {
				batch: partialBatch,
				phase: "output",
				baseLineageGeneration: args.baseLineageGeneration,
				states: [
					{ role: "base", stateId: args.partial.baseStateId, digest: args.partial.baseStateDigest },
					{ role: "staged", stateId: args.partial.stagedStateId, digest: args.partial.stagedStateDigest },
					{ role: "unstaged", stateId: args.partial.unstagedStateId, digest: args.partial.unstagedStateDigest },
				],
			});
			if (stateValidation._nay) {
				return stateValidation;
			}
		}

		let newSequence: number | null = null;
		if (args.trustedStageId) {
			const stage = await ctx.db.get("files_yjs_trusted_update_stages", args.trustedStageId);
			if (
				!stage ||
				stage.organizationId !== membership.organizationId ||
				stage.workspaceId !== membership.workspaceId ||
				stage.userId !== user._id ||
				stage.fileNodeId !== args.nodeId ||
				stage.kind !== "pending_accept" ||
				stage.expiresAt <= Date.now()
			) {
				return Result({ _nay: { message: "Not found" } });
			}
			// Consume the stage now. The delete commits even with a refusal below, on purpose: a
			// refused accept must be rebuilt and restaged, never replayed from a stale stage.
			await ctx.db.delete("files_yjs_trusted_update_stages", stage._id);

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
			// Door 1 runs on the staged diff here: an accept diff that carries a foreign root is
			// refused with a visible message, and the proposal stays discardable.
			const result = await files_db_yjs_push_update(ctx, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				nodeId: args.nodeId,
				update: stage.update,
				sessionId: `files_pending_update:${user._id}`,
				userId: user._id,
				rootKind: targetNode.yjsRootKind,
				// A save is a one-shot commit, not a keystroke stream: materialize now so
				// committed reads (bash cat, exports) see the accepted content right away.
				materializeImmediately: true,
			});
			if (result._nay) {
				// Log the cause and return a message-only `_nay`; a `cause` field would fail the
				// `v_result` returns validators this Result crosses. A refusal here usually means
				// the proposal was built by an out-of-date editor and must be discarded and redone.
				if (result._nay.cause !== undefined) {
					console.warn("Accepted pending update push refused", {
						nodeId: args.nodeId,
						pendingUpdateId: args.pendingUpdateId,
						message: result._nay.message,
						cause: result._nay.cause,
					});
					return Result({ _nay: { message: result._nay.message } });
				}
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
		}

		const now = Date.now();
		const nextBaseYjsSequence = newSequence ?? args.baseYjsSequence;

		// Full consume: the unstaged branch matches the saved result, so the proposal is done.
		// Archiving walks the replace chain: each hop's source node and the acting user's own
		// doc on it — never this doc — so it runs in parallel with the doc writes below.
		if (!args.partial) {
			const archiveSourcePromise = files_pending_update_db_archive_replace_source_chain(ctx, {
				membership,
				copiedFrom: pendingUpdate.copiedFrom,
				updatedBy: user._id,
				now,
			});

			if (pendingUpdate.pendingMove) {
				// Save publishes the content only; the move proposal survives as a move-only doc.
				// The content is committed now, so expiry must never hard-delete the node: clear the
				// eager-create stamp (and the now-stale copy provenance).
				await Promise.all([
					archiveSourcePromise,
					files_pending_update_upsert_last_sequence_saved(ctx, {
						organizationId: membership.organizationId,
						workspaceId: membership.workspaceId,
						userId: user._id,
						nodeId: args.nodeId,
						lastSequenceSaved: nextBaseYjsSequence,
						updatedAt: now,
					}),
					ctx.db.patch("files_pending_updates", pendingUpdate._id, {
						baseYjsSequence: undefined,
						baseLineageGeneration: undefined,
						baseStateId: undefined,
						stagedStateId: undefined,
						unstagedStateId: undefined,
						copiedFrom: undefined,
						eagerCreated: undefined,
						size: 0,
						updatedAt: now,
					}),
					files_db_retire_pending_update_yjs_states(ctx, {
						organizationId: membership.organizationId,
						workspaceId: membership.workspaceId,
						pendingUpdateId: pendingUpdate._id,
					}),
					files_db_schedule_pending_update_cleanup(ctx, {
						pendingUpdateId: pendingUpdate._id,
						expectedUpdatedAt: now,
					}),
					files_pending_update_db_delete_chunks(ctx, {
						pendingUpdateId: pendingUpdate._id,
					}),
				]);

				return Result({
					_yay: {
						newSequence,
					},
				});
			}

			await Promise.all([
				archiveSourcePromise,
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
				files_db_retire_pending_update_yjs_states(ctx, {
					organizationId: membership.organizationId,
					workspaceId: membership.workspaceId,
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

		// Partial save: unstaged edits survive. Swap the canonical family to the sealed outputs
		// the action staged (base = staged = the live state after this save, unstaged = the
		// merged unstaged branch).
		const partial = args.partial;
		if (!partialBatch) {
			// Validated above; keeps the compiler honest.
			return Result({ _nay: { message: "Not found" } });
		}
		await Promise.all([
			// A partial save that published nothing (nothing staged) must not complete the move;
			// the patch below still clears the provenance, so the proposal degrades to a plain edit.
			args.trustedStageId
				? files_pending_update_db_archive_replace_source_chain(ctx, {
						membership,
						copiedFrom: pendingUpdate.copiedFrom,
						updatedBy: user._id,
						now,
					})
				: null,
			ctx.db.patch("files_pending_updates", pendingUpdate._id, {
				baseYjsSequence: nextBaseYjsSequence,
				baseLineageGeneration: args.baseLineageGeneration,
				baseStateId: partial.baseStateId,
				stagedStateId: partial.stagedStateId,
				unstagedStateId: partial.unstagedStateId,
				// Content is committed from here on, so expiry must never hard-delete the node.
				copiedFrom: undefined,
				eagerCreated: undefined,
				...(partial.unstagedTextChanged ? { size: files_get_utf8_byte_size(partial.unstagedText) } : {}),
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
		await db_swap_canonical_states_and_consume_batch(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			pendingUpdateId: pendingUpdate._id,
			batch: partialBatch,
			baseStateId: partial.baseStateId,
			stagedStateId: partial.stagedStateId,
			unstagedStateId: partial.unstagedStateId,
		});

		// Remote drift merged into the unstaged branch changes its content, so pending chunk and
		// metadata docs must be rebuilt; without drift the unstaged content is unchanged by a
		// partial save.
		if (partial.unstagedTextChanged) {
			const chunksReplaced = await files_pending_update_db_replace_chunks(ctx, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: user._id,
				nodeId: args.nodeId,
				pendingUpdateId: pendingUpdate._id,
				unstagedText: partial.unstagedText,
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

		// Same as `persist_file_pending_update_rebased_state` above: no rate limit here, and the
		// permission check goes through a query that asks about this file.
		const allowed = await ctx.runQuery(api.files_nodes.get_current_user_file_write_permission, {
			membershipId: args.membershipId,
			nodeId: args.nodeId,
		});
		if (!allowed) {
			return Result({ _nay: { message: "Permission denied" } });
		}

		const data = (await ctx.runQuery(internal.files_pending_updates.get_data_for_pending_content_operation, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: userAuth.id,
			nodeId: args.nodeId,
			pendingUpdateId: args.pendingUpdateId,
		})) as get_data_for_pending_content_operation_Result;
		if (!data) {
			return Result({ _nay: { message: "Not found" } });
		}

		// Only the exact doc the client had open; the commit mutation rechecks all of this.
		const pendingUpdate = data.existingPendingUpdate;
		if (!pendingUpdate || (args.pendingUpdateId != null && pendingUpdate._id !== args.pendingUpdateId)) {
			return Result({ _nay: { message: "Not found" } });
		}
		if (pendingUpdate.pendingArchive) {
			return Result({ _nay: { message: "File has a pending delete" } });
		}
		const content = files_pending_update_content_of(pendingUpdate);
		if (!content) {
			return Result({ _nay: { message: "No content to save" } });
		}
		// A proposal built against a repaired-away lineage is visibly stale and only discardable.
		if (content.baseLineageGeneration !== data.lineageGeneration) {
			return Result({ _nay: { message: PENDING_BASE_STALE_MESSAGE } });
		}

		// Check current locks before loading Yjs state.
		// The final write checks the target and every replace source again.
		const fileWritable = files_node_require_writable(data.fileNode);
		if (fileWritable._nay) {
			return fileWritable;
		}
		const sourcePreflight = (await ctx.runQuery(
			internal.files_pending_updates.preflight_save_file_pending_update_writable,
			{
				membershipId: args.membershipId,
				userId: userAuth.id,
				nodeId: args.nodeId,
				pendingUpdateId: pendingUpdate._id,
			},
		)) as preflight_save_file_pending_update_writable_Result;
		if (sourcePreflight._nay) {
			return sourcePreflight;
		}

		const rootKind = data.fileNode.yjsRootKind;

		// Page the canonical base/staged/unstaged states and the current live state in memory.
		const [baseBytes, stagedBytes, unstagedBytes] = await Promise.all([
			action_load_pending_state_bytes(ctx, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: userAuth.id,
				stateId: content.baseStateId,
			}),
			action_load_pending_state_bytes(ctx, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: userAuth.id,
				stateId: content.stagedStateId,
			}),
			action_load_pending_state_bytes(ctx, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: userAuth.id,
				stateId: content.unstagedStateId,
			}),
		]);
		if (baseBytes._nay || stagedBytes._nay || unstagedBytes._nay) {
			return Result({ _nay: { message: "Not found" } });
		}
		const live = await files_pending_update_action_get_latest_file_yjs_state(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			nodeId: args.nodeId,
			targetSequence: data.lastSequence,
		});
		if (live._nay) {
			return Result({ _nay: { message: live._nay.message } });
		}

		const baseYjsDoc = files_yjs_doc_create_from_array_buffer_update(files_u8_to_array_buffer(baseBytes._yay));
		const stagedBranchYjsDoc = files_yjs_doc_create_from_array_buffer_update(files_u8_to_array_buffer(stagedBytes._yay));
		const unstagedBranchYjsDoc = files_yjs_doc_create_from_array_buffer_update(
			files_u8_to_array_buffer(unstagedBytes._yay),
		);
		const latestFileYjsDoc = live._yay.baseYjsDoc;

		// Merge remote drift into both branches, then compute the live-lineage accept diff. The
		// branch documents share the live document's lineage (the upsert/rebase flows preserve
		// it), so this state-vector diff carries exactly the proposal's own structs.
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
		const liveFileYjsDocAfterSave = files_yjs_doc_clone({ yjsDoc: latestFileYjsDoc });
		if (diffUpdateForLatestFileYjsDoc) {
			files_yjs_doc_apply_array_buffer_update(
				liveFileYjsDocAfterSave,
				files_u8_to_array_buffer(diffUpdateForLatestFileYjsDoc),
			);
		}

		const unstagedMatchesSavedBase = files_pending_update_docs_match_content({
			leftYjsDoc: liveFileYjsDocAfterSave,
			rightYjsDoc: unstagedBranchYjsDoc,
			rootKind,
		});
		if (unstagedMatchesSavedBase._nay) {
			// Log the cause and return a message-only `_nay`; a `cause` field would fail the
			// `v_result` returns validators this Result crosses. Nothing is written yet.
			console.error("Failed to compare unstaged pending branch with saved file content", {
				error: unstagedMatchesSavedBase._nay,
				nodeId: args.nodeId,
				pendingUpdateId: pendingUpdate._id,
			});
			return Result({ _nay: { message: "Failed to compare unstaged pending branch with saved file content" } });
		}

		// Stage the single non-empty accept diff under the update-doc cap; the commit mutation
		// consumes it and pushes it through door 1.
		let trustedStageId: Id<"files_yjs_trusted_update_stages"> | undefined;
		const retireTrustedStage = async () => {
			if (!trustedStageId) {
				return;
			}
			await ctx.runMutation(internal.files_pending_updates.retire_trusted_yjs_update_stage, {
				stageId: trustedStageId,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: userAuth.id,
				nodeId: args.nodeId,
			});
		};

		if (diffUpdateForLatestFileYjsDoc) {
			const diffBuffer = files_u8_to_array_buffer(diffUpdateForLatestFileYjsDoc);
			if (diffBuffer.byteLength > files_MAX_YJS_WIRE_BYTES) {
				return Result({ _nay: { message: "Update too large" } });
			}
			const staged = (await ctx.runMutation(internal.files_pending_updates.stage_trusted_yjs_update, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: userAuth.id,
				nodeId: args.nodeId,
				kind: "pending_accept",
				update: diffBuffer,
			})) as files_pending_updates_stage_trusted_yjs_update_Result;
			if (staged._nay) {
				return Result({ _nay: { message: staged._nay.message } });
			}
			trustedStageId = staged._yay.stageId;
		}

		// Full consume: the unstaged branch matches the saved result.
		if (unstagedMatchesSavedBase._yay) {
			const saved = (await ctx.runMutation(internal.files_pending_updates.save_file_pending_update_in_db, {
				membershipId: args.membershipId,
				nodeId: args.nodeId,
				pendingUpdateId: pendingUpdate._id,
				expectedUpdatedAt: pendingUpdate.updatedAt,
				baseYjsSequence: data.lastSequence,
				baseLineageGeneration: data.lineageGeneration,
				expectedSourceNodeIds: sourcePreflight._yay.sourceNodeIds,
				trustedStageId,
			})) as save_file_pending_update_in_db_Result;
			if (saved._nay) {
				await retireTrustedStage();
				return Result({ _nay: saved._nay });
			}
			return Result({ _yay: saved._yay });
		}

		// Partial save: stage and seal the replacement family (base = staged = the live state
		// after the save, unstaged = the merged branch), then commit by metadata id.
		const mergedUnstagedText = files_yjs_doc_get_text({ yjsDoc: unstagedBranchYjsDoc, rootKind });
		if (mergedUnstagedText._nay) {
			console.error("Failed to serialize unstaged branch after partial save", {
				error: mergedUnstagedText._nay,
				nodeId: args.nodeId,
				pendingUpdateId: pendingUpdate._id,
			});
			await retireTrustedStage();
			return Result({ _nay: { message: "Failed to serialize unstaged branch after partial save" } });
		}

		const batchCreated = (await ctx.runMutation(
			internal.files_pending_updates.create_file_pending_update_operation_batch_internal,
			{
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: userAuth.id,
				nodeId: args.nodeId,
			},
		)) as create_file_pending_update_operation_batch_internal_Result;
		if (batchCreated._nay) {
			await retireTrustedStage();
			return Result({ _nay: batchCreated._nay });
		}
		const operationBatchId = batchCreated._yay.operationBatchId;
		const retireBatch = async () => {
			await ctx.runMutation(internal.files_pending_updates.retire_file_pending_update_operation_batch, {
				operationBatchId,
			});
		};

		const nextBaseYjsUpdate = files_pending_update_encode_yjs_state_update({ yjsDoc: liveFileYjsDocAfterSave });
		const nextUnstagedBranchYjsUpdate = files_pending_update_encode_yjs_state_update({
			yjsDoc: unstagedBranchYjsDoc,
		});
		const outputs = [
			{ role: "base" as const, update: nextBaseYjsUpdate },
			{ role: "staged" as const, update: nextBaseYjsUpdate },
			{ role: "unstaged" as const, update: nextUnstagedBranchYjsUpdate },
		];
		for (const output of outputs) {
			if (output.update.byteLength > files_MAX_YJS_RECONSTRUCTED_STATE_BYTES) {
				await Promise.all([retireBatch(), retireTrustedStage()]);
				return Result({
					_nay: { message: `State exceeds ${files_MAX_YJS_RECONSTRUCTED_STATE_BYTES}-byte limit` },
				});
			}
		}

		const sealedByRole = new Map<
			"base" | "staged" | "unstaged",
			{ stateId: Id<"files_pending_update_yjs_states">; digest: string }
		>();
		let sealedLineageGeneration = data.lineageGeneration;
		for (const output of outputs) {
			const bytes = new Uint8Array(output.update);
			for (let pageIndex = 0; pageIndex * files_MAX_YJS_WIRE_BYTES < bytes.byteLength; pageIndex++) {
				const pageStart = pageIndex * files_MAX_YJS_WIRE_BYTES;
				const stagedPage = (await ctx.runMutation(
					internal.files_pending_updates.stage_file_pending_update_state_page_internal,
					{
						organizationId: membership.organizationId,
						workspaceId: membership.workspaceId,
						userId: userAuth.id,
						operationBatchId,
						phase: "output",
						role: output.role,
						pageIndex,
						bytes: bytes.slice(pageStart, pageStart + files_MAX_YJS_WIRE_BYTES).buffer as ArrayBuffer,
					},
				)) as stage_file_pending_update_state_page_internal_Result;
				if (stagedPage._nay) {
					await Promise.all([retireBatch(), retireTrustedStage()]);
					return Result({ _nay: { message: stagedPage._nay.message } });
				}
			}

			const sealed = (await ctx.runMutation(internal.files_pending_updates.seal_file_pending_update_state_internal, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: userAuth.id,
				operationBatchId,
				phase: "output",
				role: output.role,
				expectedTotalBytes: output.update.byteLength,
			})) as seal_file_pending_update_state_internal_Result;
			if (sealed._nay) {
				// The seal already retired the batch family on refusal.
				await retireTrustedStage();
				return Result({ _nay: { message: sealed._nay.message } });
			}
			sealedByRole.set(output.role, { stateId: sealed._yay.stateId, digest: sealed._yay.digest });
			sealedLineageGeneration = sealed._yay.lineageGeneration;
		}

		if (sealedLineageGeneration !== data.lineageGeneration) {
			await Promise.all([retireBatch(), retireTrustedStage()]);
			return Result({ _nay: { message: PENDING_BASE_STALE_MESSAGE } });
		}

		const base = sealedByRole.get("base");
		const staged = sealedByRole.get("staged");
		const unstaged = sealedByRole.get("unstaged");
		if (!base || !staged || !unstaged) {
			await Promise.all([retireBatch(), retireTrustedStage()]);
			return Result({ _nay: { message: "Not found" } });
		}

		// A commit that throws (for example the frontmatter field cap in the chunk rebuild) rolls
		// its own writes back, but the batch and sealed output family live in already-committed
		// mutations. Retire them before rethrowing, or the abandoned batch would block this
		// user/node until the TTL.
		let saved: save_file_pending_update_in_db_Result;
		try {
			saved = (await ctx.runMutation(internal.files_pending_updates.save_file_pending_update_in_db, {
				membershipId: args.membershipId,
				nodeId: args.nodeId,
				pendingUpdateId: pendingUpdate._id,
				expectedUpdatedAt: pendingUpdate.updatedAt,
				baseYjsSequence: data.lastSequence,
				baseLineageGeneration: data.lineageGeneration,
				expectedSourceNodeIds: sourcePreflight._yay.sourceNodeIds,
				trustedStageId,
				partial: {
					operationBatchId,
					baseStateId: base.stateId,
					stagedStateId: staged.stateId,
					unstagedStateId: unstaged.stateId,
					baseStateDigest: base.digest,
					stagedStateDigest: staged.digest,
					unstagedStateDigest: unstaged.digest,
					unstagedText: mergedUnstagedText._yay,
					unstagedTextChanged: remoteUpdateFromBase != null,
				},
			})) as save_file_pending_update_in_db_Result;
		} catch (error) {
			await Promise.all([retireBatch(), retireTrustedStage()]);
			throw error;
		}
		if (saved._nay) {
			// A commit refusal ends this operation too: without the retire, the surviving batch
			// would refuse this user/node's next operation ("already in progress") until the TTL.
			await Promise.all([retireBatch(), retireTrustedStage()]);
			return Result({ _nay: saved._nay });
		}

		return Result({ _yay: saved._yay });
	},
});
