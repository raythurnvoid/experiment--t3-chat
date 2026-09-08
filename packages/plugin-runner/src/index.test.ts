import { describe, expect, it, vi } from "vitest";

import { plugins_validate_manifest } from "../../app/shared/plugins.ts";
import worker, { BonoboHost, BonoboOutbound, DYNAMIC_WORKER_LIMITS, LIMITS, type Env } from "./index";

const URL_BASE = "https://plugin-runner.internal";
const DEFAULT_ARTIFACT_SOURCE = "export default { fetch: () => new Response('ok') };";
const DEFAULT_HOST = { origin: "https://app.example", token: "host-token" };
const TEXT_ENCODER = new TextEncoder();

async function sha256_artifact(source: string) {
	const digest = await crypto.subtle.digest("SHA-256", TEXT_ENCODER.encode(source));
	const hex = Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return `sha256:${hex}`;
}

function make_ctx(opts?: {
	hostBinding?: {
		secretGet: (input: unknown) => Promise<unknown>;
	};
	outboundBinding?: { fetch: (request: Request) => Promise<Response> };
	onHostProps?: (props: unknown) => void;
	onOutboundProps?: (props: unknown) => void;
}) {
	const hostBinding = opts?.hostBinding ?? {
		secretGet: async () => "secret-value",
	};
	const outboundBinding = opts?.outboundBinding ?? {
		fetch: async () => new Response("outbound-ok"),
	};
	return {
		waitUntil: () => {},
		exports: {
			BonoboHost: (options: { props: unknown }) => {
				opts?.onHostProps?.(options.props);
				return hostBinding;
			},
			BonoboOutbound: (options: { props: unknown }) => {
				opts?.onOutboundProps?.(options.props);
				return outboundBinding;
			},
		},
	};
}

function make_env(opts?: {
	secret?: string;
	hostSecret?: string;
	disabled?: boolean;
	artifactSource?: string | null;
	onGet?: (id: string) => void;
	onCode?: (code: Record<string, unknown>) => void;
	onEntrypoint?: (name: string | null | undefined, options: unknown) => void;
	onPluginRequest?: (request: Request) => Response | Promise<Response>;
}): Env {
	const artifactSource =
		opts && "artifactSource" in opts && opts.artifactSource !== undefined
			? opts.artifactSource
			: DEFAULT_ARTIFACT_SOURCE;
	return {
		PLUGIN_RUNNER_SECRET: opts?.secret ?? "test-secret",
		PLUGIN_RUNNER_HOST_SECRET: opts?.hostSecret ?? "test-host-secret",
		PLUGIN_RUNNER_DISABLED: opts?.disabled ? "true" : undefined,
		PLUGIN_RUNNER_ARTIFACT_PREFIX: "plugins/",
		PLUGIN_ARTIFACTS: {
			get: async () =>
				artifactSource === null
					? null
					: {
							text: async () => artifactSource,
						},
		},
		LOADER: {
			get: (id, getCode) => {
				opts?.onGet?.(id);
				const codePromise = Promise.resolve(getCode()).then((code) => {
					opts?.onCode?.(code as unknown as Record<string, unknown>);
					return code;
				});
				return {
					getEntrypoint: (name, options) => {
						opts?.onEntrypoint?.(name, options);
						return {
							fetch: async (request: Request) => {
								await codePromise;
								return opts?.onPluginRequest?.(request) ?? new Response("plugin-ok", { status: 201 });
							},
						};
					},
				};
			},
			load: () => {
				throw new Error("LOADER.load should not be called for plugin artifacts");
			},
		},
	};
}

async function make_run_body(opts?: { artifactSource?: string; body?: Record<string, unknown> }) {
	const artifactSource = opts?.artifactSource ?? DEFAULT_ARTIFACT_SOURCE;
	return JSON.stringify({
		pluginId: "media",
		pluginName: "media",
		pluginVersion: "0.1.0",
		artifactKey: "plugins/media.js",
		artifactHash: await sha256_artifact(artifactSource),
		pluginRunId: "run_123",
		responseMode: "invoke",
		timeoutMs: 35_000,
		host: DEFAULT_HOST,
		acceptedCapabilities: ["plugin.secrets.read", "outbound.fetch"],
		outboundOrigins: ["https://api.openai.com"],
		...(opts?.body ?? {}),
	});
}

function run_request(rawBody: string, headers: Record<string, string> = { Authorization: "Bearer test-secret" }) {
	return new Request(`${URL_BASE}/internal/plugin-runner/run`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: rawBody,
	});
}

function streamed_response(text: string, chunkBytes: number, status = 200) {
	const bytes = TEXT_ENCODER.encode(text);
	let offset = 0;
	return new Response(
		new ReadableStream<Uint8Array>({
			pull(controller) {
				if (offset === bytes.byteLength) {
					controller.close();
					return;
				}
				const end = Math.min(offset + chunkBytes, bytes.byteLength);
				controller.enqueue(bytes.subarray(offset, end));
				offset = end;
			},
		}),
		{ status },
	);
}

async function read_runner_response(response: Response) {
	const text = await response.text();
	const bodyBytes = TEXT_ENCODER.encode(text).byteLength;
	expect(response.headers.get("X-Bonobo-Runner-Body-Bytes")).toBe(String(bodyBytes));
	let metadataBytes = 0;
	for (const [name, value] of response.headers) {
		if (!name.startsWith("x-bonobo-runner-")) continue;
		expect(value).toMatch(/^[\x20-\x7e]*$/u);
		metadataBytes += name.length + value.length + 4;
	}
	expect(metadataBytes).toBeLessThanOrEqual(LIMITS.metadataBytes);
	if (response.headers.get("X-Bonobo-Runner-Kind") !== "invoke") {
		expect(bodyBytes).toBeLessThanOrEqual(LIMITS.smallResponseBytes);
	}
	return text;
}

function fetch_request(input: Parameters<typeof fetch>[0]) {
	return input instanceof Request ? input : new Request(input);
}

function mock_host_fetch(handler?: (request: Request) => Response | Promise<Response> | undefined) {
	const hostRequests: Request[] = [];
	const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
		const request = fetch_request(input);
		if (request.url.startsWith(DEFAULT_HOST.origin)) {
			hostRequests.push(request);
		}
		if (request.url === `${DEFAULT_HOST.origin}/api/internal/plugins/host/claim-runner-call`) {
			return new Response(JSON.stringify({ callId: "call_1" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		if (request.url === `${DEFAULT_HOST.origin}/api/internal/plugins/host/finish-runner-call`) {
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		const handled = await handler?.(request);
		if (handled) {
			return handled;
		}
		throw new Error(`unexpected fetch ${request.url}`);
	});
	return { fetchSpy, hostRequests };
}

describe("routing", () => {
	it("returns ok for GET /health", async () => {
		const res = await worker.fetch(new Request(`${URL_BASE}/health`), make_env());
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});

	it("returns 404 for unknown routes", async () => {
		const res = await worker.fetch(new Request(`${URL_BASE}/nope`), make_env());
		expect(res.status).toBe(404);
	});
});

describe("manifest contract", () => {
	const manifest = {
		schemaVersion: 1,
		name: "media",
		displayName: "Media",
		version: "0.1.0",
		description: "Runner contract fixture",
		compatibility: { bonoboPluginRuntime: "1" },
		events: [],
		capabilities: ["plugin.backend.invoke"],
		secrets: [],
		outboundOrigins: [],
		backend: {
			entry: "dist/worker.js",
			moduleName: "dist/worker.js",
			compatibilityDate: "2026-08-14",
			compatibilityFlags: [],
			endpoints: [{ id: "echo", path: "/echo" }],
		},
		files: [{ path: "dist/worker.js", sha256: `sha256:${"a".repeat(64)}`, bytes: 1, contentType: "text/javascript" }],
	};

	it.each([64, 65, 100, 101])("agrees on a %i-character version label", async (length) => {
		const version = `0.1.0-${"a".repeat(length - 6)}`;
		const accepted = length <= 100;
		const validated = plugins_validate_manifest({ ...manifest, version });
		expect(Boolean(validated._yay), validated._nay?.message).toBe(accepted);
		const response = await worker.fetch(
			run_request(await make_run_body({ body: { pluginVersion: version } })),
			make_env(),
			make_ctx(),
		);
		expect(response.status).toBe(accepted ? 200 : 400);
		if (!accepted) {
			expect((await response.json())._nay.message).toBe("pluginVersion must be at most 100 characters");
		}
	});

	it("runs a manifest version with build metadata", async () => {
		const version = "0.1.0+build.42";
		expect(plugins_validate_manifest({ ...manifest, version })._nay).toBeUndefined();
		const response = await worker.fetch(
			run_request(await make_run_body({ body: { pluginVersion: version } })),
			make_env(),
			make_ctx(),
		);
		expect(response.status).toBe(200);
	});

	it.each([
		["/", true],
		["/echo", true],
		["/messages/send", true],
		["/v1/send-message", true],
		[`/${"a".repeat(255)}`, true],
		[`/${"a".repeat(256)}`, false],
		["echo", false],
		["/Echo", false],
		["/echo/", false],
		["/echo//value", false],
		["/echo.json", false],
		["/echo%20value", false],
		["/echo%2Fvalue", false],
		["/%E2%98%83", false],
		["/caffè", false],
		["/echo\n", false],
		["/echo?query", false],
		["/echo#fragment", false],
		["//other/echo", false],
		["/a/../b", false],
		["/./run", false],
		["/__bonobo_senate/run", false],
		["/x/%2e%2e/__bonobo_senate/run", false],
		["/x/%2E%2E/__bonobo_senate/run", false],
		["/x/.%2e/__bonobo_senate/run", false],
		["/x\\..\\__bonobo_senate/run", false],
		["/%5F%5Fbonobo_senate/run", false],
		["/echo%", false],
		["/echo%GG", false],
		["/echo%C0%AF", false],
	] as const)("agrees on endpoint path %s: %s", async (path, accepted) => {
		const validated = plugins_validate_manifest({
			...manifest,
			backend: { ...manifest.backend, endpoints: [{ id: "echo", path }] },
		});
		expect(Boolean(validated._yay), validated._nay?.message).toBe(accepted);
		const seenUrls: string[] = [];
		const response = await worker.fetch(
			run_request(await make_run_body({ body: { requestPath: path } })),
			make_env({
				onPluginRequest: (request) => {
					seenUrls.push(request.url);
					return new Response("ok");
				},
			}),
			make_ctx(),
		);
		expect(response.status).toBe(accepted ? 200 : 400);
		expect(seenUrls).toEqual(accepted ? [`https://plugin.local${path}`] : []);
	});
});

describe("auth + kill switch", () => {
	it("rejects requests without a valid bearer token", async () => {
		const res = await worker.fetch(run_request(await make_run_body(), {}), make_env());
		expect(res.status).toBe(401);
	});

	it("rejects requests with the wrong bearer token", async () => {
		const res = await worker.fetch(run_request(await make_run_body(), { Authorization: "Bearer wrong" }), make_env());
		expect(res.status).toBe(401);
	});

	it("returns 503 when PLUGIN_RUNNER_DISABLED is set", async () => {
		const res = await worker.fetch(run_request(await make_run_body()), make_env({ disabled: true }));
		expect(res.status).toBe(503);
		expect((await res.json())._nay.name).toBe("disabled");
	});
});

describe("validation", () => {
	it.each([
		{ responseMode: undefined, timeoutMs: undefined },
		{ responseMode: undefined },
		{ timeoutMs: undefined },
		{ responseMode: "stream" },
		{ timeoutMs: 0 },
		{ timeoutMs: -1 },
		{ timeoutMs: 1.5 },
		{ timeoutMs: "35000" },
		{ timeoutMs: 35_001 },
		{ responseMode: "event", timeoutMs: 180_001 },
		{ pluginRunId: "run\n123" },
		{ pluginRunId: "run🦊" },
		{ unknownField: true },
	])("refuses invalid strict runner fields before loading: %j", async (body) => {
		const onGet = vi.fn();
		const response = await worker.fetch(run_request(await make_run_body({ body })), make_env({ onGet }), make_ctx());
		expect(response.status).toBe(400);
		expect(onGet).not.toHaveBeenCalled();
		expect(response.headers.get("X-Bonobo-Runner-Kind")).toBe("error");
		expect(response.headers.get("X-Bonobo-Runner-Run-Id")).toBeNull();
		expect(JSON.parse(await read_runner_response(response))._nay.code).toBe("runner_refused");
	});

	it("rejects invalid JSON", async () => {
		const res = await worker.fetch(run_request("{nope"), make_env());
		expect(res.status).toBe(400);
		expect((await res.json())._nay.name).toBe("invalid_json");
	});

	it("rejects a non-object body", async () => {
		const res = await worker.fetch(run_request(JSON.stringify([1, 2, 3])), make_env());
		expect(res.status).toBe(400);
		expect((await res.json())._nay.name).toBe("invalid_request");
	});

	it("requires artifactHash", async () => {
		const res = await worker.fetch(run_request(await make_run_body({ body: { artifactHash: undefined } })), make_env());
		expect(res.status).toBe(400);
		expect((await res.json())._nay.message).toContain("artifactHash");
	});

	it("requires outboundOrigins", async () => {
		const res = await worker.fetch(
			run_request(await make_run_body({ body: { outboundOrigins: undefined } })),
			make_env(),
		);
		expect(res.status).toBe(400);
		expect((await res.json())._nay.message).toContain("outboundOrigins");
	});

	it("rejects outboundOrigins entries that are not exact https origins", async () => {
		for (const outboundOrigins of [
			["https://modal.example/convert"],
			["http://modal.example"],
			"https://modal.example",
		]) {
			const res = await worker.fetch(run_request(await make_run_body({ body: { outboundOrigins } })), make_env());
			expect(res.status).toBe(400);
			expect((await res.json())._nay.message).toContain("outboundOrigins");
		}
	});

	it("rejects a malformed or reserved requestPath with curated messages", async () => {
		// Messages are curated: they must never echo the submitted value back.
		const cases = [
			{ requestPath: "echo", message: "requestPath is invalid" },
			{ requestPath: "/caffè", message: "requestPath is invalid" },
			{ requestPath: `/${"a".repeat(256)}`, message: "requestPath is invalid" },
			{ requestPath: "/__bonobo_senate/run", message: "requestPath is invalid" },
			{ requestPath: "/__bonobo_senate-extra", message: "requestPath is invalid" },
			// These spellings must not reach the host-event path when the runner builds its URL.
			{ requestPath: "/x/../__bonobo_senate/run", message: "requestPath is invalid" },
			{ requestPath: "/x/%2e%2e/__bonobo_senate/run", message: "requestPath is invalid" },
			{ requestPath: "/x/%2E%2E/__bonobo_senate/run", message: "requestPath is invalid" },
			{ requestPath: "/x/.%2e/__bonobo_senate/run", message: "requestPath is invalid" },
			{ requestPath: "/./run", message: "requestPath is invalid" },
			{ requestPath: "/x\\..\\__bonobo_senate/run", message: "requestPath is invalid" },
			{ requestPath: "/echo?query", message: "requestPath is invalid" },
			{ requestPath: "/echo#fragment", message: "requestPath is invalid" },
			{ requestPath: "//other/echo", message: "requestPath is invalid" },
			{ requestPath: "/echo%", message: "requestPath is invalid" },
			{ requestPath: "/echo%GG", message: "requestPath is invalid" },
			{ requestPath: "/echo%C0%AF", message: "requestPath is invalid" },
			{ requestPath: "/%5F%5Fbonobo_senate/run", message: "requestPath is invalid" },
			{ requestPath: "/%5f%5fbonobo_senate-extra", message: "requestPath is invalid" },
		];
		for (const { requestPath, message } of cases) {
			const res = await worker.fetch(
				run_request(await make_run_body({ body: { requestPath } })),
				make_env(),
				make_ctx(),
			);
			expect(res.status, requestPath).toBe(400);
			expect((await res.json())._nay.message).toBe(message);
		}
	});

	it("accepts a body of exactly the byte limit and refuses one byte more", async () => {
		// The body is pure ASCII, so byte length equals string length.
		const base = await make_run_body({ body: { input: "" } });
		const padding = "a".repeat(LIMITS.bodyBytes - base.length);

		const exact = await worker.fetch(
			run_request(await make_run_body({ body: { input: padding } })),
			make_env(),
			make_ctx(),
		);
		expect(exact.status).toBe(200);

		const oneOver = await worker.fetch(
			run_request(await make_run_body({ body: { input: `${padding}a` } })),
			make_env(),
			make_ctx(),
		);
		expect(oneOver.status).toBe(413);
		expect((await oneOver.json())._nay.name).toBe("body_too_large");
	});

	it("rejects an artifact key outside the configured prefix", async () => {
		const res = await worker.fetch(
			run_request(await make_run_body({ body: { artifactKey: "other/media.js" } })),
			make_env(),
		);
		expect(res.status).toBe(400);
		expect((await res.json())._nay.name).toBe("invalid_artifact_key");
	});

	it("returns 503 when ctx.exports does not provide BonoboHost", async () => {
		const res = await worker.fetch(run_request(await make_run_body()), make_env());
		expect(res.status).toBe(503);
		expect((await res.json())._nay.name).toBe("misconfigured");
	});

	it("returns 404 for a missing R2 object", async () => {
		const res = await worker.fetch(run_request(await make_run_body()), make_env({ artifactSource: null }), make_ctx());
		expect(res.status).toBe(404);
		expect((await res.json())._nay.name).toBe("artifact_not_found");
	});
});

describe("dynamic worker loading", () => {
	it("rejects artifact hash mismatches before calling the loader", async () => {
		const onGet = vi.fn();
		const res = await worker.fetch(
			run_request(
				await make_run_body({
					body: { artifactHash: await sha256_artifact("different source") },
				}),
			),
			make_env({ onGet }),
			make_ctx(),
		);
		expect(res.status).toBe(400);
		expect((await res.json())._nay.name).toBe("artifact_hash_mismatch");
		expect(onGet).not.toHaveBeenCalled();
	});

	it("loads immutable artifacts with LOADER.get, per-run isolate ids, limits, and runner bindings", async () => {
		const artifactSource = "SENTINEL_SOURCE";
		const artifactHash = await sha256_artifact(artifactSource);
		const hostBinding = {
			secretGet: async () => "secret-value",
		};
		const outboundBinding = { fetch: async () => new Response("outbound-ok") };
		let loaderId: string | undefined;
		let loaded: Record<string, unknown> | undefined;
		let entrypointOptions: unknown;
		let hostProps: unknown;
		let outboundProps: unknown;
		let pluginEvent: unknown;

		const res = await worker.fetch(
			run_request(
				await make_run_body({
					artifactSource,
					body: { input: { type: "files.upload.completed", source: { name: "photo.png" } } },
				}),
			),
			make_env({
				artifactSource,
				onGet: (id) => {
					loaderId = id;
				},
				onCode: (code) => {
					loaded = code;
				},
				onEntrypoint: (_name, options) => {
					entrypointOptions = options;
				},
				onPluginRequest: async (request) => {
					pluginEvent = await request.json();
					return new Response("plugin-ok", { status: 202 });
				},
			}),
			make_ctx({
				hostBinding,
				outboundBinding,
				onHostProps: (props) => {
					hostProps = props;
				},
				onOutboundProps: (props) => {
					outboundProps = props;
				},
			}),
		);

		expect(res.status).toBe(200);
		const pluginStableId = `plugin:media@0.1.0:${artifactHash}:bonobo-host-v3`;
		expect(loaderId).toBe(`${pluginStableId}:run_123`);
		expect(hostProps).toEqual({
			pluginStableId,
			pluginRunId: "run_123",
			host: DEFAULT_HOST,
			acceptedCapabilities: ["plugin.secrets.read", "outbound.fetch"],
		});
		expect(outboundProps).toEqual({
			pluginStableId,
			pluginRunId: "run_123",
			host: DEFAULT_HOST,
			acceptedCapabilities: ["plugin.secrets.read", "outbound.fetch"],
			outboundOrigins: ["https://api.openai.com"],
		});
		expect(loaded?.globalOutbound).toBe(outboundBinding);
		expect(loaded?.limits).toEqual(DYNAMIC_WORKER_LIMITS);
		expect((loaded?.env as Record<string, unknown>)?.BONOBO_RPC).toBe(hostBinding);
		expect((loaded?.modules as Record<string, string>)?.["plugin.js"]).toBe(artifactSource);
		expect((loaded?.modules as Record<string, string>)?.["bonobo-plugin-wrapper.js"]).toContain("secrets");
		// The wrapper forwards only the secret name; run identity/host must come from entrypoint props.
		expect((loaded?.modules as Record<string, string>)?.["bonobo-plugin-wrapper.js"]).toContain(
			"host.secretGet({ name })",
		);
		expect((loaded?.modules as Record<string, string>)?.["bonobo-plugin-wrapper.js"]).toContain("apiOrigin");
		expect((loaded?.modules as Record<string, string>)?.["bonobo-plugin-wrapper.js"]).not.toContain("writeMarkdown");
		expect((loaded?.modules as Record<string, string>)?.["bonobo-plugin-wrapper.js"]).not.toContain("sourceBase64");
		expect(entrypointOptions).toEqual({
			props: {
				pluginRunId: "run_123",
				host: DEFAULT_HOST,
				acceptedCapabilities: ["plugin.secrets.read", "outbound.fetch"],
			},
			limits: DYNAMIC_WORKER_LIMITS,
		});
		// The runner host secret is reachable only from the trusted outer classes: it must never be
		// baked into the dynamic worker's code, env, or entrypoint props.
		expect(JSON.stringify(loaded)).not.toContain("test-host-secret");
		expect(JSON.stringify(entrypointOptions)).not.toContain("test-host-secret");
		expect(pluginEvent).toEqual({
			type: "files.upload.completed",
			source: { name: "photo.png" },
			pluginRunId: "run_123",
		});
		const body = await res.json();
		expect(body).toEqual({ runId: "run_123", pluginStatus: 202, output: "plugin-ok" });
		expect(Number(res.headers.get("X-Bonobo-Runner-Elapsed-Ms"))).toBeGreaterThanOrEqual(0);
		expect(res.headers.get("X-Bonobo-Runner-Output-Bytes")).toBe(String("plugin-ok".length));
	});

	it("delivers requestPath to the plugin fetch handler and keeps the reserved default without one", async () => {
		const seenUrls: string[] = [];
		const env = make_env({
			onPluginRequest: (request) => {
				seenUrls.push(request.url);
				return new Response("plugin-ok", { status: 200 });
			},
		});

		const paths = ["/echo", "/", "/nested/echo", "/v1/send-message"];
		for (const requestPath of paths) {
			const withPath = await worker.fetch(run_request(await make_run_body({ body: { requestPath } })), env, make_ctx());
			expect(withPath.status, requestPath).toBe(200);
		}

		const withoutPath = await worker.fetch(run_request(await make_run_body()), env, make_ctx());
		expect(withoutPath.status).toBe(200);

		expect(seenUrls).toEqual([
			...paths.map((path) => `https://plugin.local${path}`),
			"https://plugin.local/__bonobo_senate/run",
		]);
	});

	it("keys the dynamic worker per run so a cached isolate never carries another run's bindings", async () => {
		const loaderIds: string[] = [];
		const env = make_env({ onGet: (id) => loaderIds.push(id) });
		for (const pluginRunId of ["run_a", "run_b"]) {
			const res = await worker.fetch(run_request(await make_run_body({ body: { pluginRunId } })), env, make_ctx());
			expect(res.status).toBe(200);
		}
		expect(loaderIds).toHaveLength(2);
		expect(loaderIds[0]).toContain(":run_a");
		expect(loaderIds[1]).toContain(":run_b");
		expect(loaderIds[0]).not.toBe(loaderIds[1]);
	});

	it("preserves a complete plugin HTTP error response", async () => {
		const res = await worker.fetch(
			run_request(await make_run_body()),
			make_env({
				onPluginRequest: async () => new Response("plugin failed", { status: 500 }),
			}),
			make_ctx(),
		);

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual({ runId: "run_123", pluginStatus: 500, output: "plugin failed" });
		expect(res.headers.get("X-Bonobo-Runner-Kind")).toBe("invoke");
	});

	it("does not log tokens, source, input, output, or raw artifact keys", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const artifactSource = "SENTINEL_SOURCE";
		try {
			await worker.fetch(
				run_request(
					await make_run_body({
						artifactSource,
						body: {
							artifactKey: "plugins/SECRET_ARTIFACT_KEY.js",
							host: { origin: "https://app.example", token: "SENTINEL_HOST_TOKEN" },
							input: { value: "SENTINEL_INPUT" },
						},
					}),
				),
				make_env({
					artifactSource,
					hostSecret: "SENTINEL_RUNNER_HOST_SECRET",
					onPluginRequest: async () => new Response("SENTINEL_OUTPUT"),
				}),
				make_ctx(),
			);
			const logs = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
			expect(logs).not.toContain("SENTINEL_SOURCE");
			expect(logs).not.toContain("SENTINEL_INPUT");
			expect(logs).not.toContain("SENTINEL_OUTPUT");
			expect(logs).not.toContain("SENTINEL_HOST_TOKEN");
			expect(logs).not.toContain("SENTINEL_RUNNER_HOST_SECRET");
			expect(logs).not.toContain("SECRET_ARTIFACT_KEY");
			expect(logs).toContain("plugin_runner");
		} finally {
			logSpy.mockRestore();
		}
	});
});

describe("runner responses", () => {
	it.each([200, 204, 400, 401, 403, 409, 500])(
		"returns a complete invoke response with plugin status %i",
		async (status) => {
			const output = status === 204 ? "" : 'A useful answer: "🦊"\n';
			const response = await worker.fetch(
				run_request(await make_run_body()),
				make_env({ onPluginRequest: () => new Response(status === 204 ? null : output, { status }) }),
				make_ctx(),
			);
			expect(response.status).toBe(200);
			expect(response.headers.get("X-Bonobo-Runner-Kind")).toBe("invoke");
			expect(response.headers.get("X-Bonobo-Runner-Run-Id")).toBe("run_123");
			expect(response.headers.get("X-Bonobo-Runner-Plugin-Status")).toBe(String(status));
			expect(response.headers.get("X-Bonobo-Runner-Elapsed-Ms")).toMatch(/^\d+$/u);
			expect(response.headers.get("X-Bonobo-Runner-Output-Bytes")).toBe(String(TEXT_ENCODER.encode(output).byteLength));
			expect(await read_runner_response(response)).toBe(
				JSON.stringify({ runId: "run_123", pluginStatus: status, output }),
			);
		},
	);

	it.each([204, 409, 500])("consumes an event response with status %i without returning its text", async (status) => {
		const output = status === 204 ? "" : "An event body has no consumer";
		const response = await worker.fetch(
			run_request(await make_run_body({ body: { responseMode: "event", timeoutMs: 180_000 } })),
			make_env({ onPluginRequest: () => new Response(status === 204 ? null : output, { status }) }),
			make_ctx(),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("X-Bonobo-Runner-Kind")).toBe("event");
		const body = JSON.parse(await read_runner_response(response));
		expect(body).toEqual({
			_yay: { pluginRunId: "run_123", pluginStatus: status, outputBytes: output.length, elapsedMs: expect.any(Number) },
		});
		expect(response.headers.get("X-Bonobo-Runner-Output-Bytes")).toBe(String(body._yay.outputBytes));
	});

	it("uses only runner-owned metadata", async () => {
		const response = await worker.fetch(
			run_request(await make_run_body()),
			make_env({
				onPluginRequest: () =>
					new Response("safe", {
						status: 409,
						headers: {
							"X-Bonobo-Runner-Kind": "error",
							"X-Bonobo-Runner-Run-Id": "forged",
							"X-Bonobo-Runner-Plugin-Status": "200",
							"X-Bonobo-Runner-Body-Bytes": "1",
							"X-Bonobo-Runner-Output-Bytes": "1",
							"X-Bonobo-Runner-Elapsed-Ms": "-1",
							"X-Bonobo-Runner-Other": "forged",
						},
					}),
			}),
			make_ctx(),
		);
		expect(response.headers.get("X-Bonobo-Runner-Kind")).toBe("invoke");
		expect(response.headers.get("X-Bonobo-Runner-Run-Id")).toBe("run_123");
		expect(response.headers.get("X-Bonobo-Runner-Plugin-Status")).toBe("409");
		expect(response.headers.get("X-Bonobo-Runner-Output-Bytes")).toBe("4");
		expect(response.headers.get("X-Bonobo-Runner-Other")).toBeNull();
		await read_runner_response(response);
	});

	it.each([
		{ pattern: "a", chunkBytes: 64 * 1024 },
		{ pattern: "🦊", chunkBytes: 65_535 },
		{ pattern: '"\\\n\u0000', chunkBytes: 64 * 1024 },
		{ pattern: "a", chunkBytes: 64 },
	])("accepts the exact encoded cap and refuses one byte more: %j", async ({ pattern, chunkBytes }) => {
		const overhead = JSON.stringify({ runId: "run_123", pluginStatus: 200, output: "" }).length;
		const encodedUnitBytes = TEXT_ENCODER.encode(JSON.stringify(pattern).slice(1, -1)).byteLength;
		const available = LIMITS.responseBytes - overhead;
		const output = pattern.repeat(Math.floor(available / encodedUnitBytes)) + "a".repeat(available % encodedUnitBytes);
		const expected = JSON.stringify({ runId: "run_123", pluginStatus: 200, output });
		expect(TEXT_ENCODER.encode(expected).byteLength).toBe(LIMITS.responseBytes);
		const requestBody = await make_run_body();
		const exact = await worker.fetch(
			run_request(requestBody),
			make_env({
				onPluginRequest: () => streamed_response(output, chunkBytes),
			}),
			make_ctx(),
		);
		expect(exact.headers.get("X-Bonobo-Runner-Kind")).toBe("invoke");
		expect(await read_runner_response(exact)).toBe(expected);

		const excess = await worker.fetch(
			run_request(requestBody),
			make_env({
				onPluginRequest: () => streamed_response(`${output}a`, chunkBytes),
			}),
			make_ctx(),
		);
		expect(excess.headers.get("X-Bonobo-Runner-Kind")).toBe("error");
		expect(JSON.parse(await read_runner_response(excess))._nay.code).toBe("response_too_large");
	});

	it("keeps Unicode whole across one-byte reads and JSON piece boundaries", async () => {
		const output = `${"a".repeat(16_383)}🦊é\ud800${"b".repeat(49_150)}🌿`;
		const decodedOutput = new TextDecoder().decode(TEXT_ENCODER.encode(output));
		const response = await worker.fetch(
			run_request(await make_run_body()),
			make_env({
				onPluginRequest: () => streamed_response(output, 1),
			}),
			make_ctx(),
		);
		expect(await read_runner_response(response)).toBe(
			JSON.stringify({ runId: "run_123", pluginStatus: 200, output: decodedOutput }),
		);
	});

	it("keeps live abort listeners bounded across many tiny reads", async () => {
		const originalAdd = AbortSignal.prototype.addEventListener;
		const originalRemove = AbortSignal.prototype.removeEventListener;
		const listeners = new WeakMap<AbortSignal, Set<EventListenerOrEventListenerObject>>();
		let maximum = 0;
		const addSpy = vi
			.spyOn(AbortSignal.prototype, "addEventListener")
			.mockImplementation(function (type, listener, options) {
				if (type === "abort" && listener) {
					let active = listeners.get(this);
					if (!active) {
						active = new Set();
						listeners.set(this, active);
					}
					active.add(listener);
					maximum = Math.max(maximum, active.size);
				}
				return originalAdd.call(this, type, listener, options);
			});
		const removeSpy = vi
			.spyOn(AbortSignal.prototype, "removeEventListener")
			.mockImplementation(function (type, listener, options) {
				if (type === "abort" && listener) listeners.get(this)?.delete(listener);
				return originalRemove.call(this, type, listener, options);
			});
		try {
			const output = "x".repeat(32_768);
			const response = await worker.fetch(
				run_request(await make_run_body()),
				make_env({
					onPluginRequest: () => streamed_response(output, 1),
				}),
				make_ctx(),
			);
			expect(JSON.parse(await read_runner_response(response)).output).toBe(output);
			// Allow the Request's own abort forwarding, but no retained listener for each completed read.
			expect(maximum).toBeGreaterThan(0);
			expect(maximum).toBeLessThanOrEqual(2);
		} finally {
			addSpy.mockRestore();
			removeSpy.mockRestore();
		}
	});

	it("accepts the raw event cap and cancels one byte over without waiting on source cleanup", async () => {
		const requestBody = await make_run_body({ body: { responseMode: "event", timeoutMs: 180_000 } });
		const exact = await worker.fetch(
			run_request(requestBody),
			make_env({
				onPluginRequest: () => new Response(new Uint8Array(LIMITS.outputBytes)),
			}),
			make_ctx(),
		);
		expect(exact.headers.get("X-Bonobo-Runner-Kind")).toBe("event");
		expect(JSON.parse(await read_runner_response(exact))._yay.outputBytes).toBe(LIMITS.outputBytes);

		const cancel = vi.fn(() => new Promise<void>(() => {}));
		const excess = await worker.fetch(
			run_request(requestBody),
			make_env({
				onPluginRequest: () =>
					new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								controller.enqueue(new Uint8Array(LIMITS.outputBytes + 1));
							},
							cancel,
						}),
					),
			}),
			make_ctx(),
		);
		expect(cancel).toHaveBeenCalledOnce();
		expect(JSON.parse(await read_runner_response(excess))._nay).toMatchObject({
			code: "response_too_large",
			data: { outputBytes: LIMITS.outputBytes + 1 },
		});
	});

	it.each(["invoke", "event"])("fails a broken %s body after its headers arrived", async (responseMode) => {
		let pulls = 0;
		const response = await worker.fetch(
			run_request(await make_run_body({ body: { responseMode } })),
			make_env({
				onPluginRequest: () =>
					new Response(
						new ReadableStream<Uint8Array>({
							pull(controller) {
								if (pulls++ === 0) controller.enqueue(TEXT_ENCODER.encode("partial"));
								else controller.error(new Error("stream broke"));
							},
						}),
					),
			}),
			make_ctx(),
		);
		expect(response.headers.get("X-Bonobo-Runner-Kind")).toBe("error");
		expect(JSON.parse(await read_runner_response(response))._nay).toMatchObject({
			code: "execution_failed",
			message: "stream broke",
		});
	});

	it.each(["response_too_large", "response_timeout"])("does not trust a plugin-thrown %s error code", async (name) => {
		const response = await worker.fetch(
			run_request(await make_run_body()),
			make_env({
				onPluginRequest: () => {
					throw Object.assign(new Error("plugin failure"), { name, code: name });
				},
			}),
			make_ctx(),
		);
		expect(JSON.parse(await read_runner_response(response))._nay).toMatchObject({ code: "execution_failed", name });
	});

	it.each(["invoke", "event"])(
		"times out a never-ending %s body and does not await cancellation",
		async (responseMode) => {
			const requestBody = await make_run_body({ body: { responseMode, timeoutMs: 100 } });
			const cancel = vi.fn(() => new Promise<void>(() => {}));
			let entered = () => {};
			const reading = new Promise<void>((resolve) => {
				entered = resolve;
			});
			vi.useFakeTimers();
			try {
				const pending = worker.fetch(
					run_request(requestBody),
					make_env({
						onPluginRequest: () =>
							new Response(
								new ReadableStream<Uint8Array>({
									pull() {
										entered();
									},
									cancel,
								}),
							),
					}),
					make_ctx(),
				);
				await reading;
				await vi.advanceTimersByTimeAsync(100);
				const response = await pending;
				expect(cancel).toHaveBeenCalledOnce();
				expect(JSON.parse(await read_runner_response(response))._nay.code).toBe("response_timeout");
				expect(vi.getTimerCount()).toBe(0);
			} finally {
				vi.useRealTimers();
			}
		},
	);

	it("times out execution and aborts the plugin request", async () => {
		const requestBody = await make_run_body({ body: { timeoutMs: 100 } });
		let entered = () => {};
		const executing = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let requestSignal: AbortSignal | undefined;
		vi.useFakeTimers();
		try {
			const pending = worker.fetch(
				run_request(requestBody),
				make_env({
					onPluginRequest(request) {
						requestSignal = request.signal;
						entered();
						return new Promise<Response>(() => {});
					},
				}),
				make_ctx(),
			);
			await executing;
			await vi.advanceTimersByTimeAsync(100);
			expect(JSON.parse(await read_runner_response(await pending))._nay.code).toBe("response_timeout");
			expect(requestSignal?.aborted).toBe(true);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not start queued artifact work after its deadline", async () => {
		const requestBody = await make_run_body({ body: { timeoutMs: 100 } });
		const onGet = vi.fn();
		const env = make_env({ onGet });
		let entered = () => {};
		const loading = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let finishLoad: (value: null) => void = () => {};
		env.PLUGIN_ARTIFACTS.get = () =>
			new Promise((resolve) => {
				finishLoad = resolve;
				entered();
			});
		vi.useFakeTimers();
		try {
			const pending = worker.fetch(run_request(requestBody), env, make_ctx());
			await loading;
			await vi.advanceTimersByTimeAsync(100);
			expect(JSON.parse(await read_runner_response(await pending))._nay.code).toBe("response_timeout");
			finishLoad(null);
			await vi.advanceTimersByTimeAsync(0);
			expect(onGet).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("uses the time left after execution for the body", async () => {
		const requestBody = await make_run_body({ body: { timeoutMs: 100 } });
		let entered = () => {};
		const executing = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let bodyTimer: ReturnType<typeof setTimeout> | undefined;
		const cancel = vi.fn(() => clearTimeout(bodyTimer));
		vi.useFakeTimers();
		try {
			const pending = worker.fetch(
				run_request(requestBody),
				make_env({
					async onPluginRequest() {
						entered();
						await new Promise((resolve) => setTimeout(resolve, 40));
						return new Response(
							new ReadableStream<Uint8Array>({
								start(controller) {
									bodyTimer = setTimeout(() => {
										controller.enqueue(TEXT_ENCODER.encode("late"));
										controller.close();
									}, 70);
								},
								cancel,
							}),
						);
					},
				}),
				make_ctx(),
			);
			await executing;
			await vi.advanceTimersByTimeAsync(100);
			expect(JSON.parse(await read_runner_response(await pending))._nay.code).toBe("response_timeout");
			expect(cancel).toHaveBeenCalledOnce();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("BonoboHost", () => {
	it("forwards secrets through the host API only with the secret capability", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ value: "openai-secret" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
		try {
			const result = await BonoboHost.prototype.secretGet.call(
				{
					env: { PLUGIN_RUNNER_HOST_SECRET: "test-host-secret" },
					ctx: {
						props: {
							pluginStableId: "plugin:media@0.1.0:sha256:abc:bonobo-host-v3",
							pluginRunId: "run_123",
							host: DEFAULT_HOST,
							acceptedCapabilities: ["plugin.secrets.read"],
						},
					},
				} as unknown as BonoboHost,
				// A rogue host/pluginRunId in the input must be ignored: run identity and the host
				// origin/token come from trusted props only.
				{
					host: { origin: "https://evil.example", token: "stolen" },
					pluginRunId: "run_forged",
					name: "OPENAI_API_KEY",
				},
			);
			expect(result).toBe("openai-secret");
			const request = fetchSpy.mock.calls[0]?.[0] as Request;
			expect(request.url).toBe("https://app.example/api/internal/plugins/host/secret-get");
			// Dual auth: the run token plus the runner-only host secret.
			expect(request.headers.get("Authorization")).toBe("Bearer host-token");
			expect(request.headers.get("X-Bonobo-Runner-Authorization")).toBe("Bearer test-host-secret");
			// The host derives the run from the bearer token, so the body carries only the secret name.
			const body = await request.clone().json();
			expect(body).toEqual({ name: "OPENAI_API_KEY" });
			expect(JSON.stringify(body)).not.toContain("host-token");

			await expect(
				BonoboHost.prototype.secretGet.call(
					{
						env: { PLUGIN_RUNNER_HOST_SECRET: "test-host-secret" },
						ctx: {
							props: {
								pluginStableId: "plugin:media@0.1.0:sha256:abc:bonobo-host-v3",
								pluginRunId: "run_123",
								host: DEFAULT_HOST,
								acceptedCapabilities: [],
							},
						},
					} as unknown as BonoboHost,
					{ name: "OPENAI_API_KEY" },
				),
			).rejects.toThrow("Missing capability");
		} finally {
			fetchSpy.mockRestore();
		}
	});
});

describe("BonoboOutbound", () => {
	function outbound_self(overrides?: { acceptedCapabilities?: string[]; outboundOrigins?: string[] }) {
		return {
			env: { PLUGIN_RUNNER_HOST_SECRET: "test-host-secret" },
			ctx: {
				props: {
					pluginStableId: "plugin:media@0.1.0:sha256:abc:bonobo-host-v3",
					pluginRunId: "run_123",
					host: DEFAULT_HOST,
					acceptedCapabilities: ["outbound.fetch"],
					outboundOrigins: ["https://modal.example"],
					...overrides,
				},
			},
		} as unknown as BonoboOutbound;
	}

	it("passes host-origin requests through without accounting or a capability gate", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("host-ok", { status: 200 }));
		try {
			const request = new Request(`${DEFAULT_HOST.origin}/api/v1/files/write`, {
				method: "POST",
				headers: { Authorization: `Bearer ${DEFAULT_HOST.token}`, "Content-Type": "application/json" },
				body: JSON.stringify({ path: "/uploads/photo.png.description.md", content: "# Out" }),
			});
			const response = await BonoboOutbound.prototype.fetch.call(
				outbound_self({ acceptedCapabilities: [], outboundOrigins: [] }),
				request,
			);
			expect(response.status).toBe(200);
			expect(await response.text()).toBe("host-ok");
			expect(fetchSpy).toHaveBeenCalledTimes(1);
			const forwarded = fetch_request(fetchSpy.mock.calls[0]![0]);
			expect(forwarded.url).toBe(`${DEFAULT_HOST.origin}/api/v1/files/write`);
			// The pass-through keeps the plugin's own headers and never adds the runner host secret.
			expect(forwarded.headers.get("X-Bonobo-Runner-Authorization")).toBe(null);
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("never attaches the runner host secret to plugin calls against the runner-only host routes", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 401 }));
		try {
			// A malicious plugin can reach the runner-only paths through the host-origin pass-through
			// and even send its own forged runner header, but the real secret is unreachable from the
			// dynamic worker, so the forged value is all that arrives at the host.
			const request = new Request(`${DEFAULT_HOST.origin}/api/internal/plugins/host/claim-runner-call`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${DEFAULT_HOST.token}`,
					"X-Bonobo-Runner-Authorization": "Bearer forged-value",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ requestBytes: 0 }),
			});
			const response = await BonoboOutbound.prototype.fetch.call(outbound_self(), request);
			expect(response.status).toBe(401);
			const forwarded = fetch_request(fetchSpy.mock.calls[0]![0]);
			expect(forwarded.headers.get("X-Bonobo-Runner-Authorization")).toBe("Bearer forged-value");
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("requires the outbound.fetch capability for non-host origins", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
		try {
			await expect(
				BonoboOutbound.prototype.fetch.call(
					outbound_self({ acceptedCapabilities: [] }),
					new Request("https://modal.example/convert"),
				),
			).rejects.toThrow("Missing capability: outbound.fetch");
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("brokers plugin fetch to allowlisted origins with claim/finish accounting", async () => {
		const { fetchSpy, hostRequests } = mock_host_fetch((request) => {
			if (request.url === "https://modal.example/convert") {
				return new Response("service-ok", { status: 200, headers: { "Content-Type": "text/plain" } });
			}
		});
		try {
			// The allowlist entry is an ORIGIN, so https://modal.example/convert passes because its origin matches.
			const response = await BonoboOutbound.prototype.fetch.call(
				outbound_self(),
				new Request("https://modal.example/convert", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: "{}",
				}),
			);
			expect(response.status).toBe(200);
			expect(response.headers.get("Content-Type")).toBe("text/plain");
			expect(await response.text()).toBe("service-ok");
			expect(fetchSpy).toHaveBeenCalledTimes(3);
			// Claim/finish authenticate with the run token plus the runner host secret; the bodies
			// carry no pluginRunId because the host derives the run from the bearer token.
			for (const hostRequest of [hostRequests[0]!, hostRequests[1]!]) {
				expect(hostRequest.headers.get("Authorization")).toBe(`Bearer ${DEFAULT_HOST.token}`);
				expect(hostRequest.headers.get("X-Bonobo-Runner-Authorization")).toBe("Bearer test-host-secret");
			}
			expect(await hostRequests[0]!.clone().json()).toEqual({
				requestBytes: 2,
			});
			expect(await hostRequests[1]!.clone().json()).toEqual({
				callId: "call_1",
				status: "succeeded",
				errorMessage: null,
				requestBytes: 2,
				responseBytes: "service-ok".length,
				responseStatus: 200,
			});
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("rejects plugin fetch URLs whose origin does not exactly match the allowlist", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
		try {
			const cases = [
				{ url: "http://modal.example/x", error: "must use HTTPS" },
				{ url: "https://modal.example:8443/x", error: "origin is not allowed" },
				{ url: "https://api.modal.example/x", error: "origin is not allowed" },
				{ url: "https://api.openai.com/v1/models", error: "origin is not allowed" },
			];
			for (const { url, error } of cases) {
				await expect(BonoboOutbound.prototype.fetch.call(outbound_self(), new Request(url))).rejects.toThrow(error);
			}
			await expect(
				BonoboOutbound.prototype.fetch.call(
					outbound_self(),
					new Request("https://modal.example/convert", { method: "HEAD" }),
				),
			).rejects.toThrow("method is invalid");
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("returns redirect responses without following them", async () => {
		const { fetchSpy } = mock_host_fetch((request) => {
			if (request.url === "https://modal.example/old") {
				return new Response(null, { status: 301, headers: { Location: "https://evil.example/new" } });
			}
		});
		try {
			const response = await BonoboOutbound.prototype.fetch.call(
				outbound_self(),
				new Request("https://modal.example/old"),
			);
			expect(response.status).toBe(301);
			expect(response.headers.get("Location")).toBe("https://evil.example/new");
			const fetchedUrls = fetchSpy.mock.calls.map((call) => fetch_request(call[0]).url);
			expect(fetchedUrls).toContain("https://modal.example/old");
			expect(fetchedUrls).not.toContain("https://evil.example/new");
			const outboundRequest = fetchSpy.mock.calls
				.map((call) => fetch_request(call[0]))
				.find((request) => request.url === "https://modal.example/old");
			expect(outboundRequest?.redirect).toBe("manual");
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("caps buffered plugin fetch responses and finishes the call as failed", async () => {
		const { fetchSpy, hostRequests } = mock_host_fetch((request) => {
			if (request.url === "https://modal.example/huge") {
				return new Response(new Uint8Array(LIMITS.outboundResponseBytes + 1), { status: 200 });
			}
		});
		try {
			await expect(
				BonoboOutbound.prototype.fetch.call(outbound_self(), new Request("https://modal.example/huge")),
			).rejects.toThrow("size limit");
			expect(await hostRequests[1]!.clone().json()).toEqual({
				callId: "call_1",
				status: "failed",
				errorMessage: "Outbound fetch failed",
				requestBytes: 0,
			});
		} finally {
			fetchSpy.mockRestore();
		}
	});
});

describe("secret masking", () => {
	function fetch_secret_during_run(secretValue: string) {
		return mock_host_fetch((request) => {
			if (request.url === `${DEFAULT_HOST.origin}/api/internal/plugins/host/secret-get`) {
				return new Response(JSON.stringify({ value: secretValue }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
		});
	}

	function plugin_secret_get() {
		return BonoboHost.prototype.secretGet.call(
			{
				env: { PLUGIN_RUNNER_HOST_SECRET: "test-host-secret" },
				ctx: {
					props: {
						pluginStableId: "plugin:media@0.1.0:sha256:abc:bonobo-host-v3",
						pluginRunId: "run_123",
						host: DEFAULT_HOST,
						acceptedCapabilities: ["plugin.secrets.read"],
						outboundOrigins: [],
					},
				},
			} as unknown as BonoboHost,
			{ name: "OPENAI_API_KEY" },
		);
	}

	it("masks complete secrets across byte blocks in a non-2xx response and keeps raw byte counts", async () => {
		const secret = "super-secret-value-123";
		const { fetchSpy } = fetch_secret_during_run(secret);
		const prefix = "a".repeat(65_530);
		try {
			const response = await worker.fetch(
				run_request(await make_run_body()),
				make_env({
					async onPluginRequest() {
						await plugin_secret_get();
						return streamed_response(`${prefix}${secret} done`, 7, 409);
					},
				}),
				make_ctx(),
			);
			expect(response.headers.get("X-Bonobo-Runner-Output-Bytes")).toBe(String(prefix.length + secret.length + 5));
			expect(JSON.parse(await read_runner_response(response))).toEqual({
				runId: "run_123",
				pluginStatus: 409,
				output: `${prefix}*** done`,
			});
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("masks error names and messages before their bounds, including heavily escaped text", async () => {
		const secret = "super-secret-value-123";
		const { fetchSpy } = fetch_secret_during_run(secret);
		try {
			const response = await worker.fetch(
				run_request(await make_run_body()),
				make_env({
					async onPluginRequest() {
						await plugin_secret_get();
						throw Object.assign(new Error(`${"\u0000".repeat(490)}${secret}${"\u0000".repeat(10_000)}`), {
							name: `${"\u0000".repeat(60)}${secret}${"\u0000".repeat(10_000)}`,
						});
					},
				}),
				make_ctx(),
			);
			const body = JSON.parse(await read_runner_response(response));
			expect(body._nay.name).toBe(`${"\u0000".repeat(60)}***\u0000`);
			expect(body._nay.message).toBe(`${"\u0000".repeat(490)}***${"\u0000".repeat(7)}`);
			expect(body._nay.code).toBe("execution_failed");
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("refuses an oversized raw plugin response even when masking would make the invoke reply fit", async () => {
		const secret = "super-secret-value-123";
		const { fetchSpy } = fetch_secret_during_run(secret);
		try {
			const response = await worker.fetch(
				run_request(await make_run_body()),
				make_env({
					async onPluginRequest() {
						await plugin_secret_get();
						return new Response(secret.repeat(Math.floor(LIMITS.outputBytes / secret.length) + 1));
					},
				}),
				make_ctx(),
			);
			expect(JSON.parse(await read_runner_response(response))._nay.code).toBe("response_too_large");
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("releases late responses and does not recreate secret state after a timeout", async () => {
		const requestBody = await make_run_body({ body: { timeoutMs: 100 } });
		let entered = () => {};
		const fetching = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let finishSecret: (response: Response) => void = () => {};
		const { fetchSpy } = mock_host_fetch((request) => {
			if (request.url.endsWith("/secret-get")) {
				entered();
				return new Promise<Response>((resolve) => {
					finishSecret = resolve;
				});
			}
		});
		let cancelled = () => {};
		const lateCancellation = new Promise<void>((resolve) => {
			cancelled = resolve;
		});
		const cancel = vi.fn(() => {
			cancelled();
			return new Promise<void>(() => {});
		});
		const mapSet = vi.spyOn(Map.prototype, "set");
		vi.useFakeTimers();
		try {
			const pending = worker.fetch(
				run_request(requestBody),
				make_env({
					async onPluginRequest() {
						await plugin_secret_get();
						return new Response(new ReadableStream<Uint8Array>({ cancel }));
					},
				}),
				make_ctx(),
			);
			await fetching;
			await vi.advanceTimersByTimeAsync(100);
			expect(JSON.parse(await read_runner_response(await pending))._nay.code).toBe("response_timeout");
			mapSet.mockClear();
			finishSecret(Response.json({ value: "late-secret-value" }));
			await lateCancellation;
			expect(cancel).toHaveBeenCalledOnce();
			expect(mapSet.mock.calls.filter(([key]) => key === "run_123")).toEqual([]);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			mapSet.mockRestore();
			vi.useRealTimers();
			fetchSpy.mockRestore();
		}
	});

	it("masks tracked secret values in run output and never logs them", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { fetchSpy } = fetch_secret_during_run("super-secret-value-123");
		try {
			const res = await worker.fetch(
				run_request(await make_run_body()),
				make_env({
					onPluginRequest: async () => {
						const secret = await plugin_secret_get();
						return new Response(`token=${secret} done`);
					},
				}),
				make_ctx(),
			);
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.output).toContain("***");
			expect(body.output).not.toContain("super-secret-value-123");
			const logs = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
			expect(logs).not.toContain("super-secret-value-123");
		} finally {
			fetchSpy.mockRestore();
			logSpy.mockRestore();
		}
	});

	it("masks the plugin-visible run token in plugin output", async () => {
		const res = await worker.fetch(
			run_request(await make_run_body()),
			make_env({
				onPluginRequest: async () => new Response(`token=${DEFAULT_HOST.token} done`),
			}),
			make_ctx(),
		);
		const body = await res.json();
		expect(body.output).toBe("token=*** done");
	});

	it("does not mask secrets shorter than the minimum length", async () => {
		const { fetchSpy } = fetch_secret_during_run("abc12");
		try {
			const res = await worker.fetch(
				run_request(await make_run_body()),
				make_env({
					onPluginRequest: async () => {
						const secret = await plugin_secret_get();
						return new Response(`token=${secret} done`);
					},
				}),
				make_ctx(),
			);
			const body = await res.json();
			expect(body.output).toBe("token=abc12 done");
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("clears tracked secrets when the run finishes", async () => {
		const { fetchSpy } = fetch_secret_during_run("super-secret-value-123");
		try {
			const first = await worker.fetch(
				run_request(await make_run_body()),
				make_env({
					onPluginRequest: async () => {
						const secret = await plugin_secret_get();
						return new Response(`token=${secret}`);
					},
				}),
				make_ctx(),
			);
			expect((await first.json()).output).toBe("token=***");

			// Same pluginRunId, but this plugin never calls secretGet: an unmasked echo proves
			// the per-run set was deleted at the end of the first run.
			const second = await worker.fetch(
				run_request(await make_run_body()),
				make_env({
					onPluginRequest: async () => new Response("token=super-secret-value-123"),
				}),
				make_ctx(),
			);
			expect((await second.json()).output).toBe("token=super-secret-value-123");
		} finally {
			fetchSpy.mockRestore();
		}
	});
});
