import { Workpool } from "@convex-dev/workpool";
import { describe, expect, test, vi } from "vitest";
import { internal } from "../convex/_generated/api.js";
import { organizations_membership_lifetimes_db_record } from "../convex/organizations_membership_lifetimes.ts";
import { r2_confirmed_object_delete } from "../convex/r2_client.ts";
import { test_convex, test_mocks_fill_db_with } from "../convex/setup.test.ts";
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
				await runner.run({
					command: `{ ${command} $(echo once >> count.txt; echo docs/readme.md) ${Array.from({ length: 100 }, () => "docs/readme.md").join(" ")} copies/; echo after > after.txt; } &`,
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

		test("durable Move input progress can pass the normal shell lifetime", async () => {
			let workNumber = 0;
			vi.spyOn(Workpool.prototype, "enqueueAction").mockImplementation(
				async () => `long-input-${workNumber++}` as never,
			);
			const runner = await create_bash_runner();
			await runner.run({ command: "mkdir copies" });
			await runner.run({
				command: `{ mv ${Array.from({ length: 301 }, () => "docs/readme.md").join(" ")} copies/; echo after; } &`,
			});
			const mutate = runner.runMutation.getMockImplementation()!;
			vi.useFakeTimers({ toFake: ["Date"] });
			const startedAt = Date.now();
			runner.runMutation.mockImplementation(async (reference, args) => {
				const result = await mutate(reference, args);
				if (function_name_of(reference) === "ai_chat_files:accept_bash_job_copy_source")
					vi.setSystemTime(Date.now() + 5 * 60_000);
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
			// 3,201 sources need 33 pages. One worker appends at most 32 pages (3,200 sources), then requeues
			// the job. Each source costs a path lookup, so keep the count just past 3,200.
			await runner.run({
				command:
					"{ cp $(echo once >> count.txt; printf 'docs/readme.md\\n%.0s' $(seq 3201)) copies/; echo after > after.txt; } &",
			});

			const first = await run_job(runner, 1);
			expect(sourceReadsBeforeCheckpoint, "source resolution begins after saved input").toBe(0);
			if (first.job.copy?.phase !== "admitting" || first.job.copy.runId === null)
				throw new Error("Expected a linked Copy admission");
			const scope = { membershipId: first.membershipId, threadId: first.threadId, runId: first.job.copy.runId };
			expect(first.job.workerGeneration).toBe(1);
			expect(first.job.copy.sourcesCount, "the first worker leaves source resolution unfinished").toBe(3200);
			expect(first.job.copy.input.cursor).toBeLessThan(first.job.copy.input.sourceByteCount);
			expect(await runner.t.query(internal.files_transfer.get_for_agent, scope)).toMatchObject({
				step: "uploading",
				selection: { expectedCount: 3201, count: 3200 },
			});

			const second = await run_job(runner, 1);
			expect(second.job.copy).toMatchObject({ phase: "waiting", runId: scope.runId });
			expect(await runner.t.query(internal.files_transfer.get_for_agent, scope)).toMatchObject({
				selection: { expectedCount: 3201, count: 3201 },
			});
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

		test.each(
			[
				"none",
				"upload",
				"save_bash_job_copy_checkpoint",
				"ready_bash_job_copy_input",
				"accept_bash_job_copy_source",
				"seal_bash_job_copy_checkpoint",
				"seal_for_agent",
				"take_bash_job_copy_result",
			].flatMap((lostReply) => ["cp", "mv"].map((command) => ({ command, lostReply }))),
		)("durable plain $command survives a lost $lostReply reply without replay", async ({ command, lostReply }) => {
			const runner = await create_bash_runner();
			await runner.run({ command: "echo source > source.txt; mkdir copies" });
			const original = runner.runMutation.getMockImplementation()!;
			let lost = false;
			if (lostReply === "upload") {
				const upload = vi.mocked(fetch).getMockImplementation()!;
				vi.mocked(fetch).mockImplementation(async (url, init) => {
					const response = await upload(url, init);
					if (!lost && init?.method === "PUT" && String(url).includes("bash-inputs")) {
						lost = true;
						throw new Error("upload reply lost");
					}
					return response;
				});
			}
			runner.runMutation.mockImplementation(async (reference, args) => {
				const result = await original(reference, args);
				if (!lost && function_name_of(reference)?.endsWith(`:${lostReply}`)) {
					lost = true;
					throw new Error("reply lost");
				}
				return result;
			});
			await runner.run({
				command: `{ echo before; ${command} $(echo expanded >> count.txt; echo source.txt) ${Array.from({ length: 100 }, () => "source.txt").join(" ")} copies/; echo after; } &`,
			});
			const waiting = await run_job(runner, 1);
			expect(waiting.status).toBe("running");
			expect(waiting.job.copy?.phase).toBe("waiting");
			expect(waiting.job.liveOutput?.stdout).toBe("before\n");
			expect((await runner.run({ command: "cat count.txt" })).stdout).toBe("expanded\n");
			if (waiting.job.copy?.phase !== "waiting") throw new Error("Expected waiting Copy");
			await runner.runQuery(internal.files_transfer.get_for_agent, {
				membershipId: waiting.membershipId,
				threadId: waiting.threadId,
				runId: waiting.job.copy.runId,
			});
			const finished = await run_job(runner, 1);
			expect(finished.status).toBe("finished");
			expect(finished.result?.stdout).toMatch(/^before\nTransfer .*\nafter\n$/);
			expect((await runner.run({ command: "cat count.txt" })).stdout).toBe("expanded\n");
			if (lostReply !== "none") expect(lost).toBe(true);
		});

		test("durable Copy clears delivery before a sleep and keeps cumulative wait credit", async () => {
			const runner = await create_bash_runner();
			await runner.run({ command: "echo source > source.txt" });
			await runner.run({ command: "{ cp source.txt first.txt; sleep 5; cp source.txt second.txt; echo after; } &" });
			for (const copyNumber of [1, 2]) {
				const waiting = await run_job(runner, 1);
				if (waiting.job.copy?.phase !== "waiting") throw new Error("Expected waiting Copy");
				await runner.runQuery(internal.files_transfer.get_for_agent, {
					membershipId: waiting.membershipId,
					threadId: waiting.threadId,
					runId: waiting.job.copy.runId,
				});
				const after = await run_job(runner, 1);
				expect(after.job.copy).toBeUndefined();
				if (copyNumber === 1) expect(after.status).toBe("running");
				else expect(after.result?.stdout).toMatch(/after\n$/);
			}
		});

		test.each(["finish", "stop"])(
			"durable Copy deletes old input pages after the next Copy, a pause and the %s",
			async (end) => {
				const runner = await create_bash_runner();
				const page_commands = async () =>
					(await runner.t.run((ctx) => ctx.db.query("ai_chat_bash_job_copy_pages").collect())).map(
						(page) => page.commandNumber,
					);
				// The scheduler does not run by itself in these tests. Run the cleanups the doors scheduled.
				const run_cleanups = async () => {
					const tasks = await runner.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
					for (const task of tasks)
						if (task.name.endsWith("cleanup_bash_job_copy_pages") && task.state.kind === "pending")
							await runner.t.mutation(internal.ai_chat_files.cleanup_bash_job_copy_pages, task.args[0]);
				};
				const finish_copy = async () => {
					const waiting = await job_row(runner, 1);
					if (waiting.job.copy?.phase !== "waiting") throw new Error("Expected waiting Copy");
					await runner.runQuery(internal.files_transfer.get_for_agent, {
						membershipId: waiting.membershipId,
						threadId: waiting.threadId,
						runId: waiting.job.copy.runId,
					});
					return waiting.job.copy.commandNumber;
				};
				await runner.run({
					command:
						"{ cp docs/readme.md first.md; cp docs/readme.md second.md; sleep 5; cp docs/readme.md third.md; echo after; } &",
				});

				await run_job(runner, 1);
				const first = await finish_copy();
				expect(await page_commands()).toEqual([first]);

				// The second Copy replaces the delivered first one.
				await run_job(runner, 1);
				const second = await finish_copy();
				expect(second).toBeGreaterThan(first);
				await run_cleanups();
				expect(await page_commands()).toEqual([second]);

				// The sleep pause clears the delivered second Copy.
				expect((await run_job(runner, 1)).job.copy).toBeUndefined();
				await run_cleanups();
				expect(await page_commands()).toEqual([]);

				await run_job(runner, 1);
				const third = await job_row(runner, 1);
				if (third.job.copy?.phase !== "waiting") throw new Error("Expected waiting Copy");
				expect(await page_commands()).toEqual([third.job.copy.commandNumber]);
				if (end === "finish") {
					await finish_copy();
					expect((await run_job(runner, 1)).result?.stdout).toMatch(/after\n$/);
				} else {
					await runner.run({ command: "kill 1" });
					await runner.t.mutation(internal.ai_chat_files.handle_bash_job_complete, {
						workId: third.job.workId!,
						context: { invocationId: third._id },
						result: { kind: "canceled" },
					});
					expect(await activity_of(runner, 1)).toMatchObject({ status: "canceled" });
				}
				await run_cleanups();
				expect(await page_commands()).toEqual([]);
			},
		);

		test.each([
			["delivers", 60_000],
			["times out", 5 * 60_000],
		])("durable Copy %s when delivery queue time crosses the normal job lifetime", async (outcome, queueMs) => {
			const runner = await create_bash_runner();
			await runner.run({ command: "{ sleep 5; cp docs/readme.md copy.md; echo after; } &" });
			vi.useFakeTimers({ toFake: ["Date"] });
			try {
				const createdAt = (await job_row(runner, 1))._creationTime;
				expect((await run_job(runner, 1)).job.copy).toBeUndefined();

				// Ordinary time before the Copy counts: 3 minutes of allowance are left.
				vi.setSystemTime(createdAt + 24 * 60 * 60_000 - 3 * 60_000);
				const waiting = await run_job(runner, 1);
				if (waiting.job.copy?.phase !== "waiting") throw new Error("Expected waiting Copy");
				const runId = waiting.job.copy.runId;

				// A 25-hour Copy is excluded up to the producer's finish time only.
				vi.setSystemTime(Date.now() + 25 * 60 * 60_000);
				await runner.t.run(async (ctx) => {
					const activity = await ctx.db
						.query("activities")
						.withIndex("by_source_id", (q) => q.eq("source.id", runId))
						.unique();
					await ctx.db.patch("activities", activity!._id, { deadlineAt: Date.now() + 60_000, updatedAt: Date.now() });
				});
				await runner.runQuery(internal.files_transfer.get_for_agent, {
					membershipId: waiting.membershipId,
					threadId: waiting.threadId,
					runId,
				});

				// The delivery queue time after that finish counts like ordinary time.
				vi.setSystemTime(Date.now() + queueMs);
				const after = await run_job(runner, 1);
				if (outcome === "delivers") {
					expect(after.status).toBe("finished");
					expect(after.result?.stdout).toMatch(/after\n$/);
				} else {
					expect(after.status).toBe("interrupted");
					expect(after.result?.stdout ?? "").not.toContain("after");
					expect(await activity_of(runner, 1)).toMatchObject({ status: "timed_out" });
				}
			} finally {
				vi.useRealTimers();
			}
		});

		test.each(["source", "destination", "chat", "purge", "stop"])(
			"durable Copy stops before continuation after %s access changes",
			async (change) => {
				const t = test_convex();
				const seeded = await t.run((ctx) =>
					test_mocks_fill_db_with.membership(ctx, { organizationName: "copy-team", workspaceName: "shared" }),
				);
				const runner = await create_bash_runner({ shared: { t, seeded } });
				const personal = await t.query(internal.ai_chat_workspaces.resolve, {
					source: {
						organizationId: seeded.organizationId,
						workspaceId: seeded.workspaceId,
						userId: seeded.userId,
						threadId: runner.threadId,
						membershipId: seeded.membershipId,
						membershipLifetime: runner.ctxData.membershipLifetime,
					},
					workspace: "personal",
				});
				if (personal._nay) throw new Error(personal._nay.message);
				const home = `/home/cloud-usr/w/${personal._yay.organizationName}/${personal._yay.workspaceName}`;
				await runner.run({ command: `echo team > source.txt; echo private > ${home}/source.txt` });
				await runner.run({
					command:
						change === "source"
							? `{ cp ${home}/source.txt copy.txt; echo after; } &`
							: `{ cp source.txt ${home}/copy.txt; echo after; } &`,
				});
				const waiting = await run_job(runner, 1);
				if (waiting.job.copy?.phase !== "waiting") throw new Error("Expected waiting Copy");
				await runner.runQuery(internal.files_transfer.get_for_agent, {
					membershipId: waiting.membershipId,
					threadId: waiting.threadId,
					runId: waiting.job.copy.runId,
				});
				if (change === "stop") await runner.run({ command: "kill 1" });
				else
					await t.run(async (ctx) => {
						if (change === "purge")
							await ctx.db.patch("organizations_workspaces", personal._yay.workspaceId, {
								pluginDataPurgeStartedAt: Date.now(),
							});
						else
							await ctx.db.patch(
								"organizations_workspaces_users",
								change === "chat" ? seeded.membershipId : personal._yay.membershipId,
								{ active: false },
							);
					});
				await run_job(runner, 1);
				const after = await job_row(runner, 1);
				expect(after.result?.stdout ?? "").not.toContain("after");
				expect(after.job.copy?.phase).not.toBe("delivering");
			},
		);

		test.each([
			"",
			"echo after",
			"set -e; cp source.txt copy.txt && echo logical",
			"(cp source.txt copy.txt)",
			"for x in 1; do cp source.txt copy.txt; done",
			"cp source.txt copy.txt | cat",
		])("durable Copy keeps empty remainder or excludes compound form %s", async (tail) => {
			const runner = await create_bash_runner();
			await runner.run({ command: "echo source > source.txt" });
			const plain = tail === "" || tail === "echo after";
			await runner.run({ command: `{ ${plain ? `cp source.txt copy.txt; ${tail};` : `${tail};`} } &` });
			const first = await run_job(runner, 1);
			if (!plain) {
				expect(first.status).toBe("finished");
				expect(first.job.copy).toBeUndefined();
				return;
			}
			if (first.job.copy?.phase !== "waiting") throw new Error("Expected waiting Copy");
			await runner.runQuery(internal.files_transfer.get_for_agent, {
				membershipId: first.membershipId,
				threadId: first.threadId,
				runId: first.job.copy.runId,
			});
			const after = await run_job(runner, 1);
			expect(after.result?.metadata.exitCode).toBe(0);
			expect(after.result?.stdout.match(/Transfer /g)).toHaveLength(1);
		});

		test("durable Copy result obeys errexit", async () => {
			const runner = await create_bash_runner();
			await runner.run({ command: "echo source > source.txt" });
			await runner.run({ command: "{ set -e; cp source.txt copy.txt; echo after; } &" });
			const waiting = await run_job(runner, 1);
			if (waiting.job.copy?.phase !== "waiting") throw new Error("Expected waiting Copy");
			const runId = waiting.job.copy.runId;
			await runner.t.run(async (ctx) => {
				const activity = await ctx.db
					.query("activities")
					.withIndex("by_source_id", (q) => q.eq("source.id", runId))
					.unique();
				await ctx.db.patch("activities", activity!._id, {
					status: "failed",
					finishedAt: Date.now(),
					errorMessage: "Copy failed",
				});
			});
			const after = await run_job(runner, 1);
			expect(after.result?.metadata.exitCode).toBe(1);
			expect(after.result?.stdout).not.toContain("after");
		});

		test("durable Copy keeps streamed output beyond the live head in the transcript", async () => {
			const runner = await create_bash_runner();
			await runner.run({
				command: "{ seq 1 10000; cp $(echo expansion-warning >&2; echo docs/readme.md) copy.md; echo after; } &",
			});
			const waiting = await run_job(runner, 1);
			if (waiting.job.copy?.phase !== "waiting") throw new Error(`Expected waiting Copy: ${waiting.result?.stderr}`);
			expect(waiting.job.liveOutput?.stdoutTruncated).toBe(true);
			expect(waiting.job.liveOutput?.stderr).toBe("expansion-warning\n");
			const entries = await runner.t.run((ctx) => ctx.db.query("ai_chat_bash_shell_transcripts").collect());
			const pauses = entries.filter((entry) => entry.text.includes("suspended for Copy"));
			expect(pauses).toHaveLength(1);
			expect(pauses[0]!.text).toContain("9999\n10000\n");
			expect(pauses[0]!.text.match(/expansion-warning/g)).toHaveLength(1);
		});

		test("durable Copy excludes two 25-hour waits without resetting the normal lifetime", async () => {
			const runner = await create_bash_runner();
			await runner.run({
				command: "{ cp docs/readme.md first.md; sleep 5; cp docs/readme.md second.md; sleep 5; echo after; } &",
			});
			vi.useFakeTimers({ toFake: ["Date"] });
			try {
				for (const waitNumber of [1, 2]) {
					const waiting = await run_job(runner, 1);
					if (waiting.job.copy?.phase !== "waiting") throw new Error("Expected waiting Copy");
					const runId = waiting.job.copy.runId;
					vi.setSystemTime(Date.now() + 25 * 60 * 60_000);
					await runner.t.run(async (ctx) => {
						const activity = await ctx.db
							.query("activities")
							.withIndex("by_source_id", (q) => q.eq("source.id", runId))
							.unique();
						await ctx.db.patch("activities", activity!._id, { deadlineAt: Date.now() + 60_000, updatedAt: Date.now() });
					});
					const stillWaiting = await run_job(runner, 1);
					expect(stillWaiting.job.copy).toEqual(waiting.job.copy);
					await runner.runQuery(internal.files_transfer.get_for_agent, {
						membershipId: waiting.membershipId,
						threadId: waiting.threadId,
						runId,
					});
					const paused = await run_job(runner, 1);
					expect(paused.status).toBe("running");
					expect(paused.job.copy).toBeUndefined();
					expect(paused.job.excludedCopyWaitMs).toBeGreaterThanOrEqual(waitNumber * 25 * 60 * 60_000);
					vi.setSystemTime(Date.now() + 5_000);
				}
				vi.setSystemTime(Date.now() + 25 * 60 * 60_000);
				const expired = await run_job(runner, 1);
				expect(expired.status).toBe("interrupted");
				expect(await activity_of(runner, 1)).toMatchObject({ status: "timed_out" });
			} finally {
				vi.useRealTimers();
			}
		});

		test.each(["next statements", "errexit"])(
			"durable Copy delivers a final admission refusal once as the failed cp result (%s)",
			async (mode) => {
				let workNumber = 0;
				vi.spyOn(Workpool.prototype, "enqueueAction").mockImplementation(
					async () => `refusal-work-${workNumber++}` as never,
				);
				const runner = await create_bash_runner();
				await runner.run({ command: "echo source > source.txt" });
				await runner.run({
					command: `{ ${mode === "errexit" ? "set -e; " : ""}cp source.txt docs/copy.md; echo "status=$?"; echo after > after.txt; } &`,
				});
				const original = runner.runMutation.getMockImplementation()!;
				let starts = 0;
				runner.runMutation.mockImplementation(async (reference, args) => {
					if (function_name_of(reference) === "ai_chat_files:accept_bash_job_copy_source" && starts++ === 0)
						// Files renames the destination folder after the input was staged.
						await runner.t.run(async (ctx) => {
							const docs = (await ctx.db.query("files_nodes").collect()).find(
								(node) => node.path === "/docs" && node.archiveOperationId === null,
							);
							await ctx.db.patch("files_nodes", docs!._id, { path: "/docs-renamed", name: "docs-renamed" });
						});
					return await original(reference, args);
				});
				// Run workers like the pool does: a worker that throws gets a failed callback.
				for (let attempt = 0; attempt < 5 && (await job_row(runner, 1)).status === "running"; attempt++) {
					const row = await job_row(runner, 1);
					const error = await run_job(runner, 1).then(
						() => null,
						(error: unknown) => String(error),
					);
					if (error !== null && (await job_row(runner, 1)).job.workId === row.job.workId)
						await runner.t.mutation(internal.ai_chat_files.handle_bash_job_complete, {
							workId: row.job.workId!,
							context: { invocationId: row._id },
							result: { kind: "failed", error },
						});
				}

				const finished = await job_row(runner, 1);
				expect(finished.status).toBe("finished");
				expect(finished.result?.stderr.match(/cp: Destination changed\n/g)).toHaveLength(1);
				if (mode === "errexit") {
					expect(finished.result?.metadata.exitCode).toBe(1);
					expect(finished.result?.stdout).not.toContain("status=");
					expect((await runner.run({ command: "cat after.txt" })).metadata.exitCode).not.toBe(0);
				} else {
					expect(finished.result?.metadata.exitCode).toBe(0);
					expect(finished.result?.stdout).toBe("status=1\n");
					expect((await runner.run({ command: "cat after.txt" })).stdout).toBe("after\n");
				}
				// Each worker retries acceptance once for a lost reply. No transfer exists.
				expect(starts).toBe(4);
				expect(await runner.t.run((ctx) => ctx.db.query("files_transfer_runs").collect())).toEqual([]);
			},
		);

		test("durable Copy waits for a busy lane without calling the rate-limited start", async () => {
			const runner = await create_bash_runner();
			await runner.run({ command: "echo source > source.txt" });
			// Job 1's Copy holds the transfer lane while it waits.
			await runner.run({ command: "{ cp source.txt first.txt; } &" });
			const holder = await run_job(runner, 1);
			if (holder.job.copy?.phase !== "waiting") throw new Error("Expected waiting Copy");
			await runner.run({ command: "{ cp source.txt second.txt; echo after; } &" });
			const starts = () => mutation_calls(runner, "ai_chat_files:accept_bash_job_copy_source");
			const startsBefore = starts();

			for (let attempt = 0; attempt < 5; attempt++) await run_job(runner, 2);
			const waiting = await job_row(runner, 2);
			expect(waiting.job.copy).toMatchObject({
				phase: "admitting",
				sealed: false,
				runId: null,
				sourcesCount: 0,
				input: { ready: true },
			});
			expect(starts()).toBe(startsBefore);

			// Once the lane is free, the next worker starts the Copy once.
			await runner.runQuery(internal.files_transfer.get_for_agent, {
				membershipId: holder.membershipId,
				threadId: holder.threadId,
				runId: holder.job.copy.runId,
			});
			const admitted = await run_job(runner, 2);
			expect(admitted.job.copy?.phase).toBe("waiting");
			expect(starts()).toBe(startsBefore + 1);
		});

		test("durable Copy ends as canceled when access is lost just before its requeue", async () => {
			const runner = await create_bash_runner();
			await runner.run({ command: "{ cp docs/readme.md copy.md; echo after > after.txt; } &" });
			const waiting = await run_job(runner, 1);
			if (waiting.job.copy?.phase !== "waiting") throw new Error("Expected waiting Copy");
			const runId = waiting.job.copy.runId;
			const original = runner.runMutation.getMockImplementation()!;
			runner.runMutation.mockImplementation(async (reference, args) => {
				// The member is removed after the worker found the Copy still running.
				if (function_name_of(reference) === "ai_chat_files:requeue_bash_job_copy")
					await runner.t.run((ctx) =>
						ctx.db.patch("organizations_workspaces_users", runner.seeded.membershipId, { active: false }),
					);
				return await original(reference, args);
			});

			const after = await run_job(runner, 1);
			expect(after.status).toBe("interrupted");
			expect(after.job.copy).toBeUndefined();
			expect(await activity_of(runner, 1)).toMatchObject({ status: "canceled" });
			const transfer = await runner.t.run((ctx) =>
				ctx.db
					.query("activities")
					.withIndex("by_source_id", (q) => q.eq("source.id", runId))
					.unique(),
			);
			expect(transfer?.status).not.toBe("running");
		});

		test("durable Copy saves its checkpoint when the host clock runs ahead of the server", async () => {
			const runner = await create_bash_runner();
			await runner.run({ command: "{ cp docs/readme.md copy.md; echo after > after.txt; } &" });
			const original = runner.runMutation.getMockImplementation()!;
			vi.useFakeTimers({ toFake: ["Date"] });
			let serverNow = 0;
			let savedDeadlineAt: number | undefined;
			try {
				runner.runMutation.mockImplementation(async (reference, args) => {
					if (function_name_of(reference) !== "ai_chat_files:save_bash_job_copy_checkpoint")
						return await original(reference, args);
					// Run the save on a server clock 2 minutes behind the host clock.
					vi.setSystemTime(Date.now() - 2 * 60_000);
					serverNow = Date.now();
					const saved = await original(reference, args);
					const row = await job_row(runner, 1);
					if (row.job.copy?.phase === "admitting") savedDeadlineAt = row.job.copy.admissionDeadlineAt;
					vi.setSystemTime(Date.now() + 2 * 60_000);
					return saved;
				});

				await expect(run_job(runner, 1)).resolves.toMatchObject({ job: { copy: { phase: "waiting" } } });
				// The server sets the admission deadline from its own clock.
				expect(savedDeadlineAt).toBe(serverNow + 10 * 60_000);
			} finally {
				vi.useRealTimers();
			}
		});

		test("durable Copy lost delivery worker cannot replay the remaining shell", async () => {
			const runner = await create_bash_runner();
			await runner.run({ command: "{ cp docs/readme.md copy.md; echo after > after.txt; } &" });
			const waiting = await run_job(runner, 1);
			if (waiting.job.copy?.phase !== "waiting") throw new Error("Expected waiting Copy");
			await runner.runQuery(internal.files_transfer.get_for_agent, {
				membershipId: waiting.membershipId,
				threadId: waiting.threadId,
				runId: waiting.job.copy.runId,
			});
			const original = runner.runMutation.getMockImplementation()!;
			runner.runMutation.mockImplementation(async (reference, args) => {
				const result = await original(reference, args);
				if (function_name_of(reference) === "ai_chat_files:take_bash_job_copy_result")
					throw new Error("worker lost after delivery");
				return result;
			});
			await expect(run_job(runner, 1)).rejects.toThrow("worker lost after delivery");
			runner.runMutation.mockImplementation(original);
			await runner.t.mutation(internal.ai_chat_files.handle_bash_job_complete, {
				workId: waiting.job.workId!,
				context: { invocationId: waiting._id },
				result: { kind: "failed", error: "worker lost" },
			});
			await run_job(runner, 1);
			expect((await runner.run({ command: "cat after.txt" })).metadata.exitCode).not.toBe(0);
			expect(await activity_of(runner, 1)).toMatchObject({ status: "failed" });
		});
	});
});
