// Share rows (`files_share_rows`): one copy of a restricted node per share, so a member's shared items
// can be paged with indexes like the folder table. A share is a file `content.read` grant to a user or
// a role. The copy lives while the grant lives and its node is a restricted scope root in the grant's
// workspace, active or archived.
//
// The overlay flush (`server/files-pending-overlay.ts`) keeps them true in the writer's transaction: a
// grant write syncs its row, and a write to a node that is or was a restricted scope root syncs the
// node's rows. Shares per node are bounded by the share caps (`MAX_FILE_SHARE_PRINCIPALS`, 50 people
// and roles, in `convex/files_sharing.ts`, and `MAX_READERS`, 50 plugin readers, in
// `convex/plugins_external_files.ts`). A reserved node has at most two copies per grant.
//
// Leaf module: import only `convex/_generated`, `shared/`, `common/` and other leaf modules (see
// `server/files-visible-resolve.ts`).

import type { WithoutSystemFields } from "convex/server";
import type { Doc, Id } from "../convex/_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "../convex/_generated/server.js";
import { files_saved_placement_db_get_node, type files_saved_placement_FixedView } from "./files-saved-placement.ts";

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
function share_row_of(
	node: Doc<"files_nodes">,
	grant: Doc<"access_control_permission_grants">,
	moveView?: files_saved_placement_FixedView,
): ShareRow | null {
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
		moveView,
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
	fixedView?: files_saved_placement_FixedView,
) {
	if (!grant || grant.resourceKind !== "file" || grant.permission !== "content.read") return null;
	const nodeId = db.normalizeId("files_nodes", grant.resourceId);
	const node = nodeId && (await files_saved_placement_db_get_node(db, nodeId, fixedView));
	return node ? share_row_of(node, grant, fixedView) : null;
}

/**
 * The node each share row copies: the node itself, or its before and after places while a Move holds
 * it. A before place is null for a node the Move creates.
 */
async function db_get_placed_nodes(db: QueryCtx["db"], node: Doc<"files_nodes">) {
	const cohortId = node.moveCohortId;
	if (!cohortId) return [{ placed: node, moveView: undefined }];
	return await Promise.all(
		(["before", "after"] as const).map(async (view) => ({
			placed: await files_saved_placement_db_get_node(db, node._id, { cohortId, view }),
			moveView: { cohortId, view },
		})),
	);
}

/**
 * Current grants apply to both candidates, even before the Move is published.
 */
export async function files_share_rows_db_compute_all_for_grant(
	db: QueryCtx["db"],
	grant: Doc<"access_control_permission_grants"> | null,
) {
	if (!grant || grant.resourceKind !== "file" || grant.permission !== "content.read") return [];
	const nodeId = db.normalizeId("files_nodes", grant.resourceId);
	const node = nodeId && (await db.get("files_nodes", nodeId));
	if (!node) return [];
	const rows: ShareRow[] = [];
	for (const { placed, moveView } of await db_get_placed_nodes(db, node)) {
		const row = placed && share_row_of(placed, grant, moveView);
		if (row) rows.push(row);
	}
	return rows;
}

function row_key(row: Pick<ShareRow, "grantId" | "moveView">) {
	return `${row.grantId}:${row.moveView?.cohortId ?? ""}:${row.moveView?.view ?? ""}`;
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
		let key = row_key(row);
		// Tag the old normal copy in place when staging the before candidate.
		if (!row.moveView && !desiredByGrant.has(key)) {
			const before = [...desiredByGrant.values()].find(
				(desired) => desired.grantId === row.grantId && desired.moveView?.view === "before",
			);
			if (before) key = row_key(before);
		}
		const desired = desiredByGrant.get(key);
		desiredByGrant.delete(key);
		if (!desired) {
			await db.delete("files_share_rows", row._id);
			continue;
		}
		const patch: Record<string, unknown> = {};
		for (const [field, value] of Object.entries(desired)) {
			if (field === "moveView") {
				if (row.moveView?.cohortId !== desired.moveView?.cohortId || row.moveView?.view !== desired.moveView?.view)
					patch.moveView = value;
			} else if (row[field as keyof ShareRow] !== value) patch[field] = value;
		}
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
	const desired = await files_share_rows_db_compute_all_for_grant(
		db,
		await db.get("access_control_permission_grants", grantId),
	);
	const stored = await db
		.query("files_share_rows")
		.withIndex("by_grant", (q) => q.eq("grantId", grantId))
		.collect();
	await db_sync_rows(db, stored, new Map(desired.map((row) => [row_key(row), row])));
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
		old.moveCohortId !== node.moveCohortId ||
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
	if (node && (node.restrictedScopeNodeId === node._id || node.moveCohortId)) {
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
		// Read the placed nodes once. A long name in a Move would make a read per grant too large.
		const placedNodes = await db_get_placed_nodes(db, node);
		for (const grant of grants)
			for (const { placed, moveView } of placedNodes) {
				const row = placed && share_row_of(placed, grant, moveView);
				if (row) desiredByGrant.set(row_key(row), row);
			}
	}

	const stored = await db
		.query("files_share_rows")
		.withIndex("by_node", (q) => q.eq("nodeId", args.nodeId))
		.collect();
	await db_sync_rows(db, stored, desiredByGrant);
}
