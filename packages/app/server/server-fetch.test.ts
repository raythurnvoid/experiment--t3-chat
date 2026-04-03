import "../convex/setup.test.ts";
import { afterEach, describe, expect, test, vi } from "vitest";
import { server_fetch_json } from "./server-fetch.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("server_fetch_json", () => {
	test("returns the parsed JSON payload for a 200 response", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ ok: true, value: 42 }), {
				status: 200,
				headers: {
					"Content-Type": "application/json",
				},
			}),
		);

		const result = await server_fetch_json<{ ok: boolean; value: number }>({
			url: "https://example.com/json",
		});

		expect(result._nay).toBeUndefined();
		expect(result._yay?.payload).toEqual({ ok: true, value: 42 });
		expect(fetchSpy).toHaveBeenCalledOnce();
	});

	test("merges RequestInit fields after defaults and cannot override headers, method, body, or keepalive", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		const signal = AbortSignal.timeout(60_000);

		await server_fetch_json({
			url: "https://example.com/init-merge",
			method: "POST",
			body: { x: 1 },
			signal,
			cache: "no-store",
			priority: "high",
		});

		expect(fetchSpy).toHaveBeenCalledOnce();
		const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(init.cache).toBe("no-store");
		expect(init.priority).toBe("high");
		expect(init.method).toBe("POST");
		expect(init.body).toBe(JSON.stringify({ x: 1 }));
		expect(init.signal).toBe(signal);
		expect(init.headers).toBeInstanceOf(Headers);
	});

	test("returns a null payload for a 204 response", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(null, {
				status: 204,
			}),
		);

		const result = await server_fetch_json<null>({
			url: "https://example.com/no-content",
		});

		expect(result._nay).toBeUndefined();
		expect(result._yay?.payload).toBeNull();
	});

	test("returns a null payload for 200 when Content-Length is 0", async () => {
		const response = new Response(null, {
			status: 200,
			headers: { "content-length": "0" },
		});
		const textSpy = vi.spyOn(response, "text");

		vi.spyOn(globalThis, "fetch").mockResolvedValue(response);

		const result = await server_fetch_json<null>({
			url: "https://example.com/zero-length",
		});

		expect(result._nay).toBeUndefined();
		expect(result._yay?.payload).toBeNull();
		expect(textSpy).not.toHaveBeenCalled();
	});

	test("returns a stable API error with the raw Response as data for non-ok responses", async () => {
		const errorResponse = new Response(JSON.stringify({ errors: ["bad request"] }), {
			status: 400,
			statusText: "Bad Request",
			headers: {
				"Content-Type": "application/json",
			},
		});

		vi.spyOn(globalThis, "fetch").mockResolvedValue(errorResponse);

		const result = await server_fetch_json({
			url: "https://example.com/non-ok",
		});

		expect(result._yay).toBeUndefined();
		expect(result._nay?.message).toBe("The API responded with an error");
		expect(result._nay?.data).toBe(errorResponse);
		expect(result._nay?.data.status).toBe(400);
	});

	test("returns a parse error for successful invalid JSON", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("not-json", {
				status: 200,
				headers: {
					"Content-Type": "application/json",
				},
			}),
		);

		const result = await server_fetch_json({
			url: "https://example.com/invalid-json",
		});

		expect(result._yay).toBeUndefined();
		expect(result._nay?.message).toBe("Failed to parse response as JSON");
		expect(result._nay?.cause).toBeInstanceOf(Error);
	});

	test("returns nay_abort without retrying when fetch aborts", async () => {
		const abortError = new DOMException("Aborted", "AbortError");
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(abortError);

		const result = await server_fetch_json({
			url: "https://example.com/abort",
			retries: 2,
		});

		expect(result._yay).toBeUndefined();
		expect(result._nay?.name).toBe("nay_abort");
		expect(result._nay?.message).toBe("Request aborted");
		expect(fetchSpy).toHaveBeenCalledOnce();
	});

	test("retries network failures and then returns a stable fetch error", async () => {
		vi.useFakeTimers();

		const networkError = new TypeError("network down");
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(networkError);

		const resultPromise = server_fetch_json({
			url: "https://example.com/network-error",
			retries: 2,
		});

		await vi.advanceTimersByTimeAsync(2_000);

		const result = await resultPromise;

		expect(result._yay).toBeUndefined();
		expect(result._nay?.message).toBe("Failed to fetch");
		expect(result._nay?.cause).toBe(networkError);
		expect(fetchSpy).toHaveBeenCalledTimes(3);
	});
});
