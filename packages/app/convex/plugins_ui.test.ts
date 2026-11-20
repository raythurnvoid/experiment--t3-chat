import { R2 } from "@convex-dev/r2";
import { getFunctionName } from "convex/server";
import { importSPKI, jwtVerify } from "jose";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Doc as YDoc, encodeStateAsUpdate } from "yjs";

import { api, components, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import { files_db_yjs_push_update } from "./files_nodes.ts";
import { files_nodes_db_create_node_recursively_at_path } from "./files_nodes_create_db.ts";
import { r2 } from "./r2_client.ts";
import { files_metadata_db_insert_committed, files_metadata_db_write_entries } from "./files_metadata_db.ts";
import { grant_plugin_file_access } from "./plugins.setup.test.ts";
import { public_api_files_query_http } from "./public_api_files_query.ts";
import {
	test_convex,
	test_db_hold_move_slot,
	test_finish_file_index,
	test_finish_saved_scope_jobs,
	test_mocks_fill_db_with,
	test_run_with_flush,
} from "./setup.test.ts";
import { crypto_sha256_hex } from "../server/crypto-utils.ts";
import { files_ROOT_ID, files_u8_to_array_buffer } from "../server/files.ts";
import { files_yjs_doc_update_from_text } from "../shared/files-tiptap.ts";
import { plugins_validate_manifest, type plugins_Capability } from "../shared/plugins.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";
import { files_content_type_index_fields } from "../shared/files.ts";
import { files_metadata_QUERY_FIELDS_MAX, type files_metadata_Entry } from "../shared/files-metadata.ts";
import { plugins_file_grants_db_ensure_pair } from "../server/plugins-file-grants.ts";
import { organizations_membership_lifetimes_db_ensure } from "./organizations_membership_lifetimes.ts";

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
				return body === undefined
					? new Response(null, { status: 404 })
					: new Response(body, { status: 200, headers: { ETag: '"saved-file"' } });
			}
			return new Response(null, { status: 404 });
		}),
	);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.useRealTimers();
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
	uiOutboundOrigins: [],
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

async function register_gallery_plugin(args: {
	t: ReturnType<typeof test_convex>;
	userId: Id<"users">;
	version?: string;
	capabilities?: plugins_Capability[];
	uiOutboundOrigins?: string[];
	pages?: { id: string; title: string; entry: string; navItem: { label: string; icon: string } | null }[];
	fileViews?: { id: string; title: string; entry: string; contentTypes: string[] }[];
}) {
	const { t, userId } = args;

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
		reviewId: null,
		artifactHash: `sha256:${version.replaceAll(".", "0").padEnd(64, "c").slice(0, 64)}`,
		sourceRepositoryUrl: "https://github.com/bonobo/gallery-plugin",
		sourceOwner: "bonobo",
		sourceRepo: "gallery-plugin",
		sourceCommitSha: "1234567890abcdef1234567890abcdef12345678",
		manifestR2Key: `plugins/gallery/${version}/manifest.json`,
		backendEntrypointFile: null,
		configuration: null,
		mounts: [],
		events: [],
		pages: args.pages ?? [
			{
				id: "gallery",
				title: "Gallery",
				entry: "dist/frontend/index.html",
				navItem: { label: "Gallery", icon: "images" },
			},
		],
		fileViews: args.fileViews ?? [],
		capabilities: args.capabilities ?? ["workspace.files.read"],
		outboundOrigins: [],
		uiOutboundOrigins: args.uiOutboundOrigins ?? [],
		mcpServers: [],
		mcpServersFingerprint: "mcp-servers-hash",
		skills: [],
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
		secrets: [],
		endpoints: [],
		userWritableCollections: null,
		sourceFiles: [{ path: "dist/frontend/index.html", rawText: "<!doctype html><title>Gallery</title>" }],
	});
	if (registered._nay) {
		throw new Error(registered._nay.message);
	}
	return registered._yay;
}

async function install_gallery_plugin(
	t: ReturnType<typeof test_convex>,
	args: {
		capabilities?: plugins_Capability[];
		uiOutboundOrigins?: string[];
		fileViews?: { id: string; title: string; entry: string; contentTypes: string[] }[];
		fileConsent?: boolean;
	} = {},
) {
	const membership = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const registered = await register_gallery_plugin({
		t,
		userId: membership.userId,
		capabilities: args.capabilities,
		uiOutboundOrigins: args.uiOutboundOrigins,
		fileViews: args.fileViews,
	});
	const asOwner = t.withIdentity(user_identity(membership.userId));
	const installed = await asOwner.mutation(api.plugins.install_version, {
		membershipId: membership.membershipId,
		pluginVersionId: registered.pluginVersionId,
		acceptedCapabilities: args.capabilities ?? ["workspace.files.read"],
		acceptedOutboundOrigins: [],
		acceptedUiOutboundOrigins: args.uiOutboundOrigins ?? [],
		acceptedMcpServersFingerprint: "mcp-servers-hash",
		acceptedSkillNames: [],
	});
	if (installed._nay) {
		throw new Error(installed._nay.message);
	}
	const { installation, pair } = await t.run(async (ctx) => {
		const installation = (await ctx.db.get("plugins_workspace_installations", installed._yay.installationId))!;
		const member = (await ctx.db.get("organizations_workspaces_users", membership.membershipId))!;
		const pair = await plugins_file_grants_db_ensure_pair(ctx, {
			installation,
			membership: member,
			membershipLifetime: await organizations_membership_lifetimes_db_ensure(ctx, member),
		});
		if (args.fileConsent !== false)
			await ctx.db.insert("plugins_file_consents", {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				pairId: pair._id,
				rootNodeId: null,
				requestedLevel: "read",
				appliedLevel: "read",
				areaEligible: true,
				open: true,
				revision: 1,
				state: "applied",
				endedReason: null,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		return { installation, pair };
	});
	return {
		membership,
		asOwner,
		pluginVersionId: registered.pluginVersionId,
		installationId: installed._yay.installationId,
		serviceAccountId: installation.serviceAccountId,
		filePairId: pair._id,
	};
}

async function mint_session_token(fixture: Awaited<ReturnType<typeof install_gallery_plugin>>) {
	const minted = await fixture.asOwner.action(api.plugins_ui.mint_page_session, {
		membershipId: fixture.membership.membershipId,
		pluginName: "gallery",
	});
	if (minted._nay) {
		throw new Error(minted._nay.message);
	}
	return minted._yay;
}

// A second member with workspace-wide content.read only, so restricted-node checks have someone
// the workspace grant does not cover.
async function seed_reader_member(
	t: ReturnType<typeof test_convex>,
	fixture: Awaited<ReturnType<typeof install_gallery_plugin>>,
) {
	return await t.run(async (ctx) => {
		const now = Date.now();
		const userId = await ctx.db.insert("users", { clerkUserId: "clerk-plugin-ui-reader" });
		const membershipId = await ctx.db.insert("organizations_workspaces_users", {
			organizationId: fixture.membership.organizationId,
			workspaceId: fixture.membership.workspaceId,
			userId,
			active: true,
			pendingOrganizationRemoval: false,
			updatedAt: Date.now(),
			displayName: "",
			sortDisplayName: "",
		});
		const grantId = await ctx.db.insert("access_control_permission_grants", {
			organizationId: fixture.membership.organizationId,
			workspaceId: fixture.membership.workspaceId,
			resourceKind: "workspace",
			resourceId: String(fixture.membership.workspaceId),
			principalKind: "user",
			userId,
			permission: "content.read",
			createdAt: now,
			updatedAt: now,
		});
		const member = (await ctx.db.get("organizations_workspaces_users", membershipId))!;
		const pair = await plugins_file_grants_db_ensure_pair(ctx, {
			installation: (await ctx.db.get("plugins_workspace_installations", fixture.installationId))!,
			membership: member,
			membershipLifetime: await organizations_membership_lifetimes_db_ensure(ctx, member),
		});
		const consentId = await ctx.db.insert("plugins_file_consents", {
			organizationId: fixture.membership.organizationId,
			workspaceId: fixture.membership.workspaceId,
			pairId: pair._id,
			rootNodeId: null,
			requestedLevel: "read",
			appliedLevel: "read",
			areaEligible: true,
			open: true,
			revision: 1,
			state: "applied",
			endedReason: null,
			createdAt: now,
			updatedAt: now,
		});
		return { userId, membershipId, grantId, consentId };
	});
}

async function mint_reader_session(
	t: ReturnType<typeof test_convex>,
	fixture: Awaited<ReturnType<typeof install_gallery_plugin>>,
) {
	const reader = await seed_reader_member(t, fixture);
	const asReader = t.withIdentity(user_identity(reader.userId));
	const minted = await asReader.action(api.plugins_ui.mint_page_session, {
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

async function seed_pending_markdown_node(args: {
	t: ReturnType<typeof test_convex>;
	fixture: Awaited<ReturnType<typeof install_gallery_plugin>>;
	filename: string;
}) {
	const { t, fixture, filename } = args;

	const created = await fixture.asOwner.action(api.files_nodes_content.create_text_node, {
		membershipId: fixture.membership.membershipId,
		parentId: files_ROOT_ID,
		path: filename,
	});
	if (created._nay) throw new Error(created._nay.message);

	const yjsDoc = new YDoc();
	const updated = files_yjs_doc_update_from_text({
		rootKind: "rich_text",
		text: "# Pending materialization\n",
		mut_yjsDoc: yjsDoc,
	});
	if (updated._nay) throw new Error(updated._nay.message);
	await test_run_with_flush(t, async (ctx) =>
		files_db_yjs_push_update(ctx, {
			organizationId: fixture.membership.organizationId,
			workspaceId: fixture.membership.workspaceId,
			userId: fixture.membership.userId,
			nodeId: created._yay.nodeId,
			expectedYjsLastSequenceId: (await ctx.db.get("files_nodes", created._yay.nodeId))!.yjsLastSequenceId!,
			update: files_u8_to_array_buffer(encodeStateAsUpdate(yjsDoc)),
			sessionId: `plugin-ui-ttl-${filename}`,
			rootKind: "rich_text",
			materializeImmediately: false,
		}),
	);
	yjsDoc.destroy();

	return { nodeId: created._yay.nodeId };
}

// Editable downloads sign the newest live version snapshot (there is no current-content object
// in R2). Find the key the signer must have used after the request ran.
async function get_newest_version_snapshot_r2_key(t: ReturnType<typeof test_convex>, nodeId: Id<"files_nodes">) {
	return await t.run(async (ctx) => {
		const snapshots = (await ctx.db.query("files_snapshots").collect()).filter(
			(snapshot) => snapshot.fileNodeId === nodeId && snapshot.archivedAt <= 0,
		);
		const newest = snapshots.sort((a, b) => b._creationTime - a._creationTime)[0];
		const asset = newest ? await ctx.db.get("files_r2_assets", newest.assetId) : null;
		if (!asset?.r2Key) throw new Error("Expected a version snapshot asset key");
		return asset.r2Key;
	});
}

// Direct seeding sidesteps the per-user files_tree_write rate limit (capacity 2 per test user).
async function seed_upload_node(args: {
	t: ReturnType<typeof test_convex>;
	fixture: {
		membership: {
			organizationId: Id<"organizations">;
			workspaceId: Id<"organizations_workspaces">;
			userId: Id<"users">;
		};
	};
	filename: string;
	contentType: string;
}) {
	const { t, fixture } = args;

	return await test_run_with_flush(t, async (ctx) => {
		const now = Date.now();
		const assetId = await ctx.db.insert("files_r2_assets", {
			organizationId: fixture.membership.organizationId,
			workspaceId: fixture.membership.workspaceId,
			kind: "upload",
			r2Bucket: r2.config.bucket,
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
async function seed_sibling_gallery_installation(args: {
	ctx: MutationCtx;
	fixture: Awaited<ReturnType<typeof install_gallery_plugin>>;
	name: string;
}) {
	const { ctx, fixture, name } = args;

	const { _id, _creationTime, ...version } = (await ctx.db.get("plugins_versions", fixture.pluginVersionId))!;
	const original = (await ctx.db.get("plugins_workspace_installations", fixture.installationId))!;
	const { _id: installationId, _creationTime: installationTime, ...installation } = original;
	const pluginVersionId = await ctx.db.insert("plugins_versions", { ...version, name, isLatest: false });
	await ctx.db.insert("plugins_service_account_bindings", {
		organizationId: installation.organizationId,
		workspaceId: installation.workspaceId,
		pluginName: name,
		publisherUserId: version.createdBy,
		sourceRepositoryUrl: version.sourceRepositoryUrl,
		serviceAccountId: installation.serviceAccountId,
	});
	const id = await ctx.db.insert("plugins_workspace_installations", {
		...installation,
		pluginName: name,
		pluginVersionId,
	});
	const sibling = (await ctx.db.get("plugins_workspace_installations", id))!;
	const member = (await ctx.db.get("organizations_workspaces_users", fixture.membership.membershipId))!;
	const pair = await plugins_file_grants_db_ensure_pair(ctx, {
		installation: sibling,
		membership: member,
		membershipLifetime: await organizations_membership_lifetimes_db_ensure(ctx, member),
	});
	return { ...sibling, filePairId: pair._id };
}

async function seed_session_token(args: {
	t: ReturnType<typeof test_convex>;
	fixture: Awaited<ReturnType<typeof install_gallery_plugin>>;
	tokenSeed: string;
	expiresInMs?: number;
}) {
	const { t, fixture, tokenSeed } = args;

	const token = `plu_${tokenSeed.repeat(64).slice(0, 64)}`;
	await t.run(async (ctx) => {
		const now = Date.now();
		await ctx.db.insert("plugins_ui_sessions", {
			serviceAccountId: fixture.serviceAccountId,
			organizationId: fixture.membership.organizationId,
			workspaceId: fixture.membership.workspaceId,
			installationId: fixture.installationId,
			pluginVersionId: fixture.pluginVersionId,
			userId: fixture.membership.userId,
			filePairId: fixture.filePairId,
			tokenHash: await crypto_sha256_hex(token),
			createdAt: now,
			expiresAt: now + (args.expiresInMs ?? 30 * 60 * 1000),
		});
	});
	return token;
}

// Default to the frame's own origin, derived from the env exactly like the handler derives it.
async function exchange_session_jwt(args: { t: ReturnType<typeof test_convex>; token: string; origin?: string }) {
	const { t, origin, token } = args;

	return await t.fetch("/plugins-ui/session-jwt", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Origin: origin ?? new URL(process.env.VITE_CONVEX_HTTP_URL!).origin,
		},
		body: JSON.stringify({ token }),
	});
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

describe("plugin ui manifest file views", () => {
	test("accepts a frontend-only manifest with file views", () => {
		const manifest = {
			...gallery_manifest_base,
			fileViews: [
				{
					id: "player",
					title: "Video player",
					entry: "dist/frontend/index.html",
					contentTypes: ["video/mp4", "video/webm"],
				},
			],
		};

		expect(plugins_validate_manifest(manifest)).toMatchObject({ _yay: expect.any(Object) });
	});

	test("accepts an empty file views array", () => {
		expect(plugins_validate_manifest({ ...gallery_manifest_base, fileViews: [] })).toMatchObject({
			_yay: expect.any(Object),
		});
	});

	test("rejects duplicate file view ids", () => {
		const manifest = {
			...gallery_manifest_base,
			fileViews: [
				{ id: "player", title: "Video player", entry: "dist/frontend/index.html", contentTypes: ["video/mp4"] },
				{ id: "player", title: "Player again", entry: "dist/frontend/index.html", contentTypes: ["video/webm"] },
			],
		};

		expect(plugins_validate_manifest(manifest)).toMatchObject({
			_nay: { message: 'Plugin manifest has duplicate file view id "player"' },
		});
	});

	test("rejects a file view id that collides with a page id", () => {
		const manifest = {
			...gallery_manifest_base,
			pages: [{ id: "player", title: "Player page", entry: "dist/frontend/index.html" }],
			fileViews: [
				{ id: "player", title: "Video player", entry: "dist/frontend/index.html", contentTypes: ["video/mp4"] },
			],
		};

		expect(plugins_validate_manifest(manifest)).toMatchObject({
			_nay: { message: 'Plugin manifest has duplicate file view id "player"' },
		});
	});

	test("rejects a file view entry that is not a listed file", () => {
		const manifest = {
			...gallery_manifest_base,
			fileViews: [
				{ id: "player", title: "Video player", entry: "dist/frontend/missing.html", contentTypes: ["video/mp4"] },
			],
		};

		expect(plugins_validate_manifest(manifest)).toMatchObject({
			_nay: { message: 'Plugin file view "player" entry must be a listed file' },
		});
	});

	test("rejects a file view entry that is not text/html", () => {
		const manifest = {
			...gallery_manifest_base,
			fileViews: [
				{
					id: "player",
					title: "Video player",
					entry: "dist/frontend/assets/index.js",
					contentTypes: ["video/mp4"],
				},
			],
		};

		expect(plugins_validate_manifest(manifest)).toMatchObject({
			_nay: { message: 'Plugin file view "player" entry must be a text/html file' },
		});
	});
});

describe("personal file session pins", () => {
	test("pins new page and file-view sessions without creating consent", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t, {
			fileViews: [{ id: "player", title: "Player", entry: "dist/frontend/index.html", contentTypes: ["video/mp4"] }],
			fileConsent: false,
		});
		const page = await fixture.asOwner.mutation(internal.plugins_ui.insert_page_session, {
			membershipId: fixture.membership.membershipId,
			pluginName: "gallery",
		});
		const upload = await seed_upload_node({ t, fixture, filename: "pin.mp4", contentType: "video/mp4" });
		const view = await fixture.asOwner.mutation(internal.plugins_ui.insert_file_view_session, {
			membershipId: fixture.membership.membershipId,
			pluginName: "gallery",
			fileViewId: "player",
			fileNodeId: upload.nodeId,
		});
		expect(page._nay).toBeUndefined();
		expect(view._nay).toBeUndefined();
		const docs = await t.run(async (ctx) => ({
			page: await ctx.db.get("plugins_ui_sessions", page._yay!.sessionId),
			view: await ctx.db.get("plugins_ui_sessions", view._yay!.sessionId),
			consents: await ctx.db.query("plugins_file_consents").collect(),
		}));
		expect(docs.page?.filePairId, "a new personal page must pin its pair").toBeDefined();
		expect(docs.view?.filePairId, "a file view must use the same person's pair").toBe(docs.page?.filePairId);
		expect(docs.consents, "minting does not grant any file").toEqual([]);
	});

	test("refresh keeps its pair and refuses a later membership lifetime", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);
		const session = await mint_session_token(fixture);
		const original = await t.run((ctx) => ctx.db.get("plugins_ui_sessions", session.sessionId));
		expect(
			(
				await fixture.asOwner.mutation(internal.plugins_ui.rotate_ui_session, {
					membershipId: fixture.membership.membershipId,
					sessionId: session.sessionId,
				})
			)._nay,
		).toBeUndefined();
		expect((await t.run((ctx) => ctx.db.get("plugins_ui_sessions", session.sessionId)))?.filePairId).toBe(
			original?.filePairId,
		);
		await t.run(async (ctx) => {
			const lifetime = await ctx.db
				.query("organizations_membership_lifetimes")
				.withIndex("by_workspace_user", (q) =>
					q.eq("workspaceId", fixture.membership.workspaceId).eq("userId", fixture.membership.userId),
				)
				.unique();
			await ctx.db.patch("organizations_membership_lifetimes", lifetime!._id, { lifetime: lifetime!.lifetime + 1 });
			// Isolate the lifetime check from the successful refresh above.
			await ctx.runMutation(components.rate_limiter.lib.resetRateLimit, {
				name: "plugins_ui_session_mint",
				key: fixture.membership.userId,
			});
		});
		expect(
			(
				await fixture.asOwner.mutation(internal.plugins_ui.rotate_ui_session, {
					membershipId: fixture.membership.membershipId,
					sessionId: session.sessionId,
				})
			)._nay?.message,
			"refresh must not adopt the new membership lifetime",
		).toBe("Unauthorized");
	});
});

describe("plugin ui sessions", () => {
	test("registers a frontend-only version with pages persisted", async () => {
		const t = test_convex();
		const membership = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const registered = await register_gallery_plugin({ t, userId: membership.userId });

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

		const pages = await fixture.asOwner.query(api.plugins_ui_installed.list_ui_pages, {
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
						hasAgent: false,
					},
				],
			},
		]);

		await t.run((ctx) =>
			ctx.db.patch("plugins_workspace_installations", fixture.installationId, { status: "disabled" }),
		);
		const afterDisable = await fixture.asOwner.query(api.plugins_ui_installed.list_ui_pages, {
			membershipId: fixture.membership.membershipId,
		});
		expect(afterDisable).toEqual([]);
	});

	test("a guest still cannot open a plugin page", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);
		const member = await seed_reader_member(t, fixture);
		const asMember = t.withIdentity(user_identity(member.userId));
		const list = () => asMember.query(api.plugins_ui_installed.list_ui_pages, { membershipId: member.membershipId });
		// The same member with workspace read sees the page, so the refusals below come from the guest.
		expect(await list()).toHaveLength(1);

		// Without workspace read the member is a guest. A guest gets no plugins.
		await t.run((ctx) => ctx.db.delete("access_control_permission_grants", member.grantId));
		expect(await list()).toEqual([]);
		expect(
			await asMember.action(api.plugins_ui.mint_page_session, {
				membershipId: member.membershipId,
				pluginName: "gallery",
			}),
		).toMatchObject({ _nay: { message: "Permission denied" } });
	});

	test("a plugin-session identity cannot mint sessions or list pages", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);

		const minted = await fixture.asOwner.action(api.plugins_ui.mint_page_session, {
			membershipId: fixture.membership.membershipId,
			pluginName: "gallery",
		});
		if (minted._nay) throw new Error(minted._nay.message);

		// A leaked plugin JWT must not mint more sessions or reach member functions. The subject
		// is a real session id, so only the issuer separates this identity from a member's.
		const asPluginSession = t.withIdentity({
			issuer: `${process.env.VITE_CONVEX_HTTP_URL!}/plugins-ui`,
			subject: minted._yay.sessionId,
		});

		const remint = await asPluginSession.action(api.plugins_ui.mint_page_session, {
			membershipId: fixture.membership.membershipId,
			pluginName: "gallery",
		});
		expect(remint).toMatchObject({ _nay: { message: "Unauthenticated" } });

		const pages = await asPluginSession.query(api.plugins_ui_installed.list_ui_pages, {
			membershipId: fixture.membership.membershipId,
		});
		expect(pages).toEqual([]);
	});

	test("excludes pages-less versions from list_ui_pages and mint_page_session", async () => {
		const t = test_convex();
		const membership = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const registered = await register_gallery_plugin({ t, userId: membership.userId, pages: [] });
		const asOwner = t.withIdentity(user_identity(membership.userId));
		const installed = await asOwner.mutation(api.plugins.install_version, {
			membershipId: membership.membershipId,
			pluginVersionId: registered.pluginVersionId,
			acceptedCapabilities: ["workspace.files.read"],
			acceptedOutboundOrigins: [],
			acceptedUiOutboundOrigins: [],
			acceptedMcpServersFingerprint: "mcp-servers-hash",
			acceptedSkillNames: [],
		});
		expect(installed._nay).toBeUndefined();

		const pages = await asOwner.query(api.plugins_ui_installed.list_ui_pages, {
			membershipId: membership.membershipId,
		});
		expect(pages).toEqual([]);

		const minted = await asOwner.action(api.plugins_ui.mint_page_session, {
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
				await fixture.asOwner.query(api.plugins_ui_installed.list_ui_pages, {
					membershipId: fixture.membership.membershipId,
				}),
			).toEqual([]);
			expect(
				await fixture.asOwner.action(api.plugins_ui.mint_page_session, {
					membershipId: fixture.membership.membershipId,
					pluginName: "gallery",
				}),
			).toMatchObject({ _nay: { message: "Not found" } });
		}
	});

	test("minted token lists and reads files but can never write", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);
		await seed_upload_node({ t, fixture, filename: "photo.png", contentType: "image/png" });

		const session = await mint_session_token(fixture);
		expect(session.token).toMatch(/^plu_[0-9a-f]{64}$/u);
		const installation = await t.run((ctx) => ctx.db.get("plugins_workspace_installations", fixture.installationId));
		const storedSession = await t.run((ctx) => ctx.db.get("plugins_ui_sessions", session.sessionId));
		expect(storedSession?.serviceAccountId).toBeDefined();
		expect(storedSession?.serviceAccountId).toBe(installation?.serviceAccountId);

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

	test("mint and refresh keep removed grants absent", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);
		const installation = await t.run((ctx) => ctx.db.get("plugins_workspace_installations", fixture.installationId));
		if (!installation?.serviceAccountId) {
			throw new Error("Expected installation account");
		}
		await t.run(async (ctx) => {
			const grants = await ctx.db.query("access_control_permission_grants").collect();
			for (const grant of grants) {
				if (grant.principalKind === "service_account") {
					await ctx.db.delete("access_control_permission_grants", grant._id);
				}
			}
		});

		const session = await mint_session_token(fixture);
		expect(
			(
				await fixture.asOwner.action(api.plugins_ui.refresh_ui_session, {
					membershipId: fixture.membership.membershipId,
					sessionId: session.sessionId,
				})
			)._nay,
		).toBeUndefined();
		expect(await t.run((ctx) => ctx.db.get("plugins_ui_sessions", session.sessionId))).toMatchObject({
			serviceAccountId: installation.serviceAccountId,
		});
		expect(await t.run((ctx) => ctx.db.get("plugins_workspace_installations", fixture.installationId))).toMatchObject({
			serviceAccountId: installation.serviceAccountId,
		});
		expect(await t.run((ctx) => ctx.db.query("access_control_service_accounts").collect())).toHaveLength(1);
		expect(await t.run((ctx) => ctx.db.query("access_control_permission_grants").collect())).toEqual([]);
	});

	test("revocation and rebind cannot rotate an old session into the replacement account", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);
		const session = await mint_session_token(fixture);
		const original = await t.run((ctx) => ctx.db.get("plugins_ui_sessions", session.sessionId));
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10_000);
		expect(
			(
				await fixture.asOwner.mutation(api.access_control.revoke_service_account, {
					membershipId: fixture.membership.membershipId,
					serviceAccountId: fixture.serviceAccountId,
				})
			)._nay,
		).toBeUndefined();
		expect(
			(
				await fixture.asOwner.action(api.plugins_ui.mint_page_session, {
					membershipId: fixture.membership.membershipId,
					pluginName: "gallery",
				})
			)._nay?.message,
		).toBe("Not found");
		const replacement = await fixture.asOwner.mutation(api.access_control.create_service_account, {
			membershipId: fixture.membership.membershipId,
			name: "Replacement",
		});
		if (replacement._nay) {
			throw new Error(replacement._nay.message);
		}
		expect(
			(
				await fixture.asOwner.mutation(api.plugins.set_installation_service_account, {
					membershipId: fixture.membership.membershipId,
					installationId: fixture.installationId,
					serviceAccountId: replacement._yay.serviceAccountId,
				})
			)._nay,
		).toBeUndefined();
		expect(
			(
				await fixture.asOwner.action(api.plugins_ui.refresh_ui_session, {
					membershipId: fixture.membership.membershipId,
					sessionId: session.sessionId,
				})
			)._nay,
		).toBeDefined();
		expect(await t.run((ctx) => ctx.db.get("plugins_ui_sessions", session.sessionId))).toEqual(original);
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10_000);
		const next = await mint_session_token(fixture);
		expect(await t.run((ctx) => ctx.db.get("plugins_ui_sessions", next.sessionId))).toMatchObject({
			serviceAccountId: replacement._yay.serviceAccountId,
		});
	});

	test("refreshes one session in place, invalidates the old token, and revokes the current token", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);
		const initial = await mint_session_token(fixture);
		const initialSession = await t.run((ctx) => ctx.db.get("plugins_ui_sessions", initial.sessionId));
		const list_with = (token: string) =>
			t.fetch("/api/v1/files/list", {
				method: "POST",
				headers: auth_headers(token),
				body: JSON.stringify({ recursive: true }),
			});

		const refreshed = await fixture.asOwner.action(api.plugins_ui.refresh_ui_session, {
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
		expect(sessionsAfterRefresh[0]?.serviceAccountId).toBe(initialSession?.serviceAccountId);

		const revoked = await fixture.asOwner.mutation(api.plugins_ui.revoke_ui_session, {
			membershipId: fixture.membership.membershipId,
			sessionId: initial.sessionId,
		});
		expect(revoked._nay).toBeUndefined();
		expect((await list_with(refreshed._yay.token)).status).toBe(401);
	});

	test("a member cannot refresh another member's session and take it over", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);
		const owned = await mint_session_token(fixture);
		// A second member of the SAME workspace. Every other check on the refresh path compares only
		// the organization and the workspace, which both members satisfy, so the owner check is the
		// only thing standing between them.
		const reader = await seed_reader_member(t, fixture);
		const asReader = t.withIdentity(user_identity(reader.userId));

		const stolen = await asReader.action(api.plugins_ui.refresh_ui_session, {
			membershipId: reader.membershipId,
			sessionId: owned.sessionId,
		});
		expect(stolen._nay?.message).toBe("Unauthorized");

		// Why this refusal is the whole check: the refresh rotates the token on the SAME session doc
		// and never rewrites its userId, so a token minted here would still resolve as the owner and
		// read files with the owner's permissions.
		const session = await t.run((ctx) => ctx.db.get("plugins_ui_sessions", owned.sessionId));
		expect(session?.userId).toEqual(fixture.membership.userId);
		const listed = await t.fetch("/api/v1/files/list", {
			method: "POST",
			headers: auth_headers(owned.token),
			body: JSON.stringify({ recursive: true }),
		});
		expect(listed.status).toBe(200);
	});

	test("a member cannot revoke another member's session", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);
		const owned = await mint_session_token(fixture);
		const reader = await seed_reader_member(t, fixture);
		const asReader = t.withIdentity(user_identity(reader.userId));

		const revoked = await asReader.mutation(api.plugins_ui.revoke_ui_session, {
			membershipId: reader.membershipId,
			sessionId: owned.sessionId,
		});
		expect(revoked._nay?.message).toBe("Unauthorized");

		// Revocation is idempotent for a session that is already gone, so a missing owner check would
		// read as success here and close a frame the caller does not own.
		const sessions = await t.run((ctx) => ctx.db.query("plugins_ui_sessions").collect());
		expect(sessions).toHaveLength(1);
		const listed = await t.fetch("/api/v1/files/list", {
			method: "POST",
			headers: auth_headers(owned.token),
			body: JSON.stringify({ recursive: true }),
		});
		expect(listed.status).toBe(200);
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
			const sibling = await seed_sibling_gallery_installation({ ctx, fixture, name: "gallery-copy" });
			const installationId = sibling._id;
			await ctx.db.insert("plugins_ui_sessions", {
				serviceAccountId: sibling.serviceAccountId,
				organizationId: fixture.membership.organizationId,
				workspaceId: fixture.membership.workspaceId,
				installationId,
				pluginVersionId: sibling.pluginVersionId,
				userId: fixture.membership.userId,
				filePairId: sibling.filePairId,
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

		// Freeze the clock so a slow machine cannot refill the 20-call budget.
		vi.useFakeTimers({ toFake: ["Date"] });
		for (let call = 0; call < 20; call += 1) {
			expect((await list_with(call % 2 === 0 ? first.token : second.token)).status).toBe(200);
		}
		expect((await list_with(second.token)).status).toBe(429);

		const separateRoute = await t.fetch("/api/v1/files/read", {
			method: "POST",
			headers: auth_headers(first.token),
			body: JSON.stringify({ path: "/missing.md" }),
		});
		expect(separateRoute.status).toBe(404);
	});

	test("pages a sparse content type filter from its index", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);
		// 40 non-matching files sort first. A scan of 8 rounds of `limit` (2) rows reads only 16 rows here,
		// so it would return an empty page.
		const files = [
			...Array.from({ length: 40 }, (_, index) => [`a-${String(index).padStart(2, "0")}.md`, "text/markdown"] as const),
			["z-photo.png", "image/png"] as const,
			["z-video.mp4", "video/mp4"] as const,
		];
		await test_run_with_flush(t, async (ctx) => {
			const now = Date.now();
			for (const [name, contentType] of files) {
				await ctx.db.insert("files_nodes", {
					organizationId: fixture.membership.organizationId,
					workspaceId: fixture.membership.workspaceId,
					pendingContentVersion: 1,
					path: `/${name}`,
					treePath: `/${name}`,
					pathDepth: 1,
					lowercaseExtension: name.slice(name.lastIndexOf(".") + 1),
					name,
					sortName: files_sort_text_key(name),
					kind: "file",
					contentType,
					...files_content_type_index_fields(contentType),
					parentId: "root",
					createdBy: fixture.membership.userId,
					updatedBy: fixture.membership.userId,
					updatedAt: now,
					assetId: null,
					contentByteSize: null,
					textKind: null,
					collaborationEnabled: null,
					yjsSnapshotId: null,
					yjsLastSequenceId: null,
					statsId: null,
					contentTooLargeByteSize: null,
					contentShapeMismatchAt: null,
					contentYjsStateTooLargeByteSize: null,
					restrictedScopeNodeId: null,
					extendedScopeNodeId: null,
					isRestrictedScopeRoot: false,
					readOnly: false,
					readOnlyDecisionId: null,
					archiveOperationId: null,
				});
			}
		});

		const session = await mint_session_token(fixture);
		const response = await t.fetch("/api/v1/files/list", {
			method: "POST",
			headers: auth_headers(session.token),
			// Both index kinds. " IMAGE/png" is cleaned up, and its row also matches "image/" but is listed once.
			body: JSON.stringify({
				recursive: true,
				kind: "file",
				limit: 2,
				contentTypePrefixes: ["image/", " IMAGE/png", "video/mp4"],
			}),
		});
		expect(response.status).toBe(200);
		const body = await response.json();

		expect(
			body.items.map((item: { name: string }) => item.name),
			"the first page holds both media files past 40 non-matching files",
		).toEqual(["z-photo.png", "z-video.mp4"]);
		expect(body.isDone, "both type streams end on the first page").toBe(true);
	});

	test("issues download urls whose ttl is clamped to the session expiry", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);
		const seeded = await seed_upload_node({ t, fixture, filename: "photo.png", contentType: "image/png" });
		await t.run((ctx) => ctx.db.patch("files_r2_assets", seeded.assetId, { r2Key: "test/photo.png" }));

		// The session has 45 seconds left and the URL ceiling is 15 minutes: the shorter session expiry must win.
		const token = await seed_session_token({ t, fixture, tokenSeed: "4", expiresInMs: 45_000 });
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
		const pending = await seed_pending_markdown_node({ t, fixture, filename: "download.md" });
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
		const versionSnapshotR2Key = await get_newest_version_snapshot_r2_key(t, pending.nodeId);
		const call = signerCalls.slice(callsBeforeRelease).findLast(({ key }) => key === versionSnapshotR2Key);
		expect(call?.expiresIn).toBe(1);
		const body = await response.json();
		const expiresAt = body.items[0].expiresAt;
		expect(expiresAt).toBeLessThanOrEqual(now + 1_000);
		expect(expiresAt).toBeLessThanOrEqual(authorityExpiresAt);
	});

	test("pins the stored content type and an inline filename into signed download urls", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);
		const seeded = await seed_upload_node({ t, fixture, filename: "it's clip video.mp4", contentType: "video/mp4" });
		await t.run((ctx) => ctx.db.patch("files_r2_assets", seeded.assetId, { r2Key: "test/clip.mp4" }));
		const session = await mint_session_token(fixture);
		const signerCalls: Array<{ key: string; options: Record<string, unknown> | undefined }> = [];
		vi.spyOn(R2.prototype, "getUrl").mockImplementation(async (key: string, options?: Record<string, unknown>) => {
			signerCalls.push({ key, options });
			return `https://r2.test/object?key=${encodeURIComponent(key)}`;
		});

		const response = await t.fetch("/api/v1/files/download-urls", {
			method: "POST",
			headers: auth_headers(session.token),
			body: JSON.stringify({ fileNodeIds: [seeded.nodeId] }),
		});
		expect(response.status).toBe(200);

		// Upload content types are client-supplied, so the response headers must be part of the
		// signed request. The space proves the RFC 5987 encoding runs, and the apostrophe proves the
		// extra escaping runs: encodeURIComponent leaves ' raw, which would corrupt the header.
		const call = signerCalls.find(({ key }) => key === "test/clip.mp4");
		expect(call?.options).toMatchObject({
			responseContentType: "video/mp4",
			responseContentDisposition: "inline; filename*=UTF-8''it%27s%20clip%20video.mp4",
		});
	});

	test("pins an attachment filename for an explicit media download", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);
		const seeded = await seed_upload_node({ t, fixture, filename: "it's photo.png", contentType: "image/png" });
		await t.run((ctx) => ctx.db.patch("files_r2_assets", seeded.assetId, { r2Key: "test/photo.png" }));
		const session = await mint_session_token(fixture);
		const signerCalls: Array<{ key: string; options: Record<string, unknown> | undefined }> = [];
		vi.spyOn(R2.prototype, "getUrl").mockImplementation(async (key: string, options?: Record<string, unknown>) => {
			signerCalls.push({ key, options });
			return `https://r2.test/object?key=${encodeURIComponent(key)}`;
		});

		const response = await t.fetch("/api/v1/files/download-urls", {
			method: "POST",
			headers: auth_headers(session.token),
			body: JSON.stringify({ fileNodeIds: [seeded.nodeId], download: true }),
		});
		expect(response.status).toBe(200);
		expect(signerCalls.find(({ key }) => key === "test/photo.png")?.options).toMatchObject({
			responseContentType: "image/png",
			responseContentDisposition: "attachment; filename*=UTF-8''it%27s%20photo.png",
		});
	});

	test("refuses a non-boolean download option before signing", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);
		const seeded = await seed_upload_node({ t, fixture, filename: "photo.png", contentType: "image/png" });
		await t.run((ctx) => ctx.db.patch("files_r2_assets", seeded.assetId, { r2Key: "test/photo.png" }));
		const session = await mint_session_token(fixture);
		const signer = vi.spyOn(R2.prototype, "getUrl");

		const response = await t.fetch("/api/v1/files/download-urls", {
			method: "POST",
			headers: auth_headers(session.token),
			body: JSON.stringify({ fileNodeIds: [seeded.nodeId], download: "true" }),
		});
		expect(response.status).toBe(400);
		expect(signer).not.toHaveBeenCalled();
	});

	test("mints batch download URLs with per-id errors", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);
		const first = await seed_upload_node({ t, fixture, filename: "one.png", contentType: "image/png" });
		const second = await seed_upload_node({ t, fixture, filename: "two.png", contentType: "image/png" });
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
		expect(body.errors).toEqual([{ fileNodeId: "not-a-real-node-id", message: "Not found", errorCode: "not_found" }]);
		expect(body.truncated).toBe(false);
	});

	test("suppresses signed urls when personal View consent is revoked during signing", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);
		const seeded = await seed_upload_node({ t, fixture, filename: "photo.png", contentType: "image/png" });
		await t.run((ctx) => ctx.db.patch("files_r2_assets", seeded.assetId, { r2Key: "test/photo.png" }));
		const reader = await mint_reader_session(t, fixture);
		const positive = await t.fetch("/api/v1/files/download-urls", {
			method: "POST",
			headers: auth_headers(reader.session.token),
			body: JSON.stringify({ fileNodeIds: [seeded.nodeId] }),
		});
		expect(positive.status).toBe(200);
		expect(await positive.json()).toMatchObject({
			items: [{ fileNodeId: seeded.nodeId, url: expect.any(String) }],
			errors: [],
		});
		const signing = defer_download_urls();

		const responsePromise = t.fetch("/api/v1/files/download-urls", {
			method: "POST",
			headers: auth_headers(reader.session.token),
			body: JSON.stringify({ fileNodeIds: [seeded.nodeId] }),
		});
		await signing.started;
		expect(
			await t.withIdentity(user_identity(reader.userId)).mutation(api.plugins_access.revoke_file_access_as_me, {
				membershipId: reader.membershipId,
				installationId: fixture.installationId,
				consentId: reader.consentId,
			}),
		).toEqual({ _yay: null });
		signing.release();

		const response = await responsePromise;
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ message: "Permission denied", errorCode: "permission_denied" });
	});

	test("suppresses every batch url when its session expires during signing", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);
		const first = await seed_upload_node({ t, fixture, filename: "one.png", contentType: "image/png" });
		const second = await seed_upload_node({ t, fixture, filename: "two.png", contentType: "image/png" });
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
		expect(await response.json()).toEqual({ message: "Unauthenticated", errorCode: "unauthenticated" });
	});

	test.each([
		"membership removed",
		"installation disabled",
		"installation uninstalled",
		"installation upgraded",
	] as const)("suppresses batch urls when the %s during signing", async (change) => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);
		const seeded = await seed_upload_node({ t, fixture, filename: "photo.png", contentType: "image/png" });
		await t.run((ctx) => ctx.db.patch("files_r2_assets", seeded.assetId, { r2Key: "test/photo.png" }));
		const session = await mint_session_token(fixture);
		const nextVersion =
			change === "installation upgraded"
				? await register_gallery_plugin({ t, userId: fixture.membership.userId, version: "0.2.0" })
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
		expect(await response.json()).toEqual({ message: "Unauthenticated", errorCode: "unauthenticated" });
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
		expect(oversizedBody.status).toBe(413);
		expect(await oversizedBody.json()).toEqual({
			message: "Request body is too large",
			errorCode: "request_too_large",
		});

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
		expect(streamedBody.status).toBe(413);
		expect(await streamedBody.json()).toEqual({ message: "Request body is too large", errorCode: "request_too_large" });
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
		expect(await duplicate.json()).toEqual({ message: "fileNodeIds must be unique", errorCode: "invalid_input" });
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
		const local = await seed_upload_node({ t, fixture, filename: "local.png", contentType: "image/png" });
		const foreignMembership = await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, {
				organizationName: "foreign-organization",
				workspaceName: "foreign-workspace",
			}),
		);
		const foreign = await seed_upload_node({
			t,
			fixture: { membership: foreignMembership },
			filename: "foreign.png",
			contentType: "image/png",
		});
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
		expect(body.errors).toEqual([{ fileNodeId: foreign.nodeId, message: "Not found", errorCode: "not_found" }]);
		expect(JSON.stringify(body)).not.toContain("test/foreign.png");
	});

	test("returns 403 when a plugin page reads stored bytes", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);
		const seeded = await seed_upload_node({ t, fixture, filename: "photo.png", contentType: "image/png" });
		await t.run((ctx) => ctx.db.patch("files_r2_assets", seeded.assetId, { r2Key: "test/photo.png" }));
		const session = await mint_session_token(fixture);

		const response = await t.fetch("/api/v1/files/read", {
			method: "POST",
			headers: auth_headers(session.token),
			body: JSON.stringify({ path: "/photo.png" }),
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

		const disabled = await seed_session_token({ t, fixture, tokenSeed: "1" });
		await t.run((ctx) =>
			ctx.db.patch("plugins_workspace_installations", fixture.installationId, { status: "disabled" }),
		);
		expect((await list_with(disabled)).status).toBe(401);
		await t.run((ctx) =>
			ctx.db.patch("plugins_workspace_installations", fixture.installationId, { status: "enabled" }),
		);

		const upgraded = await seed_session_token({ t, fixture, tokenSeed: "2" });
		const nextVersion = await register_gallery_plugin({ t, userId: fixture.membership.userId, version: "0.2.0" });
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

		const expired = await seed_session_token({ t, fixture, tokenSeed: "3" });
		await t.run(async (ctx) => {
			const sessions = await ctx.db.query("plugins_ui_sessions").collect();
			await Promise.all(
				sessions.map((session) => ctx.db.patch("plugins_ui_sessions", session._id, { expiresAt: Date.now() - 1000 })),
			);
		});
		expect((await list_with(expired)).status).toBe(401);
	});

	test("uninstall revokes an unbounded session set and drains it in installation-scoped pages", async () => {
		const t = test_convex({ transactionLimits: { bytesRead: 120_000 } });
		const fixture = await install_gallery_plugin(t);
		const siblingInstallationId = await t.run(async (ctx) => {
			const now = Date.now();
			const sibling = await seed_sibling_gallery_installation({ ctx, fixture, name: "gallery-sibling" });
			const installationId = sibling._id;
			for (let index = 0; index < 300; index += 1) {
				await ctx.db.insert("plugins_ui_sessions", {
					serviceAccountId: fixture.serviceAccountId,
					organizationId: fixture.membership.organizationId,
					workspaceId: fixture.membership.workspaceId,
					installationId: fixture.installationId,
					pluginVersionId: fixture.pluginVersionId,
					userId: fixture.membership.userId,
					filePairId: fixture.filePairId,
					tokenHash: `${"t".repeat(64)}-${index}`,
					createdAt: now,
					expiresAt: now + 30 * 60 * 1000,
				});
			}
			for (let index = 0; index < 3; index += 1) {
				await ctx.db.insert("plugins_ui_sessions", {
					serviceAccountId: sibling.serviceAccountId,
					organizationId: fixture.membership.organizationId,
					workspaceId: fixture.membership.workspaceId,
					installationId,
					pluginVersionId: sibling.pluginVersionId,
					userId: fixture.membership.userId,
					filePairId: sibling.filePairId,
					tokenHash: `${"s".repeat(64)}-${index}`,
					createdAt: now,
					expiresAt: now + 30 * 60 * 1000,
				});
			}
			return installationId;
		});

		// This proves the old uninstall-time collect cannot fit under this test's transaction limit.
		await expect(
			t.run((ctx) =>
				ctx.db
					.query("plugins_ui_sessions")
					.withIndex("by_installation", (q) => q.eq("installationId", fixture.installationId))
					.collect(),
			),
		).rejects.toThrow();

		const uninstalled = await fixture.asOwner.mutation(api.plugins.uninstall_version, {
			membershipId: fixture.membership.membershipId,
			installationId: fixture.installationId,
		});
		expect(uninstalled._nay).toBeUndefined();
		expect(await t.run((ctx) => ctx.db.get("plugins_workspace_installations", fixture.installationId))).toBeNull();

		for (const deletedCount of [100, 100, 100, 1, 1]) {
			expect(
				await t.mutation(internal.plugins_data.drain_uninstalled_installation, {
					organizationId: fixture.membership.organizationId,
					workspaceId: fixture.membership.workspaceId,
					installationId: fixture.installationId,
					_test_disableReschedule: true,
				}),
			).toEqual({ done: false, deletedCount });
		}
		expect(
			await t.mutation(internal.plugins_data.drain_uninstalled_installation, {
				organizationId: fixture.membership.organizationId,
				workspaceId: fixture.membership.workspaceId,
				installationId: fixture.installationId,
				_test_disableReschedule: true,
			}),
		).toEqual({ done: true, deletedCount: 0 });

		const remaining = await t.run(async (ctx) => ({
			siblingInstallation: await ctx.db.get("plugins_workspace_installations", siblingInstallationId),
			siblingSessions: await ctx.db
				.query("plugins_ui_sessions")
				.withIndex("by_installation", (q) => q.eq("installationId", siblingInstallationId))
				.collect(),
			targetSession: await ctx.db
				.query("plugins_ui_sessions")
				.withIndex("by_installation", (q) => q.eq("installationId", fixture.installationId))
				.first(),
		}));
		expect(remaining.siblingInstallation?._id).toBe(siblingInstallationId);
		expect(remaining.siblingSessions).toHaveLength(3);
		expect(remaining.targetSession).toBeNull();
	});

	test("cleanup cron deletes expired sessions in batches and keeps live ones", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);
		await seed_session_token({ t, fixture, tokenSeed: "a", expiresInMs: -60_000 });
		await seed_session_token({ t, fixture, tokenSeed: "b", expiresInMs: -60_000 });
		await seed_session_token({ t, fixture, tokenSeed: "c", expiresInMs: -60_000 });
		const live = await seed_session_token({ t, fixture, tokenSeed: "d" });

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

		const minted = await fixture.asOwner.action(api.plugins_ui.mint_page_session, {
			membershipId: fixture.membership.membershipId,
			pluginName: "gallery",
		});
		expect(minted).toMatchObject({ _nay: { message: "Not found" } });
	});

	test("a rate limited page mint answers with the wait the frame shows", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);
		const mint = () =>
			fixture.asOwner.action(api.plugins_ui.mint_page_session, {
				membershipId: fixture.membership.membershipId,
				pluginName: "gallery",
			});

		// `plugins_ui_session_mint` holds two tokens, so the third mint in a burst is refused.
		expect(await mint()).toMatchObject({ _yay: expect.any(Object) });
		expect(await mint()).toMatchObject({ _yay: expect.any(Object) });
		const refused = await mint();
		expect(refused).toMatchObject({ _nay: { message: "Rate limit exceeded" } });
		if (!refused._nay) {
			throw new Error("the third page mint was not refused");
		}

		// The frame turns this number into "Wait N seconds, then press Retry". If the refusal carries
		// no number, the frame shows a fixed 5 seconds instead (`mint_error_message` in
		// `plugins-ui-frame.tsx`), which is a guess and not this bucket's own wait. `retryAfterMs` is
		// optional in the validator, so nothing else catches a refusal that drops it.
		expect(refused._nay.data?.retryAfterMs).toEqual(expect.any(Number));
		expect(refused._nay.data!.retryAfterMs!).toBeGreaterThan(0);
		// The refusal asks for one token, and the bucket refills 12 tokens a minute
		// (`plugins_ui_session_mint` in `rate_limiter.ts`), so the wait is one refill step at most.
		expect(refused._nay.data!.retryAfterMs!).toBeLessThanOrEqual(60_000 / 12);
	});
});

describe("plugin ui file view sessions", () => {
	const video_file_view = {
		id: "player",
		title: "Video player",
		entry: "dist/frontend/index.html",
		contentTypes: ["video/mp4", "video/webm"],
	};

	// A member-role reader: the role covers unrestricted files, while a restricted node answers only
	// from grants on its scope node, so restricting a node cuts this reader out.
	async function seed_member_reader(
		t: ReturnType<typeof test_convex>,
		fixture: Awaited<ReturnType<typeof install_gallery_plugin>>,
	) {
		return await t.run(async (ctx) => {
			const now = Date.now();
			const userId = await ctx.db.insert("users", { clerkUserId: "clerk-plugin-ui-member" });
			const membershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: fixture.membership.organizationId,
				workspaceId: fixture.membership.workspaceId,
				userId,
				active: true,
				pendingOrganizationRemoval: false,
				updatedAt: Date.now(),
				displayName: "",
				sortDisplayName: "",
			});
			await access_control_db_ensure_role_assignment(ctx, {
				organizationId: fixture.membership.organizationId,
				workspaceId: fixture.membership.workspaceId,
				userId,
				role: "member",
				now,
			});
			return { userId, membershipId };
		});
	}

	async function mint_file_view(
		fixture: Awaited<ReturnType<typeof install_gallery_plugin>>,
		args: { fileViewId?: string; fileNodeId: Id<"files_nodes"> },
	) {
		return await fixture.asOwner.action(api.plugins_ui.mint_file_view_session, {
			membershipId: fixture.membership.membershipId,
			pluginName: "gallery",
			fileViewId: args.fileViewId ?? "player",
			fileNodeId: args.fileNodeId,
		});
	}

	test("lists file views with the installation creation time and mints a working session", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t, { fileViews: [video_file_view] });
		const seeded = await seed_upload_node({ t, fixture, filename: "clip.mp4", contentType: "video/mp4" });

		const listed = await fixture.asOwner.query(api.plugins_ui_installed.list_file_views, {
			membershipId: fixture.membership.membershipId,
		});
		// Pin the exact installation creation time: the files UI orders view tabs by this value,
		// so it must be the installation's time, not the version's.
		const installation = await t.run((ctx) => ctx.db.get("plugins_workspace_installations", fixture.installationId));
		expect(listed).toEqual([
			{
				pluginName: "gallery",
				pluginVersionId: fixture.pluginVersionId,
				installationCreatedAt: installation?._creationTime,
				fileViews: [video_file_view],
			},
		]);

		const minted = await mint_file_view(fixture, { fileNodeId: seeded.nodeId });
		if (minted._nay) {
			throw new Error(minted._nay.message);
		}
		expect(minted._yay.token).toMatch(/^plu_[0-9a-f]{64}$/u);
		expect(minted._yay.pluginVersionId).toBe(fixture.pluginVersionId);

		const session = await t.run((ctx) => ctx.db.get("plugins_ui_sessions", minted._yay.sessionId));
		expect(session?.fileNodeId).toBe(seeded.nodeId);
		expect(session?.serviceAccountId).toBeDefined();
		expect(session?.serviceAccountId).toBe(installation?.serviceAccountId);

		// The token is a full plugin_ui principal, so the plugin frame can read workspace files.
		const listResponse = await t.fetch("/api/v1/files/list", {
			method: "POST",
			headers: auth_headers(minted._yay.token),
			body: JSON.stringify({ recursive: true }),
		});
		expect(listResponse.status).toBe(200);
	});

	test("excludes file-view-less versions from list_file_views and refuses their mint", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);
		const seeded = await seed_upload_node({ t, fixture, filename: "clip.mp4", contentType: "video/mp4" });

		const listed = await fixture.asOwner.query(api.plugins_ui_installed.list_file_views, {
			membershipId: fixture.membership.membershipId,
		});
		expect(listed).toEqual([]);

		const minted = await mint_file_view(fixture, { fileNodeId: seeded.nodeId });
		expect(minted).toMatchObject({ _nay: { message: "Not found" } });
	});

	test("refuses mint for an unknown view id and for a content-type mismatch", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t, { fileViews: [video_file_view] });
		const video = await seed_upload_node({ t, fixture, filename: "clip.mp4", contentType: "video/mp4" });
		const image = await seed_upload_node({ t, fixture, filename: "photo.png", contentType: "image/png" });

		expect(await mint_file_view(fixture, { fileNodeId: video.nodeId })).toMatchObject({
			_yay: expect.any(Object),
		});
		expect(await mint_file_view(fixture, { fileViewId: "other", fileNodeId: video.nodeId })).toMatchObject({
			_nay: { message: "Not found" },
		});
		expect(await mint_file_view(fixture, { fileNodeId: image.nodeId })).toMatchObject({
			_nay: { message: "Not found" },
		});
	});

	test("excludes non-passed and non-ready versions from file view listing and minting", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t, { fileViews: [video_file_view] });
		const seeded = await seed_upload_node({ t, fixture, filename: "clip.mp4", contentType: "video/mp4" });

		expect(await mint_file_view(fixture, { fileNodeId: seeded.nodeId })).toMatchObject({
			_yay: expect.any(Object),
		});

		for (const patch of [{ reviewStatus: "pending" as const }, { sourceStatus: "preparing" as const }]) {
			await t.run((ctx) => ctx.db.patch("plugins_versions", fixture.pluginVersionId, patch));
			expect(
				await fixture.asOwner.query(api.plugins_ui_installed.list_file_views, {
					membershipId: fixture.membership.membershipId,
				}),
			).toEqual([]);
			expect(await mint_file_view(fixture, { fileNodeId: seeded.nodeId })).toMatchObject({
				_nay: { message: "Not found" },
			});
			await t.run((ctx) =>
				ctx.db.patch("plugins_versions", fixture.pluginVersionId, {
					reviewStatus: "passed",
					sourceStatus: "ready",
				}),
			);
		}
	});

	test("refuses to mint for a disabled installation", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t, { fileViews: [video_file_view] });
		const seeded = await seed_upload_node({ t, fixture, filename: "clip.mp4", contentType: "video/mp4" });
		await t.run((ctx) =>
			ctx.db.patch("plugins_workspace_installations", fixture.installationId, { status: "disabled" }),
		);

		expect(await mint_file_view(fixture, { fileNodeId: seeded.nodeId })).toMatchObject({
			_nay: { message: "Not found" },
		});
	});

	test("refuses to mint for a restricted file the user cannot read", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t, { fileViews: [video_file_view] });
		const seeded = await seed_upload_node({ t, fixture, filename: "clip.mp4", contentType: "video/mp4" });
		const reader = await seed_member_reader(t, fixture);
		const asReader = t.withIdentity(user_identity(reader.userId));
		const mint_as_reader = () =>
			asReader.action(api.plugins_ui.mint_file_view_session, {
				membershipId: reader.membershipId,
				pluginName: "gallery",
				fileViewId: "player",
				fileNodeId: seeded.nodeId,
			});

		expect(await mint_as_reader()).toMatchObject({ _yay: expect.any(Object) });

		// Restricting the node cuts the reader's workspace-wide content.read out of the decision.
		await t.run((ctx) => ctx.db.patch("files_nodes", seeded.nodeId, { restrictedScopeNodeId: seeded.nodeId }));
		expect(await mint_as_reader()).toMatchObject({ _nay: { message: "Permission denied" } });
	});

	test("refreshes a file-view session only while the file stays readable", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t, { fileViews: [video_file_view] });
		const seeded = await seed_upload_node({ t, fixture, filename: "clip.mp4", contentType: "video/mp4" });
		const reader = await seed_member_reader(t, fixture);
		const asReader = t.withIdentity(user_identity(reader.userId));
		const minted = await asReader.action(api.plugins_ui.mint_file_view_session, {
			membershipId: reader.membershipId,
			pluginName: "gallery",
			fileViewId: "player",
			fileNodeId: seeded.nodeId,
		});
		if (minted._nay) {
			throw new Error(minted._nay.message);
		}
		const refresh = () =>
			asReader.action(api.plugins_ui.refresh_ui_session, {
				membershipId: reader.membershipId,
				sessionId: minted._yay.sessionId,
			});

		expect(await refresh()).toMatchObject({ _yay: expect.any(Object) });

		// A restriction added after the mint must stop the rotation, because the session carries the
		// node it was opened for.
		await t.run((ctx) => ctx.db.patch("files_nodes", seeded.nodeId, { restrictedScopeNodeId: seeded.nodeId }));
		expect(await refresh()).toMatchObject({ _nay: { message: "Permission denied" } });
	});

	test("refuses to refresh a file-view session after its file node is deleted", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t, { fileViews: [video_file_view] });
		const seeded = await seed_upload_node({ t, fixture, filename: "clip.mp4", contentType: "video/mp4" });
		const minted = await mint_file_view(fixture, { fileNodeId: seeded.nodeId });
		if (minted._nay) {
			throw new Error(minted._nay.message);
		}
		const refresh = () =>
			fixture.asOwner.action(api.plugins_ui.refresh_ui_session, {
				membershipId: fixture.membership.membershipId,
				sessionId: minted._yay.sessionId,
			});

		expect(await refresh()).toMatchObject({ _yay: expect.any(Object) });

		// Without the deleted-node guard the check would degrade to the workspace-level question, so
		// the session could keep rotating for a purged file.
		await t.run((ctx) => ctx.db.delete("files_nodes", seeded.nodeId));
		expect(await refresh()).toMatchObject({ _nay: { message: "Not found" } });
	});

	test("rate limits file view mints on their own bucket", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t, { fileViews: [video_file_view] });
		const seeded = await seed_upload_node({ t, fixture, filename: "clip.mp4", contentType: "video/mp4" });

		// Bucket capacity is 8: browsing a handful of files in a row must work, the ninth burst mint hits the limit.
		for (let mint = 0; mint < 8; mint += 1) {
			expect(await mint_file_view(fixture, { fileNodeId: seeded.nodeId })).toMatchObject({
				_yay: expect.any(Object),
			});
		}
		expect(await mint_file_view(fixture, { fileNodeId: seeded.nodeId })).toMatchObject({
			_nay: { message: "Rate limit exceeded" },
		});

		// Page mints stay on their own bucket, so the file-view burst does not break opening a page.
		const pageMint = await fixture.asOwner.action(api.plugins_ui.mint_page_session, {
			membershipId: fixture.membership.membershipId,
			pluginName: "gallery",
		});
		expect(pageMint).toMatchObject({ _yay: expect.any(Object) });
	});

	test("a rate limited file view mint answers with the wait the frame shows", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t, { fileViews: [video_file_view] });
		const seeded = await seed_upload_node({ t, fixture, filename: "clip.mp4", contentType: "video/mp4" });

		// Fill the eight tokens this bucket holds, so the next mint is the refused one.
		for (let mint = 0; mint < 8; mint += 1) {
			expect(await mint_file_view(fixture, { fileNodeId: seeded.nodeId })).toMatchObject({
				_yay: expect.any(Object),
			});
		}
		const refused = await mint_file_view(fixture, { fileNodeId: seeded.nodeId });
		expect(refused).toMatchObject({ _nay: { message: "Rate limit exceeded" } });
		if (!refused._nay) {
			throw new Error("the ninth file view mint was not refused");
		}

		// Same alert as the page mint: the frame prints this wait and stops. Without the number it
		// prints a fixed 5 seconds (`mint_error_message` in `plugins-ui-frame.tsx`), which is longer
		// than this faster bucket ever needs, so the member waits for nothing.
		expect(refused._nay.data?.retryAfterMs).toEqual(expect.any(Number));
		expect(refused._nay.data!.retryAfterMs!).toBeGreaterThan(0);
		// One token asked for, and this bucket refills 30 tokens a minute
		// (`plugins_ui_file_view_session_mint` in `rate_limiter.ts`), so one refill step is the most
		// the member can be asked to wait.
		expect(refused._nay.data!.retryAfterMs!).toBeLessThanOrEqual(60_000 / 30);
	});

	test("a rate limited rotation answers with the wait the frame pauses for", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t, { fileViews: [video_file_view] });
		const seeded = await seed_upload_node({ t, fixture, filename: "clip.mp4", contentType: "video/mp4" });
		const minted = await mint_file_view(fixture, { fileNodeId: seeded.nodeId });
		if (minted._nay) {
			throw new Error(minted._nay.message);
		}
		const refresh = () =>
			fixture.asOwner.action(api.plugins_ui.refresh_ui_session, {
				membershipId: fixture.membership.membershipId,
				sessionId: minted._yay.sessionId,
			});

		// A rotation charges `plugins_ui_session_mint`, and the file-view mint above charges its own
		// bucket instead. So this bucket is still full here, it holds two tokens, and the third
		// rotation in a burst is refused.
		expect(await refresh()).toMatchObject({ _yay: expect.any(Object) });
		expect(await refresh()).toMatchObject({ _yay: expect.any(Object) });
		const refused = await refresh();
		expect(refused).toMatchObject({ _nay: { message: "Rate limit exceeded" } });
		if (!refused._nay) {
			throw new Error("the third rotation was not refused");
		}

		// The frame reads this wait, sleeps, and rotates once more (`plugins-ui-frame.tsx`). Without
		// the wait it stops the page, and the member gets an error alert instead of a page that heals
		// itself. So the refusal must carry a real number.
		expect(refused._nay.data?.retryAfterMs).toEqual(expect.any(Number));
		expect(refused._nay.data!.retryAfterMs!).toBeGreaterThan(0);
		// The refusal asks for one token, and the bucket refills 12 tokens a minute
		// (`plugins_ui_session_mint` in `rate_limiter.ts`), so the wait is one refill step at most.
		expect(refused._nay.data!.retryAfterMs!).toBeLessThanOrEqual(60_000 / 12);
	});
});

// The expiry job is shared by both mints and moved by refresh, so it gets its own group.
describe("plugin ui session expiry", () => {
	test("a minted session deletes itself at expiry without the daily cron", async () => {
		const t = test_convex();
		// The expiry deletion runs on the scheduler, so the test needs fake timers to reach it.
		vi.useFakeTimers();
		const fixture = await install_gallery_plugin(t);
		const session = await mint_session_token(fixture);

		const stored = await t.run((ctx) => ctx.db.get("plugins_ui_sessions", session.sessionId));
		if (!stored?.expiryJobId) {
			throw new Error("mint did not schedule the expiry job");
		}
		const job = await t.run((ctx) => ctx.db.system.get("_scheduled_functions", stored.expiryJobId!));
		expect(job?.scheduledTime).toBe(session.expiresAt);

		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(await t.run((ctx) => ctx.db.get("plugins_ui_sessions", session.sessionId))).toBeNull();
	});

	test("refresh moves the expiry job to the new expiry instead of letting the old one fire", async () => {
		const t = test_convex();
		vi.useFakeTimers();
		const fixture = await install_gallery_plugin(t);
		const session = await mint_session_token(fixture);
		const beforeRefresh = await t.run((ctx) => ctx.db.get("plugins_ui_sessions", session.sessionId));

		// Let time pass so the refreshed expiry lands later than the minted one.
		vi.advanceTimersByTime(60 * 1000);
		const refreshed = await fixture.asOwner.action(api.plugins_ui.refresh_ui_session, {
			membershipId: fixture.membership.membershipId,
			sessionId: session.sessionId,
		});
		if (refreshed._nay) {
			throw new Error(refreshed._nay.message);
		}
		expect(refreshed._yay.expiresAt).toBeGreaterThan(session.expiresAt);

		const afterRefresh = await t.run((ctx) => ctx.db.get("plugins_ui_sessions", session.sessionId));
		expect(afterRefresh?.expiryJobId).not.toBe(beforeRefresh?.expiryJobId);
		const oldJob = await t.run((ctx) => ctx.db.system.get("_scheduled_functions", beforeRefresh!.expiryJobId!));
		expect(oldJob?.state.kind).toBe("canceled");
		const newJob = await t.run((ctx) => ctx.db.system.get("_scheduled_functions", afterRefresh!.expiryJobId!));
		expect(newJob?.scheduledTime).toBe(refreshed._yay.expiresAt);
	});

	test("the expiry job is a no-op for a moved expiry and for a revoked session", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);
		const session = await mint_session_token(fixture);

		// A stale run before expiry (a refresh raced the job) leaves the doc alone.
		await t.mutation(internal.plugins_ui.expire_ui_session, { sessionId: session.sessionId });
		expect(await t.run((ctx) => ctx.db.get("plugins_ui_sessions", session.sessionId))).not.toBeNull();

		// A run after revocation finds no doc and does not throw.
		const revoked = await fixture.asOwner.mutation(api.plugins_ui.revoke_ui_session, {
			membershipId: fixture.membership.membershipId,
			sessionId: session.sessionId,
		});
		expect(revoked).toMatchObject({ _yay: {} });
		await t.mutation(internal.plugins_ui.expire_ui_session, { sessionId: session.sessionId });
		expect(await t.run((ctx) => ctx.db.get("plugins_ui_sessions", session.sessionId))).toBeNull();
	});
});

describe("plugin session jwt in mint and refresh", () => {
	async function verify_session_jwt(jwt: string) {
		const publicKey = await importSPKI(process.env.ANONYMOUS_USERS_JWT_PUBLIC_KEY_PEM!, "ES256");
		return await jwtVerify(jwt, publicKey, {
			issuer: `${process.env.VITE_CONVEX_HTTP_URL!}/plugins-ui`,
			audience: "convex",
		});
	}

	test("a page mint delivers a verifiable JWT that expires with the session", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);
		const session = await mint_session_token(fixture);

		// One expiry for both credentials: the doors re-read the session doc on every call, so a
		// shorter JWT would buy nothing and only add a second refresh cadence.
		expect(session.jwtExpiresAt).toBe(session.expiresAt);
		const verified = await verify_session_jwt(session.jwt);
		expect(verified.payload.sub).toBe(session.sessionId);
		expect(verified.protectedHeader.kid).toBe("anonymous-user-jwt-2025-12");
		expect(verified.payload.exp).toBe(Math.floor(session.expiresAt / 1000));
	});

	test("a file-view mint delivers the same kind of JWT", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t, {
			fileViews: [
				{ id: "player", title: "Video player", entry: "dist/frontend/index.html", contentTypes: ["video/mp4"] },
			],
		});
		const seeded = await seed_upload_node({ t, fixture, filename: "clip.mp4", contentType: "video/mp4" });

		const minted = await fixture.asOwner.action(api.plugins_ui.mint_file_view_session, {
			membershipId: fixture.membership.membershipId,
			pluginName: "gallery",
			fileViewId: "player",
			fileNodeId: seeded.nodeId,
		});
		if (minted._nay) {
			throw new Error(minted._nay.message);
		}
		expect(minted._yay.jwtExpiresAt).toBe(minted._yay.expiresAt);
		const verified = await verify_session_jwt(minted._yay.jwt);
		expect(verified.payload.sub).toBe(minted._yay.sessionId);
		expect(verified.payload.exp).toBe(Math.floor(minted._yay.expiresAt / 1000));
	});

	test("a refresh delivers a new JWT signed for the new expiry", async () => {
		const t = test_convex();
		vi.useFakeTimers();
		const fixture = await install_gallery_plugin(t);
		const initial = await mint_session_token(fixture);

		// Let time pass so the refreshed expiry lands later than the minted one.
		vi.advanceTimersByTime(60 * 1000);
		const refreshed = await fixture.asOwner.action(api.plugins_ui.refresh_ui_session, {
			membershipId: fixture.membership.membershipId,
			sessionId: initial.sessionId,
		});
		if (refreshed._nay) {
			throw new Error(refreshed._nay.message);
		}
		expect(refreshed._yay.jwtExpiresAt).toBe(refreshed._yay.expiresAt);
		const verified = await verify_session_jwt(refreshed._yay.jwt);
		expect(verified.payload.sub).toBe(initial.sessionId);
		expect(verified.payload.exp).toBe(Math.floor(refreshed._yay.expiresAt / 1000));
		expect(verified.payload.exp).toBeGreaterThan(Math.floor(initial.expiresAt / 1000));
	});
});

describe("plugin session jwt exchange", () => {
	test("exchanges a live token for a verifiable plugin-session JWT without extending the session", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);
		const session = await mint_session_token(fixture);

		const response = await exchange_session_jwt({ t, token: session.token });
		expect(response.status).toBe(200);
		const body = (await response.json()) as { _yay?: { jwt: string; sessionExpiresAt: number } };
		if (!body._yay) {
			throw new Error("exchange refused a live token");
		}
		expect(body._yay.sessionExpiresAt).toBe(session.expiresAt);

		// Verify against the same public key the JWKS route publishes: signature, issuer, audience.
		const publicKey = await importSPKI(process.env.ANONYMOUS_USERS_JWT_PUBLIC_KEY_PEM!, "ES256");
		const verified = await jwtVerify(body._yay.jwt, publicKey, {
			issuer: `${process.env.VITE_CONVEX_HTTP_URL!}/plugins-ui`,
			audience: "convex",
		});
		expect(verified.payload.sub).toBe(session.sessionId);
		expect(verified.protectedHeader.kid).toBe("anonymous-user-jwt-2025-12");
		// The JWT expires with the session it stands for, nothing shorter: the same rule as the JWT
		// the mint delivered, so the fallback and the delivered credential are interchangeable.
		expect(verified.payload.exp).toBe(Math.floor(session.expiresAt / 1000));

		// The exchange must never extend the session; only refresh_ui_session (member auth) does.
		const stored = await t.run((ctx) => ctx.db.get("plugins_ui_sessions", session.sessionId));
		expect(stored?.expiresAt).toBe(session.expiresAt);
	});

	test("signs the JWT for whatever is left of the session", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);
		const session = await mint_session_token(fixture);
		// Two minutes left on the session: the JWT gets exactly those two minutes.
		const nearExpiry = Date.now() + 2 * 60 * 1000;
		await t.run((ctx) => ctx.db.patch("plugins_ui_sessions", session.sessionId, { expiresAt: nearExpiry }));

		const response = await exchange_session_jwt({ t, token: session.token });
		expect(response.status).toBe(200);
		const body = (await response.json()) as { _yay?: { jwt: string; sessionExpiresAt: number } };
		if (!body._yay) {
			throw new Error("exchange refused a live token");
		}
		expect(body._yay.sessionExpiresAt).toBe(nearExpiry);

		const publicKey = await importSPKI(process.env.ANONYMOUS_USERS_JWT_PUBLIC_KEY_PEM!, "ES256");
		const verified = await jwtVerify(body._yay.jwt, publicKey, {
			issuer: `${process.env.VITE_CONVEX_HTTP_URL!}/plugins-ui`,
			audience: "convex",
		});
		expect(verified.payload.exp).toBe(Math.floor(nearExpiry / 1000));
	});

	test("refuses wrong origins, garbage tokens, other principal kinds, and dead sessions", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);
		const session = await mint_session_token(fixture);

		// A cross-origin browser call with a live token: only the Origin guard stands between a
		// foreign page and a readable JWT.
		const crossOrigin = await exchange_session_jwt({ t, token: session.token, origin: "https://evil.example" });
		expect(crossOrigin.status).toBe(403);
		// A sandboxed iframe without allow-same-origin sends the literal "null" Origin.
		const nullOrigin = await exchange_session_jwt({ t, token: session.token, origin: "null" });
		expect(nullOrigin.status).toBe(403);

		// A request with no Origin header at all is allowed: non-browser callers send none, and
		// the browser threat is the readable response, which the missing CORS headers block.
		const noOrigin = await t.fetch("/plugins-ui/session-jwt", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ token: session.token }),
		});
		expect(noOrigin.status).toBe(200);
		expect(noOrigin.headers.get("Access-Control-Allow-Origin")).toBeNull();

		const noToken = await t.fetch("/plugins-ui/session-jwt", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: new URL(process.env.VITE_CONVEX_HTTP_URL!).origin },
			body: JSON.stringify({}),
		});
		expect(noToken.status).toBe(400);

		const garbage = await exchange_session_jwt({ t, token: `plu_${"0".repeat(64)}` });
		expect(garbage.status).toBe(401);

		// A real user API key resolves to a principal, but not a plugin_ui one — it must never
		// become a Convex identity through this route.
		await t.run((ctx) =>
			ctx.db.patch("users", fixture.membership.userId, { clerkUserId: `clerk-${fixture.membership.userId}` }),
		);
		const created = await fixture.asOwner.mutation(api.public_api.api_credential_create, {
			serviceAccountId: null,
			membershipId: fixture.membership.membershipId,
			name: "Files key",
			scopes: ["files:read"],
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		const apiKey = await exchange_session_jwt({ t, token: created._yay.credential });
		expect(apiKey.status).toBe(401);

		// Expired session: resolve_principal leaves the expiry verdict to this route.
		await t.run((ctx) => ctx.db.patch("plugins_ui_sessions", session.sessionId, { expiresAt: Date.now() - 1000 }));
		const expired = await exchange_session_jwt({ t, token: session.token });
		expect(expired.status).toBe(401);

		// Revoked session: the token no longer resolves at all.
		await t.run((ctx) => ctx.db.delete("plugins_ui_sessions", session.sessionId));
		const revoked = await exchange_session_jwt({ t, token: session.token });
		expect(revoked.status).toBe(401);
	});

	test("rate limits repeated exchanges per session", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);
		const session = await mint_session_token(fixture);

		// Capacity 6 per session id; the seventh call in a burst must be refused.
		for (let index = 0; index < 6; index += 1) {
			expect((await exchange_session_jwt({ t, token: session.token })).status).toBe(200);
		}
		const refused = await exchange_session_jwt({ t, token: session.token });
		expect(refused.status).toBe(429);
		const body = (await refused.json()) as { retryAfterMs?: number };
		expect(body.retryAfterMs).toBeGreaterThan(0);
	});

	// The dev exchange exception must be invisible while the deployment variable is unset, which is
	// always true in production. This pins the unset state explicitly instead of relying on every
	// other test's environment happening to lack the variable.
	test("refuses a cross-origin caller and sends no CORS headers while the dev exchange variable is unset", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);
		const session = await mint_session_token(fixture);
		vi.stubEnv("PLUGINS_UI_DEV_EXCHANGE_ORIGIN", "");

		const refused = await exchange_session_jwt({ t, token: session.token, origin: "http://localhost:5174" });
		expect(refused.status).toBe(403);
		expect(refused.headers.get("Access-Control-Allow-Origin")).toBeNull();

		// The preflight route answers like any unregistered route without the variable.
		const preflight = await t.fetch("/plugins-ui/session-jwt", {
			method: "OPTIONS",
			headers: { Origin: "http://localhost:5174", "Access-Control-Request-Method": "POST" },
		});
		expect(preflight.status).toBe(404);
	});

	test("accepts exactly the configured dev exchange origin with CORS and refuses every other origin", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);
		const session = await mint_session_token(fixture);
		vi.stubEnv("PLUGINS_UI_DEV_EXCHANGE_ORIGIN", "http://localhost:5174");

		// The exact configured origin exchanges and may read the response through CORS.
		const accepted = await exchange_session_jwt({ t, token: session.token, origin: "http://localhost:5174" });
		expect(accepted.status).toBe(200);
		expect(accepted.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5174");
		expect(accepted.headers.get("Access-Control-Allow-Methods")).toBe("POST");
		expect(accepted.headers.get("Access-Control-Allow-Headers")).toBe("Content-Type");
		// Vary keeps any shared cache from answering one origin with another origin's response.
		expect(accepted.headers.get("Vary")).toBe("Origin");
		const body = (await accepted.json()) as { _yay?: { jwt: string } };
		if (!body._yay) {
			throw new Error("exchange refused the configured dev origin");
		}

		// The frame's own asset origin stays valid while the variable is set, so enabling the dev
		// exception cannot break the published-frame flow.
		const siteCaller = await exchange_session_jwt({ t, token: session.token });
		expect(siteCaller.status).toBe(200);

		// A different port or scheme must not ride along, and never sees CORS headers.
		for (const foreignOrigin of ["http://localhost:5175", "https://localhost:5174"]) {
			const foreign = await exchange_session_jwt({ t, token: session.token, origin: foreignOrigin });
			expect(foreign.status).toBe(403);
			expect(foreign.headers.get("Access-Control-Allow-Origin")).toBeNull();
		}
		// "null" stays refused even when it is a substring of the configured value.
		const nullOrigin = await exchange_session_jwt({ t, token: session.token, origin: "null" });
		expect(nullOrigin.status).toBe(403);

		// A server-to-server call (no Origin header) keeps working and still gains no CORS headers,
		// so its response remains unreadable cross-origin.
		const noOrigin = await t.fetch("/plugins-ui/session-jwt", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ token: session.token }),
		});
		expect(noOrigin.status).toBe(200);
		expect(noOrigin.headers.get("Access-Control-Allow-Origin")).toBeNull();

		// Refused answers also carry the CORS headers for the dev origin, or a preflighted request
		// whose POST then fails would hide its error body behind a browser CORS block.
		const badBody = await t.fetch("/plugins-ui/session-jwt", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: "http://localhost:5174" },
			body: JSON.stringify({}),
		});
		expect(badBody.status).toBe(400);
		expect(badBody.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5174");

		// The preflight answers for the configured origin only.
		const preflight = await t.fetch("/plugins-ui/session-jwt", {
			method: "OPTIONS",
			headers: { Origin: "http://localhost:5174", "Access-Control-Request-Method": "POST" },
		});
		expect(preflight.status).toBe(204);
		expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5174");
		expect(preflight.headers.get("Access-Control-Allow-Methods")).toBe("POST");
		const foreignPreflight = await t.fetch("/plugins-ui/session-jwt", {
			method: "OPTIONS",
			headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" },
		});
		expect(foreignPreflight.status).toBe(404);

		// An invalid configured value behaves as unset rather than opening the guard.
		vi.stubEnv("PLUGINS_UI_DEV_EXCHANGE_ORIGIN", "localhost:5174");
		const invalidConfigured = await exchange_session_jwt({ t, token: session.token, origin: "localhost:5174" });
		expect(invalidConfigured.status).toBe(403);

		// The most likely typo is a scheme-less value, and new URL("localhost:5174").origin does not
		// throw — it serializes to the string "null". That is also the literal Origin header every
		// sandboxed iframe or data: page sends, so the parser must refuse the value outright or the
		// guard would open to every opaque origin on the web.
		const opaqueOrigin = await exchange_session_jwt({ t, token: session.token, origin: "null" });
		expect(opaqueOrigin.status).toBe(403);
		expect(opaqueOrigin.headers.get("Access-Control-Allow-Origin")).toBeNull();
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
		// Pin the whole policy, not one directive at a time. A `toContain` check on a directive stays
		// true after that directive is widened, and `frame-ancestors` is the last one and carries no
		// trailing semicolon, so appending a second origin to it passed the old check.
		//
		// Several directives had no test at all, while the app argues from them: plugins_ui.ts
		// explains `img-src`/`media-src` as what stops a frame from leaking data through image and
		// media loads, and plugins-ui-frame.tsx allows the iframe `allow-forms` because
		// `form-action 'none'` blocks every real submission. Widening any of them must fail here.
		expect(csp).toBe(
			[
				"default-src 'none'",
				"script-src 'self'",
				"style-src 'self' 'unsafe-inline'",
				"img-src https://test.r2.cloudflarestorage.com https://test-files-bucket.test.r2.cloudflarestorage.com data: blob:",
				"media-src https://test.r2.cloudflarestorage.com https://test-files-bucket.test.r2.cloudflarestorage.com blob:",
				// The Convex cloud origins let the frame's own ConvexClient connect; https never
				// authorizes wss, so both schemes must be listed.
				"connect-src 'self' https://cloud.convex.test wss://cloud.convex.test",
				"font-src 'self'",
				"base-uri 'none'",
				"form-action 'none'",
				"frame-ancestors https://app.test",
			].join("; "),
		);
		expect(await response.text()).toBe("<!doctype html><title>Gallery</title>");
	});

	test("lets the page reach only the origins its own version declared", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t, {
			capabilities: ["workspace.files.read", "ui.outbound.fetch"],
			uiOutboundOrigins: ["https://council.example.com"],
		});
		r2Objects.set("plugins/gallery/0.1.0/dist/frontend/index.html", "<!doctype html><title>Gallery</title>");

		const response = await t.fetch(`/plugins-ui/${fixture.pluginVersionId}/dist/frontend/index.html`, {
			method: "GET",
		});
		expect(response.status).toBe(200);
		const csp = response.headers.get("Content-Security-Policy");
		// The declared origin is added to the origins every frame already needs; it does not replace them.
		expect(csp).toContain(
			"connect-src 'self' https://cloud.convex.test wss://cloud.convex.test https://council.example.com;",
		);
		expect(csp).not.toContain("connect-src 'self' https://cloud.convex.test wss://cloud.convex.test;");
	});

	test("keeps another plugin's declared origins out of this page's policy", async () => {
		const t = test_convex();
		// Two versions in one deployment. The policy must come from the version being served, not from
		// whatever any installed plugin declared, or one plugin would widen every other plugin's page.
		const talker = await install_gallery_plugin(t, {
			capabilities: ["workspace.files.read", "ui.outbound.fetch"],
			uiOutboundOrigins: ["https://council.example.com"],
		});
		const quiet = await register_gallery_plugin({ t, userId: talker.membership.userId, version: "0.2.0" });
		r2Objects.set("plugins/gallery/0.2.0/dist/frontend/index.html", "<!doctype html><title>Gallery</title>");

		const response = await t.fetch(`/plugins-ui/${quiet.pluginVersionId}/dist/frontend/index.html`, {
			method: "GET",
		});
		expect(response.status).toBe(200);
		const csp = response.headers.get("Content-Security-Policy");
		expect(csp).toContain("connect-src 'self' https://cloud.convex.test wss://cloud.convex.test;");
		expect(csp).not.toContain("council.example.com");
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
		// The frame and its immutable assets share one origin, so these files need no CORS header.
		expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
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

/**
 * Seed saved files with custom fields, and wait until their field docs are published.
 */
async function seed_query_files(
	t: ReturnType<typeof test_convex>,
	fixture: Awaited<ReturnType<typeof install_gallery_plugin>>,
	files: Array<{ path: string; metadata: files_metadata_Entry[] }>,
) {
	const nodeIds = await test_run_with_flush(t, async (ctx) => {
		const ids: Array<Id<"files_nodes">> = [];
		for (const file of files) {
			const created = await files_nodes_db_create_node_recursively_at_path(ctx, {
				organizationId: fixture.membership.organizationId,
				workspaceId: fixture.membership.workspaceId,
				userId: fixture.membership.userId,
				parentId: "root",
				path: file.path,
				kind: "file",
				contentType: "text/markdown",
				now: Date.now(),
			});
			if (created._nay) throw new Error(created._nay.message);
			await files_metadata_db_write_entries(ctx, {
				fileNode: (await ctx.db.get("files_nodes", created._yay))!,
				entries: file.metadata,
			});
			ids.push(created._yay);
		}
		return ids;
	});
	for (const nodeId of nodeIds) await test_finish_file_index(t, nodeId);
	return nodeIds;
}

type QueryPage = {
	items: Array<{
		path: string;
		fields: Record<string, { value: string | number | boolean | null; isPreview: boolean }>;
	}>;
	cursor: string | null;
	isDone: boolean;
};

async function query_files(t: ReturnType<typeof test_convex>, token: string, body: Record<string, unknown>) {
	const response = await t.fetch("/api/v1/files/query", {
		method: "POST",
		headers: auth_headers(token),
		body: JSON.stringify(body),
	});
	return {
		status: response.status,
		body: (await response.json()) as QueryPage & { message?: string; errorCode?: string },
	};
}

async function get_folder_id(
	t: ReturnType<typeof test_convex>,
	fixture: Awaited<ReturnType<typeof install_gallery_plugin>>,
	path: string,
) {
	return await t.run(async (ctx) => {
		const nodes = await ctx.db.query("files_nodes").collect();
		return nodes.find((node) => node.workspaceId === fixture.membership.workspaceId && node.path === path)!._id;
	});
}

describe("files/query", () => {
	test.each(["asc", "desc"] as const)(
		"folder mode pages by value past many other values, and reads only the matching rows (%s)",
		async (order) => {
			const t = test_convex();
			const fixture = await install_gallery_plugin(t);
			await seed_query_files(t, fixture, [
				// More rows with another value than eight read rounds of this page size can pass. Half sort
				// before "open" and half after it, so both orders must pass other values first.
				...Array.from({ length: 60 }, (_, index) => ({
					path: `listings/a-${String(index).padStart(2, "0")}.md`,
					metadata: [{ key: "status", value: index % 2 === 0 ? "closed" : "pending" }],
				})),
				...Array.from({ length: 5 }, (_, index) => ({
					path: `listings/z-${index}.md`,
					metadata: [
						{ key: "status", value: "open" },
						{ key: "rent", value: 900 + index },
					],
				})),
				{ path: "listings/no-status.md", metadata: [{ key: "rent", value: 1 }] },
				{ path: "other/open.md", metadata: [{ key: "status", value: "open" }] },
			]);
			const session = await mint_session_token(fixture);

			const pages: QueryPage[] = [];
			let cursor: string | null = null;
			do {
				const page = await query_files(t, session.token, {
					mode: "folder",
					path: "/listings",
					field: "metadata.status",
					match: { eq: "open" },
					order,
					fields: ["metadata.rent"],
					limit: 2,
					cursor,
				});
				expect(page.status, JSON.stringify(page.body)).toBe(200);
				pages.push(page.body);
				cursor = page.body.cursor;
				expect(pages.length).toBeLessThan(10);
			} while (cursor !== null);

			const rows = pages.map((page) => page.items.map((item) => [item.path, item.fields["metadata.rent"]?.value]));
			// An `eq` match reads one value, in name order.
			const expected = Array.from({ length: 5 }, (_, index) => [`/listings/z-${index}.md`, 900 + index]);
			if (order === "desc") expected.reverse();
			// Only the last request may be an empty page: the reader learns the end only after the last row.
			expect(rows.at(-1)!.length === 0 ? rows.slice(0, -1) : rows).toEqual([
				expected.slice(0, 2),
				expected.slice(2, 4),
				expected.slice(4),
			]);
			expect(pages.at(-1)!.isDone).toBe(true);

			// The read must not touch the 60 rows with another value. A page of 2 reads about 20 documents:
			// its 2 field docs and nodes, and the access and index state docs.
			const folderId = await get_folder_id(t, fixture, "/listings");
			const reads = await t.run(async (ctx) => {
				const before = await ctx.meta.getTransactionMetrics();
				const page = await ctx.runQuery(internal.files_tree.list_children_by_field, {
					organizationId: fixture.membership.organizationId,
					workspaceId: fixture.membership.workspaceId,
					subject: { kind: "plugin_pair", pairId: fixture.filePairId },
					folderId,
					kind: "file",
					field: "metadata.status",
					match: { kind: "eq", value: "open" },
					order,
					source: { kind: "normal", generation: 0 },
					seek: { lastKey: null, phase: 0 },
					numItems: 2,
				});
				const after = await ctx.meta.getTransactionMetrics();
				return { rows: page?.rows.length, documents: after.documentsRead.used - before.documentsRead.used };
			});
			expect(reads.rows).toBe(2);
			expect(reads.documents, "documents read for a page of 2").toBeLessThan(40);
		},
	);

	test("a plugin page reads only the folder its person chose, and never a whole-workspace search", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t, { fileConsent: false });
		await seed_query_files(t, fixture, [
			{ path: "listings/one.md", metadata: [{ key: "status", value: "open" }] },
			{ path: "other/two.md", metadata: [{ key: "status", value: "open" }] },
		]);
		const grant = async (rootNodeId: Id<"files_nodes">) => {
			// plugins_manage is a token bucket with capacity 2, and the install spent one token.
			await t.run((ctx) =>
				ctx.runMutation(components.rate_limiter.lib.resetRateLimit, {
					name: "plugins_manage",
					key: fixture.membership.userId,
				}),
			);
			await grant_plugin_file_access({
				t,
				userId: fixture.membership.userId,
				membershipId: fixture.membership.membershipId,
				installationId: fixture.installationId,
				rootNodeId,
				level: "read",
			});
		};
		await grant(await get_folder_id(t, fixture, "/other"));
		const session = await mint_session_token(fixture);
		const body = { mode: "folder", path: "/listings", field: "metadata.status" };

		const refused = await query_files(t, session.token, body);
		expect(refused.status).toBe(403);
		expect(refused.body).toEqual({ message: "Permission denied: /listings", errorCode: "permission_denied" });

		await grant(await get_folder_id(t, fixture, "/listings"));
		const allowed = await query_files(t, session.token, body);
		expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
		expect(allowed.body.items.map((item) => item.path)).toEqual(["/listings/one.md"]);

		// A prefix reads the whole open area by value, so it needs the workspace root.
		const prefix = await query_files(t, session.token, {
			mode: "search",
			field: "metadata.status",
			match: { prefix: "op" },
		});
		expect(prefix.status).toBe(403);
		expect(prefix.body).toEqual({
			message:
				"Permission denied: /. Prefix and range read the whole workspace and need access to /. Use eq or exists with a folder path, or folder mode.",
			errorCode: "permission_denied",
		});
	});

	test("a restricted child with a matching value never shows in a folder page", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);
		const [, secretId] = await seed_query_files(t, fixture, [
			{ path: "listings/a.md", metadata: [{ key: "status", value: "open" }] },
			{ path: "listings/b-secret.md", metadata: [{ key: "status", value: "open" }] },
			{ path: "listings/c.md", metadata: [{ key: "status", value: "open" }] },
		]);
		const restricted = await fixture.asOwner.mutation(api.files_sharing.restrict_node, {
			membershipId: fixture.membership.membershipId,
			nodeId: secretId!,
		});
		expect(restricted._nay).toBeUndefined();
		await test_finish_saved_scope_jobs(t);
		await test_finish_file_index(t, secretId!);
		// Give the plugin the restricted file too. plugins_manage is a token bucket with capacity 2, and
		// the install spent one token.
		await t.run((ctx) =>
			ctx.runMutation(components.rate_limiter.lib.resetRateLimit, {
				name: "plugins_manage",
				key: fixture.membership.userId,
			}),
		);
		await grant_plugin_file_access({
			t,
			userId: fixture.membership.userId,
			membershipId: fixture.membership.membershipId,
			installationId: fixture.installationId,
			rootNodeId: secretId!,
			level: "read",
		});
		const session = await mint_session_token(fixture);

		// The plugin can open the restricted file: a search finds it.
		const search = await query_files(t, session.token, {
			mode: "search",
			path: "/listings",
			field: "metadata.status",
			match: { eq: "open" },
		});
		expect(search.status, JSON.stringify(search.body)).toBe(200);
		expect(search.body.items.map((item) => item.path)).toContain("/listings/b-secret.md");

		// Folder mode still leaves it out on purpose. It reads only the area of the folder itself, so a
		// page never depends on a row of another area.
		const body = { mode: "folder", path: "/listings", field: "metadata.status", match: { eq: "open" }, limit: 1 };
		const first = await query_files(t, session.token, body);
		expect(first.status, JSON.stringify(first.body)).toBe(200);
		expect(first.body.items.map((item) => item.path)).toEqual(["/listings/a.md"]);
		const second = await query_files(t, session.token, { ...body, cursor: first.body.cursor });
		expect(second.body.items.map((item) => item.path)).toEqual(["/listings/c.md"]);
	});

	test("folder mode merges the normal and the Move docs, and returns each file once", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);
		const ids = await seed_query_files(
			t,
			fixture,
			// A number value: the cursor must keep the type of the last item's key, or the copy of the
			// previous page's last file is not skipped.
			Array.from({ length: 6 }, (_, index) => ({
				path: `listings/z-${index}.md`,
				metadata: [{ key: "status", value: 7 }],
			})),
		);
		// A Move is copying these files' docs, like the read budget test in `files_tree.budgets.test.ts`.
		// The writes copy the shape of the real copiers (`db_sides` in `files_move_cohorts.ts` and
		// `db_stage_page` in `files_move_content.ts`): each normal doc becomes the "before" doc, and a new
		// "after" doc is inserted. The docs of z-0, z-1, z-2 and z-4 are copied. z-3 and z-5 are not yet.
		const cohortId = await t.run(async (ctx) => {
			const cohortId = await test_db_hold_move_slot(ctx, fixture.membership);
			for (const nodeId of ids) {
				const {
					_id,
					_creationTime,
					createdBy: _createdBy,
					readOnly: _readOnly,
					readOnlyDecisionId: _readOnlyDecisionId,
					moveCohortId: _moveCohortId,
					scopeOpId: _scopeOpId,
					...header
				} = (await ctx.db.get("files_nodes", nodeId))!;
				for (const view of ["before", "after"] as const) {
					await ctx.db.insert("files_saved_places", {
						...header,
						organizationId: fixture.membership.organizationId,
						workspaceId: fixture.membership.workspaceId,
						cohortId,
						view,
						nodeId,
						nodeCreationTime: _creationTime,
						contentId: null,
					});
				}
				await ctx.db.patch("files_nodes", nodeId, { moveCohortId: cohortId });
			}
			for (const { _id, _creationTime, ...doc } of await ctx.db.query("files_metadata_docs").collect()) {
				if (doc.sourceKind !== "committed" || ![0, 1, 2, 4].includes(ids.indexOf(doc.fileNodeId))) continue;
				await ctx.db.patch("files_metadata_docs", _id, { moveView: { cohortId, view: "before" } });
				await ctx.db.insert("files_metadata_docs", { ...doc, moveView: { cohortId, view: "after" } });
			}
			return cohortId;
		});
		// The Move publishes its "after" view, like the end of `files_tree.budgets.test.ts`.
		const publish = () =>
			t.run(async (ctx) => {
				await ctx.db.patch("files_move_cohorts", cohortId, { visibleView: "after", publishedAt: Date.now() });
				const slot = (await ctx.db
					.query("files_move_workspace_slots")
					.withIndex("by_workspace", (q) =>
						q.eq("organizationId", fixture.membership.organizationId).eq("workspaceId", fixture.membership.workspaceId),
					)
					.unique())!;
				await ctx.db.patch("files_move_workspace_slots", slot._id, { visibleView: "after" });
			});
		const session = await mint_session_token(fixture);

		const pages: string[][] = [];
		let cursor: string | null = null;
		do {
			const page = await query_files(t, session.token, {
				mode: "folder",
				path: "/listings",
				field: "metadata.status",
				limit: 2,
				cursor,
			});
			expect(page.status, JSON.stringify(page.body)).toBe(200);
			pages.push(page.body.items.map((item) => item.path));
			cursor = page.body.cursor;
			// Page 1 ends on z-1's "before" doc. The "after" copy of z-1 is newer, so on page 2 it comes
			// right after the page 1 cursor.
			if (pages.length === 1) await publish();
			expect(pages.length).toBeLessThan(10);
		} while (cursor !== null);

		// Every page is full, in name order, and no file shows twice or goes missing.
		expect(pages.at(-1)!.length === 0 ? pages.slice(0, -1) : pages).toEqual([
			["/listings/z-0.md", "/listings/z-1.md"],
			["/listings/z-2.md", "/listings/z-3.md"],
			["/listings/z-4.md", "/listings/z-5.md"],
		]);
	});

	test("a cursor works only for the same caller and the same request", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);
		await seed_query_files(t, fixture, [
			{ path: "listings/a.md", metadata: [{ key: "status", value: "open" }] },
			{ path: "listings/b.md", metadata: [{ key: "status", value: "open" }] },
		]);
		const session = await mint_session_token(fixture);
		const reader = await mint_reader_session(t, fixture);
		const body = { mode: "folder", path: "/listings", field: "metadata.status", limit: 1 };
		const first = await query_files(t, session.token, body);
		expect(first.body.cursor, JSON.stringify(first.body)).not.toBeNull();

		const invalid = { message: "This query cursor changed. Start a new page.", errorCode: "invalid_cursor" };
		const otherCaller = await query_files(t, reader.session.token, { ...body, cursor: first.body.cursor });
		expect(otherCaller.status).toBe(400);
		expect(otherCaller.body).toEqual(invalid);
		const otherMatch = await query_files(t, session.token, {
			...body,
			match: { eq: "open" },
			cursor: first.body.cursor,
		});
		expect(otherMatch.status).toBe(400);
		expect(otherMatch.body).toEqual(invalid);

		// The same person through their own API key is another caller too.
		await t.run((ctx) =>
			ctx.db.patch("users", fixture.membership.userId, { clerkUserId: `clerk-${fixture.membership.userId}` }),
		);
		const key = await fixture.asOwner.mutation(api.public_api.api_credential_create, {
			serviceAccountId: null,
			membershipId: fixture.membership.membershipId,
			name: "Query key",
			scopes: ["files:read", "files:list"],
		});
		if (key._nay) throw new Error(key._nay.message);
		const otherPrincipal = await query_files(t, key._yay.credential, { ...body, cursor: first.body.cursor });
		expect(otherPrincipal.status).toBe(400);
		expect(otherPrincipal.body).toEqual(invalid);

		// `fields` only picks the values to return, so it may change between pages.
		const same = await query_files(t, session.token, {
			...body,
			fields: ["metadata.status"],
			cursor: first.body.cursor,
		});
		expect(same.body.items.map((item) => item.path)).toEqual(["/listings/b.md"]);
	});

	test("folder mode reads a round again when the index view changes, and gives up after two changes", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);
		await seed_query_files(t, fixture, [
			{ path: "listings/a.md", metadata: [{ key: "status", value: "open" }] },
			{ path: "listings/b.md", metadata: [{ key: "status", value: "open" }] },
			{ path: "listings/c.md", metadata: [{ key: "status", value: "open" }] },
		]);
		// A held Move slot gives the index view a cohort, and its visible view is part of the view.
		await t.run((ctx) => test_db_hold_move_slot(ctx, fixture.membership));
		let visibleView: "before" | "after" = "before";
		const flip_view = () =>
			t.run(async (ctx) => {
				visibleView = visibleView === "before" ? "after" : "before";
				const slot = (await ctx.db
					.query("files_move_workspace_slots")
					.withIndex("by_workspace", (q) =>
						q.eq("organizationId", fixture.membership.organizationId).eq("workspaceId", fixture.membership.workspaceId),
					)
					.unique())!;
				await ctx.db.patch("files_move_workspace_slots", slot._id, { visibleView });
			});
		const session = await mint_session_token(fixture);
		const body = { mode: "folder", path: "/listings", field: "metadata.status" };

		// Run one page through the route, and call `onList` after each index read of the page.
		const run_page = (pageBody: Record<string, unknown>, onList: () => Promise<void>) =>
			t.action(async (ctx) =>
				public_api_files_query_http({
					ctx: {
						...ctx,
						runQuery: async (...args) => {
							const result = await ctx.runQuery(...args);
							if (getFunctionName(args[0]) === "files_tree:list_children_by_field") await onList();
							return result;
						},
					},
					request: new Request("https://api.test/api/v1/files/query", {
						method: "POST",
						headers: auth_headers(session.token),
						body: JSON.stringify(pageBody),
					}),
					path: "/api/v1/files/query",
				}),
			);
		const view_changes = (count: number) => async () => {
			if (count === 0) return;
			count--;
			await flip_view();
		};

		// One change: the route reads that round again, and the page is still exact.
		const once = await run_page(body, view_changes(1));
		expect(once.status, JSON.stringify(once.body)).toBe(200);
		expect("items" in once.body && (once.body.items ?? []).map((item) => item.path)).toEqual([
			"/listings/a.md",
			"/listings/b.md",
			"/listings/c.md",
		]);

		// Three changes in one page: the route stops and asks the caller to retry.
		const busy = await run_page(body, view_changes(3));
		expect(busy.status).toBe(503);
		expect(busy.body).toEqual({ message: "Files changed during this page. Retry it.", errorCode: "listing_busy" });

		// The folder changes during a page with a cursor: the cursor cannot go on from there.
		const first = await query_files(t, session.token, { ...body, limit: 1 });
		expect(first.body.cursor, JSON.stringify(first.body)).not.toBeNull();
		let restricted = false;
		const changed = await run_page({ ...body, limit: 1, cursor: first.body.cursor }, async () => {
			if (restricted) return;
			restricted = true;
			const result = await fixture.asOwner.mutation(api.files_sharing.restrict_node, {
				membershipId: fixture.membership.membershipId,
				nodeId: await get_folder_id(t, fixture, "/listings"),
			});
			expect(result._nay).toBeUndefined();
		});
		expect(changed.status).toBe(400);
		expect(changed.body).toEqual({
			message: "This query cursor changed. Start a new page.",
			errorCode: "invalid_cursor",
		});
	});

	test("search mode reads nothing under a restricted folder the plugin was not given", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);
		const [, lockedFileId] = await seed_query_files(t, fixture, [
			{ path: "listings/a.md", metadata: [{ key: "status", value: "open" }] },
			{ path: "listings/locked/b.md", metadata: [{ key: "status", value: "open" }] },
			{ path: "listings/c.md", metadata: [{ key: "status", value: "open" }] },
		]);
		// Whole workspace consent covers the open area only. A restricted folder needs its own choice.
		const restricted = await fixture.asOwner.mutation(api.files_sharing.restrict_node, {
			membershipId: fixture.membership.membershipId,
			nodeId: await get_folder_id(t, fixture, "/listings/locked"),
		});
		expect(restricted._nay).toBeUndefined();
		await test_finish_saved_scope_jobs(t);
		await test_finish_file_index(t, lockedFileId!);
		const session = await mint_session_token(fixture);

		// Record every folder the walk reads in, through the route's own context.
		const framePaths: string[] = [];
		const response = await t.action(async (ctx) =>
			public_api_files_query_http({
				ctx: {
					...ctx,
					runQuery: async (...args) => {
						const frame = (args[1] as { frame?: { treePath: string } } | undefined)?.frame;
						if (frame) framePaths.push(frame.treePath);
						return await ctx.runQuery(...args);
					},
				},
				request: new Request("https://api.test/api/v1/files/query", {
					method: "POST",
					headers: auth_headers(session.token),
					body: JSON.stringify({ mode: "search", path: "/listings", field: "metadata.status", match: { eq: "open" } }),
				}),
				path: "/api/v1/files/query",
			}),
		);
		expect(framePaths.length, "the walk must read the open folder").toBeGreaterThan(0);
		expect(framePaths.filter((treePath) => treePath.startsWith("/listings/locked/"))).toEqual([]);
		expect(response.status, JSON.stringify(response.body)).toBe(200);
		expect("items" in response.body && (response.body.items ?? []).map((item) => item.path)).toEqual([
			"/listings/a.md",
			"/listings/c.md",
		]);
	});

	test("search mode pages a match under a folder, and a whole-workspace plugin runs prefix and range", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);
		await seed_query_files(t, fixture, [
			{
				path: "listings/a.md",
				metadata: [
					{ key: "status", value: "open" },
					{ key: "rent", value: 900 },
				],
			},
			{
				path: "listings/b.md",
				metadata: [
					{ key: "status", value: "open" },
					{ key: "rent", value: 950 },
				],
			},
			{
				path: "listings/sub/c.md",
				metadata: [
					{ key: "status", value: "open" },
					{ key: "rent", value: 1000 },
				],
			},
			{ path: "listings/d.md", metadata: [{ key: "status", value: "closed" }] },
			{
				path: "other/e.md",
				metadata: [
					{ key: "status", value: "open" },
					{ key: "rent", value: 1200 },
				],
			},
		]);
		const [tagsId] = await seed_query_files(t, fixture, [{ path: "other/tags.md", metadata: [] }]);
		await test_run_with_flush(t, (ctx) =>
			files_metadata_db_insert_committed(ctx, {
				organizationId: fixture.membership.organizationId,
				workspaceId: fixture.membership.workspaceId,
				nodeId: tagsId!,
				markdownContent: "---\ntags: [open, opal]\n---\n",
			}),
		);
		await test_finish_file_index(t, tagsId!);
		const session = await mint_session_token(fixture);

		const body = {
			mode: "search",
			path: "/listings",
			field: "metadata.status",
			match: { eq: "open" },
			fields: ["metadata.rent"],
			limit: 1,
		};

		// A repeated field counts once. The list below has one field more than the limit, so it passes
		// only when the repeat is removed first.
		const allFields = Array.from({ length: files_metadata_QUERY_FIELDS_MAX }, (_, index) => `metadata.f${index}`);
		const repeated = await query_files(t, session.token, { ...body, fields: [...allFields, "metadata.f0"] });
		expect(repeated.status, JSON.stringify(repeated.body)).toBe(200);

		const pages: QueryPage[] = [];
		let cursor: string | null = null;
		do {
			const page = await query_files(t, session.token, { ...body, cursor });
			expect(page.status, JSON.stringify(page.body)).toBe(200);
			pages.push(page.body);
			cursor = page.body.cursor;
			expect(pages.length).toBeLessThan(10);
		} while (cursor !== null);
		expect(pages.at(-1)!.isDone).toBe(true);
		expect(pages.every((page) => page.items.length <= 1)).toBe(true);
		expect(pages.flatMap((page) => page.items.map((item) => [item.path, item.fields]))).toEqual([
			["/listings/a.md", { "metadata.rent": { value: 900, isPreview: false } }],
			["/listings/b.md", { "metadata.rent": { value: 950, isPreview: false } }],
			["/listings/sub/c.md", { "metadata.rent": { value: 1000, isPreview: false } }],
		]);

		const first = await query_files(t, session.token, body);
		const otherMatch = await query_files(t, session.token, {
			...body,
			match: { eq: "closed" },
			cursor: first.body.cursor,
		});
		expect(otherMatch.status).toBe(400);
		expect(otherMatch.body).toEqual({
			message: "This query cursor changed. Start a new page.",
			errorCode: "invalid_cursor",
		});

		// This plugin has Whole workspace consent, so it may read the whole open area by value.
		const prefix = await query_files(t, session.token, {
			mode: "search",
			field: "metadata.status",
			match: { prefix: "op" },
		});
		expect(prefix.status, JSON.stringify(prefix.body)).toBe(200);
		expect(prefix.body.items.map((item) => item.path).sort()).toEqual([
			"/listings/a.md",
			"/listings/b.md",
			"/listings/sub/c.md",
			"/other/e.md",
		]);
		const range = await query_files(t, session.token, {
			mode: "search",
			field: "metadata.rent",
			match: { range: { gte: 950 } },
		});
		expect(range.status, JSON.stringify(range.body)).toBe(200);
		expect(range.body.items.map((item) => item.path)).toEqual(["/listings/b.md", "/listings/sub/c.md", "/other/e.md"]);

		// A list field with two matching values gives two index rows. The file still shows once on the page.
		const tags = await query_files(t, session.token, {
			mode: "search",
			field: "frontmatter.tags",
			match: { prefix: "op" },
		});
		expect(tags.status, JSON.stringify(tags.body)).toBe(200);
		expect(tags.body.items.map((item) => item.path)).toEqual(["/other/tags.md"]);
	});

	test("folder mode orders numbers, booleans and text across pages, and eq is strict by type", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);
		const values = [-10, -5, 0, 12.25, 12.5, 850, false, true, "850", "n/a"];
		// Seed in another order than the expected one, so the order comes from the keys.
		await seed_query_files(
			t,
			fixture,
			values.map((value, index) => ({ path: `listings/f-${index}.md`, metadata: [{ key: "rent", value }] })).reverse(),
		);
		const session = await mint_session_token(fixture);
		const body = { mode: "folder", path: "/listings", field: "metadata.rent", fields: ["metadata.rent"] };

		// Pages of 2 put a page boundary between the last number and `false`, and between `true` and the
		// first text.
		const pages: Array<Array<string | number | boolean | null | undefined>> = [];
		let cursor: string | null = null;
		do {
			const page = await query_files(t, session.token, { ...body, limit: 2, cursor });
			expect(page.status, JSON.stringify(page.body)).toBe(200);
			pages.push(page.body.items.map((item) => item.fields["metadata.rent"]?.value));
			cursor = page.body.cursor;
			expect(pages.length).toBeLessThan(10);
		} while (cursor !== null);
		expect(pages.flat(), "the full order: numbers, false, true, text").toEqual(values);

		const eq_paths = async (eq: string | number) => {
			const page = await query_files(t, session.token, { ...body, match: { eq } });
			expect(page.status, JSON.stringify(page.body)).toBe(200);
			return page.body.items.map((item) => item.path);
		};
		expect(await eq_paths(850), "eq 850 finds the number only").toEqual(["/listings/f-5.md"]);
		expect(await eq_paths("850"), 'eq "850" finds the text only').toEqual(["/listings/f-8.md"]);
	});

	test("folder mode with eq true returns only the files whose value is the boolean true", async () => {
		const t = test_convex();
		const fixture = await install_gallery_plugin(t);
		await seed_query_files(t, fixture, [
			{ path: "listings/a.md", metadata: [{ key: "ideal", value: true }] },
			{ path: "listings/b.md", metadata: [{ key: "ideal", value: false }] },
			{ path: "listings/c.md", metadata: [{ key: "ideal", value: "true" }] },
			{ path: "listings/d.md", metadata: [{ key: "ideal", value: 1 }] },
			{ path: "listings/e.md", metadata: [{ key: "other", value: true }] },
			{ path: "listings/f.md", metadata: [{ key: "ideal", value: true }] },
		]);
		const session = await mint_session_token(fixture);

		const page = await query_files(t, session.token, {
			mode: "folder",
			path: "/listings",
			field: "metadata.ideal",
			match: { eq: true },
		});
		expect(page.status, JSON.stringify(page.body)).toBe(200);
		// Folder mode compares values by the folder table's sort key, which keeps the type of the stored
		// value (see "Field queries" in the public-api skill). So only the boolean true matches. The
		// text "true", false, 1 and another key do not.
		expect(page.body.items.map((item) => item.path)).toEqual(["/listings/a.md", "/listings/f.md"]);

		const text = await query_files(t, session.token, {
			mode: "folder",
			path: "/listings",
			field: "metadata.ideal",
			match: { eq: "true" },
		});
		expect(text.status, JSON.stringify(text.body)).toBe(200);
		expect(text.body.items.map((item) => item.path)).toEqual(["/listings/c.md"]);
	});
});
