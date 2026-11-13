// The tests of a job that loses scheduled steps, in their own file so they run at the same time as the
// other files_archive_runs test files.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { activities_is_active } from "./activities_db.ts";
import {
	fixture,
	seed_tree,
	expect_consistent,
	read_activity,
	step,
	archive,
	archive_with_check,
	archive_to_end,
	restore,
	purge,
	purge_job,
	type Fixture,
} from "./files_archive_runs.setup.test.ts";

// A check step reads at most 100 nodes here instead of 500, so the check of a small tree takes more than
// one step. The mock puts this file in the isolated "Convex" project.
vi.mock("../server/files-archive-runs.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../server/files-archive-runs.ts")>()),
	files_archive_runs_CHECK_STEP_MAX_NODES: 100,
}));

// Under fake timers a scheduled step runs only when the test moves the clock.
beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

async function read_scheduled(f: Fixture) {
	return await f.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
}

async function read_walk(f: Fixture) {
	return await f.t.run((ctx) => ctx.db.query("files_subtree_op_walks").unique());
}

/**
 * Run the scheduled functions that are due now, and not the ones they schedule.
 */
async function run_due(f: Fixture) {
	vi.advanceTimersByTime(0);
	await f.t.finishInProgressScheduledFunctions();
}

/**
 * Run every scheduled function to its end. The clock moves, so the retries a step schedules run too.
 */
async function finish_scheduled(f: Fixture) {
	await f.t.finishAllScheduledFunctions(vi.runAllTimers, 1000);
}

/**
 * Cancel scheduled copies of the job's current step. "due" cancels the copy that is due now. "all" also
 * cancels its retry.
 *
 * A step that throws writes nothing. So the database is the same as when the step never ran.
 *
 * Leave the retries of older steps alone. They still run later and must do nothing.
 *
 * Returns how many copies it canceled.
 */
async function lose_steps(f: Fixture, lost: "due" | "all") {
	return await f.t.run(async (ctx) => {
		const walk = await ctx.db.query("files_subtree_op_walks").unique();
		const now = Date.now();
		let count = 0;
		for (const scheduled of await ctx.db.system.query("_scheduled_functions").collect()) {
			if (scheduled.name !== "files_subtree_ops:advance" || scheduled.state.kind !== "pending") continue;
			const args = scheduled.args[0] as { opId: Id<"files_subtree_ops">; step: number };
			if (args.opId !== walk!.opId || args.step !== walk!.step) continue;
			if (lost === "all" || scheduled.scheduledTime <= now) {
				await ctx.scheduler.cancel(scheduled._id);
				count += 1;
			}
		}
		return count;
	});
}

/**
 * What the job left behind, without ids and times, so two runs in two databases can be compared.
 */
async function read_end(f: Fixture, activityId: Id<"activities">) {
	const state = await expect_consistent(f);
	const activity = await read_activity(f, activityId);
	const counts = await f.t.run(async (ctx) => ({
		trashEntries: (await ctx.db.query("files_trash_entries").collect()).length,
		ops: (await ctx.db.query("files_subtree_ops").collect()).length,
		queueRows: (await ctx.db.query("files_subtree_op_nodes").collect()).length,
	}));
	const failed = (await read_scheduled(f)).filter((scheduled) => scheduled.state.kind === "failed");

	return {
		status: activity.status,
		errorCode: activity.errorCode,
		progress: activity.progress,
		nodes: state.nodes
			.map((node) => `${node.path} ${node.archiveOperationId === null ? "active" : "in Trash"}`)
			.toSorted(),
		operations: new Set(state.nodes.map((node) => node.archiveOperationId)).size,
		chunks: state.chunks.length,
		metadataDocs: state.metadataDocs.length,
		savedScopeJobs: state.savedScopeJobs.length,
		failedFunctions: failed.map((scheduled) => scheduled.name),
		...counts,
	};
}

/**
 * Seed a folder and start the job on it. The folder is big enough for several steps of each phase.
 */
async function start(kind: "archive" | "archive with a check" | "restore" | "purge") {
	const f = await fixture();

	// The request checks the first 100 items itself. So only a tree of more than 300 items leaves two
	// check steps to the job.
	if (kind === "archive with a check") {
		const tree = await seed_tree(f, { name: "lost", folderCount: 3, filesPerFolder: 100 });
		return { f, job: (await archive_with_check(f, [tree.topId]))._yay! };
	}

	// 123 items take more than one apply step of 30.
	const tree = await seed_tree(f, { name: "lost", folderCount: 2, filesPerFolder: 60 });
	if (kind === "archive") {
		return { f, job: (await archive(f, [tree.topId]))._yay! };
	}

	await archive_to_end(f, tree.topId);
	if (kind === "restore") {
		return { f, job: (await restore(f, [tree.topId]))._yay! };
	}
	return { f, job: await purge_job(f, (await purge(f, [tree.topId])).runId) };
}

describe("a job that loses steps", () => {
	test.each(["archive", "archive with a check", "restore", "purge"] as const)(
		"%s ends like a job that lost none, wherever the step is lost",
		async (kind) => {
			const clean = await start(kind);
			const phases = [];
			while (activities_is_active((await read_activity(clean.f, clean.job.activityId)).status)) {
				phases.push((await clean.f.t.run((ctx) => ctx.db.get("files_archive_runs", clean.job.runId)))?.phase);
				await run_due(clean.f);
				if (phases.length > 100) throw new Error("The job did not finish");
			}
			await finish_scheduled(clean.f);
			const expected = await read_end(clean.f, clean.job.activityId);
			expect(expected).toMatchObject({ status: "succeeded", ops: 0, queueRows: 0, savedScopeJobs: 0 });
			expect(phases.length, "the job takes several steps").toBeGreaterThan(2);
			if (kind === "archive with a check") {
				expect(phases.filter((phase) => phase === "check").length, "the check takes several steps").toBeGreaterThan(1);
			}

			for (let lostAt = 0; lostAt < phases.length; lostAt++) {
				for (const lost of ["due", "all"] as const) {
					const label = `step ${lostAt}, ${lost} lost`;
					const { f, job } = await start(kind);
					for (let count = 0; count < lostAt; count++) await run_due(f);
					const walk = await read_walk(f);
					expect(await lose_steps(f, lost), `${label}: the copies canceled`).toBe(lost === "due" ? 1 : 2);

					// Nothing runs the lost step at once.
					await run_due(f);
					expect(await read_walk(f), `${label}: the walk did not move`).toEqual(walk);

					await finish_scheduled(f);
					// With "all" no retry is left, so the job waits for the deadline check of its Activity.
					if (lost === "all") {
						const activity = await read_activity(f, job.activityId);
						expect(activity.status, `${label}: the job still waits`).toBe("running");
						vi.setSystemTime(activity.deadlineAt + 1);
						await f.t.mutation(internal.activities.recover_expired, {});
						await finish_scheduled(f);
					}

					expect(await read_end(f, job.activityId), `${label}: the end`).toEqual(expected);
				}
			}
		},
		300_000,
	);

	test("a late copy of an old step does nothing", async () => {
		const { f, job } = await start("archive");
		await step(f, job.runId);
		const read_all = async () => ({
			walk: await read_walk(f),
			state: await expect_consistent(f),
			activity: await read_activity(f, job.activityId),
			scheduledCount: (await read_scheduled(f)).length,
		});
		const before = await read_all();

		// The retry of a step still runs a minute later, when the job is already past that step.
		await f.t.mutation(internal.files_subtree_ops.advance, { opId: before.walk!.opId, step: before.walk!.step - 1 });

		expect(await read_all()).toEqual(before);
	});
});
