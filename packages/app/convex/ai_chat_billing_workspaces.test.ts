import { Workpool } from "@convex-dev/workpool";
import { R2 } from "@convex-dev/r2";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";

// Replace only the OpenAI provider model. The receipt middleware that wraps it stays real, so the
// test sees the same billing path as production.
const provider = vi.hoisted(() => ({ model: null as MockLanguageModelV3 | null }));
vi.mock("@ai-sdk/openai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@ai-sdk/openai")>();
	return {
		...actual,
		openai: Object.assign(() => provider.model, actual.openai),
	};
});

beforeEach(() => {
	provider.model = null;
	vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("billing-workspaces-test-work" as never);
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (key) => ({
		key: key ?? "test",
		url: `https://r2.test/upload?key=${encodeURIComponent(key ?? "test")}`,
	}));
	vi.spyOn(R2.prototype, "getUrl").mockImplementation(
		async (key) => `https://r2.test/object?key=${encodeURIComponent(key)}`,
	);
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	const objects = new Map<string, BodyInit>();
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
			const key = url.searchParams.get("key") ?? "";
			if (init?.method === "PUT") {
				objects.set(key, init.body ?? "");
				return new Response(null, { status: 200 });
			}
			const body = objects.get(key);
			return new Response(body ?? null, { status: body === undefined ? 404 : 200 });
		}),
	);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("/api/chat billing across workspaces", () => {
	// Zero-token runs make the same proposal, but must not bill either user before Save.
	test.each([
		{ billingMode: "organization_owner", inputTokens: 1_000 },
		{ billingMode: "user", inputTokens: 1_000 },
		{ billingMode: "organization_owner", inputTokens: 0 },
		{ billingMode: "user", inputTokens: 0 },
	] as const)(
		"keeps $billingMode billing on the team for a personal proposal ($inputTokens input tokens per step)",
		async ({ billingMode, inputTokens }) => {
			const t = test_convex();
			// These fixtures use the real local billing ledger, without a Polar account.
			const owner = await t.run((ctx) =>
				test_mocks_fill_db_with.membership(ctx, { organizationName: "billing-team", workspaceName: "home" }),
			);
			const home = await t.run((ctx) =>
				test_mocks_fill_db_with.membership(ctx, { organizationName: "personal", workspaceName: "home" }),
			);
			const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: owner.userId });
			const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: home.userId });
			expect(
				await asOwner.mutation(api.organizations.invite_user_to_organization_workspace, {
					organizationId: owner.organizationId,
					workspaceId: owner.workspaceId,
					userIdToAdd: home.userId,
				}),
			).toEqual({ _yay: null });
			expect(
				await asOwner.mutation(api.organizations.set_organization_billing_mode, {
					organizationId: owner.organizationId,
					billingMode,
				}),
			).toEqual({ _yay: null });
			const membership = await t.run((ctx) =>
				ctx.db
					.query("organizations_workspaces_users")
					.withIndex("by_workspace_user_active", (q) =>
						q.eq("workspaceId", owner.workspaceId).eq("userId", home.userId).eq("active", true),
					)
					.unique(),
			);
			if (!membership) throw new Error("Expected team membership");
			const created = await asUser.mutation(api.ai_chat.thread_create, {
				membershipId: membership._id,
				clientGeneratedId: "billing-workspaces-chat",
				// Avoid a separate title model call and its usage charge.
				title: "Personal notes from a team chat",
				lastMessageAt: Date.now(),
			});
			if (created._nay) throw new Error(created._nay.message);
			const threadId = created._yay.threadId;
			const meters = () =>
				t.run(async (ctx) => ({
					owner: (await ctx.db
						.query("billing_usage_snapshots")
						.withIndex("by_user", (q) => q.eq("userId", owner.userId))
						.unique())!.meter!,
					user: (await ctx.db
						.query("billing_usage_snapshots")
						.withIndex("by_user", (q) => q.eq("userId", home.userId))
						.unique())!.meter!,
				}));
			const before = await meters();
			const outputTokens = inputTokens / 4;
			let step = 0;
			const languageModel = new MockLanguageModelV3({
				doStream: async () => ({
					stream: new ReadableStream({
						start(controller) {
							const firstStep = step++ === 0;
							controller.enqueue({ type: "stream-start", warnings: [] });
							if (firstStep) {
								controller.enqueue({
									type: "tool-call",
									toolCallId: "write-personal-note",
									toolName: "bash",
									input: JSON.stringify({
										command:
											"printf '%s' 'PRIVATE_BILLING_NOTE' > /home/cloud-usr/w/personal/home/billing-note.txt && cat /home/cloud-usr/w/personal/home/billing-note.txt",
									}),
								});
							} else {
								controller.enqueue({ type: "text-start", id: "answer" });
								controller.enqueue({
									type: "text-delta",
									id: "answer",
									delta: "Your personal note is ready for review.",
								});
								controller.enqueue({ type: "text-end", id: "answer" });
							}
							controller.enqueue({
								type: "finish",
								finishReason: { unified: firstStep ? "tool-calls" : "stop", raw: undefined },
								usage: {
									inputTokens: {
										total: inputTokens,
										noCache: inputTokens,
										cacheRead: undefined,
										cacheWrite: undefined,
									},
									outputTokens: { total: outputTokens, text: outputTokens, reasoning: undefined },
								},
							});
							controller.close();
						},
					}),
				}),
			});
			provider.model = languageModel;

			const response = await asUser.fetch("/api/chat", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					messages: [
						{ id: "personal-note-request", role: "user", parts: [{ type: "text", text: "Write my personal note." }] },
					],
					parentId: null,
					mode: "agent",
					model: "gpt-6-luna",
					trigger: "submit-message",
					threadId,
					membershipId: membership._id,
					browserIntent: { policyRevision: 0 },
				}),
			});
			const body = await response.text();
			expect(response.status, body).toBe(200);
			expect(body).not.toContain('"type":"error"');
			expect(languageModel.doStreamCalls).toHaveLength(2);
			const results = languageModel.doStreamCalls[1]!.prompt.flatMap((message) =>
				message.role === "tool" ? message.content.filter((part) => part.type === "tool-result") : [],
			);
			expect(results).toEqual([
				expect.objectContaining({
					toolCallId: "write-personal-note",
					toolName: "bash",
					output: expect.objectContaining({
						type: "json",
						value: expect.objectContaining({
							output: expect.stringContaining("PRIVATE_BILLING_NOTE"),
							metadata: expect.objectContaining({ exitCode: 0 }),
						}),
					}),
				}),
			]);
			const proposals = await t.run((ctx) => ctx.db.query("files_pending_updates").collect());
			expect(proposals).toEqual([
				expect.objectContaining({
					organizationId: home.organizationId,
					workspaceId: home.workspaceId,
					userId: home.userId,
					threadIds: [threadId],
					target: expect.objectContaining({ kind: "private" }),
					content: expect.objectContaining({ base: { kind: "new" } }),
				}),
			]);
			expect(
				await asUser.query(api.ai_chat_files.get_file_output_target, {
					membershipId: membership._id,
					target: proposals[0]!.target,
				}),
			).toMatchObject({
				path: "/billing-note.txt",
				organizationName: "personal",
				workspaceName: "home",
				readiness: "ready",
			});
			expect(await t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual([]);
			const thread = await t.run((ctx) => ctx.db.get("ai_chat_threads", threadId));
			expect(thread).toMatchObject({
				organizationId: owner.organizationId,
				workspaceId: owner.workspaceId,
				createdBy: home.userId,
			});
			expect(thread?.activeRun).toBeUndefined();
			const messages = await t.run((ctx) => ctx.db.query("ai_chat_threads_messages_aisdk_5").collect());
			expect(messages.map((message) => message.content.role)).toEqual(["user", "assistant"]);
			const after = await meters();
			const payer = billingMode === "organization_owner" ? "owner" : "user";
			const other = payer === "owner" ? "user" : "owner";
			const payerId = payer === "owner" ? owner.userId : home.userId;
			// One receipt per provider request: the tool step and the answer step.
			const receipts = await t.run((ctx) => ctx.db.query("ai_model_call_receipts").collect());
			expect(receipts).toEqual([
				expect.objectContaining({
					purpose: "chat_step",
					modelId: "gpt-6-luna",
					threadId,
					billedUserId: payerId,
					actorUserId: home.userId,
					organizationId: owner.organizationId,
					workspaceId: owner.workspaceId,
					usage: expect.objectContaining({ state: "reported", inputTokens, outputTokens }),
					nextRecoveryAt: null,
					tokens: expect.objectContaining({ state: inputTokens === 0 ? "skipped_zero" : "debited" }),
					images: [],
				}),
				expect.objectContaining({
					usage: expect.objectContaining({ state: "reported", inputTokens, outputTokens }),
					tokens: expect.objectContaining({ state: inputTokens === 0 ? "skipped_zero" : "debited" }),
				}),
			]);
			if (inputTokens === 0) {
				expect(after).toEqual(before);
				return;
			}
			const amount = receipts[0]!.tokens!.amountCents + receipts[1]!.tokens!.amountCents;
			expect(amount).toBeGreaterThan(0);
			expect(after[payer].balance).toBeLessThan(before[payer].balance);
			expect(before[payer].balance - after[payer].balance).toBeCloseTo(amount, 8);
			expect(after[payer].consumedUnits - before[payer].consumedUnits).toBeCloseTo(amount, 8);
			expect(after[other]).toEqual(before[other]);
		},
	);
});
