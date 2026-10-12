// Fixtures shared by files_nodes.read_only.test.ts and files_nodes.move_nodes.test.ts.
import { expect, vi } from "vitest";
import { api } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { test_convex, test_finish_pending_update_run, test_mocks_fill_db_with } from "./setup.test.ts";

export async function accept_move_proposals_for_test(
	t: ReturnType<typeof test_convex>,
	db: Awaited<ReturnType<typeof test_mocks_fill_db_with.membership>>,
	proposalIds: Id<"files_pending_updates">[],
) {
	const hadFakeTimers = vi.isFakeTimers();
	if (!hadFakeTimers) vi.useFakeTimers();
	try {
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const proposals = await t.run((ctx) =>
			Promise.all(proposalIds.map((id) => ctx.db.get("files_pending_updates", id))),
		);
		const started = await asUser.mutation(api.files_pending_update_runs.start, {
			membershipId: db.membershipId,
			requestId: crypto.randomUUID(),
			kind: "accept",
			expectedItemCount: proposals.length,
			items: proposals.map((proposal) => ({
				pendingUpdateId: proposal!._id,
				reviewedRevision: proposal!.revision,
				selectedContentStateId: proposal!.content?.stagedStateId ?? null,
			})),
		});
		if (started._nay) throw new Error(started._nay.message);
		expect(
			await asUser.mutation(api.files_pending_update_runs.seal, {
				membershipId: db.membershipId,
				runId: started._yay.runId,
			}),
		).toEqual({ _yay: null });
		await test_finish_pending_update_run(asUser, started._yay.runId);
		return await t.run(async (ctx) => ({
			activity: await ctx.db.get("activities", started._yay.activityId),
			units: await ctx.db
				.query("files_pending_update_run_units")
				.withIndex("by_run_order", (q) => q.eq("runId", started._yay.runId))
				.collect(),
		}));
	} finally {
		if (!hadFakeTimers) vi.useRealTimers();
	}
}
