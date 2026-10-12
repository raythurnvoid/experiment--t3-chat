// Durable Copy and Move intake tests: worker crashes and lost expanded input. Long intake tests are in
// bash.jobs-copy-intake.test.ts, and the other durable Copy and Move job tests in bash.jobs-copy.test.ts.
import { Workpool } from "@convex-dev/workpool";
import { describe, expect, test, vi } from "vitest";
import { internal } from "../convex/_generated/api.js";
import { r2_confirmed_object_delete } from "../convex/r2_client.ts";
import {
	function_name_of,
	test_r2_objects,
	create_bash_runner,
	job_row,
	activity_of,
	run_job,
	mutation_calls,
} from "./bash.setup.test.ts";

describe("bash_run_command", () => {
	describe("jobs", () => {
		test("durable Copy warns when suspension drops job tmp writes", async () => {
			const runner = await create_bash_runner();
			await runner.run({
				command: "{ echo scratch > /tmp/copy-scratch.txt; cp docs/readme.md copy.md; echo after; } &",
			});
			const waiting = await run_job(runner, 1);
			expect(waiting.job.copy?.phase).toBe("waiting");
			expect(waiting.job.liveOutput?.stderr ?? "").toContain(
				"/tmp writes are dropped when a job pauses for Copy: /tmp/copy-scratch.txt",
			);
			const transcript = await runner.t.run((ctx) => ctx.db.query("ai_chat_bash_shell_transcripts").collect());
			expect(transcript.filter((entry) => entry.text.includes("suspended for Copy"))[0]?.text).toContain(
				"/tmp/copy-scratch.txt",
			);
			expect((await runner.run({ command: "cat /tmp/copy-scratch.txt" })).metadata.exitCode).not.toBe(0);
		});

		test("durable Copy result consumes the resumed worker output budget", async () => {
			const runner = await create_bash_runner();
			// 249,950 spaces plus the redirected "after" line fit the 250,000-byte budget. The Copy
			// result line (about 140 bytes) does not, so only a charged Copy result makes this fail.
			await runner.run({ command: "{ cp docs/readme.md copy.md; printf '%249950s' x; echo after > after.txt; } &" });
			const waiting = await run_job(runner, 1);
			if (waiting.job.copy?.phase !== "waiting") throw new Error("Expected waiting Copy");
			await runner.runQuery(internal.files_transfer.get_for_agent, {
				membershipId: waiting.membershipId,
				threadId: waiting.threadId,
				runId: waiting.job.copy.runId,
			});
			const finished = await run_job(runner, 1);
			expect(finished.result?.metadata.exitCode).not.toBe(0);
			expect(finished.result?.stderr).toMatch(/output.*limit/i);
			expect((await runner.run({ command: "cat after.txt" })).metadata.exitCode).not.toBe(0);

			// Control: the same output without the Copy result fits the budget.
			await runner.run({ command: "{ true; printf '%249950s' x; echo after > control.txt; } &" });
			const control = await run_job(runner, 2);
			expect(control.result?.metadata.exitCode, control.result?.stderr).toBe(0);
			expect((await runner.run({ command: "cat control.txt" })).stdout).toBe("after\n");
		});

		test.each(
			[
				"capture_bash_job_copy_scopes",
				"ready_bash_job_copy_input",
				"accept_bash_job_copy_source",
				"seal_bash_job_copy_checkpoint",
				"seal_for_agent",
				"requeue_bash_job_copy",
			]
				.flatMap((crashAt) =>
					["cp", "mv"].map((command) => ({ command, crashAt, crashOffset: undefined as number | undefined })),
				)
				.concat(["cp", "mv"].map((command) => ({ command, crashAt: "accept_bash_job_copy_source", crashOffset: 100 }))),
		)(
			"durable $command worker crash after $crashAt at offset $crashOffset never repeats expansion",
			async ({ command, crashAt, crashOffset }) => {
				let workNumber = 0;
				vi.spyOn(Workpool.prototype, "enqueueAction").mockImplementation(
					async () => `copy-crash-work-${workNumber++}` as never,
				);
				const runner = await create_bash_runner();
				await runner.run({ command: "mkdir copies" });
				// Each source costs an accept call. Only the crash at offset 100 needs the second page of
				// 100 sources; the other crash points need just a few sources.
				await runner.run({
					command: `{ ${command} $(echo once >> count.txt; echo docs/readme.md) ${Array.from({ length: crashOffset ?? 2 }, () => "docs/readme.md").join(" ")} copies/; echo after > after.txt; } &`,
				});
				const queued = await job_row(runner, 1);
				const mutate = runner.runMutation.getMockImplementation()!;
				const query = runner.runQuery.getMockImplementation()!;
				let crashed = false;
				runner.runMutation.mockImplementation(async (reference, args) => {
					const result = await mutate(reference, args);
					if (
						function_name_of(reference)?.endsWith(`:${crashAt}`) &&
						(crashOffset === undefined || args.offset === crashOffset)
					) {
						crashed = true;
						throw new Error("worker crashed");
					}
					return result;
				});
				runner.runQuery.mockImplementation(async (reference, args) => {
					if (crashed && function_name_of(reference) === "ai_chat_files:read_bash_job_copy_invocation")
						throw new Error("worker crashed");
					return await query(reference, args);
				});
				await expect(run_job(runner, 1)).rejects.toThrow("worker crashed");
				runner.runMutation.mockImplementation(mutate);
				runner.runQuery.mockImplementation(query);
				const beforeCallback = await job_row(runner, 1);
				await runner.t.mutation(internal.ai_chat_files.handle_bash_job_complete, {
					workId: queued.job.workId!,
					context: { invocationId: queued._id },
					result: { kind: "failed", error: "worker crashed" },
				});
				// A worker lost after its requeue committed is already stale. Its callback must not requeue
				// or settle the newer worker's continuation.
				if (crashAt === "requeue_bash_job_copy") expect(await job_row(runner, 1)).toEqual(beforeCallback);
				const incomplete = crashAt === "capture_bash_job_copy_scopes";
				if (incomplete) {
					expect((await job_row(runner, 1)).status).toBe("interrupted");
					expect(await runner.t.run((ctx) => ctx.db.query("ai_chat_bash_invocation_transfers").collect())).toHaveLength(
						0,
					);
					await run_job(runner, 1);
					expect((await runner.run({ command: "cat after.txt" })).metadata.exitCode).not.toBe(0);
				} else {
					expect(
						(await job_row(runner, 1)).status,
						"a lost worker resumes unsealed Move input without repeating expansion",
					).toBe("running");
					await run_job(runner, 1);
					const waiting = await job_row(runner, 1);
					if (waiting.job.copy?.phase !== "waiting") throw new Error("Expected waiting Copy");
					await runner.runQuery(internal.files_transfer.get_for_agent, {
						membershipId: waiting.membershipId,
						threadId: waiting.threadId,
						runId: waiting.job.copy.runId,
					});
					await run_job(runner, 1);
					expect((await runner.run({ command: "cat after.txt" })).stdout).toBe("after\n");
					expect(await runner.t.run((ctx) => ctx.db.query("ai_chat_bash_invocation_transfers").collect())).toHaveLength(
						1,
					);
				}
				expect((await runner.run({ command: "cat count.txt" })).stdout).toBe("once\n");
			},
		);

		test.each(["missing", "changed"])("durable Move ends the whole job for $0 expanded input", async (problem) => {
			let workNumber = 0;
			vi.spyOn(Workpool.prototype, "enqueueAction").mockImplementation(
				async () => `fatal-input-${workNumber++}` as never,
			);
			const runner = await create_bash_runner();
			await runner.run({ command: "mkdir copies" });
			await runner.run({
				command: "{ mv $(echo once >> count.txt; echo docs/readme.md) copies/; echo after > after.txt; } &",
			});
			const queued = await job_row(runner, 1);
			const mutate = runner.runMutation.getMockImplementation()!;
			// Keep cleanup and the agent wake queued until this test runs them.
			vi.useFakeTimers();
			let delayed = false;
			runner.runMutation.mockImplementation(async (reference, args) => {
				if (function_name_of(reference) === "ai_chat_files:save_bash_job_copy_checkpoint") {
					// The upload lease was already made. The save reaches Convex one second later.
					if (!delayed) {
						vi.setSystemTime(Date.now() + 1_000);
						delayed = true;
					}
					await mutate(reference, args);
					throw new Error("worker crashed before upload");
				}
				return await mutate(reference, args);
			});
			await expect(run_job(runner, 1)).rejects.toThrow("worker crashed before upload");
			runner.runMutation.mockImplementation(mutate);
			await runner.t.mutation(internal.ai_chat_files.handle_bash_job_complete, {
				workId: queued.job.workId!,
				context: { invocationId: queued._id },
				result: { kind: "failed", error: "worker crashed" },
			});
			const saved = await job_row(runner, 1);
			if (saved.job.copy?.phase !== "admitting")
				throw new Error("Expected saved input reservation");
			const input = saved.job.copy.input;
			vi.setSystemTime(input.putMayArriveUntil + 1);
			expect(Date.now(), "The upload lease ends before the intake idle deadline").toBeLessThan(
				saved.job.copy.admissionDeadlineAt,
			);
			if (problem === "changed") test_r2_objects.set(input.r2Key, new Uint8Array([0]));
			const ended = await run_job(runner, 1);
			const later = await runner.t.query(internal.files_nodes.get_visible_entry_by_path, {
				organizationId: runner.seeded.organizationId,
				workspaceId: runner.seeded.workspaceId,
				visibilityUserId: runner.ctxData.userId,
				overlayUserId: runner.ctxData.userId,
				path: "/after.txt",
			});
			expect(later, "Lost expanded input never runs later shell writes").toBeNull();
			expect(ended.status).toBe("interrupted");
			expect(await activity_of(runner, 1)).toMatchObject({
				status: "failed",
				errorMessage: expect.stringMatching(/input/i),
			});
			expect(mutation_calls(runner, "ai_chat_files:accept_bash_job_copy_source")).toBe(0);
			expect((await runner.run({ command: "cat count.txt" })).stdout).toBe("once\n");
			expect(await runner.t.run((ctx) => ctx.db.query("files_transfer_runs").collect())).toEqual([]);
			const deletion = await runner.t.run((ctx) =>
				ctx.db
					.query("files_r2_object_deletion_jobs")
					.withIndex("by_r2_key", (q) => q.eq("r2Key", input.r2Key))
					.unique(),
			);
			expect(deletion).toMatchObject({
				organizationId: saved.organizationId,
				workspaceId: saved.workspaceId,
				r2Key: input.r2Key,
				reason: "bash_input",
				putMayArriveUntil: input.putMayArriveUntil,
			});
			await runner.t.action(internal.r2_client.process_object_deletion_job, {
				jobId: deletion!._id,
				generation: deletion!.generation,
			});
			expect(test_r2_objects.has(input.r2Key)).toBe(false);
			expect(
				vi.mocked(r2_confirmed_object_delete.delete_object).mock.calls.some(([, key]) => key === input.r2Key),
			).toBe(true);
			expect(await runner.t.run((ctx) => ctx.db.get("files_r2_object_deletion_jobs", deletion!._id))).toBeNull();
		});

		test("durable Move never replays missing expanded input and Stop cleans a late upload", async () => {
			let workNumber = 0;
			vi.spyOn(Workpool.prototype, "enqueueAction").mockImplementation(
				async () => `missing-input-${workNumber++}` as never,
			);
			const runner = await create_bash_runner();
			await runner.run({ command: "mkdir copies" });
			await runner.run({
				command: "{ mv $(echo once >> count.txt; echo docs/readme.md) copies/; echo after > after.txt; } &",
			});
			const queued = await job_row(runner, 1);
			const mutate = runner.runMutation.getMockImplementation()!;
			runner.runMutation.mockImplementation(async (reference, args) => {
				const result = await mutate(reference, args);
				if (function_name_of(reference) === "ai_chat_files:save_bash_job_copy_checkpoint")
					throw new Error("worker crashed before upload");
				return result;
			});
			await expect(run_job(runner, 1)).rejects.toThrow("worker crashed before upload");
			runner.runMutation.mockImplementation(mutate);
			await runner.t.mutation(internal.ai_chat_files.handle_bash_job_complete, {
				workId: queued.job.workId!,
				context: { invocationId: queued._id },
				result: { kind: "failed", error: "worker crashed" },
			});
			const waiting = await run_job(runner, 1);
			if (waiting.job.copy?.phase !== "admitting")
				throw new Error("Expected reserved input");
			const input = waiting.job.copy.input;
			expect(input.ready).toBe(false);
			expect(waiting.job.copy.sourcesCount).toBe(0);
			expect(test_r2_objects.has(input.r2Key)).toBe(false);
			expect((await runner.run({ command: "cat count.txt" })).stdout).toBe("once\n");
			expect((await runner.run({ command: "cat after.txt" })).metadata.exitCode).not.toBe(0);
			await runner.run({ command: "kill 1" });
			const deletion = await runner.t.run((ctx) =>
				ctx.db
					.query("files_r2_object_deletion_jobs")
					.withIndex("by_r2_key", (q) => q.eq("r2Key", input.r2Key))
					.unique(),
			);
			expect(deletion).toMatchObject({ reason: "bash_input", putMayArriveUntil: input.putMayArriveUntil });
			await runner.t.action(internal.r2_client.process_object_deletion_job, {
				jobId: deletion!._id,
				generation: deletion!.generation,
			});
			// The signed PUT can arrive after Stop and the first confirmed delete.
			test_r2_objects.set(input.r2Key, new TextEncoder().encode("late input"));
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(input.putMayArriveUntil + 1);
			await runner.t.action(internal.r2_client.process_object_deletion_job, {
				jobId: deletion!._id,
				generation: deletion!.generation,
			});
			expect(test_r2_objects.has(input.r2Key), "Stop cleanup removes late expanded input").toBe(false);
			expect(await runner.t.run((ctx) => ctx.db.get("files_r2_object_deletion_jobs", deletion!._id))).toBeNull();
		});

		test("durable Move holds an accepted private source until Stop releases it", async () => {
			const runner = await create_bash_runner();
			await runner.run({ command: "echo source > source.txt; mkdir copies" });
			await runner.run({ command: "{ mv source.txt docs/readme.md copies/; } &" });
			const queued = await job_row(runner, 1);
			const mutate = runner.runMutation.getMockImplementation()!;
			runner.runMutation.mockImplementation(async (reference, args) => {
				const result = await mutate(reference, args);
				if (function_name_of(reference) === "ai_chat_files:accept_bash_job_copy_source")
					throw new Error("worker crashed after accepting a private source");
				return result;
			});
			await expect(run_job(runner, 1)).rejects.toThrow("worker crashed after accepting a private source");
			runner.runMutation.mockImplementation(mutate);
			const saved = await job_row(runner, 1);
			if (saved.job.copy?.phase !== "admitting" || !saved.job.copy.runId) throw new Error("Expected unsealed transfer");
			const runId = saved.job.copy.runId;
			const source = await runner.t.query(internal.files_nodes.get_visible_entry_by_path, {
				organizationId: runner.seeded.organizationId,
				workspaceId: runner.seeded.workspaceId,
				visibilityUserId: runner.ctxData.userId,
				overlayUserId: runner.ctxData.userId,
				path: "/source.txt",
			});
			if (source?.kind !== "private") throw new Error("Expected private source");
			const expiryArgs = {
				organizationId: runner.seeded.organizationId,
				workspaceId: runner.seeded.workspaceId,
				userId: runner.ctxData.userId,
			};
			const make_expiry_due = () =>
				runner.t.run(async (ctx) => {
					await ctx.db.patch("files_pending_updates", source.pendingUpdate._id, { expiresAt: Date.now() - 1 });
					const check = await ctx.db
						.query("files_pending_update_expiry_checks")
						.withIndex("by_organization_workspace_user", (q) =>
							q
								.eq("organizationId", expiryArgs.organizationId)
								.eq("workspaceId", expiryArgs.workspaceId)
								.eq("userId", expiryArgs.userId),
						)
						.unique();
					await ctx.db.patch("files_pending_update_expiry_checks", check!._id, { nextCheckAt: Date.now() - 1 });
					const active = await ctx.db
						.query("users_last_active")
						.withIndex("by_user", (q) => q.eq("userId", expiryArgs.userId))
						.unique();
					if (active) await ctx.db.patch("users_last_active", active._id, { lastActiveAt: 0 });
				});
			await make_expiry_due();
			await runner.t.mutation(internal.files_pending_updates.expire_file_pending_updates, expiryArgs);
			expect(
				(await runner.t.run((ctx) => ctx.db.get("files_pending_nodes", source.node._id)))?.state,
				"An unsealed recovered Move holds each accepted private source",
			).toBe("active");
			await runner.run({ command: "kill 1" });
			await runner.t.mutation(internal.ai_chat_files.handle_bash_job_complete, {
				workId: queued.job.workId!,
				context: { invocationId: queued._id },
				result: { kind: "failed", error: "worker crashed" },
			});
			await runner.runQuery(internal.files_transfer.get_for_agent, {
				membershipId: saved.membershipId,
				threadId: saved.threadId,
				runId,
			});
			await runner.t.mutation(internal.files_pending_holds.release_producer, {
				producer: { kind: "files_transfer_run", id: runId },
			});
			await make_expiry_due();
			await runner.t.mutation(internal.files_pending_updates.expire_file_pending_updates, expiryArgs);
			expect(
				(await runner.t.run((ctx) => ctx.db.get("files_pending_nodes", source.node._id)))?.state,
				"Stop releases an unsealed Move source for expiry",
			).not.toBe("active");
		});
	});
});
