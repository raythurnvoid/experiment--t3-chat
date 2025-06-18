import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import path from "node:path";
import { resolve } from "node:path";

// https://vite.dev/config/
export default defineConfig({
	plugins: [
		tanstackRouter({
			target: "react",
			autoCodeSplitting: true,
			verboseFileRoutes: false,
		}),
		react(),
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
			ignored: [resolve("+personal/**")],
		},
	},
	optimizeDeps: {
		entries: [
			// Necessary to prevent vite from crawling the `+personal` folder
			"./index.html",
		],
	},
});
