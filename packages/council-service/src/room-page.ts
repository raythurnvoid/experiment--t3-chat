/**
 * `GET /room` — the public meeting room page, on this Worker's own separate origin.
 */

import type { Env } from "./env.ts";
import { council_NO_STORE_HEADERS } from "./http.ts";
import { council_room_page_external_origins, council_room_page_html } from "./room/page.ts";

export function council_handle_room_page(_request: Request, _env: Env): Response {
	// The page loads the provider SDK, so those origins are allowed exactly and nothing else is.
	// `frame-ancestors 'none'` keeps the room out of every iframe, the app's included; the ticket
	// flow depends on the room being a top-level document.
	const external = council_room_page_external_origins.join(" ");
	const csp = [
		"default-src 'none'",
		`script-src 'self' 'unsafe-inline' ${external}`.trimEnd(),
		`connect-src 'self' ${external}`.trimEnd(),
		"style-src 'self' 'unsafe-inline'",
		"img-src 'self' data: blob:",
		"media-src 'self' blob:",
		// The SDK bundle spawns a blob Worker for audio processing. Without this directive the
		// browser falls back to script-src, blocks the blob, and the SDK silently degrades —
		// observed live as one violation per room browser on 2026-08-16.
		"worker-src 'self' blob:",
		"font-src 'self'",
		"frame-ancestors 'none'",
		"base-uri 'none'",
		"form-action 'none'",
	].join("; ");

	return new Response(council_room_page_html(), {
		status: 200,
		headers: {
			...council_NO_STORE_HEADERS,
			"Content-Type": "text/html; charset=utf-8",
			"Content-Security-Policy": csp,
			"X-Content-Type-Options": "nosniff",
		},
	});
}
