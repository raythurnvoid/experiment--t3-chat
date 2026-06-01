"use node";

import { v } from "convex/values";
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
import mri from "mri";
import { z } from "zod";
import { internal } from "./_generated/api.js";
import { internalAction, type ActionCtx } from "./_generated/server.js";
import type { Doc, Id } from "./_generated/dataModel";
import type { ai_chat_get_thread_state_Result } from "./ai_chat.ts";
import type {
	files_nodes_create_folder_node_by_path_Result,
	files_nodes_get_by_path_Result,
	files_nodes_get_file_last_available_markdown_content_by_path_Result,
	files_nodes_list_files_Result,
	files_nodes_text_search_files_Result,
} from "./files_nodes.ts";
import { files_chunk_BITMASK_FLAGS, files_chunk_has_bitmask_flag } from "../server/files-markdown-chunking-mastra.ts";

const HOME = "/home/cloud-usr";
const MOUNT_ROOT = `${HOME}/w`;
const TMP_MOUNT = "/tmp";
const DEFAULT_CWD = "~";
/**
 * Keep the shell path index deliberately small so `ls`, glob expansion, and
 * wide traversal prove truncation behavior instead of hiding DB-heavy reads.
 */
const PATH_INDEX_LIMIT = 20;
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
	pathIndexLimit: number;
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
 * Return the entry name shown by `readdir`.
 *
 * Examples:
 * - parent `/`, child `/docs/readme.md` -> `docs`
 * - parent `/docs`, child `/docs/readme.md` -> `readme.md`
 */
function directory_child_name(parentPath: string, childPath: string) {
	const normalizedParent = normalize_path(parentPath);
	const normalizedChild = normalize_path(childPath);
	if (normalizedParent === "/") {
		return normalizedChild.split("/").filter(Boolean)[0] ?? "";
	}
	return normalizedChild.slice(normalizedParent.length + 1).split("/")[0] ?? "";
}

/**
 * Build a read-only filesystem error for a bash-visible path.
 */
function readonly_error(path: string) {
	return new Error(`EROFS: read-only file system, '${normalize_path(path)}'`);
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

function search_command_parse_args(args: string[]) {
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
			const parsed = search_command_parse_args(args);
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

/**
 * Mount the app file tree into Just Bash as a mostly read-only filesystem.
 */
class WorkspaceFs implements IFileSystem {
	readonly ctx: ActionCtx;
	readonly ctxData: WorkspaceFsOptions["ctxData"];
	readonly pathIndexLimit: number;
	readonly appFilesMountPath: string;
	readonly allowAppFileTreeMkdir: boolean;
	pathIndexTruncated = false;
	directoryListingTruncated = false;
	private entryCache = new Map<string, JustBashFileNodeCacheEntry>();
	private contentCache = new Map<string, string>();

	constructor(options: WorkspaceFsOptions) {
		this.ctx = options.ctx;
		this.ctxData = options.ctxData;
		this.pathIndexLimit = options.pathIndexLimit;
		this.appFilesMountPath = options.appFilesMountPath;
		this.allowAppFileTreeMkdir = options.allowAppFileTreeMkdir;
		this.rememberEntry({
			path: "/",
			kind: "folder",
			updatedAt: 0,
		});
	}

	async prewarmPathIndex() {
		const list = (await this.ctx.runQuery(internal.files_nodes.list_files, {
			workspaceId: this.ctxData.workspaceId,
			projectId: this.ctxData.projectId,
			path: "/",
			maxDepth: 10,
			limit: this.pathIndexLimit,
		})) as files_nodes_list_files_Result;

		this.pathIndexTruncated = list.truncated;
		for (const item of list.items) {
			this.rememberEntry(item);
		}
	}

	async readFile(path: string, _options?: Parameters<IFileSystem["readFile"]>[1]) {
		const normalizedPath = normalize_path(path);
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
				const shellPath = app_path_to_shell_path(this.appFilesMountPath, normalizedPath);
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
				const lastSlashIndex = normalizedPath.lastIndexOf("/");
				const lastDotIndex = normalizedPath.lastIndexOf(".");
				const appPathWithoutExtension =
					lastDotIndex > lastSlashIndex ? normalizedPath.slice(0, lastDotIndex) : normalizedPath;
				const relatedReadablePaths = Array.from(
					new Set([
						app_path_to_shell_path(this.appFilesMountPath, `${normalizedPath}.md`),
						app_path_to_shell_path(this.appFilesMountPath, `${appPathWithoutExtension}.md`),
						app_path_to_shell_path(this.appFilesMountPath, `${appPathWithoutExtension}.txt`),
					]),
				).filter((path) => path !== shellPath);
				return [
					`Cannot read '${shellPath}' through bash because its content type is '${contentType ?? "unknown"}'.`,
					"Bash can currently read Markdown and plain text files only.",
					`Try listing the folder for a related readable file, such as ${relatedReadablePaths
						.map((path) => `'${path}'`)
						.join(", ")}, then read the one that exists.`,
					"",
				].join("\n");
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

	async readdir(path: string) {
		const normalizedPath = normalize_path(path);
		const stat = await this.stat(normalizedPath);
		if (!stat.isDirectory) {
			throw new Error(
				`ENOTDIR: not a directory, scandir '${app_path_to_shell_path(this.appFilesMountPath, normalizedPath)}'`,
			);
		}

		const list = (await this.ctx.runQuery(internal.files_nodes.list_files, {
			workspaceId: this.ctxData.workspaceId,
			projectId: this.ctxData.projectId,
			path: normalizedPath,
			maxDepth: 0,
			limit: this.pathIndexLimit,
		})) as files_nodes_list_files_Result;
		this.pathIndexTruncated = this.pathIndexTruncated || list.truncated;
		this.directoryListingTruncated = this.directoryListingTruncated || list.truncated;

		const names = new Set<string>();
		for (const item of list.items) {
			this.rememberEntry(item);
			const name = directory_child_name(normalizedPath, item.path);
			if (name) {
				names.add(name);
			}
		}

		return Array.from(names).sort();
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
		// Just Bash asks for glob candidates synchronously, so keep this bounded to the prewarmed
		// file-node cache. Keep wide directory traversal capped too; narrow the path for listing
		// and use the custom `search` command when content-search completeness matters.
		return Array.from(this.entryCache.keys()).sort();
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

function create_grep_command() {
	return defineCommand("grep", async (args) => {
		const suggestedQuery = args.find((arg) => arg.trim() && !arg.startsWith("-") && !arg.startsWith("/"));
		const suggestedCommand = suggestedQuery ? `search --limit 20 ${suggestedQuery}` : "search --limit 20 <query>";
		return {
			stdout:
				[
					"grep is available only as a compatibility hint in this app file shell.",
					"Use the indexed search command for app file content search:",
					`  ${suggestedCommand}`,
					"The search command uses the Convex text index and returns matching file paths with snippets.",
				].join("\n") + "\n",
			stderr: "",
			exitCode: 0,
		};
	});
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
		pathIndexLimit: PATH_INDEX_LIMIT,
		appFilesMountPath,
		allowAppFileTreeMkdir: args.allowAppFileTreeMkdir,
	});
	await workspaceFs.prewarmPathIndex();

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
		customCommands: [search_command_create(ctx, workspaceFs.ctxData, appFilesMountPath), create_grep_command()],
		executionLimits: {
			maxCommandCount: 200,
			maxLoopIterations: 10_000,
			maxCallDepth: 50,
			maxOutputSize: 250_000,
			maxHeredocSize: 250_000,
		},
	});

	const result = await bash
		.exec(args.command, {
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
	if (workspaceFs.directoryListingTruncated) {
		// Surface the DB read cap in stderr so both the model and the UI know an `ls`/`find`
		// style result is incomplete instead of treating the first page as a full listing.
		stderr += `bash: directory listing truncated after ${PATH_INDEX_LIMIT} entries; output is incomplete.\n`;
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
			const workspaceItems: Array<{
				path: string;
				kind: "folder" | "file";
				updatedAt: number;
				depthTruncated: boolean;
				contentType?: string;
			}> = [...workspaceItemsInitial];
			const runQueryImpl = async (_ref: unknown, queryArgs: Record<string, unknown>) => {
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
				if (path === "/docs") return workspaceItems[0];
				if (path === "/docs/readme.md") return workspaceItems[1];
				if (path === "/source.pdf") return workspaceItems[2];
				if (path === "/uploaded.md") return workspaceItems[3];
				if (path === "/reports/summary.md") return workspaceItems[4];
				return null;
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

		test("uses the aggressive path index limit for prewarm and directory reads", async () => {
			const { run, runQuery } = createBashRunner();

			await run(`ls ${test_app_files_mount}/docs`);

			const listCalls = runQuery.mock.calls
				.map((call) => call[1])
				.filter((args) => args && typeof args === "object" && "maxDepth" in args);
			expect(listCalls).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ path: "/", maxDepth: 10, limit: 20 }),
					expect.objectContaining({ path: "/docs", maxDepth: 0, limit: 20 }),
				]),
			);
		});

		test("uses synthetic parent directories from prewarmed descendants", async () => {
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
			expect(reportsLookupCalls).toHaveLength(0);
		});

		test("warns when a directory listing reaches the path index limit", async () => {
			const { run } = createBashRunner({ listTruncated: true });

			const result = await run(`ls ${test_app_files_mount}/docs`);

			expect(result.metadata.exitCode).toBe(0);
			expect(result.metadata.pathIndexTruncated).toBe(true);
			expect(result.stderr).toContain("directory listing truncated after 20 entries");
			expect(result.stderr).toContain("output is incomplete");
			expect(result.output).toContain(`/home/cloud-usr$ ls ${test_app_files_mount}/docs`);
			expect(result.output).toContain("directory listing truncated after 20 entries");
			expect(result.output).not.toContain("<stderr>");
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
				.find((line) => line.startsWith("Try listing the folder for a related readable file"));

			expect(result.metadata.exitCode).toBe(0);
			expect(suggestionLine).toBeDefined();
			expect(suggestionLine).not.toContain(`'${test_app_files_mount}/uploaded.md'`);
			expect(suggestionLine).toContain(`'${test_app_files_mount}/uploaded.md.md'`);
			expect(suggestionLine).toContain(`'${test_app_files_mount}/uploaded.txt'`);
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

			expect(result.metadata.exitCode).toBe(0);
			expect(result.stderr).toBe("");
			expect(result.stdout).toContain("grep is available only as a compatibility hint");
			expect(result.stdout).toContain("search --limit 20 unique-token");
			expect(result.stdout).toContain("Convex text index");
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

		test("reports stdout truncation and path-index truncation", async () => {
			const { run } = createBashRunner({ listTruncated: true });

			const result = await run("seq 1 40000");

			expect(result.metadata.stdoutTruncated).toBe(true);
			expect(result.metadata.stdoutLength).toBeGreaterThan(30_000);
			expect(result.metadata.pathIndexTruncated).toBe(true);
			expect(result.stdout).toContain("[truncated after 30000 characters]");
		});
	});
}
