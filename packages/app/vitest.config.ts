import { configDefaults, defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";
import tailwindcss from "@tailwindcss/vite";
import { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default defineConfig({
	plugins: [
		{
			// Vite writes the `VITE_*` values from `.env` into the transformed code, and the fs module
			// cache key does not include them. Add them, so a changed `.env` does not run old code.
			name: "fs-module-cache-env-key",
			configureVitest({ experimental_defineCacheKeyGenerator }) {
				experimental_defineCacheKeyGenerator(({ environment }) => JSON.stringify(environment.config.env));
			},
		},
	],
	resolve: {
		alias: {
			"@": fileURLToPath(new URL("./src", import.meta.url)),
			"cloudflare:workers": fileURLToPath(new URL("../plugin-runner/src/test-cloudflare-workers.ts", import.meta.url)),
			"monaco-editor/editor/editor.worker?worker": fileURLToPath(
				new URL("./src/test-stubs/monaco-worker.ts", import.meta.url),
			),
			"monaco-editor": fileURLToPath(new URL("./src/test-stubs/monaco-editor.ts", import.meta.url)),
		},
	},
	test: {
		exclude: [...configDefaults.exclude],
		// Pin the zone so a local-day rule that reads the date as UTC fails its test on every machine.
		// On a UTC machine `new Date(2026, 8, 4)` equals `Date.UTC(2026, 8, 4)`, so that rule would
		// pass there. London has summer time, so local and UTC differ for most of the year.
		env: { TZ: "Europe/London" },
		passWithNoTests: true,
		// Keep transformed modules on disk, so the next run skips most transforms (Babel with the React
		// Compiler in src, the vendored TypeScript packages everywhere). The key is the file path, its
		// content, the config and the lockfile. Run `vitest --clearCache` if a vendored package changes
		// how its imports resolve without a lockfile change.
		experimental: {
			fsModuleCache: true,
			// Worktrees often link `node_modules` to the main checkout, so the default cache folder in
			// `node_modules` is shared by every checkout. On Windows a cache write fails with EPERM while
			// another run reads the same file, so keep one cache folder per checkout.
			fsModuleCachePath: join(
				tmpdir(),
				"vitest-fs-module-cache",
				createHash("sha256")
					.update(fileURLToPath(new URL(".", import.meta.url)))
					.digest("hex")
					.slice(0, 16),
			),
		},
		silent: "passed-only",
		// Keep fewer copies of app code in memory at once.
		maxWorkers: "50%",
		testTimeout: 30_000,
		// Slow full-size checks carry this tag and run only with test:files:full-size (vitest.full-size.config.ts).
		// A tag does not depend on the test name, and `-t` cannot select a tagged test here.
		tags: [{ name: "full-size", description: "Slow full-size checks. Run them with test:files:full-size." }],
		tagsFilter: ["!full-size"],
		hookTimeout: 30_000,
		teardownTimeout: 30_000,
		projects: [
			{
				extends: true,
				test: {
					include: ["scripts/**/*.test.ts"],
					name: "scripts",
					environment: "node",
				},
			},
			{
				extends: true,
				plugins: [
					// Run the React Compiler like the app and the browser project do, so src tests run the same compiled code.
					// Some bugs only happen in compiled code. Keep these settings in sync with vite.config.ts.
					babel({
						presets: [
							reactCompilerPreset({
								target: "19",
								sources: (filename: string) =>
									["./src", "./vendor/novel", "./vendor/polar", "./vendor/tiptap", "../native-popovers/src"].some(
										(dir) => filename.startsWith(fileURLToPath(new URL(dir, import.meta.url))),
									),
							}),
						],
					}),
				],
				test: {
					include: ["src/**/*.test.{ts,tsx}", "shared/**/*.test.ts"],
					// Shared tests run here and in the convex project, because shared code must work in both
					// runtimes. The diff budget files compute for about 30 s each, and their step counts are the
					// same in every runtime, so they run only in the convex project.
					exclude: [
						"src/**/*.browser.test.{ts,tsx}",
						"shared/files.diff_budgets.test.ts",
						"shared/files.diff_refusal.test.ts",
					],
					includeSource: ["src/**/*.{ts,tsx}"],
					name: "src",
					// happy-dom is pinned to 20.3.5 in package.json. From 20.3.6 on, a click inside a
					// `<summary>` opens its `<details>` even when React calls `preventDefault()`, and the
					// Pending changes tests fail. Check those tests before you upgrade it.
					environment: "happy-dom",
					setupFiles: ["./src/test-stubs/happy-dom-apis.ts"],
					server: {
						deps: {
							// Vendored workspace packages must be inlined for tests,
							// otherwise the runtime tries to execute raw `.ts` sources and fails with unknown extension errors.
							// Keep this list as small as possible and scoped to the src test dependency graph.
							//
							// `react-tweet` ships CSS imports the runtime cannot execute, and the browser
							// extension-list test imports it through `novel`.
							inline: ["@tiptap/extension-collaboration", "react-tweet"],
						},
					},
				},
			},
			{
				extends: true,
				plugins: [
					// Browser layout tests need the same utility styles as the app.
					tailwindcss({ optimize: false }),
					// Run the React Compiler like the app and the src project do, so browser tests run the same compiled code.
					// Some bugs only happen in compiled code. Keep these settings in sync with vite.config.ts.
					babel({
						presets: [
							reactCompilerPreset({
								target: "19",
								sources: (filename: string) =>
									["./src", "./vendor/novel", "./vendor/polar", "./vendor/tiptap", "../native-popovers/src"].some(
										(dir) => filename.startsWith(fileURLToPath(new URL(dir, import.meta.url))),
									),
							}),
						],
					}),
				],
				// Prepare this dynamic dependency before a browser test can trigger a reload.
				optimizeDeps: { include: ["react-dom/server"] },
				test: {
					include: ["src/**/*.browser.test.{ts,tsx}"],
					name: "browser",
					browser: {
						enabled: true,
						provider: playwright(),
						headless: true,
						instances: [{ browser: "chromium" }],
					},
				},
			},
			{
				extends: true,
				resolve: {
					alias: [
						// The package index also loads every other locale, 0.4 s to 1.7 s more in each test file.
						// `locale/en` exports the same `faker` object, and the tests use only that.
						{ find: /^@faker-js\/faker$/, replacement: "@faker-js/faker/locale/en" },
					],
				},
				test: {
					include: ["convex/**/*.test.ts", "server/**/*.test.ts", "shared/**/*.test.ts"],
					// Setup helpers have no tests, but each one would still take a worker and import the app.
					exclude: [...configDefaults.exclude, "**/setup.test.ts", "**/setup-*.test.ts", "**/*.setup.test.ts"],
					includeSource: ["convex/**/*.ts", "server/bash.ts", "server/server-ai-tools.ts"],
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
					// Preload only environment values; helper imports would load app modules before per-file mocks.
					setupFiles: ["./convex/setup-env.test.ts"],
				},
			},
		],
	},
});
