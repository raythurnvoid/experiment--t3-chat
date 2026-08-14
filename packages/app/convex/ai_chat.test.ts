import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import type { Id } from "./_generated/dataModel.js";

describe("ai_chat thread state", () => {
	test("creates thread state for new threads and updates bash cwd through the thread state functions", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, {
				organizationName: "personal",
				workspaceName: "home",
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
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			threadId,
			bashCwd: "~",
			updatedBy: seeded.userId,
		});

		await t.run((ctx) =>
			ctx.runMutation(internal.ai_chat.set_thread_state, {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				threadId,
				userId: seeded.userId,
				patch: {
					bashCwd: "~/w/personal/home/docs",
				},
			}),
		);

		const state = await t.run((ctx) =>
			ctx.runQuery(internal.ai_chat.get_thread_state, {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				threadId,
			}),
		);
		expect(state.bashCwd).toBe("~/w/personal/home/docs");
	});

	test("copies bash cwd state when branching a thread", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, {
				organizationName: "personal",
				workspaceName: "home",
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
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
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
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				threadId: branchedThreadId,
			}),
		);
		expect(branchedState.bashCwd).toBe("~/w/personal/home/mails");
	});

	test("thread_messages_add is idempotent for client generated message ids", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, {
				organizationName: "personal",
				workspaceName: "home",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "clerk-ai-chat-message-idempotency",
			external_id: seeded.userId,
			email: "ai-chat-message-idempotency@test.local",
		});

		const created = await asUser.mutation(api.ai_chat.thread_create, {
			membershipId: seeded.membershipId,
			clientGeneratedId: "client_ai_chat_message_idempotency",
			title: "Message idempotency",
			lastMessageAt: Date.now(),
		});
		expect(created._yay).toBeTruthy();
		const threadId = created._yay!.threadId;

		const message = {
			clientGeneratedMessageId: "client_message_duplicate",
			content: {
				id: "client_message_duplicate",
				role: "assistant",
				parts: [{ type: "text", text: "Done" }],
				metadata: {
					convexParentId: null,
					parentClientGeneratedId: null,
				},
			},
		} as const;

		const first = await asUser.mutation(api.ai_chat.thread_messages_add, {
			membershipId: seeded.membershipId,
			threadId,
			parentId: null,
			messages: [message],
		});
		const second = await asUser.mutation(api.ai_chat.thread_messages_add, {
			membershipId: seeded.membershipId,
			threadId,
			parentId: null,
			messages: [message],
		});

		expect(first._yay?.ids).toHaveLength(1);
		expect(second._yay?.ids).toEqual(first._yay?.ids);

		const messages = await t.run((ctx) =>
			ctx.db
				.query("ai_chat_threads_messages_aisdk_5")
				.withIndex("by_organization_workspace_thread", (q) =>
					q.eq("organizationId", seeded.organizationId).eq("workspaceId", seeded.workspaceId).eq("threadId", threadId),
				)
				.collect(),
		);
		expect(messages).toHaveLength(1);
	});

	test("thread_messages_add rejects file parts that break the image contract", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, {
				organizationName: "personal",
				workspaceName: "home",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "clerk-ai-chat-message-image-contract",
			external_id: seeded.userId,
			email: "ai-chat-message-image-contract@test.local",
		});

		const created = await asUser.mutation(api.ai_chat.thread_create, {
			membershipId: seeded.membershipId,
			clientGeneratedId: "client_ai_chat_message_image_contract",
			title: "Message image contract",
			lastMessageAt: Date.now(),
		});
		expect(created._yay).toBeTruthy();
		const threadId = created._yay!.threadId;

		// A remote URL must never be stored: history is forwarded to the model provider.
		const remoteUrlRejected = await asUser.mutation(api.ai_chat.thread_messages_add, {
			membershipId: seeded.membershipId,
			threadId,
			parentId: null,
			messages: [
				{
					clientGeneratedMessageId: "client_message_remote_image",
					content: {
						id: "client_message_remote_image",
						role: "user",
						parts: [{ type: "file", mediaType: "image/png", url: "https://attacker.example/image.png" }],
						metadata: {
							convexParentId: null,
							parentClientGeneratedId: null,
						},
					},
				},
			],
		});
		expect(remoteUrlRejected._nay?.message).toBe("Invalid image attachments");

		const dataUrlAccepted = await asUser.mutation(api.ai_chat.thread_messages_add, {
			membershipId: seeded.membershipId,
			threadId,
			parentId: null,
			messages: [
				{
					clientGeneratedMessageId: "client_message_data_url_image",
					content: {
						id: "client_message_data_url_image",
						role: "user",
						parts: [{ type: "file", mediaType: "image/png", url: "data:image/png;base64,aW1n" }],
						metadata: {
							convexParentId: null,
							parentClientGeneratedId: null,
						},
					},
				},
			],
		});
		expect(dataUrlAccepted._yay?.ids).toHaveLength(1);
	});

	test("thread_messages_add publishes the generated images the stored message shows", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, {
				organizationName: "personal",
				workspaceName: "home",
			}),
		);
		const other = await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, {
				organizationName: "other",
				workspaceName: "home",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "clerk-ai-chat-generated-image",
			external_id: seeded.userId,
			email: "ai-chat-generated-image@test.local",
		});

		const created = await asUser.mutation(api.ai_chat.thread_create, {
			membershipId: seeded.membershipId,
			clientGeneratedId: "client_ai_chat_generated_image",
			title: "Generated image",
			lastMessageAt: Date.now(),
		});
		expect(created._yay).toBeTruthy();
		const threadId = created._yay!.threadId;

		const insertGeneratedImage = (args: { organizationId: string; workspaceId: string }) =>
			t.run((ctx) =>
				ctx.db.insert("files_r2_assets", {
					organizationId: args.organizationId as Id<"organizations">,
					workspaceId: args.workspaceId as Id<"organizations_workspaces">,
					kind: "generated_image" as const,
					r2Bucket: "test-bucket",
					size: 128,
					createdBy: seeded.userId,
					unfinalizedExpiresAt: Date.now() + 60_000,
					updatedAt: Date.now(),
				}),
			);

		const assetId = await insertGeneratedImage(seeded);
		const otherWorkspaceAssetId = await insertGeneratedImage(other);

		const stored = await asUser.mutation(api.ai_chat.thread_messages_add, {
			membershipId: seeded.membershipId,
			threadId,
			parentId: null,
			messages: [
				{
					clientGeneratedMessageId: "client_message_generated_image",
					content: {
						id: "client_message_generated_image",
						role: "assistant",
						parts: [
							{
								type: "tool-image_generation",
								toolCallId: "call_image_1",
								state: "output-available",
								input: {},
								output: { assetId, mediaType: "image/webp", size: 128 },
							},
							{
								type: "tool-image_generation",
								toolCallId: "call_image_2",
								state: "output-available",
								input: {},
								output: { assetId: otherWorkspaceAssetId, mediaType: "image/webp", size: 128 },
							},
						],
						metadata: {
							convexParentId: null,
							parentClientGeneratedId: null,
						},
					},
				},
			],
		});
		expect(stored._yay?.ids).toHaveLength(1);

		const assets = await t.run(async (ctx) => ({
			published: await ctx.db.get("files_r2_assets", assetId),
			otherWorkspace: await ctx.db.get("files_r2_assets", otherWorkspaceAssetId),
		}));

		// The message shows this picture, so it must survive the unfinalized-asset cleanup.
		expect(assets.published?.unfinalizedExpiresAt).toBeUndefined();
		expect(assets.published?.r2Key).toBe(
			`organizations/${seeded.organizationId}/workspaces/${seeded.workspaceId}/assets/${assetId}`,
		);

		// A message cannot publish an asset from another workspace by naming its id.
		expect(assets.otherWorkspace?.unfinalizedExpiresAt).toBeTypeOf("number");
		expect(assets.otherWorkspace?.r2Key).toBeUndefined();
	});

	test("thread_messages_add returns existing ids when the message write limit is exhausted", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, {
				organizationName: "personal",
				workspaceName: "home",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "clerk-ai-chat-message-idempotency-rate-limit",
			external_id: seeded.userId,
			email: "ai-chat-message-idempotency-rate-limit@test.local",
		});

		const created = await asUser.mutation(api.ai_chat.thread_create, {
			membershipId: seeded.membershipId,
			clientGeneratedId: "client_ai_chat_message_idempotency_rate_limit",
			title: "Message idempotency rate limit",
			lastMessageAt: Date.now(),
		});
		expect(created._yay).toBeTruthy();
		const threadId = created._yay!.threadId;

		const duplicateMessage = {
			clientGeneratedMessageId: "client_message_duplicate_rate_limit",
			content: {
				id: "client_message_duplicate_rate_limit",
				role: "assistant",
				parts: [{ type: "text", text: "Done" }],
				metadata: {
					convexParentId: null,
					parentClientGeneratedId: null,
				},
			},
		} as const;

		const first = await asUser.mutation(api.ai_chat.thread_messages_add, {
			membershipId: seeded.membershipId,
			threadId,
			parentId: null,
			messages: [duplicateMessage],
		});
		expect(first._yay?.ids).toHaveLength(1);
		const firstId = first._yay?.ids[0];
		if (!firstId) {
			throw new Error("Expected first message id");
		}

		const remainingCapacity = await asUser.mutation(api.ai_chat.thread_messages_add, {
			membershipId: seeded.membershipId,
			threadId,
			parentId: firstId,
			messages: Array.from({ length: 3 }, (_, index) => ({
				clientGeneratedMessageId: `client_message_rate_limit_${index}`,
				content: {
					id: `client_message_rate_limit_${index}`,
					role: "assistant",
					parts: [{ type: "text", text: `Message ${index}` }],
					metadata: {
						convexParentId: firstId,
						parentClientGeneratedId: duplicateMessage.clientGeneratedMessageId,
					},
				},
			})),
		});
		expect(remainingCapacity._yay?.ids).toHaveLength(3);

		const retry = await asUser.mutation(api.ai_chat.thread_messages_add, {
			membershipId: seeded.membershipId,
			threadId,
			parentId: null,
			messages: [duplicateMessage],
		});
		expect(retry._yay?.ids).toEqual(first._yay?.ids);
	});
});

describe("ai_chat thread read cursor", () => {
	const seed = async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, {
				organizationName: "personal",
				workspaceName: "home",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "clerk-ai-chat-read-cursor",
			external_id: seeded.userId,
			email: "ai-chat-read-cursor@test.local",
		});

		return { t, seeded, asUser };
	};

	const makeMessage = (id: string) => ({
		clientGeneratedMessageId: id,
		content: {
			id,
			role: "assistant",
			parts: [{ type: "text", text: "Answer" }],
			metadata: {
				convexParentId: null,
				parentClientGeneratedId: null,
			},
		},
	});

	test("a new thread starts read, a new message makes it unread, and thread_mark_read clears it", async () => {
		const { t, seeded, asUser } = await seed();

		const created = await asUser.mutation(api.ai_chat.thread_create, {
			membershipId: seeded.membershipId,
			clientGeneratedId: "client_ai_chat_read_cursor",
			title: "Read cursor",
			lastMessageAt: Date.now(),
		});
		expect(created._yay).toBeTruthy();
		const threadId = created._yay!.threadId;

		const createdThread = await t.run((ctx) => ctx.db.get("ai_chat_threads", threadId));
		expect(createdThread?.readAt).toBe(createdThread?.lastMessageAt);

		// A finished answer moves `lastMessageAt` past the cursor. Nothing writes "unread".
		const added = await asUser.mutation(api.ai_chat.thread_messages_add, {
			membershipId: seeded.membershipId,
			threadId,
			parentId: null,
			messages: [makeMessage("client_message_read_cursor")],
		});
		expect(added._yay).toBeTruthy();

		const unreadThread = await t.run((ctx) => ctx.db.get("ai_chat_threads", threadId));
		expect((unreadThread?.lastMessageAt ?? 0) > (unreadThread?.readAt ?? 0)).toBe(true);

		const markedRead = await asUser.mutation(api.ai_chat.thread_mark_read, {
			membershipId: seeded.membershipId,
			threadId,
		});
		expect(markedRead._yay).toBeDefined();

		const readThread = await t.run((ctx) => ctx.db.get("ai_chat_threads", threadId));
		expect((readThread?.lastMessageAt ?? 0) > (readThread?.readAt ?? 0)).toBe(false);
		// Reading is not a content edit.
		expect(readThread?.updatedAt).toBe(unreadThread?.updatedAt);
	});

	test("thread_mark_read never lands behind an already persisted message", async () => {
		const { t, seeded, asUser } = await seed();

		const created = await asUser.mutation(api.ai_chat.thread_create, {
			membershipId: seeded.membershipId,
			clientGeneratedId: "client_ai_chat_read_cursor_future",
			title: "Read cursor future",
			lastMessageAt: Date.now(),
		});
		const threadId = created._yay!.threadId;

		// Simulate a message stamped ahead of the mutation's own clock.
		const future = Date.now() + 60_000;
		await t.run((ctx) => ctx.db.patch("ai_chat_threads", threadId, { lastMessageAt: future }));

		await asUser.mutation(api.ai_chat.thread_mark_read, {
			membershipId: seeded.membershipId,
			threadId,
		});

		const thread = await t.run((ctx) => ctx.db.get("ai_chat_threads", threadId));
		expect(thread?.readAt).toBe(future);
		expect((thread?.lastMessageAt ?? 0) > (thread?.readAt ?? 0)).toBe(false);
	});

	test("thread_create clamps a timestamp from the future", async () => {
		const { t, seeded, asUser } = await seed();

		const future = Date.now() + 60_000;
		const created = await asUser.mutation(api.ai_chat.thread_create, {
			membershipId: seeded.membershipId,
			clientGeneratedId: "client_ai_chat_read_cursor_clamp",
			title: "Read cursor clamp",
			lastMessageAt: future,
		});
		expect(created._yay).toBeTruthy();

		// Without the limit, this thread would sort above every other thread in `threads_list` until a
		// message replaced the value. `readAt` copies the same value, so the thread would also look read
		// during all that time.
		const thread = await t.run((ctx) => ctx.db.get("ai_chat_threads", created._yay!.threadId));
		expect(thread?.lastMessageAt ?? Infinity).toBeLessThan(future);
		expect(thread?.readAt).toBe(thread?.lastMessageAt);
	});

	test("a branched thread starts read", async () => {
		const { t, seeded, asUser } = await seed();

		const created = await asUser.mutation(api.ai_chat.thread_create, {
			membershipId: seeded.membershipId,
			clientGeneratedId: "client_ai_chat_read_cursor_branch",
			title: "Read cursor branch",
			lastMessageAt: Date.now(),
		});
		const sourceThreadId = created._yay!.threadId;

		await asUser.mutation(api.ai_chat.thread_messages_add, {
			membershipId: seeded.membershipId,
			threadId: sourceThreadId,
			parentId: null,
			messages: [makeMessage("client_message_read_cursor_branch")],
		});

		const branched = await asUser.mutation(api.ai_chat.thread_branch, {
			membershipId: seeded.membershipId,
			threadId: sourceThreadId,
		});
		expect(branched._yay).toBeTruthy();

		const branchedThread = await t.run((ctx) =>
			ctx.db.get("ai_chat_threads", branched._yay!.threadId as Id<"ai_chat_threads">),
		);
		expect((branchedThread?.lastMessageAt ?? 0) > (branchedThread?.readAt ?? 0)).toBe(false);
	});
});
