import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

// Use the same esbuild and resolution conditions as the Convex CLI.
const esbuild: {
	build(options: object): Promise<{ metafile: { inputs: Record<string, unknown> } }>;
} = createRequire(createRequire(appRoot + "package.json").resolve("convex/package.json"))("esbuild");

describe("sharing imports", () => {
	// The share dialog waits on these modules. Splitting them from the file engine cut files_sharing.ts
	// from about 4.8 MB to 1.1 MB. Each MB adds about 40ms to a cold call.
	test.each(["files_sharing", "files_sharing_db", "files_subtree_ops_rebuild"])(
		"%s keeps the file engine out",
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
				inputs.filter((path) =>
					/(?:^|\/)convex\/(?:files_nodes|files_share_links|files_subtree_ops|files_archive_runs|files_metadata|files_transfer)\.ts$/.test(
						path,
					),
				),
				"no heavy file module import",
			).toEqual([]);
			expect(
				inputs.filter((path) => /\/(?:@aws-sdk|@smithy)\/|(?:^|\/)convex\/r2_client\.ts$/.test(path)),
				"no R2 SDK",
			).toEqual([]);
			expect(
				inputs.filter((path) =>
					/\/(?:@tiptap|linkedom|yjs)\/|shared\/files-(?:tiptap|share-rich-text)\.ts$/.test(path),
				),
				"no Markdown editor code",
			).toEqual([]);
		},
	);
});
