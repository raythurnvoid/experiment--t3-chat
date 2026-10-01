import { describe, it, expect, vi } from "vitest";
import { runInNewContext } from "node:vm";
import { build_executor_module, snippet_executor_check_state, snippet_executor_LIMITS as LIMITS } from "./snippet-executor";

describe("build_executor_module", () => {
	function run_snippet(code: string, budgetMs = 1000, state: string | null = null) {
		const screenshot = Uint8Array.from(
			Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+Xf6sAAAAASUVORK5CYII=",
				"base64",
			),
		);
		const outer = { url: () => "https://controller.browser.invalid/v0", childFrames: () => [{}] };
		const page = {
			on: () => {},
			mainFrame: () => ({ childFrames: () => [outer] }),
			setViewportSize: async () => {},
			viewportSize: () => ({ width: 1280, height: 900 }),
			screenshot: async () => screenshot,
		};
		const source =
			build_executor_module(code)
				.replace(/^import .*;$/gm, "")
				.replace("export default class", "class") + "\nSnippetExecutor;";
		const Executor = runInNewContext(source, {
			WorkerEntrypoint: class {},
			TextEncoder,
			URL,
			Uint8Array,
			ArrayBuffer,
			console: {},
			expect: () => {},
			setTimeout,
			clearTimeout,
			connect: async () => ({ contexts: () => [{ pages: () => [page] }], close: async () => {} }),
		}) as new () => {
			evaluate: (input: unknown) => Promise<{
				ok: boolean;
				files?: Array<{ workspace: "current" | "personal"; path: string; contentType?: string; bytes: Uint8Array }>;
				resultJson?: string;
				timedOut?: boolean;
				stateJson: string | null;
				stateWarnings: string[];
				error?: { message: string };
			}>;
		};
		return new Executor().evaluate({
			endpointId: "fixture",
			mode: "file",
			runtimeOrigin: "https://controller.browser.invalid",
			viewport: { width: 1280, height: 900 },
			budgetMs,
			state,
		});
	}

	it.each([undefined, null, "", "home", "CURRENT", 1])(
		"rejects workspace %s inside the browser harness",
		async (workspace) => {
			const result = await run_snippet(`
			emitFile({ workspace: "personal", path: "/first.bin", bytes: new Uint8Array([1]) });
			emitFile({ workspace: ${JSON.stringify(workspace)}, path: "/bad.bin", bytes: new Uint8Array([2]) });
		`);
			expect(result).toMatchObject({ ok: false, error: { message: "emitFile workspace must be current or personal" } });
			expect(result.files).toBeUndefined();
		},
	);

	it("emits a screenshot and arbitrary binary bytes through the same helper", async () => {
		const result = await run_snippet(`
			const source = new Uint8Array([99, 0, 255, 128, 99]);
			emitFile({ workspace: "current", path: "/reports/slice.bin", bytes: source.subarray(1, 4) });
			emitFile({ workspace: "personal", path: "/reports/buffer.bin", bytes: source.buffer, contentType: "application/x-custom" });
			emitFile({ workspace: "current", path: "/reports/empty", bytes: new ArrayBuffer(0) });
			emitFile({ workspace: "personal", path: "/reports/page.png", bytes: await page.screenshot() });
			source.fill(5);
		`);
		expect(result.ok).toBe(true);
		expect(result.files?.slice(0, 3)).toEqual([
			{ workspace: "current", path: "/reports/slice.bin", bytes: new Uint8Array([0, 255, 128]) },
			{
				workspace: "personal",
				path: "/reports/buffer.bin",
				bytes: new Uint8Array([99, 0, 255, 128, 99]),
				contentType: "application/x-custom",
			},
			{ workspace: "current", path: "/reports/empty", bytes: new Uint8Array() },
		]);
		expect(result.files?.[3]?.bytes.slice(0, 8)).toEqual(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
		expect(result.files?.[3]?.workspace).toBe("personal");
	});

	it("allows the exact file and byte budgets", async () => {
		const result = await run_snippet(
			`for (let i = 0; i < ${LIMITS.files}; i++) emitFile({ workspace: i % 2 ? "personal" : "current", path: "/reports/" + i, bytes: new Uint8Array(${LIMITS.fileBytes / LIMITS.files}) });`,
		);
		expect(result.ok).toBe(true);
		expect(result.files).toHaveLength(LIMITS.files);
		expect(result.files?.reduce((sum, file) => sum + file.bytes.byteLength, 0)).toBe(LIMITS.fileBytes);
	});

	it.each([
		`for (let i = 0; i < ${LIMITS.files}; i++) emitFile({ workspace: i % 2 ? "personal" : "current", path: "/reports/" + i, bytes: new Uint8Array() });`,
		`emitFile({ workspace: "personal", path: "/reports/large", bytes: new Uint8Array(${LIMITS.fileBytes}) });`,
		`emitFile({ workspace: "current", path: "/reports/bad", bytes: "text" });`,
		`emitFile({ workspace: "current", path: "", bytes: new Uint8Array() });`,
		`emitFile({ workspace: "current", path: "/reports/bad", contentType: null, bytes: new Uint8Array() });`,
		`throw new Error("failed");`,
	])("drops all emitted files when the snippet fails", async (failure) => {
		const result = await run_snippet(
			`emitFile({ workspace: "current", path: "/reports/first", bytes: new Uint8Array([1]) }); ${failure}`,
		);
		expect(result.ok).toBe(false);
		expect(result.files).toBeUndefined();
	});

	it("drops emitted files on timeout and clears the timer after success", async () => {
		vi.useFakeTimers();
		try {
			const pending = run_snippet(
				'emitFile({ workspace: "current", path: "/reports/first", bytes: new Uint8Array([1]) }); await new Promise(() => {});',
				50,
			);
			await vi.advanceTimersByTimeAsync(50);
			expect(await pending).toMatchObject({ ok: false, timedOut: true, error: { message: "Execution timed out" } });
			expect((await pending).files).toBeUndefined();
			expect((await run_snippet("return 1;")).ok).toBe(true);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("caps Unicode console and log output in the running harness", async () => {
		const inner = {};
		const outer = { url: () => "https://controller.browser.invalid/v0", childFrames: () => [inner] };
		const page = {
			on: (event: string, callback: (message: { type: () => string; text: () => string }) => void) => {
				if (event === "console")
					for (let i = 0; i < 10; i++) callback({ type: () => "log", text: () => "€".repeat(500) });
			},
			mainFrame: () => ({ childFrames: () => [outer] }),
			setViewportSize: async () => {},
			viewportSize: () => ({ width: 1280, height: 900 }),
		};
		const source =
			build_executor_module('console.log("€".repeat(6000)); return 42;')
				.replace(/^import .*;$/gm, "")
				.replace("export default class", "class") + "\nSnippetExecutor;";
		const Executor = runInNewContext(source, {
			WorkerEntrypoint: class {},
			TextEncoder,
			URL,
			console: {},
			expect: () => {},
			setTimeout: () => 0,
			clearTimeout: () => {},
			connect: async () => ({ contexts: () => [{ pages: () => [page] }], close: async () => {} }),
		}) as new () => {
			evaluate: (
				input: unknown,
			) => Promise<{ ok: boolean; logs: string[]; consoleEntries: string[]; logsTruncated: boolean }>;
		};
		const result = await new Executor().evaluate({
			endpointId: "fixture",
			mode: "file",
			runtimeOrigin: "https://controller.browser.invalid",
			viewport: { width: 1280, height: 900 },
			budgetMs: 1000,
		});
		expect(result.ok).toBe(true);
		expect(result.logsTruncated).toBe(true);
		expect(result.logs).toEqual(["€".repeat(5461)]);
		expect(
			result.consoleEntries.reduce((sum, line) => sum + new TextEncoder().encode(line).length, 0),
		).toBeLessThanOrEqual(LIMITS.consoleBytes);
	});

	it("gives web and shared-tab snippets the main frame without waiting for a preview frame", async () => {
		const mainFrame = { childFrames: () => [] };
		const setViewportSize = vi.fn(async () => {});
		const page = {
			on: () => {},
			mainFrame: () => mainFrame,
			setViewportSize,
			viewportSize: () => ({ width: 1280, height: 900 }),
		};
		const source =
			build_executor_module(
				'try { emitFile({ workspace: "current", path: "/a", bytes: new Uint8Array() }); } catch (e) { return e.message; }\nreturn frame === page.mainFrame();',
			)
				.replace(/^import .*;$/gm, "")
				.replace("export default class", "class") + "\nSnippetExecutor;";
		const Executor = runInNewContext(source, {
			WorkerEntrypoint: class {},
			TextEncoder,
			URL,
			Uint8Array,
			ArrayBuffer,
			console: {},
			expect: () => {},
			setTimeout,
			clearTimeout,
			connect: async () => ({ contexts: () => [{ pages: () => [page] }], close: async () => {} }),
		}) as new () => { evaluate: (input: unknown) => Promise<{ ok: boolean; resultJson?: string }> };
		const result = await new Executor().evaluate({
			endpointId: "fixture",
			mode: "web",
			runtimeOrigin: null,
			viewport: { width: 1280, height: 900 },
			budgetMs: 1000,
		});
		expect(result).toMatchObject({ ok: true, resultJson: "true" });
		expect(setViewportSize).toHaveBeenCalledTimes(1);
		// The shared tab keeps the user's window size and cannot save files yet.
		expect(await new Executor().evaluate({ endpointId: "fixture", mode: "shared", budgetMs: 1000 })).toMatchObject({
			ok: true,
			resultJson: JSON.stringify("Saving files from the shared tab is not available yet."),
		});
		expect(setViewportSize).toHaveBeenCalledTimes(1);
		// Only web mode may skip the runtime origin.
		await expect(
			new Executor().evaluate({
				endpointId: "fixture",
				mode: "file",
				runtimeOrigin: null,
				viewport: { width: 1280, height: 900 },
				budgetMs: 1000,
			}),
		).rejects.toThrow("Missing runtime origin.");
	});

	it.each([
		"async ({ page }) => {\n\tawait page.title();\n\treturn 1;\n}",
		"// Read the title.\nasync (page) => page.title()",
		"page => 1",
		"async function main({ page }) {\n\treturn 1;\n}",
		"return async ({ page }) => 1;",
	])("refuses a snippet that only defines or returns a function: %s", async (code) => {
		expect(await run_snippet(code)).toMatchObject({
			ok: false,
			error: { message: "Your code returned a function. Write the function body only, do not wrap it in a function." },
		});
	});

	it.each([
		["return 1;", "1"],
		["(async () => 1)();", "null"],
		["async function helper() { return 2; }\nawait helper();", "null"],
		[
			'function helper() {}\nemitFile({ workspace: "current", path: "/a", bytes: new Uint8Array() });\nhelper();',
			"null",
		],
		["const run = async () => 3;\nreturn await run();", "3"],
	])("runs a snippet that uses its own functions: %s", async (code, resultJson) => {
		expect(await run_snippet(code)).toMatchObject({ ok: true, resultJson });
	});

	it("wraps user code with the registered page harness", () => {
		const module = build_executor_module("return 42;");
		expect(module).toContain("return 42;");
		expect(module).toContain('from "./pw.js"');
		expect(module).toContain("persistent=true&browser_binding=BROWSER");
		expect(module).not.toContain("providerSessionId");
		expect(module).toContain("setViewportSize");
		expect(module).toContain(".call(undefined, page, frame, expect, emitFile, state)");
		expect(module).toContain("Preview frame not found");
		expect(module).toContain("emitFile");
	});

	it("keeps plain JSON state between calls, even when the snippet throws", async () => {
		const first = await run_snippet("state.count = (state.count ?? 0) + 1; return state.count;", 1000, null);
		expect(first).toMatchObject({ ok: true, resultJson: "1", stateJson: '{"count":1}', stateWarnings: [] });

		const second = await run_snippet('state.count += 1; throw new Error("failed");', 1000, first.stateJson);
		expect(second).toMatchObject({ ok: false, stateJson: '{"count":2}' });
	});

	it("drops browser objects and other non-JSON values from state with a warning", async () => {
		const result = await run_snippet(
			"state.page = page; state.when = new Date(0); state.list = [1, () => 2]; state.n = 1; state.self = state;",
		);
		expect(JSON.parse(result.stateJson!)).toEqual({ list: [1, null], n: 1 });
		expect(result.stateWarnings.map((warning) => warning.split(" ")[0])).toEqual([
			"state.page",
			"state.when",
			"state.list[1]",
			"state.self",
		]);
	});

	it("does not save state over the size limit", async () => {
		const result = await run_snippet(`state.big = "x".repeat(${LIMITS.stateBytes});`);
		expect(result.stateJson).toBeNull();
		expect(result.stateWarnings[0]).toContain("larger than");
	});
});

describe("snippet_executor_check_state", () => {
	it.each([
		['{"a":1}', '{"a":1}'],
		["[1]", null],
		["null", null],
		["{", null],
		[1, null],
		[JSON.stringify({ big: "x".repeat(LIMITS.stateBytes) }), null],
	])("accepts only a plain JSON object under the size limit (case %#)", (value, expected) => {
		expect(snippet_executor_check_state(value)).toBe(expected);
	});
});
