import { fileURLToPath } from "node:url";

export default {
	root: fileURLToPath(new URL(".", import.meta.url)),
	resolve: {
		alias: {
			"cloudflare:workers": fileURLToPath(new URL("./src/test-cloudflare-workers.ts", import.meta.url)),
			"@cloudflare/playwright": fileURLToPath(new URL("./src/test-playwright.ts", import.meta.url)),
		},
	},
	test: {
		environment: "node",
		include: ["src/**/*.test.ts"],
	},
};
