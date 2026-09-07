// This module is not a full POSIX shell.
// It gives the AI a bash-shaped interface over db files.
// Db file discovery has to stay index-friendly, so Native Just Bash glob expansion,
// recursive grep, and arbitrary regex scans are not the default way to query db-files paths.
// Prefer custom app-aware commands and flags that map directly to indexed queries,
// such as `find --extension`, `find --path-query`, `search --path`, and exact file reads.
// When the model still writes common glob or regex-shaped commands, recover only the
// simple cases that can be translated safely into the same indexed operations.
// Do not add broad JavaScript filtering after pagination to imitate shell behavior.
//
// Path vocabulary:
// - Bash path: an absolute path in the Just Bash filesystem. It may point at
//   db files, `/tmp`, or synthetic base directories.
// - `HOME`: the bash home/user path, `/home/cloud-usr`.
// - `APP_MOUNT_PATH`: the parent mount path for app organizations,
//   `/home/cloud-usr/w`.
// - `currentWorkspacePath`: the mounted app file tree path,
//   `/home/cloud-usr/w/<organizationName>/<workspaceName>`.
// - dbFilesPath: the Convex `files_nodes.path` inside the selected db-files
//   file tree. It is root-relative, but still starts with `/`; examples are
//   `/docs/readme.md`, `/<mount-name>/README.md`, and `/` for a tree root.
// - Persisted cwd path: the thread-state representation. `~` (the creation
//   default) means "start in currentWorkspacePath"; anything else is an absolute
//   Bash path under `HOME` or `/tmp`.
//
// Command operands start raw. Command handlers resolve them against `cwd` into a
// normalized Bash path, then strip the current workspace path before querying
// Convex. `bash_DbFilesFs` receives already-stripped db-files paths from
// `MountableFs`.

import {
	Bash,
	defineCommand,
	InMemoryFs,
	MountableFs,
	type Command,
	type CommandName,
	type CpOptions,
	type FileContent,
	type FsStat,
	type IFileSystem,
	type MkdirOptions,
	type RmOptions,
} from "just-bash/browser";
import { internal } from "../convex/_generated/api.js";
import type { ActionCtx } from "../convex/_generated/server.js";
import type { Doc, Id } from "../convex/_generated/dataModel";
import type { ai_chat_get_thread_state_Result } from "../convex/ai_chat.ts";
import type { bash_ReviewScratch } from "../convex/bash.ts";
import type {
	ai_chat_files_load_thread_tmp_files_Result,
	ai_chat_files_patch_thread_tmp_files_Args,
} from "../convex/ai_chat_files.ts";
import { files_pending_path_overlay_project_committed_path } from "../shared/files.ts";
import type { plugins_list_bash_source_mounts_Result } from "../convex/plugins.ts";
import {
	organizations_GLOBAL_GITHUB_WORKSPACE_ID,
	organizations_GLOBAL_ORGANIZATION_ID,
	organizations_GLOBAL_PLUGINS_WORKSPACE_ID,
} from "../shared/organizations.ts";
import { should_never_happen } from "../shared/shared-utils.ts";
import { bash_cat_command_create } from "./bash-cat-command.ts";
import { bash_cp_command_create } from "./bash-cp-command.ts";
import { bash_find_command_create } from "./bash-find-command.ts";
import { bash_grep_command_create } from "./bash-grep-command.ts";
import { bash_ls_command_create } from "./bash-ls-command.ts";
import { bash_meta_command_create } from "./bash-meta-command.ts";
import { bash_mv_command_create } from "./bash-mv-command.ts";
import { bash_nested_shell_command_create } from "./bash-nested-shell-command.ts";
import { bash_head_tail_wc_command_create } from "./bash-head-tail-wc-command.ts";
import { bash_rm_command_create } from "./bash-rm-command.ts";
import { bash_search_command_create } from "./bash-search-command.ts";
import { bash_sed_command_create } from "./bash-sed-command.ts";
import { bash_stat_command_create } from "./bash-stat-command.ts";
import { bash_tee_command_create } from "./bash-tee-command.ts";
import { bash_textgrep_command_create } from "./bash-textgrep-command.ts";
import { bash_tree_command_create } from "./bash-tree-command.ts";
import { bash_touch_command_create } from "./bash-touch-command.ts";
import {
	bash_APP_MOUNT_PATH,
	bash_EXTERNAL_MOUNTS_ROOT,
	bash_PLUGINS_MOUNT_ROOT,
	bash_command_loads_disallowed_shell_code,
	bash_current_workspace_path_to_db_files_path,
	bash_db_files_path_to_current_workspace_path,
	bash_DEV_NULL_PATH,
	bash_DEV_ZERO_BYTE_COUNT,
	bash_DEV_ZERO_PATH,
	bash_DEV_ZERO_TEXT,
	bash_HOME,
	bash_normalize_path,
	bash_resolve_path,
	bash_shell_arg_quote,
	bash_disallowed_shell_code_error,
	bash_TMP_MOUNT,
	bash_DbFilesFs,
	bash_COMMAND_EXIT_FAILURE,
	bash_COMMAND_EXIT_CANNOT_EXECUTE,
	bash_TERMINAL_LINE_ENDING_REGEX,
	bash_SHELL_COMMENT_LINE_REGEX,
	bash_WHITESPACE_RUN_REGEX,
	type bash_DbFilesRoots,
} from "./bash-utils.ts";
import { bash_ALLOWED_COMMANDS, bash_delegate_native_just_bash_tmp_command } from "./bash-delegate.ts";
import { bash_which_command_create } from "./bash-which-command.ts";
import { bash_xargs_command_create } from "./bash-xargs-command.ts";

const DEFAULT_CWD = "~";
const OUTPUT_LIMIT = 30_000;

const TERMINAL_TRAILING_NEWLINE_REGEX = /\n+$/;

const COMMAND_NOT_FOUND_REGEX = /: command not found$/m;
const REDIRECTS_STDERR_TO_STDOUT_REGEX = /(^|[\s;&|])2\s*>\s*&\s*1(?=$|[\s;&|])/;
const SET_INVALID_OPTION_REGEX = /bash: set: -o: invalid option/m;
const FILE_COMMAND_OPERAND_REGEX = /(?:^|[\s;&|])file\s+([^\s;&|]+)/u;

// Deliberately tiny caps so /tmp eviction is exercised while testing the app.
const BASH_TMP_SESSION_MAX_PATHS = 10;
const BASH_TMP_SESSION_MAX_BYTES = 4_000;
const BASH_TMP_SESSION_MAX_FILE_BYTES = 2_000;

type BashTmpPatchEntry = ai_chat_files_patch_thread_tmp_files_Args["fileNodes"][number];

type BashTmpPatchContentDict = ai_chat_files_patch_thread_tmp_files_Args["fileNodesContentDict"];

/**
 * Whitelist of commands allowed to operate on db-files roots.
 *
 * These commands have app-aware handlers backed by indexed Convex
 * `files_nodes` queries. Every other allowed Native Just Bash command is wrapped as a
 * /tmp-only command (see `NATIVE_JUST_BASH_TMP_COMMANDS`) that rejects db-file
 * paths with a hint instead of touching the mounted db-files trees.
 */
const DB_FILES_COMMANDS = [
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

const DB_FILES_COMMAND_NAMES = new Set<string>(DB_FILES_COMMANDS);
const NATIVE_JUST_BASH_TMP_COMMANDS = bash_ALLOWED_COMMANDS.filter((command) => !DB_FILES_COMMAND_NAMES.has(command));

/**
 * Changed and deleted paths since the baseline, for `patch_thread_tmp_files`.
 **/
async function tmp_fs_delta_payload(tmpFs: BashTmpFs) {
	const finalPaths = tmpFs.fs.getAllPaths().filter((path) => path !== "/");
	const finalPathSet = new Set(finalPaths);
	const deletePaths = [...tmpFs.baselinePaths].filter((path) => !finalPathSet.has(path)).sort();
	const tmpFilesContentDict: BashTmpPatchContentDict = {};
	const tmpFileEntryPromises: Promise<BashTmpPatchEntry>[] = [];

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

		tmpFileEntryPromises.push(
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
				tmpFilesContentDict[path] = new Uint8Array(bytes).buffer;
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

	const tmpFileEntries = await Promise.all(tmpFileEntryPromises);
	return {
		fileNodes: tmpFileEntries,
		fileNodesContentDict: tmpFilesContentDict,
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
			.map((path) => `${bash_TMP_MOUNT}${path}`)
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
	let candidate = bash_normalize_path(path);
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
		candidate = bash_normalize_path(`${candidate}/..`);
	}
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
function format_bash_output(args: {
	command: string;
	cwd: string;
	nextCwd: string;
	exitCode: number;
	stdout: string;
	stderr: string;
}) {
	const stdout = args.stdout
		.replace(bash_TERMINAL_LINE_ENDING_REGEX, "\n")
		.replace(TERMINAL_TRAILING_NEWLINE_REGEX, "");
	const stderr = args.stderr
		.replace(bash_TERMINAL_LINE_ENDING_REGEX, "\n")
		.replace(TERMINAL_TRAILING_NEWLINE_REGEX, "");
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

// #region native just bash tmp command

function native_just_bash_tmp_command_create(command: CommandName, currentWorkspacePath: string) {
	return defineCommand(command, async (args, commandCtx) => {
		return await bash_delegate_native_just_bash_tmp_command(command, args, commandCtx, currentWorkspacePath);
	});
}

function native_just_bash_tmp_command_create_all(currentWorkspacePath: string) {
	return NATIVE_JUST_BASH_TMP_COMMANDS.map((command) =>
		native_just_bash_tmp_command_create(command, currentWorkspacePath),
	);
}
// #endregion native just bash tmp command

/**
 * Means bash tried to mutate a mounted read-only filesystem path.
 */
class ReadOnlyFileSystemError extends Error {
	readonly path: string;

	constructor(path: string) {
		const normalizedPath = bash_normalize_path(path);
		super(
			`EROFS: read-only file system, '${normalizedPath}'. Writes are only supported under the current workspace app path or /tmp.`,
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
 * Mutating operations mark touched `/tmp` paths dirty so the end-of-call flush
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

		return await BashTmpFs.from_files({
			fileNodes: loaded.file_nodes,
			fileNodesContentDict: Object.fromEntries(
				loaded.file_nodes.map((file) => [
					file.path,
					loaded.file_nodes_content_dict[file._id]?.bytes ?? new ArrayBuffer(0),
				]),
			),
		});
	}

	static async from_files(loaded: bash_ReviewScratch) {
		const tmpFs = new BashTmpFs();
		for (const tmpFile of loaded.fileNodes) {
			if (tmpFile.kind === "directory") {
				await tmpFs.fs.mkdir(tmpFile.path, { recursive: true });
				await tmpFs.fs.chmod(tmpFile.path, tmpFile.mode);
				await tmpFs.fs.utimes(tmpFile.path, new Date(tmpFile.mtime), new Date(tmpFile.mtime));
			} else if (tmpFile.kind === "symlink") {
				await tmpFs.fs.symlink(tmpFile.symlinkTargetPath ?? "", tmpFile.path);
				await tmpFs.fs.chmod(tmpFile.path, tmpFile.mode);
			} else {
				const bytes = loaded.fileNodesContentDict[tmpFile.path] ?? new ArrayBuffer(0);
				tmpFs.fs.writeFileSync(tmpFile.path, new Uint8Array(bytes), undefined, {
					mode: tmpFile.mode,
					mtime: new Date(tmpFile.mtime),
				});
			}
			tmpFs.baselinePaths.add(tmpFile.path);
		}
		return tmpFs;
	}

	private markDirty(path: string) {
		this.dirty = true;
		this.dirtyRoots.add(bash_normalize_path(path));
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

function stream_utility_command_create_all(currentWorkspacePath: string) {
	return [
		native_just_bash_tmp_command_create("sort", currentWorkspacePath),
		native_just_bash_tmp_command_create("uniq", currentWorkspacePath),
		native_just_bash_tmp_command_create("cut", currentWorkspacePath),
		native_just_bash_tmp_command_create("awk", currentWorkspacePath),
	];
}

// #region action

/**
 * Provide the empty root filesystem that hosts top-level mounts like `/home` and `/tmp`.
 */
class ReadOnlyBaseFs implements IFileSystem {
	async readFile(path: string, _options?: Parameters<IFileSystem["readFile"]>[1]): Promise<string> {
		const normalizedPath = bash_normalize_path(path);
		if (normalizedPath === bash_DEV_NULL_PATH) {
			return "";
		}
		if (normalizedPath === bash_DEV_ZERO_PATH) {
			return bash_DEV_ZERO_TEXT;
		}
		throw new Error(`ENOENT: no such file or directory, open '${normalizedPath}'`);
	}

	async readFileBuffer(path: string): Promise<Uint8Array> {
		const normalizedPath = bash_normalize_path(path);
		if (normalizedPath === bash_DEV_NULL_PATH) {
			return new Uint8Array();
		}
		if (normalizedPath === bash_DEV_ZERO_PATH) {
			return new Uint8Array(bash_DEV_ZERO_BYTE_COUNT);
		}
		throw new Error(`ENOENT: no such file or directory, open '${normalizedPath}'`);
	}

	async writeFile(path: string, _content: FileContent, _options?: Parameters<IFileSystem["writeFile"]>[2]) {
		if (bash_normalize_path(path) === bash_DEV_NULL_PATH) {
			return;
		}
		throw new ReadOnlyFileSystemError(path);
	}

	async appendFile(path: string, _content: FileContent, _options?: Parameters<IFileSystem["appendFile"]>[2]) {
		if (bash_normalize_path(path) === bash_DEV_NULL_PATH) {
			return;
		}
		throw new ReadOnlyFileSystemError(path);
	}

	async exists(path: string) {
		const normalizedPath = bash_normalize_path(path);
		return normalizedPath === "/" || normalizedPath === bash_DEV_NULL_PATH || normalizedPath === bash_DEV_ZERO_PATH;
	}

	async stat(path: string): Promise<FsStat> {
		const normalizedPath = bash_normalize_path(path);
		if (normalizedPath === bash_DEV_NULL_PATH || normalizedPath === bash_DEV_ZERO_PATH) {
			return {
				isFile: true,
				isDirectory: false,
				isSymbolicLink: false,
				mode: 0o666,
				size: normalizedPath === bash_DEV_ZERO_PATH ? bash_DEV_ZERO_BYTE_COUNT : 0,
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
		if (options?.recursive && bash_normalize_path(path) === "/") {
			return;
		}
		throw new ReadOnlyFileSystemError(path);
	}

	async readdir(path: string) {
		const normalizedPath = bash_normalize_path(path);
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
		return bash_resolve_path(base, path);
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
		throw new Error(`EINVAL: invalid argument, readlink '${bash_normalize_path(path)}'`);
	}

	async lstat(path: string) {
		return this.stat(path);
	}

	async realpath(path: string) {
		const normalizedPath = bash_normalize_path(path);
		await this.stat(normalizedPath);
		return normalizedPath;
	}

	async utimes(path: string, _atime: Date, _mtime: Date) {
		throw new ReadOnlyFileSystemError(path);
	}
}

/**
 * Create the app-shell filesystem and Bash runtime for an agent thread.
 */
async function bash_fs_create(args: {
	ctx: ActionCtx;
	organizationId: Id<"organizations">;
	workspaceId: Id<"organizations_workspaces">;
	organizationName: string;
	workspaceName: string;
	userId: Id<"users">;
	threadId: Id<"ai_chat_threads">;
	persistedCwd: string;
	allowDbFilesMkdir: boolean;
	githubMounts: Doc<"github_mounts">[];
	pluginSourceMounts: plugins_list_bash_source_mounts_Result;
}) {
	// Organization and workspace names are validated slugs, so they are stable shell
	// path segments and do not need path-segment encoding here.
	const currentWorkspacePath = `${bash_APP_MOUNT_PATH}/${args.organizationName}/${args.workspaceName}`;

	const tmpFs = await BashTmpFs.create(args.ctx, args.threadId);

	const appDbFilesFs = new bash_DbFilesFs({
		ctx: args.ctx,
		ctxData: {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			organizationName: args.organizationName,
			workspaceName: args.workspaceName,
			userId: args.userId,
			threadId: args.threadId,
		},
		currentWorkspacePath,
		allowDbFilesMkdir: args.allowDbFilesMkdir,
	});

	// Each synced GitHub mount doc gets its own read-only mount at `/.mounts/<name>`, backed by the
	// commit-keyed tree `/<name>/<commitSha>/...` in the reserved `GLOBAL`/`GITHUB` scope. Only
	// mounts with a finished sync (`lastCommitSha` set) are visible, and the sha is pinned for
	// this run, so a pointer flip mid-run never tears reads. `MountableFs` synthesizes the
	// `/.mounts` parent listing from these mount points, so with zero synced mounts `/.mounts`
	// does not exist at all.
	const externalMounts = new Map(
		args.githubMounts.flatMap((mount) => {
			const commitSha = mount.lastCommitSha;
			if (commitSha == null) {
				return [];
			}
			const mountWorkspacePath = `${bash_EXTERNAL_MOUNTS_ROOT}/${mount.name}`;
			const mountFs = new bash_DbFilesFs({
				ctx: args.ctx,
				ctxData: {
					organizationId: organizations_GLOBAL_ORGANIZATION_ID,
					workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
					organizationName: "GLOBAL",
					workspaceName: "GITHUB",
					userId: args.userId,
					// Read-only mount: never writes pending updates, so no thread to stamp.
					threadId: null,
				},
				currentWorkspacePath: mountWorkspacePath,
				allowDbFilesMkdir: false,
				dbFilesPathPrefix: `/${mount.name}/${commitSha}`,
				readOnlySource: "codebase",
			});
			return [
				[
					mount.name,
					{
						name: mount.name,
						commitSha,
						fs: mountFs,
					},
				] as const,
			];
		}),
	);

	// Each enabled plugin installation gets its own read-only mount at `/.plugins/<pluginName>`,
	// backed by the version-keyed tree `/<pluginVersionId>/...` in the reserved `GLOBAL`/`PLUGINS`
	// scope. `MountableFs` synthesizes the `/.plugins` parent listing from these mount points, so
	// with zero installations `/.plugins` does not exist at all.
	const pluginMounts = new Map(
		args.pluginSourceMounts.map((installation) => {
			const pluginWorkspacePath = `${bash_PLUGINS_MOUNT_ROOT}/${installation.pluginName}`;
			const pluginFs = new bash_DbFilesFs({
				ctx: args.ctx,
				ctxData: {
					organizationId: organizations_GLOBAL_ORGANIZATION_ID,
					workspaceId: organizations_GLOBAL_PLUGINS_WORKSPACE_ID,
					organizationName: "GLOBAL",
					workspaceName: "PLUGINS",
					userId: args.userId,
					// Read-only mount: never writes pending updates, so no thread to stamp.
					threadId: null,
				},
				currentWorkspacePath: pluginWorkspacePath,
				allowDbFilesMkdir: false,
				dbFilesPathPrefix: `/${installation.pluginVersionId}`,
				readOnlySource: "plugins",
			});
			return [
				installation.pluginName,
				{
					pluginName: installation.pluginName,
					fs: pluginFs,
				},
			] as const;
		}),
	);

	const fs = new MountableFs({
		base: new ReadOnlyBaseFs(),
		mounts: [
			{ mountPoint: currentWorkspacePath, filesystem: appDbFilesFs },
			...Array.from(externalMounts.values(), (mount) => ({
				mountPoint: mount.fs.currentWorkspacePath,
				filesystem: mount.fs,
			})),
			...Array.from(pluginMounts.values(), (mount) => ({
				mountPoint: mount.fs.currentWorkspacePath,
				filesystem: mount.fs,
			})),
			{ mountPoint: bash_TMP_MOUNT, filesystem: tmpFs },
		],
	});

	const dbFilesRoots: bash_DbFilesRoots = {
		app: {
			currentWorkspacePath,
			fs: appDbFilesFs,
		},
		externalMounts: {
			currentWorkspacePath: bash_EXTERNAL_MOUNTS_ROOT,
			mounts: externalMounts,
		},
		plugins: {
			currentWorkspacePath: bash_PLUGINS_MOUNT_ROOT,
			mounts: pluginMounts,
		},
	};

	// The visible path the user's own pending move gives this app path, or null when untouched.
	const project_pending_moved_path = async (path: string) => {
		const dbFilesPath = bash_current_workspace_path_to_db_files_path(currentWorkspacePath, bash_normalize_path(path));
		if (dbFilesPath == null || dbFilesPath === "/") {
			return null;
		}
		const overlay = await appDbFilesFs.getOverlay();
		if (overlay == null) {
			return null;
		}
		const visiblePath = files_pending_path_overlay_project_committed_path(overlay, dbFilesPath);
		if (visiblePath == null || visiblePath === dbFilesPath) {
			return null;
		}
		return bash_db_files_path_to_current_workspace_path(currentWorkspacePath, visiblePath);
	};

	// The persisted cwd can vanish between runs (deleted folder, pruned /tmp).
	const requestedCwd = args.persistedCwd === DEFAULT_CWD ? currentWorkspacePath : args.persistedCwd;
	let cwd = (await nearest_existing_dir(fs, requestedCwd)) ?? currentWorkspacePath;
	// A persisted cwd vacated by the user's own pending move (proposed in another chat)
	// follows the move to its visible destination instead of climbing out of it.
	if (cwd !== bash_normalize_path(requestedCwd)) {
		const movedCwd = await project_pending_moved_path(requestedCwd);
		if (movedCwd != null && (await nearest_existing_dir(fs, movedCwd)) === movedCwd) {
			cwd = movedCwd;
		}
	}

	const shell = bash_shell_create(args.ctx, { fs, cwd, dbFilesRoots });
	return {
		cwd,
		currentWorkspacePath,
		...shell,
		nearest_existing_dir: (path: string) => nearest_existing_dir(fs, path),
		project_pending_moved_path,
		evict_tmp_to_limits: () => tmp_fs_evict_to_limits(tmpFs),
		create_tmp_patch: async () => {
			if (!tmpFs.dirty) {
				return null;
			}
			return await tmp_fs_delta_payload(tmpFs);
		},
		mark_tmp_clean: () => {
			tmpFs.dirty = false;
		},
		path_index_truncated: () => appDbFilesFs.pathIndexTruncated,
		truncate_output,
		format_output: format_bash_output,
	};
}

function bash_shell_create(ctx: ActionCtx, args: { fs: MountableFs; cwd: string; dbFilesRoots: bash_DbFilesRoots }) {
	const { fs, cwd, dbFilesRoots } = args;
	const currentWorkspacePath = dbFilesRoots.app.currentWorkspacePath;
	// App commands answer a usage mistake on stderr, usually with a `Try:` line naming the command
	// that works. That answer is tool guidance, not program output, but `2>/dev/null` deletes it and
	// a pipe replaces the non-zero exit with the last stage's 0 — leaving an empty stdout and exit 0
	// that reads as "nothing is there". Record what each app command really printed so the run can
	// restore guidance the shell swallowed.
	const appCommandDiagnostics: { name: string; exitCode: number; stderr: string }[] = [];
	const record_app_command_diagnostics = (command: Command): Command => ({
		...command,
		execute: async (commandArgs, commandCtx) => {
			const result = await command.execute(commandArgs, commandCtx);
			if (result.exitCode !== 0 && result.stderr) {
				appCommandDiagnostics.push({ name: command.name, exitCode: result.exitCode, stderr: result.stderr });
			}
			return result;
		},
	});

	const bash = new Bash({
		fs,
		cwd,
		env: {
			HOME: bash_HOME,
		},
		commands: bash_ALLOWED_COMMANDS,
		customCommands: [
			// Indexed app discovery.
			bash_search_command_create(ctx, dbFilesRoots),
			bash_meta_command_create(ctx, dbFilesRoots),
			bash_ls_command_create(ctx, dbFilesRoots),
			bash_find_command_create(ctx, dbFilesRoots),
			bash_tree_command_create(ctx, dbFilesRoots),
			bash_grep_command_create(ctx, dbFilesRoots),
			bash_textgrep_command_create(ctx, dbFilesRoots),
			// App readers.
			bash_cat_command_create(ctx, dbFilesRoots),
			bash_head_tail_wc_command_create(ctx, dbFilesRoots, "head"),
			bash_head_tail_wc_command_create(ctx, dbFilesRoots, "tail"),
			bash_head_tail_wc_command_create(ctx, dbFilesRoots, "wc"),
			bash_stat_command_create(ctx, dbFilesRoots),
			...stream_utility_command_create_all(currentWorkspacePath),
			bash_sed_command_create(ctx, dbFilesRoots),
			// Guarded mutators.
			bash_touch_command_create(dbFilesRoots),
			...(dbFilesRoots.app.fs.readOnlySource == null
				? [
						bash_rm_command_create(ctx, dbFilesRoots),
						bash_cp_command_create(ctx, dbFilesRoots),
						bash_mv_command_create(ctx, dbFilesRoots),
					]
				: []),
			bash_tee_command_create(dbFilesRoots),
			// Nested execution.
			bash_nested_shell_command_create("bash", currentWorkspacePath),
			bash_nested_shell_command_create("sh", currentWorkspacePath),
			// xargs/which.
			bash_xargs_command_create(),
			bash_which_command_create(),
			// Native /tmp wrappers.
			...native_just_bash_tmp_command_create_all(currentWorkspacePath),
		].map(record_app_command_diagnostics),
		executionLimits: {
			maxCommandCount: 200,
			maxLoopIterations: 10_000,
			maxCallDepth: 50,
			maxOutputSize: 250_000,
			maxHeredocSize: 250_000,
		},
	});

	return {
		run_command: async (command: string) => {
			// Block app and read-only mount files before Just Bash can load their
			// contents as shell code through direct or nested commands.
			if (await bash_command_loads_disallowed_shell_code(command, { cwd, fs })) {
				return {
					stdout: "",
					stderr: bash_disallowed_shell_code_error(),
					exitCode: bash_COMMAND_EXIT_CANNOT_EXECUTE,
					env: {
						PWD: cwd,
					},
				};
			}

			// Surface unexpected Just Bash failures as terminal stderr instead of
			// failing the Convex action.
			const result = await bash.exec(command).catch((error: unknown) => ({
				stdout: "",
				stderr: `${error instanceof Error ? error.message : String(error)}\n`,
				exitCode: bash_COMMAND_EXIT_FAILURE,
					env: {
						PWD: cwd,
					},
			}));
			return result;
		},
		app_command_diagnostics: () => appCommandDiagnostics,
	};
}

export async function bash_run_plugin_review_command(
	ctx: ActionCtx,
	args: { reviewRoot: string; userId: Id<"users">; command: string; cwd: string; scratch: bash_ReviewScratch },
) {
	// Only the host supplies this root. Never accept a tenant or published-version path here.
	if (!/^\/review-[a-f0-9]{32}$/u.test(args.reviewRoot)) {
		throw new Error("Invalid plugin review root");
	}
	const currentWorkspacePath = `${bash_PLUGINS_MOUNT_ROOT}/review`;
	const sourceFs = new bash_DbFilesFs({
		ctx,
		ctxData: {
			organizationId: organizations_GLOBAL_ORGANIZATION_ID,
			workspaceId: organizations_GLOBAL_PLUGINS_WORKSPACE_ID,
			organizationName: "GLOBAL",
			workspaceName: "PLUGINS",
			userId: args.userId,
			threadId: null,
		},
		currentWorkspacePath,
		dbFilesPathPrefix: args.reviewRoot,
		readOnlySource: "plugins",
		allowDbFilesMkdir: false,
	});
	const tmpFs = await BashTmpFs.from_files(args.scratch);
	const fs = new MountableFs({
		base: new ReadOnlyBaseFs(),
		mounts: [
			{ mountPoint: currentWorkspacePath, filesystem: sourceFs },
			{ mountPoint: bash_TMP_MOUNT, filesystem: tmpFs },
		],
	});
	const cwd = (await nearest_existing_dir(fs, args.cwd)) ?? currentWorkspacePath;
	const shell = bash_shell_create(ctx, {
		fs,
		cwd,
		dbFilesRoots: {
			// Unscoped search/meta from /tmp uses this root, so it must stay inside this review.
			app: { currentWorkspacePath, fs: sourceFs },
			externalMounts: { currentWorkspacePath: bash_EXTERNAL_MOUNTS_ROOT, mounts: new Map() },
			plugins: {
				currentWorkspacePath: bash_PLUGINS_MOUNT_ROOT,
				mounts: new Map([["review", { pluginName: "review", fs: sourceFs }]]),
			},
		},
	});
	const result = await shell.run_command(args.command);
	for (const diagnostic of shell.app_command_diagnostics()) {
		if (!result.stdout.includes(diagnostic.stderr.trim()) && !result.stderr.includes(diagnostic.stderr.trim())) {
			result.stderr += `${diagnostic.name} exited ${diagnostic.exitCode}: ${diagnostic.stderr}`;
		}
	}
	result.stderr += await tmp_fs_evict_to_limits(tmpFs);
	const nextCwd = (await nearest_existing_dir(fs, result.env.PWD || cwd)) ?? currentWorkspacePath;
	// Return the bounded scratch snapshot to this review, without creating a UI chat thread.
	tmpFs.baselinePaths.clear();
	const { fileNodes, fileNodesContentDict } = await tmp_fs_delta_payload(tmpFs);
	return {
		output: format_bash_output({
			command: args.command,
			cwd,
			nextCwd,
			exitCode: result.exitCode,
			stdout: truncate_output(result.stdout).value,
			stderr: truncate_output(result.stderr).value,
		}),
		exitCode: result.exitCode,
		cwd: nextCwd,
		scratch: { fileNodes, fileNodesContentDict },
	};
}

/**
 * Run one app-shell command for an agent thread.
 *
 * Lifecycle: load thread state, mount Convex app files and durable `/tmp`,
 * execute the command, add agent-friendly diagnostics, persist cwd and `/tmp`
 * deltas, then return the formatted transcript and metadata.
 */
export async function bash_run_command(
	ctx: ActionCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		organizationName: string;
		workspaceName: string;
		userId: Id<"users">;
		threadId: Id<"ai_chat_threads">;
		command: string;
		allowDbFilesMkdir: boolean;
	},
) {
	// Mount visibility is decided per run: only plugins with an enabled installation in this
	// workspace appear under `/.plugins`, and only GitHub mounts with a finished sync appear
	// under `/.mounts` (their commit sha is pinned for the whole run).
	const [threadState, githubMounts, pluginSourceMounts] = await Promise.all([
		ctx.runQuery(internal.ai_chat.get_thread_state, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			threadId: args.threadId,
		}) as Promise<ai_chat_get_thread_state_Result>,
		ctx.runQuery(internal.github_mounts.list_mounts, {}) as Promise<Doc<"github_mounts">[]>,
		ctx.runQuery(internal.plugins.list_bash_source_mounts, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
		}) as Promise<plugins_list_bash_source_mounts_Result>,
	]);

	const bashFs = await bash_fs_create({
		ctx,
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		organizationName: args.organizationName,
		workspaceName: args.workspaceName,
		userId: args.userId,
		threadId: args.threadId,
		persistedCwd: threadState.bashCwd,
		allowDbFilesMkdir: args.allowDbFilesMkdir,
		githubMounts,
		pluginSourceMounts,
	});

	const result = await bashFs.run_command(args.command);

	// PWD is an ordinary shell variable; a command can unset or empty it, in
	// which case we assume the shell did not move.
	const rawNextCwd = result.env.PWD || bashFs.cwd;
	// A command can delete its own cwd; climb to the nearest surviving directory.
	let nextCwd = (await bashFs.nearest_existing_dir(rawNextCwd)) ?? bashFs.currentWorkspacePath;
	// A cwd vacated by the user's own pending move (mv of the cwd or an ancestor) follows
	// the move to its visible destination instead of climbing out of it.
	if (nextCwd !== bash_normalize_path(rawNextCwd)) {
		const movedCwd = await bashFs.project_pending_moved_path(rawNextCwd);
		if (movedCwd != null && (await bashFs.nearest_existing_dir(movedCwd)) === movedCwd) {
			nextCwd = movedCwd;
		}
	}
	const redirectsStderrToStdout = REDIRECTS_STDERR_TO_STDOUT_REGEX.test(args.command);

	if (
		COMMAND_NOT_FOUND_REGEX.test(result.stderr) ||
		(redirectsStderrToStdout && COMMAND_NOT_FOUND_REGEX.test(result.stdout))
	) {
		result.stderr +=
			"bash: run 'help' to list available commands; app files are db-backed — use search/grep for content and find/ls for paths.\n";
		const filePathMatch = FILE_COMMAND_OPERAND_REGEX.exec(args.command.replace(bash_SHELL_COMMENT_LINE_REGEX, ""));
		if (filePathMatch?.[1] != null) {
			const target = bash_shell_arg_quote(filePathMatch[1]);
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

	// Restore app-command guidance the shell swallowed. `find … 2>/dev/null | head` discards the
	// `Try:` line and reports exit 0, so the model sees an empty successful result and can report
	// "no matching files" as fact. The guidance is the tool answering the mistake, so it survives
	// redirection; anything still visible in the transcript is skipped so nothing is printed twice.
	const restoredDiagnostics = new Set<string>();
	for (const diagnostic of bashFs.app_command_diagnostics()) {
		const guidance = diagnostic.stderr.trim();
		if (!guidance || restoredDiagnostics.has(guidance)) {
			continue;
		}
		if (result.stdout.includes(guidance) || result.stderr.includes(guidance)) {
			continue;
		}
		restoredDiagnostics.add(guidance);
		result.stderr += `bash: ${diagnostic.name} exited ${diagnostic.exitCode} and its stderr was discarded; it said:\n${guidance}\n`;
	}

	// Only paths under HOME, `/tmp`, and the read-only `/.mounts` and `/.plugins` trees survive between
	// runs (`/tmp` is restored from the db; mounts are reconstructed from the reserved scopes; everything
	// else is synthetic mount scaffolding). A `/.plugins` cwd can still vanish when the plugin is
	// uninstalled; the nearest-existing-dir climb above already handles that.
	if (
		nextCwd !== bash_HOME &&
		!nextCwd.startsWith(`${bash_HOME}/`) &&
		nextCwd !== bash_TMP_MOUNT &&
		!nextCwd.startsWith(`${bash_TMP_MOUNT}/`) &&
		nextCwd !== bash_EXTERNAL_MOUNTS_ROOT &&
		!nextCwd.startsWith(`${bash_EXTERNAL_MOUNTS_ROOT}/`) &&
		nextCwd !== bash_PLUGINS_MOUNT_ROOT &&
		!nextCwd.startsWith(`${bash_PLUGINS_MOUNT_ROOT}/`)
	) {
		console.warn("Bash cwd is not persistable, resetting to the app root", {
			threadId: args.threadId,
			cwd: rawNextCwd,
		});
		nextCwd = bashFs.currentWorkspacePath;
	}

	// `/tmp` persists to the db, so bound its durable footprint before flushing:
	// discard files over the per-file cap, then evict the oldest leaves (files,
	// symlinks, and empty directories, by mtime then path) until both thread
	// caps are satisfied — this call's writes have fresh mtimes and survive.
	// Deletions go through `tmpFs.rm` so they mark the fs dirty and reach the db.
	result.stderr += await bashFs.evict_tmp_to_limits();

	const pendingMutations: Promise<unknown>[] = [];
	const tmpPatch = await bashFs.create_tmp_patch();
	if (tmpPatch) {
		pendingMutations.push(
			ctx.runMutation(internal.ai_chat_files.patch_thread_tmp_files, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				threadId: args.threadId,
				fileNodes: tmpPatch.fileNodes,
				fileNodesContentDict: tmpPatch.fileNodesContentDict,
				deletePaths: tmpPatch.deletePaths,
			}),
		);
		bashFs.mark_tmp_clean();
	}

	const stdoutLength = result.stdout.length;
	const stderrLength = result.stderr.length;
	const stdout = bashFs.truncate_output(result.stdout);
	const truncatedStderr = bashFs.truncate_output(result.stderr);

	const threadStateUpdated = nextCwd !== threadState.bashCwd;
	if (threadStateUpdated) {
		pendingMutations.push(
			ctx.runMutation(internal.ai_chat.set_thread_state, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				threadId: args.threadId,
				userId: args.userId,
				patch: {
					bashCwd: nextCwd,
				},
			}),
		);
	}

	await Promise.all(pendingMutations);

	const pathIndexTruncated = bashFs.path_index_truncated();
	console.debug("Bash command completed", {
		threadId: args.threadId,
		commandName: args.command.trim().split(bash_WHITESPACE_RUN_REGEX, 1)[0] ?? "",
		exitCode: result.exitCode,
		stdoutLength,
		stderrLength,
		threadStateUpdated,
		pathIndexTruncated,
	});

	return {
		title: `exit ${result.exitCode} · ${nextCwd}`,
		output: bashFs.format_output({
			command: args.command,
			cwd: bashFs.cwd,
			nextCwd,
			exitCode: result.exitCode,
			stdout: stdout.value,
			stderr: truncatedStderr.value,
		}),
		stdout: stdout.value,
		stderr: truncatedStderr.value,
		metadata: {
			command: args.command,
			cwd: bashFs.cwd,
			nextCwd,
			exitCode: result.exitCode,
			stdoutTruncated: stdout.truncated,
			stderrTruncated: truncatedStderr.truncated,
			stdoutLength,
			stderrLength,
			pathIndexTruncated,
		},
	};
}

// #endregion action

// #region tests
// Vitest sets NODE_ENV to "test"; Convex's bundler defines it as "production",
// so keep that check first to let esbuild erase `import.meta.vitest` before analysis.
if (process.env.NODE_ENV === "test" && import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest;

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

	describe("format_bash_output", () => {
		test("renders a terminal prompt with stdout and exit status", () => {
			const result = format_bash_output({
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
			const result = format_bash_output({
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
			const result = format_bash_output({
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
			const result = format_bash_output({
				command: "cat missing.md",
				cwd: "/home/cloud-usr",
				nextCwd: "/home/cloud-usr",
				exitCode: bash_COMMAND_EXIT_FAILURE,
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
}
// #endregion tests
