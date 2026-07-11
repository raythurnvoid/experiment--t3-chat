import { describe, expect, it, vi } from "vitest";

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
	disabled?: boolean;
	artifactSource?: string | null;
	onGet?: (id: string) => void;
	onCode?: (code: Record<string, unknown>) => void;
	onEntrypoint?: (name: string | null | undefined, options: unknown) => void;
	onPluginRequest?: (request: Request) => Response | Promise<Response>;
}): Env {
	const artifactSource =
		opts && "artifactSource" in opts && opts.artifactSource !== undefined ? opts.artifactSource : DEFAULT_ARTIFACT_SOURCE;
	return {
		PLUGIN_RUNNER_SECRET: opts?.secret ?? "test-secret",
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

async function make_run_body(opts?: {
	artifactSource?: string;
	body?: Record<string, unknown>;
}) {
	const artifactSource = opts?.artifactSource ?? DEFAULT_ARTIFACT_SOURCE;
	return JSON.stringify({
		pluginId: "media",
		pluginName: "media",
		pluginVersion: "0.1.0",
		artifactKey: "plugins/media.js",
		artifactHash: await sha256_artifact(artifactSource),
		pluginRunId: "run_123",
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
		const res = await worker.fetch(
			run_request(await make_run_body({ body: { artifactHash: undefined } })),
			make_env(),
		);
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
		for (const outboundOrigins of [["https://modal.example/convert"], ["http://modal.example"], "https://modal.example"]) {
			const res = await worker.fetch(run_request(await make_run_body({ body: { outboundOrigins } })), make_env());
			expect(res.status).toBe(400);
			expect((await res.json())._nay.message).toContain("outboundOrigins");
		}
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
		const res = await worker.fetch(
			run_request(await make_run_body()),
			make_env({ artifactSource: null }),
			make_ctx(),
		);
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
		const pluginStableId = `plugin:media@0.1.0:${artifactHash}:bonobo-host-v2`;
		expect(loaderId).toBe(`${pluginStableId}:run_123`);
		expect(hostProps).toEqual({
			pluginStableId,
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
		expect(pluginEvent).toEqual({
			type: "files.upload.completed",
			source: { name: "photo.png" },
			pluginRunId: "run_123",
		});
		const body = await res.json();
		expect(body._yay.pluginStatus).toBe(202);
		expect(body._yay.elapsedMs).toEqual(expect.any(Number));
		expect(body._yay.outputBytes).toBe("plugin-ok".length);
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

	it("reports plugin HTTP errors as errored runs", async () => {
		const res = await worker.fetch(
			run_request(await make_run_body()),
			make_env({
				onPluginRequest: async () => new Response("plugin failed", { status: 500 }),
			}),
			make_ctx(),
		);

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toMatchObject({
			_nay: {
				name: "PluginResponseError",
				message: "Plugin returned status 500",
				data: { pluginStatus: 500, outputBytes: "plugin failed".length },
			},
		});
		expect(body._yay).toBeUndefined();
		expect(JSON.stringify(body)).not.toContain("plugin failed");
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
					onPluginRequest: async () => new Response("SENTINEL_OUTPUT"),
				}),
				make_ctx(),
			);
			const logs = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
			expect(logs).not.toContain("SENTINEL_SOURCE");
			expect(logs).not.toContain("SENTINEL_INPUT");
			expect(logs).not.toContain("SENTINEL_OUTPUT");
			expect(logs).not.toContain("SENTINEL_HOST_TOKEN");
			expect(logs).not.toContain("SECRET_ARTIFACT_KEY");
			expect(logs).toContain("plugin_runner");
		} finally {
			logSpy.mockRestore();
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
					ctx: {
						props: {
							pluginStableId: "plugin:media@0.1.0:sha256:abc:bonobo-host-v2",
							acceptedCapabilities: ["plugin.secrets.read"],
						},
					},
				} as unknown as BonoboHost,
				{ host: DEFAULT_HOST, pluginRunId: "run_123", name: "OPENAI_API_KEY" },
			);
			expect(result).toBe("openai-secret");
			const request = fetchSpy.mock.calls[0]?.[0] as Request;
			expect(request.url).toBe("https://app.example/api/internal/plugins/host/secret-get");
			expect(request.headers.get("Authorization")).toBe("Bearer host-token");
			const body = await request.clone().json();
			expect(body).toEqual({ pluginRunId: "run_123", name: "OPENAI_API_KEY" });
			expect(JSON.stringify(body)).not.toContain("host-token");

			await expect(
				BonoboHost.prototype.secretGet.call(
					{
						ctx: {
							props: {
								pluginStableId: "plugin:media@0.1.0:sha256:abc:bonobo-host-v2",
								acceptedCapabilities: [],
							},
						},
					} as unknown as BonoboHost,
					{ host: DEFAULT_HOST, pluginRunId: "run_123", name: "OPENAI_API_KEY" },
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
			ctx: {
				props: {
					pluginStableId: "plugin:media@0.1.0:sha256:abc:bonobo-host-v2",
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
			const request = new Request(`${DEFAULT_HOST.origin}/api/plugins/v1/write-markdown`, {
				method: "POST",
				headers: { Authorization: `Bearer ${DEFAULT_HOST.token}`, "Content-Type": "application/json" },
				body: JSON.stringify({ pluginRunId: "run_123", markdown: "# Out" }),
			});
			const response = await BonoboOutbound.prototype.fetch.call(
				outbound_self({ acceptedCapabilities: [], outboundOrigins: [] }),
				request,
			);
			expect(response.status).toBe(200);
			expect(await response.text()).toBe("host-ok");
			expect(fetchSpy).toHaveBeenCalledTimes(1);
			expect(fetch_request(fetchSpy.mock.calls[0]![0]).url).toBe(`${DEFAULT_HOST.origin}/api/plugins/v1/write-markdown`);
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
			expect(await hostRequests[0]!.clone().json()).toEqual({
				pluginRunId: "run_123",
				operation: "outboundFetch",
				requestBytes: 2,
			});
			expect(await hostRequests[1]!.clone().json()).toMatchObject({
				pluginRunId: "run_123",
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
			expect(await hostRequests[1]!.clone().json()).toMatchObject({
				pluginRunId: "run_123",
				callId: "call_1",
				status: "failed",
				errorMessage: "Outbound fetch failed",
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
				ctx: {
					props: {
						pluginStableId: "plugin:media@0.1.0:sha256:abc:bonobo-host-v2",
						acceptedCapabilities: ["plugin.secrets.read"],
						outboundOrigins: [],
					},
				},
			} as unknown as BonoboHost,
			{ host: DEFAULT_HOST, pluginRunId: "run_123", name: "OPENAI_API_KEY" },
		);
	}

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
			expect(body._yay.output).toContain("***");
			expect(body._yay.output).not.toContain("super-secret-value-123");
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
		expect(body._yay.output).toBe("token=*** done");
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
			expect(body._yay.output).toBe("token=abc12 done");
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
			expect((await first.json())._yay.output).toBe("token=***");

			// Same pluginRunId, but this plugin never calls secretGet: an unmasked echo proves
			// the per-run set was deleted at the end of the first run.
			const second = await worker.fetch(
				run_request(await make_run_body()),
				make_env({
					onPluginRequest: async () => new Response("token=super-secret-value-123"),
				}),
				make_ctx(),
			);
			expect((await second.json())._yay.output).toBe("token=super-secret-value-123");
		} finally {
			fetchSpy.mockRestore();
		}
	});
});
