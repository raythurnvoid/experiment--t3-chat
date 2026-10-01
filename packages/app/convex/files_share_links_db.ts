// DB helpers that delete public file links when a file's access situation changes.
//
// File lifecycle modules and access-control grant removal both call these helpers. So this module
// imports only generated types and lean helpers. It must not import `files_nodes.ts`,
// `access_control.ts`, or the public share doors in `files_share_links.ts`, or those imports would
// form a cycle.

import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { files_db_resolve_scope } from "./files_scopes.ts";
import { organizations_is_global_organization_id } from "../shared/organizations.ts";

/**
 * Most active public links in one workspace.
 *
 * A safety bound on query and cleanup cost, not a plan allowance, so it is a code constant and not a
 * quota.
 */
export const files_share_links_MAX_PER_WORKSPACE = 500;

/**
 * Cleanup state owned by one mutation.
 *
 * The mutation creates it once and passes it to every root cleanup it runs. So each workspace's link
 * docs are loaded at most once, and a doc one call deleted is skipped by the next. Never keep it in a
 * module-level cache: it belongs to one transaction.
 */
export type files_share_links_CleanupState = {
	docsByWorkspace: Map<Id<"organizations_workspaces">, Doc<"files_share_links">[]>;
	deletedIds: Set<Id<"files_share_links">>;
};

export function files_share_links_create_cleanup_state(): files_share_links_CleanupState {
	return { docsByWorkspace: new Map(), deletedIds: new Set() };
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
 *
 * This reads the live index, so it needs no cleanup state: a link another call already deleted is not
 * found again.
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
		await ctx.db.delete("files_share_links", link._id);
	}
}

/**
 * Delete every link on a root or below it.
 *
 * A link doc stores its file's ancestor IDs, so this matches in memory and never loads file nodes or
 * reads tree paths. It loads the workspace's link docs once per cleanup state. Callers union the roots
 * they know before calling, and pass the same state to later calls in the same mutation.
 */
export async function files_share_links_db_delete_for_roots(
	ctx: MutationCtx,
	args: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		rootNodeIds: Iterable<Id<"files_nodes">>;
	},
	state: files_share_links_CleanupState,
) {
	const rootNodeIds = new Set<Id<"files_nodes">>(args.rootNodeIds);
	if (rootNodeIds.size === 0) {
		return;
	}

	const scope = resolve_link_scope(ctx, args);
	if (!scope) {
		return;
	}

	let links = state.docsByWorkspace.get(scope.workspaceId);
	if (!links) {
		// `set_node_share_link` refuses the link past this bound, so this reads every link here.
		links = await ctx.db
			.query("files_share_links")
			.withIndex("by_organization_workspace_node", (q) =>
				q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId),
			)
			.take(files_share_links_MAX_PER_WORKSPACE);
		state.docsByWorkspace.set(scope.workspaceId, links);
	}

	for (const link of links) {
		if (state.deletedIds.has(link._id)) {
			continue;
		}
		if (!rootNodeIds.has(link.nodeId) && !link.ancestorNodeIds.some((ancestorId) => rootNodeIds.has(ancestorId))) {
			continue;
		}

		// `files_share_links_db_delete_for_node` may have deleted this doc after it was loaded, because
		// it does not record into the state.
		state.deletedIds.add(link._id);
		if (await ctx.db.get("files_share_links", link._id)) {
			await ctx.db.delete("files_share_links", link._id);
		}
	}
}
