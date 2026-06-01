import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import type { Id } from "./_generated/dataModel.js";

describe("ai_chat thread state", () => {
	test("creates thread state for new threads and updates bash cwd through the thread state functions", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, {
				workspaceName: "personal",
				projectName: "home",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "clerk-ai-chat-thread-state",
			external_id: seeded.userId,
			email: "ai-chat-thread-state@test.local",
		});

		const created = await asUser.mutation(api.ai_chat.thread_create, {
			membershipId: seeded.membershipId,
			clientGeneratedId: "client_ai_chat_thread_state",
			title: "Thread state",
			lastMessageAt: Date.now(),
		});
		expect(created._yay).toBeTruthy();
		const threadId = created._yay!.threadId;

		const initial = await t.run(async (ctx) => {
			const thread = await ctx.db.get("ai_chat_threads", threadId);
			const state = thread?.stateId ? await ctx.db.get("ai_chat_threads_state", thread.stateId) : null;
			return { thread, state };
		});
		expect(initial.thread?.stateId).toBe(initial.state?._id);
		expect(initial.state).toMatchObject({
			workspaceId: seeded.workspaceId,
			projectId: seeded.projectId,
			threadId,
			bashCwd: "~",
			updatedBy: seeded.userId,
		});

		await t.run((ctx) =>
			ctx.runMutation(internal.ai_chat.set_thread_state, {
				workspaceId: seeded.workspaceId,
				projectId: seeded.projectId,
				threadId,
				userId: seeded.userId,
				patch: {
					bashCwd: "~/w/personal/home/docs",
				},
			}),
		);

		const state = await t.run((ctx) =>
			ctx.runQuery(internal.ai_chat.get_thread_state, {
				workspaceId: seeded.workspaceId,
				projectId: seeded.projectId,
				threadId,
			}),
		);
		expect(state.bashCwd).toBe("~/w/personal/home/docs");
	});

	test("copies bash cwd state when branching a thread", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, {
				workspaceName: "personal",
				projectName: "home",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "clerk-ai-chat-thread-state-branch",
			external_id: seeded.userId,
			email: "ai-chat-thread-state-branch@test.local",
		});

		const created = await asUser.mutation(api.ai_chat.thread_create, {
			membershipId: seeded.membershipId,
			clientGeneratedId: "client_ai_chat_thread_state_branch",
			title: "Thread state branch",
			lastMessageAt: Date.now(),
		});
		expect(created._yay).toBeTruthy();
		const sourceThreadId = created._yay!.threadId;

		await t.run((ctx) =>
			ctx.runMutation(internal.ai_chat.set_thread_state, {
				workspaceId: seeded.workspaceId,
				projectId: seeded.projectId,
				threadId: sourceThreadId,
				userId: seeded.userId,
				patch: {
					bashCwd: "~/w/personal/home/mails",
				},
			}),
		);

		const branched = await asUser.mutation(api.ai_chat.thread_branch, {
			membershipId: seeded.membershipId,
			threadId: sourceThreadId,
		});
		expect(branched._yay).toBeTruthy();
		const branchedThreadId = branched._yay!.threadId as Id<"ai_chat_threads">;

		const branchedState = await t.run((ctx) =>
			ctx.runQuery(internal.ai_chat.get_thread_state, {
				workspaceId: seeded.workspaceId,
				projectId: seeded.projectId,
				threadId: branchedThreadId,
			}),
		);
		expect(branchedState.bashCwd).toBe("~/w/personal/home/mails");
	});
});
