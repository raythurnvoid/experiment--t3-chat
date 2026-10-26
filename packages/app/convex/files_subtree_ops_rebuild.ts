// Give the items inside a moved or newly scoped folder the path and access area of their live parent.
// The request changes the folder itself, then starts an op here. The first step runs in the same mutation,
// so a small folder is done at once. Later steps run in `advance` in files_subtree_ops.ts. The archive job
// also calls `files_nodes_db_rebuild_node` for each child it restores.
//
// Keep the imports of this module small. On a cold call Convex loads every file that this module imports,
// even the unused ones. The sharing doors start ops here, so this module must not import files_nodes.ts or
// files_subtree_ops.ts.

import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { activities_db_start } from "./activities_db.ts";
import { files_media_validation_db_advance_version } from "./files_media_validation.ts";
import { files_path_depth } from "./files_nodes_create_db.ts";
import { files_share_links_db_delete_for_node } from "./files_share_links_db.ts";
import {
	files_subtree_ops_RECOVER_AFTER_MS,
	files_subtree_ops_db_delete,
	files_subtree_ops_db_enqueue_nodes,
	files_subtree_ops_db_first_node,
	files_subtree_ops_db_insert,
	files_subtree_ops_db_is_near_limits,
	files_subtree_ops_db_next_children,
	files_subtree_ops_db_pause_for_move,
	files_subtree_ops_db_require_walk,
	files_subtree_ops_db_save_page,
	files_subtree_ops_db_schedule_step,
} from "./files_subtree_ops_db.ts";
import { organizations_membership_lifetimes_db_ensure } from "./organizations_membership_lifetimes.ts";
import { files_pending_overlay_db_follow_saved_scope } from "../server/files-pending-overlay.ts";
import { path_join } from "../server/server-utils.ts";
import { files_derive_tree_path_for_file_node } from "../shared/files.ts";

/**
 * A step ends after it writes this many nodes, like the archive job.
 */
export const files_subtree_ops_STEP_MAX_NODES = 75;

/**
 * Give a child the path and restricted scope that its live parent implies. Its saved chunks and
 * metadata docs follow in this mutation when there are few, else in a saved scope job
 * (`files_pending_overlay_db_follow_saved_scope`). A restrict or restore job calls this for each child
 * after the parent is right, and checks the transaction limits between children. Returns whether it
 * wrote anything. The caller advances the media validation version once after its writes.
 *
 * It never writes `archiveOperationId`. An archive job may stamp the same child, and a patch keeps
 * the other field.
 *
 * It does not check the path limit. A restore gives a child that was archived on its own the path of
 * its restored folder, even when that path is a few characters over the limit. The child stays
 * archived. Its own restore uses its first Archive allowance, or the normal limit when it is absent.
 */
export async function files_nodes_db_rebuild_node(
	ctx: MutationCtx,
	args: { node: Doc<"files_nodes">; parent: Doc<"files_nodes"> },
) {
	const { node, parent } = args;
	const path = path_join(parent.path, node.name);
	// A boundary, live or former, points at its parent's area.
	const isBoundary = node.isRestrictedScopeRoot || node.parentScopeNodeId !== undefined;
	const isExtendedRoot = node.parentExtendedScopeNodeId !== undefined;
	const restrictedScopeNodeId = node.restrictedScopeNodeId === node._id ? node._id : parent.restrictedScopeNodeId;
	const fields = {
		path,
		treePath: files_derive_tree_path_for_file_node(path, node.kind),
		pathDepth: files_path_depth(path),
		// A child that is its own restricted folder keeps its scope.
		restrictedScopeNodeId,
		...(isBoundary ? { parentScopeNodeId: parent.restrictedScopeNodeId } : {}),
		// A restricted root starts with no added people from above. An extended root keeps its own and
		// links to its parent's chain. Any other child takes its parent's chain.
		extendedScopeNodeId:
			restrictedScopeNodeId === node._id ? null : isExtendedRoot ? node._id : parent.extendedScopeNodeId,
		...(isExtendedRoot ? { parentExtendedScopeNodeId: parent.extendedScopeNodeId } : {}),
		// A public file stays public only in its own area.
		isPublic: node.restrictedScopeNodeId === restrictedScopeNodeId ? node.isPublic : undefined,
	};
	if (
		node.path === fields.path &&
		node.treePath === fields.treePath &&
		node.pathDepth === fields.pathDepth &&
		node.restrictedScopeNodeId === fields.restrictedScopeNodeId &&
		(!isBoundary || node.parentScopeNodeId === parent.restrictedScopeNodeId) &&
		node.extendedScopeNodeId === fields.extendedScopeNodeId &&
		(!isExtendedRoot || node.parentExtendedScopeNodeId === parent.extendedScopeNodeId) &&
		node.isPublic === fields.isPublic
	) {
		return false;
	}

	// A new scope ends the public link. Rename keeps links. Move cohorts remove reparented links
	// before publication. Scope repair also uses this helper.
	if (node.restrictedScopeNodeId !== fields.restrictedScopeNodeId) {
		await files_share_links_db_delete_for_node(ctx, {
			organizationId: node.organizationId,
			workspaceId: node.workspaceId,
			nodeId: node._id,
		});
	}

	await ctx.db.patch("files_nodes", node._id, fields);
	if (node.path !== path) await files_pending_overlay_db_follow_saved_scope(ctx, node);
	// Only the area changed. Metadata docs copy it for the catalog's area rows; text chunks have no
	// area. A node without metadata docs writes nothing more.
	else if (node.restrictedScopeNodeId !== fields.restrictedScopeNodeId)
		await files_pending_overlay_db_follow_saved_scope(ctx, node, { metadataOnly: true });
	return true;
}

/**
 * Rewrite the path and scope of each child in the op's queue from its live parent. The request
 * already changed the roots. When the queue is empty, a pass ended. Walk again from the roots,
 * until a pass writes nothing.
 */
export async function files_subtree_ops_db_rebuild_walk(args: {
	ctx: MutationCtx;
	op: Doc<"files_subtree_ops">;
	budget: { nodes: number; hasPaginated: boolean };
}) {
	const { ctx, op, budget } = args;

	const walk = await files_subtree_ops_db_require_walk(ctx, op._id);
	let passWrote = walk.passWrote;
	let isWritten = false;
	let count = 0;
	let isDone = false;

	while (budget.nodes > 0 && !(count > 0 && (await files_subtree_ops_db_is_near_limits(ctx)))) {
		const row = await files_subtree_ops_db_first_node(ctx, op._id);
		// A child that got a name before the cursor during a pass was missed, so only a pass that
		// wrote nothing ends the walk.
		if (!row) {
			if (!passWrote) {
				isDone = true;
				break;
			}
			passWrote = false;
			await files_subtree_ops_db_enqueue_nodes(ctx, {
				opId: op._id,
				nodes: op.rootNodeIds.map((nodeId) => ({ nodeId, nodeDone: true })),
			});
			continue;
		}
		// Count the row too. A step that only clears empty or deleted folders must still stop near the
		// limits.
		count += 1;

		const folder = await ctx.db.get("files_nodes", row.nodeId);
		if (!folder) {
			await ctx.db.delete("files_subtree_op_nodes", row._id);
			continue;
		}

		const next = await files_subtree_ops_db_next_children(ctx, { row, folder, budget });
		if (!next) break;
		const folderIds = [];
		let pending: Array<Id<"files_nodes">> = [];
		for (const [index, child] of next.children.entries()) {
			// A file with many side docs writes a lot, so a full step can end inside the page. The children
			// it did not reach wait in `pending` for the next step.
			if (index > 0 && (budget.nodes <= 0 || (await files_subtree_ops_db_is_near_limits(ctx)))) {
				pending = next.children.slice(index).map((pendingChild) => pendingChild._id);
				break;
			}
			count += 1;

			// Count only the items the step writes. A later pass reads items that are already right, and
			// they cost only a read.
			if (await files_nodes_db_rebuild_node(ctx, { node: child, parent: folder })) {
				budget.nodes -= 1;
				passWrote = true;
				isWritten = true;
			}
			// A scope change stops at a restricted folder: the scopes inside it depend only on that folder.
			// The rebuild above still gives the folder its new parent scope.
			if (child.kind === "folder" && !(op.kind === "scope" && child.isRestrictedScopeRoot)) {
				folderIds.push(child._id);
			}
		}
		await files_subtree_ops_db_save_page(ctx, {
			row,
			cursor: next.cursor,
			isDone: next.isDone,
			pending,
			folderIds,
			isRowFirst: false,
		});
	}

	if (passWrote !== walk.passWrote) {
		await ctx.db.patch("files_subtree_op_walks", walk._id, { passWrote });
	}
	if (isWritten) {
		await files_media_validation_db_advance_version(ctx, op);
	}
	return isDone;
}

/**
 * Start the walk after the request changed the roots. A transfer defers the first walk so root
 * publication has its own budget. Return null when the walk finished in this request.
 */
export async function files_subtree_ops_db_start_rebuild(
	ctx: MutationCtx,
	args: {
		kind: "move" | "scope";
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
		/**
		 * Null for a plugin door, which acts for a user without a membership doc. The hidden scope
		 * Activity then carries no membership.
		 */
		membership: Doc<"organizations_workspaces_users"> | null;
		/**
		 * The roots as the request left them. `oldTreePath` is where each one was before.
		 */
		roots: Array<{ node: Doc<"files_nodes">; oldTreePath: string }>;
		budget: { nodes: number; hasPaginated: boolean };
		deferWalk?: boolean;
		now: number;
	},
) {
	const folders = args.roots.filter((root) => root.node.kind === "folder");
	if (folders.length === 0) {
		return null;
	}

	const shared = {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		userId: args.userId,
		status: "running" as const,
		blockedByOpId: null,
		rootNodeIds: folders.map((root) => root.node._id),
		treePaths: folders.map((root) => root.node.treePath),
	};
	const opId = await files_subtree_ops_db_insert(ctx, {
		op:
			args.kind === "move"
				? { ...shared, kind: "move", oldTreePaths: folders.map((root) => root.oldTreePath) }
				: { ...shared, kind: "scope" },
		now: args.now,
	});
	// Each root remembers its newest scope op. Only that op's end may stop it being a boundary.
	if (args.kind === "scope") {
		for (const root of folders) await ctx.db.patch("files_nodes", root.node._id, { scopeOpId: opId });
	}
	await files_subtree_ops_db_enqueue_nodes(ctx, {
		opId,
		nodes: folders.map((root) => ({ nodeId: root.node._id, nodeDone: true })),
	});

	const op = (await ctx.db.get("files_subtree_ops", opId))!;
	if (
		!args.deferWalk &&
		!(await files_subtree_ops_db_pause_for_move(ctx, op)) &&
		(await files_subtree_ops_db_rebuild_walk({ ctx, op, budget: args.budget }))
	) {
		await files_subtree_ops_db_delete(ctx, { opId, now: args.now });
		return null;
	}

	const activityId = await activities_db_start(ctx, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		userId: args.userId,
		...(args.membership
			? {
					membershipId: args.membership._id,
					membershipLifetime: await organizations_membership_lifetimes_db_ensure(ctx, args.membership),
				}
			: {}),
		source: { kind: "files_subtree_op", id: opId, opKind: args.kind },
		// Keep names and paths out of the title. The requester may lose access to the items later.
		title: args.kind === "move" ? "Move files" : "Restrict files",
		targets: [],
		visibility: "requester",
		// A transfer owns the visible card. Keep this Activity for recovery after Stop.
		feedVisible: args.kind === "move" && !args.deferWalk,
		status: "running",
		resultKind: "saved",
		deadlineAt: args.now + files_subtree_ops_RECOVER_AFTER_MS,
		now: args.now,
	});
	await files_subtree_ops_db_schedule_step(ctx, { opId, now: args.now });
	return { opId, activityId };
}
