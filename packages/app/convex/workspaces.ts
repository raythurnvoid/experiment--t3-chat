import { v } from "convex/values";
import { doc } from "convex-helpers/validators";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import type { Id } from "./_generated/dataModel";
import { server_convex_get_user_fallback_to_anonymous, should_never_happen } from "../server/server-utils.ts";
import { Result } from "../shared/errors-as-values-utils.ts";
import { v_result } from "../server/convex-utils.ts";
import app_convex_schema from "./schema.ts";
import { workspaces_db_create, workspaces_validate_name } from "../server/workspaces.ts";

/**
 * TODO: to be implemented
 */
async function user_is_workspace_admin(ctx: MutationCtx, args: { workspaceId: Id<"workspaces">; userId: Id<"users"> }) {
	return true;
}

/**
 * TODO: to be implemented
 */
async function user_is_project_admin(
	ctx: MutationCtx,
	args: { projectId: Id<"workspaces_projects">; userId: Id<"users"> },
) {
	return true;
}

export const list = query({
	args: {},
	returns: v.object({
		workspaces: v.array(doc(app_convex_schema, "workspaces")),
		workspaceIdsProjectsDict: v.record(v.id("workspaces"), v.array(doc(app_convex_schema, "workspaces_projects"))),
	}),
	handler: async (ctx) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);
		const memberships = await ctx.db
			.query("workspaces_projects_users")
			.withIndex("by_userId_workspaceId_projectId", (q) => q.eq("userId", user.id))
			.collect();

		const projectIdsByWorkspace = new Map<Id<"workspaces">, Set<Id<"workspaces_projects">>>();
		for (const membership of memberships) {
			let projectIds = projectIdsByWorkspace.get(membership.workspaceId);
			if (!projectIds) {
				projectIds = new Set();
				projectIdsByWorkspace.set(membership.workspaceId, projectIds);
			}
			projectIds.add(membership.projectId);
		}

		const [workspaceIds, workspaces] = await Promise.try(async () => {
			const workspaceIds = [];
			const workspacesPromises = [];

			for (const workspaceId of projectIdsByWorkspace.keys()) {
				workspaceIds.push(workspaceId);
				workspacesPromises.push(ctx.db.get("workspaces", workspaceId));
			}

			const workspaces = [];
			for (const workspacePromise of workspacesPromises) {
				const workspace = await workspacePromise;

				if (workspace) {
					workspaces.push(workspace);
				}
			}

			return [workspaceIds, workspaces] as const;
		});

		const workspaceIdsProjectsDict = Object.fromEntries(
			await Promise.all(
				workspaceIds.map(async (workspaceId) => {
					const projectIds = projectIdsByWorkspace.get(workspaceId);

					if (!projectIds) {
						throw should_never_happen("Project ids not found for workspace", { workspaceId });
					}

					const projectsPromises = [];
					for (const projectId of projectIds) {
						projectsPromises.push(ctx.db.get("workspaces_projects", projectId));
					}

					const projects = [];
					for (const projectPromise of projectsPromises) {
						const project = await projectPromise;
						if (project !== null) {
							projects.push(project);
						}
					}

					return [workspaceId, projects] as const;
				}),
			),
		);

		return { workspaces, workspaceIdsProjectsDict };
	},
});

export const get_membership_for_scope = query({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
	},
	returns: v.union(doc(app_convex_schema, "workspaces_projects_users"), v.null()),
	handler: async (ctx, args) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);
		const workspaceId = ctx.db.normalizeId("workspaces", args.workspaceId);
		const projectId = ctx.db.normalizeId("workspaces_projects", args.projectId);
		if (!workspaceId || !projectId) {
			return null;
		}

		const membership = await ctx.db
			.query("workspaces_projects_users")
			.withIndex("by_userId_workspaceId_projectId", (q) =>
				q.eq("userId", user.id).eq("workspaceId", workspaceId).eq("projectId", projectId),
			)
			.first();

		return membership;
	},
});

export const get_membership_by_workspace_project_name = query({
	args: {
		workspaceName: v.string(),
		projectName: v.string(),
	},
	returns: v.union(doc(app_convex_schema, "workspaces_projects_users"), v.null()),
	handler: async (ctx, args) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx).then((user) => ctx.db.get("users", user.id));
		if (!user) {
			return null;
		}

		const workspaceNameResult = workspaces_validate_name(args.workspaceName);
		if (workspaceNameResult._nay) {
			return null;
		}

		const projectNameResult = workspaces_validate_name(args.projectName);
		if (projectNameResult._nay) {
			return null;
		}

		const memberships = await ctx.db
			.query("workspaces_projects_users")
			.withIndex("by_userId_workspaceId_projectId", (q) => q.eq("userId", user._id))
			.collect();

		const candidateMembershipsPromises = [];
		for (const membership of memberships) {
			candidateMembershipsPromises.push(
				Promise.all([
					ctx.db.get("workspaces", membership.workspaceId),
					ctx.db.get("workspaces_projects", membership.projectId),
				]).then(([workspace, project]) => {
					if (!workspace || !project) {
						return;
					}

					if (project.workspaceId !== membership.workspaceId) {
						return;
					}

					if (workspace.name !== workspaceNameResult._yay || project.name !== projectNameResult._yay) {
						return;
					}

					return membership;
				}),
			);
		}

		let foundMembership = null;
		for (const candidateMembershipsPromise of candidateMembershipsPromises) {
			const candidateMembership = await candidateMembershipsPromise;
			if (candidateMembership) {
				foundMembership = candidateMembership;
				break;
			}
		}

		if (!foundMembership) {
			return null;
		}

		return foundMembership;
	},
});

async function db_get_membership(
	ctx: QueryCtx,
	args: { membershipId: Id<"workspaces_projects_users">; userId: Id<"users"> },
) {
	const membership = await ctx.db.get("workspaces_projects_users", args.membershipId);
	if (!membership || membership.userId !== args.userId) {
		return null;
	}
	return membership;
}

/**
 * Get the membership doc.
 *
 * Useful to check user access to resources.
 */
export const get_membership = query({
	args: {
		membershipId: v.id("workspaces_projects_users"),
	},
	returns: v.union(doc(app_convex_schema, "workspaces_projects_users"), v.null()),
	handler: async (ctx, args) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);
		return await db_get_membership(ctx, { membershipId: args.membershipId, userId: user.id });
	},
});

export const get_membership_from_string = query({
	args: {
		membershipId: v.string(),
	},
	returns: v.union(doc(app_convex_schema, "workspaces_projects_users"), v.null()),
	handler: async (ctx, args) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);

		const membershipId = ctx.db.normalizeId("workspaces_projects_users", args.membershipId.trim());
		if (!membershipId) {
			return null;
		}

		return await db_get_membership(ctx, { membershipId, userId: user.id });
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
				.then((projects) => {
					const promises = [];
					for (const project of projects) {
						promises.push(
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
						);
					}
					return Promise.all(promises);
				}),

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
				.then((projectUsers) =>
					Promise.all(projectUsers.map((projectUser) => ctx.db.delete("workspaces_projects_users", projectUser._id))),
				),

			ctx.db.delete("workspaces_projects", project._id),
		]);

		return Result({
			_yay: null,
		});
	},
});
