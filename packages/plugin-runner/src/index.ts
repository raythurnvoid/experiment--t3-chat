// Host Worker for Phase 0 plugin artifact execution.
//
// Security notes:
// - The plugin Dynamic Worker receives no platform `env`, bindings, R2 bucket, or host secrets.
// - Plugin `fetch()` goes through the `BonoboOutbound` Fetcher: host-origin requests pass through,
//   every other origin is gated on the `outbound.fetch` capability and the per-run origin allowlist.
// - Operational logs include only metadata, never artifact source, input, output, or secrets.
// - Auth uses `Authorization: Bearer <PLUGIN_RUNNER_SECRET>` for the Phase 0 internal endpoint.
// - Trusted runner-to-host calls (secret-get, outbound claim/finish) attach
//   `X-Bonobo-Runner-Authorization: Bearer <PLUGIN_RUNNER_HOST_SECRET>` alongside the run token.
//   The secret stays in the outer runner classes and never reaches the dynamic worker.

// Carries the ambient Cloudflare types along for programs that import this module's exported
// types (the host imports pluginRunnerApiSchema) without this package's tsconfig.
/// <reference path="./cloudflare-runtime.d.ts" />

import { WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";

import { Result } from "common/errors-as-values-utils.ts";
import { type api_schemas_BuildResponseSpecFromHandler } from "common/api-schemas.ts";
import { type cloudflare_workers_RouteHandlerArgs } from "common/cloudflare-workers.ts";

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
	// Host origin/token come from trusted props (set by the runner at binding construction), never
	// from RPC input, so the runner host secret can only ever be sent to the real host origin.
	pluginRunId: string;
	host: HostRuntime;
	acceptedCapabilities: string[];
};

type BonoboOutboundProps = {
	pluginStableId: string;
	// Kept for run identity even though outbound claim/finish bodies no longer carry it (the host
	// derives the run from the bearer run token).
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
	PLUGIN_RUNNER_HOST_SECRET: string;
	PLUGIN_RUNNER_ARTIFACT_PREFIX?: string;
	PLUGIN_RUNNER_DISABLED?: string;
};

export type pluginRunner_InvokeReply = {
	runId: string;
	pluginStatus: number;
	output: string;
};

export const LIMITS = {
	bodyBytes: 64_000,
	artifactBytes: 1_000_000,
	outputBytes: 16 * 1024 * 1024,
	responseBytes: 16 * 1024 * 1024,
	smallResponseBytes: 8 * 1024,
	metadataBytes: 2 * 1024,
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
const PLUGIN_WRAPPER_VERSION = "bonobo-host-v3";
const RESPONSE_BLOCK_BYTES = 64 * 1024;
const RESPONSE_TOO_LARGE = new Error("Plugin response exceeds the size limit");
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
	// A secret call that finishes after the deadline must not recreate the finished run's set.
	RUN_SECRET_VALUES.get(pluginRunId)?.add(value);
}

function mask_secret_values(text: string, values: ReadonlySet<string> | undefined): string {
	if (!values || values.size === 0) return text;
	let masked = text;
	for (const value of values) {
		masked = masked.replaceAll(value, "***");
	}
	return masked;
}

// Runner-only host routes. Calls authenticate with both the run token (`Authorization`) and the
// runner host secret (`X-Bonobo-Runner-Authorization`); the host derives the run from the bearer
// run token, so these request bodies carry no pluginRunId.
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
          get: (name) => host.secretGet({ name }),
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

function sanitize_error(error: unknown, secrets?: ReadonlySet<string>): { name: string; message: string } {
	if (error && typeof error === "object") {
		const e = error as { name?: unknown; message?: unknown };
		return {
			name: typeof e.name === "string" ? mask_secret_values(e.name, secrets).slice(0, 64) : "Error",
			// Mask before shortening, so a boundary cannot expose the first half of a secret.
			message:
				typeof e.message === "string" && e.message
					? mask_secret_values(e.message, secrets).slice(0, 500)
					: "Plugin execution failed",
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

function create_deadline(timeoutMs: number) {
	const controller = new AbortController();
	const error = new Error("Plugin response deadline exceeded");
	const expiresAt = Date.now() + timeoutMs;
	const timer = setTimeout(() => controller.abort(error), timeoutMs);
	const check = () => {
		if (Date.now() >= expiresAt) controller.abort(error);
		controller.signal.throwIfAborted();
	};

	return {
		signal: controller.signal,
		check,
		clear: () => clearTimeout(timer),
		async wait<T>(operation: Promise<T>) {
			let onAbort = () => {};
			const aborted = new Promise<never>((_resolve, reject) => {
				onAbort = () => reject(error);
				controller.signal.addEventListener("abort", onAbort, { once: true });
			});
			try {
				// One listener per current read, not one retained reaction per chunk on a shared promise.
				if (controller.signal.aborted) onAbort();
				const value = await Promise.race([operation, aborted]);
				check();
				return value;
			} finally {
				controller.signal.removeEventListener("abort", onAbort);
			}
		},
	};
}

async function read_plugin_response(
	response: Response,
	keepText: boolean,
	deadline: ReturnType<typeof create_deadline>,
	metrics: { outputBytes: number },
) {
	const reader = response.body?.getReader();
	if (!reader) return "";

	const decoder = new TextDecoder();
	const parts: string[] = [];
	const block = new Uint8Array(keepText ? RESPONSE_BLOCK_BYTES : 0);
	let filled = 0;
	let complete = false;
	try {
		for (;;) {
			const next = await deadline.wait(reader.read());
			if (next.done) {
				complete = true;
				break;
			}
			// This is raw output, before decoding or secret masking, including bytes read on failure.
			metrics.outputBytes += next.value.byteLength;
			if (metrics.outputBytes > LIMITS.outputBytes) throw RESPONSE_TOO_LARGE;
			if (!keepText) continue;

			let offset = 0;
			while (offset < next.value.byteLength) {
				const count = Math.min(block.byteLength - filled, next.value.byteLength - offset);
				block.set(next.value.subarray(offset, offset + count), filled);
				filled += count;
				offset += count;
				if (filled === block.byteLength) {
					parts.push(decoder.decode(block, { stream: true }));
					filled = 0;
				}
			}
		}
		if (keepText) parts.push(decoder.decode(block.subarray(0, filled)));
		return parts.join("");
	} finally {
		// Cancelling a plugin-controlled source may never settle. Do not extend the run to await it.
		if (!complete) void reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

function encode_invoke_reply(reply: pluginRunner_InvokeReply, deadline: ReturnType<typeof create_deadline>) {
	const blocks: Uint8Array[] = [];
	let block = new Uint8Array(RESPONSE_BLOCK_BYTES);
	let filled = 0;
	let totalBytes = 0;
	const append = (text: string) => {
		const bytes = TEXT_ENCODER.encode(text);
		// The public JSON cap includes escaping, field names, run ID, status, and punctuation.
		if (totalBytes + bytes.byteLength > LIMITS.responseBytes) throw RESPONSE_TOO_LARGE;
		totalBytes += bytes.byteLength;
		let offset = 0;
		while (offset < bytes.byteLength) {
			const count = Math.min(block.byteLength - filled, bytes.byteLength - offset);
			block.set(bytes.subarray(offset, offset + count), filled);
			filled += count;
			offset += count;
			if (filled === block.byteLength) {
				blocks.push(block);
				block = new Uint8Array(RESPONSE_BLOCK_BYTES);
				filled = 0;
			}
		}
	};

	append(`{"runId":${JSON.stringify(reply.runId)},"pluginStatus":${reply.pluginStatus},"output":"`);
	for (let start = 0; start < reply.output.length; ) {
		deadline.check();
		let end = Math.min(start + 16 * 1024, reply.output.length);
		const last = reply.output.charCodeAt(end - 1);
		const next = reply.output.charCodeAt(end);
		if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
		append(JSON.stringify(reply.output.slice(start, end)).slice(1, -1));
		start = end;
	}
	append('"}');
	if (filled > 0) blocks.push(block.subarray(0, filled));

	const bytes = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of blocks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	blocks.length = 0;
	deadline.check();
	return bytes;
}

function runner_refusal<const Status extends 400 | 401 | 404 | 413 | 503>(
	status: Status,
	name: string,
	message: string,
) {
	return {
		status,
		kind: "error" as const,
		// The general Result constructor drops extra error fields, including this wire's code.
		body: { _nay: { code: "runner_refused" as const, name, message: message.slice(0, 500) } },
	};
}

function runner_headers(
	kind: "invoke" | "event" | "error",
	bodyBytes: number,
	metrics?: { pluginRunId: string; elapsedMs: number; outputBytes: number; pluginStatus?: number },
) {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"X-Bonobo-Runner-Kind": kind,
		"X-Bonobo-Runner-Body-Bytes": String(bodyBytes),
	};
	if (metrics) {
		headers["X-Bonobo-Runner-Run-Id"] = metrics.pluginRunId;
		headers["X-Bonobo-Runner-Elapsed-Ms"] = String(metrics.elapsedMs);
		headers["X-Bonobo-Runner-Output-Bytes"] = String(metrics.outputBytes);
		if (metrics.pluginStatus !== undefined) headers["X-Bonobo-Runner-Plugin-Status"] = String(metrics.pluginStatus);
	}
	return headers;
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

const RUN_REQUEST_SCHEMA = z
	.strictObject({
		pluginId: z
			.string({ error: "pluginId is required" })
			.min(1, "pluginId is required")
			.max(128, "pluginId is required"),
		pluginName: z
			.string({ error: "pluginName is required" })
			.min(1, "pluginName is required")
			.max(128, "pluginName is required")
			.regex(/^[A-Za-z0-9._@/-]+$/u, "pluginName is invalid"),
		pluginVersion: z
			.string({ error: "pluginVersion is required" })
			.min(1, "pluginVersion is required")
			.max(100, "pluginVersion must be at most 100 characters")
			.regex(/^[A-Za-z0-9._@/+\-]+$/u, "pluginVersion is invalid"),
		artifactKey: z.string({ error: "artifactKey is required" }).min(1, "artifactKey is required"),
		artifactHash: z
			.string({ error: "artifactHash is required" })
			.regex(/^sha256:[a-f0-9]{64}$/iu, "artifactHash must be sha256:<hex>")
			.transform((value) => value.toLowerCase()),
		pluginRunId: z
			.string({ error: "pluginRunId is required" })
			.min(1, "pluginRunId is required")
			.max(128, "pluginRunId is required")
			.regex(/^[\x21-\x7e]+$/u, "pluginRunId must be visible ASCII"),
		responseMode: z.enum(["invoke", "event"], { error: "responseMode must be invoke or event" }),
		timeoutMs: z.number({ error: "timeoutMs must be a positive integer" }).int().positive(),
		/**
		 * The path the plugin's fetch handler sees. Absent for host event runs, which keep the
		 * reserved default below. Simple segments exclude that prefix and URL rewrites.
		 * Keep the endpoint grammar in sync with packages/app/shared/plugins.ts.
		 */
		requestPath: z
			.string({ error: "requestPath is invalid" })
			.max(256, "requestPath is invalid")
			.regex(/^\/(?:[a-z0-9-]+(?:\/[a-z0-9-]+)*)?$/u, "requestPath is invalid")
			.optional(),
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
	})
	.superRefine((value, ctx) => {
		if (value.timeoutMs > (value.responseMode === "invoke" ? 35_000 : 180_000)) {
			ctx.addIssue({ code: "custom", message: "timeoutMs exceeds the response mode's budget" });
		}
	});

// Messages come from the curated strings attached to the schema; never pass zod default text
// through — runner errors are persisted by the host and must not echo received values.
function validation_error_message(error: z.ZodError): string {
	const issue = error.issues[0];
	if (!issue) return "Request body is invalid";
	if (issue.code === "unrecognized_keys") return "Request body contains unknown fields";
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

function require_capability(acceptedCapabilities: string[], capability: string) {
	if (!acceptedCapabilities.includes(capability)) {
		throw new Error(`Missing capability: ${capability}`);
	}
}

async function post_host_json(input: {
	host: HostRuntime;
	path: string;
	token: string;
	runnerHostSecret: string;
	pluginStableId: string;
	body: Record<string, unknown>;
}) {
	const response = await fetch(
		new Request(host_call_url(input.host, input.path), {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${input.token}`,
				"X-Bonobo-Runner-Authorization": `Bearer ${input.runnerHostSecret}`,
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

// The claim route brackets exactly one outbound fetch, so the host's strict body validator
// accepts only `requestBytes` — the call kind is fixed server-side, and any extra field is a
// 400. The claimed call id settles later through finish_runner_call.
async function claim_runner_call(input: {
	host: HostRuntime;
	runnerHostSecret: string;
	pluginStableId: string;
	requestBytes: number;
}) {
	const result = await post_host_json({
		host: input.host,
		path: HOST_API_PATHS.claimRunnerCall,
		token: input.host.token,
		runnerHostSecret: input.runnerHostSecret,
		pluginStableId: input.pluginStableId,
		body: {
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
	runnerHostSecret: string;
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
		runnerHostSecret: input.runnerHostSecret,
		pluginStableId: input.pluginStableId,
		body: {
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
		const { pluginRunId, host } = this.ctx.props;
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
			runnerHostSecret: this.env.PLUGIN_RUNNER_HOST_SECRET,
			pluginStableId: this.ctx.props.pluginStableId,
			body: {
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
		const { pluginStableId, host } = this.ctx.props;
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
			runnerHostSecret: this.env.PLUGIN_RUNNER_HOST_SECRET,
			pluginStableId,
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
				runnerHostSecret: this.env.PLUGIN_RUNNER_HOST_SECRET,
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
				runnerHostSecret: this.env.PLUGIN_RUNNER_HOST_SECRET,
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
					return runner_refusal(401, "unauthorized", "Unauthorized");
				}
				if (env.PLUGIN_RUNNER_DISABLED === "true") {
					return runner_refusal(503, "disabled", "Plugin runner is disabled");
				}

				const raw = await read_bounded_text(request);
				if (!raw.ok) {
					return runner_refusal(413, "body_too_large", "Request body too large");
				}

				let body: unknown;
				try {
					body = JSON.parse(raw.text);
				} catch {
					return runner_refusal(400, "invalid_json", "Invalid JSON");
				}

				const validated = RUN_REQUEST_SCHEMA.safeParse(body);
				if (!validated.success) {
					return runner_refusal(400, "invalid_request", validation_error_message(validated.error));
				}

				const prefix = env.PLUGIN_RUNNER_ARTIFACT_PREFIX ?? "plugins/";
				if (!validated.data.artifactKey.startsWith(prefix)) {
					return runner_refusal(400, "invalid_artifact_key", "Artifact key is outside the plugin prefix");
				}
				if (!ctx?.exports?.BonoboHost || !ctx.exports.BonoboOutbound) {
					return runner_refusal(503, "misconfigured", "Runner entrypoint bindings are unavailable");
				}

				const startedAt = Date.now();
				const deadline = create_deadline(validated.data.timeoutMs);
				const metrics: { pluginRunId: string; pluginStatus?: number; outputBytes: number } = {
					pluginRunId: validated.data.pluginRunId,
					outputBytes: 0,
				};
				try {
					// The run token is plugin-visible via env.BONOBO.host.token, so mask it in outputs
					// exactly like secret values.
					RUN_SECRET_VALUES.set(validated.data.pluginRunId, new Set());
					track_run_secret_value(validated.data.pluginRunId, validated.data.host.token);
					const artifactKeyHash = await deadline.wait(sha256_hex(validated.data.artifactKey));
					const pluginStableId = build_plugin_stable_id(validated.data);
					const pluginStableIdHash = await deadline.wait(sha256_hex(pluginStableId));
					const artifact = await deadline.wait(env.PLUGIN_ARTIFACTS.get(validated.data.artifactKey));
					if (!artifact) {
						return runner_refusal(404, "artifact_not_found", "Artifact not found");
					}

					const artifactRead = await deadline.wait(read_r2_artifact(artifact));
					if (!artifactRead.ok) {
						return runner_refusal(413, "artifact_too_large", "Artifact too large");
					}
					const actualArtifactHash = `sha256:${await deadline.wait(sha256_hex_bytes(artifactRead.bytes))}`;
					if (actualArtifactHash !== validated.data.artifactHash) {
						return runner_refusal(400, "artifact_hash_mismatch", "Artifact hash mismatch");
					}

					const hostBinding = ctx.exports.BonoboHost({
						props: {
							pluginStableId,
							pluginRunId: validated.data.pluginRunId,
							host: validated.data.host,
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
					deadline.check();
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
					const pluginResponse = await deadline.wait(
						Promise.resolve(
							worker
								.getEntrypoint(null, {
									props: {
										pluginRunId: validated.data.pluginRunId,
										host: validated.data.host,
										acceptedCapabilities: validated.data.acceptedCapabilities,
									},
									limits: DYNAMIC_WORKER_LIMITS,
								})
								.fetch(
									new Request(`https://plugin.local${validated.data.requestPath ?? "/__bonobo_senate/run"}`, {
										method: "POST",
										headers: { "Content-Type": "application/json" },
										body: JSON.stringify(build_plugin_event(validated.data.input, validated.data.pluginRunId)),
										signal: deadline.signal,
									}),
								),
						).then((response) => {
							try {
								deadline.check();
							} catch (error) {
								// A plugin may return after abort. Release its body without waiting on cleanup.
								void response.body?.cancel().catch(() => {});
								throw error;
							}
							return response;
						}),
					);
					if (pluginResponse.status < 200 || pluginResponse.status > 599) {
						void pluginResponse.body?.cancel().catch(() => {});
						throw new Error("Plugin response status is invalid");
					}
					metrics.pluginStatus = pluginResponse.status;
					const output = await read_plugin_response(
						pluginResponse,
						validated.data.responseMode === "invoke",
						deadline,
						metrics,
					);
					const body =
						validated.data.responseMode === "invoke"
							? encode_invoke_reply(
									{
										runId: validated.data.pluginRunId,
										pluginStatus: pluginResponse.status,
										output: mask_secret_values(output, RUN_SECRET_VALUES.get(validated.data.pluginRunId)),
									},
									deadline,
								)
							: null;
					deadline.check();
					const completedMetrics = {
						...metrics,
						pluginStatus: pluginResponse.status,
						elapsedMs: Date.now() - startedAt,
					};
					log_plugin_execution({
						pluginRunId: validated.data.pluginRunId,
						pluginId: validated.data.pluginId,
						artifactKeyHash: artifactKeyHash.slice(0, 16),
						pluginStableIdHash: pluginStableIdHash.slice(0, 16),
						status: pluginResponse.status,
						elapsedMs: completedMetrics.elapsedMs,
					});

					if (body) {
						return {
							status: 200,
							kind: "invoke",
							body,
							metrics: completedMetrics,
						} as const;
					}

					return {
						status: 200,
						kind: "event",
						body: Result({ _yay: completedMetrics }),
						metrics: completedMetrics,
					} as const;
				} catch (error) {
					const sanitized = sanitize_error(error, RUN_SECRET_VALUES.get(validated.data.pluginRunId));
					const elapsedMs = Date.now() - startedAt;
					log_plugin_execution({
						pluginRunId: validated.data.pluginRunId,
						pluginId: validated.data.pluginId,
						status: "errored",
						elapsedMs,
					});
					// Only runner-owned error identities choose these codes; plugin error names cannot.
					const code =
						error === RESPONSE_TOO_LARGE
							? "response_too_large"
							: deadline.signal.aborted
								? "response_timeout"
								: "execution_failed";
					const failedMetrics = { ...metrics, elapsedMs };
					return {
						status: 200,
						kind: "error",
						metrics: failedMetrics,
						body: {
							_nay: {
								code,
								...sanitized,
								data: failedMetrics,
							},
						},
					} as const;
				} finally {
					deadline.clear();
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

type RouteHandler = (typeof routes)["/health"]["GET"] | (typeof routes)["/internal/plugin-runner/run"]["POST"];

export default {
	async fetch(request: Request, env: Env, ctx?: PluginRunnerContext): Promise<Response> {
		const url = new URL(request.url);

		// @ts-expect-error arbitrary request strings can't index the literal-keyed routes table
		const handler: RouteHandler | undefined = routes[url.pathname]?.[request.method];
		const result = handler ? await handler({ request, env, ctx }) : runner_refusal(404, "not_found", "Not found");
		if (!("kind" in result)) return json_response(result.body, result.status);

		const bytes = result.body instanceof Uint8Array ? result.body : TEXT_ENCODER.encode(JSON.stringify(result.body));
		return new Response(bytes, {
			status: result.status,
			headers: runner_headers(result.kind, bytes.byteLength, "metrics" in result ? result.metrics : undefined),
		});
	},
};
