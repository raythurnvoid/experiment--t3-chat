// Host Worker for Phase 0 plugin artifact execution.
//
// Security notes:
// - The plugin Dynamic Worker receives no platform `env`, bindings, R2 bucket, or host secrets.
// - Plugin `fetch()` goes through the `BonoboOutbound` Fetcher: host-origin requests pass through,
//   every other origin is gated on the `outbound.fetch` capability and the per-run origin allowlist.
// - Operational logs include only metadata, never artifact source, input, output, or secrets.
// - Auth uses `Authorization: Bearer <PLUGIN_RUNNER_SECRET>` for the Phase 0 internal endpoint.

// Carries the ambient Cloudflare types along for programs that import this module's exported
// types (the host imports pluginRunnerApiSchema) without this package's tsconfig.
/// <reference path="./cloudflare-runtime.d.ts" />

import { WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";

import { Result } from "common/errors-as-values-utils.ts";
import { type api_schemas_BuildResponseSpecFromHandler } from "common/api-schemas.ts";
import {
	type cloudflare_workers_RouteHandler,
	type cloudflare_workers_RouteHandlerArgs,
} from "common/cloudflare-workers.ts";

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

const HOST_RUNTIME_SCHEMA = z
	.object(
		{
			origin: z
				.string({ error: "host.origin is required" })
				.min(1, "host.origin is required")
				.max(2048, "host.origin is required"),
			token: z
				.string({ error: "host.token is required" })
				.min(1, "host.token is required")
				.max(4096, "host.token is required"),
		},
		{ error: "host is required" },
	)
	.transform((value, ctx) => {
		let url: URL;
		try {
			url = new URL(value.origin);
		} catch {
			ctx.addIssue({ code: "custom", message: "host.origin is invalid" });
			return z.NEVER;
		}
		const localHost = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
		if (url.protocol !== "https:" && !(url.protocol === "http:" && localHost)) {
			ctx.addIssue({ code: "custom", message: "host.origin must be HTTPS" });
			return z.NEVER;
		}
		return { origin: url.origin, token: value.token } satisfies HostRuntime;
	});

const RUN_REQUEST_SCHEMA = z.strictObject({
	pluginId: z.string({ error: "pluginId is required" }).min(1, "pluginId is required").max(128, "pluginId is required"),
	pluginName: z
		.string({ error: "pluginName is required" })
		.min(1, "pluginName is required")
		.max(128, "pluginName is required")
		.regex(/^[A-Za-z0-9._@/-]+$/u, "pluginName is invalid"),
	pluginVersion: z
		.string({ error: "pluginVersion is required" })
		.min(1, "pluginVersion is required")
		.max(64, "pluginVersion is required")
		.regex(/^[A-Za-z0-9._@/-]+$/u, "pluginVersion is invalid"),
	artifactKey: z.string({ error: "artifactKey is required" }).min(1, "artifactKey is required"),
	artifactHash: z
		.string({ error: "artifactHash is required" })
		.regex(/^sha256:[a-f0-9]{64}$/iu, "artifactHash must be sha256:<hex>")
		.transform((value) => value.toLowerCase()),
	pluginRunId: z
		.string({ error: "pluginRunId is required" })
		.min(1, "pluginRunId is required")
		.max(128, "pluginRunId is required"),
	input: z.unknown(),
	host: HOST_RUNTIME_SCHEMA,
	acceptedCapabilities: z
		.array(
			z
				.string({ error: "acceptedCapabilities contains an invalid value" })
				.min(1, "acceptedCapabilities contains an invalid value")
				.max(128, "acceptedCapabilities contains an invalid value"),
			{ error: "acceptedCapabilities must be an array" },
		)
		.default([]),
	outboundOrigins: z
		.array(
			z
				.string({ error: "outboundOrigins contains an invalid value" })
				.min(1, "outboundOrigins contains an invalid value")
				.max(256, "outboundOrigins contains an invalid value"),
			{ error: "outboundOrigins must be an array" },
		)
		.max(32, "outboundOrigins contains too many entries")
		.superRefine((entries, ctx) => {
			for (const origin of entries) {
				let url: URL;
				try {
					url = new URL(origin);
				} catch {
					ctx.addIssue({ code: "custom", message: "outboundOrigins contains an invalid value" });
					return;
				}
				// Each entry must be exactly an https origin: no path, userinfo, query, hash, or default port.
				if (url.protocol !== "https:" || url.origin !== origin) {
					ctx.addIssue({ code: "custom", message: "outboundOrigins entries must be https origins" });
					return;
				}
			}
		}),
});

// Messages come from the curated strings attached to the schema; never pass zod default text
// through — runner errors are persisted by the host and must not echo received values.
function validation_error_message(error: z.ZodError): string {
	const issue = error.issues[0];
	if (!issue) return "Request body is invalid";
	if (issue.code === "unrecognized_keys") return `Unknown field: ${issue.keys[0]}`;
	if (issue.code === "invalid_type" && issue.path.length === 0) return "Request body must be an object";
	return issue.message;
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
	const host = HOST_RUNTIME_SCHEMA.safeParse(value.host);
	if (!host.success) {
		throw new Error("Host call runtime is invalid");
	}
	return { pluginRunId, host: host.data };
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

type RouteHandlerArgs = cloudflare_workers_RouteHandlerArgs<Env, PluginRunnerContext>;
type RouteHandler = cloudflare_workers_RouteHandler<Env, PluginRunnerContext>;

// This object is both the runtime dispatch table and the schema type source: each entry is the
// handler function with the request/response spec phantom-intersected onto its type (the spec
// fields don't exist at runtime, only the function does). Every response is inferred from its
// handler's literal status/body union.
//
// The schema is only as precise as the handlers, and nothing guards that precision: a status
// widened to number (e.g. threaded through a variable instead of returned `as const`) collapses
// the response spec into a numeric index, and an `any` body silently turns consumers' `satisfies`
// checks into no-ops. Keep statuses literal and bodies precisely typed.
const routes = {
	"/health": {
		GET: ((/* iife */) => {
			const handler = () => ({ status: 200, body: { ok: true } }) as const;
			return handler as typeof handler & {
				pathParams: {};
				searchParams: {};
				headers: {};
				body: never;
				response: api_schemas_BuildResponseSpecFromHandler<typeof handler>;
			};
		})(),
	},
	"/internal/plugin-runner/run": {
		POST: ((/* iife */) => {
			const handler = async ({ request, env, ctx }: RouteHandlerArgs) => {
				if (!(await is_authorized(request, env))) {
					return { status: 401, body: Result({ _nay: { name: "unauthorized", message: "Unauthorized" } }) } as const;
				}
				if (env.PLUGIN_RUNNER_DISABLED === "true") {
					return {
						status: 503,
						body: Result({ _nay: { name: "disabled", message: "Plugin runner is disabled" } }),
					} as const;
				}

				const raw = await read_bounded_text(request);
				if (!raw.ok) {
					return {
						status: 413,
						body: Result({ _nay: { name: "body_too_large", message: "Request body too large" } }),
					} as const;
				}

				let body: unknown;
				try {
					body = JSON.parse(raw.text);
				} catch {
					return { status: 400, body: Result({ _nay: { name: "invalid_json", message: "Invalid JSON" } }) } as const;
				}

				const validated = RUN_REQUEST_SCHEMA.safeParse(body);
				if (!validated.success) {
					return {
						status: 400,
						body: Result({ _nay: { name: "invalid_request", message: validation_error_message(validated.error) } }),
					} as const;
				}

				const prefix = env.PLUGIN_RUNNER_ARTIFACT_PREFIX ?? "plugins/";
				if (!validated.data.artifactKey.startsWith(prefix)) {
					return {
						status: 400,
						body: Result({
							_nay: { name: "invalid_artifact_key", message: "Artifact key is outside the plugin prefix" },
						}),
					} as const;
				}
				if (!ctx?.exports?.BonoboHost || !ctx.exports.BonoboOutbound) {
					return {
						status: 503,
						body: Result({ _nay: { name: "misconfigured", message: "Runner entrypoint bindings are unavailable" } }),
					} as const;
				}

				const startedAt = Date.now();
				const artifactKeyHash = await sha256_hex(validated.data.artifactKey);
				const pluginStableId = build_plugin_stable_id(validated.data);
				const pluginStableIdHash = await sha256_hex(pluginStableId);
				try {
					// The run token is plugin-visible via env.BONOBO.host.token, so mask it in outputs
					// exactly like secret values.
					track_run_secret_value(validated.data.pluginRunId, validated.data.host.token);
					const artifact = await env.PLUGIN_ARTIFACTS.get(validated.data.artifactKey);
					if (!artifact) {
						return {
							status: 404,
							body: Result({ _nay: { name: "artifact_not_found", message: "Artifact not found" } }),
						} as const;
					}

					const artifactRead = await read_r2_artifact(artifact);
					if (!artifactRead.ok) {
						return {
							status: 413,
							body: Result({ _nay: { name: "artifact_too_large", message: "Artifact too large" } }),
						} as const;
					}
					const actualArtifactHash = `sha256:${await sha256_hex_bytes(artifactRead.bytes)}`;
					if (actualArtifactHash !== validated.data.artifactHash) {
						return {
							status: 400,
							body: Result({ _nay: { name: "artifact_hash_mismatch", message: "Artifact hash mismatch" } }),
						} as const;
					}

					const hostBinding = ctx.exports.BonoboHost({
						props: {
							pluginStableId,
							acceptedCapabilities: validated.data.acceptedCapabilities,
						},
					});
					const outboundBinding = ctx.exports.BonoboOutbound({
						props: {
							pluginStableId,
							pluginRunId: validated.data.pluginRunId,
							host: validated.data.host,
							acceptedCapabilities: validated.data.acceptedCapabilities,
							outboundOrigins: validated.data.outboundOrigins,
						},
					});
					// The loader reuses workers with the same id, and this worker is built with run-specific
					// values inside (the run's host token, capabilities, and allowed outbound origins via
					// BONOBO_RPC and globalOutbound). If the id were shared across runs, a later run would
					// execute with an earlier run's token and permissions. So the id includes the run id:
					// one worker per run. Sharing is only safe once nothing run-specific is built in here.
					const worker = env.LOADER.get(`${pluginStableId}:${validated.data.pluginRunId}`, () => ({
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
								pluginRunId: validated.data.pluginRunId,
								host: validated.data.host,
								acceptedCapabilities: validated.data.acceptedCapabilities,
							},
							limits: DYNAMIC_WORKER_LIMITS,
						})
						.fetch(
							new Request("https://plugin.local/__bonobo/run", {
								method: "POST",
								headers: { "Content-Type": "application/json" },
								body: JSON.stringify(build_plugin_event(validated.data.input, validated.data.pluginRunId)),
							}),
						);
					const output = await response_text_limited(pluginResponse);
					const elapsedMs = Date.now() - startedAt;
					log_plugin_execution({
						pluginRunId: validated.data.pluginRunId,
						pluginId: validated.data.pluginId,
						artifactKeyHash: artifactKeyHash.slice(0, 16),
						pluginStableIdHash: pluginStableIdHash.slice(0, 16),
						status: pluginResponse.status,
						elapsedMs,
					});

					if (!pluginResponse.ok) {
						return {
							status: 200,
							body: Result({
								_nay: {
									name: "PluginResponseError",
									message: `Plugin returned status ${pluginResponse.status}`,
									data: {
										pluginRunId: validated.data.pluginRunId,
										pluginStatus: pluginResponse.status,
										elapsedMs,
										outputBytes: byte_length(output.text),
										outputTruncated: output.truncated,
									},
								},
							}),
						} as const;
					}

					const maskedOutput = mask_secret_values(output.text, RUN_SECRET_VALUES.get(validated.data.pluginRunId));
					return {
						status: 200,
						body: Result({
							_yay: {
								pluginRunId: validated.data.pluginRunId,
								pluginStatus: pluginResponse.status,
								elapsedMs,
								outputBytes: byte_length(maskedOutput),
								output: maskedOutput,
								outputTruncated: output.truncated,
							},
						}),
					} as const;
				} catch (error) {
					const sanitized = sanitize_error(error);
					const elapsedMs = Date.now() - startedAt;
					log_plugin_execution({
						pluginRunId: validated.data.pluginRunId,
						pluginId: validated.data.pluginId,
						artifactKeyHash: artifactKeyHash.slice(0, 16),
						pluginStableIdHash: pluginStableIdHash.slice(0, 16),
						status: "errored",
						elapsedMs,
					});
					// Plugin-thrown names and messages are forwarded as-is, so any secret values the run
					// fetched must be masked before they leave the worker.
					const runSecretValues = RUN_SECRET_VALUES.get(validated.data.pluginRunId);
					return {
						status: 200,
						body: Result({
							_nay: {
								name: mask_secret_values(sanitized.name, runSecretValues),
								message: mask_secret_values(sanitized.message, runSecretValues),
								data: {
									pluginRunId: validated.data.pluginRunId,
									elapsedMs,
									// The plugin threw instead of responding, so these metrics do not exist. The explicit
									// undefined keys (dropped by JSON.stringify) keep every _nay data the same shape in
									// the inferred wire type, so the host can read them off any failure.
									pluginStatus: undefined,
									outputBytes: undefined,
									outputTruncated: undefined,
								},
							},
						}),
					} as const;
				} finally {
					RUN_SECRET_VALUES.delete(validated.data.pluginRunId);
				}
			};
			return handler as typeof handler & {
				pathParams: {};
				searchParams: {};
				headers: { Authorization: string };
				body: z.input<typeof RUN_REQUEST_SCHEMA>;
				response: api_schemas_BuildResponseSpecFromHandler<typeof handler>;
			};
		})(),
	},
};

export type pluginRunnerApiSchema = typeof routes;

type RunnerRunResponses = pluginRunnerApiSchema["/internal/plugin-runner/run"]["POST"]["response"];

/**
 * Wire shape of the run endpoint's JSON body: _yay carries the run result, while _nay carries
 * the failure (with run metrics under data once the plugin ran). A plugin failure is still
 * HTTP 200 — non-200 means the runner itself refused or broke.
 */
type RunnerRunResult = RunnerRunResponses[keyof RunnerRunResponses]["body"];

export default {
	async fetch(request: Request, env: Env, ctx?: PluginRunnerContext): Promise<Response> {
		const url = new URL(request.url);

		// @ts-expect-error arbitrary request strings can't index the literal-keyed routes table
		const handler: RouteHandler | undefined = routes[url.pathname]?.[request.method];
		if (!handler) {
			return json_response(Result({ _nay: { name: "not_found", message: "Not found" } }) satisfies RunnerRunResult, 404);
		}

		const result = await handler({ request, env, ctx });
		return json_response(result.body, result.status);
	},
};
