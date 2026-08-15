import { describe, expect, test } from "vitest";

import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import { crypto_random_hex, crypto_sha256_hex } from "../server/crypto-utils.ts";
import { public_api_PLUGIN_SERVICE_TOKEN_REGEX } from "../shared/public-api.ts";
import type { plugins_Capability } from "../shared/plugins.ts";

const EXCHANGE_PATH = "/api/internal/plugins/service-grants/exchange";
const RENEW_PATH = "/api/internal/plugins/service-grants/renew";
const VERIFY_LIVE_PATH = "/api/internal/plugins/service-grants/verify-live";
const SEAL_PROCESSING_PATH = "/api/internal/plugins/service-grants/seal-processing";

/** The value `setup-env.test.ts` puts in the environment for the whole convex project. */
const EXCHANGE_SECRET = "COUNCIL_SERVICE_EXCHANGE_SECRET_TEST";

/** What a finished Council installation consents to. The exchange requires all four by name. */
const COUNCIL_CAPABILITIES: plugins_Capability[] = [
	"plugin.service.connect",
	"plugin.data.read",
	"plugin.data.write",
	"workspace.files.write",
];

/**
 * Insert a ready plugin version and one enabled installation directly, the same way
 * `plugins_data.test.ts` does. The publish pipeline is not what these tests exercise.
 */
async function seed_installation(
	t: ReturnType<typeof test_convex>,
	args: {
		acceptedCapabilities?: plugins_Capability[];
		pluginName?: string;
	} = {},
) {
	return await t.run(async (ctx) => {
		const now = Date.now();
		const membership = await test_mocks_fill_db_with.membership(ctx, {});
		const capabilities = args.acceptedCapabilities ?? COUNCIL_CAPABILITIES;
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

	test("refuses a page token belonging to a different plugin, and mints nothing", async () => {
		const t = test_convex();
		// Every plugin page is served from the same asset origin, so one page can read another page's
		// `plu_` token. Without this binding the exchange would hand the Council service a grant carrying
		// the other plugin's producer identity — and a service grant is the only principal allowed to
		// write versioned documents, so a read-only page token would become that plugin's writer.
		const fixture = await seed_installation(t, { pluginName: "gallery" });
		const pageToken = await seed_page_token(t, fixture);

		const response = await exchange(t, pageToken);
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ message: "Permission denied" });
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

	test("refuses a body that leaves out what the service believes it holds", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const grantToken = await exchange_token(t, fixture);

		// A service that states nothing cannot be told it was wrong, so the route would answer "live"
		// to a caller whose real expectations it never saw.
		const response = await t.fetch(VERIFY_LIVE_PATH, {
			method: "POST",
			headers: service_headers(grantToken),
			body: JSON.stringify({ installationId: String(fixture.installationId), phase: "interactive" }),
		});
		expect(response.status).toBe(400);
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
