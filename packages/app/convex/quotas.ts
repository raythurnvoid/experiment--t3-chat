import { v } from "convex/values";
import { doc } from "convex-helpers/validators";

import type { Id } from "./_generated/dataModel";
import { query, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import { convex_error } from "../server/convex-utils.ts";
import { server_convex_get_user_fallback_to_anonymous, should_never_happen } from "../server/server-utils.ts";
import { quotas } from "../shared/quotas.ts";
import app_convex_schema from "./schema.ts";

export async function quotas_db_get(
	ctx: QueryCtx | MutationCtx,
	args:
		| {
				quotaName: "extra_workspaces";
				userId: Id<"users">;
		  }
		| {
				quotaName: "extra_projects";
				workspaceId: Id<"workspaces">;
		  },
) {
	const quota =
		args.quotaName === "extra_workspaces"
			? await ctx.db
					.query("quotas")
					.withIndex("by_user_quotaName", (q) => q.eq("userId", args.userId).eq("quotaName", args.quotaName))
					.first()
			: await ctx.db
					.query("quotas")
					.withIndex("by_workspace_quotaName", (q) =>
						q.eq("workspaceId", args.workspaceId).eq("quotaName", args.quotaName),
					)
					.first();

	if (!quota) {
		throw should_never_happen("Missing quota doc", {
			quotaName: args.quotaName,
			...(args.quotaName === "extra_workspaces" ? { userId: args.userId } : { workspaceId: args.workspaceId }),
		});
	}

	return quota;
}

export async function quotas_db_ensure(
	ctx: MutationCtx,
	args:
		| {
				quotaName: "extra_workspaces";
				userId: Id<"users">;
				now: number;
		  }
		| {
				quotaName: "extra_projects";
				workspaceId: Id<"workspaces">;
				now: number;
		  },
) {
	const quotaDefinition = quotas[args.quotaName];
	const existing =
		args.quotaName === "extra_workspaces"
			? await ctx.db
					.query("quotas")
					.withIndex("by_user_quotaName", (q) => q.eq("userId", args.userId).eq("quotaName", args.quotaName))
					.first()
			: await ctx.db
					.query("quotas")
					.withIndex("by_workspace_quotaName", (q) =>
						q.eq("workspaceId", args.workspaceId).eq("quotaName", args.quotaName),
					)
					.first();
	if (existing) {
		return existing._id;
	}

	return await ctx.db.insert("quotas", {
		quotaName: args.quotaName,
		...(args.quotaName === "extra_workspaces" ? { userId: args.userId } : { workspaceId: args.workspaceId }),
		usedCount: 0,
		maxCount: quotaDefinition.maxCount,
		createdAt: args.now,
		updatedAt: args.now,
	});
}

/**
 * Return a persisted quota doc only after proving the caller can access the typed quota scope.
 */
export const get = query({
	args: {
		quotaName: app_convex_schema.tables.quotas.validator.fields.quotaName,
		userId: v.optional(v.id("users")),
		workspaceId: v.optional(v.id("workspaces")),
	},
	returns: v.union(doc(app_convex_schema, "quotas"), v.null()),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			throw convex_error({ message: "Unauthenticated" });
		}

		const userDoc = await ctx.db.get("users", userAuth.id);
		if (!userDoc || userDoc.deletedAt != null) {
			// A live browser tab can keep a valid Convex identity briefly after
			// account deletion removes the user's quota docs. Treat that as a
			// stale subscription, not as quota usage drift.
			return null;
		}

		if (args.quotaName === "extra_workspaces") {
			// A user quota is private to the same user id as the authenticated app user.
			if (!args.userId || args.userId !== userAuth.id) {
				return null;
			}

			return await quotas_db_get(ctx, {
				quotaName: args.quotaName,
				userId: args.userId,
			});
		}

		if (args.quotaName === "extra_projects") {
			const workspaceId = args.workspaceId;
			if (!workspaceId) {
				return null;
			}

			// Workspace quotas are scoped to the whole workspace. Any active
			// membership in that workspace is enough to read the quota, regardless
			// of which project created the membership doc.
			const membershipDoc = await ctx.db
				.query("workspaces_projects_users")
				.withIndex("by_active_user_workspace_project", (q) =>
					q.eq("active", true).eq("userId", userAuth.id).eq("workspaceId", workspaceId),
				)
				.first();

			if (!membershipDoc) {
				return null;
			}

			return await quotas_db_get(ctx, {
				quotaName: args.quotaName,
				workspaceId,
			});
		}

		throw should_never_happen("Unhandled quota name", {
			quotaName: args.quotaName,
		});
	},
});
