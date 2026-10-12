import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { vitest_find_isolated_files } from "./vitest-isolation.ts";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = path.resolve(appRoot, "../..");
const scratchRoot = path.resolve(
	repoRoot,
	"..",
	`${path.basename(repoRoot)}-+personal`,
	"+ai",
	`vitest-isolation-tests-${new Date().toISOString().slice(0, 10)}`,
);
let fixtureRoot: string;

function write_fixture(fileName: string, text: string) {
	const file = path.resolve(fixtureRoot, fileName);
	expect(file.startsWith(fixtureRoot + path.sep)).toBe(true);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
}

describe("vitest_find_isolated_files", () => {
	beforeEach(() => {
		fs.mkdirSync(scratchRoot, { recursive: true });
		fixtureRoot = fs.mkdtempSync(path.join(scratchRoot, "fixture-"));
	});
	afterEach(() => {
		expect(fixtureRoot.startsWith(scratchRoot + path.sep)).toBe(true);
		fs.rmSync(fixtureRoot, { recursive: true, force: true });
	});

	test("isolates a test that imports a helper's permanent generic mock", () => {
		write_fixture("publish.test.ts", 'import { model } from "./review.setup.test.ts";\n');
		write_fixture(
			"review.setup.test.ts",
			"export const model = { submit: vi.fn<(text: string) => Promise<string>>() };\n",
		);
		expect(
			vitest_find_isolated_files(fixtureRoot, ["publish.test.ts"], []),
			"an imported helper's permanent mock requires isolation",
		).toEqual(["publish.test.ts"]);
	});

	test("follows helper re-exports and cycles and finds their module hooks", () => {
		write_fixture("entry.test.ts", 'import "./barrel.test.ts";\n');
		write_fixture("barrel.test.ts", 'export * from "./hooks.setup.test.js";\n');
		write_fixture("hooks.setup.test.ts", 'import "./barrel.test.ts"; beforeEach(() => vi.spyOn(Date, "now"));\n');
		expect(vitest_find_isolated_files(fixtureRoot, ["entry.test.ts"], [])).toEqual(["entry.test.ts"]);
	});

	test("keeps factory helpers and per-file setup hooks shared", () => {
		write_fixture("entry.test.ts", 'import { fixture } from "./factory.setup.test.ts";\n');
		write_fixture("factory.setup.test.ts", 'import "./env.test.ts"; export function fixture() { return vi.fn(); }\n');
		write_fixture("env.test.ts", "afterEach(cleanup);\n");
		expect(vitest_find_isolated_files(fixtureRoot, ["entry.test.ts"], ["./env.test.ts"])).toEqual([]);
	});

	test("ignores type-only helper imports and keeps direct module mock tests isolated", () => {
		write_fixture(
			"types.test.ts",
			'import type { Model } from "./missing.test.ts"; import { type Reply } from "./missing.test.ts";\n',
		);
		write_fixture(
			"barrel.test.ts",
			'export type { Model } from "./missing.test.ts"; export { type Reply } from "./missing.test.ts";\n',
		);
		write_fixture("mock.test.ts", 'vi.mock("module");\n');
		expect(vitest_find_isolated_files(fixtureRoot, ["types.test.ts", "barrel.test.ts", "mock.test.ts"], [])).toEqual([
			"mock.test.ts",
		]);
	});

	test("keeps ordinary Convex fixtures shared and isolates both current publishing tests", () => {
		const files = [
			"convex/files_move_cohorts.test.ts",
			"convex/files_move_scale.test.ts",
			"convex/plugins.test.ts",
			"convex/plugins.publish.test.ts",
		];
		expect(vitest_find_isolated_files(appRoot, files, ["./convex/setup-env.test.ts"])).toEqual([
			"convex/plugins.test.ts",
			"convex/plugins.publish.test.ts",
		]);
	});
});
