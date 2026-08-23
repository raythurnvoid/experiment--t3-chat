import { describe, expect, test, vi } from "vitest";

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
		// The only two directives that are built by interpolation, so they are the only two a producer
		// can break while every other assertion here stays green. `connect-src` is pinned in full
		// because losing the wss entry is silent and total: the page renders, the SDK loads, and the
		// browser refuses its websocket, so nobody can hear anybody.
		expect(csp).toContain(
			"connect-src 'self' https://cdn.jsdelivr.net https://api.realtime.cloudflare.com https://*.realtime.cloudflare.com wss://*.realtime.cloudflare.com",
		);
		expect(csp).toContain("script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net");
	});
});

describe("scheduled", () => {
	test("a failed pass logs the context and still fails the invocation", async () => {
		const failure = new Error("FOREIGN KEY constraint failed");
		const env = make_env();
		// Reject on the pass's very first statement. That is the shape the real failure took: one
		// statement throws and the rest of the pass never runs.
		env.COUNCIL_DB = {
			prepare: () => ({
				bind: () => ({
					run: () => Promise.reject(failure),
				}),
			}),
		} as unknown as Env["COUNCIL_DB"];

		const logged: unknown[][] = [];
		const consoleError = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			logged.push(args);
		});

		let waited: Promise<unknown> | undefined;
		await worker.scheduled({ scheduledTime: 1_755_000_000_000, cron: "*/5 * * * *" }, env, {
			waitUntil: (promise) => {
				waited = promise;
			},
		});

		// The runtime only records the invocation as failed while the promise given to `waitUntil`
		// still rejects. A `.catch` that swallowed the error would make this resolve instead.
		await expect(waited).rejects.toBe(failure);
		consoleError.mockRestore();

		// Without the log the operator sees a bare constraint error and cannot tell which pass raised
		// it. Assert the context, not only the rejection above, which survives even with no `.catch`.
		expect(logged).toHaveLength(1);
		expect(logged[0][1]).toMatchObject({
			scheduledTime: 1_755_000_000_000,
			cron: "*/5 * * * *",
			error: failure,
		});
	});
});
