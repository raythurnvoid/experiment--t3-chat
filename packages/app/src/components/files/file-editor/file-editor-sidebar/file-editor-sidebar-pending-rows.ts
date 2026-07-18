import type { app_convex_Doc, app_convex_Id } from "@/lib/app-convex-client.ts";
import { files_ROOT_ID, files_pending_update_has_yjs_content } from "@/lib/files.ts";

export type FileEditorSidebarPendingRow = {
	pendingUpdate: app_convex_Doc<"files_pending_updates">;
	path: string;
	kind: "content" | "move" | "copy" | "content_and_move";
	nodeKind: app_convex_Doc<"files_nodes">["kind"] | undefined;
	moveDestinationPath: string | undefined;
	/** True for `mv -f` replace proposals: accepting archives the file at the destination path. */
	moveReplacesExistingFile: boolean;
	/** True when the proposal created the file (write_file/cp onto a new path): shown as Added. */
	isAddedFile: boolean;
};

const FILE_EDITOR_SIDEBAR_PENDING_MISSING_PATH_LABEL = "(unknown file)";

/**
 * Pair each pending update with its file path and sort by path. The list query returns rows in
 * creation order, so the sort is the meaningful client-side logic. Rows whose file node is missing
 * (archived/renamed and absent from `list_tree`) keep a fallback label instead of being dropped, so
 * the user can still discard them from the panel. The row `kind` is derived from field presence:
 * `pendingMove` marks a move (plus content when the Yjs fields are set), `copiedFrom` marks a copy.
 */
export function files_pending_changes_build_rows(
	pendingUpdates: readonly app_convex_Doc<"files_pending_updates">[],
	nodesById: Map<app_convex_Id<"files_nodes">, app_convex_Doc<"files_nodes">>,
): FileEditorSidebarPendingRow[] {
	return pendingUpdates
		.map((pendingUpdate) => {
			const node = nodesById.get(pendingUpdate.fileNodeId);
			const { pendingMove, copiedFrom } = pendingUpdate;

			const kind = pendingMove
				? files_pending_update_has_yjs_content(pendingUpdate)
					? ("content_and_move" as const)
					: ("move" as const)
				: copiedFrom
					? ("copy" as const)
					: ("content" as const);

			let moveDestinationPath: string | undefined;
			if (pendingMove) {
				if (pendingMove.destParentId === files_ROOT_ID) {
					moveDestinationPath = `/${pendingMove.destName}`;
				} else {
					const destParent = nodesById.get(pendingMove.destParentId);
					moveDestinationPath = destParent ? `${destParent.path}/${pendingMove.destName}` : `…/${pendingMove.destName}`;
				}
			}

			return {
				pendingUpdate,
				path: node?.path ?? pendingMove?.fromPath ?? FILE_EDITOR_SIDEBAR_PENDING_MISSING_PATH_LABEL,
				kind,
				nodeKind: node?.kind,
				moveDestinationPath,
				moveReplacesExistingFile: pendingMove?.replacesNodeId != null,
				isAddedFile: pendingUpdate.eagerCreated != null,
			};
		})
		.sort((left, right) => left.path.localeCompare(right.path));
}
