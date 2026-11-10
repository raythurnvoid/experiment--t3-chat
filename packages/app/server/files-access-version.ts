// Human authority changes update Files resolver clocks, Messages summaries and personal plugin
// grants. Each has its own field set. Plugin readers use applied grants while their worker catches up.
// Account grants and account roles are not human authority. Credential checks stay separate.
// Saved `find --content-type` frames still cover people only. Add account authority fields before
// allowing accounts or plugins to start those queries.

import type { Id, TableNames } from "../convex/_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "../convex/_generated/server.js";
import { should_never_happen } from "../shared/shared-utils.ts";
import { channels_notifications_db_advance_authority } from "./channels-notifications.ts";
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

type Fields = Record<string, unknown>;
type Scope = { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces"> | null };

/**
 * Messages ignores names, content and archive changes, including during a Move.
 */
export function files_access_version_messages_file_changed(before: Fields | null, after: Fields | null) {
	return (
		(before === null) !== (after === null) ||
		MESSAGES_FILE_FIELDS.some((field) => before?.[field] !== after?.[field])
	);
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
 * Capture actual authority changes once per scope in a mutation. This avoids both a global hot
 * counter and clock writes for profile edits, file content, metadata, or unchanged patches.
 */
export function files_access_version_db_wrap(ctx: MutationCtx) {
	const scopes = new Map<string, Scope>();
	const messageScopes = new Map<string, Scope>();
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
						mark("messages", table, value, id);
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
					if (table === "files_nodes") {
						// Held physical writes only copy the selected view. Publication owns its clock.
						if (old?.moveCohortId || next?.moveCohortId || !files_access_version_messages_file_changed(old, next))
							return;
					} else if (table === "files_saved_places") {
						// Inserts and deletes are preparation/cleanup. Sharing edits the selected place.
						if (property === "delete") return;
						const [before, after] = await Promise.all([selected_place(old), selected_place(next)]);
						if (!files_access_version_messages_file_changed(before, after)) return;
					} else if (!messageFields.some((field) => JSON.stringify(old?.[field]) !== JSON.stringify(next?.[field]))) {
						return;
					}
					mark("messages", table, old, id);
					mark("messages", table, next, id);
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
			messageScopes.clear();
			for (const scope of pluginScopes.values())
				await plugins_file_grants_db_advance_authority({ db: raw, scheduler: ctx.scheduler }, scope);
			pluginScopes.clear();
		},
	};
}
