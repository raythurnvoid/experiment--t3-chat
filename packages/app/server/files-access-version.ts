// Permission answers may live in a saved resolver frame. These clocks cover every database field
// used by the human Files permission check. User, chat and source authority is checked live too.
//
// Account grants, service account roles and plugin sandbox roots stay out on purpose. Only saved
// `find --content-type` frames read these clocks, and only a user without a sandbox starts one. If an
// account or a plugin can ever start a type query, add those fields here first.

import type { Id, TableNames } from "../convex/_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "../convex/_generated/server.js";
import { should_never_happen } from "../shared/shared-utils.ts";

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
		"externalPluginMembershipLifetime",
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

type Fields = Record<string, unknown>;
type Scope = { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces"> | null };

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
	const raw = ctx.db;
	function mark(table: TableNames, value: Fields | null, id: string) {
		if (!value) return;
		if (
			table === "access_control_permission_grants" &&
			(value.permission !== "content.read" || value.principalKind === "service_account")
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
		scopes.set(JSON.stringify(scope), scope);
	}
	const db = new Proxy(raw, {
		get(target, property) {
			if (property === "insert")
				return async (table: TableNames, value: Fields) => {
					const id = await target.insert(table, value as never);
					// A new file has a new identity. No previous answer can name its scope pointer.
					if (FIELDS[table] && table !== "files_nodes" && table !== "files_saved_places") mark(table, value, id);
					return id;
				};
			if (property === "patch" || property === "replace" || property === "delete")
				return async (...args: unknown[]) => {
					const write = Reflect.get(target, property) as (...args: unknown[]) => Promise<void>;
					const tableFirst = args.length === (property === "delete" ? 2 : 3);
					if (!tableFirst) {
						for (const table of Object.keys(FIELDS) as TableNames[])
							if (raw.normalizeId(table, String(args[0])))
								throw should_never_happen("Authority writes must name their table", { table, id: args[0] });
						return await Reflect.apply(write, target, args);
					}
					const table = args[0] as TableNames;
					const id = args[1] as Id<TableNames>;
					const fields = FIELDS[table];
					const value = property === "delete" ? null : (args[2] as Fields);
					if (!fields || (property === "patch" && !fields.some((field) => field in value!)))
						return await Reflect.apply(write, target, args);
					const old = (await raw.get(table, id)) as Fields | null;
					await Reflect.apply(write, target, args);
					const next = property === "delete" ? null : property === "replace" ? value : { ...old, ...value };
					if (fields.some((field) => JSON.stringify(old?.[field]) !== JSON.stringify(next?.[field]))) {
						mark(table, old, id);
						mark(table, next, id);
					}
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
		},
	};
}
