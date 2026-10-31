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
//
// One grant names no person, role, or app: "Everyone in this workspace can view" (`principalKind: "workspace"`, set by
// `set_node_workspace_view`). It is not an entry of the list. The dialog shows it as General access.
//
// Keep the imports of this module small. On a cold call Convex loads every file that this module imports,
// even the unused ones. The share dialog waits on these doors, so this module must not import
// files_nodes.ts, files_share_links.ts or files_subtree_ops.ts. scripts/convex-sharing-path-imports.test.ts
// checks this.

import { v } from "convex/values";
import { doc } from "convex-helpers/validators";

import type { Doc, Id } from "./_generated/dataModel.js";
import { query, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import { mutation } from "./functions.ts";
import {
	access_control_create_file_checker,
	access_control_db_authorize_membership,
	access_control_db_authorize_node,
	access_control_db_authorize_service_account_grant,
	access_control_db_caller_cannot_share_with_role,
	access_control_db_extended_chain_allows,
	access_control_db_has_permission,
	access_control_db_resolve_effective_permissions,
	access_control_db_resolve_live_restricted_scope,
	access_control_db_resolve_role_permissions,
	access_control_db_resolve_role_refs,
	access_control_db_set_service_account_grant,
} from "./access_control.ts";
import {
	files_nodes_db_get_plugin_binding_installation_id,
	files_nodes_db_has_plugin_binding,
} from "./files_nodes_db.ts";
import { files_nodes_db_resolve_parent_restricted_scope } from "./files_write_policy_db.ts";
import {
	files_nodes_db_set_extended_scope,
	files_nodes_db_set_restricted_scope,
	files_sharing_db_set_node_public,
} from "./files_sharing_db.ts";
import { files_subtree_ops_db_start_rebuild, files_subtree_ops_STEP_MAX_NODES } from "./files_subtree_ops_rebuild.ts";
import { organizations_db_get_membership } from "./organizations_memberships_db.ts";
import { plugins_db_sync_sandbox_root } from "./plugins_service_accounts.ts";
import { files_media_validation_db_advance_version } from "./files_media_validation.ts";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";
import app_convex_schema from "./schema.ts";
import { convex_error, v_result } from "../server/convex-utils.ts";
import { files_share_links_db_is_selected } from "../server/files-share-links.ts";
import { server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";
import {
	files_saved_placement_db_get_node,
	files_saved_placement_db_get_node_view,
} from "../server/files-saved-placement.ts";
import { Result } from "common/errors-as-values-utils.ts";
import {
	access_control_ADDED_PEOPLE_LEVEL_MESSAGE,
	access_control_FILE_SHARE_LEVEL_KEYS,
	access_control_FILE_SHARE_LEVELS,
	access_control_PERMISSION_CATALOG,
	access_control_FILE_SHARE_PERMISSIONS,
	access_control_file_share_level_from_permissions,
	access_control_is_system_role,
	type access_control_FileShareLevel,
	type access_control_Permission,
	type access_control_GrantPermission,
	type access_control_RoleRef,
} from "../shared/access-control.ts";
import { files_is_inline_media_content_type } from "../shared/files.ts";

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
 * A principal costs up to three docs, one per permission of the `manage` level. The `+ 1` principal is
 * the slot kept for an app account. The last `+ 1` doc is the "Everyone in this workspace can view"
 * grant. It sorts after every other grant in the index, so it must fit, or a read would miss it.
 *
 * The cap exists so a single query can never read an unbounded number of docs, not as a second limit
 * users can hit.
 */
const MAX_FILE_SHARE_GRANT_DOCS = (MAX_FILE_SHARE_PRINCIPALS + 1) * 3 + 1;

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
 * A manual sharing change takes over the reader list without removing its grants.
 * Call only after a real change; saving the same sharing must keep plugin reader sync.
 *
 * A bound area holds no public links: the bind deleted them, and turn-on refuses there. So a detach
 * has no links to delete.
 */
async function db_detach_file_access_binding(args: { ctx: MutationCtx; node: Doc<"files_nodes"> }) {
	const { ctx, node } = args;

	const binding = await ctx.db
		.query("plugins_file_access_bindings")
		.withIndex("by_node", (q) => q.eq("nodeId", node._id))
		.first();
	const externalBinding = await ctx.db
		.query("plugins_external_file_bindings")
		.withIndex("by_node", (q) => q.eq("nodeId", node._id))
		.first();
	if (binding) {
		await ctx.db.delete("plugins_file_access_bindings", binding._id);
	}

	if (externalBinding && externalBinding.detachedAt === null) {
		await ctx.db.patch("plugins_external_file_bindings", externalBinding._id, {
			detachedAt: Date.now(),
			revision: externalBinding.revision + 1,
			updatedAt: Date.now(),
		});
		const grants = await ctx.db
			.query("access_control_permission_grants")
			.withIndex("by_organization_workspace_resource_user_permission", (q) =>
				q
					.eq("organizationId", externalBinding.organizationId)
					.eq("workspaceId", externalBinding.workspaceId)
					.eq("resourceKind", "file")
					.eq("resourceId", String(node._id)),
			)
			.take(MAX_FILE_SHARE_GRANT_DOCS);
		let changed = false;
		const accountPermissions = new Map<Id<"access_control_service_accounts">, Set<access_control_GrantPermission>>();
		for (const grant of grants) {
			if (grant.principalKind === "service_account" && grant.serviceAccountId) {
				const permissions = accountPermissions.get(grant.serviceAccountId) ?? new Set();
				accountPermissions.set(grant.serviceAccountId, permissions.add(grant.permission));
			}
			if (grant.externalPluginMembershipLifetime !== undefined) {
				await ctx.db.patch("access_control_permission_grants", grant._id, {
					externalPluginMembershipLifetime: undefined,
				});
				changed = true;
			}
		}
		// The folder is no longer a plugin output folder, so the account grant becomes a sandbox root.
		for (const [serviceAccountId, permissions] of accountPermissions) {
			const synced = await plugins_db_sync_sandbox_root(ctx, {
				organizationId: externalBinding.organizationId,
				workspaceId: externalBinding.workspaceId,
				serviceAccountId,
				resource: { kind: "file", nodeId: node._id },
				level: access_control_file_share_level_from_permissions(permissions),
			});
			// Do not refuse a sharing change for a plugin limit. The plugin just does not reach the folder.
			if (synced._nay) {
				console.warn("Skipped a sandbox root past the plugin folder cap", { nodeId: node._id, serviceAccountId });
			}
		}
		if (changed) {
			await files_media_validation_db_advance_version(ctx, {
				organizationId: externalBinding.organizationId,
				workspaceId: externalBinding.workspaceId,
			});
		}
	}
}

// #region sharing

/** Written by hand: when you add a level to `access_control_FILE_SHARE_LEVELS`, add it here too. */
const share_level_validator = v.union(v.literal("read"), v.literal("write"), v.literal("manage"));

/**
 * Who a share entry is about. `public` is missing on purpose, so nothing here can write a public grant.
 * A public grant on a restricted folder would open every file inside it. Public file links use their own
 * token table instead (`files_share_links`, written by `set_node_share_link` in `files_share_links.ts`).
 */
const share_principal_validator = v.union(
	v.object({ kind: v.literal("user"), userId: v.id("users") }),
	v.object({ kind: v.literal("service_account"), serviceAccountId: v.id("access_control_service_accounts") }),
	v.object({
		kind: v.literal("role"),
		role: doc(app_convex_schema, "access_control_role_assignments").fields.role,
	}),
);

const share_entry_validator = v.object({
	principal: share_principal_validator,
	level: share_level_validator,
	serviceAccountName: v.union(v.string(), v.null()),
	/** The plugin this account serves here, if any. Its grants are also that plugin's folders. */
	servicePluginName: v.union(v.string(), v.null()),
});

/**
 * What a person, role, or app gets from somewhere other than its own row on this list. Each field is
 * the best level from one source, or null.
 */
const share_coverage_validator = v.object({
	/** From the access the item has without its own list: workspace roles, or the restricted folder above. */
	base: v.union(share_level_validator, v.null()),
	/** From the folders above with added people. These give view or edit only. */
	folder: v.union(v.null(), v.object({ level: share_level_validator, name: v.string() })),
	/** From a role row on this same list that the person or app has. */
	role: v.union(
		v.null(),
		v.object({
			level: share_level_validator,
			role: doc(app_convex_schema, "access_control_role_assignments").fields.role,
		}),
	),
	/** From "Everyone in this workspace can view" on this node. Apps never get it. */
	workspace: v.union(v.literal("read"), v.null()),
});

/**
 * A folder above the node whose people also reach it. `entries` and `workspaceView` are null when the
 * caller may not see them.
 */
const share_inherited_validator = v.object({
	nodeId: v.id("files_nodes"),
	name: v.string(),
	path: v.string(),
	entries: v.union(v.array(share_entry_validator), v.null()),
	/** Whether everyone in the workspace can view that folder. */
	workspaceView: v.union(v.boolean(), v.null()),
});

type FileSharePrincipal =
	| { kind: "user"; userId: Id<"users"> }
	| { kind: "role"; role: access_control_RoleRef }
	| { kind: "service_account"; serviceAccountId: Id<"access_control_service_accounts"> };

/**
 * One string that stands for one principal, so entries can be grouped in a `Map`.
 *
 * The prefix keeps user, role, and service-account IDs apart. `workspace` is the grant behind
 * "Everyone in this workspace can view". It has no id, and it is never an entry.
 */
function share_principal_key(principal: FileSharePrincipal | { kind: "workspace" }) {
	if (principal.kind === "workspace") {
		return "workspace";
	}
	if (principal.kind === "service_account") {
		return `service_account:${principal.serviceAccountId}`;
	}
	return principal.kind === "user" ? `user:${principal.userId}` : `role:${principal.role}`;
}

/**
 * Every grant doc saved on one scope root (restricted or extended), whatever the principal.
 *
 * The index starts with organization, workspace, resource kind and resource id, and `principalKind`
 * only comes after those, so this query returns user, role, and service-account grants together.
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
	if (grant.principalKind === "service_account" && grant.serviceAccountId) {
		return { kind: "service_account", serviceAccountId: grant.serviceAccountId };
	}

	// `public` grants land here. Nothing in this module writes one, and the share dialog has no row
	// that could show it, so it is left out rather than shown as an entry nobody can remove.
	// `workspace` grants land here too: the dialog shows them as General access, not as a row.
	return null;
}

/** Whether a restricted node holds "Everyone in this workspace can view". */
function has_workspace_view(grants: Doc<"access_control_permission_grants">[]) {
	return grants.some((grant) => grant.principalKind === "workspace" && grant.permission === "content.read");
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
		{ principal: FileSharePrincipal; permissions: Set<access_control_GrantPermission> }
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
		/** `workspace` takes only `read` or `null`: callers never give it more. */
		principal: Exclude<FileSharePrincipal, { kind: "service_account" }> | { kind: "workspace" };
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
	const existingByPermission = new Map<access_control_GrantPermission, Doc<"access_control_permission_grants">>();
	for (const grant of args.grants) {
		// `read_grant_principal` leaves the workspace grant out of entries, so match it by kind here.
		const principal =
			grant.principalKind === "workspace" ? { kind: "workspace" as const } : read_grant_principal(grant);
		if (principal && share_principal_key(principal) === key) {
			existingByPermission.set(grant.permission, grant);
		}
	}

	let changed = false;
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
					...(args.principal.kind === "user"
						? { userId: args.principal.userId }
						: args.principal.kind === "role"
							? { role: args.principal.role }
							: {}),
					permission,
					createdAt: args.now,
					updatedAt: args.now,
				});
				changed = true;
			}
			continue;
		}

		if (existing) {
			await ctx.db.delete("access_control_permission_grants", existing._id);
			changed = true;
		}
	}
	if (changed) {
		await files_media_validation_db_advance_version(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
		});
	}
	return changed;
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
 * themselves.
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

	return !args.entries.some(
		(entry) =>
			entry.principal.kind !== "service_account" &&
			entry.level === "manage" &&
			share_principal_key(entry.principal) !== key,
	);
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
		principal: Exclude<FileSharePrincipal, { kind: "service_account" }>;
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
			/** The node's path. The dialog shows it and copies it. */
			nodePath: v.string(),
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
			canShareWithServiceAccounts: v.boolean(),
			serviceGrantableLevels: v.array(share_level_validator),
			/**
			 * What this node is: a restricted root, an item with added people, or an item that only takes
			 * the access of the folders above it.
			 */
			access: v.union(v.literal("restricted_root"), v.literal("extended_root"), v.literal("inherits")),
			/** "Everyone in this workspace can view" on this node. Only a restricted root can have it. */
			workspaceView: v.boolean(),
			/** Whether the caller may add people here. Any item can get added people. */
			canAddPeople: v.boolean(),
			/**
			 * The people on this node itself. Empty for an item that only inherits. `coverage` is null when
			 * the caller cannot manage the node.
			 */
			entries: v.array(
				v.object({ ...share_entry_validator.fields, coverage: v.union(share_coverage_validator, v.null()) }),
			),
			callerUserId: v.id("users"),
			/** What the caller gets from somewhere other than their own row. Null when they cannot manage. */
			callerCoverage: v.union(share_coverage_validator, v.null()),
			/**
			 * The caller's roles here, so the dialog can tell when a role row is their own access. Empty when
			 * they cannot manage.
			 */
			callerRoles: v.array(doc(app_convex_schema, "access_control_role_assignments").fields.role),
			/**
			 * The access the node has without its own list: `null` for the workspace roles, or the restricted
			 * folder above. For a restricted root this is where an unrestrict falls back to.
			 */
			baseScope: v.union(
				v.null(),
				v.object({
					nodeId: v.id("files_nodes"),
					name: v.string(),
					path: v.string(),
					/**
					 * Whether everyone in the workspace can view that folder. The dialog needs it to offer
					 * "can view" here, to warn on unrestrict, and to pick the icon. `null` when the caller may not
					 * read that folder's list.
					 */
					workspaceView: v.union(v.boolean(), v.null()),
				}),
			),
			/** Whether a file inside this restricted folder has a public link. An unrestrict ends it. */
			linksInside: v.boolean(),
			/**
			 * The plugin that decides who reads this node's area. `isSelf` is true when the plugin keeps
			 * this node's own list: a change here then stops the plugin updating it.
			 */
			pluginArea: v.union(v.null(), v.object({ pluginName: v.string(), isSelf: v.boolean() })),
			/**
			 * Where the rest of the access comes from. `restricted` null means everyone in the workspace.
			 * `extended` lists the folders with added people above the node, nearest first.
			 */
			inheritedFrom: v.object({
				restricted: v.union(share_inherited_validator, v.null()),
				extended: v.array(share_inherited_validator),
			}),
			/** The owner always gets in, and holds no grant, so the dialog shows them as a fixed row. */
			organizationOwnerUserId: v.id("users"),
			/**
			 * The file's public link. Only a live manager of the file gets it, because the token opens the
			 * file to anyone who has it.
			 */
			link: v.union(
				v.null(),
				v.object({
					token: doc(app_convex_schema, "files_share_links").fields.token,
					createdBy: doc(app_convex_schema, "files_share_links").fields.createdBy,
					createdAt: doc(app_convex_schema, "files_share_links").fields.createdAt,
				}),
			),
			/**
			 * The public flag of an image or video file: public link pages show it inside a linked file.
			 * Null for a folder and for any other file. `canChange` needs "edit" on the file.
			 */
			public: v.union(
				v.null(),
				v.object({
					isPublic: v.boolean(),
					canChange: v.boolean(),
					mediaKind: v.union(v.literal("image"), v.literal("video")),
				}),
			),
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
		// The owner holds no grants and passes every check earlier than this one. Without manage the
		// answer is no, so skip the check: on a deep path each permission costs a walk of the chain.
		const canRestrict =
			userAuth.id === organization.ownerUserId ||
			(canManage &&
				(await caller_can_hand_out_level(ctx, {
					organization,
					defaultWorkspaceId,
					workspaceId: membership.workspaceId,
					node,
					userId: userAuth.id,
					level: "manage",
				})) === null);

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
		const canShareWithServiceAccounts =
			canManage &&
			(await access_control_db_has_permission(ctx, {
				organizationId: organization._id,
				workspaceId: membership.workspaceId,
				defaultWorkspaceId,
				organizationOwnerUserId: organization.ownerUserId,
				userId: userAuth.id,
				resource: { kind: "workspace", id: membership.workspaceId },
				permission: "workspace.service_accounts.manage",
			}));
		const serviceGrantableLevels: access_control_FileShareLevel[] = [];
		if (canShareWithServiceAccounts) {
			for (const level of access_control_FILE_SHARE_LEVEL_KEYS) {
				// An account can manage only a restricted root. The writer refuses it anywhere else.
				if (level === "manage" && node.restrictedScopeNodeId !== node._id) continue;
				if (
					(await caller_can_hand_out_level(ctx, {
						organization,
						defaultWorkspaceId,
						workspaceId: membership.workspaceId,
						node,
						userId: userAuth.id,
						level,
					})) === null
				) {
					serviceGrantableLevels.push(level);
				}
			}
		}

		// Only a manager of the file gets the token, like `set_node_share_link`. Both ask about the stored
		// scope: a link inside a folder that is being restricted ends when the scope op reaches the file.
		const linkDoc =
			node.kind === "file" && canManage
				? await ctx.db
						.query("files_share_links")
						.withIndex("by_organization_workspace_node", (q) =>
							q.eq("organizationId", organization._id).eq("workspaceId", membership.workspaceId).eq("nodeId", node._id),
						)
						.first()
				: null;
		// A Move keeps the ended link until its cleanup. The public page already refuses it, so show it as off.
		const link =
			linkDoc && (await files_share_links_db_is_selected(ctx.db, linkDoc))
				? { token: linkDoc.token, createdBy: linkDoc.createdBy, createdAt: linkDoc.createdAt }
				: null;
		const publicFlag =
			node.kind === "file" && files_is_inline_media_content_type(node.contentType)
				? {
						isPublic: node.isPublic === true,
						// The checker follows "Add people" too, like `set_node_public`.
						canChange: await access_control_create_file_checker(ctx, {
							organizationId: organization._id,
							workspaceId: membership.workspaceId,
							subject: { kind: "user", userId: userAuth.id, plugin: null },
						}).can(node, "content.write"),
						mediaKind: node.contentType?.startsWith("video/") ? ("video" as const) : ("image" as const),
					}
				: null;

		// The stored pointer can be out of date. Resolving it the same way the permission check does
		// keeps the dialog saying the same thing that check does.
		const scopeNodeId = await access_control_db_resolve_live_restricted_scope(ctx, {
			organizationId: organization._id,
			workspaceId: membership.workspaceId,
			restrictedScopeNodeId: node.restrictedScopeNodeId,
		});
		const scopeNode = scopeNodeId ? await ctx.db.get("files_nodes", scopeNodeId) : null;
		const scopeIsLive = scopeNode !== null && scopeNode.restrictedScopeNodeId === scopeNode._id;
		const access =
			scopeIsLive && scopeNode._id === node._id
				? ("restricted_root" as const)
				: node.parentExtendedScopeNodeId !== undefined
					? ("extended_root" as const)
					: ("inherits" as const);
		// The entries and the workspace view of one node come from the same grants, so read them once.
		const scopeGrants = new Map<Id<"files_nodes">, ReturnType<typeof db_list_scope_grants>>();
		const grants_on = (scopeNodeId: Id<"files_nodes">) => {
			let grants = scopeGrants.get(scopeNodeId);
			if (!grants) {
				grants = db_list_scope_grants(ctx, {
					organizationId: organization._id,
					workspaceId: membership.workspaceId,
					scopeNodeId,
				});
				scopeGrants.set(scopeNodeId, grants);
			}
			return grants;
		};
		const entries_on = async (scopeNodeId: Id<"files_nodes">) =>
			await Promise.all(
				group_grants_into_entries(await grants_on(scopeNodeId)).map(async (entry) => {
					const account =
						entry.principal.kind === "service_account"
							? await ctx.db.get("access_control_service_accounts", entry.principal.serviceAccountId)
							: null;
					const installation = account
						? await ctx.db
								.query("plugins_workspace_installations")
								.withIndex("by_serviceAccount", (q) => q.eq("serviceAccountId", account._id))
								.first()
						: null;
					const version = installation ? await ctx.db.get("plugins_versions", installation.pluginVersionId) : null;
					return {
						...entry,
						serviceAccountName: account?.name ?? null,
						servicePluginName: version?.displayName ?? null,
					};
				}),
			);
		const entries = access === "inherits" ? [] : await entries_on(node._id);
		const workspaceView = access === "restricted_root" && has_workspace_view(await grants_on(node._id));

		// Inherited names only for somebody who reads the whole area: every folder here is in the node's
		// own restricted area (or all open). A person who gets in only through added people must not learn
		// who else reads the folders above. Managing the node is enough too: added people never manage.
		const seesInheritedNames =
			canManage ||
			(await access_control_db_has_permission(ctx, {
				organizationId: organization._id,
				workspaceId: membership.workspaceId,
				defaultWorkspaceId,
				organizationOwnerUserId: organization.ownerUserId,
				resource:
					scopeNode && scopeIsLive
						? { kind: "file", id: String(scopeNode._id), restrictedScopeNodeId: scopeNode._id }
						: { kind: "workspace", id: membership.workspaceId },
				permission: "content.read",
				userId: userAuth.id,
			}));
		const inherited = async (folder: Doc<"files_nodes">) => ({
			nodeId: folder._id,
			name: folder.name,
			path: folder.path,
			entries: seesInheritedNames ? await entries_on(folder._id) : null,
			workspaceView: seesInheritedNames ? has_workspace_view(await grants_on(folder._id)) : null,
		});
		const chainNodes = new Map<Id<"files_nodes">, Doc<"files_nodes">>();
		const extendedFolders: Doc<"files_nodes">[] = [];
		await access_control_db_extended_chain_allows(ctx, {
			organizationId: organization._id,
			workspaceId: membership.workspaceId,
			node,
			get_node: async (nodeId) => {
				const chainNode = await files_saved_placement_db_get_node(ctx.db, nodeId);
				if (chainNode) chainNodes.set(nodeId, chainNode);
				return chainNode;
			},
			// Never stop early: collect every live root above the node.
			root_allows: async (rootId) => {
				if (rootId !== node._id) extendedFolders.push(chainNodes.get(rootId)!);
				return false;
			},
		});
		const inheritedFrom = {
			restricted: scopeNode && scopeIsLive && access !== "restricted_root" ? await inherited(scopeNode) : null,
			extended: await Promise.all(extendedFolders.map(inherited)),
		};

		// The access the node has without its own list. A restricted root falls back to the scope of its
		// parent, like `unrestrict_node` does.
		const baseScopeNodeId =
			access === "restricted_root"
				? await access_control_db_resolve_live_restricted_scope(ctx, {
						organizationId: organization._id,
						workspaceId: membership.workspaceId,
						restrictedScopeNodeId: await files_nodes_db_resolve_parent_restricted_scope(ctx, {
							parentId: node.parentId,
						}),
					})
				: scopeNode && scopeIsLive
					? scopeNode._id
					: null;

		// What each row and the caller get from somewhere else, so the dialog can say "Can manage through
		// workspace role" and warn before a change takes access away. Only a manager can change the list,
		// so only a manager gets it. The reads are bounded: at most 50 entries, each with 2 role reads and 3
		// permission checks, plus the folders above, which are already read, plus one workspace check while
		// Everyone can view is on.
		const baseResource = baseScopeNodeId
			? { kind: "file" as const, id: String(baseScopeNodeId), restrictedScopeNodeId: baseScopeNodeId }
			: { kind: "workspace" as const, id: String(membership.workspaceId) };
		// A manager of a restricted folder inside another one may not open the outer folder. Then send no
		// levels from it: otherwise they could add a person, read the level, and learn the outer list.
		const seesBaseLevels =
			canManage &&
			(access !== "restricted_root" ||
				!baseScopeNodeId ||
				(await access_control_db_has_permission(ctx, {
					organizationId: organization._id,
					workspaceId: membership.workspaceId,
					defaultWorkspaceId,
					organizationOwnerUserId: organization.ownerUserId,
					resource: baseResource,
					permission: "content.read",
					userId: userAuth.id,
				})));
		const baseScopeNode = baseScopeNodeId ? await ctx.db.get("files_nodes", baseScopeNodeId) : null;
		const baseScope = baseScopeNode
			? {
					nodeId: baseScopeNode._id,
					name: baseScopeNode.name,
					path: baseScopeNode.path,
					// Ask the same question as for the names of that folder. For an item that takes its access,
					// `seesInheritedNames` asks about that folder. For a restricted root it asks about the root
					// itself, so use `seesBaseLevels`, which checks the folder above.
					workspaceView: (access === "restricted_root" ? seesBaseLevels : seesInheritedNames)
						? has_workspace_view(await grants_on(baseScopeNode._id))
						: null,
				}
			: null;
		const baseRoleEntries =
			baseScopeNodeId && seesBaseLevels
				? group_grants_into_entries(
						await db_list_scope_grants(ctx, {
							organizationId: organization._id,
							workspaceId: membership.workspaceId,
							scopeNodeId: baseScopeNodeId,
						}),
					)
				: [];
		const level_from = async (has: (permission: access_control_GrantPermission) => Promise<boolean>) => {
			const permissions = new Set<access_control_GrantPermission>();
			for (const permission of access_control_FILE_SHARE_PERMISSIONS) {
				// No read means no level, so skip the other checks.
				if (permission !== "content.read" && !permissions.has("content.read")) break;
				if (await has(permission)) permissions.add(permission);
			}
			return access_control_file_share_level_from_permissions(permissions);
		};
		const level_rank = (level: access_control_FileShareLevel | null) =>
			level ? access_control_FILE_SHARE_LEVEL_KEYS.indexOf(level) : -1;
		const coverage_of = async (principal: FileSharePrincipal) => {
			const checkArgs = {
				organizationId: organization._id,
				workspaceId: membership.workspaceId,
				defaultWorkspaceId,
				organizationOwnerUserId: organization.ownerUserId,
				resource: baseResource,
			};
			let roleRefs: access_control_RoleRef[] = [];
			let base: access_control_FileShareLevel | null;
			if (principal.kind === "user") {
				roleRefs = await access_control_db_resolve_role_refs(ctx, {
					organizationId: organization._id,
					workspaceId: membership.workspaceId,
					defaultWorkspaceId,
					userId: principal.userId,
				});
				base = seesBaseLevels
					? await level_from((permission) =>
							access_control_db_has_permission(ctx, { ...checkArgs, permission, userId: principal.userId }),
						)
					: null;
			} else if (principal.kind === "service_account") {
				const account = await ctx.db.get("access_control_service_accounts", principal.serviceAccountId);
				roleRefs = account?.role !== undefined ? [account.role] : [];
				base = seesBaseLevels
					? await level_from((permission) =>
							access_control_db_has_permission(ctx, {
								...checkArgs,
								permission,
								serviceAccountId: principal.serviceAccountId,
							}),
						)
					: null;
			} else if (baseScopeNodeId) {
				base =
					baseRoleEntries.find((entry) => share_principal_key(entry.principal) === share_principal_key(principal))
						?.level ?? null;
			} else {
				const permissions = await access_control_db_resolve_role_permissions(ctx, {
					organizationId: organization._id,
					role: principal.role,
				});
				base = access_control_file_share_level_from_permissions(
					new Set(access_control_FILE_SHARE_PERMISSIONS.filter((permission) => permissions?.includes(permission))),
				);
			}

			// A row matches its own key, and a person or app also matches the rows of their roles.
			const keys = new Set([
				share_principal_key(principal),
				...roleRefs.map((role) => share_principal_key({ kind: "role", role })),
			]);
			let folder: { level: access_control_FileShareLevel; name: string } | null = null;
			for (const extendedFolder of inheritedFrom.extended) {
				for (const entry of extendedFolder.entries ?? []) {
					if (
						keys.has(share_principal_key(entry.principal)) &&
						level_rank(entry.level) > level_rank(folder?.level ?? null)
					) {
						folder = { level: entry.level, name: extendedFolder.name };
					}
				}
			}
			let role: { level: access_control_FileShareLevel; role: access_control_RoleRef } | null = null;
			for (const entry of entries) {
				if (
					entry.principal.kind === "role" &&
					roleRefs.includes(entry.principal.role) &&
					level_rank(entry.level) > level_rank(role?.level ?? null)
				) {
					role = { level: entry.level, role: entry.principal.role };
				}
			}
			// The same question the permission check asks for a `workspace` grant.
			let workspace: "read" | null = null;
			if (workspaceView && principal.kind === "user") {
				const canRead = await access_control_db_has_permission(ctx, {
					...checkArgs,
					resource: { kind: "workspace", id: String(membership.workspaceId) },
					permission: "content.read",
					userId: principal.userId,
				});
				workspace = canRead ? "read" : null;
			} else if (workspaceView && principal.kind === "role") {
				const rolePermissions = await access_control_db_resolve_role_permissions(ctx, {
					organizationId: organization._id,
					role: principal.role,
				});
				workspace = rolePermissions?.includes("content.read") ? "read" : null;
			}
			return { base, folder, role, workspace };
		};
		const listedEntries = await Promise.all(
			entries.map(async (entry) => ({ ...entry, coverage: canManage ? await coverage_of(entry.principal) : null })),
		);
		const callerCoverage = canManage ? await coverage_of({ kind: "user", userId: userAuth.id }) : null;
		const callerRoles = canManage
			? await access_control_db_resolve_role_refs(ctx, {
					organizationId: organization._id,
					workspaceId: membership.workspaceId,
					defaultWorkspaceId,
					userId: userAuth.id,
				})
			: [];

		// An unrestrict ends the links of the files inside, so the dialog asks first. One read.
		const linksInside =
			canManage &&
			access === "restricted_root" &&
			node.kind === "folder" &&
			(await ctx.db
				.query("files_share_links")
				.withIndex("by_organization_workspace_scope", (q) =>
					q
						.eq("organizationId", organization._id)
						.eq("workspaceId", membership.workspaceId)
						.eq("restrictedScopeNodeId", node._id),
				)
				.first()) !== null;

		// A plugin decides who reads a bound area. On the bound folder a change stops that, and an item
		// inside it cannot be restricted, like `restrict_node` refuses.
		const pluginInstallationId =
			scopeNode && scopeIsLive ? await files_nodes_db_get_plugin_binding_installation_id(ctx, scopeNode._id) : null;
		const pluginInstallation = pluginInstallationId
			? await ctx.db.get("plugins_workspace_installations", pluginInstallationId)
			: null;
		const pluginVersion = pluginInstallation
			? await ctx.db.get("plugins_versions", pluginInstallation.pluginVersionId)
			: null;
		const pluginArea =
			scopeNode && pluginVersion ? { pluginName: pluginVersion.displayName, isSelf: scopeNode._id === node._id } : null;

		if (!scopeNode || !scopeIsLive) {
			return {
				nodeId: node._id,
				nodeName: node.name,
				nodePath: node.path,
				nodeKind: node.kind,
				scope: null,
				canManage,
				canRestrict,
				canShareWithRoles,
				canShareWithServiceAccounts,
				serviceGrantableLevels,
				access,
				workspaceView,
				canAddPeople: canManage,
				entries: listedEntries,
				callerUserId: userAuth.id,
				callerCoverage,
				callerRoles,
				baseScope,
				linksInside,
				pluginArea,
				inheritedFrom,
				organizationOwnerUserId: organization.ownerUserId,
				link,
				public: publicFlag,
			};
		}

		return {
			nodeId: node._id,
			nodeName: node.name,
			nodePath: node.path,
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
			canShareWithServiceAccounts,
			serviceGrantableLevels,
			access,
			workspaceView,
			canAddPeople: canManage,
			entries: listedEntries,
			callerUserId: userAuth.id,
			callerCoverage,
			callerRoles,
			baseScope,
			linksInside,
			pluginArea,
			inheritedFrom,
			organizationOwnerUserId: organization.ownerUserId,
			link,
			public: publicFlag,
		};
	},
});

/**
 * Add a person or a role to a node's share list, or change the level they already have.
 *
 * On a restricted node this edits who may open it. On any other node it adds people ("Add people"):
 * the node becomes an extended root, and its added people also get everything inside it, except
 * restricted items inside it. Everybody who had access before keeps it.
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
		if (args.principal.kind === "service_account") {
			const resource = { kind: "file" as const, nodeId: node._id };
			const allowed = await access_control_db_authorize_service_account_grant(ctx, {
				userAuth,
				membership,
				resource,
				level: args.level,
			});
			if (allowed._nay) {
				return allowed;
			}
			const result = await access_control_db_set_service_account_grant(ctx, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				serviceAccountId: args.principal.serviceAccountId,
				resource,
				level: args.level,
			});
			return result._nay ? result : Result({ _yay: null });
		}
		if (args.level === "manage" && node.restrictedScopeNodeId !== node._id) {
			return Result({ _nay: { message: access_control_ADDED_PEOPLE_LEVEL_MESSAGE } });
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
				_nay: {
					message: `One file or folder can be shared with at most ${MAX_FILE_SHARE_PRINCIPALS} people and roles`,
				},
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
				.filter((q) => q.eq(q.field("resourceKind"), "file"))
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

		// Every refusal is above this line, so a refused share leaves no extended root behind.
		const now = Date.now();
		if (node.restrictedScopeNodeId !== node._id && node.parentExtendedScopeNodeId === undefined) {
			await files_nodes_db_set_extended_scope(ctx, { nodeId: node._id, extended: true });
			// An op gives the items inside the new chain. Its first step runs here, so a small folder is done now,
			// unless a Move holds the workspace.
			await files_subtree_ops_db_start_rebuild(ctx, {
				kind: "scope",
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: userAuth.id,
				membership,
				roots: [{ node, oldTreePath: node.treePath }],
				budget: { nodes: files_subtree_ops_STEP_MAX_NODES, hasPaginated: false },
				now,
			});
		}

		const changed = await db_set_principal_level(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			scopeNodeId: node._id,
			principal: args.principal,
			level: args.level,
			grants,
			now,
		});
		if (changed) {
			await db_detach_file_access_binding({ ctx, node });
		}

		return Result({ _yay: null });
	},
});

/**
 * Take a person, a role or an account off a node's share list.
 *
 * When the last one leaves an extended root, the item stops being one and inherits again.
 */
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
		if (args.principal.kind === "service_account") {
			const resource = { kind: "file" as const, nodeId: node._id };
			const allowed = await access_control_db_authorize_service_account_grant(ctx, {
				userAuth,
				membership,
				resource,
				level: null,
			});
			if (allowed._nay) {
				return allowed;
			}
			const result = await access_control_db_set_service_account_grant(ctx, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				serviceAccountId: args.principal.serviceAccountId,
				resource,
				level: null,
			});
			if (result._nay) {
				return result;
			}
		} else {
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

			const changed = await db_set_principal_level(ctx, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				scopeNodeId: node._id,
				principal: args.principal,
				level: null,
				grants,
				now: Date.now(),
			});
			if (changed) {
				await db_detach_file_access_binding({ ctx, node });
			}
		}

		if (node.parentExtendedScopeNodeId !== undefined) {
			// Read after the delete above. A mutation sees its own writes.
			const left = await db_list_scope_grants(ctx, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				scopeNodeId: node._id,
			});
			if (left.length === 0) {
				await files_nodes_db_set_extended_scope(ctx, { nodeId: node._id, extended: false });
				await files_subtree_ops_db_start_rebuild(ctx, {
					kind: "scope",
					organizationId: membership.organizationId,
					workspaceId: membership.workspaceId,
					userId: userAuth.id,
					membership,
					roots: [{ node, oldTreePath: node.treePath }],
					budget: { nodes: files_subtree_ops_STEP_MAX_NODES, hasPaginated: false },
					now: Date.now(),
				});
			}
		}

		return Result({ _yay: null });
	},
});

// #endregion sharing

// #region scope restriction

/**
 * Restrict a node that is not restricted yet, for `restrict_node` and `set_node_workspace_view`.
 * The caller already checked `content.permissions.manage` on the node. Every refusal comes before
 * the first write, so a refusal leaves the node as it was.
 */
async function db_restrict_node(
	ctx: MutationCtx,
	args: {
		userAuth: { id: Id<"users"> };
		membership: Doc<"organizations_workspaces_users">;
		node: Doc<"files_nodes">;
		organization: Doc<"organizations">;
		defaultWorkspaceId: Id<"organizations_workspaces">;
	},
) {
	const { userAuth, membership, node, organization, defaultWorkspaceId } = args;

	// A plugin decides who reads the whole bound area. A restricted item inside would leave that list.
	// While a Move holds the item, the area it moves into counts too: the Move checked it before this restrict.
	const moveView = await files_saved_placement_db_get_node_view(ctx.db, node._id);
	const moved = moveView
		? await files_saved_placement_db_get_node(ctx.db, node._id, { cohortId: moveView.cohortId, view: "after" })
		: null;
	for (const scopeNodeId of [node.restrictedScopeNodeId, moved?.restrictedScopeNodeId]) {
		if (scopeNodeId && (await files_nodes_db_has_plugin_binding(ctx, scopeNodeId))) {
			return Result({
				_nay: { message: "A plugin decides who can read this item, so it cannot be restricted on its own" },
			});
		}
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

	// Restricting keeps the people, roles, and service accounts added here, so the list stays the one
	// the dialog showed. The person restricting it joins the list below, so a full list has no room
	// for them.
	const grants = await db_list_scope_grants(ctx, {
		organizationId: membership.organizationId,
		workspaceId: membership.workspaceId,
		scopeNodeId: node._id,
	});
	const entries = group_grants_into_entries(grants);
	const callerKey = share_principal_key({ kind: "user", userId: userAuth.id });
	if (
		!isOwner &&
		entries.length >= MAX_FILE_SHARE_PRINCIPALS &&
		!entries.some((entry) => share_principal_key(entry.principal) === callerKey)
	) {
		return Result({
			_nay: {
				message: `This list already has ${MAX_FILE_SHARE_PRINCIPALS} people, roles, and apps, the most it can hold. Remove one first.`,
			},
		});
	}

	const now = Date.now();
	await db_detach_file_access_binding({ ctx, node });
	await files_nodes_db_set_restricted_scope({
		ctx,
		organizationId: membership.organizationId,
		workspaceId: membership.workspaceId,
		nodeId: node._id,
		restrictedScopeNodeId: node._id,
	});
	// The root changes even when the folder is empty and no op starts.
	await files_media_validation_db_advance_version(ctx, {
		organizationId: membership.organizationId,
		workspaceId: membership.workspaceId,
	});
	// An op gives the descendants the new scope. Its first step runs here, so a small folder is done now,
	// unless a Move holds the workspace.
	await files_subtree_ops_db_start_rebuild(ctx, {
		kind: "scope",
		organizationId: membership.organizationId,
		workspaceId: membership.workspaceId,
		userId: userAuth.id,
		membership,
		roots: [{ node, oldTreePath: node.treePath }],
		budget: { nodes: files_subtree_ops_STEP_MAX_NODES, hasPaginated: false },
		now,
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
			// Pass the kept grants, so a caller who was already listed gets no second copy of a permission.
			grants,
			now,
		});
	}

	return Result({ _yay: null });
}

/**
 * "Only people added": the item stops taking the access of the workspace or of the folder above.
 */
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
		const { node } = authorized._yay;
		if (node.restrictedScopeNodeId === node._id) {
			// Already restricted. Answering yes keeps a double click, or two people clicking at once,
			// from reading as an error.
			return Result({ _yay: null });
		}

		return await db_restrict_node(ctx, { userAuth, ...authorized._yay });
	},
});

/**
 * Turn "Everyone in this workspace can view" on or off for one item.
 *
 * Turning it on restricts the item first when it is open, in the same transaction, so nobody loses access in
 * between. Then each member reads it when their own workspace access could read an open item, and
 * only the people on the list can change it. Turning it off keeps the item restricted ("Only people added").
 *
 * Only an item whose folder above lets the whole workspace in may turn it on: an open folder, or a
 * restricted folder that has this setting on too. Inside any other restricted folder it would open the
 * item past that folder's list, like naming every role, and the new readers could not browse to it
 * through the locked folder. So the dialog offers people and roles there instead. This is a product
 * guard, checked only here: an item stays open to the workspace when the folder above stops letting
 * the workspace in later.
 */
export const set_node_workspace_view = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
		enabled: v.boolean(),
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
		const isRestrictedRoot = node.restrictedScopeNodeId === node._id;

		const grantsBefore = isRestrictedRoot
			? await db_list_scope_grants(ctx, {
					organizationId: membership.organizationId,
					workspaceId: membership.workspaceId,
					scopeNodeId: node._id,
				})
			: [];
		// Already so. A double click must not read as an error. Turning it off on an item that is not
		// restricted lands here too: such an item has no grant to remove.
		if (has_workspace_view(grantsBefore) === args.enabled) {
			return Result({ _yay: null });
		}

		if (args.enabled) {
			const parentScopeNodeId = await access_control_db_resolve_live_restricted_scope(ctx, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				restrictedScopeNodeId: await files_nodes_db_resolve_parent_restricted_scope(ctx, {
					parentId: node.parentId,
				}),
			});
			const parentLetsWorkspaceIn =
				!parentScopeNodeId ||
				has_workspace_view(
					await db_list_scope_grants(ctx, {
						organizationId: membership.organizationId,
						workspaceId: membership.workspaceId,
						scopeNodeId: parentScopeNodeId,
					}),
				);
			if (!parentLetsWorkspaceIn) {
				return Result({
					_nay: {
						message:
							"This is inside a restricted folder, so it cannot be opened to the whole workspace. Add people or roles instead.",
					},
				});
			}

			if (!isRestrictedRoot) {
				const restricted = await db_restrict_node(ctx, { userAuth, ...authorized._yay });
				if (restricted._nay) {
					return restricted;
				}
			}
		}

		// Read after the restrict above. A mutation sees its own writes.
		const grants = await db_list_scope_grants(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			scopeNodeId: node._id,
		});
		await db_set_principal_level(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			scopeNodeId: node._id,
			principal: { kind: "workspace" },
			level: args.enabled ? "read" : null,
			grants,
			now: Date.now(),
		});
		// A manual change takes the list over from a plugin. The restrict above already did this when it ran.
		if (isRestrictedRoot) {
			await db_detach_file_access_binding({ ctx, node });
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

		await db_detach_file_access_binding({ ctx, node });
		await files_nodes_db_set_restricted_scope({
			ctx,
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			nodeId: node._id,
			restrictedScopeNodeId: parentScopeNodeId,
		});
		await files_media_validation_db_advance_version(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
		});

		const grants = await db_list_scope_grants(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			scopeNodeId: node._id,
		});
		// The list stays, so the item keeps its people, roles, and service accounts as added people: it
		// becomes an extended root. Added people can view or edit only, so a kept manage becomes edit.
		if (group_grants_into_entries(grants).length > 0) {
			await files_nodes_db_set_extended_scope(ctx, { nodeId: node._id, extended: true });
		}
		for (const grant of grants) {
			// An open item lets the workspace in anyway. Kept, the grant would come back with the next restrict.
			if (grant.principalKind === "workspace") {
				await ctx.db.delete("access_control_permission_grants", grant._id);
				continue;
			}
			if (grant.permission !== "content.permissions.manage") continue;
			// Service account grants go through the account writer, so the plugin folders stay in sync.
			// A revoked account cannot get a new level, so its grant goes.
			if (grant.principalKind === "service_account" && grant.serviceAccountId) {
				const account = await ctx.db.get("access_control_service_accounts", grant.serviceAccountId);
				const lowered = await access_control_db_set_service_account_grant(ctx, {
					organizationId: membership.organizationId,
					workspaceId: membership.workspaceId,
					serviceAccountId: grant.serviceAccountId,
					resource: { kind: "file", nodeId: node._id },
					level: account?.revokedAt === null ? "write" : null,
				});
				if (lowered._nay) throw convex_error(lowered._nay);
				continue;
			}
			// A manage level is the edit docs plus this one, so deleting it leaves edit.
			await ctx.db.delete("access_control_permission_grants", grant._id);
		}

		// One op gives the items inside both the new scope and the new chain.
		await files_subtree_ops_db_start_rebuild(ctx, {
			kind: "scope",
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: userAuth.id,
			membership,
			roots: [{ node, oldTreePath: node.treePath }],
			budget: { nodes: files_subtree_ops_STEP_MAX_NODES, hasPaginated: false },
			now: Date.now(),
		});

		return Result({ _yay: null });
	},
});

// #endregion scope restriction

// #region public flag

/**
 * Turn the public flag of one file on or off. Both need "edit" on the file: a person who can edit an
 * image can already upload a copy of it into a linked document.
 */
export const set_node_public = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.id("files_nodes"),
		enabled: v.boolean(),
	},
	returns: v_result({ _yay: v.object({ public: v.boolean() }) }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "files_sharing_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		// An anonymous account cannot publish, like the public link.
		if (args.enabled && userAuth.isAnonymous) {
			return Result({ _nay: { message: "Sign in to make files public" } });
		}

		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const node = await files_saved_placement_db_get_node(ctx.db, args.nodeId);
		if (!node || node.organizationId !== membership.organizationId || node.workspaceId !== membership.workspaceId) {
			return Result({ _nay: { message: "Not found" } });
		}

		const authorized = await access_control_db_authorize_membership(ctx, { userAuth, membership, permission: null });
		if (authorized._nay) {
			return authorized;
		}
		// The checker follows "Add people" too, so a person added to the file with Can edit may change it.
		const checker = access_control_create_file_checker(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			subject: { kind: "user", userId: userAuth.id, plugin: null },
		});
		if (!(await checker.can(node, "content.write"))) {
			return Result({ _nay: { message: "Permission denied" } });
		}
		// Nobody publishes content they cannot read themselves.
		if (args.enabled && !(await checker.can(node, "content.read"))) {
			return Result({
				_nay: {
					message: `You need "${access_control_PERMISSION_CATALOG["content.read"].label}" on this file to make it public`,
				},
			});
		}

		return await files_sharing_db_set_node_public(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			node,
			enabled: args.enabled,
		});
	},
});

// #endregion public flag
