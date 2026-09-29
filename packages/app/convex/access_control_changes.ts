import type { Doc } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { plugins_schedules_db_cancel } from "./plugins_schedules_db.ts";

// Record access changes in the same transaction as the source change.
export async function access_control_changes_db_record(
	ctx: MutationCtx,
	events: Array<Pick<Doc<"access_control_changes">, "scope" | "event">>,
) {
	if (events.length === 0) return;
	// Local scheduled runs must stop even before the external change feed starts.
	for (const { scope, event } of events) {
		if (
			event.kind !== "revoked" &&
			!(event.kind === "refresh" && (event.reason === "permissions" || event.reason === "account"))
		)
			continue;
		await plugins_schedules_db_cancel(
			ctx,
			scope.kind === "all"
				? {}
				: scope.kind === "organization"
					? { organizationId: scope.organizationId }
					: scope.kind === "workspace"
						? { organizationId: scope.organizationId, workspaceId: scope.workspaceId }
						: scope.kind === "installation"
							? { installationId: scope.installationId }
							: scope.kind === "user"
								? { userId: scope.userId }
								: { serviceAccountId: scope.serviceAccountId },
		);
	}

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
