// Trash entries (`files_trash_entries`): one doc per item that is in Trash on its own. The Trash list
// of an area is one index range over them.
//
// An entry is a fact. The step that decides "this item is in Trash on its own" inserts it. The list of
// those steps is the Trash entries principle in `.agents/skills/files-explorer-tree/SKILL.md`. Nothing
// derives entries from parents, so a parent change never needs a repair of its children.
//
// The overlay flush (`server/files-pending-overlay.ts`) and Move cleanup keep each entry true for its
// own node: the entry goes away when the node leaves Trash or is deleted, and its delete id follows the
// node. A node in Trash has one delete id, so it has at most one entry. The scope job of an unrestrict,
// and Delete permanently of a restricted folder, move the entries of that folder's area to the area the
// folder lists in (`files_trash_entries_db_set_area`).
//
// Leaf module: import only `convex/_generated`, `shared/`, `common/` and other leaf modules (see
// `server/files-visible-resolve.ts`). So callers resolve the live area themselves
// (`access_control_db_resolve_trash_entry_area`).

import type { Doc, Id } from "../convex/_generated/dataModel.js";
import type { MutationCtx } from "../convex/_generated/server.js";

type Placement = Pick<Doc<"files_nodes">, "restrictedScopeNodeId" | "isRestrictedScopeRoot" | "parentScopeNodeId">;

/**
 * The stored pointer an item's area comes from. A restricted folder lists in the area of its parent,
 * where people who cannot open it still see it as locked. Every other item lists in its own area. The
 * pointer can be dead, so resolve it to the live area before you store it.
 */
export function files_trash_entries_area_pointer(node: Placement) {
	return node.isRestrictedScopeRoot ? (node.parentScopeNodeId ?? null) : node.restrictedScopeNodeId;
}

/**
 * The sort key of a delete id. Delete ids start with the delete time, so mapping each char to
 * `127 - code` makes ascending order newest delete first. Paths then stay A to Z.
 */
export function files_trash_entries_order(archiveOperationId: string) {
	return Array.from(archiveOperationId, (char) => String.fromCharCode(127 - char.charCodeAt(0))).join("");
}

/**
 * Record that `node` is in Trash on its own, in the live `area` of its pointer
 * (`files_trash_entries_area_pointer`). Call it after the stamp, only from the step that decides it. A
 * second call for the same node does nothing.
 */
export async function files_trash_entries_db_insert(
	ctx: MutationCtx,
	node: Doc<"files_nodes">,
	area: Id<"files_nodes"> | null,
) {
	if (node.archiveOperationId === null) return;
	const existing = await ctx.db
		.query("files_trash_entries")
		.withIndex("by_node", (q) => q.eq("nodeId", node._id))
		.unique();
	if (existing) return;
	await ctx.db.insert("files_trash_entries", {
		organizationId: node.organizationId,
		workspaceId: node.workspaceId,
		nodeId: node._id,
		archiveOperationId: node.archiveOperationId,
		area,
		order: files_trash_entries_order(node.archiveOperationId),
		// Nodes deleted before `archivedPath` existed keep their path in Trash.
		archivedPath: node.archivedPath ?? node.path,
	});
}

/**
 * Record that `nodeId` is not in Trash on its own: it went to Trash with a folder of the same delete,
 * or joined one.
 */
export async function files_trash_entries_db_delete(ctx: MutationCtx, nodeId: Doc<"files_nodes">["_id"]) {
	const entry = await ctx.db
		.query("files_trash_entries")
		.withIndex("by_node", (q) => q.eq("nodeId", nodeId))
		.unique();
	if (entry) await ctx.db.delete("files_trash_entries", entry._id);
}

/**
 * Keep the entry of one node true after a write. Delete it when the node is gone or no longer in
 * Trash. Follow the node's delete id. Never insert: only producers decide that.
 *
 * Keep the entry's area. A new delete id (a Restore that skips the item, or finds its path too long)
 * leaves the item where it was in Trash. A Trash item keeps its delete-time scope fields, and only
 * `files_trash_entries_db_set_area` moves its entry, so the fields can name an old or dead area. A later
 * write of the node, for example a purge mark, must not move the entry back.
 */
export async function files_trash_entries_db_sync(
	ctx: MutationCtx,
	args: { nodeId: Doc<"files_nodes">["_id"]; node: Doc<"files_nodes"> | null },
) {
	const entry = await ctx.db
		.query("files_trash_entries")
		.withIndex("by_node", (q) => q.eq("nodeId", args.nodeId))
		.unique();
	if (!entry) return;
	const { node } = args;
	if (!node || node.archiveOperationId === null) {
		await ctx.db.delete("files_trash_entries", entry._id);
		return;
	}

	if (entry.archiveOperationId !== node.archiveOperationId)
		await ctx.db.patch("files_trash_entries", entry._id, {
			archiveOperationId: node.archiveOperationId,
			order: files_trash_entries_order(node.archiveOperationId),
		});
}

/**
 * Move at most `limit` entries of area `from` to area `to`. Returns how many moved, so a caller with
 * a budget calls again until it moves fewer than `limit`. Each patch leaves the range, so a new call
 * needs no cursor.
 */
export async function files_trash_entries_db_set_area(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		from: Id<"files_nodes">;
		to: Id<"files_nodes"> | null;
		limit: number;
	},
) {
	const entries = await ctx.db
		.query("files_trash_entries")
		.withIndex("by_org_ws_area_order_path", (q) =>
			q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("area", args.from),
		)
		.take(args.limit);
	for (const entry of entries) await ctx.db.patch("files_trash_entries", entry._id, { area: args.to });
	return entries.length;
}
