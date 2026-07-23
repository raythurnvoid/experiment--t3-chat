import { v } from "convex/values";
import { doc } from "convex-helpers/validators";
import { internal } from "./_generated/api.js";
import { internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import type { Id } from "./_generated/dataModel";
import { server_convex_get_user_fallback_to_anonymous, should_never_happen } from "../server/server-utils.ts";
import { convex_error, v_result } from "../server/convex-utils.ts";
import { Result } from "common/errors-as-values-utils.ts";
import { quotas_db_ensure, quotas_db_get } from "./quotas.ts";
import {
	organizations_DEFAULT_WORKSPACE_NAME,
	organizations_DEFAULT_ORGANIZATION_NAME,
	organizations_description_normalize,
	organizations_list_sort_workspaces_for_organization,
	organizations_list_sort_organizations,
	organizations_name_autofix_and_validate,
} from "../shared/organizations.ts";
import app_convex_schema from "./schema.ts";
import {
	access_control_workspace_role_permission_grants,
	access_control_db_ensure_role_assignment,
	access_control_db_ensure_role_permission_grant,
	access_control_db_has_permission,
	access_control_organization_role_permission_grants,
} from "./access_control.ts";
import { data_deletion_db_request } from "./data_deletion.ts";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";

// Make Convex reuse the loaded module between calls, so warm calls skip the module load cost.
// Does NOT work for http actions (see http.ts). No mutable module-level state allowed here.
export const experimental_reuseContext = true;

/**
 * Autofix then validate an organization or workspace name.
 *
 * @returns A result containing the normalized name if valid, or an error message if invalid.
 */
function organizations_validate_name(name: string) {
	return organizations_name_autofix_and_validate(name);
}

function organizations_validate_description(raw: string) {
	return organizations_description_normalize(raw);
}

/**
 * Get a membership doc by id and verify it belongs to the given user.
 */
export async function organizations_db_get_membership(
	ctx: QueryCtx | MutationCtx,
	args: { userId: Id<"users">; membershipId: Id<"organizations_workspaces_users"> },
) {
	const membership = await ctx.db.get("organizations_workspaces_users", args.membershipId);
	if (!membership || membership.userId !== args.userId || membership.active === false) {
		return null;
	}
	return membership;
}

export async function organizations_db_create(
	ctx: MutationCtx,
	args: { userId: Id<"users">; name: string; description: string; now: number; default?: boolean },
) {
	const nameResult = organizations_validate_name(args.name);
	if (nameResult._nay) {
		return Result({
			_nay: {
				message: nameResult._nay.message,
			},
		});
	}
	const name = nameResult._yay;

	const isDefault = Boolean(args.default) && name === organizations_DEFAULT_ORGANIZATION_NAME;

	// Allow only default organizations to reuse their global name; user-created organizations stay globally unique.
	const existingOrganization = isDefault
		? null
		: await ctx.db
				.query("organizations")
				.withIndex("by_name", (q) => q.eq("name", name))
				.first();
	if (existingOrganization) {
		return Result({
			_nay: {
				message: "Organization name already exists",
			},
		});
	}

	if (!args.default) {
		// Non-default organization ownership consumes the creator's organization quota.
		const quota = await quotas_db_get(ctx, {
			quotaName: "extra_organizations",
			userId: args.userId,
		});
		const remainingCount = Math.max(0, quota.maxCount - quota.usedCount);
		if (remainingCount <= 0) {
			return Result({
				_nay: {
					message: "Organization quota reached",
				},
			});
		}

		await ctx.db.patch("quotas", quota._id, {
			usedCount: quota.usedCount + 1,
			updatedAt: args.now,
		});
	}

	const organizationId = await ctx.db.insert("organizations", {
		name,
		description: args.description,
		default: args.default ?? false,
		billingMode: "user",
		ownerUserId: args.userId,
		updatedAt: args.now,
	});

	const defaultWorkspaceId = await ctx.db.insert("organizations_workspaces", {
		organizationId,
		name: organizations_DEFAULT_WORKSPACE_NAME,
		description: "",
		default: true,
		updatedAt: args.now,
	});

	const updates = [
		ctx.db.patch("organizations", organizationId, {
			defaultWorkspaceId,
		}),

		quotas_db_ensure(ctx, {
			quotaName: "extra_workspaces",
			organizationId,
			now: args.now,
		}),

		quotas_db_ensure(ctx, {
			quotaName: "active_api_credentials",
			userId: args.userId,
			organizationId,
			workspaceId: defaultWorkspaceId,
			now: args.now,
		}),

		ctx.db.insert("organizations_workspaces_users", {
			organizationId: organizationId,
			workspaceId: defaultWorkspaceId,
			userId: args.userId,
			active: true,
			updatedAt: args.now,
		}),

		access_control_db_ensure_role_assignment(ctx, {
			organizationId,
			workspaceId: defaultWorkspaceId,
			userId: args.userId,
			role: "owner",
			now: args.now,
		}),
	];

	if (args.default) {
		updates.push(
			ctx.db.patch("users", args.userId, {
				defaultOrganizationId: organizationId,
				defaultWorkspaceId,
			}),
		);
	}

	await Promise.all(updates);

	for (const grant of access_control_organization_role_permission_grants) {
		await access_control_db_ensure_role_permission_grant(ctx, {
			organizationId,
			workspaceId: defaultWorkspaceId,
			resourceKind: "organization",
			resourceId: String(organizationId),
			role: grant.role,
			permission: grant.permission,
			now: args.now,
		});
	}

	for (const grant of access_control_workspace_role_permission_grants) {
		await access_control_db_ensure_role_permission_grant(ctx, {
			organizationId,
			workspaceId: defaultWorkspaceId,
			resourceKind: "workspace",
			resourceId: String(defaultWorkspaceId),
			role: grant.role,
			permission: grant.permission,
			now: args.now,
		});
	}

	// Seeding the README needs an action (R2 writes), so it runs right after this mutation.
	await ctx.scheduler.runAfter(0, internal.files_nodes.create_home_file, {
		organizationId,
		workspaceId: defaultWorkspaceId,
		userId: args.userId,
	});

	return Result({
		_yay: {
			organizationId,
			defaultWorkspaceId,
			name,
			defaultWorkspaceName: organizations_DEFAULT_WORKSPACE_NAME,
		},
	});
}

export async function organizations_db_create_workspace(
	ctx: MutationCtx,
	args: { userId: Id<"users">; organizationId: Id<"organizations">; name: string; description: string; now: number },
) {
	const nameResult = organizations_validate_name(args.name);
	if (nameResult._nay) {
		return Result({
			_nay: {
				message: nameResult._nay.message,
			},
		});
	}
	const name = nameResult._yay;

	const organization = await ctx.db.get("organizations", args.organizationId);
	if (!organization) {
		return Result({
			_nay: {
				message: "Not found",
			},
		});
	}

	const hasMembership = Boolean(
		await ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_active_user_organization_workspace", (q) =>
				q.eq("active", true).eq("userId", args.userId).eq("organizationId", args.organizationId),
			)
			.first(),
	);

	if (!hasMembership) {
		return Result({
			_nay: {
				message: "Not found",
			},
		});
	}

	const [defaultWorkspaces, nonDefaultWorkspaces] = await Promise.all([
		ctx.db
			.query("organizations_workspaces")
			.withIndex("by_organization_default", (q) => q.eq("organizationId", args.organizationId).eq("default", true))
			.collect(),
		ctx.db
			.query("organizations_workspaces")
			.withIndex("by_organization_default", (q) => q.eq("organizationId", args.organizationId).eq("default", false))
			.collect(),
	]);

	for (const workspace of [...defaultWorkspaces, ...nonDefaultWorkspaces]) {
		if (workspace.name === name) {
			return Result({
				_nay: {
					message: "Workspace name already exists",
				},
			});
		}
	}

	const quota = await quotas_db_get(ctx, {
		quotaName: "extra_workspaces",
		organizationId: args.organizationId,
	});
	const remainingCount = Math.max(0, quota.maxCount - quota.usedCount);
	if (remainingCount <= 0) {
		return Result({
			_nay: {
				message: "Workspace quota reached",
			},
		});
	}

	await ctx.db.patch("quotas", quota._id, {
		usedCount: quota.usedCount + 1,
		updatedAt: args.now,
	});

	const workspaceId = await ctx.db.insert("organizations_workspaces", {
		organizationId: args.organizationId,
		name,
		description: args.description,
		default: false,
		updatedAt: args.now,
	});

	await ctx.db.insert("organizations_workspaces_users", {
		organizationId: args.organizationId,
		workspaceId,
		userId: args.userId,
		active: true,
		updatedAt: args.now,
	});
	await quotas_db_ensure(ctx, {
		quotaName: "active_api_credentials",
		userId: args.userId,
		organizationId: args.organizationId,
		workspaceId,
		now: args.now,
	});

	await access_control_db_ensure_role_assignment(ctx, {
		organizationId: args.organizationId,
		workspaceId,
		userId: args.userId,
		role: "member",
		now: args.now,
	});

	for (const grant of access_control_workspace_role_permission_grants) {
		await access_control_db_ensure_role_permission_grant(ctx, {
			organizationId: args.organizationId,
			workspaceId,
			resourceKind: "workspace",
			resourceId: String(workspaceId),
			role: grant.role,
			permission: grant.permission,
			now: args.now,
		});
	}

	// Seeding the README needs an action (R2 writes), so it runs right after this mutation.
	await ctx.scheduler.runAfter(0, internal.files_nodes.create_home_file, {
		organizationId: args.organizationId,
		workspaceId,
		userId: args.userId,
	});

	return Result({
		_yay: {
			workspaceId,
			name,
			organizationId: args.organizationId,
		},
	});
}

export async function organizations_db_ensure_default_organization_and_workspace_for_user(
	ctx: MutationCtx,
	args: { userId: Id<"users">; now: number },
) {
	const user = await ctx.db.get("users", args.userId);
	if (!user) {
		return;
	}

	const defaultOrganization = user.defaultOrganizationId
		? await ctx.db.get("organizations", user.defaultOrganizationId)
		: null;

	if (!defaultOrganization) {
		await organizations_db_create(ctx, {
			userId: args.userId,
			name: organizations_DEFAULT_ORGANIZATION_NAME,
			description: "",
			now: args.now,
			default: true,
		});
	}
}

export const list = query({
	args: {},
	returns: v.object({
		organizations: v.array(doc(app_convex_schema, "organizations")),
		organizationIdsWorkspacesDict: v.record(
			v.id("organizations"),
			v.array(doc(app_convex_schema, "organizations_workspaces")),
		),
	}),
	handler: async (ctx) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			throw convex_error({ message: "Unauthenticated" });
		}
		const memberships = await ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_active_user_organization_workspace", (q) => q.eq("active", true).eq("userId", userAuth.id))
			.collect();

		const workspaceIdsByOrganization = new Map<Id<"organizations">, Set<Id<"organizations_workspaces">>>();
		for (const membership of memberships) {
			let workspaceIds = workspaceIdsByOrganization.get(membership.organizationId);
			if (!workspaceIds) {
				workspaceIds = new Set();
				workspaceIdsByOrganization.set(membership.organizationId, workspaceIds);
			}
			workspaceIds.add(membership.workspaceId);
		}

		const organizationsUnsorted = await Promise.try(async () => {
			const organizationsPromises = [];

			for (const organizationId of workspaceIdsByOrganization.keys()) {
				organizationsPromises.push(ctx.db.get("organizations", organizationId));
			}

			const organizations = [];
			for (const organizationPromise of organizationsPromises) {
				const organization = await organizationPromise;

				if (organization) {
					organizations.push(organization);
				}
			}

			return organizations;
		});

		// Presentation order: default organization first, then locale-aware name (+ `_id` tiebreaker). Workspace docs per organization: organization primary first (`defaultWorkspaceId` / `default` flag), then the same name rule.
		const organizations = organizations_list_sort_organizations(organizationsUnsorted);

		const organizationIdsWorkspacesDict = Object.fromEntries(
			await Promise.all(
				organizations.map(async (organization) => {
					const organizationId = organization._id;
					const workspaceIds = workspaceIdsByOrganization.get(organizationId);

					if (!workspaceIds) {
						const errorMessage = "Workspace ids not found for organization";
						const errorData = { organizationId };
						console.error(errorMessage, errorData);
						throw should_never_happen(errorMessage, errorData);
					}

					const workspacesPromises = [];
					for (const workspaceId of workspaceIds) {
						workspacesPromises.push(ctx.db.get("organizations_workspaces", workspaceId));
					}

					const workspaces = [];
					for (const workspacePromise of workspacesPromises) {
						const workspace = await workspacePromise;
						if (workspace !== null) {
							workspaces.push(workspace);
						}
					}

					const workspacesSorted = organizations_list_sort_workspaces_for_organization(organization, workspaces);

					return [organizationId, workspacesSorted] as const;
				}),
			),
		);

		return {
			organizations,
			organizationIdsWorkspacesDict,
		};
	},
});

export const get_membership_for_scope = query({
	args: {
		organizationId: v.string(),
		workspaceId: v.string(),
	},
	returns: v.union(doc(app_convex_schema, "organizations_workspaces_users"), v.null()),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			throw convex_error({ message: "Unauthenticated" });
		}
		const organizationId = ctx.db.normalizeId("organizations", args.organizationId);
		const workspaceId = ctx.db.normalizeId("organizations_workspaces", args.workspaceId);
		if (!organizationId || !workspaceId) {
			return null;
		}

		const membership = await ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_active_user_organization_workspace", (q) =>
				q
					.eq("active", true)
					.eq("userId", userAuth.id)
					.eq("organizationId", organizationId)
					.eq("workspaceId", workspaceId),
			)
			.first();

		return membership;
	},
});

export const get_tenant = internalQuery({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
	},
	returns: v.object({
		organization: doc(app_convex_schema, "organizations"),
		workspace: doc(app_convex_schema, "organizations_workspaces"),
	}),
	handler: async (ctx, args) => {
		const [organization, workspace] = await Promise.all([
			ctx.db.get("organizations", args.organizationId),
			ctx.db.get("organizations_workspaces", args.workspaceId),
		]);
		if (!organization || !workspace || workspace.organizationId !== organization._id) {
			const errorMessage = "Organization/workspace scope points to missing or mismatched docs";
			const errorData = { organizationId: args.organizationId, workspaceId: args.workspaceId };
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}

		return {
			organization,
			workspace,
		};
	},
});

export const get_membership_by_organization_workspace_name = query({
	args: {
		organizationName: v.string(),
		workspaceName: v.string(),
	},
	returns: v.union(doc(app_convex_schema, "organizations_workspaces_users"), v.null()),
	handler: async (ctx, args) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx).then((userAuth) => {
			if (!userAuth) {
				return null;
			}

			return ctx.db.get("users", userAuth.id);
		});

		if (!user) {
			throw convex_error({ message: "Unauthenticated" });
		}

		const organizationNameResult = organizations_validate_name(args.organizationName);
		if (organizationNameResult._nay) {
			return null;
		}

		const workspaceNameResult = organizations_validate_name(args.workspaceName);
		if (workspaceNameResult._nay) {
			return null;
		}

		const memberships = await ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_active_user_organization_workspace", (q) => q.eq("active", true).eq("userId", user._id))
			.collect();

		const candidateMembershipsPromises = [];
		for (const membership of memberships) {
			candidateMembershipsPromises.push(
				Promise.all([
					ctx.db.get("organizations", membership.organizationId),
					ctx.db.get("organizations_workspaces", membership.workspaceId),
				]).then(([organization, workspace]) => {
					if (!organization || !workspace) {
						return;
					}

					if (workspace.organizationId !== membership.organizationId) {
						return;
					}

					if (organization.name !== organizationNameResult._yay || workspace.name !== workspaceNameResult._yay) {
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

/**
 * Get the membership doc.
 *
 * Useful to check user access to resources.
 */
export const get_membership = query({
	args: {
		membershipId: v.string(),
	},
	returns: v.union(doc(app_convex_schema, "organizations_workspaces_users"), v.null()),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			throw convex_error({ message: "Unauthenticated" });
		}

		// Normalize untrusted request ids before `db.get`; Convex throws for malformed strings and wrong-table ids.
		const membershipId = ctx.db.normalizeId("organizations_workspaces_users", args.membershipId.trim());
		if (!membershipId) {
			return null;
		}

		return await organizations_db_get_membership(ctx, { membershipId, userId: userAuth.id });
	},
});

export const list_organization_workspace_users = query({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
	},
	returns: v.union(v.array(v.id("users")), v.null()),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			throw convex_error({ message: "Unauthenticated" });
		}

		const [currentWorkspaceMembership, workspaceMemberships] = await Promise.all([
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
			// Get all users in the requested workspace.
			ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_active_organization_workspace_user", (q) =>
					q.eq("active", true).eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId),
				)
				.collect(),
		]);

		// Return nothing if the user requesting the list is not part of the workspace.
		if (!currentWorkspaceMembership) {
			return null;
		}

		return workspaceMemberships.map((membership) => membership.userId);
	},
});

export const create_organization = mutation({
	args: {
		name: v.string(),
		description: v.string(),
	},
	returns: v_result({
		_yay: v.object({
			organizationId: v.id("organizations"),
			defaultWorkspaceId: v.id("organizations_workspaces"),
			name: v.string(),
			defaultWorkspaceName: v.string(),
		}),
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const now = Date.now();

		const descriptionResult = organizations_validate_description(args.description);
		if (descriptionResult._nay) {
			return Result({
				_nay: {
					message: descriptionResult._nay.message,
				},
			});
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "organizations_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		return await organizations_db_create(ctx, {
			userId: userAuth.id,
			name: args.name,
			description: descriptionResult._yay,
			now,
		});
	},
});

export const create_workspace = mutation({
	args: {
		organizationId: v.id("organizations"),
		name: v.string(),
		description: v.string(),
	},
	returns: v_result({
		_yay: v.object({
			name: v.string(),
			workspaceId: v.id("organizations_workspaces"),
			organizationId: v.id("organizations"),
		}),
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const now = Date.now();

		const descriptionResult = organizations_validate_description(args.description);
		if (descriptionResult._nay) {
			return Result({
				_nay: {
					message: descriptionResult._nay.message,
				},
			});
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "organizations_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		return await organizations_db_create_workspace(ctx, {
			userId: userAuth.id,
			organizationId: args.organizationId,
			name: args.name,
			description: descriptionResult._yay,
			now,
		});
	},
});

/**
 * Add an existing user to an organization workspace by id or by email.
 * The default workspace means organization membership, so adding to
 * another workspace also adds the user to default when needed.
 */
export const invite_user_to_organization_workspace = mutation({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		email: v.optional(v.string()),
		userIdToAdd: v.optional(v.id("users")),
	},
	returns: v_result({
		_yay: v.null(),
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "organizations_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		let userIdToAdd = args.userIdToAdd ?? null;
		if (!userIdToAdd) {
			const email = args.email?.trim().toLowerCase() ?? "";
			if (!email) {
				return Result({ _nay: { message: "Email is required" } });
			}

			const anagraphic = await ctx.db
				.query("users_anagraphics")
				.withIndex("by_email", (q) => q.eq("email", email))
				.unique()
				.catch(() => "duplicate_email" as const);
			if (!anagraphic || anagraphic === "duplicate_email") {
				return Result({ _nay: { message: "User to add not found" } });
			}
			userIdToAdd = anagraphic.userId;
		}

		if (userAuth.id === userIdToAdd) {
			return Result({ _nay: { message: "Cannot invite yourself" } });
		}

		const now = Date.now();

		// Load the user, organization, and requested workspace before checking membership and permissions.
		const [userToAdd, organization, workspace] = await Promise.all([
			ctx.db.get("users", userIdToAdd),
			ctx.db.get("organizations", args.organizationId),
			ctx.db.get("organizations_workspaces", args.workspaceId),
		]);

		if (!userToAdd || userToAdd.deletedAt != null) {
			return Result({ _nay: { message: "User to add not found" } });
		}

		if (!organization || !workspace || workspace.organizationId !== args.organizationId) {
			return Result({ _nay: { message: "Not found" } });
		}

		if (!organization.defaultWorkspaceId) {
			const errorMessage = "organization.defaultWorkspaceId is not set";
			const errorData = {
				organizationId: organization._id,
			};
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}
		const defaultWorkspaceId = organization.defaultWorkspaceId;
		const isDefaultWorkspace = workspace._id === defaultWorkspaceId;

		if (organization.default) {
			return Result({ _nay: { message: "Cannot add user to default organization" } });
		}

		const [currentHomeMembership, canManageMembers] = await Promise.all([
			// Check if the current user is part of the organization before adding another user.
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
			access_control_db_has_permission(ctx, {
				organizationId: organization._id,
				workspaceId: defaultWorkspaceId,
				defaultWorkspaceId,
				organizationOwnerUserId: organization.ownerUserId,
				resourceKind: "organization",
				resourceId: String(organization._id),
				permission: "organization.members.manage",
				userId: userAuth.id,
			}),
		]);
		if (!currentHomeMembership) {
			return Result({ _nay: { message: "Not found" } });
		}

		if (!canManageMembers) {
			return Result({ _nay: { message: "Permission denied" } });
		}

		// Check if the user is already in the default workspace and in the requested workspace.
		const [existingHomeMembership, existingWorkspaceMembership] = await Promise.all([
			isDefaultWorkspace
				? null
				: ctx.db
						.query("organizations_workspaces_users")
						.withIndex("by_active_user_organization_workspace", (q) =>
							q
								.eq("active", true)
								.eq("userId", userIdToAdd)
								.eq("organizationId", organization._id)
								.eq("workspaceId", defaultWorkspaceId),
						)
						.first(),
			ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_active_user_organization_workspace", (q) =>
					q
						.eq("active", true)
						.eq("userId", userIdToAdd)
						.eq("organizationId", organization._id)
						.eq("workspaceId", workspace._id),
				)
				.first(),
		]);

		if (existingWorkspaceMembership) {
			// Treat repeated invite attempts as success when the user is already in the requested workspace.
			return Result({ _yay: null });
		}

		// Add the user to the default workspace and, when different, to the requested workspace.
		await Promise.all([
			existingHomeMembership
				? null
				: ctx.db.insert("organizations_workspaces_users", {
						organizationId: organization._id,
						workspaceId: defaultWorkspaceId,
						userId: userIdToAdd,
						active: true,
						updatedAt: now,
					}),
			existingHomeMembership
				? null
				: quotas_db_ensure(ctx, {
						quotaName: "active_api_credentials",
						userId: userIdToAdd,
						organizationId: organization._id,
						workspaceId: defaultWorkspaceId,
						now,
					}),
			access_control_db_ensure_role_assignment(ctx, {
				organizationId: organization._id,
				workspaceId: defaultWorkspaceId,
				userId: userIdToAdd,
				role: "member",
				now,
			}),
			isDefaultWorkspace
				? null
				: ctx.db.insert("organizations_workspaces_users", {
						organizationId: organization._id,
						workspaceId: workspace._id,
						userId: userIdToAdd,
						active: true,
						updatedAt: now,
					}),
			isDefaultWorkspace
				? null
				: quotas_db_ensure(ctx, {
						quotaName: "active_api_credentials",
						userId: userIdToAdd,
						organizationId: organization._id,
						workspaceId: workspace._id,
						now,
					}),
			isDefaultWorkspace
				? null
				: access_control_db_ensure_role_assignment(ctx, {
						organizationId: organization._id,
						workspaceId: workspace._id,
						userId: userIdToAdd,
						role: "member",
						now,
					}),
			ctx.db.insert("notifications", {
				userId: userIdToAdd,
				kind: "organization_workspace_invite",
				archivedAt: 0,
				actorUserId: userAuth.id,
				organizationId: organization._id,
				workspaceId: workspace._id,
				updatedAt: now,
			}),
		]);

		return Result({ _yay: null });
	},
});

export const remove_user_from_organization = mutation({
	args: {
		organizationId: v.id("organizations"),
		userIdToRemove: v.id("users"),
	},
	returns: v_result({
		_yay: v.null(),
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const organization = await ctx.db.get("organizations", args.organizationId);
		if (!organization) {
			return Result({ _nay: { message: "Not found" } });
		}

		if (!organization.defaultWorkspaceId) {
			const errorMessage = "organization.defaultWorkspaceId is not set";
			const errorData = {
				organizationId: organization._id,
			};
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}
		const defaultWorkspaceId = organization.defaultWorkspaceId;

		const userToRemoveIsOwner = organization.ownerUserId === args.userIdToRemove;
		const [currentHomeMembership, canManageMembers] = await Promise.all([
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
			access_control_db_has_permission(ctx, {
				organizationId: organization._id,
				workspaceId: defaultWorkspaceId,
				defaultWorkspaceId,
				organizationOwnerUserId: organization.ownerUserId,
				resourceKind: "organization",
				resourceId: String(organization._id),
				permission: "organization.members.manage",
				userId: userAuth.id,
			}),
		]);
		if (!currentHomeMembership) {
			return Result({ _nay: { message: "Not found" } });
		}

		if (organization.default) {
			return Result({ _nay: { message: "Cannot remove users from the default organization" } });
		}

		if (userToRemoveIsOwner) {
			return Result({ _nay: { message: "Cannot remove the organization owner" } });
		}

		// Allow regular members to leave, but keep removing another user behind member-management permission.
		if (userAuth.id !== args.userIdToRemove && !canManageMembers) {
			return Result({ _nay: { message: "Permission denied" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "organizations_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const now = Date.now();

		const memberships = await ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_active_user_organization_workspace", (q) =>
				q.eq("active", true).eq("userId", args.userIdToRemove).eq("organizationId", organization._id),
			)
			.collect();
		const apiCredentialsPromise = Promise.all(
			memberships.map((membership) =>
				ctx.db
					.query("api_credentials")
					.withIndex("by_organization_workspace_user_revokedAt", (q) =>
						q
							.eq("organizationId", organization._id)
							.eq("workspaceId", membership.workspaceId)
							.eq("userId", args.userIdToRemove)
							.eq("revokedAt", null),
					)
					// The active API credential quota bounds this workspace/user set. Collect every match so removal cannot leave a key active.
					.collect(),
			),
		);
		const apiCredentialQuotasPromise = Promise.all(
			memberships.map((membership) =>
				quotas_db_get(ctx, {
					quotaName: "active_api_credentials",
					userId: args.userIdToRemove,
					organizationId: organization._id,
					workspaceId: membership.workspaceId,
				}),
			),
		);

		await Promise.all([
			...memberships.map((membership) => ctx.db.delete("organizations_workspaces_users", membership._id)),
			// Re-inviting this user must never restore credentials from the membership being removed.
			apiCredentialsPromise.then((apiCredentials) =>
				Promise.all(
					apiCredentials
						.flat()
						.map((apiCredential) => ctx.db.patch("api_credentials", apiCredential._id, { revokedAt: now })),
				),
			),
			// Delete these quota docs so a later invite creates counters with `usedCount: 0`.
			apiCredentialQuotasPromise.then((quotaDocs) =>
				Promise.all(quotaDocs.map((quotaDoc) => ctx.db.delete("quotas", quotaDoc._id))),
			),
			// Remove invite notifications for the organization access the user is losing.
			ctx.db
				.query("notifications")
				.withIndex("by_organization_user_archivedAt", (q) =>
					q.eq("organizationId", organization._id).eq("userId", args.userIdToRemove),
				)
				.collect()
				.then((notifications) =>
					Promise.all(notifications.map((notification) => ctx.db.delete("notifications", notification._id))),
				),
			ctx.db
				.query("access_control_role_assignments")
				.withIndex("by_organization_user_workspace_role", (q) =>
					q.eq("organizationId", organization._id).eq("userId", args.userIdToRemove),
				)
				.collect()
				.then((docs) => Promise.all(docs.map((doc) => ctx.db.delete("access_control_role_assignments", doc._id)))),
			ctx.db
				.query("access_control_permission_grants")
				.withIndex("by_organization_user_workspace_resource_permission", (q) =>
					q.eq("organizationId", organization._id).eq("userId", args.userIdToRemove),
				)
				.collect()
				.then((docs) => Promise.all(docs.map((doc) => ctx.db.delete("access_control_permission_grants", doc._id)))),
		]);

		return Result({ _yay: null });
	},
});

export const edit_organization = mutation({
	args: {
		organizationId: v.id("organizations"),
		defaultWorkspaceId: v.id("organizations_workspaces"),
		name: v.string(),
		description: v.string(),
	},
	returns: v_result({
		_yay: v.object({
			name: v.string(),
		}),
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const now = Date.now();

		const [organization, defaultWorkspace, organizationUserLookup] = await Promise.all([
			ctx.db.get("organizations", args.organizationId),
			ctx.db.get("organizations_workspaces", args.defaultWorkspaceId),
			ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_active_user_organization_workspace", (q) =>
					q
						.eq("active", true)
						.eq("userId", userAuth.id)
						.eq("organizationId", args.organizationId)
						.eq("workspaceId", args.defaultWorkspaceId),
				)
				.first(),
		]);

		if (
			!organization ||
			defaultWorkspace === null ||
			defaultWorkspace.organizationId !== args.organizationId ||
			!(organization.defaultWorkspaceId === defaultWorkspace._id || defaultWorkspace.default) ||
			!organizationUserLookup
		) {
			return Result({
				_nay: {
					message: "Not found",
				},
			});
		}

		if (
			!(await access_control_db_has_permission(ctx, {
				organizationId: organization._id,
				workspaceId: defaultWorkspace._id,
				defaultWorkspaceId: defaultWorkspace._id,
				organizationOwnerUserId: organization.ownerUserId,
				resourceKind: "organization",
				resourceId: String(organization._id),
				permission: "organization.update",
				userId: userAuth.id,
			}))
		) {
			return Result({
				_nay: {
					message: "Permission denied",
				},
			});
		}

		if (organization.default) {
			return Result({
				_nay: {
					message: "Cannot edit the default organization",
				},
			});
		}

		const descriptionResult = organizations_validate_description(args.description);
		if (descriptionResult._nay) {
			return Result({
				_nay: {
					message: descriptionResult._nay.message,
				},
			});
		}

		const nameResult = organizations_validate_name(args.name);
		if (nameResult._nay) {
			return Result({
				_nay: {
					message: nameResult._nay.message,
				},
			});
		}
		const name = nameResult._yay;
		const description = descriptionResult._yay;

		const existingOrganization = await ctx.db
			.query("organizations")
			.withIndex("by_name", (q) => q.eq("name", name))
			.first();
		if (existingOrganization && existingOrganization._id !== args.organizationId) {
			return Result({
				_nay: {
					message: "Organization name already exists",
				},
			});
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "organizations_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		await ctx.db.patch("organizations", args.organizationId, {
			name,
			description,
			updatedAt: now,
		});

		return Result({
			_yay: {
				name,
			},
		});
	},
});

export const set_organization_billing_mode = mutation({
	args: {
		organizationId: v.id("organizations"),
		billingMode: doc(app_convex_schema, "organizations").fields.billingMode,
	},
	returns: v_result({
		_yay: v.null(),
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const organization = await ctx.db.get("organizations", args.organizationId);
		if (!organization) {
			return Result({ _nay: { message: "Not found" } });
		}

		if (organization.default) {
			return Result({ _nay: { message: "Cannot manage billing for the default organization" } });
		}

		if (organization.ownerUserId !== userAuth.id) {
			return Result({ _nay: { message: "Permission denied" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "organizations_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		await ctx.db.patch("organizations", organization._id, {
			billingMode: args.billingMode,
			updatedAt: Date.now(),
		});

		return Result({ _yay: null });
	},
});

export const edit_workspace = mutation({
	args: {
		organizationId: v.id("organizations"),
		defaultWorkspaceId: v.id("organizations_workspaces"),
		workspaceId: v.id("organizations_workspaces"),
		name: v.string(),
		description: v.string(),
	},
	returns: v_result({
		_yay: v.object({
			name: v.string(),
			organizationId: v.id("organizations"),
		}),
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const now = Date.now();

		const [organization, workspace, defaultWorkspace, defaultWorkspaceMembership, workspaceMembership] =
			await Promise.all([
				ctx.db.get("organizations", args.organizationId),
				ctx.db.get("organizations_workspaces", args.workspaceId),
				ctx.db.get("organizations_workspaces", args.defaultWorkspaceId),
				ctx.db
					.query("organizations_workspaces_users")
					.withIndex("by_active_user_organization_workspace", (q) =>
						q
							.eq("active", true)
							.eq("userId", userAuth.id)
							.eq("organizationId", args.organizationId)
							.eq("workspaceId", args.defaultWorkspaceId),
					)
					.first(),
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
			]);

		if (
			!organization ||
			!workspace ||
			!defaultWorkspace ||
			workspace.organizationId !== args.organizationId ||
			defaultWorkspace.organizationId !== args.organizationId ||
			!(organization.defaultWorkspaceId === defaultWorkspace._id || defaultWorkspace.default) ||
			!defaultWorkspaceMembership ||
			!workspaceMembership
		) {
			return Result({
				_nay: {
					message: "Not found",
				},
			});
		}

		if (
			!(await access_control_db_has_permission(ctx, {
				organizationId: organization._id,
				workspaceId: workspace._id,
				defaultWorkspaceId: defaultWorkspace._id,
				organizationOwnerUserId: organization.ownerUserId,
				resourceKind: "workspace",
				resourceId: String(workspace._id),
				permission: "workspace.update",
				userId: userAuth.id,
			})) &&
			!(await access_control_db_has_permission(ctx, {
				organizationId: organization._id,
				workspaceId: defaultWorkspace._id,
				defaultWorkspaceId: defaultWorkspace._id,
				organizationOwnerUserId: organization.ownerUserId,
				resourceKind: "organization",
				resourceId: String(organization._id),
				permission: "organization.update",
				userId: userAuth.id,
			}))
		) {
			return Result({
				_nay: {
					message: "Permission denied",
				},
			});
		}

		if (
			(organization.defaultWorkspaceId !== undefined && workspace._id === organization.defaultWorkspaceId) ||
			workspace.default
		) {
			return Result({
				_nay: {
					message: "Cannot edit the default workspace",
				},
			});
		}

		const descriptionResult = organizations_validate_description(args.description);
		if (descriptionResult._nay) {
			return Result({
				_nay: {
					message: descriptionResult._nay.message,
				},
			});
		}

		const nameResult = organizations_validate_name(args.name);
		if (nameResult._nay) {
			return Result({
				_nay: {
					message: nameResult._nay.message,
				},
			});
		}
		const name = nameResult._yay;
		const description = descriptionResult._yay;

		const [defaultWorkspaces, nonDefaultWorkspaces] = await Promise.all([
			ctx.db
				.query("organizations_workspaces")
				.withIndex("by_organization_default", (q) =>
					q.eq("organizationId", workspace.organizationId).eq("default", true),
				)
				.collect(),
			ctx.db
				.query("organizations_workspaces")
				.withIndex("by_organization_default", (q) =>
					q.eq("organizationId", workspace.organizationId).eq("default", false),
				)
				.collect(),
		]);

		for (const doc of [...defaultWorkspaces, ...nonDefaultWorkspaces]) {
			if (doc._id !== args.workspaceId && doc.name === name) {
				return Result({
					_nay: {
						message: "Workspace name already exists",
					},
				});
			}
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "organizations_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		await ctx.db.patch("organizations_workspaces", args.workspaceId, {
			name,
			description,
			updatedAt: now,
		});

		return Result({
			_yay: {
				name,
				organizationId: workspace.organizationId,
			},
		});
	},
});

export const delete_organization = mutation({
	args: {
		organizationId: v.id("organizations"),
	},
	returns: v_result({
		_yay: v.null(),
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const now = Date.now();

		const organization = await ctx.db.get("organizations", args.organizationId);
		if (!organization) {
			return Result({
				_nay: {
					message: "Not found",
				},
			});
		}

		if (!organization.defaultWorkspaceId) {
			const errorMessage = "organization.defaultWorkspaceId is not set";
			const errorData = {
				organizationId: organization._id,
			};
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}
		const defaultWorkspaceId = organization.defaultWorkspaceId;

		const organizationUserLookup = await ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_active_user_organization_workspace", (q) =>
				q
					.eq("active", true)
					.eq("userId", userAuth.id)
					.eq("organizationId", organization._id)
					.eq("workspaceId", defaultWorkspaceId),
			)
			.first();
		if (!organizationUserLookup) {
			return Result({
				_nay: {
					message: "Not found",
				},
			});
		}

		if (organization.default) {
			return Result({
				_nay: {
					message: "Cannot delete the default organization",
				},
			});
		}

		if (organization.ownerUserId !== userAuth.id) {
			return Result({
				_nay: {
					message: "Permission denied",
				},
			});
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "organizations_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const [, , , , userIdsPerWorkspace] = await Promise.all([
			// Queue one delayed organization purge doc while you remove workspace memberships in parallel.
			data_deletion_db_request(ctx, {
				userId: userAuth.id,
				organizationId: organization._id,
				scope: "organization",
			}),
			// Remove every invite notification tied to the organization being deleted.
			ctx.db
				.query("notifications")
				.withIndex("by_organization_user_archivedAt", (q) => q.eq("organizationId", organization._id))
				.collect()
				.then((notifications) =>
					Promise.all(notifications.map((notification) => ctx.db.delete("notifications", notification._id))),
				),
			ctx.db
				.query("access_control_role_assignments")
				.withIndex("by_organization_workspace_user_role", (q) => q.eq("organizationId", organization._id))
				.collect()
				.then((docs) => Promise.all(docs.map((doc) => ctx.db.delete("access_control_role_assignments", doc._id)))),
			ctx.db
				.query("access_control_permission_grants")
				.withIndex("by_organization_workspace_resource_user_permission", (q) =>
					q.eq("organizationId", organization._id),
				)
				.collect()
				.then((docs) => Promise.all(docs.map((doc) => ctx.db.delete("access_control_permission_grants", doc._id)))),
			ctx.db
				.query("organizations_workspaces")
				.withIndex("by_organization_default", (q) => q.eq("organizationId", organization._id))
				.collect()
				.then((organizationWorkspaces) =>
					Promise.all(
						organizationWorkspaces.map(async (workspace) => {
							const workspaceUsers = await ctx.db
								.query("organizations_workspaces_users")
								.withIndex("by_workspace_user_active", (q) => q.eq("workspaceId", workspace._id))
								.collect();

							await Promise.all(
								workspaceUsers.map((workspaceUser) =>
									ctx.db.delete("organizations_workspaces_users", workspaceUser._id),
								),
							);

							return workspaceUsers.map((workspaceUser) => workspaceUser.userId);
						}),
					),
				),
		]);

		const affectedUserIds = new Set<Id<"users">>(userIdsPerWorkspace.flat());

		const quota = await quotas_db_get(ctx, {
			quotaName: "extra_organizations",
			userId: organization.ownerUserId,
		});
		if (quota.usedCount > 0) {
			await ctx.db.patch("quotas", quota._id, {
				usedCount: quota.usedCount - 1,
				updatedAt: now,
			});
		}

		for (const userId of affectedUserIds) {
			await organizations_db_ensure_default_organization_and_workspace_for_user(ctx, {
				userId,
				now: Date.now(),
			});
		}

		return Result({
			_yay: null,
		});
	},
});

export const delete_workspace = mutation({
	args: {
		workspaceId: v.id("organizations_workspaces"),
	},
	returns: v_result({
		_yay: v.null(),
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const now = Date.now();

		const [[workspace, organization, organizationUserLookup], workspaceUserLookup] = await Promise.all([
			ctx.db.get("organizations_workspaces", args.workspaceId).then(
				async (workspace) =>
					[
						workspace,
						...(await Promise.try(async () => {
							if (!workspace) return [null, null] as const;

							const organization = await ctx.db.get("organizations", workspace.organizationId);
							const defaultWorkspaceId = organization?.defaultWorkspaceId;

							return [
								organization,

								defaultWorkspaceId
									? await ctx.db
											.query("organizations_workspaces_users")
											.withIndex("by_active_user_organization_workspace", (q) =>
												q
													.eq("active", true)
													.eq("userId", userAuth.id)
													.eq("organizationId", workspace.organizationId)
													.eq("workspaceId", defaultWorkspaceId),
											)
											.first()
									: null,
							] as const;
						})),
					] as const,
			),
			ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_workspace_user_active", (q) => q.eq("workspaceId", args.workspaceId))
				.collect(),
		]);

		if (!workspace || !organization || !organizationUserLookup || !workspaceUserLookup) {
			return Result({
				_nay: {
					message: "Not found",
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

		if (
			!(await access_control_db_has_permission(ctx, {
				organizationId: organization._id,
				workspaceId: workspace._id,
				defaultWorkspaceId: organizationUserLookup.workspaceId,
				organizationOwnerUserId: organization.ownerUserId,
				resourceKind: "workspace",
				resourceId: String(workspace._id),
				permission: "workspace.update",
				userId: userAuth.id,
			})) &&
			!(await access_control_db_has_permission(ctx, {
				organizationId: organization._id,
				workspaceId: organizationUserLookup.workspaceId,
				defaultWorkspaceId: organizationUserLookup.workspaceId,
				organizationOwnerUserId: organization.ownerUserId,
				resourceKind: "organization",
				resourceId: String(organization._id),
				permission: "organization.update",
				userId: userAuth.id,
			}))
		) {
			return Result({
				_nay: {
					message: "Permission denied",
				},
			});
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "organizations_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const affectedUserIds = new Set<Id<"users">>(workspaceUserLookup.map((workspaceUser) => workspaceUser.userId));

		await data_deletion_db_request(ctx, {
			userId: userAuth.id,
			organizationId: organization._id,
			workspaceId: workspace._id,
			scope: "workspace",
		});
		const quota = await quotas_db_get(ctx, {
			quotaName: "extra_workspaces",
			organizationId: organization._id,
		});
		if (quota.usedCount > 0) {
			await ctx.db.patch("quotas", quota._id, {
				usedCount: quota.usedCount - 1,
				updatedAt: now,
			});
		}
		await Promise.all([
			// Remove invite notifications that pointed at the workspace being deleted.
			ctx.db
				.query("notifications")
				.withIndex("by_organization_workspace_user", (q) =>
					q.eq("organizationId", organization._id).eq("workspaceId", workspace._id),
				)
				.collect()
				.then((notifications) =>
					Promise.all(notifications.map((notification) => ctx.db.delete("notifications", notification._id))),
				),
			Promise.all(
				workspaceUserLookup.map((workspaceUser) => ctx.db.delete("organizations_workspaces_users", workspaceUser._id)),
			),
			ctx.db
				.query("quotas")
				.withIndex("by_workspace_quotaName", (q) =>
					q.eq("workspaceId", workspace._id).eq("quotaName", "active_api_credentials"),
				)
				.collect()
				.then((docs) => Promise.all(docs.map((doc) => ctx.db.delete("quotas", doc._id)))),
			ctx.db
				.query("access_control_role_assignments")
				.withIndex("by_organization_workspace_user_role", (q) =>
					q.eq("organizationId", organization._id).eq("workspaceId", workspace._id),
				)
				.collect()
				.then((docs) => Promise.all(docs.map((doc) => ctx.db.delete("access_control_role_assignments", doc._id)))),
			ctx.db
				.query("access_control_permission_grants")
				.withIndex("by_organization_workspace_resource_user_permission", (q) =>
					q.eq("organizationId", organization._id).eq("workspaceId", workspace._id),
				)
				.collect()
				.then((docs) => Promise.all(docs.map((doc) => ctx.db.delete("access_control_permission_grants", doc._id)))),
		]);

		await ctx.db.delete("organizations_workspaces", workspace._id);
		for (const userId of affectedUserIds) {
			await organizations_db_ensure_default_organization_and_workspace_for_user(ctx, {
				userId,
				now: Date.now(),
			});
		}

		return Result({
			_yay: null,
		});
	},
});
