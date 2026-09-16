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
	InterpreterStateSnapshot,
	MkdirOptions,
	RmOptions,
} from "just-bash/browser";
import type { Infer } from "convex/values";
import { internal } from "../convex/_generated/api.js";
import type { Doc, Id } from "../convex/_generated/dataModel";
import type { ActionCtx } from "../convex/_generated/server.js";
import type { bash_shell_state_validator } from "../convex/schema.ts";
import type {
	files_nodes_create_private_node_by_path_Result,
	files_nodes_get_visible_entry_by_path_Result,
	files_nodes_read_file_content_from_chunks_Result,
} from "../convex/files_nodes.ts";
import type { files_nodes_get_file_last_available_text_content_by_path_Result } from "../convex/files_nodes_content.ts";
import type { prepare_file_pending_update_for_agent_Result } from "../convex/files_pending_updates.ts";
import type { get_asset_by_id_Result } from "../convex/r2.ts";
import { Result } from "common/errors-as-values-utils.ts";
import {
	files_MAX_TEXT_CONTENT_BYTES,
	files_get_normalized_node_path_segments,
	files_get_utf8_byte_size,
	files_normalize_lf_newlines,
	files_normalize_special_node_path,
	files_pending_update_content_is_stale,
	files_pending_update_has_content,
	type files_PendingTarget,
} from "../shared/files.ts";
import { math_clamp, should_never_happen } from "../shared/shared-utils.ts";
import { path_name_of } from "../shared/paths.ts";
import {
	organizations_is_reserved_workspace_id,
	organizations_is_global_organization_id,
} from "../shared/organizations.ts";
import { pagination_fan_out_paginate } from "../shared/pagination.ts";

// #region bash constants and path helpers

export const bash_HOME = "/home/cloud-usr";
export const bash_APP_MOUNT_PATH = `${bash_HOME}/w`;
export const bash_TMP_MOUNT = "/tmp";

/**
 * Read-only mount with one folder per shell of the thread: `/shells/<name>/transcript`.
 */
export const bash_SHELLS_MOUNT = "/shells";

/**
 * Keep the stored shell state and the engine snapshot in step. A field that one side has and the
 * other does not fails one of the four lines below, and the message names the field. The declaration
 * is ambient, so it needs no value and no suppression. Do not turn it into the unused `type _Name`
 * alias this repo uses elsewhere. That form needs a suppression comment on the line above it. If the
 * declaration then fits on one line, the suppression hides the drift error too, and this check stops
 * reporting anything.
 *
 * The first pair compares the two as `Required`, because a field that one side marks optional and
 * the other side does not have at all is assignable in both directions. The second pair compares
 * them as they are, because `Required` erases the difference when both sides have the field and only
 * one of them marks it optional. `Required` reaches the top level only, so a field added as optional
 * inside a nested object passes; a nested field that is required, or whose type changed, still fails.
 * The stored `options` and `shoptOptions` take any name, so a new boolean shell option passes too.
 */
type bash_ShellState = Infer<typeof bash_shell_state_validator>;
type bash_Assignable<_From extends To, To> = true;
declare const bash_shell_state_matches_snapshot: [
	bash_Assignable<Required<bash_ShellState>, Required<InterpreterStateSnapshot>>,
	bash_Assignable<Required<InterpreterStateSnapshot>, Required<bash_ShellState>>,
	bash_Assignable<bash_ShellState, InterpreterStateSnapshot>,
	bash_Assignable<InterpreterStateSnapshot, bash_ShellState>,
];

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
 * materialized chunks, so a large file is never loaded in one shot.
 */
export const bash_READ_INLINE_MAX_BYTES = 64 * 1024;

/**
 * Per-page line cap for head/sed/tail against a large file.
 *
 * Must match the backend `files_READ_RANGE_MAX_LINES`.
 */
export const bash_READ_HEAD_LARGE_FILE_MAX_LINES = 500;

/**
 * Cap on distinct paths one Bash call records for scoped-guidance lookup. Each path fans out to
 * ancestor AGENTS.md reads afterwards, so the cap bounds that work per call.
 */
const bash_OBSERVED_PATHS_MAX = 100;
export const bash_COMMAND_EXIT_FAILURE = 1;
export const bash_COMMAND_EXIT_USAGE = 2;
/**
 * Only `wait`, `jobs` and `jobs -o` return 3 on their own: the job is still running. A job's own
 * script can exit 3 as well, and `wait` reports a waited job's stored code as it is, so 3 does not
 * prove the job is live. A model that loops on 3 alone should ask `jobs` for the status word.
 */
export const bash_COMMAND_EXIT_STILL_RUNNING = 3;
export const bash_COMMAND_EXIT_CANNOT_EXECUTE = 126;
export const bash_COMMAND_EXIT_NOT_FOUND = 127;
/**
 * 128 + 15 (SIGTERM): the user stopped the job. The job worker reports it from its own abort reason.
 * A script that exits 143 by itself lands here too, because `finish_bash_job` reads a stored 143 back
 * into the Activity status `canceled`, and the job then shows as stopped everywhere.
 */
export const bash_COMMAND_EXIT_STOPPED = 143;
/**
 * The job used its whole budget. The worker reports it from its own abort reason, and a script that
 * exits 124 by itself is read back as `timed_out` the same way.
 */
export const bash_COMMAND_EXIT_TIMED_OUT = 124;
/**
 * The abort reason for a user stop, a lost permission or a deleted job row. Any other reason is
 * a deadline and reports 124.
 */
export const bash_ABORT_REASON_STOPPED = "job stopped";

/**
 * The exit code one job reports, from its Activity and the code its worker stored. A job can be
 * declared dead before its worker stops: a watchdog or a Stop settles the Activity while a slow
 * worker is still finishing, and the worker then stores its own code under a `timed_out` or
 * `canceled` Activity. The feed, `jobs -a` and the finished-job note all show the Activity status
 * word. `wait` and the `jobs -o` marker read the Activity first and report a code that agrees
 * with that word, instead of the late result's code. A job with no stored code at all (stopped
 * before a worker ran, a crashed worker, or a result the cleanup cron already stripped) answers
 * from the Activity too: `succeeded` is 0, `timed_out` 124, `canceled` 143 and everything else 1.
 */
export function bash_job_exit_code(activityStatus: Doc<"activities">["status"], storedExitCode: number | null) {
	if (activityStatus === "timed_out") return bash_COMMAND_EXIT_TIMED_OUT;
	if (activityStatus === "canceled") return bash_COMMAND_EXIT_STOPPED;
	return storedExitCode ?? (activityStatus === "succeeded" ? 0 : bash_COMMAND_EXIT_FAILURE);
}

/**
 * How many job numbers `wait` may name in one call. The door reads one index row per number, so
 * the list has to be bounded somewhere: `wait {1..5000}` is 14 characters for the agent to type.
 * `wait` refuses a longer list with a usage error, and the door refuses it again.
 */
export const bash_JOB_NUMBERS_MAX_COUNT = 12;
export const bash_NON_NEGATIVE_INTEGER_REGEX = /^\d+$/u;
export const bash_TERMINAL_LINE_ENDING_REGEX = /\r\n?/g;
export const bash_SHELL_COMMENT_LINE_REGEX = /^\s*#.*$/gm;
export const bash_WHITESPACE_RUN_REGEX = /\s+/u;

const PAGINATION_CURSOR_TTL_MS = 24 * 60 * 60 * 1000;
const BACKSLASH_REGEX = /\\/g;
const SINGLE_QUOTE_REGEX = /'/g;
const SIGNED_INTEGER_REGEX = /^-?\d+$/u;
const LONE_SURROGATE_REGEX = /[\ud800-\udfff]/gu;
const SIMPLE_EXTENSION_GLOB_REGEX = /^\*\.([a-z0-9][a-z0-9_-]*)$/iu;
const SEARCH_EXACT_SINGLE_TOKEN_REGEX = /^\S+$/u;
const SEARCH_EXACT_PUNCTUATION_TOKEN_REGEX = /[-_.:@]/u;
const SHELL_ARG_SAFE_UNQUOTED_REGEX = /^[A-Za-z0-9_/:.,=+@-]+$/;
const LISTING_PAGE_LIMIT_MAX = 200;
const BASH_REGEX_PATTERN_MAX_LENGTH = 200;
const textEncoder = new TextEncoder();

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

/**
 * Keep the first `maxChars` UTF-16 code units of `text`, and never cut a character in half. A
 * character outside the basic range takes two code units, so a cut at a fixed count can land between
 * them, and Convex refuses a string that holds half a character (`.agents/skills/convex/SKILL.md`:
 * strings "must be valid Unicode sequences"). Every Bash cut that carries command output or a script
 * into a document goes through here. Same rule as the chunk cut in
 * server/files-plain-text-chunking.ts. A cut is not the only way to get half a character, so
 * `bash_text_well_formed` repairs what the script itself printed.
 */
export function bash_text_head(text: string, maxChars: number) {
	if (text.length <= maxChars) return text;
	const codeUnit = text.charCodeAt(maxChars - 1);
	// A high surrogate at the last kept position is the first half of a character. Drop it.
	const end = codeUnit >= 0xd800 && codeUnit <= 0xdbff ? maxChars - 1 : maxChars;
	return text.slice(0, end);
}

/**
 * Replace every half of a character with U+FFFD. The shell can produce one half on its own, with no
 * cut involved: `printf '\ud83c'` is a valid command. Convex refuses a string that holds one, and it
 * refuses the whole call: we ran `printf 'A\ud83cB'` against the dev deployment and the Bash call
 * failed with "Invalid arguments provided" and stored nothing. The `u` flag makes the pattern read
 * whole characters, so a complete pair is one character and does not match; only an unpaired half
 * does. `is_well_formed_string` in convex/plugins_data_http.ts asks the same question with a hand
 * written scan, and the plugin data route refuses such a string instead of repairing it, because
 * there the string is a caller's input and here it is the shell's own output.
 */
export function bash_text_well_formed(text: string) {
	return text.replace(LONE_SURROGATE_REGEX, "�");
}

/**
 * Walk only plain objects and arrays. Repair every string value. Leave every other value as it
 * is, so file bytes and ids reach the backend untouched. Leave object field names as they are
 * too: Convex already refuses a non-ASCII key, and U+FFFD is itself non-ASCII, so repairing the
 * key would only change the error text and could merge two keys into one.
 */
function value_well_formed(value: unknown): unknown {
	if (typeof value === "string") return bash_text_well_formed(value);
	if (Array.isArray(value)) return value.map(value_well_formed);
	if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, value_well_formed(entry)]));
	}
	return value;
}

/**
 * Repair every string of a value the shell sends to Convex or returns to the model.
 */
export function bash_value_well_formed<T>(value: T) {
	return value_well_formed(value) as T;
}

/**
 * The action ctx every Bash call uses, with one repair on the way out. Half a character does not only
 * come out of a command's output: `mkdir "/tmp/$(printf '\ud83c')"` names a file with one, and that
 * name then travels as a mutation argument, as does the saved cwd, an observed path and a copy
 * destination. The same repair also changes a saved variable's value and a saved function's
 * text, so a paused job continues with U+FFFD where it printed half a character. Convex refuses
 * the whole call for any of them, so a call that already did its work would die at its last
 * write. Wrapping the ctx once covers every query, mutation and action the shell sends,
 * including the ones each command sends for itself. The same shape as the accounting wrapper in
 * convex/files_pending_update_runs.ts.
 */
export function bash_well_formed_ctx(ctx: ActionCtx): ActionCtx {
	// A function reference is not a value the shell built, so repair the args object only.
	const repaired = (args: unknown[]) => (args.length > 1 ? [args[0], bash_value_well_formed(args[1])] : args);

	// Each Proxy passes the receiver of the call on to the method it wraps, so taking the method here
	// does not lose its `this`, which is what `unbound-method` guards against. The object below carries
	// every own member of the real ctx, so that `this` still reaches all of them.
	return {
		...ctx,
		// eslint-disable-next-line @typescript-eslint/unbound-method
		runQuery: new Proxy(ctx.runQuery, {
			apply(method, receiver, args: unknown[]) {
				return Reflect.apply(method, receiver, repaired(args));
			},
		}),
		// eslint-disable-next-line @typescript-eslint/unbound-method
		runMutation: new Proxy(ctx.runMutation, {
			apply(method, receiver, args: unknown[]) {
				return Reflect.apply(method, receiver, repaired(args));
			},
		}),
		// eslint-disable-next-line @typescript-eslint/unbound-method
		runAction: new Proxy(ctx.runAction, {
			apply(method, receiver, args: unknown[]) {
				return Reflect.apply(method, receiver, repaired(args));
			},
		}),
	};
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
	target?: files_PendingTarget | { kind: "root" };
	path: Doc<"files_nodes">["path"];
	name: Doc<"files_nodes">["name"];
	kind: Doc<"files_nodes">["kind"];
	updatedAt: Doc<"files_nodes">["updatedAt"];
	updatedBy?: Doc<"files_nodes">["updatedBy"] | "";
	contentType?: Doc<"files_nodes">["contentType"];
	assetId: Doc<"files_nodes">["assetId"];
	contentSize?: number;
	textKind: Doc<"files_nodes">["textKind"];
	preparing?: boolean;
};

export type bash_DbFilesFsOptions = {
	ctx: ActionCtx;
	ctxData: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		organizationName: string;
		workspaceName: string;
		userId: Id<"users">;
		/** Chat thread running this bash call; stamped on the pending updates mv/cp create. */
		threadId: Id<"ai_chat_threads"> | null;
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
	readonly contentType: string | null | undefined;

	constructor(args: { shellPath: string; contentType: string | null | undefined }) {
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
		// source mounts. Read-only mount writes need separate messages because no tool
		// can edit read-only mounted sources. The tenant branch is only reachable from
		// still-unsupported operations (rm, fs-level cp/mv, chmod, symlink, link).
		const message =
			readOnlySource === "codebase"
				? `EROFS: read-only file system, '${normalizedPath}'. '${bash_EXTERNAL_MOUNTS_ROOT}' is a read-only mount of an external source.`
				: readOnlySource === "plugins"
					? `EROFS: read-only file system, '${normalizedPath}'. '${bash_PLUGINS_MOUNT_ROOT}' is a read-only mount of installed plugin sources.`
					: `EROFS: read-only file system, '${normalizedPath}'. This operation is not supported for app files. Create or overwrite app files with shell redirection (> or a heredoc), append with >>, or use edit_file for targeted edits.`;
		super(message);
		this.name = "ReadOnlyFileSystemError";
		this.path = normalizedPath;
	}
}

/**
 * Decode Just Bash write content to a UTF-8 text string.
 *
 * Mirrors just-bash `toBuffer` for the encodings our callers use: redirection and
 * `tee` pass `"binary"` (latin1, one byte per char code) for byte-shaped output and
 * plain utf8 strings otherwise; builtin `touch` passes no encoding. App files store
 * UTF-8 Markdown/text, so byte content that is not valid UTF-8 is rejected.
 */
function decode_write_content(
	content: FileContent,
	options: Parameters<IFileSystem["writeFile"]>[2],
	shellPath: string,
): string {
	const encoding = typeof options === "string" ? options : options?.encoding;
	let bytes: Uint8Array;
	if (typeof content === "string") {
		if (encoding !== "binary" && encoding !== "latin1") {
			return content;
		}
		bytes = new Uint8Array(content.length);
		for (let index = 0; index < content.length; index++) {
			bytes[index] = content.charCodeAt(index) & 0xff;
		}
	} else {
		bytes = content;
	}
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new Error(
			`cannot write '${shellPath}': content is not valid UTF-8 text; app files store Markdown and plain text only`,
		);
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
	/**
	 * Tenant app tree only: resolve lookups through this user's pending path overlay, so the
	 * proposer's later reads see their pending moves applied. Mounted sources never have
	 * pending proposals, so they stay on the committed lookup.
	 */
	readonly overlayUserId: Id<"users"> | undefined;
	pathIndexTruncated = false;
	private entryCache = new Map<string, DbFilesCacheEntry>();
	private contentCache = new Map<string, string>();
	/** App paths this call touched, collected so the result can load their scoped AGENTS.md guidance. */
	readonly observedPaths = new Set<string>();
	/** Set when the observed-path cap above dropped entries. */
	observedPathsTruncated = false;
	/** Command-owned per-run caches (cat's content cache) cleared together with resetProposalCaches. */
	private linkedProposalCaches: Array<Map<string, string>> = [];

	constructor(options: bash_DbFilesFsOptions) {
		this.ctx = options.ctx;
		this.ctxData = options.ctxData;
		this.currentWorkspacePath = options.currentWorkspacePath;
		this.allowDbFilesMkdir = options.allowDbFilesMkdir;
		this.readOnlySource = options.readOnlySource;
		this.overlayUserId = options.readOnlySource == null ? options.ctxData.userId : undefined;
		this.dbFilesPathPrefix = options.dbFilesPathPrefix == null ? "" : bash_normalize_path(options.dbFilesPathPrefix);
		this.dbFilesRootPath =
			this.dbFilesPathPrefix === "" || this.dbFilesPathPrefix === "/" ? "/" : this.dbFilesPathPrefix;
		this.seedRootEntry();
	}

	// A prefixed mount root (`/<prefix>`) is a real files_nodes folder, not the scope's
	// synthetic "/" root: keep the seeded entry id-less so callers resolve the real node id
	// instead of inheriting files_ROOT_ID and listing the reserved scope root's children.
	private seedRootEntry() {
		this.rememberEntry({
			...(this.dbFilesRootPath === "/" ? { target: { kind: "root" as const } } : {}),
			path: this.dbFilesRootPath,
			name: "",
			kind: "folder",
			updatedAt: 0,
			assetId: null,
			textKind: null,
		});
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
			this.observePath(normalizedPath);
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
		const shellPath = bash_db_files_path_to_current_workspace_path(
			this.currentWorkspacePath,
			bash_normalize_path(path),
		);
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
			overlayUserId: this.overlayUserId,
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
			internal.files_nodes_content.get_file_last_available_text_content_by_path,
			{
				organizationId: this.ctxData.organizationId,
				workspaceId: this.ctxData.workspaceId,
				userId: this.ctxData.userId,
				path: dbFilesPath,
				overlayUserId: this.overlayUserId,
			},
		) as Promise<files_nodes_get_file_last_available_text_content_by_path_Result>;
		const [fileContent, cacheEntry] = await Promise.all([fileContentPromise, this.getEntry(dbFilesPath)]);

		if (!fileContent) {
			if (cacheEntry?.preparing) throw new Error(`Draft is still preparing: '${this.shellPathOf(dbFilesPath)}'`);
			if (cacheEntry?.kind === "file") {
				throw new bash_DbFilesContentUnavailableError({
					shellPath: this.shellPathOf(dbFilesPath),
					contentType: cacheEntry.contentType,
				});
			}
			if (cacheEntry?.kind === "folder") {
				throw new Error(`EISDIR: illegal operation on a directory, read '${this.shellPathOf(dbFilesPath)}'`);
			}
			throw new Error(`ENOENT: no such file or directory, open '${this.shellPathOf(dbFilesPath)}'`);
		}

		this.contentCache.set(dbFilesPath, fileContent.content);
		if (!cacheEntry) {
			this.rememberEntry({
				target: fileContent.target,
				path: dbFilesPath,
				name: path_name_of(dbFilesPath),
				kind: "file",
				updatedAt: Date.now(),
				assetId: null,
				textKind: null,
			});
		}
		return fileContent.content;
	}

	async readFileBuffer(path: string) {
		return textEncoder.encode(await this.readFile(path));
	}

	async writeFile(path: string, content: FileContent, options?: Parameters<IFileSystem["writeFile"]>[2]) {
		await this.proposeWrite(path, content, options, "overwrite");
	}

	async appendFile(path: string, content: FileContent, options?: Parameters<IFileSystem["appendFile"]>[2]) {
		await this.proposeWrite(path, content, options, "append");
	}

	/**
	 * Write an app file from shell redirection, `tee`, or builtin `touch`, Agent mode only.
	 * Every write goes to the pending unstaged branch. A missing target reserves a private path.
	 *
	 * Thrown errors become the whole command's stderr (redirection has no per-write catch
	 * in Just Bash), so every message must tell the model what to do instead.
	 *
	 * Compound redirects (`{ ...; } > f`, bare `> f`, `exec > f`) pre-truncate with an
	 * empty write before the content write: two upserts on the same pending doc, correct
	 * end state, and both writes use the same private target.
	 */
	private async proposeWrite(
		path: string,
		content: FileContent,
		options: Parameters<IFileSystem["writeFile"]>[2],
		mode: "overwrite" | "append",
	) {
		const normalizedPath = bash_normalize_path(path);
		if (this.readOnlySource != null) {
			throw this.readOnlyFileSystemError(normalizedPath);
		}

		const requestedDbFilesPath = this.toDbFilesPath(normalizedPath);
		const shellPath = this.shellPathOf(requestedDbFilesPath);

		if (!this.allowDbFilesMkdir) {
			throw new Error(
				`App file writes are available in Agent mode. Ask mode cannot create or change app files: '${shellPath}'.`,
			);
		}

		if (bash_GLOB_METACHARACTER_REGEX.test(requestedDbFilesPath)) {
			throw new Error(`app file glob patterns are not supported: '${shellPath}'`);
		}

		// An existing occupant at the requested path always wins untouched: draft-name
		// normalization (README casing, extension fixes) must never redirect a write away from
		// a real target. Only a missing target normalizes, so private creation names new files
		// exactly like cp and the UI create flow.
		let dbFilesPath = requestedDbFilesPath;
		// Listing caches omit document shape. Writes need the current editable-text marker.
		this.entryCache.delete(dbFilesPath);
		let entry = await this.getEntry(dbFilesPath);

		if (!entry) {
			dbFilesPath = files_normalize_special_node_path("file", requestedDbFilesPath);
			if (dbFilesPath !== requestedDbFilesPath) {
				dbFilesPath = await this.ctx.runQuery(internal.files_nodes.resolve_new_node_path, {
					organizationId: this.ctxData.organizationId,
					workspaceId: this.ctxData.workspaceId,
					path: requestedDbFilesPath,
					normalizedPath: dbFilesPath,
					overlayUserId: this.overlayUserId,
				});
				if (dbFilesPath === requestedDbFilesPath) {
					throw new Error(`cannot write '${shellPath}': Permission denied`);
				}
				this.entryCache.delete(dbFilesPath);
				entry = await this.getEntry(dbFilesPath);
			}

			const normalizedSegments = files_get_normalized_node_path_segments({
				kind: "file",
				nameOrPath: dbFilesPath,
				// New special names are canonicalized above. The extension is a content-type hint;
				// an unknown or missing extension becomes plain text.
				fileNamePolicy: "keep_extension",
			});

			if (!normalizedSegments || "validationMessage" in normalizedSegments) {
				throw new Error(
					`cannot write '${shellPath}': invalid app file path${
						normalizedSegments ? `: ${normalizedSegments.validationMessage}` : ""
					}`,
				);
			}

			const normalizedDbFilesPath = `/${normalizedSegments.normalizedPathSegments.join("/")}`;

			if (normalizedDbFilesPath !== dbFilesPath) {
				// The normalized name can land on an existing node; that node becomes the
				// overwrite target (cp's replace-target re-check). Creating at a silently
				// renamed path is a trap instead: the redirect reports success while the
				// requested path stays missing, so refuse and name the valid path.
				this.entryCache.delete(normalizedDbFilesPath);
				entry = await this.getEntry(normalizedDbFilesPath);
				if (!entry) {
					throw new Error(
						`cannot write '${shellPath}': app file names are normalized; write to '${this.shellPathOf(normalizedDbFilesPath)}' instead`,
					);
				}
				dbFilesPath = normalizedDbFilesPath;
			}
		}

		if (entry?.kind === "folder") {
			throw new Error(`EISDIR: illegal operation on a directory, open '${shellPath}'`);
		}

		if (entry?.preparing) throw new Error(`cannot write '${shellPath}': this draft is still preparing`);
		// Private text owns a sealed state before it has a saved asset.
		if (entry?.kind === "file" && entry.textKind === null) {
			throw new Error(
				`cannot write '${shellPath}': this file's content type ('${entry.contentType ?? "unknown"}') is not editable as text`,
			);
		}

		const chunk = decode_write_content(content, options, shellPath);
		const normalizedChunk = files_normalize_lf_newlines(chunk);

		if (files_get_utf8_byte_size(normalizedChunk) > files_MAX_TEXT_CONTENT_BYTES) {
			throw new Error(
				`cannot write '${shellPath}': content exceeds the ${files_MAX_TEXT_CONTENT_BYTES}-byte app file limit`,
			);
		}

		// Writes only run for the tenant app db-files root: the mounted sources threw above,
		// so the scope here is never reserved. Narrow the union for the workspace-only functions.
		const { organizationId, workspaceId, userId, threadId } = this.ctxData;
		if (
			organizations_is_global_organization_id(organizationId) ||
			organizations_is_reserved_workspace_id(workspaceId)
		) {
			throw should_never_happen("app file write reached the reserved mount scope", { organizationId, workspaceId });
		}

		let target: files_PendingTarget;
		if (entry?.target && entry.target.kind !== "root") {
			target = entry.target;
		} else {
			const nearestAncestor = await this.getNearestVisibleAncestor(dbFilesPath);
			if (nearestAncestor?.kind === "file") {
				throw new Error(
					`cannot write '${shellPath}': '${this.shellPathOf(nearestAncestor.path)}' is a file, not a folder`,
				);
			}
			const created = (await this.ctx.runMutation(internal.files_nodes.create_private_node_by_path, {
				organizationId,
				workspaceId,
				userId,
				path: dbFilesPath,
				kind: "file",
				threadId: threadId ?? undefined,
			})) as files_nodes_create_private_node_by_path_Result;
			if (created._nay) {
				throw new Error(`cannot write '${shellPath}': ${created._nay.message}`);
			}
			target = created._yay.target;
			if (created._yay.created) {
				const written = await files_agent_write_file_text(this.ctx, {
					organizationId,
					workspaceId,
					userId,
					target,
					operationBatchId: created._yay.operationBatchId!,
					pendingUpdateId: created._yay.pendingUpdateId!,
					unstagedText: normalizedChunk,
					threadId: threadId ?? undefined,
				});
				this.resetProposalCaches();
				if (written._nay) throw new Error(`cannot write '${shellPath}': ${written._nay.message}`);
				return;
			}
		}

		for (let attempt = 0; ; attempt += 1) {
			// Prepare before reading or opening a write batch: preparation uses its own batch.
			const prepared = (await this.ctx.runAction(internal.files_pending_updates.prepare_file_pending_update_for_agent, {
				organizationId,
				workspaceId,
				userId,
				target,
			})) as prepare_file_pending_update_for_agent_Result;
			if (prepared._nay) {
				throw new Error(`cannot write '${shellPath}': ${prepared._nay.message}`);
			}

			// Use full chunks, not capped readFile output. Keep exact Markdown bytes when
			// available; the Yjs action is the fallback for text not served by chunks.
			let currentContent: {
				target: files_PendingTarget;
				content: string;
				pendingUpdateId: Id<"files_pending_updates"> | null;
				pendingUpdateBaseStateId?: Id<"files_pending_update_yjs_states">;
			} | null = (await this.ctx.runQuery(internal.files_nodes.read_file_content_from_chunks, {
				organizationId,
				workspaceId,
				userId,
				path: dbFilesPath,
				overlayUserId: userId,
				mode: { kind: "full", maxBytes: files_MAX_TEXT_CONTENT_BYTES },
			})) as files_nodes_read_file_content_from_chunks_Result;
			if (!currentContent) {
				currentContent = (await this.ctx.runAction(
					internal.files_nodes_content.get_file_last_available_text_content_by_path,
					{
						organizationId,
						workspaceId,
						userId,
						path: dbFilesPath,
						overlayUserId: userId,
					},
				)) as files_nodes_get_file_last_available_text_content_by_path_Result;
			}
			if (!currentContent) {
				throw new Error(
					`cannot write '${shellPath}': the file changed while the command was running. Re-run the command.`,
				);
			}

			const newText = mode === "append" ? currentContent.content + normalizedChunk : normalizedChunk;
			if (files_get_utf8_byte_size(newText) > files_MAX_TEXT_CONTENT_BYTES) {
				throw new Error(
					`cannot write '${shellPath}': content exceeds the ${files_MAX_TEXT_CONTENT_BYTES}-byte app file limit`,
				);
			}
			if (currentContent.target.kind !== target.kind || currentContent.target.id !== target.id) {
				throw new Error(`cannot write '${shellPath}': the target changed. Re-run the command.`);
			}
			const written = await files_agent_write_file_text(this.ctx, {
				organizationId,
				workspaceId,
				userId,
				target,
				pendingUpdateId: currentContent.pendingUpdateId ?? undefined,
				// Append depends on the text read above; a full overwrite replaces it deliberately.
				expectedBaseStateId: mode === "append" ? (currentContent.pendingUpdateBaseStateId ?? null) : undefined,
				unstagedText: newText,
				threadId: threadId ?? undefined,
			});

			if (written._nay) {
				if (attempt === 0 && written._nay.name === "pending_content_changed") continue;
				throw new Error(`cannot write '${shellPath}': ${written._nay.message}`);
			}
			// Later commands chained in this same bash call must see the new proposal.
			this.resetProposalCaches();
			return;
		}
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
		const requestedDbFilesPath = this.toDbFilesPath(normalizedPath);
		let dbFilesPath = requestedDbFilesPath;
		if (bash_GLOB_METACHARACTER_REGEX.test(dbFilesPath)) {
			throw new Error(`app file glob patterns are not supported: '${this.shellPathOf(dbFilesPath)}'`);
		}
		let existing = await this.getEntry(dbFilesPath);
		const normalizedDbFilesPath = files_normalize_special_node_path("folder", dbFilesPath);
		if (!existing && normalizedDbFilesPath !== dbFilesPath) {
			dbFilesPath = await this.ctx.runQuery(internal.files_nodes.resolve_new_node_path, {
				organizationId: this.ctxData.organizationId,
				workspaceId: this.ctxData.workspaceId,
				path: dbFilesPath,
				normalizedPath: normalizedDbFilesPath,
				overlayUserId: this.overlayUserId,
			});
			if (dbFilesPath === requestedDbFilesPath) {
				throw new Error(`cannot create '${this.shellPathOf(dbFilesPath)}': Permission denied`);
			}
			existing = await this.getEntry(dbFilesPath);
		}
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
		} else {
			// -p creates missing parents: reject when the nearest existing visible ancestor is
			// a file (committed, or a pending move's claim), like a real filesystem's ENOTDIR.
			const nearestAncestor = await this.getNearestVisibleAncestor(dbFilesPath);
			if (nearestAncestor?.kind === "file") {
				throw new Error("Not a directory");
			}
		}

		// mkdir only runs for the tenant app db-files root: the external mount and plugin
		// source roots pass allowDbFilesMkdir=false and threw above, so the scope here is never
		// reserved. Narrow the union before the workspace-only mutation, which declares strict ids.
		const { organizationId, workspaceId, userId } = this.ctxData;
		if (
			organizations_is_global_organization_id(organizationId) ||
			organizations_is_reserved_workspace_id(workspaceId)
		) {
			throw should_never_happen("mkdir reached the reserved mount scope", { organizationId, workspaceId });
		}
		const created = (await this.ctx.runMutation(internal.files_nodes.create_private_node_by_path, {
			organizationId,
			workspaceId,
			userId,
			path: dbFilesPath,
			kind: "folder",
			threadId: this.ctxData.threadId ?? undefined,
		})) as files_nodes_create_private_node_by_path_Result;
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		this.resetProposalCaches();
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
		// Builtin touch always calls utimes after creating or finding its target. App files
		// keep their own updatedAt, so Agent-mode app-tree utimes is a silent no-op; mounts
		// and Ask mode keep rejecting like every other write.
		if (this.readOnlySource != null) {
			throw this.readOnlyFileSystemError(path);
		}
		if (!this.allowDbFilesMkdir) {
			const shellPath = this.shellPathOf(this.toDbFilesPath(bash_normalize_path(path)));
			throw new Error(
				`App file writes are available in Agent mode. Ask mode cannot create or change app files: '${shellPath}'.`,
			);
		}
	}

	/**
	 * Drop the per-run entry/content caches after a command
	 * changes the user's proposal set, so later commands chained in the same bash
	 * call see the new visible tree instead of the view cached before the proposal.
	 */
	resetProposalCaches() {
		this.entryCache.clear();
		this.contentCache.clear();
		for (const cache of this.linkedProposalCaches) {
			cache.clear();
		}
		this.seedRootEntry();
	}

	/**
	 * Link a command-owned cache so resetProposalCaches clears it too.
	 */
	linkProposalCache(cache: Map<string, string>) {
		this.linkedProposalCaches.push(cache);
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
					assetId: null,
					textKind: null,
				});
			}
		}
		this.entryCache.set(normalizedPath, {
			...cacheEntry,
			path: normalizedPath,
		});
	}

	observePath(path: string) {
		if (this.readOnlySource != null) return;
		if (this.observedPaths.size >= bash_OBSERVED_PATHS_MAX && !this.observedPaths.has(path)) {
			this.observedPathsTruncated = true;
			return;
		}
		this.observedPaths.add(path);
	}

	async getEntry(path: string, recordPath = true) {
		const normalizedPath = bash_normalize_path(path);
		if (recordPath) this.observePath(normalizedPath);
		const cached = this.entryCache.get(normalizedPath);
		// Synthetic parent folders make descendant paths navigable. Except for the
		// synthetic root, only tagged targets prove that an app path exists.
		if (cached && (normalizedPath === "/" || cached.target != null)) {
			return cached;
		}

		const entry = (await this.ctx.runQuery(internal.files_nodes.get_visible_entry_by_path, {
			organizationId: this.ctxData.organizationId,
			workspaceId: this.ctxData.workspaceId,
			visibilityUserId: this.ctxData.userId,
			path: normalizedPath,
			overlayUserId: this.overlayUserId,
		})) as files_nodes_get_visible_entry_by_path_Result;

		if (!entry) {
			return null;
		}

		// The overlay can present a moved node here: cache it under the requested path,
		// never the node's committed path (identical without an overlay).
		const intent = entry.kind === "private" ? entry.pendingUpdate.createIntent : undefined;
		const replacement = entry.kind === "saved" ? entry.pendingUpdate?.pendingReplacement : undefined;
		const cacheEntry: DbFilesCacheEntry = {
			target: entry.kind === "saved" ? { kind: "saved", id: entry.node._id } : { kind: "private", id: entry.node._id },
			path: normalizedPath,
			name: path_name_of(normalizedPath),
			kind: entry.node.kind,
			updatedAt: entry.kind === "saved" ? entry.node.updatedAt : entry.pendingUpdate.updatedAt,
			updatedBy: entry.kind === "saved" ? entry.node.updatedBy : entry.node.userId,
			contentType:
				entry.kind === "saved"
					? (replacement?.contentType ?? entry.node.contentType)
					: intent && intent.kind !== "folder"
						? intent.contentType
						: null,
			assetId:
				entry.kind === "saved"
					? (replacement?.assetId ?? entry.node.assetId)
					: intent?.kind === "stored"
						? intent.assetId
						: null,
			textKind:
				entry.kind === "saved"
					? replacement
						? (replacement.yjsRootKind ?? null)
						: entry.node.textKind
					: intent?.kind === "text"
						? intent.textKind
						: null,
			preparing:
				entry.kind === "private" &&
				(!intent || (intent.kind === "text" && entry.pendingUpdate.content?.base.kind !== "new")),
			contentSize:
				entry.kind === "private"
					? intent?.kind === "stored"
						? intent.size
						: entry.pendingUpdate.content
							? entry.pendingUpdate.size
							: undefined
					: files_pending_update_has_content(entry.pendingUpdate) &&
						  !files_pending_update_content_is_stale(entry.pendingUpdate, entry.node)
						? entry.pendingUpdate.size
						: replacement?.size,
		};
		this.rememberEntry(cacheEntry);
		return cacheEntry;
	}

	/**
	 * Nearest existing visible entry strictly above a stored path (the mount root, always
	 * a folder, is excluded and reads as null). Recursive creators (mkdir -p, cp/write_file
	 * implicit parents) reject a file result before building committed folders under it.
	 */
	async getNearestVisibleAncestor(path: string) {
		let ancestorPath = bash_normalize_path(`${bash_normalize_path(path)}/..`);
		while (ancestorPath !== "/" && ancestorPath !== this.dbFilesRootPath) {
			const entry = await this.getEntry(ancestorPath);
			if (entry) {
				return entry;
			}
			ancestorPath = bash_normalize_path(`${ancestorPath}/..`);
		}
		return null;
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
		const versionRootPath = mount.fs.dbFilesRootPath;
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
	if (dbFilesPath != null) dbFilesRoots.app.fs.observePath(dbFilesPath);
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

// These constants support the narrow shell-code guard below. They identify
// simple command boundaries, wrapper builtins, nested shells, redirections,
// and dynamic words; they are not a general shell parser.
const SOURCE_BUILTIN_PREFIX_COMMANDS = new Set(["builtin", "command", "eval"]);
const SOURCE_BUILTIN_PREFIX_OPTIONS = new Set(["--", "-p"]);
const SOURCE_BUILTIN_CONTROL_WORDS = new Set(["!", "do", "elif", "else", "if", "then", "time", "until", "while"]);
const SHELL_CODE_CONTENT_READER_COMMANDS = new Set(["cat", "grep", "head", "sed", "tail", "textgrep"]);
const NESTED_SHELL_COMMANDS = new Set(["bash", "sh"]);
const NESTED_SHELL_SCRIPT_FLAGS = new Set(["-c", "-lc", "-cl"]);
const SHELL_ASSIGNMENT_WORD_REGEX = /^[A-Za-z_][A-Za-z0-9_]*=/u;
const SHELL_DYNAMIC_WORD_REGEX = /[$`]/u;
const SHELL_STATIC_ECHO_COMMAND_SUBSTITUTION_REGEX = /^\$\(\s*echo\s+([A-Za-z0-9_.-]+)\s*\)$/u;
const SHELL_REDIRECTION_WORD_REGEX = /^(?:\d*(?:<>|>>|>\||>|<|<<|<<<|<&|>&)|&>>?)(?:.+)?$/u;
const SHELL_REDIRECTION_OPERATOR_REGEX = /^(?:\d*(?:<>|>>|>\||>|<|<<|<<<|<&|>&)|&>>?)$/u;

type ShellWordToken = { kind: "separator" } | { kind: "word"; value: string };
type ShellCodeGuardOptions = { cwd: string; fs: IFileSystem; appRoot: bash_DbFilesRoot };

/**
 * Split only enough shell syntax to find simple commands. Quotes and backslashes
 * stay inside the word value, so separators inside quotes do not split the command.
 */
function parse_shell_word_tokens(command: string) {
	const tokens: ShellWordToken[] = [];
	let word = "";
	let quote: "'" | '"' | null = null;
	let commandSubstitutionDepth = 0;

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
		if (char === "$" && command[i + 1] === "(") {
			commandSubstitutionDepth++;
			word += "$(";
			i++;
			continue;
		}
		if (commandSubstitutionDepth > 0) {
			if (char === "(") {
				commandSubstitutionDepth++;
			} else if (char === ")") {
				commandSubstitutionDepth--;
			}
			word += char;
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
 * Extract command-substitution bodies while balancing nested `$()` groups.
 */
function shell_command_substitution_scripts(script: string) {
	const substitutions: string[] = [];

	for (let index = 0; index < script.length; index++) {
		if (script[index] === "`") {
			const start = index + 1;
			for (index++; index < script.length; index++) {
				if (script[index] === "\\") {
					index++;
					continue;
				}
				if (script[index] === "`") {
					substitutions.push(script.slice(start, index));
					break;
				}
			}
			continue;
		}
		if (script[index] !== "$" || script[index + 1] !== "(") {
			continue;
		}

		const start = index + 2;
		let depth = 1;
		let quote: "'" | '"' | "`" | null = null;
		for (index += 2; index < script.length; index++) {
			const char = script[index];
			if (quote !== null) {
				if (char === "\\" && quote !== "'") {
					index++;
				} else if (char === quote) {
					quote = null;
				}
				continue;
			}
			if (char === "\\") {
				index++;
				continue;
			}
			if (char === "'" || char === '"' || char === "`") {
				quote = char;
				continue;
			}
			if (char === "(") {
				depth++;
				continue;
			}
			if (char !== ")") {
				continue;
			}
			depth--;
			if (depth === 0) {
				substitutions.push(script.slice(start, index));
				break;
			}
		}
	}

	return substitutions;
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
 * Find the next shell word while ignoring redirection targets and selected wrapper options.
 */
function next_shell_word_from_words(words: string[], startIndex: number, skippedWords?: ReadonlySet<string>) {
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
		if (skippedWords?.has(word)) {
			continue;
		}
		return word;
	}
	return null;
}

/**
 * Decide whether a shell-code file path is disallowed.
 *
 * `source`/`.` executes inside the current shell, bypassing the explicit
 * `bash <script>` guards for app files and external mounts. Literal targets are
 * resolved against cwd so `/tmp/script.sh` stays allowed. Dynamic targets are
 * blocked because their final path cannot be classified without shell expansion.
 */
function shell_code_path_is_disallowed(target: string, options: { cwd: string }): boolean {
	if (SHELL_DYNAMIC_WORD_REGEX.test(target)) {
		return true;
	}
	const resolvedPath = bash_resolve_path(options.cwd, target);
	return bash_is_path_under(bash_APP_MOUNT_PATH, resolvedPath) || bash_is_path_under_read_only_mounts(resolvedPath);
}

/**
 * Detect a file path inside command substitution that will become nested shell code.
 * Explicit paths can be classified directly. For bare relative content-reader operands,
 * check the mounted filesystem so option values and search patterns are not mistaken for files.
 */
async function command_substitution_loads_disallowed_shell_code(script: string, options: ShellCodeGuardOptions) {
	for (const nestedCommand of shell_command_substitution_scripts(script)) {
		// Check inner substitutions before their output can hide the command that read the file.
		if (await command_substitution_loads_disallowed_shell_code(nestedCommand, options)) {
			return true;
		}

		const tokens = parse_shell_word_tokens(nestedCommand);
		let commandName: string | null = null;
		let hasDynamicCommandName = false;
		let hasCommandWrapper = false;

		for (const token of tokens) {
			if (token.kind === "separator") {
				commandName = null;
				hasDynamicCommandName = false;
				hasCommandWrapper = false;
				continue;
			}
			const word = token.value;
			if (commandName == null) {
				if (SHELL_ASSIGNMENT_WORD_REGEX.test(word) || SOURCE_BUILTIN_CONTROL_WORDS.has(word)) {
					continue;
				}
				if (SOURCE_BUILTIN_PREFIX_COMMANDS.has(word)) {
					hasCommandWrapper = true;
					continue;
				}
				if (hasCommandWrapper && SOURCE_BUILTIN_PREFIX_OPTIONS.has(word)) {
					continue;
				}
				const staticEchoCommand = word.match(SHELL_STATIC_ECHO_COMMAND_SUBSTITUTION_REGEX)?.[1] ?? null;
				commandName = staticEchoCommand ?? word;
				hasDynamicCommandName = staticEchoCommand === null && SHELL_DYNAMIC_WORD_REGEX.test(word);
				hasCommandWrapper = false;
				continue;
			}

			if (
				(SHELL_CODE_CONTENT_READER_COMMANDS.has(commandName) || hasDynamicCommandName) &&
				!word.startsWith("-") &&
				shell_code_path_is_disallowed(word, options)
			) {
				if (SHELL_DYNAMIC_WORD_REGEX.test(word)) {
					return true;
				}
				const isExplicitPath = word.startsWith("/") || word.startsWith("./") || word.startsWith("../");
				if (isExplicitPath) {
					return true;
				}
				try {
					const shellPath = bash_resolve_path(options.cwd, word);
					const dbFilesPath =
						options.appRoot.fs.readOnlySource == null
							? bash_current_workspace_path_to_db_files_path(options.appRoot.currentWorkspacePath, shellPath)
							: null;
					// Safety probes inspect shell text, including skipped commands and patterns.
					// Only actual file operations should load that folder's instructions.
					if (dbFilesPath != null) {
						if (
							!bash_GLOB_METACHARACTER_REGEX.test(dbFilesPath) &&
							(await options.appRoot.fs.getEntry(dbFilesPath, false))?.kind === "file"
						) {
							return true;
						}
					} else if ((await options.fs.stat(shellPath)).isFile) {
						return true;
					}
				} catch {
					// Non-file arguments are normal command options, patterns, or missing paths.
				}
			}
		}
	}

	return false;
}

function shell_script_uses_assignment(script: string, assignmentNames: ReadonlySet<string>) {
	for (const assignmentName of assignmentNames) {
		if (new RegExp(`\\$(?:${assignmentName}(?![A-Za-z0-9_])|\\{${assignmentName}\\})`, "u").test(script)) {
			return true;
		}
	}
	return false;
}

async function update_shell_code_assignments(
	words: string[],
	assignmentNames: Set<string>,
	options: ShellCodeGuardOptions,
) {
	for (const word of words) {
		if (!SHELL_ASSIGNMENT_WORD_REGEX.test(word)) {
			break;
		}

		const separatorIndex = word.indexOf("=");
		const assignmentName = word.slice(0, separatorIndex);
		const assignmentValue = word.slice(separatorIndex + 1);
		if (await command_substitution_loads_disallowed_shell_code(assignmentValue, options)) {
			assignmentNames.add(assignmentName);
		} else {
			assignmentNames.delete(assignmentName);
		}
	}
}

/**
 * Inspect one simple command for a disallowed `source`/`.` target.
 *
 * Assignment words, redirections, and wrapper builtins can appear before
 * `source`, so skip them before checking the script target.
 */
async function simple_command_loads_disallowed_shell_code(
	words: string[],
	options: ShellCodeGuardOptions,
	assignmentNames: ReadonlySet<string>,
): Promise<boolean> {
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
			const target = next_shell_word_from_words(words, index + 1);
			return target == null ? false : shell_code_path_is_disallowed(target, options);
		}

		if (word === "eval") {
			// `eval 'source ...'` builds another command string; scan that string
			// before Just Bash runs it.
			const script = words.slice(index + 1).join(" ");
			return (
				shell_script_uses_assignment(script, assignmentNames) ||
				(await command_substitution_loads_disallowed_shell_code(script, options)) ||
				(await bash_command_loads_disallowed_shell_code(script, options))
			);
		}

		if (NESTED_SHELL_COMMANDS.has(word)) {
			const flag = next_shell_word_from_words(words, index + 1);
			if (flag == null || !NESTED_SHELL_SCRIPT_FLAGS.has(flag)) {
				return false;
			}
			const flagIndex = words.indexOf(flag, index + 1);
			const script = next_shell_word_from_words(words, flagIndex + 1);
			return (
				script != null &&
				(shell_script_uses_assignment(script, assignmentNames) ||
					(await command_substitution_loads_disallowed_shell_code(script, options)) ||
					(await bash_command_loads_disallowed_shell_code(script, options)))
			);
		}

		if (SOURCE_BUILTIN_PREFIX_COMMANDS.has(word)) {
			// `command source file` and `builtin . file` still invoke the source builtins.
			const command = next_shell_word_from_words(words, index + 1, SOURCE_BUILTIN_PREFIX_OPTIONS);
			if (command === "source" || command === ".") {
				const sourceIndex = words.indexOf(command, index + 1);
				const target = next_shell_word_from_words(words, sourceIndex + 1);
				return target == null ? false : shell_code_path_is_disallowed(target, options);
			}
			if (command === "eval") {
				const evalIndex = words.indexOf(command, index + 1);
				const script = words.slice(evalIndex + 1).join(" ");
				return (
					shell_script_uses_assignment(script, assignmentNames) ||
					(await command_substitution_loads_disallowed_shell_code(script, options)) ||
					(await bash_command_loads_disallowed_shell_code(script, options))
				);
			}
		}

		return false;
	}

	return false;
}

/**
 * Detect shell syntax that would load an app file or external mount as code.
 *
 * This stays a shallow shell-word scan, not a second interpreter. It only decides
 * whether a source target or nested command substitution reads a disallowed path;
 * normal `/tmp` script usage should continue through Just Bash.
 */
export async function bash_command_loads_disallowed_shell_code(command: string, options: ShellCodeGuardOptions) {
	const tokens = parse_shell_word_tokens(command.replace(bash_SHELL_COMMENT_LINE_REGEX, ""));
	const shellCodeAssignmentNames = new Set<string>();
	let words: string[] = [];

	for (const token of tokens) {
		if (token.kind === "separator") {
			await update_shell_code_assignments(words, shellCodeAssignmentNames, options);
			if (await simple_command_loads_disallowed_shell_code(words, options, shellCodeAssignmentNames)) {
				return true;
			}
			words = [];
			continue;
		}
		words.push(token.value);
	}

	await update_shell_code_assignments(words, shellCodeAssignmentNames, options);
	return await simple_command_loads_disallowed_shell_code(words, options, shellCodeAssignmentNames);
}

/**
 * Build the message shown when shell code comes from an app file or agent-only external mount.
 */
export function bash_disallowed_shell_code_error() {
	return "bash: source, ., and nested commands cannot load app files or agent-only external mounts as shell code; use bash /tmp/<script> for scratch scripts.\n";
}

/**
 * Parse app `cp`/`mv` flags and keep path intent before normalization.
 *
 * Raw operands remain available on failure so callers can route pure scratch commands
 * to the native parser. App commands must check the Result before starting any work.
 */
export function bash_parse_cp_mv_operands(command: "cp" | "mv", args: string[]) {
	const operands: string[] = [];
	let recursive = false;
	let conflictPolicy: "replace" | "skip" | "error" = command === "cp" ? "replace" : "error";
	let noTargetDirectory = false;
	let optionsEnded = false;
	let error: string | null = null;

	for (const arg of args) {
		if (optionsEnded) {
			operands.push(arg);
			continue;
		}
		if (arg === "--") {
			optionsEnded = true;
			continue;
		}
		if (arg.startsWith("-") && arg !== "-") {
			const flags = arg.startsWith("--") ? [arg] : [...arg.slice(1)];
			for (const flag of flags) {
				if (command === "cp" && (flag === "r" || flag === "R" || flag === "--recursive")) {
					recursive = true;
				} else if (flag === "f" || flag === "--force") {
					conflictPolicy = "replace";
				} else if (flag === "n" || flag === "--no-clobber") {
					conflictPolicy = "skip";
				} else if (flag === "T" || flag === "--no-target-directory") {
					noTargetDirectory = true;
				} else {
					error ??= `${command}: unsupported option '${flag.startsWith("--") ? flag : `-${flag}`}'`;
				}
			}
			continue;
		}
		operands.push(arg);
	}

	if (operands.length < 2) error ??= `${command}: expected at least one source and a destination`;
	if (noTargetDirectory && operands.length > 2) error ??= `${command}: -T requires exactly one source`;
	if (error !== null) {
		return { operands, ...Result({ _nay: { message: error } }) };
	}

	const destination = operands[operands.length - 1];
	return {
		operands,
		...Result({
			_yay: {
				sources: operands.slice(0, -1).map((path) => ({ path, requiresFolder: path.endsWith("/") })),
				destination: { path: destination, requiresFolder: operands.length > 2 || destination.endsWith("/") },
				recursive,
				conflictPolicy,
				noTargetDirectory,
			},
		}),
	};
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
	textChunk: string,
) {
	if (exactQueryFilter == null) {
		return "";
	}
	return textChunk.toLowerCase().includes(exactQueryFilter)
		? ` [contains exact '${query}']`
		: ` [word-level match; chunk does not contain '${query}']`;
}

/**
 * Build the exact/word-level split shown in the "Found N results" header.
 *
 * The model relays counts from command output, so give it grounded counts
 * instead of making it count annotated result blocks itself.
 */
export function bash_search_command_exact_query_summary(exactQueryFilter: string | null, textChunks: string[]) {
	if (exactQueryFilter == null) {
		return "";
	}
	const exactCount = textChunks.filter((chunk) => chunk.toLowerCase().includes(exactQueryFilter)).length;
	const broadCount = textChunks.length - exactCount;
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
 * The visible Result shape of the agent write flow. Kept as a local structural type on purpose:
 * this helper sits inside the generated-API type graph (convex/bash.ts → server/bash.ts → here),
 * so inferring or importing the registered functions' Result types as its return type creates an
 * inference cycle that collapses the whole generated API to `any`.
 */
export type files_agent_write_file_text_Result =
	| { _yay: null; _nay?: undefined }
	| { _yay?: undefined; _nay: { name?: string; message: string } };

/**
 * Record the agent's new text for one file, behind the bash file writes (`>`, `>>`, heredocs,
 * `tee`, builtin `touch`) and `edit_file`. A `cp` and a `mv -f` stage their own doc kinds.
 *
 * The file gets a proposal the user reviews, in both collaboration modes: create a server-side
 * operation batch, stage the one bounded unstaged text under it, then run the finishing internal
 * action that carries only ids. A staging refusal retires the batch first, or the abandoned
 * "already in progress" batch would block this user/node's next write until the TTL. Refusals
 * return unchanged, so every caller keeps its own `_nay` surfacing.
 */
export async function files_agent_write_file_text(
	ctx: ActionCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
		target: files_PendingTarget;
		operationBatchId?: Id<"files_pending_update_operation_batches">;
		pendingUpdateId?: Id<"files_pending_updates">;
		expectedBaseStateId?: Id<"files_pending_update_yjs_states"> | null;
		unstagedText: string;
		copiedFrom?: Doc<"files_pending_updates">["copiedFrom"];
		threadId?: Id<"ai_chat_threads">;
	},
): Promise<files_agent_write_file_text_Result> {
	const batch = args.operationBatchId
		? Result({ _yay: { operationBatchId: args.operationBatchId } })
		: ((await ctx.runMutation(internal.files_pending_updates.create_file_pending_update_operation_batch_internal, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				userId: args.userId,
				target: args.target,
			})) as
				| {
						_yay: { operationBatchId: Id<"files_pending_update_operation_batches">; expiresAt: number };
						_nay?: undefined;
				  }
				| { _yay?: undefined; _nay: { name?: string; message: string } });
	if (batch._nay) {
		return { _nay: batch._nay };
	}
	const operationBatchId = batch._yay.operationBatchId;

	const staged = (await ctx.runMutation(internal.files_pending_updates.stage_file_pending_update_text_input_internal, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		userId: args.userId,
		operationBatchId,
		role: "unstaged",
		text: args.unstagedText,
	})) as files_agent_write_file_text_Result;
	if (staged._nay) {
		await ctx.runMutation(internal.files_pending_updates.retire_file_pending_update_operation_batch, {
			operationBatchId,
		});
		return staged;
	}

	return (await ctx.runAction(internal.files_pending_updates.upsert_file_pending_update_internal_action, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		userId: args.userId,
		target: args.target,
		operationBatchId,
		...(args.pendingUpdateId ? { pendingUpdateId: args.pendingUpdateId } : {}),
		...(args.expectedBaseStateId !== undefined ? { expectedBaseStateId: args.expectedBaseStateId } : {}),
		...(args.copiedFrom ? { copiedFrom: args.copiedFrom } : {}),
		...(args.threadId ? { threadId: args.threadId } : {}),
	})) as files_agent_write_file_text_Result;
}

/**
 * Persist a raw pagination cursor and return the stored cursor id printed
 * in command output.
 *
 * Raw Convex cursors are extremely long and hard for the AI to copy back into
 * shell commands reliably, so bash output exposes only this value_store id.
 */
export async function bash_cursor_id_create(ctx: ActionCtx, cursor: string) {
	return (await ctx.runMutation(internal.value_store.put, {
		value: cursor,
		ttl: PAGINATION_CURSOR_TTL_MS,
	})) as Id<"value_store">;
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

	// Read Convex every time so expiry and removal also apply across action runtimes.
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
			.map((mount) => ({ key: mount.pluginName, fingerprint: mount.fs.dbFilesRootPath.slice(1), source: mount })),
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
	const versionRootPath = mount.fs.dbFilesRootPath;
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
 * Proposal metadata wins over saved asset size. Writes clear the path cache,
 * so a later command sees the current size without loading the body.
 */
export async function bash_get_db_file_byte_size(args: {
	ctx: ActionCtx;
	ctxData: bash_DbFilesFsOptions["ctxData"];
	dbFilesDoc: Pick<DbFilesCacheEntry, "kind" | "assetId" | "contentSize">;
}) {
	if (args.dbFilesDoc.kind !== "file") {
		return null;
	}
	if (args.dbFilesDoc.contentSize != null) return args.dbFilesDoc.contentSize;
	if (args.dbFilesDoc.assetId == null) return null;

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
	contentType: string | null | undefined,
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
		"This message is NOT the file content. Bash can read editable text files only (Markdown and plain text types such as .txt, .json, .yaml, .csv); binary/media files are not supported.",
		`To read generated text output for this file, try: ${relatedReadablePaths.map((path) => `cat ${path}`).join(", or ")}`,
		"If none of those commands return content, run ls on the parent folder to find the correct generated Markdown sibling.",
		"",
	].join("\n");
}

// #endregion reader helpers
