import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import type { Id } from "./_generated/dataModel.js";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";

/**
 * A shell state snapshot with the given variables and nothing else.
 */
const snapshot = (env: { name: string; value: string }[]) => ({
	env,
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
	previousDir: "~",
	directoryStack: [],
	lastExitCode: 0,
	lastArg: "",
	openFileDescriptors: [],
});

describe("ai_chat thread state", () => {
	test("creates the shell on the first call and saves its cwd and transcript", async () => {
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

		// A new thread has no shell rows. The first call creates the shell it names.
		const shellsOf = (forThreadId: Id<"ai_chat_threads">) =>
			t.run((ctx) =>
				ctx.db
					.query("ai_chat_bash_shells")
					.withIndex("by_thread_name", (q) => q.eq("threadId", forThreadId))
					.collect(),
			);
		expect(await shellsOf(threadId)).toEqual([]);
		const identity = {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			threadId,
		};
		const begun = await t.mutation(internal.ai_chat_files.begin_bash_invocation, {
			...identity,
			toolCallId: "cwd-test",
			commandHash: "a".repeat(64),
			shellName: "default",
		});
		if (begun._nay || !("shell" in begun._yay)) throw new Error("Expected a fresh shell");
		const shellId = begun._yay.shell._id;
		expect(begun._yay.shell).toMatchObject({ name: "default", cwd: "~", cwdTarget: null, state: null });
		expect(begun._yay.shells).toEqual([{ _id: shellId, name: "default" }]);
		expect(await shellsOf(threadId)).toMatchObject([{ _id: shellId, transcriptEntries: 0 }]);

		const entry = "$ [2026-09-15T10:00:00.000Z] (exit 0) ~\ncd docs\n\n";
		await t.mutation(internal.ai_chat.save_shell, {
			...identity,
			invocationId: begun._yay.invocationId,
			shellId,
			cwd: "~/w/personal/home/docs",
			cwdTarget: null,
			transcriptEntry: entry,
		});

		const saved = await t.run(async (ctx) => ({
			shell: await ctx.db.get("ai_chat_bash_shells", shellId),
			entries: await ctx.db
				.query("ai_chat_bash_shell_transcripts")
				.withIndex("by_shell_seq", (q) => q.eq("shellId", shellId))
				.collect(),
		}));
		expect(saved.shell).toMatchObject({
			cwd: "~/w/personal/home/docs",
			transcriptBytes: new TextEncoder().encode(entry).byteLength,
			transcriptEntries: 1,
			transcriptSeq: 1,
			updatedBy: seeded.userId,
		});
		expect(saved.entries).toMatchObject([{ seq: 0, text: entry }]);

		// The next call on the same name reuses the row and starts where the last call ended.
		const again = await t.mutation(internal.ai_chat_files.begin_bash_invocation, {
			...identity,
			toolCallId: "cwd-test-2",
			commandHash: "b".repeat(64),
			shellName: "default",
		});
		if (again._nay || !("shell" in again._yay)) throw new Error("Expected the same shell");
		expect(again._yay.shell).toMatchObject({ _id: shellId, cwd: "~/w/personal/home/docs" });
		expect(await shellsOf(threadId)).toHaveLength(1);
	});

	test("copies the shells when branching with write permission, never transcripts or jobs", async () => {
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
		const identity = {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			threadId: sourceThreadId,
		};
		const begun = await t.mutation(internal.ai_chat_files.begin_bash_invocation, {
			...identity,
			toolCallId: "cwd-test",
			commandHash: "a".repeat(64),
			shellName: "default",
		});
		if (begun._nay || !("shell" in begun._yay)) throw new Error("Expected a fresh shell");
		await t.mutation(internal.ai_chat.save_shell, {
			...identity,
			invocationId: begun._yay.invocationId,
			shellId: begun._yay.shell._id,
			cwd: "~/w/personal/home/mails",
			cwdTarget: null,
			transcriptEntry: "$ [2026-09-15T10:00:00.000Z] (exit 0) ~\ncd mails\n\n",
		});
		// A job still running in the source thread stays there; the branch does not see it.
		const launched = await t.mutation(internal.ai_chat_files.start_bash_job, {
			parentInvocationId: begun._yay.invocationId,
			commandNumber: 0,
			shellId: begun._yay.shell._id,
			script: "sleep 60",
			startCwd: "/home/cloud-usr/w/personal/home/mails",
			startCwdTarget: null,
			shellState: snapshot([]),
			allowDbFilesMkdir: true,
		});
		if (launched._nay) throw new Error(launched._nay.message);

		const branched = await asUser.mutation(api.ai_chat.thread_branch, {
			membershipId: seeded.membershipId,
			threadId: sourceThreadId,
		});
		expect(branched._yay).toBeTruthy();
		const branchedThreadId = branched._yay!.threadId as Id<"ai_chat_threads">;

		const branchedShells = await t.run((ctx) =>
			ctx.db
				.query("ai_chat_bash_shells")
				.withIndex("by_thread_name", (q) => q.eq("threadId", branchedThreadId))
				.collect(),
		);
		expect(branchedShells).toMatchObject([
			{
				name: "default",
				cwd: "~/w/personal/home/mails",
				cwdTarget: null,
				transcriptBytes: 0,
				transcriptEntries: 0,
				transcriptSeq: 0,
			},
		]);
		const branchedEntries = await t.run((ctx) =>
			ctx.db
				.query("ai_chat_bash_shell_transcripts")
				.withIndex("by_shell_seq", (q) => q.eq("shellId", branchedShells[0]!._id))
				.collect(),
		);
		expect(branchedEntries).toEqual([]);
		const live = { select: { kind: "live" as const } };
		expect(
			await t.query(internal.ai_chat_files.list_thread_jobs, { ...identity, threadId: branchedThreadId, ...live }),
		).toEqual([]);
		expect(await t.query(internal.ai_chat_files.list_thread_jobs, { ...identity, ...live })).toMatchObject([
			{ jobNumber: 1, status: "queued" },
		]);

		// A member who cannot write in the source thread gets a branch without shells.
		const viewer = await t.run(async (ctx) => {
			const userId = await ctx.db.insert("users", { clerkUserId: "clerk-ai-chat-branch-viewer" });
			const membershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId,
				active: true,
				updatedAt: Date.now(),
			});
			await access_control_db_ensure_role_assignment(ctx, {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId,
				role: "viewer",
				now: Date.now(),
			});
			return { userId, membershipId };
		});
		const asViewer = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "clerk-ai-chat-branch-viewer",
			external_id: viewer.userId,
			email: "ai-chat-branch-viewer@test.local",
		});
		const viewerBranch = await asViewer.mutation(api.ai_chat.thread_branch, {
			membershipId: viewer.membershipId,
			threadId: sourceThreadId,
		});
		if (viewerBranch._nay) throw new Error(viewerBranch._nay.message);
		const viewerThreadId = viewerBranch._yay.threadId as Id<"ai_chat_threads">;
		expect(
			await t.run((ctx) =>
				ctx.db
					.query("ai_chat_bash_shells")
					.withIndex("by_thread_name", (q) => q.eq("threadId", viewerThreadId))
					.collect(),
			),
		).toEqual([]);
	});

	test("the last save wins the whole snapshot when two calls save the same shell", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, {
				organizationName: "personal",
				workspaceName: "home",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "clerk-ai-chat-shell-last-write",
			external_id: seeded.userId,
			email: "ai-chat-shell-last-write@test.local",
		});
		const created = await asUser.mutation(api.ai_chat.thread_create, {
			membershipId: seeded.membershipId,
			clientGeneratedId: "client_ai_chat_shell_last_write",
			title: "Shell last write",
			lastMessageAt: Date.now(),
		});
		if (created._nay) throw new Error(created._nay.message);
		const identity = {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			threadId: created._yay.threadId,
		};
		// Both calls begin before either saves, so the second save does not see the first one's state.
		const first = await t.mutation(internal.ai_chat_files.begin_bash_invocation, {
			...identity,
			toolCallId: "first",
			commandHash: "a".repeat(64),
			shellName: "default",
		});
		if (first._nay || !("shell" in first._yay)) throw new Error("Expected a fresh shell");
		const shellId = first._yay.shell._id;
		const second = await t.mutation(internal.ai_chat_files.begin_bash_invocation, {
			...identity,
			toolCallId: "second",
			commandHash: "b".repeat(64),
			shellName: "default",
		});
		if (second._nay) throw new Error(second._nay.message);
		await t.mutation(internal.ai_chat.save_shell, {
			...identity,
			invocationId: first._yay.invocationId,
			shellId,
			cwd: "~/first",
			cwdTarget: null,
			state: snapshot([{ name: "x", value: "1" }]),
			transcriptEntry: "$ x=1",
		});
		await t.mutation(internal.ai_chat.save_shell, {
			...identity,
			invocationId: second._yay.invocationId,
			shellId,
			cwd: "~/second",
			cwdTarget: null,
			state: snapshot([{ name: "y", value: "2" }]),
			transcriptEntry: "$ y=2",
		});

		const shell = await t.run((ctx) => ctx.db.get("ai_chat_bash_shells", shellId));
		expect(shell).toMatchObject({ cwd: "~/second", state: snapshot([{ name: "y", value: "2" }]) });
		expect(shell?.state?.env).toEqual([{ name: "y", value: "2" }]);

		// A save with no `state` keeps the stored snapshot: the call's own snapshot was over the size cap.
		await t.mutation(internal.ai_chat.save_shell, {
			...identity,
			invocationId: second._yay.invocationId,
			shellId,
			cwd: "~/third",
			cwdTarget: null,
			transcriptEntry: "$ big=...",
		});
		const kept = await t.run((ctx) => ctx.db.get("ai_chat_bash_shells", shellId));
		expect(kept).toMatchObject({ cwd: "~/third", transcriptEntries: 3 });
		expect(kept?.state?.env).toEqual([{ name: "y", value: "2" }]);
	});

	test("save_shell refuses the write when the caller loses read permission during the call", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, {
				organizationName: "personal",
				workspaceName: "home",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "clerk-ai-chat-shell-role-change",
			external_id: seeded.userId,
			email: "ai-chat-shell-role-change@test.local",
		});
		const created = await asUser.mutation(api.ai_chat.thread_create, {
			membershipId: seeded.membershipId,
			clientGeneratedId: "client_ai_chat_shell_role_change",
			title: "Shell role change",
			lastMessageAt: Date.now(),
		});
		if (created._nay) throw new Error(created._nay.message);
		const identity = {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			threadId: created._yay.threadId,
		};
		const begun = await t.mutation(internal.ai_chat_files.begin_bash_invocation, {
			...identity,
			toolCallId: "role-change",
			commandHash: "a".repeat(64),
			shellName: "default",
		});
		if (begun._nay || !("shell" in begun._yay)) throw new Error("Expected a fresh shell");
		const shellId = begun._yay.shell._id;
		const save = (cwd: string) =>
			t.mutation(internal.ai_chat.save_shell, {
				...identity,
				invocationId: begun._yay.invocationId,
				shellId,
				cwd,
				cwdTarget: null,
				transcriptEntry: `$ ${cwd}`,
			});

		// The same save passes first, so the refusal below can only come from the role change.
		await save("~/before");

		// The shell row and its transcript belong to everyone in the thread, and this save can delete
		// another member's oldest transcript entries, so a role change during the call has to stop it.
		// The seeded user created the organization and an owner passes every check, so hand the
		// organization to somebody else and leave the user without a role.
		await t.run(async (ctx) => {
			const otherOwnerId = await ctx.db.insert("users", { clerkUserId: null });
			await ctx.db.patch("organizations", seeded.organizationId, { ownerUserId: otherOwnerId });
		});

		await expect(save("~/after")).rejects.toThrow("Permission denied");
		expect(await t.run((ctx) => ctx.db.get("ai_chat_bash_shells", shellId))).toMatchObject({
			cwd: "~/before",
			transcriptEntries: 1,
		});
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

	test("thread_messages_add refuses raw browser parts with or without toolName", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "clerk-ai-chat-browser-parts",
			external_id: seeded.userId,
			email: "ai-chat-browser-parts@test.local",
		});

		const created = await asUser.mutation(api.ai_chat.thread_create, {
			membershipId: seeded.membershipId,
			clientGeneratedId: "client_ai_chat_browser_parts",
			title: "Browser parts",
			lastMessageAt: Date.now(),
		});
		const threadId = created._yay!.threadId;

		const raw = {
			clientGeneratedMessageId: "client_message_browser_raw",
			content: {
				id: "client_message_browser_raw",
				role: "assistant",
				parts: [
					{
						type: "tool-browser_run",
						toolCallId: "call-1",
						state: "output-available",
						input: { code: "return 1;" },
						output: {
							title: "Browser run",
							output: "raw observations",
							metadata: { status: "succeeded", resultId: "result-1" },
						},
					},
				],
				metadata: {
					convexParentId: null,
					parentClientGeneratedId: null,
				},
			},
		} as const;

		const refused = await asUser.mutation(api.ai_chat.thread_messages_add, {
			membershipId: seeded.membershipId,
			threadId,
			parentId: null,
			messages: [raw],
		});
		expect(refused._nay?.message).toBe("Invalid browser result parts");

		const scrubbed = {
			...raw,
			clientGeneratedMessageId: "client_message_browser_scrubbed",
			content: {
				...raw.content,
				id: "client_message_browser_scrubbed",
				parts: [
					{
						type: "tool-browser_run",
						toolCallId: "call-1",
						state: "output-available",
						input: {},
						output: {
							title: "Browser run",
							output: "Browser succeeded.",
							metadata: { status: "succeeded", resultId: "result-1" },
						},
					},
				],
			},
		} as const;

		const stored = await asUser.mutation(api.ai_chat.thread_messages_add, {
			membershipId: seeded.membershipId,
			threadId,
			parentId: null,
			messages: [scrubbed],
		});
		expect(stored._yay?.ids).toHaveLength(1);

		const dynamic = {
			clientGeneratedMessageId: "client_message_browser_dynamic",
			content: {
				id: "client_message_browser_dynamic",
				role: "assistant",
				parts: [
					{
						type: "dynamic-tool",
						toolName: "browser_run",
						toolCallId: "call-2",
						state: "output-available",
						input: { code: "return 1;" },
						output: {
							title: "Browser run",
							output: "raw observations",
							metadata: { status: "succeeded", resultId: "result-1" },
						},
					},
				],
				metadata: {
					convexParentId: null,
					parentClientGeneratedId: null,
				},
			},
		} as const;

		const dynamicRefused = await asUser.mutation(api.ai_chat.thread_messages_add, {
			membershipId: seeded.membershipId,
			threadId,
			parentId: null,
			messages: [dynamic],
		});
		expect(dynamicRefused._nay?.message).toBe("Invalid browser result parts");
	});

	test("thread_messages_add refuses an oversized serialized message without storing it", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "clerk-ai-chat-message-size",
			external_id: seeded.userId,
			email: "ai-chat-message-size@test.local",
		});
		const created = await asUser.mutation(api.ai_chat.thread_create, {
			membershipId: seeded.membershipId,
			clientGeneratedId: "client_oversized_thread",
			title: "Message size",
			lastMessageAt: Date.now(),
		});
		const threadId = created._yay!.threadId;
		const result = await asUser.mutation(api.ai_chat.thread_messages_add, {
			membershipId: seeded.membershipId,
			threadId,
			messages: [
				{
					clientGeneratedMessageId: "client_oversized_message",
					content: {
						id: "client_oversized_message",
						role: "assistant",
						// A quote JSON-escapes to \" so the stored size is twice the text length.
						parts: [{ type: "text", text: '"'.repeat(460 * 1024) }],
					},
				},
			],
		});
		expect(result._nay?.message).toContain("Message is too large to store");
		const listed = await asUser.query(api.ai_chat.thread_messages_list, {
			membershipId: seeded.membershipId,
			threadId,
		});
		expect(listed?.messages).toHaveLength(0);
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

describe("thread_create", () => {
	// The positive control for the refusal below: the same issuer shape with the anonymous issuer
	// creates a thread, so the refusal is about the plugin issuer and nothing else.
	test("lets an anonymous member create a thread", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, {
				organizationName: "personal",
				workspaceName: "home",
			}),
		);
		const asAnonymous = t.withIdentity({
			issuer: process.env.VITE_CONVEX_HTTP_URL!,
			subject: seeded.userId,
		});

		const created = await asAnonymous.mutation(api.ai_chat.thread_create, {
			membershipId: seeded.membershipId,
			clientGeneratedId: "client_ai_chat_thread_anonymous",
			title: "Anonymous",
			lastMessageAt: Date.now(),
		});
		expect(created._yay?.threadId).toBeTruthy();
	});

	test("refuses a plugin-session identity even though an anonymous member may create threads", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, {
				organizationName: "personal",
				workspaceName: "home",
			}),
		);

		// A plugin frame's Convex client authenticates with the plugin-session JWT, and a plugin may
		// call any function of the app with it. This mutation lets an anonymous member through, so
		// it is the case where reading that JWT as an anonymous user would change the outcome: the
		// classifier must answer no user at all, not a user with fewer permissions.
		//
		// This first call only proves the `/plugins-ui` issuer is not matched as the anonymous issuer
		// it starts with.
		const asPluginSession = t.withIdentity({
			issuer: `${process.env.VITE_CONVEX_HTTP_URL!}/plugins-ui`,
			subject: seeded.userId,
		});

		const refused = await asPluginSession.mutation(api.ai_chat.thread_create, {
			membershipId: seeded.membershipId,
			clientGeneratedId: "client_ai_chat_thread_plugin_session",
			title: "Plugin session",
			lastMessageAt: Date.now(),
		});
		expect(refused._nay?.message).toBe("Unauthenticated");

		// The plugin branch must win by issuer alone. A crafted `external_id` claim must not upgrade
		// the token to a signed-in member. This is the call that fails when the plugin branch is
		// removed from the classifier: these claims would then read as a Clerk member.
		const asPluginSessionWithExternalId = t.withIdentity({
			issuer: `${process.env.VITE_CONVEX_HTTP_URL!}/plugins-ui`,
			subject: seeded.userId,
			external_id: seeded.userId,
			email: "thread-plugin-session@test.local",
		});

		const refusedWithClaims = await asPluginSessionWithExternalId.mutation(api.ai_chat.thread_create, {
			membershipId: seeded.membershipId,
			clientGeneratedId: "client_ai_chat_thread_plugin_session_claims",
			title: "Plugin session with claims",
			lastMessageAt: Date.now(),
		});
		expect(refusedWithClaims._nay?.message).toBe("Unauthenticated");

		const threads = await t.run((ctx) => ctx.db.query("ai_chat_threads").collect());
		expect(threads).toHaveLength(0);
	});
});
