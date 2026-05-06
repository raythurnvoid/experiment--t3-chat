import { test_mocks_hardcoded } from "../convex/setup.test.ts";
import { test, expect, vi } from "vitest";
import type { ActionCtx } from "../convex/_generated/server";
import type { Id } from "../convex/_generated/dataModel";

const exa_test = vi.hoisted(() => ({
	searchMock: vi.fn(),
	lastApiKey: undefined as string | undefined,
}));

vi.mock("exa-js", () => ({
	default: class MockExa {
		constructor(apiKey?: string) {
			exa_test.lastApiKey = apiKey;
		}

		search = exa_test.searchMock;
	},
	ExaError: class ExaError extends Error {
		override name = "ExaError";
	},
}));
import {
	ai_chat_tool_create_list_files,
	ai_chat_tool_create_read_file,
	ai_chat_tool_create_text_search_files,
	ai_chat_tool_create_write_file,
	ai_chat_tool_create_edit_file,
	ai_chat_tool_create_web_search,
	replace_once_or_all,
} from "./server-ai-tools.ts";
import { has_defined_property } from "../shared/shared-utils.ts";
import { files_chunk_BITMASK_FLAGS } from "./files-markdown-chunking-mastra.ts";

type server_ai_tools_test_user_identity = NonNullable<Awaited<ReturnType<ActionCtx["auth"]["getUserIdentity"]>>>;

const server_ai_tools_test_user_id = test_mocks_hardcoded.user.user_1.id as Id<"users">;

const server_ai_tools_test_ctx_data = {
	workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
	projectId: test_mocks_hardcoded.project_id.project_1,
	userId: server_ai_tools_test_user_id,
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

test("list_files tool: inputSchema defaults", () => {
	const { ctx } = makeCtx(async () => ({ items: [], truncated: false }));
	const tool = ai_chat_tool_create_list_files(
		ctx,
		server_ai_tools_test_ctx_data as Parameters<typeof ai_chat_tool_create_list_files>[1],
	);

	const parsed = has_defined_property(tool.inputSchema, "parse") ? tool.inputSchema.parse({}) : undefined;
	expect(parsed).toEqual({ path: "/", maxDepth: 5, limit: 100 });
});

test("list_files tool: execute renders files and folders, applies ignore, and calls convex with correct args", async () => {
	const now = Date.now();
	const listReturn = {
		items: [
			{ path: "/docs", kind: "folder", updatedAt: now, depthTruncated: false },
			{ path: "/docs/guides", kind: "folder", updatedAt: now, depthTruncated: true },
			{ path: "/docs/tutorial.md", kind: "file", updatedAt: now, depthTruncated: false },
			{ path: "/play.md", kind: "file", updatedAt: now, depthTruncated: false },
		],
		truncated: false,
	};

	const { ctx, runQuery } = makeCtx(async (_ref, _args) => {
		// Only list_files is called by this tool
		return listReturn;
	});

	const tool = ai_chat_tool_create_list_files(
		ctx,
		server_ai_tools_test_ctx_data as Parameters<typeof ai_chat_tool_create_list_files>[1],
	);
	const result = await tool.execute?.(
		{ path: "/", maxDepth: 10, limit: 100, ignore: ["**/play.md"] },
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

	expect(result.metadata.count).toBe(3);
	expect(result.metadata.truncated).toBe(false);

	expect(result.output).toBe(
		"" +
			"/docs/\n" + //
			"/docs/guides/ (...)\n" + //
			"/docs/tutorial.md",
	);
});

test("text_search_files tool: renders line ranges and fragment markers", async () => {
	const searchReturn = {
		items: [
			{
				path: "/docs/code-guide.md",
				markdownChunk: "```ts\nconst value = 1;\n```",
				chunkIndex: 2,
				startIndex: 900,
				endIndex: 925,
				lineStart: 41,
				lineEnd: 43,
				chunkFlags:
					files_chunk_BITMASK_FLAGS.isCode |
					files_chunk_BITMASK_FLAGS.hasMoreFragmentContentAbove |
					files_chunk_BITMASK_FLAGS.hasMoreFragmentContentBelow,
				hasChunkAbove: true,
				hasChunkBelow: true,
			},
			{
				path: "/docs/table-guide.md",
				markdownChunk: "| a | b |\n|---|---|\n| 1 | 2 |",
				chunkIndex: 1,
				startIndex: 120,
				endIndex: 151,
				lineStart: 10,
				lineEnd: 12,
				chunkFlags: files_chunk_BITMASK_FLAGS.isTable | files_chunk_BITMASK_FLAGS.hasMoreFragmentContentBelow,
				hasChunkAbove: false,
				hasChunkBelow: true,
			},
		],
	};

	const { ctx, runQuery } = makeCtx(async (_ref, _args) => searchReturn);
	const tool = ai_chat_tool_create_text_search_files(
		ctx,
		server_ai_tools_test_ctx_data as Parameters<typeof ai_chat_tool_create_text_search_files>[1],
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

	expect(result.output).toContain("/docs/code-guide.md (lines 41-43, chars 900-925, chunk #2)");
	expect(result.output).toContain("... more code block content above");
	expect(result.output).toContain("... more code block content below");
	expect(result.output).toContain("/docs/table-guide.md (lines 10-12, chars 120-151, chunk #1)");
	expect(result.output).toContain("... more table content below");
});

test("read_file tool forwards pendingUpdateId and returns it in metadata", async () => {
	const pendingUpdateId = "pending123";
	const currentContent = {
		nodeId: "p123",
		content: "# Base",
		pendingUpdateId,
	};

	const { ctx, runQuery } = makeCtx(async () => currentContent);
	const tool = ai_chat_tool_create_read_file(
		ctx,
		server_ai_tools_test_ctx_data as Parameters<typeof ai_chat_tool_create_read_file>[1],
	);
	const result = await tool.execute?.(
		{ path: "/docs/plan.md", pendingUpdateId, limit: 2000 },
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
		path: "/docs/plan.md",
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		projectId: test_mocks_hardcoded.project_id.project_1,
		userId: server_ai_tools_test_user_id,
		pendingUpdateId,
	});

	if (!result.metadata) {
		throw new Error("`result.metadata` is undefined");
	}

	expect(result.metadata.nodeId).toBe("p123");
	expect(result.metadata.pendingUpdateId).toBe(pendingUpdateId);
});

test("write_file tool stores pending unstaged branch updates from the agent", async () => {
	const nodeId = "p123";
	const pendingUpdateId = "pending123";
	const currentContent = {
		nodeId,
		content: "# Base",
		pendingUpdateId,
	};

	let runQueryCallCount = 0;
	const { ctx, runQuery, runMutation } = makeCtx(async () => {
		runQueryCallCount += 1;
		return runQueryCallCount === 1 ? currentContent : { _id: pendingUpdateId };
	});
	const tool = ai_chat_tool_create_write_file(
		ctx,
		server_ai_tools_test_ctx_data as Parameters<typeof ai_chat_tool_create_write_file>[1],
	);
	const result = await tool.execute?.(
		{ path: "/docs/plan.md", content: "# Updated" },
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
	const [, firstQueryArgs] = runQuery.mock.calls[0]!;
	expect(firstQueryArgs).toEqual({
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		projectId: test_mocks_hardcoded.project_id.project_1,
		userId: server_ai_tools_test_user_id,
		path: "/docs/plan.md",
		pendingUpdateId: undefined,
	});
	const [, mutationArgs] = runMutation.mock.calls[0]!;
	expect(mutationArgs).toEqual({
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		projectId: test_mocks_hardcoded.project_id.project_1,
		userId: server_ai_tools_test_user_id,
		nodeId,
		pendingUpdateId,
		unstagedMarkdown: "# Updated",
	});

	expect(result.metadata.nodeId).toBe(nodeId);
	expect(result.metadata.pendingUpdateId).toBe(pendingUpdateId);
	expect(result.metadata.exists).toBe(true);
});

test("write_file tool normalizes missing file paths before creating with the agent user", async () => {
	const nodeId = "p999";
	const pendingUpdateId = "pending999";

	let runQueryCallCount = 0;
	let runMutationCallCount = 0;
	const { ctx, runQuery, runMutation } = makeCtx(
		async () => {
			runQueryCallCount += 1;
			return runQueryCallCount === 1 ? null : { _id: pendingUpdateId };
		},
		{
			runMutationImpl: async () => {
				runMutationCallCount += 1;
				return runMutationCallCount === 1 ? { _yay: { nodeId } } : null;
			},
		},
	);
	const tool = ai_chat_tool_create_write_file(
		ctx,
		server_ai_tools_test_ctx_data as Parameters<typeof ai_chat_tool_create_write_file>[1],
	);
	const result = await tool.execute?.({ path: "/docs/New Plan", content: "# New" }, { toolCallId: "test", messages: [] });

	if (!result) {
		throw new Error("`result` is undefined");
	}
	if (!isNotAsyncIterable(result)) {
		throw new Error("`result` is AsyncIterable but expected sync object");
	}

	expect(runQuery).toHaveBeenCalledTimes(2);
	const [, firstQueryArgs] = runQuery.mock.calls[0]!;
	expect(firstQueryArgs).toEqual({
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		projectId: test_mocks_hardcoded.project_id.project_1,
		userId: server_ai_tools_test_user_id,
		path: "/docs/new-plan.md",
		pendingUpdateId: undefined,
	});

	expect(runMutation).toHaveBeenCalledTimes(2);
	const [, createArgs] = runMutation.mock.calls[0]!;
	expect(createArgs).toEqual({
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		projectId: test_mocks_hardcoded.project_id.project_1,
		userId: server_ai_tools_test_user_id,
		path: "/docs/new-plan.md",
	});
	const [, pendingArgs] = runMutation.mock.calls[1]!;
	expect(pendingArgs).toEqual({
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		projectId: test_mocks_hardcoded.project_id.project_1,
		userId: server_ai_tools_test_user_id,
		nodeId,
		pendingUpdateId: undefined,
		unstagedMarkdown: "# New",
	});

	expect(result.metadata.nodeId).toBe(nodeId);
	expect(result.metadata.pendingUpdateId).toBe(pendingUpdateId);
	expect(result.metadata.exists).toBe(false);
});

test("edit_file tool stores pending unstaged branch updates from the agent", async () => {
	const nodeId = "p456";
	const pendingUpdateId = "pending456";
	const currentContent = {
		nodeId,
		content: "Hello world",
		pendingUpdateId,
	};

	let runQueryCallCount = 0;
	const { ctx, runQuery, runMutation } = makeCtx(async () => {
		runQueryCallCount += 1;
		return runQueryCallCount === 1 ? currentContent : { _id: pendingUpdateId };
	});
	const tool = ai_chat_tool_create_edit_file(
		ctx,
		server_ai_tools_test_ctx_data as Parameters<typeof ai_chat_tool_create_edit_file>[1],
	);
	const result = await tool.execute?.(
		{
			path: "/docs/hello.md",
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
	const [, firstQueryArgs] = runQuery.mock.calls[0]!;
	expect(firstQueryArgs).toEqual({
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		projectId: test_mocks_hardcoded.project_id.project_1,
		userId: server_ai_tools_test_user_id,
		path: "/docs/hello.md",
		pendingUpdateId: undefined,
	});
	const [, mutationArgs] = runMutation.mock.calls[0]!;
	expect(mutationArgs).toEqual({
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		projectId: test_mocks_hardcoded.project_id.project_1,
		userId: server_ai_tools_test_user_id,
		nodeId,
		pendingUpdateId,
		unstagedMarkdown: "Hello team",
	});

	expect(result.metadata.nodeId).toBe(nodeId);
	expect(result.metadata.pendingUpdateId).toBe(pendingUpdateId);
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

test("edit_file tool preserves the baseline trailing newline shape", async () => {
	const nodeId = "p789";
	const pendingUpdateId = "pending789";
	const currentContent = {
		nodeId,
		content: "Hello world\n",
		pendingUpdateId,
	};

	let runQueryCallCount = 0;
	const { ctx, runQuery, runMutation } = makeCtx(async () => {
		runQueryCallCount += 1;
		return runQueryCallCount === 1 ? currentContent : { _id: pendingUpdateId };
	});
	const tool = ai_chat_tool_create_edit_file(
		ctx,
		server_ai_tools_test_ctx_data as Parameters<typeof ai_chat_tool_create_edit_file>[1],
	);
	const result = await tool.execute?.(
		{
			path: "/docs/newline.md",
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

	const [, firstQueryArgs] = runQuery.mock.calls[0]!;
	expect(firstQueryArgs).toEqual({
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		projectId: test_mocks_hardcoded.project_id.project_1,
		userId: server_ai_tools_test_user_id,
		path: "/docs/newline.md",
		pendingUpdateId: undefined,
	});

	const [, args] = runMutation.mock.calls[0]!;
	expect(args).toEqual({
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		projectId: test_mocks_hardcoded.project_id.project_1,
		userId: server_ai_tools_test_user_id,
		nodeId,
		pendingUpdateId,
		unstagedMarkdown: "Hello team\n",
	});

	expect(result.metadata.matcher).toBe("simple");
});

test("web_search tool: Exa SDK uses fast search, highlights, and returns compact output", async () => {
	const prevKey = process.env.EXA_API_KEY;
	process.env.EXA_API_KEY = "test-exa-key";

	exa_test.searchMock.mockResolvedValue({
		requestId: "req_test",
		results: [
			{
				title: "Example",
				url: "https://example.com/doc",
				id: "https://example.com/doc",
				highlights: ["First snippet.", "Second snippet."],
			},
		],
	});

	try {
		const tool = ai_chat_tool_create_web_search();
		const result = await tool.execute?.(
			{
				query: "convex auth",
				numResults: 7,
				includeDomains: ["exa.ai"],
				excludeDomains: ["spam.test"],
			},
			{ toolCallId: "tool-call-1", messages: [] },
		);

		if (!result) {
			throw new Error("`result` is undefined");
		}
		if (!isNotAsyncIterable(result)) {
			throw new Error("`result` is AsyncIterable but expected sync object");
		}

		expect(exa_test.lastApiKey).toBe("test-exa-key");
		expect(exa_test.searchMock).toHaveBeenCalledTimes(1);
		expect(exa_test.searchMock).toHaveBeenCalledWith("convex auth", {
			type: "fast",
			numResults: 7,
			includeDomains: ["exa.ai"],
			excludeDomains: ["spam.test"],
			contents: { highlights: { maxCharacters: 4000 } },
		});

		expect(result.title).toBe("Web search");
		expect(result.metadata).toEqual({
			query: "convex auth",
			resultCount: 1,
			requestId: "req_test",
		});
		expect(result.output).toContain("Example");
		expect(result.output).toContain("https://example.com/doc");
		expect(result.output).toContain("First snippet.");
	} finally {
		exa_test.searchMock.mockClear();
		exa_test.lastApiKey = undefined;
		if (prevKey === undefined) {
			delete process.env.EXA_API_KEY;
		} else {
			process.env.EXA_API_KEY = prevKey;
		}
	}
});
