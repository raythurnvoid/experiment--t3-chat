// DB helpers that delete public file links when a file's access situation changes.
//
// File lifecycle modules and access-control grant removal both call these helpers. So this module
// imports only generated types and lean helpers. It must not import `files_nodes.ts`,
// `access_control.ts`, or the public share doors in `files_share_links.ts`, or those imports would
// form a cycle.

import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import { files_db_resolve_scope } from "./files_scopes.ts";
import { organizations_is_global_organization_id } from "../shared/organizations.ts";
import { should_never_happen } from "../shared/shared-utils.ts";

/**
 * Most active public links in one workspace.
 *
 * A safety bound on query and cleanup cost, not a plan allowance, so it is a code constant and not a
 * quota.
 */
export const files_share_links_MAX_PER_WORKSPACE = 500;

/**
 * End the link now, then remove its publication records in background pages.
 */
export async function files_share_links_db_delete(ctx: MutationCtx, linkId: Id<"files_share_links">) {
	await ctx.db.delete("files_share_links", linkId);
	const media = await ctx.db
		.query("files_share_link_media")
		.withIndex("by_link_mediaNode", (q) => q.eq("linkId", linkId))
		.first();
	if (media)
		await ctx.scheduler.runAfter(0, internal.files_share_link_media_db.cleanup_link_media, { linkId, cursor: null });
}

/**
 * The real workspace for link cleanup, or `null` when the scope can never hold a link.
 *
 * File helpers also handle global, plugin-volume, and reserved scopes. Those files can never get a link,
 * so their normal cleanup runs without any link work. Check the global organization first, then the
 * scope, in the same order as `files_media_validation_db_advance_version`.
 */
function resolve_link_scope(
	ctx: MutationCtx,
	args: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
	},
) {
	const { organizationId } = args;
	if (organizations_is_global_organization_id(organizationId)) {
		return null;
	}

	const scope = files_db_resolve_scope(ctx, args.workspaceId);
	if (scope.kind !== "workspace") {
		return null;
	}

	return { organizationId, workspaceId: scope.workspaceId };
}

/**
 * Delete the link of one exact file, if it has one.
 */
export async function files_share_links_db_delete_for_node(
	ctx: MutationCtx,
	args: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		nodeId: Id<"files_nodes">;
	},
) {
	const scope = resolve_link_scope(ctx, args);
	if (!scope) {
		return;
	}

	const link = await ctx.db
		.query("files_share_links")
		.withIndex("by_organization_workspace_node", (q) =>
			q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId).eq("nodeId", args.nodeId),
		)
		.first();
	if (link) {
		await files_share_links_db_delete(ctx, link._id);
	}
}

/**
 * Delete the links of every file whose stored scope is `scopeNodeId`.
 *
 * Call it when that node becomes or stops being a restricted root, or gets a plugin binding. The files
 * inside keep the same scope id then, so no scope job deletes their links.
 */
export async function files_share_links_db_delete_for_scope(
	ctx: MutationCtx,
	args: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		/**
		 * Never `null`: that would delete every open link of the workspace.
		 */
		scopeNodeId: Id<"files_nodes">;
	},
) {
	const scope = resolve_link_scope(ctx, args);
	if (!scope) {
		return;
	}

	// `set_node_share_link` keeps at most this many links in a workspace, so this reads at most that many.
	const links = await ctx.db
		.query("files_share_links")
		.withIndex("by_organization_workspace_scope", (q) =>
			q
				.eq("organizationId", scope.organizationId)
				.eq("workspaceId", scope.workspaceId)
				.eq("restrictedScopeNodeId", args.scopeNodeId),
		)
		.take(files_share_links_MAX_PER_WORKSPACE + 1);
	if (links.length > files_share_links_MAX_PER_WORKSPACE) {
		throw should_never_happen("Too many public links in one scope", args);
	}
	for (const link of links) {
		await files_share_links_db_delete(ctx, link._id);
	}
}
