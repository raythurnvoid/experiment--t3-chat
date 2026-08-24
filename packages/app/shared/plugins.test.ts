import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import app_convex_schema from "../convex/schema.ts";
import type { plugins_Capability } from "./plugins.ts";
import {
	plugins_consent_diff,
	plugins_dist_review_mechanical_findings,
	plugins_event_matches_configuration,
	plugins_get_event_filter_values,
	plugins_list_file_view_matches,
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
				type: "files.upload.completed" | "users.account.deleted";
				contentTypes?: string[];
				filters?: Array<{
					field: "source.path";
					operator: "pathIsUnderAny";
					configurationPath: string[];
				}>;
			}>;
			outboundOrigins?: string[];
			uiOutboundOrigins?: string[];
			capabilities?: string[];
			/** Declare one file view and no `pages` key at all, the way bonobo-plugin-video-player ships. */
			fileViewsOnly?: boolean;
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
			...(args.fileViewsOnly
				? {
						fileViews: [{ id: "viewer", title: "Viewer", entry: "dist/ui/index.html", contentTypes: ["video/mp4"] }],
					}
				: { pages: [] }),
			capabilities: args.capabilities ?? ["plugin.secrets.read", "outbound.fetch"],
			outboundOrigins: args.outboundOrigins ?? [],
			...(args.uiOutboundOrigins === undefined ? {} : { uiOutboundOrigins: args.uiOutboundOrigins }),
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

	test("bounds manifest text that is copied into every stored version", () => {
		expect(plugins_validate_manifest({ ...manifest_json(), displayName: "x".repeat(81) })).toEqual({
			_nay: { message: "Plugin display names must be at most 80 characters" },
		});
		expect(plugins_validate_manifest({ ...manifest_json(), description: "x".repeat(2_001) })).toEqual({
			_nay: { message: "Plugin descriptions must be at most 2000 characters" },
		});
		expect(plugins_validate_manifest({ ...manifest_json(), version: `0.1.0-${"a".repeat(95)}` })).toEqual({
			_nay: { message: "Plugin versions must be at most 100 characters" },
		});
		const backend = {
			entry: "dist/backend/worker.js",
			moduleName: "dist/backend/worker.js",
			compatibilityDate: "2026-08-14",
			compatibilityFlags: Array.from({ length: 33 }, () => "nodejs_compat"),
		};
		expect(plugins_validate_manifest({ ...manifest_json(), backend })).toEqual({
			_nay: { message: "Plugin backends can declare at most 32 compatibility flags" },
		});
		expect(
			plugins_validate_manifest({
				...manifest_json(),
				backend: { ...backend, compatibilityFlags: ["x".repeat(65)] },
			}),
		).toEqual({ _nay: { message: "Compatibility flags must be at most 64 characters" } });
	});


	test("holds each event to what it can carry: a file event needs content types, the account event refuses them", () => {
		// An account deletion has no file, so a content type could never match one. Refusing it at
		// publish time is the difference between an author fixing a manifest and an author waiting for
		// an event that will never arrive.
		expect(
			plugins_validate_manifest(
				manifest_json({ events: [{ type: "users.account.deleted", contentTypes: ["image/png"] }] }),
			),
		).toEqual({
			_nay: { message: "users.account.deleted carries no file, so it cannot declare content types" },
		});

		// The one filter the platform has is a path filter, and this event has no path. It has one
		// subject, so there is nothing left to narrow.
		expect(
			plugins_validate_manifest(
				manifest_json({
					events: [
						{
							type: "users.account.deleted",
							filters: [
								{ field: "source.path", operator: "pathIsUnderAny", configurationPath: ["routing", "folders"] },
							],
						},
					],
				}),
			),
		).toEqual({
			_nay: { message: "users.account.deleted has one subject, so it cannot declare filters" },
		});

		// The upload event keeps its old rule. It used to come from the field's own minimum, and the
		// minimum had to go so the other event could leave the list empty.
		expect(plugins_validate_manifest(manifest_json({ events: [{ type: "files.upload.completed" }] }))).toEqual({
			_nay: { message: "files.upload.completed must declare at least one content type" },
		});

		expect(plugins_validate_manifest(manifest_json({ events: [{ type: "users.account.deleted" }] }))).toMatchObject({
			_yay: { events: [{ type: "users.account.deleted", contentTypes: [], filters: [] }] },
		});
	});

	test("bounds the whole stored manifest payload", () => {
		const files = Array.from({ length: 64 }, (_, index) => ({
			path: `dist/${String(index).padStart(2, "0")}-${"a".repeat(500)}`,
			sha256: `sha256:${"a".repeat(64)}`,
			bytes: 1,
			contentType: `application/${"x".repeat(243)}`,
		}));
		const manifest = {
			...manifest_json(),
			configuration: {
				description: "Large metadata fixture",
				defaultYaml: `notes: ${JSON.stringify("x".repeat(12_000))}`,
			},
			events: [],
			files,
		};

		expect(plugins_validate_manifest(manifest)).toEqual({
			_nay: { message: "Plugin manifest stores more than 64 KiB of metadata" },
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

	test("rejects a manifest file content type that could forge a review inventory line", () => {
		// The reviewer's file inventory prints one shipped file per line and ends an unreviewable one
		// with "not reviewable text — not sent)". A newline in this value closes that line early and
		// starts another, so the publisher gets to describe a file nobody shipped.
		const forgedLine =
			"image/png, 1 bytes, not reviewable text — not sent)\ndist/backend/ghost.js (application/javascript";
		expect(
			plugins_validate_manifest({
				...manifest_json(),
				files: [
					{ path: "dist/backend/worker.js", sha256: `sha256:${"a".repeat(64)}`, bytes: 1, contentType: forgedLine },
					{ path: "dist/ui/index.html", sha256: `sha256:${"b".repeat(64)}`, bytes: 1, contentType: "text/html" },
				],
			}),
		).toEqual({
			_nay: { message: 'Plugin file "dist/backend/worker.js" content type must not contain control characters' },
		});

		// The same guard covers characters that hide text rather than add a line.
		expect(
			plugins_validate_manifest({
				...manifest_json(),
				files: [
					{
						path: "dist/backend/worker.js",
						sha256: `sha256:${"a".repeat(64)}`,
						bytes: 1,
						// A zero-width space, built from its code point so it stays visible in this source.
						contentType: `text/${String.fromCharCode(0x200b)}html`,
					},
					{ path: "dist/ui/index.html", sha256: `sha256:${"b".repeat(64)}`, bytes: 1, contentType: "text/html" },
				],
			}),
		).toEqual({
			_nay: { message: 'Plugin file "dist/backend/worker.js" content type must not contain control characters' },
		});
	});

	test("rejects a manifest that still declares the removed artifact pointer", () => {
		expect(plugins_validate_manifest({ ...manifest_json(), artifact: "dist/artifact.json" })).toMatchObject({
			_nay: { message: expect.any(String) },
		});
	});

	test("rejects host-owned R2 keys in manifest file entries", () => {
		const manifest = manifest_json();

		expect(
			plugins_validate_manifest({
				...manifest,
				files: [{ ...manifest.files[0]!, r2Key: "plugins/caller-chosen-key" }, ...manifest.files.slice(1)],
			}),
		).toMatchObject({ _nay: { message: expect.any(String) } });
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

	test("defaults UI outbound origins to none when the manifest omits them", () => {
		const validated = plugins_validate_manifest(manifest_json());
		if (validated._nay) {
			throw new Error(validated._nay.message);
		}
		expect(validated._yay.uiOutboundOrigins).toEqual([]);
	});

	test("accepts declared UI outbound origins that are already normalized", () => {
		const validated = plugins_validate_manifest(
			manifest_json({
				capabilities: ["plugin.secrets.read", "ui.outbound.fetch"],
				uiOutboundOrigins: ["https://council.example.com"],
			}),
		);
		if (validated._nay) {
			throw new Error(validated._nay.message);
		}
		expect(validated._yay.uiOutboundOrigins).toEqual(["https://council.example.com"]);
		// UI egress does not imply backend egress. The two lists stay separate.
		expect(validated._yay.outboundOrigins).toEqual([]);
	});

	test("rejects invalid, non-normalized, and duplicate UI outbound origins", () => {
		expect(
			plugins_validate_manifest(
				manifest_json({
					capabilities: ["plugin.secrets.read", "ui.outbound.fetch"],
					uiOutboundOrigins: ["http://council.example.com"],
				}),
			),
		).toEqual({ _nay: { message: "Origin must use https" } });
		expect(
			plugins_validate_manifest(
				manifest_json({
					capabilities: ["plugin.secrets.read", "ui.outbound.fetch"],
					uiOutboundOrigins: ["https://Council.Example.com/"],
				}),
			),
		).toEqual({ _nay: { message: "UI outbound origins must already be normalized" } });
		expect(
			plugins_validate_manifest(
				manifest_json({
					capabilities: ["plugin.secrets.read", "ui.outbound.fetch"],
					uiOutboundOrigins: ["https://council.example.com", "https://council.example.com"],
				}),
			),
		).toEqual({
			_nay: { message: 'Plugin manifest has duplicate UI outbound origin "https://council.example.com"' },
		});
	});

	test("keeps the ui.outbound.fetch capability and UI outbound origins together", () => {
		expect(
			plugins_validate_manifest(manifest_json({ capabilities: ["plugin.secrets.read", "ui.outbound.fetch"] })),
		).toEqual({ _nay: { message: "The ui.outbound.fetch capability requires at least one UI outbound origin" } });
		expect(
			plugins_validate_manifest(
				manifest_json({ capabilities: ["plugin.secrets.read"], uiOutboundOrigins: ["https://council.example.com"] }),
			),
		).toEqual({ _nay: { message: "UI outbound origins require the ui.outbound.fetch capability" } });
	});

	test("refuses a file-view-only manifest without naming a manifest section it does not have", () => {
		// `uiOutboundOrigins` becomes the `connect-src` of every asset response, and `get_ui_asset`
		// serves pages and file views from the same branch, so the list reaches a file view exactly as it
		// reaches a page. `pages` and `fileViews` are both optional, so a manifest can carry these origins
		// with no `pages` key at all. A refusal that said "page outbound origins" would send that
		// publisher looking for a section their manifest does not contain.
		const refusal = plugins_validate_manifest(
			manifest_json({
				fileViewsOnly: true,
				capabilities: ["plugin.secrets.read"],
				uiOutboundOrigins: ["https://council.example.com"],
			}),
		);
		expect(refusal._nay?.message.toLowerCase()).not.toContain("page");
		expect(refusal).toEqual({
			_nay: { message: "UI outbound origins require the ui.outbound.fetch capability" },
		});
	});

	test("bounds UI outbound origins at the same cap as backend origins", () => {
		expect(
			plugins_validate_manifest(
				manifest_json({
					capabilities: ["plugin.secrets.read", "ui.outbound.fetch"],
					uiOutboundOrigins: Array.from({ length: 16 }, (_, index) => `https://page-${index}.example.com`),
				}),
			),
		).toMatchObject({ _yay: expect.any(Object) });
		expect(
			plugins_validate_manifest(
				manifest_json({
					capabilities: ["plugin.secrets.read", "ui.outbound.fetch"],
					uiOutboundOrigins: Array.from({ length: 17 }, (_, index) => `https://page-${index}.example.com`),
				}),
			),
		).toEqual({ _nay: { message: "Plugin manifests can declare at most 16 UI outbound origins" } });
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

	test("accepts secrets declarations and defaults optional to false", () => {
		expect(
			plugins_validate_manifest({
				...manifest_json(),
				secrets: [
					{ name: "OPENAI_API_KEY", description: "OpenAI key used for transcription." },
					{ name: "WEBHOOK_TOKEN", description: "", optional: true },
				],
			}),
		).toMatchObject({
			_yay: {
				secrets: [
					{ name: "OPENAI_API_KEY", description: "OpenAI key used for transcription.", optional: false },
					{ name: "WEBHOOK_TOKEN", description: "", optional: true },
				],
			},
		});
		expect(plugins_validate_manifest(manifest_json())).toMatchObject({ _yay: { secrets: [] } });
	});

	test("rejects secret declarations with invalid names, duplicates, or missing capability", () => {
		// A name that is not a valid env key could never be configured or read.
		for (const name of ["MY KEY", "https://example.com", "please set the api key"]) {
			expect(plugins_validate_manifest({ ...manifest_json(), secrets: [{ name, description: "" }] })).toEqual({
				_nay: { message: "Secret names must use env key syntax" },
			});
		}
		expect(
			plugins_validate_manifest({ ...manifest_json(), secrets: [{ name: " OPENAI_API_KEY ", description: "" }] }),
		).toEqual({ _nay: { message: "Secret names must already be normalized" } });
		expect(
			plugins_validate_manifest({
				...manifest_json(),
				secrets: [
					{ name: "OPENAI_API_KEY", description: "" },
					{ name: "OPENAI_API_KEY", description: "", optional: true },
				],
			}),
		).toEqual({ _nay: { message: 'Plugin manifest has duplicate secret "OPENAI_API_KEY"' } });
		expect(
			plugins_validate_manifest({
				...manifest_json(),
				secrets: [{ name: "OPENAI_API_KEY", description: "x".repeat(301) }],
			}),
		).toEqual({ _nay: { message: "Secret descriptions must be at most 300 characters" } });
		// A bidi override could visually reorder the rendered note into phishing copy.
		expect(
			plugins_validate_manifest({
				...manifest_json(),
				secrets: [{ name: "OPENAI_API_KEY", description: "paste at ‮moc.live‬" }],
			}),
		).toEqual({ _nay: { message: 'Secret "OPENAI_API_KEY" description must not contain control characters' } });
		expect(
			plugins_validate_manifest({
				...manifest_json(),
				secrets: Array.from({ length: 33 }, (_, index) => ({ name: `SECRET_${index}`, description: "" })),
			}),
		).toEqual({ _nay: { message: "Plugin manifests can declare at most 32 secrets" } });
		expect(
			plugins_validate_manifest({
				...manifest_json(),
				capabilities: ["outbound.fetch"],
				secrets: [{ name: "OPENAI_API_KEY", description: "" }],
			}),
		).toEqual({ _nay: { message: "Plugin secrets declarations require the plugin.secrets.read capability" } });
	});

	test("rejects plugin.data.write without plugin.data.read", () => {
		expect(
			plugins_validate_manifest({
				...manifest_json(),
				capabilities: ["plugin.data.write"],
			}),
		).toEqual({ _nay: { message: "The plugin.data.write capability requires the plugin.data.read capability" } });
		// Reading without writing is a normal declaration for a page that only displays stored documents.
		const readOnly = plugins_validate_manifest({ ...manifest_json(), capabilities: ["plugin.data.read"] });
		if (readOnly._nay) {
			throw new Error(readOnly._nay.message);
		}
		expect(readOnly._yay.capabilities).toEqual(["plugin.data.read"]);
		const readWrite = plugins_validate_manifest({
			...manifest_json(),
			capabilities: ["plugin.data.read", "plugin.data.write"],
		});
		if (readWrite._nay) {
			throw new Error(readWrite._nay.message);
		}
		expect(readWrite._yay.capabilities).toEqual(["plugin.data.read", "plugin.data.write"]);
	});

	test("rejects plugin.data.user-write without plugin.data.read", () => {
		expect(
			plugins_validate_manifest({
				...manifest_json(),
				capabilities: ["plugin.data.user-write"],
			}),
		).toEqual({
			_nay: { message: "The plugin.data.user-write capability requires the plugin.data.read capability" },
		});
		const readUserWrite = plugins_validate_manifest({
			...manifest_json(),
			capabilities: ["plugin.data.read", "plugin.data.user-write"],
		});
		if (readUserWrite._nay) {
			throw new Error(readUserWrite._nay.message);
		}
		expect(readUserWrite._yay.capabilities).toEqual(["plugin.data.read", "plugin.data.user-write"]);
	});

	test("rejects workspace.files.create-read-only without workspace.files.write", () => {
		expect(
			plugins_validate_manifest({
				...manifest_json(),
				capabilities: ["workspace.files.create-read-only"],
			}),
		).toEqual({
			_nay: {
				message: "The workspace.files.create-read-only capability requires the workspace.files.write capability",
			},
		});
	});

	test("rejects plugin.service.connect with nothing for the service to borrow", () => {
		expect(
			plugins_validate_manifest({
				...manifest_json(),
				capabilities: ["plugin.service.connect"],
			}),
		).toEqual({
			_nay: {
				message:
					"The plugin.service.connect capability requires the plugin.data.read or workspace.files.write capability",
			},
		});
		// Outbound fetch is the plugin's own backend calling out, not an outside service acting for it,
		// so it does not satisfy the rule.
		expect(
			plugins_validate_manifest({
				...manifest_json(),
				capabilities: ["plugin.service.connect", "outbound.fetch"],
			}),
		).toEqual({
			_nay: {
				message:
					"The plugin.service.connect capability requires the plugin.data.read or workspace.files.write capability",
			},
		});
		// Either grantable capability is enough on its own: a service that only files artifacts never
		// needs the document store, and one that only keeps state never needs to write files.
		for (const paired of ["plugin.data.read", "workspace.files.write"] as const) {
			const accepted = plugins_validate_manifest({
				...manifest_json(),
				capabilities: ["plugin.service.connect", paired],
			});
			if (accepted._nay) {
				throw new Error(accepted._nay.message);
			}
			expect(accepted._yay.capabilities).toEqual(["plugin.service.connect", paired]);
		}
	});

	test("rejects duplicate file view content types within and across views", () => {
		expect(
			plugins_validate_manifest({
				...manifest_json(),
				fileViews: [
					{
						id: "player",
						title: "Video player",
						entry: "dist/ui/index.html",
						contentTypes: ["video/mp4", "video/mp4"],
					},
				],
			}),
		).toEqual({
			_nay: { message: 'Plugin manifest has duplicate file view content type "video/mp4"' },
		});
		expect(
			plugins_validate_manifest({
				...manifest_json(),
				fileViews: [
					{ id: "player", title: "Video player", entry: "dist/ui/index.html", contentTypes: ["video/mp4"] },
					{ id: "other", title: "Other player", entry: "dist/ui/index.html", contentTypes: ["video/mp4"] },
				],
			}),
		).toEqual({
			_nay: { message: 'Plugin manifest has duplicate file view content type "video/mp4"' },
		});
	});

	test("bounds file view fan-out", () => {
		const contentTypes = Array.from({ length: 32 }, (_, index) => `video/x-test-${index}`);
		expect(
			plugins_validate_manifest({
				...manifest_json(),
				fileViews: [
					{ id: "first", title: "First", entry: "dist/ui/index.html", contentTypes },
					{
						id: "second",
						title: "Second",
						entry: "dist/ui/index.html",
						contentTypes: contentTypes.map((type) => `${type}-other`),
					},
				],
			}),
		).toMatchObject({ _yay: expect.any(Object) });
		expect(
			plugins_validate_manifest({
				...manifest_json(),
				fileViews: [
					{ id: "first", title: "First", entry: "dist/ui/index.html", contentTypes },
					{
						id: "second",
						title: "Second",
						entry: "dist/ui/index.html",
						contentTypes: contentTypes.map((type) => `${type}-other`),
					},
					{ id: "third", title: "Third", entry: "dist/ui/index.html", contentTypes: ["video/x-over-limit"] },
				],
			}),
		).toEqual({
			_nay: { message: "Plugin manifest declares more than 64 file view content types" },
		});
		expect(
			plugins_validate_manifest({
				...manifest_json(),
				fileViews: [
					{
						id: "player",
						title: "Video player",
						entry: "dist/ui/index.html",
						contentTypes: [...contentTypes, "video/x-over-limit"],
					},
				],
			}),
		).toEqual({ _nay: { message: "Plugin file views can declare at most 32 content types" } });
		expect(
			plugins_validate_manifest({
				...manifest_json(),
				fileViews: Array.from({ length: 9 }, (_, index) => ({
					id: `view-${index}`,
					title: `View ${index}`,
					entry: "dist/ui/index.html",
					contentTypes: [`video/x-view-${index}`],
				})),
			}),
		).toEqual({ _nay: { message: "Plugin manifests can declare at most 8 file views" } });
	});
});

describe("plugins_Capability", () => {
	// `satisfies Record<plugins_Capability, true>` forces this literal to name every member of the
	// shared union and nothing else, so a capability added to one list but not the other fails these
	// tests or their compile.
	const capabilities = Object.keys({
		"plugin.secrets.read": true,
		"outbound.fetch": true,
		"workspace.files.read": true,
		"workspace.files.write": true,
		"workspace.files.create-read-only": true,
		"plugin.data.read": true,
		"plugin.data.write": true,
		"plugin.data.user-write": true,
		"plugin.service.connect": true,
		"ui.outbound.fetch": true,
		"workspace.members.read": true,
	} satisfies Record<plugins_Capability, true>);

	test("the Convex schema capability validator matches the shared capability list exactly", () => {
		const schemaCapabilities =
			app_convex_schema.tables.plugins_versions.validator.fields.capabilities.element.members.map(
				(member) => member.value,
			);
		expect([...schemaCapabilities].sort()).toEqual([...capabilities].sort());
	});

	test("the plugin SDK's BonoboCapability union matches the shared capability list exactly", () => {
		// No app module imports the SDK, so nothing else notices when the two lists drift. 0.9.1
		// shipped without `plugin.data.user-write` after the host already had it, and only a human
		// review round caught that. Read the published types as text and compare both directions.
		const sdkTypes = readFileSync(`${process.cwd()}/../bonobo-plugin-sdk/index.d.ts`, "utf8");
		const union = /export type BonoboCapability =([^;]*);/u.exec(sdkTypes);
		// Tell a reformatted declaration apart from a real mismatch: without this the next assertion
		// would report an empty SDK list and hide the reason.
		expect(union).not.toBeNull();

		const sdkCapabilities = [...(union?.[1] ?? "").matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
		expect([...sdkCapabilities].sort()).toEqual([...capabilities].sort());
	});

	test("the plugin SDK doc block states every capability that another capability requires", () => {
		// A manifest that declares only the dependent half is rejected at publish, so an author who
		// writes a manifest against the types must learn the rule here and not from a rejection.
		// `plugin.data.write` was the one conditional capability whose bullet stayed silent, and
		// nothing catches that: the doc block is prose in a `.d.ts` no app module imports.
		const requiredByCapability = {
			"plugin.data.write": ["plugin.data.read"],
			"plugin.data.user-write": ["plugin.data.read"],
			"workspace.files.create-read-only": ["workspace.files.write"],
			"plugin.service.connect": ["plugin.data.read", "workspace.files.write"],
		} satisfies Partial<Record<plugins_Capability, plugins_Capability[]>>;

		const sdkTypes = readFileSync(`${process.cwd()}/../bonobo-plugin-sdk/index.d.ts`, "utf8");
		const docBlock = /\/\*\*([^]*?)\*\/\s*export type BonoboCapability =/u.exec(sdkTypes);
		// Tell a moved or reformatted doc block apart from a real omission: without this the bullet
		// lookups below would all come back empty and blame the wrong thing.
		expect(docBlock).not.toBeNull();

		// Each bullet runs from its own ` * - ` marker to the next one, so slice on that marker.
		const bullets = (docBlock?.[1] ?? "").split(/\n\s*\* - /u).slice(1);
		// Answer per capability rather than asserting inside the loop, so a failure names the bullet
		// that stayed silent instead of printing "expected false to be true".
		const statesItsRule = Object.fromEntries(
			Object.entries(requiredByCapability).map(([capability, required]) => {
				const bullet = bullets.find((entry) => entry.startsWith(`\`${capability}\``)) ?? "";
				return [capability, required.some((name) => bullet.includes(`\`${name}\``))];
			}),
		);

		expect(statesItsRule).toEqual({
			"plugin.data.write": true,
			"plugin.data.user-write": true,
			"workspace.files.create-read-only": true,
			"plugin.service.connect": true,
		});
	});
});

describe("plugins_consent_diff", () => {
	test("marks everything as new for a fresh install", () => {
		expect(
			plugins_consent_diff({
				current: null,
				target: {
					capabilities: ["plugin.secrets.read"],
					outboundOrigins: ["https://api.openai.com"],
					uiOutboundOrigins: ["https://council.example.com"],
				},
			}),
		).toEqual({
			newCapabilities: ["plugin.secrets.read"],
			newOutboundOrigins: ["https://api.openai.com"],
			newUiOutboundOrigins: ["https://council.example.com"],
		});
	});

	test("returns an empty diff when the upgrade declares nothing new", () => {
		expect(
			plugins_consent_diff({
				current: {
					capabilities: ["plugin.secrets.read"],
					outboundOrigins: ["https://api.openai.com"],
					uiOutboundOrigins: ["https://council.example.com"],
				},
				target: {
					capabilities: ["plugin.secrets.read"],
					outboundOrigins: ["https://api.openai.com"],
					uiOutboundOrigins: ["https://council.example.com"],
				},
			}),
		).toEqual({ newCapabilities: [], newOutboundOrigins: [], newUiOutboundOrigins: [] });
	});

	test("returns only the added capabilities and origins for an upgrade", () => {
		expect(
			plugins_consent_diff({
				current: {
					capabilities: ["plugin.secrets.read"],
					outboundOrigins: ["https://api.openai.com"],
					uiOutboundOrigins: [],
				},
				target: {
					capabilities: ["plugin.secrets.read", "outbound.fetch"],
					outboundOrigins: ["https://api.openai.com", "https://example.com"],
					uiOutboundOrigins: ["https://council.example.com"],
				},
			}),
		).toEqual({
			newCapabilities: ["outbound.fetch"],
			newOutboundOrigins: ["https://example.com"],
			newUiOutboundOrigins: ["https://council.example.com"],
		});
	});

	test("an origin the backend already reaches is still new to the page", () => {
		expect(
			plugins_consent_diff({
				current: {
					capabilities: ["outbound.fetch"],
					outboundOrigins: ["https://council.example.com"],
					uiOutboundOrigins: [],
				},
				target: {
					capabilities: ["outbound.fetch", "ui.outbound.fetch"],
					outboundOrigins: ["https://council.example.com"],
					uiOutboundOrigins: ["https://council.example.com"],
				},
			}),
		).toEqual({
			newCapabilities: ["ui.outbound.fetch"],
			newOutboundOrigins: [],
			newUiOutboundOrigins: ["https://council.example.com"],
		});
	});
});

describe("plugins_dist_review_mechanical_findings", () => {
	function read_first_party_dist(plugin: "image" | "pdf") {
		// vitest runs with cwd at packages/app; import.meta.url is a vite /@fs URL here.
		return readFileSync(`${process.cwd()}/../../plugins/bonobo-plugin-${plugin}/dist/backend/worker.js`, "utf8");
	}

	test("the real readable first-party dists produce no finding of either severity", () => {
		expect(plugins_dist_review_mechanical_findings(read_first_party_dist("image"))).toEqual({
			findings: [],
			advisoryFindings: [],
		});
		expect(plugins_dist_review_mechanical_findings(read_first_party_dist("pdf"))).toEqual({
			findings: [],
			advisoryFindings: [],
		});
	});

	test("reports the same dist with its whitespace minified away as advisory only", () => {
		const minified = read_first_party_dist("image")
			.split(/\r?\n/u)
			.map((line) => line.trim())
			.filter(Boolean)
			.join("");
		// Shape alone never blocks: a normal bundled dependency looks exactly like this and the plugin
		// author cannot fix it.
		expect(plugins_dist_review_mechanical_findings(minified)).toEqual({
			findings: [],
			advisoryFindings: [expect.stringContaining("Longest line"), expect.stringContaining("Average line length")],
		});
	});

	test("reports a dist dominated by single-character identifiers as advisory only", () => {
		const minified = Array.from({ length: 50 }, (_, i) => `var a${i % 3};function f(x,y,z){var q=x+y;return q*z}`).join(
			"\n",
		);
		expect(plugins_dist_review_mechanical_findings(minified)).toEqual({
			findings: [],
			advisoryFindings: [expect.stringContaining("single character")],
		});
	});

	test("rejects a dist with a giant base64 string literal", () => {
		const readableLines = Array.from(
			{ length: 20 },
			(_, i) => `export function handler${i}(request) { return request; }`,
		);
		const source = [...readableLines, `const payload = decodePayload("${"A".repeat(300)}");`].join("\n");
		expect(plugins_dist_review_mechanical_findings(source)).toEqual({
			findings: [expect.stringContaining("base64")],
			advisoryFindings: [],
		});
	});

	test("rejects escape-sequence obfuscation and the Function constructor", () => {
		const escaped = `const readableName = "${"\\x41".repeat(20)}";\n`;
		expect(plugins_dist_review_mechanical_findings(escaped)).toEqual({
			findings: [expect.stringContaining("escape sequences")],
			advisoryFindings: [],
		});
		expect(plugins_dist_review_mechanical_findings('const build = Function("return 1");\n')).toEqual({
			findings: [expect.stringContaining("Function constructor")],
			advisoryFindings: [],
		});
	});

	test("a rejecting finding still rejects when the same file is also advisory", () => {
		// One long line carrying a hidden payload. The shape is advisory and the payload rejects, and
		// the two must land in their own arrays instead of merging back into one verdict.
		const source = `const payload = decodePayload("${"A".repeat(300)}"); ${"// padding".repeat(100)}\n`;
		expect(plugins_dist_review_mechanical_findings(source)).toEqual({
			findings: [expect.stringContaining("base64")],
			advisoryFindings: [expect.stringContaining("Longest line"), expect.stringContaining("Average line length")],
		});
	});

	test("keeps JavaScript-only checks out of non-JavaScript text", () => {
		expect(
			plugins_dist_review_mechanical_findings('main::before { content: "Function(return 1)"; }\n', {
				javaScript: false,
			}),
		).toEqual({ findings: [], advisoryFindings: [] });
	});
});

describe("plugins_list_file_view_matches", () => {
	function file_view_plugin(args: {
		pluginName: string;
		installationCreatedAt: number;
		fileViews: { id: string; contentTypes: string[] }[];
	}) {
		return {
			pluginName: args.pluginName,
			installationCreatedAt: args.installationCreatedAt,
			fileViews: args.fileViews.map((fileView) => ({
				id: fileView.id,
				title: fileView.id,
				entry: "dist/frontend/index.html",
				contentTypes: fileView.contentTypes,
			})),
		};
	}

	test("lists the view whose declared content types include the file's content type", () => {
		const plugins = [
			file_view_plugin({
				pluginName: "player",
				installationCreatedAt: 100,
				fileViews: [
					{ id: "audio", contentTypes: ["audio/mpeg"] },
					{ id: "video", contentTypes: ["video/mp4", "video/webm"] },
				],
			}),
		];

		const matches = plugins_list_file_view_matches(plugins, "video/mp4");
		expect(matches).toHaveLength(1);
		expect(matches[0]?.plugin.pluginName).toBe("player");
		expect(matches[0]?.fileView.id).toBe("video");
		expect(matches[0]?.contentType).toBe("video/mp4");
	});

	test("returns an empty list without a matching view, without a content type, or while plugins load", () => {
		const plugins = [
			file_view_plugin({
				pluginName: "player",
				installationCreatedAt: 100,
				fileViews: [{ id: "video", contentTypes: ["video/mp4"] }],
			}),
		];

		expect(plugins_list_file_view_matches(plugins, "application/zip")).toEqual([]);
		expect(plugins_list_file_view_matches(plugins, undefined)).toEqual([]);
		expect(plugins_list_file_view_matches(undefined, "video/mp4")).toEqual([]);
	});

	test("orders matches by installation creation time, regardless of list order", () => {
		const newer = file_view_plugin({
			pluginName: "newer",
			installationCreatedAt: 200,
			fileViews: [{ id: "video", contentTypes: ["video/mp4"] }],
		});
		const older = file_view_plugin({
			pluginName: "older",
			installationCreatedAt: 100,
			fileViews: [{ id: "video", contentTypes: ["video/mp4"] }],
		});

		expect(plugins_list_file_view_matches([newer, older], "video/mp4").map((match) => match.plugin.pluginName)).toEqual(
			["older", "newer"],
		);
		expect(plugins_list_file_view_matches([older, newer], "video/mp4").map((match) => match.plugin.pluginName)).toEqual(
			["older", "newer"],
		);
	});
});
