// Files nodes are organized as a file tree where each node is either a folder or a Markdown file.
//
// This structure allows file-system-like operations such as finding all items under a path (`/docs/*`) or
// listing folder children and reading file content (`/docs/README.md`).

import { action, internalAction, internalQuery, query, type QueryCtx, type MutationCtx } from "./_generated/server.js";
import { internalMutation, mutation } from "./functions.ts";
import type { Doc, Id } from "./_generated/dataModel";
import {
	paginationOptsValidator,
	paginationResultValidator,
	type PaginationResult,
	type RegisteredMutation,
	type RegisteredQuery,
	type IndexRange,
} from "convex/server";
import { Workpool } from "@convex-dev/workpool";
import {
	path_extract_segments_from,
	server_path_normalize,
	server_convex_get_user_fallback_to_anonymous,
	path_join,
	path_tree_prefix_upper_bound,
	string_prefix_upper_bound,
} from "../server/server-utils.ts";
import { compareValues, v, type Infer } from "convex/values";
import {
	date_get_week_start_timestamp,
	date_get_day_start_timestamp,
	date_get_hour_start_timestamp,
	date_MS_DAY,
	date_MS_DAYS_30,
	date_MS_WEEK,
} from "../shared/date.ts";
import {
	files_ROOT_ID,
	files_IMPORT_MAX_ITEMS_PER_CALL,
	files_MAX_UPLOADS_BYTES,
	files_MAX_UNMATERIALIZED_YJS_UPDATE_BYTES,
	files_MAX_UNMATERIALIZED_YJS_UPDATE_COUNT,
	files_MAX_YJS_WIRE_BYTES,
	files_UPLOAD_PATH_TAKEN_MESSAGE,
	files_INVALID_CONTENT_TYPE_MESSAGE,
	files_get_signed_download_serving,
	files_resolve_upload_content_type,
	files_get_utf8_byte_size,
	files_node_has_editable_text_content,
	files_node_has_editable_yjs_state,
	files_pending_update_has_pending_chunks,
	files_db_delete_pending_update_yjs_states,
	files_db_patch_pending_update,
	files_db_delete_pending_update,
	files_db_get_visible_node_by_path,
	type files_YjsRootKind,
} from "../server/files.ts";
import { files_yjs_COMPACTION_RETRY_MESSAGE, files_yjs_scan_client_update } from "../shared/files-yjs.ts";
import { files_metadata_apply_set_and_remove, type files_metadata_Entry } from "../shared/files-metadata.ts";
import {
	files_sort_is_valid,
	files_sort_text_key,
	type files_sort_Key,
	type files_sort_RowKey,
} from "../shared/files-sort.ts";
import {
	files_table_filter_is_valid,
	files_table_filter_order_field,
	files_table_filter_takes_name_prefix,
	files_table_metadata_field,
} from "../shared/files-table.ts";
import { path_name_of } from "../shared/paths.ts";
import { Result, Result_all } from "common/errors-as-values-utils.ts";
import { composite_id, should_never_happen } from "../shared/shared-utils.ts";
import { organizations_is_global_organization_id } from "../shared/organizations.ts";
import { users_SYSTEM_AUTHOR } from "../shared/users.ts";
import app_convex_schema, {
	ai_chat_workspaces_source_validator,
	files_content_version_validator,
	files_metadata_search_plan_validator,
	files_pending_target_validator,
	files_sort_row_key_validator,
	files_sort_validator,
	files_table_filter_validator,
	file_content_materialization_state_validator,
	file_content_materialization_header_validator,
	files_saved_stream_validator,
} from "./schema.ts";
import { files_search_db_create_reader } from "./files_search.ts";
import {
	files_saved_placement_db_get_node,
	files_saved_placement_db_get_slot,
	files_saved_placement_db_get_proposal,
	files_saved_placement_db_get_sequence,
} from "../server/files-saved-placement.ts";
import { files_saved_stream_db_create } from "../server/files-saved-stream.ts";
import {
	files_saved_content_collect,
	files_saved_content_db_plain_text_chunks,
	files_saved_content_db_text_chunks,
	files_saved_content_db_yjs_updates,
} from "../server/files-saved-content.ts";
import { files_index_range_apply, files_index_range_phases } from "../server/files-index-range.ts";
import { files_share_links_db_is_selected } from "../server/files-share-links.ts";
import { files_saved_placement_db_get_view } from "../server/files-saved-placement.ts";
import {
	files_move_reservations_db_check,
	files_move_reservations_db_enter_security,
	files_move_reservations_db_find_blocker,
} from "../server/files-move-reservations.ts";
import { files_visible_db_create_reader } from "./files_visible.ts";
import { files_media_validation_db_advance_version } from "./files_media_validation.ts";
import type { files_PendingTarget } from "../shared/files.ts";
import { components, internal } from "./_generated/api.js";
import { doc } from "convex-helpers/validators";
import { billing_event } from "../server/billing.ts";
import { convex_error, convex_invalid_cursor_error, v_result } from "../server/convex-utils.ts";
import { organizations_db_get_membership } from "./organizations.ts";
import { ai_chat_workspaces_db_authorize_file_scope } from "./ai_chat_workspaces.ts";
import { files_db_resolve_scope } from "./files_scopes.ts";
import {
	files_share_links_create_cleanup_state,
	files_share_links_db_delete_for_node,
	files_share_links_db_delete_for_roots,
	type files_share_links_CleanupState,
} from "./files_share_links_db.ts";
import { files_updated_by_db_delete_for_node, files_updated_by_db_sync_node } from "./files_updated_by.ts";
import { files_db_authorize_file_read } from "./files_volume_access.ts";
import {
	access_control_db_authorize_membership,
	access_control_db_authorize_node,
	access_control_db_can_act_on_file_node,
	access_control_db_filter_readable_file_nodes,
	access_control_db_has_permission,
	access_control_db_resolve_role_refs,
} from "./access_control.ts";
import type { access_control_Permission } from "../shared/access-control.ts";
import { billing_db_check_credits, billing_pick_billed_user_id, billing_ingest_events } from "./billing_db.ts";
import { files_stored_uploads_db_admit } from "./files_stored_uploads.ts";
import { files_transfer_source_versions_equal } from "./files_transfer.ts";
import { rate_limiter_check_by_key, rate_limiter_limit_by_key } from "./rate_limiter.ts";
import {
	files_ANCESTOR_FIELD_COUNT,
	files_content_type_index_fields,
	files_derive_tree_path_for_file_node,
	files_is_ancestor_field,
	files_lowercase_extension,
	files_default_text_shape_for_name,
	files_get_normalized_node_path_segments,
	files_normalize_markdown_name,
	files_normalize_name,
	files_normalize_special_node_path,
	files_normalize_upload_file_name,
	files_parse_content_type_prefix,
	files_pending_update_content_is_stale,
	files_TEXT_SEARCH_MAX_RESULTS,
	files_WRITE_POLICY_INVALID_WRITERS_MESSAGE,
	type files_VisibleEntry,
} from "../shared/files.ts";
import {
	files_metadata_db_patch_file_scope,
	files_metadata_db_query_saved_plan,
	files_metadata_db_write_entries,
} from "./files_metadata.ts";
import {
	files_search_query_field_path_is_valid,
	files_search_query_FIELD_PATH_MAX_LENGTH,
} from "../shared/files-search-query.ts";
import { files_archive_runs_db_start, files_archive_runs_STEP_MAX_NODES } from "./files_archive_runs.ts";
import { files_transfer_db_start_rename } from "./files_transfer.ts";
import { public_api_service_uploads_db_get_target_by_asset } from "./public_api_service_uploads.ts";
import {
	files_pending_nodes_db_create,
	files_pending_nodes_db_get_ancestry,
	files_pending_nodes_db_resolve_read_target,
} from "./files_pending_nodes.ts";
import { quotas_db_ensure } from "./quotas.ts";
import { organizations_membership_lifetimes_db_get } from "./organizations_membership_lifetimes.ts";
import { files_share_rows_NODE_FIELDS, files_share_rows_principal_key } from "../server/files-share-rows.ts";
import { files_pending_overlay_list_over_budget } from "../server/files-pending-overlay.ts";
import { quotas } from "../shared/quotas.ts";
import {
	r2,
	r2_create_asset_key,
	r2_enqueue_object_deletion_job,
	r2_PUT_MAY_ARRIVE_MARGIN_MS,
	r2_UNFINALIZED_ASSET_TTL_MS,
} from "./r2_client.ts";

// Make Convex reuse the loaded module between calls, so warm calls skip the module load cost.
// Does NOT work for http actions (see http.ts). No mutable module-level state allowed here.
export const experimental_reuseContext = true;

const files_content_materialization_workpool = new Workpool(components.files_content_materialization_workpool, {
	maxParallelism: 1,
	retryActionsByDefault: true,
	defaultRetryBehavior: {
		initialBackoffMs: 60 * 1000,
		base: 1.2,
		maxAttempts: Number.POSITIVE_INFINITY,
	} as const,
});

// The up-front Archive policy check can defer larger trees to its background worker.
const MAX_SUBTREE_POLICY_NODE_COUNT = 2000;

const TREE_CHILDREN_MAX_ITEMS = 200;
// The page cap and the split guard of the share pages. Each share row is its own scope, so each one
// reads its node and checks its access. The worst row is shared with the member's second role and
// also has an old plugin grant to the member, so the check also reads that grant and the live
// membership lifetime: 16 index ranges (measured in the cost test under `list_tree_children_shared`),
// floor(3,000 / 16) = 187.
const TREE_SHARE_PAGE_MAX_ITEMS = 187;
// The split guard of an owner's restricted rows in the tree and the folder table. An open row needs
// no read: the open children of a folder share one access scope, and the rows check each scope once.
// An owner restricted row is its own scope, so it checks access: 2 reads (the user and the
// organization; the owner reads no grant), floor(3,000 / 2) = 1,500, and the guard is 1,000.
const TREE_RESTRICTED_SPLIT_GUARD = 1000;
// The split guards of the folder table's metadata sort. An open row reads its node with one `get`:
// 1 read, so floor(3,000 / 1) = 3,000, and the guard is 1,800 so the node bytes stay small too. An
// owner restricted row is its own scope, so it also checks access: 2 reads (the user and the
// organization; the owner reads no grant). That is 3 reads, floor(3,000 / 3) = 1,000, and the guard
// is 700.
const TREE_METADATA_SPLIT_GUARD = 1800;
const TREE_METADATA_RESTRICTED_SPLIT_GUARD = 700;

const TREE_ANCESTORS_MAX_DEPTH = 64;

// A search box page holds at most this many rows. A text search page has no split cursor and can
// grow on a rerun, so a bigger one restarts from the first page before any per-row read.
const SEARCH_SAVED_MAX_ITEMS = 100;
// The split guard of the search box's metadata and link pages. Each row reads its node with one
// `get` and checks access once per restricted scope. The worst row is its own restricted scope,
// read by a member: the node, the scope node, the user grant, 2 role assignments and 2 role
// grants, 7 reads, so floor(3,000 / 7) = 428, and the guard is 400.
const SEARCH_SAVED_SPLIT_GUARD = 400;
const SEARCH_SAVED_TEXT_MAX_LENGTH = 200;
const SEARCH_SAVED_PATH_MAX_LENGTH = 1024;

function files_path_depth(path: string) {
	return path === "/" ? 0 : path_extract_segments_from(path).length;
}

/** -1 in any file_stats count means the content cannot be processed (non-markdown / binary). */
const files_STATS_UNPROCESSABLE = -1;

/**
 * Create or update the `file_stats` doc for a file node and, on first creation, link it back via
 * `files_nodes.statsId`. Subsequent updates patch only the stats doc — NOT the file node — so
 * re-materializing content does not invalidate the file-tree / path-resolution queries that read
 * the file node. Returns the stats doc id.
 */
export async function db_upsert_file_stats(
	ctx: MutationCtx,
	args: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		nodeId: Id<"files_nodes">;
		lineCount: number;
		wordCount: number;
		charCount: number;
	},
) {
	const existing = await ctx.db
		.query("file_stats")
		.withIndex("by_organization_workspace_fileNode", (q) =>
			q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("fileNodeId", args.nodeId),
		)
		.first();
	if (existing) {
		await ctx.db.patch("file_stats", existing._id, {
			lineCount: args.lineCount,
			wordCount: args.wordCount,
			charCount: args.charCount,
		});
		return existing._id;
	}
	const statsId = await ctx.db.insert("file_stats", {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		fileNodeId: args.nodeId,
		lineCount: args.lineCount,
		wordCount: args.wordCount,
		charCount: args.charCount,
	});
	await ctx.db.patch("files_nodes", args.nodeId, { statsId });
	return statsId;
}

async function db_patch_plain_text_chunks_scope(
	ctx: MutationCtx,
	args: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		nodeId: Id<"files_nodes">;
		path?: string;
		archiveOperationId?: string;
	},
) {
	const patch: Partial<Pick<Doc<"files_plain_text_chunks">, "path" | "archiveOperationId">> = {};
	if ("path" in args) {
		patch.path = args.path;
	}
	if ("archiveOperationId" in args) {
		patch.archiveOperationId = args.archiveOperationId;
	}
	// Saved content is bounded by one file. Other owners' drafts use the overlay job.
	const chunks = await ctx.db
		.query("files_plain_text_chunks")
		.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
			q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("fileNodeId", args.nodeId),
		)
		.collect();
	await Promise.all(chunks.map((chunk) => ctx.db.patch("files_plain_text_chunks", chunk._id, patch)));
}

async function db_patch_node_search_scope(
	ctx: MutationCtx,
	args: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		nodeId: Id<"files_nodes">;
		kind: Doc<"files_nodes">["kind"];
		path?: string;
		archiveOperationId?: string;
		parentId?: Doc<"files_nodes">["parentId"];
		name?: string;
	},
) {
	await Promise.all([
		args.kind === "file" ? db_patch_plain_text_chunks_scope(ctx, args) : undefined,
		files_metadata_db_patch_file_scope(ctx, {
			...args,
			...(args.path === undefined ? {} : { treePath: files_derive_tree_path_for_file_node(args.path, args.kind) }),
		}),
	]);
}

export async function enqueue_file_content_materialization(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		nodeId: Id<"files_nodes">;
		userId: Id<"users">;
		targetSequence: number;
		delayMs: number;
	},
) {
	const existingJobs = await ctx.db
		.query("files_content_materialization_jobs")
		.withIndex("by_fileNode", (q) => q.eq("fileNodeId", args.nodeId))
		.collect();

	const jobId = await files_content_materialization_workpool.enqueueAction(
		ctx,
		internal.files_nodes_content.materialize_file_content,
		{
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId: args.nodeId,
			userId: args.userId,
			targetSequence: args.targetSequence,
		},
		{
			runAfter: args.delayMs,
		},
	);

	await Promise.all([
		ctx.db.insert("files_content_materialization_jobs", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			fileNodeId: args.nodeId,
			jobId,
			targetSequence: args.targetSequence,
		}),
		...existingJobs.map((job) => files_content_materialization_workpool.cancel(ctx, job.jobId)),
		...existingJobs.map((job) => ctx.db.delete("files_content_materialization_jobs", job._id)),
	]);
}

export async function files_nodes_db_resume_file_content_materialization(
	ctx: MutationCtx,
	args: { jobId: Id<"files_content_materialization_jobs">; userId: Id<"users"> },
) {
	const job = await ctx.db.get("files_content_materialization_jobs", args.jobId);
	if (!job) return;
	const jobId = await files_content_materialization_workpool.enqueueAction(
		ctx,
		internal.files_nodes_content.materialize_file_content,
		{
			organizationId: job.organizationId,
			workspaceId: job.workspaceId,
			nodeId: job.fileNodeId,
			userId: args.userId,
			targetSequence: job.targetSequence,
		},
		{ runAfter: 0 },
	);
	// Keep the accepted job identity while replacing its completed workpool attempt.
	await ctx.db.patch("files_content_materialization_jobs", job._id, { jobId });
}

/**
 * Stop materialization for one file and forget its job docs.
 *
 * Cancel the workpool item before deleting the tracking doc. Deleting the doc alone leaves the
 * worker running, and that worker still writes the file's Yjs snapshot object to R2 after the
 * caller removed it. The workspace purge cancels in this order for the same reason.
 */
export async function cancel_file_content_materialization(ctx: MutationCtx, args: { nodeId: Id<"files_nodes"> }) {
	const jobs = await ctx.db
		.query("files_content_materialization_jobs")
		.withIndex("by_fileNode", (q) => q.eq("fileNodeId", args.nodeId))
		.collect();

	await Promise.all([
		...jobs.map((job) => files_content_materialization_workpool.cancel(ctx, job.jobId)),
		...jobs.map((job) => ctx.db.delete("files_content_materialization_jobs", job._id)),
	]);
}

export const get_by_path = internalQuery({
	args: {
		agentSource: v.optional(ai_chat_workspaces_source_validator),
		organizationId: doc(app_convex_schema, "files_nodes").fields.organizationId,
		workspaceId: doc(app_convex_schema, "files_nodes").fields.workspaceId,
		path: v.string(),
		/**
		 * Who is looking. Required, not optional, so a new caller cannot forget it and quietly get an
		 * unfiltered view: a restricted node answers `null` for anybody without a grant on it.
		 */
		visibilityUserId: v.id("users"),
		serviceAccountId: v.optional(v.id("access_control_service_accounts")),
		/** When set, resolve through this user's pending path overlay (their pending moves). */
		overlayUserId: v.optional(v.id("users")),
	},
	returns: v.union(doc(app_convex_schema, "files_nodes"), v.null()),
	handler: async (ctx, args) => {
		const authorized = await files_db_authorize_file_read(ctx, { ...args, userId: args.visibilityUserId });
		if (authorized._nay) return null;
		const scope = files_db_resolve_scope(ctx, args.workspaceId);
		if (scope.kind === "volume") return await files_db_get_visible_node_by_path(ctx, args);
		if (
			args.overlayUserId &&
			!args.serviceAccountId &&
			!organizations_is_global_organization_id(args.organizationId) &&
			scope.kind === "workspace"
		) {
			if (args.overlayUserId !== args.visibilityUserId) return null;
			const reader = await files_visible_db_create_reader(ctx, {
				organizationId: args.organizationId,
				workspaceId: scope.workspaceId,
				userId: args.visibilityUserId,
				readLimit: 2048,
			});
			const entry = await reader.resolvePath(args.path);
			if (reader.exhausted) throw convex_error({ message: "File path lookup exceeded its read limit." });
			return entry?.kind === "saved" ? entry.node : null;
		}
		const fileNode = await files_db_get_visible_node_by_path(ctx, args);
		if (!fileNode) {
			return null;
		}

		const [readable] = await access_control_db_filter_readable_file_nodes(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.visibilityUserId,
			serviceAccountId: args.serviceAccountId,
			nodes: [fileNode],
		});
		return readable ?? null;
	},
});

export type files_nodes_get_by_path_Result =
	typeof get_by_path extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

export const get_visible_entry_by_path = internalQuery({
	args: {
		agentSource: v.optional(ai_chat_workspaces_source_validator),
		organizationId: doc(app_convex_schema, "files_nodes").fields.organizationId,
		workspaceId: doc(app_convex_schema, "files_nodes").fields.workspaceId,
		path: v.string(),
		visibilityUserId: v.id("users"),
		serviceAccountId: v.optional(v.id("access_control_service_accounts")),
		overlayUserId: v.optional(v.id("users")),
	},
	returns: v.union(
		v.object({
			kind: v.literal("saved"),
			node: doc(app_convex_schema, "files_nodes"),
			pendingUpdate: v.union(doc(app_convex_schema, "files_pending_updates"), v.null()),
			path: v.string(),
		}),
		v.object({
			kind: v.literal("private"),
			node: doc(app_convex_schema, "files_pending_nodes"),
			pendingUpdate: doc(app_convex_schema, "files_pending_updates"),
			path: v.string(),
		}),
		v.null(),
	),
	handler: async (ctx, args): Promise<files_VisibleEntry | null> => {
		const authorized = await files_db_authorize_file_read(ctx, { ...args, userId: args.visibilityUserId });
		if (authorized._nay) return null;
		const scope = files_db_resolve_scope(ctx, args.workspaceId);
		if (organizations_is_global_organization_id(args.organizationId) || scope.kind !== "workspace") {
			const node = await files_db_get_visible_node_by_path(ctx, args);
			return node ? { kind: "saved" as const, node, pendingUpdate: null, path: args.path } : null;
		}

		const organizationId = args.organizationId;
		const workspaceId = scope.workspaceId;
		const membership = await ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_user_organization_workspace_active", (q) =>
				q
					.eq("userId", args.visibilityUserId)
					.eq("organizationId", organizationId)
					.eq("workspaceId", workspaceId)
					.eq("active", true),
			)
			.first();
		if (!membership) return null;

		const workspaceRead = await access_control_db_authorize_membership(ctx, {
			userAuth: { id: args.visibilityUserId },
			membership,
			permission: "content.read",
		});

		const savedNode =
			args.overlayUserId === undefined || args.serviceAccountId !== undefined
				? await files_db_get_visible_node_by_path(ctx, { organizationId, workspaceId, path: args.path })
				: null;

		const entry: files_VisibleEntry | null =
			args.overlayUserId === undefined || args.serviceAccountId !== undefined
				? savedNode
					? { kind: "saved" as const, node: savedNode, pendingUpdate: null, path: args.path }
					: null
				: args.overlayUserId === args.visibilityUserId
					? ((await ctx.runQuery(internal.files_visible.internal_get_by_path, {
							organizationId,
							workspaceId,
							userId: args.visibilityUserId,
							path: args.path,
						})) as files_VisibleEntry | null)
					: null;
		if (!entry) return null;

		let accessNode: Doc<"files_nodes"> | null;
		if (entry.kind === "private") {
			const ancestry = await files_pending_nodes_db_get_ancestry(ctx, {
				organizationId,
				workspaceId,
				userId: args.visibilityUserId,
				privateNodeId: entry.node._id,
			});
			if (ancestry._nay) return null;
			accessNode = ancestry._yay.savedParent;
		} else {
			accessNode = entry.node;
		}

		if (!accessNode) return workspaceRead._nay ? null : entry;
		const [readable] = await access_control_db_filter_readable_file_nodes(ctx, {
			organizationId,
			workspaceId,
			userId: args.visibilityUserId,
			serviceAccountId: args.serviceAccountId,
			hasWorkspaceRead: !workspaceRead._nay,
			nodes: [accessNode],
		});
		return readable ? entry : null;
	},
});

export type files_nodes_get_visible_entry_by_path_Result =
	typeof get_visible_entry_by_path extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

export const get_visible_target_by_path = query({
	args: { membershipId: v.id("organizations_workspaces_users"), path: v.string() },
	returns: v.union(
		v.object({ target: files_pending_target_validator, kind: doc(app_convex_schema, "files_nodes").fields.kind }),
		v.null(),
	),
	// The two same-file lookups below make an inference cycle, so name the return type.
	handler: async (ctx, args): Promise<{ target: files_PendingTarget; kind: Doc<"files_nodes">["kind"] } | null> => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) throw convex_error({ message: "Unauthenticated" });
		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) return null;
		const path = server_path_normalize(args.path);
		// Look up the saved row first, with its access check. An unreadable saved row counts as not
		// found, so the answer never depends on a hidden row. Only then look for the caller's own
		// drafts at this path, so a link to a draft still opens.
		const savedEntry = (await ctx.runQuery(internal.files_nodes.get_visible_entry_by_path, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			visibilityUserId: userAuth.id,
			path,
		})) as files_nodes_get_visible_entry_by_path_Result;
		const entry: files_nodes_get_visible_entry_by_path_Result =
			savedEntry ??
			((await ctx.runQuery(internal.files_nodes.get_visible_entry_by_path, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				visibilityUserId: userAuth.id,
				overlayUserId: userAuth.id,
				path,
			})) as files_nodes_get_visible_entry_by_path_Result);
		if (!entry) return null;
		return {
			target:
				entry.kind === "private"
					? { kind: "private" as const, id: entry.node._id }
					: { kind: "saved" as const, id: entry.node._id },
			kind: entry.node.kind,
		};
	},
});

/**
 * The chat route already proves workspace read access. This lookup checks the node and
 * returns its path in the same user's pending tree.
 */
export const get_path_by_id = internalQuery({
	args: {
		agentSource: v.optional(ai_chat_workspaces_source_validator),
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		visibilityUserId: v.id("users"),
		/**
		 * Keep raw IDs so invalid input returns null instead of an argument error.
		 */
		nodeId: v.string(),
	},
	returns: v.union(v.string(), v.null()),
	handler: async (ctx, args) => {
		if (args.agentSource) {
			const authorized = await ai_chat_workspaces_db_authorize_file_scope(ctx, {
				...args,
				agentSource: args.agentSource,
				userId: args.visibilityUserId,
			});
			if (authorized._nay) return null;
		}
		const nodeId = ctx.db.normalizeId("files_nodes", args.nodeId);
		const privateNodeId = ctx.db.normalizeId("files_pending_nodes", args.nodeId);
		if (!nodeId && !privateNodeId) {
			return null;
		}
		const target = await files_pending_nodes_db_resolve_read_target(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			target: nodeId ? { kind: "saved", id: nodeId } : { kind: "private", id: privateNodeId! },
		});
		if (!target) return null;

		const reader = await files_visible_db_create_reader(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.visibilityUserId,
			readLimit: 2048,
		});
		const entry = await reader.resolveTarget(target);
		if (reader.exhausted) throw convex_error({ message: "File path lookup exceeded its read limit." });
		return entry?.path ?? null;
	},
});

export const resolve_new_node_path = internalQuery({
	args: {
		organizationId: doc(app_convex_schema, "files_nodes").fields.organizationId,
		workspaceId: doc(app_convex_schema, "files_nodes").fields.workspaceId,
		path: v.string(),
		normalizedPath: v.string(),
		overlayUserId: v.optional(v.id("users")),
	},
	returns: v.string(),
	handler: async (ctx, args) => {
		if (args.path === args.normalizedPath) return args.path;
		const scope = files_db_resolve_scope(ctx, args.workspaceId);
		// Hidden targets still occupy their names. Write doors check access after choosing the path.
		if (
			args.overlayUserId &&
			!organizations_is_global_organization_id(args.organizationId) &&
			scope.kind === "workspace"
		) {
			const reader = await files_visible_db_create_reader(ctx, {
				organizationId: args.organizationId,
				workspaceId: scope.workspaceId,
				userId: args.overlayUserId,
				readLimit: 2048,
			});
			const entry = await reader.findPath(args.path);
			if (reader.exhausted) throw convex_error({ message: "File path lookup exceeded its read limit." });
			return entry ? args.path : args.normalizedPath;
		}
		return (await files_db_get_visible_node_by_path(ctx, args)) ? args.path : args.normalizedPath;
	},
});

/**
 * The restricted scope a new or moved child inherits from where it sits: the nearest restricted
 * folder at or above `parentId`, or `null` when that chain has none.
 *
 * The parent already carries the answer, because every node stores its nearest restricted ancestor.
 * So this is one read and never a walk up the tree.
 */
export async function files_nodes_db_resolve_parent_restricted_scope(
	ctx: MutationCtx,
	args: {
		parentId: Doc<"files_nodes">["parentId"];
	},
) {
	if (args.parentId === files_ROOT_ID) {
		return null;
	}

	const parent = await ctx.db.get("files_nodes", args.parentId);
	return parent?.restrictedScopeNodeId ?? null;
}

/**
 * Set a node's own `restrictedScopeNodeId` when a restrict or unrestrict makes it its own restricted
 * root or stops it being one. Start a scope op with `files_subtree_ops_db_start_rebuild` after this
 * for the descendants.
 *
 * The folder table indexes split rows by `isRestrictedScopeRoot`, so the node and its committed
 * metadata field docs get the new flag in the same transaction. Archived docs too, because a restore
 * does not rewrite the flag.
 *
 * A scope change also deletes the public links on this node and below it, now. The scope op reaches
 * the items inside later, and a restrict then unrestrict before it gets there must not bring an old
 * link back.
 *
 * Pass `null` as `shareLinkCleanup` only for a folder this mutation just created. It has no links, so
 * this skips the link scan.
 */
export async function files_nodes_db_set_restricted_scope(args: {
	ctx: MutationCtx;
	organizationId: Doc<"files_nodes">["organizationId"];
	workspaceId: Doc<"files_nodes">["workspaceId"];
	nodeId: Id<"files_nodes">;
	restrictedScopeNodeId: Id<"files_nodes"> | null;
	shareLinkCleanup: files_share_links_CleanupState | null;
}) {
	const { ctx, shareLinkCleanup } = args;

	const node = await files_saved_placement_db_get_node(ctx.db, args.nodeId);
	if (shareLinkCleanup && node?.restrictedScopeNodeId !== args.restrictedScopeNodeId) {
		await files_share_links_db_delete_for_roots({
			ctx,
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			rootNodeIds: [args.nodeId],
			state: shareLinkCleanup,
		});
	}

	const isRestrictedScopeRoot = args.restrictedScopeNodeId === args.nodeId;
	if (
		node &&
		(node.moveCohortId ||
			(await files_move_reservations_db_find_blocker(ctx.db, { source: { kind: "saved", id: node._id } })))
	)
		files_move_reservations_db_enter_security(ctx, { nodeId: node._id });
	if (node?.moveCohortId) {
		// Each placement inherits from its own parent. The access rule changes in both views now.
		for (const view of ["before", "after"] as const) {
			const fixedView = { cohortId: node.moveCohortId, view };
			const place = await ctx.db
				.query("files_saved_places")
				.withIndex("by_cohort_view_node", (q) =>
					q.eq("cohortId", fixedView.cohortId).eq("view", view).eq("nodeId", node._id),
				)
				.unique();
			if (!place) continue;
			let scopeNodeId = isRestrictedScopeRoot ? node._id : null;
			let parentId = place.parentId;
			while (!scopeNodeId && parentId !== files_ROOT_ID) {
				const parent = await files_saved_placement_db_get_node(ctx.db, parentId, fixedView);
				if (!parent) break;
				if (parent.isRestrictedScopeRoot) scopeNodeId = parent._id;
				parentId = parent.parentId;
			}
			await ctx.db.patch("files_saved_places", place._id, {
				restrictedScopeNodeId: scopeNodeId,
				isRestrictedScopeRoot,
			});
			await files_metadata_db_patch_file_scope(ctx, { ...args, isRestrictedScopeRoot, fixedView });
		}
	}
	await ctx.db.patch("files_nodes", args.nodeId, {
		restrictedScopeNodeId: args.restrictedScopeNodeId,
		isRestrictedScopeRoot,
	});
	await files_metadata_db_patch_file_scope(ctx, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		nodeId: args.nodeId,
		isRestrictedScopeRoot,
	});
	await files_updated_by_db_sync_node(ctx, { nodeId: args.nodeId });
}

// #region write-policy

export type files_nodes_WriteContext = {
	writer: Extract<NonNullable<Doc<"files_nodes">["writePolicy"]>, { mode: "writer" }>["writers"][number];
	actorUserId: Id<"users">;
	resourceScope:
		| { kind: "workspace" }
		| { kind: "subtree"; nodeId: Id<"files_nodes"> }
		| { kind: "node"; nodeId: Id<"files_nodes"> }
		| { kind: "create"; parentNodeId: Id<"files_nodes"> | "root"; path: string };
	policyReach: "none" | "direct" | "ancestors";
};

type WriteTarget =
	| { kind: "node"; node: Doc<"files_nodes"> }
	| { kind: "create"; parentNode: Doc<"files_nodes"> | null; path: string };

async function db_is_within_write_scope(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		writeContext: files_nodes_WriteContext;
		target: WriteTarget;
	},
) {
	const scope = args.writeContext.resourceScope;
	let node = args.target.kind === "node" ? args.target.node : args.target.parentNode;
	if (node && (node.organizationId !== args.organizationId || node.workspaceId !== args.workspaceId)) {
		return false;
	}

	if (scope.kind === "workspace") {
		return true;
	}
	if (scope.kind === "create") {
		return (
			args.target.kind === "create" &&
			scope.parentNodeId === (node?._id ?? files_ROOT_ID) &&
			scope.path === args.target.path
		);
	}
	if (scope.kind === "node") {
		return args.target.kind === "node" && node?._id === scope.nodeId;
	}

	while (node) {
		if (node._id === scope.nodeId) {
			return true;
		}
		node = node.parentId === files_ROOT_ID ? null : await ctx.db.get("files_nodes", node.parentId);
	}

	return false;
}

/**
 * Check whether a writer rule lists this writer. A read-only rule lists nobody.
 */
export function files_nodes_writer_matches_policy(args: {
	policy: NonNullable<Doc<"files_nodes">["writePolicy"]>;
	writer: files_nodes_WriteContext["writer"];
}) {
	const writer = args.writer;
	return args.policy.mode === "writer"
		? args.policy.writers.some((policyWriter) =>
				policyWriter.kind === "user"
					? writer.kind === "user" && policyWriter.userId === writer.userId
					: writer.kind === "service_account" && policyWriter.serviceAccountId === writer.serviceAccountId,
			)
		: false;
}

async function db_get_blocking_write_policy(
	ctx: QueryCtx | MutationCtx,
	args: { target: WriteTarget; writeContext: files_nodes_WriteContext },
) {
	// Each node's protection is local. A parent rule never blocks a child on its own; only a real
	// entry change checks the destination folder, and only the named node checks itself.
	if (args.target.kind === "node") {
		const policy = args.target.node.writePolicy;
		if (policy === null) {
			return null;
		}
		if (policy.mode === "read_only") {
			return args.target.node;
		}
		return files_nodes_writer_matches_policy({ policy, writer: args.writeContext.writer }) ? null : args.target.node;
	}

	// A create checks the destination folder's own rule. A matching writer rule still refuses a
	// direct-only service: the parent rule is not the new child's own rule.
	const parent = args.target.parentNode;
	if (!parent) {
		return null;
	}
	const policy = parent.writePolicy;
	if (policy === null) {
		return null;
	}
	if (policy.mode === "read_only") {
		return parent;
	}
	return files_nodes_writer_matches_policy({ policy, writer: args.writeContext.writer }) &&
		args.writeContext.policyReach === "ancestors"
		? null
		: parent;
}

/**
 * Apply the current policy after actor, account, and credential permission checks.
 */
export async function files_nodes_db_require_writable(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		writeContext: files_nodes_WriteContext;
		target: WriteTarget;
	},
) {
	if (!(await db_is_within_write_scope(ctx, args))) {
		return Result({ _nay: { message: "Permission denied" } });
	}

	if (await db_get_blocking_write_policy(ctx, args)) {
		return Result({ _nay: { name: "read_only", message: "This item is read-only." } });
	}

	return Result({ _yay: null });
}

/**
 * Get the starting protection for a brand-new child of `parentId`.
 * The default is copied once. Later changes to the folder do not touch existing children.
 */
export async function files_nodes_db_resolve_parent_new_child_policy(
	ctx: QueryCtx | MutationCtx,
	args: {
		parentId: Doc<"files_nodes">["parentId"];
	},
) {
	if (args.parentId === files_ROOT_ID) {
		return null;
	}

	const parent = await ctx.db.get("files_nodes", args.parentId);
	return parent?.newChildWritePolicy ?? null;
}

/**
 * Allow a copy run into the parent it produced while the parent's current policy still equals
 * the value the run wrote there. A null or changed stored value keeps the live refusal.
 */
export async function files_nodes_db_require_user_writable_or_matching_policy(
	ctx: QueryCtx | MutationCtx,
	args: {
		node: Doc<"files_nodes">;
		userId: Id<"users">;
		runWrittenWritePolicy?: Doc<"files_nodes">["writePolicy"];
	},
) {
	const writable = await files_nodes_db_require_user_writable(ctx, {
		node: args.node,
		userId: args.userId,
	});
	if (!writable._nay) {
		return writable;
	}

	if (
		writable._nay.name !== "read_only" ||
		args.runWrittenWritePolicy == null ||
		JSON.stringify(args.node.writePolicy) !== JSON.stringify(args.runWrittenWritePolicy)
	) {
		return writable;
	}

	return Result({ _yay: null });
}

/**
 * Ordinary app and agent writes always use their current human actor.
 */
export async function files_nodes_db_require_user_writable(
	ctx: QueryCtx | MutationCtx,
	args: { node: Doc<"files_nodes">; userId: Id<"users"> },
) {
	return await files_nodes_db_require_writable(ctx, {
		organizationId: args.node.organizationId,
		workspaceId: args.node.workspaceId,
		target: { kind: "node", node: args.node },
		writeContext: {
			writer: { kind: "user", userId: args.userId },
			actorUserId: args.userId,
			resourceScope: { kind: "workspace" },
			policyReach: "ancestors",
		},
	});
}

/**
 * Actions check the current actor's ACL and policy before writing external objects.
 */
export const get_user_file_write_access = internalQuery({
	args: {
		organizationId: doc(app_convex_schema, "files_nodes").fields.organizationId,
		workspaceId: doc(app_convex_schema, "files_nodes").fields.workspaceId,
		userId: v.id("users"),
		nodeId: v.union(v.id("files_nodes"), v.literal(files_ROOT_ID)),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const node = args.nodeId === files_ROOT_ID ? null : await ctx.db.get("files_nodes", args.nodeId);
		if (
			(args.nodeId !== files_ROOT_ID && !node) ||
			(node && (node.organizationId !== args.organizationId || node.workspaceId !== args.workspaceId))
		) {
			return Result({ _nay: { message: "Not found" } });
		}

		const writeContext: files_nodes_WriteContext = {
			writer: { kind: "user", userId: args.userId },
			actorUserId: args.userId,
			resourceScope: { kind: "workspace" },
			policyReach: "ancestors",
		};
		if (!(await db_has_write_context_permission(ctx, { ...args, node, writeContext, permission: "content.write" }))) {
			return Result({ _nay: { message: "Permission denied" } });
		}

		return node
			? await files_nodes_db_require_user_writable(ctx, { node, userId: args.userId })
			: Result({ _yay: null });
	},
});

export type files_nodes_get_user_file_write_access_Result =
	typeof get_user_file_write_access extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * Load every descendant below `parentId`. Include archived descendants.
 * Use parent ids because active and archived trees can have the same path.
 * Return null when there are more than `MAX_SUBTREE_POLICY_NODE_COUNT`, so one mutation never reads a
 * huge folder and fails on the Convex read limits.
 */
async function db_collect_descendants(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		parentId: Id<"files_nodes">;
	},
) {
	const descendants: Array<Doc<"files_nodes">> = [];
	const stack = [args.parentId];

	while (stack.length > 0) {
		const parentId = stack.pop();
		if (parentId === undefined) {
			continue;
		}

		const children = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_parent_name_archiveOperation", (q) =>
				q
					.eq("organizationId", args.organizationId)
					.eq("workspaceId", args.workspaceId)
					.eq("moveCohortId", undefined)
					.eq("parentId", parentId),
			)
			.take(MAX_SUBTREE_POLICY_NODE_COUNT + 1 - descendants.length);

		descendants.push(...children);
		if (descendants.length > MAX_SUBTREE_POLICY_NODE_COUNT) {
			return null;
		}
		// Only folders have children. Skip the files so the walk reads one index range per folder.
		stack.push(...children.filter((child) => child.kind === "folder").map((child) => child._id));
	}

	return descendants;
}

/**
 * Refuse the whole change when any node is read-only.
 * Say "read-only" only when the caller can see that node. Otherwise use a general error.
 */
export async function files_nodes_db_require_swept_nodes_writable(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		writeContext: files_nodes_WriteContext;
		nodes: readonly Doc<"files_nodes">[];
	},
) {
	// Check each restricted folder once.
	const readableByScopeNodeId = new Map<Id<"files_nodes">, boolean>();
	let hasHiddenRefusal = false;

	for (const node of args.nodes) {
		const writable = await files_nodes_db_require_writable(ctx, { ...args, target: { kind: "node", node } });
		if (!writable._nay) {
			continue;
		}

		const scopeNodeId = node.restrictedScopeNodeId;
		// This node is not restricted. The caller can see the read-only error.
		if (!scopeNodeId) {
			return writable;
		}

		let readable = readableByScopeNodeId.get(scopeNodeId);
		if (readable === undefined) {
			readable = await access_control_db_can_act_on_file_node(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				userId: args.writeContext.actorUserId,
				serviceAccountId:
					args.writeContext.writer.kind === "service_account" ? args.writeContext.writer.serviceAccountId : undefined,
				fileNode: node,
				permission: "content.read",
			});
			readableByScopeNodeId.set(scopeNodeId, readable);
		}

		if (readable) {
			return writable;
		}
		hasHiddenRefusal = true;
	}

	return hasHiddenRefusal ? Result({ _nay: { message: "Permission denied" } }) : Result({ _yay: null });
}

/**
 * Refuse removing a folder when any removed descendant is read-only.
 * Use only for delete, archive, and replace paths. Rename and move never call this:
 * protected descendants travel along and keep their rules.
 * Include archived descendants because hiding them changes them too.
 * Refuse with `subtree_too_large` when the folder holds more than `MAX_SUBTREE_POLICY_NODE_COUNT` items.
 */
export async function files_nodes_db_require_subtree_writable(
	ctx: MutationCtx,
	args: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		writeContext: files_nodes_WriteContext;
		node: Doc<"files_nodes">;
	},
) {
	if (args.node.kind !== "folder") {
		return Result({ _yay: null });
	}

	const subtreeFileNodes = await db_collect_descendants(ctx, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		parentId: args.node._id,
	});
	if (!subtreeFileNodes) {
		return Result({
			_nay: { name: "subtree_too_large", message: "This folder holds too many items to check at once." },
		});
	}

	return await files_nodes_db_require_swept_nodes_writable(ctx, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		writeContext: args.writeContext,
		nodes: subtreeFileNodes,
	});
}

/**
 * Load the membership and node. Check `content.permissions.manage` on the node.
 *
 * Check the node so a grant on a restricted node can allow this action.
 * Policy management must work while content is blocked.
 */
export async function files_nodes_db_authorize_write_policy_management(
	ctx: MutationCtx,
	args: {
		userAuth: { id: Id<"users"> };
		membershipId: Id<"organizations_workspaces_users">;
		nodeId: Id<"files_nodes">;
	},
) {
	const membership = await organizations_db_get_membership(ctx, {
		userId: args.userAuth.id,
		membershipId: args.membershipId,
	});
	if (!membership) {
		return Result({ _nay: { message: "Unauthorized" } });
	}

	const authorized = await access_control_db_authorize_node(ctx, {
		userAuth: args.userAuth,
		membership,
		nodeId: args.nodeId,
		permission: "content.permissions.manage",
	});
	if (authorized._nay) {
		return authorized;
	}

	return Result({ _yay: { membership, node: authorized._yay.fileNode } });
}

async function db_has_write_context_permission(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		writeContext: files_nodes_WriteContext;
		node: Doc<"files_nodes"> | null;
		permission: access_control_Permission;
	},
) {
	const organizationId = ctx.db.normalizeId("organizations", String(args.organizationId));
	const workspaceId = ctx.db.normalizeId("organizations_workspaces", String(args.workspaceId));
	if (!organizationId || !workspaceId) {
		return false;
	}

	const membership = await ctx.db
		.query("organizations_workspaces_users")
		.withIndex("by_active_user_organization_workspace", (q) =>
			q
				.eq("active", true)
				.eq("userId", args.writeContext.actorUserId)
				.eq("organizationId", organizationId)
				.eq("workspaceId", workspaceId),
		)
		.first();
	if (!membership || membership.pendingOrganizationRemoval) {
		return false;
	}

	const authorized = await access_control_db_authorize_membership(ctx, {
		userAuth: { id: args.writeContext.actorUserId },
		membership,
		fileNode: args.node ?? undefined,
		permission: args.permission,
	});
	if (authorized._nay) {
		return false;
	}

	if (args.writeContext.writer.kind === "user") {
		return true;
	}

	return await access_control_db_has_permission(ctx, {
		organizationId,
		workspaceId,
		defaultWorkspaceId: authorized._yay.defaultWorkspaceId,
		organizationOwnerUserId: authorized._yay.organization.ownerUserId,
		resource: args.node
			? { kind: "file", id: String(args.node._id), restrictedScopeNodeId: args.node.restrictedScopeNodeId }
			: { kind: "workspace", id: String(workspaceId) },
		permission: args.permission,
		serviceAccountId: args.writeContext.writer.serviceAccountId,
	});
}

async function db_get_visible_policy_writer(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		writer: files_nodes_WriteContext["writer"];
	},
) {
	const writer = args.writer;
	if (writer.kind === "service_account") {
		const account = await ctx.db.get("access_control_service_accounts", writer.serviceAccountId);
		return account &&
			account.organizationId === args.organizationId &&
			account.workspaceId === args.workspaceId &&
			account.revokedAt === null
			? { ...writer, name: account.name }
			: null;
	}

	const organizationId = ctx.db.normalizeId("organizations", String(args.organizationId));
	const workspaceId = ctx.db.normalizeId("organizations_workspaces", String(args.workspaceId));
	if (!organizationId || !workspaceId) {
		return null;
	}

	const [user, membership] = await Promise.all([
		ctx.db.get("users", writer.userId),
		ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_active_user_organization_workspace", (q) =>
				q
					.eq("active", true)
					.eq("userId", writer.userId)
					.eq("organizationId", organizationId)
					.eq("workspaceId", workspaceId),
			)
			.first(),
	]);
	if (!user || user.deletedAt != null || !membership || membership.pendingOrganizationRemoval) {
		return null;
	}

	const anagraphic = user.anagraphic ? await ctx.db.get("users_anagraphics", user.anagraphic) : null;
	return { ...writer, name: anagraphic?.displayName ?? "User" };
}

/**
 * Check that a copied protection rule still names only writers who can edit the destination.
 * Copies keep access grants separate, so every writer in the rule must be an active destination
 * member or account. Refuse clearly instead of silently clearing the rule.
 */
export async function files_nodes_db_require_copiable_write_policy(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		writePolicy: Doc<"files_nodes">["writePolicy"];
	},
) {
	if (args.writePolicy?.mode === "writer") {
		const visibleWriters = await Promise.all(
			args.writePolicy.writers.map((writer) =>
				db_get_visible_policy_writer(ctx, {
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					writer,
				}),
			),
		);
		if (visibleWriters.includes(null)) {
			return Result({
				_nay: {
					message:
						"The copied protection names a writer who cannot edit this destination. Change the source rule or pick a writer with access first.",
				},
			});
		}
	}

	return Result({ _yay: null });
}

/**
 * Merge freshly read source protection into a copy's `copiedFrom` record.
 * The first write wins: a retry reuses its target and never applies later source rules
 * over what the first attempt captured.
 */
export function files_nodes_db_copied_from_policy_fields(args: {
	prev?: Pick<
		NonNullable<Doc<"files_pending_updates">["copiedFrom"]>,
		"sourceWritePolicy" | "sourceNewChildWritePolicy"
	> | null;
	sourceWritePolicy?: Doc<"files_nodes">["writePolicy"];
	sourceNewChildWritePolicy?: Doc<"files_nodes">["newChildWritePolicy"];
}) {
	if (args.prev?.sourceWritePolicy !== undefined) {
		return {
			sourceWritePolicy: args.prev.sourceWritePolicy,
			...(args.prev.sourceNewChildWritePolicy === undefined
				? {}
				: { sourceNewChildWritePolicy: args.prev.sourceNewChildWritePolicy }),
		};
	}

	return {
		...(args.sourceWritePolicy === undefined ? {} : { sourceWritePolicy: args.sourceWritePolicy }),
		...(args.sourceNewChildWritePolicy === undefined
			? {}
			: { sourceNewChildWritePolicy: args.sourceNewChildWritePolicy }),
	};
}

/**
 * Validate all management before a create or a larger operation starts writing.
 */
export async function files_nodes_db_require_write_policy_management(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		writeContext: files_nodes_WriteContext;
		target: WriteTarget;
		writePolicy: Doc<"files_nodes">["writePolicy"];
	},
) {
	const node = args.target.kind === "node" ? args.target.node : args.target.parentNode;
	if (
		!(await db_is_within_write_scope(ctx, args)) ||
		!(await db_has_write_context_permission(ctx, {
			...args,
			node,
			permission: "content.permissions.manage",
		}))
	) {
		return Result({ _nay: { message: "Permission denied" } });
	}

	if (args.writePolicy?.mode === "writer") {
		const writers = args.writePolicy.writers;
		const writerIds = new Set(
			writers.map((writer) => (writer.kind === "user" ? writer.userId : writer.serviceAccountId)),
		);
		// There is no max count. Every writer must be an active member or account (checked below),
		// so the workspace size already limits the list.
		if (writers.length === 0 || writerIds.size !== writers.length) {
			return Result({ _nay: { message: files_WRITE_POLICY_INVALID_WRITERS_MESSAGE } });
		}

		// Every listed writer must be an active member or account now. The management state hides a
		// stored writer who left, so a manager who saves the rule again has to drop or replace them.
		const visibleWriters = await Promise.all(
			writers.map((writer) => db_get_visible_policy_writer(ctx, { ...args, writer })),
		);
		if (visibleWriters.includes(null)) {
			return Result({ _nay: { message: "Writer is not available" } });
		}
	}

	// Check only the target. A folder's rule limits rename and move-out of its direct children, restricted
	// ones too, the same way write access on a Linux or macOS folder does. Children keep their own rules.
	return Result({ _yay: null });
}

async function db_set_write_policy(
	ctx: MutationCtx,
	args: { node: Doc<"files_nodes">; writePolicy: Doc<"files_nodes">["writePolicy"] },
) {
	if (JSON.stringify(args.writePolicy) === JSON.stringify(args.node.writePolicy)) {
		return;
	}

	// Local change only. Children keep their own rules.
	if (
		args.node.moveCohortId ||
		(await files_move_reservations_db_find_blocker(ctx.db, { source: { kind: "saved", id: args.node._id } }))
	)
		files_move_reservations_db_enter_security(ctx, { nodeId: args.node._id });
	await ctx.db.patch("files_nodes", args.node._id, {
		writePolicy: args.writePolicy,
	});
	await files_media_validation_db_advance_version(ctx, args.node);
}

export async function files_nodes_db_set_write_policy(
	ctx: MutationCtx,
	args: {
		node: Doc<"files_nodes">;
		writeContext: files_nodes_WriteContext;
		writePolicy: Doc<"files_nodes">["writePolicy"];
	},
) {
	const allowed = await files_nodes_db_require_write_policy_management(ctx, {
		organizationId: args.node.organizationId,
		workspaceId: args.node.workspaceId,
		writeContext: args.writeContext,
		target: { kind: "node", node: args.node },
		writePolicy: args.writePolicy,
	});
	if (allowed._nay) {
		return allowed;
	}

	if (JSON.stringify(args.node.writePolicy) !== JSON.stringify(args.writePolicy)) {
		await db_set_write_policy(ctx, args);
	}

	return Result({ _yay: null });
}

export async function files_nodes_db_get_write_policy_management_state(
	ctx: QueryCtx | MutationCtx,
	args: { node: Doc<"files_nodes">; writeContext: files_nodes_WriteContext },
) {
	const { node, writeContext } = args;
	const permissionArgs = { organizationId: node.organizationId, workspaceId: node.workspaceId, node, writeContext };
	const [management, canWriteContent, blockingPolicy] = await Promise.all([
		files_nodes_db_require_write_policy_management(ctx, {
			...permissionArgs,
			target: { kind: "node", node },
			writePolicy: null,
		}),
		db_has_write_context_permission(ctx, { ...permissionArgs, permission: "content.write" }),
		db_get_blocking_write_policy(ctx, { writeContext, target: { kind: "node", node } }),
	]);
	const inScope = await db_is_within_write_scope(ctx, { ...permissionArgs, target: { kind: "node", node } });

	// Return only the writers the caller may see, plus how many were hidden or revoked.
	async function visible_policy(policy: Doc<"files_nodes">["writePolicy"]) {
		if (policy?.mode !== "writer") {
			return policy;
		}

		const writers = await Promise.all(
			policy.writers.map((writer) => db_get_visible_policy_writer(ctx, { ...permissionArgs, writer })),
		);
		const visibleWriters = writers.filter((writer) => writer !== null);
		return {
			mode: "writer" as const,
			writers: visibleWriters,
			hiddenWriterCount: writers.length - visibleWriters.length,
		};
	}

	const writeBlockedReason =
		!canWriteContent || !inScope ? ("permission" as const) : blockingPolicy ? ("read_only" as const) : null;

	return {
		nodeId: node._id,
		canManage: !management._nay,
		canWrite: writeBlockedReason === null,
		writeBlockedReason,
		localPolicy: await visible_policy(node.writePolicy),
		localDefault: node.kind === "folder" ? await visible_policy(node.newChildWritePolicy) : null,
	};
}

const files_nodes_visible_policy_validator = v.union(
	v.null(),
	v.object({ mode: v.literal("read_only") }),
	v.object({
		mode: v.literal("writer"),
		writers: v.array(
			v.union(
				v.object({ kind: v.literal("user"), userId: v.id("users"), name: v.string() }),
				v.object({
					kind: v.literal("service_account"),
					serviceAccountId: v.id("access_control_service_accounts"),
					name: v.string(),
				}),
			),
		),
		/**
		 * Writers the caller cannot see: people who left the workspace and revoked or foreign accounts.
		 * Their ids stay hidden. Saving the rule again drops them.
		 */
		hiddenWriterCount: v.number(),
	}),
);

export const files_nodes_write_policy_management_state_validator = v.object({
	nodeId: v.id("files_nodes"),
	canManage: v.boolean(),
	canWrite: v.boolean(),
	writeBlockedReason: v.union(v.null(), v.literal("permission"), v.literal("read_only")),
	localPolicy: files_nodes_visible_policy_validator,
	localDefault: v.union(v.null(), files_nodes_visible_policy_validator),
});

export const get_node_write_policy_management_state = query({
	args: { membershipId: v.id("organizations_workspaces_users"), nodeId: v.id("files_nodes") },
	returns: v.union(v.null(), files_nodes_write_policy_management_state_validator),
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

		return await files_nodes_db_get_write_policy_management_state(ctx, {
			node: authorized._yay.fileNode,
			writeContext: {
				writer: { kind: "user", userId: userAuth.id },
				actorUserId: userAuth.id,
				resourceScope: { kind: "workspace" },
				policyReach: "ancestors",
			},
		});
	},
});

/**
 * Return which kind of default a folder gives its new children, without account names.
 * The sidebar reads it before a create. `get_node_write_policy_management_state` does more work than
 * a create needs: it checks management, write access and the blocking rule, and looks up account names.
 */
export const get_folder_new_child_write_policy_state = query({
	args: { membershipId: v.id("organizations_workspaces_users"), nodeId: v.id("files_nodes") },
	returns: v.union(v.null(), v.literal("none"), v.literal("read_only"), v.literal("writer")),
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
		if (authorized._nay || authorized._yay.fileNode.kind !== "folder") {
			return null;
		}

		const newChildWritePolicy = authorized._yay.fileNode.newChildWritePolicy;
		return newChildWritePolicy === null ? "none" : newChildWritePolicy.mode;
	},
});

export const set_node_write_policy = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
		writePolicy: doc(app_convex_schema, "files_nodes").fields.writePolicy,
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "files_tree_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const authorized = await files_nodes_db_authorize_write_policy_management(ctx, {
			userAuth,
			membershipId: args.membershipId,
			nodeId: args.nodeId,
		});
		if (authorized._nay) {
			return authorized;
		}

		return await files_nodes_db_set_write_policy(ctx, {
			node: authorized._yay.node,
			writePolicy: args.writePolicy,
			writeContext: {
				writer: { kind: "user", userId: userAuth.id },
				actorUserId: userAuth.id,
				resourceScope: { kind: "workspace" },
				policyReach: "ancestors",
			},
		});
	},
});

export async function files_nodes_db_set_new_child_write_policy(
	ctx: MutationCtx,
	args: {
		node: Doc<"files_nodes">;
		writeContext: files_nodes_WriteContext;
		newChildWritePolicy: Doc<"files_nodes">["writePolicy"];
	},
) {
	if (args.node.kind !== "folder") {
		return Result({ _nay: { message: "Only folders have a new-item default." } });
	}

	const allowed = await files_nodes_db_require_write_policy_management(ctx, {
		organizationId: args.node.organizationId,
		workspaceId: args.node.workspaceId,
		writeContext: args.writeContext,
		target: { kind: "node", node: args.node },
		writePolicy: args.newChildWritePolicy,
	});
	if (allowed._nay) {
		return allowed;
	}

	if (JSON.stringify(args.node.newChildWritePolicy) === JSON.stringify(args.newChildWritePolicy)) {
		return Result({ _yay: null });
	}

	// The default changes, but existing children keep their rules.
	if (
		args.node.moveCohortId ||
		(await files_move_reservations_db_find_blocker(ctx.db, { source: { kind: "saved", id: args.node._id } }))
	)
		files_move_reservations_db_enter_security(ctx, { nodeId: args.node._id });
	await ctx.db.patch("files_nodes", args.node._id, {
		newChildWritePolicy: args.newChildWritePolicy,
	});
	await files_media_validation_db_advance_version(ctx, args.node);

	return Result({ _yay: null });
}

export const set_node_new_child_write_policy = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
		newChildWritePolicy: doc(app_convex_schema, "files_nodes").fields.writePolicy,
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "files_tree_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const authorized = await files_nodes_db_authorize_write_policy_management(ctx, {
			userAuth,
			membershipId: args.membershipId,
			nodeId: args.nodeId,
		});
		if (authorized._nay) {
			return authorized;
		}

		return await files_nodes_db_set_new_child_write_policy(ctx, {
			node: authorized._yay.node,
			newChildWritePolicy: args.newChildWritePolicy,
			writeContext: {
				writer: { kind: "user", userId: userAuth.id },
				actorUserId: userAuth.id,
				resourceScope: { kind: "workspace" },
				policyReach: "ancestors",
			},
		});
	},
});

// #endregion write-policy

/**
 * Check `content.write` on the node that decides a file write.
 *
 * For a change to an existing node that is the node itself. For a new node, or for one about to be
 * dropped somewhere, it is the folder it lands in. At the root there is no node to ask about, so
 * the workspace answers.
 *
 * Asking the node, and not the workspace, is what makes a grant useful: somebody whose only power
 * in this workspace is a grant on one restricted folder can still work inside it, which a
 * workspace-wide check would refuse at the door.
 */
export async function authorize_file_write(
	ctx: QueryCtx | MutationCtx,
	args: {
		userAuth: { id: Id<"users"> };
		membership: Doc<"organizations_workspaces_users">;
		nodeId: Doc<"files_nodes">["parentId"];
	},
) {
	if (args.nodeId === files_ROOT_ID) {
		return await access_control_db_authorize_membership(ctx, {
			userAuth: args.userAuth,
			membership: args.membership,
			permission: "content.write",
		});
	}

	return await access_control_db_authorize_node(ctx, {
		userAuth: args.userAuth,
		membership: args.membership,
		nodeId: args.nodeId,
		permission: "content.write",
	});
}

/**
 * Check the third permission leg of a move: leaving a restricted folder.
 *
 * A move already asks two questions. May the caller write this node, and may they write where it
 * lands. There is a third. When a node sits inside a restricted folder and lands somewhere that
 * folder does not cover, everybody who can read the destination can now read the file, its history
 * and its comments. That is a change to who can see it, so it needs the permission that owns
 * sharing. `content.write` means "change what is inside", never "change who can see it".
 *
 * Moving a folder does this to every file under it in one action, so the cost of getting it wrong
 * is a whole subtree, not one file. "They could copy the text out anyway" is a different thing:
 * copying gives one person a copy, this hands everyone the real file.
 *
 * A folder that is the restricted scope itself carries that scope wherever it goes, so it changes
 * nobody's access and is not asked about.
 */
export async function authorize_leaving_restricted_scope(
	ctx: MutationCtx,
	args: {
		userAuth: { id: Id<"users"> };
		membership: Doc<"organizations_workspaces_users">;
		fileNode: Doc<"files_nodes">;
		destParentId: Doc<"files_nodes">["parentId"];
	},
) {
	if (!args.fileNode.restrictedScopeNodeId || args.fileNode.restrictedScopeNodeId === args.fileNode._id) {
		return Result({ _yay: null });
	}

	const destScopeNodeId = await files_nodes_db_resolve_parent_restricted_scope(ctx, {
		parentId: args.destParentId,
	});
	if (destScopeNodeId === args.fileNode.restrictedScopeNodeId) {
		return Result({ _yay: null });
	}

	const authorized = await access_control_db_authorize_membership(ctx, {
		userAuth: args.userAuth,
		membership: args.membership,
		permission: "content.permissions.manage",
		fileNode: args.fileNode,
	});
	if (authorized._nay) {
		// Name the level the Share dialog shows, so the message says what to ask a manager for.
		return Result({
			_nay: { name: "nay", message: "You need Can manage on the shared folder to move this out of it." },
		});
	}

	return Result({ _yay: null });
}

/**
 * Whether the caller may write a file here. `nodeId` is the node that decides, the same one
 * `authorize_file_write` takes.
 *
 * An action cannot read the database, so every action that writes a file asks this first. Without
 * it those actions would still be asking the workspace, and would refuse the one person a grant was
 * meant for.
 */
export const get_current_user_file_write_permission = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.union(v.id("files_nodes"), v.literal(files_ROOT_ID)),
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return false;
		}

		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return false;
		}

		const authorized = await authorize_file_write(ctx, { userAuth, membership, nodeId: args.nodeId });
		if (authorized._nay) {
			return false;
		}
		if (args.nodeId === files_ROOT_ID) {
			return true;
		}
		const node = await ctx.db.get("files_nodes", args.nodeId);
		return node !== null && !(await files_nodes_db_require_user_writable(ctx, { node, userId: userAuth.id }))._nay;
	},
});

function node_insert_fields(args: {
	userId: Doc<"files_nodes">["createdBy"];
	organizationId: Doc<"files_nodes">["organizationId"];
	workspaceId: Doc<"files_nodes">["workspaceId"];
	parentId: Doc<"files_nodes">["parentId"];
	name: string;
	path: string;
	kind: Doc<"files_nodes">["kind"];
	contentType?: Doc<"files_nodes">["contentType"];
	assetId?: Id<"files_r2_assets">;
	contentByteSize?: number;
	archiveOperationId?: Doc<"files_nodes">["archiveOperationId"];
	restrictedScopeNodeId: Doc<"files_nodes">["restrictedScopeNodeId"];
	writePolicy?: Doc<"files_nodes">["writePolicy"];
	newChildWritePolicy?: Doc<"files_nodes">["newChildWritePolicy"];
	now: number;
}) {
	return {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		parentId: args.parentId,
		kind: args.kind,
		name: args.name,
		sortName: files_sort_text_key(args.name),
		path: args.path,
		treePath: files_derive_tree_path_for_file_node(args.path, args.kind),
		pathDepth: files_path_depth(args.path),
		lowercaseExtension: files_lowercase_extension(args.path, args.kind),
		contentType: args.contentType ?? null,
		...files_content_type_index_fields(args.contentType ?? null),
		assetId: args.assetId ?? null,
		contentByteSize: args.contentByteSize ?? null,
		textKind: null,
		collaborationEnabled: null,
		yjsSnapshotId: null,
		yjsLastSequenceId: null,
		statsId: null,
		contentTooLargeByteSize: null,
		contentShapeMismatchAt: null,
		contentYjsStateTooLargeByteSize: null,
		contentFrontmatterTooLargeFieldCount: null,
		contentFrontmatterTooLargeIndexDocumentCount: null,
		restrictedScopeNodeId: args.restrictedScopeNodeId,
		// A new node inherits its parent's scope, so it is never its own restricted root.
		isRestrictedScopeRoot: false,
		writePolicy: args.writePolicy ?? null,
		newChildWritePolicy: args.newChildWritePolicy ?? null,
		archiveOperationId: args.archiveOperationId ?? null,
		createdBy: args.userId,
		updatedBy: args.userId,
		updatedAt: args.now,
	};
}

async function db_insert_node(
	ctx: MutationCtx,
	args: {
		userId: Doc<"files_nodes">["createdBy"];
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		parentId: Doc<"files_nodes">["parentId"];
		name: Doc<"files_nodes">["name"];
		path: Doc<"files_nodes">["path"];
		kind: Doc<"files_nodes">["kind"];
		contentType?: Doc<"files_nodes">["contentType"];
		assetId?: Id<"files_r2_assets">;
		archiveOperationId?: Doc<"files_nodes">["archiveOperationId"];
		/**
		 * Set when the caller inserts the file's content docs right after this insert, in the same
		 * mutation, via `files_nodes_db_insert_file_content_docs` (files_nodes_content.ts). Skips
		 * the initial UNPROCESSABLE stats write so those callers do not double-write stats.
		 */
		expectsTextContent?: true;
		/**
		 * Omitted means copy the immediate parent's new-child default. An explicit value,
		 * including null, is an override the caller already checked for management rights.
		 * Copy operations pass the verified source settings through here instead.
		 */
		writePolicy?: Doc<"files_nodes">["writePolicy"];
		/**
		 * Omitted on a new folder means copy the parent default too. Files always store null.
		 */
		newChildWritePolicy?: Doc<"files_nodes">["newChildWritePolicy"];
		now: number;
	},
) {
	// A new node sits inside its parent, so it starts with the parent's restricted scope. Without
	// this, a file created inside a restricted folder would be open to the whole workspace, which is
	// the one thing the person who restricted that folder asked us not to do.
	const restrictedScopeNodeId = await files_nodes_db_resolve_parent_restricted_scope(ctx, {
		parentId: args.parentId,
	});

	// Copying the default is an ordinary creation step. It needs no policy-management right.
	const parentDefault = await files_nodes_db_resolve_parent_new_child_policy(ctx, {
		parentId: args.parentId,
	});

	// Upload assets are inserted with their declared size, and the R2 upload event corrects it later.
	const asset = args.assetId ? await ctx.db.get("files_r2_assets", args.assetId) : null;

	const nodeId = await ctx.db.insert(
		"files_nodes",
		node_insert_fields({
			...args,
			contentByteSize: asset?.size,
			restrictedScopeNodeId,
			writePolicy: args.writePolicy !== undefined ? args.writePolicy : parentDefault,
			newChildWritePolicy:
				args.kind === "folder"
					? args.newChildWritePolicy !== undefined
						? args.newChildWritePolicy
						: parentDefault
					: null,
		}),
	);
	await files_media_validation_db_advance_version(ctx, args);
	await files_updated_by_db_sync_node(ctx, { nodeId });

	if (args.kind === "folder") {
		return Result({ _yay: nodeId });
	}

	// Content callers insert the file's content docs (and real stats) right after this returns,
	// still inside the same mutation. Keep the assetId invariant here: every file with text
	// content links a content or version-snapshot asset.
	if (args.expectsTextContent) {
		if (!args.assetId) {
			const errorMessage = "fileNode.assetId is not set";
			const errorData = {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				nodeId,
			};
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}
		return Result({ _yay: nodeId });
	}

	// A file with no processable text content (e.g. a raw upload) still gets a stats doc, flagged
	// unprocessable with -1. A later materialization overwrites it with real counts if text appears.
	await db_upsert_file_stats(ctx, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		nodeId,
		lineCount: files_STATS_UNPROCESSABLE,
		wordCount: files_STATS_UNPROCESSABLE,
		charCount: files_STATS_UNPROCESSABLE,
	});
	return Result({ _yay: nodeId });
}

/**
 * Create a node from a path, creating each missing parent folder segment before
 * creating the final file/folder segment.
 *
 * Trust callers to pass a valid, normalized path for the requested leaf kind.
 */
export async function files_nodes_db_create_node_recursively_at_path(
	ctx: MutationCtx,
	args: {
		userId: Doc<"files_nodes">["createdBy"];
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		parentId: Doc<"files_nodes">["parentId"];
		path: string;
		kind: Doc<"files_nodes">["kind"];
		contentType?: Doc<"files_nodes">["contentType"];
		assetId?: Id<"files_r2_assets">;
		archiveOperationId?: Doc<"files_nodes">["archiveOperationId"];
		/** Forwarded to `db_insert_node` for the leaf only; see the arg doc there. */
		expectsTextContent?: true;
		/**
		 * Metadata for the leaf file or folder only. Import names must not spread to ancestors.
		 */
		metadata?: files_metadata_Entry[];
		/**
		 * Initial metadata on each new node. Reused nodes keep their existing maps.
		 */
		createdNodesMetadata?: files_metadata_Entry[];
		now: number;
		/**
		 * Trusted delegated facts; ordinary callers use their explicit human author.
		 */
		writeContext?: files_nodes_WriteContext;
		/**
		 * Initial local policy on the leaf. It requires manage permission before any insert,
		 * unless `trustPolicySource` marks it as verified source settings from a copy.
		 */
		writePolicy?: Doc<"files_nodes">["writePolicy"];
		/**
		 * Initial default on a new leaf folder. Same manage rule as `writePolicy`, unless
		 * `trustPolicySource` marks it as verified source settings from a copy.
		 */
		newChildWritePolicy?: Doc<"files_nodes">["newChildWritePolicy"];
		/**
		 * Set only by server copy paths that read both settings from the source doc itself.
		 * It skips the manage check but keeps the destination writer check. Never set this
		 * from client input.
		 */
		trustPolicySource?: true;
		/**
		 * Set only when a replace copies `writePolicy` from the file it replaces. It keeps the manage
		 * check but skips the writer check. Those writers were checked when the rule was set, and a
		 * writer who left since then must not stop the others from replacing the file.
		 */
		keepsReplacedPolicy?: true;
		/**
		 * Set only by a copy run that produced `parentId` itself. The create may proceed while
		 * the parent's current policy still equals this value, even when the value is a lock.
		 * Never set this from client input.
		 */
		expectedParentWritePolicy?: Doc<"files_nodes">["writePolicy"];
	},
) {
	let parentNode =
		args.parentId === files_ROOT_ID ? null : await files_saved_placement_db_get_node(ctx.db, args.parentId);
	// Only an active folder takes children. An archived parent is hidden, so a live child created
	// there would be hidden too until a restore.
	if (
		args.parentId !== files_ROOT_ID &&
		(!parentNode ||
			parentNode.organizationId !== args.organizationId ||
			parentNode.workspaceId !== args.workspaceId ||
			parentNode.kind !== "folder" ||
			parentNode.archiveOperationId !== null)
	) {
		return Result({ _nay: { message: "Not found" } });
	}

	const segments = path_extract_segments_from(args.path);
	let parentPath = parentNode?.path ?? "/";
	let firstMissing = 0;
	const writeContext: files_nodes_WriteContext | null =
		args.userId === users_SYSTEM_AUTHOR
			? null
			: (args.writeContext ?? {
					writer: { kind: "user", userId: args.userId },
					actorUserId: args.userId,
					resourceScope: { kind: "workspace" },
					policyReach: "ancestors",
				});

	// Resolve every existing segment before creating anything. A later refusal must leave no folders.
	for (const [i, name] of segments.entries()) {
		const existing = await files_saved_placement_db_get_slot(ctx.db, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			parentId: parentNode?._id ?? files_ROOT_ID,
			name,
		});
		firstMissing = i;
		if (!existing) {
			break;
		}

		if (
			writeContext &&
			!(await access_control_db_can_act_on_file_node(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				userId: writeContext.actorUserId,
				fileNode: existing,
				permission: "content.write",
			}))
		) {
			return Result({ _nay: { message: "Permission denied" } });
		}

		const isLeaf = i === segments.length - 1;
		if (existing.kind !== "folder" || isLeaf) {
			if (
				writeContext &&
				!(await db_has_write_context_permission(ctx, {
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					writeContext,
					node: existing,
					permission: "content.write",
				}))
			) {
				return Result({ _nay: { message: "Permission denied" } });
			}
			if (isLeaf && args.archiveOperationId != null) {
				break;
			}
			return Result({
				_nay: { message: isLeaf && args.kind === "file" ? "This file already exists." : "This folder already exists." },
			});
		}

		parentNode = existing;
		parentPath = existing.path;
	}

	const missingNames = segments.slice(firstMissing);
	const intendedPath = missingNames.reduce((path, name) => path_join(path, name), parentPath);
	if (writeContext) {
		const target = { kind: "create" as const, parentNode, path: intendedPath };
		if (
			!(await db_has_write_context_permission(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				writeContext,
				node: parentNode,
				permission: "content.write",
			}))
		) {
			return Result({ _nay: { message: "Permission denied" } });
		}

		const writable = await files_nodes_db_require_writable(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			writeContext,
			target,
		});
		// A copy run may create inside the parent it produced while that parent's current
		// policy still equals the value the run wrote. Any other refusal stands.
		if (
			writable._nay &&
			(writable._nay.name !== "read_only" ||
				args.expectedParentWritePolicy == null ||
				JSON.stringify(parentNode?.writePolicy ?? null) !== JSON.stringify(args.expectedParentWritePolicy))
		) {
			return writable;
		}

		if (args.writePolicy !== undefined || args.newChildWritePolicy !== undefined) {
			if (args.trustPolicySource) {
				for (const policy of [args.writePolicy, args.newChildWritePolicy]) {
					if (policy === undefined) {
						continue;
					}
					const copiable = await files_nodes_db_require_copiable_write_policy(ctx, {
						organizationId: args.organizationId,
						workspaceId: args.workspaceId,
						writePolicy: policy,
					});
					if (copiable._nay) {
						return copiable;
					}
				}
			} else {
				// Check every explicit override. A default-only create must not skip
				// the writer check by falling back to writePolicy: null.
				for (const policy of [args.writePolicy, args.newChildWritePolicy]) {
					if (policy === undefined) {
						continue;
					}
					const managed = await files_nodes_db_require_write_policy_management(ctx, {
						organizationId: args.organizationId,
						workspaceId: args.workspaceId,
						writeContext,
						target,
						// A null rule checks only the manage permission.
						writePolicy: args.keepsReplacedPolicy ? null : policy,
					});
					if (managed._nay) {
						return managed;
					}
				}
			}
		}
	}

	const organizationId = ctx.db.normalizeId("organizations", args.organizationId);
	const workspaceId = ctx.db.normalizeId("organizations_workspaces", args.workspaceId);
	if (organizationId && workspaceId && missingNames[0] !== undefined) {
		const parentId = parentNode?._id ?? files_ROOT_ID;
		const busy = await files_move_reservations_db_check(ctx.db, {
			parent: parentId === files_ROOT_ID ? { kind: "root" } : { kind: "saved", id: parentId },
			slot: { organizationId, workspaceId, parentId, name: missingNames[0] },
		});
		if (busy._nay) return busy;
	}

	let currentParent = parentNode?._id ?? files_ROOT_ID;
	let path = parentPath;
	for (const [i, name] of missingNames.entries()) {
		const isLeaf = i === missingNames.length - 1;
		path = path_join(path, name);
		const nodeIdResult = await db_insert_node(ctx, {
			userId: args.userId,
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			parentId: currentParent,
			name,
			path,
			kind: isLeaf ? args.kind : "folder",
			contentType: isLeaf ? args.contentType : undefined,
			assetId: isLeaf ? args.assetId : undefined,
			archiveOperationId: isLeaf ? args.archiveOperationId : undefined,
			expectsTextContent: isLeaf ? args.expectsTextContent : undefined,
			writePolicy: isLeaf ? args.writePolicy : undefined,
			newChildWritePolicy: isLeaf ? args.newChildWritePolicy : undefined,
			now: args.now,
		});
		if (nodeIdResult._nay) {
			return nodeIdResult;
		}

		const metadata =
			isLeaf && args.metadata
				? files_metadata_apply_set_and_remove(args.createdNodesMetadata ?? [], { set: args.metadata, remove: [] })
				: args.createdNodesMetadata;
		if (metadata) {
			const createdNode = await ctx.db.get("files_nodes", nodeIdResult._yay);
			if (!createdNode) {
				const errorMessage = "created node is missing right after insert";
				const errorData = { nodeId: nodeIdResult._yay };
				console.error(errorMessage, errorData);
				throw should_never_happen(errorMessage, errorData);
			}
			await files_metadata_db_write_entries(ctx, { fileNode: createdNode, entries: metadata });
		}

		if (isLeaf) {
			return Result({ _yay: nodeIdResult._yay });
		}
		currentParent = nodeIdResult._yay;
	}

	const errorMessage = "nodeId not resolved after node path creation";
	const errorData = {};
	console.error(errorMessage, errorData);
	throw should_never_happen(errorMessage, errorData);
}

export const create_folder_node = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		parentId: v.union(v.id("files_nodes"), v.literal(files_ROOT_ID)),
		path: v.string(),
	},
	returns: v_result({ _yay: v.object({ nodeId: v.id("files_nodes") }) }),
	handler: async (ctx, args) => {
		const userAuthPromise = server_convex_get_user_fallback_to_anonymous(ctx);
		const membershipPromise = ctx.db.get("organizations_workspaces_users", args.membershipId);

		const userAuth = await userAuthPromise;
		if (!userAuth) {
			await membershipPromise;
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const [rateLimit, membership] = await Promise.all([
			rate_limiter_limit_by_key(ctx, { name: "files_tree_write", key: userAuth.id }),
			membershipPromise,
		]);
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		if (!membership || membership.userId !== userAuth.id || membership.active === false) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const authorized = await authorize_file_write(ctx, {
			userAuth,
			membership,
			nodeId: args.parentId,
		});
		if (authorized._nay) {
			return authorized;
		}

		// We trust that the front-end is validating the input correctly.
		const nodeIdResult = await files_nodes_db_create_node_recursively_at_path(ctx, {
			userId: userAuth.id,
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			parentId: args.parentId,
			path: args.path,
			kind: "folder",
			now: Date.now(),
		});

		if (nodeIdResult._nay) {
			return nodeIdResult;
		}

		return Result({ _yay: { nodeId: nodeIdResult._yay } });
	},
});

/**
 * Create a folder at a trusted absolute path for server-side agent tools.
 *
 * Trust callers to validate and normalize `path` before calling this mutation.
 */
export const create_folder_node_by_path = internalMutation({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		path: v.string(),
	},
	returns: v_result({ _yay: v.object({ nodeId: v.id("files_nodes"), exists: v.boolean() }) }),
	handler: async (ctx, args) => {
		const activeNode = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
				q
					.eq("organizationId", args.organizationId)
					.eq("workspaceId", args.workspaceId)
					.eq("moveCohortId", undefined)
					.eq("path", args.path)
					.eq("archiveOperationId", null),
			)
			.first();

		// The lookup above is raw, so it also finds a node the caller cannot see. Handing back the id of a
		// restricted folder would be enough: `mkdir` remembers what it gets, so `stat` would then read that
		// folder too. A taken path still says something is there, as every path entrypoint does, but not what.
		if (
			activeNode &&
			!(await access_control_db_can_act_on_file_node(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				userId: args.userId,
				fileNode: activeNode,
				permission: "content.write",
			}))
		) {
			return Result({ _nay: { message: "Permission denied" } });
		}

		if (activeNode?.kind === "folder") {
			return Result({ _yay: { nodeId: activeNode._id, exists: true } });
		}
		if (activeNode?.kind === "file") {
			return Result({ _nay: { message: "A file already exists at this path." } });
		}

		// Nothing is at this path, so no existing node answered the permission question, and the walk
		// below will not ask one either: it only checks nodes that already exist. The caller is an
		// action, which proves nothing before calling, so the workspace has to answer here, in the
		// transaction that writes. `create_file_node` asks the same question for the same reason, so
		// `mkdir` and `touch` refuse the same people.
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

		const authorized = await authorize_file_write(ctx, {
			userAuth: { id: args.userId },
			membership,
			nodeId: files_ROOT_ID,
		});
		if (authorized._nay) {
			return Result({ _nay: { message: "Permission denied" } });
		}

		const nodeId = await files_nodes_db_create_node_recursively_at_path(ctx, {
			userId: args.userId,
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			parentId: files_ROOT_ID,
			path: args.path,
			kind: "folder",
			now: Date.now(),
		});

		if (nodeId._nay) {
			return nodeId;
		}

		return Result({ _yay: { nodeId: nodeId._yay, exists: false } });
	},
});

export type files_nodes_create_folder_node_by_path_Result =
	typeof create_folder_node_by_path extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * Check a private create before allocating content. Commit repeats this same plan because
 * access, quotas, and occupied names can change while the action prepares the content.
 */
export async function files_nodes_db_plan_private_node_by_path(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
		path: string;
		kind: "file" | "folder";
		uniqueName?: boolean;
	},
) {
	if (
		args.path.length > 1024 ||
		!args.path.startsWith("/") ||
		/[\\*?\[\]{}]/.test(args.path) ||
		args.path
			.slice(1)
			.split("/")
			.some((segment) => segment === "" || segment === "." || segment === "..")
	)
		return Result({ _nay: { message: "Invalid file path" } });
	const normalized = files_get_normalized_node_path_segments({
		kind: args.kind,
		nameOrPath: args.path,
		fileNamePolicy: "keep_extension",
	});
	if (
		!normalized ||
		"validationMessage" in normalized ||
		`/${normalized.normalizedPathSegments.join("/")}` !== args.path
	) {
		return Result({ _nay: { message: "Invalid file path" } });
	}
	let segments = normalized.normalizedPathSegments;

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
	if (!membership) return Result({ _nay: { message: "Permission denied" } });

	const reader = await files_visible_db_create_reader(ctx, { ...args, readLimit: 4096 });
	let path = args.path;
	if (args.uniqueName) {
		const dot = path.lastIndexOf(".");
		const extensionStart = dot > path.lastIndexOf("/") + 1 ? dot : path.length;
		let available = false;
		for (let suffix = 0; suffix < 100; suffix++) {
			const candidate =
				suffix === 0 ? path : `${path.slice(0, extensionStart)}-${suffix + 1}${path.slice(extensionStart)}`;
			// A pending move or delete can hide a saved occupant from the owner's view.
			const saved = await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", args.organizationId)
						.eq("workspaceId", args.workspaceId)
						.eq("moveCohortId", undefined)
						.eq("path", candidate)
						.eq("archiveOperationId", null),
				)
				.first();
			if (!saved && !(await reader.findPath(candidate))) {
				path = candidate;
				available = true;
				break;
			}
		}
		if (!available || reader.exhausted) return Result({ _nay: { message: "No free filename was found" } });
		segments = path.slice(1).split("/");
	}

	let parent: Doc<"files_pending_nodes">["parent"] = { kind: "root" };
	let savedParent: Doc<"files_nodes"> | null = null;
	let privateDepth = 0;
	let missingFrom = 0;

	// Find existing parents so creation can reuse them and add only the missing path.
	for (; missingFrom < segments.length; missingFrom++) {
		const entry = (await reader.findPath(`/${segments.slice(0, missingFrom + 1).join("/")}`))?.entry;
		if (reader.exhausted) return Result({ _nay: { message: "Create path lookup exceeded its read limit." } });
		if (!entry) break;

		if (entry.kind === "private") {
			const ancestry = await files_pending_nodes_db_get_ancestry(ctx, { ...args, privateNodeId: entry.node._id });
			if (ancestry._nay) return ancestry;
			savedParent = ancestry._yay.savedParent;
			privateDepth = ancestry._yay.ancestors.length + 1;
		} else {
			savedParent = entry.node;
			privateDepth = 0;
		}

		const readable = await access_control_db_authorize_membership(ctx, {
			userAuth: { id: args.userId },
			membership,
			fileNode: savedParent ?? undefined,
			permission: "content.read",
		});
		if (readable._nay) return Result({ _nay: { message: "Permission denied" } });

		if (missingFrom === segments.length - 1) {
			if (entry.node.kind !== args.kind)
				return Result({ _nay: { message: "A different entry already exists at this path" } });
			return Result({
				_yay: {
					kind: "existing" as const,
					target:
						entry.kind === "saved"
							? { kind: "saved" as const, id: entry.node._id }
							: { kind: "private" as const, id: entry.node._id },
					created: false,
					pendingUpdateId: entry.pendingUpdate?._id ?? null,
					operationBatchId: null,
				},
			});
		}

		if (entry.node.kind !== "folder") return Result({ _nay: { message: "Not a directory" } });
		if (entry.kind === "private" && entry.pendingUpdate.createIntent?.kind !== "folder") {
			return Result({ _nay: { name: "preparing", message: "This draft folder is still preparing" } });
		}
		parent = entry.kind === "saved" ? { kind: "saved", id: entry.node._id } : { kind: "private", id: entry.node._id };
	}

	const writable = await authorize_file_write(ctx, {
		userAuth: { id: args.userId },
		membership,
		nodeId: savedParent?._id ?? files_ROOT_ID,
	});
	if (writable._nay) return writable;
	if (savedParent) {
		const policy = await files_nodes_db_require_user_writable(ctx, { node: savedParent, userId: args.userId });
		if (policy._nay) return policy;
	}

	const missingCount = segments.length - missingFrom;
	// Bound the ancestor checks and writes of one implicit-parent create.
	if (missingCount > 32 || privateDepth + missingCount > 256) {
		return Result({ _nay: { name: "too_large", message: "Create the parent folders in smaller groups" } });
	}

	const now = Date.now();
	const quotaId = await quotas_db_ensure(ctx, { ...args, quotaName: "files_private_nodes", now });
	const quota = await ctx.db.get("quotas", quotaId);
	if (!quota) throw should_never_happen("Missing private node quota", { quotaId });
	if (quota.usedCount + missingCount > quota.maxCount) {
		return Result({ _nay: { name: "storage_full", message: quotas.files_private_nodes.disabledReason } });
	}
	return Result({ _yay: { kind: "create" as const, path, segments, missingFrom, parent, now } });
}

/**
 * Create only the missing path. Text stays Preparing until its initial batch commits.
 * Stored content attaches in the caller's transaction after its upload completes.
 */
export async function files_nodes_db_create_private_node_by_path(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
		path: string;
		kind: "file" | "folder";
		threadId?: Id<"ai_chat_threads">;
		agentSource?: Infer<typeof ai_chat_workspaces_source_validator>;
		content?:
			| { kind: "stored"; assetId: Id<"files_r2_assets">; size: number; contentType: string }
			| { kind: "text"; contentType: string; textKind: files_YjsRootKind };
	},
) {
	if (args.agentSource) {
		const allowed = await ai_chat_workspaces_db_authorize_file_scope(ctx, { ...args, agentSource: args.agentSource });
		if (allowed._nay) return allowed;
	}
	const planned = await files_nodes_db_plan_private_node_by_path(ctx, {
		...args,
		uniqueName: args.content !== undefined,
	});
	if (planned._nay) return planned;
	if (planned._yay.kind === "existing") {
		const { kind: _kind, ...existing } = planned._yay;
		return Result({ _yay: { ...existing, createdNodeIds: [] as Id<"files_pending_nodes">[], path: args.path } });
	}
	const { path, segments, missingFrom, now } = planned._yay;
	let parent = planned._yay.parent;
	const createdNodeIds: Id<"files_pending_nodes">[] = [];

	for (let index = missingFrom; index < segments.length; index++) {
		const kind = index === segments.length - 1 ? args.kind : "folder";
		const created = await files_pending_nodes_db_create(ctx, { ...args, parent, name: segments[index]!, kind });
		if (created._nay) throw should_never_happen("Private path changed after preflight", { path: args.path });
		const { privateNodeId, pendingUpdateId } = created._yay;
		createdNodeIds.push(privateNodeId);
		const shape =
			args.content?.kind === "text"
				? { contentType: args.content.contentType, rootKind: args.content.textKind }
				: files_default_text_shape_for_name(segments[index]!);

		await files_db_patch_pending_update({
			ctx,
			pendingUpdateId,
			value: {
				createIntent:
					kind === "folder"
						? { kind: "folder", metadata: [] }
						: args.content?.kind === "stored"
							? { ...args.content, metadata: [] }
							: {
									kind: "text",
									contentType: shape.contentType,
									textKind: shape.rootKind,
									collaborationEnabled: true,
									metadata: [],
								},
				// Uploaded bytes already know their size. A text create keeps size 0 until its first batch.
				...(kind === "file" && args.content?.kind === "stored" ? { size: args.content.size } : {}),
			},
		});
		parent = { kind: "private", id: privateNodeId };

		if (index === segments.length - 1) {
			// Text still needs its first edit batch. Stored bytes are already complete at creation.
			const operationBatchId =
				kind === "file" && args.content?.kind !== "stored"
					? await ctx.db.insert("files_pending_update_operation_batches", {
							organizationId: args.organizationId,
							workspaceId: args.workspaceId,
							userId: args.userId,
							target: { kind: "private", id: privateNodeId },
							expectedPendingUpdateId: pendingUpdateId,
							expectedRevision: 1,
							expectedPrivateVersion: { creationGeneration: 1, structuralRevision: 1 },
							initialCreation: true,
							...(args.agentSource ? { agentSource: args.agentSource } : {}),
							expiresAt: now + 30 * 60 * 1000,
							updatedAt: now,
							lastActivityAt: now,
						})
					: null;
			return Result({
				_yay: {
					target: { kind: "private" as const, id: privateNodeId },
					created: true,
					pendingUpdateId,
					operationBatchId,
					createdNodeIds,
					path,
				},
			});
		}
	}

	throw should_never_happen("Private create has no path segments", { path: args.path });
}

export const create_private_node_by_path = internalMutation({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		path: v.string(),
		kind: v.union(v.literal("file"), v.literal("folder")),
		threadId: v.optional(v.id("ai_chat_threads")),
		agentSource: v.optional(ai_chat_workspaces_source_validator),
	},
	returns: v_result({
		_yay: v.object({
			target: files_pending_target_validator,
			created: v.boolean(),
			pendingUpdateId: v.union(v.id("files_pending_updates"), v.null()),
			operationBatchId: v.union(v.id("files_pending_update_operation_batches"), v.null()),
		}),
	}),
	handler: async (ctx, args) => {
		const result = await files_nodes_db_create_private_node_by_path(ctx, args);
		if (result._nay) return result;
		const { createdNodeIds: _createdNodeIds, path: _path, ...created } = result._yay;
		return Result({ _yay: created });
	},
});

export type files_nodes_create_private_node_by_path_Result =
	typeof create_private_node_by_path extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * Delete one bounded batch of a subtree: range-scan `files_nodes` by `treePath` over
 * `[prefix, path_tree_prefix_upper_bound(prefix))` and, for each node, delete its committed chunks, `file_stats`,
 * metadata docs, and R2 asset (object + doc, gated on `r2Key`) BEFORE the node doc itself, so a
 * crash never orphans children. Asset and node deletion are one budget unit pair so a node never
 * commits with a missing asset reference. Callers drive this to `done: true` by calling repeatedly.
 *
 * This deletes no public links. Every caller deletes a global or plugin-volume tree, and those files
 * can never get a link. Add link cleanup before a workspace caller uses this.
 */
export async function files_nodes_db_delete_subtree_batch(
	ctx: MutationCtx,
	args: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		/** `files_nodes.treePath` prefix of the subtree, including the trailing slash (e.g. `/<root>/`). */
		treePathPrefix: string;
		batchSize: number;
	},
) {
	const lower = args.treePathPrefix;
	const upper = path_tree_prefix_upper_bound(lower);

	let deletedCount = 0;
	while (deletedCount < args.batchSize) {
		const node = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_treePath", (q) =>
				q
					.eq("organizationId", args.organizationId)
					.eq("workspaceId", args.workspaceId)
					.eq("moveCohortId", undefined)
					.gte("treePath", lower)
					.lt("treePath", upper),
			)
			.order("desc")
			.first();
		if (!node) {
			break;
		}

		const remainingPlainTextChunks = args.batchSize - deletedCount;
		let plainTextChunks = await ctx.db
			.query("files_plain_text_chunks")
			.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
				q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("fileNodeId", node._id),
			)
			.take(remainingPlainTextChunks);
		if (plainTextChunks.length === 0) {
			plainTextChunks = await ctx.db
				.query("files_plain_text_chunks")
				.withIndex("by_organization_workspace_target_chunkIndex", (q) =>
					q
						.eq("organizationId", args.organizationId)
						.eq("workspaceId", args.workspaceId)
						.eq("target.kind", "saved")
						.eq("target.id", node._id),
				)
				.take(remainingPlainTextChunks);
		}
		for (const chunk of plainTextChunks) {
			await ctx.db.delete("files_plain_text_chunks", chunk._id);
			deletedCount++;
		}
		if (plainTextChunks.length > 0) {
			continue;
		}

		const remainingTextChunks = args.batchSize - deletedCount;
		let textChunks = await ctx.db
			.query("files_text_chunks")
			.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
				q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("fileNodeId", node._id),
			)
			.take(remainingTextChunks);
		if (textChunks.length === 0) {
			textChunks = await ctx.db
				.query("files_text_chunks")
				.withIndex("by_organization_workspace_target_chunkIndex", (q) =>
					q
						.eq("organizationId", args.organizationId)
						.eq("workspaceId", args.workspaceId)
						.eq("target.kind", "saved")
						.eq("target.id", node._id),
				)
				.take(remainingTextChunks);
		}
		for (const chunk of textChunks) {
			await ctx.db.delete("files_text_chunks", chunk._id);
			deletedCount++;
		}
		if (textChunks.length > 0) {
			continue;
		}

		const remainingFileStats = args.batchSize - deletedCount;
		const fileStats = await ctx.db
			.query("file_stats")
			.withIndex("by_organization_workspace_fileNode", (q) =>
				q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("fileNodeId", node._id),
			)
			.take(remainingFileStats);
		for (const stats of fileStats) {
			await ctx.db.delete("file_stats", stats._id);
			deletedCount++;
		}
		if (fileStats.length > 0) {
			continue;
		}

		const remainingMetadataDocs = args.batchSize - deletedCount;
		let metadataDocs = await ctx.db
			.query("files_metadata_docs")
			.withIndex("by_organization_workspace_fileNode_fieldPath", (q) =>
				q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("fileNodeId", node._id),
			)
			.take(remainingMetadataDocs);
		if (metadataDocs.length === 0) {
			metadataDocs = await ctx.db
				.query("files_metadata_docs")
				.withIndex("by_organization_workspace_target_fieldPath", (q) =>
					q
						.eq("organizationId", args.organizationId)
						.eq("workspaceId", args.workspaceId)
						.eq("target.kind", "saved")
						.eq("target.id", node._id),
				)
				.take(remainingMetadataDocs);
		}
		for (const metadataDoc of metadataDocs) {
			await ctx.db.delete("files_metadata_docs", metadataDoc._id);
			deletedCount++;
		}
		if (metadataDocs.length > 0) {
			continue;
		}

		if (node.assetId) {
			const asset = await ctx.db.get("files_r2_assets", node.assetId);
			if (asset) {
				if (deletedCount + 2 > args.batchSize) {
					break;
				}
				if (asset.r2Key) {
					await r2.deleteObject(ctx, asset.r2Key);
				}
				await ctx.db.delete("files_r2_assets", asset._id);
				await ctx.db.delete("files_nodes", node._id);
				deletedCount += 2;
				continue;
			}
		}

		if (deletedCount >= args.batchSize) {
			break;
		}
		await ctx.db.delete("files_nodes", node._id);
		deletedCount++;
	}

	const remaining = await ctx.db
		.query("files_nodes")
		.withIndex("by_organization_workspace_treePath", (q) =>
			q
				.eq("organizationId", args.organizationId)
				.eq("workspaceId", args.workspaceId)
				.eq("moveCohortId", undefined)
				.gte("treePath", lower)
				.lt("treePath", upper),
		)
		.first();

	return { done: remaining === null, deletedCount };
}

/**
 * Transfer the late-PUT deadline before node or tenant deletion removes this asset.
 * The caller owns deleting the node's snapshots and the asset doc.
 */
export async function files_nodes_db_handoff_yjs_cleanup_task(ctx: MutationCtx, task: Doc<"files_yjs_cleanup_tasks">) {
	const asset = await ctx.db.get("files_r2_assets", task.supersededYjsAssetId);
	if (asset) {
		await r2_enqueue_object_deletion_job(ctx, {
			organizationId: task.organizationId,
			workspaceId: task.workspaceId,
			r2Key:
				asset.r2Key ??
				r2_create_asset_key({
					organizationId: task.organizationId,
					workspaceId: task.workspaceId,
					assetId: asset._id,
				}),
			reason: "untracked_asset_event",
			putMayArriveUntil: task.putMayArriveUntil ?? undefined,
		});
	}

	await ctx.db.delete("files_yjs_cleanup_tasks", task._id);
}

/**
 * Remove a failed file creation and its linked content, proposals, and assets.
 */
export async function files_nodes_db_hard_delete_node(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		nodeId: Id<"files_nodes">;
	},
) {
	const node = await ctx.db.get("files_nodes", args.nodeId);
	if (!node || node.organizationId !== args.organizationId || node.workspaceId !== args.workspaceId) {
		return;
	}
	// Every caller cleans up an upload that never completed, and all of them pass a file node.
	if (node.kind !== "file") {
		const errorMessage = "files_nodes_db_hard_delete_node only supports file nodes";
		const errorData = { nodeId: args.nodeId, kind: node.kind };
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}

	await files_share_links_db_delete_for_node(ctx, args);
	await files_updated_by_db_delete_for_node(ctx, { nodeId: node._id });

	const [
		plainTextChunks,
		textChunks,
		fileStats,
		metadataDocs,
		yjsSnapshots,
		yjsUpdates,
		yjsLastSequences,
		materializationJobs,
		snapshots,
		pendingUpdates,
		lastSequenceSavedDocs,
		shareGrants,
		yjsCleanupTasks,
	] = await Promise.all([
		Promise.all([
			ctx.db
				.query("files_plain_text_chunks")
				.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
					q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("fileNodeId", node._id),
				)
				.collect(),
			ctx.db
				.query("files_plain_text_chunks")
				.withIndex("by_organization_workspace_target_chunkIndex", (q) =>
					q
						.eq("organizationId", args.organizationId)
						.eq("workspaceId", args.workspaceId)
						.eq("target.kind", "saved")
						.eq("target.id", node._id),
				)
				.collect(),
		]).then((families) => families.flat()),
		Promise.all([
			ctx.db
				.query("files_text_chunks")
				.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
					q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("fileNodeId", node._id),
				)
				.collect(),
			ctx.db
				.query("files_text_chunks")
				.withIndex("by_organization_workspace_target_chunkIndex", (q) =>
					q
						.eq("organizationId", args.organizationId)
						.eq("workspaceId", args.workspaceId)
						.eq("target.kind", "saved")
						.eq("target.id", node._id),
				)
				.collect(),
		]).then((families) => families.flat()),
		ctx.db
			.query("file_stats")
			.withIndex("by_organization_workspace_fileNode", (q) =>
				q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("fileNodeId", node._id),
			)
			.collect(),
		Promise.all([
			ctx.db
				.query("files_metadata_docs")
				.withIndex("by_organization_workspace_fileNode_fieldPath", (q) =>
					q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("fileNodeId", node._id),
				)
				.collect(),
			ctx.db
				.query("files_metadata_docs")
				.withIndex("by_organization_workspace_target_fieldPath", (q) =>
					q
						.eq("organizationId", args.organizationId)
						.eq("workspaceId", args.workspaceId)
						.eq("target.kind", "saved")
						.eq("target.id", node._id),
				)
				.collect(),
		]).then((families) => families.flat()),
		ctx.db
			.query("files_yjs_snapshots")
			.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
				q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("fileNodeId", node._id),
			)
			.collect(),
		ctx.db
			.query("files_yjs_updates")
			.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
				q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("fileNodeId", node._id),
			)
			.collect(),
		ctx.db
			.query("files_yjs_docs_last_sequences")
			.withIndex("by_organization_workspace_fileNode", (q) =>
				q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("fileNodeId", node._id),
			)
			.collect(),
		ctx.db
			.query("files_content_materialization_jobs")
			.withIndex("by_organization_workspace_fileNode", (q) =>
				q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("fileNodeId", node._id),
			)
			.collect(),
		ctx.db
			.query("files_snapshots")
			.withIndex("by_organization_workspace_fileNode_archivedAt", (q) =>
				q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("fileNodeId", node._id),
			)
			.collect(),
		ctx.db
			.query("files_pending_updates")
			.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", node._id))
			.collect(),
		ctx.db
			.query("files_pending_updates_last_sequence_saved")
			.withIndex("by_organization_workspace_fileNode_user", (q) =>
				q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("fileNodeId", node._id),
			)
			.collect(),
		// A single file can be restricted too, and then it owns share grants. Deleting the file without
		// them would leave rows nothing can ever reach or remove.
		ctx.db
			.query("access_control_permission_grants")
			.withIndex("by_organization_workspace_resource_user_permission", (q) =>
				q
					.eq("organizationId", args.organizationId)
					.eq("workspaceId", args.workspaceId)
					.eq("resourceKind", "file")
					.eq("resourceId", String(node._id)),
			)
			.collect(),
		ctx.db
			.query("files_yjs_cleanup_tasks")
			.withIndex("by_organization_workspace_fileNode_historyPending", (q) =>
				q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("fileNodeId", node._id),
			)
			.collect(),
	]);

	// node.assetId points at the newest version snapshot for editable files, so the same asset id
	// can appear again in `snapshots`; dedupe before deleting.
	const assetIds = new Set<Id<"files_r2_assets">>();
	if (node.assetId) {
		assetIds.add(node.assetId);
	}
	for (const yjsSnapshot of yjsSnapshots) {
		assetIds.add(yjsSnapshot.assetId);
	}
	for (const snapshot of snapshots) {
		assetIds.add(snapshot.assetId);
	}
	// Transfer the late-PUT deadline before deleting the retired snapshot asset.
	for (const task of yjsCleanupTasks) {
		assetIds.add(task.supersededYjsAssetId);
		await files_nodes_db_handoff_yjs_cleanup_task(ctx, task);
	}
	// A staged whole-file replacement (`cp` onto this file) owns a published object of its own.
	for (const pendingUpdate of pendingUpdates) {
		if (pendingUpdate.pendingReplacement) {
			assetIds.add(pendingUpdate.pendingReplacement.assetId);
		}
	}

	// Delete every pending doc's canonical paged state family beside its other children.
	await Promise.all(
		pendingUpdates.map((pendingUpdate) =>
			files_db_delete_pending_update_yjs_states(ctx, { pendingUpdateId: pendingUpdate._id }),
		),
	);

	// Also drain every remaining node-scoped state family (temporary and retired owners included)
	// — the by-node index reaches them cheaply. Operation batches, text inputs and trusted-update
	// stages have no by-node index (their indexes lead with the user), so a hard delete leaves
	// them to the 30-minute TTL sweep on purpose: they carry no committed content, expire on
	// their own, and a new index only for this path is not worth its write cost.
	const nodeScopedStates = await ctx.db
		.query("files_pending_update_yjs_states")
		.withIndex("by_organization_workspace_target", (q) =>
			q
				.eq("organizationId", args.organizationId)
				.eq("workspaceId", args.workspaceId)
				.eq("target.kind", "saved")
				.eq("target.id", node._id),
		)
		.collect();
	await Promise.all(
		nodeScopedStates.map(async (stateDoc) => {
			const pages = await ctx.db
				.query("files_pending_update_yjs_state_pages")
				.withIndex("by_state_pageIndex", (q) => q.eq("stateId", stateDoc._id))
				.collect();
			await Promise.all(pages.map((page) => ctx.db.delete("files_pending_update_yjs_state_pages", page._id)));
			await ctx.db.delete("files_pending_update_yjs_states", stateDoc._id);
		}),
	);

	await Promise.all([
		...plainTextChunks.map((chunk) => ctx.db.delete("files_plain_text_chunks", chunk._id)),
		...textChunks.map((chunk) => ctx.db.delete("files_text_chunks", chunk._id)),
		...fileStats.map((stats) => ctx.db.delete("file_stats", stats._id)),
		...metadataDocs.map((metadataDoc) => ctx.db.delete("files_metadata_docs", metadataDoc._id)),
		...yjsSnapshots.map((yjsSnapshot) => ctx.db.delete("files_yjs_snapshots", yjsSnapshot._id)),
		...yjsUpdates.map((yjsUpdate) => ctx.db.delete("files_yjs_updates", yjsUpdate._id)),
		...yjsLastSequences.map((lastSequence) => ctx.db.delete("files_yjs_docs_last_sequences", lastSequence._id)),
		...materializationJobs.map((job) => ctx.db.delete("files_content_materialization_jobs", job._id)),
		...snapshots.map((snapshot) => ctx.db.delete("files_snapshots", snapshot._id)),
		...pendingUpdates.map((pendingUpdate) =>
			files_db_delete_pending_update({ ctx, pendingUpdateId: pendingUpdate._id }),
		),
		...lastSequenceSavedDocs.map((doc) => ctx.db.delete("files_pending_updates_last_sequence_saved", doc._id)),
		...shareGrants.map((grant) => ctx.db.delete("access_control_permission_grants", grant._id)),
	]);

	for (const assetId of assetIds) {
		const asset = await ctx.db.get("files_r2_assets", assetId);
		if (!asset) {
			continue;
		}
		// Keep cleanup retryable after the asset doc is gone. Upload callers already own their guards.
		await r2_enqueue_object_deletion_job(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			r2Key:
				asset.r2Key ??
				r2_create_asset_key({
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					assetId: asset._id,
				}),
			reason: "untracked_asset_event",
			mode: "ensure",
		});
		await ctx.db.delete("files_r2_assets", asset._id);
	}

	await ctx.db.delete("files_nodes", node._id);
}

/**
 * A signed upload URL works for 15 minutes.
 * Store its end time so cleanup knows when the URL can no longer write the temporary R2 file.
 */
export const files_UPLOAD_URL_TTL_MS = 15 * 60 * 1000;

export const create_upload_node = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		parentId: v.union(v.id("files_nodes"), v.literal(files_ROOT_ID)),
		filename: v.string(),
		contentType: v.optional(v.string()),
		size: v.number(),
		/**
		 * What to do when the target path is taken. Defaults to "replace", which archives the
		 * file that holds the path. "fail" leaves it alone and answers
		 * `files_UPLOAD_PATH_TAKEN_MESSAGE`, for callers that pick their own name and can try
		 * the next one, like the rich text editor uploading a pasted image.
		 */
		onConflict: v.optional(v.union(v.literal("replace"), v.literal("fail"))),
	},
	returns: v_result({
		_yay: v.object({
			assetId: v.id("files_r2_assets"),
			nodeId: v.id("files_nodes"),
			url: v.string(),
			headers: v.record(v.string(), v.string()),
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

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "files_tree_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const authorized = await authorize_file_write(ctx, {
			userAuth,
			membership,
			nodeId: args.parentId,
		});
		if (authorized._nay) {
			return authorized;
		}

		const organization = await ctx.db.get("organizations", membership.organizationId);
		if (!organization) {
			const errorMessage = "membership.organizationId points to a missing organizations doc";
			const errorData = {
				membershipId: membership._id,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
			};
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}

		const admission = await files_stored_uploads_db_admit(ctx, {
			organization,
			actorUserId: userAuth.id,
			workspaceId: membership.workspaceId,
			declaredBytes: [args.size],
		});
		if (admission._nay) return admission;

		// The stored type decides how the upload is processed and opened, so settle it before any
		// write. The caller's type wins when it is valid. The name is only a hint when no type was
		// sent, and a file with neither is stored bytes. A broken type is refused, not guessed.
		const storedContentType = files_resolve_upload_content_type({
			contentType: args.contentType,
			fileName: path_name_of(args.filename),
		});
		if (storedContentType === null) {
			return Result({ _nay: { message: files_INVALID_CONTENT_TYPE_MESSAGE } });
		}

		let parentPath = "/";
		if (args.parentId !== files_ROOT_ID) {
			const parent = await ctx.db.get("files_nodes", args.parentId);
			if (
				!parent ||
				parent.organizationId !== membership.organizationId ||
				parent.workspaceId !== membership.workspaceId ||
				parent.kind !== "folder" ||
				parent.archiveOperationId !== null
			) {
				return Result({ _nay: { message: "Not found" } });
			}
			// The caller has write permission, but the folder can still be read-only.
			// Check before writing the archive or asset docs.
			const parentWritable = await files_nodes_db_require_user_writable(ctx, { node: parent, userId: userAuth.id });
			if (parentWritable._nay) {
				return parentWritable;
			}
			parentPath = parent.path;
		}

		args = { ...args, filename: files_normalize_special_node_path("file", args.filename) };
		const path = path_join(parentPath, args.filename);
		const existingNode = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
				q
					.eq("organizationId", membership.organizationId)
					.eq("workspaceId", membership.workspaceId)
					.eq("moveCohortId", undefined)
					.eq("path", path)
					.eq("archiveOperationId", null),
			)
			.first();
		const now = Date.now();

		// The check at the top of the handler asked about `parentId`. A filename may carry path
		// segments, so between `parentId` and the file there can be folders nobody has asked about, and
		// one of them can be a restricted folder this caller may not write. The create below walks them
		// and does refuse — but by then this mutation has archived the old file and written an asset
		// doc, and a Convex mutation that returns normally commits both. So ask about them here, while
		// nothing has been written yet. Only folders that already exist can carry a restriction, which
		// is the same set the create walk checks.
		const nameSegments = path_extract_segments_from(args.filename);
		let intermediateParentId = args.parentId;
		for (const name of nameSegments.slice(0, -1)) {
			const intermediate = await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_parent_name_archiveOperation", (q) =>
					q
						.eq("organizationId", membership.organizationId)
						.eq("workspaceId", membership.workspaceId)
						.eq("moveCohortId", undefined)
						.eq("parentId", intermediateParentId)
						.eq("name", name)
						.eq("archiveOperationId", null),
				)
				.first();
			if (!intermediate) {
				break;
			}

			if (
				!(await access_control_db_can_act_on_file_node(ctx, {
					organizationId: membership.organizationId,
					workspaceId: membership.workspaceId,
					userId: userAuth.id,
					fileNode: intermediate,
					permission: "content.write",
				}))
			) {
				return Result({ _nay: { message: "Permission denied" } });
			}

			// Check every existing folder in the path. Each folder stores its current lock.
			// Do this before writing the archive or asset docs.
			const intermediateWritable = await files_nodes_db_require_user_writable(ctx, {
				node: intermediate,
				userId: userAuth.id,
			});
			if (intermediateWritable._nay) {
				return intermediateWritable;
			}

			// A file cannot hold other files, so this upload can never succeed. The create below says the
			// same thing, in the same words and only to callers who got past the check above, but it says
			// it after the asset doc is written. Answer here, while nothing has been written yet.
			if (intermediate.kind !== "folder") {
				return Result({ _nay: { message: "This folder already exists." } });
			}

			intermediateParentId = intermediate._id;
		}

		if (existingNode) {
			// Answer before the permission check below, so a caller that may write the parent
			// folder gets the same reply whether or not it may write the file holding the path.
			// `create_upload_nodes` hides restricted paths the same way.
			if (args.onConflict === "fail") {
				return Result({ _nay: { message: files_UPLOAD_PATH_TAKEN_MESSAGE } });
			}

			if (existingNode.kind !== "file") {
				return Result({
					_nay: {
						message: "The path cannot point to a folder",
					},
				});
			}

			// Uploading over a name archives whatever holds it. The check above asked about the folder, so
			// without this an upload could replace a restricted file the caller cannot even open.
			if (
				!(await access_control_db_can_act_on_file_node(ctx, {
					organizationId: membership.organizationId,
					workspaceId: membership.workspaceId,
					userId: userAuth.id,
					fileNode: existingNode,
					permission: "content.write",
				}))
			) {
				return Result({ _nay: { message: "Permission denied" } });
			}

			// Replace archives the current file, so that file must be writable.
			// The caller can use another upload name when it is locked.
			const occupantWritable = await files_nodes_db_require_user_writable(ctx, {
				node: existingNode,
				userId: userAuth.id,
			});
			if (occupantWritable._nay) {
				return occupantWritable;
			}

			await files_nodes_db_archive_nodes({
				ctx,
				nodeIds: [existingNode._id],
				updatedBy: userAuth.id,
				now,
				shareLinkCleanup: files_share_links_create_cleanup_state(),
			});
		}

		const assetId = await ctx.db.insert("files_r2_assets", {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			kind: "upload",
			r2Bucket: r2.config.bucket,
			size: args.size,
			createdBy: membership.userId,
			unfinalizedExpiresAt: now + r2_UNFINALIZED_ASSET_TTL_MS,
			updatedAt: now,
		});
		const uploadR2Key = r2_create_asset_key({
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			assetId,
		});

		const nodeIdResult = await files_nodes_db_create_node_recursively_at_path(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: membership.userId,
			parentId: args.parentId,
			path: args.filename,
			kind: "file",
			contentType: storedContentType,
			assetId,
			// The size and the media type are not stamped here: both are client-declared at this
			// point. The R2 event publish stamps the real ones.
			metadata: [
				{ key: "source", value: "upload" },
				{ key: "original-name", value: args.filename },
			],
			now,
		});
		if (nodeIdResult._nay) {
			return Result({ _nay: nodeIdResult._nay });
		}

		// Keep the URL end time so cleanup can remove a late PUT.
		// An accepted upload always finishes. A later lock stops new writes, not this one.
		await ctx.db.patch("files_r2_assets", assetId, {
			uploadUrlExpiresAt: now + files_UPLOAD_URL_TTL_MS,
		});
		const signedUpload = await r2.generateUploadUrl(uploadR2Key, {
			createOnly: true,
			expiresIn: files_UPLOAD_URL_TTL_MS / 1000,
		});
		const headers: Record<string, string> = { "Content-Type": storedContentType, "If-None-Match": "*" };

		return Result({
			_yay: {
				assetId,
				nodeId: nodeIdResult._yay,
				url: signedUpload.url,
				headers,
			},
		});
	},
});

/**
 * Create upload nodes and presigned R2 PUT urls for a folder import from the browser.
 *
 * The batch contract: after validation, one file's problem never fails the whole call. Every
 * item ends as created or as skipped with a reason. A malformed item (bad path shape, bad
 * name, bad size, duplicate target) still fails the whole call, because the client
 * pre-normalizes and only a buggy or hostile caller sends one.
 *
 * Unlike `data_import.create_upload_targets`, assets keep `processingWorkId` unset, so the R2
 * event finalizer runs Markdown conversion and plugin dispatch like any single-file upload.
 */
export const create_upload_nodes = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		parentId: v.union(v.id("files_nodes"), v.literal(files_ROOT_ID)),
		/**
		 * What to do when a file already sits on an item's target path. "replace" archives it
		 * like `create_upload_node`; "skip" leaves it and reports the item as skipped. The
		 * client sends "skip" unless the user explicitly confirmed replacing.
		 */
		onConflict: v.union(v.literal("replace"), v.literal("skip")),
		items: v.array(
			v.object({
				relativePath: v.string(),
				contentType: v.optional(v.string()),
				size: v.number(),
			}),
		),
	},
	returns: v_result({
		_yay: v.object({
			created: v.array(
				v.object({
					relativePath: v.string(),
					assetId: v.id("files_r2_assets"),
					nodeId: v.id("files_nodes"),
					url: v.string(),
					headers: v.record(v.string(), v.string()),
				}),
			),
			// "conflict" covers every refusal about the target file itself, including permission
			// refusals, so the payload never says which paths are restricted. "path_blocked" means
			// the path cannot hold a file at all: a folder owns it, or a file owns an ancestor.
			skipped: v.array(
				v.object({
					relativePath: v.string(),
					reason: v.union(v.literal("conflict"), v.literal("path_blocked")),
				}),
			),
		}),
		_nay: {
			data: v.object({
				retryAfterMs: v.optional(v.number()),
				path: v.optional(v.string()),
			}),
		},
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

		if (args.items.length === 0) {
			return Result({ _nay: { message: "No files to import" } });
		}
		if (args.items.length > files_IMPORT_MAX_ITEMS_PER_CALL) {
			return Result({ _nay: { message: "Too many files" } });
		}

		// Two buckets: `files_tree_write` for call parity with the other tree mutations, and the
		// per-item import bucket so one call cannot mint 50 nodes for a single tree-write token.
		// Ask the item bucket first without consuming: a successful charge commits even when the
		// mutation then returns `_nay`, so charging tree-write before knowing the item bucket
		// would pass would burn a token on every refused retry.
		const bulkCheck = await rate_limiter_check_by_key(ctx, {
			name: "files_bulk_import",
			key: userAuth.id,
			count: args.items.length,
		});
		if (bulkCheck) {
			return Result({ _nay: { message: bulkCheck.message, data: { retryAfterMs: bulkCheck.retryAfterMs } } });
		}
		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "files_tree_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message, data: { retryAfterMs: rateLimit.retryAfterMs } } });
		}
		const bulkLimit = await rate_limiter_limit_by_key(ctx, {
			name: "files_bulk_import",
			key: userAuth.id,
			count: args.items.length,
		});
		if (bulkLimit) {
			return Result({ _nay: { message: bulkLimit.message, data: { retryAfterMs: bulkLimit.retryAfterMs } } });
		}

		const authorized = await authorize_file_write(ctx, {
			userAuth,
			membership,
			nodeId: args.parentId,
		});
		if (authorized._nay) {
			return authorized;
		}

		const organization = await ctx.db.get("organizations", membership.organizationId);
		if (!organization) {
			const errorMessage = "membership.organizationId points to a missing organizations doc";
			const errorData = {
				membershipId: membership._id,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
			};
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}

		let parentPath = "/";
		if (args.parentId !== files_ROOT_ID) {
			const parent = await ctx.db.get("files_nodes", args.parentId);
			if (
				!parent ||
				parent.organizationId !== membership.organizationId ||
				parent.workspaceId !== membership.workspaceId ||
				parent.kind !== "folder" ||
				parent.archiveOperationId !== null
			) {
				return Result({ _nay: { message: "Not found" } });
			}
			// A read-only parent folder refuses the whole import before any write.
			// A problem inside one item path skips only that item below.
			const parentWritable = await files_nodes_db_require_user_writable(ctx, { node: parent, userId: userAuth.id });
			if (parentWritable._nay) {
				return parentWritable;
			}
			parentPath = parent.path;
		}

		// Structural validation for the whole batch, before any write. The client pre-normalizes,
		// so a failure here is a caller bug and fails the whole call with the path attached.
		const targetPaths = new Set<string>();
		const validated: Array<{
			relativePath: string;
			segments: string[];
			targetPath: string;
			contentType: string | undefined;
			size: number;
		}> = [];
		for (const rawItem of args.items) {
			const item = { ...rawItem, relativePath: files_normalize_special_node_path("file", rawItem.relativePath) };
			const segments = path_extract_segments_from(item.relativePath);

			// The splitter drops empty segments, so without this reconstruction check `a//b`, a
			// leading `/`, or a trailing `/` would be silently accepted instead of rejected.
			if (segments.length === 0 || segments.join("/") !== item.relativePath) {
				return Result({
					_nay: { message: "Path must be relative and normalized", data: { path: item.relativePath } },
				});
			}

			for (const segment of segments.slice(0, -1)) {
				const normalizedSegment = files_normalize_name("folder", segment);
				if (normalizedSegment._nay || normalizedSegment._yay !== segment) {
					return Result({
						_nay: { message: "Path contains an invalid folder name", data: { path: item.relativePath } },
					});
				}
			}

			// Use the same leaf split as the single-file flow. A `.md` name keeps the Markdown name
			// rule (README casing), every other name keeps its real extension. Both are name rules
			// only: the stored type below never comes from the name when the caller sent one.
			const leafName = segments[segments.length - 1];
			if (leafName.toLowerCase().endsWith(".md")) {
				const normalizedLeaf = files_normalize_markdown_name(leafName);
				if (normalizedLeaf._nay || normalizedLeaf._yay !== leafName) {
					return Result({
						_nay: { message: "Path ends in an invalid file name", data: { path: item.relativePath } },
					});
				}
			} else if (files_normalize_upload_file_name(leafName) !== leafName) {
				return Result({
					_nay: { message: "Path ends in an invalid file name", data: { path: item.relativePath } },
				});
			}
			const contentType = files_resolve_upload_content_type({ contentType: item.contentType, fileName: leafName });
			if (contentType === null) {
				return Result({
					_nay: { message: files_INVALID_CONTENT_TYPE_MESSAGE, data: { path: item.relativePath } },
				});
			}

			if (!Number.isSafeInteger(item.size) || item.size < 0) {
				return Result({ _nay: { message: "Invalid file size", data: { path: item.relativePath } } });
			}
			if (item.size > files_MAX_UPLOADS_BYTES) {
				return Result({ _nay: { message: "File too large", data: { path: item.relativePath } } });
			}

			const targetPath = path_join(parentPath, item.relativePath);
			if (targetPaths.has(targetPath)) {
				return Result({ _nay: { message: "Duplicate path in batch", data: { path: item.relativePath } } });
			}
			targetPaths.add(targetPath);

			validated.push({
				relativePath: item.relativePath,
				segments,
				targetPath,
				contentType,
				size: item.size,
			});
		}

		const now = Date.now();
		const skipped: Array<{ relativePath: string; reason: "conflict" | "path_blocked" }> = [];
		const runnable: Array<(typeof validated)[number] & { existingNodeId: Id<"files_nodes"> | null }> = [];
		// Share one link cleanup across the replaced files, so the workspace links load only once.
		const shareLinkCleanup = files_share_links_create_cleanup_state();

		// Conflicts with nodes that already exist in the workspace are per-item skips, never call
		// failures. The walk below also asks `content.write` about every folder that already
		// exists on the item's way, before anything is archived: a leaf can be writable while an
		// outer restricted folder is not, and archiving first would keep the archive when the
		// create then refuses (a normal return commits every prior write). The permission refusal
		// reports the same generic "conflict" as a skipped replace, so the response never says
		// which paths are restricted.
		for (const item of validated) {
			let itemSkipReason: "conflict" | "path_blocked" | null = null;
			let walkParentId: Doc<"files_nodes">["parentId"] | null = args.parentId;
			for (const [depth, name] of item.segments.slice(0, -1).entries()) {
				// Another item in this batch wants a file where this item needs a folder.
				const ancestorTargetPath = path_join(parentPath, item.segments.slice(0, depth + 1).join("/"));
				if (targetPaths.has(ancestorTargetPath)) {
					itemSkipReason = "path_blocked";
					break;
				}

				// Once one segment is missing, the deeper ones cannot exist either; only the
				// batch-internal check above still applies below this depth.
				if (walkParentId === null) {
					continue;
				}
				// The annotation breaks a TypeScript inference cycle: the narrowed type of
				// `walkParentId` depends on `intermediate`, whose query depends on this constant.
				const currentWalkParentId: Doc<"files_nodes">["parentId"] = walkParentId;

				const intermediate = await ctx.db
					.query("files_nodes")
					.withIndex("by_organization_workspace_parent_name_archiveOperation", (q) =>
						q
							.eq("organizationId", membership.organizationId)
							.eq("workspaceId", membership.workspaceId)
							.eq("moveCohortId", undefined)
							.eq("parentId", currentWalkParentId)
							.eq("name", name)
							.eq("archiveOperationId", null),
					)
					.first();
				if (!intermediate) {
					walkParentId = null;
					continue;
				}
				// "path_blocked" says a file sits on this path. Report it only when the caller can
				// read that node; otherwise the reason would reveal the kind of a hidden node, which
				// the conflict pre-check and the tree (`list_tree_children`) both hide.
				if (intermediate.kind !== "folder") {
					itemSkipReason = (await access_control_db_can_act_on_file_node(ctx, {
						organizationId: membership.organizationId,
						workspaceId: membership.workspaceId,
						userId: userAuth.id,
						fileNode: intermediate,
						permission: "content.read",
					}))
						? "path_blocked"
						: "conflict";
					break;
				}
				if (
					!(await access_control_db_can_act_on_file_node(ctx, {
						organizationId: membership.organizationId,
						workspaceId: membership.workspaceId,
						userId: userAuth.id,
						fileNode: intermediate,
						permission: "content.write",
					}))
				) {
					itemSkipReason = "conflict";
					break;
				}
				// Report a general conflict. Do not reveal that a hidden folder is read-only.
				if ((await files_nodes_db_require_user_writable(ctx, { node: intermediate, userId: userAuth.id }))._nay) {
					itemSkipReason = "conflict";
					break;
				}
				walkParentId = intermediate._id;
			}
			if (itemSkipReason) {
				skipped.push({ relativePath: item.relativePath, reason: itemSkipReason });
				continue;
			}

			const existingNode = await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", membership.organizationId)
						.eq("workspaceId", membership.workspaceId)
						.eq("moveCohortId", undefined)
						.eq("path", item.targetPath)
						.eq("archiveOperationId", null),
				)
				.first();
			if (existingNode) {
				// Same rule as the walk above: only a readable folder may report "path_blocked",
				// a hidden one must stay indistinguishable from a plain conflict.
				if (existingNode.kind !== "file") {
					const canReadBlockingNode = await access_control_db_can_act_on_file_node(ctx, {
						organizationId: membership.organizationId,
						workspaceId: membership.workspaceId,
						userId: userAuth.id,
						fileNode: existingNode,
						permission: "content.read",
					});
					skipped.push({
						relativePath: item.relativePath,
						reason: canReadBlockingNode ? "path_blocked" : "conflict",
					});
					continue;
				}
				if (args.onConflict === "skip") {
					skipped.push({ relativePath: item.relativePath, reason: "conflict" });
					continue;
				}
				if (
					!(await access_control_db_can_act_on_file_node(ctx, {
						organizationId: membership.organizationId,
						workspaceId: membership.workspaceId,
						userId: userAuth.id,
						fileNode: existingNode,
						permission: "content.write",
					}))
				) {
					skipped.push({ relativePath: item.relativePath, reason: "conflict" });
					continue;
				}
				// If the file being replaced is locked, skip only this item.
				// Keep that file active and continue the other imports.
				if ((await files_nodes_db_require_user_writable(ctx, { node: existingNode, userId: userAuth.id }))._nay) {
					skipped.push({ relativePath: item.relativePath, reason: "conflict" });
					continue;
				}
			}

			runnable.push({ ...item, existingNodeId: existingNode?._id ?? null });
		}

		// Admit only accepted items, before replacing any existing file.
		const admission = await files_stored_uploads_db_admit(ctx, {
			organization,
			actorUserId: userAuth.id,
			workspaceId: membership.workspaceId,
			declaredBytes: runnable.map((item) => item.size),
		});
		if (admission._nay) return admission;

		const created: Array<{
			relativePath: string;
			assetId: Id<"files_r2_assets">;
			nodeId: Id<"files_nodes">;
			url: string;
			headers: Record<string, string>;
		}> = [];
		for (const item of runnable) {
			if (item.existingNodeId) {
				await files_nodes_db_archive_nodes({
					ctx,
					nodeIds: [item.existingNodeId],
					updatedBy: userAuth.id,
					now,
					shareLinkCleanup,
				});
			}
			const assetId = await ctx.db.insert("files_r2_assets", {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				kind: "upload",
				r2Bucket: r2.config.bucket,
				size: item.size,
				createdBy: membership.userId,
				unfinalizedExpiresAt: now + r2_UNFINALIZED_ASSET_TTL_MS,
				updatedAt: now,
			});

			const nodeIdResult = await files_nodes_db_create_node_recursively_at_path(ctx, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: membership.userId,
				parentId: args.parentId,
				path: item.relativePath,
				kind: "file",
				contentType: item.contentType,
				assetId,
				// A folder import also records the path the file had inside the imported folder. Once
				// the import is placed under another parent, the stored path no longer shows it.
				metadata: [
					{ key: "source", value: "upload" },
					{ key: "original-name", value: path_name_of(item.relativePath) },
					{ key: "import-relative-path", value: item.relativePath },
				],
				now,
			});
			// The checks above should make this branch unreachable.
			// Keep it so a future change cannot leave an asset doc without a node.
			// Use "conflict" for permission and read-only errors so hidden paths stay private.
			if (nodeIdResult._nay) {
				await ctx.db.delete("files_r2_assets", assetId);
				skipped.push({
					relativePath: item.relativePath,
					reason:
						nodeIdResult._nay.message === "Permission denied" || nodeIdResult._nay.name === "read_only"
							? "conflict"
							: "path_blocked",
				});
				continue;
			}

			const uploadR2Key = r2_create_asset_key({
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				assetId,
			});

			// Keep the URL end time so cleanup can remove a late PUT.
			// A later lock does not stop this accepted upload.
			await ctx.db.patch("files_r2_assets", assetId, {
				uploadUrlExpiresAt: now + files_UPLOAD_URL_TTL_MS,
			});
			const signedUpload = await r2.generateUploadUrl(uploadR2Key, {
				createOnly: true,
				expiresIn: files_UPLOAD_URL_TTL_MS / 1000,
			});

			created.push({
				relativePath: item.relativePath,
				assetId,
				nodeId: nodeIdResult._yay,
				url: signedUpload.url,
				headers: { ...(item.contentType ? { "Content-Type": item.contentType } : {}), "If-None-Match": "*" },
			});
		}

		return Result({ _yay: { created, skipped } });
	},
});

/**
 * Which of these target paths already hold a node the caller can read. The folder-import
 * confirm modal asks this once before any write.
 *
 * A batch query for one UI is normally avoided, but a pre-check for up to 1,000 paths cannot
 * be 1,000 single queries; `data_import.verify_metadata` is the same shape. Queries cannot
 * charge the rate limiter, so this must never reveal more than the tree (`list_tree_children`)
 * does: a node the caller cannot read is reported as no conflict, and the (rate-limited) import
 * mutation later reports it as a generic skip.
 */
export const get_upload_conflicts = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		parentId: v.union(v.id("files_nodes"), v.literal(files_ROOT_ID)),
		relativePaths: v.array(v.string()),
	},
	returns: v.array(
		v.object({
			relativePath: v.string(),
			kind: doc(app_convex_schema, "files_nodes").fields.kind,
		}),
	),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			throw convex_error({ message: "Unauthenticated" });
		}

		// The import caps mutation calls at this size too; a bigger path list here is a caller
		// bug, and silently answering only part of it would make missing conflicts look like none.
		if (args.relativePaths.length > files_IMPORT_MAX_ITEMS_PER_CALL) {
			throw convex_error({ message: "Too many paths" });
		}

		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return [];
		}

		let parentPath = "/";
		if (args.parentId !== files_ROOT_ID) {
			const parent = await ctx.db.get("files_nodes", args.parentId);
			if (
				!parent ||
				parent.organizationId !== membership.organizationId ||
				parent.workspaceId !== membership.workspaceId ||
				parent.kind !== "folder" ||
				parent.archiveOperationId !== null
			) {
				return [];
			}
			parentPath = parent.path;
		}

		const conflicts = await Promise.all(
			args.relativePaths.map(async (relativePath) => {
				const fileNode = await ctx.db
					.query("files_nodes")
					.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
						q
							.eq("organizationId", membership.organizationId)
							.eq("workspaceId", membership.workspaceId)
							.eq("moveCohortId", undefined)
							.eq("path", path_join(parentPath, relativePath))
							.eq("archiveOperationId", null),
					)
					.first();
				if (!fileNode) {
					return null;
				}

				// Same per-node check as `get_authorized_by_path`: a restricted node the caller
				// cannot read must look exactly like no conflict.
				const authorized = await access_control_db_authorize_membership(ctx, {
					userAuth,
					membership,
					permission: "content.read",
					fileNode,
				});
				if (authorized._nay) {
					return null;
				}

				return { relativePath, kind: fileNode.kind };
			}),
		);

		return conflicts.filter((conflict) => conflict !== null);
	},
});

/**
 * Delete a node whose upload never reached R2, so a failed or cancelled PUT does not leave a
 * permanent "waiting for upload" file in the tree. Only the creator's own unfinalized upload
 * qualifies; when the R2 event already recorded the object (`r2Key` set, or the Markdown
 * finalizer already re-pointed the node), the node stays and `removed: false` tells the
 * client to count the file as imported after all.
 */
export const discard_failed_upload_node = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
	},
	returns: v_result({
		_yay: v.object({ removed: v.boolean() }),
		_nay: { data: v.object({ retryAfterMs: v.optional(v.number()) }) },
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

		// Metered on the import bucket: cleanup after a failed chunk can be dozens of calls and
		// must not starve the shared tree-write bucket the rest of the sidebar runs on.
		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "files_bulk_import", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message, data: { retryAfterMs: rateLimit.retryAfterMs } } });
		}

		const node = await ctx.db.get("files_nodes", args.nodeId);
		if (
			!node ||
			node.organizationId !== membership.organizationId ||
			node.workspaceId !== membership.workspaceId ||
			node.kind !== "file" ||
			node.archiveOperationId !== null
		) {
			return Result({ _nay: { message: "Not found" } });
		}

		// Only the creator may discard: this is cleanup of their own failed upload, not a
		// delete feature, so nobody else's `content.write` grant applies here.
		if (node.createdBy !== userAuth.id) {
			return Result({ _nay: { message: "Permission denied" } });
		}

		if (!node.assetId) {
			return Result({ _yay: { removed: false } });
		}
		const asset = await ctx.db.get("files_r2_assets", node.assetId);
		if (!asset) {
			const errorMessage = "fileNode.assetId points to a missing files_r2_assets doc";
			const errorData = { nodeId: node._id, assetId: node.assetId };
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}

		// `r2Key` set means the R2 event won the race and the upload actually finished; a
		// non-upload asset kind means the Markdown finalizer already made the node editable.
		// Either way the file is real now, so keep it.
		if (asset.kind !== "upload" || asset.r2Key !== undefined) {
			return Result({ _yay: { removed: false } });
		}
		const serviceTarget = await public_api_service_uploads_db_get_target_by_asset(ctx, asset._id);

		// Cancel removes the unfinished upload even if it is locked. A lock stops new
		// writes, not cleanup of an upload that never landed. Landed files return early above.

		const now = Date.now();
		const liveR2Key = r2_create_asset_key({
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			assetId: asset._id,
		});
		await r2_enqueue_object_deletion_job(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			r2Key: liveR2Key,
			reason: "untracked_asset_event",
			putMayArriveUntil: (asset.uploadUrlExpiresAt ?? asset.unfinalizedExpiresAt ?? now) + r2_PUT_MAY_ARRIVE_MARGIN_MS,
		});

		// This member action ends a service upload too. Release its replay state in the same transaction
		// that removes the asset, so a late R2 event can settle any extra stored bytes exactly once.
		if (serviceTarget?.state === "pending" && serviceTarget.assetId === asset._id) {
			await ctx.db.patch("plugin_service_storage_targets", serviceTarget._id, {
				state: "released",
				updatedAt: now,
			});
		}

		// The job owns the exact key before its node and asset docs disappear.
		// If the URL creates the object again, its job will delete it later.
		await files_nodes_db_hard_delete_node(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			nodeId: node._id,
		});

		return Result({ _yay: { removed: true } });
	},
});

/**
 * rename() semantics: only an EMPTY folder can be replaced. Committed active children count
 * as occupancy, and so do the user's own pending moves into the folder (replacing it would
 * break their destinations).
 */
async function db_folder_occupant_is_empty(
	ctx: QueryCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		target: files_PendingTarget;
		userId: Id<"users">;
	},
) {
	const target = args.target;
	const activeChild =
		target.kind === "saved"
			? await ctx.db
					.query("files_nodes")
					.withIndex("by_organization_workspace_parent_archiveOperation_name", (q) =>
						q
							.eq("organizationId", args.organizationId)
							.eq("workspaceId", args.workspaceId)
							.eq("moveCohortId", undefined)
							.eq("parentId", target.id)
							.eq("archiveOperationId", null),
					)
					.first()
			: null;
	if (activeChild) {
		return false;
	}

	const reader = await files_visible_db_create_reader(ctx, args);
	for (const parent of await reader.parentAliases(args.target)) {
		const [privateChild, pendingMove] = await Promise.all([
			ctx.db
				.query("files_pending_nodes")
				.withIndex("by_organization_workspace_user_parent_state_name", (q) =>
					q
						.eq("organizationId", args.organizationId)
						.eq("workspaceId", args.workspaceId)
						.eq("userId", args.userId)
						.eq("parent.kind", parent.kind)
						.eq("parent.id", parent.kind === "root" ? undefined : parent.id)
						.eq("state", "active"),
				)
				.first(),
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_org_ws_user_pendingMove_destParent_destName", (q) =>
					q
						.eq("organizationId", args.organizationId)
						.eq("workspaceId", args.workspaceId)
						.eq("userId", args.userId)
						.eq("pendingMove.destParent.kind", parent.kind)
						.eq("pendingMove.destParent.id", parent.kind === "root" ? undefined : parent.id),
				)
				.first(),
		]);
		if (privateChild || pendingMove) return false;
	}

	return true;
}

/**
 * Validate the visible occupant before a move replaces it. Private occupants are retired only
 * after this check. A saved occupant stays intact until the proposal is saved.
 */
export async function files_nodes_db_validate_occupant_replace(
	ctx: MutationCtx,
	args: {
		membership: Doc<"organizations_workspaces_users">;
		sourceKind: "file" | "folder";
		occupant: files_VisibleEntry;
		replace: boolean;
	},
) {
	const { membership, occupant } = args;
	const scope = {
		organizationId: membership.organizationId,
		workspaceId: membership.workspaceId,
		userId: membership.userId,
	};

	if (
		!args.replace ||
		args.sourceKind !== occupant.node.kind ||
		(occupant.kind === "saved" && occupant.pendingUpdate?.pendingMove)
	)
		return Result({ _nay: { message: "Path already exists" } });

	let replacesNode = occupant.kind === "saved" ? occupant.node : null;
	let replacesContentVersion = replacesNode ? await files_nodes_db_get_content_version(ctx, replacesNode) : null;

	if (occupant.kind === "private") {
		const ready =
			!occupant.pendingUpdate.preparation &&
			occupant.pendingUpdate.createIntent &&
			(occupant.pendingUpdate.createIntent.kind !== "text" || occupant.pendingUpdate.content?.base.kind === "new");
		if (!ready) return Result({ _nay: { name: "preparing", message: "The destination draft is still preparing" } });
		const ancestry = await files_pending_nodes_db_get_ancestry(ctx, { ...scope, privateNodeId: occupant.node._id });
		if (ancestry._nay) return ancestry;

		const allowed = await access_control_db_authorize_membership(ctx, {
			userAuth: { id: membership.userId },
			membership,
			permission: "content.write",
			fileNode: ancestry._yay.savedParent ?? undefined,
		});
		if (allowed._nay) return allowed;
		if (ancestry._yay.savedParent) {
			const writable = await files_nodes_db_require_user_writable(ctx, {
				node: ancestry._yay.savedParent,
				userId: membership.userId,
			});
			if (writable._nay) return writable;
		}

		const claim = occupant.pendingUpdate.pendingMove;
		if (claim?.replacesTarget?.kind === "saved") {
			if (claim.replacesContentVersion === undefined)
				return Result({
					_nay: { name: "destination_changed", message: "The destination changed. Start the move again." },
				});
			replacesNode = await ctx.db.get("files_nodes", claim.replacesTarget.id);
			if (
				!replacesNode ||
				replacesNode.organizationId !== membership.organizationId ||
				replacesNode.workspaceId !== membership.workspaceId ||
				replacesNode.archiveOperationId !== null ||
				replacesNode.parentId !== (ancestry._yay.savedParent?._id ?? files_ROOT_ID) ||
				replacesNode.name !== occupant.node.name ||
				replacesNode.kind !== occupant.node.kind ||
				!files_transfer_source_versions_equal(
					await files_nodes_db_get_content_version(ctx, replacesNode),
					claim.replacesContentVersion,
				)
			)
				return Result({
					_nay: { name: "destination_changed", message: "The destination changed. Start the move again." },
				});
			replacesContentVersion = claim.replacesContentVersion;
		}
	}

	if (
		occupant.node.kind === "folder" &&
		!(await db_folder_occupant_is_empty(ctx, {
			...scope,
			target:
				occupant.kind === "private"
					? { kind: "private", id: occupant.node._id }
					: { kind: "saved", id: occupant.node._id },
		}))
	) {
		return Result({ _nay: { message: "Directory not empty" } });
	}

	if (replacesNode) {
		const allowed = await access_control_db_authorize_membership(ctx, {
			userAuth: { id: membership.userId },
			membership,
			permission: "content.write",
			fileNode: replacesNode,
		});
		if (allowed._nay) return allowed;
		const writable = await files_nodes_db_require_user_writable(ctx, { node: replacesNode, userId: membership.userId });
		if (writable._nay) return writable;

		// This only records a draft. The Save cohort checks archived descendants before publication.
	}

	return Result({ _yay: { replacesEntry: occupant, replacesNode, replacesContentVersion } });
}

/**
 * Proposal-time validation for a pending move, against the proposer's visible tree: a committed
 * sibling with a pending move away does not conflict, and a destination already claimed by
 * another pending move is rejected.
 */
export async function files_nodes_db_validate_pending_move_target_for_proposal(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		nodeId: Id<"files_nodes">;
		destParent: Doc<"files_pending_nodes">["parent"];
		destName: string;
		/**
		 * Replace opt-in: file-onto-file (`mv -f`), or folder-onto-EMPTY-folder (rename()
		 * semantics). `"any-active-occupant"` accepts whichever active node owns the destination;
		 * a node id requires the destination to still be exactly that node.
		 */
		replaceTarget?: Id<"files_nodes"> | "any-active-occupant";
		/** The owner whose pending paths the move uses. */
		userId: Id<"users">;
		membership: Doc<"organizations_workspaces_users">;
	},
) {
	const node = await ctx.db.get("files_nodes", args.nodeId);
	if (
		!node ||
		node.organizationId !== args.organizationId ||
		node.workspaceId !== args.workspaceId ||
		node.archiveOperationId !== null
	) {
		return Result({ _nay: { message: "Not found" } });
	}

	const reader = await files_visible_db_create_reader(ctx, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		userId: args.userId,
		readLimit: 4096,
	});

	let destParentPath = "/";
	let visibleDestParentPath = "/";
	if (args.destParent.kind !== "root") {
		const parent = await reader.resolveTarget(args.destParent);
		if (reader.exhausted) return Result({ _nay: { message: "Move path lookup exceeded its read limit." } });
		if (!parent || parent.node.kind !== "folder") {
			return Result({ _nay: { message: "Destination folder is missing" } });
		}
		destParentPath = parent.kind === "saved" ? parent.node.path : parent.path;
		visibleDestParentPath = parent.path;
	}

	const destPath = path_join(destParentPath, args.destName);
	const visibleDestPath = path_join(visibleDestParentPath, args.destName);
	const visibleNodePath = (await reader.resolveTarget({ kind: "saved", id: node._id }))?.path;
	if (reader.exhausted) return Result({ _nay: { message: "Move path lookup exceeded its read limit." } });
	if (!visibleNodePath) return Result({ _nay: { message: "Not found" } });
	if (visibleDestPath === visibleNodePath) {
		return Result({ _nay: { message: "Source and destination are the same" } });
	}
	if (node.kind === "folder" && visibleDestPath.startsWith(`${visibleNodePath}/`)) {
		return Result({ _nay: { message: "Cannot move a folder into itself" } });
	}

	const occupant = (await reader.findPath(visibleDestPath))?.entry;
	if (reader.exhausted) return Result({ _nay: { message: "Move path lookup exceeded its read limit." } });
	if (occupant && (occupant.kind !== "saved" || occupant.node._id !== node._id)) {
		const checked = await files_nodes_db_validate_occupant_replace(ctx, {
			membership: args.membership,
			sourceKind: node.kind,
			occupant,
			replace:
				args.replaceTarget === "any-active-occupant" ||
				(occupant.kind === "saved" && args.replaceTarget === occupant.node._id),
		});
		if (checked._nay) return checked;
		return Result({ _yay: { node, destParentPath, destPath, ...checked._yay } });
	}

	return Result({
		_yay: { node, destParentPath, destPath, replacesEntry: null, replacesNode: null, replacesContentVersion: null },
	});
}

export const rename_node = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		requestId: v.string(),
		nodeId: v.id("files_nodes"),
		path: v.string(),
	},
	returns: v_result({
		_yay: v.union(v.object({ runId: v.id("files_transfer_runs"), activityId: v.id("activities") }), v.null()),
		_nay: { data: v.any() },
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) return Result({ _nay: { message: "Unauthenticated" } });
		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "files_tree_write", key: userAuth.id });
		if (rateLimit) return Result({ _nay: { message: rateLimit.message } });
		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) return Result({ _nay: { message: "Unauthorized" } });
		return await files_transfer_db_start_rename(ctx, {
			membership,
			requestId: args.requestId,
			nodeId: args.nodeId,
			path: args.path,
		});
	},
});

// #region move nodes

/**
 * A scope op or a move op writes the new scope to the items inside in later steps. Until then an item
 * can store its old scope. While one runs, the returned function gives a node the scope of its
 * parents, so a permission check asks about the scope the node really has.
 */
export async function files_nodes_db_live_scope_reader(
	ctx: QueryCtx | MutationCtx,
	args: Pick<Doc<"organizations_workspaces_users">, "organizationId" | "workspaceId">,
) {
	const findOp = (kind: "scope" | "move") =>
		ctx.db
			.query("files_subtree_ops")
			.withIndex("by_organization_workspace_kind", (q) =>
				q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("kind", kind),
			)
			.first();
	const isScopeStale = (await findOp("scope")) !== null || (await findOp("move")) !== null;
	const scopesInside = new Map<Id<"files_nodes">, Id<"files_nodes"> | null>();
	async function readScopeInside(folderId: Doc<"files_nodes">["parentId"]): Promise<Id<"files_nodes"> | null> {
		if (folderId === files_ROOT_ID) return null;
		let scope = scopesInside.get(folderId);
		if (scope === undefined) {
			const folder = await ctx.db.get("files_nodes", folderId);
			// A restrict or unrestrict writes the folder's own scope in the request, so it is never old.
			scope = !folder
				? null
				: folder.restrictedScopeNodeId === folder._id
					? folder._id
					: await readScopeInside(folder.parentId);
			scopesInside.set(folderId, scope);
		}
		return scope;
	}

	return async function withLiveScope(node: Doc<"files_nodes">) {
		if (!isScopeStale || node.restrictedScopeNodeId === node._id) return node;
		const scope = await readScopeInside(node.parentId);
		return scope === node.restrictedScopeNodeId ? node : { ...node, restrictedScopeNodeId: scope };
	};
}

/**
 * Give a child the path and restricted scope that its live parent implies, with its side docs.
 * A move or restrict job calls this for each child after the parent is right. Returns whether it
 * wrote anything. The caller advances the media validation version once after its writes.
 *
 * It never writes `archiveOperationId`. An archive job may stamp the same child, and a patch keeps
 * the other field.
 */
export async function files_nodes_db_rebuild_node(
	ctx: MutationCtx,
	args: { node: Doc<"files_nodes">; parent: Doc<"files_nodes"> },
) {
	const { node, parent } = args;
	const path = path_join(parent.path, node.name);
	const fields = {
		path,
		treePath: files_derive_tree_path_for_file_node(path, node.kind),
		pathDepth: files_path_depth(path),
		// A child that is its own restricted folder keeps its scope.
		restrictedScopeNodeId: node.restrictedScopeNodeId === node._id ? node._id : parent.restrictedScopeNodeId,
	};
	if (
		node.path === fields.path &&
		node.treePath === fields.treePath &&
		node.pathDepth === fields.pathDepth &&
		node.restrictedScopeNodeId === fields.restrictedScopeNodeId
	) {
		return false;
	}

	// A new scope ends the public link. Rename keeps links. Move cohorts remove reparented links
	// before publication. Scope repair also uses this helper.
	if (node.restrictedScopeNodeId !== fields.restrictedScopeNodeId) {
		await files_share_links_db_delete_for_node(ctx, {
			organizationId: node.organizationId,
			workspaceId: node.workspaceId,
			nodeId: node._id,
		});
	}

	await ctx.db.patch("files_nodes", node._id, fields);
	if (node.path !== path) {
		await db_patch_node_search_scope(ctx, {
			organizationId: node.organizationId,
			workspaceId: node.workspaceId,
			nodeId: node._id,
			kind: node.kind,
			path,
		});
	}
	return true;
}

// #endregion move nodes

// #region archive nodes
/**
 * Archive one node and its side docs under `archiveOperationId`, in the same mutation.
 * The caller advances the media validation version once after its writes.
 *
 * It also deletes the node's own public link. A folder's links below it are the caller's job, because
 * this archives only the one node.
 */
export async function files_nodes_db_archive_node(
	ctx: MutationCtx,
	args: {
		node: Doc<"files_nodes">;
		archiveOperationId: string;
		updatedBy: Id<"users">;
		now: number;
	},
) {
	await files_share_links_db_delete_for_node(ctx, {
		organizationId: args.node.organizationId,
		workspaceId: args.node.workspaceId,
		nodeId: args.node._id,
	});
	await ctx.db.patch("files_nodes", args.node._id, {
		archiveOperationId: args.archiveOperationId,
		updatedBy: args.updatedBy,
		updatedAt: args.now,
	});
	await db_patch_node_search_scope(ctx, {
		organizationId: args.node.organizationId,
		workspaceId: args.node.workspaceId,
		nodeId: args.node._id,
		kind: args.node.kind,
		archiveOperationId: args.archiveOperationId,
	});
	await files_updated_by_db_sync_node(ctx, { nodeId: args.node._id });
}

/**
 * Restore one archived node under `parent`, which is active, or under the workspace root when it is
 * null. The node and its side docs change in the same mutation. The node takes the parent's
 * restricted scope unless it is its own scope root, like a move. The caller advances the media
 * validation version once after its writes.
 *
 * Items inside keep their old path here. The restore job walks the folder and gives them the new
 * path and scope.
 */
export async function files_nodes_db_restore_node(
	ctx: MutationCtx,
	args: {
		node: Doc<"files_nodes">;
		parent: Doc<"files_nodes"> | null;
		name: string;
		updatedBy: Id<"users">;
		now: number;
	},
) {
	const parentId = args.parent?._id ?? files_ROOT_ID;
	const path = path_join(args.parent?.path ?? "/", args.name);
	const restrictedScopeNodeId =
		args.node.restrictedScopeNodeId === args.node._id ? args.node._id : (args.parent?.restrictedScopeNodeId ?? null);

	// A restored file comes back without a public link. Turning it on again makes a new token.
	await files_share_links_db_delete_for_node(ctx, {
		organizationId: args.node.organizationId,
		workspaceId: args.node.workspaceId,
		nodeId: args.node._id,
	});
	await ctx.db.patch("files_nodes", args.node._id, {
		archiveOperationId: null,
		parentId,
		name: args.name,
		sortName: files_sort_text_key(args.name),
		path,
		treePath: files_derive_tree_path_for_file_node(path, args.node.kind),
		pathDepth: files_path_depth(path),
		lowercaseExtension: files_lowercase_extension(path, args.node.kind),
		restrictedScopeNodeId,
		updatedBy: args.updatedBy,
		updatedAt: args.now,
	});
	await db_patch_node_search_scope(ctx, {
		organizationId: args.node.organizationId,
		workspaceId: args.node.workspaceId,
		nodeId: args.node._id,
		kind: args.node.kind,
		path,
		archiveOperationId: undefined,
		parentId,
		...(args.name !== args.node.name ? { name: args.name } : {}),
	});
	await files_updated_by_db_sync_node(ctx, { nodeId: args.node._id });
}

export async function files_nodes_db_archive_nodes(args: {
	ctx: MutationCtx;
	nodeIds: Array<Id<"files_nodes">>;
	updatedBy: Id<"users">;
	now: number;
	shareLinkCleanup: files_share_links_CleanupState;
}) {
	const { ctx, shareLinkCleanup } = args;

	const archiveOperationId = crypto.randomUUID();
	const fileNodes = (await Promise.all(args.nodeIds.map((nodeId) => ctx.db.get("files_nodes", nodeId)))).filter(
		(fileNode) => fileNode !== null,
	);
	const archivedWorkspaces = new Map<Doc<"files_nodes">["workspaceId"], Doc<"files_nodes">["organizationId"]>();
	for (const fileNode of fileNodes) {
		archivedWorkspaces.set(fileNode.workspaceId, fileNode.organizationId);
	}

	// Archive stamps only the named nodes. Delete the public links below them too, once per workspace.
	for (const [workspaceId, organizationId] of archivedWorkspaces) {
		await files_share_links_db_delete_for_roots({
			ctx,
			organizationId,
			workspaceId,
			rootNodeIds: fileNodes.filter((fileNode) => fileNode.workspaceId === workspaceId).map((fileNode) => fileNode._id),
			state: shareLinkCleanup,
		});
	}

	await Promise.all(
		fileNodes.map((fileNode) =>
			files_nodes_db_archive_node(ctx, {
				node: fileNode,
				archiveOperationId,
				updatedBy: args.updatedBy,
				now: args.now,
			}),
		),
	);

	// Advance each workspace once, after its parallel Archive writes finish.
	for (const [workspaceId, organizationId] of archivedWorkspaces)
		await files_media_validation_db_advance_version(ctx, { organizationId, workspaceId });
}

/**
 * The most items one Archive or Restore call may name.
 */
const MAX_ARCHIVE_NAMED_NODES = 500;

export const archive_nodes = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeIds: v.array(v.string()),
	},
	returns: v_result({
		_yay: v.union(
			v.null(),
			v.object({
				runId: v.id("files_archive_runs"),
				activityId: v.id("activities"),
				/**
				 * True when the job ended inside the request. The job is kept only to list what was not
				 * archived.
				 */
				isDone: v.boolean(),
				/**
				 * The named ids that were not found, and the named ids the job refused so far with the named ids
				 * inside them. The refused ones stay active.
				 */
				notArchivedNodeIds: v.array(v.id("files_nodes")),
			}),
		),
		_nay: { data: v.any() },
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

		if (args.nodeIds.length > MAX_ARCHIVE_NAMED_NODES) {
			return Result({ _nay: { message: `Archive at most ${MAX_ARCHIVE_NAMED_NODES} items at once.` } });
		}

		const nodeIds = [];
		for (const maybeNodeId of args.nodeIds) {
			const nodeId = ctx.db.normalizeId("files_nodes", maybeNodeId);
			if (!nodeId) {
				return Result({ _nay: { name: "nay", message: "Not found", data: { nodeId: maybeNodeId } } });
			}
			nodeIds.push(nodeId);
		}

		// Like `rm` with several files, a named item that is missing is "Not found" for that item alone.
		// The job lists it and archives the others.
		const notFoundNodeIds = new Set<Id<"files_nodes">>();
		const fileNodes: Doc<"files_nodes">[] = [];
		const loadedNodes = await Promise.all(nodeIds.map((nodeId) => ctx.db.get("files_nodes", nodeId)));
		// Per node, not per workspace, because a grant on one restricted folder has to be enough to
		// archive what is inside it. This loop only turns a node the person cannot read into "Not found".
		// A node they can read but not change goes on to the job, which refuses it and archives the other
		// named items. The write check costs no extra read for an unrestricted tree, and the read check
		// runs only when the write check fails.
		let hasWorkspaceRead: boolean | undefined;
		for (const [index, fileNode] of loadedNodes.entries()) {
			if (
				!fileNode ||
				fileNode.organizationId !== membership.organizationId ||
				fileNode.workspaceId !== membership.workspaceId
			) {
				notFoundNodeIds.add(nodeIds[index]!);
				continue;
			}

			const authorized = await access_control_db_authorize_membership(ctx, {
				userAuth,
				membership,
				permission: "content.write",
				fileNode,
			});
			if (authorized._nay) {
				// Somebody who cannot even see this node hears the same answer as somebody who named an id
				// that is not there. Two different refusals would confirm the file exists. A member with only
				// folder grants has no workspace read, so an open node is hidden from them too.
				hasWorkspaceRead ??= !(
					await access_control_db_authorize_membership(ctx, { userAuth, membership, permission: "content.read" })
				)._nay;
				const [readable] = await access_control_db_filter_readable_file_nodes(ctx, {
					organizationId: membership.organizationId,
					workspaceId: membership.workspaceId,
					userId: userAuth.id,
					nodes: [fileNode],
					hasWorkspaceRead,
				});
				if (!readable) {
					notFoundNodeIds.add(fileNode._id);
					continue;
				}
			}
			fileNodes.push(fileNode);
		}

		// Drop an item that is already archived, like `rm -f` drops a missing file. Also drop an item that
		// sits inside another named folder. The folder's walk archives it, so the job does not count it twice.
		const activeFileNodes = [
			...new Map(fileNodes.filter((node) => node.archiveOperationId === null).map((node) => [node._id, node])).values(),
		];
		const rootFileNodes = activeFileNodes.filter(
			(node) =>
				!activeFileNodes.some(
					(other) => other.kind === "folder" && other._id !== node._id && node.treePath.startsWith(other.treePath),
				),
		);
		if (rootFileNodes.length === 0) {
			const [notFoundNodeId] = notFoundNodeIds;
			return notFoundNodeId
				? Result({ _nay: { name: "nay", message: "Not found", data: { nodeId: notFoundNodeId } } })
				: Result({ _yay: null });
		}

		// The job checks every node inside before it archives anything, then archives in steps.
		const started = await files_archive_runs_db_start(ctx, {
			kind: "archive",
			userAuth,
			membership,
			archiveOperationId: crypto.randomUUID(),
			rootNodeIds: rootFileNodes.map((node) => node._id),
			notFoundNodeIds: [...notFoundNodeIds],
			treePaths: rootFileNodes.map((node) => node.treePath),
			pendingUpdateCleanup: null,
			budget: { nodes: files_archive_runs_STEP_MAX_NODES, hasPaginated: false },
			previousRunId: null,
			shareLinkCleanup: files_share_links_create_cleanup_state(),
		});
		if (started._nay || !started._yay) return started;

		// A named item inside a refused folder stays active with that folder, so report it too.
		const job = started._yay;
		const refusedFolders = rootFileNodes.filter(
			(node) => node.kind === "folder" && job.notArchivedNodeIds.includes(node._id),
		);
		const notArchivedNodeIds = [
			...notFoundNodeIds,
			...activeFileNodes
				.filter(
					(node) =>
						job.notArchivedNodeIds.includes(node._id) ||
						refusedFolders.some((folder) => node.treePath.startsWith(folder.treePath)),
				)
				.map((node) => node._id),
		];
		return Result({ _yay: { ...job, notArchivedNodeIds } });
	},
});

export const unarchive_nodes = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeIds: v.array(v.string()),
	},
	returns: v_result({
		_yay: v.union(v.null(), v.object({ runId: v.id("files_archive_runs"), activityId: v.id("activities") })),
		_nay: { data: v.any() },
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

		if (args.nodeIds.length === 0) {
			return Result({ _yay: null });
		}

		if (args.nodeIds.length > MAX_ARCHIVE_NAMED_NODES) {
			return Result({ _nay: { message: `Restore at most ${MAX_ARCHIVE_NAMED_NODES} items at once.` } });
		}

		const nodeIds = [];
		for (const maybeNodeId of args.nodeIds) {
			const nodeId = ctx.db.normalizeId("files_nodes", maybeNodeId);
			if (!nodeId) {
				return Result({ _nay: { name: "nay", message: "Not found", data: { nodeId: maybeNodeId } } });
			}
			nodeIds.push(nodeId);
		}

		const fileNodes = Result_all(
			await Promise.all(
				nodeIds.map((nodeId) =>
					ctx.db.get("files_nodes", nodeId).then((fileNode) => {
						if (
							!fileNode ||
							fileNode.organizationId !== membership.organizationId ||
							fileNode.workspaceId !== membership.workspaceId
						) {
							return Result({ _nay: { name: "nay", message: "Not found", data: { nodeId } } });
						}
						return Result({ _yay: fileNode });
					}),
				),
			),
		);

		if (fileNodes._nay) {
			return fileNodes;
		}

		// Per node, like `archive_nodes`. An archived node keeps the restricted scope it had, so
		// restoring something out of a restricted folder still asks that folder for permission.
		for (const fileNode of fileNodes._yay) {
			const authorized = await access_control_db_authorize_membership(ctx, {
				userAuth,
				membership,
				permission: "content.write",
				fileNode,
			});
			if (authorized._nay) {
				// Same as `archive_nodes`: a node the caller cannot see answers "Not found", so the refusal
				// does not tell them it is in the archive.
				const [readable] = await access_control_db_filter_readable_file_nodes(ctx, {
					organizationId: membership.organizationId,
					workspaceId: membership.workspaceId,
					userId: userAuth.id,
					nodes: [fileNode],
				});
				return readable
					? authorized
					: Result({ _nay: { name: "nay", message: "Not found", data: { nodeId: fileNode._id } } });
			}
		}

		// Restore brings back every item archived together with a named item. Take the operations
		// parents first, so a later operation can land in a folder an earlier one restored. Order them by
		// each operation's top item, not by the named item, which can sit deep inside its operation. The
		// operations share one budget, so the first ones run inside this request. After the first job, each
		// job waits for the job before it, so their steps do not write the same docs at the same time.
		const topTreePathByOperationId = new Map<string, string>();
		for (const fileNode of fileNodes._yay) {
			const archiveOperationId = fileNode.archiveOperationId;
			if (archiveOperationId === null || topTreePathByOperationId.has(archiveOperationId)) continue;
			const topNode = await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_archiveOperation_treePath", (q) =>
					q
						.eq("organizationId", membership.organizationId)
						.eq("workspaceId", membership.workspaceId)
						.eq("moveCohortId", undefined)
						.eq("archiveOperationId", archiveOperationId),
				)
				.first();
			// The query always finds at least `fileNode`. The fallback only satisfies the type.
			topTreePathByOperationId.set(archiveOperationId, (topNode ?? fileNode).treePath);
		}

		const budget = { nodes: files_archive_runs_STEP_MAX_NODES, hasPaginated: false };
		const shareLinkCleanup = files_share_links_create_cleanup_state();
		let firstJob = null;
		let previousJob = null;
		for (const [archiveOperationId, topTreePath] of [...topTreePathByOperationId].toSorted((a, b) =>
			a[1] < b[1] ? -1 : 1,
		)) {
			// A refusal here keeps the operations restored before it. Each operation is one unit.
			const started = await files_archive_runs_db_start(ctx, {
				kind: "restore",
				userAuth,
				membership,
				archiveOperationId,
				rootNodeIds: [],
				notFoundNodeIds: [],
				treePaths: [topTreePath],
				pendingUpdateCleanup: null,
				budget,
				previousRunId: previousJob?.runId ?? null,
				shareLinkCleanup,
			});
			if (started._nay) {
				return started;
			}
			firstJob ??= started._yay;
			previousJob = started._yay ?? previousJob;
		}

		// A restore never leaves out one named item. One refusal ends the whole restore, so the caller
		// needs only the job.
		return Result({ _yay: firstJob && { runId: firstJob.runId, activityId: firstJob.activityId } });
	},
});
// #endregion archive nodes

/**
 * Fields for a node returned by public queries.
 *
 * Raw policy fields stay private. They are write authority, and a writer choice names accounts
 * the reader may not see. Return the actor's write access and only the local rule kind.
 */
const files_node_public_doc_fields = {
	organizationId: doc(app_convex_schema, "files_nodes").fields.organizationId,
	workspaceId: doc(app_convex_schema, "files_nodes").fields.workspaceId,
	publishedFromPrivateNodeId: doc(app_convex_schema, "files_nodes").fields.publishedFromPrivateNodeId,
	parentId: doc(app_convex_schema, "files_nodes").fields.parentId,
	kind: doc(app_convex_schema, "files_nodes").fields.kind,
	name: doc(app_convex_schema, "files_nodes").fields.name,
	path: doc(app_convex_schema, "files_nodes").fields.path,
	treePath: doc(app_convex_schema, "files_nodes").fields.treePath,
	pathDepth: doc(app_convex_schema, "files_nodes").fields.pathDepth,
	lowercaseExtension: doc(app_convex_schema, "files_nodes").fields.lowercaseExtension,
	contentType: doc(app_convex_schema, "files_nodes").fields.contentType,
	assetId: doc(app_convex_schema, "files_nodes").fields.assetId,
	contentByteSize: doc(app_convex_schema, "files_nodes").fields.contentByteSize,
	textKind: doc(app_convex_schema, "files_nodes").fields.textKind,
	collaborationEnabled: doc(app_convex_schema, "files_nodes").fields.collaborationEnabled,
	yjsSnapshotId: doc(app_convex_schema, "files_nodes").fields.yjsSnapshotId,
	yjsLastSequenceId: doc(app_convex_schema, "files_nodes").fields.yjsLastSequenceId,
	statsId: doc(app_convex_schema, "files_nodes").fields.statsId,
	contentTooLargeByteSize: doc(app_convex_schema, "files_nodes").fields.contentTooLargeByteSize,
	contentShapeMismatchAt: doc(app_convex_schema, "files_nodes").fields.contentShapeMismatchAt,
	contentYjsStateTooLargeByteSize: doc(app_convex_schema, "files_nodes").fields.contentYjsStateTooLargeByteSize,
	contentFrontmatterTooLargeFieldCount: doc(app_convex_schema, "files_nodes").fields
		.contentFrontmatterTooLargeFieldCount,
	contentFrontmatterTooLargeIndexDocumentCount: doc(app_convex_schema, "files_nodes").fields
		.contentFrontmatterTooLargeIndexDocumentCount,
	restrictedScopeNodeId: doc(app_convex_schema, "files_nodes").fields.restrictedScopeNodeId,
	// Leave writePolicy and newChildWritePolicy out. They name accounts a reader may not see.
	// Leave sortName, isRestrictedScopeRoot, contentTypeEssence, contentTypeFamily and ancestor1..12 out too.
	// Only the server indexes read them.
	archiveOperationId: doc(app_convex_schema, "files_nodes").fields.archiveOperationId,
	createdBy: doc(app_convex_schema, "files_nodes").fields.createdBy,
	updatedBy: doc(app_convex_schema, "files_nodes").fields.updatedBy,
	updatedAt: doc(app_convex_schema, "files_nodes").fields.updatedAt,
	_id: doc(app_convex_schema, "files_nodes").fields._id,
	_creationTime: doc(app_convex_schema, "files_nodes").fields._creationTime,
	canWrite: v.boolean(),
	writeBlockedReason: v.union(v.null(), v.literal("permission"), v.literal("read_only")),
	writePolicyState: v.union(v.literal("none"), v.literal("read_only"), v.literal("writer")),
};

/**
 * Build the public write access fields for one node.
 * The state names the node's own rule only. A parent lock never marks a child.
 */
function get_public_node_fields(fileNode: Doc<"files_nodes">, writeBlockedReason: "permission" | "read_only" | null) {
	const {
		writePolicy,
		newChildWritePolicy: _newChildWritePolicy,
		sortName: _sortName,
		isRestrictedScopeRoot: _isRestrictedScopeRoot,
		moveCohortId: _moveCohortId,
		contentTypeEssence: _contentTypeEssence,
		contentTypeFamily: _contentTypeFamily,
		...fields
	} = fileNode;
	// Leave `ancestor1..12` out too. Only the name search index reads them.
	const rest = Object.fromEntries(
		Object.entries(fields).filter(([field]) => !files_is_ancestor_field(field)),
	) as typeof fields;

	// Keep these values as exact literals so they match the return validator.
	const writePolicyState =
		writePolicy === null
			? ("none" as const)
			: writePolicy.mode === "read_only"
				? ("read_only" as const)
				: ("writer" as const);

	return {
		...rest,
		canWrite: writeBlockedReason === null,
		writeBlockedReason,
		writePolicyState,
	};
}

export const get_file_node_for_membership = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		fileNodeId: v.string(),
	},
	returns: v.union(v.object(files_node_public_doc_fields), v.null()),
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

		const fileNodeId = ctx.db.normalizeId("files_nodes", args.fileNodeId);
		if (!fileNodeId) {
			return null;
		}

		const fileNode = await files_saved_placement_db_get_node(ctx.db, fileNodeId);
		if (!fileNode) {
			return null;
		}

		// The permission is checked against the node, not the workspace, so a file inside a restricted
		// folder is refused here even for somebody the workspace lets read everything else.
		const authorized = await access_control_db_authorize_membership(ctx, {
			userAuth,
			membership,
			permission: "content.read",
			fileNode,
		});
		if (authorized._nay) {
			return null;
		}

		// Return the lock source only when this member can read it.
		// Keep hidden folder ids and paths private.
		const canWriteContent = await access_control_db_authorize_membership(ctx, {
			userAuth,
			membership,
			permission: "content.write",
			fileNode,
		});
		const writable = await files_nodes_db_require_user_writable(ctx, { node: fileNode, userId: userAuth.id });
		return get_public_node_fields(fileNode, canWriteContent._nay ? "permission" : writable._nay ? "read_only" : null);
	},
});

export const get_authorized_by_path = query({
	args: { membershipId: v.id("organizations_workspaces_users"), path: v.string() },
	returns: v.union(
		v.object({
			nodeId: v.id("files_nodes"),
			name: v.string(),
			kind: doc(app_convex_schema, "files_nodes").fields.kind,
			assetId: doc(app_convex_schema, "files_nodes").fields.assetId,
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

		const fileNode = await files_db_get_visible_node_by_path(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			path: args.path,
		});

		if (!fileNode) {
			return null;
		}

		// A link that uses a path opens the same nodes as a link that uses `?nodeId=`, so it gets the
		// same check on the node. Otherwise a shared path URL would give out a node id that
		// `get_file_node_for_membership` would then refuse to open.
		const authorized = await access_control_db_authorize_membership(ctx, {
			userAuth,
			membership,
			permission: "content.read",
			fileNode,
		});
		if (authorized._nay) {
			return null;
		}

		return {
			nodeId: fileNode._id,
			name: fileNode.name,
			kind: fileNode.kind,
			assetId: fileNode.assetId,
		};
	},
});

// #region list

/**
 * Resolve the member who reads the Files tree, or `null` when they may read nothing.
 *
 * A failed workspace read check does not always end the read. Somebody whose role gives no
 * workspace-wide read can still have been given one folder, and showing them that folder is the
 * whole point of sharing. Only "Permission denied" means this grant-only mode. Other permission
 * refusals return `null`. Missing current-user auth throws before membership is read.
 *
 * The public link list uses it too, so it answers the same members as the tree.
 */
export async function files_nodes_db_get_tree_reader(
	ctx: QueryCtx,
	args: { membershipId: Id<"organizations_workspaces_users"> },
) {
	const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
	const user = userAuth ? await ctx.db.get("users", userAuth.id) : null;
	if (!userAuth || !user || (userAuth.kind === "anonymous" && user.deletedAt !== undefined)) {
		throw convex_error({ message: "Unauthenticated" });
	}
	const membership = await ctx.db.get("organizations_workspaces_users", args.membershipId);
	if (!membership || membership.userId !== userAuth.id || membership.active === false) {
		return null;
	}

	const authorized = await access_control_db_authorize_membership(ctx, {
		userAuth,
		membership,
		permission: "content.read",
	});
	if (authorized._nay && authorized._nay.message !== "Permission denied") {
		return null;
	}

	// "Permission denied" does not return the organization, so load it here. The check above already
	// refused an organization without a default workspace; the guard only narrows the type.
	const organization = await ctx.db.get("organizations", membership.organizationId);
	if (!organization?.defaultWorkspaceId) {
		return null;
	}

	return {
		userAuth,
		membership,
		defaultWorkspaceId: organization.defaultWorkspaceId,
		isOwner: organization.ownerUserId === userAuth.id,
		hasWorkspaceRead: !authorized._nay,
	};
}

export const get_workspace_move_view = query({
	args: { membershipId: v.id("organizations_workspaces_users") },
	returns: v.union(
		v.null(),
		v.object({
			cohortId: v.union(v.id("files_move_cohorts"), v.null()),
			view: v.union(v.literal("before"), v.literal("after"), v.null()),
			generation: v.number(),
			searchGeneration: v.number(),
		}),
	),
	handler: async (ctx, args) => {
		const reader = await files_nodes_db_get_tree_reader(ctx, args);
		if (!reader) return null;
		const { cohortId, view, generation, searchGeneration } = await files_saved_placement_db_get_view(
			ctx.db,
			reader.membership,
		);
		return { cohortId, view, generation, searchGeneration };
	},
});

/**
 * Load one node of the reader's workspace, or `null` when it is missing, in another workspace, or
 * hidden from the reader. All three cases give the same answer, so a caller cannot learn that a
 * hidden node exists.
 *
 * It does not use `files_metadata_db_get_table_node`: it keeps archived nodes, and it checks access
 * with the tree's list filter, so an open node costs no extra read, like the tree pages.
 */
async function db_get_readable_tree_node(
	ctx: QueryCtx,
	args: {
		reader: {
			userAuth: { id: Id<"users"> };
			membership: Doc<"organizations_workspaces_users">;
			hasWorkspaceRead: boolean;
		};
		nodeId: Id<"files_nodes">;
	},
) {
	const fileNode = await files_saved_placement_db_get_node(ctx.db, args.nodeId);
	if (
		!fileNode ||
		fileNode.organizationId !== args.reader.membership.organizationId ||
		fileNode.workspaceId !== args.reader.membership.workspaceId
	) {
		return null;
	}

	const readable = await access_control_db_filter_readable_file_nodes(ctx, {
		organizationId: args.reader.membership.organizationId,
		workspaceId: args.reader.membership.workspaceId,
		userId: args.reader.userAuth.id,
		nodes: [fileNode],
		hasWorkspaceRead: args.reader.hasWorkspaceRead,
	});
	return readable.length > 0 ? fileNode : null;
}

/**
 * Build the public tree rows for nodes the caller may read.
 * Filter the nodes with `access_control_db_filter_readable_file_nodes` first.
 */
async function db_get_tree_rows(
	ctx: QueryCtx,
	args: {
		userAuth: { id: Id<"users"> };
		membership: Doc<"organizations_workspaces_users">;
		fileNodes: Doc<"files_nodes">[];
		canWriteContentByScope?: Map<Id<"files_nodes"> | null, Promise<boolean>>;
	},
) {
	const canWriteContentByScope = args.canWriteContentByScope ?? new Map<Id<"files_nodes"> | null, Promise<boolean>>();
	return await Promise.all(
		args.fileNodes.map(async (fileNode) => {
			if (fileNode.createdBy === users_SYSTEM_AUTHOR || fileNode.updatedBy === users_SYSTEM_AUTHOR) {
				const errorMessage = "Reserved SYSTEM author reached visible file tree";
				const errorData = {
					fileNodeId: fileNode._id,
					createdBy: fileNode.createdBy,
					updatedBy: fileNode.updatedBy,
				};
				console.error(errorMessage, errorData);
				throw should_never_happen(errorMessage, errorData);
			}

			let canWriteContent = canWriteContentByScope.get(fileNode.restrictedScopeNodeId);
			if (!canWriteContent) {
				canWriteContent = access_control_db_authorize_membership(ctx, {
					userAuth: args.userAuth,
					membership: args.membership,
					permission: "content.write",
					fileNode,
				}).then((result) => !result._nay);
				canWriteContentByScope.set(fileNode.restrictedScopeNodeId, canWriteContent);
			}

			// Each node's rule is local, so each row needs its own answer. The check reads
			// only the node doc in hand, so no cache key helps here.
			const policyWritable = await files_nodes_db_require_user_writable(ctx, {
				node: fileNode,
				userId: args.userAuth.id,
			});

			const writeBlockedReason = !(await canWriteContent) ? "permission" : !policyWritable._nay ? null : "read_only";

			return {
				...get_public_node_fields(fileNode, writeBlockedReason),
				organizationId: args.membership.organizationId,
				workspaceId: args.membership.workspaceId,
				createdBy: fileNode.createdBy,
				updatedBy: fileNode.updatedBy,
			};
		}),
	);
}

/**
 * Whether a page must be split before its per-row reads. A page with more rows than its guard, or a
 * page the server already marked, returns no rows and asks the client to split it
 * (`tree_page_split_required`). Check it before any other read: a reactive rerun has no row cap, so
 * a page can grow far past `numItems`. Only a page with a `splitCursor` can be split, so a page
 * without one is read as it is. Convex sends `SplitRequired` with a `splitCursor`.
 * Each guard is floor(3,000 index ranges / index ranges read by the worst row) or lower.
 */
function tree_page_needs_split(result: PaginationResult<unknown>, guard: number) {
	return !!result.splitCursor && (result.page.length > guard || !!result.pageStatus);
}

function tree_page_split_required(result: PaginationResult<unknown>) {
	return {
		page: [],
		isDone: result.isDone,
		continueCursor: result.continueCursor,
		splitCursor: result.splitCursor,
		pageStatus: "SplitRequired" as const,
	};
}

/**
 * Fail loudly when a stream row is not what its index range promised. The open streams check no
 * row's access, so a row of another workspace, or a row whose copied scope fields are out of step
 * with the node, must never show.
 */
function check_tree_stream_row(
	node: Doc<"files_nodes">,
	args: {
		membership: Doc<"organizations_workspaces_users">;
		parentId: Doc<"files_nodes">["parentId"];
		archived: boolean;
		restricted: boolean;
	},
) {
	if (
		node.organizationId !== args.membership.organizationId ||
		node.workspaceId !== args.membership.workspaceId ||
		node.parentId !== args.parentId ||
		(node.archiveOperationId !== null) !== args.archived ||
		node.isRestrictedScopeRoot !== args.restricted ||
		(node.restrictedScopeNodeId === node._id) !== args.restricted
	) {
		const errorMessage = "files_nodes tree stream row scope is mismatched";
		const errorData = { nodeId: node._id, parentId: args.parentId };
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}
}

/**
 * Check the sort, filter, name prefix and segment of one folder table stream, and say how to read
 * it. Returns null when the stream has no rows: an invalid sort, or a `missing` segment that this
 * order does not have. Throws on an invalid filter or page limit.
 */
function get_table_read_args(args: {
	kind: Doc<"files_nodes">["kind"];
	sort: Infer<typeof files_sort_validator>;
	filter: Infer<typeof files_table_filter_validator> | null;
	namePrefix: string | null;
	segment: "value" | "missing";
	paginationOpts: { numItems: number };
}) {
	if (!files_sort_is_valid(args.sort)) {
		return null;
	}
	const sort = args.sort[0]!;
	const filter = args.filter;
	if (
		!Number.isInteger(args.paginationOpts.numItems) ||
		args.paginationOpts.numItems < 1 ||
		(filter !== null &&
			(!files_table_filter_is_valid(filter) || sort.field !== files_table_filter_order_field(filter))) ||
		(args.namePrefix !== null &&
			(filter === null ||
				!files_table_filter_takes_name_prefix(filter) ||
				!files_table_filter_is_valid({ kind: "name", field: "name", op: "starts_with", value: args.namePrefix })))
	)
		throw convex_error({ message: "Invalid table filter or page limit." });

	// Only an extension or size sort with no filter keeps the rows with no value in a `missing`
	// segment. Folders have no size, so the size sort reads them by name in the `value` segment. A
	// metadata sort hides the rows with no value.
	if (
		args.segment === "missing" &&
		(filter !== null ||
			(sort.field !== "extension" && sort.field !== "size") ||
			(sort.field === "size" && args.kind === "folder"))
	) {
		return null;
	}

	// `name starts with` is one range on the stored name key. The upper bound is null only for an
	// empty key (a prefix of only accent marks), and that prefix matches every name.
	const namePrefixText = filter?.kind === "name" ? filter.value : args.namePrefix;
	const namePrefixStart = namePrefixText === null ? null : files_sort_text_key(namePrefixText);
	const namePrefix =
		namePrefixStart === null ? null : { start: namePrefixStart, end: string_prefix_upper_bound(namePrefixStart) };

	return { sort, filter, namePrefix, metadataField: files_table_metadata_field({ sort, filter }) };
}

/**
 * The `principalKey`s of the share rows a member reads, by `principalIndex`: 0 is the member, 1 and
 * 2 are their workspace role and organization role (`access_control_db_resolve_role_refs`). A role
 * they do not have has no key.
 */
async function db_get_share_principal_keys(
	ctx: QueryCtx,
	reader: {
		userAuth: { id: Id<"users"> };
		membership: Doc<"organizations_workspaces_users">;
		defaultWorkspaceId: Id<"organizations_workspaces">;
	},
) {
	const roleRefs = await access_control_db_resolve_role_refs(ctx, {
		organizationId: reader.membership.organizationId,
		workspaceId: reader.membership.workspaceId,
		defaultWorkspaceId: reader.defaultWorkspaceId,
		userId: reader.userAuth.id,
	});
	return [
		files_share_rows_principal_key("user", reader.userAuth.id),
		...roleRefs.map((role) => files_share_rows_principal_key("role", role)),
	];
}

/**
 * The tree rows of one page of share rows. A share row is a copy, so each row keeps a full access
 * check: its node must be a restricted root of the reader's workspace and readable by the reader.
 * Its copied fields must match the node, so the node is still where the index range read it: under
 * the read's folder, and active or archived, as the read asks. A row of a plugin grant must also
 * carry the member's live membership lifetime: after a re-invite the old grant reads nothing, even
 * while another grant keeps the node readable. Rows that fail are dropped, so a page can be short.
 */
async function db_get_share_tree_rows(
	ctx: QueryCtx,
	args: {
		reader: {
			userAuth: { id: Id<"users"> };
			membership: Doc<"organizations_workspaces_users">;
			hasWorkspaceRead: boolean;
		};
		shareRows: Doc<"files_share_rows">[];
	},
) {
	const { userAuth, membership, hasWorkspaceRead } = args.reader;
	const liveLifetime = args.shareRows.some((shareRow) => shareRow.externalPluginMembershipLifetime !== null)
		? await organizations_membership_lifetimes_db_get(ctx, { workspaceId: membership.workspaceId, userId: userAuth.id })
		: null;

	const pairs = (
		await Promise.all(
			args.shareRows.map(async (shareRow) => ({
				shareRow,
				node: await files_saved_placement_db_get_node(ctx.db, shareRow.nodeId, shareRow.moveView),
			})),
		)
	).filter((pair): pair is { shareRow: Doc<"files_share_rows">; node: Doc<"files_nodes"> } => {
		const { shareRow, node } = pair;
		if (node === null) {
			return false;
		}
		// The overlay flush keeps the copy in step with the node. A copy out of step is a bug, and its
		// row would show in the wrong folder, segment or order.
		if (
			shareRow.nodeCreationTime !== node._creationTime ||
			files_share_rows_NODE_FIELDS.some((field) => shareRow[field] !== (node[field] ?? null))
		) {
			console.error("files_share_rows copy is mismatched", { shareRowId: shareRow._id, nodeId: node._id });
			return false;
		}
		return (
			node.organizationId === membership.organizationId &&
			node.workspaceId === membership.workspaceId &&
			node.restrictedScopeNodeId === node._id &&
			(shareRow.externalPluginMembershipLifetime === null ||
				(liveLifetime?.active === true && liveLifetime.lifetime === shareRow.externalPluginMembershipLifetime))
		);
	});
	const readableIds = new Set(
		(
			await access_control_db_filter_readable_file_nodes(ctx, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: userAuth.id,
				nodes: pairs.map((pair) => pair.node),
				hasWorkspaceRead,
			})
		).map((node) => node._id),
	);
	const kept = pairs.filter((pair) => readableIds.has(pair.node._id));
	const treeRows = await db_get_tree_rows(ctx, { userAuth, membership, fileNodes: kept.map((pair) => pair.node) });
	return kept.map((pair, index) => ({ shareRow: pair.shareRow, treeRow: treeRows[index]! }));
}

/**
 * One page of the children of one folder, of one kind. The Files tree loads each open folder with it.
 *
 * Saved rows only: UI lists never show drafts. Drafts show in the Pending tab and to the agent
 * (files-explorer-tree skill, "Saved-only lists").
 *
 * Like the folder table, each kind has an open stream and a restricted twin. The open stream reads
 * the children that are not their own restricted root. When the caller may read the folder, every
 * such child is readable, so no row is dropped after paging. Only the owner reads the restricted
 * twin. A member gets the restricted children shared with them from `list_tree_children_shared`.
 * The client merges the streams. Active rows come in the folder table's name order `(sortName,
 * name)`, archived rows in `(archiveOperationId, sortName, name)` order.
 */
export const list_tree_children = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		savedStream: v.optional(files_saved_stream_validator),
		parentId: doc(app_convex_schema, "files_nodes").fields.parentId,
		kind: doc(app_convex_schema, "files_nodes").fields.kind,
		archived: v.boolean(),
		/**
		 * Read the children that are their own restricted root. Only the owner gets rows.
		 */
		restricted: v.boolean(),
		paginationOpts: paginationOptsValidator,
	},
	returns: paginationResultValidator(
		v.object({
			...files_node_public_doc_fields,
			// These four fields cannot contain reserved `GLOBAL` or `SYSTEM` values in the visible tree.
			organizationId: v.id("organizations"),
			workspaceId: v.id("organizations_workspaces"),
			createdBy: v.id("users"),
			updatedBy: v.id("users"),
		}),
	),
	handler: async (ctx, args) => {
		// Every refusal gives this one answer. A different answer for a missing, foreign, or hidden
		// parent would tell the caller that a hidden folder exists.
		const refused = { page: [], isDone: true, continueCursor: "" };

		const reader = await files_nodes_db_get_tree_reader(ctx, { membershipId: args.membershipId });
		if (!reader) {
			return refused;
		}
		const { userAuth, membership } = reader;

		// Only the owner reads the restricted twin. Refuse before the folder read, so it costs nothing.
		if (args.restricted && !reader.isOwner) {
			return refused;
		}

		// A grant-only member reads no open node, and they get their root rows from
		// `list_tree_shared_roots` instead.
		if (args.parentId === files_ROOT_ID) {
			if (!reader.hasWorkspaceRead) {
				return refused;
			}
		} else if (!(await db_get_readable_tree_node(ctx, { reader, nodeId: args.parentId }))) {
			return refused;
		}

		const paginationOpts = {
			...args.paginationOpts,
			numItems: Math.min(args.paginationOpts.numItems, TREE_CHILDREN_MAX_ITEMS),
		};
		const saved = await files_saved_stream_db_create(ctx.db, membership, args.savedStream);
		const rawResult = args.archived
			? await saved.queries
					.by_parent_kind_restricted_archive_sort_name((q) =>
						q
							.eq("parentId", args.parentId)
							.eq("kind", args.kind)
							.eq("isRestrictedScopeRoot", args.restricted)
							.gt("archiveOperationId", null),
					)
					.paginate(paginationOpts)
			: await saved.queries
					.by_parent_archive_restricted_kind_sort_name((q) =>
						q
							.eq("parentId", args.parentId)
							.eq("archiveOperationId", null)
							.eq("isRestrictedScopeRoot", args.restricted)
							.eq("kind", args.kind),
					)
					.paginate(paginationOpts);
		// Selected rows also read their saved node, cohort and place before checking access.
		if (
			tree_page_needs_split(
				rawResult,
				args.savedStream?.kind === "cohort" ? 500 : args.restricted ? TREE_RESTRICTED_SPLIT_GUARD : Infinity,
			)
		) {
			return tree_page_split_required(rawResult);
		}
		const result = { ...rawResult, page: await saved.read_nodes(rawResult.page) };
		for (const node of result.page) {
			check_tree_stream_row(node, {
				membership,
				parentId: args.parentId,
				archived: args.archived,
				restricted: args.restricted,
			});
		}

		const page = await db_get_tree_rows(ctx, { userAuth, membership, fileNodes: result.page });
		// A page can be empty after a split. Only isDone ends the folder.
		return { ...result, page };
	},
});

/**
 * One page of one stream of one folder's children, for the folder table.
 *
 * A stream is one kind, one segment, and either the open or the restricted children. It reads one
 * index range with one `.paginate()`. The filter picks the index, and the index fixes the order, so
 * `sort` must be the filter's order (`files_table_filter_order_field`). The browser merges the
 * streams by `sortKey` with `files_sort_compare`. Folders come first.
 *
 * The open stream reads the children that are not their own restricted root. When the caller may
 * read the folder, every such child is readable. So no row is dropped for access after paging, and a
 * hidden child can never shorten a page. Only the owner reads the restricted stream. A member gets
 * the restricted children shared with them from `list_tree_children_shared`.
 * This is true for members only; service accounts check each node, so do not reuse this for them.
 */
export const list_tree_children_sorted = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		savedStream: v.optional(files_saved_stream_validator),
		parentId: doc(app_convex_schema, "files_nodes").fields.parentId,
		kind: doc(app_convex_schema, "files_nodes").fields.kind,
		/**
		 * One clause: the filter's order when a filter is on, else the saved sort.
		 */
		sort: files_sort_validator,
		filter: v.union(files_table_filter_validator, v.null()),
		/**
		 * `name starts with`, next to an "is" filter only. A `name starts with` alone is the filter.
		 */
		namePrefix: v.union(v.string(), v.null()),
		/**
		 * Read the children that are their own restricted root. Only the owner gets rows.
		 */
		restricted: v.boolean(),
		/**
		 * The rows with no value. Only an extension or size sort with no filter has them.
		 */
		segment: v.union(v.literal("value"), v.literal("missing")),
		paginationOpts: paginationOptsValidator,
	},
	returns: paginationResultValidator(
		v.object({
			...files_node_public_doc_fields,
			// These four fields cannot contain reserved `GLOBAL` or `SYSTEM` values in the visible tree.
			organizationId: v.id("organizations"),
			workspaceId: v.id("organizations_workspaces"),
			createdBy: v.id("users"),
			updatedBy: v.id("users"),
			/**
			 * The row's index key in the table order. Compare it with `files_sort_compare`.
			 */
			sortKey: files_sort_row_key_validator,
		}),
	),
	handler: async (
		ctx,
		args,
	): Promise<
		PaginationResult<Awaited<ReturnType<typeof db_get_tree_rows>>[number] & { sortKey: files_sort_RowKey }>
	> => {
		// Saved rows only: UI lists never show drafts. Drafts show in the Pending tab and to the agent
		// (files-explorer-tree skill, "Saved-only lists").

		// Every refusal gives this one answer, like `list_tree_children`.
		const refused = { page: [], isDone: true, continueCursor: "" };

		const reader = await files_nodes_db_get_tree_reader(ctx, { membershipId: args.membershipId });
		if (!reader) {
			return refused;
		}
		const { userAuth, membership } = reader;

		// A grant-only member reads no open node. `list_tree_children_shared` gives them their shared root
		// children.
		if (args.parentId === files_ROOT_ID) {
			if (!reader.hasWorkspaceRead) {
				return refused;
			}
		} else if (!(await db_get_readable_tree_node(ctx, { reader, nodeId: args.parentId }))) {
			return refused;
		}

		const table = get_table_read_args(args);
		if (!table) {
			return refused;
		}
		const { sort, filter, namePrefix, metadataField } = table;

		// Only the owner reads the restricted twin of each stream.
		if (args.restricted && !reader.isOwner) {
			return refused;
		}

		const paginationOpts = {
			...args.paginationOpts,
			numItems: Math.min(args.paginationOpts.numItems, TREE_CHILDREN_MAX_ITEMS),
		};
		const direction = sort.direction;
		const saved = await files_saved_stream_db_create(ctx.db, membership, args.savedStream);

		const table_page = async (
			result: PaginationResult<unknown>,
			rows: Array<{ node: Doc<"files_nodes">; sortKey: files_sort_Key | null }>,
		) => {
			for (const { node } of rows) {
				check_tree_stream_row(node, {
					membership,
					parentId: args.parentId,
					archived: false,
					restricted: args.restricted,
				});
			}
			const treeRows = await db_get_tree_rows(ctx, { userAuth, membership, fileNodes: rows.map((row) => row.node) });
			return {
				...result,
				page: treeRows.map((treeRow, index) => {
					const row = rows[index]!;
					const sortKey: files_sort_RowKey = { parts: [row.sortKey], nameKey: [row.node.sortName, row.node.name] };
					return { ...treeRow, sortKey };
				}),
			};
		};

		// A metadata or frontmatter key: its committed field docs carry the node's sort fields.
		if (metadataField !== null) {
			const result = await ctx.db
				.query("files_metadata_docs")
				.withIndex("by_org_ws_source_archive_docKind_field_parent_restricted_sort", (q) => {
					const fieldDocs = q
						.eq("organizationId", membership.organizationId)
						.eq("workspaceId", membership.workspaceId)
						.eq("sourceKind", "committed")
						.eq("moveView.cohortId", saved.tag?.cohortId)
						.eq("moveView.view", saved.tag?.view)
						.eq("archiveOperationId", undefined)
						.eq("docKind", "field")
						.eq("fieldPath", metadataField)
						.eq("parentId", args.parentId)
						.eq("isRestrictedScopeRoot", args.restricted)
						.eq("nodeKind", args.kind);
					// "is" reads one value. Its rows are in name order, so the name prefix is one more range.
					if (filter?.kind === "text" && filter.op === "is") {
						const value = fieldDocs.eq("sortValue", files_sort_text_key(filter.value));
						if (!namePrefix) return value;
						const fromName = value.gte("sortName", namePrefix.start);
						return namePrefix.end === null ? fromName : fromName.lt("sortName", namePrefix.end);
					}
					if (filter?.kind === "text" && filter.op === "starts_with") {
						const start = files_sort_text_key(filter.value);
						const end = string_prefix_upper_bound(start);
						const fromValue = fieldDocs.gte("sortValue", start);
						return end === null ? fromValue : fromValue.lt("sortValue", end);
					}
					// Leave out docs with no value, such as a frontmatter map.
					return fieldDocs.gte("sortValue", "");
				})
				.order(direction)
				.paginate({ ...paginationOpts, maximumBytesRead: 4 * 1024 * 1024 });

			if (
				tree_page_needs_split(
					result,
					saved.tag ? 500 : args.restricted ? TREE_METADATA_RESTRICTED_SPLIT_GUARD : TREE_METADATA_SPLIT_GUARD,
				)
			) {
				return tree_page_split_required(result);
			}

			const rows = await Promise.all(
				result.page.map(async (fieldDoc) => {
					const node =
						fieldDoc.sourceKind === "committed"
							? await files_saved_placement_db_get_node(ctx.db, fieldDoc.fileNodeId, saved.tag)
							: null;
					if (!node || fieldDoc.sourceKind !== "committed") {
						const errorMessage = "fieldDoc.fileNodeId points to a missing files_nodes doc";
						const errorData = { fieldDocId: fieldDoc._id };
						console.error(errorMessage, errorData);
						throw should_never_happen(errorMessage, errorData);
					}
					// The field doc copies the node's name and kind. A stale copy would put the row in the
					// wrong place or the wrong stream, so it must fail loudly.
					if (fieldDoc.sortName !== node.sortName || fieldDoc.name !== node.name || fieldDoc.nodeKind !== node.kind) {
						const errorMessage = "fieldDoc sort fields are mismatched";
						const errorData = { fieldDocId: fieldDoc._id, nodeId: node._id };
						console.error(errorMessage, errorData);
						throw should_never_happen(errorMessage, errorData);
					}

					return {
						node,
						sortKey:
							sort.field === "name"
								? [node.sortName, node.name]
								: [fieldDoc.sortValue ?? null, node.sortName, node.name],
					};
				}),
			);
			return await table_page(result, rows);
		}

		const by_name = (node: Doc<"files_nodes">): files_sort_Key => [node.sortName, node.name];
		const stream = await (async (/* iife */): Promise<{
			result: PaginationResult<Doc<"files_nodes"> | Doc<"files_saved_places">>;
			sortKey: (node: Doc<"files_nodes">) => files_sort_Key | null;
		}> => {
			// Convex appends `_creationTime` to every index, so this index is in creation order.
			if (filter === null ? sort.field === "created" : filter.kind === "date" && filter.field === "created") {
				const day = filter?.kind === "date" ? filter : null;
				return {
					result: await saved.queries
						.by_parent_archive_restricted_kind_created({
							parentId: args.parentId,
							archiveOperationId: null,
							isRestrictedScopeRoot: args.restricted,
							kind: args.kind,
							day,
						})
						.order(direction)
						.paginate(paginationOpts),
					sortKey: (node) => [node._creationTime],
				};
			}

			if (filter === null ? sort.field === "updated" : filter.kind === "date") {
				const day = filter?.kind === "date" ? filter : null;
				return {
					result: await saved.queries
						.by_parent_archive_restricted_kind_updated((q) => {
							const children = q
								.eq("parentId", args.parentId)
								.eq("archiveOperationId", null)
								.eq("isRestrictedScopeRoot", args.restricted)
								.eq("kind", args.kind);
							return day === null
								? children
								: day.op === "before"
									? children.lt("updatedAt", day.start)
									: day.op === "after"
										? children.gte("updatedAt", day.end)
										: children.gte("updatedAt", day.start).lt("updatedAt", day.end);
						})
						.order(direction)
						.paginate(paginationOpts),
					sortKey: (node) => [node.updatedAt, node.sortName, node.name],
				};
			}

			// An "is" or "missing" filter reads one value. Its rows are in name order, so the name prefix
			// is one more range.
			if (filter?.kind === "extension") {
				const extension = filter.op === "is" ? filter.value.toLowerCase() : null;
				return {
					result: await saved.queries
						.by_parent_archive_restricted_kind_ext((q) => {
							const value = q
								.eq("parentId", args.parentId)
								.eq("archiveOperationId", null)
								.eq("isRestrictedScopeRoot", args.restricted)
								.eq("kind", args.kind)
								.eq("lowercaseExtension", extension);
							if (!namePrefix) return value;
							const fromName = value.gte("sortName", namePrefix.start);
							return namePrefix.end === null ? fromName : fromName.lt("sortName", namePrefix.end);
						})
						.order(direction)
						.paginate(paginationOpts),
					sortKey: by_name,
				};
			}

			if (filter?.kind === "size" && (filter.op === "is" || filter.op === "missing")) {
				const size = filter.op === "is" ? filter.value : null;
				return {
					result: await saved.queries
						.by_parent_archive_restricted_kind_size((q) => {
							const value = q
								.eq("parentId", args.parentId)
								.eq("archiveOperationId", null)
								.eq("isRestrictedScopeRoot", args.restricted)
								.eq("kind", args.kind)
								.eq("contentByteSize", size);
							if (!namePrefix) return value;
							const fromName = value.gte("sortName", namePrefix.start);
							return namePrefix.end === null ? fromName : fromName.lt("sortName", namePrefix.end);
						})
						.order(direction)
						.paginate(paginationOpts),
					sortKey: by_name,
				};
			}

			// A size range orders by size. `at_most` leaves out the rows with no size.
			if (filter?.kind === "size") {
				const bound = filter.value;
				return {
					result: await saved.queries
						.by_parent_archive_restricted_kind_size((q) => {
							const children = q
								.eq("parentId", args.parentId)
								.eq("archiveOperationId", null)
								.eq("isRestrictedScopeRoot", args.restricted)
								.eq("kind", args.kind);
							return filter.op === "at_least"
								? children.gte("contentByteSize", bound)
								: children.gt("contentByteSize", null).lte("contentByteSize", bound);
						})
						.order(direction)
						.paginate(paginationOpts),
					sortKey: (node) => [node.contentByteSize, node.sortName, node.name],
				};
			}

			// Null means no extension or no known size. With no filter, those rows are the `missing`
			// segment, by name.
			const missing = args.segment === "missing";
			if (filter === null && sort.field === "extension") {
				return {
					result: await saved.queries
						.by_parent_archive_restricted_kind_ext((q) => {
							const children = q
								.eq("parentId", args.parentId)
								.eq("archiveOperationId", null)
								.eq("isRestrictedScopeRoot", args.restricted)
								.eq("kind", args.kind);
							return missing ? children.eq("lowercaseExtension", null) : children.gt("lowercaseExtension", null);
						})
						.order(missing ? "asc" : direction)
						.paginate(paginationOpts),
					sortKey: (node) => (missing ? null : [node.lowercaseExtension, node.sortName, node.name]),
				};
			}

			if (filter === null && sort.field === "size" && args.kind === "file") {
				return {
					result: await saved.queries
						.by_parent_archive_restricted_kind_size((q) => {
							const children = q
								.eq("parentId", args.parentId)
								.eq("archiveOperationId", null)
								.eq("isRestrictedScopeRoot", args.restricted)
								.eq("kind", args.kind);
							return missing ? children.eq("contentByteSize", null) : children.gt("contentByteSize", null);
						})
						.order(missing ? "asc" : direction)
						.paginate(paginationOpts),
					sortKey: (node) => (missing ? null : [node.contentByteSize, node.sortName, node.name]),
				};
			}

			// The name order: no filter with a name sort, a `name starts with` filter, and folders in a size
			// sort (they have no size, so their key is null).
			return {
				result: await saved.queries
					.by_parent_archive_restricted_kind_sort_name((q) => {
						const children = q
							.eq("parentId", args.parentId)
							.eq("archiveOperationId", null)
							.eq("isRestrictedScopeRoot", args.restricted)
							.eq("kind", args.kind);
						if (!namePrefix) return children;
						const fromName = children.gte("sortName", namePrefix.start);
						return namePrefix.end === null ? fromName : fromName.lt("sortName", namePrefix.end);
					})
					.order(sort.field === "name" ? direction : "asc")
					.paginate(paginationOpts),
				sortKey: (node) => (sort.field === "name" ? by_name(node) : null),
			};
		})();

		if (
			tree_page_needs_split(
				stream.result,
				args.savedStream?.kind === "cohort" ? 500 : args.restricted ? TREE_RESTRICTED_SPLIT_GUARD : Infinity,
			)
		) {
			return tree_page_split_required(stream.result);
		}

		return await table_page(
			stream.result,
			(await saved.read_nodes(stream.result.page)).map((node) => ({ node, sortKey: stream.sortKey(node) })),
		);
	},
});

/**
 * One page of one share stream of one folder's children: the restricted children shared with a
 * member, for the folder table and the Files tree. It takes the args of `list_tree_children_sorted`
 * and reads the same order from the share rows (`files_share_rows`), so the client merges it with
 * the open stream.
 *
 * A share row is one copy per share (one grant to a user or a role), not one per member who can
 * read the node. A share to a role stays one row however many members hold the role, and a role
 * change writes nothing. So a member reads up to 3 streams per kind and segment, by
 * `principalIndex` (`db_get_share_principal_keys`), and the client drops a node it already has.
 *
 * The owner reads every restricted child in the restricted twin, so the owner gets an empty page.
 * Metadata sorts and filters have no share copy, so they get an empty page too: the folder table
 * tells members that shared items are not shown then (`has_tree_children_shared`). The archived
 * sidebar reads the name order only.
 */
export const list_tree_children_shared = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		savedStream: v.optional(files_saved_stream_validator),
		parentId: doc(app_convex_schema, "files_nodes").fields.parentId,
		kind: doc(app_convex_schema, "files_nodes").fields.kind,
		archived: v.boolean(),
		/**
		 * 0 reads the member's own shares, 1 and 2 the shares of their roles.
		 */
		principalIndex: v.union(v.literal(0), v.literal(1), v.literal(2)),
		sort: files_sort_validator,
		filter: v.union(files_table_filter_validator, v.null()),
		namePrefix: v.union(v.string(), v.null()),
		segment: v.union(v.literal("value"), v.literal("missing")),
		paginationOpts: paginationOptsValidator,
	},
	returns: paginationResultValidator(
		v.object({
			...files_node_public_doc_fields,
			// These four fields cannot contain reserved `GLOBAL` or `SYSTEM` values in the visible tree.
			organizationId: v.id("organizations"),
			workspaceId: v.id("organizations_workspaces"),
			createdBy: v.id("users"),
			updatedBy: v.id("users"),
			/**
			 * The row's index key in the table order. Compare it with `files_sort_compare`.
			 */
			sortKey: files_sort_row_key_validator,
		}),
	),
	handler: async (
		ctx,
		args,
	): Promise<
		PaginationResult<Awaited<ReturnType<typeof db_get_tree_rows>>[number] & { sortKey: files_sort_RowKey }>
	> => {
		// Saved rows only: UI lists never show drafts. Drafts show in the Pending tab and to the agent
		// (files-explorer-tree skill, "Saved-only lists").

		// Every refusal gives this one answer, like `list_tree_children`.
		const refused = { page: [], isDone: true, continueCursor: "" };

		const reader = await files_nodes_db_get_tree_reader(ctx, { membershipId: args.membershipId });
		if (!reader) {
			return refused;
		}
		const { membership } = reader;

		// Do the refusals that need no folder read first, so they cost nothing.
		const table = get_table_read_args(args);
		if (
			!table ||
			reader.isOwner ||
			table.metadataField !== null ||
			(args.archived && (table.sort.field !== "name" || table.filter !== null || table.namePrefix !== null))
		) {
			return refused;
		}
		const { sort, filter, namePrefix } = table;

		// The server builds the key from the caller only, never from the client.
		const principalKey = (await db_get_share_principal_keys(ctx, reader))[args.principalIndex];
		if (!principalKey) {
			return refused;
		}

		// At the root a grant-only member still gets the shares there, because the open streams give
		// them nothing.
		if (args.parentId !== files_ROOT_ID && !(await db_get_readable_tree_node(ctx, { reader, nodeId: args.parentId }))) {
			return refused;
		}

		const paginationOpts = {
			...args.paginationOpts,
			numItems: Math.min(args.paginationOpts.numItems, TREE_SHARE_PAGE_MAX_ITEMS),
		};
		const { tag } = await files_saved_stream_db_create(ctx.db, membership, args.savedStream);
		const direction = sort.direction;

		const by_name = (row: Doc<"files_share_rows">): files_sort_Key => [row.sortName, row.name];
		const stream = await (async (/* iife */): Promise<{
			result: PaginationResult<Doc<"files_share_rows">>;
			sortKey: (row: Doc<"files_share_rows">) => files_sort_Key | null;
		}> => {
			// The archived sidebar: archived rows in `(archiveOperationId, sortName, name)` order.
			if (args.archived) {
				return {
					result: await ctx.db
						.query("files_share_rows")
						.withIndex("by_org_ws_principal_parent_kind_archive_sortName_name", (q) =>
							q
								.eq("organizationId", membership.organizationId)
								.eq("workspaceId", membership.workspaceId)
								.eq("principalKey", principalKey)
								.eq("moveView.cohortId", tag?.cohortId)
								.eq("moveView.view", tag?.view)
								.eq("parentId", args.parentId)
								.eq("kind", args.kind)
								.gt("archiveOperationId", null),
						)
						.order(direction)
						.paginate(paginationOpts),
					sortKey: (row) => [row.archiveOperationId, row.sortName, row.name],
				};
			}

			// The share row copies the node's `_creationTime`, so this order follows the node.
			if (filter === null ? sort.field === "created" : filter.kind === "date" && filter.field === "created") {
				const day = filter?.kind === "date" ? filter : null;
				return {
					result: await ctx.db
						.query("files_share_rows")
						.withIndex("by_org_ws_principal_parent_kind_archive_nodeCreationTime", (q) => {
							const children = q
								.eq("organizationId", membership.organizationId)
								.eq("workspaceId", membership.workspaceId)
								.eq("principalKey", principalKey)
								.eq("moveView.cohortId", tag?.cohortId)
								.eq("moveView.view", tag?.view)
								.eq("parentId", args.parentId)
								.eq("kind", args.kind)
								.eq("archiveOperationId", null);
							return day === null
								? children
								: day.op === "before"
									? children.lt("nodeCreationTime", day.start)
									: day.op === "after"
										? children.gte("nodeCreationTime", day.end)
										: children.gte("nodeCreationTime", day.start).lt("nodeCreationTime", day.end);
						})
						.order(direction)
						.paginate(paginationOpts),
					sortKey: (row) => [row.nodeCreationTime],
				};
			}

			if (filter === null ? sort.field === "updated" : filter.kind === "date") {
				const day = filter?.kind === "date" ? filter : null;
				return {
					result: await ctx.db
						.query("files_share_rows")
						.withIndex("by_org_ws_principal_parent_kind_archive_updatedAt_sortName_name", (q) => {
							const children = q
								.eq("organizationId", membership.organizationId)
								.eq("workspaceId", membership.workspaceId)
								.eq("principalKey", principalKey)
								.eq("moveView.cohortId", tag?.cohortId)
								.eq("moveView.view", tag?.view)
								.eq("parentId", args.parentId)
								.eq("kind", args.kind)
								.eq("archiveOperationId", null);
							return day === null
								? children
								: day.op === "before"
									? children.lt("updatedAt", day.start)
									: day.op === "after"
										? children.gte("updatedAt", day.end)
										: children.gte("updatedAt", day.start).lt("updatedAt", day.end);
						})
						.order(direction)
						.paginate(paginationOpts),
					sortKey: (row) => [row.updatedAt, row.sortName, row.name],
				};
			}

			// An "is" or "missing" filter reads one value. Its rows are in name order, so the name prefix
			// is one more range.
			if (filter?.kind === "extension") {
				const extension = filter.op === "is" ? filter.value.toLowerCase() : null;
				return {
					result: await ctx.db
						.query("files_share_rows")
						.withIndex("by_org_ws_principal_parent_kind_archive_ext_sortName_name", (q) => {
							const value = q
								.eq("organizationId", membership.organizationId)
								.eq("workspaceId", membership.workspaceId)
								.eq("principalKey", principalKey)
								.eq("moveView.cohortId", tag?.cohortId)
								.eq("moveView.view", tag?.view)
								.eq("parentId", args.parentId)
								.eq("kind", args.kind)
								.eq("archiveOperationId", null)
								.eq("lowercaseExtension", extension);
							if (!namePrefix) return value;
							const fromName = value.gte("sortName", namePrefix.start);
							return namePrefix.end === null ? fromName : fromName.lt("sortName", namePrefix.end);
						})
						.order(direction)
						.paginate(paginationOpts),
					sortKey: by_name,
				};
			}

			if (filter?.kind === "size" && (filter.op === "is" || filter.op === "missing")) {
				const size = filter.op === "is" ? filter.value : null;
				return {
					result: await ctx.db
						.query("files_share_rows")
						.withIndex("by_org_ws_principal_parent_kind_archive_size_sortName_name", (q) => {
							const value = q
								.eq("organizationId", membership.organizationId)
								.eq("workspaceId", membership.workspaceId)
								.eq("principalKey", principalKey)
								.eq("moveView.cohortId", tag?.cohortId)
								.eq("moveView.view", tag?.view)
								.eq("parentId", args.parentId)
								.eq("kind", args.kind)
								.eq("archiveOperationId", null)
								.eq("contentByteSize", size);
							if (!namePrefix) return value;
							const fromName = value.gte("sortName", namePrefix.start);
							return namePrefix.end === null ? fromName : fromName.lt("sortName", namePrefix.end);
						})
						.order(direction)
						.paginate(paginationOpts),
					sortKey: by_name,
				};
			}

			// A size range orders by size. `at_most` leaves out the rows with no size.
			if (filter?.kind === "size") {
				const bound = filter.value;
				return {
					result: await ctx.db
						.query("files_share_rows")
						.withIndex("by_org_ws_principal_parent_kind_archive_size_sortName_name", (q) => {
							const children = q
								.eq("organizationId", membership.organizationId)
								.eq("workspaceId", membership.workspaceId)
								.eq("principalKey", principalKey)
								.eq("moveView.cohortId", tag?.cohortId)
								.eq("moveView.view", tag?.view)
								.eq("parentId", args.parentId)
								.eq("kind", args.kind)
								.eq("archiveOperationId", null);
							return filter.op === "at_least"
								? children.gte("contentByteSize", bound)
								: children.gt("contentByteSize", null).lte("contentByteSize", bound);
						})
						.order(direction)
						.paginate(paginationOpts),
					sortKey: (row) => [row.contentByteSize, row.sortName, row.name],
				};
			}

			// Null means no extension or no known size. With no filter, those rows are the `missing`
			// segment, by name.
			const missing = args.segment === "missing";
			if (filter === null && sort.field === "extension") {
				return {
					result: await ctx.db
						.query("files_share_rows")
						.withIndex("by_org_ws_principal_parent_kind_archive_ext_sortName_name", (q) => {
							const children = q
								.eq("organizationId", membership.organizationId)
								.eq("workspaceId", membership.workspaceId)
								.eq("principalKey", principalKey)
								.eq("moveView.cohortId", tag?.cohortId)
								.eq("moveView.view", tag?.view)
								.eq("parentId", args.parentId)
								.eq("kind", args.kind)
								.eq("archiveOperationId", null);
							return missing ? children.eq("lowercaseExtension", null) : children.gt("lowercaseExtension", null);
						})
						.order(missing ? "asc" : direction)
						.paginate(paginationOpts),
					sortKey: (row) => (missing ? null : [row.lowercaseExtension, row.sortName, row.name]),
				};
			}

			if (filter === null && sort.field === "size" && args.kind === "file") {
				return {
					result: await ctx.db
						.query("files_share_rows")
						.withIndex("by_org_ws_principal_parent_kind_archive_size_sortName_name", (q) => {
							const children = q
								.eq("organizationId", membership.organizationId)
								.eq("workspaceId", membership.workspaceId)
								.eq("principalKey", principalKey)
								.eq("moveView.cohortId", tag?.cohortId)
								.eq("moveView.view", tag?.view)
								.eq("parentId", args.parentId)
								.eq("kind", args.kind)
								.eq("archiveOperationId", null);
							return missing ? children.eq("contentByteSize", null) : children.gt("contentByteSize", null);
						})
						.order(missing ? "asc" : direction)
						.paginate(paginationOpts),
					sortKey: (row) => (missing ? null : [row.contentByteSize, row.sortName, row.name]),
				};
			}

			// The name order: no filter with a name sort, a `name starts with` filter, and folders in a size
			// sort (they have no size, so their key is null).
			return {
				result: await ctx.db
					.query("files_share_rows")
					.withIndex("by_org_ws_principal_parent_kind_archive_sortName_name", (q) => {
						const children = q
							.eq("organizationId", membership.organizationId)
							.eq("workspaceId", membership.workspaceId)
							.eq("principalKey", principalKey)
							.eq("moveView.cohortId", tag?.cohortId)
							.eq("moveView.view", tag?.view)
							.eq("parentId", args.parentId)
							.eq("kind", args.kind)
							.eq("archiveOperationId", null);
						if (!namePrefix) return children;
						const fromName = children.gte("sortName", namePrefix.start);
						return namePrefix.end === null ? fromName : fromName.lt("sortName", namePrefix.end);
					})
					.order(sort.field === "name" ? direction : "asc")
					.paginate(paginationOpts),
				sortKey: (row) => (sort.field === "name" ? by_name(row) : null),
			};
		})();

		// Each share row reads its node and checks its access (`TREE_SHARE_PAGE_MAX_ITEMS`).
		if (tree_page_needs_split(stream.result, TREE_SHARE_PAGE_MAX_ITEMS)) {
			return tree_page_split_required(stream.result);
		}

		const rows = await db_get_share_tree_rows(ctx, { reader, shareRows: stream.result.page });
		return {
			...stream.result,
			page: rows.map(({ shareRow, treeRow }) => {
				// The key comes from the share row, the index key of this page, so the merge sees what the
				// index sorted.
				const sortKey: files_sort_RowKey = {
					parts: [stream.sortKey(shareRow)],
					nameKey: [shareRow.sortName, shareRow.name],
				};
				return { ...treeRow, sortKey };
			}),
		};
	},
});

/**
 * Whether the caller has a share in this folder, active or archived, as the read asks, for the
 * folder table: during a metadata sort or filter it tells members that shared items are not shown.
 * Null when the caller cannot read the folder, which the table shows as a refused folder. The owner
 * gets false.
 */
export const has_tree_children_shared = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		parentId: doc(app_convex_schema, "files_nodes").fields.parentId,
		archived: v.boolean(),
	},
	returns: v.union(v.boolean(), v.null()),
	handler: async (ctx, args) => {
		const reader = await files_nodes_db_get_tree_reader(ctx, { membershipId: args.membershipId });
		if (!reader) {
			return null;
		}
		// The same gate as `list_tree_children_shared`. The owner check comes after it, because the
		// owner's false is not a refusal: the table reads null as a refused folder.
		if (args.parentId !== files_ROOT_ID && !(await db_get_readable_tree_node(ctx, { reader, nodeId: args.parentId }))) {
			return null;
		}
		if (reader.isOwner) {
			return false;
		}

		const view = await files_saved_placement_db_get_view(ctx.db, reader.membership);
		const tags = [undefined, ...(view.cohortId && view.view ? [{ cohortId: view.cohortId, view: view.view }] : [])];
		// One `.first()` per view, principal and kind. The answer names no item, so it
		// reads no node and checks no access. A plugin grant row with an old membership lifetime reads
		// nothing, like in `db_get_share_tree_rows`. Such rows live only while a drain deletes them, and
		// reading past one would be a scan, so the answer can be a short false "no" then.
		let liveLifetime: Awaited<ReturnType<typeof organizations_membership_lifetimes_db_get>> | undefined;
		for (const tag of tags) {
			for (const principalKey of await db_get_share_principal_keys(ctx, reader)) {
				for (const kind of ["folder", "file"] as const) {
					const shareRow = await ctx.db
						.query("files_share_rows")
						.withIndex("by_org_ws_principal_parent_kind_archive_sortName_name", (q) => {
							const children = q
								.eq("organizationId", reader.membership.organizationId)
								.eq("workspaceId", reader.membership.workspaceId)
								.eq("principalKey", principalKey)
								.eq("moveView.cohortId", tag?.cohortId)
								.eq("moveView.view", tag?.view)
								.eq("parentId", args.parentId)
								.eq("kind", kind);
							return args.archived ? children.gt("archiveOperationId", null) : children.eq("archiveOperationId", null);
						})
						.first();
					if (!shareRow) continue;
					if (shareRow.externalPluginMembershipLifetime === null) return true;
					if (liveLifetime === undefined) {
						liveLifetime = await organizations_membership_lifetimes_db_get(ctx, {
							workspaceId: reader.membership.workspaceId,
							userId: reader.userAuth.id,
						});
					}
					if (liveLifetime?.active === true && liveLifetime.lifetime === shareRow.externalPluginMembershipLifetime)
						return true;
				}
			}
		}
		return false;
	},
});

/**
 * A node and the readable folders above it, for deep links, reveal, and the breadcrumb.
 *
 * `ancestors` go from the top readable folder down to the node's parent. The walk stops at the
 * first folder the caller cannot read, because the tree cannot show a row under a folder it cannot
 * show. So the node's rows hang from the root. Every row still carries its `path` and `parentId`,
 * like `list_tree_children` rows, so the names of the hidden folders above it are not secret.
 */
export const get_tree_ancestors = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		/**
		 * Keep raw IDs so invalid input returns null instead of an argument error.
		 */
		nodeId: v.string(),
	},
	returns: v.union(
		v.null(),
		v.object({
			node: v.object({
				...files_node_public_doc_fields,
				// These four fields cannot contain reserved `GLOBAL` or `SYSTEM` values in the visible tree.
				organizationId: v.id("organizations"),
				workspaceId: v.id("organizations_workspaces"),
				createdBy: v.id("users"),
				updatedBy: v.id("users"),
			}),
			ancestors: v.array(
				v.object({
					...files_node_public_doc_fields,
					// These four fields cannot contain reserved `GLOBAL` or `SYSTEM` values in the visible tree.
					organizationId: v.id("organizations"),
					workspaceId: v.id("organizations_workspaces"),
					createdBy: v.id("users"),
					updatedBy: v.id("users"),
				}),
			),
		}),
	),
	handler: async (ctx, args) => {
		const reader = await files_nodes_db_get_tree_reader(ctx, { membershipId: args.membershipId });
		if (!reader) {
			return null;
		}

		const nodeId = ctx.db.normalizeId("files_nodes", args.nodeId);
		if (!nodeId) {
			return null;
		}

		// Archived nodes are allowed. The caller decides how to show them.
		const fileNode = await db_get_readable_tree_node(ctx, { reader, nodeId });
		if (!fileNode) {
			return null;
		}

		const ancestors: Doc<"files_nodes">[] = [];
		let parentId = fileNode.parentId;
		while (parentId !== files_ROOT_ID && ancestors.length < TREE_ANCESTORS_MAX_DEPTH) {
			const parent = await db_get_readable_tree_node(ctx, { reader, nodeId: parentId });
			if (!parent) {
				break;
			}

			ancestors.unshift(parent);
			parentId = parent.parentId;
		}

		const [node, ...ancestorRows] = await db_get_tree_rows(ctx, {
			userAuth: reader.userAuth,
			membership: reader.membership,
			fileNodes: [fileNode, ...ancestors],
		});
		return { node, ancestors: ancestorRows };
	},
});

/**
 * The "Shared with you" group of the Files tree: every share of the caller, one page of one
 * principal (see `list_tree_children_shared`). The client merges the 3 principal streams and drops
 * a node it already has.
 *
 * Saved rows only. A share inside a folder the member can open shows here and in its folder. The
 * owner reads everything, so the owner gets nothing. Active rows come in `(sortName, name)` order,
 * archived rows in `(archiveOperationId, sortName, name)` order.
 */
export const list_tree_shared_roots = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		savedStream: v.optional(files_saved_stream_validator),
		archived: v.boolean(),
		/**
		 * 0 reads the member's own shares, 1 and 2 the shares of their roles.
		 */
		principalIndex: v.union(v.literal(0), v.literal(1), v.literal(2)),
		paginationOpts: paginationOptsValidator,
	},
	returns: paginationResultValidator(
		v.object({
			...files_node_public_doc_fields,
			// These four fields cannot contain reserved `GLOBAL` or `SYSTEM` values in the visible tree.
			organizationId: v.id("organizations"),
			workspaceId: v.id("organizations_workspaces"),
			createdBy: v.id("users"),
			updatedBy: v.id("users"),
		}),
	),
	handler: async (ctx, args) => {
		const refused = { page: [], isDone: true, continueCursor: "" };

		const reader = await files_nodes_db_get_tree_reader(ctx, { membershipId: args.membershipId });
		if (!reader || reader.isOwner) {
			return refused;
		}
		const principalKey = (await db_get_share_principal_keys(ctx, reader))[args.principalIndex];
		if (!principalKey) {
			return refused;
		}
		const { tag } = await files_saved_stream_db_create(ctx.db, reader.membership, args.savedStream);

		const result = await ctx.db
			.query("files_share_rows")
			.withIndex("by_org_ws_principal_archive_sortName_name", (q) => {
				const shares = q
					.eq("organizationId", reader.membership.organizationId)
					.eq("workspaceId", reader.membership.workspaceId)
					.eq("principalKey", principalKey)
					.eq("moveView.cohortId", tag?.cohortId)
					.eq("moveView.view", tag?.view);
				return args.archived ? shares.gt("archiveOperationId", null) : shares.eq("archiveOperationId", null);
			})
			.paginate({
				...args.paginationOpts,
				numItems: Math.min(args.paginationOpts.numItems, TREE_SHARE_PAGE_MAX_ITEMS),
			});

		// The same per-row reads as a share stream of `list_tree_children_shared`, so the same guard.
		if (tree_page_needs_split(result, TREE_SHARE_PAGE_MAX_ITEMS)) {
			return tree_page_split_required(result);
		}

		const rows = await db_get_share_tree_rows(ctx, { reader, shareRows: result.page });
		return { ...result, page: rows.map((row) => row.treeRow) };
	},
});

/**
 * The README of one folder: its active file child whose name, in lowercase, is `readme.md`.
 *
 * Names sort by raw bytes, so no single index range finds every letter case. Scan the 8 case
 * variants of the prefix `rea` instead, in byte order. Then the first readable match is the same
 * README that a byte-ordered listing shows first.
 */
export const get_folder_readme = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		folderId: doc(app_convex_schema, "files_nodes").fields.parentId,
	},
	returns: v.union(
		v.null(),
		v.object({
			...files_node_public_doc_fields,
			// These four fields cannot contain reserved `GLOBAL` or `SYSTEM` values in the visible tree.
			organizationId: v.id("organizations"),
			workspaceId: v.id("organizations_workspaces"),
			createdBy: v.id("users"),
			updatedBy: v.id("users"),
		}),
	),
	handler: async (ctx, args) => {
		const reader = await files_nodes_db_get_tree_reader(ctx, { membershipId: args.membershipId });
		if (!reader) {
			return null;
		}
		const { userAuth, membership, hasWorkspaceRead } = reader;

		// Use the same folder gate as `list_tree_children`, so a hidden folder answers like a missing one.
		if (args.folderId !== files_ROOT_ID && !(await db_get_readable_tree_node(ctx, { reader, nodeId: args.folderId }))) {
			return null;
		}

		const candidateLists = await Promise.all(
			["REA", "REa", "ReA", "Rea", "rEA", "rEa", "reA", "rea"].map((prefix) =>
				ctx.db
					.query("files_nodes")
					.withIndex("by_organization_workspace_parent_archiveOperation_kind_name", (q) => {
						const range = q
							.eq("organizationId", membership.organizationId)
							.eq("workspaceId", membership.workspaceId)
							.eq("moveCohortId", undefined)
							.eq("parentId", args.folderId)
							.eq("archiveOperationId", null)
							.eq("kind", "file")
							.gte("name", prefix);
						const upperBound = string_prefix_upper_bound(prefix);
						return upperBound === null ? range : range.lt("name", upperBound);
					})
					.take(50),
			),
		);

		const readmes = await access_control_db_filter_readable_file_nodes(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: userAuth.id,
			nodes: candidateLists.flat().filter((fileNode) => fileNode.name.toLowerCase() === "readme.md"),
			hasWorkspaceRead,
		});
		if (readmes.length === 0) {
			return null;
		}

		const [readme] = await db_get_tree_rows(ctx, { userAuth, membership, fileNodes: [readmes[0]] });
		return readme;
	},
});

/**
 * Whether the caller has a draft that adds, moves or removes items in this saved folder. The folder
 * table shows saved rows only, so it uses this to point to the Pending tab. A draft that only
 * changes content makes no place and no hide, so it gives no hint.
 */
export const has_drafts_in_folder = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		folderId: doc(app_convex_schema, "files_nodes").fields.parentId,
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const reader = await files_nodes_db_get_tree_reader(ctx, { membershipId: args.membershipId });
		if (!reader) {
			return false;
		}
		const { userAuth, membership } = reader;

		// Use the same folder gate as `list_tree_children`, so a hidden folder answers like a missing one.
		if (args.folderId !== files_ROOT_ID && !(await db_get_readable_tree_node(ctx, { reader, nodeId: args.folderId }))) {
			return false;
		}

		// A draft that adds or moves an item here has a visible place in this folder.
		const view = await files_saved_placement_db_get_view(ctx.db, membership);
		const selected = view.cohortId && view.view ? { cohortId: view.cohortId, view: view.view } : undefined;
		const views = selected ? [undefined, selected] : [undefined];
		const places = await Promise.all(
			views.map((moveView) =>
				ctx.db
					.query("files_pending_places")
					.withIndex("by_org_ws_user_visible_parent_name", (q) => {
						const visible = q
							.eq("organizationId", membership.organizationId)
							.eq("workspaceId", membership.workspaceId)
							.eq("userId", userAuth.id)
							.eq("moveView.cohortId", moveView?.cohortId)
							.eq("moveView.view", moveView?.view)
							.eq("isVisible", true);
						return args.folderId === files_ROOT_ID
							? visible.eq("parent.kind", "root")
							: visible.eq("parent.kind", "saved").eq("parent.id", args.folderId);
					})
					.first(),
			),
		);
		if (places.some((place) => place !== null)) {
			return true;
		}

		// A draft that moves, renames or deletes a saved item here has a hide in this folder.
		const hides = await Promise.all(
			views.map((moveView) =>
				ctx.db
					.query("files_pending_hides")
					.withIndex("by_org_ws_user_parent_name", (q) =>
						q
							.eq("organizationId", membership.organizationId)
							.eq("workspaceId", membership.workspaceId)
							.eq("userId", userAuth.id)
							.eq("moveView.cohortId", moveView?.cohortId)
							.eq("moveView.view", moveView?.view)
							.eq("parentId", args.folderId),
					)
					.first(),
			),
		);
		return hides.some((hide) => hide !== null);
	},
});

async function db_list_children(
	ctx: QueryCtx,
	args: {
		agentSource?: Infer<typeof ai_chat_workspaces_source_validator>;
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		visibilityUserId: Id<"users">;
		serviceAccountId?: Id<"access_control_service_accounts">;
		numItems: number;
		cursor: string | null;
		parentId?: Id<"files_nodes"> | typeof files_ROOT_ID;
		orderBy: "name" | "updatedAt";
		order?: "asc" | "desc";
	},
) {
	const allowed = await files_db_authorize_file_read(ctx, { ...args, userId: args.visibilityUserId });
	if (allowed._nay) return { items: [], continueCursor: args.cursor ?? "", isDone: true };
	const scope = files_db_resolve_scope(ctx, args.workspaceId);
	// A page can come back shorter than `numItems` once restricted nodes are dropped. The cursor still
	// points at the right place, so paging keeps working; only the page size varies.
	const filter_readable = (nodes: Doc<"files_nodes">[]) =>
		scope.kind === "volume"
			? nodes
			: access_control_db_filter_readable_file_nodes(ctx, {
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					userId: args.visibilityUserId,
					serviceAccountId: args.serviceAccountId,
					nodes,
				});

	if (args.parentId == null) {
		if (args.orderBy === "name") {
			return { items: [], continueCursor: args.cursor ?? "", isDone: true };
		}

		const result = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_archiveOperation_updatedAt", (q) =>
				q
					.eq("organizationId", args.organizationId)
					.eq("workspaceId", args.workspaceId)
					.eq("moveCohortId", undefined)
					.eq("archiveOperationId", null),
			)
			.order(args.order ?? "desc")
			.paginate({
				cursor: args.cursor,
				numItems: args.numItems,
			});

		return {
			items: (await filter_readable(result.page)).map((fileNode) => ({
				name: fileNode.name,
				kind: fileNode.kind,
				path: fileNode.path,
				updatedAt: fileNode.updatedAt,
				updatedBy: fileNode.updatedBy,
				contentType: fileNode.contentType,
			})),
			continueCursor: result.continueCursor,
			isDone: result.isDone,
		};
	}

	const parentId = args.parentId;
	if (parentId !== files_ROOT_ID) {
		const parent = await ctx.db.get("files_nodes", parentId);
		if (
			!parent ||
			parent.organizationId !== args.organizationId ||
			parent.workspaceId !== args.workspaceId ||
			parent.kind !== "folder"
		) {
			return { items: [], continueCursor: args.cursor ?? "", isDone: true };
		}
	}

	const result =
		args.orderBy === "name"
			? await ctx.db
					.query("files_nodes")
					.withIndex("by_organization_workspace_parent_archiveOperation_name", (q) =>
						q
							.eq("organizationId", args.organizationId)
							.eq("workspaceId", args.workspaceId)
							.eq("moveCohortId", undefined)
							.eq("parentId", parentId)
							.eq("archiveOperationId", null),
					)
					.order(args.order ?? "asc")
					.paginate({
						cursor: args.cursor,
						numItems: args.numItems,
					})
			: await ctx.db
					.query("files_nodes")
					.withIndex("by_organization_workspace_parent_archiveOperation_updatedAt", (q) =>
						q
							.eq("organizationId", args.organizationId)
							.eq("workspaceId", args.workspaceId)
							.eq("moveCohortId", undefined)
							.eq("parentId", parentId)
							.eq("archiveOperationId", null),
					)
					.order(args.order ?? "desc")
					.paginate({
						cursor: args.cursor,
						numItems: args.numItems,
					});

	return {
		items: (await filter_readable(result.page)).map((fileNode) => ({
			name: fileNode.name,
			kind: fileNode.kind,
			path: fileNode.path,
			updatedAt: fileNode.updatedAt,
			updatedBy: fileNode.updatedBy,
			contentType: fileNode.contentType,
		})),
		continueCursor: result.continueCursor,
		isDone: result.isDone,
	};
}

export const list_children = internalQuery({
	args: {
		agentSource: v.optional(ai_chat_workspaces_source_validator),
		organizationId: doc(app_convex_schema, "files_nodes").fields.organizationId,
		workspaceId: doc(app_convex_schema, "files_nodes").fields.workspaceId,
		/** Who is looking. Required so a new caller cannot forget it and list restricted nodes. */
		visibilityUserId: v.id("users"),
		serviceAccountId: v.optional(v.id("access_control_service_accounts")),
		numItems: v.number(),
		cursor: paginationOptsValidator.fields.cursor,
		parentId: v.optional(v.union(v.id("files_nodes"), v.literal(files_ROOT_ID))),
		orderBy: v.union(v.literal("name"), v.literal("updatedAt")),
		order: v.optional(v.union(v.literal("asc"), v.literal("desc"))),
	},
	returns: v.object({
		items: v.array(
			v.object({
				name: v.string(),
				kind: v.union(v.literal("folder"), v.literal("file")),
				path: v.string(),
				updatedAt: v.number(),
				updatedBy: doc(app_convex_schema, "files_nodes").fields.updatedBy,
				contentType: doc(app_convex_schema, "files_nodes").fields.contentType,
			}),
		),
		continueCursor: v.string(),
		isDone: v.boolean(),
	}),
	handler: async (ctx, args) => {
		return await db_list_children(ctx, args);
	},
});

export type files_nodes_list_children_Result =
	typeof list_children extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

const subtree_key_validator = v.object({
	value: v.string(),
	createdAt: v.number(),
	nodeId: v.string(),
});

export const list_subtree = internalQuery({
	args: {
		agentSource: v.optional(ai_chat_workspaces_source_validator),
		organizationId: doc(app_convex_schema, "files_nodes").fields.organizationId,
		workspaceId: doc(app_convex_schema, "files_nodes").fields.workspaceId,
		/** Who is looking. Required so a new caller cannot forget it and walk into a restricted folder. */
		visibilityUserId: v.id("users"),
		serviceAccountId: v.optional(v.id("access_control_service_accounts")),
		folderPath: v.string(),
		numItems: v.number(),
		cursor: paginationOptsValidator.fields.cursor,
		savedStream: v.optional(files_saved_stream_validator),
		seek: v.optional(
			v.object({
				lowerKey: v.union(subtree_key_validator, v.null()),
				upperKey: v.union(subtree_key_validator, v.null()),
				phase: v.number(),
			}),
		),
		order: v.optional(v.union(v.literal("asc"), v.literal("desc"))),
		kind: v.optional(doc(app_convex_schema, "files_nodes").fields.kind),
		lowercaseExtension: v.optional(v.string()),
		/** One `contentTypePrefixes` value of the public files list, like `image/` or `image/png`. */
		contentTypePrefix: v.optional(v.string()),
		minDepth: v.optional(v.number()),
		maxDepth: v.optional(v.number()),
	},
	returns: v.object({
		...paginationResultValidator(doc(app_convex_schema, "files_nodes")).fields,
		frontier: v.optional(v.union(subtree_key_validator, v.null())),
		phaseCount: v.optional(v.number()),
	}),
	handler: async (ctx, args) => {
		const authorized = await files_db_authorize_file_read(ctx, { ...args, userId: args.visibilityUserId });
		if (authorized._nay) return { page: [], continueCursor: args.cursor ?? "", isDone: true };
		const scope = files_db_resolve_scope(ctx, args.workspaceId);
		const saved = await files_saved_stream_db_create(ctx.db, args, args.savedStream);
		const lowercaseExtension = args.lowercaseExtension;
		const kind = args.kind;
		const contentTypeMatch =
			args.contentTypePrefix === undefined ? null : files_parse_content_type_prefix(args.contentTypePrefix);
		// The type indexes cover the whole subtree only. The public route refuses the other shapes first.
		if (
			args.contentTypePrefix !== undefined &&
			(contentTypeMatch === null || lowercaseExtension != null || args.maxDepth !== undefined)
		)
			throw convex_error({
				message: "list_subtree takes one content type family or exact type, on a whole subtree, without an extension.",
			});

		if ((lowercaseExtension != null || contentTypeMatch !== null) && kind === "folder") {
			return { page: [], continueCursor: args.cursor ?? "", isDone: true };
		}

		const normalizedPath = server_path_normalize(args.folderPath);
		const lowerBound = files_derive_tree_path_for_file_node(normalizedPath, "folder");
		const upperBound = path_tree_prefix_upper_bound(lowerBound);

		// Depth has three shapes, each one index range: the root row only (`maxDepth: 0`), the root row
		// plus direct children (`maxDepth: 1`, parent index), or the whole subtree. `minDepth: 1`
		// leaves the root row out. A depth filter on the subtree range would read every row under the
		// folder to find the few at one depth, so other depths are refused. Bash callers map their
		// depths with `map_find_depth` in `server/bash-find-command.ts`.
		const minDepth = args.minDepth ?? 0;
		if (
			(minDepth !== 0 && minDepth !== 1) ||
			(args.maxDepth !== undefined && args.maxDepth !== 0 && args.maxDepth !== 1) ||
			minDepth > (args.maxDepth ?? 1)
		)
			throw convex_error({
				message: "list_subtree takes minDepth 0 or 1, and maxDepth 0, 1 or none (the whole subtree).",
			});
		const directChildren = args.maxDepth !== undefined;
		const withRoot = minDepth === 0;

		let rootNode: Doc<"files_nodes"> | null = null;
		if (directChildren && normalizedPath !== "/") {
			rootNode = await files_db_get_visible_node_by_path(ctx, { ...args, path: normalizedPath });
			if (rootNode?.kind !== "folder") return { page: [], continueCursor: args.cursor ?? "", isDone: true };
		}
		const parentId = rootNode?._id ?? files_ROOT_ID;
		// The root row only when it matches the filter. The workspace root has no row.
		const rootRow =
			withRoot && rootNode !== null && (kind === undefined || kind === "folder") && lowercaseExtension === undefined
				? rootNode
				: null;
		const filter_readable = async (nodes: Doc<"files_nodes">[]) =>
			scope.kind === "volume"
				? nodes
				: await access_control_db_filter_readable_file_nodes(ctx, {
						organizationId: args.organizationId,
						workspaceId: args.workspaceId,
						userId: args.visibilityUserId,
						serviceAccountId: args.serviceAccountId,
						nodes,
					});

		if (args.maxDepth === 0) {
			return {
				page: rootRow && args.cursor === null ? await filter_readable([rootRow]) : [],
				continueCursor: "",
				isDone: true,
			};
		}

		const seek = args.seek;
		if (seek && (withRoot || !Number.isInteger(seek.phase) || seek.phase < 0)) {
			throw convex_invalid_cursor_error("Invalid saved list seek.");
		}
		for (const key of [seek?.lowerKey, seek?.upperKey]) {
			if (
				key &&
				!directChildren &&
				(compareValues(key.value, lowerBound) <= 0 || compareValues(key.value, upperBound) >= 0)
			) {
				throw convex_invalid_cursor_error("The saved list key is outside its folder.");
			}
		}
		const phases = files_index_range_phases({
			fields: [
				directChildren ? "name" : "treePath",
				...(args.savedStream?.kind === "cohort" ? ["nodeCreationTime", "nodeId"] : ["_creationTime", "_id"]),
			],
			order: args.order ?? "asc",
			start: seek?.lowerKey
				? [seek.lowerKey.value, seek.lowerKey.createdAt, seek.lowerKey.nodeId]
				: directChildren
					? []
					: [lowerBound],
			end: seek?.upperKey
				? [seek.upperKey.value, seek.upperKey.createdAt, seek.upperKey.nodeId]
				: directChildren
					? []
					: [upperBound],
			startInclusive: seek?.lowerKey ? false : withRoot,
			endInclusive: false,
		});
		const phase = phases[seek?.phase ?? 0];
		if (!phase) return { page: [], continueCursor: "", isDone: true, phaseCount: phases.length, frontier: null };
		const range = (q: IndexRange) => files_index_range_apply(q, phase);
		const query = (
			directChildren
				? lowercaseExtension != null
					? saved.queries.by_parent_archive_kind_ext_name((q) =>
							range(
								q
									.eq("parentId", parentId)
									.eq("archiveOperationId", null)
									.eq("kind", "file")
									.eq("lowercaseExtension", lowercaseExtension),
							),
						)
					: kind == null
						? saved.queries.by_parent_archive_name((q) =>
								range(q.eq("parentId", parentId).eq("archiveOperationId", null)),
							)
						: saved.queries.by_parent_archive_kind_name((q) =>
								range(q.eq("parentId", parentId).eq("archiveOperationId", null).eq("kind", kind)),
							)
				: lowercaseExtension != null
					? saved.queries.by_archive_kind_ext_tree((q) =>
							range(q.eq("archiveOperationId", null).eq("kind", "file").eq("lowercaseExtension", lowercaseExtension)),
						)
					: contentTypeMatch?.field === "contentTypeFamily"
						? saved.queries.by_archive_content_type_family_tree((q) =>
								range(q.eq("archiveOperationId", null).eq("contentTypeFamily", contentTypeMatch.value)),
							)
						: contentTypeMatch?.field === "contentTypeEssence"
							? saved.queries.by_archive_content_type_essence_tree((q) =>
									range(q.eq("archiveOperationId", null).eq("contentTypeEssence", contentTypeMatch.value)),
								)
							: kind == null
								? saved.queries.by_archive_tree((q) => range(q.eq("archiveOperationId", null)))
								: saved.queries.by_archive_kind_tree((q) => range(q.eq("archiveOperationId", null).eq("kind", kind)))
		).order(args.order ?? "asc");

		// The first page of direct children starts with the root row (the last page, in desc order). With
		// `numItems` 1 that page holds the root row and one child: a page of only the root row would need
		// a cursor for the start of the children, and Convex has no such cursor.
		const rootFirst = directChildren && rootRow !== null && args.cursor === null && args.order !== "desc";
		const result = await query.paginate({
			cursor: args.cursor,
			numItems: rootFirst ? Math.max(1, args.numItems - 1) : args.numItems,
		});
		const rootLast = directChildren && rootRow !== null && result.isDone && args.order === "desc";
		const nodes = [
			...(rootFirst && rootRow ? [rootRow] : []),
			...(await saved.read_nodes(result.page)),
			...(rootLast && rootRow ? [rootRow] : []),
		];

		// The access check can make a page shorter. The cursor still walks the whole subtree; only the
		// page size varies.
		const last = result.page.at(-1);
		const frontier = last
			? {
					value: directChildren ? last.name : last.treePath,
					createdAt: "nodeId" in last ? last.nodeCreationTime : last._creationTime,
					nodeId: "nodeId" in last ? last.nodeId : last._id,
				}
			: null;
		return {
			...result,
			page: await filter_readable(nodes),
			frontier,
			...(seek ? { phaseCount: phases.length } : {}),
		};
	},
});

export type files_nodes_list_subtree_Result =
	typeof list_subtree extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

// #endregion list

export const search_paths = internalQuery({
	args: {
		agentSource: v.optional(ai_chat_workspaces_source_validator),
		organizationId: doc(app_convex_schema, "files_nodes").fields.organizationId,
		workspaceId: doc(app_convex_schema, "files_nodes").fields.workspaceId,
		/** Who is looking. Required so a new caller cannot forget it and match a restricted path. */
		visibilityUserId: v.id("users"),
		serviceAccountId: v.optional(v.id("access_control_service_accounts")),
		pathQuery: v.string(),
		numItems: v.number(),
		cursor: paginationOptsValidator.fields.cursor,
		kind: v.optional(v.union(v.literal("folder"), v.literal("file"))),
		parentId: v.optional(v.union(v.id("files_nodes"), v.literal(files_ROOT_ID))),
		pathPrefix: v.optional(v.string()),
		minPathDepth: v.optional(v.number()),
	},
	returns: v.object({
		items: v.array(
			v.object({
				path: v.string(),
				kind: v.union(v.literal("folder"), v.literal("file")),
				updatedAt: v.number(),
			}),
		),
		continueCursor: v.string(),
		isDone: v.boolean(),
	}),
	handler: async (ctx, args) => {
		const authorized = await files_db_authorize_file_read(ctx, { ...args, userId: args.visibilityUserId });
		if (authorized._nay) return { items: [], continueCursor: args.cursor ?? "", isDone: true };
		const scope = files_db_resolve_scope(ctx, args.workspaceId);
		if (args.parentId != null && args.parentId !== files_ROOT_ID) {
			const parent = await ctx.db.get("files_nodes", args.parentId);
			if (
				!parent ||
				parent.organizationId !== args.organizationId ||
				parent.workspaceId !== args.workspaceId ||
				parent.kind !== "folder"
			) {
				return { items: [], continueCursor: args.cursor ?? "", isDone: true };
			}
		}

		const pathPrefixFilter =
			args.pathPrefix == null || args.pathPrefix === "/"
				? null
				: files_derive_tree_path_for_file_node(args.pathPrefix, "folder");

		let searchQuery = ctx.db.query("files_nodes").withSearchIndex("search_path", (q) => {
			const base = q
				.search("path", args.pathQuery)
				.eq("organizationId", args.organizationId)
				.eq("workspaceId", args.workspaceId)
				.eq("archiveOperationId", null);

			if (args.kind != null && args.parentId != null) {
				return base.eq("kind", args.kind).eq("parentId", args.parentId);
			}
			if (args.kind != null) {
				return base.eq("kind", args.kind);
			}
			if (args.parentId != null) {
				return base.eq("parentId", args.parentId);
			}
			return base;
		});
		// Subtree scope rides a post-index `.filter()` (search filterFields are equality-only, so a
		// prefix range cannot ride the index): numItems counts docs that pass the filter, so pages
		// fill with descendants instead of thinning, and the tree prefix upper bound keeps a
		// sibling-prefix folder like /foo-bar out of a /foo scope.
		if (pathPrefixFilter != null) {
			searchQuery = searchQuery.filter((q) =>
				q.and(
					q.gte(q.field("treePath"), pathPrefixFilter),
					q.lt(q.field("treePath"), path_tree_prefix_upper_bound(pathPrefixFilter)),
				),
			);
		}

		// The depth floor also runs after the search index. It excludes the starting
		// folder for scoped `find -mindepth 1 --path-query ...`.
		if (args.minPathDepth != null) {
			const minPathDepth = args.minPathDepth;
			searchQuery = searchQuery.filter((q) => q.gte(q.field("pathDepth"), minPathDepth));
		}

		const result = await searchQuery.paginate({
			cursor: args.cursor,
			numItems: args.numItems,
		});

		const readable =
			scope.kind === "volume"
				? result.page
				: await access_control_db_filter_readable_file_nodes(ctx, {
						organizationId: args.organizationId,
						workspaceId: args.workspaceId,
						userId: args.visibilityUserId,
						serviceAccountId: args.serviceAccountId,
						nodes: result.page,
					});

		return {
			items: readable.map((fileNode) => ({
				path: fileNode.path,
				kind: fileNode.kind,
				updatedAt: fileNode.updatedAt,
			})),
			continueCursor: result.continueCursor,
			isDone: result.isDone,
		};
	},
});

export type files_nodes_search_paths_Result =
	typeof search_paths extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * Read the saved content version without loading snapshots or the update log. Content error
 * markers do not prevent a move or archive. Callers that read bytes check those markers.
 */
export async function files_nodes_db_get_content_version(
	ctx: QueryCtx | MutationCtx,
	fileNode: Doc<"files_nodes">,
): Promise<Infer<typeof files_content_version_validator> | null> {
	if (fileNode.kind !== "file" || fileNode.assetId === null || fileNode.contentType === null) {
		return null;
	}

	if (fileNode.collaborationEnabled !== true) {
		return {
			kind: "asset",
			assetId: fileNode.assetId,
			contentType: fileNode.contentType,
			textKind: fileNode.textKind,
			collaborationEnabled: fileNode.collaborationEnabled,
		};
	}

	if (fileNode.textKind === null || fileNode.yjsLastSequenceId === null) {
		const errorMessage = "fileNode.textKind or fileNode.yjsLastSequenceId is not set";
		const errorData = {
			nodeId: fileNode._id,
			textKind: fileNode.textKind,
			yjsLastSequenceId: fileNode.yjsLastSequenceId,
		};
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}

	const sequenceDoc = await files_saved_placement_db_get_sequence(ctx.db, fileNode);
	if (
		!sequenceDoc ||
		sequenceDoc.organizationId !== fileNode.organizationId ||
		sequenceDoc.workspaceId !== fileNode.workspaceId ||
		sequenceDoc.fileNodeId !== fileNode._id
	) {
		const errorMessage =
			"fileNode.yjsLastSequenceId points to a missing or mismatched files_yjs_docs_last_sequences doc";
		const errorData = { nodeId: fileNode._id, yjsLastSequenceId: fileNode.yjsLastSequenceId, sequenceDoc };
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}

	return {
		kind: "yjs",
		lastSequenceId: sequenceDoc._id,
		lineageGeneration: sequenceDoc.lineageGeneration,
		sequence: sequenceDoc.lastSequence,
		contentType: fileNode.contentType,
		textKind: fileNode.textKind,
		collaborationEnabled: true,
	};
}

export async function db_get_file_content_materialization_db_state(
	ctx: QueryCtx,
	args: { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces">; nodeId: Id<"files_nodes"> },
) {
	const header = await db_get_file_content_materialization_header(ctx, args);
	if (!header) {
		return null;
	}

	const yjsUpdatesDocs: Doc<"files_yjs_updates">[] = [];
	for await (const update of files_saved_content_db_yjs_updates(ctx.db, {
		...args,
		throughSequence: header.yjsLastSequenceDoc.lastSequence,
	}))
		yjsUpdatesDocs.push(update);

	return {
		fileNode: header.fileNode,
		yjsSnapshotDoc: header.yjsSnapshotDoc,
		yjsLastSequenceDoc: header.yjsLastSequenceDoc,
		yjsUpdatesDocs,
		asset: header.asset,
		yjsSnapshotAsset: header.yjsSnapshotAsset,
	};
}

/**
 * The header half of the materialization state: every doc except the update log. The
 * materialization action reads the log one update doc at a time through
 * `get_file_next_yjs_update` instead of collecting it, because one allowed doc may itself be
 * 930,000 bytes.
 */
async function db_get_file_content_materialization_header(
	ctx: QueryCtx,
	args: { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces">; nodeId: Id<"files_nodes"> },
) {
	const fileNode = await files_saved_placement_db_get_node(ctx.db, args.nodeId);
	if (!fileNode || fileNode.organizationId !== args.organizationId || fileNode.workspaceId !== args.workspaceId) {
		return null;
	}

	if (!files_node_has_editable_yjs_state(fileNode)) {
		return null;
	}

	const [asset, yjsSnapshotDoc, yjsLastSequenceDoc] = await Promise.all([
		ctx.db.get("files_r2_assets", fileNode.assetId),
		ctx.db.get("files_yjs_snapshots", fileNode.yjsSnapshotId),
		files_saved_placement_db_get_sequence(ctx.db, fileNode),
	]);

	// Do not check the asset kind here. node.assetId always holds the file's current bytes, but
	// the kind can vary: usually the newest version snapshot, or an old content row without an
	// r2Key (old data) until a materialization points the node at a fresh snapshot.
	if (!asset || asset.organizationId !== args.organizationId || asset.workspaceId !== args.workspaceId) {
		const errorMessage = "fileNode.assetId points to a missing or mismatched files_r2_assets doc";
		const errorData = {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId: args.nodeId,
			assetId: fileNode.assetId,
			asset,
		};
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}

	if (
		!yjsSnapshotDoc ||
		yjsSnapshotDoc.organizationId !== args.organizationId ||
		yjsSnapshotDoc.workspaceId !== args.workspaceId ||
		yjsSnapshotDoc.fileNodeId !== args.nodeId
	) {
		const errorMessage = "fileNode.yjsSnapshotId points to a missing or mismatched files_yjs_snapshots doc";
		const errorData = {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId: args.nodeId,
			yjsSnapshotId: fileNode.yjsSnapshotId,
			yjsSnapshotDoc,
		};
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}

	if (
		!yjsLastSequenceDoc ||
		yjsLastSequenceDoc.organizationId !== args.organizationId ||
		yjsLastSequenceDoc.workspaceId !== args.workspaceId ||
		yjsLastSequenceDoc.fileNodeId !== args.nodeId
	) {
		const errorMessage =
			"fileNode.yjsLastSequenceId points to a missing or mismatched files_yjs_docs_last_sequences doc";
		const errorData = {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId: args.nodeId,
			yjsLastSequenceId: fileNode.yjsLastSequenceId,
			yjsLastSequenceDoc,
		};
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}

	const yjsSnapshotAsset = await ctx.db.get("files_r2_assets", yjsSnapshotDoc.assetId);
	if (
		!yjsSnapshotAsset ||
		yjsSnapshotAsset.organizationId !== args.organizationId ||
		yjsSnapshotAsset.workspaceId !== args.workspaceId ||
		yjsSnapshotAsset.kind !== "yjs_snapshot"
	) {
		const errorMessage = "yjsSnapshotDoc.assetId points to a missing or mismatched files_r2_assets doc";
		const errorData = {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId: args.nodeId,
			assetId: yjsSnapshotDoc.assetId,
		};
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}

	return {
		fileNode,
		yjsSnapshotDoc,
		yjsLastSequenceDoc,
		asset,
		yjsSnapshotAsset,
	};
}

export const get_file_content_materialization_state = internalQuery({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		nodeId: v.id("files_nodes"),
		userId: v.optional(v.id("users")),
		serviceAccountId: v.optional(v.id("access_control_service_accounts")),
	},
	returns: v.union(file_content_materialization_state_validator, v.null()),
	handler: async (ctx, args) => {
		if (args.userId !== undefined || args.serviceAccountId !== undefined) {
			const node = await files_saved_placement_db_get_node(ctx.db, args.nodeId);
			if (!node || args.userId === undefined) {
				return null;
			}
			const [readable] = await access_control_db_filter_readable_file_nodes(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				userId: args.userId,
				serviceAccountId: args.serviceAccountId,
				nodes: [node],
			});
			if (!readable) {
				return null;
			}
		}
		return await db_get_file_content_materialization_db_state(ctx, args);
	},
});

export type get_file_content_materialization_state_Result =
	typeof get_file_content_materialization_state extends RegisteredQuery<
		infer _Visibility,
		infer _Args,
		infer ReturnValue
	>
		? Awaited<ReturnValue>
		: never;

export const get_file_content_materialization_header = internalQuery({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		nodeId: v.id("files_nodes"),
		targetSequence: v.number(),
	},
	returns: v.union(file_content_materialization_header_validator, v.null()),
	handler: async (ctx, args) => {
		const header = await db_get_file_content_materialization_header(ctx, args);
		if (!header) {
			return null;
		}

		return {
			...header,
			throughSequence: args.targetSequence,
		};
	},
});

export type get_file_content_materialization_header_Result =
	typeof get_file_content_materialization_header extends RegisteredQuery<
		infer _Visibility,
		infer _Args,
		infer ReturnValue
	>
		? Awaited<ReturnValue>
		: never;

/**
 * Read exactly one update doc inside `(afterSequence, throughSequence]`. One doc is the only
 * safe page size because one allowed doc may itself be 930,000 bytes. The caller passes the
 * frozen `throughSequence` from the materialization header, so a concurrent `S+1` push never
 * changes what this run reads. A gap or duplicate in the sequence order is refused instead of
 * silently skipped: reconstruction from a broken log would commit wrong content.
 */
export const get_file_next_yjs_update = internalQuery({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		nodeId: v.id("files_nodes"),
		expectedLastSequenceId: v.id("files_yjs_docs_last_sequences"),
		expectedLineageGeneration: v.number(),
		afterSequence: v.number(),
		throughSequence: v.number(),
	},
	returns: v.union(
		v.object({ kind: v.literal("row"), row: doc(app_convex_schema, "files_yjs_updates") }),
		v.object({ kind: v.literal("done") }),
		v.object({ kind: v.literal("gap"), expectedSequence: v.number(), foundSequence: v.number() }),
	),
	handler: async (ctx, args) => {
		const node = await files_saved_placement_db_get_node(ctx.db, args.nodeId);
		if (!node || node.organizationId !== args.organizationId || node.workspaceId !== args.workspaceId)
			return { kind: "done" as const };
		const head = await files_saved_placement_db_get_sequence(ctx.db, node);
		if (head?._id !== args.expectedLastSequenceId || head.lineageGeneration !== args.expectedLineageGeneration)
			return { kind: "done" as const };
		const rows: Doc<"files_yjs_updates">[] = [];
		for await (const update of files_saved_content_db_yjs_updates(ctx.db, args)) {
			rows.push(update);
			if (rows.length === 2) break;
		}

		const row = rows[0];
		if (!row) {
			return { kind: "done" as const };
		}
		if (row.sequence !== args.afterSequence + 1) {
			return { kind: "gap" as const, expectedSequence: args.afterSequence + 1, foundSequence: row.sequence };
		}
		if (rows[1] && rows[1].sequence === row.sequence) {
			return { kind: "gap" as const, expectedSequence: row.sequence + 1, foundSequence: rows[1].sequence };
		}

		return { kind: "row" as const, row };
	},
});

export type get_file_next_yjs_update_Result =
	typeof get_file_next_yjs_update extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

// #region read file

// Bound pages by lines and bytes so a complete page fits in a chat tool result.
// Export the line cap for the Bash tool prompt.
export const files_READ_RANGE_MAX_LINES = 500;
const files_READ_RANGE_MAX_BYTES = 64 * 1024;

/**
 * Size bound (UTF-16 code units) for one chunk-range scan. The line-based stop conditions bound
 * ordinary files, but every piece of a mid-line-split long line carries the same line number, so
 * a single huge line would otherwise be collected whole into one query result. A scan that trips
 * this bound reports "not usable" and the caller falls back to its byte-window read.
 */
const files_READ_RANGE_MAX_SCAN_CHARS = 256_000;
// A single very long line (legitimately minified content, or a deliberate attempt to bypass
// line-based limits) is truncated for display at this many characters, with a marker, so one
// line cannot dominate the bounded output. Generous enough not to clip normal prose lines.
const files_READ_MAX_LINE_CHARS = 8000;

/**
 * Truncate one display line that is pathologically long, appending a clear marker so the
 * agent understands the line continues (rather than being silently cut). Returns the line
 * unchanged when it is within the cap.
 */
function files_truncate_long_display_line(line: string) {
	if (line.length <= files_READ_MAX_LINE_CHARS) {
		return line;
	}
	return `${line.slice(0, files_READ_MAX_LINE_CHARS)} …[line truncated to ${files_READ_MAX_LINE_CHARS} chars — the full line is ${line.length}+ chars]`;
}

/**
 * Returns lines [`startLine`, `startLine`+`maxLines`) of `content` (1-based, each line with
 * its trailing newline), plus how many lines were returned and whether more lines follow
 * within `content`. `content` may be a leading window of a larger file. Over-long lines are
 * truncated for display (with a marker) so a single huge line cannot flood the output.
 */
export function files_line_range_from_text(args: { content: string; startLine: number; maxLines: number }) {
	const { content, startLine, maxLines } = args;

	if (maxLines <= 0 || content.length === 0) {
		return { content: "", linesReturned: 0, moreLines: false };
	}
	const hasTrailingNewline = content.endsWith("\n");
	const split = content.split("\n");
	// A trailing newline yields an empty final element that is not a real line; drop it.
	const lines = hasTrailingNewline ? split.slice(0, -1) : split;
	const start = Math.max(0, startLine - 1);
	const slice: string[] = [];
	let bytes = 0;
	for (const line of lines.slice(start, start + maxLines)) {
		const displayed = files_truncate_long_display_line(line);
		const lineBytes = files_get_utf8_byte_size(displayed) + 1;
		if (bytes + lineBytes > files_READ_RANGE_MAX_BYTES) break;
		slice.push(displayed);
		bytes += lineBytes;
	}
	const moreLines = start + slice.length < lines.length;
	const out = slice.length > 0 ? `${slice.join("\n")}\n` : "";
	return { content: out, linesReturned: slice.length, moreLines };
}

/** Returns the last `maxLines` lines of `content` (over-long lines truncated for display). */
export function files_tail_lines_from_text(content: string, maxLines: number) {
	if (maxLines <= 0 || content.length === 0) {
		return { content: "", moreAbove: false };
	}
	const hasTrailingNewline = content.endsWith("\n");
	const split = content.split("\n");
	const lines = hasTrailingNewline ? split.slice(0, -1) : split;
	const slice: string[] = [];
	let bytes = 0;
	for (let index = lines.length - 1; index >= Math.max(0, lines.length - maxLines); index--) {
		const displayed = files_truncate_long_display_line(lines[index]);
		const lineBytes = files_get_utf8_byte_size(displayed) + 1;
		if (bytes + lineBytes > files_READ_RANGE_MAX_BYTES) break;
		slice.push(displayed);
		bytes += lineBytes;
	}
	slice.reverse();
	// `moreAbove` is true when the file (or this window) holds lines before the returned tail, so a
	// `tail` view can honestly signal it is partial rather than implying it shows the whole file.
	return { content: slice.length > 0 ? `${slice.join("\n")}\n` : "", moreAbove: lines.length > slice.length };
}

/**
 * Resolve the committed-chunk read target for a path, or null when the chunk fast path must NOT
 * be used: a pending user overlay (not yet committed), a stale snapshot (latest edits not yet
 * committed — chunks would disagree with `cat`), an explicit pendingUpdateId (caller wants a
 * pending view), or a non-file / non-editable node. `byteSize` is the committed content byte size.
 */
async function db_resolve_committed_chunk_source(
	ctx: QueryCtx,
	args: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		userId: Id<"users">;
		path: string;
		pendingUpdateId?: Id<"files_pending_updates">;
		overlayUserId?: Id<"users">;
	},
): Promise<{
	nodeId: Id<"files_nodes">;
	byteSize: number;
	counts: { lineCount: number; wordCount: number; charCount: number } | null;
} | null> {
	// An explicit pending view is requested → committed chunks are not what the caller wants.
	if (args.pendingUpdateId || args.path === "/") return null;
	const scope = files_db_resolve_scope(ctx, args.workspaceId);

	let fileNode: Doc<"files_nodes"> | null;
	if (
		args.overlayUserId &&
		!organizations_is_global_organization_id(args.organizationId) &&
		scope.kind === "workspace"
	) {
		if (args.overlayUserId !== args.userId) return null;
		const reader = await files_visible_db_create_reader(ctx, {
			organizationId: args.organizationId,
			workspaceId: scope.workspaceId,
			userId: args.userId,
			readLimit: 2048,
		});
		const entry = await reader.resolvePath(args.path);
		if (reader.exhausted) throw convex_error({ message: "File path lookup exceeded its read limit." });
		fileNode = entry?.kind === "saved" ? entry.node : null;
	} else {
		fileNode = await files_db_get_visible_node_by_path(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			path: args.path,
		});
	}
	if (fileNode == null) return null;
	if (fileNode.kind !== "file") return null;

	// This reader hands out no text, but `wc` reports exact line, word and byte counts, which is
	// plenty to learn from a file somebody was not given.
	const readable =
		scope.kind === "volume" ||
		(await access_control_db_can_act_on_file_node(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			fileNode,
			permission: "content.read",
		}));
	if (!readable) return null;

	// Exact wc counts from the linked file_stats doc (read O(1) by id — the back-ref the node holds).
	// null when unlinked (old file not yet migrated) or flagged unprocessable (-1), so the stats
	// query falls back to the windowed estimate. Shared by both scopes.
	const resolve_counts = async () => {
		const stats = fileNode.statsId ? await ctx.db.get("file_stats", fileNode.statsId) : null;
		return stats && stats.lineCount >= 0 && stats.wordCount >= 0 && stats.charCount >= 0
			? { lineCount: stats.lineCount, wordCount: stats.wordCount, charCount: stats.charCount }
			: null;
	};

	// External (reserved) scope: no Yjs/pending/materialization. Committed chunks are addressed by
	// node id alone; byte size comes from the linked R2 content asset.
	if (organizations_is_global_organization_id(args.organizationId) || scope.kind !== "workspace") {
		const asset = fileNode.assetId ? await ctx.db.get("files_r2_assets", fileNode.assetId) : null;
		const byteSize =
			asset &&
			asset.organizationId === args.organizationId &&
			asset.workspaceId === args.workspaceId &&
			asset.kind === "content"
				? asset.size
				: 0;
		return { nodeId: fileNode._id, byteSize, counts: await resolve_counts() };
	}

	if (!files_node_has_editable_text_content(fileNode)) return null;

	// Tenant scope (the guards above narrowed both ids): bind them so the narrowing reaches the
	// `withIndex` callback — TS drops property narrowing at closure boundaries.
	const organizationId = args.organizationId;
	const workspaceId = scope.workspaceId;

	// The user's unstaged branch is not materialized into chunks; read it via the in-memory path.
	// This holds in both editable modes: a file with collaboration off carries proposals too. A
	// move-only doc has no text of its own, and a stale proposal's text is not served, so the
	// committed chunks below answer for both, the same way the read doors fall through.
	const pendingSource = await ctx.db
		.query("files_pending_updates")
		.withIndex("by_organization_workspace_user_target", (q) =>
			q
				.eq("organizationId", organizationId)
				.eq("workspaceId", workspaceId)
				.eq("userId", args.userId)
				.eq("target.kind", "saved")
				.eq("target.id", fileNode._id),
		)
		.first();
	const pendingUpdate = pendingSource ? await files_saved_placement_db_get_proposal(ctx.db, pendingSource._id) : null;
	if (
		pendingUpdate != null &&
		files_pending_update_has_pending_chunks(pendingUpdate) &&
		!files_pending_update_content_is_stale(pendingUpdate, fileNode)
	) {
		return null;
	}

	if (!files_node_has_editable_yjs_state(fileNode)) {
		// A non-collaborative file has no Yjs document and so no materialization state. Its
		// committed chunks are always current, and its byte size comes from the linked content
		// asset, the same way the reserved scope above reads it. Do not check the asset kind:
		// `node.assetId` always holds the file's current bytes but the kind varies, as
		// `db_get_file_content_materialization_header` explains.
		const asset = await ctx.db.get("files_r2_assets", fileNode.assetId);
		const byteSize =
			asset && asset.organizationId === args.organizationId && asset.workspaceId === args.workspaceId ? asset.size : 0;
		return { nodeId: fileNode._id, byteSize, counts: await resolve_counts() };
	}

	const materializationState = await db_get_file_content_materialization_db_state(ctx, {
		organizationId,
		workspaceId,
		nodeId: fileNode._id,
	});
	if (!materializationState) return null;
	// Stale: edits exist beyond the materialized snapshot, so chunks are behind the committed view.
	if (materializationState.yjsLastSequenceDoc.lastSequence > materializationState.yjsSnapshotDoc.sequence) return null;

	return {
		nodeId: fileNode._id,
		byteSize: materializationState.asset.size,
		counts: await resolve_counts(),
	};
}

/**
 * Concatenate chunks (given in ascending chunkIndex order) into the exact source substring they
 * span. Returns null if the chunks are not contiguous (each startIndex must equal the previous
 * endIndex) — a safety check so a materialization anomaly falls back rather than returning text
 * with a hidden gap.
 */
export function files_merge_contiguous_chunks(
	chunks: Array<{ startIndex: number; endIndex: number; textChunk: string }>,
): string | null {
	let out = "";
	let prevEnd: number | null = null;
	for (const chunk of chunks) {
		if (prevEnd !== null && chunk.startIndex !== prevEnd) return null;
		out += chunk.textChunk;
		prevEnd = chunk.endIndex;
	}
	return out;
}

async function files_read_prefix_from_ordered_chunks(
	chunks: AsyncIterable<{ startIndex: number; endIndex: number; textChunk: string }>,
	maxBytes: number,
) {
	let content = "";
	let endIndex = 0;
	let hasChunks = false;
	for await (const chunk of chunks) {
		hasChunks = true;
		if (chunk.startIndex !== endIndex) return null;
		content += chunk.textChunk;
		endIndex = chunk.endIndex;
		const bytes = new TextEncoder().encode(content);
		if (bytes.byteLength > maxBytes) {
			// Streaming decode drops an unfinished UTF-8 character at the byte boundary.
			return {
				hasChunks,
				content: new TextDecoder().decode(bytes.subarray(0, maxBytes), { stream: true }),
				moreLines: true,
			};
		}
	}
	return { hasChunks, content, moreLines: false };
}

/**
 * Read a forward line window from chunks that are already ordered by their line range.
 *
 * The caller chooses the source query: pending update chunks or committed snapshot chunks.
 * This helper only keeps the chunks that overlap the requested lines, verifies they form
 * one contiguous text span, and then slices the merged text with the same line helper used
 * by action fallbacks.
 */
async function files_read_forward_line_range_from_ordered_chunks(
	chunks: AsyncIterable<{
		startIndex: number;
		endIndex: number;
		lineStart: number;
		lineEnd: number;
		textChunk: string;
	}>,
	args: { startLine: number; maxLines: number },
) {
	const startLine = Math.max(1, Math.trunc(args.startLine));
	const maxLines = Math.max(1, Math.min(files_READ_RANGE_MAX_LINES, Math.trunc(args.maxLines)));
	const endLine = startLine + maxLines - 1;
	const overlapping: Array<{
		startIndex: number;
		endIndex: number;
		lineStart: number;
		lineEnd: number;
		textChunk: string;
	}> = [];
	let hasChunks = false;
	let sawBeyond = false;
	let stoppedForSize = false;
	let overlappingLength = 0;

	for await (const chunk of chunks) {
		hasChunks = true;

		// The index may start before the requested line when the first returned
		// chunk spans across it. Skip anything that still ends too early.
		if (chunk.lineEnd < startLine) {
			continue;
		}

		// Once a chunk starts after the requested window, every later ordered
		// chunk is also beyond it. Stop so line reads do not scan the whole file.
		if (chunk.lineStart > endLine) {
			sawBeyond = true;
			break;
		}

		// Bound the scan by size as well as by lines. Every piece of a mid-line-split long line
		// reports that one line's number, so the line-based stop above can never fire inside it
		// and `head -n 5 huge.json` would otherwise buffer every chunk of the file into one
		// query. Give up instead; the caller falls back to its bounded byte-window read.
		overlappingLength += chunk.textChunk.length;
		if (overlappingLength > files_READ_RANGE_MAX_SCAN_CHARS) {
			return null;
		}
		overlapping.push(chunk);
		if (overlappingLength >= files_READ_RANGE_MAX_BYTES && chunk.lineEnd > startLine) {
			stoppedForSize = true;
			break;
		}
	}

	if (overlapping.length === 0) {
		return { hasChunks, content: "", moreLines: sawBeyond };
	}

	let merged = files_merge_contiguous_chunks(overlapping);
	if (merged == null) return null;
	// A size-limited scan may end inside a line. Leave that line for the next page.
	if (stoppedForSize && !merged.endsWith("\n")) {
		merged = merged.slice(0, merged.lastIndexOf("\n") + 1);
	}
	const baseLine = overlapping[0]!.lineStart;
	// The merged text begins at baseLine, so translate the document line number
	// into the merged-string line number before slicing.
	const range = files_line_range_from_text({ content: merged, startLine: startLine - baseLine + 1, maxLines });
	return { hasChunks, content: range.content, moreLines: range.moreLines || sawBeyond || stoppedForSize };
}

/**
 * Read a line range (or the trailing lines) of committed, up-to-date content directly from
 * materialized chunks. Returns { usable: false } when the content is not committed-current (the
 * action then falls back to the in-memory / windowed path). For a forward range it seeks the
 * chunks overlapping [startLine, startLine+maxLines) via the lineEnd index; for `fromEnd` it walks
 * chunks from the end until it has enough trailing lines. Works at any depth — no byte window.
 */
export const read_committed_file_chunks_line_range = internalQuery({
	args: {
		agentSource: v.optional(ai_chat_workspaces_source_validator),
		organizationId: doc(app_convex_schema, "files_nodes").fields.organizationId,
		workspaceId: doc(app_convex_schema, "files_nodes").fields.workspaceId,
		userId: v.id("users"),
		path: v.string(),
		startLine: v.number(),
		maxLines: v.number(),
		fromEnd: v.boolean(),
		pendingUpdateId: v.optional(v.id("files_pending_updates")),
		/** When set, resolve `path` through this user's pending path overlay (their pending moves). */
		overlayUserId: v.optional(v.id("users")),
	},
	returns: v.union(
		v.object({ usable: v.literal(false) }),
		v.object({
			usable: v.literal(true),
			nodeId: v.id("files_nodes"),
			content: v.string(),
			moreLines: v.boolean(),
		}),
	),
	handler: async (ctx, args) => {
		const authorized = await files_db_authorize_file_read(ctx, args);
		if (authorized._nay) return { usable: false as const };
		const source = await db_resolve_committed_chunk_source(ctx, args);
		if (!source) return { usable: false as const };
		const maxLines = Math.max(1, Math.min(files_READ_RANGE_MAX_LINES, Math.trunc(args.maxLines)));

		if (args.fromEnd) {
			// tail: stream chunks from the end (descending) only until they cover maxLines distinct
			// lines, then reorder ascending and slice the last maxLines. The trailing chunks are
			// consecutive (so contiguous), and reading just enough of them avoids pulling the whole file.
			const tailChunks: Array<Doc<"files_text_chunks">> = [];
			let lastLineEnd: number | null = null;
			let tailChunksLength = 0;
			for await (const chunk of files_saved_content_db_text_chunks(ctx.db, {
				...args,
				nodeId: source.nodeId,
				pendingUpdateId: undefined,
				startLine: undefined,
				order: "desc",
			})) {
				if (lastLineEnd === null) lastLineEnd = chunk.lineEnd; // file's last line (first iterated, desc)
				// Bound the walk by size as well as by lines: every piece of a mid-line-split long
				// line shares one line number, so the distinct-line stop below can never fire inside
				// it and `tail` on that file would otherwise buffer every chunk. Fall back instead.
				tailChunksLength += chunk.textChunk.length;
				if (tailChunksLength > files_READ_RANGE_MAX_SCAN_CHARS) {
					return { usable: false as const };
				}
				tailChunks.push(chunk);
				// Distinct lines covered so far = lastLine - earliestStart + 1 (contiguous chunks share at
				// most a boundary line, so this counts distinct lines exactly, not a summed over-count).
				if (lastLineEnd - chunk.lineStart + 1 >= maxLines) break;
			}
			if (tailChunks.length === 0) {
				// A non-empty committed file must have chunks; if absent it is not yet materialized.
				if (source.byteSize > 0) return { usable: false as const };
				return { usable: true as const, nodeId: source.nodeId, content: "", moreLines: false };
			}
			tailChunks.reverse(); // desc → asc (document order)
			const merged = files_merge_contiguous_chunks(tailChunks);
			if (merged == null) return { usable: false as const };
			const tail = files_tail_lines_from_text(merged, maxLines);
			// For `fromEnd`, `moreLines` means "lines precede this tail". `lineEnd` is 0-based, so the
			// file has `lastLineEnd + 1` lines; the tail is partial iff that total exceeds maxLines, i.e.
			// `lastLineEnd >= maxLines`. (Using the file's true last line, not the merged-suffix length,
			// which can equal maxLines on a chunk boundary while earlier lines still exist.)
			const moreLines = tail.moreAbove || (lastLineEnd ?? 0) >= maxLines;
			return { usable: true as const, nodeId: source.nodeId, content: tail.content, moreLines };
		}

		// Seek to the first chunk whose lineEnd >= startLine (which contains the start of line
		// `startLine`), then stream forward in chunkIndex order (the index's trailing chunkIndex column
		// orders same-lineEnd ties), stopping at the first chunk that starts past endLine. lineStart is
		// non-decreasing in chunkIndex, so that first beyond-chunk means every later chunk is beyond too
		// — we read only the chunks overlapping the range, never the whole file, regardless of depth.
		const range = await files_read_forward_line_range_from_ordered_chunks(
			files_saved_content_db_text_chunks(ctx.db, {
				...args,
				nodeId: source.nodeId,
				pendingUpdateId: undefined,
				startLine: Math.max(1, Math.trunc(args.startLine)),
			}),
			{ startLine: args.startLine, maxLines },
		);
		if (range == null) return { usable: false as const };
		if (!range.hasChunks) {
			// No chunk ends at/after startLine: either startLine is past EOF (a valid empty page on a
			// materialized file) or the file is not materialized (fall back).
			const { value: anyChunk } = await files_saved_content_db_text_chunks(ctx.db, {
				...args,
				nodeId: source.nodeId,
				pendingUpdateId: undefined,
				startLine: undefined,
			}).next();
			if (anyChunk) return { usable: true as const, nodeId: source.nodeId, content: "", moreLines: false };
			return source.byteSize > 0
				? { usable: false as const }
				: { usable: true as const, nodeId: source.nodeId, content: "", moreLines: false };
		}
		return { usable: true as const, nodeId: source.nodeId, content: range.content, moreLines: range.moreLines };
	},
});

export type files_nodes_read_committed_file_chunks_line_range_Result =
	typeof read_committed_file_chunks_line_range extends RegisteredQuery<
		infer _Visibility,
		infer _Args,
		infer ReturnValue
	>
		? Awaited<ReturnValue>
		: never;

/**
 * Read app-file content directly from chunk tables.
 *
 * Pending update chunks win because they are the user's current view of the file.
 * When there is no pending update, the query reads committed text chunks only if
 * the materialized snapshot is current. Returning null means chunks cannot serve this
 * request; callers decide whether to treat that as no content or use an action fallback.
 */
export const read_file_content_from_chunks = internalQuery({
	args: {
		agentSource: v.optional(ai_chat_workspaces_source_validator),
		organizationId: doc(app_convex_schema, "files_nodes").fields.organizationId,
		workspaceId: doc(app_convex_schema, "files_nodes").fields.workspaceId,
		userId: v.id("users"),
		serviceAccountId: v.optional(v.id("access_control_service_accounts")),
		path: v.string(),
		pendingUpdateId: v.optional(v.id("files_pending_updates")),
		/** When set, resolve `path` through this user's pending path overlay (their pending moves). */
		overlayUserId: v.optional(v.id("users")),
		/**
		 * Skip the lookup of this user's pending doc, so the read serves the committed chunks. An
		 * explicit `pendingUpdateId` and the `overlayUserId` path overlay still apply.
		 */
		committedOnly: v.optional(v.boolean()),
		mode: v.union(
			v.object({
				kind: v.literal("prefix"),
				maxBytes: v.number(),
			}),
			v.object({
				kind: v.literal("full"),
				maxBytes: v.number(),
			}),
			v.object({
				kind: v.literal("lines"),
				startLine: v.number(),
				maxLines: v.number(),
			}),
		),
	},
	returns: v.union(
		v.object({
			target: files_pending_target_validator,
			content: v.string(),
			moreLines: v.boolean(),
			pendingUpdateId: v.union(v.id("files_pending_updates"), v.null()),
			pendingUpdateBaseStateId: v.optional(v.id("files_pending_update_yjs_states")),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		// Translate the path through the overlay first; the per-user pending-content logic
		// below then runs on the resolved node, so content-plus-move docs compose.
		const entry = (await ctx.runQuery(internal.files_nodes.get_visible_entry_by_path, {
			agentSource: args.agentSource,
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			path: args.path,
			visibilityUserId: args.userId,
			serviceAccountId: args.serviceAccountId,
			overlayUserId: args.overlayUserId,
		})) as files_nodes_get_visible_entry_by_path_Result;
		if (!entry || entry.node.kind !== "file") return null;
		if (
			entry.kind === "private" &&
			(args.committedOnly === true ||
				entry.pendingUpdate.createIntent?.kind !== "text" ||
				entry.pendingUpdate.content?.base.kind !== "new")
		)
			return null;

		const fileNode = entry.kind === "saved" ? entry.node : null;
		const target = entry.kind === "saved" ? { kind: "saved" as const, id: entry.node._id } : entry.pendingUpdate.target;

		const requestedOrganizationId = args.organizationId;
		const requestedWorkspaceId = args.workspaceId;
		const scope = files_db_resolve_scope(ctx, requestedWorkspaceId);
		const realTenantScope =
			organizations_is_global_organization_id(requestedOrganizationId) || scope.kind !== "workspace"
				? null
				: {
						organizationId: requestedOrganizationId,
						workspaceId: scope.workspaceId,
					};
		const isEditableTextFile = fileNode !== null && files_node_has_editable_yjs_state(fileNode);
		// A non-collaborative file is editable text with no Yjs document. Its pending proposals
		// apply the same way, but it has no materialization state and reads its committed chunks
		// directly.
		const isNonCollaborativeTextFile =
			fileNode !== null && !isEditableTextFile && files_node_has_editable_text_content(fileNode);
		const isReadOnlyPlainTextFile =
			!isEditableTextFile && !isNonCollaborativeTextFile && (fileNode?.contentType?.startsWith("text/plain") ?? false);
		let pendingUpdateBaseStateId: Id<"files_pending_update_yjs_states"> | undefined;
		if (realTenantScope) {
			if (entry.kind === "saved" && !isEditableTextFile && !isNonCollaborativeTextFile && !isReadOnlyPlainTextFile)
				return null;

			if (entry.kind === "private" || isEditableTextFile || isNonCollaborativeTextFile) {
				// Bind the guard-narrowed ids; TS drops property narrowing inside the closures below.
				const { organizationId, workspaceId } = realTenantScope;

				// Prefer the explicit pending update when the caller is continuing a known
				// read. Otherwise use the current pending edit for this user and file.
				let pendingUpdate: Doc<"files_pending_updates"> | null = null;
				if (args.pendingUpdateId != null) {
					pendingUpdate = await files_saved_placement_db_get_proposal(ctx.db, args.pendingUpdateId).then(
						(pendingUpdate) => {
							if (
								!pendingUpdate ||
								pendingUpdate.organizationId !== organizationId ||
								pendingUpdate.workspaceId !== workspaceId ||
								pendingUpdate.userId !== args.userId ||
								pendingUpdate.target.kind !== target.kind ||
								pendingUpdate.target.id !== target.id
							) {
								return null;
							}
							return pendingUpdate;
						},
					);
					if (pendingUpdate == null) return null;
				} else if (args.committedOnly !== true) {
					pendingUpdate = await ctx.db
						.query("files_pending_updates")
						.withIndex("by_organization_workspace_user_target", (q) =>
							q
								.eq("organizationId", organizationId)
								.eq("workspaceId", workspaceId)
								.eq("userId", args.userId)
								.eq("target.kind", target.kind)
								.eq("target.id", target.id),
						)
						.first();
				}
				if (pendingUpdate) pendingUpdate = await files_saved_placement_db_get_proposal(ctx.db, pendingUpdate._id);

				// Keep the source family even when stale reads show saved text. Review may replace
				// this family before a read-based edit writes its result.
				pendingUpdateBaseStateId = pendingUpdate?.content?.baseStateId;
				// A stored replacement has no text. The old saved text is no longer this user's view.
				if (pendingUpdate?.pendingReplacement && pendingUpdate.pendingReplacement.yjsRootKind === undefined)
					return null;

				// Move-only docs and copies of stored files have no pending chunks; fall through to
				// the committed chunks so reads do not return an empty file behind them. A stale
				// proposal (a member saved the file with collaboration off after it was made) falls
				// through too, until preparation updates it.
				if (
					pendingUpdate != null &&
					files_pending_update_has_pending_chunks(pendingUpdate) &&
					(fileNode === null || !files_pending_update_content_is_stale(pendingUpdate, fileNode))
				) {
					// Pending chunks are already the markdown text the user sees. Full reads
					// still honor maxBytes; line reads stream only the overlapping chunks.
					const chunks = files_saved_content_db_text_chunks(ctx.db, {
						...args,
						pendingUpdateId: pendingUpdate._id,
						proposalRevision: pendingUpdate.revision,
					});

					if (args.mode.kind === "prefix") {
						const prefix = await files_read_prefix_from_ordered_chunks(
							chunks,
							Math.max(0, Math.min(files_READ_RANGE_MAX_BYTES, args.mode.maxBytes)),
						);
						if (prefix == null || (!prefix.hasChunks && pendingUpdate.size > 0)) return null;
						return {
							target,
							content: prefix.content,
							moreLines: prefix.moreLines,
							pendingUpdateId: pendingUpdate._id,
							pendingUpdateBaseStateId,
						};
					}

					if (args.mode.kind === "full") {
						if (pendingUpdate.size > args.mode.maxBytes) return null;
						const collectedChunks = await files_saved_content_collect(chunks);
						if (collectedChunks.length === 0) {
							return pendingUpdate.size > 0
								? null
								: {
										target,
										content: "",
										moreLines: false,
										pendingUpdateId: pendingUpdate._id,
										pendingUpdateBaseStateId,
									};
						}

						const content = files_merge_contiguous_chunks(collectedChunks);
						if (content == null || files_get_utf8_byte_size(content) > args.mode.maxBytes) return null;
						return {
							target,
							content,
							moreLines: false,
							pendingUpdateId: pendingUpdate._id,
							pendingUpdateBaseStateId,
						};
					}

					const startLine = Math.max(1, Math.trunc(args.mode.startLine));
					const range = await files_read_forward_line_range_from_ordered_chunks(
						files_saved_content_db_text_chunks(ctx.db, {
							...args,
							pendingUpdateId: pendingUpdate._id,
							proposalRevision: pendingUpdate.revision,
							startLine,
						}),
						{
							startLine,
							maxLines: args.mode.maxLines,
						},
					);
					if (range == null || (!range.hasChunks && pendingUpdate.size > 0)) return null;
					return {
						target,
						content: range.content,
						moreLines: range.moreLines,
						pendingUpdateId: pendingUpdate._id,
						pendingUpdateBaseStateId,
					};
				}
			} else if (args.pendingUpdateId != null) {
				return null;
			}
		} else if (args.pendingUpdateId != null) {
			// External (reserved) nodes never have pending docs; an explicit pending view cannot resolve.
			return null;
		}

		// Private preparation never falls through to saved chunks or an empty saved file.
		if (!fileNode) return null;

		// Determine the committed byte size used for the cap/empty checks below. Tenant: the materialized
		// snapshot must be current (stale → null so the action fallback runs). External: the linked R2
		// content asset's size.
		let byteSize: number;
		if (realTenantScope && isEditableTextFile) {
			const materializationState = await db_get_file_content_materialization_db_state(ctx, {
				organizationId: realTenantScope.organizationId,
				workspaceId: realTenantScope.workspaceId,
				nodeId: fileNode._id,
			});
			if (
				!materializationState ||
				materializationState.yjsLastSequenceDoc.lastSequence > materializationState.yjsSnapshotDoc.sequence
			) {
				return null;
			}
			byteSize = materializationState.asset.size;
		} else {
			const asset = fileNode.assetId ? await ctx.db.get("files_r2_assets", fileNode.assetId) : null;
			// A non-collaborative file points at the version snapshot its last save wrote, not at an
			// upload row, so the kind check that fits an external mount would read its size as 0 and
			// stop enforcing `maxBytes`. `node.assetId` always holds the file's current bytes either
			// way, as `db_get_file_content_materialization_header` explains.
			const allowedAssetKind = isNonCollaborativeTextFile ? "content_snapshot" : "content";
			byteSize =
				asset &&
				asset.organizationId === args.organizationId &&
				asset.workspaceId === args.workspaceId &&
				asset.kind === allowedAssetKind
					? asset.size
					: 0;
		}

		if (args.mode.kind === "prefix") {
			const prefix = await files_read_prefix_from_ordered_chunks(
				files_saved_content_db_text_chunks(ctx.db, { ...args, nodeId: fileNode._id, pendingUpdateId: undefined }),
				Math.max(0, Math.min(files_READ_RANGE_MAX_BYTES, args.mode.maxBytes)),
			);
			if (prefix == null || (!prefix.hasChunks && byteSize > 0)) return null;
			return {
				target,
				content: prefix.content,
				moreLines: prefix.moreLines,
				pendingUpdateId: null,
				pendingUpdateBaseStateId,
			};
		}

		if (args.mode.kind === "full") {
			// Full reads use the byte size as the cheap cap check, then merge the materialized chunks
			// only when the file is small enough to return inline.
			if (byteSize > args.mode.maxBytes) return null;

			const chunks = await files_saved_content_collect(
				files_saved_content_db_text_chunks(ctx.db, {
					...args,
					nodeId: fileNode._id,
					pendingUpdateId: undefined,
				}),
			);
			if (chunks.length === 0) {
				return byteSize > 0
					? null
					: {
							target,
							content: "",
							moreLines: false,
							pendingUpdateId: null,
							pendingUpdateBaseStateId,
						};
			}

			const content = files_merge_contiguous_chunks(chunks);
			if (content == null) return null;
			return { target, content, moreLines: false, pendingUpdateId: null, pendingUpdateBaseStateId };
		}

		// Line reads use the lineEnd index to seek near the requested start line
		// and avoid reading unrelated leading chunks.
		const startLine = Math.max(1, Math.trunc(args.mode.startLine));
		const range = await files_read_forward_line_range_from_ordered_chunks(
			files_saved_content_db_text_chunks(ctx.db, {
				...args,
				nodeId: fileNode._id,
				pendingUpdateId: undefined,
				startLine,
			}),
			{ startLine, maxLines: args.mode.maxLines },
		);
		if (range == null) return null;
		if (!range.hasChunks) {
			const { value: anyChunk } = await files_saved_content_db_text_chunks(ctx.db, {
				...args,
				nodeId: fileNode._id,
				pendingUpdateId: undefined,
			}).next();
			if (!anyChunk && byteSize > 0) return null;
		}

		return {
			target,
			content: range.content,
			moreLines: range.moreLines,
			pendingUpdateId: null,
			pendingUpdateBaseStateId,
		};
	},
});

export type files_nodes_read_file_content_from_chunks_Result =
	typeof read_file_content_from_chunks extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * Exact line/word/char/byte counts for committed, up-to-date content — read O(1) from the counts
 * stored on the file node at materialization (NO file/chunk content is read). Returns
 * { usable: false } when not committed-current, or for a file materialized before counts were
 * stored (the action then falls back to the windowed estimate). byteCount is the content byte size.
 */
export const read_committed_file_chunk_stats = internalQuery({
	args: {
		agentSource: v.optional(ai_chat_workspaces_source_validator),
		organizationId: doc(app_convex_schema, "files_nodes").fields.organizationId,
		workspaceId: doc(app_convex_schema, "files_nodes").fields.workspaceId,
		userId: v.id("users"),
		path: v.string(),
		pendingUpdateId: v.optional(v.id("files_pending_updates")),
		/** When set, resolve `path` through this user's pending path overlay (their pending moves). */
		overlayUserId: v.optional(v.id("users")),
	},
	returns: v.union(
		v.object({ usable: v.literal(false) }),
		v.object({
			usable: v.literal(true),
			nodeId: v.id("files_nodes"),
			lineCount: v.number(),
			wordCount: v.number(),
			charCount: v.number(),
			byteCount: v.number(),
		}),
	),
	handler: async (ctx, args) => {
		const authorized = await files_db_authorize_file_read(ctx, args);
		if (authorized._nay) return { usable: false as const };
		const source = await db_resolve_committed_chunk_source(ctx, args);
		// Counts are persisted on the node at materialization; if absent (older file), fall back.
		if (!source || !source.counts) return { usable: false as const };
		return {
			usable: true as const,
			nodeId: source.nodeId,
			lineCount: source.counts.lineCount,
			wordCount: source.counts.wordCount,
			charCount: source.counts.charCount,
			byteCount: source.byteSize,
		};
	},
});

export type files_nodes_read_committed_file_chunk_stats_Result =
	typeof read_committed_file_chunk_stats extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

// #endregion read file

// #region match

// Per-file `grep` scans chunks streaming-style and bounds only the retained output state.
// DEV-PHASE AGGRESSIVE: keep these small while we exercise pagination/truncation behavior.
const files_GREP_MAX_MATCHES = 100;
const files_GREP_MAX_CONTEXT_LINES = 20;
const files_GREP_MAX_OUTPUT_LINES = 200;
const files_GREP_MAX_SCAN_LINES = 200;
const files_GREP_MAX_SCAN_BYTES = 16 * 1024;
const files_GREP_MAX_SLICE_CHARS = 16 * 1024;

type MatchChunksListTruncatedReason =
	| "selected_match_limit_reached"
	| "output_line_limit_reached"
	| "scan_line_limit_reached"
	| "scan_byte_limit_reached"
	| "slice_window_ended";

/**
 * Scan ordered text chunks as one logical file.
 *
 * This owns the hard part that both grep modes share: stitching ordered chunks,
 * preserving source line numbers, adding context, and stopping at the scan caps.
 * Callers choose either fixed-string substring matching or regex matching.
 */
async function match_text_chunks_list(
	chunks: AsyncIterable<{
		chunkIndex: number;
		lineStart?: number;
		lineEnd?: number;
		startIndex?: number;
		endIndex?: number;
		textChunk?: string;
	}>,
	args: {
		target: files_PendingTarget;
		pattern: string;
		invert: boolean;
		before: number;
		after: number;
		match: { kind: "substring"; needle: string; ignoreCase: boolean } | { kind: "regex"; regex: RegExp };
		window?:
			| { kind: "lines"; startLine: number; maxLines: number }
			| { kind: "slice"; startIndex: number; maxChars: number };
	},
) {
	const linesByNumber = new Map<number, { lineNumber: number; line: string; matched: boolean }>();
	const previousLines: Array<{ lineNumber: number; line: string }> = [];
	const requestedBefore = Math.max(0, args.before);
	const requestedAfter = Math.max(0, args.after);
	const before = Math.min(requestedBefore, files_GREP_MAX_CONTEXT_LINES);
	const after = Math.min(requestedAfter, files_GREP_MAX_CONTEXT_LINES);
	const lineWindow =
		args.window?.kind === "lines"
			? {
					startLine: Math.max(1, Math.trunc(args.window.startLine)),
					maxLines: Math.max(1, Math.min(files_GREP_MAX_SCAN_LINES, Math.trunc(args.window.maxLines))),
				}
			: { startLine: 1, maxLines: files_GREP_MAX_SCAN_LINES };
	const lineWindowEnd = lineWindow.startLine + lineWindow.maxLines - 1;
	const sliceWindow =
		args.window?.kind === "slice"
			? {
					startIndex: Math.max(0, Math.trunc(args.window.startIndex)),
					maxChars: Math.max(1, Math.min(files_GREP_MAX_SLICE_CHARS, Math.trunc(args.window.maxChars))),
				}
			: null;
	const sliceWindowEnd = sliceWindow == null ? null : sliceWindow.startIndex + sliceWindow.maxChars;

	let afterRemaining = 0;
	let afterContextCapPending = false;
	let carry = "";
	let carryStartIndex: number | null = null;
	let lineNumber: number | null = null;
	let prevEnd: number | null = null;
	let previousChunkIndex: number | null = null;
	let selectedCount = 0;
	let selectedStored = 0;
	let scanTruncated = false;
	let outputTruncated = false;
	let stopScanning = false;
	const truncation = {
		reason: null as MatchChunksListTruncatedReason | null,
		nextStartLine: null as number | null,
		nextStartIndex: null as number | null,
	};
	let lastScannedLine: number | null = null;
	let lastScannedIndex: number | null = null;
	let scannedBytes = 0;

	const setTruncated = (args: {
		reason: MatchChunksListTruncatedReason;
		nextLine: number | null;
		nextIndex: number | null;
	}) => {
		const { reason, nextLine, nextIndex } = args;

		scanTruncated = true;
		stopScanning = true;
		if (truncation.reason == null) {
			truncation.reason = reason;
			truncation.nextStartLine = nextLine;
			truncation.nextStartIndex = nextIndex;
		}
	};

	const includeLine = (line: { lineNumber: number; line: string }, matched: boolean) => {
		const existing = linesByNumber.get(line.lineNumber);
		if (existing) {
			if (matched) {
				existing.matched = true;
			}
			return true;
		}
		if (linesByNumber.size >= files_GREP_MAX_OUTPUT_LINES) {
			outputTruncated = true;
			setTruncated({ reason: "output_line_limit_reached", nextLine: line.lineNumber, nextIndex: null });
			return false;
		}
		linesByNumber.set(line.lineNumber, { ...line, matched });
		return true;
	};

	const rememberPreviousLine = (line: { lineNumber: number; line: string }) => {
		if (before === 0) {
			return;
		}
		previousLines.push(line);
		if (previousLines.length > before) {
			previousLines.shift();
		}
	};

	const processLine = (line: string, lineStartIndex: number | null, lineEndIndex: number | null) => {
		lineNumber = (lineNumber ?? 0) + 1;
		if (lineNumber < lineWindow.startLine) {
			return true;
		}
		if (lineNumber > lineWindowEnd) {
			setTruncated({ reason: "scan_line_limit_reached", nextLine: lineNumber, nextIndex: null });
			return false;
		}

		const lineBytes = files_get_utf8_byte_size(line) + 1;
		if (scannedBytes + lineBytes > files_GREP_MAX_SCAN_BYTES) {
			const lineExceedsByteCap = lineBytes > files_GREP_MAX_SCAN_BYTES;
			setTruncated({
				reason: "scan_byte_limit_reached",
				nextLine: lineExceedsByteCap ? null : lineNumber,
				nextIndex: lineExceedsByteCap ? lineStartIndex : null,
			});
			return false;
		}
		scannedBytes += lineBytes;
		lastScannedLine = lineNumber;
		lastScannedIndex = lineEndIndex;

		const displayLine = { lineNumber, line: files_truncate_long_display_line(line) };
		const isMatch =
			args.pattern.length > 0 &&
			(args.match.kind === "substring"
				? (args.match.ignoreCase ? line.toLowerCase() : line).includes(args.match.needle)
				: args.match.regex.test(line));
		const selected = args.invert ? !isMatch : isMatch;

		if (!selected && afterRemaining === 0 && afterContextCapPending) {
			outputTruncated = true;
			afterContextCapPending = false;
		}

		if (selected) {
			if (selectedStored < files_GREP_MAX_MATCHES) {
				if (!includeLine(displayLine, true)) {
					rememberPreviousLine(displayLine);
					return false;
				}
				selectedCount++;
				selectedStored++;
				if (requestedBefore > before && previousLines.length === before) {
					outputTruncated = true;
				}
				for (const previousLine of previousLines) {
					if (!includeLine(previousLine, false)) {
						rememberPreviousLine(displayLine);
						return false;
					}
				}
				afterRemaining = after;
				afterContextCapPending = requestedAfter > after;
			} else {
				setTruncated({ reason: "selected_match_limit_reached", nextLine: lineNumber, nextIndex: null });
				rememberPreviousLine(displayLine);
				return afterRemaining > 0;
			}
		} else if (afterRemaining > 0) {
			if (!includeLine(displayLine, false)) {
				rememberPreviousLine(displayLine);
				return false;
			}
			afterRemaining--;
		}

		rememberPreviousLine(displayLine);
		return true;
	};

	for await (const chunk of chunks) {
		if (previousChunkIndex !== null && chunk.chunkIndex !== previousChunkIndex + 1) {
			return null;
		}
		previousChunkIndex = chunk.chunkIndex;

		let text = chunk.textChunk;
		if (text == null) {
			return null;
		}
		if (chunk.startIndex != null && chunk.endIndex != null && prevEnd !== null && chunk.startIndex !== prevEnd) {
			return null;
		}
		prevEnd = chunk.endIndex ?? prevEnd;

		let textStartIndex = chunk.startIndex ?? null;
		let textPrefixForLineNumber = "";
		if (sliceWindow != null) {
			if (chunk.startIndex == null || chunk.endIndex == null) {
				return null;
			}
			if (chunk.endIndex <= sliceWindow.startIndex) {
				continue;
			}
			if (sliceWindowEnd != null && chunk.startIndex >= sliceWindowEnd) {
				setTruncated({
					reason: "slice_window_ended",
					nextLine: null,
					nextIndex: sliceWindow.startIndex + sliceWindow.maxChars,
				});
				break;
			}
			const trimStart = Math.max(0, sliceWindow.startIndex - chunk.startIndex);
			const trimEnd = Math.min(text.length, sliceWindowEnd == null ? text.length : sliceWindowEnd - chunk.startIndex);
			if (trimStart > trimEnd) {
				continue;
			}
			textPrefixForLineNumber = text.slice(0, trimStart);
			text = text.slice(trimStart, trimEnd);
			textStartIndex = chunk.startIndex + trimStart;
			if (chunk.startIndex + trimEnd < chunk.endIndex) {
				setTruncated({
					reason: "slice_window_ended",
					nextLine: null,
					nextIndex: sliceWindow.startIndex + Math.max(1, sliceWindow.maxChars - args.pattern.length + 1),
				});
			}
		}

		if (lineNumber == null) {
			let skippedLines = 0;
			for (const char of textPrefixForLineNumber) {
				if (char === "\n") {
					skippedLines++;
				}
			}
			lineNumber = chunk.lineStart == null ? 0 : chunk.lineStart - 1 + skippedLines;
		}
		if (carry.length === 0) {
			carryStartIndex = textStartIndex;
		}
		carry += text;

		let newlineIndex = carry.indexOf("\n");
		while (newlineIndex !== -1) {
			const line = carry.slice(0, newlineIndex);
			const lineStartIndex = carryStartIndex;
			const lineEndIndex: number | null = carryStartIndex == null ? null : carryStartIndex + newlineIndex;
			carry = carry.slice(newlineIndex + 1);
			carryStartIndex = lineEndIndex == null ? null : lineEndIndex + 1;
			if (!processLine(line, lineStartIndex, lineEndIndex)) {
				break;
			}
			newlineIndex = carry.indexOf("\n");
		}
		if (stopScanning || (scanTruncated && afterRemaining <= 0)) {
			break;
		}
	}

	if ((!scanTruncated || truncation.reason === "slice_window_ended") && carry.length > 0) {
		const lineStartIndex = carryStartIndex;
		const lineEndIndex = carryStartIndex == null ? null : carryStartIndex + carry.length;
		processLine(carry, lineStartIndex, lineEndIndex);
	}

	const resultTruncatedReason = truncation.reason ?? (outputTruncated ? "output_line_limit_reached" : null);

	return {
		target: args.target,
		lines: [...linesByNumber.values()].sort((left, right) => left.lineNumber - right.lineNumber),
		selectedCount,
		scanTruncated: scanTruncated || outputTruncated,
		truncatedReason: resultTruncatedReason,
		nextStartLine: truncation.nextStartLine,
		nextStartIndex: truncation.nextStartIndex,
		lastScannedLine,
		lastScannedIndex,
	};
}

/**
 * Scan ordered plain-text chunks as one logical file for regex line matching.
 */
async function match_plain_text_chunks_list(
	chunks: AsyncIterable<{
		chunkIndex: number;
		lineStart?: number;
		plainTextChunk?: string;
	}>,
	args: {
		target: files_PendingTarget;
		pattern: string;
		ignoreCase: boolean;
		fixedStrings: boolean;
		invert: boolean;
	},
) {
	let match: { kind: "substring"; needle: string; ignoreCase: boolean } | { kind: "regex"; regex: RegExp };
	if (args.fixedStrings) {
		// `textgrep -F` treats regex metacharacters as normal text.
		match = {
			kind: "substring",
			needle: args.ignoreCase ? args.pattern.toLowerCase() : args.pattern,
			ignoreCase: args.ignoreCase,
		};
	} else {
		try {
			match = { kind: "regex", regex: new RegExp(args.pattern, args.ignoreCase ? "iu" : "u") };
		} catch {
			return null;
		}
	}

	const linesByNumber = new Map<number, { lineNumber: number; line: string; matched: boolean }>();
	let carry = "";
	let lineNumber: number | null = null;
	let previousChunkIndex: number | null = null;
	let selectedCount = 0;
	let selectedStored = 0;
	let scanTruncated = false;
	let outputTruncated = false;
	let stopScanning = false;
	const truncation = {
		reason: null as MatchChunksListTruncatedReason | null,
		nextStartLine: null as number | null,
	};
	let lastScannedLine: number | null = null;
	let scannedBytes = 0;

	const setTruncated = (reason: MatchChunksListTruncatedReason, nextLine: number | null) => {
		scanTruncated = true;
		stopScanning = true;
		if (truncation.reason == null) {
			truncation.reason = reason;
			truncation.nextStartLine = nextLine;
		}
	};

	const includeLine = (line: { lineNumber: number; line: string }) => {
		if (linesByNumber.has(line.lineNumber)) {
			return true;
		}
		if (linesByNumber.size >= files_GREP_MAX_OUTPUT_LINES) {
			outputTruncated = true;
			setTruncated("output_line_limit_reached", line.lineNumber);
			return false;
		}
		linesByNumber.set(line.lineNumber, { ...line, matched: true });
		return true;
	};

	const processLine = (line: string) => {
		lineNumber = (lineNumber ?? 0) + 1;
		if (lineNumber > files_GREP_MAX_SCAN_LINES) {
			setTruncated("scan_line_limit_reached", lineNumber);
			return false;
		}

		const lineBytes = files_get_utf8_byte_size(line) + 1;
		if (scannedBytes + lineBytes > files_GREP_MAX_SCAN_BYTES) {
			setTruncated("scan_byte_limit_reached", lineBytes > files_GREP_MAX_SCAN_BYTES ? null : lineNumber);
			return false;
		}
		scannedBytes += lineBytes;
		lastScannedLine = lineNumber;

		const isMatch =
			args.pattern.length > 0 &&
			(match.kind === "substring"
				? (match.ignoreCase ? line.toLowerCase() : line).includes(match.needle)
				: match.regex.test(line));
		const selected = args.invert ? !isMatch : isMatch;
		if (!selected) {
			return true;
		}

		if (selectedStored >= files_GREP_MAX_MATCHES) {
			setTruncated("selected_match_limit_reached", lineNumber);
			return false;
		}

		if (!includeLine({ lineNumber, line: files_truncate_long_display_line(line) })) {
			return false;
		}
		selectedCount++;
		selectedStored++;
		return true;
	};

	for await (const chunk of chunks) {
		if (previousChunkIndex !== null && chunk.chunkIndex !== previousChunkIndex + 1) {
			return null;
		}
		previousChunkIndex = chunk.chunkIndex;

		const text = chunk.plainTextChunk;
		if (text == null) {
			return null;
		}
		if (lineNumber == null) {
			lineNumber = chunk.lineStart == null ? 0 : chunk.lineStart - 1;
		}
		carry += text;

		let newlineIndex = carry.indexOf("\n");
		while (newlineIndex !== -1) {
			const line = carry.slice(0, newlineIndex);
			carry = carry.slice(newlineIndex + 1);
			if (!processLine(line)) {
				break;
			}
			newlineIndex = carry.indexOf("\n");
		}
		if (stopScanning) {
			break;
		}
	}

	if (!scanTruncated && carry.length > 0) {
		processLine(carry);
	}

	const resultTruncatedReason = truncation.reason ?? (outputTruncated ? "output_line_limit_reached" : null);
	return {
		target: args.target,
		lines: [...linesByNumber.values()].sort((left, right) => left.lineNumber - right.lineNumber),
		selectedCount,
		scanTruncated: scanTruncated || outputTruncated,
		truncatedReason: resultTruncatedReason,
		nextStartLine: truncation.nextStartLine,
		nextStartIndex: null,
		lastScannedLine,
		lastScannedIndex: null,
	};
}

async function* db_plain_text_chunks_with_lines(chunks: AsyncIterable<Doc<"files_plain_text_chunks">>) {
	for await (const chunk of chunks) {
		yield {
			chunkIndex: chunk.chunkIndex,
			lineStart: chunk.lineStart,
			plainTextChunk: chunk.plainTextChunk,
		};
	}
}

/**
 * The two grep views share owner, readiness, and saved-content checks.
 */
async function db_get_text_match_source(
	ctx: QueryCtx,
	args: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		userId: Id<"users">;
		target: files_PendingTarget;
		pendingUpdateId?: Id<"files_pending_updates">;
	},
) {
	const scope = files_db_resolve_scope(ctx, args.workspaceId);
	const tenantScope =
		!organizations_is_global_organization_id(args.organizationId) && scope.kind === "workspace"
			? { organizationId: args.organizationId, workspaceId: scope.workspaceId, userId: args.userId }
			: null;

	let fileNode: Doc<"files_nodes"> | null = null;
	let pendingUpdateId: Id<"files_pending_updates"> | null = null;
	if (tenantScope) {
		const entry = (await ctx.runQuery(internal.files_visible.internal_get_by_target, {
			...tenantScope,
			target: args.target,
		})) as files_VisibleEntry | null;
		if (!entry || entry.node.kind !== "file") return null;
		const pending = entry.pendingUpdate;
		if (args.pendingUpdateId != null && pending?._id !== args.pendingUpdateId) return null;

		if (entry.kind === "private") {
			if (
				entry.pendingUpdate.preparation ||
				entry.pendingUpdate.createIntent?.kind !== "text" ||
				!files_pending_update_has_pending_chunks(entry.pendingUpdate)
			)
				return null;
			pendingUpdateId = entry.pendingUpdate._id;
		} else {
			fileNode = entry.node;
			if (!files_node_has_editable_text_content(fileNode)) return null;
			// A move-only or stale content proposal keeps reading the saved chunks.
			if (
				pending &&
				!pending.preparation &&
				files_pending_update_has_pending_chunks(pending) &&
				!files_pending_update_content_is_stale(pending, fileNode)
			)
				pendingUpdateId = pending._id;
		}
	} else {
		if (args.target.kind !== "saved" || args.pendingUpdateId != null) return null;
		fileNode = await files_saved_placement_db_get_node(ctx.db, args.target.id);
		if (
			!fileNode ||
			fileNode.organizationId !== args.organizationId ||
			fileNode.workspaceId !== args.workspaceId ||
			fileNode.archiveOperationId !== null
		)
			return null;

		if (
			scope.kind !== "volume" &&
			!(await access_control_db_can_act_on_file_node(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				userId: args.userId,
				fileNode,
				permission: "content.read",
			}))
		)
			return null;
	}

	return { fileNode, pendingUpdateId };
}

/**
 * Match lines in text chunks for the Bash `grep` command's single-file path.
 *
 * Normal grep uses regex matching over the Markdown representation. `grep -F`
 * uses fixed-string matching through the same chunk scan.
 */
export const match_text_file_lines = internalQuery({
	args: {
		agentSource: v.optional(ai_chat_workspaces_source_validator),
		organizationId: doc(app_convex_schema, "files_nodes").fields.organizationId,
		workspaceId: doc(app_convex_schema, "files_nodes").fields.workspaceId,
		userId: v.id("users"),
		target: files_pending_target_validator,
		pattern: v.string(),
		ignoreCase: v.boolean(),
		fixedStrings: v.boolean(),
		invert: v.boolean(),
		before: v.number(),
		after: v.number(),
		pendingUpdateId: v.optional(v.id("files_pending_updates")),
		window: v.optional(
			v.union(
				v.object({
					kind: v.literal("lines"),
					startLine: v.number(),
					maxLines: v.number(),
				}),
				v.object({
					kind: v.literal("slice"),
					startIndex: v.number(),
					maxChars: v.number(),
				}),
			),
		),
	},
	returns: v.union(
		v.null(),
		v.object({
			target: files_pending_target_validator,
			lines: v.array(
				v.object({
					lineNumber: v.number(),
					line: v.string(),
					matched: v.boolean(),
				}),
			),
			selectedCount: v.number(),
			scanTruncated: v.boolean(),
			truncatedReason: v.union(
				v.literal("selected_match_limit_reached"),
				v.literal("output_line_limit_reached"),
				v.literal("scan_line_limit_reached"),
				v.literal("scan_byte_limit_reached"),
				v.literal("slice_window_ended"),
				v.null(),
			),
			nextStartLine: v.union(v.number(), v.null()),
			nextStartIndex: v.union(v.number(), v.null()),
			lastScannedLine: v.union(v.number(), v.null()),
			lastScannedIndex: v.union(v.number(), v.null()),
		}),
	),
	handler: async (ctx, args) => {
		const authorized = await files_db_authorize_file_read(ctx, args);
		if (authorized._nay) return null;
		const scope = files_db_resolve_scope(ctx, args.workspaceId);
		const source = await db_get_text_match_source(ctx, args);
		if (!source) return null;
		const { fileNode, pendingUpdateId } = source;

		let match: { kind: "substring"; needle: string; ignoreCase: boolean } | { kind: "regex"; regex: RegExp };
		if (args.fixedStrings) {
			// `grep -F` treats regex metacharacters as normal text.
			match = {
				kind: "substring",
				needle: args.ignoreCase ? args.pattern.toLowerCase() : args.pattern,
				ignoreCase: args.ignoreCase,
			};
		} else {
			try {
				match = { kind: "regex", regex: new RegExp(args.pattern, args.ignoreCase ? "iu" : "u") };
			} catch {
				return null;
			}
		}

		const window = args.window;
		if (pendingUpdateId != null) {
			const chunks = files_saved_content_db_text_chunks(ctx.db, {
				...args,
				pendingUpdateId,
				startLine: window?.kind === "lines" ? Math.max(1, Math.trunc(window.startLine)) : undefined,
				startIndex: window?.kind === "slice" ? Math.max(0, Math.trunc(window.startIndex)) + 1 : undefined,
			});

			return await match_text_chunks_list(chunks, {
				target: args.target,
				pattern: args.pattern,
				invert: args.invert,
				before: args.before,
				after: args.after,
				match,
				window,
			});
		}

		if (!fileNode) return null;

		// Tenant committed chunks are valid only when the latest Yjs sequence is materialized; external
		// (reserved) nodes have no Yjs/materialization state and read committed chunks by node id. A
		// non-collaborative file has no Yjs sequence either, so its committed chunks are always current.
		if (
			!organizations_is_global_organization_id(args.organizationId) &&
			scope.kind === "workspace" &&
			files_node_has_editable_yjs_state(fileNode)
		) {
			const materializationState = await db_get_file_content_materialization_db_state(ctx, {
				organizationId: args.organizationId,
				workspaceId: scope.workspaceId,
				nodeId: fileNode._id,
			});
			if (
				!materializationState ||
				materializationState.yjsLastSequenceDoc.lastSequence > materializationState.yjsSnapshotDoc.sequence
			) {
				return null;
			}
		}

		const chunks = files_saved_content_db_text_chunks(ctx.db, {
			...args,
			nodeId: fileNode._id,
			pendingUpdateId: undefined,
			startLine: window?.kind === "lines" ? Math.max(1, Math.trunc(window.startLine)) : undefined,
			startIndex: window?.kind === "slice" ? Math.max(0, Math.trunc(window.startIndex)) + 1 : undefined,
		});

		return await match_text_chunks_list(chunks, {
			target: args.target,
			pattern: args.pattern,
			invert: args.invert,
			before: args.before,
			after: args.after,
			match,
			window,
		});
	},
});

export type files_nodes_match_text_file_lines_Result =
	typeof match_text_file_lines extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * Match lines in plain-text chunks for the Bash `textgrep` command's single-file path.
 * This uses regex matching over rendered plain text.
 */
export const match_plain_text_file_lines = internalQuery({
	args: {
		agentSource: v.optional(ai_chat_workspaces_source_validator),
		organizationId: doc(app_convex_schema, "files_nodes").fields.organizationId,
		workspaceId: doc(app_convex_schema, "files_nodes").fields.workspaceId,
		userId: v.id("users"),
		target: files_pending_target_validator,
		pattern: v.string(),
		ignoreCase: v.boolean(),
		fixedStrings: v.boolean(),
		invert: v.boolean(),
		pendingUpdateId: v.optional(v.id("files_pending_updates")),
	},
	returns: v.union(
		v.null(),
		v.object({
			target: files_pending_target_validator,
			lines: v.array(
				v.object({
					lineNumber: v.number(),
					line: v.string(),
					matched: v.boolean(),
				}),
			),
			selectedCount: v.number(),
			scanTruncated: v.boolean(),
			truncatedReason: v.union(
				v.literal("selected_match_limit_reached"),
				v.literal("output_line_limit_reached"),
				v.literal("scan_line_limit_reached"),
				v.literal("scan_byte_limit_reached"),
				v.literal("slice_window_ended"),
				v.null(),
			),
			nextStartLine: v.union(v.number(), v.null()),
			nextStartIndex: v.union(v.number(), v.null()),
			lastScannedLine: v.union(v.number(), v.null()),
			lastScannedIndex: v.union(v.number(), v.null()),
		}),
	),
	handler: async (ctx, args) => {
		const authorized = await files_db_authorize_file_read(ctx, args);
		if (authorized._nay) return null;
		const scope = files_db_resolve_scope(ctx, args.workspaceId);
		const source = await db_get_text_match_source(ctx, args);
		if (!source) return null;
		const { fileNode, pendingUpdateId } = source;

		if (pendingUpdateId != null) {
			const chunks = files_saved_content_db_plain_text_chunks(ctx.db, { ...args, pendingUpdateId });

			return await match_plain_text_chunks_list(db_plain_text_chunks_with_lines(chunks), {
				target: args.target,
				pattern: args.pattern,
				ignoreCase: args.ignoreCase,
				fixedStrings: args.fixedStrings,
				invert: args.invert,
			});
		}

		if (!fileNode) return null;

		// Tenant committed chunks are valid only when the latest Yjs sequence is materialized; external
		// (reserved) nodes have no Yjs/materialization state and read committed chunks by node id. A
		// non-collaborative file has no Yjs sequence either, so its committed chunks are always current.
		if (
			!organizations_is_global_organization_id(args.organizationId) &&
			scope.kind === "workspace" &&
			files_node_has_editable_yjs_state(fileNode)
		) {
			const materializationState = await db_get_file_content_materialization_db_state(ctx, {
				organizationId: args.organizationId,
				workspaceId: scope.workspaceId,
				nodeId: fileNode._id,
			});
			if (
				!materializationState ||
				materializationState.yjsLastSequenceDoc.lastSequence > materializationState.yjsSnapshotDoc.sequence
			) {
				return null;
			}
		}

		const chunks = files_saved_content_db_plain_text_chunks(ctx.db, {
			...args,
			nodeId: fileNode._id,
			pendingUpdateId: undefined,
		});

		return await match_plain_text_chunks_list(db_plain_text_chunks_with_lines(chunks), {
			target: args.target,
			pattern: args.pattern,
			ignoreCase: args.ignoreCase,
			fixedStrings: args.fixedStrings,
			invert: args.invert,
		});
	},
});

export type files_nodes_match_plain_text_file_lines_Result =
	typeof match_plain_text_file_lines extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

// #endregion match

export const get_file_last_yjs_sequence = query({
	args: { membershipId: v.id("organizations_workspaces_users"), nodeId: v.id("files_nodes") },
	returns: v.union(
		v.object({
			yjsLastSequenceId: v.id("files_yjs_docs_last_sequences"),
			lastSequence: v.number(),
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

		const fileNode = await files_saved_placement_db_get_node(ctx.db, args.nodeId);
		if (
			!files_node_has_editable_yjs_state(fileNode) ||
			fileNode.organizationId !== membership.organizationId ||
			fileNode.workspaceId !== membership.workspaceId
		) {
			return null;
		}

		const authorized = await access_control_db_authorize_membership(ctx, {
			userAuth,
			membership,
			permission: "content.read",
			fileNode,
		});
		if (authorized._nay) {
			return null;
		}

		const lastYjsSequenceDoc = await files_saved_placement_db_get_sequence(ctx.db, fileNode).then((doc) => {
			if (!doc || doc.organizationId !== fileNode.organizationId || doc.workspaceId !== fileNode.workspaceId)
				return null;
			return doc;
		});

		if (!lastYjsSequenceDoc) {
			const errorMessage =
				"fileNode.yjsLastSequenceId points to a missing or mismatched files_yjs_docs_last_sequences doc";
			const errorData = {
				organizationId: fileNode.organizationId,
				workspaceId: fileNode.workspaceId,
				nodeId: args.nodeId,
				yjsLastSequenceId: fileNode.yjsLastSequenceId,
			};
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}

		return {
			yjsLastSequenceId: lastYjsSequenceDoc._id,
			lastSequence: lastYjsSequenceDoc.lastSequence,
		};
	},
});

function db_text_search_filtered_query(
	ctx: QueryCtx,
	args: {
		organizationId: Doc<"files_plain_text_chunks">["organizationId"];
		workspaceId: Doc<"files_plain_text_chunks">["workspaceId"];
		userId: Id<"users">;
		query: string;
		targets?: files_PendingTarget[];
		sourceKind: "pending" | "committed";
		tag?: { cohortId: Id<"files_move_cohorts">; view: "before" | "after" };
	},
) {
	let searchQuery = ctx.db.query("files_plain_text_chunks").withSearchIndex("search_by_plainTextChunk", (q) => {
		const base = q
			.search("plainTextChunk", args.query)
			.eq("organizationId", args.organizationId)
			.eq("workspaceId", args.workspaceId)
			.eq("moveView.cohortId", args.tag?.cohortId)
			.eq("moveView.view", args.tag?.view)
			.eq("archiveOperationId", undefined);
		// Committed chunks have no `userId`. Pending chunks are only the caller's own.
		return args.sourceKind === "committed"
			? base.eq("sourceKind", "committed")
			: base.eq("sourceKind", "pending").eq("userId", args.userId);
	});
	if (args.targets !== undefined) {
		const targets = args.targets;
		searchQuery = searchQuery.filter((q) =>
			q.or(
				...targets.map((target) =>
					q.or(
						...(target.kind === "saved" ? [q.eq(q.field("fileNodeId"), target.id)] : []),
						q.and(q.eq(q.field("target.kind"), target.kind), q.eq(q.field("target.id"), target.id)),
					),
				),
			),
		);
	}
	// Current paths, proposal revisions, and access are checked on the bounded page below.
	return searchQuery;
}

/**
 * Each owner/saved and normal/selected source gets its own native page.
 * The cursor pins the search and saved view. A side-row change requires a fresh search.
 */
type TextSearchPosition = {
	sourceIndex: number;
	cursor: string | null;
	read: number;
	scope: string;
	searchedTop: boolean;
};

function text_search_parse_cursor(cursor: string): TextSearchPosition | null {
	let raw: unknown;
	try {
		raw = JSON.parse(cursor);
	} catch {
		return null;
	}
	if (typeof raw !== "object" || raw === null) return null;
	const { sourceIndex, cursor: innerCursor, read, scope, searchedTop } = raw as Record<string, unknown>;
	if (typeof sourceIndex !== "number" || !Number.isInteger(sourceIndex) || sourceIndex < 0) return null;
	if (innerCursor !== null && typeof innerCursor !== "string") return null;
	if (typeof read !== "number" || !Number.isSafeInteger(read) || read < 0) return null;
	if (typeof scope !== "string" || typeof searchedTop !== "boolean") return null;
	return { sourceIndex, cursor: innerCursor, read, scope, searchedTop };
}

const text_search_args = {
	organizationId: doc(app_convex_schema, "files_nodes").fields.organizationId,
	workspaceId: doc(app_convex_schema, "files_nodes").fields.workspaceId,
	userId: v.id("users"),
	serviceAccountId: v.optional(v.id("access_control_service_accounts")),
	/**
	 * Whether the caller proved workspace-wide content.read for this workspace.
	 * Required on purpose: the readable filter defaults to true when the field is absent, so a
	 * forgotten argument would fail open and stream open-file snippets to a user who only has a
	 * per-node grant. A required field turns that mistake into a validator error instead.
	 */
	hasWorkspaceRead: v.boolean(),
	query: v.string(),
	/** Optional subtree scope: keep only matches whose file path is under this folder prefix. */
	pathPrefix: v.optional(v.string()),
	/**
	 * Files matching the structured filters. This only narrows the existing access checks.
	 */
	targets: v.optional(v.array(files_pending_target_validator)),
};

export const text_search_files = internalQuery({
	args: {
		agentSource: v.optional(ai_chat_workspaces_source_validator),
		...text_search_args,
		numItems: v.number(),
		cursor: paginationOptsValidator.fields.cursor,
	},
	returns: v.object({
		items: v.array(
			v.object({
				target: files_pending_target_validator,
				path: v.string(),
				textChunk: v.string(),
				chunkIndex: v.number(),
				startIndex: v.number(),
				endIndex: v.number(),
				lineStart: v.number(),
				lineEnd: v.number(),
				chunkFlags: v.number(),
				hasChunkAbove: v.boolean(),
				hasChunkBelow: v.boolean(),
			}),
		),
		continueCursor: v.string(),
		isDone: v.boolean(),
		/**
		 * The page ran out of reads. Nothing was returned: read the same cursor again with fewer rows.
		 */
		retrySmaller: v.boolean(),
		/**
		 * The committed search ended on the 1,024 rows Convex returns at most, so it may have missed
		 * matches.
		 */
		searchedTop: v.boolean(),
	}),
	handler: async (
		ctx,
		args,
	): Promise<{
		items: Array<{
			target: files_PendingTarget;
			path: string;
			textChunk: string;
			chunkIndex: number;
			startIndex: number;
			endIndex: number;
			lineStart: number;
			lineEnd: number;
			chunkFlags: number;
			hasChunkAbove: boolean;
			hasChunkBelow: boolean;
		}>;
		continueCursor: string;
		isDone: boolean;
		retrySmaller: boolean;
		searchedTop: boolean;
	}> => {
		const empty = {
			items: [],
			continueCursor: args.cursor ?? "",
			isDone: true,
			retrySmaller: false,
			searchedTop: false,
		};
		const scope = files_db_resolve_scope(ctx, args.workspaceId);
		if (args.agentSource && scope.kind !== "volume") {
			const authorized = await ai_chat_workspaces_db_authorize_file_scope(ctx, {
				...args,
				agentSource: args.agentSource,
			});
			if (authorized._nay) return empty;
		}
		const reader = await files_search_db_create_reader(ctx, args);
		if (!reader.active) return empty;

		// Only the owner's overlay reads pending chunks, like the reader.
		const ownerPending =
			args.serviceAccountId === undefined &&
			!organizations_is_global_organization_id(args.organizationId) &&
			scope.kind === "workspace";
		const view = await files_saved_placement_db_get_view(ctx.db, args);
		const tags = view.cohortId && view.view ? [undefined, { cohortId: view.cohortId, view: view.view }] : [undefined];
		const sources = (ownerPending ? ["pending" as const, "committed" as const] : ["committed" as const]).flatMap(
			(sourceKind) => tags.map((tag) => ({ sourceKind, tag })),
		);
		const cursorScope = JSON.stringify({
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			serviceAccountId: args.serviceAccountId,
			agentSource: args.agentSource,
			hasWorkspaceRead: args.hasWorkspaceRead,
			query: args.query,
			pathPrefix: args.pathPrefix,
			targets: args.targets,
			view,
		});
		const position =
			args.cursor === null
				? { sourceIndex: 0, cursor: null, read: 0, scope: cursorScope, searchedTop: false }
				: text_search_parse_cursor(args.cursor);
		if (!position || position.scope !== cursorScope || !sources[position.sourceIndex])
			throw convex_error({ message: "Search changed. Start the search again." });
		const source = sources[position.sourceIndex]!;
		const result = await db_text_search_filtered_query(ctx, { ...args, ...source }).paginate({
			cursor: position.cursor,
			numItems: Math.max(1, Math.min(100, args.numItems)),
		});

		const items = [];
		const rawPrefix = args.pathPrefix?.trim();
		const pathPrefix = rawPrefix && rawPrefix !== "/" ? `/${rawPrefix.replace(/^\/+|\/+$/gu, "")}/` : null;
		for (const searchChunk of result.page) {
			const entry = await reader.resolveDocument(searchChunk);
			// A search page cannot stop part way, because its cursor covers the whole page. So the action
			// reads the same cursor again with fewer rows.
			if (reader.exhausted || files_pending_overlay_list_over_budget(await ctx.meta.getTransactionMetrics()))
				return { ...empty, isDone: false, retrySmaller: true };
			// The folder is checked per row, on the top 1,024 matches of the workspace.
			if (!entry || (pathPrefix && !entry.path.startsWith(pathPrefix))) continue;
			items.push({
				...entry,
				textChunk: searchChunk.textChunk,
				chunkIndex: searchChunk.chunkIndex,
				startIndex: searchChunk.startIndex,
				endIndex: searchChunk.endIndex,
				lineStart: searchChunk.lineStart,
				lineEnd: searchChunk.lineEnd,
				chunkFlags: searchChunk.chunkFlags,
				hasChunkAbove: searchChunk.hasChunkAbove,
				hasChunkBelow: searchChunk.hasChunkBelow,
			});
		}

		const read = position.read + result.page.length;
		const searchedTop =
			position.searchedTop ||
			(source.sourceKind === "committed" && result.isDone && read >= files_TEXT_SEARCH_MAX_RESULTS);
		const next: TextSearchPosition | null = !result.isDone
			? { ...position, cursor: result.continueCursor, read, searchedTop }
			: position.sourceIndex + 1 < sources.length
				? { ...position, sourceIndex: position.sourceIndex + 1, cursor: null, read: 0, searchedTop }
				: null;
		return {
			items,
			continueCursor: next ? JSON.stringify(next) : "",
			isDone: next === null,
			retrySmaller: false,
			searchedTop,
		};
	},
});

export type files_nodes_text_search_files_Result =
	typeof text_search_files extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * The search box door: one clause plus an optional folder, one page of matching rows. Every read is
 * one index range or one text search. The client merges and dedupes pages by `nodeId`.
 *
 * A problem comes back as the only row of a done page, because `usePaginatedQuery` shows rows only.
 * Input the app never sends gets an empty, done page.
 */
export const search_saved = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		savedStream: v.optional(files_saved_stream_validator),
		searchGeneration: v.optional(v.number()),
		clause: v.union(
			// Whole words and word starts of the name. `nodeKind` lists only files or only folders.
			v.object({
				kind: v.literal("name"),
				text: v.string(),
				nodeKind: v.optional(doc(app_convex_schema, "files_nodes").fields.kind),
			}),
			v.object({ kind: v.literal("content"), text: v.string() }),
			// One plan of `files_search_query_to_plans`. A chip with two plans is two calls.
			v.object({
				kind: v.literal("metadata"),
				plan: files_metadata_search_plan_validator,
			}),
			// An exact path, with its case, or a saved node id.
			v.object({ kind: v.literal("path"), path: v.string() }),
			// `file.link:public`: the files with a public link.
			v.object({ kind: v.literal("link") }),
		),
		/**
		 * The exact path of the folder to search inside. Names, metadata `eq` and `exists`, and links
		 * take one.
		 */
		folderPath: v.optional(v.string()),
		paginationOpts: paginationOptsValidator,
	},
	returns: paginationResultValidator(
		v.union(
			v.object({
				kind: doc(app_convex_schema, "files_nodes").fields.kind,
				nodeId: v.id("files_nodes"),
				path: doc(app_convex_schema, "files_nodes").fields.path,
				// The media picker shows files that are not images or videos as disabled.
				contentType: doc(app_convex_schema, "files_nodes").fields.contentType,
				// Content rows only: the first matching chunk of the file on this page.
				textChunk: v.optional(v.string()),
				lineStart: v.optional(v.number()),
			}),
			v.object({
				kind: v.literal("problem"),
				message: v.union(
					v.literal("Folder not found"),
					v.literal("This folder is too deep to search inside. Search a folder higher up"),
				),
			}),
		),
	),
	handler: async (ctx, args) => {
		// Saved rows only: UI lists never show drafts. Drafts show in the Pending tab, in the draft
		// folder view and to the agent (files-explorer-tree skill, "Saved-only lists").

		const refused = { page: [], isDone: true, continueCursor: "" };

		const reader = await files_nodes_db_get_tree_reader(ctx, { membershipId: args.membershipId });
		if (!reader) {
			return refused;
		}
		const { userAuth, membership } = reader;
		const clause = args.clause;
		const saved = await files_saved_stream_db_create(ctx.db, membership, args.savedStream);
		if (args.searchGeneration !== undefined && args.searchGeneration !== saved.view.searchGeneration) {
			throw convex_invalid_cursor_error("The saved search view changed.");
		}
		const paginationOpts = {
			...args.paginationOpts,
			numItems: Math.min(args.paginationOpts.numItems, SEARCH_SAVED_MAX_ITEMS),
		};

		/**
		 * Keep the active nodes of the membership's workspace that the caller may read, once each.
		 */
		const readable_rows = async (nodes: Array<Doc<"files_nodes"> | null>) => {
			const byId = new Map<Id<"files_nodes">, Doc<"files_nodes">>();
			for (const node of nodes) {
				if (
					node?.archiveOperationId === null &&
					node.organizationId === membership.organizationId &&
					node.workspaceId === membership.workspaceId
				) {
					byId.set(node._id, node);
				}
			}
			const readable = await access_control_db_filter_readable_file_nodes(ctx, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: userAuth.id,
				hasWorkspaceRead: reader.hasWorkspaceRead,
				nodes: [...byId.values()],
			});
			return readable.map((node) => ({
				kind: node.kind,
				nodeId: node._id,
				path: node.path,
				contentType: node.contentType,
			}));
		};

		if (clause.kind === "path") {
			if (saved.tag) return refused;
			if (args.folderPath !== undefined || clause.path.length > SEARCH_SAVED_PATH_MAX_LENGTH) {
				return refused;
			}
			// A pasted link holds the node id.
			const nodeId = clause.path.startsWith("/")
				? (
						await files_db_get_visible_node_by_path(ctx, {
							organizationId: membership.organizationId,
							workspaceId: membership.workspaceId,
							path: clause.path,
						})
					)?._id
				: ctx.db.normalizeId("files_nodes", clause.path);
			return {
				...refused,
				page: await readable_rows([nodeId ? await files_saved_placement_db_get_node(ctx.db, nodeId) : null]),
			};
		}

		// The folder comes from its saved row, never from the typed text: its stored ancestors and
		// tree path scope the read. A missing, unreadable or archived folder answers the same.
		let folder: Doc<"files_nodes"> | null = null;
		if (args.folderPath !== undefined && args.folderPath !== "/") {
			const folderNode =
				args.folderPath.startsWith("/") && args.folderPath.length <= SEARCH_SAVED_PATH_MAX_LENGTH
					? await files_db_get_visible_node_by_path(ctx, {
							organizationId: membership.organizationId,
							workspaceId: membership.workspaceId,
							path: args.folderPath,
						})
					: null;
			folder =
				folderNode?.kind === "folder" ? await db_get_readable_tree_node(ctx, { reader, nodeId: folderNode._id }) : null;
			if (!folder) {
				return { ...refused, page: [{ kind: "problem" as const, message: "Folder not found" as const }] };
			}
			// A node keeps only its top 12 ancestors, so a deeper folder cannot scope a name search.
			if (folder.pathDepth > files_ANCESTOR_FIELD_COUNT) {
				return {
					...refused,
					page: [
						{
							kind: "problem" as const,
							message: "This folder is too deep to search inside. Search a folder higher up" as const,
						},
					],
				};
			}
		}
		const folderId = folder?._id ?? null;
		const folderTreePath = folder?.treePath ?? null;

		if (clause.kind === "name" || clause.kind === "content") {
			const text = clause.text.trim();
			// Contents have no folder scope in the search box.
			if (text.length === 0 || text.length > SEARCH_SAVED_TEXT_MAX_LENGTH || (clause.kind === "content" && folder)) {
				return refused;
			}

			if (clause.kind === "name") {
				const nodeKind = clause.nodeKind;
				// A node is under the folder exactly when its ancestor at the folder's depth is the folder.
				const ancestorField = `ancestor${folder?.pathDepth ?? 1}` as Extract<
					keyof Doc<"files_nodes">,
					`ancestor${number}`
				>;
				const result = saved.tag
					? await ctx.db
							.query("files_saved_places")
							.withSearchIndex("search_name", (q) => {
								const active = q
									.search("name", text)
									.eq("cohortId", saved.tag!.cohortId)
									.eq("view", saved.tag!.view)
									.eq("archiveOperationId", null);
								const kinded = nodeKind ? active.eq("kind", nodeKind) : active;
								return folderId ? kinded.eq(ancestorField, folderId) : kinded;
							})
							.paginate(paginationOpts)
					: await ctx.db
							.query("files_nodes")
							.withSearchIndex("search_name", (q) => {
								const active = q
									.search("name", text)
									.eq("workspaceId", membership.workspaceId)
									.eq("moveCohortId", undefined)
									.eq("archiveOperationId", null);
								const kinded = nodeKind ? active.eq("kind", nodeKind) : active;
								return folderId ? kinded.eq(ancestorField, folderId) : kinded;
							})
							.paginate(paginationOpts);
				if (result.page.length > SEARCH_SAVED_MAX_ITEMS) {
					throw convex_invalid_cursor_error("The search page grew past its cap");
				}
				return { ...result, page: await readable_rows(await saved.read_nodes(result.page)) };
			}

			// Committed chunks only: drafts never count toward the top matches.
			const result = await ctx.db
				.query("files_plain_text_chunks")
				.withSearchIndex("search_by_plainTextChunk", (q) =>
					q
						.search("plainTextChunk", text)
						.eq("organizationId", membership.organizationId)
						.eq("workspaceId", membership.workspaceId)
						.eq("archiveOperationId", undefined)
						.eq("sourceKind", "committed")
						.eq("moveView.cohortId", saved.tag?.cohortId)
						.eq("moveView.view", saved.tag?.view),
				)
				.paginate(paginationOpts);
			if (result.page.length > SEARCH_SAVED_MAX_ITEMS) {
				throw convex_invalid_cursor_error("The search page grew past its cap");
			}
			const chunks = result.page.flatMap((chunk) => (chunk.sourceKind === "committed" ? [chunk] : []));
			const rows = await readable_rows(
				await Promise.all(
					chunks.map((chunk) => files_saved_placement_db_get_node(ctx.db, chunk.fileNodeId, saved.tag)),
				),
			);
			return {
				...result,
				page: rows.map((row) => {
					// Chunks come in relevance order, so the first chunk of a file is its best one.
					const chunk = chunks.find((searchChunk) => searchChunk.fileNodeId === row.nodeId)!;
					return { ...row, textChunk: chunk.textChunk, lineStart: chunk.lineStart };
				}),
			};
		}

		if (clause.kind === "metadata") {
			const plan = clause.plan;
			// A folder scopes `eq` and `exists` only: `prefix` and `range` put their range on the value.
			if (
				plan.fieldPath.length > files_search_query_FIELD_PATH_MAX_LENGTH ||
				!files_search_query_field_path_is_valid(plan.fieldPath) ||
				(folder && (plan.op === "prefix" || plan.op === "range"))
			) {
				return refused;
			}
			const result = await files_metadata_db_query_saved_plan(ctx, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				plan,
				treePathPrefix: folderTreePath,
				moveView: saved.tag,
			}).paginate(paginationOpts);
			if (tree_page_needs_split(result, SEARCH_SAVED_SPLIT_GUARD)) {
				return tree_page_split_required(result);
			}
			return {
				...result,
				page: await readable_rows(
					await Promise.all(
						result.page.map(async (metadataDoc) =>
							metadataDoc.sourceKind === "committed"
								? await files_saved_placement_db_get_node(ctx.db, metadataDoc.fileNodeId, saved.tag)
								: null,
						),
					),
				),
			};
		}

		// `set_node_share_link` keeps at most 500 links in a workspace, so a folder can drop rows of a
		// page here instead of in an index range.
		if (saved.tag) return refused;
		const result = await ctx.db
			.query("files_share_links")
			.withIndex("by_organization_workspace_node", (q) =>
				q.eq("organizationId", membership.organizationId).eq("workspaceId", membership.workspaceId),
			)
			.paginate(paginationOpts);
		if (tree_page_needs_split(result, SEARCH_SAVED_SPLIT_GUARD)) {
			return tree_page_split_required(result);
		}
		const nodes = await Promise.all(
			result.page.map(async (link) =>
				(await files_share_links_db_is_selected(ctx.db, link))
					? await files_saved_placement_db_get_node(ctx.db, link.nodeId)
					: null,
			),
		);
		return {
			...result,
			page: await readable_rows(
				nodes.filter((node) => folderTreePath === null || node?.treePath.startsWith(folderTreePath)),
			),
		};
	},
});

export const profile_text_search_files = internalAction({
	args: {
		...text_search_args,
		numItems: v.number(),
		cursor: paginationOptsValidator.fields.cursor,
	},
	returns: v.object({
		durationMs: v.number(),
		itemCount: v.number(),
		continueCursor: v.string(),
		isDone: v.boolean(),
		firstPaths: v.array(v.string()),
	}),
	handler: async (ctx, args) => {
		const startedAt = Date.now();
		const result: files_nodes_text_search_files_Result = await ctx.runQuery(
			internal.files_nodes.text_search_files,
			args,
		);
		return {
			durationMs: Date.now() - startedAt,
			itemCount: result.items.length,
			continueCursor: result.continueCursor,
			isDone: result.isDone,
			firstPaths: result.items.slice(0, 5).map((item) => item.path),
		};
	},
});

export const get_file_snapshots_list = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
		showArchived: v.boolean(),
	},
	returns: v.object({
		snapshots: v.array(doc(app_convex_schema, "files_snapshots")),
	}),
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
			return {
				snapshots: [],
			};
		}

		// Against the node, not the workspace: a file's version list says when it changed and how
		// often, and a restricted file must not answer that to everybody in the workspace.
		const authorized = await access_control_db_authorize_node(ctx, {
			userAuth,
			membership,
			nodeId: args.nodeId,
			permission: "content.read",
		});
		if (authorized._nay) {
			return {
				snapshots: [],
			};
		}

		const snapshots = await ctx.db
			.query("files_snapshots")
			.withIndex("by_organization_workspace_fileNode_archivedAt", (q) => {
				const qBase = q
					.eq("organizationId", membership.organizationId)
					.eq("workspaceId", membership.workspaceId)
					.eq("fileNodeId", args.nodeId);

				const qFinal = args.showArchived ? qBase.gt("archivedAt", 0) : qBase.lte("archivedAt", 0);

				return qFinal;
			})
			.order("desc")
			.collect();

		return {
			snapshots,
		};
	},
});

export const get_file_snapshot = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
		snapshotId: v.id("files_snapshots"),
	},
	returns: v.union(doc(app_convex_schema, "files_snapshots"), v.null()),
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

		const snapshot = await ctx.db.get("files_snapshots", args.snapshotId);
		if (!snapshot) {
			return null;
		}

		if (
			snapshot.organizationId !== membership.organizationId ||
			snapshot.workspaceId !== membership.workspaceId ||
			snapshot.fileNodeId !== args.nodeId
		) {
			return null;
		}

		return snapshot;
	},
});

export async function db_get_file_snapshot_content(
	ctx: QueryCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		nodeId: Id<"files_nodes">;
		snapshotId: Id<"files_snapshots">;
	},
) {
	const snapshot = await ctx.db.get("files_snapshots", args.snapshotId);
	if (
		!snapshot ||
		snapshot.organizationId !== args.organizationId ||
		snapshot.workspaceId !== args.workspaceId ||
		snapshot.fileNodeId !== args.nodeId
	) {
		return null;
	}

	const asset = await ctx.db
		.get("files_r2_assets", snapshot.assetId)
		.then((asset) =>
			asset && asset.organizationId === args.organizationId && asset.workspaceId === args.workspaceId ? asset : null,
		);
	if (!asset) {
		return null;
	}

	return {
		asset,
		snapshotId: snapshot._id,
		_creationTime: snapshot._creationTime,
		contentType: snapshot.contentType,
		yjsRootKind: snapshot.yjsRootKind,
		collaborationEnabled: snapshot.collaborationEnabled,
	};
}

export const get_data_for_create_file_snapshot_content_url = internalQuery({
	args: {
		userId: v.id("users"),
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
		snapshotId: v.id("files_snapshots"),
	},
	returns: v.union(
		v.object({
			asset: doc(app_convex_schema, "files_r2_assets"),
			snapshotId: v.id("files_snapshots"),
			_creationTime: v.number(),
			/**
			 * The version's own content type. The signer pins the served type from it.
			 */
			contentType: doc(app_convex_schema, "files_snapshots").fields.contentType,
			yjsRootKind: doc(app_convex_schema, "files_snapshots").fields.yjsRootKind,
			collaborationEnabled: doc(app_convex_schema, "files_snapshots").fields.collaborationEnabled,
			/**
			 * The AUTHORIZED node's name, for the disposition file name. The signer must use this
			 * server-resolved value, never a caller-supplied name.
			 */
			fileName: v.string(),
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
			permission: "content.read",
		});
		if (authorized._nay) {
			return null;
		}

		const snapshotContent = await db_get_file_snapshot_content(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			nodeId: args.nodeId,
			snapshotId: args.snapshotId,
		});
		if (!snapshotContent) {
			return null;
		}

		return {
			...snapshotContent,
			fileName: authorized._yay.fileNode.name,
		};
	},
});

type get_data_for_create_file_snapshot_content_url_Result =
	typeof get_data_for_create_file_snapshot_content_url extends RegisteredQuery<
		infer _Visibility,
		infer _Args,
		infer ReturnValue
	>
		? Awaited<ReturnValue>
		: never;

export const create_file_snapshot_content_url = action({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
		snapshotId: v.id("files_snapshots"),
	},
	returns: v.union(
		v.object({
			url: v.string(),
			snapshotId: v.id("files_snapshots"),
			_creationTime: v.number(),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			throw convex_error({ message: "Unauthenticated" });
		}

		const data = (await ctx.runQuery(internal.files_nodes.get_data_for_create_file_snapshot_content_url, {
			userId: userAuth.id,
			membershipId: args.membershipId,
			nodeId: args.nodeId,
			snapshotId: args.snapshotId,
		})) as get_data_for_create_file_snapshot_content_url_Result;
		if (!data) {
			return null;
		}
		if (!data.asset.r2Key) {
			const errorMessage = "snapshot.assetId points to an asset without r2Key";
			const errorData = {
				nodeId: args.nodeId,
				snapshotId: args.snapshotId,
				assetId: data.asset._id,
			};
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}

		// A presigned R2 GET has no nosniff/CSP, so the pinned type plus the disposition below is
		// the whole defense. The type is the version's own stored type, and the name is the
		// authorized node name the query returned, never a caller-supplied name.
		const serving = files_get_signed_download_serving({ contentType: data.contentType, fileName: data.fileName });
		return {
			url: await r2.getUrl(data.asset.r2Key, {
				expiresIn: 15 * 60,
				responseContentType: serving.responseContentType,
				responseContentDisposition: serving.responseContentDisposition,
			}),
			snapshotId: data.snapshotId,
			_creationTime: data._creationTime,
		};
	},
});

export const archive_snapshot = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		snapshotId: v.id("files_snapshots"),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "files_snapshot_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return Result({ _yay: null });
		}

		// The snapshot comes first here, because the permission belongs to the file it is a version of.
		// This mutation takes only a snapshot id, so there is no node to check until it is loaded.
		const snapshot = await ctx.db.get("files_snapshots", args.snapshotId);
		if (
			!snapshot ||
			snapshot.organizationId !== membership.organizationId ||
			snapshot.workspaceId !== membership.workspaceId
		) {
			return Result({ _yay: null });
		}

		const authorized = await access_control_db_authorize_node(ctx, {
			userAuth,
			membership,
			nodeId: snapshot.fileNodeId,
			permission: "content.write",
		});
		if (authorized._nay) {
			return authorized;
		}

		// A read-only file still allows snapshot reads and downloads.
		// Archiving a snapshot changes version history, so it is blocked.
		const nodeWritable = await files_nodes_db_require_user_writable(ctx, {
			node: authorized._yay.fileNode,
			userId: userAuth.id,
		});
		if (nodeWritable._nay) {
			return nodeWritable;
		}

		await ctx.db.patch("files_snapshots", args.snapshotId, {
			archivedAt: Date.now(),
		});

		return Result({ _yay: null });
	},
});

export const unarchive_snapshot = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		snapshotId: v.id("files_snapshots"),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "files_snapshot_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return Result({ _yay: null });
		}

		// Same order as `archive_snapshot`: the snapshot names the file, and the file carries the
		// permission.
		const snapshot = await ctx.db.get("files_snapshots", args.snapshotId);
		if (
			!snapshot ||
			snapshot.organizationId !== membership.organizationId ||
			snapshot.workspaceId !== membership.workspaceId
		) {
			return Result({ _yay: null });
		}

		const authorized = await access_control_db_authorize_node(ctx, {
			userAuth,
			membership,
			nodeId: snapshot.fileNodeId,
			permission: "content.write",
		});
		if (authorized._nay) {
			return authorized;
		}

		// A read-only file still allows snapshot reads.
		// Restoring an archived snapshot changes version history, so it is blocked.
		const nodeWritable = await files_nodes_db_require_user_writable(ctx, {
			node: authorized._yay.fileNode,
			userId: userAuth.id,
		});
		if (nodeWritable._nay) {
			return nodeWritable;
		}

		await ctx.db.patch("files_snapshots", args.snapshotId, {
			archivedAt: 0,
		});
		return Result({ _yay: null });
	},
});

export const get_data_for_yjs_prepare_doc_last_snapshot = internalQuery({
	args: {
		userId: v.id("users"),
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
	},
	returns: v.union(file_content_materialization_state_validator, v.null()),
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
			permission: "content.read",
		});
		if (authorized._nay) {
			return null;
		}

		return await db_get_file_content_materialization_db_state(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			nodeId: args.nodeId,
		});
	},
});

type get_data_for_yjs_prepare_doc_last_snapshot_Result =
	typeof get_data_for_yjs_prepare_doc_last_snapshot extends RegisteredQuery<
		infer _Visibility,
		infer _Args,
		infer ReturnValue
	>
		? Awaited<ReturnValue>
		: never;

export const yjs_prepare_doc_last_snapshot = action({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
	},
	returns: v.union(
		v.object({
			snapshot: doc(app_convex_schema, "files_yjs_snapshots"),
			snapshotUrl: v.string(),
			yjsLastSequenceId: v.id("files_yjs_docs_last_sequences"),
			// A live document always has an editable text shape.
			textKind: v.union(v.literal("rich_text"), v.literal("plain_text")),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			throw convex_error({ message: "Unauthenticated" });
		}

		const data = (await ctx.runQuery(internal.files_nodes.get_data_for_yjs_prepare_doc_last_snapshot, {
			userId: userAuth.id,
			membershipId: args.membershipId,
			nodeId: args.nodeId,
		})) as get_data_for_yjs_prepare_doc_last_snapshot_Result;
		if (!data) {
			return null;
		}

		if (!data.yjsSnapshotAsset.r2Key) {
			const errorMessage = "yjsSnapshotAsset.r2Key is not set";
			const errorData = {
				nodeId: args.nodeId,
				assetId: data.yjsSnapshotAsset._id,
			};
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}

		return {
			snapshot: data.yjsSnapshotDoc,
			snapshotUrl: await r2.getUrl(data.yjsSnapshotAsset.r2Key, {
				expiresIn: 15 * 60,
			}),
			yjsLastSequenceId: data.yjsLastSequenceDoc._id,
			textKind: data.fileNode.textKind,
		};
	},
});

/**
 * Refusal message returned while a durable shape/state marker is set on the node. All three
 * update writers refuse new edits until the operator repair clears the marker.
 */
export const files_yjs_NODE_NEEDS_REPAIR_MESSAGE = "File is not accepting new edits until an operator repairs it";

/**
 * The shared reserve-and-increment gate for the three `files_yjs_updates` writers (door 1,
 * snapshot restore, public fill). Every sequence increment inserts exactly one update doc, so
 * this helper also maintains the aggregate unmaterialized counters (absent means 0).
 *
 * Refusals happen BEFORE the sequence increment, so a refused write leaves no bumped
 * `lastSequence` without an update doc:
 * - empty or over-`files_MAX_YJS_WIRE_BYTES` docs are rejected (the trusted writers skip door
 *   1's content scan, but every stored doc must stay under the Convex value cap);
 * - while a durable shape/state marker is set on the node, all writers refuse until repair;
 * - when the aggregate byte/count budget would be crossed, schedule immediate materialization
 *   and return a visible retry message without a sequence or update write.
 */
export async function yjs_reserve_and_increment_last_sequence(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		nodeId: Id<"files_nodes">;
		userId: Id<"users">;
		/**
		 * Refuse when this write was built for a Yjs document that the file no longer uses.
		 */
		expectedYjsLastSequenceId: Id<"files_yjs_docs_last_sequences">;
		/** Byte size of the `files_yjs_updates.update` value the caller inserts at the new sequence. */
		updateByteLength: number;
	},
) {
	if (args.updateByteLength === 0) {
		return Result({ _nay: { message: "Empty update" } });
	}
	if (args.updateByteLength > files_MAX_YJS_WIRE_BYTES) {
		return Result({ _nay: { message: "Update too large" } });
	}

	const fileNode = await ctx.db.get("files_nodes", args.nodeId);
	if (
		!fileNode ||
		fileNode.organizationId !== args.organizationId ||
		fileNode.workspaceId !== args.workspaceId ||
		!files_node_has_editable_yjs_state(fileNode)
	) {
		return Result({ _nay: { message: "Not found" } });
	}
	if (fileNode.yjsLastSequenceId !== args.expectedYjsLastSequenceId) {
		return Result({
			_nay: {
				message: "This file changed while you were editing. Copy your local changes before reloading, then try again.",
			},
		});
	}
	// A durable refusal marker means materialization already refused this file's state and an
	// operator repair is the only exit; accepting more updates would only grow the broken log.
	if (fileNode.contentShapeMismatchAt !== null || fileNode.contentYjsStateTooLargeByteSize !== null) {
		return Result({ _nay: { message: files_yjs_NODE_NEEDS_REPAIR_MESSAGE } });
	}

	const lastSequenceData = await ctx.db.get("files_yjs_docs_last_sequences", args.expectedYjsLastSequenceId);
	if (
		!lastSequenceData ||
		lastSequenceData.organizationId !== args.organizationId ||
		lastSequenceData.workspaceId !== args.workspaceId ||
		lastSequenceData.fileNodeId !== args.nodeId
	) {
		const errorMessage = "fileNode.yjsLastSequenceId points to a missing or mismatched last-sequence doc";
		console.error(errorMessage, { nodeId: args.nodeId, yjsLastSequenceId: args.expectedYjsLastSequenceId });
		throw should_never_happen(errorMessage, {
			nodeId: args.nodeId,
			yjsLastSequenceId: args.expectedYjsLastSequenceId,
		});
	}

	// Enforce the aggregate budget before the increment. On a would-cross, materialize what is
	// already stored right away and ask the caller to retry: nothing is written here, so the
	// refusal cannot leave a bumped sequence behind.
	if (lastSequenceData) {
		const nextCount = lastSequenceData.unmaterializedUpdateCount + 1;
		const nextBytes = lastSequenceData.unmaterializedUpdateBytes + args.updateByteLength;
		if (
			nextCount > files_MAX_UNMATERIALIZED_YJS_UPDATE_COUNT ||
			nextBytes > files_MAX_UNMATERIALIZED_YJS_UPDATE_BYTES
		) {
			// A settle marker (too-large text or over-cap frontmatter) means materialization
			// completes without advancing the committed content, so the counters can never
			// shrink and "retry in a moment" would be permanently false. The repair path is the
			// only exit in that state, so return the repair message instead of enqueueing a
			// materialization that would settle again without freeing budget.
			if (
				fileNode.contentTooLargeByteSize !== null ||
				fileNode.contentFrontmatterTooLargeFieldCount !== null ||
				fileNode.contentFrontmatterTooLargeIndexDocumentCount !== null
			) {
				return Result({ _nay: { message: files_yjs_NODE_NEEDS_REPAIR_MESSAGE } });
			}
			await enqueue_file_content_materialization(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				nodeId: args.nodeId,
				userId: args.userId,
				targetSequence: lastSequenceData.lastSequence,
				delayMs: 0,
			});
			return Result({ _nay: { message: files_yjs_COMPACTION_RETRY_MESSAGE } });
		}
	}

	await ctx.db.patch("files_yjs_docs_last_sequences", lastSequenceData._id, {
		lastSequence: lastSequenceData.lastSequence + 1,
		unmaterializedUpdateCount: lastSequenceData.unmaterializedUpdateCount + 1,
		unmaterializedUpdateBytes: lastSequenceData.unmaterializedUpdateBytes + args.updateByteLength,
	});

	return Result({
		_yay: {
			...lastSequenceData,
			lastSequence: lastSequenceData.lastSequence + 1,
			unmaterializedUpdateCount: lastSequenceData.unmaterializedUpdateCount + 1,
			unmaterializedUpdateBytes: lastSequenceData.unmaterializedUpdateBytes + args.updateByteLength,
		},
	});
}

export async function files_db_yjs_push_update(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		nodeId: Id<"files_nodes">;
		update: ArrayBuffer;
		sessionId: string;
		userId: Id<"users">;
		expectedYjsLastSequenceId: Id<"files_yjs_docs_last_sequences">;
		/**
		 * The shape stored on the node (`textKind`). Both callers already hold the node; this
		 * function does not load it, so the scan below needs the value here.
		 */
		rootKind: files_YjsRootKind;
		/**
		 * True for one-shot commits (save/accept) so committed chunks refresh right away
		 * and readers do not see stale content. False for live editor keystreams:
		 * materialization keeps the 30s debounce (each push reschedules the job).
		 */
		materializeImmediately: boolean;
	},
) {
	// Door 1: the byte checks and the content scan are the FIRST statements — above every write.
	// `yjs_reserve_and_increment_last_sequence` writes, and a returning Convex mutation commits,
	// so a scan placed between the increment and the insert would commit a bumped `lastSequence`
	// with no `files_yjs_updates` doc on every refusal. The raw byte checks also run before the
	// first decode so an oversized payload is never decoded.
	// Zero bytes are not a legal wire no-op: merging a stored zero-byte update into the next
	// snapshot throws forever. The canonical two-byte v1 no-op remains legal.
	if (args.update.byteLength === 0) {
		return Result({ _nay: { message: "Empty update" } });
	}
	if (args.update.byteLength > files_MAX_YJS_WIRE_BYTES) {
		return Result({ _nay: { message: "Update too large" } });
	}
	const scan = files_yjs_scan_client_update({ update: new Uint8Array(args.update), rootKind: args.rootKind });
	if (scan._nay) {
		// Log with the node id here: the shared scan has no id to log. Keep the content kinds
		// only — the update's bytes were refused, so nothing else is safe to log.
		console.warn("Refused client Yjs update", {
			nodeId: args.nodeId,
			rootKind: args.rootKind,
			message: scan._nay.message,
			cause: scan._nay.cause,
		});
		return scan;
	}

	const now = Date.now();

	const reserved = await yjs_reserve_and_increment_last_sequence(ctx, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		nodeId: args.nodeId,
		userId: args.userId,
		expectedYjsLastSequenceId: args.expectedYjsLastSequenceId,
		updateByteLength: args.update.byteLength,
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
		update: args.update,
		origin: {
			type: "USER_EDIT",
			sessionId: args.sessionId,
		},
		createdBy: args.userId,
		createdAt: now,
	});

	const snapshotScheduleDelayMs = args.materializeImmediately
		? 0
		: newSequenceData.lastSequence > 0 && newSequenceData.lastSequence % 50 === 0
			? 0
			: 30_000;

	await enqueue_file_content_materialization(ctx, {
		userId: args.userId,
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		nodeId: args.nodeId,
		targetSequence: newSequenceData.lastSequence,
		delayMs: snapshotScheduleDelayMs,
	});

	return Result({ _yay: { newSequence: newSequenceData.lastSequence } });
}

export const yjs_push_update = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
		update: v.bytes(),
		sessionId: v.string(),
		expectedYjsLastSequenceId: v.id("files_yjs_docs_last_sequences"),
	},
	returns: v_result({
		_yay: v.object({
			newSequence: v.number(),
		}),
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "files_yjs_push_update", key: userAuth.id });
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

		const fileNode = await ctx.db.get("files_nodes", args.nodeId);
		if (!fileNode) {
			return Result({ _nay: { message: "Not found" } });
		}
		if (fileNode.organizationId !== membership.organizationId || fileNode.workspaceId !== membership.workspaceId) {
			return Result({ _nay: { message: "Unauthorized" } });
		}
		if (!files_node_has_editable_yjs_state(fileNode)) {
			return Result({ _nay: { message: "Not found" } });
		}

		const authorized = await access_control_db_authorize_membership(ctx, {
			userAuth,
			membership,
			permission: "content.write",
			fileNode,
		});
		if (authorized._nay) {
			return authorized;
		}

		// Check the current lock before reserving a sequence.
		// An old lock does not matter after the file becomes writable again.
		const writable = await files_nodes_db_require_user_writable(ctx, { node: fileNode, userId: userAuth.id });
		if (writable._nay) {
			return writable;
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

		const pushResult = await files_db_yjs_push_update(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			nodeId: args.nodeId,
			update: args.update,
			sessionId: args.sessionId,
			userId: user._id,
			expectedYjsLastSequenceId: args.expectedYjsLastSequenceId,
			rootKind: fileNode.textKind,
			// Live editor keystream: keep the materialization debounce.
			materializeImmediately: false,
		});
		if (pushResult._nay) {
			// Log the cause and return a message-only `_nay`; a `cause` field would fail the
			// `v_result` returns validator this Result crosses.
			if (pushResult._nay.cause !== undefined) {
				console.warn("Client Yjs update push refused", {
					nodeId: args.nodeId,
					message: pushResult._nay.message,
					cause: pushResult._nay.cause,
				});
				return Result({ _nay: { message: pushResult._nay.message } });
			}
			return pushResult;
		}

		// Bill with the lineage id too. Turning collaboration off and on again starts a new lineage
		// at sequence 0, so the sequence alone would repeat an id Polar has already seen.
		const saveVersion = `${args.expectedYjsLastSequenceId}:${pushResult._yay.newSequence}`;
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
							organizationId: fileNode.organizationId,
							workspaceId: fileNode.workspaceId,
							nodeId: args.nodeId,
							version: saveVersion,
						},
					}),
				},
			],
		});

		return pushResult;
	},
});

export const yjs_get_incremental_updates = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
	},
	returns: v.union(
		v.object({
			yjsLastSequenceId: v.id("files_yjs_docs_last_sequences"),
			updates: v.array(doc(app_convex_schema, "files_yjs_updates")),
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

		const fileNode = await files_saved_placement_db_get_node(ctx.db, args.nodeId);
		if (
			!fileNode ||
			fileNode.organizationId !== membership.organizationId ||
			fileNode.workspaceId !== membership.workspaceId ||
			fileNode.kind !== "file"
		) {
			return null;
		}

		const authorized = await access_control_db_authorize_membership(ctx, {
			userAuth,
			membership,
			permission: "content.read",
			fileNode,
		});
		if (authorized._nay) {
			return null;
		}

		if (!fileNode.yjsLastSequenceId) {
			return null;
		}

		const sequence = await files_saved_placement_db_get_sequence(ctx.db, fileNode);
		if (!sequence) return null;
		const updates = await files_saved_content_collect(
			files_saved_content_db_yjs_updates(ctx.db, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				nodeId: args.nodeId,
				order: "desc",
				throughSequence: sequence.lastSequence,
			}),
		);

		// Return the exact lineage even when the log is empty. Clients fetch the snapshot and update
		// log separately, so they need this token to refuse a mixed-lineage read.
		return { yjsLastSequenceId: fileNode.yjsLastSequenceId, updates };
	},
});

// #region snapshots

const SNAPSHOT_CLEANUP_BATCH_SIZE = 200;

/**
 * Internal mutation to cleanup old snapshots based on retention rules.
 * Runs daily at 5AM UTC via cron job. Each run scans one bounded newest-first page of the 60-day
 * window and reschedules itself with the page cursor until the window is covered, so the mutation
 * stays inside Convex transaction limits no matter how many snapshots exist.
 *
 * Retention rules:
 * - Older than 30 days: keep only the last snapshot for each week
 * - Older than 7 days (but <= 30 days): keep only the last snapshot for each day
 * - Older than 1 day (but <= 7 days): keep only the last snapshot each hour
 * - <= 1 day old: keep all snapshots
 */
export const cleanup_old_snapshots = internalMutation({
	args: {
		/**
		 * Sweep wall time (ms). The first run leaves it unset and uses `Date.now()`. Continuation
		 * runs pass the first run's value along so the 60-day scan bound stays identical across
		 * batches and the pagination cursor stays valid. Tests may set it to pin the window.
		 */
		now: v.optional(v.number()),
		batchSize: v.optional(v.number()),
		cursor: v.optional(v.string()),
	},
	returns: v.object({
		deletedCount: v.number(),
		done: v.boolean(),
	}),
	handler: async (ctx, args) => {
		const now = args.now ?? Date.now();
		const batchSize = Math.min(Math.max(args.batchSize ?? SNAPSHOT_CLEANUP_BATCH_SIZE, 1), 1000);
		const timestamp60DaysAgo = now - 60 * date_MS_DAY;

		const page = await ctx.db
			.query("files_snapshots")
			.withIndex("by_creation_time", (q) => q.gte("_creationTime", timestamp60DaysAgo))
			.order("desc")
			.paginate({ numItems: batchSize, cursor: args.cursor ?? null });

		// The per-slot dedup set restarts empty on every batch. When a slot's newest snapshot
		// landed in an earlier batch, the first same-slot snapshot of this batch is kept as if it
		// were the newest, so a page boundary can only over-retain: deleting still requires a newer
		// same-slot snapshot inside this same batch. The next daily sweep prunes those leftovers
		// once page boundaries move.
		const latestSnapshotNodeIdWithTimeSlot = new Set<string>();
		const snapshotsToDelete: Array<{
			snapshotId: Id<"files_snapshots">;
			assetId: Id<"files_r2_assets">;
			r2Key: string;
		}> = [];

		for (const snapshot of page.page) {
			const age = now - snapshot._creationTime;
			let keepSnapshot = false;

			// If the snapshot is less than 1 day old, keep it
			if (age <= date_MS_DAY) {
				keepSnapshot = true;
			} else {
				// If the snapshot is older than 1 day, we need to determine the time slot it belongs to
				let bucketTimestamp: number;

				if (age > date_MS_DAYS_30) {
					bucketTimestamp = date_get_week_start_timestamp(snapshot._creationTime);
				} else if (age > date_MS_WEEK) {
					bucketTimestamp = date_get_day_start_timestamp(snapshot._creationTime);
				} else {
					bucketTimestamp = date_get_hour_start_timestamp(snapshot._creationTime);
				}

				// If this is the first snapshot for this time slot, it means it's the latest
				// therefore we keep it
				const snapshotTimeSlotKey = `${snapshot.fileNodeId}::${bucketTimestamp}`;
				if (!latestSnapshotNodeIdWithTimeSlot.has(snapshotTimeSlotKey)) {
					latestSnapshotNodeIdWithTimeSlot.add(snapshotTimeSlotKey);
					keepSnapshot = true;
				}
			}

			if (keepSnapshot) {
				continue;
			}

			// Never delete the snapshot the node points at: it holds the file's current bytes and
			// must stay downloadable. The newest-first rule alone is not safe here: a restore
			// writes two snapshots in one transaction, so they share the same creation time.
			const node = await ctx.db.get("files_nodes", snapshot.fileNodeId);
			if (node?.assetId === snapshot.assetId) {
				continue;
			}
			const claim = await ctx.db
				.query("files_move_asset_claims")
				.withIndex("by_asset", (q) => q.eq("assetId", snapshot.assetId))
				.first();
			if (claim) continue;

			const asset = await ctx.db.get("files_r2_assets", snapshot.assetId);
			if (
				!asset ||
				asset.organizationId !== snapshot.organizationId ||
				asset.workspaceId !== snapshot.workspaceId ||
				asset.kind !== "content_snapshot"
			) {
				const errorMessage = "snapshot.assetId points to a missing or mismatched files_r2_assets doc";
				const errorData = {
					snapshotId: snapshot._id,
					assetId: snapshot.assetId,
				};
				console.error(errorMessage, errorData);
				throw should_never_happen(errorMessage, errorData);
			}
			if (!asset.r2Key) {
				const errorMessage = "snapshotAsset.r2Key is not set";
				const errorData = {
					snapshotId: snapshot._id,
					assetId: asset._id,
				};
				console.error(errorMessage, errorData);
				throw should_never_happen(errorMessage, errorData);
			}

			snapshotsToDelete.push({
				snapshotId: snapshot._id,
				assetId: asset._id,
				r2Key: asset.r2Key,
			});
		}

		await Promise.all(snapshotsToDelete.map((snapshot) => r2.deleteObject(ctx, snapshot.r2Key)));
		await Promise.all(snapshotsToDelete.map((snapshot) => ctx.db.delete("files_snapshots", snapshot.snapshotId)));
		await Promise.all(snapshotsToDelete.map((snapshot) => ctx.db.delete("files_r2_assets", snapshot.assetId)));

		if (!page.isDone) {
			await ctx.scheduler.runAfter(0, internal.files_nodes.cleanup_old_snapshots, {
				now,
				batchSize: args.batchSize,
				cursor: page.continueCursor,
			});
		}

		return { deletedCount: snapshotsToDelete.length, done: page.isDone };
	},
});

// #endregion snapshots

// #region tests
if (process.env.NODE_ENV === "test" && import.meta.vitest) {
	const { describe, expect, test } = import.meta.vitest;

	const grepTestFileNodeId = "grep-test-file-node" as Id<"files_nodes">;
	const matchMarkdownTestScannerOptions = {
		target: { kind: "saved" as const, id: grepTestFileNodeId },
		invert: false,
		before: 0,
		after: 0,
	};

	function grepTestLineNumberAt(content: string, offset: number) {
		return content.slice(0, offset).split("\n").length;
	}

	function grepTestChunks(content: string, splitIndexes: number[] = []) {
		const chunks: Array<{
			chunkIndex: number;
			startIndex: number;
			endIndex: number;
			lineStart: number;
			lineEnd: number;
			textChunk: string;
		}> = [];
		let startIndex = 0;
		for (const [chunkIndex, endIndex] of [...splitIndexes, content.length].entries()) {
			chunks.push({
				chunkIndex,
				startIndex,
				endIndex,
				lineStart: grepTestLineNumberAt(content, startIndex),
				lineEnd: grepTestLineNumberAt(content, endIndex),
				textChunk: content.slice(startIndex, endIndex),
			});
			startIndex = endIndex;
		}
		return chunks;
	}

	async function* grepTestChunkIterator(
		chunks: Array<{
			chunkIndex: number;
			startIndex?: number;
			endIndex?: number;
			lineStart?: number;
			lineEnd?: number;
			textChunk?: string;
			plainTextChunk?: string;
		}>,
	) {
		for (const chunk of chunks) {
			yield chunk;
		}
	}

	async function* lineRangeTestChunkIterator(
		chunks: Array<{
			startIndex: number;
			endIndex: number;
			lineStart: number;
			lineEnd: number;
			textChunk: string;
		}>,
	) {
		for (const chunk of chunks) {
			yield chunk;
		}
	}

	async function grepTestScan(
		content: string,
		args: {
			pattern: string;
			ignoreCase?: boolean;
			invert?: boolean;
			before?: number;
			after?: number;
			splitIndexes?: number[];
		},
	) {
		return await match_text_chunks_list(grepTestChunkIterator(grepTestChunks(content, args.splitIndexes)), {
			...matchMarkdownTestScannerOptions,
			pattern: args.pattern,
			invert: args.invert ?? false,
			before: args.before ?? 0,
			after: args.after ?? 0,
			match: {
				kind: "substring",
				needle: args.ignoreCase ? args.pattern.toLowerCase() : args.pattern,
				ignoreCase: args.ignoreCase ?? false,
			},
		});
	}

	describe("chunk line range reads", () => {
		test("line range reads the first page and reports more lines", async () => {
			const result = await files_read_forward_line_range_from_ordered_chunks(
				lineRangeTestChunkIterator([
					{ startIndex: 0, endIndex: 5, lineStart: 1, lineEnd: 2, textChunk: "one\nt" },
					{ startIndex: 5, endIndex: 14, lineStart: 2, lineEnd: 3, textChunk: "wo\nthree\n" },
					{ startIndex: 14, endIndex: 19, lineStart: 4, lineEnd: 4, textChunk: "four\n" },
				]),
				{ startLine: 1, maxLines: 2 },
			);

			expect(result).toEqual({ hasChunks: true, content: "one\ntwo\n", moreLines: true });
		});

		test("line range reads an offset page across chunk boundaries", async () => {
			const result = await files_read_forward_line_range_from_ordered_chunks(
				lineRangeTestChunkIterator([
					{ startIndex: 0, endIndex: 5, lineStart: 1, lineEnd: 2, textChunk: "one\nt" },
					{ startIndex: 5, endIndex: 14, lineStart: 2, lineEnd: 3, textChunk: "wo\nthree\n" },
					{ startIndex: 14, endIndex: 19, lineStart: 4, lineEnd: 4, textChunk: "four\n" },
				]),
				{ startLine: 2, maxLines: 2 },
			);

			expect(result).toEqual({ hasChunks: true, content: "two\nthree\n", moreLines: true });
		});

		test("line range returns null for non-contiguous chunks", async () => {
			const result = await files_read_forward_line_range_from_ordered_chunks(
				lineRangeTestChunkIterator([
					{ startIndex: 0, endIndex: 4, lineStart: 1, lineEnd: 1, textChunk: "one\n" },
					{ startIndex: 6, endIndex: 10, lineStart: 2, lineEnd: 2, textChunk: "two\n" },
				]),
				{ startLine: 1, maxLines: 2 },
			);

			expect(result).toBeNull();
		});

		test("line range gives up when a split line's pieces exceed the scan size bound", async () => {
			// Every piece of a mid-line-split long line reports line 1, so the line-based stop can
			// never fire; only the size bound keeps this read from buffering the whole file.
			const pieceText = "x".repeat(64_000);
			const pieces = Array.from({ length: 5 }, (_, index) => ({
				startIndex: index * pieceText.length,
				endIndex: (index + 1) * pieceText.length,
				lineStart: 1,
				lineEnd: 1,
				textChunk: pieceText,
			}));

			const result = await files_read_forward_line_range_from_ordered_chunks(lineRangeTestChunkIterator(pieces), {
				startLine: 1,
				maxLines: 5,
			});

			expect(result).toBeNull();
		});
	});

	describe("match_text_chunks_list", () => {
		test("finds literal substring matches without context", async () => {
			const content = "alpha\nneedle one\nbeta\nneedle two\n";
			const result = await grepTestScan(content, { pattern: "needle" });

			expect(result).not.toBeNull();
			if (!result) throw new Error("expected grep scan result");
			expect(result.lines).toEqual([
				{ lineNumber: 2, line: "needle one", matched: true },
				{ lineNumber: 4, line: "needle two", matched: true },
			]);
			expect(result.selectedCount).toBe(2);
			expect(result.scanTruncated).toBe(false);
		});

		test("matches case-insensitively", async () => {
			const content = "alpha\nNeedle one\nbeta\nNEEDLE two\n";
			const result = await grepTestScan(content, { pattern: "needle", ignoreCase: true });

			expect(result).not.toBeNull();
			if (!result) throw new Error("expected grep scan result");
			expect(result.lines).toEqual([
				{ lineNumber: 2, line: "Needle one", matched: true },
				{ lineNumber: 4, line: "NEEDLE two", matched: true },
			]);
			expect(result.selectedCount).toBe(2);
			expect(result.scanTruncated).toBe(false);
		});

		test("reassembles lines across chunk boundaries", async () => {
			const content = "first\nboundary-needle-line\nlast";
			const result = await grepTestScan(content, {
				pattern: "needle",
				splitIndexes: [content.indexOf("needle") + 2],
			});

			expect(result).not.toBeNull();
			if (!result) throw new Error("expected grep scan result");
			expect(result.lines).toEqual([{ lineNumber: 2, line: "boundary-needle-line", matched: true }]);
			expect(result.selectedCount).toBe(1);
			expect(result.scanTruncated).toBe(false);
		});

		test("returns no lines for an empty pattern", async () => {
			const result = await grepTestScan("alpha\nbeta\n", { pattern: "" });

			expect(result).toEqual({
				target: { kind: "saved", id: grepTestFileNodeId },
				lines: [],
				selectedCount: 0,
				scanTruncated: false,
				truncatedReason: null,
				nextStartLine: null,
				nextStartIndex: null,
				lastScannedLine: 2,
				lastScannedIndex: 10,
			});
		});

		test("returns null for non-contiguous chunks", async () => {
			const result = await match_text_chunks_list(
				grepTestChunkIterator([
					{ chunkIndex: 0, startIndex: 0, endIndex: 5, textChunk: "hello" },
					{ chunkIndex: 1, startIndex: 6, endIndex: 11, textChunk: "world" },
				]),
				{
					...matchMarkdownTestScannerOptions,
					pattern: "world",
					match: { kind: "substring", needle: "world", ignoreCase: false },
				},
			);

			expect(result).toBeNull();
		});

		test("matches regex over text chunks", async () => {
			const content = "intro\ncritical   alert\noutro\n";
			const result = await match_text_chunks_list(grepTestChunkIterator(grepTestChunks(content)), {
				...matchMarkdownTestScannerOptions,
				pattern: String.raw`critical\s+alert`,
				match: { kind: "regex", regex: /critical\s+alert/u },
			});

			expect(result).not.toBeNull();
			if (!result) throw new Error("expected grep scan result");
			expect(result.lines).toEqual([{ lineNumber: 2, line: "critical   alert", matched: true }]);
			expect(result.selectedCount).toBe(1);
			expect(result.scanTruncated).toBe(false);
		});

		test("matches regex over plain-text chunks", async () => {
			const result = await match_plain_text_chunks_list(
				grepTestChunkIterator([{ chunkIndex: 0, plainTextChunk: "intro\ncritical alert\noutro\n" }]),
				{
					target: { kind: "saved", id: grepTestFileNodeId },
					pattern: String.raw`critical\s+alert`,
					ignoreCase: false,
					fixedStrings: false,
					invert: false,
				},
			);

			expect(result).not.toBeNull();
			if (!result) throw new Error("expected grep scan result");
			expect(result.lines).toEqual([{ lineNumber: 2, line: "critical alert", matched: true }]);
			expect(result.selectedCount).toBe(1);
			expect(result.scanTruncated).toBe(false);
		});

		test("returns before and after context", async () => {
			const content = "one\ntwo\nneedle one\nfour\nfive\nneedle two\nseven\n";
			const result = await grepTestScan(content, { pattern: "needle", before: 1, after: 1 });

			expect(result).not.toBeNull();
			if (!result) throw new Error("expected grep scan result");
			expect(result.lines).toEqual([
				{ lineNumber: 2, line: "two", matched: false },
				{ lineNumber: 3, line: "needle one", matched: true },
				{ lineNumber: 4, line: "four", matched: false },
				{ lineNumber: 5, line: "five", matched: false },
				{ lineNumber: 6, line: "needle two", matched: true },
				{ lineNumber: 7, line: "seven", matched: false },
			]);
			expect(result.selectedCount).toBe(2);
			expect(result.scanTruncated).toBe(false);
		});

		test("returns inverted selections", async () => {
			const content = "keep one\nneedle one\nkeep two\nneedle two\nkeep three\n";
			const result = await grepTestScan(content, { pattern: "needle", invert: true });

			expect(result).not.toBeNull();
			if (!result) throw new Error("expected grep scan result");
			expect(result.lines).toEqual([
				{ lineNumber: 1, line: "keep one", matched: true },
				{ lineNumber: 3, line: "keep two", matched: true },
				{ lineNumber: 5, line: "keep three", matched: true },
			]);
			expect(result.selectedCount).toBe(3);
			expect(result.scanTruncated).toBe(false);
		});

		test("reports the bounded selected count when the selected cap is hit", async () => {
			const content = Array.from({ length: files_GREP_MAX_MATCHES + 5 }, (_, index) => `needle ${index + 1}`).join(
				"\n",
			);
			const result = await grepTestScan(content, { pattern: "needle" });

			expect(result).not.toBeNull();
			if (!result) throw new Error("expected grep scan result");
			expect(result.lines).toHaveLength(files_GREP_MAX_MATCHES);
			expect(result.selectedCount).toBe(files_GREP_MAX_MATCHES);
			expect(result.scanTruncated).toBe(true);
			expect(result.truncatedReason).toBe("selected_match_limit_reached");
			expect(result.nextStartLine).toBe(files_GREP_MAX_MATCHES + 1);
		});

		test("starts from a non-zero line window source origin", async () => {
			const content = "one\ntwo\nthree\nneedle four\nneedle five\n";
			const chunks = grepTestChunks(content, [14]).filter((chunk) => chunk.lineEnd >= 4);
			const result = await match_text_chunks_list(grepTestChunkIterator(chunks), {
				...matchMarkdownTestScannerOptions,
				pattern: "needle",
				match: { kind: "substring", needle: "needle", ignoreCase: false },
				window: { kind: "lines", startLine: 4, maxLines: 1 },
			});

			expect(result).not.toBeNull();
			if (!result) throw new Error("expected grep scan result");
			expect(result.lines).toEqual([{ lineNumber: 4, line: "needle four", matched: true }]);
			expect(result.selectedCount).toBe(1);
			expect(result.scanTruncated).toBe(true);
			expect(result.truncatedReason).toBe("scan_line_limit_reached");
			expect(result.nextStartLine).toBe(5);
		});

		test("stops at the line scan cap and returns a continuation line", async () => {
			const content = Array.from({ length: files_GREP_MAX_SCAN_LINES + 5 }, (_, index) =>
				index === files_GREP_MAX_SCAN_LINES + 2 ? "late needle" : `line ${index + 1}`,
			).join("\n");
			const result = await grepTestScan(content, { pattern: "needle" });

			expect(result).not.toBeNull();
			if (!result) throw new Error("expected grep scan result");
			expect(result.lines).toEqual([]);
			expect(result.selectedCount).toBe(0);
			expect(result.scanTruncated).toBe(true);
			expect(result.truncatedReason).toBe("scan_line_limit_reached");
			expect(result.nextStartLine).toBe(files_GREP_MAX_SCAN_LINES + 1);
		});

		test("stops before an oversized line and returns a slice continuation index", async () => {
			const content = `${"x".repeat(files_GREP_MAX_SCAN_BYTES + 10)}needle\n`;
			const result = await grepTestScan(content, { pattern: "needle" });

			expect(result).not.toBeNull();
			if (!result) throw new Error("expected grep scan result");
			expect(result.lines).toEqual([]);
			expect(result.scanTruncated).toBe(true);
			expect(result.truncatedReason).toBe("scan_byte_limit_reached");
			expect(result.nextStartIndex).toBe(0);
		});

		test("counts UTF-8 bytes when applying the scan byte cap", async () => {
			const content = `${"é".repeat(Math.floor(files_GREP_MAX_SCAN_BYTES / 2))}needle\n`;
			const result = await grepTestScan(content, { pattern: "needle" });

			expect(result).not.toBeNull();
			if (!result) throw new Error("expected grep scan result");
			expect(result.lines).toEqual([]);
			expect(result.scanTruncated).toBe(true);
			expect(result.truncatedReason).toBe("scan_byte_limit_reached");
			expect(result.nextStartIndex).toBe(0);
		});

		test("slice window scans inside an oversized line", async () => {
			const prefix = "x".repeat(files_GREP_MAX_SCAN_BYTES + 10);
			const content = `${prefix}needle-end\n`;
			const result = await match_text_chunks_list(grepTestChunkIterator(grepTestChunks(content, [prefix.length - 5])), {
				...matchMarkdownTestScannerOptions,
				pattern: "needle",
				match: { kind: "substring", needle: "needle", ignoreCase: false },
				window: { kind: "slice", startIndex: prefix.length - 5, maxChars: 64 },
			});

			expect(result).not.toBeNull();
			if (!result) throw new Error("expected grep scan result");
			expect(result.lines).toEqual([{ lineNumber: 1, line: "xxxxxneedle-end", matched: true }]);
			expect(result.selectedCount).toBe(1);
			expect(result.scanTruncated).toBe(false);
		});

		test("reports a slice window that ended before the match", async () => {
			// The slice is the caller's own window, so running out of it is not a cap the scanner hit.
			// It has to be its own reason, because the continuation resumes at a character index rather
			// than at the next line.
			const content = `${"x".repeat(files_GREP_MAX_SCAN_BYTES + 10)}needle-end\n`;
			const result = await match_text_chunks_list(grepTestChunkIterator(grepTestChunks(content)), {
				...matchMarkdownTestScannerOptions,
				pattern: "needle",
				match: { kind: "substring", needle: "needle", ignoreCase: false },
				window: { kind: "slice", startIndex: 0, maxChars: 64 },
			});

			expect(result).not.toBeNull();
			if (!result) throw new Error("expected grep scan result");
			expect(result.lines).toEqual([]);
			expect(result.scanTruncated).toBe(true);
			expect(result.truncatedReason).toBe("slice_window_ended");
			// The next page starts five characters back from the window end, not at it. "needle" is six
			// characters, so a match sitting across the edge would be missed by both pages otherwise.
			expect(result.nextStartIndex).toBe(64 - ("needle".length - 1));
		});
	});
}
// #endregion tests
