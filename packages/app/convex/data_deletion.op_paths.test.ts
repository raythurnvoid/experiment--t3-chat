import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import { data_deletion_db_request } from "./data_deletion_requests.ts";
import { fixture, folder, type Fixture } from "./files_archive_runs.setup.test.ts";
import { test_mocks_fill_db_with } from "./setup.test.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function start_archive(f: Fixture, count: number) {
	const nodeIds = [];
	for (let index = 0; index < count; index++) {
		const path = `/folder-${String(index).padStart(2, "0")}`;
		nodeIds.push(await folder(f, path));
		// The child keeps the Archive op alive after its named folder is stamped.
		await folder(f, `${path}/child`);
	}
	const archived = await f.asOwner.mutation(api.files_nodes.archive_nodes, {
		membershipId: f.db.membershipId,
		nodeIds,
	});
	if (archived._nay) throw new Error(archived._nay.message);
	expect(archived._yay).toMatchObject({ isDone: false, notArchivedNodeIds: [] });
	return archived._yay!;
}

async function read_index(f: Fixture) {
	return await f.t.run(async (ctx) => {
		const ops = await ctx.db
			.query("files_subtree_ops")
			.withIndex("by_organization_workspace_kind", (q) =>
				q.eq("organizationId", f.db.organizationId).eq("workspaceId", f.db.workspaceId),
			)
			.collect();
		const paths = await ctx.db
			.query("files_subtree_op_paths")
			.withIndex("by_organization_workspace_parent", (q) =>
				q.eq("organizationId", f.db.organizationId).eq("workspaceId", f.db.workspaceId),
			)
			.collect();
		const jobs = await ctx.db
			.query("files_subtree_op_path_jobs")
			.withIndex("by_organization_workspace", (q) =>
				q.eq("organizationId", f.db.organizationId).eq("workspaceId", f.db.workspaceId),
			)
			.collect();
		return { ops, paths, jobs };
	});
}

describe("workspace purge of subtree op paths", () => {
	test.each(["staged", "building", "built"] as const)("purges a %s path index", async (phase) => {
		const f = await fixture({ transactionLimits: true });
		const controlDb = await f.t.run((ctx) => test_mocks_fill_db_with.membership(ctx, { organizationName: "control" }));
		const control = {
			t: f.t,
			db: controlDb,
			asOwner: f.t.withIdentity({ issuer: "https://clerk.test", external_id: controlDb.userId }),
		};
		await start_archive(control, 2);
		const kept = await read_index(control);
		expect(kept.ops).toHaveLength(1);
		expect(kept.paths).toHaveLength(2);

		const archived = await start_archive(f, phase === "built" ? 32 : 40);
		const started = await read_index(f);
		expect(started.ops).toHaveLength(1);
		expect(started.jobs).toHaveLength(1);
		const job = started.jobs[0]!;
		const oldCallback = { jobId: job._id, generation: job.generation, step: job.step };
		if (phase !== "staged") await f.t.mutation(internal.files_subtree_ops.path_index_advance, oldCallback);
		const before = await read_index(f);
		expect(before.paths).toHaveLength(phase === "staged" ? 0 : 32);
		const inputs = await f.t.run((ctx) =>
			ctx.db
				.query("files_subtree_op_path_inputs")
				.withIndex("by_job_generation_order", (q) => q.eq("jobId", job._id))
				.collect(),
		);
		expect(inputs).toHaveLength(phase === "staged" ? 2 : phase === "building" ? 1 : 0);
		const read_job_doc_counts = async () =>
			await f.t.run(async (ctx) => ({
				paths: (
					await ctx.db
						.query("files_subtree_op_paths")
						.withIndex("by_op_treePath", (q) => q.eq("opId", job.opId))
						.collect()
				).length,
				inputs: (
					await ctx.db
						.query("files_subtree_op_path_inputs")
						.withIndex("by_job_generation_order", (q) => q.eq("jobId", job._id))
						.collect()
				).length,
				jobs: (await ctx.db.get("files_subtree_op_path_jobs", job._id)) ? 1 : 0,
			}));

		const requestId = await f.t.run((ctx) =>
			data_deletion_db_request(ctx, {
				userId: f.db.userId,
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				scope: "workspace",
				eligibleAt: Date.now(),
			}),
		);
		let done = false;
		let cleanupPasses = 0;
		let emptyJobPasses = 0;
		for (let pass = 0; pass < 200 && !done; pass++) {
			const hasProducer = await f.t.run(async (ctx) =>
				Boolean(
					(await ctx.db.get("files_archive_runs", archived.runId)) ?? (await ctx.db.get("files_subtree_ops", job.opId)),
				),
			);
			const beforePass = hasProducer ? null : await read_job_doc_counts();
			const result = await f.t.mutation(internal.data_deletion.process_workspace_deletion_request, {
				requestId,
				_test_batchSize: 20,
			});
			if (beforePass?.jobs) {
				const afterPass = await read_job_doc_counts();
				const removed =
					beforePass.paths + beforePass.inputs + beforePass.jobs - afterPass.paths - afterPass.inputs - afterPass.jobs;
				expect(result.deletedCount, "workspace purge must report each removed path doc, input chunk, and job").toBe(
					removed,
				);
				cleanupPasses += 1;
				if (beforePass.paths === 0 && beforePass.inputs === 0) {
					expect(result.deletedCount, "the last empty path job must count as one deleted doc").toBe(1);
					emptyJobPasses += 1;
				}
			}
			done = result.done;
		}
		expect(done).toBe(true);
		expect(cleanupPasses).toBeGreaterThan(0);
		if (phase === "built") expect(emptyJobPasses).toBe(1);
		expect(await f.t.run((ctx) => ctx.db.get("data_deletion_requests", requestId))).toBeNull();
		expect(await read_index(f)).toEqual({ ops: [], paths: [], jobs: [] });
		expect(await f.t.run((ctx) => ctx.db.query("files_subtree_op_path_inputs").collect())).toEqual([]);
		expect(await read_index(control)).toEqual(kept);

		// Retry both the original and the last build step after the purge removed their job.
		for (const callback of [oldCallback, { ...oldCallback, step: before.jobs[0]!.step }]) {
			await f.t.mutation(internal.files_subtree_ops.path_index_advance, callback);
		}
		expect(await read_index(f)).toEqual({ ops: [], paths: [], jobs: [] });
		expect(await f.t.run((ctx) => ctx.db.query("files_subtree_op_path_inputs").collect())).toEqual([]);
		expect(await read_index(control)).toEqual(kept);
	});
});
