// Trash entries (`files_trash_entries`): one doc per item that is in Trash on its own. The Trash list
// of an area is one index range over them.
//
// An entry is a fact. The step that decides "this item is in Trash on its own" inserts it. The list of
// those steps is the Trash entries principle in `.agents/skills/files-explorer-tree/SKILL.md`. Nothing
// derives entries from parents, so a parent change never needs a repair of its children.
//
// The overlay flush (`server/files-pending-overlay.ts`) and Move cleanup keep each entry true for its
// own node: the entry goes away when the node leaves Trash or is deleted, and its area and delete id
// follow the node. A node in Trash has one delete id, so it has at most one entry.
//
// Leaf module: import only `convex/_generated`, `shared/`, `common/` and other leaf modules (see
// `server/files-visible-resolve.ts`).

import type { Doc } from "../convex/_generated/dataModel.js";
import type { MutationCtx } from "../convex/_generated/server.js";

type Placement = Pick<
	Doc<"files_nodes">,
	"archiveOperationId" | "restrictedScopeNodeId" | "isRestrictedScopeRoot" | "parentScopeNodeId"
>;

/**
 * The area an item lists in. A restricted folder lists in the area of its parent, where people who
 * cannot open it still see it as locked. Every other item lists in its own area.
 */
export function files_trash_entries_area(node: Placement) {
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
 * Record that `node` is in Trash on its own. Call it after the stamp, only from the step that
 * decides it. A second call for the same node does nothing.
 */
export async function files_trash_entries_db_insert(ctx: MutationCtx, node: Doc<"files_nodes">) {
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
		area: files_trash_entries_area(node),
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
 * Trash. Otherwise follow the node's area and delete id. Never insert: only producers decide that.
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

	const area = files_trash_entries_area(node);
	if (entry.area !== area || entry.archiveOperationId !== node.archiveOperationId)
		await ctx.db.patch("files_trash_entries", entry._id, {
			area,
			archiveOperationId: node.archiveOperationId,
			order: files_trash_entries_order(node.archiveOperationId),
		});
}
