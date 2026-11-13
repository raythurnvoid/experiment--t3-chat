import { Workpool } from "@convex-dev/workpool";
import type { streamText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { getFunctionAddress } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import type { ActionCtx } from "./_generated/server.js";
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

type StreamPart =
	Awaited<ReturnType<MockLanguageModelV3["doStream"]>>["stream"] extends ReadableStream<infer T> ? T : never;

const LIMIT_NOTICE = 'The agent reached its reply limit before it could answer. Send "continue" to try again.';

/**
 * Stream one reply through the real route and SDK. Hooks place access loss or Stop at the save boundary.
 */
async function send_text_reply(args: {
	text?: string;
	parts?: StreamPart[];
	finishReason?: Extract<StreamPart, { type: "finish" }>["finishReason"]["unified"];
	signal?: AbortSignal;
	duringModelCall?: (
		t: ReturnType<typeof test_convex>,
		membershipId: Id<"organizations_workspaces_users">,
	) => Promise<void>;
	beforeStepSave?: (
		ctx: ActionCtx,
		threadId: Id<"ai_chat_threads">,
		membershipId: Id<"organizations_workspaces_users">,
		parts: unknown[],
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
				stream: new ReadableStream<StreamPart>({
					start(controller) {
						controller.enqueue({ type: "stream-start", warnings: [] });
						if (args.text !== undefined) {
							controller.enqueue({ type: "text-start", id: "answer" });
							controller.enqueue({ type: "text-delta", id: "answer", delta: args.text });
							controller.enqueue({ type: "text-end", id: "answer" });
						}
						for (const part of args.parts ?? []) controller.enqueue(part);
						controller.enqueue({
							type: "finish",
							finishReason: { unified: args.finishReason ?? "stop", raw: undefined },
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

	const requestInit: RequestInit = {
		method: "POST",
		signal: args.signal,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			messages: [{ id: "reply-storage-request", role: "user", parts: [{ type: "text", text: "Answer me." }] }],
			parentId: null,
			mode: "agent",
			model: "gpt-6-luna",
			trigger: "submit-message",
			threadId,
			membershipId: home.membershipId,
			browserIntent: { policyRevision: 0 },
			pluginPage: null,
		}),
	};
	const intercepted = args.beforeStepSave
		? await asUser.action(async (ctx) => {
				const runMutation: typeof ctx.runMutation = async (ref, mutationArgs) => {
					if (getFunctionAddress(ref).name === "ai_chat_runs:step_complete") {
						await args.beforeStepSave!(ctx, threadId, home.membershipId, mutationArgs.parts);
					}
					return await ctx.runMutation(ref, mutationArgs);
				};
				const { ai_chat_http_chat_response } = await import("./ai_chat.ts");
				const response = await ai_chat_http_chat_response(
					{ ...ctx, runMutation },
					new Request("https://app.test/api/chat", requestInit),
				);
				return { status: response.status, text: await response.text() };
			})
		: null;
	const response = intercepted
		? new Response(intercepted.text, { status: intercepted.status })
		: await asUser.fetch("/api/chat", requestInit);
	// A failed reply save rethrows inside the SDK's finish step, so reading the stream fails.
	const body = await response.text().then(
		(text) => ({ text, error: null }),
		(error: unknown) => ({ text: null, error }),
	);
	const messages = await t.run((ctx) => ctx.db.query("ai_chat_threads_messages_aisdk_5").collect());
	const steps = await t.run((ctx) => ctx.db.query("ai_chat_run_steps").collect());
	return { t, asUser, home, threadId, response, body, messages, steps, languageModel };
}

describe("/api/chat reply storage", () => {
	test.each(["empty", "reasoning", "whitespace"] as const)(
		"streams and saves one limit notice for %s output",
		async (kind) => {
			const fx = await send_text_reply({
				finishReason: "length",
				text: kind === "whitespace" ? " \n\t" : undefined,
				parts:
					kind === "reasoning"
						? [
								{ type: "reasoning-start", id: "thinking" },
								{ type: "reasoning-delta", id: "thinking", delta: "Still planning." },
								{ type: "reasoning-end", id: "thinking" },
							]
						: [],
			});

			expect(fx.response.status).toBe(200);
			expect(fx.body.error).toBeNull();
			expect(fx.body.text?.split(JSON.stringify(LIMIT_NOTICE)).length, "live notice appears exactly once").toBe(2);
			expect(fx.steps).toHaveLength(1);
			expect(fx.steps[0]?.parts.filter((part) => part.type === "text" && part.text === LIMIT_NOTICE)).toHaveLength(1);
			expect(fx.steps[0]?.finishReason, "saved step keeps the model finish reason").toBe("length");
			expect(fx.steps[0]?.status).toBe("done");
			expect(fx.messages.at(-1)?.status).toBe("done");
			expect(fx.languageModel.doStreamCalls).toHaveLength(1);
			const branch = await fx.asUser.query(api.ai_chat_runs.branch_page, {
				membershipId: fx.home.membershipId,
				threadId: fx.threadId,
				anchorId: null,
				fromId: null,
				stopId: null,
			});
			expect(branch?.nodes[0]?.content.parts).toEqual(fx.steps[0]?.parts);
			// A whitespace provider part and the notice stay separate even though both are text.
			if (kind === "whitespace") {
				const starts = fx.body
					.text!.split("\n")
					.filter((line) => line.includes('"type":"text-start"'))
					.map((line) => JSON.parse(line.slice(6)) as { id: string });
				expect(starts).toHaveLength(2);
				expect(starts[0]?.id).toBe("answer");
				expect(starts[1]?.id).not.toBe("answer");
				expect(fx.steps[0]?.parts.filter((part) => part.type === "text").map((part) => part.text)).toEqual([
					" \n\t",
					LIMIT_NOTICE,
				]);
			}
		},
	);

	test.each(["stop", "content-filter", "error"] as const)(
		"keeps an empty %s finish distinct from a limit",
		async (finishReason) => {
			const fx = await send_text_reply({ finishReason });
			expect(fx.body.error).toBeNull();
			expect(fx.body.text).not.toContain("reached its reply limit");
			expect(fx.steps[0]?.finishReason).toBe(finishReason);
			expect(JSON.stringify(fx.steps)).not.toContain(LIMIT_NOTICE);
		},
	);

	test("keeps a partial answer when the output reaches the limit", async () => {
		const fx = await send_text_reply({ text: "The work so far.", finishReason: "length" });
		expect(fx.body.text).not.toContain("reached its reply limit");
		expect(fx.steps[0]?.parts.filter((part) => part.type === "text")).toMatchObject([{ text: "The work so far." }]);
		expect(fx.steps[0]?.finishReason).toBe("length");
	});

	test("does not hide a provider error behind a later length finish", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const fx = await send_text_reply({
			parts: [{ type: "error", error: new Error("Provider failed") }],
			finishReason: "length",
		});
		expect(fx.body.text).toContain("Provider failed");
		expect(fx.body.text).not.toContain("reached its reply limit");
		expect(JSON.stringify(fx.steps)).not.toContain(LIMIT_NOTICE);
		expect(fx.languageModel.doStreamCalls).toHaveLength(1);
	});

	test("an abort before the provider finish adds no limit notice", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const abort = new AbortController();
		const fx = await send_text_reply({
			finishReason: "length",
			signal: abort.signal,
			duringModelCall: async () => abort.abort(),
		});
		expect(fx.body.text).not.toContain("reached its reply limit");
		expect(JSON.stringify(fx.steps)).not.toContain(LIMIT_NOTICE);
		// The SDK reports no output when this abort lands before its first completed step.
		expect(fx.messages.at(-1)?.status).toBe("failed");
		expect(fx.steps.every((step) => step.status !== "done")).toBe(true);
		expect(fx.languageModel.doStreamCalls).toHaveLength(1);
	});

	test("Stop after notice insertion saves only the stopped partial tail", async () => {
		const fx = await send_text_reply({
			finishReason: "length",
			beforeStepSave: async (ctx, threadId, membershipId, parts) => {
				expect(parts).toContainEqual({ type: "text", text: LIMIT_NOTICE, state: "done" });
				const stopped = await ctx.runMutation(api.ai_chat_runs.stop, { threadId, membershipId, replyId: null });
				expect(stopped._nay).toBeUndefined();
			},
		});
		expect(fx.response.status, fx.body.text ?? "").toBe(200);
		expect(fx.body.error).toBeNull();
		expect(fx.steps).toHaveLength(1);
		expect(fx.steps[0]).toMatchObject({ status: "partial", finishReason: null });
		expect(fx.steps[0]?.parts).toContainEqual({ type: "text", text: LIMIT_NOTICE, state: "done" });
		expect(fx.messages.at(-1)?.status).toBe("stopped");
		expect((await fx.t.run((ctx) => ctx.db.query("ai_chat_runs").first()))?.status).toBe("ended");
		expect(fx.languageModel.doStreamCalls).toHaveLength(1);
	});

	test("logs a reply that is too large to save, without its text", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

		const { threadId, response, body, messages, steps } = await send_text_reply({
			text: "x".repeat(950 * 1024),
		});

		expect(response.status, body.text ?? "").toBe(200);
		expect(body.error).toBeNull();
		expect(body.text).toContain("This reply is too large and was not saved.");
		// The reply node exists from the start. The step with the reply text is not saved.
		expect(messages.map((message) => message.content.role)).toEqual(["user", "assistant"]);
		expect(steps).toEqual([]);
		const lostReplyLogs = consoleError.mock.calls.filter((call) => call[0] === "Chat data not saved");
		expect(lostReplyLogs).toEqual([
			[
				"Chat data not saved",
				{
					reason: "reply_too_large",
					threadId,
					runId: expect.any(String),
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

		const { t, threadId, body, messages, steps } = await send_text_reply({
			text: "PRIVATE_REPLY_TEXT",
			// The membership ends during the model call, so the reply save is refused.
			duringModelCall: async (t, membershipId) => {
				await t.run((ctx) => ctx.db.patch("organizations_workspaces_users", membershipId, { active: false }));
			},
		});

		// The step save stops the run instead of failing the stream.
		expect(body.error).toBeNull();
		// The reply node exists from the start. The step with the reply text is not saved.
		expect(messages.map((message) => message.content.role)).toEqual(["user", "assistant"]);
		expect(steps).toEqual([]);
		const lostReplyLogs = consoleError.mock.calls.filter((call) => call[0] === "Chat data not saved");
		expect(lostReplyLogs).toEqual([
			[
				"Chat data not saved",
				{
					reason: "access_lost",
					threadId,
					runId: expect.any(String),
					messageId: expect.any(String),
				},
			],
		]);
		expect(JSON.stringify(lostReplyLogs)).not.toContain("PRIVATE_REPLY_TEXT");
		const run = await t.run((ctx) => ctx.db.query("ai_chat_runs").first());
		expect(run?.status).toBe("ended");
	});
});
