import { configDefaults, defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
	resolve: {
		alias: {
			"@": fileURLToPath(new URL("./src", import.meta.url)),
		},
	},
	test: {
		exclude: [...configDefaults.exclude],
		passWithNoTests: true,
		projects: [
			{
				extends: true,
				test: {
					include: ["src/**/*.test.{ts,tsx}", "shared/**/*.test.ts"],
					includeSource: ["src/**/*.{ts,tsx}"],
					name: "src",
					environment: "happy-dom",
					server: {
						deps: {
							// Vendored workspace packages must be inlined for tests,
							// otherwise the runtime tries to execute raw `.ts` sources and fails with unknown extension errors.
							// Keep this list as small as possible and scoped to the convex/server test dependency graph.
							inline: ["@tiptap/extension-collaboration"],
						},
					},
				},
			},
			{
				extends: true,
				test: {
					include: ["convex/**/*.test.ts", "server/**/*.test.ts", "shared/**/*.test.ts"],
					name: "convex",
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
