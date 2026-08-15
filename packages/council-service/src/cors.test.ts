import { describe, expect, test } from "vitest";

import { council_cors_headers, council_handle_preflight, council_is_allowed_origin } from "./cors.ts";

const PLUGIN_ORIGIN = "https://grand-finch-267.convex.site";

const preflight = (origin: string | null, overrides: Record<string, string> = {}) =>
	new Request("https://council.example.com/api/meetings", {
		method: "OPTIONS",
		headers: {
			...(origin === null ? {} : { Origin: origin }),
			"Access-Control-Request-Method": "POST",
			"Access-Control-Request-Headers": "content-type",
			...overrides,
		},
	});

describe("council_is_allowed_origin", () => {
	test("accepts the one plugin-asset origin", () => {
		expect(council_is_allowed_origin(PLUGIN_ORIGIN, PLUGIN_ORIGIN)).toBe(true);
	});

	test.each([
		["a missing origin", null],
		["the literal null origin a sandboxed frame sends", "null"],
		["a sibling subdomain", "https://evil.convex.site"],
		["the same host on http", "http://grand-finch-267.convex.site"],
		["the same origin with a trailing slash", "https://grand-finch-267.convex.site/"],
	])("refuses %s", (_label, origin) => {
		expect(council_is_allowed_origin(origin, PLUGIN_ORIGIN)).toBe(false);
	});
});

describe("council_cors_headers", () => {
	test("names the exact origin and varies on it", () => {
		expect(council_cors_headers(PLUGIN_ORIGIN, PLUGIN_ORIGIN)).toEqual({
			"Access-Control-Allow-Origin": PLUGIN_ORIGIN,
			Vary: "Origin",
		});
	});

	test("never reflects an origin it was not configured with", () => {
		// Reflection is the usual CORS mistake: it turns "allow one origin" into "allow whoever asks".
		expect(council_cors_headers("https://evil.example.com", PLUGIN_ORIGIN)).toEqual({});
	});

	test("never answers with a wildcard", () => {
		const headers = council_cors_headers(PLUGIN_ORIGIN, PLUGIN_ORIGIN);
		expect(headers["Access-Control-Allow-Origin"]).not.toBe("*");
	});
});

describe("council_handle_preflight", () => {
	test("ignores a request that is not an OPTIONS", () => {
		const request = new Request("https://council.example.com/api/meetings", { method: "POST" });
		expect(council_handle_preflight(request, PLUGIN_ORIGIN)).toBeNull();
	});

	test("answers the allowed origin with the exact method and header lists", () => {
		const response = council_handle_preflight(preflight(PLUGIN_ORIGIN), PLUGIN_ORIGIN);

		expect(response?.status).toBe(204);
		expect(response?.headers.get("Access-Control-Allow-Origin")).toBe(PLUGIN_ORIGIN);
		expect(response?.headers.get("Access-Control-Allow-Methods")).toBe("POST, OPTIONS");
		expect(response?.headers.get("Access-Control-Max-Age")).toBe("600");
		expect(response?.headers.get("Vary")).toBe("Origin");
	});

	test("answers the exact header list rather than echoing what the browser asked for", () => {
		const response = council_handle_preflight(
			preflight(PLUGIN_ORIGIN, { "Access-Control-Request-Headers": "x-anything-at-all" }),
			PLUGIN_ORIGIN,
		);

		expect(response?.headers.get("Access-Control-Allow-Headers")).toBe("Authorization, Content-Type, X-Council-Csrf");
		expect(response?.headers.get("Access-Control-Allow-Headers")).not.toContain("x-anything-at-all");
	});

	test("gives a disallowed origin no permission headers at all", () => {
		const response = council_handle_preflight(preflight("https://evil.example.com"), PLUGIN_ORIGIN);

		expect(response?.status).toBe(204);
		expect(response?.headers.get("Access-Control-Allow-Origin")).toBeNull();
		expect(response?.headers.get("Access-Control-Allow-Methods")).toBeNull();
	});

	test("refuses an OPTIONS that is missing a preflight header", () => {
		const request = new Request("https://council.example.com/api/meetings", {
			method: "OPTIONS",
			headers: { Origin: PLUGIN_ORIGIN, "Access-Control-Request-Method": "POST" },
		});

		expect(council_handle_preflight(request, PLUGIN_ORIGIN)?.status).toBe(400);
	});

	test("never allows credentials, because the room cookie must not ride a cross-origin call", () => {
		const response = council_handle_preflight(preflight(PLUGIN_ORIGIN), PLUGIN_ORIGIN);
		expect(response?.headers.get("Access-Control-Allow-Credentials")).toBeNull();
	});
});
