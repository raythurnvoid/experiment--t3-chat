"use node";

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
import { minimatch } from "minimatch";
import { z } from "zod";
import { internal } from "./_generated/api.js";
import { internalAction, type ActionCtx } from "./_generated/server.js";
import type { Doc, Id } from "./_generated/dataModel";
import type { ai_chat_get_thread_state_Result } from "./ai_chat.ts";
import type {
	files_nodes_create_folder_node_by_path_Result,
	files_nodes_get_bash_path_entry_Result,
	files_nodes_get_bash_stat_entry_Result,
	files_nodes_get_by_path_Result,
	files_nodes_get_file_last_available_markdown_content_by_path_Result,
	files_nodes_list_dir_children_paginated_Result,
	files_nodes_list_path_prefix_paginated_Result,
	files_nodes_list_subtree_paginated_Result,
	files_nodes_text_search_files_Result,
} from "./files_nodes.ts";
import { files_chunk_BITMASK_FLAGS, files_chunk_has_bitmask_flag } from "../server/files-markdown-chunking-mastra.ts";

const HOME = "/home/cloud-usr";
const MOUNT_ROOT = `${HOME}/w`;
const TMP_MOUNT = "/tmp";
const DEFAULT_CWD = "~";
const OUTPUT_LIMIT = 30_000;
const TERMINAL_LINE_ENDING_REGEX = /\r\n?/g;
const TERMINAL_TRAILING_NEWLINE_REGEX = /\n+$/;
const textEncoder = new TextEncoder();

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
	path: Doc<"files_nodes">["path"];
	kind: Doc<"files_nodes">["kind"];
	updatedAt: Doc<"files_nodes">["updatedAt"];
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
function app_path_to_shell_path(appFilesMountPath: string, appPath: string) {
	const normalizedPath = normalize_path(appPath);
	return normalizedPath === "/" ? appFilesMountPath : `${appFilesMountPath}${normalizedPath}`;
}

/**
 * Convert a mounted shell path back to a real app file path.
 */
function shell_path_to_app_path(appFilesMountPath: string, shellPath: string) {
	const normalizedPath = normalize_path(shellPath);
	if (normalizedPath === appFilesMountPath) {
		return "/";
	}
	if (normalizedPath.startsWith(`${appFilesMountPath}/`)) {
		return normalize_path(normalizedPath.slice(appFilesMountPath.length));
	}
	return null;
}

function shell_arg_quote(arg: string) {
	return /^[A-Za-z0-9_/:.,=+-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
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
function expand_persisted_bash_cwd(value: string | undefined) {
	const cwd = value?.trim() || DEFAULT_CWD;
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
 * Build a read-only filesystem error for a bash-visible path.
 */
function readonly_error(path: string) {
	return new Error(`EROFS: read-only file system, '${normalize_path(path)}'`);
}

class AppFileContentUnavailableError extends Error {
	readonly shellPath: string;
	readonly contentType: string | undefined;

	constructor(args: { shellPath: string; contentType: string | undefined }) {
		super(`unsupported app file content type '${args.contentType ?? "unknown"}'`);
		this.name = "AppFileContentUnavailableError";
		this.shellPath = args.shellPath;
		this.contentType = args.contentType;
	}
}

function app_glob_syntax_error(command: string, path: string) {
	return (
		`${command}: app file glob patterns are not supported: ${path}\n` +
		`Use an exact path, or use find with a predicate:\n` +
		`  find --extension md          # files ending in .md\n` +
		`  find -name PATTERN           # glob name match, e.g. -name '*.md' or -name '?.md'\n` +
		`  find -iname PATTERN          # case-insensitive name match\n`
	);
}

function has_glob_metacharacters(path: string) {
	return /[*?[\]]/u.test(path);
}

function is_under_app_mount(appFilesMountPath: string, shellPath: string) {
	const normalizedPath = normalize_path(shellPath);
	return normalizedPath === appFilesMountPath || normalizedPath.startsWith(`${appFilesMountPath}/`);
}

function is_under_tmp_mount(shellPath: string) {
	const normalizedPath = normalize_path(shellPath);
	return normalizedPath === TMP_MOUNT || normalizedPath.startsWith(`${TMP_MOUNT}/`);
}

function resolve_command_path(commandCtx: CommandContext, path: string) {
	return resolve_path(commandCtx.cwd, path);
}

function command_path_to_app_path(commandCtx: CommandContext, appFilesMountPath: string, path: string) {
	return shell_path_to_app_path(appFilesMountPath, resolve_command_path(commandCtx, path));
}

function command_usage_error(stderr: string) {
	return {
		stdout: "",
		stderr,
		exitCode: 2,
	};
}

function command_failure(stderr: string) {
	return {
		stdout: "",
		stderr,
		exitCode: 1,
	};
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

	return {
		value: `${value.slice(0, OUTPUT_LIMIT)}\n\n[truncated after ${OUTPUT_LIMIT} characters]`,
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
});

function search_command_parse_args(args: string[], appFilesMountPath: string) {
	let unsupportedOption: string | null = null;
	const parsedArgs = mri<{ limit?: string }>(args, {
		string: ["limit"],
		alias: {
			limit: [],
		},
		default: {
			limit: "20",
		},
		unknown: (option) => {
			unsupportedOption ??= option;
		},
	});

	if (unsupportedOption != null) {
		return { error: `search: unsupported option ${unsupportedOption}` };
	}

	const result = search_command_args_schema.safeParse(parsedArgs);
	if (!result.success) {
		const hasLimitError = result.error.issues.some((issue) => issue.path[0] === "limit");
		return { error: hasLimitError ? "search: --limit must be an integer" : "search: missing query" };
	}

	// Keep content search from silently treating a path filter as part of the text query.
	const pathOperand = result.data._.find(
		(arg) =>
			arg.includes("/") ||
			arg.startsWith("~") ||
			arg === "." ||
			arg === ".." ||
			is_under_app_mount(appFilesMountPath, normalize_path(arg)),
	);
	if (pathOperand != null) {
		return {
			error:
				`search: path operands are not supported: ${pathOperand}\n` +
				"search searches the ENTIRE workspace and does not accept path filters.\n" +
				"Remove the path and run: search --limit N <query terms only>\n" +
				"To restrict to one folder, keep only the result paths that start with that folder.",
		};
	}

	const query = result.data._.join(" ").trim();
	return query
		? {
				query,
				limit: Math.max(1, Math.min(100, result.data.limit)),
			}
		: { error: "search: missing query" };
}

function search_command_create(ctx: ActionCtx, ctxData: WorkspaceFsOptions["ctxData"], appFilesMountPath: string) {
	return {
		name: "search",
		trusted: true,
		execute: async (args: string[]) => {
			const parsed = search_command_parse_args(args, appFilesMountPath);
			if (parsed.error != null) {
				return {
					stdout: "",
					stderr: `${parsed.error}\nUsage: search [--limit N] <query...>\n`,
					exitCode: 2,
				};
			}

			const res = (await ctx.runQuery(internal.files_nodes.text_search_files, {
				workspaceId: ctxData.workspaceId,
				projectId: ctxData.projectId,
				query: parsed.query,
				limit: parsed.limit,
			})) as files_nodes_text_search_files_Result;
			const searchResult = {
				items: res.items.map((item) => ({
					...item,
					path: app_path_to_shell_path(appFilesMountPath, item.path),
				})),
			};
			let output = "No files found";

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

				output = [`Found ${searchResult.items.length} results`, "", ...outputBlocks].join("\n");
			}

			return {
				stdout: `${output}\n`,
				stderr: "",
				exitCode: 0,
			};
		},
	};
}

// #endregion search command

// #region app file shell commands

const LISTING_DEFAULT_LIMIT = 100;
const LISTING_MAX_LIMIT = 200;
const APP_COMMAND_NAMES = new Set<string>([...ALLOWED_COMMANDS, "search"]);

async function delegate_builtin_command(command: CommandName, args: string[], ctx: CommandContext, options?: { cwd?: string }) {
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
		return { error: `${command}: --limit must be an integer` };
	}
	return { limit: Math.max(1, Math.min(LISTING_MAX_LIMIT, Number(rawValue))) };
}

function default_app_target_shell_path(cwd: string, appFilesMountPath: string) {
	const normalizedCwd = normalize_path(cwd);
	return is_under_app_mount(appFilesMountPath, normalizedCwd) ? normalizedCwd : appFilesMountPath;
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

function parse_ls_args(args: string[]) {
	let limitValue: string | undefined;
	let cursor: string | null = null;
	const paths: string[] = [];
	let unsupportedOption: string | null = null;

	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		if (arg === "--limit") {
			limitValue = args[++index];
			continue;
		}
		if (arg.startsWith("--limit=")) {
			limitValue = arg.slice("--limit=".length);
			continue;
		}
		if (arg === "--cursor") {
			cursor = args[++index] ?? null;
			continue;
		}
		if (arg.startsWith("--cursor=")) {
			cursor = arg.slice("--cursor=".length);
			continue;
		}
		if (arg.startsWith("-")) {
			unsupportedOption ??= arg;
			continue;
		}
		paths.push(arg);
	}

	const limit = parse_listing_limit("ls", limitValue);
	if (limit.error != null) {
		return limit;
	}
	if (paths.length > 1) {
		return { error: "ls: app file listings support one path at a time" } as const;
	}

	if (cursor != null && cursor.trim() === "") {
		cursor = null;
	}

	return {
		path: paths[0],
		limit: limit.limit,
		cursor,
		hasAppListingOption: limitValue != null || cursor != null,
		unsupportedOption,
	} as const;
}

function ls_command_create(ctx: ActionCtx, ctxData: WorkspaceFsOptions["ctxData"], appFilesMountPath: string) {
	return defineCommand("ls", async (args, commandCtx) => {
		const parsed = parse_ls_args(args);
		if ("error" in parsed) {
			return command_usage_error(`${parsed.error}\nUsage: ls [--limit N] [--cursor CURSOR] [PATH]\n`);
		}

		const targetShellPath = resolve_path(
			commandCtx.cwd,
			parsed.path ?? default_app_target_shell_path(commandCtx.cwd, appFilesMountPath),
		);
		const appPath = shell_path_to_app_path(appFilesMountPath, targetShellPath);
		if (appPath == null) {
			if (parsed.hasAppListingOption) {
				return command_usage_error(
					"ls: --limit and --cursor are only available for app file paths\n" +
						`Omit PATH to list the app root, or use ${appFilesMountPath} explicitly. Use plain ls for /tmp.\n`,
				);
			}
			return await delegate_builtin_command("ls", args, commandCtx);
		}

		if (parsed.unsupportedOption != null) {
			if (parsed.unsupportedOption === "--next-page") {
				return command_usage_error(
					"ls: --next-page is not supported for app files\n" +
						"Copy the exact `Next page: ls --limit N --cursor ... <path>` command from the previous ls output.\n" +
						"Usage: ls [--limit N] [--cursor CURSOR] [PATH]\n",
				);
			}
			const opt = parsed.unsupportedOption;
			const hint =
				opt === "-R" || opt === "--recursive"
					? "For recursive listing use: find <path> --limit N [-maxdepth N]"
					: opt === "-l" || opt === "-la" || opt === "-al" || opt === "-a"
						? "App ls does not support long/hidden format flags; use: ls [--limit N] [PATH]"
						: "App ls only supports --limit and --cursor";
			return command_usage_error(
				`ls: unsupported option ${opt} for app files\n${hint}\nUsage: ls [--limit N] [--cursor CURSOR] [PATH]\n`,
			);
		}
		if (parsed.path != null && has_glob_metacharacters(parsed.path)) {
			return command_usage_error(app_glob_syntax_error("ls", parsed.path));
		}

		const entry = await get_bash_path_entry(ctx, ctxData, appPath);
		if (!entry) {
			return command_failure(`ls: cannot access '${targetShellPath}': No such file or directory\n`);
		}
		if (entry.kind === "file") {
			if (parsed.cursor != null) {
				return command_usage_error(`ls: --cursor can only continue a directory listing\n`);
			}
			return {
				stdout: `${targetShellPath}\n`,
				stderr: "",
				exitCode: 0,
			};
		}

		const result = (await ctx.runQuery(internal.files_nodes.list_dir_children_paginated, {
			workspaceId: ctxData.workspaceId,
			projectId: ctxData.projectId,
			path: appPath,
			numItems: parsed.limit,
			cursor: parsed.cursor,
		})) as files_nodes_list_dir_children_paginated_Result;

		const lines = result.items.map((item) => (item.kind === "folder" ? `${item.name}/` : item.name));
		if (!result.isDone) {
			if (lines.length === 0) {
				lines.push("No items in this page; more pages exist.");
			}
			lines.push("", `Next page: ls --limit ${parsed.limit} --cursor ${shell_arg_quote(result.continueCursor)} ${shell_arg_quote(targetShellPath)}`);
		}

		if (lines.length === 0) {
			return {
				stdout: "(empty directory)\n",
				stderr: "",
				exitCode: 0,
			};
		}

		return {
			stdout: `${lines.join("\n")}\n`,
			stderr: "",
			exitCode: 0,
		};
	});
}

function find_read_value(args: string[], index: number, option: string) {
	const value = args[index + 1];
	if (value == null) {
		return { error: `find: ${option} requires a value` };
	}
	return { value, nextIndex: index + 1 };
}

function parse_find_args(args: string[]) {
	let path: string | undefined;
	let pathPrefix: string | undefined;
	let limitValue: string | undefined;
	let cursor: string | null = null;
	let maxDepthValue: string | undefined;
	let type: string | undefined;
	let name: string | undefined;
	let iname: string | undefined;
	let extension: string | undefined;

	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;

		if (arg === "--limit") {
			const value = find_read_value(args, index, "--limit");
			if (value.error != null) return value;
			limitValue = value.value;
			index = value.nextIndex;
			continue;
		}
		if (arg.startsWith("--limit=")) {
			limitValue = arg.slice("--limit=".length);
			continue;
		}
		if (arg === "--cursor") {
			const value = find_read_value(args, index, "--cursor");
			if (value.error != null) return value;
			cursor = value.value;
			index = value.nextIndex;
			continue;
		}
		if (arg.startsWith("--cursor=")) {
			cursor = arg.slice("--cursor=".length);
			continue;
		}
		if (arg === "--prefix") {
			const value = find_read_value(args, index, "--prefix");
			if (value.error != null) return value;
			pathPrefix = value.value;
			index = value.nextIndex;
			continue;
		}
		if (arg.startsWith("--prefix=")) {
			pathPrefix = arg.slice("--prefix=".length);
			continue;
		}
		if (arg === "-maxdepth" || arg === "--maxdepth") {
			const value = find_read_value(args, index, arg);
			if (value.error != null) return value;
			maxDepthValue = value.value;
			index = value.nextIndex;
			continue;
		}
		if (arg === "-type" || arg === "--type") {
			const value = find_read_value(args, index, arg);
			if (value.error != null) return value;
			type = value.value;
			index = value.nextIndex;
			continue;
		}
		if (arg === "-name" || arg === "--name") {
			const value = find_read_value(args, index, arg);
			if (value.error != null) return value;
			name = value.value;
			index = value.nextIndex;
			continue;
		}
		if (arg === "-iname" || arg === "--iname") {
			const value = find_read_value(args, index, arg);
			if (value.error != null) return value;
			iname = value.value;
			index = value.nextIndex;
			continue;
		}
		if (arg === "--extension") {
			const value = find_read_value(args, index, arg);
			if (value.error != null) return value;
			extension = value.value;
			index = value.nextIndex;
			continue;
		}
		if (arg.startsWith("--extension=")) {
			extension = arg.slice("--extension=".length);
			continue;
		}
		if (arg.startsWith("-") || arg === "!" || arg === "(" || arg === ")") {
			return { error: `find: unsupported predicate ${arg} (GNU find extensions like -printf, -mtime, -newer, -exec, -ok are not available for app files; omit them and use -name PATTERN, -type f|d, -maxdepth N, or --extension EXT instead)` } as const;
		}
		if (path != null) {
			return { error: "find: app file find supports one path only" } as const;
		}
		path = arg;
	}

	if (pathPrefix != null && path != null) {
		return { error: "find: --prefix cannot be combined with PATH" } as const;
	}

	const limit = parse_listing_limit("find", limitValue);
	if (limit.error != null) {
		return limit;
	}

	let maxDepth: number | null = null;
	if (maxDepthValue != null) {
		if (!/^\d+$/u.test(maxDepthValue.trim())) {
			return { error: "find: -maxdepth must be a non-negative integer" } as const;
		}
		maxDepth = Number(maxDepthValue);
	}

	if (type != null && type !== "f" && type !== "d") {
		return { error: "find: -type supports only f or d for app files" } as const;
	}

	let normalizedExtension: string | undefined;
	if (extension != null) {
		const trimmedExtension = extension.trim();
		if (trimmedExtension === "" || trimmedExtension === ".") {
			return { error: "find: --extension requires a file extension" } as const;
		}
		normalizedExtension = trimmedExtension.startsWith(".") ? trimmedExtension : `.${trimmedExtension}`;
	}

	return {
		path,
		pathPrefix,
		limit: limit.limit,
		cursor,
		hasAppListingOption: limitValue != null || cursor != null,
		maxDepth,
		type,
		name,
		iname,
		extension: normalizedExtension,
	} as const;
}

function path_depth_from_base(basePath: string, itemPath: string) {
	const normalizedBase = normalize_path(basePath);
	const normalizedItem = normalize_path(itemPath);
	if (normalizedItem === normalizedBase) {
		return 0;
	}
	const suffix = normalizedBase === "/" ? normalizedItem.slice(1) : normalizedItem.slice(normalizedBase.length + 1);
	return suffix.split("/").filter(Boolean).length;
}

function path_basename(path: string) {
	const segments = normalize_path(path).split("/").filter(Boolean);
	return segments.at(-1) ?? "";
}

function find_prefix_to_app_path(commandCtx: CommandContext, appFilesMountPath: string, pathPrefix: string) {
	if (has_glob_metacharacters(pathPrefix)) {
		return { error: app_glob_syntax_error("find", pathPrefix) };
	}
	if (pathPrefix === "/" || pathPrefix.startsWith("/") || pathPrefix.startsWith("~/")) {
		const shellPath = pathPrefix.startsWith("~/") ? normalize_path(`${HOME}/${pathPrefix.slice(2)}`) : normalize_path(pathPrefix);
		const mountedAppPath = shell_path_to_app_path(appFilesMountPath, shellPath);
		return { appPath: mountedAppPath ?? normalize_path(pathPrefix) };
	}

	const cwd = normalize_path(commandCtx.cwd);
	if (is_under_app_mount(appFilesMountPath, cwd)) {
		return { appPath: command_path_to_app_path(commandCtx, appFilesMountPath, pathPrefix) ?? normalize_path(pathPrefix) };
	}
	return { appPath: normalize_path(pathPrefix) };
}

function find_item_matches(
	item: { path: string; kind: "folder" | "file" },
	parsed: {
		maxDepth: number | null;
		type: string | undefined;
		name: string | undefined;
		iname: string | undefined;
		extension: string | undefined;
	},
	basePath: string,
) {
	if (parsed.maxDepth != null && path_depth_from_base(basePath, item.path) > parsed.maxDepth) {
		return false;
	}
	if (parsed.type != null && (parsed.type === "f" ? item.kind !== "file" : item.kind !== "folder")) {
		return false;
	}
	if (parsed.name != null && !minimatch(path_basename(item.path), parsed.name)) {
		return false;
	}
	if (parsed.iname != null && !minimatch(path_basename(item.path), parsed.iname, { nocase: true })) {
		return false;
	}
	if (parsed.extension != null && (item.kind !== "file" || !path_basename(item.path).endsWith(parsed.extension))) {
		return false;
	}
	return true;
}

function find_command_create(ctx: ActionCtx, ctxData: WorkspaceFsOptions["ctxData"], appFilesMountPath: string) {
	return defineCommand("find", async (args, commandCtx) => {
		const parsed = parse_find_args(args);
		if ("error" in parsed) {
			return {
				stdout: "",
				stderr:
					`${parsed.error}\n` +
					"Usage: find [PATH] [--prefix PREFIX] [-maxdepth N] [-type f|d] [-name PATTERN|-iname PATTERN] [--extension EXT] [--limit N] [--cursor CURSOR]\n",
				exitCode: 2,
			};
		}

		if (parsed.pathPrefix != null) {
			const prefix = find_prefix_to_app_path(commandCtx, appFilesMountPath, parsed.pathPrefix);
			if (prefix.error != null) {
				return command_usage_error(prefix.error);
			}
			const result = (await ctx.runQuery(internal.files_nodes.list_path_prefix_paginated, {
				workspaceId: ctxData.workspaceId,
				projectId: ctxData.projectId,
				pathPrefix: prefix.appPath,
				numItems: parsed.limit,
				cursor: parsed.cursor,
			})) as files_nodes_list_path_prefix_paginated_Result;

			const lines = result.items
				.filter((item) => find_item_matches(item, parsed, prefix.appPath))
				.map((item) => `${app_path_to_shell_path(appFilesMountPath, item.path)}${item.kind === "folder" ? "/" : ""}`);
			if (!result.isDone) {
				if (lines.length === 0) {
					lines.push("No matches in this page; more pages exist.");
				}
				lines.push("", build_find_continuation({ parsed, target: null, prefix: parsed.pathPrefix, cursor: result.continueCursor }));
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
				return command_usage_error(
					"find: --limit and --cursor are only available for app file paths\n" +
						`Omit PATH to search the app root, or use ${appFilesMountPath} explicitly. Use plain find for /tmp.\n`,
				);
			}
			return await delegate_builtin_command("find", args, commandCtx);
		}
		if (parsed.path != null && has_glob_metacharacters(parsed.path)) {
			return command_usage_error(app_glob_syntax_error("find", parsed.path));
		}

		const entry = await get_bash_path_entry(ctx, ctxData, appPath);
		if (!entry) {
			return command_failure(
				`find: ${targetShellPath}: No such file or directory\n` +
				`If you intended a path prefix search (paths whose names START WITH this string), run:\n` +
				`  find --prefix ${shell_arg_quote(targetShellPath)} --limit ${parsed.limit}\n`,
			);
		}

		const result = (await ctx.runQuery(internal.files_nodes.list_subtree_paginated, {
			workspaceId: ctxData.workspaceId,
			projectId: ctxData.projectId,
			path: appPath,
			numItems: parsed.limit,
			cursor: parsed.cursor,
		})) as files_nodes_list_subtree_paginated_Result;

		const lines = result.items
			.filter((item) => find_item_matches(item, parsed, appPath))
			.map((item) => `${app_path_to_shell_path(appFilesMountPath, item.path)}${item.kind === "folder" ? "/" : ""}`);

		if (!result.isDone) {
			if (lines.length === 0) {
				lines.push("No matches in this page; more pages exist.");
			}
			lines.push("", build_find_continuation({ parsed, target: targetShellPath, prefix: null, cursor: result.continueCursor }));
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

function build_find_continuation(args: {
	parsed: ReturnType<typeof parse_find_args> & { error?: never };
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
	if (args.parsed.maxDepth != null) {
		continuationParts.push("-maxdepth", String(args.parsed.maxDepth));
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
	if (args.parsed.extension != null) {
		continuationParts.push("--extension", shell_arg_quote(args.parsed.extension));
	}
	continuationParts.push("--limit", String(args.parsed.limit), "--cursor", shell_arg_quote(args.cursor));
	return continuationParts.join(" ");
}

function create_tree_command(appFilesMountPath: string) {
	return defineCommand("tree", async (args, commandCtx) => {
		// Skip flags and their values (e.g. -L 4, -P pattern) to find the path operand.
		const valueFlags = new Set(["-L", "-P", "-I", "--filelimit", "-o"]);
		let path: string | undefined;
		for (let index = 0; index < args.length; index++) {
			const arg = args[index]!;
			if (valueFlags.has(arg)) {
				index++; // skip value
				continue;
			}
			if (arg.startsWith("-")) continue;
			path = arg;
			break;
		}
		const targetShellPath = resolve_path(
			commandCtx.cwd,
			path ?? default_app_target_shell_path(commandCtx.cwd, appFilesMountPath),
		);
		if (!is_under_app_mount(appFilesMountPath, targetShellPath)) {
			return await delegate_builtin_command("tree", args, commandCtx);
		}
		const suggestedPath = shell_arg_quote(targetShellPath);
		return command_usage_error(
			`tree is not available for app files.\n` +
			`Use find instead to explore the folder structure:\n` +
			`  find ${suggestedPath} --limit 100 -maxdepth 2\n` +
			`Add -maxdepth N to control depth, or omit to list all levels.\n`,
		);
	});
}

function create_grep_command() {
	return defineCommand("grep", async (args) => {
		const valueOptions = new Set(["-e", "-m", "-A", "-B", "-C", "--regexp", "--max-count", "--after-context", "--before-context", "--context"]);
		let suggestedQuery: string | undefined;
		for (let index = 0; index < args.length; index++) {
			const arg = args[index]!;
			if (valueOptions.has(arg)) {
				const value = args[++index];
				if (value && !value.startsWith("/") && !value.startsWith("-")) {
					suggestedQuery ??= value;
				}
				continue;
			}
			if (arg.startsWith("--regexp=")) {
				const value = arg.slice("--regexp=".length);
				if (value) suggestedQuery ??= value;
				continue;
			}
			if (arg.trim() && !arg.startsWith("-") && !arg.startsWith("/")) {
				suggestedQuery ??= arg;
			}
		}
		const suggestedCommand = suggestedQuery ? `search --limit 20 ${suggestedQuery}` : "search --limit 20 <query>";
		return {
			stdout:
				[
					"grep over app files is not supported; use search --limit N <query>.",
					"Use the indexed search command for app file content search:",
					`  ${suggestedCommand}`,
					"IMPORTANT: search takes query terms ONLY. Do NOT pass file paths or directory operands to search.",
					"search always covers the entire workspace — there is no path filter.",
					"To restrict to one folder, run the search above and keep only the result paths that start with that folder; do NOT enumerate files with find/grep.",
					"The search command uses the Convex text index and returns matching file paths with snippets.",
				].join("\n") + "\n",
			stderr: "",
			exitCode: 2,
		};
	});
}

function create_cat_command(appFilesMountPath: string) {
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
				return command_usage_error(`cat: unsupported option ${arg}\nUsage: cat [-n] [FILE...]\n`);
			}
			files.push(arg);
		}

		const targets = files.length ? files : ["-"];
		let stdout = "";
		let stderr = "";
		let exitCode = 0;
		let lineNumber = 1;

		for (const file of targets) {
			let content: string;
			if (file === "-") {
				content = commandCtx.stdin as unknown as string;
			} else {
				if (has_glob_metacharacters(file)) {
					return command_usage_error(app_glob_syntax_error("cat", file));
				}
				const resolvedPath = resolve_command_path(commandCtx, file);
				try {
					content = await commandCtx.fs.readFile(resolvedPath);
				} catch (error) {
					if (error instanceof AppFileContentUnavailableError) {
						content = build_unreadable_file_advisory(appFilesMountPath, shell_path_to_app_path(appFilesMountPath, error.shellPath) ?? file, error.contentType);
					} else {
						const msg = error instanceof Error ? error.message : String(error);
						if (msg.startsWith("EISDIR")) {
							stderr += `cat: ${file}: Is a directory\n`;
						} else {
							stderr += `cat: ${file}: No such file or directory\n`;
						}
						exitCode = 1;
						continue;
					}
				}
			}

			if (showLineNumbers) {
				const numbered = add_cat_line_numbers(content, lineNumber);
				stdout += numbered.content;
				lineNumber = numbered.nextLineNumber;
			} else {
				stdout += content;
			}
		}

		return { stdout, stderr, exitCode, stdoutEncoding: "binary" };
	});
}

function add_cat_line_numbers(content: string, startLine: number) {
	const lines = content.split("\n");
	const hasTrailingNewline = content.endsWith("\n");
	const linesToNumber = hasTrailingNewline ? lines.slice(0, -1) : lines;
	const numbered = linesToNumber.map((line, index) => `${String(startLine + index).padStart(6)}\t${line}`);
	return {
		content: numbered.join("\n") + (hasTrailingNewline ? "\n" : ""),
		nextLineNumber: startLine + linesToNumber.length,
	};
}

function build_unreadable_file_advisory(appFilesMountPath: string, normalizedPath: string, contentType: string | undefined) {
	const shellPath = app_path_to_shell_path(appFilesMountPath, normalizedPath);
	const lastSlashIndex = normalizedPath.lastIndexOf("/");
	const lastDotIndex = normalizedPath.lastIndexOf(".");
	const appPathWithoutExtension = lastDotIndex > lastSlashIndex ? normalizedPath.slice(0, lastDotIndex) : normalizedPath;
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

function parse_stat_args(args: string[]) {
	let format: string | null = null;
	const files: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		if (arg === "--help") {
			return { delegate: true } as const;
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
			return { error: `stat: unsupported option ${arg}` } as const;
		}
		files.push(arg);
	}
	if (files.length === 0) {
		return { error: "stat: missing operand" } as const;
	}
	return { format, files } as const;
}

function format_stat_mode(mode: number, isDirectory: boolean) {
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

function render_stat_output(format: string | null, file: string, stat: { isDirectory: boolean; mode: number; size: number | undefined; mtime: Date }) {
	const modeOctal = stat.mode.toString(8);
	const modeStr = format_stat_mode(stat.mode, stat.isDirectory);
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
	const sizeDisplay = stat.size !== undefined
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
		"",
	].join("\n");
}

function create_stat_command(ctx: ActionCtx, ctxData: WorkspaceFsOptions["ctxData"], appFilesMountPath: string) {
	return defineCommand("stat", async (args, commandCtx) => {
		const parsed = parse_stat_args(args);
		if ("delegate" in parsed) {
			return await delegate_builtin_command("stat", args, commandCtx);
		}
		if ("error" in parsed) {
			return command_usage_error(`${parsed.error}\n`);
		}

		let stdout = "";
		let stderr = "";
		let hasError = false;
		for (const file of parsed.files) {
			if (has_glob_metacharacters(file)) {
				stderr += app_glob_syntax_error("stat", file);
				hasError = true;
				continue;
			}
			const resolvedPath = resolve_command_path(commandCtx, file);
			const appPath = shell_path_to_app_path(appFilesMountPath, resolvedPath);
			try {
				if (appPath == null) {
					const stat = await commandCtx.fs.stat(resolvedPath);
					stdout += render_stat_output(parsed.format, file, stat);
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
				stdout += render_stat_output(parsed.format, file, {
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

function create_file_operand_guard_command(
	command: CommandName,
	appFilesMountPath: string,
	argsToFiles: (args: string[]) => { files: string[]; outputFiles?: string[]; error?: string; delegateCwd?: string },
) {
	return defineCommand(command, async (args, commandCtx) => {
		const parsed = argsToFiles(args);
		if (parsed.error != null) {
			return command_usage_error(`${parsed.error}\n`);
		}
		for (const file of [...parsed.files, ...(parsed.outputFiles ?? [])]) {
			if (has_glob_metacharacters(file)) {
				return command_usage_error(app_glob_syntax_error(command, file));
			}
			const resolvedPath = resolve_command_path(commandCtx, file);
			if (is_under_app_mount(appFilesMountPath, resolvedPath)) {
				return command_failure(
					`${command}: direct app file operands are not supported for '${file}'\n` +
					`Pipe the file through cat instead: cat '${file}' | ${command}\n`,
				);
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
		create_file_operand_guard_command("sed", appFilesMountPath, (args) => {
			const files: string[] = [];
			let hasScript = false;
			for (let index = 0; index < args.length; index++) {
				const arg = args[index]!;
				if (arg.includes(appFilesMountPath)) {
					return { files: [], error: `sed: app file paths cannot be used as direct operands: ${arg.trim()}\nPipe the file through cat instead: cat '${arg.trim()}' | sed '<script>'` };
				}
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
			return { files, delegateCwd: TMP_MOUNT };
		}),
		create_file_operand_guard_command("awk", appFilesMountPath, (args) => {
			const files: string[] = [];
			let hasProgram = false;
			for (let index = 0; index < args.length; index++) {
				const arg = args[index]!;
				if (arg.includes(appFilesMountPath)) {
					return { files: [], error: `awk: app file paths cannot be used as direct operands: ${arg.trim()}\nPipe the file through cat instead: cat '${arg.trim()}' | awk '<program>'` };
				}
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

function create_reader_guard_command(command: "head" | "tail" | "wc", appFilesMountPath: string) {
	return defineCommand(command, async (args, commandCtx) => {
		const files: string[] = [];
		for (let index = 0; index < args.length; index++) {
			const arg = args[index]!;
			if (command === "wc") {
				if (
					arg === "-l" ||
					arg === "-w" ||
					arg === "-c" ||
					arg === "-m" ||
					arg === "--lines" ||
					arg === "--words" ||
					arg === "--bytes" ||
					arg === "--chars"
				) {
					continue;
				}
			} else {
				if (arg === "-n" || arg === "--lines" || arg === "-c" || arg === "--bytes") {
					index++;
					continue;
				}
				if (arg.startsWith("--lines=") || arg.startsWith("--bytes=")) {
					continue;
				}
				if (arg.startsWith("-n") || arg.startsWith("-c")) {
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
			if (file !== "-" && has_glob_metacharacters(file) && is_under_app_mount(appFilesMountPath, resolve_command_path(commandCtx, file))) {
				return command_usage_error(app_glob_syntax_error(command, file));
			}
		}
		return await delegate_builtin_command(command, args, commandCtx);
	});
}

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
			const resolvedPath = resolve_command_path(commandCtx, file);
			if (is_under_app_mount(appFilesMountPath, resolvedPath)) {
				const appPath = shell_path_to_app_path(appFilesMountPath, resolvedPath) ?? file;
				return command_failure(
					`touch: cannot create or update app file '${file}' through bash.\n` +
					`Use write_file with path '${appPath}' to create a new file (strip the '${appFilesMountPath}' mount prefix from the bash path).\n` +
					`Use edit_file with path '${appPath}' to update an existing file.\n`,
				);
			}
		}
		return await delegate_builtin_command("touch", args, commandCtx);
	});
}

function create_rm_command(appFilesMountPath: string) {
	return defineCommand("rm", async (args, commandCtx) => {
		for (const arg of args) {
			if (arg.startsWith("-")) continue;
			const resolvedPath = resolve_command_path(commandCtx, arg);
			if (is_under_app_mount(appFilesMountPath, resolvedPath)) {
				return command_failure(
					`rm: cannot delete app file '${arg}' through bash.\n` +
					`App files cannot be deleted via shell commands. Ask the user to delete '${arg}' using the file browser UI.\n`,
				);
			}
		}
		return await delegate_builtin_command("rm", args, commandCtx);
	});
}

function parse_cp_mv_operands(args: string[]) {
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

function create_cp_command(appFilesMountPath: string) {
	return defineCommand("cp", async (args, commandCtx) => {
		const { operands, recursive } = parse_cp_mv_operands(args);
		const appOperands = operands.filter((operand) => is_under_app_mount(appFilesMountPath, resolve_command_path(commandCtx, operand)));
		if (appOperands.length === 0) {
			return await delegate_builtin_command("cp", args, commandCtx);
		}
		for (const operand of appOperands) {
			if (has_glob_metacharacters(operand)) {
				return command_usage_error(app_glob_syntax_error("cp", operand));
			}
		}
		// Writing INTO the app tree (any -> app destination) is read-only for cp; route
		// straight to write_file so the model does not retry cp.
		if (operands.length === 2 && is_under_app_mount(appFilesMountPath, resolve_command_path(commandCtx, operands[1]!))) {
			const destAppPath = shell_path_to_app_path(appFilesMountPath, resolve_command_path(commandCtx, operands[1]!)) ?? operands[1]!;
			return command_failure(
				`cp: cannot write to app file '${operands[1]}': the app file tree is read-only for cp.\n` +
				`To create a durable copy at '${destAppPath}', use write_file with path '${destAppPath}' and the content read from the source.\n` +
				`cp into the app tree is never supported; only cp <app-file> /tmp/<name> (scratch copy) is allowed.\n`,
			);
		}
		if (recursive || operands.length !== 2 || appOperands.length !== 1 || appOperands[0] !== operands[0]) {
			return command_failure(
				"cp: app files can only be copied as one exact readable file to a /tmp destination.\n" +
				"Usage: cp <app-file> /tmp/<name>  — copies the file content to /tmp scratch space (one invocation only).\n" +
				"To duplicate an app file as a new durable file, use write_file with the new app path (strip the mount prefix).\n",
			);
		}

		const sourceShellPath = resolve_command_path(commandCtx, operands[0]!);
		const destShellPath = resolve_command_path(commandCtx, operands[1]!);
		if (!is_under_tmp_mount(destShellPath)) {
			const destAppPath = shell_path_to_app_path(appFilesMountPath, destShellPath);
			const destHint = destAppPath != null
				? `To create a durable copy at '${destAppPath}', use write_file with path '${destAppPath}' and the content read from the source.`
				: "Durable app file writes require write_file, not cp.";
			return command_failure(
				`cp: cannot write to '${operands[1]}': app file tree is read-only for cp.\n` +
				`Only /tmp destinations are supported: cp ${shell_arg_quote(operands[0]!)} /tmp/<name>\n` +
				`${destHint}\n`,
			);
		}
		try {
			const sourceStat = await commandCtx.fs.stat(sourceShellPath);
			if (!sourceStat.isFile) {
				return command_failure("cp: recursive app directory copy is not supported\n");
			}
			const content = await commandCtx.fs.readFileBuffer(sourceShellPath);
			await commandCtx.fs.writeFile(destShellPath, content);
			return { stdout: "", stderr: "", exitCode: 0 };
		} catch (error) {
			if (error instanceof AppFileContentUnavailableError) {
				return command_failure(`cp: ${operands[0]}: unsupported app file content type '${error.contentType ?? "unknown"}'\n`);
			}
			return command_failure(`cp: cannot copy '${operands[0]}'\n`);
		}
	});
}

function create_mv_command(appFilesMountPath: string) {
	return defineCommand("mv", async (args, commandCtx) => {
		const { operands } = parse_cp_mv_operands(args);
		// Identify source and destination for better guidance
		const srcOperand = operands[0];
		const destOperand = operands[1];
		for (const operand of operands) {
			const resolvedPath = resolve_command_path(commandCtx, operand);
			if (is_under_app_mount(appFilesMountPath, resolvedPath)) {
				const srcAppPath = srcOperand != null
					? (shell_path_to_app_path(appFilesMountPath, resolve_command_path(commandCtx, srcOperand)) ?? srcOperand)
					: null;
				const destAppPath = destOperand != null
					? (shell_path_to_app_path(appFilesMountPath, resolve_command_path(commandCtx, destOperand)) ?? destOperand)
					: null;
				const renameHint = srcAppPath != null && destAppPath != null
					? `To rename/move an app file: (1) use write_file with path '${destAppPath}' and the content read from '${srcAppPath}', then (2) ask the user to delete '${srcAppPath}' via the file browser UI.`
					: "To rename/move an app file, use write_file to create the file at the new path, then ask the user to delete the original via the file browser UI.";
				return command_failure(
					`mv: cannot move or rename app files through bash.\n` +
					`${renameHint}\n`,
				);
			}
		}
		return await delegate_builtin_command("mv", args, commandCtx);
	});
}

function create_tee_command(appFilesMountPath: string) {
	return defineCommand("tee", async (args, commandCtx) => {
		const files = args.filter((arg) => !arg.startsWith("-"));
		for (const file of files) {
			const resolvedPath = resolve_command_path(commandCtx, file);
			if (is_under_app_mount(appFilesMountPath, resolvedPath)) {
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

function create_nested_shell_command(name: "bash" | "sh", appFilesMountPath: string) {
	return defineCommand(name, async (args, commandCtx) => {
		if (args.length === 0) {
			return { stdout: "", stderr: "", exitCode: 0 };
		}
		// Treat the common `bash -lc` agent habit as `bash -c`; login-shell setup is irrelevant in this curated shell.
		if (args[0] === "-c" || args[0] === "-lc" || args[0] === "-cl") {
			const script = args[1];
			if (script == null) {
				return command_failure(`${name}: -c: option requires an argument\n`);
			}
			if (!commandCtx.exec) {
				return command_failure(`${name}: nested execution is unavailable\n`);
			}
			return await commandCtx.exec(`set -f\n${script}`, {
				cwd: commandCtx.cwd,
				signal: commandCtx.signal,
				args: args.slice(2),
			});
		}
		if (args[0]?.startsWith("-")) {
			return command_usage_error(
				`${name}: unsupported option ${args[0]}\nOnly ${name} -c 'script' (inline script) is supported. Avoid set -euo pipefail, process substitution, and other shell-specific flags.\n`,
			);
		}
		const scriptPath = resolve_command_path(commandCtx, args[0]!);
		if (is_under_app_mount(appFilesMountPath, scriptPath)) {
			return command_failure(`${name}: app-mounted script files are not executable through bash\n`);
		}
		if (!commandCtx.exec) {
			return command_failure(`${name}: nested execution is unavailable\n`);
		}
		const script = await commandCtx.fs.readFile(scriptPath);
		return await commandCtx.exec(`set -f\n${script}`, {
			cwd: commandCtx.cwd,
			signal: commandCtx.signal,
			args: args.slice(1),
		});
	});
}

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
				maxArgs = Number(args[++index]);
				commandStart = index + 1;
				continue;
			}
			if (arg.startsWith("-n") && arg.length > 2 && /^-n\d+$/u.test(arg)) {
				maxArgs = Number(arg.slice(2));
				commandStart = index + 1;
				continue;
			}
			if (arg === "-P") {
				const value = Number(args[index + 1]);
				if (Number.isFinite(value) && value > 1) {
					return command_usage_error("xargs: parallel execution (-P > 1) is not supported in this app shell\n");
				}
				index++;
				commandStart = index + 1;
				continue;
			}
			if (arg.startsWith("-P") && arg.length > 2) {
				const value = Number(arg.slice(2));
				if (Number.isFinite(value) && value > 1) {
					return command_usage_error("xargs: parallel execution (-P > 1) is not supported in this app shell\n");
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
				return command_usage_error(
					`xargs: unsupported option ${arg}\nSupported: xargs [-n N] [-I REPLACE] [-d DELIM] [-0] [-t] [-r] [COMMAND [ARGS...]]\n`,
				);
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
			return command_failure("xargs: nested execution is unavailable\n");
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
				return command_usage_error(`which: unsupported option ${arg}\n`);
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

// #endregion app file shell commands

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
		if (has_glob_metacharacters(normalizedPath)) {
			throw new Error(`app file glob patterns are not supported: '${app_path_to_shell_path(this.appFilesMountPath, normalizedPath)}'`);
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
							path: node.path,
							kind: node.kind,
							updatedAt: node.updatedAt,
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
		throw readonly_error(app_path_to_shell_path(this.appFilesMountPath, path));
	}

	async appendFile(path: string, _content: FileContent, _options?: Parameters<IFileSystem["appendFile"]>[2]) {
		throw readonly_error(app_path_to_shell_path(this.appFilesMountPath, path));
	}

	async exists(path: string) {
		return (await this.getEntry(path)) != null;
	}

	async stat(path: string): Promise<FsStat> {
		const normalizedPath = normalize_path(path);
		if (has_glob_metacharacters(normalizedPath)) {
			throw new Error(`app file glob patterns are not supported: '${app_path_to_shell_path(this.appFilesMountPath, normalizedPath)}'`);
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
		if (has_glob_metacharacters(normalizedPath)) {
			throw new Error(`app file glob patterns are not supported: '${app_path_to_shell_path(this.appFilesMountPath, normalizedPath)}'`);
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
		throw readonly_error(app_path_to_shell_path(this.appFilesMountPath, path));
	}

	async cp(_src: string, dest: string, _options?: CpOptions) {
		throw readonly_error(app_path_to_shell_path(this.appFilesMountPath, dest));
	}

	async mv(_src: string, dest: string) {
		throw readonly_error(app_path_to_shell_path(this.appFilesMountPath, dest));
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
		throw readonly_error(app_path_to_shell_path(this.appFilesMountPath, path));
	}

	async symlink(_target: string, linkPath: string) {
		throw readonly_error(app_path_to_shell_path(this.appFilesMountPath, linkPath));
	}

	async link(_existingPath: string, newPath: string) {
		throw readonly_error(app_path_to_shell_path(this.appFilesMountPath, newPath));
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
		throw readonly_error(app_path_to_shell_path(this.appFilesMountPath, path));
	}

	private rememberEntry(entry: JustBashFileNodeCacheEntry) {
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

	private async getEntry(path: string) {
		const normalizedPath = normalize_path(path);
		const cached = this.entryCache.get(normalizedPath);
		if (cached) {
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
			path: node.path,
			kind: node.kind,
			updatedAt: node.updatedAt,
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
		throw readonly_error(path);
	}

	async appendFile(path: string, _content: FileContent, _options?: Parameters<IFileSystem["appendFile"]>[2]) {
		throw readonly_error(path);
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
		throw readonly_error(path);
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
		throw readonly_error(path);
	}

	async cp(_src: string, dest: string, _options?: CpOptions) {
		throw readonly_error(dest);
	}

	async mv(_src: string, dest: string) {
		throw readonly_error(dest);
	}

	resolvePath(base: string, path: string) {
		return resolve_path(base, path);
	}

	getAllPaths() {
		return ["/"];
	}

	async chmod(path: string, _mode: number) {
		throw readonly_error(path);
	}

	async symlink(_target: string, linkPath: string) {
		throw readonly_error(linkPath);
	}

	async link(_existingPath: string, newPath: string) {
		throw readonly_error(newPath);
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
		throw readonly_error(path);
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
			ls_command_create(ctx, workspaceFs.ctxData, appFilesMountPath),
			find_command_create(ctx, workspaceFs.ctxData, appFilesMountPath),
			create_tree_command(appFilesMountPath),
			create_grep_command(),
			create_cat_command(appFilesMountPath),
			create_reader_guard_command("head", appFilesMountPath),
			create_reader_guard_command("tail", appFilesMountPath),
			create_reader_guard_command("wc", appFilesMountPath),
			create_stat_command(ctx, workspaceFs.ctxData, appFilesMountPath),
			...create_stream_utility_commands(appFilesMountPath),
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
		}) {
			let cwd = args?.initialCwd ?? "~";
			let currentCommand = "";
			let paginatedPathQueryCount = 0;
			const workspaceItems: Array<{
				path: string;
				kind: "folder" | "file";
				updatedAt: number;
				depthTruncated: boolean;
				contentType?: string;
			}> = [...workspaceItemsInitial];
			const runQueryImpl = async (_ref: unknown, queryArgs: Record<string, unknown>) => {
				const itemName = (path: string) => path.split("/").filter(Boolean).at(-1) ?? "";
				const parentPath = (path: string) => {
					const segments = path.split("/").filter(Boolean);
					return segments.length <= 1 ? "/" : `/${segments.slice(0, -1).join("/")}`;
				};
				const pageItems = <T,>(items: T[], limitValue: unknown, cursorValue: unknown) => {
					const limit = typeof limitValue === "number" && Number.isFinite(limitValue) ? Math.max(1, Math.trunc(limitValue)) : 100;
					const cursor = typeof cursorValue === "string" && cursorValue.startsWith("cursor-") ? Number(cursorValue.slice(7)) : 0;
					const start = Number.isFinite(cursor) ? cursor : 0;
					const page = items.slice(start, start + limit);
					const nextStart = start + limit;
					return {
						page,
						continueCursor: nextStart < items.length ? `cursor-${nextStart}` : "",
						isDone: nextStart >= items.length,
					};
				};

				if ("query" in queryArgs) {
					return {
						items:
							queryArgs.query === "unique-token"
								? [
										{
											path: "/docs/readme.md",
											markdownChunk: "A chunk with unique-token inside.",
											chunkIndex: 0,
											startIndex: 0,
											endIndex: 33,
											lineStart: 1,
											lineEnd: 1,
											chunkFlags: 0,
											hasChunkAbove: false,
											hasChunkBelow: false,
										},
									]
								: [],
					};
				}

				if ("numItems" in queryArgs && "path" in queryArgs) {
					const path = typeof queryArgs.path === "string" ? queryArgs.path : "/";
					const commandBeforeCursor = currentCommand.split("--cursor")[0] ?? currentCommand;
					const lsOccurrences = commandBeforeCursor.match(/\bls\s/gu)?.length ?? 0;
					const isDirectChildrenQuery = paginatedPathQueryCount < lsOccurrences;
					paginatedPathQueryCount++;
					if (!isDirectChildrenQuery) {
						const target = workspaceItems.find((item) => item.path === path);
						const items =
							target?.kind === "file"
								? [target]
								: workspaceItems.filter((item) => {
										if (path === "/") return true;
										return item.path.startsWith(`${path}/`);
									});
						const paged = pageItems(
							items.sort((a, b) => a.path.localeCompare(b.path)),
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
					const paged = pageItems(
						workspaceItems
							.filter((item) => parentPath(item.path) === path)
							.sort((a, b) => itemName(a.path).localeCompare(itemName(b.path))),
						queryArgs.numItems,
						queryArgs.cursor,
					);
					return {
						items: paged.page.map((item) => ({
							name: itemName(item.path),
							path: item.path,
							kind: item.kind,
							updatedAt: item.updatedAt,
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

				const path = queryArgs.path;
				if (path === "/") {
					return {
						path: "/",
						name: "",
						kind: "folder",
						updatedAt: 0,
					};
				}
				return typeof path === "string" ? (workspaceItems.find((item) => item.path === path) ?? null) : null;
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
							depthTruncated: false,
						});
						return { _yay: { nodeId: "folder_created", exists: false } };
					}
					return null;
				},
				runActionImpl: async (_ref, actionArgs) => {
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
					return null;
				},
			});

			return {
				run: async (command: string) => {
					currentCommand = command;
					paginatedPathQueryCount = 0;
					try {
						const result = await action_run(ctx, {
							...test_ctx_data,
							command,
							allowAppFileTreeMkdir: args?.allowAppFileTreeMkdir ?? true,
							persistedCwd: cwd,
						});
						cwd = result.nextPersistedCwd;
						return result;
					} finally {
						currentCommand = "";
					}
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
				return actionArgs && typeof actionArgs === "object" && "path" in actionArgs && actionArgs.path === "/docs/readme.md";
			});

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout.split("# Readme").length - 1).toBe(2);
			expect(readCalls).toHaveLength(1);
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
						path: "/docs",
						numItems: 1,
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

		test("guides invented ls pagination flags back to the printed cursor command", async () => {
			const { run } = createBashRunner();

			const result = await run(`ls --limit 1 --next-page ${test_app_files_mount}/docs`);

			expect(result.metadata.exitCode).toBe(2);
			expect(result.stderr).toContain("--next-page is not supported");
			expect(result.stderr).toContain("Copy the exact");
			expect(result.stderr).toContain("Next page: ls --limit N --cursor");
		});

		test("supports paginated find with maxdepth, type, and name filters", async () => {
			const { run, runQuery } = createBashRunner();

			const result = await run(`find ${test_app_files_mount}/docs -maxdepth 1 -type f -name '*.md' --limit 10`);

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
					}),
				]),
			);
		});

		test("supports extension discovery as app-native find sugar", async () => {
			const { run } = createBashRunner();

			const result = await run(`find ${test_app_files_mount}/docs -maxdepth 1 --extension md --limit 10`);
			const dottedResult = await run(`find ${test_app_files_mount}/docs -maxdepth 1 --extension .md --limit 10`);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toContain(`${test_app_files_mount}/docs/readme.md`);
			expect(result.stdout).toContain(`${test_app_files_mount}/docs/tutorial.md`);
			expect(result.stdout).not.toContain(`${test_app_files_mount}/docs/nested/deep.md`);
			expect(dottedResult.metadata.exitCode).toBe(0);
			expect(dottedResult.stdout).toBe(result.stdout);
		});

		test("marks empty filtered find pages as partial when more pages exist", async () => {
			const { run } = createBashRunner();

			const result = await run(`find ${test_app_files_mount}/docs -maxdepth 1 -type d -name missing --limit 1`);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toContain("No matches in this page; more pages exist.");
			expect(result.stdout).toContain("Next page:");
		});

		test("rejects unsupported find predicates when pagination is requested", async () => {
			const { run, runQuery } = createBashRunner();

			const result = await run(`find ${test_app_files_mount}/docs -delete --limit 10`);

			expect(result.metadata.exitCode).toBe(2);
			expect(result.stderr).toContain("unsupported predicate -delete");
			expect(result.stderr).toContain("use -name PATTERN");
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
			expect(result.stderr).toContain("find -name PATTERN");
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
					limit: 5,
				}),
			);
		});

		test("rejects app path operands in indexed search instead of folding them into the query", async () => {
			const { run, runQuery } = createBashRunner();

			const result = await run(`search --limit 5 unique-token ${test_app_files_mount}`);

			expect(result.metadata.exitCode).toBe(2);
			expect(result.stderr).toContain("path operands are not supported");
			expect(result.stderr).toContain("Remove the path and run: search --limit N");
			expect(runQuery).not.toHaveBeenCalled();
		});

		test("does not scan markdown files when indexed search misses", async () => {
			const { run, runAction } = createBashRunner();

			const result = await run("search --limit 5 Readme");

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toBe("No files found\n");
			expect(runAction).not.toHaveBeenCalled();
		});

		test("keeps grep as a compatibility hint that points to indexed search", async () => {
			const { run } = createBashRunner();

			const result = await run(`grep -R unique-token ${test_app_files_mount}`);

			expect(result.metadata.exitCode).toBe(2);
			expect(result.stderr).toBe("");
			expect(result.stdout).toContain("grep over app files is not supported");
			expect(result.stdout).toContain("search --limit 20 unique-token");
			expect(result.stdout).toContain("Convex text index");
		});

		test("uses native prefix find and rejects app tree rendering", async () => {
			const { run } = createBashRunner();

			const prefixResult = await run("find --prefix /docs --limit 20 -type f -iname '*.MD'");
			const treeResult = await run(`tree ${test_app_files_mount}/docs`);

			expect(prefixResult.metadata.exitCode).toBe(0);
			expect(prefixResult.stdout).toContain(`${test_app_files_mount}/docs/readme.md`);
			expect(prefixResult.stdout).toContain(`${test_app_files_mount}/docs/tutorial.md`);
			expect(treeResult.metadata.exitCode).toBe(2);
			expect(treeResult.stderr).toContain("tree is not available for app files");
			expect(treeResult.stderr).toContain("Use find instead");
			expect(treeResult.stderr).toContain("--limit 100");
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
			const unreadable = await run(`head ${test_app_files_mount}/source.pdf`);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toContain("# Readme");
			expect(result.stdout).toContain("unique-token");
			expect(result.stdout).toContain(`${test_app_files_mount}/docs/readme.md`);
			expect(result.stdout).toContain("regular file");
			expect(unreadable.metadata.exitCode).not.toBe(0);
			expect(unreadable.stdout).not.toContain("Markdown and plain text files only");
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

		test("rejects app writes and prevents mixed /tmp partial side effects", async () => {
			const { run } = createBashRunner();

			const touchResult = await run(`touch ${test_app_files_mount}/docs/readme.md`);
			const rmResult = await run(`rm -f ${test_app_files_mount}/docs/readme.md`);
			const mvResult = await run(`mv ${test_app_files_mount}/docs/readme.md /tmp/moved.md; cat /tmp/moved.md`);
			const teeResult = await run(`printf hi | tee /tmp/out.txt ${test_app_files_mount}/docs/readme.md; cat /tmp/out.txt`);

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

		test("parses options after the search query", async () => {
			const { run, runQuery } = createBashRunner();

			await run("search unique-token --limit 5");

			expect(runQuery).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					query: "unique-token",
					limit: 5,
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
