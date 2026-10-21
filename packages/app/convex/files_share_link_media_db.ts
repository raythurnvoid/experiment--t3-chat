// Publication records contain only checked file and asset ids. Public reads still check the live link.

import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import { internalMutation } from "./functions.ts";
import { files_is_inline_media_content_type } from "../shared/files.ts";
import { files_share_links_db_is_selected } from "../server/files-share-links.ts";
import {
	files_saved_placement_db_get_node,
	files_saved_placement_db_resolve_read_target,
} from "../server/files-saved-placement.ts";
import { files_media_parse_src } from "../shared/files-media.ts";

/**
 * A draft reference can publish only the saved file it became.
 */
export async function files_share_link_media_db_resolve_node(
	ctx: QueryCtx | MutationCtx,
	args: { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces">; src: string },
) {
	const parsed = files_media_parse_src(args.src);
	let nodeId: Id<"files_nodes"> | null = null;
	if (parsed.kind === "file") nodeId = ctx.db.normalizeId("files_nodes", parsed.fileNodeId);
	else if (parsed.kind === "private") {
		const privateId = ctx.db.normalizeId("files_pending_nodes", parsed.privateNodeId);
		const target = privateId
			? await files_saved_placement_db_resolve_read_target(ctx.db, {
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					target: { kind: "private", id: privateId },
				})
			: null;
		if (target?.kind === "saved") nodeId = target.id;
	}
	const node = nodeId ? await files_saved_placement_db_get_node(ctx.db, nodeId) : null;
	return node &&
		node.organizationId === args.organizationId &&
		node.workspaceId === args.workspaceId &&
		node.archiveOperationId === null &&
		node.kind === "file" &&
		files_is_inline_media_content_type(node.contentType)
		? node
		: null;
}

/**
 * The caller must prove this actor can write the document and read this exact media file.
 */
export async function files_share_link_media_db_approve(
	ctx: MutationCtx,
	args: { link: Doc<"files_share_links">; mediaNode: Doc<"files_nodes">; userId: Id<"users"> },
) {
	const { link, mediaNode } = args;
	if (
		mediaNode.kind !== "file" ||
		mediaNode.organizationId !== link.organizationId ||
		mediaNode.workspaceId !== link.workspaceId ||
		mediaNode.archiveOperationId !== null ||
		mediaNode.restrictedScopeNodeId !== link.restrictedScopeNodeId ||
		!files_is_inline_media_content_type(mediaNode.contentType) ||
		!mediaNode.assetId ||
		!(await files_share_links_db_is_selected(ctx.db, link))
	)
		return false;
	const asset = await ctx.db.get("files_r2_assets", mediaNode.assetId);
	if (!asset || asset.organizationId !== link.organizationId || asset.workspaceId !== link.workspaceId) return false;
	const approval = await ctx.db
		.query("files_share_link_media")
		.withIndex("by_link_mediaNode", (q) => q.eq("linkId", link._id).eq("mediaNodeId", mediaNode._id))
		.first();
	if (approval?.assetId === asset._id) return true;
	const fields = { assetId: asset._id, approvedBy: args.userId, approvedAt: Date.now() };
	if (approval) await ctx.db.patch("files_share_link_media", approval._id, fields);
	else
		await ctx.db.insert("files_share_link_media", {
			organizationId: link.organizationId,
			workspaceId: link.workspaceId,
			linkId: link._id,
			mediaNodeId: mediaNode._id,
			...fields,
		});
	return true;
}

/**
 * The link is already gone. Old publication docs grant nothing while these pages are removed.
 */
export const cleanup_link_media = internalMutation({
	args: { linkId: v.id("files_share_links"), cursor: v.union(v.string(), v.null()) },
	returns: v.null(),
	handler: async (ctx, args) => {
		if (await ctx.db.get("files_share_links", args.linkId)) return null;
		const page = await ctx.db
			.query("files_share_link_media")
			.withIndex("by_link_mediaNode", (q) => q.eq("linkId", args.linkId))
			.paginate({ cursor: args.cursor, numItems: 100 });
		for (const doc of page.page) await ctx.db.delete("files_share_link_media", doc._id);
		if (!page.isDone)
			await ctx.scheduler.runAfter(0, internal.files_share_link_media_db.cleanup_link_media, {
				linkId: args.linkId,
				cursor: page.continueCursor,
			});
		return null;
	},
});
