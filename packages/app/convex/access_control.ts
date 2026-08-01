import { v } from "convex/values";
import { doc } from "convex-helpers/validators";

import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import {
	access_control_ENFORCED_PERMISSIONS,
	access_control_is_system_role,
	access_control_MAX_ROLE_DESCRIPTION_LENGTH,
	access_control_MAX_ROLE_NAME_LENGTH,
	access_control_PERMISSION_CATALOG,
	access_control_RESERVED_ROLE_NAMES,
	access_control_SYSTEM_ROLE_MATRIX,
	type access_control_DisplayRole,
	type access_control_Permission,
	type access_control_ResourceKind,
	type access_control_RoleRef,
} from "../shared/access-control.ts";
import { Result } from "common/errors-as-values-utils.ts";
import { quotas_db_get } from "./quotas.ts";
import { v_result } from "../server/convex-utils.ts";
import { server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";
import app_convex_schema from "./schema.ts";
import { should_never_happen } from "../shared/shared-utils.ts";

// Make Convex reuse the loaded module between calls, so warm calls skip the module load cost.
// Does NOT work for http actions (see http.ts). No mutable module-level state allowed here.
export const experimental_reuseContext = true;

/** Most custom roles an organization may define. */
const MAX_CUSTOM_ROLES = 20;

/**
 * How many assignments of one role we ever load at once.
 *
 * `list_roles` uses it as the highest value of `assignmentCount`, so a very large organization cannot
 * slow down the page. When a role has more assignments than this, `delete_role` refuses instead of
 * deleting only the first page of them.
 */
const MAX_ROLE_ASSIGNMENT_COUNT = 100;

/**
 * The thing a permission is checked against.
 *
 * For `file`, `restrictedScopeNodeId` points to the nearest restricted folder above the node, or to
 * the node itself, or is `null` when the node uses normal workspace access. So callers must not build
 * this object by hand: pass the loaded node to `access_control_db_authorize_membership` and let it
 * fill in the ids. See `access_control_permission_grants.resourceId` in the schema for where a file
 * grant is stored.
 *
 * When the scope is `null`, the check still looks for a grant on the node itself before it falls back
 * to the caller's role. It never uses a `workspace` grant for a file. Sharing writes its grants on the
 * restricted node, so that lookup only finds something for a node that is itself restricted.
 */
export type access_control_Resource =
	| { kind: "organization"; id: string }
	| { kind: "workspace"; id: string }
	| { kind: "file"; id: string; restrictedScopeNodeId: Id<"files_nodes"> | null };

const display_role_validator = v.union(
	v.null(),
	v.object({ kind: v.literal("owner") }),
	v.object({
		kind: v.literal("system"),
		// Written by hand: when you add a role to `access_control_SYSTEM_ROLE_MATRIX`, add it here too.
		role: v.union(v.literal("admin"), v.literal("member"), v.literal("viewer")),
	}),
	v.object({
		kind: v.literal("custom"),
		roleId: v.id("access_control_roles"),
		name: v.string(),
	}),
);

const permission_validator = doc(app_convex_schema, "access_control_permission_grants").fields.permission;

// #region Role resolution

/**
 * The permissions a role gives, or `null` when the role does not exist.
 *
 * System roles come from the matrix written in code. Custom roles come from their doc in the
 * database. A reference to a custom role that was deleted gives nothing; it does not fall back to
 * any other role.
 */
async function resolve_role_permissions(
	ctx: QueryCtx | MutationCtx,
	args: { organizationId: Id<"organizations">; role: access_control_RoleRef },
): Promise<readonly access_control_Permission[] | null> {
	if (access_control_is_system_role(args.role)) {
		return access_control_SYSTEM_ROLE_MATRIX[args.role].permissions;
	}

	const roleId = ctx.db.normalizeId("access_control_roles", args.role);
	if (!roleId) {
		return null;
	}

	const role = await ctx.db.get("access_control_roles", roleId);
	if (!role) {
		return null;
	}

	if (role.organizationId !== args.organizationId) {
		console.error("Role assignment references a custom role from another organization", {
			organizationId: args.organizationId,
			roleId,
			roleOrganizationId: role.organizationId,
		});
		return null;
	}

	return role.permissions;
}

/**
 * The first file grant carried by a role that the caller could not hand out on its own.
 *
 * A role is not only its permission list. A share list can name a role, and from then on holding
 * that role opens the restricted node. `resolve_role_permissions` never sees those grants, so the
 * permission ceiling in `set_user_role` cannot see them either: without this, somebody whose role
 * only manages members could hand out a payroll folder they cannot open themselves, just by
 * assigning the role it was shared with.
 *
 * A role given on the default workspace is the organization role and works in every workspace, so
 * that case has to weigh grants from every workspace, not only the one being written. Each grant is
 * judged in the workspace it lives in, so a caller who is not a member there simply fails the check
 * — which is right: nobody hands out access where they have none.
 */
export async function access_control_db_role_file_grant_caller_cannot_give(
	ctx: QueryCtx | MutationCtx,
	args: {
		organization: Doc<"organizations">;
		defaultWorkspaceId: Id<"organizations_workspaces">;
		workspaceId: Id<"organizations_workspaces">;
		role: access_control_RoleRef;
		userId: Id<"users">;
	},
) {
	const isDefaultWorkspace = args.workspaceId === args.defaultWorkspaceId;
	const grants = await ctx.db
		.query("access_control_permission_grants")
		.withIndex("by_organization_role_workspace_resource", (q) => {
			const byRole = q.eq("organizationId", args.organization._id).eq("principalKind", "role").eq("role", args.role);
			return isDefaultWorkspace ? byRole : byRole.eq("workspaceId", args.workspaceId);
		})
		.collect();

	for (const grant of grants) {
		if (grant.resourceKind !== "file") {
			continue;
		}

		// `resourceId` on a file grant is always the restricted scope node's own id, so it is both the
		// resource and its scope. A node that is gone, or open again, makes the grant give nothing, and
		// `access_control_db_has_permission` already answers that by falling back to workspace access.
		const scopeNodeId = ctx.db.normalizeId("files_nodes", grant.resourceId);
		if (!scopeNodeId) {
			continue;
		}

		const allowed = await access_control_db_has_permission(ctx, {
			organizationId: args.organization._id,
			workspaceId: grant.workspaceId,
			defaultWorkspaceId: args.defaultWorkspaceId,
			organizationOwnerUserId: args.organization.ownerUserId,
			resource: { kind: "file", id: grant.resourceId, restrictedScopeNodeId: scopeNodeId },
			permission: grant.permission,
			userId: args.userId,
		});
		if (!allowed) {
			return grant;
		}
	}

	return null;
}

function db_get_role_assignment(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
	},
) {
	return ctx.db
		.query("access_control_role_assignments")
		.withIndex("by_organization_workspace_user", (q) =>
			q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("userId", args.userId),
		)
		.first();
}

function db_get_active_membership(
	ctx: QueryCtx | MutationCtx,
	args: {
		userId: Id<"users">;
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
	},
) {
	return ctx.db
		.query("organizations_workspaces_users")
		.withIndex("by_active_user_organization_workspace", (q) =>
			q
				.eq("active", true)
				.eq("userId", args.userId)
				.eq("organizationId", args.organizationId)
				.eq("workspaceId", args.workspaceId),
		)
		.first();
}

/**
 * The roles that apply to a user in one workspace: the role they have in that workspace, plus their
 * organization role, which is stored on the default workspace.
 */
async function resolve_role_refs(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		defaultWorkspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
	},
) {
	const [workspaceAssignment, defaultAssignment] = await Promise.all([
		db_get_role_assignment(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
		}),
		args.workspaceId === args.defaultWorkspaceId
			? null
			: db_get_role_assignment(ctx, {
					organizationId: args.organizationId,
					workspaceId: args.defaultWorkspaceId,
					userId: args.userId,
				}),
	]);

	const refs: access_control_RoleRef[] = [];
	if (workspaceAssignment) {
		refs.push(workspaceAssignment.role);
	}
	if (defaultAssignment && defaultAssignment.role !== workspaceAssignment?.role) {
		refs.push(defaultAssignment.role);
	}
	return refs;
}

/**
 * Every permission a user has inside one workspace. `"all"` means the user is the organization owner.
 *
 * This function does not check that the user is a member of the workspace; the caller must do that.
 * `access_control_db_has_permission` is almost the same, but it does check membership in one case: a
 * workspace-scoped permission that arrives from the organization role, which otherwise would
 * reach workspaces the user does not belong to. This function skips that check, so every caller that
 * lets a user *do* something must prove membership first. The one caller that does not need to is the
 * "would this role change anything" test in `set_user_role`: it only asks what a user already has.
 *
 * Grants given to one user on one file are left out on purpose: such a grant gives no power over
 * roles.
 */
export async function access_control_db_resolve_effective_permissions(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		defaultWorkspaceId: Id<"organizations_workspaces">;
		organizationOwnerUserId: Id<"users">;
		userId: Id<"users">;
	},
): Promise<ReadonlySet<access_control_Permission> | "all"> {
	if (args.userId === args.organizationOwnerUserId) {
		return "all";
	}

	const isDefaultWorkspace = args.workspaceId === args.defaultWorkspaceId;
	const [workspaceAssignment, defaultAssignment] = await Promise.all([
		db_get_role_assignment(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
		}),
		isDefaultWorkspace
			? null
			: db_get_role_assignment(ctx, {
					organizationId: args.organizationId,
					workspaceId: args.defaultWorkspaceId,
					userId: args.userId,
				}),
	]);

	const permissions = new Set<access_control_Permission>();

	if (workspaceAssignment) {
		const workspacePermissions = await resolve_role_permissions(ctx, {
			organizationId: args.organizationId,
			role: workspaceAssignment.role,
		});
		for (const permission of workspacePermissions ?? []) {
			// A role given in one workspace never gives organization-wide power.
			if (isDefaultWorkspace || access_control_PERMISSION_CATALOG[permission].scope === "workspace") {
				permissions.add(permission);
			}
		}
	}

	if (defaultAssignment) {
		const defaultPermissions = await resolve_role_permissions(ctx, {
			organizationId: args.organizationId,
			role: defaultAssignment.role,
		});
		for (const permission of defaultPermissions ?? []) {
			permissions.add(permission);
		}
	}

	return permissions;
}

// #endregion Role resolution

// #region Grant lookups

function db_get_user_permission_grant(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		resourceKind: access_control_ResourceKind;
		resourceId: string;
		userId: Id<"users">;
		permission: access_control_Permission;
	},
) {
	return ctx.db
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
}

function db_get_public_permission_grant(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		resourceKind: access_control_ResourceKind;
		resourceId: string;
		permission: access_control_Permission;
	},
) {
	return ctx.db
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
}

function db_get_role_permission_grant(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		resourceKind: access_control_ResourceKind;
		resourceId: string;
		role: access_control_RoleRef;
		permission: access_control_Permission;
	},
) {
	return ctx.db
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
}

// #endregion Grant lookups

// #region Write helpers

/**
 * Create a role assignment when the user has no role yet in this workspace.
 *
 * It never changes an existing role. The invite and create flows use it, so running them again
 * cannot lower someone's role by accident. Use `db_set_role_assignment` to change a role.
 */
export async function access_control_db_ensure_role_assignment(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
		role: access_control_RoleRef;
		now: number;
	},
) {
	const existing = await db_get_role_assignment(ctx, args);
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

/**
 * Give one membership the `member` organization role, when that membership needs one.
 *
 * A membership on its own gives no permission any more, so a membership written or reactivated
 * without an assignment would quietly see an empty file tree instead of an error. `member` is the
 * lowest role every invite writes.
 *
 * It does nothing in three cases: the user owns the organization (owners have no assignment doc),
 * the organization has no default workspace (logged, not thrown), and the membership is outside the
 * default workspace (the assignment there is already the organization role).
 *
 * Callers run during sign-in and during migrations, where one broken organization must not stop the
 * whole job, so this never throws.
 */
export async function access_control_db_ensure_organization_member_role(
	ctx: MutationCtx,
	args: {
		organization: Doc<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
		now: number;
	},
) {
	if (args.organization.ownerUserId === args.userId) {
		return;
	}

	if (!args.organization.defaultWorkspaceId) {
		console.error("organization.defaultWorkspaceId is not set", { organizationId: args.organization._id });
		return;
	}

	if (args.workspaceId !== args.organization.defaultWorkspaceId) {
		return;
	}

	await access_control_db_ensure_role_assignment(ctx, {
		organizationId: args.organization._id,
		workspaceId: args.workspaceId,
		userId: args.userId,
		role: "member",
		now: args.now,
	});
}

/** Set a user's role at one workspace, replacing any role they already have there. */
async function db_set_role_assignment(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
		role: access_control_RoleRef;
		now: number;
	},
) {
	const existing = await db_get_role_assignment(ctx, args);
	if (existing) {
		if (existing.role !== args.role) {
			await ctx.db.patch("access_control_role_assignments", existing._id, {
				role: args.role,
				updatedAt: args.now,
			});
		}
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

// #endregion Write helpers

// #region Permission check

/**
 * Access to a restricted file or folder.
 *
 * Once a node is restricted, a role's own permissions give nothing here. Only a grant gets in: one
 * that names the user, one that is public, or one that names a role the user holds. So even an admin
 * with workspace-wide `content.read` is locked out unless a grant names them. Only the owner is let
 * through, earlier, in `access_control_db_has_permission`.
 *
 * The caller returns this answer as-is and never falls back to the role check below it.
 */
async function has_restricted_file_permission(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		defaultWorkspaceId: Id<"organizations_workspaces">;
		scopeNodeId: Id<"files_nodes">;
		permission: access_control_Permission;
		userId?: Id<"users">;
		allowPublic?: boolean;
	},
) {
	const grantKey = {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		resourceKind: "file",
		resourceId: String(args.scopeNodeId),
		permission: args.permission,
	} as const;

	if (args.userId && (await db_get_user_permission_grant(ctx, { ...grantKey, userId: args.userId }))) {
		return true;
	}

	if (args.allowPublic && (await db_get_public_permission_grant(ctx, grantKey))) {
		return true;
	}

	if (!args.userId) {
		return false;
	}

	const refs = await resolve_role_refs(ctx, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		defaultWorkspaceId: args.defaultWorkspaceId,
		userId: args.userId,
	});

	const roleGrants = await Promise.all(refs.map((role) => db_get_role_permission_grant(ctx, { ...grantKey, role })));
	return roleGrants.some(Boolean);
}

/**
 * The restricted scope that is really in force for a node, or `null` when the node uses normal
 * workspace access.
 *
 * The pointer saved on a node can be out of date: the scope node may have been deleted, or made
 * open again. Such a pointer must not hide the files under it forever, so we follow it only when the
 * scope node is still really restricted. We also compare organization and workspace, so a pointer
 * that somehow crossed into another workspace is never answered with this workspace's grants.
 *
 * Both readers of `restrictedScopeNodeId` go through here, so the rule for "is this pointer real"
 * exists once. A second copy of it would let the permission check and the list filter drift apart,
 * and then a file would be hidden from a list but still open by id, or the other way round.
 */
async function db_resolve_live_restricted_scope(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		restrictedScopeNodeId: Id<"files_nodes"> | null;
	},
) {
	if (!args.restrictedScopeNodeId) {
		return null;
	}

	const scopeNode = await ctx.db.get("files_nodes", args.restrictedScopeNodeId);
	if (
		!scopeNode ||
		scopeNode.restrictedScopeNodeId !== scopeNode._id ||
		scopeNode.organizationId !== args.organizationId ||
		scopeNode.workspaceId !== args.workspaceId
	) {
		return null;
	}

	return scopeNode._id;
}

/**
 * Keep only the file nodes the user may read.
 *
 * By default every caller has already proved workspace-wide `content.read`, so a node with no
 * restricted scope passes without a single extra read. Only restricted nodes cost anything, and the
 * answer is worked out once per scope instead of once per node: a restricted folder with 500 files
 * inside is one check, not 500.
 *
 * Use this on every surface that returns more than one node. Without it a restricted file keeps its
 * name and path visible in the tree, in search, and in the activity list, which tells everyone in
 * the workspace exactly what they are not allowed to open.
 */
export async function access_control_db_filter_readable_file_nodes<
	T extends { restrictedScopeNodeId?: Id<"files_nodes"> },
>(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		userId: Id<"users">;
		nodes: readonly T[];
		/**
		 * Whether the caller holds workspace-wide `content.read`. Defaults to `true`, which is what
		 * every list surface proves before calling.
		 *
		 * Pass `false` for a user whose role gives them no workspace-wide read but who may still have
		 * been given one folder. Then only the restricted nodes they hold a grant on are kept, and
		 * every open node is dropped.
		 */
		hasWorkspaceRead?: boolean;
	},
): Promise<T[]> {
	const hasWorkspaceRead = args.hasWorkspaceRead ?? true;

	// Nothing here is restricted, so the caller's workspace-wide read already covers all of it. This
	// is the normal case, and it costs no database read at all. It is also what keeps the reserved
	// global organization working: nothing can restrict a node there, so we never try to load it as a
	// real organization below.
	if (hasWorkspaceRead && !args.nodes.some((node) => node.restrictedScopeNodeId)) {
		return [...args.nodes];
	}

	const organizationId = ctx.db.normalizeId("organizations", String(args.organizationId));
	const workspaceId = ctx.db.normalizeId("organizations_workspaces", String(args.workspaceId));
	const organization = organizationId ? await ctx.db.get("organizations", organizationId) : null;
	const defaultWorkspaceId = organization?.defaultWorkspaceId;

	// The owner may read everything.
	if (organization && args.userId === organization.ownerUserId) {
		return [...args.nodes];
	}

	const readableByScopeNodeId = new Map<Id<"files_nodes">, boolean>();
	const kept: T[] = [];

	for (const node of args.nodes) {
		const pointer = node.restrictedScopeNodeId;
		if (!pointer) {
			// An open node is exactly what workspace-wide read covers, so without that read it is out.
			if (hasWorkspaceRead) {
				kept.push(node);
			}
			continue;
		}

		if (!organizationId || !workspaceId || !defaultWorkspaceId) {
			// The organization cannot be read, so no grant can be checked. Drop the restricted nodes and
			// keep the rest: refusing everything would empty a whole workspace over a broken
			// organization doc, and keeping everything would hand out the files this pointer protects.
			console.error("Cannot resolve the organization while filtering restricted file nodes", {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
			});
			continue;
		}

		let readable = readableByScopeNodeId.get(pointer);
		if (readable === undefined) {
			const scopeNodeId = await db_resolve_live_restricted_scope(ctx, {
				organizationId,
				workspaceId,
				restrictedScopeNodeId: pointer,
			});
			readable = scopeNodeId
				? await has_restricted_file_permission(ctx, {
						organizationId,
						workspaceId,
						defaultWorkspaceId,
						scopeNodeId,
						permission: "content.read",
						userId: args.userId,
					})
				: // A dead pointer means this node is not really restricted, so it is an open node and the
					// workspace-wide read decides. Caching that under the dead pointer is safe: every node
					// carrying the same dead pointer gets the same answer.
					hasWorkspaceRead;
			readableByScopeNodeId.set(pointer, readable);
		}

		if (readable) {
			kept.push(node);
		}
	}

	return kept;
}

/**
 * Whether `userId` may do `permission` on one already-loaded node, when only the ids are on hand.
 *
 * For the handlers that never see a membership doc: the db helpers under `files_nodes.ts`, and the
 * public-API mutations that authorize a token instead of a member. Like the read filter above, it
 * assumes the caller already proved the workspace-wide permission, so a node with no restricted scope
 * costs no database read and answers yes.
 *
 * Reach for this whenever a write path **finds** a node after its permission check: the folder a
 * recursive create walks into, the file already sitting on a destination path, a descendant swept up
 * by a cascade. Those nodes were never named by the caller, so nothing has asked about them yet, and
 * every one of them has been a way into a restricted folder at least once.
 */
export async function access_control_db_can_act_on_file_node(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		userId: Id<"users">;
		fileNode: { restrictedScopeNodeId?: Id<"files_nodes"> };
		permission: access_control_Permission;
	},
) {
	if (!args.fileNode.restrictedScopeNodeId) {
		return true;
	}

	const organizationId = ctx.db.normalizeId("organizations", String(args.organizationId));
	const workspaceId = ctx.db.normalizeId("organizations_workspaces", String(args.workspaceId));
	const organization = organizationId ? await ctx.db.get("organizations", organizationId) : null;
	const defaultWorkspaceId = organization?.defaultWorkspaceId;
	if (!organizationId || !workspaceId || !organization || !defaultWorkspaceId) {
		// Same call as the read filter: with no organization doc no grant can be checked, and the safe
		// answer for a restricted node is no.
		console.error("Cannot resolve the organization while checking a restricted file node", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
		});
		return false;
	}

	if (args.userId === organization.ownerUserId) {
		return true;
	}

	const scopeNodeId = await db_resolve_live_restricted_scope(ctx, {
		organizationId,
		workspaceId,
		restrictedScopeNodeId: args.fileNode.restrictedScopeNodeId,
	});
	if (!scopeNodeId) {
		// A dead pointer means this node is not really restricted, and the caller already holds the
		// workspace-wide permission.
		return true;
	}

	return await has_restricted_file_permission(ctx, {
		organizationId,
		workspaceId,
		defaultWorkspaceId,
		scopeNodeId,
		permission: args.permission,
		userId: args.userId,
	});
}

/**
 * Answer whether a user, or the public, has one permission on one resource.
 *
 * The caller must load the file, workspace, or organization first and pass the ids taken from it.
 * This helper does not load the organization, and it checks workspace membership in one case only: a
 * workspace-scoped permission that arrives from the organization role, which otherwise would
 * reach workspaces the user does not belong to. In every other case the handler that calls this must
 * check membership itself.
 *
 * Pass `userId` to check a logged-in user. Leave it out and pass `allowPublic: true` only for public
 * or link access, which is meant to accept grants given to everyone.
 */
export async function access_control_db_has_permission(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		defaultWorkspaceId: Id<"organizations_workspaces">;
		organizationOwnerUserId: Id<"users">;
		resource: access_control_Resource;
		permission: access_control_Permission;
		userId?: Id<"users">;
		allowPublic?: boolean;
	},
) {
	const userId = args.userId;

	// The owner is only the user stored in `organizations.ownerUserId`. Owners have no assignment doc.
	if (userId && userId === args.organizationOwnerUserId) {
		return true;
	}

	if (args.resource.kind === "file") {
		const scopeNodeId = await db_resolve_live_restricted_scope(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			restrictedScopeNodeId: args.resource.restrictedScopeNodeId,
		});
		if (scopeNodeId) {
			return await has_restricted_file_permission(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				defaultWorkspaceId: args.defaultWorkspaceId,
				scopeNodeId,
				permission: args.permission,
				userId,
				allowPublic: args.allowPublic,
			});
		}
	}

	const grantKey = {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		resourceKind: args.resource.kind,
		resourceId: args.resource.id,
		permission: args.permission,
	} as const;

	if (userId && (await db_get_user_permission_grant(ctx, { ...grantKey, userId }))) {
		return true;
	}

	if (args.allowPublic && (await db_get_public_permission_grant(ctx, grantKey))) {
		return true;
	}

	if (!userId) {
		return false;
	}

	const scope = access_control_PERMISSION_CATALOG[args.permission].scope;

	// An organization-scoped permission only works when it comes from the default workspace, because
	// that is where a user's organization role is stored.
	if (scope === "workspace" || args.workspaceId === args.defaultWorkspaceId) {
		const assignment = await db_get_role_assignment(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId,
		});
		if (assignment) {
			const permissions = await resolve_role_permissions(ctx, {
				organizationId: args.organizationId,
				role: assignment.role,
			});
			if (permissions?.includes(args.permission)) {
				return true;
			}
		}
	}

	if (args.workspaceId === args.defaultWorkspaceId) {
		return false;
	}

	// Nothing so far, so try the organization role, stored on the default workspace.
	const defaultAssignment = await db_get_role_assignment(ctx, {
		organizationId: args.organizationId,
		workspaceId: args.defaultWorkspaceId,
		userId,
	});
	if (!defaultAssignment) {
		return false;
	}

	const defaultPermissions = await resolve_role_permissions(ctx, {
		organizationId: args.organizationId,
		role: defaultAssignment.role,
	});
	if (!defaultPermissions?.includes(args.permission)) {
		return false;
	}

	// An organization-scoped permission works in every workspace. A workspace-scoped one works only in
	// workspaces the user is really a member of.
	if (scope === "organization") {
		return true;
	}

	return Boolean(
		await db_get_active_membership(ctx, {
			userId,
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
		}),
	);
}

/**
 * Check one permission for a handler that works inside a workspace.
 *
 * It takes the membership the handler already loaded. That way this file never has to import
 * `organizations.ts`, which already imports this file. Pass `fileNode` when the operation targets one
 * file or folder: the file scope is worked out here, so call sites cannot build the wrong ids.
 *
 * On success it returns the organization, so handlers do not have to load it again, and
 * `defaultWorkspaceId` separately because here it is already known to be set. Read from
 * `organization` again its type is `Id | undefined`, and an `undefined` would quietly match nothing
 * instead of failing.
 */
export async function access_control_db_authorize_membership(
	ctx: QueryCtx | MutationCtx,
	args: {
		userAuth: { id: Id<"users"> };
		membership: Doc<"organizations_workspaces_users">;
		permission: access_control_Permission;
		fileNode?: Pick<Doc<"files_nodes">, "_id" | "organizationId" | "workspaceId" | "restrictedScopeNodeId">;
	},
) {
	const user = await ctx.db.get("users", args.userAuth.id);
	if (!user || user.deletedAt != null) {
		return Result({ _nay: { message: "Unauthenticated" } });
	}

	if (args.membership.userId !== args.userAuth.id || args.membership.active === false) {
		return Result({ _nay: { message: "Unauthorized" } });
	}

	const organization = await ctx.db.get("organizations", args.membership.organizationId);
	if (!organization?.defaultWorkspaceId) {
		console.error("organization.defaultWorkspaceId is not set", { organizationId: args.membership.organizationId });
		return Result({ _nay: { message: "Unauthorized" } });
	}
	const defaultWorkspaceId = organization.defaultWorkspaceId;

	let resource: access_control_Resource;
	if (args.fileNode) {
		if (
			args.fileNode.organizationId !== args.membership.organizationId ||
			args.fileNode.workspaceId !== args.membership.workspaceId
		) {
			return Result({ _nay: { message: "Unauthorized" } });
		}
		resource = {
			kind: "file",
			id: String(args.fileNode._id),
			restrictedScopeNodeId: args.fileNode.restrictedScopeNodeId ?? null,
		};
	} else {
		resource = { kind: "workspace", id: String(args.membership.workspaceId) };
	}

	const allowed = await access_control_db_has_permission(ctx, {
		organizationId: args.membership.organizationId,
		workspaceId: args.membership.workspaceId,
		defaultWorkspaceId,
		organizationOwnerUserId: organization.ownerUserId,
		resource,
		permission: args.permission,
		userId: args.userAuth.id,
	});
	if (!allowed) {
		return Result({ _nay: { message: "Permission denied" } });
	}

	return Result({ _yay: { organization, defaultWorkspaceId } });
}

/**
 * Load one node of this workspace and check a permission against that node.
 *
 * Many handlers take a node id and nothing else: the snapshot family, the pending-update family, and
 * the structural mutations. Every one of them has to load the node, prove it belongs to the
 * membership's workspace, and only then ask the permission question against it. Those three steps
 * live here once, because doing them by hand in twenty places is how one of them ends up asking
 * about the workspace instead and quietly opens every restricted file in it.
 *
 * The membership comes in already loaded, for the same reason as
 * `access_control_db_authorize_membership`: loading it here would import `organizations.ts`, which
 * already imports this file.
 */
export async function access_control_db_authorize_node(
	ctx: QueryCtx | MutationCtx,
	args: {
		userAuth: { id: Id<"users"> };
		membership: Doc<"organizations_workspaces_users">;
		nodeId: Id<"files_nodes">;
		permission: access_control_Permission;
	},
) {
	const fileNode = await ctx.db.get("files_nodes", args.nodeId);
	if (
		!fileNode ||
		fileNode.organizationId !== args.membership.organizationId ||
		fileNode.workspaceId !== args.membership.workspaceId
	) {
		// "Not found" and not "Permission denied": a node of another workspace is not this caller's
		// business at all, and saying which of the two it is would confirm that the id exists.
		return Result({ _nay: { message: "Not found" } });
	}

	const authorized = await access_control_db_authorize_membership(ctx, {
		userAuth: args.userAuth,
		membership: args.membership,
		permission: args.permission,
		fileNode,
	});
	if (authorized._nay) {
		return authorized;
	}

	return Result({
		_yay: {
			fileNode,
			organization: authorized._yay.organization,
			defaultWorkspaceId: authorized._yay.defaultWorkspaceId,
		},
	});
}

// #endregion Permission check

// #region Role and permission queries

/**
 * The role to show in the UI for a user in one workspace.
 *
 * When the user has no role in that workspace, it falls back to their organization role from
 * the default workspace, the same way the permission check does. So someone who can work in a
 * workspace is never shown as having no role there.
 */
async function resolve_display_role(
	ctx: QueryCtx | MutationCtx,
	args: {
		organization: Doc<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
	},
): Promise<access_control_DisplayRole | null> {
	if (args.userId === args.organization.ownerUserId) {
		return { kind: "owner" };
	}

	const defaultWorkspaceId = args.organization.defaultWorkspaceId;
	let assignment = await db_get_role_assignment(ctx, {
		organizationId: args.organization._id,
		workspaceId: args.workspaceId,
		userId: args.userId,
	});
	if (!assignment && defaultWorkspaceId && defaultWorkspaceId !== args.workspaceId) {
		assignment = await db_get_role_assignment(ctx, {
			organizationId: args.organization._id,
			workspaceId: defaultWorkspaceId,
			userId: args.userId,
		});
	}
	if (!assignment) {
		return null;
	}

	if (access_control_is_system_role(assignment.role)) {
		return { kind: "system", role: assignment.role };
	}

	const roleId = ctx.db.normalizeId("access_control_roles", assignment.role);
	const role = roleId ? await ctx.db.get("access_control_roles", roleId) : null;
	if (!role || role.organizationId !== args.organization._id) {
		return null;
	}

	return { kind: "custom", roleId: role._id, name: role.name };
}

export const get_current_user_role = query({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
	},
	returns: display_role_validator,
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return null;
		}

		const organization = await ctx.db.get("organizations", args.organizationId);
		if (!organization) {
			return null;
		}

		return await resolve_display_role(ctx, {
			organization,
			workspaceId: args.workspaceId,
			userId: userAuth.id,
		});
	},
});

/** Return one user's role at one workspace, but only to someone who can see that workspace. */
export const get_organization_workspace_user_role = query({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
	},
	returns: display_role_validator,
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return null;
		}

		const [currentWorkspaceMembership, targetWorkspaceMembership, organization] = await Promise.all([
			db_get_active_membership(ctx, {
				userId: userAuth.id,
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
			}),
			db_get_active_membership(ctx, {
				userId: args.userId,
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
			}),
			ctx.db.get("organizations", args.organizationId),
		]);

		// We need both memberships, not only the caller's. `resolve_display_role` answers `owner`
		// before it reads anything, and otherwise falls back to the organization role. So without
		// checking the target's membership, this query would report a role for someone who is not in
		// this workspace at all — for example an account being deleted, whose membership is inactive
		// but whose role assignment is still there. Callers only ask about users they took from this
		// workspace's member list.
		if (!currentWorkspaceMembership || !targetWorkspaceMembership || !organization) {
			return null;
		}

		return await resolve_display_role(ctx, {
			organization,
			workspaceId: args.workspaceId,
			userId: args.userId,
		});
	},
});

export const get_current_user_organization_permission = query({
	args: {
		organizationId: v.id("organizations"),
		permission: permission_validator,
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

		const defaultWorkspaceId = organization.defaultWorkspaceId;
		if (!defaultWorkspaceId) {
			console.error("organization.defaultWorkspaceId is not set", { organizationId: organization._id });
			return false;
		}

		// Organization-level permissions in the UI need a membership in the default workspace. A grant
		// on a single file does not make somebody a member of the organization.
		const defaultWorkspaceMembership = await db_get_active_membership(ctx, {
			userId: userAuth.id,
			organizationId: organization._id,
			workspaceId: defaultWorkspaceId,
		});
		if (!defaultWorkspaceMembership) {
			return false;
		}

		return await access_control_db_has_permission(ctx, {
			organizationId: organization._id,
			workspaceId: defaultWorkspaceId,
			defaultWorkspaceId,
			organizationOwnerUserId: organization.ownerUserId,
			resource: { kind: "organization", id: String(organization._id) },
			permission: args.permission,
			userId: userAuth.id,
		});
	},
});

/**
 * Whether the current user has one permission inside one workspace.
 *
 * The organization query cannot answer this for workspace-scoped permissions such as
 * `content.write`, because it always checks the default workspace.
 */
export const get_current_user_workspace_permission = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		permission: permission_validator,
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return false;
		}

		const membership = await ctx.db.get("organizations_workspaces_users", args.membershipId);
		if (!membership) {
			return false;
		}

		const authorized = await access_control_db_authorize_membership(ctx, {
			userAuth,
			membership,
			permission: args.permission,
		});
		return !authorized._nay;
	},
});

// #endregion Role and permission queries

// #region Custom roles

/** Load the organization and the caller's permissions for a role-management mutation. */
async function authorize_role_management(
	ctx: MutationCtx,
	args: { organizationId: Id<"organizations">; userId: Id<"users"> },
) {
	const organization = await ctx.db.get("organizations", args.organizationId);
	if (!organization) {
		return Result({ _nay: { message: "Not found" } });
	}

	const defaultWorkspaceId = organization.defaultWorkspaceId;
	if (!defaultWorkspaceId) {
		const errorMessage = "organization.defaultWorkspaceId is not set";
		const errorData = { organizationId: organization._id };
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}

	const defaultWorkspaceMembership = await db_get_active_membership(ctx, {
		userId: args.userId,
		organizationId: organization._id,
		workspaceId: defaultWorkspaceId,
	});
	if (!defaultWorkspaceMembership) {
		return Result({ _nay: { message: "Permission denied" } });
	}

	const permissions = await access_control_db_resolve_effective_permissions(ctx, {
		organizationId: organization._id,
		workspaceId: defaultWorkspaceId,
		defaultWorkspaceId,
		organizationOwnerUserId: organization.ownerUserId,
		userId: args.userId,
	});

	if (permissions !== "all" && !permissions.has("organization.roles.manage")) {
		return Result({ _nay: { message: "Permission denied" } });
	}

	// We return `defaultWorkspaceId` because here it is already known to exist. Callers compare role
	// assignments against it. If they read it from `organization` again its type is `Id | undefined`,
	// and an `undefined` value would quietly match nothing instead of failing.
	return Result({ _yay: { organization, defaultWorkspaceId, permissions } });
}

/**
 * Check the permission list of a role.
 *
 * A role can never contain a permission the caller does not have. Without this rule, anyone who can
 * manage roles could build a role stronger than themselves and then give it to themselves.
 */
function validate_role_permissions(
	permissions: access_control_Permission[],
	callerPermissions: ReadonlySet<access_control_Permission> | "all",
) {
	const unique = [...new Set(permissions)];
	if (unique.length === 0) {
		return Result({ _nay: { message: "Pick at least one permission" } });
	}

	// A permission that no code checks yet would be a switch that does nothing. It is already in the
	// catalog and in the schema, but it cannot be put on a role until something enforces it.
	const notEnforced = unique.find((permission) => !access_control_ENFORCED_PERMISSIONS.includes(permission));
	if (notEnforced) {
		return Result({
			_nay: { message: `"${access_control_PERMISSION_CATALOG[notEnforced].label}" is not available yet` },
		});
	}

	if (callerPermissions !== "all") {
		const missing = unique.find((permission) => !callerPermissions.has(permission));
		if (missing) {
			return Result({
				_nay: { message: `You cannot grant "${access_control_PERMISSION_CATALOG[missing].label}"` },
			});
		}
	}

	return Result({ _yay: unique });
}

async function validate_role_name(
	ctx: MutationCtx,
	args: { organizationId: Id<"organizations">; name: string; roleIdToIgnore?: Id<"access_control_roles"> },
) {
	const name = args.name.trim();
	if (name.length === 0) {
		return Result({ _nay: { message: "Name cannot be empty" } });
	}
	if (name.length > access_control_MAX_ROLE_NAME_LENGTH) {
		return Result({ _nay: { message: `Name must be at most ${access_control_MAX_ROLE_NAME_LENGTH} characters` } });
	}

	const normalizedName = name.toLowerCase();
	if ((access_control_RESERVED_ROLE_NAMES as readonly string[]).includes(normalizedName)) {
		return Result({ _nay: { message: "This name is reserved for a system role" } });
	}

	const existing = await ctx.db
		.query("access_control_roles")
		.withIndex("by_organization_normalizedName", (q) =>
			q.eq("organizationId", args.organizationId).eq("normalizedName", normalizedName),
		)
		.first();
	if (existing && existing._id !== args.roleIdToIgnore) {
		return Result({ _nay: { message: "Role name already exists" } });
	}

	return Result({ _yay: { name, normalizedName } });
}

/**
 * The custom roles of one organization. System roles are not here: they live only in code, with no
 * database, so the role editor reads those straight from `access_control_SYSTEM_ROLE_MATRIX`.
 */
export const list_roles = query({
	args: { organizationId: v.id("organizations") },
	returns: v.array(
		v.object({
			_id: v.id("access_control_roles"),
			name: doc(app_convex_schema, "access_control_roles").fields.name,
			description: doc(app_convex_schema, "access_control_roles").fields.description,
			permissions: doc(app_convex_schema, "access_control_roles").fields.permissions,
			assignmentCount: v.number(),
			updatedAt: doc(app_convex_schema, "access_control_roles").fields.updatedAt,
		}),
	),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return [];
		}

		const organization = await ctx.db.get("organizations", args.organizationId);
		if (!organization) {
			return [];
		}

		const defaultWorkspaceId = organization.defaultWorkspaceId;
		if (!defaultWorkspaceId) {
			console.error("organization.defaultWorkspaceId is not set", { organizationId: organization._id });
			return [];
		}

		// Any active member can read this. Member lists show role names, and the role editor needs the
		// full role. So it is fine that a viewer can see the permissions of every role: nothing here is
		// about a single user, and the role names are already visible on the members page.
		const defaultWorkspaceMembership = await db_get_active_membership(ctx, {
			userId: userAuth.id,
			organizationId: organization._id,
			workspaceId: defaultWorkspaceId,
		});
		if (!defaultWorkspaceMembership) {
			return [];
		}

		const roles = await ctx.db
			.query("access_control_roles")
			.withIndex("by_organization_normalizedName", (q) => q.eq("organizationId", organization._id))
			.collect();

		return await Promise.all(
			roles.map(async (role) => {
				const assignments = await ctx.db
					.query("access_control_role_assignments")
					.withIndex("by_organization_role_workspace_user", (q) =>
						q.eq("organizationId", organization._id).eq("role", role._id),
					)
					.take(MAX_ROLE_ASSIGNMENT_COUNT);

				// This counts assignment docs, not people. It also counts users whose account is being
				// deleted, and it counts a workspace role apart from the same user's organization role.
				// Only users with an active membership block `delete_role`, so this number can be
				// higher than the number of users who really must be moved off the role first. Loading
				// every membership to make it exact would cost one read per assignment per role.
				return {
					_id: role._id,
					name: role.name,
					description: role.description,
					permissions: role.permissions,
					assignmentCount: assignments.length,
					updatedAt: role.updatedAt,
				};
			}),
		);
	},
});

export const create_role = mutation({
	args: {
		organizationId: v.id("organizations"),
		name: doc(app_convex_schema, "access_control_roles").fields.name,
		description: doc(app_convex_schema, "access_control_roles").fields.description,
		permissions: doc(app_convex_schema, "access_control_roles").fields.permissions,
	},
	returns: v_result({ _yay: v.object({ roleId: v.id("access_control_roles") }) }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "roles_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const authorized = await authorize_role_management(ctx, {
			organizationId: args.organizationId,
			userId: userAuth.id,
		});
		if (authorized._nay) {
			return authorized;
		}
		const { organization, permissions: callerPermissions } = authorized._yay;

		const nameResult = await validate_role_name(ctx, {
			organizationId: organization._id,
			name: args.name,
		});
		if (nameResult._nay) {
			return nameResult;
		}

		const permissionsResult = validate_role_permissions(args.permissions, callerPermissions);
		if (permissionsResult._nay) {
			return permissionsResult;
		}

		const description = args.description.trim();
		if (description.length > access_control_MAX_ROLE_DESCRIPTION_LENGTH) {
			return Result({
				_nay: { message: `Description must be at most ${access_control_MAX_ROLE_DESCRIPTION_LENGTH} characters` },
			});
		}

		const existingRoles = await ctx.db
			.query("access_control_roles")
			.withIndex("by_organization_normalizedName", (q) => q.eq("organizationId", organization._id))
			.take(MAX_CUSTOM_ROLES);
		if (existingRoles.length >= MAX_CUSTOM_ROLES) {
			return Result({
				_nay: { message: `An organization can have at most ${MAX_CUSTOM_ROLES} custom roles` },
			});
		}

		const now = Date.now();
		const roleId = await ctx.db.insert("access_control_roles", {
			organizationId: organization._id,
			name: nameResult._yay.name,
			normalizedName: nameResult._yay.normalizedName,
			description,
			permissions: permissionsResult._yay,
			createdBy: userAuth.id,
			createdAt: now,
			updatedAt: now,
		});

		return Result({ _yay: { roleId } });
	},
});

export const update_role = mutation({
	args: {
		roleId: v.id("access_control_roles"),
		name: v.optional(doc(app_convex_schema, "access_control_roles").fields.name),
		description: v.optional(doc(app_convex_schema, "access_control_roles").fields.description),
		permissions: v.optional(doc(app_convex_schema, "access_control_roles").fields.permissions),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "roles_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const role = await ctx.db.get("access_control_roles", args.roleId);
		if (!role) {
			return Result({ _nay: { message: "Not found" } });
		}

		const authorized = await authorize_role_management(ctx, {
			organizationId: role.organizationId,
			userId: userAuth.id,
		});
		if (authorized._nay) {
			return authorized;
		}
		const { permissions: callerPermissions } = authorized._yay;

		// You may only edit a role you could have created yourself. Without this rule an admin could
		// rename the owner's billing role to "Read-only auditor" and trick the next person who gives
		// that role to someone.
		if (callerPermissions !== "all") {
			const missing = role.permissions.find((permission) => !callerPermissions.has(permission));
			if (missing) {
				return Result({
					_nay: { message: `You cannot edit a role that grants "${access_control_PERMISSION_CATALOG[missing].label}"` },
				});
			}
		}

		const patch: Partial<
			Pick<Doc<"access_control_roles">, "name" | "normalizedName" | "description" | "permissions" | "updatedAt">
		> = { updatedAt: Date.now() };

		if (args.name != null) {
			const nameResult = await validate_role_name(ctx, {
				organizationId: role.organizationId,
				name: args.name,
				roleIdToIgnore: role._id,
			});
			if (nameResult._nay) {
				return nameResult;
			}
			patch.name = nameResult._yay.name;
			patch.normalizedName = nameResult._yay.normalizedName;
		}

		if (args.description != null) {
			const description = args.description.trim();
			if (description.length > access_control_MAX_ROLE_DESCRIPTION_LENGTH) {
				return Result({
					_nay: { message: `Description must be at most ${access_control_MAX_ROLE_DESCRIPTION_LENGTH} characters` },
				});
			}
			patch.description = description;
		}

		if (args.permissions != null) {
			const permissionsResult = validate_role_permissions(args.permissions, callerPermissions);
			if (permissionsResult._nay) {
				return permissionsResult;
			}
			patch.permissions = permissionsResult._yay;
		}

		await ctx.db.patch("access_control_roles", role._id, patch);

		return Result({ _yay: null });
	},
});

export const delete_role = mutation({
	args: { roleId: v.id("access_control_roles") },
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "roles_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const role = await ctx.db.get("access_control_roles", args.roleId);
		if (!role) {
			return Result({ _nay: { message: "Not found" } });
		}

		const authorized = await authorize_role_management(ctx, {
			organizationId: role.organizationId,
			userId: userAuth.id,
		});
		if (authorized._nay) {
			return authorized;
		}
		const { organization, defaultWorkspaceId, permissions: callerPermissions } = authorized._yay;

		// Same rule as `update_role`: you may only delete a role you could have created yourself.
		//
		// This protects the role *definition*, not what a user can do right now. Do not read it as
		// "billing access cannot be taken away". The same admin can still take this role away from
		// every user through `set_user_role` or `remove_user_from_organization`, and neither of those
		// looks at what the target already has. That is on purpose: this system stops people from
		// gaining more power, not from taking power away, and the owner can undo those changes with
		// one click. Deleting the role is the one thing the owner cannot undo: the name and the
		// permission list are gone, and a caller without those permissions could not create them again.
		if (callerPermissions !== "all") {
			const missing = role.permissions.find((permission) => !callerPermissions.has(permission));
			if (missing) {
				return Result({
					_nay: {
						message: `You cannot delete a role that grants "${access_control_PERMISSION_CATALOG[missing].label}"`,
					},
				});
			}
		}

		// Refuse while somebody can still be moved off this role, because deleting it would silently
		// take their access away. Assignments held by a user with no active membership are the
		// exception: `set_user_role` refuses those users, so blocking on them would make the role
		// impossible to delete until their account finishes deleting. Those leftover docs are handled
		// below.
		const [assignments, grant] = await Promise.all([
			ctx.db
				.query("access_control_role_assignments")
				.withIndex("by_organization_role_workspace_user", (q) =>
					q.eq("organizationId", role.organizationId).eq("role", role._id),
				)
				// One more than the limit, so a role held by more people than the limit is refused
				// instead of deleting the first `MAX_ROLE_ASSIGNMENT_COUNT` docs and leaving the rest
				// pointing at a role that no longer exists.
				.take(MAX_ROLE_ASSIGNMENT_COUNT + 1),
			ctx.db
				.query("access_control_permission_grants")
				.withIndex("by_organization_role_workspace_resource", (q) =>
					q.eq("organizationId", role.organizationId).eq("principalKind", "role").eq("role", role._id),
				)
				.first(),
		]);

		if (assignments.length > MAX_ROLE_ASSIGNMENT_COUNT) {
			return Result({ _nay: { message: "Too many members hold this role to delete it" } });
		}

		const memberships = await Promise.all(
			assignments.map((assignment) =>
				db_get_active_membership(ctx, {
					userId: assignment.userId,
					organizationId: assignment.organizationId,
					workspaceId: assignment.workspaceId,
				}),
			),
		);
		if (memberships.some((membership) => membership !== null)) {
			return Result({ _nay: { message: "Give this role's members another role first" } });
		}
		if (grant) {
			// Cannot happen until file sharing writes the first role grant. When that lands, it must
			// also ship a way to remove such a grant. Otherwise this error has no way out and the role
			// can never be deleted by anyone, not even the owner.
			return Result({ _nay: { message: "This role is still used to share a file or folder" } });
		}

		// Every user left here has no active membership in the workspace of their assignment, so
		// `set_user_role` refuses to move them off the role. In practice their account is being deleted.
		// The assignment on the default workspace is their organization role, and every member
		// needs one, so we lower it to the weakest role instead of deleting it. Deleting it would not
		// leave them with nothing: `users.resolve_user` writes `member` back if they come back, which
		// is more than the role they really had. Writing `viewer` keeps the fallback clear and small,
		// and it is the role the check below measures. Rows on any other workspace only add extra
		// power, so we delete those.
		const demotes = assignments.some((assignment) => assignment.workspaceId === defaultWorkspaceId);

		// Lowering a role gives out `viewer`, so it follows the same rule as `set_user_role`: nobody may
		// give a permission they do not have. This can only happen for a custom role that does not
		// include reading — `viewer` is not weaker than every role — held by a caller who cannot read
		// either.
		if (demotes && callerPermissions !== "all") {
			const missing = access_control_SYSTEM_ROLE_MATRIX.viewer.permissions.find(
				(permission) => !callerPermissions.has(permission),
			);
			if (missing) {
				return Result({
					_nay: {
						// The message names the fallback role for the same reason the invite error names
						// `member`: the caller never chose it and cannot choose another one.
						message: `You cannot delete this role: its members would fall back to ${access_control_SYSTEM_ROLE_MATRIX.viewer.label}, which grants "${access_control_PERMISSION_CATALOG[missing].label}"`,
					},
				});
			}

			// The other half of what a role carries. The grant query above only asked about the role
			// being deleted, and `viewer` is a different role: a share list can name it, so `viewer` can
			// open restricted files that its permission list says nothing about.
			//
			// The holders reached here all have an inactive membership, so nothing opens for them today.
			// It opens later: `users.resolve_user` reactivates the membership on account restore and
			// keeps whatever role assignment it finds, which by then is this `viewer`. So the caller
			// would have handed out a file through a role `set_user_role` would never have let them give.
			const blockingGrant = await access_control_db_role_file_grant_caller_cannot_give(ctx, {
				organization,
				defaultWorkspaceId,
				workspaceId: defaultWorkspaceId,
				role: "viewer",
				userId: userAuth.id,
			});
			if (blockingGrant) {
				return Result({
					_nay: {
						message: `You cannot delete this role: its members would fall back to ${access_control_SYSTEM_ROLE_MATRIX.viewer.label}, which is shared on a file you do not have "${access_control_PERMISSION_CATALOG[blockingGrant.permission].label}" on`,
					},
				});
			}
		}

		const now = Date.now();
		await Promise.all(
			assignments.map((assignment) =>
				assignment.workspaceId === defaultWorkspaceId
					? ctx.db.patch("access_control_role_assignments", assignment._id, { role: "viewer", updatedAt: now })
					: ctx.db.delete("access_control_role_assignments", assignment._id),
			),
		);
		await ctx.db.delete("access_control_roles", role._id);

		return Result({ _yay: null });
	},
});

// #endregion Custom roles

// #region Role assignment

export const set_user_role = mutation({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		// `null` removes the workspace role. Without it, a workspace role could
		// never be taken back: any weaker role is rejected by the "changes nothing" rule below, and
		// `delete_role` refuses while somebody still holds the role. The two checks would block each
		// other forever.
		role: v.union(v.null(), doc(app_convex_schema, "access_control_role_assignments").fields.role),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "roles_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const organization = await ctx.db.get("organizations", args.organizationId);
		if (!organization) {
			return Result({ _nay: { message: "Not found" } });
		}

		const defaultWorkspaceId = organization.defaultWorkspaceId;
		if (!defaultWorkspaceId) {
			const errorMessage = "organization.defaultWorkspaceId is not set";
			const errorData = { organizationId: organization._id };
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}

		const isDefaultWorkspace = args.workspaceId === defaultWorkspaceId;
		const [callerDefaultWorkspaceMembership, callerWorkspaceMembership, targetMembership, callerPermissions] =
			await Promise.all([
				db_get_active_membership(ctx, {
					userId: userAuth.id,
					organizationId: organization._id,
					workspaceId: defaultWorkspaceId,
				}),
				isDefaultWorkspace
					? null
					: db_get_active_membership(ctx, {
							userId: userAuth.id,
							organizationId: organization._id,
							workspaceId: args.workspaceId,
						}),
				db_get_active_membership(ctx, {
					userId: args.userId,
					organizationId: organization._id,
					workspaceId: args.workspaceId,
				}),
				access_control_db_resolve_effective_permissions(ctx, {
					organizationId: organization._id,
					workspaceId: args.workspaceId,
					defaultWorkspaceId,
					organizationOwnerUserId: organization.ownerUserId,
					userId: userAuth.id,
				}),
			]);

		if (!callerDefaultWorkspaceMembership) {
			return Result({ _nay: { message: "Permission denied" } });
		}

		// This runs after the membership check, like the same rule in `remove_user_from_organization`.
		// The message tells the caller who the owner is, and only a member may learn that. It runs
		// before the permission check, so the reason stays correct for a member who may manage roles
		// but hit the one member they cannot change.
		if (args.userId === organization.ownerUserId) {
			return Result({ _nay: { message: "Use ownership transfer to change the owner" } });
		}
		if (!targetMembership) {
			return Result({ _nay: { message: "This user is not a member of that workspace" } });
		}

		const canManage =
			callerPermissions === "all" ||
			callerPermissions.has("organization.members.manage") ||
			// `workspace.members.manage` never works in the default workspace, because roles there are
			// organization-wide. It also works only in a workspace the caller belongs to, the same rule
			// the permission check uses for every other workspace-scoped permission. Without the
			// membership test, an organization role holding only this permission could give write
			// access inside a workspace where its own holder cannot read a single file.
			(!isDefaultWorkspace && Boolean(callerWorkspaceMembership) && callerPermissions.has("workspace.members.manage"));
		if (!canManage) {
			return Result({ _nay: { message: "Permission denied" } });
		}

		if (args.role === null) {
			// The assignment on the default workspace is the organization role, and every member has
			// one. Removing it would leave a member who can open the app but do nothing in it, and the
			// members page would have no name to show for that state. Setting a weaker role says the
			// same thing and stays readable.
			if (isDefaultWorkspace) {
				return Result({
					_nay: {
						message: "Every member needs an organization role. Set a weaker one, or remove them from the organization.",
					},
				});
			}

			// Removing a role does not check what the caller has, unlike giving a role below. That check
			// exists so nobody gives out more than they have, and removing gives out nothing: it can only
			// send the target back to their organization role, which every member already has. So
			// the worst a caller can do here is take a workspace role away. They can never go above
			// their own level, and never push somebody below the normal floor. It does mean a caller
			// can remove a workspace role they could not give back; the owner can restore it.
			const assignment = await db_get_role_assignment(ctx, {
				organizationId: organization._id,
				workspaceId: args.workspaceId,
				userId: args.userId,
			});
			if (assignment) {
				await ctx.db.delete("access_control_role_assignments", assignment._id);
			}

			return Result({ _yay: null });
		}

		const rolePermissions = await resolve_role_permissions(ctx, {
			organizationId: organization._id,
			role: args.role,
		});
		if (!rolePermissions) {
			return Result({ _nay: { message: "Not found" } });
		}

		// Nobody may give out more than they have. We compare every permission in the role, even one
		// that would do nothing in this workspace today. That way the saved assignment never promises
		// more than the caller could give. If we compared only the permissions that work today, the doc
		// grant more than the caller has on the day those rules change.
		//
		// `callerPermissions` is read at `args.workspaceId`, and
		// `access_control_db_resolve_effective_permissions` also adds the organization role
		// without checking membership. So a caller who is not a member here can look like they hold
		// workspace-scoped permissions that the permission check would refuse them in this workspace.
		// That looks like a hole but is not one. The same caller can give the same role in the default
		// workspace, where this same set is the limit and the "adds nothing" rule below does not apply.
		// And a role given in the default workspace gives the target *more* than one given here: it
		// works in every workspace, not only this one. Every real target has a membership and an
		// assignment in the default workspace, because invites always create them. So this check asks
		// what the caller's role contains, not what they could use right here.
		if (callerPermissions !== "all") {
			const missing = rolePermissions.find((permission) => !callerPermissions.has(permission));
			if (missing) {
				return Result({
					_nay: {
						message: `You cannot assign a role that grants "${access_control_PERMISSION_CATALOG[missing].label}"`,
					},
				});
			}

			// The same rule, for the half of a role that lives outside its permission list. A share list
			// can name a role, so assigning one also hands over every restricted file shared with it.
			// The list above cannot see those, and a caller who may manage members is not thereby
			// somebody who may open a restricted folder.
			const blockingGrant = await access_control_db_role_file_grant_caller_cannot_give(ctx, {
				organization,
				defaultWorkspaceId,
				workspaceId: args.workspaceId,
				role: args.role,
				userId: userAuth.id,
			});
			if (blockingGrant) {
				// The node is not named. A caller who cannot open it should not learn which file it is
				// from a refusal, and the role name is enough to act on.
				return Result({
					_nay: {
						message: `You cannot assign this role: it is shared on a file you do not have "${access_control_PERMISSION_CATALOG[blockingGrant.permission].label}" on`,
					},
				});
			}
		}

		// Roles can only add power. A workspace role weaker than the organization role changes
		// nothing. Accepting it would report success, show the weaker name on the members page, and
		// still leave the user with all their old access.
		if (!isDefaultWorkspace) {
			const organizationPermissions = await access_control_db_resolve_effective_permissions(ctx, {
				organizationId: organization._id,
				workspaceId: defaultWorkspaceId,
				defaultWorkspaceId,
				organizationOwnerUserId: organization.ownerUserId,
				userId: args.userId,
			});
			// Here we look only at the permissions that would really work in this workspace. An
			// organization-scoped permission written on a workspace assignment works nowhere, so a role
			// whose only extra permission is one of those would pass this test and then change nothing
			// — exactly what this check exists to stop. The check above reads the full list on purpose,
			// because it asks a different question.
			const bindingPermissions = rolePermissions.filter(
				(permission) => access_control_PERMISSION_CATALOG[permission].scope === "workspace",
			);
			const addsNothing =
				organizationPermissions === "all" ||
				bindingPermissions.every((permission) => organizationPermissions.has(permission));
			if (addsNothing) {
				return Result({
					_nay: {
						message: "This role adds nothing to the member's organization role",
					},
				});
			}
		}

		await db_set_role_assignment(ctx, {
			organizationId: organization._id,
			workspaceId: args.workspaceId,
			userId: args.userId,
			role: args.role,
			now: Date.now(),
		});

		return Result({ _yay: null });
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

		const [newOwnerAssignments, newOwnerUser, newOwnerDefaultWorkspaceMembership, currentOwnerQuota, newOwnerQuota] =
			await Promise.all([
				// We delete the new owner's role docs in every workspace, not only the default one. While
				// they own the organization those docs do nothing, and they would quietly start working
				// again if ownership were later given to someone else.
				ctx.db
					.query("access_control_role_assignments")
					.withIndex("by_organization_user_workspace", (q) =>
						q.eq("organizationId", args.organizationId).eq("userId", args.newOwnerUserId),
					)
					.collect(),
				ctx.db.get("users", args.newOwnerUserId),
				db_get_active_membership(ctx, {
					userId: args.newOwnerUserId,
					organizationId: args.organizationId,
					workspaceId: defaultWorkspaceId,
				}),
				quotas_db_get(ctx, {
					quotaName: "extra_organizations",
					userId: user._id,
				}),
				quotas_db_get(ctx, {
					quotaName: "extra_organizations",
					userId: args.newOwnerUserId,
				}),
			]);

		if (!newOwnerUser || newOwnerUser.deletedAt != null || !newOwnerDefaultWorkspaceMembership) {
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

		await Promise.all([
			// We keep `billingMode` as it is. The owner-purge path in `data_deletion.ts` resets it to
			// `"user"` instead, because there the new owner is only the first member the index returned.
			// Here the old owner picked the new owner on purpose, so the billing setup should stay.
			// `billing.test.ts` checks this.
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
			...newOwnerAssignments.map((assignment) => ctx.db.delete("access_control_role_assignments", assignment._id)),
			db_set_role_assignment(ctx, {
				organizationId: args.organizationId,
				workspaceId: defaultWorkspaceId,
				userId: user._id,
				role: "member",
				now,
			}),
		]);

		return Result({ _yay: null });
	},
});

// #endregion Role assignment
