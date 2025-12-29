import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import path from "node:path";
// import type { Logger, LoggerEvent } from "babel-plugin-react-compiler";

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
							// logger: {
							// 	logEvent(filename, event) {
							// 		if (!filename) return;

							// 		// By default, keep logs focused to avoid noise.
							// 		// Set `REACT_COMPILER_LOG_ALL=1` to log for all compiled files.
							// 		const logAll = process.env.REACT_COMPILER_LOG_ALL === "1";
							// 		if (!logAll) {
							// 			const appAuthPath = path.resolve(__dirname, "src/components/app-auth.tsx");
							// 			if (filename !== appAuthPath) return;
							// 		}

							// 		log_react_compiler_event(filename, event);
							// 	},
							// } satisfies Logger,
							environment: {
								// Adds extra annotations useful when inspecting compiler output.
								enableMemoizationComments: true,
							},
							sources: (filename: string) => {
								return (
									filename.startsWith(path.resolve(__dirname, "src")) ||
									filename.startsWith(path.resolve(__dirname, "vendor/novel"))
								);
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
			// Exclude vendored packages from pre-bundling so they're treated as source files
			"@assistant-ui/react",
			"@assistant-ui/react-ai-sdk",
			"@assistant-ui/react-markdown",
			"assistant-cloud",
			"@assistant-ui/react-edge",
			"@convex-dev/presence",

			"novel",

			"@liveblocks/react-tiptap",
			"@liveblocks/react",
			"@liveblocks/react-ui",
			"@liveblocks/yjs",
			"@liveblocks/client",
			"@liveblocks/core",
			"@liveblocks/node",

			"@remix-run/interaction",
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
