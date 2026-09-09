import type { Doc } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";

// Record access changes in the same transaction as the source change.
export async function access_control_changes_db_record(
	ctx: MutationCtx,
	events: Array<Pick<Doc<"access_control_changes">, "scope" | "event">>,
) {
	if (events.length === 0) return;

	const state = await ctx.db
		.query("access_control_change_state")
		.withIndex("by_key", (q) => q.eq("key", "main"))
		.first();
	// Before the first lease there is no remote authority to invalidate.
	if (!state) return;

	const now = Date.now();
	await Promise.all(
		events.map((event, index) =>
			ctx.db.insert("access_control_changes", {
				...event,
				revision: state.revision + index + 1,
				createdAt: now,
			}),
		),
	);
	await ctx.db.patch("access_control_change_state", state._id, { revision: state.revision + events.length });
}
