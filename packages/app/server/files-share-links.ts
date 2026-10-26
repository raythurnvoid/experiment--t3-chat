// Checks that a public link or a public file may show right now. The link pages in
// convex/files_share_links.ts and the public flag writer in convex/files_sharing_db.ts both use them.
//
// This module is not a leaf: the scope check imports convex/files_nodes_db.ts to find plugin bindings.

import type { Doc, Id } from "../convex/_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "../convex/_generated/server.js";
import { files_nodes_db_has_plugin_binding } from "../convex/files_nodes_db.ts";
import { files_saved_placement_db_get_node } from "./files-saved-placement.ts";
import { Result } from "common/errors-as-values-utils.ts";

/**
 * A moved link expires at publication, before its physical row is removed.
 */
export async function files_share_links_db_is_selected(db: QueryCtx["db"], link: Doc<"files_share_links">) {
	if (!link.moveView) return true;
	const cohort = await db.get("files_move_cohorts", link.moveView.cohortId);
	return (
		cohort !== null &&
		cohort.organizationId === link.organizationId &&
		cohort.workspaceId === link.workspaceId &&
		cohort.visibleView === link.moveView.view
	);
}

/**
 * Whether the organization and workspace exist and no deletion has started. Reads 4 docs.
 */
export async function files_share_links_db_is_workspace_live(
	ctx: QueryCtx | MutationCtx,
	args: { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces"> },
) {
	const organization = await ctx.db.get("organizations", args.organizationId);
	const workspace = await ctx.db.get("organizations_workspaces", args.workspaceId);
	// A deletion request exists before the purge starts, so it hides the file first. Look up this
	// organization's request and this workspace's request exactly. A request for another workspace of
	// the same organization must not hide this file.
	const organizationDeletion = await ctx.db
		.query("data_deletion_requests")
		.withIndex("by_organization_workspace", (q) =>
			q.eq("organizationId", args.organizationId).eq("workspaceId", undefined),
		)
		.first();
	const workspaceDeletion = await ctx.db
		.query("data_deletion_requests")
		.withIndex("by_organization_workspace", (q) =>
			q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId),
		)
		.first();
	return (
		organization !== null &&
		workspace !== null &&
		workspace.organizationId === args.organizationId &&
		workspace.pluginDataPurgeStartedAt === undefined &&
		organizationDeletion === null &&
		workspaceDeletion === null
	);
}

/**
 * Whether a link may trust a stored restricted scope. A live link's scope is null, or a live
 * restricted root with no plugin binding. `dead` means the scope node stopped being a root, which
 * ended its links, so a new link waits for the scope op. `bound` means a plugin decides who reads the
 * area. Reads at most 5 docs. Never cache the answer: a turn-on and a bind at the same moment must
 * read the same binding docs, so one of them retries.
 */
export async function files_share_links_db_check_scope(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		restrictedScopeNodeId: Id<"files_nodes"> | null;
	},
) {
	if (args.restrictedScopeNodeId === null) {
		return "ok" as const;
	}

	const scopeNode = await files_saved_placement_db_get_node(ctx.db, args.restrictedScopeNodeId);
	if (
		!scopeNode ||
		scopeNode.organizationId !== args.organizationId ||
		scopeNode.workspaceId !== args.workspaceId ||
		scopeNode.restrictedScopeNodeId !== scopeNode._id
	) {
		return "dead" as const;
	}
	if (await files_nodes_db_has_plugin_binding(ctx, scopeNode._id)) {
		return "bound" as const;
	}

	return "ok" as const;
}

/**
 * Check that a file may become public right now. The same live checks as a link
 * (`db_check_live_file` in convex/files_share_links.ts), but any file may be public:
 * public pages show it only when it is an image or video.
 */
export async function files_share_links_db_check_live_node(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		node: Doc<"files_nodes">;
	},
) {
	if (args.node.archiveOperationId !== null) {
		return Result({ _nay: { message: "This item is archived" } });
	}

	if (!(await files_share_links_db_is_workspace_live(ctx, args))) {
		return Result({ _nay: { message: "This workspace is being deleted" } });
	}

	const scope = await files_share_links_db_check_scope(ctx, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		restrictedScopeNodeId: args.node.restrictedScopeNodeId,
	});
	if (scope === "dead") {
		return Result({ _nay: { name: "not_ready", message: "Wait until the access change of a folder above finishes" } });
	}
	if (scope === "bound") {
		return Result({ _nay: { message: "A plugin decides who can read this item, so it cannot be public" } });
	}

	return Result({ _yay: null });
}
