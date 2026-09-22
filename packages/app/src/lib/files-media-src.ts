// Resolve an image or video embedded in a rich text document.
//
// Documents hold saved or private `bonobo-file://` references or external URLs. Signed R2
// URLs expire after 15 minutes, so resolve them here while the embed is on screen.
//
// Never save a signed URL in the document. A document is kept forever, so the URL would be dead
// long before the document is. It would also travel into the markdown, the diff view, and every
// collaborator's copy.

import { app_convex, app_convex_api } from "./app-convex-client.ts";
import type { app_convex_FunctionReturnType, app_convex_Id } from "./app-convex-client.ts";
import { Result } from "common/errors-as-values-utils.ts";

/**
 * Matches the lifetime of `r2.create_signed_download_url`.
 */
const SIGNED_URL_LIFETIME_MS = 15 * 60 * 1000;

/**
 * Re-mint this early, so a url handed to an element never expires while it is still loading.
 */
const SIGNED_URL_REFRESH_MARGIN_MS = 60 * 1000;

/**
 * Cap the cache. One long session can open many documents, and without a cap every embed ever
 * rendered would keep its entry for as long as the tab lives.
 */
const SIGNED_URL_CACHE_MAX_ENTRIES = 200;

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
	media: NonNullable<app_convex_FunctionReturnType<typeof app_convex_api.r2.get_media_by_reference>>;
}) {
	// The query pairs each private target with its exact version. Private URLs are never cached.
	if (args.media.target.kind === "private") {
		const signed = await app_convex.action(app_convex_api.files_pending_updates.create_private_pending_download_url, {
			membershipId: args.membershipId,
			target: args.media.target,
			...args.media.privateVersion!,
		});
		return signed._nay ? signed : Result({ _yay: signed._yay.url });
	}

	const now = Date.now();
	// The same saved file can have different readers and can replace its content asset.
	const cacheKey = `${args.membershipId}:${args.media.target.id}:${args.media.asset._id}`;
	const cached = read_cached_signed_url(cacheKey, now);
	if (cached !== null) {
		return Result({ _yay: cached });
	}

	const signed = await app_convex.action(app_convex_api.r2.create_signed_download_url, {
		membershipId: args.membershipId,
		fileNodeId: args.media.target.id,
	});
	if (signed._nay) {
		return signed;
	}

	remember_signed_url(cacheKey, signed._yay.url, now);

	return Result({ _yay: signed._yay.url });
}
