import { Workpool } from "@convex-dev/workpool";
import { describe, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api.js";
import { ai_chat_files_db_delete_job_batch } from "../convex/ai_chat_files.ts";
import { access_control_db_ensure_role_assignment } from "../convex/access_control.ts";
import { test_convex, test_mocks_fill_db_with } from "../convex/setup.test.ts";
import { bash_run_command, bash_run_job } from "./bash.ts";
import { bash_COMMAND_EXIT_USAGE, bash_JOB_NUMBERS_MAX_COUNT } from "./bash-utils.ts";
import {
	test_db_files_mount,
	function_name_of,
	create_bash_runner,
	job_row,
	activity_of,
	run_job,
	mutation_calls,
} from "./bash.setup.test.ts";

describe("bash_run_command", () => {
	describe("jobs", () => {
		test("starts a job on stderr with $? 0, runs it with the shell state and stores its output", async () => {
			const runner = await create_bash_runner();
			const launched = await runner.run({ command: 'x=7; echo hi $x & echo "rc=$? job=$!"' });
			expect(launched.metadata.exitCode, launched.stderr).toBe(0);
			expect(launched.stdout).toBe("rc=0 job=1\n");
			expect(launched.stderr).toBe(
				"bash: started job 1 in shell default. Follow it with `jobs`, or in the Notifications panel.\n",
			);
			expect(launched.metadata.launchedJobNumbers).toEqual([1]);
			expect((await runner.run({ command: "echo $!" })).stdout).toBe("0\n");

			const queued = await job_row(runner, 1);
			expect(queued.job).toMatchObject({
				jobNumber: 1,
				script: "echo hi $x",
				startCwd: test_db_files_mount,
				startCwdTarget: null,
				allowDbFilesMkdir: true,
				workId: "work_bash_test_billing_event",
			});
			expect(await activity_of(runner, 1)).toMatchObject({ status: "queued", feedVisible: true });

			const finished = await run_job(runner, 1);
			expect(finished.status).toBe("finished");
			expect(finished.result).toMatchObject({ stdout: "hi 7\n", stderr: "", metadata: { exitCode: 0 } });
			expect(finished.job).toMatchObject({ script: null, shellState: null });
			expect(await activity_of(runner, 1)).toMatchObject({ status: "succeeded" });

			const entries = await runner.t.run(async (ctx) =>
				(await ctx.db.query("ai_chat_bash_shell_transcripts").collect()).sort((a, b) => a.seq - b.seq),
			);
			// The launch entry lands during the call, before the call's own entry.
			expect(entries.map((entry) => entry.text)).toEqual([
				expect.stringMatching(/^\[[^\]]+\] job 1 started in shell default: echo hi \$x$/),
				expect.stringMatching(/^\$ \[[^\]]+\] \(exit 0\) /),
				expect.stringMatching(/^\$ \[[^\]]+\] \(exit 0\) /),
				expect.stringMatching(
					/^\$ \[[^\]]+\] job 1 finished \(exit 0\) in shell default, started \d\d:\d\d:\d\d\necho hi \$x\nhi 7\n\n$/,
				),
			]);
		});

		test("jobs, jobs -a and jobs -o read the job back", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run({ command: "echo one &" })).metadata.exitCode).toBe(0);
			expect((await runner.run({ command: "{ echo two >&2; false; } &" })).metadata.exitCode).toBe(0);

			const live = await runner.run({ command: "jobs" });
			expect(live.metadata.exitCode).toBe(3);
			expect(live.stdout).toBe("[2] queued    default  { echo two >&2; false; }\n[1] queued    default  echo one\n");
			expect((await runner.run({ command: "jobs -o 1" })).metadata.exitCode).toBe(3);
			expect((await runner.run({ command: "jobs -o 9" })).stderr).toContain("bash: jobs: no such job 9\n");

			await run_job(runner, 1);
			await run_job(runner, 2);
			const all = await runner.run({ command: "jobs -a" });
			expect(all.metadata.exitCode, all.stderr).toBe(0);
			expect(all.stdout).toBe("[2] failed    default  { echo two >&2; false; }\n[1] done      default  echo one\n");
			expect((await runner.run({ command: "jobs" })).stdout).toBe("");

			const output = await runner.run({ command: "jobs -o 2" });
			expect(output.metadata.exitCode).toBe(0);
			expect(output.stdout).toBe("");
			expect(output.stderr).toBe("two\n[job 2 exit 1]\n");

			const row = await job_row(runner, 1);
			await runner.t.run((ctx) => ctx.db.patch("ai_chat_bash_invocations", row._id, { result: undefined }));
			const stripped = await runner.run({ command: "jobs -o 1" });
			expect(stripped.metadata.exitCode).toBe(1);
			expect(stripped.stdout).toBe("");
			// The row lost its result, so the message answers from the Activity's own outcome instead.
			expect(stripped.stderr).toBe("bash: jobs: job 1 done and stored no output; read the shell transcript\n");
		});

		test("jobs -o spends no read budget on a job that is still live", async () => {
			const runner = await create_bash_runner();
			// The budget check sits after the live check, so reading a live job three times in the call
			// that launched it must not spend the two reads the call may make.
			const read = await runner.run({ command: "sleep 60 & jobs -o 1; jobs -o 1; jobs -o 1; echo done" });
			expect(read.metadata.exitCode).toBe(0);
			expect(read.stdout).toBe("done\n");
			// The pool is mocked, so job 1 never starts and each read prints only its status marker.
			expect(read.stderr).toBe(
				"bash: started job 1 in shell default. Follow it with `jobs`, or in the Notifications panel.\n" +
					"[job 1 queued]\n[job 1 queued]\n[job 1 queued]\n",
			);
		});

		test("jobs -o still prints a live job's head after the row's deadline passes", async () => {
			const runner = await create_bash_runner();
			// The pool is mocked, so job 1 stays queued. Give it a flushed head and put its deadline in
			// the past: the invocation row then calls itself interrupted, which happens minutes before the
			// watchdog settles the job. `jobs` and `wait` read the Activity, so this command must agree
			// with them instead of calling the job ended and dropping the head.
			expect((await runner.run({ command: "sleep 60 &" })).metadata.exitCode).toBe(0);
			const row = await job_row(runner, 1);
			if (!row.job) throw new Error("Expected the job row");
			const job = row.job;
			await runner.t.run((ctx) =>
				ctx.db.patch("ai_chat_bash_invocations", row._id, {
					deadlineAt: Date.now() - 1,
					job: {
						...job,
						liveOutput: { stdout: "half\n", stderr: "", stdoutTruncated: false, stderrTruncated: false },
					},
				}),
			);
			const read = await runner.run({ command: "jobs -o 1" });
			expect(read.metadata.exitCode).toBe(3);
			expect(read.stdout).toBe("half\n");
			expect(read.stderr).toBe("[job 1 queued]\n");
		});

		test("jobs -o and wait report the same code for a job that stored a late result", async () => {
			const runner = await create_bash_runner();
			// The watchdog settles a job at its deadline while a slow worker is still storing the result
			// of a script that finished on its own. The job then holds a `timed_out` Activity and a
			// stored exit code of 0. `jobs -o` and `wait` must report 124, like the finish line
			// (`with exit 124`), not the stored 0.
			expect((await runner.run({ command: "echo late &" })).metadata.exitCode).toBe(0);
			expect((await run_job(runner, 1)).result).toMatchObject({ metadata: { exitCode: 0 } });
			const activity = await activity_of(runner, 1);
			if (!activity) throw new Error("Expected the job Activity");
			await runner.t.run((ctx) => ctx.db.patch("activities", activity._id, { status: "timed_out" }));

			const read = await runner.run({ command: "jobs -o 1" });
			expect(read.metadata.exitCode).toBe(0);
			expect(read.stdout).toBe("late\n");
			expect(read.stderr.endsWith("[job 1 exit 124]\n")).toBe(true);
			expect((await runner.run({ command: "wait 1" })).metadata.exitCode).toBe(124);
		});

		test("another member's jobs stay out of this member's list", async () => {
			const t = test_convex();
			const seeded = await t.run((ctx) =>
				test_mocks_fill_db_with.membership(ctx, { organizationName: "bash-jobs-team", workspaceName: "home" }),
			);
			const owner = await create_bash_runner({ shared: { t, seeded } });
			expect((await owner.run({ command: "sleep 60 &" })).metadata.exitCode).toBe(0);
			const member = await t.run((ctx) =>
				test_mocks_fill_db_with.membership(ctx, { organizationName: "personal", workspaceName: "home" }),
			);
			const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: seeded.userId });
			expect(
				(
					await asOwner.mutation(api.organizations.invite_user_to_organization_workspace, {
						organizationId: seeded.organizationId,
						workspaceId: seeded.workspaceId,
						userIdToAdd: member.userId,
					})
				)._nay,
			).toBeUndefined();
			const membership = await t.run((ctx) =>
				ctx.db
					.query("organizations_workspaces_users")
					.withIndex("by_workspace_user_active", (q) =>
						q.eq("workspaceId", seeded.workspaceId).eq("userId", member.userId).eq("active", true),
					)
					.unique(),
			);
			if (!membership) throw new Error("Expected invited membership");
			// Each member runs in their own chat and cannot name the other member's jobs.
			const runner = await create_bash_runner({
				shared: { t, seeded: { ...seeded, userId: member.userId, membershipId: membership._id } },
			});
			const listed = await runner.run({ command: "jobs -a" });
			expect(listed.metadata.exitCode, listed.stderr).toBe(0);
			expect(listed.stdout).toBe("");
			expect((await runner.run({ command: "kill 1" })).stderr).toBe("bash: kill: no such job 1\n");
			expect((await runner.run({ command: "jobs -o 1" })).stderr).toBe("bash: jobs: no such job 1\n");
			expect((await runner.run({ command: "wait 1" })).stderr).toBe("bash: wait: 1: no such job\n");
		});

		test("jobs keeps a space after the widest shell name", async () => {
			const runner = await create_bash_runner();
			// A shell name may be 32 characters. Padding the column to 9 would add nothing at that
			// width, so the name would run straight into the script.
			const widest = "a".repeat(32);
			expect(
				(await runner.run({ command: "echo one &", toolCallId: "bash-widest", shellName: widest })).metadata.exitCode,
			).toBe(0);
			expect((await runner.run({ command: "jobs", toolCallId: "bash-widest-list", shellName: widest })).stdout).toBe(
				`[1] queued    ${widest} echo one\n`,
			);
		});

		test("jobs -o reads one 32k page per stream and refuses a third read in one call", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run({ command: "seq 1 10000 &" })).metadata.exitCode).toBe(0);
			await run_job(runner, 1);
			const read = await runner.run({ command: "jobs -o 1; jobs -o 1; jobs -o 1" });
			expect(read.metadata.exitCode).toBe(1);
			expect(read.stdout.startsWith("1\n2\n3\n")).toBe(true);
			expect(read.stdout).toContain("\n[truncated]\n");
			expect(read.stderr).toBe(
				"[job 1 exit 0]\n[job 1 exit 0]\nbash: jobs: this call already read job output twice; read the shell transcript\n",
			);
		});

		test("jobs -o shows the output a running job flushed so far, with exit 3", async () => {
			const runner = await create_bash_runner();
			// A long `sleep $t` runs inline and keeps the worker busy. A literal `sleep 60` would pause the job
			// instead (see the pause tests below). The tests below use the same form for the same reason.
			expect(
				(await runner.run({ command: "{ echo first; echo warn >&2; t=60; sleep $t; echo last; } &" })).metadata
					.exitCode,
			).toBe(0);
			const row = await job_row(runner, 1);
			vi.useFakeTimers();
			try {
				const worker = bash_run_job(runner.ctx, { invocationId: row._id, workerGeneration: row.job!.workerGeneration });
				// Before the first poll tick nothing is flushed, so the read costs nothing and prints
				// only the status marker.
				await vi.advanceTimersByTimeAsync(1_000);
				const early = await runner.run({ command: "jobs -o 1" });
				expect(early.metadata.exitCode).toBe(3);
				expect(early.stdout).toBe("");
				expect(early.stderr).toBe("[job 1 running]\n");

				// The tick flushes the head; the mutation runs off the timer, so wait for the row.
				await vi.advanceTimersByTimeAsync(5_000);
				await vi.waitFor(async () => expect((await job_row(runner, 1)).job?.liveOutput).toBeDefined());
				expect((await job_row(runner, 1)).job?.liveOutput).toEqual({
					stdout: "first\n",
					stderr: "warn\n",
					stdoutTruncated: false,
					stderrTruncated: false,
				});
				const partial = await runner.run({ command: "jobs -o 1" });
				expect(partial.metadata.exitCode).toBe(3);
				expect(partial.stdout).toBe("first\n");
				expect(partial.stderr).toBe("warn\n[job 1 running]\n");

				// The job's `sleep` runs on the real clock (see the permission test below), so end the
				// job with a Stop instead of waiting for it.
				expect((await runner.run({ command: "kill 1" })).metadata.exitCode).toBe(0);
				await vi.advanceTimersByTimeAsync(5_000);
				await worker;
			} finally {
				vi.useRealTimers();
			}
			// The finish drops the head; the result and the transcript carry the output.
			const finished = await job_row(runner, 1);
			expect(finished.job?.liveOutput).toBeUndefined();
			expect(finished.result).toMatchObject({ stdout: "first\n", metadata: { exitCode: 143 } });
			const done = await runner.run({ command: "jobs -o 1" });
			expect(done.metadata.exitCode).toBe(0);
			expect(done.stdout).toBe("first\n");
			expect(done.stderr.startsWith("warn\n")).toBe(true);
			expect(done.stderr.endsWith("[job 1 exit 143]\n")).toBe(true);
		});

		test("the head cut drops half a character instead of storing it", async () => {
			const runner = await create_bash_runner();
			// The engine hands over each statement's output on its own, so a character whose two halves
			// come from two statements is cut where the head fills up. Convex refuses a mutation
			// argument that holds half a character, so the flush would fail for the rest of the job.
			// `printf '%32767s' x` prints 32766 spaces and an "x" in one statement. An awk loop is much slower.
			const script = `{ printf '%32767s' x; printf '\\ud83c'; printf '\\udf89'; sleep 30; }`;
			expect((await runner.run({ command: `${script} &` })).metadata.exitCode).toBe(0);
			const paused = await run_job(runner, 1);
			const head = paused.job?.liveOutput?.stdout ?? "";
			expect(head.isWellFormed()).toBe(true);
			// The cut backs off to the last whole character, so it keeps 32767 units, not 32768 with a
			// replacement character in the last slot.
			expect(head.length).toBe(32_767);
			expect(head.endsWith("x")).toBe(true);
			expect(paused.job?.liveOutput?.stdoutTruncated).toBe(true);
		});

		test("a head the script itself left half a character in is stored with U+FFFD", async () => {
			const runner = await create_bash_runner();
			// No cut is involved here: the script prints one half of a character. Convex refuses to
			// store it, so the flush and the pause repair the head before they hand it over.
			expect((await runner.run({ command: `{ printf 'A\\ud83cB'; sleep 30; } &` })).metadata.exitCode).toBe(0);
			const paused = await run_job(runner, 1);
			expect(paused.job?.liveOutput?.stdout).toBe("A�B");
		});

		test("an unrelated fresh call after a job finish carries no job text", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run({ command: "true", toolCallId: "before" })).metadata.exitCode).toBe(0);
			expect((await runner.run({ command: "echo bg &" })).metadata.exitCode).toBe(0);
			await run_job(runner, 1);
			// The finish message in the chat is the only signal now. Neither the rejoin nor any
			// fresh call carries job text in its output.
			const rejoined = await runner.run({ command: "true", toolCallId: "before" });
			expect(rejoined.stderr).toBe("");
			const fresh = await runner.run({ command: "echo fg" });
			expect(fresh.stdout).toBe("fg\n");
			expect(fresh.stderr).toBe("");
			expect((await runner.run({ command: "true" })).stderr).toBe("");
		});

		test("a job cannot change its shell and starts in the live cwd of the &", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run({ command: "cd docs; { x=1; cd nested; pwd; } & cd .." })).metadata.exitCode).toBe(0);
			const row = await job_row(runner, 1);
			expect(row.job?.startCwd).toBe(`${test_db_files_mount}/docs`);
			expect(row.job?.startCwdTarget).toMatchObject({ kind: "saved" });
			const finished = await run_job(runner, 1);
			expect(finished.result?.stdout).toBe(`${test_db_files_mount}/docs/nested\n`);
			expect((await runner.run({ command: "pwd; echo x=$x" })).stdout).toBe(`${test_db_files_mount}\nx=\n`);
		});

		test("refuses the 11th live job across the workspace and stops querying after 3 refusals", async () => {
			const runner = await create_bash_runner();
			for (let n = 1; n <= 10; n++) expect((await runner.run({ command: "sleep 1 &" })).metadata.exitCode).toBe(0);
			const refused = await runner.run({ command: "sleep 1 & echo rc=$?" });
			expect(refused.stdout).toBe("rc=1\n");
			expect(refused.stderr).toBe(
				"bash: cannot start a job: 10 jobs are already active across your workspace (queued, running or stopping). Some may be in another chat, where `jobs` and `wait` cannot name them. Wait for one of this chat's jobs, or start more in a later call.\n",
			);
			const before = mutation_calls(runner, "ai_chat_files:start_bash_job");
			const many = await runner.run({ command: "true & true & true & true & true &" });
			expect(mutation_calls(runner, "ai_chat_files:start_bash_job") - before).toBe(3);
			expect(many.stderr).toContain("3 launches in a row were refused in this call");
			expect((await runner.run({ command: "set -e; true & echo after" })).stdout).toBe("");
		});

		test("a launch that succeeds lets the call be refused three more times", async () => {
			const runner = await create_bash_runner();
			// A script over 64 KiB is refused every time, whatever the live jobs are, so one call can
			// mix refusals with a launch that works. Two refusals, a success, two more refusals: the
			// count only ever reaches two in a row, so the sixth launch must still ask the door.
			const tooBig = `true '${"a".repeat(66_000)}' &`;
			const before = mutation_calls(runner, "ai_chat_files:start_bash_job");
			const mixed = await runner.run({
				command: `${tooBig} ${tooBig} true & ${tooBig} ${tooBig} true & echo rc=$?; jobs -a`,
			});
			expect(mutation_calls(runner, "ai_chat_files:start_bash_job") - before).toBe(6);
			expect(mixed.stdout).toBe("rc=0\n[2] queued    default  true\n[1] queued    default  true\n");
			expect(mixed.stderr).toContain("bash: started job 2 in shell default");
			expect(mixed.stderr).not.toContain("in a row were refused");
		});

		test("a wait for a job that had already ended leaves the local block in place", async () => {
			const runner = await create_bash_runner();
			// Job 1 ended in an earlier call, so the cap was already not blocking this call while
			// these launches were refused, and this wait resets nothing. Without that rule
			// `true & wait 1` in a loop asks the door on every turn: `&` costs no command budget,
			// so this count is what stops that flat run.
			expect((await runner.run({ command: "echo one &" })).metadata.exitCode).toBe(0);
			await run_job(runner, 1);
			const tooBig = `true '${"a".repeat(66_000)}' &`;
			const before = mutation_calls(runner, "ai_chat_files:start_bash_job");
			const blocked = await runner.run({ command: `${tooBig} ${tooBig} ${tooBig} wait 1; ${tooBig} echo rc=$?` });
			expect(mutation_calls(runner, "ai_chat_files:start_bash_job") - before).toBe(3);
			expect(blocked.stdout).toBe("rc=1\n");
			expect(blocked.stderr).toContain("3 launches in a row were refused in this call");
		});

		test("a wait that waited for nothing leaves the local block in place", async () => {
			const runner = await create_bash_runner();
			// A loop of `cmd & wait` starts nothing and waits for nothing, so it must not be able to keep
			// asking the door. Only a wait that saw a live job end lifts the local block.
			const tooBig = `true '${"a".repeat(66_000)}' &`;
			const before = mutation_calls(runner, "ai_chat_files:start_bash_job");
			const blocked = await runner.run({ command: `${tooBig} ${tooBig} ${tooBig} wait; ${tooBig} echo rc=$?` });
			expect(mutation_calls(runner, "ai_chat_files:start_bash_job") - before).toBe(3);
			expect(blocked.stdout).toBe("rc=1\n");
			expect(blocked.stderr).toContain("3 launches in a row were refused in this call");
		});

		test("a wait that gave up with its job still live leaves the local block in place", async () => {
			const runner = await create_bash_runner();
			// The wait returns 3 with job 1 still queued, so no slot was freed. The reset has to sit
			// after that return: a reset before it would lift the block on a wait that ended nothing.
			for (let n = 1; n <= 10; n++) expect((await runner.run({ command: "sleep 1 &" })).metadata.exitCode).toBe(0);
			const before = mutation_calls(runner, "ai_chat_files:start_bash_job");
			const blocked = await runner.run({ command: "sleep 1 & sleep 1 & sleep 1 & wait -t 1 1; sleep 1 & echo rc=$?" });
			expect(mutation_calls(runner, "ai_chat_files:start_bash_job") - before).toBe(3);
			expect(blocked.stdout).toBe("rc=1\n");
			expect(blocked.stderr).toContain("3 launches in a row were refused in this call");
		});

		test("a wait that saw a live job end lifts the local block", async () => {
			const runner = await create_bash_runner();
			// Ten live jobs from earlier calls, then three cap refusals. The wait finds job 1 live,
			// the wrapper ends it after that first list, and the launch after the wait must ask the
			// door again. Deleting the `if (waitedOnLive)` reset leaves every other door test green.
			for (let n = 1; n <= 10; n++) expect((await runner.run({ command: "sleep 1 &" })).metadata.exitCode).toBe(0);
			const query = runner.runQuery.getMockImplementation()!;
			let ended = false;
			runner.runQuery.mockImplementation(async (ref, args) => {
				const result = await query(ref, args);
				if (
					!ended &&
					function_name_of(ref) === "ai_chat_files:list_thread_jobs" &&
					(args as { select?: { kind?: string } }).select?.kind === "numbers"
				) {
					ended = true;
					const row = await job_row(runner, 1);
					await runner.t.mutation(internal.ai_chat_files.finish_bash_job, {
						invocationId: row._id,
						workId: row.job!.workId!,
						result: {
							title: "job",
							output: "done\n",
							stdout: "done\n",
							stderr: "",
							metadata: {
								command: "sleep 1",
								cwd: "/",
								nextCwd: "/",
								exitCode: 0,
								stdoutTruncated: false,
								stderrTruncated: false,
								stdoutLength: 5,
								stderrLength: 0,
								pathIndexTruncated: false,
								observedPaths: [],
								observedPathsTruncated: false,
							},
						},
					});
				}
				return result;
			});
			const wait_lists = () =>
				runner.runQuery.mock.calls.filter(
					([ref, queryArgs]) =>
						function_name_of(ref) === "ai_chat_files:list_thread_jobs" &&
						(queryArgs as { select?: { kind?: string } }).select?.kind === "numbers",
				).length;
			const before = mutation_calls(runner, "ai_chat_files:start_bash_job");
			vi.useFakeTimers();
			try {
				// `wait` lists once, then sleeps. Hold the rest of the call until that first list, so
				// the wrapper can end job 1 while `wait` still sees it live. Then run out the `-t`
				// bound: `wait` has already returned by then, and a wait that never looked again
				// would hang this test.
				const waiting = runner.run({ command: "sleep 1 & sleep 1 & sleep 1 & wait -t 5 1; sleep 1 & echo rc=$?" });
				while (wait_lists() === 0) await vi.advanceTimersByTimeAsync(100);
				await vi.advanceTimersByTimeAsync(5_000);
				const reset = await waiting;
				expect(mutation_calls(runner, "ai_chat_files:start_bash_job") - before).toBe(4);
				expect(reset.stdout).toBe("rc=0\n");
				expect(reset.stderr).toContain("started job");
				expect(reset.stderr).not.toContain("in a row were refused");
			} finally {
				vi.useRealTimers();
			}
		});

		test("wait reports 1 when a job row disappears while it polls", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run({ command: "{ t=600; sleep $t; } &" })).metadata.exitCode).toBe(0);
			const row = await job_row(runner, 1);
			const query = runner.runQuery.getMockImplementation()!;
			let deleted = false;
			runner.runQuery.mockImplementation(async (ref, args) => {
				const result = await query(ref, args);
				if (
					!deleted &&
					function_name_of(ref) === "ai_chat_files:list_thread_jobs" &&
					(args as { select?: { kind?: string } }).select?.kind === "numbers"
				) {
					deleted = true;
					await runner.t.run(async (ctx) => {
						await ai_chat_files_db_delete_job_batch(ctx, { invocationId: row._id, batchSize: 8 });
					});
				}
				return result;
			});
			const wait_lists = () =>
				runner.runQuery.mock.calls.filter(
					([ref, queryArgs]) =>
						function_name_of(ref) === "ai_chat_files:list_thread_jobs" &&
						(queryArgs as { select?: { kind?: string } }).select?.kind === "numbers",
				).length;
			vi.useFakeTimers();
			try {
				// `wait` lists once, then sleeps. The first list still sees the row, so the missing
				// check passes. The wrapper then deletes it. The second list is empty. Asking
				// `read_job_exit_codes` for that empty list reports 0; asking for the number `wait`
				// started with reports 1.
				const waiting = runner.run({ command: "wait -t 5 1" });
				while (wait_lists() === 0) await vi.advanceTimersByTimeAsync(100);
				await vi.advanceTimersByTimeAsync(5_000);
				expect((await waiting).metadata.exitCode).toBe(1);
			} finally {
				vi.useRealTimers();
			}
		});

		test("a nested job counts against the cap and survives its parent's stop", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run({ command: "{ echo nested & } &" })).metadata.exitCode).toBe(0);
			const parent = await run_job(runner, 1);
			expect(parent.result?.stderr).toContain("bash: started job 2 in shell default.");
			expect(await activity_of(runner, 2)).toMatchObject({ status: "queued", source: { parentJobNumber: 1 } });
			expect((await runner.run({ command: "jobs" })).stdout).toBe(
				"[2] queued    default  echo nested   (from job 1)\n",
			);
			const child = await run_job(runner, 2);
			expect(child.result?.stdout).toBe("nested\n");
		});

		test("an old worker generation cannot run the statements saved by a pause", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run({ command: "{ echo before; sleep 30; echo after; } &" })).metadata.exitCode).toBe(0);
			const original = await job_row(runner, 1);
			const paused = await run_job(runner, 1);
			expect(paused.job?.workerGeneration).toBe(1);
			const activity = await activity_of(runner, 1);
			await bash_run_job(runner.ctx, {
				invocationId: original._id,
				workerGeneration: original.job!.workerGeneration,
			});
			expect(await job_row(runner, 1)).toEqual(paused);
			expect(await activity_of(runner, 1)).toEqual(activity);
			const finished = await run_job(runner, 1);
			expect(finished.result?.stdout).toBe("before\nafter\n");
			expect(finished.result?.metadata.exitCode).toBe(0);
		});

		test("pauses before a top-level sleep, keeps its state and cwd, and finishes in a later run", async () => {
			const runner = await create_bash_runner();
			const script = "{ x=1; echo before $x; cd docs; sleep 30; x=$((x + 1)); echo after $x; pwd; }";
			expect((await runner.run({ command: `${script} &` })).metadata.exitCode).toBe(0);

			// The first run stops before the sleep: the rest, the state, the cwd and the output head
			// go on the row, the Activity waits as `queued`, and the next run is due after the sleep.
			const paused = await run_job(runner, 1);
			expect(paused.status).toBe("running");
			expect(paused.job).toMatchObject({
				script,
				resumeScript: "x=$((x + 1))\necho after $x\npwd",
				startCwd: `${test_db_files_mount}/docs`,
				liveOutput: { stdout: "before 1\n", stderr: "", stdoutTruncated: false, stderrTruncated: false },
			});
			expect(paused.job?.shellState?.env).toContainEqual({ name: "x", value: "1" });
			const pausedActivity = await activity_of(runner, 1);
			expect(pausedActivity).toMatchObject({ status: "queued" });
			expect(vi.mocked(Workpool.prototype).enqueueAction.mock.calls.at(-1)?.[3]).toMatchObject({ runAfter: 30_000 });
			const partial = await runner.run({ command: "jobs -o 1" });
			expect(partial.metadata.exitCode).toBe(3);
			expect(partial.stdout).toBe("before 1\n");
			// The marker word comes from the Activity, so a paused job reads `queued` here too.
			expect(partial.stderr).toBe("[job 1 queued]\n");

			// The next run continues with the saved state and prints the whole job's output.
			const finished = await run_job(runner, 1);
			expect(finished.status).toBe("finished");
			expect(finished.job).toMatchObject({ script: null, shellState: null });
			expect(finished.job?.resumeScript).toBeUndefined();
			expect(finished.result).toMatchObject({
				stdout: `before 1\nafter 2\n${test_db_files_mount}/docs\n`,
				stderr: "",
				metadata: { exitCode: 0 },
			});
			expect(await activity_of(runner, 1)).toMatchObject({ status: "succeeded", startedAt: pausedActivity?.startedAt });
			const entries = await runner.t.run(async (ctx) =>
				(await ctx.db.query("ai_chat_bash_shell_transcripts").collect())
					.sort((a, b) => a.seq - b.seq)
					.map((entry) => entry.text),
			);
			expect(entries.find((entry) => entry.includes("job 1 paused"))).toMatch(
				/^\$ \[[^\]]+\] job 1 paused \(exit 0\) in shell default: sleep 30s, continues at [^\n]+\nbefore 1\n\n$/,
			);
			expect(entries.at(-1)).toMatch(
				/^\$ \[[^\]]+\] job 1 finished \(exit 0\) in shell default, started \d\d:\d\d:\d\d\n\{ x=1; [^\n]+\nbefore 1\nafter 2\n/,
			);
		});

		test("pauses when the run budget is nearly used and continues at once", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run({ command: "{ sleep 1; echo one; echo two; } &" })).metadata.exitCode).toBe(0);
			const row = await job_row(runner, 1);
			vi.useFakeTimers({ toFake: ["Date"] });
			try {
				const start = Date.now();
				const worker = bash_run_job(runner.ctx, { invocationId: row._id, workerGeneration: row.job!.workerGeneration });
				// The first statement sleeps on the real clock; meanwhile the run budget runs out.
				await new Promise((resolve) => setTimeout(resolve, 300));
				vi.setSystemTime(start + 7 * 60 * 1000);
				await worker;
			} finally {
				vi.useRealTimers();
			}
			const paused = await job_row(runner, 1);
			expect(paused.status).toBe("running");
			expect(paused.job).toMatchObject({ resumeScript: "echo one\necho two" });
			expect(paused.job?.liveOutput).toBeUndefined();
			// Nothing was printed yet, so the marker is the whole answer; it still costs no read budget.
			const partial = await runner.run({ command: "jobs -o 1" });
			expect(partial.metadata.exitCode).toBe(3);
			expect(partial.stdout).toBe("");
			expect(partial.stderr).toBe("[job 1 queued]\n");
			expect(vi.mocked(Workpool.prototype).enqueueAction.mock.calls.at(-1)?.[3]).toMatchObject({ runAfter: 0 });
			const entries = await runner.t.run(async (ctx) =>
				(await ctx.db.query("ai_chat_bash_shell_transcripts").collect()).map((entry) => entry.text),
			);
			expect(
				entries.some((entry) =>
					entry.includes("job 1 paused (exit 0) in shell default: run budget used, continues at once\n"),
				),
			).toBe(true);

			const finished = await run_job(runner, 1);
			expect(finished.result).toMatchObject({ stdout: "one\ntwo\n", metadata: { exitCode: 0 } });
		});

		test("a dropped sleep leaves $? at 0, like a sleep that ran", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run({ command: "{ false; sleep 30; echo rc=$?; } &" })).metadata.exitCode).toBe(0);
			await run_job(runner, 1);
			const finished = await run_job(runner, 1);
			expect(finished.result?.stdout).toBe("rc=0\n");
		});

		test("a pause tells jobs -o about the dropped /tmp writes and the closed descriptors", async () => {
			const runner = await create_bash_runner();
			const script = "{ exec 3>/tmp/log; echo one > /tmp/keep; sleep 30; echo two; }";
			expect((await runner.run({ command: `${script} &` })).metadata.exitCode).toBe(0);
			expect((await run_job(runner, 1)).status).toBe("running");

			// The warnings are added after the engine returned, so only this prepares them for the head
			// `jobs -o` reads; the run's own result reaches the transcript instead.
			const partial = await runner.run({ command: "jobs -o 1" });
			expect(partial.metadata.exitCode).toBe(3);
			expect(partial.stderr).toContain("bash: /tmp writes are dropped when a job pauses:");
			expect(partial.stderr).toContain("bash: file descriptor 3 was closed\n");
			expect(partial.stderr.endsWith("[job 1 queued]\n")).toBe(true);
		});

		test("a job whose state is too big to pause runs on and says so", async () => {
			const runner = await create_bash_runner();
			// 133000 characters in one variable put the snapshot over the 128 KiB cap, so the sleep
			// cannot pause and runs for real.
			const script = '{ x=$(printf "%133000s" ""); sleep 5; echo done; }';
			expect((await runner.run({ command: `${script} &` })).metadata.exitCode).toBe(0);
			const finished = await run_job(runner, 1);
			expect(finished.status).toBe("finished");
			expect(finished.result?.stdout).toBe("done\n");
			expect(finished.result?.stderr).toContain(
				"bash: the shell state is larger than 128 KiB, so the job cannot pause",
			);
		});

		test("a pause says nothing about an earlier statement that was too big to pause", async () => {
			const runner = await create_bash_runner();
			// The first sleep cannot pause, because the variable is over the cap. `unset` shrinks the
			// state, so the second sleep pauses, and the warning would contradict that pause.
			const script = '{ x=$(printf "%133000s" ""); sleep 5; unset x; sleep 5; echo done; }';
			expect((await runner.run({ command: `${script} &` })).metadata.exitCode).toBe(0);
			const paused = await run_job(runner, 1);
			expect(paused.status).toBe("running");
			// The first sleep really could not pause: the stored rest starts after the second sleep, so
			// this run walked past the first one instead of stopping there.
			expect(paused.job?.resumeScript).toBe("echo done");

			const partial = await runner.run({ command: "jobs -o 1" });
			expect(partial.stderr).not.toContain("the shell state is larger than 128 KiB");
			expect(partial.stderr.endsWith("[job 1 queued]\n")).toBe(true);
		});

		test("stops pausing once the job used its whole lifetime", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run({ command: "{ sleep 30; echo after; } &" })).metadata.exitCode).toBe(0);
			const row = await job_row(runner, 1);
			vi.useFakeTimers({ toFake: ["Date"] });
			try {
				// Claim refuses this old job before running any shell statement.
				vi.setSystemTime(row._creationTime + 25 * 60 * 60 * 1000);
				await bash_run_job(runner.ctx, { invocationId: row._id, workerGeneration: row.job!.workerGeneration });
			} finally {
				vi.useRealTimers();
			}
			const finished = await job_row(runner, 1);
			expect(finished.status).toBe("interrupted");
			expect(finished.result).toBeUndefined();
			expect(finished.job?.resumeScript).toBeUndefined();
			expect(await activity_of(runner, 1)).toMatchObject({ status: "timed_out" });
		});

		test("a launch after a pause starts a new job instead of finding the earlier one", async () => {
			const runner = await create_bash_runner();
			// A launch is stored under a synthetic tool-call id made of the job row and the command
			// number, so a replayed launch finds the row it already made. Each run counts its own
			// commands, so the count has to survive the pause: otherwise both `&` statements are
			// command 0, and the second launch finds job 2 again and starts nothing.
			expect((await runner.run({ command: "{ echo one & sleep 30; echo two & } &" })).metadata.exitCode).toBe(0);
			await run_job(runner, 1);
			expect((await job_row(runner, 2)).job?.script).toBe("echo one");

			const finished = await run_job(runner, 1);
			expect(finished.status).toBe("finished");
			expect(finished.result?.stderr).toContain("bash: started job 3 in shell default.");
			expect((await job_row(runner, 3)).job?.script).toBe("echo two");
		});

		test("a bare wait after a pause still waits for the jobs the earlier run started", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run({ command: "{ echo one & sleep 30; wait -t 1; } &" })).metadata.exitCode).toBe(0);
			await run_job(runner, 1);
			// The pool is mocked, so job 2 is still queued. A bare `wait` that lost the numbers of
			// the earlier run would wait for nothing and return 0 instead of 3.
			const finished = await run_job(runner, 1);
			expect(finished.result?.metadata.exitCode).toBe(3);
		});

		test("a launch before a pause still answers wait $! in the next run", async () => {
			const runner = await create_bash_runner();
			expect(
				(await runner.run({ command: "sleep 1 & { echo one & sleep 30; wait -t 1 $!; } &" })).metadata.exitCode,
			).toBe(0);
			// A job starts with `$!` at 0: job 1 belongs to the call that started it, not to job 2.
			expect((await job_row(runner, 2)).job?.shellState?.lastBackgroundPid).toBeUndefined();
			// The shell the call leaves behind keeps no `$!` either, so the next call reads 0. That is
			// what the tool prompt promises, and storing the call's snapshot unchanged breaks it.
			expect((await runner.run({ command: "echo $!" })).stdout).toBe("0\n");

			const paused = await run_job(runner, 2);
			// `$!` is part of the shell state the pause stored. A state that dropped it would run
			// `wait -t 1 0`, which names no job, instead of waiting for the still-queued job 3.
			expect(paused.job?.shellState?.lastBackgroundPid).toBe(3);
			const finished = await run_job(runner, 2);
			expect(finished.result?.metadata.exitCode).toBe(3);
		});

		test("a bare wait takes the newest job numbers when a job started more than one wait may name", async () => {
			const runner = await create_bash_runner();
			// Twelve finished jobs. The cap counts live jobs, so launch four and run those four to the
			// end before the next four. Job 1 exits 7 and is the oldest number the slice keeps, so a wait
			// that kept eleven numbers, or numbers from the wrong end, cannot print 7 below.
			for (let round = 0; round < 3; round++) {
				const launches = round === 0 ? "exit 7 & echo b & echo c & echo d &" : "echo a & echo b & echo c & echo d &";
				expect((await runner.run({ command: launches })).metadata.exitCode).toBe(0);
				for (let jobNumber = round * 4 + 1; jobNumber <= round * 4 + 4; jobNumber++) {
					expect((await run_job(runner, jobNumber)).status).toBe("finished");
				}
			}

			expect((await runner.run({ command: "{ sleep 5; wait; echo rc=$?; } &" })).metadata.exitCode).toBe(0);
			const paused = await run_job(runner, 13);
			expect(paused.job?.resumeScript).toBe("wait\necho rc=$?");
			// A job that ran several statements across pauses can have started more jobs than one
			// `wait` may name. Fourteen numbers, and the two oldest name no row: a read of more than
			// twelve is refused whole, and a slice from the wrong end asks for 998 and gets "no such
			// job" instead of waiting.
			await runner.t.run((ctx) =>
				ctx.db.patch("ai_chat_bash_invocations", paused._id, {
					job: { ...paused.job!, resumeLaunchedJobNumbers: [998, 999, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] },
				}),
			);

			// The bare `wait` keeps the newest twelve, which all finished, so it waits for nothing and
			// prints the worst exit code among them, which is job 1's 7. The job's own exit code is the
			// `echo`'s.
			const finished = await run_job(runner, 13);
			expect(finished.result?.stderr).toBe("");
			expect(finished.result?.stdout).toBe("rc=7\n");
			expect(finished.result?.metadata.exitCode).toBe(0);
		});

		test("a pause stores only the newest job numbers when a job started more than the row may keep", async () => {
			const runner = await create_bash_runner();
			// Three launches per run is the room the job has: the 4-jobs cap counts the job itself, and
			// each round's jobs must finish before the next round may start. Five rounds launch fifteen
			// jobs, which is more than the twelve numbers a row may keep.
			const round = "echo a & echo b & echo c & sleep 5; ";
			expect((await runner.run({ command: `{ ${round.repeat(5)}echo done; } &` })).metadata.exitCode).toBe(0);
			for (let pass = 0; pass < 5; pass++) {
				expect((await run_job(runner, 1)).job?.resumeScript).toBeDefined();
				for (let jobNumber = pass * 3 + 2; jobNumber <= pass * 3 + 4; jobNumber++) {
					expect((await run_job(runner, jobNumber)).status).toBe("finished");
				}
			}

			// The newest twelve of the fifteen. Without the cap the stored array would grow with every
			// pause of a job that keeps launching jobs, for as long as the job lives.
			const paused = await job_row(runner, 1);
			expect(paused.job?.resumeScript).toBe("echo done");
			expect(paused.job?.resumeLaunchedJobNumbers).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
		});

		test("a settled job keeps no script and no paused state", async () => {
			const runner = await create_bash_runner();
			const script = "{ x=1; sleep 30; echo done; }";
			expect((await runner.run({ command: `${script} &` })).metadata.exitCode).toBe(0);
			const paused = await run_job(runner, 1);
			expect(paused.job?.resumeScript).toBe("echo done");
			expect(paused.job?.shellState?.env).toContainEqual({ name: "x", value: "1" });

			// The watchdog settles the paused row, and nothing will ever run it again. So the script and
			// the state it stored for the next run must not sit on the row until the row is deleted.
			vi.useFakeTimers({ toFake: ["Date"] });
			try {
				vi.setSystemTime(paused.deadlineAt + 1);
				await runner.t.mutation(internal.ai_chat_files.timeout_bash_job, {
					invocationId: paused._id,
					expectedDeadlineAt: paused.deadlineAt,
				});
			} finally {
				vi.useRealTimers();
			}
			const settled = await job_row(runner, 1);
			expect(settled.status).toBe("interrupted");
			expect(settled.job).toMatchObject({ script: null, shellState: null });
			expect(settled.job?.resumeScript).toBeUndefined();
			expect(settled.job?.resumeCommandNumber).toBeUndefined();
			expect(settled.job?.resumeLaunchedJobNumbers).toBeUndefined();
			// The finish entry still names the script, because the settle writes it from the copy it
			// read before the patch. Read it off that entry: the launching call and the start entry
			// print the same text, so searching the whole transcript would pass without it.
			const lines = (await runner.run({ command: "cat /shells/default/transcript" })).stdout.split("\n");
			const finishHeader = lines.findIndex((line) => line.includes("job 1 finished (exit 124)"));
			expect(finishHeader).toBeGreaterThan(-1);
			expect(lines[finishHeader + 1]).toBe(script);
		});

		test("a Stop lands at the next statement boundary, not only at the next 5-second tick", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run({ command: "{ sleep 1.2; echo after; } &" })).metadata.exitCode).toBe(0);
			const row = await job_row(runner, 1);
			const worker = bash_run_job(runner.ctx, { invocationId: row._id, workerGeneration: row.job!.workerGeneration });
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect((await runner.run({ command: "kill 1" })).metadata.exitCode).toBe(0);
			// Without the boundary poll `echo after` would run at 1.2 s, well before the 5-second tick.
			await worker;
			const finished = await job_row(runner, 1);
			expect(finished.result).toMatchObject({ stdout: "", metadata: { exitCode: 143 } });
			expect(await activity_of(runner, 1)).toMatchObject({ status: "canceled" });
		});

		test("a call with the wake flag arms the jobs it starts, and a job a job starts is never armed", async () => {
			const runner = await create_bash_runner({ wakeAgent: { modelId: "gpt-6-luna" } });
			expect((await runner.run({ command: "{ echo nested & } &" })).metadata.exitCode).toBe(0);
			expect((await job_row(runner, 1)).job?.wakeAgent).toEqual({ modelId: "gpt-6-luna" });
			// The worker's own jobContext carries no wake flag.
			await run_job(runner, 1);
			expect((await job_row(runner, 2)).job?.wakeAgent).toBeUndefined();
		});

		test("wait in a call with the wake flag arms the live jobs and stops polling", async () => {
			const launcher = await create_bash_runner();
			expect((await launcher.run({ command: "sleep 600 &" })).metadata.exitCode).toBe(0);
			expect((await launcher.run({ command: "true &" })).metadata.exitCode).toBe(0);
			await run_job(launcher, 2);
			expect((await job_row(launcher, 1)).job?.wakeAgent).toBeUndefined();
			// A plain `wait` polls and reports nothing about waking.
			const polled = await launcher.run({ command: "wait -t 1 1" });
			expect(polled.metadata.exitCode).toBe(3);
			expect(polled.metadata.waitingForJobs).toBeUndefined();

			const waiter = await create_bash_runner({
				shared: { t: launcher.t, seeded: launcher.seeded },
				threadId: launcher.threadId,
				wakeAgent: { modelId: "gpt-6-luna" },
			});
			const waited = await waiter.run({ command: "wait 1 2" });
			expect(waited.stderr).toBe(
				"bash: waiting for job 1: end this turn. The finish then starts your next run, or leaves its result in the chat message.\n",
			);
			expect(waited.metadata.exitCode).toBe(3);
			expect(waited.metadata.waitingForJobs).toEqual([1]);
			expect((await job_row(launcher, 1)).job?.wakeAgent).toEqual({ modelId: "gpt-6-luna" });
			// A finished job is never armed, and a wait on it alone reads its result as usual.
			expect((await job_row(launcher, 2)).job?.wakeAgent).toBeUndefined();
			const done = await waiter.run({ command: "wait 2" });
			expect(done.metadata.exitCode).toBe(0);
			expect(done.metadata.waitingForJobs).toBeUndefined();
		});

		test("kill stops a running job with 143, also inside a sleep, and never ends the call", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run({ command: "{ echo before; t=60; sleep $t; } &" })).metadata.exitCode).toBe(0);
			const row = await job_row(runner, 1);
			vi.useFakeTimers();
			try {
				const worker = bash_run_job(runner.ctx, { invocationId: row._id, workerGeneration: row.job!.workerGeneration });
				await vi.advanceTimersByTimeAsync(1_000);
				const killed = await runner.run({ command: "kill 1; echo after" });
				expect(killed.stdout).toBe("after\n");
				expect(killed.stderr).toBe("bash: kill: stop requested for job 1\n");
				expect(killed.metadata.exitCode).toBe(0);
				await vi.advanceTimersByTimeAsync(5_000);
				await worker;
			} finally {
				vi.useRealTimers();
			}
			const stopped = await job_row(runner, 1);
			expect(stopped.result).toMatchObject({ stdout: "before\n", metadata: { exitCode: 143 } });
			expect(stopped.result?.stderr).toContain("bash: job stopped. Remaining commands were stopped.");
			// `sleep` runs through the /tmp-only delegate, so a Stop ends it non-zero. `sleep` never
			// reads an app file, so the stored output must not tell the user about db-backed paths.
			expect(stopped.result?.stderr).not.toContain("cannot access app files directly");
			expect(await activity_of(runner, 1)).toMatchObject({ status: "canceled" });
			// No job text precedes the kill errors: this fresh call comes after the finish.
			const missing = await runner.run({ command: "kill 9; kill 1" });
			expect(missing.stderr).toBe("bash: kill: no such job 9\nbash: kill: no such job 1\n");
			expect(missing.metadata.exitCode).toBe(1);
		});

		test("an Ask-mode member can kill its own job", async () => {
			const t = test_convex();
			const seeded = await t.run((ctx) =>
				test_mocks_fill_db_with.membership(ctx, { organizationName: "job-team", workspaceName: "home" }),
			);
			const owner = await create_bash_runner({ shared: { t, seeded } });
			const member = await owner.t.run(async (ctx) => {
				const userId = await ctx.db.insert("users", { clerkUserId: "ask-kill-member" });
				await test_mocks_fill_db_with.membership(ctx, { userId, organizationName: "personal", workspaceName: "home" });
				const membershipId = await ctx.db.insert("organizations_workspaces_users", {
					organizationId: owner.seeded.organizationId,
					workspaceId: owner.seeded.workspaceId,
					userId,
					active: true,
					pendingOrganizationRemoval: false,
					updatedAt: Date.now(),
				});
				await access_control_db_ensure_role_assignment(ctx, {
					organizationId: owner.seeded.organizationId,
					workspaceId: owner.seeded.workspaceId,
					userId,
					role: "viewer",
					now: Date.now(),
				});
				return { userId, membershipId };
			});
			// Ask mode cannot write app files, so the `kill` door needs `content.read` only. Give the
			// member the one role that holds read and nothing else, so a door that asked for write
			// instead would fail here. A member who does not own the organization must still be able to
			// stop their own job.
			const runner = await create_bash_runner({
				allowDbFilesMkdir: false,
				shared: { t: owner.t, seeded: { ...owner.seeded, ...member } },
			});
			expect((await runner.run({ command: "{ t=60; sleep $t; } &" })).metadata.exitCode).toBe(0);
			const row = await job_row(runner, 1);
			expect(row.job?.allowDbFilesMkdir).toBe(false);
			vi.useFakeTimers();
			try {
				const worker = bash_run_job(runner.ctx, { invocationId: row._id, workerGeneration: row.job!.workerGeneration });
				await vi.advanceTimersByTimeAsync(1_000);
				const killed = await runner.run({ command: "kill 1" });
				expect(killed.metadata.exitCode, killed.stderr).toBe(0);
				expect(killed.stderr).toBe("bash: kill: stop requested for job 1\n");
				await vi.advanceTimersByTimeAsync(10_000);
				// Run out the job's whole 8-minute budget too. The stop has already been served by now.
				// If the `kill` door had refused an Ask-mode stop, the job would report 124 here instead
				// of hanging the test.
				await vi.advanceTimersByTimeAsync(8 * 60 * 1000);
				await worker;
			} finally {
				vi.useRealTimers();
			}
			expect((await job_row(runner, 1)).result?.metadata.exitCode).toBe(143);
			expect(await activity_of(runner, 1)).toMatchObject({ status: "canceled" });
		});

		test("a running job stops when its read permission is taken away", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run({ command: "{ echo before; t=60; sleep $t; } &" })).metadata.exitCode).toBe(0);
			const row = await job_row(runner, 1);
			expect(row.job?.allowDbFilesMkdir).toBe(true);
			vi.useFakeTimers();
			try {
				const worker = bash_run_job(runner.ctx, { invocationId: row._id, workerGeneration: row.job!.workerGeneration });
				await vi.advanceTimersByTimeAsync(1_000);
				// Hand ownership away and remove the role, keeping the membership active.
				await runner.t.run(async (ctx) => {
					const otherOwnerId = await ctx.db.insert("users", { clerkUserId: null });
					await ctx.db.patch("organizations", runner.seeded.organizationId, { ownerUserId: otherOwnerId });
					const assignmentId = await access_control_db_ensure_role_assignment(ctx, {
						organizationId: runner.seeded.organizationId,
						workspaceId: runner.seeded.workspaceId,
						userId: runner.seeded.userId,
						role: "member",
						now: Date.now(),
					});
					await ctx.db.delete("access_control_role_assignments", assignmentId);
				});
				await vi.advanceTimersByTimeAsync(10_000);
				// Run out the job's whole 8-minute budget too. The poll has already stopped the job by now.
				// If a poll had skipped the permission check, the job would report 124 here instead of
				// hanging the test.
				await vi.advanceTimersByTimeAsync(8 * 60 * 1000);
				await worker;
			} finally {
				vi.useRealTimers();
			}
			const stopped = await job_row(runner, 1);
			expect(stopped.result).toMatchObject({ stdout: "before\n", metadata: { exitCode: 143 } });
			expect(await activity_of(runner, 1)).toMatchObject({ status: "canceled" });
		});

		test.each([false, true])(
			"a job keeps running after write permission loss (agent=%s)",
			async (allowDbFilesMkdir) => {
				const runner = await create_bash_runner({ allowDbFilesMkdir });
				expect((await runner.run({ command: "{ echo before; t=600; sleep $t; } &" })).metadata.exitCode).toBe(0);
				const row = await job_row(runner, 1);
				expect(row.job?.allowDbFilesMkdir).toBe(allowDbFilesMkdir);
				// Only the poll can stop a job, so count its turns to prove it really ran.
				const poll_count = () =>
					runner.runQuery.mock.calls.filter(([ref]) => function_name_of(ref) === "ai_chat_files:poll_bash_job").length;
				vi.useFakeTimers();
				try {
					const worker = bash_run_job(runner.ctx, {
						invocationId: row._id,
						workerGeneration: row.job!.workerGeneration,
					});
					await vi.advanceTimersByTimeAsync(1_000);
					const pollsBeforeHandover = poll_count();
					// Both modes need source read access. File writes check their own destination.
					await runner.t.run(async (ctx) => {
						const otherOwnerId = await ctx.db.insert("users", { clerkUserId: null });
						await ctx.db.patch("organizations", runner.seeded.organizationId, { ownerUserId: otherOwnerId });
						// `ensure` returns an existing assignment unchanged, so patch the role as well. A user
						// who already held a `member` role-assignment doc would otherwise keep `content.write`,
						// and this test would pass without ever taking the permission away.
						const assignmentId = await access_control_db_ensure_role_assignment(ctx, {
							organizationId: runner.seeded.organizationId,
							workspaceId: runner.seeded.workspaceId,
							userId: runner.seeded.userId,
							role: "member",
							now: Date.now(),
						});
						await ctx.db.patch("access_control_role_assignments", assignmentId, { role: "viewer" });
					});
					await vi.advanceTimersByTimeAsync(15_000);
					// Count the polls that ran after the handover. Nothing else in this test would notice a
					// handover that did not take, and the exit code below reads 124 either way.
					expect(poll_count()).toBeGreaterThan(pollsBeforeHandover);
					// The job's own `sleep` runs on the real clock, because just-bash keeps the `setTimeout` it
					// captured when the module loaded and no fake advance can move it. So let the job's
					// deadline end it instead of waiting for the sleep. A poll that asked for write would have
					// stopped the job at 5 seconds and the exit code below would read 143.
					await vi.advanceTimersByTimeAsync(8 * 60 * 1000);
					await worker;
				} finally {
					vi.useRealTimers();
				}
				const finished = await job_row(runner, 1);
				expect(finished.result).toMatchObject({ stdout: "before\n", metadata: { exitCode: 124 } });
				expect(await activity_of(runner, 1)).toMatchObject({ status: "timed_out" });
			},
		);

		test("a job that uses its whole budget keeps its output and reports 124", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run({ command: "{ echo partial; t=600; sleep $t; } &" })).metadata.exitCode).toBe(0);
			const row = await job_row(runner, 1);
			vi.useFakeTimers();
			try {
				const worker = bash_run_job(runner.ctx, { invocationId: row._id, workerGeneration: row.job!.workerGeneration });
				await vi.advanceTimersByTimeAsync(8 * 60 * 1000);
				await worker;
			} finally {
				vi.useRealTimers();
			}
			const timedOut = await job_row(runner, 1);
			expect(timedOut.result).toMatchObject({ stdout: "partial\n", metadata: { exitCode: 124 } });
			expect(timedOut.result?.stderr).toContain("Remaining commands were stopped.");
			// A deadline is not an app-file failure either, so its stored output must stay clean too.
			expect(timedOut.result?.stderr).not.toContain("cannot access app files directly");
			expect(await activity_of(runner, 1)).toMatchObject({ status: "timed_out" });
		});

		test("wait -t stops at the call's own deadline, not at the seconds it was given", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run({ command: "{ t=600; sleep $t; } &" })).metadata.exitCode).toBe(0);
			// Only `wait` reads the jobs it was named, so this counts its own polls.
			const wait_polls = () =>
				runner.runQuery.mock.calls.filter(
					([ref, queryArgs]) =>
						function_name_of(ref) === "ai_chat_files:list_thread_jobs" &&
						(queryArgs as { select?: { kind?: string } }).select?.kind === "numbers",
				).length;
			runner.runQuery.mockClear();
			vi.useFakeTimers();
			try {
				// A call gets 90 seconds at most, so `wait` cannot really wait the 600 it was given. The
				// job never runs here, so it stays live for the whole wait.
				const startedAt = Date.now();
				let polls = 0;
				let lastPollMs = 0;
				const waiting = runner.run({ command: "wait -t 600 1" });
				// Read the clock at `wait`'s last look at the jobs, not when the call returns: storing the
				// result and writing the transcript take their own turns, and each one costs another step
				// of this loop. Run the whole 150 seconds, which is past the call's own 120-second abort,
				// so a `wait` that kept its 600 seconds also stops polling and the assertion reads its
				// last poll instead of hanging the test.
				while (Date.now() - startedAt < 150_000) {
					await vi.advanceTimersByTimeAsync(1_000);
					if (wait_polls() > polls) {
						polls = wait_polls();
						lastPollMs = Date.now() - startedAt;
					}
				}
				// A `wait` that did not wait at all polls once, and one that used its own 600 seconds keeps
				// polling until the call is aborted at 120 seconds. Bound both ends, so neither passes.
				// The upper bound has room for a slow step of this loop, which can drift a few seconds.
				expect(polls).toBeGreaterThan(1);
				expect(lastPollMs).toBeGreaterThanOrEqual(85_000);
				expect(lastPollMs).toBeLessThanOrEqual(100_000);
				expect((await waiting).metadata.exitCode).toBe(3);
			} finally {
				vi.useRealTimers();
			}
		});

		test("wait notices a job that finishes while it is waiting", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run({ command: "false &" })).metadata.exitCode).toBe(0);
			const row = await job_row(runner, 1);
			// Only `wait` reads the jobs it was named, so this counts its own list calls.
			const wait_lists = () =>
				runner.runQuery.mock.calls.filter(
					([ref, queryArgs]) =>
						function_name_of(ref) === "ai_chat_files:list_thread_jobs" &&
						(queryArgs as { select?: { kind?: string } }).select?.kind === "numbers",
				).length;
			runner.runQuery.mockClear();
			vi.useFakeTimers();
			try {
				// `wait` lists the jobs once, sleeps, then lists them again. Hold the worker back until
				// that first list has run, so `wait` sees the job still queued. Only the second list can
				// report the job's own exit code here; without it `wait` would report 3.
				const waiting = runner.run({ command: "wait -t 20 1" });
				while (wait_lists() === 0) await vi.advanceTimersByTimeAsync(100);
				const worker = bash_run_job(runner.ctx, { invocationId: row._id, workerGeneration: row.job!.workerGeneration });
				await vi.advanceTimersByTimeAsync(5_000);
				await worker;
				// Run out the whole `-t` bound too. `wait` has already returned by now, and a `wait`
				// that never looked again gives up with 3 here instead of hanging the test.
				await vi.advanceTimersByTimeAsync(20_000);
				expect((await waiting).metadata.exitCode).toBe(1);
			} finally {
				vi.useRealTimers();
			}
			expect(await activity_of(runner, 1)).toMatchObject({ status: "failed" });
		});

		test("a job whose row was already settled interrupted stops with 124, not 143", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run({ command: "{ echo partial; t=600; sleep $t; } &" })).metadata.exitCode).toBe(0);
			const row = await job_row(runner, 1);
			vi.useFakeTimers();
			try {
				const worker = bash_run_job(runner.ctx, { invocationId: row._id, workerGeneration: row.job!.workerGeneration });
				await vi.advanceTimersByTimeAsync(1_000);
				// Somebody else marked the row interrupted while this worker is still alive. That is a
				// deadline, not a Stop, so the poll must abort with the deadline reason.
				await runner.t.mutation(internal.ai_chat_files.interrupt_bash_invocation, { invocationId: row._id });
				await vi.advanceTimersByTimeAsync(5_000);
				await worker;
			} finally {
				vi.useRealTimers();
			}
			const settled = await job_row(runner, 1);
			expect(settled.result).toMatchObject({ stdout: "partial\n", metadata: { exitCode: 124 } });
			expect(settled.result?.stderr).toContain("bash: Bash deadline reached. Remaining commands were stopped.");
		});

		test("wait covers this call's launches or named jobs and reports the worst code", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run({ command: "wait" })).metadata.exitCode).toBe(0);
			expect((await runner.run({ command: "false &" })).metadata.exitCode).toBe(0);
			expect((await runner.run({ command: "true &" })).metadata.exitCode).toBe(0);
			const missing = await runner.run({ command: "wait 9" });
			expect(missing.stderr).toBe("bash: wait: 9: no such job\n");
			expect(missing.metadata.exitCode).toBe(1);
			expect((await runner.run({ command: "wait -t 1 1" })).metadata.exitCode).toBe(3);
			await run_job(runner, 1);
			await run_job(runner, 2);
			expect((await runner.run({ command: "wait 2" })).metadata.exitCode).toBe(0);
			expect((await runner.run({ command: "wait 1 2" })).metadata.exitCode).toBe(1);
			const launched = await runner.run({ command: "true & wait -t 1" });
			expect(launched.metadata.exitCode).toBe(3);
		});

		test("wait refuses more job numbers than the door will read", async () => {
			const runner = await create_bash_runner();
			// `wait {1..5000}` is 14 characters to type and one index read per number to serve, so the
			// list is bounded here as well as at the door.
			const many = await runner.run({
				command: `wait ${Array.from({ length: bash_JOB_NUMBERS_MAX_COUNT + 1 }, (_, n) => n + 1).join(" ")}`,
			});
			expect(many.stderr).toBe(
				`wait: at most ${bash_JOB_NUMBERS_MAX_COUNT} job numbers can be waited at once\nUsage: wait [-t SECONDS] [JOB...]\n`,
			);
			expect(many.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);

			// Repeats collapse, so a long list of the same job is still one read.
			expect((await runner.run({ command: `wait ${"1 ".repeat(bash_JOB_NUMBERS_MAX_COUNT + 4)}` })).stderr).toBe(
				"bash: wait: 1: no such job\n",
			);
		});

		test("wait answers from the Activity when the result is gone or the watchdog settled the job", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run({ command: "true &" })).metadata.exitCode).toBe(0);
			expect((await runner.run({ command: "{ t=600; sleep $t; } &" })).metadata.exitCode).toBe(0);
			const done = await run_job(runner, 1);
			await runner.t.run((ctx) => ctx.db.patch("ai_chat_bash_invocations", done._id, { result: undefined }));

			// The placeholder watchdog settles a job that never ran as timed out, with no result. Move the
			// job's deadline into the past instead of faking the clock. A fake clock 10 minutes ahead
			// makes the job-finish work that the settle schedules treat the chat run as expired, and
			// that work runs on a real timer, so it can end the run between two calls of this test.
			const queued = await job_row(runner, 2);
			const deadlineAt = Date.now() - 1;
			await runner.t.run((ctx) => ctx.db.patch("ai_chat_bash_invocations", queued._id, { deadlineAt }));
			await runner.t.mutation(internal.ai_chat_files.timeout_bash_job, {
				invocationId: queued._id,
				expectedDeadlineAt: deadlineAt,
			});
			expect(await activity_of(runner, 2)).toMatchObject({ status: "timed_out" });

			expect((await runner.run({ command: "wait 1" })).metadata.exitCode).toBe(0);
			expect((await runner.run({ command: "wait 1 2" })).metadata.exitCode).toBe(124);
		});

		test("drops /tmp writes at job end and names them; /shells is mounted inside the job", async () => {
			const runner = await create_bash_runner();
			const script = "{ echo x > /tmp/j.txt; ls /shells; tail -n 1 /shells/default/transcript; }";
			expect((await runner.run({ command: `${script} &` })).metadata.exitCode).toBe(0);
			const finished = await run_job(runner, 1);
			// The transcript's last line is the launching call's own stderr, saved before the job ran.
			expect(finished.result?.stdout).toBe(
				"default\nbash: started job 1 in shell default. Follow it with `jobs`, or in the Notifications panel.\n",
			);
			expect(finished.result?.stderr).toBe("bash: /tmp writes are dropped when a job ends: /tmp/j.txt\n");
			expect((await runner.run({ command: "ls /tmp" })).stdout).not.toContain("j.txt");
		});

		test("cp inside a job hides its transfer from the feed and cp && cat waits for the copy", async () => {
			const runner = await create_bash_runner();
			expect(
				(await runner.run({ command: "cp docs/readme.md docs/copy.md && cat docs/copy.md &" })).metadata.exitCode,
			).toBe(0);
			const finished = await run_job(runner, 1);
			expect(finished.result?.metadata.exitCode, finished.result?.stderr).toBe(0);
			expect(finished.result?.stdout).toContain("Transfer ");
			// The copy is re-serialized markdown, so compare the body lines, not the exact bytes.
			expect(finished.result?.stdout).toContain("unique-token here\nmore unique-token below");
			const activities = await runner.t.run((ctx) => ctx.db.query("activities").collect());
			expect(activities.map((activity) => [activity.source.kind, activity.feedVisible])).toEqual(
				expect.arrayContaining([
					["ai_chat_bash_job", true],
					["files_transfer_run", false],
				]),
			);
		});

		test("which knows jobs and kill but not wait", async () => {
			const runner = await create_bash_runner();
			const known = await runner.run({ command: "which jobs; which kill" });
			expect(known.metadata.exitCode, known.stderr).toBe(0);
			expect(known.stdout).toBe("/usr/bin/jobs\n/usr/bin/kill\n");
			expect((await runner.run({ command: "which wait" })).metadata.exitCode).not.toBe(0);
		});

		test("which knows browser only in a chat call that may browse", async () => {
			const runner = await create_bash_runner();
			expect((await runner.run({ command: "which browser" })).metadata.exitCode).not.toBe(0);

			const thread = await runner.t.run((ctx) => ctx.db.get("ai_chat_threads", runner.threadId));
			const result = await bash_run_command(runner.ctx, {
				...runner.ctxData,
				toolCallId: "which-browser",
				command: "which browser",
				allowDbFilesMkdir: true,
				shellName: "default",
				wakeAgent: null,
				output: null,
				run: runner.chatRun,
				browserIntent: { policyRevision: 0 },
				sourceMessageId: thread!.newestNodeId!,
			});
			expect(result.stdout, result.stderr).toBe("/usr/bin/browser\n");
		});

		test("a job from a call that may browse gets browser only while that run runs", async () => {
			const runner = await create_bash_runner();
			const thread = await runner.t.run((ctx) => ctx.db.get("ai_chat_threads", runner.threadId));
			const launched = await bash_run_command(runner.ctx, {
				...runner.ctxData,
				toolCallId: "browser-jobs",
				command: "which browser & browser open &",
				allowDbFilesMkdir: true,
				shellName: "default",
				wakeAgent: null,
				output: null,
				run: runner.chatRun,
				browserIntent: { policyRevision: 0 },
				sourceMessageId: thread!.newestNodeId!,
			});
			expect(launched.metadata.launchedJobNumbers, launched.stderr).toEqual([1, 2]);
			expect((await job_row(runner, 1)).job?.browserRun).toEqual(runner.chatRun);
			expect((await run_job(runner, 1)).result?.stdout).toBe("/usr/bin/browser\n");

			// The chat run ends while job 2 still waits in the pool.
			await runner.t.run((ctx) => ctx.db.patch("ai_chat_runs", runner.chatRun.runId, { status: "ended" }));
			const finished = await run_job(runner, 2);
			expect(finished.result?.metadata.exitCode).toBe(1);
			expect(finished.result?.stderr).toBe(
				"browser: the chat turn was stopped or has ended. This command did not run.\nCause: stopped: Stopped. This call was not run.\n",
			);
		});
	});
});
