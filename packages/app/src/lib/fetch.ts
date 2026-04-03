import type { api_schemas_Main_Path, api_schemas_Main } from "./api-schemas.ts";
import type { LiteralUnion } from "type-fest";
import { AppAuthProvider } from "../components/app-auth.tsx";
import { delay, should_never_happen } from "./utils.ts";
import { Result } from "./errors-as-values-utils.ts";

const convex_http_url = import.meta.env
	? (import.meta.env.VITE_CONVEX_HTTP_URL as string)
	: (process.env.VITE_CONVEX_HTTP_URL as string);

if (!convex_http_url) {
	throw new Error("`VITE_CONVEX_HTTP_URL` env var is not set");
}

export async function app_fetch_auth_anonymous(
	args?: api_schemas_Main["/api/auth/anonymous"]["POST"]["body"] & { signal?: AbortSignal },
) {
	const url = app_fetch_main_api_url("/api/auth/anonymous");

	return await app_fetch_json<api_schemas_Main["/api/auth/anonymous"]["POST"]["response"][200]["body"]>({
		url,
		method: "POST",
		auth: false,
		body: args?.token ? { token: args.token } : {},
		signal: args?.signal,
	});
}

export async function app_fetch_auth_resolve_user(
	args: api_schemas_Main["/api/auth/resolve-user"]["POST"]["body"] & {
		token: string;
		signal?: AbortSignal;
	},
) {
	const url = app_fetch_main_api_url("/api/auth/resolve-user");

	return await app_fetch_json<api_schemas_Main["/api/auth/resolve-user"]["POST"]["response"][200]["body"]>({
		url,
		method: "POST",
		auth: false,
		headers: {
			Authorization: `Bearer ${args.token}`,
		},
		body: args.anonymousUserToken ? { anonymousUserToken: args.anonymousUserToken } : {},
		signal: args.signal,
	});
}

export async function app_fetch_main_chat(
	args: Omit<app_fetch_stream_Args, "url" | "body"> & {
		input: api_schemas_Main["/api/chat"]["POST"]["body"];
	},
) {
	const { input, ...stream_args } = args;

	const url = app_fetch_main_api_url("/api/chat");

	return await app_fetch_stream({
		...stream_args,
		url,
		body: input,
	});
}

export async function app_fetch_stream_runs(
	args: Omit<app_fetch_stream_Args, "url" | "body"> & {
		input: api_schemas_Main["/api/v1/runs/stream"]["POST"]["body"];
	},
) {
	const { input, ...stream_args } = args;
	const url = app_fetch_main_api_url("/api/v1/runs/stream");

	return await app_fetch_stream({
		...stream_args,
		url,
		body: input,
	});
}

export async function app_fetch_ai_docs_contextual_prompt(
	args: Omit<app_fetch_json_Args, "url" | "body" | "method"> & {
		input: {
			prompt: string;
			context?: any;
			previous?: any;
		};
	},
) {
	const { input, ...json_args } = args;
	const url = `${convex_http_url}/api/ai-docs-temp/contextual-prompt`;

	return await app_fetch_json<any>({
		...json_args,
		url,
		method: "POST",
		body: input,
	});
}

// #region Core
const base_url_main = convex_http_url;

export function app_fetch_main_api_url(
	path: api_schemas_Main_Path,
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

export async function app_fetch_stream(args: app_fetch_stream_Args) {
	// It's correct to default to `application/json` even in case we don't expect any response body, because in case of non-ok response it would be a json anyway.
	const { url, contentType, retries = 3, auth = true, accept = "text/plain", ...requestInit } = args;

	const resolvedContentType = contentType ?? "application/json";
	const method = requestInit.method ?? "POST";
	const keepalive = requestInit.keepalive ?? false;

	const headers = new Headers(requestInit.headers);

	if (!headers.has("Accept")) {
		headers.set("Accept", accept);
	}

	if (!headers.has("Content-Type")) {
		headers.set("Content-Type", resolvedContentType);
	}

	if (auth) {
		const token = await AppAuthProvider.getToken();

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

	// +1 to have a 1 based index because "attempt 1" sounds better
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
				signal: requestInit.signal == null ? undefined : requestInit.signal,
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
				return Result({
					_nay: {
						name: "nay_abort",
						message: "Request aborted",
						cause: error,
					},
				});
			}

			// Client connection error, it makes sense to retry
			if (attempt < maxAttempts) {
				await delay(1000); // 1-second delay
				continue;
			}

			return Result({
				_nay: {
					message: "Failed to fetch",
					cause: error,
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

export async function app_fetch_json<Response>(args: app_fetch_json_Args) {
	// It's correct to default to `application/json` even in case we don't expect any response body, because in case of non-ok response it would be a json anyway.
	const accept = "application/json";

	const { url, contentType, retries = 3, auth = true, ...requestInit } = args;
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

	if (auth) {
		const token = await AppAuthProvider.getToken();

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

	// +1 to have a 1 based index because "attempt 1" sounds better
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
		} catch (e) {
			const error = e as Error;
			// Handle errors as values
			if (error.name === "AbortError") {
				return Result({
					_nay: {
						name: "nay_abort",
						message: "Request aborted",
						cause: error,
					},
				});
			}

			// Client connection error, it makes sense to retry
			if (attempt < maxAttempts) {
				await delay(1000); // 1-second delay
				continue;
			}

			return Result({
				_nay: {
					message: "Failed to fetch",
					cause: error,
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

type app_fetch_json_Args = Omit<RequestInit, "body" | "headers" | "method" | "keepalive" | "signal"> & {
	url: string;
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

type app_fetch_stream_Args = Omit<RequestInit, "body" | "headers" | "method" | "keepalive" | "signal"> & {
	url: string;
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
	 * @default "POST"
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
