import { v } from "convex/values";
import { doc } from "convex-helpers/validators";

import type { Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import {
	type access_control_Permission,
	type access_control_ResourceKind,
	type access_control_Role,
} from "../shared/access-control.ts";
import { Result } from "common/errors-as-values-utils.ts";
import { quotas_db_get } from "./quotas.ts";
import { v_result } from "../server/convex-utils.ts";
import { server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";
import app_convex_schema from "./schema.ts";
import { should_never_happen } from "../shared/shared-utils.ts";

export const access_control_organization_role_permission_grants = [
	{ role: "admin", permission: "organization.update" },
	{ role: "admin", permission: "organization.members.manage" },
	{ role: "admin", permission: "workspace.create" },
	{ role: "admin", permission: "workspace.update" },
	{ role: "admin", permission: "workspace.delete" },
	{ role: "admin", permission: "workspace.members.manage" },
	{ role: "admin", permission: "asset.read" },
	{ role: "admin", permission: "asset.write" },
	{ role: "admin", permission: "organization.roles.manage" },
	{ role: "admin", permission: "asset.permissions.manage" },
	{ role: "admin", permission: "api.credentials.manage" },
	{ role: "admin", permission: "workspace.plugins.manage" },
	{ role: "member", permission: "organization.update" },
	{ role: "member", permission: "workspace.create" },
	{ role: "member", permission: "workspace.update" },
	{ role: "member", permission: "workspace.delete" },
	{ role: "member", permission: "asset.read" },
	{ role: "member", permission: "asset.write" },
] as const satisfies Array<{ role: access_control_Role; permission: access_control_Permission }>;

export const access_control_workspace_role_permission_grants = [
	{ role: "admin", permission: "workspace.update" },
	{ role: "admin", permission: "workspace.delete" },
	{ role: "admin", permission: "workspace.members.manage" },
	{ role: "admin", permission: "asset.read" },
	{ role: "admin", permission: "asset.write" },
	{ role: "admin", permission: "asset.permissions.manage" },
	{ role: "admin", permission: "api.credentials.manage" },
	{ role: "admin", permission: "workspace.plugins.manage" },
	{ role: "member", permission: "workspace.update" },
	{ role: "member", permission: "workspace.delete" },
	{ role: "member", permission: "asset.read" },
	{ role: "member", permission: "asset.write" },
] as const satisfies Array<{ role: access_control_Role; permission: access_control_Permission }>;

export async function access_control_db_ensure_role_assignment(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
		role: access_control_Role;
		now: number;
	},
) {
	const existing = await ctx.db
		.query("access_control_role_assignments")
		.withIndex("by_organization_workspace_user_role", (q) =>
			q
				.eq("organizationId", args.organizationId)
				.eq("workspaceId", args.workspaceId)
				.eq("userId", args.userId)
				.eq("role", args.role),
		)
		.first();

	if (existing) {
		return existing._id;
	}

	return await ctx.db.insert("access_control_role_assignments", {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		userId: args.userId,
		role: args.role,
		createdAt: args.now,
		updatedAt: args.now,
	});
}

export async function access_control_db_ensure_role_permission_grant(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
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
		.withIndex("by_organization_workspace_resource_role_permission", (q) =>
			q
				.eq("organizationId", args.organizationId)
				.eq("workspaceId", args.workspaceId)
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
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
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
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
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
		.withIndex("by_organization_workspace_resource_user_permission", (q) =>
			q
				.eq("organizationId", args.organizationId)
				.eq("workspaceId", args.workspaceId)
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
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
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
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		resourceKind: access_control_ResourceKind;
		resourceId: string;
		permission: access_control_Permission;
		now: number;
	},
) {
	// Callers must load the protected resource first and derive this scope from it.
	const existing = await ctx.db
		.query("access_control_permission_grants")
		.withIndex("by_organization_workspace_resource_public_permission", (q) =>
			q
				.eq("organizationId", args.organizationId)
				.eq("workspaceId", args.workspaceId)
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
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
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
 * Callers must load the protected resource, workspace, or organization first and pass the
 * derived organization/workspace ids plus the organization default workspace id. This helper
 * does not fetch the organization or validate resource scope.
 *
 * Use `organizationId`, `defaultWorkspaceId`, and `ownerUserId` from the organization.
 *
 * Use `workspaceId` from the resource/workspace scope being checked, which may be a
 * non-default workspace. Use `resourceKind` and `resourceId` from the protected doc;
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
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		defaultWorkspaceId: Id<"organizations_workspaces">;
		organizationOwnerUserId: Id<"users">;
		resourceKind: access_control_ResourceKind;
		resourceId: string;
		permission: access_control_Permission;
		userId?: Id<"users">;
		allowPublic?: boolean;
	},
) {
	const userId = args.userId;

	if (userId) {
		// Keep organization ownership sourced from `organizations.ownerUserId`; role docs are only the ACL mirror.
		if (userId === args.organizationOwnerUserId) {
			return true;
		}

		const directGrant = await ctx.db
			.query("access_control_permission_grants")
			.withIndex("by_organization_workspace_resource_user_permission", (q) =>
				q
					.eq("organizationId", args.organizationId)
					.eq("workspaceId", args.workspaceId)
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
			.withIndex("by_organization_workspace_resource_public_permission", (q) =>
				q
					.eq("organizationId", args.organizationId)
					.eq("workspaceId", args.workspaceId)
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

	// Use the first role assignment; product flows keep one role per user/workspace.
	const workspaceRoleAssignment = await ctx.db
		.query("access_control_role_assignments")
		.withIndex("by_organization_workspace_user_role", (q) =>
			q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("userId", userId),
		)
		.first();

	if (
		workspaceRoleAssignment &&
		(await ctx.db
			.query("access_control_permission_grants")
			.withIndex("by_organization_workspace_resource_role_permission", (q) =>
				q
					.eq("organizationId", args.organizationId)
					.eq("workspaceId", args.workspaceId)
					.eq("resourceKind", args.resourceKind)
					.eq("resourceId", args.resourceId)
					.eq("principalKind", "role")
					.eq("role", workspaceRoleAssignment.role)
					.eq("permission", args.permission),
			)
			.first())
	) {
		return true;
	}

	if (args.workspaceId === args.defaultWorkspaceId) {
		return false;
	}

	const defaultWorkspaceRoleAssignment = await ctx.db
		.query("access_control_role_assignments")
		.withIndex("by_organization_workspace_user_role", (q) =>
			q.eq("organizationId", args.organizationId).eq("workspaceId", args.defaultWorkspaceId).eq("userId", userId),
		)
		.first();

	return Boolean(
		defaultWorkspaceRoleAssignment &&
			(await ctx.db
				.query("access_control_permission_grants")
				.withIndex("by_organization_workspace_resource_role_permission", (q) =>
					q
						.eq("organizationId", args.organizationId)
						.eq("workspaceId", args.defaultWorkspaceId)
						.eq("resourceKind", "organization")
						.eq("resourceId", String(args.organizationId))
						.eq("principalKind", "role")
						.eq("role", defaultWorkspaceRoleAssignment.role)
						.eq("permission", args.permission),
				)
				.first()),
	);
}

export const get_current_user_role = query({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
	},
	returns: v.union(doc(app_convex_schema, "access_control_role_assignments").fields.role, v.null()),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return null;
		}

		const workspaceAssignment = await ctx.db
			.query("access_control_role_assignments")
			.withIndex("by_organization_workspace_user_role", (q) =>
				q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("userId", userAuth.id),
			)
			.first();

		return workspaceAssignment?.role ?? null;
	},
});

export const get_current_user_organization_permission = query({
	args: {
		organizationId: v.id("organizations"),
		permission: doc(app_convex_schema, "access_control_permission_grants").fields.permission,
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return false;
		}

		const organization = await ctx.db.get("organizations", args.organizationId);
		if (!organization) {
			return false;
		}

		if (!organization.defaultWorkspaceId) {
			console.error("organization.defaultWorkspaceId is not set", {
				organizationId: organization._id,
			});
			return false;
		}

		const defaultWorkspaceId = organization.defaultWorkspaceId;

		const [defaultWorkspace, currentHomeMembership] = await Promise.all([
			ctx.db.get("organizations_workspaces", defaultWorkspaceId),
			// Keep organization-level permission UI tied to home membership; direct grants do not make non-members organization members.
			ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_active_user_organization_workspace", (q) =>
					q
						.eq("active", true)
						.eq("userId", userAuth.id)
						.eq("organizationId", organization._id)
						.eq("workspaceId", defaultWorkspaceId),
				)
				.first(),
		]);

		if (!defaultWorkspace) {
			console.error("organization.defaultWorkspaceId points to a missing organizations_workspaces doc", {
				organizationId: organization._id,
				defaultWorkspaceId,
			});
			return false;
		}

		if (defaultWorkspace.organizationId !== organization._id) {
			console.error("Default workspace organization mismatch", {
				organizationId: organization._id,
				defaultWorkspaceId,
				defaultWorkspaceOrganizationId: defaultWorkspace.organizationId,
			});
			return false;
		}

		if (!currentHomeMembership) {
			return false;
		}

		return await access_control_db_has_permission(ctx, {
			organizationId: organization._id,
			workspaceId: defaultWorkspaceId,
			defaultWorkspaceId,
			organizationOwnerUserId: organization.ownerUserId,
			resourceKind: "organization",
			resourceId: String(organization._id),
			permission: args.permission,
			userId: userAuth.id,
		});
	},
});

/**
 * Return one user's role in one workspace scope only when the current user can see
 * that workspace membership. The default/home workspace acts as the organization role
 * view; non-default workspaces show only workspace-local roles.
 */
export const get_organization_workspace_user_role = query({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
	},
	returns: v.union(doc(app_convex_schema, "access_control_role_assignments").fields.role, v.null()),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return null;
		}

		const [currentWorkspaceMembership, workspaceAssignment] = await Promise.all([
			// Check if the current user is part of the requested workspace.
			ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_active_user_organization_workspace", (q) =>
					q
						.eq("active", true)
						.eq("userId", userAuth.id)
						.eq("organizationId", args.organizationId)
						.eq("workspaceId", args.workspaceId),
				)
				.first(),
			// Read only the target user's role at this exact workspace scope.
			ctx.db
				.query("access_control_role_assignments")
				.withIndex("by_organization_workspace_user_role", (q) =>
					q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("userId", args.userId),
				)
				.first(),
		]);

		// Return nothing unless the current user can see the requested workspace.
		if (!currentWorkspaceMembership) {
			return null;
		}

		return workspaceAssignment?.role ?? null;
	},
});

export const transfer_organization_ownership = mutation({
	args: {
		organizationId: v.id("organizations"),
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

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "organizations_write", key: user._id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const now = Date.now();
		const organization = await ctx.db.get("organizations", args.organizationId);
		if (!organization) {
			return Result({ _nay: { message: "Not found" } });
		}

		if (organization.default) {
			return Result({ _nay: { message: "Cannot transfer ownership of the default organization" } });
		}

		if (organization.ownerUserId !== user._id) {
			return Result({ _nay: { message: "Permission denied" } });
		}

		if (organization.ownerUserId === args.newOwnerUserId) {
			return Result({ _nay: { message: "User is already the organization owner" } });
		}

		const defaultWorkspaceId = organization.defaultWorkspaceId;
		if (!defaultWorkspaceId) {
			const errorMessage = "organization.defaultWorkspaceId is not set";
			const errorData = {
				organizationId: organization._id,
			};
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}

		const [
			ownerAssignments,
			newOwnerAssignments,
			newOwnerUser,
			newOwnerHomeMembership,
			currentOwnerQuota,
			newOwnerQuota,
		] =
			await Promise.all([
				ctx.db
					.query("access_control_role_assignments")
					.withIndex("by_organization_workspace_role_user", (q) =>
						q.eq("organizationId", args.organizationId).eq("workspaceId", defaultWorkspaceId).eq("role", "owner"),
					)
					.collect(),
				ctx.db
					.query("access_control_role_assignments")
					.withIndex("by_organization_workspace_user_role", (q) =>
						q
							.eq("organizationId", args.organizationId)
							.eq("workspaceId", defaultWorkspaceId)
							.eq("userId", args.newOwnerUserId),
					)
					.collect(),
				ctx.db.get("users", args.newOwnerUserId),
				ctx.db
					.query("organizations_workspaces_users")
					.withIndex("by_active_user_organization_workspace", (q) =>
						q
							.eq("active", true)
							.eq("userId", args.newOwnerUserId)
							.eq("organizationId", args.organizationId)
							.eq("workspaceId", defaultWorkspaceId),
					)
					.first(),
				quotas_db_get(ctx, {
					quotaName: "extra_organizations",
					userId: user._id,
				}),
				quotas_db_get(ctx, {
					quotaName: "extra_organizations",
					userId: args.newOwnerUserId,
				}),
			]);

		if (!newOwnerUser || newOwnerUser.deletedAt != null || !newOwnerHomeMembership) {
			return Result({ _nay: { message: "New owner must be an active organization member" } });
		}

		const newOwnerRemainingCount = Math.max(0, newOwnerQuota.maxCount - newOwnerQuota.usedCount);
		if (newOwnerRemainingCount <= 0) {
			return Result({
				_nay: {
					message: "Organization quota reached",
				},
			});
		}

		// Replace the invited member's current default-workspace role. One user must
		// have only one role at this scope after becoming the organization owner.
		await Promise.all([
			...ownerAssignments.map((assignment) => ctx.db.delete("access_control_role_assignments", assignment._id)),
			...newOwnerAssignments.map((assignment) => ctx.db.delete("access_control_role_assignments", assignment._id)),
		]);

		await Promise.all([
			ctx.db.patch("organizations", organization._id, {
				ownerUserId: args.newOwnerUserId,
				updatedAt: now,
			}),
			ctx.db.patch("quotas", currentOwnerQuota._id, {
				usedCount: Math.max(0, currentOwnerQuota.usedCount - 1),
				updatedAt: now,
			}),
			ctx.db.patch("quotas", newOwnerQuota._id, {
				usedCount: newOwnerQuota.usedCount + 1,
				updatedAt: now,
			}),
			access_control_db_ensure_role_assignment(ctx, {
				organizationId: args.organizationId,
				workspaceId: defaultWorkspaceId,
				userId: user._id,
				role: "member",
				now,
			}),
			access_control_db_ensure_role_assignment(ctx, {
				organizationId: args.organizationId,
				workspaceId: defaultWorkspaceId,
				userId: args.newOwnerUserId,
				role: "owner",
				now,
			}),
		]);

		return Result({ _yay: null });
	},
});
