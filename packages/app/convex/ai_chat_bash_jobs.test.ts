import { Workpool, type WorkId } from "@convex-dev/workpool";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, components, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import { activities_db_start } from "./activities_db.ts";
import { ai_chat_files_db_append_shell_transcript, ai_chat_files_db_delete_job_batch } from "./ai_chat_files.ts";
import { bash_JOB_NUMBERS_MAX_COUNT } from "../server/bash-utils.ts";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

const PLACEHOLDER_MS = 10 * 60 * 1000;
const RUN_MS = 8 * 60 * 1000;

// The pool item never runs here: the fake timers never fire it. It only gives a real work id.
const pool = new Workpool(components.ai_chat_bash_jobs_workpool, { retryActionsByDefault: false });

/**
 * The snapshot of a shell that ran nothing yet.
 */
const empty_shell_state = {
	env: [],
	arrays: [],
	options: {},
	shoptOptions: {},
	readonlyVars: [],
	associativeArrays: [],
	namerefs: [],
	boundNamerefs: [],
	invalidNamerefs: [],
	integerVars: [],
	lowercaseVars: [],
	uppercaseVars: [],
	exportedVars: [],
	declaredVars: [],
	functions: [],
	previousDir: "/",
	directoryStack: [],
	lastExitCode: 0,
	lastArg: "",
	openFileDescriptors: [],
};

/**
 * A workspace, a thread and one foreground Bash call whose shell the jobs run in. `seed_job`
 * inserts what `start_bash_job` inserts, without the pool item: the job row, its Activity, the
 * placeholder watchdog and the start transcript entry.
 */
async function fixture() {
	const t = test_convex();
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const thread = await asUser.mutation(api.ai_chat.thread_create, {
		membershipId: db.membershipId,
		clientGeneratedId: "bash-jobs-thread",
		lastMessageAt: Date.now(),
	});
	if (thread._nay) throw new Error(thread._nay.message);
	const scope = {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: db.userId,
		threadId: thread._yay.threadId,
	};
	const begun = await t.mutation(internal.ai_chat_files.begin_bash_invocation, {
		...scope,
		toolCallId: "parent-call",
		commandHash: "a".repeat(64),
		shellName: "default",
	});
	if (begun._nay || !("shell" in begun._yay)) throw new Error("Expected a fresh call with its shell");
	const shell = begun._yay.shell;
	const parent = await t.run((ctx) => ctx.db.get("ai_chat_bash_invocations", begun._yay.invocationId));
	if (!parent) throw new Error("Expected the parent call row");

	const seed_job = async (args: {
		jobNumber: number;
		status?: "queued" | "running";
		script?: string;
		workId?: WorkId | null;
		stopRequestedAt?: number;
		parentJobNumber?: number;
		allowDbFilesMkdir?: boolean;
		wakeAgent?: { modelId: "gpt-5.4-nano" };
	}) =>
		await t.run(async (ctx) => {
			const now = Date.now();
			const script = args.script ?? `sleep ${args.jobNumber}`;
			const invocationId = await ctx.db.insert("ai_chat_bash_invocations", {
				...scope,
				toolCallId: `job:${parent._id}:${args.jobNumber}`,
				commandHash: "b".repeat(64),
				membershipId: parent.membershipId,
				membershipLifetime: parent.membershipLifetime,
				status: "running",
				deadlineAt: now + PLACEHOLDER_MS,
				transferDeadlineAt: now + PLACEHOLDER_MS,
				job: {
					jobNumber: args.jobNumber,
					shellId: shell._id,
					parentInvocationId: parent._id,
					commandNumber: args.jobNumber,
					script,
					startCwd: "/",
					startCwdTarget: null,
					shellState: null,
					allowDbFilesMkdir: args.allowDbFilesMkdir ?? false,
					workId:
						args.workId === undefined
							? await pool.enqueueMutation(ctx, internal.ai_chat_files.cleanup_expired_bash_results, {})
							: args.workId,
					watchdogId: null,
					stopRequestedAt: args.stopRequestedAt ?? null,
					wakeAgent: args.wakeAgent,
				},
			});
			const watchdogId = await ctx.scheduler.runAt(now + PLACEHOLDER_MS, internal.ai_chat_files.timeout_bash_job, {
				invocationId,
				expectedDeadlineAt: now + PLACEHOLDER_MS,
			});
			await ctx.db.patch("ai_chat_bash_invocations", invocationId, {
				job: { ...(await ctx.db.get("ai_chat_bash_invocations", invocationId))!.job!, watchdogId },
			});
			const activityId = await activities_db_start(ctx, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				membershipId: parent.membershipId,
				membershipLifetime: parent.membershipLifetime,
				source: {
					kind: "ai_chat_bash_job",
					id: invocationId,
					threadId: scope.threadId,
					jobNumber: args.jobNumber,
					shellName: "default",
					parentJobNumber: args.parentJobNumber ?? null,
					scriptPreview: script.slice(0, 80),
				},
				title: `Background command ${args.jobNumber}`,
				targets: [],
				visibility: "requester",
				feedVisible: true,
				status: args.status ?? "queued",
				resultKind: "bash_result",
				deadlineAt: now + PLACEHOLDER_MS,
				now,
			});
			if (args.stopRequestedAt !== undefined)
				await ctx.db.patch("activities", activityId, { status: "stopping", stopRequestedAt: args.stopRequestedAt });
			const shellDoc = await ctx.db.get("ai_chat_bash_shells", shell._id);
			if (!shellDoc) throw new Error("Expected the shell");
			await ai_chat_files_db_append_shell_transcript(
				ctx,
				shellDoc,
				`[${new Date(now).toISOString()}] job ${args.jobNumber} started in shell default: ${script.slice(0, 80)}`,
			);
			const workId = (await ctx.db.get("ai_chat_bash_invocations", invocationId))!.job!.workId;
			return { invocationId, activityId, watchdogId, workId };
		});

	const read = async (invocationId: Id<"ai_chat_bash_invocations">) =>
		await t.run(async (ctx) => ({
			row: await ctx.db.get("ai_chat_bash_invocations", invocationId),
			activity: await ctx.db
				.query("activities")
				.withIndex("by_source_id", (q) => q.eq("source.id", invocationId))
				.unique(),
			transcript: (
				await ctx.db
					.query("ai_chat_bash_shell_transcripts")
					.withIndex("by_shell_seq", (q) => q.eq("shellId", shell._id))
					.collect()
			).map((entry) => entry.text),
		}));

	const scheduled_state = async (id: Id<"_scheduled_functions">) =>
		await t.run(async (ctx) => (await ctx.db.system.get("_scheduled_functions", id))?.state.kind);

	return { t, db, asUser, scope, parent, shell, seed_job, read, scheduled_state };
}

function job_result(exitCode: number, stdout = "done\n", stderr = "") {
	return {
		title: "job",
		output: stdout + stderr,
		stdout,
		stderr,
		metadata: {
			command: "sleep 1",
			cwd: "/",
			nextCwd: "/",
			exitCode,
			stdoutTruncated: false,
			stderrTruncated: false,
			stdoutLength: stdout.length,
			stderrLength: stderr.length,
			pathIndexTruncated: false,
			observedPaths: [],
			observedPathsTruncated: false,
		},
	};
}

async function add_member(f: Awaited<ReturnType<typeof fixture>>, clerkUserId: string) {
	return await f.t.run(async (ctx) => {
		const userId = await ctx.db.insert("users", { clerkUserId });
		const membershipId = await ctx.db.insert("organizations_workspaces_users", {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			userId,
			active: true,
			updatedAt: Date.now(),
		});
		await access_control_db_ensure_role_assignment(ctx, {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			userId,
			role: "member",
			now: Date.now(),
		});
		return { userId, membershipId };
	});
}

describe("start_bash_job", () => {
	const launch = async (
		f: Awaited<ReturnType<typeof fixture>>,
		overrides: Partial<Parameters<typeof f.t.mutation<typeof internal.ai_chat_files.start_bash_job>>[1]> = {},
	) =>
		await f.t.mutation(internal.ai_chat_files.start_bash_job, {
			parentInvocationId: f.parent._id,
			commandNumber: 0,
			shellId: f.shell._id,
			script: "echo  hi",
			startCwd: "/",
			startCwdTarget: null,
			shellState: empty_shell_state,
			allowDbFilesMkdir: false,
			...overrides,
		});

	const job_rows = async (f: Awaited<ReturnType<typeof fixture>>) =>
		await f.t.run(async (ctx) => (await ctx.db.query("ai_chat_bash_invocations").collect()).filter((row) => row.job));

	test("inserts the row, the queued Activity, the watchdog and the start entry; a replay starts nothing new", async () => {
		const f = await fixture();
		const now = Date.now();
		expect(await launch(f)).toEqual({ _yay: { jobNumber: 1 } });
		const [row] = await job_rows(f);
		if (!row?.job) throw new Error("Expected the job row");
		expect(row).toMatchObject({
			toolCallId: `job:${f.parent._id}:0`,
			membershipId: f.parent.membershipId,
			membershipLifetime: f.parent.membershipLifetime,
			status: "running",
			deadlineAt: now + PLACEHOLDER_MS,
			transferDeadlineAt: now + PLACEHOLDER_MS,
			job: {
				jobNumber: 1,
				shellId: f.shell._id,
				parentInvocationId: f.parent._id,
				commandNumber: 0,
				script: "echo  hi",
				startCwd: "/",
				startCwdTarget: null,
				shellState: empty_shell_state,
				allowDbFilesMkdir: false,
				stopRequestedAt: null,
			},
		});
		expect(row.job.workId).not.toBeNull();
		if (row.job.watchdogId === null) throw new Error("Expected the watchdog");
		expect(await f.scheduled_state(row.job.watchdogId)).toBe("pending");
		const after = await f.read(row._id);
		expect(after.activity).toMatchObject({
			status: "queued",
			feedVisible: true,
			// `requester` keeps a job out of every other member's feed. `activities.list` filters on
			// it, so a drift to `workspace` would show one member's script preview to the workspace.
			visibility: "requester",
			// The card label and the job's `wait` fallback both read this.
			resultKind: "bash_result",
			title: "Background command 1",
			deadlineAt: now + PLACEHOLDER_MS,
			source: {
				kind: "ai_chat_bash_job",
				id: row._id,
				jobNumber: 1,
				shellName: "default",
				parentJobNumber: null,
				scriptPreview: "echo hi",
			},
		});
		expect(after.transcript).toEqual([expect.stringMatching(/^\[[^\]]+\] job 1 started in shell default: echo hi$/)]);

		// A lost reply replays the same command number and finds its row.
		expect(await launch(f)).toEqual({ _yay: { jobNumber: 1 } });
		expect(await job_rows(f)).toHaveLength(1);
		// The next number comes from the thread counter, not from the highest stored row.
		await f.t.run((ctx) => ctx.db.delete("ai_chat_bash_invocations", row._id));
		expect(await launch(f, { commandNumber: 1 })).toEqual({ _yay: { jobNumber: 2 } });
	});

	test("counts live jobs across the workspace, stopping ones too, and refuses the 11th", async () => {
		const f = await fixture();
		for (let n = 1; n <= 9; n += 1) await f.seed_job({ jobNumber: n, status: "running" });
		await f.seed_job({ jobNumber: 10, status: "running", stopRequestedAt: Date.now() });
		const refused = await launch(f);
		expect(refused._nay).toMatchObject({
			name: "limit",
			message:
				"10 jobs are already active across your workspace (queued, running or stopping). Some may be in another chat, where `jobs` and `wait` cannot name them. Wait for one of this chat's jobs, or start more in a later call.",
		});
		expect(await job_rows(f)).toHaveLength(10);
	});

	test("cuts the script preview without splitting a character", async () => {
		const f = await fixture();
		// The preview keeps 80 code units, and a character outside the basic range takes two of them.
		// Here the emoji starts at unit 79, so a plain cut would store half of it and this repo's own
		// write checks call such a string unstorable.
		const emoji = String.fromCodePoint(0x1f389);
		expect(await launch(f, { script: `true ${"a".repeat(74)}${emoji}` })).toEqual({ _yay: { jobNumber: 1 } });
		const [row] = await job_rows(f);
		if (!row) throw new Error("Expected the job row");
		const { activity } = await f.read(row._id);
		expect(activity?.source).toMatchObject({ scriptPreview: `true ${"a".repeat(74)}` });
	});

	test("a job may start a child, but not while it is stopping or after its Activity is gone", async () => {
		const f = await fixture();
		const parent = await f.seed_job({ jobNumber: 1, status: "running" });
		expect(await launch(f, { parentInvocationId: parent.invocationId })).toEqual({ _yay: { jobNumber: 1 } });
		const child = (await job_rows(f)).find((row) => row.job?.parentInvocationId === parent.invocationId);
		if (!child) throw new Error("Expected the child row");
		expect((await f.read(child._id)).activity).toMatchObject({ source: { parentJobNumber: 1 } });

		const stopping = await f.seed_job({ jobNumber: 8, status: "running", stopRequestedAt: Date.now() });
		expect((await launch(f, { parentInvocationId: stopping.invocationId, commandNumber: 1 }))._nay?.message).toBe(
			"the parent job has ended or is stopping",
		);
		const orphan = await f.seed_job({ jobNumber: 9, status: "running" });
		await f.t.run((ctx) => ctx.db.delete("activities", orphan.activityId));
		expect((await launch(f, { parentInvocationId: orphan.invocationId, commandNumber: 2 }))._nay?.message).toBe(
			"the parent job has ended or is stopping",
		);

		// A parent the feed already shows as finished must not start children either: the child
		// would take a live slot and point at a job the user has been told is over.
		const settled = await f.seed_job({ jobNumber: 10, status: "running" });
		await f.t.run((ctx) => ctx.db.patch("activities", settled.activityId, { status: "succeeded" }));
		expect((await launch(f, { parentInvocationId: settled.invocationId, commandNumber: 3 }))._nay?.message).toBe(
			"the parent job has ended or is stopping",
		);
	});

	test("refuses a large script or state, a shell of another thread and a dead membership", async () => {
		const f = await fixture();
		expect((await launch(f, { script: "x".repeat(64 * 1024 + 1) }))._nay?.message).toBe(
			"the job script is larger than 64 KiB",
		);
		expect(
			(
				await launch(f, {
					shellState: { ...empty_shell_state, env: [{ name: "big", value: "x".repeat(128 * 1024) }] },
				})
			)._nay?.message,
		).toBe("the shell state is larger than 128 KiB");
		const otherThread = await f.asUser.mutation(api.ai_chat.thread_create, {
			membershipId: f.db.membershipId,
			clientGeneratedId: "bash-jobs-other-thread",
			lastMessageAt: Date.now(),
		});
		if (otherThread._nay) throw new Error(otherThread._nay.message);
		const otherShell = await f.t.mutation(internal.ai_chat_files.begin_bash_invocation, {
			...f.scope,
			threadId: otherThread._yay.threadId,
			toolCallId: "other-call",
			commandHash: "c".repeat(64),
			shellName: "default",
		});
		if (otherShell._nay || !("shell" in otherShell._yay)) throw new Error("Expected the other shell");
		expect((await launch(f, { shellId: otherShell._yay.shell._id }))._nay?.message).toBe("Unauthorized");
		await f.t.run((ctx) => ctx.db.patch("organizations_workspaces_users", f.db.membershipId, { active: false }));
		expect((await launch(f))._nay?.message).toBe("Unauthorized");
		expect(await job_rows(f)).toHaveLength(0);
	});
});

describe("begin_bash_invocation", () => {
	test("a fresh call after a job finish carries no job fields", async () => {
		const f = await fixture();
		const job = await f.seed_job({ jobNumber: 1, status: "running" });
		await f.t.mutation(internal.ai_chat_files.finish_bash_job, {
			invocationId: job.invocationId,
			result: job_result(0),
		});
		const begun = await f.t.mutation(internal.ai_chat_files.begin_bash_invocation, {
			...f.scope,
			toolCallId: "no-notes",
			commandHash: "d".repeat(64),
			shellName: "default",
		});
		if (begun._nay) throw new Error(begun._nay.message);
		// The finish message in the chat is the only signal now. The call carries nothing.
		expect("notes" in begun._yay).toBe(false);
		expect("noticeAt" in begun._yay).toBe(false);
	});
});

describe("claim_bash_job", () => {
	test("re-arms the three clocks from the worker start, swaps the watchdog and returns the armed row", async () => {
		const f = await fixture();
		const start = Date.now();
		const job = await f.seed_job({ jobNumber: 1 });
		vi.setSystemTime(start + 60_000);
		const claimed = await f.t.mutation(internal.ai_chat_files.claim_bash_job, { invocationId: job.invocationId });
		if (!claimed) throw new Error("Expected the claim");
		const deadlineAt = start + 60_000 + RUN_MS;
		expect(claimed.row).toMatchObject({ deadlineAt, transferDeadlineAt: deadlineAt - 30_000, status: "running" });
		expect(claimed.row.job?.watchdogId).not.toBe(job.watchdogId);
		expect(claimed.organizationName).toBe("test-organization");
		expect(claimed.workspaceName).toBe("test-workspace");
		expect(claimed.shells).toEqual([{ _id: f.shell._id, name: "default" }]);
		const after = await f.read(job.invocationId);
		expect(after.row).toMatchObject({ deadlineAt, transferDeadlineAt: deadlineAt - 30_000 });
		expect(after.row?.job?.watchdogId).toBe(claimed.row.job?.watchdogId);
		expect(after.activity).toMatchObject({ status: "running", startedAt: start + 60_000, deadlineAt });
		expect(await f.scheduled_state(job.watchdogId)).toBe("canceled");
	});

	test("does not revive a stopping job or one with a stop recorded", async () => {
		const f = await fixture();
		const stopping = await f.seed_job({ jobNumber: 1, stopRequestedAt: Date.now() });
		expect(
			await f.t.mutation(internal.ai_chat_files.claim_bash_job, { invocationId: stopping.invocationId }),
		).toBeNull();
		expect((await f.read(stopping.invocationId)).activity).toMatchObject({ status: "stopping" });

		// The flag alone, with the Activity still queued, is also final.
		const flagged = await f.seed_job({ jobNumber: 2, stopRequestedAt: Date.now() });
		await f.t.run((ctx) => ctx.db.patch("activities", flagged.activityId, { status: "queued" }));
		expect(
			await f.t.mutation(internal.ai_chat_files.claim_bash_job, { invocationId: flagged.invocationId }),
		).toBeNull();
		expect((await f.read(flagged.invocationId)).activity).toMatchObject({ status: "queued" });
	});

	test("settles a job whose membership died as canceled instead of leaving it queued", async () => {
		const f = await fixture();
		const job = await f.seed_job({ jobNumber: 1 });
		await f.t.run((ctx) => ctx.db.patch("organizations_workspaces_users", f.db.membershipId, { active: false }));
		expect(await f.t.mutation(internal.ai_chat_files.claim_bash_job, { invocationId: job.invocationId })).toBeNull();
		const after = await f.read(job.invocationId);
		expect(after.row).toMatchObject({ status: "interrupted" });
		expect(after.activity).toMatchObject({ status: "canceled", errorMessage: null });
		expect(after.transcript[1]).toMatch(/^\$ \[[^\]]+\] job 1 finished \(exit 143\) in shell default\nsleep 1\n\n$/);
		expect(await f.scheduled_state(job.watchdogId)).toBe("canceled");
	});

	test("returns null on a missing row", async () => {
		const f = await fixture();
		const job = await f.seed_job({ jobNumber: 1 });
		await f.t.run((ctx) => ctx.db.delete("ai_chat_bash_invocations", job.invocationId));
		expect(await f.t.mutation(internal.ai_chat_files.claim_bash_job, { invocationId: job.invocationId })).toBeNull();
	});
});

describe("flush_bash_job_output", () => {
	const head = { stdout: "partial\n", stderr: "", stdoutTruncated: false, stderrTruncated: false };

	test("stores the head on a running row, refuses a settled one, and the finish drops it", async () => {
		const f = await fixture();
		const job = await f.seed_job({ jobNumber: 1, status: "running" });
		await f.t.mutation(internal.ai_chat_files.flush_bash_job_output, {
			invocationId: job.invocationId,
			workId: job.workId!,
			liveOutput: head,
		});
		expect((await f.read(job.invocationId)).row).toMatchObject({ job: { liveOutput: head } });
		expect(await f.t.query(internal.ai_chat_files.read_job_output, { ...f.scope, jobNumber: 1 })).toMatchObject({
			activityStatus: "running",
			liveOutput: head,
		});

		await f.t.mutation(internal.ai_chat_files.finish_bash_job, {
			invocationId: job.invocationId,
			result: job_result(0),
		});
		const finished = await f.read(job.invocationId);
		expect(finished.row?.job?.liveOutput).toBeUndefined();
		await f.t.mutation(internal.ai_chat_files.flush_bash_job_output, {
			invocationId: job.invocationId,
			workId: job.workId!,
			liveOutput: head,
		});
		expect((await f.read(job.invocationId)).row?.job?.liveOutput).toBeUndefined();
	});

	test("a settle with no result writes the flushed head into the finish entry", async () => {
		const f = await fixture();
		const start = Date.now();
		const job = await f.seed_job({ jobNumber: 1, status: "running" });
		await f.t.mutation(internal.ai_chat_files.flush_bash_job_output, {
			invocationId: job.invocationId,
			workId: job.workId!,
			liveOutput: head,
		});
		vi.setSystemTime(start + PLACEHOLDER_MS);
		await f.t.mutation(internal.ai_chat_files.timeout_bash_job, {
			invocationId: job.invocationId,
			expectedDeadlineAt: start + PLACEHOLDER_MS,
		});
		const after = await f.read(job.invocationId);
		expect(after.row).toMatchObject({ status: "interrupted" });
		expect(after.row?.job?.liveOutput).toBeUndefined();
		expect(after.transcript[1]).toContain("job 1 finished (exit 124)");
		expect(after.transcript[1]?.endsWith("\nsleep 1\npartial\n\n")).toBe(true);
	});
});

describe("pause_bash_job", () => {
	const head = { stdout: "one\n", stderr: "", stdoutTruncated: false, stderrTruncated: false };
	const pause = async (
		f: Awaited<ReturnType<typeof fixture>>,
		invocationId: Id<"ai_chat_bash_invocations">,
		liveOutput: typeof head | null = head,
	) =>
		await f.t.mutation(internal.ai_chat_files.pause_bash_job, {
			invocationId,
			resume: {
				script: "echo two",
				shellState: empty_shell_state,
				cwd: "/docs",
				cwdTarget: null,
				commandNumber: 2,
				launchedJobNumbers: [3],
			},
			liveOutput,
			outcome: { exitCode: 0, stdout: "one\n", stderr: "" },
			reason: "sleep 30s, continues at soon",
			runAfterMs: 30_000,
		});

	test("stores the next run, re-queues the Activity, swaps the pool item and the watchdog, and appends the pause entry", async () => {
		const f = await fixture();
		const start = Date.now();
		const job = await f.seed_job({ jobNumber: 1 });
		vi.setSystemTime(start + 60_000);
		const claimed = await f.t.mutation(internal.ai_chat_files.claim_bash_job, { invocationId: job.invocationId });
		if (!claimed) throw new Error("Expected the claim");
		vi.setSystemTime(start + 90_000);
		expect(await pause(f, job.invocationId)).toBe(true);

		const after = await f.read(job.invocationId);
		const deadlineAt = start + 90_000 + 30_000 + PLACEHOLDER_MS;
		expect(after.row).toMatchObject({
			status: "running",
			deadlineAt,
			transferDeadlineAt: deadlineAt,
			job: {
				script: "sleep 1",
				resumeScript: "echo two",
				// The next run counts its commands and its bare `wait` from where this one stopped.
				resumeCommandNumber: 2,
				resumeLaunchedJobNumbers: [3],
				shellState: empty_shell_state,
				startCwd: "/docs",
				startCwdTarget: null,
				liveOutput: head,
			},
		});
		expect(after.row?.job?.workId).not.toBe(job.workId);
		expect(after.row?.job?.watchdogId).not.toBe(claimed.row.job?.watchdogId);
		expect(await f.scheduled_state(claimed.row.job!.watchdogId!)).toBe("canceled");
		expect(await f.scheduled_state(after.row!.job!.watchdogId!)).toBe("pending");
		expect(after.activity).toMatchObject({ status: "queued", startedAt: start + 60_000, deadlineAt });
		expect(after.transcript[1]).toBe(
			`$ [${new Date(start + 90_000).toISOString()}] job 1 paused (exit 0) in shell default: sleep 30s, continues at soon\none\n\n`,
		);

		// The next claim keeps the first start time, and the finish drops the resume script.
		vi.setSystemTime(start + 120_000);
		await f.t.mutation(internal.ai_chat_files.claim_bash_job, { invocationId: job.invocationId });
		expect((await f.read(job.invocationId)).activity).toMatchObject({ status: "running", startedAt: start + 60_000 });
		await f.t.mutation(internal.ai_chat_files.finish_bash_job, {
			invocationId: job.invocationId,
			result: job_result(0),
		});
		const finished = await f.read(job.invocationId);
		expect(finished.row?.job?.resumeScript).toBeUndefined();
		expect(finished.row?.job?.liveOutput).toBeUndefined();
		expect(finished.transcript[2]).toContain(
			`started ${new Date(start + 60_000).toISOString().slice(11, 19)}\nsleep 1\n`,
		);
	});

	test("refuses a row with a Stop pending or one that already settled", async () => {
		const f = await fixture();
		const stopping = await f.seed_job({ jobNumber: 1, status: "running", stopRequestedAt: Date.now() });
		expect(await pause(f, stopping.invocationId)).toBe(false);
		const settled = await f.seed_job({ jobNumber: 2, status: "running" });
		await f.t.mutation(internal.ai_chat_files.finish_bash_job, {
			invocationId: settled.invocationId,
			result: job_result(0),
		});
		expect(await pause(f, settled.invocationId)).toBe(false);
		for (const job of [stopping, settled]) {
			const after = await f.read(job.invocationId);
			expect(after.row?.job?.resumeScript).toBeUndefined();
			expect(after.row?.job?.workId).toBe(job.workId);
		}
	});

	test("a flush from the paused run's pool item is refused", async () => {
		const f = await fixture();
		const job = await f.seed_job({ jobNumber: 1, status: "running" });
		expect(await pause(f, job.invocationId)).toBe(true);
		await f.t.mutation(internal.ai_chat_files.flush_bash_job_output, {
			invocationId: job.invocationId,
			workId: job.workId!,
			liveOutput: { ...head, stdout: "stale\n" },
		});
		expect((await f.read(job.invocationId)).row?.job?.liveOutput).toEqual(head);
	});
});

describe("job wakeup", () => {
	const wakeAgent = { modelId: "gpt-5.4-nano" } as const;

	/**
	 * A user message and its reply, so the thread has a leaf to hang the job finish message on.
	 */
	async function seed_messages(f: Awaited<ReturnType<typeof fixture>>) {
		const stored = await f.asUser.mutation(api.ai_chat.thread_messages_add, {
			membershipId: f.db.membershipId,
			threadId: f.scope.threadId,
			parentId: null,
			messages: [
				{
					clientGeneratedMessageId: "user-1",
					content: { id: "user-1", role: "user", parts: [{ type: "text", text: "run it" }] },
				},
				{
					clientGeneratedMessageId: "assistant-1",
					content: { id: "assistant-1", role: "assistant", parts: [{ type: "text", text: "started" }] },
				},
			],
		});
		if (stored._nay) throw new Error(stored._nay.message);
		return { userId: stored._yay.ids[0]!, assistantId: stored._yay.ids[1]! };
	}

	async function read_thread(f: Awaited<ReturnType<typeof fixture>>) {
		return await f.t.run(async (ctx) => ({
			thread: await ctx.db.get("ai_chat_threads", f.scope.threadId),
			messages: await ctx.db
				.query("ai_chat_threads_messages_aisdk_5")
				.withIndex("by_organization_workspace_thread", (q) =>
					q
						.eq("organizationId", f.db.organizationId)
						.eq("workspaceId", f.db.workspaceId)
						.eq("threadId", f.scope.threadId),
				)
				.order("asc")
				.collect(),
			wakeups: (await ctx.db.system.query("_scheduled_functions").collect()).filter(
				(scheduled) => scheduled.name === getFunctionName(internal.ai_chat.run_job_wakeup),
			),
		}));
	}

	test("the finish stores a system message under the newest leaf, takes the lease and schedules the run", async () => {
		const f = await fixture();
		const { assistantId } = await seed_messages(f);
		const job = await f.seed_job({ jobNumber: 1, status: "running", wakeAgent });
		const now = Date.now();
		await f.t.mutation(internal.ai_chat_files.finish_bash_job, {
			invocationId: job.invocationId,
			result: job_result(2, "line one\n", "oops\n"),
		});

		const { thread, messages, wakeups } = await read_thread(f);
		const message = messages.at(-1);
		expect(message).toMatchObject({
			parentId: assistantId,
			createdBy: f.db.userId,
			content: {
				role: "system",
				parts: [
					{
						type: "text",
						text: "Background job 1 finished in shell default with exit 2.\nstdout:\nline one\n\nstderr:\noops\n\nFull output: jobs -o 1 or /shells/default/transcript.",
					},
				],
			},
		});
		expect(thread).toMatchObject({
			activeRun: { kind: "job_wakeup", expiresAt: now + 10 * 60 * 1000 },
			lastMessageAt: now,
		});
		expect(wakeups).toHaveLength(1);
		expect(wakeups[0]).toMatchObject({
			state: { kind: "pending" },
			args: [{ invocationId: job.invocationId, threadId: f.scope.threadId, finishMessageId: message?._id }],
		});
	});

	test("the message goes under the newest message, not under the newest root's branch", async () => {
		const f = await fixture();
		const { assistantId } = await seed_messages(f);

		// Editing the first user message stores the new one with no parent, so the thread gets a second
		// root. The chat still shows the branch of the newest message, and the user keeps talking there.
		vi.setSystemTime(Date.now() + 1000);
		const otherRoot = await f.asUser.mutation(api.ai_chat.thread_messages_add, {
			membershipId: f.db.membershipId,
			threadId: f.scope.threadId,
			parentId: null,
			messages: [
				{
					clientGeneratedMessageId: "user-b",
					content: { id: "user-b", role: "user", parts: [{ type: "text", text: "run it again" }] },
				},
			],
		});
		if (otherRoot._nay) throw new Error(otherRoot._nay.message);
		vi.setSystemTime(Date.now() + 1000);
		const branchA = await f.asUser.mutation(api.ai_chat.thread_messages_add, {
			membershipId: f.db.membershipId,
			threadId: f.scope.threadId,
			parentId: assistantId,
			messages: [
				{
					clientGeneratedMessageId: "user-a2",
					content: { id: "user-a2", role: "user", parts: [{ type: "text", text: "and again" }] },
				},
			],
		});
		if (branchA._nay) throw new Error(branchA._nay.message);

		// The last word in the thread is another member's, and the chat shows their message as the leaf
		// for everyone. The message belongs there too, so this pins the newest message of the thread and
		// not the newest message of the user whose job it is.
		const other = await add_member(f, "bash-jobs-leaf");
		vi.setSystemTime(Date.now() + 1000);
		const otherMessage = await f.t
			.withIdentity({ issuer: "https://clerk.test", external_id: other.userId })
			.mutation(api.ai_chat.thread_messages_add, {
				membershipId: other.membershipId,
				threadId: f.scope.threadId,
				parentId: branchA._yay.ids[0]!,
				messages: [
					{
						clientGeneratedMessageId: "user-c",
						content: { id: "user-c", role: "user", parts: [{ type: "text", text: "me too" }] },
					},
				],
			});
		if (otherMessage._nay) throw new Error(otherMessage._nay.message);
		const newestMessageId = otherMessage._yay.ids[0]!;

		const job = await f.seed_job({ jobNumber: 1, status: "running", wakeAgent });
		vi.setSystemTime(Date.now() + 1000);
		await f.t.mutation(internal.ai_chat_files.finish_bash_job, {
			invocationId: job.invocationId,
			result: job_result(0),
		});

		const { messages } = await read_thread(f);
		const message = messages.at(-1);
		expect(message?.content.role).toBe("system");
		// The newest root is `user-b`, whose branch the chat does not render. Hanging the message there
		// would hide it and give the woken run only that one turn to answer.
		expect(message?.parentId).toBe(newestMessageId);
	});

	test("cuts the message's output head without splitting a character", async () => {
		const f = await fixture();
		await seed_messages(f);
		// The message carries 4096 code units of each stream, and the emoji starts at unit 4095, so a plain
		// cut would keep only its first half. `[truncated]` must follow the last whole character.
		const emoji = String.fromCodePoint(0x1f389);
		const job = await f.seed_job({ jobNumber: 1, status: "running", wakeAgent });
		await f.t.mutation(internal.ai_chat_files.finish_bash_job, {
			invocationId: job.invocationId,
			result: job_result(0, `${"x".repeat(4095)}${emoji}`),
		});

		const { messages } = await read_thread(f);
		expect(messages.at(-1)?.content.parts[0].text).toContain(`stdout:\n${"x".repeat(4095)}\n[truncated]\nstderr:`);
	});

	test("a job that ends while a chat run streams stores the message but schedules nothing; an expired lease does not block", async () => {
		const f = await fixture();
		await seed_messages(f);
		const now = Date.now();
		await f.t.run((ctx) =>
			ctx.db.patch("ai_chat_threads", f.scope.threadId, { activeRun: { kind: "chat", expiresAt: now + 60_000 } }),
		);
		const first = await f.seed_job({ jobNumber: 1, status: "running", wakeAgent });
		await f.t.mutation(internal.ai_chat_files.finish_bash_job, {
			invocationId: first.invocationId,
			result: job_result(0),
		});
		// The message is stored at once, so history order stays true. The running turn injects it at
		// its next step boundary; no lease is taken and no wake run is scheduled.
		let state = await read_thread(f);
		expect(state.messages).toHaveLength(3);
		expect(state.messages.at(-1)?.content.role).toBe("system");
		expect(state.thread?.activeRun).toEqual({ kind: "chat", expiresAt: now + 60_000 });
		expect(state.wakeups).toHaveLength(0);

		vi.setSystemTime(now + 60_001);
		const second = await f.seed_job({ jobNumber: 2, status: "running", wakeAgent });
		await f.t.mutation(internal.ai_chat_files.finish_bash_job, {
			invocationId: second.invocationId,
			result: job_result(0),
		});
		state = await read_thread(f);
		expect(state.messages).toHaveLength(4);
		expect(state.thread?.activeRun?.kind).toBe("job_wakeup");
		expect(state.wakeups).toHaveLength(1);
	});

	test("a job without the flag still posts and wakes, and a settle with no result wakes with the flushed head", async () => {
		const f = await fixture();
		await seed_messages(f);
		const plain = await f.seed_job({ jobNumber: 1, status: "running" });
		await f.t.mutation(internal.ai_chat_files.finish_bash_job, {
			invocationId: plain.invocationId,
			result: job_result(0),
		});
		// No flag, same message. The wake run answers with the default model (see the door test).
		expect((await read_thread(f)).messages).toHaveLength(3);
		await f.t.mutation(internal.ai_chat.thread_run_end, { threadId: f.scope.threadId, kind: "job_wakeup" });

		const start = Date.now();
		const armed = await f.seed_job({ jobNumber: 2, status: "running", wakeAgent });
		await f.t.mutation(internal.ai_chat_files.flush_bash_job_output, {
			invocationId: armed.invocationId,
			workId: armed.workId!,
			liveOutput: { stdout: "partial\n", stderr: "", stdoutTruncated: false, stderrTruncated: false },
		});
		vi.setSystemTime(start + PLACEHOLDER_MS);
		await f.t.mutation(internal.ai_chat_files.timeout_bash_job, {
			invocationId: armed.invocationId,
			expectedDeadlineAt: start + PLACEHOLDER_MS,
		});
		const { messages, wakeups } = await read_thread(f);
		expect(messages.at(-1)?.content.parts[0].text).toBe(
			"Background job 2 finished in shell default with exit 124.\nstdout:\npartial\n\nstderr:\n\nFull output: jobs -o 2 or /shells/default/transcript.",
		);
		expect(wakeups).toHaveLength(2);
	});

	test("the message of a settled job reports the Activity code, not the late result's", async () => {
		const f = await fixture();
		await seed_messages(f);
		const start = Date.now();
		const job = await f.seed_job({ jobNumber: 1, status: "running", wakeAgent });
		// A chat run holds the thread lease, so the watchdog stores its message but schedules nothing.
		// The slow worker then stores the 0 of a script that finished on its own, and the message must
		// not say the job succeeded while `wait`, `jobs -o` and the feed all say it timed out.
		vi.setSystemTime(start + PLACEHOLDER_MS);
		expect(await f.t.mutation(internal.ai_chat.thread_run_begin, { threadId: f.scope.threadId })).toBe(true);
		await f.t.mutation(internal.ai_chat_files.timeout_bash_job, {
			invocationId: job.invocationId,
			expectedDeadlineAt: start + PLACEHOLDER_MS,
		});
		await f.t.mutation(internal.ai_chat.thread_run_end, { threadId: f.scope.threadId, kind: "chat" });
		await f.t.mutation(internal.ai_chat_files.finish_bash_job, {
			invocationId: job.invocationId,
			result: job_result(0, "late\n"),
		});

		expect((await read_thread(f)).messages.at(-1)?.content.parts[0].text).toContain(
			"Background job 1 finished in shell default with exit 124.",
		);
	});

	test("wakeups chain without the user up to any count, and a chat request still takes the lease", async () => {
		const f = await fixture();
		await seed_messages(f);
		// A woken turn gives the lease back when it ends, so the job it armed can wake again.
		const wake_once = async (jobNumber: number) => {
			const job = await f.seed_job({ jobNumber, status: "running", wakeAgent });
			await f.t.mutation(internal.ai_chat_files.finish_bash_job, {
				invocationId: job.invocationId,
				result: job_result(0),
			});
			await f.t.mutation(internal.ai_chat.thread_run_end, { threadId: f.scope.threadId, kind: "job_wakeup" });
		};
		for (const jobNumber of [1, 2, 3, 4, 5, 6, 7]) await wake_once(jobNumber);
		const chained = await read_thread(f);
		expect(chained.wakeups).toHaveLength(7);
		// Nothing answered these messages, so each one is the thread's newest message when the next job
		// ends, and the messages form one chain. A rule that skipped system messages would hang all seven
		// off the last user message instead, and the chat would render only the newest of them.
		const messages = chained.messages.filter((message) => message.content.role === "system");
		expect(messages).toHaveLength(7);
		expect(messages.slice(1).map((message) => message.parentId)).toEqual(
			messages.slice(0, -1).map((message) => message._id),
		);

		expect(await f.t.mutation(internal.ai_chat.thread_run_begin, { threadId: f.scope.threadId })).toBe(true);
		await f.t.mutation(internal.ai_chat.thread_run_end, { threadId: f.scope.threadId, kind: "chat" });
		await wake_once(8);
		expect((await read_thread(f)).wakeups).toHaveLength(8);
	});

	test("a job whose member lost access writes no message and takes no lease", async () => {
		const f = await fixture();
		await seed_messages(f);
		const job = await f.seed_job({ jobNumber: 1, status: "running", wakeAgent });
		await f.t.run((ctx) => ctx.db.patch("organizations_workspaces_users", f.db.membershipId, { active: false }));
		// The claim of a job with a dead membership settles it, and that settle would wake.
		expect(await f.t.mutation(internal.ai_chat_files.claim_bash_job, { invocationId: job.invocationId })).toBeNull();
		const state = await read_thread(f);
		expect(state.messages).toHaveLength(2);
		expect(state.thread?.activeRun).toBeUndefined();
		expect(state.wakeups).toHaveLength(0);
	});

	test("a job whose member lost the role writes no message either", async () => {
		const f = await fixture();
		await seed_messages(f);
		const job = await f.seed_job({ jobNumber: 1, status: "running", wakeAgent, allowDbFilesMkdir: true });
		// The fixture user created the organization, so they own it, and an owner passes every
		// permission check. Hand the organization to somebody else and give the user a real role, so
		// the role below is what decides.
		const assignmentId = await f.t.run(async (ctx) => {
			const otherOwnerId = await ctx.db.insert("users", { clerkUserId: null });
			await ctx.db.patch("organizations", f.db.organizationId, { ownerUserId: otherOwnerId });
			return await access_control_db_ensure_role_assignment(ctx, {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				userId: f.db.userId,
				role: "viewer",
				now: Date.now(),
			});
		});

		// `viewer` reads and does not write. The message of an Agent-mode job starts a turn that may
		// write app files, and the wakeup run is refused anyway, so no message is stored.
		await f.t.mutation(internal.ai_chat_files.finish_bash_job, {
			invocationId: job.invocationId,
			result: job_result(0),
		});
		const afterViewer = await read_thread(f);
		expect(afterViewer.messages).toHaveLength(2);
		expect(afterViewer.thread?.activeRun).toBeUndefined();
		// The job did finish. Without this, a `finish_bash_job` that stored nothing at all would pass
		// every assertion here, because they all check that something is absent.
		expect((await f.read(job.invocationId)).row).toMatchObject({ status: "finished" });

		// A member with no role at all cannot even read the thread, so an Ask-mode job stores nothing
		// either.
		await f.t.run((ctx) => ctx.db.delete("access_control_role_assignments", assignmentId));
		const ask = await f.seed_job({ jobNumber: 2, status: "running", wakeAgent });
		await f.t.mutation(internal.ai_chat_files.finish_bash_job, {
			invocationId: ask.invocationId,
			result: job_result(0),
		});
		const afterNoRole = await read_thread(f);
		expect(afterNoRole.messages).toHaveLength(2);
		expect(afterNoRole.wakeups).toHaveLength(0);
	});

	test("a result stored after the watchdog settled adds no second message", async () => {
		const f = await fixture();
		await seed_messages(f);
		const start = Date.now();
		const job = await f.seed_job({ jobNumber: 1, status: "running", wakeAgent });
		vi.setSystemTime(start + PLACEHOLDER_MS);
		await f.t.mutation(internal.ai_chat_files.timeout_bash_job, {
			invocationId: job.invocationId,
			expectedDeadlineAt: start + PLACEHOLDER_MS,
		});
		const settled = await read_thread(f);
		expect(settled.messages).toHaveLength(3);

		// The woken turn ended and gave the lease back, so the message the settle already stored is the
		// only thing that can stop a second one. The worker was alive after all, and its real output
		// is still kept.
		await f.t.mutation(internal.ai_chat.thread_run_end, { threadId: f.scope.threadId, kind: "job_wakeup" });
		await f.t.mutation(internal.ai_chat_files.finish_bash_job, {
			invocationId: job.invocationId,
			result: job_result(0, "real output\n"),
		});
		expect((await f.read(job.invocationId)).row).toMatchObject({
			status: "finished",
			result: { stdout: "real output\n" },
		});
		const state = await read_thread(f);
		expect(state.messages).toHaveLength(3);
		expect(state.wakeups).toHaveLength(1);
	});

	test("a settle during a run stores the message and the late result adds nothing", async () => {
		const f = await fixture();
		await seed_messages(f);
		const start = Date.now();
		const job = await f.seed_job({ jobNumber: 1, status: "running", wakeAgent });
		// A chat run still holds the thread when the watchdog settles, so that settle stores its
		// message but schedules nothing. The lease has to outlive the settle below, which happens ten
		// minutes in.
		await f.t.run((ctx) =>
			ctx.db.patch("ai_chat_threads", f.scope.threadId, {
				activeRun: { kind: "chat", expiresAt: start + PLACEHOLDER_MS + 60_000 },
			}),
		);
		vi.setSystemTime(start + PLACEHOLDER_MS);
		await f.t.mutation(internal.ai_chat_files.timeout_bash_job, {
			invocationId: job.invocationId,
			expectedDeadlineAt: start + PLACEHOLDER_MS,
		});
		const settled = await read_thread(f);
		expect(settled.messages).toHaveLength(3);
		expect(settled.wakeups).toHaveLength(0);
		// The settle really ran. A watchdog that did nothing would leave the row running, and the
		// finish below would then be an ordinary first wake that proves nothing about this case.
		expect((await f.read(job.invocationId)).row).toMatchObject({ status: "interrupted" });

		// The chat turn ended, and then the slow worker reported. The message is already stored, so
		// this result only stores its output and schedules nothing.
		await f.t.mutation(internal.ai_chat.thread_run_end, { threadId: f.scope.threadId, kind: "chat" });
		await f.t.mutation(internal.ai_chat_files.finish_bash_job, {
			invocationId: job.invocationId,
			result: job_result(0, "real output\n"),
		});
		const woken = await read_thread(f);
		expect(woken.messages).toHaveLength(3);
		expect(woken.wakeups).toHaveLength(0);
	});

	test("arm_bash_job_wakeup arms the caller's live jobs only", async () => {
		const f = await fixture();
		const live = await f.seed_job({ jobNumber: 1, status: "running" });
		const done = await f.seed_job({ jobNumber: 2, status: "running" });
		await f.t.mutation(internal.ai_chat_files.finish_bash_job, {
			invocationId: done.invocationId,
			result: job_result(0),
		});
		expect(
			await f.t.mutation(internal.ai_chat_files.arm_bash_job_wakeup, {
				...f.scope,
				jobNumbers: [1, 2, 9],
				modelId: "gpt-5.4-mini",
			}),
		).toEqual([1]);
		expect((await f.read(live.invocationId)).row?.job?.wakeAgent).toEqual({ modelId: "gpt-5.4-mini" });
		expect((await f.read(done.invocationId)).row?.job?.wakeAgent).toBeUndefined();
	});

	test("the run lease refuses a chat request only while a wakeup runs, and each kind clears its own", async () => {
		const f = await fixture();
		const now = Date.now();
		expect(await f.t.mutation(internal.ai_chat.thread_run_begin, { threadId: f.scope.threadId })).toBe(true);
		expect((await read_thread(f)).thread?.activeRun).toEqual({ kind: "chat", expiresAt: now + 10 * 60 * 1000 });
		// A second chat request is allowed, like before the lease existed.
		expect(await f.t.mutation(internal.ai_chat.thread_run_begin, { threadId: f.scope.threadId })).toBe(true);
		await f.t.mutation(internal.ai_chat.thread_run_end, { threadId: f.scope.threadId, kind: "job_wakeup" });
		expect((await read_thread(f)).thread?.activeRun?.kind).toBe("chat");
		await f.t.mutation(internal.ai_chat.thread_run_end, { threadId: f.scope.threadId, kind: "chat" });
		expect((await read_thread(f)).thread?.activeRun).toBeUndefined();

		await f.t.run((ctx) =>
			ctx.db.patch("ai_chat_threads", f.scope.threadId, { activeRun: { kind: "job_wakeup", expiresAt: now + 60_000 } }),
		);
		expect(await f.t.mutation(internal.ai_chat.thread_run_begin, { threadId: f.scope.threadId })).toBe(false);
		vi.setSystemTime(now + 60_001);
		expect(await f.t.mutation(internal.ai_chat.thread_run_begin, { threadId: f.scope.threadId })).toBe(true);
	});

	test("get_job_wakeup_context reads the thread with the job's user and refuses a lost membership", async () => {
		const f = await fixture();
		await seed_messages(f);
		const job = await f.seed_job({ jobNumber: 1, status: "running", wakeAgent, allowDbFilesMkdir: true });
		const context = await f.t.query(internal.ai_chat.get_job_wakeup_context, { invocationId: job.invocationId });
		if (context._nay) throw new Error(context._nay.message);
		expect(context._yay).toMatchObject({
			membership: { _id: f.db.membershipId },
			thread: { _id: f.scope.threadId },
			modelId: "gpt-5.4-nano",
			modeId: "agent",
		});
		expect(context._yay.messages.map((message) => message.clientGeneratedMessageId)).toEqual(["user-1", "assistant-1"]);

		// A job with no flag still opens the door, with the default model. This is also the shape of
		// a job a job started, whose worker never carries the flag.
		const plain = await f.seed_job({ jobNumber: 2, status: "running" });
		const plainContext = await f.t.query(internal.ai_chat.get_job_wakeup_context, {
			invocationId: plain.invocationId,
		});
		if (plainContext._nay) throw new Error(plainContext._nay.message);
		expect(plainContext._yay.modelId).toBe("gpt-5.4-nano");

		// A member who was removed and invited again gets a new lifetime, and the job still names the
		// older one. The step below bumps that counter straight in the row, which is the one thing a
		// reinvite changes that this door reads.
		const lifetimeRow = await f.t.run(async (ctx) => {
			const lifetime = (await ctx.db
				.query("organizations_membership_lifetimes")
				.withIndex("by_workspace_user", (q) => q.eq("workspaceId", f.db.workspaceId).eq("userId", f.db.userId))
				.first())!;
			await ctx.db.patch("organizations_membership_lifetimes", lifetime._id, { lifetime: lifetime.lifetime + 1 });
			return lifetime;
		});
		expect(await f.t.query(internal.ai_chat.get_job_wakeup_context, { invocationId: job.invocationId })).toEqual({
			_nay: { message: "Unauthorized" },
		});
		// Put the job back in reach, so the refusal below is the dead membership and not the lifetime.
		await f.t.run((ctx) =>
			ctx.db.patch("organizations_membership_lifetimes", lifetimeRow._id, { lifetime: lifetimeRow.lifetime }),
		);
		expect(
			(await f.t.query(internal.ai_chat.get_job_wakeup_context, { invocationId: job.invocationId }))._nay,
		).toBeUndefined();

		await f.t.run((ctx) => ctx.db.patch("organizations_workspaces_users", f.db.membershipId, { active: false }));
		expect(await f.t.query(internal.ai_chat.get_job_wakeup_context, { invocationId: job.invocationId })).toEqual({
			_nay: { message: "Unauthorized" },
		});
	});

	test("get_chat_reply_parent chains under a mid-run finish message and nothing else", async () => {
		const f = await fixture();
		const { assistantId } = await seed_messages(f);
		const job = await f.seed_job({ jobNumber: 1, status: "running", wakeAgent });
		await f.t.mutation(internal.ai_chat_files.finish_bash_job, {
			invocationId: job.invocationId,
			result: job_result(0),
		});
		const finishId = (await read_thread(f)).messages.at(-1)!._id;
		// The reply captured its parent before the finish landed; it must chain under the finish.
		expect(
			await f.t.query(internal.ai_chat.get_chat_reply_parent, {
				threadId: f.scope.threadId,
				fallbackParentId: assistantId,
			}),
		).toBe(finishId);
		// The fallback itself is newest: nothing changed.
		expect(
			await f.t.query(internal.ai_chat.get_chat_reply_parent, {
				threadId: f.scope.threadId,
				fallbackParentId: finishId,
			}),
		).toBe(finishId);
		const aborted = await f.asUser.mutation(api.ai_chat.thread_messages_add, {
			membershipId: f.db.membershipId,
			threadId: f.scope.threadId,
			parentId: assistantId,
			messages: [
				{
					clientGeneratedMessageId: "abort-reply",
					content: { id: "abort-reply", role: "assistant", parts: [{ type: "text", text: "stopped" }] },
				},
			],
		});
		if (aborted._nay) throw new Error(aborted._nay.message);
		expect((await read_thread(f)).messages.find((message) => message._id === aborted._yay.ids[0])?.parentId).toBe(
			finishId,
		);
	});

	test("get_chat_reply_parent ignores a user quote of the finish words", async () => {
		const f = await fixture();
		const { assistantId } = await seed_messages(f);
		const stored = await f.asUser.mutation(api.ai_chat.thread_messages_add, {
			membershipId: f.db.membershipId,
			threadId: f.scope.threadId,
			parentId: assistantId,
			messages: [
				{
					clientGeneratedMessageId: "user-quote",
					content: {
						id: "user-quote",
						role: "user",
						parts: [{ type: "text", text: "Background job 1 finished in shell default, really?" }],
					},
				},
			],
		});
		if (stored._nay) throw new Error(stored._nay.message);
		expect(
			await f.t.query(internal.ai_chat.get_chat_reply_parent, {
				threadId: f.scope.threadId,
				fallbackParentId: assistantId,
			}),
		).toBe(assistantId);
	});

	test("get_chat_reply_parent walks a chain of mid-run finishes under the captured parent", async () => {
		const f = await fixture();
		const { assistantId } = await seed_messages(f);
		const first = await f.seed_job({ jobNumber: 1, status: "running", wakeAgent });
		await f.t.mutation(internal.ai_chat_files.finish_bash_job, {
			invocationId: first.invocationId,
			result: job_result(0),
		});
		const second = await f.seed_job({ jobNumber: 2, status: "running", wakeAgent });
		await f.t.mutation(internal.ai_chat_files.finish_bash_job, {
			invocationId: second.invocationId,
			result: job_result(0),
		});
		const finishId = (await read_thread(f)).messages.at(-1)!._id;
		expect(
			await f.t.query(internal.ai_chat.get_chat_reply_parent, {
				threadId: f.scope.threadId,
				fallbackParentId: assistantId,
			}),
		).toBe(finishId);
		const aborted = await f.asUser.mutation(api.ai_chat.thread_messages_add, {
			membershipId: f.db.membershipId,
			threadId: f.scope.threadId,
			parentId: assistantId,
			messages: [
				{
					clientGeneratedMessageId: "abort-two-finishes",
					content: { id: "abort-two-finishes", role: "assistant", parts: [{ type: "text", text: "stopped" }] },
				},
			],
		});
		if (aborted._nay) throw new Error(aborted._nay.message);
		expect((await read_thread(f)).messages.find((message) => message._id === aborted._yay.ids[0])?.parentId).toBe(
			finishId,
		);
	});

	test("get_chat_reply_parent keeps an older captured parent when the finish hangs further down", async () => {
		const f = await fixture();
		const { assistantId } = await seed_messages(f);
		const later = await f.asUser.mutation(api.ai_chat.thread_messages_add, {
			membershipId: f.db.membershipId,
			threadId: f.scope.threadId,
			parentId: assistantId,
			messages: [
				{
					clientGeneratedMessageId: "user-2",
					content: { id: "user-2", role: "user", parts: [{ type: "text", text: "later" }] },
				},
			],
		});
		if (later._nay) throw new Error(later._nay.message);
		const job = await f.seed_job({ jobNumber: 1, status: "running", wakeAgent });
		await f.t.mutation(internal.ai_chat_files.finish_bash_job, {
			invocationId: job.invocationId,
			result: job_result(0),
		});
		const finishId = (await read_thread(f)).messages.at(-1)!._id;
		expect(finishId).not.toBe(assistantId);
		expect(
			await f.t.query(internal.ai_chat.get_chat_reply_parent, {
				threadId: f.scope.threadId,
				fallbackParentId: assistantId,
			}),
		).toBe(assistantId);
		const regenerated = await f.asUser.mutation(api.ai_chat.thread_messages_add, {
			membershipId: f.db.membershipId,
			threadId: f.scope.threadId,
			parentId: assistantId,
			messages: [
				{
					clientGeneratedMessageId: "regenerate-a1",
					content: { id: "regenerate-a1", role: "assistant", parts: [{ type: "text", text: "new a1" }] },
				},
			],
		});
		if (regenerated._nay) throw new Error(regenerated._nay.message);
		expect(
			(await read_thread(f)).messages.find((message) => message._id === regenerated._yay.ids[0])?.parentId,
		).toBe(assistantId);
	});

	test("thread_run_handover_to_wakeup flips one chat lease and refuses the rest", async () => {
		const f = await fixture();
		expect(
			await f.t.mutation(internal.ai_chat.thread_run_handover_to_wakeup, { threadId: f.scope.threadId }),
		).toBe(false);
		await f.t.mutation(internal.ai_chat.thread_run_begin, { threadId: f.scope.threadId });
		expect(
			await f.t.mutation(internal.ai_chat.thread_run_handover_to_wakeup, { threadId: f.scope.threadId }),
		).toBe(true);
		expect((await read_thread(f)).thread?.activeRun?.kind).toBe("job_wakeup");
		// The second tab hands over nothing: exactly one wake run follows.
		expect(
			await f.t.mutation(internal.ai_chat.thread_run_handover_to_wakeup, { threadId: f.scope.threadId }),
		).toBe(false);
		// A chat release no longer clears the woken lease.
		await f.t.mutation(internal.ai_chat.thread_run_end, { threadId: f.scope.threadId, kind: "chat" });
		expect((await read_thread(f)).thread?.activeRun?.kind).toBe("job_wakeup");
	});

	test("thread_run_extend_wakeup stretches a live wake lease and refuses the rest", async () => {
		const f = await fixture();
		expect(
			await f.t.mutation(internal.ai_chat.thread_run_extend_wakeup, { threadId: f.scope.threadId }),
		).toBe(false);
		const now = Date.now();
		await f.t.mutation(internal.ai_chat.thread_run_begin, { threadId: f.scope.threadId });
		expect(
			await f.t.mutation(internal.ai_chat.thread_run_extend_wakeup, { threadId: f.scope.threadId }),
		).toBe(false);
		expect(
			await f.t.mutation(internal.ai_chat.thread_run_handover_to_wakeup, { threadId: f.scope.threadId }),
		).toBe(true);
		vi.setSystemTime(now + 60_000);
		expect(
			await f.t.mutation(internal.ai_chat.thread_run_extend_wakeup, { threadId: f.scope.threadId }),
		).toBe(true);
		expect((await read_thread(f)).thread?.activeRun).toEqual({
			kind: "job_wakeup",
			expiresAt: now + 60_000 + 10 * 60 * 1000,
		});
		// Past the extended expiry the lease is gone again.
		vi.setSystemTime(now + 60_000 + 10 * 60 * 1000 + 1);
		expect(
			await f.t.mutation(internal.ai_chat.thread_run_extend_wakeup, { threadId: f.scope.threadId }),
		).toBe(false);
	});

	test("get_wake_retry_after_ms names the wake lease end and null otherwise", async () => {
		const f = await fixture();
		expect(await f.t.query(internal.ai_chat.get_wake_retry_after_ms, { threadId: f.scope.threadId })).toBeNull();
		const now = Date.now();
		await f.t.run((ctx) =>
			ctx.db.patch("ai_chat_threads", f.scope.threadId, {
				activeRun: { kind: "job_wakeup", expiresAt: now + 60_000 },
			}),
		);
		expect(await f.t.query(internal.ai_chat.get_wake_retry_after_ms, { threadId: f.scope.threadId })).toBe(61_000);
	});

	test("thread_run_begin_wakeup takes a free lease and refuses a live run", async () => {
		const f = await fixture();
		expect(await f.t.mutation(internal.ai_chat.thread_run_begin_wakeup, { threadId: f.scope.threadId })).toBe(true);
		expect((await read_thread(f)).thread?.activeRun?.kind).toBe("job_wakeup");
		expect(await f.t.mutation(internal.ai_chat.thread_run_begin_wakeup, { threadId: f.scope.threadId })).toBe(false);
		await f.t.mutation(internal.ai_chat.thread_run_end, { threadId: f.scope.threadId, kind: "job_wakeup" });
		await f.t.mutation(internal.ai_chat.thread_run_begin, { threadId: f.scope.threadId });
		expect(await f.t.mutation(internal.ai_chat.thread_run_begin_wakeup, { threadId: f.scope.threadId })).toBe(false);
	});

	test("store_job_wakeup_reply hangs under a later finish on the same branch", async () => {
		const f = await fixture();
		await seed_messages(f);
		const first = await f.seed_job({ jobNumber: 1, status: "running" });
		await f.t.mutation(internal.ai_chat_files.finish_bash_job, {
			invocationId: first.invocationId,
			result: job_result(0),
		});
		await f.t.mutation(internal.ai_chat.thread_run_end, { threadId: f.scope.threadId, kind: "job_wakeup" });
		const job1FinishId = (await read_thread(f)).messages.at(-1)!._id;
		const second = await f.seed_job({ jobNumber: 2, status: "running" });
		await f.t.mutation(internal.ai_chat_files.finish_bash_job, {
			invocationId: second.invocationId,
			result: job_result(0),
		});
		await f.t.mutation(internal.ai_chat.thread_run_end, { threadId: f.scope.threadId, kind: "job_wakeup" });
		const job2FinishId = (await read_thread(f)).messages.at(-1)!._id;

		await f.t.mutation(internal.ai_chat.store_job_wakeup_reply, {
			threadId: f.scope.threadId,
			userId: f.scope.userId,
			finishMessageId: job1FinishId,
			clientGeneratedMessageId: "wake-1",
			content: { id: "wake-1", role: "assistant", parts: [{ type: "text", text: "both done" }] },
		});
		const reply = (await read_thread(f)).messages.find((message) => message.clientGeneratedMessageId === "wake-1");
		expect(reply?.parentId).toBe(job2FinishId);
	});

	test("store_job_wakeup_reply hangs under a chat reply that chained onto the finish", async () => {
		const f = await fixture();
		await seed_messages(f);
		const job = await f.seed_job({ jobNumber: 1, status: "running" });
		await f.t.mutation(internal.ai_chat_files.finish_bash_job, {
			invocationId: job.invocationId,
			result: job_result(0),
		});
		await f.t.mutation(internal.ai_chat.thread_run_end, { threadId: f.scope.threadId, kind: "job_wakeup" });
		const finishId = (await read_thread(f)).messages.at(-1)!._id;
		const stored = await f.asUser.mutation(api.ai_chat.thread_messages_add, {
			membershipId: f.db.membershipId,
			threadId: f.scope.threadId,
			parentId: finishId,
			messages: [
				{
					clientGeneratedMessageId: "chat-reply",
					content: { id: "chat-reply", role: "assistant", parts: [{ type: "text", text: "working" }] },
				},
			],
		});
		if (stored._nay) throw new Error(stored._nay.message);

		await f.t.mutation(internal.ai_chat.store_job_wakeup_reply, {
			threadId: f.scope.threadId,
			userId: f.scope.userId,
			finishMessageId: finishId,
			clientGeneratedMessageId: "wake-1",
			content: { id: "wake-1", role: "assistant", parts: [{ type: "text", text: "job done" }] },
		});
		const reply = (await read_thread(f)).messages.find((message) => message.clientGeneratedMessageId === "wake-1");
		expect(reply?.parentId).toBe(stored._yay.ids[0]);
	});

	test("store_job_wakeup_reply stays on the finish branch when a newer other-root exists", async () => {
		const f = await fixture();
		await seed_messages(f);
		const job = await f.seed_job({ jobNumber: 1, status: "running" });
		await f.t.mutation(internal.ai_chat_files.finish_bash_job, {
			invocationId: job.invocationId,
			result: job_result(0),
		});
		await f.t.mutation(internal.ai_chat.thread_run_end, { threadId: f.scope.threadId, kind: "job_wakeup" });
		const finishId = (await read_thread(f)).messages.at(-1)!._id;
		vi.setSystemTime(Date.now() + 1000);
		const otherRoot = await f.asUser.mutation(api.ai_chat.thread_messages_add, {
			membershipId: f.db.membershipId,
			threadId: f.scope.threadId,
			parentId: null,
			messages: [
				{
					clientGeneratedMessageId: "other-root",
					content: { id: "other-root", role: "user", parts: [{ type: "text", text: "other branch" }] },
				},
			],
		});
		if (otherRoot._nay) throw new Error(otherRoot._nay.message);

		await f.t.mutation(internal.ai_chat.store_job_wakeup_reply, {
			threadId: f.scope.threadId,
			userId: f.scope.userId,
			finishMessageId: finishId,
			clientGeneratedMessageId: "wake-1",
			content: { id: "wake-1", role: "assistant", parts: [{ type: "text", text: "job done" }] },
		});
		const reply = (await read_thread(f)).messages.find((message) => message.clientGeneratedMessageId === "wake-1");
		expect(reply?.parentId).toBe(finishId);
		expect(reply?.parentId).not.toBe(otherRoot._yay.ids[0]);
	});

	test("list_finish_messages_since returns linked finishes since the cutoff, oldest first", async () => {
		const f = await fixture();
		await seed_messages(f);
		const start = Date.now();
		const first = await f.seed_job({ jobNumber: 1, status: "running", wakeAgent });
		await f.t.mutation(internal.ai_chat_files.finish_bash_job, {
			invocationId: first.invocationId,
			result: job_result(0),
		});
		vi.setSystemTime(start + 1000);
		const second = await f.seed_job({ jobNumber: 2, status: "running", wakeAgent });
		await f.t.mutation(internal.ai_chat_files.finish_bash_job, {
			invocationId: second.invocationId,
			result: job_result(0),
		});
		const fresh = await f.t.query(internal.ai_chat.list_finish_messages_since, {
			threadId: f.scope.threadId,
			sinceMs: start,
		});
		expect(fresh.map((row) => row.invocationId)).toEqual([first.invocationId, second.invocationId]);
		expect(fresh[0]?.text).toContain("Background job 1 finished");
		const later = await f.t.query(internal.ai_chat.list_finish_messages_since, {
			threadId: f.scope.threadId,
			sinceMs: start + 1000,
		});
		expect(later.map((row) => row.invocationId)).toEqual([second.invocationId]);
	});
});

describe("timeout_bash_job", () => {
	test("a placeholder watchdog that runs after the claim re-armed the clocks no-ops", async () => {
		const f = await fixture();
		const start = Date.now();
		const job = await f.seed_job({ jobNumber: 1 });
		vi.setSystemTime(start + 60_000);
		await f.t.mutation(internal.ai_chat_files.claim_bash_job, { invocationId: job.invocationId });
		vi.setSystemTime(start + PLACEHOLDER_MS + 1);
		await f.t.mutation(internal.ai_chat_files.timeout_bash_job, {
			invocationId: job.invocationId,
			expectedDeadlineAt: start + PLACEHOLDER_MS,
		});
		const after = await f.read(job.invocationId);
		expect(after.row).toMatchObject({ status: "running" });
		expect(after.activity).toMatchObject({ status: "running" });
	});

	test("settles timed out at the armed deadline and writes the finish entry with the start time", async () => {
		const f = await fixture();
		const start = Date.now();
		const job = await f.seed_job({ jobNumber: 1 });
		vi.setSystemTime(start + 60_000);
		const claimed = await f.t.mutation(internal.ai_chat_files.claim_bash_job, { invocationId: job.invocationId });
		if (!claimed) throw new Error("Expected the claim");
		vi.setSystemTime(claimed.row.deadlineAt);
		await f.t.mutation(internal.ai_chat_files.timeout_bash_job, {
			invocationId: job.invocationId,
			expectedDeadlineAt: claimed.row.deadlineAt,
		});
		const after = await f.read(job.invocationId);
		expect(after.row).toMatchObject({ status: "interrupted", finishedAt: claimed.row.deadlineAt });
		expect(after.activity).toMatchObject({ status: "timed_out", finishedAt: claimed.row.deadlineAt });
		const started = new Date(start + 60_000).toISOString().slice(11, 19);
		expect(after.transcript[1]).toBe(
			`$ [${new Date(claimed.row.deadlineAt).toISOString()}] job 1 finished (exit 124) in shell default, started ${started}\nsleep 1\n\n`,
		);
	});

	test("settles canceled, not timed out, when a stop was recorded", async () => {
		const f = await fixture();
		const start = Date.now();
		const job = await f.seed_job({ jobNumber: 1, status: "running", stopRequestedAt: start });
		vi.setSystemTime(start + PLACEHOLDER_MS);
		await f.t.mutation(internal.ai_chat_files.timeout_bash_job, {
			invocationId: job.invocationId,
			expectedDeadlineAt: start + PLACEHOLDER_MS,
		});
		const after = await f.read(job.invocationId);
		expect(after.row).toMatchObject({ status: "interrupted" });
		expect(after.activity).toMatchObject({ status: "canceled" });
		expect(after.transcript[1]).toContain("job 1 finished (exit 143)");
	});

	test("fired after finish_bash_job committed finished, it leaves the row finished", async () => {
		const f = await fixture();
		const start = Date.now();
		const job = await f.seed_job({ jobNumber: 1, status: "running" });
		await f.t.mutation(internal.ai_chat_files.finish_bash_job, {
			invocationId: job.invocationId,
			result: job_result(0),
		});
		vi.setSystemTime(start + PLACEHOLDER_MS);
		await f.t.mutation(internal.ai_chat_files.timeout_bash_job, {
			invocationId: job.invocationId,
			expectedDeadlineAt: start + PLACEHOLDER_MS,
		});
		const after = await f.read(job.invocationId);
		expect(after.row).toMatchObject({ status: "finished" });
		expect(after.activity).toMatchObject({ status: "succeeded" });
		expect(after.transcript).toHaveLength(2);
	});
});

describe("finish_bash_job", () => {
	test("stores the result with the foreground retention, empties the job fields and settles the Activity", async () => {
		const f = await fixture();
		const start = Date.now();
		const job = await f.seed_job({ jobNumber: 1, script: "echo hi" });
		vi.setSystemTime(start + 60_000);
		await f.t.mutation(internal.ai_chat_files.claim_bash_job, { invocationId: job.invocationId });
		vi.setSystemTime(start + 90_000);
		await f.t.mutation(internal.ai_chat_files.finish_bash_job, {
			invocationId: job.invocationId,
			result: job_result(0, "hi\n"),
		});
		const after = await f.read(job.invocationId);
		expect(after.row).toMatchObject({
			status: "finished",
			finishedAt: start + 90_000,
			resultExpiresAt: start + 90_000 + 7 * 24 * 60 * 60 * 1000,
			result: { stdout: "hi\n", metadata: { exitCode: 0 } },
			job: { script: null, shellState: null },
		});
		expect(after.activity).toMatchObject({ status: "succeeded", errorMessage: null, finishedAt: start + 90_000 });
		expect(after.transcript).toEqual([
			`[${new Date(start).toISOString()}] job 1 started in shell default: echo hi`,
			`$ [${new Date(start + 90_000).toISOString()}] job 1 finished (exit 0) in shell default, started ${new Date(start + 60_000).toISOString().slice(11, 19)}\necho hi\nhi\n\n`,
		]);
		expect(await f.scheduled_state(after.row!.job!.watchdogId!)).toBe("canceled");
	});

	test.each([
		{ exitCode: 143, status: "canceled", errorMessage: null },
		{ exitCode: 124, status: "timed_out", errorMessage: null },
		{ exitCode: 2, status: "failed", errorMessage: "Command exited with code 2" },
	])("maps exit $exitCode to $status", async ({ exitCode, status, errorMessage }) => {
		const f = await fixture();
		const job = await f.seed_job({ jobNumber: 1, status: "running" });
		await f.t.mutation(internal.ai_chat_files.finish_bash_job, {
			invocationId: job.invocationId,
			result: job_result(exitCode),
		});
		expect((await f.read(job.invocationId)).activity).toMatchObject({ status, errorMessage });
	});

	test("accepts an interrupted row, refuses a finished one, and adds no second entry on a late finish", async () => {
		const f = await fixture();
		const start = Date.now();
		const job = await f.seed_job({ jobNumber: 1, status: "running" });
		vi.setSystemTime(start + PLACEHOLDER_MS);
		await f.t.mutation(internal.ai_chat_files.timeout_bash_job, {
			invocationId: job.invocationId,
			expectedDeadlineAt: start + PLACEHOLDER_MS,
		});
		expect((await f.read(job.invocationId)).row).toMatchObject({ status: "interrupted" });

		await f.t.mutation(internal.ai_chat_files.finish_bash_job, {
			invocationId: job.invocationId,
			result: job_result(0, "late\n"),
		});
		const late = await f.read(job.invocationId);
		expect(late.row).toMatchObject({ status: "finished", result: { stdout: "late\n" } });
		expect(late.activity).toMatchObject({ status: "timed_out" });
		// The start entry and the settle's finish entry. The worker's real result is kept on the row,
		// but a second finish entry would contradict the first one's 124.
		expect(late.transcript).toHaveLength(2);

		await f.t.mutation(internal.ai_chat_files.finish_bash_job, {
			invocationId: job.invocationId,
			result: job_result(1, "again\n"),
		});
		const again = await f.read(job.invocationId);
		expect(again.row).toMatchObject({ result: { stdout: "late\n" } });
		expect(again.transcript).toHaveLength(2);
	});

	test("stores a bounded copy of a huge result and keeps the full output in the transcript", async () => {
		const f = await fixture();
		const job = await f.seed_job({ jobNumber: 1, status: "running" });
		const stdout = "x".repeat(800 * 1024);
		await f.t.mutation(internal.ai_chat_files.finish_bash_job, {
			invocationId: job.invocationId,
			result: job_result(0, stdout),
		});
		const after = await f.read(job.invocationId);
		expect(after.row?.result?.stdout).toHaveLength(16_384);
		expect(after.row?.result?.metadata.stdoutTruncated).toBe(true);
		expect(after.transcript[1]).toContain(stdout);
	});

	test("cuts a transcript entry that one document could not hold and counts the cut size", async () => {
		const f = await fixture();
		const job = await f.seed_job({ jobNumber: 1, status: "running" });
		// A caller can hand over more than the engine's own output limit, and one Convex document
		// cannot be 1 MiB. Without the cut this insert fails and takes the whole call down after its
		// work was already done.
		await f.t.mutation(internal.ai_chat_files.finish_bash_job, {
			invocationId: job.invocationId,
			result: job_result(0, "x".repeat(1_200 * 1024)),
		});
		const after = await f.read(job.invocationId);
		// Uncut, this one entry is already over the whole transcript's byte cap, so the trim deletes it
		// again and the job's output is gone.
		expect(after.transcript).toHaveLength(2);
		const entry = after.transcript[1]!;
		expect(entry.endsWith("\n[transcript entry truncated]")).toBe(true);
		const bytes = after.transcript.reduce((total, text) => total + new TextEncoder().encode(text).byteLength, 0);
		expect(new TextEncoder().encode(entry).byteLength).toBeLessThan(1024 * 1024);
		// The shell counts the entry it really stored, not the text it was handed.
		expect(await f.t.run((ctx) => ctx.db.get("ai_chat_bash_shells", f.shell._id))).toMatchObject({
			transcriptBytes: bytes,
			transcriptEntries: after.transcript.length,
		});
	});

	test("schedules this job's own result expiry instead of leaving it to the daily cron", async () => {
		const f = await fixture();
		const job = await f.seed_job({ jobNumber: 1, status: "running" });
		await f.t.mutation(internal.ai_chat_files.finish_bash_job, {
			invocationId: job.invocationId,
			result: job_result(0),
		});
		// A job result can be 700 KiB, so a finished job row must empty itself on time like a
		// foreground call does.
		const expiry = await f.t.run(async (ctx) =>
			(await ctx.db.system.query("_scheduled_functions").collect()).find(
				(entry) =>
					entry.name.endsWith("expire_bash_invocation_result") &&
					(entry.args[0] as { invocationId?: string }).invocationId === job.invocationId,
			),
		);
		expect(expiry?.state.kind).toBe("pending");
		expect(expiry?.scheduledTime).toBe(Date.now() + 7 * 24 * 60 * 60 * 1000);
	});

	test("returns quietly on a missing row", async () => {
		const f = await fixture();
		const job = await f.seed_job({ jobNumber: 1 });
		await f.t.run((ctx) => ctx.db.delete("ai_chat_bash_invocations", job.invocationId));
		await expect(
			f.t.mutation(internal.ai_chat_files.finish_bash_job, { invocationId: job.invocationId, result: job_result(0) }),
		).resolves.toBeNull();
	});
});

describe("handle_bash_job_complete", () => {
	const callback = (
		invocationId: Id<"ai_chat_bash_invocations">,
		workId: WorkId,
		kind: "success" | "failed" | "canceled",
	) => ({
		workId,
		context: { invocationId },
		result:
			kind === "success"
				? { kind: "success" as const, returnValue: null }
				: kind === "failed"
					? { kind: "failed" as const, error: "boom" }
					: { kind: "canceled" as const },
	});

	test("a worker that threw settles failed at once and the row is interrupted", async () => {
		const f = await fixture();
		const job = await f.seed_job({ jobNumber: 1, status: "running" });
		await f.t.mutation(
			internal.ai_chat_files.handle_bash_job_complete,
			callback(job.invocationId, job.workId!, "failed"),
		);
		const after = await f.read(job.invocationId);
		expect(after.row).toMatchObject({ status: "interrupted" });
		expect(after.activity).toMatchObject({ status: "failed", errorMessage: "Background command crashed" });
		expect(after.transcript[1]).toContain("job 1 finished (exit 1)");
	});

	test("a Stop on a queued job settles canceled, posts a finish message and schedules a wake", async () => {
		const f = await fixture();
		const job = await f.seed_job({ jobNumber: 1, stopRequestedAt: Date.now() });
		await f.t.mutation(
			internal.ai_chat_files.handle_bash_job_complete,
			callback(job.invocationId, job.workId!, "canceled"),
		);
		const after = await f.read(job.invocationId);
		expect(after.row).toMatchObject({ status: "interrupted" });
		expect(after.activity).toMatchObject({ status: "canceled" });
		const posted = await f.t.run(async (ctx) => {
			const messages = await ctx.db
				.query("ai_chat_threads_messages_aisdk_5")
				.withIndex("by_organization_workspace_thread", (q) =>
					q
						.eq("organizationId", f.db.organizationId)
						.eq("workspaceId", f.db.workspaceId)
						.eq("threadId", f.scope.threadId),
				)
				.collect();
			const wakeups = (await ctx.db.system.query("_scheduled_functions").collect()).filter(
				(scheduled) => scheduled.name === getFunctionName(internal.ai_chat.run_job_wakeup),
			);
			return { messages, wakeups };
		});
		expect(
			posted.messages.some(
				(message) =>
					message.content.role === "system" &&
					typeof message.content.parts?.[0]?.text === "string" &&
					message.content.parts[0].text.includes("Background job 1 finished"),
			),
		).toBe(true);
		expect(posted.wakeups).toHaveLength(1);
	});

	test("a success after a stop settles canceled; a plain success and a superseded worker do nothing", async () => {
		const f = await fixture();
		const plain = await f.seed_job({ jobNumber: 1, status: "running" });
		await f.t.mutation(
			internal.ai_chat_files.handle_bash_job_complete,
			callback(plain.invocationId, plain.workId!, "success"),
		);
		expect((await f.read(plain.invocationId)).activity).toMatchObject({ status: "running" });

		const stopped = await f.seed_job({ jobNumber: 2, stopRequestedAt: Date.now() });
		await f.t.mutation(
			internal.ai_chat_files.handle_bash_job_complete,
			callback(stopped.invocationId, "other" as WorkId, "success"),
		);
		expect((await f.read(stopped.invocationId)).activity).toMatchObject({ status: "stopping" });
		await f.t.mutation(
			internal.ai_chat_files.handle_bash_job_complete,
			callback(stopped.invocationId, stopped.workId!, "success"),
		);
		expect((await f.read(stopped.invocationId)).activity).toMatchObject({ status: "canceled" });

		await f.t.run((ctx) => ctx.db.delete("ai_chat_bash_invocations", plain.invocationId));
		await expect(
			f.t.mutation(
				internal.ai_chat_files.handle_bash_job_complete,
				callback(plain.invocationId, plain.workId!, "failed"),
			),
		).resolves.toBeNull();
	});
});

describe("request_bash_job_stop", () => {
	test("records the stop on the caller's own live job and cancels the watchdog", async () => {
		const f = await fixture();
		const job = await f.seed_job({ jobNumber: 1, status: "running" });
		expect(await f.t.mutation(internal.ai_chat_files.request_bash_job_stop, { ...f.scope, jobNumber: 1 })).toBe(true);
		const after = await f.read(job.invocationId);
		expect(after.row).toMatchObject({ status: "running", job: { stopRequestedAt: Date.now() } });
		expect(after.activity).toMatchObject({ status: "stopping", stopRequestedAt: Date.now() });
		expect(await f.scheduled_state(job.watchdogId)).toBe("canceled");
		// A repeated kill is still a recorded stop.
		expect(await f.t.mutation(internal.ai_chat_files.request_bash_job_stop, { ...f.scope, jobNumber: 1 })).toBe(true);
	});

	test("returns false for a finished job, an unknown job and another member's job", async () => {
		const f = await fixture();
		const finished = await f.seed_job({ jobNumber: 1, status: "running" });
		await f.t.mutation(internal.ai_chat_files.finish_bash_job, {
			invocationId: finished.invocationId,
			result: job_result(0),
		});
		expect(await f.t.mutation(internal.ai_chat_files.request_bash_job_stop, { ...f.scope, jobNumber: 1 })).toBe(false);
		expect(await f.t.mutation(internal.ai_chat_files.request_bash_job_stop, { ...f.scope, jobNumber: 9 })).toBe(false);

		await f.seed_job({ jobNumber: 2, status: "running" });
		const other = await add_member(f, "bash-jobs-other");
		expect(
			await f.t.mutation(internal.ai_chat_files.request_bash_job_stop, {
				...f.scope,
				userId: other.userId,
				jobNumber: 2,
			}),
		).toBe(false);
		expect((await f.read(finished.invocationId)).activity).toMatchObject({ status: "succeeded" });
	});

	test("does not throw when the pool item and the watchdog are null", async () => {
		const f = await fixture();
		const job = await f.seed_job({ jobNumber: 1, status: "running", workId: null });
		await f.t.run(async (ctx) => {
			const row = await ctx.db.get("ai_chat_bash_invocations", job.invocationId);
			await ctx.db.patch("ai_chat_bash_invocations", job.invocationId, { job: { ...row!.job!, watchdogId: null } });
		});
		expect(await f.t.mutation(internal.ai_chat_files.request_bash_job_stop, { ...f.scope, jobNumber: 1 })).toBe(true);
		expect((await f.read(job.invocationId)).activity).toMatchObject({ status: "stopping" });
	});
});

describe("poll_bash_job", () => {
	test("reports the row status, the stop flag and the permission re-check", async () => {
		const f = await fixture();
		const job = await f.seed_job({ jobNumber: 1, status: "running" });
		expect(await f.t.query(internal.ai_chat_files.poll_bash_job, { invocationId: job.invocationId })).toEqual({
			status: "running",
			stopRequested: false,
			authorized: true,
		});
		await f.t.mutation(internal.ai_chat_files.request_bash_job_stop, { ...f.scope, jobNumber: 1 });
		expect(await f.t.query(internal.ai_chat_files.poll_bash_job, { invocationId: job.invocationId })).toMatchObject({
			stopRequested: true,
		});

		// The watchdog marks the row while the worker is still alive: the flag stays false.
		const seededAt = Date.now();
		const overrun = await f.seed_job({ jobNumber: 2, status: "running" });
		vi.setSystemTime(seededAt + PLACEHOLDER_MS);
		await f.t.mutation(internal.ai_chat_files.timeout_bash_job, {
			invocationId: overrun.invocationId,
			expectedDeadlineAt: seededAt + PLACEHOLDER_MS,
		});
		expect(await f.t.query(internal.ai_chat_files.poll_bash_job, { invocationId: overrun.invocationId })).toEqual({
			status: "interrupted",
			stopRequested: false,
			authorized: true,
		});

		await f.t.run((ctx) => ctx.db.patch("organizations_workspaces_users", f.db.membershipId, { active: false }));
		expect(await f.t.query(internal.ai_chat_files.poll_bash_job, { invocationId: job.invocationId })).toMatchObject({
			authorized: false,
		});
		await f.t.run((ctx) => ctx.db.delete("ai_chat_bash_invocations", job.invocationId));
		expect(await f.t.query(internal.ai_chat_files.poll_bash_job, { invocationId: job.invocationId })).toEqual({
			status: "missing",
			stopRequested: false,
			authorized: false,
		});
	});

	test("an Agent-mode job loses its authorization when write permission is taken away, an Ask-mode job does not", async () => {
		const f = await fixture();
		const agentJob = await f.seed_job({ jobNumber: 1, status: "running", allowDbFilesMkdir: true });
		const askJob = await f.seed_job({ jobNumber: 2, status: "running" });

		// The fixture user created the organization, so they own it, and the owner passes every
		// permission check. Hand the organization to somebody else and give the user a real role, so
		// the role below is what decides.
		const assignmentId = await f.t.run(async (ctx) => {
			const otherOwnerId = await ctx.db.insert("users", { clerkUserId: null });
			await ctx.db.patch("organizations", f.db.organizationId, { ownerUserId: otherOwnerId });
			return await access_control_db_ensure_role_assignment(ctx, {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				userId: f.db.userId,
				role: "member",
				now: Date.now(),
			});
		});
		expect(await f.t.query(internal.ai_chat_files.poll_bash_job, { invocationId: agentJob.invocationId })).toEqual({
			status: "running",
			stopRequested: false,
			authorized: true,
		});

		// `viewer` holds `content.read` and not `content.write`: the job may keep reading, but an
		// Agent-mode job that can still write app files must be stopped within one poll.
		await f.t.run((ctx) => ctx.db.patch("access_control_role_assignments", assignmentId, { role: "viewer" }));
		expect(await f.t.query(internal.ai_chat_files.poll_bash_job, { invocationId: agentJob.invocationId })).toEqual({
			status: "running",
			stopRequested: false,
			authorized: false,
		});
		expect(await f.t.query(internal.ai_chat_files.poll_bash_job, { invocationId: askJob.invocationId })).toEqual({
			status: "running",
			stopRequested: false,
			authorized: true,
		});

		// The poll asks for `content.read` in both modes. A member who keeps the membership but holds no
		// role at all has no permission, so now neither job may keep running.
		await f.t.run((ctx) => ctx.db.delete("access_control_role_assignments", assignmentId));
		expect(await f.t.query(internal.ai_chat_files.poll_bash_job, { invocationId: agentJob.invocationId })).toEqual({
			status: "running",
			stopRequested: false,
			authorized: false,
		});
		expect(await f.t.query(internal.ai_chat_files.poll_bash_job, { invocationId: askJob.invocationId })).toEqual({
			status: "running",
			stopRequested: false,
			authorized: false,
		});
	});
});

describe("list_live_thread_jobs", () => {
	test("returns the caller's live jobs only", async () => {
		const f = await fixture();
		await f.seed_job({ jobNumber: 1, status: "queued" });
		await f.seed_job({ jobNumber: 2, status: "running" });
		await f.seed_job({ jobNumber: 3, status: "running", stopRequestedAt: Date.now() });
		const done = await f.seed_job({ jobNumber: 4, status: "running" });
		await f.t.mutation(internal.ai_chat_files.finish_bash_job, {
			invocationId: done.invocationId,
			result: job_result(0),
		});
		const mine = await f.asUser.query(api.ai_chat_files.list_live_thread_jobs, {
			membershipId: f.db.membershipId,
			threadId: f.scope.threadId,
		});
		expect(mine.map((job) => job.jobNumber)).toEqual([1, 2, 3]);
		// Another member sees none of these jobs.
		const other = await add_member(f, "bash-jobs-live");
		const theirs = await f.t
			.withIdentity({ issuer: "https://clerk.test", external_id: other.userId })
			.query(api.ai_chat_files.list_live_thread_jobs, {
				membershipId: other.membershipId,
				threadId: f.scope.threadId,
			});
		expect(theirs).toEqual([]);
	});
});

describe("list_thread_jobs", () => {
	test("live shows a job older than eight finished ones; newest is the 8-row window with the parent number", async () => {
		const f = await fixture();
		const live = await f.seed_job({ jobNumber: 1, status: "running" });
		for (let n = 2; n <= 10; n += 1) {
			const job = await f.seed_job({ jobNumber: n, status: "running", parentJobNumber: n === 10 ? 1 : undefined });
			await f.t.mutation(internal.ai_chat_files.finish_bash_job, {
				invocationId: job.invocationId,
				result: job_result(0),
			});
		}
		expect(await f.t.query(internal.ai_chat_files.list_thread_jobs, { ...f.scope, select: { kind: "live" } })).toEqual([
			{
				jobNumber: 1,
				status: "running",
				shellName: "default",
				scriptPreview: "sleep 1",
				parentJobNumber: null,
				invocationId: live.invocationId,
				startedAt: Date.now(),
				finishedAt: undefined,
			},
		]);
		const newest = await f.t.query(internal.ai_chat_files.list_thread_jobs, { ...f.scope, select: { kind: "newest" } });
		expect(newest.map((job) => job.jobNumber)).toEqual([10, 9, 8, 7, 6, 5, 4, 3]);
		expect(newest[0]).toMatchObject({ status: "succeeded", parentJobNumber: 1 });
		expect(
			(
				await f.t.query(internal.ai_chat_files.list_thread_jobs, {
					...f.scope,
					select: { kind: "numbers", jobNumbers: [3, 99, 1] },
				})
			).map((job) => job.jobNumber),
		).toEqual([3, 1]);

		// One index read per named number, so the door refuses a long list as well as `wait` does. A
		// validator cannot limit an array's length.
		await expect(
			f.t.query(internal.ai_chat_files.list_thread_jobs, {
				...f.scope,
				select: {
					kind: "numbers",
					jobNumbers: Array.from({ length: bash_JOB_NUMBERS_MAX_COUNT + 1 }, (_, n) => n + 1),
				},
			}),
		).rejects.toThrow("Too many job numbers");
	});

	test("shows only the caller's jobs and refuses a non-member", async () => {
		const f = await fixture();
		await f.seed_job({ jobNumber: 1, status: "running" });
		const other = await add_member(f, "bash-jobs-lister");
		for (const select of [
			{ kind: "live" as const },
			{ kind: "newest" as const },
			{ kind: "numbers" as const, jobNumbers: [1] },
		]) {
			expect(
				await f.t.query(internal.ai_chat_files.list_thread_jobs, { ...f.scope, userId: other.userId, select }),
			).toEqual([]);
		}
		const stranger = await f.t.run((ctx) => test_mocks_fill_db_with.membership(ctx, { organizationName: "elsewhere" }));
		await expect(
			f.t.query(internal.ai_chat_files.list_thread_jobs, {
				...f.scope,
				userId: stranger.userId,
				select: { kind: "live" },
			}),
		).rejects.toThrow("Unauthorized");
	});
});

describe("read_job_output", () => {
	test("keeps the stored result for 7 days, then answers with the Activity status and no result", async () => {
		const f = await fixture();
		const start = Date.now();
		const job = await f.seed_job({ jobNumber: 1, status: "running" });
		await f.t.mutation(internal.ai_chat_files.finish_bash_job, {
			invocationId: job.invocationId,
			result: job_result(0, "out\n"),
		});
		vi.setSystemTime(start + 7 * 24 * 60 * 60 * 1000 - 1);
		expect(await f.t.query(internal.ai_chat_files.read_job_output, { ...f.scope, jobNumber: 1 })).toMatchObject({
			activityStatus: "succeeded",
			result: { stdout: "out\n" },
		});
		vi.setSystemTime(start + 7 * 24 * 60 * 60 * 1000);
		await f.t.mutation(internal.ai_chat_files.cleanup_expired_bash_results, {});
		expect(await f.t.query(internal.ai_chat_files.read_job_output, { ...f.scope, jobNumber: 1 })).toMatchObject({
			activityStatus: "succeeded",
			result: null,
		});
		expect(await f.t.query(internal.ai_chat_files.read_job_output, { ...f.scope, jobNumber: 2 })).toBeNull();
	});
});

describe("read_job_exit_codes", () => {
	test("reads the Activity first, then the stored code, and reports 1 for a number that is not a job", async () => {
		const f = await fixture();
		const start = Date.now();
		// Job 1 is settled by the watchdog and its slow worker then stores the 0 of a script that
		// finished on its own. The Activity says timed out, so this door must too.
		const timedOut = await f.seed_job({ jobNumber: 1, status: "running" });
		vi.setSystemTime(start + PLACEHOLDER_MS);
		await f.t.mutation(internal.ai_chat_files.timeout_bash_job, {
			invocationId: timedOut.invocationId,
			expectedDeadlineAt: start + PLACEHOLDER_MS,
		});
		await f.t.mutation(internal.ai_chat_files.finish_bash_job, {
			invocationId: timedOut.invocationId,
			result: job_result(0, "late\n"),
		});
		// The row really holds the worker's own 0, so the 124 below is the Activity winning over it.
		expect(await f.t.query(internal.ai_chat_files.read_job_output, { ...f.scope, jobNumber: 1 })).toMatchObject({
			activityStatus: "timed_out",
			result: { metadata: { exitCode: 0 } },
		});
		// A script that exits 143 or 124 by itself is read back into the same two Activity statuses.
		const stopped = await f.seed_job({ jobNumber: 2, status: "running" });
		await f.t.mutation(internal.ai_chat_files.finish_bash_job, {
			invocationId: stopped.invocationId,
			result: job_result(143),
		});
		const failed = await f.seed_job({ jobNumber: 3, status: "running" });
		await f.t.mutation(internal.ai_chat_files.finish_bash_job, {
			invocationId: failed.invocationId,
			result: job_result(5),
		});

		// The stopped twin of job 1, and the only row whose code cannot come from a result: a Stop
		// settles the Activity and the worker never stores one. Reading the Activity is what turns this
		// into 143; the plain no-result fallback would say 1.
		const canceled = await f.seed_job({ jobNumber: 4, stopRequestedAt: Date.now() });
		await f.t.mutation(internal.ai_chat_files.handle_bash_job_complete, {
			workId: canceled.workId!,
			context: { invocationId: canceled.invocationId },
			result: { kind: "success", returnValue: null },
		});

		expect(
			await f.t.query(internal.ai_chat_files.read_job_exit_codes, { ...f.scope, jobNumbers: [1, 2, 3, 4, 99] }),
		).toEqual([
			{ jobNumber: 1, exitCode: 124 },
			{ jobNumber: 2, exitCode: 143 },
			{ jobNumber: 3, exitCode: 5 },
			{ jobNumber: 4, exitCode: 143 },
			{ jobNumber: 99, exitCode: 1 },
		]);
	});

	test("falls back to the Activity when the cleanup cron stripped the stored result", async () => {
		const f = await fixture();
		const start = Date.now();
		for (const [jobNumber, exitCode] of [
			[1, 0],
			[2, 5],
		]) {
			const job = await f.seed_job({ jobNumber: jobNumber!, status: "running" });
			await f.t.mutation(internal.ai_chat_files.finish_bash_job, {
				invocationId: job.invocationId,
				result: job_result(exitCode!),
			});
		}
		vi.setSystemTime(start + 7 * 24 * 60 * 60 * 1000);
		await f.t.mutation(internal.ai_chat_files.cleanup_expired_bash_results, {});

		// The stored 5 is gone, so the failed Activity reports the plain failure code instead.
		expect(await f.t.query(internal.ai_chat_files.read_job_exit_codes, { ...f.scope, jobNumbers: [1, 2] })).toEqual([
			{ jobNumber: 1, exitCode: 0 },
			{ jobNumber: 2, exitCode: 1 },
		]);
	});

	test("refuses a long list, hides another member's job, and refuses a non-member", async () => {
		const f = await fixture();
		await f.seed_job({ jobNumber: 1, status: "running" });
		await expect(
			f.t.query(internal.ai_chat_files.read_job_exit_codes, {
				...f.scope,
				jobNumbers: Array.from({ length: bash_JOB_NUMBERS_MAX_COUNT + 1 }, (_, n) => n + 1),
			}),
		).rejects.toThrow("Too many job numbers");

		const other = await add_member(f, "bash-jobs-code-reader");
		expect(
			await f.t.query(internal.ai_chat_files.read_job_exit_codes, {
				...f.scope,
				userId: other.userId,
				jobNumbers: [1],
			}),
		).toEqual([{ jobNumber: 1, exitCode: 1 }]);

		const stranger = await f.t.run((ctx) => test_mocks_fill_db_with.membership(ctx, { organizationName: "elsewhere" }));
		await expect(
			f.t.query(internal.ai_chat_files.read_job_exit_codes, {
				...f.scope,
				userId: stranger.userId,
				jobNumbers: [1],
			}),
		).rejects.toThrow("Unauthorized");
	});
});

describe("activities", () => {
	test("Stop records a cooperative stop and is a no-op on a stopping job", async () => {
		const f = await fixture();
		const job = await f.seed_job({ jobNumber: 1, status: "running" });
		const stop = () =>
			f.asUser.mutation(api.activities.request_stop, { membershipId: f.db.membershipId, activityId: job.activityId });
		expect(await stop()).toEqual({ _yay: null });
		const first = await f.read(job.invocationId);
		expect(first.row).toMatchObject({ status: "running", job: { stopRequestedAt: Date.now() } });
		expect(first.activity).toMatchObject({ status: "stopping" });
		vi.setSystemTime(Date.now() + 1000);
		expect(await stop()).toEqual({ _yay: null });
		expect(await f.read(job.invocationId)).toEqual(first);
	});

	test("recover_expired settles a stopping job as canceled and a running one as timed out, eight rows per pass", async () => {
		const f = await fixture();
		const start = Date.now();
		const stopping = await f.seed_job({ jobNumber: 1, status: "running", stopRequestedAt: start });
		const jobs: Awaited<ReturnType<typeof f.seed_job>>[] = [];
		for (let n = 2; n <= 10; n += 1) jobs.push(await f.seed_job({ jobNumber: n, status: "running" }));
		const now = start + PLACEHOLDER_MS;
		expect(
			await f.t.mutation(internal.activities.recover_expired, { _test_now: now, _test_disableReschedule: true }),
		).toEqual({ processedCount: 8, done: false });
		// `stopping` rows are read last, so the stopping job is in the second pass.
		expect((await f.read(stopping.invocationId)).activity).toMatchObject({ status: "stopping" });
		expect(
			await f.t.mutation(internal.activities.recover_expired, { _test_now: now, _test_disableReschedule: true }),
		).toEqual({ processedCount: 2, done: true });
		expect((await f.read(stopping.invocationId)).activity).toMatchObject({ status: "canceled" });
		for (const job of jobs) {
			const after = await f.read(job.invocationId);
			expect(after.row).toMatchObject({ status: "interrupted" });
			expect(after.activity).toMatchObject({ status: "timed_out" });
		}
	});

	test("cleanup_history deletes expired jobs with their Activities, eight rows per pass", async () => {
		const f = await fixture();
		const start = Date.now();
		const jobs: Awaited<ReturnType<typeof f.seed_job>>[] = [];
		for (let n = 1; n <= 9; n += 1) {
			const job = await f.seed_job({ jobNumber: n, status: "running" });
			await f.t.mutation(internal.ai_chat_files.finish_bash_job, {
				invocationId: job.invocationId,
				result: job_result(0),
			});
			jobs.push(job);
		}
		const expiresAt = start + 7 * 24 * 60 * 60 * 1000;
		expect(
			await f.t.mutation(internal.activities.cleanup_history, {
				_test_now: expiresAt - 1,
				_test_disableReschedule: true,
			}),
		).toEqual({ deletedCount: 0, done: true });
		expect(
			await f.t.mutation(internal.activities.cleanup_history, { _test_now: expiresAt, _test_disableReschedule: true }),
		).toEqual({ deletedCount: 16, done: false });
		expect(
			await f.t.mutation(internal.activities.cleanup_history, { _test_now: expiresAt, _test_disableReschedule: true }),
		).toEqual({ deletedCount: 2, done: true });
		for (const job of jobs) {
			const after = await f.read(job.invocationId);
			expect(after.row).toBeNull();
			expect(after.activity).toBeNull();
		}
		// The foreground call that launched them is not history.
		expect(await f.t.run((ctx) => ctx.db.get("ai_chat_bash_invocations", f.parent._id))).not.toBeNull();
	});
});

describe("ai_chat_files_db_delete_job_batch", () => {
	test("deletes the receipts, the Activity and the row in bounded passes", async () => {
		const f = await fixture();
		const job = await f.seed_job({ jobNumber: 1, status: "running" });
		await f.t.run(async (ctx) => {
			// A receipt outlives its cleaned-up run and Activity; only the ids must be real.
			const runId = await ctx.db.insert("files_transfer_runs", {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				userId: f.db.userId,
				requestId: "jobs-run",
				requestHash: "hash",
				kind: "copy",
				sourceView: "draft",
				publication: "proposal",
				origin: { kind: "agent", threadId: f.scope.threadId },
				targetParent: { kind: "root" },
				targetPath: "/",
				targetName: null,
				missingParentNames: [],
				preparedParent: null,
				fixedDeadline: false,
				conflictPolicy: { file: "error", folder: "merge" },
				step: "apply",
				planCursor: null,
				revision: 0,
				inFlight: 0,
				retryOf: null,
				retryCursor: null,
				applyToRemaining: { file: null, folder: null },
			});
			await ctx.db.delete("files_transfer_runs", runId);
			for (let n = 0; n < 3; n += 1) {
				await ctx.db.insert("ai_chat_bash_invocation_transfers", {
					organizationId: f.db.organizationId,
					workspaceId: f.db.workspaceId,
					threadId: f.scope.threadId,
					invocationId: job.invocationId,
					commandNumber: n,
					runId,
					activityId: job.activityId,
				});
			}
		});
		const run = async (batchSize: number) =>
			await f.t.run((ctx) => ai_chat_files_db_delete_job_batch(ctx, { invocationId: job.invocationId, batchSize }));
		expect(await run(2)).toEqual({ done: false, deletedCount: 2 });
		expect((await f.read(job.invocationId)).activity).not.toBeNull();
		expect(await run(2)).toEqual({ done: true, deletedCount: 3 });
		const after = await f.read(job.invocationId);
		expect(after.row).toBeNull();
		expect(after.activity).toBeNull();
		expect(await f.scheduled_state(job.watchdogId)).toBe("canceled");
		expect(await run(2)).toEqual({ done: true, deletedCount: 0 });
	});
});
