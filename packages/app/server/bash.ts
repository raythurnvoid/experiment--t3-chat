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

import { getFunctionName } from "convex/server";
import {
	Bash,
	defineCommand,
	InMemoryFs,
	MountableFs,
	type CommandName,
	type CpOptions,
	type FileContent,
	type FsStat,
	type IFileSystem,
	type MkdirOptions,
	type RmOptions,
} from "just-bash/browser";
import { internal } from "../convex/_generated/api.js";
import type { ActionCtx, MutationCtx } from "../convex/_generated/server.js";
import type { Id } from "../convex/_generated/dataModel";
import type { ai_chat_get_thread_state_Result } from "../convex/ai_chat.ts";
import type {
	ai_chat_files_load_thread_tmp_files_Result,
	ai_chat_files_patch_thread_tmp_files_Args,
} from "../convex/ai_chat_files.ts";
import { files_ROOT_ID, files_get_utf8_byte_size } from "../shared/files.ts";
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
	bash_ALLOWED_COMMANDS,
	bash_APP_MOUNT_PATH,
	bash_EXTERNAL_MOUNTS_ROOT,
	bash_PLUGINS_MOUNT_ROOT,
	bash_command_has_disallowed_source_target,
	bash_delegate_native_just_bash_tmp_command,
	bash_DEV_NULL_PATH,
	bash_DEV_ZERO_BYTE_COUNT,
	bash_DEV_ZERO_PATH,
	bash_DEV_ZERO_TEXT,
	bash_get_db_file_byte_size,
	bash_HOME,
	bash_normalize_path,
	bash_READER_FILE_OPERAND_MAX,
	bash_READ_HEAD_LARGE_FILE_MAX_LINES,
	bash_READ_INLINE_MAX_BYTES,
	bash_resolve_path,
	bash_shell_arg_quote,
	bash_disallowed_source_target_error,
	bash_TMP_MOUNT,
	bash_DbFilesFs,
	bash_COMMAND_EXIT_FAILURE,
	bash_COMMAND_EXIT_USAGE,
	bash_COMMAND_EXIT_CANNOT_EXECUTE,
	bash_COMMAND_EXIT_NOT_FOUND,
	bash_TERMINAL_LINE_ENDING_REGEX,
	bash_SHELL_COMMENT_LINE_REGEX,
	bash_WHITESPACE_RUN_REGEX,
	type bash_DbFilesRoots,
} from "./bash-utils.ts";
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
			`EROFS: read-only file system, '${normalizedPath}'. Persistent app-file writes must use write_file/edit_file; shell redirects into app files are unsupported.`,
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

		const tmpFs = new BashTmpFs();
		for (const tmpFile of loaded.file_nodes) {
			if (tmpFile.kind === "directory") {
				await tmpFs.fs.mkdir(tmpFile.path, { recursive: true });
				await tmpFs.fs.chmod(tmpFile.path, tmpFile.mode);
				await tmpFs.fs.utimes(tmpFile.path, new Date(tmpFile.mtime), new Date(tmpFile.mtime));
			} else if (tmpFile.kind === "symlink") {
				await tmpFs.fs.symlink(tmpFile.symlinkTargetPath ?? "", tmpFile.path);
				await tmpFs.fs.chmod(tmpFile.path, tmpFile.mode);
			} else {
				const bytes = loaded.file_nodes_content_dict[tmpFile._id]?.bytes ?? new ArrayBuffer(0);
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
		},
		currentWorkspacePath,
		allowDbFilesMkdir: args.allowDbFilesMkdir,
	});

	// Read-only external mounts share one reserved-scope (`GLOBAL`/`GITHUB`) filesystem mounted at
	// `/.mounts`. `MountableFs` strips `/.mounts`, so this FS receives the stored `/<name>/<rel>` path
	// directly. Mount visibility is whatever top-level folders exist in that reserved files tree.
	const externalMountsDbFilesFs = new bash_DbFilesFs({
		ctx: args.ctx,
		ctxData: {
			organizationId: organizations_GLOBAL_ORGANIZATION_ID,
			workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
			organizationName: "GLOBAL",
			workspaceName: "GITHUB",
			userId: args.userId,
		},
		currentWorkspacePath: bash_EXTERNAL_MOUNTS_ROOT,
		allowDbFilesMkdir: false,
		readOnlySource: "codebase",
	});

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
					pluginVersionId: installation.pluginVersionId,
					fs: pluginFs,
				},
			] as const;
		}),
	);

	const fs = new MountableFs({
		base: new ReadOnlyBaseFs(),
		mounts: [
			{ mountPoint: currentWorkspacePath, filesystem: appDbFilesFs },
			{ mountPoint: bash_EXTERNAL_MOUNTS_ROOT, filesystem: externalMountsDbFilesFs },
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
			fs: externalMountsDbFilesFs,
		},
		plugins: {
			currentWorkspacePath: bash_PLUGINS_MOUNT_ROOT,
			mounts: pluginMounts,
		},
	};

	// The persisted cwd can vanish between runs (deleted folder, pruned /tmp).
	const cwd =
		(await nearest_existing_dir(fs, args.persistedCwd === DEFAULT_CWD ? currentWorkspacePath : args.persistedCwd)) ??
		currentWorkspacePath;

	const bash = new Bash({
		fs,
		cwd,
		env: {
			HOME: bash_HOME,
		},
		commands: bash_ALLOWED_COMMANDS,
		customCommands: [
			// Indexed app discovery.
			bash_search_command_create(args.ctx, dbFilesRoots),
			bash_meta_command_create(args.ctx, dbFilesRoots),
			bash_ls_command_create(args.ctx, dbFilesRoots),
			bash_find_command_create(args.ctx, dbFilesRoots),
			bash_tree_command_create(args.ctx, dbFilesRoots),
			bash_grep_command_create(args.ctx, dbFilesRoots),
			bash_textgrep_command_create(args.ctx, dbFilesRoots),
			// App readers.
			bash_cat_command_create(args.ctx, dbFilesRoots),
			bash_head_tail_wc_command_create(args.ctx, dbFilesRoots, "head"),
			bash_head_tail_wc_command_create(args.ctx, dbFilesRoots, "tail"),
			bash_head_tail_wc_command_create(args.ctx, dbFilesRoots, "wc"),
			bash_stat_command_create(args.ctx, dbFilesRoots),
			...stream_utility_command_create_all(currentWorkspacePath),
			bash_sed_command_create(args.ctx, dbFilesRoots),
			// Guarded mutators.
			bash_touch_command_create(currentWorkspacePath),
			bash_rm_command_create(currentWorkspacePath),
			bash_cp_command_create(currentWorkspacePath),
			bash_mv_command_create(currentWorkspacePath),
			bash_tee_command_create(currentWorkspacePath),
			// Nested execution.
			bash_nested_shell_command_create("bash", currentWorkspacePath),
			bash_nested_shell_command_create("sh", currentWorkspacePath),
			// xargs/which.
			bash_xargs_command_create(),
			bash_which_command_create(),
			// Native /tmp wrappers.
			...native_just_bash_tmp_command_create_all(currentWorkspacePath),
		],
		executionLimits: {
			maxCommandCount: 200,
			maxLoopIterations: 10_000,
			maxCallDepth: 50,
			maxOutputSize: 250_000,
			maxHeredocSize: 250_000,
		},
	});

	return {
		cwd,
		currentWorkspacePath,
		run_command: async (command: string) => {
			// `source` and `.` execute inside the current shell, so block mounted
			// file targets before Just Bash can load them.
			if (bash_command_has_disallowed_source_target(command, { cwd, currentWorkspacePath })) {
				return {
					stdout: "",
					stderr: bash_disallowed_source_target_error(),
					exitCode: bash_COMMAND_EXIT_CANNOT_EXECUTE,
					env: {
						PWD: cwd,
					},
				};
			}

			// Surface unexpected Just Bash failures as terminal stderr instead of
			// failing the Convex action.
			return await bash.exec(command).catch((error: unknown) => ({
				stdout: "",
				stderr: `${error instanceof Error ? error.message : String(error)}\n`,
				exitCode: bash_COMMAND_EXIT_FAILURE,
				env: {
					PWD: cwd,
				},
			}));
		},
		nearest_existing_dir: (path: string) => nearest_existing_dir(fs, path),
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
	// Plugin source visibility is decided per run: only plugins with an enabled
	// installation in this workspace appear under `/.plugins`.
	const [threadState, pluginSourceMounts] = await Promise.all([
		ctx.runQuery(internal.ai_chat.get_thread_state, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			threadId: args.threadId,
		}) as Promise<ai_chat_get_thread_state_Result>,
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
		pluginSourceMounts,
	});

	const result = await bashFs.run_command(args.command);

	// PWD is an ordinary shell variable; a command can unset or empty it, in
	// which case we assume the shell did not move.
	const rawNextCwd = result.env.PWD || bashFs.cwd;
	// A command can delete its own cwd; climb to the nearest surviving directory.
	let nextCwd = (await bashFs.nearest_existing_dir(rawNextCwd)) ?? bashFs.currentWorkspacePath;
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

// Vitest sets NODE_ENV to "test"; Convex's bundler defines it as "production",
// so keep that check first to let esbuild erase `import.meta.vitest` before analysis.
if (process.env.NODE_ENV === "test" && import.meta.vitest) {
	const { describe, test, expect, vi, beforeEach, afterEach } = import.meta.vitest;

	const test_db_files_mount = "/home/cloud-usr/w/personal/home";
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

	describe("action_run", () => {
		const test_organization_name = "personal";
		const test_workspace_name = "home";

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

		// Mirrors the old mock organization tree; contents are canonical for every test that reads them.
		const default_organization_files: BashSeedSpec[] = [
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

		async function seed_organization_folder(
			ctx: MutationCtx,
			scope: { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces">; userId: Id<"users"> },
			path: string,
			updatedAt: number,
		) {
			const { test_mocks } = await import("../convex/setup.test.ts");
			const segments = path.split("/").filter(Boolean);
			let parentId: Id<"files_nodes"> | typeof files_ROOT_ID = files_ROOT_ID;
			for (let depth = 1; depth <= segments.length; depth++) {
				const ancestorPath = `/${segments.slice(0, depth).join("/")}`;
				const existing = await ctx.db
					.query("files_nodes")
					.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
						q
							.eq("organizationId", scope.organizationId)
							.eq("workspaceId", scope.workspaceId)
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
					organizationId: scope.organizationId,
					workspaceId: scope.workspaceId,
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

		async function seed_organization_node(
			ctx: MutationCtx,
			scope: { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces">; userId: Id<"users"> },
			spec: BashSeedSpec,
			seedIndex: number,
		) {
			const { test_mocks } = await import("../convex/setup.test.ts");
			const { db_insert_file_text_content } = await import("../convex/files_nodes.ts");
			// Deterministic, distinct recency: later seeds are newer.
			const updatedAt = spec.updatedAt ?? Date.now() - 1_000_000 + seedIndex * 1000;
			const segments = spec.path.split("/").filter(Boolean);
			if (spec.kind === "folder") {
				await seed_organization_folder(ctx, scope, spec.path, updatedAt);
				return;
			}
			const parentId =
				segments.length > 1
					? await seed_organization_folder(ctx, scope, `/${segments.slice(0, -1).join("/")}`, updatedAt)
					: files_ROOT_ID;
			const name = segments[segments.length - 1];
			const dotIndex = name.lastIndexOf(".");
			const content = spec.content ?? "";
			const bytes = new TextEncoder().encode(content);
			const fileId = await ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: scope.organizationId,
				workspaceId: scope.workspaceId,
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
				organizationId: scope.organizationId,
				workspaceId: scope.workspaceId,
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
				organizationId: scope.organizationId,
				workspaceId: scope.workspaceId,
				kind: "yjs_snapshot",
				r2Bucket: "test",
				size: 0,
				createdBy: scope.userId,
				updatedAt,
			});
			const yjsSnapshotId = await ctx.db.insert("files_yjs_snapshots", {
				organizationId: scope.organizationId,
				workspaceId: scope.workspaceId,
				fileNodeId: fileId,
				sequence: 1,
				assetId: yjsSnapshotAssetId,
				createdBy: scope.userId,
				updatedBy: scope.userId,
				updatedAt,
			});
			const yjsLastSequenceId = await ctx.db.insert("files_yjs_docs_last_sequences", {
				organizationId: scope.organizationId,
				workspaceId: scope.workspaceId,
				fileNodeId: fileId,
				lastSequence: 1,
			});
			await ctx.db.patch("files_nodes", fileId, { assetId, yjsSnapshotId, yjsLastSequenceId });
			if (spec.materialized === false) {
				return;
			}
			const chunked = await db_insert_file_text_content(ctx, {
				organizationId: scope.organizationId,
				workspaceId: scope.workspaceId,
				nodeId: fileId,
				path: spec.path,
				yjsSequence: 1,
				contentType: spec.contentType ?? "text/markdown;charset=utf-8",
				textContent: content,
			});
			if (chunked._nay) {
				throw new Error(`Seed chunking failed for ${spec.path}: ${chunked._nay.message}`);
			}
			if (spec.brokenChunks) {
				// Materialization anomaly: break the verbatim chunk tiling so chunk-backed readers
				// bail out (usable: false) and the bounded R2 window fallback runs instead.
				const chunks = await ctx.db
					.query("files_markdown_chunks")
					.withIndex("by_organization_workspace_source_fileNode_yjsSeq_chunk", (q) =>
						q
							.eq("organizationId", scope.organizationId)
							.eq("workspaceId", scope.workspaceId)
							.eq("sourceKind", "committed")
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
						organizationId: scope.organizationId,
						workspaceId: scope.workspaceId,
						fileNodeId: fileId,
						sourceKind: "committed",
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
			allowDbFilesMkdir?: boolean;
			extraFiles?: BashSeedSpec[];
			/** Reuse another runner's database (fresh thread, no default tree re-seed). */
			shared?: {
				t: unknown;
				seeded: {
					userId: Id<"users">;
					organizationId: Id<"organizations">;
					workspaceId: Id<"organizations_workspaces">;
					membershipId: Id<"organizations_workspaces_users">;
				};
			};
			/** Acting user override for the action args (scoping tests). */
			userId?: Id<"users">;
			/** Attach to an existing thread instead of creating one (tmp-scope tests). */
			threadId?: Id<"ai_chat_threads">;
		}) {
			const { test_convex, test_mocks_fill_db_with } = await import("../convex/setup.test.ts");
			const { api } = await import("../convex/_generated/api.js");

			test_runner_counter += 1;
			const runnerIndex = test_runner_counter;

			const t = (opts?.shared?.t as ReturnType<typeof test_convex> | undefined) ?? test_convex();
			const seeded =
				opts?.shared?.seeded ??
				(await t.run((ctx) =>
					test_mocks_fill_db_with.membership(ctx, {
						organizationName: test_organization_name,
						workspaceName: test_workspace_name,
					}),
				));
			const actingUserId = opts?.userId ?? seeded.userId;

			const seedSpecs = [...(opts?.shared ? [] : default_organization_files), ...(opts?.extraFiles ?? [])];
			if (seedSpecs.length > 0) {
				await t.run(async (ctx) => {
					for (const [seedIndex, spec] of seedSpecs.entries()) {
						await seed_organization_node(
							ctx,
							{ organizationId: seeded.organizationId, workspaceId: seeded.workspaceId, userId: seeded.userId },
							spec,
							seedIndex,
						);
					}
				});
			}

			let threadId: Id<"ai_chat_threads">;
			if (opts?.threadId != null) {
				threadId = opts.threadId;
			} else {
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
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					threadId,
					userId: seeded.userId,
					patch: { bashCwd: opts.initialCwd },
				});
				cwd = state.bashCwd ?? opts.initialCwd;
			}

			// Spy-delegate ctx: every downstream function runs for real against the in-memory db
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
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				organizationName: test_organization_name,
				workspaceName: test_workspace_name,
				userId: actingUserId,
			};

			const run = async (command: string) => {
				const result = await bash_run_command(ctx, {
					...ctxData,
					threadId,
					command,
					allowDbFilesMkdir: opts?.allowDbFilesMkdir ?? true,
				});
				const state = await t.query(internal.ai_chat.get_thread_state, {
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					threadId,
				});
				cwd = state.bashCwd ?? cwd;
				return result;
			};

			return { run, runQuery, runMutation, runAction, getCwd: () => cwd, t, seeded, threadId, ctxData, ctx };
		}

		async function get_seeded_node(runner: Awaited<ReturnType<typeof create_bash_runner>>, path: string) {
			const dbFilesDoc = await runner.t.run((ctx) =>
				ctx.db
					.query("files_nodes")
					.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
						q
							.eq("organizationId", runner.seeded.organizationId)
							.eq("workspaceId", runner.seeded.workspaceId)
							.eq("path", path)
							.eq("archiveOperationId", undefined),
					)
					.first(),
			);
			if (!dbFilesDoc) {
				throw new Error(`No seeded node at ${path}`);
			}
			return dbFilesDoc;
		}

		async function get_seeded_node_id(runner: Awaited<ReturnType<typeof create_bash_runner>>, path: string) {
			return (await get_seeded_node(runner, path))._id;
		}

		test("runs pwd and persists cd across invocations", async () => {
			const { run, getCwd } = await create_bash_runner();

			const pwdResult = await run("pwd");
			expect(pwdResult.stdout.trim()).toBe(test_db_files_mount);
			expect(pwdResult.metadata.cwd).toBe(test_db_files_mount);
			expect(getCwd()).toBe(test_db_files_mount);

			const cdResult = await run(`cd ${test_db_files_mount}/docs`);
			expect(cdResult.metadata.nextCwd).toBe(`${test_db_files_mount}/docs`);
			expect(getCwd()).toBe(`${test_db_files_mount}/docs`);

			const nextPwdResult = await run("pwd");
			expect(nextPwdResult.stdout.trim()).toBe(`${test_db_files_mount}/docs`);
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

			const catResult = await run(`cat ${test_db_files_mount}${literalPath}`);
			const grepResult = await run(`grep "command not found" ${test_db_files_mount}${literalPath}`);

			expect(catResult.stdout).toContain("example: command not found");
			expect(catResult.stderr).not.toContain("run 'help' to list available commands");
			expect(grepResult.stdout).toContain("example: command not found");
			expect(grepResult.stderr).not.toContain("run 'help' to list available commands");
		});

		test("reads markdown files through the chunk-backed file content query", async () => {
			const { run, runQuery, runAction, seeded } = await create_bash_runner();

			const result = await run(`cat ${test_db_files_mount}/docs/readme.md`);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toContain("# Readme");
			expect(
				runQuery.mock.calls.some(
					([ref, queryArgs]) =>
						function_name_of(ref) === "files_nodes:read_file_content_from_chunks" &&
						queryArgs?.path === "/docs/readme.md" &&
						queryArgs?.userId === seeded.userId,
				),
			).toBe(true);
			expect(
				runAction.mock.calls.some(
					([ref]) => function_name_of(ref) === "files_nodes:get_file_last_available_markdown_content_by_path",
				),
			).toBe(false);
		});

		test("supports cat end-of-options marker for dash-leading operands", async () => {
			const { run } = await create_bash_runner({
				initialCwd: test_db_files_mount,
				extraFiles: [
					{ path: "/-dash.md", content: "dash file\n" },
					{ path: "/--help", content: "help file\n" },
				],
			});

			const dashFile = await run("cat -- -dash.md");
			const stdin = await run("printf stdin-ok | cat -- -");
			const helpFile = await run("cat -- --help");

			expect(dashFile.metadata.exitCode).toBe(0);
			expect(dashFile.stdout).toBe("dash file\n");
			expect(stdin.metadata.exitCode).toBe(0);
			expect(stdin.stdout).toBe("stdin-ok");
			expect(helpFile.metadata.exitCode).toBe(0);
			expect(helpFile.stdout).toBe("help file\n");
		});

		test("delegates cat help to the built-in command", async () => {
			const { run } = await create_bash_runner();

			const result = await run("cat --help");

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toContain("Usage: cat [OPTION]... [FILE]...");
			expect(result.stderr).toBe("");
		});

		test("treats missing stdin as empty input for cat", async () => {
			const { run } = await create_bash_runner();

			const plain = await run("cat");
			const numbered = await run("cat -n");
			const explicitStdin = await run("cat -- -");

			expect(plain.metadata.exitCode).toBe(0);
			expect(plain.stdout).toBe("");
			expect(numbered.metadata.exitCode).toBe(0);
			expect(numbered.stdout).toBe("");
			expect(explicitStdin.metadata.exitCode).toBe(0);
			expect(explicitStdin.stdout).toBe("");
		});

		test("does not fall back to full-content action when cat chunks are unavailable", async () => {
			const { run, runAction } = await create_bash_runner({
				extraFiles: [{ path: "/docs/unmaterialized.md", content: "hidden fallback\n", materialized: false }],
			});

			const result = await run(`cat ${test_db_files_mount}/docs/unmaterialized.md`);

			expect(result.metadata.exitCode).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("content is not available from materialized chunks");
			expect(result.stderr).toContain(`${test_db_files_mount}/docs/unmaterialized.md`);
			expect(
				runAction.mock.calls.some(
					([ref]) => function_name_of(ref) === "files_nodes:get_file_last_available_markdown_content_by_path",
				),
			).toBe(false);
		});

		test("caches markdown file content within one bash invocation", async () => {
			const { run, runQuery } = await create_bash_runner();

			const result = await run(
				`cat ${test_db_files_mount}/docs/readme.md && cat ${test_db_files_mount}/docs/readme.md`,
			);
			const readCalls = runQuery.mock.calls.filter(
				([ref, queryArgs]) =>
					function_name_of(ref) === "files_nodes:read_file_content_from_chunks" &&
					queryArgs?.path === "/docs/readme.md",
			);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout.split("# Readme").length - 1).toBe(2);
			expect(readCalls).toHaveLength(1);
		});

		test("reads current app file byte size after an unsaved edit is created", async () => {
			const runner = await create_bash_runner({
				extraFiles: [{ path: "/fresh-size.md", content: "tiny base\n" }],
			});
			const { files_yjs_doc_create_from_markdown, files_u8_to_array_buffer } = await import("./files.ts");
			const { encodeStateAsUpdate } = await import("yjs");
			const baseYjsDoc = files_yjs_doc_create_from_markdown({ markdown: "tiny base" });
			if ("_nay" in baseYjsDoc) {
				throw new Error(baseYjsDoc._nay.message);
			}
			const dbFilesDoc = await get_seeded_node(runner, "/fresh-size.md");
			const dbFilesDocId = dbFilesDoc._id;

			const committedSize = await bash_get_db_file_byte_size({
				ctx: runner.ctx,
				ctxData: runner.ctxData,
				dbFilesDoc,
			});

			if (committedSize == null) {
				throw new Error("expected committed asset size for /fresh-size.md");
			}
			expect(committedSize).toBeLessThan(bash_READ_INLINE_MAX_BYTES);

			const upserted = await runner.t.mutation(internal.files_pending_updates.upsert_file_pending_update_in_db, {
				organizationId: runner.seeded.organizationId,
				workspaceId: runner.seeded.workspaceId,
				userId: runner.seeded.userId,
				nodeId: dbFilesDocId,
				baseYjsSequence: 1,
				baseYjsUpdate: files_u8_to_array_buffer(encodeStateAsUpdate(baseYjsDoc)),
				unstagedMarkdown: Array.from({ length: 400 }, (_, index) => `line ${index + 1}`).join("\n\n"),
			});
			if (upserted._nay) {
				throw new Error(upserted._nay.message);
			}
			const pendingUpdate = await runner.t.query(internal.files_pending_updates.get_by_file_node, {
				organizationId: runner.seeded.organizationId,
				workspaceId: runner.seeded.workspaceId,
				userId: runner.seeded.userId,
				fileNodeId: dbFilesDocId,
			});
			if (pendingUpdate?.size == null) {
				throw new Error("expected pending update size to be set for /fresh-size.md");
			}
			runner.runQuery.mockClear();

			const currentSize = await bash_get_db_file_byte_size({
				ctx: runner.ctx,
				ctxData: runner.ctxData,
				dbFilesDoc,
			});

			expect(currentSize).toBe(pendingUpdate.size);
			expect(currentSize).toBeGreaterThan(bash_READ_INLINE_MAX_BYTES);
			expect(runner.runQuery.mock.calls.some(([ref]) => function_name_of(ref) === "r2:get_asset_by_id")).toBe(false);
		});

		test("uses pending update size metadata without reconstructing content", async () => {
			const runner = await create_bash_runner({
				extraFiles: [{ path: "/legacy-pending.md", content: "base\n" }],
			});
			const { files_yjs_doc_create_from_markdown, files_u8_to_array_buffer } = await import("./files.ts");
			const { encodeStateAsUpdate } = await import("yjs");
			const baseYjsDoc = files_yjs_doc_create_from_markdown({ markdown: "base" });
			if ("_nay" in baseYjsDoc) {
				throw new Error(baseYjsDoc._nay.message);
			}
			const yjsUpdate = files_u8_to_array_buffer(encodeStateAsUpdate(baseYjsDoc));
			const dbFilesDoc = await get_seeded_node(runner, "/legacy-pending.md");
			const dbFilesDocId = dbFilesDoc._id;
			const pendingSize = files_get_utf8_byte_size("base");
			await runner.t.run(async (ctx) => {
				await ctx.db.insert("files_pending_updates", {
					organizationId: runner.seeded.organizationId,
					workspaceId: runner.seeded.workspaceId,
					userId: runner.seeded.userId,
					fileNodeId: dbFilesDocId,
					baseYjsSequence: 1,
					baseYjsUpdate: yjsUpdate,
					stagedBranchYjsUpdate: yjsUpdate,
					unstagedBranchYjsUpdate: yjsUpdate,
					size: pendingSize,
					updatedAt: Date.now(),
				});
			});
			runner.runQuery.mockClear();
			runner.runAction.mockClear();

			const size = await bash_get_db_file_byte_size({
				ctx: runner.ctx,
				ctxData: runner.ctxData,
				dbFilesDoc,
			});

			expect(size).toBe(pendingSize);
			expect(runner.runQuery.mock.calls.some(([ref]) => function_name_of(ref) === "r2:get_asset_by_id")).toBe(false);
			expect(
				runner.runAction.mock.calls.some(
					([ref]) => function_name_of(ref) === "files_nodes:get_file_last_available_markdown_content_by_path",
				),
			).toBe(false);
		});

		test("pipes cat text output without corrupting Unicode", async () => {
			const unicodePath = "/docs/unicode.md";
			const content = "cafe\u0301 — snowman ☃\n";
			const { run } = await create_bash_runner({
				extraFiles: [{ path: unicodePath, content }],
			});

			const result = await run(`cat ${test_db_files_mount}${unicodePath} | cat`);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toBe(content);
		});

		test("supports ls, find, and stat over db-files paths", async () => {
			const { run } = await create_bash_runner();

			const result = await run(
				`ls ${test_db_files_mount}/docs && find ${test_db_files_mount}/docs -maxdepth 1 -type f && stat ${test_db_files_mount}/docs/readme.md`,
			);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toContain("readme.md");
			expect(result.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
		});

		test("keeps valid ls operands when another operand is missing", async () => {
			const { run } = await create_bash_runner();

			const result = await run(`ls ${test_db_files_mount}/docs ${test_db_files_mount}/missing`);

			expect(result.metadata.exitCode).toBe(1);
			expect(result.stdout).toContain(`${test_db_files_mount}/docs:`);
			expect(result.stdout).toContain("readme.md");
			expect(result.stderr).toContain(`ls: cannot access '${test_db_files_mount}/missing': No such file or directory`);
		});

		test("supports paginated ls with a continuation command", async () => {
			const runner = await create_bash_runner();
			const { run, runQuery } = runner;
			const docsId = await get_seeded_node_id(runner, "/docs");

			const result = await run(`ls --limit 1 ${test_db_files_mount}/docs`);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toContain("nested/");
			expect(result.stdout).toContain("Next page:");
			expect(result.stdout).toMatch(new RegExp(`ls --limit 1 --cursor \\S+ ${test_db_files_mount}/docs`, "u"));
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

			await run(`cd ${test_db_files_mount}/docs`);
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

		test("delegates bare ls to the current scratch directory outside the current workspace path", async () => {
			const { run, runQuery } = await create_bash_runner();

			const result = await run("cd /tmp && printf hi > scratch.txt && ls");

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toContain("scratch.txt");
			expect(result.stdout).not.toContain("readme.md");
			const paginatedCalls = runQuery.mock.calls.map((call) => call[1]).filter((args) => "numItems" in args);
			expect(paginatedCalls).toHaveLength(0);
		});

		test("keeps /tmp relative ls output outside the current workspace path", async () => {
			const { run, runQuery } = await create_bash_runner();

			const result = await run("cd /tmp && printf hi > relative-tmp.txt && ls relative-tmp.txt");

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout.trim()).toBe("relative-tmp.txt");
			const paginatedCalls = runQuery.mock.calls.map((call) => call[1]).filter((args) => "numItems" in args);
			expect(paginatedCalls).toHaveLength(0);
		});

		test("reports unknown ls cursor ids with recovery guidance", async () => {
			const { run } = await create_bash_runner();

			const result = await run(`ls --limit 1 --cursor cursor-1 ${test_db_files_mount}/docs`);

			expect(result.metadata.exitCode).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("cursor cursor-1 expired, is unavailable, or was copied incorrectly");
			expect(result.stderr).toContain("Copy the exact --cursor value from the latest Next page command and retry");
		});

		test("resolves stored cursor ids from memory before querying value_store", async () => {
			const { run, runQuery, runMutation } = await create_bash_runner();

			const firstPage = await run(`ls --limit 1 ${test_db_files_mount}/docs`);
			const cursorId = firstPage.stdout.match(/--cursor '?([^' ]+)'?/u)?.[1];
			if (cursorId == null) {
				throw new Error("expected a cursor id in the first page stdout");
			}
			const rawCursor = runMutation.mock.calls
				.map(([ref, mutationArgs]) => (function_name_of(ref) === "value_store:put" ? mutationArgs.value : null))
				.find((value): value is string => typeof value === "string");
			if (rawCursor == null) {
				throw new Error("expected the first page cursor to be stored in value_store");
			}

			runQuery.mockClear();
			const secondPage = await run(`ls --limit 1 --cursor '${cursorId}' ${test_db_files_mount}/docs`);

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
			const { run, runQuery, runMutation, t } = await create_bash_runner();

			const firstPage = await run(`ls --limit 1 ${test_db_files_mount}/docs`);
			const warmedCursorId = firstPage.stdout.match(/--cursor '?([^' ]+)'?/u)?.[1];
			if (warmedCursorId == null) {
				throw new Error("expected a cursor id in the first page stdout");
			}
			const rawCursor = runMutation.mock.calls
				.map(([ref, mutationArgs]) => (function_name_of(ref) === "value_store:put" ? mutationArgs.value : null))
				.find((value): value is string => typeof value === "string");
			if (rawCursor == null) {
				throw new Error("expected the first page cursor to be stored in value_store");
			}

			let cursorId = "";
			await t.run(async (ctx) => {
				// Earlier isolated Convex test runners can cache the first generated ids.
				for (let index = 0; index < 25; index++) {
					cursorId = String(await ctx.db.insert("value_store", { value: rawCursor }));
				}
			});
			runQuery.mockClear();
			const secondPage = await run(`ls --limit 1 --cursor '${cursorId}' ${test_db_files_mount}/docs`);

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

			const result = await run(`ls --limit 1 --cursor missing ${test_db_files_mount}/docs`);

			expect(result.metadata.exitCode).toBe(1);
			expect(result.stderr).toContain("cursor missing expired, is unavailable, or was copied incorrectly");
			expect(result.stderr).toContain("Copy the exact --cursor value from the latest Next page command and retry");
		});

		test("supports multiple ls path operands with per-directory continuation commands", async () => {
			const { run } = await create_bash_runner();

			const result = await run(
				`ls --limit 1 ${test_db_files_mount}/docs ${test_db_files_mount} ${test_db_files_mount}/docs/readme.md`,
			);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toContain(`${test_db_files_mount}/docs:\nnested/`);
			expect(result.stdout).toContain(`${test_db_files_mount}:\ndocs/`);
			expect(result.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
			expect(result.stdout.match(/Next page:/gu)).toHaveLength(2);
			const continuations = [...result.stdout.matchAll(/Next page: ls --limit 1 --cursor (\S+) (\S+)/gu)];
			expect(continuations.map((m) => m[2])).toEqual([`${test_db_files_mount}/docs`, test_db_files_mount]);
			expect(continuations[0][1]).not.toBe(continuations[1][1]);
		});

		test("supports mixed /tmp and app ls operands without a cursor", async () => {
			const { run } = await create_bash_runner();

			const tmpFirst = await run(
				`printf hi > /tmp/mixed-tmp-a.txt && printf hi > /tmp/mixed-tmp-b.txt && ls /tmp/mixed-tmp-a.txt /tmp/mixed-tmp-b.txt ${test_db_files_mount}/docs`,
			);
			const tmpAppTmp = await run(
				`printf hi > /tmp/mixed-tmp-a.txt && printf hi > /tmp/mixed-tmp-b.txt && ls /tmp/mixed-tmp-a.txt ${test_db_files_mount}/docs /tmp/mixed-tmp-b.txt`,
			);

			expect(tmpFirst.metadata.exitCode).toBe(0);
			expect(tmpFirst.stdout).toContain("/tmp/mixed-tmp-a.txt");
			expect(tmpFirst.stdout).toContain("/tmp/mixed-tmp-b.txt");
			expect(tmpFirst.stdout).toContain(`${test_db_files_mount}/docs:\nnested/`);
			expect(tmpFirst.stdout.indexOf("/tmp/mixed-tmp-a.txt")).toBeLessThan(
				tmpFirst.stdout.indexOf("/tmp/mixed-tmp-b.txt"),
			);
			expect(tmpFirst.stdout.indexOf("/tmp/mixed-tmp-b.txt")).toBeLessThan(
				tmpFirst.stdout.indexOf(`${test_db_files_mount}/docs:`),
			);
			expect(tmpFirst.stderr).not.toContain("cannot mix app file paths");

			expect(tmpAppTmp.metadata.exitCode).toBe(0);
			expect(tmpAppTmp.stdout).toContain("/tmp/mixed-tmp-a.txt");
			expect(tmpAppTmp.stdout).toContain(`${test_db_files_mount}/docs:\nnested/`);
			expect(tmpAppTmp.stdout).toContain("/tmp/mixed-tmp-b.txt");
			expect(tmpAppTmp.stdout.indexOf("/tmp/mixed-tmp-a.txt")).toBeLessThan(
				tmpAppTmp.stdout.indexOf(`${test_db_files_mount}/docs:`),
			);
			expect(tmpAppTmp.stdout.indexOf(`${test_db_files_mount}/docs:`)).toBeLessThan(
				tmpAppTmp.stdout.indexOf("/tmp/mixed-tmp-b.txt"),
			);
			expect(tmpAppTmp.stderr).not.toContain("cannot mix app file paths");
		});

		test("formats mixed /tmp and app ls directory sections consistently", async () => {
			const { run } = await create_bash_runner();

			const result = await run(
				`mkdir -p /tmp/mixed-ls-dir && printf hi > /tmp/mixed-ls-dir/tmp.txt && ls ${test_db_files_mount}/docs /tmp/mixed-ls-dir`,
			);
			const relativeResult = await run(
				`cd /tmp && mkdir -p mixed-ls-relative-dir && printf hi > mixed-ls-relative-dir/tmp.txt && ls mixed-ls-relative-dir ${test_db_files_mount}/docs`,
			);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toContain(`${test_db_files_mount}/docs:\nnested/`);
			expect(result.stdout).toContain("/tmp/mixed-ls-dir:\ntmp.txt");
			expect(result.stdout.trim().split("\n\n")).toEqual([
				`${test_db_files_mount}/docs:\nnested/\nreadme.md\ntutorial.md`,
				"/tmp/mixed-ls-dir:\ntmp.txt",
			]);
			expect(relativeResult.metadata.exitCode).toBe(0);
			expect(relativeResult.stdout.trim().split("\n\n")).toEqual([
				"mixed-ls-relative-dir:\ntmp.txt",
				`${test_db_files_mount}/docs:\nnested/\nreadme.md\ntutorial.md`,
			]);
		});

		test("keeps Native Just Bash ls flags when batching adjacent /tmp operands", async () => {
			const { run } = await create_bash_runner();

			const result = await run(
				`mkdir -p /tmp/mixed-ls-a /tmp/mixed-ls-b && ls -d /tmp/mixed-ls-a /tmp/mixed-ls-b ${test_db_files_mount}/docs`,
			);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout.trim().split("\n\n")).toEqual([
				"/tmp/mixed-ls-a",
				"/tmp/mixed-ls-b",
				`${test_db_files_mount}/docs/`,
			]);
		});

		test("rejects ls cursor continuation with multiple operands", async () => {
			const { run, runQuery } = await create_bash_runner();

			const result = await run(
				`ls --limit 1 --cursor cursor-1 ${test_db_files_mount}/docs ${test_db_files_mount}/reports`,
			);
			const mixedResult = await run(`ls --limit 1 --cursor cursor-1 ${test_db_files_mount}/docs /tmp`);

			expect(result.metadata.exitCode).toBe(2);
			expect(result.stderr).toContain("--cursor can only continue one listing target");
			expect(mixedResult.metadata.exitCode).toBe(2);
			expect(mixedResult.stderr).toContain("--cursor can only continue one listing target");
			const paginatedCalls = runQuery.mock.calls.map((call) => call[1]).filter((args) => "numItems" in args);
			expect(paginatedCalls).toHaveLength(0);
		});

		test("supports ls -d and lets directory mode win over recursive mode", async () => {
			const { run } = await create_bash_runner();

			const result = await run(`ls -dR ${test_db_files_mount}/docs`);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout.trim()).toBe(`${test_db_files_mount}/docs/`);
			expect(result.stdout).not.toContain("readme.md");
		});

		test("supports recursive ls with full app shell paths", async () => {
			const { run } = await create_bash_runner();

			const result = await run(`ls -R --limit 10 ${test_db_files_mount}/docs`);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toContain(`${test_db_files_mount}/docs/nested/`);
			expect(result.stdout).toContain(`${test_db_files_mount}/docs/nested/deep.md`);
			expect(result.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
		});

		test("supports reverse ls order through the paginated query", async () => {
			const runner = await create_bash_runner();
			const { run, runQuery } = runner;
			const docsId = await get_seeded_node_id(runner, "/docs");

			const result = await run(`ls -r --limit 10 ${test_db_files_mount}/docs`);

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

		test("ls -t lists the workspace newest-first and supports scoped immediate-child recency", async () => {
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
			const scopedNewest = await run(`ls -t --limit 10 ${test_db_files_mount}/docs`);
			const scopedOldest = await run(`ls -rt --limit 10 ${test_db_files_mount}/docs`);
			const scopedPaged = await run(`ls -t --limit 1 ${test_db_files_mount}/docs`);
			const recursiveScoped = await run(`ls -Rt ${test_db_files_mount}/docs`);
			const workspacePaged = await run("ls -t --limit 1");

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
				new RegExp(`Next page: ls -t --limit 1 --cursor \\S+ ${test_db_files_mount}/docs`, "u"),
			);
			expect(recursiveScoped.metadata.exitCode).toBe(2);
			expect(recursiveScoped.stderr).toContain("ls -t -R is not supported");
			expect(workspacePaged.stdout).toContain("Next page: ls -t --limit 1 --cursor");
			expect(runQuery).toHaveBeenCalledWith(
				internal.files_nodes.list_children,
				expect.objectContaining({
					parentId: docsId,
					orderBy: "updatedAt",
					order: "desc",
				}),
			);
		});

		test("supports app-specific long ls output", async () => {
			const { run, seeded } = await create_bash_runner();

			const result = await run(`ls -la --limit 10 ${test_db_files_mount}/docs`);

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

			const result = await run(`ls -1apF --sort=name --indicator-style=slash --limit 10 ${test_db_files_mount}/docs`);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout.trim().split("\n")).toEqual(["nested/", "readme.md", "tutorial.md"]);
		});

		test("rejects unsupported ls sorting and size flags only when db-files paths are involved", async () => {
			const { run, runQuery } = await create_bash_runner();

			const sortResult = await run(`ls --sort=size ${test_db_files_mount}/docs`);
			const sizeResult = await run(`ls -S ${test_db_files_mount}/docs`);
			const nativeJustBashResult = await run("ls --sort=size /tmp");
			const mixedResult = await run(
				`printf hi > /tmp/unsupported-ls-tmp.txt && ls --sort=size /tmp/unsupported-ls-tmp.txt ${test_db_files_mount}/docs`,
			);

			expect(sortResult.metadata.exitCode).toBe(2);
			expect(sortResult.stderr).toContain("unsupported option --sort=size");
			expect(sortResult.stderr).toContain("/home/cloud-usr/w");
			expect(sortResult.stderr).toContain("supports name and time order only");
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

			const appResult = await run(`ls --limit 1 --next-page ${test_db_files_mount}/docs`);
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

			const result = await run(`find ${test_db_files_mount}/docs -maxdepth 1 -type f --limit 10`);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
			expect(result.stdout).toContain(`${test_db_files_mount}/docs/tutorial.md`);
			expect(result.stdout).not.toContain(`${test_db_files_mount}/docs/nested/deep.md`);
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

			const plain = await run(`find ${test_db_files_mount}/docs/readme.md --limit 10`);
			const extension = await run(`find ${test_db_files_mount}/docs/readme.md --extension md --limit 10`);
			const typeFolder = await run(`find ${test_db_files_mount}/docs/readme.md -type d --limit 10`);
			const tooDeep = await run(`find ${test_db_files_mount}/docs/readme.md -mindepth 1 --limit 10`);

			expect(plain.metadata.exitCode).toBe(0);
			expect(plain.stdout.trim()).toBe(`${test_db_files_mount}/docs/readme.md`);
			expect(extension.metadata.exitCode).toBe(0);
			expect(extension.stdout.trim()).toBe(`${test_db_files_mount}/docs/readme.md`);
			expect(typeFolder.stdout.trim()).toBe("0 matches.");
			expect(tooDeep.stdout.trim()).toBe("0 matches.");
			expect(runQuery.mock.calls.some(([ref]) => function_name_of(ref) === "files_nodes:list_subtree")).toBe(false);
		});

		test("supports indexed app-file find path word search", async () => {
			// convex-test's search index splits document words on whitespace only, so the word
			// query can only land on a path segment that follows a space in the file name.
			const wordSearchPath = "/docs/word readme.md";
			const outsideWordSearchPath = "/word readme-outside.md";
			const runner = await create_bash_runner({
				extraFiles: [
					{ path: wordSearchPath, content: "word search fixture\n" },
					{ path: outsideWordSearchPath, content: "outside word search fixture\n" },
					{ path: "/docs/scope word/child.md", content: "child under scope word\n" },
				],
			});
			const { run, runQuery } = runner;
			const docsId = await get_seeded_node_id(runner, "/docs");

			const nameResult = await run("find -name readme --limit 10");
			const explicitResult = await run("find --path-query readme --limit 10");
			const scopedResult = await run(`find ${test_db_files_mount}/docs -maxdepth 1 -name readme -type f --limit 10`);
			const subtreeResult = await run(`find ${test_db_files_mount}/docs -name readme --limit 10`);
			const dottedNameResult = await run(`find ${test_db_files_mount}/docs -type f -name 'word readme.md' --limit 10`);
			const scopedSelfResult = await run(`find '${test_db_files_mount}/docs/scope word' --path-query word --limit 10`);
			const scopedMindepthResult = await run(
				`find '${test_db_files_mount}/docs/scope word' -mindepth 1 --path-query word --limit 10`,
			);

			expect(nameResult.metadata.exitCode).toBe(0);
			expect(nameResult.stdout).toContain(`${test_db_files_mount}${wordSearchPath}`);
			expect(nameResult.stdout).toContain(`${test_db_files_mount}${outsideWordSearchPath}`);
			expect(explicitResult.metadata.exitCode).toBe(0);
			expect(explicitResult.stdout).toContain(`${test_db_files_mount}${wordSearchPath}`);
			expect(scopedResult.metadata.exitCode).toBe(0);
			expect(scopedResult.stdout).toContain(`${test_db_files_mount}${wordSearchPath}`);
			// Without -maxdepth, a folder scope searches the full subtree and filters out the rest.
			expect(subtreeResult.metadata.exitCode).toBe(0);
			expect(subtreeResult.stdout).toContain(`${test_db_files_mount}${wordSearchPath}`);
			expect(subtreeResult.stdout).not.toContain(`${test_db_files_mount}${outsideWordSearchPath}`);
			expect(dottedNameResult.metadata.exitCode).toBe(0);
			expect(dottedNameResult.stdout).toContain(`${test_db_files_mount}${wordSearchPath}`);
			expect(dottedNameResult.stdout).not.toContain(`${test_db_files_mount}/docs/nested/deep.md`);
			expect(scopedSelfResult.metadata.exitCode).toBe(0);
			expect(scopedSelfResult.stdout.trim().split("\n")).toContain(`${test_db_files_mount}/docs/scope word/`);
			expect(scopedMindepthResult.metadata.exitCode).toBe(0);
			expect(scopedMindepthResult.stdout.trim().split("\n")).not.toContain(`${test_db_files_mount}/docs/scope word/`);
			expect(scopedMindepthResult.stdout.trim().split("\n")).toContain(
				`${test_db_files_mount}/docs/scope word/child.md`,
			);
			expect(runQuery).toHaveBeenCalledWith(
				internal.files_nodes.search_paths,
				expect.objectContaining({
					pathQuery: "readme",
				}),
			);
			expect(runQuery).toHaveBeenCalledWith(
				internal.files_nodes.search_paths,
				expect.objectContaining({
					parentId: docsId,
					kind: "file",
				}),
			);
			expect(runQuery).toHaveBeenCalledWith(
				internal.files_nodes.search_paths,
				expect.objectContaining({
					pathQuery: "readme",
					pathPrefix: "/docs",
				}),
			);
		});

		test("supports find -mindepth and accepts -print as a no-op", async () => {
			const { run } = await create_bash_runner();

			const deepOnly = await run(`find ${test_db_files_mount}/docs -mindepth 2 --limit 50`);
			const directOnly = await run(`find ${test_db_files_mount}/docs -mindepth 1 -maxdepth 1 --limit 50`);
			const printed = await run(`find ${test_db_files_mount}/docs -maxdepth 1 -print --limit 50`);

			expect(deepOnly.metadata.exitCode).toBe(0);
			expect(deepOnly.stdout).toContain(`${test_db_files_mount}/docs/nested/deep.md`);
			expect(deepOnly.stdout).not.toContain(`${test_db_files_mount}/docs/readme.md`);
			expect(directOnly.metadata.exitCode).toBe(0);
			expect(directOnly.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
			expect(directOnly.stdout).toContain(`${test_db_files_mount}/docs/nested/`);
			expect(directOnly.stdout).not.toContain(`${test_db_files_mount}/docs/nested/deep.md`);
			expect(printed.metadata.exitCode).toBe(0);
			expect(printed.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
		});

		test("rejects a non-integer find -mindepth and round-trips it in the continuation", async () => {
			const { run } = await create_bash_runner();

			const invalid = await run(`find ${test_db_files_mount}/docs -mindepth x --limit 10`);
			const paged = await run(`find ${test_db_files_mount}/docs -mindepth 1 --limit 1`);

			expect(invalid.metadata.exitCode).toBe(2);
			expect(invalid.stderr).toContain("-mindepth must be a non-negative integer");
			expect(paged.metadata.exitCode).toBe(0);
			expect(paged.stdout).toContain("Next page: find");
			expect(paged.stdout).toContain("-mindepth 1");
		});

		test("rejects find --prefix combined with depth flags", async () => {
			const { run, runQuery } = await create_bash_runner();

			const maxResult = await run(`find --prefix ${test_db_files_mount}/docs -maxdepth 1 --limit 10`);
			const minResult = await run(`find --prefix ${test_db_files_mount}/docs -mindepth 2 --limit 10`);

			expect(maxResult.metadata.exitCode).toBe(2);
			expect(maxResult.stderr).toContain("--prefix cannot be combined with -maxdepth/-mindepth");
			expect(minResult.metadata.exitCode).toBe(2);
			expect(minResult.stderr).toContain("--prefix cannot be combined with -maxdepth/-mindepth");
			const paginatedCalls = runQuery.mock.calls.map((call) => call[1]).filter((args) => "numItems" in args);
			expect(paginatedCalls).toHaveLength(0);
		});

		test("supports indexed app-file find extension search and simple extension glob recovery", async () => {
			const { run, runQuery } = await create_bash_runner();

			const globName = await run("find -name '*.md' --limit 10");
			const extension = await run(`find ${test_db_files_mount}/docs --extension md --limit 10`);
			const pathGlob = await run(`find ${test_db_files_mount}/docs/*.md --limit 1`);

			expect(globName.metadata.exitCode).toBe(0);
			expect(globName.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
			expect(extension.metadata.exitCode).toBe(0);
			expect(extension.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
			expect(pathGlob.metadata.exitCode).toBe(0);
			expect(pathGlob.stdout).toContain(`${test_db_files_mount}/docs/nested/deep.md`);
			expect(pathGlob.stdout).toMatch(
				new RegExp(`Next page: find ${test_db_files_mount}/docs --extension md --limit 1 --cursor \\S+`, "u"),
			);
			expect(runQuery).toHaveBeenCalledWith(
				internal.files_nodes.list_subtree,
				expect.objectContaining({
					folderPath: "/docs",
					kind: "file",
					lowercaseExtension: "md",
				}),
			);
		});

		test("rejects find combinations that still cannot stay indexed", async () => {
			const { run } = await create_bash_runner();

			const scopedDepth = await run(`find ${test_db_files_mount}/docs -maxdepth 2 -name readme --limit 10`);
			const tokenGlobName = await run("find -type f -name '*readme*' --limit 10");
			const prefixExtensionGlobName = await run(
				`find ${test_db_files_mount}/docs -type f -name 'readme*.md' --limit 10`,
			);
			const complexGlobName = await run("find -name 'read.*.md' --limit 10");
			const pathQueryGlob = await run("find --path-query '.*readme.*' --limit 10");
			const combinedPathQueryExtension = await run(
				`find ${test_db_files_mount}/docs -type f --extension md --path-query readme --limit 10`,
			);
			const recursivePathQuery = await run(
				`find ${test_db_files_mount} -maxdepth 5 -type f --path-query readme --limit 10`,
			);
			const regexPathPredicate = await run(`find ${test_db_files_mount}/docs -type f -regex '.*readme.*' --limit 10`);

			expect(scopedDepth.metadata.exitCode).toBe(2);
			expect(scopedDepth.stderr).toContain("full subtree (omit -maxdepth) or immediate children with -maxdepth 1");
			expect(scopedDepth.stderr).toContain(`Try: find ${test_db_files_mount}/docs --path-query readme --limit 10`);
			expect(tokenGlobName.metadata.exitCode).toBe(2);
			expect(tokenGlobName.stderr).toContain(`Try: find ${test_db_files_mount} -type f --path-query readme --limit 10`);
			expect(prefixExtensionGlobName.metadata.exitCode).toBe(2);
			expect(prefixExtensionGlobName.stderr).toContain(
				`Try: find ${test_db_files_mount}/docs -type f --path-query readme --limit 10`,
			);
			expect(complexGlobName.metadata.exitCode).toBe(2);
			expect(complexGlobName.stderr).toContain("not glob patterns");
			expect(complexGlobName.stderr).toContain("Try `find <dir> -type f --extension md");
			expect(pathQueryGlob.metadata.exitCode).toBe(2);
			expect(pathQueryGlob.stderr).toContain("--path-query uses indexed app-file path word search");
			expect(pathQueryGlob.stderr).toContain(`Try: find ${test_db_files_mount} --path-query readme --limit 10`);
			expect(combinedPathQueryExtension.metadata.exitCode).toBe(2);
			expect(combinedPathQueryExtension.stderr).toContain(
				`Try: find ${test_db_files_mount}/docs -type f --path-query readme --limit 10`,
			);
			expect(combinedPathQueryExtension.stderr).toContain(
				`For extension-only search, use: find ${test_db_files_mount}/docs -type f --extension md --limit 10`,
			);
			expect(recursivePathQuery.metadata.exitCode).toBe(2);
			expect(recursivePathQuery.stderr).toContain(
				`Try: find ${test_db_files_mount} -type f --path-query readme --limit 10`,
			);
			expect(regexPathPredicate.metadata.exitCode).toBe(2);
			expect(regexPathPredicate.stderr).toContain(
				`Try: find ${test_db_files_mount}/docs -type f --path-query readme --limit 10`,
			);
		});

		test("filters non-search find pages before pagination", async () => {
			const { run } = await create_bash_runner();

			const result = await run(`find ${test_db_files_mount}/docs -maxdepth 1 -type f --limit 1`);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
			expect(result.stdout).not.toContain("No matches in this page; more pages exist.");
			expect(result.stdout).toContain("Next page:");
		});

		test("rejects unsupported find predicates when pagination is requested", async () => {
			const { run, runQuery } = await create_bash_runner();

			const result = await run(`find ${test_db_files_mount}/docs -delete --limit 10`);
			const regexResult = await run(
				`find ${test_db_files_mount}/docs -regextype posix-extended -regex '.*readme.*' --limit 10`,
			);
			const nativeJustBashResult = await run("find /tmp -mtime 1 --limit 1");

			expect(result.metadata.exitCode).toBe(2);
			expect(result.stderr).toContain("unsupported predicate -delete");
			expect(result.stderr).toContain("/home/cloud-usr/w");
			expect(result.stderr).toContain("use -name QUERY");
			expect(result.stderr).toContain("Usage: find");
			expect(regexResult.metadata.exitCode).toBe(2);
			expect(regexResult.stderr).toContain("unsupported predicate -regextype");
			expect(regexResult.stderr).toContain("--path-query with plain path words");
			expect(regexResult.stderr).toContain(`Try: find ${test_db_files_mount}/docs --path-query readme --limit 10`);
			expect(regexResult.stderr).not.toContain("supports one path only");
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

			await run(`ls ${test_db_files_mount}/docs`);

			const listCalls = runQuery.mock.calls
				.map((call) => call[1])
				.filter((args) => args && typeof args === "object" && "maxDepth" in args);
			expect(listCalls).toHaveLength(0);
		});

		test("resolves exact parent folders through db-files path lookups", async () => {
			const { run, runQuery } = await create_bash_runner();

			const result = await run(`cd ${test_db_files_mount}/reports && pwd`);
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
			expect(result.stdout.trim()).toBe(`${test_db_files_mount}/reports`);
			expect(reportsLookupCalls.length).toBeGreaterThan(0);
		});

		test("rejects app glob patterns without falling back to capped enumeration", async () => {
			const { run } = await create_bash_runner();

			const result = await run(`ls ${test_db_files_mount}/docs/*.md`);

			expect(result.metadata.exitCode).toBe(2);
			expect(result.metadata.pathIndexTruncated).toBe(false);
			expect(result.stderr).toContain("app file glob patterns are not supported");
			expect(result.stderr).toContain(`Try: find ${test_db_files_mount}/docs -type f --extension md --limit 20`);
		});

		test("expands scratch globs but rejects app globs after cwd resolution", async () => {
			const { run } = await create_bash_runner();

			const writeTmp = await run("printf 'alpha\\n' > /tmp/a.txt && printf 'beta\\n' > /tmp/b.txt");
			const cdTmp = await run("cd /tmp");
			const tmpGlob = await run("cat *.txt");
			const cdApp = await run(`cd ${test_db_files_mount}/docs`);
			const appGlob = await run("ls *.md");

			expect(writeTmp.metadata.exitCode).toBe(0);
			expect(cdTmp.metadata.exitCode).toBe(0);
			expect(tmpGlob.metadata.exitCode).toBe(0);
			expect(tmpGlob.stdout).toContain("alpha\n");
			expect(tmpGlob.stdout).toContain("beta\n");
			expect(tmpGlob.stderr).not.toContain("app file glob patterns are not supported");
			expect(cdApp.metadata.exitCode).toBe(0);
			expect(appGlob.metadata.exitCode).toBe(2);
			expect(appGlob.stderr).toContain("app file glob patterns are not supported");
			expect(appGlob.stderr).toContain("Try: find . -type f --extension md --limit 20");
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

			const result = await run(`cat ${test_db_files_mount}/source.pdf`);

			expect(result.metadata.exitCode).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("content type is 'application/pdf'");
			expect(result.stderr).toContain("Markdown and plain text files only");
			expect(result.stderr).toContain(`${test_db_files_mount}/source.pdf.md`);
			expect(result.stderr).toContain(`${test_db_files_mount}/source.md`);
			expect(result.stderr).toContain(`${test_db_files_mount}/source.txt`);
		});

		test("keeps unreadable cat advisories out of pipelines", async () => {
			const { run } = await create_bash_runner();

			const result = await run(`cat ${test_db_files_mount}/source.pdf | grep application/pdf`);

			expect(result.metadata.exitCode).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("content type is 'application/pdf'");
		});

		test("does not suggest rereading the same unreadable file path", async () => {
			const { run } = await create_bash_runner();

			const result = await run(`cat ${test_db_files_mount}/uploaded.md`);
			const suggestionLine = result.stderr
				.split("\n")
				.find((line) => line.startsWith("To read generated text output for this file"));

			expect(result.metadata.exitCode).toBe(1);
			expect(result.stdout).toBe("");
			expect(suggestionLine).toBeDefined();
			// The advisory must suggest readable siblings, never re-reading the same unreadable path.
			expect(suggestionLine).not.toContain(`${test_db_files_mount}/uploaded.md,`);
			expect(suggestionLine?.endsWith(`${test_db_files_mount}/uploaded.md`)).toBe(false);
			expect(suggestionLine).toContain(`${test_db_files_mount}/uploaded.md.md`);
			expect(suggestionLine).toContain(`${test_db_files_mount}/uploaded.txt`);
		});

		test("rejects organization writes and persists same-thread /tmp scratch files", async () => {
			const { run, runMutation } = await create_bash_runner();

			const organizationWrite = await run(`echo nope > ${test_db_files_mount}/docs/new.md`);
			expect(organizationWrite.metadata.exitCode).not.toBe(0);
			expect(organizationWrite.stderr).toContain("read-only file system");

			const tmpWrite = await run("printf hi > /tmp/a.txt");
			expect(tmpWrite.metadata.exitCode).toBe(0);

			const nextInvocation = await run("cat /tmp/a.txt");
			expect(nextInvocation.metadata.exitCode).toBe(0);
			expect(nextInvocation.stdout).toBe("hi");

			// Only the tmp write flushes; the failed organization write and the read do not.
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
						fileNodes: BashTmpPatchEntry[];
						fileNodesContentDict: BashTmpPatchContentDict;
						deletePaths: string[];
				  }
				| undefined;
			expect(lastPatchArgs?.fileNodes.map((tmpFile) => tmpFile.path)).toEqual(["/a.txt"]);
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
						fileNodes: BashTmpPatchEntry[];
						fileNodesContentDict: BashTmpPatchContentDict;
						deletePaths: string[];
				  }
				| undefined;
			expect(lastPatchArgs?.fileNodes.map((tmpFile) => tmpFile.path)).toEqual([
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

			const { test_mocks_fill_db_with } = await import("../convex/setup.test.ts");
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
			const { run, runMutation, seeded } = await create_bash_runner({ allowDbFilesMkdir: true });

			const result = await run(
				`mkdir ${test_db_files_mount}/bash-created && stat ${test_db_files_mount}/bash-created && ls ${test_db_files_mount}`,
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
			const { run, runMutation } = await create_bash_runner({ allowDbFilesMkdir: false });

			const result = await run(`mkdir ${test_db_files_mount}/ask-denied`);

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
			expect(result.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
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

			const result = await run(`search --path=${test_db_files_mount}/docs --limit=5 unique-token`);

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
			expect(firstPage.stdout.indexOf("Next page: search")).toBeLessThan(
				firstPage.stdout.indexOf(`${test_db_files_mount}/search-fixtures/broad.md`),
			);
			expect(firstPage.stdout).toContain("run the exact Next page command before answering");

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

		test("prints a search continuation when indexed search has another db page", async () => {
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

			const result = await run(`search --path ${test_db_files_mount}/docs --limit 1 paged-token`);

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

		test("rejects db-files path operands in indexed search instead of folding them into the query", async () => {
			const { run, runQuery } = await create_bash_runner();

			const result = await run(`search --limit 5 unique-token ${test_db_files_mount}`);

			expect(result.metadata.exitCode).toBe(2);
			expect(result.stderr).toContain("path operands are not supported");
			expect(result.stderr).toContain("search --path <folder>");
			expect(runQuery.mock.calls.some(([, queryArgs]) => "query" in queryArgs)).toBe(false);
		});

		test("scopes indexed search to a folder with --path", async () => {
			const { run, runQuery } = await create_bash_runner();

			// In-scope folder -> hit, and the db-files path is passed through to the query.
			const inScope = await run(`search --path ${test_db_files_mount}/docs unique-token`);
			expect(inScope.metadata.exitCode).toBe(0);
			expect(inScope.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
			expect(inScope.stdout).toContain(`under ${test_db_files_mount}/docs`);
			expect(runQuery).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ query: "unique-token", pathPrefix: "/docs" }),
			);

			// Bare search follows the current app cwd so "cd dir && search term" stays db-scoped.
			const cwdScope = await run(`cd ${test_db_files_mount}/docs && search unique-token`);
			expect(cwdScope.metadata.exitCode).toBe(0);
			expect(cwdScope.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
			expect(cwdScope.stdout).toContain(`under ${test_db_files_mount}/docs`);
			const searchCalls = runQuery.mock.calls.map((call) => call[1]).filter((args) => "query" in args);
			expect(searchCalls.at(-1)).toEqual(expect.objectContaining({ query: "unique-token", pathPrefix: "/docs" }));

			// Relative --path (including `.`) resolves against the current working directory.
			const relScope = await run(`cd ${test_db_files_mount} && search --path docs unique-token`);
			expect(relScope.metadata.exitCode).toBe(0);
			expect(relScope.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
			expect(relScope.stdout).toContain(`under ${test_db_files_mount}/docs`);

			const dotScope = await run(`cd ${test_db_files_mount}/docs && search --path . unique-token`);
			expect(dotScope.metadata.exitCode).toBe(0);
			expect(dotScope.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
			const relCalls = runQuery.mock.calls.map((call) => call[1]).filter((args) => "query" in args);
			expect(relCalls.at(-1)).toEqual(expect.objectContaining({ query: "unique-token", pathPrefix: "/docs" }));

			// Explicit --path scopes must be real app folders.
			const missingScope = await run(`search --path ${test_db_files_mount}/other unique-token`);
			expect(missingScope.metadata.exitCode).toBe(1);
			expect(missingScope.stderr).toContain("--path folder does not exist");

			const fileScope = await run(`search --path ${test_db_files_mount}/docs/readme.md unique-token`);
			expect(fileScope.metadata.exitCode).toBe(2);
			expect(fileScope.stderr).toContain("--path must be a folder");

			// A --path outside currentWorkspacePath (and outside any mount) is rejected.
			const bad = await run("search --path /etc unique-token");
			expect(bad.metadata.exitCode).toBe(2);
			expect(bad.stderr).toContain("--path must be a folder under");
		});

		test("textgrep scans one file's rendered plain text and maps -R to indexed search", async () => {
			const { run, runQuery } = await create_bash_runner({
				extraFiles: [{ path: "/docs/textgrep.md", content: "# Notice\n\n**critical** alert\n" }],
			});
			const filePath = `${test_db_files_mount}/docs/textgrep.md`;

			// Single-file regex over rendered plain text: no line numbers, no separators.
			const singleFile = await run(`textgrep 'critical\\s+alert' ${filePath}`);
			expect(singleFile.metadata.exitCode).toBe(0);
			expect(singleFile.stdout).toBe("critical alert\n");
			expect(singleFile.stderr).toBe("");

			// -F treats regex metacharacters literally, so "critical.alert" does not match.
			const fixed = await run(`textgrep -F 'critical.alert' ${filePath}`);
			expect(fixed.metadata.exitCode).toBe(1);
			expect(fixed.stdout).toBe("");

			// -c counts matching lines; an absent pattern still prints 0 (exit 1).
			const count = await run(`textgrep -c 'critical' ${filePath}`);
			expect(count.metadata.exitCode).toBe(0);
			expect(count.stdout).toBe("1\n");
			const countAbsent = await run(`textgrep -c 'absent-token' ${filePath}`);
			expect(countAbsent.metadata.exitCode).toBe(1);
			expect(countAbsent.stdout).toBe("0\n");

			// -l prints the path when there is a match.
			const list = await run(`textgrep -l 'critical' ${filePath}`);
			expect(list.metadata.exitCode).toBe(0);
			expect(list.stdout).toBe(`${filePath}\n`);

			// -v keeps non-matching lines.
			const invert = await run(`textgrep -v 'critical' ${filePath}`);
			expect(invert.metadata.exitCode).toBe(0);
			expect(invert.stdout).not.toContain("critical alert");

			// -R folder scan routes to indexed full-text search, mirroring grep -R.
			const recursive = await run(`textgrep -R unique-token ${test_db_files_mount}/docs`);
			expect(recursive.metadata.exitCode).toBe(0);
			expect(recursive.stdout).toContain("uses indexed full-text search");
			expect(recursive.stdout).toContain(`Found 1 results under ${test_db_files_mount}/docs`);
			expect(recursive.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
			expect(runQuery.mock.calls.some(([ref]) => function_name_of(ref) === "files_nodes:text_search_files")).toBe(true);
			expect(runQuery).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ query: "unique-token", pathPrefix: "/docs" }),
			);

			// Invalid regex over a single file is reported.
			const invalid = await run(`textgrep '[' ${filePath}`);
			expect(invalid.metadata.exitCode).toBe(2);
			expect(invalid.stderr).toContain("invalid regex");

			// -n is rejected with a pointer to grep.
			const lineNumbers = await run(`textgrep -n 'critical' ${filePath}`);
			expect(lineNumbers.metadata.exitCode).toBe(2);
			expect(lineNumbers.stderr).toContain("grep -n");
		});

		test("textgrep parses extended grep flags and rejects unsupported / recursive-fixed-string forms", async () => {
			const { run, runQuery } = await create_bash_runner({
				extraFiles: [{ path: "/docs/textgrep.md", content: "# Notice\n\n**critical** alert\n" }],
			});
			const filePath = `${test_db_files_mount}/docs/textgrep.md`;
			const folder = `${test_db_files_mount}/docs`;

			// -e / --regexp supply the pattern explicitly.
			const dashE = await run(`textgrep -e 'critical' ${filePath}`);
			expect(dashE.metadata.exitCode).toBe(0);
			expect(dashE.stdout).toBe("critical alert\n");
			const longRegexp = await run(`textgrep --regexp='critical' ${filePath}`);
			expect(longRegexp.metadata.exitCode).toBe(0);
			expect(longRegexp.stdout).toBe("critical alert\n");

			// Combined short flags: -iF (ignore-case + fixed string), -cl (count + list → list wins).
			const combinedIF = await run(`textgrep -iF 'CRITICAL' ${filePath}`);
			expect(combinedIF.metadata.exitCode).toBe(0);
			expect(combinedIF.stdout).toBe("critical alert\n");
			const combinedCL = await run(`textgrep -cl 'critical' ${filePath}`);
			expect(combinedCL.metadata.exitCode).toBe(0);
			expect(combinedCL.stdout).toBe(`${filePath}\n`);

			// Long aliases mirror their short forms.
			const longFixed = await run(`textgrep --fixed-strings 'critical.alert' ${filePath}`);
			expect(longFixed.metadata.exitCode).toBe(1);
			expect(longFixed.stdout).toBe("");
			const longInvert = await run(`textgrep --invert-match 'critical' ${filePath}`);
			expect(longInvert.metadata.exitCode).toBe(0);
			expect(longInvert.stdout).not.toContain("critical alert");
			const longCount = await run(`textgrep --count 'critical' ${filePath}`);
			expect(longCount.metadata.exitCode).toBe(0);
			expect(longCount.stdout).toBe("1\n");
			const longList = await run(`textgrep --files-with-matches 'critical' ${filePath}`);
			expect(longList.metadata.exitCode).toBe(0);
			expect(longList.stdout).toBe(`${filePath}\n`);

			// Context flags are rejected with a pointer to grep.
			for (const contextFlag of ["-A 1", "-B 1", "-C 1", "--context=2"]) {
				const contextRes = await run(`textgrep ${contextFlag} 'critical' ${filePath}`);
				expect(contextRes.metadata.exitCode).toBe(2);
				expect(contextRes.stderr).toContain("context windows");
			}

			// Markdown scan-window flags are rejected.
			const startLine = await run(`textgrep --start-line 2 'critical' ${filePath}`);
			expect(startLine.metadata.exitCode).toBe(2);
			expect(startLine.stderr).toContain("scan-window");
			const startIndex = await run(`textgrep --start-index 0 'critical' ${filePath}`);
			expect(startIndex.metadata.exitCode).toBe(2);
			expect(startIndex.stderr).toContain("scan-window");

			// Removed folder-regex flags now surface as unsupported options.
			for (const removedFlag of ["--path", "--limit", "--cursor"]) {
				const removed = await run(`textgrep ${removedFlag} 'critical' ${filePath}`);
				expect(removed.metadata.exitCode).toBe(2);
				expect(removed.stderr).toContain(`unsupported option ${removedFlag}`);
			}

			// Recursive -c / -l / -v fall to single-file guidance, never indexed search.
			for (const recursiveFlag of ["-c", "-l", "-v"]) {
				const recursive = await run(`textgrep -R ${recursiveFlag} 'critical' ${folder}`);
				expect(recursive.metadata.exitCode).toBe(2);
				expect(recursive.stdout).toContain("textgrep regex runs over ONE app file");
			}

			// Recursive -F is rejected: indexed scans cannot do exact fixed-string matching.
			const recursiveFixed = await run(`textgrep -R -F 'critical' ${folder}`);
			expect(recursiveFixed.metadata.exitCode).toBe(2);
			expect(recursiveFixed.stderr).toContain("does not support exact fixed-string");

			// None of the rejected/guidance forms above reached indexed full-text search.
			expect(runQuery.mock.calls.some(([ref]) => function_name_of(ref) === "files_nodes:text_search_files")).toBe(
				false,
			);
		});

		test("meta searches indexed frontmatter and inspects one file", async () => {
			const { run, runQuery } = await create_bash_runner({
				extraFiles: [
					{
						path: "/docs/meta-email.md",
						content:
							"---\nfrom: alice@example.com\ncc:\n  - Bob\n  - Jane\namount: 125\nreviewed: true\n---\n# Email\n",
					},
					{
						path: "/docs/meta-tags.md",
						content: "---\ntopic:\n  - alpha\n  - atlas\n---\n# Tags\n",
					},
				],
			});

			const paths = await run(`meta search --where '{"eq":["frontmatter.from","alice@example.com"]}' --limit 5`);
			const json = await run(`meta search --format json --where '{"range":["frontmatter.amount",{"gte":100}]}'`);
			const jsonExists = await run(`meta search --format json --where '{"exists":"frontmatter.cc"}'`);
			const dedupedPrefix = await run(`meta search --where '{"prefix":["frontmatter.topic","a"]}' --limit 5`);
			const scoped = await run(`cd ${test_db_files_mount}/docs && meta search --where '{"exists":"frontmatter.cc"}'`);
			const get = await run(`meta get ${test_db_files_mount}/docs/meta-email.md`);
			const invalid = await run(`meta search --where '{"eq":["from","alice@example.com"]}'`);

			expect(paths.metadata.exitCode).toBe(0);
			expect(paths.stdout).toBe(`${test_db_files_mount}/docs/meta-email.md\n`);
			expect(paths.stderr).toBe("");
			expect(
				runQuery.mock.calls.some(
					([ref, args]) =>
						function_name_of(ref) === "files_metadata:search" && (args as { plan?: unknown }).plan != null,
				),
			).toBe(true);

			expect(json.metadata.exitCode).toBe(0);
			expect(json.stderr).toBe("");
			const parsedJson = JSON.parse(json.stdout) as {
				results: Array<{ path: string; field: string; valueKind: string; matchedValue: unknown }>;
				nextCursor: string | null;
			};
			expect(parsedJson.results).toEqual([
				expect.objectContaining({
					path: `${test_db_files_mount}/docs/meta-email.md`,
					field: "frontmatter.amount",
					valueKind: "number",
					matchedValue: 125,
				}),
			]);
			expect(parsedJson.nextCursor).toBeNull();

			expect(jsonExists.metadata.exitCode).toBe(0);
			expect(jsonExists.stderr).toBe("");
			const parsedExistsJson = JSON.parse(jsonExists.stdout) as {
				results: Array<{ path: string; field: string; valueKind: string; matchedValue?: unknown }>;
			};
			expect(parsedExistsJson.results).toEqual([
				expect.objectContaining({
					path: `${test_db_files_mount}/docs/meta-email.md`,
					field: "frontmatter.cc",
					valueKind: "none",
				}),
			]);
			expect(parsedExistsJson.results[0]).not.toHaveProperty("matchedValue");

			expect(dedupedPrefix.metadata.exitCode).toBe(0);
			expect(dedupedPrefix.stderr).toBe("");
			expect(dedupedPrefix.stdout).toBe(`${test_db_files_mount}/docs/meta-tags.md\n`);

			expect(scoped.metadata.exitCode).toBe(0);
			expect(scoped.stdout).toBe(`${test_db_files_mount}/docs/meta-email.md\n`);
			expect(
				runQuery.mock.calls.some(
					([ref, args]) =>
						function_name_of(ref) === "files_metadata:search" &&
						(args as { pathPrefix?: string }).pathPrefix === "/docs",
				),
			).toBe(true);

			expect(get.metadata.exitCode).toBe(0);
			expect(get.stdout).toContain("source: committed");
			expect(get.stdout).toContain("frontmatter.cc");
			expect(get.stdout).toContain('frontmatter.from = "alice@example.com"');

			expect(invalid.metadata.exitCode).toBe(2);
			expect(invalid.stderr).toContain("must be qualified");
		});

		test("does not scan markdown files when indexed search misses", async () => {
			const { run, runAction } = await create_bash_runner();

			const result = await run("search --limit 5 zzz-absent-token");

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toContain("No content matches found");
			expect(result.stdout).toContain("find --path-query QUERY");
			expect(result.stdout).toContain("meta search");
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

			const result = await run(`grep -R unique-token ${test_db_files_mount}/docs`);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stderr).toBe("");
			expect(result.stdout).toContain("uses indexed full-text search");
			expect(result.stdout).toContain(`Found 1 results under ${test_db_files_mount}/docs`);
			expect(result.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
			expect(runQuery).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ query: "unique-token", pathPrefix: "/docs" }),
			);
		});

		test("rejects grep -R -F over an app folder instead of routing to indexed search", async () => {
			const { run, runQuery } = await create_bash_runner();

			const result = await run(`grep -R -F unique-token ${test_db_files_mount}/docs`);

			expect(result.metadata.exitCode).toBe(2);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("does not support exact fixed-string");
			expect(runQuery.mock.calls.some(([ref]) => function_name_of(ref) === "files_nodes:text_search_files")).toBe(
				false,
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

			const result = await run(`grep -R exact-hyphen-token-2026 ${test_db_files_mount}/grep-fixtures`);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toContain(
				`Found 2 results under ${test_db_files_mount}/grep-fixtures (exact matches: 1, word-level-only matches: 1; see per-hit notes)`,
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

			const result = await run(`grep -R exact-hyphen-token-2026 ${test_db_files_mount}/grep-fixtures`);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toContain(
				`Found 1 results under ${test_db_files_mount}/grep-fixtures (exact matches: 0, word-level-only matches: 1; see per-hit notes)`,
			);
			expect(result.stdout).toMatch(
				/grep-fixtures\/broad\.md .+\[word-level match; chunk does not contain 'exact-hyphen-token-2026'\]/u,
			);
		});

		test("greps a single app file (regex by default, -F substring, optional line numbers, -i), guidance otherwise", async () => {
			const { run } = await create_bash_runner();

			// Single app file prints raw matching lines by default, like native grep.
			const hit = await run(`grep unique-token ${test_db_files_mount}/docs/readme.md`);
			expect(hit.metadata.exitCode).toBe(0);
			expect(hit.stdout).toBe("unique-token here\nmore unique-token below\n");

			// Single-file app grep supports regex because it scans one bounded chunk stream.
			const regexHit = await run(`grep 'unique.*below' ${test_db_files_mount}/docs/readme.md`);
			expect(regexHit.metadata.exitCode).toBe(0);
			expect(regexHit.stdout).toBe("more unique-token below\n");

			const invalidRegex = await run(`grep '[' ${test_db_files_mount}/docs/readme.md`);
			expect(invalidRegex.metadata.exitCode).toBe(2);
			expect(invalidRegex.stderr).toContain("invalid regex");

			// -F switches back to fixed-string semantics.
			const fixedMiss = await run(`grep -F 'unique.*below' ${test_db_files_mount}/docs/readme.md`);
			expect(fixedMiss.metadata.exitCode).toBe(1);
			expect(fixedMiss.stdout).toBe("");

			// -n switches to 1-based line numbers.
			const numberedHit = await run(`grep -n unique-token ${test_db_files_mount}/docs/readme.md`);
			expect(numberedHit.metadata.exitCode).toBe(0);
			expect(numberedHit.stdout).toBe("2:unique-token here\n3:more unique-token below\n");

			const dashPattern = await run(`grep -- -token ${test_db_files_mount}/docs/readme.md`);
			expect(dashPattern.metadata.exitCode).toBe(0);
			expect(dashPattern.stdout).toBe("unique-token here\nmore unique-token below\n");

			const piped = await run(`cat ${test_db_files_mount}/docs/readme.md | head -n 20 | grep -n unique-token`);
			expect(piped.metadata.exitCode).toBe(0);
			expect(piped.stdout).toBe("2:unique-token here\n3:more unique-token below\n");

			const pipedRegex = await run(`cat ${test_db_files_mount}/docs/readme.md | grep 'unique.*below'`);
			expect(pipedRegex.metadata.exitCode).toBe(0);
			expect(pipedRegex.stdout).toBe("more unique-token below\n");

			const pipedFixedMiss = await run(`cat ${test_db_files_mount}/docs/readme.md | grep -F 'unique.*below'`);
			expect(pipedFixedMiss.metadata.exitCode).toBe(1);
			expect(pipedFixedMiss.stdout).toBe("");

			// Case-insensitive.
			const ci = await run(`grep -i ALPHA ${test_db_files_mount}/docs/tutorial.md`);
			expect(ci.metadata.exitCode).toBe(0);
			expect(ci.stdout).toBe("alpha\nALPHA\n");

			// No match → exit 1, no output (real grep semantics).
			const none = await run(`grep zzz-nope ${test_db_files_mount}/docs/readme.md`);
			expect(none.metadata.exitCode).toBe(1);
			expect(none.stdout).toBe("");

			// Multiple files → falls back to guidance (we only handle one file).
			const multi = await run(
				`grep token ${test_db_files_mount}/docs/readme.md ${test_db_files_mount}/docs/tutorial.md`,
			);
			expect(multi.metadata.exitCode).toBe(2);
			expect(multi.stdout).toContain("is not supported");

			const unsupportedSingleFileFlag = await run(`grep -o token ${test_db_files_mount}/docs/readme.md`);
			expect(unsupportedSingleFileFlag.metadata.exitCode).toBe(2);
			expect(unsupportedSingleFileFlag.stderr).toContain("unsupported option -o");
			expect(unsupportedSingleFileFlag.stderr).toContain("Supported: grep [-n] [-i] [-F]");

			// -c counts matching lines ("token" is on lines 2 and 3).
			const counted = await run(`grep -c token ${test_db_files_mount}/docs/readme.md`);
			expect(counted.metadata.exitCode).toBe(0);
			expect(counted.stdout).toBe("2\n");

			// Multiple -e patterns (OR semantics we don't reproduce) → guidance, not a silent
			// single-pattern match.
			const multiE = await run(`grep -e token -e other ${test_db_files_mount}/docs/readme.md`);
			expect(multiE.metadata.exitCode).toBe(2);

			// Combined short flags: -in (= -i -n) takes the single-file fast path, case-insensitively.
			const combined = await run(`grep -in ALPHA ${test_db_files_mount}/docs/tutorial.md`);
			expect(combined.metadata.exitCode).toBe(0);
			expect(combined.stdout).toBe("2:alpha\n3:ALPHA\n");

			const fixedCombined = await run(`grep -Fin alpha ${test_db_files_mount}/docs/tutorial.md`);
			expect(fixedCombined.metadata.exitCode).toBe(0);
			expect(fixedCombined.stdout).toBe("2:alpha\n3:ALPHA\n");

			// -iv (= -i -v) inverts: only line 1 lacks "token" (case-insensitively).
			const combinedV = await run(`grep -iv token ${test_db_files_mount}/docs/readme.md`);
			expect(combinedV.metadata.exitCode).toBe(0);
			expect(combinedV.stdout).toBe("# Readme\n");

			// -l prints the file path when it has a match, and exits 1 (no output) when it does not.
			const listed = await run(`grep -l unique-token ${test_db_files_mount}/docs/readme.md`);
			expect(listed.metadata.exitCode).toBe(0);
			expect(listed.stdout).toBe(`${test_db_files_mount}/docs/readme.md\n`);
			const listedNone = await run(`grep -l zzz-nope ${test_db_files_mount}/docs/readme.md`);
			expect(listedNone.metadata.exitCode).toBe(1);
			expect(listedNone.stdout).toBe("");

			// -B N adds leading context. Without -n, both matching and context lines are raw text.
			const before = await run(`grep -B 1 ALPHA ${test_db_files_mount}/docs/tutorial.md`);
			expect(before.metadata.exitCode).toBe(0);
			expect(before.stdout).toBe("alpha\nALPHA\n");

			// With -n, context lines use "-" and selected lines use ":".
			const beforeNumbered = await run(`grep -n -B 1 ALPHA ${test_db_files_mount}/docs/tutorial.md`);
			expect(beforeNumbered.metadata.exitCode).toBe(0);
			expect(beforeNumbered.stdout).toBe("2-alpha\n3:ALPHA\n");

			// -v without context stays native-like: non-contiguous selected lines are printed directly.
			const invertGap = await run(`grep -v alpha ${test_db_files_mount}/docs/tutorial.md`);
			expect(invertGap.metadata.exitCode).toBe(0);
			expect(invertGap.stdout).toBe("zeta\nALPHA\n");

			const pipedInvertGap = await run(`cat ${test_db_files_mount}/docs/tutorial.md | grep -v alpha`);
			expect(pipedInvertGap.metadata.exitCode).toBe(0);
			expect(pipedInvertGap.stdout).toBe("zeta\nALPHA\n");
		});

		test("supports app grep line and slice continuation windows", async () => {
			const latePath = "/docs/late-grep.md";
			const longPath = "/docs/long-line-grep.md";
			const longPrefix = "x".repeat(256 * 1024);
			const { run } = await create_bash_runner({
				extraFiles: [
					{
						path: latePath,
						content: ["first line", "late-window-token", "third line"].join("\n"),
					},
					{
						path: longPath,
						content: `${longPrefix}needle-after-long-prefix\n`,
					},
				],
			});

			const lineWindow = await run(
				`grep --start-line 3 --max-lines 1 unique-token ${test_db_files_mount}/docs/readme.md`,
			);
			expect(lineWindow.metadata.exitCode).toBe(0);
			expect(lineWindow.stdout).toBe("more unique-token below\n");

			const capped = await run(`grep --start-line 1 --max-lines 1 late-window-token ${test_db_files_mount}${latePath}`);
			expect(capped.metadata.exitCode).toBe(1);
			expect(capped.stdout).toBe("");
			expect(capped.stderr).toContain("line scan cap reached");
			expect(capped.stderr).toContain(
				`Next scan: grep --start-line 2 --max-lines 1 late-window-token ${test_db_files_mount}${latePath}`,
			);

			const continued = await run(
				`grep --start-line 2 --max-lines 1 late-window-token ${test_db_files_mount}${latePath}`,
			);
			expect(continued.metadata.exitCode).toBe(0);
			expect(continued.stdout).toBe("late-window-token\n");

			const byteCapped = await run(`grep needle-after-long-prefix ${test_db_files_mount}${longPath}`);
			expect(byteCapped.metadata.exitCode).toBe(1);
			expect(byteCapped.stdout).toBe("");
			expect(byteCapped.stderr).toContain("byte scan cap reached");
			const byteContinuationCommand = byteCapped.stderr.match(
				/Next scan: (grep --start-index 0 --max-chars \d+ needle-after-long-prefix [^\n]+)/u,
			)?.[1];
			expect(byteContinuationCommand?.startsWith("grep --start-index 0 --max-chars ")).toBe(true);
			expect(byteContinuationCommand).toContain(` needle-after-long-prefix ${test_db_files_mount}${longPath}`);

			const slice = await run(
				`grep --start-index ${longPrefix.length - 8} --max-chars 128 needle-after-long-prefix ${test_db_files_mount}${longPath}`,
			);
			expect(slice.metadata.exitCode).toBe(0);
			expect(slice.stdout).toBe(`xxxxxxxxneedle-after-long-prefix\n`);
			expect(slice.stderr).toContain("slice mode scans a text slice");
		});

		test("uses regex for single-file app grep patterns that look like regex", async () => {
			const { run } = await create_bash_runner();

			const anchored = await run(`grep '^# Readme' ${test_db_files_mount}/docs/readme.md`);
			const wildcard = await run(`grep 'unique.*token' ${test_db_files_mount}/docs/readme.md`);
			const fixed = await run(`grep -F '^# Readme' ${test_db_files_mount}/docs/readme.md`);

			expect(anchored.metadata.exitCode).toBe(0);
			expect(anchored.stdout).toBe("# Readme\n");
			expect(anchored.stderr).toBe("");
			expect(wildcard.metadata.exitCode).toBe(0);
			expect(wildcard.stdout).toBe("unique-token here\nmore unique-token below\n");
			expect(fixed.metadata.exitCode).toBe(1);
			expect(fixed.stdout).toBe("");
			expect(fixed.stderr).toBe("");
		});

		test("warns when app grep output is capped", async () => {
			const path = "/docs/capped-grep.md";
			const { run } = await create_bash_runner({
				extraFiles: [
					{
						path,
						content: Array.from({ length: 105 }, (_, index) => `cap-token ${index + 1}`).join("\n"),
					},
				],
			});

			const capped = await run(`grep cap-token ${test_db_files_mount}${path}`);

			expect(capped.metadata.exitCode).toBe(0);
			expect(capped.stdout.split("\n").filter(Boolean)).toHaveLength(100);
			expect(capped.stderr).toContain("match cap reached");
			expect(capped.stderr).toContain("Next scan:");
		});

		test("treats chunk-unavailable app grep as no match", async () => {
			const path = "/docs/large-grep.md";
			const { run } = await create_bash_runner({
				extraFiles: [
					{
						path,
						content: `match-token\n${"filler-line\n".repeat(800)}`,
						brokenChunks: true,
					},
				],
			});
			const shellPath = `${test_db_files_mount}${path}`;

			const match = await run(`grep match-token ${shellPath}`);
			const noMatch = await run(`grep missing-token ${shellPath}`);

			for (const result of [match, noMatch]) {
				expect(result.metadata.exitCode).toBe(1);
				expect(result.stdout).toBe("");
				expect(result.stderr).toBe("");
			}
			expect(noMatch.stdout).toBe("");
		});

		test("uses prefix find and renders app tree pages", async () => {
			const { run } = await create_bash_runner();
			const scopedRunner = await create_bash_runner({ initialCwd: `${test_db_files_mount}/docs` });

			const prefixResult = await run("find --prefix /docs --limit 20 -type f");
			const relativePrefixResult = await scopedRunner.run("find --prefix nested --limit 1");
			const treeResult = await run(`tree ${test_db_files_mount}/docs --limit 2`);

			expect(prefixResult.metadata.exitCode).toBe(0);
			expect(prefixResult.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
			expect(prefixResult.stdout).toContain(`${test_db_files_mount}/docs/tutorial.md`);
			expect(relativePrefixResult.metadata.exitCode).toBe(0);
			expect(relativePrefixResult.stdout).toMatch(
				new RegExp(`Next page: find --prefix ${test_db_files_mount}/docs/nested --limit 1 --cursor \\S+`, "u"),
			);
			expect(treeResult.metadata.exitCode).toBe(0);
			expect(treeResult.stdout).toContain(test_db_files_mount + "/docs");
			expect(treeResult.stdout).toContain("|-- nested/");
			expect(treeResult.stdout).toContain("|   |-- deep.md");
			expect(treeResult.stdout).toMatch(
				new RegExp(`Next page: tree ${test_db_files_mount}/docs --limit 2 --cursor \\S+`, "u"),
			);
		});

		test("tree continuation pages remind agents to stop after one requested continuation", async () => {
			const { run } = await create_bash_runner({
				extraFiles: [
					{ path: "/tree-stop/a.md", content: "a\n" },
					{ path: "/tree-stop/b.md", content: "b\n" },
					{ path: "/tree-stop/c.md", content: "c\n" },
				],
			});

			const firstPage = await run(`tree ${test_db_files_mount}/tree-stop --limit 1`);
			const continuation = firstPage.stdout.match(/Next page: (tree .+)/u)?.[1];
			if (continuation == null) {
				throw new Error("expected a tree continuation in the first page stdout");
			}

			const secondPage = await run(continuation);

			expect(secondPage.metadata.exitCode).toBe(0);
			expect(secondPage.stdout).toContain("Next page: tree");
			expect(secondPage.stdout).toContain("if the user asked for exactly one continuation, stop here");
		});

		test("renders exact file tree targets without subtree pagination", async () => {
			const { run, runQuery } = await create_bash_runner();

			const result = await run(`tree ${test_db_files_mount}/docs/readme.md --limit 2`);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout.trim()).toBe(`${test_db_files_mount}/docs/readme.md`);
			expect(runQuery.mock.calls.some(([ref]) => function_name_of(ref) === "files_nodes:list_subtree")).toBe(false);
		});

		test("keeps tree app-only option guidance out of /tmp paths", async () => {
			const { run, runQuery } = await create_bash_runner();

			const nativeJustBashResult = await run(
				"mkdir -p /tmp/tree-tmp && printf hi > /tmp/tree-tmp/a.md && tree -P '*.md' /tmp/tree-tmp",
			);
			const appResult = await run(`tree -P '*.md' ${test_db_files_mount}/docs`);
			const nativeJustBashNextPage = await run("tree --next-page /tmp");
			const appNextPage = await run(`tree --next-page ${test_db_files_mount}/docs`);

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
					`head -n 1 ${test_db_files_mount}/docs/readme.md`,
					`tail -n +2 ${test_db_files_mount}/docs/readme.md`,
					`wc -c ${test_db_files_mount}/docs/readme.md`,
					`stat -c "%F %n" ${test_db_files_mount}/docs/readme.md`,
				].join(" && "),
			);
			const unreadableHead = await run(`head ${test_db_files_mount}/source.pdf`);
			const unreadableTail = await run(`tail ${test_db_files_mount}/source.pdf`);
			const unreadableWc = await run(`wc ${test_db_files_mount}/source.pdf`);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toContain("# Readme");
			expect(result.stdout).toContain("unique-token");
			expect(result.stdout).toContain(`${test_db_files_mount}/docs/readme.md`);
			expect(result.stdout).toContain("regular file");
			for (const unreadable of [unreadableHead, unreadableTail, unreadableWc]) {
				expect(unreadable.metadata.exitCode).toBe(1);
				expect(unreadable.stdout).toBe("");
				expect(unreadable.stderr).toContain("Markdown and plain text files only");
				expect(unreadable.stderr).toContain(`${test_db_files_mount}/source.pdf.md`);
			}
		});

		test("supports stat long format options and dash-leading operands after --", async () => {
			const { run } = await create_bash_runner();
			const readmePath = `${test_db_files_mount}/docs/readme.md`;

			const shortFormat = await run(`stat -c "%F %n" ${readmePath}`);
			const longFormat = await run(`stat --format "%F %n" ${readmePath}`);
			const equalsFormat = await run(`stat --format=%F ${readmePath}`);
			const literalPercent = await run(`stat -c "%% %F" ${readmePath}`);
			const dashLeadingTmp = await run("printf hi > /tmp/-dash-stat && stat -- /tmp/-dash-stat");

			expect(shortFormat.metadata.exitCode).toBe(0);
			expect(longFormat.metadata.exitCode).toBe(0);
			expect(equalsFormat.metadata.exitCode).toBe(0);
			expect(literalPercent.metadata.exitCode).toBe(0);
			expect(dashLeadingTmp.metadata.exitCode).toBe(0);
			expect(longFormat.stdout).toBe(shortFormat.stdout);
			expect(equalsFormat.stdout).toBe("regular file\n");
			expect(literalPercent.stdout).toBe("% regular file\n");
			expect(dashLeadingTmp.stdout).toContain("File: /tmp/-dash-stat");
			expect(dashLeadingTmp.stdout).not.toContain("app files track");
		});

		test("warns about unsupported app stat format tokens without changing stdout", async () => {
			const { run } = await create_bash_runner();
			const readmePath = `${test_db_files_mount}/docs/readme.md`;

			const appResult = await run(`stat -c "%i %b %s %%" ${readmePath}`);
			const tmpResult = await run('printf hi > /tmp/stat-format.txt && stat -c "%i %b %s %%" /tmp/stat-format.txt');

			expect(appResult.metadata.exitCode).toBe(0);
			expect(appResult.stdout).toContain("%i %b ");
			expect(appResult.stdout).toContain(" %\n");
			expect(appResult.stderr).toContain("app files support only");
			expect(appResult.stderr).toContain("inode, blocks, device, and filesystem fields are not tracked");
			expect(tmpResult.metadata.exitCode).toBe(0);
			expect(tmpResult.stderr).not.toContain("app files support only");
		});

		test("does not recursively expand stat format tokens introduced by file names", async () => {
			const { run } = await create_bash_runner({
				extraFiles: [{ path: "/docs/%s-%F.md", content: "token name\n" }],
			});
			const tokenPath = `${test_db_files_mount}/docs/%s-%F.md`;

			const result = await run(`stat -c "%n" '${tokenPath}'`);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toBe(`${tokenPath}\n`);
		});

		test("keeps stat glob guidance scoped to app paths", async () => {
			const { run } = await create_bash_runner();

			const tmpGlob = await run("printf hi > '/tmp/star*.txt' && stat '/tmp/star*.txt'");
			const appGlob = await run(`stat '${test_db_files_mount}/docs/*.md'`);

			expect(tmpGlob.metadata.exitCode).toBe(0);
			expect(tmpGlob.stdout).toContain("File: /tmp/star*.txt");
			expect(tmpGlob.stderr).not.toContain("app file glob patterns are not supported");
			expect(appGlob.metadata.exitCode).not.toBe(0);
			expect(appGlob.stderr).toContain("app file glob patterns are not supported");
			expect(appGlob.stderr).toContain("find");
		});

		test("renders app stat metadata without fake block counts", async () => {
			const { run } = await create_bash_runner();

			const result = await run(`stat ${test_db_files_mount}/docs/readme.md`);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toContain("  Size: ");
			expect(result.stdout).not.toContain("Blocks:");
			expect(result.stdout).toContain("not POSIX permissions, owner, group, inode, or blocks");
		});

		test("stat reports non-editable asset size through the shared size helper", async () => {
			const { run, runQuery } = await create_bash_runner();
			const sourcePath = `${test_db_files_mount}/source.pdf`;
			runQuery.mockClear();

			const result = await run(`stat -c %s ${sourcePath}`);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toBe("4096\n");
			expect(runQuery.mock.calls.filter(([ref]) => function_name_of(ref) === "r2:get_asset_by_id")).toHaveLength(1);
		});

		test("stat reports unsaved edit size before the committed asset size", async () => {
			const runner = await create_bash_runner({
				extraFiles: [{ path: "/draft-stat.md", content: "tiny base\n" }],
			});
			const { files_yjs_doc_create_from_markdown, files_u8_to_array_buffer } = await import("./files.ts");
			const { encodeStateAsUpdate } = await import("yjs");
			const baseYjsDoc = files_yjs_doc_create_from_markdown({ markdown: "tiny base" });
			if ("_nay" in baseYjsDoc) {
				throw new Error(baseYjsDoc._nay.message);
			}
			const draftNodeId = await get_seeded_node_id(runner, "/draft-stat.md");
			const upserted = await runner.t.mutation(internal.files_pending_updates.upsert_file_pending_update_in_db, {
				organizationId: runner.seeded.organizationId,
				workspaceId: runner.seeded.workspaceId,
				userId: runner.seeded.userId,
				nodeId: draftNodeId,
				baseYjsSequence: 1,
				baseYjsUpdate: files_u8_to_array_buffer(encodeStateAsUpdate(baseYjsDoc)),
				unstagedMarkdown: Array.from({ length: 400 }, (_, index) => `line ${index + 1}`).join("\n\n"),
			});
			if (upserted._nay) {
				throw new Error(upserted._nay.message);
			}
			const pendingUpdate = await runner.t.query(internal.files_pending_updates.get_by_file_node, {
				organizationId: runner.seeded.organizationId,
				workspaceId: runner.seeded.workspaceId,
				userId: runner.seeded.userId,
				fileNodeId: draftNodeId,
			});
			if (pendingUpdate?.size == null) {
				throw new Error("expected pending update size to be set for /draft-stat.md");
			}
			const draftPath = `${test_db_files_mount}/draft-stat.md`;
			runner.runQuery.mockClear();

			const result = await runner.run(`stat -c %s ${draftPath}`);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toBe(`${pendingUpdate.size}\n`);
			expect(runner.runQuery.mock.calls.some(([ref]) => function_name_of(ref) === "r2:get_asset_by_id")).toBe(false);
		});

		test("rejects stat format options without a value", async () => {
			const { run } = await create_bash_runner();

			const shortFormat = await run("stat -c");
			const longFormat = await run("stat --format");

			expect(shortFormat.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
			expect(longFormat.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
			expect(shortFormat.stderr).toContain("stat: -c requires a value");
			expect(longFormat.stderr).toContain("stat: --format requires a value");
			expect(shortFormat.stderr).toContain("Usage: stat [-c FORMAT] [--] FILE...");
			expect(longFormat.stderr).toContain("Usage: stat [-c FORMAT] [--] FILE...");
		});

		test("caps the number of app files a single reader command fetches", async () => {
			const { run, runAction } = await create_bash_runner();

			const overCapFiles = Array.from(
				{ length: bash_READER_FILE_OPERAND_MAX + 1 },
				(_, index) => `${test_db_files_mount}/doc-${index}.md`,
			).join(" ");
			const atCapFiles = Array.from(
				{ length: bash_READER_FILE_OPERAND_MAX },
				(_, index) => `${test_db_files_mount}/doc-${index}.md`,
			).join(" ");

			// The over-cap reads must short-circuit before any content fetch, so assert no
			// runAction before any later run (the at-cap cat below legitimately fetches content).
			const overCap = await run(`cat ${overCapFiles}`);
			expect(overCap.metadata.exitCode).toBe(2);
			expect(overCap.stderr).toContain(
				`cat: db-backed file reads are limited to ${bash_READER_FILE_OPERAND_MAX} files per command`,
			);
			expect(overCap.stderr).toContain(`you requested ${bash_READER_FILE_OPERAND_MAX + 1}`);
			expect(runAction).not.toHaveBeenCalled();

			const headOverCap = await run(`head ${overCapFiles}`);
			const wcOverCap = await run(`wc -l ${overCapFiles}`);
			const statOverCap = await run(`stat ${overCapFiles}`);
			const atCap = await run(`cat ${atCapFiles}`);

			expect(headOverCap.metadata.exitCode).toBe(2);
			expect(headOverCap.stderr).toContain(`head: db-backed file reads are limited to ${bash_READER_FILE_OPERAND_MAX}`);
			expect(wcOverCap.metadata.exitCode).toBe(2);
			expect(wcOverCap.stderr).toContain(`wc: db-backed file reads are limited to ${bash_READER_FILE_OPERAND_MAX}`);
			expect(statOverCap.metadata.exitCode).toBe(2);
			expect(statOverCap.stderr).toContain(`stat: db-backed file reads are limited to ${bash_READER_FILE_OPERAND_MAX}`);
			expect(atCap.stderr).not.toContain("db-backed file reads are limited");
		});

		test("counts only db-file operands toward the reader cap, not /tmp scratch", async () => {
			const { run } = await create_bash_runner();

			const tmpFiles = Array.from({ length: 20 }, (_, index) => `/tmp/scratch-${index}.txt`).join(" ");
			const dbFileOperands = Array.from(
				{ length: bash_READER_FILE_OPERAND_MAX + 1 },
				(_, index) => `${test_db_files_mount}/doc-${index}.md`,
			).join(" ");

			const result = await run(`cat ${tmpFiles} ${dbFileOperands}`);

			expect(result.metadata.exitCode).toBe(2);
			expect(result.stderr).toContain(`you requested ${bash_READER_FILE_OPERAND_MAX + 1}`);
		});

		test("pages large files smoothly: cat/head/sed/tail return bounded pages with hints, wc reports counts", async () => {
			const { run } = await create_bash_runner({ extraFiles: [big_md_file] });
			const bigPath = `${test_db_files_mount}/big.md`;

			const catResult = await run(`cat ${bigPath}`);
			const wcResult = await run(`wc -l ${bigPath}`);
			const headResult = await run(`head -n 3 ${bigPath}`);
			const sedResult = await run(`sed -n '4,6p' ${bigPath}`);
			const tailResult = await run(`tail -n 3 ${bigPath}`);
			const headOverCap = await run(`head -n 9999 ${bigPath}`);
			const smallStillWorks = await run(`cat ${test_db_files_mount}/docs/readme.md`);

			// cat no longer refuses: it returns a bounded first page on stdout, with the advisory
			// on stderr so it never contaminates a pipe.
			expect(catResult.metadata.exitCode).toBe(0);
			expect(catResult.stdout).toContain("line 1\nline 2");
			expect(catResult.stdout).not.toContain("showing the first");
			expect(catResult.stderr).toContain(`showing the first ${bash_READ_HEAD_LARGE_FILE_MAX_LINES} lines`);
			expect(catResult.stderr).toContain(
				`sed -n '${bash_READ_HEAD_LARGE_FILE_MAX_LINES + 1},${bash_READ_HEAD_LARGE_FILE_MAX_LINES * 2}p' ${bigPath}`,
			);
			// wc reports the line count (so the agent knows the size).
			expect(wcResult.metadata.exitCode).toBe(0);
			expect(wcResult.stdout).toContain(`1000 ${bigPath}`);
			// head reads first N lines and puts the next-page command on stderr.
			expect(headResult.metadata.exitCode).toBe(0);
			expect(headResult.stdout).toContain("line 1\nline 2\nline 3\n");
			expect(headResult.stderr).toContain(`Next page: sed -n '4,6p' ${bigPath}`);
			// sed -n 'A,Bp' reads that exact range and puts its continuation on stderr.
			expect(sedResult.metadata.exitCode).toBe(0);
			expect(sedResult.stdout).toContain("line 4\nline 5\nline 6\n");
			expect(sedResult.stderr).toContain(`Next page: sed -n '7,9p' ${bigPath}`);
			// tail reads the last N lines and puts the partial-view note on stderr.
			expect(tailResult.metadata.exitCode).toBe(0);
			expect(tailResult.stdout).toContain("line 998\nline 999\nline 1000\n");
			expect(tailResult.stderr).toContain("tail: showing the last 3 lines");
			expect(tailResult.stderr).toContain(`head -n 3 ${bigPath}`);
			// head -n beyond the per-page cap clamps (no refusal) and notes it.
			expect(headOverCap.metadata.exitCode).toBe(0);
			expect(headOverCap.stderr).toContain(`showing ${bash_READ_HEAD_LARGE_FILE_MAX_LINES} lines (per-page cap)`);
			// Files under the cap are unaffected.
			expect(smallStillWorks.metadata.exitCode).toBe(0);
			expect(smallStillWorks.stdout).toContain("# Readme");
		});

		test("large cat uses query-only chunk line range reads", async () => {
			const { run, runQuery, runAction } = await create_bash_runner({ extraFiles: [big_md_file] });
			const bigPath = `${test_db_files_mount}/big.md`;

			const result = await run(`cat ${bigPath}`);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toContain("line 1\nline 2");
			expect(result.stderr).toContain(`showing the first ${bash_READ_HEAD_LARGE_FILE_MAX_LINES} lines`);
			expect(
				runQuery.mock.calls.some(([ref]) => function_name_of(ref) === "files_nodes:read_file_content_from_chunks"),
			).toBe(true);
			expect(runAction.mock.calls.some(([ref]) => function_name_of(ref) === "files_nodes:read_file_line_range")).toBe(
				false,
			);
		});

		test("prints absolute db-files paths in large-file reader continuations", async () => {
			const { run } = await create_bash_runner({ initialCwd: test_db_files_mount, extraFiles: [big_md_file] });
			const bigPath = `${test_db_files_mount}/big.md`;

			const catResult = await run("cat big.md");
			const headResult = await run("head -n 3 big.md");
			const tailForwardResult = await run("tail -n +5 big.md");
			const sedResult = await run("sed -n '4,6p' big.md");
			const tailResult = await run("tail -n 3 big.md");

			expect(catResult.stderr).toContain(
				`sed -n '${bash_READ_HEAD_LARGE_FILE_MAX_LINES + 1},${bash_READ_HEAD_LARGE_FILE_MAX_LINES * 2}p' ${bigPath}`,
			);
			expect(headResult.stderr).toContain(`Next page: sed -n '4,6p' ${bigPath}`);
			expect(tailForwardResult.stderr).toContain(
				`Next page: sed -n '${5 + bash_READ_HEAD_LARGE_FILE_MAX_LINES},${5 + bash_READ_HEAD_LARGE_FILE_MAX_LINES * 2 - 1}p' ${bigPath}`,
			);
			expect(sedResult.stderr).toContain(`Next page: sed -n '7,9p' ${bigPath}`);
			expect(tailResult.stderr).toContain(`head -n 3 ${bigPath}`);
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
			const bigPath = `${test_db_files_mount}/big.md`;

			const headResult = await run(`head -n 3 ${bigPath}`);
			const tailForwardResult = await run(`tail -n +5 ${bigPath}`);
			const sedResult = await run(`sed -n '5,9p' ${bigPath}`);

			for (const result of [headResult, tailForwardResult, sedResult]) {
				expect(result.metadata.exitCode).toBe(0);
				expect(result.stdout).not.toContain("Next page:");
				expect(result.stderr).toContain("only");
			}
		});

		test("supports obsolete head and tail line-count flags on large files", async () => {
			const { run } = await create_bash_runner({ extraFiles: [big_md_file] });
			const bigPath = `${test_db_files_mount}/big.md`;

			const headResult = await run(`head -5 ${bigPath}`);
			const tailResult = await run(`tail -3 ${bigPath}`);

			expect(headResult.metadata.exitCode).toBe(0);
			expect(headResult.stdout).toContain("line 1\nline 2\nline 3\nline 4\nline 5\n");
			expect(headResult.stderr).toContain(`Next page: sed -n '6,10p' ${bigPath}`);
			expect(tailResult.metadata.exitCode).toBe(0);
			expect(tailResult.stdout).toContain("line 998\nline 999\nline 1000\n");
			expect(tailResult.stderr).toContain(`head -n 3 ${bigPath}`);
		});

		test("rejects missing and invalid head and tail line counts", async () => {
			const { run } = await create_bash_runner();
			const readmePath = `${test_db_files_mount}/docs/readme.md`;

			const missingHead = await run("head -n");
			const invalidHead = await run(`head -n nope ${readmePath}`);
			const missingTail = await run("tail --lines");
			const invalidTail = await run(`tail --lines=nope ${readmePath}`);

			expect(missingHead.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
			expect(missingHead.stderr).toContain("head: -n requires a value");
			expect(invalidHead.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
			expect(invalidHead.stderr).toContain("head: -n must be an integer line count");
			expect(missingTail.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
			expect(missingTail.stderr).toContain("tail: --lines requires a value");
			expect(invalidTail.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
			expect(invalidTail.stderr).toContain("tail: --lines must be an integer line count");
			for (const result of [missingHead, invalidHead, missingTail, invalidTail]) {
				expect(result.stderr).toContain("Usage:");
			}
		});

		test("supports head tail and wc end-of-options markers for app operands", async () => {
			const { run } = await create_bash_runner({
				initialCwd: test_db_files_mount,
				extraFiles: [{ path: "/-reader.md", content: "dash reader\n" }],
			});

			const headResult = await run("head -n 1 -- -reader.md");
			const tailResult = await run("tail -n +1 -- -reader.md");
			const wcResult = await run("wc -c -- -reader.md");

			expect(headResult.metadata.exitCode).toBe(0);
			expect(headResult.stdout).toBe("dash reader\n");
			expect(tailResult.metadata.exitCode).toBe(0);
			expect(tailResult.stdout).toBe("dash reader\n");
			expect(wcResult.metadata.exitCode).toBe(0);
			expect(wcResult.stdout).toContain(`12 -reader.md`);
		});

		test("rejects byte-range reads for oversized app files with explicit guidance", async () => {
			const { run } = await create_bash_runner({ extraFiles: [big_md_file] });
			const bigPath = `${test_db_files_mount}/big.md`;

			const headResult = await run(`head -c 100 ${bigPath}`);
			const tailResult = await run(`tail -c 100 ${bigPath}`);

			expect(headResult.metadata.exitCode).toBe(1);
			expect(headResult.stderr).toContain("byte-range reads (-c) are not supported for large app files");
			expect(headResult.stderr).toContain(`wc -c ${bigPath}`);
			expect(tailResult.metadata.exitCode).toBe(1);
			expect(tailResult.stderr).toContain("byte-range reads (-c) are not supported for large app files");
			expect(tailResult.stderr).toContain(`wc -c ${bigPath}`);
		});

		test("does not drop non-app operands when a mixed reader command includes a large app file", async () => {
			const { run } = await create_bash_runner({ extraFiles: [big_md_file] });
			const bigPath = `${test_db_files_mount}/big.md`;

			await run("printf tmp > /tmp/reader-mixed.txt");
			const result = await run(`head -n 3 ${bigPath} /tmp/reader-mixed.txt`);

			expect(result.metadata.exitCode).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("over the");
			expect(result.stderr).toContain("inline read limit");
		});

		test("wc over one app file uses the bounded stats path", async () => {
			const { run, runAction } = await create_bash_runner({
				extraFiles: [{ path: "/wc/single.md", content: "on two\nthree\nfour x\n" }],
			});

			const result = await run(`wc ${test_db_files_mount}/wc/single.md`);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toContain(`3 5 20 ${test_db_files_mount}/wc/single.md`);
			const statsCalls = runAction.mock.calls.filter((call) => {
				const actionArgs = call[1];
				return (
					actionArgs && typeof actionArgs === "object" && "path" in actionArgs && actionArgs.path === "/wc/single.md"
				);
			});
			expect(statsCalls).toHaveLength(1);
		});

		test("wc over multiple app files reports per-file counts plus a total via the bounded stats path", async () => {
			const { run, runAction } = await create_bash_runner({
				extraFiles: [
					{ path: "/wc/a.md", content: "on two\nthree\nfour x\n" },
					{ path: "/wc/b.md", content: "abc cd\nef g\n" },
				],
			});

			const result = await run(`wc ${test_db_files_mount}/wc/a.md ${test_db_files_mount}/wc/b.md`);

			expect(result.metadata.exitCode).toBe(0);
			// Default triad (lines words bytes) per file, then a summed total line.
			expect(result.stdout).toContain(`3 5 20 ${test_db_files_mount}/wc/a.md`);
			expect(result.stdout).toContain(`2 4 12 ${test_db_files_mount}/wc/b.md`);
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
			const linesOnly = await run(`wc -l ${test_db_files_mount}/wc/a.md ${test_db_files_mount}/wc/b.md`);
			expect(linesOnly.metadata.exitCode).toBe(0);
			expect(linesOnly.stdout).toContain(`3 ${test_db_files_mount}/wc/a.md`);
			expect(linesOnly.stdout).toContain(`2 ${test_db_files_mount}/wc/b.md`);
			expect(linesOnly.stdout).toContain("5 total");

			const combinedLinesWords = await run(`wc -lw ${test_db_files_mount}/wc/a.md ${test_db_files_mount}/wc/b.md`);
			expect(combinedLinesWords.metadata.exitCode).toBe(0);
			expect(combinedLinesWords.stdout).toContain(`3 5 ${test_db_files_mount}/wc/a.md`);
			expect(combinedLinesWords.stdout).toContain(`2 4 ${test_db_files_mount}/wc/b.md`);
			expect(combinedLinesWords.stdout).toContain("5 9 total");

			const combinedCharsBytes = await run(`wc -mc ${test_db_files_mount}/wc/a.md ${test_db_files_mount}/wc/b.md`);
			expect(combinedCharsBytes.metadata.exitCode).toBe(0);
			expect(combinedCharsBytes.stdout).toContain(`20 20 ${test_db_files_mount}/wc/a.md`);
			expect(combinedCharsBytes.stdout).toContain(`12 12 ${test_db_files_mount}/wc/b.md`);
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

			const result = await run(`wc -l ${test_db_files_mount}/wc/windowed.md ${test_db_files_mount}/wc/missing.md`);

			// A missing operand reports an error and exit 1, but the readable file still counts.
			expect(result.metadata.exitCode).toBe(1);
			expect(result.stderr).toContain(`wc: ${test_db_files_mount}/wc/missing.md: No such file or directory`);
			expect(result.stdout).toContain(`40 ${test_db_files_mount}/wc/windowed.md`);
			expect(result.stdout).toContain("40 total");
			// The windowed file makes line/word/char counts lower bounds (bytes stay exact).
			expect(result.stderr).toContain("lower bounds");
		});

		test("multi-file wc uses the readable-sibling advisory for unreadable app operands", async () => {
			const { run } = await create_bash_runner({
				extraFiles: [{ path: "/wc/a.md", content: "on two\nthree\nfour x\n" }],
			});

			const result = await run(`wc ${test_db_files_mount}/wc/a.md ${test_db_files_mount}/source.pdf`);

			expect(result.metadata.exitCode).toBe(1);
			expect(result.stdout).toContain(`3 5 20 ${test_db_files_mount}/wc/a.md`);
			expect(result.stdout).toContain("3 5 20 total");
			expect(result.stderr).toContain("Markdown and plain text files only");
			expect(result.stderr).toContain(`${test_db_files_mount}/source.pdf.md`);
			expect(result.stderr).toContain(`stat -c %s ${test_db_files_mount}/source.pdf`);
		});

		test("tail -n +K reads forward from line K on a large file (not the trailing window)", async () => {
			const { run } = await create_bash_runner({ extraFiles: [big_md_file] });
			const bigPath = `${test_db_files_mount}/big.md`;

			const result = await run(`tail -n +5 ${bigPath}`);

			expect(result.metadata.exitCode).toBe(0);
			// Forward read from line 5 (not the last lines), bounded to the per-page cap.
			expect(result.stdout).toContain("line 5\nline 6\nline 7\n");
			expect(result.stdout).not.toContain("line 1000");
			// Forward continuation page via sed, anchored at the offset.
			expect(result.stderr).toContain(
				`sed -n '${5 + bash_READ_HEAD_LARGE_FILE_MAX_LINES},${5 + bash_READ_HEAD_LARGE_FILE_MAX_LINES * 2 - 1}p' ${bigPath}`,
			);
		});

		test("cat refuses a multi-file concatenation when a member is too large to inline", async () => {
			const { run } = await create_bash_runner({ extraFiles: [big_md_file] });
			const bigPath = `${test_db_files_mount}/big.md`;
			const smallPath = `${test_db_files_mount}/docs/readme.md`;

			const result = await run(`cat ${bigPath} ${smallPath}`);

			expect(result.metadata.exitCode).toBe(1);
			expect(result.stderr).toContain("too large to concatenate");
			// Nothing from the small file is emitted: the refusal happens up front.
			expect(result.stdout).not.toContain("# Readme");
		});

		test("piping a large cat keeps the advisory out of the pipe", async () => {
			const { run } = await create_bash_runner({ extraFiles: [big_md_file] });
			const bigPath = `${test_db_files_mount}/big.md`;

			const result = await run(`cat ${bigPath} | cat`);

			// The footer is on stderr, so only the file content flows downstream.
			expect(result.stdout).toContain("line 1");
			expect(result.stdout).not.toContain("showing the first");
		});

		test("large cat reports chunk-unavailable files on stderr only", async () => {
			const { run, runAction } = await create_bash_runner({
				extraFiles: [
					{
						path: "/chunk-unavailable.md",
						content: Array.from({ length: 1000 }, (_, index) => `line ${index + 1}`).join("\n"),
						materialized: false,
					},
				],
			});
			const bigPath = `${test_db_files_mount}/chunk-unavailable.md`;

			const result = await run(`cat ${bigPath} | grep materialized`);

			expect(result.metadata.exitCode).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("content is not available from materialized chunks");
			expect(runAction.mock.calls.some(([ref]) => function_name_of(ref) === "files_nodes:read_file_line_range")).toBe(
				false,
			);
		});

		test("large cat oversize gate uses unsaved edit size, not the committed asset", async () => {
			// Simulates the agent's own large write_file/edit_file edit living in files_pending_updates:
			// the committed asset is tiny, but the current unsaved edit is large. The gate must
			// fire on the edit size, otherwise a multi-MB draft would be pulled inline unguarded.
			const runner = await create_bash_runner({
				extraFiles: [{ path: "/draft.md", content: "tiny base\n" }],
			});
			const { files_yjs_doc_create_from_markdown, files_u8_to_array_buffer } = await import("./files.ts");
			const { encodeStateAsUpdate } = await import("yjs");
			const baseYjsDoc = files_yjs_doc_create_from_markdown({ markdown: "tiny base" });
			if ("_nay" in baseYjsDoc) {
				throw new Error(baseYjsDoc._nay.message);
			}
			const draftNodeId = await get_seeded_node_id(runner, "/draft.md");
			const upserted = await runner.t.mutation(internal.files_pending_updates.upsert_file_pending_update_in_db, {
				organizationId: runner.seeded.organizationId,
				workspaceId: runner.seeded.workspaceId,
				userId: runner.seeded.userId,
				nodeId: draftNodeId,
				baseYjsSequence: 1,
				baseYjsUpdate: files_u8_to_array_buffer(encodeStateAsUpdate(baseYjsDoc)),
				unstagedMarkdown: Array.from({ length: 400 }, (_, index) => `line ${index + 1}`).join("\n\n"),
			});
			if (upserted._nay) {
				throw new Error(upserted._nay.message);
			}
			const pendingUpdate = await runner.t.query(internal.files_pending_updates.get_by_file_node, {
				organizationId: runner.seeded.organizationId,
				workspaceId: runner.seeded.workspaceId,
				userId: runner.seeded.userId,
				fileNodeId: draftNodeId,
			});
			if (pendingUpdate?.size == null) {
				throw new Error("expected pending update size to be set for /draft.md");
			}
			expect(pendingUpdate.size).toBeGreaterThan(bash_READ_INLINE_MAX_BYTES);
			const draftPath = `${test_db_files_mount}/draft.md`;
			runner.runQuery.mockClear();
			runner.runAction.mockClear();

			const result = await runner.run(`cat ${draftPath}`);

			// Gate fired on the unsaved edit size: bounded page on stdout, advisory carrying
			// that byte count on stderr — even though the committed asset is only 10 bytes.
			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toContain("line 1\n\nline 2");
			expect(result.stderr).toContain(`is ${pendingUpdate.size} bytes`);
			expect(
				runner.runQuery.mock.calls.some(
					([ref]) => function_name_of(ref) === "files_nodes:read_file_content_from_chunks",
				),
			).toBe(true);
			expect(
				runner.runAction.mock.calls.some(([ref]) => function_name_of(ref) === "files_nodes:read_file_line_range"),
			).toBe(false);
			expect(runner.runQuery.mock.calls.some(([ref]) => function_name_of(ref) === "r2:get_asset_by_id")).toBe(false);
		});

		test("sed app line-range fast path supports -- and unreadable source advisories", async () => {
			const { run } = await create_bash_runner();
			const readmePath = `${test_db_files_mount}/docs/readme.md`;

			const appResult = await run(`sed -n -- '1p' ${readmePath}`);
			const tmpResult = await run("printf 'one\\ntwo\\n' > /tmp/sed.txt && sed -n '2p' /tmp/sed.txt");
			const unreadableResult = await run(`sed -n '1p' ${test_db_files_mount}/source.pdf`);
			const zeroResult = await run(`sed -n '0p' ${readmePath}`);
			const negativeResult = await run(`sed -n '-1p' ${readmePath}`);
			const folderResult = await run(`sed -n '1p' ${test_db_files_mount}/docs`);
			const rootResult = await run(`sed -n '1p' ${test_db_files_mount}`);

			expect(appResult.metadata.exitCode).toBe(0);
			expect(appResult.stdout).toBe("# Readme\n");
			expect(tmpResult.metadata.exitCode).toBe(0);
			expect(tmpResult.stdout).toBe("two\n");
			expect(unreadableResult.metadata.exitCode).toBe(1);
			expect(unreadableResult.stderr).toContain("Markdown and plain text files only");
			expect(unreadableResult.stderr).toContain(`${test_db_files_mount}/source.pdf.md`);
			expect(unreadableResult.stderr).not.toContain("No such file or directory");
			for (const result of [zeroResult, negativeResult]) {
				expect(result.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
				expect(result.stderr).toContain("invalid line range");
			}
			for (const result of [folderResult, rootResult]) {
				expect(result.metadata.exitCode).toBe(1);
				expect(result.stderr).toContain("Is a directory");
			}
		});

		test("allows app exact reads through stream utilities but rejects direct app operands", async () => {
			const { run } = await create_bash_runner({
				extraFiles: [{ path: "/docs/dupes.md", content: "alpha\nzeta\nalpha\n" }],
			});

			const pipeline = await run(
				[
					`cat ${test_db_files_mount}/docs/dupes.md | sort | uniq -c`,
					`cat ${test_db_files_mount}/docs/nested/deep.md | cut -d ':' -f 2`,
					`cat ${test_db_files_mount}/docs/readme.md | sed 's/Readme/Guide/'`,
					`cat ${test_db_files_mount}/docs/readme.md | awk '{print $1}'`,
				].join(" && "),
			);
			const directSort = await run(`sort ${test_db_files_mount}/docs/tutorial.md`);
			const directSed = await run(`sed 's/a/b/' ${test_db_files_mount}/docs/tutorial.md`);
			const directAwk = await run(`awk '{print $1}' ${test_db_files_mount}/docs/tutorial.md`);

			expect(pipeline.metadata.exitCode).toBe(0);
			expect(pipeline.stdout).toContain("2 alpha");
			expect(pipeline.stdout).toContain("two");
			expect(pipeline.stdout).toContain("# Guide");
			expect(pipeline.stdout).toContain("#");
			expect(directSort.metadata.exitCode).not.toBe(0);
			expect(directSort.stderr).toContain("db-backed");
			expect(directSort.stderr).toContain("pipe it through cat");
			expect(directSed.metadata.exitCode).not.toBe(0);
			expect(directSed.stderr).toContain("db-backed");
			expect(directSed.stderr).toContain("pipe it through cat");
			expect(directAwk.metadata.exitCode).not.toBe(0);
			expect(directAwk.stderr).toContain("db-backed");
			expect(directAwk.stderr).toContain("pipe it through cat");
		});

		test("does not falsely reject a sed script that merely contains the mount path text", async () => {
			const { run } = await create_bash_runner();

			// The mount path appears inside the sed SCRIPT, not as a file operand; piping via cat
			// must run, not be rejected by an over-broad substring guard.
			const result = await run(`cat ${test_db_files_mount}/docs/readme.md | sed 's|${test_db_files_mount}|X|'`);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toContain("# Readme");
			expect(result.stderr).not.toContain("cannot be used as direct operands");
			expect(result.stderr).not.toContain("Native Just Bash /tmp commands cannot access app files directly");
		});

		test("rejects app writes and prevents mixed /tmp partial side effects", async () => {
			const { run } = await create_bash_runner({
				initialCwd: test_db_files_mount,
				extraFiles: [
					{ path: "/-delete.md", content: "dash delete\n" },
					{ path: "/-tee.md", content: "dash tee\n" },
				],
			});

			const touchResult = await run(`touch ${test_db_files_mount}/docs/readme.md`);
			const touchDashResult = await run("touch -- -new.md");
			const touchDateResult = await run(`touch --date=@0 ${test_db_files_mount}/docs/readme.md`);
			const touchTimestampResult = await run(`touch -t 202001010000 ${test_db_files_mount}/docs/readme.md`);
			const touchReferenceResult = await run(`touch -r ${test_db_files_mount}/docs/readme.md /tmp/from-ref`);
			const rmResult = await run(`rm -f ${test_db_files_mount}/docs/readme.md`);
			const rmFolderResult = await run(`rm -rf ${test_db_files_mount}/docs`);
			const rmDashResult = await run("rm -- -delete.md");
			const cpAppDestResult = await run("printf copy > /tmp/copy-src.txt; cp /tmp/copy-src.txt -- -copy-dest.md");
			const cpAppFolderDestResult = await run(
				`printf copy > /tmp/native-output.md; cp /tmp/native-output.md ${test_db_files_mount}/docs`,
			);
			const mvResult = await run(`mv ${test_db_files_mount}/docs/readme.md /tmp/moved.md; cat /tmp/moved.md`);
			const mvAppDestResult = await run("printf move > /tmp/move-src.txt; mv /tmp/move-src.txt -- -move-dest.md");
			const mvAppDestSource = await run("cat /tmp/move-src.txt");
			const mvAppToAppResult = await run(`mv ${test_db_files_mount}/docs/readme.md renamed.md`);
			const mvGlobResult = await run(`mv '${test_db_files_mount}/docs/*.md' /tmp/moved.md`);
			const mvDashResult = await run("mv -- -delete.md /tmp/moved-dash.md");
			const teeResult = await run(
				`printf hi | tee /tmp/out.txt ${test_db_files_mount}/docs/readme.md; cat /tmp/out.txt`,
			);
			const teeAppendResult = await run(
				`printf before > /tmp/appended.txt; printf hi | tee -a /tmp/appended.txt ${test_db_files_mount}/docs/readme.md`,
			);
			const teeAppendRead = await run("cat /tmp/appended.txt");
			const teeDashResult = await run("printf hi | tee -- -tee.md");
			const teeNoStdinResult = await run(`tee ${test_db_files_mount}/docs/readme.md`);
			const redirectResult = await run(`printf hi > ${test_db_files_mount}/docs/redirect.md`);

			expect(touchResult.metadata.exitCode).not.toBe(0);
			expect(touchResult.stderr).toContain("write_file");
			expect(touchResult.stderr).toContain("edit_file");
			for (const result of [touchDashResult, touchDateResult, touchTimestampResult]) {
				expect(result.metadata.exitCode).not.toBe(0);
				expect(result.stderr).toContain("write_file");
				expect(result.stderr).toContain("edit_file");
			}
			expect(touchReferenceResult.metadata.exitCode).not.toBe(0);
			expect(touchReferenceResult.stderr).toContain("reference file");
			expect(rmResult.metadata.exitCode).not.toBe(0);
			expect(rmResult.stderr).toContain("cannot delete app file");
			expect(rmResult.stderr).toContain("path '/docs/readme.md'");
			expect(rmFolderResult.metadata.exitCode).not.toBe(0);
			expect(rmFolderResult.stderr).toContain("cannot delete app file");
			expect(rmFolderResult.stderr).toContain("path '/docs'");
			expect(rmDashResult.metadata.exitCode).not.toBe(0);
			expect(rmDashResult.stderr).toContain("cannot delete app file");
			expect(rmDashResult.stderr).toContain("path '/-delete.md'");
			expect(cpAppDestResult.metadata.exitCode).not.toBe(0);
			expect(cpAppDestResult.stderr).toContain("cannot write to app file");
			expect(cpAppDestResult.stderr).toContain("write_file");
			expect(cpAppFolderDestResult.metadata.exitCode).not.toBe(0);
			expect(cpAppFolderDestResult.stderr).toContain("cannot write to app file");
			expect(cpAppFolderDestResult.stderr).toContain("write_file");
			expect(cpAppFolderDestResult.stderr).toContain("path '/docs/native-output.md'");
			expect(mvResult.metadata.exitCode).not.toBe(0);
			expect(mvResult.stderr).toContain("cannot move or rename app file");
			expect(mvResult.stderr).toContain("Files sidebar rename/move UI");
			expect(mvResult.stderr).toContain("cp");
			expect(mvAppDestResult.metadata.exitCode).not.toBe(0);
			expect(mvAppDestResult.stderr).toContain("cannot write to app file");
			expect(mvAppDestResult.stderr).toContain("write_file");
			expect(mvAppDestResult.stderr).toContain("Moving /tmp files into the app tree");
			expect(mvAppDestSource.metadata.exitCode).toBe(0);
			expect(mvAppDestSource.stdout).toBe("move");
			expect(mvAppToAppResult.metadata.exitCode).not.toBe(0);
			expect(mvAppToAppResult.stderr).toContain("cannot move or rename app files");
			expect(mvAppToAppResult.stderr).toContain("edit_file");
			expect(mvAppToAppResult.stderr).toContain("write_file");
			expect(mvGlobResult.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
			expect(mvGlobResult.stderr).toContain("app file glob patterns are not supported");
			expect(mvGlobResult.stderr).toContain("find");
			expect(mvDashResult.metadata.exitCode).not.toBe(0);
			expect(mvDashResult.stderr).toContain("cannot move or rename app file");
			expect(teeResult.metadata.exitCode).not.toBe(0);
			expect(teeResult.stdout).toBe("");
			expect(teeResult.stderr).toContain("write_file");
			expect(teeAppendResult.metadata.exitCode).not.toBe(0);
			expect(teeAppendResult.stdout).toBe("");
			expect(teeAppendResult.stderr).toContain("write_file");
			expect(teeAppendRead.stdout).toBe("before");
			expect(teeDashResult.metadata.exitCode).not.toBe(0);
			expect(teeDashResult.stdout).toBe("");
			expect(teeDashResult.stderr).toContain("write_file");
			expect(teeDashResult.stderr).toContain("path '/-tee.md'");
			expect(teeNoStdinResult.metadata.exitCode).not.toBe(0);
			expect(teeNoStdinResult.stdout).toBe("");
			expect(teeNoStdinResult.stderr).toContain("write_file");
			expect(redirectResult.metadata.exitCode).not.toBe(0);
			expect(redirectResult.stderr).toContain("write_file/edit_file");
			expect(redirectResult.stderr).toContain("shell redirects into app files are unsupported");
		});

		test("copies one exact readable app file to scratch and rejects unreadable app copies", async () => {
			const { run } = await create_bash_runner({
				initialCwd: test_db_files_mount,
				extraFiles: [{ path: "/-dash-copy.md", content: "dash cp\n" }],
			});

			const copied = await run(`cp ${test_db_files_mount}/docs/readme.md /tmp/readme.md && cat /tmp/readme.md`);
			const dashCopied = await run("cp -- -dash-copy.md /tmp/dash-copy.md && cat /tmp/dash-copy.md");
			const dirDestination = await run(`cp ${test_db_files_mount}/docs/readme.md /tmp && cat /tmp/readme.md`);
			const outsideTmp = await run(`cp ${test_db_files_mount}/docs/readme.md /dev/null`);
			const unreadable = await run(`cp ${test_db_files_mount}/source.pdf /tmp/source.pdf`);

			expect(copied.metadata.exitCode).toBe(0);
			expect(copied.stdout).toContain("unique-token");
			expect(dashCopied.metadata.exitCode).toBe(0);
			expect(dashCopied.stdout).toContain("dash cp");
			expect(dirDestination.metadata.exitCode).toBe(0);
			expect(dirDestination.stdout).toContain("unique-token");
			expect(outsideTmp.metadata.exitCode).not.toBe(0);
			expect(outsideTmp.stderr).toContain("only supports /tmp destinations");
			expect(outsideTmp.stderr).not.toContain("read-only for cp");
			expect(unreadable.metadata.exitCode).not.toBe(0);
			expect(unreadable.stderr).toContain("Markdown and plain text files only");
			expect(unreadable.stderr).toContain(`${test_db_files_mount}/source.pdf.md`);
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
			expect(result.stderr).not.toContain("db-backed");
			expect(result.stderr).not.toContain("app-aware commands");
		});

		test("delegates /tmp grep file operands to Native Just Bash", async () => {
			const { run } = await create_bash_runner();

			const result = await run(
				"printf 'example: command not found\\n' > /tmp/literal.txt && grep -n 'command not found' /tmp/literal.txt",
			);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toBe("1:example: command not found\n");
			expect(result.stderr).not.toContain("grep over multiple/app-wide files is not supported");
			expect(result.stderr).not.toContain("db-backed");
		});

		test("treats /dev/null and /dev/zero as Native Just Bash devices outside the app mount", async () => {
			const { run } = await create_bash_runner();

			const nullResult = await run(
				"printf hi > /dev/null && printf 'alpha\\n' > /tmp/a.txt && tee /dev/null /tmp/b.txt < /tmp/a.txt >/dev/null && cat /tmp/b.txt",
			);
			const zeroResult = await run("head -c 5 /dev/zero | wc -c");

			expect(nullResult.metadata.exitCode).toBe(0);
			expect(nullResult.stdout).toBe("alpha\n");
			expect(nullResult.stderr).not.toContain("read-only file system");
			expect(nullResult.stderr).not.toContain("db-backed");
			expect(zeroResult.metadata.exitCode).toBe(0);
			expect(zeroResult.stdout).toBe("5\n");
			expect(zeroResult.stderr).not.toContain("No such file");
			expect(zeroResult.stderr).not.toContain("db-backed");
		});

		test("does not append app-mount guidance for /tmp Native Just Bash command failures", async () => {
			const { run } = await create_bash_runner();

			const result = await run("printf alpha > /tmp/a.txt && rg missing /tmp/a.txt");

			expect(result.metadata.exitCode).not.toBe(0);
			expect(result.stderr).not.toContain("db-backed");
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

		test("ignores shell comment lines when hinting unavailable file commands", async () => {
			const { run } = await create_bash_runner();

			const result = await run("# Try file (intentionally unavailable)\nprintf hi > /tmp/a.txt\nfile /tmp/a.txt");

			expect(result.metadata.exitCode).not.toBe(0);
			expect(result.stderr).toContain("file: command not found");
			expect(result.stderr).toContain(
				"the Unix file command is intentionally unavailable. Try: stat /tmp/a.txt && wc -c /tmp/a.txt && head -n 5 /tmp/a.txt",
			);
			expect(result.stderr).not.toContain("stat '(intentionally'");
		});

		test("prevents scratch symlinks from escaping into the app mount", async () => {
			const { run } = await create_bash_runner();

			const result = await run(`ln -s ${test_db_files_mount}/docs/readme.md /tmp/readme-link && cat /tmp/readme-link`);

			expect(result.metadata.exitCode).not.toBe(0);
			expect(result.stdout).not.toContain("unique-token");
			expect(result.stderr).toContain("db-backed");
			expect(result.stderr).toContain("Native Just Bash /tmp commands cannot access app files directly");
			// Pre-checked before the inner shell, so the sanitizer never redacts the paths.
			expect(result.stderr).toContain(`${test_db_files_mount}/docs/readme.md`);
			expect(result.stderr).not.toContain("<path>");
		});

		test("rejects expanded Native Just Bash /tmp commands when direct app operands are involved", async () => {
			const { run } = await create_bash_runner();

			const duResult = await run(`du ${test_db_files_mount}/docs`);
			const rgResult = await run(`rg unique-token ${test_db_files_mount}/docs/readme.md`);
			const diffResult = await run(
				`printf '# Readme\\n' > /tmp/readme.md && diff ${test_db_files_mount}/docs/readme.md /tmp/readme.md`,
			);
			const duWithFlagsResult = await run(`du -sh ${test_db_files_mount}/docs`);
			const defaultCwdResult = await run(`cd ${test_db_files_mount}/docs && du`);

			for (const result of [duResult, rgResult, diffResult, duWithFlagsResult, defaultCwdResult]) {
				expect(result.metadata.exitCode).not.toBe(0);
				expect(result.stderr).toContain("db-backed");
				expect(result.stderr).toContain("app-aware commands");
			}
			expect(duResult.stderr).toContain(test_db_files_mount);
			expect(duResult.stderr).not.toContain("No such file or directory");
			expect(duResult.stderr).toContain(
				`du: app-mount paths do not expose POSIX disk usage. Try: stat ${test_db_files_mount}/docs && find ${test_db_files_mount}/docs -type f --limit 20`,
			);
			expect(rgResult.stderr).toContain(
				`rg: app paths do not support direct Native Just Bash rg. Try: grep unique-token ${test_db_files_mount}/docs/readme.md`,
			);
			expect(duWithFlagsResult.stderr).not.toContain("No such file or directory");
			expect(diffResult.stderr).not.toContain("No such file or directory");
			expect(defaultCwdResult.stderr).toContain("Native Just Bash /tmp commands cannot access app files directly");
		});

		test("allows app reads to stream into expanded Native Just Bash text utilities", async () => {
			const { run } = await create_bash_runner();

			const result = await run(
				[
					`cat ${test_db_files_mount}/docs/readme.md | rev | head -n 1`,
					`cat ${test_db_files_mount}/docs/readme.md | sha256sum`,
				].join(" && "),
			);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toContain("emdaeR #");
			expect(result.stdout).toContain("-");
			expect(result.stderr).not.toContain("db-backed");
		});

		test("keeps nested shells, xargs, and which inside the curated command surface", async () => {
			const { run } = await create_bash_runner();

			const nested = await run(`bash -c 'ls --limit 1 ${test_db_files_mount}/docs'`);
			const nestedLoginForm = await run(`bash -lc 'ls --limit 1 ${test_db_files_mount}/docs'`);
			const nestedMixed = await run(
				`bash -c 'printf nested-ok > /tmp/nested-ok.txt && cat /tmp/nested-ok.txt'; bash -c 'printf blocked > ${test_db_files_mount}/nested-blocked.md'`,
			);
			const xargsResult = await run(`printf '${test_db_files_mount}/docs/readme.md\\n' | xargs cat`);
			const xargsParallel = await run("printf hi | xargs -P 2 echo");
			const xargsHelp = await run("xargs --help");
			const xargsCombined = await run("printf 'a b' | xargs -rt echo");
			const xargsNullCombined = await run("printf 'a\\0b\\0' | xargs -0t echo");
			const whichResult = await run("which ls find cat du rg sha256sum search meta textgrep && which --silent bash");
			const whichAll = await run("which --all search");
			const whichCombined = await run("which -as search");
			const whichHelp = await run("which --help");
			const whichMissing = await run("which");
			const whichEndOptions = await run("which -- --not-a-command");

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
			expect(xargsHelp.metadata.exitCode).toBe(0);
			expect(xargsHelp.stdout).toContain("[-P 0|1]");
			expect(xargsHelp.stdout).not.toContain("-a FILE");
			expect(xargsCombined.metadata.exitCode).toBe(0);
			expect(xargsCombined.stdout).toBe("a b\n");
			expect(xargsCombined.stderr).toBe("echo a b\n");
			expect(xargsNullCombined.metadata.exitCode).toBe(0);
			expect(xargsNullCombined.stdout).toBe("a b\n");
			expect(xargsNullCombined.stderr).toBe("echo a b\n");
			expect(whichResult.metadata.exitCode).toBe(0);
			expect(whichResult.stdout).toContain("/usr/bin/ls");
			expect(whichResult.stdout).toContain("/usr/bin/find");
			expect(whichResult.stdout).toContain("/usr/bin/cat");
			expect(whichResult.stdout).toContain("/usr/bin/du");
			expect(whichResult.stdout).toContain("/usr/bin/rg");
			expect(whichResult.stdout).toContain("/usr/bin/sha256sum");
			expect(whichResult.stdout).toContain("/usr/bin/search");
			expect(whichResult.stdout).toContain("/usr/bin/meta");
			expect(whichResult.stdout).toContain("/usr/bin/textgrep");
			expect(whichAll.metadata.exitCode).toBe(0);
			expect(whichAll.stdout).toBe("/usr/bin/search\n/bin/search\n");
			expect(whichCombined.metadata.exitCode).toBe(0);
			expect(whichCombined.stdout).toBe("");
			expect(whichHelp.metadata.exitCode).toBe(0);
			expect(whichHelp.stdout).toContain("Usage: which [-a] [-s] NAME...");
			expect(whichMissing.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
			expect(whichMissing.stderr).toContain("which: missing command name");
			expect(whichMissing.stderr).toContain("Usage: which [-a] [-s] NAME...");
			expect(whichEndOptions.metadata.exitCode).toBe(1);
			expect(whichEndOptions.stderr).toContain("which: no --not-a-command in (/usr/bin:/bin)");
		});

		test("keeps synthetic Native Just Bash lookup paths native-only", async () => {
			const { run } = await create_bash_runner();

			const result = await run("du -a /usr/bin");

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stdout).toContain("/usr/bin/grep");
			expect(result.stdout).not.toContain("/usr/bin/file");
			expect(result.stdout).not.toContain("/usr/bin/search");
			expect(result.stdout).not.toContain("/usr/bin/textgrep");
		});

		test("forwards nested shell stdin and handles script files cleanly", async () => {
			const { run } = await create_bash_runner();

			const nestedStdin = await run("printf nested-stdin | bash -c 'cat'");
			const nestedShStdin = await run("printf nested-sh-stdin | sh -c 'cat'");
			const nestedInlineArgs = await run("bash -c 'echo inline:$0:$1:$#' script forwarded");
			const writeScript = await run("printf 'echo script:$1\\n' > /tmp/nested-script.sh");
			const scriptPath = await run("bash /tmp/nested-script.sh forwarded");
			const nestedTmpGlob = await run(
				"printf 'nested-a\\n' > /tmp/nested-a.txt && printf 'nested-b\\n' > /tmp/nested-b.txt && bash -c 'cat /tmp/nested-*.txt'",
			);
			const sourceTmpScript = await run(
				"printf 'echo sourced:$BONOBO\\n' > /tmp/source-script.sh && BONOBO=ok source /tmp/source-script.sh",
			);
			const cdTmpBeforeDot = await run("cd /tmp");
			const dotTmpScriptFromCwd = await run(". source-script.sh");
			const missingScript = await run("bash /tmp/missing-script.sh");
			const directoryScript = await run("sh /tmp");
			const appScript = await run(`bash ${test_db_files_mount}/docs/readme.md`);
			const appSourceScript = await run(`source ${test_db_files_mount}/docs/readme.md`);
			const appDotScript = await run(`. ${test_db_files_mount}/docs/readme.md`);
			const appEnvSourceScript = await run(`BONOBO=1 source ${test_db_files_mount}/docs/readme.md`);
			const appRedirectSourceScript = await run(`2>/tmp/source.err source ${test_db_files_mount}/docs/readme.md`);
			const appCommandSourceScript = await run(`command source ${test_db_files_mount}/docs/readme.md`);
			const appEvalSourceScript = await run(`eval 'source ${test_db_files_mount}/docs/readme.md'`);
			const appEvalEnvSourceScript = await run(`eval 'BONOBO=1 source ${test_db_files_mount}/docs/readme.md'`);
			const nestedAppSourceScript = await run(`bash -c 'source ${test_db_files_mount}/docs/readme.md'`);
			const nestedAppRedirectSourceScript = await run(
				`bash -c '2>/tmp/source.err source ${test_db_files_mount}/docs/readme.md'`,
			);
			const nestedEchoSource = await run("bash -c 'echo source'");
			const missingInlineScript = await run("bash -c");
			const unsupportedFlag = await run("sh -e");

			expect(nestedStdin.metadata.exitCode).toBe(0);
			expect(nestedStdin.stdout).toBe("nested-stdin");
			expect(nestedShStdin.metadata.exitCode).toBe(0);
			expect(nestedShStdin.stdout).toBe("nested-sh-stdin");
			expect(nestedInlineArgs.metadata.exitCode).toBe(0);
			expect(nestedInlineArgs.stdout).toBe("inline:script:forwarded:1\n");
			expect(writeScript.metadata.exitCode).toBe(0);
			expect(scriptPath.metadata.exitCode).toBe(0);
			expect(scriptPath.stdout).toBe("script:forwarded\n");
			expect(nestedTmpGlob.metadata.exitCode).toBe(0);
			expect(nestedTmpGlob.stdout).toContain("nested-a\n");
			expect(nestedTmpGlob.stdout).toContain("nested-b\n");
			expect(sourceTmpScript.metadata.exitCode).toBe(0);
			expect(sourceTmpScript.stdout).toBe("sourced:ok\n");
			expect(cdTmpBeforeDot.metadata.exitCode).toBe(0);
			expect(dotTmpScriptFromCwd.metadata.exitCode).toBe(0);
			expect(dotTmpScriptFromCwd.stdout).toBe("sourced:\n");
			expect(missingScript.metadata.exitCode).toBe(bash_COMMAND_EXIT_NOT_FOUND);
			expect(missingScript.stderr).toBe("bash: /tmp/missing-script.sh: No such file or directory\n");
			expect(missingScript.stderr).not.toContain("ENOENT");
			expect(directoryScript.metadata.exitCode).toBe(bash_COMMAND_EXIT_CANNOT_EXECUTE);
			expect(directoryScript.stderr).toBe("sh: /tmp: Is a directory\n");
			expect(directoryScript.stderr).not.toContain("EISDIR");
			expect(appScript.metadata.exitCode).toBe(bash_COMMAND_EXIT_CANNOT_EXECUTE);
			expect(appScript.stderr).toContain("app-mounted script files are not executable");
			expect(appScript.stderr).toContain(`${test_db_files_mount}/docs/readme.md`);
			expect(appSourceScript.metadata.exitCode).toBe(bash_COMMAND_EXIT_CANNOT_EXECUTE);
			expect(appSourceScript.stderr).toContain("cannot load app files or agent-only external mounts");
			expect(appDotScript.metadata.exitCode).toBe(bash_COMMAND_EXIT_CANNOT_EXECUTE);
			expect(appDotScript.stderr).toContain("cannot load app files or agent-only external mounts");
			expect(appEnvSourceScript.metadata.exitCode).toBe(bash_COMMAND_EXIT_CANNOT_EXECUTE);
			expect(appEnvSourceScript.stderr).toContain("cannot load app files or agent-only external mounts");
			expect(appRedirectSourceScript.metadata.exitCode).toBe(bash_COMMAND_EXIT_CANNOT_EXECUTE);
			expect(appRedirectSourceScript.stderr).toContain("cannot load app files or agent-only external mounts");
			expect(appCommandSourceScript.metadata.exitCode).toBe(bash_COMMAND_EXIT_CANNOT_EXECUTE);
			expect(appCommandSourceScript.stderr).toContain("cannot load app files or agent-only external mounts");
			expect(appEvalSourceScript.metadata.exitCode).toBe(bash_COMMAND_EXIT_CANNOT_EXECUTE);
			expect(appEvalSourceScript.stderr).toContain("cannot load app files or agent-only external mounts");
			expect(appEvalEnvSourceScript.metadata.exitCode).toBe(bash_COMMAND_EXIT_CANNOT_EXECUTE);
			expect(appEvalEnvSourceScript.stderr).toContain("cannot load app files or agent-only external mounts");
			expect(nestedAppSourceScript.metadata.exitCode).toBe(bash_COMMAND_EXIT_CANNOT_EXECUTE);
			expect(nestedAppSourceScript.stderr).toContain("cannot load app files or agent-only external mounts");
			expect(nestedAppRedirectSourceScript.metadata.exitCode).toBe(bash_COMMAND_EXIT_CANNOT_EXECUTE);
			expect(nestedAppRedirectSourceScript.stderr).toContain("cannot load app files or agent-only external mounts");
			expect(nestedEchoSource.metadata.exitCode).toBe(0);
			expect(nestedEchoSource.stdout).toBe("source\n");
			expect(missingInlineScript.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
			expect(missingInlineScript.stderr).toContain("option requires an argument");
			expect(unsupportedFlag.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
			expect(unsupportedFlag.stderr).toContain("sh -c 'script'");
			expect(unsupportedFlag.stderr).toContain("sh /tmp/script.sh");
		});

		test("rejects xargs -n with a non-positive or non-numeric value instead of silently batching all items", async () => {
			const { run } = await create_bash_runner();

			const zero = await run("printf 'a\\nb\\nc\\n' | xargs -n 0 echo");
			const nonNumeric = await run("printf 'a\\nb\\nc\\n' | xargs -n x echo");
			const attachedNonNumeric = await run("printf 'a\\nb\\nc\\n' | xargs -nx echo");
			const valid = await run("printf 'a\\nb\\nc\\n' | xargs -n 1 echo");

			expect(zero.metadata.exitCode).toBe(2);
			expect(zero.stderr).toContain("xargs: -n requires a positive integer");
			expect(zero.stderr).toContain("Supported: xargs");
			expect(nonNumeric.metadata.exitCode).toBe(2);
			expect(nonNumeric.stderr).toContain("xargs: -n requires a positive integer");
			expect(nonNumeric.stderr).toContain("Supported: xargs");
			expect(attachedNonNumeric.metadata.exitCode).toBe(2);
			expect(attachedNonNumeric.stderr).toContain("xargs: -n requires a positive integer");
			expect(attachedNonNumeric.stderr).toContain("Supported: xargs");
			expect(valid.metadata.exitCode).toBe(0);
		});

		test("validates xargs replacement delimiter and parallel option values", async () => {
			const { run } = await create_bash_runner();

			const missingReplace = await run("printf a | xargs -I");
			const emptyReplace = await run("printf a | xargs -I '' echo");
			const missingDelimiter = await run("printf a | xargs -d");
			const emptyDelimiter = await run("printf a | xargs -d '' echo");
			const missingParallel = await run("printf a | xargs -P");
			const invalidParallel = await run("printf a | xargs -P nope echo");
			const zeroParallel = await run("printf hi | xargs -P0 echo");
			const oneParallel = await run("printf hi | xargs -P 1 echo");
			const hugeParallel = await run(`printf a | xargs -P ${"9".repeat(400)} echo`);

			expect(missingReplace.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
			expect(missingReplace.stderr).toContain("xargs: -I requires a value");
			expect(emptyReplace.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
			expect(emptyReplace.stderr).toContain("xargs: -I requires a value");
			expect(missingDelimiter.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
			expect(missingDelimiter.stderr).toContain("xargs: -d requires a value");
			expect(emptyDelimiter.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
			expect(emptyDelimiter.stderr).toContain("xargs: -d requires a value");
			expect(missingParallel.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
			expect(missingParallel.stderr).toContain("xargs: -P requires a non-negative integer");
			expect(invalidParallel.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
			expect(invalidParallel.stderr).toContain("xargs: -P requires a non-negative integer");
			expect(zeroParallel.metadata.exitCode).toBe(0);
			expect(zeroParallel.stdout).toBe("hi\n");
			expect(oneParallel.metadata.exitCode).toBe(0);
			expect(oneParallel.stdout).toBe("hi\n");
			expect(hugeParallel.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
			expect(hugeParallel.stderr).toContain("parallel execution");
		});

		test("supports GNU-style xargs long aliases", async () => {
			const { run } = await create_bash_runner();

			const maxArgsSeparate = await run("printf 'a b c' | xargs --max-args 2 echo");
			const maxArgsEquals = await run("printf 'a b c' | xargs --max-args=2 echo");
			const replaceBare = await run("printf 'a\\n' | xargs --replace echo '<{}>'");
			const replaceEquals = await run("printf 'zeta\\n' | xargs --replace={} printf '({})\\n'");
			const delimiterSeparate = await run("printf 'a,b,c' | xargs --delimiter , echo");
			const delimiterEquals = await run("printf 'a:b:c' | xargs --delimiter=: echo");
			const missingMaxArgs = await run("printf a | xargs --max-args");
			const emptyReplace = await run("printf a | xargs --replace= echo");
			const emptyDelimiter = await run("printf a | xargs --delimiter= echo");

			expect(maxArgsSeparate.metadata.exitCode).toBe(0);
			expect(maxArgsSeparate.stdout).toBe("a b\nc\n");
			expect(maxArgsEquals.metadata.exitCode).toBe(0);
			expect(maxArgsEquals.stdout).toBe("a b\nc\n");
			expect(replaceBare.metadata.exitCode).toBe(0);
			expect(replaceBare.stdout).toBe("<a>\n");
			expect(replaceEquals.metadata.exitCode).toBe(0);
			expect(replaceEquals.stdout).toBe("(zeta)\n");
			expect(delimiterSeparate.metadata.exitCode).toBe(0);
			expect(delimiterSeparate.stdout).toBe("a b c\n");
			expect(delimiterEquals.metadata.exitCode).toBe(0);
			expect(delimiterEquals.stdout).toBe("a b c\n");
			expect(missingMaxArgs.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
			expect(missingMaxArgs.stderr).toContain("xargs: -n requires a positive integer");
			expect(emptyReplace.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
			expect(emptyReplace.stderr).toContain("xargs: -I requires a value");
			expect(emptyDelimiter.metadata.exitCode).toBe(bash_COMMAND_EXIT_USAGE);
			expect(emptyDelimiter.stderr).toContain("xargs: -d requires a value");
		});

		test("keeps xargs replacement input newline-delimited and UTF-8 decoded", async () => {
			const { run } = await create_bash_runner();

			const replacement = await run("printf 'alpha beta\\ncafé file\\n' | xargs -I{} printf '<{}>\\n'");
			const doubleDash = await run("printf ok | xargs -- echo");
			const emptyInput = await run("printf '' | xargs echo should-not-run");

			expect(replacement.metadata.exitCode).toBe(0);
			expect(replacement.stdout).toBe("<alpha beta>\n<café file>\n");
			expect(doubleDash.metadata.exitCode).toBe(0);
			expect(doubleDash.stdout).toBe("ok\n");
			expect(emptyInput.metadata.exitCode).toBe(0);
			expect(emptyInput.stdout).toBe("");
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

		describe("github mounts (Phase F7)", () => {
			// README content is markdown-hostile on purpose and small enough to read inline from the
			// committed plain-text chunks (no R2 round-trip), matching how the sync materializes external mount content.
			const README_TEXT = "# experiment--t3-chat\n\nMounted repo readme.\nZorptelemetry marker line.\n";
			const GUIDE_TEXT = "guide alpha\nguide beta\n";

			// Seed reserved-scope (`GLOBAL`/`GITHUB`) plain-text nodes via the real Phase D path. The Bash
			// mount root lists top-level folders from files_nodes, so no github_sources metadata is needed.
			async function seed_github_mount(
				runner: Awaited<ReturnType<typeof create_bash_runner>>,
				name: string,
				files: { path: string; rawText: string }[],
			) {
				for (const file of files) {
					const created = (await runner.t.action(internal.files_nodes.create_file_node_internal, {
						workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
						path: `/${name}${file.path}`,
						rawText: file.rawText,
					})) as { _yay?: unknown; _nay?: { message: string } };
					if (!created._yay) {
						throw new Error(`Failed to seed mount file /${name}${file.path}: ${created._nay?.message}`);
					}
				}
			}

			test("lists reserved top-level mount folders at the synthetic /.mounts root", async () => {
				const runner = await create_bash_runner();
				await seed_github_mount(runner, "t3-chat", [{ path: "/README.md", rawText: README_TEXT }]);
				await seed_github_mount(runner, "examples", [{ path: "/hello.md", rawText: "hello\n" }]);

				const result = await runner.run("ls /.mounts");

				expect(result.metadata.exitCode).toBe(0);
				expect(result.stdout).toContain("t3-chat");
				expect(result.stdout).toContain("examples");
			});

			test("lists and reads files inside a mount byte-identically", async () => {
				const runner = await create_bash_runner();
				await seed_github_mount(runner, "t3-chat", [
					{ path: "/README.md", rawText: README_TEXT },
					{ path: "/docs/guide.md", rawText: GUIDE_TEXT },
				]);

				const listing = await runner.run("ls /.mounts/t3-chat");
				expect(listing.metadata.exitCode).toBe(0);
				expect(listing.stdout).toContain("README.md");
				expect(listing.stdout).toContain("docs");

				runner.runQuery.mockClear();
				const readme = await runner.run("cat /.mounts/t3-chat/README.md");
				expect(readme.metadata.exitCode).toBe(0);
				expect(readme.stdout).toBe(README_TEXT);

				const guide = await runner.run("cat /.mounts/t3-chat/docs/guide.md");
				expect(guide.metadata.exitCode).toBe(0);
				expect(guide.stdout).toBe(GUIDE_TEXT);
				expect(
					runner.runQuery.mock.calls.some(
						([ref]) => function_name_of(ref) === "files_pending_updates:get_by_file_node",
					),
				).toBe(false);
			});

			test("rejects mount glob patterns without shell-expanding reserved db files", async () => {
				const runner = await create_bash_runner();
				await seed_github_mount(runner, "t3-chat", [{ path: "/README.md", rawText: README_TEXT }]);

				const result = await runner.run("ls /.mounts/t3-chat/*.md");

				expect(result.metadata.exitCode).toBe(2);
				expect(result.stdout).toBe("");
				expect(result.stderr).toContain("app file glob patterns are not supported");
				expect(result.stderr).toContain("Try: find /.mounts/t3-chat -type f --extension md --limit 20");
			});

			test("reports mount folders as directories for readers", async () => {
				const runner = await create_bash_runner();
				await seed_github_mount(runner, "t3-chat", [{ path: "/docs/guide.md", rawText: GUIDE_TEXT }]);

				for (const command of [
					"cat /.mounts/t3-chat/docs",
					"head /.mounts/t3-chat/docs",
					"sed -n '1p' /.mounts/t3-chat/docs",
					"wc /.mounts/t3-chat/docs",
				]) {
					const result = await runner.run(command);
					expect(result.metadata.exitCode).not.toBe(0);
					expect(result.stdout).toBe("");
					expect(result.stderr).toContain("Is a directory");
				}
			});

			test("cd into a mount persists across invocations", async () => {
				const runner = await create_bash_runner();
				await seed_github_mount(runner, "t3-chat", [{ path: "/docs/guide.md", rawText: GUIDE_TEXT }]);

				const moved = await runner.run("cd /.mounts/t3-chat/docs");
				expect(moved.metadata.exitCode).toBe(0);

				const here = await runner.run("pwd");
				expect(here.metadata.exitCode).toBe(0);
				expect(here.stdout).toBe("/.mounts/t3-chat/docs\n");
			});

			test("grep and search find content scoped to a mount", async () => {
				const runner = await create_bash_runner();
				await seed_github_mount(runner, "t3-chat", [{ path: "/README.md", rawText: README_TEXT }]);

				const grepped = await runner.run("grep Zorptelemetry /.mounts/t3-chat/README.md");
				expect(grepped.metadata.exitCode).toBe(0);
				expect(grepped.stdout).toContain("Zorptelemetry marker line.");

				const searched = await runner.run("search --path /.mounts/t3-chat Zorptelemetry");
				expect(searched.metadata.exitCode).toBe(0);
				expect(searched.stdout).toContain("README.md");
			});

			test("find --prefix resolves relative to mount cwd and returns zero matches for absent prefixes", async () => {
				const runner = await create_bash_runner();
				await seed_github_mount(runner, "t3-chat", [
					{ path: "/docs/guide.md", rawText: GUIDE_TEXT },
					{ path: "/docs/notes.md", rawText: "notes\n" },
					{ path: "/docs-archive/leak.md", rawText: "leak\n" },
				]);

				const fromMount = await runner.run("cd /.mounts/t3-chat && find --prefix docs --limit 20 -type f");
				expect(fromMount.metadata.exitCode).toBe(0);
				expect(fromMount.stdout).toContain("/.mounts/t3-chat/docs/guide.md");
				expect(fromMount.stdout).toContain("/.mounts/t3-chat/docs/notes.md");
				expect(fromMount.stdout).not.toContain("/.mounts/t3-chat/docs-archive/leak.md");

				const fromDocs = await runner.run("cd /.mounts/t3-chat/docs && find --prefix . --limit 1");
				expect(fromDocs.metadata.exitCode).toBe(0);
				expect(fromDocs.stdout).toContain("/.mounts/t3-chat/docs/");

				const paged = await runner.run("cd /.mounts/t3-chat && find --prefix docs --limit 1");
				expect(paged.metadata.exitCode).toBe(0);
				expect(paged.stdout).toMatch(/Next page: find --prefix \/.mounts\/t3-chat\/docs --limit 1 --cursor \S+/u);

				const missing = await runner.run("find --prefix /.mounts/nope --limit 20");
				expect(missing.metadata.exitCode).toBe(0);
				expect(missing.stdout).toContain("0 matches.");
			});

			test("keeps mount content isolated from the tenant app file tree", async () => {
				const runner = await create_bash_runner();
				await seed_github_mount(runner, "t3-chat", [{ path: "/README.md", rawText: README_TEXT }]);

				// The default app file tree has no Zorptelemetry marker, so an app-scope search misses it:
				// the reserved mount scope is reachable only through the /.mounts prefix.
				const workspaceSearch = await runner.run("search Zorptelemetry");
				expect(workspaceSearch.metadata.exitCode).toBe(0);
				expect(workspaceSearch.stdout).not.toContain("README.md");

				// The runner starts in the app file tree root; listing it shows app folders, never mounts.
				const workspaceRoot = await runner.run("ls");
				expect(workspaceRoot.metadata.exitCode).toBe(0);
				expect(workspaceRoot.stdout).toContain("docs");
				expect(workspaceRoot.stdout).not.toContain("t3-chat");

				// The stored reserved path (without the /.mounts prefix) is not addressable from the shell.
				const bare = await runner.run("cat /t3-chat/README.md");
				expect(bare.metadata.exitCode).not.toBe(0);
			});

			test("rejects every write into a read-only mount and leaves it intact", async () => {
				const runner = await create_bash_runner();
				await seed_github_mount(runner, "t3-chat", [{ path: "/README.md", rawText: README_TEXT }]);

				const writes = [
					"touch /.mounts/t3-chat/new.txt",
					"rm /.mounts/t3-chat/README.md",
					"mv /.mounts/t3-chat/README.md /.mounts/t3-chat/renamed.md",
					"echo hi | tee /.mounts/t3-chat/new.txt",
					"cp /.mounts/t3-chat/README.md /.mounts/t3-chat/copy.md",
				];
				for (const command of writes) {
					const result = await runner.run(command);
					expect(result.metadata.exitCode).not.toBe(0);
					expect(result.stderr).toContain("is a read-only mount of an external source");
				}

				// The mount file is still present and unchanged after all rejected writes.
				const readme = await runner.run("cat /.mounts/t3-chat/README.md");
				expect(readme.metadata.exitCode).toBe(0);
				expect(readme.stdout).toBe(README_TEXT);
			});

			test("allows copying a mount file out to /tmp scratch", async () => {
				const runner = await create_bash_runner();
				await seed_github_mount(runner, "t3-chat", [{ path: "/README.md", rawText: README_TEXT }]);

				const copied = await runner.run("cp /.mounts/t3-chat/README.md /tmp/readme.md && cat /tmp/readme.md");
				expect(copied.metadata.exitCode).toBe(0);
				expect(copied.stdout).toBe(README_TEXT);
			});

			test("refuses to execute a mount file through bash", async () => {
				const runner = await create_bash_runner();
				await seed_github_mount(runner, "t3-chat", [{ path: "/script.sh", rawText: "echo pwned\n" }]);

				for (const command of ["bash /.mounts/t3-chat/script.sh"]) {
					const result = await runner.run(command);
					expect(result.metadata.exitCode).not.toBe(0);
					expect(result.stdout).not.toContain("pwned");
					expect(result.stderr).toContain("not executable through bash");
				}

				for (const command of [
					"source /.mounts/t3-chat/script.sh",
					". /.mounts/t3-chat/script.sh",
					"BONOBO=1 source /.mounts/t3-chat/script.sh",
					"2>/tmp/source.err source /.mounts/t3-chat/script.sh",
					"command source /.mounts/t3-chat/script.sh",
					"eval 'source /.mounts/t3-chat/script.sh'",
					"eval 'BONOBO=1 source /.mounts/t3-chat/script.sh'",
					"bash -c 'source /.mounts/t3-chat/script.sh'",
					"bash -c '2>/tmp/source.err source /.mounts/t3-chat/script.sh'",
					"sh -c '. /.mounts/t3-chat/script.sh'",
				]) {
					const result = await runner.run(command);
					expect(result.metadata.exitCode).not.toBe(0);
					expect(result.stdout).not.toContain("pwned");
					expect(result.stderr).toContain("cannot load app files or agent-only external mounts");
				}
			});

			test("reports missing mount targets as no such file", async () => {
				const runner = await create_bash_runner();
				await seed_github_mount(runner, "t3-chat", [{ path: "/README.md", rawText: README_TEXT }]);

				const listMissing = await runner.run("ls /.mounts/nope");
				expect(listMissing.metadata.exitCode).not.toBe(0);
				expect(listMissing.stderr).toContain("No such file");

				const catMissing = await runner.run("cat /.mounts/nope/x.md");
				expect(catMissing.metadata.exitCode).not.toBe(0);
				expect(catMissing.stderr).toContain("No such file");
			});
		});

		describe("plugin source mounts", () => {
			const WORKER_TEXT = "export const plugin = 'media';\nGlomtelemetry marker line.\n";
			const PLUGIN_README_TEXT = "# media plugin\n\nPlugin source readme.\n";

			// Seed a registered plugin version with a version-keyed source tree in the reserved
			// GLOBAL/PLUGINS scope, plus an enabled installation in the runner's workspace — the
			// same rows the publish + install flows produce, without the full publish pipeline.
			async function seed_plugin_mount(
				runner: Awaited<ReturnType<typeof create_bash_runner>>,
				pluginName: string,
				files: { path: string; rawText: string }[],
				opts?: { installed?: boolean },
			) {
				const now = Date.now();
				const pluginVersionId = await runner.t.run((ctx) =>
					ctx.db.insert("plugins_versions", {
						name: pluginName,
						displayName: pluginName,
						version: "0.1.0",
						description: `${pluginName} plugin`,
						reviewStatus: "passed",
						isLatest: true,
						runtimeVersion: "1",
						artifactHash: `sha256:${"a".repeat(64)}`,
						sourceRepositoryUrl: `https://github.com/bonobo/${pluginName}-plugin`,
						sourceOwner: "bonobo",
						sourceRepo: `${pluginName}-plugin`,
						sourceDefaultBranch: "main",
						sourceCommitSha: "1234567890abcdef1234567890abcdef12345678",
						manifestR2Key: `plugins/${pluginName}/manifest.json`,
						backend: {
							entry: "dist/backend/worker.js",
							moduleName: "plugin.js",
							r2Key: `plugins/${pluginName}/backend/worker.js`,
							compatibilityDate: "2026-07-01",
							compatibilityFlags: ["nodejs_compat"],
						},
						events: [{ type: "files.upload.completed", contentTypes: ["image/png"] }],
						pages: [],
						capabilities: [],
						outboundOrigins: [],
						files: [],
						sourceStatus: "ready",
						sourceFileCount: files.length,
						sourceTotalBytes: files.reduce((total, file) => total + file.rawText.length, 0),
						sourceLastError: null,
						createdBy: runner.seeded.userId,
						updatedAt: now,
					}),
				);
				for (const file of files) {
					const created = (await runner.t.action(internal.files_nodes.create_file_node_internal, {
						workspaceId: organizations_GLOBAL_PLUGINS_WORKSPACE_ID,
						path: `/${pluginVersionId}${file.path}`,
						rawText: file.rawText,
					})) as { _yay?: unknown; _nay?: { message: string } };
					if (!created._yay) {
						throw new Error(`Failed to seed plugin source file ${file.path}: ${created._nay?.message}`);
					}
				}
				let installationId: Id<"plugins_workspace_installations"> | null = null;
				if (opts?.installed !== false) {
					installationId = await runner.t.run((ctx) =>
						ctx.db.insert("plugins_workspace_installations", {
							organizationId: runner.seeded.organizationId,
							workspaceId: runner.seeded.workspaceId,
							pluginVersionId,
							pluginName,
							status: "enabled",
							acceptedCapabilities: [],
							capabilitiesAcceptedAt: now,
							acceptedOutboundOrigins: [],
							outboundOriginsAcceptedAt: now,
							installedBy: runner.seeded.userId,
							updatedBy: runner.seeded.userId,
							updatedAt: now,
						}),
					);
				}
				return { pluginVersionId, installationId };
			}

			test("hides /.plugins entirely when no plugin is installed", async () => {
				const runner = await create_bash_runner();
				// Published but not installed in this workspace: no existence leak.
				await seed_plugin_mount(runner, "media", [{ path: "/dist/backend/worker.js", rawText: WORKER_TEXT }], {
					installed: false,
				});

				const listing = await runner.run("ls /.plugins");
				expect(listing.metadata.exitCode).not.toBe(0);
				expect(listing.stderr).toContain("No such file");

				const read = await runner.run("cat /.plugins/media/dist/backend/worker.js");
				expect(read.metadata.exitCode).not.toBe(0);
				expect(read.stderr).toContain("No such file");

				// The fan-out commands also treat the root as nonexistent with zero installations.
				const tree = await runner.run("tree /.plugins");
				expect(tree.metadata.exitCode).not.toBe(0);
				expect(tree.stderr).toContain("No such file");

				const found = await runner.run("find /.plugins");
				expect(found.metadata.exitCode).not.toBe(0);
				expect(found.stderr).toContain("No such file");

				const searched = await runner.run("search --path /.plugins Glomtelemetry");
				expect(searched.metadata.exitCode).not.toBe(0);
				expect(searched.stderr).toContain("No such file");
			});

			test("lists installed plugin names at the synthetic /.plugins root", async () => {
				const runner = await create_bash_runner();
				await seed_plugin_mount(runner, "media", [{ path: "/dist/backend/worker.js", rawText: WORKER_TEXT }]);
				await seed_plugin_mount(runner, "alpha-notes", [{ path: "/README.md", rawText: PLUGIN_README_TEXT }]);

				const result = await runner.run("ls /.plugins");

				expect(result.metadata.exitCode).toBe(0);
				expect(result.stdout).toContain("media");
				expect(result.stdout).toContain("alpha-notes");
			});

			test("lists and reads files inside an installed plugin byte-identically", async () => {
				const runner = await create_bash_runner();
				await seed_plugin_mount(runner, "media", [
					{ path: "/README.md", rawText: PLUGIN_README_TEXT },
					{ path: "/dist/backend/worker.js", rawText: WORKER_TEXT },
				]);

				const listing = await runner.run("ls /.plugins/media");
				expect(listing.metadata.exitCode).toBe(0);
				expect(listing.stdout).toContain("README.md");
				expect(listing.stdout).toContain("dist");

				const readme = await runner.run("cat /.plugins/media/README.md");
				expect(readme.metadata.exitCode).toBe(0);
				expect(readme.stdout).toBe(PLUGIN_README_TEXT);

				const worker = await runner.run("cat /.plugins/media/dist/backend/worker.js");
				expect(worker.metadata.exitCode).toBe(0);
				expect(worker.stdout).toBe(WORKER_TEXT);
			});

			test("grep and search find content scoped to one plugin", async () => {
				const runner = await create_bash_runner();
				await seed_plugin_mount(runner, "media", [{ path: "/dist/backend/worker.js", rawText: WORKER_TEXT }]);

				const grepped = await runner.run("grep Glomtelemetry /.plugins/media/dist/backend/worker.js");
				expect(grepped.metadata.exitCode).toBe(0);
				expect(grepped.stdout).toContain("Glomtelemetry marker line.");

				const searched = await runner.run("search --path /.plugins/media Glomtelemetry");
				expect(searched.metadata.exitCode).toBe(0);
				expect(searched.stdout).toContain("worker.js");
			});

			test("fans out root-scope tree, find, and search across installed plugins in name order", async () => {
				const runner = await create_bash_runner();
				await seed_plugin_mount(runner, "media", [{ path: "/dist/backend/worker.js", rawText: WORKER_TEXT }]);
				await seed_plugin_mount(runner, "alpha-notes", [{ path: "/README.md", rawText: PLUGIN_README_TEXT }]);

				const tree = await runner.run("tree /.plugins");
				expect(tree.metadata.exitCode).toBe(0);
				expect(tree.stdout).toContain("/.plugins");
				expect(tree.stdout).toContain("|-- alpha-notes/");
				expect(tree.stdout).toContain("|-- media/");
				expect(tree.stdout).toContain("README.md");
				expect(tree.stdout).toContain("worker.js");
				expect(tree.stdout.indexOf("alpha-notes")).toBeLessThan(tree.stdout.indexOf("media"));

				const found = await runner.run("find /.plugins -type f --limit 20");
				expect(found.metadata.exitCode).toBe(0);
				expect(found.stdout).toContain("/.plugins/alpha-notes/README.md");
				expect(found.stdout).toContain("/.plugins/media/dist/backend/worker.js");

				// Depth predicates are relative to /.plugins: -maxdepth 1 keeps only plugin folders.
				const top = await runner.run("find /.plugins -maxdepth 1 --limit 20");
				expect(top.metadata.exitCode).toBe(0);
				expect(top.stdout).toContain("/.plugins/alpha-notes/");
				expect(top.stdout).toContain("/.plugins/media/");
				expect(top.stdout).not.toContain("README.md");

				const searched = await runner.run("search --path /.plugins Glomtelemetry");
				expect(searched.metadata.exitCode).toBe(0);
				expect(searched.stdout).toContain("under /.plugins");
				expect(searched.stdout).toContain("/.plugins/media/dist/backend/worker.js");
			});

			test("pages the /.plugins fan-out with a composite cursor and detects listing changes", async () => {
				const runner = await create_bash_runner();
				await seed_plugin_mount(runner, "alpha-notes", [{ path: "/README.md", rawText: PLUGIN_README_TEXT }]);
				const { installationId } = await seed_plugin_mount(runner, "media", [
					{ path: "/README.md", rawText: PLUGIN_README_TEXT },
				]);

				const firstPage = await runner.run("find /.plugins -type f --limit 1");
				expect(firstPage.metadata.exitCode).toBe(0);
				expect(firstPage.stdout).toContain("/.plugins/alpha-notes/README.md");
				expect(firstPage.stdout).not.toContain("/.plugins/media/README.md");
				const continuation = firstPage.stdout.match(/Next page: (find .+)/)?.[1];
				expect(continuation).toBeTruthy();

				// The composite cursor resumes into the next plugin in name order.
				const secondPage = await runner.run(String(continuation));
				expect(secondPage.metadata.exitCode).toBe(0);
				expect(secondPage.stdout).toContain("/.plugins/media/README.md");

				// Uninstalling between pages invalidates the pinned listing snapshot.
				const restartPage = await runner.run("find /.plugins -type f --limit 1");
				const staleContinuation = restartPage.stdout.match(/Next page: (find .+)/)?.[1];
				expect(staleContinuation).toBeTruthy();
				await runner.t.run(async (ctx) => {
					if (installationId == null) {
						throw new Error("Expected seeded installation");
					}
					await ctx.db.delete("plugins_workspace_installations", installationId);
				});
				const changed = await runner.run(String(staleContinuation));
				expect(changed.metadata.exitCode).not.toBe(0);
				expect(changed.stderr).toContain("listing changed");
			});

			test("keeps guidance for root-scope --prefix and meta search", async () => {
				const runner = await create_bash_runner();
				await seed_plugin_mount(runner, "media", [{ path: "/dist/backend/worker.js", rawText: WORKER_TEXT }]);

				const prefixed = await runner.run("find --prefix /.plugins --limit 5");
				expect(prefixed.metadata.exitCode).not.toBe(0);
				expect(prefixed.stderr).toContain("--prefix cannot scan the /.plugins root");

				const metaSearched = await runner.run(`meta search --path /.plugins --where '{"exists":"frontmatter.cc"}'`);
				expect(metaSearched.metadata.exitCode).not.toBe(0);
				expect(metaSearched.stderr).toContain("choose a single plugin to search");
			});

			test("scoped tree and find work inside one plugin", async () => {
				const runner = await create_bash_runner();
				await seed_plugin_mount(runner, "media", [
					{ path: "/README.md", rawText: PLUGIN_README_TEXT },
					{ path: "/dist/backend/worker.js", rawText: WORKER_TEXT },
				]);

				const tree = await runner.run("tree /.plugins/media");
				expect(tree.metadata.exitCode).toBe(0);
				expect(tree.stdout).toContain("README.md");
				expect(tree.stdout).toContain("worker.js");

				const found = await runner.run("find /.plugins/media -type f --limit 20");
				expect(found.metadata.exitCode).toBe(0);
				expect(found.stdout).toContain("/.plugins/media/README.md");
				expect(found.stdout).toContain("/.plugins/media/dist/backend/worker.js");
			});

			test("cd into a plugin mount persists across invocations", async () => {
				const runner = await create_bash_runner();
				await seed_plugin_mount(runner, "media", [{ path: "/dist/backend/worker.js", rawText: WORKER_TEXT }]);

				const moved = await runner.run("cd /.plugins/media/dist");
				expect(moved.metadata.exitCode).toBe(0);

				const here = await runner.run("pwd");
				expect(here.metadata.exitCode).toBe(0);
				expect(here.stdout).toBe("/.plugins/media/dist\n");
			});

			test("rejects every write into a plugin mount and leaves it intact", async () => {
				const runner = await create_bash_runner();
				await seed_plugin_mount(runner, "media", [{ path: "/README.md", rawText: PLUGIN_README_TEXT }]);

				const writes = [
					"touch /.plugins/media/new.txt",
					"rm /.plugins/media/README.md",
					"mv /.plugins/media/README.md /.plugins/media/renamed.md",
					"echo hi | tee /.plugins/media/new.txt",
					"cp /.plugins/media/README.md /.plugins/media/copy.md",
				];
				for (const command of writes) {
					const result = await runner.run(command);
					expect(result.metadata.exitCode).not.toBe(0);
					expect(result.stderr).toContain("read-only mount of installed plugin sources");
				}

				const readme = await runner.run("cat /.plugins/media/README.md");
				expect(readme.metadata.exitCode).toBe(0);
				expect(readme.stdout).toBe(PLUGIN_README_TEXT);
			});

			test("allows copying a plugin file out to /tmp scratch", async () => {
				const runner = await create_bash_runner();
				await seed_plugin_mount(runner, "media", [{ path: "/README.md", rawText: PLUGIN_README_TEXT }]);

				const copied = await runner.run("cp /.plugins/media/README.md /tmp/readme.md && cat /tmp/readme.md");
				expect(copied.metadata.exitCode).toBe(0);
				expect(copied.stdout).toBe(PLUGIN_README_TEXT);
			});

			test("refuses to execute plugin source through bash and source", async () => {
				const runner = await create_bash_runner();
				await seed_plugin_mount(runner, "media", [{ path: "/script.sh", rawText: "echo pwned\n" }]);

				const executed = await runner.run("bash /.plugins/media/script.sh");
				expect(executed.metadata.exitCode).not.toBe(0);
				expect(executed.stdout).not.toContain("pwned");
				expect(executed.stderr).toContain("not executable through bash");

				const sourced = await runner.run("source /.plugins/media/script.sh");
				expect(sourced.metadata.exitCode).not.toBe(0);
				expect(sourced.stdout).not.toContain("pwned");
				expect(sourced.stderr).toContain("cannot load app files or agent-only external mounts");
			});

			test("reports not-installed plugin names as plain missing paths", async () => {
				const runner = await create_bash_runner();
				await seed_plugin_mount(runner, "media", [{ path: "/README.md", rawText: PLUGIN_README_TEXT }]);

				const listMissing = await runner.run("ls /.plugins/nope");
				expect(listMissing.metadata.exitCode).not.toBe(0);
				expect(listMissing.stderr).toContain("No such file");

				const catMissing = await runner.run("cat /.plugins/nope/x.md");
				expect(catMissing.metadata.exitCode).not.toBe(0);
				expect(catMissing.stderr).toContain("No such file");
			});

			test("keeps plugin source isolated from the tenant app tree", async () => {
				const runner = await create_bash_runner();
				const { pluginVersionId } = await seed_plugin_mount(runner, "media", [
					{ path: "/dist/backend/worker.js", rawText: WORKER_TEXT },
				]);

				// App-scope search never reaches the reserved plugin scope.
				const workspaceSearch = await runner.run("search Glomtelemetry");
				expect(workspaceSearch.metadata.exitCode).toBe(0);
				expect(workspaceSearch.stdout).not.toContain("worker.js");

				// The stored version-keyed path is not addressable outside the /.plugins prefix.
				const bare = await runner.run(`cat /${pluginVersionId}/dist/backend/worker.js`);
				expect(bare.metadata.exitCode).not.toBe(0);
			});

			test("drops the mount when the installation is removed", async () => {
				const runner = await create_bash_runner();
				const { installationId } = await seed_plugin_mount(runner, "media", [
					{ path: "/README.md", rawText: PLUGIN_README_TEXT },
				]);

				const visible = await runner.run("cat /.plugins/media/README.md");
				expect(visible.metadata.exitCode).toBe(0);

				await runner.t.run(async (ctx) => {
					if (installationId == null) {
						throw new Error("Expected seeded installation");
					}
					await ctx.db.delete("plugins_workspace_installations", installationId);
				});

				// Mounts are derived per command run, so the next call already reflects the uninstall.
				const gone = await runner.run("cat /.plugins/media/README.md");
				expect(gone.metadata.exitCode).not.toBe(0);
				expect(gone.stderr).toContain("No such file");
			});
		});
	});
}
