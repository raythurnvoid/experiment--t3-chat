// R2 client and object helpers.
//
// Lives outside `r2.ts` because that module also imports `plugins_runtime.ts`, `organizations.ts`,
// and `files_nodes.ts` for its upload pipeline routes. Modules that only need to sign, read, write,
// or delete an R2 object (file-tree mutations, pending updates, snapshots) import this lean module
// so a cold Convex call does not pay the whole upload-pipeline module evaluation.

import { R2 } from "@convex-dev/r2";
import type { RegisteredQuery } from "convex/server";
import { v } from "convex/values";
import { doc } from "convex-helpers/validators";
import { components, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import {
	internalAction,
	internalMutation,
	internalQuery,
	type ActionCtx,
	type MutationCtx,
} from "./_generated/server.js";
import app_convex_schema from "./schema.ts";
import { convex_error } from "../server/convex-utils.ts";

if (!process.env.R2_BUCKET_FILES) {
	throw convex_error({ message: "R2_BUCKET_FILES is not set in Convex env" });
}

const R2_BUCKET_FILES = process.env.R2_BUCKET_FILES;

if (!process.env.R2_ENDPOINT) {
	throw convex_error({ message: "R2_ENDPOINT is not set in Convex env" });
}

const R2_ENDPOINT = process.env.R2_ENDPOINT;

if (!process.env.R2_ACCESS_KEY_ID) {
	throw convex_error({ message: "R2_ACCESS_KEY_ID is not set in Convex env" });
}

const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;

if (!process.env.R2_SECRET_ACCESS_KEY) {
	throw convex_error({ message: "R2_SECRET_ACCESS_KEY is not set in Convex env" });
}

const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;

const r2 = new R2(components.r2, {
	bucket: R2_BUCKET_FILES,
	endpoint: R2_ENDPOINT,
	accessKeyId: R2_ACCESS_KEY_ID,
	secretAccessKey: R2_SECRET_ACCESS_KEY,
});

export async function r2_get_download_url(args: {
	key: Parameters<typeof r2.getUrl>[0];
	options?: Parameters<typeof r2.getUrl>[1];
}) {
	return await r2.getUrl(args.key, {
		...args.options,
	});
}

export function r2_get_bucket() {
	return r2.config.bucket;
}

export async function r2_generate_upload_url(key: Parameters<typeof r2.generateUploadUrl>[0]) {
	return await r2.generateUploadUrl(key);
}

export function r2_create_asset_key(args: {
	organizationId: string;
	workspaceId: string;
	assetId: Id<"files_r2_assets">;
}) {
	return `organizations/${args.organizationId}/workspaces/${args.workspaceId}/assets/${args.assetId}`;
}

/**
 * Build the temporary R2 key used by a signed upload URL. The backend later copies this object to
 * the final key. Reusing the URL can change only the temporary object.
 */
export function r2_create_upload_staging_key(args: {
	organizationId: string;
	workspaceId: string;
	assetId: Id<"files_r2_assets">;
}) {
	return `organizations/${args.organizationId}/workspaces/${args.workspaceId}/upload-staging/${args.assetId}`;
}

/**
 * Wait 24 hours before checking an unfinished asset. This is much longer than the 15-minute upload
 * URL lifetime, so cleanup does not remove a normal upload that is still finishing.
 */
export const r2_UNFINALIZED_ASSET_TTL_MS = 24 * 60 * 60 * 1000;

export async function r2_put_object(
	ctx: ActionCtx,
	args: {
		key: string;
		body: BodyInit;
		contentType?: string;
	},
) {
	// Use signed PUT instead of r2.store() so deterministic content keys remain idempotent across Workpool retries.
	const upload = await r2_generate_upload_url(args.key);
	const response = await fetch(upload.url, {
		method: "PUT",
		headers: args.contentType ? { "Content-Type": args.contentType } : undefined,
		body: args.body,
	});
	if (!response.ok) {
		throw convex_error({
			message: "Failed to write R2 object",
			cause: {
				status: response.status,
				key: args.key,
			},
		});
	}

	await r2.syncMetadata(ctx, args.key);
}

export async function r2_fetch_object_from_bucket(args: { key: string }) {
	const url = await r2_get_download_url({
		key: args.key,
		options: {
			expiresIn: 60,
		},
	});
	const response = await fetch(url);
	if (!response.ok) {
		throw convex_error({
			message: "Failed to read R2 object",
			cause: {
				status: response.status,
				key: args.key,
			},
		});
	}

	return response;
}

/**
 * Fetch a bounded byte range of an R2 object via an HTTP Range request (R2 honors it and
 * returns 206 Partial Content). Lets callers read a window of a large object instead of the
 * whole thing. `start`/`endInclusive` are 0-based byte offsets; the response may be shorter
 * than requested at end-of-object.
 */
export async function r2_fetch_object_range_from_bucket(args: { key: string; start: number; endInclusive: number }) {
	const url = await r2_get_download_url({
		key: args.key,
		options: {
			expiresIn: 60,
		},
	});
	const response = await fetch(url, {
		headers: { Range: `bytes=${args.start}-${args.endInclusive}` },
	});
	// 206 = partial content (range honored); 200 = full object (range ignored by store) — both usable.
	if (!response.ok && response.status !== 206) {
		throw convex_error({
			message: "Failed to read R2 object range",
			cause: {
				status: response.status,
				key: args.key,
				range: `bytes=${args.start}-${args.endInclusive}`,
			},
		});
	}

	return response;
}

/**
 * Copy a temporary R2 object to its final key. Never replace an object already at the final key.
 */
export async function r2_copy_object_to_immutable_key(
	ctx: ActionCtx,
	args: {
		sourceKey: string;
		destinationKey: string;
		expectedSource?: {
			size: number;
			etag?: string;
		};
	},
) {
	const readMetadata = (response: Response, key: string) => {
		const contentLength = response.headers.get("Content-Length");
		const size = contentLength === null ? undefined : Number(contentLength);
		if (size !== undefined && (!Number.isSafeInteger(size) || size < 0)) {
			throw convex_error({
				message: "R2 object has an invalid Content-Length",
				cause: { key, contentLength },
			});
		}
		return {
			size,
			etag: response.headers.get("ETag") ?? undefined,
		};
	};

	const normalizeEtag = (etag: string) => {
		return etag.replace(/^W\//, "").replace(/^"|"$/g, "");
	};

	const getDestinationMetadata = async (response: Response) => {
		const metadata = readMetadata(response, args.destinationKey);
		await response.body?.cancel();
		if (metadata.size === undefined) {
			throw convex_error({
				message: "Immutable R2 object is missing Content-Length",
				cause: { key: args.destinationKey },
			});
		}
		await r2.syncMetadata(ctx, args.destinationKey);
		return {
			outcome: "ready" as const,
			size: metadata.size,
			etag: metadata.etag,
		};
	};

	const destinationUrl = await r2_get_download_url({
		key: args.destinationKey,
		options: { expiresIn: 60 },
	});
	const existingDestination = await fetch(destinationUrl);
	if (existingDestination.ok) {
		// A previous attempt may have copied the object before it crashed. Trust the final object's
		// metadata because the temporary object may have changed.
		return await getDestinationMetadata(existingDestination);
	}
	if (existingDestination.status !== 404) {
		throw convex_error({
			message: "Failed to check immutable R2 object",
			cause: {
				status: existingDestination.status,
				key: args.destinationKey,
			},
		});
	}

	const sourceUrl = await r2_get_download_url({
		key: args.sourceKey,
		options: { expiresIn: 60 },
	});
	const source = await fetch(sourceUrl);
	if (source.status === 404) {
		return { outcome: "source_missing" as const };
	}
	if (!source.ok) {
		throw convex_error({
			message: "Failed to read staged R2 object",
			cause: {
				status: source.status,
				key: args.sourceKey,
			},
		});
	}
	const sourceMetadata = readMetadata(source, args.sourceKey);
	// The signed URL may have replaced the temporary object after R2 created this event. Copy only
	// when the event still matches the current object.
	if (args.expectedSource !== undefined) {
		if (sourceMetadata.size === undefined || sourceMetadata.etag === undefined) {
			await source.body?.cancel();
			throw convex_error({
				message: "Staged R2 object is missing identity metadata",
				cause: { key: args.sourceKey },
			});
		}
		if (
			sourceMetadata.size !== args.expectedSource.size ||
			args.expectedSource.etag === undefined ||
			normalizeEtag(sourceMetadata.etag) !== normalizeEtag(args.expectedSource.etag)
		) {
			await source.body?.cancel();
			return { outcome: "stale_source" as const };
		}
	}
	if (!source.body) {
		throw convex_error({
			message: "R2 source object has no body",
			cause: { key: args.sourceKey },
		});
	}

	const upload = await r2_generate_upload_url(args.destinationKey);
	const response = await fetch(upload.url, {
		method: "PUT",
		headers: {
			"If-None-Match": "*",
			...(source.headers.get("Content-Type") ? { "Content-Type": source.headers.get("Content-Type") as string } : {}),
		},
		body: source.body,
	});
	// Another event may copy the final object first. R2 returns 412 in this case. Read that object
	// below.
	if (!response.ok && response.status !== 412) {
		throw convex_error({
			message: "Failed to copy staged R2 object",
			cause: {
				status: response.status,
				sourceKey: args.sourceKey,
				destinationKey: args.destinationKey,
			},
		});
	}

	if (response.status === 412) {
		// Trust the final object's metadata because this attempt's temporary object may be different.
		const winner = await fetch(destinationUrl);
		if (!winner.ok) {
			throw convex_error({
				message: "Failed to read immutable R2 object after conditional copy",
				cause: {
					status: winner.status,
					key: args.destinationKey,
				},
			});
		}
		return await getDestinationMetadata(winner);
	}

	const size = sourceMetadata.size ?? args.expectedSource?.size;
	if (size === undefined) {
		throw convex_error({
			message: "Staged R2 object is missing Content-Length",
			cause: { key: args.sourceKey },
		});
	}
	await r2.syncMetadata(ctx, args.destinationKey);
	return {
		outcome: "ready" as const,
		size,
		etag: sourceMetadata.etag ?? args.expectedSource?.etag,
	};
}

export async function r2_delete_object(ctx: MutationCtx, key: string) {
	await r2.deleteObject(ctx, key);
}

/**
 * Publish a picture the chat agent drew: give the asset its final key and drop its cleanup deadline.
 *
 * A generated image is only reachable from inside a stored chat message, and no index can find it
 * there. So `cleanup_expired_unfinalized_assets` would delete it like any other unfinished asset.
 * The deadline is cleared here instead, when the message that shows the image is stored. An image
 * whose message never arrives keeps the deadline and is deleted a day later.
 *
 * `assetId` travels inside a message body that the client writes, so nothing is trusted: a string
 * that is not an id, an asset from another workspace, and an asset that is not a generated image
 * are all ignored.
 */
export async function r2_db_finalize_generated_image_asset(
	ctx: MutationCtx,
	args: {
		organizationId: string;
		workspaceId: string;
		assetId: string;
	},
) {
	const assetId = ctx.db.normalizeId("files_r2_assets", args.assetId);
	if (!assetId) {
		return;
	}

	const asset = await ctx.db.get("files_r2_assets", assetId);
	if (
		!asset ||
		asset.kind !== "generated_image" ||
		asset.organizationId !== args.organizationId ||
		asset.workspaceId !== args.workspaceId
	) {
		return;
	}

	await ctx.db.patch("files_r2_assets", assetId, {
		r2Key: r2_create_asset_key({
			organizationId: asset.organizationId,
			workspaceId: asset.workspaceId,
			assetId,
		}),
		unfinalizedExpiresAt: undefined,
		updatedAt: Date.now(),
	});
}

// #region R2 deletion jobs

// Keep one cleanup job for each R2 key that must be deleted. The R2 component retries only a fixed
// number of times and does not report whether its last try worked. Keep the job until R2 confirms
// the object is gone.

/**
 * Wait five extra minutes after an upload URL expires. An upload may start just before the URL
 * expires. This gives it time to reach R2 before the final delete.
 */
export const r2_PUT_MAY_ARRIVE_MARGIN_MS = 5 * 60 * 1000;

/** Wait 30 seconds after the first failed delete. Later failures wait longer. */
const DELETION_RETRY_INITIAL_MS = 30 * 1000;

/** Never wait more than one hour before the next delete attempt. */
const DELETION_RETRY_MAX_MS = 60 * 60 * 1000;

/** Read at most 50 due jobs at a time. */
const DELETION_DUE_PAGE_SIZE = 50;

/**
 * Move a due job one hour forward before scheduling it. This stops the same hourly run from
 * scheduling it twice. A later run retries it if the delete crashes.
 */
const DELETION_ATTEMPT_LEASE_MS = 60 * 60 * 1000;

// Keep this object so tests can replace the delete function. A successful call means the object is
// gone from R2. Keep the R2 login secrets in this module. Never save or log them.
export const r2_confirmed_object_delete = {
	delete_object: async (ctx: ActionCtx, key: string) => {
		await ctx.runAction(components.r2.lib.deleteR2Object, {
			key,
			bucket: R2_BUCKET_FILES,
			endpoint: R2_ENDPOINT,
			accessKeyId: R2_ACCESS_KEY_ID,
			secretAccessKey: R2_SECRET_ACCESS_KEY,
		});
	},
};

/**
 * Create or update one R2 deletion job. Do this before deleting the asset or stage docs. If a crash
 * happens later, the exact R2 key still has a cleanup job.
 *
 * Increase `generation` when new bytes may have reached the key. A delete started for an older
 * generation cannot remove the newer job. Repeating the same R2 event makes no change.
 * `mode: "ensure"` creates a missing job but does not change an existing job.
 */
export async function r2_enqueue_object_deletion_job(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		r2Key: string;
		reason: Doc<"files_r2_object_deletion_jobs">["reason"];
		/**
		 * Set this when cleanup keeps the asset doc. The final delete clears the asset's
		 * `unfinalizedExpiresAt`.
		 */
		assetId?: Id<"files_r2_assets">;
		/**
		 * The last time another upload may reach this key. Before this time, keep the job after a
		 * successful delete and delete again later. Leave it empty when no later upload can arrive.
		 */
		putMayArriveUntil?: number;
		r2EventId?: string;
		mode?: "advance" | "ensure";
	},
) {
	const now = Date.now();
	const existing = await ctx.db
		.query("files_r2_object_deletion_jobs")
		.withIndex("by_r2_key", (q) => q.eq("r2Key", args.r2Key))
		.first();

	if (!existing) {
		const jobId = await ctx.db.insert("files_r2_object_deletion_jobs", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			r2Key: args.r2Key,
			reason: args.reason,
			assetId: args.assetId,
			generation: 1,
			lastR2EventId: args.r2EventId,
			putMayArriveUntil: args.putMayArriveUntil,
			attempts: 0,
			nextAttemptAt: now,
		});
		await ctx.scheduler.runAfter(0, internal.r2_client.process_object_deletion_job, { jobId, generation: 1 });
		return;
	}

	if (args.mode === "ensure") {
		return;
	}

	// Ignore the same R2 event when it arrives more than once.
	if (args.r2EventId !== undefined && existing.lastR2EventId === args.r2EventId) {
		return;
	}

	const generation = existing.generation + 1;
	await ctx.db.patch("files_r2_object_deletion_jobs", existing._id, {
		generation,
		...(args.r2EventId === undefined ? {} : { lastR2EventId: args.r2EventId }),
		// A new upload may make the safe final-delete time later. Never move it earlier.
		...(args.putMayArriveUntil === undefined
			? {}
			: { putMayArriveUntil: Math.max(existing.putMayArriveUntil ?? 0, args.putMayArriveUntil) }),
		attempts: 0,
		nextAttemptAt: now,
	});
	await ctx.scheduler.runAfter(0, internal.r2_client.process_object_deletion_job, {
		jobId: existing._id,
		generation,
	});
}

export const get_object_deletion_job = internalQuery({
	args: {
		jobId: v.id("files_r2_object_deletion_jobs"),
	},
	returns: v.union(doc(app_convex_schema, "files_r2_object_deletion_jobs"), v.null()),
	handler: async (ctx, args) => {
		return await ctx.db.get("files_r2_object_deletion_jobs", args.jobId);
	},
});

type get_object_deletion_job_Result =
	typeof get_object_deletion_job extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * Delete one R2 key. Then check `generation` again. If the job changed, keep it and delete again.
 * It is safe to repeat an R2 DELETE.
 */
export const process_object_deletion_job = internalAction({
	args: {
		jobId: v.id("files_r2_object_deletion_jobs"),
		generation: v.number(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const job = (await ctx.runQuery(internal.r2_client.get_object_deletion_job, {
			jobId: args.jobId,
		})) as get_object_deletion_job_Result;

		// Stop if the job is gone or a newer version of the job exists.
		if (!job || job.generation !== args.generation) {
			return null;
		}

		let deletedAt: number;
		try {
			await r2_confirmed_object_delete.delete_object(ctx, job.r2Key);
			deletedAt = Date.now();
		} catch (error) {
			console.warn("Confirmed R2 object delete attempt failed", {
				jobId: args.jobId,
				generation: args.generation,
				attempts: job.attempts,
				error,
			});
			await ctx.runMutation(internal.r2_client.record_object_deletion_failure, {
				jobId: args.jobId,
				generation: args.generation,
			});
			return null;
		}

		await ctx.runMutation(internal.r2_client.settle_object_deletion_job, {
			jobId: args.jobId,
			generation: args.generation,
			deletedAt,
		});
		return null;
	},
});

export const settle_object_deletion_job = internalMutation({
	args: {
		jobId: v.id("files_r2_object_deletion_jobs"),
		generation: v.number(),
		/** The time when R2 confirmed the delete. */
		deletedAt: v.number(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const job = await ctx.db.get("files_r2_object_deletion_jobs", args.jobId);
		if (!job) {
			return null;
		}

		// The job changed while this delete ran. Start another delete with the new generation number.
		if (job.generation !== args.generation) {
			await ctx.scheduler.runAfter(0, internal.r2_client.process_object_deletion_job, {
				jobId: job._id,
				generation: job.generation,
			});
			return null;
		}

		// The URL can still upload the object again. Keep the job and delete again after the URL expires.
		if (job.putMayArriveUntil !== undefined && args.deletedAt < job.putMayArriveUntil) {
			await ctx.db.patch("files_r2_object_deletion_jobs", job._id, {
				nextAttemptAt: job.putMayArriveUntil,
			});
			return null;
		}

		// R2 confirmed the final delete. Remove the job and clear the asset's cleanup deadline.
		await ctx.runMutation(components.r2.lib.deleteMetadata, { bucket: R2_BUCKET_FILES, key: job.r2Key });
		await ctx.db.delete("files_r2_object_deletion_jobs", job._id);

		if (job.assetId) {
			const asset = await ctx.db.get("files_r2_assets", job.assetId);
			if (asset && asset.unfinalizedExpiresAt !== undefined) {
				await ctx.db.patch("files_r2_assets", asset._id, {
					unfinalizedExpiresAt: undefined,
					updatedAt: Date.now(),
				});
			}
		}
		return null;
	},
});

export const record_object_deletion_failure = internalMutation({
	args: {
		jobId: v.id("files_r2_object_deletion_jobs"),
		generation: v.number(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const job = await ctx.db.get("files_r2_object_deletion_jobs", args.jobId);
		if (!job || job.generation !== args.generation) {
			return null;
		}

		const attempts = job.attempts + 1;
		const delayMs = Math.min(DELETION_RETRY_MAX_MS, DELETION_RETRY_INITIAL_MS * 2 ** Math.min(attempts - 1, 8));
		await ctx.db.patch("files_r2_object_deletion_jobs", job._id, {
			attempts,
			nextAttemptAt: Date.now() + delayMs,
		});
		await ctx.scheduler.runAfter(delayMs, internal.r2_client.process_object_deletion_job, {
			jobId: job._id,
			generation: job.generation,
		});
		return null;
	},
});

/**
 * Every hour, schedule jobs whose `nextAttemptAt` has passed. Read 50 jobs at a time. Schedule
 * another page until no due jobs remain.
 */
export const schedule_due_object_deletion_jobs = internalMutation({
	args: {
		_test_now: v.optional(v.number()),
		batchSize: v.optional(v.number()),
		_test_disableReschedule: v.optional(v.boolean()),
	},
	returns: v.object({
		scheduledCount: v.number(),
		done: v.boolean(),
	}),
	handler: async (ctx, args) => {
		const now = args._test_now ?? Date.now();
		const batchSize = Math.min(Math.max(args.batchSize ?? DELETION_DUE_PAGE_SIZE, 1), DELETION_DUE_PAGE_SIZE);
		const due = await ctx.db
			.query("files_r2_object_deletion_jobs")
			.withIndex("by_next_attempt_at", (q) => q.lte("nextAttemptAt", now))
			.take(batchSize);

		// Move each job out of the due list before scheduling it. This prevents a duplicate run.
		for (const job of due) {
			await ctx.db.patch("files_r2_object_deletion_jobs", job._id, {
				nextAttemptAt: now + DELETION_ATTEMPT_LEASE_MS,
			});
			await ctx.scheduler.runAfter(0, internal.r2_client.process_object_deletion_job, {
				jobId: job._id,
				generation: job.generation,
			});
		}

		const done = due.length < batchSize;
		if (!done && !args._test_disableReschedule) {
			await ctx.scheduler.runAfter(0, internal.r2_client.schedule_due_object_deletion_jobs, {
				batchSize: args.batchSize,
				_test_now: args._test_now,
			});
		}

		return { scheduledCount: due.length, done };
	},
});

// #endregion R2 deletion jobs
