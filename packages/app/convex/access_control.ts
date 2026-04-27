import { v } from "convex/values";
import { doc } from "convex-helpers/validators";

import type { Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import {
	type access_control_Permission,
	type access_control_ResourceKind,
	type access_control_Role,
} from "../shared/access-control.ts";
import { Result } from "../shared/errors-as-values-utils.ts";
import { quotas_db_get } from "./quotas.ts";
import { v_result } from "../server/convex-utils.ts";
import { server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";
import app_convex_schema from "./schema.ts";

export async function access_control_db_ensure_role_assignment(
	ctx: MutationCtx,
	args: {
		workspaceId: Id<"workspaces">;
		projectId: Id<"workspaces_projects">;
		userId: Id<"users">;
		role: access_control_Role;
		now: number;
	},
) {
	const existing = await ctx.db
		.query("access_control_role_assignments")
		.withIndex("by_workspace_project_user_role", (q) =>
			q
				.eq("workspaceId", args.workspaceId)
				.eq("projectId", args.projectId)
				.eq("userId", args.userId)
				.eq("role", args.role),
		)
		.first();

	if (existing) {
		return existing._id;
	}

	return await ctx.db.insert("access_control_role_assignments", {
		workspaceId: args.workspaceId,
		projectId: args.projectId,
		userId: args.userId,
		role: args.role,
		createdAt: args.now,
		updatedAt: args.now,
	});
}

export async function access_control_db_ensure_role_permission_grant(
	ctx: MutationCtx,
	args: {
		workspaceId: Id<"workspaces">;
		projectId: Id<"workspaces_projects">;
		resourceKind: access_control_ResourceKind;
		resourceId: string;
		role: access_control_Role;
		permission: access_control_Permission;
		now: number;
	},
) {
	// Callers must load the protected resource first and derive this scope from it.
	const existing = await ctx.db
		.query("access_control_permission_grants")
		.withIndex("by_workspace_project_resource_role_permission", (q) =>
			q
				.eq("workspaceId", args.workspaceId)
				.eq("projectId", args.projectId)
				.eq("resourceKind", args.resourceKind)
				.eq("resourceId", args.resourceId)
				.eq("principalKind", "role")
				.eq("role", args.role)
				.eq("permission", args.permission),
		)
		.first();
	if (existing) {
		return existing._id;
	}

	return await ctx.db.insert("access_control_permission_grants", {
		workspaceId: args.workspaceId,
		projectId: args.projectId,
		resourceKind: args.resourceKind,
		resourceId: args.resourceId,
		principalKind: "role",
		role: args.role,
		permission: args.permission,
		createdAt: args.now,
		updatedAt: args.now,
	});
}

export async function access_control_db_ensure_user_permission_grant(
	ctx: MutationCtx,
	args: {
		workspaceId: Id<"workspaces">;
		projectId: Id<"workspaces_projects">;
		resourceKind: access_control_ResourceKind;
		resourceId: string;
		userId: Id<"users">;
		permission: access_control_Permission;
		now: number;
	},
) {
	// Callers must load the protected resource first and derive this scope from it.
	const existing = await ctx.db
		.query("access_control_permission_grants")
		.withIndex("by_workspace_project_resource_user_permission", (q) =>
			q
				.eq("workspaceId", args.workspaceId)
				.eq("projectId", args.projectId)
				.eq("resourceKind", args.resourceKind)
				.eq("resourceId", args.resourceId)
				.eq("principalKind", "user")
				.eq("userId", args.userId)
				.eq("permission", args.permission),
		)
		.first();
	if (existing) {
		return existing._id;
	}

	return await ctx.db.insert("access_control_permission_grants", {
		workspaceId: args.workspaceId,
		projectId: args.projectId,
		resourceKind: args.resourceKind,
		resourceId: args.resourceId,
		principalKind: "user",
		userId: args.userId,
		permission: args.permission,
		createdAt: args.now,
		updatedAt: args.now,
	});
}

export async function access_control_db_ensure_public_permission_grant(
	ctx: MutationCtx,
	args: {
		workspaceId: Id<"workspaces">;
		projectId: Id<"workspaces_projects">;
		resourceKind: access_control_ResourceKind;
		resourceId: string;
		permission: access_control_Permission;
		now: number;
	},
) {
	// Callers must load the protected resource first and derive this scope from it.
	const existing = await ctx.db
		.query("access_control_permission_grants")
		.withIndex("by_workspace_project_resource_public_permission", (q) =>
			q
				.eq("workspaceId", args.workspaceId)
				.eq("projectId", args.projectId)
				.eq("resourceKind", args.resourceKind)
				.eq("resourceId", args.resourceId)
				.eq("principalKind", "public")
				.eq("permission", args.permission),
		)
		.first();
	if (existing) {
		return existing._id;
	}

	return await ctx.db.insert("access_control_permission_grants", {
		workspaceId: args.workspaceId,
		projectId: args.projectId,
		resourceKind: args.resourceKind,
		resourceId: args.resourceId,
		principalKind: "public",
		permission: args.permission,
		createdAt: args.now,
		updatedAt: args.now,
	});
}

/**
 * Check permission against an access-control tuple that the caller already proved exists.
 *
 * Callers must load the protected resource, project, or workspace first and pass the
 * derived workspace/project ids plus the workspace default project id. This helper
 * does not fetch the workspace or validate resource scope.
 *
 * Use `workspaceId` and `defaultProjectId` from the workspace.
 *
 * Use `projectId` from the resource/project scope being checked, which may be a
 * non-default project. Use `resourceKind` and `resourceId` from the protected doc;
 * `resourceId` must be `String(doc._id)`.
 *
 * Pass `userId` for authenticated user access checks.
 *
 * Omit `userId` and pass `allowPublic: true` only for public/link
 * access checks that intentionally accept public grants.
 */
export async function access_control_db_has_permission(
	ctx: QueryCtx | MutationCtx,
	args: {
		workspaceId: Id<"workspaces">;
		projectId: Id<"workspaces_projects">;
		defaultProjectId: Id<"workspaces_projects">;
		resourceKind: access_control_ResourceKind;
		resourceId: string;
		permission: access_control_Permission;
		userId?: Id<"users">;
		allowPublic?: boolean;
	},
) {
	const userId = args.userId;

	if (userId) {
		// Check if the user is the owner of the workspace.
		const ownerAssignment = await ctx.db
			.query("access_control_role_assignments")
			.withIndex("by_workspace_project_user_role", (q) =>
				q
					.eq("workspaceId", args.workspaceId)
					.eq("projectId", args.defaultProjectId)
					.eq("userId", userId)
					.eq("role", "owner"),
			)
			.first();
		if (ownerAssignment) {
			return true;
		}

		const directGrant = await ctx.db
			.query("access_control_permission_grants")
			.withIndex("by_workspace_project_resource_user_permission", (q) =>
				q
					.eq("workspaceId", args.workspaceId)
					.eq("projectId", args.projectId)
					.eq("resourceKind", args.resourceKind)
					.eq("resourceId", args.resourceId)
					.eq("principalKind", "user")
					.eq("userId", userId)
					.eq("permission", args.permission),
			)
			.first();
		if (directGrant) {
			return true;
		}
	}

	if (args.allowPublic) {
		const publicGrant = await ctx.db
			.query("access_control_permission_grants")
			.withIndex("by_workspace_project_resource_public_permission", (q) =>
				q
					.eq("workspaceId", args.workspaceId)
					.eq("projectId", args.projectId)
					.eq("resourceKind", args.resourceKind)
					.eq("resourceId", args.resourceId)
					.eq("principalKind", "public")
					.eq("permission", args.permission),
			)
			.first();
		if (publicGrant) {
			return true;
		}
	}

	if (!userId) {
		return false;
	}

	// Use the first role assignment; product flows keep one role per user/project.
	const projectRoleAssignment = await ctx.db
		.query("access_control_role_assignments")
		.withIndex("by_workspace_project_user_role", (q) =>
			q.eq("workspaceId", args.workspaceId).eq("projectId", args.projectId).eq("userId", userId),
		)
		.first();

	if (
		projectRoleAssignment &&
		(await ctx.db
			.query("access_control_permission_grants")
			.withIndex("by_workspace_project_resource_role_permission", (q) =>
				q
					.eq("workspaceId", args.workspaceId)
					.eq("projectId", args.projectId)
					.eq("resourceKind", args.resourceKind)
					.eq("resourceId", args.resourceId)
					.eq("principalKind", "role")
					.eq("role", projectRoleAssignment.role)
					.eq("permission", args.permission),
			)
			.first())
	) {
		return true;
	}

	if (args.projectId === args.defaultProjectId) {
		return false;
	}

	const defaultProjectRoleAssignment = await ctx.db
		.query("access_control_role_assignments")
		.withIndex("by_workspace_project_user_role", (q) =>
			q.eq("workspaceId", args.workspaceId).eq("projectId", args.defaultProjectId).eq("userId", userId),
		)
		.first();

	return Boolean(
		defaultProjectRoleAssignment &&
			(await ctx.db
				.query("access_control_permission_grants")
				.withIndex("by_workspace_project_resource_role_permission", (q) =>
					q
						.eq("workspaceId", args.workspaceId)
						.eq("projectId", args.defaultProjectId)
						.eq("resourceKind", "workspace")
						.eq("resourceId", String(args.workspaceId))
						.eq("principalKind", "role")
						.eq("role", defaultProjectRoleAssignment.role)
						.eq("permission", args.permission),
				)
				.first()),
	);
}

export const get_current_user_role = query({
	args: {
		workspaceId: v.id("workspaces"),
		projectId: v.id("workspaces_projects"),
	},
	returns: v.union(doc(app_convex_schema, "access_control_role_assignments").fields.role, v.null()),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return null;
		}

		const projectAssignment = await ctx.db
			.query("access_control_role_assignments")
			.withIndex("by_workspace_project_user_role", (q) =>
				q.eq("workspaceId", args.workspaceId).eq("projectId", args.projectId).eq("userId", userAuth.id),
			)
			.first();

		return projectAssignment?.role ?? null;
	},
});

export const get_current_user_workspace_permission = query({
	args: {
		workspaceId: v.id("workspaces"),
		permission: doc(app_convex_schema, "access_control_permission_grants").fields.permission,
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return false;
		}

		const workspace = await ctx.db.get("workspaces", args.workspaceId);
		if (!workspace) {
			console.error("Workspace not found", {
				workspaceId: args.workspaceId,
			});
			return false;
		}

		if (!workspace.defaultProjectId) {
			console.error("Workspace default project not found", {
				workspaceId: workspace._id,
			});
			return false;
		}

		const defaultProjectId = workspace.defaultProjectId;

		const [defaultProject, currentHomeMembership] = await Promise.all([
			ctx.db.get("workspaces_projects", defaultProjectId),
			// Keep workspace-level permission UI tied to home membership; direct grants do not make non-members workspace members.
			ctx.db
				.query("workspaces_projects_users")
				.withIndex("by_active_user_workspace_project", (q) =>
					q
						.eq("active", true)
						.eq("userId", userAuth.id)
						.eq("workspaceId", workspace._id)
						.eq("projectId", defaultProjectId),
				)
				.first(),
		]);

		if (!defaultProject) {
			console.error("Default project not found", {
				workspaceId: workspace._id,
				defaultProjectId,
			});
			return false;
		}

		if (defaultProject.workspaceId !== workspace._id) {
			console.error("Default project workspace mismatch", {
				workspaceId: workspace._id,
				defaultProjectId,
				defaultProjectWorkspaceId: defaultProject.workspaceId,
			});
			return false;
		}

		if (!currentHomeMembership) {
			return false;
		}

		return await access_control_db_has_permission(ctx, {
			workspaceId: workspace._id,
			projectId: defaultProjectId,
			defaultProjectId,
			resourceKind: "workspace",
			resourceId: String(workspace._id),
			permission: args.permission,
			userId: userAuth.id,
		});
	},
});

/**
 * Return one user's role in one project scope only when the current user can see
 * that project membership. The default/home project acts as the workspace role
 * view; non-default projects show only project-local roles.
 */
export const get_workspace_project_user_role = query({
	args: {
		workspaceId: v.id("workspaces"),
		projectId: v.id("workspaces_projects"),
		userId: v.id("users"),
	},
	returns: v.union(doc(app_convex_schema, "access_control_role_assignments").fields.role, v.null()),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return null;
		}

		const [currentProjectMembership, projectAssignment] = await Promise.all([
			// Check if the current user is part of the requested project.
			ctx.db
				.query("workspaces_projects_users")
				.withIndex("by_active_user_workspace_project", (q) =>
					q
						.eq("active", true)
						.eq("userId", userAuth.id)
						.eq("workspaceId", args.workspaceId)
						.eq("projectId", args.projectId),
				)
				.first(),
			// Read only the target user's role at this exact project scope.
			ctx.db
				.query("access_control_role_assignments")
				.withIndex("by_workspace_project_user_role", (q) =>
					q.eq("workspaceId", args.workspaceId).eq("projectId", args.projectId).eq("userId", args.userId),
				)
				.first(),
		]);

		// Return nothing unless the current user can see the requested project.
		if (!currentProjectMembership) {
			return null;
		}

		return projectAssignment?.role ?? null;
	},
});

export const transfer_workspace_ownership = mutation({
	args: {
		workspaceId: v.id("workspaces"),
		newOwnerUserId: v.id("users"),
	},
	returns: v_result({
		_yay: v.null(),
	}),
	handler: async (ctx, args) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx).then((userAuth) =>
			userAuth ? ctx.db.get("users", userAuth.id) : null,
		);
		if (!user || user.deletedAt != null) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "workspaces_write", key: user._id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const now = Date.now();
		const workspace = await ctx.db.get("workspaces", args.workspaceId);
		if (!workspace) {
			return Result({ _nay: { message: "Workspace not found" } });
		}

		if (workspace.default) {
			return Result({ _nay: { message: "Cannot transfer ownership of the default workspace" } });
		}

		if (user._id === args.newOwnerUserId) {
			return Result({ _nay: { message: "User is already the workspace owner" } });
		}

		const defaultProjectId = workspace.defaultProjectId;
		if (!defaultProjectId) {
			return Result({ _nay: { message: "Workspace default project not found" } });
		}

		const [ownerAssignment, newOwnerUser, newOwnerHomeMembership, currentOwnerQuota, newOwnerQuota] = await Promise.all(
			[
				ctx.db
					.query("access_control_role_assignments")
					.withIndex("by_workspace_project_user_role", (q) =>
						q
							.eq("workspaceId", args.workspaceId)
							.eq("projectId", defaultProjectId)
							.eq("userId", user._id)
							.eq("role", "owner"),
					)
					.first(),
				ctx.db.get("users", args.newOwnerUserId),
				ctx.db
					.query("workspaces_projects_users")
					.withIndex("by_active_user_workspace_project", (q) =>
						q
							.eq("active", true)
							.eq("userId", args.newOwnerUserId)
							.eq("workspaceId", args.workspaceId)
							.eq("projectId", defaultProjectId),
					)
					.first(),
				quotas_db_get(ctx, {
					quotaName: "extra_workspaces",
					userId: user._id,
				}),
				quotas_db_get(ctx, {
					quotaName: "extra_workspaces",
					userId: args.newOwnerUserId,
				}),
			],
		);

		if (!ownerAssignment) {
			return Result({ _nay: { message: "Permission denied" } });
		}

		if (!newOwnerUser || newOwnerUser.deletedAt != null || !newOwnerHomeMembership) {
			return Result({ _nay: { message: "New owner must be an active workspace member" } });
		}

		const newOwnerRemainingCount = Math.max(0, newOwnerQuota.maxCount - newOwnerQuota.usedCount);
		if (newOwnerRemainingCount <= 0) {
			return Result({
				_nay: {
					message: "Workspace quota reached",
				},
			});
		}

		await Promise.all([
			ctx.db.delete("access_control_role_assignments", ownerAssignment._id),
			ctx.db.patch("quotas", currentOwnerQuota._id, {
				usedCount: Math.max(0, currentOwnerQuota.usedCount - 1),
				updatedAt: now,
			}),
			ctx.db.patch("quotas", newOwnerQuota._id, {
				usedCount: newOwnerQuota.usedCount + 1,
				updatedAt: now,
			}),
			access_control_db_ensure_role_assignment(ctx, {
				workspaceId: args.workspaceId,
				projectId: defaultProjectId,
				userId: user._id,
				role: "member",
				now,
			}),
			access_control_db_ensure_role_assignment(ctx, {
				workspaceId: args.workspaceId,
				projectId: defaultProjectId,
				userId: args.newOwnerUserId,
				role: "owner",
				now,
			}),
		]);

		return Result({ _yay: null });
	},
});
