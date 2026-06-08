import { test_mocks_hardcoded } from "../convex/setup.test.ts";
import { describe, test, expect, vi } from "vitest";
import type { ActionCtx } from "../convex/_generated/server";
import type { Id } from "../convex/_generated/dataModel";
import { files_READ_RANGE_MAX_LINES } from "../convex/files_nodes.ts";

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
	ai_chat_tool_create_bash,
	ai_chat_tool_create_glob_files,
	ai_chat_tool_create_grep_files,
	ai_chat_tool_create_list_files,
	ai_chat_tool_create_read_file,
	ai_chat_tool_create_write_file,
	ai_chat_tool_create_edit_file,
	ai_chat_tool_create_web_search,
	replace_once_or_all,
} from "./server-ai-tools.ts";
import { has_defined_property } from "../shared/shared-utils.ts";

type server_ai_tools_test_user_identity = NonNullable<Awaited<ReturnType<ActionCtx["auth"]["getUserIdentity"]>>>;

const server_ai_tools_test_user_id = test_mocks_hardcoded.user.user_1.id as Id<"users">;

const server_ai_tools_test_ctx_data = {
	workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
	projectId: test_mocks_hardcoded.project_id.project_1,
	workspaceName: "personal",
	projectName: "home",
	userId: server_ai_tools_test_user_id,
} as const;
const server_ai_tools_test_app_files_mount = "/home/cloud-usr/w/personal/home";

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
		runActionImpl?: (ref: any, args: any) => Promise<any>;
		userIdentity?: server_ai_tools_test_user_identity;
	},
): {
	ctx: ActionCtx;
	runQuery: ReturnType<typeof vi.fn>;
	runMutation: ReturnType<typeof vi.fn>;
	runAction: ReturnType<typeof vi.fn>;
	getUserIdentity: ReturnType<typeof vi.fn>;
} => {
	const runQuery = vi.fn(runQueryImpl);
	const runMutation = vi.fn(args?.runMutationImpl ?? (async () => null));
	const runAction = vi.fn(args?.runActionImpl ?? runQueryImpl);
	const getUserIdentity = vi.fn(async () => args?.userIdentity ?? server_ai_tools_test_user_identity_default);
	const ctx = {
		runQuery,
		runMutation,
		runAction,
		auth: {
			getUserIdentity,
		},
	} as unknown as ActionCtx;
	return { ctx, runQuery, runMutation, runAction, getUserIdentity };
};

function isNotAsyncIterable<T>(value: T | AsyncIterable<T>): value is T {
	return !Symbol.asyncIterator || !(Symbol.asyncIterator in Object(value));
}

describe("ai_chat_tool_create_bash", () => {
	test("forwards execution to the bash action after thread resolution", async () => {
		const { ctx, runAction } = makeCtx(async () => null, {
			runActionImpl: async () => ({
				title: `exit 0 · ${server_ai_tools_test_app_files_mount}`,
				output: "$ pwd",
				stdout: `${server_ai_tools_test_app_files_mount}\n`,
				stderr: "",
				metadata: {
					command: "pwd",
					cwd: server_ai_tools_test_app_files_mount,
					nextCwd: server_ai_tools_test_app_files_mount,
					exitCode: 0,
					stdoutTruncated: false,
					stderrTruncated: false,
					stdoutLength: server_ai_tools_test_app_files_mount.length + 1,
					stderrLength: 0,
					pathIndexTruncated: false,
				},
			}),
		});
		const tool = ai_chat_tool_create_bash(ctx, server_ai_tools_test_ctx_data, {
			getThreadId: () => "thread_1" as Id<"ai_chat_threads">,
			allowAppFileTreeMkdir: true,
		});

		const result = await tool.execute?.({ command: "pwd" }, { toolCallId: "test", messages: [] });

		if (!result) {
			throw new Error("`result` is undefined");
		}
		if (!isNotAsyncIterable(result)) {
			throw new Error("`result` is AsyncIterable but expected sync object");
		}

		expect(result.stdout).toBe(`${server_ai_tools_test_app_files_mount}\n`);
		expect(runAction).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				command: "pwd",
				threadId: "thread_1",
				userId: server_ai_tools_test_user_id,
				workspaceName: "personal",
				projectName: "home",
				allowAppFileTreeMkdir: true,
			}),
		);
	});

	test("describes supported app ls flags and pagination limits", () => {
		const { ctx } = makeCtx(async () => null);
		const tool = ai_chat_tool_create_bash(ctx, server_ai_tools_test_ctx_data, {
			getThreadId: () => "thread_1" as Id<"ai_chat_threads">,
			allowAppFileTreeMkdir: true,
		});

		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("Use ls [-1aApFdlrRt] [--limit N] [--cursor CURSOR] [PATH ...] for app listings."),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					"When reporting Bash results, treat app-only flags such as --limit, --cursor, --path-query, and --extension as supported app Bash syntax",
				),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					"Printed Next page commands may use short --cursor @... aliases; run the exact printed command to continue.",
				),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					"When a user names an app-root path like /docs, run it as /home/cloud-usr/w/personal/home/docs",
				),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					"If a failed Bash command prints a Try: command that directly matches the user's request",
				),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("ls -l uses app metadata, not POSIX permissions"),
			}),
		);
	});

	test("describes the reader read cap and find depth filters", () => {
		const { ctx } = makeCtx(async () => null);
		const tool = ai_chat_tool_create_bash(ctx, server_ai_tools_test_ctx_data, {
			getThreadId: () => "thread_1" as Id<"ai_chat_threads">,
			allowAppFileTreeMkdir: true,
		});

		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("these readers fetch at most 10 app files per command"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("wc accepts multiple files (per-file counts plus a total)"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("find -maxdepth N and find -mindepth N filter non-search subtree results by depth."),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					'Content-vs-path rule: use search for text inside files, and use find only for path/name discovery.',
				),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining('Plain requests like "search for X with limit N" mean content search'),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					'If the user says "search for the X file", "find the X file", "file named X", or "path/name contains X", use find.',
				),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					"run search --path <folder> X or search X; do not substitute find --path-query.",
				),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("Use find -name QUERY or find --path-query QUERY only for DB-backed path/name word search"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("find -name is case-insensitive like -iname"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("Use find <path> --extension md -type f for exact indexed extension search"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					'Prefer --path-query QUERY for natural "path/name contains QUERY" requests',
				),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("For regex path requests, say regex is unsupported"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					"find --prefix <prefix> --limit N [--cursor CURSOR] only for raw startsWith path discovery",
				),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("prefix mode may match sibling prefixes such as /docs-archive"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("full-text content search across Markdown/text content"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("one distinctive word or a few plain terms"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("For recursive grep or grep -R wording over a folder"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("with PATH they list that directory's immediate children by update time"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("bare ls -t is still project-wide"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("Large files are not read inline"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("find -type f and find -type d restrict results to files or folders."),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("find searches paths/names only, not file content."),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("When asked for files under a folder, include -type f"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining('For requests like "where does X appear" or "which files mention X", run search first'),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("do not substitute find, which only searches paths/names"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("when the user asks for tree-shaped output, use tree, not ls -R"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("not regex, glob, path/name search, or exact grep"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("broad folder scopes with common terms can be heavier"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("bare search scopes to that cwd"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(`up to ${files_READ_RANGE_MAX_LINES} lines per read`),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("also -c count, -l list-if-matched, -v invert, and -A/-B/-C N context"),
			}),
		);
	});
});

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

test("glob_files tool: executes traversal with include pattern and sorts newest matches first", async () => {
	const listReturn = {
		items: [
			{ path: "/docs/old-target.md", kind: "file", updatedAt: 10, depthTruncated: false },
			{ path: "/docs/new-target.md", kind: "file", updatedAt: 20, depthTruncated: false },
		],
		truncated: false,
	};

	const { ctx, runQuery } = makeCtx(async (_ref, _args) => listReturn);
	const tool = ai_chat_tool_create_glob_files(
		ctx,
		server_ai_tools_test_ctx_data as Parameters<typeof ai_chat_tool_create_glob_files>[1],
	);
	const result = await tool.execute?.(
		{ pattern: "**/*target.md", path: "/docs", limit: 20 },
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
		path: "/docs",
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		projectId: test_mocks_hardcoded.project_id.project_1,
		maxDepth: 10,
		limit: 20,
		include: "**/*target.md",
	});
	expect(result.metadata).toEqual({ count: 2, truncated: false });
	expect(result.output).toBe("/docs/new-target.md\n/docs/old-target.md");
});

test("grep_files tool: searches markdown content for listed file nodes", async () => {
	const listReturn = {
		items: [
			{ path: "/docs", kind: "folder", updatedAt: 20, depthTruncated: false },
			{ path: "/docs/readme.md", kind: "file", updatedAt: 10, depthTruncated: false },
		],
		truncated: false,
	};

	const { ctx, runQuery, runAction } = makeCtx(async (_ref, _args) => listReturn, {
		runActionImpl: async () => ({
			nodeId: "readme",
			displayNodeId: "readme",
			content: "# Title\nneedle here",
			pendingUpdateId: undefined,
		}),
	});
	const tool = ai_chat_tool_create_grep_files(
		ctx,
		server_ai_tools_test_ctx_data as Parameters<typeof ai_chat_tool_create_grep_files>[1],
	);
	const result = await tool.execute?.(
		{ pattern: "needle", path: "/docs", maxDepth: 5, limit: 50 },
		{ toolCallId: "test", messages: [] },
	);

	if (!result) {
		throw new Error("`result` is undefined");
	}
	if (!isNotAsyncIterable(result)) {
		throw new Error("`result` is AsyncIterable but expected sync object");
	}

	expect(runQuery).toHaveBeenCalledTimes(1);
	const [, queryArgs] = runQuery.mock.calls[0]!;
	expect(queryArgs).toEqual({
		path: "/docs",
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		projectId: test_mocks_hardcoded.project_id.project_1,
		maxDepth: 5,
		limit: 50,
		include: undefined,
	});
	expect(runAction).toHaveBeenCalledTimes(1);
	const [, actionArgs] = runAction.mock.calls[0]!;
	expect(actionArgs).toEqual({
		path: "/docs/readme.md",
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		projectId: test_mocks_hardcoded.project_id.project_1,
		userId: server_ai_tools_test_user_id,
	});
	expect(result.metadata).toEqual({ matches: 1, truncated: false });
	expect(result.output).toContain("/docs/readme.md:");
	expect(result.output).toContain("Line 3: needle here");
});

test("read_file tool forwards pendingUpdateId and returns it in metadata", async () => {
	const pendingUpdateId = "pending123";
	const currentContent = {
		nodeId: "p123",
		displayNodeId: "p123",
		content: "# Base",
		pendingUpdateId,
	};

	const { ctx, runQuery, runAction } = makeCtx(async () => currentContent);
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

	expect(runAction).toHaveBeenCalledTimes(1);
	const [, args] = runAction.mock.calls[0]!;
	expect(args).toEqual({
		path: "/docs/plan.md",
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		projectId: test_mocks_hardcoded.project_id.project_1,
		userId: server_ai_tools_test_user_id,
		pendingUpdateId,
	});
	expect(runQuery).not.toHaveBeenCalled();

	if (!result.metadata) {
		throw new Error("`result.metadata` is undefined");
	}

	expect(result.metadata.nodeId).toBe("p123");
	expect(result.metadata.contentNodeId).toBe("p123");
	expect(result.metadata.pendingUpdateId).toBe(pendingUpdateId);
});

test("write_file tool stores pending unstaged branch updates from the agent", async () => {
	const nodeId = "p123";
	const pendingUpdateId = "pending123";
	const currentContent = {
		nodeId,
		displayNodeId: nodeId,
		content: "# Base",
		pendingUpdateId,
	};

	let runQueryCallCount = 0;
	const { ctx, runAction } = makeCtx(async () => {
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

	expect(runAction).toHaveBeenCalledTimes(2);
	const [, firstQueryArgs] = runAction.mock.calls[0]!;
	expect(firstQueryArgs).toEqual({
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		projectId: test_mocks_hardcoded.project_id.project_1,
		userId: server_ai_tools_test_user_id,
		path: "/docs/plan.md",
		pendingUpdateId: undefined,
	});
	const [, pendingArgs] = runAction.mock.calls[1]!;
	expect(pendingArgs).toEqual({
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		projectId: test_mocks_hardcoded.project_id.project_1,
		userId: server_ai_tools_test_user_id,
		nodeId,
		pendingUpdateId,
		unstagedMarkdown: "# Updated",
	});

	expect(result.metadata.nodeId).toBe(nodeId);
	expect(result.metadata.contentNodeId).toBe(nodeId);
	expect(result.metadata.pendingUpdateId).toBe(pendingUpdateId);
	expect(result.metadata.exists).toBe(true);
});

test("write_file tool normalizes missing file paths before creating with the agent user", async () => {
	const nodeId = "p999";
	const pendingUpdateId = "pending999";

	let runActionCallCount = 0;
	const { ctx, runQuery, runMutation, runAction } = makeCtx(
		async () => ({ _id: pendingUpdateId }),
		{
			runActionImpl: async () => {
				runActionCallCount += 1;
				if (runActionCallCount === 1) {
					return null;
				}
				if (runActionCallCount === 2) {
					return { _yay: { nodeId } };
				}
				return null;
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

	expect(runAction).toHaveBeenCalledTimes(3);
	expect(runQuery).toHaveBeenCalledTimes(1);
	const [, firstQueryArgs] = runAction.mock.calls[0]!;
	expect(firstQueryArgs).toEqual({
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		projectId: test_mocks_hardcoded.project_id.project_1,
		userId: server_ai_tools_test_user_id,
		path: "/docs/new-plan.md",
		pendingUpdateId: undefined,
	});

	expect(runMutation).not.toHaveBeenCalled();
	const [, createArgs] = runAction.mock.calls[1]!;
	expect(createArgs).toEqual({
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		projectId: test_mocks_hardcoded.project_id.project_1,
		userId: server_ai_tools_test_user_id,
		path: "/docs/new-plan.md",
	});
	const [, pendingArgs] = runAction.mock.calls[2]!;
	expect(pendingArgs).toEqual({
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		projectId: test_mocks_hardcoded.project_id.project_1,
		userId: server_ai_tools_test_user_id,
		nodeId,
		pendingUpdateId: undefined,
		unstagedMarkdown: "# New",
	});

	expect(result.metadata.nodeId).toBe(nodeId);
	expect(result.metadata.contentNodeId).toBe(nodeId);
	expect(result.metadata.pendingUpdateId).toBe(pendingUpdateId);
	expect(result.metadata.exists).toBe(false);
});

test("edit_file tool stores pending unstaged branch updates from the agent", async () => {
	const nodeId = "p456";
	const pendingUpdateId = "pending456";
	const currentContent = {
		nodeId,
		displayNodeId: nodeId,
		content: "Hello world",
		pendingUpdateId,
	};

	let runQueryCallCount = 0;
	const { ctx, runAction } = makeCtx(async () => {
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

	expect(runAction).toHaveBeenCalledTimes(2);
	const [, firstQueryArgs] = runAction.mock.calls[0]!;
	expect(firstQueryArgs).toEqual({
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		projectId: test_mocks_hardcoded.project_id.project_1,
		userId: server_ai_tools_test_user_id,
		path: "/docs/hello.md",
		pendingUpdateId: undefined,
	});
	const [, pendingArgs] = runAction.mock.calls[1]!;
	expect(pendingArgs).toEqual({
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		projectId: test_mocks_hardcoded.project_id.project_1,
		userId: server_ai_tools_test_user_id,
		nodeId,
		pendingUpdateId,
		unstagedMarkdown: "Hello team",
	});

	expect(result.metadata.nodeId).toBe(nodeId);
	expect(result.metadata.contentNodeId).toBe(nodeId);
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
	const { ctx, runAction } = makeCtx(async () => {
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

	const [, firstQueryArgs] = runAction.mock.calls[0]!;
	expect(firstQueryArgs).toEqual({
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		projectId: test_mocks_hardcoded.project_id.project_1,
		userId: server_ai_tools_test_user_id,
		path: "/docs/newline.md",
		pendingUpdateId: undefined,
	});

	const [, args] = runAction.mock.calls[1]!;
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
