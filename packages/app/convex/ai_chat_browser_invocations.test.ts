import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

async function fixture() {
	const t = test_convex();
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const thread = await asUser.mutation(api.ai_chat.thread_create, {
		membershipId: db.membershipId,
		clientGeneratedId: "browser-claim-thread",
		lastMessageAt: Date.now(),
	});
	if (thread._nay) throw new Error(thread._nay.message);
	const captured = await t.mutation(internal.ai_chat_workspaces.capture, {
		userId: db.userId,
		membershipId: db.membershipId,
	});
	if (captured._nay) throw new Error(captured._nay.message);
	const sourceMessageId = await t.run((ctx) =>
		ctx.db.insert("ai_chat_threads_messages_aisdk_5", {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			threadId: thread._yay.threadId,
			clientGeneratedMessageId: "browser-request",
			parentId: null,
			content: { role: "user", parts: [] },
			createdBy: db.userId,
			updatedAt: Date.now(),
		}),
	);
	const source = {
		...db,
		threadId: thread._yay.threadId,
		sourceMessageId,
		membershipLifetime: captured._yay.membershipLifetime,
	};
	const browserIntent = { webChoice: { provider: "cloud" as const }, selectionRevision: 0, policyRevision: 0 };
	const identity = { source, browserIntent, toolCallId: "open-1", operationHash: "a".repeat(64), resource: null };
	const begin = (changes: Partial<typeof identity> = {}) =>
		t.mutation(internal.ai_chat_files.begin_browser_invocation, {
			...identity,
			...changes,
			timeoutMs: 30_000,
		});
	return { t, db, asUser, source, browserIntent, identity, begin };
}

describe("begin_browser_invocation", () => {
	test("reuses the exact call identity and refuses changed input", async () => {
		const f = await fixture();
		const first = await f.begin();
		if (first._nay) throw new Error(first._nay.message);
		expect(first._yay.isNew).toBe(true);
		const duplicate = await f.begin();
		expect(duplicate._yay).toEqual({ ...first._yay, isNew: false });
		expect((await f.begin({ operationHash: "b".repeat(64) }))._nay?.name).toBe("invocation_changed");
		expect(await f.t.run((ctx) => ctx.db.query("ai_chat_browser_invocations").collect())).toHaveLength(1);
	});

	test("retains the no-replay identity after its deadline and result expiry", async () => {
		const f = await fixture();
		const first = await f.begin();
		if (first._nay) throw new Error(first._nay.message);
		vi.setSystemTime(first._yay.deadlineAt + 1);
		expect((await f.begin())._yay).toMatchObject({
			isNew: false,
			status: "interrupted",
			commandId: first._yay.commandId,
		});
		await f.t.mutation(internal.ai_chat_files.finish_browser_invocation, {
			invocationId: first._yay.invocationId,
			operationHash: f.identity.operationHash,
			commandId: first._yay.commandId,
			result: { status: "unknown", reason: "outcome_unknown" },
		});
		vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
		await f.t.mutation(internal.ai_chat_files.cleanup_expired_browser_results, {});
		expect((await f.begin())._yay).toMatchObject({
			isNew: false,
			status: "finished",
			result: null,
			resultExpired: true,
		});
	});

	test("requires the exact saved user message and an active creator-owned chat", async () => {
		const f = await fixture();
		await f.t.run((ctx) =>
			ctx.db.patch("ai_chat_threads_messages_aisdk_5", f.source.sourceMessageId, { content: { role: "assistant" } }),
		);
		expect((await f.begin())._nay).toBeDefined();
		await f.t.run((ctx) =>
			ctx.db.patch("ai_chat_threads_messages_aisdk_5", f.source.sourceMessageId, { content: { role: "user" } }),
		);
		await f.t.run((ctx) => ctx.db.patch("ai_chat_threads", f.source.threadId, { archived: true }));
		expect((await f.begin())._nay).toBeDefined();
		expect(await f.t.run((ctx) => ctx.db.query("ai_chat_browser_invocations").collect())).toEqual([]);
	});

	test("does not restore a queued request after a member is removed and re-added", async () => {
		const f = await fixture();
		await f.t.run(async (ctx) => {
			await ctx.db.delete("organizations_workspaces_users", f.db.membershipId);
			await ctx.db.insert("organizations_workspaces_users", {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				userId: f.db.userId,
				active: true,
			});
		});
		expect((await f.begin())._nay).toBeDefined();
	});
});

describe("browser preferences", () => {
	test("has one cloud-enabled default without creating a profile or session", async () => {
		const f = await fixture();
		expect(
			await f.asUser.query(api.files_browser.current_browser_preferences, { membershipId: f.db.membershipId }),
		).toEqual({
			...f.browserIntent,
			webAgentAccess: true,
			agentBlockedHosts: [],
			syncPending: false,
		});
		expect(await f.t.run((ctx) => ctx.db.query("files_browser_profiles").collect())).toEqual([]);
		expect(await f.t.run((ctx) => ctx.db.query("files_browser_sessions").collect())).toEqual([]);
	});

	test("blocks old web intent after Off, and allows explicit file open claims", async () => {
		const f = await fixture();
		const changed = await f.t.mutation(internal.files_browser.change_browser_preferences, {
			userId: f.db.userId,
			membershipId: f.db.membershipId,
			change: { kind: "access", enabled: false },
		});
		if (changed._nay) throw new Error(changed._nay.message);
		expect((await f.begin())._nay?.name).toBe("browser_intent_changed");
		await f.t.mutation(internal.files_browser.finish_browser_preferences_sync, {
			preferenceId: changed._yay._id,
			policyRevision: 1,
			selectionRevision: 0,
		});
		const newIntent = { ...f.browserIntent, policyRevision: 1 };
		expect((await f.begin({ browserIntent: newIntent }))._nay?.name).toBe("agent_access_off");
		const file = await f.t.mutation(internal.ai_chat_files.begin_browser_invocation, {
			...f.identity,
			mode: "file",
			timeoutMs: 30_000,
		});
		expect(file._yay?.isNew).toBe(true);
	});

	test("keeps changed policy pending until both runners acknowledge its exact revision", async () => {
		const f = await fixture();
		const changed = await f.t.mutation(internal.files_browser.change_browser_preferences, {
			userId: f.db.userId,
			membershipId: f.db.membershipId,
			change: { kind: "hosts", hosts: [" Bank.Example. ", "bank.example"] },
		});
		if (changed._nay) throw new Error(changed._nay.message);
		expect(changed._yay).toMatchObject({ policyRevision: 1, syncPending: true, agentBlockedHosts: ["bank.example"] });
		expect((await f.begin({ browserIntent: { ...f.browserIntent, policyRevision: 1 } }))._nay?.name).toBe(
			"policy_sync_pending",
		);
		expect(
			await f.t.mutation(internal.files_browser.finish_browser_preferences_sync, {
				preferenceId: changed._yay._id,
				policyRevision: 0,
				selectionRevision: 0,
			}),
		).toBe(false);
	});

	test("a new send uses the new saved choice while the queued send stays refused", async () => {
		const f = await fixture();
		const changed = await f.t.mutation(internal.files_browser.change_browser_preferences, {
			userId: f.db.userId,
			membershipId: f.db.membershipId,
			change: { kind: "choice", webChoice: { provider: "none" } },
		});
		if (changed._nay) throw new Error(changed._nay.message);
		await f.t.mutation(internal.files_browser.finish_browser_preferences_sync, {
			preferenceId: changed._yay._id,
			policyRevision: 0,
			selectionRevision: 1,
		});
		expect((await f.begin())._nay?.name).toBe("browser_intent_changed");
		expect(
			(
				await f.t.query(internal.files_browser.check_browser_source, {
					source: f.source,
					browserIntent: { webChoice: { provider: "none" }, policyRevision: 0, selectionRevision: 1 },
				})
			)._yay,
		).toBeNull();
	});
});

describe("finish_browser_invocation", () => {
	test("accepts only the same command receipt, even after its source message is gone", async () => {
		const f = await fixture();
		const first = await f.begin();
		if (first._nay) throw new Error(first._nay.message);
		await f.t.run((ctx) => ctx.db.delete("ai_chat_threads_messages_aisdk_5", f.source.sourceMessageId));
		const finish = {
			invocationId: first._yay.invocationId,
			operationHash: f.identity.operationHash,
			commandId: first._yay.commandId,
			result: { status: "cancelled" as const, reason: "source_revoked" },
		};
		expect(
			(await f.t.mutation(internal.ai_chat_files.finish_browser_invocation, { ...finish, commandId: "other-command" }))
				._nay?.name,
		).toBe("invocation_changed");
		expect((await f.t.mutation(internal.ai_chat_files.finish_browser_invocation, finish))._yay?.result).toEqual(
			finish.result,
		);
		expect(
			(
				await f.t.mutation(internal.ai_chat_files.finish_browser_invocation, {
					...finish,
					result: { status: "succeeded", reason: null },
				})
			)._yay?.result,
		).toEqual(finish.result);
	});
});

describe("resolve_cloud_browser_invocation", () => {
	async function pending_call(operationKind: "run" | "management" = "run") {
		const f = await fixture();
		const sessionId = await f.t.run((ctx) =>
			ctx.db.insert("files_browser_sessions", {
				mode: "web",
				ownerId: f.db.userId,
				billedUserId: f.db.userId,
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				navigationGeneration: 1,
				loadGen: 0,
				controlGen: 1,
				control: "ready",
				billing: { state: "pending" },
				runnerSessionId: "runner-1",
				agentAccess: true,
				tabId: "tab-1",
				tabGen: 1,
				viewedTabId: "tab-1",
				viewGen: 1,
				tabCount: 1,
				tabs: [{ tabId: "tab-1", tabGen: 1, navGen: 1 }],
				policyRevision: 0,
				selectionRevision: 0,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}),
		);
		const claim = await f.t.mutation(internal.ai_chat_files.begin_browser_invocation, {
			...f.identity,
			operationKind,
			resource: {
				provider: "cloud",
				mode: "web",
				sessionId,
				navGen: 1,
				loadGen: 0,
				controlGen: 1,
				tabId: "tab-1",
				tabGen: 1,
			},
			timeoutMs: 30_000,
		});
		if (claim._nay) throw new Error(claim._nay.message);
		vi.setSystemTime(claim._yay.receiptResolutionDeadline + 1);
		await f.t.mutation(internal.ai_chat_files.interrupt_browser_invocation, { invocationId: claim._yay.invocationId });
		return { ...f, claim: claim._yay, sessionId };
	}

	function runner(replies: unknown[]) {
		vi.stubEnv("BROWSER_RUNNER_URL", "https://browser-runner.test");
		vi.stubEnv("BROWSER_RUNNER_SECRET", "test-secret");
		const calls: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				calls.push(url.slice(url.lastIndexOf("/") + 1));
				if (replies.length === 0) throw new Error("No test reply");
				return Response.json(replies.shift());
			}),
		);
		return calls;
	}

	test("does not release malformed or unknown cleanup after the resolution deadline", async () => {
		const f = await pending_call();
		const calls = runner([{ ok: true }, { ok: true, alive: true }]);
		await f.t.action(internal.ai_chat_files.resolve_cloud_browser_invocation, { invocationId: f.claim.invocationId });
		expect(calls).toEqual(["command-fence", "status"]);
		const stored = await f.t.query(internal.ai_chat_files.load_browser_invocation_receipt_identity, {
			invocationId: f.claim.invocationId,
		});
		expect(stored?.status).toBe("interrupted");
		expect(stored?.result).toBeUndefined();
	});

	test("stores a completed error as an error and never replays input", async () => {
		const f = await pending_call();
		const calls = runner([
			{
				ok: true,
				status: "completed",
				commandId: f.claim.commandId,
				codeHash: f.identity.operationHash,
				result: { cleanup: "complete", reason: "timed_out" },
			},
		]);
		await f.t.action(internal.ai_chat_files.resolve_cloud_browser_invocation, { invocationId: f.claim.invocationId });
		expect(calls).toEqual(["command-fence"]);
		expect(
			await f.t.query(internal.ai_chat_files.load_browser_invocation_receipt_identity, {
				invocationId: f.claim.invocationId,
			}),
		).toMatchObject({ status: "finished", result: { status: "errored", reason: "timed_out" } });
	});

	test("keeps a lost open linked until provider closure and bills its real usage", async () => {
		const f = await fixture();
		const claim = await f.begin();
		if (claim._nay) throw new Error(claim._nay.message);
		const sessionId = await f.t.run((ctx) =>
			ctx.db.insert("files_browser_sessions", {
				mode: "web",
				ownerId: f.db.userId,
				billedUserId: f.db.userId,
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				navigationGeneration: 1,
				loadGen: 0,
				controlGen: 0,
				control: "starting",
				billing: { state: "pending" },
				agentAccess: true,
				tabId: null,
				tabGen: 0,
				viewedTabId: null,
				viewGen: 0,
				tabCount: 0,
				tabs: [],
				policyRevision: 0,
				selectionRevision: 0,
				startingExpiresAt: Date.now() + 1_000,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}),
		);
		expect(
			await f.t.mutation(internal.ai_chat_files.bind_browser_open_invocation, {
				commandId: claim._yay.commandId,
				source: f.source,
				sessionId,
			}),
		).toEqual({ _yay: null });
		vi.setSystemTime(claim._yay.deadlineAt + 1);
		await f.t.mutation(internal.files_browser.cleanup_expired_browser_docs, {});
		expect(await f.t.run((ctx) => ctx.db.get("files_browser_sessions", sessionId))).not.toBeNull();
		await f.t.mutation(internal.ai_chat_files.interrupt_browser_invocation, { invocationId: claim._yay.invocationId });
		const usage = { providerAcquiredAt: Date.now() - 30_000, endedAt: Date.now(), reason: "interrupted_open" };
		const calls = runner([
			{
				ok: true,
				status: "completed",
				result: { reason: null, cleanup: "complete" },
				session: {
					mode: "web",
					sessionId: "runner-open",
					navGen: 1,
					loadGen: 0,
					controlGen: 1,
					control: "ready",
					agentAccess: true,
					tabId: "tab-1",
					tabGen: 1,
					viewedTabId: "tab-1",
					viewGen: 1,
					tabCount: 1,
					policyRevision: 0,
					selectionRevision: 0,
					idleUntil: Date.now() + 300_000,
					totalUntil: Date.now() + 1_200_000,
				},
			},
			{ ok: true, existed: true, verified: true, usage },
			{ ok: true, alive: false, closing: false, usage, profileStored: false },
		]);
		await f.t.action(internal.ai_chat_files.resolve_cloud_browser_invocation, {
			invocationId: claim._yay.invocationId,
		});
		expect(calls).toEqual(["operation-status", "close", "status"]);
		expect(await f.t.run((ctx) => ctx.db.get("files_browser_sessions", sessionId))).toMatchObject({
			control: "closed",
			billing: { state: "settled", billedMs: 30_000, amountCents: 0.3 },
		});
		expect(
			await f.t.query(internal.ai_chat_files.load_browser_invocation_receipt_identity, {
				invocationId: claim._yay.invocationId,
			}),
		).toMatchObject({ status: "finished", result: { status: "unknown", reason: "outcome_unknown" } });
	});
});
