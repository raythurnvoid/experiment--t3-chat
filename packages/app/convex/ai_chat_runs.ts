// One `ai_chat_runs` doc per agent run execution: a `/api/chat` request or one `run_job_wakeup`
// action. The run id travels through the run, so later writes can check which run is writing.
// The thread's `activeRun` lease stays the job-wake rule; these docs only decide when it is cleared.

import { v, type Infer } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel.js";
import { internal } from "./_generated/api.js";
import { internalMutation, type MutationCtx } from "./_generated/server.js";
import type { ai_chat_workspaces_source_validator } from "./schema.ts";
import { ai_chat_outputs_db_release_run } from "./ai_chat_outputs.ts";

// Make Convex reuse the loaded module between calls, so warm calls skip the module load cost.
// Does NOT work for http actions (see http.ts). No mutable module-level state allowed here.
export const experimental_reuseContext = true;

/**
 * Ending a run also releases up to 50 reservations and 50 pending owners. Five runs per pass keep
 * one watchdog mutation well under the Convex limits on reads, writes and scheduled functions.
 */
const WATCHDOG_BATCH_SIZE = 5;
const OTHER_RUNS_READ_SIZE = 50;

/**
 * Insert the run doc for one run execution. Its lease ends when the thread lease it holds ends.
 */
export async function ai_chat_runs_db_insert(
	ctx: MutationCtx,
	args: {
		kind: Doc<"ai_chat_runs">["kind"];
		leaseExpiresAt: number;
		source: Infer<typeof ai_chat_workspaces_source_validator>;
	},
) {
	return await ctx.db.insert("ai_chat_runs", {
		organizationId: args.source.organizationId,
		workspaceId: args.source.workspaceId,
		threadId: args.source.threadId,
		userId: args.source.userId,
		membershipId: args.source.membershipId,
		membershipLifetime: args.source.membershipLifetime,
		kind: args.kind,
		status: "running",
		leaseExpiresAt: args.leaseExpiresAt,
		endedAt: null,
	});
}

/**
 * End one run and give the thread lease back when no other live run of the lease's kind still
 * runs. A chat run that ends after a handover keeps the wake lease, and one of two chat tabs
 * ending keeps the other tab's lease. Ending an ended run does nothing.
 *
 * The run also gives back the output reservations and pending output owners it left. An attach
 * that arrives later is refused, because the run is no longer running.
 */
export async function ai_chat_runs_db_end(ctx: MutationCtx, args: { runId: Id<"ai_chat_runs">; now: number }) {
	const run = await ctx.db.get("ai_chat_runs", args.runId);
	if (!run || run.status === "ended") return;
	await ctx.db.patch("ai_chat_runs", run._id, { status: "ended", endedAt: args.now });

	if (await ai_chat_outputs_db_release_run(ctx, run._id)) {
		await ctx.scheduler.runAfter(0, internal.ai_chat_outputs.release_run, { runId: run._id });
	}

	const thread = await ctx.db.get("ai_chat_threads", run.threadId);
	const activeRun = thread?.activeRun;
	if (!thread || !activeRun) return;

	const otherRuns = await ctx.db
		.query("ai_chat_runs")
		.withIndex("by_thread_status", (q) => q.eq("threadId", run.threadId).eq("status", "running"))
		.take(OTHER_RUNS_READ_SIZE);
	// A run whose action died keeps `running` until the watchdog ends it, so only live runs count.
	const leaseStillHeld = otherRuns.some((other) => other.kind === activeRun.kind && other.leaseExpiresAt > args.now);
	if (!leaseStillHeld) {
		await ctx.db.patch("ai_chat_threads", thread._id, { activeRun: undefined });
	}
}

/**
 * End runs whose lease passed without a run end, for example after a killed action.
 */
export const end_expired_runs = internalMutation({
	args: { _test_now: v.optional(v.number()), _test_disableReschedule: v.optional(v.boolean()) },
	returns: v.null(),
	handler: async (ctx, args) => {
		const now = args._test_now ?? Date.now();
		const expired = await ctx.db
			.query("ai_chat_runs")
			.withIndex("by_status_leaseExpiresAt", (q) => q.eq("status", "running").lte("leaseExpiresAt", now))
			.take(WATCHDOG_BATCH_SIZE);
		for (const run of expired) {
			await ai_chat_runs_db_end(ctx, { runId: run._id, now });
		}

		// A full batch means more runs may still be waiting.
		if (expired.length === WATCHDOG_BATCH_SIZE && !args._test_disableReschedule) {
			await ctx.scheduler.runAfter(0, internal.ai_chat_runs.end_expired_runs, {});
		}
		return null;
	},
});
