import { test_mocks_hardcoded } from "../convex/setup.test.ts";
import { test, expect, vi } from "vitest";
import type { ActionCtx } from "../convex/_generated/server";
import {
	ai_chat_tool_create_list_pages,
	ai_chat_tool_create_read_page,
	ai_chat_tool_create_text_search_pages,
	ai_chat_tool_create_write_page,
	ai_chat_tool_create_edit_page,
	replace_once_or_all,
} from "./server-ai-tools.ts";
import { has_defined_property } from "../shared/shared-utils.ts";
import { pages_chunk_BITMASK_FLAGS } from "./pages-markdown-chunking-mastra.ts";

type server_ai_tools_test_user_identity = NonNullable<Awaited<ReturnType<ActionCtx["auth"]["getUserIdentity"]>>>;

const server_ai_tools_test_ctx_data = {
	workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
	projectId: test_mocks_hardcoded.project_id.project_1,
	userId: test_mocks_hardcoded.user.user_1.id,
} as const;

const server_ai_tools_test_user_identity_default = {
	issuer: "https://clerk.test",
	subject: "subject-user-1",
	external_id: "user_1",
	name: "Test User",
} as unknown as server_ai_tools_test_user_identity;

const makeCtx = (
	runQueryImpl: (ref: any, args: any) => Promise<any>,
	args?: {
		runMutationImpl?: (ref: any, args: any) => Promise<any>;
		userIdentity?: server_ai_tools_test_user_identity;
	},
): {
	ctx: ActionCtx;
	runQuery: ReturnType<typeof vi.fn>;
	runMutation: ReturnType<typeof vi.fn>;
	getUserIdentity: ReturnType<typeof vi.fn>;
} => {
	const runQuery = vi.fn(runQueryImpl);
	const runMutation = vi.fn(args?.runMutationImpl ?? (async () => null));
	const getUserIdentity = vi.fn(async () => args?.userIdentity ?? server_ai_tools_test_user_identity_default);
	const ctx = {
		runQuery,
		runMutation,
		auth: {
			getUserIdentity,
		},
	} as unknown as ActionCtx;
	return { ctx, runQuery, runMutation, getUserIdentity };
};

function isNotAsyncIterable<T>(value: T | AsyncIterable<T>): value is T {
	return !Symbol.asyncIterator || !(Symbol.asyncIterator in Object(value));
}

test("list_pages tool: inputSchema defaults", () => {
	const { ctx } = makeCtx(async () => ({ items: [], truncated: false }));
	const tool = ai_chat_tool_create_list_pages(
		ctx,
		server_ai_tools_test_ctx_data as Parameters<typeof ai_chat_tool_create_list_pages>[1],
	);

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

	const tool = ai_chat_tool_create_list_pages(
		ctx,
		server_ai_tools_test_ctx_data as Parameters<typeof ai_chat_tool_create_list_pages>[1],
	);
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
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		projectId: test_mocks_hardcoded.project_id.project_1,
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
	const tool = ai_chat_tool_create_text_search_pages(
		ctx,
		server_ai_tools_test_ctx_data as Parameters<typeof ai_chat_tool_create_text_search_pages>[1],
	);
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
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		projectId: test_mocks_hardcoded.project_id.project_1,
		query: "value",
		limit: 20,
	});

	expect(result.output).toContain("/Docs/CodeGuide (lines 41-43, chunk #2)");
	expect(result.output).toContain("... more code block content above");
	expect(result.output).toContain("... more code block content below");
	expect(result.output).toContain("/Docs/TableGuide (lines 10-12, chunk #1)");
	expect(result.output).toContain("... more table content below");
});

test("read_page tool forwards pendingEditId and returns it in metadata", async () => {
	const pendingEditId = "pending123";
	const currentContent = {
		pageId: "p123",
		content: "# Base",
		pendingEditId,
	};

	const { ctx, runQuery } = makeCtx(async () => currentContent);
	const tool = ai_chat_tool_create_read_page(
		ctx,
		server_ai_tools_test_ctx_data as Parameters<typeof ai_chat_tool_create_read_page>[1],
	);
	const result = await tool.execute?.(
		{ path: "/Docs/Plan", pendingEditId, limit: 2000 },
		{ toolCallId: "test", messages: [] },
	);

	if (!result) {
		throw new Error("`result` is undefined");
	}
	if (!isNotAsyncIterable(result)) {
		throw new Error("`result` is AsyncIterable but expected sync object");
	}

	expect(runQuery).toHaveBeenCalledTimes(1);
	const [, args] = runQuery.mock.calls[0]!;
	expect(args).toEqual({
		path: "/Docs/Plan",
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		projectId: test_mocks_hardcoded.project_id.project_1,
		pendingEditId,
	});

	if (!result.metadata) {
		throw new Error("`result.metadata` is undefined");
	}

	expect(result.metadata.pageId).toBe("p123");
	expect(result.metadata.pendingEditId).toBe(pendingEditId);
});

test("write_page tool stores pending unstaged branch updates from the agent", async () => {
	const pageId = "p123";
	const pendingEditId = "pending123";
	const currentContent = {
		pageId,
		content: "# Base",
		pendingEditId,
	};

	let runQueryCallCount = 0;
	const { ctx, runQuery, runMutation } = makeCtx(async () => {
		runQueryCallCount += 1;
		return runQueryCallCount === 1 ? currentContent : { _id: pendingEditId };
	});
	const tool = ai_chat_tool_create_write_page(
		ctx,
		server_ai_tools_test_ctx_data as Parameters<typeof ai_chat_tool_create_write_page>[1],
	);
	const result = await tool.execute?.(
		{ path: "/Docs/Plan", content: "# Updated" },
		{ toolCallId: "test", messages: [] },
	);

	if (!result) {
		throw new Error("`result` is undefined");
	}
	if (!isNotAsyncIterable(result)) {
		throw new Error("`result` is AsyncIterable but expected sync object");
	}

	expect(runQuery).toHaveBeenCalledTimes(2);
	expect(runMutation).toHaveBeenCalledTimes(1);
	const [, args] = runMutation.mock.calls[0]!;
	expect(args).toEqual({
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		projectId: test_mocks_hardcoded.project_id.project_1,
		userId: test_mocks_hardcoded.user.user_1.id,
		pageId,
		pendingEditId,
		unstagedMarkdown: "# Updated",
	});

	expect(result.metadata.pageId).toBe(pageId);
	expect(result.metadata.pendingEditId).toBe(pendingEditId);
	expect(result.metadata.exists).toBe(true);
});

test("edit_page tool stores pending unstaged branch updates from the agent", async () => {
	const pageId = "p456";
	const pendingEditId = "pending456";
	const currentContent = {
		pageId,
		content: "Hello world",
		pendingEditId,
	};

	let runQueryCallCount = 0;
	const { ctx, runQuery, runMutation } = makeCtx(async () => {
		runQueryCallCount += 1;
		return runQueryCallCount === 1 ? currentContent : { _id: pendingEditId };
	});
	const tool = ai_chat_tool_create_edit_page(
		ctx,
		server_ai_tools_test_ctx_data as Parameters<typeof ai_chat_tool_create_edit_page>[1],
	);
	const result = await tool.execute?.(
		{
			path: "/Docs/Hello",
			oldString: "world",
			newString: "team",
			replaceAll: false,
		},
		{ toolCallId: "test", messages: [] },
	);

	if (!result) {
		throw new Error("`result` is undefined");
	}
	if (!isNotAsyncIterable(result)) {
		throw new Error("`result` is AsyncIterable but expected sync object");
	}

	expect(runQuery).toHaveBeenCalledTimes(2);
	expect(runMutation).toHaveBeenCalledTimes(1);
	const [, args] = runMutation.mock.calls[0]!;
	expect(args).toEqual({
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		projectId: test_mocks_hardcoded.project_id.project_1,
		userId: test_mocks_hardcoded.user.user_1.id,
		pageId,
		pendingEditId,
		unstagedMarkdown: "Hello team",
	});

	expect(result.metadata.pageId).toBe(pageId);
	expect(result.metadata.pendingEditId).toBe(pendingEditId);
	expect(result.metadata.matches).toBe(1);
	expect(result.metadata.matcher).toBe("simple");
});

test("replace_once_or_all: line-trimmed matching preserves the following newline", () => {
	const result = replace_once_or_all("before\n  alpha  \n  beta  \nafter", "alpha\nbeta", "gamma\ndelta");

	expect(result).toEqual({
		content: "before\ngamma\ndelta\nafter",
		matches: 1,
		matcher: "line_trimmed",
	});
});

test("replace_once_or_all: trimmed-boundary matching tolerates outer blank lines", () => {
	const result = replace_once_or_all("before\nalpha\nbeta\nafter", "\nalpha\nbeta\n", "gamma");

	expect(result).toEqual({
		content: "before\ngamma\nafter",
		matches: 1,
		matcher: "trimmed_boundary",
	});
});

test("replace_once_or_all: whitespace-normalized matching handles inline spacing differences", () => {
	const result = replace_once_or_all("before\nHello    brave   world\nafter", "Hello brave world", "Hi team");

	expect(result).toEqual({
		content: "before\nHi team\nafter",
		matches: 1,
		matcher: "whitespace_normalized",
	});
});

test("replace_once_or_all: indentation differences are still replaceable", () => {
	const result = replace_once_or_all(
		"before\n\t\tconst value = 1;\n\t\treturn value;\nafter",
		"const value = 1;\n\treturn value;",
		"const nextValue = 2;\n\treturn nextValue;",
	);

	expect(result.content).toBe("before\nconst nextValue = 2;\n\treturn nextValue;\nafter");
	expect(result.matches).toBe(1);
	expect(result.matcher).toBe("line_trimmed");
});

test("replace_once_or_all: escape-normalized matching handles escaped multiline strings", () => {
	const result = replace_once_or_all('"hello\\nworld"', '"hello\nworld"', '"hi there"');

	expect(result).toEqual({
		content: '"hi there"',
		matches: 1,
		matcher: "escape_normalized",
	});
});

test("replace_once_or_all: replaceAll uses the shared fallback pipeline", () => {
	const result = replace_once_or_all(
		"start\n  alpha  \n  beta  \nmid\n  alpha  \n  beta  \nend",
		"alpha\nbeta",
		"gamma\ndelta",
		{ replaceAll: true },
	);

	expect(result).toEqual({
		content: "start\ngamma\ndelta\nmid\ngamma\ndelta\nend",
		matches: 2,
		matcher: "line_trimmed",
	});
});

test("replace_once_or_all: throws a not-found error when there is no match", () => {
	expect(() => replace_once_or_all("alpha\nbeta", "missing", "gamma")).toThrow(
		"oldString not found in content. It must match exactly, including whitespace, indentation, and line endings.",
	);
});

test("replace_once_or_all: throws an ambiguity error when the match is not unique", () => {
	expect(() => replace_once_or_all("alpha\nalpha", "alpha", "gamma")).toThrow(
		"Found multiple matches for oldString. Provide more surrounding context to make the match unique.",
	);
});

test("edit_page tool preserves the baseline trailing newline shape", async () => {
	const pageId = "p789";
	const pendingEditId = "pending789";
	const currentContent = {
		pageId,
		content: "Hello world\n",
		pendingEditId,
	};

	let runQueryCallCount = 0;
	const { ctx, runMutation } = makeCtx(async () => {
		runQueryCallCount += 1;
		return runQueryCallCount === 1 ? currentContent : { _id: pendingEditId };
	});
	const tool = ai_chat_tool_create_edit_page(
		ctx,
		server_ai_tools_test_ctx_data as Parameters<typeof ai_chat_tool_create_edit_page>[1],
	);
	const result = await tool.execute?.(
		{
			path: "/Docs/Newline",
			oldString: "world",
			newString: "team",
			replaceAll: false,
		},
		{ toolCallId: "test", messages: [] },
	);

	if (!result) {
		throw new Error("`result` is undefined");
	}
	if (!isNotAsyncIterable(result)) {
		throw new Error("`result` is AsyncIterable but expected sync object");
	}

	const [, args] = runMutation.mock.calls[0]!;
	expect(args).toEqual({
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		projectId: test_mocks_hardcoded.project_id.project_1,
		userId: test_mocks_hardcoded.user.user_1.id,
		pageId,
		pendingEditId,
		unstagedMarkdown: "Hello team\n",
	});

	expect(result.metadata.matcher).toBe("simple");
});
