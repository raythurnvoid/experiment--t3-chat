import { v, type Infer } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { doc } from "convex-helpers/validators";
import { Result } from "common/errors-as-values-utils.ts";

import type { Doc, Id } from "./_generated/dataModel.js";
import { query, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import { mutation } from "./functions.ts";
import app_convex_schema from "./schema.ts";
import { access_control_db_caller_cannot_share_with_role, access_control_db_has_permission } from "./access_control.ts";
import { access_control_changes_db_record } from "./access_control_changes.ts";
import { organizations_db_get_membership } from "./organizations.ts";
import { organizations_membership_lifetimes_db_ensure } from "./organizations_membership_lifetimes.ts";
import {
	plugins_scheduled_access_db_validate_consent,
	plugins_scheduled_access_db_validate_grant,
} from "./plugins_scheduled_access.ts";
import { plugins_schedules_db_cancel } from "./plugins_schedules_db.ts";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";
import { access_control_is_system_role } from "../shared/access-control.ts";
import { should_never_happen } from "../shared/shared-utils.ts";
import { server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";
import { convex_error, v_result } from "../server/convex-utils.ts";

export const experimental_reuseContext = true;

const MAX_MANAGEMENT_PRINCIPALS = 50;
const MAX_ROLE_MANAGEMENT_RESOURCES = 50;

const management_access_validator = v.union(v.literal("owner"), v.literal("selected"), v.literal("workspace"));
const management_principal_validator = v.union(
	v.object({ kind: v.literal("user"), userId: v.id("users") }),
	v.object({ kind: v.literal("role"), role: doc(app_convex_schema, "access_control_role_assignments").fields.role }),
);
const run_as_scope_validator = v.union(
	v.literal("files:list"),
	v.literal("files:read"),
	v.literal("plugin_data:read"),
	v.literal("plugin_data:write"),
	v.literal("volumes:write"),
	v.literal("secrets:read"),
	v.literal("outbound:fetch"),
);
const files_read_proof_validator = v.union(
	v.object({ kind: v.literal("workspace") }),
	v.object({ kind: v.literal("file"), nodeId: v.id("files_nodes") }),
);

function principal_key(principal: Infer<typeof management_principal_validator>) {
	return principal.kind === "user" ? `user:${principal.userId}` : `role:${principal.role}`;
}

export async function plugins_access_db_authorize_membership(
	ctx: QueryCtx | MutationCtx,
	args: {
		userId: Id<"users">;
		membershipId: Id<"organizations_workspaces_users">;
		installationId?: Id<"plugins_workspace_installations">;
	},
) {
	const user = await ctx.db.get("users", args.userId);
	if (!user || user.deletedAt !== undefined) return Result({ _nay: { message: "Unauthenticated" } });
	const membership = await organizations_db_get_membership(ctx, args);
	if (!membership || membership.pendingOrganizationRemoval === true)
		return Result({ _nay: { message: "Unauthorized" } });
	const [organization, workspace, installation] = await Promise.all([
		ctx.db.get("organizations", membership.organizationId),
		ctx.db.get("organizations_workspaces", membership.workspaceId),
		args.installationId ? ctx.db.get("plugins_workspace_installations", args.installationId) : null,
	]);
	if (!organization?.defaultWorkspaceId)
		throw should_never_happen("organization.defaultWorkspaceId is not set", {
			organizationId: membership.organizationId,
		});
	if (
		!workspace ||
		workspace.organizationId !== organization._id ||
		(args.installationId &&
			(!installation || installation.organizationId !== organization._id || installation.workspaceId !== workspace._id))
	)
		return Result({ _nay: { message: "Not found" } });
	if (workspace.pluginDataPurgeStartedAt !== undefined)
		return Result({ _nay: { message: "Workspace cleanup is in progress" } });
	return Result({
		_yay: { membership, organization, workspace, installation, defaultWorkspaceId: organization.defaultWorkspaceId },
	});
}

export async function plugins_access_db_authorize_management(
	ctx: QueryCtx | MutationCtx,
	args: {
		userId: Id<"users">;
		membershipId: Id<"organizations_workspaces_users">;
		installationId?: Id<"plugins_workspace_installations">;
	},
) {
	const context = await plugins_access_db_authorize_membership(ctx, args);
	if (context._nay) return context;
	const { organization, workspace, installation, defaultWorkspaceId } = context._yay;
	const allowed = await access_control_db_has_permission(ctx, {
		organizationId: organization._id,
		workspaceId: workspace._id,
		defaultWorkspaceId,
		organizationOwnerUserId: organization.ownerUserId,
		resource: installation
			? { kind: "plugin_installation", id: installation._id }
			: { kind: "workspace", id: workspace._id },
		permission: "workspace.plugins.manage",
		userId: args.userId,
	});
	return allowed ? context : Result({ _nay: { message: "Permission denied" } });
}

function db_get_management_grants(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		installationId?: Id<"plugins_workspace_installations">;
	},
) {
	return ctx.db
		.query("access_control_permission_grants")
		.withIndex("by_resource_permission", (q) =>
			q
				.eq("organizationId", args.organizationId)
				.eq("workspaceId", args.workspaceId)
				.eq("resourceKind", args.installationId ? "plugin_installation" : "workspace")
				.eq("resourceId", args.installationId ?? args.workspaceId)
				.eq("permission", "workspace.plugins.manage"),
		)
		.take(MAX_MANAGEMENT_PRINCIPALS + 1);
}

function read_management_principal(grant: Doc<"access_control_permission_grants">) {
	if (grant.principalKind === "user" && grant.userId) return { kind: "user" as const, userId: grant.userId };
	if (grant.principalKind === "role" && grant.role) return { kind: "role" as const, role: grant.role };
	return null;
}

async function db_update_management_access(
	ctx: MutationCtx,
	args: {
		userId: Id<"users">;
		organization: Doc<"organizations">;
		defaultWorkspaceId: Id<"organizations_workspaces">;
		workspace: Doc<"organizations_workspaces">;
		installation: Doc<"plugins_workspace_installations"> | null;
		mode: Infer<typeof management_access_validator>;
		principals: Infer<typeof management_principal_validator>[];
	},
) {
	const principals = args.mode === "owner" ? [] : args.principals;
	if (principals.length > MAX_MANAGEMENT_PRINCIPALS)
		return Result({ _nay: { message: "Choose at most 50 people and roles" } });
	const keys = new Set<string>();
	const grants = await db_get_management_grants(ctx, {
		organizationId: args.organization._id,
		workspaceId: args.workspace._id,
		installationId: args.installation?._id,
	});
	if (grants.length > MAX_MANAGEMENT_PRINCIPALS)
		return Result({ _nay: { message: "This access list needs migration before it can be changed" } });
	const existingKeys = new Set(
		grants.flatMap((grant) => {
			const principal = read_management_principal(grant);
			return principal ? [principal_key(principal)] : [];
		}),
	);
	for (const principal of principals) {
		const key = principal_key(principal);
		if (keys.has(key)) return Result({ _nay: { message: "Choose each person or role once" } });
		keys.add(key);
		if (principal.kind === "user") {
			if (principal.userId === args.organization.ownerUserId)
				return Result({ _nay: { message: "The organization owner already has full access" } });
			const [membership, user] = await Promise.all([
				ctx.db
					.query("organizations_workspaces_users")
					.withIndex("by_active_user_organization_workspace", (q) =>
						q
							.eq("active", true)
							.eq("userId", principal.userId)
							.eq("organizationId", args.organization._id)
							.eq("workspaceId", args.workspace._id),
					)
					.first(),
				ctx.db.get("users", principal.userId),
			]);
			if (!membership || !user || user.deletedAt !== undefined)
				return Result({ _nay: { message: "This person is not a member of this workspace" } });
			continue;
		}
		if (!access_control_is_system_role(principal.role)) {
			const roleId = ctx.db.normalizeId("access_control_roles", principal.role);
			const role = roleId ? await ctx.db.get("access_control_roles", roleId) : null;
			if (!role || role.organizationId !== args.organization._id)
				return Result({ _nay: { message: "This role does not exist" } });
		}
		if (existingKeys.has(key)) continue;
		const blocked = await access_control_db_caller_cannot_share_with_role(ctx, {
			organization: args.organization,
			defaultWorkspaceId: args.defaultWorkspaceId,
			role: principal.role,
			userId: args.userId,
		});
		if (blocked) return Result({ _nay: blocked });
		const role = principal.role;
		const roleGrants = await ctx.db
			.query("access_control_permission_grants")
			.withIndex("by_organization_role_workspace_resource", (q) =>
				q.eq("organizationId", args.organization._id).eq("principalKind", "role").eq("role", role),
			)
			.filter((q) =>
				q.and(
					q.eq(q.field("permission"), "workspace.plugins.manage"),
					q.or(q.eq(q.field("resourceKind"), "workspace"), q.eq(q.field("resourceKind"), "plugin_installation")),
				),
			)
			.take(MAX_ROLE_MANAGEMENT_RESOURCES + 1);
		const resources = new Set(
			roleGrants.map((grant) => `${grant.workspaceId}:${grant.resourceKind}:${grant.resourceId}`),
		);
		if (resources.size >= MAX_ROLE_MANAGEMENT_RESOURCES)
			return Result({ _nay: { message: "This role is already on 50 plugin access lists. Choose people instead." } });
	}

	const now = Date.now();
	for (const grant of grants) {
		const principal = read_management_principal(grant);
		if (!principal || !keys.has(principal_key(principal)))
			await ctx.db.delete("access_control_permission_grants", grant._id);
	}
	for (const principal of principals) {
		if (existingKeys.has(principal_key(principal))) continue;
		await ctx.db.insert("access_control_permission_grants", {
			organizationId: args.organization._id,
			workspaceId: args.workspace._id,
			resourceKind: args.installation ? "plugin_installation" : "workspace",
			resourceId: args.installation?._id ?? args.workspace._id,
			principalKind: principal.kind,
			...(principal.kind === "user" ? { userId: principal.userId } : { role: principal.role }),
			permission: "workspace.plugins.manage",
			createdAt: now,
			updatedAt: now,
		});
	}
	if (args.installation)
		await ctx.db.patch("plugins_workspace_installations", args.installation._id, {
			managementAccess: args.mode,
			updatedBy: args.userId,
			updatedAt: now,
		});
	else
		await ctx.db.patch("organizations_workspaces", args.workspace._id, {
			pluginInstallAccess: args.mode,
			updatedAt: now,
		});
	await access_control_changes_db_record(ctx, [
		{
			scope: args.installation
				? { kind: "installation", installationId: args.installation._id }
				: { kind: "workspace", organizationId: args.organization._id, workspaceId: args.workspace._id },
			event: { kind: "refresh", reason: "permissions" },
		},
	]);
	return Result({ _yay: null });
}

export const get_workspace_install_access = query({
	args: { membershipId: v.id("organizations_workspaces_users") },
	returns: v.union(
		v.null(),
		v.object({
			canInstall: v.boolean(),
			canManageSettings: v.boolean(),
			mode: v.union(management_access_validator, v.null()),
			principals: v.array(management_principal_validator),
			organizationOwnerUserId: v.id("users"),
		}),
	),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) throw convex_error({ message: "Unauthenticated" });
		const context = await plugins_access_db_authorize_membership(ctx, { ...args, userId: userAuth.id });
		if (context._nay?.message === "Unauthenticated") throw convex_error(context._nay);
		if (context._nay) return null;
		const { organization, workspace, defaultWorkspaceId } = context._yay;
		const canManageSettings = organization.ownerUserId === userAuth.id;
		const canInstall = await access_control_db_has_permission(ctx, {
			organizationId: organization._id,
			workspaceId: workspace._id,
			defaultWorkspaceId,
			organizationOwnerUserId: organization.ownerUserId,
			resource: { kind: "workspace", id: workspace._id },
			permission: "workspace.plugins.manage",
			userId: userAuth.id,
		});
		const grants = canManageSettings
			? await db_get_management_grants(ctx, { organizationId: organization._id, workspaceId: workspace._id })
			: [];
		return {
			canInstall,
			canManageSettings,
			mode: canManageSettings ? workspace.pluginInstallAccess : null,
			principals: grants.flatMap((grant) => {
				const principal = read_management_principal(grant);
				return principal ? [principal] : [];
			}),
			organizationOwnerUserId: organization.ownerUserId,
		};
	},
});

export const update_workspace_install_access = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		mode: management_access_validator,
		principals: v.array(management_principal_validator),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) return Result({ _nay: { message: "Unauthenticated" } });
		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "plugins_manage", key: userAuth.id });
		if (rateLimit) return Result({ _nay: { message: rateLimit.message } });
		const context = await plugins_access_db_authorize_membership(ctx, { ...args, userId: userAuth.id });
		if (context._nay) return context;
		if (context._yay.organization.ownerUserId !== userAuth.id)
			return Result({ _nay: { message: "Only the organization owner can change plugin setup access" } });
		return await db_update_management_access(ctx, { ...context._yay, ...args, userId: userAuth.id });
	},
});

export const get_installation_access = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		installationId: v.id("plugins_workspace_installations"),
	},
	returns: v.union(
		v.null(),
		v.object({
			mode: management_access_validator,
			principals: v.array(management_principal_validator),
			organizationOwnerUserId: v.id("users"),
		}),
	),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) throw convex_error({ message: "Unauthenticated" });
		const context = await plugins_access_db_authorize_management(ctx, { ...args, userId: userAuth.id });
		if (context._nay?.message === "Unauthenticated") throw convex_error(context._nay);
		if (context._nay) return null;
		const { organization, workspace, installation } = context._yay;
		if (!installation) return null;
		const grants = await db_get_management_grants(ctx, {
			organizationId: organization._id,
			workspaceId: workspace._id,
			installationId: installation._id,
		});
		return {
			mode: installation.managementAccess,
			principals: grants.flatMap((grant) => {
				const principal = read_management_principal(grant);
				return principal ? [principal] : [];
			}),
			organizationOwnerUserId: organization.ownerUserId,
		};
	},
});

export const update_installation_access = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		installationId: v.id("plugins_workspace_installations"),
		mode: management_access_validator,
		principals: v.array(management_principal_validator),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) return Result({ _nay: { message: "Unauthenticated" } });
		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "plugins_manage", key: userAuth.id });
		if (rateLimit) return Result({ _nay: { message: rateLimit.message } });
		const context = await plugins_access_db_authorize_management(ctx, { ...args, userId: userAuth.id });
		if (context._nay) return context;
		return await db_update_management_access(ctx, { ...context._yay, ...args, userId: userAuth.id });
	},
});

function db_get_run_as_grant(
	ctx: QueryCtx | MutationCtx,
	args: { installation: Doc<"plugins_workspace_installations">; userId: Id<"users"> },
) {
	return ctx.db
		.query("access_control_permission_grants")
		.withIndex("by_organization_workspace_resource_user_permission", (q) =>
			q
				.eq("organizationId", args.installation.organizationId)
				.eq("workspaceId", args.installation.workspaceId)
				.eq("resourceKind", "plugin_installation")
				.eq("resourceId", args.installation._id)
				.eq("principalKind", "user")
				.eq("userId", args.userId)
				.eq("permission", "plugin.run_as"),
		)
		.unique();
}

// Both callers validate the human's consent before any setup writes.
export async function plugins_access_db_create_run_as_grant(
	ctx: MutationCtx,
	args: {
		membership: Doc<"organizations_workspaces_users">;
		installation: Doc<"plugins_workspace_installations">;
		scopes: Infer<typeof run_as_scope_validator>[];
	},
) {
	const previous = await db_get_run_as_grant(ctx, { installation: args.installation, userId: args.membership.userId });
	const lifetime = await organizations_membership_lifetimes_db_ensure(ctx, args.membership);
	const now = Date.now();
	await plugins_schedules_db_cancel(ctx, { installationId: args.installation._id, userId: args.membership.userId });
	if (previous) await ctx.db.delete("access_control_permission_grants", previous._id);
	const grantId = await ctx.db.insert("access_control_permission_grants", {
		organizationId: args.membership.organizationId,
		workspaceId: args.membership.workspaceId,
		resourceKind: "plugin_installation",
		resourceId: args.installation._id,
		principalKind: "user",
		userId: args.membership.userId,
		permission: "plugin.run_as",
		runAs: { membershipId: args.membership._id, membershipLifetime: lifetime, scopes: args.scopes },
		createdAt: now,
		updatedAt: now,
	});
	if (args.installation.scheduledRunUserId === args.membership.userId) {
		await ctx.db.patch("plugins_workspace_installations", args.installation._id, { scheduledRunGrantId: grantId });
		const handler = await ctx.db
			.query("plugins_workspace_event_handlers")
			.withIndex("by_installation", (q) => q.eq("installationId", args.installation._id))
			.filter((q) => q.eq(q.field("event"), "schedule.interval.elapsed"))
			.first();
		if (handler) await ctx.db.patch("plugins_workspace_event_handlers", handler._id, { nextRunAt: now });
	}
	return grantId;
}

export const get_my_run_as_grant = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		installationId: v.id("plugins_workspace_installations"),
	},
	returns: v.union(
		v.null(),
		v.object({
			pluginName: v.string(),
			displayName: v.string(),
			capabilities: doc(app_convex_schema, "plugins_versions").fields.capabilities,
			isAssigned: v.boolean(),
			grant: v.union(
				v.null(),
				v.object({
					grantId: v.id("access_control_permission_grants"),
					scopes: v.array(run_as_scope_validator),
					valid: v.boolean(),
				}),
			),
		}),
	),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) throw convex_error({ message: "Unauthenticated" });
		const context = await plugins_access_db_authorize_membership(ctx, { ...args, userId: userAuth.id });
		if (context._nay?.message === "Unauthenticated") throw convex_error(context._nay);
		if (context._nay || !context._yay.installation) return null;
		const installation = context._yay.installation;
		const version = await ctx.db.get("plugins_versions", installation.pluginVersionId);
		if (!version?.events.some((event) => event.type === "schedule.interval.elapsed")) return null;
		const grant = await db_get_run_as_grant(ctx, { installation, userId: userAuth.id });
		const validation = grant?.runAs
			? await plugins_scheduled_access_db_validate_grant(ctx, { installation, userId: userAuth.id, grantId: grant._id })
			: null;
		return {
			pluginName: installation.pluginName,
			displayName: version.displayName,
			capabilities: version.capabilities.filter((capability) => installation.acceptedCapabilities.includes(capability)),
			isAssigned: installation.scheduledRunUserId === userAuth.id,
			grant: grant?.runAs
				? { grantId: grant._id, scopes: grant.runAs.scopes, valid: validation?._nay === undefined }
				: null,
		};
	},
});

export const grant_run_as_me = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		installationId: v.id("plugins_workspace_installations"),
		scopes: v.array(run_as_scope_validator),
		filesReadProof: v.optional(files_read_proof_validator),
	},
	returns: v_result({ _yay: v.object({ grantId: v.id("access_control_permission_grants") }) }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) return Result({ _nay: { message: "Unauthenticated" } });
		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "plugins_manage", key: userAuth.id });
		if (rateLimit) return Result({ _nay: { message: rateLimit.message } });
		const context = await plugins_access_db_authorize_membership(ctx, { ...args, userId: userAuth.id });
		if (context._nay) return context;
		const { membership, installation } = context._yay;
		if (!installation) return Result({ _nay: { message: "Not found" } });
		const version = await ctx.db.get("plugins_versions", installation.pluginVersionId);
		if (!version) return Result({ _nay: { message: "Not found" } });
		const consent = await plugins_scheduled_access_db_validate_consent(ctx, {
			membership,
			version,
			installation,
			...args,
		});
		if (consent._nay) return consent;
		const grantId = await plugins_access_db_create_run_as_grant(ctx, { membership, installation, scopes: args.scopes });
		return Result({ _yay: { grantId } });
	},
});

export const revoke_run_as_me = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		installationId: v.id("plugins_workspace_installations"),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) return Result({ _nay: { message: "Unauthenticated" } });
		const context = await plugins_access_db_authorize_membership(ctx, { ...args, userId: userAuth.id });
		if (context._nay) return context;
		const { installation } = context._yay;
		if (!installation) return Result({ _nay: { message: "Not found" } });
		await plugins_schedules_db_cancel(ctx, { installationId: installation._id, userId: userAuth.id });
		const grant = await db_get_run_as_grant(ctx, { installation, userId: userAuth.id });
		if (grant) await ctx.db.delete("access_control_permission_grants", grant._id);
		if (installation.scheduledRunUserId === userAuth.id)
			await ctx.db.patch("plugins_workspace_installations", installation._id, { scheduledRunGrantId: undefined });
		return Result({ _yay: null });
	},
});

export const list_eligible_run_users = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		installationId: v.id("plugins_workspace_installations"),
		paginationOpts: paginationOptsValidator,
	},
	returns: v.object({
		page: v.array(
			v.object({
				userId: v.id("users"),
				grantId: v.id("access_control_permission_grants"),
				displayName: v.string(),
				scopes: v.array(run_as_scope_validator),
			}),
		),
		continueCursor: v.string(),
		isDone: v.boolean(),
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) throw convex_error({ message: "Unauthenticated" });
		const context = await plugins_access_db_authorize_management(ctx, { ...args, userId: userAuth.id });
		if (context._nay?.message === "Unauthenticated") throw convex_error(context._nay);
		if (context._nay || !context._yay.installation) return { page: [], continueCursor: "", isDone: true };
		const installation = context._yay.installation;
		const grants = await ctx.db
			.query("access_control_permission_grants")
			.withIndex("by_resource_permission", (q) =>
				q
					.eq("organizationId", installation.organizationId)
					.eq("workspaceId", installation.workspaceId)
					.eq("resourceKind", "plugin_installation")
					.eq("resourceId", installation._id)
					.eq("permission", "plugin.run_as"),
			)
			.paginate({ ...args.paginationOpts, numItems: Math.min(args.paginationOpts.numItems, 100) });
		const page = [];
		for (const grant of grants.page) {
			if (grant.principalKind !== "user" || !grant.userId || !grant.runAs) continue;
			const validated = await plugins_scheduled_access_db_validate_grant(ctx, {
				installation,
				userId: grant.userId,
				grantId: grant._id,
			});
			if (validated._nay) continue;
			const anagraphic = validated._yay.user.anagraphic
				? await ctx.db.get("users_anagraphics", validated._yay.user.anagraphic)
				: null;
			page.push({
				userId: grant.userId,
				grantId: grant._id,
				displayName: anagraphic?.displayName ?? "Workspace member",
				scopes: grant.runAs.scopes,
			});
		}
		return { page, continueCursor: grants.continueCursor, isDone: grants.isDone };
	},
});

export const set_scheduled_run_user = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		installationId: v.id("plugins_workspace_installations"),
		userId: v.id("users"),
		grantId: v.id("access_control_permission_grants"),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) return Result({ _nay: { message: "Unauthenticated" } });
		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "plugins_manage", key: userAuth.id });
		if (rateLimit) return Result({ _nay: { message: rateLimit.message } });
		const context = await plugins_access_db_authorize_management(ctx, { ...args, userId: userAuth.id });
		if (context._nay) return context;
		const installation = context._yay.installation;
		if (!installation) return Result({ _nay: { message: "Not found" } });
		const version = await ctx.db.get("plugins_versions", installation.pluginVersionId);
		if (!version?.events.some((event) => event.type === "schedule.interval.elapsed"))
			return Result({ _nay: { message: "This plugin does not have a schedule" } });
		const grant = await plugins_scheduled_access_db_validate_grant(ctx, {
			installation,
			userId: args.userId,
			grantId: args.grantId,
		});
		if (grant._nay) return grant;
		await plugins_schedules_db_cancel(ctx, { installationId: installation._id });
		const now = Date.now();
		await ctx.db.patch("plugins_workspace_installations", installation._id, {
			scheduledRunUserId: args.userId,
			scheduledRunGrantId: args.grantId,
			updatedBy: userAuth.id,
			updatedAt: now,
		});
		const handler = await ctx.db
			.query("plugins_workspace_event_handlers")
			.withIndex("by_installation", (q) => q.eq("installationId", installation._id))
			.filter((q) => q.eq(q.field("event"), "schedule.interval.elapsed"))
			.first();
		if (handler) await ctx.db.patch("plugins_workspace_event_handlers", handler._id, { nextRunAt: now });
		return Result({ _yay: null });
	},
});
