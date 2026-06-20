import type { app_convex_Doc, app_convex_Id } from "@/lib/app-convex-client.ts";

export type FileEditorSidebarPendingRow = {
	pendingUpdate: app_convex_Doc<"files_pending_updates">;
	path: string;
};

const FILE_EDITOR_SIDEBAR_PENDING_MISSING_PATH_LABEL = "(unknown file)";

/**
 * Pair each pending update with its file path and sort by path. The list query returns rows in
 * creation order, so the sort is the meaningful client-side logic. Rows whose file node is missing
 * (archived/renamed and absent from `list_tree`) keep a fallback label instead of being dropped, so
 * the user can still discard them from the panel.
 */
export function files_pending_changes_build_rows(
	pendingUpdates: readonly app_convex_Doc<"files_pending_updates">[],
	nodesById: Map<app_convex_Id<"files_nodes">, app_convex_Doc<"files_nodes">>,
): FileEditorSidebarPendingRow[] {
	return pendingUpdates
		.map((pendingUpdate) => ({
			pendingUpdate,
			path: nodesById.get(pendingUpdate.fileNodeId)?.path ?? FILE_EDITOR_SIDEBAR_PENDING_MISSING_PATH_LABEL,
		}))
		.sort((left, right) => left.path.localeCompare(right.path));
}
