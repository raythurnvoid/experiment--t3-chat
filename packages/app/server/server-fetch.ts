import type { LiteralUnion } from "type-fest";
import { Result } from "../shared/errors-as-values-utils.ts";
import { delay } from "../shared/async-utils.ts";

type server_fetch_json_Args = Omit<RequestInit, "body" | "headers" | "method" | "keepalive" | "signal"> & {
	url: string;
	headers?: Record<string, string>;
	/**
	 * The body of the request.
	 */
	body?: Record<string, unknown> | string;
	/**
	 * The MIME type of the request body.
	 *
	 * @default "application/json"
	 */
	contentType?: LiteralUnion<"text/plain" | "application/json", string>;
	/**
	 * The request is retried `retries` times if it fails.
	 *
	 * @default 3
	 */
	retries?: number;
	/**
	 * The HTTP method to use.
	 *
	 * @default "GET"
	 */
	method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
	/**
	 * Keep the connection alive if the page is unloaded to complete the request and
	 * avoid interrupting the request.
	 *
	 * @default false
	 */
	keepalive?: boolean;
	/**
	 * The abort signal to use to abort the request.
	 */
	signal?: AbortSignal | undefined;
};

export async function server_fetch_json<Response = unknown>(args: server_fetch_json_Args) {
	const accept = "application/json";

	const { url, contentType, retries = 3, ...requestInit } = args;
	const resolvedContentType = contentType ?? "application/json";
	const method = requestInit.method ?? "GET";
	const keepalive = requestInit.keepalive ?? false;

	const headers = new Headers(requestInit.headers);

	if (!headers.has("Accept")) {
		headers.set("Accept", accept);
	}

	if (!headers.has("Content-Type")) {
		headers.set("Content-Type", resolvedContentType);
	}

	const body = ((/* iife */) => {
		const b = requestInit.body;
		if (b === undefined || b === null) {
			return undefined;
		}
		if (typeof b === "string") {
			return b;
		}
		return JSON.stringify(b);
	})();

	const maxAttempts = Math.max(0, retries) + 1;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			const response = await fetch(url, {
				cache: "default",
				credentials: "omit",
				priority: "auto",
				...(requestInit as RequestInit),
				headers,
				method,
				body,
				keepalive,
				redirect: "error",
			});

			if (!response.ok) {
				return Result({
					_nay: {
						message: "The API responded with an error",
						data: response,
					},
				});
			}

			if (response.status === 204 || response.status === 205) {
				return Result({
					_yay: {
						response,
						payload: null as unknown as Response,
					},
				});
			}

			const content_length_raw = response.headers.get("content-length");
			if (content_length_raw !== null && Number(content_length_raw) === 0) {
				return Result({
					_yay: {
						response,
						payload: null as unknown as Response,
					},
				});
			}

			let response_text;
			try {
				response_text = await response.text();
			} catch (error) {
				return Result({
					_nay: {
						message: "Failed to read response body",
						cause: error as Error,
					},
				});
			}

			if (response_text.trim() === "") {
				return Result({
					_yay: {
						response,
						payload: null as unknown as Response,
					},
				});
			}

			try {
				return Result({
					_yay: {
						response,
						payload: JSON.parse(response_text) as Response,
					},
				});
			} catch (error) {
				return Result({
					_nay: {
						message: "Failed to parse response as JSON",
						cause: error as Error,
					},
				});
			}
		} catch (error) {
			const fetch_error = error as Error;
			if (fetch_error.name === "AbortError") {
				return Result({
					_nay: {
						name: "nay_abort",
						message: "Request aborted",
						cause: fetch_error,
					},
				});
			}

			if (attempt < maxAttempts) {
				await delay(1000);
				continue;
			}

			return Result({
				_nay: {
					message: "Failed to fetch",
					cause: fetch_error,
				},
			});
		}
	}

	return Result({
		_nay: {
			message: "Failed to fetch",
		},
	});
}
