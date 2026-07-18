// Shared Bash utilities used by `bash.ts` and extracted command modules.
// `bash.ts` owns command registration and the action lifecycle. This file owns
// path conversion, the db-files mounts, pagination cursors, and common stderr
// text. Delegation to the native just-bash engine lives in `bash-delegate.ts`;
// this file's just-bash imports must stay type-only (they are erased at build
// time) so isolate-runtime Convex code can import it - the just-bash browser
// bundle statically imports `node:zlib`, which the isolate bundler cannot resolve.

import type {
	CommandContext,
	CpOptions,
	FileContent,
	FsStat,
	IFileSystem,
	MkdirOptions,
	RmOptions,
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
import { Result } from "common/errors-as-values-utils.ts";
import { files_ROOT_ID, files_SYNTHETIC_ROOT_FOLDER, files_node_has_editable_yjs_state } from "../shared/files.ts";
import { LruCache, math_clamp, path_name_of, should_never_happen } from "../shared/shared-utils.ts";
import { organizations_is_reserved_workspace_id, organizations_is_global_organization_id } from "../shared/organizations.ts";
import { pagination_fan_out_paginate } from "../shared/pagination.ts";

// #region bash constants and path helpers

export const bash_HOME = "/home/cloud-usr";
export const bash_APP_MOUNT_PATH = `${bash_HOME}/w`;
export const bash_TMP_MOUNT = "/tmp";

/**
 * Shell mount point for read-only reserved-scope external mounts (e.g. the GitHub mirror of the
 * app's own codebase). Single source of truth for the shell-visible prefix; stored `files_nodes`
 * paths never contain it.
 */
export const bash_EXTERNAL_MOUNTS_ROOT = "/.mounts";

/**
 * Shell mount point for read-only plugin source mounts. Each enabled plugin installation in the
 * current workspace appears as `/.plugins/<pluginName>`, backed by the version-keyed source tree
 * in the reserved `GLOBAL`/`PLUGINS` scope.
 */
export const bash_PLUGINS_MOUNT_ROOT = "/.plugins";
export const bash_DEV_NULL_PATH = "/dev/null";
export const bash_DEV_ZERO_PATH = "/dev/zero";
export const bash_DEV_ZERO_BYTE_COUNT = 8192;
export const bash_DEV_ZERO_TEXT = "\0".repeat(bash_DEV_ZERO_BYTE_COUNT);

/**
 * Shell globs may expand over `/tmp`. App files and external mounts are
 * db-backed trees, so commands reject their glob operands and point callers
 * to indexed commands such as `find`.
 */
export const bash_GLOB_METACHARACTER_REGEX = /[*?[\]]/u;

/**
 * Default page size for directory and search result listings.
 *
 * Listings should be useful without letting one command dump too many results
 * into the transcript. Applies to both surface listings and subtree listings.
 */
export const bash_LISTING_DEFAULT_LIMIT = 10;

/**
 * Maximum accepted page size for directory and search result listings.
 */
export const bash_LISTING_MAX_LIMIT = 20;

/**
 * Maximum number of db-file operands one reader command can pull from the db.
 * `stat` reuses this for metadata fan-out.
 */
export const bash_READER_FILE_OPERAND_MAX = 10;

/**
 * Maximum byte size for a full inline file read.
 *
 * Above this size, full-file readers fall back to bounded reads served from
 * materialized chunks, so a large file is never loaded in one shot. DEV-PHASE
 * AGGRESSIVE: intentionally tiny so small test files page like large files.
 * Raise before production.
 */
export const bash_READ_INLINE_MAX_BYTES = 2 * 1024;

/**
 * Per-page line cap for head/sed/tail against a large file.
 *
 * Must match the backend `files_READ_RANGE_MAX_LINES`. DEV-PHASE AGGRESSIVE so
 * pagination kicks in on small files.
 */
export const bash_READ_HEAD_LARGE_FILE_MAX_LINES = 40;
export const bash_COMMAND_EXIT_FAILURE = 1;
export const bash_COMMAND_EXIT_USAGE = 2;
export const bash_COMMAND_EXIT_CANNOT_EXECUTE = 126;
export const bash_COMMAND_EXIT_NOT_FOUND = 127;
export const bash_NON_NEGATIVE_INTEGER_REGEX = /^\d+$/u;
export const bash_TERMINAL_LINE_ENDING_REGEX = /\r\n?/g;
export const bash_SHELL_COMMENT_LINE_REGEX = /^\s*#.*$/gm;
export const bash_WHITESPACE_RUN_REGEX = /\s+/u;

const PAGINATION_CURSORS_CACHE_MAX_ENTRIES = 500;
const BACKSLASH_REGEX = /\\/g;
const SINGLE_QUOTE_REGEX = /'/g;
const SIGNED_INTEGER_REGEX = /^-?\d+$/u;
const SIMPLE_EXTENSION_GLOB_REGEX = /^\*\.([a-z0-9][a-z0-9_-]*)$/iu;
const SEARCH_EXACT_SINGLE_TOKEN_REGEX = /^\S+$/u;
const SEARCH_EXACT_PUNCTUATION_TOKEN_REGEX = /[-_.:@]/u;
const SHELL_ARG_SAFE_UNQUOTED_REGEX = /^[A-Za-z0-9_/:.,=+@-]+$/;
const LISTING_PAGE_LIMIT_MAX = 200;
const BASH_REGEX_PATTERN_MAX_LENGTH = 200;
const textEncoder = new TextEncoder();

/**
 * In-memory LRU cache for stored pagination cursors. `value_store` remains the
 * durable fallback when this per-runtime cache is empty.
 */
const pagination_cursors_cache = new LruCache<string, string>(PAGINATION_CURSORS_CACHE_MAX_ENTRIES);

/**
 * Return one clean absolute path for Bash, db files, and cache keys.
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
 * Convert a db-files path to its Bash path inside currentWorkspacePath.
 */
export function bash_db_files_path_to_current_workspace_path(currentWorkspacePath: string, path: string) {
	const normalizedPath = bash_normalize_path(path);
	return normalizedPath === "/" ? currentWorkspacePath : `${currentWorkspacePath}${normalizedPath}`;
}

/**
 * Convert a normalized Bash path under currentWorkspacePath back to a db-files path.
 *
 * Returns `null` for Bash paths outside currentWorkspacePath, like `/tmp/foo`.
 */
export function bash_current_workspace_path_to_db_files_path(currentWorkspacePath: string, path: string) {
	if (path === currentWorkspacePath) {
		return "/";
	}
	if (path.startsWith(`${currentWorkspacePath}/`)) {
		return path.slice(currentWorkspacePath.length);
	}
	return null;
}

/**
 * Check whether a normalized path is inside currentWorkspacePath.
 */
export function bash_is_path_under_current_workspace_path(currentWorkspacePath: string, path: string) {
	return bash_is_path_under(currentWorkspacePath, path);
}

/**
 * Check whether a normalized path is `basePath` itself or inside it.
 */
export function bash_is_path_under(basePath: string, path: string) {
	return path === basePath || path.startsWith(`${basePath}/`);
}

/**
 * Check whether a normalized path is inside any read-only db-files mount tree
 * (`/.mounts` external sources or `/.plugins` plugin sources).
 */
export function bash_is_path_under_read_only_mounts(path: string) {
	return bash_is_path_under(bash_EXTERNAL_MOUNTS_ROOT, path) || bash_is_path_under(bash_PLUGINS_MOUNT_ROOT, path);
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

// #region db files filesystem

/**
 * Keep the Just Bash path cache to the db file fields the virtual filesystem needs.
 *
 * Some entries come from `files_nodes` docs, others are synthetic parent
 * folders created while caching descendants.
 */
type DbFilesCacheEntry = {
	_id?: Id<"files_nodes"> | typeof files_ROOT_ID;
	path: Doc<"files_nodes">["path"];
	name: Doc<"files_nodes">["name"];
	kind: Doc<"files_nodes">["kind"];
	updatedAt: Doc<"files_nodes">["updatedAt"];
	updatedBy?: Doc<"files_nodes">["updatedBy"] | "";
	contentType?: Doc<"files_nodes">["contentType"];
};

export type bash_DbFilesFsOptions = {
	ctx: ActionCtx;
	ctxData: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		organizationName: string;
		workspaceName: string;
		userId: Id<"users">;
	};
	currentWorkspacePath: string;
	allowDbFilesMkdir: boolean;
	/**
	 * Stored-path prefix prepended to every mount-relative path before it reaches Convex.
	 *
	 * Plugin source mounts store their tree under `/<pluginVersionId>/...` in the reserved
	 * `GLOBAL`/`PLUGINS` scope while the shell sees `/.plugins/<pluginName>/...`, so the fs maps
	 * `"/dist"` to `"/<pluginVersionId>/dist"` at the query boundary and strips the prefix again
	 * when rendering shell paths. Empty (the default) keeps stored and mount-relative paths equal.
	 */
	dbFilesPathPrefix?: string;
	/**
	 * Which read-only mounted source family this fs backs; omit for the tenant app tree.
	 *
	 * `codebase` is the GitHub mirror of the app's own repository (`/.mounts`), kept so the
	 * agent can read its own source when helping users use the app or build plugins.
	 * Every path a mounted fs sees is inside its own mount by construction, so the mount
	 * identity (not shell-path sniffing) decides the EROFS message for rejected writes.
	 */
	readOnlySource?: "codebase" | "plugins";
};

/**
 * Means a db file exists, but bash cannot read its body as text.
 *
 * Keep the path and content type so command handlers can print a useful message.
 */
export class bash_DbFilesContentUnavailableError extends Error {
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
		super(`unsupported file content type '${args.contentType ?? "unknown"}'`);
		this.name = "DbFilesContentUnavailableError";
		this.shellPath = args.shellPath;
		this.contentType = args.contentType;
	}
}

/**
 * Means bash tried to mutate a mounted read-only filesystem path.
 */
class ReadOnlyFileSystemError extends Error {
	readonly path: string;

	constructor(path: string, readOnlySource: bash_DbFilesFsOptions["readOnlySource"]) {
		const normalizedPath = bash_normalize_path(path);
		// The same filesystem class backs tenant app files, external mounts, and plugin
		// source mounts. Read-only mount writes need separate messages because
		// write_file/edit_file cannot edit read-only mounted sources.
		const message =
			readOnlySource === "codebase"
				? `EROFS: read-only file system, '${normalizedPath}'. '${bash_EXTERNAL_MOUNTS_ROOT}' is a read-only mount of an external source.`
				: readOnlySource === "plugins"
					? `EROFS: read-only file system, '${normalizedPath}'. '${bash_PLUGINS_MOUNT_ROOT}' is a read-only mount of installed plugin sources.`
					: `EROFS: read-only file system, '${normalizedPath}'. Persistent app-file writes must use write_file/edit_file; shell redirects into app files are unsupported.`;
		super(message);
		this.name = "ReadOnlyFileSystemError";
		this.path = normalizedPath;
	}
}

/**
 * Mount a db files tree into Just Bash as a mostly read-only filesystem.
 *
 * `MountableFs` strips `currentWorkspacePath` before calls reach this class, so
 * IFileSystem methods receive mount-relative paths like `/docs/readme.md`, not
 * shell paths like `/home/cloud-usr/w/.../docs/readme.md`. They translate through
 * `dbFilesPathPrefix` exactly once; `getEntry`/`rememberEntry` and the caches
 * always operate on stored `files_nodes.path` values.
 */
export class bash_DbFilesFs implements IFileSystem {
	readonly ctx: ActionCtx;
	readonly ctxData: bash_DbFilesFsOptions["ctxData"];
	readonly currentWorkspacePath: string;
	readonly allowDbFilesMkdir: boolean;
	readonly dbFilesPathPrefix: string;
	readonly readOnlySource: bash_DbFilesFsOptions["readOnlySource"];
	/** Stored path of this mount's root (`"/"`, or the prefix itself for prefixed mounts). */
	readonly dbFilesRootPath: string;
	pathIndexTruncated = false;
	private entryCache = new Map<string, DbFilesCacheEntry>();
	private contentCache = new Map<string, string>();

	constructor(options: bash_DbFilesFsOptions) {
		this.ctx = options.ctx;
		this.ctxData = options.ctxData;
		this.currentWorkspacePath = options.currentWorkspacePath;
		this.allowDbFilesMkdir = options.allowDbFilesMkdir;
		this.readOnlySource = options.readOnlySource;
		this.dbFilesPathPrefix = options.dbFilesPathPrefix == null ? "" : bash_normalize_path(options.dbFilesPathPrefix);
		this.dbFilesRootPath = this.dbFilesPathPrefix === "" || this.dbFilesPathPrefix === "/" ? "/" : this.dbFilesPathPrefix;
		// A prefixed mount root (`/<prefix>`) is a real files_nodes folder, not the scope's
		// synthetic "/" root: keep the seeded entry id-less so callers resolve the real node id
		// instead of inheriting files_ROOT_ID and listing the reserved scope root's children.
		this.rememberEntry(
			this.dbFilesRootPath === "/"
				? files_SYNTHETIC_ROOT_FOLDER
				: { ...files_SYNTHETIC_ROOT_FOLDER, _id: undefined, path: this.dbFilesRootPath },
		);
	}

	/**
	 * Map a mount-relative path from `MountableFs` to the stored `files_nodes.path`.
	 *
	 * `getEntry`/`rememberEntry` and the caches always operate on stored paths, so IFileSystem
	 * entrypoints translate exactly once before any cache or Convex access.
	 */
	private toDbFilesPath(path: string) {
		const normalizedPath = bash_normalize_path(path);
		if (this.dbFilesRootPath === "/") {
			return normalizedPath;
		}
		return normalizedPath === "/" ? this.dbFilesRootPath : `${this.dbFilesRootPath}${normalizedPath}`;
	}

	/**
	 * Render a stored db-files path back to the shell path the user sees,
	 * stripping the stored-path prefix for prefixed mounts.
	 */
	private shellPathOf(dbFilesPath: string) {
		const normalizedPath = bash_normalize_path(dbFilesPath);
		const mountRelativePath =
			this.dbFilesRootPath === "/"
				? normalizedPath
				: normalizedPath === this.dbFilesRootPath
					? "/"
					: normalizedPath.startsWith(`${this.dbFilesRootPath}/`)
						? normalizedPath.slice(this.dbFilesRootPath.length)
						: normalizedPath;
		return bash_db_files_path_to_current_workspace_path(this.currentWorkspacePath, mountRelativePath);
	}

	/**
	 * Build the read-only error from a mount-relative db-files path.
	 *
	 * Convert back to the shell path before choosing the tenant file or
	 * read-only mount message.
	 */
	private readOnlyFileSystemError(path: string) {
		const shellPath = bash_db_files_path_to_current_workspace_path(this.currentWorkspacePath, bash_normalize_path(path));
		return new ReadOnlyFileSystemError(shellPath, this.readOnlySource);
	}

	/**
	 * Read a db-files path after rejecting shell glob operands.
	 *
	 * Just Bash can call this filesystem with paths produced by shell glob expansion.
	 * Db files are db-backed trees, so reject glob
	 * metacharacters before querying the db.
	 */
	async readFile(path: string, _options?: Parameters<IFileSystem["readFile"]>[1]) {
		const dbFilesPath = this.toDbFilesPath(path);
		if (bash_GLOB_METACHARACTER_REGEX.test(dbFilesPath)) {
			throw new Error(`app file glob patterns are not supported: '${this.shellPathOf(dbFilesPath)}'`);
		}
		const cached = this.contentCache.get(dbFilesPath);
		if (cached != null) {
			return cached;
		}

		// Most file reads can now use materialized or pending chunks. Try that
		// cheap query path first and keep the older action fallback for callers
		// that still need last-available reconstruction behavior.
		const chunkRead = (await this.ctx.runQuery(internal.files_nodes.read_file_content_from_chunks, {
			organizationId: this.ctxData.organizationId,
			workspaceId: this.ctxData.workspaceId,
			userId: this.ctxData.userId,
			path: dbFilesPath,
			mode: {
				kind: "full",
				maxBytes: bash_READ_INLINE_MAX_BYTES,
			},
		})) as files_nodes_read_file_content_from_chunks_Result;
		if (chunkRead) {
			this.contentCache.set(dbFilesPath, chunkRead.content);
			return chunkRead.content;
		}

		// The action fallback reconstructs last-available content; the parallel
		// db file lookup preserves precise missing/folder/unreadable errors.
		const fileContentPromise = this.ctx.runAction(
			internal.files_nodes.get_file_last_available_markdown_content_by_path,
			{
				organizationId: this.ctxData.organizationId,
				workspaceId: this.ctxData.workspaceId,
				userId: this.ctxData.userId,
				path: dbFilesPath,
			},
		) as Promise<files_nodes_get_file_last_available_markdown_content_by_path_Result>;
		const dbFilePromise: Promise<files_nodes_get_by_path_Result> =
			dbFilesPath === "/"
				? Promise.resolve(null)
				: (this.ctx.runQuery(internal.files_nodes.get_by_path, {
						organizationId: this.ctxData.organizationId,
						workspaceId: this.ctxData.workspaceId,
						path: dbFilesPath,
					}) as Promise<files_nodes_get_by_path_Result>);
		const [fileContent, dbFilesDoc] = await Promise.all([fileContentPromise, dbFilePromise]);

		if (!fileContent) {
			const cacheEntry = dbFilesPath === "/" ? files_SYNTHETIC_ROOT_FOLDER : dbFilesDoc;
			if (cacheEntry?.kind === "file") {
				this.rememberEntry(cacheEntry);
				throw new bash_DbFilesContentUnavailableError({
					shellPath: this.shellPathOf(dbFilesPath),
					contentType: cacheEntry.contentType,
				});
			}
			if (cacheEntry?.kind === "folder") {
				this.rememberEntry(cacheEntry);
				throw new Error(`EISDIR: illegal operation on a directory, read '${this.shellPathOf(dbFilesPath)}'`);
			}
			throw new Error(`ENOENT: no such file or directory, open '${this.shellPathOf(dbFilesPath)}'`);
		}

		this.contentCache.set(dbFilesPath, fileContent.content);
		if (dbFilesDoc?.kind === "file") {
			this.rememberEntry(dbFilesDoc);
		} else {
			this.rememberEntry({
				_id: fileContent.nodeId,
				path: dbFilesPath,
				name: path_name_of(dbFilesPath),
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
		throw this.readOnlyFileSystemError(path);
	}

	async appendFile(path: string, _content: FileContent, _options?: Parameters<IFileSystem["appendFile"]>[2]) {
		throw this.readOnlyFileSystemError(path);
	}

	async exists(path: string) {
		return (await this.getEntry(this.toDbFilesPath(path))) != null;
	}

	async stat(path: string): Promise<FsStat> {
		const dbFilesPath = this.toDbFilesPath(path);
		if (bash_GLOB_METACHARACTER_REGEX.test(dbFilesPath)) {
			throw new Error(`app file glob patterns are not supported: '${this.shellPathOf(dbFilesPath)}'`);
		}
		const cacheEntry = await this.getEntry(dbFilesPath);
		if (!cacheEntry) {
			throw new Error(`ENOENT: no such file or directory, stat '${this.shellPathOf(dbFilesPath)}'`);
		}

		const content = this.contentCache.get(dbFilesPath);
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
		const dbFilesPath = this.toDbFilesPath(normalizedPath);
		if (bash_GLOB_METACHARACTER_REGEX.test(dbFilesPath)) {
			throw new Error(`app file glob patterns are not supported: '${this.shellPathOf(dbFilesPath)}'`);
		}
		const existing = await this.getEntry(dbFilesPath);
		if (existing) {
			if (options?.recursive && existing.kind === "folder") {
				return;
			}
			throw new Error(`EEXIST: file already exists, mkdir '${this.shellPathOf(dbFilesPath)}'`);
		}
		if (!this.allowDbFilesMkdir) {
			if (this.readOnlySource != null) {
				throw this.readOnlyFileSystemError(normalizedPath);
			}
			throw new Error(
				"Creating folders in the app file tree is available in Agent mode. Scratch space does not create durable folders.",
			);
		}
		if (!options?.recursive) {
			const parentPath = bash_normalize_path(`${dbFilesPath}/..`);
			const parent = await this.getEntry(parentPath);
			if (!parent || parent.kind !== "folder") {
				throw new Error(`ENOENT: no such file or directory, mkdir '${this.shellPathOf(dbFilesPath)}'`);
			}
		}

		// mkdir only runs for the tenant app db-files root: the external mount and plugin
		// source roots pass allowDbFilesMkdir=false and threw above, so the scope here is never
		// reserved. Narrow the union before the workspace-only mutation, which declares strict ids.
		const { organizationId, workspaceId, userId } = this.ctxData;
		if (organizations_is_global_organization_id(organizationId) || organizations_is_reserved_workspace_id(workspaceId)) {
			throw should_never_happen("mkdir reached the reserved mount scope", { organizationId, workspaceId });
		}
		const created = (await this.ctx.runMutation(internal.files_nodes.create_folder_node_by_path, {
			organizationId,
			workspaceId,
			userId,
			path: dbFilesPath,
		})) as files_nodes_create_folder_node_by_path_Result;
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		this.rememberEntry({
			_id: created._yay.nodeId,
			path: dbFilesPath,
			name: path_name_of(dbFilesPath),
			kind: "folder",
			updatedAt: Date.now(),
			contentType: undefined,
			updatedBy: this.ctxData.userId,
		});
	}

	async readdir(path: string): Promise<string[]> {
		const dbFilesPath = this.toDbFilesPath(path);
		const stat = await this.stat(path);
		if (!stat.isDirectory) {
			throw new Error(`ENOTDIR: not a directory, scandir '${this.shellPathOf(dbFilesPath)}'`);
		}
		throw new Error("db files directory enumeration is not supported; use ls --limit N or find --limit N");
	}

	async rm(path: string, options?: RmOptions) {
		if (options?.force && !(await this.exists(path))) {
			return;
		}
		throw this.readOnlyFileSystemError(path);
	}

	async cp(_src: string, dest: string, _options?: CpOptions) {
		throw this.readOnlyFileSystemError(dest);
	}

	async mv(_src: string, dest: string) {
		throw this.readOnlyFileSystemError(dest);
	}

	resolvePath(base: string, path: string) {
		return bash_resolve_path(base, path);
	}

	/**
	 * Keep app files and external mounts out of shell glob candidate discovery.
	 *
	 * Just Bash asks for glob candidates synchronously. Do not expose cached app
	 * file or external mount paths here, or shell glob expansion could look
	 * successful while bypassing db pagination and returning an incomplete set.
	 */
	getAllPaths() {
		return ["/"];
	}

	async chmod(path: string, _mode: number) {
		throw this.readOnlyFileSystemError(path);
	}

	async symlink(_target: string, linkPath: string) {
		throw this.readOnlyFileSystemError(linkPath);
	}

	async link(_existingPath: string, newPath: string) {
		throw this.readOnlyFileSystemError(newPath);
	}

	async readlink(path: string): Promise<string> {
		throw new Error(
			`EINVAL: invalid argument, readlink '${bash_db_files_path_to_current_workspace_path(this.currentWorkspacePath, path)}'`,
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
		throw this.readOnlyFileSystemError(path);
	}

	rememberEntry(cacheEntry: DbFilesCacheEntry) {
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
		// synthetic root, only entries with `_id` prove that an app path exists in `files_nodes`.
		if (cached && (normalizedPath === this.dbFilesRootPath || cached._id != null)) {
			return cached;
		}

		const dbFilesDoc = (await this.ctx.runQuery(internal.files_nodes.get_by_path, {
			organizationId: this.ctxData.organizationId,
			workspaceId: this.ctxData.workspaceId,
			path: normalizedPath,
		})) as files_nodes_get_by_path_Result;

		if (!dbFilesDoc) {
			return null;
		}

		const cacheEntry = {
			_id: dbFilesDoc._id,
			path: dbFilesDoc.path,
			name: dbFilesDoc.name,
			kind: dbFilesDoc.kind,
			updatedAt: dbFilesDoc.updatedAt,
			updatedBy: dbFilesDoc.updatedBy,
			contentType: dbFilesDoc.contentType,
		} satisfies DbFilesCacheEntry;
		this.rememberEntry(cacheEntry);
		return cacheEntry;
	}
}

// #endregion db files filesystem

// #region db files path resolution

/**
 * One db-files root that Bash can route paths into.
 */
export type bash_DbFilesRoot = {
	currentWorkspacePath: string;
	fs: bash_DbFilesFs;
};

/**
 * One enabled plugin installation exposed as a read-only source mount at
 * `/.plugins/<pluginName>`, backed by the version-keyed tree `/<pluginVersionId>/...`
 * in the reserved `GLOBAL`/`PLUGINS` scope.
 */
export type bash_PluginSourceMount = {
	pluginName: string;
	pluginVersionId: Id<"plugins_versions">;
	fs: bash_DbFilesFs;
};

/**
 * One synced GitHub source exposed as a read-only mount at `/.mounts/<name>`, backed by the
 * commit-keyed tree `/<name>/<commitSha>/...` in the reserved `GLOBAL`/`GITHUB` scope. The sha
 * is pinned once per bash run and never appears in shell paths.
 */
export type bash_ExternalSourceMount = {
	name: string;
	commitSha: string;
	fs: bash_DbFilesFs;
};

/**
 * The app file tree, per-external-source mount, and per-plugin source mount
 * db-files roots available to Bash commands.
 */
export type bash_DbFilesRoots = {
	app: bash_DbFilesRoot;
	externalMounts: {
		currentWorkspacePath: string;
		/** Synced sources keyed by mount name; empty when nothing has finished a sync. */
		mounts: Map<string, bash_ExternalSourceMount>;
	};
	plugins: {
		currentWorkspacePath: string;
		/** Enabled installations keyed by plugin name; empty when nothing is installed. */
		mounts: Map<string, bash_PluginSourceMount>;
	};
};

/**
 * The storage scope a normalized Bash path resolved to.
 */
export type bash_DbFilesShellPathKind =
	| "app"
	| "outside_db_files"
	| "external_mount"
	| "external_mounts_root"
	| "plugins_root";

export type bash_DbFilesShellPathResolution = {
	kind: bash_DbFilesShellPathKind;
	fs: bash_DbFilesFs;
	ctxData: bash_DbFilesFsOptions["ctxData"];
	/** Tenant or reserved-scope `files_nodes.path`, or `null` for paths outside db files trees. */
	dbFilesPath: string | null;
	/** Shell prefix used when rendering db-files paths back to users. */
	basePath: string;
	/** Render a db-files path back to the Bash path the user sees. */
	renderShellPath: (dbFilesPath: string) => string;
};

/**
 * Resolve a Bash path to the db-files root, stored path, and renderer.
 */
export function bash_resolve_db_files_shell_path(
	shellPath: string,
	dbFilesRoots: bash_DbFilesRoots,
): bash_DbFilesShellPathResolution {
	const normalized = bash_normalize_path(shellPath);

	if (bash_is_path_under(bash_EXTERNAL_MOUNTS_ROOT, normalized)) {
		const mountsRootPath = dbFilesRoots.externalMounts.currentWorkspacePath;
		const mountsRelativePath = bash_current_workspace_path_to_db_files_path(mountsRootPath, normalized);
		const mountName = mountsRelativePath?.split("/").filter(Boolean)[0];
		const mount = mountName == null ? undefined : dbFilesRoots.externalMounts.mounts.get(mountName);

		// `/.mounts` itself has no single stored tree: each synced source is its own commit-keyed
		// mount. Commands that need a listing fall through to `MountableFs` (dbFilesPath stays
		// null); indexed commands guard this kind and fan out or print scoping guidance.
		if (mountsRelativePath === "/" || mountsRelativePath == null) {
			return {
				kind: "external_mounts_root",
				fs: dbFilesRoots.app.fs,
				ctxData: dbFilesRoots.app.fs.ctxData,
				dbFilesPath: null,
				basePath: mountsRootPath,
				renderShellPath: (dbFilesPath: string) =>
					bash_db_files_path_to_current_workspace_path(mountsRootPath, dbFilesPath),
			};
		}

		// Unknown or not-yet-synced mount names resolve as plain non-db paths so commands fall
		// through to `MountableFs` and report ordinary ENOENT without leaking source configuration.
		if (mount == null || mountName == null) {
			return {
				kind: "outside_db_files",
				fs: dbFilesRoots.app.fs,
				ctxData: dbFilesRoots.app.fs.ctxData,
				dbFilesPath: null,
				basePath: dbFilesRoots.app.currentWorkspacePath,
				renderShellPath: (dbFilesPath: string) =>
					bash_db_files_path_to_current_workspace_path(dbFilesRoots.app.currentWorkspacePath, dbFilesPath),
			};
		}

		// `/.mounts/<name>/rest` maps to the commit-keyed stored tree `/<name>/<commitSha>/rest`
		// in the reserved `GLOBAL`/`GITHUB` scope; the renderer strips the commit prefix back off.
		const basePath = `${mountsRootPath}/${mountName}`;
		const commitRootPath = `/${mount.name}/${mount.commitSha}`;
		const mountRelativePath = bash_current_workspace_path_to_db_files_path(basePath, normalized) ?? "/";
		const dbFilesPath = mountRelativePath === "/" ? commitRootPath : `${commitRootPath}${mountRelativePath}`;
		const renderShellPath = (renderDbFilesPath: string) => {
			const normalizedDbFilesPath = bash_normalize_path(renderDbFilesPath);
			const relativePath =
				normalizedDbFilesPath === commitRootPath
					? "/"
					: normalizedDbFilesPath.startsWith(`${commitRootPath}/`)
						? normalizedDbFilesPath.slice(commitRootPath.length)
						: normalizedDbFilesPath;
			return bash_db_files_path_to_current_workspace_path(basePath, relativePath);
		};
		return {
			kind: "external_mount",
			fs: mount.fs,
			ctxData: mount.fs.ctxData,
			dbFilesPath,
			basePath,
			renderShellPath,
		};
	}

	if (bash_is_path_under(bash_PLUGINS_MOUNT_ROOT, normalized)) {
		const pluginsRootPath = dbFilesRoots.plugins.currentWorkspacePath;
		const pluginsRelativePath = bash_current_workspace_path_to_db_files_path(pluginsRootPath, normalized);
		const pluginName = pluginsRelativePath?.split("/").filter(Boolean)[0];
		const mount = pluginName == null ? undefined : dbFilesRoots.plugins.mounts.get(pluginName);

		// `/.plugins` itself has no single stored tree: each installed plugin is its own
		// mount. Commands that need a listing fall through to `MountableFs` (dbFilesPath
		// stays null); indexed commands guard this kind and print scoping guidance.
		if (pluginsRelativePath === "/" || pluginsRelativePath == null) {
			return {
				kind: "plugins_root",
				fs: dbFilesRoots.app.fs,
				ctxData: dbFilesRoots.app.fs.ctxData,
				dbFilesPath: null,
				basePath: pluginsRootPath,
				renderShellPath: (dbFilesPath: string) =>
					bash_db_files_path_to_current_workspace_path(pluginsRootPath, dbFilesPath),
			};
		}

		// Unknown or not-installed plugin names resolve as plain non-db paths so commands
		// fall through to `MountableFs` and report ordinary ENOENT without leaking whether
		// the plugin exists in the registry.
		if (mount == null || pluginName == null) {
			return {
				kind: "outside_db_files",
				fs: dbFilesRoots.app.fs,
				ctxData: dbFilesRoots.app.fs.ctxData,
				dbFilesPath: null,
				basePath: dbFilesRoots.app.currentWorkspacePath,
				renderShellPath: (dbFilesPath: string) =>
					bash_db_files_path_to_current_workspace_path(dbFilesRoots.app.currentWorkspacePath, dbFilesPath),
			};
		}

		// `/.plugins/<name>/rest` maps to the version-keyed stored tree `/<pluginVersionId>/rest`
		// in the reserved `GLOBAL`/`PLUGINS` scope; the renderer strips the version prefix back off.
		const basePath = `${pluginsRootPath}/${pluginName}`;
		const versionRootPath = `/${mount.pluginVersionId}`;
		const mountRelativePath = bash_current_workspace_path_to_db_files_path(basePath, normalized) ?? "/";
		const dbFilesPath = mountRelativePath === "/" ? versionRootPath : `${versionRootPath}${mountRelativePath}`;
		const renderShellPath = (renderDbFilesPath: string) => {
			const normalizedDbFilesPath = bash_normalize_path(renderDbFilesPath);
			const relativePath =
				normalizedDbFilesPath === versionRootPath
					? "/"
					: normalizedDbFilesPath.startsWith(`${versionRootPath}/`)
						? normalizedDbFilesPath.slice(versionRootPath.length)
						: normalizedDbFilesPath;
			return bash_db_files_path_to_current_workspace_path(basePath, relativePath);
		};
		return {
			kind: "external_mount",
			fs: mount.fs,
			ctxData: mount.fs.ctxData,
			dbFilesPath,
			basePath,
			renderShellPath,
		};
	}

	const renderShellPath = (dbFilesPath: string) =>
		bash_db_files_path_to_current_workspace_path(dbFilesRoots.app.currentWorkspacePath, dbFilesPath);
	const dbFilesPath = bash_current_workspace_path_to_db_files_path(dbFilesRoots.app.currentWorkspacePath, normalized);
	return {
		kind: dbFilesPath == null ? "outside_db_files" : "app",
		fs: dbFilesRoots.app.fs,
		ctxData: dbFilesRoots.app.fs.ctxData,
		dbFilesPath,
		basePath: dbFilesRoots.app.currentWorkspacePath,
		renderShellPath,
	};
}

/**
 * Build the consistent stderr for a write attempt under a read-only mount
 * (`/.mounts` external sources or `/.plugins` plugin sources).
 */
export function bash_read_only_mount_error(command: string, shellPath: string) {
	const normalizedPath = bash_normalize_path(shellPath);
	const reason = bash_is_path_under(bash_PLUGINS_MOUNT_ROOT, normalizedPath)
		? `'${bash_PLUGINS_MOUNT_ROOT}' is a read-only mount of installed plugin sources.`
		: `'${bash_EXTERNAL_MOUNTS_ROOT}' is a read-only mount of an external source.`;
	return `${command}: cannot modify '${normalizedPath}': ${reason}\n`;
}

// #endregion db files path resolution

// #region shared command helpers

// These constants support the narrow `source`/`.` guard below. They identify
// simple command boundaries, wrapper builtins, redirections, and dynamic words;
// they are not a general shell parser.
const SOURCE_BUILTIN_PREFIX_COMMANDS = new Set(["builtin", "command", "eval"]);
const SOURCE_BUILTIN_CONTROL_WORDS = new Set(["!", "do", "elif", "else", "if", "then", "time", "until", "while"]);
const SHELL_ASSIGNMENT_WORD_REGEX = /^[A-Za-z_][A-Za-z0-9_]*=/u;
const SHELL_DYNAMIC_WORD_REGEX = /[$`]/u;
const SHELL_REDIRECTION_WORD_REGEX = /^(?:\d*(?:<>|>>|>\||>|<|<<|<<<|<&|>&)|&>>?)(?:.+)?$/u;
const SHELL_REDIRECTION_OPERATOR_REGEX = /^(?:\d*(?:<>|>>|>\||>|<|<<|<<<|<&|>&)|&>>?)$/u;

type ShellWordToken = { kind: "separator" } | { kind: "word"; value: string };

/**
 * Split only enough shell syntax to find simple commands. Quotes and backslashes
 * stay inside the word value, so separators inside quotes do not split the command.
 */
function parse_shell_word_tokens(command: string) {
	const tokens: ShellWordToken[] = [];
	let word = "";
	let quote: "'" | '"' | null = null;

	const pushWord = () => {
		if (word === "") return;
		tokens.push({ kind: "word", value: word });
		word = "";
	};

	for (let i = 0; i < command.length; i++) {
		const char = command[i];
		if (quote !== null) {
			if (char === quote) {
				quote = null;
			} else if (char === "\\" && quote === '"' && i + 1 < command.length) {
				i++;
				word += command[i];
			} else {
				word += char;
			}
			continue;
		}

		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (char === "\\" && i + 1 < command.length) {
			i++;
			word += command[i];
			continue;
		}
		if (/\s/u.test(char)) {
			pushWord();
			if (char === "\n") {
				tokens.push({ kind: "separator" });
			}
			continue;
		}
		if (char === ";" || char === "|" || char === "&" || char === "(" || char === ")") {
			pushWord();
			tokens.push({ kind: "separator" });
			continue;
		}
		word += char;
	}
	pushWord();
	return tokens;
}

/**
 * Return whether a shell word starts a redirection.
 *
 * Redirections can be written as a standalone operator like `>` or as a compact
 * word like `2>/tmp/source.err`.
 */
function shell_word_is_redirection_prefix(word: string) {
	return SHELL_REDIRECTION_WORD_REGEX.test(word);
}

/**
 * Find the script path for `source`/`.` while ignoring redirection targets.
 * Redirections can appear before or after the sourced path, so the guard must
 * classify the script path, not the stderr/stdout path.
 */
function source_target_from_words(words: string[], startIndex: number) {
	let skipRedirectionTarget = false;

	for (let index = startIndex; index < words.length; index++) {
		const word = words[index];
		if (skipRedirectionTarget) {
			skipRedirectionTarget = false;
			continue;
		}
		if (shell_word_is_redirection_prefix(word)) {
			skipRedirectionTarget = SHELL_REDIRECTION_OPERATOR_REGEX.test(word);
			continue;
		}
		return word;
	}
	return null;
}

/**
 * Decide whether a `source`/`.` target is disallowed.
 *
 * `source`/`.` executes inside the current shell, bypassing the explicit
 * `bash <script>` guards for app files and external mounts. Literal targets are
 * resolved against cwd so `/tmp/script.sh` stays allowed. Dynamic targets are
 * blocked because their final path cannot be classified without shell expansion.
 */
function source_target_is_disallowed(target: string, options: { cwd: string; currentWorkspacePath: string }): boolean {
	if (SHELL_DYNAMIC_WORD_REGEX.test(target)) {
		return true;
	}
	const resolvedPath = bash_resolve_path(options.cwd, target);
	return (
		bash_is_path_under_current_workspace_path(options.currentWorkspacePath, resolvedPath) ||
		bash_is_path_under_read_only_mounts(resolvedPath)
	);
}

/**
 * Inspect one simple command for a disallowed `source`/`.` target.
 *
 * Assignment words, redirections, and wrapper builtins can appear before
 * `source`, so skip them before checking the script target.
 */
function simple_command_has_disallowed_source_target(
	words: string[],
	options: { cwd: string; currentWorkspacePath: string },
): boolean {
	let skipRedirectionTarget = false;

	for (let index = 0; index < words.length; index++) {
		const word = words[index];
		if (skipRedirectionTarget) {
			skipRedirectionTarget = false;
			continue;
		}

		if (SHELL_ASSIGNMENT_WORD_REGEX.test(word) || shell_word_is_redirection_prefix(word)) {
			skipRedirectionTarget = SHELL_REDIRECTION_OPERATOR_REGEX.test(word);
			continue;
		}

		if (SOURCE_BUILTIN_CONTROL_WORDS.has(word)) {
			continue;
		}

		if (word === "source" || word === ".") {
			const target = source_target_from_words(words, index + 1);
			return target == null ? false : source_target_is_disallowed(target, options);
		}

		if (word === "eval") {
			// `eval 'source ...'` builds another command string; scan that string
			// before Just Bash runs it.
			return bash_command_has_disallowed_source_target(words.slice(index + 1).join(" "), options);
		}

		if (SOURCE_BUILTIN_PREFIX_COMMANDS.has(word)) {
			// `command source file` and `builtin . file` still invoke the source builtins.
			const command = source_target_from_words(words, index + 1);
			if (command === "source" || command === ".") {
				const sourceIndex = words.indexOf(command, index + 1);
				const target = source_target_from_words(words, sourceIndex + 1);
				return target == null ? false : source_target_is_disallowed(target, options);
			}
			if (command === "eval") {
				const evalIndex = words.indexOf(command, index + 1);
				return bash_command_has_disallowed_source_target(words.slice(evalIndex + 1).join(" "), options);
			}
		}

		return false;
	}

	return false;
}

/**
 * Detect `source`/`.` usage that would execute an app file or external mount.
 *
 * This stays a shallow shell-word scan, not a second interpreter. It only decides
 * whether a `source`/`.` target is definitely an app file or external mount path;
 * normal `/tmp` source usage should continue through Just Bash.
 */
export function bash_command_has_disallowed_source_target(
	command: string,
	options: { cwd: string; currentWorkspacePath: string },
): boolean {
	const tokens = parse_shell_word_tokens(command.replace(bash_SHELL_COMMENT_LINE_REGEX, ""));
	let words: string[] = [];

	for (const token of tokens) {
		if (token.kind === "separator") {
			if (simple_command_has_disallowed_source_target(words, options)) {
				return true;
			}
			words = [];
			continue;
		}
		words.push(token.value);
	}

	return simple_command_has_disallowed_source_target(words, options);
}

/**
 * Build the message shown when `source`/`.` targets an app file or agent-only external mount.
 */
export function bash_disallowed_source_target_error() {
	return "bash: source and . cannot load app files or agent-only external mounts; use bash /tmp/<script> for scratch scripts.\n";
}

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
	let force = false;
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
		if (arg === "-f" || arg === "--force") {
			force = true;
			continue;
		}
		if (arg.startsWith("-")) {
			if (!arg.startsWith("--")) {
				const flags = [...arg.slice(1)];
				if (flags.some((flag) => flag === "r" || flag === "R")) {
					recursive = true;
				}
				if (flags.some((flag) => flag === "f")) {
					force = true;
				}
			}
			continue;
		}
		operands.push(arg);
	}
	return { operands, recursive, force };
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
	currentWorkspacePath: string;
	path: string | undefined;
	limit: number;
	cursor: string;
	query: string;
}) {
	const continuationParts = ["Next page:", "search"];
	if (args.path != null) {
		continuationParts.push(
			"--path",
			bash_shell_arg_quote(bash_db_files_path_to_current_workspace_path(args.currentWorkspacePath, args.path)),
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

/**
 * Return the literal query marker for punctuation-heavy single-token searches.
 *
 * Db full-text search can broaden tokens with punctuation, so matching code
 * needs the lowercase literal form to annotate whether each hit contains it.
 */
export function bash_search_command_exact_query_filter(query: string) {
	const trimmedQuery = query.trim();
	return SEARCH_EXACT_SINGLE_TOKEN_REGEX.test(trimmedQuery) && SEARCH_EXACT_PUNCTUATION_TOKEN_REGEX.test(trimmedQuery)
		? trimmedQuery.toLowerCase()
		: null;
}

/**
 * Build the per-hit note for exact-query searches broadened by full-text search.
 *
 * Broad word-level hits stay in the page because suppressing them thins
 * pagination; the note keeps fuzzy full-text matches from being relayed as exact
 * matches.
 */
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

/**
 * Build the exact/word-level split shown in the "Found N results" header.
 *
 * The model relays counts from command output, so give it grounded counts
 * instead of making it count annotated result blocks itself.
 */
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
 * Build the error text for commands that operate on db-backed app files or
 * external mounts when a path operand contains shell glob metacharacters.
 *
 * These commands read, list, or inspect the app file tree or `/.mounts`;
 * they do not expand globs over those db-backed trees. For the common
 * discovery mistake `*.ext`, point the model at `find --extension`, which uses
 * the indexed file path query. `find` itself handles simple extension globs
 * separately and can run that indexed search directly.
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
		`  find -name readme            # indexed app-file path word search\n` +
		`  find --path-query readme     # explicit indexed app-file path word search\n`
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

/**
 * Paginate one indexed query per installed plugin, in plugin-name order, as a
 * single continuous page stream rooted at `/.plugins`.
 *
 * Thin adapter over `pagination_fan_out_paginate`: plugin mounts become the
 * fan-out sources (name key + version-id fingerprint, so installs, uninstalls,
 * and version upgrades invalidate in-flight cursors) and the generic failure
 * names become the command's stderr messages.
 *
 * `runPage` runs the per-plugin indexed query (search, subtree listing, ...)
 * and returns items already mapped to their fan-out shape. The returned
 * `continueCursor` is the raw composite cursor payload; callers store it with
 * `bash_cursor_id_create` like any other cursor.
 */
export async function bash_plugins_fan_out_paginate<TItem>(args: {
	command: string;
	plugins: bash_DbFilesRoots["plugins"];
	/** Resolved raw cursor payload from `bash_cursor_id_resolve`, or null for the first page. */
	cursor: string | null;
	limit: number;
	runPage: (pageArgs: {
		mount: bash_PluginSourceMount;
		innerCursor: string | null;
		numItems: number;
	}) => Promise<{ items: TItem[]; continueCursor: string; isDone: boolean }>;
}) {
	const fanOut = await pagination_fan_out_paginate({
		// Scoping by command rejects cursors created by a different fan-out command.
		scope: `plugins:${args.command}`,
		sources: [...args.plugins.mounts.values()]
			.sort((a, b) => (a.pluginName < b.pluginName ? -1 : 1))
			.map((mount) => ({ key: mount.pluginName, fingerprint: mount.pluginVersionId, source: mount })),
		cursor: args.cursor,
		limit: args.limit,
		runPage: (pageArgs) =>
			args.runPage({ mount: pageArgs.source, innerCursor: pageArgs.innerCursor, numItems: pageArgs.numItems }),
	});
	if (fanOut._nay) {
		return Result({
			_nay: {
				message:
					fanOut._nay.message === "listing changed"
						? `${args.command}: the installed plugin listing changed since this cursor was created; ` +
							"rerun the command without --cursor to restart from a consistent listing."
						: `${args.command}: --cursor does not belong to a ${bash_PLUGINS_MOUNT_ROOT} listing.\n` +
							"Copy the exact Next page command from the previous output, or rerun without --cursor.",
			},
		});
	}
	return fanOut;
}

/**
 * Map a stored plugin-tree path `/<pluginVersionId>/rest` to the fan-out
 * db-files shape `/<pluginName>/rest`, which the `plugins_root` resolution's
 * `renderShellPath` turns into `/.plugins/<pluginName>/rest`.
 */
export function bash_plugins_fan_out_db_files_path(mount: bash_PluginSourceMount, storedPath: string) {
	const versionRootPath = `/${mount.pluginVersionId}`;
	const relativePath =
		storedPath === versionRootPath
			? ""
			: storedPath.startsWith(`${versionRootPath}/`)
				? storedPath.slice(versionRootPath.length)
				: storedPath;
	return `/${mount.pluginName}${relativePath}`;
}

/**
 * Paginate one indexed query per synced external mount, in mount-name order, as a
 * single continuous page stream rooted at `/.mounts`.
 *
 * Sibling of `bash_plugins_fan_out_paginate`: mounts become the fan-out sources
 * (name key + commit-sha fingerprint, so a resync invalidates in-flight cursors).
 */
export async function bash_external_mounts_fan_out_paginate<TItem>(args: {
	command: string;
	externalMounts: bash_DbFilesRoots["externalMounts"];
	/** Resolved raw cursor payload from `bash_cursor_id_resolve`, or null for the first page. */
	cursor: string | null;
	limit: number;
	runPage: (pageArgs: {
		mount: bash_ExternalSourceMount;
		innerCursor: string | null;
		numItems: number;
	}) => Promise<{ items: TItem[]; continueCursor: string; isDone: boolean }>;
}) {
	const fanOut = await pagination_fan_out_paginate({
		// Scoping by command rejects cursors created by a different fan-out command.
		scope: `mounts:${args.command}`,
		sources: [...args.externalMounts.mounts.values()]
			.sort((a, b) => (a.name < b.name ? -1 : 1))
			.map((mount) => ({ key: mount.name, fingerprint: mount.commitSha, source: mount })),
		cursor: args.cursor,
		limit: args.limit,
		runPage: (pageArgs) =>
			args.runPage({ mount: pageArgs.source, innerCursor: pageArgs.innerCursor, numItems: pageArgs.numItems }),
	});
	if (fanOut._nay) {
		return Result({
			_nay: {
				message:
					fanOut._nay.message === "listing changed"
						? `${args.command}: the mount listing changed since this cursor was created; ` +
							"rerun the command without --cursor to restart from a consistent listing."
						: `${args.command}: --cursor does not belong to a ${bash_EXTERNAL_MOUNTS_ROOT} listing.\n` +
							"Copy the exact Next page command from the previous output, or rerun without --cursor.",
			},
		});
	}
	return fanOut;
}

/**
 * Map a stored mount-tree path `/<name>/<commitSha>/rest` to the fan-out
 * db-files shape `/<name>/rest`, which the `external_mounts_root` resolution's
 * `renderShellPath` turns into `/.mounts/<name>/rest`.
 */
export function bash_external_mounts_fan_out_db_files_path(mount: bash_ExternalSourceMount, storedPath: string) {
	const commitRootPath = `/${mount.name}/${mount.commitSha}`;
	const relativePath =
		storedPath === commitRootPath
			? ""
			: storedPath.startsWith(`${commitRootPath}/`)
				? storedPath.slice(commitRootPath.length)
				: storedPath;
	return `/${mount.name}${relativePath}`;
}

// #endregion shared command helpers
// #region reader helpers

/**
 * Limit db-backed reader batches before one command starts many db reads.
 *
 * Stdin and `/tmp` files do not count. App files and external mount files
 * both count because they load db file content from the db.
 */
export function bash_enforce_reader_operand_cap(
	command: string,
	commandCtx: CommandContext,
	currentWorkspacePath: string,
	files: string[],
) {
	let fileOperandCount = 0;
	for (const file of files) {
		if (file === "-") continue;
		const resolvedPath = bash_resolve_path(commandCtx.cwd, file);
		// Mount reads pull whole file bodies from the db too, so count them against the same batch cap.
		if (
			bash_is_path_under_current_workspace_path(currentWorkspacePath, resolvedPath) ||
			bash_is_path_under_read_only_mounts(resolvedPath)
		) {
			fileOperandCount++;
		}
	}
	if (fileOperandCount > bash_READER_FILE_OPERAND_MAX) {
		return {
			stdout: "",
			stderr:
				`${command}: db-backed file reads are limited to ${bash_READER_FILE_OPERAND_MAX} files per command (you requested ${fileOperandCount}). ` +
				`This is a per-command batch limit, not a total ceiling: to READ these files, ${command} them in batches of ${bash_READER_FILE_OPERAND_MAX} or fewer across multiple commands. ` +
				`To FIND which files mention something, use search (it returns matching snippets, not whole files).\n`,
			exitCode: bash_COMMAND_EXIT_USAGE,
		};
	}
	return null;
}

/**
 * Return the current byte size for a loaded db file before deciding
 * whether reader commands can read it inline.
 *
 * This reads metadata only: an unsaved edit's size wins over the committed
 * asset size, and the file body/chunks are never loaded. There is no local
 * cache because an earlier command in the same bash run may have changed the
 * unsaved edit.
 */
export async function bash_get_db_file_byte_size(args: {
	ctx: ActionCtx;
	ctxData: bash_DbFilesFsOptions["ctxData"];
	dbFilesDoc: Doc<"files_nodes">;
}) {
	if (args.dbFilesDoc.kind !== "file" || args.dbFilesDoc.assetId == null) {
		return null;
	}

	const organizationId = args.ctxData.organizationId;
	const workspaceId = args.ctxData.workspaceId;
	if (
		files_node_has_editable_yjs_state(args.dbFilesDoc) &&
		!organizations_is_global_organization_id(organizationId) &&
		!organizations_is_reserved_workspace_id(workspaceId)
	) {
		const pendingUpdate = (await args.ctx.runQuery(internal.files_pending_updates.get_by_file_node, {
			organizationId,
			workspaceId,
			userId: args.ctxData.userId,
			fileNodeId: args.dbFilesDoc._id,
		})) as files_pending_updates_get_by_file_node_Result;
		if (pendingUpdate) {
			return pendingUpdate.size;
		}
	}

	const asset = (await args.ctx.runQuery(internal.r2.get_asset_by_id, {
		organizationId: args.ctxData.organizationId,
		workspaceId: args.ctxData.workspaceId,
		assetId: args.dbFilesDoc.assetId,
	})) as get_asset_by_id_Result;
	return asset?.size ?? null;
}

/**
 * Build stderr guidance for db files whose body cannot be returned as text.
 *
 * The sibling paths are hints for generated Markdown or plain text output.
 * Callers keep this advisory on stderr so it cannot be piped as file content.
 */
export function bash_build_unreadable_file_advisory(
	currentWorkspacePath: string,
	normalizedPath: string,
	contentType: string | undefined,
) {
	const shellPath = bash_db_files_path_to_current_workspace_path(currentWorkspacePath, normalizedPath);
	const lastSlashIndex = normalizedPath.lastIndexOf("/");
	const lastDotIndex = normalizedPath.lastIndexOf(".");
	const dbFilesPathWithoutExtension =
		lastDotIndex > lastSlashIndex ? normalizedPath.slice(0, lastDotIndex) : normalizedPath;
	const relatedReadablePaths = Array.from(
		new Set([
			bash_db_files_path_to_current_workspace_path(currentWorkspacePath, `${normalizedPath}.md`),
			bash_db_files_path_to_current_workspace_path(currentWorkspacePath, `${dbFilesPathWithoutExtension}.md`),
			bash_db_files_path_to_current_workspace_path(currentWorkspacePath, `${dbFilesPathWithoutExtension}.txt`),
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
