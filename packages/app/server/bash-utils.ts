// Shared Bash utilities used by `bash.ts` and extracted command modules.
// `bash.ts` owns command registration and the action lifecycle. This file owns
// path conversion, the Convex app-file mount, pagination cursors, Native Just
// Bash delegation, and common stderr text.

import {
	Bash,
	getCommandNames,
	type CommandContext,
	type CommandName,
	type CpOptions,
	type FileContent,
	type FsStat,
	type IFileSystem,
	type MkdirOptions,
	type RmOptions,
} from "just-bash/browser";
import { internal } from "../convex/_generated/api.js";
import type { Doc, Id } from "../convex/_generated/dataModel";
import type { ActionCtx } from "../convex/_generated/server.js";
import type {
	files_nodes_create_folder_node_by_path_Result,
	files_nodes_get_by_path_Result,
	files_nodes_get_file_last_available_markdown_content_by_path_Result,
	files_nodes_read_file_content_from_chunks_Result,
} from "../convex/files_nodes.ts";
import type { files_pending_updates_get_by_file_node_Result } from "../convex/files_pending_updates.ts";
import type { get_asset_by_id_Result } from "../convex/r2.ts";
import { Result } from "../shared/errors-as-values-utils.ts";
import { files_ROOT_ID, files_SYNTHETIC_ROOT_FOLDER, files_node_has_editable_yjs_state } from "../shared/files.ts";
import { LruCache, math_clamp, path_name_of } from "../shared/shared-utils.ts";

// #region bash constants and path helpers

export const bash_HOME = "/home/cloud-usr";
export const bash_APP_MOUNT_PATH = `${bash_HOME}/w`;
export const bash_TMP_MOUNT = "/tmp";
export const bash_DEV_NULL_PATH = "/dev/null";
export const bash_DEV_ZERO_PATH = "/dev/zero";
export const bash_DEV_ZERO_BYTE_COUNT = 8192;
export const bash_DEV_ZERO_TEXT = "\0".repeat(bash_DEV_ZERO_BYTE_COUNT);
export const bash_GLOB_METACHARACTER_REGEX = /[*?[\]]/u;

// Directory and search result listings should be useful by default without letting
// one command dump too many results into the transcript. Applies to both surface
// (dir children) and depth (subtree) listings.
export const bash_LISTING_DEFAULT_LIMIT = 10;
export const bash_LISTING_MAX_LIMIT = 20;

// Content readers (cat/head/tail/wc) fetch full file content from Convex per app-file
// operand, so bound how many a single command can pull. stat reuses this for metadata fan-out.
export const bash_READER_FILE_OPERAND_MAX = 10;

// A full inline read pulls the entire file content. Above this byte size, full-file readers
// fall back to BOUNDED reads (head/tail/sed line ranges, served from materialized chunks), so a
// large file is never loaded in one shot. DEV-PHASE AGGRESSIVE: intentionally tiny so our small
// test files page like big ones; the agent must be able to page through content at this cap.
// Raise before production. Tunable.
export const bash_READ_INLINE_MAX_BYTES = 2 * 1024;

// Per-page line cap for head/sed/tail against a large file (must match the backend
// files_READ_RANGE_MAX_LINES). DEV-PHASE AGGRESSIVE so pagination kicks in on small files.
export const bash_READ_HEAD_LARGE_FILE_MAX_LINES = 40;

const PAGINATION_CURSORS_CACHE_MAX_ENTRIES = 500;
const BACKSLASH_REGEX = /\\/g;
const SINGLE_QUOTE_REGEX = /'/g;
const SIGNED_INTEGER_REGEX = /^-?\d+$/u;
const SIMPLE_EXTENSION_GLOB_REGEX = /^\*\.([a-z0-9][a-z0-9_-]*)$/iu;
const SEARCH_EXACT_SINGLE_TOKEN_REGEX = /^\S+$/u;
const SEARCH_EXACT_PUNCTUATION_TOKEN_REGEX = /[-_.:@]/u;
const SHELL_ARG_SAFE_UNQUOTED_REGEX = /^[A-Za-z0-9_/:.,=+@-]+$/;
const COMMAND_LOOKUP_PATH_REGEX = /^\/(?:usr\/)?bin\/([^/]+)$/u;
const COMMAND_EXIT_FAILURE = 1;
const LISTING_PAGE_LIMIT_MAX = 200;
const BASH_REGEX_PATTERN_MAX_LENGTH = 200;
const textEncoder = new TextEncoder();

const DISABLED_NATIVE_JUST_BASH_COMMANDS = new Set<string>(["file"]);
export const bash_ALLOWED_COMMANDS = getCommandNames().filter(
	(command): command is CommandName => !DISABLED_NATIVE_JUST_BASH_COMMANDS.has(command),
);
const ALLOWED_COMMAND_NAMES = new Set<string>(bash_ALLOWED_COMMANDS);
/**
 * In-memory LRU cache for stored pagination cursors. `value_store` remains the
 * durable fallback when this per-runtime cache is empty.
 */
const pagination_cursors_cache = new LruCache<string, string>(PAGINATION_CURSORS_CACHE_MAX_ENTRIES);

/**
 * Return one clean absolute path for bash, app files, and cache keys.
 */
export function bash_normalize_path(path: string) {
	const parts: string[] = [];
	const normalizedInput = path.replace(BACKSLASH_REGEX, "/");
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
export function bash_resolve_path(base: string, path: string) {
	return bash_normalize_path(path.startsWith("/") ? path : `${base}/${path}`);
}

/**
 * Convert a Convex app file node path to its Bash path inside currentProjectPath.
 */
export function bash_app_file_node_path_to_current_project_path(currentProjectPath: string, path: string) {
	const normalizedPath = bash_normalize_path(path);
	return normalizedPath === "/" ? currentProjectPath : `${currentProjectPath}${normalizedPath}`;
}

/**
 * Convert a normalized Bash path under currentProjectPath back to a Convex app file node path.
 *
 * Returns `null` for Bash paths outside currentProjectPath, like `/tmp/foo`.
 */
export function bash_current_project_path_to_app_file_node_path(currentProjectPath: string, path: string) {
	if (path === currentProjectPath) {
		return "/";
	}
	if (path.startsWith(`${currentProjectPath}/`)) {
		return path.slice(currentProjectPath.length);
	}
	return null;
}

/**
 * Check whether a normalized path is inside currentProjectPath.
 */
export function bash_is_path_under_current_project_path(currentProjectPath: string, path: string) {
	return path === currentProjectPath || path.startsWith(`${currentProjectPath}/`);
}

export function bash_clamp_listing_page_limit(limit: number) {
	const finiteLimit = Number.isFinite(limit) ? Math.trunc(limit) : LISTING_PAGE_LIMIT_MAX;
	return math_clamp(finiteLimit, 1, LISTING_PAGE_LIMIT_MAX);
}

export function bash_regex_validation_error(command: string, pattern: string) {
	if (pattern.length > BASH_REGEX_PATTERN_MAX_LENGTH) {
		return `${command}: regex pattern is too long; max ${BASH_REGEX_PATTERN_MAX_LENGTH} characters\n`;
	}
	try {
		new RegExp(pattern, "u");
		return null;
	} catch (error) {
		return `${command}: invalid regex: ${error instanceof Error ? error.message : String(error)}\n`;
	}
}

// #endregion bash constants and path helpers

// #region app file filesystem

/**
 * Keep the Just Bash path cache to the file-node fields the virtual filesystem needs.
 *
 * Some entries come from Convex `files_nodes` docs, others are synthetic parent
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

export type bash_WorkspaceFsOptions = {
	ctx: ActionCtx;
	ctxData: {
		workspaceId: Id<"workspaces">;
		projectId: Id<"workspaces_projects">;
		workspaceName: string;
		projectName: string;
		userId: Id<"users">;
	};
	currentProjectPath: string;
	allowAppFileTreeMkdir: boolean;
};

/**
 * Means the app file exists, but bash cannot read its body as text.
 *
 * Keep the path and content type so command handlers can print a useful message.
 */
export class bash_AppFileContentUnavailableError extends Error {
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
		const normalizedPath = bash_normalize_path(path);
		super(
			`EROFS: read-only file system, '${normalizedPath}'. Persistent app writes must use write_file/edit_file; shell redirects into app files are unsupported.`,
		);
		this.name = "ReadOnlyFileSystemError";
		this.path = normalizedPath;
	}
}

/**
 * Mount the app file tree into Just Bash as a mostly read-only filesystem.
 *
 * `MountableFs` strips `currentProjectPath` before calls reach this class, so
 * methods here receive Convex app file node paths like `/docs/readme.md`, not
 * shell paths like `/home/cloud-usr/w/.../docs/readme.md`.
 */
export class bash_WorkspaceFs implements IFileSystem {
	readonly ctx: ActionCtx;
	readonly ctxData: bash_WorkspaceFsOptions["ctxData"];
	readonly currentProjectPath: string;
	readonly allowAppFileTreeMkdir: boolean;
	pathIndexTruncated = false;
	private entryCache = new Map<string, JustBashFileNodeCacheEntry>();
	private contentCache = new Map<string, string>();

	constructor(options: bash_WorkspaceFsOptions) {
		this.ctx = options.ctx;
		this.ctxData = options.ctxData;
		this.currentProjectPath = options.currentProjectPath;
		this.allowAppFileTreeMkdir = options.allowAppFileTreeMkdir;
		this.rememberEntry(files_SYNTHETIC_ROOT_FOLDER);
	}

	async readFile(path: string, _options?: Parameters<IFileSystem["readFile"]>[1]) {
		const normalizedPath = bash_normalize_path(path);
		if (bash_GLOB_METACHARACTER_REGEX.test(normalizedPath)) {
			throw new Error(
				`app file glob patterns are not supported: '${bash_app_file_node_path_to_current_project_path(this.currentProjectPath, normalizedPath)}'`,
			);
		}
		const cached = this.contentCache.get(normalizedPath);
		if (cached != null) {
			return cached;
		}

		// Most file reads can now use materialized or pending chunks. Try that
		// cheap query path first and keep the older action fallback for callers
		// that still need last-available reconstruction behavior.
		const chunkRead = (await this.ctx.runQuery(internal.files_nodes.read_file_content_from_chunks, {
			workspaceId: this.ctxData.workspaceId,
			projectId: this.ctxData.projectId,
			userId: this.ctxData.userId,
			path: normalizedPath,
			mode: {
				kind: "full",
				maxBytes: bash_READ_INLINE_MAX_BYTES,
			},
		})) as files_nodes_read_file_content_from_chunks_Result;
		if (chunkRead) {
			this.contentCache.set(normalizedPath, chunkRead.content);
			return chunkRead.content;
		}

		// The action fallback reconstructs last-available content; the parallel
		// file-node lookup preserves precise missing/folder/unreadable errors.
		const fileContentPromise = this.ctx.runAction(
			internal.files_nodes.get_file_last_available_markdown_content_by_path,
			{
				workspaceId: this.ctxData.workspaceId,
				projectId: this.ctxData.projectId,
				userId: this.ctxData.userId,
				path: normalizedPath,
			},
		) as Promise<files_nodes_get_file_last_available_markdown_content_by_path_Result>;
		const fileNodePromise: Promise<files_nodes_get_by_path_Result> =
			normalizedPath === "/"
				? Promise.resolve(null)
				: (this.ctx.runQuery(internal.files_nodes.get_by_path, {
						workspaceId: this.ctxData.workspaceId,
						projectId: this.ctxData.projectId,
						path: normalizedPath,
					}) as Promise<files_nodes_get_by_path_Result>);
		const [fileContent, fileNode] = await Promise.all([fileContentPromise, fileNodePromise]);

		if (!fileContent) {
			const cacheEntry = normalizedPath === "/" ? files_SYNTHETIC_ROOT_FOLDER : fileNode;
			if (cacheEntry?.kind === "file") {
				this.rememberEntry(cacheEntry);
				throw new bash_AppFileContentUnavailableError({
					shellPath: bash_app_file_node_path_to_current_project_path(this.currentProjectPath, normalizedPath),
					contentType: cacheEntry.contentType,
				});
			}
			if (cacheEntry?.kind === "folder") {
				this.rememberEntry(cacheEntry);
				throw new Error(
					`EISDIR: illegal operation on a directory, read '${bash_app_file_node_path_to_current_project_path(this.currentProjectPath, normalizedPath)}'`,
				);
			}
			throw new Error(
				`ENOENT: no such file or directory, open '${bash_app_file_node_path_to_current_project_path(this.currentProjectPath, normalizedPath)}'`,
			);
		}

		this.contentCache.set(normalizedPath, fileContent.content);
		if (fileNode?.kind === "file") {
			this.rememberEntry(fileNode);
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
		throw new ReadOnlyFileSystemError(bash_app_file_node_path_to_current_project_path(this.currentProjectPath, path));
	}

	async appendFile(path: string, _content: FileContent, _options?: Parameters<IFileSystem["appendFile"]>[2]) {
		throw new ReadOnlyFileSystemError(bash_app_file_node_path_to_current_project_path(this.currentProjectPath, path));
	}

	async exists(path: string) {
		return (await this.getEntry(path)) != null;
	}

	async stat(path: string): Promise<FsStat> {
		const normalizedPath = bash_normalize_path(path);
		if (bash_GLOB_METACHARACTER_REGEX.test(normalizedPath)) {
			throw new Error(
				`app file glob patterns are not supported: '${bash_app_file_node_path_to_current_project_path(this.currentProjectPath, normalizedPath)}'`,
			);
		}
		const cacheEntry = await this.getEntry(normalizedPath);
		if (!cacheEntry) {
			throw new Error(
				`ENOENT: no such file or directory, stat '${bash_app_file_node_path_to_current_project_path(this.currentProjectPath, normalizedPath)}'`,
			);
		}

		const content = this.contentCache.get(normalizedPath);
		return {
			isFile: cacheEntry.kind === "file",
			isDirectory: cacheEntry.kind === "folder",
			isSymbolicLink: false,
			mode: cacheEntry.kind === "file" ? 0o644 : 0o755,
			size: content == null ? 0 : textEncoder.encode(content).byteLength,
			mtime: new Date(cacheEntry.updatedAt),
		};
	}

	async mkdir(path: string, options?: MkdirOptions) {
		const normalizedPath = bash_normalize_path(path);
		if (bash_GLOB_METACHARACTER_REGEX.test(normalizedPath)) {
			throw new Error(
				`app file glob patterns are not supported: '${bash_app_file_node_path_to_current_project_path(this.currentProjectPath, normalizedPath)}'`,
			);
		}
		const existing = await this.getEntry(normalizedPath);
		if (existing) {
			if (options?.recursive && existing.kind === "folder") {
				return;
			}
			throw new Error(
				`EEXIST: file already exists, mkdir '${bash_app_file_node_path_to_current_project_path(this.currentProjectPath, normalizedPath)}'`,
			);
		}
		if (!this.allowAppFileTreeMkdir) {
			throw new Error(
				"Creating folders in the app file tree is available in Agent mode. Scratch space does not create durable folders.",
			);
		}
		if (!options?.recursive) {
			const parentPath = bash_normalize_path(`${normalizedPath}/..`);
			const parent = await this.getEntry(parentPath);
			if (!parent || parent.kind !== "folder") {
				throw new Error(
					`ENOENT: no such file or directory, mkdir '${bash_app_file_node_path_to_current_project_path(this.currentProjectPath, normalizedPath)}'`,
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
		const normalizedPath = bash_normalize_path(path);
		const stat = await this.stat(normalizedPath);
		if (!stat.isDirectory) {
			throw new Error(
				`ENOTDIR: not a directory, scandir '${bash_app_file_node_path_to_current_project_path(this.currentProjectPath, normalizedPath)}'`,
			);
		}
		throw new Error("app file directory enumeration is not supported; use ls --limit N or find --limit N");
	}

	async rm(path: string, options?: RmOptions) {
		if (options?.force && !(await this.exists(path))) {
			return;
		}
		throw new ReadOnlyFileSystemError(bash_app_file_node_path_to_current_project_path(this.currentProjectPath, path));
	}

	async cp(_src: string, dest: string, _options?: CpOptions) {
		throw new ReadOnlyFileSystemError(bash_app_file_node_path_to_current_project_path(this.currentProjectPath, dest));
	}

	async mv(_src: string, dest: string) {
		throw new ReadOnlyFileSystemError(bash_app_file_node_path_to_current_project_path(this.currentProjectPath, dest));
	}

	resolvePath(base: string, path: string) {
		return bash_resolve_path(base, path);
	}

	getAllPaths() {
		// Just Bash asks for glob candidates synchronously. Do not expose cached
		// app file paths here, or shell glob expansion could look successful while
		// bypassing Convex pagination and returning an incomplete path set.
		return ["/"];
	}

	async chmod(path: string, _mode: number) {
		throw new ReadOnlyFileSystemError(bash_app_file_node_path_to_current_project_path(this.currentProjectPath, path));
	}

	async symlink(_target: string, linkPath: string) {
		throw new ReadOnlyFileSystemError(
			bash_app_file_node_path_to_current_project_path(this.currentProjectPath, linkPath),
		);
	}

	async link(_existingPath: string, newPath: string) {
		throw new ReadOnlyFileSystemError(
			bash_app_file_node_path_to_current_project_path(this.currentProjectPath, newPath),
		);
	}

	async readlink(path: string): Promise<string> {
		throw new Error(
			`EINVAL: invalid argument, readlink '${bash_app_file_node_path_to_current_project_path(this.currentProjectPath, path)}'`,
		);
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
		throw new ReadOnlyFileSystemError(bash_app_file_node_path_to_current_project_path(this.currentProjectPath, path));
	}

	rememberEntry(cacheEntry: JustBashFileNodeCacheEntry) {
		const normalizedPath = bash_normalize_path(cacheEntry.path);
		const segments = normalizedPath.split("/").filter(Boolean);
		let currentPath = "";
		for (let index = 0; index < segments.length - 1; index++) {
			currentPath = `${currentPath}/${segments[index]}`;
			if (!this.entryCache.has(currentPath)) {
				this.entryCache.set(currentPath, {
					path: currentPath,
					name: segments[index],
					kind: "folder",
					updatedAt: cacheEntry.updatedAt,
				});
			}
		}
		this.entryCache.set(normalizedPath, {
			...cacheEntry,
			path: normalizedPath,
		});
	}

	async getEntry(path: string) {
		const normalizedPath = bash_normalize_path(path);
		const cached = this.entryCache.get(normalizedPath);
		// Synthetic parent folders make descendant paths navigable. Except for the
		// synthetic root, only entries with `_id` prove that an app path exists in Convex.
		if (cached && (normalizedPath === "/" || cached._id != null)) {
			return cached;
		}

		const fileNode = (await this.ctx.runQuery(internal.files_nodes.get_by_path, {
			workspaceId: this.ctxData.workspaceId,
			projectId: this.ctxData.projectId,
			path: normalizedPath,
		})) as files_nodes_get_by_path_Result;

		if (!fileNode) {
			return null;
		}

		const cacheEntry = {
			_id: fileNode._id,
			path: fileNode.path,
			name: fileNode.name,
			kind: fileNode.kind,
			updatedAt: fileNode.updatedAt,
			updatedBy: fileNode.updatedBy,
			contentType: fileNode.contentType,
		} satisfies JustBashFileNodeCacheEntry;
		this.rememberEntry(cacheEntry);
		return cacheEntry;
	}
}

// #endregion app file filesystem

// #region shared command helpers

/**
 * Extract `cp`/`mv` path operands for app-path routing.
 *
 * This is intentionally smaller than a full parser: it tracks recursive flags
 * including short clusters and `--`, then preserves every following token as a
 * path operand so dash-leading app file names cannot bypass the app-mutation guards.
 */
export function bash_parse_cp_mv_operands(args: string[]) {
	const operands: string[] = [];
	let recursive = false;
	let optionsEnded = false;

	for (const arg of args) {
		if (optionsEnded) {
			operands.push(arg);
			continue;
		}
		if (arg === "--") {
			optionsEnded = true;
			continue;
		}
		if (arg === "-r" || arg === "-R" || arg === "--recursive") {
			recursive = true;
			continue;
		}
		if (arg.startsWith("-")) {
			if (!arg.startsWith("--") && [...arg.slice(1)].some((flag) => flag === "r" || flag === "R")) {
				recursive = true;
			}
			continue;
		}
		operands.push(arg);
	}
	return { operands, recursive };
}

/**
 * Quote one shell argument for command hints printed back to the model.
 *
 * Plain path-like tokens stay readable. Anything else is single-quoted, with
 * embedded single quotes escaped using the normal shell `'\''` pattern.
 */
export function bash_shell_arg_quote(arg: string) {
	return SHELL_ARG_SAFE_UNQUOTED_REGEX.test(arg) ? arg : `'${arg.replace(SINGLE_QUOTE_REGEX, `'\\''`)}'`;
}

/**
 * Build the copied `Next page:` command for search-backed output.
 *
 * `search`, recursive `grep`, and `textgrep` all page through the same Convex
 * text-search cursor, so continuation output always points back to `search`.
 */
export function bash_search_command_build_continuation(args: {
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
			bash_shell_arg_quote(bash_app_file_node_path_to_current_project_path(args.currentProjectPath, args.path)),
		);
	}
	continuationParts.push(
		"--limit",
		String(args.limit),
		"--cursor",
		bash_shell_arg_quote(args.cursor),
		bash_shell_arg_quote(args.query),
	);
	return continuationParts.join(" ");
}

export function bash_search_command_exact_query_filter(query: string) {
	const trimmedQuery = query.trim();
	// Punctuation-heavy single tokens often get broadened by full-text search.
	// Track the literal form so each hit can say whether the exact token is present.
	return SEARCH_EXACT_SINGLE_TOKEN_REGEX.test(trimmedQuery) && SEARCH_EXACT_PUNCTUATION_TOKEN_REGEX.test(trimmedQuery)
		? trimmedQuery.toLowerCase()
		: null;
}

// Broad word-level hits stay in the page (suppressing them thins pagination); a per-hit
// note marks whether the shown chunk contains the literal query, so fuzzy full-text
// matches are not relayed as exact ones.
export function bash_search_command_exact_query_note(
	exactQueryFilter: string | null,
	query: string,
	markdownChunk: string,
) {
	if (exactQueryFilter == null) {
		return "";
	}
	return markdownChunk.toLowerCase().includes(exactQueryFilter)
		? ` [contains exact '${query}']`
		: ` [word-level match; chunk does not contain '${query}']`;
}

// Pre-counted exact/word-level split for the "Found N results" header: the model relays
// counts, so hand it the grounded ones instead of letting it count annotated blocks itself.
export function bash_search_command_exact_query_summary(exactQueryFilter: string | null, markdownChunks: string[]) {
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

/**
 * Read the simple glob form that can become an indexed extension search.
 *
 * Accepts `*.md` and `/some/path/*.md`.
 *
 * Returns `null` for anything more complex.
 */
export function bash_parse_simple_extension_glob(pattern: string) {
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
	if (path != null && bash_GLOB_METACHARACTER_REGEX.test(path)) {
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
export function bash_create_glob_syntax_unsupported_message(command: string, path: string) {
	const simpleExtensionGlob = bash_parse_simple_extension_glob(path);
	if (simpleExtensionGlob) {
		const target = simpleExtensionGlob.path ?? ".";
		return (
			`${command}: app file glob patterns are not supported: ${path}\n` +
			`Try: find ${bash_shell_arg_quote(target)} -type f --extension ${bash_shell_arg_quote(simpleExtensionGlob.extension)} --limit 20\n`
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
 * Format non-content Bash diagnostics as a readable stderr block.
 *
 * Each line gets the command prefix so multi-line hints stay clear in the
 * transcript and never look like file content from stdout.
 */
export function bash_format_multiline_hint(command: string, lines: string[]) {
	return lines.length === 0 ? "" : `${lines.map((line) => `${command}: ${line}`).join("\n")}\n`;
}

/**
 * Read the argv value that follows an option like `--limit 10`.
 *
 * Callers own incrementing their loop index after a successful read.
 */
export function bash_read_option_value(command: string, args: string[], index: number, option: string) {
	const value = args[index + 1];
	if (value == null) {
		return Result({ _nay: { message: `${command}: ${option} requires a value` } });
	}
	return Result({ _yay: { value } });
}

/**
 * Parse a positive pagination limit, applying the command default and max clamp.
 */
export function bash_parse_limit(command: string, value: string | undefined, defaultLimit: number, maxLimit: number) {
	const rawValue = value ?? String(defaultLimit);
	if (!SIGNED_INTEGER_REGEX.test(rawValue.trim())) {
		return Result({ _nay: { message: `${command}: --limit must be an integer` } });
	}
	return Result({ _yay: Math.max(1, Math.min(maxLimit, Number(rawValue))) });
}

/**
 * Persist a raw pagination cursor and return the stored cursor id printed
 * in command output.
 *
 * Raw Convex cursors are extremely long and hard for the AI to copy back into
 * shell commands reliably, so bash output exposes only this value_store id.
 */
export async function bash_cursor_id_create(ctx: ActionCtx, cursor: string) {
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
export async function bash_cursor_id_resolve(ctx: ActionCtx, cursor: string) {
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

// #endregion shared command helpers

// #region builtin command delegation

/**
 * Builds argv for delegating part of an app-aware command to the original built-in.
 *
 * App-file pagination options and original operands are removed. The caller
 * passes only the built-in operands that should remain, usually the original
 * operand text so delegated output keeps normal shell path formatting.
 */
export function bash_command_build_builtin_delegation_args(
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
 * Custom app-aware commands registered by the outer shell intentionally shadow
 * several built-ins. Calling `ctx.exec(...)` from those overrides would resolve
 * back to the override and recurse, so this helper creates a clean nested shell
 * whose command registry contains only the requested built-in command.
 *
 * Examples: app-aware `ls`, `find`, `tree`, `cat`, `stat`, `touch`, `rm`,
 * `cp`, `mv`, and `tee` call this after their app-path checks pass.
 */
export async function bash_delegate_builtin_command(args: {
	command: CommandName;
	args: string[];
	commandCtx: CommandContext;
	cwd?: string;
}) {
	// Custom commands shadow built-ins, so delegate through a clean nested Bash
	// instance instead of ctx.exec, which would recurse into the calling override.
	const env = Object.fromEntries(args.commandCtx.env);
	const cwd = args.cwd ?? args.commandCtx.cwd;
	const inner = new Bash({
		fs: args.commandCtx.fs,
		cwd,
		env,
		commands: [args.command],
		executionLimits: args.commandCtx.limits,
	});
	return await inner.exec([args.command, ...args.args.map(bash_shell_arg_quote)].join(" "), {
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
 * commands: `/`, `/dev`, `/dev/null`, `/dev/zero`, `/tmp`, or a descendant of `/tmp`.
 *
 * Synthetic command lookup paths are handled separately.
 */
function is_native_just_bash_tmp_path(path: string) {
	const normalizedPath = bash_normalize_path(path);
	return (
		normalizedPath === "/" ||
		normalizedPath === "/dev" ||
		normalizedPath === bash_DEV_NULL_PATH ||
		normalizedPath === bash_DEV_ZERO_PATH ||
		normalizedPath === bash_TMP_MOUNT ||
		normalizedPath.startsWith(`${bash_TMP_MOUNT}/`)
	);
}

/**
 * Returns whether a path is one of the synthetic command lookup directories
 * exposed to Native Just Bash: `/bin`, `/usr`, or `/usr/bin`.
 */
function is_native_just_bash_command_lookup_directory(path: string) {
	const normalizedPath = bash_normalize_path(path);
	return normalizedPath === "/bin" || normalizedPath === "/usr" || normalizedPath === "/usr/bin";
}

/**
 * Returns the allowed command name for synthetic executable paths such as
 * `/bin/sort` or `/usr/bin/sort`; returns `null` for non-command paths or
 * disabled Just Bash commands.
 */
function native_just_bash_command_lookup_name(path: string) {
	const normalizedPath = bash_normalize_path(path);
	const match = COMMAND_LOOKUP_PATH_REGEX.exec(normalizedPath);
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
		const resolvedPath = bash_resolve_path(ctx.cwd, arg);
		const isPathLike =
			arg === "." ||
			arg === ".." ||
			arg.startsWith("/") ||
			arg.startsWith("./") ||
			arg.startsWith("../") ||
			arg.includes("/");
		if (isPathLike && bash_is_path_under_current_project_path(currentProjectPath, resolvedPath)) {
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
		const resolvedPath = bash_resolve_path(ctx.cwd, arg);
		const isPathLike =
			arg === "." ||
			arg === ".." ||
			arg.startsWith("/") ||
			arg.startsWith("./") ||
			arg.startsWith("../") ||
			arg.includes("/");
		if (isPathLike && bash_is_path_under_current_project_path(currentProjectPath, resolvedPath)) {
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
		const resolvedPath = bash_resolve_path(ctx.cwd, arg);
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
		if (isPathLike && bash_is_path_under_current_project_path(currentProjectPath, resolvedPath)) {
			return resolvedPath;
		}
	}
	if (stderr.includes(currentProjectPath)) {
		return currentProjectPath;
	}
	const hasStdin = ctx.stdin != null && String(ctx.stdin).length > 0;
	if (!hasStdin && !hasExplicitScratchOperand && bash_is_path_under_current_project_path(currentProjectPath, ctx.cwd)) {
		return ctx.cwd;
	}
	return null;
}

/**
 * Run a Native Just Bash command through the `/tmp`-restricted filesystem view.
 *
 * This is used for Just Bash built-ins that have not been made app-file-aware:
 * they can process `/tmp` paths and stdin, but cannot directly operate on
 * Convex-backed paths under `currentProjectPath`. It keeps direct operands away
 * from the app tree, permits `/tmp`, `/dev/null`, `/dev/zero`, and synthetic command lookup
 * paths, and adds app-file guidance when the command likely failed because it
 * tried to touch the mounted project directly.
 *
 * Examples: `sort`, `uniq`, `cut`, `awk`, `sed`, `du`, `diff`, `rg`, `rev`,
 * `tac`, `nl`, `base64`, `jq`, and `sha256sum` run through this path.
 */
export async function bash_delegate_native_just_bash_tmp_command(
	command: CommandName,
	args: string[],
	ctx: CommandContext,
	currentProjectPath: string,
) {
	const env = Object.fromEntries(ctx.env);
	const cwd = is_native_just_bash_tmp_path(ctx.cwd) ? ctx.cwd : bash_TMP_MOUNT;
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
				? `du: app-mount paths do not expose POSIX disk usage. Try: stat ${bash_shell_arg_quote(directAppOperand)} && find ${bash_shell_arg_quote(directAppOperand)} -type f --limit 20\n`
				: "") +
			(directRgOperand != null
				? `rg: app paths do not support direct Native Just Bash rg. Try: grep ${bash_shell_arg_quote(directRgOperand.pattern)} ${bash_shell_arg_quote(directRgOperand.path)}\n`
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
		commands: [...bash_ALLOWED_COMMANDS],
		executionLimits: ctx.limits,
	});

	const result = await inner.exec([command, ...args.map(bash_shell_arg_quote)].join(" "), {
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

/**
 * Means a Native Just Bash /tmp command tried to access the Convex-backed app file tree.
 */
class NativeJustBashTmpCommandAccessError extends Error {
	constructor(currentProjectPath: string, path: string) {
		const normalizedPath = bash_normalize_path(path);
		const appFileNodePath =
			bash_current_project_path_to_app_file_node_path(currentProjectPath, normalizedPath) ?? normalizedPath;
		super(
			`Native Just Bash /tmp commands cannot access app files directly: '${normalizedPath}'.\n` +
				`The app file tree at '${currentProjectPath}' is Convex-backed, so Native Just Bash /tmp commands can use /tmp paths or stdin but not direct app-file operands.\n` +
				`For app path '${appFileNodePath}', use app-aware commands such as search, find, grep, cat, head, tail, wc, stat, or tree. To process one readable app file with Native Just Bash /tmp tools, pipe it through cat or copy it first: cp ${bash_shell_arg_quote(normalizedPath)} /tmp/<name>\n`,
		);
		this.name = "NativeJustBashTmpCommandAccessError";
	}
}

/**
 * Restricted filesystem view for Native Just Bash /tmp commands.
 *
 * This is not the `/tmp` storage implementation; `BashTmpFs` owns that. This
 * wrapper sits in front of the full mounted shell filesystem for nested Native Just Bash
 * commands, allows `/tmp`, `/dev/null`, `/dev/zero`, and command lookup paths, and rejects
 * direct access to the Convex-backed app file tree with a targeted error.
 *
 * Synthetic paths are entries this wrapper reports even though they are not
 * persisted in the mounted filesystem: `/bin`, `/usr`, `/usr/bin`, executable
 * command-name files under `/bin` and `/usr/bin`, plus `/dev`, `/dev/null`, and `/dev/zero`.
 * They exist only to satisfy Just Bash command lookup and null-device behavior.
 */
class RestrictedNativeJustBashTmpCommandFs implements IFileSystem {
	constructor(
		private readonly fs: IFileSystem,
		private readonly currentProjectPath: string,
		private readonly commandCwd: string,
	) {}

	async readFile(path: string, options?: Parameters<IFileSystem["readFile"]>[1]) {
		const normalizedPath = bash_normalize_path(path);
		if (!is_native_just_bash_tmp_path(normalizedPath)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentProjectPath, normalizedPath);
		}
		return await this.fs.readFile(normalizedPath, options);
	}

	async readFileBuffer(path: string) {
		const normalizedPath = bash_normalize_path(path);
		if (!is_native_just_bash_tmp_path(normalizedPath)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentProjectPath, normalizedPath);
		}
		return await this.fs.readFileBuffer(normalizedPath);
	}

	async writeFile(path: string, content: FileContent, options?: Parameters<IFileSystem["writeFile"]>[2]) {
		const normalizedPath = bash_normalize_path(path);
		if (!is_native_just_bash_tmp_path(normalizedPath)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentProjectPath, normalizedPath);
		}
		await this.fs.writeFile(normalizedPath, content, options);
	}

	async appendFile(path: string, content: FileContent, options?: Parameters<IFileSystem["appendFile"]>[2]) {
		const normalizedPath = bash_normalize_path(path);
		if (!is_native_just_bash_tmp_path(normalizedPath)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentProjectPath, normalizedPath);
		}
		await this.fs.appendFile(normalizedPath, content, options);
	}

	async exists(path: string) {
		const normalizedPath = bash_normalize_path(path);

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
		return normalizedPath === "/dev" || normalizedPath === bash_DEV_ZERO_PATH || (await this.fs.exists(normalizedPath));
	}

	async stat(path: string): Promise<FsStat> {
		const normalizedPath = bash_normalize_path(path);

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

		// /dev is synthetic; the mounted filesystem only owns device files and /tmp contents.
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
		if (normalizedPath === bash_DEV_ZERO_PATH) {
			return {
				isFile: true,
				isDirectory: false,
				isSymbolicLink: false,
				mode: 0o666,
				size: bash_DEV_ZERO_BYTE_COUNT,
				mtime: new Date(),
			};
		}
		return await this.fs.stat(normalizedPath);
	}

	async mkdir(path: string, options?: MkdirOptions) {
		const normalizedPath = bash_normalize_path(path);
		if (!is_native_just_bash_tmp_path(normalizedPath)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentProjectPath, normalizedPath);
		}
		await this.fs.mkdir(normalizedPath, options);
	}

	async readdir(path: string) {
		const normalizedPath = bash_normalize_path(path);
		if (normalizedPath === "/usr") {
			return ["bin"];
		}
		if (normalizedPath === "/bin" || normalizedPath === "/usr/bin") {
			// Return only native Just Bash commands here. App-only custom commands
			// are available to the outer shell, but not as executable files inside
			// the restricted Native Just Bash /tmp view.
			return bash_ALLOWED_COMMANDS.toSorted();
		}
		if (!is_native_just_bash_tmp_path(normalizedPath)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentProjectPath, normalizedPath);
		}
		if (normalizedPath === "/") {
			return ["dev", "tmp"];
		}
		if (normalizedPath === "/dev") {
			return ["null", "zero"];
		}
		return await this.fs.readdir(normalizedPath);
	}

	async rm(path: string, options?: RmOptions) {
		const normalizedPath = bash_normalize_path(path);
		if (!is_native_just_bash_tmp_path(normalizedPath)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentProjectPath, normalizedPath);
		}
		await this.fs.rm(normalizedPath, options);
	}

	async cp(src: string, dest: string, options?: CpOptions) {
		const normalizedSrc = bash_normalize_path(src);
		if (!is_native_just_bash_tmp_path(normalizedSrc)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentProjectPath, normalizedSrc);
		}

		const normalizedDest = bash_normalize_path(dest);
		if (!is_native_just_bash_tmp_path(normalizedDest)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentProjectPath, normalizedDest);
		}

		await this.fs.cp(normalizedSrc, normalizedDest, options);
	}

	async mv(src: string, dest: string) {
		const normalizedSrc = bash_normalize_path(src);
		if (!is_native_just_bash_tmp_path(normalizedSrc)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentProjectPath, normalizedSrc);
		}

		const normalizedDest = bash_normalize_path(dest);
		if (!is_native_just_bash_tmp_path(normalizedDest)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentProjectPath, normalizedDest);
		}

		await this.fs.mv(normalizedSrc, normalizedDest);
	}

	resolvePath(base: string, path: string) {
		if (path.startsWith("/")) {
			return bash_normalize_path(path);
		}
		// The nested shell may run from `/tmp`, but relative operands typed from
		// the app tree should still resolve against the outer command cwd so the
		// app-file guard rejects them instead of treating them as scratch paths.
		const basePath = is_native_just_bash_tmp_path(this.commandCwd) ? base : this.commandCwd;
		return bash_resolve_path(basePath, path);
	}

	getAllPaths() {
		const paths = new Set(["/", "/dev", bash_DEV_NULL_PATH, bash_DEV_ZERO_PATH, bash_TMP_MOUNT]);
		for (const path of this.fs.getAllPaths()) {
			const normalizedPath = bash_normalize_path(path);
			if (normalizedPath === bash_TMP_MOUNT || normalizedPath.startsWith(`${bash_TMP_MOUNT}/`)) {
				paths.add(normalizedPath);
			}
		}
		return [...paths].sort();
	}

	async chmod(path: string, mode: number) {
		const normalizedPath = bash_normalize_path(path);
		if (!is_native_just_bash_tmp_path(normalizedPath)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentProjectPath, normalizedPath);
		}
		await this.fs.chmod(normalizedPath, mode);
	}

	async symlink(target: string, linkPath: string) {
		const normalizedLinkPath = bash_normalize_path(linkPath);
		if (!is_native_just_bash_tmp_path(normalizedLinkPath)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentProjectPath, normalizedLinkPath);
		}

		const resolvedTarget = target.startsWith("/")
			? bash_normalize_path(target)
			: bash_resolve_path(bash_normalize_path(`${normalizedLinkPath}/..`), target);
		if (!is_native_just_bash_tmp_path(resolvedTarget)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentProjectPath, resolvedTarget);
		}

		await this.fs.symlink(target, normalizedLinkPath);
	}

	async link(existingPath: string, newPath: string) {
		const normalizedExistingPath = bash_normalize_path(existingPath);
		if (!is_native_just_bash_tmp_path(normalizedExistingPath)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentProjectPath, normalizedExistingPath);
		}

		const normalizedNewPath = bash_normalize_path(newPath);
		if (!is_native_just_bash_tmp_path(normalizedNewPath)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentProjectPath, normalizedNewPath);
		}

		await this.fs.link(normalizedExistingPath, normalizedNewPath);
	}

	async readlink(path: string) {
		const normalizedPath = bash_normalize_path(path);
		if (!is_native_just_bash_tmp_path(normalizedPath)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentProjectPath, normalizedPath);
		}
		return await this.fs.readlink(normalizedPath);
	}

	async lstat(path: string) {
		const normalizedPath = bash_normalize_path(path);
		if (
			is_native_just_bash_command_lookup_directory(normalizedPath) ||
			native_just_bash_command_lookup_name(normalizedPath) != null
		) {
			return await this.stat(normalizedPath);
		}

		if (!is_native_just_bash_tmp_path(normalizedPath)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentProjectPath, normalizedPath);
		}

		if (normalizedPath === "/dev" || normalizedPath === bash_DEV_ZERO_PATH) {
			return await this.stat(normalizedPath);
		}

		return await this.fs.lstat(normalizedPath);
	}

	async realpath(path: string) {
		const normalizedPath = bash_normalize_path(path);
		if (
			is_native_just_bash_command_lookup_directory(normalizedPath) ||
			native_just_bash_command_lookup_name(normalizedPath) != null
		) {
			return normalizedPath;
		}
		if (normalizedPath === bash_DEV_ZERO_PATH) {
			return normalizedPath;
		}

		if (!is_native_just_bash_tmp_path(normalizedPath)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentProjectPath, normalizedPath);
		}

		const realPath = await this.fs.realpath(normalizedPath);
		const normalizedRealPath = bash_normalize_path(realPath);
		if (!is_native_just_bash_tmp_path(normalizedRealPath)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentProjectPath, normalizedRealPath);
		}

		return normalizedRealPath;
	}

	async utimes(path: string, atime: Date, mtime: Date) {
		const normalizedPath = bash_normalize_path(path);
		if (!is_native_just_bash_tmp_path(normalizedPath)) {
			throw new NativeJustBashTmpCommandAccessError(this.currentProjectPath, normalizedPath);
		}
		await this.fs.utimes(normalizedPath, atime, mtime);
	}
}

// #endregion native just bash tmp command

// #region reader helpers

/**
 * Limit app-file reader batches before one command starts many Convex reads.
 *
 * Stdin and `/tmp` files do not count. This cap is only for app paths under
 * `currentProjectPath`.
 */
export function bash_enforce_reader_operand_cap(
	command: string,
	commandCtx: CommandContext,
	currentProjectPath: string,
	files: string[],
) {
	let appFileCount = 0;
	for (const file of files) {
		if (file === "-") continue;
		if (bash_is_path_under_current_project_path(currentProjectPath, bash_resolve_path(commandCtx.cwd, file))) {
			appFileCount++;
		}
	}
	if (appFileCount > bash_READER_FILE_OPERAND_MAX) {
		return {
			stdout: "",
			stderr:
				`${command}: app file reads are limited to ${bash_READER_FILE_OPERAND_MAX} files per command (you requested ${appFileCount}). ` +
				`This is a per-command batch limit, not a total ceiling: to READ these files, ${command} them in batches of ${bash_READER_FILE_OPERAND_MAX} or fewer across multiple commands. ` +
				`To FIND which files mention something, use search (it returns matching snippets, not whole files).\n`,
			exitCode: 2,
		};
	}
	return null;
}

/**
 * Return the current byte size for a loaded app file node before deciding
 * whether reader commands can read it inline.
 *
 * This reads metadata only: an unsaved edit's size wins over the committed
 * asset size, and the file body/chunks are never loaded. There is no local
 * cache because an earlier command in the same bash run may have changed the
 * unsaved edit.
 */
export async function bash_get_app_file_byte_size(args: {
	ctx: ActionCtx;
	ctxData: {
		workspaceId: Id<"workspaces">;
		projectId: Id<"workspaces_projects">;
		workspaceName: string;
		projectName: string;
		userId: Id<"users">;
	};
	fileNode: Doc<"files_nodes">;
}) {
	if (args.fileNode.kind !== "file" || args.fileNode.assetId == null) {
		return null;
	}

	if (files_node_has_editable_yjs_state(args.fileNode)) {
		const pendingUpdate = (await args.ctx.runQuery(internal.files_pending_updates.get_by_file_node, {
			workspaceId: args.ctxData.workspaceId,
			projectId: args.ctxData.projectId,
			userId: args.ctxData.userId,
			fileNodeId: args.fileNode._id,
		})) as files_pending_updates_get_by_file_node_Result;
		if (pendingUpdate) {
			return pendingUpdate.size;
		}
	}

	const asset = (await args.ctx.runQuery(internal.r2.get_asset_by_id, {
		workspaceId: args.ctxData.workspaceId,
		projectId: args.ctxData.projectId,
		assetId: args.fileNode.assetId,
	})) as get_asset_by_id_Result;
	return asset?.size ?? null;
}

/**
 * Build stderr guidance for app files whose body cannot be returned as text.
 *
 * The sibling paths are hints for generated Markdown or plain text output.
 * Callers keep this advisory on stderr so it cannot be piped as file content.
 */
export function bash_build_unreadable_file_advisory(
	currentProjectPath: string,
	normalizedPath: string,
	contentType: string | undefined,
) {
	const shellPath = bash_app_file_node_path_to_current_project_path(currentProjectPath, normalizedPath);
	const lastSlashIndex = normalizedPath.lastIndexOf("/");
	const lastDotIndex = normalizedPath.lastIndexOf(".");
	const appFileNodePathWithoutExtension =
		lastDotIndex > lastSlashIndex ? normalizedPath.slice(0, lastDotIndex) : normalizedPath;
	const relatedReadablePaths = Array.from(
		new Set([
			bash_app_file_node_path_to_current_project_path(currentProjectPath, `${normalizedPath}.md`),
			bash_app_file_node_path_to_current_project_path(currentProjectPath, `${appFileNodePathWithoutExtension}.md`),
			bash_app_file_node_path_to_current_project_path(currentProjectPath, `${appFileNodePathWithoutExtension}.txt`),
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

// #endregion reader helpers
