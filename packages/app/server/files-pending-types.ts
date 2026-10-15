// Sparse type discovery for actual pending content and moves. Saved MIME stays shared.
import type { WithoutSystemFields } from "convex/server";
import type { Doc } from "../convex/_generated/dataModel.js";
import {
	files_content_type_index_fields,
	files_derive_tree_path_for_file_node,
	type files_PendingParent,
} from "../shared/files.ts";

export function files_pending_types_compute(args: {
	pendingUpdate: Doc<"files_pending_updates">;
	node: Pick<Doc<"files_nodes">, "kind" | "name" | "_creationTime">;
	parent: files_PendingParent;
	fallbackTreePath: string;
	resolved: { entry: { path: string }; hidden: boolean; moveApplied: boolean } | null;
}): WithoutSystemFields<Doc<"files_pending_type_entries">> | null {
	const { pendingUpdate, node, resolved } = args;
	const intent = pendingUpdate.createIntent;
	const contentType =
		pendingUpdate.target.kind === "private"
			? intent && intent.kind !== "folder"
				? intent.contentType
				: null
			: (pendingUpdate.pendingReplacement?.contentType ?? null);
	const sourceKind =
		contentType !== null
			? "content"
			: pendingUpdate.target.kind === "saved" && pendingUpdate.pendingMove
				? "move"
				: null;
	if (!sourceKind || (sourceKind === "content" && node.kind !== "file")) return null;
	return {
		organizationId: pendingUpdate.organizationId,
		workspaceId: pendingUpdate.workspaceId,
		userId: pendingUpdate.userId,
		pendingUpdateId: pendingUpdate._id,
		target: pendingUpdate.target,
		parent: args.parent,
		name: pendingUpdate.pendingMove?.destName ?? node.name,
		kind: node.kind,
		sourceKind,
		ownerTreePath: resolved
			? files_derive_tree_path_for_file_node(resolved.entry.path, node.kind)
			: args.fallbackTreePath,
		isPathless: resolved === null,
		// Hidden docs still carry parent/path dependencies for later source changes.
		isVisible: resolved !== null && !resolved.hidden && (sourceKind === "content" || resolved.moveApplied),
		nodeCreationTime: node._creationTime,
		...files_content_type_index_fields(contentType),
	};
}
