import { v } from "convex/values";
import { doc } from "convex-helpers/validators";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import type { Id } from "./_generated/dataModel";
import { server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";
import { Result } from "../shared/errors-as-values-utils.ts";
import { v_result } from "../server/convex-utils.ts";
import app_convex_schema from "./schema.ts";
import { workspaces_db_create } from "../server/workspaces.ts";

type DbCtx = Pick<QueryCtx | MutationCtx, "db">;

async function get_default_project_for_workspace(ctx: DbCtx, workspaceId: Id<"workspaces">) {
	const workspace = await ctx.db.get("workspaces", workspaceId);
	if (!workspace) {
		return null;
	}

	if (workspace.defaultProjectId) {
		const project = await ctx.db.get("workspaces_projects", workspace.defaultProjectId);
		if (project && project.workspaceId === workspaceId) {
			return project;
		}
	}

	return await ctx.db
		.query("workspaces_projects")
		.withIndex("by_workspaceId_default", (q) => q.eq("workspaceId", workspaceId).eq("default", true))
		.first();
}

/**
 * TODO: to be implemented
 */
async function user_is_workspace_admin(ctx: DbCtx, args: { workspaceId: Id<"workspaces">; userId: Id<"users"> }) {
	return true;
}

/**
 * TODO: to be implemented
 */
async function user_is_project_admin(ctx: DbCtx, args: { projectId: Id<"workspaces_projects">; userId: Id<"users"> }) {
	return true;
}

export const get_default_project = query({
	args: {
		workspaceId: v.id("workspaces"),
	},
	returns: v.union(doc(app_convex_schema, "workspaces_projects"), v.null()),
	handler: async (ctx, args) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);

		const workspace = await ctx.db.get("workspaces", args.workspaceId);
		if (!workspace) {
			return null;
		}

		const project = await get_default_project_for_workspace(ctx, workspace._id);
		if (!project) {
			return null;
		}

		return (await user_is_workspace_admin(ctx, {
			workspaceId: workspace._id,
			userId: user.id,
		}))
			? project
			: null;
	},
});

export const create_workspace = mutation({
	args: {
		name: v.string(),
	},
	returns: v_result({
		_yay: v.object({
			workspaceId: v.id("workspaces"),
			defaultProjectId: v.id("workspaces_projects"),
		}),
	}),
	handler: async (ctx, args) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);

		const now = Date.now();

		return await workspaces_db_create(ctx, {
			userId: user.id,
			name: args.name,
			now,
		});
	},
});

export const add_user_to_workspace_project = mutation({
	args: {
		workspaceId: v.id("workspaces"),
		projectId: v.id("workspaces_projects"),
		userIdToAdd: v.id("users"),
	},
	returns: v_result({
		_yay: v.null(),
	}),
	handler: async (ctx, args) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);

		const [userToAdd, workspace, project, projectCurrentUserLookup, projectUserToAddLookup] = await Promise.all([
			ctx.db.get("users", args.userIdToAdd),
			ctx.db.get("workspaces", args.workspaceId),
			ctx.db.get("workspaces_projects", args.projectId),
			ctx.db
				.query("workspaces_projects_users")
				.withIndex("by_projectId_userId", (q) => q.eq("projectId", args.projectId).eq("userId", user.id))
				.first(),
			ctx.db
				.query("workspaces_projects_users")
				.withIndex("by_projectId_userId", (q) => q.eq("projectId", args.projectId).eq("userId", args.userIdToAdd))
				.first(),
		]);

		if (!userToAdd) {
			return Result({
				_nay: {
					message: "User to add not found",
				},
			});
		}

		if (!workspace || !project || !projectCurrentUserLookup || project.workspaceId !== args.workspaceId) {
			return Result({
				_nay: {
					message: "Project not found",
				},
			});
		}

		if (workspace.default) {
			return Result({
				_nay: {
					message: "Cannot add user to default workspace",
				},
			});
		}

		if (projectUserToAddLookup) {
			return Result({
				_nay: {
					message: "User already a member of the project",
				},
			});
		}

		const invitedUser = await ctx.db.get("users", args.userIdToAdd);
		if (!invitedUser) {
			return Result({
				_nay: {
					message: "User not found",
				},
			});
		}

		if (!(await user_is_workspace_admin(ctx, { workspaceId: workspace._id, userId: user.id }))) {
			return Result({
				_nay: {
					message: "Permission denied",
				},
			});
		}

		await ctx.db.insert("workspaces_projects_users", {
			workspaceId: workspace._id,
			projectId: project._id,
			userId: args.userIdToAdd,
		});

		return Result({
			_yay: null,
		});
	},
});

export const delete_workspace = mutation({
	args: {
		workspaceId: v.id("workspaces"),
	},
	returns: v_result({
		_yay: v.null(),
	}),
	handler: async (ctx, args) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);

		const [workspace, worspaceUserLookup] = await Promise.all([
			ctx.db.get("workspaces", args.workspaceId),
			ctx.db
				.query("workspaces_projects")
				.withIndex("by_workspaceId_default", (q) => q.eq("workspaceId", args.workspaceId))
				.first()
				.then(async (project) =>
					project
						? await ctx.db
								.query("workspaces_projects_users")
								.withIndex("by_projectId_userId", (q) => q.eq("projectId", project._id).eq("userId", user.id))
								.first()
						: null,
				),
		]);

		if (!workspace || !worspaceUserLookup) {
			return Result({
				_nay: {
					message: "Workspace not found",
				},
			});
		}

		if (workspace.default) {
			return Result({
				_nay: {
					message: "Cannot delete the default workspace",
				},
			});
		}

		if (!(await user_is_workspace_admin(ctx, { workspaceId: workspace._id, userId: user.id }))) {
			return Result({
				_nay: {
					message: "Permission denied",
				},
			});
		}

		await Promise.all([
			ctx.db
				.query("workspaces_projects")
				.withIndex("by_workspaceId_default", (q) => q.eq("workspaceId", workspace._id))
				.collect()
				.then((projects) =>
					Promise.all(
						projects.map((project) =>
							Promise.all([
								ctx.db
									.query("workspaces_projects_users")
									.withIndex("by_projectId_userId", (q) => q.eq("projectId", project._id))
									.collect()
									.then((projectUsers) =>
										Promise.all(
											projectUsers.map((projectUser) => ctx.db.delete("workspaces_projects_users", projectUser._id)),
										),
									),

								ctx.db.delete("workspaces_projects", project._id),
							]),
						),
					),
				),

			ctx.db.delete("workspaces", workspace._id),
		]);

		return Result({
			_yay: null,
		});
	},
});

export const delete_project = mutation({
	args: {
		projectId: v.id("workspaces_projects"),
	},
	returns: v_result({
		_yay: v.null(),
	}),
	handler: async (ctx, args) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);

		const [[project, workspace, workspaceUserLookup], projectUserLookup] = await Promise.all([
			ctx.db.get("workspaces_projects", args.projectId).then(
				async (project) =>
					[
						project,
						...(await Promise.try(async () => {
							if (!project) return [null, null] as const;

							const workspace = await ctx.db.get("workspaces", project.workspaceId);
							const defaultProjectId = workspace?.defaultProjectId;

							return [
								workspace,

								defaultProjectId
									? await ctx.db
											.query("workspaces_projects_users")
											.withIndex("by_projectId_userId", (q) =>
												q.eq("projectId", defaultProjectId).eq("userId", user.id),
											)
											.first()
									: null,
							] as const;
						})),
					] as const,
			),
			ctx.db
				.query("workspaces_projects_users")
				.withIndex("by_projectId_userId", (q) => q.eq("projectId", args.projectId))
				.collect(),
		]);

		if (!project || !workspace || !workspaceUserLookup || !projectUserLookup) {
			return Result({
				_nay: {
					message: "Project not found",
				},
			});
		}

		if (project.default) {
			return Result({
				_nay: {
					message: "Cannot delete the default project",
				},
			});
		}

		if (
			!(await user_is_project_admin(ctx, { projectId: project._id, userId: user.id })) &&
			!(await user_is_workspace_admin(ctx, { workspaceId: workspace._id, userId: user.id }))
		) {
			return Result({
				_nay: {
					message: "Permission denied",
				},
			});
		}

		await Promise.all([
			ctx.db
				.query("workspaces_projects_users")
				.withIndex("by_projectId_userId", (q) => q.eq("projectId", project._id))
				.collect()
				.then(async (projectUsers) =>
					Promise.all(projectUsers.map((projectUser) => ctx.db.delete("workspaces_projects_users", projectUser._id))),
				),

			ctx.db.delete("workspaces_projects", project._id),
		]);

		return Result({
			_yay: null,
		});
	},
});
