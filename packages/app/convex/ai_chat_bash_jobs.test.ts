import { Workpool, type WorkId } from "@convex-dev/workpool";
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

	test("counts live jobs across the workspace, stopping ones too, and refuses the 5th", async () => {
		const f = await fixture();
		for (let n = 1; n <= 3; n += 1) await f.seed_job({ jobNumber: n, status: "running" });
		await f.seed_job({ jobNumber: 4, status: "running", stopRequestedAt: Date.now() });
		const refused = await launch(f);
		expect(refused._nay).toMatchObject({
			name: "limit",
			message: "4 jobs are already active across your workspace (queued, running or stopping). Try `jobs`, or wait.",
		});
		expect(await job_rows(f)).toHaveLength(4);
	});

	test("a job may start a child, but not while it is stopping or after its Activity is gone", async () => {
		const f = await fixture();
		const parent = await f.seed_job({ jobNumber: 1, status: "running" });
		expect(await launch(f, { parentInvocationId: parent.invocationId })).toEqual({ _yay: { jobNumber: 1 } });
		const child = (await job_rows(f)).find((row) => row.job?.parentInvocationId === parent.invocationId);
		if (!child) throw new Error("Expected the child row");
		expect((await f.read(child._id)).activity).toMatchObject({ source: { parentJobNumber: 1 } });

		const stopping = await f.seed_job({ jobNumber: 8, status: "running", stopRequestedAt: Date.now() });
		expect(
			(await launch(f, { parentInvocationId: stopping.invocationId, commandNumber: 1 }))._nay?.message,
		).toBe("the parent job has ended or is stopping");
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
	const begin = async (f: Awaited<ReturnType<typeof fixture>>, toolCallId: string) => {
		const begun = await f.t.mutation(internal.ai_chat_files.begin_bash_invocation, {
			...f.scope,
			toolCallId,
			commandHash: "d".repeat(64),
			shellName: "default",
		});
		if (begun._nay) throw new Error(begun._nay.message);
		return begun._yay;
	};

	const cursor_rows = async (f: Awaited<ReturnType<typeof fixture>>) =>
		await f.t.run((ctx) => ctx.db.query("ai_chat_bash_job_notice_cursors").collect());

	test("notes a finished job once, on a fresh call only, and keeps no cursor before the first job", async () => {
		const f = await fixture();
		// The fixture's own call ran before any job: no cursor row yet.
		expect(await cursor_rows(f)).toEqual([]);
		const finishedAt = Date.now();
		const job = await f.seed_job({ jobNumber: 1, status: "running" });
		await f.t.mutation(internal.ai_chat_files.finish_bash_job, { invocationId: job.invocationId, result: job_result(0) });
		const live = await f.seed_job({ jobNumber: 2, status: "running" });

		vi.setSystemTime(finishedAt + 1000);
		const first = await begin(f, "notes-1");
		if (!("notes" in first)) throw new Error("Expected a fresh call");
		expect(first.notes).toEqual([{ jobNumber: 1, status: "succeeded", shellName: "default" }]);
		expect(await cursor_rows(f)).toMatchObject([{ userId: f.db.userId, threadId: f.scope.threadId, noticeAt: finishedAt + 999 }]);
		// The rejoin of that call carries no notes, and the next fresh call has nothing new.
		expect("notes" in (await begin(f, "notes-1"))).toBe(false);
		const second = await begin(f, "notes-2");
		if (!("notes" in second)) throw new Error("Expected a fresh call");
		expect(second.notes).toEqual([]);

		// A job finished in the same millisecond as the previous begin is still noted (`now - 1`).
		await f.t.mutation(internal.ai_chat_files.finish_bash_job, { invocationId: live.invocationId, result: job_result(1) });
		const third = await begin(f, "notes-3");
		if (!("notes" in third)) throw new Error("Expected a fresh call");
		expect(third.notes).toEqual([{ jobNumber: 2, status: "failed", shellName: "default" }]);
	});

	test("one member's call does not hide another member's notes", async () => {
		const f = await fixture();
		const job = await f.seed_job({ jobNumber: 1, status: "running" });
		await f.t.mutation(internal.ai_chat_files.finish_bash_job, { invocationId: job.invocationId, result: job_result(0) });
		vi.setSystemTime(Date.now() + 1000);
		const other = await add_member(f, "bash-jobs-noted");
		const otherCall = await f.t.mutation(internal.ai_chat_files.begin_bash_invocation, {
			...f.scope,
			userId: other.userId,
			toolCallId: "other-notes",
			commandHash: "d".repeat(64),
			shellName: "default",
		});
		if (otherCall._nay || !("notes" in otherCall._yay)) throw new Error("Expected the other member's fresh call");
		// The job is the fixture user's, so the other member has nothing to note.
		expect(otherCall._yay.notes).toEqual([]);
		const mine = await begin(f, "notes-1");
		if (!("notes" in mine)) throw new Error("Expected a fresh call");
		expect(mine.notes).toEqual([{ jobNumber: 1, status: "succeeded", shellName: "default" }]);
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
		expect(await f.t.mutation(internal.ai_chat_files.claim_bash_job, { invocationId: stopping.invocationId })).toBeNull();
		expect((await f.read(stopping.invocationId)).activity).toMatchObject({ status: "stopping" });

		// The flag alone, with the Activity still queued, is also final.
		const flagged = await f.seed_job({ jobNumber: 2, stopRequestedAt: Date.now() });
		await f.t.run((ctx) => ctx.db.patch("activities", flagged.activityId, { status: "queued" }));
		expect(await f.t.mutation(internal.ai_chat_files.claim_bash_job, { invocationId: flagged.invocationId })).toBeNull();
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
		await f.t.mutation(internal.ai_chat_files.finish_bash_job, { invocationId: job.invocationId, result: job_result(0) });
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

	test("accepts an interrupted row, refuses a finished one, and keeps a watchdog's timed_out on a late finish", async () => {
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
		expect(late.transcript).toHaveLength(3);

		await f.t.mutation(internal.ai_chat_files.finish_bash_job, {
			invocationId: job.invocationId,
			result: job_result(1, "again\n"),
		});
		const again = await f.read(job.invocationId);
		expect(again.row).toMatchObject({ result: { stdout: "late\n" } });
		expect(again.transcript).toHaveLength(3);
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
		await f.t.mutation(internal.ai_chat_files.handle_bash_job_complete, callback(job.invocationId, job.workId!, "failed"));
		const after = await f.read(job.invocationId);
		expect(after.row).toMatchObject({ status: "interrupted" });
		expect(after.activity).toMatchObject({ status: "failed", errorMessage: "Background command crashed" });
		expect(after.transcript[1]).toContain("job 1 finished (exit 1)");
	});

	test("a Stop on a queued job settles canceled and the row is interrupted", async () => {
		const f = await fixture();
		const job = await f.seed_job({ jobNumber: 1, stopRequestedAt: Date.now() });
		await f.t.mutation(internal.ai_chat_files.handle_bash_job_complete, callback(job.invocationId, job.workId!, "canceled"));
		const after = await f.read(job.invocationId);
		expect(after.row).toMatchObject({ status: "interrupted" });
		expect(after.activity).toMatchObject({ status: "canceled" });
	});

	test("a success after a stop settles canceled; a plain success and a superseded worker do nothing", async () => {
		const f = await fixture();
		const plain = await f.seed_job({ jobNumber: 1, status: "running" });
		await f.t.mutation(internal.ai_chat_files.handle_bash_job_complete, callback(plain.invocationId, plain.workId!, "success"));
		expect((await f.read(plain.invocationId)).activity).toMatchObject({ status: "running" });

		const stopped = await f.seed_job({ jobNumber: 2, stopRequestedAt: Date.now() });
		await f.t.mutation(
			internal.ai_chat_files.handle_bash_job_complete,
			callback(stopped.invocationId, "other" as WorkId, "success"),
		);
		expect((await f.read(stopped.invocationId)).activity).toMatchObject({ status: "stopping" });
		await f.t.mutation(internal.ai_chat_files.handle_bash_job_complete, callback(stopped.invocationId, stopped.workId!, "success"));
		expect((await f.read(stopped.invocationId)).activity).toMatchObject({ status: "canceled" });

		await f.t.run((ctx) => ctx.db.delete("ai_chat_bash_invocations", plain.invocationId));
		await expect(
			f.t.mutation(internal.ai_chat_files.handle_bash_job_complete, callback(plain.invocationId, plain.workId!, "failed")),
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

describe("list_thread_jobs", () => {
	test("live shows a job older than eight finished ones; newest is the 8-row window with the parent number", async () => {
		const f = await fixture();
		const live = await f.seed_job({ jobNumber: 1, status: "running" });
		for (let n = 2; n <= 10; n += 1) {
			const job = await f.seed_job({ jobNumber: n, status: "running", parentJobNumber: n === 10 ? 1 : undefined });
			await f.t.mutation(internal.ai_chat_files.finish_bash_job, { invocationId: job.invocationId, result: job_result(0) });
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
				select: { kind: "numbers", jobNumbers: Array.from({ length: bash_JOB_NUMBERS_MAX_COUNT + 1 }, (_, n) => n + 1) },
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
			expect(await f.t.query(internal.ai_chat_files.list_thread_jobs, { ...f.scope, userId: other.userId, select })).toEqual(
				[],
			);
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
	test("returns the stored result for 7 days, then the Activity status for a stripped one", async () => {
		const f = await fixture();
		const start = Date.now();
		const job = await f.seed_job({ jobNumber: 1, status: "running" });
		await f.t.mutation(internal.ai_chat_files.finish_bash_job, {
			invocationId: job.invocationId,
			result: job_result(0, "out\n"),
		});
		vi.setSystemTime(start + 7 * 24 * 60 * 60 * 1000 - 1);
		expect(await f.t.query(internal.ai_chat_files.read_job_output, { ...f.scope, jobNumber: 1 })).toMatchObject({
			invocationId: job.invocationId,
			status: "finished",
			activityStatus: "succeeded",
			result: { stdout: "out\n" },
			resultExpired: false,
		});
		vi.setSystemTime(start + 7 * 24 * 60 * 60 * 1000);
		await f.t.mutation(internal.ai_chat_files.cleanup_expired_bash_results, {});
		expect(await f.t.query(internal.ai_chat_files.read_job_output, { ...f.scope, jobNumber: 1 })).toMatchObject({
			status: "finished",
			activityStatus: "succeeded",
			result: null,
			resultExpired: true,
		});
		expect(await f.t.query(internal.ai_chat_files.read_job_output, { ...f.scope, jobNumber: 2 })).toBeNull();
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
			await f.t.mutation(internal.ai_chat_files.finish_bash_job, { invocationId: job.invocationId, result: job_result(0) });
			jobs.push(job);
		}
		const expiresAt = start + 7 * 24 * 60 * 60 * 1000;
		expect(
			await f.t.mutation(internal.activities.cleanup_history, { _test_now: expiresAt - 1, _test_disableReschedule: true }),
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
