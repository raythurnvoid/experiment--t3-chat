// Host Worker for Phase 0 plugin artifact execution.
//
// Security notes:
// - The plugin Dynamic Worker receives no platform `env`, bindings, R2 bucket, or host secrets.
// - Plugin `fetch()` goes through the `BonoboOutbound` Fetcher: host-origin requests pass through,
//   every other origin is gated on the `outbound.fetch` capability and the per-run origin allowlist.
// - Operational logs include only metadata, never artifact source, input, output, or secrets.
// - Auth uses `Authorization: Bearer <PLUGIN_RUNNER_SECRET>` for the Phase 0 internal endpoint.

import { WorkerEntrypoint } from "cloudflare:workers";

type DynamicWorkerLimits = {
	cpuMs: number;
	subRequests: number;
};

type PluginWorkerLoaderWorkerCode = {
	compatibilityDate: string;
	compatibilityFlags?: string[];
	mainModule: string;
	modules: Record<string, string>;
	env?: Record<string, unknown>;
	globalOutbound?: Fetcher | null;
	limits?: DynamicWorkerLimits;
};

type Fetcher = {
	fetch: (request: Request) => Response | Promise<Response>;
};

type BonoboHostBinding = {
	secretGet: (input: unknown) => Promise<unknown>;
};

type HostRuntime = {
	origin: string;
	token: string;
};

type PluginEntrypointProps = {
	pluginRunId: string;
	host: HostRuntime;
	acceptedCapabilities: string[];
};

type PluginWorkerStub = {
	getEntrypoint: (
		name?: string | null,
		options?: { props?: PluginEntrypointProps; limits?: DynamicWorkerLimits },
	) => Fetcher;
};

type PluginWorkerLoader = {
	get: (
		id: string,
		getCode: () => PluginWorkerLoaderWorkerCode | Promise<PluginWorkerLoaderWorkerCode>,
	) => PluginWorkerStub;
	load?: (code: PluginWorkerLoaderWorkerCode) => PluginWorkerStub;
};

type R2ObjectBody = {
	arrayBuffer?: () => Promise<ArrayBuffer>;
	text?: () => Promise<string>;
};

type R2BucketBinding = {
	get: (key: string) => Promise<R2ObjectBody | null>;
};

type BonoboHostProps = {
	pluginStableId: string;
	acceptedCapabilities: string[];
};

type BonoboOutboundProps = {
	pluginStableId: string;
	pluginRunId: string;
	host: HostRuntime;
	acceptedCapabilities: string[];
	outboundOrigins: string[];
};

type PluginRunnerContext = ExecutionContext & {
	readonly exports?: {
		readonly BonoboHost?: (options: { props: BonoboHostProps }) => BonoboHostBinding;
		readonly BonoboOutbound?: (options: { props: BonoboOutboundProps }) => Fetcher;
	};
};

export type Env = {
	LOADER: PluginWorkerLoader;
	PLUGIN_ARTIFACTS: R2BucketBinding;
	PLUGIN_RUNNER_SECRET: string;
	PLUGIN_RUNNER_ARTIFACT_PREFIX?: string;
	PLUGIN_RUNNER_DISABLED?: string;
};

export const LIMITS = {
	bodyBytes: 64_000,
	artifactBytes: 1_000_000,
	outputBytes: 900_000,
	hostResponseBytes: 64_000,
	outboundResponseBytes: 25 * 1024 * 1024,
} as const;

export const DYNAMIC_WORKER_LIMITS = {
	cpuMs: 30_000,
	subRequests: 25,
} as const satisfies DynamicWorkerLimits;

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();
const COMPAT_DATE = "2026-07-01";
const ENTRY_MODULE = "bonobo-plugin-wrapper.js";
const PLUGIN_MODULE = "plugin.js";
const PLUGIN_WRAPPER_VERSION = "bonobo-host-v2";
const REQUEST_FIELDS = new Set([
	"pluginId",
	"pluginName",
	"pluginVersion",
	"artifactKey",
	"artifactHash",
	"pluginRunId",
	"input",
	"host",
	"acceptedCapabilities",
	"outboundOrigins",
]);

// Decrypted secret values tracked per run so run output and errors can be masked.
// This cannot live on the BonoboHost instance: the host is reached via a loopback binding
// and workerd constructs a new instance per RPC call, so per-instance state does not
// survive across host calls within one run. The loopback binding runs in the same isolate
// as handle_run, so module-level state is shared.
const RUN_SECRET_VALUES = new Map<string, Set<string>>();
// Values shorter than 6 chars are not masked because masking them would shred normal text
// on common short substrings (same threshold idea as GitHub Actions).
const MASK_MIN_SECRET_LENGTH = 6;

function track_run_secret_value(pluginRunId: string, value: string) {
	if (value.length < MASK_MIN_SECRET_LENGTH) return;
	let values = RUN_SECRET_VALUES.get(pluginRunId);
	if (!values) {
		values = new Set();
		RUN_SECRET_VALUES.set(pluginRunId, values);
	}
	values.add(value);
}

function mask_secret_values(text: string, values: ReadonlySet<string> | undefined): string {
	if (!values || values.size === 0) return text;
	let masked = text;
	for (const value of values) {
		masked = masked.split(value).join("***");
	}
	return masked;
}

const HOST_API_PATHS = {
	claimRunnerCall: "/api/internal/plugins/host/claim-runner-call",
	finishRunnerCall: "/api/internal/plugins/host/finish-runner-call",
	secretGet: "/api/internal/plugins/host/secret-get",
} as const;

const PLUGIN_WRAPPER_SOURCE = `import plugin from "${PLUGIN_MODULE}";
import { WorkerEntrypoint } from "cloudflare:workers";

export default class BonoboPluginEntrypoint extends WorkerEntrypoint {
  async fetch(request) {
    const host = this.env.BONOBO_RPC;
    const props = this.ctx.props;
    const pluginEnv = Object.freeze({
      BONOBO: Object.freeze({
        secrets: Object.freeze({
          get: (name) => host.secretGet({ pluginRunId: props.pluginRunId, host: props.host, name }),
        }),
        host: Object.freeze({ apiOrigin: props.host.origin, token: props.host.token }),
      }),
    });
    const pluginCtx = Object.freeze({ waitUntil: () => { throw new Error("Plugin waitUntil is not supported"); } });
    const fetchHandler = plugin && typeof plugin.fetch === "function" ? plugin.fetch.bind(plugin) : null;
    if (!fetchHandler) {
      return Response.json({ error: "Plugin default export must provide fetch()." }, { status: 500 });
    }
    return await fetchHandler(request, pluginEnv, pluginCtx);
  }
}
`;

function json_response(body: unknown, status: number): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function byte_length(value: string) {
	return TEXT_ENCODER.encode(value).length;
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
	return await constant_time_sha256_equal(header.slice(prefix.length), env.PLUGIN_RUNNER_SECRET);
}

async function sha256_hex(input: string): Promise<string> {
	return await sha256_hex_bytes(TEXT_ENCODER.encode(input));
}

async function sha256_hex_bytes(input: Uint8Array): Promise<string> {
	const bytes = new Uint8Array(input.byteLength);
	bytes.set(input);
	const digest = await crypto.subtle.digest("SHA-256", bytes.buffer);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

function is_record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitize_error(error: unknown): { name: string; message: string } {
	if (error && typeof error === "object") {
		const e = error as { name?: unknown; message?: unknown };
		return {
			name: typeof e.name === "string" ? e.name : "Error",
			// The plugin's own failure reason is forwarded for workspace admins; secret values the
			// run fetched are masked at the response site, and the host truncates to the same cap.
			message: typeof e.message === "string" && e.message ? e.message.slice(0, 500) : "Plugin execution failed",
		};
	}
	return { name: "Error", message: "Plugin execution failed" };
}

async function read_bounded_text(request: Request) {
	const reader = request.body?.getReader();
	if (!reader) return { ok: true as const, text: "" };

	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) break;

			size += next.value.byteLength;
			if (size > LIMITS.bodyBytes) {
				await reader.cancel();
				return { ok: false as const };
			}
			chunks.push(next.value);
		}
	} finally {
		reader.releaseLock();
	}

	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { ok: true as const, text: TEXT_DECODER.decode(bytes) };
}

async function read_r2_artifact(artifact: R2ObjectBody) {
	if (artifact.arrayBuffer) {
		const buffer = await artifact.arrayBuffer();
		const bytes = new Uint8Array(buffer);
		if (bytes.byteLength > LIMITS.artifactBytes) return { ok: false as const };
		return { ok: true as const, bytes, source: TEXT_DECODER.decode(bytes) };
	}
	if (artifact.text) {
		const source = await artifact.text();
		const bytes = TEXT_ENCODER.encode(source);
		if (bytes.byteLength > LIMITS.artifactBytes) return { ok: false as const };
		return { ok: true as const, bytes, source };
	}
	throw new Error("R2 artifact body is unreadable");
}

async function read_response_json_limited(response: Response) {
	const reader = response.body?.getReader();
	if (!reader) return null;

	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) break;

			size += next.value.byteLength;
			if (size > LIMITS.hostResponseBytes) {
				await reader.cancel();
				throw new Error("Host response too large");
			}
			chunks.push(next.value);
		}
	} finally {
		reader.releaseLock();
	}

	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	const text = TEXT_DECODER.decode(bytes);
	if (text.length === 0) return null;
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new Error("Host response was not valid JSON");
	}
}

async function response_text_limited(response: Response) {
	const text = await response.text();
	if (byte_length(text) > LIMITS.outputBytes) {
		return { text: text.slice(0, LIMITS.outputBytes), truncated: true };
	}
	return { text, truncated: false };
}

function validate_stable_id_part(value: unknown, field: string, maxLength: number) {
	if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
		return { ok: false as const, message: `${field} is required` };
	}
	if (!/^[A-Za-z0-9._@/-]+$/u.test(value) || value.includes(":")) {
		return { ok: false as const, message: `${field} is invalid` };
	}
	return { ok: true as const, value };
}

function validate_artifact_hash(value: unknown) {
	if (typeof value !== "string") {
		return { ok: false as const, message: "artifactHash is required" };
	}
	const match = /^sha256:([a-f0-9]{64})$/iu.exec(value);
	if (!match) {
		return { ok: false as const, message: "artifactHash must be sha256:<hex>" };
	}
	return { ok: true as const, value: `sha256:${match[1].toLowerCase()}` };
}

function validate_host_runtime(value: unknown) {
	if (!is_record(value)) {
		return { ok: false as const, message: "host is required" };
	}
	const originValue = value.origin;
	if (typeof originValue !== "string" || originValue.length === 0 || originValue.length > 2048) {
		return { ok: false as const, message: "host.origin is required" };
	}
	if (typeof value.token !== "string" || value.token.length === 0 || value.token.length > 4096) {
		return { ok: false as const, message: "host.token is required" };
	}

	let url: URL;
	try {
		url = new URL(originValue);
	} catch {
		return { ok: false as const, message: "host.origin is invalid" };
	}
	const localHost = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
	if (url.protocol !== "https:" && !(url.protocol === "http:" && localHost)) {
		return { ok: false as const, message: "host.origin must be HTTPS" };
	}
	return { ok: true as const, value: { origin: url.origin, token: value.token } satisfies HostRuntime };
}

function validate_accepted_capabilities(value: unknown) {
	if (value === undefined) return { ok: true as const, value: [] };
	if (!Array.isArray(value)) {
		return { ok: false as const, message: "acceptedCapabilities must be an array" };
	}
	const capabilities = [];
	for (const capability of value) {
		if (typeof capability !== "string" || capability.length === 0 || capability.length > 128) {
			return { ok: false as const, message: "acceptedCapabilities contains an invalid value" };
		}
		capabilities.push(capability);
	}
	return { ok: true as const, value: capabilities };
}

function validate_outbound_origins(value: unknown) {
	if (!Array.isArray(value)) {
		return { ok: false as const, message: "outboundOrigins must be an array" };
	}
	if (value.length > 32) {
		return { ok: false as const, message: "outboundOrigins contains too many entries" };
	}
	const origins = [];
	for (const origin of value) {
		if (typeof origin !== "string" || origin.length === 0 || origin.length > 256) {
			return { ok: false as const, message: "outboundOrigins contains an invalid value" };
		}
		let url: URL;
		try {
			url = new URL(origin);
		} catch {
			return { ok: false as const, message: "outboundOrigins contains an invalid value" };
		}
		// Each entry must be exactly an https origin: no path, userinfo, query, hash, or default port.
		if (url.protocol !== "https:" || url.origin !== origin) {
			return { ok: false as const, message: "outboundOrigins entries must be https origins" };
		}
		origins.push(origin);
	}
	return { ok: true as const, value: origins };
}

function validate_request_body(body: unknown) {
	if (!is_record(body)) {
		return { ok: false as const, status: 400, code: "invalid_request", message: "Request body must be an object" };
	}
	for (const key of Object.keys(body)) {
		if (!REQUEST_FIELDS.has(key)) {
			return { ok: false as const, status: 400, code: "invalid_request", message: `Unknown field: ${key}` };
		}
	}
	if (typeof body.pluginId !== "string" || body.pluginId.length === 0 || body.pluginId.length > 128) {
		return { ok: false as const, status: 400, code: "invalid_request", message: "pluginId is required" };
	}
	const pluginName = validate_stable_id_part(body.pluginName, "pluginName", 128);
	if (!pluginName.ok) {
		return { ok: false as const, status: 400, code: "invalid_request", message: pluginName.message };
	}
	const pluginVersion = validate_stable_id_part(body.pluginVersion, "pluginVersion", 64);
	if (!pluginVersion.ok) {
		return { ok: false as const, status: 400, code: "invalid_request", message: pluginVersion.message };
	}
	if (typeof body.artifactKey !== "string" || body.artifactKey.length === 0) {
		return { ok: false as const, status: 400, code: "invalid_request", message: "artifactKey is required" };
	}
	const artifactHash = validate_artifact_hash(body.artifactHash);
	if (!artifactHash.ok) {
		return { ok: false as const, status: 400, code: "invalid_request", message: artifactHash.message };
	}
	const pluginRunId = body.pluginRunId;
	if (typeof pluginRunId !== "string" || pluginRunId.length === 0 || pluginRunId.length > 128) {
		return { ok: false as const, status: 400, code: "invalid_request", message: "pluginRunId is required" };
	}
	const host = validate_host_runtime(body.host);
	if (!host.ok) {
		return { ok: false as const, status: 400, code: "invalid_request", message: host.message };
	}
	const acceptedCapabilities = validate_accepted_capabilities(body.acceptedCapabilities);
	if (!acceptedCapabilities.ok) {
		return { ok: false as const, status: 400, code: "invalid_request", message: acceptedCapabilities.message };
	}
	const outboundOrigins = validate_outbound_origins(body.outboundOrigins);
	if (!outboundOrigins.ok) {
		return { ok: false as const, status: 400, code: "invalid_request", message: outboundOrigins.message };
	}
	return {
		ok: true as const,
		body: {
			pluginId: body.pluginId,
			pluginName: pluginName.value,
			pluginVersion: pluginVersion.value,
			artifactKey: body.artifactKey,
			artifactHash: artifactHash.value,
			pluginRunId,
			input: body.input,
			host: host.value,
			acceptedCapabilities: acceptedCapabilities.value,
			outboundOrigins: outboundOrigins.value,
		},
	};
}

function log_plugin_execution(fields: Record<string, string | number | boolean>): void {
	console.log(JSON.stringify({ tag: "plugin_runner", ...fields }));
}

function build_plugin_stable_id(input: { pluginName: string; pluginVersion: string; artifactHash: string }) {
	return `plugin:${input.pluginName}@${input.pluginVersion}:${input.artifactHash}:${PLUGIN_WRAPPER_VERSION}`;
}

function build_plugin_event(input: unknown, pluginRunId: string) {
	if (is_record(input)) {
		return { ...input, pluginRunId };
	}
	return { pluginRunId, input: input ?? null };
}

function host_call_url(host: HostRuntime, path: string) {
	return new URL(path, host.origin).href;
}

function parse_host_call_context(value: unknown) {
	if (!is_record(value)) {
		throw new Error("Host call input must be an object");
	}
	const pluginRunId = value.pluginRunId;
	if (typeof pluginRunId !== "string" || pluginRunId.length === 0 || pluginRunId.length > 128) {
		throw new Error("Host call pluginRunId is invalid");
	}
	const host = validate_host_runtime(value.host);
	if (!host.ok) {
		throw new Error("Host call runtime is invalid");
	}
	return { pluginRunId, host: host.value };
}

function require_capability(acceptedCapabilities: string[], capability: string) {
	if (!acceptedCapabilities.includes(capability)) {
		throw new Error(`Missing capability: ${capability}`);
	}
}

async function post_host_json(input: {
	host: HostRuntime;
	path: string;
	token: string;
	pluginStableId: string;
	body: Record<string, unknown>;
}) {
	const response = await fetch(
		new Request(host_call_url(input.host, input.path), {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${input.token}`,
				"X-Bonobo-Plugin-Stable-Id": input.pluginStableId,
			},
			body: JSON.stringify(input.body),
		}),
	);
	const responseBody = await read_response_json_limited(response);
	if (!response.ok) {
		const code =
			is_record(responseBody) && is_record(responseBody.error) && typeof responseBody.error.code === "string"
				? responseBody.error.code
				: "host_error";
		const message =
			is_record(responseBody) && typeof responseBody.message === "string" && responseBody.message
				? responseBody.message
				: code;
		throw new Error(`Host API failed: ${message}`);
	}
	return responseBody;
}

async function claim_runner_call(input: {
	host: HostRuntime;
	pluginRunId: string;
	pluginStableId: string;
	operation: "outboundFetch";
	requestBytes: number;
}) {
	const result = await post_host_json({
		host: input.host,
		path: HOST_API_PATHS.claimRunnerCall,
		token: input.host.token,
		pluginStableId: input.pluginStableId,
		body: {
			pluginRunId: input.pluginRunId,
			operation: input.operation,
			requestBytes: input.requestBytes,
		},
	});
	if (!is_record(result) || typeof result.callId !== "string") {
		throw new Error("Host call claim response is invalid");
	}
	return result.callId;
}

async function finish_runner_call(input: {
	host: HostRuntime;
	pluginRunId: string;
	pluginStableId: string;
	callId: string;
	status: "succeeded" | "failed";
	errorMessage: string | null;
	requestBytes?: number;
	responseBytes?: number;
	responseStatus?: number;
}) {
	await post_host_json({
		host: input.host,
		path: HOST_API_PATHS.finishRunnerCall,
		token: input.host.token,
		pluginStableId: input.pluginStableId,
		body: {
			pluginRunId: input.pluginRunId,
			callId: input.callId,
			status: input.status,
			errorMessage: input.errorMessage,
			...(input.requestBytes === undefined ? {} : { requestBytes: input.requestBytes }),
			...(input.responseBytes === undefined ? {} : { responseBytes: input.responseBytes }),
			...(input.responseStatus === undefined ? {} : { responseStatus: input.responseStatus }),
		},
	});
}

export class BonoboHost extends WorkerEntrypoint<Env, BonoboHostProps> {
	async secretGet(input: unknown): Promise<unknown> {
		const { pluginRunId, host } = parse_host_call_context(input);
		require_capability(this.ctx.props.acceptedCapabilities, "plugin.secrets.read");
		if (!is_record(input)) throw new Error("Host call input must be an object");
		const name = input.name;
		if (typeof name !== "string" || name.length === 0 || name.length > 128) {
			throw new Error("secretGet.name is invalid");
		}
		const result = await post_host_json({
			host,
			path: HOST_API_PATHS.secretGet,
			token: host.token,
			pluginStableId: this.ctx.props.pluginStableId,
			body: {
				pluginRunId,
				name,
			},
		});
		if (!is_record(result) || (result.value !== null && typeof result.value !== "string")) {
			throw new Error("Host secret response is invalid");
		}
		if (typeof result.value === "string") {
			track_run_secret_value(pluginRunId, result.value);
		}
		return result.value;
	}
}

// The plugin's `globalOutbound` Fetcher: every plugin `fetch()` lands here. Host-origin requests
// pass through without claim/finish accounting (the host routes record their own run accounting);
// every other origin is gated on the `outbound.fetch` capability and the per-run origin allowlist.
export class BonoboOutbound extends WorkerEntrypoint<Env, BonoboOutboundProps> {
	async fetch(request: Request): Promise<Response> {
		const { pluginStableId, pluginRunId, host } = this.ctx.props;
		const url = new URL(request.url);
		if (url.origin === host.origin) {
			return await fetch(request);
		}
		require_capability(this.ctx.props.acceptedCapabilities, "outbound.fetch");
		if (url.protocol !== "https:") {
			throw new Error("Plugin fetch must use HTTPS");
		}
		if (!this.ctx.props.outboundOrigins.includes(url.origin)) {
			throw new Error("Plugin fetch origin is not allowed");
		}
		if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
			throw new Error("Plugin fetch method is invalid");
		}

		const requestBody = request.body ? new Uint8Array(await request.arrayBuffer()) : null;
		const requestBytes = requestBody ? requestBody.byteLength : 0;
		const callId = await claim_runner_call({
			host,
			pluginRunId,
			pluginStableId,
			operation: "outboundFetch",
			requestBytes,
		});
		try {
			const response = await fetch(
				new Request(url, {
					method: request.method,
					headers: request.headers,
					body: requestBody,
					redirect: "manual",
				}),
			);
			const bytes = new Uint8Array(await response.arrayBuffer());
			if (bytes.byteLength > LIMITS.outboundResponseBytes) {
				throw new Error("Plugin fetch response exceeds the size limit");
			}
			console.log(
				JSON.stringify({
					tag: "plugin_runner_outbound",
					pluginStableIdHash: (await sha256_hex(pluginStableId)).slice(0, 16),
					urlHash: (await sha256_hex(`${url.origin}${url.pathname}`)).slice(0, 16),
					bodyHash: requestBody ? (await sha256_hex_bytes(requestBody)).slice(0, 16) : null,
					status: response.status,
					bytes: bytes.byteLength,
				}),
			);
			await finish_runner_call({
				host,
				pluginRunId,
				pluginStableId,
				callId,
				status: "succeeded",
				errorMessage: null,
				requestBytes,
				responseBytes: bytes.byteLength,
				responseStatus: response.status,
			});
			const responseBody = response.status === 204 || response.status === 205 || response.status === 304 ? null : bytes;
			return new Response(responseBody, {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			});
		} catch (error) {
			await finish_runner_call({
				host,
				pluginRunId,
				pluginStableId,
				callId,
				status: "failed",
				errorMessage: "Outbound fetch failed",
				requestBytes,
			});
			throw error;
		}
	}
}

async function handle_run(request: Request, env: Env, ctx?: PluginRunnerContext) {
	const raw = await read_bounded_text(request);
	if (!raw.ok) {
		return json_response({ error: { code: "body_too_large", message: "Request body too large" } }, 413);
	}

	let body: unknown;
	try {
		body = JSON.parse(raw.text);
	} catch {
		return json_response({ error: { code: "invalid_json", message: "Invalid JSON" } }, 400);
	}

	const validated = validate_request_body(body);
	if (!validated.ok) {
		return json_response({ error: { code: validated.code, message: validated.message } }, validated.status);
	}

	const prefix = env.PLUGIN_RUNNER_ARTIFACT_PREFIX ?? "plugins/";
	if (!validated.body.artifactKey.startsWith(prefix)) {
		return json_response(
			{ error: { code: "invalid_artifact_key", message: "Artifact key is outside the plugin prefix" } },
			400,
		);
	}
	if (!ctx?.exports?.BonoboHost || !ctx.exports.BonoboOutbound) {
		return json_response({ error: { code: "misconfigured", message: "Runner entrypoint bindings are unavailable" } }, 503);
	}

	const startedAt = Date.now();
	const artifactKeyHash = await sha256_hex(validated.body.artifactKey);
	const pluginStableId = build_plugin_stable_id(validated.body);
	const pluginStableIdHash = await sha256_hex(pluginStableId);
	try {
		// The run token is plugin-visible via env.BONOBO.host.token, so mask it in outputs
		// exactly like secret values.
		track_run_secret_value(validated.body.pluginRunId, validated.body.host.token);
		const artifact = await env.PLUGIN_ARTIFACTS.get(validated.body.artifactKey);
		if (!artifact) {
			return json_response({ error: { code: "artifact_not_found", message: "Artifact not found" } }, 404);
		}

		const artifactRead = await read_r2_artifact(artifact);
		if (!artifactRead.ok) {
			return json_response({ error: { code: "artifact_too_large", message: "Artifact too large" } }, 413);
		}
		const actualArtifactHash = `sha256:${await sha256_hex_bytes(artifactRead.bytes)}`;
		if (actualArtifactHash !== validated.body.artifactHash) {
			return json_response({ error: { code: "artifact_hash_mismatch", message: "Artifact hash mismatch" } }, 400);
		}

		const hostBinding = ctx.exports.BonoboHost({
			props: {
				pluginStableId,
				acceptedCapabilities: validated.body.acceptedCapabilities,
			},
		});
		const outboundBinding = ctx.exports.BonoboOutbound({
			props: {
				pluginStableId,
				pluginRunId: validated.body.pluginRunId,
				host: validated.body.host,
				acceptedCapabilities: validated.body.acceptedCapabilities,
				outboundOrigins: validated.body.outboundOrigins,
			},
		});
		// The loader reuses workers with the same id, and this worker is built with run-specific
		// values inside (the run's host token, capabilities, and allowed outbound origins via
		// BONOBO_RPC and globalOutbound). If the id were shared across runs, a later run would
		// execute with an earlier run's token and permissions. So the id includes the run id:
		// one worker per run. Sharing is only safe once nothing run-specific is built in here.
		const worker = env.LOADER.get(`${pluginStableId}:${validated.body.pluginRunId}`, () => ({
			compatibilityDate: COMPAT_DATE,
			compatibilityFlags: ["nodejs_compat"],
			mainModule: ENTRY_MODULE,
			modules: {
				[ENTRY_MODULE]: PLUGIN_WRAPPER_SOURCE,
				[PLUGIN_MODULE]: artifactRead.source,
			},
			env: {
				BONOBO_RPC: hostBinding,
			},
			globalOutbound: outboundBinding,
			limits: DYNAMIC_WORKER_LIMITS,
		}));
		const pluginResponse = await worker
			.getEntrypoint(null, {
				props: {
					pluginRunId: validated.body.pluginRunId,
					host: validated.body.host,
					acceptedCapabilities: validated.body.acceptedCapabilities,
				},
				limits: DYNAMIC_WORKER_LIMITS,
			})
			.fetch(
				new Request("https://plugin.local/__bonobo/run", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(build_plugin_event(validated.body.input, validated.body.pluginRunId)),
				}),
			);
		const output = await response_text_limited(pluginResponse);
		const elapsedMs = Date.now() - startedAt;
		log_plugin_execution({
			pluginRunId: validated.body.pluginRunId,
			pluginId: validated.body.pluginId,
			artifactKeyHash: artifactKeyHash.slice(0, 16),
			pluginStableIdHash: pluginStableIdHash.slice(0, 16),
			status: pluginResponse.status,
			elapsedMs,
		});

		if (!pluginResponse.ok) {
			return json_response(
				{
					status: "errored",
					pluginRunId: validated.body.pluginRunId,
					pluginStatus: pluginResponse.status,
					elapsedMs,
					outputBytes: byte_length(output.text),
					outputTruncated: output.truncated,
					error: { name: "PluginResponseError", message: `Plugin returned status ${pluginResponse.status}` },
				},
				200,
			);
		}

		const maskedOutput = mask_secret_values(output.text, RUN_SECRET_VALUES.get(validated.body.pluginRunId));
		return json_response(
			{
				status: "succeeded",
				pluginRunId: validated.body.pluginRunId,
				pluginStatus: pluginResponse.status,
				elapsedMs,
				outputBytes: byte_length(maskedOutput),
				output: maskedOutput,
				outputTruncated: output.truncated,
			},
			200,
		);
	} catch (error) {
		const sanitized = sanitize_error(error);
		const elapsedMs = Date.now() - startedAt;
		log_plugin_execution({
			pluginRunId: validated.body.pluginRunId,
			pluginId: validated.body.pluginId,
			artifactKeyHash: artifactKeyHash.slice(0, 16),
			pluginStableIdHash: pluginStableIdHash.slice(0, 16),
			status: "errored",
			elapsedMs,
		});
		// Plugin-thrown names and messages are forwarded as-is, so any secret values the run
		// fetched must be masked before they leave the worker.
		const runSecretValues = RUN_SECRET_VALUES.get(validated.body.pluginRunId);
		return json_response(
			{
				status: "errored",
				pluginRunId: validated.body.pluginRunId,
				elapsedMs,
				error: {
					name: mask_secret_values(sanitized.name, runSecretValues),
					message: mask_secret_values(sanitized.message, runSecretValues),
				},
			},
			200,
		);
	} finally {
		RUN_SECRET_VALUES.delete(validated.body.pluginRunId);
	}
}

export async function handle_request(request: Request, env: Env, ctx?: PluginRunnerContext): Promise<Response> {
	const url = new URL(request.url);

	if (request.method === "GET" && url.pathname === "/health") {
		return json_response({ ok: true }, 200);
	}

	if (request.method === "POST" && url.pathname === "/internal/plugin-runner/run") {
		if (!(await is_authorized(request, env))) {
			return json_response({ error: { code: "unauthorized", message: "Unauthorized" } }, 401);
		}
		if (env.PLUGIN_RUNNER_DISABLED === "true") {
			return json_response({ error: { code: "disabled", message: "Plugin runner is disabled" } }, 503);
		}
		return await handle_run(request, env, ctx);
	}

	return json_response({ error: { code: "not_found", message: "Not found" } }, 404);
}

export default {
	fetch: handle_request,
};
