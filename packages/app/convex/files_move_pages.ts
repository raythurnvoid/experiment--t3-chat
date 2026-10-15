// Native Move pages. The parent mutation checks access, applies writes and owns the flush.
// Each query has its own page journal and shares the parent's transaction budget.
// Null cursors drain docs that the parent tags or removes.

import { paginationResultValidator } from "convex/server";
import { v, type Infer } from "convex/values";
import { doc } from "convex-helpers/validators";
import { internalQuery, type QueryCtx } from "./_generated/server.js";
import app_convex_schema, { files_move_view_validator, files_pending_parent_validator } from "./schema.ts";

// Reuse the loaded module between calls. Keep request state inside each query.
export const experimental_reuseContext = true;

const PAGE_SIZE = 8;
// Bound one native page. Long headers reach the byte bound first.
const DESCENDANT_PAGE_SIZE = 32;
const DESCENDANT_PAGE_BYTES = 128 * 1024;
const METADATA_PAGE_SIZE = 64;

const proof_validator = v.object({
	token: v.string(),
	runId: v.union(v.id("files_transfer_runs"), v.id("files_pending_update_runs")),
	cohortId: v.id("files_move_cohorts"),
	entryStep: v.number(),
	step: v.number(),
	phase: v.string(),
	ordinal: v.number(),
});

// Temporary proof logs. Only selected parent calls pass a proof.
async function trace_page_proof(
	ctx: QueryCtx,
	proof: Infer<typeof proof_validator> | undefined,
	purpose: "descendants" | "metadata" | "side_cleanup" | "owner_source_metadata",
	cursor: string | null,
	page?: { page: { _id: string }[]; isDone: boolean },
) {
	if (!proof) return;
	const metrics = await ctx.meta.getTransactionMetrics();
	console.info(
		"MOVE_PAGE_PROOF_20261015 " +
			JSON.stringify({
				event: page ? "child_exit" : "child_entry",
				...proof,
				purpose,
				seq: proof.ordinal * 4 + (page ? 2 : 1),
				counters: {
					bytesRead: metrics.bytesRead,
					bytesWritten: metrics.bytesWritten,
					databaseQueries: metrics.databaseQueries,
					documentsRead: metrics.documentsRead,
					documentsWritten: metrics.documentsWritten,
					functionsScheduled: metrics.functionsScheduled,
					scheduledFunctionArgsBytes: metrics.scheduledFunctionArgsBytes,
				},
				...(page
					? {
							rowIds: page.page.map((row) => row._id),
							isDone: page.isDone,
							cursorKind: cursor === null ? "null" : "continued",
						}
					: {}),
			}),
	);
}

export const descendants = internalQuery({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		cohortId: v.id("files_move_cohorts"),
		source: v.union(v.literal("before"), v.literal("normal")),
		parentId: v.id("files_nodes"),
		cursor: v.union(v.string(), v.null()),
		proof: v.optional(proof_validator),
	},
	returns: paginationResultValidator(
		v.union(doc(app_convex_schema, "files_saved_places"), doc(app_convex_schema, "files_nodes")),
	),
	handler: async (ctx, args) => {
		await trace_page_proof(ctx, args.proof, "descendants", args.cursor);
		const page = args.source === "before"
			? await ctx.db
					.query("files_saved_places")
					.withIndex("by_view_parent_name", (q) =>
						q.eq("cohortId", args.cohortId).eq("view", "before").eq("parentId", args.parentId),
					)
					.paginate({
						cursor: args.cursor,
						numItems: DESCENDANT_PAGE_SIZE,
						maximumBytesRead: DESCENDANT_PAGE_BYTES,
					})
			: await ctx.db
					.query("files_nodes")
					.withIndex("by_organization_workspace_parent_name_archiveOperation", (q) =>
						q
							.eq("organizationId", args.organizationId)
							.eq("workspaceId", args.workspaceId)
							.eq("moveCohortId", undefined)
							.eq("parentId", args.parentId),
					)
					.paginate({
						cursor: args.cursor,
						numItems: DESCENDANT_PAGE_SIZE,
						maximumBytesRead: DESCENDANT_PAGE_BYTES,
					});
		await trace_page_proof(ctx, args.proof, "descendants", args.cursor, page);
		return page;
	},
});

export const metadata = internalQuery({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		nodeId: v.id("files_nodes"),
		cursor: v.null(),
		proof: v.optional(proof_validator),
	},
	returns: paginationResultValidator(doc(app_convex_schema, "files_metadata_docs")),
	handler: async (ctx, args) => {
		await trace_page_proof(ctx, args.proof, "metadata", args.cursor);
		const page = await ctx.db
			.query("files_metadata_docs")
			.withIndex("by_organization_workspace_source_fileNode_fieldPath", (q) =>
				q
					.eq("organizationId", args.organizationId)
					.eq("workspaceId", args.workspaceId)
					.eq("sourceKind", "committed")
					.eq("fileNodeId", args.nodeId)
					.eq("moveView.cohortId", undefined)
					.eq("moveView.view", undefined),
			)
			.paginate({ cursor: args.cursor, numItems: METADATA_PAGE_SIZE, maximumBytesRead: 1024 * 1024 });
		await trace_page_proof(ctx, args.proof, "metadata", args.cursor, page);
		return page;
	},
});

export const plain_chunks = internalQuery({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		nodeId: v.id("files_nodes"),
		cursor: v.union(v.string(), v.null()),
	},
	returns: paginationResultValidator(doc(app_convex_schema, "files_plain_text_chunks")),
	handler: async (ctx, args) => {
		return await ctx.db
			.query("files_plain_text_chunks")
			.withIndex("by_organization_workspace_source_fileNode_yjsSequence_chunkIndex", (q) =>
				q
					.eq("organizationId", args.organizationId)
					.eq("workspaceId", args.workspaceId)
					.eq("sourceKind", "committed")
					.eq("fileNodeId", args.nodeId)
					.eq("moveView.cohortId", undefined)
					.eq("moveView.view", undefined),
			)
			.paginate({ cursor: args.cursor, numItems: PAGE_SIZE });
	},
});

export const side_cleanup = internalQuery({
	args: {
		cohortId: v.id("files_move_cohorts"),
		family: v.union(
			v.literal("files_metadata_docs"),
			v.literal("files_text_chunks"),
			v.literal("files_plain_text_chunks"),
			v.literal("files_yjs_updates"),
			v.literal("files_updated_by_docs"),
			v.literal("files_share_rows"),
			v.literal("files_share_links"),
		),
		view: files_move_view_validator,
		cursor: v.null(),
		proof: v.optional(proof_validator),
	},
	returns: paginationResultValidator(
		v.union(
			doc(app_convex_schema, "files_metadata_docs"),
			doc(app_convex_schema, "files_text_chunks"),
			doc(app_convex_schema, "files_plain_text_chunks"),
			doc(app_convex_schema, "files_yjs_updates"),
			doc(app_convex_schema, "files_updated_by_docs"),
			doc(app_convex_schema, "files_share_rows"),
			doc(app_convex_schema, "files_share_links"),
		),
	),
	handler: async (ctx, args) => {
		await trace_page_proof(ctx, args.proof, "side_cleanup", args.cursor);
		const page = await ctx.db
			.query(args.family)
			.withIndex("by_move_view", (q) => q.eq("moveView.cohortId", args.cohortId).eq("moveView.view", args.view))
			.paginate({
				cursor: args.cursor,
				numItems:
					args.family === "files_metadata_docs"
						? METADATA_PAGE_SIZE
						: args.family === "files_yjs_updates"
							? 1
							: PAGE_SIZE,
				maximumBytesRead: 1024 * 1024,
			});
		await trace_page_proof(ctx, args.proof, "side_cleanup", args.cursor, page);
		return page;
	},
});

export const owner_proposals = internalQuery({
	args: { nodeId: v.id("files_nodes"), cursor: v.union(v.string(), v.null()) },
	returns: paginationResultValidator(doc(app_convex_schema, "files_pending_updates")),
	handler: async (ctx, args) => {
		return await ctx.db
			.query("files_pending_updates")
			.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", args.nodeId))
			.paginate({ cursor: args.cursor, numItems: PAGE_SIZE });
	},
});

export const owner_hides = internalQuery({
	args: { nodeId: v.id("files_nodes"), cursor: v.union(v.string(), v.null()) },
	returns: paginationResultValidator(doc(app_convex_schema, "files_pending_hides")),
	handler: async (ctx, args) => {
		return await ctx.db
			.query("files_pending_hides")
			.withIndex("by_savedNode_user", (q) => q.eq("savedNodeId", args.nodeId))
			.paginate({ cursor: args.cursor, numItems: PAGE_SIZE });
	},
});

export const owner_places = internalQuery({
	args: { nodeId: v.id("files_nodes"), cursor: v.union(v.string(), v.null()) },
	returns: paginationResultValidator(doc(app_convex_schema, "files_pending_places")),
	handler: async (ctx, args) => {
		return await ctx.db
			.query("files_pending_places")
			.withIndex("by_target_user", (q) => q.eq("target.kind", "saved").eq("target.id", args.nodeId))
			.paginate({ cursor: args.cursor, numItems: PAGE_SIZE });
	},
});

export const owner_slot_places = internalQuery({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		parentId: doc(app_convex_schema, "files_nodes").fields.parentId,
		name: v.string(),
		cursor: v.union(v.string(), v.null()),
	},
	returns: paginationResultValidator(doc(app_convex_schema, "files_pending_places")),
	handler: async (ctx, args) => {
		return await ctx.db
			.query("files_pending_places")
			.withIndex("by_org_ws_parent_name", (q) =>
				q
					.eq("organizationId", args.organizationId)
					.eq("workspaceId", args.workspaceId)
					.eq("moveView.cohortId", undefined)
					.eq("moveView.view", undefined)
					.eq("parent.kind", args.parentId === "root" ? "root" : "saved")
					.eq("parent.id", args.parentId === "root" ? undefined : args.parentId)
					.eq("name", args.name),
			)
			.paginate({ cursor: args.cursor, numItems: PAGE_SIZE });
	},
});

export const private_children = internalQuery({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		parentId: v.id("files_nodes"),
		cursor: v.union(v.string(), v.null()),
	},
	returns: paginationResultValidator(doc(app_convex_schema, "files_pending_nodes")),
	handler: async (ctx, args) => {
		return await ctx.db
			.query("files_pending_nodes")
			.withIndex("by_org_ws_parent_state_name", (q) =>
				q
					.eq("organizationId", args.organizationId)
					.eq("workspaceId", args.workspaceId)
					.eq("parent.kind", "saved")
					.eq("parent.id", args.parentId)
					.eq("state", "active"),
			)
			.paginate({ cursor: args.cursor, numItems: PAGE_SIZE });
	},
});

export const incoming_moves = internalQuery({
	args: { nodeId: v.id("files_nodes"), cursor: v.union(v.string(), v.null()) },
	returns: paginationResultValidator(doc(app_convex_schema, "files_pending_updates")),
	handler: async (ctx, args) => {
		return await ctx.db
			.query("files_pending_updates")
			.withIndex("by_pendingMove_destParent", (q) =>
				q.eq("pendingMove.destParent.kind", "saved").eq("pendingMove.destParent.id", args.nodeId),
			)
			.paginate({ cursor: args.cursor, numItems: PAGE_SIZE });
	},
});

export const publish_receipts = internalQuery({
	args: {
		nodeId: v.id("files_nodes"),
		cohortId: v.union(v.id("files_move_cohorts"), v.null()),
		cursor: v.union(v.string(), v.null()),
	},
	returns: paginationResultValidator(doc(app_convex_schema, "files_pending_node_publish_receipts")),
	handler: async (ctx, args) => {
		return await ctx.db
			.query("files_pending_node_publish_receipts")
			.withIndex("by_savedNode", (q) =>
				q
					.eq("savedNodeId", args.nodeId)
					.eq("moveView.cohortId", args.cohortId ?? undefined)
					.eq("moveView.view", args.cohortId === null ? undefined : "after"),
			)
			.paginate({ cursor: args.cursor, numItems: PAGE_SIZE });
	},
});

export const owner_private_children = internalQuery({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		parent: files_pending_parent_validator,
		cursor: v.union(v.string(), v.null()),
	},
	returns: paginationResultValidator(doc(app_convex_schema, "files_pending_nodes")),
	handler: async (ctx, args) => {
		return await ctx.db
			.query("files_pending_nodes")
			.withIndex("by_organization_workspace_user_parent_state_name", (q) =>
				q
					.eq("organizationId", args.organizationId)
					.eq("workspaceId", args.workspaceId)
					.eq("userId", args.userId)
					.eq("parent.kind", args.parent.kind)
					.eq("parent.id", args.parent.kind === "root" ? undefined : args.parent.id)
					.eq("state", "active"),
			)
			.paginate({ cursor: args.cursor, numItems: PAGE_SIZE });
	},
});

export const owner_incoming_moves = internalQuery({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		parent: files_pending_parent_validator,
		cursor: v.union(v.string(), v.null()),
	},
	returns: paginationResultValidator(doc(app_convex_schema, "files_pending_updates")),
	handler: async (ctx, args) => {
		return await ctx.db
			.query("files_pending_updates")
			.withIndex("by_org_ws_user_pendingMove_destParent_destName", (q) =>
				q
					.eq("organizationId", args.organizationId)
					.eq("workspaceId", args.workspaceId)
					.eq("userId", args.userId)
					.eq("pendingMove.destParent.kind", args.parent.kind)
					.eq("pendingMove.destParent.id", args.parent.kind === "root" ? undefined : args.parent.id),
			)
			.paginate({ cursor: args.cursor, numItems: PAGE_SIZE });
	},
});

export const owner_prefix_places = internalQuery({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		prefix: v.string(),
		prefixEnd: v.string(),
		cursor: v.union(v.string(), v.null()),
	},
	returns: paginationResultValidator(doc(app_convex_schema, "files_pending_places")),
	handler: async (ctx, args) => {
		return await ctx.db
			.query("files_pending_places")
			.withIndex("by_org_ws_user_ownerTreePath", (q) =>
				q
					.eq("organizationId", args.organizationId)
					.eq("workspaceId", args.workspaceId)
					.eq("userId", args.userId)
					.eq("moveView.cohortId", undefined)
					.eq("moveView.view", undefined)
					.gt("ownerTreePath", args.prefix)
					.lt("ownerTreePath", args.prefixEnd),
			)
			.paginate({ cursor: args.cursor, numItems: PAGE_SIZE });
	},
});

export const pending_chunks = internalQuery({
	args: { pendingUpdateId: v.id("files_pending_updates"), cursor: v.union(v.string(), v.null()) },
	returns: paginationResultValidator(doc(app_convex_schema, "files_plain_text_chunks")),
	handler: async (ctx, args) => {
		return await ctx.db
			.query("files_plain_text_chunks")
			.withIndex("by_pendingUpdate_chunkIndex", (q) =>
				q.eq("pendingUpdateId", args.pendingUpdateId).eq("moveView.cohortId", undefined).eq("moveView.view", undefined),
			)
			.paginate({ cursor: args.cursor, numItems: PAGE_SIZE });
	},
});

export const pending_metadata = internalQuery({
	args: { pendingUpdateId: v.id("files_pending_updates"), cursor: v.null() },
	returns: paginationResultValidator(doc(app_convex_schema, "files_metadata_docs")),
	handler: async (ctx, args) => {
		return await ctx.db
			.query("files_metadata_docs")
			.withIndex("by_pendingUpdate_fieldPath", (q) =>
				q.eq("pendingUpdateId", args.pendingUpdateId).eq("moveView.cohortId", undefined).eq("moveView.view", undefined),
			)
			.paginate({ cursor: args.cursor, numItems: PAGE_SIZE, maximumBytesRead: 1024 * 1024 });
	},
});

export const owner_list_rows = internalQuery({
	args: { pendingUpdateId: v.id("files_pending_updates"), cursor: v.union(v.string(), v.null()) },
	returns: paginationResultValidator(doc(app_convex_schema, "files_pending_list_rows")),
	handler: async (ctx, args) => {
		return await ctx.db
			.query("files_pending_list_rows")
			.withIndex("by_pendingUpdate", (q) =>
				q.eq("pendingUpdateId", args.pendingUpdateId).eq("moveView.cohortId", undefined).eq("moveView.view", undefined),
			)
			.paginate({ cursor: args.cursor, numItems: 100 });
	},
});

export const owner_old_fields = internalQuery({
	args: { placeId: v.id("files_pending_places"), cursor: v.union(v.string(), v.null()) },
	returns: paginationResultValidator(doc(app_convex_schema, "files_pending_place_fields")),
	handler: async (ctx, args) => {
		return await ctx.db
			.query("files_pending_place_fields")
			.withIndex("by_place", (q) =>
				q.eq("placeId", args.placeId).eq("moveView.cohortId", undefined).eq("moveView.view", undefined),
			)
			.paginate({ cursor: args.cursor, numItems: PAGE_SIZE, maximumBytesRead: 1024 * 1024 });
	},
});

export const owner_source_metadata = internalQuery({
	args: {
		source: v.union(
			v.object({
				kind: v.literal("saved"),
				organizationId: v.id("organizations"),
				workspaceId: v.id("organizations_workspaces"),
				nodeId: v.id("files_nodes"),
			}),
			v.object({ kind: v.literal("pending"), pendingUpdateId: v.id("files_pending_updates") }),
		),
		cohortId: v.union(v.id("files_move_cohorts"), v.null()),
		cursor: v.union(v.string(), v.null()),
		proof: v.optional(proof_validator),
	},
	returns: paginationResultValidator(doc(app_convex_schema, "files_metadata_docs")),
	handler: async (ctx, args) => {
		await trace_page_proof(ctx, args.proof, "owner_source_metadata", args.cursor);
		const source = args.source;
		const query =
			source.kind === "pending"
				? ctx.db
						.query("files_metadata_docs")
						.withIndex("by_pendingUpdate", (q) =>
							q
								.eq("pendingUpdateId", source.pendingUpdateId)
								.eq("moveView.cohortId", args.cohortId ?? undefined)
								.eq("moveView.view", args.cohortId === null ? undefined : "after"),
						)
				: ctx.db
						.query("files_metadata_docs")
						.withIndex("by_organization_workspace_source_fileNode", (q) =>
							q
								.eq("organizationId", source.organizationId)
								.eq("workspaceId", source.workspaceId)
								.eq("sourceKind", "committed")
								.eq("fileNodeId", source.nodeId)
								.eq("moveView.cohortId", args.cohortId ?? undefined)
								.eq("moveView.view", args.cohortId === null ? undefined : "after"),
						);
		const page = await query.paginate({ cursor: args.cursor, numItems: PAGE_SIZE, maximumBytesRead: 1024 * 1024 });
		await trace_page_proof(ctx, args.proof, "owner_source_metadata", args.cursor, page);
		return page;
	},
});

export const owner_cleanup = internalQuery({
	args: {
		cohortId: v.id("files_move_cohorts"),
		family: v.union(
			v.literal("files_pending_place_fields"),
			v.literal("files_pending_list_rows"),
			v.literal("files_pending_hides"),
			v.literal("files_pending_places"),
		),
		view: files_move_view_validator,
		cursor: v.null(),
	},
	returns: paginationResultValidator(
		v.union(
			doc(app_convex_schema, "files_pending_place_fields"),
			doc(app_convex_schema, "files_pending_list_rows"),
			doc(app_convex_schema, "files_pending_hides"),
			doc(app_convex_schema, "files_pending_places"),
		),
	),
	handler: async (ctx, args) => {
		return await ctx.db
			.query(args.family)
			.withIndex("by_move_view", (q) => q.eq("moveView.cohortId", args.cohortId).eq("moveView.view", args.view))
			.paginate({ cursor: args.cursor, numItems: PAGE_SIZE, maximumBytesRead: 1024 * 1024 });
	},
});

export const owner_review_facts = internalQuery({
	args: { cohortId: v.id("files_move_cohorts"), view: files_move_view_validator, cursor: v.null() },
	returns: paginationResultValidator(doc(app_convex_schema, "files_pending_review_facts")),
	handler: async (ctx, args) => {
		return await ctx.db
			.query("files_pending_review_facts")
			.withIndex("by_cohort_view", (q) => q.eq("cohortId", args.cohortId).eq("view", args.view))
			.paginate({ cursor: args.cursor, numItems: PAGE_SIZE });
	},
});

export const owner_list_keys = internalQuery({
	args: { cohortId: v.id("files_move_cohorts"), cursor: v.null() },
	returns: paginationResultValidator(doc(app_convex_schema, "files_move_owner_list_keys")),
	handler: async (ctx, args) => {
		return await ctx.db
			.query("files_move_owner_list_keys")
			.withIndex("by_cohort", (q) => q.eq("cohortId", args.cohortId))
			.paginate({ cursor: args.cursor, numItems: PAGE_SIZE });
	},
});

export const owner_work = internalQuery({
	args: { cohortId: v.id("files_move_cohorts"), cursor: v.union(v.string(), v.null()) },
	returns: paginationResultValidator(doc(app_convex_schema, "files_move_owner_work")),
	handler: async (ctx, args) => {
		return await ctx.db
			.query("files_move_owner_work")
			.withIndex("by_cohort_order", (q) => q.eq("cohortId", args.cohortId))
			.paginate({ cursor: args.cursor, numItems: PAGE_SIZE });
	},
});

// Temporary reads for parent writes made during the native page proof.
export const proof_work_range = internalQuery({
	args: { cohortId: v.id("files_move_cohorts"), key: v.string() },
	returns: v.union(doc(app_convex_schema, "files_move_work_ranges"), v.null()),
	handler: async (ctx, args) => {
		return await ctx.db
			.query("files_move_work_ranges")
			.withIndex("by_cohort_key", (q) => q.eq("cohortId", args.cohortId).eq("key", args.key))
			.unique();
	},
});

export const proof_owner_fields = internalQuery({
	args: { ids: v.array(v.id("files_pending_place_fields")) },
	returns: v.array(v.union(doc(app_convex_schema, "files_pending_place_fields"), v.null())),
	handler: async (ctx, args) => {
		return await Promise.all(args.ids.map((id) => ctx.db.get("files_pending_place_fields", id)));
	},
});
