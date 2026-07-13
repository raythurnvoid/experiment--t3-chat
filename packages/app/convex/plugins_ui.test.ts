import { R2 } from "@convex-dev/r2";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { files_nodes_db_create_node_recursively_at_path } from "./files_nodes.ts";
import { r2_get_bucket } from "./r2.ts";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import { crypto_sha256_hex } from "../server/crypto-utils.ts";
import { plugins_validate_manifest, type plugins_Capability } from "../shared/plugins.ts";

const r2Objects = new Map<string, string>();

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
	const registered = await t.action(internal.plugins.register_plugin_version, {
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

// Direct seeding sidesteps the per-user files_tree_write rate limit (capacity 2 per test user).
async function seed_upload_node(
	t: ReturnType<typeof test_convex>,
	fixture: Awaited<ReturnType<typeof install_gallery_plugin>>,
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

	test("tolerates the legacy empty pages array", () => {
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

	test("issues a download url whose ttl is clamped to the session expiry", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);
		const seeded = await seed_upload_node(t, fixture, { filename: "photo.png", contentType: "image/png" });
		await t.run((ctx) => ctx.db.patch("files_r2_assets", seeded.assetId, { r2Key: "test/photo.png" }));

		// The session has 45 seconds left and the URL ceiling is 15 minutes: the shorter session expiry must win.
		const token = await seed_session_token(t, fixture, "4", { expiresInMs: 45_000 });
		const response = await t.fetch("/api/v1/files/download-url", {
			method: "POST",
			headers: auth_headers(token),
			body: JSON.stringify({ fileNodeId: seeded.nodeId, expiresInSeconds: 900 }),
		});
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.url).toContain("https://r2.test/object?key=");
		expect(body.expiresAt).toBeLessThanOrEqual(Date.now() + 46_000);
		// Lower bound: clamped to the session expiry, not squashed to some fixed tiny TTL.
		expect(body.expiresAt).toBeGreaterThan(Date.now() + 30_000);

		// Above the 900s zod ceiling: rejected outright, not clamped.
		const overCeiling = await t.fetch("/api/v1/files/download-url", {
			method: "POST",
			headers: auth_headers(token),
			body: JSON.stringify({ fileNodeId: seeded.nodeId, expiresInSeconds: 901 }),
		});
		expect(overCeiling.status).toBe(400);
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
