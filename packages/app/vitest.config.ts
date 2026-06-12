import { configDefaults, defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
	resolve: {
		alias: {
			"@": fileURLToPath(new URL("./src", import.meta.url)),
			"monaco-editor/esm/vs/editor/editor.worker?worker": fileURLToPath(
				new URL("./src/test-stubs/monaco-worker.ts", import.meta.url),
			),
			"monaco-editor": fileURLToPath(new URL("./src/test-stubs/monaco-editor.ts", import.meta.url)),
		},
	},
	test: {
		exclude: [...configDefaults.exclude],
		passWithNoTests: true,
		silent: "passed-only",
		testTimeout: 30_000,
		hookTimeout: 30_000,
		teardownTimeout: 30_000,
		projects: [
			{
				extends: true,
				test: {
					include: ["src/**/*.test.{ts,tsx}", "shared/**/*.test.ts"],
					exclude: ["src/**/*.browser.test.{ts,tsx}"],
					includeSource: ["src/**/*.{ts,tsx}"],
					name: "src",
					environment: "happy-dom",
					server: {
						deps: {
							// Vendored workspace packages must be inlined for tests,
							// otherwise the runtime tries to execute raw `.ts` sources and fails with unknown extension errors.
							// Keep this list as small as possible and scoped to the src test dependency graph.
							inline: ["@liveblocks/core", "@tiptap/extension-collaboration"],
						},
					},
				},
			},
			{
				extends: true,
				test: {
					include: ["src/**/*.browser.test.{ts,tsx}"],
					name: "browser",
					browser: {
						enabled: true,
						provider: "playwright",
						headless: true,
						instances: [{ browser: "chromium" }],
					},
				},
			},
			{
				extends: true,
				test: {
					include: ["convex/**/*.test.ts", "server/**/*.test.ts", "shared/**/*.test.ts"],
					includeSource: ["convex/**/*.ts"],
					name: "convex",
					globals: true,
					environment: "edge-runtime",
					server: {
						deps: {
							// Vendored workspace packages must be inlined for tests,
							// otherwise the runtime tries to execute raw `.ts` sources and fails with unknown extension errors.
							// Keep this list as small as possible and scoped to the convex/server test dependency graph.
							inline: ["convex-test", "@tiptap/extension-collaboration"],
						},
					},
					setupFiles: ["./convex/setup.test.ts"],
				},
			},
		],
	},
});
