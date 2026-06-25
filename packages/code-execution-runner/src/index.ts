// Host Worker for `execute_code`.
//
// Runs untrusted JavaScript in a Worker Loader Dynamic Worker and returns a
// bounded JSON result plus bounded logs.
//
// Security notes:
// - The sandbox receives no platform `env`, bindings, or host secrets.
// - Without a network/app capability, `globalOutbound: null` makes `fetch()`
//   and `connect()` throw.
// - Internet access is explicit opt-in and routes through `ExecuteCodeHttpGateway`.
// - App file access uses a public API grant token kept in the gateway;
//   the snippet sees only `process.env.T3_APP_ORIGIN`.
// - Execution has an in-sandbox 5s timeout plus a parent 7s wall-clock
//   backstop. Synchronous CPU loops may hit workerd's resource limit first;
//   those kills are mapped to `timed_out`.
// - Operational logs include only execution metadata, never code, input, result,
//   or sandbox logs.
// - Auth uses `Authorization: Bearer <CODE_EXECUTION_RUNNER_SECRET>`.

import { WorkerEntrypoint } from "cloudflare:workers";

// Typed locally to match the in-file binding shape convention.
// Mirrors `WorkerLoaderWorkerCode`; no `limits` field because Worker Loader does not accept it.
type CodeWorkerLoaderWorkerCode = {
	compatibilityDate: string;
	compatibilityFlags?: string[];
	mainModule: string;
	modules: Record<string, string>;
	env?: Record<string, unknown>;
	globalOutbound?: Fetcher | null;
};

type SandboxEvaluateResult =
	| { ok: true; resultJson: string; logs: string[]; logsTruncated: boolean }
	| { ok: false; error: { name: string; message: string }; logs: string[]; logsTruncated: boolean };

type CodeWorkerStub = {
	getEntrypoint: () => { evaluate: (input: unknown) => Promise<SandboxEvaluateResult> };
};

type CodeWorkerLoader = {
	load: (code: CodeWorkerLoaderWorkerCode) => CodeWorkerStub;
};

export type Env = {
	LOADER: CodeWorkerLoader;
	CODE_EXECUTION_RUNNER_SECRET: string;
	CODE_EXECUTION_DISABLED?: string;
	CODE_EXECUTION_NETWORK_DISABLED?: string;
};

type Fetcher = {
	fetch: (request: Request) => Response | Promise<Response>;
};

type ExecuteCodeContext = ExecutionContext & {
	readonly exports?: {
		readonly ExecuteCodeHttpGateway?: (options: { props: ExecuteCodeHttpGatewayProps }) => Fetcher;
	};
};

type ExecuteCodeHttpGatewayProps = {
	executionId: string;
	allowPublic: boolean;
	app?: AppRuntime;
};

type NetworkPolicy = {
	mode: "public_http";
};

type AppRuntime = {
	origin: string;
	token: string;
};

// Limits / constants

export const LIMITS = {
	codeBytes: 20_000,
	inputBytes: 64_000,
	bodyBytes: 96_000,
	resultBytes: 16_000,
	logBytes: 16_000,
	logLines: 100,
	fetchRequestBytes: 128_000,
	fetchResponseBytes: 512_000,
	fetchRequests: 20,
	fetchRedirects: 5,
	fetchTimeoutMs: 5_000,
	sandboxTimeoutMs: 5_000,
	parentTimeoutMs: 7_000,
} as const;

const COMPAT_DATE = "2025-06-01";
const WRAPPER_VERSION = "v1";
const ENTRY_MODULE = "executor.js";
const EXECUTE_CODE_REQUEST_FIELDS = new Set(["code", "input", "executionId", "network", "app"]);

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

// Small helpers

function byte_length(value: string): number {
	return TEXT_ENCODER.encode(value).length;
}

function json_response(body: unknown, status: number): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

async function constant_time_sha256_equal(a: string, b: string): Promise<boolean> {
	const [aDigest, bDigest] = await Promise.all([
		crypto.subtle.digest("SHA-256", TEXT_ENCODER.encode(a)),
		crypto.subtle.digest("SHA-256", TEXT_ENCODER.encode(b)),
	]);
	const aBytes = new Uint8Array(aDigest);
	const bBytes = new Uint8Array(bDigest);
	let diff = aBytes.length ^ bBytes.length;
	for (let i = 0; i < Math.max(aBytes.length, bBytes.length); i++) {
		diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
	}
	return diff === 0;
}

async function is_authorized(request: Request, env: Env): Promise<boolean> {
	const header = request.headers.get("Authorization");
	const prefix = "Bearer ";
	if (!header?.startsWith(prefix)) return false;
	return await constant_time_sha256_equal(header.slice(prefix.length), env.CODE_EXECUTION_RUNNER_SECRET);
}

function is_record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cap_message(message: string): string {
	return message.length > 1000 ? `${message.slice(0, 1000)}…` : message;
}

function sanitize_error(error: unknown): { name: string; message: string } {
	if (error && typeof error === "object") {
		const e = error as { name?: unknown; message?: unknown };
		return {
			name: typeof e.name === "string" ? e.name : "Error",
			message: cap_message(typeof e.message === "string" ? e.message : String(error)),
		};
	}
	return { name: "Error", message: cap_message(String(error)) };
}

// workerd kills a runaway sandbox (e.g. a synchronous `while (true) {}` that
// starves both the in-sandbox and parent-side JS timers) at the platform CPU
// limit, surfacing "Worker exceeded CPU time limit." / "exceeded resource
// limits". That is a resource-exhaustion timeout, not a user-code error, so map
// it to `timed_out`.
function is_resource_limit_error(error: unknown): boolean {
	const message = error && typeof error === "object" ? (error as { message?: unknown }).message : undefined;
	if (typeof message !== "string") return false;
	return /exceeded (the )?(cpu time|resource|memory) limit/iu.test(message);
}

async function sha256_hex(input: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", TEXT_ENCODER.encode(input));
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

// Operational log — metadata only, never raw code/input/result/logs.
function log_execution(fields: Record<string, string | number | boolean>): void {
	console.log(JSON.stringify({ tag: "code_execution", ...fields }));
}

function log_outbound(fields: Record<string, string | number | boolean>): void {
	console.log(JSON.stringify({ tag: "code_execution_outbound", ...fields }));
}

function append_bytes(chunks: Uint8Array[], size: number) {
	const out = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

async function read_bounded_stream(stream: ReadableStream<Uint8Array> | null, maxBytes: number) {
	if (!stream) return { bytes: new Uint8Array(), truncated: false };

	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) break;

			const chunk = next.value;
			const remaining = maxBytes - size;
			if (chunk.byteLength > remaining) {
				if (remaining > 0) {
					chunks.push(chunk.slice(0, remaining));
					size += remaining;
				}
				await reader.cancel();
				return { bytes: append_bytes(chunks, size), truncated: true };
			}

			chunks.push(chunk);
			size += chunk.byteLength;
		}
		return { bytes: append_bytes(chunks, size), truncated: false };
	} finally {
		reader.releaseLock();
	}
}

async function read_bounded_text(request: Request) {
	const { bytes, truncated } = await read_bounded_stream(request.body, LIMITS.bodyBytes);
	if (truncated) return { ok: false as const };
	return { ok: true as const, text: TEXT_DECODER.decode(bytes) };
}

// Outbound gateway

function is_supported_outbound_method(method: string) {
	return ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method);
}

function method_can_have_outbound_body(method: string) {
	return method !== "GET" && method !== "HEAD";
}

function normalize_hostname(hostname: string) {
	let host = hostname.toLowerCase();
	if (host.endsWith(".")) {
		host = host.slice(0, -1);
	}
	if (host.startsWith("[") && host.endsWith("]")) {
		host = host.slice(1, -1);
	}
	return host;
}

function is_ipv4_literal(hostname: string) {
	const parts = hostname.split(".");
	if (parts.length !== 4) return false;
	return parts.every((part) => /^\d{1,3}$/u.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

function is_blocked_hostname(hostname: string) {
	if (hostname === "localhost") return true;
	if (!hostname.includes(".")) return true;
	return hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal");
}

export function validate_outbound_url(
	rawUrl: string,
): { ok: true; url: URL; hostname: string } | { ok: false; reason: string; hostname: string } {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return { ok: false, reason: "invalid_url", hostname: "unknown" };
	}

	const hostname = normalize_hostname(url.hostname);
	if (url.protocol !== "https:") return { ok: false, reason: "protocol", hostname };
	if (url.username || url.password) return { ok: false, reason: "credentials", hostname };
	if (!hostname) return { ok: false, reason: "hostname", hostname: "unknown" };
	if (url.port && url.port !== "443") return { ok: false, reason: "port", hostname };
	if (is_ipv4_literal(hostname) || hostname.includes(":")) return { ok: false, reason: "ip_literal", hostname };
	if (is_blocked_hostname(hostname)) return { ok: false, reason: "hostname", hostname };

	return { ok: true, url, hostname };
}

const BLOCKED_OUTBOUND_HEADERS = new Set([
	"cf-connecting-ip",
	"cf-ipcountry",
	"cf-ray",
	"connection",
	"cookie",
	"expect",
	"forwarded",
	"host",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
	"x-forwarded-for",
	"x-real-ip",
]);

function copy_outbound_headers(headers: Headers) {
	const copied = new Headers();
	headers.forEach((value, name) => {
		const lowerName = name.toLowerCase();
		if (BLOCKED_OUTBOUND_HEADERS.has(lowerName)) return;
		if (lowerName.startsWith("sec-")) return;
		if (lowerName.startsWith("x-forwarded-")) return;
		copied.set(name, value.slice(0, 4096));
	});
	return copied;
}

function is_app_public_api_url(url: URL, app: AppRuntime | undefined) {
	return app !== undefined && url.origin === app.origin && url.pathname.startsWith("/api/v1/files/");
}

function copy_response_headers(headers: Headers, truncated: boolean) {
	const out = new Headers();
	const contentType = headers.get("content-type");
	if (contentType) out.set("content-type", contentType.slice(0, 128));
	out.set("cache-control", "no-store");
	if (truncated) out.set("x-execute-code-truncated", "true");
	return out;
}

function bytes_to_body_init(bytes: Uint8Array | undefined): BodyInit | undefined {
	if (!bytes) return undefined;
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy.buffer;
}

async function fetch_with_timeout(request: Request) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), LIMITS.fetchTimeoutMs);
	try {
		return await fetch(request, {
			signal: controller.signal,
			redirect: "manual",
		});
	} finally {
		clearTimeout(timer);
	}
}

async function log_outbound_event(input: {
	executionId: string;
	hostname: string;
	status: string | number;
	bytes: number;
	truncated: boolean;
	reason?: string;
}) {
	const hostnameHash = (await sha256_hex(input.hostname)).slice(0, 16);
	log_outbound({
		executionId: input.executionId,
		hostnameHash,
		status: input.status,
		bytes: input.bytes,
		truncated: input.truncated,
		...(input.reason ? { reason: input.reason } : {}),
	});
}

async function capped_outbound_response(response: Response) {
	const { bytes, truncated } = await read_bounded_stream(response.body, LIMITS.fetchResponseBytes);
	return {
		response: new Response(bytes, {
			status: response.status,
			headers: copy_response_headers(response.headers, truncated),
		}),
		bytes: bytes.byteLength,
		truncated,
	};
}

function redirect_next_method(input: {
	status: number;
	method: string;
	headers: Headers;
	body: Uint8Array | undefined;
	sourceOrigin: string;
	targetOrigin: string;
}) {
	if (input.sourceOrigin !== input.targetOrigin) {
		input.headers.delete("authorization");
	}
	if (input.status === 303 || ((input.status === 301 || input.status === 302) && input.method === "POST")) {
		input.headers.delete("content-type");
		return { method: "GET", headers: input.headers, body: undefined };
	}
	return input;
}

export async function handle_outbound_gateway_request(request: Request, props: ExecuteCodeHttpGatewayProps) {
	const method = request.method.toUpperCase();
	if (!is_supported_outbound_method(method)) {
		return new Response("Method not allowed", { status: 405 });
	}

	const firstValidation = validate_outbound_url(request.url);
	if (!firstValidation.ok) {
		await log_outbound_event({
			executionId: props.executionId,
			hostname: firstValidation.hostname,
			status: "blocked",
			bytes: 0,
			truncated: false,
			reason: firstValidation.reason,
		});
		return new Response("Blocked outbound request", { status: 403 });
	}
	if (!props.allowPublic && !is_app_public_api_url(firstValidation.url, props.app)) {
		await log_outbound_event({
			executionId: props.executionId,
			hostname: firstValidation.hostname,
			status: "blocked",
			bytes: 0,
			truncated: false,
			reason: "capability",
		});
		return new Response("Blocked outbound request", { status: 403 });
	}

	let requestBody: Uint8Array | undefined;
	if (method_can_have_outbound_body(method)) {
		const body = await read_bounded_stream(request.body, LIMITS.fetchRequestBytes);
		if (body.truncated) {
			return new Response("Request body too large", { status: 413 });
		}
		requestBody = body.bytes;
	}

	let nextUrl = firstValidation.url;
	let nextMethod = method;
	let nextHeaders = copy_outbound_headers(request.headers);
	let originalAuthorization = nextHeaders.get("authorization");
	let nextBody = requestBody;
	for (let redirectCount = 0; redirectCount <= LIMITS.fetchRedirects; redirectCount++) {
		if (!props.allowPublic && !is_app_public_api_url(nextUrl, props.app)) {
			await log_outbound_event({
				executionId: props.executionId,
				hostname: normalize_hostname(nextUrl.hostname),
				status: "blocked",
				bytes: 0,
				truncated: false,
				reason: "capability",
			});
			return new Response("Blocked outbound request", { status: 403 });
		}

		const app = props.app;
		if (app && is_app_public_api_url(nextUrl, app)) {
			nextHeaders.set("authorization", `Bearer ${app.token}`);
		} else if (originalAuthorization) {
			nextHeaders.set("authorization", originalAuthorization);
		} else {
			nextHeaders.delete("authorization");
		}

		const outboundRequest = new Request(nextUrl.href, {
			method: nextMethod,
			headers: nextHeaders,
			body: bytes_to_body_init(nextBody),
		});
		const response = await fetch_with_timeout(outboundRequest);
		const redirectLocation = response.headers.get("location");
		if (![301, 302, 303, 307, 308].includes(response.status) || !redirectLocation) {
			const capped = await capped_outbound_response(response);
			await log_outbound_event({
				executionId: props.executionId,
				hostname: normalize_hostname(nextUrl.hostname),
				status: response.status,
				bytes: capped.bytes,
				truncated: capped.truncated,
			});
			return capped.response;
		}

		if (redirectCount === LIMITS.fetchRedirects) {
			return new Response("Too many redirects", { status: 508 });
		}

		const redirectedUrl = new URL(redirectLocation, nextUrl);
		const redirectValidation = validate_outbound_url(redirectedUrl.href);
		if (!redirectValidation.ok) {
			await log_outbound_event({
				executionId: props.executionId,
				hostname: redirectValidation.hostname,
				status: "blocked",
				bytes: 0,
				truncated: false,
				reason: redirectValidation.reason,
			});
			return new Response("Blocked outbound redirect", { status: 403 });
		}

		const redirect = redirect_next_method({
			status: response.status,
			method: nextMethod,
			headers: nextHeaders,
			body: nextBody,
			sourceOrigin: nextUrl.origin,
			targetOrigin: redirectValidation.url.origin,
		});
		if (nextUrl.origin !== redirectValidation.url.origin) {
			originalAuthorization = null;
		}
		nextUrl = redirectValidation.url;
		nextMethod = redirect.method;
		nextHeaders = redirect.headers;
		nextBody = redirect.body;
	}

	return new Response("Too many redirects", { status: 508 });
}

export class ExecuteCodeHttpGateway extends WorkerEntrypoint<Env, ExecuteCodeHttpGatewayProps> {
	async fetch(request: Request): Promise<Response> {
		return await handle_outbound_gateway_request(request, this.ctx.props);
	}

	connect(): never {
		throw new Error("TCP connect is not allowed.");
	}
}

// Execution timeout

export class WallTimeoutError extends Error {
	constructor() {
		super("Wall-clock timeout");
		this.name = "WallTimeoutError";
	}
}

export function with_wall_timeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new WallTimeoutError()), ms);
	});
	return Promise.race([promise, timeout]).finally(() => {
		if (timer !== undefined) clearTimeout(timer);
	});
}

// Dynamic Worker module generation
//
// The generated ES module exports `class CodeExecutor extends WorkerEntrypoint`
// with an `evaluate(input)` RPC method that hijacks console into a bounded
// `__logs` array, runs the user body inside `(async (input) => { ... })(input)`
// with an in-sandbox `Promise.race` timeout, and JSON-stringifies the result so
// only strings cross the RPC boundary. The user `code` is the BODY of that async
// function and should `return` a JSON-serializable value.

function build_harness_prefix(executionEnv: Record<string, string>) {
	return `import { WorkerEntrypoint } from "cloudflare:workers";

export default class CodeExecutor extends WorkerEntrypoint {
  async evaluate(input) {
    const process = Object.freeze({ env: Object.freeze(${JSON.stringify(executionEnv)}) });
    const __logs = [];
    let __logBytes = 0;
    let __logsTruncated = false;
    const __MAX_LOG_LINES = ${LIMITS.logLines};
    const __MAX_LOG_BYTES = ${LIMITS.logBytes};
    const __enc = new TextEncoder();
    const __push = (prefix, args) => {
      if (__logsTruncated) return;
      if (__logs.length >= __MAX_LOG_LINES) { __logsTruncated = true; return; }
      let line = prefix + args.map((a) => {
        if (typeof a === "string") return a;
        try { return JSON.stringify(a); } catch (e) { return String(a); }
      }).join(" ");
      let bytes = __enc.encode(line).length;
      if (__logBytes + bytes > __MAX_LOG_BYTES) {
        line = line.slice(0, Math.max(0, __MAX_LOG_BYTES - __logBytes));
        __logsTruncated = true;
        bytes = __enc.encode(line).length;
      }
      __logBytes += bytes;
      __logs.push(line);
    };
    console.log = (...a) => __push("", a);
    console.info = (...a) => __push("", a);
    console.debug = (...a) => __push("", a);
    console.warn = (...a) => __push("[warn] ", a);
    console.error = (...a) => __push("[error] ", a);
    if (typeof globalThis.fetch === "function") {
      const __nativeFetch = globalThis.fetch.bind(globalThis);
      let __fetchRequests = 0;
      globalThis.fetch = (...args) => {
        __fetchRequests += 1;
        if (__fetchRequests > ${LIMITS.fetchRequests}) {
          return Promise.reject(new Error("Fetch request limit exceeded"));
        }
        return __nativeFetch(...args);
      };
    }
    try {
      const __result = await Promise.race([
        (async (input) => {
`;
}

const HARNESS_SUFFIX = `
        })(input),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Execution timed out")), ${LIMITS.sandboxTimeoutMs})),
      ]);
      let __resultJson;
      try {
        __resultJson = __result === undefined ? "null" : JSON.stringify(__result);
      } catch (e) {
        return { ok: false, error: { name: "TypeError", message: "Result is not JSON-serializable" }, logs: __logs, logsTruncated: __logsTruncated };
      }
      if (typeof __resultJson !== "string") __resultJson = "null";
      return { ok: true, resultJson: __resultJson, logs: __logs, logsTruncated: __logsTruncated };
    } catch (err) {
      const __name = err && err.name ? String(err.name) : "Error";
      const __message = err && err.message ? String(err.message) : String(err);
      return { ok: false, error: { name: __name, message: __message }, logs: __logs, logsTruncated: __logsTruncated };
    }
  }
}
`;

export function build_executor_module(user_code: string, executionEnv: Record<string, string> = {}): string {
	return build_harness_prefix(executionEnv) + user_code + HARNESS_SUFFIX;
}

// Request handling

function invalid_request(message: string) {
	return json_response({ ok: false, error: { code: "invalid_request", message } }, 400);
}

function too_large(message: string) {
	return json_response({ ok: false, error: { code: "too_large", message } }, 413);
}

function parse_network_policy(
	value: unknown,
): { ok: true; policy: NetworkPolicy | null } | { ok: false; response: Response } {
	if (value === undefined || value === null) return { ok: true, policy: null };
	if (!is_record(value) || value.mode !== "public_http") {
		return { ok: false, response: invalid_request('`network` must be { mode: "public_http" } when provided.') };
	}
	return { ok: true, policy: { mode: "public_http" } };
}

function parse_app_runtime(value: unknown): { ok: true; app: AppRuntime | null } | { ok: false; response: Response } {
	if (value === undefined || value === null) return { ok: true, app: null };
	if (!is_record(value) || typeof value.origin !== "string" || typeof value.token !== "string") {
		return { ok: false, response: invalid_request("`app` must include `origin` and `token` strings.") };
	}
	if (value.token.length === 0 || value.token.length > 512) {
		return { ok: false, response: invalid_request("`app.token` is invalid.") };
	}

	let origin: string;
	try {
		const url = new URL(value.origin);
		if (url.protocol !== "https:") {
			return { ok: false, response: invalid_request("`app.origin` must be an HTTPS origin.") };
		}
		origin = url.origin;
	} catch {
		return { ok: false, response: invalid_request("`app.origin` must be a valid URL.") };
	}

	return { ok: true, app: { origin, token: value.token } };
}

function build_evaluate_input(
	input: unknown,
): { ok: true; input: unknown; inputJson: string } | { ok: false; response: Response } {
	let inputJson: string;
	try {
		inputJson = input === undefined ? "null" : JSON.stringify(input ?? null);
	} catch {
		return { ok: false, response: invalid_request("`input` must be JSON-serializable.") };
	}
	if (typeof inputJson !== "string") inputJson = "null";
	return { ok: true, input: input ?? null, inputJson };
}

async function handle_execute_code(request: Request, env: Env, ctx?: ExecuteCodeContext): Promise<Response> {
	// Auth first so an unauthenticated caller cannot probe the kill-switch state.
	if (!(await is_authorized(request, env))) {
		return json_response({ ok: false, error: { code: "unauthorized", message: "Unauthorized" } }, 401);
	}
	if (env.CODE_EXECUTION_DISABLED === "true") {
		return json_response({ ok: false, error: { code: "disabled", message: "Code execution is disabled." } }, 503);
	}

	const raw = await read_bounded_text(request);
	if (!raw.ok) return too_large("Request body too large.");

	let body: unknown;
	try {
		body = JSON.parse(raw.text);
	} catch {
		return json_response(
			{ ok: false, error: { code: "invalid_json", message: "Request body must be valid JSON." } },
			400,
		);
	}
	if (!is_record(body)) {
		return json_response(
			{ ok: false, error: { code: "invalid_request", message: "Request body must be a JSON object." } },
			400,
		);
	}
	for (const key of Object.keys(body)) {
		if (!EXECUTE_CODE_REQUEST_FIELDS.has(key)) {
			return invalid_request(`Unknown request field \`${key}\`.`);
		}
	}

	const code = body.code;
	if (typeof code !== "string" || code.length === 0) {
		return json_response(
			{ ok: false, error: { code: "invalid_request", message: "`code` must be a non-empty string." } },
			400,
		);
	}
	if (byte_length(code) > LIMITS.codeBytes) {
		return too_large("`code` exceeds the size limit.");
	}

	const network = parse_network_policy(body.network);
	if (!network.ok) return network.response;

	const appRuntime = parse_app_runtime(body.app);
	if (!appRuntime.ok) return appRuntime.response;

	const evaluateInput = build_evaluate_input(body.input);
	if (!evaluateInput.ok) return evaluateInput.response;

	const inputJson = evaluateInput.inputJson;
	if (byte_length(inputJson) > LIMITS.inputBytes) {
		return too_large("`input` exceeds the size limit.");
	}

	const executionId =
		typeof body.executionId === "string" && body.executionId.length > 0 ? body.executionId : crypto.randomUUID();
	const codeBytes = byte_length(code);
	const inputBytes = byte_length(inputJson);
	const codeHash = await sha256_hex(`${WRAPPER_VERSION}\n${code}`);
	const moduleSource = build_executor_module(
		code,
		appRuntime.app
			? {
					T3_APP_ORIGIN: appRuntime.app.origin,
				}
			: {},
	);
	const needsOutbound = network.policy !== null || appRuntime.app !== null;
	let globalOutbound: Fetcher | null = null;
	if (needsOutbound && env.CODE_EXECUTION_NETWORK_DISABLED !== "true") {
		const outboundGateway = ctx?.exports?.ExecuteCodeHttpGateway;
		if (!outboundGateway) {
			return json_response(
				{
					ok: false,
					error: {
						code: "misconfigured",
						message: "Code execution outbound access is unavailable.",
					},
				},
				503,
			);
		}
		globalOutbound = outboundGateway({
			props: {
				executionId,
				allowPublic: network.policy !== null,
				...(appRuntime.app ? { app: appRuntime.app } : {}),
			},
		});
	} else if (needsOutbound) {
		return json_response(
			{
				ok: false,
				error: {
					code: "disabled",
					message: "Code execution outbound access is disabled.",
				},
			},
			503,
		);
	}

	const started = Date.now();
	let sandbox: SandboxEvaluateResult;
	try {
		const worker = env.LOADER.load({
			compatibilityDate: COMPAT_DATE,
			compatibilityFlags: ["nodejs_compat"],
			mainModule: ENTRY_MODULE,
			modules: { [ENTRY_MODULE]: moduleSource },
			globalOutbound,
			// No platform `env`: synthetic values are lexical harness variables only.
		});
		const entrypoint = worker.getEntrypoint();
		sandbox = await with_wall_timeout(entrypoint.evaluate(evaluateInput.input), LIMITS.parentTimeoutMs);
	} catch (err) {
		const elapsedMs = Date.now() - started;
		const wallTimeout = err instanceof WallTimeoutError;
		const resourceLimit = is_resource_limit_error(err);
		const timedOut = wallTimeout || resourceLimit;
		log_execution({
			executionId,
			codeHash,
			status: timedOut ? "timed_out" : "errored",
			elapsedMs,
			codeBytes,
			inputBytes,
			resultBytes: 0,
			logCount: 0,
			logsTruncated: false,
			resultTruncated: false,
		});
		return json_response(
			{
				executionId,
				status: timedOut ? "timed_out" : "errored",
				codeHash,
				elapsedMs,
				result: null,
				resultTruncated: false,
				logs: [],
				logsTruncated: false,
				error: wallTimeout
					? { name: "TimeoutError", message: "Execution timed out." }
					: resourceLimit
						? { name: "TimeoutError", message: "Execution exceeded the platform CPU/time limit." }
						: sanitize_error(err),
			},
			200,
		);
	}

	const elapsedMs = Date.now() - started;
	const logs = Array.isArray(sandbox.logs) ? sandbox.logs : [];
	const logsTruncated = sandbox.logsTruncated === true;

	if (!sandbox.ok) {
		const timedOut = sandbox.error?.message === "Execution timed out";
		log_execution({
			executionId,
			codeHash,
			status: timedOut ? "timed_out" : "errored",
			elapsedMs,
			codeBytes,
			inputBytes,
			resultBytes: 0,
			logCount: logs.length,
			logsTruncated,
			resultTruncated: false,
		});
		return json_response(
			{
				executionId,
				status: timedOut ? "timed_out" : "errored",
				codeHash,
				elapsedMs,
				result: null,
				resultTruncated: false,
				logs,
				logsTruncated,
				error: {
					name: sandbox.error?.name ?? "Error",
					message: cap_message(sandbox.error?.message ?? "Unknown error"),
				},
			},
			200,
		);
	}

	const resultJson = typeof sandbox.resultJson === "string" ? sandbox.resultJson : "null";
	const resultBytes = byte_length(resultJson);
	let result: unknown = null;
	let resultTruncated = false;
	if (resultBytes > LIMITS.resultBytes) {
		resultTruncated = true;
	} else {
		try {
			result = JSON.parse(resultJson);
		} catch {
			result = null;
		}
	}

	log_execution({
		executionId,
		codeHash,
		status: "succeeded",
		elapsedMs,
		codeBytes,
		inputBytes,
		resultBytes,
		logCount: logs.length,
		logsTruncated,
		resultTruncated,
	});
	return json_response(
		{
			executionId,
			status: "succeeded",
			codeHash,
			elapsedMs,
			result,
			resultTruncated,
			logs,
			logsTruncated,
			error: null,
		},
		200,
	);
}

export async function handle_request(request: Request, env: Env, ctx?: ExecuteCodeContext): Promise<Response> {
	const url = new URL(request.url);
	if (request.method === "GET" && url.pathname === "/health") {
		return json_response({ ok: true }, 200);
	}
	if (request.method === "POST" && url.pathname === "/internal/execute-code") {
		return handle_execute_code(request, env, ctx);
	}
	return json_response({ ok: false, error: { code: "not_found", message: "Not found" } }, 404);
}

export default {
	fetch: handle_request,
};
