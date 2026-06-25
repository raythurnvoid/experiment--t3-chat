import { describe, it, expect, vi } from "vitest";
import {
	handle_request,
	build_executor_module,
	with_wall_timeout,
	WallTimeoutError,
	LIMITS,
	handle_outbound_gateway_request,
	validate_outbound_url,
	type Env,
} from "./index";

const URL_BASE = "https://runner.internal";

type SandboxResult =
	| { ok: true; resultJson: string; logs: string[]; logsTruncated: boolean }
	| { ok: false; error: { name: string; message: string }; logs: string[]; logsTruncated: boolean };

function make_env(opts: {
	secret?: string;
	disabled?: boolean;
	networkDisabled?: boolean;
	evaluate?: (input: unknown, source: string) => SandboxResult | Promise<SandboxResult>;
}): Env {
	const loader = {
		load: (code: { mainModule: string; modules: Record<string, string> }) => ({
			getEntrypoint: () => ({
				evaluate: (input: unknown) =>
					Promise.resolve(
						opts.evaluate
							? opts.evaluate(input, code.modules[code.mainModule])
							: ({ ok: true, resultJson: "null", logs: [], logsTruncated: false } satisfies SandboxResult),
					),
			}),
		}),
	};
	return {
		LOADER: loader as unknown as Env["LOADER"],
		CODE_EXECUTION_RUNNER_SECRET: opts.secret ?? "test-secret",
		CODE_EXECUTION_DISABLED: opts.disabled ? "true" : undefined,
		CODE_EXECUTION_NETWORK_DISABLED: opts.networkDisabled ? "true" : undefined,
	};
}

function make_ctx(
	fetcher: { fetch: (request: Request) => Response | Promise<Response> } = { fetch: async () => new Response("ok") },
	onProps?: (props: unknown) => void,
) {
	return {
		waitUntil: () => {},
		exports: {
			ExecuteCodeHttpGateway: (options: { props: unknown }) => {
				onProps?.(options.props);
				return fetcher;
			},
		},
	};
}

function exec_request(
	rawBody: string,
	headers: Record<string, string> = { Authorization: "Bearer test-secret" },
): Request {
	return new Request(`${URL_BASE}/internal/execute-code`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: rawBody,
	});
}

describe("routing", () => {
	it("returns ok for GET /health", async () => {
		const res = await handle_request(new Request(`${URL_BASE}/health`), make_env({}));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});

	it("returns 404 for unknown routes", async () => {
		const res = await handle_request(new Request(`${URL_BASE}/nope`), make_env({}));
		expect(res.status).toBe(404);
	});
});

describe("auth + kill switch", () => {
	it("rejects requests without a valid bearer token", async () => {
		const res = await handle_request(exec_request(JSON.stringify({ code: "return 1;" }), {}), make_env({}));
		expect(res.status).toBe(401);
	});

	it("rejects requests with the wrong bearer token", async () => {
		const res = await handle_request(
			exec_request(JSON.stringify({ code: "return 1;" }), { Authorization: "Bearer wrong" }),
			make_env({}),
		);
		expect(res.status).toBe(401);
	});

	it("returns 503 when CODE_EXECUTION_DISABLED is set", async () => {
		const res = await handle_request(exec_request(JSON.stringify({ code: "return 1;" })), make_env({ disabled: true }));
		expect(res.status).toBe(503);
		expect((await res.json()).error.code).toBe("disabled");
	});
});

describe("validation + size caps", () => {
	it("rejects invalid JSON", async () => {
		const res = await handle_request(exec_request("{not json"), make_env({}));
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe("invalid_json");
	});

	it("rejects a non-object body", async () => {
		const res = await handle_request(exec_request(JSON.stringify([1, 2, 3])), make_env({}));
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe("invalid_request");
	});

	it("rejects a missing/empty code field", async () => {
		const res = await handle_request(exec_request(JSON.stringify({ input: { n: 1 } })), make_env({}));
		expect(res.status).toBe(400);
	});

	it("rejects code over the size limit", async () => {
		const code = "a".repeat(LIMITS.codeBytes + 1);
		const res = await handle_request(exec_request(JSON.stringify({ code })), make_env({}));
		expect(res.status).toBe(413);
	});

	it("rejects input over the size limit", async () => {
		const input = { blob: "x".repeat(LIMITS.inputBytes + 10) };
		const res = await handle_request(exec_request(JSON.stringify({ code: "return 1;", input })), make_env({}));
		expect(res.status).toBe(413);
	});

	it("rejects a body over the size limit", async () => {
		const big = "x".repeat(LIMITS.bodyBytes + 10);
		const res = await handle_request(exec_request(`{"code":"return 1;","pad":"${big}"}`), make_env({}));
		expect(res.status).toBe(413);
	});
});

describe("execution outcomes", () => {
	it("returns a succeeded result", async () => {
		const env = make_env({
			evaluate: (input) => ({
				ok: true,
				resultJson: JSON.stringify({ doubled: (input as { n: number }).n * 2 }),
				logs: ["hello"],
				logsTruncated: false,
			}),
		});
		const res = await handle_request(
			exec_request(JSON.stringify({ code: "return { doubled: input.n*2 };", input: { n: 2 } })),
			env,
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.status).toBe("succeeded");
		expect(body.result).toEqual({ doubled: 4 });
		expect(body.logs).toEqual(["hello"]);
		expect(body.error).toBeNull();
		expect(typeof body.executionId).toBe("string");
		expect(typeof body.codeHash).toBe("string");
	});

	it("honors a caller-supplied executionId", async () => {
		const env = make_env({});
		const res = await handle_request(
			exec_request(JSON.stringify({ code: "return null;", executionId: "abc-123" })),
			env,
		);
		expect((await res.json()).executionId).toBe("abc-123");
	});

	it("truncates an oversized result", async () => {
		const env = make_env({
			evaluate: () => ({
				ok: true,
				resultJson: `"${"a".repeat(LIMITS.resultBytes + 100)}"`,
				logs: [],
				logsTruncated: false,
			}),
		});
		const res = await handle_request(exec_request(JSON.stringify({ code: "return big;" })), env);
		const body = await res.json();
		expect(body.status).toBe("succeeded");
		expect(body.resultTruncated).toBe(true);
		expect(body.result).toBeNull();
	});

	it("maps a sandbox error to errored", async () => {
		const env = make_env({
			evaluate: () => ({ ok: false, error: { name: "TypeError", message: "boom" }, logs: ["x"], logsTruncated: false }),
		});
		const res = await handle_request(exec_request(JSON.stringify({ code: "throw new TypeError('boom');" })), env);
		const body = await res.json();
		expect(body.status).toBe("errored");
		expect(body.error).toEqual({ name: "TypeError", message: "boom" });
		expect(body.result).toBeNull();
		expect(body.logs).toEqual(["x"]);
	});

	it("maps a sandbox timeout to timed_out", async () => {
		const env = make_env({
			evaluate: () => ({
				ok: false,
				error: { name: "Error", message: "Execution timed out" },
				logs: [],
				logsTruncated: false,
			}),
		});
		const res = await handle_request(exec_request(JSON.stringify({ code: "while(true){}" })), env);
		expect((await res.json()).status).toBe("timed_out");
	});

	it("maps a loader/RPC rejection to errored", async () => {
		const env = make_env({ evaluate: () => Promise.reject(new Error("loader exploded")) });
		const res = await handle_request(exec_request(JSON.stringify({ code: "return 1;" })), env);
		const body = await res.json();
		expect(body.status).toBe("errored");
		expect(body.error.message).toContain("loader exploded");
	});

	it("maps a platform CPU-limit kill to timed_out", async () => {
		const env = make_env({ evaluate: () => Promise.reject(new Error("Worker exceeded CPU time limit.")) });
		const res = await handle_request(exec_request(JSON.stringify({ code: "while(true){}" })), env);
		const body = await res.json();
		expect(body.status).toBe("timed_out");
		expect(body.error.name).toBe("TimeoutError");
		expect(body.error.message).toContain("CPU/time limit");
	});

	it("loads the sandbox with globalOutbound:null and no env/limits", async () => {
		let loaded: Record<string, unknown> | undefined;
		const env = make_env({});
		(env.LOADER as unknown as { load: (code: Record<string, unknown>) => unknown }).load = (code) => {
			loaded = code;
			return {
				getEntrypoint: () => ({
					evaluate: () => Promise.resolve({ ok: true, resultJson: "1", logs: [], logsTruncated: false }),
				}),
			};
		};
		await handle_request(exec_request(JSON.stringify({ code: "return 1;" })), env);
		expect(loaded?.globalOutbound).toBeNull();
		expect(loaded?.env).toBeUndefined();
		expect("limits" in (loaded ?? {})).toBe(false);
		expect(loaded?.compatibilityFlags).toEqual(["nodejs_compat"]);
	});

	it("loads the sandbox with the outbound gateway when network mode is requested", async () => {
		let loaded: Record<string, unknown> | undefined;
		let gatewayProps: unknown;
		const fetcher = { fetch: async () => new Response("ok") };
		const env = make_env({});
		(env.LOADER as unknown as { load: (code: Record<string, unknown>) => unknown }).load = (code) => {
			loaded = code;
			return {
				getEntrypoint: () => ({
					evaluate: () => Promise.resolve({ ok: true, resultJson: "1", logs: [], logsTruncated: false }),
				}),
			};
		};

		await handle_request(
			exec_request(
				JSON.stringify({
					code: "return await fetch('https://example.com').then(r => r.text());",
					network: { mode: "public_http" },
				}),
			),
			env,
			make_ctx(fetcher, (props) => {
				gatewayProps = props;
			}),
		);

		expect(loaded?.globalOutbound).toBe(fetcher);
		expect(loaded?.env).toBeUndefined();
		expect(gatewayProps).toEqual(expect.objectContaining({ allowPublic: true }));
	});

	it("loads the sandbox with app gateway props and synthetic process env", async () => {
		let loaded: Record<string, unknown> | undefined;
		let gatewayProps: unknown;
		let moduleSource = "";
		const fetcher = { fetch: async () => new Response("ok") };
		const env = make_env({});
		(env.LOADER as unknown as { load: (code: Record<string, unknown>) => unknown }).load = (code) => {
			loaded = code;
			moduleSource = (code.modules as Record<string, string>)[code.mainModule as string] ?? "";
			return {
				getEntrypoint: () => ({
					evaluate: () => Promise.resolve({ ok: true, resultJson: "1", logs: [], logsTruncated: false }),
				}),
			};
		};

		await handle_request(
			exec_request(
				JSON.stringify({
					code: "return process.env.T3_APP_ORIGIN;",
					app: { origin: "https://app.example.com/path", token: "grant-token" },
				}),
			),
			env,
			make_ctx(fetcher, (props) => {
				gatewayProps = props;
			}),
		);

		expect(loaded?.globalOutbound).toBe(fetcher);
		expect(loaded?.env).toBeUndefined();
		expect(moduleSource).toContain('"T3_APP_ORIGIN":"https://app.example.com"');
		expect(moduleSource).not.toContain("grant-token");
		expect(gatewayProps).toEqual(
			expect.objectContaining({
				allowPublic: false,
				app: { origin: "https://app.example.com", token: "grant-token" },
			}),
		);
	});

	it("returns a clear preflight error when the outbound gateway is unavailable", async () => {
		const response = await handle_request(
			exec_request(JSON.stringify({ code: "return 1;", network: { mode: "public_http" } })),
			make_env({}),
		);

		expect(response.status).toBe(503);
		const body = await response.json();
		expect(body.error.code).toBe("misconfigured");
		expect(body.error.message).toContain("outbound access is unavailable");
	});

	it("returns 503 when outbound mode is requested and the network kill switch is set", async () => {
		const env = make_env({ networkDisabled: true });
		const response = await handle_request(
			exec_request(JSON.stringify({ code: "return 1;", network: { mode: "public_http" } })),
			env,
			make_ctx(),
		);

		expect(response.status).toBe(503);
		expect((await response.json()).error.message).toContain("outbound access is disabled");
	});

	it("preserves input as ordinary opaque JSON", async () => {
		let evaluatedInput: unknown;
		const env = make_env({});
		(env.LOADER as unknown as { load: (code: Record<string, unknown>) => unknown }).load = (code) => {
			return {
				getEntrypoint: () => ({
					evaluate: (input: unknown) => {
						evaluatedInput = input;
						return Promise.resolve({ ok: true, resultJson: "1", logs: [], logsTruncated: false });
					},
				}),
			};
		};

		await handle_request(
			exec_request(
				JSON.stringify({
					code: "return input.items[0].id;",
					input: { label: "plan", items: [{ id: "a" }], options: { limit: 3 } },
				}),
			),
			env,
		);

		expect(evaluatedInput).toEqual({
			label: "plan",
			items: [{ id: "a" }],
			options: { limit: 3 },
		});
	});

	it("rejects unknown top-level request fields", async () => {
		const response = await handle_request(
			exec_request(
				JSON.stringify({
					code: "return 1;",
					metadata: { source: "test" },
				}),
			),
			make_env({}),
		);

		expect(response.status).toBe(400);
		expect((await response.json()).error.message).toContain("metadata");
	});

	it("rejects invalid network shape", async () => {
		const badNetwork = await handle_request(
			exec_request(JSON.stringify({ code: "return 1;", network: { mode: "inherit" } })),
			make_env({}),
		);
		expect(badNetwork.status).toBe(400);
		expect((await badNetwork.json()).error.message).toContain("network");
	});

	it("operational logs carry only metadata, never raw code/input/result/logs", async () => {
		const env = make_env({
			evaluate: () => ({
				ok: true,
				resultJson: JSON.stringify("SENTINEL_RESULT"),
				logs: ["SENTINEL_LOG"],
				logsTruncated: false,
			}),
		});
		const captured: string[] = [];
		const original = console.log;
		console.log = (...args: unknown[]) => {
			captured.push(args.map((a) => String(a)).join(" "));
		};
		try {
			await handle_request(
				exec_request(JSON.stringify({ code: "return 'SENTINEL_CODE';", input: "SENTINEL_INPUT" })),
				env,
			);
		} finally {
			console.log = original;
		}
		const logged = captured.join("\n");
		expect(logged).toContain("code_execution");
		for (const sentinel of ["SENTINEL_CODE", "SENTINEL_INPUT", "SENTINEL_RESULT", "SENTINEL_LOG"]) {
			expect(logged).not.toContain(sentinel);
		}
	});

	it("maps a non-serializable result to errored", async () => {
		const env = make_env({
			evaluate: () => ({
				ok: false,
				error: { name: "TypeError", message: "Result is not JSON-serializable" },
				logs: [],
				logsTruncated: false,
			}),
		});
		const body = await (await handle_request(exec_request(JSON.stringify({ code: "return () => 1;" })), env)).json();
		expect(body.status).toBe("errored");
		expect(body.error).toEqual({ name: "TypeError", message: "Result is not JSON-serializable" });
		expect(body.result).toBeNull();
	});

	it("passes logsTruncated through from the sandbox", async () => {
		const env = make_env({ evaluate: () => ({ ok: true, resultJson: "1", logs: ["x"], logsTruncated: true }) });
		const body = await (
			await handle_request(exec_request(JSON.stringify({ code: "for(;;)console.log('x');" })), env)
		).json();
		expect(body.logsTruncated).toBe(true);
		expect(body.logs).toEqual(["x"]);
	});

	it("sanitizes a compile/syntax failure into errored", async () => {
		const env = make_env({ evaluate: () => Promise.reject(new SyntaxError("x".repeat(2000))) });
		const body = await (await handle_request(exec_request(JSON.stringify({ code: "return )(;" })), env)).json();
		expect(body.status).toBe("errored");
		expect(body.error.name).toBe("SyntaxError");
		expect(body.error.message.length).toBeLessThanOrEqual(1001);
		expect(body.error.message.endsWith("…")).toBe(true);
	});
});

describe("module generation + wall timeout", () => {
	it("embeds the user code and harness", () => {
		const mod = build_executor_module("return input.n * 2;");
		expect(mod).toContain('import { WorkerEntrypoint } from "cloudflare:workers"');
		expect(mod).toContain("return input.n * 2;");
		expect(mod).toContain("Execution timed out");
		expect(mod).toContain(String(LIMITS.sandboxTimeoutMs));
	});

	it("with_wall_timeout rejects when the promise hangs", async () => {
		await expect(with_wall_timeout(new Promise(() => {}), 20)).rejects.toBeInstanceOf(WallTimeoutError);
	});

	it("with_wall_timeout resolves when the promise settles first", async () => {
		await expect(with_wall_timeout(Promise.resolve(42), 1000)).resolves.toBe(42);
	});
});

describe("outbound gateway", () => {
	it("allows public HTTPS hostnames and blocks unsupported URL forms", () => {
		expect(validate_outbound_url("https://example.com/path")).toEqual(
			expect.objectContaining({ ok: true, hostname: "example.com" }),
		);
		expect(validate_outbound_url("https://example.com./path")).toEqual(
			expect.objectContaining({ ok: true, hostname: "example.com" }),
		);
		expect(validate_outbound_url("http://example.com/path")).toEqual(
			expect.objectContaining({ ok: false, reason: "protocol" }),
		);
		expect(validate_outbound_url("https://127.0.0.1/path")).toEqual(
			expect.objectContaining({ ok: false, reason: "ip_literal" }),
		);
		expect(validate_outbound_url("https://2130706433/path")).toEqual(
			expect.objectContaining({ ok: false, reason: "ip_literal" }),
		);
		expect(validate_outbound_url("https://[::1]/path")).toEqual(
			expect.objectContaining({ ok: false, reason: "ip_literal" }),
		);
		expect(validate_outbound_url("https://service.internal/path")).toEqual(
			expect.objectContaining({ ok: false, reason: "hostname" }),
		);
		expect(validate_outbound_url("https://service/path")).toEqual(
			expect.objectContaining({ ok: false, reason: "hostname" }),
		);
		expect(validate_outbound_url("https://example.com:8443/path")).toEqual(
			expect.objectContaining({ ok: false, reason: "port" }),
		);
	});

	it("strips blocked headers from public requests", async () => {
		const fetchMock = vi.fn(async () => new Response("ok", { headers: { "content-type": "text/plain" } }));
		vi.stubGlobal("fetch", fetchMock);

		try {
			const response = await handle_outbound_gateway_request(
				new Request("https://example.com/resource", {
					headers: {
						Accept: "application/json",
						Authorization: "Bearer secret",
						Cookie: "session=secret",
						Forwarded: "for=192.0.2.60",
						"X-Forwarded-Host": "private.example",
						"X-Forwarded-Proto": "http",
					},
				}),
				{ executionId: "exec_1", allowPublic: true },
			);

			expect(response.status).toBe(200);
			const forwarded = fetchMock.mock.calls[0]?.[0];
			if (!(forwarded instanceof Request)) {
				throw new Error("expected forwarded Request");
			}
			expect(forwarded.headers.get("accept")).toBe("application/json");
			expect(forwarded.headers.get("authorization")).toBe("Bearer secret");
			expect(forwarded.headers.get("cookie")).toBeNull();
			expect(forwarded.headers.get("forwarded")).toBeNull();
			expect(forwarded.headers.get("x-forwarded-host")).toBeNull();
			expect(forwarded.headers.get("x-forwarded-proto")).toBeNull();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("keeps public authorization headers when app access is also available", async () => {
		const fetchMock = vi.fn(async () => new Response("ok"));
		vi.stubGlobal("fetch", fetchMock);

		try {
			const response = await handle_outbound_gateway_request(
				new Request("https://api.example.com/resource", {
					headers: { Authorization: "Bearer public-token" },
				}),
				{
					executionId: "exec_1",
					allowPublic: true,
					app: { origin: "https://app.example.com", token: "grant-token" },
				},
			);

			expect(response.status).toBe(200);
			const forwarded = fetchMock.mock.calls[0]?.[0];
			if (!(forwarded instanceof Request)) {
				throw new Error("expected forwarded Request");
			}
			expect(forwarded.headers.get("authorization")).toBe("Bearer public-token");
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("injects the app grant token only for app public API routes", async () => {
		const fetchMock = vi.fn(async () => new Response("ok"));
		vi.stubGlobal("fetch", fetchMock);

		try {
			const response = await handle_outbound_gateway_request(
				new Request("https://app.example.com/api/v1/files/list", { method: "POST" }),
				{
					executionId: "exec_1",
					allowPublic: false,
					app: { origin: "https://app.example.com", token: "grant-token" },
				},
			);

			expect(response.status).toBe(200);
			const forwarded = fetchMock.mock.calls[0]?.[0];
			if (!(forwarded instanceof Request)) {
				throw new Error("expected forwarded Request");
			}
			expect(forwarded.headers.get("authorization")).toBe("Bearer grant-token");
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("does not forward the app grant token to non-public-API redirects", async () => {
		const fetchMock = vi.fn(async (request: Request) => {
			if (request.url.endsWith("/api/v1/files/list")) {
				return new Response(null, { status: 302, headers: { location: "/not-public-api" } });
			}
			return new Response("ok");
		});
		vi.stubGlobal("fetch", fetchMock);

		try {
			const response = await handle_outbound_gateway_request(
				new Request("https://app.example.com/api/v1/files/list", { method: "POST" }),
				{
					executionId: "exec_1",
					allowPublic: true,
					app: { origin: "https://app.example.com", token: "grant-token" },
				},
			);

			expect(response.status).toBe(200);
			const redirected = fetchMock.mock.calls[1]?.[0];
			if (!(redirected instanceof Request)) {
				throw new Error("expected redirected Request");
			}
			expect(redirected.url).toBe("https://app.example.com/not-public-api");
			expect(redirected.headers.get("authorization")).toBeNull();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("blocks non-app hosts in app-only mode", async () => {
		const fetchMock = vi.fn(async () => new Response("ok"));
		vi.stubGlobal("fetch", fetchMock);

		try {
			const response = await handle_outbound_gateway_request(new Request("https://example.com/resource"), {
				executionId: "exec_1",
				allowPublic: false,
				app: { origin: "https://app.example.com", token: "grant-token" },
			});

			expect(response.status).toBe(403);
			expect(fetchMock).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("rejects unsupported methods and oversize request bodies", async () => {
		const methodResponse = await handle_outbound_gateway_request(
			new Request("https://example.com/resource", { method: "OPTIONS" }),
			{ executionId: "exec_1", allowPublic: true },
		);
		expect(methodResponse.status).toBe(405);

		const bodyResponse = await handle_outbound_gateway_request(
			new Request("https://example.com/resource", {
				method: "POST",
				body: "x".repeat(LIMITS.fetchRequestBytes + 1),
			}),
			{ executionId: "exec_1", allowPublic: true },
		);
		expect(bodyResponse.status).toBe(413);
	});

	it("blocks redirects to disallowed hosts", async () => {
		const fetchMock = vi.fn(
			async () => new Response(null, { status: 302, headers: { location: "https://127.0.0.1/" } }),
		);
		vi.stubGlobal("fetch", fetchMock);

		try {
			const response = await handle_outbound_gateway_request(new Request("https://example.com/redirect"), {
				executionId: "exec_1",
				allowPublic: true,
			});

			expect(response.status).toBe(403);
			expect(fetchMock).toHaveBeenCalledTimes(1);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("truncates large responses from public hosts", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response("x".repeat(LIMITS.fetchResponseBytes + 1), { headers: { "content-type": "text/plain" } }),
			),
		);

		try {
			const response = await handle_outbound_gateway_request(new Request("https://example.com/large"), {
				executionId: "exec_1",
				allowPublic: true,
			});

			expect(response.status).toBe(200);
			expect(response.headers.get("x-execute-code-truncated")).toBe("true");
			expect((await response.text()).length).toBe(LIMITS.fetchResponseBytes);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
