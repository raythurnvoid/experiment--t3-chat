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
	access_control_db_ensure_role_assignment,
	access_control_db_has_permission,
	access_control_db_resolve_effective_permissions,
	access_control_db_resolve_role_refs,
	access_control_db_role_file_grant_caller_cannot_give,
} from "./access_control.ts";
import {
	access_control_PERMISSION_CATALOG,
	access_control_SYSTEM_ROLE_MATRIX,
	type access_control_RoleRef,
} from "../shared/access-control.ts";
import { data_deletion_db_request } from "./data_deletion_requests.ts";
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

		// The creator gets no role assignment: being in `organizations.ownerUserId` already gives them
		// everything.
		ctx.db.insert("organizations_workspaces_users", {
			organizationId: organizationId,
			workspaceId: defaultWorkspaceId,
			userId: args.userId,
			active: true,
			updatedAt: args.now,
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

	// Seeding the README needs an action (R2 writes), so it runs right after this mutation.
	await ctx.scheduler.runAfter(0, internal.files_nodes_content.create_home_file, {
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

	const defaultWorkspaceId = organization.defaultWorkspaceId;
	if (!defaultWorkspaceId) {
		const errorMessage = "organization.defaultWorkspaceId is not set";
		const errorData = { organizationId: organization._id };
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}

	// Creating a workspace uses up the organization's workspace quota, so not every member may do it.
	// We check on the default workspace, because this permission is organization-scoped and only works
	// from there.
	const canCreateWorkspace = await access_control_db_has_permission(ctx, {
		organizationId: organization._id,
		workspaceId: defaultWorkspaceId,
		defaultWorkspaceId,
		organizationOwnerUserId: organization.ownerUserId,
		resource: { kind: "organization", id: String(organization._id) },
		permission: "workspace.create",
		userId: args.userId,
	});
	if (!canCreateWorkspace) {
		return Result({
			_nay: {
				message: "Permission denied",
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

	// We write no role assignment here. The creator's organization role already works in this
	// workspace through the membership we just created. Also, always giving `member` would let someone
	// whose role only has `workspace.create` write files in the workspace they just made.

	// Seeding the README needs an action (R2 writes), so it runs right after this mutation.
	await ctx.scheduler.runAfter(0, internal.files_nodes_content.create_home_file, {
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
		// What the caller may do in each workspace listed above, so the switcher can hide buttons the
		// server would refuse. `"all"` means the caller is the organization owner.
		//
		// This travels with the list instead of being its own query, even though our guidelines
		// normally prefer separate queries. Two reasons. The switcher draws every organization and
		// workspace at once, so a separate query would mean either one call per membership, or a second
		// round trip that makes the buttons appear after the names. And the price of joining them is
		// that this query re-runs when a role changes — which is exactly when the switcher's old
		// answer is wrong anyway.
		workspaceIdsPermissionsDict: v.record(
			v.id("organizations_workspaces"),
			v.union(v.literal("all"), v.array(doc(app_convex_schema, "access_control_permission_grants").fields.permission)),
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

		const workspaceIdsPermissionsDict = Object.fromEntries(
			await Promise.all(
				organizations.flatMap((organization) =>
					(organizationIdsWorkspacesDict[organization._id] ?? []).map(async (workspace) => {
						const defaultWorkspaceId = organization.defaultWorkspaceId;
						// Do not use this workspace id as a stand-in for the default one. Organization-wide
						// permissions only work from the default workspace, so that would make a role that
						// exists only in this workspace look organization-wide. Report nothing instead and
						// let the server refuse the action.
						if (!defaultWorkspaceId) {
							console.error("organization.defaultWorkspaceId is not set", { organizationId: organization._id });
							return [workspace._id, []] as const;
						}

						const permissions = await access_control_db_resolve_effective_permissions(ctx, {
							organizationId: organization._id,
							workspaceId: workspace._id,
							defaultWorkspaceId,
							organizationOwnerUserId: organization.ownerUserId,
							userId: userAuth.id,
						});

						return [workspace._id, permissions === "all" ? "all" : [...permissions]] as const;
					}),
				),
			),
		);

		return {
			organizations,
			organizationIdsWorkspacesDict,
			workspaceIdsPermissionsDict,
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
		// Only a signed-in user can create an organization. Making an anonymous account costs one
		// request with no login, and whoever creates an organization can invite any user by email.
		// The invited user joins right away, with no step where they accept. So anonymous creation
		// would let anyone push real users into memberships and notifications for free.
		// Anonymous users are not left with nothing: signup already gives them a `personal`
		// organization.
		if (!userAuth || userAuth.kind !== "signed_in") {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		// A deleted account keeps its `users` doc with `deletedAt` set, and its old session token can
		// still work. `access_control_db_authorize_membership` rejects such a user for the same reason.
		// Without this check, an account whose deletion did not finish in Clerk could still create new
		// organizations.
		const user = await ctx.db.get("users", userAuth.id);
		if (!user || user.deletedAt != null) {
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

		const now = Date.now();

		// Check the caller's permission on this organization BEFORE looking up the `email`. That lookup
		// answers "does this address have an account here?". When it ran first, anyone could use this
		// endpoint to test email addresses: an unknown address answered "User to add not found", while
		// a known one gave a different error. Anyone can create an anonymous account and ask. Now only
		// a member with `organization.members.manage` reaches the lookup, and for them "this address is
		// unknown" is the answer they asked for.
		const [organization, workspace] = await Promise.all([
			ctx.db.get("organizations", args.organizationId),
			ctx.db.get("organizations_workspaces", args.workspaceId),
		]);

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

		const [currentHomeMembership, callerPermissions] = await Promise.all([
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
			access_control_db_resolve_effective_permissions(ctx, {
				organizationId: organization._id,
				workspaceId: defaultWorkspaceId,
				defaultWorkspaceId,
				organizationOwnerUserId: organization.ownerUserId,
				userId: userAuth.id,
			}),
		]);
		if (!currentHomeMembership) {
			return Result({ _nay: { message: "Not found" } });
		}

		if (callerPermissions !== "all" && !callerPermissions.has("organization.members.manage")) {
			return Result({ _nay: { message: "Permission denied" } });
		}

		// From here down the caller is a member with the right permission, so looking up the invited
		// user tells them nothing they could not already see on the members page.
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

		const userToAdd = await ctx.db.get("users", userIdToAdd);
		if (!userToAdd || userToAdd.deletedAt != null) {
			return Result({ _nay: { message: "User to add not found" } });
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

		// The role given by this invite is not the only thing that matters. The invited user may
		// already have a role for the whole organization. Adding them to this workspace turns ON the
		// workspace-scoped permissions of that role here, because the permission checker gives those
		// only to a real member of the workspace.
		//
		// So we also compare what the invited user already has against what the caller has. Without
		// this, a caller who only has `organization.members.manage` could put a very powerful member
		// into a workspace where `set_user_role` would never let them give those powers.
		//
		// We look at workspace-scoped permissions only. Organization-scoped ones come from the
		// assignment in the default workspace and do not need a membership, so the invite does not
		// change them.
		//
		// This runs after the "already a member" return above, because only an invite that really
		// writes a membership turns anything on. We measure the caller in the target workspace, the
		// same place `set_user_role` measures them, so a caller who only holds a workspace role here
		// is still allowed to give what they can already give here.
		if (callerPermissions !== "all") {
			const [inviteePermissions, callerWorkspacePermissions] = await Promise.all([
				access_control_db_resolve_effective_permissions(ctx, {
					organizationId: organization._id,
					workspaceId: defaultWorkspaceId,
					defaultWorkspaceId,
					organizationOwnerUserId: organization.ownerUserId,
					userId: userIdToAdd,
				}),
				isDefaultWorkspace
					? callerPermissions
					: access_control_db_resolve_effective_permissions(ctx, {
							organizationId: organization._id,
							workspaceId: workspace._id,
							defaultWorkspaceId,
							organizationOwnerUserId: organization.ownerUserId,
							userId: userAuth.id,
						}),
			]);

			// `"all"` means "this user is the organization owner". An invited owner already has every
			// permission, so the invite cannot raise them. An owner caller was already handled by the
			// `callerPermissions !== "all"` check above.
			if (inviteePermissions !== "all" && callerWorkspacePermissions !== "all") {
				const missing = [...inviteePermissions].find(
					(permission) =>
						access_control_PERMISSION_CATALOG[permission].scope === "workspace" &&
						!callerWorkspacePermissions.has(permission),
				);
				if (missing) {
					return Result({
						_nay: {
							message: `You cannot invite this member, because their role grants "${access_control_PERMISSION_CATALOG[missing].label}"`,
						},
					});
				}
			}

			// A share list can name a role, so a role carries restricted files its permission list says
			// nothing about, and the check above cannot see them.
			//
			// Only `member`, and only when this invite really hands it out. `ensure_role_assignment`
			// below keeps an assignment that already exists, so an invitee who already has a role never
			// receives `member` and weighing it here would refuse an invite that gives nothing. The
			// owner never gets an assignment at all.
			//
			// This sits after the "already in this workspace" return above, for the same reason that
			// one does: an invite that writes nothing can hand out nothing.
			// Every workspace this invite really joins them to, and the only place a role can hand the
			// invitee anything: a file grant works only for an active member of the workspace it lives
			// in. The default workspace counts only when its membership is new too, because an invite
			// that writes nothing there switches nothing on there.
			const joinedWorkspaceIds =
				isDefaultWorkspace || existingHomeMembership ? [workspace._id] : [workspace._id, defaultWorkspaceId];

			const assignsMemberRole =
				userIdToAdd !== organization.ownerUserId &&
				!(await ctx.db
					.query("access_control_role_assignments")
					.withIndex("by_organization_workspace_user", (q) =>
						q.eq("organizationId", organization._id).eq("workspaceId", defaultWorkspaceId).eq("userId", userIdToAdd),
					)
					.first());
			if (assignsMemberRole) {
				// An invite gives out a role, so it follows the same rule as `set_user_role`: the invited role
				// must be one the inviter could give. Without this, someone whose role only manages members
				// could invite an account of their own and give it full read and write access. Weighed only
				// here, when the invite really hands out `member`: an invitee who is already in the workspace,
				// or who keeps a role they already have, receives nothing this check could refuse.
				const missing = access_control_SYSTEM_ROLE_MATRIX.member.permissions.find(
					(permission) => !callerPermissions.has(permission),
				);
				if (missing) {
					// The message names the role, unlike the similar errors in `access_control.ts`. An invite
					// takes no role argument, so the caller never chose this role and cannot choose another.
					return Result({
						_nay: {
							message: `You cannot invite someone as ${access_control_SYSTEM_ROLE_MATRIX.member.label}, because that role grants "${access_control_PERMISSION_CATALOG[missing].label}"`,
						},
					});
				}

				const blockingGrant = await access_control_db_role_file_grant_caller_cannot_give(ctx, {
					organization,
					defaultWorkspaceId,
					reach: { kind: "workspaces", joinedWorkspaceIds },
					role: "member",
					userId: userAuth.id,
				});
				if (blockingGrant) {
					return Result({
						_nay: {
							message: `You cannot invite someone as ${access_control_SYSTEM_ROLE_MATRIX.member.label}: that role is shared on a file you do not have "${access_control_PERMISSION_CATALOG[blockingGrant.permission].label}" on`,
						},
					});
				}
			}

			// The role this invite gives is not the only role the invitee ends up holding here. A file
			// grant only works for a member of the workspace it lives in, so writing the membership below
			// is what switches on every grant naming a role they already have. The permission comparison
			// above cannot see those: a role carries files its permission list says nothing about.
			//
			// Each distinct role is weighed once, over every workspace this invite joins. The scan is the
			// most expensive read in this mutation, and asking the same role a second time cannot return
			// a different answer.
			const heldRoles = new Set<access_control_RoleRef>();
			for (const joinedWorkspaceId of joinedWorkspaceIds) {
				for (const heldRole of await access_control_db_resolve_role_refs(ctx, {
					organizationId: organization._id,
					workspaceId: joinedWorkspaceId,
					defaultWorkspaceId,
					userId: userIdToAdd,
				})) {
					heldRoles.add(heldRole);
				}
			}

			// Already weighed just above, over these same workspaces.
			if (assignsMemberRole) {
				heldRoles.delete("member");
			}

			for (const heldRole of heldRoles) {
				const blockingGrant = await access_control_db_role_file_grant_caller_cannot_give(ctx, {
					organization,
					defaultWorkspaceId,
					reach: { kind: "workspaces", joinedWorkspaceIds },
					role: heldRole,
					userId: userAuth.id,
				});
				if (blockingGrant) {
					return Result({
						_nay: {
							message: `You cannot invite this member: a role they already have is shared on a file you do not have "${access_control_PERMISSION_CATALOG[blockingGrant.permission].label}" on`,
						},
					});
				}
			}
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
			// The role is written on the default workspace only. That single assignment already works in
			// every workspace where the user is an active member, so a second one here would add
			// nothing. Worse, it would make a later per-workspace change look like it worked when it
			// did not.
			//
			// Never for the owner: an owner has no role assignment, and every check answers "owner"
			// before it reads one. This case can really happen, because the membership insert above is
			// conditional while this write is not. So inviting the owner into a workspace they are not
			// in would leave them a stray `member` doc and quietly break that rule.
			userIdToAdd === organization.ownerUserId
				? null
				: access_control_db_ensure_role_assignment(ctx, {
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
				resource: { kind: "organization", id: String(organization._id) },
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

		// We include inactive memberships on purpose. A user whose account is being deleted has all of
		// their memberships turned off. Skipping those would leave the membership, the API keys, and
		// the quota docs in place, so restoring the account would put them back in this organization.
		const memberships = await ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_user_organization_workspace_active", (q) =>
				q.eq("userId", args.userIdToRemove).eq("organizationId", organization._id),
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
		const publicApiGrantsPromise = Promise.all(
			memberships.map((membership) =>
				ctx.db
					.query("public_api_grants")
					.withIndex("by_organization_workspace_user", (q) =>
						q
							.eq("organizationId", organization._id)
							.eq("workspaceId", membership.workspaceId)
							.eq("userId", args.userIdToRemove),
					)
					.collect(),
			),
		);
		const pluginUiSessionsPromise = Promise.all(
			memberships.map((membership) =>
				ctx.db
					.query("plugins_ui_sessions")
					.withIndex("by_organization_workspace_user", (q) =>
						q
							.eq("organizationId", organization._id)
							.eq("workspaceId", membership.workspaceId)
							.eq("userId", args.userIdToRemove),
					)
					.collect(),
			),
		);
		const pluginServiceGrantsPromise = Promise.all(
			memberships.map((membership) =>
				ctx.db
					.query("plugin_service_grants")
					.withIndex("by_organization_workspace_actorUser", (q) =>
						q
							.eq("organizationId", organization._id)
							.eq("workspaceId", membership.workspaceId)
							.eq("actorUserId", args.userIdToRemove),
					)
					.collect(),
			),
		);
		const pluginDataMemberUsagePromise = Promise.all(
			memberships.map((membership) =>
				ctx.db
					.query("plugins_data_member_usage")
					.withIndex("by_organization_workspace_user", (q) =>
						q
							.eq("organizationId", organization._id)
							.eq("workspaceId", membership.workspaceId)
							.eq("userId", args.userIdToRemove),
					)
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
			// Re-inviting this user must not restore public API grants, plugin UI sessions, or the service
			// grants those sessions were exchanged for. A service grant lives 24 hours, so without this a
			// removal reversed the same day would hand the service its old authority back.
			publicApiGrantsPromise.then((grants) =>
				Promise.all(grants.flat().map((grant) => ctx.db.delete("public_api_grants", grant._id))),
			),
			pluginUiSessionsPromise.then((sessions) =>
				Promise.all(sessions.flat().map((session) => ctx.db.delete("plugins_ui_sessions", session._id))),
			),
			pluginServiceGrantsPromise.then((grants) =>
				Promise.all(grants.flat().map((grant) => ctx.db.delete("plugin_service_grants", grant._id))),
			),
			// A per-member plugin storage row names the member, so it must not outlive their membership.
			// The documents it counted stay: they belong to the workspace, and the counters they fed are
			// installation-wide. A later credit that names this member finds no row and does nothing.
			pluginDataMemberUsagePromise.then((rows) =>
				Promise.all(rows.flat().map((row) => ctx.db.delete("plugins_data_member_usage", row._id))),
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
				.withIndex("by_organization_user_workspace", (q) =>
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
			// We trust only `organization.defaultWorkspaceId`, never the `default` flag on the workspace
			// doc. The check below treats this id as the place where organization roles work. If we
			// accepted any workspace that calls itself default, a role that exists only in that
			// workspace could claim organization-wide power.
			organization.defaultWorkspaceId !== defaultWorkspace._id ||
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
				resource: { kind: "organization", id: String(organization._id) },
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

		const defaultWorkspaceId = organization.defaultWorkspaceId;
		if (!defaultWorkspaceId) {
			const errorMessage = "organization.defaultWorkspaceId is not set";
			const errorData = { organizationId: organization._id };
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}

		// The permission check does not verify membership, so we do it here. Otherwise a user whose
		// memberships were turned off for account deletion could still change who pays.
		const homeMembership = await ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_active_user_organization_workspace", (q) =>
				q
					.eq("active", true)
					.eq("userId", userAuth.id)
					.eq("organizationId", organization._id)
					.eq("workspaceId", defaultWorkspaceId),
			)
			.first();
		if (!homeMembership) {
			return Result({ _nay: { message: "Permission denied" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "organizations_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const canManageBilling = await access_control_db_has_permission(ctx, {
			organizationId: organization._id,
			workspaceId: defaultWorkspaceId,
			defaultWorkspaceId,
			organizationOwnerUserId: organization.ownerUserId,
			resource: { kind: "organization", id: String(organization._id) },
			permission: "organization.billing.manage",
			userId: userAuth.id,
		});
		if (!canManageBilling) {
			return Result({ _nay: { message: "Permission denied" } });
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
			// Same rule as `edit_organization`: the default workspace comes from the organization doc,
			// not from a workspace that says it is the default one.
			organization.defaultWorkspaceId !== defaultWorkspace._id ||
			!defaultWorkspaceMembership
		) {
			return Result({
				_nay: {
					message: "Not found",
				},
			});
		}

		// An organization role works in a workspace only while the caller is a member of it, so a
		// non-member gets "Not found". The owner is the exception: they own every workspace in the
		// organization, joined or not, and `delete_workspace` already lets them through the same way.
		// Without this the owner could delete a workspace another member made but could not rename it.
		if (!workspaceMembership && organization.ownerUserId !== userAuth.id) {
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
				resource: { kind: "workspace", id: String(workspace._id) },
				permission: "workspace.update",
				userId: userAuth.id,
			})) &&
			!(await access_control_db_has_permission(ctx, {
				organizationId: organization._id,
				workspaceId: defaultWorkspace._id,
				defaultWorkspaceId: defaultWorkspace._id,
				organizationOwnerUserId: organization.ownerUserId,
				resource: { kind: "organization", id: String(organization._id) },
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

		// We trust only `organization.defaultWorkspaceId`, never the `default` flag on the workspace doc.
		// Two sources of truth can disagree, and this one decides where organization roles work.
		if (workspace._id === organization.defaultWorkspaceId) {
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
				.withIndex("by_organization_workspace_user", (q) => q.eq("organizationId", organization._id))
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
			ctx.db
				.query("access_control_roles")
				.withIndex("by_organization_normalizedName", (q) => q.eq("organizationId", organization._id))
				.collect()
				.then((docs) => Promise.all(docs.map((doc) => ctx.db.delete("access_control_roles", doc._id)))),
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

		// Same as `edit_workspace`: the default workspace comes from the organization doc, not from the
		// `default` flag on the workspace doc.
		if (workspace._id === organization.defaultWorkspaceId) {
			return Result({
				_nay: {
					message: "Cannot delete the default workspace",
				},
			});
		}

		// The organization role works in a workspace only while the caller is a member of it, and
		// the permission check does not verify that. Handlers that use
		// `access_control_db_authorize_membership` pass it a membership doc. This handler builds the
		// ids itself, so it has to check membership here.
		const isWorkspaceMember =
			organization.ownerUserId === userAuth.id ||
			workspaceUserLookup.some((workspaceUser) => workspaceUser.userId === userAuth.id && workspaceUser.active);

		if (
			!isWorkspaceMember ||
			!(await access_control_db_has_permission(ctx, {
				organizationId: organization._id,
				workspaceId: workspace._id,
				defaultWorkspaceId: organizationUserLookup.workspaceId,
				organizationOwnerUserId: organization.ownerUserId,
				resource: { kind: "workspace", id: String(workspace._id) },
				permission: "workspace.delete",
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
				// Upload budgets stay until the delayed content purge drains targets and late R2 events.
				.withIndex("by_workspace_quotaName", (q) =>
					q.eq("workspaceId", workspace._id).eq("quotaName", "active_api_credentials"),
				)
				.collect()
				.then((docs) => Promise.all(docs.map((doc) => ctx.db.delete("quotas", doc._id)))),
			ctx.db
				.query("access_control_role_assignments")
				.withIndex("by_organization_workspace_user", (q) =>
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
