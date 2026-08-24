import { defineConfig, type Plugin } from "vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// import type { Logger, LoggerEvent } from "babel-plugin-react-compiler";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Make every stylesheet the app serves declare the cascade layer order before its own rules.
 *
 * A layer's position is fixed by the first declaration the browser sees, and a later `@layer a, b;`
 * statement cannot reorder layers that already exist. The production build splits css per chunk and
 * links one file per chunk, and nothing in Vite lets us choose which chunk comes first. So the chunk
 * holding app.css, where the order is declared, arrived last, and the browser built its own order
 * from whatever loaded before it. Tailwind preflight sits in `@layer base` and resets padding,
 * margin and border on every element, so it won against the component layers and the app lost its
 * padding, its buttons and its tabs.
 *
 * Rather than try to control the load order, give every stylesheet the same opening line. Whichever
 * one the browser reads first establishes the right order and the rest are no-ops. app.css stays
 * the single place a person edits the order; this plugin copies it.
 */
function vite_plugin_css_layer_order(appCssPath: string): Plugin {
	// Read once when the plugin is created, so a missing statement fails the build immediately with
	// the path in the message instead of silently shipping the broken order again.
	const source = readFileSync(appCssPath, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
	const names = /@layer\s+([^;{]+);/.exec(source)?.[1];
	if (!names) {
		throw new Error(`Failed to find a @layer order statement in ${appCssPath}`);
	}

	const layerNames = names.split(",").map((name) => name.trim());
	const opening = `@layer ${layerNames.join(", ")};\n`;

	// Tailwind reformats the statement app.css declares when it expands that file, so the copies
	// cannot be found by string equality. Match the names instead, and tolerate any spacing. The
	// trailing `\s*` swallows the newline so removing a copy leaves no blank line behind.
	const anyCopy = new RegExp(`@layer\\s+${layerNames.join(",\\s*")}\\s*;\\s*`, "g");

	return {
		name: "app-css-layer-order",

		// Prepend per module rather than only per built file. Two reasons. The dev server does not
		// split css, so this is the only hook that reaches it. And in the build this text becomes
		// part of each module's content, which is what the asset hash is computed from, so editing
		// the order in app.css gives every css file a new name. generateBundle runs after hashing,
		// so a prepend there alone would change the bytes while leaving the file name untouched,
		// and a returning browser would keep serving the old order out of its cache.
		transform(code, id) {
			if (!id.split("?")[0].endsWith(".css")) return null;

			// This project turns css sourcemaps off in both modes, so shifting every file down by
			// one line costs nothing. Turning them on means generating a map here.
			return { code: opening + code, map: null };
		},

		// Build only. Each built file concatenates many modules, so it arrives holding one copy of
		// the opening line per module, plus the one app.css declares itself. Drop them all and put
		// a single copy back at the top.
		generateBundle(_options, bundle) {
			for (const asset of Object.values(bundle)) {
				if (asset.type !== "asset" || !asset.fileName.endsWith(".css")) continue;

				const css = typeof asset.source === "string" ? asset.source : Buffer.from(asset.source).toString("utf8");
				asset.source = opening + css.replace(anyCopy, "");
			}
		},
	};
}

// https://vite.dev/config/
export default defineConfig({
	plugins: [
		tanstackRouter({
			target: "react",
			autoCodeSplitting: true,
			routeFileIgnorePattern: "\\.test\\.",
			verboseFileRoutes: false,
		}),
		react(),
		babel({
			// https://react.dev/learn/react-compiler
			presets: [
				reactCompilerPreset({
					target: "19",
					// logger: {
					// 	logEvent(filename, event) {
					// 		if (!filename) return;

					// 		if (filename.includes(`ariakit`)) {
					// 			console.log("ariakit", filename);
					// 		}
					// 	},
					// } satisfies Logger,
					environment: {
						// Adds extra annotations useful when inspecting compiler output.
						enableMemoizationComments: true,
					},
					sources: (filename: string) => {
						return (
							filename.startsWith(path.resolve(__dirname, "src")) ||
							filename.startsWith(path.resolve(__dirname, "vendor/novel")) ||
							filename.startsWith(path.resolve(__dirname, "vendor/polar")) ||
							filename.startsWith(path.resolve(__dirname, "vendor/tiptap"))
						);
					},
				}),
			],
		}),
		tailwindcss({
			optimize: false,
		}),
		// Keep last so it prepends to css Tailwind has already expanded.
		vite_plugin_css_layer_order(path.resolve(__dirname, "src/app.css")),
	],
	server: {
		watch: {
			// Agent and docs files live under the watched tree but are not app sources; editing
			// them during a live session must not trigger HMR or full reloads.
			ignored: [
				"**/.claude/**",
				"**/.agents/**",
				"**/AGENTS.md",
				"**/CLAUDE.md",
			],
		},
	},
	build: {
		target: "esnext",
		cssTarget: "esnext",
		cssMinify: false,
	},
	resolve: {
		dedupe: ["react", "react-dom"],
		alias: [
			{
				find: "@",
				replacement: path.resolve(__dirname, "./src"),
			},
		],
	},
	optimizeDeps: {
		entries: ["./index.html"],
		exclude: [
			// Exclude vendored packages from pre-bundling so they're treated as source files
			"@convex-dev/presence",
			"@convex-dev/polar",
			"@convex-dev/rate-limiter",
			"@convex-dev/r2",

			"common",

			"novel",

			"@remix-run/interaction",

			"@tiptap/core",
			"@tiptap/react",
			"@tiptap/pm",
			"@tiptap/starter-kit",
			"@tiptap/markdown",
			"@tiptap/html",
			"@tiptap/extension-collaboration",
			"@tiptap/extension-collaboration-caret",
			"@tiptap/extension-document",
			"@tiptap/extension-drag-handle",
			"@tiptap/extension-highlight",
			"@tiptap/extension-horizontal-rule",
			"@tiptap/extension-mention",
			"@tiptap/extension-paragraph",
			"@tiptap/extension-placeholder",
			"@tiptap/extension-task-item",
			"@tiptap/extension-task-list",
			"@tiptap/extension-text",
			"@tiptap/extension-text-align",
			"@tiptap/extension-text-style",
			"@tiptap/extension-typography",
			"@tiptap/extension-underline",
			"@tiptap/extension-dropcursor",
			"@tiptap/extension-gapcursor",
			"@tiptap/extension-history",
			"@tiptap/extension-list-item",
			"@tiptap/extension-list-keymap",
			"@tiptap/extension-character-count",
			"@tiptap/extension-focus",
			"@tiptap/extension-table-cell",
			"@tiptap/extension-table-header",
			"@tiptap/extension-table-row",
			"@tiptap/suggestion",
		],
	},
});

// function log_react_compiler_event(filename: string, event: LoggerEvent) {
// 	switch (event.kind) {
// 		case "CompileSuccess": {
// 			console.info(
// 				`[react-compiler] ${path.basename(filename)}: compiled ${event.fnName ?? "<anonymous>"} ` +
// 					`(memoSlots=${event.memoSlots}, memoBlocks=${event.memoBlocks}, memoValues=${event.memoValues})`,
// 			);
// 			return;
// 		}
// 		case "CompileSkip": {
// 			console.warn(
// 				`[react-compiler] ${path.basename(filename)}:${format_loc_compact(event.loc)} ` + `skipped (${event.reason})`,
// 			);
// 			return;
// 		}
// 		case "CompileDiagnostic": {
// 			console.warn(
// 				`[react-compiler] ${path.basename(filename)}:${format_loc_compact(event.detail.loc)} ` +
// 					`diagnostic (${event.detail.category} / ${event.detail.reason})`,
// 				{ ...event.detail, loc: format_loc_verbose(filename, event.detail.loc) },
// 			);
// 			return;
// 		}
// 		case "CompileError": {
// 			const detailAny = event.detail as any;
// 			const loc =
// 				(detailAny?.loc as unknown) ??
// 				(detailAny?.options?.loc as unknown) ??
// 				(detailAny?.primaryLocation?.() as unknown) ??
// 				null;

// 			console.error(`[react-compiler] ${path.basename(filename)}:${format_loc_compact(loc)} error`, {
// 				...(typeof detailAny === "object" && detailAny ? detailAny : { detail: detailAny }),
// 				loc: format_loc_verbose(filename, loc),
// 			});
// 			return;
// 		}
// 		default: {
// 			// Keep other events quiet unless we need deeper debugging.
// 			return;
// 		}
// 	}
// }

// function format_loc_compact(loc: unknown): string {
// 	const parsed = parse_loc(loc);
// 	if (!parsed) return "?:?";
// 	return `${parsed.start.line}:${parsed.start.column + 1}`;
// }

// function format_loc_verbose(filename: string, loc: unknown): string | null {
// 	const parsed = parse_loc(loc);
// 	if (!parsed) return null;
// 	const file = path.basename(filename);
// 	const start = `${parsed.start.line}:${parsed.start.column + 1}`;
// 	const end = `${parsed.end.line}:${parsed.end.column + 1}`;
// 	return `${file}:${start}-${end}`;
// }

// function parse_loc(
// 	loc: unknown,
// ): { start: { line: number; column: number }; end: { line: number; column: number } } | null {
// 	if (!loc || typeof loc !== "object") return null;

// 	const l = loc as {
// 		start?: { line?: unknown; column?: unknown } | null;
// 		end?: { line?: unknown; column?: unknown } | null;
// 		loc?: unknown;
// 	};

// 	// Some shapes might be nested.
// 	const maybeNested = l.start && l.end ? l : (l.loc as any);
// 	if (!maybeNested || typeof maybeNested !== "object") return null;

// 	const start = (maybeNested as any).start;
// 	const end = (maybeNested as any).end;

// 	if (!start || !end) return null;
// 	if (typeof start.line !== "number" || typeof start.column !== "number") return null;
// 	if (typeof end.line !== "number" || typeof end.column !== "number") return null;

// 	return {
// 		start: { line: start.line, column: start.column },
// 		end: { line: end.line, column: end.column },
// 	};
// }
