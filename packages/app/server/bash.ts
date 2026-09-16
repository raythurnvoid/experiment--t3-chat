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
	type ExecOptions,
	type FileContent,
	type FsStat,
	type IFileSystem,
	type InterpreterStateSnapshot,
	type MkdirOptions,
	type RmOptions,
} from "just-bash/browser";
import { internal } from "../convex/_generated/api.js";
import type { ActionCtx } from "../convex/_generated/server.js";
import type { Doc, Id } from "../convex/_generated/dataModel";
import type { bash_ReviewScratch } from "../convex/bash.ts";
import type {
	ai_chat_files_claim_bash_job_Result,
	ai_chat_files_load_thread_tmp_files_Result,
	ai_chat_files_patch_thread_tmp_files_Args,
	ai_chat_files_poll_bash_job_Result,
	ai_chat_files_read_shell_transcript_Result,
	ai_chat_files_start_bash_job_Result,
} from "../convex/ai_chat_files.ts";
import type { files_PendingTarget } from "../shared/files.ts";
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
import type { bash_TransferContext } from "./bash-transfer-command.ts";
import {
	bash_JOB_OUTPUT_READ_BUDGET_BYTES,
	bash_job_status_word,
	bash_jobs_command_create,
	bash_kill_command_create,
	bash_wait_command_create,
	type bash_JobContext,
} from "./bash-jobs-command.ts";
import { bash_nested_shell_command_create } from "./bash-nested-shell-command.ts";
import { bash_head_tail_wc_command_create } from "./bash-head-tail-wc-command.ts";
import { bash_resolve_command_create } from "./bash-resolve-command.ts";
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
	bash_SHELLS_MOUNT,
	bash_DbFilesFs,
	bash_ABORT_REASON_STOPPED,
	bash_COMMAND_EXIT_FAILURE,
	bash_COMMAND_EXIT_CANNOT_EXECUTE,
	bash_COMMAND_EXIT_STOPPED,
	bash_COMMAND_EXIT_TIMED_OUT,
	bash_TERMINAL_LINE_ENDING_REGEX,
	bash_SHELL_COMMENT_LINE_REGEX,
	bash_WHITESPACE_RUN_REGEX,
	type bash_DbFilesRoots,
} from "./bash-utils.ts";
import { bash_ALLOWED_COMMANDS, bash_delegate_native_just_bash_tmp_command } from "./bash-delegate.ts";
import { bash_which_command_create } from "./bash-which-command.ts";
import { bash_xargs_command_create } from "./bash-xargs-command.ts";

const DEFAULT_CWD = "~";
const OUTPUT_LIMIT = 128 * 1024;
// A saved shell state above this is not stored; the previous state stays and the call warns.
const SHELL_STATE_MAX_BYTES = 128 * 1024;
// A job has an 8-minute budget, so it may run more statements than a 90-second call.
const BASH_JOB_MAX_COMMAND_COUNT = 2_000;
// The worker reads the Stop flag, the row status and its permissions this often.
const BASH_JOB_POLL_MS = 5_000;
// After this many refused launches in one call, the hook refuses the rest without a query.
const BASH_JOB_LAUNCH_MAX_REFUSALS = 3;
// Any abort reason other than `bash_ABORT_REASON_STOPPED` reports 124, so this text is what the
// user reads in the job's stderr. It is not the flag that picks the exit code.
const BASH_JOB_DEADLINE_ABORT_REASON = "Bash deadline reached";

const TERMINAL_TRAILING_NEWLINE_REGEX = /\n+$/;

const COMMAND_NOT_FOUND_REGEX = /: command not found$/m;
const REDIRECTS_STDERR_TO_STDOUT_REGEX = /(^|[\s;&|])2\s*>\s*&\s*1(?=$|[\s;&|])/;
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
 * A read-only view over an in-memory fs, for the `/shells` mount. Reads forward to the inner fs;
 * every write throws, so `> /shells/x/transcript` fails with a clear error instead of vanishing at
 * call end. Wrapped like `BashTmpFs`, not extended, because `ReadOnlyBaseFs` is the disk root.
 */
class ReadOnlyInMemoryFs implements IFileSystem {
	constructor(readonly fs: InMemoryFs) {}

	async readFile(path: string, options?: Parameters<IFileSystem["readFile"]>[1]) {
		return await this.fs.readFile(path, options);
	}

	async readFileBuffer(path: string) {
		return await this.fs.readFileBuffer(path);
	}

	async writeFile(path: string, _content: FileContent, _options?: Parameters<IFileSystem["writeFile"]>[2]) {
		throw new ReadOnlyFileSystemError(path);
	}

	async appendFile(path: string, _content: FileContent, _options?: Parameters<IFileSystem["appendFile"]>[2]) {
		throw new ReadOnlyFileSystemError(path);
	}

	async exists(path: string) {
		return await this.fs.exists(path);
	}

	async stat(path: string) {
		return await this.fs.stat(path);
	}

	async mkdir(path: string, _options?: MkdirOptions) {
		throw new ReadOnlyFileSystemError(path);
	}

	async readdir(path: string) {
		return await this.fs.readdir(path);
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
		return this.fs.resolvePath(base, path);
	}

	getAllPaths() {
		return this.fs.getAllPaths();
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

	async readlink(path: string) {
		return await this.fs.readlink(path);
	}

	async lstat(path: string) {
		return await this.fs.lstat(path);
	}

	async realpath(path: string) {
		return await this.fs.realpath(path);
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
	persistedCwdTarget: files_PendingTarget | null;
	allowDbFilesMkdir: boolean;
	githubMounts: Doc<"github_mounts">[];
	pluginSourceMounts: plugins_list_bash_source_mounts_Result;
	transferContext: bash_TransferContext;
	jobContext: bash_JobContext;
	shells: { _id: Id<"ai_chat_bash_shells">; name: string }[];
	restoreState: InterpreterStateSnapshot | undefined;
	onExecEnd?: (snapshot: InterpreterStateSnapshot) => void;
	executionLimitsOverride?: { maxCommandCount: number };
}) {
	// Organization and workspace names are validated slugs, so they are stable shell
	// path segments and do not need path-segment encoding here.
	const currentWorkspacePath = `${bash_APP_MOUNT_PATH}/${args.organizationName}/${args.workspaceName}`;

	const tmpFs = await BashTmpFs.create(args.ctx, args.threadId);

	// `/shells/<name>/transcript` loads on first read. The engine also loads a lazy file on `stat`
	// (it needs a size), so `ls -l`, `find`, `wc -c` and `test -s` on a transcript run the query;
	// a plain `ls /shells` only lists the folders and runs nothing.
	const shellsFs = new InMemoryFs();
	for (const shell of args.shells) {
		shellsFs.writeFileLazy(`/${shell.name}/transcript`, async () => {
			const entries = (await args.ctx.runQuery(internal.ai_chat_files.read_shell_transcript, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				userId: args.userId,
				threadId: args.threadId,
				shellId: shell._id,
			})) as ai_chat_files_read_shell_transcript_Result;
			return entries.map((entry) => entry.text).join("\n");
		});
	}

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
			{ mountPoint: bash_SHELLS_MOUNT, filesystem: new ReadOnlyInMemoryFs(shellsFs) },
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

	const get_directory_path = async (target: files_PendingTarget) => {
		const directory = await args.ctx.runQuery(internal.files_visible.internal_get_directory_path, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			target,
		});
		return directory ? bash_db_files_path_to_current_workspace_path(currentWorkspacePath, directory.path) : null;
	};
	const get_cwd_target = async (path: string) => {
		const dbFilesPath = bash_current_workspace_path_to_db_files_path(currentWorkspacePath, bash_normalize_path(path));
		if (dbFilesPath === null || dbFilesPath === "/") return null;
		const entry = await appDbFilesFs.getEntry(dbFilesPath, false);
		return entry?.kind === "folder" && entry.target?.kind !== "root" ? (entry?.target ?? null) : null;
	};

	// A target survives moves and publication. A removed target must not adopt a new occupant.
	let requestedCwd = args.persistedCwd === DEFAULT_CWD ? currentWorkspacePath : args.persistedCwd;
	if (args.persistedCwdTarget) {
		requestedCwd = (await get_directory_path(args.persistedCwdTarget)) ?? bash_normalize_path(`${requestedCwd}/..`);
	}
	// The remembered folder can be gone by the next run (deleted folder, pruned /tmp).
	const cwd = (await nearest_existing_dir(fs, requestedCwd)) ?? currentWorkspacePath;

	// A successful cd starts a new selection, even when it returns to the same path.
	const cwdToken = {};
	const cwdTargets = new WeakMap<object, files_PendingTarget>();
	const remember_cwd = async (path: string, token: object) => {
		const target = await get_cwd_target(path);
		if (target) cwdTargets.set(token, target);
	};
	await remember_cwd(cwd, cwdToken);

	// A `&` statement becomes a background job. The engine hands over the statement text, the
	// live cwd and a state snapshot taken at the `&`, so a loop variable is captured per job. The
	// cwd target is resolved from the live cwd here, never from the shell row: `cd x; cmd &` must
	// start the job in `x`, and the mutation cannot resolve a path on its own.
	const onBackground: NonNullable<ExecOptions["onBackground"]> = async (launch) => {
		const job = args.jobContext;
		if (job.launchAttempts >= BASH_JOB_LAUNCH_MAX_REFUSALS)
			return {
				jobNumber: null,
				stderr: `bash: cannot start a job: ${BASH_JOB_LAUNCH_MAX_REFUSALS} launches were already refused in this call\n`,
			};
		const started = (await args.ctx.runMutation(internal.ai_chat_files.start_bash_job, {
			parentInvocationId: job.invocationId,
			commandNumber: job.nextCommandNumber(),
			shellId: job.shellId,
			// The engine hands over the statement text with only the `&` cut out. Store it without
			// the whitespace around it: the transcript prints the script on its own line.
			script: launch.script.trim(),
			startCwd: launch.cwd,
			startCwdTarget: await get_cwd_target(launch.cwd),
			shellState: launch.snapshot,
			allowDbFilesMkdir: job.allowDbFilesMkdir,
		})) as ai_chat_files_start_bash_job_Result;
		if (started._nay) {
			job.launchAttempts += 1;
			return { jobNumber: null, stderr: `bash: cannot start a job: ${started._nay.message}\n` };
		}
		const { jobNumber } = started._yay;
		job.launchedJobNumbers.push(jobNumber);
		// Extra fds (`exec 3>out`) are in the snapshot for report only; the job does not get them.
		let stderr = "";
		for (const fd of launch.snapshot.openFileDescriptors) stderr += `bash: file descriptor ${fd} was closed\n`;
		stderr += `bash: started job ${jobNumber} in shell ${job.shellName}. Follow it with \`jobs\`, or in the Notifications panel.\n`;
		return { jobNumber, stderr };
	};

	const shell = bash_shell_create(args.ctx, {
		fs,
		cwd,
		cwdToken,
		dbFilesRoots,
		rememberCwd: remember_cwd,
		transferContext: args.transferContext,
		jobContext: args.jobContext,
		onBackground,
		restoreState: args.restoreState,
		onExecEnd: args.onExecEnd,
		executionLimitsOverride: args.executionLimitsOverride,
	});

	return {
		cwd,
		currentWorkspacePath,
		...shell,
		nearest_existing_dir: (path: string) => nearest_existing_dir(fs, path),
		get_cwd_target,
		resolve_cwd: async (selection: { path: string; token: object }) => {
			const target = cwdTargets.get(selection.token);
			return target
				? ((await get_directory_path(target)) ?? bash_normalize_path(`${selection.path}/..`))
				: selection.path;
		},
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
		tmp_dirty_roots: () => tmpFs.dirtyRoots,
		path_index_truncated: () => appDbFilesFs.pathIndexTruncated,
		clear_observed_paths: () => {
			appDbFilesFs.observedPaths.clear();
			appDbFilesFs.observedPathsTruncated = false;
		},
		observed_paths: appDbFilesFs.observedPaths,
		observed_paths_truncated: () => appDbFilesFs.observedPathsTruncated,
		truncate_output,
		format_output: format_bash_output,
	};
}

function bash_shell_create(
	ctx: ActionCtx,
	args: {
		fs: MountableFs;
		cwd: string;
		cwdToken?: object;
		dbFilesRoots: bash_DbFilesRoots;
		rememberCwd?: (path: string, token: object) => Promise<void>;
		transferContext?: bash_TransferContext;
		/**
		 * Present in a chat call and a job worker. The plugin-review shell has none, so it gets no
		 * `jobs`, `wait` or `kill`, and its `&` runs inline.
		 */
		jobContext?: bash_JobContext;
		onBackground?: NonNullable<ExecOptions["onBackground"]>;
		/**
		 * A job may raise the statement count only. `maxOutputSize` stays: the transcript-entry
		 * size math depends on it.
		 */
		executionLimitsOverride?: { maxCommandCount: number };
		restoreState?: InterpreterStateSnapshot;
		onExecEnd?: (snapshot: InterpreterStateSnapshot) => void;
	},
) {
	const { fs, cwd, dbFilesRoots } = args;
	const cwdToken = args.cwdToken ?? {};
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
			bash_resolve_command_create(ctx, dbFilesRoots),
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
						bash_cp_command_create(ctx, dbFilesRoots, args.transferContext),
						bash_mv_command_create(ctx, dbFilesRoots, args.transferContext),
					]
				: []),
			bash_tee_command_create(dbFilesRoots),
			// Background jobs.
			...(args.jobContext
				? [
						bash_jobs_command_create(ctx, args.jobContext),
						bash_wait_command_create(ctx, args.jobContext),
						bash_kill_command_create(ctx, args.jobContext),
					]
				: []),
			// Nested execution.
			bash_nested_shell_command_create("bash", dbFilesRoots.app),
			bash_nested_shell_command_create("sh", dbFilesRoots.app),
			// xargs/which.
			bash_xargs_command_create(dbFilesRoots.app),
			bash_which_command_create(),
			// Native /tmp wrappers.
			...native_just_bash_tmp_command_create_all(currentWorkspacePath),
		].map(record_app_command_diagnostics),
		executionLimits: {
			maxCommandCount: args.executionLimitsOverride?.maxCommandCount ?? 200,
			maxLoopIterations: 10_000,
			maxCallDepth: 50,
			// Since just-bash 3.4 this budget also counts the bytes a redirection writes to a file,
			// not only the output a call returns. So a single call cannot write much more than this
			// to an app file, which is well under the app's own 900,000-byte file limit. Do not
			// raise it to close that gap: one transcript entry has to fit in a Convex document, and
			// `BASH_SHELL_TRANSCRIPT_ENTRY_MAX_BYTES` is already sized for the worst-case output of
			// this number. Bigger app files arrive through upload and the editor instead.
			maxOutputSize: 250_000,
			maxHeredocSize: 250_000,
		},
	});

	return {
		run_command: async (command: string) => {
			// Block app and read-only mount files before Just Bash can load their
			// contents as shell code through direct or nested commands.
			if (await bash_command_loads_disallowed_shell_code(command, { cwd, fs, appRoot: dbFilesRoots.app })) {
				return {
					stdout: "",
					stderr: bash_disallowed_shell_code_error(),
					exitCode: bash_COMMAND_EXIT_CANNOT_EXECUTE,
					cwd: { path: cwd, token: cwdToken },
					env: {
						PWD: cwd,
					},
				};
			}

			// Surface unexpected Just Bash failures as terminal stderr instead of
			// failing the Convex action.
			const result = await bash
				.exec(command, {
					cwdToken,
					onCwdChange: args.rememberCwd,
					signal: args.transferContext?.signal,
					restoreState: args.restoreState,
					onExecEnd: args.onExecEnd,
					onBackground: args.onBackground,
				})
				.catch((error: unknown) => ({
					stdout: "",
					stderr: `${error instanceof Error ? error.message : String(error)}\n`,
					exitCode: bash_COMMAND_EXIT_FAILURE,
					cwd: { path: cwd, token: cwdToken },
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
	const nextCwd = (await nearest_existing_dir(fs, result.cwd.path)) ?? currentWorkspacePath;

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
		toolCallId: string;
		command: string;
		allowDbFilesMkdir: boolean;
		shellName: string;
	},
): Promise<NonNullable<Doc<"ai_chat_bash_invocations">["result"]>> {
	// The shell is part of the call identity: a replay with another shell must not rejoin.
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(JSON.stringify([args.command, args.allowDbFilesMkdir, args.shellName])),
	);

	const commandHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");

	const identity = {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		userId: args.userId,
		threadId: args.threadId,
		toolCallId: args.toolCallId,
		commandHash,
	};

	// A lost begin reply may already own this call. Read it back instead of running it a second time.
	const begun = await ctx
		.runMutation(internal.ai_chat_files.begin_bash_invocation, { ...identity, shellName: args.shellName })
		.catch(() => ctx.runQuery(internal.ai_chat_files.get_bash_invocation, identity));
	if (begun._nay) throw new Error(begun._nay.message);

	const invocation = begun._yay;

	if (!invocation.isNew) {
		if (invocation.result) return invocation.result;

		const cwd = `${bash_APP_MOUNT_PATH}/${args.organizationName}/${args.workspaceName}`;

		const exitCode =
			invocation.status === "running"
				? 3
				: invocation.status === "interrupted" && invocation.deadlineAt <= Date.now()
					? 124
					: 1;

		const stderr =
			invocation.status === "running"
				? `Bash call ${invocation.invocationId} is still running. Check Notifications for its progress.\n`
				: exitCode === 124
					? `Bash call ${invocation.invocationId} reached its deadline. Check Notifications before starting a new command.\n`
					: invocation.resultExpired
						? `Bash call ${invocation.invocationId} has finished and its saved result has expired. Start a new command.\n`
						: `Bash call ${invocation.invocationId} was interrupted. Check Notifications before starting a new command.\n`;

		return {
			title: `exit ${exitCode} · ${cwd}`,
			stdout: "",
			stderr,
			output: format_bash_output({ command: args.command, cwd, nextCwd: cwd, exitCode, stdout: "", stderr }),
			metadata: {
				command: args.command,
				cwd,
				nextCwd: cwd,
				exitCode,
				stdoutTruncated: false,
				stderrTruncated: false,
				stdoutLength: 0,
				stderrLength: stderr.length,
				pathIndexTruncated: false,
				observedPaths: [],
				observedPathsTruncated: false,
			},
		};
	}

	// A replayed begin has no shell; that path returned above.
	if (!("shell" in invocation)) {
		throw should_never_happen("Bash begin returned no shell", { invocationId: invocation.invocationId });
	}

	const abort = new AbortController();
	const deadlineTimer = setTimeout(
		() => abort.abort("Bash deadline reached"),
		Math.max(0, invocation.deadlineAt - Date.now()),
	);
	let commandNumber = 0;
	// Set by the engine when the exec ends; stays unset when the engine threw before that.
	let endSnapshot: InterpreterStateSnapshot | undefined;
	try {
		// Mount visibility is decided per run: only plugins with an enabled installation in this
		// workspace appear under `/.plugins`, and only GitHub mounts with a finished sync appear
		// under `/.mounts` (their commit sha is pinned for the whole run).
		const [githubMounts, pluginSourceMounts] = await Promise.all([
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
			persistedCwd: invocation.shell.cwd,
			persistedCwdTarget: invocation.shell.cwdTarget,
			allowDbFilesMkdir: args.allowDbFilesMkdir,
			githubMounts,
			pluginSourceMounts,
			transferContext: {
				invocationId: invocation.invocationId,
				membershipId: invocation.membershipId,
				deadlineAt: invocation.transferDeadlineAt,
				signal: abort.signal,
				abort: (reason) => abort.abort(reason),
				nextCommandNumber: () => commandNumber++,
				jobId: null,
			},
			jobContext: {
				invocationId: invocation.invocationId,
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				threadId: args.threadId,
				userId: args.userId,
				membershipId: invocation.membershipId,
				shellId: invocation.shell._id,
				shellName: args.shellName,
				allowDbFilesMkdir: args.allowDbFilesMkdir,
				deadlineAt: invocation.transferDeadlineAt,
				signal: abort.signal,
				nextCommandNumber: () => commandNumber++,
				launchedJobNumbers: [],
				launchAttempts: 0,
				readBudgetRemaining: bash_JOB_OUTPUT_READ_BUDGET_BYTES,
			},
			shells: invocation.shells,
			// `null` is a fresh shell: nothing to seed.
			restoreState: invocation.shell.state ?? undefined,
			onExecEnd: (snapshot) => {
				endSnapshot = snapshot;
			},
		});

		const { result, observedPaths, observedPathsTruncated, nextCwd } = await run_command_and_diagnose({
			bashFs,
			command: args.command,
			abort,
			threadId: args.threadId,
		});

		// Jobs that finished since this user's last fresh call are announced first.
		result.stderr =
			invocation.notes
				.map(
					(note) =>
						`bash: job ${note.jobNumber} ${bash_job_status_word(note.status)}. Output: ${bash_SHELLS_MOUNT}/${note.shellName}/transcript\n`,
				)
				.join("") + result.stderr;

		// Extra fds (`exec 3>out`) are reported by the snapshot but never restored in the next call.
		// A state over the cap is not saved: the previous state stays, and the call says so.
		let nextState = endSnapshot;
		if (endSnapshot) {
			for (const fd of endSnapshot.openFileDescriptors) {
				result.stderr += `bash: file descriptor ${fd} was closed\n`;
			}
			if (new TextEncoder().encode(JSON.stringify(endSnapshot)).byteLength > SHELL_STATE_MAX_BYTES) {
				result.stderr += "bash: the shell state is larger than 128 KiB and was not saved; the previous state stays.\n";
				nextState = undefined;
			}
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
					invocationId: invocation.invocationId,
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

		// Every call saves its shell, because every call appends a transcript entry. The entry
		// carries the full output (the engine already caps it), not the truncated tool result.
		const nextCwdTarget = await bashFs.get_cwd_target(nextCwd);
		pendingMutations.push(
			ctx.runMutation(internal.ai_chat.save_shell, {
				invocationId: invocation.invocationId,
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				threadId: args.threadId,
				userId: args.userId,
				shellId: invocation.shell._id,
				cwd: nextCwd,
				cwdTarget: nextCwdTarget,
				...(nextState !== undefined ? { state: nextState } : {}),
				transcriptEntry: `$ [${new Date().toISOString()}] (exit ${result.exitCode}) ${bashFs.cwd}\n${args.command}\n${result.stdout}\n${result.stderr}`,
			}),
		);

		await Promise.all(pendingMutations);

		const response = bash_response({ bashFs, command: args.command, result, nextCwd, observedPaths, observedPathsTruncated });
		console.debug("Bash command completed", {
			threadId: args.threadId,
			shellName: args.shellName,
			commandName: args.command.trim().split(bash_WHITESPACE_RUN_REGEX, 1)[0] ?? "",
			exitCode: result.exitCode,
			stdoutLength: response.metadata.stdoutLength,
			stderrLength: response.metadata.stderrLength,
			pathIndexTruncated: response.metadata.pathIndexTruncated,
		});

		const finished = await ctx.runMutation(internal.ai_chat_files.finish_bash_invocation, {
			invocationId: invocation.invocationId,
			commandHash,
			result: response,
		});
		if (finished._nay) throw new Error(finished._nay.message);
		if (finished._yay.result) return finished._yay.result;

		// The watchdog or finalization can end the call while its last writes are pending.
		const exitCode = finished._yay.deadlineAt <= Date.now() ? 124 : 1;
		const stderr = `${response.stderr}bash: ${exitCode === 124 ? "execution deadline reached" : "call was interrupted"}. Check Notifications before starting a new command.\n`;

		return {
			...response,
			title: `exit ${exitCode} · ${nextCwd}`,
			stderr,
			output: bashFs.format_output({
				command: args.command,
				cwd: bashFs.cwd,
				nextCwd,
				exitCode,
				stdout: response.stdout,
				stderr,
			}),
			metadata: { ...response.metadata, exitCode, stderrLength: stderr.length },
		};
	} catch (error) {
		await ctx
			.runMutation(internal.ai_chat_files.interrupt_bash_invocation, { invocationId: invocation.invocationId })
			.catch((interruptionError: unknown) =>
				console.error("Failed to mark Bash call interrupted", {
					invocationId: invocation.invocationId,
					error: interruptionError,
				}),
			);
		throw error;
	} finally {
		clearTimeout(deadlineTimer);
	}
}

/**
 * The part of a run that a chat call and a job worker share: run the command, turn an abort
 * into 124 or 143, add the agent-facing diagnostics, and settle the next cwd.
 */
async function run_command_and_diagnose(args: {
	bashFs: Awaited<ReturnType<typeof bash_fs_create>>;
	command: string;
	abort: AbortController;
	threadId: Id<"ai_chat_threads">;
}) {
	const { bashFs, command, abort } = args;

	// Scope follows shell operations, not the cwd checks before and after them.
	bashFs.clear_observed_paths();
	const result = await bashFs.run_command(command);
	// The abort reason decides 124 or 143, never the engine's exit code: an aborted last statement
	// can return 0. Only a job Stop aborts with the stop reason.
	if (abort.signal.aborted) {
		result.exitCode =
			abort.signal.reason === bash_ABORT_REASON_STOPPED ? bash_COMMAND_EXIT_STOPPED : bash_COMMAND_EXIT_TIMED_OUT;
		result.stderr += `bash: ${typeof abort.signal.reason === "string" ? abort.signal.reason : "execution deadline reached"}. Remaining commands were stopped.\n`;
	}
	const observedPaths = [...bashFs.observed_paths];
	const observedPathsTruncated = bashFs.observed_paths_truncated();

	// The engine returns its real directory. Shell variables cannot change this selection.
	const rawNextCwd = result.cwd.path;
	// Follow the folder identity before its old path, which may hold a new folder after mv.
	const resolvedCwd = await bashFs.resolve_cwd(result.cwd);
	let nextCwd = (await bashFs.nearest_existing_dir(resolvedCwd)) ?? bashFs.currentWorkspacePath;
	const redirectsStderrToStdout = REDIRECTS_STDERR_TO_STDOUT_REGEX.test(command);

	if (
		COMMAND_NOT_FOUND_REGEX.test(result.stderr) ||
		(redirectsStderrToStdout && COMMAND_NOT_FOUND_REGEX.test(result.stdout))
	) {
		result.stderr +=
			"bash: run 'help' to list available commands; app files are db-backed — use search/grep for content and find/ls for paths.\n";
		const filePathMatch = FILE_COMMAND_OPERAND_REGEX.exec(command.replace(bash_SHELL_COMMENT_LINE_REGEX, ""));
		if (filePathMatch?.[1] != null) {
			const target = bash_shell_arg_quote(filePathMatch[1]);
			result.stderr += `bash: the Unix file command is intentionally unavailable. Try: stat ${target} && wc -c ${target} && head -n 5 ${target}\n`;
		}
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

	// Only paths under HOME, `/tmp`, `/shells`, and the read-only `/.mounts` and `/.plugins` trees
	// survive between runs (`/tmp` is restored from the db; `/shells` and the mounts are rebuilt
	// from the db and the reserved scopes; everything else is synthetic mount scaffolding). A
	// `/.plugins` cwd can still vanish when the plugin is uninstalled; the nearest-existing-dir
	// climb above already handles that.
	if (
		nextCwd !== bash_HOME &&
		!nextCwd.startsWith(`${bash_HOME}/`) &&
		nextCwd !== bash_TMP_MOUNT &&
		!nextCwd.startsWith(`${bash_TMP_MOUNT}/`) &&
		nextCwd !== bash_SHELLS_MOUNT &&
		!nextCwd.startsWith(`${bash_SHELLS_MOUNT}/`) &&
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

	return { result, observedPaths, observedPathsTruncated, nextCwd };
}

/**
 * The stored result of a chat call or a job: the transcript for the model, and the bounded copy
 * of the output the row keeps.
 */
function bash_response(args: {
	bashFs: Awaited<ReturnType<typeof bash_fs_create>>;
	command: string;
	result: { stdout: string; stderr: string; exitCode: number };
	nextCwd: string;
	observedPaths: string[];
	observedPathsTruncated: boolean;
}) {
	const { bashFs, command, result, nextCwd } = args;
	const stdout = bashFs.truncate_output(result.stdout);
	const stderr = bashFs.truncate_output(result.stderr);
	return {
		title: `exit ${result.exitCode} · ${nextCwd}`,
		output: bashFs.format_output({
			command,
			cwd: bashFs.cwd,
			nextCwd,
			exitCode: result.exitCode,
			stdout: stdout.value,
			stderr: stderr.value,
		}),
		stdout: stdout.value,
		stderr: stderr.value,
		metadata: {
			command,
			cwd: bashFs.cwd,
			nextCwd,
			exitCode: result.exitCode,
			stdoutTruncated: stdout.truncated,
			stderrTruncated: stderr.truncated,
			stdoutLength: result.stdout.length,
			stderrLength: result.stderr.length,
			pathIndexTruncated: bashFs.path_index_truncated(),
			observedPaths: args.observedPaths,
			observedPathsTruncated: args.observedPathsTruncated,
		},
	};
}

/**
 * The background job worker, run by the jobs workpool. Claim the row, rebuild the file system
 * the launching call had (its cwd, its state, a private `/tmp` copy, the same mounts), run the
 * script through the same runner, and store the result. Stops, the deadline and a lost
 * permission reach the script through the worker's own abort signal. The pool's `onComplete`
 * settles a worker that throws; the watchdog settles a dead one.
 */
export async function bash_run_job(
	ctx: ActionCtx,
	args: { invocationId: Id<"ai_chat_bash_invocations"> },
): Promise<null> {
	const claimed = (await ctx.runMutation(internal.ai_chat_files.claim_bash_job, {
		invocationId: args.invocationId,
	})) as ai_chat_files_claim_bash_job_Result;
	// Stopped, settled or purged while queued: nothing to run.
	if (!claimed) return null;
	const { row, organizationName, workspaceName, shells } = claimed;
	const job = row.job;
	const shellName = shells.find((shell) => shell._id === job?.shellId)?.name;
	if (!job || job.script === null || job.shellState === null || shellName === undefined) {
		throw should_never_happen("Claimed job row without its script, state or shell", { invocationId: row._id });
	}

	const abort = new AbortController();
	const deadlineTimer = setTimeout(
		() => abort.abort(BASH_JOB_DEADLINE_ABORT_REASON),
		Math.max(0, row.transferDeadlineAt - Date.now()),
	);
	// The Stop button, a deleted row, a lost permission and the watchdog all reach the script
	// through this poll. A missing row and a lost permission count as a stop.
	let polling = false;
	const pollTimer = setInterval(() => {
		if (polling) return;
		polling = true;
		(ctx.runQuery(internal.ai_chat_files.poll_bash_job, { invocationId: row._id }) as Promise<ai_chat_files_poll_bash_job_Result>)
			.then((poll) => {
				if (poll.status === "missing" || poll.stopRequested || !poll.authorized) abort.abort(bash_ABORT_REASON_STOPPED);
				// The watchdog marks the row `interrupted` at the deadline. That is a deadline, not
				// a Stop, so it must report 124 and settle a running copy as a timeout. The
				// deadline timer above normally fires first; this is the case where it did not.
				else if (poll.status === "interrupted") abort.abort(BASH_JOB_DEADLINE_ABORT_REASON);
			})
			.catch((error: unknown) => console.warn("Bash job poll failed", { invocationId: row._id, error }))
			.finally(() => {
				polling = false;
			});
	}, BASH_JOB_POLL_MS);
	let commandNumber = 0;
	try {
		// The same mount visibility as the launching call: without these queries `/.mounts` and
		// `/.plugins` would be empty inside a job.
		const [githubMounts, pluginSourceMounts] = await Promise.all([
			ctx.runQuery(internal.github_mounts.list_mounts, {}) as Promise<Doc<"github_mounts">[]>,
			ctx.runQuery(internal.plugins.list_bash_source_mounts, {
				organizationId: row.organizationId,
				workspaceId: row.workspaceId,
			}) as Promise<plugins_list_bash_source_mounts_Result>,
		]);

		const bashFs = await bash_fs_create({
			ctx,
			organizationId: row.organizationId,
			workspaceId: row.workspaceId,
			organizationName,
			workspaceName,
			userId: row.userId,
			threadId: row.threadId,
			persistedCwd: job.startCwd,
			persistedCwdTarget: job.startCwdTarget,
			allowDbFilesMkdir: job.allowDbFilesMkdir,
			githubMounts,
			pluginSourceMounts,
			transferContext: {
				invocationId: row._id,
				membershipId: row.membershipId,
				deadlineAt: row.transferDeadlineAt,
				signal: abort.signal,
				abort: (reason) => abort.abort(reason),
				nextCommandNumber: () => commandNumber++,
				jobId: row._id,
			},
			jobContext: {
				invocationId: row._id,
				organizationId: row.organizationId,
				workspaceId: row.workspaceId,
				threadId: row.threadId,
				userId: row.userId,
				membershipId: row.membershipId,
				shellId: job.shellId,
				shellName,
				allowDbFilesMkdir: job.allowDbFilesMkdir,
				deadlineAt: row.transferDeadlineAt,
				signal: abort.signal,
				nextCommandNumber: () => commandNumber++,
				launchedJobNumbers: [],
				launchAttempts: 0,
				readBudgetRemaining: bash_JOB_OUTPUT_READ_BUDGET_BYTES,
			},
			shells,
			restoreState: job.shellState,
			executionLimitsOverride: { maxCommandCount: BASH_JOB_MAX_COMMAND_COUNT },
		});

		const { result, observedPaths, observedPathsTruncated, nextCwd } = await run_command_and_diagnose({
			bashFs,
			command: job.script,
			abort,
			threadId: row.threadId,
		});

		// `/tmp` is a private copy inside a job and is never written back. Name what was dropped.
		const droppedTmpPaths = [...bashFs.tmp_dirty_roots()].sort();
		if (droppedTmpPaths.length > 0) {
			result.stderr += `bash: /tmp writes are dropped when a job ends: ${droppedTmpPaths.map((path) => `${bash_TMP_MOUNT}${path}`).join(", ")}\n`;
		}

		const response = bash_response({ bashFs, command: job.script, result, nextCwd, observedPaths, observedPathsTruncated });
		await ctx.runMutation(internal.ai_chat_files.finish_bash_job, { invocationId: row._id, result: response });
		console.debug("Bash job completed", {
			threadId: row.threadId,
			shellName,
			jobNumber: job.jobNumber,
			exitCode: result.exitCode,
			stdoutLength: response.metadata.stdoutLength,
			stderrLength: response.metadata.stderrLength,
		});
		return null;
	} finally {
		clearTimeout(deadlineTimer);
		clearInterval(pollTimer);
	}
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
