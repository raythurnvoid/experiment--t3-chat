import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		exclude: [...configDefaults.exclude],
		// exclude: [...configDefaults.exclude, "+personal/**/*"],
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
							inline: ["convex-test"],
						},
					},
					setupFiles: ["./convex/test.setup.ts"],
				},
			},
		],
	},
});
