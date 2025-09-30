import "../convex/test.setup.ts";
import { test, expect, vi } from "vitest";
import type { ActionCtx } from "../convex/_generated/server";
import { ai_tool_create_list_pages } from "./server-ai-tools.ts";
import { ai_chat_HARDCODED_ORG_ID, ai_chat_HARDCODED_PROJECT_ID } from "../src/lib/ai-chat.ts";
import { has_defined_property } from "../src/lib/utils.ts";

const makeCtx = (
	runQueryImpl: (ref: any, args: any) => Promise<any>,
): { ctx: ActionCtx; runQuery: ReturnType<typeof vi.fn> } => {
	const runQuery = vi.fn(runQueryImpl);
	const ctx = { runQuery } as unknown as ActionCtx;
	return { ctx, runQuery };
};

function isNotAsyncIterable<T>(value: T | AsyncIterable<T>): value is T {
	return !Symbol.asyncIterator || !(Symbol.asyncIterator in Object(value));
}

test("list_pages tool: inputSchema defaults", () => {
	const { ctx } = makeCtx(async () => ({ items: [], truncated: false }));
	const tool = ai_tool_create_list_pages(ctx);

	const parsed = has_defined_property(tool.inputSchema, "parse") ? tool.inputSchema.parse({}) : undefined;
	expect(parsed).toEqual({ path: "/", maxDepth: 5, limit: 100 });
});

test("list_pages tool: execute renders tree, applies ignore, and calls convex with correct args", async () => {
	const now = Date.now();
	const listReturn = {
		items: [
			{ path: "/Docs", updatedAt: now, depthTruncated: false },
			{ path: "/Docs/Guides", updatedAt: now, depthTruncated: true },
			{ path: "/Docs/Tutorial", updatedAt: now, depthTruncated: false },
			{ path: "/Play", updatedAt: now, depthTruncated: false },
		],
		truncated: false,
	};

	const { ctx, runQuery } = makeCtx(async (_ref, _args) => {
		// Only list_pages is called by this tool
		return listReturn;
	});

	const tool = ai_tool_create_list_pages(ctx);
	const result = await tool.execute?.(
		{ path: "/", maxDepth: 10, limit: 100, ignore: ["**/Play"] },
		{ toolCallId: "test", messages: [] },
	);

	if (!result) {
		throw new Error("`result` is undefined");
	}

	if (!isNotAsyncIterable(result)) {
		throw new Error("`result` is AsyncIterable but expected sync object");
	}

	// Verify convex call
	expect(runQuery).toHaveBeenCalledTimes(1);
	const calls = runQuery.mock.calls;
	const [, args] = calls[0];
	expect(args).toEqual({
		path: "/",
		workspaceId: ai_chat_HARDCODED_ORG_ID,
		projectId: ai_chat_HARDCODED_PROJECT_ID,
		maxDepth: 10,
		limit: 100,
	});

	expect(result.metadata.count).toBe(3); // Play ignored
	expect(result.metadata.truncated).toBe(false);

	expect(result.output).toBe(
		"" +
			"/\n" + //
			"  Docs/\n" + //
			"    Guides/\n" + //
			"      ... (children truncated due to `maxDepth`)\n" + //
			"    Tutorial/\n",
	);
});
