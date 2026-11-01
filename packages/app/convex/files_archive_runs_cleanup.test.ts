import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api.js";
import { archive_to_end, fixture, read_node, seed_tree } from "./files_archive_runs.setup.test.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("delete_finished", () => {
	test("deletes all finished kinds and their receipts, and refuses active work", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "cleanup", folderCount: 1, filesPerFolder: 1 });
		await archive_to_end(f, tree.topId);
		const baseline = await f.t.run(async (ctx) => {
			const run = (await ctx.db.query("files_archive_runs").first())!;
			const activity = (await ctx.db
				.query("activities")
				.withIndex("by_source_id", (q) => q.eq("source.id", run._id))
				.first())!;
			return { run, activity };
		});
		const { _id: _runId, _creationTime: _runTime, ...runFields } = baseline.run;
		const { _id: _activityId, _creationTime: _activityTime, ...activityFields } = baseline.activity;
		await f.t.run(async (ctx) => {
			for (const kind of ["restore", "purge"] as const) {
				const runId = await ctx.db.insert("files_archive_runs", { ...runFields, kind });
				await ctx.db.insert("activities", {
					...activityFields,
					source: { kind: "files_archive_run", id: runId, archiveKind: kind, force: false },
				});
			}
			for (let order = 0; order < 51; order++) {
				await ctx.db.insert("files_archive_run_items", {
					runId: baseline.run._id,
					order,
					kind: "restore",
					path: "/cleanup",
					newPath: null,
				});
			}
			await ctx.db.insert("activities_user_states", {
				userId: f.db.userId,
				activityId: baseline.activity._id,
				dismissedAt: Date.now(),
			});
		});
		const before = await read_node(f, tree.topId);
		expect(await f.t.mutation(internal.files_archive_runs_cleanup.delete_finished, {})).toEqual({
			deletedCount: 50,
			done: false,
		});
		expect(await f.t.run((ctx) => ctx.db.get("files_archive_runs", baseline.run._id))).not.toBeNull();
		let done = false;
		for (let call = 0; call < 10 && !done; call++) {
			done = (await f.t.mutation(internal.files_archive_runs_cleanup.delete_finished, {})).done;
		}
		expect(done).toBe(true);
		expect(
			await f.t.run(async (ctx) => ({
				runs: await ctx.db.query("files_archive_runs").collect(),
				items: await ctx.db.query("files_archive_run_items").collect(),
				activities: await ctx.db.query("activities").collect(),
				states: await ctx.db.query("activities_user_states").collect(),
			})),
		).toEqual({ runs: [], items: [], activities: [], states: [] });
		expect(await read_node(f, tree.topId)).toEqual(before);

		const activeRunId = await f.t.run(async (ctx) => {
			const runId = await ctx.db.insert("files_archive_runs", { ...runFields, active: true });
			await ctx.db.insert("activities", {
				...activityFields,
				status: "running",
				source: { kind: "files_archive_run", id: runId, archiveKind: "archive", force: false },
			});
			return runId;
		});
		await expect(
			f.t.mutation(internal.files_archive_runs_cleanup.delete_finished, {}),
			"active work is refused",
		).rejects.toThrow("An archive run is active.");
		expect(await f.t.run((ctx) => ctx.db.get("files_archive_runs", activeRunId))).toMatchObject({ active: true });
	});
});
