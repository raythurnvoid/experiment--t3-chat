// Private identity and parent reads. Creation and cleanup stay in files_pending_nodes.ts.

import { Result } from "common/errors-as-values-utils.ts";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import { access_control_db_authorize_membership } from "./access_control.ts";
import { files_saved_placement_db_get_publish_receipt } from "../server/files-saved-placement.ts";
import { should_never_happen } from "../shared/shared-utils.ts";

// Leave room for content, permission, and review reads in the same transaction.
export const files_pending_nodes_MAX_PRIVATE_ANCESTORS = 256;

/**
 * Resolve read links only. The caller still checks current Files access.
 *
 * Save turns a private draft into a saved node. Follow an old draft link to that saved node, so a
 * link written before Save keeps working after it.
 */
export async function files_pending_nodes_db_resolve_read_target(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		target: Doc<"files_pending_updates">["target"];
	},
) {
	if (args.target.kind === "saved") return args.target;

	// The saved node keeps this link after the short-lived publish receipt is removed.
	const privateNodeId = args.target.id;
	const saved = await ctx.db
		.query("files_nodes")
		.withIndex("by_organization_workspace_publishedFromPrivateNode", (q) =>
			q
				.eq("organizationId", args.organizationId)
				.eq("workspaceId", args.workspaceId)
				.eq("publishedFromPrivateNodeId", privateNodeId),
		)
		.first();

	if (!saved) return args.target;

	// An archived saved file is gone, so answer null instead of the old draft link.
	return saved.archiveOperationId === null ? { kind: "saved" as const, id: saved._id } : null;
}

/**
 * Resolve identity only. The caller checks the saved parent's current access and policy.
 */
export async function files_pending_nodes_db_resolve_saved_parent(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
		parent: Doc<"files_pending_nodes">["parent"];
	},
) {
	if (args.parent.kind === "root") return Result({ _yay: { parentId: "root" as const } });
	if (args.parent.kind === "saved") return Result({ _yay: { parentId: args.parent.id } });
	const node = await ctx.db.get("files_pending_nodes", args.parent.id);
	if (
		!node ||
		node.organizationId !== args.organizationId ||
		node.workspaceId !== args.workspaceId ||
		node.userId !== args.userId ||
		node.kind !== "folder"
	) {
		return Result({ _nay: { name: "not_found", message: "Not found" } });
	}
	if (node.state === "active") {
		return Result({ _nay: { name: "needs_review", message: "Save the parent folder before this move" } });
	}
	if (node.state === "discarded") {
		return Result({ _nay: { name: "target_changed", message: "The destination draft was discarded" } });
	}
	const receipt = await ctx.db
		.query("files_pending_node_publish_receipts")
		.withIndex("by_privateNode", (q) => q.eq("privateNodeId", node._id))
		.unique();
	if (!receipt) throw should_never_happen("Published private node has no receipt", { privateNodeId: node._id });
	return Result({ _yay: { parentId: receipt.savedNodeId } });
}

/**
 * Save-only exception for a copied parent's unchanged lock. It grants no editing access.
 */
export async function files_pending_nodes_db_can_save_to_copied_parent(
	ctx: QueryCtx | MutationCtx,
	args: {
		membership: Doc<"organizations_workspaces_users">;
		node: Doc<"files_pending_nodes">;
		savedParent: Doc<"files_nodes">;
		cohort?: { cohortId: Id<"files_move_cohorts">; fence: number; attemptFence: number };
	},
) {
	const { membership, node, savedParent } = args;
	if (
		!membership.active ||
		node.state !== "active" ||
		node.parent.kind !== "private" ||
		node.userId !== membership.userId ||
		node.organizationId !== membership.organizationId ||
		node.workspaceId !== membership.workspaceId ||
		savedParent.organizationId !== node.organizationId ||
		savedParent.workspaceId !== node.workspaceId ||
		savedParent.kind !== "folder" ||
		savedParent.archiveOperationId !== null
	)
		return false;
	const cohort = args.cohort ? await ctx.db.get("files_move_cohorts", args.cohort.cohortId) : null;
	if (
		args.cohort &&
		(!cohort ||
			cohort.organizationId !== membership.organizationId ||
			cohort.workspaceId !== membership.workspaceId ||
			cohort.userId !== membership.userId ||
			cohort.membershipId !== membership._id ||
			cohort.fence !== args.cohort.fence ||
			cohort.attemptFence !== args.cohort.attemptFence ||
			cohort.publishedAt !== null ||
			cohort.phase === "aborting" ||
			cohort.phase === "complete")
	)
		return false;
	// A selected copied parent has an AFTER identity before its private node is published.
	const readAfterReceipt = async (privateParent: Doc<"files_pending_nodes">) => {
		if (!cohort || privateParent.state !== "active") return null;
		const selected = await ctx.db
			.query("files_move_cohort_items")
			.withIndex("by_cohort_target", (q) =>
				q.eq("cohortId", cohort._id).eq("target.kind", "private").eq("target.id", privateParent._id),
			)
			.unique();
		const proposal = selected?.pendingUpdateId
			? await ctx.db.get("files_pending_updates", selected.pendingUpdateId)
			: null;
		if (
			!selected ||
			!proposal ||
			proposal.target.kind !== "private" ||
			proposal.target.id !== privateParent._id ||
			proposal.organizationId !== membership.organizationId ||
			proposal.workspaceId !== membership.workspaceId ||
			proposal.userId !== membership.userId ||
			proposal.revision !== selected.reviewedRevision ||
			selected.privateVersion?.creationGeneration !== privateParent.creationGeneration ||
			selected.privateVersion.structuralRevision !== privateParent.structuralRevision
		)
			return null;
		const receipt = await files_saved_placement_db_get_publish_receipt(
			ctx.db,
			{ ...membership, privateNodeId: privateParent._id },
			{ cohortId: cohort._id, view: "after" },
		);
		if (
			!receipt ||
			receipt.moveView?.cohortId !== cohort._id ||
			receipt.moveView.view !== "after" ||
			receipt.proposalRevision !== selected.reviewedRevision
		)
			return null;
		const record = await ctx.db.get("files_move_cohort_nodes", selected.nodeRecordId);
		return record?.cohortId === cohort._id && record.role === "allocated" && record.nodeId === receipt.savedNodeId
			? receipt
			: null;
	};
	const parent = await ctx.db.get("files_pending_nodes", node.parent.id);
	if (
		!parent ||
		(parent.state !== "published" && !(cohort && parent.state === "active")) ||
		parent.kind !== "folder" ||
		parent.userId !== node.userId ||
		parent.organizationId !== node.organizationId ||
		parent.workspaceId !== node.workspaceId ||
		parent.name !== savedParent.name ||
		savedParent.publishedFromPrivateNodeId !== parent._id
	)
		return false;
	const receipt =
		parent.state === "active"
			? await readAfterReceipt(parent)
			: await files_saved_placement_db_get_publish_receipt(ctx.db, { ...node, privateNodeId: parent._id });
	if (
		!receipt ||
		receipt.userId !== node.userId ||
		receipt.organizationId !== node.organizationId ||
		receipt.workspaceId !== node.workspaceId ||
		receipt.savedNodeId !== savedParent._id ||
		receipt.creationGeneration + (parent.state === "published" ? 1 : 0) !== parent.creationGeneration ||
		receipt.structuralRevision !== parent.structuralRevision ||
		!receipt.copiedReadOnlyDecisionId ||
		receipt.copiedPath !== savedParent.path ||
		!savedParent.readOnly ||
		receipt.copiedReadOnlyDecisionId !== savedParent.readOnlyDecisionId
	)
		return false;
	let originalParentId: Id<"files_nodes"> | "root";
	if (cohort && parent.parent.kind === "private") {
		const grandparent = await ctx.db.get("files_pending_nodes", parent.parent.id);
		if (
			!grandparent ||
			grandparent.organizationId !== node.organizationId ||
			grandparent.workspaceId !== node.workspaceId ||
			grandparent.userId !== node.userId ||
			grandparent.kind !== "folder"
		)
			return false;
		const original =
			grandparent.state === "active"
				? await readAfterReceipt(grandparent)
				: await files_saved_placement_db_get_publish_receipt(ctx.db, { ...node, privateNodeId: grandparent._id });
		if (!original) return false;
		originalParentId = original.savedNodeId;
	} else {
		const original = await files_pending_nodes_db_resolve_saved_parent(ctx, { ...node, parent: parent.parent });
		if (original._nay) return false;
		originalParentId = original._yay.parentId;
	}
	if (originalParentId !== savedParent.parentId) return false;
	return !(
		await access_control_db_authorize_membership(ctx, {
			userAuth: { id: node.userId },
			membership,
			fileNode: savedParent,
			permission: "content.write",
		})
	)._nay;
}

/**
 * Resolve an owner's active private chain to its saved parent or the workspace root.
 * A published parent is followed through its receipt. A discarded parent hides its descendants.
 * Callers still check membership and the saved parent's current access and write policy.
 */
export async function files_pending_nodes_db_get_ancestry(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
		privateNodeId: Id<"files_pending_nodes">;
		// Owner recovery reads only. Normal path and write callers must leave this unset.
		allowArchivedParent?: true;
	},
) {
	const ancestors: Doc<"files_pending_nodes">[] = [];
	let privateNodeId = args.privateNodeId;
	let savedParentId: Id<"files_nodes"> | null = null;
	while (true) {
		const node = await ctx.db.get("files_pending_nodes", privateNodeId);
		if (
			!node ||
			node.organizationId !== args.organizationId ||
			node.workspaceId !== args.workspaceId ||
			node.userId !== args.userId
		) {
			return Result({ _nay: { name: "not_found", message: "Not found" } });
		}
		if (node.state === "discarded" || (ancestors.length === 0 && node.state === "published")) {
			return Result({ _nay: { name: "target_changed", message: "This draft is no longer active" } });
		}
		if (node.state === "published") {
			const receipt = await ctx.db
				.query("files_pending_node_publish_receipts")
				.withIndex("by_privateNode", (q) => q.eq("privateNodeId", node._id))
				.first();
			if (!receipt) {
				throw should_never_happen("Published private node has no receipt", { privateNodeId: node._id });
			}
			savedParentId = receipt.savedNodeId;
			break;
		}
		ancestors.push(node);
		if (node.parent.kind === "root") break;
		if (node.parent.kind === "saved") {
			savedParentId = node.parent.id;
			break;
		}
		if (ancestors.length === files_pending_nodes_MAX_PRIVATE_ANCESTORS) {
			return Result({ _nay: { name: "too_large", message: "This draft has too many parent folders" } });
		}
		privateNodeId = node.parent.id;
	}

	const savedParent = savedParentId === null ? null : await ctx.db.get("files_nodes", savedParentId);
	if (
		savedParentId !== null &&
		(!savedParent ||
			savedParent.organizationId !== args.organizationId ||
			savedParent.workspaceId !== args.workspaceId ||
			savedParent.kind !== "folder" ||
			(savedParent.archiveOperationId !== null && !args.allowArchivedParent))
	) {
		return Result({ _nay: { name: "target_changed", message: "This draft's destination is no longer available" } });
	}

	return Result({ _yay: { node: ancestors[0]!, ancestors: ancestors.slice(1), savedParent } });
}
