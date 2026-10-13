// Keep the action small. Load content helpers only when a step needs them.
import type { RegisteredMutation } from "convex/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api.js";
import { internalAction } from "./_generated/server.js";
import { files_move_content_action_prepare } from "./files_move_content.ts";

console.info("Move startup module", { module: "files_move_run" });
console.info("Move startup helper", files_move_content_action_prepare.name);

const RUN_BUDGET_MS = 5_000;
const RUN_MAX_ADVANCE_CALLS = 128;

type advance_Result =
	typeof import("./files_move_cohorts.ts").advance extends RegisteredMutation<
		infer _Visibility,
		infer _Args,
		infer ReturnValue
	>
		? Awaited<ReturnValue>
		: never;

export const run = internalAction({
	args: {
		cohortId: v.id("files_move_cohorts"),
		step: v.number(),
		runGeneration: v.union(v.number(), v.null()),
		mode: v.union(v.literal("step"), v.literal("chain")),
	},
	returns: v.union(v.null(), v.literal("complete")),
	handler: async (ctx, args) => {
		const startedAt = Date.now();
		let step = args.step;
		try {
			for (let count = 0; count < RUN_MAX_ADVANCE_CALLS; count++) {
				let pending: advance_Result = await ctx.runMutation(internal.files_move_cohorts.advance, {
					cohortId: args.cohortId,
					step,
					runGeneration: args.runGeneration,
					join: args.mode === "chain",
				});
				if (!pending) return null;
				if (pending.kind === "complete") return "complete" as const;
				if (pending.kind === "prepare" || pending.kind === "media") {
					step = pending.step;
					const prepare =
						pending.kind === "prepare"
							? (await import("./files_move_content.ts")).files_move_content_action_prepare
							: (await import("./files_move_media.ts")).files_move_media_action_prepare_refs;
					const result = await prepare(ctx, {
						cohortId: args.cohortId,
						contentId: pending.contentId,
						fence: pending.fence,
						attemptFence: pending.attemptFence,
						runGeneration: args.runGeneration,
					});
					pending = await ctx.runMutation(internal.files_move_cohorts.resume, {
						cohortId: args.cohortId,
						step,
						runGeneration: args.runGeneration,
						error: result._nay ? { name: result._nay.name, message: result._nay.message } : null,
					});
					if (!pending) return null;
				}
				step = pending.step;
				if (args.mode === "step" || Date.now() - startedAt >= RUN_BUDGET_MS) break;
			}
			await ctx.runMutation(internal.files_move_cohorts.handoff, {
				cohortId: args.cohortId,
				step,
				runGeneration: args.runGeneration,
			});
		} catch (error) {
			console.error("Move step failed", { cohortId: args.cohortId, step, error });
			// Keep the real error, so a repair that keeps failing shows why.
			const data = error instanceof ConvexError ? (error.data as { name?: unknown; message?: unknown }) : null;
			const message =
				typeof data?.message === "string" ? data.message : error instanceof Error ? error.message : String(error);
			const name =
				typeof data?.name === "string"
					? data.name
					: message.startsWith("[should_never_happen]")
						? "should_never_happen"
						: "move_step_failed";
			await ctx.runMutation(internal.files_move_cohorts.resume, {
				cohortId: args.cohortId,
				step,
				runGeneration: args.runGeneration,
				error: {
					name: "move_step_failed",
					message: "This Move step failed. Review it again.",
					cause: { name, message },
				},
			});
		}
		return null;
	},
});

export const profile_move_startup = internalAction({
	args: { sample: v.number() },
	returns: v.null(),
	handler: async () => null,
});
