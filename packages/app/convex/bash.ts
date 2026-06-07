"use node";

// This module is not a full POSIX shell.
// It gives the AI a bash-shaped interface over Convex-backed app files.
// Convex file discovery has to stay index-friendly, so native glob expansion,
// recursive grep, and arbitrary regex scans are not the default app-file path.
// Prefer custom app-aware commands and flags that map directly to indexed queries,
// such as `find --extension`, `find --path-query`, `search --path`, and exact file reads.
// When the model still writes common glob or regex-shaped commands, recover only the
// simple cases that can be translated safely into the same indexed operations.
// Do not add broad JavaScript filtering after pagination to imitate native shell behavior.

import { v } from "convex/values";
import {
	Bash,
	defineCommand,
	InMemoryFs,
	MountableFs,
	type CommandContext,
	type CommandName,
	type CpOptions,
	type FileContent,
	type FsStat,
	type IFileSystem,
	type MkdirOptions,
	type RmOptions,
} from "just-bash/browser";
import mri from "mri";
import { z } from "zod";
import { internal } from "./_generated/api.js";
import { internalAction, type ActionCtx } from "./_generated/server.js";
import type { Doc, Id } from "./_generated/dataModel";
import type { ai_chat_get_thread_state_Result } from "./ai_chat.ts";
import type {
	files_nodes_create_folder_node_by_path_Result,
	files_nodes_get_bash_path_entry_Result,
	files_nodes_get_bash_served_byte_size_Result,
	files_nodes_get_bash_stat_entry_Result,
	files_nodes_get_by_path_Result,
	files_nodes_get_file_last_available_markdown_content_by_path_Result,
	files_nodes_grep_app_file_Result,
	files_nodes_grep_app_file_scan_Result,
	files_nodes_list_dir_children_by_parent_paginated_Result,
	files_nodes_list_dir_children_by_parent_recency_paginated_Result,
	files_nodes_list_path_prefix_paginated_Result,
	files_nodes_list_recent_paginated_Result,
	files_nodes_list_subtree_by_extension_paginated_Result,
	files_nodes_list_subtree_paginated_Result,
	files_nodes_read_file_content_stats_Result,
	files_nodes_read_file_line_range_Result,
	files_nodes_read_file_tail_lines_Result,
	files_nodes_search_paths_paginated_Result,
	files_nodes_text_search_files_Result,
} from "./files_nodes.ts";
import { Result } from "../shared/errors-as-values-utils.ts";
import { files_chunk_BITMASK_FLAGS, files_chunk_has_bitmask_flag } from "../server/files-markdown-chunking-mastra.ts";

const HOME = "/home/cloud-usr";
const MOUNT_ROOT = `${HOME}/w`;
const TMP_MOUNT = "/tmp";
const DEFAULT_CWD = "~";
const FILES_ROOT_ID = "root";
const OUTPUT_LIMIT = 30_000;
const COMMAND_EXIT_FAILURE = 1;
const COMMAND_EXIT_USAGE = 2;
const textEncoder = new TextEncoder();

const TERMINAL_LINE_ENDING_REGEX = /\r\n?/g;
const TERMINAL_TRAILING_NEWLINE_REGEX = /\n+$/;
const SIMPLE_EXTENSION_GLOB_REGEX = /^\*\.([a-z0-9][a-z0-9_-]*)$/iu;
const GLOB_METACHARACTER_REGEX = /[*?[\]]/u;
const SHELL_ARG_SAFE_UNQUOTED_REGEX = /^[A-Za-z0-9_/:.,=+-]+$/;

const ALLOWED_COMMANDS = [
	"echo",
	"cat",
	"printf",
	"ls",
	"pwd",
	"head",
	"tail",
	"wc",
	"stat",
	"grep",
	"sed",
	"awk",
	"sort",
	"uniq",
	"cut",
	"tr",
	"find",
	"basename",
	"dirname",
	"tree",
	"xargs",
	"true",
	"false",
	"bash",
	"sh",
	"help",
	"which",
	"mkdir",
	"touch",
	"rm",
	"cp",
	"mv",
	"tee",
	"seq",
] as const satisfies CommandName[];

/**
 * Keep the Just Bash path cache to the file-node fields the virtual filesystem needs.
 *
 * Some entries come from Convex `files_nodes` rows, others are synthetic parent
 * folders created while caching descendants.
 */
type JustBashFileNodeCacheEntry = {
	nodeId?: Id<"files_nodes">;
	path: Doc<"files_nodes">["path"];
	kind: Doc<"files_nodes">["kind"];
	updatedAt: Doc<"files_nodes">["updatedAt"];
	updatedBy?: Id<"users">;
	contentType?: Doc<"files_nodes">["contentType"];
};

type WorkspaceFsOptions = {
	ctx: ActionCtx;
	ctxData: {
		workspaceId: string;
		projectId: string;
		workspaceName: string;
		projectName: string;
		userId: Id<"users">;
	};
	appFilesMountPath: string;
	allowAppFileTreeMkdir: boolean;
};
/**
 * Means the app file exists, but bash cannot read its body as text.
 *
 * Keep the path and content type so command handlers can print a useful message.
 */
class AppFileContentUnavailableError extends Error {
	/**
	 * The absolute bash path the command tried to read,
	 * like `/home/cloud-usr/w/docs/file.pdf`.
	 **/
	readonly shellPath: string;

	/**
	 * The file type, when the app knows it,
	 * as a MIME type like `text/markdown` or `application/pdf`.
	 **/
	readonly contentType: string | undefined;

	constructor(args: { shellPath: string; contentType: string | undefined }) {
		super(`unsupported app file content type '${args.contentType ?? "unknown"}'`);
		this.name = "AppFileContentUnavailableError";
		this.shellPath = args.shellPath;
		this.contentType = args.contentType;
	}
}

/**
 * Means bash tried to mutate a mounted read-only filesystem path.
 */
class ReadOnlyFileSystemError extends Error {
	readonly path: string;

	constructor(path: string) {
		const normalizedPath = normalize_path(path);
		super(
			`EROFS: read-only file system, '${normalizedPath}'. Persistent app writes must use write_file/edit_file; shell redirects into app files are unsupported.`,
		);
		this.name = "ReadOnlyFileSystemError";
		this.path = normalizedPath;
	}
}

/**
 * Return one clean absolute path for bash, Convex queries, and cache keys.
 */
function normalize_path(path: string) {
	const parts: string[] = [];
	const normalizedInput = path.replace(/\\/g, "/");
	for (const rawPart of normalizedInput.split("/")) {
		const part = rawPart.trim();
		if (!part || part === ".") {
			continue;
		}
		if (part === "..") {
			parts.pop();
			continue;
		}
		parts.push(part);
	}
	return `/${parts.join("/")}`;
}

/**
 * Resolve a bash path against the current directory.
 */
function resolve_path(base: string, path: string) {
	return normalize_path(path.startsWith("/") ? path : `${base}/${path}`);
}

/**
 * Convert an app file path to its mounted bash path.
 */
function app_path_to_shell_path(appFilesMountPath: string, path: string) {
	const normalizedPath = normalize_path(path);
	return normalizedPath === "/" ? appFilesMountPath : `${appFilesMountPath}${normalizedPath}`;
}

/**
 * Convert a mounted shell path back to a real app file path.
 *
 * The path must already be normalized by the command boundary before calling
 * this helper.
 */
function shell_path_to_app_path(appFilesMountPath: string, path: string) {
	if (path === appFilesMountPath) {
		return "/";
	}
	if (path.startsWith(`${appFilesMountPath}/`)) {
		return path.slice(appFilesMountPath.length);
	}
	return null;
}

/**
 * Quote one shell argument for command hints printed back to the model.
 *
 * Plain path-like tokens stay readable. Anything else is single-quoted, with
 * embedded single quotes escaped using the normal shell `'\''` pattern.
 */
function shell_arg_quote(arg: string) {
	return SHELL_ARG_SAFE_UNQUOTED_REGEX.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * Expand the cwd saved in thread state into the absolute path Bash runs with.
 *
 * We save cwd as `~` or `~/...` so it stays tied to the bash home.
 * Examples:
 * - `undefined` or `~` -> `/home/cloud-usr`
 * - `~/w/personal/home` -> `/home/cloud-usr/w/personal/home`
 * - `/home/cloud-usr/w/personal/home` -> `/home/cloud-usr/w/personal/home`
 */
function expand_persisted_bash_cwd(path: string | undefined) {
	const cwd = path?.trim() || DEFAULT_CWD;
	if (cwd === "~") {
		return HOME;
	}
	if (cwd.startsWith("~/")) {
		return normalize_path(`${HOME}/${cwd.slice(2)}`);
	}
	if (cwd === HOME || cwd.startsWith(`${HOME}/`)) {
		return normalize_path(cwd);
	}
	return normalize_path(cwd);
}

/**
 * Collapse a bash cwd into the thread-state format.
 *
 * Only paths under `/home/cloud-usr` persist between bash calls.
 * Examples:
 * - `/home/cloud-usr` -> `~`
 * - `/home/cloud-usr/w/personal/home` -> `~/w/personal/home`
 * - `/tmp` -> `null`
 */
function collapse_bash_cwd_for_persistence(shellCwd: string | undefined) {
	const normalizedCwd = normalize_path(shellCwd || HOME);
	if (normalizedCwd === HOME) {
		return DEFAULT_CWD;
	}
	if (normalizedCwd.startsWith(`${HOME}/`)) {
		return `~/${normalizedCwd.slice(HOME.length + 1)}`;
	}
	return null;
}

/**
 * Read the simple glob form that can become an indexed extension search.
 *
 * Accepts `*.md` and `/some/path/*.md`.
 *
 * Returns `null` for anything more complex.
 */
function parse_simple_find_command_extension_glob(pattern: string) {
	const trimmed = pattern.trim();

	// Split an optional folder path from the file name part.
	const slashIndex = trimmed.lastIndexOf("/");
	const basename = slashIndex === -1 ? trimmed : trimmed.slice(slashIndex + 1);

	// Only accept the exact shape `*.extension`.
	const match = basename.match(SIMPLE_EXTENSION_GLOB_REGEX);
	if (!match) {
		return null;
	}

	// Keep the folder path if the user wrote one, like `/docs/*.md`.
	const path = slashIndex === -1 ? undefined : trimmed.slice(0, slashIndex) || "/";
	if (path != null && GLOB_METACHARACTER_REGEX.test(path)) {
		return null;
	}

	return {
		path,
		// Extension search is case-insensitive.
		extension: match[1].toLowerCase(),
	};
}

/**
 * Build the error text for commands that operate on Convex-backed app files
 * when a path operand contains shell glob metacharacters.
 *
 * These commands read, list, or inspect the virtual app file tree mounted under
 * `~/w/...`; they do not expand globs over that tree. For the common discovery
 * mistake `*.ext`, point the model at `find --extension`, which uses the indexed
 * file path query. `find` itself handles simple extension globs separately and
 * can run that indexed search directly.
 */
function app_glob_syntax_unsupported_message(command: string, path: string) {
	const simpleExtensionGlob = parse_simple_find_command_extension_glob(path);
	if (simpleExtensionGlob) {
		const target = simpleExtensionGlob.path ?? ".";
		return (
			`${command}: app file glob patterns are not supported: ${path}\n` +
			`Try: find ${shell_arg_quote(target)} -type f --extension ${shell_arg_quote(simpleExtensionGlob.extension)} --limit 20\n`
		);
	}
	return (
		`${command}: app file glob patterns are not supported: ${path}\n` +
		`Use an exact path, or use find with a predicate:\n` +
		`  find -name readme            # DB-backed path word search\n` +
		`  find --path-query readme     # explicit DB-backed path word search\n`
	);
}

/**
 * Check whether a normalized path is inside the mounted app file tree.
 */
function is_path_under_app_mount(appFilesMountPath: string, path: string) {
	return path === appFilesMountPath || path.startsWith(`${appFilesMountPath}/`);
}


/**
 * Cap bash stdout/stderr before storing it in the chat message.
 */
function truncate_output(value: string) {
	if (value.length <= OUTPUT_LIMIT) {
		return {
			value,
			truncated: false,
		};
	}

	const truncated = `${value.slice(0, OUTPUT_LIMIT)}\n\n[truncated after ${OUTPUT_LIMIT} characters]`;
	const trimmed = value.trimEnd();
	const lastLineStart = trimmed.lastIndexOf("\n") + 1;
	const lastLine = trimmed.slice(lastLineStart);
	const continuation = lastLine.includes("Next page:") && !truncated.includes(lastLine) ? `\n${lastLine}` : "";
	return {
		value: `${truncated}${continuation}`,
		truncated: true,
	};
}

/**
 * Render the structured bash result as the terminal transcript shown to the model.
 */
function format_tool_output(args: {
	command: string;
	cwd: string;
	nextCwd: string;
	exitCode: number;
	stdout: string;
	stderr: string;
}) {
	const stdout = args.stdout.replace(TERMINAL_LINE_ENDING_REGEX, "\n").replace(TERMINAL_TRAILING_NEWLINE_REGEX, "");
	const stderr = args.stderr.replace(TERMINAL_LINE_ENDING_REGEX, "\n").replace(TERMINAL_TRAILING_NEWLINE_REGEX, "");
	const lines = [`${args.cwd}$ ${args.command}`];
	if (stdout) {
		lines.push("", stdout);
	}
	if (stderr) {
		lines.push("", stderr);
	}

	const statusParts = [`exit ${args.exitCode}`];
	if (args.nextCwd !== args.cwd) {
		statusParts.push(`cwd changed: ${args.cwd} -> ${args.nextCwd}`);
	}
	lines.push("", statusParts.join(" · "));

	return lines.join("\n");
}

// #region search command

const search_command_args_schema = z.object({
	_: z.array(z.string()),
	limit: z
		.string()
		.trim()
		.regex(/^-?\d+$/)
		.transform((value) => Number(value)),
	cursor: z.string().trim().optional(),
	path: z.string().trim().optional(),
});

function search_command_parse_args(args: string[], appFilesMountPath: string) {
	const unsupportedChunkFilter = args.find((arg) => arg === "--code" || arg === "--table" || arg === "--no-code");
	if (unsupportedChunkFilter != null) {
		return Result({
			_nay: {
				message:
					`search: ${unsupportedChunkFilter} is not supported for app indexed search.\n` +
					"Use a distinctive text token, or inspect a specific file with grep.",
			},
		});
	}

	const unsupportedOptions: string[] = [];
	const parsedArgs = mri<{ limit?: string; path?: string; cursor?: string }>(args, {
		string: ["limit", "path", "cursor"],
		alias: {
			limit: [],
			path: [],
			cursor: [],
		},
		default: {
			limit: "20",
		},
		unknown: (option) => {
			unsupportedOptions.push(option);
		},
	});

	const unsupportedOption = unsupportedOptions[0];
	if (unsupportedOption != null) {
		return Result({ _nay: { message: `search: unsupported option ${unsupportedOption}` } });
	}

	const result = search_command_args_schema.safeParse(parsedArgs);
	if (!result.success) {
		const hasLimitError = result.error.issues.some((issue) => issue.path[0] === "limit");
		return Result({
			_nay: { message: hasLimitError ? "search: --limit must be an integer" : "search: missing query" },
		});
	}

	// A positional path is almost always a mistaken scope filter; point to --path instead of
	// silently folding it into the text query.
	const pathOperand = result.data._.find(
		(arg) =>
			arg.includes("/") ||
			arg.startsWith("~") ||
			arg === "." ||
			arg === ".." ||
			is_path_under_app_mount(appFilesMountPath, normalize_path(arg)),
	);
	if (pathOperand != null) {
		return Result({
			_nay: {
				message:
					`search: path operands are not supported: ${pathOperand}\n` +
					"Pass query terms only. To restrict to one folder, use: search --path <folder> <query terms>",
			},
		});
	}

	// Optional subtree scope. Resolve the shell folder path to an app path; reject paths outside the
	// app file tree.
	let pathPrefix: string | undefined;
	if (result.data.path != null && result.data.path !== "") {
		const appPath = shell_path_to_app_path(appFilesMountPath, normalize_path(result.data.path));
		if (appPath == null) {
			return Result({
				_nay: {
					message:
						`search: --path must be a folder under the app file tree: ${result.data.path}\n` +
						`Use an absolute path under ${appFilesMountPath}.`,
				},
			});
		}
		pathPrefix = appPath;
	}

	const query = result.data._.join(" ").trim();
	return query
		? Result({
				_yay: {
					query,
					limit: Math.max(1, Math.min(100, result.data.limit)),
					cursor: result.data.cursor ?? null,
					pathPrefix,
				},
			})
		: Result({ _nay: { message: "search: missing query" } });
}

function search_command_create(ctx: ActionCtx, ctxData: WorkspaceFsOptions["ctxData"], appFilesMountPath: string) {
	return defineCommand("search", async (args, commandCtx) => {
		const parsedResult = search_command_parse_args(args, appFilesMountPath);
		if (parsedResult._nay) {
			return {
				stdout: "",
				stderr: `${parsedResult._nay.message}\nUsage: search [--limit N] [--cursor CURSOR] [--path <folder>] <query...>\n`,
				exitCode: 2,
			};
		}
		const parsed = parsedResult._yay;

		const cwdAppPath = shell_path_to_app_path(
			appFilesMountPath,
			default_app_target_shell_path(commandCtx.cwd, appFilesMountPath),
		);
		const pathPrefix = parsed.pathPrefix ?? (cwdAppPath != null && cwdAppPath !== "/" ? cwdAppPath : undefined);
		const res = (await ctx.runQuery(internal.files_nodes.text_search_files, {
			workspaceId: ctxData.workspaceId,
			projectId: ctxData.projectId,
			query: parsed.query,
			numItems: parsed.limit,
			cursor: parsed.cursor,
			pathPrefix,
		})) as files_nodes_text_search_files_Result;
		const searchResult = {
			items: res.items.map((item) => ({
				...item,
				path: app_path_to_shell_path(appFilesMountPath, item.path),
			})),
		};
		const hasNextPage =
			!res.isDone &&
			(pathPrefix == null ||
				(await ctx.runQuery(internal.files_nodes.text_search_files_page_has_items, {
					workspaceId: ctxData.workspaceId,
					projectId: ctxData.projectId,
					query: parsed.query,
					cursor: res.continueCursor,
					pathPrefix,
				})));
		const scopeNote = pathPrefix != null ? ` under ${app_path_to_shell_path(appFilesMountPath, pathPrefix)}` : "";
		let output = `No content matches found${scopeNote}. search uses indexed Convex text search, not path/name search; use find -name QUERY or find --path-query QUERY for path/name discovery. Retry content search with a shorter distinctive token if needed.`;

		if (searchResult.items.length) {
			const outputBlocks = searchResult.items.map((item) => {
				const isCodeChunk = files_chunk_has_bitmask_flag(item.chunkFlags, files_chunk_BITMASK_FLAGS.isCode);
				const isTableChunk = files_chunk_has_bitmask_flag(item.chunkFlags, files_chunk_BITMASK_FLAGS.isTable);
				const hasSpecificAbove = files_chunk_has_bitmask_flag(
					item.chunkFlags,
					files_chunk_BITMASK_FLAGS.hasMoreFragmentContentAbove,
				);
				const hasSpecificBelow = files_chunk_has_bitmask_flag(
					item.chunkFlags,
					files_chunk_BITMASK_FLAGS.hasMoreFragmentContentBelow,
				);

				const blockLines = [
					`${item.path} (lines ${item.lineStart}-${item.lineEnd}, chars ${item.startIndex}-${item.endIndex}, chunk #${item.chunkIndex})`,
				];

				if (item.hasChunkAbove) {
					if (hasSpecificAbove && isCodeChunk) {
						blockLines.push("... more code block content above");
					} else if (hasSpecificAbove && isTableChunk) {
						blockLines.push("... more table content above");
					} else {
						blockLines.push("... more content above");
					}
				}

				blockLines.push(item.markdownChunk);

				if (item.hasChunkBelow) {
					if (hasSpecificBelow && isCodeChunk) {
						blockLines.push("... more code block content below");
					} else if (hasSpecificBelow && isTableChunk) {
						blockLines.push("... more table content below");
					} else {
						blockLines.push("... more content below");
					}
				}

				return blockLines.join("\n");
			});

			const blocks = [`Found ${searchResult.items.length} results${scopeNote}`, "", ...outputBlocks];
			if (hasNextPage) {
				const continuationParts = ["Next page:", "search"];
				if (pathPrefix != null) {
					continuationParts.push("--path", shell_arg_quote(app_path_to_shell_path(appFilesMountPath, pathPrefix)));
				}
				continuationParts.push(
					"--limit",
					String(parsed.limit),
					"--cursor",
					shell_arg_quote(res.continueCursor),
					shell_arg_quote(parsed.query),
				);
				blocks.push("", continuationParts.join(" "));
			}
			output = blocks.join("\n");
		} else if (hasNextPage) {
			const continuationParts = ["Next page:", "search"];
			if (pathPrefix != null) {
				continuationParts.push("--path", shell_arg_quote(app_path_to_shell_path(appFilesMountPath, pathPrefix)));
			}
			continuationParts.push(
				"--limit",
				String(parsed.limit),
				"--cursor",
				shell_arg_quote(res.continueCursor),
				shell_arg_quote(parsed.query),
			);
			output = `${output}\n\n${continuationParts.join(" ")}`;
		}

		return {
			stdout: `${output}\n`,
			stderr: "",
			exitCode: 0,
		};
	});
}

// #endregion search command

// Aggressive listing page sizes so even a small workspace exercises pagination like a huge
// one: a bare ls/find returns LISTING_DEFAULT_LIMIT entries, and a larger --limit is clamped
// to LISTING_MAX_LIMIT. Applies to both surface (dir children) and depth (subtree) listings.
// Tunable — raise for production.
const LISTING_DEFAULT_LIMIT = 10;
const LISTING_MAX_LIMIT = 20;
// Shared partial-page sentinel emitted by ls and find when a page yields no rows but the
// cursor is not done. The agent-facing docs/system prompt document this exact phrase, so all
// listing surfaces must emit it verbatim (an ls page that said "No items..." would not be
// recognized as the documented "continue paging" signal).
const PARTIAL_PAGE_NOTICE = "No matches in this page; more pages exist.";
// Content readers (cat/head/tail/wc) fetch full file content from Convex per app-file
// operand, so bound how many a single command can pull. stat reuses this for metadata fan-out.
const READER_FILE_OPERAND_MAX = 10;
// A full inline read pulls the entire file content. Above this byte size, full-file readers
// fall back to BOUNDED reads (head/tail/sed line ranges, served from materialized chunks), so a
// large file is never loaded in one shot. DEV-PHASE AGGRESSIVE: intentionally tiny so our small
// test files page like big ones; the agent must be able to page through content at this cap.
// Raise before production. Tunable.
const READ_INLINE_MAX_BYTES = 2 * 1024;
// Per-page line cap for head/sed/tail against a large file (must match the backend
// files_READ_RANGE_MAX_LINES). DEV-PHASE AGGRESSIVE so pagination kicks in on small files.
const READ_HEAD_LARGE_FILE_MAX_LINES = 40;

async function delegate_builtin_command(
	command: CommandName,
	args: string[],
	ctx: CommandContext,
	options?: { cwd?: string },
) {
	// Custom commands shadow built-ins, so delegate through a clean nested Bash
	// instance instead of ctx.exec, which would recurse into this override.
	const env = Object.fromEntries(ctx.env);
	const cwd = options?.cwd ?? ctx.cwd;
	const inner = new Bash({
		fs: ctx.fs,
		cwd,
		env,
		commands: [command],
		executionLimits: ctx.limits,
	});
	return await inner.exec([command, ...args.map(shell_arg_quote)].join(" "), {
		cwd,
		stdin: ctx.stdin as unknown as string,
		stdinKind: "bytes",
		env: {
			...env,
			PWD: cwd,
		},
	});
}

function parse_listing_limit(command: string, value: string | undefined) {
	const rawValue = value ?? String(LISTING_DEFAULT_LIMIT);
	if (!/^-?\d+$/u.test(rawValue.trim())) {
		return Result({ _nay: { message: `${command}: --limit must be an integer` } });
	}
	return Result({ _yay: { limit: Math.max(1, Math.min(LISTING_MAX_LIMIT, Number(rawValue))) } });
}

function default_app_target_shell_path(cwd: string, appFilesMountPath: string) {
	const normalizedCwd = normalize_path(cwd);
	return is_path_under_app_mount(appFilesMountPath, normalizedCwd) ? normalizedCwd : appFilesMountPath;
}

async function get_bash_path_entry(
	ctx: ActionCtx,
	ctxData: WorkspaceFsOptions["ctxData"],
	appPath: string,
): Promise<files_nodes_get_bash_path_entry_Result> {
	return (await ctx.runQuery(internal.files_nodes.get_bash_path_entry, {
		workspaceId: ctxData.workspaceId,
		projectId: ctxData.projectId,
		path: appPath,
	})) as files_nodes_get_bash_path_entry_Result;
}

// #region ls command

const LS_PATH_OPERAND_MAX = 20;

function ls_command_read_value(args: string[], index: number, option: string) {
	const value = args[index + 1];
	if (value == null) {
		return Result({ _nay: { message: `ls: ${option} requires a value` } });
	}
	return Result({ _yay: { value, nextIndex: index + 1 } });
}

function parse_ls_command_args(args: string[]) {
	let limitValue: string | undefined;
	let cursor: string | null = null;
	const paths: string[] = [];
	let unsupportedOption: string | null = null;
	let recursive = false;
	let directory = false;
	let reverse = false;
	let long = false;
	let time = false;
	let optionsEnded = false;

	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		if (optionsEnded) {
			paths.push(arg);
			continue;
		}
		if (arg === "--") {
			optionsEnded = true;
			continue;
		}
		if (arg === "--limit") {
			const value = ls_command_read_value(args, index, "--limit");
			if (value._nay) return value;
			limitValue = value._yay.value;
			index = value._yay.nextIndex;
			continue;
		}
		if (arg.startsWith("--limit=")) {
			limitValue = arg.slice("--limit=".length);
			continue;
		}
		if (arg === "--cursor") {
			const value = ls_command_read_value(args, index, "--cursor");
			if (value._nay) return value;
			cursor = value._yay.value;
			index = value._yay.nextIndex;
			continue;
		}
		if (arg.startsWith("--cursor=")) {
			cursor = arg.slice("--cursor=".length);
			continue;
		}
		if (arg === "--recursive") {
			recursive = true;
			continue;
		}
		if (arg === "--directory") {
			directory = true;
			continue;
		}
		if (arg === "--reverse") {
			reverse = true;
			continue;
		}
		if (arg === "--classify") {
			continue;
		}
		if (arg === "--indicator-style") {
			const value = ls_command_read_value(args, index, "--indicator-style");
			if (value._nay) return value;
			if (value._yay.value !== "slash") {
				unsupportedOption ??= `--indicator-style=${value._yay.value}`;
			}
			index = value._yay.nextIndex;
			continue;
		}
		if (arg.startsWith("--indicator-style=")) {
			const value = arg.slice("--indicator-style=".length);
			if (value !== "slash") {
				unsupportedOption ??= arg;
			}
			continue;
		}
		if (arg === "--sort") {
			const value = ls_command_read_value(args, index, "--sort");
			if (value._nay) return value;
			if (value._yay.value === "time" || value._yay.value === "mtime") {
				time = true;
			} else if (value._yay.value !== "name") {
				unsupportedOption ??= `--sort=${value._yay.value}`;
			}
			index = value._yay.nextIndex;
			continue;
		}
		if (arg.startsWith("--sort=")) {
			const value = arg.slice("--sort=".length);
			if (value === "time" || value === "mtime") {
				time = true;
			} else if (value !== "name") {
				unsupportedOption ??= arg;
			}
			continue;
		}
		if (arg.startsWith("--")) {
			unsupportedOption ??= arg;
			continue;
		}
		if (arg.startsWith("-") && arg !== "-") {
			for (const flag of arg.slice(1)) {
				if (flag === "1" || flag === "a" || flag === "A" || flag === "p" || flag === "F") {
					continue;
				}
				if (flag === "d") {
					directory = true;
					continue;
				}
				if (flag === "r") {
					reverse = true;
					continue;
				}
				if (flag === "R") {
					recursive = true;
					continue;
				}
				if (flag === "l") {
					long = true;
					continue;
				}
				if (flag === "t") {
					time = true;
					continue;
				}
				unsupportedOption ??= `-${flag}`;
			}
			continue;
		}
		paths.push(arg);
	}

	const limit = parse_listing_limit("ls", limitValue);
	if (limit._nay) {
		return limit;
	}
	if (paths.length > LS_PATH_OPERAND_MAX) {
		return Result({ _nay: { message: `ls: app file listings support at most ${LS_PATH_OPERAND_MAX} path operands` } });
	}

	if (cursor != null && cursor.trim() === "") {
		cursor = null;
	}
	if (cursor != null && paths.length > 1) {
		return Result({ _nay: { message: "ls: --cursor can only continue one listing target" } });
	}

	return Result({
		_yay: {
			paths,
			limit: limit._yay.limit,
			cursor,
			hasAppListingOption: limitValue != null || cursor != null,
			unsupportedOption,
			recursive,
			directory,
			reverse,
			long,
			time,
		} as const,
	});
}

function format_ls_command_item(args: {
	kind: "folder" | "file";
	updatedAt: number;
	updatedBy?: string;
	contentType?: string;
	display: string;
	long: boolean;
}) {
	const display = args.kind === "folder" && !args.display.endsWith("/") ? `${args.display}/` : args.display;
	if (!args.long) {
		return display;
	}
	const fields = [args.kind, new Date(args.updatedAt).toISOString(), `updatedBy=${args.updatedBy ?? "-"}`];
	if (args.contentType != null) {
		fields.push(`contentType=${args.contentType}`);
	}
	fields.push(display);
	return fields.join("\t");
}

function build_ls_command_continuation(args: {
	parsed: NonNullable<ReturnType<typeof parse_ls_command_args>["_yay"]>;
	targetShellPath: string;
	cursor: string;
}) {
	const continuationParts = ["Next page:", "ls"];
	if (args.parsed.long) {
		continuationParts.push("-l");
	}
	if (args.parsed.reverse) {
		continuationParts.push("-r");
	}
	if (args.parsed.time) {
		continuationParts.push("-t");
	}
	if (args.parsed.recursive && !args.parsed.directory) {
		continuationParts.push("-R");
	}
	continuationParts.push(
		"--limit",
		String(args.parsed.limit),
		"--cursor",
		shell_arg_quote(args.cursor),
		shell_arg_quote(args.targetShellPath),
	);
	return continuationParts.join(" ");
}

function build_ls_command_recent_continuation(args: {
	parsed: NonNullable<ReturnType<typeof parse_ls_command_args>["_yay"]>;
	cursor: string;
}) {
	// Recency listing is project-wide, so the continuation carries no path operand.
	return [
		"Next page:",
		"ls",
		args.parsed.reverse ? "-rt" : "-t",
		"--limit",
		String(args.parsed.limit),
		"--cursor",
		shell_arg_quote(args.cursor),
	].join(" ");
}

async function get_ls_command_path_entry(args: {
	ctx: ActionCtx;
	ctxData: WorkspaceFsOptions["ctxData"];
	workspaceFs: WorkspaceFs;
	appPath: string;
	needsFullMetadata: boolean;
}) {
	if (!args.needsFullMetadata) {
		const cached = await args.workspaceFs.getEntry(args.appPath);
		if (!cached) {
			return null;
		}
		if (args.appPath === "/" || cached.nodeId != null) {
			return {
				nodeId: args.appPath === "/" ? (FILES_ROOT_ID as typeof FILES_ROOT_ID) : cached.nodeId,
				path: cached.path,
				name: cached.path.split("/").filter(Boolean).at(-1) ?? "",
				kind: cached.kind,
				updatedAt: cached.updatedAt,
				updatedBy: cached.updatedBy,
				contentType: cached.contentType,
			};
		}
	}

	const entry = await get_bash_path_entry(args.ctx, args.ctxData, args.appPath);
	if (entry && entry.nodeId !== FILES_ROOT_ID) {
		args.workspaceFs.rememberEntry({
			nodeId: entry.nodeId,
			path: entry.path,
			kind: entry.kind,
			updatedAt: entry.updatedAt,
			updatedBy: entry.updatedBy,
			contentType: entry.contentType,
		});
	}
	return entry;
}

function ls_command_create(ctx: ActionCtx, workspaceFs: WorkspaceFs, appFilesMountPath: string) {
	return defineCommand("ls", async (args, commandCtx) => {
		const parsedResult = parse_ls_command_args(args);
		if (parsedResult._nay) {
			return {
				stdout: "",
				stderr: `${parsedResult._nay.message}\nUsage: ls [-1aApFdlrRt] [--limit N] [--cursor CURSOR] [PATH ...]\n`,
				exitCode: COMMAND_EXIT_USAGE,
			};
		}
		const parsed = parsedResult._yay;

		const targetInputs = parsed.paths.length > 0 ? parsed.paths : [undefined];
		const targets = targetInputs.map((path) => {
			const targetShellPath = resolve_path(
				commandCtx.cwd,
				path ?? default_app_target_shell_path(commandCtx.cwd, appFilesMountPath),
			);
			return {
				inputPath: path,
				targetShellPath,
				appPath: shell_path_to_app_path(appFilesMountPath, targetShellPath),
			};
		});
		if (targets.every((target) => target.appPath == null)) {
			if (parsed.hasAppListingOption) {
				return {
					stdout: "",
					stderr: (
						"ls: --limit and --cursor are only available for app file paths\n" +
						`Omit PATH to list the app root, or use ${appFilesMountPath} explicitly. Use plain ls for /tmp.\n`
					),
					exitCode: COMMAND_EXIT_USAGE,
				};
			}
			return await delegate_builtin_command("ls", args, commandCtx);
		}
		if (targets.some((target) => target.appPath == null)) {
			return {
				stdout: "",
				stderr: "ls: cannot mix app file paths with non-app paths in one listing\n",
				exitCode: COMMAND_EXIT_USAGE,
			};
		}

		if (parsed.unsupportedOption != null) {
			if (parsed.unsupportedOption === "--next-page") {
				return {
					stdout: "",
					stderr: (
						"ls: --next-page is not supported for app files\n" +
						"Copy the exact `Next page: ls --limit N --cursor ... <path>` command from the previous ls output.\n" +
						"Usage: ls [-1aApFdlrRt] [--limit N] [--cursor CURSOR] [PATH ...]\n"
					),
					exitCode: COMMAND_EXIT_USAGE,
				};
			}
			const opt = parsed.unsupportedOption;
			const hint = "App ls supports name order only; use find/search for pattern and content discovery.";
			return {
				stdout: "",
				stderr: `ls: unsupported option ${opt} for app files\n${hint}\nUsage: ls [-1aApFdlrRt] [--limit N] [--cursor CURSOR] [PATH ...]\n`,
				exitCode: COMMAND_EXIT_USAGE,
			};
		}

		if (parsed.time && parsed.paths.length === 0) {
			const result = (await ctx.runQuery(internal.files_nodes.list_recent_paginated, {
				workspaceId: workspaceFs.ctxData.workspaceId,
				projectId: workspaceFs.ctxData.projectId,
				numItems: parsed.limit,
				cursor: parsed.cursor,
				order: parsed.reverse ? "asc" : "desc",
			})) as files_nodes_list_recent_paginated_Result;

			const lines = result.items.map(
				(item) =>
					`${new Date(item.updatedAt).toISOString()}\t${app_path_to_shell_path(appFilesMountPath, item.path)}${item.kind === "folder" ? "/" : ""}`,
			);
			if (!result.isDone) {
				if (lines.length === 0) {
					lines.push(PARTIAL_PAGE_NOTICE);
				}
				lines.push("", build_ls_command_recent_continuation({ parsed, cursor: result.continueCursor }));
			} else if (lines.length === 0) {
				lines.push("(no files)");
			}
			return { stdout: `${lines.join("\n")}\n`, stderr: "", exitCode: 0 };
		}
		if (parsed.time && parsed.recursive && !parsed.directory) {
			return {
				stdout: "",
				stderr: (
					"ls -t -R is not supported for app file paths.\n" +
					"Use `ls -t` for project-wide recency, `ls -t <dir>` for immediate children, or `find <dir>` for recursive path discovery.\n"
				),
				exitCode: COMMAND_EXIT_USAGE,
			};
		}

		for (const target of targets) {
			if (target.inputPath != null && GLOB_METACHARACTER_REGEX.test(target.inputPath)) {
				return {
					stdout: "",
					stderr: app_glob_syntax_unsupported_message("ls", target.inputPath),
					exitCode: COMMAND_EXIT_USAGE,
				};
			}
		}

		const sections: string[] = [];
		let stderr = "";
		let hasFailure = false;
		for (const target of targets) {
			const appPath = target.appPath;
			if (appPath == null) {
				continue;
			}

			const entry = await get_ls_command_path_entry({
				ctx,
				ctxData: workspaceFs.ctxData,
				workspaceFs,
				appPath,
				needsFullMetadata: parsed.long && (parsed.directory || (await workspaceFs.getEntry(appPath))?.kind === "file"),
			});
			if (!entry) {
				stderr += `ls: cannot access '${target.targetShellPath}': No such file or directory\n`;
				hasFailure = true;
				continue;
			}

			const lines: string[] = [];
			if (parsed.directory || entry.kind === "file") {
				if (parsed.cursor != null) {
					return {
						stdout: "",
						stderr: `ls: --cursor can only continue a directory or recursive listing\n`,
						exitCode: COMMAND_EXIT_USAGE,
					};
				}
				lines.push(
					format_ls_command_item({
						kind: entry.kind,
						updatedAt: entry.updatedAt,
						updatedBy: "updatedBy" in entry ? entry.updatedBy : undefined,
						contentType: entry.contentType,
						display: target.targetShellPath,
						long: parsed.long,
					}),
				);
			} else if (parsed.recursive) {
				const result = (await ctx.runQuery(internal.files_nodes.list_subtree_paginated, {
					workspaceId: workspaceFs.ctxData.workspaceId,
					projectId: workspaceFs.ctxData.projectId,
					path: appPath,
					numItems: parsed.limit,
					cursor: parsed.cursor,
					order: parsed.reverse ? "desc" : "asc",
				})) as files_nodes_list_subtree_paginated_Result;

				lines.push(
					...result.items.map((item) =>
						format_ls_command_item({
							kind: item.kind,
							updatedAt: item.updatedAt,
							updatedBy: item.updatedBy,
							contentType: item.contentType,
							display: app_path_to_shell_path(appFilesMountPath, item.path),
							long: parsed.long,
						}),
					),
				);
				if (!result.isDone) {
					if (lines.length === 0) {
						lines.push(PARTIAL_PAGE_NOTICE);
					}
					lines.push(
						"",
						build_ls_command_continuation({
							parsed,
							targetShellPath: target.targetShellPath,
							cursor: result.continueCursor,
						}),
					);
				}
			} else {
				const parentId = entry.nodeId;
				if (parentId == null) {
					return {
						stdout: "",
						stderr: `ls: cannot resolve '${target.targetShellPath}': No such file or directory\n`,
						exitCode: COMMAND_EXIT_FAILURE,
					};
				}
				const result = parsed.time
					? ((await ctx.runQuery(internal.files_nodes.list_dir_children_by_parent_recency_paginated, {
							workspaceId: workspaceFs.ctxData.workspaceId,
							projectId: workspaceFs.ctxData.projectId,
							parentId,
							numItems: parsed.limit,
							cursor: parsed.cursor,
							order: parsed.reverse ? "asc" : "desc",
						})) as files_nodes_list_dir_children_by_parent_recency_paginated_Result)
					: ((await ctx.runQuery(internal.files_nodes.list_dir_children_by_parent_paginated, {
							workspaceId: workspaceFs.ctxData.workspaceId,
							projectId: workspaceFs.ctxData.projectId,
							parentId,
							numItems: parsed.limit,
							cursor: parsed.cursor,
							order: parsed.reverse ? "desc" : "asc",
						})) as files_nodes_list_dir_children_by_parent_paginated_Result);

				lines.push(
					...result.items.map((item) =>
						format_ls_command_item({
							kind: item.kind,
							updatedAt: item.updatedAt,
							updatedBy: item.updatedBy,
							contentType: item.contentType,
							display: item.name,
							long: parsed.long,
						}),
					),
				);
				if (!result.isDone) {
					if (lines.length === 0) {
						lines.push(PARTIAL_PAGE_NOTICE);
					}
					lines.push(
						"",
						build_ls_command_continuation({
							parsed,
							targetShellPath: target.targetShellPath,
							cursor: result.continueCursor,
						}),
					);
				}
			}

			if (lines.length === 0) {
				lines.push("(empty directory)");
			}
			if (targets.length > 1 && entry.kind === "folder" && !parsed.directory) {
				lines.unshift(`${target.targetShellPath}:`);
			}
			sections.push(lines.join("\n"));
		}

		return {
			stdout: sections.length > 0 ? `${sections.join("\n\n")}\n` : "",
			stderr,
			exitCode: hasFailure ? 1 : 0,
		};
	});
}

// #endregion ls command

// #region find command

const FIND_COMMAND_EXTENSION_TOKEN_REGEX = /^[a-z0-9][a-z0-9_-]*$/iu;
const SIMPLE_PATH_WORD_GLOB_REGEX = /^\*+([a-z0-9][a-z0-9_-]*)\*+$/iu;
const SIMPLE_PATH_WORD_REGEX_GLOB_REGEX = /^\.\*([a-z0-9][a-z0-9_-]*)\.\*$/iu;

/**
 * Clean the extension value used by `find --extension`.
 *
 * `md` and `.md` both become `md`.
 *
 * Bad input returns a `_nay` with the text to print.
 */
function normalize_find_command_extension_value(extension: string) {
	const trimmed = extension.trim();

	// Let callers pass `md` or `.md`.
	const extensionWithoutDot = trimmed.startsWith(".") ? trimmed.slice(1) : trimmed;
	if (extensionWithoutDot === "") {
		return Result({ _nay: { message: "find: --extension requires a file extension" } });
	}

	// Keep this to one simple extension token, not a path or glob.
	if (!FIND_COMMAND_EXTENSION_TOKEN_REGEX.test(extensionWithoutDot)) {
		return Result({ _nay: { message: "find: --extension supports a simple extension token such as md, ts, or pdf" } });
	}

	// Match extensions without caring about letter case.
	return Result({ _yay: { extension: extensionWithoutDot.toLowerCase() } });
}

/**
 * Read simple "contains this word" glob or regex-shaped mistakes.
 *
 * Accepts forms like `*readme*` and `.*readme.*`.
 *
 * Returns `null` for real globs or regexes.
 */
function parse_simple_find_command_path_word_glob(pattern: string) {
	const trimmed = pattern.trim();

	// Treat `*readme*` as the plain path word `readme`.
	const globMatch = trimmed.match(SIMPLE_PATH_WORD_GLOB_REGEX);
	if (globMatch) {
		return globMatch[1]!.toLowerCase();
	}

	// Treat `.*readme.*` the same way, without accepting full regex syntax.
	const regexMatch = trimmed.match(SIMPLE_PATH_WORD_REGEX_GLOB_REGEX);
	return regexMatch?.[1]?.toLowerCase() ?? null;
}

/**
 * Build the agent-facing `Try:` line for path word search recovery.
 *
 * This points the model at the indexed `find --path-query` form when it used a
 * glob or regex-shaped path query that the app shell cannot run directly.
 */
function build_find_command_path_query_retry_hint(
	targetShellPath: string,
	args: { query: string; type?: string; maxDepth?: number; limit: number },
) {
	const parts = ["Try:", "find", shell_arg_quote(targetShellPath)];
	if (args.maxDepth != null) {
		parts.push("-maxdepth", String(args.maxDepth));
	}
	if (args.type != null) {
		parts.push("-type", args.type);
	}
	parts.push("--path-query", shell_arg_quote(args.query), "--limit", String(args.limit));
	return parts.join(" ");
}

function find_command_read_value(args: string[], index: number, option: string) {
	const value = args[index + 1];
	if (value == null) {
		return Result({ _nay: { message: `find: ${option} requires a value` } });
	}
	return Result({ _yay: { value, nextIndex: index + 1 } });
}

function parse_find_command_args(args: string[]) {
	let path: string | undefined;
	let pathPrefix: string | undefined;
	let limitValue: string | undefined;
	let cursor: string | null = null;
	let maxDepthValue: string | undefined;
	let minDepthValue: string | undefined;
	let type: string | undefined;
	let name: string | undefined;
	let iname: string | undefined;
	let pathQuery: string | undefined;
	let extension: string | undefined;

	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;

		if (arg === "--limit") {
			const value = find_command_read_value(args, index, "--limit");
			if (value._nay) return value;
			limitValue = value._yay.value;
			index = value._yay.nextIndex;
			continue;
		}
		if (arg.startsWith("--limit=")) {
			limitValue = arg.slice("--limit=".length);
			continue;
		}
		if (arg === "--cursor") {
			const value = find_command_read_value(args, index, "--cursor");
			if (value._nay) return value;
			cursor = value._yay.value;
			index = value._yay.nextIndex;
			continue;
		}
		if (arg.startsWith("--cursor=")) {
			cursor = arg.slice("--cursor=".length);
			continue;
		}
		if (arg === "--prefix") {
			const value = find_command_read_value(args, index, "--prefix");
			if (value._nay) return value;
			pathPrefix = value._yay.value;
			index = value._yay.nextIndex;
			continue;
		}
		if (arg.startsWith("--prefix=")) {
			pathPrefix = arg.slice("--prefix=".length);
			continue;
		}
		if (arg === "-maxdepth" || arg === "--maxdepth") {
			const value = find_command_read_value(args, index, arg);
			if (value._nay) return value;
			maxDepthValue = value._yay.value;
			index = value._yay.nextIndex;
			continue;
		}
		if (arg === "-mindepth" || arg === "--mindepth") {
			const value = find_command_read_value(args, index, arg);
			if (value._nay) return value;
			minDepthValue = value._yay.value;
			index = value._yay.nextIndex;
			continue;
		}
		if (arg === "-print") {
			// Printing is already the default action; accept it as a no-op for compatibility.
			continue;
		}
		if (arg === "-type" || arg === "--type") {
			const value = find_command_read_value(args, index, arg);
			if (value._nay) return value;
			type = value._yay.value;
			index = value._yay.nextIndex;
			continue;
		}
		if (arg === "-name" || arg === "--name") {
			const value = find_command_read_value(args, index, arg);
			if (value._nay) return value;
			name = value._yay.value;
			index = value._yay.nextIndex;
			continue;
		}
		if (arg === "-iname" || arg === "--iname") {
			const value = find_command_read_value(args, index, arg);
			if (value._nay) return value;
			iname = value._yay.value;
			index = value._yay.nextIndex;
			continue;
		}
		if (arg === "--path-query") {
			const value = find_command_read_value(args, index, arg);
			if (value._nay) return value;
			pathQuery = value._yay.value;
			index = value._yay.nextIndex;
			continue;
		}
		if (arg.startsWith("--path-query=")) {
			pathQuery = arg.slice("--path-query=".length);
			continue;
		}
		if (arg === "--extension") {
			const value = find_command_read_value(args, index, arg);
			if (value._nay) return value;
			extension = value._yay.value;
			index = value._yay.nextIndex;
			continue;
		}
		if (arg.startsWith("--extension=")) {
			extension = arg.slice("--extension=".length);
			continue;
		}
		if (arg.startsWith("-") || arg === "!" || arg === "(" || arg === ")") {
			return Result({
				_nay: {
					message: `find: unsupported predicate ${arg} (GNU find extensions like -printf, -mtime, -newer, -exec, -ok are not available for app files; omit them and use -name QUERY, --path-query QUERY, -type f|d, -maxdepth N, or -mindepth N instead)`,
				},
			});
		}
		const simpleExtensionGlob = parse_simple_find_command_extension_glob(arg);
		if (simpleExtensionGlob) {
			if (path != null) {
				return Result({ _nay: { message: "find: app file find supports one path only" } });
			}
			if (extension != null) {
				const normalizedExtension = normalize_find_command_extension_value(extension);
				if (normalizedExtension._nay) return normalizedExtension;
				if (normalizedExtension._yay.extension !== simpleExtensionGlob.extension) {
					return Result({ _nay: { message: "find: simple extension glob conflicts with --extension" } });
				}
			}
			path = simpleExtensionGlob.path;
			extension = simpleExtensionGlob.extension;
			continue;
		}
		if (path != null) {
			return Result({ _nay: { message: "find: app file find supports one path only" } });
		}
		path = arg;
	}

	if (pathPrefix != null && path != null) {
		return Result({ _nay: { message: "find: --prefix cannot be combined with PATH" } });
	}

	const limit = parse_listing_limit("find", limitValue);
	if (limit._nay) {
		return limit;
	}

	let maxDepth: number | null = null;
	if (maxDepthValue != null) {
		if (!/^\d+$/u.test(maxDepthValue.trim())) {
			return Result({ _nay: { message: "find: -maxdepth must be a non-negative integer" } });
		}
		maxDepth = Number(maxDepthValue);
	}

	let minDepth: number | null = null;
	if (minDepthValue != null) {
		if (!/^\d+$/u.test(minDepthValue.trim())) {
			return Result({ _nay: { message: "find: -mindepth must be a non-negative integer" } });
		}
		minDepth = Number(minDepthValue);
	}

	if (pathPrefix != null && (maxDepth != null || minDepth != null)) {
		// --prefix is a raw startsWith token, not an ancestor folder, so depth measured
		// from the prefix string is meaningless. Reject rather than silently mis-filter.
		return Result({
			_nay: {
				message:
					"find: --prefix cannot be combined with -maxdepth/-mindepth (depth is undefined for a prefix; drop the depth flags or use a folder PATH instead)",
			},
		});
	}

	if (type != null && type !== "f" && type !== "d") {
		return Result({ _nay: { message: "find: -type supports only f or d for app files" } });
	}

	let normalizedExtension: string | undefined;
	if (extension != null) {
		const normalized = normalize_find_command_extension_value(extension);
		if (normalized._nay) return normalized;
		normalizedExtension = normalized._yay.extension;
	}

	const simpleNameExtension =
		name != null || iname != null ? parse_simple_find_command_extension_glob((name ?? iname)!.trim()) : null;
	if (simpleNameExtension) {
		if (simpleNameExtension.path != null) {
			return Result({ _nay: { message: "find: -name/-iname simple extension globs must not include a path" } });
		}
		if (normalizedExtension != null && normalizedExtension !== simpleNameExtension.extension) {
			return Result({ _nay: { message: "find: -name/-iname simple extension glob conflicts with --extension" } });
		}
		normalizedExtension = simpleNameExtension.extension;
		name = undefined;
		iname = undefined;
	}

	const pathQueries = [name, iname, pathQuery].filter((value): value is string => value != null);
	if (pathQueries.length > 1) {
		return Result({ _nay: { message: "find: use only one of -name, -iname, or --path-query" } });
	}
	const normalizedPathQuery = pathQueries.at(0)?.trim();
	if (normalizedPathQuery === "") {
		return Result({ _nay: { message: "find: path search requires a non-empty query" } });
	}
	if (
		(name != null || iname != null) &&
		normalizedPathQuery != null &&
		GLOB_METACHARACTER_REGEX.test(normalizedPathQuery)
	) {
		const simplePathWordGlob = parse_simple_find_command_path_word_glob(normalizedPathQuery);
		return Result({
			_nay: {
				message:
					"find: -name/-iname use DB-backed path word search for app files, not glob patterns. Try `find <dir> -type f --extension md --limit 20` for simple extension searches, or use words like `readme`.",
				...(simplePathWordGlob == null
					? {}
					: {
							data: {
								tryPathQuery: {
									query: simplePathWordGlob,
									...(type == null ? {} : { type }),
									limit: limit._yay.limit,
								},
							},
						}),
			},
		});
	}
	if (pathQuery != null && normalizedPathQuery != null && GLOB_METACHARACTER_REGEX.test(normalizedPathQuery)) {
		const simplePathWordGlob = parse_simple_find_command_path_word_glob(normalizedPathQuery);
		return Result({
			_nay: {
				message:
					"find: --path-query uses DB-backed path word search, not regex/glob patterns. Use plain tokens like `readme`.",
				...(simplePathWordGlob == null
					? {}
					: {
							data: {
								tryPathQuery: {
									query: simplePathWordGlob,
									...(type == null ? {} : { type }),
									limit: limit._yay.limit,
								},
							},
						}),
			},
		});
	}

	return Result({
		_yay: {
			path,
			pathPrefix,
			limit: limit._yay.limit,
			cursor,
			hasAppListingOption: limitValue != null || cursor != null,
			maxDepth,
			minDepth,
			type,
			name,
			iname,
			pathQuery: pathQuery == null ? undefined : normalizedPathQuery,
			pathSearchQuery: normalizedPathQuery,
			extension: normalizedExtension,
		} as const,
	});
}

function command_path_to_app_path(commandCtx: CommandContext, appFilesMountPath: string, path: string) {
	return shell_path_to_app_path(appFilesMountPath, resolve_path(commandCtx.cwd, path));
}

function find_command_prefix_to_app_path(commandCtx: CommandContext, appFilesMountPath: string, pathPrefix: string) {
	if (GLOB_METACHARACTER_REGEX.test(pathPrefix)) {
		return Result({ _nay: { message: app_glob_syntax_unsupported_message("find", pathPrefix) } });
	}
	if (pathPrefix === "/" || pathPrefix.startsWith("/") || pathPrefix.startsWith("~/")) {
		const shellPath = pathPrefix.startsWith("~/")
			? normalize_path(`${HOME}/${pathPrefix.slice(2)}`)
			: normalize_path(pathPrefix);
		const mountedAppPath = shell_path_to_app_path(appFilesMountPath, shellPath);
		return Result({ _yay: { appPath: mountedAppPath ?? normalize_path(pathPrefix) } });
	}

	const cwd = normalize_path(commandCtx.cwd);
	if (is_path_under_app_mount(appFilesMountPath, cwd)) {
		return Result({
			_yay: {
				appPath: command_path_to_app_path(commandCtx, appFilesMountPath, pathPrefix) ?? normalize_path(pathPrefix),
			},
		});
	}
	return Result({ _yay: { appPath: normalize_path(pathPrefix) } });
}

function find_command_create(ctx: ActionCtx, ctxData: WorkspaceFsOptions["ctxData"], appFilesMountPath: string) {
	return defineCommand("find", async (args, commandCtx) => {
		const parsedResult = parse_find_command_args(args);
		if (parsedResult._nay) {
			const errorData = parsedResult._nay.data as
				| { tryPathQuery?: { query: string; type?: string; limit: number } }
				| undefined;
			const tryPathQuery = errorData?.tryPathQuery ?? null;
			const tryLine =
				tryPathQuery == null ? "" : `${build_find_command_path_query_retry_hint(appFilesMountPath, tryPathQuery)}\n`;
			return {
				stdout: "",
				stderr:
					`${parsedResult._nay.message}\n` +
					tryLine +
					"Usage: find [PATH] [--prefix PREFIX] [-maxdepth N] [-mindepth N] [-type f|d] [-name QUERY|-iname QUERY|--path-query QUERY|--extension EXT] [--limit N] [--cursor CURSOR]\n",
				exitCode: 2,
			};
		}
		const parsed = parsedResult._yay;

		if (parsed.pathPrefix != null) {
			if (parsed.extension != null) {
				return {
					stdout: "",
					stderr: (
						"find: --prefix cannot be combined with --extension for app files.\n" +
						"Try: find <folder> -type f --extension " +
						shell_arg_quote(parsed.extension) +
						" --limit " +
						String(parsed.limit) +
						"\n"
					),
					exitCode: COMMAND_EXIT_USAGE,
				};
			}
			if (parsed.pathSearchQuery != null) {
				return {
					stdout: "",
					stderr: (
						"find: --prefix cannot be combined with path word search for app files.\n" +
						"Use `find --prefix PREFIX` for exact starts-with path discovery, or `find -name QUERY` for DB-backed path word search.\n"
					),
					exitCode: COMMAND_EXIT_USAGE,
				};
			}
			const prefixResult = find_command_prefix_to_app_path(commandCtx, appFilesMountPath, parsed.pathPrefix);
			if (prefixResult._nay) {
				return {
					stdout: "",
					stderr: prefixResult._nay.message,
					exitCode: COMMAND_EXIT_USAGE,
				};
			}
			const prefix = prefixResult._yay;
			const result = (await ctx.runQuery(internal.files_nodes.list_path_prefix_paginated, {
				workspaceId: ctxData.workspaceId,
				projectId: ctxData.projectId,
				pathPrefix: prefix.appPath,
				numItems: parsed.limit,
				cursor: parsed.cursor,
				...(parsed.type === "f" ? { kind: "file" as const } : parsed.type === "d" ? { kind: "folder" as const } : {}),
			})) as files_nodes_list_path_prefix_paginated_Result;

			const lines = result.items.map(
				(item) => `${app_path_to_shell_path(appFilesMountPath, item.path)}${item.kind === "folder" ? "/" : ""}`,
			);
			if (!result.isDone) {
				if (lines.length === 0) {
					lines.push(PARTIAL_PAGE_NOTICE);
				}
				lines.push(
					"",
					build_find_command_continuation({
						parsed,
						target: null,
						prefix: app_path_to_shell_path(appFilesMountPath, prefix.appPath),
						cursor: result.continueCursor,
					}),
				);
			} else if (lines.length === 0) {
				lines.push("0 matches.");
			}

			return {
				stdout: `${lines.join("\n")}\n`,
				stderr: "",
				exitCode: 0,
			};
		}

		const targetShellPath = resolve_path(
			commandCtx.cwd,
			parsed.path ?? default_app_target_shell_path(commandCtx.cwd, appFilesMountPath),
		);
		const appPath = shell_path_to_app_path(appFilesMountPath, targetShellPath);
		if (appPath == null) {
			if (parsed.hasAppListingOption) {
				return {
					stdout: "",
					stderr: (
						"find: --limit and --cursor are only available for app file paths\n" +
						`Omit PATH to search the app root, or use ${appFilesMountPath} explicitly. Use plain find for /tmp.\n`
					),
					exitCode: COMMAND_EXIT_USAGE,
				};
			}
			return await delegate_builtin_command("find", args, commandCtx);
		}
		if (parsed.path != null && GLOB_METACHARACTER_REGEX.test(parsed.path)) {
			return {
				stdout: "",
				stderr: app_glob_syntax_unsupported_message("find", parsed.path),
				exitCode: COMMAND_EXIT_USAGE,
			};
		}

		const entry = await get_bash_path_entry(ctx, ctxData, appPath);
		if (!entry) {
			return {
				stdout: "",
				stderr: (
					`find: ${targetShellPath}: No such file or directory\n` +
					`If you intended a path prefix search (paths whose names START WITH this string), run:\n` +
					`  find --prefix ${shell_arg_quote(targetShellPath)} --limit ${parsed.limit}\n`
				),
				exitCode: COMMAND_EXIT_FAILURE,
			};
		}

		if (parsed.pathSearchQuery != null) {
			if (parsed.extension != null) {
				return {
					stdout: "",
					stderr: (
						"find: path word search cannot be combined with --extension for app files.\n" +
						"Try either `find -name readme --limit " +
						String(parsed.limit) +
						"` or `find <folder> -type f --extension " +
						shell_arg_quote(parsed.extension) +
						" --limit " +
						String(parsed.limit) +
						"`.\n"
					),
					exitCode: COMMAND_EXIT_USAGE,
				};
			}
			let parentId: Id<"files_nodes"> | typeof FILES_ROOT_ID | undefined;
			if (appPath === "/") {
				if (parsed.maxDepth != null && parsed.maxDepth !== 1) {
					return {
						stdout: "",
						stderr: (
							"find: path word search supports project-wide results or immediate children with -maxdepth 1.\n" +
							`${build_find_command_path_query_retry_hint(targetShellPath, {
							query: parsed.pathSearchQuery,
							...(parsed.type == null ? {} : { type: parsed.type }),
							limit: parsed.limit,
							})}\n`
						),
						exitCode: COMMAND_EXIT_USAGE,
					};
				}
				if (parsed.minDepth != null && parsed.minDepth !== 1) {
					return {
						stdout: "",
						stderr: "find: path word search with -mindepth supports only -mindepth 1.\n",
						exitCode: COMMAND_EXIT_USAGE,
					};
				}
				if (parsed.maxDepth === 1) {
					parentId = FILES_ROOT_ID;
				}
			} else {
				if (entry.kind !== "folder") {
					return {
						stdout: "",
						stderr: "find: path word search can target the project root or an immediate folder.\n",
						exitCode: COMMAND_EXIT_USAGE,
					};
				}
				if (parsed.maxDepth !== 1) {
					return {
						stdout: "",
						stderr: (
							"find: scoped path word search supports immediate children only. Add -maxdepth 1, or omit PATH for project-wide search.\n" +
							`${build_find_command_path_query_retry_hint(targetShellPath, {
							query: parsed.pathSearchQuery,
							...(parsed.type == null ? {} : { type: parsed.type }),
							maxDepth: 1,
							limit: parsed.limit,
							})}\n`
						),
						exitCode: COMMAND_EXIT_USAGE,
					};
				}
				if (parsed.minDepth != null && parsed.minDepth !== 1) {
					return {
						stdout: "",
						stderr: "find: scoped path word search with -mindepth supports only -mindepth 1.\n",
						exitCode: COMMAND_EXIT_USAGE,
					};
				}
				if (entry.nodeId == null) {
					return {
						stdout: "",
						stderr: `find: cannot resolve '${targetShellPath}': No such file or directory\n`,
						exitCode: COMMAND_EXIT_FAILURE,
					};
				}
				parentId = entry.nodeId;
			}

			const result = (await ctx.runQuery(internal.files_nodes.search_paths_paginated, {
				workspaceId: ctxData.workspaceId,
				projectId: ctxData.projectId,
				pathQuery: parsed.pathSearchQuery,
				numItems: parsed.limit,
				cursor: parsed.cursor,
				...(parsed.type === "f" ? { kind: "file" as const } : parsed.type === "d" ? { kind: "folder" as const } : {}),
				...(parentId == null ? {} : { parentId }),
			})) as files_nodes_search_paths_paginated_Result;

			const lines = result.items.map(
				(item) => `${app_path_to_shell_path(appFilesMountPath, item.path)}${item.kind === "folder" ? "/" : ""}`,
			);
			if (!result.isDone) {
				lines.push(
					"",
					build_find_command_continuation({
						parsed,
						target: targetShellPath,
						prefix: null,
						cursor: result.continueCursor,
					}),
				);
			} else if (lines.length === 0) {
				lines.push("0 matches.");
			}

			return {
				stdout: `${lines.join("\n")}\n`,
				stderr: "",
				exitCode: 0,
			};
		}

		if (parsed.extension != null) {
			if (parsed.type === "d") {
				return {
					stdout: "0 matches.\n",
					stderr: "",
					exitCode: 0,
				};
			}

			const result = (await ctx.runQuery(internal.files_nodes.list_subtree_by_extension_paginated, {
				workspaceId: ctxData.workspaceId,
				projectId: ctxData.projectId,
				path: appPath,
				lowercaseExtension: parsed.extension,
				numItems: parsed.limit,
				cursor: parsed.cursor,
				...(parsed.minDepth == null ? {} : { minDepth: parsed.minDepth }),
				...(parsed.maxDepth == null ? {} : { maxDepth: parsed.maxDepth }),
			})) as files_nodes_list_subtree_by_extension_paginated_Result;

			const lines = result.items.map((item) => app_path_to_shell_path(appFilesMountPath, item.path));
			if (!result.isDone) {
				if (lines.length === 0) {
					lines.push(PARTIAL_PAGE_NOTICE);
				}
				lines.push(
					"",
					build_find_command_continuation({
						parsed,
						target: targetShellPath,
						prefix: null,
						cursor: result.continueCursor,
					}),
				);
			} else if (lines.length === 0) {
				lines.push("0 matches.");
			}

			return {
				stdout: `${lines.join("\n")}\n`,
				stderr: "",
				exitCode: 0,
			};
		}

		const result = (await ctx.runQuery(internal.files_nodes.list_subtree_paginated, {
			workspaceId: ctxData.workspaceId,
			projectId: ctxData.projectId,
			path: appPath,
			numItems: parsed.limit,
			cursor: parsed.cursor,
			...(parsed.type === "f" ? { kind: "file" as const } : parsed.type === "d" ? { kind: "folder" as const } : {}),
			...(parsed.minDepth == null ? {} : { minDepth: parsed.minDepth }),
			...(parsed.maxDepth == null ? {} : { maxDepth: parsed.maxDepth }),
		})) as files_nodes_list_subtree_paginated_Result;

		const lines = result.items.map(
			(item) => `${app_path_to_shell_path(appFilesMountPath, item.path)}${item.kind === "folder" ? "/" : ""}`,
		);

		if (!result.isDone) {
			if (lines.length === 0) {
				lines.push(PARTIAL_PAGE_NOTICE);
			}
			lines.push(
				"",
				build_find_command_continuation({
					parsed,
					target: targetShellPath,
					prefix: null,
					cursor: result.continueCursor,
				}),
			);
		} else if (lines.length === 0) {
			lines.push("0 matches.");
		}

		return {
			stdout: `${lines.join("\n")}\n`,
			stderr: "",
			exitCode: 0,
		};
	});
}

function build_find_command_continuation(args: {
	parsed: NonNullable<ReturnType<typeof parse_find_command_args>["_yay"]>;
	target: string | null;
	prefix: string | null;
	cursor: string;
}) {
	const continuationParts = ["Next page:", "find"];
	if (args.prefix != null) {
		continuationParts.push("--prefix", shell_arg_quote(args.prefix));
	} else if (args.target != null) {
		continuationParts.push(shell_arg_quote(args.target));
	}
	// Depth flags are invalid with --prefix (rejected at parse time); never emit them there.
	if (args.prefix == null && args.parsed.maxDepth != null) {
		continuationParts.push("-maxdepth", String(args.parsed.maxDepth));
	}
	if (args.prefix == null && args.parsed.minDepth != null) {
		continuationParts.push("-mindepth", String(args.parsed.minDepth));
	}
	if (args.parsed.type != null) {
		continuationParts.push("-type", args.parsed.type);
	}
	if (args.parsed.name != null) {
		continuationParts.push("-name", shell_arg_quote(args.parsed.name));
	}
	if (args.parsed.iname != null) {
		continuationParts.push("-iname", shell_arg_quote(args.parsed.iname));
	}
	if (args.parsed.pathQuery != null) {
		continuationParts.push("--path-query", shell_arg_quote(args.parsed.pathQuery));
	}
	if (args.parsed.extension != null) {
		continuationParts.push("--extension", shell_arg_quote(args.parsed.extension));
	}
	continuationParts.push("--limit", String(args.parsed.limit), "--cursor", shell_arg_quote(args.cursor));
	return continuationParts.join(" ");
}

// #endregion find command

// #region tree command

function tree_command_read_value(args: string[], index: number, option: string) {
	const value = args[index + 1];
	if (value == null) {
		return Result({ _nay: { message: `tree: ${option} requires a value` } });
	}
	return Result({ _yay: { value, nextIndex: index + 1 } });
}

function parse_tree_command_args(args: string[]) {
	let path: string | undefined;
	let limitValue: string | undefined;
	let cursor: string | null = null;
	let unsupportedOption: string | null = null;
	const valueFlags = new Set(["-L", "-P", "-I", "--filelimit", "-o"]);

	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		if (arg === "--limit") {
			const value = tree_command_read_value(args, index, "--limit");
			if (value._nay) return value;
			limitValue = value._yay.value;
			index = value._yay.nextIndex;
			continue;
		}
		if (arg.startsWith("--limit=")) {
			limitValue = arg.slice("--limit=".length);
			continue;
		}
		if (arg === "--cursor") {
			const value = tree_command_read_value(args, index, "--cursor");
			if (value._nay) return value;
			cursor = value._yay.value;
			index = value._yay.nextIndex;
			continue;
		}
		if (arg.startsWith("--cursor=")) {
			cursor = arg.slice("--cursor=".length);
			continue;
		}
		if (valueFlags.has(arg)) {
			unsupportedOption ??= arg;
			index++;
			continue;
		}
		if (arg.startsWith("-")) {
			unsupportedOption ??= arg;
			continue;
		}
		if (path != null) {
			return Result({ _nay: { message: "tree: app file tree supports one path only" } });
		}
		path = arg;
	}

	const limit = parse_listing_limit("tree", limitValue);
	if (limit._nay) {
		return limit;
	}

	return Result({
		_yay: {
			path,
			limit: limit._yay.limit,
			cursor,
			unsupportedOption,
			hasAppListingOption: limitValue != null || cursor != null,
		} as const,
	});
}

/**
 * Return the path segments from a tree root to an item path.
 *
 * Both paths must already be normalized by the command boundary.
 */
function tree_command_relative_segments(basePath: string, itemPath: string) {
	if (itemPath === basePath) {
		return [];
	}
	const suffix = basePath === "/" ? itemPath.slice(1) : itemPath.slice(basePath.length + 1);
	return suffix.split("/").filter(Boolean);
}

function build_tree_command_continuation(args: { target: string; limit: number; cursor: string }) {
	return [
		"Next page:",
		"tree",
		shell_arg_quote(args.target),
		"--limit",
		String(args.limit),
		"--cursor",
		shell_arg_quote(args.cursor),
	].join(" ");
}

function create_tree_command(ctx: ActionCtx, ctxData: WorkspaceFsOptions["ctxData"], appFilesMountPath: string) {
	return defineCommand("tree", async (args, commandCtx) => {
		const parsedResult = parse_tree_command_args(args);
		if (parsedResult._nay) {
			return {
				stdout: "",
				stderr: `${parsedResult._nay.message}\nUsage: tree [PATH] [--limit N] [--cursor CURSOR]\n`,
				exitCode: COMMAND_EXIT_USAGE,
			};
		}
		const parsed = parsedResult._yay;
		const targetShellPath = resolve_path(
			commandCtx.cwd,
			parsed.path ?? default_app_target_shell_path(commandCtx.cwd, appFilesMountPath),
		);
		if (!is_path_under_app_mount(appFilesMountPath, targetShellPath)) {
			if (parsed.hasAppListingOption) {
				const suggestedTarget =
					parsed.path != null && parsed.path.startsWith("/")
						? `${appFilesMountPath}${normalize_path(parsed.path) === "/" ? "" : normalize_path(parsed.path)}`
						: `${appFilesMountPath}/${parsed.path ?? ""}`.replace(/\/+$/u, "");
				return {
					stdout: "",
					stderr: (
						`tree: --limit and --cursor are app-file pagination flags, but ${targetShellPath} is outside the app mount ${appFilesMountPath}\n` +
						`Try: tree ${shell_arg_quote(suggestedTarget)} --limit ${parsed.limit}\n`
					),
					exitCode: COMMAND_EXIT_USAGE,
				};
			}
			return await delegate_builtin_command("tree", args, commandCtx);
		}
		if (parsed.unsupportedOption != null) {
			return {
				stdout: "",
				stderr: (
					`tree: unsupported option ${parsed.unsupportedOption} for app files\n` +
					"Usage: tree [PATH] [--limit N] [--cursor CURSOR]\n"
				),
				exitCode: COMMAND_EXIT_USAGE,
			};
		}
		if (parsed.path != null && GLOB_METACHARACTER_REGEX.test(parsed.path)) {
			return {
				stdout: "",
				stderr: app_glob_syntax_unsupported_message("tree", parsed.path),
				exitCode: COMMAND_EXIT_USAGE,
			};
		}

		const appPath = shell_path_to_app_path(appFilesMountPath, targetShellPath);
		if (appPath == null) {
			return {
				stdout: "",
				stderr: `tree: app path expected under ${appFilesMountPath}\n`,
				exitCode: COMMAND_EXIT_USAGE,
			};
		}
		const entry = await get_bash_path_entry(ctx, ctxData, appPath);
		if (!entry) {
			return {
				stdout: "",
				stderr: `tree: ${targetShellPath}: No such file or directory\n`,
				exitCode: COMMAND_EXIT_FAILURE,
			};
		}

		const result = (await ctx.runQuery(internal.files_nodes.list_subtree_paginated, {
			workspaceId: ctxData.workspaceId,
			projectId: ctxData.projectId,
			path: appPath,
			numItems: parsed.limit,
			cursor: parsed.cursor,
		})) as files_nodes_list_subtree_paginated_Result;

		const lines = [targetShellPath];
		for (const item of result.items) {
			const segments = tree_command_relative_segments(appPath, item.path);
			if (segments.length === 0) {
				continue;
			}
			const prefix = segments.length === 1 ? "|-- " : `${"|   ".repeat(segments.length - 1)}|-- `;
			lines.push(`${prefix}${segments.at(-1)}${item.kind === "folder" ? "/" : ""}`);
		}
		if (!result.isDone) {
			lines.push(
				"",
				build_tree_command_continuation({
					target: targetShellPath,
					limit: parsed.limit,
					cursor: result.continueCursor,
				}),
			);
		}

		return {
			stdout: `${lines.join("\n")}\n`,
			stderr: "",
			exitCode: 0,
		};
	});
}

// #endregion tree command

// #region grep command

const GREP_SUBSTRING_ONLY_WARNING =
	"grep: app-file grep is substring-only; regex metacharacters are matched literally. Use search for indexed content search.\n";

function has_unescaped_grep_command_regex_metacharacter(pattern: string) {
	let escaped = false;
	for (const char of pattern) {
		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (char === "^" || char === "$" || char === "." || char === "*" || char === "[" || char === "]") {
			return true;
		}
	}
	return false;
}

function create_grep_command(ctx: ActionCtx, ctxData: WorkspaceFsOptions["ctxData"], appFilesMountPath: string) {
	return defineCommand("grep", async (args, commandCtx) => {
		// Single APP-file grep is supported via a bounded chunk scan (substring, -i), with -c/-l/-v and
		// -A/-B/-C context handled too. Everything else — workspace-wide, recursive, multiple files,
		// /tmp, regex/-e OR-sets, -m, or unknown flags — keeps the indexed-search guidance.
		const valueOptions = new Set(["-e", "--regexp", "-m", "--max-count", "-f", "--file"]);
		const noopFlags = new Set([
			"-n",
			"--line-number",
			"-H",
			"--with-filename",
			"-h",
			"--no-filename",
			"-F",
			"--fixed-strings",
			"-s",
			"-I",
			"--color",
			"--color=auto",
			"--color=always",
			"--color=never",
		]);
		let pattern: string | undefined;
		let ignoreCase = false;
		let recursive = false;
		let invert = false;
		let countOnly = false;
		let listOnly = false;
		let before = 0;
		let after = 0;
		let complexFlag = false;
		let unsupportedFlag: string | null = null;
		const operands: string[] = [];
		// A context value (-A/-B/-C N) must be a non-negative integer; anything else falls back.
		const parseContextValue = (raw: string | undefined): number | null => {
			if (raw == null) return null;
			const value = Number(raw);
			return Number.isInteger(value) && value >= 0 ? value : null;
		};
		for (let index = 0; index < args.length; index++) {
			const arg = args[index]!;
			if (arg === "-e" || arg === "--regexp") {
				const value = args[++index];
				// A second pattern (multiple -e) is real-grep OR-semantics we don't reproduce → fall back.
				if (pattern !== undefined) complexFlag = true;
				else if (value != null) pattern = value;
				continue;
			}
			if (arg.startsWith("--regexp=")) {
				if (pattern !== undefined) complexFlag = true;
				else pattern = arg.slice("--regexp=".length);
				continue;
			}
			if (arg === "-i" || arg === "--ignore-case") {
				ignoreCase = true;
				continue;
			}
			if (arg === "-r" || arg === "-R" || arg === "--recursive") {
				recursive = true;
				continue;
			}
			if (arg === "-v" || arg === "--invert-match") {
				invert = true;
				continue;
			}
			if (arg === "-c" || arg === "--count") {
				countOnly = true;
				continue;
			}
			if (arg === "-l" || arg === "--files-with-matches") {
				listOnly = true;
				continue;
			}
			// Context flags: -A/-B/-C with a separate value, the attached short form (-A3), or --x=N.
			if (arg === "-A" || arg === "--after-context") {
				const value = parseContextValue(args[++index]);
				if (value == null) complexFlag = true;
				else after = value;
				continue;
			}
			if (arg === "-B" || arg === "--before-context") {
				const value = parseContextValue(args[++index]);
				if (value == null) complexFlag = true;
				else before = value;
				continue;
			}
			if (arg === "-C" || arg === "--context") {
				const value = parseContextValue(args[++index]);
				if (value == null) complexFlag = true;
				else before = after = value;
				continue;
			}
			const attachedContext = /^-([ABC])(\d+)$/u.exec(arg);
			if (attachedContext) {
				const value = Number(attachedContext[2]);
				if (attachedContext[1] === "A") after = value;
				else if (attachedContext[1] === "B") before = value;
				else before = after = value;
				continue;
			}
			const longContext = /^--(after-context|before-context|context)=(\d+)$/u.exec(arg);
			if (longContext) {
				const value = Number(longContext[2]);
				if (longContext[1] === "after-context") after = value;
				else if (longContext[1] === "before-context") before = value;
				else before = after = value;
				continue;
			}
			// Combined short flags like -in (= -i -n) or -ivc. Split and apply each; only boolean
			// i/v/c/l/n/H/h/s/I (and r/R) are safe — any value/unknown char falls back to guidance.
			if (/^-[a-zA-Z]{2,}$/u.test(arg)) {
				for (const ch of arg.slice(1)) {
					if (ch === "i") ignoreCase = true;
					else if (ch === "r" || ch === "R") recursive = true;
					else if (ch === "v") invert = true;
					else if (ch === "c") countOnly = true;
					else if (ch === "l") listOnly = true;
					else if (ch === "n" || ch === "H" || ch === "h" || ch === "s" || ch === "I") {
						// display/no-op flag
					} else {
						complexFlag = true;
						unsupportedFlag ??= `-${ch}`;
					}
				}
				continue;
			}
			if (valueOptions.has(arg)) {
				index++; // consume the value
				complexFlag = true; // output/semantics we don't reproduce on the fast path
				continue;
			}
			if (noopFlags.has(arg)) continue;
			if (arg.startsWith("-") && arg !== "-") {
				complexFlag = true; // unknown / semantics-changing flag (-w, -o, -x, -P, ...)
				unsupportedFlag ??= arg;
				continue;
			}
			if (pattern === undefined) pattern = arg;
			else operands.push(arg);
		}

		const isSingleAppFile =
			operands.length === 1 &&
			operands[0] !== "-" &&
			shell_path_to_app_path(appFilesMountPath, resolve_path(commandCtx.cwd, operands[0]!)) != null;
		if (pattern != null && pattern.length > 0 && !recursive && !complexFlag && isSingleAppFile) {
			const fileArg = operands[0]!;
			if (GLOB_METACHARACTER_REGEX.test(fileArg)) {
				return {
					stdout: "",
					stderr: app_glob_syntax_unsupported_message("grep", fileArg),
					exitCode: COMMAND_EXIT_USAGE,
				};
			}
			const appPath = shell_path_to_app_path(appFilesMountPath, resolve_path(commandCtx.cwd, fileArg))!;
			const regexWarning = has_unescaped_grep_command_regex_metacharacter(pattern) ? GREP_SUBSTRING_ONLY_WARNING : "";

			// Context (-A/-B/-C) and inverted selection (-v) need lines OTHER than the matches → the
			// windowed scan path. Plain matching, and -c/-l without -v, only need the match set → the
			// cheaper match-only chunk scan. (-c/-l override context output, so context alone there
			// still takes the match path.)
			const needsScan = invert || (!countOnly && !listOnly && (before > 0 || after > 0));
			if (needsScan) {
				const result = (await ctx.runAction(internal.files_nodes.grep_app_file_scan, {
					workspaceId: ctxData.workspaceId,
					projectId: ctxData.projectId,
					userId: ctxData.userId,
					path: appPath,
					pattern,
					ignoreCase,
					invert,
					before,
					after,
				})) as files_nodes_grep_app_file_scan_Result;
				if (!result) {
					return {
						stdout: "",
						stderr: `grep: ${fileArg}: No such file or directory\n`,
						exitCode: COMMAND_EXIT_FAILURE,
					};
				}
				if (listOnly) {
					if (result.selectedCount > 0) return { stdout: `${fileArg}\n`, stderr: regexWarning, exitCode: 0 };
					const stderr = result.scanTruncated
						? "[grep: scanned only a bounded portion of a large file; matches may exist beyond it]\n"
						: "";
					return { stdout: "", stderr: `${regexWarning}${stderr}`, exitCode: 1 };
				}
				if (countOnly) {
					const stderr = result.scanTruncated
						? "[grep: scanned only a bounded portion of a large file; count is a lower bound]\n"
						: "";
					return {
						stdout: `${result.selectedCount}\n`,
						stderr: `${regexWarning}${stderr}`,
						exitCode: result.selectedCount > 0 ? 0 : 1,
					};
				}
				if (result.lines.length === 0) {
					const note = result.scanTruncated
						? "[grep: scanned only a bounded portion of a large file; matches may exist beyond it]\n"
						: "";
					return { stdout: "", stderr: `${regexWarning}${note}`, exitCode: 1 };
				}
				// Render matched lines with a ":" separator and context lines with "-" (real grep -n
				// style), inserting "--" between non-contiguous groups.
				const pieces: string[] = [];
				let prevLineNumber: number | null = null;
				for (const entry of result.lines) {
					if (prevLineNumber !== null && entry.lineNumber > prevLineNumber + 1) pieces.push("--");
					pieces.push(`${entry.lineNumber}${entry.matched ? ":" : "-"}${entry.line}`);
					prevLineNumber = entry.lineNumber;
				}
				const stdout = `${pieces.join("\n")}\n`;
				let stderr = regexWarning;
				if (result.scanTruncated) {
					stderr += "[grep: scanned only a bounded portion of a large file; more may exist]\n";
				}
				return { stdout, stderr, exitCode: 0 };
			}

			const result = (await ctx.runAction(internal.files_nodes.grep_app_file, {
				workspaceId: ctxData.workspaceId,
				projectId: ctxData.projectId,
				userId: ctxData.userId,
				path: appPath,
				pattern,
				ignoreCase,
			})) as files_nodes_grep_app_file_Result;
			if (!result) {
				return {
					stdout: "",
					stderr: `grep: ${fileArg}: No such file or directory\n`,
					exitCode: COMMAND_EXIT_FAILURE,
				};
			}
			if (listOnly) {
				if (result.matches.length > 0) return { stdout: `${fileArg}\n`, stderr: regexWarning, exitCode: 0 };
				const stderr = result.scanTruncated
					? "[grep: scanned only a bounded portion of a large file; matches may exist beyond it]\n"
					: "";
				return { stdout: "", stderr: `${regexWarning}${stderr}`, exitCode: 1 };
			}
			if (countOnly) {
				// matches is capped at the per-file match cap, so scanTruncated means the count is a
				// lower bound (more matching lines exist past the cap or the scanned window).
				const stderr = result.scanTruncated ? "[grep: stopped at the match cap; count is a lower bound]\n" : "";
				return {
					stdout: `${result.matches.length}\n`,
					stderr: `${regexWarning}${stderr}`,
					exitCode: result.matches.length > 0 ? 0 : 1,
				};
			}
			if (result.matches.length === 0) {
				// Real grep: exit 1 means "no matches".
				const note = result.scanTruncated
					? "[grep: scanned only a bounded portion of a large file; matches may exist beyond it]\n"
					: "";
				return { stdout: "", stderr: `${regexWarning}${note}`, exitCode: 1 };
			}
			const stdout = `${result.matches.map((match) => `${match.lineNumber}:${match.line}`).join("\n")}\n`;
			let stderr = regexWarning;
			if (result.scanTruncated) {
				stderr += `[grep: stopped at the match/scan cap (showing first ${result.matches.length}); more may exist]\n`;
			}
			return { stdout, stderr, exitCode: 0 };
		}

		const readsStdin =
			operands.length === 0 ? commandCtx.stdin !== undefined : operands.length === 1 && operands[0] === "-";
		if (pattern != null && pattern.length > 0 && !recursive && !complexFlag && readsStdin) {
			const text = String(commandCtx.stdin ?? "");
			const normalizedNeedle = ignoreCase ? pattern.toLowerCase() : pattern;
			const lines = text.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").split("\n");
			if (text.endsWith("\n")) {
				lines.pop();
			}
			const selected = new Set<number>();
			for (let index = 0; index < lines.length; index++) {
				const haystack = ignoreCase ? lines[index]!.toLowerCase() : lines[index]!;
				const matched = haystack.includes(normalizedNeedle);
				if (invert ? !matched : matched) {
					selected.add(index);
				}
			}
			if (listOnly) {
				return {
					stdout: selected.size > 0 ? "(standard input)\n" : "",
					stderr: "",
					exitCode: selected.size > 0 ? 0 : 1,
				};
			}
			if (countOnly) {
				return {
					stdout: `${selected.size}\n`,
					stderr: "",
					exitCode: selected.size > 0 ? 0 : 1,
				};
			}
			if (selected.size === 0) {
				return { stdout: "", stderr: "", exitCode: 1 };
			}
			const outputIndexes = new Set<number>();
			for (const index of selected) {
				const start = Math.max(0, index - before);
				const end = Math.min(lines.length - 1, index + after);
				for (let lineIndex = start; lineIndex <= end; lineIndex++) {
					outputIndexes.add(lineIndex);
				}
			}
			const outputLines: string[] = [];
			let previousIndex: number | null = null;
			for (const index of [...outputIndexes].sort((a, b) => a - b)) {
				if (previousIndex !== null && index > previousIndex + 1) {
					outputLines.push("--");
				}
				outputLines.push(`${index + 1}${selected.has(index) ? ":" : "-"}${lines[index]}`);
				previousIndex = index;
			}
			return {
				stdout: `${outputLines.join("\n")}\n`,
				stderr: "",
				exitCode: 0,
			};
		}

		if (pattern != null && pattern.length > 0 && isSingleAppFile && unsupportedFlag != null) {
			return {
				stdout: "",
				stderr: (
					`grep: unsupported option ${unsupportedFlag} for app-file grep. ` +
					"Supported: grep [-i] PATTERN <file> with -c, -l, -v, and -A/-B/-C N. " +
					"Drop the flag, or use search for cross-file discovery.\n"
				),
				exitCode: COMMAND_EXIT_USAGE,
			};
		}

		let suggestedCommand = pattern ? `search --limit 20 ${shell_arg_quote(pattern)}` : "search --limit 20 <query>";
		if (pattern) {
			const firstAppOperand = operands.find((operand) => {
				if (operand === "-" || GLOB_METACHARACTER_REGEX.test(operand)) return false;
				return shell_path_to_app_path(appFilesMountPath, resolve_path(commandCtx.cwd, operand)) != null;
			});
			if (firstAppOperand != null) {
				const targetShellPath = resolve_path(commandCtx.cwd, firstAppOperand);
				const appPath = shell_path_to_app_path(appFilesMountPath, targetShellPath);
				const entry = appPath ? await get_bash_path_entry(ctx, ctxData, appPath) : null;
				if (entry?.kind === "folder") {
					suggestedCommand = `search --path ${shell_arg_quote(targetShellPath)} --limit 20 ${shell_arg_quote(pattern)}`;
				}
			}
		}
		return {
			stdout:
				[
					"grep over multiple/app-wide files is not supported; use search, or grep a single file.",
					"To search ALL files for content, use the indexed search command:",
					`Try: ${suggestedCommand}`,
					"IMPORTANT: search uses indexed Convex text search, not regex/glob/exact grep; use short distinctive tokens.",
					"To grep ONE file, pass exactly one app file path: grep [-i] PATTERN <file> (substring match, prints line numbers).",
					"To restrict search to a folder, cd there or use search --path <folder> <query>; broad scopes with common terms can be heavier.",
					"The search command uses the Convex text index and returns matching file paths with snippets.",
				].join("\n") + "\n",
			stderr: "",
			exitCode: 2,
		};
	});
}

// #endregion grep command

function enforce_reader_operand_cap(
	command: string,
	commandCtx: CommandContext,
	appFilesMountPath: string,
	files: string[],
) {
	let appFileCount = 0;
	for (const file of files) {
		if (file === "-") continue;
		if (is_path_under_app_mount(appFilesMountPath, resolve_path(commandCtx.cwd, file))) {
			appFileCount++;
		}
	}
	if (appFileCount > READER_FILE_OPERAND_MAX) {
		return {
			stdout: "",
			stderr: (
				`${command}: app file reads are limited to ${READER_FILE_OPERAND_MAX} files per command (you requested ${appFileCount}). ` +
				`This is a per-command batch limit, not a total ceiling: to READ these files, ${command} them in batches of ${READER_FILE_OPERAND_MAX} or fewer across multiple commands. ` +
				`To FIND which files mention something, use search (it returns matching snippets, not whole files).\n`
			),
			exitCode: COMMAND_EXIT_USAGE,
		};
	}
	return null;
}

/** Byte size of an app file via stat metadata, or null when unknown (e.g. unmaterialized). */
async function get_app_file_byte_size(ctx: ActionCtx, ctxData: WorkspaceFsOptions["ctxData"], appPath: string) {
	// Pending-aware: the agent's own unsaved write_file/edit_file content lives in
	// files_pending_updates, so the reader gate must size on what's actually served, not the
	// committed asset (which `stat` reports). Otherwise the gate decision and the byte count in
	// the oversize footer disagree with `cat`.
	const served = (await ctx.runQuery(internal.files_nodes.get_bash_served_byte_size, {
		workspaceId: ctxData.workspaceId,
		projectId: ctxData.projectId,
		userId: ctxData.userId,
		path: appPath,
	})) as files_nodes_get_bash_served_byte_size_Result;
	return served ? served.servedBytes : null;
}

function build_unreadable_file_advisory(
	appFilesMountPath: string,
	normalizedPath: string,
	contentType: string | undefined,
) {
	const shellPath = app_path_to_shell_path(appFilesMountPath, normalizedPath);
	const lastSlashIndex = normalizedPath.lastIndexOf("/");
	const lastDotIndex = normalizedPath.lastIndexOf(".");
	const appPathWithoutExtension =
		lastDotIndex > lastSlashIndex ? normalizedPath.slice(0, lastDotIndex) : normalizedPath;
	const relatedReadablePaths = Array.from(
		new Set([
			app_path_to_shell_path(appFilesMountPath, `${normalizedPath}.md`),
			app_path_to_shell_path(appFilesMountPath, `${appPathWithoutExtension}.md`),
			app_path_to_shell_path(appFilesMountPath, `${appPathWithoutExtension}.txt`),
		]),
	).filter((path) => path !== shellPath);
	return [
		`[ADVISORY] Cannot read '${shellPath}' — its content type is '${contentType ?? "unknown"}', which is not readable as text.`,
		"This message is NOT the file content. Bash can currently read Markdown and plain text files only; binary/media files are not supported.",
		`To read generated text output for this file, try: ${relatedReadablePaths.map((path) => `cat ${path}`).join(", or ")}`,
		"If none of those commands return content, run ls on the parent folder to find the correct generated Markdown sibling.",
		"",
	].join("\n");
}

// #region cat command

function create_cat_command(ctx: ActionCtx, ctxData: WorkspaceFsOptions["ctxData"], appFilesMountPath: string) {
	return defineCommand("cat", async (args, commandCtx) => {
		let showLineNumbers = false;
		const files: string[] = [];
		for (const arg of args) {
			if (arg === "--help") {
				return await delegate_builtin_command("cat", args, commandCtx);
			}
			if (arg === "-n" || arg === "--number") {
				showLineNumbers = true;
				continue;
			}
			if (arg.startsWith("-") && arg !== "-") {
				return {
					stdout: "",
					stderr: `cat: unsupported option ${arg}\nUsage: cat [-n] [FILE...]\n`,
					exitCode: COMMAND_EXIT_USAGE,
				};
			}
			files.push(arg);
		}

		const targets = files.length ? files : ["-"];
		const capError = enforce_reader_operand_cap("cat", commandCtx, appFilesMountPath, targets);
		if (capError != null) return capError;

		// Multi-file cat can't safely page a large member: a bounded preview spliced into the
		// concatenation would silently drop the rest of that file (and corrupt any downstream pipe).
		// Refuse up front and point at reading the large file on its own.
		if (targets.length > 1) {
			for (const file of targets) {
				if (file === "-" || GLOB_METACHARACTER_REGEX.test(file)) continue;
				const appPath = shell_path_to_app_path(appFilesMountPath, resolve_path(commandCtx.cwd, file));
				if (appPath == null) continue;
				const size = await get_app_file_byte_size(ctx, ctxData, appPath);
				if (size != null && size > READ_INLINE_MAX_BYTES) {
					return {
						stdout: "",
						stderr: `cat: ${file}: ${size} bytes — too large to concatenate. Read large files one at a time (e.g. head -n ${READ_HEAD_LARGE_FILE_MAX_LINES} ${shell_arg_quote(file)} or wc ${shell_arg_quote(file)}).\n`,
						exitCode: COMMAND_EXIT_FAILURE,
					};
				}
			}
		}
		let stdout = "";
		let stderr = "";
		let exitCode = 0;
		let lineNumber = 1;

		const appendContent = (content: string) => {
			if (showLineNumbers) {
				const numbered = add_cat_command_line_numbers(content, lineNumber);
				stdout += numbered.content;
				lineNumber = numbered.nextLineNumber;
			} else {
				stdout += content;
			}
		};

		for (const file of targets) {
			if (file === "-") {
				appendContent(commandCtx.stdin as unknown as string);
				continue;
			}
			if (GLOB_METACHARACTER_REGEX.test(file)) {
				return {
					stdout: "",
					stderr: app_glob_syntax_unsupported_message("cat", file),
					exitCode: COMMAND_EXIT_USAGE,
				};
			}
			const resolvedPath = resolve_path(commandCtx.cwd, file);
			const appPath = shell_path_to_app_path(appFilesMountPath, resolvedPath);
			// Large app file: don't dump it whole (and don't refuse) — show a bounded first page
			// plus a footer telling the agent how to read the rest.
			if (appPath != null) {
				const size = await get_app_file_byte_size(ctx, ctxData, appPath);
				if (size != null && size > READ_INLINE_MAX_BYTES) {
					const resolvedAppShellPath = app_path_to_shell_path(appFilesMountPath, appPath);
					const page = (await ctx.runAction(internal.files_nodes.read_file_line_range, {
						workspaceId: ctxData.workspaceId,
						projectId: ctxData.projectId,
						userId: ctxData.userId,
						path: appPath,
						startLine: 1,
						maxLines: READ_HEAD_LARGE_FILE_MAX_LINES,
					})) as files_nodes_read_file_line_range_Result;
					if (!page) {
						stderr += `cat: ${file}: No such file or directory\n`;
						exitCode = 1;
						continue;
					}
					const cont = page.moreLines
						? ` Continue with: sed -n '${READ_HEAD_LARGE_FILE_MAX_LINES + 1},${READ_HEAD_LARGE_FILE_MAX_LINES * 2}p' ${shell_arg_quote(resolvedAppShellPath)}.`
						: "";
					// Content goes to stdout verbatim; the advisory goes to stderr so it never
					// contaminates a pipe (e.g. `cat big.md | grep …`).
					appendContent(page.content);
					stderr += `[cat: '${file}' is ${size} bytes — showing the first ${READ_HEAD_LARGE_FILE_MAX_LINES} lines.${cont} Full counts: wc ${shell_arg_quote(file)}.]\n`;
					continue;
				}
			}
			try {
				appendContent(await commandCtx.fs.readFile(resolvedPath));
			} catch (error) {
				if (error instanceof AppFileContentUnavailableError) {
					appendContent(
						build_unreadable_file_advisory(
							appFilesMountPath,
							shell_path_to_app_path(appFilesMountPath, error.shellPath) ?? file,
							error.contentType,
						),
					);
				} else {
					const msg = error instanceof Error ? error.message : String(error);
					stderr += msg.startsWith("EISDIR")
						? `cat: ${file}: Is a directory\n`
						: `cat: ${file}: No such file or directory\n`;
					exitCode = 1;
				}
			}
		}

		return { stdout, stderr, exitCode };
	});
}

function add_cat_command_line_numbers(content: string, startLine: number) {
	const lines = content.split("\n");
	const hasTrailingNewline = content.endsWith("\n");
	const linesToNumber = hasTrailingNewline ? lines.slice(0, -1) : lines;
	const numbered = linesToNumber.map((line, index) => `${String(startLine + index).padStart(6)}\t${line}`);
	return {
		content: numbered.join("\n") + (hasTrailingNewline ? "\n" : ""),
		nextLineNumber: startLine + linesToNumber.length,
	};
}

// #endregion cat command

// #region stat command

function parse_stat_command_args(args: string[]) {
	let format: string | null = null;
	const files: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		if (arg === "--help") {
			return Result({ _yay: { delegate: true } as const });
		}
		if (arg === "-c") {
			format = args[++index] ?? "";
			continue;
		}
		if (arg.startsWith("-c")) {
			format = arg.slice(2);
			continue;
		}
		if (arg.startsWith("-")) {
			return Result({ _nay: { message: `stat: unsupported option ${arg}` } });
		}
		files.push(arg);
	}
	if (files.length === 0) {
		return Result({ _nay: { message: "stat: missing operand" } });
	}
	return Result({ _yay: { format, files } as const });
}

function format_stat_command_mode(mode: number, isDirectory: boolean) {
	const prefix = isDirectory ? "d" : "-";
	const bits = [
		[0o400, "r"],
		[0o200, "w"],
		[0o100, "x"],
		[0o040, "r"],
		[0o020, "w"],
		[0o010, "x"],
		[0o004, "r"],
		[0o002, "w"],
		[0o001, "x"],
	] as const;
	return `${prefix}${bits.map(([bit, char]) => ((mode & bit) === bit ? char : "-")).join("")}`;
}

function render_stat_command_output(
	format: string | null,
	file: string,
	stat: { isDirectory: boolean; mode: number; size: number | undefined; mtime: Date },
) {
	const modeOctal = stat.mode.toString(8);
	const modeStr = format_stat_command_mode(stat.mode, stat.isDirectory);
	// When size is undefined the committed snapshot size is unknown/not tracked;
	// render "?" rather than "0" so a %s format does not mislead the agent into
	// thinking the file is empty.
	const sizeStr = stat.size !== undefined ? String(stat.size) : "?";
	const mtimeIso = stat.mtime.toISOString();
	const mtimeHuman = mtimeIso.replace("T", " ").replace("Z", " +0000");
	if (format != null) {
		let output = format;
		output = output.replace(/%n/g, file);
		output = output.replace(/%N/g, `'${file}'`);
		output = output.replace(/%s/g, sizeStr);
		output = output.replace(/%F/g, stat.isDirectory ? "directory" : "regular file");
		output = output.replace(/%a/g, modeOctal);
		output = output.replace(/%A/g, modeStr);
		output = output.replace(/%u/g, "1000");
		output = output.replace(/%U/g, "user");
		output = output.replace(/%g/g, "1000");
		output = output.replace(/%G/g, "group");
		output = output.replace(/%y/g, mtimeHuman);
		output = output.replace(/%Y/g, String(Math.floor(stat.mtime.getTime() / 1000)));
		output = output.replace(/%x/g, mtimeHuman);
		output = output.replace(/%X/g, String(Math.floor(stat.mtime.getTime() / 1000)));
		output = output.replace(/%z/g, mtimeHuman);
		output = output.replace(/%Z/g, String(Math.floor(stat.mtime.getTime() / 1000)));
		return `${output}\n`;
	}
	const sizeDisplay =
		stat.size !== undefined
			? `${stat.size}\t\tBlocks: ${Math.ceil(stat.size / 512)}`
			: stat.isDirectory
				? "(directory; no content size)"
				: "(content size not tracked for this file)";
	return [
		`  File: ${file}`,
		`  Size: ${sizeDisplay}`,
		`  Type: ${stat.isDirectory ? "directory" : "regular file"}`,
		`Access: (${modeOctal.padStart(4, "0")}/${modeStr})`,
		`Modify: ${mtimeIso}`,
		"[stat: Access is a fixed placeholder; app files track only Size, Type, and Modify — not POSIX permissions, owner, group, inode, or blocks]",
		"",
	].join("\n");
}

function create_stat_command(ctx: ActionCtx, ctxData: WorkspaceFsOptions["ctxData"], appFilesMountPath: string) {
	return defineCommand("stat", async (args, commandCtx) => {
		const parsedResult = parse_stat_command_args(args);
		if (parsedResult._nay) {
			return {
				stdout: "",
				stderr: `${parsedResult._nay.message}\n`,
				exitCode: COMMAND_EXIT_USAGE,
			};
		}
		const parsed = parsedResult._yay;
		if ("delegate" in parsed) {
			return await delegate_builtin_command("stat", args, commandCtx);
		}

		const capError = enforce_reader_operand_cap("stat", commandCtx, appFilesMountPath, parsed.files);
		if (capError != null) return capError;

		let stdout = "";
		let stderr = "";
		let hasError = false;
		for (const file of parsed.files) {
			if (GLOB_METACHARACTER_REGEX.test(file)) {
				stderr += app_glob_syntax_unsupported_message("stat", file);
				hasError = true;
				continue;
			}
			const resolvedPath = resolve_path(commandCtx.cwd, file);
			const appPath = shell_path_to_app_path(appFilesMountPath, resolvedPath);
			try {
				if (appPath == null) {
					const stat = await commandCtx.fs.stat(resolvedPath);
					stdout += render_stat_command_output(parsed.format, file, stat);
					continue;
				}
				const entry = (await ctx.runQuery(internal.files_nodes.get_bash_stat_entry, {
					workspaceId: ctxData.workspaceId,
					projectId: ctxData.projectId,
					path: appPath,
				})) as files_nodes_get_bash_stat_entry_Result;
				if (!entry) {
					throw new Error("missing");
				}
				stdout += render_stat_command_output(parsed.format, file, {
					isDirectory: entry.kind === "folder",
					mode: entry.kind === "folder" ? 0o755 : 0o644,
					// size: 0 means the committed R2 snapshot is empty (initial blank doc);
					// treat it the same as undefined so the output says "not tracked" rather
					// than "0 bytes", which would mislead the agent into thinking the file is empty.
					size: entry.size || undefined,
					mtime: new Date(entry.updatedAt),
				});
			} catch {
				stderr += `stat: cannot stat '${file}': No such file or directory\n`;
				hasError = true;
			}
		}

		return { stdout, stderr, exitCode: hasError ? 1 : 0 };
	});
}

// #endregion stat command

// #region stream utility commands

function create_file_operand_guard_command(
	command: CommandName,
	appFilesMountPath: string,
	argsToFiles: (args: string[]) => { files: string[]; outputFiles?: string[]; delegateCwd?: string },
) {
	return defineCommand(command, async (args, commandCtx) => {
		const parsed = argsToFiles(args);
		for (const file of [...parsed.files, ...(parsed.outputFiles ?? [])]) {
			if (GLOB_METACHARACTER_REGEX.test(file)) {
				return {
					stdout: "",
					stderr: app_glob_syntax_unsupported_message(command, file),
					exitCode: COMMAND_EXIT_USAGE,
				};
			}
			const resolvedPath = resolve_path(commandCtx.cwd, file);
			if (is_path_under_app_mount(appFilesMountPath, resolvedPath)) {
				return {
					stdout: "",
					stderr: (
						`${command}: direct app file operands are not supported for '${file}'\n` +
						`Pipe the file through cat instead: cat '${file}' | ${command}\n`
					),
					exitCode: COMMAND_EXIT_FAILURE,
				};
			}
		}
		return await delegate_builtin_command(command, args, commandCtx, { cwd: parsed.delegateCwd });
	});
}

function create_stream_utility_commands(appFilesMountPath: string) {
	return [
		create_file_operand_guard_command("sort", appFilesMountPath, (args) => {
			const files: string[] = [];
			const outputFiles: string[] = [];
			for (let index = 0; index < args.length; index++) {
				const arg = args[index]!;
				if (arg === "-o" || arg === "--output") {
					const value = args[++index];
					if (value) outputFiles.push(value);
					continue;
				}
				if (arg.startsWith("-o") && arg.length > 2) {
					outputFiles.push(arg.slice(2));
					continue;
				}
				if (arg.startsWith("--output=")) {
					outputFiles.push(arg.slice("--output=".length));
					continue;
				}
				if (arg === "-k" || arg === "--key" || arg === "-t" || arg === "--field-separator") {
					index++;
					continue;
				}
				if (!arg.startsWith("-")) files.push(arg);
			}
			return { files, outputFiles };
		}),
		create_file_operand_guard_command("uniq", appFilesMountPath, (args) => ({
			files: args.filter((arg) => !arg.startsWith("-")),
		})),
		create_file_operand_guard_command("cut", appFilesMountPath, (args) => {
			const files: string[] = [];
			for (let index = 0; index < args.length; index++) {
				const arg = args[index]!;
				if (arg === "-d" || arg === "-f" || arg === "-c") {
					index++;
					continue;
				}
				if (!arg.startsWith("-") && !arg.startsWith("--")) {
					files.push(arg);
				}
			}
			return { files };
		}),
		create_file_operand_guard_command("awk", appFilesMountPath, (args) => {
			const files: string[] = [];
			let hasProgram = false;
			for (let index = 0; index < args.length; index++) {
				const arg = args[index]!;
				if (arg === "-F" || arg === "-v") {
					index++;
					continue;
				}
				if (arg.startsWith("-F") || arg.startsWith("-v")) {
					continue;
				}
				if (arg.startsWith("-")) {
					continue;
				}
				if (!hasProgram) {
					hasProgram = true;
					continue;
				}
				files.push(arg);
			}
			return { files, delegateCwd: TMP_MOUNT };
		}),
	];
}

// #endregion stream utility commands

// #region sed command

/**
 * `sed` with a special fast path for bounded line-range reads of an app file:
 * `sed -n 'A,Bp' <file>` (or `sed -n 'Ap' <file>`) reads exactly that line range via a
 * bounded read, so the agent can page through a large file (this is what `head`/`sed`
 * continuation hints point to). Any other sed usage falls back to the standard guard:
 * app-file operands must be piped through cat; non-app operands delegate to the builtin.
 */
function create_sed_command(ctx: ActionCtx, ctxData: WorkspaceFsOptions["ctxData"], appFilesMountPath: string) {
	return defineCommand("sed", async (args, commandCtx) => {
		if (args.includes("-n")) {
			const nonFlags = args.filter((arg) => !arg.startsWith("-"));
			const rangeMatch = nonFlags.length === 2 ? /^(\d+)(?:,(\d+))?p$/u.exec(nonFlags[0]!) : null;
			if (rangeMatch) {
				const fileArg = nonFlags[1]!;
				const appPath = shell_path_to_app_path(appFilesMountPath, resolve_path(commandCtx.cwd, fileArg));
				if (appPath != null) {
					const startLine = Number(rangeMatch[1]);
					const endLine = rangeMatch[2] != null ? Number(rangeMatch[2]) : startLine;
					if (endLine < startLine) {
						return {
							stdout: "",
							stderr: `sed: invalid line range '${nonFlags[0]}'\n`,
							exitCode: COMMAND_EXIT_USAGE,
						};
					}
					const maxLines = endLine - startLine + 1;
					if (maxLines > READ_HEAD_LARGE_FILE_MAX_LINES) {
						return {
							stdout: "",
							stderr: `sed: line range too large (${maxLines} lines; max ${READ_HEAD_LARGE_FILE_MAX_LINES} per read). Narrow the range.\n`,
							exitCode: COMMAND_EXIT_USAGE,
						};
					}
					const result = (await ctx.runAction(internal.files_nodes.read_file_line_range, {
						workspaceId: ctxData.workspaceId,
						projectId: ctxData.projectId,
						userId: ctxData.userId,
						path: appPath,
						startLine,
						maxLines,
					})) as files_nodes_read_file_line_range_Result;
					if (!result) {
						return {
							stdout: "",
							stderr: `sed: ${fileArg}: No such file or directory\n`,
							exitCode: COMMAND_EXIT_FAILURE,
						};
					}
					let stdout = result.content;
					const notes: string[] = [];
					if (result.moreLines && !result.scanTruncated) {
						notes.push(
							`More lines below. Next page: sed -n '${endLine + 1},${endLine + maxLines}p' ${shell_arg_quote(app_path_to_shell_path(appFilesMountPath, appPath))}`,
						);
					}
					if (result.scanTruncated) {
						notes.push("[sed: large file — only the scanned block was read; range may be incomplete]");
					}
					if (notes.length > 0) {
						stdout += `${stdout.endsWith("\n") ? "" : "\n"}${notes.join("\n")}\n`;
					}
					return { stdout, stderr: "", exitCode: 0 };
				}
			}
		}

		// Fallback: standard stream-utility guard (reject direct app operands, else delegate to /tmp).
		const files: string[] = [];
		let hasScript = false;
		for (let index = 0; index < args.length; index++) {
			const arg = args[index]!;
			if (arg === "-e") {
				hasScript = true;
				index++;
				continue;
			}
			if (arg === "-f") {
				const value = args[++index];
				if (value) files.push(value);
				continue;
			}
			if (arg === "-i" || arg === "-n" || arg === "-E" || arg === "-r") {
				continue;
			}
			if (arg.startsWith("-")) {
				continue;
			}
			if (!hasScript) {
				hasScript = true;
				continue;
			}
			files.push(arg);
		}
		for (const file of files) {
			if (GLOB_METACHARACTER_REGEX.test(file)) {
				return {
					stdout: "",
					stderr: app_glob_syntax_unsupported_message("sed", file),
					exitCode: COMMAND_EXIT_USAGE,
				};
			}
			if (is_path_under_app_mount(appFilesMountPath, resolve_path(commandCtx.cwd, file))) {
				return {
					stdout: "",
					stderr: (
						`sed: direct app file operands are not supported for '${file}'\n` +
						`Pipe the file through cat instead: cat '${file}' | sed '<script>'\n` +
						`To read a line range of a large app file, use: sed -n 'A,Bp' '${file}'\n`
					),
					exitCode: COMMAND_EXIT_FAILURE,
				};
			}
		}
		return await delegate_builtin_command("sed", args, commandCtx, { cwd: TMP_MOUNT });
	});
}

// #endregion sed command

// #region head tail wc commands

function parse_head_command_line_count(value: string | undefined) {
	if (value == null) return null;
	// A leading `+` (e.g. `tail -n +K`) means "start at line K" (forward), not "last K lines".
	const match = /^(\+?)(\d+)$/u.exec(value.trim());
	return match ? { count: Number(match[2]), fromStart: match[1] === "+" } : null;
}

/**
 * Returns the first app-file operand whose byte size exceeds the inline read cap, so readers
 * can refuse to pull a multi-MB file in one shot. Unknown sizes (unmaterialized) are allowed
 * through to the normal path.
 */
async function find_oversized_app_operand(
	ctx: ActionCtx,
	ctxData: WorkspaceFsOptions["ctxData"],
	commandCtx: CommandContext,
	appFilesMountPath: string,
	files: string[],
) {
	for (const file of files) {
		if (file === "-") continue;
		const appPath = shell_path_to_app_path(appFilesMountPath, resolve_path(commandCtx.cwd, file));
		if (appPath == null) continue;
		const size = await get_app_file_byte_size(ctx, ctxData, appPath);
		if (size != null && size > READ_INLINE_MAX_BYTES) {
			return { file, appPath, size } as const;
		}
	}
	return null;
}

function create_reader_guard_command(
	ctx: ActionCtx,
	ctxData: WorkspaceFsOptions["ctxData"],
	command: "head" | "tail" | "wc",
	appFilesMountPath: string,
) {
	return defineCommand(command, async (args, commandCtx) => {
		const files: string[] = [];
		let headLineCount: number | null = null;
		let headFromStart = false;
		let byteMode = false;
		const wcFlags = { lines: false, words: false, chars: false, bytes: false };
		for (let index = 0; index < args.length; index++) {
			const arg = args[index]!;
			if (command === "wc") {
				if (arg === "-l" || arg === "--lines") {
					wcFlags.lines = true;
					continue;
				}
				if (arg === "-w" || arg === "--words") {
					wcFlags.words = true;
					continue;
				}
				if (arg === "-c" || arg === "--bytes") {
					wcFlags.bytes = true;
					continue;
				}
				if (arg === "-m" || arg === "--chars") {
					wcFlags.chars = true;
					continue;
				}
				if (/^-[lwmc]{2,}$/u.test(arg)) {
					for (const ch of arg.slice(1)) {
						if (ch === "l") wcFlags.lines = true;
						else if (ch === "w") wcFlags.words = true;
						else if (ch === "c") wcFlags.bytes = true;
						else if (ch === "m") wcFlags.chars = true;
					}
					continue;
				}
			} else {
				if (arg === "-n" || arg === "--lines") {
					const parsed = parse_head_command_line_count(args[++index]);
					headLineCount = parsed?.count ?? null;
					headFromStart = parsed?.fromStart ?? false;
					continue;
				}
				if (arg === "-c" || arg === "--bytes") {
					byteMode = true;
					index++;
					continue;
				}
				if (arg.startsWith("--lines=")) {
					const parsed = parse_head_command_line_count(arg.slice("--lines=".length));
					headLineCount = parsed?.count ?? null;
					headFromStart = parsed?.fromStart ?? false;
					continue;
				}
				if (arg.startsWith("--bytes=")) {
					byteMode = true;
					continue;
				}
				const obsoleteLineCount = /^-(\d+)$/u.exec(arg);
				if (obsoleteLineCount) {
					headLineCount = Number(obsoleteLineCount[1]);
					headFromStart = false;
					continue;
				}
				if (arg.startsWith("-n")) {
					const parsed = parse_head_command_line_count(arg.slice(2));
					headLineCount = parsed?.count ?? null;
					headFromStart = parsed?.fromStart ?? false;
					continue;
				}
				if (arg.startsWith("-c")) {
					byteMode = true;
					continue;
				}
				if (arg === "-q" || arg === "--quiet" || arg === "-v" || arg === "--verbose") {
					continue;
				}
			}
			if (!arg.startsWith("-") || arg === "-") {
				files.push(arg);
			}
		}
		for (const file of files) {
			if (
				file !== "-" &&
				GLOB_METACHARACTER_REGEX.test(file) &&
				is_path_under_app_mount(appFilesMountPath, resolve_path(commandCtx.cwd, file))
			) {
				return {
					stdout: "",
					stderr: app_glob_syntax_unsupported_message(command, file),
					exitCode: COMMAND_EXIT_USAGE,
				};
			}
		}
		const capError = enforce_reader_operand_cap(command, commandCtx, appFilesMountPath, files);
		if (capError != null) return capError;

		// Multi-file wc across app files: serve per-file + total counts from the bounded stats
		// path (committed chunks are exact; oversized files yield windowed lower bounds) so a batch
		// never triggers a full read per file. Mixed/real-fs/stdin batches fall through to the builtin.
		if (
			command === "wc" &&
			files.length >= 2 &&
			files.every(
				(file) =>
					file !== "-" && shell_path_to_app_path(appFilesMountPath, resolve_path(commandCtx.cwd, file)) != null,
			)
		) {
			const wantDefault = !wcFlags.lines && !wcFlags.words && !wcFlags.chars && !wcFlags.bytes;
			const buildFields = (counts: { lineCount: number; wordCount: number; charCount: number; byteCount: number }) => {
				const fields: string[] = [];
				if (wcFlags.lines || wantDefault) fields.push(String(counts.lineCount));
				if (wcFlags.words || wantDefault) fields.push(String(counts.wordCount));
				if (wcFlags.bytes || wantDefault) fields.push(String(counts.byteCount));
				if (wcFlags.chars) fields.push(String(counts.charCount));
				return fields.join(" ");
			};
			const totals = { lineCount: 0, wordCount: 0, charCount: 0, byteCount: 0 };
			let stdout = "";
			let stderr = "";
			let exitCode = 0;
			let anyWindowed = false;
			for (const file of files) {
				const appPath = shell_path_to_app_path(appFilesMountPath, resolve_path(commandCtx.cwd, file))!;
				const stats = (await ctx.runAction(internal.files_nodes.read_file_content_stats, {
					workspaceId: ctxData.workspaceId,
					projectId: ctxData.projectId,
					userId: ctxData.userId,
					path: appPath,
				})) as files_nodes_read_file_content_stats_Result;
				if (!stats) {
					const entry = await get_bash_path_entry(ctx, ctxData, appPath);
					if (entry?.kind === "file") {
						stderr += build_unreadable_file_advisory(appFilesMountPath, appPath, entry.contentType);
					} else {
						stderr += `wc: ${file}: No such file or directory\n`;
					}
					exitCode = 1;
					continue;
				}
				totals.lineCount += stats.lineCount;
				totals.wordCount += stats.wordCount;
				totals.charCount += stats.charCount;
				totals.byteCount += stats.byteCount;
				if (!stats.exact) anyWindowed = true;
				stdout += `${buildFields(stats)} ${file}\n`;
			}
			stdout += `${buildFields(totals)} total\n`;
			// Byte counts are always exact; only line/word/char come from a bounded window.
			const windowedRequested = wcFlags.lines || wcFlags.words || wcFlags.chars || wantDefault;
			if (anyWindowed && windowedRequested) {
				stdout +=
					"[wc: one or more files exceed the scan window; line/word/char counts are lower bounds. Byte counts are exact.]\n";
			}
			return { stdout, stderr, exitCode };
		}

		// Large files would pull megabytes through a full read; gate them. head/tail/wc map to
		// bounded line reads served from materialized chunks (any depth); byte-mode (head -c) and
		// multi-file batches still refuse with guidance below.
		const oversized = await find_oversized_app_operand(ctx, ctxData, commandCtx, appFilesMountPath, files);
		if (oversized != null) {
			const appOperandCount = files.filter(
				(file) =>
					file !== "-" && shell_path_to_app_path(appFilesMountPath, resolve_path(commandCtx.cwd, file)) != null,
			).length;

			// Large files are read in bounded pages. head/tail map to bounded line reads; a
			// single file operand is required so the page output is unambiguous.
			if ((command === "head" || command === "tail") && byteMode && appOperandCount === 1) {
				return {
					stdout: "",
					stderr: `${command}: byte-range reads (-c) are not supported for large app files; use ${command} -n N (lines) or wc -c ${shell_arg_quote(app_path_to_shell_path(appFilesMountPath, oversized.appPath))} for the byte count.\n`,
					exitCode: COMMAND_EXIT_FAILURE,
				};
			}
			if ((command === "head" || command === "tail") && !byteMode && appOperandCount === 1) {
				const oversizedAppShellPath = app_path_to_shell_path(appFilesMountPath, oversized.appPath);
				// `tail -n +K`: output from line K onward — a forward read at an offset, not a trailing
				// window. Serve it from the same bounded forward reader head uses (paged via sed).
				if (command === "tail" && headFromStart && headLineCount != null) {
					const startLine = Math.max(1, headLineCount);
					const maxLines = READ_HEAD_LARGE_FILE_MAX_LINES;
					const result = (await ctx.runAction(internal.files_nodes.read_file_line_range, {
						workspaceId: ctxData.workspaceId,
						projectId: ctxData.projectId,
						userId: ctxData.userId,
						path: oversized.appPath,
						startLine,
						maxLines,
					})) as files_nodes_read_file_line_range_Result;
					if (!result) {
						return {
							stdout: "",
							stderr: `tail: ${oversized.file}: No such file or directory\n`,
							exitCode: COMMAND_EXIT_FAILURE,
						};
					}
					let stdout = result.content;
					const notes: string[] = [];
					if (result.moreLines && !result.scanTruncated) {
						notes.push(
							`More lines below. Next page: sed -n '${startLine + maxLines},${startLine + maxLines * 2 - 1}p' ${shell_arg_quote(oversizedAppShellPath)}`,
						);
					}
					if (result.scanTruncated) {
						notes.push("[tail: large file — only the first scanned block was read; output may be incomplete]");
					}
					if (notes.length > 0) {
						stdout += `${stdout.endsWith("\n") ? "" : "\n"}${notes.join("\n")}\n`;
					}
					return { stdout, stderr: "", exitCode: 0 };
				}
				const requestedLines = headLineCount ?? 10;
				// Clamp (don't refuse) an over-large -n to the per-page cap, and note it.
				const maxLines = Math.min(requestedLines, READ_HEAD_LARGE_FILE_MAX_LINES);
				const clampNote =
					requestedLines > READ_HEAD_LARGE_FILE_MAX_LINES
						? `[${command}: showing ${maxLines} lines (per-page cap); page again to read further]`
						: null;
				if (command === "head") {
					const result = (await ctx.runAction(internal.files_nodes.read_file_line_range, {
						workspaceId: ctxData.workspaceId,
						projectId: ctxData.projectId,
						userId: ctxData.userId,
						path: oversized.appPath,
						startLine: 1,
						maxLines,
					})) as files_nodes_read_file_line_range_Result;
					if (!result) {
						return {
							stdout: "",
							stderr: `head: ${oversized.file}: No such file or directory\n`,
							exitCode: COMMAND_EXIT_FAILURE,
						};
					}
					let stdout = result.content;
					const notes: string[] = [];
					if (clampNote) notes.push(clampNote);
					if (result.moreLines && !result.scanTruncated) {
						// Point the agent at the next page via sed line ranges (bash-native paging).
						notes.push(
							`More lines below. Next page: sed -n '${maxLines + 1},${maxLines * 2}p' ${shell_arg_quote(oversizedAppShellPath)}`,
						);
					}
					if (result.scanTruncated) {
						notes.push("[head: large file — only the first scanned block was read; output may be incomplete]");
					}
					if (notes.length > 0) {
						stdout += `${stdout.endsWith("\n") ? "" : "\n"}${notes.join("\n")}\n`;
					}
					return { stdout, stderr: "", exitCode: 0 };
				}
				const result = (await ctx.runAction(internal.files_nodes.read_file_tail_lines, {
					workspaceId: ctxData.workspaceId,
					projectId: ctxData.projectId,
					userId: ctxData.userId,
					path: oversized.appPath,
					maxLines,
				})) as files_nodes_read_file_tail_lines_Result;
				if (!result) {
					return {
						stdout: "",
						stderr: `tail: ${oversized.file}: No such file or directory\n`,
						exitCode: COMMAND_EXIT_FAILURE,
					};
				}
				let stdout = result.content;
				const tailNotes: string[] = [];
				if (clampNote) tailNotes.push(clampNote);
				if (result.scanTruncated) {
					tailNotes.push("[tail: large file — only the trailing block was read]");
				} else if (result.moreLines) {
					// Signal that this is a partial end-of-file view and point at the top of the file.
					tailNotes.push(
						`[tail: showing the last ${maxLines} lines; earlier lines precede them. Read from the top with: head -n ${maxLines} ${shell_arg_quote(oversizedAppShellPath)}]`,
					);
				}
				if (tailNotes.length > 0) {
					stdout += `${stdout.endsWith("\n") ? "" : "\n"}${tailNotes.join("\n")}\n`;
				}
				return { stdout, stderr: "", exitCode: 0 };
			}

			// wc on a large file: report counts so the agent learns the file's size (e.g. line
			// count) instead of over-paging. Bytes are exact; line/word/char come from a bounded
			// window (flagged as a lower bound when the file exceeds the scan window).
			if (command === "wc" && appOperandCount === 1) {
				const stats = (await ctx.runAction(internal.files_nodes.read_file_content_stats, {
					workspaceId: ctxData.workspaceId,
					projectId: ctxData.projectId,
					userId: ctxData.userId,
					path: oversized.appPath,
				})) as files_nodes_read_file_content_stats_Result;
				if (!stats) {
					return {
						stdout: "",
						stderr: `wc: ${oversized.file}: No such file or directory\n`,
						exitCode: COMMAND_EXIT_FAILURE,
					};
				}
				const wantDefault = !wcFlags.lines && !wcFlags.words && !wcFlags.chars && !wcFlags.bytes;
				const fields: string[] = [];
				if (wcFlags.lines || wantDefault) fields.push(String(stats.lineCount));
				if (wcFlags.words || wantDefault) fields.push(String(stats.wordCount));
				if (wcFlags.bytes || wantDefault) fields.push(String(stats.byteCount));
				if (wcFlags.chars) fields.push(String(stats.charCount));
				let stdout = `${fields.join(" ")} ${oversized.file}\n`;
				// Byte count is always exact; only line/word/char counts are window-bounded.
				const windowedRequested = wcFlags.lines || wcFlags.words || wcFlags.chars || wantDefault;
				if (!stats.exact && windowedRequested) {
					stdout += `[wc: file exceeds the scan window; line/word/char counts are lower bounds. Byte count (${stats.byteCount}) is exact.]\n`;
				}
				return { stdout, stderr: "", exitCode: 0 };
			}

			const hint =
				command === "head"
					? `Use head -n N (line mode, single file, N<=${READ_HEAD_LARGE_FILE_MAX_LINES}) to read the start, then the printed sed -n page command to continue.`
					: command === "tail"
						? `Use tail -n N (line mode, single file, N<=${READ_HEAD_LARGE_FILE_MAX_LINES}) to read the end.`
						: "Read with head -n N / sed -n 'A,Bp' / tail -n N, or use search for content.";
			return {
				stdout: "",
				stderr: `${command}: '${oversized.file}' is ${oversized.size} bytes, over the ${READ_INLINE_MAX_BYTES}-byte inline read limit. ${hint}\n`,
				exitCode: COMMAND_EXIT_FAILURE,
			};
		}
		for (const file of files) {
			if (file === "-") continue;
			const resolvedPath = resolve_path(commandCtx.cwd, file);
			const appPath = shell_path_to_app_path(appFilesMountPath, resolvedPath);
			if (appPath == null) continue;
			try {
				await commandCtx.fs.readFile(resolvedPath);
			} catch (error) {
				if (error instanceof AppFileContentUnavailableError) {
					return {
						stdout: build_unreadable_file_advisory(appFilesMountPath, appPath, error.contentType),
						stderr: "",
						exitCode: 0,
					};
				}
			}
		}
		try {
			return await delegate_builtin_command(command, args, commandCtx);
		} catch (error) {
			if (error instanceof AppFileContentUnavailableError) {
				return {
					stdout: build_unreadable_file_advisory(
						appFilesMountPath,
						shell_path_to_app_path(appFilesMountPath, error.shellPath) ?? error.shellPath,
						error.contentType,
					),
					stderr: "",
					exitCode: 0,
				};
			}
			throw error;
		}
	});
}

// #endregion head tail wc commands

// #region touch command

function create_touch_command(appFilesMountPath: string) {
	return defineCommand("touch", async (args, commandCtx) => {
		const files: string[] = [];
		for (let index = 0; index < args.length; index++) {
			const arg = args[index]!;
			if (arg === "-d" || arg === "--date" || arg === "-r" || arg === "-t") {
				index++;
				continue;
			}
			if (!arg.startsWith("-")) {
				files.push(arg);
			}
		}
		for (const file of files) {
			const resolvedPath = resolve_path(commandCtx.cwd, file);
			if (is_path_under_app_mount(appFilesMountPath, resolvedPath)) {
				const appPath = shell_path_to_app_path(appFilesMountPath, resolvedPath) ?? file;
				return {
					stdout: "",
					stderr: (
						`touch: cannot create or update app file '${file}' through bash.\n` +
						`Use write_file with path '${appPath}' to create a new file (strip the '${appFilesMountPath}' mount prefix from the bash path).\n` +
						`Use edit_file with path '${appPath}' to update an existing file.\n`
					),
					exitCode: COMMAND_EXIT_FAILURE,
				};
			}
		}
		return await delegate_builtin_command("touch", args, commandCtx);
	});
}

// #endregion touch command

// #region rm command

function create_rm_command(appFilesMountPath: string) {
	return defineCommand("rm", async (args, commandCtx) => {
		for (const arg of args) {
			if (arg.startsWith("-")) continue;
			const resolvedPath = resolve_path(commandCtx.cwd, arg);
			if (is_path_under_app_mount(appFilesMountPath, resolvedPath)) {
				return {
					stdout: "",
					stderr: (
						`rm: cannot delete app file '${arg}' through bash.\n` +
						`App files cannot be deleted via shell commands. Use the Files sidebar Archive action for '${arg}', or use write_file/edit_file for content changes.\n`
					),
					exitCode: COMMAND_EXIT_FAILURE,
				};
			}
		}
		return await delegate_builtin_command("rm", args, commandCtx);
	});
}

// #endregion rm command

function parse_cp_mv_command_operands(args: string[]) {
	const operands: string[] = [];
	let recursive = false;
	for (const arg of args) {
		if (arg === "-r" || arg === "-R" || arg === "--recursive") {
			recursive = true;
			continue;
		}
		if (arg.startsWith("-")) {
			continue;
		}
		operands.push(arg);
	}
	return { operands, recursive };
}

// #region cp command

/**
 * Check whether a normalized path is inside the per-command scratch mount.
 */
function is_under_tmp_mount(path: string) {
	return path === TMP_MOUNT || path.startsWith(`${TMP_MOUNT}/`);
}

function create_cp_command(appFilesMountPath: string) {
	return defineCommand("cp", async (args, commandCtx) => {
		const { operands, recursive } = parse_cp_mv_command_operands(args);
		const appOperands = operands.filter((operand) =>
			is_path_under_app_mount(appFilesMountPath, resolve_path(commandCtx.cwd, operand)),
		);
		if (appOperands.length === 0) {
			return await delegate_builtin_command("cp", args, commandCtx);
		}
		for (const operand of appOperands) {
			if (GLOB_METACHARACTER_REGEX.test(operand)) {
				return {
					stdout: "",
					stderr: app_glob_syntax_unsupported_message("cp", operand),
					exitCode: COMMAND_EXIT_USAGE,
				};
			}
		}
		// Writing INTO the app tree (any -> app destination) is read-only for cp; route
		// straight to write_file so the model does not retry cp.
		if (
			operands.length === 2 &&
			is_path_under_app_mount(appFilesMountPath, resolve_path(commandCtx.cwd, operands[1]!))
		) {
			const destAppPath =
				shell_path_to_app_path(appFilesMountPath, resolve_path(commandCtx.cwd, operands[1]!)) ?? operands[1]!;
			return {
				stdout: "",
				stderr: (
					`cp: cannot write to app file '${operands[1]}': the app file tree is read-only for cp.\n` +
					`To create a durable copy at '${destAppPath}', use write_file with path '${destAppPath}' and the content read from the source.\n` +
					`cp into the app tree is never supported; only cp <app-file> /tmp/<name> (scratch copy) is allowed.\n`
				),
				exitCode: COMMAND_EXIT_FAILURE,
			};
		}
		if (recursive || operands.length !== 2 || appOperands.length !== 1 || appOperands[0] !== operands[0]) {
			return {
				stdout: "",
				stderr: (
					"cp: app files can only be copied as one exact readable file to a /tmp destination.\n" +
					"Usage: cp <app-file> /tmp/<name>  — copies the file content to /tmp scratch space (one invocation only).\n" +
					"To duplicate an app file as a new durable file, use write_file with the new app path (strip the mount prefix).\n"
				),
				exitCode: COMMAND_EXIT_FAILURE,
			};
		}

		const sourceShellPath = resolve_path(commandCtx.cwd, operands[0]!);
		const destShellPath = resolve_path(commandCtx.cwd, operands[1]!);
		if (!is_under_tmp_mount(destShellPath)) {
			const destAppPath = shell_path_to_app_path(appFilesMountPath, destShellPath);
			const destHint =
				destAppPath != null
					? `To create a durable copy at '${destAppPath}', use write_file with path '${destAppPath}' and the content read from the source.`
					: "Durable app file writes require write_file, not cp.";
			return {
				stdout: "",
				stderr: (
					`cp: cannot write to '${operands[1]}': app file tree is read-only for cp.\n` +
					`Only /tmp destinations are supported: cp ${shell_arg_quote(operands[0]!)} /tmp/<name>\n` +
					`${destHint}\n`
				),
				exitCode: COMMAND_EXIT_FAILURE,
			};
		}
		try {
			const sourceStat = await commandCtx.fs.stat(sourceShellPath);
			if (!sourceStat.isFile) {
				return {
					stdout: "",
					stderr: "cp: recursive app directory copy is not supported\n",
					exitCode: COMMAND_EXIT_FAILURE,
				};
			}
			const content = await commandCtx.fs.readFileBuffer(sourceShellPath);
			await commandCtx.fs.writeFile(destShellPath, content);
			return { stdout: "", stderr: "", exitCode: 0 };
		} catch (error) {
			if (error instanceof AppFileContentUnavailableError) {
				return {
					stdout: "",
					stderr: `cp: ${operands[0]}: unsupported app file content type '${error.contentType ?? "unknown"}'\n`,
					exitCode: COMMAND_EXIT_FAILURE,
				};
			}
			return {
				stdout: "",
				stderr: `cp: cannot copy '${operands[0]}'\n`,
				exitCode: COMMAND_EXIT_FAILURE,
			};
		}
	});
}

// #endregion cp command

// #region mv command

function create_mv_command(appFilesMountPath: string) {
	return defineCommand("mv", async (args, commandCtx) => {
		const { operands } = parse_cp_mv_command_operands(args);
		// Identify source and destination for better guidance
		const srcOperand = operands[0];
		const destOperand = operands[1];
		for (const operand of operands) {
			const resolvedPath = resolve_path(commandCtx.cwd, operand);
			if (is_path_under_app_mount(appFilesMountPath, resolvedPath)) {
				const srcAppPath =
					srcOperand != null
						? (shell_path_to_app_path(appFilesMountPath, resolve_path(commandCtx.cwd, srcOperand)) ?? srcOperand)
						: null;
				const destAppPath =
					destOperand != null
						? (shell_path_to_app_path(appFilesMountPath, resolve_path(commandCtx.cwd, destOperand)) ?? destOperand)
						: null;
				const renameHint =
					srcAppPath != null && destAppPath != null
						? `To rename/move an app file, use the Files sidebar rename/move UI. For content changes, use write_file with path '${destAppPath}' or edit_file on '${srcAppPath}'.`
						: "To rename/move an app file, use the Files sidebar rename/move UI. For content changes, use write_file or edit_file.";
				return {
					stdout: "",
					stderr: `mv: cannot move or rename app files through bash.\n` + `${renameHint}\n`,
					exitCode: COMMAND_EXIT_FAILURE,
				};
			}
		}
		return await delegate_builtin_command("mv", args, commandCtx);
	});
}

// #endregion mv command

// #region tee command

function create_tee_command(appFilesMountPath: string) {
	return defineCommand("tee", async (args, commandCtx) => {
		const files = args.filter((arg) => !arg.startsWith("-"));
		for (const file of files) {
			const resolvedPath = resolve_path(commandCtx.cwd, file);
			if (is_path_under_app_mount(appFilesMountPath, resolvedPath)) {
				const appPath = shell_path_to_app_path(appFilesMountPath, resolvedPath) ?? file;
				return {
					stdout: commandCtx.stdin as unknown as string,
					stderr:
						`tee: cannot write to app file '${file}' through bash.\n` +
						`Use write_file with path '${appPath}' to write new content (strip the '${appFilesMountPath}' mount prefix).\n` +
						`Use edit_file with path '${appPath}' to apply targeted edits to an existing file.\n`,
					exitCode: 1,
				};
			}
		}
		return await delegate_builtin_command("tee", args, commandCtx);
	});
}

// #endregion tee command

// #region nested shell commands

function create_nested_shell_command(name: "bash" | "sh", appFilesMountPath: string) {
	return defineCommand(name, async (args, commandCtx) => {
		if (args.length === 0) {
			return { stdout: "", stderr: "", exitCode: 0 };
		}
		// Treat the common `bash -lc` agent habit as `bash -c`; login-shell setup is irrelevant in this curated shell.
		if (args[0] === "-c" || args[0] === "-lc" || args[0] === "-cl") {
			const script = args[1];
			if (script == null) {
				return {
					stdout: "",
					stderr: `${name}: -c: option requires an argument\n`,
					exitCode: COMMAND_EXIT_FAILURE,
				};
			}
			if (!commandCtx.exec) {
				return {
					stdout: "",
					stderr: `${name}: nested execution is unavailable\n`,
					exitCode: COMMAND_EXIT_FAILURE,
				};
			}
			return await commandCtx.exec(`set -f\n${script}`, {
				cwd: commandCtx.cwd,
				signal: commandCtx.signal,
				args: args.slice(2),
			});
		}
		if (args[0]?.startsWith("-")) {
			return {
				stdout: "",
				stderr: `${name}: unsupported option ${args[0]}\nOnly ${name} -c 'script' (inline script) is supported. Avoid set -euo pipefail, process substitution, and other shell-specific flags.\n`,
				exitCode: COMMAND_EXIT_USAGE,
			};
		}
		const scriptPath = resolve_path(commandCtx.cwd, args[0]!);
		if (is_path_under_app_mount(appFilesMountPath, scriptPath)) {
			return {
				stdout: "",
				stderr: `${name}: app-mounted script files are not executable through bash\n`,
				exitCode: COMMAND_EXIT_FAILURE,
			};
		}
		if (!commandCtx.exec) {
			return {
				stdout: "",
				stderr: `${name}: nested execution is unavailable\n`,
				exitCode: COMMAND_EXIT_FAILURE,
			};
		}
		const script = await commandCtx.fs.readFile(scriptPath);
		return await commandCtx.exec(`set -f\n${script}`, {
			cwd: commandCtx.cwd,
			signal: commandCtx.signal,
			args: args.slice(1),
		});
	});
}

// #endregion nested shell commands

// #region xargs command

function create_xargs_command() {
	return defineCommand("xargs", async (args, commandCtx) => {
		let replaceString: string | null = null;
		let delimiter: string | null = null;
		let maxArgs: number | null = null;
		let nullSeparated = false;
		let verbose = false;
		let noRunIfEmpty = false;
		let commandStart = args.length;

		for (let index = 0; index < args.length; index++) {
			const arg = args[index]!;
			if (arg === "-I") {
				replaceString = args[++index] ?? "";
				commandStart = index + 1;
				continue;
			}
			if (arg.startsWith("-I") && arg.length > 2) {
				replaceString = arg.slice(2);
				commandStart = index + 1;
				continue;
			}
			if (arg === "-d") {
				delimiter = (args[++index] ?? "").replace(/\\n/gu, "\n").replace(/\\t/gu, "\t").replace(/\\0/gu, "\0");
				commandStart = index + 1;
				continue;
			}
			if (arg.startsWith("-d") && arg.length > 2) {
				delimiter = arg.slice(2).replace(/\\n/gu, "\n").replace(/\\t/gu, "\t").replace(/\\0/gu, "\0");
				commandStart = index + 1;
				continue;
			}
			if (arg === "-n") {
				const rawMaxArgs = args[++index];
				if (rawMaxArgs == null || !/^\d+$/u.test(rawMaxArgs) || Number(rawMaxArgs) < 1) {
					return {
						stdout: "",
						stderr: "xargs: -n requires a positive integer\n",
						exitCode: COMMAND_EXIT_USAGE,
					};
				}
				maxArgs = Number(rawMaxArgs);
				commandStart = index + 1;
				continue;
			}
			if (arg.startsWith("-n") && arg.length > 2 && /^-n\d+$/u.test(arg)) {
				const inlineMaxArgs = Number(arg.slice(2));
				if (inlineMaxArgs < 1) {
					return {
						stdout: "",
						stderr: "xargs: -n requires a positive integer\n",
						exitCode: COMMAND_EXIT_USAGE,
					};
				}
				maxArgs = inlineMaxArgs;
				commandStart = index + 1;
				continue;
			}
			if (arg === "-P") {
				const value = Number(args[index + 1]);
				if (Number.isFinite(value) && value > 1) {
					return {
						stdout: "",
						stderr: "xargs: parallel execution (-P > 1) is not supported in this app shell\n",
						exitCode: COMMAND_EXIT_USAGE,
					};
				}
				index++;
				commandStart = index + 1;
				continue;
			}
			if (arg.startsWith("-P") && arg.length > 2) {
				const value = Number(arg.slice(2));
				if (Number.isFinite(value) && value > 1) {
					return {
						stdout: "",
						stderr: "xargs: parallel execution (-P > 1) is not supported in this app shell\n",
						exitCode: COMMAND_EXIT_USAGE,
					};
				}
				commandStart = index + 1;
				continue;
			}
			if (arg === "-0" || arg === "--null") {
				nullSeparated = true;
				commandStart = index + 1;
				continue;
			}
			if (arg === "-t" || arg === "--verbose") {
				verbose = true;
				commandStart = index + 1;
				continue;
			}
			if (arg === "-r" || arg === "--no-run-if-empty") {
				noRunIfEmpty = true;
				commandStart = index + 1;
				continue;
			}
			if (arg.startsWith("-")) {
				return {
					stdout: "",
					stderr: `xargs: unsupported option ${arg}\nSupported: xargs [-n N] [-I REPLACE] [-d DELIM] [-0] [-t] [-r] [COMMAND [ARGS...]]\n`,
					exitCode: COMMAND_EXIT_USAGE,
				};
			}
			commandStart = index;
			break;
		}

		const command = args.slice(commandStart);
		if (command.length === 0) {
			command.push("echo");
		}

		const stdinText = commandCtx.stdin as unknown as string;
		const items = nullSeparated
			? stdinText.split("\0").filter(Boolean)
			: delimiter != null
				? stdinText.replace(/\n$/u, "").split(delimiter).filter(Boolean)
				: stdinText
						.split(/\s+/u)
						.map((item) => item.trim())
						.filter(Boolean);
		if (items.length === 0) {
			if (noRunIfEmpty) {
				return { stdout: "", stderr: "", exitCode: 0 };
			}
			return { stdout: "", stderr: "", exitCode: 0 };
		}
		if (!commandCtx.exec) {
			return {
				stdout: "",
				stderr: "xargs: nested execution is unavailable\n",
				exitCode: COMMAND_EXIT_FAILURE,
			};
		}

		const commandBatches: string[][] = [];
		if (replaceString != null) {
			for (const item of items) {
				commandBatches.push(command.map((part) => part.replaceAll(replaceString, item)));
			}
		} else if (maxArgs != null && Number.isFinite(maxArgs) && maxArgs > 0) {
			for (let index = 0; index < items.length; index += maxArgs) {
				commandBatches.push([...command, ...items.slice(index, index + maxArgs)]);
			}
		} else {
			commandBatches.push([...command, ...items]);
		}

		let stdout = "";
		let stderr = "";
		let exitCode = 0;
		for (const batch of commandBatches) {
			if (batch.length === 0) {
				continue;
			}
			if (verbose) {
				stderr += `${batch.map(shell_arg_quote).join(" ")}\n`;
			}
			const result = await commandCtx.exec(shell_arg_quote(batch[0]!), {
				cwd: commandCtx.cwd,
				signal: commandCtx.signal,
				args: batch.slice(1),
			});
			stdout += result.stdout;
			stderr += result.stderr;
			if (result.exitCode !== 0) {
				exitCode = result.exitCode;
			}
		}
		return { stdout, stderr, exitCode };
	});
}

// #endregion xargs command

// #region which command

const APP_COMMAND_NAMES = new Set<string>([...ALLOWED_COMMANDS, "search"]);

function create_which_command() {
	return defineCommand("which", async (args) => {
		let silent = false;
		let showAll = false;
		const names: string[] = [];
		for (const arg of args) {
			if (arg === "-s") {
				silent = true;
				continue;
			}
			if (arg === "-a") {
				showAll = true;
				continue;
			}
			if (arg.startsWith("-")) {
				return {
					stdout: "",
					stderr: `which: unsupported option ${arg}\n`,
					exitCode: COMMAND_EXIT_USAGE,
				};
			}
			names.push(arg);
		}
		if (names.length === 0) {
			return { stdout: "", stderr: "", exitCode: 1 };
		}

		let stdout = "";
		let stderr = "";
		let allFound = true;
		for (const name of names) {
			if (APP_COMMAND_NAMES.has(name)) {
				if (!silent) {
					stdout += `/usr/bin/${name}\n`;
					if (showAll) {
						stdout += `/bin/${name}\n`;
					}
				}
			} else {
				allFound = false;
				if (!silent) {
					stderr += `which: no ${name} in (/usr/bin:/bin)\n`;
				}
			}
		}
		return { stdout, stderr, exitCode: allFound ? 0 : 1 };
	});
}

// #endregion which command

/**
 * Mount the app file tree into Just Bash as a mostly read-only filesystem.
 */
class WorkspaceFs implements IFileSystem {
	readonly ctx: ActionCtx;
	readonly ctxData: WorkspaceFsOptions["ctxData"];
	readonly appFilesMountPath: string;
	readonly allowAppFileTreeMkdir: boolean;
	pathIndexTruncated = false;
	private entryCache = new Map<string, JustBashFileNodeCacheEntry>();
	private contentCache = new Map<string, string>();

	constructor(options: WorkspaceFsOptions) {
		this.ctx = options.ctx;
		this.ctxData = options.ctxData;
		this.appFilesMountPath = options.appFilesMountPath;
		this.allowAppFileTreeMkdir = options.allowAppFileTreeMkdir;
		this.rememberEntry({
			path: "/",
			kind: "folder",
			updatedAt: 0,
		});
	}

	async readFile(path: string, _options?: Parameters<IFileSystem["readFile"]>[1]) {
		const normalizedPath = normalize_path(path);
		if (GLOB_METACHARACTER_REGEX.test(normalizedPath)) {
			throw new Error(
				`app file glob patterns are not supported: '${app_path_to_shell_path(this.appFilesMountPath, normalizedPath)}'`,
			);
		}
		const cached = this.contentCache.get(normalizedPath);
		if (cached != null) {
			return cached;
		}

		const fileContent = (await this.ctx.runAction(
			internal.files_nodes.get_file_last_available_markdown_content_by_path,
			{
				workspaceId: this.ctxData.workspaceId,
				projectId: this.ctxData.projectId,
				userId: this.ctxData.userId,
				path: normalizedPath,
			},
		)) as files_nodes_get_file_last_available_markdown_content_by_path_Result;

		if (!fileContent) {
			const entry = await this.getEntry(normalizedPath);
			if (entry?.kind === "file") {
				let contentType = entry.contentType;
				if (contentType == null) {
					const node = (await this.ctx.runQuery(internal.files_nodes.get_by_path, {
						workspaceId: this.ctxData.workspaceId,
						projectId: this.ctxData.projectId,
						path: normalizedPath,
					})) as files_nodes_get_by_path_Result;
					if (node?.kind === "file") {
						contentType = node.contentType;
						this.rememberEntry({
							nodeId: node._id,
							path: node.path,
							kind: node.kind,
							updatedAt: node.updatedAt,
							updatedBy: node.updatedBy,
							contentType: node.contentType,
						});
					}
				}
				throw new AppFileContentUnavailableError({
					shellPath: app_path_to_shell_path(this.appFilesMountPath, normalizedPath),
					contentType,
				});
			}
			if (entry?.kind === "folder") {
				throw new Error(
					`EISDIR: illegal operation on a directory, read '${app_path_to_shell_path(this.appFilesMountPath, normalizedPath)}'`,
				);
			}
			throw new Error(
				`ENOENT: no such file or directory, open '${app_path_to_shell_path(this.appFilesMountPath, normalizedPath)}'`,
			);
		}

		this.contentCache.set(normalizedPath, fileContent.content);
		this.rememberEntry({
			nodeId: fileContent.nodeId,
			path: normalizedPath,
			kind: "file",
			updatedAt: Date.now(),
		});
		return fileContent.content;
	}

	async readFileBuffer(path: string) {
		return textEncoder.encode(await this.readFile(path));
	}

	async writeFile(path: string, _content: FileContent, _options?: Parameters<IFileSystem["writeFile"]>[2]) {
		throw new ReadOnlyFileSystemError(app_path_to_shell_path(this.appFilesMountPath, path));
	}

	async appendFile(path: string, _content: FileContent, _options?: Parameters<IFileSystem["appendFile"]>[2]) {
		throw new ReadOnlyFileSystemError(app_path_to_shell_path(this.appFilesMountPath, path));
	}

	async exists(path: string) {
		return (await this.getEntry(path)) != null;
	}

	async stat(path: string): Promise<FsStat> {
		const normalizedPath = normalize_path(path);
		if (GLOB_METACHARACTER_REGEX.test(normalizedPath)) {
			throw new Error(
				`app file glob patterns are not supported: '${app_path_to_shell_path(this.appFilesMountPath, normalizedPath)}'`,
			);
		}
		const entry = await this.getEntry(normalizedPath);
		if (!entry) {
			throw new Error(
				`ENOENT: no such file or directory, stat '${app_path_to_shell_path(this.appFilesMountPath, normalizedPath)}'`,
			);
		}

		const content = this.contentCache.get(normalizedPath);
		return {
			isFile: entry.kind === "file",
			isDirectory: entry.kind === "folder",
			isSymbolicLink: false,
			mode: entry.kind === "file" ? 0o644 : 0o755,
			size: content == null ? 0 : textEncoder.encode(content).byteLength,
			mtime: new Date(entry.updatedAt),
		};
	}

	async mkdir(path: string, options?: MkdirOptions) {
		const normalizedPath = normalize_path(path);
		if (GLOB_METACHARACTER_REGEX.test(normalizedPath)) {
			throw new Error(
				`app file glob patterns are not supported: '${app_path_to_shell_path(this.appFilesMountPath, normalizedPath)}'`,
			);
		}
		const existing = await this.getEntry(normalizedPath);
		if (existing) {
			if (options?.recursive && existing.kind === "folder") {
				return;
			}
			throw new Error(
				`EEXIST: file already exists, mkdir '${app_path_to_shell_path(this.appFilesMountPath, normalizedPath)}'`,
			);
		}
		if (!this.allowAppFileTreeMkdir) {
			throw new Error(
				"Creating folders in the app file tree is available in Agent mode. Scratch space does not create durable folders.",
			);
		}
		if (!options?.recursive) {
			const parentPath = normalize_path(`${normalizedPath}/..`);
			const parent = await this.getEntry(parentPath);
			if (!parent || parent.kind !== "folder") {
				throw new Error(
					`ENOENT: no such file or directory, mkdir '${app_path_to_shell_path(this.appFilesMountPath, normalizedPath)}'`,
				);
			}
		}

		const created = (await this.ctx.runMutation(internal.files_nodes.create_folder_node_by_path, {
			workspaceId: this.ctxData.workspaceId,
			projectId: this.ctxData.projectId,
			userId: this.ctxData.userId,
			path: normalizedPath,
		})) as files_nodes_create_folder_node_by_path_Result;
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		this.rememberEntry({
			nodeId: created._yay.nodeId,
			path: normalizedPath,
			kind: "folder",
			updatedAt: Date.now(),
		});
	}

	async readdir(path: string): Promise<string[]> {
		const normalizedPath = normalize_path(path);
		const stat = await this.stat(normalizedPath);
		if (!stat.isDirectory) {
			throw new Error(
				`ENOTDIR: not a directory, scandir '${app_path_to_shell_path(this.appFilesMountPath, normalizedPath)}'`,
			);
		}
		throw new Error("app file directory enumeration is not supported; use ls --limit N or find --limit N");
	}

	async rm(path: string, options?: RmOptions) {
		if (options?.force && !(await this.exists(path))) {
			return;
		}
		throw new ReadOnlyFileSystemError(app_path_to_shell_path(this.appFilesMountPath, path));
	}

	async cp(_src: string, dest: string, _options?: CpOptions) {
		throw new ReadOnlyFileSystemError(app_path_to_shell_path(this.appFilesMountPath, dest));
	}

	async mv(_src: string, dest: string) {
		throw new ReadOnlyFileSystemError(app_path_to_shell_path(this.appFilesMountPath, dest));
	}

	resolvePath(base: string, path: string) {
		return resolve_path(base, path);
	}

	getAllPaths() {
		// Just Bash asks for glob candidates synchronously. Do not expose cached
		// app file paths here, or shell glob expansion could look successful while
		// bypassing Convex pagination and returning an incomplete path set.
		return ["/"];
	}

	async chmod(path: string, _mode: number) {
		throw new ReadOnlyFileSystemError(app_path_to_shell_path(this.appFilesMountPath, path));
	}

	async symlink(_target: string, linkPath: string) {
		throw new ReadOnlyFileSystemError(app_path_to_shell_path(this.appFilesMountPath, linkPath));
	}

	async link(_existingPath: string, newPath: string) {
		throw new ReadOnlyFileSystemError(app_path_to_shell_path(this.appFilesMountPath, newPath));
	}

	async readlink(path: string): Promise<string> {
		throw new Error(`EINVAL: invalid argument, readlink '${app_path_to_shell_path(this.appFilesMountPath, path)}'`);
	}

	async lstat(path: string) {
		return this.stat(path);
	}

	async realpath(path: string) {
		const normalizedPath = normalize_path(path);
		await this.stat(normalizedPath);
		return normalizedPath;
	}

	async utimes(path: string, _atime: Date, _mtime: Date) {
		throw new ReadOnlyFileSystemError(app_path_to_shell_path(this.appFilesMountPath, path));
	}

	rememberEntry(entry: JustBashFileNodeCacheEntry) {
		const normalizedPath = normalize_path(entry.path);
		const segments = normalizedPath.split("/").filter(Boolean);
		let currentPath = "";
		for (let index = 0; index < segments.length - 1; index++) {
			currentPath = `${currentPath}/${segments[index]}`;
			if (!this.entryCache.has(currentPath)) {
				this.entryCache.set(currentPath, {
					path: currentPath,
					kind: "folder",
					updatedAt: entry.updatedAt,
				});
			}
		}
		this.entryCache.set(normalizedPath, {
			...entry,
			path: normalizedPath,
		});
	}

	async getEntry(path: string) {
		const normalizedPath = normalize_path(path);
		const cached = this.entryCache.get(normalizedPath);
		if (cached && (normalizedPath === "/" || cached.nodeId != null)) {
			return cached;
		}

		const node = (await this.ctx.runQuery(internal.files_nodes.get_by_path, {
			workspaceId: this.ctxData.workspaceId,
			projectId: this.ctxData.projectId,
			path: normalizedPath,
		})) as files_nodes_get_by_path_Result;

		if (!node) {
			return null;
		}

		const entry = {
			nodeId: node._id,
			path: node.path,
			kind: node.kind,
			updatedAt: node.updatedAt,
			updatedBy: node.updatedBy,
			contentType: node.contentType,
		} satisfies JustBashFileNodeCacheEntry;
		this.rememberEntry(entry);
		return entry;
	}
}

/**
 * Provide the empty root filesystem that hosts top-level mounts like `/home` and `/tmp`.
 */
class ReadOnlyBaseFs implements IFileSystem {
	async readFile(path: string, _options?: Parameters<IFileSystem["readFile"]>[1]): Promise<string> {
		throw new Error(`ENOENT: no such file or directory, open '${normalize_path(path)}'`);
	}

	async readFileBuffer(path: string): Promise<Uint8Array> {
		throw new Error(`ENOENT: no such file or directory, open '${normalize_path(path)}'`);
	}

	async writeFile(path: string, _content: FileContent, _options?: Parameters<IFileSystem["writeFile"]>[2]) {
		throw new ReadOnlyFileSystemError(path);
	}

	async appendFile(path: string, _content: FileContent, _options?: Parameters<IFileSystem["appendFile"]>[2]) {
		throw new ReadOnlyFileSystemError(path);
	}

	async exists(path: string) {
		return normalize_path(path) === "/";
	}

	async stat(path: string): Promise<FsStat> {
		const normalizedPath = normalize_path(path);
		if (normalizedPath !== "/") {
			throw new Error(`ENOENT: no such file or directory, stat '${normalizedPath}'`);
		}

		return {
			isFile: false,
			isDirectory: true,
			isSymbolicLink: false,
			mode: 0o755,
			size: 0,
			mtime: new Date(),
		};
	}

	async mkdir(path: string, options?: MkdirOptions) {
		if (options?.recursive && normalize_path(path) === "/") {
			return;
		}
		throw new ReadOnlyFileSystemError(path);
	}

	async readdir(path: string) {
		const normalizedPath = normalize_path(path);
		if (normalizedPath !== "/") {
			throw new Error(`ENOENT: no such file or directory, scandir '${normalizedPath}'`);
		}
		return [];
	}

	async rm(path: string, options?: RmOptions) {
		if (options?.force && !(await this.exists(path))) {
			return;
		}
		throw new ReadOnlyFileSystemError(path);
	}

	async cp(_src: string, dest: string, _options?: CpOptions) {
		throw new ReadOnlyFileSystemError(dest);
	}

	async mv(_src: string, dest: string) {
		throw new ReadOnlyFileSystemError(dest);
	}

	resolvePath(base: string, path: string) {
		return resolve_path(base, path);
	}

	getAllPaths() {
		return ["/"];
	}

	async chmod(path: string, _mode: number) {
		throw new ReadOnlyFileSystemError(path);
	}

	async symlink(_target: string, linkPath: string) {
		throw new ReadOnlyFileSystemError(linkPath);
	}

	async link(_existingPath: string, newPath: string) {
		throw new ReadOnlyFileSystemError(newPath);
	}

	async readlink(path: string): Promise<string> {
		throw new Error(`EINVAL: invalid argument, readlink '${normalize_path(path)}'`);
	}

	async lstat(path: string) {
		return this.stat(path);
	}

	async realpath(path: string) {
		const normalizedPath = normalize_path(path);
		await this.stat(normalizedPath);
		return normalizedPath;
	}

	async utimes(path: string, _atime: Date, _mtime: Date) {
		throw new ReadOnlyFileSystemError(path);
	}
}

export const run = internalAction({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		workspaceName: v.string(),
		projectName: v.string(),
		userId: v.id("users"),
		threadId: v.id("ai_chat_threads"),
		command: v.string(),
		allowAppFileTreeMkdir: v.boolean(),
	},
	returns: v.object({
		title: v.string(),
		output: v.string(),
		stdout: v.string(),
		stderr: v.string(),
		metadata: v.object({
			command: v.string(),
			cwd: v.string(),
			nextCwd: v.string(),
			exitCode: v.number(),
			stdoutTruncated: v.boolean(),
			stderrTruncated: v.boolean(),
			stdoutLength: v.number(),
			stderrLength: v.number(),
			pathIndexTruncated: v.boolean(),
		}),
	}),
	handler: async (ctx, args) => {
		const threadState = (await ctx.runQuery(internal.ai_chat.get_thread_state, {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			threadId: args.threadId,
		})) as ai_chat_get_thread_state_Result;

		const execution = await action_run(ctx, {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			workspaceName: args.workspaceName,
			projectName: args.projectName,
			userId: args.userId,
			command: args.command,
			allowAppFileTreeMkdir: args.allowAppFileTreeMkdir,
			persistedCwd: threadState.bashCwd,
		});

		await ctx.runMutation(internal.ai_chat.set_thread_state, {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			threadId: args.threadId,
			userId: args.userId,
			patch: {
				bashCwd: execution.nextPersistedCwd,
			},
		});

		return {
			title: execution.title,
			output: execution.output,
			stdout: execution.stdout,
			stderr: execution.stderr,
			metadata: execution.metadata,
		};
	},
});

async function action_run(
	ctx: ActionCtx,
	args: {
		workspaceId: string;
		projectId: string;
		workspaceName: string;
		projectName: string;
		userId: Id<"users">;
		command: string;
		allowAppFileTreeMkdir: boolean;
		persistedCwd: string;
	},
) {
	// Workspace and project names are validated slugs, so they are stable shell
	// path segments and do not need path-segment encoding here.
	const appFilesMountPath = normalize_path(`${MOUNT_ROOT}/${args.workspaceName}/${args.projectName}`);
	let cwd = expand_persisted_bash_cwd(args.persistedCwd);

	const workspaceFs = new WorkspaceFs({
		ctx,
		ctxData: {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			workspaceName: args.workspaceName,
			projectName: args.projectName,
			userId: args.userId,
		},
		appFilesMountPath,
		allowAppFileTreeMkdir: args.allowAppFileTreeMkdir,
	});

	const fs = new MountableFs({
		base: new ReadOnlyBaseFs(),
		mounts: [
			{ mountPoint: appFilesMountPath, filesystem: workspaceFs },
			{ mountPoint: TMP_MOUNT, filesystem: new InMemoryFs() },
		],
	});

	try {
		const cwdStat = await fs.stat(cwd);
		if (!cwdStat.isDirectory) {
			cwd = HOME;
		}
	} catch {
		cwd = HOME;
	}

	const bash = new Bash({
		fs,
		cwd,
		env: {
			PWD: cwd,
			HOME: HOME,
		},
		commands: [...ALLOWED_COMMANDS],
		customCommands: [
			search_command_create(ctx, workspaceFs.ctxData, appFilesMountPath),
			ls_command_create(ctx, workspaceFs, appFilesMountPath),
			find_command_create(ctx, workspaceFs.ctxData, appFilesMountPath),
			create_tree_command(ctx, workspaceFs.ctxData, appFilesMountPath),
			create_grep_command(ctx, workspaceFs.ctxData, appFilesMountPath),
			create_cat_command(ctx, workspaceFs.ctxData, appFilesMountPath),
			create_reader_guard_command(ctx, workspaceFs.ctxData, "head", appFilesMountPath),
			create_reader_guard_command(ctx, workspaceFs.ctxData, "tail", appFilesMountPath),
			create_reader_guard_command(ctx, workspaceFs.ctxData, "wc", appFilesMountPath),
			create_stat_command(ctx, workspaceFs.ctxData, appFilesMountPath),
			...create_stream_utility_commands(appFilesMountPath),
			create_sed_command(ctx, workspaceFs.ctxData, appFilesMountPath),
			create_touch_command(appFilesMountPath),
			create_rm_command(appFilesMountPath),
			create_cp_command(appFilesMountPath),
			create_mv_command(appFilesMountPath),
			create_tee_command(appFilesMountPath),
			create_nested_shell_command("bash", appFilesMountPath),
			create_nested_shell_command("sh", appFilesMountPath),
			create_xargs_command(),
			create_which_command(),
		],
		executionLimits: {
			maxCommandCount: 200,
			maxLoopIterations: 10_000,
			maxCallDepth: 50,
			maxOutputSize: 250_000,
			maxHeredocSize: 250_000,
		},
	});

	const result = await bash
		.exec(`set -f\n${args.command}`, {
			cwd,
			env: {
				PWD: cwd,
				HOME: HOME,
			},
		})
		.catch((error: unknown) => ({
			stdout: "",
			stderr: `${error instanceof Error ? error.message : String(error)}\n`,
			exitCode: 1,
			env: {
				PWD: cwd,
			},
		}));

	const rawNextCwd = result.env.PWD;
	let nextPersistedCwd = collapse_bash_cwd_for_persistence(rawNextCwd);
	let nextCwd = nextPersistedCwd == null ? HOME : expand_persisted_bash_cwd(nextPersistedCwd);
	let stderr = result.stderr;
	const commandNotFoundPattern = /: command not found$/m;
	const redirectsStderrToStdout = /(^|[\s;&|])2\s*>\s*&\s*1(?=$|[\s;&|])/.test(args.command);
	if (commandNotFoundPattern.test(stderr) || (redirectsStderrToStdout && commandNotFoundPattern.test(result.stdout))) {
		stderr +=
			"bash: run 'help' to list available commands; app files are DB-backed — use search/grep for content and find/ls for paths.\n";
	}
	try {
		const nextCwdStat = await fs.stat(nextCwd);
		if (!nextCwdStat.isDirectory || nextPersistedCwd == null) {
			nextPersistedCwd = DEFAULT_CWD;
			nextCwd = HOME;
			stderr += `bash: cwd '${rawNextCwd}' is not persisted; resetting to ${HOME}\n`;
		}
	} catch {
		nextPersistedCwd = DEFAULT_CWD;
		nextCwd = HOME;
		stderr += `bash: cwd '${rawNextCwd}' is invalid; resetting to ${HOME}\n`;
	}

	const stdoutLength = result.stdout.length;
	const stderrLength = stderr.length;
	const stdout = truncate_output(result.stdout);
	const truncatedStderr = truncate_output(stderr);

	return {
		nextPersistedCwd,
		title: `exit ${result.exitCode} · ${nextCwd}`,
		output: format_tool_output({
			command: args.command,
			cwd,
			nextCwd,
			exitCode: result.exitCode,
			stdout: stdout.value,
			stderr: truncatedStderr.value,
		}),
		stdout: stdout.value,
		stderr: truncatedStderr.value,
		metadata: {
			command: args.command,
			cwd,
			nextCwd,
			exitCode: result.exitCode,
			stdoutTruncated: stdout.truncated,
			stderrTruncated: truncatedStderr.truncated,
			stdoutLength,
			stderrLength,
			pathIndexTruncated: workspaceFs.pathIndexTruncated,
		},
	};
}

// Vitest sets NODE_ENV to "test"; Convex's bundler defines it as "production",
// so keep that check first to let esbuild erase `import.meta.vitest` before analysis.
if (process.env.NODE_ENV === "test" && import.meta.vitest) {
	const { describe, test, expect, vi } = import.meta.vitest;

	const test_user_id = "user_1" as Id<"users">;

	const test_ctx_data = {
		workspaceId: "app_workspace_test_1",
		projectId: "app_project_test_1",
		workspaceName: "personal",
		projectName: "home",
		userId: test_user_id,
	} as const;
	const test_app_files_mount = "/home/cloud-usr/w/personal/home";

	const makeCtx = (
		runQueryImpl: (ref: unknown, args: Record<string, unknown>) => Promise<unknown>,
		args?: {
			runMutationImpl?: (ref: unknown, args: Record<string, unknown>) => Promise<unknown>;
			runActionImpl?: (ref: unknown, args: Record<string, unknown>) => Promise<unknown>;
		},
	) => {
		const runQuery = vi.fn(runQueryImpl);
		const runMutation = vi.fn(args?.runMutationImpl ?? (async () => null));
		const runAction = vi.fn(args?.runActionImpl ?? runQueryImpl);
		const ctx = {
			runQuery,
			runMutation,
			runAction,
		} as unknown as ActionCtx;
		return { ctx, runQuery, runMutation, runAction };
	};

	describe("truncate_output", () => {
		test("keeps empty output unchanged", () => {
			const result = truncate_output("");

			expect(result).toEqual({
				value: "",
				truncated: false,
			});
		});

		test("keeps output below the limit unchanged", () => {
			const value = "x".repeat(OUTPUT_LIMIT - 1);

			const result = truncate_output(value);

			expect(result.value).toBe(value);
			expect(result.value.length).toBe(OUTPUT_LIMIT - 1);
			expect(result.truncated).toBe(false);
		});

		test("keeps output exactly at the limit unchanged", () => {
			const value = "x".repeat(OUTPUT_LIMIT);

			const result = truncate_output(value);

			expect(result.value).toBe(value);
			expect(result.value.length).toBe(OUTPUT_LIMIT);
			expect(result.value).not.toContain("[truncated after");
			expect(result.truncated).toBe(false);
		});

		test("truncates output one character over the limit", () => {
			const value = `${"x".repeat(OUTPUT_LIMIT)}y`;

			const result = truncate_output(value);

			expect(result.value).toBe(`${"x".repeat(OUTPUT_LIMIT)}\n\n[truncated after ${OUTPUT_LIMIT} characters]`);
			expect(result.value).not.toContain("y");
			expect(result.truncated).toBe(true);
		});

		test("keeps only the first limit characters from much larger output", () => {
			const prefix = "prefix:";
			const value = `${prefix}${"x".repeat(OUTPUT_LIMIT - prefix.length)}POST_LIMIT_SENTINEL${"y".repeat(OUTPUT_LIMIT)}`;

			const result = truncate_output(value);

			expect(result.value.startsWith(prefix)).toBe(true);
			expect(result.value).toContain(`[truncated after ${OUTPUT_LIMIT} characters]`);
			expect(result.value).not.toContain("POST_LIMIT_SENTINEL");
			expect(result.value.slice(0, OUTPUT_LIMIT)).toBe(value.slice(0, OUTPUT_LIMIT));
			expect(result.truncated).toBe(true);
		});

		test("preserves a trailing Next page command when output is truncated", () => {
			const continuation = "More results. Next page: search --limit 1 --cursor cursor-1 common-token";
			const value = `${"x".repeat(OUTPUT_LIMIT + 100)}\n${continuation}\n`;

			const result = truncate_output(value);

			expect(result.value).toContain(`[truncated after ${OUTPUT_LIMIT} characters]`);
			expect(result.value).toContain(continuation);
			expect(result.value.endsWith(continuation)).toBe(true);
			expect(result.truncated).toBe(true);
		});
	});

	describe("format_tool_output", () => {
		test("renders a terminal prompt with stdout and exit status", () => {
			const result = format_tool_output({
				command: "pwd",
				cwd: "/home/cloud-usr",
				nextCwd: "/home/cloud-usr",
				exitCode: 0,
				stdout: "/home/cloud-usr\n",
				stderr: "",
			});

			expect(result).toBe("/home/cloud-usr$ pwd\n\n/home/cloud-usr\n\nexit 0");
		});

		test("normalizes line endings and trims trailing newlines", () => {
			const result = format_tool_output({
				command: "printf lines",
				cwd: "/home/cloud-usr",
				nextCwd: "/home/cloud-usr",
				exitCode: 0,
				stdout: "one\r\ntwo\r\n\r\n",
				stderr: "warn\r\n\r\n",
			});

			expect(result).toBe("/home/cloud-usr$ printf lines\n\none\ntwo\n\nwarn\n\nexit 0");
		});

		test("makes cwd changes explicit", () => {
			const result = format_tool_output({
				command: "cd docs",
				cwd: "/home/cloud-usr",
				nextCwd: "/home/cloud-usr/w/personal/home/docs",
				exitCode: 0,
				stdout: "",
				stderr: "",
			});

			expect(result).toBe(
				"/home/cloud-usr$ cd docs\n\nexit 0 · cwd changed: /home/cloud-usr -> /home/cloud-usr/w/personal/home/docs",
			);
		});

		test("renders stderr without the old XML-like envelope", () => {
			const result = format_tool_output({
				command: "cat missing.md",
				cwd: "/home/cloud-usr",
				nextCwd: "/home/cloud-usr",
				exitCode: 1,
				stdout: "",
				stderr: "No such file\n",
			});

			expect(result).toBe("/home/cloud-usr$ cat missing.md\n\nNo such file\n\nexit 1");
			expect(result).not.toContain("<stderr>");
		});
	});

	describe("action_run", () => {
		const now = Date.now();
		const workspaceItemsInitial = [
			{ path: "/docs", kind: "folder", updatedAt: now, depthTruncated: false },
			{
				path: "/docs/readme.md",
				kind: "file",
				updatedAt: now,
				depthTruncated: false,
				contentType: "text/markdown;charset=utf-8",
			},
			{
				path: "/docs/tutorial.md",
				kind: "file",
				updatedAt: now,
				depthTruncated: false,
				contentType: "text/markdown;charset=utf-8",
			},
			{
				path: "/docs/nested",
				kind: "folder",
				updatedAt: now,
				depthTruncated: false,
			},
			{
				path: "/docs/nested/deep.md",
				kind: "file",
				updatedAt: now,
				depthTruncated: false,
				contentType: "text/markdown;charset=utf-8",
			},
			{
				path: "/source.pdf",
				kind: "file",
				updatedAt: now,
				depthTruncated: false,
				contentType: "application/pdf",
			},
			{
				path: "/uploaded.md",
				kind: "file",
				updatedAt: now,
				depthTruncated: false,
				contentType: "application/octet-stream",
			},
			{
				path: "/reports",
				kind: "folder",
				updatedAt: now,
				depthTruncated: false,
			},
			{
				path: "/reports/summary.md",
				kind: "file",
				updatedAt: now,
				depthTruncated: false,
				contentType: "text/markdown;charset=utf-8",
			},
		] as const;

		function createBashRunner(args?: {
			initialCwd?: string;
			listTruncated?: boolean;
			allowAppFileTreeMkdir?: boolean;
			extraItems?: Array<{
				path: string;
				kind: "folder" | "file";
				updatedAt: number;
				updatedBy?: string;
				depthTruncated: boolean;
				contentType?: string;
				size?: number;
				servedSize?: number;
			}>;
			extraFileContents?: Record<string, string>;
			scanTruncatedPaths?: string[];
		}) {
			let cwd = args?.initialCwd ?? "~";
			const scanTruncatedPaths = new Set(args?.scanTruncatedPaths ?? []);
			const workspaceItems: Array<{
				path: string;
				kind: "folder" | "file";
				updatedAt: number;
				updatedBy?: string;
				depthTruncated: boolean;
				contentType?: string;
				size?: number;
				servedSize?: number;
			}> = [...workspaceItemsInitial, ...(args?.extraItems ?? [])];
			const runQueryImpl = async (_ref: unknown, queryArgs: Record<string, unknown>) => {
				const itemName = (path: string) => path.split("/").filter(Boolean).at(-1) ?? "";
				const itemExtension = (path: string) => {
					const name = itemName(path);
					const dotIndex = name.lastIndexOf(".");
					return dotIndex <= 0 || dotIndex === name.length - 1 ? null : name.slice(dotIndex + 1).toLowerCase();
				};
				const nodeIdForPath = (path: string) => (path === "/" ? "root" : `node:${path}`);
				const pathFromNodeId = (nodeId: unknown) => {
					if (nodeId === "root") return "/";
					return typeof nodeId === "string" && nodeId.startsWith("node:") ? nodeId.slice("node:".length) : null;
				};
				const parentPath = (path: string) => {
					const segments = path.split("/").filter(Boolean);
					return segments.length <= 1 ? "/" : `/${segments.slice(0, -1).join("/")}`;
				};
				const sortBy = <T>(items: T[], order: unknown, compare: (a: T, b: T) => number) =>
					[...items].sort((a, b) => (order === "desc" ? -1 : 1) * compare(a, b));
				const pageItems = <T>(items: T[], limitValue: unknown, cursorValue: unknown) => {
					const limit =
						typeof limitValue === "number" && Number.isFinite(limitValue) ? Math.max(1, Math.trunc(limitValue)) : 100;
					const cursor =
						typeof cursorValue === "string" && cursorValue.startsWith("cursor-") ? Number(cursorValue.slice(7)) : 0;
					const start = Number.isFinite(cursor) ? cursor : 0;
					const page = items.slice(start, start + limit);
					const nextStart = start + limit;
					return {
						page,
						continueCursor: nextStart < items.length ? `cursor-${nextStart}` : "",
						isDone: nextStart >= items.length,
					};
				};

				if (_ref === internal.files_nodes.search_paths_paginated) {
					const pathQuery = String(queryArgs.pathQuery ?? "").toLowerCase();
					const parentPathFilter = queryArgs.parentId == null ? null : pathFromNodeId(queryArgs.parentId);
					const kindFilter = typeof queryArgs.kind === "string" ? queryArgs.kind : null;
					const paged = pageItems(
						workspaceItems.filter((item) => {
							if (pathQuery !== "" && !item.path.toLowerCase().includes(pathQuery)) {
								return false;
							}
							if (parentPathFilter != null && parentPath(item.path) !== parentPathFilter) {
								return false;
							}
							if (kindFilter != null && item.kind !== kindFilter) {
								return false;
							}
							return true;
						}),
						queryArgs.numItems,
						queryArgs.cursor,
					);
					return {
						items: paged.page.map((item) => ({
							path: item.path,
							kind: item.kind,
							updatedAt: item.updatedAt,
						})),
						continueCursor: paged.continueCursor,
						isDone: paged.isDone,
					};
				}

				if ("lowercaseExtension" in queryArgs) {
					const path = typeof queryArgs.path === "string" ? queryArgs.path : "/";
					const extension = String(queryArgs.lowercaseExtension ?? "").toLowerCase();
					const target = workspaceItems.find((item) => item.path === path);
					const baseDepth = path === "/" ? 0 : path.split("/").filter(Boolean).length;
					const itemRelativeDepth = (itemPath: string) => {
						const itemDepth = itemPath === "/" ? 0 : itemPath.split("/").filter(Boolean).length;
						return itemDepth - baseDepth;
					};
					const items =
						target?.kind === "file"
							? [target]
							: workspaceItems.filter((item) => {
									if (path === "/") return true;
									return item.path.startsWith(`${path}/`);
								});
					const paged = pageItems(
						items
							.filter((item) => item.kind === "file" && itemExtension(item.path) === extension)
							.filter((item) => {
								if (typeof queryArgs.minDepth === "number" && itemRelativeDepth(item.path) < queryArgs.minDepth) {
									return false;
								}
								if (typeof queryArgs.maxDepth === "number" && itemRelativeDepth(item.path) > queryArgs.maxDepth) {
									return false;
								}
								return true;
							})
							.sort((a, b) => a.path.localeCompare(b.path)),
						queryArgs.numItems,
						queryArgs.cursor,
					);
					return {
						items: paged.page.map((item) => ({
							path: item.path,
							kind: "file" as const,
							updatedAt: item.updatedAt,
						})),
						continueCursor: paged.continueCursor,
						isDone: paged.isDone,
					};
				}

				if (_ref === internal.files_nodes.list_dir_children_by_parent_recency_paginated && "parentId" in queryArgs) {
					const path = pathFromNodeId(queryArgs.parentId);
					const paged = pageItems(
						sortBy(
							workspaceItems.filter((item) => parentPath(item.path) === path),
							queryArgs.order,
							(a, b) => a.updatedAt - b.updatedAt || itemName(a.path).localeCompare(itemName(b.path)),
						),
						queryArgs.numItems,
						queryArgs.cursor,
					);
					return {
						items: paged.page.map((item) => ({
							name: itemName(item.path),
							path: item.path,
							kind: item.kind,
							updatedAt: item.updatedAt,
							updatedBy: item.updatedBy ?? test_user_id,
							contentType: item.contentType,
						})),
						continueCursor: paged.continueCursor,
						isDone: paged.isDone,
					};
				}

				if ("numItems" in queryArgs && "parentId" in queryArgs) {
					const path = pathFromNodeId(queryArgs.parentId);
					const paged = pageItems(
						sortBy(
							workspaceItems.filter((item) => parentPath(item.path) === path),
							queryArgs.order,
							(a, b) => itemName(a.path).localeCompare(itemName(b.path)),
						),
						queryArgs.numItems,
						queryArgs.cursor,
					);
					return {
						items: paged.page.map((item) => ({
							name: itemName(item.path),
							path: item.path,
							kind: item.kind,
							updatedAt: item.updatedAt,
							updatedBy: item.updatedBy ?? test_user_id,
							contentType: item.contentType,
						})),
						continueCursor: paged.continueCursor,
						isDone: paged.isDone,
					};
				}

				if (_ref === internal.files_nodes.text_search_files_page_has_items) {
					return true;
				}

				if ("query" in queryArgs) {
					const prefix = typeof queryArgs.pathPrefix === "string" ? queryArgs.pathPrefix : null;
					const underScope = (path: string) => prefix === null || path === prefix || path.startsWith(`${prefix}/`);
					const fixtures: Record<string, Array<{ path: string; markdownChunk: string; chunkFlags: number }>> = {
						"unique-token": [
							{ path: "/docs/readme.md", markdownChunk: "A chunk with unique-token inside.", chunkFlags: 0 },
						],
						"paged-token": [
							{ path: "/docs/readme.md", markdownChunk: "First paged-token chunk.", chunkFlags: 0 },
							{ path: "/docs/tutorial.md", markdownChunk: "Second paged-token chunk.", chunkFlags: 0 },
						],
						"code-token": [
							{
								path: "/docs/readme.md",
								markdownChunk: "const codeToken = 1;",
								chunkFlags: files_chunk_BITMASK_FLAGS.isCode,
							},
						],
						"table-token": [
							{
								path: "/docs/readme.md",
								markdownChunk: "| table-token | x |",
								chunkFlags: files_chunk_BITMASK_FLAGS.isTable,
							},
						],
					};
					const paged = pageItems(
						(fixtures[String(queryArgs.query)] ?? []).filter((fixture) => underScope(fixture.path)),
						queryArgs.numItems,
						queryArgs.cursor,
					);
					return {
						items: paged.page.map((fixture, index) => ({
							path: fixture.path,
							markdownChunk: fixture.markdownChunk,
							chunkIndex: index,
							startIndex: 0,
							endIndex: fixture.markdownChunk.length,
							lineStart: 1,
							lineEnd: 1,
							chunkFlags: fixture.chunkFlags,
							hasChunkAbove: false,
							hasChunkBelow: false,
						})),
						continueCursor: paged.continueCursor,
						isDone: paged.isDone,
					};
				}

				if ("numItems" in queryArgs && "path" in queryArgs) {
					const path = typeof queryArgs.path === "string" ? queryArgs.path : "/";
					const target = workspaceItems.find((item) => item.path === path);
					const baseDepth = path === "/" ? 0 : path.split("/").filter(Boolean).length;
					const itemRelativeDepth = (itemPath: string) => {
						const itemDepth = itemPath === "/" ? 0 : itemPath.split("/").filter(Boolean).length;
						return itemDepth - baseDepth;
					};
					const items =
						target?.kind === "file"
							? [target]
							: workspaceItems.filter((item) => {
									if (path === "/") return true;
									return item.path.startsWith(`${path}/`);
								});
					const filteredItems = items.filter((item) => {
						if (queryArgs.kind === "file" && item.kind !== "file") return false;
						if (queryArgs.kind === "folder" && item.kind !== "folder") return false;
						if (typeof queryArgs.minDepth === "number" && itemRelativeDepth(item.path) < queryArgs.minDepth)
							return false;
						if (typeof queryArgs.maxDepth === "number" && itemRelativeDepth(item.path) > queryArgs.maxDepth)
							return false;
						return true;
					});
					const paged = pageItems(
						sortBy(filteredItems, queryArgs.order, (a, b) => a.path.localeCompare(b.path)),
						queryArgs.numItems,
						queryArgs.cursor,
					);
					return {
						items: paged.page.map((item) => ({
							path: item.path,
							kind: item.kind,
							updatedAt: item.updatedAt,
							updatedBy: item.updatedBy ?? test_user_id,
							contentType: item.contentType,
						})),
						continueCursor: paged.continueCursor,
						isDone: paged.isDone,
					};
				}

				if ("numItems" in queryArgs && "pathPrefix" in queryArgs) {
					const pathPrefix = typeof queryArgs.pathPrefix === "string" ? queryArgs.pathPrefix : "/";
					const paged = pageItems(
						workspaceItems
							.filter((item) => item.path.startsWith(pathPrefix))
							.filter((item) => {
								if (queryArgs.kind === "file" && item.kind !== "file") return false;
								if (queryArgs.kind === "folder" && item.kind !== "folder") return false;
								return true;
							})
							.sort((a, b) => a.path.localeCompare(b.path)),
						queryArgs.numItems,
						queryArgs.cursor,
					);
					return {
						items: paged.page.map((item) => ({
							path: item.path,
							kind: item.kind,
							updatedAt: item.updatedAt,
						})),
						continueCursor: paged.continueCursor,
						isDone: paged.isDone,
					};
				}

				if ("maxDepth" in queryArgs) {
					return {
						items: workspaceItems
							.filter((item) => {
								if (queryArgs.path === "/") return true;
								return item.path.startsWith(`${queryArgs.path}/`);
							})
							.map((item) => ({
								path: item.path,
								kind: item.kind,
								updatedAt: item.updatedAt,
								depthTruncated: item.depthTruncated,
							})),
						truncated: args?.listTruncated ?? false,
					};
				}

				// list_recent_paginated: project-wide, numItems but no parentId/path/pathPrefix.
				if ("numItems" in queryArgs) {
					const paged = pageItems(
						sortBy(
							workspaceItems,
							queryArgs.order,
							(a, b) => a.updatedAt - b.updatedAt || a.path.localeCompare(b.path),
						),
						queryArgs.numItems,
						queryArgs.cursor,
					);
					return {
						items: paged.page.map((item) => ({
							path: item.path,
							kind: item.kind,
							updatedAt: item.updatedAt,
							updatedBy: item.updatedBy ?? test_user_id,
							contentType: item.contentType,
						})),
						continueCursor: paged.continueCursor,
						isDone: paged.isDone,
					};
				}

				// get_bash_served_byte_size: pending-aware reader oversize gate (the only query that
				// takes userId + path). `servedSize` simulates an unsaved pending overlay diverging
				// from the committed `size`; otherwise sizing falls back to committed `size`.
				if ("userId" in queryArgs && "path" in queryArgs) {
					const targetPath = typeof queryArgs.path === "string" ? queryArgs.path : "";
					const target = workspaceItems.find((entry) => entry.path === targetPath);
					if (!target || target.kind !== "file") return null;
					if (typeof target.servedSize === "number") {
						return { servedBytes: target.servedSize, pending: true };
					}
					return { servedBytes: typeof target.size === "number" ? target.size : 0, pending: false };
				}

				const path = queryArgs.path;
				if (path === "/") {
					return {
						nodeId: "root",
						path: "/",
						name: "",
						kind: "folder",
						updatedAt: 0,
					};
				}
				if (typeof path !== "string") {
					return null;
				}
				const item = workspaceItems.find((entry) => entry.path === path);
				return item
					? {
							nodeId: nodeIdForPath(item.path),
							name: itemName(item.path),
							path: item.path,
							kind: item.kind,
							updatedAt: item.updatedAt,
							updatedBy: item.updatedBy ?? test_user_id,
							contentType: item.contentType,
							size: item.size,
						}
					: null;
			};

			const { ctx, runQuery, runMutation, runAction } = makeCtx(runQueryImpl, {
				runMutationImpl: async (_ref, mutationArgs) => {
					if (typeof mutationArgs.path === "string") {
						const existing = workspaceItems.find((item) => item.path === mutationArgs.path);
						if (existing?.kind === "folder") {
							return { _yay: { nodeId: "folder_existing", exists: true } };
						}
						if (existing?.kind === "file") {
							return { _nay: { message: "A file already exists at this path." } };
						}
						workspaceItems.push({
							path: mutationArgs.path,
							kind: "folder",
							updatedAt: Date.now(),
							updatedBy: test_user_id,
							depthTruncated: false,
						});
						return { _yay: { nodeId: "folder_created", exists: false } };
					}
					return null;
				},
				runActionImpl: async (_ref, actionArgs) => {
					const grepContents: Record<string, string> = {
						"/docs/readme.md": "# Readme\nunique-token here\nmore unique-token below\n",
						"/docs/tutorial.md": "zeta\nalpha\nALPHA\n",
						...(args?.extraFileContents ?? {}),
					};
					// grep_app_file_scan: context (-A/-B/-C) and/or inverted (-v) scan of a simulated file.
					if ("invert" in actionArgs) {
						const path = typeof actionArgs.path === "string" ? actionArgs.path : "";
						const text = grepContents[path];
						if (text === undefined) return null;
						const pattern = String(actionArgs.pattern);
						const ignoreCase = actionArgs.ignoreCase === true;
						const invert = actionArgs.invert === true;
						const before = typeof actionArgs.before === "number" ? actionArgs.before : 0;
						const after = typeof actionArgs.after === "number" ? actionArgs.after : 0;
						const allLines = text.endsWith("\n") ? text.split("\n").slice(0, -1) : text.split("\n");
						const needle = ignoreCase ? pattern.toLowerCase() : pattern;
						const selected: number[] = [];
						for (let i = 0; i < allLines.length; i++) {
							const isMatch = (ignoreCase ? allLines[i]!.toLowerCase() : allLines[i]!).includes(needle);
							if (invert ? !isMatch : isMatch) selected.push(i);
						}
						const matched = new Set(selected);
						const include = new Set<number>();
						for (const idx of selected) {
							for (let i = Math.max(0, idx - before); i <= Math.min(allLines.length - 1, idx + after); i++)
								include.add(i);
						}
						const lines = [...include]
							.sort((a, b) => a - b)
							.map((i) => ({ lineNumber: i + 1, line: allLines[i]!, matched: matched.has(i) }));
						return {
							nodeId: `node:${path}`,
							lines,
							selectedCount: selected.length,
							scanTruncated: scanTruncatedPaths.has(path),
						};
					}
					// grep_app_file: substring scan of a simulated file's content.
					if ("pattern" in actionArgs) {
						const path = typeof actionArgs.path === "string" ? actionArgs.path : "";
						const text = grepContents[path];
						if (text === undefined) return null;
						const pattern = String(actionArgs.pattern);
						const ignoreCase = actionArgs.ignoreCase === true;
						const lines = text.endsWith("\n") ? text.split("\n").slice(0, -1) : text.split("\n");
						const needle = ignoreCase ? pattern.toLowerCase() : pattern;
						const matches = lines
							.map((line, index) => ({ lineNumber: index + 1, line }))
							.filter((m) => (ignoreCase ? m.line.toLowerCase() : m.line).includes(needle));
						return { nodeId: `node:${path}`, matches, scanTruncated: scanTruncatedPaths.has(path) };
					}
					// read_file_head_lines: bounded leading-lines read for large files.
					if ("maxLines" in actionArgs) {
						// Simulate a 1000-line file ("line 1".."line 1000") for bounded-read paging tests.
						const path = typeof actionArgs.path === "string" ? actionArgs.path : "";
						const item = workspaceItems.find((entry) => entry.path === path);
						if (!item || item.kind !== "file") {
							return null;
						}
						const TOTAL = 1000;
						const maxLines = typeof actionArgs.maxLines === "number" ? actionArgs.maxLines : 10;
						if ("startLine" in actionArgs) {
							// read_file_line_range
							const startLine = typeof actionArgs.startLine === "number" ? actionArgs.startLine : 1;
							const start = Math.max(1, startLine);
							const end = Math.min(TOTAL, start + maxLines - 1);
							const lines: string[] = [];
							for (let line = start; line <= end; line++) lines.push(`line ${line}`);
							return {
								nodeId: "file_big",
								content: lines.length ? `${lines.join("\n")}\n` : "",
								moreLines: end < TOTAL,
								scanTruncated: scanTruncatedPaths.has(path),
							};
						}
						// read_file_tail_lines: last maxLines
						const start = Math.max(1, TOTAL - maxLines + 1);
						const lines: string[] = [];
						for (let line = start; line <= TOTAL; line++) lines.push(`line ${line}`);
						return {
							nodeId: "file_big",
							content: `${lines.join("\n")}\n`,
							moreLines: TOTAL > maxLines,
							scanTruncated: scanTruncatedPaths.has(path),
						};
					}
					// read_file_content_stats fixtures for the multi-file wc batch (per-file + total via
					// the bounded stats path). Keyed by path; only wc touches these paths.
					const wcStatsFixtures: Record<
						string,
						{ lineCount: number; wordCount: number; charCount: number; byteCount: number; exact: boolean }
					> = {
						"/wc/a.md": { lineCount: 3, wordCount: 5, charCount: 20, byteCount: 20, exact: true },
						"/wc/b.md": { lineCount: 2, wordCount: 4, charCount: 12, byteCount: 12, exact: true },
						"/wc/windowed.md": { lineCount: 40, wordCount: 80, charCount: 8000, byteCount: 12000, exact: false },
					};
					const wcStats = typeof actionArgs.path === "string" ? wcStatsFixtures[actionArgs.path] : undefined;
					if (wcStats) {
						return { nodeId: `node:${actionArgs.path}`, ...wcStats };
					}
					// read_file_content_stats for an oversized file (no maxLines/startLine): the only
					// no-content-read action hitting the simulated big file is the wc stats call.
					if (actionArgs.path === "/big.md") {
						const item = workspaceItems.find((entry) => entry.path === "/big.md");
						const byteCount = typeof item?.size === "number" ? item.size : 9000;
						return {
							nodeId: "file_big",
							lineCount: 1000,
							wordCount: 2000,
							charCount: byteCount,
							byteCount,
							exact: true,
						};
					}
					if (actionArgs.path === "/docs/readme.md") {
						return {
							nodeId: "file_1",
							displayNodeId: "file_1",
							content: "# Readme\nunique-token\n",
							pendingUpdateId: null,
						};
					}
					if (actionArgs.path === "/docs/tutorial.md") {
						return {
							nodeId: "file_2",
							displayNodeId: "file_2",
							content: "zeta\nalpha\nalpha\n",
							pendingUpdateId: null,
						};
					}
					if (actionArgs.path === "/docs/nested/deep.md") {
						return {
							nodeId: "file_3",
							displayNodeId: "file_3",
							content: "one:two\nthree:four\n",
							pendingUpdateId: null,
						};
					}
					if (actionArgs.path === "/reports/summary.md") {
						return {
							nodeId: "file_4",
							displayNodeId: "file_4",
							content: "summary\n",
							pendingUpdateId: null,
						};
					}
					if (typeof actionArgs.path === "string" && args?.extraFileContents?.[actionArgs.path] != null) {
						return {
							nodeId: `node:${actionArgs.path}`,
							displayNodeId: `node:${actionArgs.path}`,
							content: args.extraFileContents[actionArgs.path],
							pendingUpdateId: null,
						};
					}
					return null;
				},
			});

			return {
				run: async (command: string) => {
					const result = await action_run(ctx, {
						...test_ctx_data,
						command,
						allowAppFileTreeMkdir: args?.allowAppFileTreeMkdir ?? true,
						persistedCwd: cwd,
					});
					cwd = result.nextPersistedCwd;
					return result;
				},
				runQuery,
				runMutation,
				runAction,
				getCwd: () => cwd,
			};
		}

		test("runs pwd and persists cd across invocations", async () => {
			const { run, getCwd } = createBashRunner();

			const pwdResult = await run("pwd");
			expect(pwdResult.stdout.trim()).toBe("/home/cloud-usr");
			expect(pwdResult.metadata.cwd).toBe("/home/cloud-usr");

			const cdResult = await run(`cd ${test_app_files_mount}/docs`);
			expect(cdResult.metadata.nextCwd).toBe(`${test_app_files_mount}/docs`);
			expect(getCwd()).toBe("~/w/personal/home/docs");

			const nextPwdResult = await run("pwd");
			expect(nextPwdResult.stdout.trim()).toBe(`${test_app_files_mount}/docs`);
		});

		test("sets HOME to the cloud user home", async () => {
			const { run } = createBashRunner();

			const result = await run("printf $HOME");

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toBe("/home/cloud-usr");
		});

		test("guides unknown commands toward supported bash commands", async () => {
			const { run } = createBashRunner();

			const result = await run("du");
			const swallowed = await run("du 2>&1 || true");
			const compound = await run("du; true");

			expect(result.metadata.exitCode).toBe(127);
			expect(result.stderr).toContain("command not found");
			expect(result.stderr).toContain("run 'help' to list available commands");
			expect(result.stderr).toContain("use search/grep for content and find/ls for paths");
			expect(swallowed.metadata.exitCode).toBe(0);
			expect(swallowed.stdout).toContain("command not found");
			expect(swallowed.stderr).toContain("run 'help' to list available commands");
			expect(compound.metadata.exitCode).toBe(0);
			expect(compound.stderr).toContain("command not found");
			expect(compound.stderr).toContain("run 'help' to list available commands");
		});

		test("does not treat file content as an unknown command", async () => {
			const literalPath = "/docs/command-not-found.md";
			const { run } = createBashRunner({
				extraItems: [
					{
						path: literalPath,
						kind: "file",
						updatedAt: now,
						depthTruncated: false,
						contentType: "text/markdown;charset=utf-8",
					},
				],
				extraFileContents: {
					[literalPath]: "example: command not found\n",
				},
			});

			const catResult = await run(`cat ${test_app_files_mount}${literalPath}`);
			const grepResult = await run(`grep "command not found" ${test_app_files_mount}${literalPath}`);

			expect(catResult.stdout).toContain("example: command not found");
			expect(catResult.stderr).not.toContain("run 'help' to list available commands");
			expect(grepResult.stdout).toContain("example: command not found");
			expect(grepResult.stderr).not.toContain("run 'help' to list available commands");
		});

		test("reads markdown files through the pending-aware file content action", async () => {
			const { run, runAction } = createBashRunner();

			const result = await run(`cat ${test_app_files_mount}/docs/readme.md`);

			expect(result.stdout).toContain("# Readme");
			expect(runAction).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					path: "/docs/readme.md",
					userId: test_user_id,
				}),
			);
		});

		test("caches markdown file content within one bash invocation", async () => {
			const { run, runAction } = createBashRunner();

			const result = await run(
				`cat ${test_app_files_mount}/docs/readme.md && cat ${test_app_files_mount}/docs/readme.md`,
			);
			const readCalls = runAction.mock.calls.filter((call) => {
				const actionArgs = call[1];
				return (
					actionArgs && typeof actionArgs === "object" && "path" in actionArgs && actionArgs.path === "/docs/readme.md"
				);
			});

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout.split("# Readme").length - 1).toBe(2);
			expect(readCalls).toHaveLength(1);
		});

		test("pipes cat text output without corrupting Unicode", async () => {
			const unicodePath = "/docs/unicode.md";
			const content = "cafe\u0301 — snowman ☃\n";
			const { run } = createBashRunner({
				extraItems: [
					{
						path: unicodePath,
						kind: "file",
						updatedAt: now,
						depthTruncated: false,
						contentType: "text/markdown;charset=utf-8",
					},
				],
				extraFileContents: {
					[unicodePath]: content,
				},
			});

			const result = await run(`cat ${test_app_files_mount}${unicodePath} | cat`);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toBe(content);
		});

		test("supports ls, find, and stat over file-node paths", async () => {
			const { run } = createBashRunner();

			const result = await run(
				`ls ${test_app_files_mount}/docs && find ${test_app_files_mount}/docs -maxdepth 1 -type f && stat ${test_app_files_mount}/docs/readme.md`,
			);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toContain("readme.md");
			expect(result.stdout).toContain(`${test_app_files_mount}/docs/readme.md`);
		});

		test("keeps valid ls operands when another operand is missing", async () => {
			const { run } = createBashRunner();

			const result = await run(`ls ${test_app_files_mount}/docs ${test_app_files_mount}/missing`);

			expect(result.metadata.exitCode).toBe(1);
			expect(result.stdout).toContain(`${test_app_files_mount}/docs:`);
			expect(result.stdout).toContain("readme.md");
			expect(result.stderr).toContain(`ls: cannot access '${test_app_files_mount}/missing': No such file or directory`);
		});

		test("supports paginated ls with a continuation command", async () => {
			const { run, runQuery } = createBashRunner();

			const result = await run(`ls --limit 1 ${test_app_files_mount}/docs`);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toContain("nested/");
			expect(result.stdout).toContain("Next page:");
			expect(result.stdout).toContain(`ls --limit 1 --cursor cursor-1 ${test_app_files_mount}/docs`);
			expect(result.stderr).not.toContain("directory listing truncated");
			const paginatedCalls = runQuery.mock.calls.map((call) => call[1]).filter((args) => "numItems" in args);
			expect(paginatedCalls).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						parentId: "node:/docs",
						numItems: 1,
						cursor: null,
					}),
				]),
			);
		});

		test("resolves paginated ls path arguments from the current working directory", async () => {
			const { run, runQuery } = createBashRunner();

			await run(`cd ${test_app_files_mount}/docs`);
			const bareResult = await run("ls --limit 10");
			const dotResult = await run("ls --limit 10 .");
			const relativeResult = await run("ls --limit 10 nested");

			expect(bareResult.metadata.exitCode).toBe(0);
			expect(bareResult.stdout).toContain("readme.md");
			expect(dotResult.metadata.exitCode).toBe(0);
			expect(dotResult.stdout).toContain("tutorial.md");
			expect(relativeResult.metadata.exitCode).toBe(0);
			expect(relativeResult.stdout).toContain("deep.md");
			const paginatedCalls = runQuery.mock.calls.map((call) => call[1]).filter((args) => "numItems" in args);
			expect(paginatedCalls).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						parentId: "node:/docs",
						numItems: 10,
						cursor: null,
					}),
					expect.objectContaining({
						parentId: "node:/docs/nested",
						numItems: 10,
						cursor: null,
					}),
				]),
			);
		});

		test("continues paginated ls from the opaque cursor", async () => {
			const { run } = createBashRunner();

			const result = await run(`ls --limit 1 --cursor cursor-1 ${test_app_files_mount}/docs`);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toContain("readme.md");
			expect(result.stdout).not.toContain("nested/");
			expect(result.stdout).toContain(`ls --limit 1 --cursor cursor-2 ${test_app_files_mount}/docs`);
		});

		test("supports multiple ls path operands with per-directory continuation commands", async () => {
			const { run } = createBashRunner();

			const result = await run(
				`ls --limit 1 ${test_app_files_mount}/docs ${test_app_files_mount} ${test_app_files_mount}/docs/readme.md`,
			);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toContain(`${test_app_files_mount}/docs:\nnested/`);
			expect(result.stdout).toContain(`${test_app_files_mount}:\ndocs/`);
			expect(result.stdout).toContain(`${test_app_files_mount}/docs/readme.md`);
			expect(result.stdout.match(/Next page:/gu)).toHaveLength(2);
			expect(result.stdout).toContain(`Next page: ls --limit 1 --cursor cursor-1 ${test_app_files_mount}/docs`);
			expect(result.stdout).toContain(`Next page: ls --limit 1 --cursor cursor-1 ${test_app_files_mount}`);
		});

		test("rejects ls cursor continuation with multiple operands", async () => {
			const { run, runQuery } = createBashRunner();

			const result = await run(
				`ls --limit 1 --cursor cursor-1 ${test_app_files_mount}/docs ${test_app_files_mount}/reports`,
			);

			expect(result.metadata.exitCode).toBe(2);
			expect(result.stderr).toContain("--cursor can only continue one listing target");
			const paginatedCalls = runQuery.mock.calls.map((call) => call[1]).filter((args) => "numItems" in args);
			expect(paginatedCalls).toHaveLength(0);
		});

		test("supports ls -d and lets directory mode win over recursive mode", async () => {
			const { run } = createBashRunner();

			const result = await run(`ls -dR ${test_app_files_mount}/docs`);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout.trim()).toBe(`${test_app_files_mount}/docs/`);
			expect(result.stdout).not.toContain("readme.md");
		});

		test("supports recursive ls with full app shell paths", async () => {
			const { run } = createBashRunner();

			const result = await run(`ls -R --limit 10 ${test_app_files_mount}/docs`);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toContain(`${test_app_files_mount}/docs/nested/`);
			expect(result.stdout).toContain(`${test_app_files_mount}/docs/nested/deep.md`);
			expect(result.stdout).toContain(`${test_app_files_mount}/docs/readme.md`);
		});

		test("supports reverse ls order through the paginated query", async () => {
			const { run, runQuery } = createBashRunner();

			const result = await run(`ls -r --limit 10 ${test_app_files_mount}/docs`);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout.trim().split("\n")).toEqual(["tutorial.md", "readme.md", "nested/"]);
			expect(runQuery).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					parentId: "node:/docs",
					order: "desc",
				}),
			);
		});

		test("ls -t lists the project newest-first and supports scoped immediate-child recency", async () => {
			const { run, runQuery } = createBashRunner({
				extraItems: [
					{
						path: "/docs/aaa-old.md",
						kind: "file",
						updatedAt: now - 10_000,
						depthTruncated: false,
						contentType: "text/markdown;charset=utf-8",
					},
					{
						path: "/docs/zzz-new.md",
						kind: "file",
						updatedAt: now + 10_000,
						depthTruncated: false,
						contentType: "text/markdown;charset=utf-8",
					},
				],
			});

			const newest = await run("ls -t --limit 50");
			const oldest = await run("ls -rt --limit 50");
			const scopedNewest = await run(`ls -t --limit 10 ${test_app_files_mount}/docs`);
			const scopedOldest = await run(`ls -rt --limit 10 ${test_app_files_mount}/docs`);
			const scopedPaged = await run(`ls -t --limit 1 ${test_app_files_mount}/docs`);
			const recursiveScoped = await run(`ls -Rt ${test_app_files_mount}/docs`);
			const projectPaged = await run("ls -t --limit 1");

			expect(newest.metadata.exitCode).toBe(0);
			// Each line is "<ISO timestamp>\t<shell path>"; assert the recency formatting + a known path.
			expect(newest.stdout).toMatch(/\dT\d.*Z\t\/home\/cloud-usr\/w\/personal\/home\/docs\/readme\.md/u);
			const recencyCalls = runQuery.mock.calls
				.map((call) => call[1])
				.filter(
					(a) => "numItems" in a && !("parentId" in a) && !("path" in a) && !("pathPrefix" in a) && !("query" in a),
				);
			expect(recencyCalls.some((a) => a.order === "desc")).toBe(true);
			expect(recencyCalls.some((a) => a.order === "asc")).toBe(true);
			expect(oldest.metadata.exitCode).toBe(0);
			expect(scopedNewest.metadata.exitCode).toBe(0);
			expect(scopedNewest.stdout.trim().split("\n").at(0)).toBe("zzz-new.md");
			expect(scopedOldest.metadata.exitCode).toBe(0);
			expect(scopedOldest.stdout.trim().split("\n").at(0)).toBe("aaa-old.md");
			expect(scopedPaged.stdout).toContain(`Next page: ls -t --limit 1 --cursor cursor-1 ${test_app_files_mount}/docs`);
			expect(recursiveScoped.metadata.exitCode).toBe(2);
			expect(recursiveScoped.stderr).toContain("ls -t -R is not supported");
			expect(projectPaged.stdout).toContain("Next page: ls -t --limit 1 --cursor");
			expect(runQuery).toHaveBeenCalledWith(
				internal.files_nodes.list_dir_children_by_parent_recency_paginated,
				expect.objectContaining({
					parentId: "node:/docs",
					order: "desc",
				}),
			);
		});

		test("supports app-specific long ls output", async () => {
			const { run } = createBashRunner();

			const result = await run(`ls -la --limit 10 ${test_app_files_mount}/docs`);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toContain(`folder\t${new Date(now).toISOString()}\tupdatedBy=${test_user_id}\tnested/`);
			expect(result.stdout).toContain(
				`file\t${new Date(now).toISOString()}\tupdatedBy=${test_user_id}\tcontentType=text/markdown;charset=utf-8\treadme.md`,
			);
		});

		test("accepts ls no-op presentation flags and name sort alias", async () => {
			const { run } = createBashRunner();

			const result = await run(`ls -1apF --sort=name --indicator-style=slash --limit 10 ${test_app_files_mount}/docs`);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout.trim().split("\n")).toEqual(["nested/", "readme.md", "tutorial.md"]);
		});

		test("rejects unsupported ls sorting and size flags for app paths", async () => {
			const { run } = createBashRunner();

			const sortResult = await run(`ls --sort=size ${test_app_files_mount}/docs`);
			const sizeResult = await run(`ls -S ${test_app_files_mount}/docs`);

			expect(sortResult.metadata.exitCode).toBe(2);
			expect(sortResult.stderr).toContain("unsupported option --sort=size");
			expect(sortResult.stderr).toContain("supports name order only");
			expect(sizeResult.metadata.exitCode).toBe(2);
			expect(sizeResult.stderr).toContain("unsupported option -S");
		});

		test("guides invented ls pagination flags back to the printed cursor command", async () => {
			const { run } = createBashRunner();

			const result = await run(`ls --limit 1 --next-page ${test_app_files_mount}/docs`);

			expect(result.metadata.exitCode).toBe(2);
			expect(result.stderr).toContain("--next-page is not supported");
			expect(result.stderr).toContain("Copy the exact");
			expect(result.stderr).toContain("Next page: ls --limit N --cursor");
		});

		test("supports paginated find with maxdepth and type filters", async () => {
			const { run, runQuery } = createBashRunner();

			const result = await run(`find ${test_app_files_mount}/docs -maxdepth 1 -type f --limit 10`);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toContain(`${test_app_files_mount}/docs/readme.md`);
			expect(result.stdout).toContain(`${test_app_files_mount}/docs/tutorial.md`);
			expect(result.stdout).not.toContain(`${test_app_files_mount}/docs/nested/deep.md`);
			const paginatedCalls = runQuery.mock.calls.map((call) => call[1]).filter((args) => "numItems" in args);
			expect(paginatedCalls).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						path: "/docs",
						numItems: 10,
						cursor: null,
						kind: "file",
						maxDepth: 1,
					}),
				]),
			);
		});

		test("supports DB-backed find path word search", async () => {
			const { run, runQuery } = createBashRunner();

			const nameResult = await run("find -name readme --limit 10");
			const explicitResult = await run("find --path-query readme --limit 10");
			const scopedResult = await run(`find ${test_app_files_mount}/docs -maxdepth 1 -name readme -type f --limit 10`);

			expect(nameResult.metadata.exitCode).toBe(0);
			expect(nameResult.stdout).toContain(`${test_app_files_mount}/docs/readme.md`);
			expect(explicitResult.metadata.exitCode).toBe(0);
			expect(explicitResult.stdout).toContain(`${test_app_files_mount}/docs/readme.md`);
			expect(scopedResult.metadata.exitCode).toBe(0);
			expect(scopedResult.stdout).toContain(`${test_app_files_mount}/docs/readme.md`);
			expect(runQuery).toHaveBeenCalledWith(
				internal.files_nodes.search_paths_paginated,
				expect.objectContaining({
					pathQuery: "readme",
				}),
			);
			expect(runQuery).toHaveBeenCalledWith(
				internal.files_nodes.search_paths_paginated,
				expect.objectContaining({
					parentId: "node:/docs",
					kind: "file",
				}),
			);
		});

		test("supports find -mindepth and accepts -print as a no-op", async () => {
			const { run } = createBashRunner();

			const deepOnly = await run(`find ${test_app_files_mount}/docs -mindepth 2 --limit 50`);
			const directOnly = await run(`find ${test_app_files_mount}/docs -mindepth 1 -maxdepth 1 --limit 50`);
			const printed = await run(`find ${test_app_files_mount}/docs -maxdepth 1 -print --limit 50`);

			expect(deepOnly.metadata.exitCode).toBe(0);
			expect(deepOnly.stdout).toContain(`${test_app_files_mount}/docs/nested/deep.md`);
			expect(deepOnly.stdout).not.toContain(`${test_app_files_mount}/docs/readme.md`);
			expect(directOnly.metadata.exitCode).toBe(0);
			expect(directOnly.stdout).toContain(`${test_app_files_mount}/docs/readme.md`);
			expect(directOnly.stdout).toContain(`${test_app_files_mount}/docs/nested/`);
			expect(directOnly.stdout).not.toContain(`${test_app_files_mount}/docs/nested/deep.md`);
			expect(printed.metadata.exitCode).toBe(0);
			expect(printed.stdout).toContain(`${test_app_files_mount}/docs/readme.md`);
		});

		test("rejects a non-integer find -mindepth and round-trips it in the continuation", async () => {
			const { run } = createBashRunner();

			const invalid = await run(`find ${test_app_files_mount}/docs -mindepth x --limit 10`);
			const paged = await run(`find ${test_app_files_mount}/docs -mindepth 1 --limit 1`);

			expect(invalid.metadata.exitCode).toBe(2);
			expect(invalid.stderr).toContain("-mindepth must be a non-negative integer");
			expect(paged.metadata.exitCode).toBe(0);
			expect(paged.stdout).toContain("Next page: find");
			expect(paged.stdout).toContain("-mindepth 1");
		});

		test("rejects find --prefix combined with depth flags (depth is undefined for a prefix)", async () => {
			const { run, runQuery } = createBashRunner();

			const maxResult = await run(`find --prefix ${test_app_files_mount}/docs -maxdepth 1 --limit 10`);
			const minResult = await run(`find --prefix ${test_app_files_mount}/docs -mindepth 2 --limit 10`);

			expect(maxResult.metadata.exitCode).toBe(2);
			expect(maxResult.stderr).toContain("--prefix cannot be combined with -maxdepth/-mindepth");
			expect(minResult.metadata.exitCode).toBe(2);
			expect(minResult.stderr).toContain("--prefix cannot be combined with -maxdepth/-mindepth");
			const paginatedCalls = runQuery.mock.calls.map((call) => call[1]).filter((args) => "numItems" in args);
			expect(paginatedCalls).toHaveLength(0);
		});

		test("supports DB-backed find extension search and simple extension glob recovery", async () => {
			const { run, runQuery } = createBashRunner();

			const globName = await run("find -name '*.md' --limit 10");
			const extension = await run(`find ${test_app_files_mount}/docs --extension md --limit 10`);
			const pathGlob = await run(`find ${test_app_files_mount}/docs/*.md --limit 1`);

			expect(globName.metadata.exitCode).toBe(0);
			expect(globName.stdout).toContain(`${test_app_files_mount}/docs/readme.md`);
			expect(extension.metadata.exitCode).toBe(0);
			expect(extension.stdout).toContain(`${test_app_files_mount}/docs/readme.md`);
			expect(pathGlob.metadata.exitCode).toBe(0);
			expect(pathGlob.stdout).toContain(`${test_app_files_mount}/docs/nested/deep.md`);
			expect(pathGlob.stdout).toContain(
				`Next page: find ${test_app_files_mount}/docs --extension md --limit 1 --cursor`,
			);
			expect(runQuery).toHaveBeenCalledWith(
				internal.files_nodes.list_subtree_by_extension_paginated,
				expect.objectContaining({
					path: "/docs",
					lowercaseExtension: "md",
				}),
			);
		});

		test("rejects find combinations that still cannot stay DB-backed", async () => {
			const { run } = createBashRunner();

			const scopedRecursive = await run(`find ${test_app_files_mount}/docs -name readme --limit 10`);
			const tokenGlobName = await run("find -type f -name '*readme*' --limit 10");
			const complexGlobName = await run("find -name 'read*.md' --limit 10");
			const pathQueryGlob = await run("find --path-query '.*readme.*' --limit 10");
			const recursivePathQuery = await run(
				`find ${test_app_files_mount} -maxdepth 5 -type f --path-query readme --limit 10`,
			);

			expect(scopedRecursive.metadata.exitCode).toBe(2);
			expect(scopedRecursive.stderr).toContain("scoped path word search supports immediate children only");
			expect(scopedRecursive.stderr).toContain(
				`Try: find ${test_app_files_mount}/docs -maxdepth 1 --path-query readme --limit 10`,
			);
			expect(tokenGlobName.metadata.exitCode).toBe(2);
			expect(tokenGlobName.stderr).toContain(
				`Try: find ${test_app_files_mount} -type f --path-query readme --limit 10`,
			);
			expect(complexGlobName.metadata.exitCode).toBe(2);
			expect(complexGlobName.stderr).toContain("not glob patterns");
			expect(complexGlobName.stderr).toContain("Try `find <dir> -type f --extension md");
			expect(pathQueryGlob.metadata.exitCode).toBe(2);
			expect(pathQueryGlob.stderr).toContain("--path-query uses DB-backed path word search");
			expect(pathQueryGlob.stderr).toContain(`Try: find ${test_app_files_mount} --path-query readme --limit 10`);
			expect(recursivePathQuery.metadata.exitCode).toBe(2);
			expect(recursivePathQuery.stderr).toContain(
				`Try: find ${test_app_files_mount} -type f --path-query readme --limit 10`,
			);
		});

		test("filters non-search find pages before pagination", async () => {
			const { run } = createBashRunner();

			const result = await run(`find ${test_app_files_mount}/docs -maxdepth 1 -type f --limit 1`);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toContain(`${test_app_files_mount}/docs/readme.md`);
			expect(result.stdout).not.toContain("No matches in this page; more pages exist.");
			expect(result.stdout).toContain("Next page:");
		});

		test("rejects unsupported find predicates when pagination is requested", async () => {
			const { run, runQuery } = createBashRunner();

			const result = await run(`find ${test_app_files_mount}/docs -delete --limit 10`);

			expect(result.metadata.exitCode).toBe(2);
			expect(result.stderr).toContain("unsupported predicate -delete");
			expect(result.stderr).toContain("use -name QUERY");
			expect(result.stderr).toContain("Usage: find");
			const paginatedCalls = runQuery.mock.calls.map((call) => call[1]).filter((args) => "numItems" in args);
			expect(paginatedCalls).toHaveLength(0);
		});

		test("rejects app pagination options outside the app file mount without Convex queries", async () => {
			const { run, runQuery } = createBashRunner();

			const lsResult = await run("ls --limit 1 /tmp");
			const findResult = await run("find /tmp --limit 1");

			expect(lsResult.metadata.exitCode).toBe(2);
			expect(lsResult.stderr).toContain("--limit and --cursor are only available for app file paths");
			expect(lsResult.stderr).toContain(test_app_files_mount);
			expect(findResult.metadata.exitCode).toBe(2);
			expect(findResult.stderr).toContain("--limit and --cursor are only available for app file paths");
			expect(findResult.stderr).toContain(test_app_files_mount);
			const paginatedCalls = runQuery.mock.calls.map((call) => call[1]).filter((args) => "numItems" in args);
			expect(paginatedCalls).toHaveLength(0);
		});

		test("does not use the legacy capped list_files query for native app ls", async () => {
			const { run, runQuery } = createBashRunner();

			await run(`ls ${test_app_files_mount}/docs`);

			const listCalls = runQuery.mock.calls
				.map((call) => call[1])
				.filter((args) => args && typeof args === "object" && "maxDepth" in args);
			expect(listCalls).toHaveLength(0);
		});

		test("resolves exact parent folders through app path lookups", async () => {
			const { run, runQuery } = createBashRunner();

			const result = await run(`cd ${test_app_files_mount}/reports && pwd`);
			const reportsLookupCalls = runQuery.mock.calls.filter((call) => {
				const queryArgs = call[1];
				return (
					queryArgs &&
					typeof queryArgs === "object" &&
					!("maxDepth" in queryArgs) &&
					"path" in queryArgs &&
					queryArgs.path === "/reports"
				);
			});

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout.trim()).toBe(`${test_app_files_mount}/reports`);
			expect(reportsLookupCalls.length).toBeGreaterThan(0);
		});

		test("rejects app glob patterns without falling back to capped enumeration", async () => {
			const { run } = createBashRunner();

			const result = await run(`ls ${test_app_files_mount}/docs/*.md`);

			expect(result.metadata.exitCode).toBe(2);
			expect(result.metadata.pathIndexTruncated).toBe(false);
			expect(result.stderr).toContain("app file glob patterns are not supported");
			expect(result.stderr).toContain(`Try: find ${test_app_files_mount}/docs -type f --extension md --limit 20`);
		});

		test("does not alias root listing to app files", async () => {
			const { run } = createBashRunner();

			const result = await run("ls /");

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).not.toContain("docs");
			expect(result.stdout).not.toContain("source.pdf");
			expect(result.stdout).toContain("home");
			expect(result.stdout).toContain("tmp");
		});

		test("does not expose the removed legacy mount", async () => {
			const { run } = createBashRunner();
			const legacyMount = "/work" + "space";

			const result = await run(`ls ${legacyMount}`);

			expect(result.metadata.exitCode).not.toBe(0);
			expect(result.stdout).not.toContain("readme.md");
		});

		test("explains unreadable uploaded source files through bash cat", async () => {
			const { run } = createBashRunner();

			const result = await run(`cat ${test_app_files_mount}/source.pdf`);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toContain("content type is 'application/pdf'");
			expect(result.stdout).toContain("Markdown and plain text files only");
			expect(result.stdout).toContain(`${test_app_files_mount}/source.pdf.md`);
			expect(result.stdout).toContain(`${test_app_files_mount}/source.md`);
			expect(result.stdout).toContain(`${test_app_files_mount}/source.txt`);
			expect(result.stderr).toBe("");
		});

		test("does not suggest rereading the same unreadable file path", async () => {
			const { run } = createBashRunner();

			const result = await run(`cat ${test_app_files_mount}/uploaded.md`);
			const suggestionLine = result.stdout
				.split("\n")
				.find((line) => line.startsWith("To read generated text output for this file"));

			expect(result.metadata.exitCode).toBe(0);
			expect(suggestionLine).toBeDefined();
			// The advisory must suggest readable siblings, never re-reading the same unreadable path.
			expect(suggestionLine).not.toContain(`${test_app_files_mount}/uploaded.md,`);
			expect(suggestionLine?.endsWith(`${test_app_files_mount}/uploaded.md`)).toBe(false);
			expect(suggestionLine).toContain(`${test_app_files_mount}/uploaded.md.md`);
			expect(suggestionLine).toContain(`${test_app_files_mount}/uploaded.txt`);
		});

		test("rejects workspace writes but allows per-command /tmp scratch files", async () => {
			const { run } = createBashRunner();

			const workspaceWrite = await run(`echo nope > ${test_app_files_mount}/docs/new.md`);
			expect(workspaceWrite.metadata.exitCode).not.toBe(0);
			expect(workspaceWrite.stderr).toContain("read-only file system");

			const tmpWrite = await run("printf hi > /tmp/a.txt && cat /tmp/a.txt");
			expect(tmpWrite.metadata.exitCode).toBe(0);
			expect(tmpWrite.stdout).toBe("hi");

			const nextInvocation = await run("cat /tmp/a.txt");
			expect(nextInvocation.metadata.exitCode).not.toBe(0);
			expect(nextInvocation.stderr).toContain("No such file");
		});

		test("creates persistent app file tree folders through bash mkdir when allowed", async () => {
			const { run, runMutation } = createBashRunner({ allowAppFileTreeMkdir: true });

			const result = await run(
				`mkdir ${test_app_files_mount}/bash-created && stat ${test_app_files_mount}/bash-created && ls ${test_app_files_mount}`,
			);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toContain("drwx");
			expect(result.stdout).toContain("bash-created");
			expect(runMutation).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					path: "/bash-created",
					userId: test_user_id,
				}),
			);
		});

		test("blocks app file tree folder creation through bash mkdir when not allowed", async () => {
			const { run, runMutation } = createBashRunner({ allowAppFileTreeMkdir: false });

			const result = await run(`mkdir ${test_app_files_mount}/ask-denied`);

			expect(result.metadata.exitCode).not.toBe(0);
			expect(result.stderr).toContain("Agent mode");
			expect(result.stderr).toContain("Scratch space does not create durable folders");
			expect(runMutation).not.toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					path: "/ask-denied",
				}),
			);
		});

		test("runs indexed search with options before the query", async () => {
			const { run, runQuery } = createBashRunner();

			const result = await run("search --limit 5 unique-token");

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toContain("unique-token");
			expect(result.stdout).toContain(`${test_app_files_mount}/docs/readme.md`);
			expect(runQuery).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					query: "unique-token",
					numItems: 5,
					cursor: null,
				}),
			);
		});

		test("prints a search continuation when indexed search has another DB page", async () => {
			const { run, runQuery } = createBashRunner();

			const firstPage = await run("search --limit 1 paged-token");
			const complete = await run("search --limit 5 unique-token");

			expect(firstPage.metadata.exitCode).toBe(0);
			expect(firstPage.stdout).toContain("Found 1 results");
			expect(firstPage.stdout).toContain("Next page: search --limit 1 --cursor cursor-1 paged-token");
			expect(complete.stdout).not.toContain("Next page: search");
			const pageProbeCalls = runQuery.mock.calls.filter(
				([, args]) => "query" in args && "cursor" in args && !("numItems" in args),
			);
			expect(pageProbeCalls).toHaveLength(0);
		});

		test("probes scoped search continuations because DB-side filters can skip raw search hits", async () => {
			const { run, runQuery } = createBashRunner();

			const result = await run(`search --path ${test_app_files_mount}/docs --limit 1 paged-token`);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toContain("Next page: search --path");
			const pageProbeCalls = runQuery.mock.calls.filter(
				([, args]) => "query" in args && "cursor" in args && !("numItems" in args),
			);
			expect(pageProbeCalls.map(([, args]) => args)).toContainEqual(
				expect.objectContaining({ query: "paged-token", pathPrefix: "/docs" }),
			);
		});

		test("rejects app path operands in indexed search instead of folding them into the query", async () => {
			const { run, runQuery } = createBashRunner();

			const result = await run(`search --limit 5 unique-token ${test_app_files_mount}`);

			expect(result.metadata.exitCode).toBe(2);
			expect(result.stderr).toContain("path operands are not supported");
			expect(result.stderr).toContain("search --path <folder>");
			expect(runQuery).not.toHaveBeenCalled();
		});

		test("scopes indexed search to a folder with --path", async () => {
			const { run, runQuery } = createBashRunner();

			// In-scope folder → hit, and the app path is passed through to the query.
			const inScope = await run(`search --path ${test_app_files_mount}/docs unique-token`);
			expect(inScope.metadata.exitCode).toBe(0);
			expect(inScope.stdout).toContain(`${test_app_files_mount}/docs/readme.md`);
			expect(inScope.stdout).toContain(`under ${test_app_files_mount}/docs`);
			expect(runQuery).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ query: "unique-token", pathPrefix: "/docs" }),
			);

			// Bare search follows the current app cwd so native-ish "cd dir && search term" stays DB-scoped.
			const cwdScope = await run(`cd ${test_app_files_mount}/docs && search unique-token`);
			expect(cwdScope.metadata.exitCode).toBe(0);
			expect(cwdScope.stdout).toContain(`${test_app_files_mount}/docs/readme.md`);
			expect(cwdScope.stdout).toContain(`under ${test_app_files_mount}/docs`);
			const searchCalls = runQuery.mock.calls.map((call) => call[1]).filter((args) => "query" in args);
			expect(searchCalls.at(-1)).toEqual(expect.objectContaining({ query: "unique-token", pathPrefix: "/docs" }));

			// Out-of-scope folder → no match (the only hit lives under /docs).
			const outScope = await run(`search --path ${test_app_files_mount}/other unique-token`);
			expect(outScope.metadata.exitCode).toBe(0);
			expect(outScope.stdout).toContain("No content matches found");
			expect(outScope.stdout).toContain(`under ${test_app_files_mount}/other`);
			expect(outScope.stdout).toContain("not path/name search");

			// A --path outside the app mount is rejected.
			const bad = await run("search --path /etc unique-token");
			expect(bad.metadata.exitCode).toBe(2);
			expect(bad.stderr).toContain("must be a folder under the app file tree");
		});

		test("does not scan markdown files when indexed search misses", async () => {
			const { run, runAction } = createBashRunner();

			const result = await run("search --limit 5 Readme");

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toContain("No content matches found");
			expect(result.stdout).toContain("find --path-query QUERY");
			expect(runAction).not.toHaveBeenCalled();
		});

		test("rejects chunk-type filters for indexed search", async () => {
			const { run, runQuery } = createBashRunner();

			const code = await run("search --code code-token");
			const table = await run("search --table table-token");
			const noCode = await run("search --no-code unique-token");

			expect(code.metadata.exitCode).toBe(2);
			expect(table.metadata.exitCode).toBe(2);
			expect(noCode.metadata.exitCode).toBe(2);
			expect(code.stderr).toContain("--code is not supported");
			expect(table.stderr).toContain("--table is not supported");
			expect(noCode.stderr).toContain("--no-code is not supported");
			expect(runQuery).not.toHaveBeenCalledWith(internal.files_nodes.text_search_files, expect.anything());
		});

		test("keeps grep as a compatibility hint that points to indexed search", async () => {
			const { run } = createBashRunner();

			const result = await run(`grep -R unique-token ${test_app_files_mount}`);

			expect(result.metadata.exitCode).toBe(2);
			expect(result.stderr).toBe("");
			expect(result.stdout).toContain("is not supported");
			expect(result.stdout).toContain(`Try: search --path ${test_app_files_mount} --limit 20 unique-token`);
			expect(result.stdout).toContain("Convex text index");
			expect(result.stdout).toContain("cd there or use search --path");
		});

		test("greps a single app file (substring, line numbers, -i), guidance otherwise", async () => {
			const { run } = createBashRunner();

			// Single app file → matching lines with 1-based line numbers (grep -n style).
			const hit = await run(`grep unique-token ${test_app_files_mount}/docs/readme.md`);
			expect(hit.metadata.exitCode).toBe(0);
			expect(hit.stdout).toBe("2:unique-token here\n3:more unique-token below\n");
			const piped = await run(`cat ${test_app_files_mount}/docs/readme.md | head -n 20 | grep -n unique-token`);
			expect(piped.metadata.exitCode).toBe(0);
			expect(piped.stdout).toBe("2:unique-token\n");

			// Case-insensitive.
			const ci = await run(`grep -i ALPHA ${test_app_files_mount}/docs/tutorial.md`);
			expect(ci.metadata.exitCode).toBe(0);
			expect(ci.stdout).toBe("2:alpha\n3:ALPHA\n");

			// No match → exit 1, no output (real grep semantics).
			const none = await run(`grep zzz-nope ${test_app_files_mount}/docs/readme.md`);
			expect(none.metadata.exitCode).toBe(1);
			expect(none.stdout).toBe("");

			// Multiple files → falls back to guidance (we only handle one file).
			const multi = await run(
				`grep token ${test_app_files_mount}/docs/readme.md ${test_app_files_mount}/docs/tutorial.md`,
			);
			expect(multi.metadata.exitCode).toBe(2);
			expect(multi.stdout).toContain("is not supported");

			const unsupportedSingleFileFlag = await run(`grep -o token ${test_app_files_mount}/docs/readme.md`);
			expect(unsupportedSingleFileFlag.metadata.exitCode).toBe(2);
			expect(unsupportedSingleFileFlag.stderr).toContain("unsupported option -o");
			expect(unsupportedSingleFileFlag.stderr).toContain("Supported: grep [-i] PATTERN <file>");

			// -c counts matching lines ("token" is on lines 2 and 3).
			const counted = await run(`grep -c token ${test_app_files_mount}/docs/readme.md`);
			expect(counted.metadata.exitCode).toBe(0);
			expect(counted.stdout).toBe("2\n");

			// Multiple -e patterns (OR semantics we don't reproduce) → guidance, not a silent
			// single-pattern match.
			const multiE = await run(`grep -e token -e other ${test_app_files_mount}/docs/readme.md`);
			expect(multiE.metadata.exitCode).toBe(2);

			// Combined short flags: -in (= -i -n) takes the single-file fast path, case-insensitively.
			const combined = await run(`grep -in ALPHA ${test_app_files_mount}/docs/tutorial.md`);
			expect(combined.metadata.exitCode).toBe(0);
			expect(combined.stdout).toBe("2:alpha\n3:ALPHA\n");

			// -iv (= -i -v) inverts: only line 1 lacks "token" (case-insensitively).
			const combinedV = await run(`grep -iv token ${test_app_files_mount}/docs/readme.md`);
			expect(combinedV.metadata.exitCode).toBe(0);
			expect(combinedV.stdout).toBe("1:# Readme\n");

			// -l prints the file path when it has a match, and exits 1 (no output) when it does not.
			const listed = await run(`grep -l unique-token ${test_app_files_mount}/docs/readme.md`);
			expect(listed.metadata.exitCode).toBe(0);
			expect(listed.stdout).toBe(`${test_app_files_mount}/docs/readme.md\n`);
			const listedNone = await run(`grep -l zzz-nope ${test_app_files_mount}/docs/readme.md`);
			expect(listedNone.metadata.exitCode).toBe(1);
			expect(listedNone.stdout).toBe("");

			// -B N adds leading context: a context line uses "-", a matching line uses ":".
			const before = await run(`grep -B 1 ALPHA ${test_app_files_mount}/docs/tutorial.md`);
			expect(before.metadata.exitCode).toBe(0);
			expect(before.stdout).toBe("2-alpha\n3:ALPHA\n");

			// -v over non-contiguous selected lines inserts a "--" group separator (lines 1 and 3 lack
			// the case-sensitive "alpha"; line 2 is "alpha").
			const invertGap = await run(`grep -v alpha ${test_app_files_mount}/docs/tutorial.md`);
			expect(invertGap.metadata.exitCode).toBe(0);
			expect(invertGap.stdout).toBe("1:zeta\n--\n3:ALPHA\n");
		});

		test("warns when single-file app grep patterns look like regex but still matches substrings only", async () => {
			const { run } = createBashRunner();

			const anchored = await run(`grep '^# Readme' ${test_app_files_mount}/docs/readme.md`);
			const escaped = await run(`grep '\\.' ${test_app_files_mount}/docs/readme.md`);

			expect(anchored.metadata.exitCode).toBe(1);
			expect(anchored.stdout).toBe("");
			expect(anchored.stderr).toContain("substring-only");
			expect(anchored.stderr).toContain("regex metacharacters are matched literally");
			expect(escaped.stderr).not.toContain("substring-only");
		});

		test("keeps grep large-file scan advisories on stderr", async () => {
			const path = "/docs/large-grep.md";
			const { run } = createBashRunner({
				extraItems: [
					{
						path,
						kind: "file",
						updatedAt: now,
						depthTruncated: false,
						contentType: "text/markdown;charset=utf-8",
					},
				],
				extraFileContents: {
					[path]: "match-token\n",
				},
				scanTruncatedPaths: [path],
			});
			const shellPath = `${test_app_files_mount}${path}`;

			const match = await run(`grep match-token ${shellPath}`);
			const noMatch = await run(`grep missing-token ${shellPath}`);

			expect(match.metadata.exitCode).toBe(0);
			expect(match.stdout).toBe("1:match-token\n");
			expect(match.stderr).toContain("more may exist");
			expect(noMatch.metadata.exitCode).toBe(1);
			expect(noMatch.stdout).toBe("");
			expect(noMatch.stderr).toContain("matches may exist beyond it");
		});

		test("uses native prefix find and renders app tree pages", async () => {
			const { run } = createBashRunner();
			const scopedRunner = createBashRunner({ initialCwd: `${test_app_files_mount}/docs` });

			const prefixResult = await run("find --prefix /docs --limit 20 -type f");
			const relativePrefixResult = await scopedRunner.run("find --prefix nested --limit 1");
			const treeResult = await run(`tree ${test_app_files_mount}/docs --limit 2`);
			const wrongRootTree = await run("tree /docs --limit 2");

			expect(prefixResult.metadata.exitCode).toBe(0);
			expect(prefixResult.stdout).toContain(`${test_app_files_mount}/docs/readme.md`);
			expect(prefixResult.stdout).toContain(`${test_app_files_mount}/docs/tutorial.md`);
			expect(relativePrefixResult.metadata.exitCode).toBe(0);
			expect(relativePrefixResult.stdout).toContain(
				`Next page: find --prefix ${test_app_files_mount}/docs/nested --limit 1 --cursor`,
			);
			expect(treeResult.metadata.exitCode).toBe(0);
			expect(treeResult.stdout).toContain(test_app_files_mount + "/docs");
			expect(treeResult.stdout).toContain("|-- nested/");
			expect(treeResult.stdout).toContain("|   |-- deep.md");
			expect(treeResult.stdout).toContain("Next page: tree");
			expect(wrongRootTree.metadata.exitCode).toBe(2);
			expect(wrongRootTree.stderr).toContain("tree: --limit and --cursor are app-file pagination flags");
			expect(wrongRootTree.stderr).toContain(`Try: tree ${test_app_files_mount}/docs --limit 2`);
		});

		test("supports exact reader commands while keeping unreadable app content out of generic readers", async () => {
			const { run } = createBashRunner();

			const result = await run(
				[
					`head -n 1 ${test_app_files_mount}/docs/readme.md`,
					`tail -n +2 ${test_app_files_mount}/docs/readme.md`,
					`wc -c ${test_app_files_mount}/docs/readme.md`,
					`stat -c "%F %n" ${test_app_files_mount}/docs/readme.md`,
				].join(" && "),
			);
			const unreadableHead = await run(`head ${test_app_files_mount}/source.pdf`);
			const unreadableTail = await run(`tail ${test_app_files_mount}/source.pdf`);
			const unreadableWc = await run(`wc ${test_app_files_mount}/source.pdf`);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toContain("# Readme");
			expect(result.stdout).toContain("unique-token");
			expect(result.stdout).toContain(`${test_app_files_mount}/docs/readme.md`);
			expect(result.stdout).toContain("regular file");
			for (const unreadable of [unreadableHead, unreadableTail, unreadableWc]) {
				expect(unreadable.metadata.exitCode).toBe(0);
				expect(unreadable.stdout).toContain("Markdown and plain text files only");
				expect(unreadable.stdout).toContain(`${test_app_files_mount}/source.pdf.md`);
			}
		});

		test("caps the number of app files a single reader command fetches", async () => {
			const { run, runAction } = createBashRunner();

			const overCapFiles = Array.from(
				{ length: READER_FILE_OPERAND_MAX + 1 },
				(_, index) => `${test_app_files_mount}/doc-${index}.md`,
			).join(" ");
			const atCapFiles = Array.from(
				{ length: READER_FILE_OPERAND_MAX },
				(_, index) => `${test_app_files_mount}/doc-${index}.md`,
			).join(" ");

			// The over-cap reads must short-circuit before any content fetch, so assert no
			// runAction before any later run (the at-cap cat below legitimately fetches content).
			const overCap = await run(`cat ${overCapFiles}`);
			expect(overCap.metadata.exitCode).toBe(2);
			expect(overCap.stderr).toContain(
				`cat: app file reads are limited to ${READER_FILE_OPERAND_MAX} files per command`,
			);
			expect(overCap.stderr).toContain(`you requested ${READER_FILE_OPERAND_MAX + 1}`);
			expect(runAction).not.toHaveBeenCalled();

			const headOverCap = await run(`head ${overCapFiles}`);
			const wcOverCap = await run(`wc -l ${overCapFiles}`);
			const statOverCap = await run(`stat ${overCapFiles}`);
			const atCap = await run(`cat ${atCapFiles}`);

			expect(headOverCap.metadata.exitCode).toBe(2);
			expect(headOverCap.stderr).toContain(`head: app file reads are limited to ${READER_FILE_OPERAND_MAX}`);
			expect(wcOverCap.metadata.exitCode).toBe(2);
			expect(wcOverCap.stderr).toContain(`wc: app file reads are limited to ${READER_FILE_OPERAND_MAX}`);
			expect(statOverCap.metadata.exitCode).toBe(2);
			expect(statOverCap.stderr).toContain(`stat: app file reads are limited to ${READER_FILE_OPERAND_MAX}`);
			expect(atCap.stderr).not.toContain("app file reads are limited");
		});

		test("counts only app-file operands toward the reader cap, not /tmp scratch", async () => {
			const { run } = createBashRunner();

			const tmpFiles = Array.from({ length: 20 }, (_, index) => `/tmp/scratch-${index}.txt`).join(" ");
			const appFiles = Array.from(
				{ length: READER_FILE_OPERAND_MAX + 1 },
				(_, index) => `${test_app_files_mount}/doc-${index}.md`,
			).join(" ");

			const result = await run(`cat ${tmpFiles} ${appFiles}`);

			expect(result.metadata.exitCode).toBe(2);
			expect(result.stderr).toContain(`you requested ${READER_FILE_OPERAND_MAX + 1}`);
		});

		test("pages large files smoothly: cat/head/sed/tail return bounded pages with hints, wc reports counts", async () => {
			const bigFile = {
				path: "/big.md",
				kind: "file" as const,
				updatedAt: Date.now(),
				depthTruncated: false,
				contentType: "text/markdown;charset=utf-8",
				size: READ_INLINE_MAX_BYTES + 1,
			};
			const { run } = createBashRunner({ extraItems: [bigFile] });
			const bigPath = `${test_app_files_mount}/big.md`;

			const catResult = await run(`cat ${bigPath}`);
			const wcResult = await run(`wc -l ${bigPath}`);
			const headResult = await run(`head -n 3 ${bigPath}`);
			const sedResult = await run(`sed -n '4,6p' ${bigPath}`);
			const tailResult = await run(`tail -n 3 ${bigPath}`);
			const headOverCap = await run(`head -n 9999 ${bigPath}`);
			const smallStillWorks = await run(`cat ${test_app_files_mount}/docs/readme.md`);

			// cat no longer refuses: it returns a bounded first page on stdout, with the advisory
			// on stderr so it never contaminates a pipe.
			expect(catResult.metadata.exitCode).toBe(0);
			expect(catResult.stdout).toContain("line 1\nline 2");
			expect(catResult.stdout).not.toContain("showing the first");
			expect(catResult.stderr).toContain(`showing the first ${READ_HEAD_LARGE_FILE_MAX_LINES} lines`);
			expect(catResult.stderr).toContain(
				`sed -n '${READ_HEAD_LARGE_FILE_MAX_LINES + 1},${READ_HEAD_LARGE_FILE_MAX_LINES * 2}p' ${bigPath}`,
			);
			// wc reports the line count (so the agent knows the size).
			expect(wcResult.metadata.exitCode).toBe(0);
			expect(wcResult.stdout).toContain(`1000 ${bigPath}`);
			// head reads first N lines + prints a sed continuation for the next page.
			expect(headResult.metadata.exitCode).toBe(0);
			expect(headResult.stdout).toContain("line 1\nline 2\nline 3\n");
			expect(headResult.stdout).toContain(`Next page: sed -n '4,6p' ${bigPath}`);
			// sed -n 'A,Bp' reads that exact range (paging forward) + its own continuation.
			expect(sedResult.metadata.exitCode).toBe(0);
			expect(sedResult.stdout).toContain("line 4\nline 5\nline 6\n");
			expect(sedResult.stdout).toContain(`Next page: sed -n '7,9p' ${bigPath}`);
			// tail reads the last N lines (bounded from the end) + a partial-view note pointing at the top.
			expect(tailResult.metadata.exitCode).toBe(0);
			expect(tailResult.stdout).toContain("line 998\nline 999\nline 1000\n");
			expect(tailResult.stdout).toContain("[tail: showing the last 3 lines");
			expect(tailResult.stdout).toContain(`head -n 3 ${bigPath}`);
			// head -n beyond the per-page cap clamps (no refusal) and notes it.
			expect(headOverCap.metadata.exitCode).toBe(0);
			expect(headOverCap.stdout).toContain(`showing ${READ_HEAD_LARGE_FILE_MAX_LINES} lines (per-page cap)`);
			// Files under the cap are unaffected.
			expect(smallStillWorks.metadata.exitCode).toBe(0);
			expect(smallStillWorks.stdout).toContain("# Readme");
		});

		test("prints absolute app paths in large-file reader continuations", async () => {
			const bigFile = {
				path: "/big.md",
				kind: "file" as const,
				updatedAt: Date.now(),
				depthTruncated: false,
				contentType: "text/markdown;charset=utf-8",
				size: READ_INLINE_MAX_BYTES + 1,
			};
			const { run } = createBashRunner({ initialCwd: test_app_files_mount, extraItems: [bigFile] });
			const bigPath = `${test_app_files_mount}/big.md`;

			const catResult = await run("cat big.md");
			const headResult = await run("head -n 3 big.md");
			const tailForwardResult = await run("tail -n +5 big.md");
			const sedResult = await run("sed -n '4,6p' big.md");
			const tailResult = await run("tail -n 3 big.md");

			expect(catResult.stderr).toContain(
				`sed -n '${READ_HEAD_LARGE_FILE_MAX_LINES + 1},${READ_HEAD_LARGE_FILE_MAX_LINES * 2}p' ${bigPath}`,
			);
			expect(headResult.stdout).toContain(`Next page: sed -n '4,6p' ${bigPath}`);
			expect(tailForwardResult.stdout).toContain(
				`Next page: sed -n '${5 + READ_HEAD_LARGE_FILE_MAX_LINES},${5 + READ_HEAD_LARGE_FILE_MAX_LINES * 2 - 1}p' ${bigPath}`,
			);
			expect(sedResult.stdout).toContain(`Next page: sed -n '7,9p' ${bigPath}`);
			expect(tailResult.stdout).toContain(`head -n 3 ${bigPath}`);
		});

		test("does not emit precise reader continuations when the bounded scan is truncated", async () => {
			const bigFile = {
				path: "/big.md",
				kind: "file" as const,
				updatedAt: Date.now(),
				depthTruncated: false,
				contentType: "text/markdown;charset=utf-8",
				size: READ_INLINE_MAX_BYTES + 1,
			};
			const { run } = createBashRunner({ extraItems: [bigFile], scanTruncatedPaths: ["/big.md"] });
			const bigPath = `${test_app_files_mount}/big.md`;

			const headResult = await run(`head -n 3 ${bigPath}`);
			const tailForwardResult = await run(`tail -n +5 ${bigPath}`);
			const sedResult = await run(`sed -n '5,9p' ${bigPath}`);

			for (const result of [headResult, tailForwardResult, sedResult]) {
				expect(result.metadata.exitCode).toBe(0);
				expect(result.stdout).not.toContain("Next page:");
				expect(result.stdout).toContain("only");
			}
		});

		test("supports obsolete head and tail line-count flags on large files", async () => {
			const bigFile = {
				path: "/big.md",
				kind: "file" as const,
				updatedAt: Date.now(),
				depthTruncated: false,
				contentType: "text/markdown;charset=utf-8",
				size: READ_INLINE_MAX_BYTES + 1,
			};
			const { run } = createBashRunner({ extraItems: [bigFile] });
			const bigPath = `${test_app_files_mount}/big.md`;

			const headResult = await run(`head -5 ${bigPath}`);
			const tailResult = await run(`tail -3 ${bigPath}`);

			expect(headResult.metadata.exitCode).toBe(0);
			expect(headResult.stdout).toContain("line 1\nline 2\nline 3\nline 4\nline 5\n");
			expect(headResult.stdout).toContain(`Next page: sed -n '6,10p' ${bigPath}`);
			expect(tailResult.metadata.exitCode).toBe(0);
			expect(tailResult.stdout).toContain("line 998\nline 999\nline 1000\n");
			expect(tailResult.stdout).toContain(`head -n 3 ${bigPath}`);
		});

		test("rejects byte-range reads for oversized app files with explicit guidance", async () => {
			const bigFile = {
				path: "/big.md",
				kind: "file" as const,
				updatedAt: Date.now(),
				depthTruncated: false,
				contentType: "text/markdown;charset=utf-8",
				size: READ_INLINE_MAX_BYTES + 1,
			};
			const { run } = createBashRunner({ extraItems: [bigFile] });
			const bigPath = `${test_app_files_mount}/big.md`;

			const headResult = await run(`head -c 100 ${bigPath}`);
			const tailResult = await run(`tail -c 100 ${bigPath}`);

			expect(headResult.metadata.exitCode).toBe(1);
			expect(headResult.stderr).toContain("byte-range reads (-c) are not supported for large app files");
			expect(headResult.stderr).toContain(`wc -c ${bigPath}`);
			expect(tailResult.metadata.exitCode).toBe(1);
			expect(tailResult.stderr).toContain("byte-range reads (-c) are not supported for large app files");
			expect(tailResult.stderr).toContain(`wc -c ${bigPath}`);
		});

		test("wc over multiple app files reports per-file counts plus a total via the bounded stats path", async () => {
			const { run, runAction } = createBashRunner();

			const result = await run(`wc ${test_app_files_mount}/wc/a.md ${test_app_files_mount}/wc/b.md`);

			expect(result.metadata.exitCode).toBe(0);
			// Default triad (lines words bytes) per file, then a summed total line.
			expect(result.stdout).toContain(`3 5 20 ${test_app_files_mount}/wc/a.md`);
			expect(result.stdout).toContain(`2 4 12 ${test_app_files_mount}/wc/b.md`);
			expect(result.stdout).toContain("5 9 32 total");
			// Each file is counted via the bounded stats action — never a full content read.
			const statsCalls = runAction.mock.calls.filter((call) => {
				const actionArgs = call[1];
				return (
					actionArgs &&
					typeof actionArgs === "object" &&
					"path" in actionArgs &&
					(actionArgs.path === "/wc/a.md" || actionArgs.path === "/wc/b.md")
				);
			});
			expect(statsCalls).toHaveLength(2);

			// -l restricts the columns to the line count; the total still sums.
			const linesOnly = await run(`wc -l ${test_app_files_mount}/wc/a.md ${test_app_files_mount}/wc/b.md`);
			expect(linesOnly.metadata.exitCode).toBe(0);
			expect(linesOnly.stdout).toContain(`3 ${test_app_files_mount}/wc/a.md`);
			expect(linesOnly.stdout).toContain(`2 ${test_app_files_mount}/wc/b.md`);
			expect(linesOnly.stdout).toContain("5 total");

			const combinedLinesWords = await run(`wc -lw ${test_app_files_mount}/wc/a.md ${test_app_files_mount}/wc/b.md`);
			expect(combinedLinesWords.metadata.exitCode).toBe(0);
			expect(combinedLinesWords.stdout).toContain(`3 5 ${test_app_files_mount}/wc/a.md`);
			expect(combinedLinesWords.stdout).toContain(`2 4 ${test_app_files_mount}/wc/b.md`);
			expect(combinedLinesWords.stdout).toContain("5 9 total");

			const combinedCharsBytes = await run(`wc -mc ${test_app_files_mount}/wc/a.md ${test_app_files_mount}/wc/b.md`);
			expect(combinedCharsBytes.metadata.exitCode).toBe(0);
			expect(combinedCharsBytes.stdout).toContain(`20 20 ${test_app_files_mount}/wc/a.md`);
			expect(combinedCharsBytes.stdout).toContain(`12 12 ${test_app_files_mount}/wc/b.md`);
			expect(combinedCharsBytes.stdout).toContain("32 32 total");
		});

		test("multi-file wc flags windowed lower bounds and reports missing operands without aborting", async () => {
			const { run } = createBashRunner();

			const result = await run(`wc -l ${test_app_files_mount}/wc/windowed.md ${test_app_files_mount}/wc/missing.md`);

			// A missing operand reports an error and exit 1, but the readable file still counts.
			expect(result.metadata.exitCode).toBe(1);
			expect(result.stderr).toContain(`wc: ${test_app_files_mount}/wc/missing.md: No such file or directory`);
			expect(result.stdout).toContain(`40 ${test_app_files_mount}/wc/windowed.md`);
			expect(result.stdout).toContain("40 total");
			// The windowed file makes line/word/char counts lower bounds (bytes stay exact).
			expect(result.stdout).toContain("lower bounds");
		});

		test("multi-file wc uses the readable-sibling advisory for unreadable app operands", async () => {
			const { run } = createBashRunner();

			const result = await run(`wc ${test_app_files_mount}/wc/a.md ${test_app_files_mount}/source.pdf`);

			expect(result.metadata.exitCode).toBe(1);
			expect(result.stdout).toContain(`3 5 20 ${test_app_files_mount}/wc/a.md`);
			expect(result.stdout).toContain("3 5 20 total");
			expect(result.stderr).toContain("Markdown and plain text files only");
			expect(result.stderr).toContain(`${test_app_files_mount}/source.pdf.md`);
		});

		test("tail -n +K reads forward from line K on a large file (not the trailing window)", async () => {
			const bigFile = {
				path: "/big.md",
				kind: "file" as const,
				updatedAt: Date.now(),
				depthTruncated: false,
				contentType: "text/markdown;charset=utf-8",
				size: READ_INLINE_MAX_BYTES + 1,
			};
			const { run } = createBashRunner({ extraItems: [bigFile] });
			const bigPath = `${test_app_files_mount}/big.md`;

			const result = await run(`tail -n +5 ${bigPath}`);

			expect(result.metadata.exitCode).toBe(0);
			// Forward read from line 5 (not the last lines), bounded to the per-page cap.
			expect(result.stdout).toContain("line 5\nline 6\nline 7\n");
			expect(result.stdout).not.toContain("line 1000");
			// Forward continuation page via sed, anchored at the offset.
			expect(result.stdout).toContain(
				`sed -n '${5 + READ_HEAD_LARGE_FILE_MAX_LINES},${5 + READ_HEAD_LARGE_FILE_MAX_LINES * 2 - 1}p' ${bigPath}`,
			);
		});

		test("cat refuses a multi-file concatenation when a member is too large to inline", async () => {
			const bigFile = {
				path: "/big.md",
				kind: "file" as const,
				updatedAt: Date.now(),
				depthTruncated: false,
				contentType: "text/markdown;charset=utf-8",
				size: READ_INLINE_MAX_BYTES + 1,
			};
			const { run } = createBashRunner({ extraItems: [bigFile] });
			const bigPath = `${test_app_files_mount}/big.md`;
			const smallPath = `${test_app_files_mount}/docs/readme.md`;

			const result = await run(`cat ${bigPath} ${smallPath}`);

			expect(result.metadata.exitCode).toBe(1);
			expect(result.stderr).toContain("too large to concatenate");
			// Nothing from the small file is emitted: the refusal happens up front.
			expect(result.stdout).not.toContain("# Readme");
		});

		test("piping a large cat keeps the advisory out of the pipe", async () => {
			const bigFile = {
				path: "/big.md",
				kind: "file" as const,
				updatedAt: Date.now(),
				depthTruncated: false,
				contentType: "text/markdown;charset=utf-8",
				size: READ_INLINE_MAX_BYTES + 1,
			};
			const { run } = createBashRunner({ extraItems: [bigFile] });
			const bigPath = `${test_app_files_mount}/big.md`;

			const result = await run(`cat ${bigPath} | cat`);

			// The footer is on stderr, so only the file content flows downstream.
			expect(result.stdout).toContain("line 1");
			expect(result.stdout).not.toContain("showing the first");
		});

		test("oversize gate sizes on served (pending) content, not the committed asset", async () => {
			// Simulates the agent's own large write_file/edit_file edit living in files_pending_updates:
			// the committed asset is tiny, but the served content is large. The gate must fire on the
			// served size — otherwise a multi-MB unsaved file would be pulled inline unguarded.
			const pendingBig = {
				path: "/draft.md",
				kind: "file" as const,
				updatedAt: Date.now(),
				depthTruncated: false,
				contentType: "text/markdown;charset=utf-8",
				size: 12, // committed asset (what `stat` reports)
				servedSize: READ_INLINE_MAX_BYTES + 1, // unsaved pending overlay (what `cat` serves)
			};
			const { run } = createBashRunner({ extraItems: [pendingBig] });
			const draftPath = `${test_app_files_mount}/draft.md`;

			const result = await run(`cat ${draftPath}`);

			// Gate fired on the served size: bounded page on stdout, advisory carrying the served
			// byte count on stderr — even though the committed asset is only 12 bytes.
			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toContain("line 1\nline 2");
			expect(result.stderr).toContain(`is ${READ_INLINE_MAX_BYTES + 1} bytes`);
		});

		test("allows app exact reads through stream utilities but rejects direct app operands", async () => {
			const { run } = createBashRunner();

			const pipeline = await run(
				[
					`cat ${test_app_files_mount}/docs/tutorial.md | sort | uniq -c`,
					`cat ${test_app_files_mount}/docs/nested/deep.md | cut -d ':' -f 2`,
					`cat ${test_app_files_mount}/docs/readme.md | sed 's/Readme/Guide/'`,
					`cat ${test_app_files_mount}/docs/readme.md | awk '{print $1}'`,
				].join(" && "),
			);
			const directSort = await run(`sort ${test_app_files_mount}/docs/tutorial.md`);
			const directSed = await run(`sed 's/a/b/' ${test_app_files_mount}/docs/tutorial.md`);
			const directAwk = await run(`awk '{print $1}' ${test_app_files_mount}/docs/tutorial.md`);

			expect(pipeline.metadata.exitCode).toBe(0);
			expect(pipeline.stdout).toContain("2 alpha");
			expect(pipeline.stdout).toContain("two");
			expect(pipeline.stdout).toContain("# Guide");
			expect(pipeline.stdout).toContain("#");
			expect(directSort.metadata.exitCode).not.toBe(0);
			expect(directSort.stderr).toContain("Pipe the file through cat instead");
			expect(directSed.metadata.exitCode).not.toBe(0);
			expect(directSed.stderr).toContain("Pipe the file through cat instead");
			expect(directAwk.metadata.exitCode).not.toBe(0);
			expect(directAwk.stderr).toContain("Pipe the file through cat instead");
		});

		test("does not falsely reject a sed script that merely contains the mount path text", async () => {
			const { run } = createBashRunner();

			// The mount path appears inside the sed SCRIPT, not as a file operand; piping via cat
			// must run, not be rejected by an over-broad substring guard.
			const result = await run(`cat ${test_app_files_mount}/docs/readme.md | sed 's|${test_app_files_mount}|X|'`);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toContain("# Readme");
			expect(result.stderr).not.toContain("cannot be used as direct operands");
			expect(result.stderr).not.toContain("Pipe the file through cat instead");
		});

		test("rejects app writes and prevents mixed /tmp partial side effects", async () => {
			const { run } = createBashRunner();

			const touchResult = await run(`touch ${test_app_files_mount}/docs/readme.md`);
			const rmResult = await run(`rm -f ${test_app_files_mount}/docs/readme.md`);
			const mvResult = await run(`mv ${test_app_files_mount}/docs/readme.md /tmp/moved.md; cat /tmp/moved.md`);
			const teeResult = await run(
				`printf hi | tee /tmp/out.txt ${test_app_files_mount}/docs/readme.md; cat /tmp/out.txt`,
			);
			const redirectResult = await run(`printf hi > ${test_app_files_mount}/docs/redirect.md`);

			expect(touchResult.metadata.exitCode).not.toBe(0);
			expect(touchResult.stderr).toContain("write_file");
			expect(touchResult.stderr).toContain("edit_file");
			expect(rmResult.metadata.exitCode).not.toBe(0);
			expect(rmResult.stderr).toContain("cannot delete app file");
			expect(mvResult.metadata.exitCode).not.toBe(0);
			expect(mvResult.stderr).toContain("cannot move or rename app files");
			expect(mvResult.stderr).toContain("write_file");
			expect(teeResult.metadata.exitCode).not.toBe(0);
			expect(teeResult.stdout).toContain("hi");
			expect(teeResult.stderr).toContain("write_file");
			expect(redirectResult.metadata.exitCode).not.toBe(0);
			expect(redirectResult.stderr).toContain("write_file/edit_file");
			expect(redirectResult.stderr).toContain("shell redirects into app files are unsupported");
		});

		test("copies one exact readable app file to scratch and rejects unreadable app copies", async () => {
			const { run } = createBashRunner();

			const copied = await run(`cp ${test_app_files_mount}/docs/readme.md /tmp/readme.md && cat /tmp/readme.md`);
			const unreadable = await run(`cp ${test_app_files_mount}/source.pdf /tmp/source.pdf`);

			expect(copied.metadata.exitCode).toBe(0);
			expect(copied.stdout).toContain("unique-token");
			expect(unreadable.metadata.exitCode).not.toBe(0);
			expect(unreadable.stderr).toContain("unsupported app file content type");
		});

		test("keeps nested shells, xargs, and which inside the curated command surface", async () => {
			const { run } = createBashRunner();

			const nested = await run(`bash -c 'ls --limit 1 ${test_app_files_mount}/docs'`);
			const nestedLoginForm = await run(`bash -lc 'ls --limit 1 ${test_app_files_mount}/docs'`);
			const xargsResult = await run(`printf '${test_app_files_mount}/docs/readme.md\\n' | xargs cat`);
			const xargsParallel = await run("printf hi | xargs -P 2 echo");
			const whichResult = await run("which ls find cat && which -s bash");

			expect(nested.metadata.exitCode).toBe(0);
			expect(nested.stdout).toContain("nested/");
			expect(nestedLoginForm.metadata.exitCode).toBe(0);
			expect(nestedLoginForm.stdout).toContain("nested/");
			expect(xargsResult.metadata.exitCode).toBe(0);
			expect(xargsResult.stdout).toContain("unique-token");
			expect(xargsParallel.metadata.exitCode).toBe(2);
			expect(xargsParallel.stderr).toContain("parallel execution");
			expect(whichResult.metadata.exitCode).toBe(0);
			expect(whichResult.stdout).toContain("/usr/bin/ls");
			expect(whichResult.stdout).toContain("/usr/bin/find");
			expect(whichResult.stdout).toContain("/usr/bin/cat");
		});

		test("rejects xargs -n with a non-positive or non-numeric value instead of silently batching all items", async () => {
			const { run } = createBashRunner();

			const zero = await run("printf 'a\\nb\\nc\\n' | xargs -n 0 echo");
			const nonNumeric = await run("printf 'a\\nb\\nc\\n' | xargs -n x echo");
			const valid = await run("printf 'a\\nb\\nc\\n' | xargs -n 1 echo");

			expect(zero.metadata.exitCode).toBe(2);
			expect(zero.stderr).toContain("xargs: -n requires a positive integer");
			expect(nonNumeric.metadata.exitCode).toBe(2);
			expect(nonNumeric.stderr).toContain("xargs: -n requires a positive integer");
			expect(valid.metadata.exitCode).toBe(0);
		});

		test("parses options after the search query", async () => {
			const { run, runQuery } = createBashRunner();

			await run("search unique-token --limit 5");

			expect(runQuery).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					query: "unique-token",
					numItems: 5,
				}),
			);
		});

		test("reports stdout truncation without path-index truncation", async () => {
			const { run } = createBashRunner();

			const result = await run("seq 1 40000");

			expect(result.metadata.stdoutTruncated).toBe(true);
			expect(result.metadata.stdoutLength).toBeGreaterThan(30_000);
			expect(result.metadata.pathIndexTruncated).toBe(false);
			expect(result.stdout).toContain("[truncated after 30000 characters]");
		});
	});
}
