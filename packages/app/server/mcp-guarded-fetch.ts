/**
 * The one fetch guard for every MCP and OAuth request Press sends. No other code fetches an MCP
 * server or an authorization server.
 *
 * Convex sends every `fetch` through its SSRF proxy, and the proxy checks where a name resolves.
 * This guard adds the rules the proxy cannot know. Allow hostnames only, never IP addresses. The
 * guard also refuses Press's own hosts, follows no redirect on the MCP endpoint, and caps response
 * bytes, because a Convex action has only 64 MiB of memory.
 */

// OAuth metadata GETs may follow a few redirects. Each hop goes through every URL check again.
const OAUTH_MAX_REDIRECTS = 3;
const OAUTH_TIMEOUT_MS = 5_000;
const OAUTH_MAX_RESPONSE_BYTES = 64 * 1024;

// These headers never go to an origin other than the one they were meant for.
const CREDENTIAL_HEADER_NAMES = ["authorization", "proxy-authorization", "cookie"];

const BLOCKED_HOSTS = ["localhost", "instance-data"];
// `.internal` also covers `metadata.google.internal` and `instance-data.ec2.internal`.
const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal"];

// An MCP URL that points at Press itself has no use and only adds risk. These env values already
// exist on every deployment, so Press needs no new required env for this list.
const PRESS_HOST_ENV_NAMES = [
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
];

export type mcp_GuardedFetchFailure = "url_blocked" | "timeout" | "too_large" | "bad_response" | "network_error";

/**
 * Hosts refused by exact name or by a `*.` suffix entry. Read at call time, so an env change
 * applies at once.
 */
function denied_host_entries() {
	const hosts: string[] = [];
	for (const name of PRESS_HOST_ENV_NAMES) {
		const value = process.env[name]?.trim();
		if (!value || !URL.canParse(value)) continue;
		hosts.push(new URL(value).hostname.toLowerCase());
	}

	// Optional extra list: exact hosts and `*.` suffixes, separated by commas.
	for (const entry of process.env.MCP_DENIED_HOSTS?.split(",") ?? []) {
		const host = entry.trim().toLowerCase();
		if (host) hosts.push(host);
	}

	return hosts;
}

/**
 * Return the parsed URL when Press may send a request to it, or `null` when it must not.
 */
function allowed_url(rawUrl: string, testAllowLocalHttp: boolean) {
	if (!URL.canParse(rawUrl)) return null;
	const url = new URL(rawUrl);
	if (testAllowLocalHttp && url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)) return url;
	if (url.protocol !== "https:" || url.username || url.password) return null;

	// Compare names without the root dot, so `localhost.` is still `localhost`. A name with an empty
	// label, such as `localhost..`, would slip past the name checks below, so refuse it.
	const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
	if (!hostname || hostname.length > 253 || hostname.split(".").includes("")) return null;

	// Refuse IP literals in every form. A bracketed host is IPv6, including IPv4-mapped IPv6. The URL
	// parser turns decimal, octal, hex, and short IPv4 into dotted form. A host whose last label is a
	// number is still an IPv4 address to the parser, so refuse that shape too, parsed or not.
	if (hostname.startsWith("[")) return null;
	if (/^(?:\d+|0x[0-9a-f]*)$/iu.test(hostname.split(".").at(-1) ?? "")) return null;

	if (BLOCKED_HOSTS.includes(hostname) || BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
		return null;
	}

	for (const entry of denied_host_entries()) {
		if (entry.startsWith("*.") ? hostname.endsWith(entry.slice(1)) : hostname === entry) return null;
	}

	return url;
}

/**
 * Create a fetch function for the MCP SDK.
 *
 * - `mcp`: requests to one MCP server. The server's headers and its Bearer token go only to the
 *   server's own origin. Redirects are refused, and the JSON-RPC answer rules apply.
 * - `oauth`: discovery, registration, and token requests. They send no server headers. Only a GET
 *   may follow redirects, at most 3, and each request has 5 seconds and 64 KiB.
 *
 * The SDK expects a fetch that throws on failure, so the guard throws instead of returning a Result.
 * The SDK wraps a thrown error in its own error, so the guard records why it refused in `failure`.
 * The caller reads `failure` first, `wwwAuthenticate` after a 401 or 403, and `retryAfter` after a
 * 429, because the SDK's HTTP error does not carry response headers.
 */
export function mcp_guarded_fetch_create(
	options: (
		| {
				kind: "mcp";
				server: { url: string; headers: Array<{ name: string; value: string }> };
				accessToken: string | null;
				/**
				 * Cap for one response, in decoded bytes.
				 */
				maxResponseBytes: number;
				/**
				 * Cap for all responses of this guard together, for example every page of one tool list.
				 */
				maxTotalBytes: number;
		  }
		| { kind: "oauth" }
	) & {
		/**
		 * Test only: allow `http://localhost` and `http://127.0.0.1` for the conformance harness and
		 * local fixtures. Only test code passes it. Convex functions never do.
		 */
		testAllowLocalHttp?: true;
	},
) {
	const serverOrigin = options.kind === "mcp" ? new URL(options.server.url).origin : null;
	const maxResponseBytes = options.kind === "mcp" ? options.maxResponseBytes : OAUTH_MAX_RESPONSE_BYTES;
	let remainingTotalBytes = options.kind === "mcp" ? options.maxTotalBytes : Number.POSITIVE_INFINITY;

	const guard = {
		failure: null as mcp_GuardedFetchFailure | null,
		wwwAuthenticate: null as string | null,
		retryAfter: null as string | null,
		fetch: async (input: string | URL, init?: RequestInit) => {
			const refuse = (failure: mcp_GuardedFetchFailure) => {
				guard.failure ??= failure;
				return new Error(`Guarded fetch refused the request: ${failure}`);
			};

			let url = allowed_url(String(input), options.testAllowLocalHttp === true);
			if (!url) throw refuse("url_blocked");

			const method = (init?.method ?? "GET").toUpperCase();
			const headers = new Headers(init?.headers);

			// A JSON-RPC request has a `method` and an `id`. A server must answer it with a result, never with
			// 202. A notification (no `id`) and a response to a server request (no `method`) get 202. The SDK
			// sends one message per POST.
			let sendsRequest = false;
			if (options.kind === "mcp" && typeof init?.body === "string") {
				try {
					const message: unknown = JSON.parse(init.body);
					sendsRequest = typeof message === "object" && message !== null && "method" in message && "id" in message;
				} catch {
					// Not JSON: the server decides what to do with it.
				}
			}

			// An MCP request keeps the SDK's signal, which carries the per-call timeout. The SDK's OAuth
			// helpers pass no signal, so each OAuth request gets a 5 second timer, body read included.
			let signal = init?.signal;
			let timedOut = false;
			let timer: ReturnType<typeof setTimeout> | null = null;
			if (options.kind === "oauth") {
				const controller = new AbortController();
				signal = controller.signal;
				timer = setTimeout(() => {
					timedOut = true;
					controller.abort();
				}, OAUTH_TIMEOUT_MS);
			}

			try {
				for (let hop = 0; ; hop++) {
					// Send the server's headers and token only to its own origin. The SDK may also use this fetch
					// for OAuth discovery on another origin, so drop every credential header there.
					if (options.kind === "mcp" && url.origin === serverOrigin) {
						for (const header of options.server.headers) headers.set(header.name, header.value);
						if (options.accessToken) headers.set("Authorization", `Bearer ${options.accessToken}`);
					} else if (options.kind === "mcp") {
						for (const name of CREDENTIAL_HEADER_NAMES) headers.delete(name);
						for (const header of options.server.headers) headers.delete(header.name);
					}

					let response: Response;
					try {
						response = await fetch(url, { ...init, headers, redirect: "manual", signal });
					} catch (error) {
						if (signal?.aborted) throw error;
						// The Convex runtime rethrows every backend fetch failure as a TypeError. Its SSRF proxy refusal
						// reads "Request to <url> forbidden" for http, and ends with "tunnel error: proxy authorization
						// required" for https (checked on the dev deployment, 2026-09-27). Every message also names the
						// URL, so match the whole shape: a URL that contains "forbidden" must not turn a network error
						// into `url_blocked`. This is the only place that reads message text.
						if (
							error instanceof TypeError &&
							/(?:^|: )Request to \S+ forbidden$|: tunnel error: proxy authorization required$/u.test(error.message)
						) {
							throw refuse("url_blocked");
						}
						throw refuse("network_error");
					}

					const wwwAuthenticate = response.headers.get("www-authenticate");
					if (wwwAuthenticate !== null) guard.wwwAuthenticate = wwwAuthenticate;
					const retryAfter = response.headers.get("retry-after");
					if (retryAfter !== null) guard.retryAfter = retryAfter;

					if (response.status >= 300 && response.status < 400) {
						await response.body?.cancel();
						const location = response.headers.get("location");
						// The MCP endpoint follows no redirect. OAuth follows only GET redirects, never a POST.
						if (
							options.kind === "mcp" ||
							method !== "GET" ||
							hop >= OAUTH_MAX_REDIRECTS ||
							!location ||
							!URL.canParse(location, url)
						) {
							throw refuse("bad_response");
						}

						const next = allowed_url(new URL(location, url).href, options.testAllowLocalHttp === true);
						if (!next) throw refuse("url_blocked");
						if (next.origin !== url.origin) {
							for (const name of CREDENTIAL_HEADER_NAMES) headers.delete(name);
						}
						url = next;
						continue;
					}

					const mediaType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
					// Only a 2xx answer must be JSON or SSE. A 4xx body still reaches the SDK, so the version probe
					// can read a plain-text 400. The SDK returns quietly on 202, so a request answered with 202
					// would wait for its timeout.
					if (
						options.kind === "mcp" &&
						response.ok &&
						(response.status === 202
							? sendsRequest
							: (method === "POST" || method === "GET") &&
								mediaType !== "application/json" &&
								mediaType !== "text/event-stream")
					) {
						// Close the body, so a refused answer does not keep streaming until the action ends.
						await response.body?.cancel();
						throw refuse("bad_response");
					}

					const responseInit = { status: response.status, statusText: response.statusText, headers: response.headers };
					// A 204 or 205 response cannot have a body, even an empty one.
					if (!response.body || response.status === 204 || response.status === 205) {
						return new Response(null, responseInit);
					}

					// Count the decoded bytes as they pass, so a body over a cap stops early.
					const reader = response.body.getReader();
					let size = 0;
					const body = new ReadableStream<Uint8Array>({
						pull: async (streamController) => {
							const { done, value } = await reader.read();
							if (done) {
								streamController.close();
								return;
							}

							size += value.byteLength;
							remainingTotalBytes -= value.byteLength;
							if (size > maxResponseBytes || remainingTotalBytes < 0) {
								await reader.cancel();
								streamController.error(refuse("too_large"));
								return;
							}
							streamController.enqueue(value);
						},
						cancel: async () => {
							await reader.cancel();
						},
					});

					// An SSE answer can stream for the whole call, so pass it on while it streams.
					if (options.kind === "mcp" && mediaType === "text/event-stream") {
						return new Response(body, responseInit);
					}

					// Read every other answer whole here, so a cap or the OAuth timer fails inside the guard.
					const bytes = new Uint8Array(await new Response(body).arrayBuffer());

					// Batching was removed from MCP in 2025-06-18, but the SDK still accepts a JSON array answer.
					// Skip JSON whitespace (space, tab, LF, CR). `0x5b` is `[`.
					if (options.kind === "mcp" && response.ok && mediaType === "application/json") {
						const firstByte = bytes.find((byte) => byte !== 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d);
						if (firstByte === 0x5b) throw refuse("bad_response");
					}

					return new Response(bytes, responseInit);
				}
			} catch (error) {
				// The timer can fire during the fetch or during the body read.
				if (timedOut) throw refuse("timeout");
				throw error;
			} finally {
				if (timer !== null) clearTimeout(timer);
			}
		},
	};

	return guard;
}
