// The queue and walk helpers that every subtree op kind shares: insert, schedule and delete an op, find
// the ops that overlap a path, queue its folders, read the next children, and wait while a Move holds
// the workspace. Each kind keeps its own writes in its owner: files_subtree_ops_rebuild.ts (move and
// scope), files_archive_runs.ts (archive and restore) and files_transfer.ts (copy).

import type { WithoutSystemFields } from "convex/server";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import {
	files_move_reservations_db_find_blocker,
	files_move_reservations_db_pause_worker,
} from "../server/files-move-reservations.ts";
import { files_pending_overlay_db_flush } from "../server/files-pending-overlay.ts";
import { should_never_happen } from "../shared/shared-utils.ts";

/**
 * A step also ends when less than this share of a transaction limit is left. A file with many text
 * chunks writes far more than its node, so the node count alone is not enough.
 */
const METRICS_MIN_REMAINING_SHARE = 0.25;

export const files_subtree_ops_PAGE_SIZE = 50;

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

export function files_subtree_ops_busy_tree_paths(op: Doc<"files_subtree_ops">) {
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
function files_subtree_ops_tree_paths_overlap(left: string, right: string) {
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
		const overlaps = files_subtree_ops_busy_tree_paths(op).some((busyPath) =>
			args.treePaths.some((treePath) => files_subtree_ops_tree_paths_overlap(busyPath, treePath)),
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
 */
export async function files_subtree_ops_db_find_blocked_paths(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		treePaths: readonly string[];
		maxOps: number;
	},
) {
	const blocked = args.treePaths.map(() => false);
	let opCount = 0;
	for await (const op of ctx.db
		.query("files_subtree_ops")
		.withIndex("by_organization_workspace_kind", (q) =>
			q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId),
		)) {
		opCount += 1;
		if (opCount > args.maxOps) return null;

		const busyPaths = files_subtree_ops_busy_tree_paths(op);
		for (const [index, treePath] of args.treePaths.entries()) {
			blocked[index] ||= busyPaths.some((busyPath) => files_subtree_ops_tree_paths_overlap(busyPath, treePath));
		}
	}
	return blocked;
}

export async function files_subtree_ops_db_require_walk(
	ctx: QueryCtx | MutationCtx,
	opId: Id<"files_subtree_ops">,
) {
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
	const walk = await files_subtree_ops_db_require_walk(ctx, args.opId);
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

	const walk = await files_subtree_ops_db_require_walk(ctx, args.opId);
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
	const walk = await files_subtree_ops_db_require_walk(ctx, args.opId);
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
					.eq("workspaceId", folder.workspaceId)
					.eq("moveCohortId", undefined)
					.eq("parentId", folder._id)
					.eq("name", cursor.name)
					.eq("_creationTime", cursor.creationTime),
			)
			.paginate({ cursor: cursor.pageCursor, numItems: files_subtree_ops_PAGE_SIZE });
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
							.eq("workspaceId", folder.workspaceId)
							.eq("moveCohortId", undefined)
							.eq("parentId", folder._id),
					)
					.take(files_subtree_ops_PAGE_SIZE + 1)
			: await ctx.db
					.query("files_nodes")
					.withIndex("by_organization_workspace_parent_name", (q) =>
						q
							.eq("organizationId", folder.organizationId)
							.eq("workspaceId", folder.workspaceId)
							.eq("moveCohortId", undefined)
							.eq("parentId", folder._id)
							.eq("name", cursor.name)
							.gt("_creationTime", cursor.creationTime),
					)
					.take(files_subtree_ops_PAGE_SIZE + 1);
	// One index range cannot start after a name and a creation time. So read the rest of the cursor's
	// name group first, then the names after it.
	if (cursor !== null && docs.length <= files_subtree_ops_PAGE_SIZE) {
		docs.push(
			...(await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_parent_name", (q) =>
					q
						.eq("organizationId", folder.organizationId)
						.eq("workspaceId", folder.workspaceId)
						.eq("moveCohortId", undefined)
						.eq("parentId", folder._id)
						.gt("name", cursor.name),
				)
				.take(files_subtree_ops_PAGE_SIZE + 1 - docs.length)),
		);
	}

	if (docs.length <= files_subtree_ops_PAGE_SIZE) {
		const last = docs.at(-1);
		return {
			children: docs,
			cursor: last ? { mode: "after", name: last.name, creationTime: last._creationTime } : cursor,
			isDone: true,
		};
	}

	// The next page starts after a name and a creation time, so it cannot start inside a group of
	// children that share both. Leave the group of the first child after this page for the next page.
	const next = docs[files_subtree_ops_PAGE_SIZE]!;
	const children = docs
		.slice(0, files_subtree_ops_PAGE_SIZE)
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
		const walk = await files_subtree_ops_db_require_walk(ctx, args.row.opId);
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

export async function files_subtree_ops_db_pause_for_move(ctx: MutationCtx, op: Doc<"files_subtree_ops">) {
	// The walk reads only nodes that no Move holds. A held node under a root would keep its old scope or
	// archive state, and an aborted Move writes its old header back. No index finds a held node under a
	// root, so wait while any Move holds the workspace. The walk then sees every node.
	return await files_move_reservations_db_pause_worker(ctx, {
		worker: { kind: "subtree", id: op._id },
		check: { wholeWorkspace: { organizationId: op.organizationId, workspaceId: op.workspaceId } },
	});
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
	const walk = await files_subtree_ops_db_require_walk(ctx, args.opId);
	await ctx.db.delete("files_subtree_op_walks", walk._id);

	// A folder that stopped being restricted is a boundary only until its own newest scope op ends. A
	// newer op on the same root does this at its own end.
	const op = await ctx.db.get("files_subtree_ops", args.opId);
	if (op?.kind === "scope") {
		for (const nodeId of op.rootNodeIds) {
			const node = await ctx.db.get("files_nodes", nodeId);
			if (node?.scopeOpId !== args.opId) continue;
			await ctx.db.patch("files_nodes", nodeId, {
				scopeOpId: undefined,
				...(node.isRestrictedScopeRoot ? {} : { parentScopeNodeId: undefined }),
			});
		}
	}

	// An op that ended early can leave many nodes in its queue. Delete the rest in a later mutation.
	const rows = await ctx.db
		.query("files_subtree_op_nodes")
		.withIndex("by_op_sequence", (q) => q.eq("opId", args.opId))
		.take(files_subtree_ops_PAGE_SIZE);
	for (const row of rows) {
		await ctx.db.delete("files_subtree_op_nodes", row._id);
	}
	if (rows.length === files_subtree_ops_PAGE_SIZE) {
		await ctx.scheduler.runAfter(0, internal.files_subtree_ops.delete_queue, { opId: args.opId });
	}

	await ctx.db.delete("files_subtree_ops", args.opId);

	await files_subtree_ops_db_release_waiters(ctx, { opId: args.opId });
}

/**
 * Look again at the ops that waited for the deleted op `opId`, oldest first. A waiter that overlaps
 * nothing any more starts. The others wait for the op they overlap now. A restore can mark `/` busy,
 * so many ops can wait behind one op, and each check reads every op of the workspace. So stop near
 * the transaction limits and go on in a later mutation.
 */
export async function files_subtree_ops_db_release_waiters(ctx: MutationCtx, args: { opId: Id<"files_subtree_ops"> }) {
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
			treePaths: files_subtree_ops_busy_tree_paths(waiter),
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
 * After this many deadline checks in a row find a running op at the same step, the step keeps failing.
 */
const STUCK_RECOVER_COUNT = 3;

/**
 * The Activity `errorCode` of a job whose step keeps failing. The server keeps trying.
 */
export const files_subtree_ops_STUCK_CODE = "subtree_op_stuck";

/**
 * Count one deadline check of a running op, and say whether its step keeps failing. Only the deadline
 * checks call this: they come minutes apart, and a working step moves the step number on in seconds.
 * An op that waits for a Move makes no step either, and that is not a failure. The Activity gets a
 * notice while the op is stuck, and loses it when a later check finds a new step.
 */
export async function files_subtree_ops_db_count_recover(
	ctx: MutationCtx,
	args: { opId: Id<"files_subtree_ops">; activity: Doc<"activities"> },
) {
	const op = await ctx.db.get("files_subtree_ops", args.opId);
	if (op?.status !== "running") return false;

	const walk = await files_subtree_ops_db_require_walk(ctx, op._id);
	// Ask the Move slot itself, not the waiter row: a step that throws cannot delete a stale row.
	const moveCohortId = await files_move_reservations_db_find_blocker(ctx.db, {
		wholeWorkspace: { organizationId: op.organizationId, workspaceId: op.workspaceId },
	});
	const recoverCount = walk.recoverStep === walk.step && !moveCohortId ? (walk.recoverCount ?? 0) + 1 : 0;
	await ctx.db.patch("files_subtree_op_walks", walk._id, { recoverStep: walk.step, recoverCount });

	const stuck = recoverCount >= STUCK_RECOVER_COUNT;
	if (stuck) {
		console.error("Subtree op step keeps failing", { opId: op._id, kind: op.kind, step: walk.step, recoverCount });
	}
	// Only set or clear this notice. Another code, like a Move wait, stays.
	if (stuck ? args.activity.errorCode == null : args.activity.errorCode === files_subtree_ops_STUCK_CODE) {
		await ctx.db.patch(
			"activities",
			args.activity._id,
			stuck
				? {
						errorCode: files_subtree_ops_STUCK_CODE,
						errorMessage: "A step of this job keeps failing. We try again on our own.",
					}
				: { errorCode: undefined, errorMessage: null },
		);
	}
	return stuck;
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

	const walk = await files_subtree_ops_db_require_walk(ctx, op._id);
	await ctx.scheduler.runAfter(0, internal.files_subtree_ops.advance, { opId: op._id, step: walk.step });
}
