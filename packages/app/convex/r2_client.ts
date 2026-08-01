// R2 client and object helpers.
//
// Lives outside `r2.ts` because that module also imports `plugins_runtime.ts`, `organizations.ts`,
// and `files_nodes.ts` for its upload pipeline routes. Modules that only need to sign, read, write,
// or delete an R2 object (file-tree mutations, pending updates, snapshots) import this lean module
// so a cold Convex call does not pay the whole upload-pipeline module evaluation.

import { R2 } from "@convex-dev/r2";
import { components } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import type { ActionCtx, MutationCtx } from "./_generated/server.js";
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

export async function r2_delete_object(ctx: MutationCtx, key: string) {
	await r2.deleteObject(ctx, key);
}
