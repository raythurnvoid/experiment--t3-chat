import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "happy-dom",
		environmentOptions: {
			happyDOM: {
				// bonobo_ui_connect reads parentOrigin/pageId from the embedding iframe URL.
				url: "https://plugin.test/?parentOrigin=https://host.test&pageId=main",
			},
		},
		restoreMocks: true,
		unstubGlobals: true,
	},
});
