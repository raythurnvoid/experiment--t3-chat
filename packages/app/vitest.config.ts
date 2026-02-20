import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		exclude: [...configDefaults.exclude],
		passWithNoTests: true,
		projects: [
			{
				extends: true,
				test: {
					include: ["src/**/*.test.{ts,tsx}"],
					name: "src",
				},
			},
			{
				extends: true,
				test: {
					include: ["convex/**/*.test.ts", "server/**/*.test.ts"],
					name: "convex",
					environment: "edge-runtime",
					server: {
						deps: {
							// Vendored workspace packages must be inlined for convex/edge-runtime tests,
							// otherwise Node tries to execute raw `.ts` sources and fails with unknown extension errors.
							// Keep this list as small as possible and scoped to the convex/server test dependency graph.
							inline: [
								"convex-test",
								"@tiptap/extension-collaboration",
							],
						},
					},
					setupFiles: ["./convex/setup.test.ts"],
				},
			},
		],
	},
});
