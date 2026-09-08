// The `/api/v1/plugin-backend/invoke` route.
//
// A plugin frame (page or file view) asks the host to run one of the plugin's declared backend
// endpoints and waits for the answer in the same request. The route proves the `plu_` session and
// its `backend:invoke` scope; `start_invoke_run` re-checks the installation, the capability, the
// endpoint, and the member's live membership in one transaction, because any of them can change
// between the token check and the run.
//
// The run doc created there is also the endpoint's serialization lock, and the per-run `plr_`
// token minted here is what the plugin uses to call back into `/api/v1/*` while it runs.

import { z } from "zod";

import { internal } from "./_generated/api.js";
import type { ActionCtx } from "./_generated/server.js";
import {
	plugins_runtime_execute_runner_request,
	type start_invoke_run_Result,
	type finish_event_run_Result,
} from "./plugins_runtime.ts";
import { public_api_authorize_request } from "./public_api_http_auth.ts";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";
import { crypto_random_hex, crypto_sha256_hex } from "../server/crypto-utils.ts";
import { plugins_parse_installation_configuration_yaml, type plugins_ConfigurationValue } from "../shared/plugins.ts";
import type { public_api_Scope } from "../shared/public-api.ts";

// 32 KiB. Smaller than the plugin-data routes' 64 KiB on purpose: the host wraps the page's
// input into the runner request together with the token, capability list, configuration, and
// origins, and the runner refuses its own body above 64,000 bytes. 32 KiB of input leaves room
// for that wrapper — but the headroom is smaller than it looks (JSON escaping can double a
// backslash-heavy 16 KiB configuration), so the exact wire body is still measured before the
// fetch. Do not raise this cap.
const INVOKE_REQUEST_MAX_BYTES = 32 * 1024;
// The 35-second runner budget leaves room within the 60-second run TTL.
// The finalizer still checks expiry before allowing a reply.
const INVOKE_RUNNER_TIMEOUT_MS = 35_000;

/**
 * Stop reading an invoke request as soon as it crosses this route's limit.
 */
async function read_request_text_bounded(request: Request, maxBytes: number) {
	if (!request.body) return "";
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let byteLength = 0;
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		byteLength += value.byteLength;
		if (byteLength > maxBytes) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}

	const bytes = new Uint8Array(byteLength);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

async function parse_request_json<T>(request: Request, schema: z.ZodSchema<T>, maxBytes: number) {
	const declaredBytes = Number(request.headers.get("content-length") ?? Number.NaN);
	if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
		return { _nay: { message: "Request body is too large" } } as const;
	}

	const bodyText = await read_request_text_bounded(request, maxBytes);
	if (bodyText === null) {
		return { _nay: { message: "Request body is too large" } } as const;
	}

	try {
		const parsed = schema.safeParse(JSON.parse(bodyText));
		if (parsed.error) {
			return { _nay: { message: "Request body validation failed" } } as const;
		}

		return { _yay: parsed.data } as const;
	} catch {
		return { _nay: { message: "Failed to parse request body as JSON" } } as const;
	}
}

const invoke_body_validator = z
	.object({
		endpoint: z.string().min(1).max(64),
		input: z.unknown().optional(),
		serializationKey: z.string().min(1).max(128).optional(),
	})
	.strict();

export type plugins_invoke_http_invoke_Body = z.infer<typeof invoke_body_validator>;

export async function plugins_invoke_http_invoke(
	ctx: ActionCtx,
	request: Request,
	path: "/api/v1/plugin-backend/invoke",
) {
	const auth = await public_api_authorize_request(ctx, request, {
		requiredScope: "backend:invoke" satisfies public_api_Scope,
		allowedKinds: ["plugin_ui"],
		route: path,
	});
	if (auth._nay) {
		return auth._nay;
	}
	const principal = auth._yay.principal;

	const body = await parse_request_json(request, invoke_body_validator, INVOKE_REQUEST_MAX_BYTES);
	if (body._nay) {
		return { status: 400, body: { message: body._nay.message } } as const;
	}

	// One member clicking through one plugin frame. Keyed by user and installation together, so
	// one busy frame cannot drain the member's invoke budget in every other plugin.
	const rateLimit = await rate_limiter_limit_by_key(ctx, {
		name: "plugins_backend_invoke",
		key: `${principal.userId}:${principal.installationId}`,
	});
	if (rateLimit) {
		return {
			status: 429,
			body: { message: rateLimit.message, retryAfterMs: rateLimit.retryAfterMs },
		} as const;
	}

	// The `plr_` prefix routes the token to the plugin-run arm of the public API resolver; the
	// complete token is hashed, so a leaked hash is useless without the prefix-bearing original.
	const apiToken = `plr_${crypto_random_hex(32)}`;
	const started = (await ctx.runMutation(internal.plugins_runtime.start_invoke_run, {
		organizationId: principal.organizationId,
		workspaceId: principal.workspaceId,
		installationId: principal.installationId,
		pluginVersionId: principal.pluginVersionId,
		serviceAccountId: principal.serviceAccountId,
		userId: principal.userId,
		endpointId: body._yay.endpoint,
		callerSerializationKey: body._yay.serializationKey ?? null,
		apiTokenHash: await crypto_sha256_hex(apiToken),
	})) as start_invoke_run_Result;
	if (started._nay) {
		if (started._nay.name === "busy") {
			return {
				status: 409,
				body: { message: started._nay.message, retryAfterMs: started._nay.data?.retryAfterMs ?? 0 },
			} as const;
		}

		const status =
			started._nay.message === "Permission denied"
				? (403 as const)
				: started._nay.message === "Not found" || started._nay.message === "Endpoint not found"
					? (404 as const)
					: (400 as const);
		return { status, body: { message: started._nay.message } } as const;
	}

	const runId = started._yay.pluginRun._id;
	const backendEntrypointFile = started._yay.version.backendEntrypointFile;
	// Unreachable: start_invoke_run already required the backend. Settle the run it created.
	if (!backendEntrypointFile) {
		await ctx.runMutation(internal.plugins_runtime.finish_event_run, {
			runId,
			outcome: { kind: "failed", errorMessage: "Plugin backend is missing" },
		});
		// Use 500 to avoid the deployed edge replacing 502 JSON error bodies.
		return { status: 500, body: { message: "Plugin backend failed", runId: String(runId), code: undefined } } as const;
	}

	let configuration: plugins_ConfigurationValue = null;
	if (started._yay.installation.configurationYaml !== null) {
		const parsed = plugins_parse_installation_configuration_yaml({
			configurationYaml: started._yay.installation.configurationYaml,
			events: started._yay.version.events,
		});
		if (parsed._nay) {
			await ctx.runMutation(internal.plugins_runtime.finish_event_run, {
				runId,
				outcome: { kind: "failed", errorMessage: parsed._nay.message },
			});
			return {
				status: 500,
				body: { message: "Plugin backend failed", runId: String(runId), code: undefined },
			} as const;
		}
		configuration = parsed._yay.configuration;
	}

	try {
		const runner = await plugins_runtime_execute_runner_request({
			timeoutMs: INVOKE_RUNNER_TIMEOUT_MS,
			responseMode: "invoke",
			// The plugin's own fetch handler routes on this path; the reserved default is only for
			// host event deliveries.
			requestPath: started._yay.endpointPath,
			version: started._yay.version,
			backendEntrypointFile,
			pluginRunId: runId,
			apiToken,
			acceptedCapabilities: started._yay.pluginRun.acceptedCapabilities,
			outboundOrigins: started._yay.outboundOrigins,
			// The event as the plugin sees it. actorUserId comes from the run record only: the host
			// verified that member's session, and nothing from the page body may impersonate it.
			// The page's input goes through untouched under invoke.input.
			input: {
				event: started._yay.pluginRun.event,
				eventId: started._yay.pluginRun.eventId,
				organizationId: String(started._yay.pluginRun.organizationId),
				workspaceId: String(started._yay.pluginRun.workspaceId),
				actorUserId: String(started._yay.pluginRun.actorUserId),
				configuration,
				source: null,
				invoke: {
					endpointId: body._yay.endpoint,
					serializationKey: body._yay.serializationKey ?? null,
					input: body._yay.input ?? null,
				},
			},
		});
		// Only body_too_large: the request never reached the runner. The route cap alone cannot
		// prove the wrapper fits, because the configuration's JSON form can outgrow its YAML
		// byte limit.
		if (runner._nay) {
			const message = "Invoke request is too large for this plugin configuration";
			await ctx.runMutation(internal.plugins_runtime.finish_event_run, {
				runId,
				outcome: { kind: "failed", errorMessage: message },
			});
			return { status: 413, body: { message } } as const;
		}

		const runnerResult = runner._yay.runnerResult;
		const runMetrics = runnerResult._nay ? runnerResult._nay.data : runnerResult._yay;

		// Hand over the raw facts; finish_event_run classifies success or failure, and freeing
		// the serialization lock is that same settle.
		const finished = (await ctx.runMutation(internal.plugins_runtime.finish_event_run, {
			runId,
			outcome: {
				kind: "runner_response",
				runnerOk: runner._yay.runnerOk,
				runnerHttpStatus: runner._yay.runnerHttpStatus,
				bodyStatus: runnerResult._nay ? "errored" : "succeeded",
				runnerErrorMessage: runnerResult._nay ? runnerResult._nay.message.slice(0, 500) : null,
				pluginStatus: runMetrics?.pluginStatus,
				runnerElapsedMs: runMetrics?.elapsedMs,
				runnerOutputBytes: runMetrics?.outputBytes,
				runnerOutputTruncated: false,
			},
		})) as finish_event_run_Result;

		if (runnerResult._nay || finished._nay || !finished._yay.canRelayResponse || runnerResult._yay.kind !== "invoke") {
			const code = runnerResult._nay?.code === "response_too_large" ? ("response_too_large" as const) : undefined;
			return {
				status: 500,
				body: {
					message: code ? "Plugin backend response was too large" : "Plugin backend failed",
					runId: String(runId),
					code,
				},
			} as const;
		}

		// The finalizer approved this exact complete reply. Keep its encoded bytes unchanged.
		return {
			status: 200,
			body: runnerResult._yay.body,
			headers: { "Cache-Control": "no-store", "Content-Type": "application/json" },
		} as const;
	} catch (error) {
		// A network error — or our own timeout aborting the fetch — still settles the run as
		// failed, which also frees the serialization lock.
		const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
		console.error("Plugin invoke run threw", {
			runId,
			errorMessage: error instanceof Error ? error.message : String(error),
		});
		await ctx.runMutation(internal.plugins_runtime.finish_event_run, {
			runId,
			outcome: {
				kind: "failed",
				errorMessage: timedOut ? "Plugin runner request timed out" : "Plugin runner request failed",
			},
		});
		return { status: 500, body: { message: "Plugin backend failed", runId: String(runId), code: undefined } } as const;
	}
}
