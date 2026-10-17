// Shared database bodies. Keep editor and action work on their current owners.

import type { WithoutSystemFields } from "convex/server";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
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
export function files_subtree_ops_tree_paths_overlap(left: string, right: string) {
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
