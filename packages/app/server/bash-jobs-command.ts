import type { Doc, Id } from "../convex/_generated/dataModel.js";
import type { ActionCtx } from "../convex/_generated/server.js";
import { defineCommand, type Command } from "just-bash/browser";
import { internal } from "../convex/_generated/api.js";
import type {
	ai_chat_files_list_thread_jobs_Result,
	ai_chat_files_read_job_output_Result,
} from "../convex/ai_chat_files.ts";
import { activities_is_active } from "../convex/activities_db.ts";
import {
	bash_COMMAND_EXIT_FAILURE,
	bash_COMMAND_EXIT_STILL_RUNNING,
	bash_COMMAND_EXIT_STOPPED,
	bash_COMMAND_EXIT_TIMED_OUT,
	bash_COMMAND_EXIT_USAGE,
	bash_JOB_NUMBERS_MAX_COUNT,
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
	 * Refused launches so far; after 3 the hook refuses locally without a database round trip.
	 */
	launchAttempts: number;
	/**
	 * Bytes `jobs -o` may still print in this call; starts at 64 KiB.
	 */
	readBudgetRemaining: number;
};

export const bash_JOB_OUTPUT_READ_BUDGET_BYTES = 64 * 1024;
const JOB_OUTPUT_READ_MAX_BYTES = 32 * 1024;
const WAIT_DEFAULT_MS = 30_000;
const WAIT_POLL_MS = 2_000;

const JOBS_USAGE = "Usage: jobs [-a] | jobs -o JOB\n";
const WAIT_USAGE = "Usage: wait [-t SECONDS] [JOB...]\n";
const KILL_USAGE = "Usage: kill [-s SIGNAL | -SIGNAL] JOB...\n";
const JOB_NUMBER_REGEX = /^%?(\d+)$/u;

/**
 * The status word `jobs`, `jobs -a` and the finished-job note print for an Activity status.
 * A job never waits for input and never ends `partial`; those two map to their nearest word.
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

/**
 * The exit code `wait` and `jobs -o` report for one job. The Activity decides a job that was
 * declared dead: a watchdog or a Stop can settle the Activity while a slow worker is still
 * finishing, and the worker then stores its own result under a `timed_out` or `canceled` Activity.
 * The feed, `jobs -a` and the finished-job note all show that Activity status, so these two
 * commands must agree with them instead of reporting the late result's code. Every other job reads
 * its stored result, and a finished row without one (a crashed worker, or a result the cron already
 * stripped) falls back to the Activity too.
 */
function job_exit_code(output: ai_chat_files_read_job_output_Result) {
	if (!output) return bash_COMMAND_EXIT_FAILURE;
	if (output.activityStatus === "timed_out") return bash_COMMAND_EXIT_TIMED_OUT;
	if (output.activityStatus === "canceled") return bash_COMMAND_EXIT_STOPPED;
	if (output.result) return output.result.metadata.exitCode;
	switch (output.activityStatus) {
		case "succeeded":
			return 0;
		default:
			return bash_COMMAND_EXIT_FAILURE;
	}
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
 * `jobs -o N`: the stored stdout, then stderr, each with a `[truncated]` line when it is cut.
 * The transcript keeps the full output; this read is bounded so two big reads cannot push the
 * reading call over its own output limit.
 */
async function print_job_output(ctx: ActionCtx, job: bash_JobContext, jobNumber: number) {
	const output = (await ctx.runQuery(internal.ai_chat_files.read_job_output, {
		...job_scope(job),
		jobNumber,
	})) as ai_chat_files_read_job_output_Result;
	if (!output) return { stdout: "", stderr: `bash: jobs: no such job ${jobNumber}\n`, exitCode: bash_COMMAND_EXIT_FAILURE };
	if (output.status === "running") return { stdout: "", stderr: "", exitCode: bash_COMMAND_EXIT_STILL_RUNNING };
	if (!output.result)
		return {
			stdout: "",
			stderr: `bash: jobs: no stored output for job ${jobNumber}; read the shell transcript\n`,
			exitCode: bash_COMMAND_EXIT_FAILURE,
		};
	if (job.readBudgetRemaining < JOB_OUTPUT_READ_MAX_BYTES)
		return {
			stdout: "",
			stderr: "bash: jobs: this call already read its 64 KiB of job output; read the shell transcript\n",
			exitCode: bash_COMMAND_EXIT_FAILURE,
		};
	job.readBudgetRemaining -= JOB_OUTPUT_READ_MAX_BYTES;

	const bounded = (text: string, truncated: boolean) => {
		const cut = text.length > JOB_OUTPUT_READ_MAX_BYTES;
		const kept = cut ? text.slice(0, JOB_OUTPUT_READ_MAX_BYTES) : text;
		if (!truncated && !cut) return kept;
		return `${kept}${kept.endsWith("\n") || kept === "" ? "" : "\n"}[truncated]\n`;
	};
	const { result } = output;
	return {
		stdout: bounded(result.stdout, result.metadata.stdoutTruncated),
		stderr: `${bounded(result.stderr, result.metadata.stderrTruncated)}[job ${jobNumber} exit ${result.metadata.exitCode}]\n`,
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
		const wanted = [...new Set(jobNumbers.length > 0 ? jobNumbers : job.launchedJobNumbers)];
		if (wanted.length === 0) return { stdout: "", stderr: "", exitCode: 0 };
		if (wanted.length > bash_JOB_NUMBERS_MAX_COUNT)
			return usage_error(`wait: at most ${bash_JOB_NUMBERS_MAX_COUNT} job numbers can be waited at once`, WAIT_USAGE);

		const scope = job_scope(job);
		const list = async () =>
			(await ctx.runQuery(internal.ai_chat_files.list_thread_jobs, {
				...scope,
				select: { kind: "numbers", jobNumbers: wanted },
			})) as ai_chat_files_list_thread_jobs_Result;
		let found = await list();
		// Another member's job or a deleted row resolves to nothing: say so, never poll it.
		const missing = wanted.filter((jobNumber) => !found.some((summary) => summary.jobNumber === jobNumber));
		if (missing.length > 0)
			return {
				stdout: "",
				stderr: missing.map((jobNumber) => `bash: wait: ${jobNumber}: no such job\n`).join(""),
				exitCode: bash_COMMAND_EXIT_FAILURE,
			};

		const until = Math.min(Date.now() + timeoutMs, job.deadlineAt);
		const is_live = () => found.some((summary) => activities_is_active(summary.status));
		while (is_live() && !job.signal.aborted && Date.now() < until) {
			await sleep(Math.min(WAIT_POLL_MS, until - Date.now()), job.signal);
			if (job.signal.aborted || Date.now() >= until) break;
			found = await list();
		}
		if (is_live()) return { stdout: "", stderr: "", exitCode: bash_COMMAND_EXIT_STILL_RUNNING };

		let worst = 0;
		for (const summary of found) {
			const output = (await ctx.runQuery(internal.ai_chat_files.read_job_output, {
				...scope,
				jobNumber: summary.jobNumber,
			})) as ai_chat_files_read_job_output_Result;
			worst = Math.max(worst, job_exit_code(output));
		}
		return { stdout: "", stderr: "", exitCode: worst };
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
