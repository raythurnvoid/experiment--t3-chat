import { spawnSync } from "node:child_process";
import { globSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const vitestRoot = path.dirname(require.resolve("vitest/package.json"));

function run_console(errorKind: "teardown" | "reporter") {
	const consoleChunks = globSync("dist/chunks/console.*.js", { cwd: vitestRoot });
	const utilsChunks = globSync("dist/chunks/utils.*.js", { cwd: vitestRoot }).filter((file) =>
		readFileSync(path.join(vitestRoot, file), "utf8").includes("class EnvironmentTeardownError"),
	);
	expect(consoleChunks).toHaveLength(1);
	expect(utilsChunks).toHaveLength(1);
	// A child keeps the real unhandled rejection separate from Vitest's own worker.
	const code = `
		import { pathToFileURL } from "node:url";
		const { createCustomConsole } = await import(pathToFileURL(process.argv[1]).href);
		const utils = await import(pathToFileURL(process.argv[2]).href);
		const TeardownError = Object.values(utils).find(value => typeof value === "function" && value.name === "EnvironmentTeardownError");
		if (!TeardownError) throw Error("The installed teardown error is missing");
		const logs = [];
		const errors = [];
		process.on("unhandledRejection", error => errors.push({ name: error.name, message: error.message }));
		const console = createCustomConsole({
			config: { root: process.cwd() },
			current: { id: "console-teardown" },
			rpc: { onUserConsoleLog(log) {
				logs.push(log.content);
				return Promise.reject(process.argv[3] === "teardown" ? new TeardownError("worker closed") : new Error("reporter failed"));
			} },
		});
		console.log("posted test log");
		await new Promise(resolve => setImmediate(resolve));
		await new Promise(resolve => setImmediate(resolve));
		process.stdout.write(JSON.stringify({ logs, errors }));
	`;
	const result = spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			code,
			path.join(vitestRoot, consoleChunks[0]),
			path.join(vitestRoot, utilsChunks[0]),
			errorKind,
		],
		{ cwd: appRoot, encoding: "utf8", timeout: 10_000 },
	);
	expect(result.error).toBeUndefined();
	expect(result.status, result.stderr).toBe(0);
	return JSON.parse(result.stdout) as { logs: string[]; errors: Array<{ name: string; message: string }> };
}

describe("Vitest console replies", () => {
	test("keeps a posted log when its worker closes before the reply", () => {
		const result = run_console("teardown");
		expect(result.logs).toEqual(["posted test log\n"]);
		// This fails when node_modules was installed before the patch. Run pnpm install again.
		expect(
			result.errors,
			"a posted log must not fail when its worker has closed (is patches/vitest@4.1.10.patch installed?)",
		).toEqual([]);
	});

	test("keeps reporter errors that are not worker teardown errors", () => {
		const result = run_console("reporter");
		expect(result.logs).toEqual(["posted test log\n"]);
		expect(result.errors).toEqual([{ name: "Error", message: "reporter failed" }]);
	});
});
