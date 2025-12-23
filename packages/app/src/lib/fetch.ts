import type { api_schemas_MainPaths, api_schemas_Main } from "./api-schemas.ts";
import type { LiteralUnion } from "type-fest";
import { auth_get_token } from "./auth.ts";
import { delay, should_never_happen } from "./utils.ts";
import { Result } from "./errors-as-values-utils.ts";

const convex_http_url = import.meta.env
	? (import.meta.env.VITE_CONVEX_HTTP_URL as string)
	: (process.env.VITE_CONVEX_HTTP_URL as string);

if (!convex_http_url) {
	throw new Error("`VITE_CONVEX_HTTP_URL` env var is not set");
}

export async function app_fetch_main_chat(
	args: app_fetch_StreamArgs & {
		input: api_schemas_Main["/api/chat"]["get"]["body"];
	},
) {
	const url = app_fetch_main_api_url("/api/chat");

	return await app_fetch_stream({
		...args,
		url,
		body: args.input,
	});
}

export async function app_fetch_stream_runs(
	args: app_fetch_StreamArgs & {
		input: api_schemas_Main["/api/v1/runs/stream"]["post"]["body"];
	},
) {
	const url = app_fetch_main_api_url("/api/v1/runs/stream");

	return await app_fetch_stream({
		...args,
		url,
		body: args.input,
	});
}

export async function app_fetch_ai_docs_contextual_prompt(
	args: app_fetch_JsonArgs & {
		input: {
			prompt: string;
			context?: any;
			previous?: any;
		};
	},
) {
	const url = `${convex_http_url}/api/ai-docs-temp/contextual-prompt`;

	return await app_fetch_json<any>({
		...args,
		url,
		method: "POST",
		body: args.input,
	});
}

// #region Core
const base_url_main = convex_http_url;

export function app_fetch_main_api_url(
	path: api_schemas_MainPaths,
	args?: {
		search_params?: Record<string, string | number | boolean | string[] | number[] | boolean[]>;
		path_params?: Record<string, string>;
	},
) {
	const url = new URL(`${base_url_main}${path}`);

	if (args?.path_params) {
		for (const [key, value] of Object.entries(args.path_params)) {
			url.pathname = url.pathname.replace(`{${key}}`, value);
		}
	}

	if (args?.search_params) {
		for (const [key, value] of Object.entries(args.search_params)) {
			if (Array.isArray(value)) {
				if (url.searchParams.has(key)) {
					url.searchParams.delete(key);
				}

				for (const item of value) {
					url.searchParams.append(key, item.toString());
				}
			} else {
				url.searchParams.set(key, value.toString());
			}
		}
	}

	return url.toString();
}

export async function app_fetch_stream(args: { url: string } & app_fetch_StreamArgs) {
	const auth = args.auth ?? true;
	// It's correct to default to `application/json` even in case we don't expect any response body, because in case of non-ok response it would be a json anyway.
	const accept = args.accept ?? "text/plain";
	const content_type = args.content_type ?? "application/json";
	const method = args.method ?? "POST";
	const keepalive = args.keepalive ?? false;

	const headers = new Headers(args.headers);

	if (!headers.has("Accept")) {
		headers.set("Accept", accept);
	}

	if (!headers.has("Content-Type")) {
		headers.set("Content-Type", content_type);
	}

	if (auth) {
		const token = await auth_get_token();

		if (token) {
			headers.set("Authorization", `Bearer ${token}`);
		} else {
			return Result({
				_nay: {
					message: "No token",
				},
			});
		}
	}

	const body = typeof args.body === "string" ? args.body : JSON.stringify(args.body);

	let result;

	// +1 to have a 1 based index because "attempt 1" sounds better
	const maxAttempts = Math.max(0, args.retries ?? 3) + 1;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			const response = await fetch(args.url, {
				...(args as RequestInit),
				headers,
				method,
				body,
				keepalive,
				cache: "default",
				credentials: "omit",
				priority: "auto",
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

			const reader = response.clone().body?.getReader();

			if (!reader) {
				return Result({
					_nay: {
						message: "Response body is not a stream",
					},
				});
			}

			const stream_iterator_factory = new StreamIteratorFactory({
				response,
				first_reader: reader,
				signal: args.signal,
			});

			return Result({
				_yay: {
					response,
					payload: stream_iterator_factory,
				},
			});
		} catch (e) {
			const error = e as Error;
			// Handle errors as values
			if (error.name === "AbortError") {
				result = Result({
					_nay: {
						message: "Request aborted",
						cause: error,
					},
				});
				break;
			} else {
				// Client connection error, it makes sense to retry

				result = Result({
					_nay: {
						message: "Failed to fetch",
						cause: error,
					},
				});

				// Only retry on "Failed to fetch" errors if we have more attempts left
				if (attempt < maxAttempts) {
					await delay(1000); // 1-second delay
					continue;
				}
			}
		}
	}

	if (!result) {
		should_never_happen("`result` is always valorized");
		return Result({
			_nay: {
				message: "Failed to fetch",
			},
		});
	}

	return result;
}

export async function app_fetch_json<Response>(args: { url: string } & app_fetch_JsonArgs) {
	const auth = args.auth ?? true;
	// It's correct to default to `application/json` even in case we don't expect any response body, because in case of non-ok response it would be a json anyway.
	const accept = "application/json";
	const content_type = args.content_type ?? "application/json";
	const method = args.method ?? "GET";
	const keepalive = args.keepalive ?? false;

	const headers = new Headers(args.headers);

	if (!headers.has("Accept")) {
		headers.set("Accept", accept);
	}

	if (!headers.has("Content-Type")) {
		headers.set("Content-Type", content_type);
	}

	if (auth) {
		const token = await auth_get_token();

		if (token) {
			headers.set("Authorization", `Bearer ${token}`);
		} else {
			return Result({
				_nay: {
					message: "No token",
				},
			});
		}
	}

	const body = typeof args.body === "string" ? args.body : JSON.stringify(args.body);

	let result;

	// +1 to have a 1 based index because "attempt 1" sounds better
	const maxAttempts = Math.max(0, args.retries ?? 3) + 1;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			const response = await fetch(args.url, {
				...(args as RequestInit),
				headers,
				method,
				body,
				keepalive,
				cache: "default",
				credentials: "omit",
				priority: "auto",
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

			const reader = response.clone().body?.getReader();

			if (!reader) {
				return Result({
					_nay: {
						message: "Response body is not a stream",
					},
				});
			}

			let response_json;
			try {
				response_json = await response.json();
			} catch (e) {
				const error = e as Error;
				return Result({
					_nay: {
						message: "Failed to parse response as JSON",
						cause: error,
					},
				});
			}

			return Result({
				_yay: {
					response,
					payload: response_json as Response,
				},
			});
		} catch (e) {
			const error = e as Error;
			// Handle errors as values
			if (error.name === "AbortError") {
				result = Result({
					_nay: {
						name: "nay_abort",
						message: "Request aborted",
						cause: error,
					},
				});
				break;
			} else {
				// Client connection error, it makes sense to retry

				result = Result({
					_nay: {
						message: "Failed to fetch",
						cause: error,
					},
				});

				// Only retry on "Failed to fetch" errors if we have more attempts left
				if (attempt < maxAttempts) {
					await delay(1000); // 1-second delay
					continue;
				}
			}
		}
	}

	if (!result) {
		should_never_happen("`result` is always valorized");
		return Result({
			_nay: {
				message: "Failed to fetch",
			},
		});
	}

	return result;
}

type app_fetch_JsonArgs = {
	/**
	 * The HTTP method to use.
	 *
	 * @default "GET"
	 */
	method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
	headers?: Record<string, string>;
	/**
	 * The body of the request.
	 */
	body?: Record<string, unknown> | string;
	/**
	 * Whether to add the authentication token to the request headers.
	 *
	 * @default true
	 */
	auth?: boolean;
	/**
	 * The MIME type of the request body.
	 *
	 * @default "application/json"
	 */
	content_type?: LiteralUnion<"text/plain" | "application/json", string>;
	/**
	 * Keep the connection alive if the page is unloaded to complete the request and
	 * avoid interrupting the request.
	 *
	 * @default false
	 */
	keepalive?: boolean;
	/**
	 * The request is retried `retries` times if it fails.
	 *
	 * @default 3
	 */
	retries?: number;
	/**
	 * The abort signal to use to abort the request.
	 */
	signal?: AbortSignal | undefined;
};

type app_fetch_StreamArgs = {
	/**
	 * The HTTP method to use.
	 *
	 * @default "POST"
	 */
	method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
	headers?: Record<string, string>;
	/**
	 * The body of the request.
	 */
	body?: Record<string, unknown> | string;
	/**
	 * Whether to add the authentication token to the request headers.
	 *
	 * @default true
	 */
	auth?: boolean;

	/**
	 * The MIME type of the response body.
	 *
	 * @default "text/plain"
	 */
	accept?: LiteralUnion<"text/plain" | "application/json", string>;

	/**
	 * The MIME type of the request body.
	 *
	 * @default "application/json"
	 */
	content_type?: LiteralUnion<"text/plain" | "application/json", string>;
	/**
	 * Keep the connection alive if the page is unloaded to complete the request and
	 * avoid interrupting the request.
	 *
	 * @default false
	 */
	keepalive?: boolean;
	/**
	 * The request is retried `retries` times if it fails.
	 *
	 * @default 3
	 */
	retries?: number;
	/**
	 * The abort signal to use to abort the request.
	 */
	signal?: AbortSignal | undefined;
};

class StreamIteratorFactory {
	private response: Response;
	private first_reader: ReadableStreamDefaultReader | null = null;
	private signal: AbortSignal | undefined;

	constructor(args: {
		response: Response;
		first_reader: ReadableStreamDefaultReader;
		signal: AbortSignal | undefined;
	}) {
		this.response = args.response;
		this.first_reader = args.first_reader;
		this.signal = args.signal;
	}

	get stream() {
		const generator = async function* (this: StreamIteratorFactory) {
			if (!this.response.body) {
				should_never_happen("`response.body` must be always valorized");
				return Result({
					_nay: {
						message: "Failed to read the response stream",
					},
				});
			}

			const reader = this.first_reader ?? this.response.body.getReader();

			// The first reader can be used only once
			if (this.first_reader) {
				this.first_reader = null;
			}

			const decoder = new TextDecoder("utf-8");
			let buffer = "";

			try {
				while (true) {
					const result = await reader.read();

					if (result.done) {
						break;
					}

					if (result.value) {
						// Decode the Uint8Array chunk to text
						const chunk = decoder.decode(result.value, { stream: true });
						buffer += chunk;

						yield Result({
							_yay: {
								chunk,
							},
						});
					}
				}
			} catch (e) {
				const error = e as Error;
				if (error.name === "AbortError") {
					if (this.signal?.aborted) {
						yield Result({
							_nay: this.signal.reason as Error,
						});
						return;
					} else {
						yield Result({
							_nay: {
								name: "nay_abort",
								message: error.message,
								cause: error,
							},
						});
						return;
					}
				}

				yield Result({
					_nay: {
						message: error.message,
						cause: error,
					},
				});
				return;
			} finally {
				reader.releaseLock();
			}
		};

		return generator.bind(this);
	}
}
// #endregion Core
