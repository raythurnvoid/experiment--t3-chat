"use node";

// This module is not a full POSIX shell.
// It gives the AI a bash-shaped interface over Convex-backed app files.
// Convex file discovery has to stay index-friendly, so Native Just Bash glob expansion,
// recursive grep, and arbitrary regex scans are not the default way to query app file node paths.
// Prefer custom app-aware commands and flags that map directly to indexed queries,
// such as `find --extension`, `find --path-query`, `search --path`, and exact file reads.
// When the model still writes common glob or regex-shaped commands, recover only the
// simple cases that can be translated safely into the same indexed operations.
// Do not add broad JavaScript filtering after pagination to imitate shell behavior.
//
// Path vocabulary:
// - Bash path: an absolute path in the Just Bash filesystem. It may point at
//   app files, `/tmp`, or synthetic base directories.
// - `HOME`: the bash home/user path, `/home/cloud-usr`.
// - `APP_MOUNT_PATH`: the parent mount path for app workspaces,
//   `/home/cloud-usr/w`.
// - `currentProjectPath`: the mounted project file tree path,
//   `/home/cloud-usr/w/<workspaceName>/<projectName>`.
// - App file node path: the Convex `files_nodes.path` inside the current
//   project tree. It is project-relative, but still starts with `/`; examples
//   are `/docs/readme.md` and `/` for the project root.
// - Persisted cwd path: the thread-state representation. `~` (the creation
//   default) means "start in currentProjectPath"; anything else is an absolute
//   Bash path under `HOME` or `/tmp`.
//
// Command operands start raw. Command handlers resolve them against `cwd` into a
// normalized Bash path, then strip the current project path before querying
// Convex. `WorkspaceFs` receives already-stripped app file paths from
// `MountableFs`.

import { v, type Infer } from "convex/values";
import { getFunctionName } from "convex/server";
import {
	Bash,
	defineCommand,
	getCommandNames,
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
import { internal } from "./_generated/api.js";
import { internalAction, type ActionCtx, type MutationCtx } from "./_generated/server.js";
import type { Doc, Id } from "./_generated/dataModel";
import type { ai_chat_get_thread_state_Result } from "./ai_chat.ts";
import type {
	ai_chat_files_load_thread_tmp_files_Result,
	ai_chat_files_patch_thread_tmp_files_Args,
} from "./ai_chat_files.ts";
import type {
	files_nodes_create_folder_node_by_path_Result,
	files_nodes_get_bash_served_byte_size_Result,
	files_nodes_get_bash_stat_entry_Result,
	files_nodes_get_by_path_Result,
	files_nodes_get_file_last_available_markdown_content_by_path_Result,
	files_nodes_grep_app_file_Result,
	files_nodes_grep_app_file_scan_Result,
	files_nodes_list_dir_children_by_parent_paginated_Result,
	files_nodes_list_dir_children_by_parent_recency_paginated_Result,
	files_nodes_list_folder_subtree_paginated_Result,
	files_nodes_list_recent_paginated_Result,
	files_nodes_read_file_full_content_from_chunks_Result,
	files_nodes_read_file_content_stats_Result,
	files_nodes_read_file_line_range_Result,
	files_nodes_read_file_tail_lines_Result,
	files_nodes_search_paths_paginated_Result,
	files_nodes_text_search_files_Result,
} from "./files_nodes.ts";
import { Result } from "../shared/errors-as-values-utils.ts";
import { files_ROOT_ID, files_SYNTHETIC_ROOT_FOLDER } from "../shared/files.ts";
import { LruCache, math_clamp, path_name_of, should_never_happen } from "../shared/shared-utils.ts";
import { files_chunk_BITMASK_FLAGS, files_chunk_has_bitmask_flag } from "../server/files-markdown-chunking-mastra.ts";

const HOME = "/home/cloud-usr";
const APP_MOUNT_PATH = `${HOME}/w`;
const TMP_MOUNT = "/tmp";
const DEFAULT_CWD = "~";
const OUTPUT_LIMIT = 30_000;
const LISTING_PAGE_LIMIT_MAX = 200;
const COMMAND_EXIT_FAILURE = 1;
const COMMAND_EXIT_USAGE = 2;
const textEncoder = new TextEncoder();

const TERMINAL_LINE_ENDING_REGEX = /\r\n?/g;
const TERMINAL_TRAILING_NEWLINE_REGEX = /\n+$/;
const SIMPLE_EXTENSION_GLOB_REGEX = /^\*\.([a-z0-9][a-z0-9_-]*)$/iu;
const GLOB_METACHARACTER_REGEX = /[*?[\]]/u;
const SHELL_ARG_SAFE_UNQUOTED_REGEX = /^[A-Za-z0-9_/:.,=+@-]+$/;
const COMMAND_NOT_FOUND_REGEX = /: command not found$/m;
const REDIRECTS_STDERR_TO_STDOUT_REGEX = /(^|[\s;&|])2\s*>\s*&\s*1(?=$|[\s;&|])/;
const SET_INVALID_OPTION_REGEX = /bash: set: -o: invalid option/m;
const PAGINATION_CURSORS_CACHE_MAX_ENTRIES = 500;
// Deliberately tiny caps so /tmp eviction is exercised while testing the app.
const BASH_TMP_SESSION_MAX_PATHS = 10;
const BASH_TMP_SESSION_MAX_BYTES = 4_000;
const BASH_TMP_SESSION_MAX_FILE_BYTES = 2_000;
/**
 * In-memory LRU cache for stored pagination cursors. `value_store` remains the
 * durable fallback when this per-runtime cache is empty.
 */
const pagination_cursors_cache = new LruCache<string, string>(PAGINATION_CURSORS_CACHE_MAX_ENTRIES);

type BashTmpFileNode = ai_chat_files_patch_thread_tmp_files_Args["fileNodes"][number];

type BashTmpFileNodesContentDict = ai_chat_files_patch_thread_tmp_files_Args["fileNodesContentDict"];

/**
 * Whitelist of commands allowed to operate on paths under `APP_MOUNT_PATH`, the
 * app files mount folder.
 *
 * These commands have app-aware handlers backed by indexed Convex
 * `files_nodes` queries. Every other allowed Native Just Bash command is wrapped as a
 * /tmp-only command (see `NATIVE_JUST_BASH_TMP_COMMANDS`) that rejects app file
 * paths with a hint instead of touching the mounted project tree.
 */
const APP_FILE_COMMANDS = [
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

const DISABLED_NATIVE_JUST_BASH_COMMANDS = new Set<string>(["file"]);
const APP_FILE_COMMAND_NAMES = new Set<string>(APP_FILE_COMMANDS);
const ALLOWED_COMMANDS = getCommandNames().filter(
	(command): command is CommandName => !DISABLED_NATIVE_JUST_BASH_COMMANDS.has(command),
);
const ALLOWED_COMMAND_NAMES = new Set<string>(ALLOWED_COMMANDS);
const NATIVE_JUST_BASH_TMP_COMMANDS = ALLOWED_COMMANDS.filter((command) => !APP_FILE_COMMAND_NAMES.has(command));

/**
 * Keep the Just Bash path cache to the file-node fields the virtual filesystem needs.
 *
 * Some entries come from Convex `files_nodes` rows, others are synthetic parent
 * folders created while caching descendants.
 */
type JustBashFileNodeCacheEntry = {
	_id?: Id<"files_nodes"> | typeof files_ROOT_ID;
	path: Doc<"files_nodes">["path"];
	name: Doc<"files_nodes">["name"];
	kind: Doc<"files_nodes">["kind"];
	updatedAt: Doc<"files_nodes">["updatedAt"];
	updatedBy?: Doc<"files_nodes">["updatedBy"] | "";
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
	currentProjectPath: string;
	allowAppFileTreeMkdir: boolean;
};

function clamp_listing_page_limit(limit: number) {
	const finiteLimit = Number.isFinite(limit) ? Math.trunc(limit) : LISTING_PAGE_LIMIT_MAX;
	return math_clamp(finiteLimit, 1, LISTING_PAGE_LIMIT_MAX);
}

/**
 * Return one clean absolute path for bash, app files, and cache keys.
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
 * Convert a Convex app file node path to its Bash path inside currentProjectPath.
 */
function app_file_node_path_to_current_project_path(currentProjectPath: string, path: string) {
	const normalizedPath = normalize_path(path);
	return normalizedPath === "/" ? currentProjectPath : `${currentProjectPath}${normalizedPath}`;
}

/**
 * Convert a normalized Bash path under currentProjectPath back to a Convex app file node path.
 *
 * Returns `null` for Bash paths outside currentProjectPath, like `/tmp/foo`.
 */
function current_project_path_to_app_file_node_path(currentProjectPath: string, path: string) {
	if (path === currentProjectPath) {
		return "/";
	}
	if (path.startsWith(`${currentProjectPath}/`)) {
		return path.slice(currentProjectPath.length);
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
 * Persist a raw pagination cursor and return the stored cursor id printed
 * in command output.
 *
 * Raw Convex cursors are extremely long and hard for the AI to copy back into
 * shell commands reliably, so bash output exposes only this value_store id.
 */
async function cursor_id_create(ctx: ActionCtx, cursor: string) {
	// Persist first so the cursor id survives runtime cache eviction or restart.
	const id = (await ctx.runMutation(internal.value_store.put, {
		value: cursor,
	})) as Id<"value_store">;
	// Warm the local LRU for the common case where the next command lands here.
	pagination_cursors_cache.set(id, cursor);
	return id;
}

/**
 * Resolve a command cursor id back to the raw Convex pagination cursor that
 * list queries expect.
 */
async function cursor_id_resolve(ctx: ActionCtx, cursor: string) {
	const id = cursor.trim();
	if (!id) {
		return Result({
			_nay: {
				message: "bash: cursor is invalid; rerun the original command to get a fresh Next page cursor.",
			},
		});
	}

	const cached = pagination_cursors_cache.get(id);
	if (cached != null) {
		return Result({ _yay: cached });
	}

	// Fall back to durable storage because Convex action runtimes may not share memory.
	const stored = (await ctx.runQuery(internal.value_store.get, { id })) as { value: string; createdAt: number } | null;
	if (!stored) {
		return Result({
			_nay: {
				message:
					`bash: cursor ${cursor} expired, is unavailable, or was copied incorrectly.\n` +
					"Copy the exact --cursor value from the latest Next page command and retry. " +
					"If that still fails, rerun the original command to get a fresh Next page cursor.",
			},
		});
	}

	// Refill the local LRU after durable lookup for subsequent page requests.
	pagination_cursors_cache.set(id, stored.value);
	return Result({ _yay: stored.value });
}

/**
 * Changed and deleted paths since the baseline, for `patch_thread_tmp_files`.
 **/
async function tmp_fs_delta_payload(tmpFs: BashTmpFs) {
	const finalPaths = tmpFs.fs.getAllPaths().filter((path) => path !== "/");
	const finalPathSet = new Set(finalPaths);
	const deletePaths = [...tmpFs.baselinePaths].filter((path) => !finalPathSet.has(path)).sort();
	const fileNodesContentDict: BashTmpFileNodesContentDict = {};
	const fileNodePromises: Promise<BashTmpFileNode>[] = [];

	for (const path of finalPaths) {
		let shouldUpsert = !tmpFs.baselinePaths.has(path);
		if (!shouldUpsert) {
			for (const root of tmpFs.dirtyRoots) {
				if (path === root || path.startsWith(`${root}/`)) {
					shouldUpsert = true;
					break;
				}
			}
		}
		if (!shouldUpsert) {
			continue;
		}

		fileNodePromises.push(
			(async (/** iife */) => {
				const stat = await tmpFs.fs.lstat(path);
				const mtime = stat.mtime.getTime();
				if (stat.isDirectory) {
					return {
						path,
						kind: "directory" as const,
						mode: stat.mode,
						size: 0,
						mtime,
					};
				}
				if (stat.isSymbolicLink) {
					const symlinkTargetPath = await tmpFs.fs.readlink(path);
					return {
						path,
						kind: "symlink" as const,
						mode: stat.mode,
						size: stat.size,
						mtime,
						symlinkTargetPath,
					};
				}

				const bytes = await tmpFs.fs.readFileBuffer(path);
				fileNodesContentDict[path] = new Uint8Array(bytes).buffer;
				return {
					path,
					kind: "file" as const,
					mode: stat.mode,
					size: bytes.byteLength,
					mtime,
				};
			})(),
		);
	}

	const fileNodes = await Promise.all(fileNodePromises);
	return {
		fileNodes,
		fileNodesContentDict,
		deletePaths,
	};
}

/**
 * Trim the persisted `/tmp` scratch filesystem to the session limits.
 *
 * Oversized files are discarded first, then the oldest remaining leaf paths are
 * evicted until the total path and byte limits fit. Returns stderr text that
 * should be surfaced to the user when any persisted scratch data was dropped.
 */
async function tmp_fs_evict_to_limits(tmpFs: BashTmpFs) {
	/**
	 * Metadata for paths that still exist in the persisted `/tmp` filesystem
	 * and still count against eviction limits.
	 */
	const fsNodeMetadataByPath = new Map<
		string,
		{ isDirectory: boolean; size: number; mtime: number; childCount: number }
	>();
	const childCountsByPath = new Map<string, number>();
	const oversizedPaths: string[] = [];
	const evictionCandidatesByPath = new Map<string, { path: string; mtime: number }>();
	let totalBytes = 0;
	// Snapshot each /tmp path and accumulate the aggregate eviction metadata in the same pass.
	for (const path of tmpFs.fs.getAllPaths()) {
		if (path === "/") {
			continue;
		}

		const stat = await tmpFs.fs.lstat(path).catch(() => null);
		const isDirectory = stat?.isDirectory ?? false;
		const size = stat && (stat.isFile || stat.isSymbolicLink) ? stat.size : 0;
		const mtime = stat?.mtime.getTime() ?? 0;
		const childCount = childCountsByPath.get(path) ?? 0;

		fsNodeMetadataByPath.set(path, {
			isDirectory,
			// Broken /tmp symlinks still count as paths, but have no readable size.
			size,
			mtime,
			// A child can appear before its parent, so reuse any count recorded earlier.
			childCount,
		});

		totalBytes += size;

		const isOversized = !isDirectory && size > BASH_TMP_SESSION_MAX_FILE_BYTES;
		// Oversized files are removed before aggregate eviction, so keep them out of the candidate queue.
		if (isOversized) {
			oversizedPaths.push(path);
		}
		// Files, symlinks, and currently-empty directories can be evicted without deleting children.
		else if (!isDirectory || childCount === 0) {
			evictionCandidatesByPath.set(path, { path, mtime });
		}

		const parentPath = path.slice(0, path.lastIndexOf("/"));
		const parent = fsNodeMetadataByPath.get(parentPath);

		// Parent was already seen, so update its count directly.
		if (parent) {
			parent.childCount += 1;
			evictionCandidatesByPath.delete(parentPath);
		}
		// Parent has not been seen yet; carry the count until its entry is created.
		else if (parentPath !== "") {
			childCountsByPath.set(parentPath, (childCountsByPath.get(parentPath) ?? 0) + 1);
		}
	}

	const evict = async (path: string) => {
		const metadata = fsNodeMetadataByPath.get(path);
		if (metadata == null) {
			// Unreachable: evict is only called with keys iterated from the remaining /tmp path map itself.
			throw should_never_happen("tmp eviction: path missing from remaining /tmp path map", { path });
		}
		totalBytes -= metadata.size;
		fsNodeMetadataByPath.delete(path);
		let emptiedParentPath: string | null = null;
		const parentPath = path.slice(0, path.lastIndexOf("/"));
		const parent = fsNodeMetadataByPath.get(parentPath);
		if (parent) {
			parent.childCount -= 1;
			if (parent.childCount === 0) {
				emptiedParentPath = parentPath;
			}
		}
		await tmpFs.rm(path, { recursive: true });
		return emptiedParentPath;
	};

	// Remove files that exceed the per-file limit before applying aggregate limits.
	for (const path of oversizedPaths) {
		const emptiedParentPath = await evict(path);

		// Oversized file eviction can make its parent directory eligible for aggregate eviction.
		if (emptiedParentPath !== null) {
			const metadata = fsNodeMetadataByPath.get(emptiedParentPath);
			if (metadata == null) {
				// Unreachable: evict returns a parent path only after reading it from the metadata map.
				throw should_never_happen("tmp eviction: parent path missing after oversized eviction", {
					path: emptiedParentPath,
				});
			}
			evictionCandidatesByPath.set(emptiedParentPath, { path: emptiedParentPath, mtime: metadata.mtime });
		}
	}

	const evictedPaths: string[] = [];
	const compare_eviction_candidates = (left: { path: string; mtime: number }, right: { path: string; mtime: number }) =>
		left.mtime - right.mtime || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0);

	const evictionCandidates = [...evictionCandidatesByPath.values()].sort(compare_eviction_candidates);
	let nextEvictionCandidateIndex = 0;

	// Keep evicting the oldest removable leaf path until both aggregate limits fit.
	while (fsNodeMetadataByPath.size > BASH_TMP_SESSION_MAX_PATHS || totalBytes > BASH_TMP_SESSION_MAX_BYTES) {
		const oldest = evictionCandidates[nextEvictionCandidateIndex];
		if (oldest == null) {
			break;
		}
		nextEvictionCandidateIndex += 1;
		evictedPaths.push(oldest.path);
		const emptiedParentPath = await evict(oldest.path);

		// Parent directories become removable candidates only after their last child is gone.
		if (emptiedParentPath !== null) {
			const metadata = fsNodeMetadataByPath.get(emptiedParentPath);
			if (metadata == null) {
				// Unreachable: evict returns a parent path only after reading it from the metadata map.
				throw should_never_happen("tmp eviction: parent path missing from metadata map", {
					path: emptiedParentPath,
				});
			}
			const candidate = { path: emptiedParentPath, mtime: metadata.mtime };
			let low = nextEvictionCandidateIndex;
			let high = evictionCandidates.length;
			// Keep newly-empty parent directories ordered with the remaining eviction candidates.
			while (low < high) {
				const mid = Math.floor((low + high) / 2);
				if (compare_eviction_candidates(evictionCandidates[mid], candidate) <= 0) {
					low = mid + 1;
				} else {
					high = mid;
				}
			}
			evictionCandidates.splice(low, 0, candidate);
		}
	}

	// Eviction paths are internal to the /tmp mount; prefix them for display.
	const list_tmp_paths = (paths: string[]) =>
		paths
			.slice(0, 20)
			.map((path) => `${TMP_MOUNT}${path}`)
			.join(", ") + (paths.length > 20 ? ` (and ${paths.length - 20} more)` : "");

	let stderr = "";
	if (oversizedPaths.length > 0) {
		stderr += `/tmp scratch files larger than ${BASH_TMP_SESSION_MAX_FILE_BYTES} bytes are not persisted between calls; discarded ${oversizedPaths.length} oversized file(s): ${list_tmp_paths(oversizedPaths)}\n`;
	}
	if (evictedPaths.length > 0) {
		stderr += `/tmp scratch is limited to ${BASH_TMP_SESSION_MAX_PATHS} paths and ${BASH_TMP_SESSION_MAX_BYTES} total bytes between calls; evicted the ${evictedPaths.length} oldest path(s) to fit: ${list_tmp_paths(evictedPaths)}\n`;
	}

	return stderr;
}

/**
 * Climb from `path` to the nearest existing directory, or `null` when even `/` is gone.
 **/
async function nearest_existing_dir(fs: MountableFs, path: string) {
	let candidate = normalize_path(path);
	while (true) {
		try {
			if ((await fs.stat(candidate)).isDirectory) {
				return candidate;
			}
		} catch {
			// fall through to the parent
		}
		if (candidate === "/") {
			return null;
		}
		candidate = normalize_path(`${candidate}/..`);
	}
}

/**
 * Read the simple glob form that can become an indexed extension search.
 *
 * Accepts `*.md` and `/some/path/*.md`.
 *
 * Returns `null` for anything more complex.
 */
function parse_simple_extension_glob(pattern: string) {
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
 * These commands read, list, or inspect the current project tree under
 * `~/w/<workspace>/<project>`; they do not expand globs over that tree. For the common discovery
 * mistake `*.ext`, point the model at `find --extension`, which uses the indexed
 * file path query. `find` itself handles simple extension globs separately and
 * can run that indexed search directly.
 */
function create_glob_syntax_unsupported_message(command: string, path: string) {
	const simpleExtensionGlob = parse_simple_extension_glob(path);
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
 * Check whether a normalized path is inside currentProjectPath.
 */
function is_path_under_current_project_path(currentProjectPath: string, path: string) {
	return path === currentProjectPath || path.startsWith(`${currentProjectPath}/`);
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

/**
 * Read the argv value that follows an option like `--limit 10`.
 *
 * Callers own incrementing their loop index after a successful read.
 */
function command_read_option_value(command: string, args: string[], index: number, option: string) {
	const value = args[index + 1];
	if (value == null) {
		return Result({ _nay: { message: `${command}: ${option} requires a value` } });
	}
	return Result({ _yay: { value } });
}

/**
 * Parse a positive pagination limit, applying the command default and max clamp.
 */
function command_parse_limit(command: string, value: string | undefined, defaultLimit: number, maxLimit: number) {
	const rawValue = value ?? String(defaultLimit);
	if (!/^-?\d+$/u.test(rawValue.trim())) {
		return Result({ _nay: { message: `${command}: --limit must be an integer` } });
	}
	return Result({ _yay: Math.max(1, Math.min(maxLimit, Number(rawValue))) });
}

// #region builtin command delegation

/**
 * Builds argv for delegating part of an app-aware command to the original built-in.
 *
 * App-file pagination options and original operands are removed. The caller
 * passes only the built-in operands that should remain, usually the original
 * operand text so delegated output keeps normal shell path formatting.
 */
function command_build_builtin_delegation_args(
	args: string[],
	builtinOperands: string[],
	options: {
		optionsWithValues: ReadonlySet<string>;
		pathsPosition: "beforeOptions" | "afterOptions";
	},
) {
	const builtinArgs: string[] = [];
	const shortOptionsWithValues = [...options.optionsWithValues].filter(
		(option) => option.startsWith("-") && !option.startsWith("--"),
	);
	let optionsEnded = false;

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (optionsEnded) {
			continue;
		}
		if (arg === "--") {
			optionsEnded = true;
			builtinArgs.push(arg);
			continue;
		}
		if (arg === "--limit" || arg === "--cursor") {
			index++;
			continue;
		}
		if (arg.startsWith("--limit=") || arg.startsWith("--cursor=")) {
			continue;
		}

		const equalsIndex = arg.indexOf("=");
		const optionName = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
		if (options.optionsWithValues.has(optionName)) {
			builtinArgs.push(arg);
			if (equalsIndex === -1 && index + 1 < args.length) {
				builtinArgs.push(args[index + 1]);
				index++;
			}
			continue;
		}

		if (
			arg.startsWith("-") &&
			!arg.startsWith("--") &&
			shortOptionsWithValues.some((option) => arg.startsWith(option) && arg.length > option.length)
		) {
			builtinArgs.push(arg);
			continue;
		}

		if (arg.startsWith("-") && arg !== "-") {
			builtinArgs.push(arg);
		}
	}

	if (options.pathsPosition === "beforeOptions") {
		return [...builtinOperands, ...builtinArgs];
	}
	return [...builtinArgs, ...builtinOperands];
}

/**
 * Run one Just Bash built-in command through an isolated Bash instance.
 *
 * Custom app-aware commands in this module intentionally shadow several
 * built-ins. Calling `ctx.exec(...)` from those overrides would resolve back to
 * the override and recurse, so this helper creates a clean nested shell whose
 * command registry contains only the requested built-in command.
 *
 * Examples: app-aware `ls`, `find`, `tree`, `cat`, `stat`, `touch`, `rm`,
 * `cp`, `mv`, and `tee` call this after their app-path checks pass.
 */
async function delegate_builtin_command(args: {
	command: CommandName;
	args: string[];
	commandCtx: CommandContext;
	cwd?: string;
}) {
	// Custom commands shadow built-ins, so delegate through a clean nested Bash
	// instance instead of ctx.exec, which would recurse into this override.
	const env = Object.fromEntries(args.commandCtx.env);
	const cwd = args.cwd ?? args.commandCtx.cwd;
	const inner = new Bash({
		fs: args.commandCtx.fs,
		cwd,
		env,
		commands: [args.command],
		executionLimits: args.commandCtx.limits,
	});
	return await inner.exec([args.command, ...args.args.map(shell_arg_quote)].join(" "), {
		cwd,
		stdin: args.commandCtx.stdin as unknown as string,
		stdinKind: "bytes",
		env: {
			...env,
			PWD: cwd,
		},
	});
}

// #endregion builtin command delegation

// #region native just bash tmp command
/**
 * Returns whether a path is in the direct-access surface for Native Just Bash
 * commands: `/`, `/dev`, `/dev/null`, `/tmp`, or a descendant of `/tmp`.
 *
 * Synthetic command lookup paths are handled separately.
 */
function is_native_just_bash_tmp_path(path: string) {
	const normalizedPath = normalize_path(path);
	return (
		normalizedPath === "/" ||
		normalizedPath === "/dev" ||
		normalizedPath === "/dev/null" ||
		normalizedPath === TMP_MOUNT ||
		normalizedPath.startsWith(`${TMP_MOUNT}/`)
	);
}

/**
 * Returns whether a path is one of the synthetic command lookup directories
 * exposed to Native Just Bash: `/bin`, `/usr`, or `/usr/bin`.
 */
function is_native_just_bash_command_lookup_directory(path: string) {
	const normalizedPath = normalize_path(path);
	return normalizedPath === "/bin" || normalizedPath === "/usr" || normalizedPath === "/usr/bin";
}

/**
 * Returns the allowed command name for synthetic executable paths such as
 * `/bin/sort` or `/usr/bin/sort`; returns `null` for non-command paths or
 * disabled Just Bash commands.
 */
function native_just_bash_command_lookup_name(path: string) {
	const normalizedPath = normalize_path(path);
	const match = /^\/(?:usr\/)?bin\/([^/]+)$/u.exec(normalizedPath);
	if (!match) {
		return null;
	}
	return ALLOWED_COMMAND_NAMES.has(match[1]) ? match[1] : null;
}

function native_just_bash_tmp_command_path_app_operand(
	args: string[],
	ctx: CommandContext,
	currentProjectPath: string,
) {
	for (const arg of args) {
		if (arg.startsWith("-")) {
			continue;
		}
		const resolvedPath = resolve_path(ctx.cwd, arg);
		const isPathLike =
			arg === "." ||
			arg === ".." ||
			arg.startsWith("/") ||
			arg.startsWith("./") ||
			arg.startsWith("../") ||
			arg.includes("/");
		if (isPathLike && is_path_under_current_project_path(currentProjectPath, resolvedPath)) {
			return resolvedPath;
		}
	}
	return null;
}

function native_just_bash_tmp_command_rg_app_operand(args: string[], ctx: CommandContext, currentProjectPath: string) {
	let pattern: string | null = null;
	for (const arg of args) {
		if (arg.startsWith("-")) {
			continue;
		}
		if (pattern == null) {
			pattern = arg;
			continue;
		}
		const resolvedPath = resolve_path(ctx.cwd, arg);
		const isPathLike =
			arg === "." ||
			arg === ".." ||
			arg.startsWith("/") ||
			arg.startsWith("./") ||
			arg.startsWith("../") ||
			arg.includes("/");
		if (isPathLike && is_path_under_current_project_path(currentProjectPath, resolvedPath)) {
			return { pattern, path: resolvedPath };
		}
	}
	return null;
}

function native_just_bash_tmp_command_app_hint_path(
	args: string[],
	ctx: CommandContext,
	currentProjectPath: string,
	stderr: string,
) {
	let hasExplicitScratchOperand = false;
	for (const arg of args) {
		if (arg.startsWith("-")) {
			continue;
		}
		const resolvedPath = resolve_path(ctx.cwd, arg);
		if (is_native_just_bash_tmp_path(resolvedPath)) {
			hasExplicitScratchOperand = true;
			continue;
		}
		const isPathLike =
			arg === "." ||
			arg === ".." ||
			arg.startsWith("/") ||
			arg.startsWith("./") ||
			arg.startsWith("../") ||
			arg.includes("/");
		if (isPathLike && is_path_under_current_project_path(currentProjectPath, resolvedPath)) {
			return resolvedPath;
		}
	}
	if (stderr.includes(currentProjectPath)) {
		return currentProjectPath;
	}
	const hasStdin = ctx.stdin != null && String(ctx.stdin).length > 0;
	if (!hasStdin && !hasExplicitScratchOperand && is_path_under_current_project_path(currentProjectPath, ctx.cwd)) {
		return ctx.cwd;
	}
	return null;
}

function native_just_bash_tmp_command_create(command: CommandName, currentProjectPath: string) {
	return defineCommand(command, async (args, commandCtx) => {
		return await delegate_native_just_bash_tmp_command(command, args, commandCtx, currentProjectPath);
	});
}

function native_just_bash_tmp_command_create_all(currentProjectPath: string) {
	return NATIVE_JUST_BASH_TMP_COMMANDS.map((command) =>
		native_just_bash_tmp_command_create(command, currentProjectPath),
	);
}

/**
 * Run a Native Just Bash command through the `/tmp`-restricted filesystem view.
 *
 * This is used for Just Bash built-ins that have not been made app-file-aware:
 * they can process `/tmp` paths and stdin, but cannot directly operate on
 * Convex-backed paths under `currentProjectPath`. It keeps direct operands away
 * from the app tree, permits `/tmp`, `/dev/null`, and synthetic command lookup
 * paths, and adds app-file guidance when the command likely failed because it
 * tried to touch the mounted project directly.
 *
 * Examples: `sort`, `uniq`, `cut`, `awk`, `sed`, `du`, `diff`, `rg`, `rev`,
 * `tac`, `nl`, `base64`, `jq`, and `sha256sum` run through this path.
 */
async function delegate_native_just_bash_tmp_command(
	command: CommandName,
	args: string[],
	ctx: CommandContext,
	currentProjectPath: string,
) {
	const env = Object.fromEntries(ctx.env);
	const cwd = is_native_just_bash_tmp_path(ctx.cwd) ? ctx.cwd : TMP_MOUNT;
	const directRgOperand =
		command === "rg" ? native_just_bash_tmp_command_rg_app_operand(args, ctx, currentProjectPath) : null;

	// ln is pre-checked too: just-bash's catch-all sanitizer rewrites /home…|/tmp… substrings
	// to <path>, so a thrown NativeJustBashTmpCommandAccessError loses every concrete path by the time
	// the model sees it. Rejecting before the inner shell keeps the message intact.
	const directPathOperand =
		command === "du" || command === "diff" || command === "ln"
			? native_just_bash_tmp_command_path_app_operand(args, ctx, currentProjectPath)
			: null;
	const directAppOperand = directRgOperand?.path ?? directPathOperand;

	if (directAppOperand != null) {
		const appOperandError =
			new NativeJustBashTmpCommandAccessError(currentProjectPath, directAppOperand).message +
			(command === "du"
				? `du: app-mount paths do not expose POSIX disk usage. Try: stat ${shell_arg_quote(directAppOperand)} && find ${shell_arg_quote(directAppOperand)} -type f --limit 20\n`
				: "") +
			(directRgOperand != null
				? `rg: app paths do not support direct Native Just Bash rg. Try: grep ${shell_arg_quote(directRgOperand.pattern)} ${shell_arg_quote(directRgOperand.path)}\n`
				: "");
		return {
			stdout: "",
			stderr: appOperandError,
			exitCode: COMMAND_EXIT_FAILURE,
			env: {
				...env,
				PWD: ctx.cwd,
			},
		};
	}

	const inner = new Bash({
		fs: new RestrictedNativeJustBashTmpCommandFs(ctx.fs, currentProjectPath, ctx.cwd),
		cwd,
		env,
		commands: [...ALLOWED_COMMANDS],
		executionLimits: ctx.limits,
	});

	const result = await inner.exec([command, ...args.map(shell_arg_quote)].join(" "), {
		cwd,
		stdin: ctx.stdin as unknown as string,
		stdinKind: "bytes",
		env: {
			...env,
			PWD: cwd,
		},
	});

	const guidancePath = native_just_bash_tmp_command_app_hint_path(args, ctx, currentProjectPath, result.stderr);
	if (result.exitCode !== 0 && guidancePath != null && !result.stderr.includes("Convex-backed")) {
		return {
			...result,
			stderr: `${result.stderr}${new NativeJustBashTmpCommandAccessError(currentProjectPath, guidancePath).message}`,
		};
	}
	return result;
}
// #endregion native just bash tmp command

// #endregion just bash fs
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
 * Per-call /tmp scratch fs. Loaded from durable storage at the start of
 * every bash call and flushed back at the end; nothing survives the call in
 * memory, so any Convex action runtime sees the same durable state.
 *
 * Mutating operations mark the touched roots dirty so the end-of-call flush
 * can persist a delta instead of the whole scratch.
 */
class BashTmpFs implements IFileSystem {
	readonly fs = new InMemoryFs();
	/**
	 * Paths that existed at create time;
	 * the delta flush derives deletions from it.
	 **/
	readonly baselinePaths = new Set<string>();
	/**
	 * Roots of paths mutated.
	 **/
	readonly dirtyRoots = new Set<string>();
	dirty = false;

	/**
	 * Build a fresh per-call /tmp fs from durable storage. Called at the start
	 * of every bash call so the in-memory fs always reflects what other
	 * runtimes flushed; the collected baseline powers the end-of-call delta
	 * flush.
	 */
	static async create(ctx: ActionCtx, threadId: Id<"ai_chat_threads">): Promise<BashTmpFs> {
		const loaded = (await ctx.runQuery(internal.ai_chat_files.load_thread_tmp_files, {
			threadId,
		})) as ai_chat_files_load_thread_tmp_files_Result;

		const tmpFs = new BashTmpFs();
		for (const fileNode of loaded.file_nodes) {
			if (fileNode.kind === "directory") {
				await tmpFs.fs.mkdir(fileNode.path, { recursive: true });
				await tmpFs.fs.chmod(fileNode.path, fileNode.mode);
				await tmpFs.fs.utimes(fileNode.path, new Date(fileNode.mtime), new Date(fileNode.mtime));
			} else if (fileNode.kind === "symlink") {
				await tmpFs.fs.symlink(fileNode.symlinkTargetPath ?? "", fileNode.path);
				await tmpFs.fs.chmod(fileNode.path, fileNode.mode);
			} else {
				const bytes = loaded.file_nodes_content_dict[fileNode._id]?.bytes ?? new ArrayBuffer(0);
				tmpFs.fs.writeFileSync(fileNode.path, new Uint8Array(bytes), undefined, {
					mode: fileNode.mode,
					mtime: new Date(fileNode.mtime),
				});
			}
			tmpFs.baselinePaths.add(fileNode.path);
		}
		return tmpFs;
	}

	private markDirty(path: string) {
		this.dirty = true;
		this.dirtyRoots.add(normalize_path(path));
	}

	async readFile(path: string, options?: Parameters<IFileSystem["readFile"]>[1]) {
		return await this.fs.readFile(path, options);
	}

	async readFileBuffer(path: string) {
		return await this.fs.readFileBuffer(path);
	}

	async writeFile(path: string, content: FileContent, options?: Parameters<IFileSystem["writeFile"]>[2]) {
		await this.fs.writeFile(path, content, options);
		this.markDirty(path);
	}

	async appendFile(path: string, content: FileContent, options?: Parameters<IFileSystem["appendFile"]>[2]) {
		await this.fs.appendFile(path, content, options);
		this.markDirty(path);
	}

	async exists(path: string) {
		return await this.fs.exists(path);
	}

	async stat(path: string) {
		return await this.fs.stat(path);
	}

	async mkdir(path: string, options?: MkdirOptions) {
		await this.fs.mkdir(path, options);
		this.markDirty(path);
	}

	async readdir(path: string) {
		return await this.fs.readdir(path);
	}

	async rm(path: string, options?: RmOptions) {
		await this.fs.rm(path, options);
		this.markDirty(path);
	}

	async cp(src: string, dest: string, options?: CpOptions) {
		await this.fs.cp(src, dest, options);
		this.markDirty(dest);
	}

	async mv(src: string, dest: string) {
		await this.fs.mv(src, dest);
		this.markDirty(src);
		this.markDirty(dest);
	}

	resolvePath(base: string, path: string) {
		return this.fs.resolvePath(base, path);
	}

	getAllPaths() {
		return this.fs.getAllPaths();
	}

	async chmod(path: string, mode: number) {
		await this.fs.chmod(path, mode);
		this.markDirty(path);
	}

	async symlink(target: string, linkPath: string) {
		await this.fs.symlink(target, linkPath);
		this.markDirty(linkPath);
	}

	async link(existingPath: string, newPath: string) {
		await this.fs.link(existingPath, newPath);
		this.markDirty(newPath);
	}

	async readlink(path: string) {
		return await this.fs.readlink(path);
	}

	async lstat(path: string) {
		return await this.fs.lstat(path);
	}

	async realpath(path: string) {
		return await this.fs.realpath(path);
	}

	async utimes(path: string, atime: Date, mtime: Date) {
		await this.fs.utimes(path, atime, mtime);
		this.markDirty(path);
	}
}

/**
 * Means a Native Just Bash /tmp command tried to access the Convex-backed app file tree.
 */
class NativeJustBashTmpCommandAccessError extends Error {
	constructor(currentProjectPath: string, path: string) {
		const normalizedPath = normalize_path(path);
		const appFileNodePath =
			current_project_path_to_app_file_node_path(currentProjectPath, normalizedPath) ?? normalizedPath;
		super(
			`Native Just Bash /tmp commands cannot access app files directly: '${normalizedPath}'.\n` +
				`The app file tree at '${currentProjectPath}' is Convex-backed, so Native Just Bash /tmp commands can use /tmp paths or stdin but not direct app-file operands.\n` +
				`For app path '${appFileNodePath}', use app-aware commands such as search, find, grep, cat, head, tail, wc, stat, or tree. To process one readable app file with Native Just Bash /tmp tools, pipe it through cat or copy it first: cp ${shell_arg_quote(normalizedPath)} /tmp/<name>\n`,
		);
		this.name = "NativeJustBashTmpCommandAccessError";
	}
}

/**
 * Restricted filesystem view for Native Just Bash /tmp commands.
 *
 * This is not the `/tmp` storage implementation; `BashTmpFs` owns that. This
 * wrapper sits in front of the full mounted shell filesystem for nested Native Just Bash
 * commands, allows `/tmp`, `/dev/null`, and command lookup paths, and rejects
 * direct access to the Convex-backed app file tree with a targeted error.
 *
 * Synthetic paths are entries this wrapper reports even though they are not
 * persisted in the mounted filesystem: `/bin`, `/usr`, `/usr/bin`, executable
 * command-name files under `/bin` and `/usr/bin`, plus `/dev` and `/dev/null`.
 * They exist only to satisfy Just Bash command lookup and null-device behavior.
 */
class RestrictedNativeJustBashTmpCommandFs implements IFileSystem {
	constructor(
		private readonly fs: IFileSystem,
		private readonly currentProjectPath: string,
		private readonly commandCwd: string,
	) {}

	async readFile(path: string, options?: Parameters<IFileSystem["readFile"]>[1]) {
		const normalizedPath = normalize_path(path);
		if (!is_native_just_bash_tmp_path(normalizedPath)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentProjectPath, normalizedPath);
		}
		return await this.fs.readFile(normalizedPath, options);
	}

	async readFileBuffer(path: string) {
		const normalizedPath = normalize_path(path);
		if (!is_native_just_bash_tmp_path(normalizedPath)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentProjectPath, normalizedPath);
		}
		return await this.fs.readFileBuffer(normalizedPath);
	}

	async writeFile(path: string, content: FileContent, options?: Parameters<IFileSystem["writeFile"]>[2]) {
		const normalizedPath = normalize_path(path);
		if (!is_native_just_bash_tmp_path(normalizedPath)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentProjectPath, normalizedPath);
		}
		await this.fs.writeFile(normalizedPath, content, options);
	}

	async appendFile(path: string, content: FileContent, options?: Parameters<IFileSystem["appendFile"]>[2]) {
		const normalizedPath = normalize_path(path);
		if (!is_native_just_bash_tmp_path(normalizedPath)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentProjectPath, normalizedPath);
		}
		await this.fs.appendFile(normalizedPath, content, options);
	}

	async exists(path: string) {
		const normalizedPath = normalize_path(path);

		// Synthetic command lookup paths exist so Just Bash PATH resolution can probe them.
		if (
			is_native_just_bash_command_lookup_directory(normalizedPath) ||
			native_just_bash_command_lookup_name(normalizedPath) != null
		) {
			return true;
		}

		// Native Just Bash commands are limited to synthetic lookup paths, /dev, and /tmp.
		if (!is_native_just_bash_tmp_path(normalizedPath)) {
			return false;
		}
		return normalizedPath === "/dev" || (await this.fs.exists(normalizedPath));
	}

	async stat(path: string): Promise<FsStat> {
		const normalizedPath = normalize_path(path);

		// Synthetic lookup folders must stat as directories so Just Bash can search PATH.
		if (is_native_just_bash_command_lookup_directory(normalizedPath)) {
			return {
				isFile: false,
				isDirectory: true,
				isSymbolicLink: false,
				mode: 0o755,
				size: 0,
				mtime: new Date(),
			};
		}

		// Synthetic lookup entries must stat as executable files so command resolution succeeds.
		if (native_just_bash_command_lookup_name(normalizedPath) != null) {
			return {
				isFile: true,
				isDirectory: false,
				isSymbolicLink: false,
				mode: 0o755,
				size: 0,
				mtime: new Date(),
			};
		}

		if (!is_native_just_bash_tmp_path(normalizedPath)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentProjectPath, normalizedPath);
		}

		// /dev is synthetic; the mounted filesystem only owns /dev/null and /tmp contents.
		if (normalizedPath === "/dev") {
			return {
				isFile: false,
				isDirectory: true,
				isSymbolicLink: false,
				mode: 0o755,
				size: 0,
				mtime: new Date(),
			};
		}
		return await this.fs.stat(normalizedPath);
	}

	async mkdir(path: string, options?: MkdirOptions) {
		const normalizedPath = normalize_path(path);
		if (!is_native_just_bash_tmp_path(normalizedPath)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentProjectPath, normalizedPath);
		}
		await this.fs.mkdir(normalizedPath, options);
	}

	async readdir(path: string) {
		const normalizedPath = normalize_path(path);
		if (normalizedPath === "/usr") {
			return ["bin"];
		}
		if (normalizedPath === "/bin" || normalizedPath === "/usr/bin") {
			return [...ALLOWED_COMMANDS].sort();
		}
		if (!is_native_just_bash_tmp_path(normalizedPath)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentProjectPath, normalizedPath);
		}
		if (normalizedPath === "/") {
			return ["dev", "tmp"];
		}
		if (normalizedPath === "/dev") {
			return ["null"];
		}
		return await this.fs.readdir(normalizedPath);
	}

	async rm(path: string, options?: RmOptions) {
		const normalizedPath = normalize_path(path);
		if (!is_native_just_bash_tmp_path(normalizedPath)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentProjectPath, normalizedPath);
		}
		await this.fs.rm(normalizedPath, options);
	}

	async cp(src: string, dest: string, options?: CpOptions) {
		const normalizedSrc = normalize_path(src);
		if (!is_native_just_bash_tmp_path(normalizedSrc)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentProjectPath, normalizedSrc);
		}

		const normalizedDest = normalize_path(dest);
		if (!is_native_just_bash_tmp_path(normalizedDest)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentProjectPath, normalizedDest);
		}

		await this.fs.cp(normalizedSrc, normalizedDest, options);
	}

	async mv(src: string, dest: string) {
		const normalizedSrc = normalize_path(src);
		if (!is_native_just_bash_tmp_path(normalizedSrc)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentProjectPath, normalizedSrc);
		}

		const normalizedDest = normalize_path(dest);
		if (!is_native_just_bash_tmp_path(normalizedDest)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentProjectPath, normalizedDest);
		}

		await this.fs.mv(normalizedSrc, normalizedDest);
	}

	resolvePath(base: string, path: string) {
		if (path.startsWith("/")) {
			return normalize_path(path);
		}
		const basePath = is_native_just_bash_tmp_path(this.commandCwd) ? base : this.commandCwd;
		return resolve_path(basePath, path);
	}

	getAllPaths() {
		const paths = new Set(["/", "/dev", "/dev/null", TMP_MOUNT]);
		for (const path of this.fs.getAllPaths()) {
			const normalizedPath = normalize_path(path);
			if (normalizedPath === TMP_MOUNT || normalizedPath.startsWith(`${TMP_MOUNT}/`)) {
				paths.add(normalizedPath);
			}
		}
		return [...paths].sort();
	}

	async chmod(path: string, mode: number) {
		const normalizedPath = normalize_path(path);
		if (!is_native_just_bash_tmp_path(normalizedPath)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentProjectPath, normalizedPath);
		}
		await this.fs.chmod(normalizedPath, mode);
	}

	async symlink(target: string, linkPath: string) {
		const normalizedLinkPath = normalize_path(linkPath);
		if (!is_native_just_bash_tmp_path(normalizedLinkPath)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentProjectPath, normalizedLinkPath);
		}

		const resolvedTarget = target.startsWith("/")
			? normalize_path(target)
			: resolve_path(normalize_path(`${normalizedLinkPath}/..`), target);
		if (!is_native_just_bash_tmp_path(resolvedTarget)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentProjectPath, resolvedTarget);
		}

		await this.fs.symlink(target, normalizedLinkPath);
	}

	async link(existingPath: string, newPath: string) {
		const normalizedExistingPath = normalize_path(existingPath);
		if (!is_native_just_bash_tmp_path(normalizedExistingPath)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentProjectPath, normalizedExistingPath);
		}

		const normalizedNewPath = normalize_path(newPath);
		if (!is_native_just_bash_tmp_path(normalizedNewPath)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentProjectPath, normalizedNewPath);
		}

		await this.fs.link(normalizedExistingPath, normalizedNewPath);
	}

	async readlink(path: string) {
		const normalizedPath = normalize_path(path);
		if (!is_native_just_bash_tmp_path(normalizedPath)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentProjectPath, normalizedPath);
		}
		return await this.fs.readlink(normalizedPath);
	}

	async lstat(path: string) {
		const normalizedPath = normalize_path(path);
		if (
			is_native_just_bash_command_lookup_directory(normalizedPath) ||
			native_just_bash_command_lookup_name(normalizedPath) != null
		) {
			return await this.stat(normalizedPath);
		}

		if (!is_native_just_bash_tmp_path(normalizedPath)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentProjectPath, normalizedPath);
		}

		if (normalizedPath === "/dev") {
			return await this.stat(normalizedPath);
		}

		return await this.fs.lstat(normalizedPath);
	}

	async realpath(path: string) {
		const normalizedPath = normalize_path(path);
		if (
			is_native_just_bash_command_lookup_directory(normalizedPath) ||
			native_just_bash_command_lookup_name(normalizedPath) != null
		) {
			return normalizedPath;
		}

		if (!is_native_just_bash_tmp_path(normalizedPath)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentProjectPath, normalizedPath);
		}

		const realPath = await this.fs.realpath(normalizedPath);
		const normalizedRealPath = normalize_path(realPath);
		if (!is_native_just_bash_tmp_path(normalizedRealPath)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentProjectPath, normalizedRealPath);
		}

		return normalizedRealPath;
	}

	async utimes(path: string, atime: Date, mtime: Date) {
		const normalizedPath = normalize_path(path);
		if (!is_native_just_bash_tmp_path(normalizedPath)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentProjectPath, normalizedPath);
		}
		await this.fs.utimes(normalizedPath, atime, mtime);
	}
}
// #endregion just bash fs

// #region search command

function search_command_parse_args(args: string[], options: { currentProjectPath: string; cwd: string }) {
	let limitValue: string | undefined;
	let cursor: string | null = null;
	let pathValue: string | undefined;
	const queryParts: string[] = [];
	let optionsEnded = false;

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (optionsEnded) {
			queryParts.push(arg);
			continue;
		}
		if (arg === "--") {
			optionsEnded = true;
			continue;
		}
		if (arg === "--code" || arg === "--table" || arg === "--no-code") {
			return Result({
				_nay: {
					message:
						`search: ${arg} is not supported for full-text content search.\n` +
						"Use plain content words or inspect a specific file with grep.",
				},
			});
		}
		if (arg === "--limit") {
			const value = command_read_option_value("search", args, index, "--limit");
			if (value._nay) return value;
			limitValue = value._yay.value;
			index++;
			continue;
		}
		if (arg.startsWith("--limit=")) {
			limitValue = arg.slice("--limit=".length);
			continue;
		}
		if (arg === "--cursor") {
			const value = command_read_option_value("search", args, index, "--cursor");
			if (value._nay) return value;
			cursor = value._yay.value.trim();
			index++;
			continue;
		}
		if (arg.startsWith("--cursor=")) {
			cursor = arg.slice("--cursor=".length).trim();
			continue;
		}
		if (arg === "--path") {
			const value = command_read_option_value("search", args, index, "--path");
			if (value._nay) return value;
			pathValue = value._yay.value.trim();
			index++;
			continue;
		}
		if (arg.startsWith("--path=")) {
			pathValue = arg.slice("--path=".length).trim();
			continue;
		}
		if (arg.startsWith("--") || (arg.startsWith("-") && arg !== "-")) {
			return Result({ _nay: { message: `search: unsupported option ${arg}` } });
		}
		queryParts.push(arg);
	}

	const limit = command_parse_limit("search", limitValue, 20, 100);
	if (limit._nay) {
		return limit;
	}

	const query = queryParts.join(" ").trim();
	if (!query) {
		return Result({
			_nay: { message: "search: missing query" },
		});
	}

	// A positional path is almost always a mistaken scope filter; point to --path instead of
	// silently folding it into the text query.
	const pathOperand = queryParts.find(
		(arg) =>
			arg.includes("/") ||
			arg.startsWith("~") ||
			arg === "." ||
			arg === ".." ||
			is_path_under_current_project_path(options.currentProjectPath, normalize_path(arg)),
	);
	if (pathOperand != null) {
		return Result({
			_nay: {
				message:
					`search: path operands are not supported: ${pathOperand}\n` +
					"Pass content words only. To restrict to one folder, use: search --path <folder> <content terms>",
			},
		});
	}

	// Optional subtree scope. Resolve the shell folder path to an app file node path.
	let path: string | undefined;
	if (pathValue != null && pathValue !== "") {
		const appFileNodePath = current_project_path_to_app_file_node_path(
			options.currentProjectPath,
			resolve_path(options.cwd, pathValue),
		);
		if (appFileNodePath == null) {
			return Result({
				_nay: {
					message:
						`search: --path must be a folder under the app file tree: ${pathValue}\n` +
						`Use a path under ${options.currentProjectPath}.`,
				},
			});
		}
		path = appFileNodePath;
	}

	return Result({
		_yay: {
			query,
			limit: limit._yay,
			cursor,
			path,
		},
	});
}

function search_command_build_continuation(args: {
	currentProjectPath: string;
	path: string | undefined;
	limit: number;
	cursor: string;
	query: string;
}) {
	const continuationParts = ["Next page:", "search"];
	if (args.path != null) {
		continuationParts.push(
			"--path",
			shell_arg_quote(app_file_node_path_to_current_project_path(args.currentProjectPath, args.path)),
		);
	}
	continuationParts.push(
		"--limit",
		String(args.limit),
		"--cursor",
		shell_arg_quote(args.cursor),
		shell_arg_quote(args.query),
	);
	return continuationParts.join(" ");
}

function search_command_exact_query_filter(query: string) {
	const trimmedQuery = query.trim();
	return /^\S+$/u.test(trimmedQuery) && /[-_.:@]/u.test(trimmedQuery) ? trimmedQuery.toLowerCase() : null;
}

// Broad word-level hits stay in the page (suppressing them thins pagination); a per-hit
// note marks whether the shown chunk contains the literal query, so fuzzy full-text
// matches are not relayed as exact ones.
function search_command_exact_query_note(exactQueryFilter: string | null, query: string, markdownChunk: string) {
	if (exactQueryFilter == null) {
		return "";
	}
	return markdownChunk.toLowerCase().includes(exactQueryFilter)
		? ` [contains exact '${query}']`
		: ` [word-level match; chunk does not contain '${query}']`;
}

// Pre-counted exact/word-level split for the "Found N results" header: the model relays
// counts, so hand it the grounded ones instead of letting it count annotated blocks itself.
function search_command_exact_query_summary(exactQueryFilter: string | null, markdownChunks: string[]) {
	if (exactQueryFilter == null) {
		return "";
	}
	const exactCount = markdownChunks.filter((chunk) => chunk.toLowerCase().includes(exactQueryFilter)).length;
	const broadCount = markdownChunks.length - exactCount;
	if (broadCount === 0) {
		return "";
	}
	return ` (exact matches: ${exactCount}, word-level-only matches: ${broadCount}; see per-hit notes)`;
}

function search_command_create(ctx: ActionCtx, ctxData: WorkspaceFsOptions["ctxData"], currentProjectPath: string) {
	return defineCommand("search", async (args, commandCtx) => {
		const parsed = search_command_parse_args(args, { currentProjectPath, cwd: commandCtx.cwd });
		if (parsed._nay) {
			return {
				stdout: "",
				stderr: `${parsed._nay.message}\nUsage: search [--limit N] [--cursor CURSOR] [--path <folder>] <content terms...>\n`,
				exitCode: 2,
			};
		}

		let cursor: string | null = null;
		if (parsed._yay.cursor != null) {
			const resolvedCursor = await cursor_id_resolve(ctx, parsed._yay.cursor);
			if (resolvedCursor._nay) {
				return {
					stdout: "",
					stderr: `${resolvedCursor._nay.message}\n`,
					exitCode: COMMAND_EXIT_FAILURE,
				};
			}
			cursor = resolvedCursor._yay;
		}

		const cwdAppFileNodePath = current_project_path_to_app_file_node_path(currentProjectPath, commandCtx.cwd);

		// Without --path, search follows cwd when it is inside currentProjectPath.
		const path =
			parsed._yay.path ?? (cwdAppFileNodePath != null && cwdAppFileNodePath !== "/" ? cwdAppFileNodePath : undefined);

		const res = (await ctx.runQuery(internal.files_nodes.text_search_files, {
			workspaceId: ctxData.workspaceId,
			projectId: ctxData.projectId,
			userId: ctxData.userId,
			query: parsed._yay.query,
			numItems: clamp_listing_page_limit(parsed._yay.limit),
			cursor,
			pathPrefix: path,
		})) as files_nodes_text_search_files_Result;

		const exactQueryFilter = search_command_exact_query_filter(parsed._yay.query);
		const searchResult = {
			items: res.items.map((item) => ({
				...item,
				path: app_file_node_path_to_current_project_path(currentProjectPath, item.path),
			})),
		};

		const scopeNote =
			path != null ? ` under ${app_file_node_path_to_current_project_path(currentProjectPath, path)}` : "";

		// The miss text is actionable because full-text search accepts plain
		// content terms, not path/name/glob syntax.
		let output =
			`No content matches found${scopeNote}. ` +
			`search expects words from the file content, not a shell pattern: ` +
			`pass one distinctive word or a few plain terms that should appear in the document body. ` +
			`The text index splits on whitespace/punctuation, ignores case, relevance-ranks matches, and prefix-matches the final term. ` +
			`It is implemented with Convex full-text search, but it is not path/name/glob/regex search; ` +
			`use find -name QUERY or find --path-query QUERY for path/name discovery. ` +
			`Retry with shorter distinctive content terms if needed.`;

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

				// Each hit is one block: stable location metadata, optional context hints,
				// then the matched Markdown chunk exactly as it was indexed.
				const blockLines = [
					`${item.path} (lines ${item.lineStart}-${item.lineEnd}, chars ${item.startIndex}-${item.endIndex}, chunk #${item.chunkIndex})${search_command_exact_query_note(exactQueryFilter, parsed._yay.query, item.markdownChunk)}`,
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

			// Blank lines separate the summary, result blocks, and continuation command in the transcript.
			const blocks = [
				`Found ${searchResult.items.length} results${scopeNote}${search_command_exact_query_summary(
					exactQueryFilter,
					searchResult.items.map((item) => item.markdownChunk),
				)}`,
				"",
				...outputBlocks,
			];
			if (!res.isDone) {
				// Print a complete command so the next request can copy the cursor without editing.
				const cursorId = await cursor_id_create(ctx, res.continueCursor);
				blocks.push(
					"",
					search_command_build_continuation({
						currentProjectPath,
						path,
						limit: parsed._yay.limit,
						cursor: cursorId,
						query: parsed._yay.query,
					}),
				);
			}
			output = blocks.join("\n");
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

const COMMAND_NO_BUILTIN_OPTIONS_WITH_VALUES = new Set<string>();

async function get_file_node_from_path(
	ctx: ActionCtx,
	ctxData: WorkspaceFsOptions["ctxData"],
	appFileNodePath: string,
): Promise<files_nodes_get_by_path_Result> {
	if (appFileNodePath === "/") {
		return null;
	}

	return (await ctx.runQuery(internal.files_nodes.get_by_path, {
		workspaceId: ctxData.workspaceId,
		projectId: ctxData.projectId,
		path: appFileNodePath,
	})) as files_nodes_get_by_path_Result;
}

// #region ls command

const LS_PATH_OPERAND_MAX = 20;

function ls_command_parse_args(args: string[]) {
	let limitValue: string | undefined;
	let cursor: string | null = null;
	const paths: string[] = [];
	let unsupportedAppFileOption: string | null = null;
	let recursive = false;
	let directory = false;
	let reverse = false;
	let long = false;
	let time = false;
	let optionsEnded = false;

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (optionsEnded) {
			paths.push(arg);
			continue;
		}
		if (arg === "--") {
			optionsEnded = true;
			continue;
		}
		if (arg === "--limit") {
			const value = command_read_option_value("ls", args, index, "--limit");
			if (value._nay) return value;
			limitValue = value._yay.value;
			index++;
			continue;
		}
		if (arg.startsWith("--limit=")) {
			limitValue = arg.slice("--limit=".length);
			continue;
		}
		if (arg === "--cursor") {
			const value = command_read_option_value("ls", args, index, "--cursor");
			if (value._nay) return value;
			cursor = value._yay.value;
			index++;
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
			const value = command_read_option_value("ls", args, index, "--indicator-style");
			if (value._nay) return value;
			if (value._yay.value !== "slash") {
				unsupportedAppFileOption ??= `--indicator-style=${value._yay.value}`;
			}
			index++;
			continue;
		}
		if (arg.startsWith("--indicator-style=")) {
			const value = arg.slice("--indicator-style=".length);
			if (value !== "slash") {
				unsupportedAppFileOption ??= arg;
			}
			continue;
		}
		if (arg === "--sort") {
			const value = command_read_option_value("ls", args, index, "--sort");
			if (value._nay) return value;
			if (value._yay.value === "time" || value._yay.value === "mtime") {
				time = true;
			} else if (value._yay.value !== "name") {
				unsupportedAppFileOption ??= `--sort=${value._yay.value}`;
			}
			index++;
			continue;
		}
		if (arg.startsWith("--sort=")) {
			const value = arg.slice("--sort=".length);
			if (value === "time" || value === "mtime") {
				time = true;
			} else if (value !== "name") {
				unsupportedAppFileOption ??= arg;
			}
			continue;
		}
		if (arg.startsWith("--")) {
			unsupportedAppFileOption ??= arg;
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
				unsupportedAppFileOption ??= `-${flag}`;
			}
			continue;
		}
		paths.push(arg);
	}

	const limit = command_parse_limit("ls", limitValue, LISTING_DEFAULT_LIMIT, LISTING_MAX_LIMIT);
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
			limit: limit._yay,
			cursor,
			unsupportedAppFileOption,
			recursive,
			directory,
			reverse,
			long,
			time,
		} as const,
	});
}

function ls_command_format_item(args: {
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

async function ls_command_get_path_entry(args: {
	ctx: ActionCtx;
	ctxData: WorkspaceFsOptions["ctxData"];
	workspaceFs: WorkspaceFs;
	appFileNodePath: string;
	needsFullMetadata: boolean;
}) {
	if (!args.needsFullMetadata) {
		const cached = await args.workspaceFs.getEntry(args.appFileNodePath);
		if (!cached) {
			return null;
		}
		if (args.appFileNodePath === "/") {
			return files_SYNTHETIC_ROOT_FOLDER;
		}
		if (cached._id != null) {
			return {
				_id: cached._id,
				path: cached.path,
				name: cached.name,
				kind: cached.kind,
				updatedAt: cached.updatedAt,
				updatedBy: cached.updatedBy,
				contentType: cached.contentType,
			};
		}
	}

	if (args.appFileNodePath === "/") {
		return files_SYNTHETIC_ROOT_FOLDER;
	}

	const entry = await get_file_node_from_path(args.ctx, args.ctxData, args.appFileNodePath);
	if (entry) {
		args.workspaceFs.rememberEntry({
			_id: entry._id,
			path: entry.path,
			name: entry.name,
			kind: entry.kind,
			updatedAt: entry.updatedAt,
			updatedBy: entry.updatedBy,
			contentType: entry.contentType,
		});
	}
	return entry;
}

function ls_command_build_continuation(args: {
	parsed: NonNullable<ReturnType<typeof ls_command_parse_args>["_yay"]>;
	absoluteShellPath?: string;
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
	continuationParts.push("--limit", String(args.parsed.limit), "--cursor", shell_arg_quote(args.cursor));
	if (args.absoluteShellPath != null) {
		continuationParts.push(shell_arg_quote(args.absoluteShellPath));
	}
	return continuationParts.join(" ");
}

function ls_command_create(ctx: ActionCtx, workspaceFs: WorkspaceFs, currentProjectPath: string) {
	return defineCommand("ls", async (args, commandCtx) => {
		const parsed = ls_command_parse_args(args);
		if (parsed._nay) {
			return {
				stdout: "",
				stderr: `${parsed._nay.message}\nUsage: ls [-1aApFdlrRt] [--limit N] [--cursor CURSOR] [PATH ...]\n`,
				exitCode: COMMAND_EXIT_USAGE,
			};
		}

		// AI agents commonly hallucinate `--next-page`; reject it after parse
		// validation so malformed real options still report their normal errors.
		if (args.includes("--next-page")) {
			return {
				stdout: "",
				stderr:
					"ls: --next-page is not supported\n" +
					"Copy the exact `Next page: ls --limit N --cursor ... <path>` command from the previous ls output.\n" +
					"Usage: ls [-1aApFdlrRt] [--limit N] [--cursor CURSOR] [PATH ...]\n",
				exitCode: COMMAND_EXIT_USAGE,
			};
		}

		const targetInputs = parsed._yay.paths.length > 0 ? parsed._yay.paths : [undefined];

		// Turn each ls target into a shell path and, when possible, an app file node path.
		const targets = targetInputs.map((path) => {
			const absoluteShellPath = resolve_path(commandCtx.cwd, path ?? commandCtx.cwd);
			return {
				inputPath: path,
				absoluteShellPath,
				appFileNodePath: current_project_path_to_app_file_node_path(currentProjectPath, absoluteShellPath),
				builtinOperand: path ?? ".",
			};
		});

		const hasAppFileNodeTarget = targets.some((target) => target.appFileNodePath != null);

		if (hasAppFileNodeTarget && parsed._yay.unsupportedAppFileOption != null) {
			const opt = parsed._yay.unsupportedAppFileOption;
			const hint = `ls under ${APP_MOUNT_PATH} supports name order only; use find/search for pattern and content discovery.`;
			return {
				stdout: "",
				stderr: `ls: unsupported option ${opt} for paths under ${APP_MOUNT_PATH}\n${hint}\nUsage: ls [-1aApFdlrRt] [--limit N] [--cursor CURSOR] [PATH ...]\n`,
				exitCode: COMMAND_EXIT_USAGE,
			};
		}

		let cursor: string | null = null;
		if (hasAppFileNodeTarget && parsed._yay.cursor != null) {
			const resolvedCursor = await cursor_id_resolve(ctx, parsed._yay.cursor);
			if (resolvedCursor._nay) {
				return {
					stdout: "",
					stderr: `${resolvedCursor._nay.message}\n`,
					exitCode: COMMAND_EXIT_FAILURE,
				};
			}
			cursor = resolvedCursor._yay;
		}

		// Pathless `ls -t` is the project-wide recency view, so the agent can ask
		// "what changed recently?" without first discovering every folder.
		if (hasAppFileNodeTarget && parsed._yay.time && parsed._yay.paths.length === 0) {
			const result = (await ctx.runQuery(internal.files_nodes.list_recent_paginated, {
				workspaceId: workspaceFs.ctxData.workspaceId,
				projectId: workspaceFs.ctxData.projectId,
				numItems: clamp_listing_page_limit(parsed._yay.limit),
				cursor,
				order: parsed._yay.reverse ? "asc" : "desc",
			})) as files_nodes_list_recent_paginated_Result;

			const lines = result.items.map(
				(item) =>
					`${new Date(item.updatedAt).toISOString()}\t${app_file_node_path_to_current_project_path(currentProjectPath, item.path)}${item.kind === "folder" ? "/" : ""}`,
			);
			if (!result.isDone) {
				lines.push(
					"",
					ls_command_build_continuation({
						parsed: parsed._yay,
						cursor: await cursor_id_create(ctx, result.continueCursor),
					}),
				);
			} else if (lines.length === 0) {
				lines.push("(no files)");
			}
			return { stdout: `${lines.join("\n")}\n`, stderr: "", exitCode: 0 };
		}

		// There is no single indexed query for recursive subtree results ordered by
		// updatedAt, so reject instead of loading and sorting a whole tree in memory.
		if (hasAppFileNodeTarget && parsed._yay.time && parsed._yay.recursive && !parsed._yay.directory) {
			return {
				stdout: "",
				stderr:
					"ls -t -R is not supported for app file paths.\n" +
					"Use `ls -t` for project-wide recency, `ls -t <dir>` for immediate children, or `find <dir>` for recursive path discovery.\n",
				exitCode: COMMAND_EXIT_USAGE,
			};
		}

		// App file node paths are DB-backed. Native Just Bash glob expansion would require
		// unbounded client-side filtering, so guide callers to indexed commands.
		for (const target of targets) {
			if (
				target.appFileNodePath != null &&
				target.inputPath != null &&
				GLOB_METACHARACTER_REGEX.test(target.inputPath)
			) {
				return {
					stdout: "",
					stderr: create_glob_syntax_unsupported_message("ls", target.inputPath),
					exitCode: COMMAND_EXIT_USAGE,
				};
			}
		}

		const sections: string[] = [];
		let stderr = "";
		let exitCode = 0;
		for (let targetIndex = 0; targetIndex < targets.length; targetIndex++) {
			const target = targets[targetIndex];
			const appFileNodePath = target.appFileNodePath;
			if (appFileNodePath == null) {
				const builtinTargets = [target];
				while (targetIndex + 1 < targets.length && targets[targetIndex + 1].appFileNodePath == null) {
					targetIndex++;
					builtinTargets.push(targets[targetIndex]);
				}

				// Adjacent built-in targets can run as one delegated ls call. Stop the
				// batch before an app target so output order stays the same as input order.
				const result = await delegate_builtin_command({
					command: "ls",
					args: command_build_builtin_delegation_args(
						args,
						builtinTargets.map((builtinTarget) => builtinTarget.builtinOperand),
						{
							optionsWithValues: COMMAND_NO_BUILTIN_OPTIONS_WITH_VALUES,
							pathsPosition: "afterOptions",
						},
					),
					commandCtx,
				});
				let stdout = result.stdout.endsWith("\n") ? result.stdout.slice(0, -1) : result.stdout;
				try {
					const stat = await commandCtx.fs.stat(target.absoluteShellPath);
					// A single built-in directory in a mixed ls still needs the heading
					// that multi-target ls would have printed.
					if (
						builtinTargets.length === 1 &&
						targets.length > 1 &&
						stat.isDirectory &&
						!parsed._yay.directory &&
						!parsed._yay.recursive
					) {
						stdout = stdout.length > 0 ? `${target.builtinOperand}:\n${stdout}` : `${target.builtinOperand}:`;
					}
				} catch {
					// Missing built-in targets already report through the delegated ls stderr.
				}
				if (stdout.length > 0) {
					sections.push(stdout);
				}
				stderr += result.stderr;
				if (result.exitCode !== 0) {
					exitCode = result.exitCode;
				}
				continue;
			}

			// Plain output only needs basic entry data. Long output asks for the
			// full file-node row when it needs updatedBy/contentType fields.
			const entry = await ls_command_get_path_entry({
				ctx,
				ctxData: workspaceFs.ctxData,
				workspaceFs,
				appFileNodePath,
				needsFullMetadata:
					parsed._yay.long && (parsed._yay.directory || (await workspaceFs.getEntry(appFileNodePath))?.kind === "file"),
			});
			if (!entry) {
				stderr += `ls: cannot access '${target.absoluteShellPath}': No such file or directory\n`;
				if (exitCode === 0) {
					exitCode = COMMAND_EXIT_FAILURE;
				}
				continue;
			}

			const lines: string[] = [];
			if (parsed._yay.directory || entry.kind === "file") {
				// `-d` means "print the target itself"; files are also printed as a
				// single target instead of being treated as directories.
				if (parsed._yay.cursor != null) {
					return {
						stdout: "",
						stderr: `ls: --cursor can only continue a directory or recursive listing\n`,
						exitCode: COMMAND_EXIT_USAGE,
					};
				}
				lines.push(
					ls_command_format_item({
						kind: entry.kind,
						updatedAt: entry.updatedAt,
						updatedBy: entry.updatedBy,
						contentType: entry.contentType,
						display: target.absoluteShellPath,
						long: parsed._yay.long,
					}),
				);
			} else if (parsed._yay.recursive) {
				// Recursive listings use the subtree index and print absolute shell
				// paths, since children can be nested at different depths.
				const result = (await ctx.runQuery(internal.files_nodes.list_folder_subtree_paginated, {
					workspaceId: workspaceFs.ctxData.workspaceId,
					projectId: workspaceFs.ctxData.projectId,
					folderPath: appFileNodePath,
					numItems: clamp_listing_page_limit(parsed._yay.limit),
					cursor,
					minDepth: 1,
					order: parsed._yay.reverse ? "desc" : "asc",
				})) as files_nodes_list_folder_subtree_paginated_Result;

				lines.push(
					...result.page.map((item) =>
						ls_command_format_item({
							kind: item.kind,
							updatedAt: item.updatedAt,
							updatedBy: item.updatedBy,
							contentType: item.contentType,
							display: app_file_node_path_to_current_project_path(currentProjectPath, item.path),
							long: parsed._yay.long,
						}),
					),
				);
				if (!result.isDone) {
					lines.push(
						"",
						ls_command_build_continuation({
							parsed: parsed._yay,
							absoluteShellPath: target.absoluteShellPath,
							cursor: await cursor_id_create(ctx, result.continueCursor),
						}),
					);
				}
			} else {
				// Plain directory listings are a parentId query. The project root is
				// synthetic, so its parent id is the stable root sentinel.
				let parentId: Id<"files_nodes"> | typeof files_ROOT_ID;
				if (entry.path === "/") {
					parentId = files_ROOT_ID;
				} else {
					parentId = entry._id as Id<"files_nodes">;
				}
				const result = parsed._yay.time
					? ((await ctx.runQuery(internal.files_nodes.list_dir_children_by_parent_recency_paginated, {
							workspaceId: workspaceFs.ctxData.workspaceId,
							projectId: workspaceFs.ctxData.projectId,
							parentId,
							numItems: clamp_listing_page_limit(parsed._yay.limit),
							cursor,
							order: parsed._yay.reverse ? "asc" : "desc",
						})) as files_nodes_list_dir_children_by_parent_recency_paginated_Result)
					: ((await ctx.runQuery(internal.files_nodes.list_dir_children_by_parent_paginated, {
							workspaceId: workspaceFs.ctxData.workspaceId,
							projectId: workspaceFs.ctxData.projectId,
							parentId,
							numItems: clamp_listing_page_limit(parsed._yay.limit),
							cursor,
							order: parsed._yay.reverse ? "desc" : "asc",
						})) as files_nodes_list_dir_children_by_parent_paginated_Result);

				lines.push(
					...result.items.map((item) =>
						ls_command_format_item({
							kind: item.kind,
							updatedAt: item.updatedAt,
							updatedBy: item.updatedBy,
							contentType: item.contentType,
							display: item.name,
							long: parsed._yay.long,
						}),
					),
				);
				if (!result.isDone) {
					lines.push(
						"",
						ls_command_build_continuation({
							parsed: parsed._yay,
							absoluteShellPath: target.absoluteShellPath,
							cursor: await cursor_id_create(ctx, result.continueCursor),
						}),
					);
				}
			}

			if (lines.length === 0) {
				lines.push("(empty directory)");
			}
			if (targets.length > 1 && entry.kind === "folder" && !parsed._yay.directory) {
				lines.unshift(`${target.absoluteShellPath}:`);
			}
			sections.push(lines.join("\n"));
		}

		return {
			stdout: sections.length > 0 ? `${sections.join("\n\n")}\n` : "",
			stderr,
			exitCode,
		};
	});
}

// #endregion ls command

// #region find command

const FIND_COMMAND_EXTENSION_TOKEN_REGEX = /^[a-z0-9][a-z0-9_-]*$/iu;
const SIMPLE_PATH_WORD_GLOB_REGEX = /^\*+([a-z0-9][a-z0-9_-]*)\*+$/iu;
const SIMPLE_PATH_WORD_REGEX_GLOB_REGEX = /^\.\*([a-z0-9][a-z0-9_-]*)\.\*$/iu;
const FIND_COMMAND_BUILTIN_OPTIONS_WITH_VALUES = new Set([
	"-iname",
	"-ipath",
	"-iregex",
	"-maxdepth",
	"-mindepth",
	"-mtime",
	"-name",
	"-newer",
	"-path",
	"-perm",
	"-printf",
	"-regex",
	"-size",
	"-type",
]);

/**
 * Clean the extension value used by `find --extension`.
 *
 * `md` and `.md` both become `md`.
 *
 * Bad input returns a `_nay` with the text to print.
 */
function find_command_normalize_extension_value(extension: string) {
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
function find_command_parse_simple_path_word_glob(pattern: string) {
	const trimmed = pattern.trim();

	// Treat `*readme*` as the plain path word `readme`.
	const globMatch = trimmed.match(SIMPLE_PATH_WORD_GLOB_REGEX);
	if (globMatch) {
		return globMatch[1].toLowerCase();
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
function find_command_build_path_query_retry_hint(
	absoluteShellPath: string,
	args: { query: string; type?: string; maxDepth?: number; limit: number },
) {
	const parts = ["Try:", "find", shell_arg_quote(absoluteShellPath)];
	if (args.maxDepth != null) {
		parts.push("-maxdepth", String(args.maxDepth));
	}
	if (args.type != null) {
		parts.push("-type", args.type);
	}
	parts.push("--path-query", shell_arg_quote(args.query), "--limit", String(args.limit));
	return parts.join(" ");
}

function find_command_parse_args(args: string[]) {
	let path: string | undefined;
	let prefix: string | undefined;
	let limitValue: string | undefined;
	let cursor: string | null = null;
	let unsupportedAppFilePredicate: string | null = null;
	let maxDepthValue: string | undefined;
	let minDepthValue: string | undefined;
	let type: string | undefined;
	let name: string | undefined;
	let iname: string | undefined;
	let pathQuery: string | undefined;
	let extension: string | undefined;

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];

		if (arg === "--limit") {
			const value = command_read_option_value("find", args, index, "--limit");
			if (value._nay) return value;
			limitValue = value._yay.value;
			index++;
			continue;
		}
		if (arg.startsWith("--limit=")) {
			limitValue = arg.slice("--limit=".length);
			continue;
		}
		if (arg === "--cursor") {
			const value = command_read_option_value("find", args, index, "--cursor");
			if (value._nay) return value;
			cursor = value._yay.value;
			index++;
			continue;
		}
		if (arg.startsWith("--cursor=")) {
			cursor = arg.slice("--cursor=".length);
			continue;
		}
		if (arg === "--prefix") {
			const value = command_read_option_value("find", args, index, "--prefix");
			if (value._nay) return value;
			prefix = value._yay.value;
			index++;
			continue;
		}
		if (arg.startsWith("--prefix=")) {
			prefix = arg.slice("--prefix=".length);
			continue;
		}
		if (arg === "-maxdepth" || arg === "--maxdepth") {
			const value = command_read_option_value("find", args, index, arg);
			if (value._nay) return value;
			maxDepthValue = value._yay.value;
			index++;
			continue;
		}
		if (arg === "-mindepth" || arg === "--mindepth") {
			const value = command_read_option_value("find", args, index, arg);
			if (value._nay) return value;
			minDepthValue = value._yay.value;
			index++;
			continue;
		}
		if (arg === "-print") {
			// Printing is already the default action; accept it as a no-op for compatibility.
			continue;
		}
		if (arg === "-type" || arg === "--type") {
			const value = command_read_option_value("find", args, index, arg);
			if (value._nay) return value;
			type = value._yay.value;
			index++;
			continue;
		}
		if (arg === "-name" || arg === "--name") {
			const value = command_read_option_value("find", args, index, arg);
			if (value._nay) return value;
			name = value._yay.value;
			index++;
			continue;
		}
		if (arg === "-iname" || arg === "--iname") {
			const value = command_read_option_value("find", args, index, arg);
			if (value._nay) return value;
			iname = value._yay.value;
			index++;
			continue;
		}
		if (arg === "--path-query") {
			const value = command_read_option_value("find", args, index, arg);
			if (value._nay) return value;
			pathQuery = value._yay.value;
			index++;
			continue;
		}
		if (arg.startsWith("--path-query=")) {
			pathQuery = arg.slice("--path-query=".length);
			continue;
		}
		if (arg === "--extension") {
			const value = command_read_option_value("find", args, index, arg);
			if (value._nay) return value;
			extension = value._yay.value;
			index++;
			continue;
		}
		if (arg.startsWith("--extension=")) {
			extension = arg.slice("--extension=".length);
			continue;
		}
		if (arg.startsWith("-") || arg === "!" || arg === "(" || arg === ")") {
			unsupportedAppFilePredicate ??= arg;
			if (FIND_COMMAND_BUILTIN_OPTIONS_WITH_VALUES.has(arg)) {
				index++;
			} else if (arg === "-exec" || arg === "-ok") {
				while (index + 1 < args.length && args[index + 1] !== ";" && args[index + 1] !== "+") {
					index++;
				}
				if (index + 1 < args.length) {
					index++;
				}
			}
			continue;
		}
		const simpleExtensionGlob = parse_simple_extension_glob(arg);
		if (simpleExtensionGlob) {
			if (path != null) {
				return Result({ _nay: { message: "find: app file find supports one path only" } });
			}
			if (extension != null) {
				const normalizedExtension = find_command_normalize_extension_value(extension);
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

	if (prefix != null && path != null) {
		return Result({ _nay: { message: "find: --prefix cannot be combined with PATH" } });
	}

	const limit = command_parse_limit("find", limitValue, LISTING_DEFAULT_LIMIT, LISTING_MAX_LIMIT);
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

	if (prefix != null && (maxDepth != null || minDepth != null)) {
		// --prefix uses direct indexed path-boundary scans and does not compute a
		// base node depth. Reject rather than silently mis-filter.
		return Result({
			_nay: {
				message:
					"find: --prefix cannot be combined with -maxdepth/-mindepth because prefix scans do not resolve a starting folder depth.\n" +
					"Depth filters require an existing folder PATH. Retry without --prefix after replacing the prefix with that folder path.",
			},
		});
	}

	if (type != null && type !== "f" && type !== "d") {
		return Result({ _nay: { message: "find: -type supports only f or d for app files" } });
	}

	let normalizedExtension: string | undefined;
	if (extension != null) {
		const normalized = find_command_normalize_extension_value(extension);
		if (normalized._nay) return normalized;
		normalizedExtension = normalized._yay.extension;
	}

	// Simple `*.ext` name globs become indexed extension searches.
	const nameGlob = name ?? iname;
	const simpleNameExtension = nameGlob != null ? parse_simple_extension_glob(nameGlob.trim()) : null;
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

	// In app-file find, -name, -iname, and --path-query use the same case-insensitive DB word search.
	const pathQueries = [name, iname, pathQuery].filter((value): value is string => value != null);
	if (pathQueries.length > 1) {
		return Result({ _nay: { message: "find: use only one of -name, -iname, or --path-query" } });
	}

	// Empty search text cannot produce meaningful DB word-search results.
	const normalizedPathQuery = pathQueries.at(0)?.trim();
	if (normalizedPathQuery === "") {
		return Result({ _nay: { message: "find: path search requires a non-empty query" } });
	}

	// For app files, -name/-iname are word search aliases, not shell glob filters.
	if (
		(name != null || iname != null) &&
		normalizedPathQuery != null &&
		GLOB_METACHARACTER_REGEX.test(normalizedPathQuery)
	) {
		const simplePathWordGlob = find_command_parse_simple_path_word_glob(normalizedPathQuery);
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
									limit: limit._yay,
								},
							},
						}),
			},
		});
	}

	// --path-query also accepts plain word-search text only.
	if (pathQuery != null && normalizedPathQuery != null && GLOB_METACHARACTER_REGEX.test(normalizedPathQuery)) {
		const simplePathWordGlob = find_command_parse_simple_path_word_glob(normalizedPathQuery);
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
									limit: limit._yay,
								},
							},
						}),
			},
		});
	}

	return Result({
		_yay: {
			path,
			prefix,
			limit: limit._yay,
			cursor,
			unsupportedAppFilePredicate,
			maxDepth,
			minDepth,
			type,
			name: name == null ? undefined : normalizedPathQuery,
			iname: iname == null ? undefined : normalizedPathQuery,
			pathQuery: pathQuery == null ? undefined : normalizedPathQuery,
			extension: normalizedExtension,
		} as const,
	});
}

function find_command_prefix_to_app_file_node_path(
	commandCtx: CommandContext,
	currentProjectPath: string,
	prefix: string,
) {
	if (GLOB_METACHARACTER_REGEX.test(prefix)) {
		return Result({ _nay: { message: create_glob_syntax_unsupported_message("find", prefix) } });
	}
	if (prefix === "/" || prefix.startsWith("/") || prefix.startsWith("~/")) {
		const shellPath = prefix.startsWith("~/") ? normalize_path(`${HOME}/${prefix.slice(2)}`) : normalize_path(prefix);
		const currentProjectAppFileNodePath = current_project_path_to_app_file_node_path(currentProjectPath, shellPath);
		return Result({ _yay: { appFileNodePath: currentProjectAppFileNodePath ?? normalize_path(prefix) } });
	}

	const cwd = normalize_path(commandCtx.cwd);
	if (is_path_under_current_project_path(currentProjectPath, cwd)) {
		return Result({
			_yay: {
				appFileNodePath:
					current_project_path_to_app_file_node_path(currentProjectPath, resolve_path(commandCtx.cwd, prefix)) ??
					normalize_path(prefix),
			},
		});
	}
	return Result({ _yay: { appFileNodePath: normalize_path(prefix) } });
}

function find_command_build_continuation(args: {
	parsed: NonNullable<ReturnType<typeof find_command_parse_args>["_yay"]>;
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

function find_command_create(ctx: ActionCtx, ctxData: WorkspaceFsOptions["ctxData"], currentProjectPath: string) {
	return defineCommand("find", async (args, commandCtx) => {
		const parsed = find_command_parse_args(args);
		// Parse failures return usage text before any app-file or built-in command routing.
		if (parsed._nay) {
			const errorData = parsed._nay.data as
				| { tryPathQuery?: { query: string; type?: string; limit: number } }
				| undefined;
			const tryPathQuery = errorData?.tryPathQuery ?? null;
			const tryLine =
				tryPathQuery == null ? "" : `${find_command_build_path_query_retry_hint(currentProjectPath, tryPathQuery)}\n`;
			return {
				stdout: "",
				stderr:
					`${parsed._nay.message}\n` +
					tryLine +
					"Usage: find [PATH] [--prefix PREFIX] [-maxdepth N] [-mindepth N] [-type f|d] [-name QUERY|-iname QUERY|--path-query QUERY|--extension EXT] [--limit N] [--cursor CURSOR]\n",
				exitCode: 2,
			};
		}
		// AI agents commonly hallucinate `--next-page`; reject it after parse
		// validation so malformed real options still report their normal errors.
		if (args.includes("--next-page")) {
			return {
				stdout: "",
				stderr:
					"find: --next-page is not supported\n" +
					"Copy the exact `Next page: find ... --limit N --cursor ...` command from the previous find output.\n" +
					"Usage: find [PATH] [--prefix PREFIX] [-maxdepth N] [-mindepth N] [-type f|d] [-name QUERY|-iname QUERY|--path-query QUERY|--extension EXT] [--limit N] [--cursor CURSOR]\n",
				exitCode: COMMAND_EXIT_USAGE,
			};
		}
		const pathQuery = parsed._yay.name ?? parsed._yay.iname ?? parsed._yay.pathQuery;

		let cursor: string | null = null;
		const absoluteShellPath = resolve_path(commandCtx.cwd, parsed._yay.path ?? commandCtx.cwd);
		const target = {
			inputPath: parsed._yay.path,
			absoluteShellPath,
			appFileNodePath: current_project_path_to_app_file_node_path(currentProjectPath, absoluteShellPath),
			builtinOperand: parsed._yay.path ?? ".",
		};
		// Non-app targets belong to Just Bash's built-in find unless the caller requested app-file prefix search.
		if (parsed._yay.prefix == null && target.appFileNodePath == null) {
			return await delegate_builtin_command({
				command: "find",
				args: command_build_builtin_delegation_args(args, [target.builtinOperand], {
					optionsWithValues: FIND_COMMAND_BUILTIN_OPTIONS_WITH_VALUES,
					pathsPosition: "beforeOptions",
				}),
				commandCtx,
			});
		}
		// App files only support predicates that can be implemented with indexed Convex queries.
		if (parsed._yay.unsupportedAppFilePredicate != null) {
			return {
				stdout: "",
				stderr:
					`find: unsupported predicate ${parsed._yay.unsupportedAppFilePredicate} for paths under ${APP_MOUNT_PATH}\n` +
					"GNU find extensions like -printf, -mtime, -newer, -exec, -ok, and -delete are not available there; omit them and use -name QUERY, --path-query QUERY, -type f|d, -maxdepth N, or -mindepth N instead.\n" +
					"Usage: find [PATH] [--prefix PREFIX] [-maxdepth N] [-mindepth N] [-type f|d] [-name QUERY|-iname QUERY|--path-query QUERY|--extension EXT] [--limit N] [--cursor CURSOR]\n",
				exitCode: COMMAND_EXIT_USAGE,
			};
		}
		// Cursor ids are opaque handles stored outside the command output; resolve them before querying.
		if (parsed._yay.cursor != null) {
			const resolvedCursor = await cursor_id_resolve(ctx, parsed._yay.cursor);
			if (resolvedCursor._nay) {
				return {
					stdout: "",
					stderr: `${resolvedCursor._nay.message}\n`,
					exitCode: COMMAND_EXIT_FAILURE,
				};
			}
			cursor = resolvedCursor._yay;
		}

		// Prefix search scans descendants and does not require the folder to exist.
		if (parsed._yay.prefix != null) {
			// Extension filtering is supported only for exact PATH searches.
			if (parsed._yay.extension != null) {
				return {
					stdout: "",
					stderr:
						"find: --prefix cannot be combined with --extension for app files.\n" +
						"Try: find <folder> -type f --extension " +
						shell_arg_quote(parsed._yay.extension) +
						" --limit " +
						String(parsed._yay.limit) +
						"\n",
					exitCode: COMMAND_EXIT_USAGE,
				};
			}

			// Word search and prefix search are separate modes.
			if (pathQuery != null) {
				return {
					stdout: "",
					stderr:
						"find: --prefix cannot be combined with path word search for app files.\n" +
						"Use `find --prefix PREFIX` for indexed descendant path discovery, or `find -name QUERY` for DB-backed path word search.\n",
					exitCode: COMMAND_EXIT_USAGE,
				};
			}

			// Convert to the app path format used to build the trailing-slash treePath prefix.
			const prefixResult = find_command_prefix_to_app_file_node_path(
				commandCtx,
				currentProjectPath,
				parsed._yay.prefix,
			);
			if (prefixResult._nay) {
				return {
					stdout: "",
					stderr: prefixResult._nay.message,
					exitCode: COMMAND_EXIT_USAGE,
				};
			}

			const result = (await ctx.runQuery(internal.files_nodes.list_folder_subtree_paginated, {
				workspaceId: ctxData.workspaceId,
				projectId: ctxData.projectId,
				folderPath: prefixResult._yay.appFileNodePath,
				numItems: clamp_listing_page_limit(parsed._yay.limit),
				cursor,
				...(parsed._yay.type === "f"
					? { kind: "file" as const }
					: parsed._yay.type === "d"
						? { kind: "folder" as const }
						: {}),
			})) as files_nodes_list_folder_subtree_paginated_Result;

			const lines = result.page.map(
				(item) =>
					`${app_file_node_path_to_current_project_path(currentProjectPath, item.path)}${item.kind === "folder" ? "/" : ""}`,
			);
			if (!result.isDone) {
				lines.push(
					"",
					find_command_build_continuation({
						parsed: parsed._yay,
						target: null,
						prefix: app_file_node_path_to_current_project_path(currentProjectPath, prefixResult._yay.appFileNodePath),
						cursor: await cursor_id_create(ctx, result.continueCursor),
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

		// App-file find does not expand shell globs; indexed path search flags handle search.
		if (target.inputPath != null && GLOB_METACHARACTER_REGEX.test(target.inputPath)) {
			return {
				stdout: "",
				stderr: create_glob_syntax_unsupported_message("find", target.inputPath),
				exitCode: COMMAND_EXIT_USAGE,
			};
		}

		// Non-prefix app-file execution should only reach this point after target path resolution succeeded.
		if (target.appFileNodePath == null) {
			throw should_never_happen("find: app file path missing after built-in and prefix branches", {
				absoluteShellPath: target.absoluteShellPath,
				prefix: parsed._yay.prefix,
			});
		}

		const entry = await get_file_node_from_path(ctx, ctxData, target.appFileNodePath);
		// Missing concrete app paths fail normally, with a hint for prefix-style discovery.
		if (target.appFileNodePath !== "/" && !entry) {
			return {
				stdout: "",
				stderr:
					`find: ${target.absoluteShellPath}: No such file or directory\n` +
					`If you intended a path-prefix subtree search, run:\n` +
					`  find --prefix ${shell_arg_quote(target.absoluteShellPath)} --limit ${parsed._yay.limit}\n`,
				exitCode: COMMAND_EXIT_FAILURE,
			};
		}

		// Path word search is full-text search, not glob matching.
		if (pathQuery != null) {
			// Word search and extension search are separate modes.
			if (parsed._yay.extension != null) {
				return {
					stdout: "",
					stderr:
						"find: path word search cannot be combined with --extension for app files.\n" +
						"Try either `find -name readme --limit " +
						String(parsed._yay.limit) +
						"` or `find <folder> -type f --extension " +
						shell_arg_quote(parsed._yay.extension) +
						" --limit " +
						String(parsed._yay.limit) +
						"`.\n",
					exitCode: COMMAND_EXIT_USAGE,
				};
			}

			// Supported depth options become parent or subtree filters.
			let parentId = undefined;
			let pathPrefix = undefined;
			if (target.appFileNodePath === "/") {
				// Root word search supports project-wide results and depth 1.
				if (parsed._yay.maxDepth != null && parsed._yay.maxDepth !== 1) {
					return {
						stdout: "",
						stderr:
							"find: path word search supports project-wide results or immediate children with -maxdepth 1.\n" +
							`${find_command_build_path_query_retry_hint(target.absoluteShellPath, {
								query: pathQuery,
								...(parsed._yay.type == null ? {} : { type: parsed._yay.type }),
								limit: parsed._yay.limit,
							})}\n`,
						exitCode: COMMAND_EXIT_USAGE,
					};
				}

				// Root word search only supports -mindepth 1.
				if (parsed._yay.minDepth != null && parsed._yay.minDepth !== 1) {
					return {
						stdout: "",
						stderr:
							"find: path word search supports -mindepth 1 only; deeper mindepth values are not supported.\n" +
							`${find_command_build_path_query_retry_hint(target.absoluteShellPath, {
								query: pathQuery,
								...(parsed._yay.type == null ? {} : { type: parsed._yay.type }),
								limit: parsed._yay.limit,
							})}\n` +
							"Filter deeper paths from those results if needed.\n",
						exitCode: COMMAND_EXIT_USAGE,
					};
				}

				// Depth 1 means root children.
				if (parsed._yay.maxDepth === 1) {
					parentId = files_ROOT_ID;
				}
			} else {
				// Scoped word search must start from a folder.
				if (!entry || entry.kind !== "folder") {
					return {
						stdout: "",
						stderr: "find: path word search can target the project root or an immediate folder.\n",
						exitCode: COMMAND_EXIT_USAGE,
					};
				}

				// Folder word search supports all descendants and depth 1.
				if (parsed._yay.maxDepth != null && parsed._yay.maxDepth !== 1) {
					return {
						stdout: "",
						stderr:
							"find: scoped path word search supports the full subtree (omit -maxdepth) or immediate children with -maxdepth 1.\n" +
							`${find_command_build_path_query_retry_hint(target.absoluteShellPath, {
								query: pathQuery,
								...(parsed._yay.type == null ? {} : { type: parsed._yay.type }),
								limit: parsed._yay.limit,
							})}\n`,
						exitCode: COMMAND_EXIT_USAGE,
					};
				}

				// Scoped -mindepth only supports 1.
				if (parsed._yay.minDepth != null && parsed._yay.minDepth !== 1) {
					return {
						stdout: "",
						stderr:
							"find: scoped path word search supports -mindepth 1 only; deeper mindepth values are not supported.\n" +
							`${find_command_build_path_query_retry_hint(target.absoluteShellPath, {
								query: pathQuery,
								...(parsed._yay.type == null ? {} : { type: parsed._yay.type }),
								limit: parsed._yay.limit,
							})}\n` +
							"Filter deeper paths from those results if needed.\n",
						exitCode: COMMAND_EXIT_USAGE,
					};
				}

				// Depth 1 maps to parentId; full subtree maps to pathPrefix.
				if (parsed._yay.maxDepth === 1) {
					parentId = entry._id;
				} else {
					pathPrefix = target.appFileNodePath;
				}
			}

			const result = (await ctx.runQuery(internal.files_nodes.search_paths_paginated, {
				workspaceId: ctxData.workspaceId,
				projectId: ctxData.projectId,
				pathQuery,
				numItems: clamp_listing_page_limit(parsed._yay.limit),
				cursor,
				...(parsed._yay.type === "f"
					? { kind: "file" as const }
					: parsed._yay.type === "d"
						? { kind: "folder" as const }
						: {}),
				...(parentId == null ? {} : { parentId }),
				...(pathPrefix == null ? {} : { pathPrefix }),
			})) as files_nodes_search_paths_paginated_Result;

			const lines = result.items.map(
				(item) =>
					`${app_file_node_path_to_current_project_path(currentProjectPath, item.path)}${item.kind === "folder" ? "/" : ""}`,
			);

			// Path word search emits the next-page command or a zero-match marker after pagination.
			if (!result.isDone) {
				lines.push(
					"",
					find_command_build_continuation({
						parsed: parsed._yay,
						target: target.absoluteShellPath,
						prefix: null,
						cursor: await cursor_id_create(ctx, result.continueCursor),
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

		// Extension searches go through the subtree extension index and only return file paths.
		if (parsed._yay.extension != null) {
			// --extension only matches files.
			if (parsed._yay.type === "d") {
				return {
					stdout: "0 matches.\n",
					stderr: "",
					exitCode: 0,
				};
			}

			// Exact file targets are handled without a subtree query.
			if (entry?.kind === "file") {
				const matchesDepth =
					(parsed._yay.minDepth == null || parsed._yay.minDepth <= 0) &&
					(parsed._yay.maxDepth == null || parsed._yay.maxDepth >= 0);
				const lines =
					cursor == null && matchesDepth && entry.lowercaseExtension === parsed._yay.extension
						? [app_file_node_path_to_current_project_path(currentProjectPath, entry.path)]
						: ["0 matches."];
				return {
					stdout: `${lines.join("\n")}\n`,
					stderr: "",
					exitCode: 0,
				};
			}

			const result = (await ctx.runQuery(internal.files_nodes.list_folder_subtree_paginated, {
				workspaceId: ctxData.workspaceId,
				projectId: ctxData.projectId,
				folderPath: target.appFileNodePath,
				kind: "file" as const,
				lowercaseExtension: parsed._yay.extension,
				numItems: clamp_listing_page_limit(parsed._yay.limit),
				cursor,
				...(parsed._yay.minDepth == null ? {} : { minDepth: parsed._yay.minDepth }),
				...(parsed._yay.maxDepth == null ? {} : { maxDepth: parsed._yay.maxDepth }),
			})) as files_nodes_list_folder_subtree_paginated_Result;

			const lines = result.page.map((item) =>
				app_file_node_path_to_current_project_path(currentProjectPath, item.path),
			);
			if (!result.isDone) {
				lines.push(
					"",
					find_command_build_continuation({
						parsed: parsed._yay,
						target: target.absoluteShellPath,
						prefix: null,
						cursor: await cursor_id_create(ctx, result.continueCursor),
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

		// Plain app-file find lists the subtree through the path index with optional type/depth filters.
		if (entry?.kind === "file") {
			const matchesKind = parsed._yay.type == null || parsed._yay.type === "f";
			const matchesDepth =
				(parsed._yay.minDepth == null || parsed._yay.minDepth <= 0) &&
				(parsed._yay.maxDepth == null || parsed._yay.maxDepth >= 0);
			const lines =
				cursor == null && matchesKind && matchesDepth
					? [app_file_node_path_to_current_project_path(currentProjectPath, entry.path)]
					: ["0 matches."];
			return {
				stdout: `${lines.join("\n")}\n`,
				stderr: "",
				exitCode: 0,
			};
		}

		const result = (await ctx.runQuery(internal.files_nodes.list_folder_subtree_paginated, {
			workspaceId: ctxData.workspaceId,
			projectId: ctxData.projectId,
			folderPath: target.appFileNodePath,
			numItems: clamp_listing_page_limit(parsed._yay.limit),
			cursor,
			...(parsed._yay.type === "f"
				? { kind: "file" as const }
				: parsed._yay.type === "d"
					? { kind: "folder" as const }
					: {}),
			...(parsed._yay.minDepth == null ? {} : { minDepth: parsed._yay.minDepth }),
			...(parsed._yay.maxDepth == null ? {} : { maxDepth: parsed._yay.maxDepth }),
		})) as files_nodes_list_folder_subtree_paginated_Result;

		const lines = result.page.map(
			(item) =>
				`${app_file_node_path_to_current_project_path(currentProjectPath, item.path)}${item.kind === "folder" ? "/" : ""}`,
		);

		// Plain subtree listings emit the next-page command or a zero-match marker after pagination.
		if (!result.isDone) {
			lines.push(
				"",
				find_command_build_continuation({
					parsed: parsed._yay,
					target: target.absoluteShellPath,
					prefix: null,
					cursor: await cursor_id_create(ctx, result.continueCursor),
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

// #endregion find command

// #region tree command

const TREE_COMMAND_BUILTIN_OPTIONS_WITH_VALUES = new Set(["-L", "-P", "-I", "--filelimit", "-o"]);

function tree_command_parse_args(args: string[]) {
	let path: string | undefined;
	let limitValue: string | undefined;
	let cursor: string | null = null;
	let unsupportedAppFileOption: string | null = null;

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--limit") {
			const value = command_read_option_value("tree", args, index, "--limit");
			if (value._nay) return value;
			limitValue = value._yay.value;
			index++;
			continue;
		}
		if (arg.startsWith("--limit=")) {
			limitValue = arg.slice("--limit=".length);
			continue;
		}
		if (arg === "--cursor") {
			const value = command_read_option_value("tree", args, index, "--cursor");
			if (value._nay) return value;
			cursor = value._yay.value;
			index++;
			continue;
		}
		if (arg.startsWith("--cursor=")) {
			cursor = arg.slice("--cursor=".length);
			continue;
		}
		if (TREE_COMMAND_BUILTIN_OPTIONS_WITH_VALUES.has(arg)) {
			unsupportedAppFileOption ??= arg;
			index++;
			continue;
		}
		if (arg.startsWith("-")) {
			unsupportedAppFileOption ??= arg;
			continue;
		}
		if (path != null) {
			return Result({ _nay: { message: "tree: app file tree supports one path only" } });
		}
		path = arg;
	}

	const limit = command_parse_limit("tree", limitValue, LISTING_DEFAULT_LIMIT, LISTING_MAX_LIMIT);
	if (limit._nay) {
		return limit;
	}

	return Result({
		_yay: {
			path,
			limit: limit._yay,
			cursor,
			unsupportedAppFileOption,
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

function tree_command_build_continuation(args: { target: string; limit: number; cursor: string }) {
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

function tree_command_create(ctx: ActionCtx, ctxData: WorkspaceFsOptions["ctxData"], currentProjectPath: string) {
	return defineCommand("tree", async (args, commandCtx) => {
		const parsed = tree_command_parse_args(args);
		if (parsed._nay) {
			return {
				stdout: "",
				stderr: `${parsed._nay.message}\nUsage: tree [PATH] [--limit N] [--cursor CURSOR]\n`,
				exitCode: COMMAND_EXIT_USAGE,
			};
		}
		// AI agents commonly hallucinate `--next-page`; reject it after parse
		// validation so malformed real options still report their normal errors.
		if (args.includes("--next-page")) {
			return {
				stdout: "",
				stderr:
					"tree: --next-page is not supported\n" +
					"Copy the exact `Next page: tree <path> --limit N --cursor ...` command from the previous tree output.\n" +
					"Usage: tree [PATH] [--limit N] [--cursor CURSOR]\n",
				exitCode: COMMAND_EXIT_USAGE,
			};
		}
		const absoluteShellPath = resolve_path(commandCtx.cwd, parsed._yay.path ?? commandCtx.cwd);
		if (!is_path_under_current_project_path(currentProjectPath, absoluteShellPath)) {
			const builtinOperand = parsed._yay.path ?? ".";
			return await delegate_builtin_command({
				command: "tree",
				args: command_build_builtin_delegation_args(args, [builtinOperand], {
					optionsWithValues: TREE_COMMAND_BUILTIN_OPTIONS_WITH_VALUES,
					pathsPosition: "afterOptions",
				}),
				commandCtx,
			});
		}
		if (parsed._yay.unsupportedAppFileOption != null) {
			return {
				stdout: "",
				stderr:
					`tree: unsupported option ${parsed._yay.unsupportedAppFileOption} for paths under ${APP_MOUNT_PATH}\n` +
					"Usage: tree [PATH] [--limit N] [--cursor CURSOR]\n",
				exitCode: COMMAND_EXIT_USAGE,
			};
		}
		if (parsed._yay.path != null && GLOB_METACHARACTER_REGEX.test(parsed._yay.path)) {
			return {
				stdout: "",
				stderr: create_glob_syntax_unsupported_message("tree", parsed._yay.path),
				exitCode: COMMAND_EXIT_USAGE,
			};
		}
		let cursor: string | null = null;
		if (parsed._yay.cursor != null) {
			const resolvedCursor = await cursor_id_resolve(ctx, parsed._yay.cursor);
			if (resolvedCursor._nay) {
				return {
					stdout: "",
					stderr: `${resolvedCursor._nay.message}\n`,
					exitCode: COMMAND_EXIT_FAILURE,
				};
			}
			cursor = resolvedCursor._yay;
		}

		const appFileNodePath = current_project_path_to_app_file_node_path(currentProjectPath, absoluteShellPath);
		if (appFileNodePath == null) {
			return {
				stdout: "",
				stderr: `tree: app file path expected under ${currentProjectPath}\n`,
				exitCode: COMMAND_EXIT_USAGE,
			};
		}
		const entry = await get_file_node_from_path(ctx, ctxData, appFileNodePath);
		if (appFileNodePath !== "/" && !entry) {
			return {
				stdout: "",
				stderr: `tree: ${absoluteShellPath}: No such file or directory\n`,
				exitCode: COMMAND_EXIT_FAILURE,
			};
		}

		if (entry?.kind === "file") {
			return {
				stdout: `${absoluteShellPath}\n`,
				stderr: "",
				exitCode: 0,
			};
		}

		const result = (await ctx.runQuery(internal.files_nodes.list_folder_subtree_paginated, {
			workspaceId: ctxData.workspaceId,
			projectId: ctxData.projectId,
			folderPath: appFileNodePath,
			numItems: clamp_listing_page_limit(parsed._yay.limit),
			cursor,
			minDepth: 1,
		})) as files_nodes_list_folder_subtree_paginated_Result;

		const lines = [absoluteShellPath];
		for (const item of result.page) {
			const segments = tree_command_relative_segments(appFileNodePath, item.path);
			if (segments.length === 0) {
				continue;
			}
			const prefix = segments.length === 1 ? "|-- " : `${"|   ".repeat(segments.length - 1)}|-- `;
			lines.push(`${prefix}${segments.at(-1)}${item.kind === "folder" ? "/" : ""}`);
		}
		if (!result.isDone) {
			lines.push(
				"",
				tree_command_build_continuation({
					target: absoluteShellPath,
					limit: parsed._yay.limit,
					cursor: await cursor_id_create(ctx, result.continueCursor),
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
	"grep: app-file grep is substring-only; regex metacharacters are matched literally. Use search with plain content words for cross-file discovery.\n";

function grep_command_has_unescaped_regex_metacharacter(pattern: string) {
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

// Longest literal run once unescaped metacharacters become separators, so '^# Readme'
// suggests '# Readme' and 'basheval.*common' suggests 'basheval' — a retry that actually
// matches under substring semantics.
function grep_command_substring_only_retry_literal(pattern: string) {
	const segments: string[] = [];
	let current = "";
	let escaped = false;
	for (const char of pattern) {
		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (char === "^" || char === "$" || char === "." || char === "*" || char === "[" || char === "]") {
			segments.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	segments.push(current);
	const literal = segments.reduce((longest, segment) => (segment.length > longest.length ? segment : longest), "");
	return literal.trim().length === 0 ? null : literal;
}

function grep_command_create(ctx: ActionCtx, ctxData: WorkspaceFsOptions["ctxData"], currentProjectPath: string) {
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
			const arg = args[index];
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

		// Resolved once: this both gates the single-app-file fast path and feeds the queries below.
		const singleAppFileNodePath =
			operands.length === 1 && operands[0] !== "-"
				? current_project_path_to_app_file_node_path(currentProjectPath, resolve_path(commandCtx.cwd, operands[0]))
				: null;
		if (pattern != null && pattern.length > 0 && !recursive && !complexFlag && singleAppFileNodePath != null) {
			const fileArg = operands[0];
			if (GLOB_METACHARACTER_REGEX.test(fileArg)) {
				return {
					stdout: "",
					stderr: create_glob_syntax_unsupported_message("grep", fileArg),
					exitCode: COMMAND_EXIT_USAGE,
				};
			}
			const retryLiteral = grep_command_has_unescaped_regex_metacharacter(pattern)
				? grep_command_substring_only_retry_literal(pattern)
				: null;
			const regexWarning = grep_command_has_unescaped_regex_metacharacter(pattern)
				? `${GREP_SUBSTRING_ONLY_WARNING}${retryLiteral == null ? "" : `Try: grep ${shell_arg_quote(retryLiteral)} ${shell_arg_quote(fileArg)}\n`}`
				: "";

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
					path: singleAppFileNodePath,
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
				path: singleAppFileNodePath,
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
				const haystack = ignoreCase ? lines[index].toLowerCase() : lines[index];
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

		if (
			pattern != null &&
			pattern.length > 0 &&
			recursive &&
			!complexFlag &&
			!invert &&
			!countOnly &&
			!listOnly &&
			before === 0 &&
			after === 0 &&
			operands.length === 1 &&
			operands[0] !== "-" &&
			!GLOB_METACHARACTER_REGEX.test(operands[0])
		) {
			const folderArg = operands[0];
			const absoluteShellPath = resolve_path(commandCtx.cwd, folderArg);
			const appFileNodePath = current_project_path_to_app_file_node_path(currentProjectPath, absoluteShellPath);
			const entry = appFileNodePath ? await get_file_node_from_path(ctx, ctxData, appFileNodePath) : null;
			if (appFileNodePath != null && (appFileNodePath === "/" || entry?.kind === "folder")) {
				const res = (await ctx.runQuery(internal.files_nodes.text_search_files, {
					workspaceId: ctxData.workspaceId,
					projectId: ctxData.projectId,
					userId: ctxData.userId,
					query: pattern,
					numItems: 20,
					cursor: null,
					pathPrefix: appFileNodePath,
				})) as files_nodes_text_search_files_Result;
				const scopePath = app_file_node_path_to_current_project_path(currentProjectPath, appFileNodePath);
				// Same exact-query annotation as search: hyphenated single-token patterns get a
				// per-hit note saying whether the literal pattern appears in the shown chunk.
				const exactQueryFilter = search_command_exact_query_filter(pattern);
				const blocks =
					res.items.length > 0
						? [
								`grep -R over app folders uses indexed full-text search, not exact recursive regex grep.`,
								`Found ${res.items.length} results under ${scopePath}${search_command_exact_query_summary(
									exactQueryFilter,
									res.items.map((item) => item.markdownChunk),
								)}`,
								"",
								...res.items.map((item) =>
									[
										`${app_file_node_path_to_current_project_path(currentProjectPath, item.path)} (lines ${item.lineStart}-${item.lineEnd}, chars ${item.startIndex}-${item.endIndex}, chunk #${item.chunkIndex})${search_command_exact_query_note(exactQueryFilter, pattern, item.markdownChunk)}`,
										item.markdownChunk,
									].join("\n"),
								),
							]
						: [
								`No content matches found under ${scopePath}.`,
								`grep -R over app folders uses indexed full-text search, not exact recursive regex grep.`,
							];
				if (!res.isDone) {
					const cursorId = await cursor_id_create(ctx, res.continueCursor);
					blocks.push(
						"",
						search_command_build_continuation({
							currentProjectPath,
							path: appFileNodePath,
							limit: 20,
							cursor: cursorId,
							query: pattern,
						}),
					);
				}
				return {
					stdout: `${blocks.join("\n")}\n`,
					stderr: "",
					exitCode: 0,
				};
			}
		}

		if (pattern != null && pattern.length > 0 && singleAppFileNodePath != null && unsupportedFlag != null) {
			return {
				stdout: "",
				stderr:
					`grep: unsupported option ${unsupportedFlag} for app-file grep. ` +
					"Supported: grep [-i] PATTERN <file> with -c, -l, -v, and -A/-B/-C N. " +
					"Drop the flag, or use search for cross-file discovery.\n",
				exitCode: COMMAND_EXIT_USAGE,
			};
		}

		let suggestedCommand = pattern
			? `search --limit 20 ${shell_arg_quote(pattern)}`
			: "search --limit 20 <content-terms>";
		if (pattern) {
			const firstAppOperand = operands.find((operand) => {
				if (operand === "-" || GLOB_METACHARACTER_REGEX.test(operand)) return false;
				return (
					current_project_path_to_app_file_node_path(currentProjectPath, resolve_path(commandCtx.cwd, operand)) != null
				);
			});
			if (firstAppOperand != null) {
				const absoluteShellPath = resolve_path(commandCtx.cwd, firstAppOperand);
				const appFileNodePath = current_project_path_to_app_file_node_path(currentProjectPath, absoluteShellPath);
				const entry = appFileNodePath ? await get_file_node_from_path(ctx, ctxData, appFileNodePath) : null;
				if (appFileNodePath === "/" || entry?.kind === "folder") {
					suggestedCommand = `search --path ${shell_arg_quote(absoluteShellPath)} --limit 20 ${shell_arg_quote(pattern)}`;
				}
			}
		}
		return {
			stdout:
				[
					"grep over multiple/app-wide files is not supported; use search, or grep a single file.",
					"To search ALL files for content, use search with words that should appear in the document body:",
					`Try: ${suggestedCommand}`,
					"If the Try command matches the user's request, run it next before answering.",
					"IMPORTANT: search is full-text, not grep. Pass one distinctive word or a few plain terms; the text index splits on whitespace/punctuation, ignores case, relevance-ranks matches, and prefix-matches the final term.",
					"It is implemented with Convex full-text search, but it is not regex/glob/exact substring matching.",
					"To grep ONE file, pass exactly one app file path: grep [-i] PATTERN <file> (substring match, prints line numbers).",
					"To restrict search to a folder, cd there or use search --path <folder> <content terms>; broad scopes with common terms can be heavier.",
					"The search command returns matching file paths with snippets.",
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
	currentProjectPath: string,
	files: string[],
) {
	let appFileCount = 0;
	for (const file of files) {
		if (file === "-") continue;
		if (is_path_under_current_project_path(currentProjectPath, resolve_path(commandCtx.cwd, file))) {
			appFileCount++;
		}
	}
	if (appFileCount > READER_FILE_OPERAND_MAX) {
		return {
			stdout: "",
			stderr:
				`${command}: app file reads are limited to ${READER_FILE_OPERAND_MAX} files per command (you requested ${appFileCount}). ` +
				`This is a per-command batch limit, not a total ceiling: to READ these files, ${command} them in batches of ${READER_FILE_OPERAND_MAX} or fewer across multiple commands. ` +
				`To FIND which files mention something, use search (it returns matching snippets, not whole files).\n`,
			exitCode: COMMAND_EXIT_USAGE,
		};
	}
	return null;
}

/** Byte size of an app file via stat metadata, or null when unknown (e.g. unmaterialized). */
async function get_app_file_byte_size(ctx: ActionCtx, ctxData: WorkspaceFsOptions["ctxData"], appFileNodePath: string) {
	// Pending-aware: the agent's own unsaved write_file/edit_file content lives in
	// files_pending_updates, so the reader gate must size on what's actually served, not the
	// committed asset (which `stat` reports). Otherwise the gate decision and the byte count in
	// the oversize footer disagree with `cat`.
	const served = (await ctx.runQuery(internal.files_nodes.get_bash_served_byte_size, {
		workspaceId: ctxData.workspaceId,
		projectId: ctxData.projectId,
		userId: ctxData.userId,
		path: appFileNodePath,
	})) as files_nodes_get_bash_served_byte_size_Result;
	return served ? served.servedBytes : null;
}

function build_unreadable_file_advisory(
	currentProjectPath: string,
	normalizedPath: string,
	contentType: string | undefined,
) {
	const shellPath = app_file_node_path_to_current_project_path(currentProjectPath, normalizedPath);
	const lastSlashIndex = normalizedPath.lastIndexOf("/");
	const lastDotIndex = normalizedPath.lastIndexOf(".");
	const appFileNodePathWithoutExtension =
		lastDotIndex > lastSlashIndex ? normalizedPath.slice(0, lastDotIndex) : normalizedPath;
	const relatedReadablePaths = Array.from(
		new Set([
			app_file_node_path_to_current_project_path(currentProjectPath, `${normalizedPath}.md`),
			app_file_node_path_to_current_project_path(currentProjectPath, `${appFileNodePathWithoutExtension}.md`),
			app_file_node_path_to_current_project_path(currentProjectPath, `${appFileNodePathWithoutExtension}.txt`),
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

function cat_command_create(ctx: ActionCtx, ctxData: WorkspaceFsOptions["ctxData"], currentProjectPath: string) {
	return defineCommand("cat", async (args, commandCtx) => {
		let showLineNumbers = false;
		const files: string[] = [];
		for (const arg of args) {
			if (arg === "--help") {
				return await delegate_builtin_command({ command: "cat", args, commandCtx });
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
		const capError = enforce_reader_operand_cap("cat", commandCtx, currentProjectPath, targets);
		if (capError != null) return capError;

		// Multi-file cat can't safely page a large member: a bounded preview spliced into the
		// concatenation would silently drop the rest of that file (and corrupt any downstream pipe).
		// Refuse up front and point at reading the large file on its own.
		if (targets.length > 1) {
			for (const file of targets) {
				if (file === "-" || GLOB_METACHARACTER_REGEX.test(file)) continue;
				const appFileNodePath = current_project_path_to_app_file_node_path(
					currentProjectPath,
					resolve_path(commandCtx.cwd, file),
				);
				if (appFileNodePath == null) continue;
				const size = await get_app_file_byte_size(ctx, ctxData, appFileNodePath);
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
				const numbered = cat_command_add_line_numbers(content, lineNumber);
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
					stderr: create_glob_syntax_unsupported_message("cat", file),
					exitCode: COMMAND_EXIT_USAGE,
				};
			}
			const resolvedPath = resolve_path(commandCtx.cwd, file);
			const appFileNodePath = current_project_path_to_app_file_node_path(currentProjectPath, resolvedPath);
			// Large app file: don't dump it whole (and don't refuse) — show a bounded first page
			// plus a footer telling the agent how to read the rest.
			if (appFileNodePath != null) {
				const size = await get_app_file_byte_size(ctx, ctxData, appFileNodePath);
				if (size != null && size > READ_INLINE_MAX_BYTES) {
					const resolvedAppShellPath = app_file_node_path_to_current_project_path(currentProjectPath, appFileNodePath);
					const page = (await ctx.runAction(internal.files_nodes.read_file_line_range, {
						workspaceId: ctxData.workspaceId,
						projectId: ctxData.projectId,
						userId: ctxData.userId,
						path: appFileNodePath,
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
							currentProjectPath,
							current_project_path_to_app_file_node_path(currentProjectPath, error.shellPath) ?? file,
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

function cat_command_add_line_numbers(content: string, startLine: number) {
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

function stat_command_parse_args(args: string[]) {
	let format: string | null = null;
	const files: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
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

function stat_command_format_mode(mode: number, isDirectory: boolean) {
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

function stat_command_render_output(
	format: string | null,
	file: string,
	stat: { isDirectory: boolean; mode: number; size: number | undefined; mtime: Date },
) {
	const modeOctal = stat.mode.toString(8);
	const modeStr = stat_command_format_mode(stat.mode, stat.isDirectory);
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

function stat_command_create(ctx: ActionCtx, ctxData: WorkspaceFsOptions["ctxData"], currentProjectPath: string) {
	return defineCommand("stat", async (args, commandCtx) => {
		const parsedResult = stat_command_parse_args(args);
		if (parsedResult._nay) {
			return {
				stdout: "",
				stderr: `${parsedResult._nay.message}\n`,
				exitCode: COMMAND_EXIT_USAGE,
			};
		}
		if ("delegate" in parsedResult._yay) {
			return await delegate_builtin_command({ command: "stat", args, commandCtx });
		}

		const capError = enforce_reader_operand_cap("stat", commandCtx, currentProjectPath, parsedResult._yay.files);
		if (capError != null) return capError;

		let stdout = "";
		let stderr = "";
		let hasError = false;
		for (const file of parsedResult._yay.files) {
			if (GLOB_METACHARACTER_REGEX.test(file)) {
				stderr += create_glob_syntax_unsupported_message("stat", file);
				hasError = true;
				continue;
			}
			const resolvedPath = resolve_path(commandCtx.cwd, file);
			const appFileNodePath = current_project_path_to_app_file_node_path(currentProjectPath, resolvedPath);
			try {
				if (appFileNodePath == null) {
					const stat = await commandCtx.fs.stat(resolvedPath);
					stdout += stat_command_render_output(parsedResult._yay.format, file, stat);
					continue;
				}
				const entry = (await ctx.runQuery(internal.files_nodes.get_bash_stat_entry, {
					workspaceId: ctxData.workspaceId,
					projectId: ctxData.projectId,
					path: appFileNodePath,
				})) as files_nodes_get_bash_stat_entry_Result;
				if (!entry) {
					throw new Error("missing");
				}
				stdout += stat_command_render_output(parsedResult._yay.format, file, {
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

function stream_utility_command_create_all(currentProjectPath: string) {
	return [
		native_just_bash_tmp_command_create("sort", currentProjectPath),
		native_just_bash_tmp_command_create("uniq", currentProjectPath),
		native_just_bash_tmp_command_create("cut", currentProjectPath),
		native_just_bash_tmp_command_create("awk", currentProjectPath),
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
function sed_command_create(ctx: ActionCtx, ctxData: WorkspaceFsOptions["ctxData"], currentProjectPath: string) {
	return defineCommand("sed", async (args, commandCtx) => {
		if (args.includes("-n")) {
			const nonFlags = args.filter((arg) => !arg.startsWith("-"));
			const rangeMatch = nonFlags.length === 2 ? /^(\d+)(?:,(\d+))?p$/u.exec(nonFlags[0]) : null;
			if (rangeMatch) {
				const fileArg = nonFlags[1];
				const appFileNodePath = current_project_path_to_app_file_node_path(
					currentProjectPath,
					resolve_path(commandCtx.cwd, fileArg),
				);
				if (appFileNodePath != null) {
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
						path: appFileNodePath,
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
							`More lines below. Next page: sed -n '${endLine + 1},${endLine + maxLines}p' ${shell_arg_quote(app_file_node_path_to_current_project_path(currentProjectPath, appFileNodePath))}`,
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

		return await delegate_native_just_bash_tmp_command("sed", args, commandCtx, currentProjectPath);
	});
}

// #endregion sed command

// #region head tail wc commands

function reader_command_parse_line_count(value: string | undefined) {
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
async function reader_command_find_oversized_app_operand(
	ctx: ActionCtx,
	ctxData: WorkspaceFsOptions["ctxData"],
	commandCtx: CommandContext,
	currentProjectPath: string,
	files: string[],
) {
	for (const file of files) {
		if (file === "-") continue;
		const appFileNodePath = current_project_path_to_app_file_node_path(
			currentProjectPath,
			resolve_path(commandCtx.cwd, file),
		);
		if (appFileNodePath == null) continue;
		const size = await get_app_file_byte_size(ctx, ctxData, appFileNodePath);
		if (size != null && size > READ_INLINE_MAX_BYTES) {
			return { file, appFileNodePath, size } as const;
		}
	}
	return null;
}

function reader_command_create(
	ctx: ActionCtx,
	ctxData: WorkspaceFsOptions["ctxData"],
	command: "head" | "tail" | "wc",
	currentProjectPath: string,
) {
	return defineCommand(command, async (args, commandCtx) => {
		const files: string[] = [];
		let headLineCount: number | null = null;
		let headFromStart = false;
		let byteMode = false;
		const wcFlags = { lines: false, words: false, chars: false, bytes: false };
		for (let index = 0; index < args.length; index++) {
			const arg = args[index];
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
					const parsed = reader_command_parse_line_count(args[++index]);
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
					const parsed = reader_command_parse_line_count(arg.slice("--lines=".length));
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
					const parsed = reader_command_parse_line_count(arg.slice(2));
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
				is_path_under_current_project_path(currentProjectPath, resolve_path(commandCtx.cwd, file))
			) {
				return {
					stdout: "",
					stderr: create_glob_syntax_unsupported_message(command, file),
					exitCode: COMMAND_EXIT_USAGE,
				};
			}
		}
		const capError = enforce_reader_operand_cap(command, commandCtx, currentProjectPath, files);
		if (capError != null) return capError;

		// Multi-file wc across app files: serve per-file + total counts from the bounded stats
		// path (committed chunks are exact; oversized files yield windowed lower bounds) so a batch
		// never triggers a full read per file. Mixed/real-fs/stdin batches fall through to the builtin.
		if (
			command === "wc" &&
			files.length >= 2 &&
			files.every(
				(file) =>
					file !== "-" &&
					current_project_path_to_app_file_node_path(currentProjectPath, resolve_path(commandCtx.cwd, file)) != null,
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
				const appFileNodePath = current_project_path_to_app_file_node_path(
					currentProjectPath,
					resolve_path(commandCtx.cwd, file),
				);
				if (appFileNodePath == null) {
					// Unreachable: the surrounding branch requires every operand to resolve to an app file path.
					throw should_never_happen("wc: operand stopped resolving to an app file path", { file });
				}
				const stats = (await ctx.runAction(internal.files_nodes.read_file_content_stats, {
					workspaceId: ctxData.workspaceId,
					projectId: ctxData.projectId,
					userId: ctxData.userId,
					path: appFileNodePath,
				})) as files_nodes_read_file_content_stats_Result;
				if (!stats) {
					const entry = await get_file_node_from_path(ctx, ctxData, appFileNodePath);
					if (entry?.kind === "file") {
						stderr += build_unreadable_file_advisory(currentProjectPath, appFileNodePath, entry.contentType);
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
		const oversized = await reader_command_find_oversized_app_operand(
			ctx,
			ctxData,
			commandCtx,
			currentProjectPath,
			files,
		);
		if (oversized != null) {
			const appOperandCount = files.filter(
				(file) =>
					file !== "-" &&
					current_project_path_to_app_file_node_path(currentProjectPath, resolve_path(commandCtx.cwd, file)) != null,
			).length;

			// Large files are read in bounded pages. head/tail map to bounded line reads; a
			// single file operand is required so the page output is unambiguous.
			if ((command === "head" || command === "tail") && byteMode && appOperandCount === 1) {
				return {
					stdout: "",
					stderr: `${command}: byte-range reads (-c) are not supported for large app files; use ${command} -n N (lines) or wc -c ${shell_arg_quote(app_file_node_path_to_current_project_path(currentProjectPath, oversized.appFileNodePath))} for the byte count.\n`,
					exitCode: COMMAND_EXIT_FAILURE,
				};
			}
			if ((command === "head" || command === "tail") && !byteMode && appOperandCount === 1) {
				const oversizedAppShellPath = app_file_node_path_to_current_project_path(
					currentProjectPath,
					oversized.appFileNodePath,
				);
				// `tail -n +K`: output from line K onward — a forward read at an offset, not a trailing
				// window. Serve it from the same bounded forward reader head uses (paged via sed).
				if (command === "tail" && headFromStart && headLineCount != null) {
					const startLine = Math.max(1, headLineCount);
					const maxLines = READ_HEAD_LARGE_FILE_MAX_LINES;
					const result = (await ctx.runAction(internal.files_nodes.read_file_line_range, {
						workspaceId: ctxData.workspaceId,
						projectId: ctxData.projectId,
						userId: ctxData.userId,
						path: oversized.appFileNodePath,
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
						path: oversized.appFileNodePath,
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
						// Point the agent at the next page via sed line ranges (plain bash paging).
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
					path: oversized.appFileNodePath,
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
					path: oversized.appFileNodePath,
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
			const appFileNodePath = current_project_path_to_app_file_node_path(currentProjectPath, resolvedPath);
			if (appFileNodePath == null) continue;
			try {
				await commandCtx.fs.readFile(resolvedPath);
			} catch (error) {
				if (error instanceof AppFileContentUnavailableError) {
					return {
						stdout: build_unreadable_file_advisory(currentProjectPath, appFileNodePath, error.contentType),
						stderr: "",
						exitCode: 0,
					};
				}
			}
		}
		try {
			return await delegate_builtin_command({ command, args, commandCtx });
		} catch (error) {
			if (error instanceof AppFileContentUnavailableError) {
				return {
					stdout: build_unreadable_file_advisory(
						currentProjectPath,
						current_project_path_to_app_file_node_path(currentProjectPath, error.shellPath) ?? error.shellPath,
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

function touch_command_create(currentProjectPath: string) {
	return defineCommand("touch", async (args, commandCtx) => {
		const files: string[] = [];
		for (let index = 0; index < args.length; index++) {
			const arg = args[index];
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
			if (is_path_under_current_project_path(currentProjectPath, resolvedPath)) {
				const appFileNodePath = current_project_path_to_app_file_node_path(currentProjectPath, resolvedPath) ?? file;
				return {
					stdout: "",
					stderr:
						`touch: cannot create or update app file '${file}' through bash.\n` +
						`Use write_file with path '${appFileNodePath}' to create a new file (strip the current project path prefix '${currentProjectPath}' from the bash path).\n` +
						`Use edit_file with path '${appFileNodePath}' to update an existing file.\n`,
					exitCode: COMMAND_EXIT_FAILURE,
				};
			}
		}
		return await delegate_builtin_command({ command: "touch", args, commandCtx });
	});
}

// #endregion touch command

// #region rm command

function rm_command_create(currentProjectPath: string) {
	return defineCommand("rm", async (args, commandCtx) => {
		for (const arg of args) {
			if (arg.startsWith("-")) continue;
			const resolvedPath = resolve_path(commandCtx.cwd, arg);
			if (is_path_under_current_project_path(currentProjectPath, resolvedPath)) {
				return {
					stdout: "",
					stderr:
						`rm: cannot delete app file '${arg}' through bash.\n` +
						`App files cannot be deleted via shell commands. Use the Files sidebar Archive action for '${arg}', or use write_file/edit_file for content changes.\n`,
					exitCode: COMMAND_EXIT_FAILURE,
				};
			}
		}
		return await delegate_builtin_command({ command: "rm", args, commandCtx });
	});
}

// #endregion rm command

function cp_mv_command_parse_operands(args: string[]) {
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
function cp_command_is_under_tmp_mount(path: string) {
	return path === TMP_MOUNT || path.startsWith(`${TMP_MOUNT}/`);
}

function cp_command_create(currentProjectPath: string) {
	return defineCommand("cp", async (args, commandCtx) => {
		const { operands, recursive } = cp_mv_command_parse_operands(args);
		const appOperands = operands.filter((operand) =>
			is_path_under_current_project_path(currentProjectPath, resolve_path(commandCtx.cwd, operand)),
		);
		if (appOperands.length === 0) {
			return await delegate_builtin_command({ command: "cp", args, commandCtx });
		}
		for (const operand of appOperands) {
			if (GLOB_METACHARACTER_REGEX.test(operand)) {
				return {
					stdout: "",
					stderr: create_glob_syntax_unsupported_message("cp", operand),
					exitCode: COMMAND_EXIT_USAGE,
				};
			}
		}
		// Writing INTO the app tree (any -> app destination) is read-only for cp; route
		// straight to write_file so the model does not retry cp.
		if (
			operands.length === 2 &&
			is_path_under_current_project_path(currentProjectPath, resolve_path(commandCtx.cwd, operands[1]))
		) {
			const destAppFileNodePath =
				current_project_path_to_app_file_node_path(currentProjectPath, resolve_path(commandCtx.cwd, operands[1])) ??
				operands[1];
			return {
				stdout: "",
				stderr:
					`cp: cannot write to app file '${operands[1]}': the app file tree is read-only for cp.\n` +
					`To create a durable copy at '${destAppFileNodePath}', use write_file with path '${destAppFileNodePath}' and the content read from the source.\n` +
					`cp into the app tree is never supported; only cp <app-file> /tmp/<name> (scratch copy) is allowed.\n`,
				exitCode: COMMAND_EXIT_FAILURE,
			};
		}
		if (recursive || operands.length !== 2 || appOperands.length !== 1 || appOperands[0] !== operands[0]) {
			return {
				stdout: "",
				stderr:
					"cp: app files can only be copied as one exact readable file to a /tmp destination.\n" +
					"Usage: cp <app-file> /tmp/<name> - copies the file content to durable per-thread /tmp scratch space.\n" +
					"To duplicate an app file as a new durable file, use write_file with the new app file path (strip the current project path prefix).\n",
				exitCode: COMMAND_EXIT_FAILURE,
			};
		}

		const sourceShellPath = resolve_path(commandCtx.cwd, operands[0]);
		const destShellPath = resolve_path(commandCtx.cwd, operands[1]);
		if (!cp_command_is_under_tmp_mount(destShellPath)) {
			const destAppFileNodePath = current_project_path_to_app_file_node_path(currentProjectPath, destShellPath);
			const destHint =
				destAppFileNodePath != null
					? `To create a durable copy at '${destAppFileNodePath}', use write_file with path '${destAppFileNodePath}' and the content read from the source.`
					: "Durable app file writes require write_file, not cp.";
			return {
				stdout: "",
				stderr:
					`cp: cannot write to '${operands[1]}': app file tree is read-only for cp.\n` +
					`Only /tmp destinations are supported: cp ${shell_arg_quote(operands[0])} /tmp/<name>\n` +
					`${destHint}\n`,
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

function mv_command_create(currentProjectPath: string) {
	return defineCommand("mv", async (args, commandCtx) => {
		const { operands } = cp_mv_command_parse_operands(args);
		// Identify source and destination for better guidance
		const srcOperand = operands[0];
		const destOperand = operands[1];
		for (const operand of operands) {
			const resolvedPath = resolve_path(commandCtx.cwd, operand);
			if (is_path_under_current_project_path(currentProjectPath, resolvedPath)) {
				const srcAppFileNodePath =
					srcOperand != null
						? (current_project_path_to_app_file_node_path(
								currentProjectPath,
								resolve_path(commandCtx.cwd, srcOperand),
							) ?? srcOperand)
						: null;
				const destAppFileNodePath =
					destOperand != null
						? (current_project_path_to_app_file_node_path(
								currentProjectPath,
								resolve_path(commandCtx.cwd, destOperand),
							) ?? destOperand)
						: null;
				const renameHint =
					srcAppFileNodePath != null && destAppFileNodePath != null
						? `To rename/move an app file, use the Files sidebar rename/move UI. For content changes, use write_file with path '${destAppFileNodePath}' or edit_file on '${srcAppFileNodePath}'.`
						: "To rename/move an app file, use the Files sidebar rename/move UI. For content changes, use write_file or edit_file.";
				return {
					stdout: "",
					stderr: `mv: cannot move or rename app files through bash.\n` + `${renameHint}\n`,
					exitCode: COMMAND_EXIT_FAILURE,
				};
			}
		}
		return await delegate_builtin_command({ command: "mv", args, commandCtx });
	});
}

// #endregion mv command

// #region tee command

function tee_command_create(currentProjectPath: string) {
	return defineCommand("tee", async (args, commandCtx) => {
		const files = args.filter((arg) => !arg.startsWith("-"));
		for (const file of files) {
			const resolvedPath = resolve_path(commandCtx.cwd, file);
			if (is_path_under_current_project_path(currentProjectPath, resolvedPath)) {
				const appFileNodePath = current_project_path_to_app_file_node_path(currentProjectPath, resolvedPath) ?? file;
				return {
					stdout: commandCtx.stdin as unknown as string,
					stderr:
						`tee: cannot write to app file '${file}' through bash.\n` +
						`Use write_file with path '${appFileNodePath}' to write new content (strip the current project path prefix '${currentProjectPath}').\n` +
						`Use edit_file with path '${appFileNodePath}' to apply targeted edits to an existing file.\n`,
					exitCode: 1,
				};
			}
		}
		return await delegate_builtin_command({ command: "tee", args, commandCtx });
	});
}

// #endregion tee command

// #region nested shell commands

function nested_shell_command_create(name: "bash" | "sh", currentProjectPath: string) {
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
		const scriptPath = resolve_path(commandCtx.cwd, args[0]);
		if (is_path_under_current_project_path(currentProjectPath, scriptPath)) {
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

function xargs_command_create() {
	return defineCommand("xargs", async (args, commandCtx) => {
		let replaceString: string | null = null;
		let delimiter: string | null = null;
		let maxArgs: number | null = null;
		let nullSeparated = false;
		let verbose = false;
		let noRunIfEmpty = false;
		let commandStart = args.length;

		for (let index = 0; index < args.length; index++) {
			const arg = args[index];
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
			const result = await commandCtx.exec(shell_arg_quote(batch[0]), {
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

function which_command_create() {
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

// #region action

/**
 * Mount the app file tree into Just Bash as a mostly read-only filesystem.
 */
class WorkspaceFs implements IFileSystem {
	readonly ctx: ActionCtx;
	readonly ctxData: WorkspaceFsOptions["ctxData"];
	readonly currentProjectPath: string;
	readonly allowAppFileTreeMkdir: boolean;
	pathIndexTruncated = false;
	private entryCache = new Map<string, JustBashFileNodeCacheEntry>();
	private contentCache = new Map<string, string>();

	constructor(options: WorkspaceFsOptions) {
		this.ctx = options.ctx;
		this.ctxData = options.ctxData;
		this.currentProjectPath = options.currentProjectPath;
		this.allowAppFileTreeMkdir = options.allowAppFileTreeMkdir;
		this.rememberEntry(files_SYNTHETIC_ROOT_FOLDER);
	}

	async readFile(path: string, _options?: Parameters<IFileSystem["readFile"]>[1]) {
		const normalizedPath = normalize_path(path);
		if (GLOB_METACHARACTER_REGEX.test(normalizedPath)) {
			throw new Error(
				`app file glob patterns are not supported: '${app_file_node_path_to_current_project_path(this.currentProjectPath, normalizedPath)}'`,
			);
		}
		const cached = this.contentCache.get(normalizedPath);
		if (cached != null) {
			return cached;
		}

		const chunkRead = (await this.ctx.runQuery(internal.files_nodes.read_file_full_content_from_chunks, {
			workspaceId: this.ctxData.workspaceId,
			projectId: this.ctxData.projectId,
			userId: this.ctxData.userId,
			path: normalizedPath,
			maxBytes: READ_INLINE_MAX_BYTES,
		})) as files_nodes_read_file_full_content_from_chunks_Result;
		if (chunkRead) {
			this.contentCache.set(normalizedPath, chunkRead.content);
			this.rememberEntry(chunkRead.fileNode);
			return chunkRead.content;
		}

		// TODO: This can be optimized
		const fileContentPromise = this.ctx.runAction(
			internal.files_nodes.get_file_last_available_markdown_content_by_path,
			{
				workspaceId: this.ctxData.workspaceId,
				projectId: this.ctxData.projectId,
				userId: this.ctxData.userId,
				path: normalizedPath,
			},
		) as Promise<files_nodes_get_file_last_available_markdown_content_by_path_Result>;
		const nodePromise = get_file_node_from_path(this.ctx, this.ctxData, normalizedPath);
		const [fileContent, node] = await Promise.all([fileContentPromise, nodePromise]);

		if (!fileContent) {
			const entry = normalizedPath === "/" ? files_SYNTHETIC_ROOT_FOLDER : node;
			if (entry?.kind === "file") {
				this.rememberEntry(entry);
				throw new AppFileContentUnavailableError({
					shellPath: app_file_node_path_to_current_project_path(this.currentProjectPath, normalizedPath),
					contentType: entry.contentType,
				});
			}
			if (entry?.kind === "folder") {
				this.rememberEntry(entry);
				throw new Error(
					`EISDIR: illegal operation on a directory, read '${app_file_node_path_to_current_project_path(this.currentProjectPath, normalizedPath)}'`,
				);
			}
			throw new Error(
				`ENOENT: no such file or directory, open '${app_file_node_path_to_current_project_path(this.currentProjectPath, normalizedPath)}'`,
			);
		}

		this.contentCache.set(normalizedPath, fileContent.content);
		if (node?.kind === "file") {
			this.rememberEntry(node);
		} else {
			this.rememberEntry({
				_id: fileContent.nodeId,
				path: normalizedPath,
				name: path_name_of(normalizedPath),
				kind: "file",
				updatedAt: Date.now(),
			});
		}
		return fileContent.content;
	}

	async readFileBuffer(path: string) {
		return textEncoder.encode(await this.readFile(path));
	}

	async writeFile(path: string, _content: FileContent, _options?: Parameters<IFileSystem["writeFile"]>[2]) {
		throw new ReadOnlyFileSystemError(app_file_node_path_to_current_project_path(this.currentProjectPath, path));
	}

	async appendFile(path: string, _content: FileContent, _options?: Parameters<IFileSystem["appendFile"]>[2]) {
		throw new ReadOnlyFileSystemError(app_file_node_path_to_current_project_path(this.currentProjectPath, path));
	}

	async exists(path: string) {
		return (await this.getEntry(path)) != null;
	}

	async stat(path: string): Promise<FsStat> {
		const normalizedPath = normalize_path(path);
		if (GLOB_METACHARACTER_REGEX.test(normalizedPath)) {
			throw new Error(
				`app file glob patterns are not supported: '${app_file_node_path_to_current_project_path(this.currentProjectPath, normalizedPath)}'`,
			);
		}
		const entry = await this.getEntry(normalizedPath);
		if (!entry) {
			throw new Error(
				`ENOENT: no such file or directory, stat '${app_file_node_path_to_current_project_path(this.currentProjectPath, normalizedPath)}'`,
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
				`app file glob patterns are not supported: '${app_file_node_path_to_current_project_path(this.currentProjectPath, normalizedPath)}'`,
			);
		}
		const existing = await this.getEntry(normalizedPath);
		if (existing) {
			if (options?.recursive && existing.kind === "folder") {
				return;
			}
			throw new Error(
				`EEXIST: file already exists, mkdir '${app_file_node_path_to_current_project_path(this.currentProjectPath, normalizedPath)}'`,
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
					`ENOENT: no such file or directory, mkdir '${app_file_node_path_to_current_project_path(this.currentProjectPath, normalizedPath)}'`,
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
			_id: created._yay.nodeId,
			path: normalizedPath,
			name: path_name_of(normalizedPath),
			kind: "folder",
			updatedAt: Date.now(),
			contentType: undefined,
			updatedBy: this.ctxData.userId,
		});
	}

	async readdir(path: string): Promise<string[]> {
		const normalizedPath = normalize_path(path);
		const stat = await this.stat(normalizedPath);
		if (!stat.isDirectory) {
			throw new Error(
				`ENOTDIR: not a directory, scandir '${app_file_node_path_to_current_project_path(this.currentProjectPath, normalizedPath)}'`,
			);
		}
		throw new Error("app file directory enumeration is not supported; use ls --limit N or find --limit N");
	}

	async rm(path: string, options?: RmOptions) {
		if (options?.force && !(await this.exists(path))) {
			return;
		}
		throw new ReadOnlyFileSystemError(app_file_node_path_to_current_project_path(this.currentProjectPath, path));
	}

	async cp(_src: string, dest: string, _options?: CpOptions) {
		throw new ReadOnlyFileSystemError(app_file_node_path_to_current_project_path(this.currentProjectPath, dest));
	}

	async mv(_src: string, dest: string) {
		throw new ReadOnlyFileSystemError(app_file_node_path_to_current_project_path(this.currentProjectPath, dest));
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
		throw new ReadOnlyFileSystemError(app_file_node_path_to_current_project_path(this.currentProjectPath, path));
	}

	async symlink(_target: string, linkPath: string) {
		throw new ReadOnlyFileSystemError(app_file_node_path_to_current_project_path(this.currentProjectPath, linkPath));
	}

	async link(_existingPath: string, newPath: string) {
		throw new ReadOnlyFileSystemError(app_file_node_path_to_current_project_path(this.currentProjectPath, newPath));
	}

	async readlink(path: string): Promise<string> {
		throw new Error(
			`EINVAL: invalid argument, readlink '${app_file_node_path_to_current_project_path(this.currentProjectPath, path)}'`,
		);
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
		throw new ReadOnlyFileSystemError(app_file_node_path_to_current_project_path(this.currentProjectPath, path));
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
					name: segments[index],
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
		if (cached && (normalizedPath === "/" || cached._id != null)) {
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
			_id: node._id,
			path: node.path,
			name: node.name,
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
		if (normalize_path(path) === "/dev/null") {
			return "";
		}
		throw new Error(`ENOENT: no such file or directory, open '${normalize_path(path)}'`);
	}

	async readFileBuffer(path: string): Promise<Uint8Array> {
		if (normalize_path(path) === "/dev/null") {
			return new Uint8Array();
		}
		throw new Error(`ENOENT: no such file or directory, open '${normalize_path(path)}'`);
	}

	async writeFile(path: string, _content: FileContent, _options?: Parameters<IFileSystem["writeFile"]>[2]) {
		if (normalize_path(path) === "/dev/null") {
			return;
		}
		throw new ReadOnlyFileSystemError(path);
	}

	async appendFile(path: string, _content: FileContent, _options?: Parameters<IFileSystem["appendFile"]>[2]) {
		if (normalize_path(path) === "/dev/null") {
			return;
		}
		throw new ReadOnlyFileSystemError(path);
	}

	async exists(path: string) {
		const normalizedPath = normalize_path(path);
		return normalizedPath === "/" || normalizedPath === "/dev/null";
	}

	async stat(path: string): Promise<FsStat> {
		const normalizedPath = normalize_path(path);
		if (normalizedPath === "/dev/null") {
			return {
				isFile: true,
				isDirectory: false,
				isSymbolicLink: false,
				mode: 0o666,
				size: 0,
				mtime: new Date(),
			};
		}
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

const action_run_args_validator = v.object({
	workspaceId: v.string(),
	projectId: v.string(),
	workspaceName: v.string(),
	projectName: v.string(),
	userId: v.id("users"),
	threadId: v.id("ai_chat_threads"),
	command: v.string(),
	allowAppFileTreeMkdir: v.boolean(),
});

async function action_run(ctx: ActionCtx, args: Infer<typeof action_run_args_validator>) {
	const threadState = (await ctx.runQuery(internal.ai_chat.get_thread_state, {
		workspaceId: args.workspaceId,
		projectId: args.projectId,
		threadId: args.threadId,
	})) as ai_chat_get_thread_state_Result;

	// Workspace and project names are validated slugs, so they are stable shell
	// path segments and do not need path-segment encoding here.
	const currentProjectPath = `${APP_MOUNT_PATH}/${args.workspaceName}/${args.projectName}`;

	const tmpFs = await BashTmpFs.create(ctx, args.threadId);

	const workspaceFs = new WorkspaceFs({
		ctx,
		ctxData: {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			workspaceName: args.workspaceName,
			projectName: args.projectName,
			userId: args.userId,
		},
		currentProjectPath,
		allowAppFileTreeMkdir: args.allowAppFileTreeMkdir,
	});

	const fs = new MountableFs({
		base: new ReadOnlyBaseFs(),
		mounts: [
			{ mountPoint: currentProjectPath, filesystem: workspaceFs },
			{ mountPoint: TMP_MOUNT, filesystem: tmpFs },
		],
	});

	// The persisted cwd can vanish between runs (deleted folder, pruned /tmp).
	const cwd =
		(await nearest_existing_dir(fs, threadState.bashCwd === DEFAULT_CWD ? currentProjectPath : threadState.bashCwd)) ??
		currentProjectPath;

	const bash = new Bash({
		fs,
		cwd,
		env: {
			HOME,
		},
		commands: ALLOWED_COMMANDS,
		customCommands: [
			search_command_create(ctx, workspaceFs.ctxData, currentProjectPath),
			ls_command_create(ctx, workspaceFs, currentProjectPath),
			find_command_create(ctx, workspaceFs.ctxData, currentProjectPath),
			tree_command_create(ctx, workspaceFs.ctxData, currentProjectPath),
			grep_command_create(ctx, workspaceFs.ctxData, currentProjectPath),
			cat_command_create(ctx, workspaceFs.ctxData, currentProjectPath),
			reader_command_create(ctx, workspaceFs.ctxData, "head", currentProjectPath),
			reader_command_create(ctx, workspaceFs.ctxData, "tail", currentProjectPath),
			reader_command_create(ctx, workspaceFs.ctxData, "wc", currentProjectPath),
			stat_command_create(ctx, workspaceFs.ctxData, currentProjectPath),
			...stream_utility_command_create_all(currentProjectPath),
			sed_command_create(ctx, workspaceFs.ctxData, currentProjectPath),
			touch_command_create(currentProjectPath),
			rm_command_create(currentProjectPath),
			cp_command_create(currentProjectPath),
			mv_command_create(currentProjectPath),
			tee_command_create(currentProjectPath),
			nested_shell_command_create("bash", currentProjectPath),
			nested_shell_command_create("sh", currentProjectPath),
			xargs_command_create(),
			which_command_create(),
			...native_just_bash_tmp_command_create_all(currentProjectPath),
		],
		executionLimits: {
			maxCommandCount: 200,
			maxLoopIterations: 10_000,
			maxCallDepth: 50,
			maxOutputSize: 250_000,
			maxHeredocSize: 250_000,
		},
	});

	const result = await bash.exec(`set -f\n${args.command}`).catch((error: unknown) => ({
		stdout: "",
		stderr: `${error instanceof Error ? error.message : String(error)}\n`,
		exitCode: 1,
		env: {
			PWD: cwd,
		},
	}));

	// PWD is an ordinary shell variable; a command can unset or empty it, in
	// which case we assume the shell did not move.
	const rawNextCwd = result.env.PWD || cwd;
	// A command can delete its own cwd; climb to the nearest surviving directory.
	let nextCwd = (await nearest_existing_dir(fs, rawNextCwd)) ?? currentProjectPath;
	const redirectsStderrToStdout = REDIRECTS_STDERR_TO_STDOUT_REGEX.test(args.command);

	if (
		COMMAND_NOT_FOUND_REGEX.test(result.stderr) ||
		(redirectsStderrToStdout && COMMAND_NOT_FOUND_REGEX.test(result.stdout))
	) {
		result.stderr +=
			"bash: run 'help' to list available commands; app files are DB-backed — use search/grep for content and find/ls for paths.\n";
		const filePathMatch = /(?:^|[\s;&|])file\s+([^\s;&|]+)/u.exec(args.command);
		if (filePathMatch?.[1] != null) {
			const target = shell_arg_quote(filePathMatch[1]);
			result.stderr += `bash: the Unix file command is intentionally unavailable. Try: stat ${target} && wc -c ${target} && head -n 5 ${target}\n`;
		}
	}

	if (
		args.command.includes("pipefail") &&
		(SET_INVALID_OPTION_REGEX.test(result.stderr) ||
			(redirectsStderrToStdout && SET_INVALID_OPTION_REGEX.test(result.stdout)))
	) {
		result.stderr += "bash: `set -euo pipefail` is unsupported; retry without strict-mode boilerplate.\n";
	}

	// Only paths under HOME and `/tmp` survive between runs (`/tmp` is restored
	// from the DB; everything else is synthetic mount scaffolding).
	if (
		nextCwd !== HOME &&
		!nextCwd.startsWith(`${HOME}/`) &&
		nextCwd !== TMP_MOUNT &&
		!nextCwd.startsWith(`${TMP_MOUNT}/`)
	) {
		console.warn("Bash cwd is not persistable, resetting to the project root", {
			threadId: args.threadId,
			cwd: rawNextCwd,
		});
		nextCwd = currentProjectPath;
	}

	// `/tmp` persists to the DB, so bound its durable footprint before flushing:
	// discard files over the per-file cap, then evict the oldest leaves (files,
	// symlinks, and empty directories, by mtime then path) until both thread
	// caps are satisfied — this call's writes have fresh mtimes and survive.
	// Deletions go through `tmpFs.rm` so they mark the fs dirty and reach the DB.
	result.stderr += await tmp_fs_evict_to_limits(tmpFs);

	const pendingMutations: Promise<unknown>[] = [];

	if (tmpFs.dirty) {
		const patch = await tmp_fs_delta_payload(tmpFs);
		pendingMutations.push(
			ctx.runMutation(internal.ai_chat_files.patch_thread_tmp_files, {
				workspaceId: args.workspaceId,
				projectId: args.projectId,
				threadId: args.threadId,
				fileNodes: patch.fileNodes,
				fileNodesContentDict: patch.fileNodesContentDict,
				deletePaths: patch.deletePaths,
			}),
		);
		tmpFs.dirty = false;
	}

	const stdoutLength = result.stdout.length;
	const stderrLength = result.stderr.length;
	const stdout = truncate_output(result.stdout);
	const truncatedStderr = truncate_output(result.stderr);

	const threadStateUpdated = nextCwd !== threadState.bashCwd;
	if (threadStateUpdated) {
		pendingMutations.push(
			ctx.runMutation(internal.ai_chat.set_thread_state, {
				workspaceId: args.workspaceId,
				projectId: args.projectId,
				threadId: args.threadId,
				userId: args.userId,
				patch: {
					bashCwd: nextCwd,
				},
			}),
		);
	}

	await Promise.all(pendingMutations);

	console.debug("Bash command completed", {
		threadId: args.threadId,
		commandName: args.command.trim().split(/\s+/u, 1)[0] ?? "",
		exitCode: result.exitCode,
		stdoutLength,
		stderrLength,
		threadStateUpdated,
		pathIndexTruncated: workspaceFs.pathIndexTruncated,
	});

	return {
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

export const run = internalAction({
	args: action_run_args_validator,
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
	handler: action_run,
});

// #endregion action

// Vitest sets NODE_ENV to "test"; Convex's bundler defines it as "production",
// so keep that check first to let esbuild erase `import.meta.vitest` before analysis.
if (process.env.NODE_ENV === "test" && import.meta.vitest) {
	const { describe, test, expect, vi, beforeEach, afterEach } = import.meta.vitest;

	const test_app_files_mount = "/home/cloud-usr/w/personal/home";
	const function_name_of = (ref: unknown) => {
		try {
			return getFunctionName(ref as Parameters<typeof getFunctionName>[0]);
		} catch {
			return null;
		}
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

	describe("tmp_fs_evict_to_limits", () => {
		const set_mtime = async (tmpFs: BashTmpFs, path: string, mtime: number) => {
			const date = new Date(mtime);
			await tmpFs.utimes(path, date, date);
		};

		test("discards oversized files before applying session caps", async () => {
			const tmpFs = new BashTmpFs();
			await tmpFs.writeFile("/big.txt", "x".repeat(BASH_TMP_SESSION_MAX_FILE_BYTES + 1));
			await tmpFs.writeFile("/keep.txt", "keep");

			const result = await tmp_fs_evict_to_limits(tmpFs);

			expect(result).toBe(
				`/tmp scratch files larger than ${BASH_TMP_SESSION_MAX_FILE_BYTES} bytes are not persisted between calls; discarded 1 oversized file(s): /tmp/big.txt\n`,
			);
			expect(await tmpFs.exists("/big.txt")).toBe(false);
			expect(await tmpFs.exists("/keep.txt")).toBe(true);
		});

		test("evicts oldest leaves and preserves non-empty directories", async () => {
			const tmpFs = new BashTmpFs();
			await tmpFs.mkdir("/dir");
			await tmpFs.writeFile("/dir/child.txt", "child");
			await set_mtime(tmpFs, "/dir", 1);
			await set_mtime(tmpFs, "/dir/child.txt", 2);

			for (let index = 0; index < BASH_TMP_SESSION_MAX_PATHS - 1; index++) {
				const path = `/new-${index}.txt`;
				await tmpFs.writeFile(path, "x");
				await set_mtime(tmpFs, path, 100 + index);
			}

			const result = await tmp_fs_evict_to_limits(tmpFs);

			expect(result).toBe(
				`/tmp scratch is limited to ${BASH_TMP_SESSION_MAX_PATHS} paths and ${BASH_TMP_SESSION_MAX_BYTES} total bytes between calls; evicted the 1 oldest path(s) to fit: /tmp/dir/child.txt\n`,
			);
			expect(await tmpFs.exists("/dir")).toBe(true);
			expect(await tmpFs.exists("/dir/child.txt")).toBe(false);
		});

		test("evicts a parent directory after its last child is removed", async () => {
			const tmpFs = new BashTmpFs();
			await tmpFs.mkdir("/dir");
			await tmpFs.writeFile("/dir/child.txt", "child");
			await set_mtime(tmpFs, "/dir", 1);
			await set_mtime(tmpFs, "/dir/child.txt", 2);

			for (let index = 0; index < BASH_TMP_SESSION_MAX_PATHS; index++) {
				const path = `/new-${index}.txt`;
				await tmpFs.writeFile(path, "x");
				await set_mtime(tmpFs, path, 100 + index);
			}

			const result = await tmp_fs_evict_to_limits(tmpFs);

			expect(result).toBe(
				`/tmp scratch is limited to ${BASH_TMP_SESSION_MAX_PATHS} paths and ${BASH_TMP_SESSION_MAX_BYTES} total bytes between calls; evicted the 2 oldest path(s) to fit: /tmp/dir/child.txt, /tmp/dir\n`,
			);
			expect(await tmpFs.exists("/dir")).toBe(false);
			expect(await tmpFs.exists("/dir/child.txt")).toBe(false);
			expect(await tmpFs.exists("/new-0.txt")).toBe(true);
		});
	});

	describe("action_run", () => {
		const test_workspace_name = "personal";
		const test_project_name = "home";

		// Full object bytes served by the stubbed global fetch, keyed by files_r2_assets.r2Key. The
		// R2 client's getUrl is spied to embed the key in the URL so the bounded window readers
		// exercise real HTTP Range parsing against this store.
		const test_r2_objects = new Map<string, Uint8Array>();
		let test_runner_counter = 0;

		beforeEach(async () => {
			const { Workpool } = await import("@convex-dev/workpool");
			const { R2 } = await import("@convex-dev/r2");
			test_r2_objects.clear();
			// Billing enqueue and R2 metadata sync behavior are covered by their own suites; file
			// content reads are served from test_r2_objects through the fetch stub below.
			vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("work_bash_test_billing_event" as never);
			vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined as never);
			vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (customKey?: string) => ({
				key: customKey ?? "bash-test-upload-key",
				url: "https://r2.test/upload",
			}));
			vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
			vi.spyOn(R2.prototype, "getUrl").mockImplementation(
				async (key: string) => `https://r2.test/object/${encodeURIComponent(key)}`,
			);
			vi.stubGlobal(
				"fetch",
				vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
					const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
					const url = new URL(href);
					if (url.origin !== "https://r2.test" || !url.pathname.startsWith("/object/")) {
						return new Response(null, { status: 200 });
					}
					const key = decodeURIComponent(url.pathname.slice("/object/".length));
					const bytes = test_r2_objects.get(key);
					if (!bytes) {
						return new Response(null, { status: 404 });
					}
					const range = new Headers(init?.headers).get("Range");
					const rangeMatch = range == null ? null : /^bytes=(\d+)-(\d+)$/.exec(range);
					if (rangeMatch) {
						const start = Number(rangeMatch[1]);
						const endInclusive = Math.min(Number(rangeMatch[2]), bytes.byteLength - 1);
						return new Response(bytes.slice(start, endInclusive + 1), { status: 206 });
					}
					return new Response(bytes.slice(0), { status: 200 });
				}),
			);
		});

		afterEach(() => {
			vi.restoreAllMocks();
			vi.unstubAllGlobals();
		});

		type BashSeedSpec = {
			path: string;
			kind?: "folder" | "file";
			content?: string;
			contentType?: string;
			/** false skips chunk materialization: reads fall back to the bounded R2 window paths. */
			materialized?: boolean;
			/** Break chunk tiling contiguity (materialization anomaly) so chunk readers bail to the window fallback. */
			brokenChunks?: boolean;
			/** Upload-style node without editable yjs state (binary uploads, PDFs). */
			withoutYjsState?: boolean;
			/** Committed asset byte size override; defaults to the utf8 size of `content`. */
			size?: number;
			updatedAt?: number;
		};

		// Mirrors the old mock workspace tree; contents are canonical for every test that reads them.
		const default_workspace_files: BashSeedSpec[] = [
			{ path: "/docs", kind: "folder" },
			{ path: "/docs/readme.md", content: "# Readme\nunique-token here\nmore unique-token below\n" },
			{ path: "/docs/tutorial.md", content: "zeta\nalpha\nALPHA\n" },
			{ path: "/docs/nested", kind: "folder" },
			{ path: "/docs/nested/deep.md", content: "one:two\nthree:four\n" },
			{ path: "/source.pdf", contentType: "application/pdf", withoutYjsState: true, size: 4096 },
			{ path: "/uploaded.md", contentType: "application/octet-stream", withoutYjsState: true, size: 64 },
			{ path: "/reports", kind: "folder" },
			{ path: "/reports/summary.md", content: "summary\n" },
		];

		// ~8.9KB / 1000 lines — over READ_INLINE_MAX_BYTES, so readers take the bounded large-file pages.
		const big_md_file: BashSeedSpec = {
			path: "/big.md",
			content: `${Array.from({ length: 1000 }, (_, index) => `line ${index + 1}`).join("\n")}\n`,
		};

		async function seed_workspace_folder(
			ctx: MutationCtx,
			scope: { workspaceId: string; projectId: string; userId: Id<"users"> },
			path: string,
			updatedAt: number,
		) {
			const { test_mocks } = await import("./setup.test.ts");
			const segments = path.split("/").filter(Boolean);
			let parentId: Id<"files_nodes"> | typeof files_ROOT_ID = files_ROOT_ID;
			for (let depth = 1; depth <= segments.length; depth++) {
				const ancestorPath = `/${segments.slice(0, depth).join("/")}`;
				const existing = await ctx.db
					.query("files_nodes")
					.withIndex("by_workspace_project_path_archiveOperation", (q) =>
						q
							.eq("workspaceId", scope.workspaceId)
							.eq("projectId", scope.projectId)
							.eq("path", ancestorPath)
							.eq("archiveOperationId", undefined),
					)
					.first();
				if (existing) {
					parentId = existing._id;
					continue;
				}
				parentId = await ctx.db.insert("files_nodes", {
					...test_mocks.files.base(),
					workspaceId: scope.workspaceId,
					projectId: scope.projectId,
					createdBy: scope.userId,
					updatedBy: scope.userId,
					parentId,
					name: segments[depth - 1],
					kind: "folder",
					path: ancestorPath,
					treePath: `${ancestorPath}/`,
					pathDepth: depth,
					updatedAt,
				});
			}
			return parentId;
		}

		async function seed_workspace_node(
			ctx: MutationCtx,
			scope: { workspaceId: string; projectId: string; userId: Id<"users"> },
			spec: BashSeedSpec,
			seedIndex: number,
		) {
			const { test_mocks } = await import("./setup.test.ts");
			const { db_insert_file_chunks } = await import("./files_nodes.ts");
			// Deterministic, distinct recency: later seeds are newer.
			const updatedAt = spec.updatedAt ?? Date.now() - 1_000_000 + seedIndex * 1000;
			const segments = spec.path.split("/").filter(Boolean);
			if (spec.kind === "folder") {
				await seed_workspace_folder(ctx, scope, spec.path, updatedAt);
				return;
			}
			const parentId =
				segments.length > 1
					? await seed_workspace_folder(ctx, scope, `/${segments.slice(0, -1).join("/")}`, updatedAt)
					: files_ROOT_ID;
			const name = segments[segments.length - 1];
			const dotIndex = name.lastIndexOf(".");
			const content = spec.content ?? "";
			const bytes = new TextEncoder().encode(content);
			const fileId = await ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				workspaceId: scope.workspaceId,
				projectId: scope.projectId,
				createdBy: scope.userId,
				updatedBy: scope.userId,
				parentId,
				name,
				kind: "file",
				path: spec.path,
				treePath: spec.path,
				pathDepth: segments.length,
				lowercaseExtension:
					dotIndex <= 0 || dotIndex === name.length - 1 ? null : name.slice(dotIndex + 1).toLowerCase(),
				contentType: spec.contentType ?? "text/markdown;charset=utf-8",
				updatedAt,
			});
			const r2Key = `bash-test${spec.path}`;
			const assetId = await ctx.db.insert("files_r2_assets", {
				workspaceId: scope.workspaceId,
				projectId: scope.projectId,
				kind: "content",
				r2Bucket: "test",
				r2Key,
				size: spec.size ?? bytes.byteLength,
				createdBy: scope.userId,
				updatedAt,
			});
			test_r2_objects.set(r2Key, bytes);
			if (spec.withoutYjsState) {
				await ctx.db.patch("files_nodes", fileId, { assetId });
				return;
			}
			const yjsSnapshotAssetId = await ctx.db.insert("files_r2_assets", {
				workspaceId: scope.workspaceId,
				projectId: scope.projectId,
				kind: "yjs_snapshot",
				r2Bucket: "test",
				size: 0,
				createdBy: scope.userId,
				updatedAt,
			});
			const yjsSnapshotId = await ctx.db.insert("files_yjs_snapshots", {
				workspaceId: scope.workspaceId,
				projectId: scope.projectId,
				fileNodeId: fileId,
				sequence: 1,
				assetId: yjsSnapshotAssetId,
				createdBy: scope.userId,
				updatedBy: scope.userId,
				updatedAt,
			});
			const yjsLastSequenceId = await ctx.db.insert("files_yjs_docs_last_sequences", {
				workspaceId: scope.workspaceId,
				projectId: scope.projectId,
				fileNodeId: fileId,
				lastSequence: 1,
			});
			await ctx.db.patch("files_nodes", fileId, { assetId, yjsSnapshotId, yjsLastSequenceId });
			if (spec.materialized === false) {
				return;
			}
			const chunked = await db_insert_file_chunks(ctx, {
				workspaceId: scope.workspaceId,
				projectId: scope.projectId,
				nodeId: fileId,
				yjsSequence: 1,
				markdownContent: content,
			});
			if (chunked._nay) {
				throw new Error(`Seed chunking failed for ${spec.path}: ${chunked._nay.message}`);
			}
			if (spec.brokenChunks) {
				// Materialization anomaly: break the verbatim chunk tiling so chunk-backed readers
				// bail out (usable: false) and the bounded R2 window fallback runs instead.
				const chunks = await ctx.db
					.query("files_markdown_chunks")
					.withIndex("by_workspace_project_fileNode_yjsSequence_chunkIndex", (q) =>
						q
							.eq("workspaceId", scope.workspaceId)
							.eq("projectId", scope.projectId)
							.eq("fileNodeId", fileId)
							.eq("yjsSequence", 1),
					)
					.collect();
				const second = chunks[1];
				if (second) {
					await ctx.db.patch("files_markdown_chunks", second._id, { startIndex: second.startIndex + 1 });
				} else {
					const first = chunks[0];
					await ctx.db.insert("files_markdown_chunks", {
						workspaceId: scope.workspaceId,
						projectId: scope.projectId,
						fileNodeId: fileId,
						yjsSequence: 1,
						chunkIndex: (first?.chunkIndex ?? 0) + 1,
						markdownChunk: "x",
						startIndex: (first?.endIndex ?? 0) + 7,
						endIndex: (first?.endIndex ?? 0) + 8,
						lineStart: first?.lineEnd ?? 1,
						lineEnd: first?.lineEnd ?? 1,
						chunkFlags: 0,
					});
				}
			}
		}

		async function create_bash_runner(opts?: {
			initialCwd?: string;
			allowAppFileTreeMkdir?: boolean;
			extraFiles?: BashSeedSpec[];
			/** Reuse another runner's database (fresh thread, no default tree re-seed). */
			shared?: {
				t: unknown;
				seeded: {
					userId: Id<"users">;
					workspaceId: string;
					projectId: string;
					membershipId: Id<"workspaces_projects_users">;
				};
			};
			/** Acting user override for the action args (scoping tests). */
			userId?: Id<"users">;
			/** Attach to an existing thread instead of creating one (tmp-scope tests). */
			threadId?: Id<"ai_chat_threads">;
		}) {
			const { test_convex, test_mocks_fill_db_with } = await import("./setup.test.ts");
			const { api } = await import("./_generated/api.js");

			pagination_cursors_cache.clear();
			test_runner_counter += 1;
			const runnerIndex = test_runner_counter;

			const t = (opts?.shared?.t as ReturnType<typeof test_convex> | undefined) ?? test_convex();
			const seeded =
				opts?.shared?.seeded ??
				(await t.run((ctx) =>
					test_mocks_fill_db_with.membership(ctx, {
						workspaceName: test_workspace_name,
						projectName: test_project_name,
					}),
				));
			const actingUserId = opts?.userId ?? seeded.userId;

			const seedSpecs = [...(opts?.shared ? [] : default_workspace_files), ...(opts?.extraFiles ?? [])];
			if (seedSpecs.length > 0) {
				await t.run(async (ctx) => {
					for (const [seedIndex, spec] of seedSpecs.entries()) {
						await seed_workspace_node(
							ctx,
							{ workspaceId: seeded.workspaceId, projectId: seeded.projectId, userId: seeded.userId },
							spec,
							seedIndex,
						);
					}
				});
			}

			let threadId = opts?.threadId;
			if (!threadId) {
				const asUser = t.withIdentity({
					issuer: "https://clerk.test",
					subject: `clerk-bash-runner-${runnerIndex}`,
					external_id: seeded.userId,
					email: `bash-runner-${runnerIndex}@test.local`,
				});
				const createdThread = await asUser.mutation(api.ai_chat.thread_create, {
					membershipId: seeded.membershipId,
					clientGeneratedId: `client_bash_thread_${runnerIndex}`,
					title: "bash test thread",
					lastMessageAt: Date.now(),
				});
				if (!createdThread._yay) {
					throw new Error(`Failed to create bash test thread: ${createdThread._nay?.message}`);
				}
				threadId = createdThread._yay.threadId;
			}

			let cwd = "~";
			if (opts?.initialCwd != null && opts.initialCwd !== "~") {
				const state = await t.mutation(internal.ai_chat.set_thread_state, {
					workspaceId: seeded.workspaceId,
					projectId: seeded.projectId,
					threadId,
					userId: seeded.userId,
					patch: { bashCwd: opts.initialCwd },
				});
				cwd = state.bashCwd ?? opts.initialCwd;
			}

			// Spy-delegate ctx: every downstream function runs for real against the in-memory DB
			// while the spies keep call-shape assertions (toHaveBeenCalledWith) working.
			const testQuery = t.query as unknown as (ref: unknown, args: Record<string, unknown>) => Promise<unknown>;
			const testMutation = t.mutation as unknown as (ref: unknown, args: Record<string, unknown>) => Promise<unknown>;
			const testAction = t.action as unknown as (ref: unknown, args: Record<string, unknown>) => Promise<unknown>;
			const runQuery = vi.fn((ref: unknown, queryArgs: Record<string, unknown>) => testQuery(ref, queryArgs));
			const runMutation = vi.fn((ref: unknown, mutationArgs: Record<string, unknown>) =>
				testMutation(ref, mutationArgs),
			);
			const runAction = vi.fn((ref: unknown, actionArgs: Record<string, unknown>) => testAction(ref, actionArgs));
			const ctx = { runQuery, runMutation, runAction } as unknown as ActionCtx;

			const ctxData = {
				workspaceId: seeded.workspaceId,
				projectId: seeded.projectId,
				workspaceName: test_workspace_name,
				projectName: test_project_name,
				userId: actingUserId,
			};

			const run = async (command: string) => {
				const result = await action_run(ctx, {
					...ctxData,
					threadId,
					command,
					allowAppFileTreeMkdir: opts?.allowAppFileTreeMkdir ?? true,
				});
				const state = await t.query(internal.ai_chat.get_thread_state, {
					workspaceId: seeded.workspaceId,
					projectId: seeded.projectId,
					threadId,
				});
				cwd = state.bashCwd ?? cwd;
				return result;
			};

			return { run, runQuery, runMutation, runAction, getCwd: () => cwd, t, seeded, threadId, ctxData };
		}

		async function get_seeded_node_id(runner: Awaited<ReturnType<typeof create_bash_runner>>, path: string) {
			const node = await runner.t.run((ctx) =>
				ctx.db
					.query("files_nodes")
					.withIndex("by_workspace_project_path_archiveOperation", (q) =>
						q
							.eq("workspaceId", runner.seeded.workspaceId)
							.eq("projectId", runner.seeded.projectId)
							.eq("path", path)
							.eq("archiveOperationId", undefined),
					)
					.first(),
			);
			if (!node) {
				throw new Error(`No seeded node at ${path}`);
			}
			return node._id;
		}

		test("runs pwd and persists cd across invocations", async () => {
			const { run, getCwd } = await create_bash_runner();

			const pwdResult = await run("pwd");
			expect(pwdResult.stdout.trim()).toBe(test_app_files_mount);
			expect(pwdResult.metadata.cwd).toBe(test_app_files_mount);
			expect(getCwd()).toBe(test_app_files_mount);

			const cdResult = await run(`cd ${test_app_files_mount}/docs`);
			expect(cdResult.metadata.nextCwd).toBe(`${test_app_files_mount}/docs`);
			expect(getCwd()).toBe(`${test_app_files_mount}/docs`);

			const nextPwdResult = await run("pwd");
			expect(nextPwdResult.stdout.trim()).toBe(`${test_app_files_mount}/docs`);
		});

		test("sets HOME to the cloud user home", async () => {
			const { run } = await create_bash_runner();

			const result = await run("printf $HOME");

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toBe("/home/cloud-usr");
		});

		test("guides unknown commands toward supported bash commands", async () => {
			const { run } = await create_bash_runner();

			const result = await run("notrealcmd");
			const swallowed = await run("notrealcmd 2>&1 || true");
			const compound = await run("notrealcmd; true");

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

		test("guides unsupported strict-mode boilerplate", async () => {
			const { run } = await create_bash_runner();

			const result = await run("set -euo pipefail\nprintf hi > /tmp/a.txt");

			expect(result.metadata.exitCode).toBe(1);
			expect(result.stderr).toContain("bash: set: -o: invalid option");
			expect(result.stderr).toContain("`set -euo pipefail` is unsupported");
			expect(result.stderr).toContain("retry without strict-mode boilerplate");
		});

		test("does not treat file content as an unknown command", async () => {
			const literalPath = "/docs/command-not-found.md";
			const { run } = await create_bash_runner({
				extraFiles: [{ path: literalPath, content: "example: command not found\n" }],
			});

			const catResult = await run(`cat ${test_app_files_mount}${literalPath}`);
			const grepResult = await run(`grep "command not found" ${test_app_files_mount}${literalPath}`);

			expect(catResult.stdout).toContain("example: command not found");
			expect(catResult.stderr).not.toContain("run 'help' to list available commands");
			expect(grepResult.stdout).toContain("example: command not found");
			expect(grepResult.stderr).not.toContain("run 'help' to list available commands");
		});

		test("reads markdown files through the chunk-backed file content query", async () => {
			const { run, runQuery, seeded } = await create_bash_runner();

			const result = await run(`cat ${test_app_files_mount}/docs/readme.md`);

			expect(result.stdout).toContain("# Readme");
			expect(
				runQuery.mock.calls.some(
					([ref, queryArgs]) =>
						function_name_of(ref) === "files_nodes:read_file_full_content_from_chunks" &&
						queryArgs?.path === "/docs/readme.md" &&
						queryArgs?.userId === seeded.userId,
				),
			).toBe(true);
		});

		test("caches markdown file content within one bash invocation", async () => {
			const { run, runQuery } = await create_bash_runner();

			const result = await run(
				`cat ${test_app_files_mount}/docs/readme.md && cat ${test_app_files_mount}/docs/readme.md`,
			);
			const readCalls = runQuery.mock.calls.filter(
				([ref, queryArgs]) =>
					function_name_of(ref) === "files_nodes:read_file_full_content_from_chunks" &&
					queryArgs?.path === "/docs/readme.md",
			);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout.split("# Readme").length - 1).toBe(2);
			expect(readCalls).toHaveLength(1);
		});

		test("pipes cat text output without corrupting Unicode", async () => {
			const unicodePath = "/docs/unicode.md";
			const content = "cafe\u0301 — snowman ☃\n";
			const { run } = await create_bash_runner({
				extraFiles: [{ path: unicodePath, content }],
			});

			const result = await run(`cat ${test_app_files_mount}${unicodePath} | cat`);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toBe(content);
		});

		test("supports ls, find, and stat over file-node paths", async () => {
			const { run } = await create_bash_runner();

			const result = await run(
				`ls ${test_app_files_mount}/docs && find ${test_app_files_mount}/docs -maxdepth 1 -type f && stat ${test_app_files_mount}/docs/readme.md`,
			);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toContain("readme.md");
			expect(result.stdout).toContain(`${test_app_files_mount}/docs/readme.md`);
		});

		test("keeps valid ls operands when another operand is missing", async () => {
			const { run } = await create_bash_runner();

			const result = await run(`ls ${test_app_files_mount}/docs ${test_app_files_mount}/missing`);

			expect(result.metadata.exitCode).toBe(1);
			expect(result.stdout).toContain(`${test_app_files_mount}/docs:`);
			expect(result.stdout).toContain("readme.md");
			expect(result.stderr).toContain(`ls: cannot access '${test_app_files_mount}/missing': No such file or directory`);
		});

		test("supports paginated ls with a continuation command", async () => {
			const runner = await create_bash_runner();
			const { run, runQuery } = runner;
			const docsId = await get_seeded_node_id(runner, "/docs");

			const result = await run(`ls --limit 1 ${test_app_files_mount}/docs`);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toContain("nested/");
			expect(result.stdout).toContain("Next page:");
			expect(result.stdout).toMatch(new RegExp(`ls --limit 1 --cursor \\S+ ${test_app_files_mount}/docs`, "u"));
			expect(result.stderr).not.toContain("directory listing truncated");
			const paginatedCalls = runQuery.mock.calls.map((call) => call[1]).filter((args) => "numItems" in args);
			expect(paginatedCalls).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						parentId: docsId,
						numItems: 1,
						cursor: null,
					}),
				]),
			);
		});

		test("resolves paginated ls path arguments from the current working directory", async () => {
			const runner = await create_bash_runner();
			const { run, runQuery } = runner;
			const docsId = await get_seeded_node_id(runner, "/docs");
			const nestedId = await get_seeded_node_id(runner, "/docs/nested");

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
						parentId: docsId,
						numItems: 10,
						cursor: null,
					}),
					expect.objectContaining({
						parentId: nestedId,
						numItems: 10,
						cursor: null,
					}),
				]),
			);
		});

		test("delegates bare ls to the current scratch directory outside the current project path", async () => {
			const { run, runQuery } = await create_bash_runner();

			const result = await run("cd /tmp && printf hi > scratch.txt && ls");

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toContain("scratch.txt");
			expect(result.stdout).not.toContain("readme.md");
			const paginatedCalls = runQuery.mock.calls.map((call) => call[1]).filter((args) => "numItems" in args);
			expect(paginatedCalls).toHaveLength(0);
		});

		test("keeps /tmp relative ls output outside the current project path", async () => {
			const { run, runQuery } = await create_bash_runner();

			const result = await run("cd /tmp && printf hi > relative-tmp.txt && ls relative-tmp.txt");

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout.trim()).toBe("relative-tmp.txt");
			const paginatedCalls = runQuery.mock.calls.map((call) => call[1]).filter((args) => "numItems" in args);
			expect(paginatedCalls).toHaveLength(0);
		});

		test("reports unknown ls cursor ids with recovery guidance", async () => {
			const { run } = await create_bash_runner();

			const result = await run(`ls --limit 1 --cursor cursor-1 ${test_app_files_mount}/docs`);

			expect(result.metadata.exitCode).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("cursor cursor-1 expired, is unavailable, or was copied incorrectly");
			expect(result.stderr).toContain("Copy the exact --cursor value from the latest Next page command and retry");
		});

		test("resolves stored cursor ids from memory before querying value_store", async () => {
			const { run, runQuery } = await create_bash_runner();

			const firstPage = await run(`ls --limit 1 ${test_app_files_mount}/docs`);
			const cursorId = firstPage.stdout.match(/--cursor '?([^' ]+)'?/u)?.[1];
			if (cursorId == null) {
				throw new Error("expected a cursor id in the first page stdout");
			}
			const rawCursor = pagination_cursors_cache.get(cursorId);
			expect(rawCursor).toBeTruthy();

			runQuery.mockClear();
			const secondPage = await run(`ls --limit 1 --cursor '${cursorId}' ${test_app_files_mount}/docs`);

			expect(secondPage.metadata.exitCode).toBe(0);
			expect(secondPage.stdout).toContain("readme.md");
			expect(runQuery.mock.calls.some(([ref]) => function_name_of(ref) === "value_store:get")).toBe(false);
			expect(runQuery).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					cursor: rawCursor,
				}),
			);
		});

		test("falls back to value_store when a cursor id is not in memory", async () => {
			const { run, runQuery } = await create_bash_runner();

			const firstPage = await run(`ls --limit 1 ${test_app_files_mount}/docs`);
			const cursorId = firstPage.stdout.match(/--cursor '?([^' ]+)'?/u)?.[1];
			if (cursorId == null) {
				throw new Error("expected a cursor id in the first page stdout");
			}
			const rawCursor = pagination_cursors_cache.get(cursorId);
			expect(rawCursor).toBeTruthy();

			pagination_cursors_cache.clear();
			runQuery.mockClear();
			const secondPage = await run(`ls --limit 1 --cursor '${cursorId}' ${test_app_files_mount}/docs`);

			expect(secondPage.metadata.exitCode).toBe(0);
			expect(secondPage.stdout).toContain("readme.md");
			expect(
				runQuery.mock.calls.some(
					([ref, queryArgs]) => function_name_of(ref) === "value_store:get" && queryArgs.id === cursorId,
				),
			).toBe(true);
			expect(runQuery).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					cursor: rawCursor,
				}),
			);
		});

		test("reports missing cursor ids with recovery guidance", async () => {
			const { run } = await create_bash_runner();

			const result = await run(`ls --limit 1 --cursor missing ${test_app_files_mount}/docs`);

			expect(result.metadata.exitCode).toBe(1);
			expect(result.stderr).toContain("cursor missing expired, is unavailable, or was copied incorrectly");
			expect(result.stderr).toContain("Copy the exact --cursor value from the latest Next page command and retry");
		});

		test("supports multiple ls path operands with per-directory continuation commands", async () => {
			const { run } = await create_bash_runner();

			const result = await run(
				`ls --limit 1 ${test_app_files_mount}/docs ${test_app_files_mount} ${test_app_files_mount}/docs/readme.md`,
			);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toContain(`${test_app_files_mount}/docs:\nnested/`);
			expect(result.stdout).toContain(`${test_app_files_mount}:\ndocs/`);
			expect(result.stdout).toContain(`${test_app_files_mount}/docs/readme.md`);
			expect(result.stdout.match(/Next page:/gu)).toHaveLength(2);
			const continuations = [...result.stdout.matchAll(/Next page: ls --limit 1 --cursor (\S+) (\S+)/gu)];
			expect(continuations.map((m) => m[2])).toEqual([`${test_app_files_mount}/docs`, test_app_files_mount]);
			expect(continuations[0][1]).not.toBe(continuations[1][1]);
		});

		test("supports mixed /tmp and app ls operands without a cursor", async () => {
			const { run } = await create_bash_runner();

			const tmpFirst = await run(
				`printf hi > /tmp/mixed-tmp-a.txt && printf hi > /tmp/mixed-tmp-b.txt && ls /tmp/mixed-tmp-a.txt /tmp/mixed-tmp-b.txt ${test_app_files_mount}/docs`,
			);
			const tmpAppTmp = await run(
				`printf hi > /tmp/mixed-tmp-a.txt && printf hi > /tmp/mixed-tmp-b.txt && ls /tmp/mixed-tmp-a.txt ${test_app_files_mount}/docs /tmp/mixed-tmp-b.txt`,
			);

			expect(tmpFirst.metadata.exitCode).toBe(0);
			expect(tmpFirst.stdout).toContain("/tmp/mixed-tmp-a.txt");
			expect(tmpFirst.stdout).toContain("/tmp/mixed-tmp-b.txt");
			expect(tmpFirst.stdout).toContain(`${test_app_files_mount}/docs:\nnested/`);
			expect(tmpFirst.stdout.indexOf("/tmp/mixed-tmp-a.txt")).toBeLessThan(
				tmpFirst.stdout.indexOf("/tmp/mixed-tmp-b.txt"),
			);
			expect(tmpFirst.stdout.indexOf("/tmp/mixed-tmp-b.txt")).toBeLessThan(
				tmpFirst.stdout.indexOf(`${test_app_files_mount}/docs:`),
			);
			expect(tmpFirst.stderr).not.toContain("cannot mix app file paths");

			expect(tmpAppTmp.metadata.exitCode).toBe(0);
			expect(tmpAppTmp.stdout).toContain("/tmp/mixed-tmp-a.txt");
			expect(tmpAppTmp.stdout).toContain(`${test_app_files_mount}/docs:\nnested/`);
			expect(tmpAppTmp.stdout).toContain("/tmp/mixed-tmp-b.txt");
			expect(tmpAppTmp.stdout.indexOf("/tmp/mixed-tmp-a.txt")).toBeLessThan(
				tmpAppTmp.stdout.indexOf(`${test_app_files_mount}/docs:`),
			);
			expect(tmpAppTmp.stdout.indexOf(`${test_app_files_mount}/docs:`)).toBeLessThan(
				tmpAppTmp.stdout.indexOf("/tmp/mixed-tmp-b.txt"),
			);
			expect(tmpAppTmp.stderr).not.toContain("cannot mix app file paths");
		});

		test("formats mixed /tmp and app ls directory sections consistently", async () => {
			const { run } = await create_bash_runner();

			const result = await run(
				`mkdir -p /tmp/mixed-ls-dir && printf hi > /tmp/mixed-ls-dir/tmp.txt && ls ${test_app_files_mount}/docs /tmp/mixed-ls-dir`,
			);
			const relativeResult = await run(
				`cd /tmp && mkdir -p mixed-ls-relative-dir && printf hi > mixed-ls-relative-dir/tmp.txt && ls mixed-ls-relative-dir ${test_app_files_mount}/docs`,
			);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toContain(`${test_app_files_mount}/docs:\nnested/`);
			expect(result.stdout).toContain("/tmp/mixed-ls-dir:\ntmp.txt");
			expect(result.stdout.trim().split("\n\n")).toEqual([
				`${test_app_files_mount}/docs:\nnested/\nreadme.md\ntutorial.md`,
				"/tmp/mixed-ls-dir:\ntmp.txt",
			]);
			expect(relativeResult.metadata.exitCode).toBe(0);
			expect(relativeResult.stdout.trim().split("\n\n")).toEqual([
				"mixed-ls-relative-dir:\ntmp.txt",
				`${test_app_files_mount}/docs:\nnested/\nreadme.md\ntutorial.md`,
			]);
		});

		test("keeps Native Just Bash ls flags when batching adjacent /tmp operands", async () => {
			const { run } = await create_bash_runner();

			const result = await run(
				`mkdir -p /tmp/mixed-ls-a /tmp/mixed-ls-b && ls -d /tmp/mixed-ls-a /tmp/mixed-ls-b ${test_app_files_mount}/docs`,
			);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout.trim().split("\n\n")).toEqual([
				"/tmp/mixed-ls-a",
				"/tmp/mixed-ls-b",
				`${test_app_files_mount}/docs/`,
			]);
		});

		test("rejects ls cursor continuation with multiple operands", async () => {
			const { run, runQuery } = await create_bash_runner();

			const result = await run(
				`ls --limit 1 --cursor cursor-1 ${test_app_files_mount}/docs ${test_app_files_mount}/reports`,
			);
			const mixedResult = await run(`ls --limit 1 --cursor cursor-1 ${test_app_files_mount}/docs /tmp`);

			expect(result.metadata.exitCode).toBe(2);
			expect(result.stderr).toContain("--cursor can only continue one listing target");
			expect(mixedResult.metadata.exitCode).toBe(2);
			expect(mixedResult.stderr).toContain("--cursor can only continue one listing target");
			const paginatedCalls = runQuery.mock.calls.map((call) => call[1]).filter((args) => "numItems" in args);
			expect(paginatedCalls).toHaveLength(0);
		});

		test("supports ls -d and lets directory mode win over recursive mode", async () => {
			const { run } = await create_bash_runner();

			const result = await run(`ls -dR ${test_app_files_mount}/docs`);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout.trim()).toBe(`${test_app_files_mount}/docs/`);
			expect(result.stdout).not.toContain("readme.md");
		});

		test("supports recursive ls with full app shell paths", async () => {
			const { run } = await create_bash_runner();

			const result = await run(`ls -R --limit 10 ${test_app_files_mount}/docs`);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toContain(`${test_app_files_mount}/docs/nested/`);
			expect(result.stdout).toContain(`${test_app_files_mount}/docs/nested/deep.md`);
			expect(result.stdout).toContain(`${test_app_files_mount}/docs/readme.md`);
		});

		test("supports reverse ls order through the paginated query", async () => {
			const runner = await create_bash_runner();
			const { run, runQuery } = runner;
			const docsId = await get_seeded_node_id(runner, "/docs");

			const result = await run(`ls -r --limit 10 ${test_app_files_mount}/docs`);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout.trim().split("\n")).toEqual(["tutorial.md", "readme.md", "nested/"]);
			expect(runQuery).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					parentId: docsId,
					order: "desc",
				}),
			);
		});

		test("ls -t lists the project newest-first and supports scoped immediate-child recency", async () => {
			const runner = await create_bash_runner({
				extraFiles: [
					{ path: "/docs/aaa-old.md", content: "old\n", updatedAt: Date.now() - 2_000_000 },
					{ path: "/docs/zzz-new.md", content: "new\n", updatedAt: Date.now() + 10_000 },
				],
			});
			const { run, runQuery } = runner;
			const docsId = await get_seeded_node_id(runner, "/docs");

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
			expect(scopedPaged.stdout).toMatch(
				new RegExp(`Next page: ls -t --limit 1 --cursor \\S+ ${test_app_files_mount}/docs`, "u"),
			);
			expect(recursiveScoped.metadata.exitCode).toBe(2);
			expect(recursiveScoped.stderr).toContain("ls -t -R is not supported");
			expect(projectPaged.stdout).toContain("Next page: ls -t --limit 1 --cursor");
			expect(runQuery).toHaveBeenCalledWith(
				internal.files_nodes.list_dir_children_by_parent_recency_paginated,
				expect.objectContaining({
					parentId: docsId,
					order: "desc",
				}),
			);
		});

		test("supports app-specific long ls output", async () => {
			const { run, seeded } = await create_bash_runner();

			const result = await run(`ls -la --limit 10 ${test_app_files_mount}/docs`);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toMatch(new RegExp(`folder\\t[^\\t]+Z\\tupdatedBy=${seeded.userId}\\tnested/`, "u"));
			expect(result.stdout).toMatch(
				new RegExp(
					`file\\t[^\\t]+Z\\tupdatedBy=${seeded.userId}\\tcontentType=text/markdown;charset=utf-8\\treadme\\.md`,
					"u",
				),
			);
		});

		test("accepts ls no-op presentation flags and name sort alias", async () => {
			const { run } = await create_bash_runner();

			const result = await run(`ls -1apF --sort=name --indicator-style=slash --limit 10 ${test_app_files_mount}/docs`);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout.trim().split("\n")).toEqual(["nested/", "readme.md", "tutorial.md"]);
		});

		test("rejects unsupported ls sorting and size flags only when app file node paths are involved", async () => {
			const { run, runQuery } = await create_bash_runner();

			const sortResult = await run(`ls --sort=size ${test_app_files_mount}/docs`);
			const sizeResult = await run(`ls -S ${test_app_files_mount}/docs`);
			const nativeJustBashResult = await run("ls --sort=size /tmp");
			const mixedResult = await run(
				`printf hi > /tmp/unsupported-ls-tmp.txt && ls --sort=size /tmp/unsupported-ls-tmp.txt ${test_app_files_mount}/docs`,
			);

			expect(sortResult.metadata.exitCode).toBe(2);
			expect(sortResult.stderr).toContain("unsupported option --sort=size");
			expect(sortResult.stderr).toContain("/home/cloud-usr/w");
			expect(sortResult.stderr).toContain("supports name order only");
			expect(sizeResult.metadata.exitCode).toBe(2);
			expect(sizeResult.stderr).toContain("unsupported option -S");
			expect(nativeJustBashResult.stderr).not.toContain("/home/cloud-usr/w");
			expect(mixedResult.metadata.exitCode).toBe(2);
			expect(mixedResult.stderr).toContain("unsupported option --sort=size");
			expect(mixedResult.stderr).toContain("/home/cloud-usr/w");
			expect(mixedResult.stdout).not.toContain("unsupported-ls-tmp.txt");
			const paginatedCalls = runQuery.mock.calls.map((call) => call[1]).filter((args) => "numItems" in args);
			expect(paginatedCalls).toHaveLength(0);
		});

		test("guides invented ls pagination flags back to the printed cursor command", async () => {
			const { run } = await create_bash_runner();

			const appResult = await run(`ls --limit 1 --next-page ${test_app_files_mount}/docs`);
			const nativeJustBashResult = await run("ls --next-page /tmp");

			for (const result of [appResult, nativeJustBashResult]) {
				expect(result.metadata.exitCode).toBe(2);
				expect(result.stderr).toContain("--next-page is not supported");
				expect(result.stderr).toContain("Copy the exact");
				expect(result.stderr).toContain("Next page: ls --limit N --cursor");
			}
		});

		test("supports paginated find with maxdepth and type filters", async () => {
			const { run, runQuery } = await create_bash_runner();

			const result = await run(`find ${test_app_files_mount}/docs -maxdepth 1 -type f --limit 10`);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toContain(`${test_app_files_mount}/docs/readme.md`);
			expect(result.stdout).toContain(`${test_app_files_mount}/docs/tutorial.md`);
			expect(result.stdout).not.toContain(`${test_app_files_mount}/docs/nested/deep.md`);
			const paginatedCalls = runQuery.mock.calls.map((call) => call[1]).filter((args) => "numItems" in args);
			expect(paginatedCalls).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						folderPath: "/docs",
						numItems: 10,
						cursor: null,
						kind: "file",
						maxDepth: 1,
					}),
				]),
			);
		});

		test("handles exact file find targets locally with type depth and extension filters", async () => {
			const { run, runQuery } = await create_bash_runner();

			const plain = await run(`find ${test_app_files_mount}/docs/readme.md --limit 10`);
			const extension = await run(`find ${test_app_files_mount}/docs/readme.md --extension md --limit 10`);
			const typeFolder = await run(`find ${test_app_files_mount}/docs/readme.md -type d --limit 10`);
			const tooDeep = await run(`find ${test_app_files_mount}/docs/readme.md -mindepth 1 --limit 10`);

			expect(plain.metadata.exitCode).toBe(0);
			expect(plain.stdout.trim()).toBe(`${test_app_files_mount}/docs/readme.md`);
			expect(extension.metadata.exitCode).toBe(0);
			expect(extension.stdout.trim()).toBe(`${test_app_files_mount}/docs/readme.md`);
			expect(typeFolder.stdout.trim()).toBe("0 matches.");
			expect(tooDeep.stdout.trim()).toBe("0 matches.");
			expect(
				runQuery.mock.calls.some(([ref]) => function_name_of(ref) === "files_nodes:list_folder_subtree_paginated"),
			).toBe(false);
		});

		test("supports DB-backed find path word search", async () => {
			// convex-test's search index splits document words on whitespace only, so the word
			// query can only land on a path segment that follows a space in the file name.
			const wordSearchPath = "/docs/word readme.md";
			const outsideWordSearchPath = "/word readme-outside.md";
			const runner = await create_bash_runner({
				extraFiles: [
					{ path: wordSearchPath, content: "word search fixture\n" },
					{ path: outsideWordSearchPath, content: "outside word search fixture\n" },
				],
			});
			const { run, runQuery } = runner;
			const docsId = await get_seeded_node_id(runner, "/docs");

			const nameResult = await run("find -name readme --limit 10");
			const explicitResult = await run("find --path-query readme --limit 10");
			const scopedResult = await run(`find ${test_app_files_mount}/docs -maxdepth 1 -name readme -type f --limit 10`);
			const subtreeResult = await run(`find ${test_app_files_mount}/docs -name readme --limit 10`);

			expect(nameResult.metadata.exitCode).toBe(0);
			expect(nameResult.stdout).toContain(`${test_app_files_mount}${wordSearchPath}`);
			expect(nameResult.stdout).toContain(`${test_app_files_mount}${outsideWordSearchPath}`);
			expect(explicitResult.metadata.exitCode).toBe(0);
			expect(explicitResult.stdout).toContain(`${test_app_files_mount}${wordSearchPath}`);
			expect(scopedResult.metadata.exitCode).toBe(0);
			expect(scopedResult.stdout).toContain(`${test_app_files_mount}${wordSearchPath}`);
			// Without -maxdepth, a folder scope searches the full subtree and filters out the rest.
			expect(subtreeResult.metadata.exitCode).toBe(0);
			expect(subtreeResult.stdout).toContain(`${test_app_files_mount}${wordSearchPath}`);
			expect(subtreeResult.stdout).not.toContain(`${test_app_files_mount}${outsideWordSearchPath}`);
			expect(runQuery).toHaveBeenCalledWith(
				internal.files_nodes.search_paths_paginated,
				expect.objectContaining({
					pathQuery: "readme",
				}),
			);
			expect(runQuery).toHaveBeenCalledWith(
				internal.files_nodes.search_paths_paginated,
				expect.objectContaining({
					parentId: docsId,
					kind: "file",
				}),
			);
			expect(runQuery).toHaveBeenCalledWith(
				internal.files_nodes.search_paths_paginated,
				expect.objectContaining({
					pathQuery: "readme",
					pathPrefix: "/docs",
				}),
			);
		});

		test("supports find -mindepth and accepts -print as a no-op", async () => {
			const { run } = await create_bash_runner();

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
			const { run } = await create_bash_runner();

			const invalid = await run(`find ${test_app_files_mount}/docs -mindepth x --limit 10`);
			const paged = await run(`find ${test_app_files_mount}/docs -mindepth 1 --limit 1`);

			expect(invalid.metadata.exitCode).toBe(2);
			expect(invalid.stderr).toContain("-mindepth must be a non-negative integer");
			expect(paged.metadata.exitCode).toBe(0);
			expect(paged.stdout).toContain("Next page: find");
			expect(paged.stdout).toContain("-mindepth 1");
		});

		test("rejects find --prefix combined with depth flags", async () => {
			const { run, runQuery } = await create_bash_runner();

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
			const { run, runQuery } = await create_bash_runner();

			const globName = await run("find -name '*.md' --limit 10");
			const extension = await run(`find ${test_app_files_mount}/docs --extension md --limit 10`);
			const pathGlob = await run(`find ${test_app_files_mount}/docs/*.md --limit 1`);

			expect(globName.metadata.exitCode).toBe(0);
			expect(globName.stdout).toContain(`${test_app_files_mount}/docs/readme.md`);
			expect(extension.metadata.exitCode).toBe(0);
			expect(extension.stdout).toContain(`${test_app_files_mount}/docs/readme.md`);
			expect(pathGlob.metadata.exitCode).toBe(0);
			expect(pathGlob.stdout).toContain(`${test_app_files_mount}/docs/nested/deep.md`);
			expect(pathGlob.stdout).toMatch(
				new RegExp(`Next page: find ${test_app_files_mount}/docs --extension md --limit 1 --cursor \\S+`, "u"),
			);
			expect(runQuery).toHaveBeenCalledWith(
				internal.files_nodes.list_folder_subtree_paginated,
				expect.objectContaining({
					folderPath: "/docs",
					kind: "file",
					lowercaseExtension: "md",
				}),
			);
		});

		test("rejects find combinations that still cannot stay DB-backed", async () => {
			const { run } = await create_bash_runner();

			const scopedDepth = await run(`find ${test_app_files_mount}/docs -maxdepth 2 -name readme --limit 10`);
			const tokenGlobName = await run("find -type f -name '*readme*' --limit 10");
			const complexGlobName = await run("find -name 'read*.md' --limit 10");
			const pathQueryGlob = await run("find --path-query '.*readme.*' --limit 10");
			const recursivePathQuery = await run(
				`find ${test_app_files_mount} -maxdepth 5 -type f --path-query readme --limit 10`,
			);

			expect(scopedDepth.metadata.exitCode).toBe(2);
			expect(scopedDepth.stderr).toContain("full subtree (omit -maxdepth) or immediate children with -maxdepth 1");
			expect(scopedDepth.stderr).toContain(`Try: find ${test_app_files_mount}/docs --path-query readme --limit 10`);
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
			const { run } = await create_bash_runner();

			const result = await run(`find ${test_app_files_mount}/docs -maxdepth 1 -type f --limit 1`);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toContain(`${test_app_files_mount}/docs/readme.md`);
			expect(result.stdout).not.toContain("No matches in this page; more pages exist.");
			expect(result.stdout).toContain("Next page:");
		});

		test("rejects unsupported find predicates when pagination is requested", async () => {
			const { run, runQuery } = await create_bash_runner();

			const result = await run(`find ${test_app_files_mount}/docs -delete --limit 10`);
			const nativeJustBashResult = await run("find /tmp -mtime 1 --limit 1");

			expect(result.metadata.exitCode).toBe(2);
			expect(result.stderr).toContain("unsupported predicate -delete");
			expect(result.stderr).toContain("/home/cloud-usr/w");
			expect(result.stderr).toContain("use -name QUERY");
			expect(result.stderr).toContain("Usage: find");
			expect(nativeJustBashResult.stderr).not.toContain("/home/cloud-usr/w");
			const paginatedCalls = runQuery.mock.calls.map((call) => call[1]).filter((args) => "numItems" in args);
			expect(paginatedCalls).toHaveLength(0);
		});

		test("ignores app pagination options outside the app file mount without Convex queries", async () => {
			const { run, runQuery } = await create_bash_runner();

			const lsResult = await run("ls --limit 1 /tmp");
			const lsCursorResult = await run("ls /tmp --cursor missing");
			const findResult = await run("find /tmp --limit 1");
			const findCursorResult = await run("find /tmp --cursor missing");
			const plainTreeResult = await run("tree /tmp");
			const treeResult = await run("tree /tmp --limit 1");
			const treeCursorResult = await run("tree /tmp --cursor missing");
			const malformedLimitResult = await run("ls --limit nope /tmp");

			expect(lsResult.metadata.exitCode).toBe(0);
			expect(lsCursorResult.metadata.exitCode).toBe(0);
			expect(findResult.metadata.exitCode).toBe(0);
			expect(findCursorResult.metadata.exitCode).toBe(0);
			expect(treeResult.metadata.exitCode).toBe(plainTreeResult.metadata.exitCode);
			expect(treeResult.stdout).toBe(plainTreeResult.stdout);
			expect(treeResult.stderr).toBe(plainTreeResult.stderr);
			expect(treeCursorResult.metadata.exitCode).toBe(plainTreeResult.metadata.exitCode);
			expect(treeCursorResult.stdout).toBe(plainTreeResult.stdout);
			expect(treeCursorResult.stderr).toBe(plainTreeResult.stderr);
			expect(malformedLimitResult.metadata.exitCode).toBe(2);
			expect(malformedLimitResult.stderr).toContain("ls: --limit must be an integer");
			const paginatedCalls = runQuery.mock.calls.map((call) => call[1]).filter((args) => "numItems" in args);
			expect(paginatedCalls).toHaveLength(0);
		});

		test("does not use the legacy capped list_files query for app ls", async () => {
			const { run, runQuery } = await create_bash_runner();

			await run(`ls ${test_app_files_mount}/docs`);

			const listCalls = runQuery.mock.calls
				.map((call) => call[1])
				.filter((args) => args && typeof args === "object" && "maxDepth" in args);
			expect(listCalls).toHaveLength(0);
		});

		test("resolves exact parent folders through app file node path lookups", async () => {
			const { run, runQuery } = await create_bash_runner();

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
			const { run } = await create_bash_runner();

			const result = await run(`ls ${test_app_files_mount}/docs/*.md`);

			expect(result.metadata.exitCode).toBe(2);
			expect(result.metadata.pathIndexTruncated).toBe(false);
			expect(result.stderr).toContain("app file glob patterns are not supported");
			expect(result.stderr).toContain(`Try: find ${test_app_files_mount}/docs -type f --extension md --limit 20`);
		});

		test("does not alias root listing to app files", async () => {
			const { run } = await create_bash_runner();

			const result = await run("ls /");

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).not.toContain("docs");
			expect(result.stdout).not.toContain("source.pdf");
			expect(result.stdout).toContain("home");
			expect(result.stdout).toContain("tmp");
		});

		test("does not expose the removed legacy mount", async () => {
			const { run } = await create_bash_runner();
			const legacyMount = "/work" + "space";

			const result = await run(`ls ${legacyMount}`);

			expect(result.metadata.exitCode).not.toBe(0);
			expect(result.stdout).not.toContain("readme.md");
		});

		test("explains unreadable uploaded source files through bash cat", async () => {
			const { run } = await create_bash_runner();

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
			const { run } = await create_bash_runner();

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

		test("rejects workspace writes and persists same-thread /tmp scratch files", async () => {
			const { run, runMutation } = await create_bash_runner();

			const workspaceWrite = await run(`echo nope > ${test_app_files_mount}/docs/new.md`);
			expect(workspaceWrite.metadata.exitCode).not.toBe(0);
			expect(workspaceWrite.stderr).toContain("read-only file system");

			const tmpWrite = await run("printf hi > /tmp/a.txt");
			expect(tmpWrite.metadata.exitCode).toBe(0);

			const nextInvocation = await run("cat /tmp/a.txt");
			expect(nextInvocation.metadata.exitCode).toBe(0);
			expect(nextInvocation.stdout).toBe("hi");

			// Only the tmp write flushes; the failed workspace write and the read do not.
			const patchCalls = runMutation.mock.calls.filter(
				([ref]) => function_name_of(ref) === "ai_chat_files:patch_thread_tmp_files",
			);
			expect(patchCalls).toHaveLength(1);
		});

		test("flushes only changed /tmp paths as a delta", async () => {
			const { run, runMutation } = await create_bash_runner();

			await run("printf one > /tmp/a.txt && printf two > /tmp/b.txt");
			const update = await run("printf ONE > /tmp/a.txt");

			expect(update.metadata.exitCode).toBe(0);

			const patchCalls = runMutation.mock.calls.filter(
				([ref]) => function_name_of(ref) === "ai_chat_files:patch_thread_tmp_files",
			);
			const lastPatchArgs = patchCalls.at(-1)?.[1] as
				| {
						fileNodes: BashTmpFileNode[];
						fileNodesContentDict: BashTmpFileNodesContentDict;
						deletePaths: string[];
				  }
				| undefined;
			expect(lastPatchArgs?.fileNodes.map((fileNode) => fileNode.path)).toEqual(["/a.txt"]);
			expect(lastPatchArgs?.fileNodesContentDict).toEqual({ "/a.txt": expect.any(ArrayBuffer) });
			expect(lastPatchArgs?.deletePaths).toEqual([]);

			const read = await run("cat /tmp/a.txt /tmp/b.txt");
			expect(read.stdout).toBe("ONEtwo");
		});

		test("flushes /tmp removals as delete-only deltas", async () => {
			const { run, runMutation } = await create_bash_runner();

			await run("printf one > /tmp/a.txt && printf two > /tmp/b.txt");
			const remove = await run("rm /tmp/a.txt");

			expect(remove.metadata.exitCode).toBe(0);

			const patchCalls = runMutation.mock.calls.filter(
				([ref]) => function_name_of(ref) === "ai_chat_files:patch_thread_tmp_files",
			);
			const lastPatchArgs = patchCalls.at(-1)?.[1] as { fileNodes: unknown[]; deletePaths: string[] } | undefined;
			expect(lastPatchArgs?.fileNodes).toEqual([]);
			expect(lastPatchArgs?.deletePaths).toEqual(["/a.txt"]);
		});

		test("persists nested /tmp creates and recursive deletes through deltas", async () => {
			const { run } = await create_bash_runner();

			const create = await run("mkdir -p /tmp/a/b && printf nested > /tmp/a/b/c.txt");
			expect(create.metadata.exitCode).toBe(0);

			const hydratedRead = await run("cat /tmp/a/b/c.txt");
			expect(hydratedRead.metadata.exitCode).toBe(0);
			expect(hydratedRead.stdout).toBe("nested");

			const remove = await run("rm -r /tmp/a");
			expect(remove.metadata.exitCode).toBe(0);

			const missing = await run("cat /tmp/a/b/c.txt");
			expect(missing.metadata.exitCode).not.toBe(0);
			expect(missing.stderr).toContain("No such file");
		});

		test("persists /tmp copy and move changes through deltas", async () => {
			const { run } = await create_bash_runner();

			await run("mkdir -p /tmp/src && printf copied > /tmp/src/a.txt && printf moved > /tmp/to-move.txt");
			const copyMove = await run("cp -r /tmp/src /tmp/copy && mv /tmp/to-move.txt /tmp/moved.txt");

			expect(copyMove.metadata.exitCode).toBe(0);

			const read = await run("cat /tmp/src/a.txt /tmp/copy/a.txt /tmp/moved.txt");
			expect(read.stdout).toBe("copiedcopiedmoved");
		});

		test("persists /tmp copy and move into existing directories through real destination paths", async () => {
			const { run, runMutation } = await create_bash_runner();

			await run(
				"mkdir -p /tmp/src /tmp/copy-dir /tmp/move-dir && printf copied > /tmp/src/a.txt && printf moved > /tmp/to-move.txt",
			);
			runMutation.mockClear();

			const copyMove = await run("cp /tmp/src/a.txt /tmp/copy-dir && mv /tmp/to-move.txt /tmp/move-dir");

			expect(copyMove.metadata.exitCode).toBe(0);
			const patchCalls = runMutation.mock.calls.filter(
				([ref]) => function_name_of(ref) === "ai_chat_files:patch_thread_tmp_files",
			);
			const lastPatchArgs = patchCalls.at(-1)?.[1] as
				| {
						fileNodes: BashTmpFileNode[];
						fileNodesContentDict: BashTmpFileNodesContentDict;
						deletePaths: string[];
				  }
				| undefined;
			expect(lastPatchArgs?.fileNodes.map((fileNode) => fileNode.path)).toEqual([
				"/copy-dir/a.txt",
				"/move-dir/to-move.txt",
			]);
			expect(lastPatchArgs?.fileNodesContentDict).toEqual({
				"/copy-dir/a.txt": expect.any(ArrayBuffer),
				"/move-dir/to-move.txt": expect.any(ArrayBuffer),
			});
			expect(lastPatchArgs?.deletePaths).toEqual(["/to-move.txt"]);

			const read = await run("cat /tmp/copy-dir/a.txt /tmp/move-dir/to-move.txt");
			expect(read.stdout).toBe("copiedmoved");
		});

		test("scopes durable /tmp scratch files by thread", async () => {
			const writer = await create_bash_runner();
			await writer.run("printf thread-a > /tmp/scope.txt");
			const shared = { t: writer.t, seeded: writer.seeded };

			const sameScope = await create_bash_runner({ shared, threadId: writer.threadId });
			const sameScopeRead = await sameScope.run("cat /tmp/scope.txt");
			expect(sameScopeRead.metadata.exitCode).toBe(0);
			expect(sameScopeRead.stdout).toBe("thread-a");

			const otherThread = await create_bash_runner({ shared });
			const otherThreadRead = await otherThread.run("cat /tmp/scope.txt");
			expect(otherThreadRead.metadata.exitCode).not.toBe(0);
			expect(otherThreadRead.stderr).toContain("No such file");

			const { test_mocks_fill_db_with } = await import("./setup.test.ts");
			const otherUserSeeded = await writer.t.run((ctx) => test_mocks_fill_db_with.membership(ctx, {}));
			const sameThreadOtherUser = await create_bash_runner({
				shared,
				threadId: writer.threadId,
				userId: otherUserSeeded.userId,
			});
			const sameThreadOtherUserRead = await sameThreadOtherUser.run("cat /tmp/scope.txt");
			expect(sameThreadOtherUserRead.metadata.exitCode).toBe(0);
			expect(sameThreadOtherUserRead.stdout).toBe("thread-a");
		});

		test("merges parallel same-thread /tmp writes through deltas", async () => {
			const { run } = await create_bash_runner();

			const [aResult, bResult] = await Promise.all([run("printf a > /tmp/a.txt"), run("printf b > /tmp/b.txt")]);
			expect(aResult.metadata.exitCode).toBe(0);
			expect(bResult.metadata.exitCode).toBe(0);

			const read = await run("cat /tmp/a.txt /tmp/b.txt");
			expect(read.metadata.exitCode).toBe(0);
			expect(read.stdout).toBe("ab");
		});

		test("evicts the oldest /tmp scratch paths beyond the path cap", async () => {
			const { run } = await create_bash_runner();

			await run("printf old > /tmp/old.txt");
			const paths = Array.from({ length: BASH_TMP_SESSION_MAX_PATHS }, (_, index) => `/tmp/p-${index}.txt`).join(" ");
			const overflow = await run(`touch ${paths}`);
			expect(overflow.metadata.exitCode).toBe(0);
			expect(overflow.stderr).toContain("evicted the 1 oldest path(s) to fit: /tmp/old.txt");

			const list = await run("ls /tmp");
			expect(list.stdout).toContain("p-0.txt");
			expect(list.stdout).not.toContain("old.txt");
		});

		test("evicts the oldest /tmp scratch files beyond the byte cap", async () => {
			const { run } = await create_bash_runner();

			// Each seq output is ~1.7KB: under the per-file cap, but three together pass the 4KB session cap.
			const first = await run("seq 1 470 > /tmp/a.txt");
			expect(first.stderr).toBe("");
			const overflow = await run("seq 1 470 > /tmp/b.txt && seq 1 470 > /tmp/c.txt");
			expect(overflow.metadata.exitCode).toBe(0);
			expect(overflow.stderr).toContain("evicted the 1 oldest path(s) to fit: /tmp/a.txt");

			const evictedRead = await run("cat /tmp/a.txt");
			expect(evictedRead.metadata.exitCode).not.toBe(0);
			const survivorsRead = await run("cat /tmp/b.txt /tmp/c.txt");
			expect(survivorsRead.metadata.exitCode).toBe(0);
		});

		test("evicts only the offending /tmp file beyond the per-file cap", async () => {
			const { run } = await create_bash_runner();

			// seq 1 1000 is ~3.9KB, past the 2KB per-file cap.
			const result = await run("seq 1 1000 > /tmp/big.txt && printf keep > /tmp/keep.txt");
			expect(result.metadata.exitCode).toBe(0);
			expect(result.stderr).toContain("discarded 1 oversized file(s): /tmp/big.txt");

			const read = await run("cat /tmp/keep.txt && cat /tmp/big.txt");
			expect(read.stdout).toBe("keep");
			expect(read.metadata.exitCode).not.toBe(0);
		});

		test("creates persistent app file tree folders through bash mkdir when allowed", async () => {
			const { run, runMutation, seeded } = await create_bash_runner({ allowAppFileTreeMkdir: true });

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
					userId: seeded.userId,
				}),
			);
		});

		test("blocks app file tree folder creation through bash mkdir when not allowed", async () => {
			const { run, runMutation } = await create_bash_runner({ allowAppFileTreeMkdir: false });

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
			const { run, runQuery, seeded } = await create_bash_runner();

			const result = await run("search --limit 5 unique-token");

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toContain("unique-token");
			expect(result.stdout).toContain(`${test_app_files_mount}/docs/readme.md`);
			expect(runQuery).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					userId: seeded.userId,
					query: "unique-token",
					numItems: 5,
					cursor: null,
				}),
			);
		});

		test("runs indexed search with equals-form options", async () => {
			const { run, runQuery } = await create_bash_runner();

			const result = await run(`search --path=${test_app_files_mount}/docs --limit=5 unique-token`);

			expect(result.metadata.exitCode).toBe(0);
			expect(runQuery).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					query: "unique-token",
					numItems: 5,
					pathPrefix: "/docs",
				}),
			);
		});

		test("annotates broad full-text results for exact hyphenated token searches", async () => {
			// The broad fixture's intraword bold breaks the literal token in the markdown chunk while
			// the plain-text search index still matches it; the hit stays in the page with a
			// word-level note instead of being filtered out.
			const { run } = await create_bash_runner({
				extraFiles: [
					{ path: "/search-fixtures/hyphen.md", content: "exact-hyphen-token-2026 inside\n" },
					{ path: "/search-fixtures/broad.md", content: "broad mention exact-hyphen-to**ken-2026ish** here\n" },
				],
			});

			const result = await run("search --limit 5 exact-hyphen-token-2026");

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toContain(
				"Found 2 results (exact matches: 1, word-level-only matches: 1; see per-hit notes)",
			);
			expect(result.stdout).toMatch(/search-fixtures\/hyphen\.md .+\[contains exact 'exact-hyphen-token-2026'\]/u);
			expect(result.stdout).toMatch(
				/search-fixtures\/broad\.md .+\[word-level match; chunk does not contain 'exact-hyphen-token-2026'\]/u,
			);
		});

		test("keeps word-level-only search pages full and the continuation reachable", async () => {
			// Broad file is seeded first so the limit-1 first page holds only the word-level hit;
			// the exact match lives on the next page and must stay reachable via Next page.
			const { run } = await create_bash_runner({
				extraFiles: [
					{ path: "/search-fixtures/broad.md", content: "broad mention exact-hyphen-to**ken-2026ish** here\n" },
					{ path: "/search-fixtures/hyphen.md", content: "exact-hyphen-token-2026 inside\n" },
				],
			});

			const firstPage = await run("search --limit 1 exact-hyphen-token-2026");

			expect(firstPage.metadata.exitCode).toBe(0);
			expect(firstPage.stdout).toContain(
				"Found 1 results (exact matches: 0, word-level-only matches: 1; see per-hit notes)",
			);
			expect(firstPage.stdout).toMatch(
				/search-fixtures\/broad\.md .+\[word-level match; chunk does not contain 'exact-hyphen-token-2026'\]/u,
			);
			expect(firstPage.stdout).toMatch(/Next page: search --limit 1 --cursor \S+ exact-hyphen-token-2026/u);

			const continuation = firstPage.stdout.match(/Next page: (search .+)/u)?.[1];
			if (continuation == null) {
				throw new Error("expected a search continuation in the first page stdout");
			}
			const secondPage = await run(continuation);

			expect(secondPage.metadata.exitCode).toBe(0);
			expect(secondPage.stdout).toContain("exact-hyphen-token-2026 inside");
			expect(secondPage.stdout).toMatch(/search-fixtures\/hyphen\.md .+\[contains exact 'exact-hyphen-token-2026'\]/u);
		});

		test("rejects indexed search invalid limit values", async () => {
			const { run, runQuery } = await create_bash_runner();

			const result = await run("search --limit nope unique-token");

			expect(result.metadata.exitCode).toBe(2);
			expect(result.stderr).toContain("search: --limit must be an integer");
			expect(runQuery.mock.calls.some(([, queryArgs]) => "query" in queryArgs)).toBe(false);
		});

		test("prints a search continuation when indexed search has another DB page", async () => {
			const { run, runQuery } = await create_bash_runner({
				extraFiles: [
					{ path: "/docs/paged-a.md", content: "paged-token alpha\n" },
					{ path: "/docs/paged-b.md", content: "paged-token beta\n" },
				],
			});

			const firstPage = await run("search --limit 1 paged-token");
			const complete = await run("search --limit 5 unique-token");

			expect(firstPage.metadata.exitCode).toBe(0);
			expect(firstPage.stdout).toContain("Found 1 results");
			expect(firstPage.stdout).toMatch(/Next page: search --limit 1 --cursor \S+ paged-token/u);
			expect(complete.stdout).not.toContain("Next page: search");
			const pageProbeCalls = runQuery.mock.calls.filter(
				([, args]) => "query" in args && "cursor" in args && !("numItems" in args),
			);
			expect(pageProbeCalls).toHaveLength(0);
		});

		test("reports unknown indexed search cursor ids", async () => {
			const { run, runQuery } = await create_bash_runner();

			const result = await run("search --limit 1 --cursor cursor-1 paged-token");

			expect(result.metadata.exitCode).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("cursor cursor-1 expired, is unavailable, or was copied incorrectly");
			expect(result.stderr).toContain("Copy the exact --cursor value from the latest Next page command and retry");
			expect(runQuery).toHaveBeenCalledWith(internal.value_store.get, { id: "cursor-1" });
		});

		test("does not probe scoped search continuations because Convex filters paginate results", async () => {
			const { run, runQuery } = await create_bash_runner({
				extraFiles: [
					{ path: "/docs/paged-a.md", content: "paged-token alpha\n" },
					{ path: "/docs/paged-b.md", content: "paged-token beta\n" },
				],
			});

			const result = await run(`search --path ${test_app_files_mount}/docs --limit 1 paged-token`);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toContain("Next page: search --path");
			expect(result.stdout).not.toContain("No matches in this page; more pages exist.");
			expect(runQuery).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ query: "paged-token", pathPrefix: "/docs", numItems: 1 }),
			);
			const pageProbeCalls = runQuery.mock.calls.filter(
				([, args]) => "query" in args && "cursor" in args && !("numItems" in args),
			);
			expect(pageProbeCalls).toHaveLength(0);
		});

		test("rejects app file node path operands in indexed search instead of folding them into the query", async () => {
			const { run, runQuery } = await create_bash_runner();

			const result = await run(`search --limit 5 unique-token ${test_app_files_mount}`);

			expect(result.metadata.exitCode).toBe(2);
			expect(result.stderr).toContain("path operands are not supported");
			expect(result.stderr).toContain("search --path <folder>");
			expect(runQuery.mock.calls.some(([, queryArgs]) => "query" in queryArgs)).toBe(false);
		});

		test("scopes indexed search to a folder with --path", async () => {
			const { run, runQuery } = await create_bash_runner();

			// In-scope folder -> hit, and the app file node path is passed through to the query.
			const inScope = await run(`search --path ${test_app_files_mount}/docs unique-token`);
			expect(inScope.metadata.exitCode).toBe(0);
			expect(inScope.stdout).toContain(`${test_app_files_mount}/docs/readme.md`);
			expect(inScope.stdout).toContain(`under ${test_app_files_mount}/docs`);
			expect(runQuery).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ query: "unique-token", pathPrefix: "/docs" }),
			);

			// Bare search follows the current app cwd so "cd dir && search term" stays DB-scoped.
			const cwdScope = await run(`cd ${test_app_files_mount}/docs && search unique-token`);
			expect(cwdScope.metadata.exitCode).toBe(0);
			expect(cwdScope.stdout).toContain(`${test_app_files_mount}/docs/readme.md`);
			expect(cwdScope.stdout).toContain(`under ${test_app_files_mount}/docs`);
			const searchCalls = runQuery.mock.calls.map((call) => call[1]).filter((args) => "query" in args);
			expect(searchCalls.at(-1)).toEqual(expect.objectContaining({ query: "unique-token", pathPrefix: "/docs" }));

			// Relative --path (including `.`) resolves against the current working directory.
			const relScope = await run(`cd ${test_app_files_mount} && search --path docs unique-token`);
			expect(relScope.metadata.exitCode).toBe(0);
			expect(relScope.stdout).toContain(`${test_app_files_mount}/docs/readme.md`);
			expect(relScope.stdout).toContain(`under ${test_app_files_mount}/docs`);

			const dotScope = await run(`cd ${test_app_files_mount}/docs && search --path . unique-token`);
			expect(dotScope.metadata.exitCode).toBe(0);
			expect(dotScope.stdout).toContain(`${test_app_files_mount}/docs/readme.md`);
			const relCalls = runQuery.mock.calls.map((call) => call[1]).filter((args) => "query" in args);
			expect(relCalls.at(-1)).toEqual(expect.objectContaining({ query: "unique-token", pathPrefix: "/docs" }));

			// Out-of-scope folder → no match (the only hit lives under /docs).
			const outScope = await run(`search --path ${test_app_files_mount}/other unique-token`);
			expect(outScope.metadata.exitCode).toBe(0);
			expect(outScope.stdout).toContain("No content matches found");
			expect(outScope.stdout).toContain(`under ${test_app_files_mount}/other`);
			expect(outScope.stdout).toContain("not path/name/glob/regex search");

			// A --path outside currentProjectPath is rejected.
			const bad = await run("search --path /etc unique-token");
			expect(bad.metadata.exitCode).toBe(2);
			expect(bad.stderr).toContain("must be a folder under the app file tree");
		});

		test("does not scan markdown files when indexed search misses", async () => {
			const { run, runAction } = await create_bash_runner();

			const result = await run("search --limit 5 zzz-absent-token");

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toContain("No content matches found");
			expect(result.stdout).toContain("find --path-query QUERY");
			expect(runAction).not.toHaveBeenCalled();
		});

		test("rejects chunk-type filters for indexed search", async () => {
			const { run, runQuery } = await create_bash_runner();

			const code = await run("search --code code-token");
			const table = await run("search --table table-token");
			const noCode = await run("search --no-code unique-token");

			expect(code.metadata.exitCode).toBe(2);
			expect(table.metadata.exitCode).toBe(2);
			expect(noCode.metadata.exitCode).toBe(2);
			expect(code.stderr).toContain("--code is not supported");
			expect(table.stderr).toContain("--table is not supported");
			expect(noCode.stderr).toContain("--no-code is not supported");
			expect(runQuery.mock.calls.some(([ref]) => function_name_of(ref) === "files_nodes:text_search_files")).toBe(
				false,
			);
		});

		test("maps simple recursive app grep to indexed search", async () => {
			const { run, runQuery } = await create_bash_runner();

			const result = await run(`grep -R unique-token ${test_app_files_mount}/docs`);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stderr).toBe("");
			expect(result.stdout).toContain("uses indexed full-text search");
			expect(result.stdout).toContain(`Found 1 results under ${test_app_files_mount}/docs`);
			expect(result.stdout).toContain(`${test_app_files_mount}/docs/readme.md`);
			expect(runQuery).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ query: "unique-token", pathPrefix: "/docs" }),
			);
		});

		test("annotates broad full-text results for exact hyphenated grep -R patterns", async () => {
			// Same intraword-bold trick as the search annotation tests: the index matches broad.md
			// but its markdown chunk lacks the literal token, so its hit carries the word-level note.
			const { run } = await create_bash_runner({
				extraFiles: [
					{ path: "/grep-fixtures/hyphen.md", content: "exact-hyphen-token-2026 inside\n" },
					{ path: "/grep-fixtures/broad.md", content: "broad mention exact-hyphen-to**ken-2026ish** here\n" },
				],
			});

			const result = await run(`grep -R exact-hyphen-token-2026 ${test_app_files_mount}/grep-fixtures`);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toContain(
				`Found 2 results under ${test_app_files_mount}/grep-fixtures (exact matches: 1, word-level-only matches: 1; see per-hit notes)`,
			);
			expect(result.stdout).toMatch(/grep-fixtures\/hyphen\.md .+\[contains exact 'exact-hyphen-token-2026'\]/u);
			expect(result.stdout).toMatch(
				/grep-fixtures\/broad\.md .+\[word-level match; chunk does not contain 'exact-hyphen-token-2026'\]/u,
			);
		});

		test("keeps a grep -R page whose hits are only word-level matches", async () => {
			const { run } = await create_bash_runner({
				extraFiles: [
					{ path: "/grep-fixtures/broad.md", content: "broad mention exact-hyphen-to**ken-2026ish** here\n" },
				],
			});

			const result = await run(`grep -R exact-hyphen-token-2026 ${test_app_files_mount}/grep-fixtures`);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toContain(
				`Found 1 results under ${test_app_files_mount}/grep-fixtures (exact matches: 0, word-level-only matches: 1; see per-hit notes)`,
			);
			expect(result.stdout).toMatch(
				/grep-fixtures\/broad\.md .+\[word-level match; chunk does not contain 'exact-hyphen-token-2026'\]/u,
			);
		});

		test("greps a single app file (substring, line numbers, -i), guidance otherwise", async () => {
			const { run } = await create_bash_runner();

			// Single app file → matching lines with 1-based line numbers (grep -n style).
			const hit = await run(`grep unique-token ${test_app_files_mount}/docs/readme.md`);
			expect(hit.metadata.exitCode).toBe(0);
			expect(hit.stdout).toBe("2:unique-token here\n3:more unique-token below\n");
			const piped = await run(`cat ${test_app_files_mount}/docs/readme.md | head -n 20 | grep -n unique-token`);
			expect(piped.metadata.exitCode).toBe(0);
			expect(piped.stdout).toBe("2:unique-token here\n3:more unique-token below\n");

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
			const { run } = await create_bash_runner();

			const anchored = await run(`grep '^# Readme' ${test_app_files_mount}/docs/readme.md`);
			const escaped = await run(`grep '\\.' ${test_app_files_mount}/docs/readme.md`);
			const wildcard = await run(`grep 'unique.*token' ${test_app_files_mount}/docs/readme.md`);

			expect(anchored.metadata.exitCode).toBe(1);
			expect(anchored.stdout).toBe("");
			expect(anchored.stderr).toContain("substring-only");
			expect(anchored.stderr).toContain("regex metacharacters are matched literally");
			expect(anchored.stderr).toContain(`Try: grep '# Readme' ${test_app_files_mount}/docs/readme.md`);
			expect(escaped.stderr).not.toContain("substring-only");
			expect(wildcard.stderr).toContain(`Try: grep unique ${test_app_files_mount}/docs/readme.md`);
		});

		test("keeps grep large-file scan advisories on stderr", async () => {
			const path = "/docs/large-grep.md";
			// Over the bounded scan window so the fallback reads only a leading slice; broken chunk
			// tiling makes the chunk scan bail (usable: false) into that windowed fallback.
			const { run } = await create_bash_runner({
				extraFiles: [
					{
						path,
						content: `match-token\n${"filler-line\n".repeat(800)}`,
						brokenChunks: true,
					},
				],
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

		test("uses prefix find and renders app tree pages", async () => {
			const { run } = await create_bash_runner();
			const scopedRunner = await create_bash_runner({ initialCwd: `${test_app_files_mount}/docs` });

			const prefixResult = await run("find --prefix /docs --limit 20 -type f");
			const relativePrefixResult = await scopedRunner.run("find --prefix nested --limit 1");
			const treeResult = await run(`tree ${test_app_files_mount}/docs --limit 2`);

			expect(prefixResult.metadata.exitCode).toBe(0);
			expect(prefixResult.stdout).toContain(`${test_app_files_mount}/docs/readme.md`);
			expect(prefixResult.stdout).toContain(`${test_app_files_mount}/docs/tutorial.md`);
			expect(relativePrefixResult.metadata.exitCode).toBe(0);
			expect(relativePrefixResult.stdout).toMatch(
				new RegExp(`Next page: find --prefix ${test_app_files_mount}/docs/nested --limit 1 --cursor \\S+`, "u"),
			);
			expect(treeResult.metadata.exitCode).toBe(0);
			expect(treeResult.stdout).toContain(test_app_files_mount + "/docs");
			expect(treeResult.stdout).toContain("|-- nested/");
			expect(treeResult.stdout).toContain("|   |-- deep.md");
			expect(treeResult.stdout).toMatch(
				new RegExp(`Next page: tree ${test_app_files_mount}/docs --limit 2 --cursor \\S+`, "u"),
			);
		});

		test("renders exact file tree targets without subtree pagination", async () => {
			const { run, runQuery } = await create_bash_runner();

			const result = await run(`tree ${test_app_files_mount}/docs/readme.md --limit 2`);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout.trim()).toBe(`${test_app_files_mount}/docs/readme.md`);
			expect(
				runQuery.mock.calls.some(([ref]) => function_name_of(ref) === "files_nodes:list_folder_subtree_paginated"),
			).toBe(false);
		});

		test("keeps tree app-only option guidance out of /tmp paths", async () => {
			const { run, runQuery } = await create_bash_runner();

			const nativeJustBashResult = await run(
				"mkdir -p /tmp/tree-tmp && printf hi > /tmp/tree-tmp/a.md && tree -P '*.md' /tmp/tree-tmp",
			);
			const appResult = await run(`tree -P '*.md' ${test_app_files_mount}/docs`);
			const nativeJustBashNextPage = await run("tree --next-page /tmp");
			const appNextPage = await run(`tree --next-page ${test_app_files_mount}/docs`);

			expect(nativeJustBashResult.stderr).not.toContain("/home/cloud-usr/w");
			expect(appResult.metadata.exitCode).toBe(2);
			expect(appResult.stderr).toContain("unsupported option -P");
			expect(appResult.stderr).toContain("/home/cloud-usr/w");
			for (const result of [nativeJustBashNextPage, appNextPage]) {
				expect(result.metadata.exitCode).toBe(2);
				expect(result.stderr).toContain("--next-page is not supported");
				expect(result.stderr).toContain("Copy the exact");
			}
			const paginatedCalls = runQuery.mock.calls.map((call) => call[1]).filter((args) => "numItems" in args);
			expect(paginatedCalls).toHaveLength(0);
		});

		test("supports exact reader commands while keeping unreadable app content out of generic readers", async () => {
			const { run } = await create_bash_runner();

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
			const { run, runAction } = await create_bash_runner();

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
			const { run } = await create_bash_runner();

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
			const { run } = await create_bash_runner({ extraFiles: [big_md_file] });
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

		test("prints absolute app file node paths in large-file reader continuations", async () => {
			const { run } = await create_bash_runner({ initialCwd: test_app_files_mount, extraFiles: [big_md_file] });
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
			// Unmaterialized (no chunks) so reads fall back to the bounded leading window, with lines
			// so long the window holds fewer lines than each command requests → scanTruncated.
			const { run } = await create_bash_runner({
				extraFiles: [
					{
						path: "/big.md",
						content: `${"A".repeat(4999)}\n${"B".repeat(4999)}\n${"C".repeat(2000)}`,
						materialized: false,
					},
				],
			});
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
			const { run } = await create_bash_runner({ extraFiles: [big_md_file] });
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
			const { run } = await create_bash_runner({ extraFiles: [big_md_file] });
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
			const { run, runAction } = await create_bash_runner({
				extraFiles: [
					{ path: "/wc/a.md", content: "on two\nthree\nfour x\n" },
					{ path: "/wc/b.md", content: "abc cd\nef g\n" },
				],
			});

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
			// Unmaterialized 12000-byte file with exactly 40 newlines inside the 8192-byte scan
			// window (40 × 204B lines, then one long unterminated line), so counts are lower bounds.
			const { run } = await create_bash_runner({
				extraFiles: [
					{
						path: "/wc/windowed.md",
						content: `${`${"x".repeat(203)}\n`.repeat(40)}${"y".repeat(3840)}`,
						materialized: false,
					},
				],
			});

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
			const { run } = await create_bash_runner({
				extraFiles: [{ path: "/wc/a.md", content: "on two\nthree\nfour x\n" }],
			});

			const result = await run(`wc ${test_app_files_mount}/wc/a.md ${test_app_files_mount}/source.pdf`);

			expect(result.metadata.exitCode).toBe(1);
			expect(result.stdout).toContain(`3 5 20 ${test_app_files_mount}/wc/a.md`);
			expect(result.stdout).toContain("3 5 20 total");
			expect(result.stderr).toContain("Markdown and plain text files only");
			expect(result.stderr).toContain(`${test_app_files_mount}/source.pdf.md`);
		});

		test("tail -n +K reads forward from line K on a large file (not the trailing window)", async () => {
			const { run } = await create_bash_runner({ extraFiles: [big_md_file] });
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
			const { run } = await create_bash_runner({ extraFiles: [big_md_file] });
			const bigPath = `${test_app_files_mount}/big.md`;
			const smallPath = `${test_app_files_mount}/docs/readme.md`;

			const result = await run(`cat ${bigPath} ${smallPath}`);

			expect(result.metadata.exitCode).toBe(1);
			expect(result.stderr).toContain("too large to concatenate");
			// Nothing from the small file is emitted: the refusal happens up front.
			expect(result.stdout).not.toContain("# Readme");
		});

		test("piping a large cat keeps the advisory out of the pipe", async () => {
			const { run } = await create_bash_runner({ extraFiles: [big_md_file] });
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
			const runner = await create_bash_runner({
				extraFiles: [{ path: "/draft.md", content: "tiny base\n" }],
			});
			const { files_yjs_doc_create_from_markdown, files_u8_to_array_buffer } = await import("../server/files.ts");
			const { encodeStateAsUpdate } = await import("yjs");
			const baseYjsDoc = files_yjs_doc_create_from_markdown({ markdown: "tiny base" });
			if ("_nay" in baseYjsDoc) {
				throw new Error(baseYjsDoc._nay.message);
			}
			const upserted = await runner.t.mutation(internal.files_pending_updates.upsert_file_pending_update_in_db, {
				workspaceId: runner.seeded.workspaceId,
				projectId: runner.seeded.projectId,
				userId: runner.seeded.userId,
				nodeId: await get_seeded_node_id(runner, "/draft.md"),
				baseYjsSequence: 1,
				baseYjsUpdate: files_u8_to_array_buffer(encodeStateAsUpdate(baseYjsDoc)),
				unstagedMarkdown: Array.from({ length: 400 }, (_, index) => `line ${index + 1}`).join("\n\n"),
			});
			if (upserted._nay) {
				throw new Error(upserted._nay.message);
			}
			const served = await runner.t.query(internal.files_nodes.get_bash_served_byte_size, {
				workspaceId: runner.seeded.workspaceId,
				projectId: runner.seeded.projectId,
				userId: runner.seeded.userId,
				path: "/draft.md",
			});
			if (served == null) {
				throw new Error("expected get_bash_served_byte_size to return a result for /draft.md");
			}
			expect(served).toMatchObject({ pending: true });
			expect(served.servedBytes).toBeGreaterThan(READ_INLINE_MAX_BYTES);
			const draftPath = `${test_app_files_mount}/draft.md`;

			const result = await runner.run(`cat ${draftPath}`);

			// Gate fired on the served size: bounded page on stdout, advisory carrying the served
			// byte count on stderr — even though the committed asset is only 10 bytes.
			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toContain("line 1\n\nline 2");
			expect(result.stderr).toContain(`is ${served.servedBytes} bytes`);
		});

		test("allows app exact reads through stream utilities but rejects direct app operands", async () => {
			const { run } = await create_bash_runner({
				extraFiles: [{ path: "/docs/dupes.md", content: "alpha\nzeta\nalpha\n" }],
			});

			const pipeline = await run(
				[
					`cat ${test_app_files_mount}/docs/dupes.md | sort | uniq -c`,
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
			expect(directSort.stderr).toContain("Convex-backed");
			expect(directSort.stderr).toContain("pipe it through cat");
			expect(directSed.metadata.exitCode).not.toBe(0);
			expect(directSed.stderr).toContain("Convex-backed");
			expect(directSed.stderr).toContain("pipe it through cat");
			expect(directAwk.metadata.exitCode).not.toBe(0);
			expect(directAwk.stderr).toContain("Convex-backed");
			expect(directAwk.stderr).toContain("pipe it through cat");
		});

		test("does not falsely reject a sed script that merely contains the mount path text", async () => {
			const { run } = await create_bash_runner();

			// The mount path appears inside the sed SCRIPT, not as a file operand; piping via cat
			// must run, not be rejected by an over-broad substring guard.
			const result = await run(`cat ${test_app_files_mount}/docs/readme.md | sed 's|${test_app_files_mount}|X|'`);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toContain("# Readme");
			expect(result.stderr).not.toContain("cannot be used as direct operands");
			expect(result.stderr).not.toContain("Native Just Bash /tmp commands cannot access app files directly");
		});

		test("rejects app writes and prevents mixed /tmp partial side effects", async () => {
			const { run } = await create_bash_runner();

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
			const { run } = await create_bash_runner();

			const copied = await run(`cp ${test_app_files_mount}/docs/readme.md /tmp/readme.md && cat /tmp/readme.md`);
			const unreadable = await run(`cp ${test_app_files_mount}/source.pdf /tmp/source.pdf`);

			expect(copied.metadata.exitCode).toBe(0);
			expect(copied.stdout).toContain("unique-token");
			expect(unreadable.metadata.exitCode).not.toBe(0);
			expect(unreadable.stderr).toContain("unsupported app file content type");
		});

		test("supports the broader Native Just Bash /tmp command surface", async () => {
			const { run } = await create_bash_runner();

			const result = await run(
				[
					"cd /tmp",
					"printf 'alpha\\nbeta\\n' > data.txt",
					"rev data.txt",
					"tac data.txt",
					"nl data.txt",
					"printf alpha | base64",
					'printf \'{"name":"alpha"}\\n\' > meta.json',
					"jq -r .name meta.json",
					"sha256sum data.txt",
					"du data.txt",
					"diff data.txt data.txt",
					"rg beta data.txt",
				].join(" && "),
			);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toContain("ahpla");
			expect(result.stdout).toContain("beta");
			expect(result.stdout).toContain("1\talpha");
			expect(result.stdout).toContain("YWxwaGE=");
			expect(result.stdout).toContain("alpha");
			expect(result.stdout).toContain("data.txt");
			expect(result.stderr).not.toContain("Convex-backed");
			expect(result.stderr).not.toContain("app-aware commands");
		});

		test("treats /dev/null as a Native Just Bash null device outside the app mount", async () => {
			const { run } = await create_bash_runner();

			const result = await run(
				"printf hi > /dev/null && printf 'alpha\\n' > /tmp/a.txt && tee /dev/null /tmp/b.txt < /tmp/a.txt >/dev/null && cat /tmp/b.txt",
			);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toBe("alpha\n");
			expect(result.stderr).not.toContain("read-only file system");
			expect(result.stderr).not.toContain("Convex-backed");
		});

		test("does not append app-mount guidance for /tmp Native Just Bash command failures", async () => {
			const { run } = await create_bash_runner();

			const result = await run("printf alpha > /tmp/a.txt && rg missing /tmp/a.txt");

			expect(result.metadata.exitCode).not.toBe(0);
			expect(result.stderr).not.toContain("Convex-backed");
			expect(result.stderr).not.toContain("Native Just Bash /tmp commands cannot access app files directly");
		});

		test("keeps the Unix file command unavailable", async () => {
			const { run } = await create_bash_runner();

			const result = await run("printf hi > /tmp/a.txt && file /tmp/a.txt");

			expect(result.metadata.exitCode).not.toBe(0);
			expect(result.stderr).toContain("file: command not found");
			expect(result.stderr).toContain("run 'help'");
			expect(result.stderr).toContain(
				"the Unix file command is intentionally unavailable. Try: stat /tmp/a.txt && wc -c /tmp/a.txt && head -n 5 /tmp/a.txt",
			);
		});

		test("prevents scratch symlinks from escaping into the app mount", async () => {
			const { run } = await create_bash_runner();

			const result = await run(`ln -s ${test_app_files_mount}/docs/readme.md /tmp/readme-link && cat /tmp/readme-link`);

			expect(result.metadata.exitCode).not.toBe(0);
			expect(result.stdout).not.toContain("unique-token");
			expect(result.stderr).toContain("Convex-backed");
			expect(result.stderr).toContain("Native Just Bash /tmp commands cannot access app files directly");
			// Pre-checked before the inner shell, so the sanitizer never redacts the paths.
			expect(result.stderr).toContain(`${test_app_files_mount}/docs/readme.md`);
			expect(result.stderr).not.toContain("<path>");
		});

		test("rejects expanded Native Just Bash /tmp commands when direct app operands are involved", async () => {
			const { run } = await create_bash_runner();

			const duResult = await run(`du ${test_app_files_mount}/docs`);
			const rgResult = await run(`rg unique-token ${test_app_files_mount}/docs/readme.md`);
			const diffResult = await run(
				`printf '# Readme\\n' > /tmp/readme.md && diff ${test_app_files_mount}/docs/readme.md /tmp/readme.md`,
			);
			const duWithFlagsResult = await run(`du -sh ${test_app_files_mount}/docs`);
			const defaultCwdResult = await run(`cd ${test_app_files_mount}/docs && du`);

			for (const result of [duResult, rgResult, diffResult, duWithFlagsResult, defaultCwdResult]) {
				expect(result.metadata.exitCode).not.toBe(0);
				expect(result.stderr).toContain("Convex-backed");
				expect(result.stderr).toContain("app-aware commands");
			}
			expect(duResult.stderr).toContain(test_app_files_mount);
			expect(duResult.stderr).not.toContain("No such file or directory");
			expect(duResult.stderr).toContain(
				`du: app-mount paths do not expose POSIX disk usage. Try: stat ${test_app_files_mount}/docs && find ${test_app_files_mount}/docs -type f --limit 20`,
			);
			expect(rgResult.stderr).toContain(
				`rg: app paths do not support direct Native Just Bash rg. Try: grep unique-token ${test_app_files_mount}/docs/readme.md`,
			);
			expect(duWithFlagsResult.stderr).not.toContain("No such file or directory");
			expect(diffResult.stderr).not.toContain("No such file or directory");
			expect(defaultCwdResult.stderr).toContain("Native Just Bash /tmp commands cannot access app files directly");
		});

		test("allows app reads to stream into expanded Native Just Bash text utilities", async () => {
			const { run } = await create_bash_runner();

			const result = await run(
				[
					`cat ${test_app_files_mount}/docs/readme.md | rev | head -n 1`,
					`cat ${test_app_files_mount}/docs/readme.md | sha256sum`,
				].join(" && "),
			);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toContain("emdaeR #");
			expect(result.stdout).toContain("-");
			expect(result.stderr).not.toContain("Convex-backed");
		});

		test("keeps nested shells, xargs, and which inside the curated command surface", async () => {
			const { run } = await create_bash_runner();

			const nested = await run(`bash -c 'ls --limit 1 ${test_app_files_mount}/docs'`);
			const nestedLoginForm = await run(`bash -lc 'ls --limit 1 ${test_app_files_mount}/docs'`);
			const nestedMixed = await run(
				`bash -c 'printf nested-ok > /tmp/nested-ok.txt && cat /tmp/nested-ok.txt'; bash -c 'printf blocked > ${test_app_files_mount}/nested-blocked.md'`,
			);
			const xargsResult = await run(`printf '${test_app_files_mount}/docs/readme.md\\n' | xargs cat`);
			const xargsParallel = await run("printf hi | xargs -P 2 echo");
			const whichResult = await run("which ls find cat du rg sha256sum && which -s bash");

			expect(nested.metadata.exitCode).toBe(0);
			expect(nested.stdout).toContain("nested/");
			expect(nestedLoginForm.metadata.exitCode).toBe(0);
			expect(nestedLoginForm.stdout).toContain("nested/");
			expect(nestedMixed.metadata.exitCode).not.toBe(0);
			expect(nestedMixed.stdout).toContain("nested-ok");
			expect(nestedMixed.stderr).toContain("shell redirects into app files are unsupported");
			expect(xargsResult.metadata.exitCode).toBe(0);
			expect(xargsResult.stdout).toContain("unique-token");
			expect(xargsParallel.metadata.exitCode).toBe(2);
			expect(xargsParallel.stderr).toContain("parallel execution");
			expect(whichResult.metadata.exitCode).toBe(0);
			expect(whichResult.stdout).toContain("/usr/bin/ls");
			expect(whichResult.stdout).toContain("/usr/bin/find");
			expect(whichResult.stdout).toContain("/usr/bin/cat");
			expect(whichResult.stdout).toContain("/usr/bin/du");
			expect(whichResult.stdout).toContain("/usr/bin/rg");
			expect(whichResult.stdout).toContain("/usr/bin/sha256sum");
		});

		test("rejects xargs -n with a non-positive or non-numeric value instead of silently batching all items", async () => {
			const { run } = await create_bash_runner();

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
			const { run, runQuery } = await create_bash_runner();

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
			const { run } = await create_bash_runner();

			const result = await run("seq 1 40000");

			expect(result.metadata.stdoutTruncated).toBe(true);
			expect(result.metadata.stdoutLength).toBeGreaterThan(30_000);
			expect(result.metadata.pathIndexTruncated).toBe(false);
			expect(result.stdout).toContain("[truncated after 30000 characters]");
		});
	});
}
