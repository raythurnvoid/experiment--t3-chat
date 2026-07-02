import { fileURLToPath } from "node:url";

export default {
	root: fileURLToPath(new URL(".", import.meta.url)),
	resolve: {
		alias: {
			"cloudflare:workers": fileURLToPath(new URL("./src/test-cloudflare-workers.ts", import.meta.url)),
		},
	},
	test: {
		include: ["src/**/*.test.ts"],
		environment: "node",
		passWithNoTests: true,
		testTimeout: 30_000,
	},
};
