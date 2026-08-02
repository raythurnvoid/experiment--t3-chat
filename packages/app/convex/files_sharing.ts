// Sharing one file or folder with named people, instead of with the whole workspace.
//
// Two pieces of state do the work, and both already existed before this module:
//
// - `files_nodes.restrictedScopeNodeId` points at the nearest restricted folder at or above a node.
//   A node is the restricted one exactly when the pointer equals its own id. Every node under it
//   carries the same pointer, so the check never walks up the tree.
// - `access_control_permission_grants` docs with `resourceKind: "file"` and the restricted node's id
//   as `resourceId`. One doc holds one permission, so a share level is two or three docs.
//
// Inside a restricted scope a role gives nothing: only a grant gets in, plus the organization owner.
// That rule lives in `access_control.ts` and is what makes "restricted" mean restricted, including
// against an admin. It also means the person who restricts something has to keep a way back in, so
// `restrict_node` writes their own grants, and the last manager cannot be removed.

import { v } from "convex/values";
import { doc } from "convex-helpers/validators";

import type { Doc, Id } from "./_generated/dataModel.js";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import {
	access_control_db_authorize_node,
	access_control_db_caller_cannot_share_with_role,
	access_control_db_has_permission,
	access_control_db_resolve_effective_permissions,
} from "./access_control.ts";
import {
	files_nodes_db_cascade_restricted_scope,
	files_nodes_db_resolve_parent_restricted_scope,
} from "./files_nodes.ts";
import { organizations_db_get_membership } from "./organizations.ts";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";
import app_convex_schema from "./schema.ts";
import { v_result } from "../server/convex-utils.ts";
import { server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";
import { Result } from "common/errors-as-values-utils.ts";
import {
	access_control_FILE_SHARE_LEVEL_KEYS,
	access_control_FILE_SHARE_LEVELS,
	access_control_PERMISSION_CATALOG,
	access_control_FILE_SHARE_PERMISSIONS,
	access_control_file_share_level_from_permissions,
	access_control_is_system_role,
	type access_control_FileShareLevel,
	type access_control_Permission,
	type access_control_RoleRef,
} from "../shared/access-control.ts";

// Make Convex reuse the loaded module between calls, so warm calls skip the module load cost.
// Does NOT work for http actions (see http.ts). No mutable module-level state allowed here.
export const experimental_reuseContext = true;

/**
 * Most people plus roles that one restricted file or folder may name.
 *
 * A share list is meant to be short. Somebody who needs more than this wants a workspace, not a
 * shared folder, and an unbounded list would make every read of it cost more.
 */
const MAX_FILE_SHARE_PRINCIPALS = 50;

/**
 * How many grant docs we ever load for one restricted node.
 *
 * A principal costs up to three docs, one per permission of the `manage` level, so this is the
 * principal cap with room to spare. It exists so a single query can never read an unbounded number
 * of docs, not as a second limit users can hit.
 */
const MAX_FILE_SHARE_GRANT_DOCS = MAX_FILE_SHARE_PRINCIPALS * 3 + 1;

/**
 * Most restricted files and folders that one role may be named on.
 *
 * Giving somebody a role, or inviting them, has to walk every share that names that role, because
 * a role hands out its shares along with itself. Without a limit that walk grows forever and one
 * day a mutation runs out of reads, and the person who then cannot invite anyone has no way to see
 * why or to fix it.
 *
 * So the limit lives here, at share time. This is where the count grows, and the refusal reaches
 * somebody who can act on it: share with the people instead of the role.
 */
const MAX_FILE_SHARES_PER_ROLE = 50;

/**
 * How many grant docs we load to count the shares that name one role.
 *
 * A share costs up to three docs, one per permission of the `manage` level. Reading one more than
 * the worst case is enough to tell "already at the limit" from "still below it", whatever mix of
 * levels those shares use.
 */
const MAX_ROLE_SHARE_GRANT_DOCS = MAX_FILE_SHARES_PER_ROLE * 3 + 1;

// #region validators

/** Written by hand: when you add a level to `access_control_FILE_SHARE_LEVELS`, add it here too. */
const share_level_validator = v.union(v.literal("read"), v.literal("write"), v.literal("manage"));

/**
 * Who a share entry is about. `public` is missing on purpose: link access needs `allowPublic` at
 * every read call site and is its own milestone, so nothing here can write a public grant.
 */
const share_principal_validator = v.union(
	v.object({ kind: v.literal("user"), userId: v.id("users") }),
	v.object({
		kind: v.literal("role"),
		role: doc(app_convex_schema, "access_control_role_assignments").fields.role,
	}),
);

type FileSharePrincipal =
	| { kind: "user"; userId: Id<"users"> }
	| { kind: "role"; role: access_control_RoleRef };

/**
 * One string that stands for one principal, so entries can be grouped in a `Map`.
 *
 * The two kinds are kept apart by the prefix. Without it a custom role id and a user id could
 * collide, because both are plain Convex ids.
 */
function share_principal_key(principal: FileSharePrincipal) {
	return principal.kind === "user" ? `user:${principal.userId}` : `role:${principal.role}`;
}

// #endregion validators

// #region grant helpers

/**
 * Every grant doc saved on one restricted node, whatever the principal.
 *
 * The index starts with organization, workspace, resource kind and resource id, and `principalKind`
 * only comes after those, so this one query returns user grants and role grants together.
 */
function db_list_scope_grants(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		scopeNodeId: Id<"files_nodes">;
	},
) {
	return ctx.db
		.query("access_control_permission_grants")
		.withIndex("by_organization_workspace_resource_user_permission", (q) =>
			q
				.eq("organizationId", args.organizationId)
				.eq("workspaceId", args.workspaceId)
				.eq("resourceKind", "file")
				.eq("resourceId", String(args.scopeNodeId)),
		)
		.take(MAX_FILE_SHARE_GRANT_DOCS);
}

/** The principal a grant doc is about, or `null` for a shape this module never writes. */
function read_grant_principal(grant: Doc<"access_control_permission_grants">): FileSharePrincipal | null {
	if (grant.principalKind === "user" && grant.userId) {
		return { kind: "user", userId: grant.userId };
	}
	if (grant.principalKind === "role" && grant.role) {
		return { kind: "role", role: grant.role };
	}

	// `public` grants land here. Nothing in this module writes one, and the share dialog has no row
	// that could show it, so it is left out rather than shown as an entry nobody can remove.
	return null;
}

/**
 * The share entries of one restricted node, grouped from the grant docs.
 *
 * A principal whose permissions add up to no level is dropped and logged. Only this module writes
 * these docs and it always writes a whole level, so that state is a bug, not something a user did.
 */
function group_grants_into_entries(grants: Doc<"access_control_permission_grants">[]) {
	const permissionsByKey = new Map<
		string,
		{ principal: FileSharePrincipal; permissions: Set<access_control_Permission> }
	>();

	for (const grant of grants) {
		const principal = read_grant_principal(grant);
		if (!principal) {
			continue;
		}

		const key = share_principal_key(principal);
		const entry = permissionsByKey.get(key);
		if (entry) {
			entry.permissions.add(grant.permission);
		} else {
			permissionsByKey.set(key, { principal, permissions: new Set([grant.permission]) });
		}
	}

	const entries: Array<{ principal: FileSharePrincipal; level: access_control_FileShareLevel }> = [];
	for (const entry of permissionsByKey.values()) {
		const level = access_control_file_share_level_from_permissions(entry.permissions);
		if (!level) {
			console.error("File share grants do not add up to a level", {
				principal: entry.principal,
				permissions: [...entry.permissions],
			});
			continue;
		}

		entries.push({ principal: entry.principal, level });
	}

	return entries;
}

/**
 * Write exactly the permissions of one level for one principal, and delete the rest.
 *
 * Lowering a level has to delete docs, not only stop writing them, or a member moved from "can
 * edit" to "can view" would keep writing. So this always looks at all three permissions.
 */
async function db_set_principal_level(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		scopeNodeId: Id<"files_nodes">;
		principal: FileSharePrincipal;
		/** `null` removes the principal from the share list. */
		level: access_control_FileShareLevel | null;
		grants: Doc<"access_control_permission_grants">[];
		now: number;
	},
) {
	const wanted = new Set<access_control_Permission>(
		args.level ? access_control_FILE_SHARE_LEVELS[args.level].permissions : [],
	);
	const key = share_principal_key(args.principal);
	const existingByPermission = new Map<access_control_Permission, Doc<"access_control_permission_grants">>();
	for (const grant of args.grants) {
		const principal = read_grant_principal(grant);
		if (principal && share_principal_key(principal) === key) {
			existingByPermission.set(grant.permission, grant);
		}
	}

	for (const permission of access_control_FILE_SHARE_PERMISSIONS) {
		const existing = existingByPermission.get(permission);
		if (wanted.has(permission)) {
			if (!existing) {
				await ctx.db.insert("access_control_permission_grants", {
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					resourceKind: "file",
					resourceId: String(args.scopeNodeId),
					principalKind: args.principal.kind,
					...(args.principal.kind === "user" ? { userId: args.principal.userId } : { role: args.principal.role }),
					permission,
					createdAt: args.now,
					updatedAt: args.now,
				});
			}
			continue;
		}

		if (existing) {
			await ctx.db.delete("access_control_permission_grants", existing._id);
		}
	}
}

/**
 * Refuse a change that would take the last manager off a restricted node's list.
 *
 * Without this, the last manager can remove themselves and then only the organization owner can ever
 * open the sharing again. The owner is not counted as a manager here: they hold no grant doc, and
 * counting them would let the last real manager go and leave a folder that only one person in the
 * whole organization can repair.
 *
 * Only somebody who manages it today can trigger this. A list with no manager in it is normal, and is
 * what the owner's own folders look like, so adding a reader to one of those has nothing to take away.
 *
 * The owner is never stopped by this. The rule exists to keep the node repairable, and the owner is
 * the repair: without the exemption they could not take the last person off a folder they restricted
 * themselves, and the only way back would be to unrestrict it and lose the whole list.
 *
 * It counts rows, not people. A manager row for a role nobody holds counts as a manager, and a role
 * everybody loses tomorrow still counts today. Making it count real people would not close the hole
 * either, because nothing stops the last holder of that role from being unassigned afterwards. So
 * this is a guard-rail against the common mistake, not a promise, and the owner remains the repair.
 */
function would_leave_no_manager(args: {
	entries: Array<{ principal: FileSharePrincipal; level: access_control_FileShareLevel }>;
	principal: FileSharePrincipal;
	level: access_control_FileShareLevel | null;
	callerIsOwner: boolean;
}) {
	if (args.level === "manage" || args.callerIsOwner) {
		return false;
	}

	const key = share_principal_key(args.principal);
	const managesToday = args.entries.some(
		(entry) => entry.level === "manage" && share_principal_key(entry.principal) === key,
	);
	if (!managesToday) {
		return false;
	}

	return !args.entries.some((entry) => entry.level === "manage" && share_principal_key(entry.principal) !== key);
}

// #endregion grant helpers

// #region authorization

/**
 * Load the membership, the node, and the organization for a sharing call, and check one permission
 * against the node itself.
 *
 * Checking against the node, and not against the workspace, is the whole point: inside a restricted
 * scope only a grant passes. So an admin who was never given this folder is refused here, exactly
 * like anybody else.
 */
async function authorize_node_sharing(
	ctx: QueryCtx | MutationCtx,
	args: {
		userAuth: { id: Id<"users"> };
		membershipId: Id<"organizations_workspaces_users">;
		nodeId: Id<"files_nodes">;
		permission: access_control_Permission;
	},
) {
	const membership = await organizations_db_get_membership(ctx, {
		userId: args.userAuth.id,
		membershipId: args.membershipId,
	});
	if (!membership) {
		return Result({ _nay: { message: "Unauthorized" } });
	}

	const authorized = await access_control_db_authorize_node(ctx, {
		userAuth: args.userAuth,
		membership,
		nodeId: args.nodeId,
		permission: args.permission,
	});
	if (authorized._nay) {
		return authorized;
	}

	return Result({
		_yay: {
			membership,
			node: authorized._yay.fileNode,
			organization: authorized._yay.organization,
			defaultWorkspaceId: authorized._yay.defaultWorkspaceId,
		},
	});
}

/**
 * Whether the caller may hand out every permission of one level on one node.
 *
 * Same rule as everywhere else in access control: nobody gives away what they do not have. It is
 * asked against the node, so a manager of a restricted folder who only has "can view" plus "can
 * manage" cannot turn somebody else into an editor.
 */
async function caller_can_hand_out_level(
	ctx: QueryCtx | MutationCtx,
	args: {
		organization: Doc<"organizations">;
		defaultWorkspaceId: Id<"organizations_workspaces">;
		workspaceId: Id<"organizations_workspaces">;
		node: Doc<"files_nodes">;
		userId: Id<"users">;
		level: access_control_FileShareLevel;
	},
) {
	for (const permission of access_control_FILE_SHARE_LEVELS[args.level].permissions) {
		const allowed = await access_control_db_has_permission(ctx, {
			organizationId: args.organization._id,
			workspaceId: args.workspaceId,
			defaultWorkspaceId: args.defaultWorkspaceId,
			organizationOwnerUserId: args.organization.ownerUserId,
			resource: {
				kind: "file",
				id: String(args.node._id),
				restrictedScopeNodeId: args.node.restrictedScopeNodeId ?? null,
			},
			permission,
			userId: args.userId,
		});
		if (!allowed) {
			return permission;
		}
	}

	return null;
}

/**
 * Check that a principal is somebody, or something, this workspace really has.
 *
 * A grant naming a user who is not a member, or a role that does not exist, would sit in the share
 * list forever showing a name nobody can resolve.
 */
async function validate_principal(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		principal: FileSharePrincipal;
	},
) {
	// Read into a local first: TypeScript narrows a `const`, but not `args.principal`, inside the
	// index callback below.
	const principal = args.principal;

	if (principal.kind === "user") {
		const membership = await ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_active_user_organization_workspace", (q) =>
				q
					.eq("active", true)
					.eq("userId", principal.userId)
					.eq("organizationId", args.organizationId)
					.eq("workspaceId", args.workspaceId),
			)
			.first();
		if (!membership) {
			return Result({ _nay: { message: "This person is not a member of this workspace" } });
		}

		return Result({ _yay: null });
	}

	if (access_control_is_system_role(principal.role)) {
		return Result({ _yay: null });
	}

	const roleId = ctx.db.normalizeId("access_control_roles", principal.role);
	const role = roleId ? await ctx.db.get("access_control_roles", roleId) : null;
	if (!role || role.organizationId !== args.organizationId) {
		return Result({ _nay: { message: "This role does not exist" } });
	}

	return Result({ _yay: null });
}

// #endregion authorization

// #region queries

/**
 * Everything the share dialog shows for one node.
 *
 * It answers for anybody who may read the node, not only for a manager, because "who else can open
 * this" is useful to a reader and is not a secret from somebody already inside.
 */
export const get_node_share_state = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
	},
	returns: v.union(
		v.null(),
		v.object({
			nodeId: v.id("files_nodes"),
			nodeName: v.string(),
			nodeKind: doc(app_convex_schema, "files_nodes").fields.kind,
			/**
			 * The restricted node that decides access here, or `null` when the workspace roles decide.
			 * `isSelf` tells the dialog whether it is looking at the restricted node or at something
			 * inside it, which is the difference between editing the list and only reading it.
			 */
			scope: v.union(
				v.null(),
				v.object({
					nodeId: v.id("files_nodes"),
					name: v.string(),
					path: v.string(),
					isSelf: v.boolean(),
				}),
			),
			/** Whether the caller may change the share list of a node that is already restricted. */
			canManage: v.boolean(),
			/**
			 * Whether the caller may turn this node into a restricted one. Stricter than `canManage`:
			 * restricting writes the caller a `manage` grant, and nobody hands themselves a level they
			 * could not hand to somebody else. A role holding "manage permissions" without write clears
			 * `canManage` and fails this, so the dialog must not offer the action.
			 */
			canRestrict: v.boolean(),
			/**
			 * Whether the dialog may offer roles at all. Naming a role in a share list hands that role
			 * out, so it asks the same question as assigning one, and somebody who only manages this
			 * folder cannot. Which particular roles they may name is judged in the mutation, because that
			 * depends on the role's own permission list.
			 */
			canShareWithRoles: v.boolean(),
			entries: v.array(
				v.object({
					principal: share_principal_validator,
					level: share_level_validator,
				}),
			),
			/** The owner always gets in, and holds no grant, so the dialog shows them as a fixed row. */
			organizationOwnerUserId: v.id("users"),
		}),
	),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return null;
		}

		const authorized = await authorize_node_sharing(ctx, {
			userAuth,
			membershipId: args.membershipId,
			nodeId: args.nodeId,
			permission: "content.read",
		});
		if (authorized._nay) {
			return null;
		}
		const { membership, node, organization, defaultWorkspaceId } = authorized._yay;

		const canManage = await access_control_db_has_permission(ctx, {
			organizationId: organization._id,
			workspaceId: membership.workspaceId,
			defaultWorkspaceId,
			organizationOwnerUserId: organization.ownerUserId,
			resource: {
				kind: "file",
				id: String(node._id),
				restrictedScopeNodeId: node.restrictedScopeNodeId ?? null,
			},
			permission: "content.permissions.manage",
			userId: userAuth.id,
		});

		// Restricting writes the caller a `manage` grant, so it answers to the same ceiling
		// `restrict_node` applies. Asked here so the dialog does not offer a button that always fails.
		// The owner holds no grants and passes every check earlier than this one.
		const canRestrict =
			userAuth.id === organization.ownerUserId ||
			(await caller_can_hand_out_level(ctx, {
				organization,
				defaultWorkspaceId,
				workspaceId: membership.workspaceId,
				node,
				userId: userAuth.id,
				level: "manage",
			})) === null;

		// Same reason as `canRestrict`: do not offer a choice that always fails. Read at the default
		// workspace, like the ceiling itself, because the question is what the caller's organization
		// role contains.
		const organizationPermissions = await access_control_db_resolve_effective_permissions(ctx, {
			organizationId: organization._id,
			workspaceId: defaultWorkspaceId,
			defaultWorkspaceId,
			organizationOwnerUserId: organization.ownerUserId,
			userId: userAuth.id,
		});
		const canShareWithRoles =
			organizationPermissions === "all" || organizationPermissions.has("organization.roles.manage");

		// A pointer at a node that was deleted, or that is no longer restricted, means this node uses
		// workspace access again. Reading the scope node here, instead of trusting the pointer, keeps the
		// dialog saying the same thing the permission check does.
		const scopeNode = node.restrictedScopeNodeId
			? await ctx.db.get("files_nodes", node.restrictedScopeNodeId)
			: null;
		const scopeIsLive =
			scopeNode !== null &&
			scopeNode.restrictedScopeNodeId === scopeNode._id &&
			scopeNode.organizationId === organization._id &&
			scopeNode.workspaceId === membership.workspaceId;

		if (!scopeNode || !scopeIsLive) {
			return {
				nodeId: node._id,
				nodeName: node.name,
				nodeKind: node.kind,
				scope: null,
				canManage,
				canRestrict,
				canShareWithRoles,
				entries: [],
				organizationOwnerUserId: organization.ownerUserId,
			};
		}

		const grants = await db_list_scope_grants(ctx, {
			organizationId: organization._id,
			workspaceId: membership.workspaceId,
			scopeNodeId: scopeNode._id,
		});

		return {
			nodeId: node._id,
			nodeName: node.name,
			nodeKind: node.kind,
			scope: {
				nodeId: scopeNode._id,
				name: scopeNode.name,
				path: scopeNode.path,
				isSelf: scopeNode._id === node._id,
			},
			canManage,
			canRestrict,
			canShareWithRoles,
			entries: group_grants_into_entries(grants),
			organizationOwnerUserId: organization.ownerUserId,
		};
	},
});

// #endregion queries

// #region mutations

export const restrict_node = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "files_sharing_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const authorized = await authorize_node_sharing(ctx, {
			userAuth,
			membershipId: args.membershipId,
			nodeId: args.nodeId,
			permission: "content.permissions.manage",
		});
		if (authorized._nay) {
			return authorized;
		}
		const { membership, node, organization, defaultWorkspaceId } = authorized._yay;

		if (node.restrictedScopeNodeId === node._id) {
			// Already restricted. Answering yes keeps a double click, or two people clicking at once,
			// from reading as an error.
			return Result({ _yay: null });
		}

		const isOwner = userAuth.id === organization.ownerUserId;

		// The grant below is a `manage` grant, and `manage` carries write. Somebody who may choose access
		// but not edit content would walk out of this call able to edit. Same ceiling as handing the level
		// to anybody else. Asked here because it has to be asked twice over: before the patch, since a
		// refusal after one still commits it, and while the node is still open, because once it is
		// restricted a role gives nothing inside it and this would refuse everyone.
		if (!isOwner) {
			const missing = await caller_can_hand_out_level(ctx, {
				organization,
				defaultWorkspaceId,
				workspaceId: membership.workspaceId,
				node,
				userId: userAuth.id,
				level: "manage",
			});
			if (missing) {
				return Result({
					_nay: {
						message: `You cannot give "${access_control_FILE_SHARE_LEVELS["manage"].label}" here: you do not have "${access_control_PERMISSION_CATALOG[missing].label}" on it`,
					},
				});
			}
		}

		const now = Date.now();
		await ctx.db.patch("files_nodes", node._id, { restrictedScopeNodeId: node._id });
		await files_nodes_db_cascade_restricted_scope(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			parentId: node._id,
			scopeNodeId: node._id,
		});

		// The person restricting it has to stay in. A role gives nothing inside a restricted scope, so
		// without this an admin would restrict a folder and lose it in the same click, and only the
		// owner could give it back.
		//
		// The owner is skipped because they already pass every check and hold no docs anywhere in access
		// control. The dialog shows them as a fixed row instead.
		if (!isOwner) {
			await db_set_principal_level(ctx, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				scopeNodeId: node._id,
				principal: { kind: "user", userId: userAuth.id },
				level: "manage",
				grants: [],
				now,
			});
		}

		return Result({ _yay: null });
	},
});

export const unrestrict_node = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "files_sharing_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const authorized = await authorize_node_sharing(ctx, {
			userAuth,
			membershipId: args.membershipId,
			nodeId: args.nodeId,
			permission: "content.permissions.manage",
		});
		if (authorized._nay) {
			return authorized;
		}
		const { membership, node } = authorized._yay;

		if (node.restrictedScopeNodeId !== node._id) {
			return Result({ _nay: { message: "This is not restricted" } });
		}

		// Back to whatever the folder above says. That is usually nothing, and then the workspace roles
		// decide again, but a restricted folder inside another restricted folder falls back to the outer
		// one instead of becoming open to everybody.
		const parentScopeNodeId = await files_nodes_db_resolve_parent_restricted_scope(ctx, {
			parentId: node.parentId,
		});

		await ctx.db.patch("files_nodes", node._id, { restrictedScopeNodeId: parentScopeNodeId });
		await files_nodes_db_cascade_restricted_scope(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			parentId: node._id,
			scopeNodeId: parentScopeNodeId,
		});

		const grants = await db_list_scope_grants(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			scopeNodeId: node._id,
		});
		for (const grant of grants) {
			await ctx.db.delete("access_control_permission_grants", grant._id);
		}

		return Result({ _yay: null });
	},
});

/**
 * Add a person or a role to a restricted node's share list, or change the level they already have.
 *
 * The node has to be the restricted one. Something inside a restricted folder is shared through that
 * folder, and the dialog sends the folder's id for exactly that reason.
 */
export const set_node_share_grant = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
		principal: share_principal_validator,
		level: share_level_validator,
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "files_sharing_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const authorized = await authorize_node_sharing(ctx, {
			userAuth,
			membershipId: args.membershipId,
			nodeId: args.nodeId,
			permission: "content.permissions.manage",
		});
		if (authorized._nay) {
			return authorized;
		}
		const { membership, node, organization, defaultWorkspaceId } = authorized._yay;

		if (node.restrictedScopeNodeId !== node._id) {
			return Result({ _nay: { message: "Restrict this first, then choose who gets access" } });
		}

		// The owner is not in the list and cannot be put in it: they already pass every check, so a row
		// for them would be a switch that changes nothing and a Remove button that lies.
		if (args.principal.kind === "user" && args.principal.userId === organization.ownerUserId) {
			return Result({ _nay: { message: "The organization owner already has full access" } });
		}

		const principalResult = await validate_principal(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			principal: args.principal,
		});
		if (principalResult._nay) {
			return principalResult;
		}

		const grants = await db_list_scope_grants(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			scopeNodeId: node._id,
		});
		const entries = group_grants_into_entries(grants);
		const principalKey = share_principal_key(args.principal);
		const existingEntry = entries.find((entry) => share_principal_key(entry.principal) === principalKey) ?? null;

		// Sharing with a role is handing the role out, so it needs the same permission as handing it to
		// one person. `caller_can_hand_out_level` below only asks what the caller holds on this node; it
		// cannot see that naming a role also changes who may give that role from now on.
		//
		// Only when this raises the role's level here. Lowering it, or setting what it already has,
		// hands out nothing new, the same way removing the role in `remove_node_share_grant` asks for
		// none of this.
		if (
			args.principal.kind === "role" &&
			(!existingEntry ||
				access_control_FILE_SHARE_LEVEL_KEYS.indexOf(args.level) >
					access_control_FILE_SHARE_LEVEL_KEYS.indexOf(existingEntry.level))
		) {
			const blocked = await access_control_db_caller_cannot_share_with_role(ctx, {
				organization,
				defaultWorkspaceId,
				role: args.principal.role,
				userId: userAuth.id,
			});
			if (blocked) {
				return Result({ _nay: blocked });
			}
		}

		const missing = await caller_can_hand_out_level(ctx, {
			organization,
			defaultWorkspaceId,
			workspaceId: membership.workspaceId,
			node,
			userId: userAuth.id,
			level: args.level,
		});
		if (missing) {
			// Name the permission that is actually missing, the way `create_role` and `set_user_role` do.
			// "You cannot give Can edit" leaves the caller guessing which half of the level they lack.
			return Result({
				_nay: {
					message: `You cannot give "${access_control_FILE_SHARE_LEVELS[args.level].label}" here: you do not have "${access_control_PERMISSION_CATALOG[missing].label}" on it`,
				},
			});
		}

		if (!existingEntry && entries.length >= MAX_FILE_SHARE_PRINCIPALS) {
			return Result({
				_nay: { message: `One file or folder can be shared with at most ${MAX_FILE_SHARE_PRINCIPALS} people and roles` },
			});
		}

		// Only a new role entry grows the count the role ceiling has to walk. Changing a level this role
		// already has here writes no new share, so it is not asked about.
		if (args.principal.kind === "role" && !existingEntry) {
			// `args.principal` does not narrow inside the index-builder closure below.
			const role = args.principal.role;
			const roleGrants = await ctx.db
				.query("access_control_permission_grants")
				.withIndex("by_organization_role_workspace_resource", (q) =>
					q.eq("organizationId", membership.organizationId).eq("principalKind", "role").eq("role", role),
				)
				.take(MAX_ROLE_SHARE_GRANT_DOCS);

			// Count shares, not docs: one share writes up to three docs for the same node.
			const sharedNodeIds = new Set(roleGrants.map((grant) => grant.resourceId));
			if (sharedNodeIds.size >= MAX_FILE_SHARES_PER_ROLE) {
				return Result({
					_nay: {
						message: `This role is already on ${MAX_FILE_SHARES_PER_ROLE} share lists, which is the most it can be on. Share with the people instead of the role.`,
					},
				});
			}
		}

		if (
			would_leave_no_manager({
				entries,
				principal: args.principal,
				level: args.level,
				callerIsOwner: userAuth.id === organization.ownerUserId,
			})
		) {
			return Result({
				_nay: { message: "Somebody has to be able to manage this. Give another person or role Can manage first." },
			});
		}

		await db_set_principal_level(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			scopeNodeId: node._id,
			principal: args.principal,
			level: args.level,
			grants,
			now: Date.now(),
		});

		return Result({ _yay: null });
	},
});

/** Take a person or a role off a restricted node's share list. */
export const remove_node_share_grant = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
		principal: share_principal_validator,
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "files_sharing_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const authorized = await authorize_node_sharing(ctx, {
			userAuth,
			membershipId: args.membershipId,
			nodeId: args.nodeId,
			permission: "content.permissions.manage",
		});
		if (authorized._nay) {
			return authorized;
		}
		const { membership, node, organization } = authorized._yay;

		if (node.restrictedScopeNodeId !== node._id) {
			return Result({ _nay: { message: "This is not restricted" } });
		}

		const grants = await db_list_scope_grants(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			scopeNodeId: node._id,
		});
		const entries = group_grants_into_entries(grants);

		// Removing gives nothing away, so it needs no ceiling check, the same way `set_user_role` takes
		// no ceiling when it revokes. It still needs the manager check below, which is about leaving the
		// node repairable, not about how much power the caller has.
		if (
			would_leave_no_manager({
				entries,
				principal: args.principal,
				level: null,
				callerIsOwner: userAuth.id === organization.ownerUserId,
			})
		) {
			return Result({
				_nay: {
					message: "Somebody has to be able to manage this. Give another person or role Can manage first.",
				},
			});
		}

		await db_set_principal_level(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			scopeNodeId: node._id,
			principal: args.principal,
			level: null,
			grants,
			now: Date.now(),
		});

		return Result({ _yay: null });
	},
});

// #endregion mutations
