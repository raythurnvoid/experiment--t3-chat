import type { Doc, Id } from "../convex/_generated/dataModel";
import type { MutationCtx } from "../convex/_generated/server";

/**
 * Retention after queue: purge uses each document's Convex `_creationTime` (via the built-in `by_creation_time` index).
 * `scope` records what is being deleted (see `data_deletion_requests.scope` in Convex schema).
 */
export type data_deletion_RequestScope = Doc<"data_deletion_requests">["scope"];

export async function data_deletion_db_request(
	ctx: MutationCtx,
	args: {
		userId: Id<"users">;
		workspaceId?: Id<"workspaces">;
		projectId?: Id<"workspaces_projects">;
		scope: data_deletion_RequestScope;
	},
) {
	if (args.scope === "user") {
		const existing = await ctx.db
			.query("data_deletion_requests")
			.withIndex("by_userId", (q) => q.eq("userId", args.userId))
			.filter((q) => q.eq(q.field("scope"), "user"))
			.first();

		if (existing) {
			return existing._id;
		}

		return await ctx.db.insert("data_deletion_requests", {
			userId: args.userId,
			scope: "user",
		});
	}

	if (!args.workspaceId) {
		throw new Error("Workspace id is required for workspace/project deletion requests");
	}

	if (args.scope === "project") {
		if (!args.projectId) {
			throw new Error("Project id is required for project deletion requests");
		}

		const existing = await ctx.db
			.query("data_deletion_requests")
			.withIndex("by_workspace_project", (q) => q.eq("workspaceId", args.workspaceId).eq("projectId", args.projectId))
			.first();

		if (existing) {
			return existing._id;
		}

		return await ctx.db.insert("data_deletion_requests", {
			userId: args.userId,
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			scope: "project",
		});
	}

	const existingRequests = await ctx.db
		.query("data_deletion_requests")
		.withIndex("by_workspace_project", (q) => q.eq("workspaceId", args.workspaceId))
		.collect();

	const existingWorkspaceRequest = existingRequests.find(
		(row) => row.scope === "workspace" && row.projectId === undefined,
	);

	if (existingWorkspaceRequest) {
		return existingWorkspaceRequest._id;
	}

	return await ctx.db.insert("data_deletion_requests", {
		userId: args.userId,
		scope: "workspace",
		workspaceId: args.workspaceId,
	});
}
