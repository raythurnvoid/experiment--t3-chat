import { Workpool } from "@convex-dev/workpool";
import { R2 } from "@convex-dev/r2";
import type { streamText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.js";
import * as billing_db from "./billing_db.ts";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";

const model = vi.hoisted(() => ({ streamText: vi.fn() }));
vi.mock("ai", async (importOriginal) => ({
	...(await importOriginal<typeof import("ai")>()),
	streamText: model.streamText,
}));

beforeEach(() => {
	model.streamText.mockReset();
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
			// Observe the real ingest call; do not replace it or create test billing events.
			const ingest = vi.spyOn(billing_db, "billing_ingest_events");
			const actualAi = await vi.importActual<typeof import("ai")>("ai");
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
			// Only replace the provider. The SDK, route, tool, and finish callbacks stay real.
			model.streamText.mockImplementation((options: Parameters<typeof streamText>[0]) =>
				actualAi.streamText({ ...options, model: languageModel }),
			);

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
				}),
			});
			const body = await response.text();
			expect(response.status, body).toBe(200);
			expect(body).not.toContain('"type":"error"');
			expect(model.streamText).toHaveBeenCalledTimes(1);
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
			if (inputTokens === 0) {
				expect(ingest).not.toHaveBeenCalled();
				expect(after).toEqual(before);
				return;
			}
			expect(ingest).toHaveBeenCalledTimes(1);
			const billedUserEvents = ingest.mock.calls[0]![1].billedUserEvents;
			const payer = billingMode === "organization_owner" ? "owner" : "user";
			const other = payer === "owner" ? "user" : "owner";
			const payerId = payer === "owner" ? owner.userId : home.userId;
			expect(billedUserEvents).toEqual([
				expect.objectContaining({
					billedUser: expect.objectContaining({ _id: payerId }),
					event: expect.objectContaining({
						name: "ai_usage",
						externalCustomerId: payerId,
						externalMemberId: home.userId,
						metadata: expect.objectContaining({
							actorUserId: home.userId,
							billedUserId: payerId,
							organizationId: owner.organizationId,
							workspaceId: owner.workspaceId,
							threadId,
							inputTokens: inputTokens * 2,
							outputTokens: outputTokens * 2,
						}),
					}),
				}),
			]);
			const amount = billedUserEvents[0]!.event.metadata.amount;
			expect(amount).toBeGreaterThan(0);
			expect(after[payer].balance).toBeLessThan(before[payer].balance);
			expect(before[payer].balance - after[payer].balance).toBeCloseTo(amount, 8);
			expect(after[payer].consumedUnits - before[payer].consumedUnits).toBeCloseTo(amount, 8);
			expect(after[other]).toEqual(before[other]);
		},
	);
});
