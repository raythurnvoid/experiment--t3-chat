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
//
// This module runs each step (`advance`). The queue and walk helpers that every op kind shares live in
// files_subtree_ops_db.ts. Move and scope ops start, and rewrite the items inside, in
// files_subtree_ops_rebuild.ts. The sharing doors import that module, so they do not load the archive
// and copy modules that this module imports.

import { v } from "convex/values";
import {
	files_subtree_ops_PAGE_SIZE as PAGE_SIZE,
	files_subtree_ops_db_require_walk as db_require_walk,
	files_subtree_ops_db_schedule_step,
	files_subtree_ops_db_delete,
	files_subtree_ops_db_pause_for_move,
	files_subtree_ops_db_release_waiters as db_release_waiters,
} from "./files_subtree_ops_db.ts";
import {
	files_subtree_ops_STEP_MAX_NODES,
	files_subtree_ops_db_rebuild_walk,
	files_subtree_ops_db_start_rebuild,
} from "./files_subtree_ops_rebuild.ts";
import { internal } from "./_generated/api.js";
import { internalMutation } from "./functions.ts";
import { activities_db_finish } from "./activities_db.ts";
import { files_archive_runs_db_advance, files_archive_runs_db_promote } from "./files_archive_runs.ts";
import { files_nodes_db_set_extended_scope } from "./files_sharing_db.ts";
import { files_transfer_db_promote } from "./files_transfer.ts";
import { should_never_happen } from "../shared/shared-utils.ts";

// Make Convex reuse the loaded module between calls, so warm calls skip the module load cost.
// Does NOT work for http actions (see http.ts). No mutable module-level state allowed here.
export const experimental_reuseContext = true;

/**
 * Make a plain open item an extended root and start the job that gives the items inside the new
 * chain. The account grant writer calls this with `ctx.runMutation`, in the same transaction, so its
 * light module does not load the file engine.
 */
export const extend_node = internalMutation({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		nodeId: v.id("files_nodes"),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		await files_nodes_db_set_extended_scope(ctx, { nodeId: args.nodeId, extended: true });
		const node = await ctx.db.get("files_nodes", args.nodeId);
		if (!node) throw should_never_happen("Extended node is missing", args);
		const organization = await ctx.db.get("organizations", args.organizationId);
		if (!organization) throw should_never_happen("Extended node has no organization", args);
		// Some callers (an install, a plugin setup) have no person, so the job runs as the organization owner.
		await files_subtree_ops_db_start_rebuild(ctx, {
			kind: "scope",
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: organization.ownerUserId,
			membership: null,
			roots: [{ node, oldTreePath: node.treePath }],
			budget: { nodes: files_subtree_ops_STEP_MAX_NODES, hasPaginated: false },
			now: Date.now(),
		});
		return null;
	},
});

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
				if (await files_subtree_ops_db_pause_for_move(ctx, op)) return null;
				if (
					await files_subtree_ops_db_rebuild_walk({
						ctx,
						op,
						budget: { nodes: files_subtree_ops_STEP_MAX_NODES, hasPaginated: false },
					})
				) {
					await files_subtree_ops_db_delete(ctx, { opId: op._id, now });
					await activities_db_finish(ctx, { sourceId: op._id, status: "succeeded", errorMessage: null, now });
				} else {
					await files_subtree_ops_db_schedule_step(ctx, { opId: op._id, now });
				}
				return null;
			}
			case "archive":
			case "restore":
			case "purge": {
				if (await files_subtree_ops_db_pause_for_move(ctx, op)) return null;
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
		if (await files_subtree_ops_db_pause_for_move(ctx, op)) return null;

		const now = Date.now();
		switch (op.kind) {
			case "restore":
			case "purge": {
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
