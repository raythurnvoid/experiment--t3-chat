import { describe, expect, test } from "vitest";

import worker, { type Env } from "./index.ts";

const VERSION_ID = "00000000-1111-2222-3333-444444444444";

const make_env = (): Env => ({
	CF_VERSION_METADATA: {
		id: VERSION_ID,
		tag: "test",
		timestamp: "2026-08-15T00:00:00.000Z",
	},
	COUNCIL_DB: {
		prepare: () => ({
			bind: () => ({
				run: () => Promise.resolve({}),
			}),
		}),
	},
	COUNCIL_EVENTS: {
		send: () => Promise.resolve(),
	},
	COUNCIL_PLUGIN_ORIGIN: "https://grand-finch-267.convex.site",
	CONVEX_HTTP_URL: "https://grand-finch-267.convex.site",
	COUNCIL_TRACK_FILE_PREFIX: "council",
	COUNCIL_MEETING_MAX_MINUTES: "60",
	COUNCIL_MEETING_MAX_PARTICIPANTS: "25",
	COUNCIL_SERVICE_EXCHANGE_SECRET: "test-exchange-secret",
	REALTIMEKIT_API_TOKEN: "test-api-token",
	REALTIMEKIT_ACCOUNT_ID: "test-account-id",
	REALTIMEKIT_APP_ID: "test-app-id",
	COUNCIL_ROOM_COOKIE_SECRET: "test-cookie-secret",
});

describe("routing", () => {
	test("returns the deployed version id without allowing caches", async () => {
		const response = await worker.fetch(new Request("https://council.example.com/health"), make_env());

		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(await response.json()).toEqual({
			service: "bonobo-council-service",
			status: "ok",
			versionId: VERSION_ID,
		});
	});

	test("the room page CSP carries every directive the call depends on", async () => {
		const response = await worker.fetch(new Request("https://council.example.com/room"), make_env());

		expect(response.status).toBe(200);
		const csp = response.headers.get("Content-Security-Policy") ?? "";
		expect(csp).toContain("default-src 'none'");
		expect(csp).toContain("frame-ancestors 'none'");
		expect(csp).toContain("media-src 'self' blob:");
		// The SDK bundle spawns a blob Worker for audio; without this directive the browser blocks
		// it (one violation per room, observed live 2026-08-16) and the SDK silently degrades.
		expect(csp).toContain("worker-src 'self' blob:");
	});
});
