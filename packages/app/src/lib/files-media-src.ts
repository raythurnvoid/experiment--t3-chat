// Resolve the `src` of something stored in R2: an image or video embedded in a rich text document,
// and a picture the chat agent drew.
//
// Both keep a reference, never the bytes: a document holds `bonobo-file://<fileNodeId>` for a
// workspace file or a plain external url, and a chat message holds the id of the picture's asset.
// A signed R2 url must never be written into either one, because those urls live for 15 minutes
// while a document and a message are kept forever. A url saved into a document would also travel
// into the markdown, the diff view and every collaborator's copy. The reference is turned into a
// url here, only while something is on screen.

import { app_convex, app_convex_api } from "./app-convex-client.ts";
import type { app_convex_Id } from "./app-convex-client.ts";
import { Result } from "common/errors-as-values-utils.ts";

const FILE_REFERENCE_SCHEME = "bonobo-file://";
const EXTERNAL_URL_REGEX = /^https?:\/\//i;

/** Matches the lifetime `r2.create_signed_download_url` and `r2.create_signed_chat_image_url` sign urls for. */
const SIGNED_URL_LIFETIME_MS = 15 * 60 * 1000;

/** Re-mint this early, so a url handed to an element never expires while it is still loading. */
const SIGNED_URL_REFRESH_MARGIN_MS = 60 * 1000;

/**
 * Cap the cache. One long session can open many documents and scroll through many chat threads, and
 * without a cap every embed and every picture ever rendered would keep its entry for as long as the
 * tab lives.
 */
const SIGNED_URL_CACHE_MAX_ENTRIES = 200;

export function files_media_build_file_src(fileNodeId: app_convex_Id<"files_nodes">) {
	return `${FILE_REFERENCE_SCHEME}${fileNodeId}`;
}

/**
 * Read what an embed's `src` points at.
 *
 * The file id is returned as a plain string on purpose: markdown can be hand-edited, so the id
 * is whatever the file happens to hold until Convex has normalized it.
 */
export function files_media_parse_src(src: string) {
	if (src.startsWith(FILE_REFERENCE_SCHEME)) {
		return { kind: "file" as const, fileNodeId: src.slice(FILE_REFERENCE_SCHEME.length) };
	}

	if (EXTERNAL_URL_REGEX.test(src)) {
		return { kind: "external" as const, url: src };
	}

	return { kind: "unsupported" as const };
}

/**
 * Turn a file id from markdown into an id Convex will accept.
 *
 * `r2.get_asset_by_file_node_id` and `r2.create_signed_download_url` declare `v.id("files_nodes")`, and Convex
 * rejects a string that is not an id before the handler runs. A hand-edited document can name
 * anything, so the string goes through the query that takes a plain string and answers null.
 */
export async function files_media_resolve_file_node(args: {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	fileNodeId: string;
}) {
	const fileNode = await app_convex.query(app_convex_api.files_nodes.get_file_node_for_membership, {
		membershipId: args.membershipId,
		fileNodeId: args.fileNodeId,
	});

	return fileNode;
}

// One cache for both, keyed by the id that was signed. A file node id and an asset id never collide,
// because Convex ids are unique across the whole deployment.
const signed_url_cache = new Map<string, { url: string; expiresAt: number }>();

function read_cached_signed_url(cacheKey: string, now: number) {
	const cached = signed_url_cache.get(cacheKey);
	if (cached && cached.expiresAt - SIGNED_URL_REFRESH_MARGIN_MS > now) {
		return cached.url;
	}

	return null;
}

function remember_signed_url(cacheKey: string, url: string, now: number) {
	// Re-insert so the map stays ordered oldest first, then drop from the front once it is full.
	signed_url_cache.delete(cacheKey);
	signed_url_cache.set(cacheKey, { url, expiresAt: now + SIGNED_URL_LIFETIME_MS });
	while (signed_url_cache.size > SIGNED_URL_CACHE_MAX_ENTRIES) {
		const oldest = signed_url_cache.keys().next().value;
		if (oldest === undefined) break;
		signed_url_cache.delete(oldest);
	}
}

export async function files_media_get_signed_url(args: {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	fileNodeId: app_convex_Id<"files_nodes">;
}) {
	const now = Date.now();
	const cached = read_cached_signed_url(args.fileNodeId, now);
	if (cached !== null) {
		return Result({ _yay: cached });
	}

	const signed = await app_convex.action(app_convex_api.r2.create_signed_download_url, {
		membershipId: args.membershipId,
		fileNodeId: args.fileNodeId,
	});
	if (signed._nay) {
		return signed;
	}

	remember_signed_url(args.fileNodeId, signed._yay.url, now);

	return Result({ _yay: signed._yay.url });
}

/**
 * The same thing for a picture the chat agent drew.
 *
 * `assetId` is a plain string because it comes out of a stored message part, which is opaque JSON.
 * `r2.create_signed_chat_image_url` takes a string for that reason and normalizes it itself.
 */
export async function files_media_get_signed_chat_image_url(args: {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	assetId: string;
}) {
	const now = Date.now();
	const cached = read_cached_signed_url(args.assetId, now);
	if (cached !== null) {
		return Result({ _yay: cached });
	}

	const signed = await app_convex.action(app_convex_api.r2.create_signed_chat_image_url, {
		membershipId: args.membershipId,
		assetId: args.assetId,
	});
	if (signed._nay) {
		return signed;
	}

	remember_signed_url(args.assetId, signed._yay.url, now);

	return Result({ _yay: signed._yay.url });
}
