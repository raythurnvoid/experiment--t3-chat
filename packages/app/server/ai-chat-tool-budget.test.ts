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
	test("reserves parallel write receipts before any write starts", async () => {
		let finish!: () => void;
		const pending = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const write = vi.fn(async () => {
			await pending;
			return { title: "Edit", metadata: { pendingUpdateId: "pending-1" }, output: "Replaced 1 occurrence" };
		});
		const budget = ai_chat_tool_budget_create();
		const tools = ai_chat_tool_budget_apply({ edit: tool({ inputSchema: z.object({}), execute: write }) }, budget, {
			resultReservedBytes: 128 * 1024,
		});
		const first = tools.edit.execute!({}, { toolCallId: "one", messages: [] });
		const second = tools.edit.execute!({}, { toolCallId: "two", messages: [] });
		await expect(tools.edit.execute!({}, { toolCallId: "three", messages: [] })).rejects.toThrow(
			"Too many tool calls at once. This call was not run.",
		);
		expect(write).toHaveBeenCalledTimes(2);
		// Refuse only the 3rd call: the running calls give back the reserve they do not use.
		expect(budget.exhausted).toBe(false);

		finish();
		await expect(first).resolves.toMatchObject({ metadata: { pendingUpdateId: "pending-1" } });
		await expect(second).resolves.toMatchObject({ metadata: { pendingUpdateId: "pending-1" } });
		expect(budget.remainingBytes).toBeGreaterThan(380 * 1024);
		expect(budget.reservedInFlightBytes).toBe(0);
		await expect(tools.edit.execute!({}, { toolCallId: "four", messages: [] })).resolves.toMatchObject({
			output: "Replaced 1 occurrence",
		});
		expect(write).toHaveBeenCalledTimes(3);
	});

	test("runs 5 parallel calls with a 72 KiB reserve and refuses only the 6th", async () => {
		let finish!: () => void;
		const pending = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const call = vi.fn(async () => {
			await pending;
			return { title: "Call", metadata: {}, output: "done" };
		});
		const budget = ai_chat_tool_budget_create();
		const tools = ai_chat_tool_budget_apply({ call: tool({ inputSchema: z.object({}), execute: call }) }, budget, {
			resultReservedBytes: 72 * 1024,
		});
		const running = [1, 2, 3, 4, 5].map((index) =>
			tools.call.execute!({}, { toolCallId: `call-${index}`, messages: [] }),
		);
		await expect(tools.call.execute!({}, { toolCallId: "call-6", messages: [] })).rejects.toThrow(
			"Too many tool calls at once",
		);
		expect(call).toHaveBeenCalledTimes(5);
		expect(budget.exhausted).toBe(false);

		finish();
		for (const result of running) await expect(result).resolves.toMatchObject({ output: "done" });
	});

	test("the refused call can still hit the budget when the running calls use their reserve", async () => {
		let finish!: () => void;
		const pending = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const read = vi.fn(async () => {
			await pending;
			// As large as the 128 KiB reserve, so the running calls give nothing back.
			return { title: "Read", metadata: {}, output: "x".repeat(128 * 1024) };
		});
		const budget = ai_chat_tool_budget_create();
		const tools = ai_chat_tool_budget_apply({ read: tool({ inputSchema: z.object({}), execute: read }) }, budget, {
			resultReservedBytes: 128 * 1024,
		});
		const first = tools.read.execute!({}, { toolCallId: "one", messages: [] });
		const second = tools.read.execute!({}, { toolCallId: "two", messages: [] });
		await expect(tools.read.execute!({}, { toolCallId: "three", messages: [] })).rejects.toThrow(
			"Too many tool calls at once",
		);

		finish();
		await Promise.all([first, second]);
		await expect(tools.read.execute!({}, { toolCallId: "three-again", messages: [] })).rejects.toThrow(
			"Tool budget reached",
		);
		expect(read).toHaveBeenCalledTimes(2);
		expect(budget.exhausted).toBe(true);
	});

	test("ends tool use for the reply when a call would not fit even after the running calls end", async () => {
		const read = vi
			.fn()
			.mockResolvedValueOnce({ title: "Read", metadata: {}, output: "x".repeat(300 * 1024) })
			.mockResolvedValue({ title: "Read", metadata: {}, output: "small" });
		const budget = ai_chat_tool_budget_create();
		const tools = ai_chat_tool_budget_apply({ read: tool({ inputSchema: z.object({}), execute: read }) }, budget, {
			resultReservedBytes: 128 * 1024,
		});
		await tools.read.execute!({}, { toolCallId: "large", messages: [] });
		await expect(tools.read.execute!({}, { toolCallId: "next", messages: [] })).rejects.toThrow("Tool budget reached");
		expect(read).toHaveBeenCalledOnce();
		expect(budget.exhausted).toBe(true);
	});

	test("counts escaped input bytes and refuses a large write before execution", async () => {
		const write = vi.fn(async () => ({ title: "Edit", metadata: {}, output: "Saved" }));
		const tools = ai_chat_tool_budget_apply(
			{
				edit: tool({ inputSchema: z.object({ content: z.string() }), execute: write }),
			},
			ai_chat_tool_budget_create(),
			{ resultReservedBytes: 128 * 1024 },
		);
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
		const tools = ai_chat_tool_budget_apply(
			{
				bash: tool({
					inputSchema: z.object({ command: z.string() }),
					execute: async () => ({ title: "exit 0", metadata: { exitCode: 0 }, output: body, instructions }),
				}),
			},
			budget,
			{ resultReservedBytes: 128 * 1024 },
		);
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
		const tools = ai_chat_tool_budget_apply({ edit: tool({ inputSchema: z.object({}), execute: write }) }, budget, {
			resultReservedBytes: 128 * 1024,
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
		const tools = ai_chat_tool_budget_apply({ echo: tool({ inputSchema: z.object({}), execute: call }) }, budget, {
			resultReservedBytes: 128 * 1024,
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
		const tools = ai_chat_tool_budget_apply(
			{ write: tool({ inputSchema: z.object({}), execute: write }) },
			ai_chat_tool_budget_create(),
			{ resultReservedBytes: 128 * 1024 },
		);
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
