import type { RegisteredQuery } from "convex/server";
import { doc } from "convex-helpers/validators";
import { v } from "convex/values";
import { internalQuery, query } from "./_generated/server.js";
import app_convex_schema from "./schema.ts";
import { server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";
import { workspaces_db_get_membership } from "./workspaces.ts";

export const get_by_file_node_for_membership = query({
	args: {
		membershipId: v.id("workspaces_projects_users"),
		fileNodeId: v.id("files_nodes"),
	},
	returns: v.union(doc(app_convex_schema, "files_node_properties"), v.null()),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return null;
		}

		const membership = await workspaces_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return null;
		}

		const properties = await ctx.db
			.query("files_node_properties")
			.withIndex("by_file_node", (q) => q.eq("fileNodeId", args.fileNodeId))
			.first();
		if (
			!properties ||
			properties.workspaceId !== membership.workspaceId ||
			properties.projectId !== membership.projectId
		) {
			return null;
		}

		return properties;
	},
});

export const get_by_file_node = internalQuery({
	args: {
		fileNodeId: v.id("files_nodes"),
	},
	returns: v.union(doc(app_convex_schema, "files_node_properties"), v.null()),
	handler: async (ctx, args) => {
		return await ctx.db
			.query("files_node_properties")
			.withIndex("by_file_node", (q) => q.eq("fileNodeId", args.fileNodeId))
			.first();
	},
});

export type files_node_properties_get_by_file_node_Result =
	typeof get_by_file_node extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;
