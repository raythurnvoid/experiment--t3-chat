// A move, archive, restore, restrict, or copy of a folder changes every item inside it, and a big
// folder does not fit in one mutation. So the request writes what people must see now, for example
// the moved folder itself, and inserts one op. Steps then walk the folder by `parentId` and fix the
// stored copies inside, a few items per step. The last step deletes the op.
//
// Each step reads the parent again and writes each child from it. So a person may move, rename, or
// archive an item inside while the op runs. The walk follows the live tree and never puts it back.
//
// The walk takes the queue row with the highest `sequence` first. The folders of one page get the next
// numbers, so the walk goes into them before it goes back to the folder they came from, and the queue
// stays small. Each row keeps where its next page starts and the children a full step did not reach
// (`pending`).
//
// Move, rename, archive, and restrict start at once. Copy and restore wait while an op they overlap
// is still there. A waiting op is `queued`. It writes nothing until the op before it ends.

import { v } from "convex/values";
import type { WithoutSystemFields } from "convex/server";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import { internalMutation } from "./functions.ts";
import { activities_db_finish, activities_db_start } from "./activities_db.ts";
import { files_archive_runs_db_advance, files_archive_runs_db_promote } from "./files_archive_runs.ts";
import { files_media_validation_db_advance_version } from "./files_media_validation.ts";
import { files_nodes_db_rebuild_node } from "./files_nodes.ts";
import { files_transfer_db_promote } from "./files_transfer.ts";
import { organizations_membership_lifetimes_db_ensure } from "./organizations_membership_lifetimes.ts";
import { files_pending_overlay_db_flush } from "../server/files-pending-overlay.ts";
import { files_move_reservations_db_find_blocker, files_move_reservations_db_pause_worker } from "../server/files-move-reservations.ts";
import { should_never_happen } from "../shared/shared-utils.ts";

// Make Convex reuse the loaded module between calls, so warm calls skip the module load cost.
// Does NOT work for http actions (see http.ts). No mutable module-level state allowed here.
export const experimental_reuseContext = true;

/**
 * A step ends after it writes this many nodes, like the archive job.
 */
export const files_subtree_ops_STEP_MAX_NODES = 75;

/**
 * A step also ends when less than this share of a transaction limit is left. A file with many text
 * chunks writes far more than its node, so the node count alone is not enough.
 */
const METRICS_MIN_REMAINING_SHARE = 0.25;

const PAGE_SIZE = 50;

/**
 * The recover cron looks at an op again after this long. It schedules the step again, so a step
 * that threw does not leave the op there forever.
 */
export const files_subtree_ops_RECOVER_AFTER_MS = 5 * 60 * 1000;

export async function files_subtree_ops_db_is_near_limits(ctx: MutationCtx) {
	// Flush first, so a loop that asks "can I do more?" also counts the overlay work of its writes.
	await files_pending_overlay_db_flush(ctx);
	const metrics = await ctx.meta.getTransactionMetrics();
	return [
		metrics.bytesRead,
		metrics.bytesWritten,
		metrics.documentsRead,
		metrics.documentsWritten,
		metrics.databaseQueries,
		// The flush schedules jobs. Convex allows 1,000 scheduled functions per mutation.
		metrics.functionsScheduled,
	].some((metric) => metric.remaining < (metric.used + metric.remaining) * METRICS_MIN_REMAINING_SHARE);
}

function busy_tree_paths(op: Doc<"files_subtree_ops">) {
	return [
		...op.treePaths,
		...(op.kind === "move" ? op.oldTreePaths : []),
		...(op.kind === "copy" ? op.sourceTreePaths : []),
	];
}

/**
 * Whether one tree path holds the other. Only a folder's `treePath` ends with "/", and only a folder
 * holds other paths. So a file `/docs` never overlaps a folder `/docs-archive/`.
 */
function tree_paths_overlap(left: string, right: string) {
	const holds = (outer: string, inner: string) => outer === inner || (outer.endsWith("/") && inner.startsWith(outer));
	return holds(left, right) || holds(right, left);
}

/**
 * Copy writes final paths. Only running repairs can leave stored paths or scopes behind.
 */
export async function files_subtree_ops_db_find_repair(
	ctx: QueryCtx | MutationCtx,
	args: { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces"> },
) {
	for (const kind of ["move", "scope", "archive", "restore"] as const) {
		const op = await ctx.db
			.query("files_subtree_ops")
			.withIndex("by_organization_workspace_kind_status", (q) =>
				q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("kind", kind).eq("status", "running"),
			)
			.first();
		if (op) return op;
	}
	return null;
}

/**
 * The op that a new op on `treePaths` must wait for, or null. `waiter` is a queued op that asks
 * again: only running ops and ops queued before it count, so two waiters never wait for each other.
 */
export async function files_subtree_ops_db_find_blocker(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		treePaths: readonly string[];
		waiter: Doc<"files_subtree_ops"> | null;
	},
) {
	for await (const op of ctx.db
		.query("files_subtree_ops")
		.withIndex("by_organization_workspace_kind", (q) =>
			q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId),
		)) {
		if (
			args.waiter &&
			(op._id === args.waiter._id || (op.status === "queued" && op._creationTime > args.waiter._creationTime))
		) {
			continue;
		}
		const overlaps = busy_tree_paths(op).some((busyPath) =>
			args.treePaths.some((treePath) => tree_paths_overlap(busyPath, treePath)),
		);
		if (overlaps) return op;
	}
	return null;
}

/**
 * For each of `treePaths`, whether a running or queued op overlaps it.
 *
 * `files_subtree_ops_db_find_blocker` stops at the first op that blocks any path, so it cannot tell
 * which other paths a later op blocks. This reads every op of the workspace once instead. It returns
 * null past `maxOps` ops, because a partial scan could miss a blocker.
 *
 * `beforeNextRead` is called before each read, with the op read last or null before the first read.
 * When it returns false, the scan stops and returns null.
 */
export async function files_subtree_ops_db_find_blocked_paths(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		treePaths: readonly string[];
		maxOps: number;
		beforeNextRead?: (lastOp: Doc<"files_subtree_ops"> | null) => boolean;
	},
) {
	const blocked = args.treePaths.map(() => false);
	let opCount = 0;
	if (args.beforeNextRead?.(null) === false) return null;
	for await (const op of ctx.db
		.query("files_subtree_ops")
		.withIndex("by_organization_workspace_kind", (q) =>
			q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId),
		)) {
		opCount += 1;
		if (opCount > args.maxOps) return null;

		const busyPaths = busy_tree_paths(op);
		for (const [index, treePath] of args.treePaths.entries()) {
			blocked[index] ||= busyPaths.some((busyPath) => tree_paths_overlap(busyPath, treePath));
		}

		if (args.beforeNextRead?.(op) === false) return null;
	}
	return blocked;
}

async function db_require_walk(ctx: QueryCtx | MutationCtx, opId: Id<"files_subtree_ops">) {
	const walk = await ctx.db
		.query("files_subtree_op_walks")
		.withIndex("by_op", (q) => q.eq("opId", opId))
		.unique();
	if (!walk) {
		const errorMessage = "Subtree op has no walk doc";
		const errorData = { opId };
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}
	return walk;
}

export async function files_subtree_ops_db_insert(
	ctx: MutationCtx,
	args: { op: WithoutSystemFields<Doc<"files_subtree_ops">>; now: number },
) {
	const opId = await ctx.db.insert("files_subtree_ops", args.op);
	await ctx.db.insert("files_subtree_op_walks", { opId, step: 0, passWrote: false, sequence: 0, updatedAt: args.now });
	return opId;
}

export async function files_subtree_ops_db_schedule_step(
	ctx: MutationCtx,
	args: { opId: Id<"files_subtree_ops">; now: number },
) {
	const walk = await db_require_walk(ctx, args.opId);
	const step = walk.step + 1;
	await ctx.db.patch("files_subtree_op_walks", walk._id, { step, updatedAt: args.now });
	await ctx.scheduler.runAfter(0, internal.files_subtree_ops.advance, { opId: args.opId, step });
	// A failed mutation cannot schedule its own retry. The earlier step schedules one now.
	await ctx.scheduler.runAfter(60_000, internal.files_subtree_ops.advance, { opId: args.opId, step });
}

export async function files_subtree_ops_db_insert_node(
	ctx: MutationCtx,
	args: { opId: Id<"files_subtree_ops">; sequence: number; nodeId: Id<"files_nodes">; nodeDone: boolean },
) {
	await ctx.db.insert("files_subtree_op_nodes", { ...args, cursor: null, pending: [] });
}

/**
 * Queue the nodes with the next free numbers. The step takes the highest number first, so the first
 * node gets the highest number of the block, and the nodes run in the order given.
 */
export async function files_subtree_ops_db_enqueue_nodes(
	ctx: MutationCtx,
	args: { opId: Id<"files_subtree_ops">; nodes: Array<{ nodeId: Id<"files_nodes">; nodeDone: boolean }> },
) {
	if (args.nodes.length === 0) return;

	const walk = await db_require_walk(ctx, args.opId);
	await ctx.db.patch("files_subtree_op_walks", walk._id, { sequence: walk.sequence + args.nodes.length });
	for (const [index, node] of args.nodes.entries()) {
		await files_subtree_ops_db_insert_node(ctx, {
			opId: args.opId,
			sequence: walk.sequence + args.nodes.length - 1 - index,
			...node,
		});
	}
}

/**
 * Keep the numbers 0 to `count - 1` for rows that `files_subtree_ops_db_insert_node` adds later.
 * Only an empty queue may start its numbers again, so no row holds one of them.
 */
export async function files_subtree_ops_db_reserve_sequences(
	ctx: MutationCtx,
	args: { opId: Id<"files_subtree_ops">; count: number },
) {
	const walk = await db_require_walk(ctx, args.opId);
	await ctx.db.patch("files_subtree_op_walks", walk._id, { sequence: args.count });
}

export async function files_subtree_ops_db_first_node(ctx: MutationCtx, opId: Id<"files_subtree_ops">) {
	return await ctx.db
		.query("files_subtree_op_nodes")
		.withIndex("by_op_sequence", (q) => q.eq("opId", opId))
		.order("desc")
		.first();
}

type ChildCursor = Doc<"files_subtree_op_nodes">["cursor"];

/**
 * One page of a folder's children, active and archived, in the order of the
 * `by_organization_workspace_parent_name` index: by name, then by creation time. `cursor` is where the
 * next page starts. `isDone` is true when this page reaches the last child. Returns null when the page
 * needs a paginated read and this mutation already did one.
 */
async function db_read_children(
	ctx: MutationCtx,
	args: { folder: Doc<"files_nodes">; cursor: ChildCursor; budget: { hasPaginated: boolean } },
): Promise<{ children: Doc<"files_nodes">[]; cursor: ChildCursor; isDone: boolean } | null> {
	const { folder, cursor } = args;

	if (cursor?.mode === "tie") {
		// Convex allows one paginated query per mutation. A step that already did one ends here.
		if (args.budget.hasPaginated) return null;
		args.budget.hasPaginated = true;
		const page = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_parent_name", (q) =>
				q
					.eq("organizationId", folder.organizationId)
					.eq("workspaceId", folder.workspaceId).eq("moveCohortId", undefined)
					.eq("parentId", folder._id)
					.eq("name", cursor.name)
					.eq("_creationTime", cursor.creationTime),
			)
			.paginate({ cursor: cursor.pageCursor, numItems: PAGE_SIZE });
		return {
			children: page.page,
			cursor: page.isDone
				? { mode: "after", name: cursor.name, creationTime: cursor.creationTime }
				: { ...cursor, pageCursor: page.continueCursor },
			isDone: false,
		};
	}

	const docs =
		cursor === null
			? await ctx.db
					.query("files_nodes")
					.withIndex("by_organization_workspace_parent_name", (q) =>
						q
							.eq("organizationId", folder.organizationId)
							.eq("workspaceId", folder.workspaceId).eq("moveCohortId", undefined)
							.eq("parentId", folder._id),
					)
					.take(PAGE_SIZE + 1)
			: await ctx.db
					.query("files_nodes")
					.withIndex("by_organization_workspace_parent_name", (q) =>
						q
							.eq("organizationId", folder.organizationId)
							.eq("workspaceId", folder.workspaceId).eq("moveCohortId", undefined)
							.eq("parentId", folder._id)
							.eq("name", cursor.name)
							.gt("_creationTime", cursor.creationTime),
					)
					.take(PAGE_SIZE + 1);
	// One index range cannot start after a name and a creation time. So read the rest of the cursor's
	// name group first, then the names after it.
	if (cursor !== null && docs.length <= PAGE_SIZE) {
		docs.push(
			...(await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_parent_name", (q) =>
					q
						.eq("organizationId", folder.organizationId)
						.eq("workspaceId", folder.workspaceId).eq("moveCohortId", undefined)
						.eq("parentId", folder._id)
						.gt("name", cursor.name),
				)
				.take(PAGE_SIZE + 1 - docs.length)),
		);
	}

	if (docs.length <= PAGE_SIZE) {
		const last = docs.at(-1);
		return {
			children: docs,
			cursor: last ? { mode: "after", name: last.name, creationTime: last._creationTime } : cursor,
			isDone: true,
		};
	}

	// The next page starts after a name and a creation time, so it cannot start inside a group of
	// children that share both. Leave the group of the first child after this page for the next page.
	const next = docs[PAGE_SIZE]!;
	const children = docs
		.slice(0, PAGE_SIZE)
		.filter((child) => child.name !== next.name || child._creationTime !== next._creationTime);
	if (children.length > 0) {
		const last = children.at(-1)!;
		return { children, cursor: { mode: "after", name: last.name, creationTime: last._creationTime }, isDone: false };
	}

	// The group fills the whole page. Only a paginated read can go through it.
	return await db_read_children(ctx, {
		...args,
		cursor: { mode: "tie", name: next.name, creationTime: next._creationTime, pageCursor: null },
	});
}

/**
 * The children a step handles next for a queue row: the pending ones first, then the next page. A
 * pending child that somebody moved out of the folder or deleted meanwhile is left out. Returns null
 * when the next page needs a paginated read and this mutation already did one.
 */
export async function files_subtree_ops_db_next_children(
	ctx: MutationCtx,
	args: { row: Doc<"files_subtree_op_nodes">; folder: Doc<"files_nodes">; budget: { hasPaginated: boolean } },
) {
	const { row, folder } = args;
	if (row.pending.length === 0) {
		return await db_read_children(ctx, { folder, cursor: row.cursor, budget: args.budget });
	}

	const pending = await Promise.all(row.pending.map((nodeId) => ctx.db.get("files_nodes", nodeId)));
	return {
		children: pending.filter((child): child is Doc<"files_nodes"> => child !== null && child.parentId === folder._id),
		cursor: row.cursor,
		isDone: false,
	};
}

/**
 * Save a queue row after a step handled the children from `files_subtree_ops_db_next_children`, or
 * the first part of them. `pending` holds the ones the step did not reach. The folders the step found
 * get the next numbers, so the walk goes into them before anything else in the queue. With
 * `isRowFirst`, the row gets the number after them and runs before them.
 */
export async function files_subtree_ops_db_save_page(
	ctx: MutationCtx,
	args: {
		row: Doc<"files_subtree_op_nodes">;
		cursor: ChildCursor;
		isDone: boolean;
		pending: Array<Id<"files_nodes">>;
		folderIds: Array<Id<"files_nodes">>;
		isRowFirst: boolean;
	},
) {
	await files_subtree_ops_db_enqueue_nodes(ctx, {
		opId: args.row.opId,
		nodes: args.folderIds.map((nodeId) => ({ nodeId, nodeDone: true })),
	});
	if (args.isDone && args.pending.length === 0) {
		await ctx.db.delete("files_subtree_op_nodes", args.row._id);
	} else if (args.isRowFirst) {
		const walk = await db_require_walk(ctx, args.row.opId);
		await ctx.db.patch("files_subtree_op_walks", walk._id, { sequence: walk.sequence + 1 });
		await ctx.db.patch("files_subtree_op_nodes", args.row._id, {
			cursor: args.cursor,
			pending: args.pending,
			sequence: walk.sequence,
		});
	} else {
		await ctx.db.patch("files_subtree_op_nodes", args.row._id, { cursor: args.cursor, pending: args.pending });
	}
}

/**
 * Rewrite the path and scope of each child in the op's queue from its live parent. The request
 * already changed the roots. When the queue is empty, a pass ended. Walk again from the roots,
 * until a pass writes nothing.
 */
async function db_rebuild_walk(args: {
	ctx: MutationCtx;
	op: Doc<"files_subtree_ops">;
	budget: { nodes: number; hasPaginated: boolean };
}) {
	const { ctx, op, budget } = args;
	if (await db_pause_for_move(ctx, op)) return false;

	const walk = await db_require_walk(ctx, op._id);
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
			if (child.kind === "folder") {
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
	await files_subtree_ops_db_enqueue_nodes(ctx, {
		opId,
		nodes: folders.map((root) => ({ nodeId: root.node._id, nodeDone: true })),
	});

	const op = (await ctx.db.get("files_subtree_ops", opId))!;
	if (!args.deferWalk && (await db_rebuild_walk({ ctx, op, budget: args.budget }))) {
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

/**
 * Delete an ended op with its step state, then look again at the ops that waited for it. A waiter
 * that overlaps nothing any more starts. The others wait for the op they overlap now, so no waiter
 * keeps the id of a deleted op. The caller finishes the Activity.
 */
export async function files_subtree_ops_db_delete(
	ctx: MutationCtx,
	args: { opId: Id<"files_subtree_ops">; now: number },
) {
	const walk = await db_require_walk(ctx, args.opId);
	await ctx.db.delete("files_subtree_op_walks", walk._id);

	// An op that ended early can leave many nodes in its queue. Delete the rest in a later mutation.
	const rows = await ctx.db
		.query("files_subtree_op_nodes")
		.withIndex("by_op_sequence", (q) => q.eq("opId", args.opId))
		.take(PAGE_SIZE);
	for (const row of rows) {
		await ctx.db.delete("files_subtree_op_nodes", row._id);
	}
	if (rows.length === PAGE_SIZE) {
		await ctx.scheduler.runAfter(0, internal.files_subtree_ops.delete_queue, { opId: args.opId });
	}

	await ctx.db.delete("files_subtree_ops", args.opId);

	await db_release_waiters(ctx, { opId: args.opId });
}

/**
 * Look again at the ops that waited for the deleted op `opId`, oldest first. A waiter that overlaps
 * nothing any more starts. The others wait for the op they overlap now. A restore can mark `/` busy,
 * so many ops can wait behind one op, and each check reads every op of the workspace. So stop near
 * the transaction limits and go on in a later mutation.
 */
async function db_release_waiters(ctx: MutationCtx, args: { opId: Id<"files_subtree_ops"> }) {
	while (true) {
		// Each waiter gets a new `blockedByOpId` below, so it leaves this index range.
		const waiter = await ctx.db
			.query("files_subtree_ops")
			.withIndex("by_blockedByOp", (q) => q.eq("blockedByOpId", args.opId))
			.first();
		if (!waiter) return;

		if (await files_subtree_ops_db_is_near_limits(ctx)) {
			await ctx.scheduler.runAfter(0, internal.files_subtree_ops.release_waiters, { opId: args.opId });
			return;
		}

		const blocker = await files_subtree_ops_db_find_blocker(ctx, {
			organizationId: waiter.organizationId,
			workspaceId: waiter.workspaceId,
			treePaths: busy_tree_paths(waiter),
			waiter,
		});
		await ctx.db.patch("files_subtree_ops", waiter._id, { blockedByOpId: blocker?._id ?? null });
		if (!blocker) {
			await ctx.scheduler.runAfter(0, internal.files_subtree_ops.promote, { opId: waiter._id });
		}
	}
}

/**
 * Mark a queued op running and schedule its first step. The kind's promote calls this after its
 * checks passed again.
 */
export async function files_subtree_ops_db_run(ctx: MutationCtx, args: { opId: Id<"files_subtree_ops">; now: number }) {
	await ctx.db.patch("files_subtree_ops", args.opId, { status: "running" });
	await files_subtree_ops_db_schedule_step(ctx, args);
}

/**
 * The Activity deadline passed. The op has no Stop, so schedule its step again instead of ending it.
 * When the old step still runs after all, one of the two finds a newer step number and does
 * nothing. The caller moves the deadline.
 */
export async function files_subtree_ops_db_recover(ctx: MutationCtx, args: { opId: Id<"files_subtree_ops"> }) {
	const op = await ctx.db.get("files_subtree_ops", args.opId);
	if (!op) {
		return;
	}

	if (op.status === "queued") {
		// A waiter whose blocker ended starts through promote. Run promote again in case it threw.
		if (op.blockedByOpId === null) {
			await ctx.scheduler.runAfter(0, internal.files_subtree_ops.promote, { opId: op._id });
		}
		return;
	}

	const walk = await db_require_walk(ctx, op._id);
	await ctx.scheduler.runAfter(0, internal.files_subtree_ops.advance, { opId: op._id, step: walk.step });
}

async function db_pause_for_move(ctx: MutationCtx, op: Doc<"files_subtree_ops">) {
	const worker = { kind: "subtree" as const, id: op._id };
	// Whole-workspace restore has no root yet. Other jobs check only their exact roots.
	if (op.rootNodeIds.length === 0) return await files_move_reservations_db_pause_worker(ctx, {
		worker, check: { wholeWorkspace: { organizationId: op.organizationId, workspaceId: op.workspaceId } },
	});
	for (const nodeId of op.rootNodeIds) {
		const check = { source: { kind: "saved" as const, id: nodeId } };
		if (await files_move_reservations_db_find_blocker(ctx.db, check))
			return await files_move_reservations_db_pause_worker(ctx, { worker, check });
	}
	return await files_move_reservations_db_pause_worker(ctx, {
		worker, check: { source: { kind: "saved", id: op.rootNodeIds[0]! } },
	});
}

export const advance = internalMutation({
	args: { opId: v.id("files_subtree_ops"), step: v.number() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const op = await ctx.db.get("files_subtree_ops", args.opId);
		if (!op || op.status !== "running") {
			return null;
		}

		// A step that recover scheduled again, while the first one still ran, finds a newer number.
		const walk = await db_require_walk(ctx, op._id);
		if (walk.step !== args.step) {
			return null;
		}

		const now = Date.now();
		switch (op.kind) {
			case "move":
			case "scope": {
				if (
					await db_rebuild_walk({ ctx, op, budget: { nodes: files_subtree_ops_STEP_MAX_NODES, hasPaginated: false } })
				) {
					await files_subtree_ops_db_delete(ctx, { opId: op._id, now });
					await activities_db_finish(ctx, { sourceId: op._id, status: "succeeded", errorMessage: null, now });
				} else {
					await files_subtree_ops_db_schedule_step(ctx, { opId: op._id, now });
				}
				return null;
			}
			case "archive":
			case "restore": {
				if (await db_pause_for_move(ctx, op)) return null;
				await files_archive_runs_db_advance(ctx, { op, now });
				return null;
			}
			case "copy": {
				throw should_never_happen("A copy op has no step. Its transfer run keeps the steps", { opId: op._id });
			}
			default:
				throw should_never_happen("Unknown subtree op", op satisfies never);
		}
	},
});

export const promote = internalMutation({
	args: { opId: v.id("files_subtree_ops") },
	returns: v.null(),
	handler: async (ctx, args) => {
		const op = await ctx.db.get("files_subtree_ops", args.opId);
		if (!op || op.status !== "queued" || op.blockedByOpId !== null) {
			return null;
		}
		if (await db_pause_for_move(ctx, op)) return null;

		const now = Date.now();
		switch (op.kind) {
			case "restore": {
				await files_archive_runs_db_promote(ctx, { op, now });
				return null;
			}
			case "copy": {
				await files_transfer_db_promote(ctx, { op, now });
				return null;
			}
			case "move":
			case "scope":
			case "archive": {
				throw should_never_happen("This op kind never waits", { opId: op._id, kind: op.kind });
			}
			default:
				throw should_never_happen("Unknown subtree op", op satisfies never);
		}
	},
});

export const release_waiters = internalMutation({
	args: { opId: v.id("files_subtree_ops") },
	returns: v.null(),
	handler: async (ctx, args) => {
		await db_release_waiters(ctx, args);
		return null;
	},
});

export const delete_queue = internalMutation({
	args: { opId: v.id("files_subtree_ops") },
	returns: v.null(),
	handler: async (ctx, args) => {
		const rows = await ctx.db
			.query("files_subtree_op_nodes")
			.withIndex("by_op_sequence", (q) => q.eq("opId", args.opId))
			.take(PAGE_SIZE * 10);
		for (const row of rows) {
			await ctx.db.delete("files_subtree_op_nodes", row._id);
		}
		if (rows.length === PAGE_SIZE * 10) {
			await ctx.scheduler.runAfter(0, internal.files_subtree_ops.delete_queue, { opId: args.opId });
		}
		return null;
	},
});
