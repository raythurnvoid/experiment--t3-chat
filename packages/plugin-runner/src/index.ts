// Host Worker for Phase 0 plugin artifact execution.
//
// Security notes:
// - The plugin Dynamic Worker receives no platform `env`, bindings, R2 bucket, or host secrets.
// - `globalOutbound: null` makes plugin `fetch()` and `connect()` unavailable until explicit host APIs exist.
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
	generateText: (input: unknown) => Promise<unknown>;
	transcribeAudio: (input: unknown) => Promise<unknown>;
	sourceTemporaryUrl: (input: unknown) => Promise<unknown>;
	sourceBase64: (input: unknown) => Promise<unknown>;
	writeMarkdown: (input: unknown) => Promise<unknown>;
	secretGet: (input: unknown) => Promise<unknown>;
	outboundFetch: (input: unknown) => Promise<unknown>;
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

type WorkersAiBinding = {
	run: (model: string, input: Record<string, unknown>) => Promise<unknown>;
};

type BonoboHostProps = {
	pluginStableId: string;
	acceptedCapabilities: string[];
	outboundOrigins: string[];
};

type PluginRunnerContext = ExecutionContext & {
	readonly exports?: {
		readonly BonoboHost?: (options: { props: BonoboHostProps }) => BonoboHostBinding;
	};
};

export type Env = {
	LOADER: PluginWorkerLoader;
	PLUGIN_ARTIFACTS: R2BucketBinding;
	PLUGIN_RUNNER_SECRET: string;
	PLUGIN_RUNNER_ARTIFACT_PREFIX?: string;
	PLUGIN_RUNNER_DISABLED?: string;
	AI?: WorkersAiBinding;
};

export const LIMITS = {
	bodyBytes: 64_000,
	artifactBytes: 1_000_000,
	outputBytes: 900_000,
	hostResponseBytes: 64_000,
	outboundResponseBytes: 25 * 1024 * 1024,
	sourceBytes: 5 * 1024 * 1024,
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
const PLUGIN_WRAPPER_VERSION = "bonobo-host-v1";
const WORKERS_AI_VISION_MODEL = "@cf/moonshotai/kimi-k2.6";
const WORKERS_AI_SOURCE_IMAGE_BYTES = 5 * 1024 * 1024;
const WORKERS_AI_TRANSCRIPTION_MODEL = "@cf/openai/whisper-large-v3-turbo";
const WORKERS_AI_AUDIO_BYTES = 5 * 1024 * 1024;
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
	generateText: "/api/internal/plugins/host/generate-text",
	sourceTemporaryUrl: "/api/internal/plugins/host/source-temporary-url",
	secretGet: "/api/internal/plugins/host/secret-get",
	writeMarkdown: "/api/internal/plugins/host/write-markdown",
} as const;

const PLUGIN_WRAPPER_SOURCE = `import plugin from "${PLUGIN_MODULE}";
import { WorkerEntrypoint } from "cloudflare:workers";

function objectInput(input) {
  return input && typeof input === "object" && !Array.isArray(input) ? input : {};
}

export default class BonoboPluginEntrypoint extends WorkerEntrypoint {
  async fetch(request) {
    const host = this.env.BONOBO_HOST;
    const props = this.ctx.props;
    const bonobo = Object.freeze({
      files: Object.freeze({
        source: Object.freeze({
          temporaryUrl: (input) => host.sourceTemporaryUrl({ ...objectInput(input), pluginRunId: props.pluginRunId, host: props.host }),
          base64: (input) => host.sourceBase64({ ...objectInput(input), pluginRunId: props.pluginRunId, host: props.host }),
        }),
        writeMarkdown: (input) => host.writeMarkdown({ ...objectInput(input), pluginRunId: props.pluginRunId, host: props.host }),
      }),
      secrets: Object.freeze({
        get: (name) => host.secretGet({ pluginRunId: props.pluginRunId, host: props.host, name }),
      }),
      ai: Object.freeze({
        generateText: (input) => host.generateText({ ...objectInput(input), pluginRunId: props.pluginRunId, host: props.host }),
        transcribeAudio: (input) => host.transcribeAudio({ ...objectInput(input), pluginRunId: props.pluginRunId, host: props.host }),
      }),
      outbound: Object.freeze({
        fetch: (input) => host.outboundFetch({ ...objectInput(input), pluginRunId: props.pluginRunId, host: props.host }),
      }),
    });
    const pluginEnv = Object.freeze({
      BONOBO: bonobo,
      BONOBO_HOST: Object.freeze({
        generateText: (input) => host.generateText({ ...objectInput(input), pluginRunId: props.pluginRunId, host: props.host }),
        transcribeAudio: (input) => host.transcribeAudio({ ...objectInput(input), pluginRunId: props.pluginRunId, host: props.host }),
        sourceTemporaryUrl: (input) => host.sourceTemporaryUrl({ ...objectInput(input), pluginRunId: props.pluginRunId, host: props.host }),
        sourceBase64: (input) => host.sourceBase64({ ...objectInput(input), pluginRunId: props.pluginRunId, host: props.host }),
        writeMarkdown: (input) => host.writeMarkdown({ ...objectInput(input), pluginRunId: props.pluginRunId, host: props.host }),
        secretGet: (input) => host.secretGet({ ...objectInput(input), pluginRunId: props.pluginRunId, host: props.host }),
        outboundFetch: (input) => host.outboundFetch({ ...objectInput(input), pluginRunId: props.pluginRunId, host: props.host }),
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
			message: "Plugin execution failed",
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

function base64_to_bytes(value: string) {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

function bytes_to_base64(bytes: Uint8Array) {
	let binary = "";
	for (let offset = 0; offset < bytes.byteLength; offset += 8192) {
		const chunk = bytes.subarray(offset, offset + 8192);
		binary += String.fromCharCode(...chunk);
	}
	return btoa(binary);
}

function ai_text_response(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (!is_record(value)) return null;
	for (const key of ["response", "result", "text"]) {
		const text = value[key];
		if (typeof text === "string" && text.length > 0) return text;
		if (is_record(text)) {
			const nestedText: string | null = ai_text_response(text);
			if (nestedText) return nestedText;
		}
	}
	const transcriptionInfo = value.transcription_info;
	if (is_record(transcriptionInfo)) {
		const text = transcriptionInfo.text;
		if (typeof text === "string" && text.length > 0) return text;
	}
	const segments = value.segments;
	if (Array.isArray(segments)) {
		const text = segments
			.map((segment) => (is_record(segment) && typeof segment.text === "string" ? segment.text.trim() : ""))
			.filter((segmentText) => segmentText.length > 0)
			.join("\n");
		if (text.length > 0) return text;
	}
	const vtt = value.vtt;
	if (typeof vtt === "string" && vtt.length > 0) {
		const text = vtt
			.split(/\r?\n/u)
			.map((line) => line.trim())
			.filter(
				(line) =>
					line.length > 0 &&
					line !== "WEBVTT" &&
					!/^\d+$/u.test(line) &&
					!/^\d{2}:\d{2}:\d{2}\.\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}\.\d{3}/u.test(line),
			)
			.join("\n");
		if (text.length > 0) return text;
	}
	const choices = value.choices;
	if (Array.isArray(choices)) {
		for (const choice of choices) {
			if (!is_record(choice) || !is_record(choice.message)) continue;
			const content = choice.message.content;
			if (typeof content === "string" && content.length > 0) return content;
		}
	}
	return null;
}

function image_content_type(value: string | null) {
	const contentType = value?.split(";")[0]?.trim().toLowerCase();
	if (
		contentType === "image/jpeg" ||
		contentType === "image/png" ||
		contentType === "image/webp" ||
		contentType === "image/gif"
	) {
		return contentType;
	}
	return "image/png";
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

type RunnerClaimedOperation = "generateText" | "transcribeAudio" | "outboundFetch";

async function claim_runner_call(input: {
	host: HostRuntime;
	pluginRunId: string;
	pluginStableId: string;
	operation: RunnerClaimedOperation;
	systemBytes?: number;
	promptBytes?: number;
	includeSourceImage?: boolean;
	maxOutputTokens?: number;
	requestBytes?: number;
}) {
	const result = await post_host_json({
		host: input.host,
		path: HOST_API_PATHS.claimRunnerCall,
		token: input.host.token,
		pluginStableId: input.pluginStableId,
		body: {
			pluginRunId: input.pluginRunId,
			operation: input.operation,
			...(input.systemBytes === undefined ? {} : { systemBytes: input.systemBytes }),
			...(input.promptBytes === undefined ? {} : { promptBytes: input.promptBytes }),
			...(input.includeSourceImage === undefined ? {} : { includeSourceImage: input.includeSourceImage }),
			...(input.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.maxOutputTokens }),
			...(input.requestBytes === undefined ? {} : { requestBytes: input.requestBytes }),
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
	modelId?: string;
	sourceBytes?: number;
	requestBytes?: number;
	responseBytes?: number;
	responseStatus?: number;
	outputTextBytes?: number;
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
			...(input.modelId === undefined ? {} : { modelId: input.modelId }),
			...(input.sourceBytes === undefined ? {} : { sourceBytes: input.sourceBytes }),
			...(input.requestBytes === undefined ? {} : { requestBytes: input.requestBytes }),
			...(input.responseBytes === undefined ? {} : { responseBytes: input.responseBytes }),
			...(input.responseStatus === undefined ? {} : { responseStatus: input.responseStatus }),
			...(input.outputTextBytes === undefined ? {} : { outputTextBytes: input.outputTextBytes }),
		},
	});
}

export class BonoboHost extends WorkerEntrypoint<Env, BonoboHostProps> {
	private async generateTextWithWorkersAiSourceImage(input: {
		pluginRunId: string;
		host: HostRuntime;
		system: string;
		prompt: string;
		maxOutputTokens?: number;
	}) {
		if (!this.env.AI) {
			return null;
		}
		require_capability(this.ctx.props.acceptedCapabilities, "ai.generateText");
		require_capability(this.ctx.props.acceptedCapabilities, "uploads.source.read");

		const sourceResult = await this.sourceTemporaryUrl({
			pluginRunId: input.pluginRunId,
			host: input.host,
			expiresInSeconds: 5 * 60,
		});
		if (!is_record(sourceResult) || typeof sourceResult.url !== "string") {
			throw new Error("Workers AI source URL is unavailable");
		}
		const sourceResponse = await fetch(sourceResult.url);
		if (!sourceResponse.ok) {
			throw new Error(`Workers AI source fetch returned HTTP ${sourceResponse.status}`);
		}
		const bytes = new Uint8Array(await sourceResponse.arrayBuffer());
		if (bytes.byteLength > WORKERS_AI_SOURCE_IMAGE_BYTES) {
			throw new Error("Workers AI source image exceeds the size limit");
		}

		const response = await this.env.AI.run(WORKERS_AI_VISION_MODEL, {
			messages: [
				{ role: "system", content: input.system },
				{
					role: "user",
					content: [
						{ type: "text", text: input.prompt },
						{
							type: "image_url",
							image_url: {
								url: `data:${image_content_type(sourceResponse.headers.get("Content-Type"))};base64,${bytes_to_base64(bytes)}`,
							},
						},
					],
				},
			],
			...(input.maxOutputTokens !== undefined ? { max_completion_tokens: input.maxOutputTokens } : {}),
			temperature: 0.2,
		});
		const text = ai_text_response(response);
		if (!text) {
			throw new Error("Workers AI returned no text");
		}
		return { text, sourceBytes: bytes.byteLength };
	}

	private async generateTextWithWorkersAiText(input: { system: string; prompt: string; maxOutputTokens?: number }) {
		if (!this.env.AI) {
			return null;
		}
		require_capability(this.ctx.props.acceptedCapabilities, "ai.generateText");

		const response = await this.env.AI.run(WORKERS_AI_VISION_MODEL, {
			messages: [
				{ role: "system", content: input.system },
				{ role: "user", content: input.prompt },
			],
			...(input.maxOutputTokens !== undefined ? { max_completion_tokens: input.maxOutputTokens } : {}),
			temperature: 0.2,
		});
		const text = ai_text_response(response);
		if (!text) {
			throw new Error("Workers AI returned no text");
		}
		return { text };
	}

	async generateText(input: unknown): Promise<unknown> {
		const { pluginRunId, host } = parse_host_call_context(input);
		if (!is_record(input)) throw new Error("Host call input must be an object");
		const system = input.system;
		const prompt = input.prompt;
		const includeSourceImage = input.includeSourceImage;
		const maxOutputTokens = input.maxOutputTokens;
		if (typeof system !== "string" || system.length === 0 || byte_length(system) > 16_000) {
			throw new Error("generateText.system is invalid");
		}
		if (typeof prompt !== "string" || prompt.length === 0 || byte_length(prompt) > 16_000) {
			throw new Error("generateText.prompt is invalid");
		}
		if (includeSourceImage !== undefined && typeof includeSourceImage !== "boolean") {
			throw new Error("generateText.includeSourceImage is invalid");
		}
		if (
			maxOutputTokens !== undefined &&
			(typeof maxOutputTokens !== "number" ||
				!Number.isInteger(maxOutputTokens) ||
				maxOutputTokens < 1 ||
				maxOutputTokens > 4_000)
		) {
			throw new Error("generateText.maxOutputTokens is invalid");
		}
		if (this.env.AI) {
			const callId = await claim_runner_call({
				host,
				pluginRunId,
				pluginStableId: this.ctx.props.pluginStableId,
				operation: "generateText",
				systemBytes: byte_length(system),
				promptBytes: byte_length(prompt),
				includeSourceImage,
				...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
			});
			try {
				const workersAiResult: { text: string; sourceBytes?: number } | null =
					includeSourceImage === true
						? await this.generateTextWithWorkersAiSourceImage({
								pluginRunId,
								host,
								system,
								prompt,
								...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
							})
						: await this.generateTextWithWorkersAiText({
								system,
								prompt,
								...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
							});
				if (workersAiResult) {
					await finish_runner_call({
						host,
						pluginRunId,
						pluginStableId: this.ctx.props.pluginStableId,
						callId,
						status: "succeeded",
						errorMessage: null,
						modelId: WORKERS_AI_VISION_MODEL,
						...(workersAiResult.sourceBytes !== undefined ? { sourceBytes: workersAiResult.sourceBytes } : {}),
						outputTextBytes: byte_length(workersAiResult.text),
					});
					return { text: workersAiResult.text };
				}
				throw new Error("Workers AI binding is unavailable");
			} catch (error) {
				await finish_runner_call({
					host,
					pluginRunId,
					pluginStableId: this.ctx.props.pluginStableId,
					callId,
					status: "failed",
					errorMessage: "Workers AI generateText failed",
					modelId: WORKERS_AI_VISION_MODEL,
				});
				throw error;
			}
		}
		return await post_host_json({
			host,
			path: HOST_API_PATHS.generateText,
			token: host.token,
			pluginStableId: this.ctx.props.pluginStableId,
			body: {
				pluginRunId,
				system,
				prompt,
				...(includeSourceImage !== undefined ? { includeSourceImage } : {}),
				...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
			},
		});
	}

	async sourceTemporaryUrl(input: unknown): Promise<unknown> {
		const { pluginRunId, host } = parse_host_call_context(input);
		if (!is_record(input)) throw new Error("Host call input must be an object");
		const expiresInSeconds = input.expiresInSeconds;
		if (
			expiresInSeconds !== undefined &&
			(typeof expiresInSeconds !== "number" ||
				!Number.isInteger(expiresInSeconds) ||
				expiresInSeconds < 1 ||
				expiresInSeconds > 15 * 60)
		) {
			throw new Error("sourceTemporaryUrl.expiresInSeconds is invalid");
		}
		return await post_host_json({
			host,
			path: HOST_API_PATHS.sourceTemporaryUrl,
			token: host.token,
			pluginStableId: this.ctx.props.pluginStableId,
			body: {
				pluginRunId,
				...(expiresInSeconds !== undefined ? { expiresInSeconds } : {}),
			},
		});
	}

	async sourceBase64(input: unknown): Promise<unknown> {
		require_capability(this.ctx.props.acceptedCapabilities, "uploads.source.read");
		if (!is_record(input)) throw new Error("Host call input must be an object");
		const maxBytesValue = input.maxBytes;
		const maxBytes =
			maxBytesValue === undefined
				? LIMITS.sourceBytes
				: typeof maxBytesValue === "number" && Number.isInteger(maxBytesValue) && maxBytesValue > 0
					? Math.min(maxBytesValue, LIMITS.sourceBytes)
					: null;
		if (maxBytes === null) {
			throw new Error("sourceBase64.maxBytes is invalid");
		}

		const urlResult = await this.sourceTemporaryUrl({
			...input,
			expiresInSeconds: 5 * 60,
		});
		if (!is_record(urlResult) || typeof urlResult.url !== "string") {
			throw new Error("Source temporary URL is unavailable");
		}
		const response = await fetch(urlResult.url);
		if (!response.ok) {
			throw new Error(`Source fetch returned HTTP ${response.status}`);
		}
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
			throw new Error("Source upload exceeds the size limit");
		}
		return {
			bodyBase64: bytes_to_base64(bytes),
			contentType: response.headers.get("Content-Type") ?? null,
			bytes: bytes.byteLength,
		};
	}

	async transcribeAudio(input: unknown): Promise<unknown> {
		const { pluginRunId, host } = parse_host_call_context(input);
		require_capability(this.ctx.props.acceptedCapabilities, "ai.transcribeAudio");
		if (!this.env.AI) {
			throw new Error("Workers AI binding is unavailable");
		}
		if (!is_record(input)) throw new Error("Host call input must be an object");
		const audioBase64 = input.audioBase64;
		const language = input.language;
		if (typeof audioBase64 !== "string" || audioBase64.length === 0) {
			throw new Error("transcribeAudio.audioBase64 is invalid");
		}
		const audioBytes = base64_to_bytes(audioBase64);
		if (audioBytes.byteLength === 0 || audioBytes.byteLength > WORKERS_AI_AUDIO_BYTES) {
			throw new Error("transcribeAudio.audioBase64 exceeds the size limit");
		}
		if (
			language !== undefined &&
			(typeof language !== "string" || !/^[A-Za-z]{2}(?:-[A-Za-z0-9]+)?$/u.test(language))
		) {
			throw new Error("transcribeAudio.language is invalid");
		}

		const callId = await claim_runner_call({
			host,
			pluginRunId,
			pluginStableId: this.ctx.props.pluginStableId,
			operation: "transcribeAudio",
			requestBytes: audioBytes.byteLength,
		});
		try {
			const response = await this.env.AI.run(WORKERS_AI_TRANSCRIPTION_MODEL, {
				audio: audioBase64,
				...(language !== undefined ? { language } : {}),
			});
			const text = ai_text_response(response);
			const responseRecord = is_record(response) ? response : null;
			console.log(
				JSON.stringify({
					tag: "plugin_runner_transcribe",
					pluginStableIdHash: (await sha256_hex(this.ctx.props.pluginStableId)).slice(0, 16),
					responseKeys: responseRecord ? Object.keys(responseRecord).sort().join(",") : typeof response,
					textLength: text?.trim().length ?? 0,
					segmentCount: Array.isArray(responseRecord?.segments) ? responseRecord.segments.length : 0,
					vttBytes: typeof responseRecord?.vtt === "string" ? byte_length(responseRecord.vtt) : 0,
				}),
			);
			await finish_runner_call({
				host,
				pluginRunId,
				pluginStableId: this.ctx.props.pluginStableId,
				callId,
				status: "succeeded",
				errorMessage: null,
				modelId: WORKERS_AI_TRANSCRIPTION_MODEL,
				requestBytes: audioBytes.byteLength,
				outputTextBytes: byte_length(text?.trim() ?? ""),
			});
			return { text: text?.trim() ?? "" };
		} catch (error) {
			await finish_runner_call({
				host,
				pluginRunId,
				pluginStableId: this.ctx.props.pluginStableId,
				callId,
				status: "failed",
				errorMessage: "Workers AI transcription failed",
				modelId: WORKERS_AI_TRANSCRIPTION_MODEL,
				requestBytes: audioBytes.byteLength,
			});
			throw error;
		}
	}

	async writeMarkdown(input: unknown): Promise<unknown> {
		const { pluginRunId, host } = parse_host_call_context(input);
		if (!is_record(input)) throw new Error("Host call input must be an object");
		const markdown = input.markdown;
		const path = input.path;
		const overwrite = input.overwrite;
		if (typeof markdown !== "string" || markdown.length === 0) {
			throw new Error("writeMarkdown.markdown is invalid");
		}
		if (byte_length(markdown) > LIMITS.outputBytes) {
			throw new Error("writeMarkdown.markdown exceeds the size limit");
		}
		if (path !== undefined && (typeof path !== "string" || path.length === 0 || path.length > 512)) {
			throw new Error("writeMarkdown.path is invalid");
		}
		if (overwrite !== undefined && overwrite !== "replace" && overwrite !== "fail") {
			throw new Error("writeMarkdown.overwrite is invalid");
		}
		return await post_host_json({
			host,
			path: HOST_API_PATHS.writeMarkdown,
			token: host.token,
			pluginStableId: this.ctx.props.pluginStableId,
			body: {
				pluginRunId,
				markdown,
				...(path !== undefined ? { path } : {}),
				...(overwrite !== undefined ? { overwrite } : {}),
			},
		});
	}

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

	async outboundFetch(input: unknown): Promise<unknown> {
		const { pluginRunId, host } = parse_host_call_context(input);
		require_capability(this.ctx.props.acceptedCapabilities, "outbound.fetch");
		if (!is_record(input)) throw new Error("Host call input must be an object");
		const urlValue = input.url;
		const methodValue = input.method;
		const headersValue = input.headers;
		const bodyText = input.bodyText;
		const bodyBase64 = input.bodyBase64;
		const responseType = input.responseType;
		if (typeof urlValue !== "string" || urlValue.length === 0 || urlValue.length > 4096) {
			throw new Error("outboundFetch.url is invalid");
		}
		let url: URL;
		try {
			url = new URL(urlValue);
		} catch {
			throw new Error("outboundFetch.url is invalid");
		}
		if (url.protocol !== "https:") {
			throw new Error("outboundFetch.url must be HTTPS");
		}
		if (!this.ctx.props.outboundOrigins.includes(url.origin)) {
			throw new Error("outboundFetch.url origin is not allowed");
		}
		const method = typeof methodValue === "string" && methodValue.length > 0 ? methodValue.toUpperCase() : "GET";
		if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
			throw new Error("outboundFetch.method is invalid");
		}
		const headers = new Headers();
		if (headersValue !== undefined) {
			if (!is_record(headersValue)) {
				throw new Error("outboundFetch.headers is invalid");
			}
			for (const [name, value] of Object.entries(headersValue)) {
				if (typeof value !== "string" || name.length === 0 || name.length > 128 || value.length > 16_000) {
					throw new Error("outboundFetch.headers is invalid");
				}
				headers.set(name, value);
			}
		}
		if (bodyText !== undefined && typeof bodyText !== "string") {
			throw new Error("outboundFetch.bodyText is invalid");
		}
		if (bodyBase64 !== undefined && typeof bodyBase64 !== "string") {
			throw new Error("outboundFetch.bodyBase64 is invalid");
		}
		if (bodyText !== undefined && bodyBase64 !== undefined) {
			throw new Error("outboundFetch body is ambiguous");
		}
		if (responseType !== undefined && responseType !== "text" && responseType !== "base64") {
			throw new Error("outboundFetch.responseType is invalid");
		}

		const requestBytes =
			bodyBase64 !== undefined
				? base64_to_bytes(bodyBase64).byteLength
				: bodyText !== undefined
					? byte_length(bodyText)
					: 0;
		const callId = await claim_runner_call({
			host,
			pluginRunId,
			pluginStableId: this.ctx.props.pluginStableId,
			operation: "outboundFetch",
			requestBytes,
		});
		try {
			const response = await fetch(
				new Request(url, {
					method,
					headers,
					body: bodyBase64 !== undefined ? base64_to_bytes(bodyBase64) : bodyText,
					redirect: "manual",
				}),
			);
			const bytes = new Uint8Array(await response.arrayBuffer());
			if (bytes.byteLength > LIMITS.outboundResponseBytes) {
				throw new Error("outboundFetch response exceeds the size limit");
			}
			console.log(
				JSON.stringify({
					tag: "plugin_runner_outbound",
					pluginStableIdHash: (await sha256_hex(this.ctx.props.pluginStableId)).slice(0, 16),
					urlHash: (await sha256_hex(`${url.origin}${url.pathname}`)).slice(0, 16),
					bodyHash:
						bodyText !== undefined
							? (await sha256_hex(bodyText)).slice(0, 16)
							: bodyBase64 !== undefined
								? (await sha256_hex(bodyBase64)).slice(0, 16)
								: null,
					status: response.status,
					bytes: bytes.byteLength,
				}),
			);
			await finish_runner_call({
				host,
				pluginRunId,
				pluginStableId: this.ctx.props.pluginStableId,
				callId,
				status: "succeeded",
				errorMessage: null,
				requestBytes,
				responseBytes: bytes.byteLength,
				responseStatus: response.status,
			});
			const contentType = response.headers.get("Content-Type") ?? "";
			const responseHeaders = {
				...(contentType ? { "Content-Type": contentType } : {}),
			};
			const shouldReturnText =
				responseType === "text" ||
				(responseType === undefined &&
					(contentType.startsWith("text/") || contentType.includes("json") || contentType.includes("xml")));
			return {
				status: response.status,
				ok: response.ok,
				headers: responseHeaders,
				...(shouldReturnText ? { bodyText: TEXT_DECODER.decode(bytes) } : { bodyBase64: bytes_to_base64(bytes) }),
			};
		} catch (error) {
			await finish_runner_call({
				host,
				pluginRunId,
				pluginStableId: this.ctx.props.pluginStableId,
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
	if (!ctx?.exports?.BonoboHost) {
		return json_response({ error: { code: "misconfigured", message: "BONOBO_HOST binding is unavailable" } }, 503);
	}

	const startedAt = Date.now();
	const artifactKeyHash = await sha256_hex(validated.body.artifactKey);
	const pluginStableId = build_plugin_stable_id(validated.body);
	const pluginStableIdHash = await sha256_hex(pluginStableId);
	try {
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
				outboundOrigins: validated.body.outboundOrigins,
			},
		});
		const worker = env.LOADER.get(pluginStableId, () => ({
			compatibilityDate: COMPAT_DATE,
			compatibilityFlags: ["nodejs_compat"],
			mainModule: ENTRY_MODULE,
			modules: {
				[ENTRY_MODULE]: PLUGIN_WRAPPER_SOURCE,
				[PLUGIN_MODULE]: artifactRead.source,
			},
			env: {
				BONOBO_HOST: hostBinding,
			},
			globalOutbound: null,
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
		// Defense in depth: sanitize_error genericizes messages, but a plugin can set
		// error.name to arbitrary text that could carry a secret.
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
