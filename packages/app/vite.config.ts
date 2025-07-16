import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import path from "node:path";

// https://vite.dev/config/
export default defineConfig({
	plugins: [
		tanstackRouter({
			target: "react",
			autoCodeSplitting: true,
			verboseFileRoutes: false,
		}),
		react({
			// https://react.dev/learn/react-compiler
			babel: {
				plugins: [
					[
						"babel-plugin-react-compiler",
						{
							target: "19",
							sources: (filename: string) => {
								// Compile only `src/` stuff
								return filename.startsWith(path.resolve(__dirname, "src"));
							},
						},
					],
				],
			},
		}),
		tailwindcss(),
	],
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
		},
	},
	server: {
		// Ignore +personal folder for dev server
		fs: {
			deny: ["+personal/**"],
		},
		// Exclude +personal folder from being watched, they need to be absolute paths globs
		watch: {
			ignored: [path.resolve("+personal/**")],
		},
	},
	optimizeDeps: {
		entries: [
			// Necessary to prevent vite from crawling the `+personal` folder
			"./index.html",
		],
		exclude: [
			// Exclude assistant-ui packages from pre-bundling so they're treated as source files
			"@assistant-ui/react",
			"@assistant-ui/react-ai-sdk",
			"@assistant-ui/react-markdown",
			"assistant-cloud",
			"@assistant-ui/react-edge",
		],
	},
});
