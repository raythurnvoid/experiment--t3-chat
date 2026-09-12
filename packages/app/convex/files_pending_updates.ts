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
	db_get_file_content_materialization_db_state,
	files_db_yjs_push_update,
	files_merge_contiguous_chunks,
	files_nodes_db_require_user_writable,
	type files_nodes_get_user_file_write_access_Result,
	files_nodes_db_apply_pending_move,
	files_nodes_db_apply_node_move,
	files_nodes_db_archive_nodes,
	files_nodes_db_can_act_on_swept_nodes,
	files_nodes_db_collect_descendants,
	files_nodes_db_hard_delete_node,
	files_nodes_db_is_eager_node_safe_to_hard_delete,
	files_nodes_db_remove_created_ancestor_folders_if_safe,
	files_nodes_db_require_subtree_writable,
	files_nodes_db_require_swept_nodes_writable,
	files_nodes_db_validate_pending_move_target_for_proposal,
	authorize_leaving_restricted_scope,
	files_yjs_NODE_NEEDS_REPAIR_MESSAGE,
	file_content_materialization_state_validator,
	type get_file_content_materialization_header_Result,
	type get_file_next_yjs_update_Result,
} from "./files_nodes.ts";
import { files_nodes_reconstruct_latest_file_content_from_materialization_state } from "./files_nodes_reconstruct_content.ts";
import { files_nodes_db_commit_text_replacement } from "./files_nodes_content.ts";
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
	files_pending_update_asset_content_of,
	files_pending_update_content_of,
	files_pending_update_yjs_content_of,
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
import {
	files_yjs_doc_create_from_text,
	files_yjs_doc_get_text,
	files_yjs_doc_update_from_text,
} from "../shared/files-tiptap.ts";
import { files_chunk_markdown } from "../server/files-markdown-chunking-mastra.ts";
import { files_chunk_plain_text } from "../server/files-plain-text-chunking.ts";
import { files_pending_text_merge } from "../shared/files-pending-text-merge.ts";
import {
	files_MAX_TEXT_CONTENT_BYTES,
	files_MAX_YJS_RECONSTRUCTED_STATE_BYTES,
	files_MAX_YJS_WIRE_BYTES,
	files_editable_text_content_type_of,
	files_editable_text_shape_of,
	files_get_utf8_byte_size,
	files_node_has_editable_text_content,
	files_normalize_text_document_input,
	files_PENDING_UPDATE_STALE_BASE_MESSAGE,
	files_pending_update_content_is_stale,
	type files_ContentType,
	type files_YjsRootKind,
} from "../shared/files.ts";
import {
	files_metadata_frontmatter_exceeds_index_caps,
	files_metadata_preflight_frontmatter,
} from "../shared/files-metadata.ts";
import {
	r2_copy_object_to_immutable_key,
	r2_create_asset_key,
	r2_enqueue_object_deletion_job,
	r2_fetch_object_from_bucket,
	r2_put_object,
} from "./r2_client.ts";
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
 * Stable staleness refusal shared by the upsert commit, the rebase, and the save flows: the
 * proposal's base no longer matches the live file (a newer commit, a member save on a file with
 * collaboration off, or a lineage repair landed) and the client must re-read before writing.
 */
const PENDING_BASE_STALE_MESSAGE = "Pending update base is stale and must be rebuilt from the latest live file state";
const PENDING_CONTENT_PREPARATION_MESSAGE = "This file changed. Update the proposal before editing it.";

/**
 * A text write onto a file whose pending row is a whole-file copy. The copy carries its own
 * content type and shape. A text edit would drop them, so the write waits for the review.
 */
const PENDING_REPLACEMENT_BLOCKS_WRITE_MESSAGE =
	"This file has a pending copy. Accept or discard the copy in Files before writing to the file.";

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
		header.fileNode.contentShapeMismatchAt !== null ||
		header.fileNode.contentYjsStateTooLargeByteSize !== null ||
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

export async function files_pending_update_db_delete_chunks(
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
 * Saved-sequence markers belong to the old document. A replacement starts counting again,
 * so keeping them would make readers wait for an unrelated sequence.
 */
async function db_delete_saved_sequences_for_node(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		nodeId: Id<"files_nodes">;
	},
) {
	const lastSequenceSavedDocs = await ctx.db
		.query("files_pending_updates_last_sequence_saved")
		.withIndex("by_organization_workspace_fileNode_user", (q) =>
			q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("fileNodeId", args.nodeId),
		)
		.collect();

	await Promise.all(
		lastSequenceSavedDocs.map((doc) => ctx.db.delete("files_pending_updates_last_sequence_saved", doc._id)),
	);
}

/**
 * Keep old branches until preparation puts them on the current file history.
 */
export async function files_pending_updates_db_mark_content_for_rebase(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		nodeId: Id<"files_nodes">;
		rootKind?: files_YjsRootKind;
	},
) {
	const pendingUpdates = await ctx.db
		.query("files_pending_updates")
		.withIndex("by_fileNode", (q) => q.eq("fileNodeId", args.nodeId))
		.collect();
	await db_delete_saved_sequences_for_node(ctx, args);
	await Promise.all(
		pendingUpdates.map(async (pendingUpdate) => {
			if (!files_pending_update_content_of(pendingUpdate)) return;
			// Restores and mode changes keep the owner's existing expiry deadline.
			await ctx.db.patch("files_pending_updates", pendingUpdate._id, {
				contentNeedsRebase: true,
				contentRebaseRootKind: pendingUpdate.contentRebaseRootKind ?? args.rootKind,
			});
		}),
	);
}

/**
 * Whole-file replacement removes old text proposals and keeps their move or delete intent.
 */
export async function files_pending_updates_db_drop_content_for_node(
	ctx: MutationCtx,
	args: { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces">; nodeId: Id<"files_nodes"> },
) {
	const pendingUpdates = await ctx.db
		.query("files_pending_updates")
		.withIndex("by_fileNode", (q) => q.eq("fileNodeId", args.nodeId))
		.collect();
	await db_delete_saved_sequences_for_node(ctx, args);

	const now = Date.now();
	await Promise.all(
		pendingUpdates.map(async (pendingUpdate) => {
			if (!files_pending_update_content_of(pendingUpdate)) {
				return;
			}

			// Retire the paged state families instead of deleting the pages here. One family can
			// hold 12 MiB, and this runs for every member at once, so an inline delete would blow
			// the mutation write budget.
			const retireStatesAndChunks = [
				files_db_retire_pending_update_yjs_states(ctx, {
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					pendingUpdateId: pendingUpdate._id,
				}),
				files_pending_update_db_delete_chunks(ctx, { pendingUpdateId: pendingUpdate._id }),
			];

			// Nothing else was proposed, so the whole doc goes.
			if (!pendingUpdate.pendingMove && !pendingUpdate.pendingArchive) {
				await Promise.all([
					...retireStatesAndChunks,
					files_db_cancel_pending_update_cleanup_tasks(ctx, { pendingUpdateId: pendingUpdate._id }),
					ctx.db.delete("files_pending_updates", pendingUpdate._id),
				]);
				return;
			}

			await Promise.all([
				...retireStatesAndChunks,
				ctx.db.patch("files_pending_updates", pendingUpdate._id, {
					baseYjsSequence: undefined,
					baseLineageGeneration: undefined,
					baseAssetId: undefined,
					baseStateId: undefined,
					stagedStateId: undefined,
					unstagedStateId: undefined,
					contentNeedsRebase: undefined,
					contentRebaseRootKind: undefined,
					copiedFrom: undefined,
					size: 0,
					updatedAt: now,
				}),
				files_db_schedule_pending_update_cleanup(ctx, {
					pendingUpdateId: pendingUpdate._id,
					expectedUpdatedAt: now,
				}),
			]);
		}),
	);
}

/**
 * The pending half of the frontmatter caps: refuse BEFORE any canonical proposal, state, chunk,
 * or metadata write. The commit mutations run this among their first content checks; on the
 * returned refusal the calling action retires the staged input batch, so nothing durable is left
 * behind. The insert helper's late throw stays only as an impossible backstop. Returns the
 * refusal `_nay` Result, or `null` when the text passes (plain text has no frontmatter at all).
 */
function files_pending_update_check_frontmatter_caps(args: {
	fileNode: { textKind: files_YjsRootKind };
	text: string;
}) {
	if (args.fileNode.textKind !== "rich_text") {
		return null;
	}

	const preflight = files_metadata_preflight_frontmatter(args.text);
	// Do not refuse the proposal. The user cannot fix frontmatter this parser cannot read by
	// editing less of it, and refusing would block the save that would let them rewrite it. The
	// index writer skips the frontmatter and logs it.
	if (preflight._nay) {
		return null;
	}

	if (files_metadata_frontmatter_exceeds_index_caps(preflight._yay)) {
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
		/**
		 * The shape to chunk with. A whole-file replacement brings the shape of the file it
		 * copies. Without it, the node's own document shape is used, so the node must have one.
		 */
		rootKind?: "rich_text" | "plain_text";
	},
) {
	await files_pending_update_db_delete_chunks(ctx, { pendingUpdateId: args.pendingUpdateId });

	const fileNode = await ctx.db.get("files_nodes", args.nodeId);
	// The node owns the shape (a pending update is a proposal FOR a node), and the chunker
	// dispatches on it: a pending proposal on a `.json` must chunk as plain text. A whole-file
	// replacement is the exception: it is chunked with the shape of the copied file.
	const rootKind =
		fileNode && fileNode.organizationId === args.organizationId && fileNode.workspaceId === args.workspaceId
			? (args.rootKind ?? (files_node_has_editable_text_content(fileNode) ? fileNode.textKind : undefined))
			: undefined;
	if (!fileNode || rootKind === undefined) {
		console.error(
			"Failed to replace pending update chunks: fileNode is missing, mismatched, or has no document shape",
			{
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				nodeId: args.nodeId,
				pendingUpdateId: args.pendingUpdateId,
				rootKind: args.rootKind,
				fileNode,
			},
		);
		return Result({ _yay: null });
	}
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
				archiveOperationId: fileNode.archiveOperationId ?? undefined,
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
	if (activeBatches.some((batch) => now - batch.lastActivityAt < PENDING_OPERATION_BATCH_IDLE_TAKEOVER_MS)) {
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
		!files_node_has_editable_text_content(fileNode)
	) {
		return Result({ _nay: { message: "Not found" } });
	}
	const rootKind = fileNode.textKind;

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
	// A file with collaboration off has no Yjs document and no lineage, so its states carry none.
	let lineageGeneration: number | null = null;
	if (fileNode.yjsLastSequenceId !== null) {
		const lastSequenceDoc = await ctx.db.get("files_yjs_docs_last_sequences", fileNode.yjsLastSequenceId);
		if (!lastSequenceDoc) {
			return Result({ _nay: { message: "Not found" } });
		}
		lineageGeneration = lastSequenceDoc.lineageGeneration;
	}

	const digest = files_pending_update_yjs_state_digest(bytes);
	await Promise.all([
		ctx.db.patch("files_pending_update_yjs_states", state._id, {
			sealed: true,
			digest,
			lineageGeneration: lineageGeneration ?? undefined,
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
		const nodeWritable = await files_nodes_db_require_user_writable(ctx, {
			node: authorized._yay.fileNode,
			userId: userAuth.id,
		});
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
			/**
			 * `null` for a state of a file with collaboration off, which has no lineage.
			 */
			lineageGeneration: v.union(v.number(), v.null()),
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
			lineageGeneration: v.union(v.number(), v.null()),
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
			lineageGeneration: state.lineageGeneration ?? null,
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
			/**
			 * What a content proposal on this file is built against. A collaborative file has a
			 * Yjs document with a live sequence and a lineage. A file with collaboration off has
			 * only its committed text and the content asset that text came from. The two are read
			 * in this one query so they cannot straddle a member's save.
			 */
			base: v.union(
				v.object({
					kind: v.literal("yjs"),
					yjsLastSequenceId: v.id("files_yjs_docs_last_sequences"),
					lastSequence: v.number(),
					lineageGeneration: v.number(),
				}),
				v.object({
					kind: v.literal("asset"),
					baseAssetId: v.id("files_r2_assets"),
					committedText: v.string(),
				}),
			),
			batch: v.union(doc(app_convex_schema, "files_pending_update_operation_batches"), v.null()),
			inputStates: v.array(doc(app_convex_schema, "files_pending_update_yjs_states")),
			textInputRoles: v.array(v.union(v.literal("staged"), v.literal("unstaged"))),
			existingPendingUpdate: v.union(doc(app_convex_schema, "files_pending_updates"), v.null()),
			currentCanonicalStates: v.array(doc(app_convex_schema, "files_pending_update_yjs_states")),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const user = await ctx.db.get("users", args.userId);
		if (!user || user.deletedAt !== undefined) return null;
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
		if (!membership) return null;
		const authorized = await access_control_db_authorize_node(ctx, {
			userAuth: { id: args.userId },
			membership,
			nodeId: args.nodeId,
			permission: "content.write",
		});
		if (authorized._nay) return null;
		const fileNode = await ctx.db.get("files_nodes", args.nodeId);
		if (
			!fileNode ||
			fileNode.organizationId !== args.organizationId ||
			fileNode.workspaceId !== args.workspaceId ||
			!files_node_has_editable_text_content(fileNode)
		) {
			return null;
		}

		let base:
			| {
					kind: "yjs";
					yjsLastSequenceId: Id<"files_yjs_docs_last_sequences">;
					lastSequence: number;
					lineageGeneration: number;
			  }
			| { kind: "asset"; baseAssetId: Id<"files_r2_assets">; committedText: string };
		if (files_node_has_editable_yjs_state(fileNode)) {
			const lastSequenceDoc = await ctx.db.get("files_yjs_docs_last_sequences", fileNode.yjsLastSequenceId);
			if (!lastSequenceDoc) {
				const errorMessage = "fileNode.yjsLastSequenceId points to a missing files_yjs_docs_last_sequences doc";
				const errorData = { nodeId: args.nodeId, yjsLastSequenceId: fileNode.yjsLastSequenceId };
				console.error(errorMessage, errorData);
				throw should_never_happen(errorMessage, errorData);
			}
			base = {
				kind: "yjs",
				yjsLastSequenceId: lastSequenceDoc._id,
				lastSequence: lastSequenceDoc.lastSequence,
				lineageGeneration: lastSequenceDoc.lineageGeneration,
			};
		} else {
			// Collaboration off: the branches are built from the committed text, and the proposal
			// records the asset that text came from. Read both here, the same way
			// `get_non_collaborative_file_content` does for the editor.
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
						.eq("organizationId", args.organizationId)
						.eq("workspaceId", args.workspaceId)
						.eq("sourceKind", "committed")
						.eq("fileNodeId", fileNode._id),
				)
				.collect();
			// An empty file stores no chunk at all, so an empty result is only real when the asset
			// says the file has no bytes. Otherwise the chunks are missing and no proposal can be
			// built against them.
			const committedText = chunks.length > 0 ? files_merge_contiguous_chunks(chunks) : asset.size === 0 ? "" : null;
			if (committedText == null) {
				return null;
			}
			base = { kind: "asset", baseAssetId: fileNode.assetId, committedText };
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
			base,
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
	const userId = ctx.db.normalizeId("users", args.pendingUpdate.userId);
	if (!userId) {
		return false;
	}

	const node = await ctx.db.get("files_nodes", args.pendingUpdate.fileNodeId);
	if (
		!node ||
		node.organizationId !== args.pendingUpdate.organizationId ||
		node.workspaceId !== args.pendingUpdate.workspaceId ||
		(await files_nodes_db_require_user_writable(ctx, { node, userId }))._nay
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
			(await files_nodes_db_require_user_writable(ctx, { node: ancestor, userId }))._nay
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

		// An expired whole-file copy releases its staged object before the doc goes.
		if (pendingUpdate.pendingReplacement) {
			await files_pending_update_db_release_replacement_asset(ctx, {
				organizationId: pendingUpdate.organizationId,
				workspaceId: pendingUpdate.workspaceId,
				assetId: pendingUpdate.pendingReplacement.assetId,
			});
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
			await Promise.all(
				textInputs.map((textInput) => ctx.db.delete("files_pending_update_text_inputs", textInput._id)),
			);
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
		await Promise.all(
			expiredTextInputs.map((textInput) => ctx.db.delete("files_pending_update_text_inputs", textInput._id)),
		);
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
 * proposed. A doc under a move or delete proposal keeps that part; any other doc is deleted. The
 * operation batch is always consumed. `expectedUpdatedAt` guards the race where the doc changed
 * after the action read it — a newer proposal must never be destroyed by a stale no-change. Null
 * means the action read no doc; a doc that appeared since then is left alone and the write
 * refuses, so its acknowledgment cannot claim that the newer content ended.
 */
export const settle_file_pending_update_no_change_in_db = internalMutation({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		nodeId: v.id("files_nodes"),
		operationBatchId: v.id("files_pending_update_operation_batches"),
		pendingUpdateId: v.optional(v.id("files_pending_updates")),
		expectedUpdatedAt: v.union(v.number(), v.null()),
	},
	returns: v_result({
		_yay: v.object({
			pendingUpdate: v.union(doc(app_convex_schema, "files_pending_updates"), v.null()),
			currentYjsLastSequenceId: v.union(v.id("files_yjs_docs_last_sequences"), v.null()),
		}),
	}),
	handler: async (ctx, args) => {
		const file = await ctx.db.get("files_nodes", args.nodeId);
		if (
			!file ||
			file.organizationId !== args.organizationId ||
			file.workspaceId !== args.workspaceId ||
			!files_node_has_editable_text_content(file)
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
		const writable = await files_nodes_db_require_user_writable(ctx, { node: file, userId: args.userId });
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
			return Result({ _yay: { pendingUpdate: null, currentYjsLastSequenceId: file.yjsLastSequenceId ?? null } });
		}
		// Only the exact doc the action read. When the action read no doc, any doc that exists now
		// was made by a concurrent operation, and a stale no-change must not delete it.
		if (
			args.expectedUpdatedAt === null ||
			(args.pendingUpdateId != null && pendingUpdate._id !== args.pendingUpdateId) ||
			pendingUpdate.updatedAt !== args.expectedUpdatedAt
		) {
			return Result({ _nay: { message: "Pending update changed, retry the write" } });
		}
		// A member Save changes the asset without changing the proposal's timestamp.
		if (files_pending_update_content_is_stale(pendingUpdate, file)) {
			return Result({
				_nay: {
					message: pendingUpdate.contentNeedsRebase
						? PENDING_CONTENT_PREPARATION_MESSAGE
						: files_PENDING_UPDATE_STALE_BASE_MESSAGE,
				},
			});
		}

		// Content collapsed back to base under a move or delete proposal. Keep that proposal.
		if (pendingUpdate.pendingMove || pendingUpdate.pendingArchive) {
			// Only docs that are neither eager-created nor replace-moves reach here,
			// so copiedFrom is stale provenance — clear it.
			const now = Date.now();
			await Promise.all([
				ctx.db.patch("files_pending_updates", pendingUpdate._id, {
					baseYjsSequence: undefined,
					baseLineageGeneration: undefined,
					baseAssetId: undefined,
					baseStateId: undefined,
					stagedStateId: undefined,
					unstagedStateId: undefined,
					contentNeedsRebase: undefined,
					contentRebaseRootKind: undefined,
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

			return Result({
				_yay: {
					pendingUpdate: await ctx.db.get("files_pending_updates", pendingUpdate._id),
					currentYjsLastSequenceId: file.yjsLastSequenceId ?? null,
				},
			});
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

		return Result({ _yay: { pendingUpdate: null, currentYjsLastSequenceId: file.yjsLastSequenceId ?? null } });
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
			currentYjsLastSequenceId: v.union(v.id("files_yjs_docs_last_sequences"), v.null()),
		}),
	}),
	handler: async (ctx, args) => {
		const file = await ctx.db.get("files_nodes", args.nodeId);
		if (
			!file ||
			file.organizationId !== args.organizationId ||
			file.workspaceId !== args.workspaceId ||
			!files_node_has_editable_text_content(file)
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
		const writable = await files_nodes_db_require_user_writable(ctx, { node: file, userId: args.userId });
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
			return Result({ _nay: { message: "Pending update changed, retry the write" } });
		}

		// Same-bytes rewrites still count as activity: refresh the doc's 4h lifetime, or the
		// cleanup task scheduled for the old updatedAt expires the untouched proposal. An identical
		// re-write from another chat still means that chat touched the file.
		if (files_pending_update_content_is_stale(pendingUpdate, file)) {
			return Result({
				_nay: {
					message: pendingUpdate.contentNeedsRebase
						? PENDING_CONTENT_PREPARATION_MESSAGE
						: files_PENDING_UPDATE_STALE_BASE_MESSAGE,
				},
			});
		}
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
				currentYjsLastSequenceId: file.yjsLastSequenceId ?? null,
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
		/**
		 * `null` for a file with collaboration off: its sealed states carry no lineage.
		 */
		baseLineageGeneration: number | null;
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
			(state.lineageGeneration ?? null) !== args.baseLineageGeneration
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
		/**
		 * What the branches were built against. A collaborative file names its live sequence and
		 * lineage. A file with collaboration off names the content asset the branches were built
		 * from, and the commit refuses when a member's save moved the node to another asset.
		 */
		base: v.union(
			v.object({
				kind: v.literal("yjs"),
				baseYjsSequence: v.number(),
				baseLineageGeneration: v.number(),
				expectedYjsLastSequenceId: v.id("files_yjs_docs_last_sequences"),
			}),
			v.object({
				kind: v.literal("asset"),
				expectedAssetId: v.id("files_r2_assets"),
			}),
		),
		baseStateId: v.id("files_pending_update_yjs_states"),
		stagedStateId: v.id("files_pending_update_yjs_states"),
		unstagedStateId: v.id("files_pending_update_yjs_states"),
		baseStateDigest: v.string(),
		stagedStateDigest: v.string(),
		unstagedStateDigest: v.string(),
		unstagedText: v.string(),
		unstagedBranchChanged: v.boolean(),
		copiedFrom: v.optional(v.object({ nodeId: v.id("files_nodes"), path: v.string() })),
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
		_yay: v.object({
			pendingUpdate: v.union(doc(app_convex_schema, "files_pending_updates"), v.null()),
			currentYjsLastSequenceId: v.union(v.id("files_yjs_docs_last_sequences"), v.null()),
		}),
	}),
	handler: async (ctx, args) => {
		const file = await ctx.db.get("files_nodes", args.nodeId);
		if (
			!file ||
			file.organizationId !== args.organizationId ||
			file.workspaceId !== args.workspaceId ||
			!files_node_has_editable_text_content(file)
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
		const nodeWritable = await files_nodes_db_require_user_writable(ctx, { node: file, userId: args.userId });
		if (nodeWritable._nay) {
			return nodeWritable;
		}

		// The one bounded text this commit carries; the branch states were capped at seal.
		if (files_get_utf8_byte_size(args.unstagedText) > files_MAX_TEXT_CONTENT_BYTES) {
			return Result({ _nay: { message: `Text content exceeds ${files_MAX_TEXT_CONTENT_BYTES}-byte limit` } });
		}

		// Frontmatter caps, before any write: the calling action retires the staged input batch
		// on this refusal, so nothing durable is left behind.
		const frontmatterRefusal = files_pending_update_check_frontmatter_caps({
			fileNode: file,
			text: args.unstagedText,
		});
		if (frontmatterRefusal) {
			return frontmatterRefusal;
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

		// The base the outputs were built against must still be the file's current one.
		let baseLineageGeneration: number | null;
		if (args.base.kind === "asset") {
			// A member's save between the action's read and this commit moved the node to a new
			// content asset, so the branches are stale. Check this before the mode check below:
			// turning collaboration on also changes the asset, and the agent should read the stale
			// message and retry from the saved text instead of `Not found`.
			if (file.assetId !== args.base.expectedAssetId) {
				return Result({ _nay: { name: "pending_content_changed", message: PENDING_BASE_STALE_MESSAGE } });
			}
			if (file.collaborationEnabled !== false) {
				return Result({ _nay: { message: "Not found" } });
			}
			baseLineageGeneration = null;
		} else {
			// A lineage repair between the action's read and this commit makes the whole staged
			// operation stale: the outputs were built against a document that no longer exists.
			const lastSequenceDoc =
				file.yjsLastSequenceId === args.base.expectedYjsLastSequenceId
					? await ctx.db.get("files_yjs_docs_last_sequences", args.base.expectedYjsLastSequenceId)
					: null;
			if (!lastSequenceDoc || lastSequenceDoc.lineageGeneration !== args.base.baseLineageGeneration) {
				return Result({ _nay: { name: "pending_content_changed", message: PENDING_BASE_STALE_MESSAGE } });
			}
			baseLineageGeneration = args.base.baseLineageGeneration;
		}

		const stateValidation = await db_validate_batch_states_for_commit(ctx, {
			batch,
			phase: "output",
			baseLineageGeneration,
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
		if (existingPendingUpdate && files_pending_update_content_is_stale(existingPendingUpdate, file)) {
			return Result({
				_nay: {
					name: "pending_content_changed",
					message: existingPendingUpdate.contentNeedsRebase
						? PENDING_CONTENT_PREPARATION_MESSAGE
						: files_PENDING_UPDATE_STALE_BASE_MESSAGE,
				},
			});
		}
		if (args.expectedUpdatedAt === null) {
			if (existingPendingUpdate) {
				return Result({
					_nay: { name: "pending_content_changed", message: "Pending update changed, retry the write" },
				});
			}
		} else if (
			!existingPendingUpdate ||
			(args.pendingUpdateId != null && existingPendingUpdate._id !== args.pendingUpdateId) ||
			existingPendingUpdate.updatedAt !== args.expectedUpdatedAt
		) {
			return Result({ _nay: { name: "pending_content_changed", message: "Pending update changed, retry the write" } });
		}

		// Stamp the eager create with the sequence the creator captured in the mutation that
		// created the node — never a read taken here. See the eager-create field docs.
		const eagerCreated: app_convex_Doc<"files_pending_updates">["eagerCreated"] =
			args.eagerCreatedCommittedSequence !== undefined
				? {
						committedSequence: args.eagerCreatedCommittedSequence,
						...(args.eagerCreatedAncestorIds !== undefined ? { createdAncestorIds: args.eagerCreatedAncestorIds } : {}),
					}
				: undefined;

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
				...(args.base.kind === "yjs"
					? { baseYjsSequence: args.base.baseYjsSequence, baseLineageGeneration: args.base.baseLineageGeneration }
					: { baseAssetId: args.base.expectedAssetId }),
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
				// A doc never carries both base pointers.
				...(args.base.kind === "yjs"
					? {
							baseYjsSequence: args.base.baseYjsSequence,
							baseLineageGeneration: args.base.baseLineageGeneration,
							baseAssetId: undefined,
						}
					: { baseYjsSequence: undefined, baseLineageGeneration: undefined, baseAssetId: args.base.expectedAssetId }),
				baseStateId: args.baseStateId,
				stagedStateId: args.stagedStateId,
				unstagedStateId: args.unstagedStateId,
				// The newest structural intent wins: a later cp re-records where the content comes from.
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

		return Result({
			_yay: {
				pendingUpdate: await ctx.db.get("files_pending_updates", pendingUpdateId),
				currentYjsLastSequenceId: file.yjsLastSequenceId ?? null,
			},
		});
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

type commit_file_pending_update_upsert_in_db_Base =
	typeof commit_file_pending_update_upsert_in_db extends RegisteredMutation<
		infer _Visibility,
		infer Args,
		infer _ReturnValue
	>
		? Args["base"]
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
		expectedBaseStateId?: Id<"files_pending_update_yjs_states"> | null;
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
	const fileWritable = (await ctx.runQuery(internal.files_nodes.get_user_file_write_access, {
		organizationId: data.fileNode.organizationId,
		workspaceId: data.fileNode.workspaceId,
		nodeId: data.fileNode._id,
		userId: args.userId,
	})) as files_nodes_get_user_file_write_access_Result;
	if (fileWritable._nay) {
		await retireBatch();
		return fileWritable;
	}

	const existingPendingUpdate = data.existingPendingUpdate;
	if (existingPendingUpdate && files_pending_update_content_is_stale(existingPendingUpdate, data.fileNode)) {
		await retireBatch();
		return Result({
			_nay: {
				name: args.expectedBaseStateId !== undefined ? "pending_content_changed" : undefined,
				message: existingPendingUpdate.contentNeedsRebase
					? PENDING_CONTENT_PREPARATION_MESSAGE
					: files_PENDING_UPDATE_STALE_BASE_MESSAGE,
			},
		});
	}
	// Refuse an old proposal id if a new proposal has replaced it. With no current proposal,
	// the caller can still create a new one from its draft.
	if (args.pendingUpdateId != null && existingPendingUpdate && existingPendingUpdate._id !== args.pendingUpdateId) {
		await retireBatch();
		return Result({
			_nay: {
				name: args.expectedBaseStateId !== undefined ? "pending_content_changed" : undefined,
				message: "Not found",
			},
		});
	}

	// Edit and append build text from an earlier read. Preparation may have replaced that family
	// before this batch began, while keeping the same proposal id.
	if (
		args.expectedBaseStateId !== undefined &&
		(existingPendingUpdate?.baseStateId ?? null) !== args.expectedBaseStateId
	) {
		await retireBatch();
		return Result({
			_nay: {
				name: "pending_content_changed",
				message: "The proposal changed after it was read. Read the file again before editing it.",
			},
		});
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

	// A copy row carries the source's content type and shape. A text edit on top of it would turn
	// it into a plain edit in the file's old shape and silently drop that type, so the write waits
	// until the copy is accepted or discarded.
	if (existingPendingUpdate?.pendingReplacement) {
		await retireBatch();
		return Result({ _nay: { message: PENDING_REPLACEMENT_BLOCKS_WRITE_MESSAGE } });
	}

	if (!data.textInputRoles.includes("unstaged")) {
		await retireBatch();
		return Result({ _nay: { message: "Pending update text is not staged" } });
	}
	const unstagedTextRow = (await ctx.runQuery(
		internal.files_pending_updates.get_file_pending_update_text_input_internal,
		{
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			operationBatchId: args.operationBatchId,
			role: "unstaged",
		},
	)) as get_file_pending_update_text_input_internal_Result;
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

	const rootKind = data.fileNode.textKind;

	// Substrate: the proposal's existing branch family when it is still usable, otherwise a
	// fresh family. Move-only docs have no family and take the fresh one too.
	const existingYjsContent = existingPendingUpdate ? files_pending_update_yjs_content_of(existingPendingUpdate) : null;
	const existingAssetContent = existingPendingUpdate
		? files_pending_update_asset_content_of(existingPendingUpdate)
		: null;
	const loadBranchFamily = async (family: {
		baseStateId: Id<"files_pending_update_yjs_states">;
		stagedStateId: Id<"files_pending_update_yjs_states">;
		unstagedStateId: Id<"files_pending_update_yjs_states">;
	}) => {
		const [baseBytes, stagedBytes, unstagedBytes] = await Promise.all([
			action_load_pending_state_bytes(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				userId: args.userId,
				stateId: family.baseStateId,
			}),
			action_load_pending_state_bytes(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				userId: args.userId,
				stateId: family.stagedStateId,
			}),
			action_load_pending_state_bytes(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				userId: args.userId,
				stateId: family.unstagedStateId,
			}),
		]);
		if (baseBytes._nay || stagedBytes._nay || unstagedBytes._nay) {
			return null;
		}
		return {
			baseYjsDoc: files_yjs_doc_create_from_array_buffer_update(files_u8_to_array_buffer(baseBytes._yay)),
			stagedBranchYjsDoc: files_yjs_doc_create_from_array_buffer_update(files_u8_to_array_buffer(stagedBytes._yay)),
			unstagedBranchYjsDoc: files_yjs_doc_create_from_array_buffer_update(files_u8_to_array_buffer(unstagedBytes._yay)),
		};
	};

	let commitBase: commit_file_pending_update_upsert_in_db_Base;
	let branches: { baseYjsDoc: YDoc; stagedBranchYjsDoc: YDoc; unstagedBranchYjsDoc: YDoc };
	// True when the branches continue the doc's stored family. Only then can a same-bytes rewrite
	// refresh the doc instead of swapping the family.
	let reusedExistingFamily = false;
	if (data.base.kind === "yjs") {
		// A collaborative family is usable when it lives on the current lineage generation. A
		// stale-generation family (a repair replaced the document since) is unusable as a merge
		// substrate, so the newest write intent starts from the current live document and the
		// commit retires the old family.
		const liveBase = data.base;
		const existingContent =
			existingYjsContent && existingYjsContent.baseLineageGeneration === liveBase.lineageGeneration
				? existingYjsContent
				: null;
		if (existingContent) {
			const loaded = await loadBranchFamily(existingContent);
			if (!loaded) {
				await retireBatch();
				return Result({ _nay: { message: "Not found" } });
			}
			branches = loaded;
			reusedExistingFamily = true;
			commitBase = {
				kind: "yjs",
				baseYjsSequence: existingContent.baseYjsSequence,
				baseLineageGeneration: liveBase.lineageGeneration,
				expectedYjsLastSequenceId: liveBase.yjsLastSequenceId,
			};
		} else {
			const base = await files_pending_update_action_get_latest_file_yjs_state(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				nodeId: args.nodeId,
				targetSequence: liveBase.lastSequence,
			});
			if (base._nay) {
				await retireBatch();
				return Result({ _nay: { message: base._nay.message } });
			}
			branches = {
				baseYjsDoc: base._yay.baseYjsDoc,
				stagedBranchYjsDoc: files_yjs_doc_clone({ yjsDoc: base._yay.baseYjsDoc }),
				unstagedBranchYjsDoc: files_yjs_doc_clone({ yjsDoc: base._yay.baseYjsDoc }),
			};
			commitBase = {
				kind: "yjs",
				baseYjsSequence: base._yay.baseYjsSequence,
				baseLineageGeneration: liveBase.lineageGeneration,
				expectedYjsLastSequenceId: liveBase.yjsLastSequenceId,
			};
		}
	} else {
		// A file with collaboration off has no Yjs document. Its family is usable while the node's
		// content asset is still the one the branches were built from.
		const assetBase = data.base;
		const existingContent =
			existingAssetContent && existingAssetContent.baseAssetId === assetBase.baseAssetId ? existingAssetContent : null;
		if (existingContent) {
			const loaded = await loadBranchFamily(existingContent);
			if (!loaded) {
				await retireBatch();
				return Result({ _nay: { message: "Not found" } });
			}
			branches = loaded;
			reusedExistingFamily = true;
		} else {
			// Build the base branch from the committed text. For Markdown this is one parse and
			// serialize round trip, so the base text is the committed Markdown as the rich text
			// document renders it, not the committed bytes. Turning collaboration on rewrites the
			// file the same way.
			const baseYjsDoc = files_yjs_doc_create_from_text({ text: assetBase.committedText, rootKind });
			if ("_nay" in baseYjsDoc) {
				console.error("Failed to build the base branch from the committed text", {
					error: baseYjsDoc._nay,
					nodeId: args.nodeId,
				});
				await retireBatch();
				return Result({ _nay: { message: "Failed to build the base branch from the committed text" } });
			}
			branches = {
				baseYjsDoc,
				stagedBranchYjsDoc: files_yjs_doc_clone({ yjsDoc: baseYjsDoc }),
				unstagedBranchYjsDoc: files_yjs_doc_clone({ yjsDoc: baseYjsDoc }),
			};
		}
		commitBase = { kind: "asset", expectedAssetId: assetBase.baseAssetId };
	}
	const { baseYjsDoc, stagedBranchYjsDoc, unstagedBranchYjsDoc } = branches;

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

	// No-change docs normally delete/degrade, but eager-created docs (empty write_file /
	// empty-source copy) must persist: they store base == staged == unstaged so the family
	// survives and the eager-created node stays discardable.
	const hasChanges = stagedText._yay !== baseText._yay || unstagedText._yay !== baseText._yay;
	if (!hasChanges && !existingPendingUpdate?.eagerCreated && args.eagerCreatedCommittedSequence === undefined) {
		const settled = (await ctx.runMutation(internal.files_pending_updates.settle_file_pending_update_no_change_in_db, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			nodeId: args.nodeId,
			operationBatchId: args.operationBatchId,
			pendingUpdateId: existingPendingUpdate?._id,
			expectedUpdatedAt: existingPendingUpdate?.updatedAt ?? null,
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
			existingCopiedFrom.path === args.copiedFrom.path);
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
		reusedExistingFamily &&
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
	const sealedByRole = new Map<
		"base" | "staged" | "unstaged",
		{ stateId: Id<"files_pending_update_yjs_states">; digest: string }
	>();
	// A file with collaboration off has no lineage, so its seals answer `null`.
	const expectedLineageGeneration = data.base.kind === "yjs" ? data.base.lineageGeneration : null;
	let sealedLineageGeneration = expectedLineageGeneration;
	for (const output of outputs) {
		const bytes = new Uint8Array(output.update);
		for (let pageIndex = 0; pageIndex * files_MAX_YJS_WIRE_BYTES < bytes.byteLength; pageIndex++) {
			const pageStart = pageIndex * files_MAX_YJS_WIRE_BYTES;
			const staged = (await ctx.runMutation(
				internal.files_pending_updates.stage_file_pending_update_state_page_internal,
				{
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					userId: args.userId,
					operationBatchId: args.operationBatchId,
					phase: "output",
					role: output.role,
					pageIndex,
					bytes: bytes.slice(pageStart, pageStart + files_MAX_YJS_WIRE_BYTES).buffer as ArrayBuffer,
				},
			)) as stage_file_pending_update_state_page_internal_Result;
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
	if (sealedLineageGeneration !== expectedLineageGeneration) {
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
			base: commitBase,
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
		_yay: v.object({
			pendingUpdate: v.union(doc(app_convex_schema, "files_pending_updates"), v.null()),
			currentYjsLastSequenceId: v.union(v.id("files_yjs_docs_last_sequences"), v.null()),
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

		// No rate limit here: batch creation and every staging call already counted against the
		// same limit, so counting the finishing action too would cut the real write budget.
		const allowed = (await ctx.runQuery(internal.files_nodes.get_user_file_write_access, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: userAuth.id,
			nodeId: args.nodeId,
		})) as files_nodes_get_user_file_write_access_Result;
		if (allowed._nay) {
			return allowed;
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

		return Result({ _yay: upserted._yay });
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
		expectedBaseStateId: v.optional(v.union(v.id("files_pending_update_yjs_states"), v.null())),
		copiedFrom: v.optional(v.object({ nodeId: v.id("files_nodes"), path: v.string() })),
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
			/** True when the node only exists as a pending create and the move applied immediately. */
			appliedImmediately: v.boolean(),
		}),
	}),
	handler: async (ctx, args) => {
		const sourceNode = await ctx.db.get("files_nodes", args.nodeId);
		if (
			!sourceNode ||
			sourceNode.organizationId !== args.organizationId ||
			sourceNode.workspaceId !== args.workspaceId ||
			sourceNode.archiveOperationId !== null
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
						appliedImmediately: false,
					},
				});
			}
		}

		// A move changes the source, its descendants, and the destination folder.
		// Require all of them to be writable when creating the proposal.
		// Canceling an old move stays allowed because it only removes this user's pending proposal.
		const sourceWritable = await files_nodes_db_require_user_writable(ctx, { node: sourceNode, userId: args.userId });
		if (sourceWritable._nay) {
			return sourceWritable;
		}
		const subtreeWritable = await files_nodes_db_require_subtree_writable(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			writeContext: {
				writer: { kind: "user", userId: args.userId },
				actorUserId: args.userId,
				resourceScope: { kind: "workspace" },
				policyReach: "ancestors",
			},
			node: sourceNode,
		});
		if (subtreeWritable._nay) {
			return subtreeWritable;
		}

		const destinationParent =
			args.destParentId === files_ROOT_ID ? null : await ctx.db.get("files_nodes", args.destParentId);
		const destWritable =
			destinationParent === null
				? Result({ _yay: null })
				: await files_nodes_db_require_user_writable(ctx, { node: destinationParent, userId: args.userId });
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
			const occupantWritable = await files_nodes_db_require_user_writable(ctx, {
				node: replacesNode,
				userId: args.userId,
			});
			if (occupantWritable._nay) {
				return occupantWritable;
			}
			const occupantSubtreeWritable = await files_nodes_db_require_subtree_writable(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				writeContext: {
					writer: { kind: "user", userId: args.userId },
					actorUserId: args.userId,
					resourceScope: { kind: "workspace" },
					policyReach: "ancestors",
				},
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
		// Contributor set: an agent mv records its thread once per doc; client moves pass no threadId.
		const nextThreadIds =
			args.threadId && !existingPendingUpdate?.threadIds?.includes(args.threadId)
				? [...(existingPendingUpdate?.threadIds ?? []), args.threadId]
				: undefined;

		// A pending-created node has no committed file to review a move against: the move applies
		// to its pending change directly, like a manual sidebar move — the Added row follows the
		// new path. Only when the committed destination is free: a path the visible tree shows as
		// free because of another pending move still belongs to a committed node, and replacing an
		// occupant stays reviewable, so both fall through to the proposal below — except an
		// occupant that is itself only this user's unaccepted eager create: that replace applies
		// for real, the occupant is hard-deleted, and one Added row survives.
		if (existingPendingUpdate?.eagerCreated != null) {
			const committedOccupant = await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_parent_name_archiveOperation", (q) =>
					q
						.eq("organizationId", args.organizationId)
						.eq("workspaceId", args.workspaceId)
						.eq("parentId", args.destParentId)
						.eq("name", args.destName)
						.eq("archiveOperationId", null),
				)
				.first();
			// The occupant collapses only while it is still the near-empty node its proposal
			// created. Anything real on it — committed content, another member's pending doc, a
			// staged move or delete, or its own restricted scope — keeps the replace reviewable.
			let collapsibleOccupantPendingUpdate: app_convex_Doc<"files_pending_updates"> | null = null;
			if (
				committedOccupant &&
				committedOccupant._id !== node._id &&
				committedOccupant.restrictedScopeNodeId !== committedOccupant._id
			) {
				const occupantPendingUpdate = await files_db_get_pending_update(ctx, {
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					userId: args.userId,
					nodeId: committedOccupant._id,
				});
				if (
					occupantPendingUpdate?.eagerCreated &&
					!occupantPendingUpdate.pendingMove &&
					!occupantPendingUpdate.pendingArchive &&
					(await files_nodes_db_is_eager_node_safe_to_hard_delete(ctx, {
						organizationId: args.organizationId,
						workspaceId: args.workspaceId,
						nodeId: committedOccupant._id,
						pendingUpdate: occupantPendingUpdate,
					}))
				) {
					collapsibleOccupantPendingUpdate = occupantPendingUpdate;
				}
			}
			if (!committedOccupant || committedOccupant._id === node._id || collapsibleOccupantPendingUpdate) {
				// The pending path defers this check to accept; an immediate move asks it now.
				const authorizedLeaving = await authorize_leaving_restricted_scope(ctx, {
					userAuth: { id: args.userId },
					membership,
					fileNode: node,
					destParentId: args.destParentId,
				});
				if (authorizedLeaving._nay) {
					return authorizedLeaving;
				}
				const vacatedAncestorIds = existingPendingUpdate.eagerCreated.createdAncestorIds ?? [];
				const occupantAncestorIds = collapsibleOccupantPendingUpdate?.eagerCreated?.createdAncestorIds ?? [];
				if (collapsibleOccupantPendingUpdate && committedOccupant) {
					// The hard delete takes the occupant's pending doc with it and hands its staged
					// copy asset to the deletion ledger.
					await files_nodes_db_hard_delete_node(ctx, {
						organizationId: args.organizationId,
						workspaceId: args.workspaceId,
						nodeId: committedOccupant._id,
					});
				}
				await files_nodes_db_apply_node_move(ctx, {
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					node,
					destParentId: args.destParentId,
					destName: args.destName,
					destPath,
					updatedBy: args.userId,
					now,
				});
				let survivingAncestorIds: Id<"files_nodes">[] | undefined;
				if (collapsibleOccupantPendingUpdate) {
					// The folders either create committed are cleaned up now if they were left
					// empty (off the destination chain); the destination chain itself holds the
					// moved file, so those folders stay and become the surviving row's created
					// ancestors for a later discard.
					await files_nodes_db_remove_created_ancestor_folders_if_safe(ctx, {
						organizationId: args.organizationId,
						workspaceId: args.workspaceId,
						userId: args.userId,
						createdAncestorIds: vacatedAncestorIds,
					});
					await files_nodes_db_remove_created_ancestor_folders_if_safe(ctx, {
						organizationId: args.organizationId,
						workspaceId: args.workspaceId,
						userId: args.userId,
						createdAncestorIds: occupantAncestorIds,
					});
					survivingAncestorIds = (
						await Promise.all(
							[...new Set([...vacatedAncestorIds, ...occupantAncestorIds])].map((ancestorId) =>
								ctx.db.get("files_nodes", ancestorId),
							),
						)
					)
						.filter(
							(ancestor): ancestor is NonNullable<typeof ancestor> =>
								ancestor != null && destPath.startsWith(`${ancestor.path}/`),
						)
						.sort((a, b) => b.pathDepth - a.pathDepth)
						.map((ancestor) => ancestor._id);
				}
				// A pending move already on the doc (staged before this rule) is settled for real.
				if (existingPendingUpdate.pendingMove) {
					await files_pending_update_db_settle_move_row(ctx, { pendingUpdate: existingPendingUpdate });
				}
				// The mv still touched this proposal: record its thread and refresh the row's
				// expiry, or a moved Added file could die on the creation-time deadline. A
				// collapsed occupant's contributing threads move onto the surviving row.
				const settledAt = Date.now();
				const mergedThreadIds = collapsibleOccupantPendingUpdate
					? [
							...new Set([
								...(nextThreadIds ?? existingPendingUpdate.threadIds ?? []),
								...(collapsibleOccupantPendingUpdate.threadIds ?? []),
							]),
						]
					: nextThreadIds;
				await Promise.all([
					ctx.db.patch("files_pending_updates", existingPendingUpdate._id, {
						...(mergedThreadIds && mergedThreadIds.length > 0 ? { threadIds: mergedThreadIds } : {}),
						...(survivingAncestorIds
							? {
									eagerCreated: {
										committedSequence: existingPendingUpdate.eagerCreated.committedSequence,
										createdAncestorIds: survivingAncestorIds,
									},
								}
							: {}),
						updatedAt: settledAt,
					}),
					files_db_schedule_pending_update_cleanup(ctx, {
						pendingUpdateId: existingPendingUpdate._id,
						expectedUpdatedAt: settledAt,
					}),
				]);
				return Result({
					_yay: {
						fromPath: node.path,
						destPath,
						replacesExistingOccupant: false,
						cancelledExistingMove: false,
						appliedImmediately: true,
					},
				});
			}
		}

		const pendingMove = {
			destParentId: args.destParentId,
			destName: args.destName,
			fromPath: node.path,
			...(replacesNode ? { replacesNodeId: replacesNode._id } : {}),
		};
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
				appliedImmediately: false,
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
			node.archiveOperationId !== null
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
		const nodeWritable = await files_nodes_db_require_user_writable(ctx, { node: node, userId: args.userId });
		if (nodeWritable._nay) {
			return nodeWritable;
		}
		const subtreeWritable = await files_nodes_db_require_subtree_writable(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			writeContext: {
				writer: { kind: "user", userId: args.userId },
				actorUserId: args.userId,
				resourceScope: { kind: "workspace" },
				policyReach: "ancestors",
			},
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
			if (
				await files_pending_update_db_remove_eager_created_node_if_safe(ctx, { pendingUpdate: existingPendingUpdate })
			) {
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
			node.archiveOperationId !== null
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
		const nodeWritable = await files_nodes_db_require_user_writable(ctx, { node: node, userId: userAuth.id });
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
				(descendantFileNode) => descendantFileNode.archiveOperationId === null,
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
				const descendantWritable = await files_nodes_db_require_user_writable(ctx, {
					node: descendantFileNode,
					userId: userAuth.id,
				});
				if (descendantWritable._nay) {
					return descendantWritable;
				}
			}

			// Do not hide a read-only archived descendant under this newly archived folder.
			// The user may not see that node, so return a general error if it blocks the write.
			const archivedDescendants = descendantFileNodes.filter(
				(descendantFileNode) => descendantFileNode.archiveOperationId !== null,
			);
			const archivedProtected = await files_nodes_db_require_swept_nodes_writable(ctx, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				writeContext: {
					writer: { kind: "user", userId: userAuth.id },
					actorUserId: userAuth.id,
					resourceScope: { kind: "workspace" },
					policyReach: "ancestors",
				},
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
			// A whole-file copy owns a staged object. Release it before the doc goes.
			if (pendingUpdate.pendingReplacement) {
				await files_pending_update_db_release_replacement_asset(ctx, {
					organizationId: membership.organizationId,
					workspaceId: membership.workspaceId,
					assetId: pendingUpdate.pendingReplacement.assetId,
				});
			}
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

		// A whole-file copy is discarded as a whole: release the staged object, and remove an
		// eager-created destination like a discarded copy. A move on the same doc survives.
		if (pendingUpdate.pendingReplacement) {
			await files_pending_update_db_release_replacement_asset(ctx, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				assetId: pendingUpdate.pendingReplacement.assetId,
			});
			if (await files_pending_update_db_remove_eager_created_node_if_safe(ctx, { pendingUpdate })) {
				return Result({ _yay: null });
			}
			if (pendingUpdate.pendingMove) {
				const now = Date.now();
				await Promise.all([
					ctx.db.patch("files_pending_updates", pendingUpdate._id, {
						pendingReplacement: undefined,
						copiedFrom: undefined,
						size: 0,
						updatedAt: now,
					}),
					files_pending_update_db_delete_chunks(ctx, { pendingUpdateId: pendingUpdate._id }),
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
				files_pending_update_db_delete_chunks(ctx, { pendingUpdateId: pendingUpdate._id }),
				ctx.db.delete("files_pending_updates", pendingUpdate._id),
			]);
			return Result({ _yay: null });
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
			!files_node_has_editable_text_content(fileNode)
		) {
			return Result({ _nay: { message: "Not found" } });
		}
		const rootKind = fileNode.textKind;
		// Collaboration off: a member saved the file after this proposal was made. The proposal can
		// never be accepted, so Discard removes the whole content proposal below.
		const stale = files_pending_update_content_is_stale(pendingUpdate, fileNode);

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
		const stagedBranchYjsDoc = files_yjs_doc_create_from_array_buffer_update(
			files_u8_to_array_buffer(stagedBytes._yay),
		);
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
		// no-change rule as the upsert flow applies: eager-created docs persist. A stale proposal
		// goes the same way, whatever its branches hold.
		if (stale || (stagedText._yay === baseText._yay && !pendingUpdate.eagerCreated)) {
			// A move or delete proposed on the same doc stays; only the content goes.
			if (pendingUpdate.pendingMove || pendingUpdate.pendingArchive) {
				const now = Date.now();
				await Promise.all([
					ctx.db.patch("files_pending_updates", pendingUpdate._id, {
						baseYjsSequence: undefined,
						baseLineageGeneration: undefined,
						baseAssetId: undefined,
						baseStateId: undefined,
						stagedStateId: undefined,
						unstagedStateId: undefined,
						contentNeedsRebase: undefined,
						contentRebaseRootKind: undefined,
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
			lineageGeneration: pendingUpdate.baseLineageGeneration,
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
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		nodeId: v.id("files_nodes"),
		pendingUpdateId: v.id("files_pending_updates"),
		operationBatchId: v.id("files_pending_update_operation_batches"),
		expectedUpdatedAt: v.number(),
		base: v.union(
			v.object({
				kind: v.literal("yjs"),
				baseYjsSequence: v.number(),
				baseLineageGeneration: v.number(),
				expectedYjsLastSequenceId: v.id("files_yjs_docs_last_sequences"),
			}),
			v.object({ kind: v.literal("asset"), expectedAssetId: v.id("files_r2_assets") }),
		),
		preparation: v.optional(
			v.object({
				sourceBaseStateId: v.id("files_pending_update_yjs_states"),
				sourceStagedStateId: v.id("files_pending_update_yjs_states"),
				sourceUnstagedStateId: v.id("files_pending_update_yjs_states"),
				rootKind: v.union(v.literal("plain_text"), v.literal("rich_text")),
				hasChanges: v.boolean(),
			}),
		),
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
		const user = await ctx.db.get("users", args.userId);
		if (!user || user.deletedAt !== undefined) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}
		const userAuth = { id: args.userId };
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
		const nodeWritable = await files_nodes_db_require_user_writable(ctx, {
			node: authorized._yay.fileNode,
			userId: args.userId,
		});
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
		if (args.preparation) {
			if (
				existingContent.baseStateId !== args.preparation.sourceBaseStateId ||
				existingContent.stagedStateId !== args.preparation.sourceStagedStateId ||
				existingContent.unstagedStateId !== args.preparation.sourceUnstagedStateId
			) {
				return Result({ _nay: { message: "Pending update changed, retry the write" } });
			}
		} else if (existingPendingUpdate.contentNeedsRebase) {
			return Result({ _nay: { message: PENDING_CONTENT_PREPARATION_MESSAGE } });
		}

		// Only the exact doc state the action worked from.
		if (existingPendingUpdate.updatedAt !== args.expectedUpdatedAt) {
			return Result({ _nay: { message: "Pending update changed, retry the write" } });
		}

		// The doc's base only advances to live sequences, so a captured base below it means
		// the sync inputs predate the doc's last save (e.g. another tab's save landing while
		// this sync was in flight). Reject before any write; the caller must re-read.
		if (!args.preparation) {
			const yjsContent = files_pending_update_yjs_content_of(existingPendingUpdate);
			if (!yjsContent || args.base.kind !== "yjs") return Result({ _nay: { message: "Not found" } });
			if (args.base.baseYjsSequence < yjsContent.baseYjsSequence) {
				return Result({ _nay: { message: "Stale save" } });
			}
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
		if (args.preparation && fileNode.textKind !== args.preparation.rootKind) {
			return Result({ _nay: { message: "Not found" } });
		}
		// Frontmatter caps, before any write: the calling action retires the staged input batch
		// on this refusal, so nothing durable is left behind.
		const frontmatterRefusal = files_pending_update_check_frontmatter_caps({
			fileNode,
			text: args.unstagedText,
		});
		if (frontmatterRefusal) {
			return frontmatterRefusal;
		}

		// The live document must still be exactly where the action read it: a commit or a
		// lineage repair that landed during the action makes the staged operation stale.
		if (args.base.kind === "yjs") {
			const lastSequenceDoc =
				fileNode.yjsLastSequenceId === args.base.expectedYjsLastSequenceId
					? await ctx.db.get("files_yjs_docs_last_sequences", args.base.expectedYjsLastSequenceId)
					: null;
			if (
				lastSequenceDoc?.lastSequence !== args.base.baseYjsSequence ||
				lastSequenceDoc.lineageGeneration !== args.base.baseLineageGeneration
			) {
				return Result({ _nay: { message: PENDING_BASE_STALE_MESSAGE } });
			}
		} else if (fileNode.collaborationEnabled !== false || fileNode.assetId !== args.base.expectedAssetId) {
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
			phase: args.preparation ? "output" : "input",
			baseLineageGeneration: args.base.kind === "yjs" ? args.base.baseLineageGeneration : null,
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
		if (args.preparation && !args.preparation.hasChanges && !existingPendingUpdate.eagerCreated) {
			await files_db_expire_pending_update_operation_batch(ctx, { operationBatchId: batch._id });
			await files_db_retire_pending_update_yjs_states(ctx, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				pendingUpdateId: existingPendingUpdate._id,
			});
			await files_pending_update_db_delete_chunks(ctx, { pendingUpdateId: existingPendingUpdate._id });
			if (existingPendingUpdate.pendingMove || existingPendingUpdate.pendingArchive) {
				await ctx.db.patch("files_pending_updates", existingPendingUpdate._id, {
					baseYjsSequence: undefined,
					baseLineageGeneration: undefined,
					baseAssetId: undefined,
					baseStateId: undefined,
					stagedStateId: undefined,
					unstagedStateId: undefined,
					contentNeedsRebase: undefined,
					contentRebaseRootKind: undefined,
					copiedFrom: undefined,
					size: 0,
					updatedAt: now,
				});
				await files_db_schedule_pending_update_cleanup(ctx, {
					pendingUpdateId: existingPendingUpdate._id,
					expectedUpdatedAt: now,
				});
				return Result({
					_yay: { pendingUpdate: await ctx.db.get("files_pending_updates", existingPendingUpdate._id) },
				});
			}
			await files_db_cancel_pending_update_cleanup_tasks(ctx, { pendingUpdateId: existingPendingUpdate._id });
			await ctx.db.delete("files_pending_updates", existingPendingUpdate._id);
			return Result({ _yay: { pendingUpdate: null } });
		}
		await ctx.db.patch("files_pending_updates", existingPendingUpdate._id, {
			baseYjsSequence: args.base.kind === "yjs" ? args.base.baseYjsSequence : undefined,
			baseLineageGeneration: args.base.kind === "yjs" ? args.base.baseLineageGeneration : undefined,
			baseAssetId: args.base.kind === "asset" ? args.base.expectedAssetId : undefined,
			contentNeedsRebase: undefined,
			contentRebaseRootKind: undefined,
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

async function prepare_pending_update(
	ctx: ActionCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
		nodeId: Id<"files_nodes">;
		pendingUpdateId?: Id<"files_pending_updates">;
	},
): Promise<
	| { _yay: { pendingUpdate: app_convex_Doc<"files_pending_updates"> | null }; _nay?: undefined }
	| { _nay: { name?: string; message: string }; _yay?: undefined }
> {
	const data = (await ctx.runQuery(internal.files_pending_updates.get_data_for_pending_content_operation, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		userId: args.userId,
		nodeId: args.nodeId,
		pendingUpdateId: args.pendingUpdateId,
	})) as get_data_for_pending_content_operation_Result;
	const pendingUpdate = data?.existingPendingUpdate;
	if (!data || (args.pendingUpdateId !== undefined && pendingUpdate?._id !== args.pendingUpdateId)) {
		return Result({ _nay: { message: "Not found" } });
	}
	if (!pendingUpdate) return Result({ _yay: { pendingUpdate: null } });

	const writable = (await ctx.runQuery(internal.files_nodes.get_user_file_write_access, {
		organizationId: data.fileNode.organizationId,
		workspaceId: data.fileNode.workspaceId,
		nodeId: data.fileNode._id,
		userId: args.userId,
	})) as files_nodes_get_user_file_write_access_Result;
	if (writable._nay) return writable;

	const content = files_pending_update_content_of(pendingUpdate);
	if (!content) return Result({ _yay: { pendingUpdate } });

	const yjsContent = files_pending_update_yjs_content_of(pendingUpdate);
	const liveChanged =
		data.base.kind === "yjs" &&
		yjsContent &&
		(yjsContent.baseYjsSequence !== data.base.lastSequence ||
			yjsContent.baseLineageGeneration !== data.base.lineageGeneration);
	if (!files_pending_update_content_is_stale(pendingUpdate, data.fileNode) && !liveChanged)
		return Result({ _yay: { pendingUpdate } });

	const batch = (await ctx.runMutation(
		internal.files_pending_updates.create_file_pending_update_operation_batch_internal,
		{
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			nodeId: args.nodeId,
		},
	)) as create_file_pending_update_operation_batch_internal_Result;
	if (batch._nay) return Result({ _nay: { message: batch._nay.message } });

	const operationBatchId = batch._yay.operationBatchId;
	let committed = false;
	try {
		const sourceBytes = await Promise.all(
			[content.baseStateId, content.stagedStateId, content.unstagedStateId].map((stateId) =>
				action_load_pending_state_bytes(ctx, {
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					userId: args.userId,
					stateId,
				}),
			),
		);

		const rootKind = data.fileNode.textKind;
		const sourceTexts: string[] = [];
		for (const bytes of sourceBytes) {
			if (bytes._nay) return Result({ _nay: { message: bytes._nay.message } });
			let sourceDoc: YDoc;
			try {
				sourceDoc = files_yjs_doc_create_from_array_buffer_update(files_u8_to_array_buffer(bytes._yay));
			} catch {
				return Result({ _nay: { message: "Could not read the saved proposal" } });
			}
			const text = files_yjs_doc_get_text({
				yjsDoc: sourceDoc,
				rootKind: pendingUpdate.contentRebaseRootKind ?? rootKind,
			});
			sourceDoc.destroy();
			if (text._nay) return Result({ _nay: { message: text._nay.message } });
			sourceTexts.push(text._yay);
		}

		let baseDoc: YDoc;
		if (data.base.kind === "yjs") {
			const live = await files_pending_update_action_get_latest_file_yjs_state(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				nodeId: args.nodeId,
				targetSequence: data.base.lastSequence,
			});
			if (live._nay) return Result({ _nay: { message: live._nay.message } });
			baseDoc = live._yay.baseYjsDoc;
		} else {
			const built = files_yjs_doc_create_from_text({ text: data.base.committedText, rootKind });
			if ("_nay" in built) return Result({ _nay: { message: built._nay.message } });
			baseDoc = built;
		}

		const current = files_yjs_doc_get_text({ yjsDoc: baseDoc, rootKind });
		if (current._nay) return Result({ _nay: { message: current._nay.message } });

		const staged = files_pending_text_merge({
			baseText: sourceTexts[0]!,
			proposedText: sourceTexts[1]!,
			currentText: current._yay,
		});
		if (staged._nay) return Result({ _nay: { message: staged._nay.message } });

		const unstaged = files_pending_text_merge({
			baseText: sourceTexts[0]!,
			proposedText: sourceTexts[2]!,
			currentText: current._yay,
		});
		if (unstaged._nay) return Result({ _nay: { message: unstaged._nay.message } });

		const stagedDoc = files_yjs_doc_clone({ yjsDoc: baseDoc });
		const stagedUpdate = files_yjs_doc_update_from_text({ mut_yjsDoc: stagedDoc, text: staged._yay, rootKind });
		if (stagedUpdate._nay) return Result({ _nay: { message: stagedUpdate._nay.message } });

		const unstagedDoc = files_yjs_doc_clone({ yjsDoc: stagedDoc });
		const unstagedUpdate = files_yjs_doc_update_from_text({
			mut_yjsDoc: unstagedDoc,
			text: unstaged._yay,
			rootKind,
		});
		if (unstagedUpdate._nay) return Result({ _nay: { message: unstagedUpdate._nay.message } });

		const outputs = [
			{ role: "base" as const, yjsDoc: baseDoc },
			{ role: "staged" as const, yjsDoc: stagedDoc },
			{ role: "unstaged" as const, yjsDoc: unstagedDoc },
		];
		const sealedByRole = new Map<
			"base" | "staged" | "unstaged",
			{ stateId: Id<"files_pending_update_yjs_states">; digest: string }
		>();
		const texts = new Map<"base" | "staged" | "unstaged", string>();
		for (const output of outputs) {
			const text = files_yjs_doc_get_text({ yjsDoc: output.yjsDoc, rootKind });
			if (text._nay) return Result({ _nay: { message: text._nay.message } });
			if (files_get_utf8_byte_size(text._yay) > files_MAX_TEXT_CONTENT_BYTES)
				return Result({ _nay: { message: `Text content exceeds ${files_MAX_TEXT_CONTENT_BYTES}-byte limit` } });
			const frontmatter = files_pending_update_check_frontmatter_caps({ fileNode: data.fileNode, text: text._yay });
			if (frontmatter) return frontmatter;

			texts.set(output.role, text._yay);
			const bytes = new Uint8Array(files_pending_update_encode_yjs_state_update({ yjsDoc: output.yjsDoc }));
			output.yjsDoc.destroy();
			if (bytes.byteLength > files_MAX_YJS_RECONSTRUCTED_STATE_BYTES)
				return Result({ _nay: { message: `State exceeds ${files_MAX_YJS_RECONSTRUCTED_STATE_BYTES}-byte limit` } });

			for (let pageIndex = 0; pageIndex * files_MAX_YJS_WIRE_BYTES < bytes.byteLength; pageIndex++) {
				const page = (await ctx.runMutation(
					internal.files_pending_updates.stage_file_pending_update_state_page_internal,
					{
						organizationId: args.organizationId,
						workspaceId: args.workspaceId,
						userId: args.userId,
						operationBatchId,
						phase: "output",
						role: output.role,
						pageIndex,
						bytes: files_u8_to_array_buffer(
							bytes.slice(pageIndex * files_MAX_YJS_WIRE_BYTES, (pageIndex + 1) * files_MAX_YJS_WIRE_BYTES),
						),
					},
				)) as stage_file_pending_update_state_page_internal_Result;
				if (page._nay) return Result({ _nay: { message: page._nay.message } });
			}

			const sealed = (await ctx.runMutation(internal.files_pending_updates.seal_file_pending_update_state_internal, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				userId: args.userId,
				operationBatchId,
				phase: "output",
				role: output.role,
				expectedTotalBytes: bytes.byteLength,
			})) as seal_file_pending_update_state_internal_Result;
			if (sealed._nay) return Result({ _nay: { message: sealed._nay.message } });
			sealedByRole.set(output.role, sealed._yay);
		}

		const baseState = sealedByRole.get("base")!;
		const stagedState = sealedByRole.get("staged")!;
		const unstagedState = sealedByRole.get("unstaged")!;
		const result = (await ctx.runMutation(internal.files_pending_updates.commit_file_pending_update_rebase_in_db, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			nodeId: args.nodeId,
			pendingUpdateId: pendingUpdate._id,
			operationBatchId,
			expectedUpdatedAt: pendingUpdate.updatedAt,
			base:
				data.base.kind === "yjs"
					? {
							kind: "yjs",
							baseYjsSequence: data.base.lastSequence,
							baseLineageGeneration: data.base.lineageGeneration,
							expectedYjsLastSequenceId: data.base.yjsLastSequenceId,
						}
					: { kind: "asset", expectedAssetId: data.base.baseAssetId },
			preparation: {
				sourceBaseStateId: content.baseStateId,
				sourceStagedStateId: content.stagedStateId,
				sourceUnstagedStateId: content.unstagedStateId,
				rootKind,
				hasChanges: texts.get("staged") !== texts.get("base") || texts.get("unstaged") !== texts.get("base"),
			},
			baseStateId: baseState.stateId,
			stagedStateId: stagedState.stateId,
			unstagedStateId: unstagedState.stateId,
			baseStateDigest: baseState.digest,
			stagedStateDigest: stagedState.digest,
			unstagedStateDigest: unstagedState.digest,
			unstagedText: texts.get("unstaged")!,
		})) as commit_file_pending_update_rebase_in_db_Result;
		committed = !result._nay;
		return result;
	} finally {
		if (!committed)
			await ctx.runMutation(internal.files_pending_updates.retire_file_pending_update_operation_batch, {
				operationBatchId,
			});
	}
}

export const prepare_file_pending_update_for_review = action({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
		pendingUpdateId: v.id("files_pending_updates"),
	},
	returns: v_result({
		_yay: v.object({ pendingUpdate: v.union(doc(app_convex_schema, "files_pending_updates"), v.null()) }),
	}),
	handler: async (
		ctx,
		args,
	): Promise<
		| { _yay: { pendingUpdate: app_convex_Doc<"files_pending_updates"> | null }; _nay?: undefined }
		| { _nay: { name?: string; message: string }; _yay?: undefined }
	> => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		const user = userAuth ? await ctx.runQuery(internal.users.get, { userId: userAuth.id }) : null;
		if (!userAuth || !user || (userAuth.kind === "anonymous" && user.deletedAt !== undefined)) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const membership = await ctx.runQuery(api.organizations.get_membership, { membershipId: args.membershipId });
		if (!membership || membership.userId !== userAuth.id) return Result({ _nay: { message: "Unauthorized" } });

		const allowed = (await ctx.runQuery(internal.files_nodes.get_user_file_write_access, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: userAuth.id,
			nodeId: args.nodeId,
		})) as files_nodes_get_user_file_write_access_Result;
		if (allowed._nay) {
			return allowed;
		}

		return prepare_pending_update(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: userAuth.id,
			nodeId: args.nodeId,
			pendingUpdateId: args.pendingUpdateId,
		});
	},
});

export const prepare_file_pending_update_for_agent = internalAction({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		nodeId: v.id("files_nodes"),
	},
	returns: v_result({
		_yay: v.object({ pendingUpdate: v.union(doc(app_convex_schema, "files_pending_updates"), v.null()) }),
	}),
	handler: prepare_pending_update,
});

export type prepare_file_pending_update_for_agent_Result =
	typeof prepare_file_pending_update_for_agent extends RegisteredAction<
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
		reviewedUpdatedAt: v.optional(v.number()),
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
		const allowed = (await ctx.runQuery(internal.files_nodes.get_user_file_write_access, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: userAuth.id,
			nodeId: args.nodeId,
		})) as files_nodes_get_user_file_write_access_Result;
		if (allowed._nay) {
			return allowed;
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
		// Sync rebases the branches onto the live Yjs document. A file with collaboration off has
		// none and hides the Sync button, so refuse instead of guessing a base.
		const liveBase = data.base;
		if (liveBase.kind !== "yjs") {
			await retireBatch();
			return Result({ _nay: { message: "Not found" } });
		}

		// Check the lock before loading Yjs state. The final write checks it again.
		const fileWritable = (await ctx.runQuery(internal.files_nodes.get_user_file_write_access, {
			organizationId: data.fileNode.organizationId,
			workspaceId: data.fileNode.workspaceId,
			nodeId: data.fileNode._id,
			userId: userAuth.id,
		})) as files_nodes_get_user_file_write_access_Result;
		if (fileWritable._nay) {
			await retireBatch();
			return fileWritable;
		}

		// Every cheap refusal precedes any state decode: staleness first.
		if (liveBase.lastSequence !== args.baseYjsSequence) {
			await retireBatch();
			return Result({ _nay: { message: PENDING_BASE_STALE_MESSAGE } });
		}

		// Update-only, and only the exact doc the client synced (see the commit mutation).
		const existingPendingUpdate = data.existingPendingUpdate;
		if (args.reviewedUpdatedAt !== undefined && existingPendingUpdate?.updatedAt !== args.reviewedUpdatedAt) {
			await retireBatch();
			return Result({ _nay: { message: "The proposal changed while it was being synced" } });
		}
		if (existingPendingUpdate?.contentNeedsRebase) {
			await retireBatch();
			return Result({ _nay: { message: PENDING_CONTENT_PREPARATION_MESSAGE } });
		}
		if (
			!existingPendingUpdate ||
			(args.pendingUpdateId != null && existingPendingUpdate._id !== args.pendingUpdateId)
		) {
			await retireBatch();
			return Result({ _nay: { message: "Not found" } });
		}
		const existingContent = files_pending_update_yjs_content_of(existingPendingUpdate);
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
			baseInput.lineageGeneration !== liveBase.lineageGeneration ||
			stagedInput.lineageGeneration !== liveBase.lineageGeneration ||
			unstagedInput.lineageGeneration !== liveBase.lineageGeneration
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

		const rootKind = data.fileNode.textKind;
		const baseYjsDoc = files_yjs_doc_create_from_array_buffer_update(files_u8_to_array_buffer(baseBytes._yay));
		const stagedBranchYjsDoc = files_yjs_doc_create_from_array_buffer_update(
			files_u8_to_array_buffer(stagedBytes._yay),
		);
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

		// No-change docs normally delete/degrade, but eager-created docs must persist: they store
		// base == staged == unstaged so the family survives and the eager-created node stays
		// discardable.
		const hasChanges = stagedText._yay !== baseText._yay || unstagedText._yay !== baseText._yay;
		if (!hasChanges && !existingPendingUpdate.eagerCreated) {
			const settled = (await ctx.runMutation(
				internal.files_pending_updates.settle_file_pending_update_no_change_in_db,
				{
					organizationId: membership.organizationId,
					workspaceId: membership.workspaceId,
					userId: userAuth.id,
					nodeId: args.nodeId,
					operationBatchId: args.operationBatchId,
					pendingUpdateId: existingPendingUpdate._id,
					expectedUpdatedAt: existingPendingUpdate.updatedAt,
				},
			)) as settle_file_pending_update_no_change_in_db_Result;
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
			existingContent.baseLineageGeneration === liveBase.lineageGeneration &&
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
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: userAuth.id,
				nodeId: args.nodeId,
				pendingUpdateId: existingPendingUpdate._id,
				operationBatchId: args.operationBatchId,
				expectedUpdatedAt: existingPendingUpdate.updatedAt,
				base: {
					kind: "yjs",
					baseYjsSequence: args.baseYjsSequence,
					baseLineageGeneration: liveBase.lineageGeneration,
					expectedYjsLastSequenceId: liveBase.yjsLastSequenceId,
				},
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
	returns: v.union(
		v.object({
			...doc(app_convex_schema, "files_pending_updates").fields,
			currentYjsLastSequenceId: v.union(v.id("files_yjs_docs_last_sequences"), v.null()),
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

		const pendingUpdate = await files_db_get_pending_update(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: userAuth.id,
			nodeId: args.nodeId,
			pendingUpdateId: args.pendingUpdateId,
		});
		if (!pendingUpdate) {
			return null;
		}
		return {
			...pendingUpdate,
			currentYjsLastSequenceId: authorized._yay.fileNode.yjsLastSequenceId ?? null,
		};
	},
});

export const normalize_file_pending_update_id = internalQuery({
	args: {
		pendingUpdateId: v.string(),
	},
	returns: v.union(v.id("files_pending_updates"), v.null()),
	handler: async (ctx, args) => {
		return ctx.db.normalizeId("files_pending_updates", args.pendingUpdateId);
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

export const save_file_pending_update_in_db = internalMutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
		pendingUpdateId: v.id("files_pending_updates"),
		expectedUpdatedAt: v.number(),
		baseYjsSequence: v.number(),
		baseLineageGeneration: v.number(),
		expectedYjsLastSequenceId: v.id("files_yjs_docs_last_sequences"),
		/**
		 * The staged accept diff to publish through door 1; absent when nothing staged changed.
		 */
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

		// The target file can be removed after the proposal, e.g. from the Files UI. Fail before
		// any writes, or the save would bill and publish onto a dead file. The doc stays intact.
		// An archived target still saves: the archive only hides the node, its content stays
		// writable, and unarchiving later shows the saved text.
		const targetNode = await ctx.db.get("files_nodes", args.nodeId);
		if (
			!targetNode ||
			targetNode.organizationId !== membership.organizationId ||
			targetNode.workspaceId !== membership.workspaceId ||
			!files_node_has_editable_yjs_state(targetNode)
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
		const targetWritable = await files_nodes_db_require_user_writable(ctx, { node: targetNode, userId: userAuth.id });
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

		if (pendingUpdate.contentNeedsRebase) {
			return Result({ _nay: { message: PENDING_CONTENT_PREPARATION_MESSAGE } });
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

		const pendingUpdateContent = files_pending_update_yjs_content_of(pendingUpdate);
		if (!pendingUpdateContent) {
			// Move-only docs have nothing to publish; Accept goes through
			// apply_file_pending_move instead.
			return Result({
				_nay: {
					message: "No content to save",
				},
			});
		}

		// The file must still have the Yjs sequence used to build this diff.
		// Refuse before writes or billing if another save or repair changed that sequence.
		const lastSequenceDoc =
			targetNode.yjsLastSequenceId === args.expectedYjsLastSequenceId
				? await ctx.db.get("files_yjs_docs_last_sequences", args.expectedYjsLastSequenceId)
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
				text: args.partial.unstagedText,
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
				expectedYjsLastSequenceId: args.expectedYjsLastSequenceId,
				rootKind: targetNode.textKind,
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
			// Bill with the lineage id too. Turning collaboration off and on again starts a new
			// lineage at sequence 0, so the sequence alone would repeat an id Polar has already seen.
			const saveVersion = `${args.expectedYjsLastSequenceId}:${result._yay.newSequence}`;
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
								saveVersion,
							),
							metadata: {
								amount: 1,
								actorUserId: user._id,
								billedUserId: billedUser._id,
								organizationId: membership.organizationId,
								workspaceId: membership.workspaceId,
								nodeId: args.nodeId,
								version: saveVersion,
							},
						}),
					},
				],
			});
		}

		const now = Date.now();
		const nextBaseYjsSequence = newSequence ?? args.baseYjsSequence;

		// Full consume: the unstaged branch matches the saved result, so the proposal is done.
		if (!args.partial) {
			if (pendingUpdate.pendingMove) {
				// Save publishes the content only; the move proposal survives as a move-only doc.
				// The content is committed now, so expiry must never hard-delete the node: clear the
				// eager-create stamp (and the now-stale copy provenance).
				await Promise.all([
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
						contentNeedsRebase: undefined,
						contentRebaseRootKind: undefined,
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

/**
 * Commit an accepted proposal on a file with collaboration off. The staged text becomes the
 * file's committed text through the same writes as a member save, and one `file_save` is billed.
 * `publish` is null when the staged branch equals the base and nothing is left unstaged (the
 * action returns earlier while unstaged edits remain): the file is left alone, and the doc is
 * settled the same way. The result carries the doc's `updatedAt` after the save, or null when the
 * save deleted the doc, so the diff view can wait for its doc query to show the save.
 */
export const save_file_pending_update_non_collaborative_in_db = internalMutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
		pendingUpdateId: v.id("files_pending_updates"),
		expectedUpdatedAt: v.number(),
		/**
		 * The staged text, already uploaded under the version snapshot asset.
		 */
		publish: v.union(
			v.object({
				text: v.string(),
				textSize: v.number(),
				versionSnapshotAssetId: v.id("files_r2_assets"),
			}),
			v.null(),
		),
		/**
		 * Present when unstaged edits survive the save: the sealed output family that replaces the
		 * canonical states (base = staged = the published staged branch, unstaged as it was). The
		 * file has no other writer to merge, so the unstaged text and its chunks stay unchanged.
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
			}),
		),
	},
	returns: v_result({ _yay: v.object({ updatedAt: v.union(v.number(), v.null()) }) }),
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

		// The target file can be removed or switched to collaboration after the proposal.
		// Fail before any write, or the save would bill and publish onto it. An archived
		// target still saves: the archive only hides the node.
		const targetNode = await ctx.db.get("files_nodes", args.nodeId);
		if (
			!targetNode ||
			targetNode.organizationId !== membership.organizationId ||
			targetNode.workspaceId !== membership.workspaceId ||
			targetNode.collaborationEnabled !== false ||
			!files_node_has_editable_text_content(targetNode)
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
		const targetWritable = await files_nodes_db_require_user_writable(ctx, { node: targetNode, userId: userAuth.id });
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
		// Only the exact doc the action worked from, unchanged since: see the same checks in
		// `save_file_pending_update_in_db`.
		if (!pendingUpdate || pendingUpdate._id !== args.pendingUpdateId) {
			return Result({ _nay: { message: "Not found" } });
		}
		if (pendingUpdate.updatedAt !== args.expectedUpdatedAt) {
			return Result({ _nay: { message: "Stale save" } });
		}
		if (pendingUpdate.pendingArchive) {
			return Result({ _nay: { message: "File has a pending delete" } });
		}
		if (pendingUpdate.contentNeedsRebase) {
			return Result({ _nay: { message: PENDING_CONTENT_PREPARATION_MESSAGE } });
		}
		const content = files_pending_update_asset_content_of(pendingUpdate);
		if (!content) {
			return Result({ _nay: { message: "No content to save" } });
		}
		// A member saved the file after this proposal was made (the action checked too, but a save
		// can land between the two). Refuse before writes or billing.
		if (files_pending_update_content_is_stale(pendingUpdate, targetNode)) {
			return Result({ _nay: { message: files_PENDING_UPDATE_STALE_BASE_MESSAGE } });
		}

		// Validate the partial-output family before any write, so a refusal leaves nothing behind.
		let partialBatch: app_convex_Doc<"files_pending_update_operation_batches"> | null = null;
		if (args.partial) {
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
				// The file has no Yjs document, so its states carry no lineage.
				baseLineageGeneration: null,
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

		if (args.publish) {
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
			const billedUserId = billing_pick_billed_user_id({ userId: user._id, organization });
			const billedUser = await ctx.db.get("users", billedUserId);
			if (!billedUser) {
				const errorMessage = "billedUserId points to a missing users doc";
				const errorData = { userId: user._id, organizationId: organization._id, billedUserId };
				console.error(errorMessage, errorData);
				throw should_never_happen(errorMessage, errorData);
			}

			// The accept costs the same as a member save on this file and as an accept on a
			// collaborative file.
			const check = await billing_db_check_credits(ctx, { userId: billedUser._id, minimumRequiredCents: 1 });
			if (!check.hasCredits) {
				return Result({ _nay: { message: "Insufficient funds" } });
			}

			await files_nodes_db_commit_text_replacement(ctx, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				fileNode: targetNode,
				userId: user._id,
				text: args.publish.text,
				textSize: args.publish.textSize,
				versionSnapshotAssetId: args.publish.versionSnapshotAssetId,
			});

			// The version snapshot asset is the save's id, like the member save door. The node has
			// no Yjs sequence to bill with.
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
								args.publish.versionSnapshotAssetId,
							),
							metadata: {
								amount: 1,
								actorUserId: user._id,
								billedUserId: billedUser._id,
								organizationId: membership.organizationId,
								workspaceId: membership.workspaceId,
								nodeId: args.nodeId,
								version: args.publish.versionSnapshotAssetId,
							},
						}),
					},
				],
			});
		}

		const now = Date.now();

		// Full consume: nothing unstaged survives, so the proposal is done.
		if (!args.partial) {
			if (pendingUpdate.pendingMove) {
				// Save publishes the content only; the move proposal survives as a move-only doc.
				// The content is committed now, so expiry must never hard-delete the node: clear the
				// eager-create stamp (and the now-stale copy provenance).
				await Promise.all([
					ctx.db.patch("files_pending_updates", pendingUpdate._id, {
						baseAssetId: undefined,
						baseStateId: undefined,
						stagedStateId: undefined,
						unstagedStateId: undefined,
						contentNeedsRebase: undefined,
						contentRebaseRootKind: undefined,
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

				return Result({ _yay: { updatedAt: now } });
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

			return Result({ _yay: { updatedAt: null } });
		}

		// Partial save: unstaged edits survive on the published text. Swap the canonical family to
		// the sealed outputs the action staged and point the base at the new content asset.
		const partial = args.partial;
		if (!partialBatch) {
			// Validated above; keeps the compiler honest.
			return Result({ _nay: { message: "Not found" } });
		}
		await Promise.all([
			ctx.db.patch("files_pending_updates", pendingUpdate._id, {
				baseAssetId: args.publish ? args.publish.versionSnapshotAssetId : content.baseAssetId,
				baseStateId: partial.baseStateId,
				stagedStateId: partial.stagedStateId,
				unstagedStateId: partial.unstagedStateId,
				// Content is committed from here on, so expiry must never hard-delete the node.
				copiedFrom: undefined,
				eagerCreated: undefined,
				updatedAt: now,
			}),
			// Partial saves must keep the pending update alive. Reset the expire of the pending update doc.
			files_db_schedule_pending_update_cleanup(ctx, {
				pendingUpdateId: pendingUpdate._id,
				expectedUpdatedAt: now,
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

		return Result({ _yay: { updatedAt: now } });
	},
});

type save_file_pending_update_non_collaborative_in_db_Result =
	typeof save_file_pending_update_non_collaborative_in_db extends RegisteredMutation<
		infer _Visibility,
		infer _Args,
		infer ReturnValue
	>
		? Awaited<ReturnValue>
		: never;

/**
 * Accept on a file with collaboration off. There is no live Yjs document to merge into, so the
 * staged branch is published the way a member save is: upload the staged text as a version
 * snapshot, then commit it in one mutation. Unstaged edits survive as a proposal on the new text.
 */
async function action_save_file_pending_update_non_collaborative(
	ctx: ActionCtx,
	args: {
		membershipId: Id<"organizations_workspaces_users">;
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
		nodeId: Id<"files_nodes">;
		pendingUpdateId: Id<"files_pending_updates"> | undefined;
		data: NonNullable<get_data_for_pending_content_operation_Result>;
	},
) {
	const { data } = args;
	const assetBase = data.base;
	if (assetBase.kind !== "asset") {
		return Result({ _nay: { message: "Not found" } });
	}

	// Limit here, before the branch loads and the snapshot upload below, like `replace_file_content`
	// does. The collaborative Accept limits inside its commit mutation instead, because it writes
	// nothing outside the database first.
	const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "save_file_pending_update", key: args.userId });
	if (rateLimit) {
		return Result({ _nay: { message: rateLimit.message } });
	}

	// Only the exact doc the client had open; the commit mutation rechecks all of this.
	const pendingUpdate = data.existingPendingUpdate;
	if (!pendingUpdate || (args.pendingUpdateId != null && pendingUpdate._id !== args.pendingUpdateId)) {
		return Result({ _nay: { message: "Not found" } });
	}
	if (pendingUpdate.contentNeedsRebase) {
		return Result({ _nay: { message: PENDING_CONTENT_PREPARATION_MESSAGE } });
	}
	if (pendingUpdate.pendingArchive) {
		return Result({ _nay: { message: "File has a pending delete" } });
	}
	const content = files_pending_update_asset_content_of(pendingUpdate);
	if (!content) {
		return Result({ _nay: { message: "No content to save" } });
	}
	// A member saved the file after this proposal was made. Prepare it before saving.
	if (content.baseAssetId !== assetBase.baseAssetId) {
		return Result({ _nay: { message: files_PENDING_UPDATE_STALE_BASE_MESSAGE } });
	}

	// Check the current lock before loading the branches. The final write checks it again.
	const fileWritable = (await ctx.runQuery(internal.files_nodes.get_user_file_write_access, {
		organizationId: data.fileNode.organizationId,
		workspaceId: data.fileNode.workspaceId,
		nodeId: data.fileNode._id,
		userId: args.userId,
	})) as files_nodes_get_user_file_write_access_Result;
	if (fileWritable._nay) {
		return fileWritable;
	}

	const rootKind = data.fileNode.textKind;

	const [baseBytes, stagedBytes, unstagedBytes] = await Promise.all([
		action_load_pending_state_bytes(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			stateId: content.baseStateId,
		}),
		action_load_pending_state_bytes(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			stateId: content.stagedStateId,
		}),
		action_load_pending_state_bytes(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			stateId: content.unstagedStateId,
		}),
	]);
	if (baseBytes._nay || stagedBytes._nay || unstagedBytes._nay) {
		return Result({ _nay: { message: "Not found" } });
	}
	const baseYjsDoc = files_yjs_doc_create_from_array_buffer_update(files_u8_to_array_buffer(baseBytes._yay));
	const stagedBranchYjsDoc = files_yjs_doc_create_from_array_buffer_update(files_u8_to_array_buffer(stagedBytes._yay));
	const unstagedBranchYjsDoc = files_yjs_doc_create_from_array_buffer_update(
		files_u8_to_array_buffer(unstagedBytes._yay),
	);

	const baseText = files_yjs_doc_get_text({ yjsDoc: baseYjsDoc, rootKind });
	const stagedText = files_yjs_doc_get_text({ yjsDoc: stagedBranchYjsDoc, rootKind });
	const unstagedText = files_yjs_doc_get_text({ yjsDoc: unstagedBranchYjsDoc, rootKind });
	if (baseText._nay || stagedText._nay || unstagedText._nay) {
		console.error("Failed to read the pending branches as text", {
			error: baseText._nay ?? stagedText._nay ?? unstagedText._nay,
			nodeId: args.nodeId,
			pendingUpdateId: pendingUpdate._id,
		});
		return Result({ _nay: { message: "Failed to read the pending branches as text" } });
	}

	// Publish only when an accepted hunk changed the staged branch. Unstaged edits survive the
	// save when they differ from it.
	const publish = stagedText._yay !== baseText._yay;
	const partial = unstagedText._yay !== stagedText._yay;
	// Nothing accepted yet: the file stays as it is, and so does the doc. There is no other writer
	// whose changes would have to be folded into the branches.
	if (!publish && partial) {
		return Result({ _yay: { newSequence: null, pendingUpdateUpdatedAt: pendingUpdate.updatedAt } });
	}

	// Upload the staged text under a version snapshot asset before the commit, like the member
	// save door. The commit points the node at it.
	let upload: {
		text: string;
		textSize: number;
		versionSnapshotAssetId: Id<"files_r2_assets">;
		r2Key: string;
	} | null = null;
	const releaseUpload = async () => {
		if (!upload) {
			return;
		}
		// The upload is unreferenced now. Hand its key to the deletion ledger in one mutation, so it
		// is deleted soon instead of waiting for the unfinalized-asset sweep.
		await ctx.runMutation(internal.files_nodes_content.cleanup_file_node_creation_assets, {
			assetIds: [upload.versionSnapshotAssetId],
			r2Keys: [upload.r2Key],
			durableTenantScope: { organizationId: args.organizationId, workspaceId: args.workspaceId },
		});
	};
	if (publish) {
		const creditCheck = await ctx.runQuery(internal.billing.check_credits, {
			userId: args.userId,
			organizationId: args.organizationId,
			minimumRequiredCents: 1,
		});
		if (!creditCheck.hasCredits) {
			return Result({ _nay: { message: "Insufficient funds" } });
		}

		// The staged text was normalized when it was staged. The caps are checked again because
		// this text becomes the file, the same as the member save door does.
		const textSize = files_get_utf8_byte_size(stagedText._yay);
		if (textSize > files_MAX_TEXT_CONTENT_BYTES) {
			return Result({ _nay: { message: `Text content exceeds ${files_MAX_TEXT_CONTENT_BYTES}-byte limit` } });
		}
		const frontmatterRefusal = files_pending_update_check_frontmatter_caps({
			fileNode: data.fileNode,
			text: stagedText._yay,
		});
		if (frontmatterRefusal) {
			return frontmatterRefusal;
		}

		const versionSnapshotAssetId = (await ctx.runMutation(internal.r2.insert_asset, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			kind: "content_snapshot",
			size: textSize,
			createdBy: args.userId,
		})) as Id<"files_r2_assets">;
		const r2Key = r2_create_asset_key({
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			assetId: versionSnapshotAssetId,
		});
		// The version object carries the node's stored text type. The snapshot signer pins it
		// again when it serves the object.
		await r2_put_object(ctx, {
			key: r2Key,
			body: stagedText._yay,
			contentType:
				files_editable_text_content_type_of(data.fileNode.contentType) ??
				("application/octet-stream" satisfies files_ContentType),
		});
		upload = { text: stagedText._yay, textSize, versionSnapshotAssetId, r2Key };
	}

	// Partial save: stage and seal the replacement family (base = staged = the staged branch,
	// unstaged as it is), then commit by metadata id.
	let operationBatchId: Id<"files_pending_update_operation_batches"> | undefined;
	const retireBatch = async () => {
		if (!operationBatchId) {
			return;
		}
		await ctx.runMutation(internal.files_pending_updates.retire_file_pending_update_operation_batch, {
			operationBatchId,
		});
	};
	let partialFamily: {
		operationBatchId: Id<"files_pending_update_operation_batches">;
		base: { stateId: Id<"files_pending_update_yjs_states">; digest: string };
		staged: { stateId: Id<"files_pending_update_yjs_states">; digest: string };
		unstaged: { stateId: Id<"files_pending_update_yjs_states">; digest: string };
	} | null = null;
	if (partial) {
		const batchCreated = (await ctx.runMutation(
			internal.files_pending_updates.create_file_pending_update_operation_batch_internal,
			{
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				userId: args.userId,
				nodeId: args.nodeId,
			},
		)) as create_file_pending_update_operation_batch_internal_Result;
		if (batchCreated._nay) {
			await releaseUpload();
			return Result({ _nay: batchCreated._nay });
		}
		operationBatchId = batchCreated._yay.operationBatchId;

		const nextBaseYjsUpdate = files_pending_update_encode_yjs_state_update({ yjsDoc: stagedBranchYjsDoc });
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
				await Promise.all([retireBatch(), releaseUpload()]);
				return Result({
					_nay: { message: `State exceeds ${files_MAX_YJS_RECONSTRUCTED_STATE_BYTES}-byte limit` },
				});
			}
		}

		const sealedByRole = new Map<
			"base" | "staged" | "unstaged",
			{ stateId: Id<"files_pending_update_yjs_states">; digest: string }
		>();
		for (const output of outputs) {
			const bytes = new Uint8Array(output.update);
			for (let pageIndex = 0; pageIndex * files_MAX_YJS_WIRE_BYTES < bytes.byteLength; pageIndex++) {
				const pageStart = pageIndex * files_MAX_YJS_WIRE_BYTES;
				const stagedPage = (await ctx.runMutation(
					internal.files_pending_updates.stage_file_pending_update_state_page_internal,
					{
						organizationId: args.organizationId,
						workspaceId: args.workspaceId,
						userId: args.userId,
						operationBatchId,
						phase: "output",
						role: output.role,
						pageIndex,
						bytes: bytes.slice(pageStart, pageStart + files_MAX_YJS_WIRE_BYTES).buffer as ArrayBuffer,
					},
				)) as stage_file_pending_update_state_page_internal_Result;
				if (stagedPage._nay) {
					await Promise.all([retireBatch(), releaseUpload()]);
					return Result({ _nay: { message: stagedPage._nay.message } });
				}
			}

			const sealed = (await ctx.runMutation(internal.files_pending_updates.seal_file_pending_update_state_internal, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				userId: args.userId,
				operationBatchId,
				phase: "output",
				role: output.role,
				expectedTotalBytes: output.update.byteLength,
			})) as seal_file_pending_update_state_internal_Result;
			if (sealed._nay) {
				// The seal already retired the batch family on refusal.
				await releaseUpload();
				return Result({ _nay: { message: sealed._nay.message } });
			}
			// The file has no lineage. A number here means collaboration was turned on mid-accept: the
			// ON toggle dropped this doc, so answer the way the commit below does.
			if (sealed._yay.lineageGeneration !== null) {
				await Promise.all([retireBatch(), releaseUpload()]);
				return Result({ _nay: { message: "Not found" } });
			}
			sealedByRole.set(output.role, { stateId: sealed._yay.stateId, digest: sealed._yay.digest });
		}

		const base = sealedByRole.get("base");
		const staged = sealedByRole.get("staged");
		const unstaged = sealedByRole.get("unstaged");
		if (!base || !staged || !unstaged) {
			await Promise.all([retireBatch(), releaseUpload()]);
			return Result({ _nay: { message: "Not found" } });
		}
		partialFamily = { operationBatchId, base, staged, unstaged };
	}

	// A commit that throws rolls its own writes back, but the batch and sealed output family live
	// in already-committed mutations. Retire them before rethrowing. The upload stays for the
	// unfinalized-asset sweep, the same as the member save door.
	let saved: save_file_pending_update_non_collaborative_in_db_Result;
	try {
		saved = (await ctx.runMutation(internal.files_pending_updates.save_file_pending_update_non_collaborative_in_db, {
			membershipId: args.membershipId,
			nodeId: args.nodeId,
			pendingUpdateId: pendingUpdate._id,
			expectedUpdatedAt: pendingUpdate.updatedAt,
			publish: upload
				? { text: upload.text, textSize: upload.textSize, versionSnapshotAssetId: upload.versionSnapshotAssetId }
				: null,
			partial: partialFamily
				? {
						operationBatchId: partialFamily.operationBatchId,
						baseStateId: partialFamily.base.stateId,
						stagedStateId: partialFamily.staged.stateId,
						unstagedStateId: partialFamily.unstaged.stateId,
						baseStateDigest: partialFamily.base.digest,
						stagedStateDigest: partialFamily.staged.digest,
						unstagedStateDigest: partialFamily.unstaged.digest,
					}
				: undefined,
		})) as save_file_pending_update_non_collaborative_in_db_Result;
	} catch (error) {
		await retireBatch();
		throw error;
	}
	if (saved._nay) {
		// A commit refusal ends this operation too: without the retire, the surviving batch would
		// refuse this user/node's next operation ("already in progress") until the TTL.
		await Promise.all([retireBatch(), releaseUpload()]);
		return Result({ _nay: saved._nay });
	}

	return Result({ _yay: { newSequence: null, pendingUpdateUpdatedAt: saved._yay.updatedAt } });
}

/**
 * Hand-written like `files_content_public_action_Result` in `files_nodes_content.ts`. The explicit
 * handler annotation breaks the same-file generated-API circularity: the dispatch below returns a
 * call whose arguments read the uncast `api.organizations.get_membership` result.
 */
type save_file_pending_update_Result =
	| { _yay: { newSequence: number | null; pendingUpdateUpdatedAt?: number | null }; _nay?: undefined }
	| { _nay: { name?: string; message: string }; _yay?: undefined };

export const save_file_pending_update = action({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
		pendingUpdateId: v.optional(v.id("files_pending_updates")),
		reviewedUpdatedAt: v.optional(v.number()),
	},
	returns: v_result({
		_yay: v.object({
			newSequence: v.union(v.number(), v.null()),
			/**
			 * Set on a file with collaboration off: the doc's `updatedAt` after the save, or null when
			 * the save deleted the doc. The diff view keeps its busy state until its doc query shows
			 * that, because the query can deliver the save later than this result.
			 */
			pendingUpdateUpdatedAt: v.optional(v.union(v.number(), v.null())),
		}),
	}),
	handler: async (ctx, args): Promise<save_file_pending_update_Result> => {
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

		// Same as `persist_file_pending_update_rebased_state` above: the permission check goes
		// through a query that asks about this file. The rate limit sits in the commit mutation for
		// a collaborative file and at the top of `action_save_file_pending_update_non_collaborative`
		// for the other mode.
		const allowed = (await ctx.runQuery(internal.files_nodes.get_user_file_write_access, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: userAuth.id,
			nodeId: args.nodeId,
		})) as files_nodes_get_user_file_write_access_Result;
		if (allowed._nay) {
			return allowed;
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
		if (args.reviewedUpdatedAt !== undefined && data.existingPendingUpdate?.updatedAt !== args.reviewedUpdatedAt) {
			return Result({ _nay: { message: "The proposal changed after it was reviewed" } });
		}
		if (data.existingPendingUpdate?.contentNeedsRebase) {
			return Result({ _nay: { message: PENDING_CONTENT_PREPARATION_MESSAGE } });
		}
		// A file with collaboration off has no Yjs document to merge into. Its Accept publishes the
		// staged text the way a member save does.
		if (data.base.kind === "asset") {
			return await action_save_file_pending_update_non_collaborative(ctx, {
				membershipId: args.membershipId,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: userAuth.id,
				nodeId: args.nodeId,
				pendingUpdateId: args.pendingUpdateId,
				data,
			});
		}
		const liveBase = data.base;

		// Only the exact doc the client had open; the commit mutation rechecks all of this.
		const pendingUpdate = data.existingPendingUpdate;
		if (!pendingUpdate || (args.pendingUpdateId != null && pendingUpdate._id !== args.pendingUpdateId)) {
			return Result({ _nay: { message: "Not found" } });
		}
		if (pendingUpdate.pendingArchive) {
			return Result({ _nay: { message: "File has a pending delete" } });
		}
		const content = files_pending_update_yjs_content_of(pendingUpdate);
		if (!content) {
			return Result({ _nay: { message: "No content to save" } });
		}
		// Prepare branches from an older document history before saving them.
		if (content.baseLineageGeneration !== liveBase.lineageGeneration) {
			return Result({ _nay: { message: PENDING_BASE_STALE_MESSAGE } });
		}

		// Check the current lock before loading Yjs state. The final write checks it again.
		const fileWritable = (await ctx.runQuery(internal.files_nodes.get_user_file_write_access, {
			organizationId: data.fileNode.organizationId,
			workspaceId: data.fileNode.workspaceId,
			nodeId: data.fileNode._id,
			userId: userAuth.id,
		})) as files_nodes_get_user_file_write_access_Result;
		if (fileWritable._nay) {
			return fileWritable;
		}

		const rootKind = data.fileNode.textKind;

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
			targetSequence: liveBase.lastSequence,
		});
		if (live._nay) {
			return Result({ _nay: { message: live._nay.message } });
		}

		const latestFileYjsDoc = live._yay.baseYjsDoc;
		const currentText = files_yjs_doc_get_text({ yjsDoc: latestFileYjsDoc, rootKind });
		if (currentText._nay) return Result({ _nay: { message: currentText._nay.message } });
		const sourceTexts: string[] = [];
		for (const bytes of [baseBytes._yay, stagedBytes._yay, unstagedBytes._yay]) {
			const sourceDoc = files_yjs_doc_create_from_array_buffer_update(files_u8_to_array_buffer(bytes));
			const text = files_yjs_doc_get_text({ yjsDoc: sourceDoc, rootKind });
			sourceDoc.destroy();
			if (text._nay) return Result({ _nay: { message: text._nay.message } });
			sourceTexts.push(text._yay);
		}
		const stagedText = files_pending_text_merge({
			baseText: sourceTexts[0]!,
			proposedText: sourceTexts[1]!,
			currentText: currentText._yay,
		});
		if (stagedText._nay) return Result({ _nay: { message: stagedText._nay.message } });
		const unstagedText = files_pending_text_merge({
			baseText: sourceTexts[0]!,
			proposedText: sourceTexts[2]!,
			currentText: currentText._yay,
		});
		if (unstagedText._nay) return Result({ _nay: { message: unstagedText._nay.message } });

		// Publish the accepted lines on current history. Later agent edits stay only in U.
		const liveFileYjsDocAfterSave = files_yjs_doc_clone({ yjsDoc: latestFileYjsDoc });
		const appliedStaged = files_yjs_doc_update_from_text({
			mut_yjsDoc: liveFileYjsDocAfterSave,
			text: stagedText._yay,
			rootKind,
		});
		if (appliedStaged._nay) return Result({ _nay: { message: appliedStaged._nay.message } });
		const unstagedBranchYjsDoc = files_yjs_doc_clone({ yjsDoc: liveFileYjsDocAfterSave });
		const appliedUnstaged = files_yjs_doc_update_from_text({
			mut_yjsDoc: unstagedBranchYjsDoc,
			text: unstagedText._yay,
			rootKind,
		});
		if (appliedUnstaged._nay) return Result({ _nay: { message: appliedUnstaged._nay.message } });
		const diffUpdateForLatestFileYjsDoc = files_yjs_compute_diff_update_from_yjs_doc({
			yjsDoc: liveFileYjsDocAfterSave,
			yjsBeforeDoc: latestFileYjsDoc,
		});

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
				baseYjsSequence: liveBase.lastSequence,
				baseLineageGeneration: liveBase.lineageGeneration,
				expectedYjsLastSequenceId: liveBase.yjsLastSequenceId,
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
		let sealedLineageGeneration: number | null = liveBase.lineageGeneration;
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

		if (sealedLineageGeneration !== liveBase.lineageGeneration) {
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
				baseYjsSequence: liveBase.lastSequence,
				baseLineageGeneration: liveBase.lineageGeneration,
				expectedYjsLastSequenceId: liveBase.yjsLastSequenceId,
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
					unstagedTextChanged: unstagedText._yay !== sourceTexts[2],
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

// #region whole-file replacement

/**
 * Accept refuses a whole-file replacement when the destination changed after the copy was
 * proposed, so a copy never overwrites content the reviewer never saw.
 */
export const files_PENDING_REPLACEMENT_BASE_CHANGED_MESSAGE =
	"The file changed after this copy was proposed. Discard the copy and copy again.";

/**
 * Accept refuses when an edit reached the document while it ran. The copy is still valid, so
 * the user only needs to accept it again, and that run keeps the edit as a version.
 */
export const files_PENDING_REPLACEMENT_EDITED_DURING_ACCEPT_MESSAGE =
	"The file was edited while the copy was being accepted. Accept the copy again.";

const PENDING_REPLACEMENT_SOURCE_CHANGED_MESSAGE = "The source file changed while it was being copied. Copy again.";

/**
 * Hand a staged replacement asset to the deletion ledger and delete its doc.
 *
 * The staged object sits under its final key, so the unfinalized-asset sweeper never touches it.
 * Only this release removes it. Discard, expiry, a write that supersedes the copy, a refused
 * commit, and account deletion all call it.
 */
export async function files_pending_update_db_release_replacement_asset(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		assetId: Id<"files_r2_assets">;
	},
) {
	const asset = await ctx.db.get("files_r2_assets", args.assetId);
	if (!asset || asset.organizationId !== args.organizationId || asset.workspaceId !== args.workspaceId) {
		return;
	}

	// Add the job before deleting the doc. Both save together, so a crash cannot lose the cleanup.
	await r2_enqueue_object_deletion_job(ctx, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		r2Key: r2_create_asset_key({
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			assetId: asset._id,
		}),
		reason: "discarded_replacement",
	});
	await ctx.db.delete("files_r2_assets", asset._id);
}

/**
 * Everything the stage action needs, read in one query, so the source's type, shape, mode, and
 * content asset come from the same version of the source node.
 */
export const get_data_for_pending_replacement_stage = internalQuery({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		nodeId: v.id("files_nodes"),
		sourceNodeId: v.id("files_nodes"),
	},
	returns: v.union(
		v.object({
			destNode: doc(app_convex_schema, "files_nodes"),
			sourceNode: doc(app_convex_schema, "files_nodes"),
			sourceAsset: v.union(doc(app_convex_schema, "files_r2_assets"), v.null()),
			existingPendingUpdate: v.union(doc(app_convex_schema, "files_pending_updates"), v.null()),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const [destNode, sourceNode] = await Promise.all([
			ctx.db.get("files_nodes", args.nodeId),
			ctx.db.get("files_nodes", args.sourceNodeId),
		]);
		if (
			!destNode ||
			destNode.organizationId !== args.organizationId ||
			destNode.workspaceId !== args.workspaceId ||
			destNode.kind !== "file" ||
			!sourceNode ||
			sourceNode.organizationId !== args.organizationId ||
			sourceNode.workspaceId !== args.workspaceId ||
			sourceNode.kind !== "file"
		) {
			return null;
		}

		// The destination takes a write. The source only has to be readable.
		if (
			!(await access_control_db_can_act_on_file_node(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				userId: args.userId,
				fileNode: destNode,
				permission: "content.write",
			}))
		) {
			return null;
		}
		const [readableSource] = await access_control_db_filter_readable_file_nodes(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			nodes: [sourceNode],
		});
		if (!readableSource) {
			return null;
		}

		const [sourceAsset, existingPendingUpdate] = await Promise.all([
			sourceNode.assetId ? ctx.db.get("files_r2_assets", sourceNode.assetId) : Promise.resolve(null),
			files_db_get_pending_update(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				userId: args.userId,
				nodeId: args.nodeId,
			}),
		]);

		return { destNode, sourceNode, sourceAsset, existingPendingUpdate };
	},
});

type get_data_for_pending_replacement_stage_Result =
	typeof get_data_for_pending_replacement_stage extends RegisteredQuery<
		infer _Visibility,
		infer _Args,
		infer ReturnValue
	>
		? Awaited<ReturnValue>
		: never;

/**
 * The visible Result shapes of the replacement doors. Hand-written on purpose: the bash `cp`
 * command sits inside the generated-API type graph, and inferring these from the registered
 * functions there would make the generated API collapse to `any`.
 */
export type files_pending_updates_stage_file_pending_replacement_Result =
	| { _yay: { pendingUpdateId: Id<"files_pending_updates"> }; _nay?: undefined }
	| { _yay?: undefined; _nay: { name?: string; message: string } };

export type files_pending_updates_accept_file_pending_replacement_Result =
	| { _yay: null; _nay?: undefined }
	| { _yay?: undefined; _nay: { name?: string; message: string } };

/**
 * Stage a whole-file replacement of `nodeId` with a copy of the source file (`cp` onto an app
 * path). The copy carries the source's content, content type, document shape, and collaboration
 * mode. The user reviews it as a whole and accepts it with `accept_file_pending_replacement`.
 *
 * The source is frozen now. A text source is stored as the text the caller read (through the
 * caller's own pending overlay) under a new content object. A stored source is copied on the R2
 * server side to a new object. Later source changes never reach the proposal.
 */
export const stage_file_pending_replacement_internal_action = internalAction({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		nodeId: v.id("files_nodes"),
		source: v.object({ nodeId: v.id("files_nodes"), path: v.string() }),
		/**
		 * The source's content asset the caller read. The stage refuses when the source moved on.
		 */
		expectedSourceAssetId: v.id("files_r2_assets"),
		/**
		 * The source text the caller read, for an editable text source. Absent for stored bytes.
		 */
		sourceText: v.optional(v.string()),
		eagerCreatedCommittedSequence: v.optional(v.number()),
		eagerCreatedAncestorIds: v.optional(v.array(v.id("files_nodes"))),
		threadId: v.optional(v.id("ai_chat_threads")),
	},
	returns: v_result({ _yay: v.object({ pendingUpdateId: v.id("files_pending_updates") }) }),
	handler: async (ctx, args): Promise<files_pending_updates_stage_file_pending_replacement_Result> => {
		const data = (await ctx.runQuery(internal.files_pending_updates.get_data_for_pending_replacement_stage, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			nodeId: args.nodeId,
			sourceNodeId: args.source.nodeId,
		})) as get_data_for_pending_replacement_stage_Result;
		if (!data) {
			return Result({ _nay: { message: "Not found" } });
		}
		const writable = (await ctx.runQuery(internal.files_nodes.get_user_file_write_access, {
			organizationId: data.destNode.organizationId,
			workspaceId: data.destNode.workspaceId,
			nodeId: data.destNode._id,
			userId: args.userId,
		})) as files_nodes_get_user_file_write_access_Result;
		if (writable._nay) {
			return writable;
		}
		// The caller read the source's type and its content in two steps. Refuse when the source's
		// content asset moved between them, so the type of one version never labels the bytes of
		// another.
		if (data.sourceNode.assetId !== args.expectedSourceAssetId) {
			return Result({ _nay: { message: PENDING_REPLACEMENT_SOURCE_CHANGED_MESSAGE } });
		}
		if (data.destNode.assetId === null) {
			return Result({ _nay: { message: "Not found" } });
		}
		const baseAssetId = data.destNode.assetId;

		const sourceShape = files_editable_text_shape_of(data.sourceNode.contentType);
		let replacement: NonNullable<app_convex_Doc<"files_pending_updates">["pendingReplacement"]>;
		let text: string | undefined;
		if (sourceShape !== null && files_node_has_editable_text_content(data.sourceNode)) {
			if (args.sourceText === undefined) {
				return Result({ _nay: { message: "The source text is missing" } });
			}
			text = files_normalize_text_document_input(args.sourceText);
			const size = files_get_utf8_byte_size(text);
			if (size > files_MAX_TEXT_CONTENT_BYTES) {
				return Result({ _nay: { message: `Text content exceeds ${files_MAX_TEXT_CONTENT_BYTES}-byte limit` } });
			}

			const assetId = (await ctx.runMutation(internal.r2.insert_asset, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				kind: "content_snapshot",
				size,
				createdBy: args.userId,
			})) as Id<"files_r2_assets">;
			await r2_put_object(ctx, {
				key: r2_create_asset_key({
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					assetId,
				}),
				body: text,
				contentType: sourceShape.contentType,
			});
			replacement = {
				assetId,
				size,
				contentType: sourceShape.contentType,
				yjsRootKind: sourceShape.rootKind,
				...(data.sourceNode.collaborationEnabled === false ? { nonCollaborative: true } : {}),
				baseAssetId,
			};
		} else {
			const sourceAsset = data.sourceAsset;
			if (
				!sourceAsset ||
				sourceAsset.organizationId !== args.organizationId ||
				sourceAsset.workspaceId !== args.workspaceId ||
				sourceAsset.r2Key === undefined ||
				data.sourceNode.contentType === null
			) {
				return Result({ _nay: { message: "The source file's content is not available yet" } });
			}

			const assetId = (await ctx.runMutation(internal.r2.insert_asset, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				kind: "content",
				size: sourceAsset.size,
				createdBy: args.userId,
			})) as Id<"files_r2_assets">;
			const r2Key = r2_create_asset_key({
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				assetId,
			});
			// Copy on the R2 server side. The etag check refuses a source object that changed under
			// the copy. An asset with no recorded etag is copied as it is right now.
			const copied = await r2_copy_object_to_immutable_key(ctx, {
				sourceKey: sourceAsset.r2Key,
				destinationKey: r2Key,
				...(sourceAsset.etag !== undefined
					? { expectedSource: { size: sourceAsset.size, etag: sourceAsset.etag } }
					: {}),
			});
			if (copied.outcome !== "ready") {
				await ctx.runMutation(internal.files_nodes_content.cleanup_file_node_creation_assets, {
					assetIds: [assetId],
					r2Keys: [r2Key],
					durableTenantScope: { organizationId: args.organizationId, workspaceId: args.workspaceId },
				});
				return Result({ _nay: { message: PENDING_REPLACEMENT_SOURCE_CHANGED_MESSAGE } });
			}
			replacement = {
				assetId,
				size: copied.size,
				contentType: data.sourceNode.contentType,
				baseAssetId,
			};
		}

		return (await ctx.runMutation(internal.files_pending_updates.commit_file_pending_replacement_in_db, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			nodeId: args.nodeId,
			expectedUpdatedAt: data.existingPendingUpdate?.updatedAt ?? null,
			replacement,
			...(text !== undefined ? { text } : {}),
			copiedFrom: args.source,
			...(args.eagerCreatedCommittedSequence !== undefined
				? { eagerCreatedCommittedSequence: args.eagerCreatedCommittedSequence }
				: {}),
			...(args.eagerCreatedAncestorIds !== undefined ? { eagerCreatedAncestorIds: args.eagerCreatedAncestorIds } : {}),
			...(args.threadId ? { threadId: args.threadId } : {}),
		})) as files_pending_updates_stage_file_pending_replacement_Result;
	},
});

/**
 * Record a staged whole-file replacement on the caller's pending update doc for the file.
 *
 * The commit publishes the staged object: its doc gets the final key. On any refusal it hands
 * that object to the deletion ledger instead, so a refused stage leaves nothing behind.
 */
export const commit_file_pending_replacement_in_db = internalMutation({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		nodeId: v.id("files_nodes"),
		/**
		 * `null` means the action saw no doc. A number is the read doc's `updatedAt` race guard.
		 */
		expectedUpdatedAt: v.union(v.number(), v.null()),
		replacement: v.object({
			assetId: v.id("files_r2_assets"),
			size: v.number(),
			contentType: v.string(),
			yjsRootKind: v.optional(v.union(v.literal("rich_text"), v.literal("plain_text"))),
			nonCollaborative: v.optional(v.boolean()),
			baseAssetId: v.id("files_r2_assets"),
		}),
		/**
		 * The staged text of a text copy, for the pending chunks the agent's readers overlay.
		 */
		text: v.optional(v.string()),
		copiedFrom: v.object({ nodeId: v.id("files_nodes"), path: v.string() }),
		eagerCreatedCommittedSequence: v.optional(v.number()),
		eagerCreatedAncestorIds: v.optional(v.array(v.id("files_nodes"))),
		threadId: v.optional(v.id("ai_chat_threads")),
	},
	returns: v_result({ _yay: v.object({ pendingUpdateId: v.id("files_pending_updates") }) }),
	handler: async (ctx, args) => {
		// The staged asset must be this caller's own unpublished object in this tenant. Nothing is
		// released for any other id: a caller-supplied asset id is not a claim on that object.
		const stagedAsset = await ctx.db.get("files_r2_assets", args.replacement.assetId);
		if (
			!stagedAsset ||
			stagedAsset.organizationId !== args.organizationId ||
			stagedAsset.workspaceId !== args.workspaceId ||
			stagedAsset.createdBy !== args.userId ||
			stagedAsset.r2Key !== undefined
		) {
			return Result({ _nay: { message: "Not found" } });
		}

		const refuse = async (message: string) => {
			await files_pending_update_db_release_replacement_asset(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				assetId: stagedAsset._id,
			});
			return Result({ _nay: { message } });
		};

		const file = await ctx.db.get("files_nodes", args.nodeId);
		if (
			!file ||
			file.organizationId !== args.organizationId ||
			file.workspaceId !== args.workspaceId ||
			file.kind !== "file"
		) {
			return await refuse("Not found");
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
			return await refuse("Permission denied");
		}

		const nodeWritable = await files_nodes_db_require_user_writable(ctx, { node: file, userId: args.userId });
		if (nodeWritable._nay) {
			return await refuse(nodeWritable._nay.message);
		}

		if (file.assetId !== args.replacement.baseAssetId) {
			return await refuse(files_PENDING_REPLACEMENT_BASE_CHANGED_MESSAGE);
		}

		const existingPendingUpdate = await files_db_get_pending_update(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			nodeId: args.nodeId,
		});
		// Only the exact doc state the action worked from.
		if (
			args.expectedUpdatedAt === null
				? existingPendingUpdate !== null
				: !existingPendingUpdate || existingPendingUpdate.updatedAt !== args.expectedUpdatedAt
		) {
			return await refuse("Pending update changed, retry the write");
		}
		// A pending delete wins over every other aspect of the doc, and accepting it would leave
		// the staged object behind. Ask for a decision on the delete first.
		if (existingPendingUpdate?.pendingArchive) {
			return await refuse("Discard the pending delete of this file first");
		}

		const now = Date.now();
		// Publish the staged object under its final key. The sweeper leaves published assets alone.
		// Discard and expiry release it through the deletion ledger.
		await ctx.db.patch("files_r2_assets", stagedAsset._id, {
			r2Key: r2_create_asset_key({
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				assetId: stagedAsset._id,
			}),
			size: args.replacement.size,
			unfinalizedExpiresAt: undefined,
			updatedAt: now,
		});

		// Stamp the eager create with the sequence the creator captured in the mutation that
		// created the node. See the eager-create field docs.
		const eagerCreated: app_convex_Doc<"files_pending_updates">["eagerCreated"] =
			args.eagerCreatedCommittedSequence !== undefined
				? {
						committedSequence: args.eagerCreatedCommittedSequence,
						...(args.eagerCreatedAncestorIds !== undefined ? { createdAncestorIds: args.eagerCreatedAncestorIds } : {}),
					}
				: undefined;
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
				pendingReplacement: args.replacement,
				copiedFrom: args.copiedFrom,
				...(eagerCreated ? { eagerCreated } : {}),
				...(nextThreadIds ? { threadIds: nextThreadIds } : {}),
				size: args.replacement.size,
				updatedAt: now,
			});
		} else {
			pendingUpdateId = existingPendingUpdate._id;
			// The newest intent wins. A whole-file copy replaces the text branches this user had on
			// the file, because the copy is reviewed as a whole. An older copy's staged object is
			// released.
			if (existingPendingUpdate.pendingReplacement) {
				await files_pending_update_db_release_replacement_asset(ctx, {
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					assetId: existingPendingUpdate.pendingReplacement.assetId,
				});
			}
			await Promise.all([
				files_pending_update_content_of(existingPendingUpdate)
					? files_db_retire_pending_update_yjs_states(ctx, {
							organizationId: args.organizationId,
							workspaceId: args.workspaceId,
							pendingUpdateId,
						})
					: null,
				files_pending_update_db_delete_chunks(ctx, { pendingUpdateId }),
				ctx.db.patch("files_pending_updates", pendingUpdateId, {
					baseYjsSequence: undefined,
					baseLineageGeneration: undefined,
					baseAssetId: undefined,
					baseStateId: undefined,
					stagedStateId: undefined,
					unstagedStateId: undefined,
					contentNeedsRebase: undefined,
					contentRebaseRootKind: undefined,
					pendingReplacement: args.replacement,
					copiedFrom: args.copiedFrom,
					// Never overwrite an existing eagerCreated: its committedSequence stamp must stay immutable.
					...(eagerCreated && !existingPendingUpdate.eagerCreated ? { eagerCreated } : {}),
					...(nextThreadIds ? { threadIds: nextThreadIds } : {}),
					size: args.replacement.size,
					updatedAt: now,
				}),
			]);
		}
		// A text copy also gets pending chunks, so Bash reads and search overlay the copy like
		// any other proposal. A stored copy has no text to chunk.
		if (args.text !== undefined && args.replacement.yjsRootKind !== undefined) {
			const chunksReplaced = await files_pending_update_db_replace_chunks(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				userId: args.userId,
				nodeId: args.nodeId,
				pendingUpdateId,
				unstagedText: args.text,
				rootKind: args.replacement.yjsRootKind,
			});
			files_pending_update_log_replace_chunks_nay(chunksReplaced, { pendingUpdateId, nodeId: args.nodeId });
		}
		await files_db_schedule_pending_update_cleanup(ctx, {
			pendingUpdateId,
			expectedUpdatedAt: now,
		});

		return Result({ _yay: { pendingUpdateId } });
	},
});

/**
 * Everything the accept action reads before it uploads: the file, the copy row, the staged
 * object's key, and the document state of a collaborative file, whose latest text is kept as a
 * version. Null when the file, the copy row, its staged object, or the permission is gone.
 */
export const get_data_for_pending_replacement_accept = internalQuery({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		nodeId: v.id("files_nodes"),
		pendingUpdateId: v.id("files_pending_updates"),
	},
	returns: v.union(
		v.object({
			fileNode: doc(app_convex_schema, "files_nodes"),
			pendingUpdate: doc(app_convex_schema, "files_pending_updates"),
			stagedAssetR2Key: v.string(),
			materializationState: v.union(file_content_materialization_state_validator, v.null()),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const fileNode = await ctx.db.get("files_nodes", args.nodeId);
		if (
			!fileNode ||
			fileNode.organizationId !== args.organizationId ||
			fileNode.workspaceId !== args.workspaceId ||
			fileNode.kind !== "file"
		) {
			return null;
		}
		if (
			!(await access_control_db_can_act_on_file_node(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				userId: args.userId,
				fileNode,
				permission: "content.write",
			}))
		) {
			return null;
		}

		const pendingUpdate = await files_db_get_pending_update(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			nodeId: args.nodeId,
			pendingUpdateId: args.pendingUpdateId,
		});
		if (!pendingUpdate || pendingUpdate._id !== args.pendingUpdateId || !pendingUpdate.pendingReplacement) {
			return null;
		}
		const stagedAsset = await ctx.db.get("files_r2_assets", pendingUpdate.pendingReplacement.assetId);
		if (
			!stagedAsset ||
			stagedAsset.organizationId !== args.organizationId ||
			stagedAsset.workspaceId !== args.workspaceId ||
			stagedAsset.r2Key === undefined
		) {
			return null;
		}

		// Null for a file with no document: stored bytes, or collaboration turned off.
		const materializationState = await db_get_file_content_materialization_db_state(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId: args.nodeId,
		});

		return { fileNode, pendingUpdate, stagedAssetR2Key: stagedAsset.r2Key, materializationState };
	},
});

type get_data_for_pending_replacement_accept_Result =
	typeof get_data_for_pending_replacement_accept extends RegisteredQuery<
		infer _Visibility,
		infer _Args,
		infer ReturnValue
	>
		? Awaited<ReturnValue>
		: never;

/**
 * The result of `finalize_file_pending_replacement` in files_nodes_content.ts, written by hand.
 * That module imports this one, so importing its type back would make a cycle.
 */
type finalize_file_pending_replacement_Result =
	| { _yay: null; _nay?: undefined }
	| { _yay?: undefined; _nay: { name?: string; message: string } };

/**
 * Accept a whole-file replacement. Stored bytes need no more work: the staged object becomes the
 * file's content as it is. Text gets its final form here. A collaborative result gets a fresh
 * document built from the text, and the text that document produces is what gets committed,
 * because building a rich document normalizes Markdown. The final mutation lives in
 * files_nodes_content.ts, next to the other content-state writers.
 */
async function action_accept_file_pending_replacement(
	ctx: ActionCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
		nodeId: Id<"files_nodes">;
		pendingUpdateId: Id<"files_pending_updates">;
	},
): Promise<files_pending_updates_accept_file_pending_replacement_Result> {
	const data = (await ctx.runQuery(
		internal.files_pending_updates.get_data_for_pending_replacement_accept,
		args,
	)) as get_data_for_pending_replacement_accept_Result;
	if (!data) {
		return Result({ _nay: { message: "Not found" } });
	}

	const replacement = data.pendingUpdate.pendingReplacement;
	if (!replacement) {
		return Result({ _nay: { message: "Not found" } });
	}

	const writable = (await ctx.runQuery(internal.files_nodes.get_user_file_write_access, {
		organizationId: data.fileNode.organizationId,
		workspaceId: data.fileNode.workspaceId,
		nodeId: data.fileNode._id,
		userId: args.userId,
	})) as files_nodes_get_user_file_write_access_Result;
	if (writable._nay) {
		return writable;
	}

	if (data.fileNode.assetId !== replacement.baseAssetId) {
		return Result({ _nay: { message: files_PENDING_REPLACEMENT_BASE_CHANGED_MESSAGE } });
	}

	const creditCheck = await ctx.runQuery(internal.billing.check_credits, {
		userId: args.userId,
		organizationId: args.organizationId,
		minimumRequiredCents: 1,
	});
	if (!creditCheck.hasCredits) {
		return Result({ _nay: { message: "Insufficient funds" } });
	}

	// Uploads made here stay unfinalized until the final mutation publishes them. A refusal below
	// hands them to the deletion ledger right away.
	const uploadedAssets: Array<{ assetId: Id<"files_r2_assets">; r2Key: string }> = [];
	const upload_asset = async (upload: {
		kind: "yjs_snapshot" | "content_snapshot";
		body: string | ArrayBuffer;
		size: number;
		contentType: files_ContentType;
	}) => {
		const assetId = (await ctx.runMutation(internal.r2.insert_asset, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			kind: upload.kind,
			size: upload.size,
			createdBy: args.userId,
		})) as Id<"files_r2_assets">;
		const r2Key = r2_create_asset_key({
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			assetId,
		});
		await r2_put_object(ctx, { key: r2Key, body: upload.body, contentType: upload.contentType });
		uploadedAssets.push({ assetId, r2Key });
		return assetId;
	};
	const cleanup_uploads = async () => {
		if (uploadedAssets.length === 0) {
			return;
		}
		await ctx.runMutation(internal.files_nodes_content.cleanup_file_node_creation_assets, {
			assetIds: uploadedAssets.map((asset) => asset.assetId),
			r2Keys: uploadedAssets.map((asset) => asset.r2Key),
			durableTenantScope: { organizationId: args.organizationId, workspaceId: args.workspaceId },
		});
	};

	let content: {
		contentAssetId: Id<"files_r2_assets">;
		contentSize: number;
		yjsRootKind?: files_YjsRootKind;
		nonCollaborative?: boolean;
		yjsSnapshot?: { assetId: Id<"files_r2_assets">; size: number };
		text?: string;
	};
	if (replacement.yjsRootKind === undefined) {
		content = { contentAssetId: replacement.assetId, contentSize: replacement.size };
	} else {
		const rootKind = replacement.yjsRootKind;
		// New copies inherit the source's mode. Existing text files keep their own mode.
		const nonCollaborative =
			!data.pendingUpdate.eagerCreated && files_node_has_editable_text_content(data.fileNode)
				? data.fileNode.collaborationEnabled === false
				: replacement.nonCollaborative === true;
		const stagedText = await r2_fetch_object_from_bucket({ key: data.stagedAssetR2Key }).then((response) =>
			response.text(),
		);
		let text = stagedText;
		let yjsSnapshot: { assetId: Id<"files_r2_assets">; size: number } | undefined;
		if (!nonCollaborative) {
			const yjsDoc = files_yjs_doc_create_from_text({ text: stagedText, rootKind });
			if ("_nay" in yjsDoc) {
				return Result({ _nay: { message: yjsDoc._nay.message } });
			}
			const snapshotUpdate = encodeStateAsUpdate(yjsDoc);
			if (snapshotUpdate.byteLength > files_MAX_YJS_RECONSTRUCTED_STATE_BYTES) {
				return Result({
					_nay: { message: `Compact document exceeds ${files_MAX_YJS_RECONSTRUCTED_STATE_BYTES}-byte limit` },
				});
			}
			const normalizedText = files_yjs_doc_get_text({ yjsDoc, rootKind });
			if (normalizedText._nay) {
				return Result({ _nay: { message: normalizedText._nay.message } });
			}
			text = normalizedText._yay;
			yjsSnapshot = {
				assetId: await upload_asset({
					kind: "yjs_snapshot",
					body: files_u8_to_array_buffer(snapshotUpdate),
					size: snapshotUpdate.byteLength,
					contentType: "application/octet-stream",
				}),
				size: snapshotUpdate.byteLength,
			};
		}
		const textSize = files_get_utf8_byte_size(text);
		if (textSize > files_MAX_TEXT_CONTENT_BYTES) {
			await cleanup_uploads();
			return Result({ _nay: { message: `Text content exceeds ${files_MAX_TEXT_CONTENT_BYTES}-byte limit` } });
		}
		// The staged object already holds the text when nothing normalized it. Otherwise the
		// committed text needs its own object, and the final mutation releases the staged one.
		const contentAssetId =
			text === stagedText
				? replacement.assetId
				: await upload_asset({
						kind: "content_snapshot",
						body: text,
						size: textSize,
						contentType: files_editable_text_content_type_of(replacement.contentType) ?? "application/octet-stream",
					});
		content = {
			contentAssetId,
			contentSize: textSize,
			yjsRootKind: rootKind,
			...(nonCollaborative ? { nonCollaborative: true } : {}),
			...(yjsSnapshot ? { yjsSnapshot } : {}),
			text,
		};
	}

	// The latest text of a collaborative file may still live only in its document. Keep it as a
	// version, so the edits the copy replaces stay in history. When the document has no edit past
	// its snapshot, the current asset already is the newest version row, and a backup would only
	// repeat it.
	const yjsState = data.materializationState;
	let backup: { assetId: Id<"files_r2_assets">; size: number } | undefined;
	if (yjsState && yjsState.yjsLastSequenceDoc.lastSequence > yjsState.yjsSnapshotDoc.sequence) {
		const currentContent = await files_nodes_reconstruct_latest_file_content_from_materialization_state({
			state: yjsState,
		});
		// Unlike the restore path, refuse instead of throwing: the copy stays pending, so the user
		// can discard it and the file keeps its current content.
		if (currentContent._nay) {
			console.error("Failed to reconstruct the current file content before accepting a copy", {
				error: currentContent._nay,
				nodeId: args.nodeId,
				pendingUpdateId: args.pendingUpdateId,
			});
			await cleanup_uploads();
			return Result({ _nay: { message: currentContent._nay.message } });
		}
		const text = currentContent._yay.text;
		const size = files_get_utf8_byte_size(text);
		backup = {
			assetId: await upload_asset({
				kind: "content_snapshot",
				body: text,
				size,
				contentType: files_editable_text_content_type_of(data.fileNode.contentType) ?? "application/octet-stream",
			}),
			size,
		};
	}

	// The document's last-sequence token the query read. The final mutation refuses when an edit
	// moved it, because that edit would be in neither the backup nor the history.
	const expectedYjsLastSequence = yjsState
		? { id: yjsState.yjsLastSequenceDoc._id, lastSequence: yjsState.yjsLastSequenceDoc.lastSequence }
		: undefined;

	const finalized = (await ctx.runMutation(internal.files_nodes_content.finalize_file_pending_replacement, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		userId: args.userId,
		nodeId: args.nodeId,
		pendingUpdateId: args.pendingUpdateId,
		expectedUpdatedAt: data.pendingUpdate.updatedAt,
		stagedAssetId: replacement.assetId,
		...(expectedYjsLastSequence ? { expectedYjsLastSequence } : {}),
		...(backup ? { backup } : {}),
		contentType: replacement.contentType,
		...content,
	})) as finalize_file_pending_replacement_Result;
	if (finalized._nay) {
		await cleanup_uploads();
		return finalized;
	}

	return Result({ _yay: null });
}

/**
 * The pending panel's Accept for a whole-file copy.
 */
export const accept_file_pending_replacement = action({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
		pendingUpdateId: v.id("files_pending_updates"),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args): Promise<files_pending_updates_accept_file_pending_replacement_Result> => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}
		const rateLimit = await rate_limiter_limit_by_key(ctx, {
			name: "files_pending_update_write",
			key: userAuth.id,
		});
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}
		const membership = await ctx.runQuery(api.organizations.get_membership, {
			membershipId: args.membershipId,
		});
		if (!membership || membership.userId !== userAuth.id) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		return await action_accept_file_pending_replacement(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: userAuth.id,
			nodeId: args.nodeId,
			pendingUpdateId: args.pendingUpdateId,
		});
	},
});

// #endregion whole-file replacement
