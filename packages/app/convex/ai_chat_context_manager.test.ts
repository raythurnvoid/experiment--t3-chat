import { Workpool } from "@convex-dev/workpool";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { ai_chat_runs_db_insert_node } from "./ai_chat_runs.ts";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";

// Replace only the OpenAI provider model. The receipt middleware that wraps it stays real, so the
// summary call bills through a receipt like in production.
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
	vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("context-manager-test-work" as never);
});

afterEach(() => {
	vi.restoreAllMocks();
});

// `@ai-sdk/provider` is not a direct dependency, so take its types from the mock.
type CallOptions = MockLanguageModelV3["doStreamCalls"][number];
type StreamPart =
	Awaited<ReturnType<MockLanguageModelV3["doStream"]>>["stream"] extends ReadableStream<infer T> ? T : never;

const SUMMARY_TEXT = "SUMMARY-OF-OLDER-TURNS";

type ToolCall = { toolCallId: string; toolName: string; input: unknown };

/**
 * One model step: text, one tool call, or several parallel calls. `inputTokens` is what the
 * provider says it read. `finishReason` replaces the normal one.
 */
function step_stream(args: {
	step: { text: string } | ToolCall | { calls: ToolCall[] };
	inputTokens: number;
	finishReason?: "length";
}) {
	const { step, inputTokens, finishReason } = args;

	const parts: StreamPart[] = [{ type: "stream-start", warnings: [] }];
	if ("text" in step) {
		parts.push(
			{ type: "text-start", id: "answer" },
			{ type: "text-delta", id: "answer", delta: step.text },
			{ type: "text-end", id: "answer" },
		);
	} else {
		for (const call of "calls" in step ? step.calls : [step]) {
			parts.push({
				type: "tool-call",
				toolCallId: call.toolCallId,
				toolName: call.toolName,
				input: JSON.stringify(call.input),
			});
		}
	}
	parts.push({
		type: "finish",
		finishReason: { unified: finishReason ?? ("text" in step ? "stop" : "tool-calls"), raw: undefined },
		usage: {
			inputTokens: { total: inputTokens, noCache: inputTokens, cacheRead: undefined, cacheWrite: undefined },
			outputTokens: { total: 1, text: 1, reasoning: undefined },
		},
	});
	return {
		stream: new ReadableStream<StreamPart>({
			start(controller) {
				for (const part of parts) controller.enqueue(part);
				controller.close();
			},
		}),
	};
}

/**
 * The system text of one model request.
 */
function system_text(options: CallOptions) {
	return options.prompt.flatMap((message) => (message.role === "system" ? [message.content] : [])).join("\n");
}

/**
 * The tool results of one model request, by tool call id.
 */
function tool_results(options: CallOptions) {
	return new Map(
		options.prompt.flatMap((message) =>
			message.role === "tool"
				? message.content.flatMap((part) =>
						part.type === "tool-result" ? [[part.toolCallId, part.output] as const] : [],
					)
				: [],
		),
	);
}

async function setup() {
	const t = test_convex();
	const membership = await t.run((ctx) =>
		test_mocks_fill_db_with.membership(ctx, { organizationName: "personal", workspaceName: "home" }),
	);
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: membership.userId });
	const thread = await asUser.mutation(api.ai_chat.thread_create, {
		membershipId: membership.membershipId,
		clientGeneratedId: "context-manager-thread",
		// Avoid a separate title model call.
		title: "Context manager",
		lastMessageAt: Date.now(),
	});
	if (thread._nay) throw new Error(thread._nay.message);
	return { t, asUser, membership, threadId: thread._yay.threadId };
}

async function send(
	fx: Awaited<ReturnType<typeof setup>>,
	args: { messageId: string; text: string; parentId: string | null },
) {
	const response = await fx.asUser.fetch("/api/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			messages: [{ id: args.messageId, role: "user", parts: [{ type: "text", text: args.text }] }],
			parentId: args.parentId,
			mode: "ask",
			model: "gpt-6-luna",
			trigger: "submit-message",
			threadId: fx.threadId,
			membershipId: fx.membership.membershipId,
			browserIntent: { policyRevision: 0 },
		}),
	});
	const body = await response.text();
	expect(response.status, body).toBe(200);
}

/**
 * 12 messages of about 80 KB. They fill more than 85% of the 1 MiB history budget.
 */
async function seed_long_branch(fx: Awaited<ReturnType<typeof setup>>) {
	return await fx.t.run(async (ctx) => {
		const thread = (await ctx.db.get("ai_chat_threads", fx.threadId))!;
		const ids: Id<"ai_chat_threads_messages_aisdk_5">[] = [];
		for (let index = 0; index < 12; index++) {
			const id = `old-${index}`;
			ids.push(
				await ai_chat_runs_db_insert_node(ctx, {
					thread,
					parentId: ids.at(-1) ?? null,
					createdBy: fx.membership.userId,
					clientGeneratedMessageId: id,
					content: { id, role: "user", parts: [{ type: "text", text: `${id} ${"word ".repeat(16_000)}` }] },
					status: "done",
					runId: null,
					wakePending: false,
					jobFinishInvocationId: null,
					newest: "set",
					now: Date.now(),
				}),
			);
		}
		return ids;
	});
}

describe("/api/chat history compaction", () => {
	test("summarizes the older part of a long branch once, and the next walk shows the summary", async () => {
		const fx = await setup();
		const nodeIds = await seed_long_branch(fx);

		provider.model = new MockLanguageModelV3({
			doStream: async (options) =>
				step_stream({
					step: { text: system_text(options).startsWith("You write a summary") ? SUMMARY_TEXT : "Answer" },
					inputTokens: 10,
				}),
		});
		await send(fx, { messageId: "new-question", text: "What next?", parentId: nodeIds.at(-1)! });

		// About 80 KiB stay word for word. One old message is just under that, so the newest two old
		// messages and the new question stay. The summary replaces the older ten.
		const compactions = await fx.t.run((ctx) => ctx.db.query("ai_chat_compactions").collect());
		expect(compactions).toHaveLength(1);
		expect(compactions[0]).toMatchObject({
			threadId: fx.threadId,
			headNodeId: nodeIds[0],
			tailNodeId: nodeIds[9],
			summary: SUMMARY_TEXT,
		});

		// The summary call read the old messages. The chat step read the summary, not the old text.
		const [summaryCall, chatCall] = provider.model.doStreamCalls;
		expect(JSON.stringify(summaryCall!.prompt)).toContain("old-0 word");
		expect(provider.model.doStreamCalls).toHaveLength(2);
		const chatPrompt = JSON.stringify(chatCall!.prompt);
		expect(chatPrompt).toContain(SUMMARY_TEXT);
		expect(chatPrompt).not.toContain("old-0 word");
		expect(chatPrompt).not.toContain("old-9 word");
		expect(chatPrompt).toContain("old-10 word");
		expect(chatPrompt).toContain("What next?");

		// The summary call bills through its own receipt.
		const receipts = await fx.t.run((ctx) => ctx.db.query("ai_model_call_receipts").collect());
		expect(receipts.map((receipt) => receipt.purpose).toSorted()).toEqual(["chat_step", "compaction"]);
	});

	test("does not save a summary that the output limit cut", async () => {
		const fx = await setup();
		const nodeIds = await seed_long_branch(fx);

		provider.model = new MockLanguageModelV3({
			doStream: async (options) =>
				system_text(options).startsWith("You write a summary")
					? step_stream({ step: { text: SUMMARY_TEXT }, inputTokens: 10, finishReason: "length" })
					: step_stream({ step: { text: "Answer" }, inputTokens: 10 }),
		});
		await send(fx, { messageId: "new-question", text: "What next?", parentId: nodeIds.at(-1)! });

		// The turn goes on with the cut history, without the partial summary.
		const compactions = await fx.t.run((ctx) => ctx.db.query("ai_chat_compactions").collect());
		expect(compactions).toEqual([]);
		const chatPrompt = JSON.stringify(provider.model.doStreamCalls[1]!.prompt);
		expect(chatPrompt).not.toContain(SUMMARY_TEXT);
		expect(chatPrompt).toContain("What next?");
	});
});

describe("/api/chat tool output clearing", () => {
	test("keeps the newest 3 tool outputs once the measured input passes 100k tokens", async () => {
		const fx = await setup();
		// Five steps each read a different missing image, then one step answers. The provider says
		// every step read 150k tokens.
		provider.model = new MockLanguageModelV3({
			doStream: async () => {
				const index = provider.model!.doStreamCalls.length - 1;
				return step_stream({
					step:
						index < 5
							? {
									toolCallId: `read-${index}`,
									toolName: "view_image",
									input: { workspace: "current", path: `/missing-${index}.png` },
								}
							: { text: "Done" },
					inputTokens: 150_000,
				});
			},
		});
		await send(fx, { messageId: "read-images", text: "Read the images.", parentId: null });

		const calls = provider.model.doStreamCalls;
		expect(calls).toHaveLength(6);
		const results = tool_results(calls[5]!);
		for (const id of ["read-0", "read-1"]) {
			expect(results.get(id)).toEqual({
				type: "text",
				value: "[Older tool output cleared to save context. Run the tool again if you need it.]",
			});
		}
		for (const id of ["read-2", "read-3", "read-4"]) {
			expect(JSON.stringify(results.get(id))).not.toContain("cleared to save context");
		}

		// The saved reply keeps every output.
		const steps = await fx.t.run((ctx) => ctx.db.query("ai_chat_run_steps").collect());
		expect(JSON.stringify(steps)).not.toContain("cleared to save context");
	});

	test("keeps every output of the last step, even past the newest 3", async () => {
		const fx = await setup();
		// One step reads five missing images in parallel, then one step answers.
		provider.model = new MockLanguageModelV3({
			doStream: async () =>
				provider.model!.doStreamCalls.length === 1
					? step_stream({
							step: {
								calls: [0, 1, 2, 3, 4].map((index) => ({
									toolCallId: `read-${index}`,
									toolName: "view_image",
									input: { workspace: "current", path: `/missing-${index}.png` },
								})),
							},
							inputTokens: 150_000,
						})
					: step_stream({ step: { text: "Done" }, inputTokens: 150_000 }),
		});
		await send(fx, { messageId: "read-images", text: "Read the images.", parentId: null });

		const calls = provider.model.doStreamCalls;
		expect(calls).toHaveLength(2);
		const results = tool_results(calls[1]!);
		expect(results.size).toBe(5);
		for (const output of results.values()) {
			expect(JSON.stringify(output)).not.toContain("cleared to save context");
		}
	});
});

describe("/api/chat loop detection", () => {
	test("warns about a repeated call and ends the run after 3 warnings that changed nothing", async () => {
		const fx = await setup();
		// The model reads the same missing image again and again while it has tools.
		provider.model = new MockLanguageModelV3({
			doStream: async (options) => {
				const index = provider.model!.doStreamCalls.length - 1;
				return step_stream({
					step:
						(options.tools ?? []).length > 0
							? {
									toolCallId: `again-${index}`,
									toolName: "view_image",
									input: { workspace: "current", path: "/missing.png" },
								}
							: { text: "I am stuck." },
					inputTokens: 10,
				});
			},
		});
		await send(fx, { messageId: "loop", text: "Read the image.", parentId: null });

		const calls = provider.model.doStreamCalls;
		// Steps 0 to 2 make the first three calls. Steps 3, 4 and 5 get a warning and repeat the call
		// anyway. Step 6 is the last step.
		expect(calls).toHaveLength(7);
		expect(system_text(calls[2]!)).not.toContain("same input");
		expect(system_text(calls[3]!)).toContain("You called view_image again with the same input");
		expect(system_text(calls[5]!)).not.toContain("This is the last step.");
		expect(system_text(calls[6]!)).toContain("This is the last step.");
		expect(calls[6]!.tools ?? []).toEqual([]);
	});
});
