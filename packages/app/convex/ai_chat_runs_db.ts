// Shared database bodies. Keep editor and action work on their current owners.

import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";

/**
 * Whether a write of this run generation may still happen: the run runs, and Stop has not raised
 * its generation.
 */
export async function ai_chat_runs_db_is_current(
	ctx: QueryCtx | MutationCtx,
	fence: { runId: Id<"ai_chat_runs">; generation: number },
) {
	const run = await ctx.db.get("ai_chat_runs", fence.runId);
	return run?.status === "running" && run.generation === fence.generation;
}
