// Workspace activity feed: plugin work and private transfer runs. Producers update activities
// in the same mutation as their work, so progress and results stay in sync. The `source` field
// links each activity to its run through `by_source_id`. Each producer owns expiry and cleanup.

import { v } from "convex/values";
import { doc } from "convex-helpers/validators";
import type { ExcludeStrict } from "type-fest";
import type { Doc, Id } from "./_generated/dataModel.js";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import { organizations_db_get_membership } from "./organizations.ts";
import {
	access_control_db_authorize_membership,
	access_control_db_filter_readable_file_nodes,
} from "./access_control.ts";
import app_convex_schema from "./schema.ts";
import { convex_error, v_result } from "../server/convex-utils.ts";
import { server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";
import { Result } from "common/errors-as-values-utils.ts";

// Make Convex reuse the loaded module between calls, so warm calls skip the module load cost.
// Does NOT work for http actions (see http.ts). No mutable module-level state allowed here.
export const experimental_reuseContext = true;

/**
 * The plugin activity deadline limit. Transfer runs manage their own expiry.
 */
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
		/**
		 * The file the plugin work started from. Its name may appear in the title, so activity
		 * visibility must follow access to this file.
		 */
		target: Doc<"activities">["targets"][number];
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
		targets: [args.target],
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

/**
 * Limit recent history. The caller's active transfer run is added if it falls outside this page.
 */
const ACTIVITIES_LIST_MAX = 50;

/**
 * Keep only the activities the user may see.
 *
 * Plugin activities follow file access. Those with no named file require workspace read.
 * Transfer activities contain no file paths and are visible only to their requester.
 *
 * Every surface that reads or dismisses activities uses this, so the feed and the dismiss buttons
 * always agree on what exists. Without it "Dismiss all" would archive an activity the caller cannot
 * see, and `archivedAt` is one field on the doc rather than one per user, so the people who can see
 * the file would lose it from their feed and never learn why.
 */
async function db_filter_visible_activities(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Doc<"activities">["organizationId"];
		workspaceId: Doc<"activities">["workspaceId"];
		userId: Id<"users">;
		activities: readonly Doc<"activities">[];
		/** Whether the caller holds workspace-wide `content.read`, proved by the caller. */
		hasWorkspaceRead: boolean;
	},
) {
	// Each node named on the page is looked up once, and the filter answers once per restricted scope.
	const candidates = args.activities.filter(
		(activity) => activity.source.kind !== "files_transfer_run" || activity.userId === args.userId,
	);
	const targetNodeIds = [...new Set(candidates.flatMap((activity) => activity.targets.map((target) => target.id)))];
	if (targetNodeIds.length === 0) {
		return candidates.filter((activity) => activity.source.kind === "files_transfer_run" || args.hasWorkspaceRead);
	}

	const targetNodes = (await Promise.all(targetNodeIds.map((nodeId) => ctx.db.get("files_nodes", nodeId)))).filter(
		(fileNode) => fileNode !== null,
	);
	const targetNodeById = new Map(targetNodes.map((fileNode) => [fileNode._id, fileNode] as const));
	const readableNodeIds = new Set(
		(
			await access_control_db_filter_readable_file_nodes(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				userId: args.userId,
				nodes: targetNodes,
				hasWorkspaceRead: args.hasWorkspaceRead,
			})
		).map((fileNode) => fileNode._id),
	);

	return candidates.filter((activity) => {
		// Transfer activities belong to their requester and contain no file names or paths.
		if (activity.source.kind === "files_transfer_run") return true;

		// Only docs written before the target above became mandatory can be empty here.
		if (activity.targets.length === 0) {
			return args.hasWorkspaceRead;
		}

		// One hidden or moved file is enough to drop the whole activity. The stored path, title, target
		// message, and error belong to the old location, so current access cannot make them safe to show.
		return activity.targets.every(
			(target) => readableNodeIds.has(target.id) && targetNodeById.get(target.id)?.path === target.path,
		);
	});
}

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

		// Folder guests can read activities about their files and their private transfer runs.
		// Plugin activities with no named file still require workspace read.
		const readAuthorized = await access_control_db_authorize_membership(ctx, {
			userAuth,
			membership,
			permission: "content.read",
		});
		const hasWorkspaceRead = !readAuthorized._nay;

		// Newest activity first; running items bubble up because every change bumps updatedAt.
		// Dismissed items (archivedAt > 0) stay in the table for their producers; the index skips them here.
		const activities = await ctx.db
			.query("activities")
			.withIndex("by_organization_workspace_archivedAt_updatedAt", (q) =>
				q.eq("organizationId", membership.organizationId).eq("workspaceId", membership.workspaceId).eq("archivedAt", 0),
			)
			.order("desc")
			.take(ACTIVITIES_LIST_MAX);

		// A long Paste must keep its Stop button even after newer activities fill the page.
		const transferRun = await ctx.db
			.query("files_transfer_runs")
			.withIndex("by_user_workspace_active", (q) =>
				q.eq("userId", userAuth.id).eq("workspaceId", membership.workspaceId).eq("active", true),
			)
			.unique();
		if (transferRun) {
			const transferActivity = await ctx.db
				.query("activities")
				.withIndex("by_source_id", (q) => q.eq("source.id", transferRun._id))
				.unique();
			if (transferActivity && !activities.some((activity) => activity._id === transferActivity._id))
				activities.unshift(transferActivity);
		}

		return await db_filter_visible_activities(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: userAuth.id,
			activities,
			hasWorkspaceRead,
		});
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

		const authorized = await access_control_db_authorize_membership(ctx, {
			userAuth,
			membership,
			permission: "content.write",
		});
		const activity = await ctx.db.get("activities", args.activityId);
		if (
			!activity ||
			activity.organizationId !== membership.organizationId ||
			activity.workspaceId !== membership.workspaceId
		) {
			return Result({ _nay: { message: "Activity not found" } });
		}
		// Transfer activities are private to their requester, so their owner may dismiss one without
		// workspace write permission.
		if (authorized._nay && !(activity.source.kind === "files_transfer_run" && activity.userId === userAuth.id)) {
			return authorized;
		}

		// Writing in the workspace is not the same as being allowed to see this activity, so ask the
		// same question `list_recent` asks. An activity the caller cannot see must answer like one that
		// is not there, otherwise the refusal itself says a hidden file was worked on.
		const readAuthorized = await access_control_db_authorize_membership(ctx, {
			userAuth,
			membership,
			permission: "content.read",
		});
		const [visible] = await db_filter_visible_activities(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: userAuth.id,
			activities: [activity],
			hasWorkspaceRead: !readAuthorized._nay,
		});
		if (!visible) {
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

		const authorized = await access_control_db_authorize_membership(ctx, {
			userAuth,
			membership,
			permission: "content.write",
		});
		const active = await ctx.db
			.query("activities")
			.withIndex("by_organization_workspace_archivedAt_updatedAt", (q) =>
				q.eq("organizationId", membership.organizationId).eq("workspaceId", membership.workspaceId).eq("archivedAt", 0),
			)
			.collect();
		// Running activities still need to be visible, so bulk dismiss only covers finished ones.
		// Without workspace write permission, only the caller's own transfer activities qualify.
		const finished = active.filter(
			(activity) =>
				activity.status !== "running" &&
				(!authorized._nay || (activity.source.kind === "files_transfer_run" && activity.userId === userAuth.id)),
		);
		if (authorized._nay && finished.length === 0) return authorized;

		// Dismiss only what the caller can see. `archivedAt` is one field on the doc and not one per
		// user, so archiving an activity about a restricted file would take it away from the people who
		// do hold that file, and they would never learn why it went.
		const readAuthorized = await access_control_db_authorize_membership(ctx, {
			userAuth,
			membership,
			permission: "content.read",
		});
		const visible = await db_filter_visible_activities(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: userAuth.id,
			activities: finished,
			hasWorkspaceRead: !readAuthorized._nay,
		});
		const now = Date.now();

		await Promise.all(
			visible.map((activity) => ctx.db.patch("activities", activity._id, { archivedAt: now, updatedAt: now })),
		);

		return Result({ _yay: { count: visible.length } });
	},
});

/**
 * Close plugin activities past their deadline. Transfer recovery stops its own work first.
 */
export const timeout_stale_activities = internalMutation({
	args: {},
	returns: v.object({
		count: v.number(),
	}),
	handler: async (ctx) => {
		const now = Date.now();
		const running = await ctx.db
			.query("activities")
			.withIndex("by_status_timeoutAt", (q) => q.eq("status", "running").lte("timeoutAt", now))
			.collect();
		// Transfer expiry must stop its producer before the activity can finish.
		const stale = running.filter((activity) => activity.source.kind !== "files_transfer_run");

		await Promise.all(
			stale.map((activity) =>
				ctx.db.patch("activities", activity._id, { status: "timeout", finishedAt: now, updatedAt: now }),
			),
		);

		return { count: stale.length };
	},
});
