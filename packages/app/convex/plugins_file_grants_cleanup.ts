import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { internalMutation } from "./functions.ts";
import { files_nodes_db_has_extended_grants, files_nodes_db_set_extended_scope } from "./files_sharing_db.ts";
import { files_subtree_ops_db_start_rebuild } from "./files_subtree_ops_rebuild.ts";
import { files_saved_placement_db_get_node } from "../server/files-saved-placement.ts";

// Ordinary shares and open plugin consents use the same inheritance root.
export async function plugins_file_grants_db_retire_anchor(
	ctx: MutationCtx,
	args: { nodeId: Id<"files_nodes">; userId: Id<"users"> },
) {
	const node = await files_saved_placement_db_get_node(ctx.db, args.nodeId);
	if (!node?.workspaceId || node.purgeRunId || node.parentExtendedScopeNodeId === undefined) return;
	const workspaceId = ctx.db.normalizeId("organizations_workspaces", node.workspaceId);
	if (!workspaceId) return;
	const workspace = await ctx.db.get("organizations_workspaces", workspaceId);
	if (!workspace || workspace.pluginDataPurgeStartedAt !== undefined) return;
	if (await files_nodes_db_has_extended_grants(ctx, { nodeId: node._id })) return;
	await files_nodes_db_set_extended_scope(ctx, { nodeId: node._id, extended: false });
	await files_subtree_ops_db_start_rebuild(ctx, {
		kind: "scope",
		organizationId: workspace.organizationId,
		workspaceId: workspace._id,
		userId: args.userId,
		membership: null,
		roots: [{ node, oldTreePath: node.treePath }],
		budget: { nodes: 0, hasPaginated: false },
		deferWalk: true,
		now: Date.now(),
	});
}

export const retire_anchor = internalMutation({
	args: { nodeId: v.id("files_nodes"), userId: v.id("users") },
	returns: v.null(),
	handler: async (ctx, args) => {
		await plugins_file_grants_db_retire_anchor(ctx, args);
		return null;
	},
});

// Drain children before their pair. Every caller repeats until done.
export async function plugins_file_grants_db_drain_pair(
	ctx: MutationCtx,
	args: { pair: Doc<"plugins_file_pairs">; batchSize: number },
) {
	const consents = await ctx.db
		.query("plugins_file_consents")
		.withIndex("by_pair", (q) => q.eq("pairId", args.pair._id))
		.take(args.batchSize);
	for (const consent of consents) await ctx.db.delete("plugins_file_consents", consent._id);
	for (const nodeId of new Set(consents.map((consent) => consent.rootNodeId))) {
		if (nodeId === null) continue;
		// Each root has its own scope walk and database budget.
		await ctx.scheduler.runAfter(0, internal.plugins_file_grants_cleanup.retire_anchor, {
			nodeId,
			userId: args.pair.userId,
		});
	}
	if (consents.length > 0) return { done: false, deletedCount: consents.length };
	await ctx.db.delete("plugins_file_pairs", args.pair._id);
	return { done: false, deletedCount: 1 };
}

export async function plugins_file_grants_db_drain_installation(
	ctx: MutationCtx,
	args: { installationId: Id<"plugins_workspace_installations">; batchSize: number },
) {
	const pair = await ctx.db
		.query("plugins_file_pairs")
		.withIndex("by_installation_user_lifetime", (q) => q.eq("installationId", args.installationId))
		.first();
	if (pair) return await plugins_file_grants_db_drain_pair(ctx, { pair, batchSize: args.batchSize });
	return { done: true, deletedCount: 0 };
}
