import { fileURLToPath } from "node:url";

export default {
	root: fileURLToPath(new URL(".", import.meta.url)),
	resolve: {
		alias: {
			// Node has no runtime-provided Cloudflare modules; tests get the local stubs so importing
			// the Workflow class and NonRetryableError does not crash the collector.
			"cloudflare:workers": fileURLToPath(new URL("./test/cloudflare-workers-stub.ts", import.meta.url)),
			"cloudflare:workflows": fileURLToPath(new URL("./test/cloudflare-workflows-stub.ts", import.meta.url)),
		},
	},
	test: {
		environment: "node",
		include: ["src/**/*.test.ts"],
		// A wrong glob here would print a passing run with zero tests, which reads exactly like a green
		// suite. Fail instead, so a renamed file is caught by the run rather than by a later reader.
		passWithNoTests: false,
	},
};
