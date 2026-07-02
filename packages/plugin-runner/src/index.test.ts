import { describe, expect, it, vi } from "vitest";

import { BonoboHost, DYNAMIC_WORKER_LIMITS, LIMITS, handle_request, type Env } from "./index";

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
		generateText: (input: unknown) => Promise<unknown>;
		transcribeAudio: (input: unknown) => Promise<unknown>;
		sourceTemporaryUrl: (input: unknown) => Promise<unknown>;
		sourceBase64: (input: unknown) => Promise<unknown>;
		writeMarkdown: (input: unknown) => Promise<unknown>;
		secretGet: (input: unknown) => Promise<unknown>;
		outboundFetch: (input: unknown) => Promise<unknown>;
	};
	onHostProps?: (props: unknown) => void;
}) {
	const hostBinding = opts?.hostBinding ?? {
		generateText: async () => ({ text: "generated" }),
		transcribeAudio: async () => ({ text: "transcribed" }),
		sourceTemporaryUrl: async () => ({ url: "https://source.test/file", expiresAt: 1 }),
		sourceBase64: async () => ({ bodyBase64: "AQID", contentType: "video/mp4", bytes: 3 }),
		writeMarkdown: async () => ({ ok: true }),
		secretGet: async () => "secret-value",
		outboundFetch: async () => ({ status: 200, ok: true, headers: {}, bodyText: "ok" }),
	};
	return {
		waitUntil: () => {},
		exports: {
			BonoboHost: (options: { props: unknown }) => {
				opts?.onHostProps?.(options.props);
				return hostBinding;
			},
		},
	};
}

function make_env(opts?: {
	secret?: string;
	disabled?: boolean;
	artifactSource?: string | null;
	ai?: Env["AI"];
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
		AI: opts?.ai,
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
		acceptedCapabilities: ["files.source.temporaryUrl", "files.markdown.write", "plugin.secrets.read", "outbound.fetch"],
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
		const res = await handle_request(new Request(`${URL_BASE}/health`), make_env());
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});

	it("returns 404 for unknown routes", async () => {
		const res = await handle_request(new Request(`${URL_BASE}/nope`), make_env());
		expect(res.status).toBe(404);
	});
});

describe("auth + kill switch", () => {
	it("rejects requests without a valid bearer token", async () => {
		const res = await handle_request(run_request(await make_run_body(), {}), make_env());
		expect(res.status).toBe(401);
	});

	it("rejects requests with the wrong bearer token", async () => {
		const res = await handle_request(run_request(await make_run_body(), { Authorization: "Bearer wrong" }), make_env());
		expect(res.status).toBe(401);
	});

	it("returns 503 when PLUGIN_RUNNER_DISABLED is set", async () => {
		const res = await handle_request(run_request(await make_run_body()), make_env({ disabled: true }));
		expect(res.status).toBe(503);
		expect((await res.json()).error.code).toBe("disabled");
	});
});

describe("validation", () => {
	it("rejects invalid JSON", async () => {
		const res = await handle_request(run_request("{nope"), make_env());
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe("invalid_json");
	});

	it("rejects a non-object body", async () => {
		const res = await handle_request(run_request(JSON.stringify([1, 2, 3])), make_env());
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe("invalid_request");
	});

	it("requires artifactHash", async () => {
		const res = await handle_request(
			run_request(await make_run_body({ body: { artifactHash: undefined } })),
			make_env(),
		);
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toContain("artifactHash");
	});

	it("requires outboundOrigins", async () => {
		const res = await handle_request(
			run_request(await make_run_body({ body: { outboundOrigins: undefined } })),
			make_env(),
		);
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toContain("outboundOrigins");
	});

	it("rejects outboundOrigins entries that are not exact https origins", async () => {
		for (const outboundOrigins of [["https://modal.example/convert"], ["http://modal.example"], "https://modal.example"]) {
			const res = await handle_request(run_request(await make_run_body({ body: { outboundOrigins } })), make_env());
			expect(res.status).toBe(400);
			expect((await res.json()).error.message).toContain("outboundOrigins");
		}
	});

	it("rejects an artifact key outside the configured prefix", async () => {
		const res = await handle_request(
			run_request(await make_run_body({ body: { artifactKey: "other/media.js" } })),
			make_env(),
		);
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe("invalid_artifact_key");
	});

	it("returns 503 when ctx.exports does not provide BonoboHost", async () => {
		const res = await handle_request(run_request(await make_run_body()), make_env());
		expect(res.status).toBe(503);
		expect((await res.json()).error.code).toBe("misconfigured");
	});

	it("returns 404 for a missing R2 object", async () => {
		const res = await handle_request(
			run_request(await make_run_body()),
			make_env({ artifactSource: null }),
			make_ctx(),
		);
		expect(res.status).toBe(404);
		expect((await res.json()).error.code).toBe("artifact_not_found");
	});
});

describe("dynamic worker loading", () => {
	it("rejects artifact hash mismatches before calling the loader", async () => {
		const onGet = vi.fn();
		const res = await handle_request(
			run_request(
				await make_run_body({
					body: { artifactHash: await sha256_artifact("different source") },
				}),
			),
			make_env({ onGet }),
			make_ctx(),
		);
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe("artifact_hash_mismatch");
		expect(onGet).not.toHaveBeenCalled();
	});

	it("loads immutable artifacts with LOADER.get, stable ids, limits, and BONOBO_HOST", async () => {
		const artifactSource = "SENTINEL_SOURCE";
		const artifactHash = await sha256_artifact(artifactSource);
		const hostBinding = {
			generateText: async () => ({ text: "generated" }),
			transcribeAudio: async () => ({ text: "transcribed" }),
			sourceTemporaryUrl: async () => ({ url: "https://source.test/file", expiresAt: 1 }),
			sourceBase64: async () => ({ bodyBase64: "AQID", contentType: "video/mp4", bytes: 3 }),
			writeMarkdown: async () => ({ ok: true }),
			secretGet: async () => "secret-value",
			outboundFetch: async () => ({ status: 200, ok: true, headers: {}, bodyText: "ok" }),
		};
		let stableId: string | undefined;
		let loaded: Record<string, unknown> | undefined;
		let entrypointOptions: unknown;
		let hostProps: unknown;
		let pluginEvent: unknown;

		const res = await handle_request(
			run_request(
				await make_run_body({
					artifactSource,
					body: { input: { type: "files.upload.completed", source: { name: "photo.png" } } },
				}),
			),
			make_env({
				artifactSource,
				onGet: (id) => {
					stableId = id;
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
				onHostProps: (props) => {
					hostProps = props;
				},
			}),
		);

		expect(res.status).toBe(200);
		expect(stableId).toContain(`plugin:media@0.1.0:${artifactHash}`);
		expect(stableId).toContain("bonobo-host-v1");
		expect(hostProps).toEqual({
			pluginStableId: stableId,
			acceptedCapabilities: ["files.source.temporaryUrl", "files.markdown.write", "plugin.secrets.read", "outbound.fetch"],
			outboundOrigins: ["https://api.openai.com"],
		});
		expect(loaded?.globalOutbound).toBeNull();
		expect(loaded?.limits).toEqual(DYNAMIC_WORKER_LIMITS);
		expect((loaded?.env as Record<string, unknown>)?.BONOBO_HOST).toBe(hostBinding);
			expect((loaded?.modules as Record<string, string>)?.["plugin.js"]).toBe(artifactSource);
			expect((loaded?.modules as Record<string, string>)?.["bonobo-plugin-wrapper.js"]).toContain("sourceBase64");
			expect((loaded?.modules as Record<string, string>)?.["bonobo-plugin-wrapper.js"]).toContain("generateText");
			expect(entrypointOptions).toEqual({
				props: {
					pluginRunId: "run_123",
				host: DEFAULT_HOST,
				acceptedCapabilities: ["files.source.temporaryUrl", "files.markdown.write", "plugin.secrets.read", "outbound.fetch"],
			},
			limits: DYNAMIC_WORKER_LIMITS,
		});
		expect(pluginEvent).toEqual({
			type: "files.upload.completed",
			source: { name: "photo.png" },
			pluginRunId: "run_123",
		});
		const body = await res.json();
		expect(body.pluginStatus).toBe(202);
		expect(body.elapsedMs).toEqual(expect.any(Number));
		expect(body.outputBytes).toBe("plugin-ok".length);
	});

	it("reports plugin HTTP errors as errored runs", async () => {
		const res = await handle_request(
			run_request(await make_run_body()),
			make_env({
				onPluginRequest: async () => new Response("plugin failed", { status: 500 }),
			}),
			make_ctx(),
		);

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toMatchObject({
			status: "errored",
			pluginStatus: 500,
			outputBytes: "plugin failed".length,
			error: { name: "PluginResponseError", message: "Plugin returned status 500" },
		});
		expect(body.output).toBeUndefined();
	});

	it("does not log tokens, source, input, output, or raw artifact keys", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const artifactSource = "SENTINEL_SOURCE";
		try {
			await handle_request(
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

describe("BONOBO_HOST", () => {
	it("forwards generateText through the host API with the host token kept out of the body", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ text: "description" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
		try {
			const result = await BonoboHost.prototype.generateText.call(
				Object.assign(Object.create(BonoboHost.prototype), {
					env: {},
					ctx: {
						props: {
							pluginStableId: "plugin:media@0.1.0:sha256:abc:bonobo-host-v1",
							acceptedCapabilities: [],
						},
					},
				}) as BonoboHost,
				{
					host: DEFAULT_HOST,
					pluginRunId: "run_123",
					system: "Describe uploaded images.",
					prompt: "Describe photo.png",
					includeSourceImage: true,
					maxOutputTokens: 900,
				},
			);
			expect(result).toEqual({ text: "description" });
			const request = fetchSpy.mock.calls[0]?.[0] as Request;
			expect(request.url).toBe("https://app.example/api/internal/plugins/host/generate-text");
			expect(request.headers.get("Authorization")).toBe("Bearer host-token");
			expect(request.headers.get("X-Bonobo-Plugin-Stable-Id")).toBe("plugin:media@0.1.0:sha256:abc:bonobo-host-v1");
			const body = await request.clone().json();
			expect(body).toEqual({
				pluginRunId: "run_123",
				system: "Describe uploaded images.",
				prompt: "Describe photo.png",
				includeSourceImage: true,
				maxOutputTokens: 900,
			});
			expect(JSON.stringify(body)).not.toContain("host-token");
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("can satisfy source image generateText through Workers AI", async () => {
		const aiRun = vi.fn(async () => ({ response: "workers ai description" }));
		const { fetchSpy, hostRequests } = mock_host_fetch(async (request) => {
			if (request.url === "https://app.example/api/internal/plugins/host/source-temporary-url") {
				return new Response(JSON.stringify({ url: "https://source.test/photo.png", expiresAt: 123 }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (request.url === "https://source.test/photo.png") {
				return new Response(new Uint8Array([1, 2, 3]), {
					status: 200,
					headers: { "Content-Type": "image/png" },
				});
			}
		});
		try {
			const result = await BonoboHost.prototype.generateText.call(
				Object.assign(Object.create(BonoboHost.prototype), {
					env: { AI: { run: aiRun } },
					ctx: {
						props: {
							pluginStableId: "plugin:media@0.1.0:sha256:abc:bonobo-host-v1",
							acceptedCapabilities: ["ai.generateText", "uploads.source.read"],
						},
					},
				}) as BonoboHost,
				{
					host: DEFAULT_HOST,
					pluginRunId: "run_123",
					system: "Describe uploaded images.",
					prompt: "Describe photo.png",
					includeSourceImage: true,
					maxOutputTokens: 900,
				},
			);
			expect(result).toEqual({ text: "workers ai description" });
			expect(fetchSpy).toHaveBeenCalledTimes(4);
			expect(await hostRequests[0]!.clone().json()).toEqual({
				pluginRunId: "run_123",
				operation: "generateText",
				systemBytes: TEXT_ENCODER.encode("Describe uploaded images.").length,
				promptBytes: TEXT_ENCODER.encode("Describe photo.png").length,
				includeSourceImage: true,
				maxOutputTokens: 900,
			});
			expect(await hostRequests[1]!.clone().json()).toEqual({ pluginRunId: "run_123", expiresInSeconds: 300 });
			expect(await hostRequests[2]!.clone().json()).toMatchObject({
				pluginRunId: "run_123",
				callId: "call_1",
				status: "succeeded",
				errorMessage: null,
				modelId: "@cf/moonshotai/kimi-k2.6",
				sourceBytes: 3,
				outputTextBytes: TEXT_ENCODER.encode("workers ai description").length,
			});
			expect(aiRun).toHaveBeenCalledWith("@cf/moonshotai/kimi-k2.6", {
				messages: [
					{ role: "system", content: "Describe uploaded images." },
					{
						role: "user",
						content: [
							{ type: "text", text: "Describe photo.png" },
							{ type: "image_url", image_url: { url: "data:image/png;base64,AQID" } },
						],
					},
				],
				max_completion_tokens: 900,
				temperature: 0.2,
			});
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("can satisfy text-only generateText through Workers AI", async () => {
		const aiRun = vi.fn(async () => ({ response: "workers ai summary" }));
		const { fetchSpy, hostRequests } = mock_host_fetch();
		try {
			const result = await BonoboHost.prototype.generateText.call(
				Object.assign(Object.create(BonoboHost.prototype), {
					env: { AI: { run: aiRun } },
					ctx: {
						props: {
							pluginStableId: "plugin:media@0.1.0:sha256:abc:bonobo-host-v1",
							acceptedCapabilities: ["ai.generateText"],
						},
					},
				}) as BonoboHost,
				{
					host: DEFAULT_HOST,
					pluginRunId: "run_123",
					system: "Summarize uploaded videos.",
					prompt: "Transcript: hello world",
					includeSourceImage: false,
					maxOutputTokens: 400,
				},
			);
			expect(result).toEqual({ text: "workers ai summary" });
			expect(fetchSpy).toHaveBeenCalledTimes(2);
			expect(await hostRequests[0]!.clone().json()).toEqual({
				pluginRunId: "run_123",
				operation: "generateText",
				systemBytes: TEXT_ENCODER.encode("Summarize uploaded videos.").length,
				promptBytes: TEXT_ENCODER.encode("Transcript: hello world").length,
				includeSourceImage: false,
				maxOutputTokens: 400,
			});
			expect(await hostRequests[1]!.clone().json()).toMatchObject({
				pluginRunId: "run_123",
				callId: "call_1",
				status: "succeeded",
				errorMessage: null,
				modelId: "@cf/moonshotai/kimi-k2.6",
				outputTextBytes: TEXT_ENCODER.encode("workers ai summary").length,
			});
			expect(aiRun).toHaveBeenCalledWith("@cf/moonshotai/kimi-k2.6", {
				messages: [
					{ role: "system", content: "Summarize uploaded videos." },
					{ role: "user", content: "Transcript: hello world" },
				],
				max_completion_tokens: 400,
				temperature: 0.2,
			});
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("rejects oversized markdown before calling the host API", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
		try {
			await expect(
				BonoboHost.prototype.writeMarkdown.call(
					{
						ctx: {
							props: {
								pluginStableId: "plugin:media@0.1.0:sha256:abc:bonobo-host-v1",
								acceptedCapabilities: [],
							},
						},
					} as unknown as BonoboHost,
					{
						host: DEFAULT_HOST,
						pluginRunId: "run_123",
						markdown: "x".repeat(LIMITS.outputBytes + 1),
					},
				),
			).rejects.toThrow("size limit");
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("transcribes audio through Workers AI when the plugin has the capability", async () => {
		const aiRun = vi.fn(async () => ({ text: "This is the transcript." }));
		const { fetchSpy, hostRequests } = mock_host_fetch();
		try {
			const result = await BonoboHost.prototype.transcribeAudio.call(
				Object.assign(Object.create(BonoboHost.prototype), {
					env: { AI: { run: aiRun } },
					ctx: {
						props: {
							pluginStableId: "plugin:media@0.1.0:sha256:abc:bonobo-host-v1",
							acceptedCapabilities: ["ai.transcribeAudio"],
						},
					},
				}) as BonoboHost,
				{
					host: DEFAULT_HOST,
					pluginRunId: "run_123",
					audioBase64: "AQID",
					contentType: "audio/mp4",
					language: "en",
				},
			);

			expect(result).toEqual({ text: "This is the transcript." });
			expect(fetchSpy).toHaveBeenCalledTimes(2);
			expect(await hostRequests[0]!.clone().json()).toEqual({
				pluginRunId: "run_123",
				operation: "transcribeAudio",
				requestBytes: 3,
			});
			expect(await hostRequests[1]!.clone().json()).toMatchObject({
				pluginRunId: "run_123",
				callId: "call_1",
				status: "succeeded",
				errorMessage: null,
				modelId: "@cf/openai/whisper-large-v3-turbo",
				requestBytes: 3,
				outputTextBytes: TEXT_ENCODER.encode("This is the transcript.").length,
			});
			expect(aiRun).toHaveBeenCalledWith("@cf/openai/whisper-large-v3-turbo", {
				audio: "AQID",
				language: "en",
			});

			await expect(
				BonoboHost.prototype.transcribeAudio.call(
					Object.assign(Object.create(BonoboHost.prototype), {
						env: { AI: { run: aiRun } },
						ctx: {
							props: {
								pluginStableId: "plugin:media@0.1.0:sha256:abc:bonobo-host-v1",
								acceptedCapabilities: [],
							},
						},
					}) as BonoboHost,
					{
						host: DEFAULT_HOST,
						pluginRunId: "run_123",
						audioBase64: "AQID",
					},
				),
			).rejects.toThrow("Missing capability");
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("extracts Workers AI transcription text from nested response shapes", async () => {
		const aiRun = vi.fn(async () => ({
			transcription_info: { duration: 10 },
			segments: [{ text: "First sentence." }, { text: "Second sentence." }],
		}));
		const { fetchSpy } = mock_host_fetch();
		try {
			const result = await BonoboHost.prototype.transcribeAudio.call(
				Object.assign(Object.create(BonoboHost.prototype), {
					env: { AI: { run: aiRun } },
					ctx: {
						props: {
							pluginStableId: "plugin:media@0.1.0:sha256:abc:bonobo-host-v1",
							acceptedCapabilities: ["ai.transcribeAudio"],
						},
					},
				}) as BonoboHost,
				{
					host: DEFAULT_HOST,
					pluginRunId: "run_123",
					audioBase64: "AQID",
				},
			);

			expect(result).toEqual({ text: "First sentence.\nSecond sentence." });
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("forwards source temporary URL requests through the host API", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ url: "https://source.test/file", expiresAt: 123 }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
		try {
			const result = await BonoboHost.prototype.sourceTemporaryUrl.call(
				{
					ctx: {
						props: {
							pluginStableId: "plugin:media@0.1.0:sha256:abc:bonobo-host-v1",
							acceptedCapabilities: [],
						},
					},
				} as unknown as BonoboHost,
				{
					host: DEFAULT_HOST,
					pluginRunId: "run_123",
					expiresInSeconds: 300,
				},
			);
			expect(result).toEqual({ url: "https://source.test/file", expiresAt: 123 });
			const request = fetchSpy.mock.calls[0]?.[0] as Request;
			expect(request.url).toBe("https://app.example/api/internal/plugins/host/source-temporary-url");
			expect(await request.clone().json()).toEqual({ pluginRunId: "run_123", expiresInSeconds: 300 });
		} finally {
			fetchSpy.mockRestore();
		}
	});

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
							pluginStableId: "plugin:media@0.1.0:sha256:abc:bonobo-host-v1",
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
								pluginStableId: "plugin:media@0.1.0:sha256:abc:bonobo-host-v1",
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

	it("reads bounded source bytes through a temporary host URL", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (request) => {
			const url = request instanceof Request ? request.url : String(request);
			if (url === "https://app.example/api/internal/plugins/host/source-temporary-url") {
				return new Response(JSON.stringify({ url: "https://source.test/video.mp4", expiresAt: 123 }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url === "https://source.test/video.mp4") {
				return new Response(new Uint8Array([1, 2, 3]), {
					status: 200,
					headers: { "Content-Type": "video/mp4" },
				});
			}
			throw new Error(`unexpected fetch ${url}`);
		});
		try {
			const result = await BonoboHost.prototype.sourceBase64.call(
				Object.assign(Object.create(BonoboHost.prototype), {
					ctx: {
						props: {
							pluginStableId: "plugin:media@0.1.0:sha256:abc:bonobo-host-v1",
							acceptedCapabilities: ["uploads.source.read"],
						},
					},
				}) as BonoboHost,
				{
					host: DEFAULT_HOST,
					pluginRunId: "run_123",
					maxBytes: 10,
				},
			);
			expect(result).toEqual({ bodyBase64: "AQID", contentType: "video/mp4", bytes: 3 });
			const request = fetchSpy.mock.calls[0]?.[0] as Request;
			expect(request.url).toBe("https://app.example/api/internal/plugins/host/source-temporary-url");
			expect(await request.clone().json()).toEqual({ pluginRunId: "run_123", expiresInSeconds: 300 });

			await expect(
				BonoboHost.prototype.sourceBase64.call(
					Object.assign(Object.create(BonoboHost.prototype), {
						ctx: {
							props: {
								pluginStableId: "plugin:media@0.1.0:sha256:abc:bonobo-host-v1",
								acceptedCapabilities: [],
							},
						},
					}) as BonoboHost,
					{
						host: DEFAULT_HOST,
						pluginRunId: "run_123",
						maxBytes: 10,
					},
				),
			).rejects.toThrow("Missing capability");
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("brokers outbound fetch only to per-run allowlisted origins", async () => {
		const { fetchSpy, hostRequests } = mock_host_fetch((request) => {
			if (request.url === "https://modal.example/convert") {
				return new Response("service-ok", { status: 200, headers: { "Content-Type": "text/plain" } });
			}
		});
		try {
			// The allowlist entry is an ORIGIN, so https://modal.example/convert passes because its origin matches.
			const result = await BonoboHost.prototype.outboundFetch.call(
				{
					ctx: {
						props: {
							pluginStableId: "plugin:media@0.1.0:sha256:abc:bonobo-host-v1",
							acceptedCapabilities: ["outbound.fetch"],
							outboundOrigins: ["https://modal.example"],
						},
					},
				} as unknown as BonoboHost,
				{
					host: DEFAULT_HOST,
					pluginRunId: "run_123",
					url: "https://modal.example/convert",
					method: "POST",
					headers: { "Content-Type": "application/json" },
					bodyText: "{}",
					responseType: "text",
				},
			);
			expect(result).toEqual({
				status: 200,
				ok: true,
				headers: { "Content-Type": "text/plain" },
				bodyText: "service-ok",
			});
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

			await expect(
				BonoboHost.prototype.outboundFetch.call(
					{
						ctx: {
							props: {
								pluginStableId: "plugin:media@0.1.0:sha256:abc:bonobo-host-v1",
								acceptedCapabilities: ["outbound.fetch"],
								outboundOrigins: ["https://modal.example"],
							},
						},
					} as unknown as BonoboHost,
					{
						host: DEFAULT_HOST,
						pluginRunId: "run_123",
						url: "https://not-allowed.example/convert",
					},
				),
			).rejects.toThrow("origin is not allowed");
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("rejects outbound fetch URLs whose origin does not exactly match the allowlist", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
		try {
			const cases = [
				{ outboundOrigins: ["https://modal.example"], url: "http://modal.example/x", error: "must be HTTPS" },
				{ outboundOrigins: ["https://modal.example"], url: "https://modal.example:8443/x", error: "origin is not allowed" },
				{ outboundOrigins: ["https://modal.example"], url: "https://api.modal.example/x", error: "origin is not allowed" },
				{ outboundOrigins: [], url: "https://api.openai.com/v1/models", error: "origin is not allowed" },
			];
			for (const { outboundOrigins, url, error } of cases) {
				await expect(
					BonoboHost.prototype.outboundFetch.call(
						{
							ctx: {
								props: {
									pluginStableId: "plugin:media@0.1.0:sha256:abc:bonobo-host-v1",
									acceptedCapabilities: ["outbound.fetch"],
									outboundOrigins,
								},
							},
						} as unknown as BonoboHost,
						{ host: DEFAULT_HOST, pluginRunId: "run_123", url },
					),
				).rejects.toThrow(error);
			}
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
			const result = await BonoboHost.prototype.outboundFetch.call(
				{
					ctx: {
						props: {
							pluginStableId: "plugin:media@0.1.0:sha256:abc:bonobo-host-v1",
							acceptedCapabilities: ["outbound.fetch"],
							outboundOrigins: ["https://modal.example"],
						},
					},
				} as unknown as BonoboHost,
				{
					host: DEFAULT_HOST,
					pluginRunId: "run_123",
					url: "https://modal.example/old",
				},
			);
			expect(result).toMatchObject({ status: 301, ok: false });
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
						pluginStableId: "plugin:media@0.1.0:sha256:abc:bonobo-host-v1",
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
			const res = await handle_request(
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
			expect(body.status).toBe("succeeded");
			expect(body.output).toContain("***");
			expect(body.output).not.toContain("super-secret-value-123");
			const logs = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
			expect(logs).not.toContain("super-secret-value-123");
		} finally {
			fetchSpy.mockRestore();
			logSpy.mockRestore();
		}
	});

	it("does not mask secrets shorter than the minimum length", async () => {
		const { fetchSpy } = fetch_secret_during_run("abc12");
		try {
			const res = await handle_request(
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
			expect(body.status).toBe("succeeded");
			expect(body.output).toBe("token=abc12 done");
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("clears tracked secrets when the run finishes", async () => {
		const { fetchSpy } = fetch_secret_during_run("super-secret-value-123");
		try {
			const first = await handle_request(
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
			const second = await handle_request(
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
