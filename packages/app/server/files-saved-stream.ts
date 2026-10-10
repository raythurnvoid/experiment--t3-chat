import type { IndexRange } from "convex/server";
import type { Doc } from "../convex/_generated/dataModel.js";
import type { QueryCtx } from "../convex/_generated/server.js";
import { should_never_happen } from "../shared/shared-utils.ts";
import type { files_SavedStream } from "../shared/files.ts";
import { convex_invalid_cursor_error } from "./convex-utils.ts";
import {
	files_saved_placement_db_get_node,
	files_saved_placement_db_get_view,
} from "./files-saved-placement.ts";

export type files_saved_stream_Source = files_SavedStream;

type SavedUpperRange<Field extends keyof Doc<"files_nodes">> = IndexRange & {
	lt(field: Field, value: Doc<"files_nodes">[Field]): IndexRange;
	lte(field: Field, value: Doc<"files_nodes">[Field]): IndexRange;
};
type SavedRange<Fields extends Array<keyof Doc<"files_nodes">>> = SavedUpperRange<Fields[0]> & {
	eq(field: Fields[0], value: Doc<"files_nodes">[Fields[0]]):
		Fields extends [keyof Doc<"files_nodes">, ...infer Rest extends Array<keyof Doc<"files_nodes">>]
			? Rest extends [] ? IndexRange : SavedRange<Rest>
			: IndexRange;
	gt(field: Fields[0], value: Doc<"files_nodes">[Fields[0]]): SavedUpperRange<Fields[0]>;
	gte(field: Fields[0], value: Doc<"files_nodes">[Fields[0]]): SavedUpperRange<Fields[0]>;
};

/**
 * Read one saved stream. The browser or action merges normal and selected streams.
 * Place docs keep the original saved node's identity and creation time.
 */
export async function files_saved_stream_db_create(
	db: QueryCtx["db"],
	scope: Pick<Doc<"files_nodes">, "organizationId" | "workspaceId">,
	source?: files_saved_stream_Source,
) {
	const view = await files_saved_placement_db_get_view(db, scope);
	if (source && (
		source.generation !== view.generation ||
		(source.kind === "cohort" && (source.cohortId !== view.cohortId || source.view !== view.view))
	)) {
		throw convex_invalid_cursor_error("The saved Move view changed.");
	}
	if (!source && view.cohortId !== null) {
		throw should_never_happen("A saved listing has no Move view", scope);
	}
	const fixedView = source?.kind === "cohort" ? source : null;
	const queries = {
		by_parent_archive_restricted_kind_created: (args: {
			parentId: Doc<"files_nodes">["parentId"];
			archiveOperationId: Doc<"files_nodes">["archiveOperationId"];
			isRestrictedScopeRoot: boolean;
			kind: Doc<"files_nodes">["kind"];
			day: { op: "before" | "after" | "on"; start: number; end: number } | null;
		}) => fixedView
			? db.query("files_saved_places").withIndex("by_view_parent_archive_restricted_kind_created", (q) => {
				const children = q.eq("cohortId", fixedView.cohortId).eq("view", fixedView.view)
					.eq("parentId", args.parentId).eq("archiveOperationId", args.archiveOperationId)
					.eq("isRestrictedScopeRoot", args.isRestrictedScopeRoot).eq("kind", args.kind);
				return args.day === null ? children : args.day.op === "before"
					? children.lt("nodeCreationTime", args.day.start)
					: args.day.op === "after" ? children.gte("nodeCreationTime", args.day.end)
						: children.gte("nodeCreationTime", args.day.start).lt("nodeCreationTime", args.day.end);
			})
			: db.query("files_nodes").withIndex("by_org_ws_parent_archive_restricted_kind", (q) => {
				const children = q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId).eq("moveCohortId", undefined)
					.eq("parentId", args.parentId).eq("archiveOperationId", args.archiveOperationId)
					.eq("isRestrictedScopeRoot", args.isRestrictedScopeRoot).eq("kind", args.kind);
				return args.day === null ? children : args.day.op === "before"
					? children.lt("_creationTime", args.day.start)
					: args.day.op === "after" ? children.gte("_creationTime", args.day.end)
						: children.gte("_creationTime", args.day.start).lt("_creationTime", args.day.end);
			}),
		by_parent_name_archive: (range: (q: SavedRange<["parentId", "name", "archiveOperationId"]>) => IndexRange) =>
			fixedView
				? db.query("files_saved_places").withIndex("by_view_parent_name_archive", (q) =>
						range(q.eq("cohortId", fixedView.cohortId).eq("view", fixedView.view)),
					)
				: db.query("files_nodes").withIndex("by_organization_workspace_parent_name_archiveOperation", (q) =>
						range(q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId).eq("moveCohortId", undefined)),
					),
		by_parent_name: (range: (q: SavedRange<["parentId", "name"]>) => IndexRange) =>
			fixedView
				? db.query("files_saved_places").withIndex("by_view_parent_name", (q) =>
						range(q.eq("cohortId", fixedView.cohortId).eq("view", fixedView.view)),
					)
				: db.query("files_nodes").withIndex("by_organization_workspace_parent_name", (q) =>
						range(q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId).eq("moveCohortId", undefined)),
					),
		by_parent_archive_name: (range: (q: SavedRange<["parentId", "archiveOperationId", "name"]>) => IndexRange) =>
			fixedView
				? db.query("files_saved_places").withIndex("by_view_parent_archive_name", (q) =>
						range(q.eq("cohortId", fixedView.cohortId).eq("view", fixedView.view)),
					)
				: db.query("files_nodes").withIndex("by_organization_workspace_parent_archiveOperation_name", (q) =>
						range(q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId).eq("moveCohortId", undefined)),
					),
		by_parent_archive_kind_name: (range: (q: SavedRange<["parentId", "archiveOperationId", "kind", "name"]>) => IndexRange) =>
			fixedView
				? db.query("files_saved_places").withIndex("by_view_parent_archive_kind_name", (q) =>
						range(q.eq("cohortId", fixedView.cohortId).eq("view", fixedView.view)),
					)
				: db.query("files_nodes").withIndex("by_organization_workspace_parent_archiveOperation_kind_name", (q) =>
						range(q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId).eq("moveCohortId", undefined)),
					),
		by_parent_archive_kind_ext_name: (range: (q: SavedRange<["parentId", "archiveOperationId", "kind", "lowercaseExtension", "name"]>) => IndexRange) =>
			fixedView
				? db.query("files_saved_places").withIndex("by_view_parent_archive_kind_ext_name", (q) =>
						range(q.eq("cohortId", fixedView.cohortId).eq("view", fixedView.view)),
					)
				: db.query("files_nodes").withIndex("by_org_ws_parent_archive_kind_ext_name", (q) =>
						range(q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId).eq("moveCohortId", undefined)),
					),
		by_parent_kind_restricted_archive_sort_name: (range: (q: SavedRange<["parentId", "kind", "isRestrictedScopeRoot", "archiveOperationId", "sortName", "name"]>) => IndexRange) =>
			fixedView
				? db.query("files_saved_places").withIndex("by_view_parent_kind_restricted_archive_sort_name", (q) =>
						range(q.eq("cohortId", fixedView.cohortId).eq("view", fixedView.view)),
					)
				: db.query("files_nodes").withIndex("by_org_ws_parent_kind_restricted_archive_sortName_name", (q) =>
						range(q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId).eq("moveCohortId", undefined)),
					),
		by_parent_archive_restricted_kind_sort_name: (range: (q: SavedRange<["parentId", "archiveOperationId", "isRestrictedScopeRoot", "kind", "sortName", "name"]>) => IndexRange) =>
			fixedView
				? db.query("files_saved_places").withIndex("by_view_parent_archive_restricted_kind_sort_name", (q) =>
						range(q.eq("cohortId", fixedView.cohortId).eq("view", fixedView.view)),
					)
				: db.query("files_nodes").withIndex("by_org_ws_parent_archive_restricted_kind_sortName_name", (q) =>
						range(q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId).eq("moveCohortId", undefined)),
					),
		by_parent_archive_restricted_kind_updated: (range: (q: SavedRange<["parentId", "archiveOperationId", "isRestrictedScopeRoot", "kind", "updatedAt", "sortName", "name"]>) => IndexRange) =>
			fixedView
				? db.query("files_saved_places").withIndex("by_view_parent_archive_restricted_kind_updated", (q) =>
						range(q.eq("cohortId", fixedView.cohortId).eq("view", fixedView.view)),
					)
				: db.query("files_nodes").withIndex("by_org_ws_parent_archive_restricted_kind_updatedAt_name", (q) =>
						range(q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId).eq("moveCohortId", undefined)),
					),
		by_parent_archive_restricted_kind_ext: (range: (q: SavedRange<["parentId", "archiveOperationId", "isRestrictedScopeRoot", "kind", "lowercaseExtension", "sortName", "name"]>) => IndexRange) =>
			fixedView
				? db.query("files_saved_places").withIndex("by_view_parent_archive_restricted_kind_ext", (q) =>
						range(q.eq("cohortId", fixedView.cohortId).eq("view", fixedView.view)),
					)
				: db.query("files_nodes").withIndex("by_org_ws_parent_archive_restricted_kind_ext_sortName_name", (q) =>
						range(q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId).eq("moveCohortId", undefined)),
					),
		by_parent_archive_restricted_kind_size: (range: (q: SavedRange<["parentId", "archiveOperationId", "isRestrictedScopeRoot", "kind", "contentByteSize", "sortName", "name"]>) => IndexRange) =>
			fixedView
				? db.query("files_saved_places").withIndex("by_view_parent_archive_restricted_kind_size", (q) =>
						range(q.eq("cohortId", fixedView.cohortId).eq("view", fixedView.view)),
					)
				: db.query("files_nodes").withIndex("by_org_ws_parent_archive_restricted_kind_size_sortName_name", (q) =>
						range(q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId).eq("moveCohortId", undefined)),
					),
		by_parent_archive_updated: (range: (q: SavedRange<["parentId", "archiveOperationId", "updatedAt"]>) => IndexRange) =>
			fixedView
				? db.query("files_saved_places").withIndex("by_view_parent_archive_updated", (q) =>
						range(q.eq("cohortId", fixedView.cohortId).eq("view", fixedView.view)),
					)
				: db.query("files_nodes").withIndex("by_organization_workspace_parent_archiveOperation_updatedAt", (q) =>
						range(q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId).eq("moveCohortId", undefined)),
					),
		by_path_archive: (range: (q: SavedRange<["path", "archiveOperationId"]>) => IndexRange) =>
			fixedView
				? db.query("files_saved_places").withIndex("by_view_path_archive", (q) =>
						range(q.eq("cohortId", fixedView.cohortId).eq("view", fixedView.view)),
					)
				: db.query("files_nodes").withIndex("by_organization_workspace_path_archiveOperation", (q) =>
						range(q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId).eq("moveCohortId", undefined)),
					),
		by_archive: (range: (q: SavedRange<["archiveOperationId"]>) => IndexRange) =>
			fixedView
				? db.query("files_saved_places").withIndex("by_view_archive_tree", (q) =>
						range(q.eq("cohortId", fixedView.cohortId).eq("view", fixedView.view)),
					)
				: db.query("files_nodes").withIndex("by_organization_workspace_archiveOperation", (q) =>
						range(q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId).eq("moveCohortId", undefined)),
					),
		by_tree: (range: (q: SavedRange<["treePath"]>) => IndexRange) =>
			fixedView
				? db.query("files_saved_places").withIndex("by_view_tree", (q) =>
						range(q.eq("cohortId", fixedView.cohortId).eq("view", fixedView.view)),
					)
				: db.query("files_nodes").withIndex("by_organization_workspace_treePath", (q) =>
						range(q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId).eq("moveCohortId", undefined)),
					),
		by_restricted_tree: (range: (q: SavedRange<["isRestrictedScopeRoot", "treePath"]>) => IndexRange) =>
			fixedView
				? db.query("files_saved_places").withIndex("by_view_restricted_tree", (q) =>
						range(q.eq("cohortId", fixedView.cohortId).eq("view", fixedView.view)),
					)
				: db.query("files_nodes").withIndex("by_organization_workspace_isRestrictedScopeRoot_treePath", (q) =>
						range(q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId).eq("moveCohortId", undefined)),
					),
		by_archive_tree: (range: (q: SavedRange<["archiveOperationId", "treePath"]>) => IndexRange) =>
			fixedView
				? db.query("files_saved_places").withIndex("by_view_archive_tree", (q) =>
						range(q.eq("cohortId", fixedView.cohortId).eq("view", fixedView.view)),
					)
				: db.query("files_nodes").withIndex("by_organization_workspace_archiveOperation_treePath", (q) =>
						range(q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId).eq("moveCohortId", undefined)),
					),
		by_archive_kind_tree: (range: (q: SavedRange<["archiveOperationId", "kind", "treePath"]>) => IndexRange) =>
			fixedView
				? db.query("files_saved_places").withIndex("by_view_archive_kind_tree", (q) =>
						range(q.eq("cohortId", fixedView.cohortId).eq("view", fixedView.view)),
					)
				: db.query("files_nodes").withIndex("by_organization_workspace_archiveOperation_kind_treePath", (q) =>
						range(q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId).eq("moveCohortId", undefined)),
					),
		by_archive_kind_ext_tree: (range: (q: SavedRange<["archiveOperationId", "kind", "lowercaseExtension", "treePath"]>) => IndexRange) =>
			fixedView
				? db.query("files_saved_places").withIndex("by_view_archive_kind_ext_tree", (q) =>
						range(q.eq("cohortId", fixedView.cohortId).eq("view", fixedView.view)),
					)
				: db.query("files_nodes").withIndex("by_organization_workspace_archive_kind_lowercaseExtension_tree", (q) =>
						range(q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId).eq("moveCohortId", undefined)),
					),
		by_archive_content_type_family_tree: (range: (q: SavedRange<["archiveOperationId", "contentTypeFamily", "treePath"]>) => IndexRange) =>
			fixedView
				? db.query("files_saved_places").withIndex("by_view_archive_contentTypeFamily_tree", (q) =>
						range(q.eq("cohortId", fixedView.cohortId).eq("view", fixedView.view)),
					)
				: db.query("files_nodes").withIndex("by_org_ws_archive_contentTypeFamily_tree", (q) =>
						range(q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId).eq("moveCohortId", undefined)),
					),
		by_archive_content_type_essence_tree: (range: (q: SavedRange<["archiveOperationId", "contentTypeEssence", "treePath"]>) => IndexRange) =>
			fixedView
				? db.query("files_saved_places").withIndex("by_view_archive_contentTypeEssence_tree", (q) =>
						range(q.eq("cohortId", fixedView.cohortId).eq("view", fixedView.view)),
					)
				: db.query("files_nodes").withIndex("by_org_ws_archive_contentTypeEssence_tree", (q) =>
						range(q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId).eq("moveCohortId", undefined)),
					),
		by_archive_updated: (range: (q: SavedRange<["archiveOperationId", "updatedAt"]>) => IndexRange) =>
			fixedView
				? db.query("files_saved_places").withIndex("by_view_archive_updated", (q) =>
						range(q.eq("cohortId", fixedView.cohortId).eq("view", fixedView.view)),
					)
				: db.query("files_nodes").withIndex("by_organization_workspace_archiveOperation_updatedAt", (q) =>
						range(q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId).eq("moveCohortId", undefined)),
					),
	};

	async function read_nodes(rows: Array<Doc<"files_nodes"> | Doc<"files_saved_places">>) {
		return await Promise.all(rows.map(async (row) => {
			if (!("nodeId" in row)) return row;
			const node = await files_saved_placement_db_get_node(db, row.nodeId, fixedView ?? undefined);
			if (!node || node._creationTime !== row.nodeCreationTime) {
				throw should_never_happen("Saved place points to a missing or changed node", { placeId: row._id, nodeId: row.nodeId });
			}
			return node;
		}));
	}

	return { queries, read_nodes, view, tag: fixedView ?? undefined };
}
