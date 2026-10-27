import type { Doc, Id } from "../convex/_generated/dataModel.js";
import type { QueryCtx } from "../convex/_generated/server.js";
import type { PaginationOptions } from "convex/server";
import type { files_IndexDirectoryView, files_IndexStream } from "../shared/files.ts";
import { should_never_happen } from "../shared/shared-utils.ts";
import { convex_invalid_cursor_error } from "./convex-utils.ts";

export type files_saved_index_ViewTag = {
	cohortId: Id<"files_move_cohorts"> | Id<"files_index_runs">;
	view: "before" | "after";
};

/**
 * Scope jobs wait until this file's index docs stop changing views.
 */
export async function files_saved_index_db_is_publishing(db: QueryCtx["db"], nodeId: Id<"files_nodes">) {
	const state = await db
		.query("files_index_states")
		.withIndex("by_fileNode", (q) => q.eq("fileNodeId", nodeId))
		.unique();
	const run = state?.activeRunId ? await db.get("files_index_runs", state.activeRunId) : null;
	return run !== null && run.slotGeneration !== null;
}

/**
 * Source reads and tree rows keep their separate Move-only view.
 */
export async function files_saved_index_db_get_view(
	db: QueryCtx["db"],
	args: Pick<Doc<"files_nodes">, "organizationId" | "workspaceId">,
) {
	const organizationId = db.normalizeId("organizations", args.organizationId);
	const workspaceId = db.normalizeId("organizations_workspaces", args.workspaceId);
	const slot =
		organizationId && workspaceId
			? await db
					.query("files_move_workspace_slots")
					.withIndex("by_workspace", (q) => q.eq("organizationId", organizationId).eq("workspaceId", workspaceId))
					.unique()
			: null;
	if (slot && "indexRunId" in slot) {
		const indexSlot = slot as Extract<Doc<"files_move_workspace_slots">, { indexRunId: Id<"files_index_runs"> }>;
		return {
			cohortId: indexSlot.indexRunId,
			view: indexSlot.visibleView,
			generation: indexSlot.generation,
			migrationDirection: indexSlot.migrationDirection,
		};
	}
	if (slot?.cohortId)
		return {
			cohortId: slot.cohortId,
			view: slot.visibleView,
			generation: slot.generation,
			migrationDirection: slot.migrationDirection,
		};
	return { cohortId: null, view: null, generation: slot?.generation ?? 0, migrationDirection: null };
}

/**
 * Pin each native index range to the complete selected version.
 */
export async function files_saved_index_db_get_stream(
	db: QueryCtx["db"],
	scope: Pick<Doc<"files_nodes">, "organizationId" | "workspaceId">,
	source?: files_IndexStream,
) {
	const view = await files_saved_index_db_get_view(db, scope);
	if (
		source &&
		(source.generation !== view.generation ||
			(source.kind === "cohort" && (source.cohortId !== view.cohortId || source.view !== view.view)))
	)
		throw convex_invalid_cursor_error("The saved index view changed.", "saved_index_view_changed");
	if (!source && view.cohortId !== null) throw should_never_happen("A saved index read has no selected view", scope);
	return { tag: source?.kind === "cohort" ? { cohortId: source.cohortId, view: source.view } : undefined, view };
}

export async function files_saved_index_db_get_directory(
	db: QueryCtx["db"],
	scope: Pick<Doc<"organizations_workspaces_users">, "organizationId" | "workspaceId">,
	args: { stream: "normal" | "cohort"; pageView?: files_IndexDirectoryView; paginationOpts: PaginationOptions },
) {
	const view = await files_saved_index_db_get_view(db, scope);
	const directoryView: files_IndexDirectoryView =
		view.cohortId && view.view ? { cohortId: view.cohortId, view: view.view } : null;
	if (
		(args.paginationOpts.cursor !== null || args.paginationOpts.endCursor != null) &&
		(args.pageView === undefined ||
			args.pageView?.cohortId !== directoryView?.cohortId ||
			args.pageView?.view !== directoryView?.view)
	)
		throw convex_invalid_cursor_error("The saved index view changed.", "saved_index_view_changed");
	return {
		directoryView,
		tag: args.stream === "cohort" ? (directoryView ?? undefined) : undefined,
		empty: args.stream === "cohort" && directoryView === null,
	};
}

export function files_saved_index_check_table_field_source(
	metadataDoc: Doc<"files_metadata_docs">,
	fileNode: Doc<"files_nodes">,
): asserts metadataDoc is Extract<Doc<"files_metadata_docs">, { sourceKind: "committed" }> {
	const valid =
		metadataDoc.organizationId === fileNode.organizationId &&
		metadataDoc.workspaceId === fileNode.workspaceId &&
		metadataDoc.archiveOperationId === undefined &&
		metadataDoc.sourceKind === "committed" &&
		metadataDoc.fileNodeId === fileNode._id;
	if (!valid) {
		const errorMessage = "metadataDoc source is mismatched";
		const errorData = { metadataDocId: metadataDoc._id, fileNodeId: fileNode._id };
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}
}

/**
 * Read one folder table field from the complete selected index.
 * The range holds only this key's field doc and its value docs.
 */
export async function files_saved_index_db_get_table_field(
	ctx: QueryCtx,
	args: { fileNode: Doc<"files_nodes">; field: string },
) {
	const selected = await files_saved_index_db_get_view(ctx.db, args.fileNode);
	const views =
		selected.cohortId && selected.view
			? [undefined, { cohortId: selected.cohortId, view: selected.view }]
			: [undefined];
	const candidates = await Promise.all(
		views.map((moveView) =>
			ctx.db
				.query("files_metadata_docs")
				.withIndex("by_organization_workspace_source_fileNode_fieldPath", (q) =>
					q
						.eq("organizationId", args.fileNode.organizationId)
						.eq("workspaceId", args.fileNode.workspaceId)
						.eq("sourceKind", "committed")
						.eq("fileNodeId", args.fileNode._id)
						.eq("moveView.cohortId", moveView?.cohortId)
						.eq("moveView.view", moveView?.view)
						.eq("fieldPath", args.field),
				)
				.filter((q) => q.eq(q.field("docKind"), "field"))
				.first(),
		),
	);
	// Staging and cleanup move each bounded field between these two exact ranges.
	const metadataDoc = candidates.find((candidate) => candidate !== null);
	if (!metadataDoc) return null;
	// Restore keeps the old archive id until the saved scope job reaches this doc.
	if (
		metadataDoc.archiveOperationId !== undefined &&
		(await ctx.db
			.query("files_pending_overlay_jobs")
			.withIndex("by_kind_key", (q) => q.eq("kind", "saved_scope").eq("key", args.fileNode._id))
			.unique()) !== null
	)
		return null;
	files_saved_index_check_table_field_source(metadataDoc, args.fileNode);
	return metadataDoc;
}
