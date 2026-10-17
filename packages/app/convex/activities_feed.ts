// Activity feed reads. Producers and controls stay in activities.ts.

import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v } from "convex/values";
import { doc } from "convex-helpers/validators";
import type { Doc, Id } from "./_generated/dataModel.js";
import { query, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import { activities_get_controls } from "./activities_db.ts";
import { organizations_db_get_membership } from "./organizations_memberships_db.ts";
import {
	access_control_db_authorize_membership,
	access_control_db_filter_readable_file_nodes,
} from "./access_control.ts";
import app_convex_schema from "./schema.ts";
import { convex_error } from "../server/convex-utils.ts";
import { server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";
import { files_saved_placement_db_get_node } from "../server/files-saved-placement.ts";

// Reuse the loaded module between calls. Keep request state inside each query.
export const experimental_reuseContext = true;

/**
 * Each page bounds both the scan and its access checks.
 */
export const activities_feed_LIST_MAX = 50;

/**
 * Keep only the activities the user may see.
 *
 * Plugin activities follow file access. Those with no named file require workspace read.
 * Transfer activities contain no file paths and are visible only to their requester.
 *
 * Every read and dismiss uses the same checks, including pages consumed by hidden entries.
 */
export async function activities_feed_db_filter_visible(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Doc<"activities">["organizationId"];
		workspaceId: Doc<"activities">["workspaceId"];
		userId: Id<"users">;
		activities: readonly Doc<"activities">[];
		/**
		 * Whether the caller proved workspace-wide `content.read`.
		 */
		hasWorkspaceRead: boolean;
	},
) {
	// Each node named on the page is looked up once, and the filter answers once per restricted scope.
	const candidates = args.activities.filter(
		(activity) => activity.feedVisible && (activity.visibility !== "requester" || activity.userId === args.userId),
	);
	const targetNodeIds = [...new Set(candidates.flatMap((activity) => activity.targets.map((target) => target.id)))];
	if (targetNodeIds.length === 0) {
		return candidates.filter((activity) => activity.visibility === "requester" || args.hasWorkspaceRead);
	}

	const targetNodes = (
		await Promise.all(targetNodeIds.map((nodeId) => files_saved_placement_db_get_node(ctx.db, nodeId)))
	).filter((fileNode) => fileNode !== null);
	const targetNodeById = new Map(targetNodes.map((fileNode) => [fileNode._id, fileNode] as const));
	const readableNodeIds = new Set(
		(
			await access_control_db_filter_readable_file_nodes(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				subject: { kind: "user", userId: args.userId, plugin: null },
				nodes: targetNodes,
			})
		).map((fileNode) => fileNode._id),
	);

	return candidates.filter((activity) => {
		// Transfer activities belong to their requester and contain no file names or paths.
		if (activity.visibility === "requester") return true;

		// Hidden plugin work can start without a file, but feed opt-in still requires one.
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

export async function activities_feed_db_list_visible_page(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
		hasWorkspaceRead: boolean;
		section: "active" | "history";
		paginationOpts: { cursor: string | null; numItems: number };
	},
) {
	const page = await ctx.db
		.query("activities")
		.withIndex("by_organization_workspace_feedVisible_finishedAt_updatedAt", (q) => {
			const scope = q
				.eq("organizationId", args.organizationId)
				.eq("workspaceId", args.workspaceId)
				.eq("feedVisible", true);
			return args.section === "active" ? scope.eq("finishedAt", undefined) : scope.gt("finishedAt", undefined);
		})
		.order("desc")
		.paginate({ ...args.paginationOpts, numItems: Math.min(activities_feed_LIST_MAX, args.paginationOpts.numItems) });
	const visible = await activities_feed_db_filter_visible(ctx, { ...args, activities: page.page });
	const states = await Promise.all(
		visible.map((activity) =>
			ctx.db
				.query("activities_user_states")
				.withIndex("by_user_activity", (q) => q.eq("userId", args.userId).eq("activityId", activity._id))
				.unique(),
		),
	);
	return {
		...page,
		page: visible
			.filter((_activity, index) => states[index] === null)
			.map((activity) => ({
				...activity,
				controls: activities_get_controls(activity, args.userId),
			})),
	};
}

export const list_page = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		section: v.union(v.literal("active"), v.literal("history")),
		paginationOpts: paginationOptsValidator,
	},
	returns: paginationResultValidator(
		v.object({
			...doc(app_convex_schema, "activities").fields,
			controls: v.object({
				canStop: v.boolean(),
				canRetry: v.boolean(),
				canDismiss: v.boolean(),
			}),
		}),
	),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) throw convex_error({ message: "Unauthenticated" });
		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) return { page: [], isDone: true, continueCursor: "" };
		const authorized = await access_control_db_authorize_membership(ctx, {
			userAuth,
			membership,
			permission: "content.read",
		});
		return await activities_feed_db_list_visible_page(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: userAuth.id,
			hasWorkspaceRead: !authorized._nay,
			section: args.section,
			paginationOpts: args.paginationOpts,
		});
	},
});
