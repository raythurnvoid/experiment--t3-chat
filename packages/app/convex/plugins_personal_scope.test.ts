import { R2 } from "@convex-dev/r2";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import { crypto_sha256_hex } from "../server/crypto-utils.ts";
import type { api_schemas_Main } from "../shared/api-schemas.ts";
import type { plugins_Capability } from "../shared/plugins.ts";

const PLUGIN_NAME = "private-notes";
const SERVICE_SECRET = "personal-scope-test-secret";
const ROOT = "/plugin-imports";
const PATH = `${ROOT}/notes.txt`;
const r2Objects = new Map<string, BodyInit>();

beforeEach(() => {
	r2Objects.clear();
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (key) => ({
		key: key!,
		url: `https://r2.test/object?key=${encodeURIComponent(key!)}`,
	}));
	vi.spyOn(R2.prototype, "getUrl").mockImplementation(
		async (key) => `https://r2.test/object?key=${encodeURIComponent(key)}`,
	);
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	vi.stubGlobal(
		"fetch",
		vi.fn<typeof fetch>(async (input, init) => {
			const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
			if (url.origin !== "https://r2.test") throw new Error("Unexpected external request");
			const key = url.searchParams.get("key")!;
			if (init?.method === "PUT") {
				r2Objects.set(key, init.body ?? "");
				return new Response(null);
			}
			const body = r2Objects.get(key);
			return body === undefined ? new Response(null, { status: 404 }) : new Response(body);
		}),
	);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function fixture() {
	const t = test_convex();
	const personal = await t.run((ctx) =>
		test_mocks_fill_db_with.membership(ctx, { organizationName: "personal", workspaceName: "home" }),
	);
	const team = await t.run((ctx) =>
		test_mocks_fill_db_with.membership(ctx, { userId: personal.userId, organizationName: "plugin-team" }),
	);
	const actor = t.withIdentity({ issuer: "https://clerk.test", external_id: personal.userId });
	const capabilities: plugins_Capability[] = [
		"plugin.service.connect",
		"workspace.files.read",
		"workspace.files.write",
		"workspace.files.own-write",
		"workspace.files.own-access",
	];
	// Seed reviewed artifacts only. Sessions, grants, writers and files use public doors below.
	const pluginVersionId = await t.run(async (ctx) => {
		const now = Date.now();
		await ctx.db.insert("plugins_service_registrations", {
			pluginName: PLUGIN_NAME,
			exchangeSecretHash: await crypto_sha256_hex(SERVICE_SECRET),
			scopes: ["files:write"],
			createdBy: personal.userId,
			updatedAt: now,
		});
		return await ctx.db.insert("plugins_versions", {
			name: PLUGIN_NAME,
			displayName: "Private notes",
			version: "1.0.0",
			description: "Private import scope test",
			reviewStatus: "passed",
			reviewId: null,
			isLatest: true,
			artifactHash: `sha256:${"a".repeat(64)}`,
			sourceRepositoryUrl: "https://github.com/bonobo/private-notes",
			sourceOwner: "bonobo",
			sourceRepo: PLUGIN_NAME,
			sourceCommitSha: "1234567890abcdef1234567890abcdef12345678",
			manifestR2Key: "plugins/private-notes/manifest.json",
			backendEntrypointFile: null,
			configuration: null,
			events: [],
			capabilities,
			pages: [{ id: "notes", title: "Notes", entry: "index.html", navItem: null }],
			fileViews: [],
			outboundOrigins: [],
			uiOutboundOrigins: [],
			files: [
				{
					path: "index.html",
					sha256: `sha256:${"b".repeat(64)}`,
					bytes: 12,
					contentType: "text/html",
					r2Key: "plugins/private-notes/index.html",
				},
			],
			sourceStatus: "ready",
			sourceLastError: null,
			createdBy: personal.userId,
			updatedAt: now,
		});
	});

	async function connect(scope: typeof personal) {
		const installed = await actor.mutation(api.plugins.install_version, {
			membershipId: scope.membershipId,
			pluginVersionId,
			acceptedCapabilities: capabilities,
			acceptedOutboundOrigins: [],
			acceptedUiOutboundOrigins: [],
			serviceAccountGrants: [{ resource: { kind: "workspace" }, level: "manage" }],
		});
		if (installed._nay) throw new Error(installed._nay.message);
		const session = await actor.action(api.plugins_ui.mint_page_session, {
			membershipId: scope.membershipId,
			pluginName: PLUGIN_NAME,
		});
		if (session._nay) throw new Error(session._nay.message);
		const pageHeaders = { Authorization: `Bearer ${session._yay.token}`, "Content-Type": "application/json" };
		const exchanged = await t.fetch("/api/v1/plugins/service-grants/exchange", {
			method: "POST",
			headers: { ...pageHeaders, "X-Bonobo-Service-Authorization": `Bearer ${SERVICE_SECRET}` },
			body: JSON.stringify({}),
		});
		expect(exchanged.status, await exchanged.clone().text()).toBe(200);
		const interactive =
			(await exchanged.json()) as api_schemas_Main["/api/v1/plugins/service-grants/exchange"]["POST"]["response"][200]["body"];
		expect(interactive).toMatchObject({
			actorUserId: personal.userId,
			organizationId: scope.organizationId,
			workspaceId: scope.workspaceId,
			installationId: installed._yay.installationId,
			scopes: [],
		});
		const interactiveHeaders = {
			...pageHeaders,
			Authorization: `Bearer ${interactive.token}`,
			"X-Bonobo-Service-Authorization": `Bearer ${SERVICE_SECRET}`,
		};
		const sealed = await t.fetch("/api/v1/plugins/service-grants/seal-processing", {
			method: "POST",
			headers: interactiveHeaders,
			body: JSON.stringify({ destinationPathPrefix: ROOT }),
		});
		expect(sealed.status, await sealed.clone().text()).toBe(200);
		const processing =
			(await sealed.json()) as api_schemas_Main["/api/v1/plugins/service-grants/seal-processing"]["POST"]["response"][200]["body"];
		expect(processing).toMatchObject({
			actorUserId: personal.userId,
			organizationId: scope.organizationId,
			workspaceId: scope.workspaceId,
			installationId: installed._yay.installationId,
			destinationPathPrefix: ROOT,
			scopes: ["files:write"],
		});
		const serviceHeaders = { ...interactiveHeaders, Authorization: `Bearer ${processing.token}` };
		const ensured = await t.fetch("/api/v1/files/plugin-folders/ensure", {
			method: "POST",
			headers: serviceHeaders,
			body: JSON.stringify({ path: ROOT, writer: { resourceKey: "notes", rootNodeId: null } }),
		});
		expect(ensured.status, await ensured.clone().text()).toBe(200);
		const root =
			(await ensured.json()) as api_schemas_Main["/api/v1/files/plugin-folders/ensure"]["POST"]["response"][200]["body"];
		if (!root.writer) throw new Error("Expected a conditional writer");
		return {
			...scope,
			installationId: installed._yay.installationId,
			pageHeaders,
			interactiveHeaders,
			serviceHeaders,
			root: { ...root, writer: root.writer },
		};
	}
	const home = await connect(personal);
	const shared = await connect(team);
	expect(home.installationId).not.toBe(shared.installationId);

	async function write(scope: typeof home, path: string, content: string) {
		const body = {
			path,
			content,
			contentType: "text/plain",
			nonCollaborative: true,
			expectedParentNodeId: scope.root.writer.folderNodeId,
			writer: {
				writerId: scope.root.writer.writerId,
				operationId: path,
				writerGeneration: scope.root.writer.writerGeneration,
				sequence: 1,
				expectedNodeId: null,
				expectedContentRevision: null,
				expectedReaderRevision: null,
				contentHash: await crypto_sha256_hex(content),
			},
		};
		const response = await t.fetch("/api/v1/files/write", {
			method: "POST",
			headers: scope.serviceHeaders,
			body: JSON.stringify(body),
		});
		expect(response.status, await response.clone().text()).toBe(200);
		const saved = (await response.json()) as api_schemas_Main["/api/v1/files/write"]["POST"]["response"][200]["body"];
		expect(saved.receipt).toBeDefined();
		expect(await t.run((ctx) => ctx.db.get("files_nodes", saved.nodeId))).toMatchObject({
			organizationId: scope.organizationId,
			workspaceId: scope.workspaceId,
			path,
			collaborationEnabled: false,
		});
		expect(
			await actor.query(api.files_nodes_content.get_non_collaborative_file_content, {
				membershipId: scope.membershipId,
				nodeId: saved.nodeId,
			}),
		).toEqual({ _yay: { text: content, textKind: "plain_text" } });
		return { body, saved };
	}
	const homeFile = await write(home, PATH, "HOME_PRIVATE_IMPORT\n");
	const teamFile = await write(shared, PATH, "TEAM_IMPORT\n");
	return { t, actor, home, team: shared, homeFile, teamFile, write };
}

describe("personal plugin scope", () => {
	test("binds real page, exchange and seal grants to each installation and refuses scope overrides", async () => {
		const f = await fixture();
		const sessions = await f.t.run((ctx) => ctx.db.query("plugins_ui_sessions").collect());
		const grants = await f.t.run((ctx) => ctx.db.query("plugin_service_grants").collect());
		expect(sessions).toHaveLength(2);
		expect(new Set(sessions.map((session) => session.serviceAccountId)).size).toBe(2);
		expect(grants).toHaveLength(4);
		for (const scope of [f.home, f.team]) {
			expect(sessions.filter((session) => session.installationId === scope.installationId)).toMatchObject([
				{ userId: f.home.userId, organizationId: scope.organizationId, workspaceId: scope.workspaceId },
			]);
			expect(grants.filter((grant) => grant.installationId === scope.installationId)).toHaveLength(2);
			for (const grant of grants.filter((grant) => grant.installationId === scope.installationId))
				expect(grant).toMatchObject({
					actorUserId: f.home.userId,
					organizationId: scope.organizationId,
					workspaceId: scope.workspaceId,
				});
			const verified = await f.t.fetch("/api/v1/plugins/service-grants/verify-live", {
				method: "POST",
				headers: scope.serviceHeaders,
				body: JSON.stringify({
					installationId: scope.installationId,
					phase: "processing",
					destinationPathPrefix: ROOT,
					scopes: ["files:write"],
				}),
			});
			expect(verified.status, await verified.clone().text()).toBe(200);
		}
		const foreign = await f.t.fetch("/api/v1/plugins/service-grants/verify-live", {
			method: "POST",
			headers: f.team.serviceHeaders,
			body: JSON.stringify({
				installationId: f.home.installationId,
				phase: "processing",
				destinationPathPrefix: ROOT,
				scopes: ["files:write"],
			}),
		});
		expect(foreign.status).toBe(409);
		expect(await foreign.json()).toEqual({ message: "This grant is for another installation" });
		for (const field of ["organizationId", "workspaceId", "installationId"] as const) {
			for (const request of [
				{
					path: "/api/v1/plugins/service-grants/exchange",
					headers: { ...f.team.pageHeaders, "X-Bonobo-Service-Authorization": `Bearer ${SERVICE_SECRET}` },
					body: {},
				},
				{
					path: "/api/v1/plugins/service-grants/seal-processing",
					headers: f.team.interactiveHeaders,
					body: { destinationPathPrefix: ROOT },
				},
			]) {
				const refused = await f.t.fetch(request.path, {
					method: "POST",
					headers: request.headers,
					body: JSON.stringify({ ...request.body, [field]: f.home[field] }),
				});
				expect(refused.status, await refused.clone().text()).toBe(400);
			}
		}
		expect(await f.t.run((ctx) => ctx.db.query("plugin_service_grants").collect())).toEqual(grants);
	});

	test("a team page cannot read or sign home files even when its actor can read both", async () => {
		const f = await fixture();
		const onlyHome = await f.write(f.home, `${ROOT}/home-only.txt`, "HOME_ONLY_IMPORT\n");
		const homeRead = await f.t.fetch("/api/v1/files/read", {
			method: "POST",
			headers: f.home.pageHeaders,
			body: JSON.stringify({ path: PATH, maxBytes: 1024 }),
		});
		expect(homeRead.status, await homeRead.clone().text()).toBe(200);
		const homeBody = await homeRead.json();
		expect(homeBody).toMatchObject({
			content: "HOME_PRIVATE_IMPORT\n",
			target: { kind: "saved", id: f.homeFile.saved.nodeId },
		});
		// This header selects tokens only inside the trusted runner, not in a direct plugin API call.
		const teamRead = await f.t.fetch("/api/v1/files/read", {
			method: "POST",
			headers: { ...f.team.pageHeaders, "X-Bonobo-Workspace": "personal" },
			body: JSON.stringify({ path: PATH, maxBytes: 1024, workspaceId: f.home.workspaceId }),
		});
		expect(teamRead.status, await teamRead.clone().text()).toBe(200);
		const teamBody = await teamRead.json();
		expect(teamBody).toMatchObject({
			content: "TEAM_IMPORT\n",
			target: { kind: "saved", id: f.teamFile.saved.nodeId },
		});
		expect(JSON.stringify(teamBody)).not.toContain("HOME_PRIVATE_IMPORT");
		const missing = await f.t.fetch("/api/v1/files/read", {
			method: "POST",
			headers: f.team.pageHeaders,
			body: JSON.stringify({ path: onlyHome.body.path, maxBytes: 1024 }),
		});
		expect(missing.status).toBe(404);
		expect(await missing.json()).toEqual({ message: "File not found or exceeds the read limit." });
		const listed = await f.t.fetch("/api/v1/files/list", {
			method: "POST",
			headers: f.team.pageHeaders,
			body: JSON.stringify({ path: ROOT, recursive: true, kind: "file", limit: 10 }),
		});
		expect(listed.status, await listed.clone().text()).toBe(200);
		const listing = (await listed.json()) as api_schemas_Main["/api/v1/files/list"]["POST"]["response"][200]["body"];
		expect(listing.isDone).toBe(true);
		expect(listing.items).toHaveLength(1);
		expect(listing.items[0]).toMatchObject({ path: PATH });
		expect(JSON.stringify(listing)).not.toContain(f.homeFile.saved.nodeId);
		expect(JSON.stringify(listing)).not.toContain(onlyHome.saved.nodeId);
		const downloads = await f.t.fetch("/api/v1/files/download-urls", {
			method: "POST",
			headers: f.team.pageHeaders,
			body: JSON.stringify({ fileNodeIds: [f.teamFile.saved.nodeId, f.homeFile.saved.nodeId], expiresInSeconds: 60 }),
		});
		expect(downloads.status, await downloads.clone().text()).toBe(200);
		const signed =
			(await downloads.json()) as api_schemas_Main["/api/v1/files/download-urls"]["POST"]["response"][200]["body"];
		expect(signed.items.map((item) => item.fileNodeId)).toEqual([f.teamFile.saved.nodeId]);
		expect(signed.errors).toEqual([{ fileNodeId: f.homeFile.saved.nodeId, message: "Not found" }]);
	});

	test("a team service cannot inspect or publish with home writer, parent or file IDs", async () => {
		const f = await fixture();
		for (const [scope, file] of [
			[f.home, f.homeFile],
			[f.team, f.teamFile],
		] as const) {
			const inspected = await f.t.fetch("/api/v1/files/plugin-writers/inspect", {
				method: "POST",
				headers: scope.serviceHeaders,
				body: JSON.stringify({ writerId: scope.root.writer.writerId, path: PATH, maxBytes: 1024 }),
			});
			expect(inspected.status, await inspected.clone().text()).toBe(200);
			expect(await inspected.json()).toMatchObject({ nodeId: file.saved.nodeId, content: file.body.content });
		}
		const foreign = await f.t.fetch("/api/v1/files/plugin-writers/inspect", {
			method: "POST",
			headers: f.team.serviceHeaders,
			body: JSON.stringify({ writerId: f.home.root.writer.writerId, path: PATH, maxBytes: 1024 }),
		});
		expect(foreign.status).toBe(403);
		expect(await foreign.json()).toEqual({ message: "Permission denied" });
		async function stored() {
			return await f.t.run(async (ctx) => ({
				nodes: await ctx.db.query("files_nodes").collect(),
				chunks: await ctx.db.query("files_text_chunks").collect(),
				assets: await ctx.db.query("files_r2_assets").collect(),
				stages: await ctx.db.query("public_api_file_write_stages").collect(),
				writers: await ctx.db.query("plugins_external_file_writers").collect(),
				receipts: await ctx.db.query("plugins_external_file_receipts").collect(),
			}));
		}
		const before = await stored();
		const objectsBefore = new Map(r2Objects);
		// Keep the same valid team path and service proof. Only the pinned home identity changes.
		const body = {
			...f.teamFile.body,
			content: "REPLACED_BY_TEAM\n",
			writer: {
				...f.teamFile.body.writer,
				operationId: "foreign-replacement",
				sequence: 2,
				expectedNodeId: f.teamFile.saved.nodeId,
				expectedContentRevision: f.teamFile.saved.receipt!.contentRevision,
				contentHash: await crypto_sha256_hex("REPLACED_BY_TEAM\n"),
			},
		};
		for (const [request, status] of [
			[{ ...body, writer: { ...body.writer, writerId: f.home.root.writer.writerId } }, 403],
			[{ ...body, expectedParentNodeId: f.home.root.writer.folderNodeId }, 409],
			[
				{
					...body,
					writer: {
						...body.writer,
						expectedNodeId: f.homeFile.saved.nodeId,
						expectedContentRevision: f.homeFile.saved.receipt!.contentRevision,
					},
				},
				409,
			],
		] as const) {
			const refused = await f.t.fetch("/api/v1/files/write", {
				method: "POST",
				headers: f.team.serviceHeaders,
				body: JSON.stringify(request),
			});
			expect(refused.status, await refused.clone().text()).toBe(status);
			expect(await stored()).toEqual(before);
			expect(r2Objects).toEqual(objectsBefore);
		}
		const local = await f.t.fetch("/api/v1/files/write", {
			method: "POST",
			headers: f.team.serviceHeaders,
			body: JSON.stringify(body),
		});
		expect(local.status, await local.clone().text()).toBe(200);
		expect(
			await f.actor.query(api.files_nodes_content.get_non_collaborative_file_content, {
				membershipId: f.team.membershipId,
				nodeId: f.teamFile.saved.nodeId,
			}),
		).toMatchObject({ _yay: { text: body.content } });
		expect(
			await f.actor.query(api.files_nodes_content.get_non_collaborative_file_content, {
				membershipId: f.home.membershipId,
				nodeId: f.homeFile.saved.nodeId,
			}),
		).toMatchObject({ _yay: { text: f.homeFile.body.content } });
	});
});
