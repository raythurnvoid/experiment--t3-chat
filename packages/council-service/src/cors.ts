/**
 * The browser-facing CORS contract for the members-only Council page.
 *
 * CORS is transport policy only. It decides what a browser lets a page read, and it decides nothing
 * about authority: a request with no `Origin` header at all — curl, another server — still reaches
 * the handler. Authentication and the CSRF token stay the gate. This module exists so a page on the
 * one plugin-asset origin can call Council at all, not so other callers are stopped.
 */

/** Only these travel on Council's browser-facing calls, so only these are answered for. */
const ALLOWED_HEADERS = "Authorization, Content-Type, X-Council-Csrf";
const ALLOWED_METHODS = "POST, OPTIONS";
/** Ten minutes. Long enough to skip repeat preflights, short enough that a config change lands. */
const PREFLIGHT_MAX_AGE_SECONDS = "600";

/**
 * Say whether a request's `Origin` is the one origin Council answers.
 *
 * The comparison is exact. `null`, a wildcard, the room's own origin, and any sibling subdomain are
 * all refused, because each of them is a different security context than the plugin page.
 */
export function council_is_allowed_origin(origin: string | null, allowedOrigin: string) {
	return origin !== null && origin !== "null" && origin === allowedOrigin;
}

/**
 * Headers that let the allowed origin read the response. An origin that is not allowed gets none,
 * so the browser refuses the read even though the handler already ran.
 */
// The return type is written out because inference gives a union of `{}` and the full object, and a
// union like that is not assignable to `HeadersInit` at the call site.
export function council_cors_headers(origin: string | null, allowedOrigin: string): Record<string, string> {
	if (!council_is_allowed_origin(origin, allowedOrigin)) {
		return {};
	}

	return {
		"Access-Control-Allow-Origin": allowedOrigin,
		// The response body differs by origin, so a shared cache must not hand one origin's answer to
		// another. Without this, a cache in front of the Worker is a cross-origin read.
		Vary: "Origin",
	};
}

/**
 * Answer a preflight, or `null` when the request is not one.
 *
 * A preflight is only a preflight when all three of its headers are present. An `OPTIONS` without
 * them is a plain request and is not answered with permission to call anything.
 */
export function council_handle_preflight(request: Request, allowedOrigin: string) {
	if (request.method !== "OPTIONS") {
		return null;
	}

	const origin = request.headers.get("Origin");
	const requestMethod = request.headers.get("Access-Control-Request-Method");
	const requestHeaders = request.headers.get("Access-Control-Request-Headers");
	if (origin === null || requestMethod === null || requestHeaders === null) {
		return new Response(null, { status: 400 });
	}

	if (!council_is_allowed_origin(origin, allowedOrigin)) {
		// Refuse by answering without the permission headers rather than by erroring, so the browser
		// reports a CORS failure and the page cannot tell a blocked origin from an unknown route.
		return new Response(null, { status: 204, headers: { Vary: "Origin" } });
	}

	return new Response(null, {
		status: 204,
		headers: {
			"Access-Control-Allow-Origin": allowedOrigin,
			"Access-Control-Allow-Methods": ALLOWED_METHODS,
			// Answer with the exact list Council accepts, not with whatever the browser asked for.
			// Reflecting the request's list would let any header through on a future route.
			"Access-Control-Allow-Headers": ALLOWED_HEADERS,
			"Access-Control-Max-Age": PREFLIGHT_MAX_AGE_SECONDS,
			Vary: "Origin",
		},
	});
}
