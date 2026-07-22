import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import {
	plugins_consent_diff,
	plugins_dist_review_mechanical_findings,
	plugins_event_matches_configuration,
	plugins_get_event_filter_values,
	plugins_parse_env_text,
	plugins_parse_github_repository_url,
	plugins_parse_installation_configuration_yaml,
	plugins_validate_manifest,
	plugins_validate_origin,
} from "./plugins.ts";

const uploadEvents = [
	{
		type: "files.upload.completed" as const,
		contentTypes: ["image/png"],
		filters: [
			{
				field: "source.path" as const,
				operator: "pathIsUnderAny" as const,
				configurationPath: ["triggers", "files.upload.completed", "folders"],
			},
		],
	},
];

describe("plugins_parse_installation_configuration_yaml", () => {
	test("parses plugin-owned settings and the values selected by event filters", () => {
		const selectedFolders = [
			"triggers:",
			"  files.upload.completed:",
			"    folders:",
			"      - /meetings",
			"      - /meetings/customer-calls",
			"summary:",
			"  language: en",
		].join("\n");
		expect(
			plugins_parse_installation_configuration_yaml({
				configurationYaml: selectedFolders,
				events: uploadEvents,
			}),
		).toEqual({
			_yay: {
				configurationYaml: selectedFolders,
				configuration: {
					triggers: { "files.upload.completed": { folders: ["/meetings", "/meetings/customer-calls"] } },
					summary: { language: "en" },
				},
			},
		});

		expect(
			plugins_parse_installation_configuration_yaml({
				configurationYaml: ["triggers:", "  files.upload.completed:", "    folders: []"].join("\n"),
				events: uploadEvents,
			}),
		).toMatchObject({ _yay: { configuration: { triggers: { "files.upload.completed": { folders: [] } } } } });
	});

	test("supports a plugin-defined filter location without a core configuration shape", () => {
		const configurationYaml = ["routing:", "  allowedFolders:", "    - /documents", "format: markdown"].join("\n");
		const parsed = plugins_parse_installation_configuration_yaml({
			configurationYaml,
			events: [
				{
					...uploadEvents[0]!,
					filters: [{ ...uploadEvents[0]!.filters[0]!, configurationPath: ["routing", "allowedFolders"] }],
				},
			],
		});
		expect(parsed).toMatchObject({
			_yay: { configuration: { routing: { allowedFolders: ["/documents"] }, format: "markdown" } },
		});
	});

	test("rejects unsupported YAML syntax and values used by a filter", () => {
		for (const yaml of [
			"",
			["---", "triggers: {}", "---", "triggers: {}"].join("\n"),
			["folders: &folders", "  - /meetings", "triggers:", "  files.upload.completed:", "    folders: *folders"].join(
				"\n",
			),
			["triggers:", "  files.upload.completed:", "    folders: !folders []"].join("\n"),
			["triggers:", "  files.upload.completed:", "    folders: []", "    folders: []"].join("\n"),
			["triggers:", "  files.upload.completed:", "    folders:", "      - 42"].join("\n"),
		]) {
			expect(
				plugins_parse_installation_configuration_yaml({ configurationYaml: yaml, events: uploadEvents }),
			).toMatchObject({
				_nay: { message: expect.any(String) },
			});
		}
	});

	test("bounds the YAML bytes, selected path count, and path length", () => {
		expect(
			plugins_parse_installation_configuration_yaml({
				configurationYaml: `# ${"é".repeat(8_192)}`,
				events: uploadEvents,
			}),
		).toEqual({
			_nay: { message: "Plugin configuration must be at most 16 KiB" },
		});

		const tooManyFolders = [
			"triggers:",
			"  files.upload.completed:",
			"    folders:",
			...Array.from({ length: 33 }, (_, index) => `      - /folder-${index}`),
		].join("\n");
		expect(
			plugins_parse_installation_configuration_yaml({ configurationYaml: tooManyFolders, events: uploadEvents }),
		).toEqual({
			_nay: { message: 'Plugin configuration "triggers.files.upload.completed.folders" can include at most 32 paths' },
		});

		const overlongFolder = `/${"a".repeat(512)}`;
		expect(
			plugins_parse_installation_configuration_yaml({
				configurationYaml: ["triggers:", "  files.upload.completed:", "    folders:", `      - ${overlongFolder}`].join(
					"\n",
				),
				events: uploadEvents,
			}),
		).toEqual({ _nay: { message: "Plugin configuration paths must be at most 512 characters" } });
	});

	test("rejects duplicate and non-canonical folder paths", () => {
		for (const folders of [
			["/meetings", "/meetings"],
			["meetings"],
			["/meetings/../documents"],
			["/Meetings"],
			["/meetings/"],
			["/meetings//customer-calls"],
		]) {
			const yaml = [
				"triggers:",
				"  files.upload.completed:",
				"    folders:",
				...folders.map((folder) => `      - ${folder}`),
			].join("\n");
			expect(
				plugins_parse_installation_configuration_yaml({ configurationYaml: yaml, events: uploadEvents }),
			).toMatchObject({
				_nay: { message: expect.any(String) },
			});
		}
	});
});

describe("plugins_event_matches_configuration", () => {
	test("matches root, exact paths, and descendants without matching sibling prefixes or case changes", () => {
		const matches = (path: string, folders: string[]) =>
			plugins_event_matches_configuration({
				configuration: { triggers: { "files.upload.completed": { folders } } },
				event: uploadEvents[0]!,
				source: { path },
			});

		expect(matches("/photo.png", ["/"])).toBe(true);
		expect(matches("/meetings", ["/meetings"])).toBe(true);
		expect(matches("/meetings/customer-calls/photo.png", ["/meetings"])).toBe(true);
		expect(matches("/meetings-old/photo.png", ["/meetings"])).toBe(false);
		expect(matches("/Meetings/photo.png", ["/meetings"])).toBe(false);
		expect(matches("/meetings/photo.png", [])).toBe(false);
	});

	test("requires every filter declared on an event to match", () => {
		const event = {
			...uploadEvents[0]!,
			filters: [
				uploadEvents[0]!.filters[0]!,
				{
					...uploadEvents[0]!.filters[0]!,
					configurationPath: ["routing", "reviewFolders"],
				},
			],
		};
		const configuration = {
			triggers: { "files.upload.completed": { folders: ["/meetings"] } },
			routing: { reviewFolders: ["/meetings/reviewed"] },
		};
		expect(
			plugins_event_matches_configuration({
				configuration,
				event,
				source: { path: "/meetings/draft/photo.png" },
			}),
		).toBe(false);
		expect(
			plugins_event_matches_configuration({
				configuration,
				event,
				source: { path: "/meetings/reviewed/photo.png" },
			}),
		).toBe(true);
	});
});

describe("plugins_get_event_filter_values", () => {
	test("keeps empty and populated values separate for multiple filters", () => {
		const event = {
			...uploadEvents[0]!,
			filters: [
				uploadEvents[0]!.filters[0]!,
				{
					...uploadEvents[0]!.filters[0]!,
					configurationPath: ["routing", "reviewFolders"],
				},
			],
		};
		expect(
			plugins_get_event_filter_values({
				configuration: {
					triggers: { "files.upload.completed": { folders: ["/meetings"] } },
					routing: { reviewFolders: [] },
				},
				event,
			}),
		).toEqual([
			{ filter: event.filters[0], values: ["/meetings"] },
			{ filter: event.filters[1], values: [] },
		]);
	});
});

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

	test("bounds the complete normalized origin string", () => {
		const labels = ["a".repeat(63), "b".repeat(63), "c".repeat(63)];
		const atLimit = `https://${[...labels, "d".repeat(55)].join(".")}`;
		const overLimit = `https://${[...labels, "d".repeat(56)].join(".")}`;
		expect(atLimit).toHaveLength(255);
		expect(plugins_validate_origin(atLimit)).toEqual({ _yay: atLimit });
		expect(overLimit).toHaveLength(256);
		expect(plugins_validate_origin(overLimit)).toEqual({
			_nay: { message: "Origins must be at most 255 characters" },
		});
	});
});

describe("plugins_validate_manifest", () => {
	function manifest_json(
		args: {
			configuration?: { description: string; defaultYaml: string } | null;
			events?: Array<{
				type: "files.upload.completed";
				contentTypes: string[];
				filters?: Array<{
					field: "source.path";
					operator: "pathIsUnderAny";
					configurationPath: string[];
				}>;
			}>;
			outboundOrigins?: string[];
			duplicateFilePath?: boolean;
			nonDistFilePath?: boolean;
		} = {},
	) {
		return {
			schemaVersion: 1,
			name: "media",
			displayName: "Media",
			version: "0.1.0",
			description: "Image and video markdown generation",
			compatibility: { bonoboPluginRuntime: "1" },
			...(args.configuration === undefined ? {} : { configuration: args.configuration }),
			events: args.events ?? [{ type: "files.upload.completed", contentTypes: ["image/png"] }],
			pages: [],
			capabilities: ["plugin.secrets.read", "outbound.fetch"],
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

	test("normalizes optional configuration and event filters", () => {
		const withoutConfiguration = plugins_validate_manifest(manifest_json());
		if (withoutConfiguration._nay) {
			throw new Error(withoutConfiguration._nay.message);
		}
		expect(withoutConfiguration._yay.configuration).toBeNull();
		expect(withoutConfiguration._yay.events[0]!.filters).toEqual([]);

		const withConfiguration = plugins_validate_manifest(
			manifest_json({
				configuration: {
					description: "Choose which upload folders start this plugin.",
					defaultYaml: ["routing:", "  allowedFolders:", "    - /"].join("\n"),
				},
				events: [
					{
						type: "files.upload.completed",
						contentTypes: ["image/png"],
						filters: [
							{
								field: "source.path",
								operator: "pathIsUnderAny",
								configurationPath: ["routing", "allowedFolders"],
							},
						],
					},
				],
			}),
		);
		expect(withConfiguration).toMatchObject({
			_yay: {
				configuration: { description: expect.any(String), defaultYaml: expect.any(String) },
				events: [{ filters: [{ configurationPath: ["routing", "allowedFolders"] }] }],
			},
		});
	});

	test("accepts the configuration declared by each first-party media plugin", () => {
		for (const plugin of ["image", "video", "pdf"]) {
			const manifest = JSON.parse(
				readFileSync(`${process.cwd()}/../../plugins/bonobo-plugin-${plugin}/dist/bonobo.plugin.json`, "utf8"),
			) as unknown;
			expect(plugins_validate_manifest(manifest)).toMatchObject({
				_yay: {
					configuration: { defaultYaml: expect.any(String) },
					events: [{ filters: [{ field: "source.path", operator: "pathIsUnderAny" }] }],
				},
			});
		}
	});

	test("rejects event filters without configuration and invalid default YAML", () => {
		const filteredEvent = {
			type: "files.upload.completed" as const,
			contentTypes: ["image/png"],
			filters: [
				{
					field: "source.path" as const,
					operator: "pathIsUnderAny" as const,
					configurationPath: ["routing", "allowedFolders"],
				},
			],
		};
		expect(plugins_validate_manifest(manifest_json({ events: [filteredEvent] }))).toEqual({
			_nay: { message: "Plugin event filters require a configuration declaration" },
		});
		expect(
			plugins_validate_manifest(
				manifest_json({
					configuration: { description: "Choose folders.", defaultYaml: "routing: {}" },
					events: [filteredEvent],
				}),
			),
		).toEqual({
			_nay: {
				message:
					'Plugin default configuration is invalid: Plugin configuration "routing.allowedFolders" must be an array',
			},
		});
	});

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

	test("bounds event and outbound-origin fan-out", () => {
		const contentTypes = Array.from({ length: 32 }, (_, index) => `application/x-test-${index}`);
		expect(
			plugins_validate_manifest(
				manifest_json({
					events: [
						{ type: "files.upload.completed", contentTypes },
						{ type: "files.upload.completed", contentTypes: contentTypes.map((type) => `${type}-other`) },
					],
					outboundOrigins: Array.from({ length: 16 }, (_, index) => `https://api-${index}.example.com`),
				}),
			),
		).toMatchObject({ _yay: expect.any(Object) });
		expect(
			plugins_validate_manifest(
				manifest_json({
					events: [
						{ type: "files.upload.completed", contentTypes },
						{
							type: "files.upload.completed",
							contentTypes: contentTypes.map((type) => `${type}-other`),
						},
						{ type: "files.upload.completed", contentTypes: ["application/x-over-limit"] },
					],
				}),
			),
		).toEqual({
			_nay: { message: "Plugin manifest declares more than 64 event content-type subscriptions" },
		});
		expect(
			plugins_validate_manifest(
				manifest_json({
					events: [
						{
							type: "files.upload.completed",
							contentTypes: [...contentTypes, "application/x-over-limit"],
						},
					],
				}),
			),
		).toEqual({ _nay: { message: "Plugin events can declare at most 32 content types" } });
		expect(
			plugins_validate_manifest(
				manifest_json({
					events: Array.from({ length: 9 }, (_, index) => ({
						type: "files.upload.completed" as const,
						contentTypes: [`application/x-event-${index}`],
					})),
				}),
			),
		).toEqual({ _nay: { message: "Plugin manifests can declare at most 8 events" } });
		expect(
			plugins_validate_manifest(
				manifest_json({
					outboundOrigins: Array.from({ length: 17 }, (_, index) => `https://api-${index}.example.com`),
				}),
			),
		).toEqual({ _nay: { message: "Plugin manifests can declare at most 16 outbound origins" } });
	});

	test("rejects duplicate event subscriptions and overlong secret names", () => {
		expect(
			plugins_validate_manifest(
				manifest_json({
					events: [
						{ type: "files.upload.completed", contentTypes: ["image/png"] },
						{ type: "files.upload.completed", contentTypes: ["image/png"] },
					],
				}),
			),
		).toEqual({
			_nay: { message: 'Plugin manifest has duplicate files.upload.completed content type "image/png"' },
		});
		expect(plugins_parse_env_text(`${"A".repeat(129)}=value`)).toEqual({
			_nay: { message: "Line 1: Secret names must be at most 128 characters" },
		});
	});
});

describe("plugins_consent_diff", () => {
	test("marks everything as new for a fresh install", () => {
		expect(
			plugins_consent_diff({
				current: null,
				target: { capabilities: ["plugin.secrets.read"], outboundOrigins: ["https://api.openai.com"] },
			}),
		).toEqual({
			newCapabilities: ["plugin.secrets.read"],
			newOutboundOrigins: ["https://api.openai.com"],
		});
	});

	test("returns an empty diff when the upgrade declares nothing new", () => {
		expect(
			plugins_consent_diff({
				current: { capabilities: ["plugin.secrets.read"], outboundOrigins: ["https://api.openai.com"] },
				target: { capabilities: ["plugin.secrets.read"], outboundOrigins: ["https://api.openai.com"] },
			}),
		).toEqual({ newCapabilities: [], newOutboundOrigins: [] });
	});

	test("returns only the added capabilities and origins for an upgrade", () => {
		expect(
			plugins_consent_diff({
				current: { capabilities: ["plugin.secrets.read"], outboundOrigins: ["https://api.openai.com"] },
				target: {
					capabilities: ["plugin.secrets.read", "outbound.fetch"],
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

	test("keeps JavaScript-only checks out of non-JavaScript text", () => {
		expect(
			plugins_dist_review_mechanical_findings('main::before { content: "Function(return 1)"; }\n', {
				javaScript: false,
			}),
		).toEqual([]);
	});
});
