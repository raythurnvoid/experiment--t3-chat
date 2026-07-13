import { R2 } from "@convex-dev/r2";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Doc as YDoc, encodeStateAsUpdate } from "yjs";

import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { files_db_yjs_push_update, files_nodes_db_create_node_recursively_at_path } from "./files_nodes.ts";
import { r2_get_bucket } from "./r2.ts";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import { crypto_sha256_hex } from "../server/crypto-utils.ts";
import { files_u8_to_array_buffer, files_yjs_doc_update_from_markdown } from "../server/files.ts";
import { plugins_validate_manifest, type plugins_Capability } from "../shared/plugins.ts";

const r2Objects = new Map<string, BodyInit>();

beforeEach(() => {
	r2Objects.clear();
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (customKey?: string) => {
		const key = customKey ?? "test-upload-key";
		return { key, url: `https://r2.test/upload?key=${encodeURIComponent(key)}` };
	});
	vi.spyOn(R2.prototype, "getUrl").mockImplementation(
		async (key: string) => `https://r2.test/object?key=${encodeURIComponent(key)}`,
	);
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			const urlString = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
			if (urlString.startsWith("https://r2.test/upload?key=") && init?.method === "PUT") {
				const key = decodeURIComponent(urlString.slice("https://r2.test/upload?key=".length));
				r2Objects.set(key, init.body ?? "");
				return new Response(null, { status: 200 });
			}
			if (urlString.startsWith("https://r2.test/object?key=")) {
				const key = decodeURIComponent(urlString.slice("https://r2.test/object?key=".length));
				const body = r2Objects.get(key);
				return body === undefined ? new Response(null, { status: 404 }) : new Response(body, { status: 200 });
			}
			return new Response(null, { status: 404 });
		}),
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
		email: "plugin-ui-test@example.com",
	};
}

function auth_headers(token: string) {
	return {
		Authorization: `Bearer ${token}`,
		"Content-Type": "application/json",
	};
}

const gallery_manifest_base = {
	schemaVersion: 1,
	name: "gallery",
	displayName: "Gallery",
	version: "0.1.0",
	description: "Workspace media gallery",
	compatibility: { bonoboPluginRuntime: "1" },
	events: [],
	capabilities: ["workspace.files.read"],
	outboundOrigins: [],
	files: [
		{
			path: "dist/frontend/index.html",
			sha256: `sha256:${"a".repeat(64)}`,
			bytes: 128,
			contentType: "text/html",
		},
		{
			path: "dist/frontend/assets/index.js",
			sha256: `sha256:${"b".repeat(64)}`,
			bytes: 256,
			contentType: "application/javascript",
		},
	],
};

async function register_gallery_plugin(
	t: ReturnType<typeof test_convex>,
	userId: Id<"users">,
	args: {
		version?: string;
		capabilities?: plugins_Capability[];
		pages?: { id: string; title: string; entry: string; navItem: { label: string; icon: string } | null }[];
	} = {},
) {
	const version = args.version ?? "0.1.0";
	const repositoryId = await t.run(async (ctx) => {
		const repositoryUrl = "https://github.com/bonobo/gallery-plugin";
		const existing = await ctx.db
			.query("plugins_publisher_repositories")
			.withIndex("by_ownerUser_repositoryUrl", (q) => q.eq("ownerUserId", userId).eq("repositoryUrl", repositoryUrl))
			.first();
		return (
			existing?._id ??
			(await ctx.db.insert("plugins_publisher_repositories", {
				ownerUserId: userId,
				repositoryUrl,
				owner: "bonobo",
				repo: "gallery-plugin",
			}))
		);
	});
	const registered = await t.action(internal.plugins.register_plugin_version, {
		repositoryId,
		name: "gallery",
		displayName: "Gallery",
		version,
		description: "Workspace media gallery",
		reviewStatus: "passed",
		artifactHash: `sha256:${version.replaceAll(".", "0").padEnd(64, "c").slice(0, 64)}`,
		sourceRepositoryUrl: "https://github.com/bonobo/gallery-plugin",
		sourceOwner: "bonobo",
		sourceRepo: "gallery-plugin",
		sourceCommitSha: "1234567890abcdef1234567890abcdef12345678",
		manifestR2Key: `plugins/gallery/${version}/manifest.json`,
		backendEntrypointFile: null,
		events: [],
		pages: args.pages ?? [
			{
				id: "gallery",
				title: "Gallery",
				entry: "dist/frontend/index.html",
				navItem: { label: "Gallery", icon: "images" },
			},
		],
		capabilities: args.capabilities ?? ["workspace.files.read"],
		outboundOrigins: [],
		files: [
			{
				path: "dist/frontend/index.html",
				sha256: `sha256:${"a".repeat(64)}`,
				bytes: 128,
				contentType: "text/html",
				r2Key: `plugins/gallery/${version}/dist/frontend/index.html`,
			},
			{
				path: "dist/frontend/assets/index.js",
				sha256: `sha256:${"b".repeat(64)}`,
				bytes: 256,
				contentType: "application/javascript",
				r2Key: `plugins/gallery/${version}/dist/frontend/assets/index.js`,
			},
		],
		createdBy: userId,
		sourceFiles: [{ path: "dist/frontend/index.html", rawText: "<!doctype html><title>Gallery</title>" }],
	});
	if (registered._nay) {
		throw new Error(registered._nay.message);
	}
	return registered._yay;
}

async function install_gallery_plugin(
	t: ReturnType<typeof test_convex>,
	args: { capabilities?: plugins_Capability[] } = {},
) {
	const membership = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const registered = await register_gallery_plugin(t, membership.userId, { capabilities: args.capabilities });
	const asOwner = t.withIdentity(user_identity(membership.userId));
	const installed = await asOwner.mutation(api.plugins.install_version, {
		membershipId: membership.membershipId,
		pluginVersionId: registered.pluginVersionId,
		acceptedCapabilities: args.capabilities ?? ["workspace.files.read"],
		acceptedOutboundOrigins: [],
	});
	if (installed._nay) {
		throw new Error(installed._nay.message);
	}
	return {
		membership,
		asOwner,
		pluginVersionId: registered.pluginVersionId,
		installationId: installed._yay.installationId,
	};
}

async function mint_session_token(fixture: Awaited<ReturnType<typeof install_gallery_plugin>>) {
	const minted = await fixture.asOwner.mutation(api.plugins_ui.mint_page_session, {
		membershipId: fixture.membership.membershipId,
		pluginName: "gallery",
	});
	if (minted._nay) {
		throw new Error(minted._nay.message);
	}
	return minted._yay;
}

async function mint_reader_session(
	t: ReturnType<typeof test_convex>,
	fixture: Awaited<ReturnType<typeof install_gallery_plugin>>,
) {
	const reader = await t.run(async (ctx) => {
		const now = Date.now();
		const userId = await ctx.db.insert("users", { clerkUserId: "clerk-plugin-ui-reader" });
		const membershipId = await ctx.db.insert("organizations_workspaces_users", {
			organizationId: fixture.membership.organizationId,
			workspaceId: fixture.membership.workspaceId,
			userId,
			active: true,
		});
		const grantId = await ctx.db.insert("access_control_permission_grants", {
			organizationId: fixture.membership.organizationId,
			workspaceId: fixture.membership.workspaceId,
			resourceKind: "workspace",
			resourceId: String(fixture.membership.workspaceId),
			principalKind: "user",
			userId,
			permission: "asset.read",
			createdAt: now,
			updatedAt: now,
		});
		return { userId, membershipId, grantId };
	});
	const asReader = t.withIdentity(user_identity(reader.userId));
	const minted = await asReader.mutation(api.plugins_ui.mint_page_session, {
		membershipId: reader.membershipId,
		pluginName: "gallery",
	});
	if (minted._nay) {
		throw new Error(minted._nay.message);
	}
	return { ...reader, session: minted._yay };
}

function defer_download_urls() {
	let markStarted: (() => void) | null = null;
	let release: (() => void) | null = null;
	const started = new Promise<void>((resolve) => {
		markStarted = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	vi.spyOn(R2.prototype, "getUrl").mockImplementation(async (key: string) => {
		markStarted?.();
		await gate;
		return `https://r2.test/object?key=${encodeURIComponent(key)}`;
	});
	return { started, release: () => release?.() };
}

function defer_materialization_upload() {
	let markStarted: (() => void) | null = null;
	let release: (() => void) | null = null;
	const started = new Promise<void>((resolve) => {
		markStarted = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (customKey?: string) => {
		markStarted?.();
		await gate;
		const key = customKey ?? "test-upload-key";
		return { key, url: `https://r2.test/upload?key=${encodeURIComponent(key)}` };
	});
	return { started, release: () => release?.() };
}

async function seed_pending_markdown_node(
	t: ReturnType<typeof test_convex>,
	fixture: Awaited<ReturnType<typeof install_gallery_plugin>>,
	filename: string,
) {
	const created = await t.action(internal.files_nodes.create_file_by_path, {
		organizationId: fixture.membership.organizationId,
		workspaceId: fixture.membership.workspaceId,
		userId: fixture.membership.userId,
		path: `/${filename}`,
	});
	if (created._nay) throw new Error(created._nay.message);

	const yjsDoc = new YDoc();
	const updated = files_yjs_doc_update_from_markdown({ markdown: "# Pending materialization\n", mut_yjsDoc: yjsDoc });
	if (updated._nay) throw new Error(updated._nay.message);
	await t.run((ctx) =>
		files_db_yjs_push_update(ctx, {
			organizationId: fixture.membership.organizationId,
			workspaceId: fixture.membership.workspaceId,
			userId: fixture.membership.userId,
			nodeId: created._yay.nodeId,
			update: files_u8_to_array_buffer(encodeStateAsUpdate(yjsDoc)),
			sessionId: `plugin-ui-ttl-${filename}`,
		}),
	);
	yjsDoc.destroy();

	const r2Key = await t.run(async (ctx) => {
		const node = await ctx.db.get("files_nodes", created._yay.nodeId);
		const asset = node?.assetId ? await ctx.db.get("files_r2_assets", node.assetId) : null;
		if (!asset?.r2Key) throw new Error("Expected a materialized Markdown asset key");
		return asset.r2Key;
	});
	return { nodeId: created._yay.nodeId, r2Key };
}

// Direct seeding sidesteps the per-user files_tree_write rate limit (capacity 2 per test user).
async function seed_upload_node(
	t: ReturnType<typeof test_convex>,
	fixture: {
		membership: {
			organizationId: Id<"organizations">;
			workspaceId: Id<"organizations_workspaces">;
			userId: Id<"users">;
		};
	},
	args: { filename: string; contentType: string },
) {
	return await t.run(async (ctx) => {
		const now = Date.now();
		const assetId = await ctx.db.insert("files_r2_assets", {
			organizationId: fixture.membership.organizationId,
			workspaceId: fixture.membership.workspaceId,
			kind: "upload",
			r2Bucket: r2_get_bucket(),
			size: 1024,
			createdBy: fixture.membership.userId,
			updatedAt: now,
		});
		const created = await files_nodes_db_create_node_recursively_at_path(ctx, {
			organizationId: fixture.membership.organizationId,
			workspaceId: fixture.membership.workspaceId,
			userId: fixture.membership.userId,
			parentId: "root",
			path: args.filename,
			kind: "file",
			contentType: args.contentType,
			assetId,
			now,
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		return { nodeId: created._yay, assetId };
	});
}

// Direct seeding sidesteps the per-user mint rate limit (capacity 2 per test user).
async function seed_session_token(
	t: ReturnType<typeof test_convex>,
	fixture: Awaited<ReturnType<typeof install_gallery_plugin>>,
	tokenSeed: string,
	args: { expiresInMs?: number } = {},
) {
	const token = `plu_${tokenSeed.repeat(64).slice(0, 64)}`;
	await t.run(async (ctx) => {
		const now = Date.now();
		await ctx.db.insert("plugins_ui_sessions", {
			organizationId: fixture.membership.organizationId,
			workspaceId: fixture.membership.workspaceId,
			installationId: fixture.installationId,
			pluginVersionId: fixture.pluginVersionId,
			userId: fixture.membership.userId,
			tokenHash: await crypto_sha256_hex(token),
			createdAt: now,
			expiresAt: now + (args.expiresInMs ?? 30 * 60 * 1000),
		});
	});
	return token;
}

describe("plugin ui manifest pages", () => {
	test("accepts a frontend-only manifest with pages", () => {
		const manifest = {
			...gallery_manifest_base,
			pages: [
				{
					id: "gallery",
					title: "Gallery",
					entry: "dist/frontend/index.html",
					navItem: { label: "Gallery", icon: "images" },
				},
			],
		};

		expect(plugins_validate_manifest(manifest)).toMatchObject({ _yay: expect.any(Object) });
	});

	test("accepts an empty pages array", () => {
		expect(plugins_validate_manifest({ ...gallery_manifest_base, pages: [] })).toMatchObject({
			_yay: expect.any(Object),
		});
	});

	test("rejects duplicate page ids", () => {
		const manifest = {
			...gallery_manifest_base,
			pages: [
				{ id: "gallery", title: "Gallery", entry: "dist/frontend/index.html" },
				{ id: "gallery", title: "Gallery again", entry: "dist/frontend/index.html" },
			],
		};

		expect(plugins_validate_manifest(manifest)).toMatchObject({
			_nay: { message: 'Plugin manifest has duplicate page id "gallery"' },
		});
	});

	test("rejects a page entry that is not a listed file", () => {
		const manifest = {
			...gallery_manifest_base,
			pages: [{ id: "gallery", title: "Gallery", entry: "dist/frontend/missing.html" }],
		};

		expect(plugins_validate_manifest(manifest)).toMatchObject({
			_nay: { message: 'Plugin page "gallery" entry must be a listed file' },
		});
	});

	test("rejects a page entry that is not text/html", () => {
		const manifest = {
			...gallery_manifest_base,
			pages: [{ id: "gallery", title: "Gallery", entry: "dist/frontend/assets/index.js" }],
		};

		expect(plugins_validate_manifest(manifest)).toMatchObject({
			_nay: { message: 'Plugin page "gallery" entry must be a text/html file' },
		});
	});

	test("rejects a nav icon that is not a kebab-case name", () => {
		const manifest = {
			...gallery_manifest_base,
			pages: [
				{
					id: "gallery",
					title: "Gallery",
					entry: "dist/frontend/index.html",
					navItem: { label: "Gallery", icon: "Not An Icon!" },
				},
			],
		};

		expect(plugins_validate_manifest(manifest)).toMatchObject({ _nay: { message: expect.any(String) } });
	});
});

describe("plugin ui sessions", () => {
	test("registers a frontend-only version with pages persisted", async () => {
		const t = test_convex();
		const membership = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const registered = await register_gallery_plugin(t, membership.userId);

		const version = await t.run((ctx) => ctx.db.get("plugins_versions", registered.pluginVersionId));
		expect(version?.backendEntrypointFile).toBeNull();
		expect(version?.pages).toEqual([
			{
				id: "gallery",
				title: "Gallery",
				entry: "dist/frontend/index.html",
				navItem: { label: "Gallery", icon: "images" },
			},
		]);
	});

	test("lists ui pages for enabled installations only", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);

		const pages = await fixture.asOwner.query(api.plugins_ui.list_ui_pages, {
			membershipId: fixture.membership.membershipId,
		});
		// Assert the exact id: the host route builds the iframe URL from pluginVersionId, so a
		// wrong-but-valid id here would produce broken iframes.
		expect(pages).toEqual([
			{
				pluginName: "gallery",
				displayName: "Gallery",
				pluginVersionId: fixture.pluginVersionId,
				pages: [
					{
						id: "gallery",
						title: "Gallery",
						entry: "dist/frontend/index.html",
						navItem: { label: "Gallery", icon: "images" },
					},
				],
			},
		]);

		await t.run((ctx) =>
			ctx.db.patch("plugins_workspace_installations", fixture.installationId, { status: "disabled" }),
		);
		const afterDisable = await fixture.asOwner.query(api.plugins_ui.list_ui_pages, {
			membershipId: fixture.membership.membershipId,
		});
		expect(afterDisable).toEqual([]);
	});

	test("excludes pages-less versions from list_ui_pages and mint_page_session", async () => {
		const t = test_convex();
		const membership = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const registered = await register_gallery_plugin(t, membership.userId, { pages: [] });
		const asOwner = t.withIdentity(user_identity(membership.userId));
		const installed = await asOwner.mutation(api.plugins.install_version, {
			membershipId: membership.membershipId,
			pluginVersionId: registered.pluginVersionId,
			acceptedCapabilities: ["workspace.files.read"],
			acceptedOutboundOrigins: [],
		});
		expect(installed._nay).toBeUndefined();

		const pages = await asOwner.query(api.plugins_ui.list_ui_pages, {
			membershipId: membership.membershipId,
		});
		expect(pages).toEqual([]);

		const minted = await asOwner.mutation(api.plugins_ui.mint_page_session, {
			membershipId: membership.membershipId,
			pluginName: "gallery",
		});
		expect(minted).toMatchObject({ _nay: { message: "Not found" } });
	});

	test("excludes non-ready versions from page listing and session minting", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);

		for (const sourceStatus of ["preparing", "failed"] as const) {
			await t.run((ctx) => ctx.db.patch("plugins_versions", fixture.pluginVersionId, { sourceStatus }));
			expect(
				await fixture.asOwner.query(api.plugins_ui.list_ui_pages, {
					membershipId: fixture.membership.membershipId,
				}),
			).toEqual([]);
			expect(
				await fixture.asOwner.mutation(api.plugins_ui.mint_page_session, {
					membershipId: fixture.membership.membershipId,
					pluginName: "gallery",
				}),
			).toMatchObject({ _nay: { message: "Not found" } });
		}
	});

	test("minted token lists and reads files but can never write", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);
		await seed_upload_node(t, fixture, { filename: "photo.png", contentType: "image/png" });

		const session = await mint_session_token(fixture);
		expect(session.token).toMatch(/^plu_[0-9a-f]{64}$/u);

		const listResponse = await t.fetch("/api/v1/files/list", {
			method: "POST",
			headers: auth_headers(session.token),
			body: JSON.stringify({ recursive: true }),
		});
		expect(listResponse.status).toBe(200);
		const listBody = await listResponse.json();
		expect(listBody.items).toMatchObject([{ name: "photo.png", contentType: "image/png" }]);

		const writeResponse = await t.fetch("/api/v1/files/write", {
			method: "POST",
			headers: auth_headers(session.token),
			body: JSON.stringify({ path: "/notes.md", content: "# nope" }),
		});
		expect(writeResponse.status).toBe(403);
	});

	test("refreshes one session in place, invalidates the old token, and revokes the current token", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);
		const initial = await mint_session_token(fixture);
		const list_with = (token: string) =>
			t.fetch("/api/v1/files/list", {
				method: "POST",
				headers: auth_headers(token),
				body: JSON.stringify({ recursive: true }),
			});

		const refreshed = await fixture.asOwner.mutation(api.plugins_ui.refresh_page_session, {
			membershipId: fixture.membership.membershipId,
			sessionId: initial.sessionId,
		});
		expect(refreshed._nay).toBeUndefined();
		if (refreshed._nay) {
			throw new Error(refreshed._nay.message);
		}
		expect(refreshed._yay.token).not.toBe(initial.token);
		expect((await list_with(initial.token)).status).toBe(401);
		expect((await list_with(refreshed._yay.token)).status).toBe(200);

		const sessionsAfterRefresh = await t.run((ctx) => ctx.db.query("plugins_ui_sessions").collect());
		expect(sessionsAfterRefresh).toHaveLength(1);
		expect(sessionsAfterRefresh[0]?._id).toBe(initial.sessionId);

		const revoked = await fixture.asOwner.mutation(api.plugins_ui.revoke_page_session, {
			membershipId: fixture.membership.membershipId,
			sessionId: initial.sessionId,
		});
		expect(revoked._nay).toBeUndefined();
		expect((await list_with(refreshed._yay.token)).status).toBe(401);
	});

	test("uses one stable principal key across sessions", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);
		const first = await mint_session_token(fixture);
		const second = await mint_session_token(fixture);
		const [firstPrincipal, secondPrincipal] = await Promise.all(
			[first.token, second.token].map((presented) => t.query(internal.public_api.resolve_principal, { presented })),
		);
		expect(firstPrincipal._nay).toBeUndefined();
		expect(secondPrincipal._nay).toBeUndefined();
		if (firstPrincipal._nay || secondPrincipal._nay) {
			throw new Error("plugin ui session did not resolve");
		}
		expect(firstPrincipal._yay.principalKey).toBe(secondPrincipal._yay.principalKey);
		expect(firstPrincipal._yay.principalKey).toContain(fixture.installationId);

		const isolatedToken = `plu_${"f".repeat(64)}`;
		await t.run(async (ctx) => {
			const now = Date.now();
			const installationId = await ctx.db.insert("plugins_workspace_installations", {
				organizationId: fixture.membership.organizationId,
				workspaceId: fixture.membership.workspaceId,
				pluginVersionId: fixture.pluginVersionId,
				pluginName: "gallery-copy",
				status: "enabled",
				acceptedCapabilities: ["workspace.files.read"],
				capabilitiesAcceptedAt: now,
				acceptedOutboundOrigins: [],
				outboundOriginsAcceptedAt: now,
				installedBy: fixture.membership.userId,
				updatedBy: fixture.membership.userId,
				updatedAt: now,
			});
			await ctx.db.insert("plugins_ui_sessions", {
				organizationId: fixture.membership.organizationId,
				workspaceId: fixture.membership.workspaceId,
				installationId,
				pluginVersionId: fixture.pluginVersionId,
				userId: fixture.membership.userId,
				tokenHash: await crypto_sha256_hex(isolatedToken),
				createdAt: now,
				expiresAt: now + 60_000,
			});
		});
		const isolatedPrincipal = await t.query(internal.public_api.resolve_principal, {
			presented: isolatedToken,
		});
		expect(isolatedPrincipal._nay).toBeUndefined();
		if (isolatedPrincipal._nay) {
			throw new Error(isolatedPrincipal._nay.message);
		}
		expect(isolatedPrincipal._yay.principalKey).not.toBe(firstPrincipal._yay.principalKey);
	});

	test("shares public-api capacity across sessions while keeping route buckets separate", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);
		const first = await mint_session_token(fixture);
		const second = await mint_session_token(fixture);
		const list_with = (token: string) =>
			t.fetch("/api/v1/files/list", {
				method: "POST",
				headers: auth_headers(token),
				body: JSON.stringify({ recursive: true }),
			});

		for (let call = 0; call < 20; call += 1) {
			expect((await list_with(call % 2 === 0 ? first.token : second.token)).status).toBe(200);
		}
		expect((await list_with(second.token)).status).toBe(429);

		const separateRoute = await t.fetch("/api/v1/files/read", {
			method: "POST",
			headers: auth_headers(first.token),
			body: JSON.stringify({ path: "/missing.md" }),
		});
		expect(separateRoute.status).not.toBe(429);
	});

	test("filters by contentTypePrefixes while the cursor still advances", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);
		await seed_upload_node(t, fixture, { filename: "a.png", contentType: "image/png" });
		await seed_upload_node(t, fixture, { filename: "b.md", contentType: "text/markdown" });
		await seed_upload_node(t, fixture, { filename: "c.mp4", contentType: "video/mp4" });

		const session = await mint_session_token(fixture);
		const collected: Array<{ name: string }> = [];
		let cursor: string | null = null;
		let pageCount = 0;
		for (let i = 0; i < 10; i++) {
			const response = await t.fetch("/api/v1/files/list", {
				method: "POST",
				headers: auth_headers(session.token),
				body: JSON.stringify({
					recursive: true,
					limit: 1,
					cursor,
					contentTypePrefixes: ["image/", "video/"],
				}),
			});
			expect(response.status).toBe(200);
			const body = await response.json();
			collected.push(...body.items);
			pageCount += 1;
			if (body.isDone) {
				break;
			}
			cursor = body.cursor;
		}

		// One node per page: the markdown page comes back empty but still advances the cursor.
		expect(pageCount).toBeGreaterThanOrEqual(3);
		expect(collected.map((item) => item.name)).toEqual(["a.png", "c.mp4"]);
	});

	test("issues download urls whose ttl is clamped to the session expiry", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);
		const seeded = await seed_upload_node(t, fixture, { filename: "photo.png", contentType: "image/png" });
		await t.run((ctx) => ctx.db.patch("files_r2_assets", seeded.assetId, { r2Key: "test/photo.png" }));

		// The session has 45 seconds left and the URL ceiling is 15 minutes: the shorter session expiry must win.
		const token = await seed_session_token(t, fixture, "4", { expiresInMs: 45_000 });
		const response = await t.fetch("/api/v1/files/download-urls", {
			method: "POST",
			headers: auth_headers(token),
			body: JSON.stringify({ fileNodeIds: [seeded.nodeId], expiresInSeconds: 900 }),
		});
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.items).toHaveLength(1);
		expect(body.items[0].url).toContain("https://r2.test/object?key=");
		expect(body.items[0].expiresAt).toBeLessThanOrEqual(Date.now() + 46_000);
		// Lower bound: clamped to the session expiry, not squashed to some fixed tiny TTL.
		expect(body.items[0].expiresAt).toBeGreaterThan(Date.now() + 30_000);

		// Above the 900s zod ceiling: rejected outright, not clamped.
		const overCeiling = await t.fetch("/api/v1/files/download-urls", {
			method: "POST",
			headers: auth_headers(token),
			body: JSON.stringify({ fileNodeIds: [seeded.nodeId], expiresInSeconds: 901 }),
		});
		expect(overCeiling.status).toBe(400);
	});

	test("calculates the signer ttl after delayed materialization", async () => {
		let now = Date.now();
		const startedAt = now;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);
		const pending = await seed_pending_markdown_node(t, fixture, "download.md");
		const session = await mint_session_token(fixture);
		const authorityExpiresAt = startedAt + 10_000;
		await t.run((ctx) => ctx.db.patch("plugins_ui_sessions", session.sessionId, { expiresAt: authorityExpiresAt }));

		const signerCalls: Array<{ key: string; expiresIn: number }> = [];
		vi.spyOn(R2.prototype, "getUrl").mockImplementation(async (key: string, options?: { expiresIn?: number }) => {
			signerCalls.push({ key, expiresIn: options?.expiresIn ?? 900 });
			return `https://r2.test/object?key=${encodeURIComponent(key)}`;
		});
		const materialization = defer_materialization_upload();
		const responsePromise = t.fetch("/api/v1/files/download-urls", {
			method: "POST",
			headers: auth_headers(session.token),
			body: JSON.stringify({ fileNodeIds: [pending.nodeId] }),
		});
		await materialization.started;
		now = startedAt + 8_000;
		const callsBeforeRelease = signerCalls.length;
		materialization.release();

		const response = await responsePromise;
		expect(response.status).toBe(200);
		const call = signerCalls.slice(callsBeforeRelease).findLast(({ key }) => key === pending.r2Key);
		expect(call?.expiresIn).toBe(1);
		const body = await response.json();
		const expiresAt = body.items[0].expiresAt;
		expect(expiresAt).toBeLessThanOrEqual(now + 1_000);
		expect(expiresAt).toBeLessThanOrEqual(authorityExpiresAt);
	});

	test("mints batch download URLs with per-id errors", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);
		const first = await seed_upload_node(t, fixture, { filename: "one.png", contentType: "image/png" });
		const second = await seed_upload_node(t, fixture, { filename: "two.png", contentType: "image/png" });
		await t.run(async (ctx) => {
			await ctx.db.patch("files_r2_assets", first.assetId, { r2Key: "test/one.png" });
			await ctx.db.patch("files_r2_assets", second.assetId, { r2Key: "test/two.png" });
		});
		const session = await mint_session_token(fixture);

		const response = await t.fetch("/api/v1/files/download-urls", {
			method: "POST",
			headers: auth_headers(session.token),
			body: JSON.stringify({ fileNodeIds: [first.nodeId, second.nodeId, "not-a-real-node-id"] }),
		});
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.items.map((item: { fileNodeId: string }) => item.fileNodeId)).toEqual([first.nodeId, second.nodeId]);
		expect(body.items[0].url).toContain("https://r2.test/object?key=");
		expect(body.errors).toEqual([{ fileNodeId: "not-a-real-node-id", message: "Not found" }]);
		expect(body.truncated).toBe(false);
	});

	test("suppresses signed urls when asset.read is revoked during signing", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);
		const seeded = await seed_upload_node(t, fixture, { filename: "photo.png", contentType: "image/png" });
		await t.run((ctx) => ctx.db.patch("files_r2_assets", seeded.assetId, { r2Key: "test/photo.png" }));
		const reader = await mint_reader_session(t, fixture);
		const signing = defer_download_urls();

		const responsePromise = t.fetch("/api/v1/files/download-urls", {
			method: "POST",
			headers: auth_headers(reader.session.token),
			body: JSON.stringify({ fileNodeIds: [seeded.nodeId] }),
		});
		await signing.started;
		await t.run((ctx) => ctx.db.delete("access_control_permission_grants", reader.grantId));
		signing.release();

		const response = await responsePromise;
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ message: "Permission denied" });
	});

	test("suppresses every batch url when its session expires during signing", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);
		const first = await seed_upload_node(t, fixture, { filename: "one.png", contentType: "image/png" });
		const second = await seed_upload_node(t, fixture, { filename: "two.png", contentType: "image/png" });
		await t.run(async (ctx) => {
			await ctx.db.patch("files_r2_assets", first.assetId, { r2Key: "test/one.png" });
			await ctx.db.patch("files_r2_assets", second.assetId, { r2Key: "test/two.png" });
		});
		const session = await mint_session_token(fixture);
		const signing = defer_download_urls();

		const responsePromise = t.fetch("/api/v1/files/download-urls", {
			method: "POST",
			headers: auth_headers(session.token),
			body: JSON.stringify({ fileNodeIds: [first.nodeId, second.nodeId] }),
		});
		await signing.started;
		await t.run((ctx) => ctx.db.patch("plugins_ui_sessions", session.sessionId, { expiresAt: Date.now() - 1 }));
		signing.release();

		const response = await responsePromise;
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ message: "Unauthenticated" });
	});

	test.each([
		"membership removed",
		"installation disabled",
		"installation uninstalled",
		"installation upgraded",
	] as const)("suppresses batch urls when the %s during signing", async (change) => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);
		const seeded = await seed_upload_node(t, fixture, { filename: "photo.png", contentType: "image/png" });
		await t.run((ctx) => ctx.db.patch("files_r2_assets", seeded.assetId, { r2Key: "test/photo.png" }));
		const session = await mint_session_token(fixture);
		const nextVersion =
			change === "installation upgraded"
				? await register_gallery_plugin(t, fixture.membership.userId, { version: "0.2.0" })
				: null;
		const signing = defer_download_urls();

		const responsePromise = t.fetch("/api/v1/files/download-urls", {
			method: "POST",
			headers: auth_headers(session.token),
			body: JSON.stringify({ fileNodeIds: [seeded.nodeId] }),
		});
		await signing.started;
		await t.run(async (ctx) => {
			switch (change) {
				case "membership removed":
					await ctx.db.delete("organizations_workspaces_users", fixture.membership.membershipId);
					break;
				case "installation disabled":
					await ctx.db.patch("plugins_workspace_installations", fixture.installationId, { status: "disabled" });
					break;
				case "installation uninstalled":
					await ctx.db.delete("plugins_workspace_installations", fixture.installationId);
					break;
				case "installation upgraded":
					if (!nextVersion) throw new Error("Missing upgraded plugin version");
					await ctx.db.patch("plugins_workspace_installations", fixture.installationId, {
						pluginVersionId: nextVersion.pluginVersionId,
					});
			}
		});
		signing.release();

		const response = await responsePromise;
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ message: "Unauthenticated" });
	});

	test("truncates batch ids at twenty and charges the full route bucket", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);
		const session = await mint_session_token(fixture);
		const fileNodeIds = Array.from({ length: 21 }, (_, index) => `missing-${index}`);

		const response = await t.fetch("/api/v1/files/download-urls", {
			method: "POST",
			headers: auth_headers(session.token),
			body: JSON.stringify({ fileNodeIds }),
		});
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.items).toEqual([]);
		expect(body.errors).toHaveLength(20);
		expect(body.errors.map((error: { fileNodeId: string }) => error.fileNodeId)).toEqual(fileNodeIds.slice(0, 20));
		expect(body.truncated).toBe(true);

		const rateLimited = await t.fetch("/api/v1/files/download-urls", {
			method: "POST",
			headers: auth_headers(session.token),
			body: JSON.stringify({ fileNodeIds: ["missing-again"] }),
		});
		expect(rateLimited.status).toBe(429);
	});

	test("bounds batch request work before authentication", async () => {
		const t = test_convex();
		const tooManyIds = await t.fetch("/api/v1/files/download-urls", {
			method: "POST",
			body: JSON.stringify({ fileNodeIds: Array.from({ length: 101 }, (_, index) => `missing-${index}`) }),
		});
		expect(tooManyIds.status).toBe(400);

		const oversizedBody = await t.fetch("/api/v1/files/download-urls", {
			method: "POST",
			body: JSON.stringify({ fileNodeIds: ["x".repeat(32_001)] }),
		});
		expect(oversizedBody.status).toBe(400);
		expect(await oversizedBody.json()).toEqual({ message: "Request body is too large" });

		let streamCancelled = false;
		const streamingBody = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(32_001));
			},
			cancel() {
				streamCancelled = true;
			},
		});
		const streamedBody = await t.fetch("/api/v1/files/download-urls", {
			method: "POST",
			body: streamingBody,
			// Node requires this flag when Request receives a streaming body.
			duplex: "half",
		} as RequestInit & { duplex: "half" });
		expect(streamedBody.status).toBe(400);
		expect(await streamedBody.json()).toEqual({ message: "Request body is too large" });
		expect(streamCancelled).toBe(true);
	});

	test("rejects duplicate batch ids before rate charging or signing", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);
		const session = await mint_session_token(fixture);
		const getUrlSpy = vi.spyOn(R2.prototype, "getUrl");

		const duplicate = await t.fetch("/api/v1/files/download-urls", {
			method: "POST",
			headers: auth_headers(session.token),
			body: JSON.stringify({ fileNodeIds: ["duplicate", "duplicate"] }),
		});
		expect(duplicate.status).toBe(400);
		expect(await duplicate.json()).toEqual({ message: "fileNodeIds must be unique" });
		expect(getUrlSpy).not.toHaveBeenCalled();

		const fullBatch = await t.fetch("/api/v1/files/download-urls", {
			method: "POST",
			headers: auth_headers(session.token),
			body: JSON.stringify({ fileNodeIds: Array.from({ length: 20 }, (_, index) => `missing-${index}`) }),
		});
		expect(fullBatch.status).toBe(200);
		const rateLimited = await t.fetch("/api/v1/files/download-urls", {
			method: "POST",
			headers: auth_headers(session.token),
			body: JSON.stringify({ fileNodeIds: ["missing-again"] }),
		});
		expect(rateLimited.status).toBe(429);
	});

	test("never signs a file from another workspace in a batch", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);
		const local = await seed_upload_node(t, fixture, { filename: "local.png", contentType: "image/png" });
		const foreignMembership = await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, {
				organizationName: "foreign-organization",
				workspaceName: "foreign-workspace",
			}),
		);
		const foreign = await seed_upload_node(
			t,
			{ membership: foreignMembership },
			{
				filename: "foreign.png",
				contentType: "image/png",
			},
		);
		await t.run(async (ctx) => {
			await ctx.db.patch("files_r2_assets", local.assetId, { r2Key: "test/local.png" });
			await ctx.db.patch("files_r2_assets", foreign.assetId, { r2Key: "test/foreign.png" });
		});
		const session = await mint_session_token(fixture);

		const response = await t.fetch("/api/v1/files/download-urls", {
			method: "POST",
			headers: auth_headers(session.token),
			body: JSON.stringify({ fileNodeIds: [local.nodeId, foreign.nodeId] }),
		});
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.items.map((item: { fileNodeId: string }) => item.fileNodeId)).toEqual([local.nodeId]);
		expect(body.errors).toEqual([{ fileNodeId: foreign.nodeId, message: "Not found" }]);
		expect(JSON.stringify(body)).not.toContain("test/foreign.png");
	});

	test("returns 403 on read-many, which plugin ui principals never get", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);
		await seed_upload_node(t, fixture, { filename: "photo.png", contentType: "image/png" });
		const session = await mint_session_token(fixture);

		const response = await t.fetch("/api/v1/files/read-many", {
			method: "POST",
			headers: auth_headers(session.token),
			body: JSON.stringify({ paths: ["/photo.png"] }),
		});
		expect(response.status).toBe(403);
	});

	test("returns 403 when workspace.files.read was not accepted", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t, { capabilities: [] });
		const session = await mint_session_token(fixture);

		const listResponse = await t.fetch("/api/v1/files/list", {
			method: "POST",
			headers: auth_headers(session.token),
			body: JSON.stringify({ recursive: true }),
		});
		expect(listResponse.status).toBe(403);
	});

	test("revokes tokens on disable, upgrade, and expiry", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);
		const list_with = async (token: string) =>
			t.fetch("/api/v1/files/list", {
				method: "POST",
				headers: auth_headers(token),
				body: JSON.stringify({ recursive: true }),
			});

		const disabled = await seed_session_token(t, fixture, "1");
		await t.run((ctx) =>
			ctx.db.patch("plugins_workspace_installations", fixture.installationId, { status: "disabled" }),
		);
		expect((await list_with(disabled)).status).toBe(401);
		await t.run((ctx) =>
			ctx.db.patch("plugins_workspace_installations", fixture.installationId, { status: "enabled" }),
		);

		const upgraded = await seed_session_token(t, fixture, "2");
		const nextVersion = await register_gallery_plugin(t, fixture.membership.userId, { version: "0.2.0" });
		await t.run((ctx) =>
			ctx.db.patch("plugins_workspace_installations", fixture.installationId, {
				pluginVersionId: nextVersion.pluginVersionId,
			}),
		);
		expect((await list_with(upgraded)).status).toBe(401);
		await t.run((ctx) =>
			ctx.db.patch("plugins_workspace_installations", fixture.installationId, {
				pluginVersionId: fixture.pluginVersionId,
			}),
		);

		const expired = await seed_session_token(t, fixture, "3");
		await t.run(async (ctx) => {
			const sessions = await ctx.db.query("plugins_ui_sessions").collect();
			await Promise.all(
				sessions.map((session) => ctx.db.patch("plugins_ui_sessions", session._id, { expiresAt: Date.now() - 1000 })),
			);
		});
		expect((await list_with(expired)).status).toBe(401);
	});

	test("uninstall deletes the installation's ui sessions", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);
		await seed_session_token(t, fixture, "5");

		const uninstalled = await fixture.asOwner.mutation(api.plugins.uninstall_version, {
			membershipId: fixture.membership.membershipId,
			installationId: fixture.installationId,
		});
		expect(uninstalled._nay).toBeUndefined();

		const sessions = await t.run((ctx) => ctx.db.query("plugins_ui_sessions").collect());
		expect(sessions).toHaveLength(0);
	});

	test("cleanup cron deletes expired sessions in batches and keeps live ones", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);
		await seed_session_token(t, fixture, "a", { expiresInMs: -60_000 });
		await seed_session_token(t, fixture, "b", { expiresInMs: -60_000 });
		await seed_session_token(t, fixture, "c", { expiresInMs: -60_000 });
		const live = await seed_session_token(t, fixture, "d");

		// A full batch reports done:false (the production path reschedules itself on that signal).
		const first = await t.mutation(internal.plugins_ui.cleanup_expired_ui_sessions, {
			batchSize: 2,
			_test_disableReschedule: true,
		});
		expect(first).toEqual({ deletedCount: 2, done: false });

		const second = await t.mutation(internal.plugins_ui.cleanup_expired_ui_sessions, {
			batchSize: 2,
			_test_disableReschedule: true,
		});
		expect(second).toEqual({ deletedCount: 1, done: true });

		const remaining = await t.run((ctx) => ctx.db.query("plugins_ui_sessions").collect());
		expect(remaining).toHaveLength(1);
		expect(remaining[0]?.tokenHash).toBe(await crypto_sha256_hex(live));
	});

	test("refuses to mint for a disabled installation", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);
		await t.run((ctx) =>
			ctx.db.patch("plugins_workspace_installations", fixture.installationId, { status: "disabled" }),
		);

		const minted = await fixture.asOwner.mutation(api.plugins_ui.mint_page_session, {
			membershipId: fixture.membership.membershipId,
			pluginName: "gallery",
		});
		expect(minted).toMatchObject({ _nay: { message: "Not found" } });
	});
});

describe("plugin ui assets", () => {
	test("serves a published html entry with CSP and immutable caching", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);
		r2Objects.set("plugins/gallery/0.1.0/dist/frontend/index.html", "<!doctype html><title>Gallery</title>");

		const response = await t.fetch(`/plugins-ui/${fixture.pluginVersionId}/dist/frontend/index.html`, {
			method: "GET",
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("text/html");
		expect(response.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
		const csp = response.headers.get("Content-Security-Policy");
		expect(csp).toContain("default-src 'none'");
		expect(csp).toContain("frame-ancestors https://app.test");
		expect(await response.text()).toBe("<!doctype html><title>Gallery</title>");
	});

	test("attaches CSP to non-html assets too, so no served document escapes the policy", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);
		r2Objects.set("plugins/gallery/0.1.0/dist/frontend/assets/index.js", "console.log('gallery');");

		const response = await t.fetch(`/plugins-ui/${fixture.pluginVersionId}/dist/frontend/assets/index.js`, {
			method: "GET",
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("application/javascript");
		expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
		// Module scripts fetch in CORS mode from the opaque-origin page.
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
	});

	test("does not serve artifacts until the source snapshot is ready", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);
		r2Objects.set("plugins/gallery/0.1.0/dist/frontend/index.html", "<!doctype html><title>Gallery</title>");

		for (const sourceStatus of ["preparing", "failed"] as const) {
			await t.run((ctx) => ctx.db.patch("plugins_versions", fixture.pluginVersionId, { sourceStatus }));
			const response = await t.fetch(`/plugins-ui/${fixture.pluginVersionId}/dist/frontend/index.html`, {
				method: "GET",
			});
			expect(response.status).toBe(404);
		}
	});

	test("404s on unknown versions, unlisted paths, and malformed segments", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);

		const unknownVersion = await t.fetch("/plugins-ui/nope/dist/frontend/index.html", { method: "GET" });
		expect(unknownVersion.status).toBe(404);

		const unlisted = await t.fetch(`/plugins-ui/${fixture.pluginVersionId}/dist/frontend/other.html`, {
			method: "GET",
		});
		expect(unlisted.status).toBe(404);

		// Dot segments never reach the handler over HTTP: the WHATWG URL parser collapses them
		// (the ".." here arrives as dist/index.html). So the exact-match file lookup is the real
		// traversal defense, and the handler's segment guard is a second layer.
		const dotSegments = await t.fetch(
			`/plugins-ui/${fixture.pluginVersionId}/dist/frontend/${encodeURIComponent("..")}/index.html`,
			{ method: "GET" },
		);
		expect(dotSegments.status).toBe(404);

		// Empty segments DO survive URL normalization and exercise the segment guard directly.
		const emptySegment = await t.fetch(`/plugins-ui/${fixture.pluginVersionId}/dist/frontend//index.html`, {
			method: "GET",
		});
		expect(emptySegment.status).toBe(404);
	});

	test("404s on malformed percent-encoding instead of throwing", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);

		// The WHATWG URL parser keeps invalid %-sequences verbatim, so decodeURIComponent sees them.
		const response = await t.fetch(`/plugins-ui/${fixture.pluginVersionId}/dist/frontend/%zz.html`, {
			method: "GET",
		});
		expect(response.status).toBe(404);
	});

	test("502s with no-store on object-service failure without leaking the object key", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);
		// No r2Objects entry for the key: the signed-URL fetch 404s and r2_fetch_object_from_bucket
		// throws its convex_error (whose data.cause carries the R2 key).
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const response = await t.fetch(`/plugins-ui/${fixture.pluginVersionId}/dist/frontend/index.html`, {
			method: "GET",
		});
		expect(response.status).toBe(502);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(response.headers.get("Retry-After")).toBe("3");
		const body = await response.text();
		expect(body).toBe(JSON.stringify({ message: "Temporarily unavailable" }));
		expect(body).not.toContain("plugins/gallery");

		// The log keeps version/path for debugging but never the R2 key (its prefix would be
		// "plugins/gallery"; the sanitized path field alone matches "dist/frontend/index.html").
		const logged = JSON.stringify(consoleErrorSpy.mock.calls);
		expect(logged).toContain(fixture.pluginVersionId);
		expect(logged).toContain("dist/frontend/index.html");
		expect(logged).not.toContain("plugins/gallery");
	});
});
