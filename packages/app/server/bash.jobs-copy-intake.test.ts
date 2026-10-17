// Durable Copy and Move long intake tests: the shell lifetime, folder policy and admission pages. Crash
// tests are in bash.jobs-copy-crash.test.ts, and the other durable Copy and Move job tests in bash.jobs-copy.test.ts.
import { Workpool } from "@convex-dev/workpool";
import { describe, expect, test, vi } from "vitest";
import { internal } from "../convex/_generated/api.js";
import { organizations_membership_lifetimes_db_record } from "../convex/organizations_membership_lifetimes.ts";
import { function_name_of, create_bash_runner, job_row, activity_of, run_job } from "./bash.setup.test.ts";
import { bash_job_copy_admit_limits } from "./bash.ts";

describe("bash_run_command", () => {
	describe("jobs", () => {
		test("durable Move input progress can pass the normal shell lifetime", async () => {
			let workNumber = 0;
			vi.spyOn(Workpool.prototype, "enqueueAction").mockImplementation(
				async () => `long-input-${workNumber++}` as never,
			);
			const runner = await create_bash_runner();
			await runner.run({ command: "mkdir copies" });
			// Each accept moves the clock 8 minutes, under the 10-minute admission window, so each worker
			// accepts about one source. 181 sources pass 24 hours (181 x 8 minutes).
			await runner.run({
				command: `{ mv ${Array.from({ length: 181 }, () => "docs/readme.md").join(" ")} copies/; echo after; } &`,
			});
			const mutate = runner.runMutation.getMockImplementation()!;
			vi.useFakeTimers({ toFake: ["Date"] });
			const startedAt = Date.now();
			runner.runMutation.mockImplementation(async (reference, args) => {
				const result = await mutate(reference, args);
				if (function_name_of(reference) === "ai_chat_files:accept_bash_job_copy_source")
					vi.setSystemTime(Date.now() + 8 * 60_000);
				return result;
			});
			let current = await run_job(runner, 1);
			for (
				let worker = 0;
				worker < 310 && current.status === "running" && current.job.copy?.phase === "admitting";
				worker++
			)
				current = await run_job(runner, 1);
			expect(Date.now() - startedAt).toBeGreaterThan(24 * 60 * 60_000);
			expect(current.job.copy?.phase, "Healthy source intake has no total shell lifetime cap").toBe("waiting");
			expect(current.job.excludedCopyWaitMs).toBeGreaterThan(24 * 60 * 60_000);
			expect(current.job.workerGeneration).toBeGreaterThan(1);
		}, 120_000);

		test("durable Move rejects unsealed input after the same membership is reinvited", async () => {
			let workNumber = 0;
			vi.spyOn(Workpool.prototype, "enqueueAction").mockImplementation(
				async () => `reinvited-input-${workNumber++}` as never,
			);
			const runner = await create_bash_runner();
			await runner.run({ command: "mkdir copies" });
			await runner.run({
				command:
					"{ mv $(echo once >> count.txt; echo docs/readme.md) docs/tutorial.md copies/; echo after > after.txt; } &",
			});
			const queued = await job_row(runner, 1);
			const mutate = runner.runMutation.getMockImplementation()!;
			runner.runMutation.mockImplementation(async (reference, args) => {
				const result = await mutate(reference, args);
				if (function_name_of(reference) === "ai_chat_files:accept_bash_job_copy_source")
					throw new Error("worker crashed");
				return result;
			});
			await expect(run_job(runner, 1)).rejects.toThrow("worker crashed");
			runner.runMutation.mockImplementation(mutate);
			await runner.t.mutation(internal.ai_chat_files.handle_bash_job_complete, {
				workId: queued.job.workId!,
				context: { invocationId: queued._id },
				result: { kind: "failed", error: "worker crashed" },
			});
			const before = await job_row(runner, 1);
			expect(before.job.copy).toMatchObject({ phase: "admitting", sealed: false, sourcesCount: 1 });
			const runId = before.job.copy?.runId;
			if (!runId) throw new Error("Expected linked transfer");
			await runner.t.run(async (ctx) => {
				const membership = await ctx.db.get("organizations_workspaces_users", runner.seeded.membershipId);
				if (!membership) throw new Error("Expected membership");
				await ctx.db.patch("organizations_workspaces_users", membership._id, { active: false });
				await organizations_membership_lifetimes_db_record(ctx, [{ membership, active: false }]);
				await ctx.db.patch("organizations_workspaces_users", membership._id, { active: true });
				await organizations_membership_lifetimes_db_record(ctx, [
					{ membership: { ...membership, active: true }, active: true },
				]);
			});
			const after = await run_job(runner, 1);
			expect(after.status, "Reinviting the same membership cannot revive old expanded input").toBe("interrupted");
			expect((await activity_of(runner, 1))?.status).toBe("canceled");
			expect(
				await runner.t.run((ctx) =>
					ctx.db
						.query("files_transfer_selection_items")
						.withIndex("by_run_order", (q) => q.eq("runId", runId))
						.collect(),
				),
				"The old membership cannot accept another source",
			).toHaveLength(1);
			const later = await runner.t.query(internal.files_nodes.get_visible_entry_by_path, {
				organizationId: runner.seeded.organizationId,
				workspaceId: runner.seeded.workspaceId,
				visibilityUserId: runner.ctxData.userId,
				subject: { kind: "user", userId: runner.ctxData.userId, plugin: null },
				overlayUserId: runner.ctxData.userId,
				path: "/after.txt",
			});
			expect(later).toBeNull();
		});

		test.each([
			{ command: "cp -R docs copies/", policy: "merge", exitCode: 0, child: true },
			{ command: "mv docs copies/", policy: "error", exitCode: 1, child: false },
			{ command: "mv -n docs copies/", policy: "skip", exitCode: 0, child: false },
			{ command: "mv -Tf docs copies/docs", policy: "replace_empty", exitCode: 0, child: true },
			{ command: "mv -Tf docs copies/docs", policy: "replace_empty", exitCode: 1, child: false, occupied: true },
		])(
			"durable background folder policy $command with occupied=$occupied",
			async ({ command, policy, exitCode, child, occupied }) => {
				const runner = await create_bash_runner();
				await runner.run({ command: "mkdir -p copies/docs" });
				if (occupied) await runner.run({ command: "echo keep > copies/docs/keep.txt" });
				await runner.run({ command: `{ ${command}; } &` });
				const waiting = await run_job(runner, 1);
				if (waiting.job.copy?.phase !== "waiting") throw new Error("Expected waiting transfer");
				const run = await runner.t.run((ctx) => ctx.db.get("files_transfer_runs", waiting.job.copy!.runId!));
				expect(run?.conflictPolicy.folder).toBe(policy);
				await runner.runQuery(internal.files_transfer.get_for_agent, {
					membershipId: waiting.membershipId,
					threadId: waiting.threadId,
					runId: waiting.job.copy.runId,
				});
				const finished = await run_job(runner, 1);
				expect(finished.status).toBe("finished");
				expect(finished.result?.metadata.exitCode, finished.result?.stderr).toBe(exitCode);
				const output = await runner.t.query(internal.files_nodes.get_visible_entry_by_path, {
					organizationId: runner.seeded.organizationId,
					workspaceId: runner.seeded.workspaceId,
					visibilityUserId: runner.ctxData.userId,
					subject: { kind: "user", userId: runner.ctxData.userId, plugin: null },
					overlayUserId: runner.ctxData.userId,
					path: "/copies/docs/tutorial.md",
				});
				expect(output !== null, "folder policy controls whether the child is moved or copied").toBe(child);
				if (occupied) expect((await runner.run({ command: "cat copies/docs/keep.txt" })).stdout).toBe("keep\n");
			},
		);

		test("durable Copy admission spreads more than 32 source pages over worker slices", async () => {
			const runner = await create_bash_runner();
			await runner.run({ command: "mkdir copies" });
			const mutate = runner.runMutation.getMockImplementation()!;
			let sourceReadsBeforeCheckpoint = -1;
			runner.runMutation.mockImplementation(async (reference, args) => {
				if (function_name_of(reference) === "ai_chat_files:save_bash_job_copy_checkpoint")
					sourceReadsBeforeCheckpoint = runner.runQuery.mock.calls.filter(
						([ref, query]) =>
							function_name_of(ref) === "files_nodes:get_visible_entry_by_path" && query.path === "/docs/readme.md",
					).length;
				return await mutate(reference, args);
			});
			// The real cap is 32 pages (3,200 sources). Each source costs a path lookup, so lower the cap to
			// 3 pages: 301 sources need 4 pages, and one worker appends 3 pages (300 sources), then requeues
			// the job. A frozen clock keeps the transfer deadline away, so only the page cap stops the worker.
			vi.useFakeTimers({ toFake: ["Date"] });
			bash_job_copy_admit_limits.maxPages = 3;
			try {
				await runner.run({
					command:
						"{ cp $(echo once >> count.txt; printf 'docs/readme.md\\n%.0s' $(seq 301)) copies/; echo after > after.txt; } &",
				});

				const first = await run_job(runner, 1);
				expect(sourceReadsBeforeCheckpoint, "source resolution begins after saved input").toBe(0);
				if (first.job.copy?.phase !== "admitting" || first.job.copy.runId === null)
					throw new Error("Expected a linked Copy admission");
				const scope = { membershipId: first.membershipId, threadId: first.threadId, runId: first.job.copy.runId };
				expect(first.job.workerGeneration).toBe(1);
				expect(first.job.copy.sourcesCount, "the first worker leaves source resolution unfinished").toBe(300);
				expect(first.job.copy.input.cursor).toBeLessThan(first.job.copy.input.sourceByteCount);
				expect(await runner.t.query(internal.files_transfer.get_for_agent, scope)).toMatchObject({
					step: "uploading",
					selection: { expectedCount: 301, count: 300 },
				});

				const second = await run_job(runner, 1);
				expect(second.job.copy).toMatchObject({ phase: "waiting", runId: scope.runId });
				expect(await runner.t.query(internal.files_transfer.get_for_agent, scope)).toMatchObject({
					selection: { expectedCount: 301, count: 301 },
				});
			} finally {
				bash_job_copy_admit_limits.maxPages = 32;
			}
			expect(await runner.t.run((ctx) => ctx.db.query("ai_chat_bash_invocation_transfers").collect())).toHaveLength(1);
			expect((await runner.run({ command: "cat count.txt" })).stdout).toBe("once\n");
			const inputReads = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes("bash-inputs"));
			expect(inputReads.length).toBeGreaterThan(1);
			for (const [, request] of inputReads) {
				if (request?.method === "PUT") continue;
				const range = /^bytes=(\d+)-(\d+)$/.exec(new Headers(request?.headers).get("Range") ?? "");
				expect(range, "recovery reads only bounded input windows").not.toBeNull();
				expect(Number(range![2]) - Number(range![1]) + 1).toBeLessThanOrEqual(64 * 1024);
			}
		}, 120_000);
	});
});
