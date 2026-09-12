import { convertToModelMessages, tool } from "ai";
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
		const tools = ai_chat_tool_budget_apply({ edit: tool({ inputSchema: z.object({}), execute: write }) }, budget);
		const first = tools.edit.execute!({}, { toolCallId: "one", messages: [] });
		const second = tools.edit.execute!({}, { toolCallId: "two", messages: [] });
		await expect(tools.edit.execute!({}, { toolCallId: "three", messages: [] })).rejects.toThrow(
			"This call was not run",
		);
		expect(write).toHaveBeenCalledTimes(2);
		expect(budget.exhausted).toBe(true);

		finish();
		await expect(first).resolves.toMatchObject({ metadata: { pendingUpdateId: "pending-1" } });
		await expect(second).resolves.toMatchObject({ metadata: { pendingUpdateId: "pending-1" } });
		expect(budget.remainingBytes).toBeGreaterThan(380 * 1024);
	});

	test("counts escaped input bytes and refuses a large write before execution", async () => {
		const write = vi.fn(async () => ({ title: "Edit", metadata: {}, output: "Saved" }));
		const tools = ai_chat_tool_budget_apply(
			{
				edit: tool({ inputSchema: z.object({ content: z.string() }), execute: write }),
			},
			ai_chat_tool_budget_create(),
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
		const tools = ai_chat_tool_budget_apply({ edit: tool({ inputSchema: z.object({}), execute: write }) }, budget);
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
});

describe("ai_chat_message_fits_storage", () => {
	test("counts JSON escapes and UTF-8 bytes instead of JavaScript characters", () => {
		expect(ai_chat_message_fits_storage({ parts: [{ type: "text", text: "a".repeat(890 * 1024) }] })).toBe(true);
		// "é" is 2 UTF-8 bytes; the NUL char JSON-escapes to 6, so both overshoot the limit.
		expect(ai_chat_message_fits_storage({ parts: [{ type: "text", text: "é".repeat(460 * 1024) }] })).toBe(false);
		expect(ai_chat_message_fits_storage({ parts: [{ type: "text", text: "\u0000".repeat(160 * 1024) }] })).toBe(false);
	});
});
