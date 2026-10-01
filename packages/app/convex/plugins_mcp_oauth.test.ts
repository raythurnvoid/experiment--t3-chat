import { R2 } from "@convex-dev/r2";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { plugins_mcp_grant_additional_data } from "./plugins_mcp.ts";
import { plugins_mcp_oauth_get_access_token } from "./plugins_mcp_oauth.ts";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import { crypto_decrypt_secret_value, crypto_encrypt_secret_value } from "../server/crypto-utils.ts";
import { mcp_client_list_tools } from "../server/mcp-client.ts";
import { mcp_oauth_fixtures_create } from "../server/mcp-fixtures/mcp-oauth-fixtures.ts";
import { ai_chat_tool_create_mcp_tools } from "../server/server-ai-tools.ts";
import type { ai_chat_McpToolOutput } from "../shared/ai-chat-files.ts";
import { ai_chat_DEFAULT_MODEL_ID } from "../shared/ai-chat.ts";

const APP_BASE_URL = "https://app.press.test";
const CLIENT_DOCUMENT_URL = `${APP_BASE_URL}/oauth/mcp/client.json`;
const REDIRECT_URI = `${APP_BASE_URL}/oauth/mcp/callback`;
const SERVER_A = "https://mcp-a.oauth.test/mcp";
const RETURN_PATH = "/w/test-organization/home/mcp-servers";

let fixtures: ReturnType<typeof mcp_oauth_fixtures_create>;
// A test sets this to hold every request to one path until the promise resolves.
let gate: { path: string; promise: Promise<void>; reached: boolean; onRequest?: () => void } | null = null;

beforeEach(() => {
	fixtures = mcp_oauth_fixtures_create();
	gate = null;
	vi.stubEnv("APP_BASE_URL", APP_BASE_URL);
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "info").mockImplementation(() => {});
	// Fake only the clock, so a test can refill the one-per-member sign-in rate limit.
	vi.useFakeTimers({ toFake: ["Date"] });
	// Only the fake sign-in server, its MCP servers, and the app's client document answer. Any other
	// outside request would be a bug in the test.
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const request = new Request(input, init);
			const url = new URL(request.url);
			if (url.href === CLIENT_DOCUMENT_URL) {
				return Response.json({ client_id: CLIENT_DOCUMENT_URL, redirect_uris: [REDIRECT_URI] });
			}
			if (!url.hostname.endsWith(".oauth.test")) {
				return new Response(null, { status: 404 });
			}
			if (gate && url.pathname === gate.path) {
				gate.reached = true;
				gate.onRequest?.();
				await gate.promise;
			}
			return await fixtures.fetch(request);
		}),
	);
});

afterEach(async () => {
	await fixtures.close();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

type TestConvex = ReturnType<typeof test_convex>;
type Member = Awaited<ReturnType<typeof add_member>>;

function user_identity(userId: Id<"users">) {
	return { issuer: "https://clerk.test", external_id: userId };
}

/**
 * Let one more sign-in start. The start bucket allows two in a row per member.
 */
function next_minute() {
	vi.setSystemTime(Date.now() + 60_000);
}

async function setup() {
	const t = test_convex();
	const owner = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx, { workspaceName: "home" }));
	return { t, owner: { ...owner, asUser: t.withIdentity(user_identity(owner.userId)) } };
}

/**
 * Invite a new user into the owner's workspace as a member.
 */
async function add_member(t: TestConvex, owner: Awaited<ReturnType<typeof setup>>["owner"]) {
	const user = await t.run((ctx) =>
		test_mocks_fill_db_with.membership(ctx, { organizationName: "personal", workspaceName: "home" }),
	);
	const invited = await owner.asUser.mutation(api.organizations.invite_user_to_organization_workspace, {
		organizationId: owner.organizationId,
		workspaceId: owner.workspaceId,
		userIdToAdd: user.userId,
	});
	if (invited._nay) throw new Error(invited._nay.message);

	const membership = await t.run((ctx) =>
		ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_workspace_user_active", (q) =>
				q.eq("workspaceId", owner.workspaceId).eq("userId", user.userId).eq("active", true),
			)
			.first(),
	);
	if (!membership) throw new Error("Expected invited membership");
	return {
		userId: user.userId,
		organizationId: owner.organizationId,
		workspaceId: owner.workspaceId,
		membershipId: membership._id,
		asUser: t.withIdentity(user_identity(user.userId)),
	};
}

/**
 * Insert a plugin version whose one MCP server `tracker` signs in at the fixture sign-in server,
 * its installation, and the server doc install writes.
 */
async function install_oauth_plugin(t: TestConvex, member: Pick<Member, "organizationId" | "workspaceId" | "userId">) {
	const now = Date.now();
	return await t.run(async (ctx) => {
		const pluginVersionId = await ctx.db.insert("plugins_versions", {
			name: "tracker",
			displayName: "Tracker",
			version: "1.0.0",
			description: "",
			reviewStatus: "passed",
			reviewId: null,
			isLatest: true,
			artifactHash: "hash",
			sourceRepositoryUrl: "https://github.test/acme/tracker",
			sourceOwner: "acme",
			sourceRepo: "tracker",
			sourceCommitSha: "sha",
			manifestR2Key: "manifest",
			backendEntrypointFile: null,
			configuration: null,
			mounts: [],
			events: [],
			pages: [],
			fileViews: [],
			capabilities: ["agent.mcp.connect"],
			outboundOrigins: [],
			uiOutboundOrigins: [],
			mcpServers: [
				{
					id: "tracker",
					title: "Tracker",
					transport: "http",
					url: SERVER_A,
					headers: [],
					auth: { kind: "oauth", issuer: fixtures.issuer(), resource: null, scopes: ["mcp:write"] },
					tools: null,
				},
			],
			mcpServersFingerprint: "mcp-servers-hash",
			skills: [],
			files: [],
			sourceStatus: "ready",
			sourceLastError: null,
			createdBy: member.userId,
			updatedAt: now,
		});
		const installationId = await ctx.db.insert("plugins_workspace_installations", {
			serviceAccountId: await ctx.db.insert("access_control_service_accounts", {
				organizationId: member.organizationId,
				workspaceId: member.workspaceId,
				name: "tracker",
				createdBy: member.userId,
				createdAt: now,
				updatedAt: now,
				revokedAt: null,
			}),
			organizationId: member.organizationId,
			workspaceId: member.workspaceId,
			pluginVersionId,
			pluginName: "tracker",
			status: "enabled",
			managementAccess: "selected",
			configurationYaml: null,
			acceptedCapabilities: ["agent.mcp.connect"],
			capabilitiesAcceptedAt: now,
			acceptedOutboundOrigins: [],
			acceptedUiOutboundOrigins: [],
			acceptedMcpServersFingerprint: "mcp-servers-hash",
			acceptedSkillNames: [],
			outboundOriginsAcceptedAt: now,
			installedBy: member.userId,
			updatedBy: member.userId,
			updatedAt: now,
		});
		await ctx.db.insert("plugins_mcp_servers", {
			organizationId: member.organizationId,
			workspaceId: member.workspaceId,
			installationId,
			serverId: "tracker",
			toolPrefix: "tracker",
			destinationFingerprint: "fingerprint-tracker",
			failures: 0,
			unhealthyUntil: null,
		});
		return { kind: "plugin" as const, installationId, serverId: "tracker" };
	});
}

/**
 * Save the member's own server at `url` through the real `save`, so a server that asks for sign-in
 * gets its pin.
 */
async function save_custom_server(member: Pick<Member, "asUser" | "membershipId">, url = SERVER_A) {
	const saved = await member.asUser.action(api.mcp_custom_servers.save, {
		membershipId: member.membershipId,
		customServerId: null,
		text: JSON.stringify({ mcpServers: { tracker: { url } } }),
		draftKey: "tracker",
		fill: { name: "tracker", urlFields: [], notSecretHeaders: [], secretValues: [], keptSecretNames: [] },
	});
	if (saved._nay) throw new Error(saved._nay.message);
	return { kind: "custom" as const, customServerId: saved._yay.customServerId };
}

async function start(
	member: Pick<Member, "asUser" | "membershipId">,
	target:
		| { kind: "plugin"; installationId: Id<"plugins_workspace_installations">; serverId: string }
		| {
				kind: "custom";
				customServerId: Id<"mcp_custom_servers">;
		  },
) {
	return await member.asUser.action(api.plugins_mcp_oauth.start, {
		membershipId: member.membershipId,
		target,
		returnPath: RETURN_PATH,
	});
}

/**
 * Start, sign in at the fixture sign-in server, and return what the callback page would send.
 */
async function sign_in(member: Pick<Member, "asUser" | "membershipId">, target: Parameters<typeof start>[1]) {
	const started = await start(member, target);
	if (started._nay) throw new Error(started._nay.message);

	const callback = await fixtures.authorize(started._yay.authorizationUrl);
	return { started: started._yay, callback };
}

function finish(args: {
	member: Pick<Member, "asUser">;
	callback: { code: string; state: string; iss: string | null };
	error?: string | null;
}) {
	const { member, callback, error = null } = args;

	return member.asUser.action(api.plugins_mcp_oauth.finish, {
		state: callback.state,
		code: callback.code,
		iss: callback.iss,
		error,
	});
}

async function read_all(t: TestConvex) {
	return await t.run(async (ctx) => ({
		pending: await ctx.db.query("plugins_mcp_oauth_pending").collect(),
		grants: await ctx.db.query("plugins_mcp_oauth_grants").collect(),
		clients: await ctx.db.query("plugins_mcp_oauth_clients").collect(),
		revocations: await ctx.db.query("plugins_mcp_oauth_revocations").collect(),
		customServers: await ctx.db.query("mcp_custom_servers").collect(),
	}));
}

describe("start", () => {
	test("returns the sign-in URL and stores the pending sign-in with the verifier encrypted", async () => {
		const { t, owner } = await setup();
		const target = await install_oauth_plugin(t, owner);

		const started = await start(owner, target);

		expect(started._yay?.authorizationHost).toBe("as.oauth.test");
		const url = new URL(started._yay!.authorizationUrl);
		expect(url.origin + url.pathname).toBe("https://as.oauth.test/authorize");
		expect(Object.fromEntries(url.searchParams)).toMatchObject({
			redirect_uri: REDIRECT_URI,
			resource: SERVER_A,
			code_challenge_method: "S256",
			scope: "mcp:read mcp:write offline_access",
		});
		const { pending, clients } = await read_all(t);
		expect(pending).toHaveLength(1);
		expect(pending[0]).toMatchObject({
			userId: owner.userId,
			target,
			resource: SERVER_A,
			issuer: fixtures.issuer(),
			returnPath: RETURN_PATH,
			clientKind: "dcr",
		});
		// The state and the verifier are never stored in clear.
		const state = url.searchParams.get("state")!;
		expect(JSON.stringify(pending)).not.toContain(state);
		expect(pending[0]!.codeVerifier.ciphertext.byteLength).toBeGreaterThan(0);
		expect(clients).toHaveLength(1);
		expect(clients[0]!.clientSecret).toBeNull();
	});

	test("uses the app's client document when the sign-in server accepts one (CIMD)", async () => {
		const { t, owner } = await setup();
		const target = await install_oauth_plugin(t, owner);
		fixtures.switches.cimd = true;

		const started = await start(owner, target);

		expect(new URL(started._yay!.authorizationUrl).searchParams.get("client_id")).toBe(CLIENT_DOCUMENT_URL);
		expect((await read_all(t)).clients).toEqual([]);
	});

	test("reuses a registered client, and stores a DCR secret encrypted", async () => {
		const { t, owner } = await setup();
		const target = await install_oauth_plugin(t, owner);
		fixtures.switches.tokenAuthMethods = ["client_secret_basic"];

		await start(owner, target);
		next_minute();
		await start(owner, target);

		expect(fixtures.counts.register).toBe(1);
		const [client] = (await read_all(t)).clients;
		expect(client!.tokenEndpointAuthMethod).toBe("client_secret_basic");
		const secret = await crypto_decrypt_secret_value({
			secret: client!.clientSecret!,
			additionalData: `client:${client!.issuer}:${client!.clientId}`,
			keyName: "MCP_SECRETS_ENCRYPTION_KEY",
		});
		expect(secret).toMatch(/^secret-/u);
	});

	test("refuses a return path that leaves the app", async () => {
		const { t, owner } = await setup();
		const target = await install_oauth_plugin(t, owner);

		for (const returnPath of ["https://evil.test/", "//evil.test/", "/\\evil.test"]) {
			const started = await owner.asUser.action(api.plugins_mcp_oauth.start, {
				membershipId: owner.membershipId,
				target,
				returnPath,
			});
			expect(started, returnPath).toEqual({ _nay: { message: "Invalid return path" } });
		}
	});

	test("refuses another member's own server and writes nothing", async () => {
		const { t, owner } = await setup();
		const member = await add_member(t, owner);
		const target = await save_custom_server(owner);

		const started = await start(member, target);

		expect(started).toEqual({ _nay: { message: "This MCP server is no longer available." } });
		expect((await read_all(t)).pending).toEqual([]);
	});

	test("checks the member again before it stores the pending sign-in", async () => {
		const { t, owner } = await setup();
		const member = await add_member(t, owner);
		const target = await install_oauth_plugin(t, owner);
		let release!: () => void;
		gate = {
			path: "/.well-known/oauth-authorization-server",
			promise: new Promise((resolve) => (release = resolve)),
			reached: false,
		};

		const started = start(member, target);
		await vi.waitFor(() => expect(gate?.reached).toBe(true));
		await t.run((ctx) => ctx.db.patch("organizations_workspaces_users", member.membershipId, { active: false }));
		release();

		expect(await started).toEqual({ _nay: { message: "You cannot use MCP servers in this workspace." } });
		expect((await read_all(t)).pending).toEqual([]);
	});

	test("late pin: pins a server saved with no sign-in, then starts", async () => {
		const { t, owner } = await setup();
		fixtures.switches.serverTokenOnlyForCall = true;
		const target = await save_custom_server(owner);
		const before = (await read_all(t)).customServers[0]!;
		expect(before.auth).toEqual({ kind: "none" });

		const started = await start(owner, target);

		expect(started._yay?.authorizationHost).toBe("as.oauth.test");
		const after = (await read_all(t)).customServers[0]!;
		expect(after.auth).toEqual({
			kind: "oauth",
			issuer: fixtures.issuer(),
			resource: SERVER_A,
			authorizationHost: "as.oauth.test",
		});
		expect(after.destinationFingerprint).not.toBe(before.destinationFingerprint);
		// The tool list still works with no token, so the pin must not record a failed test.
		expect(after.lastTest).toMatchObject({ outcome: "ok", toolCount: before.lastTest!.toolCount });
		expect((await read_all(t)).pending).toHaveLength(1);
	});

	test("late pin: an allowlist entry for the old fingerprint stops matching, so start refuses", async () => {
		const { t, owner } = await setup();
		fixtures.switches.serverTokenOnlyForCall = true;
		const target = await save_custom_server(owner);
		const before = (await read_all(t)).customServers[0]!;
		await t.run(async (ctx) => {
			const policy = await ctx.db
				.query("organizations_integration_policies")
				.withIndex("by_organization", (q) => q.eq("organizationId", owner.organizationId))
				.first();
			await ctx.db.patch("organizations_integration_policies", policy!._id, {
				mcpServers: {
					mode: "allowlist",
					allowlist: [
						{
							destinationFingerprint: before.destinationFingerprint,
							url: SERVER_A,
							authKind: "none",
							oauthIssuer: null,
							addedBy: owner.userId,
							addedAt: Date.now(),
						},
					],
				},
			});
		});

		const started = await start(owner, target);

		expect(started).toEqual({ _nay: { message: "Your organization's MCP policy blocks this server." } });
		const { customServers, pending } = await read_all(t);
		expect(customServers[0]!.auth.kind).toBe("oauth");
		expect(pending).toEqual([]);
	});

	test("late pin: a sign-in server without `iss` that is not trusted writes nothing", async () => {
		const { t, owner } = await setup();
		fixtures.switches.serverTokenOnlyForCall = true;
		fixtures.switches.issSupported = false;
		const target = await save_custom_server(owner);

		const refused = await start(owner, target);

		expect(refused._nay?.message).toContain("does not confirm which server answered");
		expect((await read_all(t)).customServers[0]!.auth).toEqual({ kind: "none" });
		expect((await read_all(t)).pending).toEqual([]);

		next_minute();
		vi.stubEnv("MCP_TRUSTED_ISSUERS", fixtures.issuer());
		expect((await start(owner, target))._yay).toBeTruthy();
		expect((await read_all(t)).customServers[0]!.auth.kind).toBe("oauth");
	});

	test("a stored pin wins: when PRM names another sign-in server, start refuses and asks to reconnect", async () => {
		const { t, owner } = await setup();
		const target = await save_custom_server(owner);
		const { callback } = await sign_in(owner, target);
		expect((await finish({ member: owner, callback }))._yay).toBeTruthy();

		next_minute();
		fixtures.switches.prmAuthorizationServers = ["https://other.oauth.test"];
		const started = await start(owner, target);

		expect(started).toEqual({
			_nay: { message: "This server changed its sign-in server. Delete it and add it again." },
		});
		const { grants, revocations } = await read_all(t);
		expect(grants[0]).toMatchObject({ status: "needs_reconnect", accessToken: null, refreshToken: null });
		expect(revocations).toHaveLength(1);
	});

	test.each([false, true])("an old issuer response keeps a later sign-in (existing grant: %s)", async (hasGrant) => {
		const { t, owner } = await setup();
		const target = await save_custom_server(owner);
		if (hasGrant) {
			await connect(owner, target);
			next_minute();
		}
		const before = (await read_all(t)).grants[0];
		const { callback } = await sign_in(owner, target);
		const metadataStarted = Promise.withResolvers<void>();
		const releaseMetadata = Promise.withResolvers<void>();
		const fixtureFetch = fixtures.fetch;
		let held = false;
		fixtures.switches.prmAuthorizationServers = ["https://other.oauth.test"];
		fixtures.fetch = async (input, init) => {
			const request = new Request(input, init);
			if (!held && new URL(request.url).pathname === "/.well-known/oauth-protected-resource/mcp") {
				held = true;
				// Keep the old issuer answer while a later sign-in finishes.
				const response = await fixtureFetch(request);
				metadataStarted.resolve();
				await releaseMetadata.promise;
				return response;
			}
			return await fixtureFetch(request);
		};
		const oldStart = start(owner, target);
		await metadataStarted.promise;
		try {
			fixtures.switches.prmAuthorizationServers = null;
			expect((await finish({ member: owner, callback }))._yay !== undefined).toBe(true);
			const connected = (await read_all(t)).grants[0]!;
			expect(connected.status).toBe("connected");
			if (before) {
				expect(connected._id).toBe(before._id);
				expect(connected.version).toBe(before.version + 1);
			}
		} finally {
			releaseMetadata.resolve();
		}

		expect(await oldStart).toEqual({
			_nay: { message: "This server changed its sign-in server. Delete it and add it again." },
		});
		expect((await read_all(t)).grants[0]!.status, "old issuer response kept the later sign-in").toBe("connected");
	});
});

describe("finish", () => {
	test("stores a grant whose token only the grant's own additional data decrypts", async () => {
		const { t, owner } = await setup();
		const target = await install_oauth_plugin(t, owner);
		const { callback } = await sign_in(owner, target);

		const finished = await finish({ member: owner, callback });

		expect(finished).toEqual({ _yay: { returnPath: RETURN_PATH } });
		const { grants, pending } = await read_all(t);
		expect(pending).toEqual([]);
		expect(grants).toHaveLength(1);
		const grant = grants[0]!;
		expect(grant).toMatchObject({
			userId: owner.userId,
			target,
			issuer: fixtures.issuer(),
			resource: SERVER_A,
			status: "connected",
			scope: "mcp:read mcp:write offline_access",
		});

		const additionalData = plugins_mcp_grant_additional_data(grant);
		expect(additionalData).toBe(
			`grant:plugin:${target.installationId}:tracker:${owner.userId}:${fixtures.issuer()}:${SERVER_A}`,
		);
		const accessToken = await crypto_decrypt_secret_value({
			secret: grant.accessToken!,
			additionalData,
			keyName: "MCP_SECRETS_ENCRYPTION_KEY",
		});
		await expect(
			crypto_decrypt_secret_value({
				secret: grant.accessToken!,
				additionalData: `${additionalData}x`,
				keyName: "MCP_SECRETS_ENCRYPTION_KEY",
			}),
		).rejects.toThrow();

		// The token works at server A and nowhere else.
		const listed = await mcp_client_list_tools({
			server: { url: SERVER_A, headers: [] },
			accessToken,
			timeoutMs: 5000,
			signal: new AbortController().signal,
		});
		expect(listed._yay?.tools.map((tool) => tool.name)).toEqual(["echo", "picture"]);
		const other = await mcp_client_list_tools({
			server: { url: "https://mcp-b.oauth.test/mcp", headers: [] },
			accessToken,
			timeoutMs: 5000,
			signal: new AbortController().signal,
		});
		expect(other._nay?.name).toBe("auth_required");
	});

	test("a custom server's grant uses the custom additional data", async () => {
		const { t, owner } = await setup();
		const target = await save_custom_server(owner);
		const { callback } = await sign_in(owner, target);

		expect((await finish({ member: owner, callback }))._yay).toBeTruthy();

		const grant = (await read_all(t)).grants[0]!;
		expect(plugins_mcp_grant_additional_data(grant)).toBe(
			`grant:custom:${target.customServerId}:${owner.userId}:${fixtures.issuer()}:${SERVER_A}`,
		);
		await crypto_decrypt_secret_value({
			secret: grant.accessToken!,
			additionalData: plugins_mcp_grant_additional_data(grant),
			keyName: "MCP_SECRETS_ENCRYPTION_KEY",
		});
	});

	test("another user cannot finish a sign-in, and cannot use it up either", async () => {
		const { t, owner } = await setup();
		const member = await add_member(t, owner);
		const target = await install_oauth_plugin(t, owner);
		const { callback } = await sign_in(member, target);

		const stolen = await finish({ member: owner, callback });

		expect(stolen).toEqual({ _nay: { message: "This sign-in expired. Connect again." } });
		expect((await read_all(t)).pending).toHaveLength(1);
		expect(fixtures.counts.token).toBe(0);
		expect(await finish({ member, callback })).toEqual({ _yay: { returnPath: RETURN_PATH } });
		expect((await read_all(t)).grants.map((grant) => grant.userId)).toEqual([member.userId]);
	});

	test("works once", async () => {
		const { t, owner } = await setup();
		const target = await install_oauth_plugin(t, owner);
		const { callback } = await sign_in(owner, target);

		expect((await finish({ member: owner, callback }))._yay).toBeTruthy();
		expect(await finish({ member: owner, callback })).toEqual({ _nay: { message: "This sign-in expired. Connect again." } });
	});

	test("a callback replay cannot exchange the code while the first callback waits", async () => {
		const { t, owner } = await setup();
		const target = await install_oauth_plugin(t, owner);
		const { callback } = await sign_in(owner, target);
		let release!: () => void;
		gate = { path: "/token", promise: new Promise((resolve) => (release = resolve)), reached: false };
		const first = finish({ member: owner, callback });
		await vi.waitFor(() => expect(gate?.reached).toBe(true));

		let secondRequest!: () => void;
		const requestedAgain = new Promise<void>((resolve) => (secondRequest = resolve));
		gate.onRequest = secondRequest;
		const second = finish({ member: owner, callback });
		await Promise.race([second, requestedAgain]);
		release();

		expect((await first)._yay !== undefined).toBe(true);
		expect((await second)._nay !== undefined).toBe(true);
		expect(fixtures.counts.token).toBe(1);
		expect((await read_all(t)).pending.length).toBe(0);
	});

	test.each([true, false])("Disconnect cancels a waiting exchange (existing grant: %s)", async (hasGrant) => {
		const { t, owner } = await setup();
		const target = await install_oauth_plugin(t, owner);
		if (hasGrant) {
			await connect(owner, target);
		}
		const { callback } = await sign_in(owner, target);
		let release!: () => void;
		gate = { path: "/token", promise: new Promise((resolve) => (release = resolve)), reached: false };
		const finished = finish({ member: owner, callback });
		await vi.waitFor(() => expect(gate?.reached).toBe(true));

		const disconnected = await owner.asUser.mutation(api.plugins_mcp_oauth.disconnect, {
			membershipId: owner.membershipId,
			target,
		});
		release();
		const result = await finished;

		expect(disconnected._yay === null).toBe(true);
		expect((await read_all(t)).grants.length).toBe(0);
		expect(result._nay !== undefined).toBe(true);
		expect((await read_all(t)).pending.length).toBe(0);
		await vi.waitFor(async () => expect((await read_all(t)).revocations.length).toBe(0));
		expect(fixtures.revoked.length).toBe(hasGrant ? 2 : 1);
	});

	test("refuses an expired sign-in", async () => {
		const { t, owner } = await setup();
		const target = await install_oauth_plugin(t, owner);
		const { callback } = await sign_in(owner, target);

		vi.setSystemTime(Date.now() + 11 * 60 * 1000);

		expect(await finish({ member: owner, callback })).toEqual({ _nay: { message: "This sign-in expired. Connect again." } });
	});

	test("checks `iss` before anything else (RFC 9207)", async () => {
		const { t, owner } = await setup();
		const target = await install_oauth_plugin(t, owner);
		const mismatch = { _nay: { message: "The sign-in answer came from an unexpected server. Connect again." } };

		// Each finish uses its sign-in up, so every case signs in again. The sign-in server promised
		// `iss`, so a missing one is refused, even next to an error.
		const first = await sign_in(owner, target);
		expect(await finish({ member: owner, callback: { ...first.callback, iss: null }, error: "access_denied" })).toEqual(mismatch);
		const second = await sign_in(owner, target);
		expect(await finish({ member: owner, callback: { ...second.callback, iss: "https://evil.test" } })).toEqual(mismatch);
		expect(fixtures.counts.token).toBe(0);

		next_minute();
		const third = await sign_in(owner, target);
		expect(await finish({ member: owner, callback: third.callback, error: "access_denied" })).toEqual({
			_nay: { message: "The sign-in was canceled." },
		});

		// A server that never promised `iss` may leave it out, but may not send another one.
		fixtures.switches.issSupported = false;
		vi.stubEnv("MCP_TRUSTED_ISSUERS", fixtures.issuer());
		const fourth = await sign_in(owner, target);
		expect(await finish({ member: owner, callback: { ...fourth.callback, iss: "https://evil.test" } })).toEqual(mismatch);
		next_minute();
		const fifth = await sign_in(owner, target);
		expect(fifth.callback.iss).toBeNull();
		expect((await finish({ member: owner, callback: fifth.callback }))._yay).toBeTruthy();
		expect((await read_all(t)).pending.length).toBe(0);
	});

	test.each(["no code", "failed exchange"])("clears a claimed sign-in after %s", async (failure) => {
		const { t, owner } = await setup();
		const target = await install_oauth_plugin(t, owner);
		const { callback } = await sign_in(owner, target);
		if (failure === "failed exchange") {
			fixtures.switches.tokenRedirect = "https://evil.oauth.test/token";
		}

		const result = await owner.asUser.action(api.plugins_mcp_oauth.finish, {
			state: callback.state,
			code: failure === "no code" ? null : callback.code,
			iss: callback.iss,
			error: null,
		});

		expect(result._nay !== undefined).toBe(true);
		expect((await read_all(t)).pending.length).toBe(0);
		expect(fixtures.wire.filter((entry) => entry.host === "as.oauth.test" && entry.path === "/token").length).toBe(
			failure === "no code" ? 0 : 1,
		);
	});

	test("refuses when the server moved after start", async () => {
		const { t, owner } = await setup();
		const target = await save_custom_server(owner);
		const { callback } = await sign_in(owner, target);
		await t.run((ctx) =>
			ctx.db.patch("mcp_custom_servers", target.customServerId, { destinationFingerprint: "sha256:moved" }),
		);

		expect(await finish({ member: owner, callback })).toEqual({ _nay: { message: "The server changed. Connect again." } });
		expect(fixtures.counts.token).toBe(0);
	});

	test("revokes the new token when the member was removed during the exchange", async () => {
		const { t, owner } = await setup();
		const member = await add_member(t, owner);
		const target = await install_oauth_plugin(t, owner);
		const { callback } = await sign_in(member, target);
		let release!: () => void;
		gate = { path: "/token", promise: new Promise((resolve) => (release = resolve)), reached: false };

		const finished = finish({ member, callback });
		await vi.waitFor(() => expect(gate?.reached).toBe(true));
		await t.run((ctx) => ctx.db.patch("organizations_workspaces_users", member.membershipId, { active: false }));
		release();

		expect(await finished).toEqual({ _nay: { message: "You cannot use MCP servers in this workspace." } });
		expect((await read_all(t)).grants).toEqual([]);
		// `revoke_one` runs at once and revokes the refresh token at the sign-in server.
		await vi.waitFor(async () => expect((await read_all(t)).revocations).toEqual([]));
		expect(fixtures.revoked).toHaveLength(1);
		expect(fixtures.revoked[0]).toMatch(/^refresh-/u);
	});

	test("a reconnect replaces the tokens in place", async () => {
		const { t, owner } = await setup();
		const target = await install_oauth_plugin(t, owner);
		const first = await sign_in(owner, target);
		await finish({ member: owner, callback: first.callback });
		const before = (await read_all(t)).grants[0]!;

		next_minute();
		const second = await sign_in(owner, target);
		await finish({ member: owner, callback: second.callback });

		const { grants, revocations } = await read_all(t);
		expect(grants.map((grant) => grant._id)).toEqual([before._id]);
		expect(grants[0]!.version).toBe(before.version + 1);
		expect(revocations).toEqual([]);
	});
});

/**
 * Sign in to a target and store the grant.
 */
async function connect(member: Pick<Member, "asUser" | "membershipId">, target: Parameters<typeof start>[1]) {
	const { callback } = await sign_in(member, target);
	const finished = await finish({ member, callback });
	if (finished._nay) throw new Error(finished._nay.message);
}

/**
 * Build the chat tools of one sign-in server the way a chat turn does, then run its `echo` tool once
 * per text, all at the same time.
 */
async function call_echo(args: {
	t: TestConvex;
	member: Pick<Member, "asUser" | "membershipId" | "userId" | "organizationId" | "workspaceId">;
	target: Parameters<typeof start>[1];
	texts?: string[];
}) {
	const { t, member, target, texts = ["hello"] } = args;

	const thread = await member.asUser.mutation(api.ai_chat.thread_create, {
		membershipId: member.membershipId,
		clientGeneratedId: `thread-${Math.random()}`,
		lastMessageAt: Date.now(),
	});
	if (thread._nay) throw new Error(thread._nay.message);
	const captured = await t.mutation(internal.ai_chat_workspaces.capture, {
		userId: member.userId,
		membershipId: member.membershipId,
	});
	if (captured._nay) throw new Error(captured._nay.message);
	const listed = await t.query(internal.plugins_mcp.list_turn_servers, {
		organizationId: member.organizationId,
		workspaceId: member.workspaceId,
		userId: member.userId,
		reachOrganizationIds: [member.organizationId],
	});
	const target_id = (value: Parameters<typeof start>[1]) =>
		value.kind === "plugin" ? value.installationId : value.customServerId;
	const server = listed.servers.find((candidate) => target_id(candidate.target) === target_id(target))!;

	// List the tools without a token, so the list itself never uses or refreshes the grant.
	const { serverAlwaysUnauthorized } = fixtures.switches;
	fixtures.switches.serverTokenOnlyForCall = true;
	fixtures.switches.serverAlwaysUnauthorized = false;
	const tools = await mcp_client_list_tools({
		server: { url: server.url, headers: [] },
		accessToken: null,
		timeoutMs: 5000,
		signal: new AbortController().signal,
	});
	fixtures.switches.serverTokenOnlyForCall = false;
	fixtures.switches.serverAlwaysUnauthorized = serverAlwaysUnauthorized;
	if (tools._nay) throw new Error(tools._nay.message);

	return await t.action(async (ctx) => {
		// Each call reserves output space against a running chat run.
		const begun = await ctx.runMutation(internal.ai_chat.thread_run_begin, {
			source: {
				organizationId: member.organizationId,
				workspaceId: member.workspaceId,
				userId: member.userId,
				threadId: thread._yay.threadId,
				membershipId: member.membershipId,
				membershipLifetime: captured._yay.membershipLifetime,
			},
			parentId: null,
			messages: [
				{
					clientGeneratedMessageId: "mcp-echo",
					content: { id: "mcp-echo", role: "user", parts: [{ type: "text", text: "echo" }] },
				},
			],
			modeId: "agent",
			modelId: ai_chat_DEFAULT_MODEL_ID,
		});
		if (begun._nay) throw new Error(begun._nay.message);
		const modelTools = await ai_chat_tool_create_mcp_tools({
			ctx,
			ctxData: {
				organizationId: member.organizationId,
				workspaceId: member.workspaceId,
				userId: member.userId,
				membershipId: member.membershipId,
				membershipLifetime: captured._yay.membershipLifetime,
				getThreadId: () => thread._yay.threadId,
				getRun: () => ({ runId: begun._yay.runId, generation: begun._yay.generation }),
				getModelCallId: () => "model_call_test",
				runDeadline: Date.now() + 60_000,
			},
			servers: [{ ...server, headers: [], secretValues: [], discover: tools._yay.discover, tools: tools._yay.tools }],
		});
		const echo = Object.entries(modelTools).find(([name]) => name.endsWith("__echo"))![1];
		return await Promise.all(
			texts.map((text) =>
				Promise.resolve(echo.execute!({ text }, { toolCallId: `call-${Math.random()}`, messages: [] })).then(
					(output) => ({ output: output as ai_chat_McpToolOutput, error: null }),
					(error: unknown) => ({ output: null, error: error instanceof Error ? error.message : String(error) }),
				),
			),
		);
	});
}

async function grant_access_token(t: TestConvex) {
	const grant = (await read_all(t)).grants[0]!;
	return await crypto_decrypt_secret_value({
		secret: grant.accessToken!,
		additionalData: plugins_mcp_grant_additional_data(grant),
		keyName: "MCP_SECRETS_ENCRYPTION_KEY",
	});
}

function tool_calls_to(host: string) {
	return fixtures.wire.filter((entry) => entry.host === host && entry.body.includes('"tools/call"'));
}

describe("disconnect", () => {
	test("keeps other members' and other servers' pending sign-ins", async () => {
		const { t, owner } = await setup();
		const member = await add_member(t, owner);
		const target = await install_oauth_plugin(t, owner);
		const customTarget = await save_custom_server(owner);
		await connect(owner, target);
		next_minute();
		await start(owner, target);
		await start(owner, customTarget);
		await start(member, target);
		expect((await read_all(t)).pending.length).toBe(3);

		const result = await owner.asUser.mutation(api.plugins_mcp_oauth.disconnect, {
			membershipId: owner.membershipId,
			target,
		});

		expect(result._yay === null).toBe(true);
		const { pending } = await read_all(t);
		expect(pending.length).toBe(2);
		expect(pending.some((doc) => doc.userId === member.userId && doc.target.kind === "plugin")).toBe(true);
		expect(
			pending.some(
				(doc) =>
					doc.userId === owner.userId &&
					doc.target.kind === "custom" &&
					doc.target.customServerId === customTarget.customServerId,
			),
		).toBe(true);
	});
});

describe("can_connect", () => {
	test("finds the member's plugin server and own server", async () => {
		const { t, owner } = await setup();
		const pluginTarget = await install_oauth_plugin(t, owner);
		const customTarget = await save_custom_server(owner);

		for (const target of [pluginTarget, customTarget]) {
			expect(
				await owner.asUser.query(api.plugins_mcp_oauth.can_connect, { membershipId: owner.membershipId, target }),
			).toBe(true);
		}
	});

	test("does not find a deleted server, another member's server, or an id that is not real", async () => {
		const { t, owner } = await setup();
		const member = await add_member(t, owner);
		const ownerServer = await save_custom_server(owner);
		const deleted = await save_custom_server(member);
		await t.run((ctx) => ctx.db.delete("mcp_custom_servers", deleted.customServerId));

		for (const target of [
			ownerServer,
			deleted,
			{ kind: "custom" as const, customServerId: "not-an-id" },
			{ kind: "plugin" as const, installationId: "not-an-id", serverId: "tracker" },
		]) {
			expect(
				await member.asUser.query(api.plugins_mcp_oauth.can_connect, { membershipId: member.membershipId, target }),
			).toBe(false);
		}
	});
});

describe("token use", () => {
	test("sends the member's token to its own server only, and masks it in the output", async () => {
		const { t, owner } = await setup();
		const pluginTarget = await install_oauth_plugin(t, owner);
		await connect(owner, pluginTarget);
		// A member's own server on the same sign-in server, with no grant of its own.
		const customTarget = await save_custom_server(owner, "https://mcp-b.oauth.test/mcp");
		const accessToken = await grant_access_token(t);

		const [atA] = await call_echo({ t, member: owner, target: pluginTarget, texts: [`echo ${accessToken}`] });
		const [atB] = await call_echo({ t, member: owner, target: customTarget });

		expect(atA!.output?.output).toBe("echo [secret]");
		expect(tool_calls_to("mcp-a.oauth.test").map((entry) => entry.headers.get("authorization"))).toEqual([
			`Bearer ${accessToken}`,
		]);
		expect(atB!.output?.metadata).toMatchObject({
			kind: "mcp_auth_needed",
			target: customTarget,
			reason: "needs_sign_in",
		});
		const toB = fixtures.wire.filter((entry) => entry.host === "mcp-b.oauth.test");
		expect(toB.length).toBeGreaterThan(0);
		expect(toB.every((entry) => entry.headers.get("authorization") === null)).toBe(true);
	});

	test("sends no token when the grant does not match the stored sign-in pin", async () => {
		const { t, owner } = await setup();
		const target = await install_oauth_plugin(t, owner);
		await connect(owner, target);
		// The installed version now pins another sign-in server. The grant still decrypts, so only the
		// pin check keeps its token back.
		await t.run(async (ctx) => {
			const installation = (await ctx.db.get("plugins_workspace_installations", target.installationId))!;
			const version = (await ctx.db.get("plugins_versions", installation.pluginVersionId))!;
			const server = version.mcpServers[0]!;
			await ctx.db.patch("plugins_versions", version._id, {
				mcpServers: [
					{ ...server, auth: { kind: "oauth", issuer: "https://other-as.oauth.test", resource: null, scopes: [] } },
				],
			});
		});

		const [called] = await call_echo({ t, member: owner, target });

		expect(called!.output?.metadata).toMatchObject({ kind: "mcp_auth_needed", reason: "needs_sign_in" });
		expect(
			fixtures.wire
				.filter((entry) => entry.host === "mcp-a.oauth.test")
				.every((entry) => !entry.headers.has("authorization")),
		).toBe(true);
	});

	test("refreshes a token that ends within a minute before the call", async () => {
		const { t, owner } = await setup();
		const target = await install_oauth_plugin(t, owner);
		await connect(owner, target);
		const before = (await read_all(t)).grants[0]!;
		await t.run((ctx) => ctx.db.patch("plugins_mcp_oauth_grants", before._id, { expiresAt: Date.now() + 30_000 }));

		const [called] = await call_echo({ t, member: owner, target });

		expect(called!.error).toBeNull();
		expect(fixtures.counts.refresh).toBe(1);
		const after = (await read_all(t)).grants[0]!;
		expect(after).toMatchObject({ version: before.version + 1, leaseId: null, leaseUntil: null });
		// The refresh sends the resource and the granted scope, never more.
		const refreshRequest = new URLSearchParams(
			fixtures.wire.find((entry) => entry.body.includes("refresh_token="))!.body,
		);
		expect(refreshRequest.get("resource")).toBe(SERVER_A);
		expect(refreshRequest.get("scope")).toBe(before.scope);
	});

	test("after a refused token, refreshes once and runs the call again", async () => {
		const { t, owner } = await setup();
		const target = await install_oauth_plugin(t, owner);
		await connect(owner, target);
		const grant = (await read_all(t)).grants[0]!;
		const refused = {
			...(await crypto_encrypt_secret_value({
				value: "access-refused",
				additionalData: plugins_mcp_grant_additional_data(grant),
				keyName: "MCP_SECRETS_ENCRYPTION_KEY",
			})),
			keyId: "v1" as const,
		};
		await t.run((ctx) => ctx.db.patch("plugins_mcp_oauth_grants", grant._id, { accessToken: refused }));

		const [called] = await call_echo({ t, member: owner, target });

		expect(called!.error).toBeNull();
		expect(called!.output?.metadata.kind).toBe("mcp_result");
		expect(fixtures.counts.refresh).toBe(1);
		expect((await read_all(t)).grants[0]!.status).toBe("connected");
	});

	test("a token refused right after a refresh ends the grant, with no second refresh", async () => {
		const { t, owner } = await setup();
		const target = await install_oauth_plugin(t, owner);
		await connect(owner, target);
		const grant = (await read_all(t)).grants[0]!;
		await t.run((ctx) => ctx.db.patch("plugins_mcp_oauth_grants", grant._id, { expiresAt: Date.now() - 1000 }));
		fixtures.switches.serverAlwaysUnauthorized = true;

		const [first] = await call_echo({ t, member: owner, target });
		const [second] = await call_echo({ t, member: owner, target });

		expect(first!.output?.metadata).toMatchObject({ kind: "mcp_auth_needed", reason: "needs_sign_in" });
		expect(second!.output?.metadata).toMatchObject({ kind: "mcp_auth_needed", reason: "needs_sign_in" });
		expect(fixtures.counts.refresh).toBe(1);
		const after = (await read_all(t)).grants[0]!;
		expect(after).toMatchObject({ status: "needs_reconnect", accessToken: null, refreshToken: null });
		await vi.waitFor(async () => expect((await read_all(t)).revocations).toEqual([]));
		expect(fixtures.revoked).toHaveLength(1);
	});

	test("two calls at once with an ended token make one refresh, and both work", async () => {
		const { t, owner } = await setup();
		const target = await install_oauth_plugin(t, owner);
		await connect(owner, target);
		const grant = (await read_all(t)).grants[0]!;
		await t.run((ctx) => ctx.db.patch("plugins_mcp_oauth_grants", grant._id, { expiresAt: Date.now() - 1000 }));

		const results = await call_echo({ t, member: owner, target, texts: ["one", "two"] });

		expect(results.map((result) => result.output?.output)).toEqual(["one", "two"]);
		expect(fixtures.counts.refresh).toBe(1);
		expect((await read_all(t)).grants[0]!.version).toBe(grant.version + 1);
	});

	test("`invalid_grant` on refresh ends the grant", async () => {
		const { t, owner } = await setup();
		const target = await install_oauth_plugin(t, owner);
		await connect(owner, target);
		const grant = (await read_all(t)).grants[0]!;
		await t.run((ctx) => ctx.db.patch("plugins_mcp_oauth_grants", grant._id, { expiresAt: Date.now() - 1000 }));
		fixtures.switches.refreshInvalidGrant = true;

		const [called] = await call_echo({ t, member: owner, target });

		expect(called!.output?.metadata).toMatchObject({ kind: "mcp_auth_needed", reason: "needs_sign_in" });
		expect(tool_calls_to("mcp-a.oauth.test").every((entry) => !entry.headers.has("authorization"))).toBe(true);
		expect((await read_all(t)).grants[0]).toMatchObject({ status: "needs_reconnect", accessToken: null });
		await vi.waitFor(async () => expect((await read_all(t)).revocations).toEqual([]));
	});

	test.each(["invalid_grant", "failed"])("an old refresh failure (%s) uses a newer connection", async (kind) => {
		const { t, owner } = await setup();
		const target = await install_oauth_plugin(t, owner);
		await connect(owner, target);
		const before = (await read_all(t)).grants[0]!;
		expect(before.expiresAt !== null).toBe(true);
		vi.setSystemTime(before.expiresAt! + 1);

		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const fixtureFetch = fixtures.fetch;
		let held = false;
		fixtures.switches.refreshInvalidGrant = true;
		fixtures.fetch = async (input, init) => {
			const request = new Request(input, init);
			if (
				!held &&
				new URL(request.url).pathname === "/token" &&
				(await request.clone().text()).includes("grant_type=refresh_token")
			) {
				held = true;
				const refused = await fixtureFetch(request);
				const response =
					kind === "invalid_grant" ? refused : Response.json({ error: "temporarily_unavailable" }, { status: 503 });
				fixtures.switches.refreshInvalidGrant = false;
				reached.resolve();
				await release.promise;
				return response;
			}
			return await fixtureFetch(request);
		};

		const operation = call_echo({ t, member: owner, target });
		await reached.promise;
		try {
			await connect(owner, target);
			const fresh = (await read_all(t)).grants[0]!;
			expect(fresh.status, "the new public Connect finished").toBe("connected");
			expect(fresh.version).toBe(before.version + 1);
		} finally {
			release.resolve();
		}
		const [called] = await operation;

		expect((await read_all(t)).grants[0]!.status, "the old refresh kept the new grant").toBe("connected");
		expect(called!.output?.metadata.kind, "the old refresh failure uses the newer connection").toBe("mcp_result");
		expect(called!.error).toBeNull();
		expect(called!.output?.output).toBe("hello");
		expect(fixtures.counts.refresh).toBe(1);
	});

	test("a temporary refresh failure keeps the grant and returns the error once", async () => {
		const { t, owner } = await setup();
		const target = await install_oauth_plugin(t, owner);
		await connect(owner, target);
		const before = (await read_all(t)).grants[0]!;
		vi.setSystemTime(before.expiresAt! + 1);
		const fixtureFetch = fixtures.fetch;
		let attempts = 0;
		fixtures.fetch = async (input, init) => {
			const request = new Request(input, init);
			if (
				new URL(request.url).pathname === "/token" &&
				(await request.clone().text()).includes("grant_type=refresh_token")
			) {
				attempts += 1;
				return Response.json({ error: "temporarily_unavailable" }, { status: 503 });
			}
			return await fixtureFetch(request);
		};

		const [called] = await call_echo({ t, member: owner, target });

		expect(called!.error).toBe("The sign-in server had an error.");
		expect(attempts).toBe(1);
		expect((await read_all(t)).grants[0]).toMatchObject({
			status: "connected",
			version: before.version,
			leaseId: null,
			leaseUntil: null,
		});
	});

	test("a disconnect during a refresh revokes the new tokens", async () => {
		const { t, owner } = await setup();
		const target = await install_oauth_plugin(t, owner);
		await connect(owner, target);
		const grant = (await read_all(t)).grants[0]!;
		const lease = await t.mutation(internal.plugins_mcp_oauth.take_refresh_lease, {
			grantId: grant._id,
			version: grant.version,
		});
		await owner.asUser.mutation(api.plugins_mcp_oauth.disconnect, { membershipId: owner.membershipId, target });

		const stored = await t.mutation(internal.plugins_mcp_oauth.finish_refresh, {
			grantId: grant._id,
			leaseId: lease!.leaseId,
			outcome: {
				kind: "refreshed",
				leasedGrant: lease!.grant,
				tokens: { accessToken: "access-late", refreshToken: "refresh-late", expiresAt: null },
			},
		});

		expect(stored).toBe(false);
		await vi.waitFor(async () => expect((await read_all(t)).revocations).toEqual([]));
		expect(fixtures.revoked).toContain("refresh-late");
	});

	test("keeps the scope a 403 asks for, and the next Connect asks for it", async () => {
		const { t, owner } = await setup();
		const target = await save_custom_server(owner);
		await connect(owner, target);
		expect((await read_all(t)).grants[0]!.requestedScopes.includes("mcp:write")).toBe(false);
		fixtures.switches.serverForbidden = "insufficient_scope";

		const [called] = await call_echo({ t, member: owner, target });

		expect(called!.output?.metadata).toMatchObject({ kind: "mcp_auth_needed", reason: "needs_more_access" });
		expect((await read_all(t)).grants[0]!.stepUpScope).toBe("mcp:write");
		next_minute();
		const started = await start(owner, target);
		expect(new URL(started._yay!.authorizationUrl).searchParams.get("scope")?.split(" ")).toContain("mcp:write");
	});

	test("an old token refusal cannot end a new grant with the same version", async () => {
		fixtures.switches.tokenIncludeRefresh = false;
		const { t, owner } = await setup();
		const target = await install_oauth_plugin(t, owner);
		await connect(owner, target);
		const before = (await read_all(t)).grants[0]!;
		await owner.asUser.mutation(api.plugins_mcp_oauth.disconnect, { membershipId: owner.membershipId, target });
		await vi.waitFor(async () => expect((await read_all(t)).revocations.length).toBe(0));
		next_minute();
		await connect(owner, target);
		const after = (await read_all(t)).grants[0]!;
		expect(after._id === before._id).toBe(false);
		expect(after.version).toBe(before.version);

		const access = await t.action((ctx) =>
			plugins_mcp_oauth_get_access_token(ctx, {
				userId: owner.userId,
				target,
				refusedGrant: { grantId: before._id, version: before.version },
				waitForLease: true,
				signal: new AbortController().signal,
			}),
		);

		expect(access.status).toBe("connected");
		expect((await read_all(t)).grants[0]!.status).toBe("connected");
		expect((await read_all(t)).grants[0]!.version).toBe(after.version);
		expect(fixtures.counts.refresh).toBe(0);
	});

	test("a plugin server without OAuth that asks for sign-in is a tool error, with no Connect card", async () => {
		const { t, owner } = await setup();
		const target = await install_oauth_plugin(t, owner);
		await t.run(async (ctx) => {
			const installation = await ctx.db.get("plugins_workspace_installations", target.installationId);
			const version = (await ctx.db.get("plugins_versions", installation!.pluginVersionId))!;
			await ctx.db.patch("plugins_versions", version._id, {
				mcpServers: version.mcpServers.map((server) => ({ ...server, auth: { kind: "none" as const } })),
			});
		});
		fixtures.switches.serverAlwaysUnauthorized = true;

		const [called] = await call_echo({ t, member: owner, target });

		expect(called!.error).toBe(
			"This MCP server refused the plugin's access. Ask an admin to check the plugin and its secrets.",
		);
	});

	test("a plain 403 is a tool error, and the sign-in stays as it is", async () => {
		const { t, owner } = await setup();
		const target = await install_oauth_plugin(t, owner);
		await connect(owner, target);
		const grant = (await read_all(t)).grants[0]!;
		fixtures.switches.serverForbidden = "plain";

		const [called] = await call_echo({ t, member: owner, target });

		expect(called!.error).toBe("This MCP server refused the request.");
		expect(tool_calls_to("mcp-a.oauth.test")).toHaveLength(1);
		expect(fixtures.counts.refresh).toBe(0);
		expect((await read_all(t)).grants[0]).toMatchObject({
			status: "connected",
			version: grant.version,
			stepUpScope: null,
		});
	});
});

describe("revoke_one", () => {
	test("disconnect revokes the refresh token once, then deletes the revocation doc", async () => {
		const { t, owner } = await setup();
		const target = await install_oauth_plugin(t, owner);
		fixtures.switches.tokenAuthMethods = ["client_secret_post"];
		const { callback } = await sign_in(owner, target);
		await finish({ member: owner, callback });

		const disconnected = await owner.asUser.mutation(api.plugins_mcp_oauth.disconnect, {
			membershipId: owner.membershipId,
			target,
		});

		expect(disconnected).toEqual({ _yay: null });
		await vi.waitFor(async () => expect((await read_all(t)).revocations).toEqual([]));
		expect(fixtures.revoked).toHaveLength(1);
		// The DCR client authenticates the revoke with its secret.
		const revokeRequest = fixtures.wire.find((entry) => entry.path === "/revoke");
		expect(new URLSearchParams(revokeRequest?.body).get("client_secret")).toMatch(/^secret-/u);
	});

	test("a doc whose token cannot be read is deleted without a request", async () => {
		const { t } = await setup();
		const revocationId = await t.run((ctx) =>
			ctx.db.insert("plugins_mcp_oauth_revocations", {
				token: { ciphertext: new ArrayBuffer(8), nonce: new ArrayBuffer(12), keyId: "v1" },
				additionalData: "grant:custom:x",
				tokenTypeHint: "refresh_token",
				revocationEndpoint: "https://as.oauth.test/revoke",
				issuer: fixtures.issuer(),
				clientId: CLIENT_DOCUMENT_URL,
				clientKind: "cimd",
				tokenEndpointAuthMethod: "none",
			}),
		);

		await t.action(internal.plugins_mcp_oauth.revoke_one, { revocationId });

		expect((await read_all(t)).revocations).toEqual([]);
		expect(fixtures.wire).toEqual([]);
	});
});
