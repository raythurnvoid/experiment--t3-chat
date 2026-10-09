import { Result } from "common/errors-as-values-utils.ts";

import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import {
	access_control_db_authorize_membership,
	access_control_db_authorize_node,
	access_control_db_has_permission,
} from "./access_control.ts";
import { plugins_db_get_live_service_account } from "./plugins_service_accounts.ts";
import type { plugins_Capability } from "../shared/plugins.ts";

type RunAsScope = NonNullable<Doc<"access_control_permission_grants">["runAs"]>["scopes"][number];

const SCOPE_CAPABILITIES: Record<RunAsScope, plugins_Capability> = {
	"files:list": "workspace.files.read",
	"files:read": "workspace.files.read",
	"plugin_data:read": "plugin.data.read",
	"plugin_data:write": "plugin.data.write",
	"volumes:write": "workspace.volumes.write",
	"secrets:read": "plugin.secrets.read",
	"outbound:fetch": "outbound.fetch",
};

export async function plugins_scheduled_access_db_validate_grant(
	ctx: QueryCtx | MutationCtx,
	args: {
		installation: Doc<"plugins_workspace_installations">;
		userId: Id<"users">;
		grantId: Id<"access_control_permission_grants">;
	},
) {
	const { installation, userId, grantId } = args;
	const [grant, user, organization, workspace, lifetime] = await Promise.all([
		ctx.db.get("access_control_permission_grants", grantId),
		ctx.db.get("users", userId),
		ctx.db.get("organizations", installation.organizationId),
		ctx.db.get("organizations_workspaces", installation.workspaceId),
		ctx.db
			.query("organizations_membership_lifetimes")
			.withIndex("by_workspace_user", (q) => q.eq("workspaceId", installation.workspaceId).eq("userId", userId))
			.first(),
	]);
	if (
		!grant?.runAs ||
		grant.permission !== "plugin.run_as" ||
		grant.principalKind !== "user" ||
		grant.userId !== userId ||
		grant.resourceKind !== "plugin_installation" ||
		grant.resourceId !== installation._id ||
		grant.organizationId !== installation.organizationId ||
		grant.workspaceId !== installation.workspaceId ||
		!user ||
		user.deletedAt !== undefined ||
		!organization?.defaultWorkspaceId ||
		!workspace ||
		workspace.organizationId !== organization._id ||
		workspace.pluginDataPurgeStartedAt !== undefined ||
		!lifetime?.active ||
		lifetime.membershipId !== grant.runAs.membershipId ||
		lifetime.lifetime !== grant.runAs.membershipLifetime
	)
		return Result({ _nay: { message: "The scheduled user must grant access again" } });
	const membership = await ctx.db.get("organizations_workspaces_users", grant.runAs.membershipId);
	if (
		!membership?.active ||
		membership.pendingOrganizationRemoval ||
		membership.userId !== userId ||
		membership.organizationId !== organization._id ||
		membership.workspaceId !== workspace._id
	)
		return Result({ _nay: { message: "The scheduled user is not an active workspace member" } });
	return Result({ _yay: { grant, membership, user, organization, workspace } });
}

export async function plugins_scheduled_access_db_authorize_assignment(
	ctx: QueryCtx | MutationCtx,
	args: {
		installation: Doc<"plugins_workspace_installations">;
		run?: Doc<"plugins_event_runs">;
		requiredScope?: RunAsScope;
	},
) {
	const { installation, run, requiredScope } = args;
	if (installation.status !== "enabled" || !installation.scheduledRunUserId || !installation.scheduledRunGrantId)
		return Result({ _nay: { message: "Choose a scheduled user with their own permission grant" } });
	const context = await plugins_scheduled_access_db_validate_grant(ctx, {
		installation,
		userId: installation.scheduledRunUserId,
		grantId: installation.scheduledRunGrantId,
	});
	if (context._nay) return context;
	const { grant, membership, organization } = context._yay;
	const [version, account, owner, deletionFence] = await Promise.all([
		ctx.db.get("plugins_versions", installation.pluginVersionId),
		plugins_db_get_live_service_account(ctx, { installation, serviceAccountId: installation.serviceAccountId }),
		ctx.db.get("users", organization.ownerUserId),
		ctx.db
			.query("plugins_registry_deletion_fences")
			.withIndex("by_pluginName", (q) => q.eq("pluginName", installation.pluginName))
			.first(),
	]);
	// Registry deletion disables installations in batches. The fence blocks the rest immediately.
	if (
		deletionFence ||
		!version ||
		!account ||
		!owner ||
		owner.deletedAt !== undefined ||
		!version.events.some((event) => event.type === "schedule.interval.elapsed") ||
		!version.capabilities.includes("plugin.schedule.run") ||
		!installation.acceptedCapabilities.includes("plugin.schedule.run")
	)
		return Result({ _nay: { message: "This schedule is not available" } });
	if (
		run &&
		(run.event !== "schedule.interval.elapsed" ||
			run.installationId !== installation._id ||
			run.organizationId !== organization._id ||
			run.workspaceId !== installation.workspaceId ||
			run.pluginVersionId !== version._id ||
			run.serviceAccountId !== account._id ||
			run.actorUserId !== installation.scheduledRunUserId ||
			run.runAsGrantId !== grant._id ||
			run.runAsMembershipId !== membership._id ||
			run.runAsMembershipLifetime !== grant.runAs!.membershipLifetime ||
			!run.acceptedCapabilities.includes("plugin.schedule.run"))
	)
		return Result({ _nay: { message: "The scheduled assignment changed" } });
	if (requiredScope) {
		const capability = SCOPE_CAPABILITIES[requiredScope];
		if (
			!grant.runAs!.scopes.includes(requiredScope) ||
			!version.capabilities.includes(capability) ||
			!installation.acceptedCapabilities.includes(capability) ||
			(run && !run.acceptedCapabilities.includes(capability))
		)
			return Result({ _nay: { message: "Permission denied" } });
		if (requiredScope === "plugin_data:read" || requiredScope === "plugin_data:write") {
			const allowed = await access_control_db_authorize_membership(ctx, {
				userAuth: { id: membership.userId },
				membership,
				permission: requiredScope === "plugin_data:write" ? "content.write" : "content.read",
			});
			if (allowed._nay) return allowed;
		} else if (
			requiredScope === "volumes:write" ||
			requiredScope === "secrets:read" ||
			requiredScope === "outbound:fetch"
		) {
			const allowed = await access_control_db_has_permission(ctx, {
				organizationId: organization._id,
				workspaceId: installation.workspaceId,
				defaultWorkspaceId: organization.defaultWorkspaceId!,
				organizationOwnerUserId: organization.ownerUserId,
				resource: { kind: "plugin_installation", id: installation._id },
				permission: "workspace.plugins.manage",
				userId: membership.userId,
			});
			if (!allowed) return Result({ _nay: { message: "Permission denied" } });
		}
		// Files callers check the actual nodes against the user and installation account.
	}
	return Result({ _yay: { ...context._yay, version, account } });
}

export async function plugins_scheduled_access_db_validate_consent(
	ctx: QueryCtx | MutationCtx,
	args: {
		membership: Doc<"organizations_workspaces_users">;
		version: Doc<"plugins_versions">;
		installation?: Doc<"plugins_workspace_installations">;
		scopes: RunAsScope[];
		filesReadProof?: { kind: "workspace" } | { kind: "file"; nodeId: Id<"files_nodes"> };
	},
) {
	const { membership, version, installation, scopes, filesReadProof } = args;
	const [user, organization, workspace] = await Promise.all([
		ctx.db.get("users", membership.userId),
		ctx.db.get("organizations", membership.organizationId),
		ctx.db.get("organizations_workspaces", membership.workspaceId),
	]);
	if (!user || user.deletedAt !== undefined) return Result({ _nay: { message: "Unauthenticated" } });
	if (
		!membership.active ||
		membership.pendingOrganizationRemoval ||
		!organization?.defaultWorkspaceId ||
		!workspace ||
		workspace.organizationId !== organization._id ||
		workspace.pluginDataPurgeStartedAt !== undefined ||
		(installation && (installation.organizationId !== organization._id || installation.workspaceId !== workspace._id))
	)
		return Result({ _nay: { message: "Unauthorized" } });
	if (!version.events.some((event) => event.type === "schedule.interval.elapsed"))
		return Result({ _nay: { message: "This plugin does not have a schedule" } });
	if (new Set(scopes).size !== scopes.length) return Result({ _nay: { message: "Choose each permission once" } });
	if (scopes.includes("plugin_data:write") && !scopes.includes("plugin_data:read"))
		return Result({ _nay: { message: "Plugin data write also needs plugin data read" } });
	for (const scope of scopes) {
		const capability = SCOPE_CAPABILITIES[scope];
		if (
			!version.capabilities.includes(capability) ||
			(installation && !installation.acceptedCapabilities.includes(capability))
		)
			return Result({ _nay: { message: "This plugin has not been granted that permission" } });
	}
	if (scopes.includes("files:read") || scopes.includes("files:list")) {
		if (!filesReadProof) return Result({ _nay: { message: "Choose a readable file or workspace as proof" } });
		if (filesReadProof.kind === "file") {
			const allowed = await access_control_db_authorize_node(ctx, {
				userAuth: { id: membership.userId },
				membership,
				nodeId: filesReadProof.nodeId,
				permission: "content.read",
			});
			if (allowed._nay) return allowed;
			if (allowed._yay.fileNode.archiveOperationId !== null)
				return Result({ _nay: { message: "Choose a saved file that is not archived" } });
		} else {
			const allowed = await access_control_db_authorize_membership(ctx, {
				userAuth: { id: membership.userId },
				membership,
				permission: "content.read",
			});
			if (allowed._nay) return allowed;
		}
	}
	for (const scope of ["plugin_data:read", "plugin_data:write"] as const) {
		if (!scopes.includes(scope)) continue;
		const allowed = await access_control_db_authorize_membership(ctx, {
			userAuth: { id: membership.userId },
			membership,
			permission: scope === "plugin_data:write" ? "content.write" : "content.read",
		});
		if (allowed._nay) return allowed;
	}
	if (
		installation &&
		scopes.some((scope) => scope === "volumes:write" || scope === "secrets:read" || scope === "outbound:fetch")
	) {
		const allowed = await access_control_db_has_permission(ctx, {
			organizationId: organization._id,
			workspaceId: workspace._id,
			defaultWorkspaceId: organization.defaultWorkspaceId,
			organizationOwnerUserId: organization.ownerUserId,
			resource: { kind: "plugin_installation", id: installation._id },
			permission: "workspace.plugins.manage",
			userId: membership.userId,
		});
		if (!allowed) return Result({ _nay: { message: "Permission denied" } });
	}
	return Result({ _yay: null });
}
