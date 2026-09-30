import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import { ai_chat_DEFAULT_MODEL_ID } from "../shared/ai-chat.ts";

async function fixture() {
	const t = test_convex();
	const seeded = await t.run((ctx) =>
		test_mocks_fill_db_with.membership(ctx, { organizationName: "personal", workspaceName: "home" }),
	);
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		subject: "clerk-ai-chat-thread-copies",
		external_id: seeded.userId,
		email: "ai-chat-thread-copies@test.local",
	});
	// Insert the source chat directly. `thread_create` would spend one of the two thread writes
	// the rate limiter allows at once.
	const sourceThreadId = await t.run((ctx) =>
		ctx.db.insert("ai_chat_threads", {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			clientGeneratedId: "client_ai_chat_thread_copies",
			title: "Source",
			archived: false,
			runtime: "aisdk_5",
			createdBy: seeded.userId,
			updatedBy: seeded.userId,
			updatedAt: Date.now(),
			newestNodeId: null,
		}),
	);
	return { t, seeded, asUser, sourceThreadId };
}

/**
 * Save a chain of `count` messages straight to the database: `m0` is the root, each next one its
 * child. Returns the ids root first.
 */
async function seed_chain(f: Awaited<ReturnType<typeof fixture>>, count: number) {
	return await f.t.run(async (ctx) => {
		const ids: Array<Id<"ai_chat_threads_messages_aisdk_5">> = [];
		for (let index = 0; index < count; index++) {
			const content = {
				id: `m${index}`,
				role: index % 2 === 0 ? "user" : "assistant",
				parts: [{ type: "text", text: `m${index}` }],
			};
			ids.push(
				await ctx.db.insert("ai_chat_threads_messages_aisdk_5", {
					organizationId: f.seeded.organizationId,
					workspaceId: f.seeded.workspaceId,
					parentId: ids.at(-1) ?? null,
					threadId: f.sourceThreadId,
					clientGeneratedMessageId: `m${index}`,
					content,
					createdBy: f.seeded.userId,
					updatedAt: Date.now(),
					status: "done",
					runId: null,
					version: 0,
					wakePending: false,
					bytes: JSON.stringify(content).length,
				}),
			);
		}
		await ctx.db.patch("ai_chat_threads", f.sourceThreadId, { newestNodeId: ids.at(-1) ?? null });
		return ids;
	});
}

/**
 * The texts of the target chat's messages, walked from its newest message up to its root, then
 * reversed. So they come root first, the way the chat shows them.
 */
async function read_branch(f: Awaited<ReturnType<typeof fixture>>, threadId: Id<"ai_chat_threads">) {
	return await f.t.run(async (ctx) => {
		const messages = await ctx.db
			.query("ai_chat_threads_messages_aisdk_5")
			.withIndex("by_organization_workspace_thread", (q) =>
				q
					.eq("organizationId", f.seeded.organizationId)
					.eq("workspaceId", f.seeded.workspaceId)
					.eq("threadId", threadId),
			)
			.collect();
		const byId = new Map(messages.map((message) => [message._id, message]));
		const texts: string[] = [];
		let current = messages.at(-1);
		while (current) {
			texts.push((current.content as { parts: Array<{ text: string }> }).parts[0]!.text);
			current = current.parentId ? byId.get(current.parentId) : undefined;
		}
		return { count: messages.length, texts: texts.reverse() };
	});
}

async function copy_docs(f: Awaited<ReturnType<typeof fixture>>) {
	return await f.t.run(async (ctx) => ({
		copies: await ctx.db.query("ai_chat_thread_copies").collect(),
		pages: await ctx.db.query("ai_chat_thread_copy_pages").collect(),
	}));
}

describe("thread_branch", () => {
	test("copies a branch of more than 8,192 messages in order", async () => {
		const f = await fixture();
		const ids = await seed_chain(f, 8_300);

		const branched = await f.asUser.action(api.ai_chat.thread_branch, {
			membershipId: f.seeded.membershipId,
			threadId: f.sourceThreadId,
		});

		const threadId = branched._yay!.threadId;
		const copied = await read_branch(f, threadId);
		expect(copied.count).toBe(ids.length);
		expect(copied.texts).toEqual(ids.map((_, index) => `m${index}`));
		// Publish clears the hidden state and deletes the copy doc and its pages.
		expect(
			await f.asUser.query(api.ai_chat.thread_get, { membershipId: f.seeded.membershipId, threadId }),
		).toMatchObject({ _id: threadId });
		expect(await copy_docs(f)).toEqual({ copies: [], pages: [] });
	});

	test("copies only the branch up to the chosen message", async () => {
		const f = await fixture();
		const ids = await seed_chain(f, 5);

		const branched = await f.asUser.action(api.ai_chat.thread_branch, {
			membershipId: f.seeded.membershipId,
			threadId: f.sourceThreadId,
			messageId: ids[2],
		});

		expect((await read_branch(f, branched._yay!.threadId)).texts).toEqual(["m0", "m1", "m2"]);
	});
});

describe("step", () => {
	test("keeps a copying chat hidden from every door until it is published", async () => {
		const f = await fixture();
		await seed_chain(f, 3);
		const begun = await f.t.mutation(internal.ai_chat_thread_copies.begin, {
			userId: f.seeded.userId,
			membershipId: f.seeded.membershipId,
			threadId: f.sourceThreadId,
		});
		const { copyId, threadId } = begun._yay!;
		const target = { membershipId: f.seeded.membershipId, threadId };

		expect(await f.asUser.query(api.ai_chat.thread_get, target)).toBeNull();
		expect(
			await f.asUser.query(api.ai_chat_runs.branch_page, { ...target, anchorId: null, fromId: null, stopId: null }),
		).toBeNull();
		const listed = await f.asUser.query(api.ai_chat.threads_list, {
			membershipId: f.seeded.membershipId,
			paginationOpts: { numItems: 20, cursor: null },
		});
		expect(listed.page.map((thread) => thread._id)).toEqual([f.sourceThreadId]);
		const captured = await f.t.mutation(internal.ai_chat_workspaces.capture, {
			userId: f.seeded.userId,
			membershipId: f.seeded.membershipId,
		});
		if (captured._nay) throw new Error(captured._nay.message);
		const sent = await f.t.mutation(internal.ai_chat.thread_run_begin, {
			source: {
				organizationId: f.seeded.organizationId,
				workspaceId: f.seeded.workspaceId,
				userId: f.seeded.userId,
				threadId,
				membershipId: f.seeded.membershipId,
				membershipLifetime: captured._yay.membershipLifetime,
			},
			parentId: null,
			messages: [{ clientGeneratedMessageId: "sent", content: { id: "sent", role: "user", parts: [] } }],
			modeId: "agent",
			modelId: ai_chat_DEFAULT_MODEL_ID,
		});
		expect(sent._nay).toBeTruthy();

		let step = "running";
		while (step === "running") {
			step = await f.t.mutation(internal.ai_chat_thread_copies.step, { copyId });
		}
		expect(step).toBe("published");
		expect(await f.asUser.query(api.ai_chat.thread_get, target)).toMatchObject({ _id: threadId });
	});

	test.each([
		{
			change: "the user is deleted",
			apply: (f: Awaited<ReturnType<typeof fixture>>) =>
				f.t.run((ctx) => ctx.db.patch("users", f.seeded.userId, { deletedAt: Date.now() })),
		},
		{
			change: "the workspace purge starts",
			apply: (f: Awaited<ReturnType<typeof fixture>>) =>
				f.t.run((ctx) =>
					ctx.db.patch("organizations_workspaces", f.seeded.workspaceId, { pluginDataPurgeStartedAt: Date.now() }),
				),
		},
		{
			change: "the source chat is deleted",
			apply: (f: Awaited<ReturnType<typeof fixture>>) =>
				f.t.run((ctx) => ctx.db.patch("ai_chat_threads", f.sourceThreadId, { deletingAt: Date.now() })),
		},
	])("aborts the copy and drains the target when $change between steps", async ({ apply }) => {
		const f = await fixture();
		await seed_chain(f, 150);
		const begun = await f.t.mutation(internal.ai_chat_thread_copies.begin, {
			userId: f.seeded.userId,
			membershipId: f.seeded.membershipId,
			threadId: f.sourceThreadId,
		});
		const { copyId, threadId } = begun._yay!;
		// The first step writes the page, the second copies the first 100 messages.
		expect(await f.t.mutation(internal.ai_chat_thread_copies.step, { copyId })).toBe("running");
		expect(await f.t.mutation(internal.ai_chat_thread_copies.step, { copyId })).toBe("running");

		await apply(f);
		expect(await f.t.mutation(internal.ai_chat_thread_copies.step, { copyId })).toBe("aborted");
		expect(await f.t.run((ctx) => ctx.db.get("ai_chat_threads", threadId))).toMatchObject({
			deletingAt: expect.any(Number),
		});

		let done = false;
		while (!done) {
			({ done } = await f.t.mutation(internal.data_deletion.drain_deleting_thread, {
				threadId,
				_test_disableReschedule: true,
			}));
		}
		expect(await f.t.run((ctx) => ctx.db.get("ai_chat_threads", threadId))).toBeNull();
		expect((await read_branch(f, threadId)).count).toBe(0);
		expect(await copy_docs(f)).toEqual({ copies: [], pages: [] });
	});
});

describe("abort_expired_copies", () => {
	test("aborts a copy whose action stopped", async () => {
		const f = await fixture();
		await seed_chain(f, 2);
		const begun = await f.t.mutation(internal.ai_chat_thread_copies.begin, {
			userId: f.seeded.userId,
			membershipId: f.seeded.membershipId,
			threadId: f.sourceThreadId,
		});
		const { copyId, threadId } = begun._yay!;

		await f.t.mutation(internal.ai_chat_thread_copies.abort_expired_copies, {});
		expect(await f.t.run((ctx) => ctx.db.get("ai_chat_thread_copies", copyId))).toMatchObject({
			state: { kind: "building" },
		});

		await f.t.run((ctx) => ctx.db.patch("ai_chat_thread_copies", copyId, { expiresAt: Date.now() - 1 }));
		await f.t.mutation(internal.ai_chat_thread_copies.abort_expired_copies, {});
		expect(await f.t.run((ctx) => ctx.db.get("ai_chat_thread_copies", copyId))).toMatchObject({
			state: { kind: "aborted" },
		});
		expect(await f.t.run((ctx) => ctx.db.get("ai_chat_threads", threadId))).toMatchObject({
			deletingAt: expect.any(Number),
		});
	});
});

describe("thread_delete", () => {
	test("aborts the branch copies of the deleted chat", async () => {
		const f = await fixture();
		await seed_chain(f, 2);
		const begun = await f.t.mutation(internal.ai_chat_thread_copies.begin, {
			userId: f.seeded.userId,
			membershipId: f.seeded.membershipId,
			threadId: f.sourceThreadId,
		});

		await f.asUser.mutation(api.ai_chat.thread_delete, {
			membershipId: f.seeded.membershipId,
			threadId: f.sourceThreadId,
		});

		expect(await f.t.run((ctx) => ctx.db.get("ai_chat_thread_copies", begun._yay!.copyId))).toMatchObject({
			state: { kind: "aborted" },
		});
		expect(await f.t.run((ctx) => ctx.db.get("ai_chat_threads", begun._yay!.threadId))).toMatchObject({
			deletingAt: expect.any(Number),
		});
	});
});
