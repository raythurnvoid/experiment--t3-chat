import { describe, it, expect, vi } from "vitest";
import { runInNewContext } from "node:vm";
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

function make_env(opts: {
	secret?: string;
	disabled?: boolean;
	networkDisabled?: boolean;
	evaluate?: (input: unknown, source: string) => unknown | Promise<unknown>;
}): Env {
	const loader = {
		load: (code: { mainModule: string; modules: Record<string, string> }) => ({
			getEntrypoint: () => ({
				evaluate: (input: unknown) =>
					Promise.resolve(
						opts.evaluate
							? opts.evaluate(input, code.modules[code.mainModule])
							: { ok: true, resultJson: "null", logs: [], logsTruncated: false, files: [] },
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

/**
 * Run the real generated module instead of a fake sandbox, so these tests cover the harness code
 * the runner ships. `runInNewContext` runs a plain script, not an ES module, so the Cloudflare
 * import and the `export default` are removed first.
 */
function evaluate_module(input: unknown, source: string, fetch?: typeof globalThis.fetch): Promise<unknown> {
	const script = source
		.replace('import { WorkerEntrypoint } from "cloudflare:workers";', "")
		.replace("export default class", "class");
	return runInNewContext(`${script}\nnew CodeExecutor().evaluate(input)`, {
		WorkerEntrypoint: class {},
		input,
		Uint8Array,
		ArrayBuffer,
		TextEncoder,
		TextDecoder,
		fetch,
		console: {},
		setTimeout,
		clearTimeout,
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
	it.each([
		{ origin: "https://app.example.com", token: "old-token" },
		{ origin: "https://app.example.com", token: "old-token", tokens: { current: "a", personal: "b" } },
		{ origin: "https://app.example.com", tokens: { current: "a" } },
		{ origin: "https://app.example.com", tokens: { personal: "b" } },
		{ origin: "https://app.example.com", tokens: { current: "", personal: "b" } },
		{ origin: "https://app.example.com", tokens: { current: "a", personal: "" } },
		{ origin: "https://app.example.com", tokens: { current: 1, personal: "b" } },
		{ origin: "https://app.example.com", tokens: { current: "a", personal: null } },
		{ origin: "https://app.example.com", tokens: { current: "a".repeat(513), personal: "b" } },
		{ origin: "https://app.example.com", tokens: { current: "a", personal: "b".repeat(513) } },
		{ origin: "https://app.example.com", tokens: { current: "a", personal: "b", third: "c" } },
	])("rejects an invalid app token contract %#", async (app) => {
		const evaluate = vi.fn();
		const response = await handle_request(
			exec_request(JSON.stringify({ code: "return 1;", app })), make_env({ evaluate }), make_ctx(),
		);
		expect(response.status).toBe(400);
		expect((await response.json()).error.code).toBe("invalid_request");
		expect(evaluate).not.toHaveBeenCalled();
	});

	it.each([false, true])("reads and emits both workspaces in one snippet with equal tokens=%s", async (sameHome) => {
		const app = {
			origin: "https://app.example.com",
			tokens: { current: "current-grant-token", personal: sameHome ? "current-grant-token" : "personal-grant-token" },
		};
		const gatewayProps = { executionId: "two-roots", allowPublic: false, app };
		const fetchMock = vi.fn(async (request: Request) => {
			expect(request.headers.get("x-bonobo-workspace")).toBeNull();
			return new Response(new Uint8Array([request.headers.get("authorization") === `Bearer ${app.tokens.current}` ? 1 : 2]));
		});
		const logs = vi.spyOn(console, "log").mockImplementation(() => {});
		vi.stubGlobal("fetch", fetchMock);
		try {
			const code = `
				for (const workspace of ["current", "personal"]) {
					const response = await fetch(process.env.T3_APP_ORIGIN + "/api/v1/files/read-bytes", {
						method: "POST", headers: { "X-Bonobo-Workspace": workspace }, body: JSON.stringify({ path: "/input.bin" }),
					});
					if (!response.ok) throw new Error("Read failed");
					emitFile({ workspace, path: "/output.bin", bytes: await response.arrayBuffer() });
				}
				console.log(process.env);
				return { env: process.env, input };
			`;
			const response = await handle_request(
				exec_request(JSON.stringify({ code, app, executionId: "two-roots", input: { value: 1 } })),
				make_env({ evaluate: (input, source) => {
					expect(source).not.toContain("grant-token");
					return evaluate_module(input, source, async (url, init) =>
						handle_outbound_gateway_request(new Request(url, init), gatewayProps));
				} }),
				make_ctx(undefined, (props) => expect(props).toEqual(gatewayProps)),
			);
			const text = await response.text();
			const body = JSON.parse(text);
			expect(body.status).toBe("succeeded");
			expect(body.result).toEqual({ env: { T3_APP_ORIGIN: app.origin }, input: { value: 1 } });
			expect(body.files).toEqual([
				{ workspace: "current", path: "/output.bin", dataBase64: "AQ==" },
				{ workspace: "personal", path: "/output.bin", dataBase64: sameHome ? "AQ==" : "Ag==" },
			]);
			expect(fetchMock.mock.calls.map(([request]) => request.headers.get("authorization"))).toEqual([
				`Bearer ${app.tokens.current}`, `Bearer ${app.tokens.personal}`,
			]);
			expect(text).not.toContain("grant-token");
			expect(JSON.stringify(logs.mock.calls)).not.toContain("grant-token");
		} finally {
			logs.mockRestore();
			vi.unstubAllGlobals();
		}
	});

	it("returns a succeeded result", async () => {
		const env = make_env({
			evaluate: (input) => ({
				ok: true,
				resultJson: JSON.stringify({ doubled: (input as { n: number }).n * 2 }),
				logs: ["hello"],
				logsTruncated: false,
				files: [],
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
				files: [],
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
					evaluate: () => Promise.resolve({ ok: true, resultJson: "1", logs: [], logsTruncated: false, files: [] }),
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
					evaluate: () => Promise.resolve({ ok: true, resultJson: "1", logs: [], logsTruncated: false, files: [] }),
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
					evaluate: () => Promise.resolve({ ok: true, resultJson: "1", logs: [], logsTruncated: false, files: [] }),
				}),
			};
		};

		await handle_request(
			exec_request(
				JSON.stringify({
					code: "return process.env.T3_APP_ORIGIN;",
					app: { origin: "https://app.example.com/path", tokens: { current: "current-grant-token", personal: "personal-grant-token" } },
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
				app: { origin: "https://app.example.com", tokens: { current: "current-grant-token", personal: "personal-grant-token" } },
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
						return Promise.resolve({ ok: true, resultJson: "1", logs: [], logsTruncated: false, files: [] });
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
				files: [],
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
		const env = make_env({
			evaluate: () => ({ ok: true, resultJson: "1", logs: ["x"], logsTruncated: true, files: [] }),
		});
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

describe("emitFile", () => {
	it.each([undefined, null, "", "home", "CURRENT", 1])("rejects workspace %s inside the harness", async (workspace) => {
		const result = await evaluate_module(null, build_executor_module(`
			emitFile({ workspace: "current", path: "/first", bytes: new Uint8Array([1]) });
			emitFile({ workspace: ${JSON.stringify(workspace)}, path: "/bad", bytes: new Uint8Array([2]) });
		`));
		expect(result).toMatchObject({ ok: false, error: { name: "TypeError", message: "emitFile workspace must be current or personal" } });
		const body = await (await handle_request(
			exec_request(JSON.stringify({ code: "invalid workspace" })), make_env({ evaluate: () => result }),
		)).json();
		expect(body.status).toBe("errored");
		expect(body.files).toEqual([]);
	});

	it("copies sliced views and buffers without changing their bytes", async () => {
		// The code below overwrites the source array after emitting. The emitted files must still hold
		// the old bytes, which proves emitFile copied them. A sliced view must give only its 3 bytes.
		const code = `
			const source = new Uint8Array([7, 0, 255, 128, 9]);
			emitFile({ workspace: "current", path: "/out/unknown", contentType: "application/x-custom", bytes: source.subarray(1, 4) });
			emitFile({ workspace: "personal", path: "/out/buffer.bin", bytes: source.buffer });
			emitFile({ workspace: "current", path: "/out/empty", bytes: new Uint8Array() });
			source.fill(1);
			return "done";
		`;
		const response = await handle_request(
			exec_request(JSON.stringify({ code })),
			make_env({ evaluate: evaluate_module }),
		);
		const body = await response.json();

		expect(body.status).toBe("succeeded");
		expect(body.result).toBe("done");
		expect(body.files).toEqual([
			{ workspace: "current", path: "/out/unknown", contentType: "application/x-custom", dataBase64: "AP+A" },
			{ workspace: "personal", path: "/out/buffer.bin", dataBase64: "BwD/gAk=" },
			{ workspace: "current", path: "/out/empty", dataBase64: "" },
		]);
	});

	it("allows the exact byte limit within the HTTP response cap", async () => {
		const code = `
			const bytes = new Uint8Array(${LIMITS.fileBytes});
			bytes[0] = 255;
			bytes[bytes.length - 1] = 128;
			emitFile({ workspace: "current", path: "/out/full.bin", bytes });
		`;
		const response = await handle_request(
			exec_request(JSON.stringify({ code })),
			make_env({ evaluate: evaluate_module }),
		);
		const text = await response.text();
		const body = JSON.parse(text);
		const bytes = Uint8Array.from(atob(body.files[0].dataBase64), (char) => char.charCodeAt(0));

		expect(body.status).toBe("succeeded");

		// Base64 makes the JSON body about a third larger than the raw bytes. A file at the exact byte
		// limit must still fit in the 12 MiB reply the app is willing to read, so check that size too.
		expect(new TextEncoder().encode(text).byteLength).toBeLessThan(12 * 1024 * 1024);
		expect(bytes.byteLength).toBe(LIMITS.fileBytes);
		expect(bytes[0]).toBe(255);
		expect(bytes.at(-1)).toBe(128);
	});

	it("allows eight empty files across both workspaces", async () => {
		const code = `for (let i = 0; i < ${LIMITS.files}; i++) emitFile({ workspace: i % 2 ? "personal" : "current", path: "/out/" + i, bytes: new ArrayBuffer(0) });`;
		const body = await (
			await handle_request(exec_request(JSON.stringify({ code })), make_env({ evaluate: evaluate_module }))
		).json();

		expect(body.status).toBe("succeeded");
		expect(body.files).toHaveLength(LIMITS.files);
	});

	// Files leave the sandbox only after a fully successful run. Each failure below must drop the
	// file that emitFile already accepted before it.
	it.each([
		["count", `for (let i = 0; i < ${LIMITS.files}; i++) emitFile({ workspace: i % 2 ? "personal" : "current", path: "/out/" + i, bytes: new Uint8Array() });`],
		["bytes", `emitFile({ workspace: "current", path: "/out/big", bytes: new Uint8Array(${LIMITS.fileBytes + 1}) });`],
		["total bytes", `emitFile({ workspace: "personal", path: "/out/second", bytes: new Uint8Array(${LIMITS.fileBytes}) });`],
		["path", `emitFile({ workspace: "current", path: "x".repeat(${LIMITS.filePathChars + 1}), bytes: new Uint8Array() });`],
		[
			"MIME",
			`emitFile({ workspace: "current", path: "/out/type", contentType: "x".repeat(${LIMITS.fileContentTypeChars + 1}), bytes: new Uint8Array() });`,
		],
		["byte type", 'emitFile({ workspace: "current", path: "/out/text", bytes: "not bytes" });'],
		["throw", 'throw new Error("stop");'],
		["result serialization", "return 1n;"],
	])("drops all files after a %s failure", async (_name, failure) => {
		const code = `emitFile({ workspace: "current", path: "/out/first", bytes: new Uint8Array([1]) });\n${failure}`;
		const body = await (
			await handle_request(exec_request(JSON.stringify({ code })), make_env({ evaluate: evaluate_module }))
		).json();

		expect(body.status).toBe("errored");
		expect(body.files).toEqual([]);
	});

	it("drops files when execution times out", async () => {
		vi.useFakeTimers();
		try {
			// Run the sandbox on its own and move the fake clock until its internal timeout fires. Then
			// replay that reply through the host to see what the caller gets back.
			const pending = evaluate_module(
				null,
				build_executor_module(
					'emitFile({ workspace: "current", path: "/out/first", bytes: new Uint8Array([1]) }); await new Promise(() => {});',
				),
			);
			await vi.advanceTimersByTimeAsync(LIMITS.sandboxTimeoutMs);
			const result = await pending;

			const response = await handle_request(
				exec_request(JSON.stringify({ code: "timeout" })),
				make_env({ evaluate: () => result }),
			);
			const body = await response.json();

			expect(body.status).toBe("timed_out");
			expect(body.files).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps a Unicode log within the byte cap", async () => {
		const body = await (
			await handle_request(
				exec_request(JSON.stringify({ code: `console.log("é".repeat(${LIMITS.logBytes}));` })),
				make_env({ evaluate: evaluate_module }),
			)
		).json();

		expect(body.status).toBe("succeeded");
		expect(body.logsTruncated).toBe(true);

		// "é" takes two bytes in UTF-8. The log cap counts bytes, not characters, so the kept text must
		// measure exactly logBytes.
		expect(new TextEncoder().encode(body.logs[0]).byteLength).toBe(LIMITS.logBytes);
	});
});

describe("sandbox result validation", () => {
	// User code runs in the same scope as the harness, so it can return any shape it wants over RPC.
	// The host must check every field again and return no files when the reply does not match.
	const file = { workspace: "current", path: "/out/file.bin", bytes: new Uint8Array([0, 255]) };
	const valid = { ok: true, resultJson: "null", logs: [], logsTruncated: false, files: [file] };

	it.each([undefined, null, "", "home", "CURRENT", 1])("refuses forged workspace %s in the host", async (workspace) => {
		const body = await (await handle_request(
			exec_request(JSON.stringify({ code: "return null;" })),
			make_env({ evaluate: () => ({ ...valid, files: [file, { ...file, workspace }] }) }),
		)).json();
		expect(body.status).toBe("errored");
		expect(body.files).toEqual([]);
	});

	it.each([
		["null reply", null],
		["success flag", { ...valid, ok: "true" }],
		["missing files", { ...valid, files: undefined }],
		["file count", { ...valid, files: Array.from({ length: LIMITS.files + 1 }, (_, i) => ({ ...file, workspace: i % 2 ? "personal" : "current" })) }],
		["file bytes", { ...valid, files: [{ ...file, bytes: new Uint8Array(LIMITS.fileBytes + 1) }] }],
		["total bytes", { ...valid, files: [file, { ...file, workspace: "personal", bytes: new Uint8Array(LIMITS.fileBytes) }] }],
		["byte array type", { ...valid, files: [file, { ...file, bytes: [0, 255] }] }],
		["path type", { ...valid, files: [{ ...file, path: 123 }] }],
		["path length", { ...valid, files: [{ ...file, path: "a".repeat(LIMITS.filePathChars + 1) }] }],
		["MIME type", { ...valid, files: [{ ...file, contentType: 123 }] }],
		["MIME length", { ...valid, files: [{ ...file, contentType: "a".repeat(LIMITS.fileContentTypeChars + 1) }] }],
		["result type", { ...valid, resultJson: {} }],
		["invalid JSON", { ...valid, resultJson: "{" }],
		["log type", { ...valid, logs: [123] }],
		["log count", { ...valid, logs: Array.from({ length: LIMITS.logLines + 1 }, () => "") }],
		["log bytes", { ...valid, logs: ["é".repeat(LIMITS.logBytes)] }],
		["total log bytes", { ...valid, logs: ["x".repeat(LIMITS.logBytes), "x"] }],
		["log flag", { ...valid, logsTruncated: "false" }],
		["error type", { ...valid, ok: false, error: { name: 123, message: "bad" } }],
	])("refuses a forged %s without returning files", async (_name, reply) => {
		const body = await (
			await handle_request(exec_request(JSON.stringify({ code: "return null;" })), make_env({ evaluate: () => reply }))
		).json();

		expect(body.status).toBe("errored");
		expect(body.result).toBeNull();
		expect(body.files).toEqual([]);
	});

	it("ignores files attached to a forged failure", async () => {
		const body = await (
			await handle_request(
				exec_request(JSON.stringify({ code: "throw Error();" })),
				make_env({ evaluate: () => ({ ...valid, ok: false, error: { name: "Error", message: "bad" } }) }),
			)
		).json();

		expect(body.status).toBe("errored");
		expect(body.files).toEqual([]);
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
	it.each([undefined, "", "home", "CURRENT", "current, personal"])("rejects app selector %s before fetching", async (selector) => {
		const fetchMock = vi.fn(async () => new Response("ok"));
		vi.stubGlobal("fetch", fetchMock);
		try {
			const headers = new Headers();
			if (selector !== undefined) headers.set("X-Bonobo-Workspace", selector);
			const response = await handle_outbound_gateway_request(
				new Request("https://app.example.com/api/v1/files/list", { method: "POST", headers }),
				{ executionId: "exec_1", allowPublic: true, app: { origin: "https://app.example.com", tokens: { current: "a", personal: "b" } } },
			);
			expect(response.status).toBe(400);
			expect(fetchMock).not.toHaveBeenCalled();
		} finally { vi.unstubAllGlobals(); }
	});

	it.each([false, true])("blocks public redirects from gaining app authority after leaving app=%s", async (startInApp) => {
		const fetchMock = vi.fn(async (request: Request) => new Response(null, {
			status: 302,
			headers: { location: request.url.endsWith("/api/v1/files/list") ? "https://public.example.com/redirect" : "https://app.example.com/api/v1/files/read" },
		}));
		vi.stubGlobal("fetch", fetchMock);
		try {
			const response = await handle_outbound_gateway_request(
				new Request(startInApp ? "https://app.example.com/api/v1/files/list" : "https://public.example.com/redirect", {
					headers: { "X-Bonobo-Workspace": "personal" },
				}),
				{ executionId: "exec_1", allowPublic: true, app: { origin: "https://app.example.com", tokens: { current: "a", personal: "b" } } },
			);
			expect(response.status).toBe(403);
			expect(fetchMock).toHaveBeenCalledTimes(startInApp ? 2 : 1);
			for (const [request] of fetchMock.mock.calls) {
				expect(request.headers.get("x-bonobo-workspace")).toBeNull();
				if (request.url.startsWith("https://public.example.com/")) expect(request.headers.get("authorization")).toBeNull();
			}
		} finally { vi.unstubAllGlobals(); }
	});

	it("keeps the selected grant on redirects within the app file API only", async () => {
		const fetchMock = vi.fn(async (request: Request) => request.url.endsWith("/list")
			? new Response(null, { status: 307, headers: { location: "/api/v1/files/read" } }) : new Response("ok"));
		vi.stubGlobal("fetch", fetchMock);
		try {
			const response = await handle_outbound_gateway_request(
				new Request("https://app.example.com/api/v1/files/list", { headers: { "X-Bonobo-Workspace": "personal" } }),
				{ executionId: "exec_1", allowPublic: false, app: { origin: "https://app.example.com", tokens: { current: "a", personal: "b" } } },
			);
			expect(response.status).toBe(200);
			expect(fetchMock).toHaveBeenCalledTimes(2);
			for (const [request] of fetchMock.mock.calls) {
				expect(request.headers.get("authorization")).toBe("Bearer b");
				expect(request.headers.get("x-bonobo-workspace")).toBeNull();
			}
		} finally { vi.unstubAllGlobals(); }
	});

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
						"X-Bonobo-Workspace": "personal",
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
			expect(forwarded.headers.get("x-bonobo-workspace")).toBeNull();
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
					headers: { Authorization: "Bearer public-token", "X-Bonobo-Workspace": "personal" },
				}),
				{
					executionId: "exec_1",
					allowPublic: true,
					app: { origin: "https://app.example.com", tokens: { current: "current-grant-token", personal: "personal-grant-token" } },
				},
			);

			expect(response.status).toBe(200);
			const forwarded = fetchMock.mock.calls[0]?.[0];
			if (!(forwarded instanceof Request)) {
				throw new Error("expected forwarded Request");
			}
			expect(forwarded.headers.get("authorization")).toBe("Bearer public-token");
			expect(forwarded.headers.get("x-bonobo-workspace")).toBeNull();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it.each(["current", "personal"])("injects only the %s app grant and strips the selector", async (workspace) => {
		const fetchMock = vi.fn(async () => new Response("ok"));
		vi.stubGlobal("fetch", fetchMock);

		try {
			const response = await handle_outbound_gateway_request(
				new Request("https://app.example.com/api/v1/files/list", {
					method: "POST", headers: { "X-Bonobo-Workspace": workspace, Authorization: "Bearer user-token" },
				}),
				{
					executionId: "exec_1",
					allowPublic: false,
					app: { origin: "https://app.example.com", tokens: { current: "current-grant-token", personal: "personal-grant-token" } },
				},
			);

			expect(response.status).toBe(200);
			const forwarded = fetchMock.mock.calls[0]?.[0];
			if (!(forwarded instanceof Request)) {
				throw new Error("expected forwarded Request");
			}
			expect(forwarded.headers.get("authorization")).toBe(`Bearer ${workspace}-grant-token`);
			expect(forwarded.headers.get("x-bonobo-workspace")).toBeNull();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("reads one MiB through the byte API with only the named file headers", async () => {
		const bytes = new Uint8Array(LIMITS.fileReadResponseBytes).map((_, index) => index % 256);
		vi.stubGlobal("fetch", vi.fn(async () => new Response(bytes, { headers: {
			"Content-Type": "application/octet-stream", "X-File-Content-Type": "application/x-custom",
			"X-File-Revision": "revision-1", "X-File-Size": "2097152", "X-File-Offset": "0",
			"Set-Cookie": "private", "X-Private": "secret",
		} })));
		try {
			const response = await handle_outbound_gateway_request(new Request("https://app.example.com/api/v1/files/read-bytes", {
				method: "POST", headers: { "X-Bonobo-Workspace": "personal" }, body: JSON.stringify({ path: "/reports/input.bin", offset: 0, length: bytes.length, revision: null }),
			}), { executionId: "exec_1", allowPublic: false, app: { origin: "https://app.example.com", tokens: { current: "current-grant-token", personal: "personal-grant-token" } } });
			expect(response.status).toBe(200);
			expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
			expect(Object.fromEntries(response.headers)).toEqual({
				"cache-control": "no-store", "content-type": "application/octet-stream", "x-file-content-type": "application/x-custom",
				"x-file-revision": "revision-1", "x-file-size": "2097152", "x-file-offset": "0",
			});
		} finally { vi.unstubAllGlobals(); }
	});

	it.each([
		["https://app.example.com/api/v1/files/read-bytes", "GET"],
		["https://app.example.com/api/v1/files/read-bytes/", "POST"],
		["https://app.example.com/api/v1/files/read", "POST"],
		["https://other.example.com/api/v1/files/read-bytes", "POST"],
	])("keeps the public body limit for %s %s", async (url, method) => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(LIMITS.fetchResponseBytes + 1))));
		try {
			const response = await handle_outbound_gateway_request(new Request(url, { method, headers: { "X-Bonobo-Workspace": "current" } }), {
				executionId: "exec_1", allowPublic: true, app: { origin: "https://app.example.com", tokens: { current: "current-grant-token", personal: "personal-grant-token" } },
			});
			expect(response.status).toBe(413);
		} finally { vi.unstubAllGlobals(); }
	});

	it("refuses byte reads over one MiB and cancels their body", async () => {
		const cancel = vi.fn();
		vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({
			start(controller) { controller.enqueue(new Uint8Array(LIMITS.fileReadResponseBytes + 1)); }, cancel,
		}))));
		try {
			const response = await handle_outbound_gateway_request(new Request("https://app.example.com/api/v1/files/read-bytes", { method: "POST", headers: { "X-Bonobo-Workspace": "personal" } }), {
				executionId: "exec_1", allowPublic: false, app: { origin: "https://app.example.com", tokens: { current: "current-grant-token", personal: "personal-grant-token" } },
			});
			expect(response.status).toBe(413);
			expect(cancel).toHaveBeenCalledOnce();
		} finally { vi.unstubAllGlobals(); }
	});

	it.each(["/api/v1/files/list", "/elsewhere", "https://other.example.com/read"])("does not redirect a byte read to %s", async (location) => {
		const cancel = vi.fn();
		const fetchMock = vi.fn(async () => new Response(new ReadableStream({ cancel }), { status: 307, headers: { location } }));
		vi.stubGlobal("fetch", fetchMock);
		try {
			const response = await handle_outbound_gateway_request(new Request("https://app.example.com/api/v1/files/read-bytes", {
				method: "POST", headers: { "X-Bonobo-Workspace": "personal" }, body: "private file request",
			}), { executionId: "exec_1", allowPublic: true, app: { origin: "https://app.example.com", tokens: { current: "current-grant-token", personal: "personal-grant-token" } } });
			expect(response.status).toBe(403);
			expect(fetchMock).toHaveBeenCalledOnce();
			expect(cancel).toHaveBeenCalledOnce();
		} finally { vi.unstubAllGlobals(); }
	});

	it.each(["https://app.example.com/not-public-api", "https://other.example.com/redirect"])("does not forward the app grant or selector to %s", async (location) => {
		const fetchMock = vi.fn(async (request: Request) => {
			if (request.url.endsWith("/api/v1/files/list")) {
				return new Response(null, { status: 302, headers: { location } });
			}
			return new Response("ok");
		});
		vi.stubGlobal("fetch", fetchMock);

		try {
			const response = await handle_outbound_gateway_request(
				new Request("https://app.example.com/api/v1/files/list", { method: "POST", headers: { "X-Bonobo-Workspace": "personal" } }),
				{
					executionId: "exec_1",
					allowPublic: true,
					app: { origin: "https://app.example.com", tokens: { current: "current-grant-token", personal: "personal-grant-token" } },
				},
			);

			expect(response.status).toBe(200);
			const redirected = fetchMock.mock.calls[1]?.[0];
			if (!(redirected instanceof Request)) {
				throw new Error("expected redirected Request");
			}
			expect(redirected.url).toBe(location);
			expect(redirected.headers.get("authorization")).toBeNull();
			for (const [request] of fetchMock.mock.calls) {
				expect(request.headers.get("x-bonobo-workspace")).toBeNull();
			}
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
				app: { origin: "https://app.example.com", tokens: { current: "current-grant-token", personal: "personal-grant-token" } },
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

	it("refuses large responses instead of returning partial file bytes", async () => {
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

			expect(response.status).toBe(413);
			expect(response.headers.get("x-execute-code-truncated")).toBeNull();
			expect(await response.text()).toBe("Response body too large");
		} finally {
			vi.unstubAllGlobals();
		}
	});

	// The Response constructor refuses a body for these statuses, so the gateway must pass them
	// through untouched instead of rebuilding them.
	it.each([204, 205, 304])("preserves a %s response with no body", async (status) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(null, { status })),
		);

		try {
			const response = await handle_outbound_gateway_request(new Request("https://example.com/empty"), {
				executionId: "exec_1",
				allowPublic: true,
			});

			expect(response.status).toBe(status);
			expect(response.body).toBeNull();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it.each([false, true])("keeps the original deadline while reading a stalled response body with file read=%s", async (fileRead) => {
		vi.useFakeTimers();
		let fetchSignal: AbortSignal | null = null;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_request: Request, init?: RequestInit) => {
				const signal = init?.signal;
				if (!signal) throw new Error("Expected an abort signal");
				fetchSignal = signal;
				await new Promise((resolve) => setTimeout(resolve, LIMITS.fetchTimeoutMs - 1000));
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new Uint8Array([1]));
							signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
						},
					}),
				);
			}),
		);

		try {
			const pending = handle_outbound_gateway_request(new Request(fileRead ? "https://app.example.com/api/v1/files/read-bytes" : "https://example.com/stalled", { method: fileRead ? "POST" : "GET", headers: { "X-Bonobo-Workspace": "personal" } }), {
				executionId: "exec_1",
				allowPublic: true,
				app: { origin: "https://app.example.com", tokens: { current: "current-grant-token", personal: "personal-grant-token" } },
			});
			// Attach the rejection check before moving the clock. Otherwise the promise rejects with no
			// handler yet and Node reports an unhandled rejection.
			const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });

			// The deadline starts when the request starts, not when the body arrives. So stop one
			// millisecond short and check nothing aborted yet, then step over the deadline.
			await vi.advanceTimersByTimeAsync(LIMITS.fetchTimeoutMs - 1);
			expect(fetchSignal).toMatchObject({ aborted: false });
			await vi.advanceTimersByTimeAsync(1);
			await rejected;
			expect(fetchSignal).toMatchObject({ aborted: true });
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.unstubAllGlobals();
			vi.useRealTimers();
		}
	});
});
