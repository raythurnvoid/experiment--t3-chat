// A move, archive, restore, restrict, or copy of a folder changes every item inside it, and a big
// folder does not fit in one mutation. So the request writes what people must see now, for example
// the moved folder itself, and inserts one op. Steps then walk the folder by `parentId` and fix the
// stored copies inside, a few items per step. The last step deletes the op.
//
// Each step reads the parent again and writes each child from it. So a person may move, rename, or
// archive an item inside while the op runs. The walk follows the live tree and never puts it back.
//
// Move, rename, archive, and restrict start at once. Copy and restore wait while an op they overlap
// is still there. A waiting op is `queued`. It writes nothing until the op before it ends.

import { v } from "convex/values";
import type { WithoutSystemFields } from "convex/server";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { internalMutation, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import { activities_db_finish, activities_db_start } from "./activities_db.ts";
import { files_archive_runs_db_advance, files_archive_runs_db_promote } from "./files_archive_runs.ts";
import { files_media_validation_db_advance_version } from "./files_media_validation.ts";
import { files_nodes_db_rebuild_node } from "./files_nodes.ts";
import { files_transfer_db_promote } from "./files_transfer.ts";
import { organizations_membership_lifetimes_db_ensure } from "./organizations_membership_lifetimes.ts";
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
	const metrics = await ctx.meta.getTransactionMetrics();
	return [
		metrics.bytesRead,
		metrics.bytesWritten,
		metrics.documentsRead,
		metrics.documentsWritten,
		metrics.databaseQueries,
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
		// Only a folder's `treePath` ends with "/", and only a folder holds other paths. So a file `/docs`
		// never overlaps a folder `/docs-archive/`.
		const holds = (outer: string, inner: string) => outer === inner || (outer.endsWith("/") && inner.startsWith(outer));
		const overlaps = busy_tree_paths(op).some((busyPath) =>
			args.treePaths.some((treePath) => holds(busyPath, treePath) || holds(treePath, busyPath)),
		);
		if (overlaps) return op;
	}
	return null;
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
	await ctx.db.insert("files_subtree_op_walks", { opId, step: 0, passWrote: false, updatedAt: args.now });
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

export async function files_subtree_ops_db_enqueue_node(
	ctx: MutationCtx,
	args: { opId: Id<"files_subtree_ops">; nodeId: Id<"files_nodes">; nodeDone: boolean },
) {
	await ctx.db.insert("files_subtree_op_nodes", {
		opId: args.opId,
		nodeId: args.nodeId,
		nodeDone: args.nodeDone,
		cursor: null,
	});
}

export async function files_subtree_ops_db_first_node(ctx: MutationCtx, opId: Id<"files_subtree_ops">) {
	return await ctx.db
		.query("files_subtree_op_nodes")
		.withIndex("by_op", (q) => q.eq("opId", opId))
		.first();
}

/**
 * One page of a folder's children in name order, active and archived. Archived items can share a
 * name, and a page never splits them, so the next page can start after the last name. `cursor` is
 * null when the page reaches the last child.
 */
export async function files_subtree_ops_db_list_children(
	ctx: MutationCtx,
	args: { folder: Doc<"files_nodes">; cursor: string | null },
) {
	const { folder, cursor } = args;
	const docs = await ctx.db
		.query("files_nodes")
		.withIndex("by_organization_workspace_parent_name_archiveOperation", (q) => {
			const children = q
				.eq("organizationId", folder.organizationId)
				.eq("workspaceId", folder.workspaceId)
				.eq("parentId", folder._id);
			return cursor === null ? children : children.gt("name", cursor);
		})
		.take(PAGE_SIZE + 1);
	if (docs.length <= PAGE_SIZE) {
		return { children: docs, cursor: null };
	}

	// Leave the name the next page starts with for that page. When the whole page has that one name,
	// read all of it now.
	const nextName = docs[PAGE_SIZE]!.name;
	const children = docs.slice(0, PAGE_SIZE).filter((child) => child.name !== nextName);
	if (children.length > 0) {
		return { children, cursor: children.at(-1)!.name };
	}

	const sameName = await ctx.db
		.query("files_nodes")
		.withIndex("by_organization_workspace_parent_name_archiveOperation", (q) =>
			q
				.eq("organizationId", folder.organizationId)
				.eq("workspaceId", folder.workspaceId)
				.eq("parentId", folder._id)
				.eq("name", nextName),
		)
		.collect();
	return { children: sameName, cursor: nextName };
}

/**
 * Rewrite the path and scope of each child in the op's queue from its live parent. The request
 * already changed the roots. When the queue is empty, a pass ended. Walk again from the roots,
 * until a pass writes nothing.
 */
async function db_rebuild_walk(ctx: MutationCtx, op: Doc<"files_subtree_ops">, budget: { nodes: number }) {
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
			for (const rootNodeId of op.rootNodeIds) {
				await files_subtree_ops_db_enqueue_node(ctx, { opId: op._id, nodeId: rootNodeId, nodeDone: true });
			}
			continue;
		}

		const folder = await ctx.db.get("files_nodes", row.nodeId);
		if (!folder) {
			await ctx.db.delete("files_subtree_op_nodes", row._id);
			continue;
		}

		const page = await files_subtree_ops_db_list_children(ctx, { folder, cursor: row.cursor });
		let cursor = page.cursor;
		for (const [index, child] of page.children.entries()) {
			// A file with many side docs writes a lot, so a full step ends inside the page. The next page
			// starts after a name, so inside a group of items with one name the step ends before the group.
			// The next step reads the group again and finds the items this step wrote already right.
			if (index > 0 && (budget.nodes <= 0 || (await files_subtree_ops_db_is_near_limits(ctx)))) {
				cursor = page.children.slice(0, index).findLast((previous) => previous.name !== child.name)?.name ?? row.cursor;
				break;
			}
			count += 1;

			// Count only the items the step writes. So a step that reads a group again still gets further.
			if (await files_nodes_db_rebuild_node(ctx, { node: child, parent: folder })) {
				budget.nodes -= 1;
				passWrote = true;
				isWritten = true;
			}
			if (child.kind === "folder") {
				await files_subtree_ops_db_enqueue_node(ctx, { opId: op._id, nodeId: child._id, nodeDone: true });
			}
		}

		if (cursor === null) {
			await ctx.db.delete("files_subtree_op_nodes", row._id);
		} else {
			await ctx.db.patch("files_subtree_op_nodes", row._id, { cursor });
		}
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
 * Start the walk of a move or restrict after the request changed the roots. The first step runs
 * now. Returns null when the walk ended inside this request. Then no op and no Activity remain.
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
		budget: { nodes: number };
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
	for (const root of folders) {
		await files_subtree_ops_db_enqueue_node(ctx, { opId, nodeId: root.node._id, nodeDone: true });
	}

	const op = (await ctx.db.get("files_subtree_ops", opId))!;
	if (await db_rebuild_walk(ctx, op, args.budget)) {
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
		// A restrict shows no card. Its Activity only lets the recover cron find the op.
		feedVisible: args.kind === "move",
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
		.withIndex("by_op", (q) => q.eq("opId", args.opId))
		.take(PAGE_SIZE);
	for (const row of rows) {
		await ctx.db.delete("files_subtree_op_nodes", row._id);
	}
	if (rows.length === PAGE_SIZE) {
		await ctx.scheduler.runAfter(0, internal.files_subtree_ops.delete_queue, { opId: args.opId });
	}

	await ctx.db.delete("files_subtree_ops", args.opId);

	// Few ops wait at once, so read them all before the loop changes `blockedByOpId`.
	const waiters = await ctx.db
		.query("files_subtree_ops")
		.withIndex("by_blockedByOp", (q) => q.eq("blockedByOpId", args.opId))
		.collect();
	for (const waiter of waiters) {
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
				if (await db_rebuild_walk(ctx, op, { nodes: files_subtree_ops_STEP_MAX_NODES })) {
					await files_subtree_ops_db_delete(ctx, { opId: op._id, now });
					await activities_db_finish(ctx, { sourceId: op._id, status: "succeeded", errorMessage: null, now });
				} else {
					await files_subtree_ops_db_schedule_step(ctx, { opId: op._id, now });
				}
				return null;
			}
			case "archive":
			case "restore": {
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

export const delete_queue = internalMutation({
	args: { opId: v.id("files_subtree_ops") },
	returns: v.null(),
	handler: async (ctx, args) => {
		const rows = await ctx.db
			.query("files_subtree_op_nodes")
			.withIndex("by_op", (q) => q.eq("opId", args.opId))
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
