import { describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { ai_chat_runs_db_insert_node, ai_chat_runs_LEASE_MS } from "./ai_chat_runs.ts";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import { ai_chat_DEFAULT_MODEL_ID } from "../shared/ai-chat.ts";

async function fixture() {
	const t = test_convex();
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const thread = await asUser.mutation(api.ai_chat.thread_create, {
		membershipId: db.membershipId,
		clientGeneratedId: "runs-thread",
		lastMessageAt: Date.now(),
	});
	if (thread._nay) throw new Error(thread._nay.message);
	const captured = await t.mutation(internal.ai_chat_workspaces.capture, {
		userId: db.userId,
		membershipId: db.membershipId,
	});
	if (captured._nay) throw new Error(captured._nay.message);
	const source = {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		threadId: thread._yay.threadId,
		userId: db.userId,
		membershipId: db.membershipId,
		membershipLifetime: captured._yay.membershipLifetime,
	};
	return { t, asUser, db, source };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/**
 * Send one user message the way `/api/chat` does, and return the run it starts.
 */
async function begin_turn(fx: Fixture, args: { messageId: string; parentId: string | null }) {
	const begun = await fx.t.mutation(internal.ai_chat.thread_run_begin, {
		source: fx.source,
		parentId: args.parentId,
		messages: [
			{
				clientGeneratedMessageId: args.messageId,
				content: { id: args.messageId, role: "user", parts: [{ type: "text", text: args.messageId }] },
			},
		],
		modeId: "agent",
		modelId: ai_chat_DEFAULT_MODEL_ID,
	});
	if (begun._nay) throw new Error(begun._nay.message);
	return begun._yay;
}

/**
 * Save one text step and end the run, like a turn that answered with one model call.
 */
async function answer_turn(fx: Fixture, run: { runId: Id<"ai_chat_runs">; generation: number }, text: string) {
	await fx.t.mutation(internal.ai_chat_runs.step_complete, {
		runId: run.runId,
		generation: run.generation,
		stepIndex: 0,
		parts: [{ type: "step-start" }, { type: "text", text, state: "done" }],
		finishReason: "stop",
	});
	await fx.t.mutation(internal.ai_chat_runs.finish, {
		runId: run.runId,
		generation: run.generation,
		outcome: "done",
		tail: null,
	});
}

describe("thread_run_begin", () => {
	test("saves the message and a streaming reply, and refuses a second run while the first is live", async () => {
		const fx = await fixture();
		const first = await begin_turn(fx, { messageId: "user-1", parentId: null });

		const reply = await fx.t.run((ctx) => ctx.db.get("ai_chat_threads_messages_aisdk_5", first.replyId));
		expect(reply).toMatchObject({ parentId: first.triggerId, status: "streaming", runId: first.runId });
		const thread = await fx.t.run((ctx) => ctx.db.get("ai_chat_threads", fx.source.threadId));
		expect(thread?.activeRun).toMatchObject({ kind: "chat", runId: first.runId, generation: 1 });
		expect(thread?.newestNodeId).toBe(first.replyId);

		const second = await fx.t.mutation(internal.ai_chat.thread_run_begin, {
			source: fx.source,
			parentId: first.replyId,
			messages: [
				{
					clientGeneratedMessageId: "user-2",
					content: { id: "user-2", role: "user", parts: [{ type: "text", text: "user-2" }] },
				},
			],
			modeId: "agent",
			modelId: ai_chat_DEFAULT_MODEL_ID,
		});
		expect(second._nay?.data).toMatchObject({ status: 409 });
		// The browser checks again after a few seconds, not at the lease end.
		expect(
			second._nay?.data && "retryAfterMs" in second._nay.data ? second._nay.data.retryAfterMs : null,
		).toBeLessThanOrEqual(5_000);
		const nodes = await fx.t.run((ctx) =>
			ctx.db
				.query("ai_chat_threads_messages_aisdk_5")
				.withIndex("by_thread_parent", (q) => q.eq("threadId", fx.source.threadId))
				.collect(),
		);
		expect(nodes.map((node) => node.clientGeneratedMessageId)).not.toContain("user-2");
	});
});

describe("stop", () => {
	test("raises the generation, and the old generation can only save its last step through finish", async () => {
		const fx = await fixture();
		const run = await begin_turn(fx, { messageId: "user-1", parentId: null });

		// A Stop for another reply (a run that already ended) leaves this run alone.
		await fx.asUser.mutation(api.ai_chat_runs.stop, {
			membershipId: fx.db.membershipId,
			threadId: fx.source.threadId,
			replyId: run.triggerId,
		});
		expect(await fx.t.run((ctx) => ctx.db.get("ai_chat_runs", run.runId))).toMatchObject({
			status: "running",
			generation: 1,
		});

		const stopped = await fx.asUser.mutation(api.ai_chat_runs.stop, {
			membershipId: fx.db.membershipId,
			threadId: fx.source.threadId,
			replyId: run.replyId,
		});
		expect(stopped._nay).toBeUndefined();
		expect(await fx.t.run((ctx) => ctx.db.get("ai_chat_runs", run.runId))).toMatchObject({
			status: "stopping",
			generation: 2,
		});

		// Every fenced door refuses the old generation.
		const stepSaved = await fx.t.mutation(internal.ai_chat_runs.step_complete, {
			runId: run.runId,
			generation: run.generation,
			stepIndex: 0,
			parts: [{ type: "text", text: "late", state: "done" }],
			finishReason: "stop",
		});
		expect(stepSaved).toEqual({ saved: false });
		const receipt = await fx.t.mutation(internal.ai_chat_runs.tool_receipt_begin, {
			runId: run.runId,
			generation: run.generation,
			opKey: "op-1",
			toolName: "bash",
			inputHash: "hash-1",
		});
		expect(receipt.kind).toBe("refused");

		await fx.t.mutation(internal.ai_chat_runs.finish, {
			runId: run.runId,
			generation: run.generation,
			outcome: "stopped",
			tail: {
				stepIndex: 0,
				parts: [
					{ type: "step-start" },
					{ type: "reasoning", text: "", state: "done", providerMetadata: { openai: { itemId: "rs_1" } } },
					{ type: "text", text: "half", state: "streaming", providerMetadata: { openai: { itemId: "msg_1" } } },
				],
			},
		});

		const steps = await fx.t.run((ctx) =>
			ctx.db
				.query("ai_chat_run_steps")
				.withIndex("by_message_stepIndex", (q) => q.eq("messageId", run.replyId))
				.collect(),
		);
		expect(steps).toHaveLength(1);
		expect(steps[0]).toMatchObject({ status: "partial", generation: 1 });
		// OpenAI keeps no items of a response that never finished. The next turn must not send their ids.
		expect(steps[0]?.parts.some((part: Record<string, unknown>) => "providerMetadata" in part)).toBe(false);
		expect(await fx.t.run((ctx) => ctx.db.get("ai_chat_threads_messages_aisdk_5", run.replyId))).toMatchObject({
			status: "stopped",
		});
		expect(await fx.t.run((ctx) => ctx.db.get("ai_chat_runs", run.runId))).toMatchObject({ status: "ended" });
		expect((await fx.t.run((ctx) => ctx.db.get("ai_chat_threads", fx.source.threadId)))?.activeRun).toBeUndefined();

		// The next turn starts at once.
		const next = await begin_turn(fx, { messageId: "user-2", parentId: run.replyId });
		expect(next.generation).toBe(1);
	});

	test("ends a stopped run whose action never calls finish, and logs a tail that comes later", async () => {
		vi.useFakeTimers();
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const fx = await fixture();
			const run = await begin_turn(fx, { messageId: "user-1", parentId: null });
			await fx.asUser.mutation(api.ai_chat_runs.stop, {
				membershipId: fx.db.membershipId,
				threadId: fx.source.threadId,
				replyId: run.replyId,
			});

			// Before the grace passes, the action may still call finish.
			vi.advanceTimersByTime(29_000);
			await fx.t.finishInProgressScheduledFunctions();
			expect(await fx.t.run((ctx) => ctx.db.get("ai_chat_runs", run.runId))).toMatchObject({ status: "stopping" });

			vi.advanceTimersByTime(1_000);
			await fx.t.finishInProgressScheduledFunctions();
			expect(await fx.t.run((ctx) => ctx.db.get("ai_chat_runs", run.runId))).toMatchObject({ status: "ended" });
			expect(await fx.t.run((ctx) => ctx.db.get("ai_chat_threads_messages_aisdk_5", run.replyId))).toMatchObject({
				status: "stopped",
			});
			expect((await fx.t.run((ctx) => ctx.db.get("ai_chat_threads", fx.source.threadId)))?.activeRun).toBeUndefined();

			await fx.t.mutation(internal.ai_chat_runs.finish, {
				runId: run.runId,
				generation: run.generation,
				outcome: "stopped",
				tail: { stepIndex: 0, parts: [{ type: "text", text: "PRIVATE_LATE_TEXT", state: "streaming" }] },
			});
			const lostLogs = consoleError.mock.calls.filter((call) => call[0] === "Chat data not saved");
			const ids = { threadId: fx.source.threadId, runId: run.runId, messageId: run.replyId };
			expect(lostLogs).toEqual([
				["Chat data not saved", { reason: "finish_missing", ...ids }],
				["Chat data not saved", { reason: "run_already_ended", ...ids }],
			]);
			expect(JSON.stringify(lostLogs)).not.toContain("PRIVATE_LATE_TEXT");
		} finally {
			consoleError.mockRestore();
			vi.useRealTimers();
		}
	});
});

describe("step_complete", () => {
	test("stops the run and saves no reply after the member lost access", async () => {
		const fx = await fixture();
		const run = await begin_turn(fx, { messageId: "user-1", parentId: null });
		await fx.t.run((ctx) => ctx.db.patch("organizations_workspaces_users", fx.db.membershipId, { active: false }));

		const saved = await fx.t.mutation(internal.ai_chat_runs.step_complete, {
			runId: run.runId,
			generation: run.generation,
			stepIndex: 0,
			parts: [{ type: "text", text: "after access loss", state: "done" }],
			finishReason: "stop",
		});
		expect(saved).toEqual({ saved: false });
		expect(await fx.t.run((ctx) => ctx.db.get("ai_chat_runs", run.runId))).toMatchObject({
			status: "stopping",
			generation: 2,
		});

		await fx.t.mutation(internal.ai_chat_runs.finish, {
			runId: run.runId,
			generation: run.generation,
			outcome: "stopped",
			tail: { stepIndex: 0, parts: [{ type: "text", text: "after access loss", state: "done" }] },
		});
		const steps = await fx.t.run((ctx) =>
			ctx.db
				.query("ai_chat_run_steps")
				.withIndex("by_message_stepIndex", (q) => q.eq("messageId", run.replyId))
				.collect(),
		);
		expect(steps).toEqual([]);
	});
});

describe("tool_receipt_begin", () => {
	test("replays a finished call and refuses another input or a call that never finished", async () => {
		const fx = await fixture();
		const run = await begin_turn(fx, { messageId: "user-1", parentId: null });
		const receipt = { runId: run.runId, generation: run.generation, toolName: "bash" };

		expect(
			await fx.t.mutation(internal.ai_chat_runs.tool_receipt_begin, { ...receipt, opKey: "op-1", inputHash: "a" }),
		).toEqual({
			kind: "start",
		});
		await fx.t.mutation(internal.ai_chat_runs.tool_receipt_finish, {
			threadId: fx.source.threadId,
			opKey: "op-1",
			result: { exitCode: 0 },
		});
		expect(
			await fx.t.mutation(internal.ai_chat_runs.tool_receipt_begin, { ...receipt, opKey: "op-1", inputHash: "a" }),
		).toEqual({
			kind: "replay",
			result: { exitCode: 0 },
		});
		expect(
			(await fx.t.mutation(internal.ai_chat_runs.tool_receipt_begin, { ...receipt, opKey: "op-1", inputHash: "b" }))
				.kind,
		).toBe("refused");

		// A started call may have written already, so it never runs twice.
		await fx.t.mutation(internal.ai_chat_runs.tool_receipt_begin, { ...receipt, opKey: "op-2", inputHash: "a" });
		expect(
			(await fx.t.mutation(internal.ai_chat_runs.tool_receipt_begin, { ...receipt, opKey: "op-2", inputHash: "a" }))
				.kind,
		).toBe("refused");
	});
});

describe("branch_page", () => {
	test("returns the shown branch newest first, with siblings and the reply parts from its steps", async () => {
		const fx = await fixture();
		const turn1 = await begin_turn(fx, { messageId: "user-1", parentId: null });
		await answer_turn(fx, turn1, "answer-1");
		const turn2 = await begin_turn(fx, { messageId: "user-2", parentId: turn1.replyId });
		await answer_turn(fx, turn2, "answer-2");
		// An edit of the second message makes a sibling branch. It is the newest one.
		const edit = await begin_turn(fx, { messageId: "user-2-edit", parentId: turn1.replyId });
		await answer_turn(fx, edit, "answer-2-edit");

		const pageArgs = { membershipId: fx.db.membershipId, threadId: fx.source.threadId, fromId: null, stopId: null };
		const newest = await fx.asUser.query(api.ai_chat_runs.branch_page, { ...pageArgs, anchorId: null });
		expect(newest?.nodes.map((node) => node.clientGeneratedMessageId)).toEqual([
			edit.replyClientGeneratedId,
			"user-2-edit",
			turn1.replyClientGeneratedId,
			"user-1",
		]);
		expect(newest?.nextId).toBeNull();
		expect(newest?.nodes[0]?.content.parts).toEqual([
			{ type: "step-start" },
			{ type: "text", text: "answer-2-edit", state: "done" },
		]);
		expect(newest?.nodes[1]?.siblingIds).toEqual([turn2.triggerId, edit.triggerId]);

		// The anchor picks the older branch.
		const older = await fx.asUser.query(api.ai_chat_runs.branch_page, { ...pageArgs, anchorId: turn2.triggerId });
		expect(older?.nodes.map((node) => node._id)).toEqual([
			turn2.replyId,
			turn2.triggerId,
			turn1.replyId,
			turn1.triggerId,
		]);

		// Paging: the newest page stops where the loaded older page starts.
		const top = await fx.asUser.query(api.ai_chat_runs.branch_page, {
			...pageArgs,
			anchorId: null,
			stopId: turn1.replyId,
		});
		expect(top?.nodes.map((node) => node._id)).toEqual([edit.replyId, edit.triggerId]);
		expect(top?.nextId).toBe(turn1.replyId);
		const bottom = await fx.asUser.query(api.ai_chat_runs.branch_page, {
			...pageArgs,
			anchorId: null,
			fromId: turn1.replyId,
		});
		expect(bottom?.nodes.map((node) => node._id)).toEqual([turn1.replyId, turn1.triggerId]);
	});

	test("returns null for a chat of another user", async () => {
		const fx = await fixture();
		const other = await fx.t.run((ctx) => test_mocks_fill_db_with.membership(ctx, { organizationName: "other-org" }));
		const asOther = fx.t.withIdentity({ issuer: "https://clerk.test", external_id: other.userId });
		expect(
			await asOther.query(api.ai_chat_runs.branch_page, {
				membershipId: other.membershipId,
				threadId: fx.source.threadId,
				anchorId: null,
				fromId: null,
				stopId: null,
			}),
		).toBeNull();
	});
});

describe("history_page", () => {
	test("a page stops at 256 nodes before the budget is full, and the next page goes on from there", async () => {
		const fx = await fixture();
		const leafId = await fx.t.run(async (ctx) => {
			const thread = (await ctx.db.get("ai_chat_threads", fx.source.threadId))!;
			let parentId: Id<"ai_chat_threads_messages_aisdk_5"> | null = null;
			for (let index = 0; index < 300; index++) {
				const id = `message-${index}`;
				parentId = await ai_chat_runs_db_insert_node(ctx, {
					thread,
					parentId,
					createdBy: fx.db.userId,
					clientGeneratedMessageId: id,
					content: { id, role: "user", parts: [{ type: "text", text: id }] },
					status: "done",
					runId: null,
					wakePending: false,
					jobFinishInvocationId: null,
					newest: "set",
					now: Date.now(),
				});
			}
			return parentId!;
		});
		const page = (args: { fromId: Id<"ai_chat_threads_messages_aisdk_5">; usedBytes: number; maxBytes: number }) =>
			fx.t.query(internal.ai_chat_runs.history_page, {
				threadId: fx.source.threadId,
				...args,
				hasUserMessage: args.usedBytes > 0,
			});

		const first = await page({ fromId: leafId, usedBytes: 0, maxBytes: 1024 * 1024 });
		expect(first).toMatchObject({ full: false, hasUserMessage: true });
		expect(first.messages).toHaveLength(256);
		const second = await page({ fromId: first.nextId!, usedBytes: first.usedBytes, maxBytes: 1024 * 1024 });
		expect(second.messages).toHaveLength(44);
		expect(second).toMatchObject({ nextId: null, full: false });

		// A small budget stops the walk and says so.
		const small = await page({ fromId: leafId, usedBytes: 0, maxBytes: first.messages[0]!.bytes * 3 });
		expect(small.messages).toHaveLength(3);
		expect(small.full).toBe(true);
	});
});

describe("end_expired_runs", () => {
	test("ends runs whose lease passed and gives the thread lease back", async () => {
		const fx = await fixture();
		const { runId } = await begin_turn(fx, { messageId: "user-1", parentId: null });
		const beganAt = Date.now();

		// Before the lease passes, the watchdog leaves the run alone.
		await fx.t.mutation(internal.ai_chat_runs.end_expired_runs, { _test_now: beganAt + 1000 });
		expect(await fx.t.run((ctx) => ctx.db.get("ai_chat_runs", runId))).toMatchObject({ status: "running" });
		expect((await fx.t.run((ctx) => ctx.db.get("ai_chat_threads", fx.source.threadId)))?.activeRun?.kind).toBe("chat");

		const later = beganAt + ai_chat_runs_LEASE_MS + 1000;
		await fx.t.mutation(internal.ai_chat_runs.end_expired_runs, { _test_now: later });
		expect(await fx.t.run((ctx) => ctx.db.get("ai_chat_runs", runId))).toMatchObject({
			status: "ended",
			endedAt: later,
		});
		expect((await fx.t.run((ctx) => ctx.db.get("ai_chat_threads", fx.source.threadId)))?.activeRun).toBeUndefined();
	});

	test("ends a stopped run whose action never called finish as stopped", async () => {
		const fx = await fixture();
		const run = await begin_turn(fx, { messageId: "user-1", parentId: null });
		await fx.asUser.mutation(api.ai_chat_runs.stop, {
			membershipId: fx.db.membershipId,
			threadId: fx.source.threadId,
			replyId: null,
		});

		await fx.t.mutation(internal.ai_chat_runs.end_expired_runs, {
			_test_now: Date.now() + ai_chat_runs_LEASE_MS + 1000,
		});
		expect(await fx.t.run((ctx) => ctx.db.get("ai_chat_runs", run.runId))).toMatchObject({ status: "ended" });
		expect(await fx.t.run((ctx) => ctx.db.get("ai_chat_threads_messages_aisdk_5", run.replyId))).toMatchObject({
			status: "stopped",
		});
	});
});
