import { describe, expect, onTestFinished, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import type { Id } from "./_generated/dataModel.js";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import { rate_limiter_RATE_LIMIT_EXCEEDED_MESSAGE } from "./rate_limiter.ts";
import { ai_chat_DEFAULT_MODEL_ID } from "../shared/ai-chat.ts";

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

/**
 * The source of a chat's runs, with the membership lifetime captured now, like `/api/chat` builds it.
 */
async function capture_source(
	t: ReturnType<typeof test_convex>,
	args: {
		seeded: { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces">; userId: Id<"users"> };
		membershipId: Id<"organizations_workspaces_users">;
		threadId: Id<"ai_chat_threads">;
	},
) {
	const captured = await t.mutation(internal.ai_chat_workspaces.capture, {
		userId: args.seeded.userId,
		membershipId: args.membershipId,
	});
	if (captured._nay) throw new Error(captured._nay.message);
	return {
		organizationId: args.seeded.organizationId,
		workspaceId: args.seeded.workspaceId,
		userId: args.seeded.userId,
		threadId: args.threadId,
		membershipId: args.membershipId,
		membershipLifetime: captured._yay.membershipLifetime,
	};
}

/**
 * Save user messages and start a run the way `/api/chat` does. When the run starts, end it at
 * once, so the next send in the same chat can start its own run.
 */
async function send_messages(
	t: ReturnType<typeof test_convex>,
	args: {
		source: Awaited<ReturnType<typeof capture_source>>;
		parentId: string | null;
		messageIds: string[];
	},
) {
	const begun = await t.mutation(internal.ai_chat.thread_run_begin, {
		source: args.source,
		parentId: args.parentId,
		messages: args.messageIds.map((id) => ({
			clientGeneratedMessageId: id,
			content: { id, role: "user", parts: [{ type: "text", text: id }] },
		})),
		modeId: "agent",
		modelId: ai_chat_DEFAULT_MODEL_ID,
	});
	if (begun._yay) {
		await t.mutation(internal.ai_chat_runs.finish, {
			runId: begun._yay.runId,
			generation: begun._yay.generation,
			outcome: "done",
			tail: null,
		});
	}
	return begun;
}

/**
 * Send one `/api/chat` request. The route takes one request per 15 seconds from a user, so move the
 * clock a minute forward before each request.
 */
async function post_chat(
	asUser: ReturnType<ReturnType<typeof test_convex>["withIdentity"]>,
	args: { membershipId: Id<"organizations_workspaces_users">; threadId: Id<"ai_chat_threads">; messages: unknown[] },
) {
	vi.setSystemTime(Date.now() + 60_000);
	onTestFinished(() => {
		vi.useRealTimers();
	});
	const response = await asUser.fetch("/api/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			messages: args.messages,
			parentId: null,
			mode: "agent",
			model: ai_chat_DEFAULT_MODEL_ID,
			trigger: "submit-message",
			threadId: args.threadId,
			membershipId: args.membershipId,
			browserIntent: { policyRevision: 0 },
		}),
	});
	return { status: response.status, body: await response.text() };
}

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
		const captured = await t.mutation(internal.ai_chat_workspaces.capture, {
			userId: seeded.userId,
			membershipId: seeded.membershipId,
		});
		if (captured._nay) throw new Error(captured._nay.message);
		const identity = {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			threadId,
		};
		const begun = await t.mutation(internal.ai_chat_files.begin_bash_invocation, {
			...identity,
			membershipId: seeded.membershipId,
			membershipLifetime: captured._yay.membershipLifetime,
			toolCallId: "cwd-test",
			commandHash: "a".repeat(64),
			shellName: "default",
			run: null,
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
			membershipId: seeded.membershipId,
			membershipLifetime: captured._yay.membershipLifetime,
			toolCallId: "cwd-test-2",
			commandHash: "b".repeat(64),
			shellName: "default",
			run: null,
		});
		if (again._nay || !("shell" in again._yay)) throw new Error("Expected the same shell");
		expect(again._yay.shell).toMatchObject({ _id: shellId, cwd: "~/w/personal/home/docs" });
		expect(await shellsOf(threadId)).toHaveLength(1);
	});

	test("copies the creator's shells when branching, never transcripts or jobs", async () => {
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
		const captured = await t.mutation(internal.ai_chat_workspaces.capture, {
			userId: seeded.userId,
			membershipId: seeded.membershipId,
		});
		if (captured._nay) throw new Error(captured._nay.message);
		const identity = {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			threadId: sourceThreadId,
		};
		const begun = await t.mutation(internal.ai_chat_files.begin_bash_invocation, {
			...identity,
			toolCallId: "cwd-test",
			membershipId: seeded.membershipId,
			membershipLifetime: captured._yay.membershipLifetime,
			commandHash: "a".repeat(64),
			shellName: "default",
			run: null,
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

		const branched = await asUser.action(api.ai_chat.thread_branch, {
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
		const captured = await t.mutation(internal.ai_chat_workspaces.capture, {
			userId: seeded.userId,
			membershipId: seeded.membershipId,
		});
		if (captured._nay) throw new Error(captured._nay.message);
		const first = await t.mutation(internal.ai_chat_files.begin_bash_invocation, {
			...identity,
			membershipId: seeded.membershipId,
			membershipLifetime: captured._yay.membershipLifetime,
			toolCallId: "first",
			commandHash: "a".repeat(64),
			shellName: "default",
			run: null,
		});
		if (first._nay || !("shell" in first._yay)) throw new Error("Expected a fresh shell");
		const shellId = first._yay.shell._id;
		const second = await t.mutation(internal.ai_chat_files.begin_bash_invocation, {
			...identity,
			membershipId: seeded.membershipId,
			membershipLifetime: captured._yay.membershipLifetime,
			toolCallId: "second",
			commandHash: "b".repeat(64),
			shellName: "default",
			run: null,
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
		const owner = await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, {
				organizationName: "shell-role-change",
				workspaceName: "home",
			}),
		);
		const seeded = await t.run(async (ctx) => {
			const user = await test_mocks_fill_db_with.membership(ctx, {
				organizationName: "personal",
				workspaceName: "home",
			});
			const membershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: owner.organizationId,
				workspaceId: owner.workspaceId,
				userId: user.userId,
				active: true,
				updatedAt: Date.now(),
			});
			await access_control_db_ensure_role_assignment(ctx, {
				organizationId: owner.organizationId,
				workspaceId: owner.workspaceId,
				userId: user.userId,
				role: "viewer",
				now: Date.now(),
			});
			return { ...owner, userId: user.userId, membershipId };
		});
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
		const captured = await t.mutation(internal.ai_chat_workspaces.capture, {
			userId: seeded.userId,
			membershipId: seeded.membershipId,
		});
		if (captured._nay) throw new Error(captured._nay.message);
		const begun = await t.mutation(internal.ai_chat_files.begin_bash_invocation, {
			...identity,
			membershipId: seeded.membershipId,
			membershipLifetime: captured._yay.membershipLifetime,
			toolCallId: "role-change",
			commandHash: "a".repeat(64),
			shellName: "default",
			run: null,
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

		const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: owner.userId });
		const role = await asOwner.mutation(api.access_control.create_role, {
			organizationId: owner.organizationId,
			name: "Workspace maker",
			description: "",
			permissions: ["workspace.create"],
		});
		expect(role._nay).toBeUndefined();
		const assigned = await asOwner.mutation(api.access_control.set_user_role, {
			organizationId: owner.organizationId,
			workspaceId: owner.workspaceId,
			userId: seeded.userId,
			role: role._yay!.roleId,
		});
		expect(assigned._nay).toBeUndefined();

		expect(
			await asUser.query(api.access_control.get_current_user_workspace_permission, {
				membershipId: seeded.membershipId,
				permission: "content.read",
			}),
		).toBe(false);
		await expect(save("~/after")).rejects.toThrow("Unauthorized");
		expect(await t.run((ctx) => ctx.db.get("ai_chat_bash_shells", shellId))).toMatchObject({
			cwd: "~/before",
			transcriptEntries: 1,
		});
	});

	test("save_shell and patch_thread_tmp_files refuse a call of a stopped run", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, {
				organizationName: "personal",
				workspaceName: "home",
			}),
		);
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: seeded.userId });
		const created = await asUser.mutation(api.ai_chat.thread_create, {
			membershipId: seeded.membershipId,
			clientGeneratedId: "client_ai_chat_shell_stop",
			title: "Shell stop",
			lastMessageAt: Date.now(),
		});
		if (created._nay) throw new Error(created._nay.message);
		const source = await capture_source(t, {
			seeded,
			membershipId: seeded.membershipId,
			threadId: created._yay.threadId,
		});
		const begun = await t.mutation(internal.ai_chat.thread_run_begin, {
			source,
			parentId: null,
			messages: [{ clientGeneratedMessageId: "user-1", content: { id: "user-1", role: "user", parts: [] } }],
			modeId: "agent",
			modelId: ai_chat_DEFAULT_MODEL_ID,
		});
		if (begun._nay) throw new Error(begun._nay.message);
		const identity = {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			threadId: created._yay.threadId,
		};
		const call = await t.mutation(internal.ai_chat_files.begin_bash_invocation, {
			...identity,
			membershipId: seeded.membershipId,
			membershipLifetime: source.membershipLifetime,
			toolCallId: "stop",
			commandHash: "a".repeat(64),
			shellName: "default",
			run: { runId: begun._yay.runId, generation: begun._yay.generation },
		});
		if (call._nay || !("shell" in call._yay)) throw new Error("Expected a fresh shell");
		const shellId = call._yay.shell._id;
		const save = (cwd: string) =>
			t.mutation(internal.ai_chat.save_shell, {
				...identity,
				invocationId: call._yay.invocationId,
				shellId,
				cwd,
				cwdTarget: null,
				transcriptEntry: `$ ${cwd}`,
			});
		const patchTmp = () =>
			t.mutation(internal.ai_chat_files.patch_thread_tmp_files, {
				organizationId: identity.organizationId,
				workspaceId: identity.workspaceId,
				threadId: identity.threadId,
				invocationId: call._yay.invocationId,
				fileNodes: [{ path: "/tmp/after-stop.txt", kind: "file", mode: 0o644, size: 1, mtime: Date.now() }],
				fileNodesContent: [{ path: "/tmp/after-stop.txt", content: new TextEncoder().encode("x").buffer }],
				deletePaths: [],
			});

		// The same save passes first, so the refusals below can only come from Stop.
		await save("~/before");

		await asUser.mutation(api.ai_chat_runs.stop, {
			membershipId: seeded.membershipId,
			threadId: created._yay.threadId,
			replyId: null,
		});
		await expect(save("~/after")).rejects.toThrow("Stopped");
		await expect(patchTmp()).rejects.toThrow("Stopped");
		expect(await t.run((ctx) => ctx.db.get("ai_chat_bash_shells", shellId))).toMatchObject({
			cwd: "~/before",
			transcriptEntries: 1,
		});
		const tmpFiles = await t.run((ctx) =>
			ctx.db
				.query("ai_chat_files")
				.withIndex("by_thread_path", (q) => q.eq("threadId", identity.threadId))
				.collect(),
		);
		expect(tmpFiles).toEqual([]);
	});

	test("thread_run_begin reuses a saved message when the same request comes again", async () => {
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

		const source = await capture_source(t, { seeded, membershipId: seeded.membershipId, threadId });
		const send = () => send_messages(t, { source, parentId: null, messageIds: ["client_message_duplicate"] });
		const first = await send();
		const second = await send();

		expect(first._yay?.triggerId).toBeTruthy();
		expect(second._yay?.triggerId).toBe(first._yay?.triggerId);

		const messages = await t.run((ctx) =>
			ctx.db
				.query("ai_chat_threads_messages_aisdk_5")
				.withIndex("by_organization_workspace_thread", (q) =>
					q.eq("organizationId", seeded.organizationId).eq("workspaceId", seeded.workspaceId).eq("threadId", threadId),
				)
				.collect(),
		);
		// Each request gets its own reply, but the user message is saved once.
		expect(messages.filter((message) => message.content.role === "user")).toHaveLength(1);
	});

	test("/api/chat refuses raw browser parts with or without toolName", async () => {
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
		const send = (message: unknown) =>
			post_chat(asUser, { membershipId: seeded.membershipId, threadId, messages: [message] });

		const raw = {
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
		} as const;

		expect((await send(raw)).body).toContain("Invalid file tool result parts");

		const scrubbed = {
			...raw,
			id: "client_message_browser_scrubbed",
			parts: [
				{
					type: "tool-browser_run",
					toolCallId: "call-1",
					state: "output-available",
					input: {},
					output: {
						title: "Browser run",
						output: "Browser run: succeeded.",
						metadata: { status: "succeeded", reason: null, files: [{ kind: "private", id: "private-1" }] },
					},
				},
			],
		} as const;

		// The scrubbed part passes the part check. Only the next check, the role check, refuses it.
		expect((await send(scrubbed)).body).toContain("Only user messages can be sent");

		const dynamic = {
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
		} as const;

		expect((await send(dynamic)).body).toContain("Invalid file tool result parts");

		// Three more forged shapes. An unfinished call must carry no result. The input must be an
		// object with no keys, so an array is refused. The output line must read exactly
		// "<title>: <status>.", so no raw observation can travel inside it.
		for (const [index, part] of [
			{ ...raw.parts[0], input: {}, state: "input-available" },
			{ type: "tool-read_image", toolCallId: "call-3", state: "input-available", input: [] },
			{
				...scrubbed.parts[0],
				output: { ...scrubbed.parts[0].output, output: "short raw observation" },
			},
		].entries()) {
			const malformed = await send({ ...raw, id: `malformed-browser-${index}`, parts: [part] });
			expect(malformed.body).toContain("Invalid file tool result parts");
		}

		expect(await t.run((ctx) => ctx.db.query("ai_chat_threads_messages_aisdk_5").collect())).toHaveLength(0);
	});

	test("/api/chat refuses an oversized serialized message without storing it", async () => {
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
		const result = await post_chat(asUser, {
			membershipId: seeded.membershipId,
			threadId,
			messages: [
				{
					id: "client_oversized_message",
					role: "user",
					// A quote JSON-escapes to \" so the stored size is twice the text length.
					parts: [{ type: "text", text: '"'.repeat(460 * 1024) }],
				},
			],
		});
		expect(result.status).toBe(400);
		expect(result.body).toContain("Message is too large to store");
		expect(await t.run((ctx) => ctx.db.query("ai_chat_threads_messages_aisdk_5").collect())).toHaveLength(0);
	});

	test("/api/chat rejects file parts that break the image contract", async () => {
		const t = test_convex();
		// No billing state: a message that passes every message check stops at the credit check.
		const seeded = await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, {
				organizationName: "personal",
				workspaceName: "home",
				plan: null,
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
		const remoteUrlRejected = await post_chat(asUser, {
			membershipId: seeded.membershipId,
			threadId,
			messages: [
				{
					id: "client_message_remote_image",
					role: "user",
					parts: [{ type: "file", mediaType: "image/png", url: "https://attacker.example/image.png" }],
					metadata: {
						convexParentId: null,
						parentClientGeneratedId: null,
					},
				},
			],
		});
		expect(remoteUrlRejected.body).toContain("Invalid image attachments");

		const dataUrlAccepted = await post_chat(asUser, {
			membershipId: seeded.membershipId,
			threadId,
			messages: [
				{
					id: "client_message_data_url_image",
					role: "user",
					parts: [{ type: "file", mediaType: "image/png", url: "data:image/png;base64,aW1n" }],
					metadata: {
						convexParentId: null,
						parentClientGeneratedId: null,
					},
				},
			],
		});
		expect(dataUrlAccepted.status).toBe(402);
	});

	test("/api/chat only accepts file results with the strict shape", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, {
				organizationName: "personal",
				workspaceName: "home",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "clerk-ai-chat-files",
			external_id: seeded.userId,
			email: "ai-chat-files@test.local",
		});

		const created = await asUser.mutation(api.ai_chat.thread_create, {
			membershipId: seeded.membershipId,
			clientGeneratedId: "client_file_results",
			title: "File results",
			lastMessageAt: Date.now(),
		});
		const threadId = created._yay!.threadId;

		const safe = {
			type: "tool-image_generation",
			toolCallId: "image-1",
			state: "output-available",
			input: {},
			output: {
				title: "Generate image",
				output: "Generate image: succeeded.",
				metadata: {
					status: "succeeded",
					reason: null,
					files: [{ kind: "private", id: "pending-1" }],
				},
			},
		};
		const send = (part: unknown) =>
			post_chat(asUser, {
				membershipId: seeded.membershipId,
				threadId,
				messages: [
					{
						id: "file-result",
						role: "assistant",
						parts: [part],
						metadata: { convexParentId: null, parentClientGeneratedId: null },
					},
				],
			});

		// The safe part passes the part check. Only the next check, the role check, refuses it.
		expect((await send(safe)).body).toContain("Only user messages can be sent");

		// Every row below is refused. The first one is the old image output, which named an asset id
		// instead of a Files target. The others drop the `files` list, name an unknown tool, send a
		// non-empty input, or name one tool in `type` and another one in `toolName`.
		const invalid = [
			{ ...safe, output: { assetId: "old-image-asset", mediaType: "image/webp", size: 8 } },
			{ ...safe, output: { ...safe.output, metadata: { status: "succeeded" } } },
			{ ...safe, type: "tool-read_image" },
			{ ...safe, type: "tool-read_file" },
			{ ...safe, type: "dynamic-tool", toolName: "IMAGE_GENERATION", input: { result: "raw bytes" } },
			{ ...safe, type: "tool-browser_run", toolName: "bash" },
			{ ...safe, type: "tool-execute_code", toolName: "bash" },
			{
				...safe,
				type: "tool-execute_code",
				output: {
					title: "Execute code",
					output: "Result: 1",
					metadata: {
						executionId: "exec-1",
						status: "succeeded",
						elapsedMs: 1,
						resultTruncated: false,
						logsTruncated: false,
					},
				},
			},
		];
		for (const part of invalid) {
			expect((await send(part)).body).toContain("Invalid file tool result parts");
		}
		expect(await t.run((ctx) => ctx.db.query("ai_chat_threads_messages_aisdk_5").collect())).toHaveLength(0);
	});

	test("thread_run_begin reuses saved messages when the message write limit is exhausted", async () => {
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
		const source = await capture_source(t, { seeded, membershipId: seeded.membershipId, threadId });
		const send = (parentId: string | null, messageIds: string[]) => send_messages(t, { source, parentId, messageIds });

		const first = await send(null, ["client_message_duplicate_rate_limit"]);
		if (!first._yay) throw new Error("Expected the first message to be saved");

		// Three more new messages use the rest of the write limit.
		const remainingCapacity = await send(
			first._yay.replyId,
			Array.from({ length: 3 }, (_, index) => `client_message_rate_limit_${index}`),
		);
		expect(remainingCapacity._yay).toBeTruthy();
		expect((await send(null, ["client_message_over_limit"]))._nay?.message).toBe(
			rate_limiter_RATE_LIMIT_EXCEEDED_MESSAGE,
		);

		const retry = await send(null, ["client_message_duplicate_rate_limit"]);
		expect(retry._yay?.triggerId).toBe(first._yay.triggerId);
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

	test("a new thread starts read, a new message makes it unread, and thread_mark_read clears it", async ({
		onTestFinished,
	}) => {
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

		// Keep the answer in a later millisecond even when both mutations run at once.
		const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1);
		onTestFinished(() => clock.mockRestore());

		// A new message and its reply move `lastMessageAt` past the cursor. Nothing writes "unread".
		const added = await send_messages(t, {
			source: await capture_source(t, { seeded, membershipId: seeded.membershipId, threadId }),
			parentId: null,
			messageIds: ["client_message_read_cursor"],
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

		await send_messages(t, {
			source: await capture_source(t, { seeded, membershipId: seeded.membershipId, threadId: sourceThreadId }),
			parentId: null,
			messageIds: ["client_message_read_cursor_branch"],
		});

		const branched = await asUser.action(api.ai_chat.thread_branch, {
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

describe("chat run writes", () => {
	test.each(["leave", "rejoin", "read permission"] as const)(
		"refuses late messages and titles after %s",
		async (loss) => {
			const t = test_convex();
			const owner = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx, { organizationName: "run-team" }));
			const member = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
			const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: owner.userId });
			const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: member.userId });
			const invitation = {
				organizationId: owner.organizationId,
				workspaceId: owner.workspaceId,
				userIdToAdd: member.userId,
			};
			expect(await asOwner.mutation(api.organizations.invite_user_to_organization_workspace, invitation)).toEqual({
				_yay: null,
			});
			const membership = await t.run((ctx) =>
				ctx.db
					.query("organizations_workspaces_users")
					.withIndex("by_workspace_user_active", (q) =>
						q.eq("workspaceId", owner.workspaceId).eq("userId", member.userId).eq("active", true),
					)
					.first(),
			);
			if (!membership) throw new Error("Expected invited membership");
			const created = await asUser.mutation(api.ai_chat.thread_create, {
				membershipId: membership._id,
				clientGeneratedId: "captured-run",
				lastMessageAt: Date.now(),
			});
			if (created._nay) throw new Error(created._nay.message);
			const captured = await t.mutation(internal.ai_chat_workspaces.capture, {
				userId: member.userId,
				membershipId: membership._id,
			});
			if (captured._nay) throw new Error(captured._nay.message);
			const source = {
				organizationId: owner.organizationId,
				workspaceId: owner.workspaceId,
				userId: member.userId,
				threadId: created._yay.threadId,
				membershipId: membership._id,
				membershipLifetime: captured._yay.membershipLifetime,
			};
			const writeMessage = (id: string, runSource = source) =>
				send_messages(t, { source: runSource, parentId: null, messageIds: [id] });
			expect((await writeMessage("before"))._yay).toBeTruthy();
			expect(await asUser.mutation(internal.ai_chat.thread_run_set_title, { source, title: "Before" })).toEqual({
				_yay: null,
			});

			if (loss === "read permission") {
				const role = await asOwner.mutation(api.access_control.create_role, {
					organizationId: owner.organizationId,
					name: "Workspace maker",
					description: "",
					permissions: ["workspace.create"],
				});
				if (role._nay) throw new Error(role._nay.message);
				const organization = await t.run((ctx) => ctx.db.get("organizations", owner.organizationId));
				expect(
					await asOwner.mutation(api.access_control.set_user_role, {
						organizationId: owner.organizationId,
						workspaceId: organization!.defaultWorkspaceId!,
						userId: member.userId,
						role: role._yay.roleId,
					}),
				).toEqual({ _yay: null });
			} else {
				expect(
					await asUser.mutation(api.organizations.remove_user_from_organization, {
						organizationId: owner.organizationId,
						userIdToRemove: member.userId,
					}),
				).toEqual({ _yay: null });
				if (loss === "rejoin") {
					expect(await asOwner.mutation(api.organizations.invite_user_to_organization_workspace, invitation)).toEqual({
						_yay: null,
					});
				}
			}
			const read = () =>
				t.run(async (ctx) => ({
					thread: await ctx.db.get("ai_chat_threads", source.threadId),
					messages: await ctx.db.query("ai_chat_threads_messages_aisdk_5").collect(),
				}));
			// Refill the title write limit so it cannot hide a missing access check.
			const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10_000);
			onTestFinished(() => clock.mockRestore());
			const before = await read();
			expect.soft((await writeMessage("late"))._nay?.message).toBe("Unauthorized");
			expect.soft(await asUser.mutation(internal.ai_chat.thread_run_set_title, { source, title: "Late" })).toEqual({
				_nay: { message: "Unauthorized" },
			});
			expect.soft(await read()).toEqual(before);
			expect(before.thread?.title).toBe("Before");
			expect(
				before.messages
					.filter((message) => message.content.role === "user")
					.map((message) => message.clientGeneratedMessageId),
			).toEqual(["before"]);

			if (loss === "rejoin") {
				const rejoined = await t.run((ctx) =>
					ctx.db
						.query("organizations_workspaces_users")
						.withIndex("by_workspace_user_active", (q) =>
							q.eq("workspaceId", owner.workspaceId).eq("userId", member.userId).eq("active", true),
						)
						.first(),
				);
				if (!rejoined) throw new Error("Expected rejoined membership");
				const fresh = await t.mutation(internal.ai_chat_workspaces.capture, {
					userId: member.userId,
					membershipId: rejoined._id,
				});
				if (fresh._nay) throw new Error(fresh._nay.message);
				const freshSource = {
					...source,
					membershipId: rejoined._id,
					membershipLifetime: fresh._yay.membershipLifetime,
				};
				expect(freshSource.membershipLifetime).not.toBe(source.membershipLifetime);
				// Refreshing a membership id must not refresh a running model's captured lifetime.
				const staleSource = { ...freshSource, membershipLifetime: source.membershipLifetime };
				expect.soft((await writeMessage("stale-lifetime", staleSource))._yay).toBeUndefined();
				expect
					.soft(
						(await asUser.mutation(internal.ai_chat.thread_run_set_title, { source: staleSource, title: "Stale" }))
							._yay,
					)
					.toBeUndefined();
				expect.soft(await read()).toEqual(before);
				expect((await writeMessage("fresh", freshSource))._yay).toBeTruthy();
				expect(
					await asUser.mutation(internal.ai_chat.thread_run_set_title, { source: freshSource, title: "Fresh" }),
				).toEqual({ _yay: null });
				expect((await read()).thread?.title).toBe("Fresh");
			}
		},
	);
});
