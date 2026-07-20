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
	ai_chat_tool_create_execute_code,
	replace_once_or_all,
} from "./server-ai-tools.ts";
import { files_ROOT_ID } from "./files.ts";
import { has_defined_property } from "../shared/shared-utils.ts";

type server_ai_tools_test_user_identity = NonNullable<Awaited<ReturnType<ActionCtx["auth"]["getUserIdentity"]>>>;

const server_ai_tools_test_user_id = test_mocks_hardcoded.user.user_1.id as Id<"users">;
const server_ai_tools_test_thread_id = "thread_1" as Id<"ai_chat_threads">;

const server_ai_tools_test_ctx_data = {
	organizationId: test_mocks_hardcoded.organization_id.organization_1 as Id<"organizations">,
	workspaceId: test_mocks_hardcoded.workspace_id.workspace_1 as Id<"organizations_workspaces">,
	organizationName: "personal",
	workspaceName: "home",
	userId: server_ai_tools_test_user_id,
	getThreadId: () => server_ai_tools_test_thread_id,
} as const;
const server_ai_tools_test_db_files_mount = "/home/cloud-usr/w/personal/home";

// Empty pending path overlay data: the tools fetch this before listing or creating.
const server_ai_tools_test_overlay_empty = { pendingUpdates: [], referencedNodes: [] };

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
				title: `exit 0 · ${server_ai_tools_test_db_files_mount}`,
				output: "$ pwd",
				stdout: `${server_ai_tools_test_db_files_mount}\n`,
				stderr: "",
				metadata: {
					command: "pwd",
					cwd: server_ai_tools_test_db_files_mount,
					nextCwd: server_ai_tools_test_db_files_mount,
					exitCode: 0,
					stdoutTruncated: false,
					stderrTruncated: false,
					stdoutLength: server_ai_tools_test_db_files_mount.length + 1,
					stderrLength: 0,
					pathIndexTruncated: false,
				},
			}),
		});
		const tool = ai_chat_tool_create_bash(ctx, server_ai_tools_test_ctx_data, {
			allowDbFilesMkdir: true,
		});

		const result = await tool.execute?.({ command: "pwd" }, { toolCallId: "test", messages: [] });

		if (!result) {
			throw new Error("`result` is undefined");
		}
		if (!isNotAsyncIterable(result)) {
			throw new Error("`result` is AsyncIterable but expected sync object");
		}

		expect(result.stdout).toBe(`${server_ai_tools_test_db_files_mount}\n`);
		expect(runAction).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				command: "pwd",
				threadId: "thread_1",
				userId: server_ai_tools_test_user_id,
				organizationName: "personal",
				workspaceName: "home",
				allowDbFilesMkdir: true,
			}),
		);
	});

	test("describes supported app ls flags and pagination limits", () => {
		const { ctx } = makeCtx(async () => null);
		const tool = ai_chat_tool_create_bash(ctx, server_ai_tools_test_ctx_data, {
			allowDbFilesMkdir: true,
		});

		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					"Use ls [-1aApFdlrRt] [--limit N] [--cursor CURSOR] [PATH ...] for app listings.",
				),
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
					"App-mount limitations apply only to paths under /home/cloud-usr/w/personal/home or /home/cloud-usr/w.",
				),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("/tmp has the safe Just Bash native-style scratch command surface"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("If a command touches only /tmp or stdin, use normal scratch commands"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("/tmp is durable scratch scoped to this chat thread"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					"/tmp persists across Bash calls in this chat and reloads from Convex if the warm backend runtime cache is gone.",
				),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					"It is not shared with new chats and is not app file storage; use app file tools for durable user-visible files.",
				),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					"Do not call /tmp ephemeral or temporary in a way that implies same-chat data loss.",
				),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					"that is expected evidence of per-chat isolation, not a global Bash failure.",
				),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					"Native-style /tmp commands use Just Bash's own argument parsing and include safe text/file utilities",
				),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("jq, base64, sha256sum"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					"/tmp native commands are Just Bash browser commands, not host GNU coreutils.",
				),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					"if a /tmp option fails but the command is useful, retry once with simpler native syntax.",
				),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					"When retrying a /tmp command option, prefer doing related scratch work in one call when convenient",
				),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("the Unix file command is intentionally unavailable"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					"If file fails or the user asks for it, do not stop after reporting that it is unavailable",
				),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					"Printed Next page commands use short cursor ids without an @ prefix; run the exact printed command to continue.",
				),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					"If the user asks for exactly one continuation, one continuation, or one next page, run only the first printed continuation",
				),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					"If the user asked for continuations from multiple commands, continue each requested command before summarizing.",
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
				description: expect.stringContaining("When using bash -c or sh -c to compare /tmp and app-mount behavior"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("For xargs path checks, print pathnames into xargs"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					"avoid strict-mode boilerplate such as set -euo pipefail because pipefail is unsupported",
				),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					"For multi-command inspection or eval checks, do not use set -e or hide stderr with 2>/dev/null",
				),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("ls -l uses app metadata, not POSIX permissions"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					"Preserve the full remaining suffix: /home/cloud-usr/w/personal/home/folder/README.md becomes /folder/README.md, never /README.md.",
				),
			}),
		);
	});

	test("describes the reader read cap and find depth filters", () => {
		const { ctx } = makeCtx(async () => null);
		const tool = ai_chat_tool_create_bash(ctx, server_ai_tools_test_ctx_data, {
			allowDbFilesMkdir: true,
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
				description: expect.stringContaining(
					"find -maxdepth N and find -mindepth N filter non-search app subtree results by depth.",
				),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					"Content-vs-path rule: use search for text inside files, and use find only for path/name discovery.",
				),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					"For recursive grep requests over an app folder, the first Bash command should be search --path <folder> <content terms>",
				),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("do not run ls first to verify that folder"),
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
				description: expect.stringContaining(
					"For search --path and meta search --path, the same app-root path rule applies: pass /home/cloud-usr/w/personal/home/folder or relative folder, never raw /folder.",
				),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					"Use find -name QUERY or find --path-query QUERY only for indexed app-file path/name word search",
				),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("find -name is case-insensitive like -iname"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					"Use find <path> --extension md -type f for exact indexed extension search",
				),
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
				description: expect.stringContaining("For regex path requests against app files, say regex is unsupported"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					"find --prefix <prefix> --limit N [--cursor CURSOR] for a folder-boundary subtree scan",
				),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("sibling-prefix paths such as /docs-archive are excluded from /docs"),
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
				description: expect.stringContaining("For recursive grep, grep -R, or rg wording over an app folder"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					"Simple grep -R PATTERN <app-folder> is recovered through indexed full-text search",
				),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("grep [-n] [-i] [-F] PATTERN <file>"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("Normal single-file grep uses regex matching"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("-F/--fixed-strings uses literal substring matching"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("textgrep [-i] [-F] [-v] [-c] [-l] PATTERN <file>"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("For rendered plain-text chunk scans"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("regex by default; -F/--fixed-strings uses literal substring matching"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("not exact recursive regex/fixed-string grep"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("Single-file textgrep has no line numbers or context flags"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("with PATH they list that directory's immediate children by update time"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("bare ls -t is still workspace-wide"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("Large files are not read inline"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("cat [-n] [--] [FILE...]"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("cat unreadable-file advisories are stderr, not file content"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("Uploaded source files do not alias to generated Markdown outputs."),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("read the exact generated output path when the user wants converted text"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("find -type f and find -type d restrict app results to files or folders."),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("find searches app paths/names only, not file content."),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("When asked for app files under a folder, include -type f"),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("Native find syntax can be used for /tmp paths."),
			}),
		);
		expect(tool).toEqual(
			expect.objectContaining({
				description: expect.stringContaining(
					'For requests like "where does X appear" or "which files mention X", run search first',
				),
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

test("write and edit tools describe preserving nested app path suffixes", () => {
	const { ctx } = makeCtx(async () => null);
	const writeTool = ai_chat_tool_create_write_file(
		ctx,
		server_ai_tools_test_ctx_data as Parameters<typeof ai_chat_tool_create_write_file>[1],
	);
	const editTool = ai_chat_tool_create_edit_file(
		ctx,
		server_ai_tools_test_ctx_data as Parameters<typeof ai_chat_tool_create_edit_file>[1],
	);
	const expectedPathGuidance =
		"Preserve the full remaining suffix after that prefix; /home/cloud-usr/w/personal/home/folder/README.md becomes /folder/README.md, never /README.md.";

	expect(writeTool).toEqual(
		expect.objectContaining({
			description: expect.stringContaining(expectedPathGuidance),
		}),
	);
	expect(editTool).toEqual(
		expect.objectContaining({
			description: expect.stringContaining(expectedPathGuidance),
		}),
	);
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

	const { ctx, runQuery } = makeCtx(async (_ref, args) => {
		// The tool fetches the pending path overlay first, then list_files
		if (!("path" in args)) return server_ai_tools_test_overlay_empty;
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

	// Verify convex calls (overlay fetch first, then the listing)
	expect(runQuery).toHaveBeenCalledTimes(2);
	const calls = runQuery.mock.calls;
	const [, args] = calls[1];
	expect(args).toEqual({
		path: "/",
		organizationId: test_mocks_hardcoded.organization_id.organization_1,
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
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

test("list_files tool: shows a pending rename at its new path and not the old one", async () => {
	const now = Date.now();
	const { ctx, runQuery } = makeCtx(async (_ref, args) => {
		if (!("path" in args)) {
			return {
				pendingUpdates: [{ fileNodeId: "node_old", pendingMove: { destParentId: "folder_docs", destName: "new.md" } }],
				referencedNodes: [
					{ _id: "node_old", path: "/docs/old.md", kind: "file" },
					{ _id: "folder_docs", path: "/docs", kind: "folder" },
				],
			};
		}
		return {
			items: [
				{ path: "/docs", kind: "folder", updatedAt: now, depthTruncated: false },
				{ path: "/docs/old.md", kind: "file", updatedAt: now, depthTruncated: false },
			],
			truncated: false,
		};
	});

	const tool = ai_chat_tool_create_list_files(
		ctx,
		server_ai_tools_test_ctx_data as Parameters<typeof ai_chat_tool_create_list_files>[1],
	);
	const result = await tool.execute?.({ path: "/", maxDepth: 5, limit: 100 }, { toolCallId: "test", messages: [] });

	if (!result) {
		throw new Error("`result` is undefined");
	}
	if (!isNotAsyncIterable(result)) {
		throw new Error("`result` is AsyncIterable but expected sync object");
	}

	// The rename is covered by projecting the committed result, so no injection lookup runs.
	expect(runQuery).toHaveBeenCalledTimes(2);
	expect(result.output).toBe("/docs/\n/docs/new.md");
});

test("list_files tool: lists a moved folder's new path from its committed source", async () => {
	const now = Date.now();
	const { ctx, runQuery } = makeCtx(async (_ref, args) => {
		if (!("path" in args)) {
			return {
				pendingUpdates: [{ fileNodeId: "node_docs", pendingMove: { destParentId: files_ROOT_ID, destName: "docs2" } }],
				referencedNodes: [{ _id: "node_docs", path: "/docs", kind: "folder" }],
			};
		}
		return {
			items: [{ path: "/docs/a.md", kind: "file", updatedAt: now, depthTruncated: false }],
			truncated: false,
		};
	});

	const tool = ai_chat_tool_create_list_files(
		ctx,
		server_ai_tools_test_ctx_data as Parameters<typeof ai_chat_tool_create_list_files>[1],
	);
	const result = await tool.execute?.({ path: "/docs2", maxDepth: 5, limit: 100 }, { toolCallId: "test", messages: [] });

	if (!result) {
		throw new Error("`result` is undefined");
	}
	if (!isNotAsyncIterable(result)) {
		throw new Error("`result` is AsyncIterable but expected sync object");
	}

	// The visible scope translates to the committed source folder before the query.
	const [, listArgs] = runQuery.mock.calls[1]!;
	expect(listArgs).toEqual(expect.objectContaining({ path: "/docs" }));
	expect(result.output).toBe("/docs2/a.md");
});

test("list_files tool: splices a moved-in folder's committed subtree", async () => {
	const now = Date.now();
	const { ctx, runQuery } = makeCtx(async (_ref, args) => {
		if ("folderPath" in args) {
			// list_subtree splice of the moved folder's committed source
			return {
				page: [
					{ path: "/archive/reports-2024", kind: "folder", updatedAt: now },
					{ path: "/archive/reports-2024/deep.md", kind: "file", updatedAt: now },
				],
				continueCursor: "",
				isDone: true,
			};
		}
		if (!("path" in args)) {
			return {
				pendingUpdates: [{ fileNodeId: "node_r2024", pendingMove: { destParentId: "folder_reports", destName: "2024" } }],
				referencedNodes: [
					{ _id: "node_r2024", path: "/archive/reports-2024", kind: "folder" },
					{ _id: "folder_reports", path: "/reports", kind: "folder" },
				],
			};
		}
		if ("maxDepth" in args) {
			return {
				items: [{ path: "/reports/summary.md", kind: "file", updatedAt: now, depthTruncated: false }],
				truncated: false,
			};
		}
		// get_by_path fetch of the injected committed folder doc
		return { _id: "node_r2024", path: "/archive/reports-2024", kind: "folder", updatedAt: now };
	});

	const tool = ai_chat_tool_create_list_files(
		ctx,
		server_ai_tools_test_ctx_data as Parameters<typeof ai_chat_tool_create_list_files>[1],
	);
	const result = await tool.execute?.({ path: "/reports", maxDepth: 5, limit: 100 }, { toolCallId: "test", messages: [] });

	if (!result) {
		throw new Error("`result` is undefined");
	}
	if (!isNotAsyncIterable(result)) {
		throw new Error("`result` is AsyncIterable but expected sync object");
	}

	// The committed subtree is fetched from the moved folder's source path, first page.
	const subtreeCall = runQuery.mock.calls.find(([, callArgs]) => "folderPath" in callArgs);
	expect(subtreeCall?.[1]).toEqual({
		organizationId: test_mocks_hardcoded.organization_id.organization_1,
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		folderPath: "/archive/reports-2024",
		numItems: 20,
		cursor: null,
	});
	expect(result.output).toBe("/reports/summary.md\n/reports/2024/\n/reports/2024/deep.md");
	expect(result.metadata.truncated).toBe(false);
});

test("glob_files tool: executes traversal with include pattern and sorts newest matches first", async () => {
	const listReturn = {
		items: [
			{ path: "/docs/old-target.md", kind: "file", updatedAt: 10, depthTruncated: false },
			{ path: "/docs/new-target.md", kind: "file", updatedAt: 20, depthTruncated: false },
		],
		truncated: false,
	};

	const { ctx, runQuery } = makeCtx(async (_ref, args) =>
		"path" in args ? listReturn : server_ai_tools_test_overlay_empty,
	);
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

	expect(runQuery).toHaveBeenCalledTimes(2);
	const [, args] = runQuery.mock.calls[1]!;
	expect(args).toEqual({
		path: "/docs",
		organizationId: test_mocks_hardcoded.organization_id.organization_1,
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		maxDepth: 10,
		limit: 20,
		include: "**/*target.md",
	});
	expect(result.metadata).toEqual({ count: 2, truncated: false });
	expect(result.output).toBe("/docs/new-target.md\n/docs/old-target.md");
});

test("glob_files tool: a pending rename matches by its new name via injection", async () => {
	const { ctx, runQuery } = makeCtx(async (_ref, args) => {
		if (!("path" in args)) {
			return {
				pendingUpdates: [
					{ fileNodeId: "node_old", pendingMove: { destParentId: "folder_docs", destName: "target-notes.md" } },
				],
				referencedNodes: [
					{ _id: "node_old", path: "/docs/old-name.md", kind: "file" },
					{ _id: "folder_docs", path: "/docs", kind: "folder" },
				],
			};
		}
		if ("include" in args) {
			// The committed traversal matched nothing for the new-name pattern
			return { items: [], truncated: false };
		}
		// get_by_path fetch of the injected committed doc
		return { _id: "node_old", path: "/docs/old-name.md", kind: "file", updatedAt: 42 };
	});

	const tool = ai_chat_tool_create_glob_files(
		ctx,
		server_ai_tools_test_ctx_data as Parameters<typeof ai_chat_tool_create_glob_files>[1],
	);
	const result = await tool.execute?.(
		{ pattern: "**/target*.md", path: "/docs", limit: 100 },
		{ toolCallId: "test", messages: [] },
	);

	if (!result) {
		throw new Error("`result` is undefined");
	}
	if (!isNotAsyncIterable(result)) {
		throw new Error("`result` is AsyncIterable but expected sync object");
	}

	expect(result.output).toBe("/docs/target-notes.md");
	// The injected doc is fetched as the committed doc, without the overlay arg.
	const getByPathCall = runQuery.mock.calls.find(([, callArgs]) => "path" in callArgs && !("include" in callArgs));
	expect(getByPathCall?.[1]).toEqual({
		organizationId: test_mocks_hardcoded.organization_id.organization_1,
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		path: "/docs/old-name.md",
	});
});

test("glob_files tool: drops a result that only matches by its old name", async () => {
	const { ctx, runQuery } = makeCtx(async (_ref, args) => {
		if (!("path" in args)) {
			return {
				pendingUpdates: [
					{ fileNodeId: "node_old", pendingMove: { destParentId: "folder_docs", destName: "target-notes.md" } },
				],
				referencedNodes: [
					{ _id: "node_old", path: "/docs/old-name.md", kind: "file" },
					{ _id: "folder_docs", path: "/docs", kind: "folder" },
				],
			};
		}
		return {
			items: [{ path: "/docs/old-name.md", kind: "file", updatedAt: 42, depthTruncated: false }],
			truncated: false,
		};
	});

	const tool = ai_chat_tool_create_glob_files(
		ctx,
		server_ai_tools_test_ctx_data as Parameters<typeof ai_chat_tool_create_glob_files>[1],
	);
	const result = await tool.execute?.(
		{ pattern: "**/old-name*.md", path: "/docs", limit: 100 },
		{ toolCallId: "test", messages: [] },
	);

	if (!result) {
		throw new Error("`result` is undefined");
	}
	if (!isNotAsyncIterable(result)) {
		throw new Error("`result` is AsyncIterable but expected sync object");
	}

	// The renamed file no longer matches by its old name, and nothing else does.
	expect(runQuery).toHaveBeenCalledTimes(2);
	expect(result.output).toBe("No files found");
	expect(result.metadata).toEqual({ count: 0, truncated: false });
});

test("glob_files tool: matches files inside a moved-in folder by their visible path", async () => {
	const { ctx } = makeCtx(async (_ref, args) => {
		if ("folderPath" in args) {
			// list_subtree splice of the moved folder's committed source
			return {
				page: [
					{ path: "/archive/reports-2024", kind: "folder", updatedAt: 5 },
					{ path: "/archive/reports-2024/deep.md", kind: "file", updatedAt: 6 },
				],
				continueCursor: "",
				isDone: true,
			};
		}
		if (!("path" in args)) {
			return {
				pendingUpdates: [{ fileNodeId: "node_r2024", pendingMove: { destParentId: "folder_reports", destName: "2024" } }],
				referencedNodes: [
					{ _id: "node_r2024", path: "/archive/reports-2024", kind: "folder" },
					{ _id: "folder_reports", path: "/reports", kind: "folder" },
				],
			};
		}
		if ("include" in args) {
			// The committed traversal of the scope has no matching files of its own
			return { items: [], truncated: false };
		}
		// get_by_path fetch of the injected committed folder doc
		return { _id: "node_r2024", path: "/archive/reports-2024", kind: "folder", updatedAt: 5 };
	});

	const tool = ai_chat_tool_create_glob_files(
		ctx,
		server_ai_tools_test_ctx_data as Parameters<typeof ai_chat_tool_create_glob_files>[1],
	);
	const result = await tool.execute?.(
		{ pattern: "**/*.md", path: "/reports", limit: 100 },
		{ toolCallId: "test", messages: [] },
	);

	if (!result) {
		throw new Error("`result` is undefined");
	}
	if (!isNotAsyncIterable(result)) {
		throw new Error("`result` is AsyncIterable but expected sync object");
	}

	// The folder itself does not match *.md, but its spliced descendant does.
	expect(result.output).toBe("/reports/2024/deep.md");
	expect(result.metadata).toEqual({ count: 1, truncated: false });
});

test("grep_files tool: searches markdown content for listed files", async () => {
	const listReturn = {
		items: [
			{ path: "/docs", kind: "folder", updatedAt: 20, depthTruncated: false },
			{ path: "/docs/readme.md", kind: "file", updatedAt: 10, depthTruncated: false },
		],
		truncated: false,
	};

	const { ctx, runQuery, runAction } = makeCtx(
		async (_ref, args) => ("path" in args ? listReturn : server_ai_tools_test_overlay_empty),
		{
			runActionImpl: async () => ({
				nodeId: "readme",
				displayNodeId: "readme",
				content: "# Title\nneedle here",
				pendingUpdateId: undefined,
			}),
		},
	);
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

	expect(runQuery).toHaveBeenCalledTimes(2);
	const [, queryArgs] = runQuery.mock.calls[1]!;
	expect(queryArgs).toEqual({
		path: "/docs",
		organizationId: test_mocks_hardcoded.organization_id.organization_1,
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		maxDepth: 5,
		limit: 50,
		include: undefined,
	});
	expect(runAction).toHaveBeenCalledTimes(1);
	const [, actionArgs] = runAction.mock.calls[0]!;
	expect(actionArgs).toEqual({
		path: "/docs/readme.md",
		organizationId: test_mocks_hardcoded.organization_id.organization_1,
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		userId: server_ai_tools_test_user_id,
		overlayUserId: server_ai_tools_test_user_id,
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
		organizationId: test_mocks_hardcoded.organization_id.organization_1,
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		userId: server_ai_tools_test_user_id,
		pendingUpdateId,
		overlayUserId: server_ai_tools_test_user_id,
	});
	expect(runQuery).not.toHaveBeenCalled();

	if (!result.metadata) {
		throw new Error("`result.metadata` is undefined");
	}

	expect(result.metadata.nodeId).toBe("p123");
	expect(result.metadata.contentNodeId).toBe("p123");
	expect(result.metadata.pendingUpdateId).toBe(pendingUpdateId);
});

test("read_file suggestions show visible paths through pending moves", async () => {
	const { ctx, runQuery } = makeCtx(
		async (_ref, args) => {
			if ("parentId" in args) {
				return {
					items: [
						{ name: "old-thing.md", kind: "file", path: "/docs/old-thing.md", updatedAt: 0, updatedBy: "user_1" },
						{ name: "best-setup.md", kind: "file", path: "/docs/best-setup.md", updatedAt: 0, updatedBy: "user_1" },
					],
					continueCursor: "",
					isDone: true,
				};
			}
			if ("path" in args) {
				return { _id: "folder_docs", kind: "folder", path: "/docs" };
			}
			return {
				// One sibling is renamed to a matching name; another matching sibling is hidden
				// because a pending replace-copy archives it on accept.
				pendingUpdates: [
					{ fileNodeId: "node_old_thing", pendingMove: { destParentId: "folder_docs", destName: "new-setup.md" } },
					{ fileNodeId: "node_copy_dest", copiedFrom: { nodeId: "node_best", archivesSourceOnAccept: true } },
				],
				referencedNodes: [
					{ _id: "node_old_thing", path: "/docs/old-thing.md", kind: "file" },
					{ _id: "folder_docs", path: "/docs", kind: "folder" },
					{ _id: "node_best", path: "/docs/best-setup.md", kind: "file" },
				],
			};
		},
		{ runActionImpl: async () => null },
	);

	const tool = ai_chat_tool_create_read_file(
		ctx,
		server_ai_tools_test_ctx_data as Parameters<typeof ai_chat_tool_create_read_file>[1],
	);
	const result = await tool.execute?.({ path: "/docs/setup.md", limit: 2000 }, { toolCallId: "test", messages: [] });

	if (!result) {
		throw new Error("`result` is undefined");
	}
	if (!isNotAsyncIterable(result)) {
		throw new Error("`result` is AsyncIterable but expected sync object");
	}

	expect(result.output).toBe("File not found. Did you mean one of these?\n/docs/new-setup.md");
	// The parent lookup resolves through the overlay too.
	const parentCall = runQuery.mock.calls.find(([, callArgs]) => "path" in callArgs);
	expect(parentCall?.[1]).toEqual({
		organizationId: test_mocks_hardcoded.organization_id.organization_1,
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		path: "/docs",
		overlayUserId: server_ai_tools_test_user_id,
	});
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
		organizationId: test_mocks_hardcoded.organization_id.organization_1,
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		userId: server_ai_tools_test_user_id,
		path: "/docs/plan.md",
		pendingUpdateId: undefined,
		overlayUserId: server_ai_tools_test_user_id,
	});
	const [, pendingArgs] = runAction.mock.calls[1]!;
	expect(pendingArgs).toEqual({
		organizationId: test_mocks_hardcoded.organization_id.organization_1,
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		userId: server_ai_tools_test_user_id,
		nodeId,
		pendingUpdateId,
		unstagedMarkdown: "# Updated",
		eagerCreatedCommittedSequence: undefined,
		threadId: server_ai_tools_test_thread_id,
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
		async (_ref, args) =>
			"nodeId" in args ? { _id: pendingUpdateId } : "path" in args ? null : server_ai_tools_test_overlay_empty,
		{
			runActionImpl: async () => {
				runActionCallCount += 1;
				if (runActionCallCount === 1) {
					return null;
				}
				if (runActionCallCount === 2) {
					return { _yay: { nodeId, created: true, createdCommittedSequence: 7, createdAncestorIds: [] } };
				}
				return { _yay: null };
			},
		},
	);
	const tool = ai_chat_tool_create_write_file(
		ctx,
		server_ai_tools_test_ctx_data as Parameters<typeof ai_chat_tool_create_write_file>[1],
	);
	const result = await tool.execute?.(
		{ path: "/docs/New Plan", content: "# New" },
		{ toolCallId: "test", messages: [] },
	);

	if (!result) {
		throw new Error("`result` is undefined");
	}
	if (!isNotAsyncIterable(result)) {
		throw new Error("`result` is AsyncIterable but expected sync object");
	}

	expect(runAction).toHaveBeenCalledTimes(3);
	// Overlay fetch, the visible-ancestor walk under /docs, and the pending update doc read.
	expect(runQuery).toHaveBeenCalledTimes(3);
	const [, firstQueryArgs] = runAction.mock.calls[0]!;
	expect(firstQueryArgs).toEqual({
		organizationId: test_mocks_hardcoded.organization_id.organization_1,
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		userId: server_ai_tools_test_user_id,
		path: "/docs/new-plan.md",
		pendingUpdateId: undefined,
		overlayUserId: server_ai_tools_test_user_id,
	});

	expect(runMutation).not.toHaveBeenCalled();
	const [, createArgs] = runAction.mock.calls[1]!;
	expect(createArgs).toEqual({
		organizationId: test_mocks_hardcoded.organization_id.organization_1,
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		userId: server_ai_tools_test_user_id,
		path: "/docs/new-plan.md",
	});
	const [, pendingArgs] = runAction.mock.calls[2]!;
	expect(pendingArgs).toEqual({
		organizationId: test_mocks_hardcoded.organization_id.organization_1,
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		userId: server_ai_tools_test_user_id,
		nodeId,
		pendingUpdateId: undefined,
		unstagedMarkdown: "# New",
		eagerCreatedCommittedSequence: 7,
		eagerCreatedAncestorIds: [],
		threadId: server_ai_tools_test_thread_id,
	});

	expect(result.metadata.nodeId).toBe(nodeId);
	expect(result.metadata.contentNodeId).toBe(nodeId);
	expect(result.metadata.pendingUpdateId).toBe(pendingUpdateId);
	expect(result.metadata.exists).toBe(false);
});

test("write_file tool passes created folder ids to the pending upsert after the eager create", async () => {
	const nodeId = "p_deep";
	const pendingUpdateId = "pending_deep";
	const createdAncestorIds = ["folder_deep", "folder_shallow"];

	let runActionCallCount = 0;
	const { ctx, runAction } = makeCtx(
		async (_ref, args) =>
			"nodeId" in args ? { _id: pendingUpdateId } : "path" in args ? null : server_ai_tools_test_overlay_empty,
		{
			runActionImpl: async () => {
				runActionCallCount += 1;
				if (runActionCallCount === 1) {
					return null;
				}
				if (runActionCallCount === 2) {
					return { _yay: { nodeId, created: true, createdCommittedSequence: 7, createdAncestorIds } };
				}
				return { _yay: null };
			},
		},
	);
	const tool = ai_chat_tool_create_write_file(
		ctx,
		server_ai_tools_test_ctx_data as Parameters<typeof ai_chat_tool_create_write_file>[1],
	);
	const result = await tool.execute?.(
		{ path: "/docs/deep/new.md", content: "# New" },
		{ toolCallId: "test", messages: [] },
	);

	if (!result) {
		throw new Error("`result` is undefined");
	}
	if (!isNotAsyncIterable(result)) {
		throw new Error("`result` is AsyncIterable but expected sync object");
	}

	// Discard and TTL expiry can only remove the created folders if the upsert stores their ids.
	const [, pendingArgs] = runAction.mock.calls[2]!;
	expect(pendingArgs).toEqual({
		organizationId: test_mocks_hardcoded.organization_id.organization_1,
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		userId: server_ai_tools_test_user_id,
		nodeId,
		pendingUpdateId: undefined,
		unstagedMarkdown: "# New",
		eagerCreatedCommittedSequence: 7,
		eagerCreatedAncestorIds: createdAncestorIds,
		threadId: server_ai_tools_test_thread_id,
	});
	expect(result.metadata.exists).toBe(false);
});

test("write_file tool refuses the eager create at a path vacated by a pending move", async () => {
	const { ctx, runQuery, runAction } = makeCtx(
		async () => ({
			pendingUpdates: [{ fileNodeId: "node_a", pendingMove: { destParentId: files_ROOT_ID, destName: "b.md" } }],
			referencedNodes: [{ _id: "node_a", path: "/a.md", kind: "file" }],
		}),
		{ runActionImpl: async () => null },
	);

	const tool = ai_chat_tool_create_write_file(
		ctx,
		server_ai_tools_test_ctx_data as Parameters<typeof ai_chat_tool_create_write_file>[1],
	);
	await expect(tool.execute?.({ path: "/a.md", content: "# New" }, { toolCallId: "test", messages: [] })).rejects.toThrow(
		"a pending move or replace vacated this path",
	);

	// Only the content read ran: no committed node is created and no pending update is stored.
	expect(runAction).toHaveBeenCalledTimes(1);
	expect(runQuery).toHaveBeenCalledTimes(1);
});

test("write_file tool refuses the eager create under a pending file-move claim", async () => {
	// `mv /x.md /foo.md` pending: /foo.md reads as a FILE while nothing sits there committed.
	const { ctx, runAction } = makeCtx(
		async (_ref, args) =>
			"path" in args
				? args.path === "/foo.md"
					? { _id: "node_x", path: "/foo.md", kind: "file" }
					: null
				: {
						pendingUpdates: [{ fileNodeId: "node_x", pendingMove: { destParentId: files_ROOT_ID, destName: "foo.md" } }],
						referencedNodes: [{ _id: "node_x", path: "/x.md", kind: "file" }],
					},
		{ runActionImpl: async () => null },
	);

	const tool = ai_chat_tool_create_write_file(
		ctx,
		server_ai_tools_test_ctx_data as Parameters<typeof ai_chat_tool_create_write_file>[1],
	);
	await expect(
		tool.execute?.({ path: "/foo.md/sub/y.md", content: "# New" }, { toolCallId: "test", messages: [] }),
	).rejects.toThrow("is a file, not a folder");

	// Only the content read ran: no committed folders are created under the file claim.
	expect(runAction).toHaveBeenCalledTimes(1);
});

test("write_file tool creates inside a moved folder at the committed source path", async () => {
	const nodeId = "node_new";
	const pendingUpdateId = "pending_new";
	let runActionCallCount = 0;
	const { ctx, runAction } = makeCtx(
		async (_ref, args) =>
			"nodeId" in args
				? { _id: pendingUpdateId }
				: {
						pendingUpdates: [{ fileNodeId: "node_docs", pendingMove: { destParentId: files_ROOT_ID, destName: "docs2" } }],
						referencedNodes: [{ _id: "node_docs", path: "/docs", kind: "folder" }],
					},
		{
			runActionImpl: async () => {
				runActionCallCount += 1;
				if (runActionCallCount === 1) {
					return null;
				}
				if (runActionCallCount === 2) {
					return { _yay: { nodeId, created: true } };
				}
				return { _yay: null };
			},
		},
	);

	const tool = ai_chat_tool_create_write_file(
		ctx,
		server_ai_tools_test_ctx_data as Parameters<typeof ai_chat_tool_create_write_file>[1],
	);
	const result = await tool.execute?.(
		{ path: "/docs2/new.md", content: "# New" },
		{ toolCallId: "test", messages: [] },
	);

	if (!result) {
		throw new Error("`result` is undefined");
	}
	if (!isNotAsyncIterable(result)) {
		throw new Error("`result` is AsyncIterable but expected sync object");
	}

	// The claimed visible path translates to the committed source before the eager create,
	// so the new node lands inside the moved folder instead of duplicating the visible path.
	const [, createArgs] = runAction.mock.calls[1]!;
	expect(createArgs).toEqual({
		organizationId: test_mocks_hardcoded.organization_id.organization_1,
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		userId: server_ai_tools_test_user_id,
		path: "/docs/new.md",
	});
	expect(result.metadata.path).toBe("/docs2/new.md");
	expect(result.metadata.exists).toBe(false);
});

test("write_file tool reports an overwrite when the eager create races with another writer", async () => {
	const nodeId = "p_raced";
	const pendingUpdateId = "pending_raced";
	const racedContent = {
		nodeId,
		displayNodeId: nodeId,
		content: "# Raced base\n",
		pendingUpdateId,
	};

	let runActionCallCount = 0;
	const { ctx, runAction, runMutation } = makeCtx(
		async (_ref, args) =>
			"nodeId" in args ? { _id: pendingUpdateId } : "path" in args ? null : server_ai_tools_test_overlay_empty,
		{
			runActionImpl: async () => {
				runActionCallCount += 1;
				if (runActionCallCount === 1) {
					// The visible path is still free at the first read.
					return null;
				}
				if (runActionCallCount === 2) {
					// Another writer created the node between the read and the create.
					return { _yay: { nodeId, created: false } };
				}
				if (runActionCallCount === 3) {
					// The re-read now sees the raced node's real content.
					return racedContent;
				}
				return { _yay: null };
			},
		},
	);
	const tool = ai_chat_tool_create_write_file(
		ctx,
		server_ai_tools_test_ctx_data as Parameters<typeof ai_chat_tool_create_write_file>[1],
	);
	const result = await tool.execute?.(
		{ path: "/docs/raced.md", content: "# Updated" },
		{ toolCallId: "test", messages: [] },
	);

	if (!result) {
		throw new Error("`result` is undefined");
	}
	if (!isNotAsyncIterable(result)) {
		throw new Error("`result` is AsyncIterable but expected sync object");
	}

	// Read, create, re-read, upsert.
	expect(runAction).toHaveBeenCalledTimes(4);
	const [, rereadArgs] = runAction.mock.calls[2]!;
	expect(rereadArgs).toEqual({
		organizationId: test_mocks_hardcoded.organization_id.organization_1,
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		userId: server_ai_tools_test_user_id,
		path: "/docs/raced.md",
		pendingUpdateId: undefined,
		overlayUserId: server_ai_tools_test_user_id,
	});
	// The raced node was not created by this tool, so no eager stamp reaches the upsert.
	const [, pendingArgs] = runAction.mock.calls[3]!;
	expect(pendingArgs).toEqual({
		organizationId: test_mocks_hardcoded.organization_id.organization_1,
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		userId: server_ai_tools_test_user_id,
		nodeId,
		pendingUpdateId,
		unstagedMarkdown: "# Updated\n",
		eagerCreatedCommittedSequence: undefined,
		threadId: server_ai_tools_test_thread_id,
	});
	// No created folder ids either: this tool created nothing on the raced path.
	expect(pendingArgs.eagerCreatedAncestorIds).toBeUndefined();
	expect(runMutation).not.toHaveBeenCalled();

	expect(result.output).toBe("File overwritten");
	expect(result.metadata.exists).toBe(true);
	expect(result.metadata.diff).toContain("-# Raced base");
	expect(result.metadata.diff).toContain("+# Updated");
	expect(result.metadata.modifiedContent).toBe("# Updated\n");
	expect(result.metadata.nodeId).toBe(nodeId);
	expect(result.metadata.pendingUpdateId).toBe(pendingUpdateId);
});

test("write_file tool throws when the raced node vanishes before the re-read", async () => {
	const nodeId = "p_raced";

	let runActionCallCount = 0;
	const { ctx, runAction, runMutation } = makeCtx(
		async (_ref, args) => ("path" in args ? null : server_ai_tools_test_overlay_empty),
		{
			runActionImpl: async () => {
				runActionCallCount += 1;
				if (runActionCallCount === 1) {
					// The visible path is still free at the first read.
					return null;
				}
				if (runActionCallCount === 2) {
					// Another writer created the node between the read and the create.
					return { _yay: { nodeId, created: false } };
				}
				if (runActionCallCount === 3) {
					// The raced node was moved or archived before the re-read.
					return null;
				}
				return { _yay: null };
			},
		},
	);
	const tool = ai_chat_tool_create_write_file(
		ctx,
		server_ai_tools_test_ctx_data as Parameters<typeof ai_chat_tool_create_write_file>[1],
	);
	await expect(
		tool.execute?.({ path: "/docs/raced.md", content: "# Updated" }, { toolCallId: "test", messages: [] }),
	).rejects.toThrow(
		"Cannot write to /docs/raced.md: the file changed while this write was running. Re-check the path and try again.",
	);

	// The tool stops at the failed re-read: read, create, re-read. No upsert runs.
	expect(runAction).toHaveBeenCalledTimes(3);
	// This tool created nothing on the raced path, so no compensation runs either.
	expect(runMutation).not.toHaveBeenCalled();
});

test("write_file tool surfaces the upsert rejection when the file is archived after the read", async () => {
	const nodeId = "p123";
	const currentContent = {
		nodeId,
		displayNodeId: nodeId,
		content: "# Base",
		pendingUpdateId: "pending123",
	};

	let runActionCallCount = 0;
	const { ctx, runQuery, runAction } = makeCtx(async () => null, {
		runActionImpl: async () => {
			runActionCallCount += 1;
			if (runActionCallCount === 1) {
				return currentContent;
			}
			// The node was archived (or deleted) between the read and the upsert.
			return { _nay: { message: "Not found" } };
		},
	});
	const tool = ai_chat_tool_create_write_file(
		ctx,
		server_ai_tools_test_ctx_data as Parameters<typeof ai_chat_tool_create_write_file>[1],
	);
	await expect(
		tool.execute?.({ path: "/docs/plan.md", content: "# Updated" }, { toolCallId: "test", messages: [] }),
	).rejects.toThrow("the proposal was not recorded");

	// The tool stops at the failed upsert: no success payload, no follow-up pending update doc read.
	expect(runAction).toHaveBeenCalledTimes(2);
	expect(runQuery).not.toHaveBeenCalled();
});

test("write_file tool removes the eager node when the pending upsert throws after the eager create", async () => {
	const nodeId = "p_orphan";

	let runActionCallCount = 0;
	const { ctx, runAction, runMutation } = makeCtx(
		async (_ref, args) => ("path" in args ? null : server_ai_tools_test_overlay_empty),
		{
			// The compensation mutation removes the untouched eager node and its created folders.
			runMutationImpl: async () => ({ _yay: { removed: true, ancestorsLeft: 0 } }),
			runActionImpl: async () => {
				runActionCallCount += 1;
				if (runActionCallCount === 1) {
					return null;
				}
				if (runActionCallCount === 2) {
					return { _yay: { nodeId, created: true, createdCommittedSequence: 7, createdAncestorIds: [] } };
				}
				// The pending upsert action reads R2 and can fail transiently after the create.
				throw new Error("simulated transient upsert failure");
			},
		},
	);
	const tool = ai_chat_tool_create_write_file(
		ctx,
		server_ai_tools_test_ctx_data as Parameters<typeof ai_chat_tool_create_write_file>[1],
	);
	await expect(
		tool.execute?.({ path: "/docs/orphan.md", content: "# New" }, { toolCallId: "test", messages: [] }),
	).rejects.toThrow("Cannot write to /docs/orphan.md: the proposal was not recorded. Nothing was created at /docs/orphan.md.");

	// The tool stops at the failed upsert: content read, eager create, failed upsert.
	expect(runAction).toHaveBeenCalledTimes(3);
	// The cleanup targeted the eager node with its creation-time stamp and created folders.
	expect(runMutation).toHaveBeenCalledTimes(1);
	expect(runMutation).toHaveBeenCalledWith(expect.anything(), {
		organizationId: server_ai_tools_test_ctx_data.organizationId,
		workspaceId: server_ai_tools_test_ctx_data.workspaceId,
		userId: server_ai_tools_test_ctx_data.userId,
		nodeId,
		eagerCreatedCommittedSequence: 7,
		createdAncestorIds: [],
	});
});

test("write_file tool removes the eager node when the pending upsert rejects after the eager create", async () => {
	const nodeId = "p_orphan";

	let runActionCallCount = 0;
	const { ctx, runAction, runMutation } = makeCtx(
		async (_ref, args) => ("path" in args ? null : server_ai_tools_test_overlay_empty),
		{
			// The compensation mutation removes the untouched eager node and its created folders.
			runMutationImpl: async () => ({ _yay: { removed: true, ancestorsLeft: 0 } }),
			runActionImpl: async () => {
				runActionCallCount += 1;
				if (runActionCallCount === 1) {
					return null;
				}
				if (runActionCallCount === 2) {
					return { _yay: { nodeId, created: true, createdCommittedSequence: 7, createdAncestorIds: [] } };
				}
				return { _nay: { message: "Not found" } };
			},
		},
	);
	const tool = ai_chat_tool_create_write_file(
		ctx,
		server_ai_tools_test_ctx_data as Parameters<typeof ai_chat_tool_create_write_file>[1],
	);
	await expect(
		tool.execute?.({ path: "/docs/orphan.md", content: "# New" }, { toolCallId: "test", messages: [] }),
	).rejects.toThrow(
		"Cannot write to /docs/orphan.md: the file is gone or archived, so the proposal was not recorded. Re-check the path and try again. Nothing was created at /docs/orphan.md.",
	);

	// The tool stops at the failed upsert: content read, eager create, rejected upsert.
	expect(runAction).toHaveBeenCalledTimes(3);
	expect(runMutation).toHaveBeenCalledTimes(1);
});

test("write_file tool keeps the leftover note when the eager node cleanup is blocked", async () => {
	const nodeId = "p_orphan";

	let runActionCallCount = 0;
	const { ctx, runAction, runMutation } = makeCtx(
		async (_ref, args) => ("path" in args ? null : server_ai_tools_test_overlay_empty),
		{
			// The cleanup gate refused the hard delete (e.g. another user's pending update doc).
			runMutationImpl: async () => ({ _yay: { removed: false, ancestorsLeft: 0 } }),
			runActionImpl: async () => {
				runActionCallCount += 1;
				if (runActionCallCount === 1) {
					return null;
				}
				if (runActionCallCount === 2) {
					return { _yay: { nodeId, created: true, createdCommittedSequence: 7, createdAncestorIds: [] } };
				}
				throw new Error("simulated transient upsert failure");
			},
		},
	);
	const tool = ai_chat_tool_create_write_file(
		ctx,
		server_ai_tools_test_ctx_data as Parameters<typeof ai_chat_tool_create_write_file>[1],
	);
	await expect(
		tool.execute?.({ path: "/docs/orphan.md", content: "# New" }, { toolCallId: "test", messages: [] }),
	).rejects.toThrow("An empty file was left behind at /docs/orphan.md");

	// The tool stops at the failed upsert: content read, eager create, failed upsert.
	expect(runAction).toHaveBeenCalledTimes(3);
	// The cleanup was attempted but blocked, so the note must survive.
	expect(runMutation).toHaveBeenCalledTimes(1);
});

test("write_file tool notes leftover folders when the eager cleanup leaves created ancestors", async () => {
	const nodeId = "p_orphan";
	const createdAncestorIds = ["folder_deep", "folder_shallow"];

	let runActionCallCount = 0;
	const { ctx, runAction, runMutation } = makeCtx(
		async (_ref, args) => ("path" in args ? null : server_ai_tools_test_overlay_empty),
		{
			// The eager node was removed but its created parent folders were not.
			runMutationImpl: async () => ({ _yay: { removed: true, ancestorsLeft: 2 } }),
			runActionImpl: async () => {
				runActionCallCount += 1;
				if (runActionCallCount === 1) {
					return null;
				}
				if (runActionCallCount === 2) {
					return { _yay: { nodeId, created: true, createdCommittedSequence: 7, createdAncestorIds } };
				}
				throw new Error("simulated transient upsert failure");
			},
		},
	);
	const tool = ai_chat_tool_create_write_file(
		ctx,
		server_ai_tools_test_ctx_data as Parameters<typeof ai_chat_tool_create_write_file>[1],
	);
	await expect(
		tool.execute?.({ path: "/docs/deep/orphan.md", content: "# New" }, { toolCallId: "test", messages: [] }),
	).rejects.toThrow(
		"Empty folders created for /docs/deep/orphan.md were left behind; remove them in Files if they are not wanted.",
	);

	// The tool stops at the failed upsert: content read, eager create, failed upsert.
	expect(runAction).toHaveBeenCalledTimes(3);
	// The cleanup received the created folder ids so it can remove them too.
	expect(runMutation).toHaveBeenCalledTimes(1);
	expect(runMutation).toHaveBeenCalledWith(expect.anything(), {
		organizationId: server_ai_tools_test_ctx_data.organizationId,
		workspaceId: server_ai_tools_test_ctx_data.workspaceId,
		userId: server_ai_tools_test_ctx_data.userId,
		nodeId,
		eagerCreatedCommittedSequence: 7,
		createdAncestorIds,
	});
});

test("edit_file tool surfaces the upsert rejection when the file is archived after the read", async () => {
	const nodeId = "p456";
	const currentContent = {
		nodeId,
		displayNodeId: nodeId,
		content: "Hello world",
		pendingUpdateId: "pending456",
	};

	let runActionCallCount = 0;
	const { ctx, runQuery, runAction } = makeCtx(async () => null, {
		runActionImpl: async () => {
			runActionCallCount += 1;
			if (runActionCallCount === 1) {
				return currentContent;
			}
			// The node was archived (or deleted) between the read and the upsert.
			return { _nay: { message: "Not found" } };
		},
	});
	const tool = ai_chat_tool_create_edit_file(
		ctx,
		server_ai_tools_test_ctx_data as Parameters<typeof ai_chat_tool_create_edit_file>[1],
	);
	await expect(
		tool.execute?.(
			{ path: "/docs/hello.md", oldString: "world", newString: "team", replaceAll: false },
			{ toolCallId: "test", messages: [] },
		),
	).rejects.toThrow("the proposal was not recorded");

	// The tool stops at the failed upsert: no success payload, no follow-up pending update doc read.
	expect(runAction).toHaveBeenCalledTimes(2);
	expect(runQuery).not.toHaveBeenCalled();
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
		organizationId: test_mocks_hardcoded.organization_id.organization_1,
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		userId: server_ai_tools_test_user_id,
		path: "/docs/hello.md",
		pendingUpdateId: undefined,
		overlayUserId: server_ai_tools_test_user_id,
	});
	const [, pendingArgs] = runAction.mock.calls[1]!;
	expect(pendingArgs).toEqual({
		organizationId: test_mocks_hardcoded.organization_id.organization_1,
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		userId: server_ai_tools_test_user_id,
		nodeId,
		pendingUpdateId,
		unstagedMarkdown: "Hello team",
		threadId: server_ai_tools_test_thread_id,
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
		organizationId: test_mocks_hardcoded.organization_id.organization_1,
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		userId: server_ai_tools_test_user_id,
		path: "/docs/newline.md",
		pendingUpdateId: undefined,
		overlayUserId: server_ai_tools_test_user_id,
	});

	const [, args] = runAction.mock.calls[1]!;
	expect(args).toEqual({
		organizationId: test_mocks_hardcoded.organization_id.organization_1,
		workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
		userId: server_ai_tools_test_user_id,
		nodeId,
		pendingUpdateId,
		unstagedMarkdown: "Hello team\n",
		threadId: server_ai_tools_test_thread_id,
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

type execute_code_test_runner_response = {
	ok: boolean;
	status: number;
	json: () => Promise<unknown>;
};

function execute_code_test_make_response(status: number, body: unknown): execute_code_test_runner_response {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
	};
}

async function execute_code_test_with_runner(
	args: {
		url?: string;
		secret?: string;
		appOrigin?: string;
		fetchImpl?: (...fetchArgs: unknown[]) => Promise<execute_code_test_runner_response>;
	},
	run: (fetchMock: ReturnType<typeof vi.fn>) => Promise<void>,
) {
	const prevUrl = process.env.CODE_EXECUTION_RUNNER_URL;
	const prevSecret = process.env.CODE_EXECUTION_RUNNER_SECRET;
	const prevConvexHttpUrl = process.env.VITE_CONVEX_HTTP_URL;

	if (args.url === undefined) {
		delete process.env.CODE_EXECUTION_RUNNER_URL;
	} else {
		process.env.CODE_EXECUTION_RUNNER_URL = args.url;
	}
	if (args.secret === undefined) {
		delete process.env.CODE_EXECUTION_RUNNER_SECRET;
	} else {
		process.env.CODE_EXECUTION_RUNNER_SECRET = args.secret;
	}
	process.env.VITE_CONVEX_HTTP_URL = args.appOrigin ?? "https://app.test";

	const fetchMock = vi.fn(args.fetchImpl ?? (async () => execute_code_test_make_response(200, {})));
	vi.stubGlobal("fetch", fetchMock);

	try {
		await run(fetchMock);
	} finally {
		vi.unstubAllGlobals();
		if (prevUrl === undefined) {
			delete process.env.CODE_EXECUTION_RUNNER_URL;
		} else {
			process.env.CODE_EXECUTION_RUNNER_URL = prevUrl;
		}
		if (prevSecret === undefined) {
			delete process.env.CODE_EXECUTION_RUNNER_SECRET;
		} else {
			process.env.CODE_EXECUTION_RUNNER_SECRET = prevSecret;
		}
		if (prevConvexHttpUrl === undefined) {
			delete process.env.VITE_CONVEX_HTTP_URL;
		} else {
			process.env.VITE_CONVEX_HTTP_URL = prevConvexHttpUrl;
		}
	}
}

function execute_code_test_make_tool() {
	const { ctx, runMutation, runAction } = makeCtx(async () => null);
	return {
		tool: ai_chat_tool_create_execute_code(
			ctx,
			server_ai_tools_test_ctx_data as Parameters<typeof ai_chat_tool_create_execute_code>[1],
		),
		runMutation,
		runAction,
	};
}

test("execute_code tool: describes app file API reads", () => {
	const { tool } = execute_code_test_make_tool();

	expect(tool).toEqual(
		expect.objectContaining({
			description: expect.stringContaining("/api/v1/files/read-many"),
		}),
	);
	expect(tool).toEqual(
		expect.objectContaining({
			description: expect.stringContaining("run file API fetches inside the snippet"),
		}),
	);
});

test("execute_code tool: posts to the runner and formats a succeeded result with logs", async () => {
	await execute_code_test_with_runner(
		{
			url: "https://runner.test/",
			secret: "test-runner-secret",
			fetchImpl: async () =>
				execute_code_test_make_response(200, {
					executionId: "exec_1",
					status: "succeeded",
					codeHash: "hash_1",
					elapsedMs: 3,
					result: 4,
					resultTruncated: false,
					logs: ["hello"],
					logsTruncated: false,
					error: null,
				}),
		},
		async (fetchMock) => {
			const { tool, runMutation, runAction } = execute_code_test_make_tool();
			const result = await tool.execute?.(
				{ code: "return input.n * 2;", input: { n: 2, label: "payment-001" } },
				{ toolCallId: "tool-call-1", messages: [] },
			);

			if (!result) {
				throw new Error("`result` is undefined");
			}
			if (!isNotAsyncIterable(result)) {
				throw new Error("`result` is AsyncIterable but expected sync object");
			}

			expect(fetchMock).toHaveBeenCalledTimes(1);
			const [calledUrl, calledInit] = fetchMock.mock.calls[0] as [string, RequestInit];
			expect(calledUrl).toBe("https://runner.test/internal/execute-code");
			expect(calledInit.method).toBe("POST");
			expect((calledInit.headers as Record<string, string>).Authorization).toBe("Bearer test-runner-secret");
			const runnerBody = JSON.parse(calledInit.body as string);
			expect(runnerBody).toEqual({
				executionId: expect.any(String),
				code: "return input.n * 2;",
				input: { n: 2, label: "payment-001" },
				network: { mode: "public_http" },
				app: {
					origin: "https://app.test",
					token: expect.any(String),
				},
			});
			expect(runMutation).toHaveBeenCalledTimes(1);
			expect(runMutation.mock.calls[0]?.[1]).toEqual({
				organizationId: test_mocks_hardcoded.organization_id.organization_1,
				workspaceId: test_mocks_hardcoded.workspace_id.workspace_1,
				userId: server_ai_tools_test_user_id,
				threadId: server_ai_tools_test_thread_id,
				principalKey: runnerBody.executionId,
				tokenHash: expect.any(String),
				scopes: ["files:list", "files:read"],
				pathPrefix: null,
				now: expect.any(Number),
			});
			expect(runAction).not.toHaveBeenCalled();

			expect(result.title).toBe("Execute code");
			expect(result.metadata.status).toBe("succeeded");
			expect(result.output).toContain("Result: 4");
			expect(result.output).toContain("hello");
		},
	);
});

test("execute_code tool: formats an errored result", async () => {
	await execute_code_test_with_runner(
		{
			url: "https://runner.test",
			secret: "test-runner-secret",
			fetchImpl: async () =>
				execute_code_test_make_response(200, {
					executionId: "exec_2",
					status: "errored",
					codeHash: "hash_2",
					elapsedMs: 1,
					result: null,
					resultTruncated: false,
					logs: [],
					logsTruncated: false,
					error: { name: "TypeError", message: "boom" },
				}),
		},
		async () => {
			const { tool } = execute_code_test_make_tool();
			const result = await tool.execute?.({ code: "throw new TypeError('boom');" }, { toolCallId: "t", messages: [] });
			if (!result || !isNotAsyncIterable(result)) {
				throw new Error("unexpected result");
			}
			expect(result.metadata.status).toBe("errored");
			expect(result.output).toContain("Error: TypeError: boom");
		},
	);
});

test("execute_code tool: formats a timed_out result", async () => {
	await execute_code_test_with_runner(
		{
			url: "https://runner.test",
			secret: "test-runner-secret",
			fetchImpl: async () =>
				execute_code_test_make_response(200, {
					executionId: "exec_3",
					status: "timed_out",
					codeHash: "hash_3",
					elapsedMs: 5000,
					result: null,
					resultTruncated: false,
					logs: [],
					logsTruncated: false,
					error: { name: "TimeoutError", message: "Execution timed out." },
				}),
		},
		async () => {
			const { tool } = execute_code_test_make_tool();
			const result = await tool.execute?.({ code: "while (true) {}" }, { toolCallId: "t", messages: [] });
			if (!result || !isNotAsyncIterable(result)) {
				throw new Error("unexpected result");
			}
			expect(result.metadata.status).toBe("timed_out");
			expect(result.output).toContain("timed out");
		},
	);
});

test("execute_code tool: always sends gatewayed network and app runtime", async () => {
	await execute_code_test_with_runner(
		{
			url: "https://runner.test/",
			secret: "test-runner-secret",
			fetchImpl: async () =>
				execute_code_test_make_response(200, {
					executionId: "exec_net",
					status: "succeeded",
					codeHash: "hash_net",
					elapsedMs: 3,
					result: "ok",
					resultTruncated: false,
					logs: [],
					logsTruncated: false,
					error: null,
				}),
		},
		async (fetchMock) => {
			const { tool } = execute_code_test_make_tool();
			const result = await tool.execute?.(
				{ code: "return await fetch('https://example.com').then(r => r.text());" },
				{ toolCallId: "tool-call-net", messages: [] },
			);

			if (!result) {
				throw new Error("`result` is undefined");
			}
			if (!isNotAsyncIterable(result)) {
				throw new Error("`result` is AsyncIterable but expected sync object");
			}

			expect(fetchMock).toHaveBeenCalledTimes(1);
			const [, calledInit] = fetchMock.mock.calls[0] as [string, RequestInit];
			expect(JSON.parse(calledInit.body as string)).toEqual(
				expect.objectContaining({
					code: "return await fetch('https://example.com').then(r => r.text());",
					input: null,
					network: { mode: "public_http" },
					app: { origin: "https://app.test", token: expect.any(String) },
				}),
			);
		},
	);
});

test("execute_code tool: throws when the runner is not configured", async () => {
	await execute_code_test_with_runner({ url: undefined, secret: undefined }, async (fetchMock) => {
		const { tool } = execute_code_test_make_tool();
		await expect(tool.execute?.({ code: "return 1;" }, { toolCallId: "t", messages: [] })).rejects.toThrow(
			"Code execution is unavailable.",
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

test("execute_code tool: throws when the app origin is invalid", async () => {
	await execute_code_test_with_runner(
		{ url: "https://runner.test", secret: "test-runner-secret", appOrigin: "http://app.test" },
		async (fetchMock) => {
			const { tool, runMutation } = execute_code_test_make_tool();
			await expect(tool.execute?.({ code: "return 1;" }, { toolCallId: "t", messages: [] })).rejects.toThrow(
				"Code execution app access is unavailable.",
			);
			expect(fetchMock).not.toHaveBeenCalled();
			expect(runMutation).not.toHaveBeenCalled();
		},
	);
});

test("execute_code tool: surfaces the disabled kill switch", async () => {
	await execute_code_test_with_runner(
		{
			url: "https://runner.test",
			secret: "test-runner-secret",
			fetchImpl: async () =>
				execute_code_test_make_response(503, {
					ok: false,
					error: { code: "disabled", message: "Code execution is disabled." },
				}),
		},
		async () => {
			const { tool } = execute_code_test_make_tool();
			await expect(tool.execute?.({ code: "return 1;" }, { toolCallId: "t", messages: [] })).rejects.toThrow(
				"Code execution is disabled.",
			);
		},
	);
});

test("execute_code tool: surfaces a non-OK runner error, falling back to the status code", async () => {
	await execute_code_test_with_runner(
		{
			url: "https://runner.test",
			secret: "test-runner-secret",
			fetchImpl: async () =>
				execute_code_test_make_response(500, { ok: false, error: { code: "internal", message: "runner boom" } }),
		},
		async () => {
			const { tool } = execute_code_test_make_tool();
			await expect(tool.execute?.({ code: "return 1;" }, { toolCallId: "t", messages: [] })).rejects.toThrow(
				"runner boom",
			);
		},
	);

	await execute_code_test_with_runner(
		{
			url: "https://runner.test",
			secret: "test-runner-secret",
			fetchImpl: async () => ({
				ok: false,
				status: 502,
				json: async () => {
					throw new Error("not json");
				},
			}),
		},
		async () => {
			const { tool } = execute_code_test_make_tool();
			await expect(tool.execute?.({ code: "return 1;" }, { toolCallId: "t", messages: [] })).rejects.toThrow("(502)");
		},
	);
});

test("execute_code tool: surfaces runner outbound misconfiguration", async () => {
	await execute_code_test_with_runner(
		{
			url: "https://runner.test",
			secret: "test-runner-secret",
			fetchImpl: async () =>
				execute_code_test_make_response(503, {
					ok: false,
					error: {
						code: "misconfigured",
						message: "Code execution outbound access is unavailable.",
					},
				}),
		},
		async () => {
			const { tool } = execute_code_test_make_tool();
			await expect(tool.execute?.({ code: "return 1;" }, { toolCallId: "t", messages: [] })).rejects.toThrow(
				"outbound access is unavailable",
			);
		},
	);
});

test("execute_code tool: inputSchema rejects empty and oversize code", () => {
	const { tool } = execute_code_test_make_tool();
	const schema = tool.inputSchema;
	if (!has_defined_property(schema, "parse")) {
		throw new Error("inputSchema has no parse");
	}
	expect(() => schema.parse({ code: "" })).toThrow();
	expect(() => schema.parse({ code: "a".repeat(20_001) })).toThrow();
	expect(schema.parse({ code: "return 1;" })).toEqual({ code: "return 1;" });
});
