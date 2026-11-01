import { v } from "convex/values";
import { internalMutation } from "./functions.ts";
import { files_trash_tops_db_advance, files_trash_tops_db_recover } from "../server/files-trash-tops.ts";

export const advance = internalMutation({
	args: { jobId: v.id("files_trash_top_jobs"), step: v.number() },
	returns: v.null(),
	handler: async (ctx, args) => {
		await files_trash_tops_db_advance(ctx, args);
		return null;
	},
});

export const recover = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		await files_trash_tops_db_recover(ctx);
		return null;
	},
});
