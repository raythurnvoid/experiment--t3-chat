import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import { ai_chat_files_db_get_bash_transfer, ai_chat_files_db_link_bash_transfer } from "./ai_chat_files.ts";
import { organizations_membership_lifetimes_db_record } from "./organizations_membership_lifetimes.ts";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import { files_ROOT_ID } from "../shared/files.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

async function fixture() {
	const t = test_convex();
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const thread = await asUser.mutation(api.ai_chat.thread_create, {
		membershipId: db.membershipId,
		clientGeneratedId: "bash-invocation-thread",
		lastMessageAt: Date.now(),
	});
	if (thread._nay) throw new Error(thread._nay.message);
	const args = {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: db.userId,
		threadId: thread._yay.threadId,
		toolCallId: "tool-call-1",
		commandHash: "a".repeat(64),
	};
	// Only begin takes the shell name; the lost-reply readback keeps the bare identity.
	const beginArgs = { ...args, shellName: "default" };
	return { t, db, asUser, args, beginArgs };
}

const result = {
	title: "printf ready",
	output: "ready",
	stdout: "ready",
	stderr: "",
	metadata: {
		command: "printf ready",
		cwd: "/tmp",
		nextCwd: "/tmp",
		exitCode: 0,
		stdoutTruncated: false,
		stderrTruncated: false,
		stdoutLength: 5,
		stderrLength: 0,
		pathIndexTruncated: false,
		observedPaths: [],
		observedPathsTruncated: false,
	},
};

describe("begin_bash_invocation", () => {
	test("claims one execution and keeps the first database deadlines on duplicate delivery", async () => {
		const f = await fixture();
		const now = Date.now();
		const first = await f.t.mutation(internal.ai_chat_files.begin_bash_invocation, f.beginArgs);
		expect(first._yay).toMatchObject({
			isNew: true,
			status: "running",
			membershipId: f.db.membershipId,
			deadlineAt: now + 120_000,
			transferDeadlineAt: now + 90_000,
			result: null,
			resultExpired: false,
		});
		vi.setSystemTime(now + 15_000);
		// Only the claim that created the shell returns the shell fields; a replay returns the bare claim.
		if (first._nay || !("shell" in first._yay)) throw new Error("Expected a fresh shell");
		const { shell, shells, notes, noticeAt, ...claim } = first._yay;
		expect(shell).toMatchObject({ name: "default", cwd: "~", cwdTarget: null, state: null });
		expect(shells).toEqual([{ _id: shell._id, name: "default" }]);
		expect(notes).toEqual([]);
		expect(noticeAt).toBeNull();
		const duplicate = await f.t.mutation(internal.ai_chat_files.begin_bash_invocation, f.beginArgs);
		expect(duplicate._yay).toEqual({ ...claim, isNew: false });
		expect(await f.t.run((ctx) => ctx.db.query("ai_chat_bash_invocations").collect())).toHaveLength(1);
		const changed = await f.t.mutation(internal.ai_chat_files.begin_bash_invocation, {
			...f.beginArgs,
			commandHash: "b".repeat(64),
		});
		expect(changed._nay?.name).toBe("invocation_changed");
	});

	test("never revives an interrupted command or an old membership lifetime", async () => {
		const f = await fixture();
		const first = await f.t.mutation(internal.ai_chat_files.begin_bash_invocation, f.beginArgs);
		if (first._nay) throw new Error(first._nay.message);
		await f.t.mutation(internal.ai_chat_files.interrupt_bash_invocation, { invocationId: first._yay.invocationId });
		const repeated = await f.t.mutation(internal.ai_chat_files.begin_bash_invocation, f.beginArgs);
		expect(repeated._yay).toMatchObject({ isNew: false, status: "interrupted" });
		const finishedLate = await f.t.mutation(internal.ai_chat_files.finish_bash_invocation, {
			invocationId: first._yay.invocationId,
			commandHash: f.args.commandHash,
			result,
		});
		expect(finishedLate._yay).toMatchObject({ status: "interrupted", result: null });
		await f.t.run(async (ctx) => {
			const membership = await ctx.db.get("organizations_workspaces_users", f.db.membershipId);
			if (!membership) throw new Error("Expected membership");
			await organizations_membership_lifetimes_db_record(ctx, [{ membership, active: false }]);
			await organizations_membership_lifetimes_db_record(ctx, [{ membership, active: true }]);
		});
		expect((await f.t.mutation(internal.ai_chat_files.begin_bash_invocation, f.beginArgs))._nay?.message).toBe(
			"Unauthorized",
		);
	});

	test("marks a lost interpreter interrupted at its original deadline", async () => {
		const f = await fixture();
		const first = await f.t.mutation(internal.ai_chat_files.begin_bash_invocation, f.beginArgs);
		if (first._nay) throw new Error(first._nay.message);
		await vi.advanceTimersByTimeAsync(120_001);
		await f.t.finishInProgressScheduledFunctions();
		const stored = await f.t.run((ctx) => ctx.db.get("ai_chat_bash_invocations", first._yay.invocationId));
		expect(stored?.status).toBe("interrupted");
		expect((await f.t.query(internal.ai_chat_files.get_bash_invocation, f.args))._yay).toMatchObject({
			isNew: false,
			status: "interrupted",
			result: null,
		});
	});
});

describe("finish_bash_invocation", () => {
	test("rejects a late result before a delayed watchdog runs", async () => {
		const f = await fixture();
		const begun = await f.t.mutation(internal.ai_chat_files.begin_bash_invocation, f.beginArgs);
		if (begun._nay) throw new Error(begun._nay.message);
		vi.setSystemTime(begun._yay.deadlineAt + 1);
		const finished = await f.t.mutation(internal.ai_chat_files.finish_bash_invocation, {
			invocationId: begun._yay.invocationId,
			commandHash: f.args.commandHash,
			result,
		});
		expect(finished._yay).toMatchObject({ status: "interrupted", result: null });
		const stored = await f.t.run((ctx) => ctx.db.get("ai_chat_bash_invocations", begun._yay.invocationId));
		expect(stored?.status).toBe("interrupted");
		expect(stored?.result).toBeUndefined();
	});

	test("replays the first result and leaves a terminal identity after seven days", async () => {
		const f = await fixture();
		const first = await f.t.mutation(internal.ai_chat_files.begin_bash_invocation, f.beginArgs);
		if (first._nay) throw new Error(first._nay.message);
		const finishArgs = { invocationId: first._yay.invocationId, commandHash: f.args.commandHash, result };
		await f.t.mutation(internal.ai_chat_files.finish_bash_invocation, finishArgs);
		const changedFinish = await f.t.mutation(internal.ai_chat_files.finish_bash_invocation, {
			...finishArgs,
			result: { ...result, stdout: "different" },
		});
		expect(changedFinish._yay?.result).toEqual(result);
		expect((await f.t.mutation(internal.ai_chat_files.begin_bash_invocation, f.beginArgs))._yay).toMatchObject({
			isNew: false,
			status: "finished",
			result,
			resultExpired: false,
		});
		vi.setSystemTime(Date.now() + 7 * 24 * 60 * 60 * 1000);
		expect((await f.t.query(internal.ai_chat_files.get_bash_invocation, f.args))._yay).toMatchObject({
			isNew: false,
			status: "finished",
			result: null,
			resultExpired: true,
		});
		await f.t.mutation(internal.ai_chat_files.cleanup_expired_bash_results, {});
		const tombstone = await f.t.run((ctx) => ctx.db.get("ai_chat_bash_invocations", first._yay.invocationId));
		expect(tombstone).toMatchObject({
			toolCallId: f.args.toolCallId,
			commandHash: f.args.commandHash,
			status: "finished",
		});
		expect(tombstone?.result).toBeUndefined();
		expect((await f.t.mutation(internal.ai_chat_files.begin_bash_invocation, f.beginArgs))._yay?.isNew).toBe(false);
	});

	test("stores a bounded replay when output exceeds the byte limit", async () => {
		const f = await fixture();
		const first = await f.t.mutation(internal.ai_chat_files.begin_bash_invocation, f.beginArgs);
		if (first._nay) throw new Error(first._nay.message);
		const large = "語".repeat(125_000);
		const finished = await f.t.mutation(internal.ai_chat_files.finish_bash_invocation, {
			invocationId: first._yay.invocationId,
			commandHash: f.args.commandHash,
			result: { ...result, output: large, stdout: large },
		});
		expect(finished._yay?.status).toBe("finished");
		expect(finished._yay?.result?.metadata.stdoutTruncated).toBe(true);
		expect(new TextEncoder().encode(JSON.stringify(finished._yay?.result)).byteLength).toBeLessThan(700 * 1024);
		expect((await f.t.query(internal.ai_chat_files.get_bash_invocation, f.args))._yay?.result).toEqual(
			finished._yay?.result,
		);
	});
});

describe("list_bash_invocation_transfers", () => {
	test("shows accepted jobs during execution, pages links, and hides them from another member", async () => {
		const f = await fixture();
		const first = await f.t.mutation(internal.ai_chat_files.begin_bash_invocation, f.beginArgs);
		if (first._nay) throw new Error(first._nay.message);
		const source = await f.asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: f.db.membershipId,
			parentId: files_ROOT_ID,
			path: "source",
		});
		if (source._nay) throw new Error(source._nay.message);
		const started = await f.asUser.mutation(api.files_transfer.start, {
			membershipId: f.db.membershipId,
			requestId: "linked-job",
			sourceIds: [source._yay.nodeId],
			kind: "copy",
			targetParentId: files_ROOT_ID,
		});
		if (started._nay) throw new Error(started._nay.message);
		const activity = await f.t.run((ctx) =>
			ctx.db
				.query("activities")
				.withIndex("by_source_id", (q) => q.eq("source.id", started._yay.runId))
				.first(),
		);
		if (!activity) throw new Error("Expected transfer activity");
		const linkArgs = {
			invocationId: first._yay.invocationId,
			commandNumber: 1,
			runId: started._yay.runId,
			activityId: activity._id,
		};
		const linked = await f.t.run((ctx) => ai_chat_files_db_link_bash_transfer(ctx, linkArgs));
		expect(linked._nay).toBeUndefined();
		expect(await f.t.run((ctx) => ai_chat_files_db_get_bash_transfer(ctx, linkArgs))).toEqual(linked._yay);
		await f.t.run((ctx) => ai_chat_files_db_link_bash_transfer(ctx, linkArgs));
		await f.t.run((ctx) => ai_chat_files_db_link_bash_transfer(ctx, { ...linkArgs, commandNumber: 2 }));
		const queryArgs = {
			membershipId: f.db.membershipId,
			threadId: f.args.threadId,
			toolCallId: f.args.toolCallId,
			paginationOpts: { cursor: null, numItems: 1 },
		};
		const page1 = await f.asUser.query(api.ai_chat_files.list_bash_invocation_transfers, queryArgs);
		expect(page1).toMatchObject({
			status: "running",
			page: [{ commandNumber: 1, activityId: activity._id }],
			isDone: false,
		});
		const page2 = await f.asUser.query(api.ai_chat_files.list_bash_invocation_transfers, {
			...queryArgs,
			paginationOpts: { cursor: page1!.continueCursor, numItems: 1 },
		});
		expect(page2).toMatchObject({ page: [{ commandNumber: 2 }], isDone: true });
		const other = await f.t.run(async (ctx) => {
			const userId = await ctx.db.insert("users", { clerkUserId: "other-bash-member" });
			const membershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				userId,
				active: true,
				updatedAt: Date.now(),
			});
			return { userId, membershipId };
		});
		const asOther = f.t.withIdentity({ issuer: "https://clerk.test", external_id: other.userId });
		expect(
			await asOther.query(api.ai_chat_files.list_bash_invocation_transfers, {
				...queryArgs,
				membershipId: other.membershipId,
			}),
		).toBeNull();
		await f.t.mutation(internal.ai_chat_files.interrupt_bash_invocation, { invocationId: first._yay.invocationId });
		const lateLink = await f.t.run((ctx) =>
			ai_chat_files_db_link_bash_transfer(ctx, { ...linkArgs, commandNumber: 3 }),
		);
		expect(lateLink._nay?.name).toBe("invocation_interrupted");
		expect(await f.t.run((ctx) => ctx.db.query("ai_chat_bash_invocation_transfers").collect())).toHaveLength(2);
	});
});
