// Resolve the `src` of an image or video embedded in a rich text document.
//
// A document stores a reference, never the bytes: `bonobo-file://<fileNodeId>` for a workspace
// file, or a plain external url. A signed R2 url must never be written into `src`. Those urls
// live for 15 minutes, so one saved into the document would already be dead the next time
// somebody opens the file, and it would also travel into the markdown, the diff view and every
// collaborator's copy. The reference is turned into a url here, only while something is on screen.

import { app_convex, app_convex_api } from "./app-convex-client.ts";
import type { app_convex_Id } from "./app-convex-client.ts";
import { Result } from "common/errors-as-values-utils.ts";

const FILE_REFERENCE_SCHEME = "bonobo-file://";
const EXTERNAL_URL_REGEX = /^https?:\/\//i;

/** Matches the lifetime `r2.create_signed_download_url` signs urls for. */
const SIGNED_URL_LIFETIME_MS = 15 * 60 * 1000;

/** Re-mint this early, so a url handed to an element never expires while it is still loading. */
const SIGNED_URL_REFRESH_MARGIN_MS = 60 * 1000;

/**
 * Cap the cache. One long session can open many documents, and without a cap every embed ever
 * rendered would keep its entry for as long as the tab lives.
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
 * `r2.get_asset` and `r2.create_signed_download_url` declare `v.id("files_nodes")`, and Convex
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

const signed_url_cache = new Map<string, { url: string; expiresAt: number }>();

export async function files_media_get_signed_url(args: {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	fileNodeId: app_convex_Id<"files_nodes">;
}) {
	const now = Date.now();
	const cached = signed_url_cache.get(args.fileNodeId);
	if (cached && cached.expiresAt - SIGNED_URL_REFRESH_MARGIN_MS > now) {
		return Result({ _yay: cached.url });
	}

	const signed = await app_convex.action(app_convex_api.r2.create_signed_download_url, {
		membershipId: args.membershipId,
		fileNodeId: args.fileNodeId,
	});
	if (signed._nay) {
		return signed;
	}

	// Re-insert so the map stays ordered oldest first, then drop from the front once it is full.
	signed_url_cache.delete(args.fileNodeId);
	signed_url_cache.set(args.fileNodeId, { url: signed._yay.url, expiresAt: now + SIGNED_URL_LIFETIME_MS });
	while (signed_url_cache.size > SIGNED_URL_CACHE_MAX_ENTRIES) {
		const oldest = signed_url_cache.keys().next().value;
		if (oldest === undefined) break;
		signed_url_cache.delete(oldest);
	}

	return Result({ _yay: signed._yay.url });
}
