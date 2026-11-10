import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import {
	files_subtree_op_paths_db_advance,
	files_subtree_op_paths_db_has_pending,
	files_subtree_op_paths_db_replace,
} from "./files_subtree_op_paths_db.ts";
import { files_subtree_ops_db_insert, files_subtree_ops_RECOVER_AFTER_MS } from "./files_subtree_ops_db.ts";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

async function fixture() {
	const t = test_convex({ transactionLimits: true });
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId };
	const opId = await t.run((ctx) =>
		files_subtree_ops_db_insert(ctx, {
			op: {
				...scope,
				userId: db.userId,
				kind: "scope",
				status: "running",
				blockedByOpId: null,
				rootNodeIds: [],
				treePaths: [],
			},
			now: Date.now(),
		}),
	);
	return { t, db, scope, opId };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function replace(f: Fixture, treePaths: string[]) {
	await f.t.run(async (ctx) => {
		const op = (await ctx.db.get("files_subtree_ops", f.opId))!;
		await ctx.db.patch("files_subtree_ops", f.opId, { treePaths });
		await files_subtree_op_paths_db_replace(ctx, {
			...f.scope,
			opId: f.opId,
			oldTreePaths: op.treePaths,
			treePaths,
			now: Date.now(),
		});
	});
}

async function read_job(f: Fixture) {
	return await f.t.run((ctx) =>
		ctx.db
			.query("files_subtree_op_path_jobs")
			.withIndex("by_op", (q) => q.eq("opId", f.opId))
			.first(),
	);
}

async function read_paths(f: Fixture) {
	return await f.t.run(async (ctx) =>
		(
			await ctx.db
				.query("files_subtree_op_paths")
				.withIndex("by_op_treePath", (q) => q.eq("opId", f.opId))
				.collect()
		)
			.map((path) => path.treePath)
			.sort(),
	);
}

async function advance(f: Fixture, job: Doc<"files_subtree_op_path_jobs">) {
	await f.t.mutation(internal.files_subtree_ops.path_index_advance, {
		jobId: job._id,
		generation: job.generation,
		step: job.step,
	});
}

async function finish(f: Fixture) {
	for (let count = 0; count < 200; count++) {
		const job = await read_job(f);
		if (!job) return;
		await advance(f, job);
	}
	throw new Error("The path index job did not finish");
}

describe("files_subtree_op_paths_db_replace", () => {
	test("keeps small changes synchronous and deduplicates paths", async () => {
		const f = await fixture();
		await replace(f, ["/a/", "/a/", "/b"]);
		expect(await read_job(f)).toBeNull();
		expect(await read_paths(f)).toEqual(["/a/", "/b"]);
		await replace(f, ["/a/", "/c"]);
		expect(await read_job(f)).toBeNull();
		expect(await read_paths(f)).toEqual(["/a/", "/c"]);
	});

	test("defers small queued paths and keeps a pending marker", async () => {
		const f = await fixture();
		const opId = await f.t.run((ctx) =>
			files_subtree_ops_db_insert(ctx, {
				op: {
					...f.scope,
					userId: f.db.userId,
					kind: "scope",
					status: "queued",
					blockedByOpId: f.opId,
					rootNodeIds: [],
					treePaths: ["/queued/"],
				},
				now: Date.now(),
			}),
		);
		const queued = { ...f, opId };
		expect(await read_paths(queued), "queued index work must stay in the background").toEqual([]);
		expect(await f.t.run((ctx) => files_subtree_op_paths_db_has_pending(ctx, f.scope))).toBe(true);
		await finish(queued);
		expect(await read_paths(queued)).toEqual(["/queued/"]);
	});

	test("builds from chunks without rereading the op and ignores a duplicate step", async () => {
		const f = await fixture();
		const treePaths = Array.from({ length: 97 }, (_, index) => `/source-${String(index).padStart(3, "0")}/`);
		await replace(f, [...treePaths, ...treePaths]);
		const job = (await read_job(f))!;
		const inputs = await f.t.run((ctx) =>
			ctx.db
				.query("files_subtree_op_path_inputs")
				.withIndex("by_job_generation_order", (q) => q.eq("jobId", job._id))
				.collect(),
		);
		expect(inputs.map((input) => input.treePaths.length)).toEqual([32, 32, 32, 1]);
		expect(await f.t.run((ctx) => files_subtree_op_paths_db_has_pending(ctx, f.scope))).toBe(true);

		await f.t.run(async (ctx) => {
			const get = vi.spyOn(ctx.db, "get");
			await files_subtree_op_paths_db_advance(ctx, { jobId: job._id, generation: job.generation, step: job.step });
			expect(get).not.toHaveBeenCalledWith("files_subtree_ops", f.opId);
		});
		expect(await read_paths(f)).toHaveLength(32);
		const afterFirst = await read_job(f);
		await advance(f, job);
		expect(await read_job(f)).toEqual(afterFirst);
		expect(await read_paths(f)).toHaveLength(32);

		await finish(f);
		expect(await read_paths(f)).toEqual(treePaths);
		expect(await f.t.run((ctx) => ctx.db.query("files_subtree_op_path_inputs").collect())).toEqual([]);
		expect(await f.t.run((ctx) => files_subtree_op_paths_db_has_pending(ctx, f.scope))).toBe(false);
	});

	test("ignores an old generation after two replacements", async () => {
		const f = await fixture();
		await replace(
			f,
			Array.from({ length: 70 }, (_, index) => `/old-${index}/`),
		);
		const oldJob = (await read_job(f))!;
		await replace(
			f,
			Array.from({ length: 40 }, (_, index) => `/middle-${index}/`),
		);
		const finalPaths = Array.from({ length: 40 }, (_, index) => `/final-${String(index).padStart(2, "0")}/`);
		await replace(f, finalPaths);
		const current = (await read_job(f))!;
		expect(current.generation).toBe(oldJob.generation + 2);

		await advance(f, oldJob);
		expect(await read_job(f), "an old generation must not advance the new job").toEqual(current);
		expect(await read_paths(f)).toEqual([]);
		await advance(f, current);
		const input = await f.t.run((ctx) =>
			ctx.db
				.query("files_subtree_op_path_inputs")
				.withIndex("by_job_generation_order", (q) => q.eq("jobId", current._id).eq("generation", current.generation))
				.first(),
		);
		expect(input!.nextPath).toBe(27);
		expect(await read_paths(f)).toEqual(finalPaths.slice(0, 27));
		await finish(f);
		expect(await read_paths(f)).toEqual(finalPaths);
		expect(await f.t.run((ctx) => ctx.db.query("files_subtree_op_path_inputs").collect())).toEqual([]);
	});

	test("keeps the marker while a large old set becomes a small new set", async () => {
		const f = await fixture();
		await replace(
			f,
			Array.from({ length: 80 }, (_, index) => `/old-${index}/`),
		);
		await finish(f);
		await replace(f, ["/new-a/", "/new-b/"]);
		const job = (await read_job(f))!;
		await advance(f, job);
		expect(await read_paths(f)).toHaveLength(48);
		expect(await f.t.run((ctx) => files_subtree_op_paths_db_has_pending(ctx, f.scope))).toBe(true);
		await finish(f);
		expect(await read_paths(f)).toEqual(["/new-a/", "/new-b/"]);
	});

	test("does not let an old callback touch a recreated job", async () => {
		const f = await fixture();
		await replace(
			f,
			Array.from({ length: 5 }, (_, index) => `/old-${index}/`),
		);
		const oldJob = (await read_job(f))!;
		await finish(f);
		await replace(
			f,
			Array.from({ length: 5 }, (_, index) => `/new-${index}/`),
		);
		const current = (await read_job(f))!;
		expect(current._id).not.toBe(oldJob._id);
		expect(current.generation).toBe(oldJob.generation);
		expect(current.step).toBe(oldJob.step);
		await advance(f, oldJob);
		expect(await read_job(f)).toEqual(current);
		expect(await read_paths(f)).toEqual(Array.from({ length: 5 }, (_, index) => `/old-${index}/`));
		await finish(f);
		expect(await read_paths(f)).toEqual(Array.from({ length: 5 }, (_, index) => `/new-${index}/`));
	});

	test("stages the largest Copy op in at most 512 small docs", async () => {
		const f = await fixture();
		const sourceTreePaths = Array.from({ length: 8192 }, (_, index) => `/source-${index}/`);
		const treePaths = Array.from({ length: 8192 }, (_, index) => `/new-${index}/`);
		const metrics = await f.t.run(async (ctx) => {
			await ctx.db.replace("files_subtree_ops", f.opId, {
				...f.scope,
				userId: f.db.userId,
				kind: "copy",
				// This test runs only the path index, never the Copy worker.
				transferRunId: "999999files_transfer_runs" as Id<"files_transfer_runs">,
				status: "running",
				blockedByOpId: null,
				rootNodeIds: [],
				treePaths,
				sourceTreePaths,
			});
			await files_subtree_op_paths_db_replace(ctx, {
				...f.scope,
				opId: f.opId,
				oldTreePaths: [],
				treePaths: [...sourceTreePaths, ...treePaths],
				now: Date.now(),
			});
			return await ctx.meta.getTransactionMetrics();
		});
		const inputs = await f.t.run((ctx) => ctx.db.query("files_subtree_op_path_inputs").collect());
		expect(inputs).toHaveLength(512);
		expect(inputs.every((input) => input.treePaths.length === 32)).toBe(true);
		expect(metrics.documentsWritten.used).toBeLessThan(520);
		expect(await read_paths(f)).toEqual([]);
	});

	test.each(["running", "queued"] as const)(
		"shares one mutation budget across 500 %s ops and leaves schedule room",
		async (status) => {
			const f = await fixture();
			const metrics = await f.t.run(async (ctx) => {
				for (let index = 0; index < 500; index++) {
					await files_subtree_ops_db_insert(ctx, {
						op: {
							...f.scope,
							userId: f.db.userId,
							kind: "scope",
							status,
							blockedByOpId: null,
							rootNodeIds: [],
							treePaths: [`/bulk-${String(index).padStart(3, "0")}/`],
						},
						now: Date.now(),
					});
				}
				return await ctx.meta.getTransactionMetrics();
			});
			const { paths, jobs } = await f.t.run(async (ctx) => ({
				paths: await ctx.db.query("files_subtree_op_paths").collect(),
				jobs: await ctx.db.query("files_subtree_op_path_jobs").collect(),
			}));
			if (status === "running") expect(paths.length).toBeGreaterThan(0);
			else expect(paths).toEqual([]);
			expect(jobs.length, "later ops must yield before tree work exhausts the mutation").toBeGreaterThan(0);
			expect(paths.length + jobs.length).toBe(500);
			expect(metrics.functionsScheduled.used).toBeLessThanOrEqual(750);
		},
	);
});

describe("files_subtree_op_paths cleanup", () => {
	test("finishes partial-build cleanup after its op is deleted and recovery runs", async () => {
		const f = await fixture();
		const treePaths = Array.from({ length: 70 }, (_, index) => `/source-${index}/`);
		await replace(f, treePaths);
		await advance(f, (await read_job(f))!);
		expect(await read_paths(f)).toHaveLength(32);
		const build = (await read_job(f))!;
		await f.t.run(async (ctx) => {
			await files_subtree_op_paths_db_replace(ctx, {
				...f.scope,
				opId: f.opId,
				oldTreePaths: treePaths,
				treePaths: [],
				now: Date.now(),
			});
			await ctx.db.delete("files_subtree_ops", f.opId);
		});
		const cleanup = (await read_job(f))!;
		await advance(f, build);
		expect(await read_job(f)).toEqual(cleanup);

		vi.setSystemTime(Date.now() + files_subtree_ops_RECOVER_AFTER_MS + 1);
		await f.t.mutation(internal.files_subtree_ops.path_index_recover, {});
		expect((await read_job(f))!.updatedAt).toBe(Date.now());
		await finish(f);
		expect(await read_paths(f)).toEqual([]);
		expect(await f.t.run((ctx) => ctx.db.query("files_subtree_op_path_inputs").collect())).toEqual([]);
		expect(await read_job(f)).toBeNull();
	});

	test("wakes waiting archives only after the workspace's last job finishes", async () => {
		const f = await fixture();
		const secondId = await f.t.run((ctx) =>
			files_subtree_ops_db_insert(ctx, {
				op: {
					...f.scope,
					userId: f.db.userId,
					kind: "scope",
					status: "running",
					blockedByOpId: null,
					rootNodeIds: [],
					treePaths: [],
				},
				now: Date.now(),
			}),
		);
		const second = { ...f, opId: secondId };
		await replace(
			f,
			Array.from({ length: 5 }, (_, index) => `/first-${index}/`),
		);
		await replace(
			second,
			Array.from({ length: 5 }, (_, index) => `/second-${index}/`),
		);
		const wakes = async () =>
			await f.t.run(async (ctx) =>
				(await ctx.db.system.query("_scheduled_functions").collect()).filter(
					(job) => job.name === "files_subtree_ops:path_index_wake",
				),
			);
		await finish(f);
		expect(await wakes()).toHaveLength(0);
		expect(await f.t.run((ctx) => files_subtree_op_paths_db_has_pending(ctx, f.scope))).toBe(true);
		await finish(second);
		expect(await wakes()).toHaveLength(1);
	});
});
