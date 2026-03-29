import { v } from "convex/values";
import { query } from "./_generated/server.js";
import { server_convex_get_user_fallback_to_anonymous, should_never_happen } from "../server/server-utils.ts";
import { user_limits, workspace_limits } from "../shared/limits.ts";

const user_limit_capability_validator = v.object({
	limitName: v.literal(user_limits.EXTRA_WORKSPACES.name),
	allowed: v.boolean(),
	usedCount: v.number(),
	maxCount: v.number(),
	remainingCount: v.number(),
	disabledReason: v.union(v.string(), v.null()),
});

const workspace_limit_capability_validator = v.object({
	limitName: v.literal(workspace_limits.EXTRA_PROJECTS.name),
	allowed: v.boolean(),
	usedCount: v.number(),
	maxCount: v.number(),
	remainingCount: v.number(),
	disabledReason: v.union(v.string(), v.null()),
});

export const get_user_limit = query({
	args: {
		userId: v.id("users"),
		limitName: v.literal(user_limits.EXTRA_WORKSPACES.name),
	},
	returns: v.union(user_limit_capability_validator, v.null()),
	handler: async (ctx, args) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (user.id !== args.userId) {
			return null;
		}

		const limitDefinition = user_limits.EXTRA_WORKSPACES;
		const limit = await ctx.db
			.query("limits_per_user")
			.withIndex("by_userId_limitName", (q) => q.eq("userId", args.userId).eq("limitName", args.limitName))
			.first();

		if (!limit) {
			throw should_never_happen("[limits.get_user_limit] Missing user limit doc", {
				userId: args.userId,
				limitName: args.limitName,
			});
		}

		const remainingCount = Math.max(0, limit.maxCount - limit.usedCount);

		return {
			limitName: limitDefinition.name,
			allowed: remainingCount > 0,
			usedCount: limit.usedCount,
			maxCount: limit.maxCount,
			remainingCount,
			disabledReason: remainingCount > 0 ? null : limitDefinition.disabledReason,
		};
	},
});

export const get_workspace_limit = query({
	args: {
		workspaceId: v.id("workspaces"),
		limitName: v.literal(workspace_limits.EXTRA_PROJECTS.name),
	},
	returns: v.union(workspace_limit_capability_validator, v.null()),
	handler: async (ctx, args) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);
		const membership = await ctx.db
			.query("workspaces_projects_users")
			.withIndex("by_userId_workspaceId_projectId", (q) =>
				q.eq("userId", user.id).eq("workspaceId", args.workspaceId),
			)
			.first();
		if (!membership) {
			return null;
		}

		const limitDefinition = workspace_limits.EXTRA_PROJECTS;
		const limit = await ctx.db
			.query("limits_per_workspace")
			.withIndex("by_workspaceId_limitName", (q) =>
				q.eq("workspaceId", args.workspaceId).eq("limitName", args.limitName),
			)
			.first();

		if (!limit) {
			throw should_never_happen("[limits.get_workspace_limit] Missing workspace limit doc", {
				workspaceId: args.workspaceId,
				limitName: args.limitName,
			});
		}

		const remainingCount = Math.max(0, limit.maxCount - limit.usedCount);

		return {
			limitName: limitDefinition.name,
			allowed: remainingCount > 0,
			usedCount: limit.usedCount,
			maxCount: limit.maxCount,
			remainingCount,
			disabledReason: remainingCount > 0 ? null : limitDefinition.disabledReason,
		};
	},
});
