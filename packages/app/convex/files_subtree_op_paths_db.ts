// Keep the path tree in small steps. The job stays until old paths and input chunks are gone, so
// Trash never treats a partly built index as clear. Cleanup can outlive its op and Activity.

import { internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import { files_subtree_ops_db_is_near_limits, files_subtree_ops_RECOVER_AFTER_MS } from "./files_subtree_ops_db.ts";
import {
	files_subtree_op_paths_tree_delete,
	files_subtree_op_paths_tree_insert,
} from "./files_subtree_op_paths_tree.ts";

const INPUT_PATHS = 32;
const STEP_MAX_CHANGES = 32;
const SYNC_MAX_CHANGES = 4;

async function db_schedule(
	ctx: MutationCtx,
	args: { jobId: Id<"files_subtree_op_path_jobs">; generation: number; step: number },
) {
	// A bulk Restore can create hundreds of jobs. Leave a quarter of the schedule slots for its other
	// work. A job with no slot keeps its marker and waits for the five-minute recovery pass.
	const { functionsScheduled } = await ctx.meta.getTransactionMetrics();
	const available =
		functionsScheduled.remaining - Math.ceil((functionsScheduled.used + functionsScheduled.remaining) * 0.25);
	if (available > 0) await ctx.scheduler.runAfter(0, internal.files_subtree_ops.path_index_advance, args);
	if (available > 1) await ctx.scheduler.runAfter(60_000, internal.files_subtree_ops.path_index_advance, args);
}

export async function files_subtree_op_paths_db_has_pending(
	ctx: MutationCtx | QueryCtx,
	args: { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces"> },
) {
	return (
		(await ctx.db
			.query("files_subtree_op_path_jobs")
			.withIndex("by_organization_workspace", (q) =>
				q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId),
			)
			.first()) !== null
	);
}

export async function files_subtree_op_paths_db_replace(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		opId: Id<"files_subtree_ops">;
		oldTreePaths: readonly string[];
		treePaths: readonly string[];
		defer?: boolean;
		now: number;
	},
) {
	const previous = new Set(args.oldTreePaths);
	const next = new Set(args.treePaths);
	const removed = [...previous].filter((treePath) => !next.has(treePath));
	const added = [...next].filter((treePath) => !previous.has(treePath));
	const job = await ctx.db
		.query("files_subtree_op_path_jobs")
		.withIndex("by_op", (q) => q.eq("opId", args.opId))
		.first();

	// Queued ops can arrive in a bulk request. Keep their tree work in the background too.
	if (!job && !args.defer && removed.length + added.length <= SYNC_MAX_CHANGES) {
		let remaining = removed.length + added.length;
		for (const treePath of removed) {
			if (await files_subtree_ops_db_is_near_limits(ctx)) break;
			// Tree deletion can move a successor's key to another doc. Always find the next key afresh.
			const path = await ctx.db
				.query("files_subtree_op_paths")
				.withIndex("by_op_treePath", (q) => q.eq("opId", args.opId).eq("treePath", treePath))
				.first();
			if (path) await files_subtree_op_paths_tree_delete(ctx, path);
			remaining -= 1;
		}
		if (remaining === added.length) {
			for (const treePath of added) {
				if (await files_subtree_ops_db_is_near_limits(ctx)) break;
				await files_subtree_op_paths_tree_insert(ctx, {
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					opId: args.opId,
					treePath,
				});
				remaining -= 1;
			}
		}
		if (remaining === 0) return;
	}

	const generation = (job?.generation ?? 0) + 1;
	const fields = { generation, step: 0, phase: "clear" as const, updatedAt: args.now };
	const jobId =
		job?._id ??
		(await ctx.db.insert("files_subtree_op_path_jobs", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			opId: args.opId,
			...fields,
		}));
	if (job) await ctx.db.patch("files_subtree_op_path_jobs", jobId, fields);

	// The existing op has at most two path arrays, each at most 8,192 entries, in one doc. Snapshot
	// that already-owned value in at most 512 chunks; later steps never read the large op again.
	const treePaths = [...next];
	for (let index = 0; index < treePaths.length; index += INPUT_PATHS) {
		await ctx.db.insert("files_subtree_op_path_inputs", {
			jobId,
			generation,
			order: index / INPUT_PATHS,
			treePaths: treePaths.slice(index, index + INPUT_PATHS),
			nextPath: 0,
		});
	}
	await db_schedule(ctx, { jobId, generation, step: 0 });
}

export async function files_subtree_op_paths_db_advance(
	ctx: MutationCtx,
	args: { jobId: Id<"files_subtree_op_path_jobs">; generation: number; step: number },
) {
	const job = await ctx.db.get("files_subtree_op_path_jobs", args.jobId);
	if (!job || job.generation !== args.generation || job.step !== args.step) return 0;

	let phase = job.phase;
	let changed = 0;
	let deletedCount = 0;
	while (changed < STEP_MAX_CHANGES && !(await files_subtree_ops_db_is_near_limits(ctx))) {
		if (phase === "clear") {
			const path = await ctx.db
				.query("files_subtree_op_paths")
				.withIndex("by_op_treePath", (q) => q.eq("opId", job.opId))
				.first();
			if (path) {
				await files_subtree_op_paths_tree_delete(ctx, path);
				changed += 1;
				deletedCount += 1;
				continue;
			}
			const stale = await ctx.db
				.query("files_subtree_op_path_inputs")
				.withIndex("by_job_generation_order", (q) => q.eq("jobId", job._id).lt("generation", job.generation))
				.first();
			if (stale) {
				await ctx.db.delete("files_subtree_op_path_inputs", stale._id);
				changed += 1;
				deletedCount += 1;
				continue;
			}
			phase = "build";
		}

		const input = await ctx.db
			.query("files_subtree_op_path_inputs")
			.withIndex("by_job_generation_order", (q) => q.eq("jobId", job._id).eq("generation", job.generation))
			.first();
		if (!input) {
			await ctx.db.delete("files_subtree_op_path_jobs", job._id);
			deletedCount += 1;
			if (!(await files_subtree_op_paths_db_has_pending(ctx, job))) {
				await ctx.scheduler.runAfter(0, internal.files_subtree_ops.path_index_wake, {
					organizationId: job.organizationId,
					workspaceId: job.workspaceId,
				});
			}
			return deletedCount;
		}

		let nextPath = input.nextPath;
		while (
			nextPath < input.treePaths.length &&
			changed < STEP_MAX_CHANGES &&
			!(await files_subtree_ops_db_is_near_limits(ctx))
		) {
			await files_subtree_op_paths_tree_insert(ctx, {
				organizationId: job.organizationId,
				workspaceId: job.workspaceId,
				opId: job.opId,
				treePath: input.treePaths[nextPath]!,
			});
			nextPath += 1;
			changed += 1;
		}
		if (nextPath === input.treePaths.length) {
			await ctx.db.delete("files_subtree_op_path_inputs", input._id);
			deletedCount += 1;
		} else await ctx.db.patch("files_subtree_op_path_inputs", input._id, { nextPath });
	}

	const step = job.step + 1;
	await ctx.db.patch("files_subtree_op_path_jobs", job._id, { phase, step, updatedAt: Date.now() });
	await db_schedule(ctx, { jobId: job._id, generation: job.generation, step });
	return deletedCount;
}

export async function files_subtree_op_paths_db_recover(ctx: MutationCtx) {
	const now = Date.now();
	const jobs = await ctx.db
		.query("files_subtree_op_path_jobs")
		.withIndex("by_updatedAt", (q) => q.lt("updatedAt", now - files_subtree_ops_RECOVER_AFTER_MS))
		.take(50);
	for (const job of jobs) {
		await ctx.db.patch("files_subtree_op_path_jobs", job._id, { updatedAt: now });
		await db_schedule(ctx, { jobId: job._id, generation: job.generation, step: job.step });
	}
	if (jobs.length === 50) await ctx.scheduler.runAfter(0, internal.files_subtree_ops.path_index_recover, {});
}
