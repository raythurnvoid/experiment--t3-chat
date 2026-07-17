// Workspace activity feed: one doc per user-visible unit of background work (today plugin runs;
// future internal processes add source variants). Producers call these helpers only from their
// own mutations, in the same transaction as the domain state change they mirror, so an activity
// can never drift from the real state. The activity's `source` points back at its producer
// (looked up via the `by_source_id` index), and the producer owns the activity's whole
// lifecycle, including deleting it on retention.

import { v } from "convex/values";
import { doc } from "convex-helpers/validators";
import type { ExcludeStrict } from "type-fest";
import type { Doc } from "./_generated/dataModel.js";
import { internalMutation, mutation, query, type MutationCtx } from "./_generated/server.js";
import { organizations_db_get_membership } from "./organizations.ts";
import app_convex_schema from "./schema.ts";
import { convex_error, v_result } from "../server/convex-utils.ts";
import { server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";
import { Result } from "common/errors-as-values-utils.ts";

// Make Convex reuse the loaded module between calls, so warm calls skip the module load cost.
// Does NOT work for http actions (see http.ts). No mutable module-level state allowed here.
export const experimental_reuseContext = true;

/** The longest an activity may run before the timeout cron closes it. */
export const ACTIVITIES_TIMEOUT_MAX_MS = 5 * 60 * 1000;

export async function activities_db_start(
	ctx: MutationCtx,
	args: {
		organizationId: Doc<"activities">["organizationId"];
		workspaceId: Doc<"activities">["workspaceId"];
		userId: Doc<"activities">["userId"];
		source: Doc<"activities">["source"];
		/** Status-neutral display text, e.g. "Video plugin · speakers.mp4". */
		title: Doc<"activities">["title"];
		/** Caller-predicted deadline; must be at most ACTIVITIES_TIMEOUT_MAX_MS after now. */
		timeoutAt: Doc<"activities">["timeoutAt"];
		now: number;
	},
) {
	return await ctx.db.insert("activities", {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		userId: args.userId,
		status: "running",
		source: args.source,
		title: args.title,
		errorMessage: null,
		targets: [],
		timeoutAt: args.timeoutAt,
		archivedAt: 0,
		updatedAt: args.now,
	});
}

/** The producer's activity (e.g. the one a plugin run opted into), or null when it never started one. */
export async function activities_db_get_by_source_id(ctx: MutationCtx, sourceId: Doc<"activities">["source"]["id"]) {
	return await ctx.db
		.query("activities")
		.withIndex("by_source_id", (q) => q.eq("source.id", sourceId))
		.unique();
}

export async function activities_db_finish(
	ctx: MutationCtx,
	args: {
		sourceId: Doc<"activities">["source"]["id"];
		status: ExcludeStrict<Doc<"activities">["status"], "running">;
		errorMessage: Doc<"activities">["errorMessage"];
		now: number;
	},
) {
	const activity = await activities_db_get_by_source_id(ctx, args.sourceId);
	if (!activity) {
		return;
	}
	await ctx.db.patch("activities", activity._id, {
		status: args.status,
		errorMessage: args.errorMessage,
		finishedAt: args.now,
		updatedAt: args.now,
	});
}

export async function activities_db_add_target(
	ctx: MutationCtx,
	args: {
		sourceId: Doc<"activities">["source"]["id"];
		target: Doc<"activities">["targets"][number];
		now: number;
	},
) {
	const activity = await activities_db_get_by_source_id(ctx, args.sourceId);
	if (!activity) {
		return;
	}

	// A touch then a fill of the same output must not duplicate the target.
	if (activity.targets.some((target) => target.id === args.target.id)) {
		return;
	}

	await ctx.db.patch("activities", activity._id, {
		targets: [...activity.targets, args.target],
		updatedAt: args.now,
	});
}

/** The feed stays short-lived (producers delete activities on retention), so a flat cap is enough. */
const ACTIVITIES_LIST_MAX = 50;

export const list_recent = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
	},
	returns: v.array(doc(app_convex_schema, "activities")),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			throw convex_error({ message: "Unauthenticated" });
		}
		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return [];
		}

		// Newest activity first; running items bubble up because every change bumps updatedAt.
		// Dismissed items (archivedAt > 0) stay in the table for their producers; the index skips them here.
		return await ctx.db
			.query("activities")
			.withIndex("by_organization_workspace_archivedAt_updatedAt", (q) =>
				q.eq("organizationId", membership.organizationId).eq("workspaceId", membership.workspaceId).eq("archivedAt", 0),
			)
			.order("desc")
			.take(ACTIVITIES_LIST_MAX);
	},
});

export const archive_activity = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		activityId: v.id("activities"),
	},
	returns: v_result({
		_yay: v.null(),
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}
		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const activity = await ctx.db.get("activities", args.activityId);
		if (
			!activity ||
			activity.organizationId !== membership.organizationId ||
			activity.workspaceId !== membership.workspaceId
		) {
			return Result({ _nay: { message: "Activity not found" } });
		}
		// Only finished work can be dismissed; a running activity still needs to be visible.
		if (activity.status === "running") {
			return Result({ _nay: { message: "Activity is still running" } });
		}

		if (activity.archivedAt === 0) {
			const now = Date.now();
			await ctx.db.patch("activities", activity._id, { archivedAt: now, updatedAt: now });
		}

		return Result({ _yay: null });
	},
});

export const archive_all_activities = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
	},
	returns: v_result({
		_yay: v.object({
			count: v.number(),
		}),
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}
		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const active = await ctx.db
			.query("activities")
			.withIndex("by_organization_workspace_archivedAt_updatedAt", (q) =>
				q.eq("organizationId", membership.organizationId).eq("workspaceId", membership.workspaceId).eq("archivedAt", 0),
			)
			.collect();
		// Running activities still need to be visible, so bulk dismiss only covers finished ones.
		const finished = active.filter((activity) => activity.status !== "running");
		const now = Date.now();

		await Promise.all(
			finished.map((activity) => ctx.db.patch("activities", activity._id, { archivedAt: now, updatedAt: now })),
		);

		return Result({ _yay: { count: finished.length } });
	},
});

/** Cron: close running activities past their deadline, so a dead producer never leaves one running forever. */
export const timeout_stale_activities = internalMutation({
	args: {},
	returns: v.object({
		count: v.number(),
	}),
	handler: async (ctx) => {
		const now = Date.now();
		const stale = await ctx.db
			.query("activities")
			.withIndex("by_status_timeoutAt", (q) => q.eq("status", "running").lte("timeoutAt", now))
			.collect();

		await Promise.all(
			stale.map((activity) =>
				ctx.db.patch("activities", activity._id, { status: "timeout", finishedAt: now, updatedAt: now }),
			),
		);

		return { count: stale.length };
	},
});
