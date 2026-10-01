import { convertToModelMessages, stepCountIs, streamText, tool, wrapLanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, test, vi } from "vitest";
import z from "zod";
import {
	ai_chat_message_fits_storage,
	ai_chat_tool_budget_apply,
	ai_chat_tool_budget_create,
} from "./ai-chat-tool-budget.ts";

describe("ai_chat_tool_budget_apply", () => {
	test("reserves parallel write receipts before any write starts and queues the 3rd call", async () => {
		let finish!: () => void;
		const pending = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const write = vi.fn(async () => {
			await pending;
			return { title: "Edit", metadata: { pendingUpdateId: "pending-1" }, output: "Replaced 1 occurrence" };
		});
		const budget = ai_chat_tool_budget_create();
		const tools = ai_chat_tool_budget_apply({
			tools: { edit: tool({ inputSchema: z.object({}), execute: write }) },
			budget,
			reserve: {
				resultReservedBytes: 128 * 1024,
			},
		});
		const first = tools.edit.execute!({}, { toolCallId: "one", messages: [] });
		const second = tools.edit.execute!({}, { toolCallId: "two", messages: [] });
		const third = tools.edit.execute!({}, { toolCallId: "three", messages: [] });
		await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2));
		// The 3rd call waits without holding space, and runs once a running call gives its reserve back.
		expect(budget.queue).toHaveLength(1);
		expect(budget.exhausted).toBe(false);

		finish();
		await expect(first).resolves.toMatchObject({ metadata: { pendingUpdateId: "pending-1" } });
		await expect(second).resolves.toMatchObject({ metadata: { pendingUpdateId: "pending-1" } });
		await expect(third).resolves.toMatchObject({ output: "Replaced 1 occurrence" });
		expect(write).toHaveBeenCalledTimes(3);
		expect(budget.remainingBytes).toBeGreaterThan(380 * 1024);
		expect(budget.reservedInFlightBytes).toBe(0);
		expect(budget.queue).toHaveLength(0);
	});

	test("runs 5 parallel calls with a 72 KiB reserve and starts the 6th when one ends", async () => {
		const gates = new Map<string, () => void>();
		const call = vi.fn(async (_input: object, options: { toolCallId: string }) => {
			await new Promise<void>((resolve) => gates.set(options.toolCallId, resolve));
			return { title: "Call", metadata: {}, output: "done" };
		});
		const budget = ai_chat_tool_budget_create();
		const tools = ai_chat_tool_budget_apply({
			tools: { call: tool({ inputSchema: z.object({}), execute: call }) },
			budget,
			reserve: {
				resultReservedBytes: 72 * 1024,
			},
		});
		const running = [1, 2, 3, 4, 5, 6].map((index) =>
			tools.call.execute!({}, { toolCallId: `call-${index}`, messages: [] }),
		);
		await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(5));
		expect(gates.has("call-6")).toBe(false);

		gates.get("call-1")!();
		await vi.waitFor(() => expect(gates.has("call-6")).toBe(true));
		for (const id of ["call-2", "call-3", "call-4", "call-5", "call-6"]) gates.get(id)!();
		for (const result of running) await expect(result).resolves.toMatchObject({ output: "done" });
		expect(budget.exhausted).toBe(false);
	});

	test("a new call never passes a waiting call, even when it would fit", async () => {
		let finish!: () => void;
		const pending = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const started: string[] = [];
		const read = vi.fn(async (_input: { size: string }, options: { toolCallId: string }) => {
			started.push(options.toolCallId);
			await pending;
			return { title: "Read", metadata: {}, output: "small" };
		});
		const budget = ai_chat_tool_budget_create();
		const tools = ai_chat_tool_budget_apply({
			tools: { read: tool({ inputSchema: z.object({ size: z.string() }), execute: read }) },
			budget,
			reserve: { resultReservedBytes: 100 * 1024 },
		});
		const calls = [
			tools.read.execute!({ size: "a" }, { toolCallId: "one", messages: [] }),
			tools.read.execute!({ size: "a" }, { toolCallId: "two", messages: [] }),
			// About 40 KiB of input: this call needs about 220 KiB, more than the 184 KiB left, so it waits.
			tools.read.execute!({ size: "x".repeat(40 * 1024) }, { toolCallId: "big", messages: [] }),
			// This call needs about 100 KiB, so it would fit in the space left. It must still wait behind `big`.
			tools.read.execute!({ size: "a" }, { toolCallId: "small", messages: [] }),
		];
		await vi.waitFor(() => expect(started).toEqual(["one", "two"]));
		expect(budget.queue).toHaveLength(2);

		finish();
		for (const call of calls) await expect(call).resolves.toMatchObject({ output: "small" });
		expect(started).toEqual(["one", "two", "big", "small"]);
	});

	test("refuses a head that cannot fit after the running calls end, then looks at the next call", async () => {
		let finish!: () => void;
		const pending = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const read = vi.fn(async (input: { size: string }) => {
			await pending;
			// As large as the 128 KiB reserve, so the running calls give nothing back.
			return { title: "Read", metadata: {}, output: input.size === "a" ? "x".repeat(128 * 1024) : "small" };
		});
		const budget = ai_chat_tool_budget_create();
		const tools = ai_chat_tool_budget_apply({
			tools: { read: tool({ inputSchema: z.object({ size: z.string() }), execute: read }) },
			budget,
			reserve: { resultReservedBytes: 128 * 1024 },
		});
		const first = tools.read.execute!({ size: "a" }, { toolCallId: "one", messages: [] });
		const second = tools.read.execute!({ size: "a" }, { toolCallId: "two", messages: [] });
		const third = tools.read.execute!({ size: "b" }, { toolCallId: "three", messages: [] });
		await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));

		finish();
		await Promise.all([first, second]);
		await expect(third).rejects.toThrow("Tool budget reached");
		expect(read).toHaveBeenCalledTimes(2);
		expect(budget.exhausted).toBe(true);
		expect(budget.queue).toHaveLength(0);
	});

	test("the AI SDK starts a queued call when a running call of the same step ends", async () => {
		const gates = new Map([
			["1", Promise.withResolvers<void>()],
			["2", Promise.withResolvers<void>()],
		]);
		const started: string[] = [];
		const thirdStarted = Promise.withResolvers<void>();
		const read = vi.fn(async (_input: object, options: { toolCallId: string }) => {
			started.push(options.toolCallId);
			if (options.toolCallId === "3") thirdStarted.resolve();
			await gates.get(options.toolCallId)?.promise;
			return { title: "Read", metadata: {}, output: "tiny" };
		});
		const model = new MockLanguageModelV3({
			doStream: async () => ({
				stream: new ReadableStream({
					start(controller) {
						controller.enqueue({ type: "stream-start", warnings: [] });
						for (const id of ["1", "2", "3"]) {
							controller.enqueue({ type: "tool-call", toolCallId: id, toolName: "read", input: "{}" });
						}
						controller.enqueue({
							type: "finish",
							finishReason: { unified: "tool-calls", raw: undefined },
							usage: {
								inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
								outputTokens: { total: 30, text: 30, reasoning: undefined },
							},
						});
						controller.close();
					},
				}),
			}),
		});
		const tools = ai_chat_tool_budget_apply({
			tools: { read: tool({ inputSchema: z.object({}), execute: read }) },
			budget: ai_chat_tool_budget_create(),
			reserve: { resultReservedBytes: 128 * 1024 },
		});
		const result = streamText({ model, prompt: "Read three times.", maxRetries: 0, stopWhen: stepCountIs(1), tools });
		const drained = result.consumeStream();

		await vi.waitFor(() => expect(started).toEqual(["1", "2"]));
		gates.get("1")!.resolve();
		await thirdStarted.promise;
		// Call 3 started while call 2 is still blocked.
		expect(started).toEqual(["1", "2", "3"]);
		gates.get("2")!.resolve();
		await drained;
		expect((await result.toolResults).map((toolResult) => toolResult.toolCallId).sort()).toEqual(["1", "2", "3"]);
	});

	test("Stop removes a waiting call and no body runs", async () => {
		let finish!: () => void;
		const pending = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const read = vi.fn(async () => {
			await pending;
			return { title: "Read", metadata: {}, output: "small" };
		});
		const budget = ai_chat_tool_budget_create();
		const tools = ai_chat_tool_budget_apply({
			tools: { read: tool({ inputSchema: z.object({}), execute: read }) },
			budget,
			reserve: {
				resultReservedBytes: 128 * 1024,
			},
		});
		const stop = new AbortController();
		const running = [1, 2].map((index) =>
			tools.read.execute!({}, { toolCallId: `call-${index}`, messages: [], abortSignal: stop.signal }),
		);
		const waiting = tools.read.execute!({}, { toolCallId: "call-3", messages: [], abortSignal: stop.signal });
		await vi.waitFor(() => expect(budget.queue).toHaveLength(1));

		stop.abort();
		await expect(waiting).rejects.toThrow("Stopped. This call was not run.");
		expect(budget.queue).toHaveLength(0);
		finish();
		for (const result of running) await expect(result).resolves.toMatchObject({ output: "small" });
		expect(read).toHaveBeenCalledTimes(2);
		expect(budget.reservedInFlightBytes).toBe(0);
	});

	test("ends tool use for the reply when a call would not fit even after the running calls end", async () => {
		const read = vi
			.fn()
			.mockResolvedValueOnce({ title: "Read", metadata: {}, output: "x".repeat(300 * 1024) })
			.mockResolvedValue({ title: "Read", metadata: {}, output: "small" });
		const budget = ai_chat_tool_budget_create();
		const tools = ai_chat_tool_budget_apply({
			tools: { read: tool({ inputSchema: z.object({}), execute: read }) },
			budget,
			reserve: {
				resultReservedBytes: 128 * 1024,
			},
		});
		await tools.read.execute!({}, { toolCallId: "large", messages: [] });
		await expect(tools.read.execute!({}, { toolCallId: "next", messages: [] })).rejects.toThrow("Tool budget reached");
		expect(read).toHaveBeenCalledOnce();
		expect(budget.exhausted).toBe(true);
	});

	test("counts escaped input bytes and refuses a large write before execution", async () => {
		const write = vi.fn(async () => ({ title: "Edit", metadata: {}, output: "Saved" }));
		const tools = ai_chat_tool_budget_apply({
			tools: {
				edit: tool({ inputSchema: z.object({ content: z.string() }), execute: write }),
			},
			budget: ai_chat_tool_budget_create(),
			reserve: { resultReservedBytes: 128 * 1024 },
		});
		await expect(
			tools.edit.execute!({ content: "\u0000".repeat(12 * 1024) }, { toolCallId: "large", messages: [] }),
		).rejects.toThrow("Tool budget reached");
		expect(write).not.toHaveBeenCalled();
	});

	test("keeps a full 64 KiB file and its rules in ordinary replayed history", async () => {
		const body = "é".repeat(32 * 1024);
		const instructions = JSON.stringify({
			path: "/docs/AGENTS.md",
			scope: "/docs/",
			instructions: "Rule. ".repeat(5000),
		});
		const budget = ai_chat_tool_budget_create();
		const tools = ai_chat_tool_budget_apply({
			tools: {
				bash: tool({
					inputSchema: z.object({ command: z.string() }),
					execute: async () => ({ title: "exit 0", metadata: { exitCode: 0 }, output: body, instructions }),
				}),
			},
			budget,
			reserve: { resultReservedBytes: 128 * 1024 },
		});
		const input = { command: "cat /docs/notes.md" };
		const output = await tools.bash.execute!(input, { toolCallId: "read", messages: [] });
		expect(output).toEqual({ title: "exit 0", metadata: { exitCode: 0 }, output: body, instructions });
		const message = {
			id: "assistant-1",
			role: "assistant" as const,
			parts: [{ type: "tool-bash" as const, toolCallId: "read", state: "output-available" as const, input, output }],
		};
		expect(ai_chat_message_fits_storage(message)).toBe(true);
		const modelMessages = await convertToModelMessages([message]);
		expect(JSON.stringify(modelMessages)).toContain(body);
		expect(JSON.stringify(modelMessages)).toContain("AGENTS.md");
		expect(budget.remainingBytes).toBeGreaterThan(0);
	});

	test("keeps the successful outcome and rules when a write preview is too large", async () => {
		const instructions = "Rules from /docs/AGENTS.md";
		const write = vi.fn(async () => ({
			title: "/docs/notes.md",
			output: "x".repeat(500 * 1024),
			instructions,
			metadata: { pendingUpdateId: "pending-1", matches: 1, diff: "-old\n+new" },
		}));
		const budget = ai_chat_tool_budget_create();
		const tools = ai_chat_tool_budget_apply({
			tools: { edit: tool({ inputSchema: z.object({}), execute: write }) },
			budget,
			reserve: {
				resultReservedBytes: 128 * 1024,
			},
		});
		const result = await tools.edit.execute!({}, { toolCallId: "write", messages: [] });
		expect(write).toHaveBeenCalledOnce();
		expect(result).toMatchObject({
			instructions,
			metadata: {
				pendingUpdateId: "pending-1",
				matches: 1,
				diff: "[Diff preview omitted: this reply reached its tool budget.]",
			},
		});
		expect(result).toHaveProperty("output", expect.stringContaining("Output preview truncated"));
		expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThan(384 * 1024);
		expect(budget.remainingBytes).toBeGreaterThanOrEqual(0);
	});

	test("marks an MCP result as cut when the budget cuts its output", async () => {
		const call = vi.fn(async () => ({
			title: "echo",
			output: "x".repeat(500 * 1024),
			metadata: { kind: "mcp_result", truncated: false },
		}));
		const budget = ai_chat_tool_budget_create();
		const tools = ai_chat_tool_budget_apply({
			tools: { echo: tool({ inputSchema: z.object({}), execute: call }) },
			budget,
			reserve: {
				resultReservedBytes: 128 * 1024,
			},
		});
		const result = await tools.echo.execute!({}, { toolCallId: "mcp", messages: [] });
		expect(result).toMatchObject({ metadata: { kind: "mcp_result", truncated: true } });
		expect(result).toHaveProperty("output", expect.stringContaining("Output preview truncated"));
	});

	test("never runs a tool body after Stop while the finish is held for the usage save", async () => {
		let releaseFinish!: () => void;
		const finishHeld = new Promise<void>((resolve) => {
			releaseFinish = resolve;
		});
		let reachFinish!: () => void;
		const finishReached = new Promise<void>((resolve) => {
			reachFinish = resolve;
		});
		// Like the receipt middleware: hold the finish part until the usage save ends.
		const model = wrapLanguageModel({
			model: new MockLanguageModelV3({
				doStream: async () => ({
					stream: new ReadableStream({
						start(controller) {
							controller.enqueue({ type: "stream-start", warnings: [] });
							controller.enqueue({ type: "tool-call", toolCallId: "write-1", toolName: "write", input: "{}" });
							controller.enqueue({
								type: "finish",
								finishReason: { unified: "tool-calls", raw: undefined },
								usage: {
									inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
									outputTokens: { total: 30, text: 30, reasoning: undefined },
								},
							});
							controller.close();
						},
					}),
				}),
			}),
			middleware: {
				specificationVersion: "v3",
				wrapStream: async ({ doStream }) => {
					const { stream, ...rest } = await doStream();
					return {
						...rest,
						stream: stream.pipeThrough(
							new TransformStream({
								transform: async (part, controller) => {
									if (part.type === "finish") {
										reachFinish();
										await finishHeld;
									}
									controller.enqueue(part);
								},
							}),
						),
					};
				},
			},
		});
		const write = vi.fn(async () => ({ title: "Write", output: "written", metadata: {} }));
		const tools = ai_chat_tool_budget_apply({
			tools: { write: tool({ inputSchema: z.object({}), execute: write }) },
			budget: ai_chat_tool_budget_create(),
			reserve: { resultReservedBytes: 128 * 1024 },
		});
		const stop = new AbortController();
		const result = streamText({
			model,
			prompt: "Write it.",
			maxRetries: 0,
			stopWhen: stepCountIs(2),
			abortSignal: stop.signal,
			tools,
		});
		const drained = result.consumeStream();

		await finishReached;
		stop.abort();
		releaseFinish();
		await drained;

		expect(write).not.toHaveBeenCalled();
	});
});

describe("ai_chat_message_fits_storage", () => {
	test("counts JSON escapes and UTF-8 bytes instead of JavaScript characters", () => {
		expect(ai_chat_message_fits_storage({ parts: [{ type: "text", text: "a".repeat(890 * 1024) }] })).toBe(true);
		// "é" is 2 UTF-8 bytes; the NUL char JSON-escapes to 6, so both overshoot the limit.
		expect(ai_chat_message_fits_storage({ parts: [{ type: "text", text: "é".repeat(460 * 1024) }] })).toBe(false);
		expect(ai_chat_message_fits_storage({ parts: [{ type: "text", text: "\u0000".repeat(160 * 1024) }] })).toBe(false);
	});
});
