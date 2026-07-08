/*
Read-only GitHub repo mirror ("mount") sync pipeline.

A `github_mounts` doc maps a public GitHub repo to a mount name → `/.mounts/<name>` in the bash tool.
Content lives in immutable per-commit roots `/<name>/<commitSha>/...` in reserved scope
(`organizationId="GLOBAL"`, `workspaceId="GITHUB"`, author `"SYSTEM"`). When the commit moves, sync ingests
ONE commit-pinned codeload ZIP into a fresh root while the active root (`lastCommitSha`) keeps serving
reads; finalize flips the pointer and orphan roots are GC'd afterwards. Bash mounts only mounts with a
non-null `lastCommitSha`, so an in-progress or failed sync exposes nothing. No user file staging, no
revisions, no yjs. A crash leaves a partial pending root that the next run clears (same sha) or the GC
sweep collects (moved sha).

The producer (`sync_mount`) runs in the DEFAULT runtime: it streams the archive through `fflate`'s
push-based `Unzip` one entry at a time, enforces caps/filters, and enqueues one `sync_materialize_file`
workpool job per kept file. Jobs call the `create_file_node_internal` write path.
*/

import { Workpool } from "@convex-dev/workpool";
import { Unzip, UnzipInflate, type UnzipFile } from "fflate";
import { v } from "convex/values";
import { doc } from "convex-helpers/validators";
import { components, internal } from "./_generated/api.js";
import app_convex_schema from "./schema.ts";
import {
	internalAction,
	internalMutation,
	internalQuery,
	type ActionCtx,
	type MutationCtx,
} from "./_generated/server.js";
import type { Doc, Id } from "./_generated/dataModel";
import {
	organizations_GLOBAL_ORGANIZATION_ID,
	organizations_GLOBAL_GITHUB_WORKSPACE_ID,
} from "../shared/organizations.ts";
import { Result } from "../shared/errors-as-values-utils.ts";
import { should_never_happen } from "../shared/shared-utils.ts";
import { v_result } from "../server/convex-utils.ts";
import { github_codeload_url, github_fetch_repo_head, github_fetch_with_retry } from "../server/github.ts";
import { files_MAX_TEXT_CONTENT_BYTES, files_get_utf8_byte_size } from "../shared/files.ts";
import { files_nodes_db_delete_subtree_batch } from "./files_nodes.ts";

/** Full mount doc for a per-file job / test to verify lock + status. */
export const get_mount = internalQuery({
	args: { mountId: v.id("github_mounts") },
	returns: v.union(doc(app_convex_schema, "github_mounts"), v.null()),
	handler: async (ctx, args) => {
		return await ctx.db.get("github_mounts", args.mountId);
	},
});

export const get_mount_by_name = internalQuery({
	args: { name: v.string() },
	returns: v.union(doc(app_convex_schema, "github_mounts"), v.null()),
	handler: async (ctx, args) => {
		return await ctx.db
			.query("github_mounts")
			.withIndex("by_name", (q) => q.eq("name", args.name))
			.first();
	},
});

export const list_mounts = internalQuery({
	args: {},
	returns: v.array(doc(app_convex_schema, "github_mounts")),
	handler: async (ctx) => {
		return await ctx.db.query("github_mounts").withIndex("by_name").collect();
	},
});

/** Mount-safe slug. First char alnum, then alnum/`.`/`-`, max 63 chars. */
const GITHUB_MOUNT_NAME_REGEX = /^[a-z0-9][a-z0-9.-]{0,62}$/;
/** Names that would collide with traversal or the scratch dir. */
const GITHUB_MOUNT_RESERVED_NAMES = new Set([".", "..", "tmp"]);
/** GitHub login charset (owner/org): alnum + hyphen, max 39 chars. Keeps `owner` URL-injection-safe. */
const GITHUB_OWNER_REGEX = /^[a-zA-Z0-9-]{1,39}$/;
/** GitHub repo-name charset: alnum + `.`/`_`/`-`, max 100 chars. Keeps `repo` URL-injection-safe. */
const GITHUB_REPO_REGEX = /^[a-zA-Z0-9._-]{1,100}$/;

/**
 * Validate a mount name. Mount-safe slug, not a reserved/traversal name. Returns the normalized
 * (already-lowercase) name on success.
 */
export function github_mount_validate_name(name: string) {
	if (!GITHUB_MOUNT_NAME_REGEX.test(name)) {
		return Result({
			_nay: { message: `Invalid mount name "${name}": must match ${GITHUB_MOUNT_NAME_REGEX.source}` },
		});
	}
	if (GITHUB_MOUNT_RESERVED_NAMES.has(name)) {
		return Result({ _nay: { message: `Mount name "${name}" is reserved` } });
	}
	return Result({ _yay: name });
}

export const upsert_mount = internalMutation({
	args: {
		name: v.string(),
		owner: v.string(),
		repo: v.string(),
		ref: v.string(),
	},
	returns: v_result({ _yay: v.object({ mountId: v.id("github_mounts") }) }),
	handler: async (ctx, args) => {
		const nameResult = github_mount_validate_name(args.name);
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
			.query("github_mounts")
			.withIndex("by_name", (q) => q.eq("name", args.name))
			.first();

		if (existing) {
			await ctx.db.patch("github_mounts", existing._id, {
				owner: args.owner,
				repo: args.repo,
				ref: args.ref,
			});
			return Result({ _yay: { mountId: existing._id } });
		}

		const mountId = await ctx.db.insert("github_mounts", {
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
		return Result({ _yay: { mountId } });
	},
});

// #region sync

const github_mounts_workpool = new Workpool(components.github_mounts_workpool, {
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

/** Cron target: schedule a sync for every configured mount. Real work only happens on SHA movement. */
export const sync_all_mounts = internalAction({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const mounts = await ctx.runQuery(internal.github_mounts.list_all_mount_ids, {});
		for (const mountId of mounts) {
			await ctx.scheduler.runAfter(0, internal.github_mounts.sync_mount, { mountId });
		}
		return null;
	},
});

export const list_all_mount_ids = internalQuery({
	args: {},
	returns: v.array(v.id("github_mounts")),
	handler: async (ctx) => {
		const mounts = await ctx.db.query("github_mounts").collect();
		return mounts.map((mount) => mount._id);
	},
});

// Annotated explicitly because the handler references same-module functions through
// `internal.github_mounts`, which would otherwise make the inferred type circular.
type trigger_sync_Result =
	| {
			_yay: {
				status: "idle" | "running" | "error";
				lastCommitSha: string | null;
				lastError: string | null;
			};
			_nay?: undefined;
	  }
	| { _nay: { message: string }; _yay?: undefined };

/**
 * Manual verification entrypoint: upsert (if needed) and synchronously run one sync by mount name. Returns
 * the final mount status so `convex run` shows the outcome.
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
		const mount = await ctx.runQuery(internal.github_mounts.get_mount_by_name, { name: args.name });
		if (!mount) {
			return Result({ _nay: { message: `No github_mount named "${args.name}"` } });
		}
		await ctx.runAction(internal.github_mounts.sync_mount, { mountId: mount._id });
		const after = await ctx.runQuery(internal.github_mounts.get_mount, { mountId: mount._id });
		if (!after) {
			return Result({ _nay: { message: "Mount vanished mid-sync" } });
		}
		return Result({
			_yay: { status: after.status, lastCommitSha: after.lastCommitSha, lastError: after.lastError },
		});
	},
});

/** Conservative cap on the compressed archive (codeload ZIP). Rejected before/while streaming. */
const GITHUB_SYNC_MAX_COMPRESSED_BYTES = 12 * 1024 * 1024;
/** Cap on total accepted (post-decode) text bytes across the whole sync. */
const GITHUB_SYNC_MAX_ACCEPTED_UNCOMPRESSED_BYTES = 30 * 1024 * 1024;
/** Cap on the number of accepted files per sync. */
const GITHUB_SYNC_MAX_ACCEPTED_FILES = 5_000;
/** Keep accepted ZIP entry buffers under the V8 action memory cap while the producer waits to enqueue. */
const GITHUB_SYNC_ZIP_PUSH_CHUNK_BYTES = 64 * 1024;
const GITHUB_SYNC_MAX_BUFFERED_COMPLETED_ENTRIES = 256;
const GITHUB_SYNC_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

/**
 * Drive `fflate`'s push-based `Unzip` over `body`, one response chunk at a time. Per kept entry, enqueue a
 * `sync_materialize_file` job. Backpressure: completed-entry handling (decode + enqueue) is drained between
 * `reader.read()` calls so outstanding enqueue promises never accumulate beyond one response chunk's worth.
 */
async function github_sync_stream_archive(
	ctx: ActionCtx,
	args: {
		mountId: Id<"github_mounts">;
		syncRunId: string;
		mountName: string;
		commitSha: string;
		body: ReadableStream<Uint8Array>;
	},
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

		const classification = github_mount_classify_rel_path(relPath);
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
			if (github_mount_is_lfs_pointer(text)) {
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
			await github_mounts_workpool.enqueueAction(
				ctx,
				internal.github_mounts.sync_materialize_file,
				{
					mountId: args.mountId,
					syncRunId: args.syncRunId,
					storedPath: `/${args.mountName}/${args.commitSha}/${entry.relPath}`,
					text,
				},
				{
					context: { mountId: args.mountId, syncRunId: args.syncRunId },
					onComplete: internal.github_mounts.handle_materialize_complete,
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

		// Keep counters fresh during long streams. Best-effort: this patches the same mount doc that every
		// concurrent `handle_materialize_complete` also patches, so under a completion storm it can lose the
		// OCC race and throw. Progress is cosmetic — a failed update must never abort the stream and leave the
		// sync permanently wedged (producer dead, `producerFinishedAt` null). Counters resync next chunk.
		try {
			await ctx.runMutation(internal.github_mounts.record_producer_progress, {
				mountId: args.mountId,
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

/**
 * One streaming sync for a single mount. Acquires the lock, resolves the head commit, early-returns if
 * unchanged, downloads the commit-pinned archive, clears any leftover pending root as a barrier, then
 * stream-parses the ZIP into the fresh immutable root `/<name>/<commitSha>/...` and enqueues one
 * materialize job per kept file. Producer-finished + per-job finalize close the run and flip the pointer.
 */
export const sync_mount = internalAction({
	args: { mountId: v.id("github_mounts") },
	returns: v.null(),
	handler: async (ctx, args) => {
		const syncRunId = crypto.randomUUID();

		const syncAcquireResult = await ctx.runMutation(internal.github_mounts.acquire_sync_lock, {
			mountId: args.mountId,
			syncRunId,
		});
		if (syncAcquireResult._nay) {
			// Already running / stale-but-fresh — nothing to do.
			return null;
		}
		const mount = syncAcquireResult._yay;

		const failSync = async (message: string) => {
			await ctx.runMutation(internal.github_mounts.mark_sync_error, {
				mountId: args.mountId,
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
			const headResult = await github_fetch_repo_head({
				owner: mount.owner,
				repo: mount.repo,
				ref: mount.ref,
			});
			if (headResult._nay) {
				await failSync(`Repo metadata fetch failed: ${headResult._nay.message}`);
				return null;
			}

			const commitSha = headResult._yay.commitSha;
			const treeSha = headResult._yay.treeSha;

			// 3. Early-return if the commit hasn't moved.
			if (commitSha === mount.lastCommitSha) {
				await ctx.runMutation(internal.github_mounts.release_sync_lock_unchanged, {
					mountId: args.mountId,
					syncRunId,
				});
				return null;
			}

			await ctx.runMutation(internal.github_mounts.stage_target_sha, {
				mountId: args.mountId,
				syncRunId,
				commitSha,
				treeSha,
				defaultBranch: headResult._yay.defaultBranch,
			});

			// 4. Download ONE commit-pinned archive (with codeload-lag tolerance), confirm 2xx + within caps.
			const archiveResult = await github_fetch_with_retry(
				github_codeload_url({ owner: mount.owner, repo: mount.repo, commitSha }),
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

			// 5. Clear any leftover pending root as a completed barrier (only after a confirmed 2xx archive).
			// Normally a single no-op call; after a crash that re-targets the same sha it removes the
			// partial root so re-ingest doesn't collide with existing nodes.
			for (;;) {
				const batch = await ctx.runMutation(internal.github_mounts.clear_pending_root_batch, {
					mountId: args.mountId,
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
				mountId: args.mountId,
				syncRunId,
				mountName: mount.name,
				commitSha,
				body,
			});
			if (streamResult._nay) {
				await failSync(streamResult._nay.message);
				return null;
			}

			// 8. Producer finished — finalize fires here when there were zero jobs, else the last job closes it.
			await ctx.runMutation(internal.github_mounts.mark_producer_finished, {
				mountId: args.mountId,
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

export const sync_materialize_file = internalAction({
	args: {
		mountId: v.id("github_mounts"),
		syncRunId: v.string(),
		storedPath: v.string(),
		text: v.string(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		// Re-check the sync run before ANY side effect: a superseded job must not write into a newer mount.
		const mount = await ctx.runQuery(internal.github_mounts.get_mount, { mountId: args.mountId });
		if (!mount || mount.syncRunId !== args.syncRunId || mount.status !== "running") {
			return null;
		}

		// Throw on failure so the workpool retries transient blips (OCC, R2) and, once attempts are exhausted,
		// reports this job as `failed` to handle_materialize_complete. The completion hook — not this worker —
		// records the per-job result, so the finalize barrier still advances if this action is hard-terminated
		// (timeout / infra kill) and never returns. create_file_node_internal already retries write
		// conflicts internally and returns _nay on handled failures; surface that as a throw to retry/report.
		const created = await ctx.runAction(internal.files_nodes.create_file_node_internal, {
			workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
			path: args.storedPath,
			rawText: args.text,
			mountId: args.mountId,
			syncRunId: args.syncRunId,
		});
		if (created._nay) {
			throw new Error(`Mount file materialization failed (${args.storedPath}): ${created._nay.message}`);
		}
		return null;
	},
});

/** A `running` lock older than this is considered stale and may be reclaimed. Must exceed worst-case sync. */
const GITHUB_SYNC_STALE_LOCK_MS = 30 * 60 * 1000;

export const acquire_sync_lock = internalMutation({
	args: { mountId: v.id("github_mounts"), syncRunId: v.string() },
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
		const mount = await ctx.db.get("github_mounts", args.mountId);
		if (!mount) {
			return Result({ _nay: { message: "Mount not found" } });
		}

		const now = Date.now();
		const lockedAt = mount.lockedAt ?? 0;
		if (mount.status === "running" && now - lockedAt <= GITHUB_SYNC_STALE_LOCK_MS) {
			return Result({ _nay: { message: "Sync already running" } });
		}

		await ctx.db.patch("github_mounts", mount._id, {
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
				name: mount.name,
				owner: mount.owner,
				repo: mount.repo,
				ref: mount.ref,
				lastCommitSha: mount.lastCommitSha,
			},
		});
	},
});

/** Stage the target SHAs (learned at metadata fetch) so finalize can promote them on completion. */
export const stage_target_sha = internalMutation({
	args: {
		mountId: v.id("github_mounts"),
		syncRunId: v.string(),
		commitSha: v.string(),
		treeSha: v.string(),
		defaultBranch: v.string(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const mount = await ctx.db.get("github_mounts", args.mountId);
		if (!mount || mount.syncRunId !== args.syncRunId) {
			return null;
		}
		await ctx.db.patch("github_mounts", mount._id, {
			pendingCommitSha: args.commitSha,
			pendingTreeSha: args.treeSha,
			defaultBranch: args.defaultBranch,
		});
		return null;
	},
});

/** Release the lock with no content change (commit unchanged → early return). */
export const release_sync_lock_unchanged = internalMutation({
	args: { mountId: v.id("github_mounts"), syncRunId: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const mount = await ctx.db.get("github_mounts", args.mountId);
		if (!mount || mount.syncRunId !== args.syncRunId) {
			return null;
		}
		const now = Date.now();
		await ctx.db.patch("github_mounts", mount._id, {
			status: "idle",
			finishedAt: now,
			lastSyncedAt: now,
			syncRunId: undefined,
			pendingCommitSha: undefined,
			pendingTreeSha: undefined,
		});
		// A crashed earlier run may have left a partial root at a since-moved sha; sweep it.
		await ctx.scheduler.runAfter(GITHUB_SYNC_GC_DELAY_MS, internal.github_mounts.gc_sweep_mount_roots, {
			mountId: mount._id,
		});
		return null;
	},
});

export const mark_sync_error = internalMutation({
	args: { mountId: v.id("github_mounts"), syncRunId: v.string(), message: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const mount = await ctx.db.get("github_mounts", args.mountId);
		if (!mount || mount.syncRunId !== args.syncRunId) {
			return null;
		}
		await ctx.db.patch("github_mounts", mount._id, {
			status: "error",
			lastError: args.message,
			finishedAt: Date.now(),
			syncRunId: undefined,
			pendingCommitSha: undefined,
			pendingTreeSha: undefined,
		});
		// The failed run's partial pending root (never reader-visible) becomes an orphan; sweep it.
		await ctx.scheduler.runAfter(GITHUB_SYNC_GC_DELAY_MS, internal.github_mounts.gc_sweep_mount_roots, {
			mountId: mount._id,
		});
		return null;
	},
});

export const record_producer_progress = internalMutation({
	args: {
		mountId: v.id("github_mounts"),
		syncRunId: v.string(),
		enqueuedCount: v.number(),
		skippedCount: v.number(),
		compressedBytesRead: v.number(),
		acceptedUncompressedBytes: v.number(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const mount = await ctx.db.get("github_mounts", args.mountId);
		if (!mount || mount.syncRunId !== args.syncRunId) {
			return null;
		}
		await ctx.db.patch("github_mounts", mount._id, {
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
		mountId: v.id("github_mounts"),
		syncRunId: v.string(),
		enqueuedCount: v.number(),
		skippedCount: v.number(),
		compressedBytesRead: v.number(),
		acceptedUncompressedBytes: v.number(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const mount = await ctx.db.get("github_mounts", args.mountId);
		if (!mount || mount.syncRunId !== args.syncRunId) {
			return null;
		}
		await ctx.db.patch("github_mounts", mount._id, {
			producerFinishedAt: Date.now(),
			enqueuedCount: args.enqueuedCount,
			skippedCount: args.skippedCount,
			compressedBytesRead: args.compressedBytesRead,
			acceptedUncompressedBytes: args.acceptedUncompressedBytes,
		});
		await db_maybe_finalize_sync(ctx, { mountId: args.mountId, syncRunId: args.syncRunId });
		return null;
	},
});

/**
 * Workpool completion hook for per-file materialize jobs. Fires exactly once per job after it reaches a
 * terminal state — success, failed (retries exhausted), or canceled — so the finalize barrier advances even
 * when a worker is hard-terminated (action timeout / infra kill) and never returns to report itself.
 * Sync-run-gated: completions belonging to a superseded run are ignored.
 */
export const handle_materialize_complete = github_mounts_workpool.defineOnComplete({
	context: v.object({
		mountId: v.id("github_mounts"),
		syncRunId: v.string(),
	}),
	handler: async (ctx, args) => {
		// The onComplete ctx is typed against the workpool component's generic DataModel, so its context Ids and
		// db docs come back untyped; restore the types the validator + schema already guarantee (matches
		// billing_workpool_cancellation.defineOnComplete).
		const mountId = args.context.mountId as Id<"github_mounts">;
		const mount = (await ctx.db.get("github_mounts", mountId)) as Doc<"github_mounts"> | null;
		if (!mount || mount.syncRunId !== args.context.syncRunId) {
			return;
		}
		const ok = args.result.kind === "success";
		await ctx.db.patch("github_mounts", mount._id, {
			completedCount: (mount.completedCount ?? 0) + (ok ? 1 : 0),
			failedCount: (mount.failedCount ?? 0) + (ok ? 0 : 1),
		});
		await db_maybe_finalize_sync(ctx, { mountId, syncRunId: args.context.syncRunId });
	},
});

/**
 * Close the run once the producer has finished AND every enqueued job has reported. Successful finalization
 * promotes the staged SHAs; failed materialization finalization clears them and leaves the mount errored.
 * Called by both the producer (covers `enqueuedCount === 0`) and each job's completion hook, so the last one
 * to satisfy the gate closes the run. Sync-run-gated and idempotent.
 */
async function db_maybe_finalize_sync(ctx: MutationCtx, args: { mountId: Id<"github_mounts">; syncRunId: string }) {
	const mount = await ctx.db.get("github_mounts", args.mountId);
	if (!mount || mount.syncRunId !== args.syncRunId || mount.status !== "running") {
		return;
	}
	if (mount.producerFinishedAt == null) {
		return;
	}
	const reported = (mount.completedCount ?? 0) + (mount.failedCount ?? 0);
	if (reported < (mount.enqueuedCount ?? 0)) {
		return;
	}
	if (mount.pendingCommitSha == null) {
		throw should_never_happen("Finalizing a sync with no staged commit SHA", { mountId: mount._id });
	}
	const now = Date.now();
	if ((mount.failedCount ?? 0) > 0) {
		await ctx.db.patch("github_mounts", mount._id, {
			status: "error",
			finishedAt: now,
			lastError: `Sync failed to materialize ${mount.failedCount} file${mount.failedCount === 1 ? "" : "s"}`,
			syncRunId: undefined,
			pendingCommitSha: undefined,
			pendingTreeSha: undefined,
		});
		// The partial pending root (never reader-visible) becomes an orphan; sweep it.
		await ctx.scheduler.runAfter(GITHUB_SYNC_GC_DELAY_MS, internal.github_mounts.gc_sweep_mount_roots, {
			mountId: mount._id,
		});
		return;
	}
	await ctx.db.patch("github_mounts", mount._id, {
		lastCommitSha: mount.pendingCommitSha,
		lastTreeSha: mount.pendingTreeSha ?? null,
		lastSyncedAt: now,
		status: "idle",
		finishedAt: now,
		syncRunId: undefined,
		pendingCommitSha: undefined,
		pendingTreeSha: undefined,
	});
	// The previous active root is now an orphan. The sweep is delayed so bash runs that pinned the old
	// `name→sha` map at run start can finish reading it; new runs already resolve the flipped pointer.
	await ctx.scheduler.runAfter(GITHUB_SYNC_GC_DELAY_MS, internal.github_mounts.gc_sweep_mount_roots, {
		mountId: mount._id,
	});
}

/** Soft ceiling on doc deletions per root-delete batch mutation (keeps each transaction bounded). */
const GITHUB_SYNC_MOUNT_DELETE_BATCH = 500;

/**
 * Delay before sweeping orphan roots after a terminal sync event. Bash pins the `name→commitSha` map
 * once per run, so a run that started just before a pointer flip keeps reading the old root; the delay
 * lets those in-flight runs finish before the root disappears.
 */
const GITHUB_SYNC_GC_DELAY_MS = 5 * 60 * 1000;

function github_sync_mount_delete_batch_size(args: { _test_batchSize?: number }) {
	return Math.max(2, Math.min(args._test_batchSize ?? GITHUB_SYNC_MOUNT_DELETE_BATCH, GITHUB_SYNC_MOUNT_DELETE_BATCH));
}

/**
 * Delete one bounded batch of the run's pending root (`/<name>/<pendingCommitSha>/...` in `GLOBAL`/`GITHUB`).
 * Returns `{ done, deletedCount, superseded }`; stale sync-run calls return superseded. The sync action
 * drives this to `done:true` as a hard barrier before ingesting — normally a no-op, its real job is
 * clearing the partial root a crashed run left at the same sha (re-ingest would hit "already exists").
 * Never touches the active root, so readers are unaffected.
 */
export const clear_pending_root_batch = internalMutation({
	args: { mountId: v.id("github_mounts"), syncRunId: v.string(), _test_batchSize: v.optional(v.number()) },
	returns: v.object({ done: v.boolean(), deletedCount: v.number(), superseded: v.boolean() }),
	handler: async (ctx, args) => {
		const mount = await ctx.db.get("github_mounts", args.mountId);
		if (
			!mount ||
			mount.syncRunId !== args.syncRunId ||
			mount.status !== "running" ||
			mount.pendingCommitSha == null
		) {
			return { done: true, deletedCount: 0, superseded: true };
		}

		const batch = await files_nodes_db_delete_subtree_batch(ctx, {
			organizationId: organizations_GLOBAL_ORGANIZATION_ID,
			workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
			treePathPrefix: `/${mount.name}/${mount.pendingCommitSha}/`,
			batchSize: github_sync_mount_delete_batch_size(args),
		});
		return { done: batch.done, deletedCount: batch.deletedCount, superseded: false };
	},
});

/**
 * Collect commit roots that are neither active (`lastCommitSha`) nor being ingested by a running sync
 * (`pendingCommitSha`). Deletes one bounded batch per invocation and self-reschedules until nothing is
 * left. The keep-set is re-read inside every batch transaction, so a root staged by `stage_target_sha`
 * mid-sweep is never collected (Convex serializes the two mutations). Scheduled (delayed) by every
 * terminal sync mutation; over-scheduling is harmless — a sweep with no orphans is a no-op.
 */
export const gc_sweep_mount_roots = internalMutation({
	args: { mountId: v.id("github_mounts"), _test_batchSize: v.optional(v.number()) },
	returns: v.object({ done: v.boolean(), deletedCount: v.number() }),
	handler: async (ctx, args) => {
		const mount = await ctx.db.get("github_mounts", args.mountId);
		if (!mount) {
			return { done: true, deletedCount: 0 };
		}
		const keepShas = new Set<string>();
		if (mount.lastCommitSha != null) {
			keepShas.add(mount.lastCommitSha);
		}
		if (mount.status === "running" && mount.pendingCommitSha != null) {
			keepShas.add(mount.pendingCommitSha);
		}

		// Commit roots are the active folder children of `/<name>`; each child folder's name is a sha.
		// The shared `/<name>` folder itself is never deleted.
		const mountRoot = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
				q
					.eq("organizationId", organizations_GLOBAL_ORGANIZATION_ID)
					.eq("workspaceId", organizations_GLOBAL_GITHUB_WORKSPACE_ID)
					.eq("path", `/${mount.name}`)
					.eq("archiveOperationId", undefined),
			)
			.first();
		if (!mountRoot) {
			return { done: true, deletedCount: 0 };
		}
		const children = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_parent_archiveOperation_name", (q) =>
				q
					.eq("organizationId", organizations_GLOBAL_ORGANIZATION_ID)
					.eq("workspaceId", organizations_GLOBAL_GITHUB_WORKSPACE_ID)
					.eq("parentId", mountRoot._id)
					.eq("archiveOperationId", undefined),
			)
			.collect();
		const orphan = children.find((child) => child.kind === "folder" && !keepShas.has(child.name));
		if (!orphan) {
			return { done: true, deletedCount: 0 };
		}

		const batch = await files_nodes_db_delete_subtree_batch(ctx, {
			organizationId: organizations_GLOBAL_ORGANIZATION_ID,
			workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
			treePathPrefix: `/${mount.name}/${orphan.name}/`,
			batchSize: github_sync_mount_delete_batch_size(args),
		});
		await ctx.scheduler.runAfter(0, internal.github_mounts.gc_sweep_mount_roots, {
			mountId: args.mountId,
			_test_batchSize: args._test_batchSize,
		});
		return { done: false, deletedCount: batch.deletedCount };
	},
});

// #endregion sync

// #region ingest filtering

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

/** Binary file extensions (lowercased, no dot) excluded — these are not mount text. */
const GITHUB_SYNC_BINARY_EXTENSIONS = new Set([
	// images
	"png",
	"jpg",
	"jpeg",
	"gif",
	"webp",
	"bmp",
	"ico",
	"tiff",
	"avif",
	"heic",
	// fonts
	"woff",
	"woff2",
	"ttf",
	"otf",
	"eot",
	// archives
	"zip",
	"gz",
	"tgz",
	"bz2",
	"xz",
	"7z",
	"rar",
	"tar",
	"zst",
	// media
	"mp3",
	"mp4",
	"wav",
	"ogg",
	"webm",
	"mov",
	"avi",
	"mkv",
	"flac",
	"m4a",
	// docs/binaries
	"pdf",
	"doc",
	"docx",
	"xls",
	"xlsx",
	"ppt",
	"pptx",
	// compiled / native
	"wasm",
	"so",
	"dylib",
	"dll",
	"exe",
	"o",
	"a",
	"class",
	"jar",
	"node",
	// db / misc binary
	"sqlite",
	"db",
	"bin",
	"dat",
	"lockb",
	"pyc",
	"pdb",
]);

/** Git-LFS pointer files start with this line; their content is a pointer, not the real bytes. */
const GITHUB_SYNC_LFS_POINTER_PREFIX = "version https://git-lfs.github.com/spec/v1";

function github_mount_lowercase_extension(relPath: string): string | null {
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
export function github_mount_classify_rel_path(relPath: string): { keep: true } | { keep: false; reason: string } {
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
	const extension = github_mount_lowercase_extension(relPath);
	if (extension !== null && GITHUB_SYNC_BINARY_EXTENSIONS.has(extension)) {
		return { keep: false, reason: `binary extension ".${extension}"` };
	}
	return { keep: true };
}

export function github_mount_is_lfs_pointer(text: string): boolean {
	return text.startsWith(GITHUB_SYNC_LFS_POINTER_PREFIX);
}

// #endregion ingest filtering
