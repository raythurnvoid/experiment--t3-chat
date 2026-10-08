// Share rows (`files_share_rows`): one copy of a restricted node per share, so a member's shared items
// can be paged with indexes like the folder table. A share is a file `content.read` grant to a user or
// a role. The copy lives while the grant lives and its node is a restricted scope root in the grant's
// workspace, active or archived.
//
// The overlay flush (`server/files-pending-overlay.ts`) keeps them true in the writer's transaction: a
// grant write syncs its row, and a write to a node that is or was a restricted scope root syncs the
// node's rows. Shares per node are bounded by the share caps (`MAX_FILE_SHARE_PRINCIPALS`, 50 people
// and roles, in `convex/files_sharing.ts`, and `MAX_READERS`, 50 plugin readers, in
// `convex/plugins_external_files.ts`), so a node write rewrites at most about 100 rows.
//
// Leaf module: import only `convex/_generated`, `shared/`, `common/` and other leaf modules (see
// `server/files-visible-resolve.ts`).

import type { WithoutSystemFields } from "convex/server";
import type { Doc, Id } from "../convex/_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "../convex/_generated/server.js";

type ShareRow = WithoutSystemFields<Doc<"files_share_rows">>;

/**
 * The node fields a share row copies. A write that changes none of them, nor the restricted scope,
 * leaves the node's rows as they are.
 */
export const files_share_rows_NODE_FIELDS = [
	"parentId",
	"kind",
	"archiveOperationId",
	"sortName",
	"name",
	"updatedAt",
	"lowercaseExtension",
	"contentByteSize",
] as const;

/**
 * The `principalKey` of a user or a role. The writes and the member reads build it here, so they match.
 */
export function files_share_rows_principal_key(kind: "user" | "role", id: string) {
	return `${kind}:${id}`;
}

/**
 * The share row of one grant on one node, or null when the pair is not a share.
 */
function share_row_of(node: Doc<"files_nodes">, grant: Doc<"access_control_permission_grants">): ShareRow | null {
	if (grant.resourceKind !== "file" || grant.permission !== "content.read" || grant.resourceId !== node._id)
		return null;
	// Service account and public grants are not shares.
	const principalKey =
		grant.principalKind === "user" && grant.userId
			? files_share_rows_principal_key("user", grant.userId)
			: grant.principalKind === "role" && grant.role
				? files_share_rows_principal_key("role", grant.role)
				: null;
	if (!principalKey) return null;
	// A grant may name a node id of another workspace. Never copy such a node.
	if (
		node.organizationId !== grant.organizationId ||
		node.workspaceId !== grant.workspaceId ||
		node.restrictedScopeNodeId !== node._id
	)
		return null;

	return {
		organizationId: grant.organizationId,
		workspaceId: grant.workspaceId,
		principalKey,
		grantId: grant._id,
		nodeId: node._id,
		parentId: node.parentId,
		kind: node.kind,
		archiveOperationId: node.archiveOperationId,
		sortName: node.sortName,
		name: node.name,
		updatedAt: node.updatedAt,
		lowercaseExtension: node.lowercaseExtension ?? null,
		contentByteSize: node.contentByteSize ?? null,
		nodeCreationTime: node._creationTime,
		externalPluginMembershipLifetime: grant.externalPluginMembershipLifetime ?? null,
	};
}

/**
 * What the share row of one grant should be, from the grant and its node only. The flush and
 * `check_share_rows` both use it.
 */
export async function files_share_rows_db_compute_for_grant(
	db: QueryCtx["db"],
	grant: Doc<"access_control_permission_grants"> | null,
) {
	if (!grant || grant.resourceKind !== "file" || grant.permission !== "content.read") return null;
	const nodeId = db.normalizeId("files_nodes", grant.resourceId);
	const node = nodeId && (await db.get("files_nodes", nodeId));
	return node ? share_row_of(node, grant) : null;
}

/**
 * Make the stored rows match the desired rows by grant: patch only changed fields, delete the rest.
 */
async function db_sync_rows(
	db: MutationCtx["db"],
	stored: Doc<"files_share_rows">[],
	desiredByGrant: Map<string, ShareRow>,
) {
	for (const row of stored) {
		const desired = desiredByGrant.get(row.grantId);
		// A second row of the same grant is deleted too.
		desiredByGrant.delete(row.grantId);
		if (!desired) {
			await db.delete("files_share_rows", row._id);
			continue;
		}
		const patch: Record<string, unknown> = {};
		for (const [field, value] of Object.entries(desired))
			if (row[field as keyof ShareRow] !== value) patch[field] = value;
		if (Object.keys(patch).length > 0) await db.patch("files_share_rows", row._id, patch);
	}
	for (const desired of desiredByGrant.values()) await db.insert("files_share_rows", desired);
}

/**
 * Sync the share row of one written grant. A deleted grant loses its row.
 */
export async function files_share_rows_db_sync_grant(
	db: MutationCtx["db"],
	grantId: Id<"access_control_permission_grants">,
) {
	const desired = await files_share_rows_db_compute_for_grant(
		db,
		await db.get("access_control_permission_grants", grantId),
	);
	const stored = await db
		.query("files_share_rows")
		.withIndex("by_grant", (q) => q.eq("grantId", grantId))
		.collect();
	await db_sync_rows(db, stored, new Map(desired ? [[grantId, desired]] : []));
}

/**
 * Whether a node write changes its share rows: the node is or was a restricted scope root, and a
 * copied field, its workspace or its scope changed. `old` holds the node's fields before the write
 * (null for an insert) and `node` the doc after it (null for a delete).
 */
export function files_share_rows_node_changed(
	nodeId: Id<"files_nodes">,
	old: Record<string, unknown> | null,
	node: Doc<"files_nodes"> | null,
) {
	const wasRoot = old?.restrictedScopeNodeId === nodeId;
	const isRoot = node?.restrictedScopeNodeId === nodeId;
	if (!wasRoot && !isRoot) return false;
	if (!old || !node || wasRoot !== isRoot) return true;
	return (
		old.organizationId !== node.organizationId ||
		old.workspaceId !== node.workspaceId ||
		files_share_rows_NODE_FIELDS.some((field) => old[field] !== node[field])
	);
}

/**
 * Rewrite one node's share rows from its grants. One range reads the node's `content.read` grants in
 * the node's own workspace, so no other workspace's grant is read. The share caps bound it.
 */
export async function files_share_rows_db_sync_node(
	db: MutationCtx["db"],
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		nodeId: Id<"files_nodes">;
		node: Doc<"files_nodes"> | null;
	},
) {
	const { node } = args;
	const desiredByGrant = new Map<string, ShareRow>();
	if (node && node.restrictedScopeNodeId === node._id) {
		// Service account and public `content.read` grants are in this range too, but have no row.
		const grants = await db
			.query("access_control_permission_grants")
			.withIndex("by_resource_permission", (q) =>
				q
					.eq("organizationId", args.organizationId)
					.eq("workspaceId", args.workspaceId)
					.eq("resourceKind", "file")
					.eq("resourceId", node._id)
					.eq("permission", "content.read"),
			)
			.collect();
		for (const grant of grants) {
			const row = share_row_of(node, grant);
			if (row) desiredByGrant.set(grant._id, row);
		}
	}

	const stored = await db
		.query("files_share_rows")
		.withIndex("by_node", (q) => q.eq("nodeId", args.nodeId))
		.collect();
	await db_sync_rows(db, stored, desiredByGrant);
}
