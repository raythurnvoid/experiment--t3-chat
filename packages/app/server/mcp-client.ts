/**
 * The MCP client Press runs inside Convex actions: list one server's tools, and call one tool.
 *
 * Every request goes through the guarded fetch. Each function opens a new SDK client and closes it
 * before it returns, so no connection or session stays open between calls.
 *
 * Errors come back as a `Result` with a fixed code and a fixed message. Text from the server never
 * goes into `_nay`, and never into a log: an SDK error message carries the whole HTTP body, and a
 * server can echo back the token or the header values it received.
 */
import {
	Client,
	InsufficientScopeError,
	ProtocolError,
	SdkError,
	SdkErrorCode,
	SdkHttpError,
	StreamableHTTPClientTransport,
	extractWWWAuthenticateParams,
	specTypeSchemas,
	type CallToolResult,
	type DiscoverResult,
	type Tool,
} from "@modelcontextprotocol/client";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/client/validators/cf-worker";
import { z } from "zod";
import { Result } from "common/errors-as-values-utils.ts";
import { crypto_sha256_hex } from "./crypto-utils.ts";
import { mcp_guarded_fetch_create } from "./mcp-guarded-fetch.ts";

// The 2025 versions Press accepts on the legacy era. The SDK also accepts 2024 versions.
const LEGACY_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];

// Byte caps on decoded bytes, sized for the 64 MiB Convex action.
const LIST_PAGE_MAX_BYTES = 2 * 1024 * 1024;
const LIST_TOTAL_MAX_BYTES = 4 * 1024 * 1024;
const CALL_MAX_BYTES = 1024 * 1024;

const LIST_MAX_PAGES = 20;
// `tools/list` may retry a 429 or a 5xx inside its time budget. `tools/call` never retries,
// because a write may already have run.
const LIST_MAX_RETRIES = 2;
const LIST_RETRY_DELAY_MS = 250;

// Legacy pages only. Accept any tool entry here, and let `normalize_tools` check each one.
const tools_list_page_schema = z.object({ tools: z.array(z.unknown()), nextCursor: z.string().optional() });

const TOOL_NAME_MAX_LENGTH = 128;
const TOOL_TITLE_MAX_LENGTH = 256;
const TOOL_DESCRIPTION_MAX_LENGTH = 2048;
const TOOLS_PER_SERVER_MAX = 500;
const SCHEMA_MAX_BYTES = 64 * 1024;
const SCHEMA_MAX_DEPTH = 10;
const SCHEMA_MAX_SUBSCHEMAS = 500;
const SERVER_ERROR_MESSAGE_MAX_LENGTH = 500;

const ERROR_MESSAGES = {
	auth_required: "This MCP server needs sign-in.",
	insufficient_scope: "This MCP server needs more access.",
	forbidden: "This MCP server refused the request.",
	not_modern_mcp: "This URL is not an MCP server that Press can use.",
	unsupported_version:
		"This server uses an MCP version Press does not support. Press supports 2026-07-28, 2025-11-25, 2025-06-18, and 2025-03-26.",
	url_blocked: "Press does not allow requests to this MCP server address.",
	timeout: "The MCP server timed out. It may still have done the work.",
	too_large: "The MCP server sent more data than Press accepts.",
	bad_response: "The MCP server sent a response Press cannot read.",
	input_required_unsupported: "The MCP tool asked for more input. Press does not support that yet.",
	capability_required: "The MCP server needs a client feature Press does not support.",
	rate_limited: "The MCP server is limiting requests. Try again later.",
	server_error: "The MCP server had an error.",
	network_error: "Press could not reach the MCP server.",
	result_unknown: "The connection to the MCP server was lost. The result is unknown. Check before you retry.",
} as const;

export type mcp_client_ErrorCode = keyof typeof ERROR_MESSAGES;

type McpServer = {
	url: string;
	/**
	 * Resolved header values. The guard sends them only to the server's own origin.
	 */
	headers: Array<{ name: string; value: string }>;
};

export type mcp_client_NormalizedTool = {
	name: string;
	title: string | null;
	description: string;
	inputSchema: Record<string, unknown>;
	outputSchema: Record<string, unknown> | null;
	/**
	 * Hints from an untrusted server, for display only.
	 */
	annotations: Tool["annotations"] | null;
};

export type mcp_client_NormalizedBlock =
	| { kind: "text"; text: string }
	| { kind: "omitted"; type: "image" | "audio" | "blob"; mimeType: string; bytes: number };

export type mcp_client_NormalizedResult = {
	isError: boolean;
	blocks: mcp_client_NormalizedBlock[];
	structured: unknown;
	structuredNote: string | null;
	bytesIn: number;
};

function mcp_nay(
	name: mcp_client_ErrorCode,
	data:
		| { resourceMetadataUrl: string | null; scope: string | null; error: string | null }
		| { scope: string | null }
		| { supported: string[] }
		| { retryAfterMs: number | null }
		| null = null,
) {
	return Result({ _nay: { name, message: ERROR_MESSAGES[name], data } });
}

/**
 * Map an SDK error to a Press error. Read error types and codes only, never message text.
 */
function error_to_nay(
	error: unknown,
	guard: ReturnType<typeof mcp_guarded_fetch_create>,
	phase: "list" | "call",
	era: "modern" | "legacy" | null,
) {
	// The guard's own refusal is the real reason. The SDK only wraps it.
	if (guard.failure) return mcp_nay(guard.failure);

	if (error instanceof InsufficientScopeError) {
		return mcp_nay("insufficient_scope", { scope: error.requiredScope ?? null });
	}

	if (error instanceof SdkHttpError) {
		// Without an auth provider the SDK throws a plain 401, with no challenge. The guard kept the
		// `WWW-Authenticate` header, so parse it from there.
		if (error.status === 401) {
			const challenge = guard.wwwAuthenticate
				? extractWWWAuthenticateParams(new Response(null, { headers: { "WWW-Authenticate": guard.wwwAuthenticate } }))
				: {};
			return mcp_nay("auth_required", {
				resourceMetadataUrl: challenge.resourceMetadataUrl?.href ?? null,
				scope: challenge.scope ?? null,
				error: challenge.error ?? null,
			});
		}
		if (error.status === 403) return mcp_nay("forbidden");
		// A legacy session that the server forgot. The call may have run, so never retry it.
		if (error.status === 404 && phase === "call" && era === "legacy") return mcp_nay("result_unknown");
		// A 400, 404, or 405 with no JSON-RPC error means the URL is not an MCP endpoint. A modern 400
		// with a JSON-RPC error body arrives as a ProtocolError instead.
		if (error.status === 400 || error.status === 404 || error.status === 405) return mcp_nay("not_modern_mcp");
		if (error.status === 429) return mcp_nay("rate_limited", { retryAfterMs: retry_after_ms(guard.retryAfter) });
		if (error.status >= 500) return mcp_nay("server_error");
		return mcp_nay("bad_response");
	}

	if (error instanceof SdkError) {
		// The SDK turns both a timeout and an aborted signal into RequestTimeout.
		if (error.code === SdkErrorCode.RequestTimeout) return mcp_nay("timeout");
		// A probe that got a 5xx or a network error. A guard refusal was already handled above.
		if (error.code === SdkErrorCode.EraNegotiationFailed) return mcp_nay("server_error");
		if (error.code === SdkErrorCode.CapabilityNotSupported) return mcp_nay("input_required_unsupported");
		if (error.code === SdkErrorCode.ListPaginationExceeded) return mcp_nay("too_large");
		if (error.code === SdkErrorCode.UnsupportedResultType) {
			const data: unknown = error.data;
			const resultType = typeof data === "object" && data !== null && "resultType" in data ? data.resultType : null;
			return mcp_nay(resultType === "input_required" ? "input_required_unsupported" : "bad_response");
		}
		// The stream closed before the answer. A tool may have run, so the call result is unknown.
		if (error.code === SdkErrorCode.ConnectionClosed) {
			return mcp_nay(phase === "call" ? "result_unknown" : "network_error");
		}
		return mcp_nay("bad_response");
	}

	if (error instanceof ProtocolError) {
		if (error.code === -32021) return mcp_nay("capability_required");
		if (error.code === -32022) {
			const data: unknown = error.data;
			const supported =
				typeof data === "object" && data !== null && "supported" in data && Array.isArray(data.supported)
					? data.supported.filter((version): version is string => typeof version === "string")
					: [];
			return mcp_nay("unsupported_version", { supported });
		}
		if (error.code === -32020) return mcp_nay("bad_response");
		return mcp_nay("server_error");
	}

	// A fetch TypeError other than the proxy refusal, which the guard already recorded.
	if (error instanceof TypeError) return mcp_nay("network_error");

	return mcp_nay("bad_response");
}

/**
 * Read `Retry-After` as seconds or as an HTTP date.
 */
function retry_after_ms(value: string | null) {
	if (value === null) return null;
	if (/^\d+$/u.test(value.trim())) return Number(value.trim()) * 1000;

	const date = Date.parse(value);
	return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

async function log_failure(
	operation: string,
	server: McpServer,
	nay: { name: string },
	startedAt: number,
	error: unknown,
) {
	console.warn("MCP request failed", {
		operation,
		code: nay.name,
		// Only the class, the SDK code, and the HTTP status. Never the message or the body.
		errorClass: error instanceof Error ? error.constructor.name : typeof error,
		sdkCode: error instanceof SdkError || error instanceof ProtocolError ? error.code : null,
		status: error instanceof SdkHttpError ? error.status : null,
		durationMs: Date.now() - startedAt,
		urlHash: (await crypto_sha256_hex(server.url)).slice(0, 16),
	});
}

function create_client(guard: ReturnType<typeof mcp_guarded_fetch_create>, server: McpServer) {
	const client = new Client(
		{ name: "press", version: "1.0.0" },
		{
			// Declare no elicitation, sampling, or roots, so the SDK never answers a server question.
			// TODO(elicitation): D4.
			capabilities: {},
			versionNegotiation: { mode: "auto" },
			listMaxPages: LIST_MAX_PAGES,
			// Pass the validator explicitly, so Convex and the Node tests use the same one.
			jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
			inputRequired: { autoFulfill: false },
		},
	);
	const transport = new StreamableHTTPClientTransport(new URL(server.url), {
		fetch: guard.fetch,
		// No authProvider: Press never runs an OAuth flow during a tool call. No requestInit headers:
		// the SDK copies them into authorization-server requests too. The guard adds the headers.
		// Never reopen a dropped stream. The SDK needs all four fields.
		reconnectionOptions: {
			maxReconnectionDelay: 1000,
			initialReconnectionDelay: 1000,
			reconnectionDelayGrowFactor: 1,
			maxRetries: 0,
		},
	});
	// The real reason for a ConnectionClosed error only reaches `onerror` (SDK issue #2775).
	client.onerror = (error) => {
		console.warn("MCP client error", {
			errorClass: error.constructor.name,
			sdkCode: error instanceof SdkError || error instanceof ProtocolError ? error.code : null,
		});
	};

	return { client, transport };
}

// #region tool normalization
type SchemaProblem = "missing" | "not_object" | "dialect" | "external_ref" | "recursive_ref" | "too_large";

const SCHEMA_KEYWORDS = [
	"items",
	"additionalProperties",
	"not",
	"if",
	"then",
	"else",
	"contains",
	"propertyNames",
	"unevaluatedItems",
	"unevaluatedProperties",
	"additionalItems",
];
const SCHEMA_MAP_KEYWORDS = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"];
const SCHEMA_LIST_KEYWORDS = ["allOf", "anyOf", "oneOf", "prefixItems", "items"];

/**
 * Return why a tool schema cannot be sent to the model, or `null` when it can.
 */
function schema_problem(schema: unknown): SchemaProblem | null {
	if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return "missing";
	if (!("type" in schema) || schema.type !== "object") return "not_object";
	if (
		"$schema" in schema &&
		schema.$schema !== undefined &&
		!(
			typeof schema.$schema === "string" &&
			/^https?:\/\/json-schema\.org\/(draft\/2020-12|draft-07)\/schema#?$/u.test(schema.$schema)
		)
	) {
		return "dialect";
	}
	if (new TextEncoder().encode(JSON.stringify(schema)).byteLength > SCHEMA_MAX_BYTES) return "too_large";

	// Walk every subschema once. Count them, track the depth, and collect each `$ref`.
	const refs: Array<{ ref: string; path: string }> = [];
	let subschemas = 0;
	const walk = (node: unknown, depth: number, path: string): boolean => {
		if (typeof node !== "object" || node === null || Array.isArray(node)) return true;
		subschemas += 1;
		if (subschemas > SCHEMA_MAX_SUBSCHEMAS || depth > SCHEMA_MAX_DEPTH) return false;
		if ("$ref" in node && typeof node.$ref === "string") refs.push({ ref: node.$ref, path });

		const record = node as Record<string, unknown>;
		for (const keyword of SCHEMA_KEYWORDS) {
			if (!Array.isArray(record[keyword]) && !walk(record[keyword], depth + 1, `${path}/${keyword}`)) return false;
		}
		for (const keyword of SCHEMA_MAP_KEYWORDS) {
			const map = record[keyword];
			if (typeof map !== "object" || map === null || Array.isArray(map)) continue;
			for (const [key, child] of Object.entries(map)) {
				if (!walk(child, depth + 1, `${path}/${keyword}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`)) {
					return false;
				}
			}
		}
		for (const keyword of SCHEMA_LIST_KEYWORDS) {
			const list = record[keyword];
			if (!Array.isArray(list)) continue;
			for (const [index, child] of list.entries()) {
				if (!walk(child, depth + 1, `${path}/${keyword}/${index}`)) return false;
			}
		}
		return true;
	};
	if (!walk(schema, 0, "")) return "too_large";

	// A client must never fetch a network `$ref`, so only local refs are allowed.
	if (refs.some(({ ref }) => !ref.startsWith("#"))) return "external_ref";

	// Model APIs reject recursive schemas. A local ref is recursive when it points at itself or at
	// one of its parents, for example `#` from inside the root.
	for (const { ref, path } of refs) {
		const target = ref.slice(1);
		if (target === "" || path === target || path.startsWith(`${target}/`)) return "recursive_ref";
	}
	return null;
}

/**
 * Keep the tools Press can send to the model, and say why each other tool was left out.
 */
function normalize_tools(rawTools: unknown[]) {
	const kept: mcp_client_NormalizedTool[] = [];
	const dropped: Array<{ name: string; reason: string }> = [];
	const seen = new Set<string>();

	for (const rawTool of rawTools) {
		const parsed = specTypeSchemas.Tool["~standard"].validate(rawTool);
		if (parsed.issues) {
			const rawName =
				typeof rawTool === "object" && rawTool !== null && "name" in rawTool && typeof rawTool.name === "string"
					? rawTool.name.slice(0, TOOL_NAME_MAX_LENGTH)
					: "";
			dropped.push({ name: rawName, reason: "invalid tool definition" });
			continue;
		}
		const tool = parsed.value;

		if (seen.has(tool.name)) {
			dropped.push({ name: tool.name, reason: "duplicate name" });
			continue;
		}
		seen.add(tool.name);

		if (tool.name.length > TOOL_NAME_MAX_LENGTH) {
			dropped.push({ name: tool.name.slice(0, TOOL_NAME_MAX_LENGTH), reason: "name too long" });
			continue;
		}

		const inputProblem = schema_problem(tool.inputSchema);
		if (inputProblem) {
			dropped.push({ name: tool.name, reason: `input schema: ${inputProblem}` });
			continue;
		}

		// A bad output schema only costs the structured check. Keep the tool without it.
		let outputSchema = tool.outputSchema ?? null;
		const outputProblem = outputSchema ? schema_problem(outputSchema) : null;
		if (outputProblem) {
			dropped.push({ name: tool.name, reason: `output schema: ${outputProblem}` });
			outputSchema = null;
		}

		if (kept.length >= TOOLS_PER_SERVER_MAX) {
			dropped.push({ name: tool.name, reason: "too many tools" });
			continue;
		}

		kept.push({
			name: tool.name,
			title: tool.title?.slice(0, TOOL_TITLE_MAX_LENGTH) ?? null,
			description: (tool.description ?? "").slice(0, TOOL_DESCRIPTION_MAX_LENGTH),
			inputSchema: tool.inputSchema,
			outputSchema,
			annotations: tool.annotations ?? null,
		});
	}

	return { tools: kept, dropped };
}
// #endregion tool normalization

// #region result normalization
/**
 * Decoded size of a base64 string, without decoding it.
 */
function base64_bytes(data: string) {
	const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
	return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

function normalize_result(result: CallToolResult, tool: mcp_client_NormalizedTool): mcp_client_NormalizedResult {
	const isError = result.isError === true;
	const blocks: mcp_client_NormalizedBlock[] = [];
	for (const block of result.content) {
		// Never decode or fetch anything. Images and audio are not sent to the model in v1 (D14).
		switch (block.type) {
			case "text":
				blocks.push({ kind: "text", text: block.text });
				break;
			case "image":
			case "audio":
				blocks.push({ kind: "omitted", type: block.type, mimeType: block.mimeType, bytes: base64_bytes(block.data) });
				break;
			case "resource_link":
				blocks.push({
					kind: "text",
					text: `resource link: ${block.uri} (${block.name}, ${block.mimeType ?? "unknown type"}, ${block.size ?? "unknown size"})`,
				});
				break;
			case "resource":
				if ("text" in block.resource) {
					blocks.push({ kind: "text", text: `resource ${block.resource.uri}:\n${block.resource.text}` });
				} else {
					blocks.push({
						kind: "omitted",
						type: "blob",
						mimeType: block.resource.mimeType ?? "application/octet-stream",
						bytes: base64_bytes(block.resource.blob),
					});
				}
				break;
		}
	}

	// Validate structured output here, not in the SDK: the SDK throws on a mismatch and the text
	// result is lost. On a mismatch or a missing value, keep the text and drop the structured value.
	let structured: unknown = result.structuredContent ?? null;
	let structuredNote: string | null = null;
	if (tool.outputSchema && !isError) {
		const valid =
			structured !== null &&
			new CfWorkerJsonSchemaValidator().getValidator<unknown>(tool.outputSchema)(structured).valid;
		if (!valid) {
			structured = null;
			structuredNote = "structured result did not match its schema";
		}
	}

	// Many servers also put the same JSON in a text block. Send it only once.
	if (structured !== null) {
		const structuredJson = JSON.stringify(structured);
		const sameAsText = blocks.some((block) => {
			if (block.kind !== "text") return false;
			try {
				return JSON.stringify(JSON.parse(block.text)) === structuredJson;
			} catch {
				return false;
			}
		});
		if (sameAsText) structured = null;
	}

	return {
		isError,
		blocks,
		structured,
		structuredNote,
		bytesIn: new TextEncoder().encode(JSON.stringify(result)).byteLength,
	};
}
// #endregion result normalization

/**
 * List a server's tools. Use `'auto'` negotiation: probe with `server/discover`, and fall back to the
 * legacy `initialize` handshake for a 2025 server. One deadline covers the probe, the handshake,
 * every page, and the retries.
 */
export async function mcp_client_list_tools(args: {
	server: McpServer;
	accessToken: string | null;
	timeoutMs: number;
	signal: AbortSignal;
	/**
	 * Test only. See `mcp_guarded_fetch_create`.
	 */
	testAllowLocalHttp?: true;
}) {
	const startedAt = Date.now();
	const deadline = startedAt + args.timeoutMs;

	for (let attempt = 0; ; attempt++) {
		const result = await list_tools_once(args, deadline, startedAt);
		if (!result._nay || attempt >= LIST_MAX_RETRIES) return result;
		if (result._nay.name !== "rate_limited" && result._nay.name !== "server_error") return result;

		// Retry only when the wait still fits the deadline.
		const retryAfter = result._nay.data && "retryAfterMs" in result._nay.data ? result._nay.data.retryAfterMs : null;
		const delayMs = Math.max(retryAfter ?? 0, LIST_RETRY_DELAY_MS);
		if (Date.now() + delayMs >= deadline || args.signal.aborted) return result;
		await new Promise((resolve) => setTimeout(resolve, delayMs));
	}
}

async function list_tools_once(
	args: { server: McpServer; accessToken: string | null; signal: AbortSignal; testAllowLocalHttp?: true },
	deadline: number,
	startedAt: number,
) {
	const guard = mcp_guarded_fetch_create({
		kind: "mcp",
		server: args.server,
		accessToken: args.accessToken,
		maxResponseBytes: LIST_PAGE_MAX_BYTES,
		maxTotalBytes: LIST_TOTAL_MAX_BYTES,
		testAllowLocalHttp: args.testAllowLocalHttp,
	});
	const { client, transport } = create_client(guard, args.server);

	// One deadline covers the probe, the handshake, and every page. The SDK's `timeout` is per request,
	// so also abort the whole list when the deadline passes.
	const deadlineAbort = new AbortController();
	const abortList = () => deadlineAbort.abort();
	args.signal.addEventListener("abort", abortList, { once: true });
	const deadlineTimer = setTimeout(abortList, Math.max(1, deadline - Date.now()));
	const requestOptions = () => ({ timeout: Math.max(1, deadline - Date.now()), signal: deadlineAbort.signal });

	return await (async (/* iife */) => {
		await client.connect(transport, requestOptions());

		const era = client.getProtocolEra() ?? null;
		const protocolVersion = client.getNegotiatedProtocolVersion() ?? null;
		if (era === "legacy" && !LEGACY_PROTOCOL_VERSIONS.includes(protocolVersion ?? "")) {
			return mcp_nay("unsupported_version", { supported: [] });
		}

		// On the modern era, `listTools()` walks the pages and drops tools with an invalid `x-mcp-header`.
		// Its codec checks each page against the spec schema, so one malformed tool fails the whole list
		// there. On the legacy era, read raw pages instead, so a malformed tool is dropped on its own.
		const rawTools: unknown[] = era === "modern" ? (await client.listTools(undefined, requestOptions())).tools : [];
		// Like the SDK, treat a server without the tools capability as a server with no tools.
		if (era === "legacy" && client.getServerCapabilities()?.tools) {
			const seenCursors = new Set<string>();
			let cursor: string | undefined;
			for (let page = 0; ; page++) {
				if (page >= LIST_MAX_PAGES) return mcp_nay("too_large");

				const result = await client.request(
					{ method: "tools/list", ...(cursor !== undefined && { params: { cursor } }) },
					tools_list_page_schema,
					requestOptions(),
				);
				rawTools.push(...result.tools);

				// A repeated cursor means the server does not end its pages. Stop like the SDK does.
				if (result.nextCursor === undefined || seenCursors.has(result.nextCursor)) break;
				seenCursors.add(result.nextCursor);
				cursor = result.nextCursor;
			}
		}
		const serverVersion = client.getServerVersion();

		return Result({
			_yay: {
				...normalize_tools(rawTools),
				era,
				protocolVersion,
				// The turn passes this to each call of the same server and member, so a modern call sends
				// no probe. Never store it, and never reuse it for another member.
				discover: era === "modern" ? (client.getDiscoverResult() ?? null) : null,
				// Self-reported by the server. For logs only.
				serverInfo: serverVersion ? { name: serverVersion.name, version: serverVersion.version } : null,
			},
		});
	})()
		.catch(async (error: unknown) => {
			const nay = error_to_nay(error, guard, "list", client.getProtocolEra() ?? null);
			await log_failure("list_tools", args.server, nay._nay, startedAt, error);
			return nay;
		})
		.finally(() => {
			clearTimeout(deadlineTimer);
			args.signal.removeEventListener("abort", abortList);
			return client.close().catch(() => {});
		});
}

/**
 * Call one tool with the definition frozen at turn setup.
 *
 * A modern server gets the turn's `discover` result as the prior, so the call sends no probe. A
 * legacy server (`discover: null`) gets a new session for this one call: `initialize`, the call,
 * then a DELETE. Never retry a call: a write may already have run.
 */
export async function mcp_client_call_tool(args: {
	server: McpServer;
	accessToken: string | null;
	discover: DiscoverResult | null;
	tool: mcp_client_NormalizedTool;
	arguments: Record<string, unknown>;
	timeoutMs: number;
	signal: AbortSignal;
	/**
	 * Test only. See `mcp_guarded_fetch_create`.
	 */
	testAllowLocalHttp?: true;
}) {
	const startedAt = Date.now();
	const guard = mcp_guarded_fetch_create({
		kind: "mcp",
		server: args.server,
		accessToken: args.accessToken,
		maxResponseBytes: CALL_MAX_BYTES,
		maxTotalBytes: CALL_MAX_BYTES,
		testAllowLocalHttp: args.testAllowLocalHttp,
	});
	const { client, transport } = create_client(guard, args.server);
	const era = args.discover ? "modern" : "legacy";

	return await (async (/* iife */) => {
		await client.connect(transport, {
			timeout: args.timeoutMs,
			signal: args.signal,
			prior: args.discover ? { kind: "modern", discover: args.discover } : { kind: "legacy" },
		});

		if (era === "legacy" && !LEGACY_PROTOCOL_VERSIONS.includes(client.getNegotiatedProtocolVersion() ?? "")) {
			return mcp_nay("unsupported_version", { supported: [] });
		}

		// Pass the definition without `outputSchema`: header mirroring still works, and the SDK does
		// not throw away the text result on a structured mismatch. `normalize_result` checks it.
		const toolDefinition: Tool = {
			name: args.tool.name,
			description: args.tool.description,
			inputSchema: args.tool.inputSchema as Tool["inputSchema"],
		};
		const result = await client
			.callTool(
				{ name: args.tool.name, arguments: args.arguments },
				{ timeout: Math.max(1, startedAt + args.timeoutMs - Date.now()), signal: args.signal, toolDefinition },
			)
			.then(
				(value) => ({ value, protocolError: null }),
				(error: unknown) => {
					// The server rejected the call itself. Give the model a short fixed text plus the
					// server's message, so it can fix its arguments. Keep the codes that mean
					// something to Press as errors.
					if (error instanceof ProtocolError && ![-32020, -32021, -32022].includes(error.code)) {
						return { value: null, protocolError: error };
					}
					throw error;
				},
			);

		// End the one-call legacy session. The SDK sends a DELETE only when the server set a session
		// id, and a 405 answer is fine.
		if (era === "legacy") await transport.terminateSession().catch(() => {});

		if (result.protocolError) {
			const prefix =
				result.protocolError.code === -32602
					? "tool call rejected: invalid arguments"
					: `tool call failed with error ${result.protocolError.code}`;
			return Result({
				_yay: {
					result: {
						isError: true,
						blocks: [
							{
								kind: "text",
								text: `${prefix}: ${result.protocolError.message.slice(0, SERVER_ERROR_MESSAGE_MAX_LENGTH)}`,
							},
						],
						structured: null,
						structuredNote: null,
						bytesIn: 0,
					} satisfies mcp_client_NormalizedResult,
				},
			});
		}

		return Result({ _yay: { result: normalize_result(result.value, args.tool) } });
	})()
		.catch(async (error: unknown) => {
			const nay = error_to_nay(error, guard, "call", era);
			await log_failure("call_tool", args.server, nay._nay, startedAt, error);
			return nay;
		})
		.finally(() => client.close().catch(() => {}));
}
