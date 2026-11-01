import { v } from "convex/values";
import { internalMutation } from "./functions.ts";
import { files_archive_runs_db_delete_run_batch } from "./files_archive_runs.ts";
import { convex_error } from "../server/convex-utils.ts";

/**
 * Delete finished archive, restore, and purge history before the restore schema changes.
 * Remove this temporary function after the empty-table readback.
 */
export const delete_finished = internalMutation({
	args: {},
	returns: v.object({ deletedCount: v.number(), done: v.boolean() }),
	handler: async (ctx) => {
		const run = await ctx.db.query("files_archive_runs").first();
		if (!run) return { deletedCount: 0, done: true };
		if (run.active) {
			throw convex_error({ message: "An archive run is active. Wait for it to finish before deleting history." });
		}

		// Use the same child and Activity cleanup as normal history retention, one batch per call.
		const deleted = await files_archive_runs_db_delete_run_batch(ctx, { runId: run._id });
		return {
			deletedCount: deleted.deletedCount,
			done: deleted.done && (await ctx.db.query("files_archive_runs").first()) === null,
		};
	},
});
