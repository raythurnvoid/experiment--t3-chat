import { describe, expect, test, vi } from "vitest";
import { bonobo_ui_connect } from "./frontend.js";

const HOST_ORIGIN = "https://host.test";

/**
 * Simulates a host → page postMessage. The connect listener trusts a message only when
 * `event.origin === parentOrigin && event.source === window.parent`; in this top-level test
 * window `window.parent === window`, so `source: window` passes the source pin.
 */
function post_from_host(data: unknown, origin: string = HOST_ORIGIN): void {
	window.dispatchEvent(new MessageEvent("message", { data, origin, source: window }));
}

function make_init(overrides?: Record<string, unknown>) {
	return {
		type: "bonobo:init",
		protocolVersion: 1,
		apiOrigin: "https://api.test",
		token: "plu_1",
		tokenExpiresAt: Date.now() + 600_000,
		context: {
			pluginName: "gallery",
			pageId: "main",
			pageTitle: "Gallery",
			organizationId: "org_1",
			workspaceId: "ws_1",
		},
		...overrides,
	};
}

/**
 * Records what the page posts to its parent, bypassing happy-dom's targetOrigin check. In this
 * test `window.parent === window`, so a real postMessage with targetOrigin "https://host.test"
 * would throw against the page's own origin — a real embedding parent would accept it.
 */
function spy_on_post_message() {
	return vi.spyOn(window, "postMessage").mockImplementation(() => {});
}

describe("bonobo_ui_connect", () => {
	test("handshake: posts ready to the pinned origin and resolves only on a genuine bonobo:init", async () => {
		const post_spy = spy_on_post_message();
		const client_promise = bonobo_ui_connect();
		expect(post_spy).toHaveBeenCalledWith({ type: "bonobo:ready", protocolVersion: 1 }, HOST_ORIGIN);

		// A foreign-origin init must be silently ignored...
		post_from_host(make_init({ apiOrigin: "https://evil.test", token: "plu_evil" }), "https://evil.test");
		// ...and the genuine init wins.
		post_from_host(make_init());
		const client = await client_promise;

		expect(client.apiOrigin).toBe("https://api.test");
		expect(client.context.pageTitle).toBe("Gallery");
		await expect(client.getToken()).resolves.toBe("plu_1");
	});

	test("fetchJson refreshes the token exactly once on 401 and retries with the new token", async () => {
		const post_spy = spy_on_post_message();
		const client_promise = bonobo_ui_connect();
		post_from_host(make_init());
		const client = await client_promise;

		const fetch_mock = vi
			.fn<(url: string, init: { method: string; headers: Headers; body?: string }) => Promise<Response>>()
			.mockResolvedValueOnce(new Response("expired", { status: 401 }))
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } }),
			);
		vi.stubGlobal("fetch", fetch_mock);

		const result_promise = client.fetchJson("/api/v1/files/list", { body: { limit: 100 } });
		// The 401 triggers one bonobo:token-refresh-request; answer it with a fresh token.
		await vi.waitFor(() => {
			expect(
				post_spy.mock.calls.some((call) => (call[0] as { type?: string }).type === "bonobo:token-refresh-request"),
			).toBe(true);
		});
		const refresh_call = post_spy.mock.calls.find(
			(call) => (call[0] as { type?: string }).type === "bonobo:token-refresh-request",
		);
		if (!refresh_call) {
			throw new Error("refresh request not posted");
		}
		const request_id = (refresh_call[0] as { requestId: string }).requestId;
		post_from_host({
			type: "bonobo:token",
			requestId: request_id,
			token: "plu_2",
			tokenExpiresAt: Date.now() + 600_000,
		});

		await expect(result_promise).resolves.toEqual({ ok: true });
		expect(fetch_mock).toHaveBeenCalledTimes(2);
		expect(fetch_mock.mock.calls[0][0]).toBe("https://api.test/api/v1/files/list");
		expect(fetch_mock.mock.calls[0][1].headers.get("Authorization")).toBe("Bearer plu_1");
		expect(fetch_mock.mock.calls[1][1].headers.get("Authorization")).toBe("Bearer plu_2");
		expect(fetch_mock.mock.calls[1][1].method).toBe("POST");
	});
});
