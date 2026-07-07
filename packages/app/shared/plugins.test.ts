import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import {
	plugins_consent_diff,
	plugins_dist_review_mechanical_findings,
	plugins_validate_origin,
	plugins_parse_env_text,
	plugins_parse_github_repository_url,
	plugins_validate_manifest,
} from "./plugins.ts";

describe("plugins_parse_env_text", () => {
	test("parses env text with comments, export prefixes, and quotes", () => {
		expect(
			plugins_parse_env_text(`
# Modal
export MODAL_TOKEN="abc\\n123"
CLOUDFLARE_MEDIA_TRANSFORMER_SECRET='media-secret'
OPENAI_API_KEY=plain
`),
		).toEqual({
			_yay: [
				{ name: "MODAL_TOKEN", value: "abc\n123" },
				{ name: "CLOUDFLARE_MEDIA_TRANSFORMER_SECRET", value: "media-secret" },
				{ name: "OPENAI_API_KEY", value: "plain" },
			],
		});
	});

	test("returns the line number for invalid env text", () => {
		expect(plugins_parse_env_text("GOOD=value\nnot valid")).toMatchObject({
			_nay: { message: "Line 2 must be KEY=value" },
		});
	});
});

describe("plugins_parse_github_repository_url", () => {
	test("accepts browser and ssh GitHub repository URLs", () => {
		expect(plugins_parse_github_repository_url("https://github.com/bonobo/media-plugin")).toEqual({
			_yay: {
				owner: "bonobo",
				repo: "media-plugin",
				repositoryUrl: "https://github.com/bonobo/media-plugin",
			},
		});
		expect(plugins_parse_github_repository_url("git@github.com:bonobo/pdf-plugin.git")).toMatchObject({
			_yay: {
				owner: "bonobo",
				repo: "pdf-plugin",
			},
		});
	});
});

describe("plugins_validate_origin", () => {
	test("accepts bare https origins and normalizes host case and trailing slash", () => {
		expect(plugins_validate_origin("https://api.openai.com")).toEqual({ _yay: "https://api.openai.com" });
		expect(plugins_validate_origin("https://API.OpenAI.com/")).toEqual({ _yay: "https://api.openai.com" });
		expect(plugins_validate_origin("https://example.com:8443")).toEqual({ _yay: "https://example.com:8443" });
	});

	test("rejects non-https, credentials, and non-bare origins", () => {
		expect(plugins_validate_origin("http://api.openai.com")).toMatchObject({
			_nay: { message: "Origin must use https" },
		});
		expect(plugins_validate_origin("https://user:pass@api.openai.com")).toMatchObject({
			_nay: { message: "Origin must not include credentials" },
		});
		expect(plugins_validate_origin("https://api.openai.com/v1")).toMatchObject({
			_nay: { message: "Origin must be a bare https origin without path, query, or hash" },
		});
		expect(plugins_validate_origin("https://api.openai.com?x=1")).toMatchObject({
			_nay: { message: "Origin must be a bare https origin without path, query, or hash" },
		});
		expect(plugins_validate_origin("https://api.openai.com#frag")).toMatchObject({
			_nay: { message: "Origin must be a bare https origin without path, query, or hash" },
		});
		expect(plugins_validate_origin("not a url")).toMatchObject({
			_nay: { message: "Origin must be a valid URL" },
		});
	});
});

describe("plugins_validate_manifest", () => {
	function manifest_json(
		args: { outboundOrigins?: string[]; duplicateFilePath?: boolean; nonDistFilePath?: boolean } = {},
	) {
		return {
			schemaVersion: 1,
			name: "media",
			displayName: "Media",
			version: "0.1.0",
			description: "Image and video markdown generation",
			compatibility: { bonoboPluginRuntime: "1" },
			events: [{ type: "files.upload.completed", contentTypes: ["image/png"] }],
			pages: [],
			capabilities: ["files.markdown.write"],
			outboundOrigins: args.outboundOrigins ?? [],
			files: [
				{
					path: args.nonDistFilePath ? "src/backend/worker.js" : "dist/backend/worker.js",
					sha256: `sha256:${"a".repeat(64)}`,
					bytes: 1,
					contentType: "application/javascript",
				},
				{
					path: args.duplicateFilePath ? "dist/backend/worker.js" : "dist/ui/index.html",
					sha256: `sha256:${"b".repeat(64)}`,
					bytes: 1,
					contentType: args.duplicateFilePath ? "application/javascript" : "text/html",
				},
			],
		};
	}

	test("rejects duplicate manifest file paths", () => {
		expect(plugins_validate_manifest(manifest_json({ duplicateFilePath: true }))).toEqual({
			_nay: { message: 'Plugin manifest has duplicate file path "dist/backend/worker.js"' },
		});
	});

	test("rejects manifest file paths outside dist/", () => {
		expect(plugins_validate_manifest(manifest_json({ nonDistFilePath: true }))).toEqual({
			_nay: { message: 'Plugin file "src/backend/worker.js" must be under dist/' },
		});
	});

	test("rejects a manifest that still declares the removed artifact pointer", () => {
		expect(plugins_validate_manifest({ ...manifest_json(), artifact: "dist/artifact.json" })).toMatchObject({
			_nay: { message: expect.any(String) },
		});
	});

	test("accepts declared outbound origins that are already normalized", () => {
		const validated = plugins_validate_manifest(manifest_json({ outboundOrigins: ["https://api.openai.com"] }));
		if (validated._nay) {
			throw new Error(validated._nay.message);
		}
		expect(validated._yay.outboundOrigins).toEqual(["https://api.openai.com"]);
	});

	test("rejects manifests without the outboundOrigins field", () => {
		const manifest: Record<string, unknown> = manifest_json();
		delete manifest.outboundOrigins;
		expect(plugins_validate_manifest(manifest)).toMatchObject({ _nay: { message: expect.any(String) } });
	});

	test("rejects invalid, non-normalized, and duplicate outbound origins", () => {
		expect(plugins_validate_manifest(manifest_json({ outboundOrigins: ["http://api.openai.com"] }))).toEqual({
			_nay: { message: "Origin must use https" },
		});
		expect(plugins_validate_manifest(manifest_json({ outboundOrigins: ["https://API.OpenAI.com/"] }))).toEqual({
			_nay: { message: "Outbound origins must already be normalized" },
		});
		expect(
			plugins_validate_manifest(
				manifest_json({ outboundOrigins: ["https://api.openai.com", "https://api.openai.com"] }),
			),
		).toEqual({ _nay: { message: 'Plugin manifest has duplicate outbound origin "https://api.openai.com"' } });
	});
});

describe("plugins_consent_diff", () => {
	test("marks everything as new for a fresh install", () => {
		expect(
			plugins_consent_diff({
				current: null,
				target: { capabilities: ["files.markdown.write"], outboundOrigins: ["https://api.openai.com"] },
			}),
		).toEqual({
			newCapabilities: ["files.markdown.write"],
			newOutboundOrigins: ["https://api.openai.com"],
		});
	});

	test("returns an empty diff when the upgrade declares nothing new", () => {
		expect(
			plugins_consent_diff({
				current: { capabilities: ["files.markdown.write"], outboundOrigins: ["https://api.openai.com"] },
				target: { capabilities: ["files.markdown.write"], outboundOrigins: ["https://api.openai.com"] },
			}),
		).toEqual({ newCapabilities: [], newOutboundOrigins: [] });
	});

	test("returns only the added capabilities and origins for an upgrade", () => {
		expect(
			plugins_consent_diff({
				current: { capabilities: ["files.markdown.write"], outboundOrigins: ["https://api.openai.com"] },
				target: {
					capabilities: ["files.markdown.write", "outbound.fetch"],
					outboundOrigins: ["https://api.openai.com", "https://example.com"],
				},
			}),
		).toEqual({ newCapabilities: ["outbound.fetch"], newOutboundOrigins: ["https://example.com"] });
	});
});

describe("plugins_dist_review_mechanical_findings", () => {
	function read_first_party_dist(plugin: "image" | "pdf") {
		// vitest runs with cwd at packages/app; import.meta.url is a vite /@fs URL here.
		return readFileSync(`${process.cwd()}/../../plugins/bonobo-plugin-${plugin}/dist/backend/worker.js`, "utf8");
	}

	test("the real readable first-party dists pass", () => {
		expect(plugins_dist_review_mechanical_findings(read_first_party_dist("image"))).toEqual([]);
		expect(plugins_dist_review_mechanical_findings(read_first_party_dist("pdf"))).toEqual([]);
	});

	test("rejects the same dist with its whitespace minified away", () => {
		const minified = read_first_party_dist("image")
			.split(/\r?\n/u)
			.map((line) => line.trim())
			.filter(Boolean)
			.join("");
		expect(plugins_dist_review_mechanical_findings(minified)).toEqual([
			expect.stringContaining("Longest line"),
			expect.stringContaining("Average line length"),
		]);
	});

	test("rejects a dist dominated by single-character identifiers", () => {
		const minified = Array.from({ length: 50 }, (_, i) => `var a${i % 3};function f(x,y,z){var q=x+y;return q*z}`).join(
			"\n",
		);
		expect(plugins_dist_review_mechanical_findings(minified)).toEqual([expect.stringContaining("single character")]);
	});

	test("rejects a dist with a giant base64 string literal", () => {
		const readableLines = Array.from(
			{ length: 20 },
			(_, i) => `export function handler${i}(request) { return request; }`,
		);
		const source = [...readableLines, `const payload = decodePayload("${"A".repeat(300)}");`].join("\n");
		expect(plugins_dist_review_mechanical_findings(source)).toEqual([expect.stringContaining("base64")]);
	});

	test("rejects escape-sequence obfuscation and the Function constructor", () => {
		const escaped = `const readableName = "${"\\x41".repeat(20)}";\n`;
		expect(plugins_dist_review_mechanical_findings(escaped)).toEqual([expect.stringContaining("escape sequences")]);
		expect(plugins_dist_review_mechanical_findings('const build = Function("return 1");\n')).toEqual([
			expect.stringContaining("Function constructor"),
		]);
	});
});

