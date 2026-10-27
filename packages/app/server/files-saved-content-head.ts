import type { Doc, Id } from "../convex/_generated/dataModel.js";
import type { QueryCtx } from "../convex/_generated/server.js";
import { files_content_type_index_fields } from "../shared/files.ts";
import { should_never_happen } from "../shared/shared-utils.ts";
import type { files_saved_placement_FixedView } from "./files-saved-placement.ts";

// Migration bridge: old heads owned their live log themselves. Remove after the owner audit.
export function files_saved_content_yjs_owner(head: Doc<"files_saved_content_heads">) {
	return head.yjsContentHeadId === undefined ? (head.yjsLastSequenceId ? head._id : null) : head.yjsContentHeadId;
}

export async function files_saved_content_db_get_head(
	db: QueryCtx["db"],
	nodeOrId: Doc<"files_nodes"> | Id<"files_nodes">,
	fixedView?: files_saved_placement_FixedView,
) {
	const node = typeof nodeOrId === "string" ? await db.get("files_nodes", nodeOrId) : nodeOrId;
	if (!node || node.kind !== "file") return null;
	let headId = node.contentHeadId;
	if (!headId) throw should_never_happen("Saved file has no content head", { nodeId: node._id });
	if (node.moveCohortId) {
		const cohort = await db.get("files_move_cohorts", node.moveCohortId);
		if (
			!cohort ||
			cohort.organizationId !== node.organizationId ||
			cohort.workspaceId !== node.workspaceId ||
			(fixedView && fixedView.cohortId !== cohort._id)
		)
			throw should_never_happen("Saved content cohort is missing or changed", { nodeId: node._id });
		// Staging can preview a new location before its content is ready.
		if (cohort.publishedAt !== null && (fixedView?.view ?? cohort.visibleView) === "after") {
			const content = await db
				.query("files_move_cohort_content")
				.withIndex("by_cohort_node", (q) => q.eq("cohortId", cohort._id).eq("nodeId", node._id))
				.unique();
			if (content && (!content.beforeHeadId || !content.afterHeadId))
				throw should_never_happen("Saved content candidate has no head", { contentId: content._id });
			// A later replacement owns its new head, even while Review still owns the location.
			if (content && content.beforeHeadId === headId) {
				if (!content.sealed || !content.afterHeadId)
					throw should_never_happen("Saved content candidate is not sealed", { contentId: content._id });
				headId = content.afterHeadId;
			}
		}
	}
	const head = await db.get("files_saved_content_heads", headId);
	if (
		!head ||
		head.organizationId !== node.organizationId ||
		head.workspaceId !== node.workspaceId ||
		head.fileNodeId !== node._id ||
		!head.ready ||
		head.retired
	)
		throw should_never_happen("Saved content head is missing or changed", { nodeId: node._id, headId });
	return head;
}

export function files_saved_content_apply_header(
	node: Doc<"files_nodes">,
	head: Doc<"files_saved_content_heads"> | null,
): Doc<"files_nodes"> {
	if (!head) return node;
	return {
		...node,
		contentHeadId: head._id,
		contentType: head.contentType,
		...files_content_type_index_fields(head.contentType),
		assetId: head.assetId,
		pendingContentVersion: head.pendingContentVersion,
		contentByteSize: head.contentByteSize,
		textKind: head.textKind,
		collaborationEnabled: head.collaborationEnabled,
		yjsSnapshotId: head.yjsSnapshotId,
		yjsLastSequenceId: head.yjsLastSequenceId,
		statsId: head.statsId,
		contentTooLargeByteSize: head.contentTooLargeByteSize,
		contentShapeMismatchAt: head.contentShapeMismatchAt,
		contentYjsStateTooLargeByteSize: head.contentYjsStateTooLargeByteSize,
		contentFrontmatterTooLargeFieldCount: head.contentFrontmatterTooLargeFieldCount,
		contentFrontmatterTooLargeIndexDocumentCount: head.contentFrontmatterTooLargeIndexDocumentCount,
		// Archive and Restore can change the file time without changing its bytes.
		updatedAt: Math.max(node.updatedAt, head.updatedAt),
		updatedBy: head.updatedAt > node.updatedAt ? head.updatedBy : node.updatedBy,
	};
}
