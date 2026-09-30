import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";

const CHAT_RUN_LEASE_MS = 10 * 60 * 1000;

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
	return { t, source };
}

describe("end_expired_runs", () => {
	test("ends runs whose lease passed and gives the thread lease back", async () => {
		const { t, source } = await fixture();
		const runId = await t.mutation(internal.ai_chat.thread_run_begin, { source });
		if (!runId) throw new Error("Expected the run to begin");
		const beganAt = Date.now();

		// Before the lease passes, the watchdog leaves the run alone.
		await t.mutation(internal.ai_chat_runs.end_expired_runs, { _test_now: beganAt + 1000 });
		expect(await t.run((ctx) => ctx.db.get("ai_chat_runs", runId))).toMatchObject({ status: "running" });
		expect((await t.run((ctx) => ctx.db.get("ai_chat_threads", source.threadId)))?.activeRun?.kind).toBe("chat");

		const later = beganAt + CHAT_RUN_LEASE_MS + 1000;
		await t.mutation(internal.ai_chat_runs.end_expired_runs, { _test_now: later });
		expect(await t.run((ctx) => ctx.db.get("ai_chat_runs", runId))).toMatchObject({
			status: "ended",
			endedAt: later,
		});
		expect((await t.run((ctx) => ctx.db.get("ai_chat_threads", source.threadId)))?.activeRun).toBeUndefined();
	});

	test("keeps the lease while another run of the same kind is still live", async () => {
		const { t, source } = await fixture();
		const firstRunId = await t.mutation(internal.ai_chat.thread_run_begin, { source });
		if (!firstRunId) throw new Error("Expected the first run to begin");
		const firstBeganAt = Date.now();

		// A second tab starts a chat run later, so its lease ends later.
		await t.run((ctx) => ctx.db.patch("ai_chat_runs", firstRunId, { leaseExpiresAt: firstBeganAt + 1000 }));
		const secondRunId = await t.mutation(internal.ai_chat.thread_run_begin, { source });
		if (!secondRunId) throw new Error("Expected the second run to begin");

		await t.mutation(internal.ai_chat_runs.end_expired_runs, { _test_now: firstBeganAt + 2000 });
		expect(await t.run((ctx) => ctx.db.get("ai_chat_runs", firstRunId))).toMatchObject({ status: "ended" });
		expect(await t.run((ctx) => ctx.db.get("ai_chat_runs", secondRunId))).toMatchObject({ status: "running" });
		expect((await t.run((ctx) => ctx.db.get("ai_chat_threads", source.threadId)))?.activeRun?.kind).toBe("chat");
	});
});
