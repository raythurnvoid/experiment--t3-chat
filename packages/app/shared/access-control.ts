import type { Doc, Id } from "../convex/_generated/dataModel";

/** A role saved in the database: the name of a system role, or the id of a custom role. */
export type access_control_RoleRef = Doc<"access_control_role_assignments">["role"];

/**
 * The system roles you can give to someone. Owner cannot be given this way, and a custom role is an
 * id instead of a name.
 **/
export type access_control_SystemRole = Exclude<access_control_RoleRef, Id<"access_control_roles">>;

export type access_control_Permission = Doc<"access_control_permission_grants">["permission"];
export type access_control_ResourceKind = Doc<"access_control_permission_grants">["resourceKind"];

/**
 * Where a permission works.
 *
 * An `organization` permission works only when the role that gives it is stored on the
 * organization's default workspace. A `workspace` permission works in the workspace where the role
 * is stored.
 */
type PermissionScope = "organization" | "workspace";

/**
 * The groups that permissions are sorted into.
 **/
type PermissionGroup = "Organization" | "Workspaces" | "Content" | "Integrations";

/**
 * Sort rank of each permission group: power over the whole organization first, then the shape of its
 * workspaces, then everyday content, then add-ons.
 *
 * Written as a full map on purpose: a group added to `PermissionGroup` without a rank here is a type
 * error. Without that, the role editor would simply never show that group's permissions.
 */
const PERMISSION_GROUP_ORDER = {
	Organization: 0,
	Workspaces: 1,
	Content: 2,
	Integrations: 3,
} satisfies Record<PermissionGroup, number>;

/** The permission groups the role editor shows, in order. */
export const access_control_PERMISSION_GROUPS = (Object.keys(PERMISSION_GROUP_ORDER) as PermissionGroup[]).sort(
	(a, b) => PERMISSION_GROUP_ORDER[a] - PERMISSION_GROUP_ORDER[b],
);

/**
 * Name and description limits of a custom role. Shared because the role editor puts them on its
 * inputs, so the form stops text the server would refuse anyway.
 **/
export const access_control_MAX_ROLE_NAME_LENGTH = 40;

export const access_control_MAX_ROLE_DESCRIPTION_LENGTH = 200;

/**
 * Display text and scope for every permission. The permission check reads `scope` from here, and the
 * role editor shows `label`, `description` and `group`. So this list is the one place both read
 * from.
 *
 * Every permission here must be checked somewhere in the code. A permission that is not checked yet
 * must be marked with `enforcedBy` naming the milestone that will check it, and arrive with that
 * milestone. A permission the editor offers but nothing checks is a switch that does nothing, which
 * is worse than not offering it at all. Nothing carries the mark today.
 */
export const access_control_PERMISSION_CATALOG = {
	"organization.update": {
		label: "Edit organization",
		description: "Change the organization name and description.",
		group: "Organization",
		scope: "organization",
	},
	"organization.members.manage": {
		label: "Manage organization members",
		description: "Invite people, remove them, and change their role.",
		group: "Organization",
		scope: "organization",
	},
	"organization.roles.manage": {
		label: "Manage custom roles",
		description: "Create, edit, and delete custom roles.",
		group: "Organization",
		scope: "organization",
	},
	"organization.billing.manage": {
		label: "Manage billing",
		description: "Change who pays for this organization.",
		group: "Organization",
		scope: "organization",
	},
	"workspace.create": {
		label: "Create workspace",
		description: "Add new workspaces to the organization.",
		group: "Workspaces",
		scope: "organization",
	},
	"workspace.update": {
		label: "Edit workspace",
		description: "Change the workspace name and description.",
		group: "Workspaces",
		scope: "workspace",
	},
	"workspace.delete": {
		label: "Delete workspace",
		description: "Delete a workspace and everything inside it.",
		group: "Workspaces",
		scope: "workspace",
	},
	"workspace.members.manage": {
		label: "Change roles in a workspace",
		description: "Change what people can do inside one workspace. Cannot invite or remove anyone.",
		group: "Workspaces",
		scope: "workspace",
	},
	"content.read": {
		label: "View workspace content",
		description: "Open and read files, chats, and activity.",
		group: "Content",
		scope: "workspace",
	},
	"content.write": {
		label: "Edit workspace content",
		description: "Create, edit, move, and archive files, send chat messages, and clear activity.",
		group: "Content",
		scope: "workspace",
	},
	"content.permissions.manage": {
		label: "Manage file sharing",
		description: "Restrict files and folders, and choose who can open them.",
		group: "Content",
		scope: "workspace",
	},
	"workspace.plugins.manage": {
		label: "Manage plugins",
		description: "Install, configure, and remove plugins.",
		group: "Integrations",
		scope: "workspace",
	},
} as const satisfies Record<
	access_control_Permission,
	{
		label: string;
		description: string;
		group: PermissionGroup;
		scope: PermissionScope;
		/**
		 * The milestone that will check this permission. Set only while a permission exists in the
		 * catalog but no code checks it yet, and removed by that milestone.
		 */
		enforcedBy?: string;
	}
>;

/**
 * The permissions that some code really checks today. This is exactly the set a custom role may
 * contain. See `enforcedBy` in the catalog for the ones still waiting for their milestone; every
 * permission is enforced today, so this is currently the whole catalog.
 *
 * The name says "enforced", not "grantable", because in this subsystem a "grant" is a doc in
 * `access_control_permission_grants`, and no such doc is involved here.
 */
export const access_control_ENFORCED_PERMISSIONS = (
	Object.keys(access_control_PERMISSION_CATALOG) as access_control_Permission[]
).filter((permission) => !("enforcedBy" in access_control_PERMISSION_CATALOG[permission]));

/**
 * What one person or one role may do on a restricted file or folder.
 *
 * A grant doc carries a single permission, so a level is saved as one doc per permission in
 * `permissions`. The UI only ever shows the level, because "can edit but cannot read" is a state
 * nobody asks for and the level list makes it unreachable.
 *
 * Every level contains the ones before it, so the check for "which level is this" reads the list
 * from the strongest down and stops at the first full match.
 */
export const access_control_FILE_SHARE_LEVELS = {
	read: {
		label: "Can view",
		description: "Open and read this, but change nothing.",
		permissions: ["content.read"],
	},
	write: {
		label: "Can edit",
		description: "Open, change, rename, and move this.",
		permissions: ["content.read", "content.write"],
	},
	manage: {
		label: "Can manage",
		description: "Everything above, plus choose who else gets access.",
		permissions: ["content.read", "content.write", "content.permissions.manage"],
	},
} as const satisfies Record<
	string,
	{ label: string; description: string; permissions: readonly access_control_Permission[] }
>;

export type access_control_FileShareLevel = keyof typeof access_control_FILE_SHARE_LEVELS;

/**
 * The share levels the share dialog offers, weakest first.
 *
 * Read straight off the levels above, so the order lives in exactly one place: the same object that
 * says which permissions each level hands out. A second hand-written list would let the two drift,
 * and the drift is silent — everything that compares two levels compares their position in here, so
 * a level sitting in the wrong slot quietly redefines which change counts as raising access.
 */
export const access_control_FILE_SHARE_LEVEL_KEYS = Object.keys(
	access_control_FILE_SHARE_LEVELS,
) as access_control_FileShareLevel[];

/** Every permission any share level can hand out, so a caller can check them in one pass. */
export const access_control_FILE_SHARE_PERMISSIONS = access_control_FILE_SHARE_LEVELS.manage.permissions;

/**
 * The level a set of granted permissions adds up to, or `null` when they add up to nothing.
 *
 * Read from the strongest level down, so a set holding all three permissions answers `manage` and
 * not `read`. A set that somehow holds only `content.write` answers `null`: no level offers it
 * alone, and treating it as "can edit" would report power the reader does not have.
 */
export function access_control_file_share_level_from_permissions(
	permissions: ReadonlySet<access_control_Permission>,
): access_control_FileShareLevel | null {
	for (const level of [...access_control_FILE_SHARE_LEVEL_KEYS].reverse()) {
		if (access_control_FILE_SHARE_LEVELS[level].permissions.every((permission) => permissions.has(permission))) {
			return level;
		}
	}

	return null;
}

/**
 * The permissions of each system role.
 *
 * They live in code, not in the database. So they cannot end up different from one organization to
 * the next, and changing them never needs a data migration. Only custom roles are stored in the
 * database.
 *
 * Owner is missing on purpose: the user in `organizations.ownerUserId` gets everything directly, and
 * owners have no role assignment doc.
 */
export const access_control_SYSTEM_ROLE_MATRIX = {
	admin: {
		label: "Admin",
		// Everything except billing. Changing the billing mode costs the owner money, so the owner has
		// to give that permission out on purpose.
		permissions: [
			"organization.update",
			"organization.members.manage",
			"organization.roles.manage",
			"workspace.create",
			"workspace.update",
			"workspace.delete",
			"workspace.members.manage",
			"content.read",
			"content.write",
			"content.permissions.manage",
			"workspace.plugins.manage",
		],
	},
	member: {
		label: "Member",
		permissions: ["workspace.create", "workspace.update", "content.read", "content.write"],
	},
	viewer: {
		label: "Viewer",
		permissions: ["content.read"],
	},
	// The keys must be exactly the role names the schema accepts. So a role added here that cannot be
	// saved, or a saved role missing here, is a type error instead of a role nobody can resolve.
} as const satisfies Record<
	access_control_SystemRole,
	{ label: string; permissions: readonly access_control_Permission[] }
>;

export const access_control_SYSTEM_ROLES = Object.keys(
	access_control_SYSTEM_ROLE_MATRIX,
) as Array<access_control_SystemRole>;

/**
 * Names a custom role cannot use, because people would confuse them with the system roles.
 **/
export const access_control_RESERVED_ROLE_NAMES = ["owner", ...access_control_SYSTEM_ROLES] as const;

export function access_control_is_system_role(role: access_control_RoleRef): role is access_control_SystemRole {
	return role in access_control_SYSTEM_ROLE_MATRIX;
}

/**
 * The role of one user, in the shape the UI shows it.
 **/
export type access_control_DisplayRole =
	| { kind: "owner" }
	| { kind: "system"; role: access_control_SystemRole }
	| { kind: "custom"; roleId: Id<"access_control_roles">; name: string };

export function access_control_display_role_label(role: access_control_DisplayRole) {
	switch (role.kind) {
		case "owner":
			return "Owner";
		case "system":
			return access_control_SYSTEM_ROLE_MATRIX[role.role].label;
		case "custom":
			return role.name;
	}
}

/**
 * Sort rank of each system role. Written as a full map on purpose: a role added to
 * `access_control_SYSTEM_ROLE_MATRIX` without a rank here is a type error, instead of quietly
 * sorting last.
 */
const SYSTEM_ROLE_ORDER: Record<access_control_SystemRole, number> = {
	admin: 1,
	member: 2,
	viewer: 4,
};

/**
 * Sort order for member lists: the strongest system role first, then custom roles, then read-only.
 **/
export function access_control_display_role_order(role: access_control_DisplayRole | null) {
	if (!role) {
		return 5;
	}
	switch (role.kind) {
		case "owner":
			return 0;
		case "system":
			return SYSTEM_ROLE_ORDER[role.role];
		case "custom":
			return 3;
	}
}
