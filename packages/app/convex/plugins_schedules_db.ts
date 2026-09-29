// Keep scheduled cancellation safe to import from auth and permission producers.
import { Workpool } from "@convex-dev/workpool";

import { components } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { activities_db_finish } from "./activities_db.ts";

export const plugins_scheduled_runs_workpool = new Workpool(components.plugins_scheduled_runs_workpool, {
	maxParallelism: 2,
	retryActionsByDefault: true,
	defaultRetryBehavior: {
		initialBackoffMs: 10 * 1000,
		base: 2,
		maxAttempts: 3,
	} as const,
});

export async function plugins_schedules_db_cancel(
	ctx: MutationCtx,
	args: {
		organizationId?: Id<"organizations">;
		workspaceId?: Id<"organizations_workspaces">;
		installationId?: Id<"plugins_workspace_installations">;
		pluginName?: string;
		userId?: Id<"users">;
		serviceAccountId?: Id<"access_control_service_accounts">;
	},
) {
	const now = Date.now();
	const pages = await Promise.all(
		(["queued", "running", "stopping"] as const).map((status) =>
			ctx.db
				.query("activities")
				.withIndex("by_source_kind_event_status_deadline_organization", (q) =>
					q
						.eq("source.kind", "plugin_run")
						.eq("source.event", "schedule.interval.elapsed")
						.eq("status", status)
						.gt("deadlineAt", now),
				)
				.take(5),
		),
	);
	let canceledCount = 0;
	// Admission allows only four live chains. Expired work is already fenced and has its own recovery.
	for (const activity of pages.flat()) {
		if (activity.source.kind !== "plugin_run") continue;
		const run = await ctx.db.get("plugins_event_runs", activity.source.id);
		if (
			!run ||
			(args.organizationId && run.organizationId !== args.organizationId) ||
			(args.workspaceId && run.workspaceId !== args.workspaceId) ||
			(args.installationId && run.installationId !== args.installationId) ||
			(args.userId && run.actorUserId !== args.userId) ||
			(args.serviceAccountId && run.serviceAccountId !== args.serviceAccountId)
		)
			continue;
		if (args.pluginName) {
			const installation = await ctx.db.get("plugins_workspace_installations", run.installationId);
			if (installation?.pluginName !== args.pluginName) continue;
		}
		await ctx.db.patch("plugins_event_runs", run._id, {
			apiTokenHash: undefined,
			apiTokenExpiresAt: undefined,
			chainInputState: undefined,
			followUpState: undefined,
		});
		const calls = await ctx.db
			.query("plugins_event_run_calls")
			.withIndex("by_run_sequence", (q) => q.eq("runId", run._id))
			.take(20);
		for (const call of calls) {
			if (call.status !== "started") continue;
			await ctx.db.patch("plugins_event_run_calls", call._id, {
				status: "failed",
				errorCode: "run_ended",
				errorMessage: "Run canceled before the call finished",
				finishedAt: now,
				elapsedMs: now - call.startedAt,
				updatedAt: now,
			});
		}
		await activities_db_finish(ctx, {
			sourceId: run._id,
			status: "canceled",
			errorMessage: "Scheduled access changed",
			errorCode: "assignment_changed",
			now,
		});
		if (run.workId) await plugins_scheduled_runs_workpool.cancel(ctx, run.workId);
		canceledCount += 1;
	}
	return { canceledCount };
}
