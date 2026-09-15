import type { Doc, Id } from "./_generated/dataModel.js";
import type { QueryCtx } from "./_generated/server.js";
import { access_control_db_filter_readable_file_nodes } from "./access_control.ts";
import { files_visible_db_create_reader } from "./files_visible.ts";
import { files_pending_update_has_pending_chunks } from "../server/files.ts";
import { files_pending_update_content_is_stale, type files_VisibleEntry } from "../shared/files.ts";
import {
	organizations_is_global_organization_id,
	organizations_is_reserved_workspace_id,
} from "../shared/organizations.ts";

/**
 * Reuse access and ancestor reads across one page of indexed results.
 */
export async function files_search_db_create_reader(
	ctx: QueryCtx,
	args: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		userId: Id<"users">;
		serviceAccountId?: Id<"access_control_service_accounts">;
		hasWorkspaceRead?: boolean;
	},
) {
	const ownerReader =
		args.serviceAccountId === undefined &&
		!organizations_is_global_organization_id(args.organizationId) &&
		!organizations_is_reserved_workspace_id(args.workspaceId)
			? await files_visible_db_create_reader(ctx, {
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					userId: args.userId,
				})
			: null;
	const entries = new Map<string, files_VisibleEntry | null>();

	async function resolveDocument(document: Doc<"files_metadata_docs"> | Doc<"files_plain_text_chunks">) {
		// A pending index doc belongs to one owner. Hide it from every other member, and from callers
		// that read without an owner overlay, such as service accounts and reserved scopes.
		if (document.sourceKind === "pending" && (document.userId !== args.userId || !ownerReader)) return null;

		const target =
			document.sourceKind === "committed" ? { kind: "saved" as const, id: document.fileNodeId } : document.target;
		const key = `${target.kind}:${target.id}`;
		let entry = entries.get(key);
		if (entry === undefined) {
			if (ownerReader) {
				entry = await ownerReader.resolveTarget(target);
			} else {
				if (target.kind === "private") return null;
				const node = await ctx.db.get("files_nodes", target.id);
				const readable =
					node?.archiveOperationId === null
						? await access_control_db_filter_readable_file_nodes(ctx, {
								organizationId: args.organizationId,
								workspaceId: args.workspaceId,
								userId: args.userId,
								serviceAccountId: args.serviceAccountId,
								hasWorkspaceRead: args.hasWorkspaceRead,
								nodes: [node],
							})
						: [];
				entry = readable.length > 0 && node ? { kind: "saved", node, pendingUpdate: null, path: node.path } : null;
			}
			entries.set(key, entry);
		}
		if (entry === null) return null;

		// A private draft becomes searchable only after its creation intent and its text are sealed.
		if (
			entry.kind === "private" &&
			(entry.pendingUpdate.preparation ||
				!entry.pendingUpdate.createIntent ||
				(entry.pendingUpdate.createIntent.kind === "text" && !entry.pendingUpdate.content))
		)
			return null;

		const pendingUpdate = entry.pendingUpdate;
		const isMetadata = "fieldPath" in document && document.fieldPath.startsWith("metadata.");
		const hasPendingContent =
			pendingUpdate !== null &&
			!pendingUpdate.preparation &&
			files_pending_update_has_pending_chunks(pendingUpdate) &&
			(entry.kind === "private" || !files_pending_update_content_is_stale(pendingUpdate, entry.node));

		// Drop an indexed pending doc once its proposal is gone or its revision moved on. A pending
		// metadata doc belongs to a private draft only, and a pending content doc needs current
		// pending chunks. A saved content doc is hidden while the owner has pending content, so one
		// search never returns both copies of the same file.
		if (document.sourceKind === "pending") {
			if (
				!pendingUpdate ||
				pendingUpdate._id !== document.pendingUpdateId ||
				pendingUpdate.revision !== document.proposalRevision
			)
				return null;
			if (isMetadata ? entry.kind !== "private" : !hasPendingContent) return null;
		} else if (!isMetadata && hasPendingContent) return null;

		return { target, path: entry.path };
	}

	return {
		resolveDocument,
		get exhausted() {
			return ownerReader?.exhausted ?? false;
		},
	};
}
