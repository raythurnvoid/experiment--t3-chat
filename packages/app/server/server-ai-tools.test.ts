import "../convex/setup.test.ts";
import { test, expect, vi } from "vitest";
import type { ActionCtx } from "../convex/_generated/server";
import { ai_chat_tool_create_list_pages, ai_chat_tool_create_text_search_pages } from "./server-ai-tools.ts";
import { ai_chat_HARDCODED_ORG_ID, ai_chat_HARDCODED_PROJECT_ID } from "../shared/shared-utils.ts";
import { has_defined_property } from "../shared/shared-utils.ts";
import { pages_chunk_BITMASK_FLAGS } from "./pages-markdown-chunking-mastra.ts";

type server_ai_tools_test_user_identity = NonNullable<Awaited<ReturnType<ActionCtx["auth"]["getUserIdentity"]>>>;

const server_ai_tools_test_user_identity_default = {
	issuer: "https://clerk.test",
	subject: "subject-user-1",
	external_id: "user_1",
	name: "Test User",
} as unknown as server_ai_tools_test_user_identity;

const makeCtx = (
	runQueryImpl: (ref: any, args: any) => Promise<any>,
	args?: {
		userIdentity?: server_ai_tools_test_user_identity;
	},
): {
	ctx: ActionCtx;
	runQuery: ReturnType<typeof vi.fn>;
	getUserIdentity: ReturnType<typeof vi.fn>;
} => {
	const runQuery = vi.fn(runQueryImpl);
	const getUserIdentity = vi.fn(async () => args?.userIdentity ?? server_ai_tools_test_user_identity_default);
	const ctx = {
		runQuery,
		auth: {
			getUserIdentity,
		},
	} as unknown as ActionCtx;
	return { ctx, runQuery, getUserIdentity };
};

function isNotAsyncIterable<T>(value: T | AsyncIterable<T>): value is T {
	return !Symbol.asyncIterator || !(Symbol.asyncIterator in Object(value));
}

test("list_pages tool: inputSchema defaults", () => {
	const { ctx } = makeCtx(async () => ({ items: [], truncated: false }));
	const tool = ai_chat_tool_create_list_pages(ctx);

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

	const tool = ai_chat_tool_create_list_pages(ctx);
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

test("text_search_pages tool: renders line ranges and fragment markers", async () => {
	const searchReturn = {
		items: [
			{
				path: "/Docs/CodeGuide",
				markdownChunk: "```ts\nconst value = 1;\n```",
				chunkIndex: 2,
				lineStart: 41,
				lineEnd: 43,
				chunkFlags:
					pages_chunk_BITMASK_FLAGS.isCode |
					pages_chunk_BITMASK_FLAGS.hasMoreFragmentContentAbove |
					pages_chunk_BITMASK_FLAGS.hasMoreFragmentContentBelow,
				hasChunkAbove: true,
				hasChunkBelow: true,
			},
			{
				path: "/Docs/TableGuide",
				markdownChunk: "| a | b |\n|---|---|\n| 1 | 2 |",
				chunkIndex: 1,
				lineStart: 10,
				lineEnd: 12,
				chunkFlags: pages_chunk_BITMASK_FLAGS.isTable | pages_chunk_BITMASK_FLAGS.hasMoreFragmentContentBelow,
				hasChunkAbove: false,
				hasChunkBelow: true,
			},
		],
	};

	const { ctx, runQuery } = makeCtx(async (_ref, _args) => searchReturn);
	const tool = ai_chat_tool_create_text_search_pages(ctx);
	const result = await tool.execute?.({ query: "value", limit: 20 }, { toolCallId: "test", messages: [] });

	if (!result) {
		throw new Error("`result` is undefined");
	}
	if (!isNotAsyncIterable(result)) {
		throw new Error("`result` is AsyncIterable but expected sync object");
	}

	expect(runQuery).toHaveBeenCalledTimes(1);
	const [, args] = runQuery.mock.calls[0]!;
	expect(args).toEqual({
		workspaceId: ai_chat_HARDCODED_ORG_ID,
		projectId: ai_chat_HARDCODED_PROJECT_ID,
		query: "value",
		limit: 20,
		userId: "user_1",
	});

	expect(result.output).toContain("/Docs/CodeGuide (lines 41-43, chunk #2)");
	expect(result.output).toContain("... more code block content above");
	expect(result.output).toContain("... more code block content below");
	expect(result.output).toContain("/Docs/TableGuide (lines 10-12, chunk #1)");
	expect(result.output).toContain("... more table content below");
});
