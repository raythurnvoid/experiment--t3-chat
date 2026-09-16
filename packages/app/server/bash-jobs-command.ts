import type { Doc, Id } from "../convex/_generated/dataModel.js";
import type { ActionCtx } from "../convex/_generated/server.js";
import { defineCommand, type Command } from "just-bash/browser";
import { internal } from "../convex/_generated/api.js";
import type {
	ai_chat_files_list_thread_jobs_Result,
	ai_chat_files_read_job_exit_codes_Result,
	ai_chat_files_read_job_output_Result,
} from "../convex/ai_chat_files.ts";
import { activities_is_active } from "../convex/activities_db.ts";
import type { ai_chat_ModelId } from "../shared/ai-chat.ts";
import {
	bash_COMMAND_EXIT_FAILURE,
	bash_COMMAND_EXIT_STILL_RUNNING,
	bash_COMMAND_EXIT_USAGE,
	bash_JOB_NUMBERS_MAX_COUNT,
	bash_job_exit_code,
	bash_text_head,
} from "./bash-utils.ts";

/**
 * What the `&` hook and the `jobs`, `wait` and `kill` commands know about the call they run in.
 * The call is a foreground chat call or a job worker (a job may start jobs too).
 */
export type bash_JobContext = {
	/**
	 * The caller's own row: a call or a job.
	 */
	invocationId: Id<"ai_chat_bash_invocations">;
	organizationId: Id<"organizations">;
	workspaceId: Id<"organizations_workspaces">;
	threadId: Id<"ai_chat_threads">;
	userId: Id<"users">;
	membershipId: Id<"organizations_workspaces_users">;
	shellId: Id<"ai_chat_bash_shells">;
	shellName: string;
	allowDbFilesMkdir: boolean;
	/**
	 * The call's `transferDeadlineAt`; `wait` never waits past it.
	 */
	deadlineAt: number;
	signal: AbortSignal;
	/**
	 * The per-call command counter shared with transfer receipts; a launch takes one number for
	 * its synthetic `toolCallId`.
	 */
	nextCommandNumber: () => number;
	/**
	 * Jobs this call started, for `wait` with no arguments.
	 */
	launchedJobNumbers: number[];
	/**
	 * Launches refused in a row; after 3 the hook refuses locally without a database round trip.
	 * Every refusal counts, not only the jobs-cap refusal, because each refused launch still
	 * costs a door query and `&` is free. Two things put the count back to 0: a launch that
	 * succeeds, and a `wait` that found a job live and then saw it end. The wait does not look
	 * at why the launches were refused. A script can hit the cap, `wait` for those jobs, and
	 * start more. A script, state or stopping refusal still fails at the door every time. So
	 * this count stops a flat run of `&` from asking the door once per statement, not the
	 * refusals of a whole call. A successful launch resets it too, so a call can ask the door
	 * many times inside its 90 seconds. If neither reset existed the count could never come
	 * down, since the local refusal returns before the query whose success would clear it. A
	 * `wait` for jobs that had already ended resets nothing, so a loop of `cmd & wait 1` cannot
	 * use it to keep asking the door. The jobs of another chat cannot be waited on at all, so a
	 * call blocked by those keeps the block until it ends. There is a third reset: every run of
	 * a job starts a fresh context with this count at 0, so a `&` followed by a bare `sleep 5`
	 * inside a job clears the block at each pause.
	 */
	launchRefusals: number;
	/**
	 * How much of the `jobs -o` read budget is left in this call, in UTF-16 code units so it can be
	 * compared with one page. It starts at two pages, and every read costs a whole page whatever it
	 * prints.
	 */
	readBudgetRemaining: number;
	/**
	 * Set when the chat call asked to be woken when its jobs end (the tool's `wakeOnJobFinish`):
	 * the model the wakeup runs with. A job worker never has it, so a job a job started never
	 * wakes the agent.
	 */
	wakeAgent: { modelId: ai_chat_ModelId } | null;
	/**
	 * The jobs `wait` stopped polling for because their finish wakes the agent. The call ends
	 * its turn when this is not empty.
	 */
	waitingJobNumbers: number[];
};

export const bash_JOB_OUTPUT_READ_BUDGET_CHARS = 64 * 1024;
/**
 * One `jobs -o` page per stream, counted in UTF-16 code units. The worker keeps this much of a
 * running job's output head, so a live read and a finished read are cut at the same place. One read
 * can print one page on each stream, so the two reads the budget allows fill half of the 128k a call
 * may print on a stream.
 */
export const bash_JOB_OUTPUT_READ_MAX_CHARS = 32 * 1024;
const WAIT_DEFAULT_MS = 30_000;
const WAIT_POLL_MS = 2_000;

const JOBS_USAGE = "Usage: jobs [-a] | jobs -o JOB\n";
const WAIT_USAGE = "Usage: wait [-t SECONDS] [JOB...]\n";
const KILL_USAGE = "Usage: kill [-s SIGNAL | -SIGNAL] JOB...\n";
const JOB_NUMBER_REGEX = /^%?(\d+)$/u;

/**
 * The status word `jobs`, `jobs -a`, `jobs -o` and the finished-job note print for an Activity
 * status. A job never waits for input and never ends `partial`; those two map to their nearest
 * word.
 */
export function bash_job_status_word(status: Doc<"activities">["status"]) {
	return {
		queued: "queued",
		running: "running",
		awaiting_input: "running",
		stopping: "stopping",
		succeeded: "done",
		partial: "done",
		failed: "failed",
		timed_out: "timed out",
		canceled: "stopped",
	}[status];
}

function parse_job_number(arg: string | undefined) {
	const match = arg === undefined ? null : JOB_NUMBER_REGEX.exec(arg);
	return match ? Number(match[1]) : null;
}

function usage_error(text: string, usage: string) {
	return { stdout: "", stderr: `${text}\n${usage}`, exitCode: bash_COMMAND_EXIT_USAGE };
}

/**
 * Sleep that ends early when the call is aborted, like the engine's `sleep`.
 */
function sleep(ms: number, signal: AbortSignal) {
	return new Promise<void>((resolve) => {
		if (signal.aborted) return resolve();
		const done = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal.addEventListener("abort", done, { once: true });
	});
}

function job_scope(job: bash_JobContext) {
	return {
		organizationId: job.organizationId,
		workspaceId: job.workspaceId,
		userId: job.userId,
		threadId: job.threadId,
	};
}

function job_line(summary: ai_chat_files_list_thread_jobs_Result[number]) {
	const parent = summary.parentJobNumber === null ? "" : `   (from job ${summary.parentJobNumber})`;
	// A shell name can be 32 characters, so `padEnd` alone would add no space at all and the name
	// would run into the script. Pad the columns, then always separate them with one space.
	const status = bash_job_status_word(summary.status).padEnd(9);
	const shell = summary.shellName.padEnd(8);
	return `[${summary.jobNumber}] ${status} ${shell} ${summary.scriptPreview}${parent}\n`;
}

/**
 * `jobs -o N`: the stored stdout, then stderr, each with a `[truncated]` line when it is cut, then a
 * marker with the exit code `wait` reports for the same job. While the job runs it prints the head
 * the worker flushed so far, then a status marker, and still exits 3; a paused job reads `queued` in
 * that marker. The transcript keeps the full output; this read is bounded so two big reads cannot
 * push the reading call over its own output limit.
 */
async function print_job_output(ctx: ActionCtx, job: bash_JobContext, jobNumber: number) {
	const output = (await ctx.runQuery(internal.ai_chat_files.read_job_output, {
		...job_scope(job),
		jobNumber,
	})) as ai_chat_files_read_job_output_Result;
	if (!output)
		return { stdout: "", stderr: `bash: jobs: no such job ${jobNumber}\n`, exitCode: bash_COMMAND_EXIT_FAILURE };
	// `jobs`, `jobs -a` and the finished-job note all print the Activity status, so this marker must
	// read it too. Otherwise a paused job would say running here while `jobs` calls it queued.
	const liveMarker = `[job ${jobNumber} ${bash_job_status_word(output.activityStatus)}]\n`;
	// A live job that flushed nothing yet gets the marker alone: it names the job and says the job is
	// not done. That line costs no read budget. Liveness is the Activity's, like the word above and
	// like `jobs` and `wait`. The invocation row calls itself interrupted the moment its deadline
	// passes, and the Activity can still be active then: a `kill` cancels the watchdog, so the settle
	// is left to the worker or to the five-minute recovery cron. Reading the row instead would call a
	// running job ended and throw away the head it printed a moment ago.
	if (!output.result && activities_is_active(output.activityStatus) && !output.liveOutput)
		return { stdout: "", stderr: liveMarker, exitCode: bash_COMMAND_EXIT_STILL_RUNNING };
	// A job settled by the watchdog or stopped while it waited stores no result. Name the outcome the
	// Activity already carries, so the model learns why the job ended without another call.
	if (!output.result && !activities_is_active(output.activityStatus))
		return {
			stdout: "",
			stderr: `bash: jobs: job ${jobNumber} ${bash_job_status_word(output.activityStatus)} and stored no output; read the shell transcript\n`,
			exitCode: bash_COMMAND_EXIT_FAILURE,
		};
	// Every read costs the same, so the budget is two reads per call whatever they print. Say that, not
	// the character total: after two short reads the call has printed a few characters, not two pages.
	if (job.readBudgetRemaining < bash_JOB_OUTPUT_READ_MAX_CHARS)
		return {
			stdout: "",
			stderr: "bash: jobs: this call already read job output twice; read the shell transcript\n",
			exitCode: bash_COMMAND_EXIT_FAILURE,
		};
	job.readBudgetRemaining -= bash_JOB_OUTPUT_READ_MAX_CHARS;

	const bounded = (text: string, truncated: boolean) => {
		const cut = text.length > bash_JOB_OUTPUT_READ_MAX_CHARS;
		const kept = cut ? bash_text_head(text, bash_JOB_OUTPUT_READ_MAX_CHARS) : text;
		if (!truncated && !cut) return kept;
		return `${kept}${kept.endsWith("\n") || kept === "" ? "" : "\n"}[truncated]\n`;
	};
	if (!output.result && output.liveOutput) {
		const live = output.liveOutput;
		return {
			stdout: bounded(live.stdout, live.stdoutTruncated),
			stderr: `${bounded(live.stderr, live.stderrTruncated)}${liveMarker}`,
			exitCode: bash_COMMAND_EXIT_STILL_RUNNING,
		};
	}
	const result = output.result!;
	// The Activity decides the code, like `wait` and the status word above. The finished-job note
	// prints that status word, not this code. A job settled as timed out or stopped can still store
	// the code of a script that finished on its own, and a stored 0 printed here would say the job
	// succeeded while every other surface says it did not.
	const exitCode = bash_job_exit_code(output.activityStatus, result.metadata.exitCode);
	return {
		stdout: bounded(result.stdout, result.metadata.stdoutTruncated),
		stderr: `${bounded(result.stderr, result.metadata.stderrTruncated)}[job ${jobNumber} exit ${exitCode}]\n`,
		exitCode: 0,
	};
}

/**
 * `jobs` lists the live jobs of this thread, `jobs -a` the newest 8, `jobs -o N` a stored
 * output. Rows come from Activity rows, never from the invocation rows. Exit 3 while a listed
 * job is live.
 */
export function bash_jobs_command_create(ctx: ActionCtx, job: bash_JobContext): Command {
	return defineCommand("jobs", async (args) => {
		let all = false;
		let outputOf: number | null = null;
		for (let index = 0; index < args.length; index++) {
			const arg = args[index]!;
			if (arg === "--help") return { stdout: JOBS_USAGE, stderr: "", exitCode: 0 };
			if (arg === "-a") {
				all = true;
				continue;
			}
			if (arg === "-o") {
				index += 1;
				outputOf = parse_job_number(args[index]);
				if (outputOf === null) return usage_error("jobs: -o needs a job number", JOBS_USAGE);
				continue;
			}
			return usage_error(`jobs: unsupported argument ${arg}`, JOBS_USAGE);
		}
		if (outputOf !== null) return await print_job_output(ctx, job, outputOf);

		const jobs = (await ctx.runQuery(internal.ai_chat_files.list_thread_jobs, {
			...job_scope(job),
			select: { kind: all ? "newest" : "live" },
		})) as ai_chat_files_list_thread_jobs_Result;
		const newestFirst = [...jobs].sort((a, b) => b.jobNumber - a.jobNumber);
		return {
			stdout: newestFirst.map(job_line).join(""),
			stderr: "",
			exitCode: jobs.some((summary) => activities_is_active(summary.status)) ? bash_COMMAND_EXIT_STILL_RUNNING : 0,
		};
	});
}

/**
 * `wait` polls the jobs this call started, or the named jobs of this user in the thread, every
 * 2 seconds. It stops at 30 seconds (`-t` changes that) or at the call's own deadline, and
 * returns 3 while a job is still live. With an 8-minute job budget that is the usual answer.
 * A call that will be woken (`wakeOnJobFinish`) does not poll: it arms the live jobs so their
 * finish wakes the agent, says so and returns 3; the tool then ends the turn.
 */
export function bash_wait_command_create(ctx: ActionCtx, job: bash_JobContext): Command {
	return defineCommand("wait", async (args) => {
		let timeoutMs = WAIT_DEFAULT_MS;
		const jobNumbers: number[] = [];
		for (let index = 0; index < args.length; index++) {
			const arg = args[index]!;
			if (arg === "--help") return { stdout: WAIT_USAGE, stderr: "", exitCode: 0 };
			if (arg === "-t") {
				index += 1;
				const seconds = Number(args[index]);
				if (!(seconds > 0)) return usage_error("wait: -t needs a number of seconds", WAIT_USAGE);
				timeoutMs = seconds * 1000;
				continue;
			}
			const jobNumber = parse_job_number(arg);
			if (jobNumber === null) return usage_error(`wait: ${arg}: arguments must be job numbers`, WAIT_USAGE);
			jobNumbers.push(jobNumber);
		}
		// The door reads one index row per number, so drop repeats and refuse a long list here
		// instead of sending it. `wait {1..5000}` expands to 5000 words.
		const named = jobNumbers.length > 0;
		const unique = [...new Set(named ? jobNumbers : job.launchedJobNumbers)];
		if (unique.length === 0) return { stdout: "", stderr: "", exitCode: 0 };
		if (named && unique.length > bash_JOB_NUMBERS_MAX_COUNT)
			return usage_error(`wait: at most ${bash_JOB_NUMBERS_MAX_COUNT} job numbers can be waited at once`, WAIT_USAGE);
		// A bare `wait` named nothing, so it takes the newest numbers instead of failing. A job that
		// ran several statements, across pauses, can have started more jobs than one `wait` may name.
		const wanted = named ? unique : unique.slice(-bash_JOB_NUMBERS_MAX_COUNT);

		const scope = job_scope(job);
		const list = async () =>
			(await ctx.runQuery(internal.ai_chat_files.list_thread_jobs, {
				...scope,
				select: { kind: "numbers", jobNumbers: wanted },
			})) as ai_chat_files_list_thread_jobs_Result;
		let found = await list();
		// Another member's job or a deleted row resolves to nothing: say so, never poll it. One bad
		// number refuses the whole list, because one exit code cannot say two things at once: 3 tells
		// the model to wait again, 1 tells it one of the numbers is not its job. The lines below name
		// every missing number, so a next call can leave out the ones it named itself. A bare `wait`
		// named none of them, so there the lines only say which of its own jobs are already gone.
		const missing = wanted.filter((jobNumber) => !found.some((summary) => summary.jobNumber === jobNumber));
		if (missing.length > 0)
			return {
				stdout: "",
				stderr: missing.map((jobNumber) => `bash: wait: ${jobNumber}: no such job\n`).join(""),
				exitCode: bash_COMMAND_EXIT_FAILURE,
			};

		const is_live = () => found.some((summary) => activities_is_active(summary.status));
		// Whether this wait has a slot to free at all. A job that had already ended when the wait
		// started frees nothing: its slot was free while the launches were refused.
		const waitedOnLive = is_live();
		if (job.wakeAgent !== null && is_live()) {
			const armed = await ctx.runMutation(internal.ai_chat_files.arm_bash_job_wakeup, {
				...scope,
				jobNumbers: found.filter((summary) => activities_is_active(summary.status)).map((summary) => summary.jobNumber),
				modelId: job.wakeAgent.modelId,
			});
			if (armed.length > 0) {
				job.waitingJobNumbers.push(...armed);
				return {
					stdout: "",
					stderr: `bash: waiting for job ${armed.join(", ")}: end this turn. The finish then starts your next run, or leaves its result in the shell transcript.\n`,
					exitCode: bash_COMMAND_EXIT_STILL_RUNNING,
				};
			}
			// Every live job ended between the two reads: read the results the normal way.
			found = await list();
		}

		const until = Math.min(Date.now() + timeoutMs, job.deadlineAt);
		while (is_live() && !job.signal.aborted && Date.now() < until) {
			await sleep(Math.min(WAIT_POLL_MS, until - Date.now()), job.signal);
			if (job.signal.aborted || Date.now() >= until) break;
			found = await list();
		}
		if (is_live()) return { stdout: "", stderr: "", exitCode: bash_COMMAND_EXIT_STILL_RUNNING };

		// A job this wait found live has ended, so start the local count again. Let the next `&`
		// ask the door again even when three launches in a row were refused before this wait. The
		// wait does not look at why those launches were refused. A wait for jobs that had already
		// ended resets nothing, and neither does one that gave up with a job still live or waited
		// for nothing. `&` costs no command budget in the engine, so this count is what stops a
		// flat run of `&` from asking the door once per statement.
		if (waitedOnLive) job.launchRefusals = 0;
		// Ask for the numbers this wait started with, not the last list. A purge can empty
		// `found` after the first list passed, and `Math.max(0, ...[])` would then report
		// success. `read_job_exit_codes` already answers 1 for a number it cannot resolve.
		const codes = (await ctx.runQuery(internal.ai_chat_files.read_job_exit_codes, {
			...scope,
			jobNumbers: wanted,
		})) as ai_chat_files_read_job_exit_codes_Result;
		return { stdout: "", stderr: "", exitCode: Math.max(0, ...codes.map((code) => code.exitCode)) };
	});
}

/**
 * `kill N` asks a job of this user in this thread to stop. A stop is always cooperative, so a
 * signal option is accepted and ignored. It never ends the call.
 */
export function bash_kill_command_create(ctx: ActionCtx, job: bash_JobContext): Command {
	return defineCommand("kill", async (args) => {
		const jobNumbers: number[] = [];
		for (let index = 0; index < args.length; index++) {
			const arg = args[index]!;
			if (arg === "--help") return { stdout: KILL_USAGE, stderr: "", exitCode: 0 };
			if (arg === "-s") {
				index += 1;
				continue;
			}
			if (arg.startsWith("-")) continue;
			const jobNumber = parse_job_number(arg);
			if (jobNumber === null) return usage_error(`kill: ${arg}: arguments must be job numbers`, KILL_USAGE);
			jobNumbers.push(jobNumber);
		}
		if (jobNumbers.length === 0) return usage_error("kill: missing job number", KILL_USAGE);

		let stderr = "";
		let exitCode = 0;
		for (const jobNumber of jobNumbers) {
			const stopped = (await ctx.runMutation(internal.ai_chat_files.request_bash_job_stop, {
				...job_scope(job),
				jobNumber,
			})) as boolean;
			if (stopped) {
				stderr += `bash: kill: stop requested for job ${jobNumber}\n`;
			} else {
				stderr += `bash: kill: no such job ${jobNumber}\n`;
				exitCode = bash_COMMAND_EXIT_FAILURE;
			}
		}
		return { stdout: "", stderr, exitCode };
	});
}
