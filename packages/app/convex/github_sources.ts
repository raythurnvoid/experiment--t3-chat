/*
Read-only GitHub repo mirror ("mount") sync pipeline.

A `github_sources` doc maps a public GitHub repo to a mount name → `/.mounts/<name>` in the bash tool.
When the commit moves, sync hard-deletes the whole mount, then re-ingests fresh from ONE commit-pinned
codeload ZIP into reserved scope (`workspaceId="GLOBAL"`, `projectId="GITHUB"`, author `"SYSTEM"`). No user
file staging, no revisions, no yjs. A crash leaves partial data; rerunning deletes-then-ingests again
(decision 1).

The producer (`sync_github_source`) runs in the DEFAULT runtime: it streams the archive through `fflate`'s
push-based `Unzip` one entry at a time, enforces caps/filters, and enqueues one `sync_materialize_file`
workpool job per kept file. Jobs call the Phase D `create_file_node_internal` write path.
*/

import { Workpool } from "@convex-dev/workpool";
import { Unzip, UnzipInflate, type UnzipFile } from "fflate";
import { v } from "convex/values";
import { doc } from "convex-helpers/validators";
import { z } from "zod";
import { components, internal } from "./_generated/api.js";
import app_convex_schema from "./schema.ts";
import { internalAction, internalMutation, internalQuery, type ActionCtx, type MutationCtx } from "./_generated/server.js";
import type { Doc, Id } from "./_generated/dataModel";
import {
	workspaces_GLOBAL_WORKSPACE_ID,
	workspaces_GLOBAL_GITHUB_PROJECT_ID,
} from "../shared/workspaces.ts";
import { Result } from "../shared/errors-as-values-utils.ts";
import { should_never_happen } from "../shared/shared-utils.ts";
import { json_parse_and_validate } from "../server/server-utils.ts";
import { v_result } from "../server/convex-utils.ts";
import { files_MAX_TEXT_CONTENT_BYTES, files_get_utf8_byte_size } from "../shared/files.ts";
import { r2_delete_object } from "./r2.ts";

// #region constants

/** Conservative cap on the compressed archive (codeload ZIP). Rejected before/while streaming. */
const GITHUB_SYNC_MAX_COMPRESSED_BYTES = 12 * 1024 * 1024;
/** Cap on total accepted (post-decode) text bytes across the whole sync. */
const GITHUB_SYNC_MAX_ACCEPTED_UNCOMPRESSED_BYTES = 30 * 1024 * 1024;
/** Cap on the number of accepted files per sync. */
const GITHUB_SYNC_MAX_ACCEPTED_FILES = 5_000;
/** A `running` lock older than this is considered stale and may be reclaimed. Must exceed worst-case sync. */
const GITHUB_SYNC_STALE_LOCK_MS = 30 * 60 * 1000;
/** Soft ceiling on doc deletions per hard-delete batch mutation (keeps each transaction bounded). */
const GITHUB_SYNC_MOUNT_DELETE_BATCH = 500;
/** Keep accepted ZIP entry buffers under the V8 action memory cap while the producer waits to enqueue. */
const GITHUB_SYNC_ZIP_PUSH_CHUNK_BYTES = 64 * 1024;
const GITHUB_SYNC_MAX_BUFFERED_COMPLETED_ENTRIES = 256;
const GITHUB_SYNC_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
/** Bounded retry for transient GitHub/codeload failures (429/403-rate/5xx/transient-404 after a push). */
const GITHUB_SYNC_FETCH_MAX_ATTEMPTS = 4;
const GITHUB_SYNC_FETCH_BACKOFF_BASE_MS = 600;

const GITHUB_SYNC_USER_AGENT = "t3-chat-github-mount-sync";

/** Path segments that are never ingested (build output, deps, VCS internals). */
const GITHUB_SYNC_EXCLUDED_DIR_SEGMENTS = new Set([
	"node_modules",
	"dist",
	"build",
	"out",
	".next",
	".turbo",
	"vendor",
	".git",
	"coverage",
]);

/** Lockfiles (lowercased basenames) excluded as noise. */
const GITHUB_SYNC_EXCLUDED_LOCKFILES = new Set([
	"package-lock.json",
	"pnpm-lock.yaml",
	"yarn.lock",
	"cargo.lock",
	"composer.lock",
	"poetry.lock",
	"gemfile.lock",
	"bun.lockb",
]);

/** Binary file extensions (lowercased, no dot) excluded — these are not source text. */
const GITHUB_SYNC_BINARY_EXTENSIONS = new Set([
	// images
	"png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "tiff", "avif", "heic",
	// fonts
	"woff", "woff2", "ttf", "otf", "eot",
	// archives
	"zip", "gz", "tgz", "bz2", "xz", "7z", "rar", "tar", "zst",
	// media
	"mp3", "mp4", "wav", "ogg", "webm", "mov", "avi", "mkv", "flac", "m4a",
	// docs/binaries
	"pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
	// compiled / native
	"wasm", "so", "dylib", "dll", "exe", "o", "a", "class", "jar", "node",
	// db / misc binary
	"sqlite", "db", "bin", "dat", "lockb", "pyc", "pdb",
]);

/** Git-LFS pointer files start with this line; their content is a pointer, not the real bytes. */
const GITHUB_SYNC_LFS_POINTER_PREFIX = "version https://git-lfs.github.com/spec/v1";

/** Mount-safe slug. First char alnum, then alnum/`.`/`-`, max 63 chars. */
const GITHUB_SOURCE_NAME_REGEX = /^[a-z0-9][a-z0-9.-]{0,62}$/;
/** Names that would collide with traversal or the scratch dir. */
const GITHUB_SOURCE_RESERVED_NAMES = new Set([".", "..", "tmp"]);
/** GitHub login charset (owner/org): alnum + hyphen, max 39 chars. Keeps `owner` URL-injection-safe. */
const GITHUB_OWNER_REGEX = /^[a-zA-Z0-9-]{1,39}$/;
/** GitHub repo-name charset: alnum + `.`/`_`/`-`, max 100 chars. Keeps `repo` URL-injection-safe. */
const GITHUB_REPO_REGEX = /^[a-zA-Z0-9._-]{1,100}$/;

// #endregion constants

const github_sources_workpool = new Workpool(components.github_sources_workpool, {
	maxParallelism: 4,
	// Unlike the fire-and-forget sibling pools (maxAttempts: Infinity), this pool drives a completion barrier:
	// a permanently-failing file must eventually surface as `failed` via onComplete instead of retrying forever,
	// or the run never finalizes. Finite attempts absorb transient OCC/R2 blips, then give up and report.
	retryActionsByDefault: true,
	defaultRetryBehavior: {
		initialBackoffMs: 1000,
		base: 2,
		maxAttempts: 5,
	} as const,
});

function github_sync_mount_delete_batch_size(args: { _test_batchSize?: number }) {
	return Math.max(2, Math.min(args._test_batchSize ?? GITHUB_SYNC_MOUNT_DELETE_BATCH, GITHUB_SYNC_MOUNT_DELETE_BATCH));
}

// #region pure helpers (exported for tests)

/**
 * Validate a mount name. Mount-safe slug, not a reserved/traversal name. Returns the normalized
 * (already-lowercase) name on success.
 */
export function github_source_validate_name(name: string) {
	if (!GITHUB_SOURCE_NAME_REGEX.test(name)) {
		return Result({
			_nay: { message: `Invalid mount name "${name}": must match ${GITHUB_SOURCE_NAME_REGEX.source}` },
		});
	}
	if (GITHUB_SOURCE_RESERVED_NAMES.has(name)) {
		return Result({ _nay: { message: `Mount name "${name}" is reserved` } });
	}
	return Result({ _yay: name });
}

function github_source_lowercase_extension(relPath: string): string | null {
	const base = relPath.split("/").at(-1) ?? "";
	const dotIndex = base.lastIndexOf(".");
	if (dotIndex <= 0 || dotIndex === base.length - 1) {
		return null;
	}
	return base.slice(dotIndex + 1).toLowerCase();
}

/**
 * Decide whether a repo-relative path (already stripped of the synthetic top-level folder) is ingestible.
 * Returns `{ keep: true }` or `{ keep: false, reason }`. Rejects traversal/absolute/empty paths and excludes
 * dep/build dirs, lockfiles, and binary extensions.
 */
export function github_source_classify_rel_path(relPath: string): { keep: true } | { keep: false; reason: string } {
	if (relPath.length === 0) {
		return { keep: false, reason: "empty path" };
	}
	if (relPath.startsWith("/") || /^[a-z]:/i.test(relPath)) {
		return { keep: false, reason: "absolute path" };
	}
	const segments = relPath.split("/");
	for (const segment of segments) {
		if (segment === "" || segment === "." || segment === "..") {
			return { keep: false, reason: "path traversal" };
		}
		if (GITHUB_SYNC_EXCLUDED_DIR_SEGMENTS.has(segment)) {
			return { keep: false, reason: `excluded directory "${segment}"` };
		}
	}
	const base = segments.at(-1) ?? "";
	if (GITHUB_SYNC_EXCLUDED_LOCKFILES.has(base.toLowerCase())) {
		return { keep: false, reason: "lockfile" };
	}
	const extension = github_source_lowercase_extension(relPath);
	if (extension !== null && GITHUB_SYNC_BINARY_EXTENSIONS.has(extension)) {
		return { keep: false, reason: `binary extension ".${extension}"` };
	}
	return { keep: true };
}

export function github_source_is_lfs_pointer(text: string): boolean {
	return text.startsWith(GITHUB_SYNC_LFS_POINTER_PREFIX);
}

/** Build the commit-pinned codeload archive URL. */
export function github_source_codeload_url(args: { owner: string; repo: string; commitSha: string }) {
	return `https://codeload.github.com/${args.owner}/${args.repo}/zip/${args.commitSha}`;
}

// #endregion pure helpers

// #region github metadata fetch

const github_repo_schema = z.object({ default_branch: z.string() });
const github_branch_schema = z.object({
	commit: z.object({
		sha: z.string(),
		commit: z.object({ tree: z.object({ sha: z.string() }) }),
	}),
});

function github_sync_sleep(ms: number) {
	return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch with bounded backoff for transient GitHub/codeload failures. `allowTransient404` covers codeload
 * archive lag immediately after a push. Returns the first 2xx response or a `_nay` describing the failure.
 */
async function github_sync_fetch_with_retry(
	url: string,
	options: { allowTransient404: boolean },
) {
	let lastStatus = 0;
	for (let attempt = 0; attempt < GITHUB_SYNC_FETCH_MAX_ATTEMPTS; attempt++) {
		if (attempt > 0) {
			await github_sync_sleep(GITHUB_SYNC_FETCH_BACKOFF_BASE_MS * 2 ** (attempt - 1));
		}
		let response: Response;
		try {
			response = await fetch(url, {
				headers: { "User-Agent": GITHUB_SYNC_USER_AGENT, Accept: "application/vnd.github+json" },
			});
		} catch (error) {
			lastStatus = 0;
			void error;
			continue;
		}
		if (response.ok) {
			return Result({ _yay: response });
		}
		lastStatus = response.status;
		const isTransient =
			response.status === 429 ||
			response.status === 403 ||
			response.status >= 500 ||
			(response.status === 404 && options.allowTransient404);
		// Drain the body so the connection can be reused before the next attempt.
		await response.text().catch(() => undefined);
		if (!isTransient) {
			break;
		}
	}
	return Result({ _nay: { message: `Request to ${url} failed after retries (last status ${lastStatus})` } });
}

// #endregion github metadata fetch

// #region queries

/** Full source doc for a per-file job / test to verify lock + status. */
export const get_source = internalQuery({
	args: { sourceId: v.id("github_sources") },
	returns: v.union(doc(app_convex_schema, "github_sources"), v.null()),
	handler: async (ctx, args) => {
		return await ctx.db.get("github_sources", args.sourceId);
	},
});

export const get_source_by_name = internalQuery({
	args: { name: v.string() },
	returns: v.union(doc(app_convex_schema, "github_sources"), v.null()),
	handler: async (ctx, args) => {
		return await ctx.db
			.query("github_sources")
			.withIndex("by_name", (q) => q.eq("name", args.name))
			.first();
	},
});

// #endregion queries

// #region source management (E4)

export const upsert_github_source = internalMutation({
	args: {
		name: v.string(),
		owner: v.string(),
		repo: v.string(),
		ref: v.string(),
	},
	returns: v_result({ _yay: v.object({ sourceId: v.id("github_sources") }) }),
	handler: async (ctx, args) => {
		const nameResult = github_source_validate_name(args.name);
		if (nameResult._nay) {
			return nameResult;
		}
		if (!GITHUB_OWNER_REGEX.test(args.owner)) {
			return Result({ _nay: { message: `Invalid owner "${args.owner}": must match ${GITHUB_OWNER_REGEX.source}` } });
		}
		if (!GITHUB_REPO_REGEX.test(args.repo) || args.repo === "." || args.repo === "..") {
			return Result({ _nay: { message: `Invalid repo "${args.repo}": must match ${GITHUB_REPO_REGEX.source}` } });
		}

		const existing = await ctx.db
			.query("github_sources")
			.withIndex("by_name", (q) => q.eq("name", args.name))
			.first();

		if (existing) {
			await ctx.db.patch("github_sources", existing._id, {
				owner: args.owner,
				repo: args.repo,
				ref: args.ref,
			});
			return Result({ _yay: { sourceId: existing._id } });
		}

		const sourceId = await ctx.db.insert("github_sources", {
			name: args.name,
			owner: args.owner,
			repo: args.repo,
			ref: args.ref,
			defaultBranch: null,
			lastCommitSha: null,
			lastTreeSha: null,
			lastSyncedAt: null,
			status: "idle",
			startedAt: null,
			producerFinishedAt: null,
			finishedAt: null,
			lastError: null,
		});
		return Result({ _yay: { sourceId } });
	},
});

// #endregion source management

// #region lock + finalize mutations (E2)

export const acquire_sync_lock = internalMutation({
	args: { sourceId: v.id("github_sources"), syncRunId: v.string() },
	returns: v_result({
		_yay: v.object({
			name: v.string(),
			owner: v.string(),
			repo: v.string(),
			ref: v.string(),
			lastCommitSha: v.union(v.string(), v.null()),
		}),
	}),
	handler: async (ctx, args) => {
		const source = await ctx.db.get("github_sources", args.sourceId);
		if (!source) {
			return Result({ _nay: { message: "Source not found" } });
		}

		const now = Date.now();
		const lockedAt = source.lockedAt ?? 0;
		if (source.status === "running" && now - lockedAt <= GITHUB_SYNC_STALE_LOCK_MS) {
			return Result({ _nay: { message: "Sync already running" } });
		}

		await ctx.db.patch("github_sources", source._id, {
			status: "running",
			syncRunId: args.syncRunId,
			lockedAt: now,
			startedAt: now,
			producerFinishedAt: null,
			finishedAt: null,
			lastError: null,
			enqueuedCount: 0,
			completedCount: 0,
			failedCount: 0,
			skippedCount: 0,
			compressedBytesRead: 0,
			acceptedUncompressedBytes: 0,
			pendingCommitSha: undefined,
			pendingTreeSha: undefined,
		});

		return Result({
			_yay: {
				name: source.name,
				owner: source.owner,
				repo: source.repo,
				ref: source.ref,
				lastCommitSha: source.lastCommitSha,
			},
		});
	},
});

/** Stage the target SHAs (learned at metadata fetch) so finalize can promote them on completion. */
export const stage_target_sha = internalMutation({
	args: {
		sourceId: v.id("github_sources"),
		syncRunId: v.string(),
		commitSha: v.string(),
		treeSha: v.string(),
		defaultBranch: v.string(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const source = await ctx.db.get("github_sources", args.sourceId);
		if (!source || source.syncRunId !== args.syncRunId) {
			return null;
		}
		await ctx.db.patch("github_sources", source._id, {
			pendingCommitSha: args.commitSha,
			pendingTreeSha: args.treeSha,
			defaultBranch: args.defaultBranch,
		});
		return null;
	},
});

/** Release the lock with no content change (commit unchanged → early return). */
export const release_sync_lock_unchanged = internalMutation({
	args: { sourceId: v.id("github_sources"), syncRunId: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const source = await ctx.db.get("github_sources", args.sourceId);
		if (!source || source.syncRunId !== args.syncRunId) {
			return null;
		}
		const now = Date.now();
		await ctx.db.patch("github_sources", source._id, {
			status: "idle",
			finishedAt: now,
			lastSyncedAt: now,
			syncRunId: undefined,
			pendingCommitSha: undefined,
			pendingTreeSha: undefined,
		});
		return null;
	},
});

export const mark_sync_error = internalMutation({
	args: { sourceId: v.id("github_sources"), syncRunId: v.string(), message: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const source = await ctx.db.get("github_sources", args.sourceId);
		if (!source || source.syncRunId !== args.syncRunId) {
			return null;
		}
		await ctx.db.patch("github_sources", source._id, {
			status: "error",
			lastError: args.message,
			finishedAt: Date.now(),
			syncRunId: undefined,
			pendingCommitSha: undefined,
			pendingTreeSha: undefined,
		});
		return null;
	},
});

export const record_producer_progress = internalMutation({
	args: {
		sourceId: v.id("github_sources"),
		syncRunId: v.string(),
		enqueuedCount: v.number(),
		skippedCount: v.number(),
		compressedBytesRead: v.number(),
		acceptedUncompressedBytes: v.number(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const source = await ctx.db.get("github_sources", args.sourceId);
		if (!source || source.syncRunId !== args.syncRunId) {
			return null;
		}
		await ctx.db.patch("github_sources", source._id, {
			enqueuedCount: args.enqueuedCount,
			skippedCount: args.skippedCount,
			compressedBytesRead: args.compressedBytesRead,
			acceptedUncompressedBytes: args.acceptedUncompressedBytes,
		});
		return null;
	},
});

export const mark_producer_finished = internalMutation({
	args: {
		sourceId: v.id("github_sources"),
		syncRunId: v.string(),
		enqueuedCount: v.number(),
		skippedCount: v.number(),
		compressedBytesRead: v.number(),
		acceptedUncompressedBytes: v.number(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const source = await ctx.db.get("github_sources", args.sourceId);
		if (!source || source.syncRunId !== args.syncRunId) {
			return null;
		}
		await ctx.db.patch("github_sources", source._id, {
			producerFinishedAt: Date.now(),
			enqueuedCount: args.enqueuedCount,
			skippedCount: args.skippedCount,
			compressedBytesRead: args.compressedBytesRead,
			acceptedUncompressedBytes: args.acceptedUncompressedBytes,
		});
		await db_maybe_finalize_sync(ctx, { sourceId: args.sourceId, syncRunId: args.syncRunId });
		return null;
	},
});

/**
 * Workpool completion hook for per-file materialize jobs. Fires exactly once per job after it reaches a
 * terminal state — success, failed (retries exhausted), or canceled — so the finalize barrier advances even
 * when a worker is hard-terminated (action timeout / infra kill) and never returns to report itself.
 * Sync-run-gated: completions belonging to a superseded run are ignored.
 */
export const handle_materialize_complete = github_sources_workpool.defineOnComplete({
	context: v.object({
		sourceId: v.id("github_sources"),
		syncRunId: v.string(),
	}),
	handler: async (ctx, args) => {
		// The onComplete ctx is typed against the workpool component's generic DataModel, so its context Ids and
		// db docs come back untyped; restore the types the validator + schema already guarantee (matches
		// billing_workpool_cancellation.defineOnComplete).
		const sourceId = args.context.sourceId as Id<"github_sources">;
		const source = (await ctx.db.get("github_sources", sourceId)) as Doc<"github_sources"> | null;
		if (!source || source.syncRunId !== args.context.syncRunId) {
			return;
		}
		const ok = args.result.kind === "success";
		await ctx.db.patch("github_sources", source._id, {
			completedCount: (source.completedCount ?? 0) + (ok ? 1 : 0),
			failedCount: (source.failedCount ?? 0) + (ok ? 0 : 1),
		});
		await db_maybe_finalize_sync(ctx, { sourceId, syncRunId: args.context.syncRunId });
	},
});

/**
 * Close the run once the producer has finished AND every enqueued job has reported. Successful finalization
 * promotes the staged SHAs; failed materialization finalization clears them and leaves the source errored.
 * Called by both the producer (covers `enqueuedCount === 0`) and each job's completion hook, so the last one
 * to satisfy the gate closes the run. Sync-run-gated and idempotent.
 */
async function db_maybe_finalize_sync(ctx: MutationCtx, args: { sourceId: Id<"github_sources">; syncRunId: string }) {
	const source = await ctx.db.get("github_sources", args.sourceId);
	if (!source || source.syncRunId !== args.syncRunId || source.status !== "running") {
		return;
	}
	if (source.producerFinishedAt == null) {
		return;
	}
	const reported = (source.completedCount ?? 0) + (source.failedCount ?? 0);
	if (reported < (source.enqueuedCount ?? 0)) {
		return;
	}
	if (source.pendingCommitSha == null) {
		throw should_never_happen("Finalizing a sync with no staged commit SHA", { sourceId: source._id });
	}
	const now = Date.now();
	if ((source.failedCount ?? 0) > 0) {
		await ctx.db.patch("github_sources", source._id, {
			status: "error",
			finishedAt: now,
			lastError: `Sync failed to materialize ${source.failedCount} file${source.failedCount === 1 ? "" : "s"}`,
			syncRunId: undefined,
			pendingCommitSha: undefined,
			pendingTreeSha: undefined,
		});
		return;
	}
	await ctx.db.patch("github_sources", source._id, {
		lastCommitSha: source.pendingCommitSha,
		lastTreeSha: source.pendingTreeSha ?? null,
		lastSyncedAt: now,
		status: "idle",
		finishedAt: now,
		syncRunId: undefined,
		pendingCommitSha: undefined,
		pendingTreeSha: undefined,
	});
}

// #endregion lock + finalize mutations

// #region mount hard-delete barrier (E1)

/**
 * Delete one bounded batch of the mount's reserved-scope content: range-scan `files_nodes` by `treePath`
 * over `["/<name>/", "/<name>/￿")`, and for each node delete its committed chunks, `file_stats`,
 * metadata docs (defensive), and R2 asset (object + doc, gated on `r2Key`) BEFORE the node doc itself, so a
 * crash never orphans children. Asset and node deletion are one budget unit pair so a node never commits with
 * a missing asset reference. Returns `{ done, deletedCount, superseded }`; stale sync-run calls return superseded.
 * The sync action drives this to `done:true` as a hard barrier — unlike data_deletion this does NOT self-reschedule.
 */
export const delete_mount_content_batch = internalMutation({
	args: { sourceId: v.id("github_sources"), syncRunId: v.string(), _test_batchSize: v.optional(v.number()) },
	returns: v.object({ done: v.boolean(), deletedCount: v.number(), superseded: v.boolean() }),
	handler: async (ctx, args) => {
		const source = await ctx.db.get("github_sources", args.sourceId);
		if (!source || source.syncRunId !== args.syncRunId || source.status !== "running") {
			return { done: true, deletedCount: 0, superseded: true };
		}

		const lower = `/${source.name}/`;
		const upper = `/${source.name}/￿`;
		const batchSize = github_sync_mount_delete_batch_size(args);

		let deletedCount = 0;
		while (deletedCount < batchSize) {
			const node = await ctx.db
				.query("files_nodes")
				.withIndex("by_workspace_project_treePath", (q) =>
					q
						.eq("workspaceId", workspaces_GLOBAL_WORKSPACE_ID)
						.eq("projectId", workspaces_GLOBAL_GITHUB_PROJECT_ID)
						.gte("treePath", lower)
						.lt("treePath", upper),
				)
				.order("desc")
				.first();
			if (!node) {
				break;
			}

			const remainingPlainTextChunks = batchSize - deletedCount;
			const plainTextChunks = await ctx.db
				.query("files_plain_text_chunks")
				.withIndex("by_workspace_project_fileNode_chunkIndex", (q) =>
					q
						.eq("workspaceId", workspaces_GLOBAL_WORKSPACE_ID)
						.eq("projectId", workspaces_GLOBAL_GITHUB_PROJECT_ID)
						.eq("fileNodeId", node._id),
				)
				.take(remainingPlainTextChunks);
			for (const chunk of plainTextChunks) {
				await ctx.db.delete("files_plain_text_chunks", chunk._id);
				deletedCount++;
			}
			if (plainTextChunks.length > 0) {
				continue;
			}

			const remainingMarkdownChunks = batchSize - deletedCount;
			const markdownChunks = await ctx.db
				.query("files_markdown_chunks")
				.withIndex("by_workspace_project_fileNode_chunkIndex", (q) =>
					q
						.eq("workspaceId", workspaces_GLOBAL_WORKSPACE_ID)
						.eq("projectId", workspaces_GLOBAL_GITHUB_PROJECT_ID)
						.eq("fileNodeId", node._id),
				)
				.take(remainingMarkdownChunks);
			for (const chunk of markdownChunks) {
				await ctx.db.delete("files_markdown_chunks", chunk._id);
				deletedCount++;
			}
			if (markdownChunks.length > 0) {
				continue;
			}

			const remainingFileStats = batchSize - deletedCount;
			const fileStats = await ctx.db
				.query("file_stats")
				.withIndex("by_workspace_project_fileNode", (q) =>
					q
						.eq("workspaceId", workspaces_GLOBAL_WORKSPACE_ID)
						.eq("projectId", workspaces_GLOBAL_GITHUB_PROJECT_ID)
						.eq("fileNodeId", node._id),
				)
				.take(remainingFileStats);
			for (const stats of fileStats) {
				await ctx.db.delete("file_stats", stats._id);
				deletedCount++;
			}
			if (fileStats.length > 0) {
				continue;
			}

			const remainingMetadataDocs = batchSize - deletedCount;
			const metadataDocs = await ctx.db
				.query("files_metadata_docs")
				.withIndex("by_workspace_project_fileNode_qualifiedField", (q) =>
					q
						.eq("workspaceId", workspaces_GLOBAL_WORKSPACE_ID)
						.eq("projectId", workspaces_GLOBAL_GITHUB_PROJECT_ID)
						.eq("fileNodeId", node._id),
				)
				.take(remainingMetadataDocs);
			for (const metadataDoc of metadataDocs) {
				await ctx.db.delete("files_metadata_docs", metadataDoc._id);
				deletedCount++;
			}
			if (metadataDocs.length > 0) {
				continue;
			}

			if (node.assetId) {
				const asset = await ctx.db.get("files_r2_assets", node.assetId);
				if (asset) {
					if (deletedCount + 2 > batchSize) {
						break;
					}
					if (asset.r2Key) {
						await r2_delete_object(ctx, asset.r2Key);
					}
					await ctx.db.delete("files_r2_assets", asset._id);
					await ctx.db.delete("files_nodes", node._id);
					deletedCount += 2;
					continue;
				}
			}

			if (deletedCount >= batchSize) {
				break;
			}
			await ctx.db.delete("files_nodes", node._id);
			deletedCount++;
		}

		const remaining = await ctx.db
			.query("files_nodes")
			.withIndex("by_workspace_project_treePath", (q) =>
				q
					.eq("workspaceId", workspaces_GLOBAL_WORKSPACE_ID)
					.eq("projectId", workspaces_GLOBAL_GITHUB_PROJECT_ID)
					.gte("treePath", lower)
					.lt("treePath", upper),
			)
			.first();

		return { done: remaining === null, deletedCount, superseded: false };
	},
});

// #endregion mount hard-delete barrier

// #region per-file job (E2 step 7)

export const sync_materialize_file = internalAction({
	args: {
		sourceId: v.id("github_sources"),
		syncRunId: v.string(),
		storedPath: v.string(),
		text: v.string(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		// Re-check the sync run before ANY side effect: a superseded job must not write into a newer mount.
		const source = await ctx.runQuery(internal.github_sources.get_source, { sourceId: args.sourceId });
		if (!source || source.syncRunId !== args.syncRunId || source.status !== "running") {
			return null;
		}

		// Throw on failure so the workpool retries transient blips (OCC, R2) and, once attempts are exhausted,
		// reports this job as `failed` to handle_materialize_complete. The completion hook — not this worker —
		// records the per-job result, so the finalize barrier still advances if this action is hard-terminated
		// (timeout / infra kill) and never returns. create_file_node_internal already retries write
		// conflicts internally and returns _nay on handled failures; surface that as a throw to retry/report.
		const created = await ctx.runAction(internal.files_nodes.create_file_node_internal, {
			path: args.storedPath,
			rawText: args.text,
			sourceId: args.sourceId,
			syncRunId: args.syncRunId,
		});
		if (created._nay) {
			throw new Error(`Mount file materialization failed (${args.storedPath}): ${created._nay.message}`);
		}
		return null;
	},
});

// #endregion per-file job

// #region producer action (E2)

/**
 * One streaming sync for a single source. Acquires the lock, resolves the head commit, early-returns if
 * unchanged, downloads the commit-pinned archive, hard-deletes the mount as a barrier, then stream-parses
 * the ZIP and enqueues one materialize job per kept file. Producer-finished + per-job finalize close the run.
 */
export const sync_github_source = internalAction({
	args: { sourceId: v.id("github_sources") },
	returns: v.null(),
	handler: async (ctx, args) => {
		const syncRunId = crypto.randomUUID();

		const syncAcquireResult = await ctx.runMutation(internal.github_sources.acquire_sync_lock, {
			sourceId: args.sourceId,
			syncRunId,
		});
		if (syncAcquireResult._nay) {
			// Already running / stale-but-fresh — nothing to do.
			return null;
		}
		const source = syncAcquireResult._yay;

		const failSync = async (message: string) => {
			await ctx.runMutation(internal.github_sources.mark_sync_error, {
				sourceId: args.sourceId,
				syncRunId,
				message,
			});
		};

		// Safety net: every step below either returns a Result (handled inline via failSync) or can throw
		// uncaught (stream error, enqueue failure, mutation OCC exhaustion, infra blip). An uncaught throw
		// here would leave the lock held with `producerFinishedAt` null — a permanent wedge until the 30-min
		// stale reclaim. Convert any such throw into a recoverable `error` status.
		try {
			// 2. Metadata: default branch + head commit/tree SHA.
			const repoResult = await github_sync_fetch_with_retry(
				`https://api.github.com/repos/${source.owner}/${source.repo}`,
				{ allowTransient404: false },
			);
			if (repoResult._nay) {
				await failSync(`Repo metadata fetch failed: ${repoResult._nay.message}`);
				return null;
			}
			const repoParsed = json_parse_and_validate(await repoResult._yay.text(), github_repo_schema);
			if (repoParsed._nay) {
				await failSync(`Repo metadata parse failed: ${repoParsed._nay.message}`);
				return null;
			}

			const branchResult = await github_sync_fetch_with_retry(
				`https://api.github.com/repos/${source.owner}/${source.repo}/branches/${encodeURIComponent(source.ref)}`,
				{ allowTransient404: false },
			);
			if (branchResult._nay) {
				await failSync(`Branch metadata fetch failed: ${branchResult._nay.message}`);
				return null;
			}
			const branchParsed = json_parse_and_validate(await branchResult._yay.text(), github_branch_schema);
			if (branchParsed._nay) {
				await failSync(`Branch metadata parse failed: ${branchParsed._nay.message}`);
				return null;
			}

			const commitSha = branchParsed._yay.commit.sha;
			const treeSha = branchParsed._yay.commit.commit.tree.sha;

			// 3. Early-return if the commit hasn't moved.
			if (commitSha === source.lastCommitSha) {
				await ctx.runMutation(internal.github_sources.release_sync_lock_unchanged, {
					sourceId: args.sourceId,
					syncRunId,
				});
				return null;
			}

			await ctx.runMutation(internal.github_sources.stage_target_sha, {
				sourceId: args.sourceId,
				syncRunId,
				commitSha,
				treeSha,
				defaultBranch: repoParsed._yay.default_branch,
			});

			// 4. Download ONE commit-pinned archive (with codeload-lag tolerance), confirm 2xx + within caps.
			const archiveResult = await github_sync_fetch_with_retry(
				github_source_codeload_url({ owner: source.owner, repo: source.repo, commitSha }),
				{ allowTransient404: true },
			);
			if (archiveResult._nay) {
				await failSync(`Archive download failed: ${archiveResult._nay.message}`);
				return null;
			}
			const archiveResponse = archiveResult._yay;
			const contentLengthHeader = archiveResponse.headers.get("content-length");
			if (contentLengthHeader && Number(contentLengthHeader) > GITHUB_SYNC_MAX_COMPRESSED_BYTES) {
				await failSync(`Archive Content-Length ${contentLengthHeader} exceeds compressed cap`);
				return null;
			}
			const body = archiveResponse.body;
			if (!body) {
				await failSync("Archive response had no body stream");
				return null;
			}

			// 5. Hard-delete the mount as a completed barrier (only after a confirmed 2xx archive).
			for (;;) {
				const batch = await ctx.runMutation(internal.github_sources.delete_mount_content_batch, {
					sourceId: args.sourceId,
					syncRunId,
				});
				if (batch.superseded) {
					return null;
				}
				if (batch.done) {
					break;
				}
			}

			// 6. Stream-parse the archive one entry at a time with explicit backpressure.
			const streamResult = await github_sync_stream_archive(ctx, {
				sourceId: args.sourceId,
				syncRunId,
				mountName: source.name,
				body,
			});
			if (streamResult._nay) {
				await failSync(streamResult._nay.message);
				return null;
			}

			// 8. Producer finished — finalize fires here when there were zero jobs, else the last job closes it.
			await ctx.runMutation(internal.github_sources.mark_producer_finished, {
				sourceId: args.sourceId,
				syncRunId,
				enqueuedCount: streamResult._yay.enqueuedCount,
				skippedCount: streamResult._yay.skippedCount,
				compressedBytesRead: streamResult._yay.compressedBytesRead,
				acceptedUncompressedBytes: streamResult._yay.acceptedUncompressedBytes,
			});
			return null;
		} catch (error) {
			await failSync(`Sync crashed: ${error instanceof Error ? error.message : String(error)}`);
			return null;
		}
	},
});

type github_sync_completed_entry = {
	relPath: string;
	bytes: Uint8Array[] | null;
	totalBytes: number;
	bufferedBytes: number;
	oversize: boolean;
	errored: boolean;
};

/**
 * Drive `fflate`'s push-based `Unzip` over `body`, one response chunk at a time. Per kept entry, enqueue a
 * `sync_materialize_file` job. Backpressure: completed-entry handling (decode + enqueue) is drained between
 * `reader.read()` calls so outstanding enqueue promises never accumulate beyond one response chunk's worth.
 */
async function github_sync_stream_archive(
	ctx: ActionCtx,
	args: { sourceId: Id<"github_sources">; syncRunId: string; mountName: string; body: ReadableStream<Uint8Array> },
) {
	const decoder = new TextDecoder("utf-8", { fatal: true });
	const completed: github_sync_completed_entry[] = [];

	let topLevelDir: string | null = null;
	let bufferedCompletedEntries = 0;
	let bufferedBytes = 0;
	let enqueuedCount = 0;
	let skippedCount = 0;
	let acceptedFileCount = 0;
	let acceptedUncompressedBytes = 0;
	let compressedBytesRead = 0;
	let abortMessage: string | null = null;

	const resolveRelPath = (entryName: string) => {
		const firstSlash = entryName.indexOf("/");
		if (firstSlash === -1) {
			abortMessage = `Archive entry "${entryName}" is not under a top-level folder`;
			return null;
		}

		const entryTop = entryName.slice(0, firstSlash);
		if (topLevelDir === null) {
			topLevelDir = entryTop;
		}
		if (entryTop !== topLevelDir) {
			abortMessage = `Archive has multiple top-level entries ("${topLevelDir}" vs "${entryTop}")`;
			return null;
		}

		return entryName.slice(topLevelDir.length + 1);
	};

	const drainSkippedFile = (file: UnzipFile) => {
		file.ondata = () => {};
		file.start();
	};

	const enqueueCompleted = (entry: github_sync_completed_entry) => {
		completed.push(entry);
		bufferedCompletedEntries++;
		if (bufferedCompletedEntries > GITHUB_SYNC_MAX_BUFFERED_COMPLETED_ENTRIES) {
			abortMessage = `Buffered ZIP entries exceed ${GITHUB_SYNC_MAX_BUFFERED_COMPLETED_ENTRIES}`;
		}
	};

	const unzip = new Unzip((file: UnzipFile) => {
		if (file.name.endsWith("/")) {
			// Directory entry — skip (no decompression stream needed).
			return;
		}
		const relPath = resolveRelPath(file.name);
		if (relPath == null) {
			drainSkippedFile(file);
			return;
		}

		const classification = github_source_classify_rel_path(relPath);
		if (!classification.keep) {
			skippedCount++;
			drainSkippedFile(file);
			return;
		}

		const entry: github_sync_completed_entry = {
			relPath,
			bytes: [],
			totalBytes: 0,
			bufferedBytes: 0,
			oversize: false,
			errored: false,
		};
		file.ondata = (err, chunk, final) => {
			if (err) {
				entry.errored = true;
				if (entry.bufferedBytes > 0) {
					bufferedBytes -= entry.bufferedBytes;
					entry.bufferedBytes = 0;
				}
				entry.bytes = null;
			} else if (!entry.oversize && !entry.errored && entry.bytes) {
				entry.totalBytes += chunk.length;
				if (entry.totalBytes > files_MAX_TEXT_CONTENT_BYTES) {
					entry.oversize = true;
					if (entry.bufferedBytes > 0) {
						bufferedBytes -= entry.bufferedBytes;
						entry.bufferedBytes = 0;
					}
					entry.bytes = null;
				} else {
					// Copy: fflate may reuse the underlying buffer across ondata calls.
					const copied = chunk.slice();
					entry.bytes.push(copied);
					entry.bufferedBytes += copied.length;
					bufferedBytes += copied.length;
					if (bufferedBytes > GITHUB_SYNC_MAX_BUFFERED_BYTES) {
						abortMessage = `Buffered ZIP bytes exceed ${GITHUB_SYNC_MAX_BUFFERED_BYTES}`;
					}
				}
			}
			if (final) {
				enqueueCompleted(entry);
			}
		};
		file.start();
	});
	unzip.register(UnzipInflate);

	const flushCompleted = async () => {
		while (completed.length > 0) {
			const entry = completed.shift();
			if (!entry) {
				break;
			}
			bufferedCompletedEntries--;
			if (entry.bufferedBytes > 0) {
				bufferedBytes -= entry.bufferedBytes;
				entry.bufferedBytes = 0;
			}

			if (entry.errored) {
				skippedCount++;
				continue;
			}
			if (entry.oversize || entry.bytes === null) {
				skippedCount++;
				continue;
			}

			let text: string;
			try {
				text = decoder.decode(concat_uint8(entry.bytes, entry.totalBytes));
			} catch {
				// Invalid UTF-8 → treat as binary, skip.
				skippedCount++;
				continue;
			}
			if (github_source_is_lfs_pointer(text)) {
				skippedCount++;
				continue;
			}

			const byteSize = files_get_utf8_byte_size(text);
			if (byteSize > files_MAX_TEXT_CONTENT_BYTES) {
				skippedCount++;
				continue;
			}
			if (acceptedFileCount + 1 > GITHUB_SYNC_MAX_ACCEPTED_FILES) {
				abortMessage = `Accepted file count exceeds ${GITHUB_SYNC_MAX_ACCEPTED_FILES}`;
				return;
			}
			if (acceptedUncompressedBytes + byteSize > GITHUB_SYNC_MAX_ACCEPTED_UNCOMPRESSED_BYTES) {
				abortMessage = `Accepted uncompressed bytes exceed ${GITHUB_SYNC_MAX_ACCEPTED_UNCOMPRESSED_BYTES}`;
				return;
			}

			acceptedFileCount++;
			acceptedUncompressedBytes += byteSize;
			enqueuedCount++;
			await github_sources_workpool.enqueueAction(
				ctx,
				internal.github_sources.sync_materialize_file,
				{
					sourceId: args.sourceId,
					syncRunId: args.syncRunId,
					storedPath: `/${args.mountName}/${entry.relPath}`,
					text,
				},
				{
					context: { sourceId: args.sourceId, syncRunId: args.syncRunId },
					onComplete: internal.github_sources.handle_materialize_complete,
				},
			);
		}
	};

	const reader = args.body.getReader();
	const emptyChunk = new Uint8Array(0);
	let finished = false;
	while (!finished && abortMessage === null) {
		const { done, value } = await reader.read();
		if (done) {
			unzip.push(emptyChunk, true);
			finished = true;
		} else {
			compressedBytesRead += value.length;
			if (compressedBytesRead > GITHUB_SYNC_MAX_COMPRESSED_BYTES) {
				abortMessage = `Compressed bytes read exceed ${GITHUB_SYNC_MAX_COMPRESSED_BYTES}`;
				break;
			}
			for (let offset = 0; offset < value.length && abortMessage === null; offset += GITHUB_SYNC_ZIP_PUSH_CHUNK_BYTES) {
				unzip.push(value.slice(offset, offset + GITHUB_SYNC_ZIP_PUSH_CHUNK_BYTES), false);
				if (abortMessage !== null) {
					break;
				}
				await flushCompleted();
			}
		}

		if (abortMessage === null) {
			await flushCompleted();
		}

		// Keep counters fresh during long streams. Best-effort: this patches the same source doc that every
		// concurrent `handle_materialize_complete` also patches, so under a completion storm it can lose the
		// OCC race and throw. Progress is cosmetic — a failed update must never abort the stream and leave the
		// sync permanently wedged (producer dead, `producerFinishedAt` null). Counters resync next chunk.
		try {
			await ctx.runMutation(internal.github_sources.record_producer_progress, {
				sourceId: args.sourceId,
				syncRunId: args.syncRunId,
				enqueuedCount,
				skippedCount,
				compressedBytesRead,
				acceptedUncompressedBytes,
			});
		} catch {
			// Swallow: a lost progress write is recovered on the next chunk or at mark_producer_finished.
		}
	}

	await reader.cancel().catch(() => undefined);

	if (abortMessage !== null) {
		return Result({ _nay: { message: abortMessage } });
	}

	return Result({
		_yay: { enqueuedCount, skippedCount, compressedBytesRead, acceptedUncompressedBytes },
	});
}

function concat_uint8(parts: Uint8Array[], totalBytes: number): Uint8Array {
	const out = new Uint8Array(totalBytes);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

// #endregion producer action

// #region cron + manual trigger (E3/E4)

/** Cron target: schedule a sync for every configured source. Real work only happens on SHA movement. */
export const sync_all_sources = internalAction({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const sources = await ctx.runQuery(internal.github_sources.list_all_source_ids, {});
		for (const sourceId of sources) {
			await ctx.scheduler.runAfter(0, internal.github_sources.sync_github_source, { sourceId });
		}
		return null;
	},
});

export const list_all_source_ids = internalQuery({
	args: {},
	returns: v.array(v.id("github_sources")),
	handler: async (ctx) => {
		const sources = await ctx.db.query("github_sources").collect();
		return sources.map((source) => source._id);
	},
});

// Annotated explicitly because the handler references same-module functions through
// `internal.github_sources`, which would otherwise make the inferred type circular.
type trigger_sync_Result =
	| {
			_yay: {
				status: "idle" | "running" | "error";
				lastCommitSha: string | null;
				lastError: string | null;
			};
			_nay?: undefined;
	  }
	| {
			_nay: { name?: string; message: string; cause?: unknown; data?: unknown; stack?: string };
			_yay?: undefined;
	  };

/**
 * Manual verification entrypoint: upsert (if needed) and synchronously run one sync by mount name. Returns
 * the final source status so `convex run` shows the outcome.
 */
export const trigger_sync = internalAction({
	args: { name: v.string() },
	returns: v_result({
		_yay: v.object({
			status: v.union(v.literal("idle"), v.literal("running"), v.literal("error")),
			lastCommitSha: v.union(v.string(), v.null()),
			lastError: v.union(v.string(), v.null()),
		}),
	}),
	handler: async (ctx, args): Promise<trigger_sync_Result> => {
		const source = await ctx.runQuery(internal.github_sources.get_source_by_name, { name: args.name });
		if (!source) {
			return Result({ _nay: { message: `No github_source named "${args.name}"` } });
		}
		await ctx.runAction(internal.github_sources.sync_github_source, { sourceId: source._id });
		const after = await ctx.runQuery(internal.github_sources.get_source, { sourceId: source._id });
		if (!after) {
			return Result({ _nay: { message: "Source vanished mid-sync" } });
		}
		return Result({
			_yay: { status: after.status, lastCommitSha: after.lastCommitSha, lastError: after.lastError },
		});
	},
});

// #endregion cron + manual trigger
