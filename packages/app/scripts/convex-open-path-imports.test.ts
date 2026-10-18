import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

// Use the esbuild that the Convex CLI bundles with. The app has no esbuild of its own, and the
// Convex copy matches how the deployment resolves imports.
const esbuild: {
	build(options: object): Promise<{ metafile: { inputs: Record<string, { imports: Array<{ path: string }> }> } }>;
} = createRequire(createRequire(appRoot + "package.json").resolve("convex/package.json"))("esbuild");

describe("convex/files_yjs_load.ts imports", () => {
	// Convex loads a module and all its imports on every action call. Removing zod here cut the
	// snapshot action from about 58ms to 27ms, so the file open path must not import it. A zod
	// import in `schema.ts`, `functions.ts` or one of their imports brings it back here.
	test("do not load zod", async () => {
		const result = await esbuild.build({
			entryPoints: [appRoot + "convex/files_yjs_load.ts"],
			bundle: true,
			write: false,
			metafile: true,
			format: "esm",
			platform: "browser",
			conditions: ["convex"],
			logLevel: "silent",
		});

		const inputs = Object.entries(result.metafile.inputs);
		expect(inputs.length).toBeGreaterThan(100);

		// List the files outside zod that import it, so a failure names the file to fix.
		const zodPath = /node_modules\/(\.pnpm\/[^/]+\/node_modules\/)?zod\//;
		const zodImporters = inputs
			.filter(([path, input]) => !zodPath.test(path) && input.imports.some((imported) => zodPath.test(imported.path)))
			.map(([path]) => path);
		expect(zodImporters).toEqual([]);
	});
});
