import { Workpool } from "@convex-dev/workpool";
import type { streamText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";

const model = vi.hoisted(() => ({ streamText: vi.fn() }));
vi.mock("ai", async (importOriginal) => ({
	...(await importOriginal<typeof import("ai")>()),
	streamText: model.streamText,
}));

beforeEach(() => {
	model.streamText.mockReset();
	vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("reply-storage-test-work" as never);
});

afterEach(() => {
	vi.restoreAllMocks();
});

/**
 * Stream one text reply through the real route. `duringModelCall` runs inside the model call, before the reply
 * is saved.
 */
async function send_text_reply(args: {
	text: string;
	duringModelCall?: (
		t: ReturnType<typeof test_convex>,
		membershipId: Id<"organizations_workspaces_users">,
	) => Promise<void>;
}) {
	const t = test_convex();
	const home = await t.run((ctx) =>
		test_mocks_fill_db_with.membership(ctx, { organizationName: "personal", workspaceName: "home" }),
	);
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: home.userId });
	const created = await asUser.mutation(api.ai_chat.thread_create, {
		membershipId: home.membershipId,
		clientGeneratedId: "reply-storage-chat",
		// Avoid a separate title model call.
		title: "Reply storage",
		lastMessageAt: Date.now(),
	});
	if (created._nay) throw new Error(created._nay.message);
	const threadId = created._yay.threadId;

	const actualAi = await vi.importActual<typeof import("ai")>("ai");
	const languageModel = new MockLanguageModelV3({
		doStream: async () => {
			await args.duringModelCall?.(t, home.membershipId);
			return {
				stream: new ReadableStream({
					start(controller) {
						controller.enqueue({ type: "stream-start", warnings: [] });
						controller.enqueue({ type: "text-start", id: "answer" });
						controller.enqueue({ type: "text-delta", id: "answer", delta: args.text });
						controller.enqueue({ type: "text-end", id: "answer" });
						controller.enqueue({
							type: "finish",
							finishReason: { unified: "stop", raw: undefined },
							// Zero usage keeps billing out of these tests.
							usage: {
								inputTokens: { total: 0, noCache: 0, cacheRead: undefined, cacheWrite: undefined },
								outputTokens: { total: 0, text: 0, reasoning: undefined },
							},
						});
						controller.close();
					},
				}),
			};
		},
	});
	model.streamText.mockImplementation((options: Parameters<typeof streamText>[0]) =>
		actualAi.streamText({ ...options, model: languageModel }),
	);

	const response = await asUser.fetch("/api/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			messages: [{ id: "reply-storage-request", role: "user", parts: [{ type: "text", text: "Answer me." }] }],
			parentId: null,
			mode: "agent",
			model: "gpt-6-luna",
			trigger: "submit-message",
			threadId,
			membershipId: home.membershipId,
			browserIntent: { webChoice: { provider: "cloud" }, selectionRevision: 0, policyRevision: 0 },
		}),
	});
	// A failed reply save rethrows inside the SDK's finish step, so reading the stream fails.
	const body = await response.text().then(
		(text) => ({ text, error: null }),
		(error: unknown) => ({ text: null, error }),
	);
	const messages = await t.run((ctx) => ctx.db.query("ai_chat_threads_messages_aisdk_5").collect());
	return { threadId, response, body, messages };
}

describe("/api/chat reply storage", () => {
	test("logs a reply that is too large to save, without its text", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

		const { threadId, response, body, messages } = await send_text_reply({
			text: "x".repeat(950 * 1024),
		});

		expect(response.status, body.text ?? "").toBe(200);
		expect(body.error).toBeNull();
		expect(body.text).toContain("This reply is too large and was not saved.");
		expect(messages.map((message) => message.content.role)).toEqual(["user"]);
		const lostReplyLogs = consoleError.mock.calls.filter((call) => call[0] === "Chat data not saved");
		expect(lostReplyLogs).toEqual([
			[
				"Chat data not saved",
				{
					reason: "reply_too_large",
					threadId,
					messageId: expect.any(String),
					bytes: expect.any(Number),
					limit: 900 * 1024,
				},
			],
		]);
		expect(lostReplyLogs[0]![1].bytes).toBeGreaterThan(950 * 1024);
		expect(JSON.stringify(lostReplyLogs)).not.toContain("xxxx");
	});

	test("logs a refused reply save, without its text", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

		const { threadId, body, messages } = await send_text_reply({
			text: "PRIVATE_REPLY_TEXT",
			// The membership ends during the model call, so the reply save is refused.
			duringModelCall: async (t, membershipId) => {
				await t.run((ctx) => ctx.db.patch("organizations_workspaces_users", membershipId, { active: false }));
			},
		});

		expect(body.error).toMatchObject({ message: "Failed to persist assistant message" });
		expect(messages.map((message) => message.content.role)).toEqual(["user"]);
		const lostReplyLogs = consoleError.mock.calls.filter((call) => call[0] === "Chat data not saved");
		expect(lostReplyLogs).toEqual([
			[
				"Chat data not saved",
				{
					reason: "reply_save_failed",
					threadId,
					messageId: expect.any(String),
					bytes: expect.any(Number),
					errorName: "Error",
				},
			],
		]);
		expect(JSON.stringify(lostReplyLogs)).not.toContain("PRIVATE_REPLY_TEXT");
	});
});
