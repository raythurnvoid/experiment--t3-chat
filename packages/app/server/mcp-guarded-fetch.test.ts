import { afterEach, describe, expect, test, vi } from "vitest";
import { mcp_guarded_fetch_create } from "./mcp-guarded-fetch.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

function create_mcp_guard(
	caps: { maxResponseBytes: number; maxTotalBytes: number; deadline?: number; signal?: AbortSignal } = {
		maxResponseBytes: 1024,
		maxTotalBytes: 4096,
	},
) {
	return mcp_guarded_fetch_create({
		kind: "mcp",
		server: { url: "https://mcp.example.com/mcp", headers: [{ name: "X-Api-Key", value: "server-secret" }] },
		accessToken: "access-token",
		...caps,
	});
}

function json_response(body: string) {
	return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
}

function redirect_response(location: string) {
	return new Response(null, { status: 302, headers: { Location: location } });
}

describe("mcp_guarded_fetch_create", () => {
	test.each([
		"https://127.0.0.1/",
		"https://2130706433/",
		"https://0177.0.0.1/",
		"https://0x7f.0.0.1/",
		"https://0x7f000001/",
		"https://127.1/",
		"https://8.8.8.8./",
		"https://[::1]/",
		"https://[::ffff:127.0.0.1]/",
		"https://[::ffff:7f00:1]/",
	])("refuses the IP literal %s before any fetch", async (url) => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => json_response("{}"));
		const guard = create_mcp_guard();

		await expect(guard.fetch(url)).rejects.toThrow("Guarded fetch refused the request: url_blocked");
		expect(guard.failure).toBe("url_blocked");
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	test.each([
		"http://example.com/",
		"https://example.com:8443/",
		"https://user:password@example.com/",
		"https://localhost/",
		"https://localhost./",
		"https://app.localhost/",
		"https://printer.local/",
		"https://metadata.google.internal/",
		"https://instance-data/",
		"https://instance-data.ec2.internal/",
		"https://localhost../",
		"https://8.8.8.8../",
		`https://${"a.".repeat(130)}com/`,
	])("refuses the URL %s before any fetch", async (url) => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => json_response("{}"));
		const guard = mcp_guarded_fetch_create({ kind: "oauth" });

		await expect(guard.fetch(url)).rejects.toThrow("url_blocked");
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	test.each([
		"CONVEX_CLOUD_URL",
		"CONVEX_SITE_URL",
		"APP_BASE_URL",
		"CLERK_FRONTEND_API_URL",
		"CODE_EXECUTION_RUNNER_URL",
		"BROWSER_RUNNER_URL",
		"PLUGIN_RUNNER_URL",
		"CLOUDFLARE_MEDIA_TRANSFORMER_URL",
		"MODAL_FILE_CONVERTER_URL",
		"MODAL_MEDIA_AUDIO_URL",
	])("refuses the Press host from %s", async (name) => {
		vi.stubEnv(name, "https://Press-Host.example.com/some/path");
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => json_response("{}"));
		const guard = mcp_guarded_fetch_create({ kind: "oauth" });

		await expect(guard.fetch("https://press-host.example.com/mcp")).rejects.toThrow("url_blocked");
		await expect(guard.fetch("https://other-host.example.com/mcp")).resolves.toBeInstanceOf(Response);
		expect(fetchSpy).toHaveBeenCalledOnce();
	});

	test("allows plain-HTTP localhost only with the test switch", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => json_response("{}"));
		const guard = mcp_guarded_fetch_create({ kind: "oauth", testAllowLocalHttp: true });

		await expect(guard.fetch("http://localhost:4000/mcp")).resolves.toBeInstanceOf(Response);
		await expect(guard.fetch("http://127.0.0.1:4000/mcp")).resolves.toBeInstanceOf(Response);
		await expect(guard.fetch("http://example.com/mcp")).rejects.toThrow("url_blocked");
		await expect(mcp_guarded_fetch_create({ kind: "oauth" }).fetch("http://localhost:4000/mcp")).rejects.toThrow(
			"url_blocked",
		);
	});

	test("refuses the exact hosts and suffixes in MCP_DENIED_HOSTS", async () => {
		vi.stubEnv("MCP_DENIED_HOSTS", " Exact.example.com , *.corp.example.com,");
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => json_response("{}"));
		const guard = mcp_guarded_fetch_create({ kind: "oauth" });

		await expect(guard.fetch("https://exact.example.com/")).rejects.toThrow("url_blocked");
		await expect(guard.fetch("https://mcp.corp.example.com/")).rejects.toThrow("url_blocked");
		await expect(guard.fetch("https://corp.example.com/")).resolves.toBeInstanceOf(Response);
		await expect(guard.fetch("https://sub.exact.example.com/")).resolves.toBeInstanceOf(Response);
	});

	test("sends manual-redirect requests to an allowed host", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => json_response('{"ok":true}'));
		const guard = create_mcp_guard();

		const response = await guard.fetch("https://mcp.example.com/mcp", {
			method: "POST",
			body: '{"jsonrpc":"2.0","id":1}',
		});

		await expect(response.json()).resolves.toEqual({ ok: true });
		expect(fetchSpy.mock.calls[0]?.[1]?.redirect).toBe("manual");
		expect(guard.failure).toBeNull();
	});

	test("refuses a redirect on the MCP endpoint", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async () => redirect_response("https://mcp.example.com/other"));
		const guard = create_mcp_guard();

		await expect(guard.fetch("https://mcp.example.com/mcp")).rejects.toThrow("bad_response");
		expect(fetchSpy).toHaveBeenCalledOnce();
	});

	test("follows 3 redirects on an OAuth GET", async () => {
		let hop = 0;
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			hop += 1;
			return hop <= 3 ? redirect_response(`/hop-${hop}`) : json_response('{"issuer":"x"}');
		});

		const response = await mcp_guarded_fetch_create({ kind: "oauth" }).fetch("https://auth.example.com/start");

		await expect(response.json()).resolves.toEqual({ issuer: "x" });
		expect(fetchSpy).toHaveBeenCalledTimes(4);
	});

	test("refuses the 4th redirect on an OAuth GET", async () => {
		let hop = 0;
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			hop += 1;
			return redirect_response(`https://auth.example.com/hop-${hop}`);
		});

		await expect(mcp_guarded_fetch_create({ kind: "oauth" }).fetch("https://auth.example.com/start")).rejects.toThrow(
			"bad_response",
		);
		expect(fetchSpy).toHaveBeenCalledTimes(4);
		expect(String(fetchSpy.mock.calls[3]?.[0])).toBe("https://auth.example.com/hop-3");
	});

	test("checks every redirect hop again", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async () => redirect_response("https://127.0.0.1/"));
		const guard = mcp_guarded_fetch_create({ kind: "oauth" });

		await expect(guard.fetch("https://auth.example.com/.well-known/oauth-authorization-server")).rejects.toThrow(
			"url_blocked",
		);
		expect(fetchSpy).toHaveBeenCalledOnce();
	});

	test("refuses a redirect whose Location does not parse", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => redirect_response("https://["));
		const guard = mcp_guarded_fetch_create({ kind: "oauth" });

		await expect(guard.fetch("https://auth.example.com/metadata")).rejects.toThrow(
			"Guarded fetch refused the request: bad_response",
		);
		expect(guard.failure).toBe("bad_response");
	});

	test("never follows a redirect on an OAuth POST", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async () => redirect_response("https://auth.example.com/token-2"));

		await expect(
			mcp_guarded_fetch_create({ kind: "oauth" }).fetch("https://auth.example.com/token", {
				method: "POST",
				body: "grant_type=x",
			}),
		).rejects.toThrow("bad_response");
		expect(fetchSpy).toHaveBeenCalledOnce();
	});

	test("sends the server headers and token only to the server origin", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => json_response("{}"));
		const guard = create_mcp_guard();

		await guard.fetch("https://mcp.example.com/mcp", { method: "POST", body: '{"jsonrpc":"2.0","id":1}' });
		await guard.fetch("https://auth.example.com/.well-known/oauth-protected-resource", {
			headers: { Authorization: "Bearer other", Cookie: "a=b", "X-Api-Key": "caller-copy" },
		});

		const serverHeaders = new Headers(fetchSpy.mock.calls[0]?.[1]?.headers);
		expect(serverHeaders.get("authorization")).toBe("Bearer access-token");
		expect(serverHeaders.get("x-api-key")).toBe("server-secret");
		const otherHeaders = new Headers(fetchSpy.mock.calls[1]?.[1]?.headers);
		expect(otherHeaders.get("authorization")).toBeNull();
		expect(otherHeaders.get("cookie")).toBeNull();
		expect(otherHeaders.get("x-api-key")).toBeNull();
	});

	test("drops credential headers after a cross-origin OAuth redirect", async () => {
		// Copy the headers at call time, because the guard reuses one Headers object across hops.
		const sentHeaders: Headers[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
			sentHeaders.push(new Headers(init?.headers));
			return sentHeaders.length === 1 ? redirect_response("https://other.example.com/metadata") : json_response("{}");
		});

		await mcp_guarded_fetch_create({ kind: "oauth" }).fetch("https://auth.example.com/metadata", {
			headers: { Authorization: "Basic abc", Accept: "application/json" },
		});

		expect(sentHeaders[0]?.get("authorization")).toBe("Basic abc");
		expect(sentHeaders[1]?.get("authorization")).toBeNull();
		expect(sentHeaders[1]?.get("accept")).toBe("application/json");
	});

	test("refuses a response over the per-response cap", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => json_response(`"${"x".repeat(9)}"`));
		const guard = create_mcp_guard({ maxResponseBytes: 10, maxTotalBytes: 100 });

		await expect(guard.fetch("https://mcp.example.com/mcp")).rejects.toThrow("too_large");
		expect(guard.failure).toBe("too_large");
	});

	test("refuses the response that goes over the total cap", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => json_response(`"${"x".repeat(6)}"`));
		const guard = create_mcp_guard({ maxResponseBytes: 10, maxTotalBytes: 20 });

		await expect(guard.fetch("https://mcp.example.com/mcp")).resolves.toBeInstanceOf(Response);
		await expect(guard.fetch("https://mcp.example.com/mcp")).resolves.toBeInstanceOf(Response);
		await expect(guard.fetch("https://mcp.example.com/mcp")).rejects.toThrow("too_large");
	});

	test("counts SSE bytes while the stream is read", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(
			async () =>
				new Response(`data: ${"x".repeat(20)}\n\n`, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
		);
		const guard = create_mcp_guard({ maxResponseBytes: 10, maxTotalBytes: 100 });

		const response = await guard.fetch("https://mcp.example.com/mcp");
		await expect(response.text()).rejects.toThrow("too_large");
		expect(guard.failure).toBe("too_large");
	});

	test("caps an OAuth response at 64 KiB", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => json_response(`"${"x".repeat(64 * 1024)}"`));

		await expect(mcp_guarded_fetch_create({ kind: "oauth" }).fetch("https://auth.example.com/token")).rejects.toThrow(
			"too_large",
		);
	});

	test("refuses a JSON array answer", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
			json_response(' \n[{"jsonrpc":"2.0","id":1,"result":{}}]'),
		);
		const guard = create_mcp_guard();

		await expect(guard.fetch("https://mcp.example.com/mcp", { method: "POST", body: "{}" })).rejects.toThrow(
			"bad_response",
		);
	});

	test("refuses a 202 for a request and allows it for a notification", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(null, { status: 202 }));
		const guard = create_mcp_guard();

		const notification = await guard.fetch("https://mcp.example.com/mcp", {
			method: "POST",
			body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
		});
		expect(notification.status).toBe(202);
		await expect(
			guard.fetch("https://mcp.example.com/mcp", {
				method: "POST",
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
			}),
		).rejects.toThrow("bad_response");
	});

	test("allows a 202 for the answer to a server request", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(null, { status: 202 }));
		const guard = create_mcp_guard();

		const response = await guard.fetch("https://mcp.example.com/mcp", {
			method: "POST",
			body: JSON.stringify({ jsonrpc: "2.0", id: "server-1", result: {} }),
		});

		expect(response.status).toBe(202);
		expect(guard.failure).toBeNull();
	});

	test("passes a text/plain 400 to the caller", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(
			async () =>
				new Response("Bad Request: unsupported version", { status: 400, headers: { "Content-Type": "text/plain" } }),
		);
		const guard = create_mcp_guard();

		const response = await guard.fetch("https://mcp.example.com/mcp", { method: "POST", body: "{}" });

		expect(response.status).toBe(400);
		await expect(response.text()).resolves.toBe("Bad Request: unsupported version");
		expect(guard.failure).toBeNull();
	});

	test("refuses a text/plain 200 and cancels its open body", async () => {
		const cancel = vi.fn();
		vi.spyOn(globalThis, "fetch").mockImplementation(
			async () =>
				new Response(new ReadableStream({ cancel }), { status: 200, headers: { "Content-Type": "text/plain" } }),
		);
		const guard = create_mcp_guard();

		await expect(guard.fetch("https://mcp.example.com/mcp", { method: "POST", body: "{}" })).rejects.toThrow(
			"bad_response",
		);
		expect(cancel, "refused response body was cancelled").toHaveBeenCalledOnce();
	});

	test("records the last WWW-Authenticate header", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(
			async () =>
				new Response("", {
					status: 401,
					headers: { "WWW-Authenticate": 'Bearer resource_metadata="https://mcp.example.com/prm"' },
				}),
		);
		const guard = create_mcp_guard();

		const response = await guard.fetch("https://mcp.example.com/mcp", { method: "POST", body: "{}" });
		expect(response.status).toBe(401);
		expect(guard.wwwAuthenticate).toBe('Bearer resource_metadata="https://mcp.example.com/prm"');
	});

	test("clears MCP response headers when the next POST has none", async () => {
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				new Response(null, { status: 401, headers: { "WWW-Authenticate": "Bearer", "Retry-After": "8" } }),
			)
			.mockResolvedValueOnce(new Response(null, { status: 403 }));
		const guard = create_mcp_guard();
		await guard.fetch("https://mcp.example.com/mcp", { method: "POST", body: "{}" });
		expect({ auth: guard.wwwAuthenticate, retry: guard.retryAfter }).toEqual({ auth: "Bearer", retry: "8" });

		await guard.fetch("https://mcp.example.com/mcp", { method: "POST", body: "{}" });

		expect({ auth: guard.wwwAuthenticate, retry: guard.retryAfter }, "POST cleared absent response headers").toEqual({
			auth: null,
			retry: null,
		});
	});

	test.each(["GET", "DELETE"])("keeps MCP POST response headers after a background %s", async (method) => {
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				new Response(null, { status: 401, headers: { "WWW-Authenticate": "Bearer", "Retry-After": "8" } }),
			)
			.mockResolvedValueOnce(
				new Response(null, { status: 403, headers: { "WWW-Authenticate": "Basic", "Retry-After": "9" } }),
			);
		const guard = create_mcp_guard();
		await guard.fetch("https://mcp.example.com/mcp", { method: "POST", body: "{}" });
		expect({ auth: guard.wwwAuthenticate, retry: guard.retryAfter }).toEqual({ auth: "Bearer", retry: "8" });

		await guard.fetch("https://mcp.example.com/mcp", { method });

		expect(
			{ auth: guard.wwwAuthenticate, retry: guard.retryAfter },
			"background request kept the POST headers",
		).toEqual({
			auth: "Bearer",
			retry: "8",
		});
	});

	test("records MCP response headers from an initialized notification", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(null, { status: 401, headers: { "WWW-Authenticate": "Bearer", "Retry-After": "8" } }),
		);
		const guard = create_mcp_guard();

		await guard.fetch("https://mcp.example.com/mcp", {
			method: "POST",
			body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
		});

		expect({ auth: guard.wwwAuthenticate, retry: guard.retryAfter }).toEqual({ auth: "Bearer", retry: "8" });
	});

	test("keeps OAuth response headers across GETs without them", async () => {
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				new Response(null, { status: 401, headers: { "WWW-Authenticate": "Bearer", "Retry-After": "8" } }),
			)
			.mockResolvedValueOnce(new Response(null, { status: 403 }));
		const guard = mcp_guarded_fetch_create({ kind: "oauth" });
		await guard.fetch("https://auth.example.com/prm");
		expect({ auth: guard.wwwAuthenticate, retry: guard.retryAfter }).toEqual({ auth: "Bearer", retry: "8" });

		await guard.fetch("https://auth.example.com/prm");

		expect({ auth: guard.wwwAuthenticate, retry: guard.retryAfter }).toEqual({ auth: "Bearer", retry: "8" });
	});

	// Both texts are the real Convex proxy errors from the dev deployment: http first, then https.
	test.each([
		"Request to http://mcp.example.com/mcp forbidden",
		"error sending request for url (https://mcp.example.com/mcp): client error (Connect): tunnel error: proxy authorization required",
	])("maps the Convex proxy refusal %s to url_blocked", async (message) => {
		vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError(message));
		const guard = create_mcp_guard();

		await expect(guard.fetch("https://mcp.example.com/mcp")).rejects.toThrow("url_blocked");
		expect(guard.failure).toBe("url_blocked");
	});

	test.each([
		"error sending request: connection refused",
		"fetch to https://forbidden.example.com/forbidden failed: dns error",
	])("maps the fetch error %s to network_error", async (message) => {
		vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError(message));
		const guard = create_mcp_guard();

		await expect(guard.fetch("https://mcp.example.com/mcp")).rejects.toThrow("network_error");
		expect(guard.failure).toBe("network_error");
	});

	test("stops an OAuth request after 5 seconds", async () => {
		vi.useFakeTimers();
		vi.spyOn(globalThis, "fetch").mockImplementation(
			(_url, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
				}),
		);
		const guard = mcp_guarded_fetch_create({ kind: "oauth" });

		const assertion = expect(guard.fetch("https://auth.example.com/token")).rejects.toThrow("timeout");
		await vi.advanceTimersByTimeAsync(5_000);
		await assertion;
		expect(guard.failure).toBe("timeout");
	});

	test.each(["operation", "SDK"])("keeps the %s abort signal on an MCP fetch", async (abortedSignal) => {
		const operation = new AbortController();
		const sdk = new AbortController();
		const received = Promise.withResolvers<AbortSignal>();
		const released = Promise.withResolvers<void>();
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
			const signal = init?.signal!;
			received.resolve(signal);
			await released.promise;
			if (signal.aborted) throw signal.reason;
			return json_response("{}");
		});
		const guard = create_mcp_guard({ maxResponseBytes: 1024, maxTotalBytes: 4096, signal: operation.signal });
		const pending = guard.fetch("https://mcp.example.com/mcp", { signal: sdk.signal }).catch((error: unknown) => error);
		const signal = await received.promise;
		(abortedSignal === "operation" ? operation : sdk).abort();
		const aborted = signal.aborted;
		released.resolve();
		await pending;

		expect(aborted, "fetch kept both abort signals").toBe(true);
		expect(guard.failure).toBe("timeout");
	});

	test("stops an OAuth body that is still streaming after 5 seconds", async () => {
		vi.useFakeTimers();
		// Like a real fetch body, this stream fails when the request signal aborts.
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
			const body = new ReadableStream<Uint8Array>({
				start: (controller) => {
					controller.enqueue(new TextEncoder().encode('{"issuer":'));
					init?.signal?.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")));
				},
			});
			return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
		});
		const guard = mcp_guarded_fetch_create({ kind: "oauth" });

		const assertion = expect(guard.fetch("https://auth.example.com/metadata")).rejects.toThrow("timeout");
		await vi.advanceTimersByTimeAsync(5_000);
		await assertion;
		expect(guard.failure).toBe("timeout");
	});
});
