import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

// Use the same esbuild and resolution conditions as the Convex CLI.
const esbuild: {
	build(options: object): Promise<{ metafile: { inputs: Record<string, unknown> } }>;
} = createRequire(createRequire(appRoot + "package.json").resolve("convex/package.json"))("esbuild");

describe("creation imports", () => {
	test.each(["r2_assets", "files_nodes_create_preflight", "files_nodes_create_db", "files_nodes_create"])(
		"%s keeps creation dependencies separate",
		async (name) => {
			const result = await esbuild.build({
				entryPoints: [appRoot + "convex/" + name + ".ts"],
				bundle: true,
				write: false,
				metafile: true,
				format: "esm",
				platform: "browser",
				conditions: ["convex", "module"],
				define: { "process.env.NODE_ENV": '"production"' },
				logLevel: "silent",
			});
			const inputs = Object.keys(result.metafile.inputs).map((path) => path.replaceAll("\\", "/"));
			expect(inputs.length).toBeGreaterThan(100);
			expect(
				inputs.filter((path) => /(?:^|\/)convex\/(?:files_nodes_content|files_nodes|files_metadata|files_pending_updates|files_transfer)\.ts$/.test(path)),
				"no broad content handler import",
			).toEqual([]);
			expect(
				inputs.filter((path) => /\/(?:@aws-sdk|@smithy)\/|(?:^|\/)convex\/r2_client\.ts$/.test(path)),
				"no R2 SDK in creation DB calls",
			).toEqual([]);
			// Only the final file transaction needs Markdown chunking. Folders share the DB helper.
			if (name !== "files_nodes_create") {
				expect(inputs.filter((path) => /\/(?:@tiptap|@mastra)\/|vendor\/(?:tiptap|mastra)\/|files-markdown-chunking-mastra\.ts$/.test(path))).toEqual([]);
			}
		},
	);
});
