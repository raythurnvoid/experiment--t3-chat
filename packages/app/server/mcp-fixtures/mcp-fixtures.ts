/**
 * Fake MCP servers for the MCP client tests. They run in memory, with no sockets.
 *
 * Each fixture is a web-standard `(request: Request) => Promise<Response>` handler. A test routes a
 * stubbed `fetch` to them by host: `https://<fixture>.fixtures.test/<variant>`. The good servers use
 * `@modelcontextprotocol/server`. The broken ones build raw responses, because the SDK is too correct
 * to send them.
 */
import {
	createMcpHandler,
	fromJsonSchema,
	isInitializeRequest,
	McpServer,
	WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";

export type mcp_fixtures_WireEntry = {
	fixture: string;
	variant: string;
	httpMethod: string;
	rpcMethod: string | null;
	status: number;
	sessionId: string | null;
	headers: Headers;
};

type JsonRpcBody = { jsonrpc: string; id?: string | number; method?: string; params?: Record<string, unknown> };

const validator = new CfWorkerJsonSchemaValidator();

function create_basic_server() {
	const server = new McpServer({ name: "modern-basic", version: "1.0.0" }, { jsonSchemaValidator: validator });
	server.registerTool(
		"echo",
		{
			description: "Echo text",
			inputSchema: fromJsonSchema<{ text: string }>(
				{ type: "object", properties: { text: { type: "string" } }, required: ["text"] },
				validator,
			),
			outputSchema: fromJsonSchema<{ echoed: string }>(
				{ type: "object", properties: { echoed: { type: "string" } }, required: ["echoed"] },
				validator,
			),
		},
		async ({ text }) => {
			if (text === "fail") return { content: [{ type: "text", text: "boom" }], isError: true };
			return { content: [{ type: "text", text }], structuredContent: { echoed: text } };
		},
	);
	server.registerTool(
		"picture",
		{ description: "Return a small image", inputSchema: fromJsonSchema({ type: "object", properties: {} }, validator) },
		async () => ({ content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }] }),
	);
	return server;
}

function rpc_result(id: JsonRpcBody["id"], result: Record<string, unknown>) {
	return Response.json({ jsonrpc: "2.0", id, result: { resultType: "complete", ...result } });
}

function rpc_error(args: {
	id: JsonRpcBody["id"] | null;
	code: number;
	status: number;
	data?: unknown;
}) {
	const { code, data, id, status} = args;

	return Response.json({ jsonrpc: "2.0", id, error: { code, message: `fixture error ${code}`, data } }, { status });
}

function sse_response(events: string[], options: { end: "close" | "never" }) {
	const encoder = new TextEncoder();
	let timer: ReturnType<typeof setInterval> | undefined;
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				for (const event of events) controller.enqueue(encoder.encode(event));
				if (options.end === "close") {
					controller.close();
					return;
				}
				// Keep the stream open with progress events until the client gives up.
				timer = setInterval(() => {
					controller.enqueue(
						encoder.encode(
							`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: 1, progress: 1 } })}\n\n`,
						),
					);
				}, 20);
			},
			cancel() {
				clearInterval(timer);
			},
		}),
		{ headers: { "Content-Type": "text/event-stream" } },
	);
}

function tool(name: string, extra: Record<string, unknown> = {}) {
	return { name, inputSchema: { type: "object", properties: {} }, ...extra };
}

/**
 * A stateful 2025 server that only knows `initialize`. It sets `Mcp-Session-Id`, so the client
 * sends a DELETE at the end.
 */
function create_legacy_handler(
	versions: string[],
	options: { forgetSessionOnCall: boolean; rawTools: unknown[] | null },
) {
	const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
	return async (request: Request, body: JsonRpcBody | null) => {
		const sessionId = request.headers.get("mcp-session-id");
		if (sessionId && options.forgetSessionOnCall && body?.method === "tools/call") {
			return rpc_error({ id: null, code: -32001, status: 404 });
		}
		if (sessionId && options.rawTools && body?.method === "tools/list") {
			return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: options.rawTools } });
		}
		const transport = sessionId ? sessions.get(sessionId) : undefined;
		if (transport) return await transport.handleRequest(request);
		if (sessionId) return rpc_error({ id: null, code: -32001, status: 404 });
		if (!isInitializeRequest(body)) return rpc_error({ id: null, code: -32000, status: 400 });

		const newTransport: WebStandardStreamableHTTPServerTransport = new WebStandardStreamableHTTPServerTransport({
			sessionIdGenerator: () => crypto.randomUUID(),
			enableJsonResponse: true,
			onsessioninitialized: (id) => {
				sessions.set(id, newTransport);
			},
			onsessionclosed: (id) => {
				sessions.delete(id);
			},
		});
		const server = new McpServer({ name: "legacy", version: "1.0.0" }, { supportedProtocolVersions: versions });
		server.registerTool("ping", { description: "Ping" }, async () => ({ content: [{ type: "text", text: "pong" }] }));
		await server.connect(newTransport);
		return await newTransport.handleRequest(request);
	};
}

/**
 * The `modern-basic` server on its own. The public fixture Worker in `packages/mcp-fixture-worker`
 * serves it for live QA, because Convex dev runs in the cloud and cannot reach a laptop.
 */
export function mcp_fixtures_create_basic_handler() {
	return createMcpHandler(create_basic_server, { legacy: "reject", responseMode: "json" });
}

/**
 * Create every fixture and one fetch that routes to them. Close it after the tests.
 */
export function mcp_fixtures_create() {
	const wire: mcp_fixtures_WireEntry[] = [];
	const basic = mcp_fixtures_create_basic_handler();
	const basicSse = createMcpHandler(create_basic_server, { legacy: "reject", responseMode: "sse", keepAliveMs: 0 });
	const legacy = {
		"version-legacy": create_legacy_handler(["2025-11-25"], { forgetSessionOnCall: false, rawTools: null }),
		"version-legacy-0618": create_legacy_handler(["2025-06-18"], { forgetSessionOnCall: false, rawTools: null }),
		"version-legacy-2024": create_legacy_handler(["2024-11-05"], { forgetSessionOnCall: false, rawTools: null }),
		"legacy-session-404": create_legacy_handler(["2025-11-25"], { forgetSessionOnCall: true, rawTools: null }),
		"legacy-bad-tools": create_legacy_handler(["2025-11-25"], {
			forgetSessionOnCall: false,
			rawTools: [
				tool("good"),
				{ name: "null_schema", inputSchema: null },
				tool("root_string", { inputSchema: { type: "string" } }),
			],
		}),
	};

	// Answer `tools/list` pages from a raw list. Every other method goes to the basic server, so the
	// `server/discover` probe works.
	const list_pages = (pages: Record<string, { tools: unknown[]; nextCursor?: string }>) => {
		return (body: JsonRpcBody) => {
			const cursor = typeof body.params?.cursor === "string" ? body.params.cursor : "";
			// The 2026 codec needs the cache fields on every list page.
			return rpc_result(body.id, { ttlMs: 0, cacheScope: "private", ...(pages[cursor] ?? { tools: [] }) });
		};
	};
	const many_pages = (count: number, perPage: number) => {
		const pages: Record<string, { tools: unknown[]; nextCursor?: string }> = {};
		for (let page = 0; page < count; page++) {
			pages[page === 0 ? "" : `p${page}`] = {
				tools: Array.from({ length: perPage }, (_, index) => tool(`tool_${page}_${index}`)),
				...(page + 1 < count && { nextCursor: `p${page + 1}` }),
			};
		}
		return list_pages(pages);
	};

	const deepSchema: Record<string, unknown> = { type: "object", properties: {} };
	let deepNode = deepSchema;
	for (let level = 0; level < 12; level++) {
		const child: Record<string, unknown> = { type: "object", properties: {} };
		deepNode.properties = { next: child };
		deepNode = child;
	}

	// Raw handlers keyed by fixture, then by variant (the URL path). Each one takes the JSON-RPC
	// method it overrides.
	const raw: Record<
		string,
		Record<string, { method: string; handle: (body: JsonRpcBody, request: Request) => Response | Promise<Response> }>
	> = {
		"sse-drop": {
			close: {
				method: "tools/call",
				handle: () =>
					sse_response(
						[
							`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: 1, progress: 1 } })}\n\n`,
						],
						{ end: "close" },
					),
			},
			"mid-event": {
				method: "tools/call",
				handle: (body) =>
					sse_response([`data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id }).slice(0, 12)}`], { end: "close" }),
			},
		},
		"sse-extra": {
			"": {
				method: "tools/call",
				handle: (body) =>
					sse_response(
						[
							": keep-alive comment\n\n",
							"retry: 1000\n\n",
							"event: other\ndata: not json-rpc\n\n",
							// A server request on the stream. Press declares no roots, so the SDK answers with an error.
							`id: 1\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: "server-1", method: "roots/list" })}\n\n`,
							// A response with an id the client never sent.
							`data: ${JSON.stringify({ jsonrpc: "2.0", id: 999, result: { resultType: "complete", content: [] } })}\n\n`,
							// The real answer, split over two `data:` lines.
							`id: 2\ndata: {"jsonrpc":"2.0","id":${JSON.stringify(body.id)},\ndata: "result":{"resultType":"complete","content":[{"type":"text","text":"done"}]}}\n\n`,
						],
						{ end: "close" },
					),
			},
		},
		"bad-content-type": {
			html: {
				method: "tools/call",
				handle: () => new Response("<html></html>", { headers: { "Content-Type": "text/html" } }),
			},
			array: { method: "tools/call", handle: (body) => Response.json([{ jsonrpc: "2.0", id: body.id, result: {} }]) },
			accepted: { method: "tools/call", handle: () => new Response(null, { status: 202 }) },
		},
		redirect: {
			"cross-origin": {
				method: "tools/call",
				handle: () => new Response(null, { status: 307, headers: { Location: "https://other.example/mcp" } }),
			},
			"to-ip": {
				method: "tools/call",
				handle: () => new Response(null, { status: 307, headers: { Location: "https://169.254.169.254/mcp" } }),
			},
		},
		big: {
			many: { method: "tools/list", handle: many_pages(20, 250) },
			"too-many-pages": { method: "tools/list", handle: many_pages(21, 1) },
			// 5 tools of about 40 KiB each. Each one fits the 64 KiB schema cap, but not all of them fit a turn.
			"wide-schemas": {
				method: "tools/list",
				handle: list_pages({
					"": {
						tools: Array.from({ length: 5 }, (_, index) =>
							tool(`wide_${index}`, {
								inputSchema: { type: "object", properties: {}, description: "x".repeat(40 * 1024) },
							}),
						),
					},
				}),
			},
			"empty-cursor": { method: "tools/list", handle: list_pages({ "": { tools: [tool("a")], nextCursor: "" } }) },
			loop: {
				method: "tools/list",
				handle: list_pages({
					"": { tools: [tool("a")], nextCursor: "x" },
					x: { tools: [tool("b")], nextCursor: "y" },
					y: { tools: [tool("c")], nextCursor: "x" },
				}),
			},
			"huge-result": {
				method: "tools/call",
				handle: (body) => rpc_result(body.id, { content: [{ type: "text", text: "x".repeat(2 * 1024 * 1024) }] }),
			},
			// Under the client's 1 MiB cap, but over the 64 KiB the chat keeps of one result.
			"long-text": {
				method: "tools/call",
				handle: (body) => rpc_result(body.id, { content: [{ type: "text", text: "x".repeat(100 * 1024) }] }),
			},
			// Text over the 24 KiB inline limit, so the result is stored, and about 540 KiB of small nested
			// rows. Indented JSON of the rows would pass the 2 MiB reservation.
			"deep-structured": {
				method: "tools/call",
				handle: (body) =>
					rpc_result(body.id, {
						content: [{ type: "text", text: "x".repeat(30 * 1024) }],
						structuredContent: { echoed: "rows", rows: Array.from({ length: 45_000 }, () => ({ v: [[1]] })) },
					}),
			},
			// Half of a character, then emoji past the 64 KiB cut. Convex refuses a string with half a character.
			"broken-text": {
				method: "tools/call",
				handle: (body) =>
					rpc_result(body.id, { content: [{ type: "text", text: `A\ud83dB ${"😀".repeat(20 * 1024)}` }] }),
			},
		},
		slow: {
			list: {
				method: "tools/list",
				handle: async (body) => {
					await new Promise((resolve) => setTimeout(resolve, 1000));
					return rpc_result(body.id, { tools: [] });
				},
			},
			never: { method: "tools/call", handle: () => new Promise<Response>(() => {}) },
			progress: { method: "tools/call", handle: () => sse_response([], { end: "never" }) },
		},
		"version-other": {
			"": { method: "*", handle: (body) => rpc_error({ id: body.id, code: -32022, status: 400, data: { supported: ["2027-01-01"] } }) },
		},
		"version-old-sse": {
			"": { method: "*", handle: () => new Response(null, { status: 405 }) },
		},
		"header-strict": {
			"": {
				method: "tools/list",
				handle: list_pages({
					"": {
						tools: [
							tool("with_header", {
								inputSchema: {
									type: "object",
									properties: { region: { type: "string", "x-mcp-header": "Region" } },
								},
							}),
							tool("header_on_object", {
								inputSchema: {
									type: "object",
									properties: { filter: { type: "object", "x-mcp-header": "Filter" } },
								},
							}),
							tool("header_under_items", {
								inputSchema: {
									type: "object",
									properties: { list: { type: "array", items: { type: "string", "x-mcp-header": "Item" } } },
								},
							}),
							tool("header_duplicate", {
								inputSchema: {
									type: "object",
									properties: {
										a: { type: "string", "x-mcp-header": "Same" },
										b: { type: "string", "x-mcp-header": "same" },
									},
								},
							}),
						],
					},
				}),
			},
			call: {
				method: "tools/call",
				handle: (body, request) => {
					// Refuse a call whose `Mcp-Param-Region` header does not match the argument, like a
					// SEP-2243 server.
					const args = body.params?.arguments as { region?: unknown } | undefined;
					if (request.headers.get("mcp-param-region") !== args?.region) return rpc_error({ id: body.id, code: -32020, status: 400 });
					return rpc_result(body.id, { content: [{ type: "text", text: `region ${String(args?.region)}` }] });
				},
			},
		},
		mrtr: {
			elicit: {
				method: "tools/call",
				handle: (body) =>
					Response.json({
						jsonrpc: "2.0",
						id: body.id,
						result: {
							resultType: "input_required",
							inputRequests: {
								confirm: {
									method: "elicitation/create",
									params: { mode: "form", message: "Sure?", requestedSchema: { type: "object", properties: {} } },
								},
							},
						},
					}),
			},
			"state-only": {
				method: "tools/call",
				handle: (body) =>
					Response.json({ jsonrpc: "2.0", id: body.id, result: { resultType: "input_required", requestState: "abc" } }),
			},
		},
		"result-types": {
			task: {
				method: "tools/call",
				handle: (body) => Response.json({ jsonrpc: "2.0", id: body.id, result: { resultType: "task", content: [] } }),
			},
			unknown: {
				method: "tools/call",
				handle: (body) => Response.json({ jsonrpc: "2.0", id: body.id, result: { resultType: "banana", content: [] } }),
			},
			missing: {
				method: "tools/call",
				handle: (body) => Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [] } }),
			},
			"invalid-params": { method: "tools/call", handle: (body) => rpc_error({ id: body.id, code: -32602, status: 200 }) },
			"capability-required": { method: "tools/call", handle: (body) => rpc_error({ id: body.id, code: -32021, status: 400 }) },
			"header-mismatch": { method: "tools/call", handle: (body) => rpc_error({ id: body.id, code: -32020, status: 400 }) },
			"method-error": { method: "tools/call", handle: (body) => rpc_error({ id: body.id, code: -32603, status: 200 }) },
		},
		"bad-tools": {
			invalid: {
				method: "tools/list",
				handle: list_pages({ "": { tools: [tool("good"), tool("root_string", { inputSchema: { type: "string" } })] } }),
			},
			"": {
				method: "tools/list",
				handle: list_pages({
					"": {
						tools: [
							tool("good", { title: "t".repeat(300), description: "d".repeat(50 * 1024) }),
							tool("good"),
							tool("n".repeat(200)),
							tool("network_ref", {
								inputSchema: { type: "object", properties: { a: { $ref: "https://evil.example/s.json" } } },
							}),
							tool("recursive_ref", {
								inputSchema: {
									type: "object",
									$defs: { node: { type: "object", properties: { child: { $ref: "#/$defs/node" } } } },
									properties: { root: { $ref: "#/$defs/node" } },
								},
							}),
							tool("mutual_ref", {
								inputSchema: {
									type: "object",
									$defs: {
										a: { type: "object", properties: { b: { $ref: "#/$defs/b" } } },
										b: { type: "object", properties: { a: { $ref: "#/$defs/a" } } },
									},
									properties: { root: { $ref: "#/$defs/a" } },
								},
							}),
							tool("content_ref", {
								inputSchema: {
									type: "object",
									properties: { a: { type: "string", contentSchema: { $ref: "https://evil.example/s.json" } } },
								},
							}),
							tool("dependencies_ref", {
								inputSchema: { type: "object", dependencies: { a: { $ref: "https://evil.example/s.json" } } },
							}),
							tool("local_ref", {
								inputSchema: {
									type: "object",
									$defs: { name: { type: "string" } },
									properties: { name: { $ref: "#/$defs/name" } },
								},
							}),
							tool("huge_schema", {
								inputSchema: { type: "object", properties: {}, description: "x".repeat(70 * 1024) },
							}),
							tool("deep_schema", { inputSchema: deepSchema }),
							tool("draft_04", {
								inputSchema: { $schema: "http://json-schema.org/draft-04/schema#", type: "object" },
							}),
							tool("bad_output", {
								outputSchema: { type: "object", properties: { a: { $ref: "https://x.example/" } } },
							}),
							tool("lying", { annotations: { readOnlyHint: true, destructiveHint: true } }),
						],
					},
				}),
			},
		},
		"bad-output": {
			mixed: {
				method: "tools/call",
				handle: (body) =>
					rpc_result(body.id, {
						content: [
							{ type: "audio", data: "AAAAAAAA", mimeType: "audio/wav" },
							{ type: "resource_link", uri: "file:///etc/passwd", name: "passwd" },
							{ type: "resource", resource: { uri: "file:///a.txt", text: "hello" } },
							{ type: "resource", resource: { uri: "file:///b.bin", blob: "AAAA", mimeType: "application/zip" } },
						],
					}),
			},
			"unknown-type": {
				method: "tools/call",
				handle: (body) => rpc_result(body.id, { content: [{ type: "hologram", data: "x" }] }),
			},
			"same-json": {
				method: "tools/call",
				handle: (body) =>
					rpc_result(body.id, {
						content: [{ type: "text", text: '{"echoed":"hi"}' }],
						structuredContent: { echoed: "hi" },
					}),
			},
			mismatch: {
				method: "tools/call",
				handle: (body) =>
					rpc_result(body.id, { content: [{ type: "text", text: "hi" }], structuredContent: { echoed: 1 } }),
			},
			"missing-structured": {
				method: "tools/call",
				handle: (body) => rpc_result(body.id, { content: [{ type: "text", text: "hi" }] }),
			},
			"error-structured": {
				method: "tools/call",
				handle: (body) =>
					rpc_result(body.id, {
						isError: true,
						content: [{ type: "text", text: "failed" }],
						structuredContent: { echoed: 1 },
					}),
			},
		},
	};

	const fetch = async (input: string | URL | Request, init?: RequestInit) => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		const fixture = url.hostname.split(".")[0] ?? "";
		const variant = url.pathname.slice(1);
		const text = request.method === "POST" ? await request.clone().text() : "";
		const body = text ? (JSON.parse(text) as JsonRpcBody) : null;

		const respond = async () => {
			if (fixture === "modern-basic") return await basic.fetch(request);
			if (fixture === "modern-sse") return await basicSse.fetch(request);
			if (fixture in legacy) return await legacy[fixture as keyof typeof legacy](request, body);
			if (fixture === "http-status") {
				const [status = "500", kind] = variant.split("-");
				if (kind === "rpc") return rpc_error({ id: body?.id ?? null, code: -32600, status: Number(status) });
				const headers = new Headers();
				if (status === "401") {
					headers.set(
						"WWW-Authenticate",
						'Bearer resource_metadata="https://http-status.fixtures.test/.well-known/oauth-protected-resource", scope="files:read"',
					);
				}
				if (status === "403") headers.set("WWW-Authenticate", 'Bearer error="insufficient_scope", scope="files:write"');
				if (status === "429") headers.set("Retry-After", "1");
				return new Response(null, { status: Number(status), headers });
			}

			const handler = raw[fixture]?.[variant];
			if (handler && body && (handler.method === "*" || handler.method === body.method)) {
				return await handler.handle(body, request);
			}
			// Everything else, such as the `server/discover` probe and the notifications, goes to the
			// basic server.
			return await basic.fetch(request);
		};

		// Honor the abort signal like a real fetch, so a timed-out call does not wait forever.
		const signal = init?.signal;
		const response = await (signal
			? Promise.race([
					respond(),
					new Promise<never>((_, reject) => {
						if (signal.aborted) reject(signal.reason);
						signal.addEventListener("abort", () => reject(signal.reason), { once: true });
					}),
				])
			: respond());

		wire.push({
			fixture,
			variant,
			httpMethod: request.method,
			rpcMethod: body?.method ?? null,
			status: response.status,
			sessionId: request.headers.get("mcp-session-id"),
			headers: request.headers,
		});
		return response;
	};

	return {
		wire,
		fetch,
		close: async () => {
			await basic.close();
			await basicSse.close();
		},
	};
}
