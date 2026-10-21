// Old per-link media approvals. "Anyone on the web" replaced them, so nothing reads them for access and
// nothing writes new ones. The rows stay until their removal is approved. A deleted link still removes
// its own rows, as before.

import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import { internalMutation } from "./functions.ts";

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
