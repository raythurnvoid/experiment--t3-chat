// Human authority changes update Files resolver clocks, Messages summaries and personal plugin
// grants. Each has its own field set. Plugin readers use applied grants while their worker catches up.
// Account grants and account roles are not human authority. Credential checks stay separate.
// Saved `find --content-type` frames still cover people only. Add account authority fields before
// allowing accounts or plugins to start those queries.
//
// Messages totals take the smallest reset that stays correct. A share on a file rechecks only that
// file's comment channel. A file or folder change goes through `files_access_version_messages_route`.
//
// A role, a share with one person, or a returning membership repairs only that member. An
// organization role is stored on the default workspace, so it repairs that user in every workspace.
// Shares with a role or with "Everyone in this workspace", roles themselves and tenant changes still
// reset the workspace or organization totals.

import type { Id, TableNames } from "../convex/_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "../convex/_generated/server.js";
import { should_never_happen } from "../shared/shared-utils.ts";
import {
	channels_notifications_db_advance_authority,
	channels_notifications_db_advance_member_authority,
	channels_notifications_db_enqueue_access,
	channels_notifications_db_enqueue_member_authority,
} from "./channels-notifications.ts";
import { plugins_file_grants_db_advance_authority } from "./plugins-file-grants.ts";

const FIELDS: Partial<Record<TableNames, readonly string[]>> = {
	organizations: ["ownerUserId", "defaultWorkspaceId"],
	organizations_workspaces: ["organizationId"],
	access_control_roles: ["organizationId", "permissions"],
	access_control_role_assignments: ["organizationId", "workspaceId", "userId", "role"],
	access_control_permission_grants: [
		"organizationId",
		"workspaceId",
		"resourceKind",
		"resourceId",
		"principalKind",
		"userId",
		"role",
		"permission",
	],
	organizations_workspaces_users: ["organizationId", "workspaceId", "userId", "active"],
	organizations_membership_lifetimes: ["organizationId", "workspaceId", "userId", "membershipId", "lifetime", "active"],
	files_nodes: [
		"organizationId",
		"workspaceId",
		"restrictedScopeNodeId",
		"extendedScopeNodeId",
		"parentExtendedScopeNodeId",
	],
	files_saved_places: [
		"organizationId",
		"workspaceId",
		"restrictedScopeNodeId",
		"extendedScopeNodeId",
		"parentExtendedScopeNodeId",
	],
};

const MESSAGES_FILE_FIELDS = [
	"organizationId",
	"workspaceId",
	"kind",
	"restrictedScopeNodeId",
	"extendedScopeNodeId",
	"parentExtendedScopeNodeId",
];
const MESSAGES_FIELDS = {
	...FIELDS,
	// Messages access checks never read membership lifetimes.
	organizations_membership_lifetimes: undefined,
	files_nodes: [...MESSAGES_FILE_FIELDS, "moveCohortId"],
	files_saved_places: [...MESSAGES_FILE_FIELDS, "cohortId", "view"],
};

const PLUGIN_FILE_FIELDS = [...MESSAGES_FILE_FIELDS, "isRestrictedScopeRoot", "treePath", "archiveOperationId"];
const PLUGIN_FIELDS: Partial<Record<TableNames, readonly string[]>> = {
	...FIELDS,
	organizations_workspaces: ["organizationId", "pluginDataPurgeStartedAt"],
	organizations_workspaces_users: [...FIELDS.organizations_workspaces_users!, "pendingOrganizationRemoval"],
	files_nodes: [...PLUGIN_FILE_FIELDS, "moveCohortId"],
	files_saved_places: [...PLUGIN_FILE_FIELDS, "cohortId", "view"],
	files_move_cohorts: ["visibleView"],
	plugins_file_consents: ["requestedLevel", "revision", "open"],
};

/**
 * Batch mutations are sized close to the Convex limits without counting the Messages flush. So past
 * this many changed files and members in one mutation, each further change resets the shared totals
 * of its scope instead. That is one write per scope, and it is always correct.
 *
 * Count the whole mutation, not each workspace. Owner account deletion deletes the grants of many
 * workspaces in one mutation. The node reads for shares stop at the same number.
 *
 * Keep it above `files_subtree_ops_STEP_MAX_NODES` (75), so a scope job step still rechecks single
 * file channels.
 */
const MESSAGES_CHANGE_LIMIT = 100;

type Fields = Record<string, unknown>;
type Scope = { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces"> | null };

/**
 * Messages ignores names, content and archive changes, including during a Move.
 */
function files_access_version_messages_file_changed(before: Fields | null, after: Fields | null) {
	return (
		(before === null) !== (after === null) || MESSAGES_FILE_FIELDS.some((field) => before?.[field] !== after?.[field])
	);
}

/**
 * Where a file or folder change goes for Messages totals. A file rechecks only its own comment
 * channel. A folder that other items read access through resets the workspace totals: a restricted
 * root, a former root whose scope job still runs, or an "Add people" root. Two kinds of items change
 * access with such a folder and get no write of their own, and no index finds them.
 *
 * The live items under a moved "Add people" root keep their pointer at the root. They get the people
 * of the root's new chain.
 *
 * A Trash item that no scope job has reached yet still points at the folder. Its access follows that
 * pointer through the folder.
 *
 * A plain folder does nothing, because the files inside get their own writes: a scope job writes its
 * live items and its Trash items. The first Restrict or "Add people" of a plain folder does nothing
 * too: no item can point at a folder that was never a root.
 */
export function files_access_version_messages_route(before: Fields | null, after: Fields | null, nodeId: string) {
	if (!files_access_version_messages_file_changed(before, after)) return null;
	if (before?.kind === "folder")
		return before.restrictedScopeNodeId === nodeId ||
			before.parentScopeNodeId !== undefined ||
			before.extendedScopeNodeId === nodeId
			? "workspace"
			: null;
	return before?.kind === "file" || after?.kind === "file" ? "file" : null;
}

/**
 * Missing clocks mean no captured authority write yet. Keep doc identity as well as revision, so
 * deleting and recreating a clock cannot revive an old permission answer.
 */
export async function files_access_version_db_get(
	db: QueryCtx["db"],
	args: { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces"> },
) {
	const pins = [];
	for (const workspaceId of [null, args.workspaceId]) {
		const doc = await db
			.query("files_access_versions")
			.withIndex("by_organization_workspace", (q) =>
				q.eq("organizationId", args.organizationId).eq("workspaceId", workspaceId),
			)
			.unique();
		pins.push(doc ? { id: doc._id, revision: doc.revision } : null);
	}
	return pins;
}

/**
 * Capture actual authority changes once per scope, file or member in a mutation. This avoids both a global hot
 * counter and clock writes for profile edits, file content, metadata, or unchanged patches.
 */
export function files_access_version_db_wrap(ctx: MutationCtx) {
	const scopes = new Map<string, Scope>();
	const messageScopes = new Map<string, Scope>();
	const messageNodes = new Map<string, Parameters<typeof channels_notifications_db_enqueue_access>[1]>();
	const messageMembers = new Map<
		string,
		{
			organizationId: Id<"organizations">;
			workspaceId: Id<"organizations_workspaces">;
			userId: Id<"users">;
			roleAssignment: boolean;
		}
	>();
	let messageCount = 0;
	let grantNodeReads = 0;
	const pluginScopes = new Map<string, Scope>();
	const raw = ctx.db;
	function mark(kind: "files" | "messages" | "plugins", table: TableNames, value: Fields | null, id: string) {
		if (!value) return;
		if (
			table === "access_control_permission_grants" &&
			(value.principalKind === "service_account" ||
				(kind === "plugins"
					? !["content.read", "content.write", "content.permissions.manage"].includes(String(value.permission)) ||
						!["organization", "workspace", "file"].includes(String(value.resourceKind))
					: value.permission !== "content.read"))
		)
			return;
		const organizationId = raw.normalizeId(
			"organizations",
			table === "organizations" ? id : String(value.organizationId),
		);
		if (!organizationId) return;
		const organizationScope =
			table === "organizations" || table === "access_control_roles" || table === "access_control_role_assignments";
		const workspaceId = organizationScope
			? null
			: raw.normalizeId(
					"organizations_workspaces",
					table === "organizations_workspaces" ? id : String(value.workspaceId),
				);
		if (!organizationScope && !workspaceId) return;
		const scope = { organizationId, workspaceId };
		const into = kind === "files" ? scopes : kind === "messages" ? messageScopes : pluginScopes;
		into.set(JSON.stringify(scope), scope);
	}
	// Count one more changed file or member in this mutation. Past the limit, record the shared reset
	// of `scope` and return true.
	function over_limit(scope: Scope) {
		messageCount += 1;
		if (messageCount <= MESSAGES_CHANGE_LIMIT) return false;
		messageScopes.set(JSON.stringify(scope), scope);
		return true;
	}
	function mark_node(value: Fields, nodeId: string) {
		const organizationId = raw.normalizeId("organizations", String(value.organizationId));
		const workspaceId = raw.normalizeId("organizations_workspaces", String(value.workspaceId));
		const fileNodeId = raw.normalizeId("files_nodes", nodeId);
		if (!organizationId || !workspaceId || !fileNodeId || messageNodes.has(fileNodeId)) return;
		if (!over_limit({ organizationId, workspaceId }))
			messageNodes.set(fileNodeId, { organizationId, workspaceId, fileNodeId });
	}
	function mark_member(value: Fields, roleAssignment: boolean) {
		const organizationId = raw.normalizeId("organizations", String(value.organizationId));
		const workspaceId = raw.normalizeId("organizations_workspaces", String(value.workspaceId));
		const userId = raw.normalizeId("users", String(value.userId));
		const key = `${workspaceId}:${userId}`;
		if (!organizationId || !workspaceId || !userId) return;
		const marked = messageMembers.get(key);
		// A role assignment and a share can name the same member. Keep the wider repair.
		if (marked) {
			marked.roleAssignment ||= roleAssignment;
			return;
		}
		// A role assignment can be an organization role, which works in every workspace. So past the
		// limit it resets the organization. A share or a returning membership changes one workspace.
		if (!over_limit({ organizationId, workspaceId: roleAssignment ? null : workspaceId }))
			messageMembers.set(key, { organizationId, workspaceId, userId, roleAssignment });
	}
	async function mark_messages(table: TableNames, old: Fields | null, next: Fields | null, id: string) {
		// A new member has no summary yet, and removal deletes the summary of a member who leaves.
		// So only a returning member needs a repair.
		if (table === "organizations_workspaces_users") {
			if (old?.active === false && next?.active === true) mark_member(next, false);
			return;
		}
		for (const value of [old, next]) {
			if (!value) continue;
			if (table === "access_control_role_assignments") {
				mark_member(value, true);
				continue;
			}
			if (table === "access_control_permission_grants") {
				// Messages checks people only. Public links and plugin data never open a conversation.
				// Skip the grant once a shared reset already covers it.
				if (
					value.permission !== "content.read" ||
					value.principalKind === "public" ||
					value.principalKind === "service_account" ||
					value.resourceKind === "plugin_scope" ||
					value.resourceKind === "plugin_installation" ||
					messageScopes.has(JSON.stringify({ organizationId: value.organizationId, workspaceId: null })) ||
					messageScopes.has(JSON.stringify({ organizationId: value.organizationId, workspaceId: value.workspaceId }))
				)
					continue;
				// A share on a file changes who can read only that file's comment channel.
				if (value.resourceKind === "file") {
					// Count the read below before it starts. A batch can delete many grants at once
					// (`Promise.all`), and then every grant passes the check above before any is marked.
					grantNodeReads += 1;
					if (grantNodeReads > MESSAGES_CHANGE_LIMIT) {
						mark("messages", table, value, id);
						continue;
					}
					const nodeId = raw.normalizeId("files_nodes", String(value.resourceId));
					const node = nodeId ? await raw.get("files_nodes", nodeId) : null;
					if (node?.kind === "file") {
						mark_node(value, node._id);
						continue;
					}
				}
				// A share with one person changes only what that person can read in its workspace.
				if (value.principalKind === "user") {
					mark_member(value, false);
					continue;
				}
			}
			mark("messages", table, value, id);
		}
	}
	async function selected_place(value: Fields | null) {
		if (!value) return null;
		const cohort = await raw.get("files_move_cohorts", value.cohortId as Id<"files_move_cohorts">);
		return cohort?.visibleView === value.view ? value : null;
	}
	const db = new Proxy(raw, {
		get(target, property) {
			if (property === "insert")
				return async (table: TableNames, value: Fields) => {
					const id = await target.insert(table, value as never);
					// A new file has a new identity. No previous answer can name its scope pointer.
					if (FIELDS[table] && table !== "files_nodes" && table !== "files_saved_places") {
						mark("files", table, value, id);
						if (MESSAGES_FIELDS[table]) await mark_messages(table, null, value, id);
					}
					if (
						PLUGIN_FIELDS[table] &&
						table !== "files_nodes" &&
						table !== "files_saved_places" &&
						table !== "files_move_cohorts" &&
						(table !== "plugins_file_consents" || value.open === true)
					)
						mark("plugins", table, value, id);
					return id;
				};
			if (property === "patch" || property === "replace" || property === "delete")
				return async (...args: unknown[]) => {
					const write = Reflect.get(target, property) as (...args: unknown[]) => Promise<void>;
					const tableFirst = args.length === (property === "delete" ? 2 : 3);
					if (!tableFirst) {
						for (const table of Object.keys(PLUGIN_FIELDS) as TableNames[])
							if (raw.normalizeId(table, String(args[0])))
								throw should_never_happen("Authority writes must name their table", { table, id: args[0] });
						return await Reflect.apply(write, target, args);
					}
					const table = args[0] as TableNames;
					const id = args[1] as Id<TableNames>;
					const fields = FIELDS[table];
					const messageFields = MESSAGES_FIELDS[table];
					const pluginFields = PLUGIN_FIELDS[table];
					const value = property === "delete" ? null : (args[2] as Fields);
					const captureFiles = fields && (property !== "patch" || fields.some((field) => field in value!));
					const captureMessages =
						messageFields && (property !== "patch" || messageFields.some((field) => field in value!));
					const capturePlugins =
						pluginFields && (property !== "patch" || pluginFields.some((field) => field in value!));
					if (!captureFiles && !captureMessages && !capturePlugins) return await Reflect.apply(write, target, args);
					const old = (await raw.get(table, id)) as Fields | null;
					await Reflect.apply(write, target, args);
					const next = property === "delete" ? null : property === "replace" ? value : { ...old, ...value };
					if (captureFiles && fields.some((field) => JSON.stringify(old?.[field]) !== JSON.stringify(next?.[field]))) {
						mark("files", table, old, id);
						mark("files", table, next, id);
					}
					if (capturePlugins) {
						let beforePlugin = old;
						let afterPlugin = next;
						let changed = pluginFields.some((field) => JSON.stringify(old?.[field]) !== JSON.stringify(next?.[field]));
						if (table === "files_nodes" && (old?.moveCohortId || next?.moveCohortId)) changed = false;
						else if (table === "files_saved_places") {
							if (property === "delete") changed = false;
							else {
								[beforePlugin, afterPlugin] = await Promise.all([selected_place(old), selected_place(next)]);
								changed = PLUGIN_FILE_FIELDS.some(
									(field) => JSON.stringify(beforePlugin?.[field]) !== JSON.stringify(afterPlugin?.[field]),
								);
							}
						} else if (table === "files_move_cohorts" && property === "delete") changed = false;
						// Closed consent already clears its own grant. Worker apply must not queue itself.
						else if (table === "plugins_file_consents" && next?.open !== true) changed = false;
						if (changed) {
							mark("plugins", table, beforePlugin, id);
							mark("plugins", table, afterPlugin, id);
						}
					}
					if (!captureMessages) return;
					if (table === "files_nodes" || table === "files_saved_places") {
						let before = old;
						let after = next;
						if (table === "files_nodes") {
							// Held physical writes only copy the selected view. Move cleanup routes each moved item.
							if (old?.moveCohortId || next?.moveCohortId) return;
						} else {
							// Inserts and deletes are preparation/cleanup. Sharing edits the selected place.
							if (property === "delete") return;
							[before, after] = await Promise.all([selected_place(old), selected_place(next)]);
						}
						const nodeId = table === "files_nodes" ? id : String(old!.nodeId);
						const route = files_access_version_messages_route(before, after, nodeId);
						if (route === "file") mark_node(old!, nodeId);
						else if (route === "workspace") {
							mark("messages", table, old, id);
							mark("messages", table, next, id);
						}
						return;
					}
					if (!messageFields.some((field) => JSON.stringify(old?.[field]) !== JSON.stringify(next?.[field]))) return;
					await mark_messages(table, old, next, id);
				};
			const value: unknown = Reflect.get(target, property);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return {
		db,
		async flush() {
			for (const scope of scopes.values()) {
				const doc = await raw
					.query("files_access_versions")
					.withIndex("by_organization_workspace", (q) =>
						q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId),
					)
					.unique();
				// Tenant deletion must not recreate a clock after its cleanup removed it.
				if (
					!(await raw.get("organizations", scope.organizationId)) ||
					(scope.workspaceId && !(await raw.get("organizations_workspaces", scope.workspaceId)))
				) {
					if (doc) await raw.delete("files_access_versions", doc._id);
					continue;
				}
				if (doc) await raw.patch("files_access_versions", doc._id, { revision: doc.revision + 1 });
				else await raw.insert("files_access_versions", { ...scope, revision: 1 });
			}
			scopes.clear();
			for (const scope of messageScopes.values())
				await channels_notifications_db_advance_authority({ db: raw, scheduler: ctx.scheduler }, scope);
			// A shared reset repairs every summary of its scope in full, so skip the channels inside it.
			for (const node of messageNodes.values())
				if (
					!messageScopes.has(JSON.stringify({ organizationId: node.organizationId, workspaceId: null })) &&
					!messageScopes.has(JSON.stringify({ organizationId: node.organizationId, workspaceId: node.workspaceId }))
				)
					await channels_notifications_db_enqueue_access({ db: raw, scheduler: ctx.scheduler }, node);
			for (const member of messageMembers.values()) {
				if (messageScopes.has(JSON.stringify({ organizationId: member.organizationId, workspaceId: null }))) continue;
				const workspaceReset = messageScopes.has(
					JSON.stringify({ organizationId: member.organizationId, workspaceId: member.workspaceId }),
				);
				// A share or a returning membership changes one workspace only. Skip it before the
				// organization read, because a big batch can hold many of them.
				if (!member.roleAssignment && workspaceReset) continue;
				const organization = await raw.get("organizations", member.organizationId);
				if (!organization) continue;
				const organizationRole = member.roleAssignment && member.workspaceId === organization.defaultWorkspaceId;
				if (!organizationRole && workspaceReset) continue;
				// Removal and account deletion end the membership in the same mutation. A member who
				// leaves needs no repair.
				const membership = await raw
					.query("organizations_workspaces_users")
					.withIndex("by_workspace_user_active", (q) =>
						q.eq("workspaceId", member.workspaceId).eq("userId", member.userId).eq("active", true),
					)
					.first();
				if (!membership) continue;
				// The organization role is stored on the default workspace and works in every workspace of
				// the user. So a change there repairs the user in all of them, in a background job.
				if (organizationRole) {
					await channels_notifications_db_enqueue_member_authority({ db: raw, scheduler: ctx.scheduler }, member);
					continue;
				}
				const summary = await raw
					.query("channels_summaries")
					.withIndex("by_workspaceMembership", (q) => q.eq("workspaceMembershipId", membership._id))
					.unique();
				const user = summary ? await raw.get("users", member.userId) : null;
				// Never create a summary here. Joining creates one with the current access.
				if (summary && user && user.deletedAt == null)
					await channels_notifications_db_advance_member_authority({ db: raw, scheduler: ctx.scheduler }, membership);
			}
			messageScopes.clear();
			messageNodes.clear();
			messageMembers.clear();
			messageCount = 0;
			grantNodeReads = 0;
			for (const scope of pluginScopes.values())
				await plugins_file_grants_db_advance_authority({ db: raw, scheduler: ctx.scheduler }, scope);
			pluginScopes.clear();
		},
	};
}
