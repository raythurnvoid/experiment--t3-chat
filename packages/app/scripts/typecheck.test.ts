import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = path.resolve(appRoot, "../..");
const scratchRoot = path.resolve(
	repoRoot,
	"..",
	`${path.basename(repoRoot)}-+personal`,
	"+ai",
	`typecheck-tests-${new Date().toISOString().slice(0, 10)}`,
);
const scriptPath = fileURLToPath(new URL("./typecheck.ts", import.meta.url));
let fixtureRoot: string;

function write_fixture(fileName: string, text: string) {
	const filePath = path.resolve(fixtureRoot, fileName);
	expect(filePath.startsWith(fixtureRoot + path.sep)).toBe(true);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, text);
}

function write_config(compilerOptions: Record<string, unknown> = {}, fileName = "tsconfig.json") {
	write_fixture(
		fileName,
		JSON.stringify({
			compilerOptions: {
				target: "ESNext",
				strict: true,
				types: [],
				lib: ["ES5"],
				skipLibCheck: true,
				noEmit: true,
				incremental: true,
				tsBuildInfoFile: path.join(fixtureRoot, "cache.tsbuildinfo"),
				...compilerOptions,
			},
			include: [
				path.join(fixtureRoot, "src"),
				path.join(fixtureRoot, "vendor"),
				path.join(fixtureRoot, "node_modules/sample/index.ts"),
			],
		}),
	);
}

function run_check(configName = "tsconfig.json") {
	const result = spawnSync(process.execPath, ["--import", "tsx", scriptPath, path.join(fixtureRoot, configName)], {
		cwd: appRoot,
		encoding: "utf8",
		timeout: 20_000,
	});
	expect(result.error).toBeUndefined();
	return { status: result.status, output: result.stdout + result.stderr };
}

describe("typecheck", () => {
	beforeEach(() => {
		fs.mkdirSync(scratchRoot, { recursive: true });
		fixtureRoot = fs.mkdtempSync(path.join(scratchRoot, "fixture-"));
		write_fixture("src/index.ts", "export const value: number = 1;\n");
		write_config();
	});

	afterEach(() => {
		expect(fixtureRoot.startsWith(scratchRoot + path.sep)).toBe(true);
		fs.rmSync(fixtureRoot, { recursive: true, force: true });
	});

	test("skips vendor type errors on fresh and cached checks and emits only the cache", () => {
		write_fixture("vendor/index.ts", 'export const vendorValue: number = "vendor";\n');
		write_fixture("node_modules/sample/index.ts", 'export const packageValue: number = "package";\n');
		for (let check = 0; check < 2; check++) {
			const result = run_check();
			expect(result.status).toBe(0);
			expect(result.output).toContain("Visible errors: 0, suppressed errors: 0");
			expect(result.output).not.toContain("TS2322");
		}
		expect(fs.statSync(path.join(fixtureRoot, "cache.tsbuildinfo")).size).toBeGreaterThan(0);
		expect(fs.existsSync(path.join(fixtureRoot, "src/index.js"))).toBe(false);
		expect(fs.existsSync(path.join(fixtureRoot, "src/index.d.ts"))).toBe(false);
	});

	test("keeps app errors visible on cached checks and clears them after a fix", () => {
		write_fixture("src/index.ts", 'export const value: number = "app";\n');
		for (let check = 0; check < 2; check++) {
			const result = run_check();
			expect(result.status).toBe(2);
			expect(result.output).toContain("TS2322");
			expect(result.output).toContain("Visible errors: 1, suppressed errors: 0");
		}
		write_fixture("src/index.ts", "export const value: number = 1;\n");
		const fixed = run_check();
		expect(fixed.status).toBe(0);
		expect(fixed.output).toContain("Visible errors: 0, suppressed errors: 0");
	});

	test("rechecks an unchanged app file when an imported vendor type changes", () => {
		write_fixture("vendor/index.ts", "export const value = 1;\n");
		write_fixture("src/index.ts", 'import { value } from "../vendor/index";\nexport const result: number = value;\n');
		expect(run_check().status).toBe(0);
		write_fixture("vendor/index.ts", 'export const value = "changed";\n');
		const changed = run_check();
		expect(changed.status).toBe(2);
		expect(changed.output).toContain("src/index.ts");
		expect(changed.output).toContain("TS2322");
	});

	test.each(["vendor", "node_modules/sample"])("tracks inferred return types through %s imports", (directory) => {
		write_fixture(`${directory}/value.ts`, "export function get_value() { return 1; }\n");
		write_fixture(`${directory}/index.ts`, 'export { get_value } from "./value";\n');
		write_fixture(
			"src/index.ts",
			`import { get_value } from "../${directory}/index";\nexport const result: number = get_value();\n`,
		);
		expect(run_check().status).toBe(0);
		write_fixture(`${directory}/value.ts`, 'export function get_value() { return "changed"; }\n');
		for (let check = 0; check < 2; check++) {
			const changed = run_check();
			expect(changed.status, changed.output).toBe(2);
			expect(changed.output).toContain("src/index.ts");
			expect(changed.output).toContain("TS2322");
		}
		write_fixture(`${directory}/value.ts`, "export function get_value() { return 2; }\n");
		expect(run_check().status).toBe(0);
	});

	test("rechecks app files when an ignored dependency changes a global type", () => {
		write_fixture("vendor/globals.ts", "declare global { var externalValue: number; }\nexport {};\n");
		write_fixture("src/index.ts", "export const result: number = externalValue;\n");
		expect(run_check().status).toBe(0);
		write_fixture("vendor/globals.ts", "declare global { var externalValue: string; }\nexport {};\n");
		const changed = run_check();
		expect(changed.status, changed.output).toBe(2);
		expect(changed.output).toContain("TS2322");
	});

	test("reports app syntax errors", () => {
		write_fixture("src/index.ts", "export const = 1;\n");
		const result = run_check();
		expect(result.status).toBe(2);
		expect(result.output).toContain("TS1134");
	});

	test("rechecks unchanged files when compiler options change", () => {
		write_fixture("src/index.ts", "export function get_value(value) { return value; }\n");
		write_config({ strict: false });
		expect(run_check().status).toBe(0);
		write_config({ strict: true });
		const result = run_check();
		expect(result.status).toBe(2);
		expect(result.output).toContain("TS7006");
	});

	test("reports invalid config options even inside a vendor folder", () => {
		write_config({ target: "invalid" }, "vendor/tsconfig.json");
		const result = run_check("vendor/tsconfig.json");
		expect(result.status).toBe(2);
		expect(result.output).toContain("TS6046");
	});

	test("reports conflicting compiler options even inside a vendor folder", () => {
		write_config({ module: "CommonJS", moduleResolution: "NodeNext" }, "vendor/tsconfig.json");
		const result = run_check("vendor/tsconfig.json");
		expect(result.status, result.output).toBe(2);
		expect(result.output).toContain("TS5110");
	});

	test("reports missing and malformed config files", () => {
		expect(run_check("missing.json").status).toBe(2);
		write_fixture("vendor/tsconfig.json", "{ broken");
		const malformed = run_check("vendor/tsconfig.json");
		expect(malformed.status, malformed.output).toBe(2);
		expect(malformed.output).toContain("TS");
	});

	test("keeps global errors visible on fresh and cached checks", () => {
		write_config({ noLib: true, lib: undefined });
		for (let check = 0; check < 2; check++) {
			const result = run_check();
			expect(result.status).toBe(2);
			expect(result.output).toContain("TS2318");
			expect(result.output).toContain("Cannot find global type");
		}
	});

	test("rebuilds a cache from a different compiler version", () => {
		expect(run_check().status).toBe(0);
		const cachePath = path.join(fixtureRoot, "cache.tsbuildinfo");
		const cache = fs.readFileSync(cachePath, "utf8");
		write_fixture("cache.tsbuildinfo", cache.replace(/"version":"[^"]+"/, '"version":"0.0.0"'));
		write_fixture("src/index.ts", 'export const value: number = "app";\n');
		const result = run_check();
		expect(result.status).toBe(2);
		expect(result.output).toContain("TS2322");
	});
});
