import { R2 } from "@convex-dev/r2";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { plugins_ai_review } from "./plugins.ts";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import { plugins_validate_manifest, type plugins_Capability } from "../shared/plugins.ts";
import { crypto_sha256_hex } from "../server/crypto-utils.ts";
import {
	organizations_GLOBAL_GITHUB_WORKSPACE_ID,
	organizations_GLOBAL_ORGANIZATION_ID,
} from "../shared/organizations.ts";

beforeEach(() => {
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (customKey?: string) => ({
		key: customKey ?? "test-upload-key",
		url: "https://r2.test/upload",
	}));
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(null, { status: 200 })),
	);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

function user_identity(userId: Id<"users">) {
	return {
		issuer: "https://clerk.test",
		subject: `clerk-${userId}`,
		external_id: userId,
		email: "plugin-test@example.com",
	};
}

async function register_media_plugin(
	t: ReturnType<typeof test_convex>,
	userId: Id<"users">,
	args: {
		name?: string;
		displayName?: string;
		version?: string;
		contentTypes?: string[];
		sourceRepositoryUrl?: string;
		sourceOwner?: string;
		sourceRepo?: string;
		sourceCommitSha?: string;
		outboundOrigins?: string[];
	} = {},
) {
	const name = args.name ?? "media";
	const version = args.version ?? "0.1.0";
	const registered = await t.action(internal.plugins.register_plugin_version, {
		name,
		displayName: args.displayName ?? "Media",
		version,
		description: "Image and video markdown generation",
		reviewStatus: "passed",
		artifactHash: `sha256:${"a".repeat(64)}`,
		sourceRepositoryUrl: args.sourceRepositoryUrl ?? `https://github.com/bonobo/${name}-plugin`,
		sourceOwner: args.sourceOwner ?? "bonobo",
		sourceRepo: args.sourceRepo ?? `${name}-plugin`,
		sourceDefaultBranch: "main",
		sourceCommitSha: args.sourceCommitSha ?? "1234567890abcdef1234567890abcdef12345678",
		manifestR2Key: `plugins/${name}/manifest.json`,
		backend: {
			entry: "dist/backend/worker.js",
			moduleName: "plugin.js",
			r2Key: `plugins/${name}/backend/worker.js`,
			compatibilityDate: "2026-07-01",
			compatibilityFlags: ["nodejs_compat"],
		},
		events: [{ type: "files.upload.completed", contentTypes: args.contentTypes ?? ["image/png", "video/mp4"] }],
		pages: [{ name: "gallery", displayName: "Gallery", html: "dist/ui/index.html", assets: [] }],
		capabilities: ["plugin.secrets.read", "outbound.fetch"],
		outboundOrigins: args.outboundOrigins ?? [],
		files: [
			{
				path: "dist/backend/worker.js",
				sha256: `sha256:${"b".repeat(64)}`,
				bytes: 128,
				contentType: "application/javascript",
				r2Key: `plugins/${name}/backend/worker.js`,
			},
		],
		createdBy: userId,
		sourceFiles: [{ path: "dist/backend/worker.js", rawText: `export const plugin = '${name}';` }],
	});
	if (registered._nay) {
		throw new Error(registered._nay.message);
	}
	return registered._yay;
}

const media_plugin_consent: { acceptedCapabilities: plugins_Capability[]; acceptedOutboundOrigins: string[] } = {
	acceptedCapabilities: ["plugin.secrets.read", "outbound.fetch"],
	acceptedOutboundOrigins: [],
};

async function sha256_text(value: string) {
	return `sha256:${await crypto_sha256_hex(value)}`;
}

describe("plugins Phase 0", () => {
	test("rejects unsupported backend limit fields in manifests", () => {
		const manifest = {
			schemaVersion: 1,
			name: "media",
			displayName: "Media",
			version: "0.1.0",
			description: "Image and video markdown generation",
			compatibility: { bonoboPluginRuntime: "1" },
			backend: {
				entry: "dist/backend/worker.js",
				moduleName: "plugin.js",
				compatibilityDate: "2026-07-01",
				compatibilityFlags: ["nodejs_compat"],
				limits: { cpuMs: 500 },
			},
			events: [{ type: "files.upload.completed", contentTypes: ["image/png"] }],
			pages: [],
			capabilities: ["plugin.secrets.read"],
			outboundOrigins: [],
			files: [],
		};

		expect(plugins_validate_manifest(manifest)).toMatchObject({ _nay: { message: expect.any(String) } });
	});

	test("reuses existing source mount files for the same immutable plugin version", async () => {
		const t = test_convex();
		const membership = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));

		const first = await register_media_plugin(t, membership.userId);
		const rerun = await register_media_plugin(t, membership.userId);
		expect(rerun.pluginVersionId).toBe(first.pluginVersionId);
		expect(rerun.sourceMountName).toBe(first.sourceMountName);

		// A same-artifact publish from a new commit gets a fresh mount so stale files never mix in.
		const second = await register_media_plugin(t, membership.userId, {
			sourceRepositoryUrl: "https://github.com/sybill-ai-engineering/media-plugin",
			sourceOwner: "sybill-ai-engineering",
			sourceRepo: "media-plugin",
			sourceCommitSha: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
		});
		expect(second.pluginVersionId).toBe(first.pluginVersionId);
		expect(second.sourceMountName).not.toBe(first.sourceMountName);
		const version = await t.run((ctx) => ctx.db.get("plugins_versions", first.pluginVersionId));
		expect(version?.sourceRepositoryUrl).toBe("https://github.com/sybill-ai-engineering/media-plugin");
		expect(version?.sourceOwner).toBe("sybill-ai-engineering");
		expect(version?.sourceCommitSha).toBe("abcdefabcdefabcdefabcdefabcdefabcdefabcd");
	});

	test("registers, installs, and materializes handlers and source mount", async () => {
		const t = test_convex();
		const membership = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const registered = await register_media_plugin(t, membership.userId);
		const asOwner = t.withIdentity(user_identity(membership.userId));

		const installed = await asOwner.mutation(api.plugins.install_version, {
			membershipId: membership.membershipId,
			pluginVersionId: registered.pluginVersionId,
			...media_plugin_consent,
		});
		if (installed._nay) {
			throw new Error(installed._nay.message);
		}

		const listed = await asOwner.query(api.plugins.list_installations, { membershipId: membership.membershipId });
		expect(listed).toHaveLength(1);
		expect(listed[0]!.installation.pluginName).toBe("media");
		expect(listed[0]!.handlers.map((handler: { contentType: string }) => handler.contentType).sort()).toEqual([
			"image/png",
			"video/mp4",
		]);
		expect(listed[0]!.sourceMount?.mountKind).toBe("global-github-temporary");
		expect(listed[0]!.sourceMount?.mountPath).toBe(`/.mounts/${registered.sourceMountName}`);

		const source = await t.query(internal.files_nodes.read_file_content_from_chunks, {
			organizationId: organizations_GLOBAL_ORGANIZATION_ID,
			workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
			userId: membership.userId,
			path: `/${registered.sourceMountName}/dist/backend/worker.js`,
			mode: { kind: "full", maxBytes: 100_000 },
		});
		expect(source?.content).toBe("export const plugin = 'media';");
	});

	test("rejects same-name plugin installs from a different source repository", async () => {
		const t = test_convex();
		const membership = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const first = await register_media_plugin(t, membership.userId, {
			sourceRepositoryUrl: "https://github.com/sybill-ai-engineering/media-plugin",
			sourceOwner: "sybill-ai-engineering",
			sourceRepo: "media-plugin",
		});
		const replacement = await register_media_plugin(t, membership.userId, {
			version: "0.2.0",
			sourceRepositoryUrl: "https://github.com/other/media-plugin",
			sourceOwner: "other",
			sourceRepo: "media-plugin",
			sourceCommitSha: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
		});
		const asOwner = t.withIdentity(user_identity(membership.userId));
		const installed = await asOwner.mutation(api.plugins.install_version, {
			membershipId: membership.membershipId,
			pluginVersionId: first.pluginVersionId,
			...media_plugin_consent,
		});
		if (installed._nay) {
			throw new Error(installed._nay.message);
		}

		const rejected = await asOwner.mutation(api.plugins.install_version, {
			membershipId: membership.membershipId,
			pluginVersionId: replacement.pluginVersionId,
			...media_plugin_consent,
		});

		expect(rejected).toEqual({ _nay: { message: "Plugin name already installed from a different source" } });
	});

	test("stores installation secrets encrypted and lists only redacted metadata", async () => {
		const t = test_convex();
		const membership = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const registered = await register_media_plugin(t, membership.userId);
		const asOwner = t.withIdentity(user_identity(membership.userId));
		const installed = await asOwner.mutation(api.plugins.install_version, {
			membershipId: membership.membershipId,
			pluginVersionId: registered.pluginVersionId,
			...media_plugin_consent,
		});
		if (installed._nay) {
			throw new Error(installed._nay.message);
		}

		const saved = await asOwner.mutation(api.plugins.upsert_installation_secret, {
			membershipId: membership.membershipId,
			installationId: installed._yay.installationId,
			name: "OPENAI_API_KEY",
			value: "sk-plugin-secret",
		});
		if (saved._nay) {
			throw new Error(saved._nay.message);
		}

		const listed = await asOwner.query(api.plugins.list_installation_secrets, {
			membershipId: membership.membershipId,
			installationId: installed._yay.installationId,
		});
		expect(listed).toEqual([
			expect.objectContaining({
				name: "OPENAI_API_KEY",
				valuePreview: "configured",
			}),
		]);
		expect(JSON.stringify(listed)).not.toContain("sk-plugin-secret");

		const resolved = await t.mutation(internal.plugins.get_secret_for_runtime, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			installationId: installed._yay.installationId,
			name: "OPENAI_API_KEY",
		});
		if (!resolved) {
			throw new Error("Expected secret doc");
		}
		expect(resolved.tier).toBe("installation");
		expect(new TextDecoder().decode(resolved.secret.ciphertext)).not.toContain("sk-plugin-secret");

		const decrypted = await t.action(internal.plugins.decrypt_secret_for_runtime, { resolved });
		expect(decrypted).toEqual({ _yay: "sk-plugin-secret" });
	});

	test("stores .env secret batches with a single plugin-management mutation", async () => {
		const t = test_convex();
		const membership = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const registered = await register_media_plugin(t, membership.userId);
		const asOwner = t.withIdentity(user_identity(membership.userId));
		const installed = await asOwner.mutation(api.plugins.install_version, {
			membershipId: membership.membershipId,
			pluginVersionId: registered.pluginVersionId,
			...media_plugin_consent,
		});
		if (installed._nay) {
			throw new Error(installed._nay.message);
		}

		const saved = await asOwner.mutation(api.plugins.upsert_installation_secrets, {
			membershipId: membership.membershipId,
			installationId: installed._yay.installationId,
			secrets: [
				{ name: "CLOUDFLARE_MEDIA_TRANSFORMER_URL", value: "https://media-transformer.test" },
				{ name: "CLOUDFLARE_MEDIA_TRANSFORMER_SECRET", value: "media-secret" },
				{ name: "OPENAI_API_KEY", value: "sk-batch-secret" },
			],
		});
		if (saved._nay) {
			throw new Error(saved._nay.message);
		}
		expect(saved._yay.count).toBe(3);

		const listed = await asOwner.query(api.plugins.list_installation_secrets, {
			membershipId: membership.membershipId,
			installationId: installed._yay.installationId,
		});
		expect(listed.map((secret: { name: string }) => secret.name).sort()).toEqual([
			"CLOUDFLARE_MEDIA_TRANSFORMER_SECRET",
			"CLOUDFLARE_MEDIA_TRANSFORMER_URL",
			"OPENAI_API_KEY",
		]);
		expect(JSON.stringify(listed)).not.toContain("sk-batch-secret");
	});

	test("serves installation secrets through the host secret endpoint with a running plugin token", async () => {
		const t = test_convex();
		const membership = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const registered = await register_media_plugin(t, membership.userId);
		const asOwner = t.withIdentity(user_identity(membership.userId));
		const installed = await asOwner.mutation(api.plugins.install_version, {
			membershipId: membership.membershipId,
			pluginVersionId: registered.pluginVersionId,
			...media_plugin_consent,
		});
		if (installed._nay) {
			throw new Error(installed._nay.message);
		}
		const saved = await asOwner.mutation(api.plugins.upsert_installation_secret, {
			membershipId: membership.membershipId,
			installationId: installed._yay.installationId,
			name: "OPENAI_API_KEY",
			value: "sk-runtime-secret",
		});
		if (saved._nay) {
			throw new Error(saved._nay.message);
		}

		const upload = await asOwner.mutation(api.files_nodes.create_upload_node, {
			membershipId: membership.membershipId,
			parentId: "root",
			filename: "secret.png",
			contentType: "image/png",
			size: 1024,
		});
		if (upload._nay) {
			throw new Error(upload._nay.message);
		}
		const runId = await t.run(async (ctx) => {
			const installation = await ctx.db.get("plugins_workspace_installations", installed._yay.installationId);
			if (!installation) {
				throw new Error("Expected installation");
			}
			return await ctx.db.insert("plugins_event_runs", {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				sourceAssetId: upload._yay.assetId,
				sourceFileNodeId: upload._yay.nodeId,
				actorUserId: membership.userId,
				installationId: installed._yay.installationId,
				pluginVersionId: installation.pluginVersionId,
				event: "files.upload.completed",
				eventId: "plugin:secret-test",
				status: "queued",
				acceptedCapabilities: installation.acceptedCapabilities,
				expiresAt: Date.now() + 30 * 60 * 1000,
				hostCallCount: 0,
				hostWriteCount: 0,
				errorMessage: null,
				updatedAt: Date.now(),
			});
		});
		const hostToken = "host-token-secret-test";
		await t.mutation(internal.plugins_runtime.start_event_run, {
			runId,
			hostTokenHash: await crypto_sha256_hex(hostToken),
			hostTokenExpiresAt: Date.now() + 15 * 60 * 1000,
		});

		const response = await t.fetch("/api/internal/plugins/host/secret-get", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${hostToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				pluginRunId: runId,
				name: "OPENAI_API_KEY",
			}),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ value: "sk-runtime-secret" });

		const run = await t.run((ctx) => ctx.db.get("plugins_event_runs", runId));
		expect(run?.hostCallCount).toBe(1);
		const calls = await t.run((ctx) =>
			ctx.db
				.query("plugins_event_run_calls")
				.withIndex("by_run_sequence", (q) => q.eq("runId", runId))
				.collect(),
		);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			sequence: 1,
			operation: "secretGet",
			status: "succeeded",
			secretName: "OPENAI_API_KEY",
			secretFound: true,
			errorMessage: null,
		});
		expect(JSON.stringify(calls)).not.toContain("sk-runtime-secret");
	});

	test("records runner-local host call telemetry without storing raw payloads", async () => {
		const t = test_convex();
		const membership = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const registered = await register_media_plugin(t, membership.userId);
		const asOwner = t.withIdentity(user_identity(membership.userId));
		const installed = await asOwner.mutation(api.plugins.install_version, {
			membershipId: membership.membershipId,
			pluginVersionId: registered.pluginVersionId,
			...media_plugin_consent,
		});
		if (installed._nay) {
			throw new Error(installed._nay.message);
		}
		const upload = await asOwner.mutation(api.files_nodes.create_upload_node, {
			membershipId: membership.membershipId,
			parentId: "root",
			filename: "audio.mp4",
			contentType: "video/mp4",
			size: 1024,
		});
		if (upload._nay) {
			throw new Error(upload._nay.message);
		}
		const runId = await t.run(async (ctx) => {
			const installation = await ctx.db.get("plugins_workspace_installations", installed._yay.installationId);
			if (!installation) {
				throw new Error("Expected installation");
			}
			return await ctx.db.insert("plugins_event_runs", {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				sourceAssetId: upload._yay.assetId,
				sourceFileNodeId: upload._yay.nodeId,
				actorUserId: membership.userId,
				installationId: installed._yay.installationId,
				pluginVersionId: installation.pluginVersionId,
				event: "files.upload.completed",
				eventId: "plugin:runner-call-test",
				status: "queued",
				acceptedCapabilities: ["outbound.fetch"],
				expiresAt: Date.now() + 30 * 60 * 1000,
				hostCallCount: 0,
				hostWriteCount: 0,
				errorMessage: null,
				updatedAt: Date.now(),
			});
		});
		const hostToken = "host-token-runner-call-test";
		await t.mutation(internal.plugins_runtime.start_event_run, {
			runId,
			hostTokenHash: await crypto_sha256_hex(hostToken),
			hostTokenExpiresAt: Date.now() + 15 * 60 * 1000,
		});

		const claimed = await t.fetch("/api/internal/plugins/host/claim-runner-call", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${hostToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				pluginRunId: runId,
				operation: "outboundFetch",
				requestBytes: 3,
			}),
		});
		expect(claimed.status).toBe(200);
		const claimedBody = (await claimed.json()) as { callId: string };
		const finished = await t.fetch("/api/internal/plugins/host/finish-runner-call", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${hostToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				pluginRunId: runId,
				callId: claimedBody.callId,
				status: "succeeded",
				errorMessage: null,
				requestBytes: 3,
				responseBytes: 23,
				responseStatus: 200,
			}),
		});
		expect(finished.status).toBe(200);

		const run = await t.run((ctx) => ctx.db.get("plugins_event_runs", runId));
		expect(run?.hostCallCount).toBe(1);
		const calls = await t.run((ctx) =>
			ctx.db
				.query("plugins_event_run_calls")
				.withIndex("by_run_sequence", (q) => q.eq("runId", runId))
				.collect(),
		);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			sequence: 1,
			operation: "outboundFetch",
			status: "succeeded",
			requestBytes: 3,
			responseBytes: 23,
			responseStatus: 200,
			errorMessage: null,
		});
		expect(JSON.stringify(calls)).not.toContain("AQID");
		const visibleCalls = await asOwner.query(api.plugins.list_run_calls, {
			membershipId: membership.membershipId,
			installationId: installed._yay.installationId,
			runId,
		});
		expect(visibleCalls).toHaveLength(1);
		expect(visibleCalls[0]).toMatchObject({
			sequence: 1,
			operation: "outboundFetch",
			status: "succeeded",
			requestBytes: 3,
			responseBytes: 23,
			responseStatus: 200,
		});
		expect(JSON.stringify(visibleCalls)).not.toContain("AQID");
	});

	test("enqueues multiple upload plugins without storing plugin work ids on the source asset", async () => {
		const t = test_convex();
		const membership = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const media = await register_media_plugin(t, membership.userId, { name: "media" });
		const alternate = await register_media_plugin(t, membership.userId, {
			name: "media-alt",
			displayName: "Media Alt",
			contentTypes: ["image/png"],
		});
		const asOwner = t.withIdentity(user_identity(membership.userId));
		for (const plugin of [media, alternate]) {
			const installed = await asOwner.mutation(api.plugins.install_version, {
				membershipId: membership.membershipId,
				pluginVersionId: plugin.pluginVersionId,
				...media_plugin_consent,
			});
			if (installed._nay) {
				throw new Error(installed._nay.message);
			}
		}
		const upload = await asOwner.mutation(api.files_nodes.create_upload_node, {
			membershipId: membership.membershipId,
			parentId: "root",
			filename: "multi.png",
			contentType: "image/png",
			size: 1024,
		});
		if (upload._nay) {
			throw new Error(upload._nay.message);
		}
		await t.run((ctx) => ctx.db.patch("files_r2_assets", upload._yay.assetId, { r2Key: "uploads/multi.png" }));

		const enqueued = await t.mutation(internal.plugins_runtime.enqueue_upload_completed_runs, {
			sourceAssetId: upload._yay.assetId,
			sourceFileNodeId: upload._yay.nodeId,
			eventId: "r2:multi",
			contentType: "image/png",
		});

		expect(enqueued).toEqual({ _yay: { enqueued: 2 } });
		const asset = await t.run((ctx) => ctx.db.get("files_r2_assets", upload._yay.assetId));
		expect(asset?.conversionWorkId).toBeNull();
		const runs = await t.run((ctx) => ctx.db.query("plugins_event_runs").collect());
		expect(runs).toHaveLength(2);
		expect(runs.every((run) => run.workId !== undefined)).toBe(true);
		expect(new Set(runs.map((run) => run.installationId)).size).toBe(2);
	});

	test("dispatches upload events for any handler-subscribed content type", async () => {
		const t = test_convex();
		const membership = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const registered = await register_media_plugin(t, membership.userId, {
			name: "plain-text",
			displayName: "Plain Text",
			contentTypes: ["text/plain"],
		});
		const asOwner = t.withIdentity(user_identity(membership.userId));
		const installed = await asOwner.mutation(api.plugins.install_version, {
			membershipId: membership.membershipId,
			pluginVersionId: registered.pluginVersionId,
			...media_plugin_consent,
		});
		if (installed._nay) {
			throw new Error(installed._nay.message);
		}
		const upload = await asOwner.mutation(api.files_nodes.create_upload_node, {
			membershipId: membership.membershipId,
			parentId: "root",
			filename: "notes.txt",
			contentType: "text/plain",
			size: 1024,
		});
		if (upload._nay) {
			throw new Error(upload._nay.message);
		}

		const processed = await t.mutation(internal.r2.process_uploaded_asset_event, {
			assetId: upload._yay.assetId,
			r2Key: "uploads/notes.txt",
			size: 1024,
			eventId: "r2:notes",
		});
		expect(processed).toEqual({ _yay: null });
		const runs = await t.run((ctx) => ctx.db.query("plugins_event_runs").collect());
		expect(runs).toHaveLength(1);
		expect(runs[0]).toMatchObject({
			installationId: installed._yay.installationId,
			event: "files.upload.completed",
			status: "queued",
		});
		const asset = await t.run((ctx) => ctx.db.get("files_r2_assets", upload._yay.assetId));
		expect(asset?.conversionWorkId).toBeNull();

		const unsubscribed = await asOwner.mutation(api.files_nodes.create_upload_node, {
			membershipId: membership.membershipId,
			parentId: "root",
			filename: "archive.zip",
			contentType: "application/zip",
			size: 1024,
		});
		if (unsubscribed._nay) {
			throw new Error(unsubscribed._nay.message);
		}
		const processedUnsubscribed = await t.mutation(internal.r2.process_uploaded_asset_event, {
			assetId: unsubscribed._yay.assetId,
			r2Key: "uploads/archive.zip",
			size: 1024,
			eventId: "r2:archive",
		});
		expect(processedUnsubscribed).toEqual({ _yay: null });
		const runsAfterUnsubscribed = await t.run((ctx) => ctx.db.query("plugins_event_runs").collect());
		expect(runsAfterUnsubscribed).toHaveLength(1);
		const unsubscribedAsset = await t.run((ctx) => ctx.db.get("files_r2_assets", unsubscribed._yay.assetId));
		expect(unsubscribedAsset?.conversionWorkId).toBeNull();
	});

	test("rejects markdown output conflicts when overwrite is fail", async () => {
		const t = test_convex();
		const membership = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const registered = await register_media_plugin(t, membership.userId);
		const asOwner = t.withIdentity(user_identity(membership.userId));
		const installed = await asOwner.mutation(api.plugins.install_version, {
			membershipId: membership.membershipId,
			pluginVersionId: registered.pluginVersionId,
			...media_plugin_consent,
		});
		if (installed._nay) {
			throw new Error(installed._nay.message);
		}
		const upload = await asOwner.mutation(api.files_nodes.create_upload_node, {
			membershipId: membership.membershipId,
			parentId: "root",
			filename: "conflict.png",
			contentType: "image/png",
			size: 1024,
		});
		if (upload._nay) {
			throw new Error(upload._nay.message);
		}
		const conflict = await asOwner.mutation(api.files_nodes.create_upload_node, {
			membershipId: membership.membershipId,
			parentId: "root",
			filename: "existing.md",
			contentType: "text/markdown;charset=utf-8",
			size: 3,
		});
		if (conflict._nay) {
			throw new Error(conflict._nay.message);
		}
		const runId = await t.run(async (ctx) => {
			const installation = await ctx.db.get("plugins_workspace_installations", installed._yay.installationId);
			if (!installation) {
				throw new Error("Expected installation");
			}
			return await ctx.db.insert("plugins_event_runs", {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				sourceAssetId: upload._yay.assetId,
				sourceFileNodeId: upload._yay.nodeId,
				actorUserId: membership.userId,
				installationId: installed._yay.installationId,
				pluginVersionId: installation.pluginVersionId,
				event: "files.upload.completed",
				eventId: "plugin:overwrite-test",
				status: "queued",
				acceptedCapabilities: installation.acceptedCapabilities,
				expiresAt: Date.now() + 30 * 60 * 1000,
				hostCallCount: 0,
				hostWriteCount: 0,
				errorMessage: null,
				updatedAt: Date.now(),
			});
		});
		const hostToken = "host-token-overwrite-test";
		await t.mutation(internal.plugins_runtime.start_event_run, {
			runId,
			hostTokenHash: await crypto_sha256_hex(hostToken),
			hostTokenExpiresAt: Date.now() + 15 * 60 * 1000,
		});

		const response = await t.fetch("/api/plugins/v1/write-markdown", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${hostToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				pluginRunId: runId,
				path: "existing.md",
				markdown: "# New",
				overwrite: "fail",
			}),
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ message: "Output path already exists" });
		const run = await t.run((ctx) => ctx.db.get("plugins_event_runs", runId));
		expect(run?.hostCallCount).toBe(1);
		expect(run?.hostWriteCount).toBe(0);
		const calls = await t.run((ctx) =>
			ctx.db
				.query("plugins_event_run_calls")
				.withIndex("by_run_sequence", (q) => q.eq("runId", runId))
				.collect(),
		);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			sequence: 1,
			operation: "writeMarkdown",
			status: "failed",
			outputPath: "existing.md",
			outputOverwrite: "fail",
			markdownBytes: 5,
			errorMessage: "Output path already exists",
		});
		expect(calls[0]?.finishedAt).toBeDefined();
		expect(calls[0]?.elapsedMs).toBe(0);
	});

	test("rejects plugin markdown outputs outside a simple markdown filename", async () => {
		const t = test_convex();
		const membership = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const registered = await register_media_plugin(t, membership.userId);
		const asOwner = t.withIdentity(user_identity(membership.userId));
		const installed = await asOwner.mutation(api.plugins.install_version, {
			membershipId: membership.membershipId,
			pluginVersionId: registered.pluginVersionId,
			...media_plugin_consent,
		});
		if (installed._nay) {
			throw new Error(installed._nay.message);
		}
		const upload = await asOwner.mutation(api.files_nodes.create_upload_node, {
			membershipId: membership.membershipId,
			parentId: "root",
			filename: "unsafe.png",
			contentType: "image/png",
			size: 1024,
		});
		if (upload._nay) {
			throw new Error(upload._nay.message);
		}
		const runId = await t.run(async (ctx) => {
			const installation = await ctx.db.get("plugins_workspace_installations", installed._yay.installationId);
			if (!installation) {
				throw new Error("Expected installation");
			}
			return await ctx.db.insert("plugins_event_runs", {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				sourceAssetId: upload._yay.assetId,
				sourceFileNodeId: upload._yay.nodeId,
				actorUserId: membership.userId,
				installationId: installed._yay.installationId,
				pluginVersionId: installation.pluginVersionId,
				event: "files.upload.completed",
				eventId: "plugin:unsafe-output-test",
				status: "queued",
				acceptedCapabilities: installation.acceptedCapabilities,
				expiresAt: Date.now() + 30 * 60 * 1000,
				hostCallCount: 0,
				hostWriteCount: 0,
				errorMessage: null,
				updatedAt: Date.now(),
			});
		});
		const hostToken = "host-token-unsafe-output-test";
		await t.mutation(internal.plugins_runtime.start_event_run, {
			runId,
			hostTokenHash: await crypto_sha256_hex(hostToken),
			hostTokenExpiresAt: Date.now() + 15 * 60 * 1000,
		});

		const response = await t.fetch("/api/plugins/v1/write-markdown", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${hostToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				pluginRunId: runId,
				path: "../escaped/unsafe.md",
				markdown: "# New",
				overwrite: "replace",
			}),
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ message: "Output path is invalid" });
		const run = await t.run((ctx) => ctx.db.get("plugins_event_runs", runId));
		expect(run?.hostCallCount).toBe(1);
		expect(run?.hostWriteCount).toBe(0);
		const calls = await t.run((ctx) =>
			ctx.db
				.query("plugins_event_run_calls")
				.withIndex("by_run_sequence", (q) => q.eq("runId", runId))
				.collect(),
		);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			sequence: 1,
			operation: "writeMarkdown",
			status: "failed",
			errorMessage: "Output path is invalid",
		});
	});

	test("normalizes plugin markdown output names before writing files", async () => {
		const t = test_convex();
		const membership = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const registered = await register_media_plugin(t, membership.userId);
		const asOwner = t.withIdentity(user_identity(membership.userId));
		const installed = await asOwner.mutation(api.plugins.install_version, {
			membershipId: membership.membershipId,
			pluginVersionId: registered.pluginVersionId,
			...media_plugin_consent,
		});
		if (installed._nay) {
			throw new Error(installed._nay.message);
		}
		const upload = await asOwner.mutation(api.files_nodes.create_upload_node, {
			membershipId: membership.membershipId,
			parentId: "root",
			filename: "plugin-live-image-20260702t011841z.png",
			contentType: "image/png",
			size: 1024,
		});
		if (upload._nay) {
			throw new Error(upload._nay.message);
		}
		const runId = await t.run(async (ctx) => {
			const installation = await ctx.db.get("plugins_workspace_installations", installed._yay.installationId);
			if (!installation) {
				throw new Error("Expected installation");
			}
			return await ctx.db.insert("plugins_event_runs", {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				sourceAssetId: upload._yay.assetId,
				sourceFileNodeId: upload._yay.nodeId,
				actorUserId: membership.userId,
				installationId: installed._yay.installationId,
				pluginVersionId: installation.pluginVersionId,
				event: "files.upload.completed",
				eventId: "plugin:normalized-output-test",
				status: "queued",
				acceptedCapabilities: installation.acceptedCapabilities,
				expiresAt: Date.now() + 30 * 60 * 1000,
				hostCallCount: 0,
				hostWriteCount: 0,
				errorMessage: null,
				updatedAt: Date.now(),
			});
		});
		const hostToken = "host-token-normalized-output-test";
		await t.mutation(internal.plugins_runtime.start_event_run, {
			runId,
			hostTokenHash: await crypto_sha256_hex(hostToken),
			hostTokenExpiresAt: Date.now() + 15 * 60 * 1000,
		});

		const response = await t.fetch("/api/plugins/v1/write-markdown", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${hostToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				pluginRunId: runId,
				path: "Plugin Live Image 20260702T011841Z.png.description.md",
				markdown: "# Description",
				overwrite: "replace",
			}),
		});

		expect(response.status).toBe(200);
		const output = await t.run((ctx) =>
			ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_parent_name_archiveOperation", (q) =>
					q
						.eq("organizationId", membership.organizationId)
						.eq("workspaceId", membership.workspaceId)
						.eq("parentId", "root")
						.eq("name", "plugin-live-image-20260702t011841z.png.description.md")
						.eq("archiveOperationId", undefined),
				)
				.unique(),
		);
		expect(output?.name).toBe("plugin-live-image-20260702t011841z.png.description.md");
		const calls = await t.run((ctx) =>
			ctx.db
				.query("plugins_event_run_calls")
				.withIndex("by_run_sequence", (q) => q.eq("runId", runId))
				.collect(),
		);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			sequence: 1,
			operation: "writeMarkdown",
			status: "succeeded",
			outputPath: "plugin-live-image-20260702t011841z.png.description.md",
			markdownBytes: 13,
			errorMessage: null,
		});
	});

	test("allows one plugin run to write multiple markdown outputs", async () => {
		const t = test_convex();
		const membership = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const registered = await register_media_plugin(t, membership.userId);
		const asOwner = t.withIdentity(user_identity(membership.userId));
		const installed = await asOwner.mutation(api.plugins.install_version, {
			membershipId: membership.membershipId,
			pluginVersionId: registered.pluginVersionId,
			...media_plugin_consent,
		});
		if (installed._nay) {
			throw new Error(installed._nay.message);
		}
		const upload = await asOwner.mutation(api.files_nodes.create_upload_node, {
			membershipId: membership.membershipId,
			parentId: "root",
			filename: "video.mp4",
			contentType: "video/mp4",
			size: 1024,
		});
		if (upload._nay) {
			throw new Error(upload._nay.message);
		}
		const runId = await t.run(async (ctx) => {
			const installation = await ctx.db.get("plugins_workspace_installations", installed._yay.installationId);
			if (!installation) {
				throw new Error("Expected installation");
			}
			return await ctx.db.insert("plugins_event_runs", {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				sourceAssetId: upload._yay.assetId,
				sourceFileNodeId: upload._yay.nodeId,
				actorUserId: membership.userId,
				installationId: installed._yay.installationId,
				pluginVersionId: installation.pluginVersionId,
				event: "files.upload.completed",
				eventId: "plugin:multiple-output-test",
				status: "queued",
				acceptedCapabilities: installation.acceptedCapabilities,
				expiresAt: Date.now() + 30 * 60 * 1000,
				hostCallCount: 0,
				hostWriteCount: 0,
				errorMessage: null,
				updatedAt: Date.now(),
			});
		});
		const hostToken = "host-token-multiple-output-test";
		await t.mutation(internal.plugins_runtime.start_event_run, {
			runId,
			hostTokenHash: await crypto_sha256_hex(hostToken),
			hostTokenExpiresAt: Date.now() + 15 * 60 * 1000,
		});

		for (const output of [
			{ path: "video.transcript.md", markdown: "# Transcript\n\nHello from the transcript." },
			{ path: "video.summary.md", markdown: "# Summary\n\nThe video is summarized here." },
		]) {
			const response = await t.fetch("/api/plugins/v1/write-markdown", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${hostToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					pluginRunId: runId,
					path: output.path,
					markdown: output.markdown,
					overwrite: "replace",
				}),
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ ok: true });
		}

		const transcript = await t.query(internal.files_nodes.read_file_content_from_chunks, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: membership.userId,
			path: "/video.transcript.md",
			mode: { kind: "full", maxBytes: 100_000 },
		});
		expect(transcript?.content).toBe("# Transcript\n\nHello from the transcript.");
		const summary = await t.query(internal.files_nodes.read_file_content_from_chunks, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: membership.userId,
			path: "/video.summary.md",
			mode: { kind: "full", maxBytes: 100_000 },
		});
		expect(summary?.content).toBe("# Summary\n\nThe video is summarized here.");

		const run = await t.run((ctx) => ctx.db.get("plugins_event_runs", runId));
		expect(run?.hostWriteCount).toBe(2);
		if (!run?.outputFileNodeId) {
			throw new Error("Expected latest output file id");
		}
		const latestOutput = await t.run((ctx) => ctx.db.get("files_nodes", run.outputFileNodeId!));
		expect(latestOutput?.path).toBe("/video.summary.md");
		const calls = await t.run((ctx) =>
			ctx.db
				.query("plugins_event_run_calls")
				.withIndex("by_run_sequence", (q) => q.eq("runId", runId))
				.collect(),
		);
		expect(calls.map((call) => [call.sequence, call.operation, call.status, call.outputPath])).toEqual([
			[1, "writeMarkdown", "succeeded", "video.transcript.md"],
			[2, "writeMarkdown", "succeeded", "video.summary.md"],
		]);
		expect(calls.map((call) => call.markdownBytes)).toEqual([40, 40]);
		expect(calls.every((call) => call.finishedAt !== undefined && call.elapsedMs !== undefined)).toBe(true);
		expect(JSON.stringify(calls)).not.toContain("Hello from the transcript");
		expect(JSON.stringify(calls)).not.toContain("The video is summarized here");
	});

	test("marks a run failed when the runner reports a non-2xx plugin status", async () => {
		const t = test_convex();
		const membership = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const registered = await register_media_plugin(t, membership.userId);
		const asOwner = t.withIdentity(user_identity(membership.userId));
		const installed = await asOwner.mutation(api.plugins.install_version, {
			membershipId: membership.membershipId,
			pluginVersionId: registered.pluginVersionId,
			...media_plugin_consent,
		});
		if (installed._nay) {
			throw new Error(installed._nay.message);
		}
		const upload = await asOwner.mutation(api.files_nodes.create_upload_node, {
			membershipId: membership.membershipId,
			parentId: "root",
			filename: "failed.png",
			contentType: "image/png",
			size: 1024,
		});
		if (upload._nay) {
			throw new Error(upload._nay.message);
		}
		await t.run((ctx) => ctx.db.patch("files_r2_assets", upload._yay.assetId, { r2Key: "uploads/failed.png" }));
		const runId = await t.run(async (ctx) => {
			const installation = await ctx.db.get("plugins_workspace_installations", installed._yay.installationId);
			if (!installation) {
				throw new Error("Expected installation");
			}
			return await ctx.db.insert("plugins_event_runs", {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				sourceAssetId: upload._yay.assetId,
				sourceFileNodeId: upload._yay.nodeId,
				actorUserId: membership.userId,
				installationId: installed._yay.installationId,
				pluginVersionId: installation.pluginVersionId,
				event: "files.upload.completed",
				eventId: "plugin:failed-status-test",
				status: "queued",
				acceptedCapabilities: installation.acceptedCapabilities,
				expiresAt: Date.now() + 30 * 60 * 1000,
				hostCallCount: 1,
				hostWriteCount: 1,
				errorMessage: null,
				updatedAt: Date.now(),
			});
		});
		vi.mocked(fetch).mockResolvedValue(
			new Response(
				JSON.stringify({
					status: "succeeded",
					pluginStatus: 500,
					elapsedMs: 12,
					outputBytes: 13,
					outputTruncated: false,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);

		await t.action(internal.plugins_runtime.execute_upload_completed_event_run, { runId });

		const run = await t.run((ctx) => ctx.db.get("plugins_event_runs", runId));
		expect(run).toMatchObject({
			status: "failed",
			errorMessage: "Plugin returned status 500",
			runnerHttpStatus: 200,
			pluginStatus: 500,
			runnerElapsedMs: 12,
			runnerOutputBytes: 13,
			runnerOutputTruncated: false,
		});
	});

	test("does not mark a run succeeded without a completed markdown write", async () => {
		const t = test_convex();
		const membership = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const registered = await register_media_plugin(t, membership.userId);
		const asOwner = t.withIdentity(user_identity(membership.userId));
		const installed = await asOwner.mutation(api.plugins.install_version, {
			membershipId: membership.membershipId,
			pluginVersionId: registered.pluginVersionId,
			...media_plugin_consent,
		});
		if (installed._nay) {
			throw new Error(installed._nay.message);
		}
		const upload = await asOwner.mutation(api.files_nodes.create_upload_node, {
			membershipId: membership.membershipId,
			parentId: "root",
			filename: "no-output.png",
			contentType: "image/png",
			size: 1024,
		});
		if (upload._nay) {
			throw new Error(upload._nay.message);
		}
		const runId = await t.run(async (ctx) => {
			const installation = await ctx.db.get("plugins_workspace_installations", installed._yay.installationId);
			if (!installation) {
				throw new Error("Expected installation");
			}
			return await ctx.db.insert("plugins_event_runs", {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				sourceAssetId: upload._yay.assetId,
				sourceFileNodeId: upload._yay.nodeId,
				actorUserId: membership.userId,
				installationId: installed._yay.installationId,
				pluginVersionId: installation.pluginVersionId,
				event: "files.upload.completed",
				eventId: "plugin:no-output-test",
				status: "queued",
				acceptedCapabilities: installation.acceptedCapabilities,
				expiresAt: Date.now() + 30 * 60 * 1000,
				hostCallCount: 1,
				hostWriteCount: 1,
				errorMessage: null,
				updatedAt: Date.now(),
			});
		});
		vi.mocked(fetch).mockResolvedValue(
			new Response(
				JSON.stringify({
					status: "succeeded",
					pluginStatus: 200,
					elapsedMs: 12,
					outputBytes: 2,
					outputTruncated: false,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);

		await t.action(internal.plugins_runtime.execute_upload_completed_event_run, { runId });

		const run = await t.run((ctx) => ctx.db.get("plugins_event_runs", runId));
		expect(run).toMatchObject({
			status: "failed",
			errorMessage: "Plugin produced no Markdown output",
			runnerHttpStatus: 200,
			pluginStatus: 200,
		});
	});

	test("does not persist raw plugin exception messages from the runner", async () => {
		const t = test_convex();
		const membership = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const registered = await register_media_plugin(t, membership.userId);
		const asOwner = t.withIdentity(user_identity(membership.userId));
		const installed = await asOwner.mutation(api.plugins.install_version, {
			membershipId: membership.membershipId,
			pluginVersionId: registered.pluginVersionId,
			...media_plugin_consent,
		});
		if (installed._nay) {
			throw new Error(installed._nay.message);
		}
		const upload = await asOwner.mutation(api.files_nodes.create_upload_node, {
			membershipId: membership.membershipId,
			parentId: "root",
			filename: "secret-error.png",
			contentType: "image/png",
			size: 1024,
		});
		if (upload._nay) {
			throw new Error(upload._nay.message);
		}
		const runId = await t.run(async (ctx) => {
			const installation = await ctx.db.get("plugins_workspace_installations", installed._yay.installationId);
			if (!installation) {
				throw new Error("Expected installation");
			}
			return await ctx.db.insert("plugins_event_runs", {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				sourceAssetId: upload._yay.assetId,
				sourceFileNodeId: upload._yay.nodeId,
				actorUserId: membership.userId,
				installationId: installed._yay.installationId,
				pluginVersionId: installation.pluginVersionId,
				event: "files.upload.completed",
				eventId: "plugin:secret-error-test",
				status: "queued",
				acceptedCapabilities: installation.acceptedCapabilities,
				expiresAt: Date.now() + 30 * 60 * 1000,
				hostCallCount: 0,
				hostWriteCount: 0,
				errorMessage: null,
				updatedAt: Date.now(),
			});
		});
		vi.mocked(fetch).mockResolvedValue(
			new Response(
				JSON.stringify({
					status: "errored",
					error: { name: "Error", message: "sk-runtime-secret" },
					elapsedMs: 12,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);

		await t.action(internal.plugins_runtime.execute_upload_completed_event_run, { runId });

		const run = await t.run((ctx) => ctx.db.get("plugins_event_runs", runId));
		expect(run).toMatchObject({
			status: "failed",
			errorMessage: "Plugin execution failed",
			runnerHttpStatus: 200,
		});
		expect(JSON.stringify(run)).not.toContain("sk-runtime-secret");
	});

	test("denies install for a workspace member without plugin management permission", async () => {
		const t = test_convex();
		const membership = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const registered = await register_media_plugin(t, membership.userId);
		const memberUserId = await t.run(async (ctx) => {
			const userId = await ctx.db.insert("users", { clerkUserId: null });
			await ctx.db.insert("organizations_workspaces_users", {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId,
				active: true,
				updatedAt: Date.now(),
			});
			await ctx.db.insert("access_control_role_assignments", {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId,
				role: "member",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			return userId;
		});
		const memberMembershipId = await t.run(async (ctx) => {
			const member = await ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_workspace_user_active", (q) =>
					q.eq("workspaceId", membership.workspaceId).eq("userId", memberUserId).eq("active", true),
				)
				.first();
			if (!member) {
				throw new Error("Expected member membership");
			}
			return member._id;
		});

		const asOwner = t.withIdentity(user_identity(membership.userId));
		const ownerInstalled = await asOwner.mutation(api.plugins.install_version, {
			membershipId: membership.membershipId,
			pluginVersionId: registered.pluginVersionId,
			...media_plugin_consent,
		});
		if (ownerInstalled._nay) {
			throw new Error(ownerInstalled._nay.message);
		}

		const asMember = t.withIdentity(user_identity(memberUserId));
		const listed = await asMember.query(api.plugins.list_installations, { membershipId: memberMembershipId });
		expect(listed).toEqual([]);

		const installed = await asMember.mutation(api.plugins.install_version, {
			membershipId: memberMembershipId,
			pluginVersionId: registered.pluginVersionId,
			...media_plugin_consent,
		});
		expect(installed).toEqual({ _nay: { message: "Permission denied" } });
	});
});

describe("plugins publisher", () => {
	async function create_publisher_user(t: ReturnType<typeof test_convex>) {
		return await t.run((ctx) => ctx.db.insert("users", { clerkUserId: null }));
	}

	test("list_user_published_repositories is empty when signed out and sorts repositories by URL", async () => {
		const t = test_convex();
		const userId = await create_publisher_user(t);
		const asUser = t.withIdentity(user_identity(userId));

		expect(await t.query(api.plugins.list_user_published_repositories, {})).toEqual([]);
		expect(await asUser.query(api.plugins.list_user_published_repositories, {})).toEqual([]);

		await t.run(async (ctx) => {
			await ctx.db.insert("plugins_publisher_repositories", {
				ownerUserId: userId,
				repositoryUrl: "https://github.com/bonobo/zeta-plugin",
				owner: "bonobo",
				repo: "zeta-plugin",
			});
			await ctx.db.insert("plugins_publisher_repositories", {
				ownerUserId: userId,
				repositoryUrl: "https://github.com/bonobo/alpha-plugin",
				owner: "bonobo",
				repo: "alpha-plugin",
			});
		});

		const mine = await asUser.query(api.plugins.list_user_published_repositories, {});
		expect(mine.map((item) => item.repository.repositoryUrl)).toEqual([
			"https://github.com/bonobo/alpha-plugin",
			"https://github.com/bonobo/zeta-plugin",
		]);
		expect(mine.map((item) => item.latestVersion)).toEqual([null, null]);
	});

	test("claims a repository with a normalized URL and is idempotent for the same user", async () => {
		const t = test_convex();
		const userId = await create_publisher_user(t);
		const asUser = t.withIdentity(user_identity(userId));

		const claimed = await asUser.mutation(api.plugins.claim_repository, {
			repositoryUrl: "git@github.com:bonobo/pdf-plugin.git",
		});
		if (claimed._nay) {
			throw new Error(claimed._nay.message);
		}
		expect(claimed._yay.repositoryUrl).toBe("https://github.com/bonobo/pdf-plugin");

		const repository = await t.run((ctx) => ctx.db.get("plugins_publisher_repositories", claimed._yay.repositoryId));
		expect(repository).toMatchObject({
			ownerUserId: userId,
			repositoryUrl: "https://github.com/bonobo/pdf-plugin",
			owner: "bonobo",
			repo: "pdf-plugin",
		});

		const reclaimed = await asUser.mutation(api.plugins.claim_repository, {
			repositoryUrl: "https://github.com/bonobo/pdf-plugin.git",
		});
		expect(reclaimed).toEqual({
			_yay: { repositoryId: claimed._yay.repositoryId, repositoryUrl: "https://github.com/bonobo/pdf-plugin" },
		});

		const repositories = await t.run((ctx) =>
			ctx.db
				.query("plugins_publisher_repositories")
				.withIndex("by_ownerUser_repositoryUrl", (q) => q.eq("ownerUserId", userId))
				.collect(),
		);
		expect(repositories).toHaveLength(1);
	});

	test("rejects claims for repositories claimed by another user and invalid repository URLs", async () => {
		const t = test_convex();
		const firstUserId = await create_publisher_user(t);
		const secondUserId = await create_publisher_user(t);

		const claimed = await t.withIdentity(user_identity(firstUserId)).mutation(api.plugins.claim_repository, {
			repositoryUrl: "https://github.com/bonobo/media-plugin",
		});
		if (claimed._nay) {
			throw new Error(claimed._nay.message);
		}

		const asSecondUser = t.withIdentity(user_identity(secondUserId));
		const alreadyClaimed = await asSecondUser.mutation(api.plugins.claim_repository, {
			repositoryUrl: "git@github.com:bonobo/media-plugin.git",
		});
		expect(alreadyClaimed).toEqual({ _nay: { message: "Repository is already claimed by another user" } });

		const invalidUrl = await asSecondUser.mutation(api.plugins.claim_repository, {
			repositoryUrl: "not-a-url",
		});
		expect(invalidUrl).toEqual({ _nay: { message: "Repository URL must be a GitHub URL" } });
	});

	test("removes a repository claim only for the owning user", async () => {
		const t = test_convex();
		const ownerUserId = await create_publisher_user(t);
		const otherUserId = await create_publisher_user(t);
		const repositoryId = await t.run((ctx) =>
			ctx.db.insert("plugins_publisher_repositories", {
				ownerUserId,
				repositoryUrl: "https://github.com/bonobo/media-plugin",
				owner: "bonobo",
				repo: "media-plugin",
			}),
		);
		const asOwner = t.withIdentity(user_identity(ownerUserId));

		const notOwned = await t.withIdentity(user_identity(otherUserId)).mutation(api.plugins.remove_repository, {
			repositoryId,
		});
		expect(notOwned).toEqual({ _nay: { message: "Unauthorized" } });

		const removed = await asOwner.mutation(api.plugins.remove_repository, { repositoryId });
		expect(removed).toEqual({ _yay: null });
		const repository = await t.run((ctx) => ctx.db.get("plugins_publisher_repositories", repositoryId));
		expect(repository).toBeNull();

		const missing = await asOwner.mutation(api.plugins.remove_repository, { repositoryId });
		expect(missing).toEqual({ _nay: { message: "Not found" } });
	});

	test("rejects anonymous users for publisher management and publish authorization", async () => {
		const t = test_convex();
		const ownerUserId = await create_publisher_user(t);
		const repositoryId = await t.run((ctx) =>
			ctx.db.insert("plugins_publisher_repositories", {
				ownerUserId,
				repositoryUrl: "https://github.com/bonobo/media-plugin",
				owner: "bonobo",
				repo: "media-plugin",
			}),
		);
		// Same user id as the repository owner: even the owner is rejected while authenticated anonymously.
		const asAnonymous = t.withIdentity({
			issuer: process.env.VITE_CONVEX_HTTP_URL!,
			subject: ownerUserId,
			name: "Anonymous Publisher",
		});

		const claimed = await asAnonymous.mutation(api.plugins.claim_repository, {
			repositoryUrl: "https://github.com/bonobo/other-plugin",
		});
		expect(claimed).toEqual({ _nay: { message: "Sign in to publish plugins" } });

		const removed = await asAnonymous.mutation(api.plugins.remove_repository, { repositoryId });
		expect(removed).toEqual({ _nay: { message: "Sign in to publish plugins" } });

		const published = await asAnonymous.action(api.plugins.publish_version, { repositoryId });
		expect(published).toEqual({ _nay: { message: "Sign in to publish plugins" } });

		const authorizedSignedIn = await t.query(internal.plugins.get_owned_publisher_repository, {
			userId: ownerUserId,
			repositoryId,
		});
		if (authorizedSignedIn._nay) {
			throw new Error(authorizedSignedIn._nay.message);
		}
		expect(authorizedSignedIn._yay).toMatchObject({ userId: ownerUserId, owner: "bonobo", repo: "media-plugin" });
	});
});

describe("plugins publisher secrets", () => {
	// plugins_manage is a token bucket with capacity 2; refill a token before each extra write.
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function refill_manage_rate_limit() {
		vi.advanceTimersByTime(60_000);
	}

	async function create_publisher_user(t: ReturnType<typeof test_convex>) {
		return await t.run((ctx) => ctx.db.insert("users", { clerkUserId: null }));
	}

	async function insert_claimed_repository(
		t: ReturnType<typeof test_convex>,
		args: { ownerUserId: Id<"users">; owner?: string; repo?: string },
	) {
		const owner = args.owner ?? "bonobo";
		const repo = args.repo ?? "media-plugin";
		return await t.run((ctx) =>
			ctx.db.insert("plugins_publisher_repositories", {
				ownerUserId: args.ownerUserId,
				repositoryUrl: `https://github.com/${owner}/${repo}`,
				owner,
				repo,
			}),
		);
	}

	async function get_publisher_repository_secret_doc(
		t: ReturnType<typeof test_convex>,
		repositoryId: Id<"plugins_publisher_repositories">,
		name: string,
	) {
		return await t.run(async (ctx) => {
			const secret = await ctx.db
				.query("plugins_publisher_repository_secrets")
				.withIndex("by_repository_name", (q) => q.eq("repositoryId", repositoryId).eq("name", name))
				.first();
			if (!secret) {
				throw new Error("Expected publisher secret doc");
			}
			return secret;
		});
	}

	test("stores publisher secrets encrypted and lists only redacted metadata", async () => {
		const t = test_convex();
		const ownerUserId = await create_publisher_user(t);
		const otherUserId = await create_publisher_user(t);
		const repositoryId = await insert_claimed_repository(t, { ownerUserId });
		const asOwner = t.withIdentity(user_identity(ownerUserId));

		const saved = await asOwner.mutation(api.plugins.upsert_publisher_repository_secret, {
			repositoryId,
			name: "OPENAI_API_KEY",
			value: "sk-publisher-secret",
			allowedOrigins: ["https://api.openai.com"],
		});
		if (saved._nay) {
			throw new Error(saved._nay.message);
		}

		const listed = await asOwner.query(api.plugins.list_publisher_repository_secrets, { repositoryId });
		expect(listed).toEqual([
			expect.objectContaining({
				name: "OPENAI_API_KEY",
				valuePreview: "configured",
				allowedOrigins: ["https://api.openai.com"],
				lastUsedAt: null,
			}),
		]);
		expect(JSON.stringify(listed)).not.toContain("sk-publisher-secret");

		const secret = await get_publisher_repository_secret_doc(t, repositoryId, "OPENAI_API_KEY");
		expect(new TextDecoder().decode(secret.ciphertext)).not.toContain("sk-publisher-secret");

		// Secrets are scoped to the claim owner; another user asking for this repository sees nothing.
		expect(
			await t
				.withIdentity(user_identity(otherUserId))
				.query(api.plugins.list_publisher_repository_secrets, { repositoryId }),
		).toEqual([]);
	});

	test("rejects secret mutations for repositories that are missing or claimed by another publisher", async () => {
		const t = test_convex();
		const ownerUserId = await create_publisher_user(t);
		const otherUserId = await create_publisher_user(t);
		const foreignRepositoryId = await insert_claimed_repository(t, { ownerUserId: otherUserId, owner: "gorilla" });
		const asOwner = t.withIdentity(user_identity(ownerUserId));

		expect(
			await asOwner.mutation(api.plugins.upsert_publisher_repository_secret, {
				repositoryId: foreignRepositoryId,
				name: "OPENAI_API_KEY",
				value: "sk-publisher-secret",
				allowedOrigins: [],
			}),
		).toEqual({ _nay: { message: "Unauthorized" } });
		expect(
			await asOwner.mutation(api.plugins.upsert_publisher_repository_secrets, {
				repositoryId: foreignRepositoryId,
				secrets: [{ name: "OPENAI_API_KEY", value: "sk-publisher-secret" }],
			}),
		).toEqual({ _nay: { message: "Unauthorized" } });
		refill_manage_rate_limit();
		expect(
			await asOwner.mutation(api.plugins.update_publisher_repository_secret_origins, {
				repositoryId: foreignRepositoryId,
				name: "OPENAI_API_KEY",
				allowedOrigins: [],
			}),
		).toEqual({ _nay: { message: "Unauthorized" } });
		expect(
			await asOwner.mutation(api.plugins.delete_publisher_repository_secret, {
				repositoryId: foreignRepositoryId,
				name: "OPENAI_API_KEY",
			}),
		).toEqual({ _nay: { message: "Unauthorized" } });
		expect(
			await asOwner.query(api.plugins.list_publisher_repository_secrets, { repositoryId: foreignRepositoryId }),
		).toEqual([]);

		const removedRepositoryId = await insert_claimed_repository(t, { ownerUserId });
		await t.run((ctx) => ctx.db.delete("plugins_publisher_repositories", removedRepositoryId));
		refill_manage_rate_limit();
		expect(
			await asOwner.mutation(api.plugins.upsert_publisher_repository_secret, {
				repositoryId: removedRepositoryId,
				name: "OPENAI_API_KEY",
				value: "sk-publisher-secret",
				allowedOrigins: [],
			}),
		).toEqual({ _nay: { message: "Not found" } });
		expect(
			await asOwner.query(api.plugins.list_publisher_repository_secrets, { repositoryId: removedRepositoryId }),
		).toEqual([]);
	});

	test("rejects publisher secret mutations from anonymous users", async () => {
		const t = test_convex();
		const ownerUserId = await create_publisher_user(t);
		const repositoryId = await insert_claimed_repository(t, { ownerUserId });
		const asAnonymous = t.withIdentity({
			issuer: process.env.VITE_CONVEX_HTTP_URL!,
			subject: ownerUserId,
			name: "Anonymous Publisher",
		});

		expect(
			await asAnonymous.mutation(api.plugins.upsert_publisher_repository_secret, {
				repositoryId,
				name: "OPENAI_API_KEY",
				value: "sk-publisher-secret",
				allowedOrigins: [],
			}),
		).toEqual({ _nay: { message: "Sign in to publish plugins" } });
		expect(
			await asAnonymous.mutation(api.plugins.upsert_publisher_repository_secrets, {
				repositoryId,
				secrets: [{ name: "OPENAI_API_KEY", value: "sk-publisher-secret" }],
			}),
		).toEqual({ _nay: { message: "Sign in to publish plugins" } });
		expect(
			await asAnonymous.mutation(api.plugins.update_publisher_repository_secret_origins, {
				repositoryId,
				name: "OPENAI_API_KEY",
				allowedOrigins: ["https://api.openai.com"],
			}),
		).toEqual({ _nay: { message: "Sign in to publish plugins" } });
		expect(
			await asAnonymous.mutation(api.plugins.delete_publisher_repository_secret, {
				repositoryId,
				name: "OPENAI_API_KEY",
			}),
		).toEqual({
			_nay: { message: "Sign in to publish plugins" },
		});

		const secrets = await t.run((ctx) =>
			ctx.db
				.query("plugins_publisher_repository_secrets")
				.withIndex("by_ownerUser", (q) => q.eq("ownerUserId", ownerUserId))
				.take(10),
		);
		expect(secrets).toEqual([]);
	});

	test(".env batch upsert preserves existing allowed origins and updates values", async () => {
		const t = test_convex();
		const ownerUserId = await create_publisher_user(t);
		const repositoryId = await insert_claimed_repository(t, { ownerUserId });
		const asOwner = t.withIdentity(user_identity(ownerUserId));

		const saved = await asOwner.mutation(api.plugins.upsert_publisher_repository_secret, {
			repositoryId,
			name: "OPENAI_API_KEY",
			value: "sk-old-secret",
			allowedOrigins: ["https://api.openai.com"],
		});
		if (saved._nay) {
			throw new Error(saved._nay.message);
		}

		const batch = await asOwner.mutation(api.plugins.upsert_publisher_repository_secrets, {
			repositoryId,
			secrets: [
				{ name: "OPENAI_API_KEY", value: "sk-new-secret" },
				{ name: "MODAL_TOKEN", value: "modal-secret" },
			],
		});
		if (batch._nay) {
			throw new Error(batch._nay.message);
		}
		expect(batch._yay.count).toBe(2);

		const listed = await asOwner.query(api.plugins.list_publisher_repository_secrets, { repositoryId });
		expect(listed.map((secret) => ({ name: secret.name, allowedOrigins: secret.allowedOrigins }))).toEqual([
			{ name: "MODAL_TOKEN", allowedOrigins: [] },
			{ name: "OPENAI_API_KEY", allowedOrigins: ["https://api.openai.com"] },
		]);

		const secret = await get_publisher_repository_secret_doc(t, repositoryId, "OPENAI_API_KEY");
		const decrypted = await t.action(internal.plugins.decrypt_secret_for_runtime, {
			resolved: { tier: "publisher", secret },
		});
		expect(decrypted).toEqual({ _yay: "sk-new-secret" });
	});

	test("binds publisher secret ciphertext to the owning user and name", async () => {
		const t = test_convex();
		const ownerUserId = await create_publisher_user(t);
		const otherUserId = await create_publisher_user(t);
		const repositoryId = await insert_claimed_repository(t, { ownerUserId });
		const asOwner = t.withIdentity(user_identity(ownerUserId));

		const saved = await asOwner.mutation(api.plugins.upsert_publisher_repository_secret, {
			repositoryId,
			name: "OPENAI_API_KEY",
			value: "sk-publisher-secret",
			allowedOrigins: [],
		});
		if (saved._nay) {
			throw new Error(saved._nay.message);
		}
		const secret = await get_publisher_repository_secret_doc(t, repositoryId, "OPENAI_API_KEY");

		const decrypted = await t.action(internal.plugins.decrypt_secret_for_runtime, {
			resolved: { tier: "publisher", secret },
		});
		expect(decrypted).toEqual({ _yay: "sk-publisher-secret" });

		const wrongName = await t.action(internal.plugins.decrypt_secret_for_runtime, {
			resolved: { tier: "publisher", secret: { ...secret, name: "MODAL_TOKEN" } },
		});
		expect(wrongName._nay).toBeDefined();

		const wrongOwner = await t.action(internal.plugins.decrypt_secret_for_runtime, {
			resolved: { tier: "publisher", secret: { ...secret, ownerUserId: otherUserId } },
		});
		expect(wrongOwner._nay).toBeDefined();
	});

	test("resolves installation secrets before publisher secrets", async () => {
		const t = test_convex();
		const membership = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const registered = await register_media_plugin(t, membership.userId);
		// The claim URL matches the registered version's sourceRepositoryUrl.
		const repositoryId = await insert_claimed_repository(t, { ownerUserId: membership.userId });
		const asOwner = t.withIdentity(user_identity(membership.userId));
		const installed = await asOwner.mutation(api.plugins.install_version, {
			membershipId: membership.membershipId,
			pluginVersionId: registered.pluginVersionId,
			...media_plugin_consent,
		});
		if (installed._nay) {
			throw new Error(installed._nay.message);
		}

		const savedInstallation = await asOwner.mutation(api.plugins.upsert_installation_secret, {
			membershipId: membership.membershipId,
			installationId: installed._yay.installationId,
			name: "OPENAI_API_KEY",
			value: "sk-installation-secret",
		});
		if (savedInstallation._nay) {
			throw new Error(savedInstallation._nay.message);
		}
		refill_manage_rate_limit();
		const savedPublisher = await asOwner.mutation(api.plugins.upsert_publisher_repository_secret, {
			repositoryId,
			name: "OPENAI_API_KEY",
			value: "sk-publisher-secret",
			allowedOrigins: [],
		});
		if (savedPublisher._nay) {
			throw new Error(savedPublisher._nay.message);
		}

		const resolved = await t.mutation(internal.plugins.get_secret_for_runtime, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			installationId: installed._yay.installationId,
			name: "OPENAI_API_KEY",
		});
		if (!resolved) {
			throw new Error("Expected secret doc");
		}
		expect(resolved.tier).toBe("installation");

		const decrypted = await t.action(internal.plugins.decrypt_secret_for_runtime, { resolved });
		expect(decrypted).toEqual({ _yay: "sk-installation-secret" });
	});

	test("falls through to publisher secrets and stamps lastUsedAt", async () => {
		const t = test_convex();
		const membership = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const registered = await register_media_plugin(t, membership.userId);
		// The claim URL matches the registered version's sourceRepositoryUrl.
		const repositoryId = await insert_claimed_repository(t, { ownerUserId: membership.userId });
		const asOwner = t.withIdentity(user_identity(membership.userId));
		const installed = await asOwner.mutation(api.plugins.install_version, {
			membershipId: membership.membershipId,
			pluginVersionId: registered.pluginVersionId,
			...media_plugin_consent,
		});
		if (installed._nay) {
			throw new Error(installed._nay.message);
		}
		const savedPublisher = await asOwner.mutation(api.plugins.upsert_publisher_repository_secret, {
			repositoryId,
			name: "OPENAI_API_KEY",
			value: "sk-publisher-secret",
			allowedOrigins: ["https://api.openai.com"],
		});
		if (savedPublisher._nay) {
			throw new Error(savedPublisher._nay.message);
		}

		const resolved = await t.mutation(internal.plugins.get_secret_for_runtime, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			installationId: installed._yay.installationId,
			name: "OPENAI_API_KEY",
		});
		if (!resolved) {
			throw new Error("Expected secret doc");
		}
		expect(resolved.tier).toBe("publisher");

		const decrypted = await t.action(internal.plugins.decrypt_secret_for_runtime, { resolved });
		expect(decrypted).toEqual({ _yay: "sk-publisher-secret" });

		const secret = await get_publisher_repository_secret_doc(t, repositoryId, "OPENAI_API_KEY");
		expect(typeof secret.lastUsedAt).toBe("number");
	});

	test("does not serve secrets from unrelated repositories", async () => {
		const t = test_convex();
		const membership = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const registered = await register_media_plugin(t, membership.userId);
		const asOwner = t.withIdentity(user_identity(membership.userId));
		const installed = await asOwner.mutation(api.plugins.install_version, {
			membershipId: membership.membershipId,
			pluginVersionId: registered.pluginVersionId,
			...media_plugin_consent,
		});
		if (installed._nay) {
			throw new Error(installed._nay.message);
		}

		// Another publisher's claim on a different repository holds the same secret name.
		const otherUserId = await create_publisher_user(t);
		const otherRepositoryId = await insert_claimed_repository(t, {
			ownerUserId: otherUserId,
			owner: "gorilla",
			repo: "other-plugin",
		});
		const savedOther = await t
			.withIdentity(user_identity(otherUserId))
			.mutation(api.plugins.upsert_publisher_repository_secret, {
				repositoryId: otherRepositoryId,
				name: "OPENAI_API_KEY",
				value: "sk-unrelated-secret",
				allowedOrigins: [],
			});
		if (savedOther._nay) {
			throw new Error(savedOther._nay.message);
		}

		const resolved = await t.mutation(internal.plugins.get_secret_for_runtime, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			installationId: installed._yay.installationId,
			name: "OPENAI_API_KEY",
		});
		expect(resolved).toBeNull();
	});

	test("updates and deletes publisher secrets for the owner", async () => {
		const t = test_convex();
		const ownerUserId = await create_publisher_user(t);
		const repositoryId = await insert_claimed_repository(t, { ownerUserId });
		const asOwner = t.withIdentity(user_identity(ownerUserId));

		const saved = await asOwner.mutation(api.plugins.upsert_publisher_repository_secret, {
			repositoryId,
			name: "OPENAI_API_KEY",
			value: "sk-publisher-secret",
			allowedOrigins: [],
		});
		if (saved._nay) {
			throw new Error(saved._nay.message);
		}

		const updated = await asOwner.mutation(api.plugins.update_publisher_repository_secret_origins, {
			repositoryId,
			name: "OPENAI_API_KEY",
			allowedOrigins: ["https://api.openai.com"],
		});
		expect(updated).toEqual({ _yay: null });
		const secret = await get_publisher_repository_secret_doc(t, repositoryId, "OPENAI_API_KEY");
		expect(secret.allowedOrigins).toEqual(["https://api.openai.com"]);

		refill_manage_rate_limit();
		const missingUpdate = await asOwner.mutation(api.plugins.update_publisher_repository_secret_origins, {
			repositoryId,
			name: "MODAL_TOKEN",
			allowedOrigins: [],
		});
		expect(missingUpdate).toEqual({ _nay: { message: "Not found" } });

		const deleted = await asOwner.mutation(api.plugins.delete_publisher_repository_secret, {
			repositoryId,
			name: "OPENAI_API_KEY",
		});
		expect(deleted).toEqual({ _yay: null });
		expect(await asOwner.query(api.plugins.list_publisher_repository_secrets, { repositoryId })).toEqual([]);
	});

	test("removing a repository claim deletes its secrets", async () => {
		const t = test_convex();
		const ownerUserId = await create_publisher_user(t);
		const repositoryId = await insert_claimed_repository(t, { ownerUserId });
		const otherRepositoryId = await insert_claimed_repository(t, { ownerUserId, repo: "other-plugin" });
		const asOwner = t.withIdentity(user_identity(ownerUserId));

		const saved = await asOwner.mutation(api.plugins.upsert_publisher_repository_secret, {
			repositoryId,
			name: "OPENAI_API_KEY",
			value: "sk-publisher-secret",
			allowedOrigins: [],
		});
		if (saved._nay) {
			throw new Error(saved._nay.message);
		}
		const savedOther = await asOwner.mutation(api.plugins.upsert_publisher_repository_secret, {
			repositoryId: otherRepositoryId,
			name: "MODAL_TOKEN",
			value: "modal-secret",
			allowedOrigins: [],
		});
		if (savedOther._nay) {
			throw new Error(savedOther._nay.message);
		}

		refill_manage_rate_limit();
		const removed = await asOwner.mutation(api.plugins.remove_repository, { repositoryId });
		expect(removed).toEqual({ _yay: null });

		const secrets = await t.run((ctx) =>
			ctx.db
				.query("plugins_publisher_repository_secrets")
				.withIndex("by_ownerUser", (q) => q.eq("ownerUserId", ownerUserId))
				.take(10),
		);
		expect(secrets.map((secret) => ({ name: secret.name, repositoryId: secret.repositoryId }))).toEqual([
			{ name: "MODAL_TOKEN", repositoryId: otherRepositoryId },
		]);
	});
});

describe("plugins outbound origins consent", () => {
	// plugins_manage is a token bucket with capacity 2; refill a token before each extra write.
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function refill_manage_rate_limit() {
		vi.advanceTimersByTime(60_000);
	}

	test("rejects installs whose consent does not exactly cover the declared surface", async () => {
		const t = test_convex();
		const membership = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const registered = await register_media_plugin(t, membership.userId, {
			outboundOrigins: ["https://api.openai.com"],
		});
		const asOwner = t.withIdentity(user_identity(membership.userId));

		const partialCapabilities = await asOwner.mutation(api.plugins.install_version, {
			membershipId: membership.membershipId,
			pluginVersionId: registered.pluginVersionId,
			acceptedCapabilities: ["plugin.secrets.read"],
			acceptedOutboundOrigins: ["https://api.openai.com"],
		});
		expect(partialCapabilities).toEqual({
			_nay: { message: "Install must accept exactly the capabilities the plugin declares" },
		});

		const missingOrigin = await asOwner.mutation(api.plugins.install_version, {
			membershipId: membership.membershipId,
			pluginVersionId: registered.pluginVersionId,
			...media_plugin_consent,
			acceptedOutboundOrigins: [],
		});
		expect(missingOrigin).toEqual({
			_nay: { message: "Install must accept exactly the outbound origins the plugin declares" },
		});

		refill_manage_rate_limit();
		const excessOrigin = await asOwner.mutation(api.plugins.install_version, {
			membershipId: membership.membershipId,
			pluginVersionId: registered.pluginVersionId,
			...media_plugin_consent,
			acceptedOutboundOrigins: ["https://api.openai.com", "https://example.com"],
		});
		expect(excessOrigin).toEqual({
			_nay: { message: "Install must accept exactly the outbound origins the plugin declares" },
		});

		const installed = await asOwner.mutation(api.plugins.install_version, {
			membershipId: membership.membershipId,
			pluginVersionId: registered.pluginVersionId,
			...media_plugin_consent,
			acceptedOutboundOrigins: ["https://api.openai.com"],
		});
		if (installed._nay) {
			throw new Error(installed._nay.message);
		}
		const installation = await t.run((ctx) =>
			ctx.db.get("plugins_workspace_installations", installed._yay.installationId),
		);
		expect(installation?.acceptedOutboundOrigins).toEqual(["https://api.openai.com"]);
		expect(typeof installation?.outboundOriginsAcceptedAt).toBe("number");
	});

	test("requires fresh consent only when an upgrade adds outbound origins", async () => {
		const t = test_convex();
		const membership = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const first = await register_media_plugin(t, membership.userId);
		const asOwner = t.withIdentity(user_identity(membership.userId));
		const installed = await asOwner.mutation(api.plugins.install_version, {
			membershipId: membership.membershipId,
			pluginVersionId: first.pluginVersionId,
			...media_plugin_consent,
		});
		if (installed._nay) {
			throw new Error(installed._nay.message);
		}

		const upgraded = await register_media_plugin(t, membership.userId, {
			version: "0.2.0",
			outboundOrigins: ["https://api.openai.com"],
		});
		const staleConsent = await asOwner.mutation(api.plugins.install_version, {
			membershipId: membership.membershipId,
			pluginVersionId: upgraded.pluginVersionId,
			...media_plugin_consent,
		});
		expect(staleConsent).toEqual({
			_nay: { message: "Install must accept exactly the outbound origins the plugin declares" },
		});

		refill_manage_rate_limit();
		const freshConsent = await asOwner.mutation(api.plugins.install_version, {
			membershipId: membership.membershipId,
			pluginVersionId: upgraded.pluginVersionId,
			...media_plugin_consent,
			acceptedOutboundOrigins: ["https://api.openai.com"],
		});
		if (freshConsent._nay) {
			throw new Error(freshConsent._nay.message);
		}
		expect(freshConsent._yay.installationId).toBe(installed._yay.installationId);

		refill_manage_rate_limit();
		const unchanged = await register_media_plugin(t, membership.userId, {
			version: "0.3.0",
			outboundOrigins: ["https://api.openai.com"],
		});
		const sameConsent = await asOwner.mutation(api.plugins.install_version, {
			membershipId: membership.membershipId,
			pluginVersionId: unchanged.pluginVersionId,
			...media_plugin_consent,
			acceptedOutboundOrigins: ["https://api.openai.com"],
		});
		if (sameConsent._nay) {
			throw new Error(sameConsent._nay.message);
		}
		const installation = await t.run((ctx) =>
			ctx.db.get("plugins_workspace_installations", installed._yay.installationId),
		);
		expect(installation?.pluginVersionId).toBe(unchanged.pluginVersionId);
		expect(installation?.acceptedOutboundOrigins).toEqual(["https://api.openai.com"]);
	});

	test("sends the runner exactly the consented origins plus the source repository's secret origins", async () => {
		const t = test_convex();
		const membership = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const registered = await register_media_plugin(t, membership.userId, {
			outboundOrigins: ["https://api.openai.com"],
		});
		// Claims by the same owner: one on the version's source repository, one on an unrelated repository.
		const [repositoryId, unrelatedRepositoryId] = await t.run(async (ctx) => {
			return [
				await ctx.db.insert("plugins_publisher_repositories", {
					ownerUserId: membership.userId,
					repositoryUrl: "https://github.com/bonobo/media-plugin",
					owner: "bonobo",
					repo: "media-plugin",
				}),
				await ctx.db.insert("plugins_publisher_repositories", {
					ownerUserId: membership.userId,
					repositoryUrl: "https://github.com/bonobo/other-plugin",
					owner: "bonobo",
					repo: "other-plugin",
				}),
			];
		});
		const asOwner = t.withIdentity(user_identity(membership.userId));
		const installed = await asOwner.mutation(api.plugins.install_version, {
			membershipId: membership.membershipId,
			pluginVersionId: registered.pluginVersionId,
			...media_plugin_consent,
			acceptedOutboundOrigins: ["https://api.openai.com"],
		});
		if (installed._nay) {
			throw new Error(installed._nay.message);
		}
		// Overlapping publisher origin proves the payload allowlist is deduplicated.
		const savedPublisher = await asOwner.mutation(api.plugins.upsert_publisher_repository_secret, {
			repositoryId,
			name: "TRANSFORMER_SECRET",
			value: "sk-transformer-secret",
			allowedOrigins: ["https://api.openai.com", "https://transformer.example.com"],
		});
		if (savedPublisher._nay) {
			throw new Error(savedPublisher._nay.message);
		}
		refill_manage_rate_limit();
		// The same owner's secrets on other repositories must contribute no origins.
		const savedUnrelated = await asOwner.mutation(api.plugins.upsert_publisher_repository_secret, {
			repositoryId: unrelatedRepositoryId,
			name: "UNRELATED_SECRET",
			value: "sk-unrelated-secret",
			allowedOrigins: ["https://unrelated.example.com"],
		});
		if (savedUnrelated._nay) {
			throw new Error(savedUnrelated._nay.message);
		}
		refill_manage_rate_limit();
		// Installation secrets must contribute no origins to the allowlist.
		const savedInstallation = await asOwner.mutation(api.plugins.upsert_installation_secret, {
			membershipId: membership.membershipId,
			installationId: installed._yay.installationId,
			name: "OPENAI_API_KEY",
			value: "sk-installation-secret",
		});
		if (savedInstallation._nay) {
			throw new Error(savedInstallation._nay.message);
		}
		const upload = await asOwner.mutation(api.files_nodes.create_upload_node, {
			membershipId: membership.membershipId,
			parentId: "root",
			filename: "allowlist.png",
			contentType: "image/png",
			size: 1024,
		});
		if (upload._nay) {
			throw new Error(upload._nay.message);
		}
		await t.run((ctx) => ctx.db.patch("files_r2_assets", upload._yay.assetId, { r2Key: "uploads/allowlist.png" }));
		const runId = await t.run(async (ctx) => {
			const installation = await ctx.db.get("plugins_workspace_installations", installed._yay.installationId);
			if (!installation) {
				throw new Error("Expected installation");
			}
			return await ctx.db.insert("plugins_event_runs", {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				sourceAssetId: upload._yay.assetId,
				sourceFileNodeId: upload._yay.nodeId,
				actorUserId: membership.userId,
				installationId: installed._yay.installationId,
				pluginVersionId: installation.pluginVersionId,
				event: "files.upload.completed",
				eventId: "plugin:allowlist-test",
				status: "queued",
				acceptedCapabilities: installation.acceptedCapabilities,
				expiresAt: Date.now() + 30 * 60 * 1000,
				hostCallCount: 0,
				hostWriteCount: 0,
				errorMessage: null,
				updatedAt: Date.now(),
			});
		});
		vi.mocked(fetch).mockResolvedValue(
			new Response(
				JSON.stringify({
					status: "succeeded",
					pluginStatus: 500,
					elapsedMs: 12,
					outputBytes: 0,
					outputTruncated: false,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);

		await t.action(internal.plugins_runtime.execute_upload_completed_event_run, { runId });

		const runnerCall = vi
			.mocked(fetch)
			.mock.calls.find(([url]) => String(url).startsWith(process.env.PLUGIN_RUNNER_URL ?? ""));
		if (!runnerCall) {
			throw new Error("Expected a runner fetch call");
		}
		const body = JSON.parse(String(runnerCall[1]?.body)) as { outboundOrigins: string[] };
		expect(body.outboundOrigins.toSorted()).toEqual(["https://api.openai.com", "https://transformer.example.com"]);
	});
});

describe("plugins publish_version", () => {
	async function insert_claimed_repository(
		t: ReturnType<typeof test_convex>,
		args: { ownerUserId: Id<"users">; owner?: string; repo?: string },
	) {
		const owner = args.owner ?? "bonobo";
		const repo = args.repo ?? "media-plugin";
		return await t.run((ctx) =>
			ctx.db.insert("plugins_publisher_repositories", {
				ownerUserId: args.ownerUserId,
				repositoryUrl: `https://github.com/${owner}/${repo}`,
				owner,
				repo,
			}),
		);
	}

	async function insert_plugin_version_doc(
		t: ReturnType<typeof test_convex>,
		args: {
			name: string;
			createdBy: Id<"users">;
			version?: string;
			reviewStatus?: "pending" | "passed" | "rejected" | "flagged";
		},
	) {
		return await t.run(async (ctx) => {
			// Mirror upsert_plugin: the isLatest marker moves to the newest-created doc per name.
			const previousLatest = await ctx.db
				.query("plugins_versions")
				.withIndex("by_isLatest_name", (q) => q.eq("isLatest", true).eq("name", args.name))
				.first();
			if (previousLatest) {
				await ctx.db.patch("plugins_versions", previousLatest._id, { isLatest: false });
			}

			return await ctx.db.insert("plugins_versions", {
				name: args.name,
				displayName: args.name,
				version: args.version ?? "0.1.0",
				description: `${args.name} plugin`,
				reviewStatus: args.reviewStatus ?? "pending",
				isLatest: true,
				runtimeVersion: "1",
				artifactHash: `sha256:${"c".repeat(64)}`,
				sourceRepositoryUrl: `https://github.com/bonobo/${args.name}-plugin`,
				sourceOwner: "bonobo",
				sourceRepo: `${args.name}-plugin`,
				sourceDefaultBranch: "main",
				sourceCommitSha: "1234567890abcdef1234567890abcdef12345678",
				manifestR2Key: `plugins/${args.name}/manifest.json`,
				backend: null,
				events: [{ type: "files.upload.completed", contentTypes: ["image/png"] }],
				pages: [],
				capabilities: ["plugin.secrets.read"],
				outboundOrigins: [],
				files: [],
				sourceMountName: null,
				createdBy: args.createdBy,
				updatedAt: Date.now(),
			});
		});
	}

	function mock_ai_review(result?: { verdict: "passed" | "rejected" | "flagged"; findings: string[] }) {
		return vi
			.spyOn(plugins_ai_review, "generate_verdict")
			.mockResolvedValue(result ?? { verdict: "passed", findings: [] });
	}

	function mock_ai_review_votes(votes: Array<{ verdict: "passed" | "rejected" | "flagged"; findings: string[] }>) {
		const spy = vi.spyOn(plugins_ai_review, "generate_verdict");
		for (const vote of votes) {
			spy.mockResolvedValueOnce(vote);
		}
		return spy;
	}

	/** Reviews a never-seen artifact hash, which consumes fresh AI review budget when allowed. */
	async function request_fresh_review(
		t: ReturnType<typeof test_convex>,
		args: { requestedBy: Id<"users">; repositoryId: Id<"plugins_publisher_repositories">; hashChar: string },
	) {
		return await t.action(internal.plugins.run_version_review, {
			pluginName: "media-drain",
			version: "0.1.0",
			artifactHash: `sha256:${args.hashChar.repeat(64)}`,
			distSource: "export default { fetch: () => new Response('published') };",
			capabilities: ["plugin.secrets.read"],
			outboundOrigins: [],
			repositoryId: args.repositoryId,
			requestedBy: args.requestedBy,
		});
	}

	async function mock_publish_github_fetch(
		args: { manifestPublisher?: string; artifactBytesDelta?: number; workerSource?: string } = {},
	) {
		const commitSha = "fedcba9876543210fedcba9876543210fedcba98";
		const workerSource = args.workerSource ?? "export default { fetch: () => new Response('published') };";
		const manifestText = JSON.stringify({
			schemaVersion: 1,
			name: "media",
			displayName: "Media",
			version: "0.2.0",
			description: "Published media plugin",
			...(args.manifestPublisher ? { publisher: args.manifestPublisher } : {}),
			compatibility: { bonoboPluginRuntime: "1" },
			backend: {
				entry: "dist/backend/worker.js",
				moduleName: "plugin.js",
				compatibilityDate: "2026-07-01",
				compatibilityFlags: ["nodejs_compat"],
			},
			events: [{ type: "files.upload.completed", contentTypes: ["image/png"] }],
			pages: [],
			capabilities: ["plugin.secrets.read", "outbound.fetch"],
			outboundOrigins: [],
			files: [
				{
					path: "dist/backend/worker.js",
					sha256: await sha256_text(workerSource),
					bytes: workerSource.length + (args.artifactBytesDelta ?? 0),
					contentType: "application/javascript",
				},
			],
		});
		const uploadUrls: string[] = [];
		const githubAuthorizations: Array<string | null> = [];

		vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url === "https://r2.test/upload") {
				expect(init?.method).toBe("PUT");
				uploadUrls.push(url);
				return new Response(null, { status: 200 });
			}
			if (url.startsWith("https://api.github.com/") || url.startsWith("https://raw.githubusercontent.com/")) {
				githubAuthorizations.push(new Headers(init?.headers).get("Authorization"));
			}
			if (url === "https://api.github.com/repos/bonobo/media-plugin") {
				return new Response(JSON.stringify({ default_branch: "main" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url === "https://api.github.com/repos/bonobo/media-plugin/commits/main") {
				return new Response(JSON.stringify({ sha: commitSha }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url === `https://raw.githubusercontent.com/bonobo/media-plugin/${commitSha}/dist/bonobo.plugin.json`) {
				return new Response(manifestText, { status: 200 });
			}
			if (url === `https://raw.githubusercontent.com/bonobo/media-plugin/${commitSha}/dist/backend/worker.js`) {
				return new Response(workerSource, { status: 200 });
			}
			return new Response(null, { status: 404 });
		});

		return { commitSha, manifestText, workerSource, uploadUrls, githubAuthorizations };
	}

	test("publishes a bundled plugin from GitHub, writes R2 artifacts, and registers with the review verdict", async () => {
		const t = test_convex();
		const membership = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const repositoryId = await insert_claimed_repository(t, { ownerUserId: membership.userId });
		const asOwner = t.withIdentity(user_identity(membership.userId));
		const github = await mock_publish_github_fetch();
		const aiReview = mock_ai_review();

		const published = await asOwner.action(api.plugins.publish_version, { repositoryId });
		if (published._nay) {
			throw new Error(published._nay.message);
		}
		expect(published._yay.sourceCommitSha).toBe(github.commitSha);

		const version = await t.run((ctx) => ctx.db.get("plugins_versions", published._yay.pluginVersionId));
		expect(version).toMatchObject({
			name: "media",
			version: "0.2.0",
			createdBy: membership.userId,
			reviewStatus: "passed",
			artifactHash: await sha256_text(github.manifestText),
			manifestR2Key: `plugins/media/0.2.0/${github.commitSha}/dist/bonobo.plugin.json`,
		});
		expect(aiReview).toHaveBeenCalledTimes(1);
		const reviews = await t.run((ctx) => ctx.db.query("plugins_version_reviews").collect());
		expect(reviews).toMatchObject([
			{
				createdBy: membership.userId,
				artifactHash: await sha256_text(github.manifestText),
				pluginName: "media",
				version: "0.2.0",
				status: "passed",
				mechanicalFindings: [],
				aiFindings: [],
				model: "gpt-5.4-mini",
			},
		]);
		expect(version?.backend?.r2Key).toBe(`plugins/media/0.2.0/${github.commitSha}/dist/backend/worker.js`);
		expect(new Set(github.githubAuthorizations)).toEqual(new Set(["Bearer PLUGIN_IMPORT_GITHUB_TOKEN_TEST"]));

		const installations = await t.run((ctx) => ctx.db.query("plugins_workspace_installations").collect());
		expect(installations).toEqual([]);

		const mountedWorker = await t.query(internal.files_nodes.read_file_content_from_chunks, {
			organizationId: organizations_GLOBAL_ORGANIZATION_ID,
			workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
			userId: membership.userId,
			path: `/${published._yay.sourceMountName}/dist/backend/worker.js`,
			mode: { kind: "full", maxBytes: 100_000 },
		});
		expect(mountedWorker?.content).toBe(github.workerSource);
		const mountedManifest = await t.query(internal.files_nodes.read_file_content_from_chunks, {
			organizationId: organizations_GLOBAL_ORGANIZATION_ID,
			workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
			userId: membership.userId,
			path: `/${published._yay.sourceMountName}/dist/bonobo.plugin.json`,
			mode: { kind: "full", maxBytes: 100_000 },
		});
		expect(mountedManifest?.content).toBe(github.manifestText);
	});

	test("rejects publish before R2 upload when an artifact file byte size does not match", async () => {
		const t = test_convex();
		const membership = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const repositoryId = await insert_claimed_repository(t, { ownerUserId: membership.userId });
		const asOwner = t.withIdentity(user_identity(membership.userId));
		const github = await mock_publish_github_fetch({ artifactBytesDelta: 1 });

		const published = await asOwner.action(api.plugins.publish_version, { repositoryId });

		expect(published).toEqual({ _nay: { message: 'Artifact file byte size mismatch for "dist/backend/worker.js"' } });
		expect(github.uploadUrls).toEqual([]);
	});

	test("rejects manifests that still declare the removed publisher field", async () => {
		const t = test_convex();
		const membership = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const repositoryId = await insert_claimed_repository(t, { ownerUserId: membership.userId });
		const asOwner = t.withIdentity(user_identity(membership.userId));
		const github = await mock_publish_github_fetch({ manifestPublisher: "gorilla" });

		const published = await asOwner.action(api.plugins.publish_version, { repositoryId });

		expect(published._nay?.message).toContain("publisher");
		expect(github.uploadUrls).toEqual([]);
		const versions = await t.run((ctx) => ctx.db.query("plugins_versions").collect());
		expect(versions).toEqual([]);
	});

	test("rejects publishing a plugin name owned by another publisher", async () => {
		const t = test_convex();
		const membership = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const otherUserId = await t.run((ctx) => ctx.db.insert("users", { clerkUserId: null }));
		const existingVersionId = await insert_plugin_version_doc(t, {
			name: "media",
			createdBy: otherUserId,
		});
		const repositoryId = await insert_claimed_repository(t, { ownerUserId: membership.userId });
		const asOwner = t.withIdentity(user_identity(membership.userId));
		await mock_publish_github_fetch();
		mock_ai_review();

		const published = await asOwner.action(api.plugins.publish_version, { repositoryId });

		expect(published).toEqual({ _nay: { message: "Plugin name is already owned by another publisher" } });
		const versions = await t.run((ctx) =>
			ctx.db
				.query("plugins_versions")
				.withIndex("by_name", (q) => q.eq("name", "media"))
				.collect(),
		);
		expect(versions).toHaveLength(1);
		expect(versions[0]?._id).toBe(existingVersionId);
	});

	test("republishes the same commit idempotently and reuses the cached verdict without calling the model", async () => {
		const t = test_convex();
		const membership = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const repositoryId = await insert_claimed_repository(t, { ownerUserId: membership.userId });
		const asOwner = t.withIdentity(user_identity(membership.userId));
		await mock_publish_github_fetch();
		const aiReview = mock_ai_review();

		const first = await asOwner.action(api.plugins.publish_version, { repositoryId });
		if (first._nay) {
			throw new Error(first._nay.message);
		}

		const second = await asOwner.action(api.plugins.publish_version, { repositoryId });
		if (second._nay) {
			throw new Error(second._nay.message);
		}
		expect(second._yay.pluginVersionId).toBe(first._yay.pluginVersionId);
		expect(aiReview).toHaveBeenCalledTimes(1);

		const version = await t.run((ctx) => ctx.db.get("plugins_versions", first._yay.pluginVersionId));
		expect(version).toMatchObject({ createdBy: membership.userId, reviewStatus: "passed" });
		const reviews = await t.run((ctx) => ctx.db.query("plugins_version_reviews").collect());
		expect(reviews).toHaveLength(1);
	});

	test("mechanically rejects a minified dist before any upload and stores the rejection", async () => {
		const t = test_convex();
		const membership = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const repositoryId = await insert_claimed_repository(t, { ownerUserId: membership.userId });
		const asOwner = t.withIdentity(user_identity(membership.userId));
		const minifiedWorker = `export default{fetch:()=>new Response(${JSON.stringify("x".repeat(1200))})};`;
		const github = await mock_publish_github_fetch({ workerSource: minifiedWorker });
		const aiReview = mock_ai_review();

		const published = await asOwner.action(api.plugins.publish_version, { repositoryId });

		expect(published._nay?.message).toContain("Plugin review rejected this version");
		expect(published._nay?.message).toContain("Longest line");
		expect(aiReview).not.toHaveBeenCalled();
		expect(github.uploadUrls).toEqual([]);
		const versions = await t.run((ctx) => ctx.db.query("plugins_versions").collect());
		expect(versions).toEqual([]);
		const reviews = await t.run((ctx) => ctx.db.query("plugins_version_reviews").collect());
		expect(reviews).toMatchObject([
			{ createdBy: membership.userId, pluginName: "media", status: "rejected", aiFindings: [], model: "none" },
		]);
		expect(reviews[0]?.mechanicalFindings.join(" ")).toContain("Longest line");
	});

	test("flagged verdicts register the version but block installs", async () => {
		const t = test_convex();
		const membership = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const repositoryId = await insert_claimed_repository(t, { ownerUserId: membership.userId });
		const asOwner = t.withIdentity(user_identity(membership.userId));
		await mock_publish_github_fetch();
		mock_ai_review({ verdict: "flagged", findings: ["Module-level mutable state outlives a run"] });

		const published = await asOwner.action(api.plugins.publish_version, { repositoryId });
		if (published._nay) {
			throw new Error(published._nay.message);
		}

		const version = await t.run((ctx) => ctx.db.get("plugins_versions", published._yay.pluginVersionId));
		expect(version).toMatchObject({ reviewStatus: "flagged" });
		const reviews = await t.run((ctx) => ctx.db.query("plugins_version_reviews").collect());
		expect(reviews).toMatchObject([{ status: "flagged", aiFindings: ["Module-level mutable state outlives a run"] }]);

		const installed = await asOwner.mutation(api.plugins.install_version, {
			membershipId: membership.membershipId,
			pluginVersionId: published._yay.pluginVersionId,
			acceptedCapabilities: ["plugin.secrets.read", "outbound.fetch"],
			acceptedOutboundOrigins: [],
		});
		expect(installed).toEqual({ _nay: { message: "Plugin version failed review and cannot be installed" } });
	});

	test("rejects the version when the review verdict is rejected", async () => {
		const t = test_convex();
		const membership = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const repositoryId = await insert_claimed_repository(t, { ownerUserId: membership.userId });
		const asOwner = t.withIdentity(user_identity(membership.userId));
		await mock_publish_github_fetch();
		const aiReview = mock_ai_review({
			verdict: "rejected",
			findings: ["Sends secret values to attacker.example", "Obfuscated eval chain"],
		});

		const published = await asOwner.action(api.plugins.publish_version, { repositoryId });

		expect(published._nay?.message).toBe(
			"Plugin review rejected this version: Sends secret values to attacker.example | Obfuscated eval chain",
		);
		expect(aiReview).toHaveBeenCalledTimes(1);
		const versions = await t.run((ctx) => ctx.db.query("plugins_versions").collect());
		expect(versions).toEqual([]);
		const reviews = await t.run((ctx) => ctx.db.query("plugins_version_reviews").collect());
		expect(reviews).toMatchObject([
			{
				status: "rejected",
				aiFindings: ["Sends secret values to attacker.example", "Obfuscated eval chain"],
			},
		]);
	});

	test("registers as flagged when the review verdict is flagged", async () => {
		const t = test_convex();
		const membership = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const repositoryId = await insert_claimed_repository(t, { ownerUserId: membership.userId });
		const asOwner = t.withIdentity(user_identity(membership.userId));
		await mock_publish_github_fetch();
		const aiReview = mock_ai_review({ verdict: "flagged", findings: ["Module-level mutable state outlives a run"] });

		const published = await asOwner.action(api.plugins.publish_version, { repositoryId });
		if (published._nay) {
			throw new Error(published._nay.message);
		}

		expect(aiReview).toHaveBeenCalledTimes(1);
		const version = await t.run((ctx) => ctx.db.get("plugins_versions", published._yay.pluginVersionId));
		expect(version).toMatchObject({ reviewStatus: "flagged" });
		const reviews = await t.run((ctx) => ctx.db.query("plugins_version_reviews").collect());
		expect(reviews).toMatchObject([
			{
				status: "flagged",
				aiFindings: ["Module-level mutable state outlives a run"],
			},
		]);
	});

	test("a cached rejected review does not block a republish and the fresh verdict replaces it", async () => {
		const t = test_convex();
		const membership = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const repositoryId = await insert_claimed_repository(t, { ownerUserId: membership.userId });
		const asOwner = t.withIdentity(user_identity(membership.userId));
		await mock_publish_github_fetch();
		const aiReview = mock_ai_review_votes([
			{ verdict: "rejected", findings: ["Sends secret values to attacker.example"] },
			{ verdict: "passed", findings: [] },
		]);

		const first = await asOwner.action(api.plugins.publish_version, { repositoryId });
		expect(first._nay?.message).toContain("Plugin review rejected this version");
		expect(aiReview).toHaveBeenCalledTimes(1);

		const second = await asOwner.action(api.plugins.publish_version, { repositoryId });
		if (second._nay) {
			throw new Error(second._nay.message);
		}
		expect(aiReview).toHaveBeenCalledTimes(2);

		const version = await t.run((ctx) => ctx.db.get("plugins_versions", second._yay.pluginVersionId));
		expect(version).toMatchObject({ reviewStatus: "passed" });
		// One upserted row per artifact hash: the fresh passed verdict replaced the rejected one.
		const reviews = await t.run((ctx) => ctx.db.query("plugins_version_reviews").collect());
		expect(reviews).toMatchObject([{ status: "passed", aiFindings: [] }]);
	});

	test("records a succeeded publish attempt with the published commit on the claim", async () => {
		const t = test_convex();
		const membership = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const repositoryId = await insert_claimed_repository(t, { ownerUserId: membership.userId });
		const asOwner = t.withIdentity(user_identity(membership.userId));
		const github = await mock_publish_github_fetch();
		mock_ai_review();

		const published = await asOwner.action(api.plugins.publish_version, { repositoryId });
		if (published._nay) {
			throw new Error(published._nay.message);
		}

		const repository = await t.run((ctx) => ctx.db.get("plugins_publisher_repositories", repositoryId));
		expect(repository?.lastPublishAttempt).toMatchObject({
			status: "succeeded",
			message: `Published commit ${github.commitSha.slice(0, 8)}`,
			commitSha: github.commitSha,
		});
	});

	test("records failed and rejected publish attempts with the user-facing message", async () => {
		const t = test_convex();
		const membership = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const repositoryId = await insert_claimed_repository(t, { ownerUserId: membership.userId });
		const asOwner = t.withIdentity(user_identity(membership.userId));
		await mock_publish_github_fetch({ artifactBytesDelta: 1 });

		const failed = await asOwner.action(api.plugins.publish_version, { repositoryId });
		expect(failed._nay?.message).toBe('Artifact file byte size mismatch for "dist/backend/worker.js"');
		const afterFailed = await t.run((ctx) => ctx.db.get("plugins_publisher_repositories", repositoryId));
		expect(afterFailed?.lastPublishAttempt).toMatchObject({
			status: "failed",
			message: 'Artifact file byte size mismatch for "dist/backend/worker.js"',
			commitSha: null,
		});

		const minifiedWorker = `export default{fetch:()=>new Response(${JSON.stringify("x".repeat(1200))})};`;
		await mock_publish_github_fetch({ workerSource: minifiedWorker });
		const rejected = await asOwner.action(api.plugins.publish_version, { repositoryId });
		expect(rejected._nay?.message).toContain("Plugin review rejected this version");
		const afterRejected = await t.run((ctx) => ctx.db.get("plugins_publisher_repositories", repositoryId));
		expect(afterRejected?.lastPublishAttempt).toMatchObject({ status: "rejected", commitSha: null });
		expect(afterRejected?.lastPublishAttempt?.message).toContain("Longest line");
	});

	test("an AI review failure blocks the publish with a typed error instead of passing silently", async () => {
		const t = test_convex();
		const membership = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const repositoryId = await insert_claimed_repository(t, { ownerUserId: membership.userId });
		const asOwner = t.withIdentity(user_identity(membership.userId));
		const github = await mock_publish_github_fetch();
		vi.spyOn(plugins_ai_review, "generate_verdict").mockRejectedValue(new Error("model unreachable"));

		const published = await asOwner.action(api.plugins.publish_version, { repositoryId });

		expect(published).toEqual({
			_nay: { message: "Plugin AI review is unavailable; the version was not registered" },
		});
		expect(github.uploadUrls).toEqual([]);
		const versions = await t.run((ctx) => ctx.db.query("plugins_versions").collect());
		expect(versions).toEqual([]);
		const reviews = await t.run((ctx) => ctx.db.query("plugins_version_reviews").collect());
		expect(reviews).toEqual([]);
	});

	test("rate limits fresh AI reviews per publishing user without calling the model once exhausted", async () => {
		const t = test_convex();
		const membership = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const repositoryId = await insert_claimed_repository(t, { ownerUserId: membership.userId });
		const aiReview = mock_ai_review();

		for (const hashChar of ["0", "1", "2", "3", "4"]) {
			const review = await request_fresh_review(t, { requestedBy: membership.userId, repositoryId, hashChar });
			if (review._nay) {
				throw new Error(review._nay.message);
			}
			expect(review._yay.status).toBe("passed");
		}
		expect(aiReview).toHaveBeenCalledTimes(5);

		const exceeded = await request_fresh_review(t, { requestedBy: membership.userId, repositoryId, hashChar: "5" });

		expect(exceeded._nay?.message).toMatch(/^Plugin AI review rate limit exceeded; try again in \d+s$/);
		expect(aiReview).toHaveBeenCalledTimes(5);
		const reviews = await t.run((ctx) => ctx.db.query("plugins_version_reviews").collect());
		expect(reviews).toHaveLength(5);
	});

	test("blocks a publish that needs a fresh AI review once the review budget is exhausted", async () => {
		const t = test_convex();
		const membership = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const repositoryId = await insert_claimed_repository(t, { ownerUserId: membership.userId });
		const asOwner = t.withIdentity(user_identity(membership.userId));
		const github = await mock_publish_github_fetch();
		const aiReview = mock_ai_review();
		for (const hashChar of ["0", "1", "2", "3", "4"]) {
			const review = await request_fresh_review(t, { requestedBy: membership.userId, repositoryId, hashChar });
			if (review._nay) {
				throw new Error(review._nay.message);
			}
		}

		const published = await asOwner.action(api.plugins.publish_version, { repositoryId });

		expect(published._nay?.message).toMatch(/^Plugin AI review rate limit exceeded; try again in \d+s$/);
		expect(aiReview).toHaveBeenCalledTimes(5);
		expect(github.uploadUrls).toEqual([]);
		const versions = await t.run((ctx) => ctx.db.query("plugins_versions").collect());
		expect(versions).toEqual([]);
	});

	test("republishes a cached artifact even when the fresh AI review budget is exhausted", async () => {
		const t = test_convex();
		const membership = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const repositoryId = await insert_claimed_repository(t, { ownerUserId: membership.userId });
		const asOwner = t.withIdentity(user_identity(membership.userId));
		await mock_publish_github_fetch();
		const aiReview = mock_ai_review();

		const first = await asOwner.action(api.plugins.publish_version, { repositoryId });
		if (first._nay) {
			throw new Error(first._nay.message);
		}
		expect(aiReview).toHaveBeenCalledTimes(1);

		// The first publish consumed one token; drain the rest, then confirm the budget is empty.
		for (const hashChar of ["1", "2", "3", "4"]) {
			const review = await request_fresh_review(t, { requestedBy: membership.userId, repositoryId, hashChar });
			if (review._nay) {
				throw new Error(review._nay.message);
			}
		}
		const drained = await request_fresh_review(t, { requestedBy: membership.userId, repositoryId, hashChar: "5" });
		expect(drained._nay?.message).toContain("Plugin AI review rate limit exceeded");

		const second = await asOwner.action(api.plugins.publish_version, { repositoryId });
		if (second._nay) {
			throw new Error(second._nay.message);
		}
		expect(second._yay.pluginVersionId).toBe(first._yay.pluginVersionId);
		expect(aiReview).toHaveBeenCalledTimes(5);
	});

	test("rejects installs of plugin versions that failed review", async () => {
		const t = test_convex();
		const membership = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const rejectedVersionId = await insert_plugin_version_doc(t, {
			name: "rejected-media",
			createdBy: membership.userId,
			reviewStatus: "rejected",
		});
		const flaggedVersionId = await insert_plugin_version_doc(t, {
			name: "flagged-media",
			createdBy: membership.userId,
			reviewStatus: "flagged",
		});
		const asOwner = t.withIdentity(user_identity(membership.userId));

		for (const pluginVersionId of [rejectedVersionId, flaggedVersionId]) {
			const installed = await asOwner.mutation(api.plugins.install_version, {
				membershipId: membership.membershipId,
				pluginVersionId,
				...media_plugin_consent,
			});
			expect(installed).toEqual({ _nay: { message: "Plugin version failed review and cannot be installed" } });
		}

		const installations = await t.run((ctx) => ctx.db.query("plugins_workspace_installations").collect());
		expect(installations).toEqual([]);
	});

	test("rejects publishes for repositories that are missing or claimed by another publisher", async () => {
		const t = test_convex();
		const membership = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const otherUserId = await t.run((ctx) => ctx.db.insert("users", { clerkUserId: null }));
		const foreignRepositoryId = await insert_claimed_repository(t, {
			ownerUserId: otherUserId,
			owner: "gorilla",
			repo: "media-plugin",
		});
		const asOwner = t.withIdentity(user_identity(membership.userId));

		const foreign = await asOwner.action(api.plugins.publish_version, {
			repositoryId: foreignRepositoryId,
		});
		expect(foreign).toEqual({ _nay: { message: "Unauthorized" } });
		// Pre-authorization failures never touch the claim's publish feedback.
		const foreignRepository = await t.run((ctx) => ctx.db.get("plugins_publisher_repositories", foreignRepositoryId));
		expect(foreignRepository?.lastPublishAttempt).toBeUndefined();

		const removedRepositoryId = await insert_claimed_repository(t, { ownerUserId: membership.userId });
		await t.run((ctx) => ctx.db.delete("plugins_publisher_repositories", removedRepositoryId));
		const missing = await asOwner.action(api.plugins.publish_version, {
			repositoryId: removedRepositoryId,
		});
		expect(missing).toEqual({ _nay: { message: "Not found" } });
	});

	test("lists the latest registered version per plugin name with publisher display names", async () => {
		const t = test_convex();
		const membership = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		await t.run(async (ctx) => {
			const anagraphicId = await ctx.db.insert("users_anagraphics", {
				userId: membership.userId,
				displayName: "Ray Publisher",
				email: "ray@example.com",
				updatedAt: Date.now(),
			});
			await ctx.db.patch("users", membership.userId, { anagraphic: anagraphicId });
		});
		await insert_plugin_version_doc(t, {
			name: "media",
			createdBy: membership.userId,
			version: "0.1.0",
		});
		const latestMediaVersionId = await insert_plugin_version_doc(t, {
			name: "media",
			createdBy: membership.userId,
			version: "0.2.0",
			reviewStatus: "passed",
		});
		const alphaVersionId = await insert_plugin_version_doc(t, {
			name: "alpha",
			createdBy: membership.userId,
			version: "1.0.0",
		});
		// Latest is by publish order, not semver: 0.1.9 wins because it was published after 0.1.10.
		await insert_plugin_version_doc(t, {
			name: "beta",
			createdBy: membership.userId,
			version: "0.1.10",
		});
		const latestBetaVersionId = await insert_plugin_version_doc(t, {
			name: "beta",
			createdBy: membership.userId,
			version: "0.1.9",
		});
		const asOwner = t.withIdentity(user_identity(membership.userId));

		const listed = await asOwner.query(api.plugins.list_published_plugins, { membershipId: membership.membershipId });
		expect(listed).toMatchObject([
			{
				pluginVersionId: alphaVersionId,
				name: "alpha",
				version: "1.0.0",
				publisherDisplayName: "Ray Publisher",
				reviewStatus: "pending",
			},
			{
				pluginVersionId: latestBetaVersionId,
				name: "beta",
				version: "0.1.9",
				publisherDisplayName: "Ray Publisher",
				reviewStatus: "pending",
			},
			{
				pluginVersionId: latestMediaVersionId,
				name: "media",
				version: "0.2.0",
				publisherDisplayName: "Ray Publisher",
				reviewStatus: "passed",
			},
		]);

		const strangerUserId = await t.run((ctx) => ctx.db.insert("users", { clerkUserId: null }));
		const asStranger = t.withIdentity(user_identity(strangerUserId));
		const unauthorized = await asStranger.query(api.plugins.list_published_plugins, {
			membershipId: membership.membershipId,
		});
		expect(unauthorized).toEqual([]);
	});

	test("get_publisher_plugin returns publish-ordered panel data only to the claim owner", async () => {
		const t = test_convex();
		const membership = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const repositoryId = await insert_claimed_repository(t, { ownerUserId: membership.userId });
		const now = Date.now();
		// Publish order beats semver order: 0.1.9 is latest because it was published after 0.1.10.
		const earlierVersionId = await insert_plugin_version_doc(t, {
			name: "media",
			createdBy: membership.userId,
			version: "0.1.10",
		});
		const latestVersionId = await insert_plugin_version_doc(t, {
			name: "media",
			createdBy: membership.userId,
			version: "0.1.9",
		});
		await t.run(async (ctx) => {
			for (const pluginName of ["media", "other"]) {
				await ctx.db.insert("plugins_version_reviews", {
					createdBy: membership.userId,
					artifactHash: `sha256:${(pluginName === "media" ? "e" : "f").repeat(64)}`,
					pluginName,
					version: "0.1.10",
					status: "passed",
					mechanicalFindings: [],
					aiFindings: [],
					model: "none",
					updatedAt: now,
				});
			}
		});
		const asOwner = t.withIdentity(user_identity(membership.userId));

		const details = await asOwner.query(api.plugins.get_publisher_plugin, { pluginName: "media" });
		if (!details) {
			throw new Error("Expected publisher plugin details");
		}
		expect(details.repository._id).toBe(repositoryId);
		expect(details.versions.map((version) => ({ _id: version._id, version: version.version }))).toEqual([
			{ _id: latestVersionId, version: "0.1.9" },
			{ _id: earlierVersionId, version: "0.1.10" },
		]);
		expect(details.reviews.map((review) => review.pluginName)).toEqual(["media"]);

		// Anyone who does not own the claim behind the latest version gets null.
		const strangerUserId = await t.run((ctx) => ctx.db.insert("users", { clerkUserId: null }));
		expect(
			await t.withIdentity(user_identity(strangerUserId)).query(api.plugins.get_publisher_plugin, {
				pluginName: "media",
			}),
		).toBeNull();
		expect(await t.query(api.plugins.get_publisher_plugin, { pluginName: "media" })).toBeNull();
		expect(await asOwner.query(api.plugins.get_publisher_plugin, { pluginName: "missing" })).toBeNull();

		// Removing the claim hides the panel data reactively.
		await t.run((ctx) => ctx.db.delete("plugins_publisher_repositories", repositoryId));
		expect(await asOwner.query(api.plugins.get_publisher_plugin, { pluginName: "media" })).toBeNull();
	});
});

describe("plugins uninstall_version", () => {
	// plugins_manage is a token bucket with capacity 2; refill a token before each extra write.
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function refill_manage_rate_limit() {
		vi.advanceTimersByTime(60_000);
	}

	test("uninstalls the installation, deletes handlers and secrets, and keeps runs", async () => {
		const t = test_convex();
		const membership = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const registered = await register_media_plugin(t, membership.userId);
		const asOwner = t.withIdentity(user_identity(membership.userId));
		const installed = await asOwner.mutation(api.plugins.install_version, {
			membershipId: membership.membershipId,
			pluginVersionId: registered.pluginVersionId,
			...media_plugin_consent,
		});
		if (installed._nay) {
			throw new Error(installed._nay.message);
		}
		const saved = await asOwner.mutation(api.plugins.upsert_installation_secret, {
			membershipId: membership.membershipId,
			installationId: installed._yay.installationId,
			name: "OPENAI_API_KEY",
			value: "sk-uninstall-secret",
		});
		if (saved._nay) {
			throw new Error(saved._nay.message);
		}
		const upload = await asOwner.mutation(api.files_nodes.create_upload_node, {
			membershipId: membership.membershipId,
			parentId: "root",
			filename: "history.png",
			contentType: "image/png",
			size: 1024,
		});
		if (upload._nay) {
			throw new Error(upload._nay.message);
		}
		const runId = await t.run(async (ctx) => {
			const installation = await ctx.db.get("plugins_workspace_installations", installed._yay.installationId);
			if (!installation) {
				throw new Error("Expected installation");
			}
			return await ctx.db.insert("plugins_event_runs", {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				sourceAssetId: upload._yay.assetId,
				sourceFileNodeId: upload._yay.nodeId,
				actorUserId: membership.userId,
				installationId: installed._yay.installationId,
				pluginVersionId: installation.pluginVersionId,
				event: "files.upload.completed",
				eventId: "plugin:uninstall-history-test",
				status: "succeeded",
				acceptedCapabilities: installation.acceptedCapabilities,
				expiresAt: Date.now() + 30 * 60 * 1000,
				hostCallCount: 1,
				hostWriteCount: 1,
				errorMessage: null,
				updatedAt: Date.now(),
			});
		});

		refill_manage_rate_limit();
		const uninstalled = await asOwner.mutation(api.plugins.uninstall_version, {
			membershipId: membership.membershipId,
			installationId: installed._yay.installationId,
		});
		if (uninstalled._nay) {
			throw new Error(uninstalled._nay.message);
		}

		const installation = await t.run((ctx) =>
			ctx.db.get("plugins_workspace_installations", installed._yay.installationId),
		);
		expect(installation).toBeNull();
		const handlers = await t.run((ctx) =>
			ctx.db
				.query("plugins_workspace_event_handlers")
				.withIndex("by_installation", (q) => q.eq("installationId", installed._yay.installationId))
				.collect(),
		);
		expect(handlers).toEqual([]);
		const secrets = await t.run((ctx) =>
			ctx.db
				.query("plugins_workspace_installation_secrets")
				.withIndex("by_installation_name", (q) => q.eq("installationId", installed._yay.installationId))
				.collect(),
		);
		expect(secrets).toEqual([]);
		// Event runs stay as history; the admin hard-delete flow sweeps them.
		const run = await t.run((ctx) => ctx.db.get("plugins_event_runs", runId));
		expect(run).not.toBeNull();
	});

	test("rejects uninstalls from users without workspace plugin permissions", async () => {
		const t = test_convex();
		const membership = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const registered = await register_media_plugin(t, membership.userId);
		const asOwner = t.withIdentity(user_identity(membership.userId));
		const installed = await asOwner.mutation(api.plugins.install_version, {
			membershipId: membership.membershipId,
			pluginVersionId: registered.pluginVersionId,
			...media_plugin_consent,
		});
		if (installed._nay) {
			throw new Error(installed._nay.message);
		}

		const strangerUserId = await t.run((ctx) => ctx.db.insert("users", { clerkUserId: null }));
		const rejected = await t.withIdentity(user_identity(strangerUserId)).mutation(api.plugins.uninstall_version, {
			membershipId: membership.membershipId,
			installationId: installed._yay.installationId,
		});
		expect(rejected).toEqual({ _nay: { message: "Unauthorized" } });

		const installation = await t.run((ctx) =>
			ctx.db.get("plugins_workspace_installations", installed._yay.installationId),
		);
		expect(installation).not.toBeNull();
	});

	test("reinstalls a plugin after uninstalling it", async () => {
		const t = test_convex();
		const membership = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const registered = await register_media_plugin(t, membership.userId);
		const asOwner = t.withIdentity(user_identity(membership.userId));
		const installed = await asOwner.mutation(api.plugins.install_version, {
			membershipId: membership.membershipId,
			pluginVersionId: registered.pluginVersionId,
			...media_plugin_consent,
		});
		if (installed._nay) {
			throw new Error(installed._nay.message);
		}

		refill_manage_rate_limit();
		const uninstalled = await asOwner.mutation(api.plugins.uninstall_version, {
			membershipId: membership.membershipId,
			installationId: installed._yay.installationId,
		});
		if (uninstalled._nay) {
			throw new Error(uninstalled._nay.message);
		}
		expect(await asOwner.query(api.plugins.list_installations, { membershipId: membership.membershipId })).toEqual([]);

		refill_manage_rate_limit();
		const reinstalled = await asOwner.mutation(api.plugins.install_version, {
			membershipId: membership.membershipId,
			pluginVersionId: registered.pluginVersionId,
			...media_plugin_consent,
		});
		if (reinstalled._nay) {
			throw new Error(reinstalled._nay.message);
		}
		expect(reinstalled._yay.installationId).not.toBe(installed._yay.installationId);

		const listed = await asOwner.query(api.plugins.list_installations, { membershipId: membership.membershipId });
		expect(listed).toHaveLength(1);
		expect(listed[0]?.handlers.map((handler: { contentType: string }) => handler.contentType).sort()).toEqual([
			"image/png",
			"video/mp4",
		]);
	});
});

describe("plugins run_installation_on_files", () => {
	async function install_media_plugin_with_upload(
		t: ReturnType<typeof test_convex>,
		args?: { contentTypes?: string[]; filename?: string; uploadContentType?: string; confirmUpload?: boolean },
	) {
		const membership = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const registered = await register_media_plugin(t, membership.userId, {
			contentTypes: args?.contentTypes ?? ["image/png"],
		});
		const asOwner = t.withIdentity(user_identity(membership.userId));
		const installed = await asOwner.mutation(api.plugins.install_version, {
			membershipId: membership.membershipId,
			pluginVersionId: registered.pluginVersionId,
			...media_plugin_consent,
		});
		if (installed._nay) {
			throw new Error(installed._nay.message);
		}
		const filename = args?.filename ?? "photo.png";
		const upload = await asOwner.mutation(api.files_nodes.create_upload_node, {
			membershipId: membership.membershipId,
			parentId: "root",
			filename,
			contentType: args?.uploadContentType ?? "image/png",
			size: 1024,
		});
		if (upload._nay) {
			throw new Error(upload._nay.message);
		}
		if (args?.confirmUpload !== false) {
			await t.run((ctx) => ctx.db.patch("files_r2_assets", upload._yay.assetId, { r2Key: `uploads/${filename}` }));
		}
		return { membership, asOwner, installationId: installed._yay.installationId, upload: upload._yay };
	}

	test("skips files whose content type has no enabled handler", async () => {
		const t = test_convex();
		const { installationId, upload } = await install_media_plugin_with_upload(t, {
			contentTypes: ["image/png"],
			filename: "clip.mp4",
			uploadContentType: "video/mp4",
		});

		const result = await t.mutation(internal.plugins.run_installation_on_files, {
			installationId,
			nodeIds: [upload.nodeId],
		});
		if (result._nay) {
			throw new Error(result._nay.message);
		}

		expect(result._yay.runs).toEqual([
			{ nodeId: upload.nodeId, runId: null, message: "Plugin does not handle this file type" },
		]);
		const runs = await t.run((ctx) => ctx.db.query("plugins_event_runs").collect());
		expect(runs).toEqual([]);
	});

	test("skips editable markdown nodes and uploads without a confirmed r2 object", async () => {
		const t = test_convex();
		const { membership, asOwner, installationId, upload } = await install_media_plugin_with_upload(t, {
			confirmUpload: false,
		});

		const markdown = await asOwner.action(api.files_nodes.create_markdown_node, {
			membershipId: membership.membershipId,
			parentId: "root",
			path: "/notes.md",
		});
		if (markdown._nay) {
			throw new Error(markdown._nay.message);
		}
		const result = await t.mutation(internal.plugins.run_installation_on_files, {
			installationId,
			nodeIds: [markdown._yay.nodeId, upload.nodeId],
		});
		if (result._nay) {
			throw new Error(result._nay.message);
		}

		expect(result._yay.runs).toEqual([
			{ nodeId: markdown._yay.nodeId, runId: null, message: "Plugin runs are only supported for uploaded files" },
			{ nodeId: upload.nodeId, runId: null, message: "File upload is not ready" },
		]);
		const runs = await t.run((ctx) => ctx.db.query("plugins_event_runs").collect());
		expect(runs).toEqual([]);
	});

	test("rejects disabled installations", async () => {
		const t = test_convex();
		const { installationId, upload } = await install_media_plugin_with_upload(t);
		await t.run((ctx) => ctx.db.patch("plugins_workspace_installations", installationId, { status: "disabled" }));

		const rejected = await t.mutation(internal.plugins.run_installation_on_files, {
			installationId,
			nodeIds: [upload.nodeId],
		});

		expect(rejected).toEqual({ _nay: { message: "Plugin is disabled" } });
		const runs = await t.run((ctx) => ctx.db.query("plugins_event_runs").collect());
		expect(runs).toEqual([]);
	});

	test("enqueues one run per file in a single call", async () => {
		const t = test_convex();
		const { membership, asOwner, installationId, upload } = await install_media_plugin_with_upload(t);
		const secondUpload = await asOwner.mutation(api.files_nodes.create_upload_node, {
			membershipId: membership.membershipId,
			parentId: "root",
			filename: "photo-2.png",
			contentType: "image/png",
			size: 1024,
		});
		if (secondUpload._nay) {
			throw new Error(secondUpload._nay.message);
		}
		await t.run((ctx) => ctx.db.patch("files_r2_assets", secondUpload._yay.assetId, { r2Key: "uploads/photo-2.png" }));

		const result = await t.mutation(internal.plugins.run_installation_on_files, {
			installationId,
			nodeIds: [upload.nodeId, secondUpload._yay.nodeId],
		});
		if (result._nay) {
			throw new Error(result._nay.message);
		}

		expect(result._yay.runs.map((run) => run.nodeId)).toEqual([upload.nodeId, secondUpload._yay.nodeId]);
		expect(result._yay.runs.map((run) => run.message)).toEqual([null, null]);
		const runs = await t.run((ctx) => ctx.db.query("plugins_event_runs").collect());
		expect(runs.map((run) => run.sourceFileNodeId).sort()).toEqual([upload.nodeId, secondUpload._yay.nodeId].sort());
	});

	test("blocks a second manual run while one is pending for the same installation and file", async () => {
		const t = test_convex();
		const { installationId, upload } = await install_media_plugin_with_upload(t);

		const first = await t.mutation(internal.plugins.run_installation_on_files, {
			installationId,
			nodeIds: [upload.nodeId],
		});
		if (first._nay) {
			throw new Error(first._nay.message);
		}
		const second = await t.mutation(internal.plugins.run_installation_on_files, {
			installationId,
			nodeIds: [upload.nodeId],
		});
		if (second._nay) {
			throw new Error(second._nay.message);
		}

		expect(second._yay.runs).toEqual([
			{ nodeId: upload.nodeId, runId: null, message: "A run for this plugin is already pending for this file" },
		]);
		const runs = await t.run((ctx) => ctx.db.query("plugins_event_runs").collect());
		expect(runs).toHaveLength(1);
	});

	test("blocks manual runs while a queued upload run exists for the same file", async () => {
		const t = test_convex();
		const { installationId, upload } = await install_media_plugin_with_upload(t);

		const enqueued = await t.mutation(internal.plugins_runtime.enqueue_upload_completed_runs, {
			sourceAssetId: upload.assetId,
			sourceFileNodeId: upload.nodeId,
			eventId: "r2:photo",
			contentType: "image/png",
		});
		expect(enqueued).toEqual({ _yay: { enqueued: 1 } });

		const result = await t.mutation(internal.plugins.run_installation_on_files, {
			installationId,
			nodeIds: [upload.nodeId],
		});
		if (result._nay) {
			throw new Error(result._nay.message);
		}

		expect(result._yay.runs).toEqual([
			{ nodeId: upload.nodeId, runId: null, message: "A run for this plugin is already pending for this file" },
		]);
		const runs = await t.run((ctx) => ctx.db.query("plugins_event_runs").collect());
		expect(runs).toHaveLength(1);
	});

	test("allows a re-run with a fresh eventId after the pending run succeeds", async () => {
		const t = test_convex();
		const { installationId, upload } = await install_media_plugin_with_upload(t);

		const first = await t.mutation(internal.plugins.run_installation_on_files, {
			installationId,
			nodeIds: [upload.nodeId],
		});
		if (first._nay) {
			throw new Error(first._nay.message);
		}
		const firstRunId = first._yay.runs[0]?.runId;
		if (!firstRunId) {
			throw new Error("Expected first queued run");
		}
		await t.run((ctx) => ctx.db.patch("plugins_event_runs", firstRunId, { status: "succeeded" }));

		const second = await t.mutation(internal.plugins.run_installation_on_files, {
			installationId,
			nodeIds: [upload.nodeId],
		});
		if (second._nay) {
			throw new Error(second._nay.message);
		}
		const secondRunId = second._yay.runs[0]?.runId;
		if (!secondRunId) {
			throw new Error("Expected second queued run");
		}

		expect(secondRunId).not.toBe(firstRunId);
		const [firstRun, secondRun] = await t.run(async (ctx) => [
			await ctx.db.get("plugins_event_runs", firstRunId),
			await ctx.db.get("plugins_event_runs", secondRunId),
		]);
		expect(firstRun?.eventId).not.toBe(secondRun?.eventId);
	});

	test("ignores expired queued runs when guarding new manual runs", async () => {
		const t = test_convex();
		const { installationId, upload } = await install_media_plugin_with_upload(t);

		const first = await t.mutation(internal.plugins.run_installation_on_files, {
			installationId,
			nodeIds: [upload.nodeId],
		});
		if (first._nay) {
			throw new Error(first._nay.message);
		}
		const firstRunId = first._yay.runs[0]?.runId;
		if (!firstRunId) {
			throw new Error("Expected first queued run");
		}
		// start_event_run refuses expired queued docs, so the guard must not count them either.
		await t.run((ctx) => ctx.db.patch("plugins_event_runs", firstRunId, { expiresAt: Date.now() - 1000 }));

		const second = await t.mutation(internal.plugins.run_installation_on_files, {
			installationId,
			nodeIds: [upload.nodeId],
		});
		if (second._nay) {
			throw new Error(second._nay.message);
		}
		expect(second._yay.runs[0]?.message).toBeNull();
		const runs = await t.run((ctx) => ctx.db.query("plugins_event_runs").collect());
		expect(runs).toHaveLength(2);
	});

	test("creates a queued manual run mirroring the upload run shape", async () => {
		const t = test_convex();
		const { membership, installationId, upload } = await install_media_plugin_with_upload(t);

		const result = await t.mutation(internal.plugins.run_installation_on_files, {
			installationId,
			nodeIds: [upload.nodeId],
		});
		if (result._nay) {
			throw new Error(result._nay.message);
		}
		const runId = result._yay.runs[0]?.runId;
		if (!runId) {
			throw new Error("Expected queued run");
		}

		const installation = await t.run((ctx) => ctx.db.get("plugins_workspace_installations", installationId));
		if (!installation) {
			throw new Error("Expected installation");
		}
		const run = await t.run((ctx) => ctx.db.get("plugins_event_runs", runId));
		if (!run) {
			throw new Error("Expected run doc");
		}
		expect(run).toMatchObject({
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			sourceAssetId: upload.assetId,
			sourceFileNodeId: upload.nodeId,
			actorUserId: membership.userId,
			installationId,
			pluginVersionId: installation.pluginVersionId,
			event: "files.run.requested",
			status: "queued",
			acceptedCapabilities: installation.acceptedCapabilities,
			hostCallCount: 0,
			hostWriteCount: 0,
			errorMessage: null,
		});
		expect(run.eventId.startsWith("run_requested::")).toBe(true);
		expect(run.eventId.endsWith(`::${installationId}`)).toBe(true);
		expect(run.workId).toBeDefined();
		expect(run.expiresAt).toBeGreaterThan(run._creationTime);
		// Manual runs never take over the asset's upload-conversion bookkeeping.
		const asset = await t.run((ctx) => ctx.db.get("files_r2_assets", upload.assetId));
		expect(asset?.conversionWorkId).toBeUndefined();
	});
});

describe("plugins admin hard delete", () => {
	test("hard-deletes one plugin's rows, R2 artifacts, and repository secrets while other plugins stay intact", async () => {
		const t = test_convex();
		const membership = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const media = await register_media_plugin(t, membership.userId, { name: "media" });
		const alternate = await register_media_plugin(t, membership.userId, {
			name: "media-alt",
			displayName: "Media Alt",
			contentTypes: ["image/png"],
		});
		const asOwner = t.withIdentity(user_identity(membership.userId));
		const installedMedia = await asOwner.mutation(api.plugins.install_version, {
			membershipId: membership.membershipId,
			pluginVersionId: media.pluginVersionId,
			...media_plugin_consent,
		});
		if (installedMedia._nay) {
			throw new Error(installedMedia._nay.message);
		}
		const installedAlternate = await asOwner.mutation(api.plugins.install_version, {
			membershipId: membership.membershipId,
			pluginVersionId: alternate.pluginVersionId,
			...media_plugin_consent,
		});
		if (installedAlternate._nay) {
			throw new Error(installedAlternate._nay.message);
		}
		const upload = await asOwner.mutation(api.files_nodes.create_upload_node, {
			membershipId: membership.membershipId,
			parentId: "root",
			filename: "hard-delete.png",
			contentType: "image/png",
			size: 1024,
		});
		if (upload._nay) {
			throw new Error(upload._nay.message);
		}
		await t.run(async (ctx) => {
			const now = Date.now();
			for (const name of ["media", "media-alt"]) {
				const repositoryId = await ctx.db.insert("plugins_publisher_repositories", {
					ownerUserId: membership.userId,
					repositoryUrl: `https://github.com/bonobo/${name}-plugin`,
					owner: "bonobo",
					repo: `${name}-plugin`,
				});
				// Each repository claim owns one secret; deleting "media" must cascade only its own.
				await ctx.db.insert("plugins_publisher_repository_secrets", {
					ownerUserId: membership.userId,
					repositoryId,
					name: "OPENAI_API_KEY",
					ciphertext: new TextEncoder().encode(`${name}-publisher-cipher`).buffer,
					nonce: new TextEncoder().encode("nonce").buffer,
					valuePreview: "configured",
					allowedOrigins: [],
					updatedAt: now,
				});
				await ctx.db.insert("plugins_version_reviews", {
					createdBy: membership.userId,
					artifactHash: `sha256:${(name === "media" ? "a" : "d").repeat(64)}`,
					pluginName: name,
					version: "0.1.0",
					status: "passed",
					mechanicalFindings: [],
					aiFindings: [],
					model: "none",
					updatedAt: now,
				});
			}
			await ctx.db.insert("plugins_workspace_installation_secrets", {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				installationId: installedMedia._yay.installationId,
				pluginName: "media",
				name: "OPENAI_API_KEY",
				ciphertext: new TextEncoder().encode("cipher").buffer,
				nonce: new TextEncoder().encode("nonce").buffer,
				valuePreview: "configured",
				createdBy: membership.userId,
				updatedBy: membership.userId,
				updatedAt: now,
			});
			const runId = await ctx.db.insert("plugins_event_runs", {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				sourceAssetId: upload._yay.assetId,
				sourceFileNodeId: upload._yay.nodeId,
				actorUserId: membership.userId,
				installationId: installedMedia._yay.installationId,
				pluginVersionId: media.pluginVersionId,
				event: "files.upload.completed",
				eventId: "plugin:hard-delete-test",
				status: "succeeded",
				acceptedCapabilities: media_plugin_consent.acceptedCapabilities,
				expiresAt: now + 30 * 60 * 1000,
				hostCallCount: 2,
				hostWriteCount: 1,
				errorMessage: null,
				updatedAt: now,
			});
			for (const sequence of [1, 2]) {
				await ctx.db.insert("plugins_event_run_calls", {
					organizationId: membership.organizationId,
					workspaceId: membership.workspaceId,
					runId,
					installationId: installedMedia._yay.installationId,
					pluginVersionId: media.pluginVersionId,
					sequence,
					operation: "writeMarkdown",
					status: "succeeded",
					errorMessage: null,
					startedAt: now,
					updatedAt: now,
				});
			}
		});

		const previewBefore = await t.query(internal.plugins.preview_hard_delete_registered_plugin, {
			pluginName: "media",
		});
		expect(previewBefore).toEqual({
			versions: 1,
			versionReviews: 1,
			sourceMounts: 1,
			installations: 1,
			eventHandlers: 2,
			installationSecrets: 1,
			eventRuns: 1,
			eventRunCalls: 2,
			publisherRepositoryClaims: 1,
			publisherSecrets: 1,
			r2ObjectKeys: 2,
		});

		const deleteObjectSpy = vi.spyOn(R2.prototype, "deleteObject").mockResolvedValue(undefined);
		// A tiny batch size forces multiple mutation batches through the action loop.
		await t.action(internal.plugins.hard_delete_registered_plugin_now, {
			pluginName: "media",
			_test_batchSize: 3,
		});

		const previewAfter = await t.query(internal.plugins.preview_hard_delete_registered_plugin, {
			pluginName: "media",
		});
		expect(previewAfter).toEqual({
			versions: 0,
			versionReviews: 0,
			sourceMounts: 0,
			installations: 0,
			eventHandlers: 0,
			installationSecrets: 0,
			eventRuns: 0,
			eventRunCalls: 0,
			publisherRepositoryClaims: 0,
			publisherSecrets: 0,
			r2ObjectKeys: 0,
		});

		const versions = await t.run((ctx) => ctx.db.query("plugins_versions").collect());
		expect(versions.map((version) => version.name)).toEqual(["media-alt"]);
		const reviews = await t.run((ctx) => ctx.db.query("plugins_version_reviews").collect());
		expect(reviews.map((review) => review.pluginName)).toEqual(["media-alt"]);
		const mounts = await t.run((ctx) => ctx.db.query("plugins_source_mounts").collect());
		expect(mounts.map((mount) => mount.pluginVersionId)).toEqual([alternate.pluginVersionId]);
		const installations = await t.run((ctx) => ctx.db.query("plugins_workspace_installations").collect());
		expect(installations.map((installation) => installation.pluginName)).toEqual(["media-alt"]);
		const handlers = await t.run((ctx) => ctx.db.query("plugins_workspace_event_handlers").collect());
		expect(handlers.map((handler) => handler.pluginName)).toEqual(["media-alt"]);
		expect(await t.run((ctx) => ctx.db.query("plugins_workspace_installation_secrets").collect())).toEqual([]);
		expect(await t.run((ctx) => ctx.db.query("plugins_event_runs").collect())).toEqual([]);
		expect(await t.run((ctx) => ctx.db.query("plugins_event_run_calls").collect())).toEqual([]);
		const claims = await t.run((ctx) => ctx.db.query("plugins_publisher_repositories").collect());
		expect(claims.map((claim) => claim.repositoryUrl)).toEqual(["https://github.com/bonobo/media-alt-plugin"]);

		// The deleted claim's secret cascades with it; the other repository's secret stays.
		const publisherSecrets = await t.run((ctx) => ctx.db.query("plugins_publisher_repository_secrets").collect());
		expect(publisherSecrets).toHaveLength(1);
		expect(publisherSecrets[0]).toMatchObject({
			ownerUserId: membership.userId,
			name: "OPENAI_API_KEY",
		});
		expect(new TextDecoder().decode(publisherSecrets[0].ciphertext)).toBe("media-alt-publisher-cipher");

		expect(deleteObjectSpy).toHaveBeenCalledWith(expect.anything(), "plugins/media/manifest.json");
		expect(deleteObjectSpy).toHaveBeenCalledWith(expect.anything(), "plugins/media/backend/worker.js");
		expect(deleteObjectSpy).not.toHaveBeenCalledWith(expect.anything(), "plugins/media-alt/manifest.json");
	});
});
