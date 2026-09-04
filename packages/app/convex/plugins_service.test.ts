import { describe, expect, test } from "vitest";

import { api, internal } from "./_generated/api.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import { crypto_random_hex, crypto_sha256_hex } from "../server/crypto-utils.ts";
import { public_api_PLUGIN_SERVICE_TOKEN_REGEX } from "../shared/public-api.ts";
import type { plugins_Capability } from "../shared/plugins.ts";

const EXCHANGE_PATH = "/api/internal/plugins/service-grants/exchange";
const RENEW_PATH = "/api/internal/plugins/service-grants/renew";
const VERIFY_LIVE_PATH = "/api/internal/plugins/service-grants/verify-live";
const SEAL_PROCESSING_PATH = "/api/internal/plugins/service-grants/seal-processing";

/** The secret the seeded registration's hash is made from. */
const EXCHANGE_SECRET = "SERVICE_EXCHANGE_SECRET_TEST";

/** What a finished Council installation consents to. */
const SERVICE_CAPABILITIES: plugins_Capability[] = [
	"plugin.service.connect",
	"plugin.data.read",
	"plugin.data.write",
	"workspace.files.write",
	"workspace.files.create-read-only",
];

/**
 * Insert a ready plugin version, one enabled installation, and the plugin's service registration
 * directly, the same way `plugins_data.test.ts` does. The publish pipeline is not what these
 * tests exercise. `registration: false` leaves the plugin unregistered.
 */
async function seed_installation(
	t: ReturnType<typeof test_convex>,
	args: {
		acceptedCapabilities?: plugins_Capability[];
		pluginName?: string;
		organizationName?: string;
		registration?: { scopes?: ("plugin_data:read" | "plugin_data:write" | "files:write")[]; secret?: string } | false;
	} = {},
) {
	return await t.run(async (ctx) => {
		const now = Date.now();
		const membership = await test_mocks_fill_db_with.membership(ctx, { organizationName: args.organizationName });
		const capabilities = args.acceptedCapabilities ?? SERVICE_CAPABILITIES;
		const pluginName = args.pluginName ?? "council";
		const pluginVersionId = await ctx.db.insert("plugins_versions", {
			name: pluginName,
			displayName: "Council",
			version: "0.1.0",
			description: "Meetings with named transcripts",
			reviewStatus: "passed",
			reviewId: null,
			isLatest: true,
			artifactHash: `sha256:${"a".repeat(64)}`,
			sourceRepositoryUrl: "https://github.com/bonobo/council-plugin",
			sourceOwner: "bonobo",
			sourceRepo: "council-plugin",
			sourceCommitSha: "1234567890abcdef1234567890abcdef12345678",
			manifestR2Key: "plugins/council/manifest.json",
			backendEntrypointFile: null,
			configuration: null,
			events: [],
			capabilities,
			pages: [],
			fileViews: [],
			outboundOrigins: [],
			uiOutboundOrigins: [],
			files: [],
			sourceStatus: "ready",
			sourceLastError: null,
			createdBy: membership.userId,
			updatedAt: now,
		});
		const installationId = await ctx.db.insert("plugins_workspace_installations", {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			pluginVersionId,
			pluginName,
			status: "enabled",
			configurationYaml: null,
			acceptedCapabilities: capabilities,
			capabilitiesAcceptedAt: now,
			acceptedOutboundOrigins: [],
			acceptedUiOutboundOrigins: [],
			outboundOriginsAcceptedAt: now,
			installedBy: membership.userId,
			updatedBy: membership.userId,
			updatedAt: now,
		});
		if (args.registration !== false) {
			await ctx.db.insert("plugins_service_registrations", {
				pluginName,
				exchangeSecretHash: await crypto_sha256_hex(args.registration?.secret ?? EXCHANGE_SECRET),
				scopes: args.registration?.scopes ?? ["plugin_data:read", "plugin_data:write", "files:write"],
				createdBy: membership.userId,
				updatedAt: now,
			});
		}
		return { ...membership, pluginVersionId, installationId } as const;
	});
}

/**
 * Mint a page session directly. `mint_page_session` needs a signed-in identity and a passed page in
 * the manifest; neither is what these routes are about, and only the token hash matters here.
 */
async function seed_page_token(
	t: ReturnType<typeof test_convex>,
	fixture: Awaited<ReturnType<typeof seed_installation>>,
	args: { expiresAt?: number } = {},
) {
	const token = `plu_${crypto_random_hex(32)}`;
	const now = Date.now();
	await t.run(async (ctx) => {
		await ctx.db.insert("plugins_ui_sessions", {
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			installationId: fixture.installationId,
			pluginVersionId: fixture.pluginVersionId,
			userId: fixture.userId,
			tokenHash: await crypto_sha256_hex(token),
			createdAt: now,
			expiresAt: args.expiresAt ?? now + 30 * 60 * 1000,
		});
	});
	return token;
}

/**
 * A page token held by a second workspace member who holds exactly the content permissions asked
 * for, `content.read` alone by default. The seal writes the meeting's files as the member behind the
 * grant, so this is the actor its write check exists for.
 *
 * It has to be a second member. The organization owner passes every permission check without a grant
 * doc, so nothing can take a content permission away from the seeded fixture user.
 */
async function seed_member_page_token(
	t: ReturnType<typeof test_convex>,
	fixture: Awaited<ReturnType<typeof seed_installation>>,
	args: { permissions?: ("content.read" | "content.write")[] } = {},
) {
	const token = `plu_${crypto_random_hex(32)}`;
	await t.run(async (ctx) => {
		const now = Date.now();
		const userId = await ctx.db.insert("users", { clerkUserId: "clerk-council-member" });
		await ctx.db.insert("organizations_workspaces_users", {
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			userId,
			active: true,
		});
		for (const permission of args.permissions ?? ["content.read"]) {
			await ctx.db.insert("access_control_permission_grants", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				resourceKind: "workspace",
				resourceId: String(fixture.workspaceId),
				principalKind: "user",
				userId,
				permission,
				createdAt: now,
				updatedAt: now,
			});
		}
		await ctx.db.insert("plugins_ui_sessions", {
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			installationId: fixture.installationId,
			pluginVersionId: fixture.pluginVersionId,
			userId,
			tokenHash: await crypto_sha256_hex(token),
			createdAt: now,
			expiresAt: now + 30 * 60 * 1000,
		});
	});
	return token;
}

function service_headers(bearer: string, args: { secret?: string | null } = {}) {
	const secret = args.secret === undefined ? EXCHANGE_SECRET : args.secret;
	return {
		"Content-Type": "application/json",
		Authorization: `Bearer ${bearer}`,
		...(secret === null ? {} : { "X-Bonobo-Service-Authorization": `Bearer ${secret}` }),
	};
}

async function read_grants(t: ReturnType<typeof test_convex>) {
	return await t.run(async (ctx) => await ctx.db.query("plugin_service_grants").collect());
}

async function exchange(t: ReturnType<typeof test_convex>, pageToken: string, args: { secret?: string | null } = {}) {
	return await t.fetch(EXCHANGE_PATH, {
		method: "POST",
		headers: service_headers(pageToken, args),
		body: JSON.stringify({}),
	});
}

/** Exchange and return the raw grant token, failing loudly if the exchange itself was refused. */
async function exchange_token(
	t: ReturnType<typeof test_convex>,
	fixture: Awaited<ReturnType<typeof seed_installation>>,
) {
	const pageToken = await seed_page_token(t, fixture);
	const response = await exchange(t, pageToken);
	if (response.status !== 200) {
		throw new Error(`Exchange failed with ${response.status}: ${await response.text()}`);
	}
	const body = (await response.json()) as { token: string };
	return body.token;
}

describe("/api/internal/plugins/service-grants/exchange", () => {
	test("trades a live page token for a grant the service can really write with", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const pageToken = await seed_page_token(t, fixture);

		const response = await exchange(t, pageToken);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			token: string;
			expiresAt: number;
			scopes: string[];
			principalKey: string;
			actorUserId: string;
			organizationId: string;
			workspaceId: string;
			installationId: string;
		};
		expect(public_api_PLUGIN_SERVICE_TOKEN_REGEX.test(body.token)).toBe(true);
		// No file-write scope yet: it needs a destination prefix, and no manifest configuration
		// declares one. The two data scopes are what the store accepts today.
		expect(body.scopes).toEqual(["plugin_data:read", "plugin_data:write"]);
		expect(body.installationId).toBe(String(fixture.installationId));
		expect(body.actorUserId).toBe(String(fixture.userId));

		// Read the table, not the response. Only the hash may be stored.
		const grants = await read_grants(t);
		expect(grants).toHaveLength(1);
		expect(grants[0]!.tokenHash).toBe(await crypto_sha256_hex(body.token));
		expect(grants[0]!.tokenHash).not.toBe(body.token);
		expect(grants[0]!.actorUserId).toEqual(fixture.userId);
		expect(grants[0]!.phase).toBe("interactive");

		// The grant is not just stored, it works: the store accepts a write made with it.
		const written = await t.fetch("/api/v1/plugin-data/write", {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${body.token}` },
			body: JSON.stringify({ collection: "meetings", key: "meeting-1", value: { title: "Weekly sync" } }),
		});
		expect(written.status).toBe(200);
	});

	test("refuses a caller with no exchange secret, and mints nothing", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const pageToken = await seed_page_token(t, fixture);

		const response = await exchange(t, pageToken, { secret: null });
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ message: "Unauthorized" });
		expect(await read_grants(t)).toHaveLength(0);
	});

	test("refuses a caller who sends an empty exchange secret, and mints nothing", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const pageToken = await seed_page_token(t, fixture);

		// `Bearer ` with nothing after it must not be read as a secret. If it were, a deployment that
		// never set the secret would accept exactly this header from anyone.
		const response = await exchange(t, pageToken, { secret: "" });
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ message: "Unauthorized" });
		expect(await read_grants(t)).toHaveLength(0);
	});

	test("refuses a caller with the wrong exchange secret, and mints nothing", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const pageToken = await seed_page_token(t, fixture);

		const response = await exchange(t, pageToken, { secret: `${EXCHANGE_SECRET}x` });
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ message: "Unauthorized" });
		expect(await read_grants(t)).toHaveLength(0);
	});

	test("refuses the raw exchange secret sent without the Bearer scheme, and mints nothing", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const pageToken = await seed_page_token(t, fixture);

		// `get_service_secret` in plugins_service.ts reads only `Bearer `-prefixed header values, so
		// the correct secret under any other scheme must stay useless.
		const response = await t.fetch(EXCHANGE_PATH, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${pageToken}`,
				"X-Bonobo-Service-Authorization": EXCHANGE_SECRET,
			},
			body: JSON.stringify({}),
		});
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ message: "Unauthorized" });
		expect(await read_grants(t)).toHaveLength(0);
	});

	test("refuses a Basic-scheme bearer even with a valid exchange secret, and mints nothing", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const pageToken = await seed_page_token(t, fixture);

		// `get_bearer_token` in plugins_service.ts accepts only the `Bearer ` scheme, so a Basic
		// credential never reaches the token lookup.
		const response = await t.fetch(EXCHANGE_PATH, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Basic ${pageToken}`,
				"X-Bonobo-Service-Authorization": `Bearer ${EXCHANGE_SECRET}`,
			},
			body: JSON.stringify({}),
		});
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ message: "Unauthorized" });
		expect(await read_grants(t)).toHaveLength(0);
	});

	test("refuses a grant token presented where a page token belongs", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const grantToken = await exchange_token(t, fixture);

		// A grant that could exchange itself would never need a member to open the page again, which
		// is the one thing that keeps a leaked exchange secret from being enough on its own.
		const response = await exchange(t, grantToken);
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ message: "Unauthorized" });
		expect(await read_grants(t)).toHaveLength(1);
	});

	test("refuses an installation that did not accept every required capability, and mints nothing", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t, {
			acceptedCapabilities: ["plugin.service.connect", "plugin.data.read", "plugin.data.write"],
		});
		const pageToken = await seed_page_token(t, fixture);

		const response = await exchange(t, pageToken);
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ message: "Permission denied" });
		expect(await read_grants(t)).toHaveLength(0);
	});

	// The capability rule asks only for the gates of the REGISTERED scopes plus the connect
	// consent. `create-target` still checks `workspace.files.create-read-only` on every call, so
	// nothing is lost by not asking for it here.
	test("exchanges without workspace.files.create-read-only, which is no longer required here", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t, {
			acceptedCapabilities: SERVICE_CAPABILITIES.filter(
				(capability) => capability !== ("workspace.files.create-read-only" satisfies plugins_Capability),
			),
		});
		const pageToken = await seed_page_token(t, fixture);

		const response = await exchange(t, pageToken);
		expect(response.status).toBe(200);
		expect(await read_grants(t)).toHaveLength(1);
	});

	test("the granted scopes derive from the registration, not from a fixed list", async () => {
		const t = test_convex();
		// A read-only service: its registration names one scope, so the exchange needs only the
		// connect consent plus that scope's gate, and the grant carries exactly that scope.
		const fixture = await seed_installation(t, {
			acceptedCapabilities: ["plugin.service.connect", "plugin.data.read"],
			registration: { scopes: ["plugin_data:read"] },
		});
		const pageToken = await seed_page_token(t, fixture);

		const response = await exchange(t, pageToken);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { scopes: string[] };
		expect(body.scopes).toEqual(["plugin_data:read"]);
	});

	test("refuses a page token belonging to an unregistered plugin, and mints nothing", async () => {
		const t = test_convex();
		// Every plugin page is served from the same asset origin, so one page can read another page's
		// `plu_` token. The stolen token resolves to the other plugin's installation, and that plugin
		// has no registration, so there is no hash the presented secret could match. The refusal is
		// the same flat word as a wrong secret.
		const fixture = await seed_installation(t, { pluginName: "gallery", registration: false });
		const pageToken = await seed_page_token(t, fixture);

		const response = await exchange(t, pageToken);
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ message: "Unauthorized" });
		expect(await read_grants(t)).toHaveLength(0);
	});

	test("refuses another registered plugin's page token with the same flat word, and mints nothing", async () => {
		const t = test_convex();
		// The other plugin IS registered, under its own secret. The stolen token finds that
		// registration, and the presented secret's hash does not match it — the secret is bound to
		// one plugin by the lookup itself, with no plugin-name allowlist left to configure.
		const fixture = await seed_installation(t, {
			pluginName: "gallery",
			registration: { secret: "pse_gallery_secret" },
		});
		const pageToken = await seed_page_token(t, fixture);

		const response = await exchange(t, pageToken);
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ message: "Unauthorized" });
		expect(await read_grants(t)).toHaveLength(0);
	});

	test("refuses a page token whose session already expired, and mints nothing", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const pageToken = await seed_page_token(t, fixture, { expiresAt: Date.now() - 1000 });

		const response = await exchange(t, pageToken);
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ message: "Unauthorized" });
		expect(await read_grants(t)).toHaveLength(0);
	});

	test("rotating the registration through the publisher mutation kills the old secret immediately", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		// The publisher gate needs the repository claim behind the latest version, owned by the
		// caller who also published it.
		await t.run(async (ctx) => {
			await ctx.db.insert("plugins_publisher_repositories", {
				ownerUserId: fixture.userId,
				repositoryUrl: "https://github.com/bonobo/council-plugin",
				owner: "bonobo",
				repo: "council-plugin",
			});
		});
		const asPublisher = t.withIdentity({
			issuer: "https://clerk.test",
			subject: `clerk-${fixture.userId}`,
			external_id: fixture.userId,
		});

		const baseline = await exchange(t, await seed_page_token(t, fixture));
		expect(baseline.status).toBe(200);

		const rotated = await asPublisher.mutation(api.plugins.set_plugin_service_registration, {
			pluginName: "council",
			scopes: ["plugin_data:read", "plugin_data:write", "files:write"],
		});
		expect(rotated._nay).toBeUndefined();
		const newSecret = rotated._yay!.exchangeSecret;
		expect(newSecret.startsWith("pse_")).toBe(true);

		// The old secret dies with the rotation; the new one works at once.
		const withOld = await exchange(t, await seed_page_token(t, fixture));
		expect(withOld.status).toBe(401);
		expect(await withOld.json()).toEqual({ message: "Unauthorized" });
		const withNew = await exchange(t, await seed_page_token(t, fixture), { secret: newSecret });
		expect(withNew.status).toBe(200);

		// The publisher query reports state without the hash or the secret.
		const state = await asPublisher.query(api.plugins.get_plugin_service_registration, { pluginName: "council" });
		expect(state).toEqual({
			exists: true,
			scopes: ["plugin_data:read", "plugin_data:write", "files:write"],
			updatedAt: expect.any(Number),
		});

		// Removal drops the registration, and with it every exchange.
		const removed = await asPublisher.mutation(api.plugins.remove_plugin_service_registration, {
			pluginName: "council",
		});
		expect(removed._nay).toBeUndefined();
		const afterRemove = await exchange(t, await seed_page_token(t, fixture), { secret: newSecret });
		expect(afterRemove.status).toBe(401);
	});
});

describe("/api/internal/plugins/service-grants/renew", () => {
	test("replaces the raw token on the same grant and kills the old one", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const first = await exchange_token(t, fixture);
		const before = await read_grants(t);

		const response = await t.fetch(RENEW_PATH, {
			method: "POST",
			headers: service_headers(first),
			body: JSON.stringify({}),
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as { token: string; expiresAt: number; scopes: string[] };
		expect(public_api_PLUGIN_SERVICE_TOKEN_REGEX.test(body.token)).toBe(true);
		expect(body.token).not.toBe(first);

		// One grant, still the same doc: renewal must never be a way to collect tenant grants.
		const after = await read_grants(t);
		expect(after).toHaveLength(1);
		expect(after[0]!._id).toEqual(before[0]!._id);
		expect(after[0]!.tokenHash).toBe(await crypto_sha256_hex(body.token));

		const withNew = await t.fetch("/api/v1/plugin-data/write", {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${body.token}` },
			body: JSON.stringify({ collection: "meetings", key: "meeting-1", value: { title: "Weekly sync" } }),
		});
		expect(withNew.status).toBe(200);

		const withOld = await t.fetch("/api/v1/plugin-data/write", {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${first}` },
			body: JSON.stringify({ collection: "meetings", key: "meeting-2", value: { title: "Old token" } }),
		});
		expect(withOld.status).toBe(401);
	});

	test("refuses a page token, so renewal can never create a grant", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const pageToken = await seed_page_token(t, fixture);

		const response = await t.fetch(RENEW_PATH, {
			method: "POST",
			headers: service_headers(pageToken),
			body: JSON.stringify({}),
		});
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ message: "Unauthorized" });
		expect(await read_grants(t)).toHaveLength(0);
	});

	test("refuses to renew once the installation stops accepting plugin.service.connect", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const grantToken = await exchange_token(t, fixture);
		await t.run(async (ctx) => {
			await ctx.db.patch("plugins_workspace_installations", fixture.installationId, {
				acceptedCapabilities: ["plugin.data.read", "plugin.data.write", "workspace.files.write"],
			});
		});

		const response = await t.fetch(RENEW_PATH, {
			method: "POST",
			headers: service_headers(grantToken),
			body: JSON.stringify({}),
		});
		expect(response.status).toBe(401);
		const stored = await read_grants(t);
		expect(stored[0]!.tokenHash).toBe(await crypto_sha256_hex(grantToken));
	});

	test("refuses to renew after the actor loses the workspace", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const grantToken = await exchange_token(t, fixture);
		await t.run(async (ctx) => {
			await ctx.db.patch("organizations_workspaces_users", fixture.membershipId, { active: false });
		});

		const response = await t.fetch(RENEW_PATH, {
			method: "POST",
			headers: service_headers(grantToken),
			body: JSON.stringify({}),
		});
		expect(response.status).toBe(401);
		const stored = await read_grants(t);
		expect(stored[0]!.tokenHash).toBe(await crypto_sha256_hex(grantToken));
	});
});

describe("/api/internal/plugins/service-grants/verify-live", () => {
	/**
	 * Every field is required, so the service always states what it believes it holds. A body helper
	 * keeps each test to the one claim it is about.
	 */
	function verify_live_body(
		fixture: Awaited<ReturnType<typeof seed_installation>>,
		args: {
			installationId?: string;
			phase?: "interactive" | "processing";
			destinationPathPrefix?: string | null;
			scopes?: string[];
		} = {},
	) {
		return JSON.stringify({
			installationId: args.installationId ?? String(fixture.installationId),
			phase: args.phase ?? "interactive",
			destinationPathPrefix: args.destinationPathPrefix === undefined ? null : args.destinationPathPrefix,
			scopes: args.scopes ?? ["plugin_data:read", "plugin_data:write"],
		});
	}

	test("reports what the grant may still attempt", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const grantToken = await exchange_token(t, fixture);

		const response = await t.fetch(VERIFY_LIVE_PATH, {
			method: "POST",
			headers: service_headers(grantToken),
			body: verify_live_body(fixture),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			installationId: String(fixture.installationId),
			phase: "interactive",
			scopes: ["plugin_data:read", "plugin_data:write"],
			destinationPathPrefix: null,
			contentPermissions: { read: true, write: true },
		});
	});

	test("refuses a body that leaves out any single one of the four claims", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const grantToken = await exchange_token(t, fixture);

		// Drop exactly one field at a time. A body missing several proves much less: any one field
		// could stop being required and the remaining missing one would still answer 400, so the
		// lost check would never show up.
		//
		// The field that matters most is `scopes` — a capability the workspace takes back NARROWS a
		// live grant instead of killing it, so the scopes claim is the only thing that turns a
		// quietly narrowed grant into a refusal.
		const complete: Record<string, unknown> = {
			installationId: String(fixture.installationId),
			phase: "interactive",
			destinationPathPrefix: null,
			scopes: ["plugin_data:read", "plugin_data:write"],
		};
		for (const omitted of Object.keys(complete)) {
			const body = { ...complete };
			delete body[omitted];
			const response = await t.fetch(VERIFY_LIVE_PATH, {
				method: "POST",
				headers: service_headers(grantToken),
				body: JSON.stringify(body),
			});
			expect([omitted, response.status]).toEqual([omitted, 400]);
		}

		// And a service that states nothing at all cannot be told it was wrong.
		const empty = await t.fetch(VERIFY_LIVE_PATH, {
			method: "POST",
			headers: service_headers(grantToken),
			body: JSON.stringify({}),
		});
		expect(empty.status).toBe(400);
	});

	test("refuses when the service names another installation", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const other = await seed_installation(t, { organizationName: "other-organization" });
		const grantToken = await exchange_token(t, fixture);

		const response = await t.fetch(VERIFY_LIVE_PATH, {
			method: "POST",
			headers: service_headers(grantToken),
			body: verify_live_body(fixture, { installationId: String(other.installationId) }),
		});
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ message: "This grant is for another installation" });
	});

	test("refuses when the service believes it holds the sealed processing grant", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const grantToken = await exchange_token(t, fixture);

		// The service asks this before it mints a guest token or starts a recording. A service that
		// thinks it is past the seal while it still holds the interactive grant must be stopped here,
		// not at the upload after the meeting ended.
		const response = await t.fetch(VERIFY_LIVE_PATH, {
			method: "POST",
			headers: service_headers(grantToken),
			body: verify_live_body(fixture, { phase: "processing" }),
		});
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ message: "This grant is in another phase" });
	});

	test("refuses when the service expects a destination the grant does not have", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const grantToken = await exchange_token(t, fixture);

		const response = await t.fetch(VERIFY_LIVE_PATH, {
			method: "POST",
			headers: service_headers(grantToken),
			body: verify_live_body(fixture, { destinationPathPrefix: "/Meetings" }),
		});
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ message: "This grant writes to another destination" });
	});

	test("refuses when the installation took back a capability the service still relies on", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const grantToken = await exchange_token(t, fixture);
		// Dropping a capability narrows a live grant instead of killing it. Without the scopes claim the
		// grant would still look live here and only fail later, on the write at the end of a meeting.
		await t.run(async (ctx) => {
			await ctx.db.patch("plugins_workspace_installations", fixture.installationId, {
				acceptedCapabilities: ["plugin.service.connect", "plugin.data.read", "workspace.files.write"],
			});
		});

		const response = await t.fetch(VERIFY_LIVE_PATH, {
			method: "POST",
			headers: service_headers(grantToken),
			body: verify_live_body(fixture),
		});
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ message: "This grant no longer has the scopes it needs" });

		// Reading alone is still allowed, so a service that stops claiming the write keeps working.
		const readOnly = await t.fetch(VERIFY_LIVE_PATH, {
			method: "POST",
			headers: service_headers(grantToken),
			body: verify_live_body(fixture, { scopes: ["plugin_data:read"] }),
		});
		expect(readOnly.status).toBe(200);
		expect(await readOnly.json()).toMatchObject({ scopes: ["plugin_data:read"] });
	});

	test("refuses when the member behind the grant may read workspace content but not write it", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const readerPageToken = await seed_member_page_token(t, fixture);
		const exchanged = await exchange(t, readerPageToken);
		expect(exchanged.status).toBe(200);
		const grantToken = ((await exchanged.json()) as { token: string }).token;

		// An admin can move this member to the `viewer` role in the middle of a meeting. That leaves
		// the membership and the installation's capabilities alone, so the grant still carries
		// `plugin_data:write` and every other check here still passes. The `/api/v1/*` doors answer
		// `Permission denied` for that scope anyway, so a 200 here would send the service into a
		// recording whose files can never land.
		const response = await t.fetch(VERIFY_LIVE_PATH, {
			method: "POST",
			headers: service_headers(grantToken),
			body: verify_live_body(fixture),
		});
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ message: "This grant's member can no longer use the scopes it needs" });

		// Only the claimed scopes are judged. The same grant claiming the read alone is still live, and
		// the reported permissions say which half went away.
		const readOnly = await t.fetch(VERIFY_LIVE_PATH, {
			method: "POST",
			headers: service_headers(grantToken),
			body: verify_live_body(fixture, { scopes: ["plugin_data:read"] }),
		});
		expect(readOnly.status).toBe(200);
		expect(await readOnly.json()).toMatchObject({ contentPermissions: { read: true, write: false } });
	});

	test("refuses a sealed processing grant claiming files:write once its member lost content.write", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const memberPageToken = await seed_member_page_token(t, fixture, {
			permissions: ["content.read", "content.write"],
		});
		const exchanged = await exchange(t, memberPageToken);
		expect(exchanged.status).toBe(200);
		const interactive = ((await exchanged.json()) as { token: string }).token;

		const sealed = await t.fetch(SEAL_PROCESSING_PATH, {
			method: "POST",
			headers: service_headers(interactive),
			body: JSON.stringify({ destinationPathPrefix: "/meetings" }),
		});
		expect(sealed.status).toBe(200);
		const processingToken = ((await sealed.json()) as { token: string }).token;

		// The seal is the only place `files:write` was ever checked against the member, and it runs
		// before the meeting records. Revoke the write permission afterwards and the sealed grant still
		// carries the scope for its whole six-day window while every upload it makes is refused.
		await t.run(async (ctx) => {
			const grants = await ctx.db.query("access_control_permission_grants").collect();
			const write = grants.find((grant) => grant.permission === "content.write");
			await ctx.db.delete("access_control_permission_grants", write!._id);
		});

		// `plugin_data:read` is claimed alongside and still allowed, so only the `files:write` row of
		// the permission map can produce this refusal.
		const response = await t.fetch(VERIFY_LIVE_PATH, {
			method: "POST",
			headers: service_headers(processingToken),
			body: verify_live_body(fixture, {
				phase: "processing",
				destinationPathPrefix: "/meetings",
				scopes: ["plugin_data:read", "files:write"],
			}),
		});
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ message: "This grant's member can no longer use the scopes it needs" });
	});

	test("refuses a grant whose installation was disabled", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const grantToken = await exchange_token(t, fixture);
		await t.run(async (ctx) => {
			await ctx.db.patch("plugins_workspace_installations", fixture.installationId, { status: "disabled" });
		});

		const response = await t.fetch(VERIFY_LIVE_PATH, {
			method: "POST",
			headers: service_headers(grantToken),
			body: verify_live_body(fixture),
		});
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ message: "Unauthorized" });
	});

	test("refuses a caller with no exchange secret", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const grantToken = await exchange_token(t, fixture);

		const response = await t.fetch(VERIFY_LIVE_PATH, {
			method: "POST",
			headers: service_headers(grantToken, { secret: null }),
			body: verify_live_body(fixture),
		});
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ message: "Unauthorized" });
	});
});

describe("/api/internal/plugins/service-grants/seal-processing", () => {
	async function seal(t: ReturnType<typeof test_convex>, bearer: string, destinationPathPrefix = "/meetings") {
		return await t.fetch(SEAL_PROCESSING_PATH, {
			method: "POST",
			headers: service_headers(bearer),
			body: JSON.stringify({ destinationPathPrefix }),
		});
	}

	test("seals a live interactive grant into a six-day processing grant bound to the destination", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const interactive = await exchange_token(t, fixture);

		const before = Date.now();
		const response = await seal(t, interactive);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			token: string;
			expiresAt: number;
			scopes: string[];
			destinationPathPrefix: string;
		};
		expect(public_api_PLUGIN_SERVICE_TOKEN_REGEX.test(body.token)).toBe(true);
		expect(body.scopes).toEqual(["plugin_data:read", "plugin_data:write", "files:write"]);
		expect(body.destinationPathPrefix).toBe("/meetings");

		// The interactive grant stays alive next to the sealed one; only the new doc is processing.
		const grants = await read_grants(t);
		expect(grants).toHaveLength(2);
		const processing = grants.find((grant) => grant.phase === "processing");
		expect(processing).toBeDefined();
		expect(processing!.tokenHash).toBe(await crypto_sha256_hex(body.token));
		expect(processing!.destinationPathPrefix).toBe("/meetings");
		expect(processing!.actorUserId).toEqual(fixture.userId);
		expect(processing!.scopes).toEqual(["plugin_data:read", "plugin_data:write", "files:write"]);
		// Six days: the plan's recovery window, one day inside the provider's seven-day artifact expiry.
		expect(processing!.expiresAt).toBeGreaterThan(before + 5 * 24 * 60 * 60 * 1000);
		expect(processing!.expiresAt).toBeLessThanOrEqual(Date.now() + 6 * 24 * 60 * 60 * 1000);
	});

	test("refuses to seal from a processing grant, so the window cannot roll forever", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const interactive = await exchange_token(t, fixture);
		const sealed = await seal(t, interactive);
		expect(sealed.status).toBe(200);
		const processingToken = ((await sealed.json()) as { token: string }).token;

		const again = await seal(t, processingToken);
		expect(again.status).toBe(403);
		expect(await again.json()).toEqual({ message: "Permission denied" });
		expect(await read_grants(t)).toHaveLength(2);
	});

	test("refuses a page token where the interactive grant belongs", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const pageToken = await seed_page_token(t, fixture);

		const response = await seal(t, pageToken);
		expect(response.status).toBe(401);
		expect(await read_grants(t)).toHaveLength(0);
	});

	test("refuses a destination that is not absolute and normalized", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const interactive = await exchange_token(t, fixture);

		const response = await seal(t, interactive, "/meetings/");
		expect(response.status).toBe(400);
		expect(await read_grants(t)).toHaveLength(1);
	});

	test("refuses a destination of `/`, which would seal the grant to the whole workspace", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const interactive = await exchange_token(t, fixture);

		// `/` is its own normalized form and has no segments, so neither neighbouring check sees it.
		// It has to be named on its own, because a grant sealed to `/` passes the upload routes'
		// containment test for EVERY path in the workspace — which is the opposite of sealed.
		const response = await seal(t, interactive, "/");
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ message: "destinationPathPrefix must be a normalized absolute path" });
		expect(await read_grants(t)).toHaveLength(1);
	});

	test("the seal's mint refuses outright when a scope it promised is no longer available", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);

		// The route pre-checks the capabilities and refuses first, so this asks the mint directly: it
		// is the backstop for a capability the workspace takes back BETWEEN that pre-check and this
		// mutation. Without `requireAllRequestedScopes` the mint would quietly narrow `files:write`
		// away and hand back a two-scope processing grant, which fails at the upload after the
		// meeting ended and the member left.
		await t.run(async (ctx) => {
			await ctx.db.patch("plugins_workspace_installations", fixture.installationId, {
				acceptedCapabilities: ["plugin.service.connect", "plugin.data.read", "plugin.data.write"],
			});
		});

		const minted = await t.mutation(internal.public_api.create_plugin_service_grant, {
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			installationId: fixture.installationId,
			actorUserId: fixture.userId,
			requestedScopes: ["plugin_data:read", "plugin_data:write", "files:write"],
			requireAllRequestedScopes: true,
			destinationPathPrefix: "/meetings",
			phase: "processing",
			now: Date.now(),
		});
		expect(minted._nay?.message).toBe("Permission denied");
		expect(await read_grants(t)).toHaveLength(0);
	});

	test("refuses a destination with a non-canonical folder name; the service normalizes before sealing", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const interactive = await exchange_token(t, fixture);

		// The host never lowercases for the caller: the Council service must normalize its configured
		// folder (for example /Meetings -> /meetings) before it seals.
		const response = await seal(t, interactive, "/Meetings");
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ message: "destinationPathPrefix contains an invalid folder name" });
		expect(await read_grants(t)).toHaveLength(1);
	});

	test("refuses to seal once workspace.files.write was taken back, and mints nothing", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const interactive = await exchange_token(t, fixture);
		await t.run(async (ctx) => {
			await ctx.db.patch("plugins_workspace_installations", fixture.installationId, {
				acceptedCapabilities: ["plugin.service.connect", "plugin.data.read", "plugin.data.write"],
			});
		});

		const response = await seal(t, interactive);
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ message: "Permission denied" });
		expect(await read_grants(t)).toHaveLength(1);
	});

	test("refuses to seal for a member who may read workspace content but not write it", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const readerPageToken = await seed_member_page_token(t, fixture);
		const exchanged = await exchange(t, readerPageToken);
		expect(exchanged.status).toBe(200);
		const interactive = ((await exchanged.json()) as { token: string }).token;

		// The uploads at the end of the meeting are written as this member, and the upload routes
		// refuse them there. Refusing at the seal is what stops the meeting before it records, instead
		// of after everyone left and the files cannot land.
		const response = await seal(t, interactive);
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ message: "Permission denied" });
		expect(await read_grants(t)).toHaveLength(1);
	});

	test("refuses to seal after the actor loses the workspace", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const interactive = await exchange_token(t, fixture);
		await t.run(async (ctx) => {
			await ctx.db.patch("organizations_workspaces_users", fixture.membershipId, { active: false });
		});

		const response = await seal(t, interactive);
		expect(response.status).toBe(401);
		expect(await read_grants(t)).toHaveLength(1);
	});

	test("renewing a processing grant rotates the token without extending the six-day deadline", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const interactive = await exchange_token(t, fixture);
		const sealed = await seal(t, interactive);
		expect(sealed.status).toBe(200);
		const processingToken = ((await sealed.json()) as { token: string }).token;
		const grantsBefore = await read_grants(t);
		const processingBefore = grantsBefore.find((grant) => grant.phase === "processing")!;

		const response = await t.fetch(RENEW_PATH, {
			method: "POST",
			headers: service_headers(processingToken),
			body: JSON.stringify({}),
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as { token: string; expiresAt: number };
		expect(body.token).not.toBe(processingToken);
		// The six-day deadline is the revocation the plan promises. A renewal that extended it would
		// keep a sealed grant alive as long as the service keeps calling.
		expect(body.expiresAt).toBe(processingBefore.expiresAt);

		const grantsAfter = await read_grants(t);
		const processingAfter = grantsAfter.find((grant) => grant.phase === "processing")!;
		expect(processingAfter._id).toEqual(processingBefore._id);
		expect(processingAfter.expiresAt).toBe(processingBefore.expiresAt);
		expect(processingAfter.tokenHash).toBe(await crypto_sha256_hex(body.token));
	});
});
