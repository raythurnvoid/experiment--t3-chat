import { afterEach, describe, expect, test, vi } from "vitest";
import { compareValues } from "convex/values";

import { access_control_db_ensure_role_assignment, access_control_db_has_permission } from "./access_control.ts";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel";
import type { billing_PRODUCTS } from "../shared/billing.ts";
import { organizations_db_create_workspace } from "./organizations.ts";
import { plugins_data_db_count_installation_docs } from "./plugins_data.ts";
import { quotas_db_ensure } from "./quotas.ts";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";
import { test_convex, test_mocks, test_mocks_fill_db_with } from "./setup.test.ts";
import { crypto_sha256_hex } from "../server/crypto-utils.ts";
import type { access_control_SystemRole } from "../shared/access-control.ts";
import { public_api_PLUGIN_SERVICE_TOKEN_REGEX } from "../shared/public-api.ts";
import type { plugins_Capability } from "../shared/plugins.ts";

/**
 * Insert a ready plugin version and one enabled installation directly. The publish pipeline is not
 * what these tests exercise, and the same direct seed is what `data_deletion.test.ts` uses.
 *
 * The payer defaults to `Free`, which is also the store's slot-ceiling default for unknown plans.
 * Pass a paid plan where a test needs the higher ceiling.
 */
async function seed_installation(
	t: ReturnType<typeof test_convex>,
	args: {
		acceptedCapabilities?: plugins_Capability[];
		userId?: Id<"users">;
		organizationName?: string;
		plan?: keyof typeof billing_PRODUCTS | null;
	} = {},
) {
	return await t.run(async (ctx) => {
		const now = Date.now();
		const membership = await test_mocks_fill_db_with.membership(ctx, {
			userId: args.userId,
			organizationName: args.organizationName,
			plan: args.plan ?? "Free",
		});
		const pluginVersionId = await ctx.db.insert("plugins_versions", {
			name: "council",
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
			capabilities: ["plugin.data.read", "plugin.data.write", "plugin.service.connect"],
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
			pluginName: "council",
			status: "enabled",
			configurationYaml: null,
			acceptedCapabilities: args.acceptedCapabilities ?? [
				"plugin.data.read",
				"plugin.data.write",
				"plugin.service.connect",
			],
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

async function mint_service_grant(
	t: ReturnType<typeof test_convex>,
	fixture: Awaited<ReturnType<typeof seed_installation>>,
	args: {
		requestedScopes?: ("plugin_data:read" | "plugin_data:write" | "files:write")[];
		destinationPathPrefix?: string | null;
		phase?: "interactive" | "processing";
	} = {},
) {
	return await t.mutation(internal.public_api.create_plugin_service_grant, {
		organizationId: fixture.organizationId,
		workspaceId: fixture.workspaceId,
		installationId: fixture.installationId,
		actorUserId: fixture.userId,
		requestedScopes: args.requestedScopes ?? ["plugin_data:read", "plugin_data:write"],
		destinationPathPrefix: args.destinationPathPrefix ?? null,
		phase: args.phase ?? "interactive",
		now: Date.now(),
	});
}

describe("create_plugin_service_grant", () => {
	test("stores only the token hash and narrows the requested scopes to accepted capabilities", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t, {
			acceptedCapabilities: ["plugin.data.read", "plugin.service.connect"],
		});

		const minted = await mint_service_grant(t, fixture);
		if (minted._nay) {
			throw new Error(minted._nay.message);
		}
		expect(public_api_PLUGIN_SERVICE_TOKEN_REGEX.test(minted._yay.token)).toBe(true);
		// The write capability was never accepted, so the write scope is dropped instead of granted.
		expect(minted._yay.scopes).toEqual(["plugin_data:read"]);

		const stored = await t.run(async (ctx) => await ctx.db.get("plugin_service_grants", minted._yay.grantId));
		expect(stored?.tokenHash).toBe(await crypto_sha256_hex(minted._yay.token));
		expect(stored?.tokenHash).not.toBe(minted._yay.token);
		expect(stored?.scopes).toEqual(["plugin_data:read"]);
		expect(stored?.pluginVersionId).toEqual(fixture.pluginVersionId);
		expect(stored?.pluginName).toBe("council");
		expect(stored?.revokedAt).toBeUndefined();
	});

	test("refuses a file-write grant with no destination prefix", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t, {
			acceptedCapabilities: [
				"plugin.data.read",
				"plugin.data.write",
				"workspace.files.write",
				"plugin.service.connect",
			],
		});

		const withoutPrefix = await mint_service_grant(t, fixture, {
			requestedScopes: ["files:write"],
			destinationPathPrefix: null,
		});
		expect(withoutPrefix._nay?.message).toBe("A file-write grant requires a destination path prefix");
		const grantCount = await t.run(async (ctx) => (await ctx.db.query("plugin_service_grants").collect()).length);
		expect(grantCount).toBe(0);

		const withPrefix = await mint_service_grant(t, fixture, {
			requestedScopes: ["files:write"],
			destinationPathPrefix: "/Meetings",
		});
		if (withPrefix._nay) {
			throw new Error(withPrefix._nay.message);
		}
		expect(withPrefix._yay.scopes).toEqual(["files:write"]);
	});

	test("drops the file-write scope when the installation never accepted workspace.files.write", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);

		// The prefix is present and valid, so only the missing capability can refuse this.
		const minted = await mint_service_grant(t, fixture, {
			requestedScopes: ["files:write"],
			destinationPathPrefix: "/Meetings",
		});
		expect(minted._nay?.message).toBe("At least one scope is required");
		expect(await t.run(async (ctx) => (await ctx.db.query("plugin_service_grants").collect()).length)).toBe(0);

		// Losing the capability on upgrade narrows an already-issued grant too, so a grant minted while
		// the capability was accepted stops carrying the scope the moment it is removed.
		const live = await seed_installation(t, {
			organizationName: "files-write-cap",
			acceptedCapabilities: ["plugin.data.read", "workspace.files.write", "plugin.service.connect"],
		});
		const grant = await mint_service_grant(t, live, {
			requestedScopes: ["plugin_data:read", "files:write"],
			destinationPathPrefix: "/Meetings",
		});
		if (grant._nay) {
			throw new Error(grant._nay.message);
		}
		expect(grant._yay.scopes).toEqual(["plugin_data:read", "files:write"]);

		await t.run(async (ctx) => {
			await ctx.db.patch("plugins_workspace_installations", live.installationId, {
				acceptedCapabilities: ["plugin.data.read", "plugin.service.connect"],
			});
		});
		const resolved = await t.query(internal.public_api.resolve_principal, { presented: grant._yay.token });
		if (resolved._nay) {
			throw new Error(resolved._nay.message);
		}
		expect(resolved._yay.scopes).toEqual(["plugin_data:read"]);
	});

	test("refuses a disabled installation, another tenant's installation, and a non-member actor", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const otherFixture = await seed_installation(t, { organizationName: "other-organization" });

		await t.run(async (ctx) => {
			await ctx.db.patch("plugins_workspace_installations", fixture.installationId, { status: "disabled" });
		});
		expect((await mint_service_grant(t, fixture))._nay?.message).toBe("Not found");
		await t.run(async (ctx) => {
			await ctx.db.patch("plugins_workspace_installations", fixture.installationId, { status: "enabled" });
		});

		// The installation exists, but not in the organization and workspace the caller claims.
		const crossTenant = await t.mutation(internal.public_api.create_plugin_service_grant, {
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			installationId: otherFixture.installationId,
			actorUserId: fixture.userId,
			requestedScopes: ["plugin_data:read"],
			destinationPathPrefix: null,
			phase: "interactive",
			now: Date.now(),
		});
		expect(crossTenant._nay?.message).toBe("Not found");

		const strangerId = await t.run(async (ctx) => await ctx.db.insert("users", { clerkUserId: "clerk-stranger" }));
		const stranger = await t.mutation(internal.public_api.create_plugin_service_grant, {
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			installationId: fixture.installationId,
			actorUserId: strangerId,
			requestedScopes: ["plugin_data:read"],
			destinationPathPrefix: null,
			phase: "interactive",
			now: Date.now(),
		});
		expect(stranger._nay?.message).toBe("Unauthorized");

		const grantCount = await t.run(async (ctx) => (await ctx.db.query("plugin_service_grants").collect()).length);
		expect(grantCount).toBe(0);
	});
});

describe("resolve_principal", () => {
	test("resolves a service grant to its installation, tenant, and stable producer key", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const minted = await mint_service_grant(t, fixture);
		if (minted._nay) {
			throw new Error(minted._nay.message);
		}

		const resolved = await t.query(internal.public_api.resolve_principal, { presented: minted._yay.token });
		if (resolved._nay) {
			throw new Error(resolved._nay.message);
		}
		expect(resolved._yay).toMatchObject({
			kind: "plugin_service",
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			installationId: fixture.installationId,
			pluginVersionId: fixture.pluginVersionId,
			actorUserId: fixture.userId,
			phase: "interactive",
			scopes: ["plugin_data:read", "plugin_data:write"],
			credentialId: null,
			pathPrefix: null,
		});
		// One producer per installation, so a rotated token keeps owning the same documents.
		expect(resolved._yay.principalKey).toBe(
			`plugin_service:${fixture.organizationId}:${fixture.workspaceId}:${fixture.installationId}`,
		);
	});

	test("refuses a revoked grant, a disabled installation, and an upgraded installation", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const minted = await mint_service_grant(t, fixture);
		if (minted._nay) {
			throw new Error(minted._nay.message);
		}
		const token = minted._yay.token;

		await t.run(async (ctx) => {
			await ctx.db.patch("plugin_service_grants", minted._yay.grantId, { revokedAt: Date.now() });
		});
		expect((await t.query(internal.public_api.resolve_principal, { presented: token }))._nay?.message).toBe(
			"Unauthenticated",
		);
		await t.run(async (ctx) => {
			await ctx.db.patch("plugin_service_grants", minted._yay.grantId, { revokedAt: undefined });
		});

		await t.run(async (ctx) => {
			await ctx.db.patch("plugins_workspace_installations", fixture.installationId, { status: "disabled" });
		});
		expect((await t.query(internal.public_api.resolve_principal, { presented: token }))._nay?.message).toBe(
			"Unauthenticated",
		);
		await t.run(async (ctx) => {
			await ctx.db.patch("plugins_workspace_installations", fixture.installationId, { status: "enabled" });
		});

		// An upgrade moves the installation to a new version id, which is what revokes outstanding grants.
		const otherFixture = await seed_installation(t, { organizationName: "other-organization" });
		await t.run(async (ctx) => {
			await ctx.db.patch("plugins_workspace_installations", fixture.installationId, {
				pluginVersionId: otherFixture.pluginVersionId,
			});
		});
		expect((await t.query(internal.public_api.resolve_principal, { presented: token }))._nay?.message).toBe(
			"Unauthenticated",
		);
	});

	test("drops a scope when the installation stops accepting its capability", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const minted = await mint_service_grant(t, fixture);
		if (minted._nay) {
			throw new Error(minted._nay.message);
		}
		expect(minted._yay.scopes).toEqual(["plugin_data:read", "plugin_data:write"]);

		await t.run(async (ctx) => {
			await ctx.db.patch("plugins_workspace_installations", fixture.installationId, {
				acceptedCapabilities: ["plugin.data.read", "plugin.service.connect"],
			});
		});

		const resolved = await t.query(internal.public_api.resolve_principal, { presented: minted._yay.token });
		if (resolved._nay) {
			throw new Error(resolved._nay.message);
		}
		// The grant doc still says write; the live installation is what decides.
		expect(resolved._yay).toMatchObject({ kind: "plugin_service", scopes: ["plugin_data:read"] });
	});

	test("refuses the whole grant once the installation stops accepting plugin.service.connect", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const minted = await mint_service_grant(t, fixture);
		if (minted._nay) {
			throw new Error(minted._nay.message);
		}

		// Taking away the capability the workspace consented to is not a scope change. It withdraws
		// permission for an outside server to act at all, so the whole grant stops resolving.
		await t.run(async (ctx) => {
			await ctx.db.patch("plugins_workspace_installations", fixture.installationId, {
				acceptedCapabilities: ["plugin.data.read", "plugin.data.write"],
			});
		});

		expect((await t.query(internal.public_api.resolve_principal, { presented: minted._yay.token }))._nay?.message).toBe(
			"Unauthenticated",
		);
	});

	test("refuses to mint for an installation that never accepted plugin.service.connect", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t, {
			acceptedCapabilities: ["plugin.data.read", "plugin.data.write"],
		});

		// Without the capability the install-consent dialog never showed the paragraph about a
		// publisher's server acting for the workspace, so no grant may exist at all.
		const minted = await mint_service_grant(t, fixture);
		expect(minted._nay?.message).toBe("Permission denied");
		expect(await t.run(async (ctx) => (await ctx.db.query("plugin_service_grants").collect()).length)).toBe(0);
	});

	test("refuses both phases once the actor loses membership", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const interactive = await mint_service_grant(t, fixture, { phase: "interactive" });
		const processing = await mint_service_grant(t, fixture, { phase: "processing" });
		if (interactive._nay || processing._nay) {
			throw new Error(interactive._nay?.message ?? processing._nay?.message);
		}

		await t.run(async (ctx) => {
			const membership = await ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_active_user_organization_workspace", (q) =>
					q
						.eq("active", true)
						.eq("userId", fixture.userId)
						.eq("organizationId", fixture.organizationId)
						.eq("workspaceId", fixture.workspaceId),
				)
				.first();
			if (!membership) {
				throw new Error("Expected an active membership to deactivate");
			}
			await ctx.db.patch("organizations_workspaces_users", membership._id, { active: false });
		});

		// Both phases die with the membership, `processing` included. Being sealed to one destination
		// path prefix bounds where a processing grant writes, not whether its member may still write,
		// so the seal is no reason to resolve it here.
		expect(
			(await t.query(internal.public_api.resolve_principal, { presented: interactive._yay.token }))._nay?.message,
		).toBe("Unauthenticated");
		expect(
			(await t.query(internal.public_api.resolve_principal, { presented: processing._yay.token }))._nay?.message,
		).toBe("Unauthenticated");
	});

	test("refuses a deleted actor in both phases", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const processing = await mint_service_grant(t, fixture, { phase: "processing" });
		if (processing._nay) {
			throw new Error(processing._nay.message);
		}

		await t.run(async (ctx) => {
			await ctx.db.patch("users", fixture.userId, { deletedAt: Date.now() });
		});
		expect(
			(await t.query(internal.public_api.resolve_principal, { presented: processing._yay.token }))._nay?.message,
		).toBe("Unauthenticated");
	});
});

function service_headers(token: string) {
	return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

/**
 * An installation whose member is a signed-in Clerk user, so the test can mint a real user API key.
 * Only signed-in users can create one.
 */
async function seed_installation_with_key_owner(t: ReturnType<typeof test_convex>, clerkUserId: string) {
	const userId = await t.run(async (ctx) => await ctx.db.insert("users", { clerkUserId }));
	const fixture = await seed_installation(t, { userId });
	const asUser = t.withIdentity({ issuer: "https://clerk.test", subject: clerkUserId, external_id: userId });
	return { ...fixture, asUser } as const;
}

/**
 * Start a real plugin run against the installation and return its live `plr_` token.
 *
 * A run gets its scopes from the capabilities the workspace accepted when it installed the plugin,
 * so the token is the only way to check what an installation's runs may really do. The run needs a
 * triggering upload because `resolve_principal` reads the source file node on every request.
 */
async function start_plugin_run(
	t: ReturnType<typeof test_convex>,
	fixture: Awaited<ReturnType<typeof seed_installation>>,
	args: { acceptedCapabilities: plugins_Capability[]; tokenSeed: string },
) {
	const runId = await t.run(async (ctx) => {
		const now = Date.now();
		// Only a version with a backend can run an event, and the shared seed declares no backend.
		await ctx.db.patch("plugins_versions", fixture.pluginVersionId, {
			backendEntrypointFile: {
				entry: "backend/main.js",
				moduleName: "main",
				r2Key: "plugins/council/backend/main.js",
				sha256: "b".repeat(64),
				compatibilityDate: "2026-01-01",
				compatibilityFlags: [],
			},
		});
		const assetId = await ctx.db.insert("files_r2_assets", {
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			kind: "upload",
			r2Bucket: "test-bucket",
			r2Key: "uploads/photo.png",
			size: 1024,
			createdBy: fixture.userId,
			updatedAt: now,
		});
		const fileNodeId = await ctx.db.insert("files_nodes", {
			...test_mocks.files.base(),
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			createdBy: fixture.userId,
			updatedBy: fixture.userId,
			kind: "file",
			name: "photo.png",
			path: "/photo.png",
			treePath: "/photo.png",
			lowercaseExtension: "png",
			updatedAt: now,
		});

		return await ctx.db.insert("plugins_event_runs", {
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			assetId,
			fileNodeId,
			actorUserId: fixture.userId,
			installationId: fixture.installationId,
			pluginVersionId: fixture.pluginVersionId,
			event: "files.upload.completed",
			eventId: `plugin:run-${args.tokenSeed}`,
			status: "queued",
			acceptedCapabilities: args.acceptedCapabilities,
			expiresAt: now + 30 * 60 * 1000,
			apiCallCount: 0,
			outputWriteCount: 0,
			errorMessage: null,
			updatedAt: now,
		});
	});

	const apiToken = `plr_${args.tokenSeed.repeat(64)}`;
	const started = await t.mutation(internal.plugins_runtime.start_event_run, {
		runId,
		apiTokenHash: await crypto_sha256_hex(apiToken),
	});
	// A refused start would leave the run without a token and make every later assertion vacuous.
	if (started._nay) {
		throw new Error(started._nay.message);
	}

	return { runId, apiToken } as const;
}

/**
 * Join a second signed-in user to the installation's workspace with the system role given.
 *
 * Every other fixture in this file acts as the organization owner, who passes every permission check
 * by owning the organization. A `viewer` holds `content.read` and nothing else, so it is the actor
 * that tells a live permission check apart from no check at all.
 */
async function join_member_with_role(
	t: ReturnType<typeof test_convex>,
	fixture: Awaited<ReturnType<typeof seed_installation>>,
	args: { clerkUserId: string; role: access_control_SystemRole },
) {
	const member = await t.run(async (ctx) => {
		const now = Date.now();
		const userId = await ctx.db.insert("users", { clerkUserId: args.clerkUserId });
		const membershipId = await ctx.db.insert("organizations_workspaces_users", {
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			userId,
			active: true,
			updatedAt: now,
		});
		await access_control_db_ensure_role_assignment(ctx, {
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			userId,
			role: args.role,
			now,
		});
		// The invite mutation writes this next to the membership, and minting an API key reads it. A
		// fixture without it would leave the member in a state no invite can produce.
		await quotas_db_ensure(ctx, {
			quotaName: "active_api_credentials",
			userId,
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			now,
		});
		return { userId, membershipId } as const;
	});

	// The page-session identity lets door tests act as this member's plugin page too.
	const pageSession = await seed_page_session(t, { ...fixture, userId: member.userId });

	return {
		...member,
		...pageSession,
		asUser: t.withIdentity({
			issuer: "https://clerk.test",
			subject: args.clerkUserId,
			external_id: member.userId,
		}),
	} as const;
}

describe("public API routes", () => {
	test("refuses a service token on a files route, and refuses an expired one before the kind check", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const minted = await mint_service_grant(t, fixture);
		if (minted._nay) {
			throw new Error(minted._nay.message);
		}

		// The file routes do not allow this kind, so a live grant is rejected as a permission problem.
		const live = await t.fetch("/api/v1/files/list", {
			method: "POST",
			headers: { Authorization: `Bearer ${minted._yay.token}`, "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(live.status).toBe(403);
		expect(await live.json()).toEqual({ message: "Permission denied" });

		// Expiry is checked before the kind, so the same request now fails as authentication instead.
		await t.run(async (ctx) => {
			await ctx.db.patch("plugin_service_grants", minted._yay.grantId, { expiresAt: Date.now() - 1000 });
		});
		const expired = await t.fetch("/api/v1/files/list", {
			method: "POST",
			headers: { Authorization: `Bearer ${minted._yay.token}`, "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(expired.status).toBe(401);
		expect(await expired.json()).toEqual({ message: "Unauthenticated" });
	});

	test("refuses a caller with no token at all, and writes nothing", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);

		const written = await t.fetch("/api/v1/plugin-data/write", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ collection: "meetings", key: "meeting-1", value: { n: 1 } }),
		});
		expect(written.status).toBe(401);
		expect(await written.json()).toEqual({ message: "Unauthenticated" });

		// Read the tables, not the response. A refusal that still wrote would answer 401 all the same.
		expect(await read_documents(t, fixture)).toHaveLength(0);
		expect(await read_usage(t, fixture)).toBeNull();
	});

	test("stores a document through the write route and reads it back through the read route", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const minted = await mint_service_grant(t, fixture);
		if (minted._nay) {
			throw new Error(minted._nay.message);
		}

		const written = await t.fetch("/api/v1/plugin-data/write", {
			method: "POST",
			headers: service_headers(minted._yay.token),
			body: JSON.stringify({ collection: "meetings", key: "meeting-1", value: { title: "Weekly sync" } }),
		});
		expect(written.status).toBe(200);
		// The canonical JSON is `{"title":"Weekly sync"}`.
		expect(await written.json()).toEqual({ revision: 1, byteSize: 23 });

		// The document is really stored, not only reported as written.
		const stored = await read_documents(t, fixture);
		expect(stored).toHaveLength(1);
		expect(stored[0]).toMatchObject({ collection: "meetings", key: "meeting-1", value: { title: "Weekly sync" } });

		const read = await t.fetch("/api/v1/plugin-data/read", {
			method: "POST",
			headers: service_headers(minted._yay.token),
			body: JSON.stringify({ collection: "meetings", key: "meeting-1" }),
		});
		expect(read.status).toBe(200);
		expect(await read.json()).toMatchObject({
			document: { collection: "meetings", key: "meeting-1", revision: 1, value: { title: "Weekly sync" } },
		});

		const listed = await t.fetch("/api/v1/plugin-data/list", {
			method: "POST",
			headers: service_headers(minted._yay.token),
			body: JSON.stringify({ collection: "meetings" }),
		});
		expect(listed.status).toBe(200);
		expect(await listed.json()).toMatchObject({ documents: [{ key: "meeting-1" }], isDone: true, cursor: null });
	});

	test("reports the full public document shape on the read route", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t);
		const minted = await mint_service_grant(t, fixture);
		if (minted._nay) {
			throw new Error(minted._nay.message);
		}

		// A pre-door doc: written interactively with no stored ownership, so it reads back as shared.
		await t.mutation(internal.plugins_data.write_document, {
			principal: store_principal(fixture),
			collection: "meetings",
			key: "meeting-1",
			value: { title: "Weekly sync" },
		});

		const read = await t.fetch("/api/v1/plugin-data/read", {
			method: "POST",
			headers: service_headers(minted._yay.token),
			body: JSON.stringify({ collection: "meetings", key: "meeting-1" }),
		});
		expect(read.status).toBe(200);
		// Pin the exact field set: the SDK and plugin pages consume this shape.
		expect(await read.json()).toEqual({
			document: {
				collection: "meetings",
				key: "meeting-1",
				value: { title: "Weekly sync" },
				revision: 1,
				byteSize: 23,
				writeMode: "normal",
				ownership: "shared",
				createdBy: fixture.userId,
				updatedBy: fixture.userId,
				createdAt: expect.any(Number),
				updatedAt: expect.any(Number),
			},
		});

		// A door-created doc reads back as owned.
		const appended = await fixture.asPage.mutation(api.plugins_data.user_append_document, {
			collection: "messages",
			value: { text: "hello" },
			clientRequestId: "shape-1",
		});
		if (appended._nay) {
			throw new Error(appended._nay.message);
		}
		const owned = await t.fetch("/api/v1/plugin-data/read", {
			method: "POST",
			headers: service_headers(minted._yay.token),
			body: JSON.stringify({ collection: "messages", key: appended._yay.key }),
		});
		expect(owned.status).toBe(200);
		expect(await owned.json()).toMatchObject({ document: { ownership: "owned", createdBy: fixture.userId } });
	});

	test("filters the list route by keyPrefix and refuses an invalid one", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const minted = await mint_service_grant(t, fixture);
		if (minted._nay) {
			throw new Error(minted._nay.message);
		}

		await t.mutation(internal.plugins_data.write_documents_batch, {
			principal: store_principal(fixture),
			documents: [
				{ collection: "meetings", key: "meeting:1", value: { n: 1 } },
				{ collection: "meetings", key: "note:1", value: { n: 2 } },
			],
		});

		const listed = await t.fetch("/api/v1/plugin-data/list", {
			method: "POST",
			headers: service_headers(minted._yay.token),
			body: JSON.stringify({ collection: "meetings", keyPrefix: "meeting:" }),
		});
		expect(listed.status).toBe(200);
		expect(await listed.json()).toMatchObject({ documents: [{ key: "meeting:1" }], isDone: true, cursor: null });

		// The shared prefix rule answers the refusal, so the route reports the same 400 the append does.
		for (const [keyPrefix, message] of [
			["no space", "Key prefixes must contain only printable ASCII characters"],
			["", "Key prefixes must not be empty"],
			["p".repeat(110), "Key prefixes must be at most 109 characters"],
		] as const) {
			const refused = await t.fetch("/api/v1/plugin-data/list", {
				method: "POST",
				headers: service_headers(minted._yay.token),
				body: JSON.stringify({ collection: "meetings", keyPrefix }),
			});
			expect(refused.status).toBe(400);
			expect(await refused.json()).toEqual({ message });
		}
	});

	test("continues a bounded key range from a fencepost, on both the page and the service token", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t);
		await t.run(async (ctx) => {
			// A page session is only minted for a version that declares a page.
			await ctx.db.patch("plugins_versions", fixture.pluginVersionId, {
				pages: [{ id: "meetings", title: "Meetings", entry: "pages/meetings.js", navItem: null }],
			});
		});
		const minted = await fixture.asUser.mutation(api.plugins_ui.mint_page_session, {
			membershipId: fixture.membershipId,
			pluginName: "council",
		});
		if (minted._nay) {
			throw new Error(minted._nay.message);
		}
		const service = await mint_service_grant(t, fixture);
		if (service._nay) {
			throw new Error(service._nay.message);
		}

		await t.mutation(internal.plugins_data.write_documents_batch, {
			principal: store_principal(fixture),
			documents: [
				{ collection: "meetings", key: "meeting:1", value: { n: 1 } },
				{ collection: "meetings", key: "meeting:2", value: { n: 2 } },
				{ collection: "meetings", key: "meeting:3", value: { n: 3 } },
				{ collection: "meetings", key: "meeting:4", value: { n: 4 } },
				{ collection: "meetings", key: "note:1", value: { n: 5 } },
			],
		});

		// The page token is §8.1's phase-1 consumer of this door, so page 1 goes through it.
		const page1 = await t.fetch("/api/v1/plugin-data/list", {
			method: "POST",
			headers: service_headers(minted._yay.token),
			body: JSON.stringify({ collection: "meetings", keyPrefix: "meeting:", limit: 2 }),
		});
		expect(page1.status).toBe(200);
		const page1Body = (await page1.json()) as { documents: { key: string }[] };
		const page1Keys = page1Body.documents.map((document) => document.key);
		expect(page1Keys).toEqual(["meeting:1", "meeting:2"]);

		// Page 2 carries no cursor at all: the fencepost is the continuation, and it survives a
		// process restart that would have thrown a cursor away.
		const page2 = await t.fetch("/api/v1/plugin-data/list", {
			method: "POST",
			headers: service_headers(service._yay.token),
			body: JSON.stringify({
				collection: "meetings",
				keyPrefix: "meeting:",
				keyStartExclusive: page1Keys.at(-1),
				limit: 2,
			}),
		});
		expect(page2.status).toBe(200);
		const page2Body = (await page2.json()) as { documents: { key: string }[] };
		const page2Keys = page2Body.documents.map((document) => document.key);
		expect(compareValues(page2Keys[0], page1Keys.at(-1))).toBeGreaterThan(0);
		expect(page2Keys.filter((key) => page1Keys.includes(key))).toEqual([]);

		// The two doors must agree on order, or a page that reads history over HTTP and live data
		// over the reactive door would interleave them wrongly.
		const watched = await fixture.asPage.query(api.plugins_data.watch_documents, {
			collection: "meetings",
			keyPrefix: "meeting:",
			limit: 10,
		});
		expect([...page1Keys, ...page2Keys]).toEqual(watched?.docs.map((document) => document.key));
	});

	test("a cursor continues inside its own range and is refused beside a changed one", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const minted = await mint_service_grant(t, fixture);
		if (minted._nay) {
			throw new Error(minted._nay.message);
		}

		await t.mutation(internal.plugins_data.write_documents_batch, {
			principal: store_principal(fixture),
			documents: [
				{ collection: "meetings", key: "meeting:1", value: { n: 1 } },
				{ collection: "meetings", key: "meeting:2", value: { n: 2 } },
				{ collection: "meetings", key: "meeting:3", value: { n: 3 } },
				{ collection: "meetings", key: "meeting:4", value: { n: 4 } },
			],
		});
		const list = async (body: Record<string, unknown>) =>
			await t.fetch("/api/v1/plugin-data/list", {
				method: "POST",
				headers: service_headers(minted._yay.token),
				body: JSON.stringify(body),
			});

		// A cursor and a key range compose: the cursor carries the range it was minted in, so sending
		// the same body back with it continues inside that range.
		const rangedBody = { collection: "meetings", keyPrefix: "meeting:", keyStartExclusive: "meeting:1", limit: 2 };
		const page1 = await list(rangedBody);
		expect(page1.status).toBe(200);
		const page1Body = (await page1.json()) as { documents: { key: string }[]; cursor: string | null };
		expect(page1Body.documents.map((document) => document.key)).toEqual(["meeting:2", "meeting:3"]);
		expect(page1Body.cursor).not.toBeNull();

		const page2 = await list({ ...rangedBody, cursor: page1Body.cursor });
		expect(page2.status).toBe(200);
		expect(await page2.json()).toMatchObject({ documents: [{ key: "meeting:4" }], isDone: true, cursor: null });

		// Replay the same cursor beside a changed range. The route rebuilds its index range from the
		// body, so this cursor now points into a query it was never minted for, and the page it would
		// answer would silently skip or repeat history. The message names the field that moved,
		// because the caller cannot diff a body they no longer hold.
		for (const [changedField, changedBody] of [
			["keyStartExclusive", { ...rangedBody, keyStartExclusive: "meeting:2" }],
			["keyEndInclusive", { ...rangedBody, keyEndInclusive: "meeting:4" }],
			["keyPrefix", { ...rangedBody, keyPrefix: "meeting" }],
			["collection", { ...rangedBody, collection: "notes" }],
		] as const) {
			const refused = await list({ ...changedBody, cursor: page1Body.cursor });
			expect([changedField, refused.status]).toEqual([changedField, 400]);
			expect(await refused.json()).toEqual({
				message: `cursor was issued for a different ${changedField}. Start a new page instead of reusing it.`,
			});
		}

		// A string that is not one of this route's cursors is refused before it can reach the store,
		// where it would throw while being parsed.
		const forged = await list({ ...rangedBody, cursor: "not-a-cursor" });
		expect(forged.status).toBe(400);
		expect(await forged.json()).toEqual({ message: "cursor is not a cursor this route issued" });

		// A client that always sends the field and passes null on the first page is sending a legal
		// body. Refusing it would 400 the fencepost path's own first request.
		const firstPage = await list({ collection: "meetings", keyStartExclusive: "meeting:1", cursor: null, limit: 1 });
		expect(firstPage.status).toBe(200);
		expect(await firstPage.json()).toMatchObject({ documents: [{ key: "meeting:2" }] });
	});

	test("a full ranged page hands back a cursor, and an exhausted one hands back none", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const minted = await mint_service_grant(t, fixture);
		if (minted._nay) {
			throw new Error(minted._nay.message);
		}

		await t.mutation(internal.plugins_data.write_documents_batch, {
			principal: store_principal(fixture),
			documents: [
				{ collection: "meetings", key: "meeting:1", value: { n: 1 } },
				{ collection: "meetings", key: "meeting:2", value: { n: 2 } },
				{ collection: "meetings", key: "meeting:3", value: { n: 3 } },
			],
		});

		// A full page inside a range says history continues and hands back the cursor that continues
		// it. The fencepost continuation still works too; both are valid, and a caller picks one.
		const full = await t.fetch("/api/v1/plugin-data/list", {
			method: "POST",
			headers: service_headers(minted._yay.token),
			body: JSON.stringify({ collection: "meetings", keyPrefix: "meeting:", keyStartExclusive: "meeting:1", limit: 1 }),
		});
		expect(full.status).toBe(200);
		const fullBody = (await full.json()) as { documents: { key: string }[]; cursor: string | null; isDone: boolean };
		expect(fullBody.documents.map((document) => document.key)).toEqual(["meeting:2"]);
		expect(fullBody.isDone).toBe(false);
		expect(typeof fullBody.cursor).toBe("string");

		// Past the end of the range there is nothing left, and that is what ends a "load older" loop.
		const past = await t.fetch("/api/v1/plugin-data/list", {
			method: "POST",
			headers: service_headers(minted._yay.token),
			body: JSON.stringify({ collection: "meetings", keyPrefix: "meeting:", keyStartExclusive: "meeting:3", limit: 1 }),
		});
		expect(past.status).toBe(200);
		expect(await past.json()).toEqual({ documents: [], cursor: null, isDone: true });
	});

	test("refuses a value field name Convex cannot store, and accepts the punctuation it can", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const minted = await mint_service_grant(t, fixture);
		if (minted._nay) {
			throw new Error(minted._nay.message);
		}
		const write = async (value: Record<string, unknown>) =>
			await t.fetch("/api/v1/plugin-data/write", {
				method: "POST",
				headers: service_headers(minted._yay.token),
				body: JSON.stringify({ collection: "meetings", key: "meeting-1", value }),
			});

		const nest = (levels: number) => {
			let value: Record<string, unknown> = { leaf: 1 };
			for (let index = 1; index < levels; index += 1) {
				value = { n: value };
			}
			return value;
		};
		const wide = (fields: number) => {
			const value: Record<string, unknown> = {};
			for (let index = 0; index < fields; index += 1) {
				value["f" + index] = 1;
			}
			return value;
		};

		// Convex refuses these while it serializes the mutation arguments or validates the document,
		// both of which happen outside the store's own refusals. Without the check at the route the
		// caller gets a server error for a value it could have sent differently. Every one is easy to
		// reach: a participant map keyed by name arrives with one accented letter, and sixteen nested
		// objects are about a hundred bytes. Nesting matters for names too, because a bad name may sit
		// any distance down inside the value.
		for (const value of [
			{ Renée: "present" },
			{ $set: 1 },
			{ attendees: [{ Zoë: "present" }] },
			{ notes: { ["n".repeat(1025)]: 1 } },
			{ text: "\ud800" },
			nest(16),
			{ attendees: [[[[[[[[[[[[[[[1]]]]]]]]]]]]]]] },
			wide(1025),
			{ samples: new Array(8193).fill(0) },
		]) {
			const refused = await write(value);
			expect(refused.status).toBe(400);
			expect(await refused.json()).toEqual({ message: "Request body validation failed" });
		}

		// The rule is about what Convex stores, not about tidy names or small values. Everything
		// printable still writes, and so does each shape that sits exactly at its limit.
		for (const value of [
			{ "participant name (2)": "present", "a-b_c.d/e": 1, ["n".repeat(1024)]: 1 },
			{ text: "😀" },
			nest(15),
			wide(1024),
		]) {
			const accepted = await write(value);
			expect(accepted.status).toBe(200);
		}
		expect(await read_documents(t, fixture)).toHaveLength(1);
	});

	test("refuses malformed strings and oversized or unknown request fields before the store call", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const minted = await mint_service_grant(t, fixture);
		if (minted._nay) {
			throw new Error(minted._nay.message);
		}

		const malformed = await t.fetch("/api/v1/plugin-data/write", {
			method: "POST",
			headers: service_headers(minted._yay.token),
			body: JSON.stringify({ collection: "\ud800", key: "meeting-1", value: { title: "Weekly sync" } }),
		});
		expect(malformed.status).toBe(400);
		expect(await malformed.json()).toEqual({ message: "Request body validation failed" });

		const unknown = await t.fetch("/api/v1/plugin-data/read", {
			method: "POST",
			headers: service_headers(minted._yay.token),
			body: JSON.stringify({ collection: "meetings", key: "meeting-1", padding: "not allowed" }),
		});
		expect(unknown.status).toBe(400);
		expect(await unknown.json()).toEqual({ message: "Request body validation failed" });

		const oversized = await t.fetch("/api/v1/plugin-data/read", {
			method: "POST",
			headers: service_headers(minted._yay.token),
			body: JSON.stringify({ collection: "meetings", key: "meeting-1", padding: "x".repeat(64 * 1024) }),
		});
		expect(oversized.status).toBe(400);
		expect(await oversized.json()).toEqual({ message: "Request body is too large" });
		expect(await read_documents(t, fixture)).toHaveLength(0);
	});

	test("checks the value shape on every route that carries one", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const minted = await mint_service_grant(t, fixture);
		if (minted._nay) {
			throw new Error(minted._nay.message);
		}

		// One validator is shared by three bodies. A route that dropped it would answer 500 for the
		// same value the other two refuse with 400.
		for (const [path, body] of [
			["/api/v1/plugin-data/write", { collection: "meetings", key: "m", value: { $set: 1 } }],
			["/api/v1/plugin-data/write-batch", { documents: [{ collection: "meetings", key: "m", value: { $set: 1 } }] }],
			["/api/v1/plugin-data/write-versioned", { collection: "meetings", key: "m", revision: 1, value: { $set: 1 } }],
		] as const) {
			const refused = await t.fetch(path, {
				method: "POST",
				headers: service_headers(minted._yay.token),
				body: JSON.stringify(body),
			});
			expect(refused.status).toBe(400);
			expect(await refused.json()).toEqual({ message: "Request body validation failed" });
		}

		expect(await read_documents(t, fixture)).toHaveLength(0);
	});

	test("refuses a token whose grant lost the write scope, and writes nothing", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const minted = await mint_service_grant(t, fixture, { requestedScopes: ["plugin_data:read"] });
		if (minted._nay) {
			throw new Error(minted._nay.message);
		}

		const written = await t.fetch("/api/v1/plugin-data/write", {
			method: "POST",
			headers: service_headers(minted._yay.token),
			body: JSON.stringify({ collection: "meetings", key: "meeting-1", value: { n: 1 } }),
		});
		expect(written.status).toBe(403);
		expect(await written.json()).toEqual({ message: "Permission denied" });
		expect(await read_documents(t, fixture)).toHaveLength(0);
		expect(await read_usage(t, fixture)).toBeNull();
	});

	test("refuses an ordered write from a token that is not a service grant", async () => {
		const t = test_convex();
		const fixture = await seed_installation_with_key_owner(t, "plugin-data-routes");
		const created = await fixture.asUser.mutation(api.public_api.api_credential_create, {
			membershipId: fixture.membershipId,
			name: "Plugin data key",
			scopes: ["plugin_data:read", "plugin_data:write"],
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		const credential = created._yay.credential;

		// Ordered writes belong to one external producer, so a person's key cannot use them at all.
		const ordered = await t.fetch("/api/v1/plugin-data/write-versioned", {
			method: "POST",
			headers: service_headers(credential),
			body: JSON.stringify({ collection: "meetings", key: "meeting-1", revision: 1, value: { n: 1 } }),
		});
		expect(ordered.status).toBe(403);
		expect(await ordered.json()).toEqual({ message: "Permission denied" });

		// The same key writes normally once it names the installation it means.
		const missingInstallation = await t.fetch("/api/v1/plugin-data/write", {
			method: "POST",
			headers: service_headers(credential),
			body: JSON.stringify({ collection: "meetings", key: "meeting-1", value: { n: 1 } }),
		});
		expect(missingInstallation.status).toBe(400);
		expect(await missingInstallation.json()).toEqual({ message: "installationId is required for an API key" });

		const written = await t.fetch("/api/v1/plugin-data/write", {
			method: "POST",
			headers: service_headers(credential),
			body: JSON.stringify({
				installationId: fixture.installationId,
				collection: "meetings",
				key: "meeting-1",
				value: { n: 1 },
			}),
		});
		expect(written.status).toBe(200);
		expect(await read_documents(t, fixture)).toHaveLength(1);
	});

	test("keeps plugin-data out of a run's baseline and gives it only what was accepted", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);

		// An installation that predates the store consented to a plugin that could persist nothing, and
		// it keeps that deal until an upgrade makes the workspace accept the new capability. So a run on
		// such an installation must be refused even though the routes accept its kind.
		const withoutConsent = await start_plugin_run(t, fixture, {
			acceptedCapabilities: ["plugin.secrets.read", "outbound.fetch"],
			tokenSeed: "a",
		});
		for (const route of ["/api/v1/plugin-data/read", "/api/v1/plugin-data/write"]) {
			const refused = await t.fetch(route, {
				method: "POST",
				headers: service_headers(withoutConsent.apiToken),
				body: JSON.stringify({ collection: "meetings", key: "meeting-1", value: { n: 1 } }),
			});
			expect([route, refused.status]).toEqual([route, 403]);
		}
		expect(await read_documents(t, fixture)).toHaveLength(0);

		// The same installation, the same routes, one accepted capability apart.
		const readOnly = await start_plugin_run(t, fixture, {
			acceptedCapabilities: ["plugin.data.read"],
			tokenSeed: "b",
		});
		const read = await t.fetch("/api/v1/plugin-data/read", {
			method: "POST",
			headers: service_headers(readOnly.apiToken),
			body: JSON.stringify({ collection: "meetings", key: "meeting-1" }),
		});
		expect(read.status).toBe(200);
		const written = await t.fetch("/api/v1/plugin-data/write", {
			method: "POST",
			headers: service_headers(readOnly.apiToken),
			body: JSON.stringify({ collection: "meetings", key: "meeting-1", value: { n: 1 } }),
		});
		expect(written.status).toBe(403);
		expect(await read_documents(t, fixture)).toHaveLength(0);

		const readWrite = await start_plugin_run(t, fixture, {
			acceptedCapabilities: ["plugin.data.read", "plugin.data.write"],
			tokenSeed: "c",
		});
		const allowed = await t.fetch("/api/v1/plugin-data/write", {
			method: "POST",
			headers: service_headers(readWrite.apiToken),
			body: JSON.stringify({ collection: "meetings", key: "meeting-1", value: { n: 1 } }),
		});
		expect(allowed.status).toBe(200);
		expect(await read_documents(t, fixture)).toHaveLength(1);
	});

	test("lets a plugin page read and refuses it every write", async () => {
		const t = test_convex();
		const fixture = await seed_installation_with_key_owner(t, "plugin-data-page");
		await t.run(async (ctx) => {
			// A page session is only minted for a version that declares a page.
			await ctx.db.patch("plugins_versions", fixture.pluginVersionId, {
				pages: [{ id: "meetings", title: "Meetings", entry: "pages/meetings.js", navItem: null }],
			});
		});
		await t.mutation(internal.plugins_data.write_document, {
			principal: store_principal(fixture),
			collection: "meetings",
			key: "meeting-1",
			value: { title: "Weekly sync" },
		});

		const minted = await fixture.asUser.mutation(api.plugins_ui.mint_page_session, {
			membershipId: fixture.membershipId,
			pluginName: "council",
		});
		if (minted._nay) {
			throw new Error(minted._nay.message);
		}

		// A page runs the plugin's own script inside the workspace member's browser, so it reads what
		// the plugin stored and writes nothing. A scripting bug on a page must not be able to put data
		// into the store that a plugin backend later acts on with its own secrets.
		const read = await t.fetch("/api/v1/plugin-data/read", {
			method: "POST",
			headers: service_headers(minted._yay.token),
			body: JSON.stringify({ collection: "meetings", key: "meeting-1" }),
		});
		expect(read.status).toBe(200);
		expect(await read.json()).toMatchObject({ document: { value: { title: "Weekly sync" } } });

		for (const [route, body] of [
			["/api/v1/plugin-data/write", { collection: "meetings", key: "meeting-2", value: { n: 2 } }],
			["/api/v1/plugin-data/write-batch", { documents: [{ collection: "meetings", key: "m", value: { n: 2 } }] }],
			["/api/v1/plugin-data/delete", { collection: "meetings", key: "meeting-1" }],
			["/api/v1/plugin-data/write-versioned", { collection: "meetings", key: "m", revision: 1, value: { n: 2 } }],
			["/api/v1/plugin-data/delete-versioned", { collection: "meetings", key: "meeting-1", revision: 1 }],
			[
				"/api/v1/plugin-data/reserve",
				{
					collection: "meetings",
					key: "m",
					maximumBytes: 100,
					idempotencyKey: "reserve-1",
					expiresAt: Date.now() + 60_000,
				},
			],
			["/api/v1/plugin-data/release-reservation", { collection: "meetings", key: "m", idempotencyKey: "reserve-1" }],
		] as const) {
			const refused = await t.fetch(route, {
				method: "POST",
				headers: service_headers(minted._yay.token),
				body: JSON.stringify(body),
			});
			expect([route, refused.status]).toEqual([route, 403]);
		}

		// Read the tables, not the refusals: the owner's one document is all that may be there.
		const stored = await read_documents(t, fixture);
		expect(stored).toHaveLength(1);
		expect(stored[0]).toMatchObject({ key: "meeting-1" });
		expect(await read_reservations(t, fixture)).toHaveLength(0);
	});

	test("refuses a body that names an installation on every route a plugin token can call", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const otherFixture = await seed_installation(t, { organizationName: "other-organization" });
		const minted = await mint_service_grant(t, fixture);
		if (minted._nay) {
			throw new Error(minted._nay.message);
		}

		// A service token already carries the installation it may touch. Naming a second one is how a
		// caller would try to reach an installation its token does not cover, so every route refuses it
		// by name. The four ordered routes take no key at all and still declare the field, because a
		// silently dropped field leaves the caller believing the installation it named was honoured.
		const bodies: Record<string, Record<string, unknown>> = {
			"/api/v1/plugin-data/read": { collection: "meetings", key: "m" },
			"/api/v1/plugin-data/list": { collection: "meetings" },
			"/api/v1/plugin-data/write": { collection: "meetings", key: "m", value: { n: 1 } },
			"/api/v1/plugin-data/write-batch": { documents: [{ collection: "meetings", key: "m", value: { n: 1 } }] },
			"/api/v1/plugin-data/delete": { collection: "meetings", key: "m" },
			"/api/v1/plugin-data/write-versioned": { collection: "meetings", key: "m", revision: 1, value: { n: 1 } },
			"/api/v1/plugin-data/delete-versioned": { collection: "meetings", key: "m", revision: 1 },
			"/api/v1/plugin-data/reserve": {
				collection: "meetings",
				key: "m",
				maximumBytes: 1000,
				idempotencyKey: "reserve-1",
				expiresAt: Date.now() + 60_000,
			},
			"/api/v1/plugin-data/release-reservation": { collection: "meetings", key: "m", idempotencyKey: "reserve-1" },
		};

		for (const [route, body] of Object.entries(bodies)) {
			const refused = await t.fetch(route, {
				method: "POST",
				headers: service_headers(minted._yay.token),
				body: JSON.stringify({ ...body, installationId: otherFixture.installationId }),
			});
			expect([route, refused.status]).toEqual([route, 400]);
			expect([route, await refused.json()]).toEqual([
				route,
				{ message: "installationId is not allowed for this token" },
			]);
		}

		// Read both installations, not the refusals: a route that honoured the named installation would
		// have written into a tenant this token has nothing to do with.
		expect(await read_documents(t, fixture)).toHaveLength(0);
		expect(await read_documents(t, otherFixture)).toHaveLength(0);
		expect(await read_reservations(t, otherFixture)).toHaveLength(0);
	});

	test("refuses an installation the key's tenant does not own, and one that is not an id", async () => {
		const t = test_convex();
		const fixture = await seed_installation_with_key_owner(t, "plugin-data-cross-tenant");
		const otherFixture = await seed_installation(t, { organizationName: "other-organization" });
		const created = await fixture.asUser.mutation(api.public_api.api_credential_create, {
			membershipId: fixture.membershipId,
			name: "Plugin data key",
			scopes: ["plugin_data:write"],
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		for (const installationId of [otherFixture.installationId, "not-an-id"]) {
			const written = await t.fetch("/api/v1/plugin-data/write", {
				method: "POST",
				headers: service_headers(created._yay.credential),
				body: JSON.stringify({ installationId, collection: "meetings", key: "meeting-1", value: { n: 1 } }),
			});
			expect(written.status).toBe(404);
			expect(await written.json()).toEqual({ message: "Not found" });
		}

		expect(await read_documents(t, fixture)).toHaveLength(0);
		expect(await read_documents(t, otherFixture)).toHaveLength(0);
	});

	test("refuses a whole batch that is over the item cap and one that repeats a document", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const minted = await mint_service_grant(t, fixture);
		if (minted._nay) {
			throw new Error(minted._nay.message);
		}

		const overCap = await t.fetch("/api/v1/plugin-data/write-batch", {
			method: "POST",
			headers: service_headers(minted._yay.token),
			body: JSON.stringify({
				documents: Array.from({ length: 51 }, (_, index) => ({
					collection: "meetings",
					key: `meeting-${index}`,
					value: { n: index },
				})),
			}),
		});
		expect(overCap.status).toBe(400);

		const repeated = await t.fetch("/api/v1/plugin-data/write-batch", {
			method: "POST",
			headers: service_headers(minted._yay.token),
			body: JSON.stringify({
				documents: [
					{ collection: "meetings", key: "meeting-1", value: { n: 1 } },
					{ collection: "meetings", key: "meeting-1", value: { n: 2 } },
				],
			}),
		});
		expect(repeated.status).toBe(400);
		expect(await repeated.json()).toEqual({ message: "A write batch names the same document twice" });
		expect(await read_documents(t, fixture)).toHaveLength(0);
	});

	test("accepts a valid batch whose body is larger than the normal request limit", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const minted = await mint_service_grant(t, fixture);
		if (minted._nay) {
			throw new Error(minted._nay.message);
		}
		const documents = Array.from({ length: 50 }, (_, index) => ({
			collection: "meetings",
			key: `meeting-${index}`,
			value: { payload: "x".repeat(2048) },
		}));
		const body = JSON.stringify({ documents });
		expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(64 * 1024);

		const written = await t.fetch("/api/v1/plugin-data/write-batch", {
			method: "POST",
			headers: service_headers(minted._yay.token),
			body,
		});
		expect(written.status).toBe(200);
		expect(((await written.json()) as { documents: unknown[] }).documents).toHaveLength(50);
		expect(await read_documents(t, fixture)).toHaveLength(50);
		expect(await read_usage(t, fixture)).toMatchObject({ usedBytes: 103_100, usedDocuments: 50 });
	});

	test("charges a batch for every document it carries and keeps one plugin's bucket off another's", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const other = await seed_installation(t, { organizationName: "other-organization" });
		const minted = await mint_service_grant(t, fixture);
		const otherMinted = await mint_service_grant(t, other);
		if (minted._nay || otherMinted._nay) {
			throw new Error(minted._nay?.message ?? otherMinted._nay!.message);
		}

		const batch = async (token: string, prefix: string, size: number) =>
			await t.fetch("/api/v1/plugin-data/write-batch", {
				method: "POST",
				headers: service_headers(token),
				body: JSON.stringify({
					documents: Array.from({ length: size }, (_, index) => ({
						collection: "meetings",
						key: `${prefix}-${index}`,
						value: { n: index },
					})),
				}),
			});

		// Freeze the limiter clock while the two large writes run. Otherwise the bucket refills during
		// the test itself, and a slow machine can make the final request pass.
		const limiterNow = Date.now();
		const dateNow = vi.spyOn(Date, "now").mockReturnValue(limiterNow);
		try {
			// The bucket holds 100 documents, so two full batches spend all of it. A batch that only cost
			// one token per request would leave 98 here and never reach the refusal below.
			expect((await batch(minted._yay.token, "a", 50)).status).toBe(200);
			expect((await batch(minted._yay.token, "b", 50)).status).toBe(200);
			expect((await batch(minted._yay.token, "c", 1)).status).toBe(429);

			// The bucket key is the principal, so another plugin's service still has its own full bucket.
			expect((await batch(otherMinted._yay.token, "a", 50)).status).toBe(200);
		} finally {
			dateNow.mockRestore();
		}

		expect(await read_documents(t, fixture)).toHaveLength(100);
		expect(await read_documents(t, other)).toHaveLength(50);
	});

	test("an exhausted bulk bucket rejects the whole batch before any write", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const minted = await mint_service_grant(t, fixture);
		if (minted._nay) {
			throw new Error(minted._nay.message);
		}

		// Leave the bucket with room for one document, then send two. The batch pays for every document
		// it carries up front, so it must be refused as a whole instead of writing the one it can afford.
		const drained = await t.run(
			async (ctx) =>
				await rate_limiter_limit_by_key(ctx, {
					name: "public_api_plugin_data_write_bulk",
					key: `plugin_service:${minted._yay.principalKey}`,
					count: 99,
				}),
		);
		expect(drained).toBeNull();

		const blocked = await t.fetch("/api/v1/plugin-data/write-batch", {
			method: "POST",
			headers: service_headers(minted._yay.token),
			body: JSON.stringify({
				documents: [
					{ collection: "meetings", key: "meeting-1", value: { n: 1 } },
					{ collection: "meetings", key: "meeting-2", value: { n: 2 } },
				],
			}),
		});
		expect(blocked.status).toBe(429);
		expect(typeof ((await blocked.json()) as { retryAfterMs: number }).retryAfterMs).toBe("number");

		expect(await read_documents(t, fixture)).toHaveLength(0);
		expect(await read_usage(t, fixture)).toBeNull();
	});

	test("orders a producer's writes and refuses a late one after its delete", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const minted = await mint_service_grant(t, fixture);
		if (minted._nay) {
			throw new Error(minted._nay.message);
		}
		const ordered = async (body: Record<string, unknown>) =>
			await t.fetch("/api/v1/plugin-data/write-versioned", {
				method: "POST",
				headers: service_headers(minted._yay.token),
				body: JSON.stringify(body),
			});

		expect((await ordered({ collection: "meetings", key: "m", revision: 1, value: { n: 1 } })).status).toBe(200);
		const skipped = await ordered({ collection: "meetings", key: "m", revision: 3, value: { n: 3 } });
		expect(skipped.status).toBe(409);
		expect(await skipped.json()).toEqual({ message: "This document does not have the revision before this one" });

		const deleted = await t.fetch("/api/v1/plugin-data/delete-versioned", {
			method: "POST",
			headers: service_headers(minted._yay.token),
			body: JSON.stringify({ collection: "meetings", key: "m", revision: 4 }),
		});
		expect(deleted.status).toBe(200);
		expect(await deleted.json()).toEqual({ deleted: true, revision: 4 });
		expect(await read_documents(t, fixture)).toHaveLength(0);

		const late = await ordered({ collection: "meetings", key: "m", revision: 2, value: { n: 2 } });
		expect(late.status).toBe(409);
		expect(await late.json()).toEqual({ message: "This document was deleted by its service" });
		expect(await read_documents(t, fixture)).toHaveLength(0);
	});

	test("answers a full store with 403, not the 400 every other refused body gets", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const minted = await mint_service_grant(t, fixture);
		if (minted._nay) {
			throw new Error(minted._nay.message);
		}
		const write = async (key: string) =>
			await t.fetch("/api/v1/plugin-data/write", {
				method: "POST",
				headers: service_headers(minted._yay.token),
				body: JSON.stringify({ collection: "meetings", key, value: { n: 1 } }),
			});

		// The first write creates the usage document this test then fills to the ceiling.
		expect((await write("a")).status).toBe(200);
		await t.run(async (ctx) => {
			const usage = await ctx.db
				.query("plugins_data_usage")
				.withIndex("by_installation", (q) => q.eq("installationId", fixture.installationId))
				.first();
			await ctx.db.patch("plugins_data_usage", usage!._id, { usedBytes: 16 * 1024 * 1024 });
		});

		const full = await write("b");
		expect(full.status).toBe(403);
		expect(await full.json()).toEqual({ message: "This plugin has used its 16 MiB of storage" });
		expect(await read_documents(t, fixture)).toHaveLength(1);
	});

	test("reserves and releases capacity through the routes", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const minted = await mint_service_grant(t, fixture);
		if (minted._nay) {
			throw new Error(minted._nay.message);
		}
		const expiresAt = Date.now() + 60_000;

		const reserved = await t.fetch("/api/v1/plugin-data/reserve", {
			method: "POST",
			headers: service_headers(minted._yay.token),
			body: JSON.stringify({
				collection: "meetings",
				key: "m",
				maximumBytes: 1000,
				idempotencyKey: "reserve-1",
				expiresAt,
			}),
		});
		expect(reserved.status).toBe(200);
		// The producer needs the id back to name this reservation in its own records.
		const [stored] = await read_reservations(t, fixture);
		expect(await reserved.json()).toEqual({
			reservationId: stored._id,
			remainingBytes: 1000,
			expiresAt: expect.any(Number),
		});
		expect(await read_usage(t, fixture)).toMatchObject({ reservedBytes: 1000, reservedDocuments: 1 });

		const released = await t.fetch("/api/v1/plugin-data/release-reservation", {
			method: "POST",
			headers: service_headers(minted._yay.token),
			body: JSON.stringify({ collection: "meetings", key: "m", idempotencyKey: "reserve-1" }),
		});
		expect(released.status).toBe(200);
		expect(await released.json()).toEqual({ releasedBytes: 1000 });
		expect(await read_usage(t, fixture)).toMatchObject({ reservedBytes: 0, reservedDocuments: 0 });

		// A producer that never saw the release answer resends the reserve. The route must call that a
		// conflict, because a 400 would tell the producer its request was malformed and worth rewriting.
		const replayed = await t.fetch("/api/v1/plugin-data/reserve", {
			method: "POST",
			headers: service_headers(minted._yay.token),
			body: JSON.stringify({
				collection: "meetings",
				key: "m",
				maximumBytes: 1000,
				idempotencyKey: "reserve-1",
				expiresAt,
			}),
		});
		expect(replayed.status).toBe(409);
		expect(await replayed.json()).toEqual({ message: "This reservation was already released" });
		expect(await read_usage(t, fixture)).toMatchObject({ reservedBytes: 0, reservedDocuments: 0 });
	});
});

describe("/api/v1/auth/verify", () => {
	test("reports the scopes a key still has, without needing any one of them", async () => {
		const t = test_convex();
		const fixture = await seed_installation_with_key_owner(t, "plugin-data-verify");
		const created = await fixture.asUser.mutation(api.public_api.api_credential_create, {
			membershipId: fixture.membershipId,
			name: "Plugin data key",
			scopes: ["plugin_data:read"],
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		// A key with no file scope at all still verifies. Testing through a file route would refuse it.
		const verified = await t.fetch("/api/v1/auth/verify", {
			method: "POST",
			headers: { Authorization: `Bearer ${created._yay.credential}` },
		});
		expect(verified.status).toBe(200);
		expect(await verified.json()).toEqual({
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			scopes: ["plugin_data:read"],
		});

		const revoked = await fixture.asUser.mutation(api.public_api.api_credential_revoke, {
			membershipId: fixture.membershipId,
			credentialId: created._yay.credentialId,
		});
		expect(revoked._nay).toBeUndefined();
		const afterRevoke = await t.fetch("/api/v1/auth/verify", {
			method: "POST",
			headers: { Authorization: `Bearer ${created._yay.credential}` },
		});
		expect(afterRevoke.status).toBe(401);
	});

	test("drops a plugin-data scope the key's owner can no longer use", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const viewer = await join_member_with_role(t, fixture, {
			clerkUserId: "plugin-data-viewer-key",
			role: "viewer",
		});

		// Anybody may mint a key with any scope: nothing is checked at mint time on purpose, because a
		// scope the person cannot use is meant to be filtered at request time instead. That makes this
		// the place where "a key can never do more than the person who owns it" is either true or not.
		const created = await viewer.asUser.mutation(api.public_api.api_credential_create, {
			membershipId: viewer.membershipId,
			name: "Viewer key",
			scopes: ["plugin_data:read", "plugin_data:write"],
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		const verified = await t.fetch("/api/v1/auth/verify", {
			method: "POST",
			headers: { Authorization: `Bearer ${created._yay.credential}` },
		});
		expect(verified.status).toBe(200);
		expect(await verified.json()).toEqual({
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			scopes: ["plugin_data:read"],
		});

		// What the report says and what the routes do must be the same answer.
		const written = await t.fetch("/api/v1/plugin-data/write", {
			method: "POST",
			headers: service_headers(created._yay.credential),
			body: JSON.stringify({
				installationId: fixture.installationId,
				collection: "meetings",
				key: "meeting-1",
				value: { n: 1 },
			}),
		});
		expect(written.status).toBe(403);
		expect(await written.json()).toEqual({ message: "Permission denied" });
		expect(await read_documents(t, fixture)).toHaveLength(0);

		const read = await t.fetch("/api/v1/plugin-data/read", {
			method: "POST",
			headers: service_headers(created._yay.credential),
			body: JSON.stringify({ installationId: fixture.installationId, collection: "meetings", key: "meeting-1" }),
		});
		expect(read.status).toBe(200);
	});

	test("refuses a plugin token", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const minted = await mint_service_grant(t, fixture);
		if (minted._nay) {
			throw new Error(minted._nay.message);
		}

		const refused = await t.fetch("/api/v1/auth/verify", {
			method: "POST",
			headers: { Authorization: `Bearer ${minted._yay.token}` },
		});
		expect(refused.status).toBe(403);
		expect(await refused.json()).toEqual({ message: "Permission denied" });
	});
});

function store_principal(
	fixture: Awaited<ReturnType<typeof seed_installation>>,
	args: {
		kind?: "user_api_key" | "plugin_run" | "plugin_ui" | "plugin_service";
		// A plain string, like the store's own field: a user API key names its installation in the
		// request body, so a test must be able to pass something that is not an id at all.
		installationId?: string;
		actorUserId?: Id<"users">;
		principalKey?: string;
	} = {},
) {
	const kind = args.kind ?? "plugin_run";
	return {
		kind,
		organizationId: fixture.organizationId,
		workspaceId: fixture.workspaceId,
		installationId: args.installationId ?? fixture.installationId,
		actorUserId: args.actorUserId ?? fixture.userId,
		principalKey: args.principalKey ?? `${kind}:${fixture.installationId}`,
	} as const;
}

/** One external producer. Ordered writes bind a key to this exact principal key for good. */
function service_principal(
	fixture: Awaited<ReturnType<typeof seed_installation>>,
	args: { principalKey?: string } = {},
) {
	return store_principal(fixture, { kind: "plugin_service", principalKey: args.principalKey });
}

async function read_reservations(
	t: ReturnType<typeof test_convex>,
	fixture: Awaited<ReturnType<typeof seed_installation>>,
) {
	return await t.run(
		async (ctx) =>
			await ctx.db
				.query("plugins_data_reservations")
				.withIndex("by_installation_state_collection_key", (q) => q.eq("installationId", fixture.installationId))
				.collect(),
	);
}

async function read_usage(t: ReturnType<typeof test_convex>, fixture: Awaited<ReturnType<typeof seed_installation>>) {
	return await t.run(
		async (ctx) =>
			await ctx.db
				.query("plugins_data_usage")
				.withIndex("by_installation", (q) => q.eq("installationId", fixture.installationId))
				.first(),
	);
}

async function read_documents(
	t: ReturnType<typeof test_convex>,
	fixture: Awaited<ReturnType<typeof seed_installation>>,
) {
	return await t.run(
		async (ctx) =>
			await ctx.db
				.query("plugins_data")
				.withIndex("by_installation_collection_key", (q) => q.eq("installationId", fixture.installationId))
				.collect(),
	);
}

/** The canonical JSON is `{"a":"..."}`, so a value of exactly N bytes needs N - 8 characters. */
function value_of_bytes(byteSize: number) {
	return { a: "x".repeat(byteSize - 8) };
}

describe("write_document", () => {
	test("stores the document and its accounting in one transaction", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);

		const written = await t.mutation(internal.plugins_data.write_document, {
			principal: store_principal(fixture),
			collection: "meetings",
			key: "meeting-1",
			value: { title: "Weekly sync", participants: 3 },
		});
		if (written._nay) {
			throw new Error(written._nay.message);
		}
		// The canonical JSON is `{"participants":3,"title":"Weekly sync"}`, with sorted field names.
		expect(written._yay).toEqual({ revision: 1, byteSize: 40 });

		const documents = await read_documents(t, fixture);
		expect(documents).toHaveLength(1);
		expect(documents[0]).toMatchObject({
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			installationId: fixture.installationId,
			pluginName: "council",
			collection: "meetings",
			key: "meeting-1",
			value: { title: "Weekly sync", participants: 3 },
			revision: 1,
			byteSize: 40,
			writeMode: "normal",
			// The service write path stamps shared on docs it creates now that the field is required.
			ownership: "shared",
			createdBy: fixture.userId,
			updatedBy: fixture.userId,
		});

		expect(await read_usage(t, fixture)).toMatchObject({
			usedBytes: 40,
			usedDocuments: 1,
			reservedBytes: 0,
			reservedDocuments: 0,
			tombstoneDocuments: 0,
			collectionNames: ["meetings"],
		});

		const read = await t.query(internal.plugins_data.read_document, {
			principal: store_principal(fixture),
			collection: "meetings",
			key: "meeting-1",
		});
		expect(read._yay).toMatchObject({ key: "meeting-1", revision: 1, value: { title: "Weekly sync" } });
	});

	test("prices a replacement by the byte difference and keeps one slot", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const principal = store_principal(fixture);

		await t.mutation(internal.plugins_data.write_document, {
			principal,
			collection: "meetings",
			key: "meeting-1",
			value: value_of_bytes(1000),
		});
		const replaced = await t.mutation(internal.plugins_data.write_document, {
			principal,
			collection: "meetings",
			key: "meeting-1",
			value: value_of_bytes(400),
		});
		if (replaced._nay) {
			throw new Error(replaced._nay.message);
		}
		expect(replaced._yay).toEqual({ revision: 2, byteSize: 400 });

		expect(await read_usage(t, fixture)).toMatchObject({ usedBytes: 400, usedDocuments: 1 });
		expect(await read_documents(t, fixture)).toHaveLength(1);
	});

	test("adds a collection with its first document and drops it with its last", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const principal = store_principal(fixture);

		await t.mutation(internal.plugins_data.write_document, {
			principal,
			collection: "meetings",
			key: "a",
			value: { n: 1 },
		});
		await t.mutation(internal.plugins_data.write_document, {
			principal,
			collection: "meetings",
			key: "b",
			value: { n: 2 },
		});
		await t.mutation(internal.plugins_data.write_document, {
			principal,
			collection: "notes",
			key: "a",
			value: { n: 3 },
		});
		expect((await read_usage(t, fixture))?.collectionNames).toEqual(["meetings", "notes"]);

		// One of two documents leaves, so the collection stays.
		await t.mutation(internal.plugins_data.delete_document, { principal, collection: "meetings", key: "a" });
		expect((await read_usage(t, fixture))?.collectionNames).toEqual(["meetings", "notes"]);

		await t.mutation(internal.plugins_data.delete_document, { principal, collection: "meetings", key: "b" });
		expect(await read_usage(t, fixture)).toMatchObject({
			collectionNames: ["notes"],
			usedDocuments: 1,
			usedBytes: 7,
		});
	});

	test("refuses the seventeenth collection but still writes into the sixteen it has", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const principal = store_principal(fixture);

		await t.mutation(internal.plugins_data.write_document, {
			principal,
			collection: "collection-0",
			key: "a",
			value: { n: 0 },
		});
		await t.run(async (ctx) => {
			const usage = await ctx.db
				.query("plugins_data_usage")
				.withIndex("by_installation", (q) => q.eq("installationId", fixture.installationId))
				.first();
			await ctx.db.patch("plugins_data_usage", usage!._id, {
				collectionNames: Array.from({ length: 15 }, (_, index) => `collection-${index}`),
			});
		});

		// The sixteenth is the last one that fits, and it must be accepted. Checking only the refusal
		// would keep passing if the ceiling were off by one and the sixteenth were refused too.
		const sixteenth = await t.mutation(internal.plugins_data.write_document, {
			principal,
			collection: "collection-15",
			key: "a",
			value: { n: 15 },
		});
		expect(sixteenth._nay).toBeUndefined();
		expect((await read_usage(t, fixture))?.collectionNames).toHaveLength(16);

		const refused = await t.mutation(internal.plugins_data.write_document, {
			principal,
			collection: "collection-16",
			key: "a",
			value: { n: 16 },
		});
		expect(refused._nay?.message).toBe("This plugin can use at most 16 collections");

		const accepted = await t.mutation(internal.plugins_data.write_document, {
			principal,
			collection: "collection-15",
			key: "b",
			value: { n: 15 },
		});
		expect(accepted._nay).toBeUndefined();
	});

	test("refuses the slot after the last one, and still replaces an existing document", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const principal = store_principal(fixture);

		await t.mutation(internal.plugins_data.write_document, {
			principal,
			collection: "meetings",
			key: "a",
			value: { n: 1 },
		});
		// Reservations and tombstones share the ceiling with values, so spend it across all three.
		await t.run(async (ctx) => {
			const usage = await ctx.db
				.query("plugins_data_usage")
				.withIndex("by_installation", (q) => q.eq("installationId", fixture.installationId))
				.first();
			await ctx.db.patch("plugins_data_usage", usage!._id, {
				usedDocuments: 8999,
				reservedDocuments: 500,
				tombstoneDocuments: 500,
			});
		});

		// 9999 slots are spent, so the next new document takes the last one and must be accepted.
		const lastSlot = await t.mutation(internal.plugins_data.write_document, {
			principal,
			collection: "meetings",
			key: "b",
			value: { n: 2 },
		});
		expect(lastSlot._nay).toBeUndefined();

		const refused = await t.mutation(internal.plugins_data.write_document, {
			principal,
			collection: "meetings",
			key: "c",
			value: { n: 3 },
		});
		expect(refused._nay?.message).toBe("This plugin has used its 10000 document slots");

		// Replacing a stored document costs no new slot, so a full store can still be updated.
		const replaced = await t.mutation(internal.plugins_data.write_document, {
			principal,
			collection: "meetings",
			key: "a",
			value: { n: 2 },
		});
		expect(replaced._nay).toBeUndefined();
	});

	test("a paid plan buys ten times the slots, read off the payer's synced product", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t, { plan: "Pro" });
		const principal = store_principal(fixture);

		await t.mutation(internal.plugins_data.write_document, {
			principal,
			collection: "meetings",
			key: "a",
			value: { n: 1 },
		});
		await t.run(async (ctx) => {
			const usage = await ctx.db
				.query("plugins_data_usage")
				.withIndex("by_installation", (q) => q.eq("installationId", fixture.installationId))
				.first();
			await ctx.db.patch("plugins_data_usage", usage!._id, { usedDocuments: 99_999 });
		});

		// 99,999 slots are spent, so the next new document takes the last one and must be accepted.
		const lastSlot = await t.mutation(internal.plugins_data.write_document, {
			principal,
			collection: "meetings",
			key: "b",
			value: { n: 2 },
		});
		expect(lastSlot._nay).toBeUndefined();

		const refused = await t.mutation(internal.plugins_data.write_document, {
			principal,
			collection: "meetings",
			key: "c",
			value: { n: 3 },
		});
		expect(refused._nay?.name).toBe("storage_full");
		expect(refused._nay?.message).toBe("This plugin has used its 100000 document slots");
	});

	test("downgrade keeps stored data usable but refuses new documents at the smaller ceiling", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t, { plan: "Pro" });
		const principal = store_principal(fixture);

		// Documents stored while the payer is on Pro. The downgrade below moves usage past the Free
		// ceiling without deleting anything, which is what a real downgrade must do to data.
		for (const key of ["a", "b"] as const) {
			const written = await t.mutation(internal.plugins_data.write_document, {
				principal,
				collection: "meetings",
				key,
				value: { n: 1 },
			});
			expect(written._nay).toBeUndefined();
		}
		await t.run(async (ctx) => {
			const usage = await ctx.db
				.query("plugins_data_usage")
				.withIndex("by_installation", (q) => q.eq("installationId", fixture.installationId))
				.first();
			await ctx.db.patch("plugins_data_usage", usage!._id, { usedDocuments: 10_000 });
		});

		// The payer moves from Pro back down to Free.
		await t.run(async (ctx) =>
			test_mocks_fill_db_with.plan(ctx, { userId: fixture.userId, plan: "Free" }),
		);

		// New documents refuse with the same name and shape as before, now naming the Free number.
		const refused = await t.mutation(internal.plugins_data.write_document, {
			principal,
			collection: "meetings",
			key: "c",
			value: { n: 3 },
		});
		expect(refused._nay?.name).toBe("storage_full");
		expect(refused._nay?.message).toBe("This plugin has used its 10000 document slots");

		// In-place updates cost no slot, so a store over its ceiling can still change what it holds.
		const replaced = await t.mutation(internal.plugins_data.write_document, {
			principal,
			collection: "meetings",
			key: "a",
			value: { n: 2 },
		});
		expect(replaced._nay).toBeUndefined();
	});

	test("a workspace with no billing state at all gets the Free ceiling", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t, { plan: null });
		const principal = store_principal(fixture);

		await t.mutation(internal.plugins_data.write_document, {
			principal,
			collection: "meetings",
			key: "a",
			value: { n: 1 },
		});
		await t.run(async (ctx) => {
			const usage = await ctx.db
				.query("plugins_data_usage")
				.withIndex("by_installation", (q) => q.eq("installationId", fixture.installationId))
				.first();
			await ctx.db.patch("plugins_data_usage", usage!._id, { usedDocuments: 10_000 });
		});

		const refused = await t.mutation(internal.plugins_data.write_document, {
			principal,
			collection: "meetings",
			key: "b",
			value: { n: 2 },
		});
		expect(refused._nay?.message).toBe("This plugin has used its 10000 document slots");
	});

	test("refuses the byte after the last one, and counts reserved bytes toward the same ceiling", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const principal = store_principal(fixture);

		await t.mutation(internal.plugins_data.write_document, {
			principal,
			collection: "meetings",
			key: "a",
			value: { n: 1 },
		});
		// Stored bytes and bytes promised to reservations share the ceiling, so spend it across both
		// and leave room for exactly one more 16 KiB value.
		await t.run(async (ctx) => {
			const usage = await ctx.db
				.query("plugins_data_usage")
				.withIndex("by_installation", (q) => q.eq("installationId", fixture.installationId))
				.first();
			await ctx.db.patch("plugins_data_usage", usage!._id, {
				usedBytes: 16 * 1024 * 1024 - 16 * 1024 - 8 * 1024,
				reservedBytes: 8 * 1024,
			});
		});

		const atLimit = await t.mutation(internal.plugins_data.write_document, {
			principal,
			collection: "meetings",
			key: "b",
			value: value_of_bytes(16 * 1024),
		});
		expect(atLimit._nay).toBeUndefined();
		expect((await read_usage(t, fixture))?.usedBytes).toBe(16 * 1024 * 1024 - 8 * 1024);

		const overLimit = await t.mutation(internal.plugins_data.write_document, {
			principal,
			collection: "meetings",
			key: "c",
			value: { n: 2 },
		});
		expect(overLimit._nay?.message).toBe("This plugin has used its 16 MiB of storage");
		expect(await read_documents(t, fixture)).toHaveLength(2);
	});

	test("refuses a value over the size limit and accepts one exactly at it", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const principal = store_principal(fixture);

		const atLimit = await t.mutation(internal.plugins_data.write_document, {
			principal,
			collection: "meetings",
			key: "a",
			value: value_of_bytes(16 * 1024),
		});
		if (atLimit._nay) {
			throw new Error(atLimit._nay.message);
		}
		expect(atLimit._yay.byteSize).toBe(16 * 1024);

		const overLimit = await t.mutation(internal.plugins_data.write_document, {
			principal,
			collection: "meetings",
			key: "b",
			value: value_of_bytes(16 * 1024 + 1),
		});
		expect(overLimit._nay?.message).toBe("Plugin document values must be at most 16 KiB");
		expect(await read_documents(t, fixture)).toHaveLength(1);
	});

	test("refuses empty, overlong, padded, and control-character names", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const principal = store_principal(fixture);

		for (const [collection, key, message] of [
			["", "a", "Collection names must not be empty"],
			["x".repeat(129), "a", "Collection names must be at most 128 characters"],
			[" meetings", "a", "Collection names must not start or end with whitespace"],
			["meet\u0000ings", "a", "Collection names must not contain control characters"],
			["meetings", "", "Keys must not be empty"],
			["meetings", "x".repeat(129), "Keys must be at most 128 characters"],
			["meetings", "a ", "Keys must not start or end with whitespace"],
			["meetings", "a\u200bb", "Keys must not contain control characters"],
		] as const) {
			const refused = await t.mutation(internal.plugins_data.write_document, {
				principal,
				collection,
				key,
				value: { n: 1 },
			});
			expect(refused._nay?.message).toBe(message);
		}
		expect(await read_documents(t, fixture)).toHaveLength(0);
		expect(await read_usage(t, fixture)).toBeNull();

		// 128 characters is the last length that fits, on both names. Without this the same test would
		// pass with a ceiling that refused every name of exactly the documented maximum.
		const atLimit = await t.mutation(internal.plugins_data.write_document, {
			principal,
			collection: "c".repeat(128),
			key: "k".repeat(128),
			value: { n: 1 },
		});
		expect(atLimit._nay).toBeUndefined();
		expect(await read_documents(t, fixture)).toHaveLength(1);
	});
});

describe("write_documents_batch", () => {
	test("writes nothing when one item is oversized", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);

		const refused = await t.mutation(internal.plugins_data.write_documents_batch, {
			principal: store_principal(fixture),
			documents: [
				{ collection: "meetings", key: "good", value: { n: 1 } },
				{ collection: "meetings", key: "oversized", value: value_of_bytes(16 * 1024 + 1) },
			],
		});
		expect(refused._nay?.message).toBe("Plugin document values must be at most 16 KiB");

		// Both tables are untouched: the valid first item must not survive its refused sibling.
		expect(await read_documents(t, fixture)).toHaveLength(0);
		expect(await read_usage(t, fixture)).toBeNull();
	});

	test("refuses an empty batch, an over-sized batch, and a repeated document", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const principal = store_principal(fixture);

		expect(
			(await t.mutation(internal.plugins_data.write_documents_batch, { principal, documents: [] }))._nay?.message,
		).toBe("A write batch holds 1 to 50 documents");
		const tooMany = await t.mutation(internal.plugins_data.write_documents_batch, {
			principal,
			documents: Array.from({ length: 51 }, (_, index) => ({
				collection: "meetings",
				key: `key-${index}`,
				value: { n: index },
			})),
		});
		expect(tooMany._nay?.message).toBe("A write batch holds 1 to 50 documents");

		const repeated = await t.mutation(internal.plugins_data.write_documents_batch, {
			principal,
			documents: [
				{ collection: "meetings", key: "a", value: { n: 1 } },
				{ collection: "meetings", key: "a", value: { n: 2 } },
			],
		});
		expect(repeated._nay?.message).toBe("A write batch names the same document twice");
		expect(await read_documents(t, fixture)).toHaveLength(0);
	});

	test("writes a full batch of fifty and counts every document once", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);

		const written = await t.mutation(internal.plugins_data.write_documents_batch, {
			principal: store_principal(fixture),
			documents: Array.from({ length: 50 }, (_, index) => ({
				collection: "meetings",
				key: `key-${index}`,
				value: { n: index },
			})),
		});
		if (written._nay) {
			throw new Error(written._nay.message);
		}
		expect(written._yay.documents).toHaveLength(50);
		expect(await read_documents(t, fixture)).toHaveLength(50);
		expect(await read_usage(t, fixture)).toMatchObject({ usedDocuments: 50, collectionNames: ["meetings"] });
	});
});

describe("list_documents", () => {
	test("answers crossed range bounds with a finished empty page, and refuses a malformed one", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		await t.mutation(internal.plugins_data.write_documents_batch, {
			principal: store_principal(fixture),
			documents: [
				{ collection: "meetings", key: "meeting:1", value: { n: 1 } },
				{ collection: "meetings", key: "note:1", value: { n: 2 } },
			],
		});

		// A fencepost copied from one prefix and reused against another sorts outside it, so the
		// bounds cross. That page is finished, not merely empty: an unfinished one makes the route
		// echo a cursor and the caller asks for the same nothing forever.
		const crossed = await t.query(internal.plugins_data.list_documents, {
			principal: store_principal(fixture),
			collection: "meetings",
			keyPrefix: "meeting:",
			keyStartExclusive: "note:1",
			paginationOpts: { numItems: 10, cursor: null },
		});
		if (crossed._nay) {
			throw new Error(crossed._nay.message);
		}
		expect(crossed._yay.page).toEqual([]);
		expect(crossed._yay.isDone).toBe(true);

		// A bad bound bubbles the store's own refusal, which the route maps to 400 — the same answer
		// the prefix rules already give.
		const refused = await t.query(internal.plugins_data.list_documents, {
			principal: store_principal(fixture),
			collection: "meetings",
			keyEndInclusive: " leading space",
			paginationOpts: { numItems: 10, cursor: null },
		});
		expect(refused._nay?.message).toBe("Keys must not start or end with whitespace");
	});

	test("never returns more than one page even when the caller asks for more", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		await t.run(async (ctx) => {
			const now = Date.now();
			for (let index = 0; index < 120; index += 1) {
				await ctx.db.insert("plugins_data", {
					organizationId: fixture.organizationId,
					workspaceId: fixture.workspaceId,
					installationId: fixture.installationId,
					pluginName: "council",
					collection: "meetings",
					key: `meeting-${String(index).padStart(3, "0")}`,
					value: { n: index },
					byteSize: 9,
					revision: 1,
					writeMode: "normal",
					ownership: "shared",
					createdBy: fixture.userId,
					updatedBy: fixture.userId,
					updatedAt: now,
				});
			}
		});

		// The route validator already caps the number a caller may ask for, but the query is also
		// reachable from inside the backend. Asking for everything must still answer one page.
		const listed = await t.query(internal.plugins_data.list_documents, {
			principal: store_principal(fixture),
			collection: "meetings",
			paginationOpts: { numItems: 1000, cursor: null },
		});
		if (listed._nay) {
			throw new Error(listed._nay.message);
		}
		expect(listed._yay.page).toHaveLength(100);
		expect(listed._yay.isDone).toBe(false);

		const rest = await t.query(internal.plugins_data.list_documents, {
			principal: store_principal(fixture),
			collection: "meetings",
			paginationOpts: { numItems: 1000, cursor: listed._yay.continueCursor },
		});
		if (rest._nay) {
			throw new Error(rest._nay.message);
		}
		expect(rest._yay.page).toHaveLength(20);
		expect(rest._yay.isDone).toBe(true);
	});

	test("keyPrefix narrows the pages and the cursor continues inside the range", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		await t.run(async (ctx) => {
			const now = Date.now();
			const insert = async (key: string, n: number) => {
				await ctx.db.insert("plugins_data", {
					organizationId: fixture.organizationId,
					workspaceId: fixture.workspaceId,
					installationId: fixture.installationId,
					pluginName: "council",
					collection: "messages",
					key,
					value: { n },
					byteSize: 9,
					revision: 1,
					writeMode: "normal",
					ownership: "shared",
					createdBy: fixture.userId,
					updatedBy: fixture.userId,
					updatedAt: now,
				});
			};
			for (let index = 0; index < 120; index += 1) {
				await insert(`msg:${String(index).padStart(3, "0")}`, index);
			}
			for (let index = 0; index < 30; index += 1) {
				await insert(`note:${String(index).padStart(3, "0")}`, index);
			}
		});

		const firstPage = await t.query(internal.plugins_data.list_documents, {
			principal: store_principal(fixture),
			collection: "messages",
			keyPrefix: "msg:",
			paginationOpts: { numItems: 100, cursor: null },
		});
		if (firstPage._nay) {
			throw new Error(firstPage._nay.message);
		}
		expect(firstPage._yay.page).toHaveLength(100);
		expect(firstPage._yay.isDone).toBe(false);
		expect(firstPage._yay.page.every((doc) => doc.key.startsWith("msg:"))).toBe(true);

		// The second page picks up inside the narrowed range: only the 20 remaining prefixed docs,
		// never the 30 `note:` docs that follow them in the index.
		const secondPage = await t.query(internal.plugins_data.list_documents, {
			principal: store_principal(fixture),
			collection: "messages",
			keyPrefix: "msg:",
			paginationOpts: { numItems: 100, cursor: firstPage._yay.continueCursor },
		});
		if (secondPage._nay) {
			throw new Error(secondPage._nay.message);
		}
		expect(secondPage._yay.page).toHaveLength(20);
		expect(secondPage._yay.isDone).toBe(true);
		expect(secondPage._yay.page.every((doc) => doc.key.startsWith("msg:"))).toBe(true);
	});

	test("the successor bound excludes sibling prefixes at the alphabet edges", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		await t.run(async (ctx) => {
			const now = Date.now();
			for (const key of ["room9", "room9a", "room:x", "room;y", "x~", "x~é", "x€"]) {
				await ctx.db.insert("plugins_data", {
					organizationId: fixture.organizationId,
					workspaceId: fixture.workspaceId,
					installationId: fixture.installationId,
					pluginName: "council",
					collection: "rooms",
					key,
					value: { n: 1 },
					byteSize: 7,
					revision: 1,
					writeMode: "normal",
					ownership: "shared",
					createdBy: fixture.userId,
					updatedBy: fixture.userId,
					updatedAt: now,
				});
			}
		});

		const list = async (keyPrefix: string) => {
			const listed = await t.query(internal.plugins_data.list_documents, {
				principal: store_principal(fixture),
				collection: "rooms",
				keyPrefix,
				paginationOpts: { numItems: 100, cursor: null },
			});
			if (listed._nay) {
				throw new Error(listed._nay.message);
			}
			return listed._yay.page.map((doc) => doc.key);
		};

		// ':' is exactly '9' + 1, so a "room:" key starts at the exclusive bound of prefix "room9" and
		// must stay out. A key equal to the prefix itself is a match.
		expect(await list("room9")).toEqual(["room9", "room9a"]);
		expect(await list("room:")).toEqual(["room:x"]);
		// '~' is the top of the allowed alphabet. Its bound is the unstorable 0x7F, which still sorts
		// below every non-ASCII continuation, so "x€" stays out while "x~é" stays in.
		expect(await list("x~")).toEqual(["x~", "x~é"]);
	});
});

describe("reserve_document", () => {
	test("holds capacity before the value exists and answers a replayed request", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const principal = service_principal(fixture);
		const expiresAt = Date.now() + 60_000;

		const reserved = await t.mutation(internal.plugins_data.reserve_document, {
			principal,
			collection: "meetings",
			key: "meeting-1",
			maximumBytes: 1000,
			idempotencyKey: "reserve-1",
			expiresAt,
		});
		// Compare against the stored reservation, not against the answer itself. Reading the id out of
		// the received object would make the assertion pass even when the field is missing.
		const [stored] = await read_reservations(t, fixture);
		const reservationId = stored._id;
		expect(reserved._yay).toEqual({ reservationId, remainingBytes: 1000, expiresAt });

		// The reservation holds bytes and a slot without storing a document.
		expect(await read_documents(t, fixture)).toHaveLength(0);
		expect(await read_usage(t, fixture)).toMatchObject({
			usedBytes: 0,
			usedDocuments: 0,
			reservedBytes: 1000,
			reservedDocuments: 1,
			tombstoneDocuments: 0,
			collectionNames: ["meetings"],
		});

		const replayed = await t.mutation(internal.plugins_data.reserve_document, {
			principal,
			collection: "meetings",
			key: "meeting-1",
			maximumBytes: 1000,
			idempotencyKey: "reserve-1",
			expiresAt,
		});
		// The replay answers with the same reservation, not a second one.
		expect(replayed._yay).toEqual({ reservationId, remainingBytes: 1000, expiresAt });
		expect(await read_reservations(t, fixture)).toHaveLength(1);
		expect(await read_usage(t, fixture)).toMatchObject({ reservedBytes: 1000, reservedDocuments: 1 });
	});

	test("answers a replay with what the reservation holds now, not with its first answer", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const principal = service_principal(fixture);
		const expiresAt = Date.now() + 60_000;

		const request = {
			principal,
			collection: "meetings",
			key: "meeting-1",
			maximumBytes: 1000,
			idempotencyKey: "reserve-1",
			expiresAt,
		};
		await t.mutation(internal.plugins_data.reserve_document, request);

		// The producer spent 600 of the 1000 it reserved, then lost the answer to its next request.
		await t.mutation(internal.plugins_data.write_versioned_document, {
			principal,
			collection: "meetings",
			key: "meeting-1",
			revision: 1,
			value: value_of_bytes(600),
		});

		// Telling it 1000 again would let it size its next write against bytes it already spent, and it
		// would learn that only when the write is refused.
		const replayed = await t.mutation(internal.plugins_data.reserve_document, request);
		expect(replayed._yay?.remainingBytes).toBe(400);
		expect(await read_reservations(t, fixture)).toHaveLength(1);
	});

	test("refuses a different request under the same idempotency key", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const principal = service_principal(fixture);
		const expiresAt = Date.now() + 60_000;

		await t.mutation(internal.plugins_data.reserve_document, {
			principal,
			collection: "meetings",
			key: "meeting-1",
			maximumBytes: 1000,
			idempotencyKey: "reserve-1",
			expiresAt,
		});
		const refused = await t.mutation(internal.plugins_data.reserve_document, {
			principal,
			collection: "meetings",
			key: "meeting-1",
			maximumBytes: 2000,
			idempotencyKey: "reserve-1",
			expiresAt,
		});
		expect(refused._nay?.message).toBe("This idempotency key was already used for a different reservation");
		expect(await read_reservations(t, fixture)).toHaveLength(1);
		expect(await read_usage(t, fixture)).toMatchObject({ reservedBytes: 1000, reservedDocuments: 1 });
	});

	test("refuses a replay of a reservation that was already released", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const principal = service_principal(fixture);
		const expiresAt = Date.now() + 60_000;

		await t.mutation(internal.plugins_data.reserve_document, {
			principal,
			collection: "meetings",
			key: "meeting-1",
			maximumBytes: 1000,
			idempotencyKey: "reserve-1",
			expiresAt,
		});
		const released = await t.mutation(internal.plugins_data.release_reservation, {
			principal,
			collection: "meetings",
			key: "meeting-1",
			idempotencyKey: "reserve-1",
		});
		if (released._nay) {
			throw new Error(released._nay.message);
		}

		// A released row holds nothing. Answering the replay from it the usual way would hand back zero
		// remaining bytes, and the producer would learn that only after doing the outside work the
		// reservation was meant to cover. So the replay is refused instead.
		const replayed = await t.mutation(internal.plugins_data.reserve_document, {
			principal,
			collection: "meetings",
			key: "meeting-1",
			maximumBytes: 1000,
			idempotencyKey: "reserve-1",
			expiresAt,
		});
		expect(replayed._nay?.message).toBe("This reservation was already released");
		expect(await read_usage(t, fixture)).toMatchObject({ reservedBytes: 0, reservedDocuments: 0 });
	});

	test("refuses a new reservation while the service delete tombstone still owns the key", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const principal = service_principal(fixture);

		await t.mutation(internal.plugins_data.write_versioned_document, {
			principal,
			collection: "meetings",
			key: "meeting-1",
			revision: 1,
			value: { title: "Weekly sync" },
		});
		await t.mutation(internal.plugins_data.delete_versioned_document, {
			principal,
			collection: "meetings",
			key: "meeting-1",
			revision: 2,
		});

		const reserved = await t.mutation(internal.plugins_data.reserve_document, {
			principal,
			collection: "meetings",
			key: "meeting-1",
			maximumBytes: 1000,
			idempotencyKey: "reserve-after-delete",
			expiresAt: Date.now() + 60_000,
		});
		expect(reserved._nay?.message).toBe("This document was deleted by its service");
		expect(await read_reservations(t, fixture)).toHaveLength(0);
		expect(await read_usage(t, fixture)).toMatchObject({
			reservedBytes: 0,
			reservedDocuments: 0,
			collectionNames: [],
		});
	});

	test("still sees the live reservation after a key collects many released retry records", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const principal = service_principal(fixture);

		// Each reserve/release cycle leaves a released retry record behind, and one key can collect a
		// lot of them. A lookup that read the key's docs and filtered afterwards would stop before the
		// live one, and then hand out a second live reservation for the same document.
		for (let cycle = 0; cycle < 20; cycle += 1) {
			const reserved = await t.mutation(internal.plugins_data.reserve_document, {
				principal,
				collection: "meetings",
				key: "meeting-1",
				maximumBytes: 100,
				idempotencyKey: `reserve-${cycle}`,
				expiresAt: Date.now() + 60_000,
			});
			if (reserved._nay) {
				throw new Error(`cycle ${cycle}: ${reserved._nay.message}`);
			}
			const released = await t.mutation(internal.plugins_data.release_reservation, {
				principal,
				collection: "meetings",
				key: "meeting-1",
				idempotencyKey: `reserve-${cycle}`,
			});
			if (released._nay) {
				throw new Error(`cycle ${cycle}: ${released._nay.message}`);
			}
		}

		const live = await t.mutation(internal.plugins_data.reserve_document, {
			principal,
			collection: "meetings",
			key: "meeting-1",
			maximumBytes: 100,
			idempotencyKey: "reserve-live",
			expiresAt: Date.now() + 60_000,
		});
		if (live._nay) {
			throw new Error(live._nay.message);
		}

		const second = await t.mutation(internal.plugins_data.reserve_document, {
			principal,
			collection: "meetings",
			key: "meeting-1",
			maximumBytes: 100,
			idempotencyKey: "reserve-second",
			expiresAt: Date.now() + 60_000,
		});
		expect(second._nay?.message).toBe("This document already has a live reservation");

		// Read the docs, not the refusal: a second live reservation would double-count the bytes and
		// the slot it holds.
		const reservations = await read_reservations(t, fixture);
		expect(reservations.filter((reservation) => reservation.state === "live")).toHaveLength(1);
		expect((await read_usage(t, fixture))?.reservedDocuments).toBe(1);
	});

	test("keeps the collection name while a reservation on another key still holds it", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const principal = service_principal(fixture);

		const written = await t.mutation(internal.plugins_data.write_versioned_document, {
			principal,
			collection: "meetings",
			key: "meeting-1",
			revision: 1,
			value: { n: 1 },
		});
		if (written._nay) {
			throw new Error(written._nay.message);
		}
		const reserved = await t.mutation(internal.plugins_data.reserve_document, {
			principal,
			collection: "meetings",
			key: "meeting-2",
			maximumBytes: 100,
			idempotencyKey: "reserve-1",
			expiresAt: Date.now() + 60_000,
		});
		if (reserved._nay) {
			throw new Error(reserved._nay.message);
		}

		// Deleting the only document leaves the collection with no document at all. The name must
		// survive, because the reservation on the other key is a promise that a later write into this
		// same collection will be accepted, and dropping the name could push it over the ceiling.
		const deleted = await t.mutation(internal.plugins_data.delete_versioned_document, {
			principal,
			collection: "meetings",
			key: "meeting-1",
			revision: 2,
		});
		if (deleted._nay) {
			throw new Error(deleted._nay.message);
		}

		expect(await read_documents(t, fixture)).toHaveLength(0);
		expect((await read_reservations(t, fixture)).filter((reservation) => reservation.state === "live")).toHaveLength(1);
		expect((await read_usage(t, fixture))?.collectionNames).toEqual(["meetings"]);
	});

	test("starts the retry horizon at the release, not at the reservation's own expiry", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const principal = service_principal(fixture);

		// A meeting reservation may run for days. Releasing it after a minute must give its document
		// slot back a day later, not a day after the deadline it never reached.
		const expiresAt = Date.now() + 8 * 24 * 60 * 60 * 1000 - 1000;
		const reserved = await t.mutation(internal.plugins_data.reserve_document, {
			principal,
			collection: "meetings",
			key: "meeting-1",
			maximumBytes: 100,
			idempotencyKey: "reserve-1",
			expiresAt,
		});
		if (reserved._nay) {
			throw new Error(reserved._nay.message);
		}

		const released = await t.mutation(internal.plugins_data.release_reservation, {
			principal,
			collection: "meetings",
			key: "meeting-1",
			idempotencyKey: "reserve-1",
		});
		if (released._nay) {
			throw new Error(released._nay.message);
		}

		const [stored] = await read_reservations(t, fixture);
		expect(stored.state).toBe("released");
		expect(stored.retryHorizonExpiresAt).toBeLessThan(expiresAt);
		expect(stored.retryHorizonExpiresAt).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);
	});

	test("refuses a second live reservation and a key another writer owns", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const principal = service_principal(fixture);
		const expiresAt = Date.now() + 60_000;

		await t.mutation(internal.plugins_data.reserve_document, {
			principal,
			collection: "meetings",
			key: "meeting-1",
			maximumBytes: 1000,
			idempotencyKey: "reserve-1",
			expiresAt,
		});
		const second = await t.mutation(internal.plugins_data.reserve_document, {
			principal,
			collection: "meetings",
			key: "meeting-1",
			maximumBytes: 1000,
			idempotencyKey: "reserve-2",
			expiresAt,
		});
		expect(second._nay?.message).toBe("This document already has a live reservation");

		// A key the plugin already writes interactively cannot be taken over by a producer.
		await t.mutation(internal.plugins_data.write_document, {
			principal: store_principal(fixture),
			collection: "meetings",
			key: "meeting-2",
			value: { n: 1 },
		});
		const overNormal = await t.mutation(internal.plugins_data.reserve_document, {
			principal,
			collection: "meetings",
			key: "meeting-2",
			maximumBytes: 1000,
			idempotencyKey: "reserve-3",
			expiresAt,
		});
		expect(overNormal._nay?.message).toBe("This document belongs to another writer");
		expect(await read_reservations(t, fixture)).toHaveLength(1);
	});

	test("refuses a non-service principal, a bad size, and a bad expiry", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const expiresAt = Date.now() + 60_000;

		const notAService = await t.mutation(internal.plugins_data.reserve_document, {
			principal: store_principal(fixture),
			collection: "meetings",
			key: "meeting-1",
			maximumBytes: 1000,
			idempotencyKey: "reserve-1",
			expiresAt,
		});
		expect(notAService._nay?.message).toBe("Permission denied");

		const principal = service_principal(fixture);
		for (const [maximumBytes, message] of [
			[0, "A reservation holds 1 to 16384 bytes"],
			[16 * 1024 + 1, "A reservation holds 1 to 16384 bytes"],
		] as const) {
			const refused = await t.mutation(internal.plugins_data.reserve_document, {
				principal,
				collection: "meetings",
				key: "meeting-1",
				maximumBytes,
				idempotencyKey: "reserve-1",
				expiresAt,
			});
			expect(refused._nay?.message).toBe(message);
		}

		for (const badExpiry of [Date.now() - 1, Date.now() + 9 * 24 * 60 * 60 * 1000]) {
			const refused = await t.mutation(internal.plugins_data.reserve_document, {
				principal,
				collection: "meetings",
				key: "meeting-1",
				maximumBytes: 1000,
				idempotencyKey: "reserve-1",
				expiresAt: badExpiry,
			});
			expect(refused._nay?.message).toBe("A reservation expires within 8 days");
		}

		// The idempotency key is the lookup key of the replay index, so a padded one would quietly
		// become a second reservation for the same document. It is named in its own refusals because a
		// producer that reads "Keys must not be empty" would go looking at the document key instead.
		for (const [idempotencyKey, message] of [
			["", "Idempotency keys must not be empty"],
			["r".repeat(129), "Idempotency keys must be at most 128 characters"],
			["reserve-1 ", "Idempotency keys must not start or end with whitespace"],
		] as const) {
			const refused = await t.mutation(internal.plugins_data.reserve_document, {
				principal,
				collection: "meetings",
				key: "meeting-1",
				maximumBytes: 1000,
				idempotencyKey,
				expiresAt,
			});
			expect(refused._nay?.message).toBe(message);
		}

		expect(await read_reservations(t, fixture)).toHaveLength(0);
		expect(await read_usage(t, fixture)).toBeNull();
	});

	test("accepts the eight-day horizon a meeting reservation needs", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const principal = store_principal(fixture, { kind: "plugin_service" });

		// Council holds a projection reservation until eight days after the meeting closes: the seven
		// days the provider keeps the recording URL, plus one. A shorter ceiling would refuse the one
		// reservation this store was built for.
		const reserved = await t.mutation(internal.plugins_data.reserve_document, {
			principal,
			collection: "meetings",
			key: "meeting-1",
			maximumBytes: 1000,
			idempotencyKey: "reserve-1",
			expiresAt: Date.now() + 8 * 24 * 60 * 60 * 1000 - 1000,
		});
		if (reserved._nay) {
			throw new Error(reserved._nay.message);
		}
		expect(await read_reservations(t, fixture)).toHaveLength(1);
	});
});

describe("release_reservation", () => {
	test("gives back everything an unused reservation held and answers a replayed release", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const principal = service_principal(fixture);

		await t.mutation(internal.plugins_data.reserve_document, {
			principal,
			collection: "meetings",
			key: "meeting-1",
			maximumBytes: 1000,
			idempotencyKey: "reserve-1",
			expiresAt: Date.now() + 60_000,
		});
		const released = await t.mutation(internal.plugins_data.release_reservation, {
			principal,
			collection: "meetings",
			key: "meeting-1",
			idempotencyKey: "reserve-1",
		});
		expect(released._yay).toEqual({ releasedBytes: 1000 });
		expect(await read_usage(t, fixture)).toMatchObject({
			reservedBytes: 0,
			reservedDocuments: 0,
			// The row stays behind as the answer to a replayed release, so its slot moves rather than returning.
			tombstoneDocuments: 1,
			collectionNames: [],
		});

		const replayed = await t.mutation(internal.plugins_data.release_reservation, {
			principal,
			collection: "meetings",
			key: "meeting-1",
			idempotencyKey: "reserve-1",
		});
		expect(replayed._yay).toEqual({ releasedBytes: 1000 });
		expect(await read_usage(t, fixture)).toMatchObject({ reservedBytes: 0, tombstoneDocuments: 1 });
	});

	test("keeps the bytes a stored value already spent and leaves that value alone", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const principal = service_principal(fixture);

		await t.mutation(internal.plugins_data.reserve_document, {
			principal,
			collection: "meetings",
			key: "meeting-1",
			maximumBytes: 1000,
			idempotencyKey: "reserve-1",
			expiresAt: Date.now() + 60_000,
		});
		await t.mutation(internal.plugins_data.write_versioned_document, {
			principal,
			collection: "meetings",
			key: "meeting-1",
			revision: 1,
			value: value_of_bytes(600),
		});

		const released = await t.mutation(internal.plugins_data.release_reservation, {
			principal,
			collection: "meetings",
			key: "meeting-1",
			idempotencyKey: "reserve-1",
		});
		expect(released._yay).toEqual({ releasedBytes: 400 });
		expect(await read_documents(t, fixture)).toHaveLength(1);
		expect(await read_usage(t, fixture)).toMatchObject({
			usedBytes: 600,
			usedDocuments: 1,
			reservedBytes: 0,
			reservedDocuments: 0,
			tombstoneDocuments: 0,
			// The stored value still lives in the collection, so its name stays.
			collectionNames: ["meetings"],
		});
	});

	test("refuses an idempotency key it never issued", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);

		const refused = await t.mutation(internal.plugins_data.release_reservation, {
			principal: service_principal(fixture),
			collection: "meetings",
			key: "meeting-1",
			idempotencyKey: "reserve-1",
		});
		expect(refused._nay?.message).toBe("Not found");
	});
});

describe("write_versioned_document", () => {
	test("binds the key to its producer and keeps every other writer out", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const principal = service_principal(fixture);

		const written = await t.mutation(internal.plugins_data.write_versioned_document, {
			principal,
			collection: "meetings",
			key: "meeting-1",
			revision: 1,
			value: { n: 3 },
		});
		expect(written._yay).toEqual({ revision: 1, byteSize: 7 });

		const documents = await read_documents(t, fixture);
		expect(documents).toHaveLength(1);
		expect(documents[0]).toMatchObject({
			revision: 1,
			writeMode: "versioned",
			producerPrincipalKey: principal.principalKey,
		});

		// Another producer, the interactive write route, and the interactive delete route are all refused.
		const otherProducer = await t.mutation(internal.plugins_data.write_versioned_document, {
			principal: service_principal(fixture, { principalKey: "plugin_service:other" }),
			collection: "meetings",
			key: "meeting-1",
			revision: 2,
			value: { n: 4 },
		});
		expect(otherProducer._nay?.message).toBe("This document belongs to another writer");

		const interactiveWrite = await t.mutation(internal.plugins_data.write_document, {
			principal: store_principal(fixture),
			collection: "meetings",
			key: "meeting-1",
			value: { n: 5 },
		});
		expect(interactiveWrite._nay?.message).toBe("This document is written by a service and cannot be changed here");

		const interactiveDelete = await t.mutation(internal.plugins_data.delete_document, {
			principal: store_principal(fixture),
			collection: "meetings",
			key: "meeting-1",
		});
		expect(interactiveDelete._nay?.message).toBe("This document is written by a service and cannot be changed here");

		const stored = await read_documents(t, fixture);
		expect(stored).toHaveLength(1);
		expect(stored[0]).toMatchObject({ revision: 1, value: { n: 3 } });
	});

	test("resolves the plan-driven slot ceiling on this door too", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t, { plan: "Pro" });
		const principal = service_principal(fixture);

		await t.mutation(internal.plugins_data.write_versioned_document, {
			principal,
			collection: "meetings",
			key: "a",
			revision: 1,
			value: { n: 1 },
		});
		await t.run(async (ctx) => {
			const usage = await ctx.db
				.query("plugins_data_usage")
				.withIndex("by_installation", (q) => q.eq("installationId", fixture.installationId))
				.first();
			await ctx.db.patch("plugins_data_usage", usage!._id, { usedDocuments: 99_999 });
		});

		// A door hardcoding the Free constant would refuse here at 10,000. The paid
		// ceiling admits the last slot, then refuses naming the paid number.
		const lastSlot = await t.mutation(internal.plugins_data.write_versioned_document, {
			principal,
			collection: "meetings",
			key: "b",
			revision: 1,
			value: { n: 2 },
		});
		expect(lastSlot._nay).toBeUndefined();

		const refused = await t.mutation(internal.plugins_data.write_versioned_document, {
			principal,
			collection: "meetings",
			key: "c",
			revision: 1,
			value: { n: 3 },
		});
		expect(refused._nay?.name).toBe("storage_full");
		expect(refused._nay?.message).toBe("This plugin has used its 100000 document slots");
	});

	test("refuses a key the plugin already writes interactively", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);

		await t.mutation(internal.plugins_data.write_document, {
			principal: store_principal(fixture),
			collection: "meetings",
			key: "meeting-1",
			value: { n: 1 },
		});
		const refused = await t.mutation(internal.plugins_data.write_versioned_document, {
			principal: service_principal(fixture),
			collection: "meetings",
			key: "meeting-1",
			revision: 1,
			value: { n: 2 },
		});
		expect(refused._nay?.message).toBe("This document belongs to another writer");

		const documents = await read_documents(t, fixture);
		expect(documents[0]).toMatchObject({ writeMode: "normal", value: { n: 1 } });
	});

	test("accepts only the next revision and replays an exact duplicate", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const principal = service_principal(fixture);

		// Nothing is stored yet, so only revision 1 can start the sequence.
		const skippedStart = await t.mutation(internal.plugins_data.write_versioned_document, {
			principal,
			collection: "meetings",
			key: "meeting-1",
			revision: 2,
			value: { n: 2 },
		});
		expect(skippedStart._nay?.message).toBe("This document does not have the revision before this one");
		expect(await read_documents(t, fixture)).toHaveLength(0);
		expect(await read_usage(t, fixture)).toBeNull();

		await t.mutation(internal.plugins_data.write_versioned_document, {
			principal,
			collection: "meetings",
			key: "meeting-1",
			revision: 1,
			value: { n: 1 },
		});

		const skipped = await t.mutation(internal.plugins_data.write_versioned_document, {
			principal,
			collection: "meetings",
			key: "meeting-1",
			revision: 3,
			value: { n: 3 },
		});
		expect(skipped._nay?.message).toBe("This document does not have the revision before this one");

		// The producer resent revision 1 because it never saw the answer. Same payload, same answer.
		const replay = await t.mutation(internal.plugins_data.write_versioned_document, {
			principal,
			collection: "meetings",
			key: "meeting-1",
			revision: 1,
			value: { n: 1 },
		});
		expect(replay._yay).toEqual({ revision: 1, byteSize: 7 });

		const forked = await t.mutation(internal.plugins_data.write_versioned_document, {
			principal,
			collection: "meetings",
			key: "meeting-1",
			revision: 1,
			value: { n: 9 },
		});
		expect(forked._nay?.message).toBe("This revision was already written with a different value");

		const next = await t.mutation(internal.plugins_data.write_versioned_document, {
			principal,
			collection: "meetings",
			key: "meeting-1",
			revision: 2,
			value: { n: 2 },
		});
		expect(next._yay).toEqual({ revision: 2, byteSize: 7 });

		const documents = await read_documents(t, fixture);
		expect(documents).toHaveLength(1);
		expect(documents[0]).toMatchObject({ revision: 2, value: { n: 2 } });
		expect(await read_usage(t, fixture)).toMatchObject({ usedBytes: 7, usedDocuments: 1 });
	});

	test("moves reserved bytes into used bytes, and gives them back when the value shrinks", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const principal = service_principal(fixture);

		await t.mutation(internal.plugins_data.reserve_document, {
			principal,
			collection: "meetings",
			key: "meeting-1",
			maximumBytes: 1000,
			idempotencyKey: "reserve-1",
			expiresAt: Date.now() + 60_000,
		});
		for (const [revision, byteSize, reservedBytes] of [
			[1, 600, 400],
			[2, 900, 100],
			[3, 700, 300],
		] as const) {
			const written = await t.mutation(internal.plugins_data.write_versioned_document, {
				principal,
				collection: "meetings",
				key: "meeting-1",
				revision,
				value: value_of_bytes(byteSize),
			});
			expect(written._yay).toEqual({ revision, byteSize });
			expect(await read_usage(t, fixture)).toMatchObject({ usedBytes: byteSize, reservedBytes });

			const reservations = await read_reservations(t, fixture);
			expect(reservations[0]).toMatchObject({ state: "live", remainingBytes: reservedBytes });
		}

		// The reservation paid for the growth AND for the document slot. The first write converts
		// reserved -> used instead of charging a second slot.
		expect(await read_usage(t, fixture)).toMatchObject({ usedDocuments: 1, reservedDocuments: 0 });
	});

	test("the first write of a reserved key still succeeds when every other slot is spent", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const principal = service_principal(fixture);

		await t.mutation(internal.plugins_data.reserve_document, {
			principal,
			collection: "meetings",
			key: "meeting-1",
			maximumBytes: 1000,
			idempotencyKey: "reserve-1",
			expiresAt: Date.now() + 60_000,
		});
		await t.run(async (ctx) => {
			const usage = await ctx.db
				.query("plugins_data_usage")
				.withIndex("by_installation", (q) => q.eq("installationId", fixture.installationId))
				.first();
			await ctx.db.patch("plugins_data_usage", usage!._id, { usedDocuments: 9999 });
		});

		const written = await t.mutation(internal.plugins_data.write_versioned_document, {
			principal,
			collection: "meetings",
			key: "meeting-1",
			revision: 1,
			value: value_of_bytes(100),
		});
		expect(written._nay).toBeUndefined();
		expect(await read_usage(t, fixture)).toMatchObject({ usedDocuments: 10_000, reservedDocuments: 0 });

		// Release after the conversion must not decrement reservedDocuments below zero, and must
		// not add a tombstone on top of the used slot. That overflow would refuse the next write.
		const released = await t.mutation(internal.plugins_data.release_reservation, {
			principal,
			collection: "meetings",
			key: "meeting-1",
			idempotencyKey: "reserve-1",
		});
		expect(released._nay).toBeUndefined();
		expect(await read_usage(t, fixture)).toMatchObject({
			usedDocuments: 10_000,
			reservedDocuments: 0,
			tombstoneDocuments: 0,
		});

		const revised = await t.mutation(internal.plugins_data.write_versioned_document, {
			principal,
			collection: "meetings",
			key: "meeting-1",
			revision: 2,
			value: value_of_bytes(100),
		});
		expect(revised._nay).toBeUndefined();
		expect(await read_usage(t, fixture)).toMatchObject({ usedDocuments: 10_000, reservedDocuments: 0, tombstoneDocuments: 0 });
	});
});

describe("delete_versioned_document", () => {
	test("keeps a normal write off a key its service tombstoned", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const principal = service_principal(fixture);

		await t.mutation(internal.plugins_data.write_versioned_document, {
			principal,
			collection: "meetings",
			key: "meeting-1",
			revision: 1,
			value: { n: 1 },
		});
		const deleted = await t.mutation(internal.plugins_data.delete_versioned_document, {
			principal,
			collection: "meetings",
			key: "meeting-1",
			revision: 2,
		});
		if (deleted._nay) {
			throw new Error(deleted._nay.message);
		}

		// The value doc is gone and the reservation is released, so only the tombstone still holds the
		// key. Without it the key would look free, a page write would take it as a normal document, and
		// the service that owns the key could never write it again.
		const seized = await t.mutation(internal.plugins_data.write_document, {
			principal: store_principal(fixture),
			collection: "meetings",
			key: "meeting-1",
			value: { n: 2 },
		});
		expect(seized._nay?.message).toBe("This document is written by a service and cannot be changed here");
		expect(await read_documents(t, fixture)).toHaveLength(0);

		// The delete is terminal for everyone while the tombstone lives, including the producer. What
		// the fence protects is the producer's claim on the key, not a right to keep writing it.
		const next = await t.mutation(internal.plugins_data.write_versioned_document, {
			principal,
			collection: "meetings",
			key: "meeting-1",
			revision: 3,
			value: { n: 3 },
		});
		expect(next._nay?.message).toBe("This document was deleted by its service");
		expect(await read_documents(t, fixture)).toHaveLength(0);
	});

	test("refuses a tombstone for a key that never existed once the slots are gone", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const principal = service_principal(fixture);

		await t.run(async (ctx) => {
			const usage = await ctx.db
				.query("plugins_data_usage")
				.withIndex("by_installation", (q) => q.eq("installationId", fixture.installationId))
				.first();
			if (usage) {
				await ctx.db.patch("plugins_data_usage", usage._id, { usedDocuments: 10_000 });
				return;
			}

			await ctx.db.insert("plugins_data_usage", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				installationId: fixture.installationId,
				pluginName: "council",
				usedBytes: 0,
				reservedBytes: 0,
				usedDocuments: 10_000,
				reservedDocuments: 0,
				tombstoneDocuments: 0,
				collectionNames: [],
				updatedAt: Date.now(),
			});
		});

		// Deleting a stored value is never refused, because its tombstone takes the slot the value gave
		// back. Deleting a key that was never stored gives nothing back, so its tombstone is a new slot
		// and has to fit. Otherwise a producer could fill the store with tombstones alone.
		const refused = await t.mutation(internal.plugins_data.delete_versioned_document, {
			principal,
			collection: "meetings",
			key: "never-stored",
			revision: 1,
		});
		expect(refused._nay?.message).toBe("This plugin has used its 10000 document slots");
		expect(await t.run(async (ctx) => (await ctx.db.query("plugins_data_revision_tombstones").collect()).length)).toBe(
			0,
		);
	});

	test("a reserved never-stored key can still be tombstoned when every other slot is spent", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const principal = service_principal(fixture);

		await t.mutation(internal.plugins_data.reserve_document, {
			principal,
			collection: "meetings",
			key: "never-stored",
			maximumBytes: 1000,
			idempotencyKey: "reserve-1",
			expiresAt: Date.now() + 60_000,
		});
		await t.run(async (ctx) => {
			const usage = await ctx.db
				.query("plugins_data_usage")
				.withIndex("by_installation", (q) => q.eq("installationId", fixture.installationId))
				.first();
			await ctx.db.patch("plugins_data_usage", usage!._id, { usedDocuments: 9999 });
		});

		const deleted = await t.mutation(internal.plugins_data.delete_versioned_document, {
			principal,
			collection: "meetings",
			key: "never-stored",
			revision: 1,
		});
		expect(deleted._nay).toBeUndefined();
		expect(await read_usage(t, fixture)).toMatchObject({
			usedDocuments: 9999,
			reservedDocuments: 0,
			tombstoneDocuments: 1,
		});
	});

	test("a last-slot never-stored reservation still tombstones after its producer released it", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const principal = service_principal(fixture);

		await t.mutation(internal.plugins_data.reserve_document, {
			principal,
			collection: "meetings",
			key: "never-stored",
			maximumBytes: 1000,
			idempotencyKey: "reserve-1",
			expiresAt: Date.now() + 60_000,
		});
		await t.run(async (ctx) => {
			const usage = await ctx.db
				.query("plugins_data_usage")
				.withIndex("by_installation", (q) => q.eq("installationId", fixture.installationId))
				.first();
			await ctx.db.patch("plugins_data_usage", usage!._id, { usedDocuments: 9999 });
		});
		await t.mutation(internal.plugins_data.release_reservation, {
			principal,
			collection: "meetings",
			key: "never-stored",
			idempotencyKey: "reserve-1",
		});
		expect(await read_usage(t, fixture)).toMatchObject({
			usedDocuments: 9999,
			reservedDocuments: 0,
			tombstoneDocuments: 1,
		});

		const deleted = await t.mutation(internal.plugins_data.delete_versioned_document, {
			principal,
			collection: "meetings",
			key: "never-stored",
			revision: 1,
		});
		expect(deleted._nay).toBeUndefined();
		expect(await read_usage(t, fixture)).toMatchObject({
			usedDocuments: 9999,
			reservedDocuments: 0,
			tombstoneDocuments: 1,
		});
	});

	test("a last-slot never-stored reservation still tombstones after the cron released it", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const principal = service_principal(fixture);

		await t.mutation(internal.plugins_data.reserve_document, {
			principal,
			collection: "meetings",
			key: "never-stored",
			maximumBytes: 1000,
			idempotencyKey: "reserve-1",
			expiresAt: Date.now() + 60_000,
		});
		await t.run(async (ctx) => {
			const usage = await ctx.db
				.query("plugins_data_usage")
				.withIndex("by_installation", (q) => q.eq("installationId", fixture.installationId))
				.first();
			await ctx.db.patch("plugins_data_usage", usage!._id, { usedDocuments: 9999 });
			const reservation = await ctx.db
				.query("plugins_data_reservations")
				.withIndex("by_installation_state_collection_key", (q) => q.eq("installationId", fixture.installationId))
				.first();
			await ctx.db.patch("plugins_data_reservations", reservation!._id, { expiresAt: Date.now() - 1 });
		});

		expect(
			await t.mutation(internal.plugins_data.cleanup_expired_plugin_data, { _test_disableReschedule: true }),
		).toEqual({ done: false, releasedCount: 1, deletedCount: 0 });
		expect(await read_usage(t, fixture)).toMatchObject({
			usedDocuments: 9999,
			reservedDocuments: 0,
			tombstoneDocuments: 1,
		});

		const deleted = await t.mutation(internal.plugins_data.delete_versioned_document, {
			principal,
			collection: "meetings",
			key: "never-stored",
			revision: 1,
		});
		expect(deleted._nay).toBeUndefined();
		expect(await read_usage(t, fixture)).toMatchObject({
			usedDocuments: 9999,
			reservedDocuments: 0,
			tombstoneDocuments: 1,
		});
	});

	test("removes the value, refuses late writes, and answers a replayed delete", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const principal = service_principal(fixture);

		await t.mutation(internal.plugins_data.write_versioned_document, {
			principal,
			collection: "meetings",
			key: "meeting-1",
			revision: 1,
			value: { n: 1 },
		});
		// A terminal delete may skip ahead, because it supersedes entries the producer has not sent yet.
		const deleted = await t.mutation(internal.plugins_data.delete_versioned_document, {
			principal,
			collection: "meetings",
			key: "meeting-1",
			revision: 5,
		});
		expect(deleted._yay).toEqual({ deleted: true, revision: 5 });
		expect(await read_documents(t, fixture)).toHaveLength(0);
		expect(await read_usage(t, fixture)).toMatchObject({
			usedBytes: 0,
			usedDocuments: 0,
			tombstoneDocuments: 1,
			collectionNames: [],
		});

		const replayed = await t.mutation(internal.plugins_data.delete_versioned_document, {
			principal,
			collection: "meetings",
			key: "meeting-1",
			revision: 5,
		});
		expect(replayed._yay).toEqual({ deleted: false, revision: 5 });

		// Every entry that arrives after the delete is refused, whether it is older or newer.
		for (const revision of [2, 6]) {
			const late = await t.mutation(internal.plugins_data.write_versioned_document, {
				principal,
				collection: "meetings",
				key: "meeting-1",
				revision,
				value: { n: revision },
			});
			expect(late._nay?.message).toBe("This document was deleted by its service");
		}
		const lateDelete = await t.mutation(internal.plugins_data.delete_versioned_document, {
			principal,
			collection: "meetings",
			key: "meeting-1",
			revision: 3,
		});
		expect(lateDelete._nay?.message).toBe("This document was deleted by its service");
		expect(await read_documents(t, fixture)).toHaveLength(0);
	});

	test("releases the producer's reservation in the same transaction", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const principal = service_principal(fixture);

		await t.mutation(internal.plugins_data.reserve_document, {
			principal,
			collection: "meetings",
			key: "meeting-1",
			maximumBytes: 1000,
			idempotencyKey: "reserve-1",
			expiresAt: Date.now() + 60_000,
		});
		await t.mutation(internal.plugins_data.write_versioned_document, {
			principal,
			collection: "meetings",
			key: "meeting-1",
			revision: 1,
			value: value_of_bytes(600),
		});
		await t.mutation(internal.plugins_data.delete_versioned_document, {
			principal,
			collection: "meetings",
			key: "meeting-1",
			revision: 2,
		});

		expect(await read_usage(t, fixture)).toMatchObject({
			usedBytes: 0,
			usedDocuments: 0,
			reservedBytes: 0,
			reservedDocuments: 0,
			// The revision tombstone holds the slot. The reservation already converted to used,
			// so releasing it does not add a second tombstone.
			tombstoneDocuments: 1,
			collectionNames: [],
		});
		const reservations = await read_reservations(t, fixture);
		expect(reservations[0]).toMatchObject({ state: "released", remainingBytes: 0 });
	});

	test("keeps the document slot when a converted reservation was released before delete", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const principal = service_principal(fixture);

		await t.mutation(internal.plugins_data.reserve_document, {
			principal,
			collection: "meetings",
			key: "meeting-1",
			maximumBytes: 1000,
			idempotencyKey: "reserve-1",
			expiresAt: Date.now() + 60_000,
		});
		await t.mutation(internal.plugins_data.write_versioned_document, {
			principal,
			collection: "meetings",
			key: "meeting-1",
			revision: 1,
			value: value_of_bytes(600),
		});
		await t.mutation(internal.plugins_data.release_reservation, {
			principal,
			collection: "meetings",
			key: "meeting-1",
			idempotencyKey: "reserve-1",
		});

		await t.mutation(internal.plugins_data.delete_versioned_document, {
			principal,
			collection: "meetings",
			key: "meeting-1",
			revision: 2,
		});

		expect(await read_usage(t, fixture)).toMatchObject({
			usedDocuments: 0,
			reservedDocuments: 0,
			tombstoneDocuments: 1,
		});
	});

	test("refuses another producer and a non-service principal", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const principal = service_principal(fixture);

		await t.mutation(internal.plugins_data.write_versioned_document, {
			principal,
			collection: "meetings",
			key: "meeting-1",
			revision: 1,
			value: { n: 1 },
		});

		const otherProducer = await t.mutation(internal.plugins_data.delete_versioned_document, {
			principal: service_principal(fixture, { principalKey: "plugin_service:other" }),
			collection: "meetings",
			key: "meeting-1",
			revision: 2,
		});
		expect(otherProducer._nay?.message).toBe("This document belongs to another writer");

		const notAService = await t.mutation(internal.plugins_data.delete_versioned_document, {
			principal: store_principal(fixture),
			collection: "meetings",
			key: "meeting-1",
			revision: 2,
		});
		expect(notAService._nay?.message).toBe("Permission denied");
		expect(await read_documents(t, fixture)).toHaveLength(1);
	});
});

describe("db_authorize", () => {
	test("refuses the capability the installation did not accept", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t, {
			acceptedCapabilities: ["plugin.data.read", "plugin.service.connect"],
		});
		const principal = store_principal(fixture);

		const written = await t.mutation(internal.plugins_data.write_document, {
			principal,
			collection: "meetings",
			key: "a",
			value: { n: 1 },
		});
		expect(written._nay?.message).toBe("Permission denied");

		// Read consent was given, so reading the empty store still answers.
		const read = await t.query(internal.plugins_data.read_document, { principal, collection: "meetings", key: "a" });
		expect(read._yay).toBeNull();

		await t.run(async (ctx) => {
			await ctx.db.patch("plugins_workspace_installations", fixture.installationId, { acceptedCapabilities: [] });
		});
		const readAfter = await t.query(internal.plugins_data.read_document, {
			principal,
			collection: "meetings",
			key: "a",
		});
		expect(readAfter._nay?.message).toBe("Permission denied");
	});

	test("refuses a page principal that reaches a write mutation directly", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const principal = store_principal(fixture, { kind: "plugin_ui" });

		// The routes already leave `plugin_ui` out of every write allowlist, and a page token never
		// carries the write scope. This is the second barrier, for a caller inside the backend that
		// reaches the mutation without going through a route at all.
		const written = await t.mutation(internal.plugins_data.write_document, {
			principal,
			collection: "meetings",
			key: "a",
			value: { n: 1 },
		});
		expect(written._nay?.message).toBe("Permission denied");

		const batched = await t.mutation(internal.plugins_data.write_documents_batch, {
			principal,
			documents: [{ collection: "meetings", key: "a", value: { n: 1 } }],
		});
		expect(batched._nay?.message).toBe("Permission denied");

		const removed = await t.mutation(internal.plugins_data.delete_document, {
			principal,
			collection: "meetings",
			key: "a",
		});
		expect(removed._nay?.message).toBe("Permission denied");

		// Reading is what a page is for, so it still answers.
		const read = await t.query(internal.plugins_data.read_document, { principal, collection: "meetings", key: "a" });
		expect(read._yay).toBeNull();
		expect(await read_documents(t, fixture)).toHaveLength(0);
		expect(await read_usage(t, fixture)).toBeNull();
	});

	test("refuses a write whose actor may read the workspace but not write it", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const viewer = await join_member_with_role(t, fixture, {
			clerkUserId: "plugin-data-viewer",
			role: "viewer",
		});
		const principal = store_principal(fixture, { actorUserId: viewer.userId });

		await t.mutation(internal.plugins_data.write_document, {
			principal: store_principal(fixture),
			collection: "meetings",
			key: "a",
			value: { n: 1 },
		});

		// A plugin run is the one kind the route layer does not permission-check, because it runs on a
		// workspace event rather than on a request somebody made. So this check inside the store is the
		// only thing standing between a viewer's plugin run and a write. Same installation, same accepted
		// capabilities, same collection: only the person behind the call differs.
		const read = await t.query(internal.plugins_data.read_document, { principal, collection: "meetings", key: "a" });
		expect(read._yay).toMatchObject({ key: "a" });

		const written = await t.mutation(internal.plugins_data.write_document, {
			principal,
			collection: "meetings",
			key: "b",
			value: { n: 2 },
		});
		expect(written._nay?.message).toBe("Permission denied");
		const removed = await t.mutation(internal.plugins_data.delete_document, {
			principal,
			collection: "meetings",
			key: "a",
		});
		expect(removed._nay?.message).toBe("Permission denied");

		// Read the table, not the refusals: the owner's one document must still be there, untouched.
		expect(await read_documents(t, fixture)).toHaveLength(1);
	});

	test("refuses an installation id that is not an id at all", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);

		// A user API key names its installation in the request body, so this value comes from outside
		// the application. It must be refused, not throw at the argument validator.
		const refused = await t.query(internal.plugins_data.read_document, {
			principal: store_principal(fixture, { installationId: "not-an-id" }),
			collection: "meetings",
			key: "a",
		});
		expect(refused._nay?.message).toBe("Not found");
	});

	test("refuses an installation outside the principal's tenant and a disabled one", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const otherFixture = await seed_installation(t, { organizationName: "other-organization" });

		const crossTenant = await t.query(internal.plugins_data.read_document, {
			principal: store_principal(fixture, { installationId: otherFixture.installationId }),
			collection: "meetings",
			key: "a",
		});
		expect(crossTenant._nay?.message).toBe("Not found");

		await t.run(async (ctx) => {
			await ctx.db.patch("plugins_workspace_installations", fixture.installationId, { status: "disabled" });
		});
		const disabled = await t.query(internal.plugins_data.read_document, {
			principal: store_principal(fixture),
			collection: "meetings",
			key: "a",
		});
		expect(disabled._nay?.message).toBe("Not found");
	});

	test("refuses an installation in another workspace of the same organization", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);

		// A user API key belongs to one workspace and names the installation it wants to reach. The
		// organization matches here, so only the workspace check stands between this key and the
		// documents of a plugin installed next door.
		const siblingInstallationId = await t.run(async (ctx) => {
			const now = Date.now();
			const siblingWorkspace = await organizations_db_create_workspace(ctx, {
				userId: fixture.userId,
				organizationId: fixture.organizationId,
				name: "sibling-workspace",
				description: "",
				now,
			});
			if (siblingWorkspace._nay) {
				throw new Error(siblingWorkspace._nay.message);
			}

			return await ctx.db.insert("plugins_workspace_installations", {
				organizationId: fixture.organizationId,
				workspaceId: siblingWorkspace._yay.workspaceId,
				pluginVersionId: fixture.pluginVersionId,
				pluginName: "council",
				status: "enabled",
				configurationYaml: null,
				acceptedCapabilities: ["plugin.data.read", "plugin.data.write", "plugin.service.connect"],
				capabilitiesAcceptedAt: now,
				acceptedOutboundOrigins: [],
				acceptedUiOutboundOrigins: [],
				outboundOriginsAcceptedAt: now,
				installedBy: fixture.userId,
				updatedBy: fixture.userId,
				updatedAt: now,
			});
		});

		const crossWorkspace = await t.mutation(internal.plugins_data.write_document, {
			principal: store_principal(fixture, { installationId: siblingInstallationId }),
			collection: "meetings",
			key: "a",
			value: { n: 1 },
		});
		expect(crossWorkspace._nay?.message).toBe("Not found");
		// Read the whole table, not the fixture's own installation: a document written past this check
		// would be filed under the sibling installation, where a fixture-scoped read cannot see it.
		expect(await t.run(async (ctx) => await ctx.db.query("plugins_data").collect())).toHaveLength(0);
	});

	test("refuses every principal whose actor lost the workspace, including a service grant", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);

		await t.mutation(internal.plugins_data.write_document, {
			principal: store_principal(fixture),
			collection: "meetings",
			key: "a",
			value: { n: 1 },
		});

		await t.run(async (ctx) => {
			const membership = await ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_active_user_organization_workspace", (q) =>
					q
						.eq("active", true)
						.eq("userId", fixture.userId)
						.eq("organizationId", fixture.organizationId)
						.eq("workspaceId", fixture.workspaceId),
				)
				.first();
			await ctx.db.patch("organizations_workspaces_users", membership!._id, { active: false });
		});

		const refusedRead = await t.query(internal.plugins_data.read_document, {
			principal: store_principal(fixture),
			collection: "meetings",
			key: "a",
		});
		expect(refusedRead._nay?.message).toBe("Unauthenticated");
		const refusedWrite = await t.mutation(internal.plugins_data.write_document, {
			principal: store_principal(fixture),
			collection: "meetings",
			key: "b",
			value: { n: 2 },
		});
		expect(refusedWrite._nay?.message).toBe("Unauthenticated");
		const refusedDelete = await t.mutation(internal.plugins_data.delete_document, {
			principal: store_principal(fixture),
			collection: "meetings",
			key: "a",
		});
		expect(refusedDelete._nay?.message).toBe("Unauthenticated");

		// A service grant is judged with its actor's live membership like every other principal. This
		// door takes no phase at all, so a sealed `processing` grant reaches this same check: the seal
		// bounds where a grant writes, not whether its member may still write.
		const service = await t.query(internal.plugins_data.read_document, {
			principal: store_principal(fixture, { kind: "plugin_service" }),
			collection: "meetings",
			key: "a",
		});
		expect(service._nay?.message).toBe("Unauthenticated");
	});
});

/**
 * An installation whose version declares and whose workspace accepted the user-write door, owned
 * by a signed-in member. The door takes app auth, so calls go through `asUser`.
 */
let page_session_seed_counter = 0;

/**
 * Insert a page session for a member and return an identity authenticated as that page. The doors
 * only read the session doc the JWT's subject points at, so tests seed the doc directly instead
 * of driving the whole mint and JWT exchange, which plugins_ui.test.ts covers.
 */
async function seed_page_session(
	t: ReturnType<typeof test_convex>,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		installationId: Id<"plugins_workspace_installations">;
		pluginVersionId: Id<"plugins_versions">;
		userId: Id<"users">;
	},
) {
	page_session_seed_counter += 1;
	const tokenHash = `page-session-${page_session_seed_counter}`;
	const sessionId = await t.run(async (ctx) => {
		const now = Date.now();
		return await ctx.db.insert("plugins_ui_sessions", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			installationId: args.installationId,
			pluginVersionId: args.pluginVersionId,
			userId: args.userId,
			tokenHash,
			createdAt: now,
			expiresAt: now + 30 * 60 * 1000,
		});
	});
	const asPage = t.withIdentity({
		issuer: `${process.env.VITE_CONVEX_HTTP_URL!}/plugins-ui`,
		subject: sessionId,
	});
	return { sessionId, asPage } as const;
}

async function seed_user_write_door(
	t: ReturnType<typeof test_convex>,
	args: { organizationName?: string; clerkUserId?: string } = {},
) {
	const clerkUserId = args.clerkUserId ?? "door-owner";
	const userId = await t.run(async (ctx) => await ctx.db.insert("users", { clerkUserId }));
	const fixture = await seed_installation(t, {
		userId,
		organizationName: args.organizationName,
		acceptedCapabilities: ["plugin.data.read", "plugin.data.write", "plugin.data.user-write", "plugin.service.connect"],
	});
	// The seed inserts a version without the door capability, and the door checks the declaration
	// on every call, so stamp it on the version too.
	await t.run(async (ctx) => {
		await ctx.db.patch("plugins_versions", fixture.pluginVersionId, {
			capabilities: [
				"plugin.data.read",
				"plugin.data.write",
				"plugin.data.user-write",
				"plugin.service.connect",
			] satisfies plugins_Capability[],
		});
	});
	const asUser = t.withIdentity({ issuer: "https://clerk.test", subject: clerkUserId, external_id: userId });
	const pageSession = await seed_page_session(t, fixture);
	return { ...fixture, asUser, ...pageSession } as const;
}

describe("user_append_document", () => {
	test("stores an owned document under a newest-first server key", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t);

		const limiterNow = Date.now();
		const dateNow = vi.spyOn(Date, "now").mockReturnValue(limiterNow);
		try {
			const appended = await fixture.asPage.mutation(api.plugins_data.user_append_document, {
				collection: "messages",
				keyPrefix: "general:",
				value: { text: "hello" },
				clientRequestId: "append-1",
			});
			if (appended._nay) {
				throw new Error(appended._nay.message);
			}

			// 13-digit inverted millisecond stamp, one `:`, four random hex characters.
			const invertedMs = String(9_999_999_999_999 - limiterNow).padStart(13, "0");
			expect(appended._yay.key).toMatch(new RegExp(`^general:${invertedMs}:[0-9a-f]{4}$`));

			const documents = await read_documents(t, fixture);
			expect(documents).toHaveLength(1);
			expect(documents[0]).toMatchObject({
				collection: "messages",
				key: appended._yay.key,
				value: { text: "hello" },
				revision: 1,
				writeMode: "normal",
				ownership: "owned",
				userWriteRequestId: "append-1",
				createdBy: fixture.userId,
				updatedBy: fixture.userId,
			});
			expect(documents[0]!.userWriteRequestFingerprint).toMatch(/^[0-9a-f]{64}$/);
			expect(await read_usage(t, fixture)).toMatchObject({
				usedDocuments: 1,
				usedBytes: appended._yay.byteSize,
				collectionNames: ["messages"],
			});
		} finally {
			dateNow.mockRestore();
		}
	});

	test("a later append sorts lexicographically before an earlier one", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t);
		const baseNow = Date.now();

		const dateNow = vi.spyOn(Date, "now").mockReturnValue(baseNow);
		try {
			const first = await fixture.asPage.mutation(api.plugins_data.user_append_document, {
				collection: "messages",
				value: { n: 1 },
				clientRequestId: "order-1",
			});
			dateNow.mockReturnValue(baseNow + 5_000);
			const second = await fixture.asPage.mutation(api.plugins_data.user_append_document, {
				collection: "messages",
				value: { n: 2 },
				clientRequestId: "order-2",
			});
			if (first._nay || second._nay) {
				throw new Error(first._nay?.message ?? second._nay?.message);
			}

			// Ascending key order must read newest first, so the later key sorts before the earlier.
			expect(second._yay.key < first._yay.key).toBe(true);
			const documents = await read_documents(t, fixture);
			expect(documents.map((doc) => doc.key)).toEqual([second._yay.key, first._yay.key]);
		} finally {
			dateNow.mockRestore();
		}
	});

	test("answers a replayed append with the stored key and refuses a changed one", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t);
		const send = async (value: Record<string, unknown>, keyPrefix?: string) =>
			await fixture.asPage.mutation(api.plugins_data.user_append_document, {
				collection: "messages",
				...(keyPrefix === undefined ? {} : { keyPrefix }),
				value,
				clientRequestId: "retry-1",
			});

		const first = await send({ text: "hello" });
		if (first._nay) {
			throw new Error(first._nay.message);
		}
		const replay = await send({ text: "hello" });
		if (replay._nay) {
			throw new Error(replay._nay.message);
		}
		expect(replay._yay).toEqual(first._yay);
		expect(await read_documents(t, fixture)).toHaveLength(1);

		// Same idempotency key, different request: refused instead of appending a second document.
		const changedValue = await send({ text: "different" });
		expect(changedValue._nay?.message).toBe("This idempotency key was already used for a different write");
		const changedPrefix = await send({ text: "hello" }, "general:");
		expect(changedPrefix._nay?.message).toBe("This idempotency key was already used for a different write");
		expect(await read_documents(t, fixture)).toHaveLength(1);
	});

	test("keeps the generated key inside the budget at the longest allowed prefix", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t);

		const atLimit = await fixture.asPage.mutation(api.plugins_data.user_append_document, {
			collection: "messages",
			keyPrefix: "p".repeat(109),
			value: { n: 1 },
			clientRequestId: "long-1",
		});
		if (atLimit._nay) {
			throw new Error(atLimit._nay.message);
		}
		expect(atLimit._yay.key).toMatch(/^p{109}\d{13}:[0-9a-f]{4}$/);
		expect(atLimit._yay.key.length).toBeLessThanOrEqual(128);

		const overLimit = await fixture.asPage.mutation(api.plugins_data.user_append_document, {
			collection: "messages",
			keyPrefix: "p".repeat(110),
			value: { n: 1 },
			clientRequestId: "long-2",
		});
		expect(overLimit._nay?.message).toBe("Key prefixes must be at most 109 characters");
		expect(await read_documents(t, fixture)).toHaveLength(1);
	});

	test("pins the key prefix alphabet to printable ASCII without space", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t);
		const send = async (keyPrefix: string, clientRequestId: string) =>
			await fixture.asPage.mutation(api.plugins_data.user_append_document, {
				collection: "messages",
				keyPrefix,
				value: { n: 1 },
				clientRequestId,
			});

		// '9', ':', and '~' are the digit, segment, and top edges of the allowed 0x21-0x7E range.
		for (const [index, keyPrefix] of ["9", ":", "~"].entries()) {
			expect((await send(keyPrefix, `edge-ok-${index}`))._nay).toBeUndefined();
		}
		for (const [index, keyPrefix] of [" ", "no space", "caffé", "🦧"].entries()) {
			expect((await send(keyPrefix, `edge-bad-${index}`))._nay?.message).toBe(
				"Key prefixes must contain only printable ASCII characters",
			);
		}
		expect((await send("", "edge-empty"))._nay?.message).toBe("Key prefixes must not be empty");
		expect(await read_documents(t, fixture)).toHaveLength(3);
	});

	test("lets an invited anonymous member append", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t);
		const anonymous = await t.run(async (ctx) => {
			const now = Date.now();
			const userId = await ctx.db.insert("users", { clerkUserId: null });
			const membershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				userId,
				active: true,
				updatedAt: now,
			});
			await access_control_db_ensure_role_assignment(ctx, {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				userId,
				role: "member",
				now,
			});
			return { userId, membershipId } as const;
		});

		// An invited anonymous member mints page sessions like any other member, so a session
		// seeded for it opens the same door.
		const anonymousPage = await seed_page_session(t, { ...fixture, userId: anonymous.userId });
		const appended = await anonymousPage.asPage.mutation(api.plugins_data.user_append_document, {
			collection: "messages",
			value: { text: "from an anonymous member" },
			clientRequestId: "anon-1",
		});
		if (appended._nay) {
			throw new Error(appended._nay.message);
		}

		const documents = await read_documents(t, fixture);
		expect(documents).toHaveLength(1);
		expect(documents[0]).toMatchObject({ createdBy: anonymous.userId, ownership: "owned" });
	});

	test("refuses the eleventh append in one frozen-clock burst", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t);

		const limiterNow = Date.now();
		const dateNow = vi.spyOn(Date, "now").mockReturnValue(limiterNow);
		try {
			// The bucket holds 10 tokens and refills one every two seconds, so a frozen clock lets
			// exactly ten writes through.
			for (let index = 0; index < 10; index += 1) {
				const appended = await fixture.asPage.mutation(api.plugins_data.user_append_document, {
					collection: "messages",
					value: { n: index },
					clientRequestId: `burst-${index}`,
				});
				expect(appended._nay).toBeUndefined();
			}
			const refused = await fixture.asPage.mutation(api.plugins_data.user_append_document, {
				collection: "messages",
				value: { n: 10 },
				clientRequestId: "burst-10",
			});
			expect(refused._nay?.message).toBe("Rate limit exceeded");
		} finally {
			dateNow.mockRestore();
		}
		expect(await read_documents(t, fixture)).toHaveLength(10);
	});

	test("a replayed append answers the stored key even when the bucket is empty", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t);

		const limiterNow = Date.now();
		const dateNow = vi.spyOn(Date, "now").mockReturnValue(limiterNow);
		try {
			for (let index = 0; index < 10; index += 1) {
				const appended = await fixture.asPage.mutation(api.plugins_data.user_append_document, {
					collection: "messages",
					value: { n: index },
					clientRequestId: `burst-${index}`,
				});
				expect(appended._nay).toBeUndefined();
			}

			// A retry after a lost response replays the same request. The first call already
			// committed and charged the bucket, so the replay must answer the stored key instead
			// of a rate refusal, or a delivered message would report as failed.
			const replayed = await fixture.asPage.mutation(api.plugins_data.user_append_document, {
				collection: "messages",
				value: { n: 0 },
				clientRequestId: "burst-0",
			});
			expect(replayed._nay).toBeUndefined();
			const documents = await read_documents(t, fixture);
			expect(replayed._yay?.key).toBe(documents.find((doc) => doc.userWriteRequestId === "burst-0")?.key);

			// A fresh append still refuses: the replay above answered without refilling anything.
			const refused = await fixture.asPage.mutation(api.plugins_data.user_append_document, {
				collection: "messages",
				value: { n: 11 },
				clientRequestId: "burst-11",
			});
			expect(refused._nay?.message).toBe("Rate limit exceeded");
		} finally {
			dateNow.mockRestore();
		}
		expect(await read_documents(t, fixture)).toHaveLength(10);
	});

	test("the put door spends the same bucket the append door does", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t);

		const limiterNow = Date.now();
		const dateNow = vi.spyOn(Date, "now").mockReturnValue(limiterNow);
		try {
			// Puts charge inside db_authorize_page_write instead of the append's post-replay charge,
			// so a regression that drops that charge would leave puts and removes unmetered.
			for (let index = 0; index < 10; index += 1) {
				const put = await fixture.asPage.mutation(api.plugins_data.user_put_document, {
					collection: "messages",
					key: `put-burst-${index}`,
					value: { n: index },
				});
				expect(put._nay).toBeUndefined();
			}
			const refused = await fixture.asPage.mutation(api.plugins_data.user_put_document, {
				collection: "messages",
				key: "put-burst-10",
				value: { n: 10 },
			});
			expect(refused._nay?.message).toBe("Rate limit exceeded");
		} finally {
			dateNow.mockRestore();
		}
		expect(await read_documents(t, fixture)).toHaveLength(10);
	});

	test("rejects an expectedRevision argument: an append has no revision to expect", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t);

		// The field is absent from the validator on purpose, so a caller cannot even ask.
		await expect(
			fixture.asPage.mutation(api.plugins_data.user_append_document, {
				collection: "messages",
				value: { n: 1 },
				clientRequestId: "cas-append",
				...({ expectedRevision: 0 } as object),
			}),
		).rejects.toThrow(/expectedRevision/);
	});

	test("refuses the next append once the installation sits at its document-slot ceiling", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t);

		// The first append creates the accounting doc the seed below fills.
		const first = await fixture.asPage.mutation(api.plugins_data.user_append_document, {
			collection: "messages",
			value: { text: "hello" },
			clientRequestId: "slot-wall-1",
		});
		if (first._nay) {
			throw new Error(first._nay.message);
		}

		// AT the ceiling, not one below: the check refuses when the write would take the store past
		// 10,000, so a store holding 9,999 still accepts one more. The number is written out here on
		// purpose. `MAX_DOCUMENT_SLOTS` is module-private, and exporting a ceiling so a test can read
		// it would let the test follow the constant instead of pinning the value the plugin ships with.
		await t.run(async (ctx) => {
			const usage = await ctx.db
				.query("plugins_data_usage")
				.withIndex("by_installation", (q) => q.eq("installationId", fixture.installationId))
				.first();
			await ctx.db.patch("plugins_data_usage", usage!._id, { usedDocuments: 10_000 });
		});

		const refused = await fixture.asPage.mutation(api.plugins_data.user_append_document, {
			collection: "messages",
			value: { text: "hello" },
			clientRequestId: "slot-wall-2",
		});
		// The plugin branches on this name to show a store-full state instead of a per-message error,
		// so the name is part of the contract and not only the message.
		expect(refused._nay?.name).toBe("storage_full");
		expect(refused._nay?.message).toBe("This plugin has used its 10000 document slots");
	});
});

describe("user_put_document", () => {
	test("creates shared docs any member can change, and guards owned docs by creator", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t);
		const member = await join_member_with_role(t, fixture, { clerkUserId: "door-second-member", role: "member" });

		const appended = await fixture.asPage.mutation(api.plugins_data.user_append_document, {
			collection: "messages",
			value: { text: "original" },
			clientRequestId: "put-1",
		});
		if (appended._nay) {
			throw new Error(appended._nay.message);
		}
		const ownedKey = appended._yay.key;

		// Another member may not edit the owned doc, not even through the door.
		const refused = await member.asPage.mutation(api.plugins_data.user_put_document, {
			collection: "messages",
			key: ownedKey,
			value: { text: "hijacked" },
		});
		expect(refused._nay?.message).toBe("This document belongs to another writer");

		// The creator edits their own doc, and it stays owned.
		const edited = await fixture.asPage.mutation(api.plugins_data.user_put_document, {
			collection: "messages",
			key: ownedKey,
			value: { text: "edited" },
		});
		if (edited._nay) {
			throw new Error(edited._nay.message);
		}
		expect(edited._yay.revision).toBe(2);

		// A put on an absent key creates a shared doc, and any member with content.write may update it.
		const created = await member.asPage.mutation(api.plugins_data.user_put_document, {
			collection: "channels",
			key: "general",
			value: { name: "general" },
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		const renamed = await fixture.asPage.mutation(api.plugins_data.user_put_document, {
			collection: "channels",
			key: "general",
			value: { name: "renamed" },
		});
		if (renamed._nay) {
			throw new Error(renamed._nay.message);
		}
		expect(renamed._yay.revision).toBe(2);

		const documents = await read_documents(t, fixture);
		expect(documents.find((doc) => doc.key === ownedKey)).toMatchObject({
			value: { text: "edited" },
			ownership: "owned",
			createdBy: fixture.userId,
		});
		expect(documents.find((doc) => doc.key === "general")).toMatchObject({
			value: { name: "renamed" },
			ownership: "shared",
			createdBy: member.userId,
			updatedBy: fixture.userId,
		});
	});

	test("refuses a versioned key with the service literal", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t);
		await t.mutation(internal.plugins_data.write_versioned_document, {
			principal: service_principal(fixture),
			collection: "messages",
			key: "outbox",
			revision: 1,
			value: { n: 1 },
		});

		const put = await fixture.asPage.mutation(api.plugins_data.user_put_document, {
			collection: "messages",
			key: "outbox",
			value: { n: 2 },
		});
		expect(put._nay?.message).toBe("This document is written by a service and cannot be changed here");
		const removed = await fixture.asPage.mutation(api.plugins_data.user_remove_document, {
			collection: "messages",
			key: "outbox",
		});
		expect(removed._nay?.message).toBe("This document is written by a service and cannot be changed here");

		const documents = await read_documents(t, fixture);
		expect(documents).toHaveLength(1);
		expect(documents[0]).toMatchObject({ key: "outbox", value: { n: 1 }, writeMode: "versioned" });
	});

	test("expectedRevision gates the put against the revision the caller read", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t);
		const member = await join_member_with_role(t, fixture, { clerkUserId: "cas-put-member", role: "member" });
		const put = async (args: { key?: string; value: Record<string, unknown>; expectedRevision?: number }) =>
			await fixture.asPage.mutation(api.plugins_data.user_put_document, {
				collection: "channels",
				key: args.key ?? "general",
				value: args.value,
				...(args.expectedRevision === undefined ? {} : { expectedRevision: args.expectedRevision }),
			});

		// 0 means "must not exist yet", and the first stored revision is 1.
		expect((await put({ value: { name: "general" }, expectedRevision: 0 }))._yay).toMatchObject({ revision: 1 });
		expect((await put({ value: { name: "late" }, expectedRevision: 0 }))._nay).toEqual({
			name: "conflict",
			message: "This document changed since it was read",
		});

		// A matching revision writes; replaying the same guess refuses, and the refusal carries no
		// fresh revision to retry against.
		expect((await put({ value: { name: "renamed" }, expectedRevision: 1 }))._yay).toMatchObject({ revision: 2 });
		const stale = await put({ value: { name: "stale" }, expectedRevision: 1 });
		expect(stale._nay).toEqual({ name: "conflict", message: "This document changed since it was read" });

		// A guess about an absent doc refuses too: the doc it read is gone.
		expect((await put({ key: "missing", value: { n: 1 }, expectedRevision: 3 }))._nay).toMatchObject({
			message: "This document changed since it was read",
		});

		// Delete and recreate starts over at revision 1: a revision orders one document lifetime.
		const removed = await fixture.asPage.mutation(api.plugins_data.user_remove_document, {
			collection: "channels",
			key: "general",
		});
		expect(removed._yay).toEqual({ deleted: true });
		expect((await put({ value: { name: "reborn" }, expectedRevision: 0 }))._yay).toMatchObject({ revision: 1 });

		// Bad guesses are bad input, not conflicts.
		expect((await put({ value: { n: 1 }, expectedRevision: -1 }))._nay?.message).toBe(
			"Expected revisions must be non-negative integers",
		);
		expect((await put({ value: { n: 1 }, expectedRevision: 1.5 }))._nay?.message).toBe(
			"Expected revisions must be non-negative integers",
		);

		// Ownership is judged before the guess: a writer refused for ownership hears that refusal
		// whatever revision they pass, so the guess cannot probe a doc they may not touch.
		const appended = await fixture.asPage.mutation(api.plugins_data.user_append_document, {
			collection: "messages",
			value: { text: "mine" },
			clientRequestId: "cas-owned",
		});
		if (appended._nay) {
			throw new Error(appended._nay.message);
		}
		const hijack = await member.asPage.mutation(api.plugins_data.user_put_document, {
			collection: "messages",
			key: appended._yay.key,
			value: { text: "hijacked" },
			expectedRevision: 999,
		});
		expect(hijack._nay?.message).toBe("This document belongs to another writer");
	});
});

describe("user_remove_document", () => {
	test("deletes own and shared docs, reports absent keys, and guards owned docs", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t);
		const member = await join_member_with_role(t, fixture, { clerkUserId: "door-remover", role: "member" });

		const absent = await fixture.asPage.mutation(api.plugins_data.user_remove_document, {
			collection: "messages",
			key: "never-stored",
		});
		expect(absent).toEqual({ _yay: { deleted: false } });

		const appended = await fixture.asPage.mutation(api.plugins_data.user_append_document, {
			collection: "messages",
			value: { text: "mine" },
			clientRequestId: "rm-1",
		});
		if (appended._nay) {
			throw new Error(appended._nay.message);
		}

		const refused = await member.asPage.mutation(api.plugins_data.user_remove_document, {
			collection: "messages",
			key: appended._yay.key,
		});
		expect(refused._nay?.message).toBe("This document belongs to another writer");
		expect(await read_documents(t, fixture)).toHaveLength(1);

		// A shared doc is removable by any member with content.write, not only its creator.
		const shared = await member.asPage.mutation(api.plugins_data.user_put_document, {
			collection: "messages",
			key: "shared-note",
			value: { n: 1 },
		});
		if (shared._nay) {
			throw new Error(shared._nay.message);
		}
		const sharedRemoved = await fixture.asPage.mutation(api.plugins_data.user_remove_document, {
			collection: "messages",
			key: "shared-note",
		});
		expect(sharedRemoved).toEqual({ _yay: { deleted: true } });

		const ownRemoved = await fixture.asPage.mutation(api.plugins_data.user_remove_document, {
			collection: "messages",
			key: appended._yay.key,
		});
		expect(ownRemoved).toEqual({ _yay: { deleted: true } });
		expect(await read_documents(t, fixture)).toHaveLength(0);
		expect(await read_usage(t, fixture)).toMatchObject({ usedDocuments: 0, usedBytes: 0 });
	});

	test("expectedRevision gates the remove, and an absent doc answers the guess", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t);
		const member = await join_member_with_role(t, fixture, { clerkUserId: "cas-remove-member", role: "member" });
		const remove = async (args: { key: string; expectedRevision?: number }) =>
			await fixture.asPage.mutation(api.plugins_data.user_remove_document, {
				collection: "channels",
				key: args.key,
				...(args.expectedRevision === undefined ? {} : { expectedRevision: args.expectedRevision }),
			});

		const created = await fixture.asPage.mutation(api.plugins_data.user_put_document, {
			collection: "channels",
			key: "general",
			value: { name: "general" },
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		// A stale guess leaves the doc alone; the read revision deletes it.
		expect((await remove({ key: "general", expectedRevision: 2 }))._nay).toEqual({
			name: "conflict",
			message: "This document changed since it was read",
		});
		expect((await remove({ key: "general", expectedRevision: 1 }))._yay).toEqual({ deleted: true });

		// An absent doc keeps the idempotent answer for "no expectation" and for "must not exist",
		// and refuses a guess about a revision that is gone.
		expect((await remove({ key: "general" }))._yay).toEqual({ deleted: false });
		expect((await remove({ key: "general", expectedRevision: 0 }))._yay).toEqual({ deleted: false });
		expect((await remove({ key: "general", expectedRevision: 1 }))._nay).toMatchObject({
			message: "This document changed since it was read",
		});

		// Ownership is judged before the guess, like the put.
		const appended = await fixture.asPage.mutation(api.plugins_data.user_append_document, {
			collection: "messages",
			value: { text: "mine" },
			clientRequestId: "cas-remove-owned",
		});
		if (appended._nay) {
			throw new Error(appended._nay.message);
		}
		const hijack = await member.asPage.mutation(api.plugins_data.user_remove_document, {
			collection: "messages",
			key: appended._yay.key,
			expectedRevision: 999,
		});
		expect(hijack._nay?.message).toBe("This document belongs to another writer");
	});
});

describe("user_put_owned_document", () => {
	test("isolates two members writing the same logical key", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t);
		const member = await join_member_with_role(t, fixture, { clerkUserId: "door-reactor", role: "member" });

		const aVote = await fixture.asPage.mutation(api.plugins_data.user_put_owned_document, {
			collection: "reactions",
			key: "vote",
			value: { choice: "yes" },
		});
		const bVote = await member.asPage.mutation(api.plugins_data.user_put_owned_document, {
			collection: "reactions",
			key: "vote",
			value: { choice: "no" },
		});
		if (aVote._nay || bVote._nay) {
			throw new Error(aVote._nay?.message ?? bVote._nay?.message);
		}
		expect(aVote._yay.key).toBe(`vote:${fixture.userId}`);
		expect(bVote._yay.key).toBe(`vote:${member.userId}`);
		expect(await read_documents(t, fixture)).toHaveLength(2);

		// The generic remove on the other member's full suffixed key hits the ownership rule.
		const forged = await member.asPage.mutation(api.plugins_data.user_remove_document, {
			collection: "reactions",
			key: aVote._yay.key,
		});
		expect(forged._nay?.message).toBe("This document belongs to another writer");

		// A ":" smuggled into the caller key stays caller text: it lands under the caller's own suffix.
		const smuggled = await member.asPage.mutation(api.plugins_data.user_put_owned_document, {
			collection: "reactions",
			key: `vote:${fixture.userId}`,
			value: { choice: "forged" },
		});
		if (smuggled._nay) {
			throw new Error(smuggled._nay.message);
		}
		expect(smuggled._yay.key).toBe(`vote:${fixture.userId}:${member.userId}`);
		const documents = await read_documents(t, fixture);
		expect(documents).toHaveLength(3);
		expect(documents.find((doc) => doc.key === `vote:${fixture.userId}`)).toMatchObject({
			value: { choice: "yes" },
			createdBy: fixture.userId,
		});

		// removeOwned only ever reaches the caller's own suffix.
		const removed = await member.asPage.mutation(api.plugins_data.user_remove_owned_document, {
			collection: "reactions",
			key: "vote",
		});
		expect(removed).toEqual({ _yay: { deleted: true } });
		const after = await read_documents(t, fixture);
		expect(after.map((doc) => doc.key).sort()).toEqual([`vote:${fixture.userId}`, `vote:${fixture.userId}:${member.userId}`]);

		const removedAgain = await member.asPage.mutation(api.plugins_data.user_remove_owned_document, {
			collection: "reactions",
			key: "vote",
		});
		expect(removedAgain).toEqual({ _yay: { deleted: false } });
	});

	test("refuses a squatted composed key and a key that outgrows the budget", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t);

		// A shared doc created at exactly the composed key squats it; putOwned must refuse, not adopt.
		const squat = await fixture.asPage.mutation(api.plugins_data.user_put_document, {
			collection: "reactions",
			key: `poll:${fixture.userId}`,
			value: { n: 1 },
		});
		if (squat._nay) {
			throw new Error(squat._nay.message);
		}
		const refused = await fixture.asPage.mutation(api.plugins_data.user_put_owned_document, {
			collection: "reactions",
			key: "poll",
			value: { n: 2 },
		});
		expect(refused._nay?.message).toBe("This document belongs to another writer");
		const documents = await read_documents(t, fixture);
		expect(documents).toHaveLength(1);
		expect(documents[0]).toMatchObject({ value: { n: 1 }, ownership: "shared" });

		// The composed key must still fit 128 characters with `:` and the writer id appended.
		const idLength = String(fixture.userId).length;
		const fits = await fixture.asPage.mutation(api.plugins_data.user_put_owned_document, {
			collection: "reactions",
			key: "k".repeat(127 - idLength),
			value: { n: 3 },
		});
		if (fits._nay) {
			throw new Error(fits._nay.message);
		}
		expect(fits._yay.key.length).toBe(128);
		const overflow = await fixture.asPage.mutation(api.plugins_data.user_put_owned_document, {
			collection: "reactions",
			key: "k".repeat(128 - idLength),
			value: { n: 4 },
		});
		expect(overflow._nay?.message).toBe("Keys must be at most 128 characters after the writer id is appended");
	});

	test("expectedRevision gates the owned put and remove against the composed key's doc", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t);
		const putOwned = async (args: { value: Record<string, unknown>; expectedRevision?: number }) =>
			await fixture.asPage.mutation(api.plugins_data.user_put_owned_document, {
				collection: "reactions",
				key: "msg-1",
				value: args.value,
				...(args.expectedRevision === undefined ? {} : { expectedRevision: args.expectedRevision }),
			});
		const removeOwned = async (args: { expectedRevision?: number }) =>
			await fixture.asPage.mutation(api.plugins_data.user_remove_owned_document, {
				collection: "reactions",
				key: "msg-1",
				...(args.expectedRevision === undefined ? {} : { expectedRevision: args.expectedRevision }),
			});

		// The guess is judged against the doc at the composed key, so the same flow as the shared
		// put holds per member: create with 0, update with the read revision, refuse the replay.
		expect((await putOwned({ value: { emoji: "👍" }, expectedRevision: 0 }))._yay).toMatchObject({ revision: 1 });
		expect((await putOwned({ value: { emoji: "🎉" }, expectedRevision: 1 }))._yay).toMatchObject({ revision: 2 });
		expect((await putOwned({ value: { emoji: "👀" }, expectedRevision: 1 }))._nay).toEqual({
			name: "conflict",
			message: "This document changed since it was read",
		});

		// The owned remove answers the guess the same way, absent doc included.
		expect((await removeOwned({ expectedRevision: 1 }))._nay).toMatchObject({
			message: "This document changed since it was read",
		});
		expect((await removeOwned({ expectedRevision: 2 }))._yay).toEqual({ deleted: true });
		expect((await removeOwned({ expectedRevision: 0 }))._yay).toEqual({ deleted: false });
		expect((await removeOwned({ expectedRevision: 2 }))._nay).toMatchObject({
			message: "This document changed since it was read",
		});
	});

	test("an oversized cursor map is refused on value size, not as a full store, and a lost race keeps the stored map", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t);
		const putCursors = async (args: { value: Record<string, unknown>; expectedRevision?: number }) =>
			await fixture.asPage.mutation(api.plugins_data.user_put_owned_document, {
				collection: "cursors",
				key: "read-cursors",
				value: args.value,
				...(args.expectedRevision === undefined ? {} : { expectedRevision: args.expectedRevision }),
			});

		// A member holding one read cursor per channel keeps them in one owned document, so the value
		// ceiling is what a growing workspace meets first. The refusal has to say that. `storage_full`
		// already means two different things — the installation is full, and this member's share is
		// full — and neither is true here: the store has room, this one value is too big. A plugin
		// reading `_nay.name` alone would tell the member to delete messages, which cannot help.
		const tooBig = await putCursors({ value: value_of_bytes(16 * 1024 + 1) });
		expect(tooBig._nay).toEqual({ message: "Plugin document values must be at most 16 KiB" });
		expect(tooBig._nay?.name).toBeUndefined();

		// A member with two tabs open writes the whole map at once, so a lost race must not drop the
		// cursors the winner stored.
		const stored = await putCursors({ value: { general: 7, random: 3 }, expectedRevision: 0 });
		if (stored._nay) {
			throw new Error(stored._nay.message);
		}
		const stale = await putCursors({ value: { general: 1 }, expectedRevision: 0 });
		expect(stale._nay).toEqual({ name: "conflict", message: "This document changed since it was read" });

		const documents = await read_documents(t, fixture);
		expect(documents.find((doc) => doc.collection === "cursors")?.value).toEqual({ general: 7, random: 3 });
	});
});

describe("db_authorize_page_write", () => {
	test("refuses non-page identities and dead sessions, and keeps tenants apart", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t);

		const unauthenticated = await t.mutation(api.plugins_data.user_append_document, {
			collection: "messages",
			value: { text: "nobody" },
			clientRequestId: "refused-1",
		});
		expect(unauthenticated._nay?.message).toBe("Unauthenticated");

		// The member's own Clerk identity is not a plugin page: these doors answer only the
		// plugin-session JWT, the way member functions refuse that JWT.
		const asMember = await fixture.asUser.mutation(api.plugins_data.user_append_document, {
			collection: "messages",
			value: { text: "member" },
			clientRequestId: "refused-2",
		});
		expect(asMember._nay?.message).toBe("Unauthenticated");

		// An expired session refuses even while its doc still exists (the expiry job has not fired).
		await t.run(async (ctx) => {
			await ctx.db.patch("plugins_ui_sessions", fixture.sessionId, { expiresAt: Date.now() - 1000 });
		});
		const expired = await fixture.asPage.mutation(api.plugins_data.user_append_document, {
			collection: "messages",
			value: { text: "expired" },
			clientRequestId: "refused-3",
		});
		expect(expired._nay?.message).toBe("Unauthenticated");

		// A revoked (deleted) session dies whatever the JWT still says.
		await t.run(async (ctx) => {
			await ctx.db.delete("plugins_ui_sessions", fixture.sessionId);
		});
		const revoked = await fixture.asPage.mutation(api.plugins_data.user_append_document, {
			collection: "messages",
			value: { text: "revoked" },
			clientRequestId: "refused-4",
		});
		expect(revoked._nay?.message).toBe("Unauthenticated");

		// A stranger's page can only write into its own installation, so this store stays empty.
		const stranger = await seed_user_write_door(t, { organizationName: "stranger-org", clerkUserId: "door-stranger" });
		const strangerAppend = await stranger.asPage.mutation(api.plugins_data.user_append_document, {
			collection: "messages",
			value: { text: "stranger" },
			clientRequestId: "stranger-1",
		});
		expect(strangerAppend._nay).toBeUndefined();

		expect(await read_documents(t, fixture)).toHaveLength(0);
	});

	test("closes the door on every revocation flavor and on a read-only role", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t);
		const append = async (clientRequestId: string) =>
			await fixture.asPage.mutation(api.plugins_data.user_append_document, {
				collection: "messages",
				value: { text: clientRequestId },
				clientRequestId,
			});

		expect((await append("baseline"))._nay).toBeUndefined();

		// 1) The workspace withdraws its consent for the capability.
		await t.run(async (ctx) => {
			await ctx.db.patch("plugins_workspace_installations", fixture.installationId, {
				acceptedCapabilities: ["plugin.data.read", "plugin.data.write", "plugin.service.connect"],
			});
		});
		expect((await append("no-acceptance"))._nay?.message).toBe("Permission denied");
		await t.run(async (ctx) => {
			await ctx.db.patch("plugins_workspace_installations", fixture.installationId, {
				acceptedCapabilities: [
					"plugin.data.read",
					"plugin.data.write",
					"plugin.data.user-write",
					"plugin.service.connect",
				],
			});
		});

		// 2) The installation is disabled.
		await t.run(async (ctx) => {
			await ctx.db.patch("plugins_workspace_installations", fixture.installationId, { status: "disabled" });
		});
		expect((await append("disabled"))._nay?.message).toBe("Unauthorized");
		await t.run(async (ctx) => {
			await ctx.db.patch("plugins_workspace_installations", fixture.installationId, { status: "enabled" });
		});

		// 3) An upgrade moves the installation to a new version, revoking sessions minted under
		// the old one before any capability difference matters.
		const upgradedVersionId = await t.run(async (ctx) => {
			const version = await ctx.db.get("plugins_versions", fixture.pluginVersionId);
			const { _id, _creationTime, ...rest } = version!;
			return await ctx.db.insert("plugins_versions", { ...rest, version: "0.2.0", isLatest: false });
		});
		await t.run(async (ctx) => {
			await ctx.db.patch("plugins_workspace_installations", fixture.installationId, {
				pluginVersionId: upgradedVersionId,
			});
		});
		expect((await append("upgraded"))._nay?.message).toBe("Unauthorized");
		await t.run(async (ctx) => {
			await ctx.db.patch("plugins_workspace_installations", fixture.installationId, {
				pluginVersionId: fixture.pluginVersionId,
			});
		});

		// 4) An upgrade stops declaring the capability, even though the workspace once accepted it.
		await t.run(async (ctx) => {
			await ctx.db.patch("plugins_versions", fixture.pluginVersionId, {
				capabilities: ["plugin.data.read", "plugin.data.write", "plugin.service.connect"],
			});
		});
		expect((await append("no-declaration"))._nay?.message).toBe("Permission denied");
		await t.run(async (ctx) => {
			await ctx.db.patch("plugins_versions", fixture.pluginVersionId, {
				capabilities: [
					"plugin.data.read",
					"plugin.data.write",
					"plugin.data.user-write",
					"plugin.service.connect",
				] satisfies plugins_Capability[],
			});
		});

		// 5) A viewer may read the workspace but not write it.
		const viewer = await join_member_with_role(t, fixture, { clerkUserId: "door-viewer", role: "viewer" });
		const viewerAppend = await viewer.asPage.mutation(api.plugins_data.user_append_document, {
			collection: "messages",
			value: { text: "viewer" },
			clientRequestId: "viewer-1",
		});
		expect(viewerAppend._nay?.message).toBe("Permission denied");

		// 6) The minting user's account is deleted.
		await t.run(async (ctx) => {
			await ctx.db.patch("users", fixture.userId, { deletedAt: Date.now() });
		});
		expect((await append("dead-account"))._nay?.message).toBe("Unauthorized");
		await t.run(async (ctx) => {
			await ctx.db.patch("users", fixture.userId, { deletedAt: undefined });
		});

		// 7) The membership itself is removed.
		await t.run(async (ctx) => {
			await ctx.db.patch("organizations_workspaces_users", fixture.membershipId, { active: false });
		});
		expect((await append("no-membership"))._nay?.message).toBe("Unauthorized");

		// Only the baseline write landed.
		const documents = await read_documents(t, fixture);
		expect(documents).toHaveLength(1);
		expect(documents[0]).toMatchObject({ value: { text: "baseline" } });
	});
});

describe("watch_documents", () => {
	test("throws with no auth identity and answers null for non-page and dead-session callers", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t);

		await expect(
			t.query(api.plugins_data.watch_documents, {
				collection: "messages",
				limit: 10,
			}),
		).rejects.toThrow(/Unauthenticated/);

		// The member's own Clerk identity is authenticated but is not a plugin page: it hears
		// null like every other denial, not an error.
		const asMember = await fixture.asUser.query(api.plugins_data.watch_documents, {
			collection: "messages",
			limit: 10,
		});
		expect(asMember).toBeNull();

		// An expired session answers null even while its doc still exists.
		await t.run(async (ctx) => {
			await ctx.db.patch("plugins_ui_sessions", fixture.sessionId, { expiresAt: Date.now() - 1000 });
		});
		expect(
			await fixture.asPage.query(api.plugins_data.watch_documents, {
				collection: "messages",
				limit: 10,
			}),
		).toBeNull();

		// A revoked (deleted) session dies into null: the kill signal for a live subscription.
		await t.run(async (ctx) => {
			await ctx.db.delete("plugins_ui_sessions", fixture.sessionId);
		});
		expect(
			await fixture.asPage.query(api.plugins_data.watch_documents, {
				collection: "messages",
				limit: 10,
			}),
		).toBeNull();
	});

	test("returns the newest window in ascending key order and respects the limit", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t);
		const baseNow = Date.now();

		const dateNow = vi.spyOn(Date, "now").mockReturnValue(baseNow);
		try {
			const keys: string[] = [];
			for (let index = 0; index < 3; index += 1) {
				dateNow.mockReturnValue(baseNow + index * 5_000);
				const appended = await fixture.asPage.mutation(api.plugins_data.user_append_document, {
					collection: "messages",
					value: { n: index },
					clientRequestId: `watch-order-${index}`,
				});
				if (appended._nay) {
					throw new Error(appended._nay.message);
				}
				keys.push(appended._yay.key);
			}

			const watched = await fixture.asPage.query(api.plugins_data.watch_documents, {
				collection: "messages",
				limit: 2,
			});
			// The window holds the two newest appends: inverted-ms keys make ascending order newest
			// first, so the oldest append falls off the end of the window, not the newest.
			expect(watched?.docs.map((doc) => doc.key)).toEqual([keys[2], keys[1]]);
			expect(watched?.docs.map((doc) => doc.value)).toEqual([{ n: 2 }, { n: 1 }]);
		} finally {
			dateNow.mockRestore();
		}
	});

	test("keyPrefix narrows the window and spans a supplementary Unicode key", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t);

		for (const [index, keyPrefix] of ["general:", "general:", "random:"].entries()) {
			const appended = await fixture.asPage.mutation(api.plugins_data.user_append_document, {
				collection: "messages",
				keyPrefix,
				value: { n: index },
				clientRequestId: `watch-prefix-${index}`,
			});
			if (appended._nay) {
				throw new Error(appended._nay.message);
			}
		}
		// A key whose first character after the prefix is U+10FFFF sorts above every ASCII
		// continuation, and above the broken `prefix + "\uffff"` bound this range must not use. The
		// door only mints ASCII keys, so store it through the interactive write path, whose key rule
		// allows non-control Unicode.
		const unicodeKey = "general:\u{10FFFF}late";
		const written = await t.mutation(internal.plugins_data.write_document, {
			principal: store_principal(fixture),
			collection: "messages",
			key: unicodeKey,
			value: { n: 3 },
		});
		expect(written._nay).toBeUndefined();

		const watched = await fixture.asPage.query(api.plugins_data.watch_documents, {
			collection: "messages",
			keyPrefix: "general:",
			limit: 100,
		});
		expect(watched?.docs).toHaveLength(3);
		expect(watched?.docs.every((doc) => doc.key.startsWith("general:"))).toBe(true);
		expect(watched?.docs.map((doc) => doc.key)).toContain(unicodeKey);
	});

	test("interval bounds intersect with the key prefix on the tighter side", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t);
		for (const key of ["a:", "a:1", "a:2", "a:3", "a:4", "b:1"]) {
			const written = await t.mutation(internal.plugins_data.write_document, {
				principal: store_principal(fixture),
				collection: "messages",
				key,
				value: { key },
			});
			expect(written._nay).toBeUndefined();
		}
		const watch = async (args: { keyPrefix?: string; keyStartExclusive?: string; keyEndInclusive?: string }) =>
			await fixture.asPage.query(api.plugins_data.watch_documents, {
				collection: "messages",
				...args,
				limit: 100,
			});
		const keys = async (args: Parameters<typeof watch>[0]) => (await watch(args))?.docs.map((doc) => doc.key);

		// One bound at a time, both inside the prefix range.
		expect(await keys({ keyPrefix: "a:", keyEndInclusive: "a:2" })).toEqual(["a:", "a:1", "a:2"]);
		expect(await keys({ keyPrefix: "a:", keyStartExclusive: "a:2" })).toEqual(["a:3", "a:4"]);

		// Both bounds inside the prefix range.
		expect(await keys({ keyPrefix: "a:", keyStartExclusive: "a:1", keyEndInclusive: "a:3" })).toEqual(["a:2", "a:3"]);

		// Bounds outside the prefix range lose to the prefix on their side.
		expect(await keys({ keyPrefix: "a:", keyStartExclusive: "Z", keyEndInclusive: "z" })).toEqual([
			"a:",
			"a:1",
			"a:2",
			"a:3",
			"a:4",
		]);

		// A start bound equal to the prefix's own lower bound is the tighter side: its `gt` drops
		// the doc whose key IS the prefix, which the prefix's `gte` kept above.
		expect(await keys({ keyPrefix: "a:", keyStartExclusive: "a:" })).toEqual(["a:1", "a:2", "a:3", "a:4"]);

		// Bounds with no prefix at all cross the former prefix boundary.
		expect(await keys({ keyStartExclusive: "a:2", keyEndInclusive: "b:1" })).toEqual(["a:3", "a:4", "b:1"]);
	});

	test("an interval whose bounds cross or touch exclusively answers empty, not null", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t);
		for (const key of ["a:1", "a:2", "a:3"]) {
			const written = await t.mutation(internal.plugins_data.write_document, {
				principal: store_principal(fixture),
				collection: "messages",
				key,
				value: { key },
			});
			expect(written._nay).toBeUndefined();
		}
		const watch = async (args: { keyStartExclusive: string; keyEndInclusive: string }) =>
			await fixture.asPage.query(api.plugins_data.watch_documents, {
				collection: "messages",
				...args,
				limit: 100,
			});

		// Inverted bounds hold nothing. They are not refused, because detecting the inversion is
		// itself a key comparison, and the window dies as empty either way.
		expect(await watch({ keyStartExclusive: "a:3", keyEndInclusive: "a:1" })).toEqual({ docs: [], truncated: false });

		// gt X .. lte X holds nothing either: the one shared key is dropped by the exclusive side.
		expect(await watch({ keyStartExclusive: "a:2", keyEndInclusive: "a:2" })).toEqual({ docs: [], truncated: false });
	});

	test("truncated says whether the range holds more documents than the limit", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t);
		for (const key of ["a:1", "a:2", "a:3"]) {
			const written = await t.mutation(internal.plugins_data.write_document, {
				principal: store_principal(fixture),
				collection: "messages",
				key,
				value: { key },
			});
			expect(written._nay).toBeUndefined();
		}
		const watch = async (args: { keyStartExclusive?: string; keyEndInclusive?: string; limit: number }) =>
			await fixture.asPage.query(api.plugins_data.watch_documents, {
				collection: "messages",
				...args,
			});

		// The extra document read past the limit only flips the flag; it never leaves the server.
		expect(await watch({ limit: 2 })).toEqual({
			docs: [expect.objectContaining({ key: "a:1" }), expect.objectContaining({ key: "a:2" })],
			truncated: true,
		});
		expect((await watch({ limit: 3 }))?.truncated).toBe(false);

		// The flag is judged inside the bounded range, not against the whole collection.
		expect(await watch({ keyStartExclusive: "a:1", keyEndInclusive: "a:3", limit: 1 })).toEqual({
			docs: [expect.objectContaining({ key: "a:2" })],
			truncated: true,
		});
		expect((await watch({ keyStartExclusive: "a:1", limit: 2 }))?.truncated).toBe(false);
	});

	test("bound comparisons follow the index's UTF-8 order for supplementary-plane keys", async () => {
		// In UTF-16 a supplementary-plane character compares BELOW U+FFFF, so a JS `<` between these
		// bounds would read the interval as inverted and answer nothing. The index orders keys by
		// their UTF-8 bytes, where U+10FFFF is the largest character, and compareValues must agree
		// with the index for the intersection to be sound.
		expect(compareValues("\u{10FFFF}", "\u{FFFF}")).toBeGreaterThan(0);

		const t = test_convex();
		const fixture = await seed_user_write_door(t);
		const written = await t.mutation(internal.plugins_data.write_document, {
			principal: store_principal(fixture),
			collection: "messages",
			key: "k\u{10FFFF}",
			value: { n: 1 },
		});
		expect(written._nay).toBeUndefined();

		const watched = await fixture.asPage.query(api.plugins_data.watch_documents, {
			collection: "messages",
			keyStartExclusive: "k\u{FFFF}",
			keyEndInclusive: "k\u{10FFFF}",
			limit: 100,
		});
		expect(watched?.docs.map((doc) => doc.key)).toEqual(["k\u{10FFFF}"]);
	});

	test("closes every revocation flavor into null", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t);
		const watch = async () =>
			await fixture.asPage.query(api.plugins_data.watch_documents, {
				collection: "messages",
				limit: 10,
			});

		expect(await watch()).not.toBeNull();

		// 1) The workspace withdraws its consent for the read capability.
		await t.run(async (ctx) => {
			await ctx.db.patch("plugins_workspace_installations", fixture.installationId, {
				acceptedCapabilities: ["plugin.data.write", "plugin.data.user-write", "plugin.service.connect"],
			});
		});
		expect(await watch()).toBeNull();
		await t.run(async (ctx) => {
			await ctx.db.patch("plugins_workspace_installations", fixture.installationId, {
				acceptedCapabilities: [
					"plugin.data.read",
					"plugin.data.write",
					"plugin.data.user-write",
					"plugin.service.connect",
				],
			});
		});

		// 2) The installation is disabled.
		await t.run(async (ctx) => {
			await ctx.db.patch("plugins_workspace_installations", fixture.installationId, { status: "disabled" });
		});
		expect(await watch()).toBeNull();
		await t.run(async (ctx) => {
			await ctx.db.patch("plugins_workspace_installations", fixture.installationId, { status: "enabled" });
		});

		// 3) An upgrade stops declaring the read capability, even though the workspace once accepted it.
		await t.run(async (ctx) => {
			await ctx.db.patch("plugins_versions", fixture.pluginVersionId, {
				capabilities: ["plugin.data.write", "plugin.data.user-write", "plugin.service.connect"],
			});
		});
		expect(await watch()).toBeNull();
		await t.run(async (ctx) => {
			await ctx.db.patch("plugins_versions", fixture.pluginVersionId, {
				capabilities: [
					"plugin.data.read",
					"plugin.data.write",
					"plugin.data.user-write",
					"plugin.service.connect",
				] satisfies plugins_Capability[],
			});
		});

		// 4) An upgrade moves the installation to a new version, revoking sessions minted under
		// the old one before any capability difference matters.
		const upgradedVersionId = await t.run(async (ctx) => {
			const version = await ctx.db.get("plugins_versions", fixture.pluginVersionId);
			const { _id, _creationTime, ...rest } = version!;
			return await ctx.db.insert("plugins_versions", { ...rest, version: "0.2.0", isLatest: false });
		});
		await t.run(async (ctx) => {
			await ctx.db.patch("plugins_workspace_installations", fixture.installationId, {
				pluginVersionId: upgradedVersionId,
			});
		});
		expect(await watch()).toBeNull();
		await t.run(async (ctx) => {
			await ctx.db.patch("plugins_workspace_installations", fixture.installationId, {
				pluginVersionId: fixture.pluginVersionId,
			});
		});

		// 5) The minting user's account is deleted.
		await t.run(async (ctx) => {
			await ctx.db.patch("users", fixture.userId, { deletedAt: Date.now() });
		});
		expect(await watch()).toBeNull();
		await t.run(async (ctx) => {
			await ctx.db.patch("users", fixture.userId, { deletedAt: undefined });
		});

		// 6) The membership itself is removed.
		await t.run(async (ctx) => {
			await ctx.db.patch("organizations_workspaces_users", fixture.membershipId, { active: false });
		});
		expect(await watch()).toBeNull();
	});

	test("lets a read-only viewer watch until the role itself is gone", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t);
		const viewer = await join_member_with_role(t, fixture, { clerkUserId: "watch-viewer", role: "viewer" });
		const watch = async () =>
			await viewer.asPage.query(api.plugins_data.watch_documents, {
				collection: "messages",
				limit: 10,
			});

		// Watching gates on content.read, not content.write: the viewer role holds read alone, and the
		// same role is refused by the write door.
		expect(await watch()).not.toBeNull();

		// Deleting the role assignment takes content.read away, and the same watch dies into null.
		await t.run(async (ctx) => {
			const assignments = await ctx.db.query("access_control_role_assignments").collect();
			for (const assignment of assignments) {
				if (assignment.userId === viewer.userId) {
					await ctx.db.delete("access_control_role_assignments", assignment._id);
				}
			}
		});
		expect(await watch()).toBeNull();
	});

	test("answers null for a window the store can never answer", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t);
		const watch = async (args: {
			collection?: string;
			keyPrefix?: string;
			keyStartExclusive?: string;
			keyEndInclusive?: string;
			limit?: number;
		}) =>
			await fixture.asPage.query(api.plugins_data.watch_documents, {
				collection: args.collection ?? "messages",
				...(args.keyPrefix === undefined ? {} : { keyPrefix: args.keyPrefix }),
				...(args.keyStartExclusive === undefined ? {} : { keyStartExclusive: args.keyStartExclusive }),
				...(args.keyEndInclusive === undefined ? {} : { keyEndInclusive: args.keyEndInclusive }),
				limit: args.limit ?? 10,
			});

		// The baseline answers, so every refusal below comes from the one input it changes.
		expect(await watch({})).not.toBeNull();

		expect(await watch({ collection: "bad\u0000name" })).toBeNull();
		expect(await watch({ keyPrefix: "no space" })).toBeNull();
		expect(await watch({ keyPrefix: "" })).toBeNull();
		expect(await watch({ limit: 0 })).toBeNull();
		expect(await watch({ limit: 101 })).toBeNull();
		expect(await watch({ limit: 2.5 })).toBeNull();

		// Interval bounds follow the key shape rules, and a bad bound dies like any other bad input.
		expect(await watch({ keyStartExclusive: "" })).toBeNull();
		expect(await watch({ keyStartExclusive: "a".repeat(129) })).toBeNull();
		expect(await watch({ keyEndInclusive: "bad\u{0}key" })).toBeNull();
		expect(await watch({ keyEndInclusive: " padded " })).toBeNull();
	});
});

describe("watch_recent", () => {
	/** Appends `count` documents five seconds apart and answers their keys, oldest first. */
	async function append_over_time(
		fixture: Awaited<ReturnType<typeof seed_user_write_door>>,
		args: { count: number; baseNow: number; label: string },
	) {
		const dateNow = vi.spyOn(Date, "now");
		const keys: string[] = [];
		try {
			for (let index = 0; index < args.count; index += 1) {
				dateNow.mockReturnValue(args.baseNow + index * 5_000);
				const appended = await fixture.asPage.mutation(api.plugins_data.user_append_document, {
					collection: "messages",
					value: { n: index },
					clientRequestId: `${args.label}-${index}`,
				});
				if (appended._nay) {
					throw new Error(appended._nay.message);
				}
				keys.push(appended._yay.key);
			}
		} finally {
			dateNow.mockRestore();
		}
		return keys;
	}

	test("reads creation order, and editing an old document does not move it", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t);
		const baseNow = Date.now();
		const keys = await append_over_time(fixture, { count: 3, baseNow, label: "recent-order" });

		// Edit the OLDEST document, at a clock later than every append, so `updatedAt` now says it is
		// the freshest thing in the collection. That is the trap: a member fixing a typo must not push
		// a three-month-old message to the top of everyone's catch-up read. Without the later clock
		// the edited document keeps the smallest `updatedAt` and an `updatedAt`-ordered read would
		// answer creation order by accident, so this test would pass against the defect it exists for.
		const dateNow = vi.spyOn(Date, "now").mockReturnValue(baseNow + 60_000);
		const edited = await fixture.asPage.mutation(api.plugins_data.user_put_document, {
			collection: "messages",
			key: keys[0]!,
			value: { n: 0, edited: true },
		});
		dateNow.mockRestore();
		if (edited._nay) {
			throw new Error(edited._nay.message);
		}

		const recent = await fixture.asPage.query(api.plugins_data.watch_recent, {
			collection: "messages",
			limit: 10,
		});
		expect(recent?.docs.map((doc) => doc.key)).toEqual(keys);
		expect(recent?.docs[0]?.value).toEqual({ n: 0, edited: true });
		expect(recent?.truncated).toBe(false);
	});

	test("since is an exclusive fencepost and truncated says more is waiting", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t);
		const baseNow = Date.now();
		const keys = await append_over_time(fixture, { count: 3, baseNow, label: "recent-since" });

		const all = await fixture.asPage.query(api.plugins_data.watch_recent, {
			collection: "messages",
			limit: 10,
		});
		const firstCreatedAt = all!.docs[0]!.createdAt;

		// The caller copies `createdAt` from the last document it handled, so that same document must
		// not come back. Anything else and every catch-up read redelivers its own fencepost.
		const after = await fixture.asPage.query(api.plugins_data.watch_recent, {
			collection: "messages",
			since: firstCreatedAt,
			limit: 10,
		});
		expect(after?.docs.map((doc) => doc.key)).toEqual([keys[1], keys[2]]);

		const firstPage = await fixture.asPage.query(api.plugins_data.watch_recent, {
			collection: "messages",
			limit: 2,
		});
		expect(firstPage?.docs.map((doc) => doc.key)).toEqual([keys[0], keys[1]]);
		expect(firstPage?.truncated).toBe(true);
	});

	test("answers null for a non-page caller and for bad input", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t);

		expect(
			await fixture.asUser.query(api.plugins_data.watch_recent, { collection: "messages", limit: 10 }),
		).toBeNull();

		expect(await fixture.asPage.query(api.plugins_data.watch_recent, { collection: "messages", limit: 10 })).not.toBeNull();
		expect(
			await fixture.asPage.query(api.plugins_data.watch_recent, { collection: "bad name", limit: 10 }),
		).toBeNull();
		expect(await fixture.asPage.query(api.plugins_data.watch_recent, { collection: "messages", limit: 0 })).toBeNull();
		expect(await fixture.asPage.query(api.plugins_data.watch_recent, { collection: "messages", limit: 101 })).toBeNull();
		expect(
			await fixture.asPage.query(api.plugins_data.watch_recent, { collection: "messages", limit: 10, since: Number.NaN }),
		).toBeNull();
	});

	test("descending answers newest first, before pages it, and an edit does not move a document", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t);
		const baseNow = Date.now();
		const keys = await append_over_time(fixture, { count: 3, baseNow, label: "recent-desc" });

		// Same trap as the ascending test: edit the OLDEST document at the latest clock, so an
		// `updatedAt`-ordered read would answer it as the newest thing in the feed.
		const dateNow = vi.spyOn(Date, "now").mockReturnValue(baseNow + 60_000);
		const edited = await fixture.asPage.mutation(api.plugins_data.user_put_document, {
			collection: "messages",
			key: keys[0]!,
			value: { n: 0, edited: true },
		});
		dateNow.mockRestore();
		if (edited._nay) {
			throw new Error(edited._nay.message);
		}

		// The boot read: newest first, no fencepost yet. A feed cannot boot through `since`, because
		// ascending truncation cuts the newest end off — the exact end the feed is for.
		const newest = await fixture.asPage.query(api.plugins_data.watch_recent, {
			collection: "messages",
			order: "desc",
			limit: 2,
		});
		expect(newest?.docs.map((doc) => doc.key)).toEqual([keys[2], keys[1]]);
		expect(newest?.truncated).toBe(true);

		// Paging: `before` copies the oldest rendered `createdAt` and must not redeliver it.
		const older = await fixture.asPage.query(api.plugins_data.watch_recent, {
			collection: "messages",
			order: "desc",
			before: newest!.docs[1]!.createdAt,
			limit: 10,
		});
		expect(older?.docs.map((doc) => doc.key)).toEqual([keys[0]]);
		expect(older?.docs[0]?.value).toEqual({ n: 0, edited: true });
		expect(older?.truncated).toBe(false);
	});

	test("each fencepost belongs to one direction", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t);
		await append_over_time(fixture, { count: 1, baseNow: Date.now(), label: "recent-mix" });

		// A mixed call asked for an order it does not understand, and the wrong end of the read would
		// be truncated silently — so it answers null like every other bad input.
		expect(
			await fixture.asPage.query(api.plugins_data.watch_recent, {
				collection: "messages",
				order: "desc",
				since: Date.now(),
				limit: 10,
			}),
		).toBeNull();
		expect(
			await fixture.asPage.query(api.plugins_data.watch_recent, {
				collection: "messages",
				before: Date.now(),
				limit: 10,
			}),
		).toBeNull();
		expect(
			await fixture.asPage.query(api.plugins_data.watch_recent, {
				collection: "messages",
				order: "desc",
				before: Number.NaN,
				limit: 10,
			}),
		).toBeNull();
	});
});

describe("resolve_member_display", () => {
	test("resolves live members and answers null entries for everyone else", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t);
		const member = await join_member_with_role(t, fixture, { clerkUserId: "resolve-member", role: "member" });
		// A user with a live membership in another workspace only: their name must not leak here, even
		// though they have one stored.
		const outsider = await seed_user_write_door(t, {
			organizationName: "resolve-outside-org",
			clerkUserId: "resolve-outsider",
		});
		// The fixtures skip the sign-in bootstrap that writes anagraphics, so store the names directly.
		await t.run(async (ctx) => {
			const now = Date.now();
			for (const [userId, displayName] of [
				[fixture.userId, "Door Owner"],
				[member.userId, "Second Member"],
				[outsider.userId, "Outside Person"],
			] as const) {
				const anagraphicId = await ctx.db.insert("users_anagraphics", {
					userId,
					displayName,
					email: "",
					updatedAt: now,
				});
				await ctx.db.patch("users", userId, { anagraphic: anagraphicId });
			}
		});
		// An id whose user doc is gone entirely.
		const unknownUserId = await t.run(async (ctx) => {
			const userId = await ctx.db.insert("users", { clerkUserId: "resolve-deleted" });
			await ctx.db.delete("users", userId);
			return userId;
		});

		const resolved = await fixture.asPage.query(api.plugins_data.resolve_member_display, {
			userIds: [fixture.userId, member.userId, outsider.userId, unknownUserId],
		});
		expect(resolved).toEqual({
			members: {
				[fixture.userId]: "Door Owner",
				[member.userId]: "Second Member",
				[outsider.userId]: null,
				[unknownUserId]: null,
			},
		});
	});

	test("throws with no auth identity and answers null for denials and bad input", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t);

		await expect(
			t.query(api.plugins_data.resolve_member_display, {
				userIds: [fixture.userId],
			}),
		).rejects.toThrow(/Unauthenticated/);

		const resolve = async (userIds: Id<"users">[]) =>
			await fixture.asPage.query(api.plugins_data.resolve_member_display, {
				userIds,
			});

		// The read capability gates name resolution the same way it gates the watch.
		await t.run(async (ctx) => {
			await ctx.db.patch("plugins_workspace_installations", fixture.installationId, {
				acceptedCapabilities: ["plugin.data.write", "plugin.data.user-write", "plugin.service.connect"],
			});
		});
		expect(await resolve([fixture.userId])).toBeNull();
		await t.run(async (ctx) => {
			await ctx.db.patch("plugins_workspace_installations", fixture.installationId, {
				acceptedCapabilities: [
					"plugin.data.read",
					"plugin.data.write",
					"plugin.data.user-write",
					"plugin.service.connect",
				],
			});
		});

		expect(await resolve([])).toBeNull();
		expect(await resolve(Array.from({ length: 51 }, () => fixture.userId))).toBeNull();
		// The same call inside the ceiling answers, so the refusals above came from the input alone.
		expect(await resolve([fixture.userId])).not.toBeNull();
	});
});

describe("list_members", () => {
	/** Put the roster capability on both halves the door checks: the version and the installation. */
	async function grant_roster(
		t: ReturnType<typeof test_convex>,
		fixture: Awaited<ReturnType<typeof seed_user_write_door>>,
		args: { onlyRoster?: boolean } = {},
	) {
		const capabilities = (
			args.onlyRoster
				? ["workspace.members.read"]
				: ["plugin.data.read", "plugin.data.write", "plugin.data.user-write", "workspace.members.read"]
		) satisfies plugins_Capability[];
		await t.run(async (ctx) => {
			await ctx.db.patch("plugins_versions", fixture.pluginVersionId, { capabilities });
			await ctx.db.patch("plugins_workspace_installations", fixture.installationId, {
				acceptedCapabilities: capabilities,
			});
		});
	}

	test("an installation that never accepted the capability is refused, and the refusal is not an empty roster", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t);

		// The seed accepts every data capability and not this one, which is the state every installed
		// plugin is in until an admin accepts the upgraded list.
		expect(await fixture.asPage.query(api.plugins_data.list_members, { limit: 50 })).toEqual({
			refusal: "not_consented",
		});

		// The same call after the workspace accepts it answers the roster. So the refusal above came
		// from the consent alone, and a page can tell "nobody granted this yet" from "this workspace
		// has one member" — an empty roster for both would have hidden the consent from the admin.
		await grant_roster(t, fixture);
		expect(await fixture.asPage.query(api.plugins_data.list_members, { limit: 50 })).toEqual({
			members: [{ userId: fixture.userId, displayName: null }],
			cursor: null,
		});
	});

	test("the roster is its own consent and does not ride on plugin data read", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t);
		// A plugin that stores nothing and only shows a member picker declares this one capability.
		// If the roster were gated on the data-read door as well, such a plugin would have to ask a
		// workspace for access to a store it never writes to.
		await grant_roster(t, fixture, { onlyRoster: true });

		expect(await fixture.asPage.query(api.plugins_data.list_members, { limit: 50 })).toEqual({
			members: [{ userId: fixture.userId, displayName: null }],
			cursor: null,
		});
		// The data doors are shut for that same session, so the two consents really are separate.
		expect(
			await fixture.asPage.query(api.plugins_data.watch_documents, { collection: "messages", limit: 10 }),
		).toBeNull();
	});

	test("lists every live member of this workspace with a name and nothing else, one page at a time", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t);
		await grant_roster(t, fixture);
		const second = await join_member_with_role(t, fixture, { clerkUserId: "roster-second", role: "member" });
		const third = await join_member_with_role(t, fixture, { clerkUserId: "roster-third", role: "member" });
		// A live member of another workspace only. Enumeration must stay inside this workspace.
		const outsider = await seed_user_write_door(t, {
			organizationName: "roster-outside-org",
			clerkUserId: "roster-outsider",
		});
		// The fixtures skip the sign-in bootstrap that writes anagraphics, so store the names directly.
		// `third` gets none, which is what an anonymous or half-onboarded member looks like.
		await t.run(async (ctx) => {
			const now = Date.now();
			for (const [userId, displayName] of [
				[fixture.userId, "Door Owner"],
				[second.userId, "Second Member"],
				[outsider.userId, "Outside Person"],
			] as const) {
				const anagraphicId = await ctx.db.insert("users_anagraphics", {
					userId,
					displayName,
					email: "someone@example.com",
					updatedAt: now,
				});
				await ctx.db.patch("users", userId, { anagraphic: anagraphicId });
			}
		});

		const firstPage = await fixture.asPage.query(api.plugins_data.list_members, { limit: 2 });
		expect(firstPage?.members).toHaveLength(2);
		expect(firstPage?.cursor).not.toBeNull();
		const secondPage = await fixture.asPage.query(api.plugins_data.list_members, {
			limit: 2,
			cursor: firstPage?.cursor,
		});
		// The last page says so with a null cursor, so a caller following it stops instead of asking
		// for the same empty page forever.
		expect(secondPage?.cursor).toBeNull();

		// The index orders by user id, which carries no meaning, so compare the union by name.
		const rows = [...(firstPage?.members ?? []), ...(secondPage?.members ?? [])];
		expect([...rows].map((row) => row.displayName).sort()).toEqual(["Door Owner", "Second Member", null]);
		expect(rows.map((row) => row.userId).sort()).toEqual([fixture.userId, second.userId, third.userId].sort());
		// A row carries two fields. The obvious app-side member helper answers the whole anagraphic
		// document, email included, and a plugin frame may post whatever it reads to the publisher's
		// own origin — so pin the field set, not just the values.
		for (const row of rows) {
			expect(Object.keys(row).sort()).toEqual(["displayName", "userId"]);
		}
	});

	test("a member who signed in anonymously reads the roster like anyone else", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t);
		await grant_roster(t, fixture);
		const anonymous = await join_member_with_role(t, fixture, { clerkUserId: "roster-anon", role: "member" });
		// An anonymous identity is a normal user doc with no Clerk id. `mint_page_session` resolves
		// one for a visitor with no session, so a page session for such a user is an ordinary state.
		await t.run(async (ctx) => {
			await ctx.db.patch("users", anonymous.userId, { clerkUserId: null });
		});

		// One rule for every invited member: an anonymous member reads the same roster a Clerk-backed
		// one does. This is a deliberate exposure, recorded in the plugin-system skill.
		const roster = await anonymous.asPage.query(api.plugins_data.list_members, { limit: 50 });
		expect(roster?.members?.map((row) => row.userId).sort()).toEqual([fixture.userId, anonymous.userId].sort());
	});

	test("throws with no auth identity and answers null for denials and bad input", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t);
		await grant_roster(t, fixture);

		await expect(t.query(api.plugins_data.list_members, { limit: 10 })).rejects.toThrow(/Unauthenticated/);

		// A version that stopped declaring the capability refuses the same way an unaccepted
		// installation does. Both halves must say yes on every call, and the page has one thing to
		// show either way: this plugin cannot read the member list here.
		await t.run(async (ctx) => {
			await ctx.db.patch("plugins_versions", fixture.pluginVersionId, {
				capabilities: ["plugin.data.read"] satisfies plugins_Capability[],
			});
		});
		expect(await fixture.asPage.query(api.plugins_data.list_members, { limit: 10 })).toEqual({
			refusal: "not_consented",
		});
		await grant_roster(t, fixture);

		// A dead session is a null, not a refusal: nobody can accept their way out of it.
		await t.run(async (ctx) => {
			await ctx.db.patch("plugins_ui_sessions", fixture.sessionId, { expiresAt: Date.now() - 1 });
		});
		expect(await fixture.asPage.query(api.plugins_data.list_members, { limit: 10 })).toBeNull();
		await t.run(async (ctx) => {
			await ctx.db.patch("plugins_ui_sessions", fixture.sessionId, { expiresAt: Date.now() + 30 * 60 * 1000 });
		});

		expect(await fixture.asPage.query(api.plugins_data.list_members, { limit: 0 })).toBeNull();
		expect(await fixture.asPage.query(api.plugins_data.list_members, { limit: 101 })).toBeNull();
		// The same call inside the ceiling answers, so the refusals above came from the input alone.
		expect(await fixture.asPage.query(api.plugins_data.list_members, { limit: 100 })).not.toBeNull();
	});
});

describe("storage-layer ownership", () => {
	test("refuses changing another member's owned doc through every interactive writer", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t);
		const other = await join_member_with_role(t, fixture, { clerkUserId: "owned-doc-outsider", role: "member" });

		const appended = await fixture.asPage.mutation(api.plugins_data.user_append_document, {
			collection: "messages",
			value: { text: "mine" },
			clientRequestId: "owned-1",
		});
		if (appended._nay) {
			throw new Error(appended._nay.message);
		}
		const key = appended._yay.key;

		// The storage layer judges the actor, not the route: an API key, a plugin run, and a service
		// grant acting for someone else are all refused on the member's owned doc.
		for (const kind of ["user_api_key", "plugin_run", "plugin_service"] as const) {
			const written = await t.mutation(internal.plugins_data.write_document, {
				principal: store_principal(fixture, { kind, actorUserId: other.userId }),
				collection: "messages",
				key,
				value: { text: "overwritten" },
			});
			expect(written._nay?.message).toBe("This document belongs to another writer");
		}
		const batched = await t.mutation(internal.plugins_data.write_documents_batch, {
			principal: store_principal(fixture, { kind: "user_api_key", actorUserId: other.userId }),
			documents: [
				{ collection: "messages", key: "fresh", value: { n: 1 } },
				{ collection: "messages", key, value: { text: "overwritten" } },
			],
		});
		expect(batched._nay?.message).toBe("This document belongs to another writer");
		const removed = await t.mutation(internal.plugins_data.delete_document, {
			principal: store_principal(fixture, { kind: "user_api_key", actorUserId: other.userId }),
			collection: "messages",
			key,
		});
		expect(removed._nay?.message).toBe("This document belongs to another writer");

		// The refused batch must not keep its valid sibling either.
		const documents = await read_documents(t, fixture);
		expect(documents).toHaveLength(1);
		expect(documents[0]).toMatchObject({ key, value: { text: "mine" }, ownership: "owned" });

		// The creator is the one actor an interactive writer may act for on this doc.
		const ownWrite = await t.mutation(internal.plugins_data.write_document, {
			principal: store_principal(fixture, { kind: "user_api_key", actorUserId: fixture.userId }),
			collection: "messages",
			key,
			value: { text: "edited by its creator" },
		});
		expect(ownWrite._nay).toBeUndefined();
		expect((await read_documents(t, fixture))[0]).toMatchObject({ value: { text: "edited by its creator" } });
	});
});

/** One member's share row. It is absent until that member's first charged write. */
async function read_member_usage(
	t: ReturnType<typeof test_convex>,
	fixture: Awaited<ReturnType<typeof seed_installation>>,
	userId: Id<"users">,
) {
	return await t.run(
		async (ctx) =>
			await ctx.db
				.query("plugins_data_member_usage")
				.withIndex("by_installation_user", (q) => q.eq("installationId", fixture.installationId).eq("userId", userId))
				.first(),
	);
}

/**
 * Move one member's stored counters straight to the numbers a case needs.
 *
 * The shares are big enough that reaching them with real writes would take a hundred documents per
 * case, so the seed stands in for that traffic. The installation-ceiling test patches
 * `plugins_data_usage` the same way.
 */
async function set_member_usage(
	t: ReturnType<typeof test_convex>,
	fixture: Awaited<ReturnType<typeof seed_installation>>,
	userId: Id<"users">,
	patch: { usedBytes?: number; usedDocuments?: number; machineBytes?: number },
) {
	await t.run(async (ctx) => {
		const row = await ctx.db
			.query("plugins_data_member_usage")
			.withIndex("by_installation_user", (q) => q.eq("installationId", fixture.installationId).eq("userId", userId))
			.first();
		await ctx.db.patch("plugins_data_member_usage", row!._id, patch);
	});
}

describe("db_patch_usage", () => {
	test("warns once when a write crosses 80% of a ceiling, on the aggregate and never on a refusal", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const principal = service_principal(fixture);

		// The first write creates the accounting doc the seeds below move.
		const seeded = await t.mutation(internal.plugins_data.write_document, {
			principal,
			collection: "meetings",
			key: "seed",
			value: { n: 1 },
		});
		expect(seeded._nay).toBeUndefined();

		const set_usage = async (patch: { usedBytes?: number; usedDocuments?: number; reservedDocuments?: number }) => {
			await t.run(async (ctx) => {
				const usage = await ctx.db
					.query("plugins_data_usage")
					.withIndex("by_installation", (q) => q.eq("installationId", fixture.installationId))
					.first();
				await ctx.db.patch("plugins_data_usage", usage!._id, patch);
			});
		};

		// One slot below the 8,000 threshold on the aggregate the store refuses on, with
		// `usedDocuments` far below it on its own. A threshold over the stored halves alone would
		// never fire for a producer filling the store through reservations, and those are the doors
		// that fill it fastest.
		await set_usage({ usedDocuments: 1, reservedDocuments: 7_998, usedBytes: 16 * 1024 * 1024 });

		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			// This write would cross the slot threshold, and it is refused for bytes. The comparison
			// runs on the transaction that commits, so a refused write says nothing — and neither does
			// an optimistic-concurrency retry of one.
			const refused = await t.mutation(internal.plugins_data.write_document, {
				principal,
				collection: "meetings",
				key: "refused",
				value: { n: 2 },
			});
			expect(refused._nay?.name).toBe("storage_full");
			expect(warn).toHaveBeenCalledTimes(0);

			await set_usage({ usedBytes: 100 });
			const crossing = await t.mutation(internal.plugins_data.write_document, {
				principal,
				collection: "meetings",
				key: "crossing",
				value: { n: 3 },
			});
			expect(crossing._nay).toBeUndefined();
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn.mock.calls[0]?.[0]).toBe("A plugin installation passed 80% of a storage ceiling");

			// Above the threshold the installation is already known to be filling up. A line per write
			// from here on is volume, not signal.
			const above = await t.mutation(internal.plugins_data.write_document, {
				principal,
				collection: "meetings",
				key: "above",
				value: { n: 4 },
			});
			expect(above._nay).toBeUndefined();
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			warn.mockRestore();
		}
	});
});

describe("per-member capacity", () => {
	test("refuses a member at their byte share and at their slot share while another member still writes", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t);
		const memberB = await join_member_with_role(t, fixture, { clerkUserId: "share-member-b", role: "member" });

		const append = async (asPage: typeof fixture.asPage, clientRequestId: string) =>
			await asPage.mutation(api.plugins_data.user_append_document, {
				collection: "messages",
				value: { text: "hello" },
				clientRequestId,
			});

		// The first append from each member creates the row the seeds below fill.
		expect((await append(fixture.asPage, "a-1"))._nay).toBeUndefined();
		expect((await append(memberB.asPage, "b-1"))._nay).toBeUndefined();

		await set_member_usage(t, fixture, fixture.userId, { usedBytes: 1600 * 1024 });
		const overBytes = await append(fixture.asPage, "a-2");
		expect(overBytes._nay?.name).toBe("storage_full");
		expect(overBytes._nay?.message).toBe("You have used your 1.6 MiB share of this plugin's storage");
		// One member's full share must not stop the workspace, which is the whole reason the share
		// exists: B is inside their own and keeps writing.
		expect((await append(memberB.asPage, "b-2"))._nay).toBeUndefined();

		// The slot share is a separate ceiling. Without it a member holding almost no bytes can still
		// spend every slot in the installation.
		await set_member_usage(t, fixture, fixture.userId, { usedBytes: 0, usedDocuments: 3_000 });
		const overSlots = await append(fixture.asPage, "a-3");
		expect(overSlots._nay?.name).toBe("storage_full");
		expect(overSlots._nay?.message).toBe("You have used your 3000 document slots in this plugin");
		expect((await append(memberB.asPage, "b-3"))._nay).toBeUndefined();

		// Both refusals carry the same name and the route maps both to 403, so the message is the only
		// thing that tells a member "you are full" from "the plugin is full".
		await set_member_usage(t, fixture, fixture.userId, { usedBytes: 0, usedDocuments: 0 });
		await t.run(async (ctx) => {
			const usage = await ctx.db
				.query("plugins_data_usage")
				.withIndex("by_installation", (q) => q.eq("installationId", fixture.installationId))
				.first();
			await ctx.db.patch("plugins_data_usage", usage!._id, { usedBytes: 16 * 1024 * 1024 });
		});
		const installationFull = await append(fixture.asPage, "a-4");
		expect(installationFull._nay?.name).toBe("storage_full");
		expect(installationFull._nay?.message).toBe("This plugin has used its 16 MiB of storage");
		expect(installationFull._nay?.message).not.toBe(overBytes._nay?.message);
	});

	test("moves the bytes and the slot onto the member who takes a shared document over", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t);
		const memberB = await join_member_with_role(t, fixture, { clerkUserId: "transfer-member-b", role: "member" });

		// A holds two documents: one owned message and one shared channel any member may rename.
		const appended = await fixture.asPage.mutation(api.plugins_data.user_append_document, {
			collection: "messages",
			value: value_of_bytes(100),
			clientRequestId: "transfer-1",
		});
		if (appended._nay) {
			throw new Error(appended._nay.message);
		}
		const created = await fixture.asPage.mutation(api.plugins_data.user_put_document, {
			collection: "channels",
			key: "general",
			value: value_of_bytes(100),
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		expect(await read_member_usage(t, fixture, fixture.userId)).toMatchObject({ usedBytes: 200, usedDocuments: 2 });

		// B renames the shared channel. The whole document moves: A is credited the old bytes and the
		// slot, B is charged the new bytes and the slot. Leaving the slot on A would let a member keep
		// moving slots onto themselves by patching documents somebody else created.
		const renamed = await memberB.asPage.mutation(api.plugins_data.user_put_document, {
			collection: "channels",
			key: "general",
			value: value_of_bytes(300),
		});
		if (renamed._nay) {
			throw new Error(renamed._nay.message);
		}
		expect(await read_member_usage(t, fixture, fixture.userId)).toMatchObject({ usedBytes: 100, usedDocuments: 1 });
		expect(await read_member_usage(t, fixture, memberB.userId)).toMatchObject({ usedBytes: 300, usedDocuments: 1 });
	});

	test("deletes a member's share row once they hold nothing, at every door that attributes", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t);

		const appended = await fixture.asPage.mutation(api.plugins_data.user_append_document, {
			collection: "messages",
			value: { text: "hello" },
			clientRequestId: "row-life-1",
		});
		if (appended._nay) {
			throw new Error(appended._nay.message);
		}
		expect(await read_member_usage(t, fixture, fixture.userId)).toMatchObject({ usedDocuments: 1 });

		// A stored zero would keep one row per member who ever wrote, so the table would grow with
		// churn and a departed member would leave an id behind for nothing.
		const removed = await fixture.asPage.mutation(api.plugins_data.user_remove_document, {
			collection: "messages",
			key: appended._yay.key,
		});
		if (removed._nay) {
			throw new Error(removed._nay.message);
		}
		expect(await read_member_usage(t, fixture, fixture.userId)).toBeNull();

		// The API-key doors attribute too, so they must give the same row back.
		const written = await t.mutation(internal.plugins_data.write_document, {
			principal: store_principal(fixture, { kind: "user_api_key" }),
			collection: "meetings",
			key: "by-key",
			value: { n: 1 },
		});
		expect(written._nay).toBeUndefined();
		expect(await read_member_usage(t, fixture, fixture.userId)).toMatchObject({ usedDocuments: 1 });

		const deleted = await t.mutation(internal.plugins_data.delete_document, {
			principal: store_principal(fixture, { kind: "user_api_key" }),
			collection: "meetings",
			key: "by-key",
		});
		expect(deleted._nay).toBeUndefined();
		expect(await read_member_usage(t, fixture, fixture.userId)).toBeNull();
	});

	test("credits nothing for a member whose row the prune already deleted", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t);

		const appended = await fixture.asPage.mutation(api.plugins_data.user_append_document, {
			collection: "messages",
			value: { text: "hello" },
			clientRequestId: "departed-1",
		});
		if (appended._nay) {
			throw new Error(appended._nay.message);
		}

		// What removing the member from the organization leaves behind: the share row is gone, and the
		// documents they composed stay in the workspace still naming them in `chargedTo`.
		await t.run(async (ctx) => {
			const row = await ctx.db
				.query("plugins_data_member_usage")
				.withIndex("by_installation_user", (q) =>
					q.eq("installationId", fixture.installationId).eq("userId", fixture.userId),
				)
				.first();
			await ctx.db.delete("plugins_data_member_usage", row!._id);
		});

		const removed = await fixture.asPage.mutation(api.plugins_data.user_remove_document, {
			collection: "messages",
			key: appended._yay.key,
		});
		if (removed._nay) {
			throw new Error(removed._nay.message);
		}

		// The credit finds no row and does nothing. Creating one would store a negative share against a
		// user who has left, and the next member to write would read it as free space.
		expect(await read_member_usage(t, fixture, fixture.userId)).toBeNull();
	});

	test("refuses an API key over its owner's byte share and keeps another member's key writing", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t);
		const memberB = await join_member_with_role(t, fixture, { clerkUserId: "key-member-b", role: "member" });
		const keyA = await fixture.asUser.mutation(api.public_api.api_credential_create, {
			membershipId: fixture.membershipId,
			name: "Member A key",
			scopes: ["plugin_data:write"],
		});
		const keyB = await memberB.asUser.mutation(api.public_api.api_credential_create, {
			membershipId: memberB.membershipId,
			name: "Member B key",
			scopes: ["plugin_data:write"],
		});
		if (keyA._nay || keyB._nay) {
			throw new Error(keyA._nay?.message ?? keyB._nay!.message);
		}

		const batch = async (credential: string, key: string) =>
			await t.fetch("/api/v1/plugin-data/write-batch", {
				method: "POST",
				headers: service_headers(credential),
				body: JSON.stringify({
					installationId: fixture.installationId,
					documents: [{ collection: "meetings", key, value: { n: 1 } }],
				}),
			});

		// The first batch creates A's share row, which the seed below fills.
		expect((await batch(keyA._yay.credential, "a-1")).status).toBe(200);
		await set_member_usage(t, fixture, fixture.userId, { usedBytes: 1600 * 1024 });

		// A key writes as the member who minted it, and this door fills the store about seventeen
		// times faster than the frame door, so the share has to bind here too.
		const refused = await batch(keyA._yay.credential, "a-2");
		expect(refused.status).toBe(403);
		expect(await refused.json()).toEqual({
			message: "You have used your 1.6 MiB share of this plugin's storage",
		});
		expect((await batch(keyB._yay.credential, "b-1")).status).toBe(200);
	});

	test("holds a member to eight collections at both doors and gives one back when a collection empties", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t);
		const memberB = await join_member_with_role(t, fixture, { clerkUserId: "collections-member-b", role: "member" });
		const keyA = await fixture.asUser.mutation(api.public_api.api_credential_create, {
			membershipId: fixture.membershipId,
			name: "Member A key",
			scopes: ["plugin_data:write"],
		});
		if (keyA._nay) {
			throw new Error(keyA._nay.message);
		}

		// The frame write bucket holds ten tokens, and this case spends more than that, so the clock
		// moves on its own instead of waiting for a real refill.
		const base = Date.now();
		const clock = vi.spyOn(Date, "now").mockReturnValue(base);
		try {
			const put = async (asPage: typeof fixture.asPage, collection: string) =>
				await asPage.mutation(api.plugins_data.user_put_document, {
					collection,
					key: "only",
					value: { n: 1 },
				});

			// A member's list holds the collections they introduced to the installation. Eight is half
			// of the installation's sixteen, so one member cannot pin them all and a plugin still has
			// room to add one later.
			for (let index = 0; index < 8; index += 1) {
				expect((await put(fixture.asPage, `a${index}`))._nay).toBeUndefined();
			}
			const ninth = await put(fixture.asPage, "a8");
			expect(ninth._nay?.name).toBe("storage_full");
			expect(ninth._nay?.message).toBe("You can create at most 8 collections in this plugin");

			// The batch door computes its collections independently, so one body naming new collections
			// would pin the installation there with the member's row recording none.
			const overBatch = await t.fetch("/api/v1/plugin-data/write-batch", {
				method: "POST",
				headers: service_headers(keyA._yay.credential),
				body: JSON.stringify({
					installationId: fixture.installationId,
					documents: [{ collection: "a8", key: "only", value: { n: 1 } }],
				}),
			});
			expect(overBatch.status).toBe(403);
			expect(await overBatch.json()).toEqual({ message: "You can create at most 8 collections in this plugin" });

			// The share is per member, not per installation: B has introduced none and the installation
			// still holds eight of its sixteen.
			expect((await put(memberB.asPage, "b0"))._nay).toBeUndefined();
			expect(await read_member_usage(t, fixture, fixture.userId)).toMatchObject({
				collectionNames: ["a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7"],
			});

			clock.mockReturnValue(base + 60_000);

			// Emptying a collection drops it from the installation's list, and the member lists have to
			// shrink with it. Otherwise a member who created a collection and then emptied it spends
			// that share slot forever.
			const removed = await fixture.asPage.mutation(api.plugins_data.user_remove_document, {
				collection: "a0",
				key: "only",
			});
			if (removed._nay) {
				throw new Error(removed._nay.message);
			}
			expect(await read_usage(t, fixture)).toMatchObject({
				collectionNames: ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "b0"],
			});
			expect(await read_member_usage(t, fixture, fixture.userId)).toMatchObject({
				collectionNames: ["a1", "a2", "a3", "a4", "a5", "a6", "a7"],
			});
			expect((await put(fixture.asPage, "a9"))._nay).toBeUndefined();
		} finally {
			clock.mockRestore();
		}
	});

	test("keeps a plugin backend's bytes out of the member's own share, at both doors", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t);
		const granted = await mint_service_grant(t, fixture);
		const keyA = await fixture.asUser.mutation(api.public_api.api_credential_create, {
			membershipId: fixture.membershipId,
			name: "Member A key",
			scopes: ["plugin_data:write"],
		});
		if (granted._nay || keyA._nay) {
			throw new Error(granted._nay?.message ?? keyA._nay!.message);
		}

		const put = async (key: string, byteSize: number) =>
			await fixture.asPage.mutation(api.plugins_data.user_put_document, {
				collection: "channels",
				key,
				value: value_of_bytes(byteSize),
			});

		for (const key of ["c0", "c1", "c2"]) {
			expect((await put(key, 100))._nay).toBeUndefined();
		}
		expect(await read_member_usage(t, fixture, fixture.userId)).toMatchObject({
			usedBytes: 300,
			machineBytes: 0,
			usedDocuments: 3,
		});

		// A backend may patch any shared document a member created, and every patch is accepted:
		// refusing one because some member is at their share would let one member block the whole
		// plugin. So the bytes it writes must not count against that member instead.
		for (const key of ["c0", "c1", "c2"]) {
			const grown = await t.fetch("/api/v1/plugin-data/write", {
				method: "POST",
				headers: service_headers(granted._yay.token),
				body: JSON.stringify({ collection: "channels", key, value: value_of_bytes(16 * 1024) }),
			});
			expect([key, grown.status]).toEqual([key, 200]);
		}
		expect(await read_member_usage(t, fixture, fixture.userId)).toMatchObject({
			usedBytes: 3 * 16 * 1024,
			machineBytes: 3 * 16 * 1024,
			usedDocuments: 3,
		});
		const stored = await read_documents(t, fixture);
		expect(stored.find((document) => document.key === "c0")).toMatchObject({
			chargedTo: fixture.userId,
			machineBytes: 16 * 1024,
		});

		// The same shape after the hundred documents it would really take to cross the share. The seed
		// stands in for that traffic; every byte in it was written by the backend.
		await set_member_usage(t, fixture, fixture.userId, {
			usedBytes: 3 * 16 * 1024 + 1600 * 1024,
			machineBytes: 3 * 16 * 1024 + 1600 * 1024,
		});

		// A composed none of those bytes, so both doors still take A's own writes. The comparison lives
		// inside `check_capacity`, which is exactly why one edit has to serve both call sites.
		expect((await put("mine", 100))._nay).toBeUndefined();
		const batched = await t.fetch("/api/v1/plugin-data/write-batch", {
			method: "POST",
			headers: service_headers(keyA._yay.credential),
			body: JSON.stringify({
				installationId: fixture.installationId,
				documents: [{ collection: "channels", key: "mine-by-key", value: { n: 1 } }],
			}),
		});
		expect(batched.status).toBe(200);

		// The share still binds for the bytes A did compose.
		await set_member_usage(t, fixture, fixture.userId, { usedBytes: 1600 * 1024, machineBytes: 0 });
		const refused = await put("mine-2", 100);
		expect(refused._nay?.name).toBe("storage_full");
		expect(refused._nay?.message).toBe("You have used your 1.6 MiB share of this plugin's storage");
	});

	test("keeps a member's own bytes exact when a machine-grown document shrinks, moves, or is deleted", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t);
		const memberB = await join_member_with_role(t, fixture, { clerkUserId: "machine-member-b", role: "member" });
		const granted = await mint_service_grant(t, fixture);
		if (granted._nay) {
			throw new Error(granted._nay.message);
		}

		const grow = async (key: string) =>
			await t.fetch("/api/v1/plugin-data/write", {
				method: "POST",
				headers: service_headers(granted._yay.token),
				body: JSON.stringify({ collection: "channels", key, value: value_of_bytes(16 * 1024) }),
			});

		// Shrink. A writes 100 bytes, a backend grows the document, and A rewrites it small again. A
		// composed the value that is stored now, so A holds exactly those 100 bytes — not a share
		// inflated by what the backend wrote, and not a negative number.
		expect(
			(
				await fixture.asPage.mutation(api.plugins_data.user_put_document, {
					collection: "channels",
					key: "c0",
					value: value_of_bytes(100),
				})
			)._nay,
		).toBeUndefined();
		expect((await grow("c0")).status).toBe(200);
		expect(
			(
				await fixture.asPage.mutation(api.plugins_data.user_put_document, {
					collection: "channels",
					key: "c0",
					value: value_of_bytes(100),
				})
			)._nay,
		).toBeUndefined();
		expect(await read_member_usage(t, fixture, fixture.userId)).toMatchObject({ usedBytes: 100, machineBytes: 0 });
		expect(
			(
				await memberB.asPage.mutation(api.plugins_data.user_put_document, {
					collection: "channels",
					key: "b0",
					value: value_of_bytes(100),
				})
			)._nay,
		).toBeUndefined();
		// A member no backend ever touched holds the same own-bytes for the same value.
		expect(await read_member_usage(t, fixture, memberB.userId)).toMatchObject({ usedBytes: 100, machineBytes: 0 });

		// Transfer. The backend grows A's document again and B renames it. B is charged only what B
		// wrote, and A keeps nothing of it: the machine share is zeroed by B's own write instead of
		// following the document onto B.
		expect((await grow("c0")).status).toBe(200);
		expect(
			(
				await memberB.asPage.mutation(api.plugins_data.user_put_document, {
					collection: "channels",
					key: "c0",
					value: value_of_bytes(200),
				})
			)._nay,
		).toBeUndefined();
		// A's row survives with zeroed counters because A introduced `channels` and the installation
		// still holds it. The collection name is what A is still charged for, not the bytes.
		expect(await read_member_usage(t, fixture, fixture.userId)).toMatchObject({
			usedBytes: 0,
			machineBytes: 0,
			usedDocuments: 0,
			collectionNames: ["channels"],
		});
		expect(await read_member_usage(t, fixture, memberB.userId)).toMatchObject({
			usedBytes: 300,
			machineBytes: 0,
			usedDocuments: 2,
		});

		// Delete. A inserts and removes documents no backend ever touched, so there is no machine
		// share to credit back and the counter never goes below zero.
		const appended = await fixture.asPage.mutation(api.plugins_data.user_append_document, {
			collection: "messages",
			value: value_of_bytes(100),
			clientRequestId: "machine-delete-1",
		});
		if (appended._nay) {
			throw new Error(appended._nay.message);
		}
		expect(await read_member_usage(t, fixture, fixture.userId)).toMatchObject({ usedBytes: 100, machineBytes: 0 });
		const removed = await fixture.asPage.mutation(api.plugins_data.user_remove_document, {
			collection: "messages",
			key: appended._yay.key,
		});
		if (removed._nay) {
			throw new Error(removed._nay.message);
		}
		expect(await read_member_usage(t, fixture, fixture.userId)).toMatchObject({
			usedBytes: 0,
			machineBytes: 0,
			usedDocuments: 0,
			collectionNames: ["channels"],
		});
	});

	test("charges no member for a plugin backend's write", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t);
		const granted = await mint_service_grant(t, fixture);
		if (granted._nay) {
			throw new Error(granted._nay.message);
		}

		// The grant carries the member whose page token was exchanged for it, and that field is kept
		// for audit only. Charging by it would bill a whole backend projection to one member and lock
		// them out of a plugin every other member keeps writing to.
		const written = await t.fetch("/api/v1/plugin-data/write", {
			method: "POST",
			headers: service_headers(granted._yay.token),
			body: JSON.stringify({ collection: "meetings", key: "projection", value: { n: 1 } }),
		});
		expect(written.status).toBe(200);

		const stored = await read_documents(t, fixture);
		expect(stored[0]).toMatchObject({ key: "projection", machineBytes: 7 });
		expect(stored[0]?.chargedTo).toBeUndefined();
		expect(await read_member_usage(t, fixture, fixture.userId)).toBeNull();
	});
});

/**
 * Fill every one of the six installation-owned tables: a stored document, a live reservation, a
 * released reservation, a revision tombstone, a service grant, one member share row, and the
 * accounting doc they share.
 */
async function seed_full_store(
	t: ReturnType<typeof test_convex>,
	fixture: Awaited<ReturnType<typeof seed_installation>>,
) {
	const principal = service_principal(fixture);
	await t.mutation(internal.plugins_data.write_document, {
		principal: store_principal(fixture),
		collection: "meetings",
		key: "kept",
		value: { n: 1 },
	});
	// An API key writes as the member who minted it, so this is the one write in the seed that
	// creates a per-member usage row. Without it the drain's member pass has nothing to delete.
	await t.mutation(internal.plugins_data.write_document, {
		principal: store_principal(fixture, { kind: "user_api_key" }),
		collection: "meetings",
		key: "charged",
		value: { n: 2 },
	});
	await t.mutation(internal.plugins_data.reserve_document, {
		principal,
		collection: "meetings",
		key: "reserved",
		maximumBytes: 1000,
		idempotencyKey: "reserve-live",
		expiresAt: Date.now() + 60_000,
	});
	await t.mutation(internal.plugins_data.reserve_document, {
		principal,
		collection: "meetings",
		key: "released",
		maximumBytes: 1000,
		idempotencyKey: "reserve-released",
		expiresAt: Date.now() + 60_000,
	});
	await t.mutation(internal.plugins_data.release_reservation, {
		principal,
		collection: "meetings",
		key: "released",
		idempotencyKey: "reserve-released",
	});
	await t.mutation(internal.plugins_data.write_versioned_document, {
		principal,
		collection: "meetings",
		key: "gone",
		revision: 1,
		value: { n: 1 },
	});
	await t.mutation(internal.plugins_data.delete_versioned_document, {
		principal,
		collection: "meetings",
		key: "gone",
		revision: 2,
	});
	await mint_service_grant(t, fixture);
}

/** Read the six installation-owned tables at once, so a deletion test can assert every one is empty. */
async function read_all_store_tables(
	t: ReturnType<typeof test_convex>,
	fixture: Awaited<ReturnType<typeof seed_installation>>,
) {
	return await t.run(async (ctx) => {
		const [documents, reservations, tombstones, usage, memberUsage, grants] = await Promise.all([
			ctx.db
				.query("plugins_data")
				.withIndex("by_installation_collection_key", (q) => q.eq("installationId", fixture.installationId))
				.collect(),
			ctx.db
				.query("plugins_data_reservations")
				.withIndex("by_installation_state_collection_key", (q) => q.eq("installationId", fixture.installationId))
				.collect(),
			ctx.db
				.query("plugins_data_revision_tombstones")
				.withIndex("by_installation_collection_key", (q) => q.eq("installationId", fixture.installationId))
				.collect(),
			ctx.db
				.query("plugins_data_usage")
				.withIndex("by_installation", (q) => q.eq("installationId", fixture.installationId))
				.collect(),
			ctx.db
				.query("plugins_data_member_usage")
				.withIndex("by_installation_user", (q) => q.eq("installationId", fixture.installationId))
				.collect(),
			ctx.db
				.query("plugin_service_grants")
				.withIndex("by_organization_workspace_installation", (q) =>
					q
						.eq("organizationId", fixture.organizationId)
						.eq("workspaceId", fixture.workspaceId)
						.eq("installationId", fixture.installationId),
				)
				.collect(),
		]);
		return {
			documents: documents.length,
			reservations: reservations.length,
			revisionTombstones: tombstones.length,
			usage: usage.length,
			memberUsage: memberUsage.length,
			serviceGrants: grants.length,
		};
	});
}

/** Call the drain until it reports `done`, the way the scheduler would. */
async function drain_until_done(
	t: ReturnType<typeof test_convex>,
	fixture: Awaited<ReturnType<typeof seed_installation>>,
) {
	let passes = 0;
	for (;;) {
		const drained = await t.mutation(internal.plugins_data.drain_uninstalled_installation, {
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			installationId: fixture.installationId,
			_test_disableReschedule: true,
		});
		passes += 1;
		if (drained.done) {
			return passes;
		}

		if (passes > 20) {
			throw new Error("The drain never finished");
		}
	}
}

describe("plugins_data_db_drain_batch", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	test("uninstalling a plugin leaves all six of its tables empty", async () => {
		const t = test_convex();
		// The drain runs on the scheduler and reschedules itself, so the test needs fake timers to
		// walk that chain to its end.
		vi.useFakeTimers();
		const fixture = await seed_installation_with_key_owner(t, "clerk-uninstall-drain");
		await seed_full_store(t, fixture);
		expect(await read_all_store_tables(t, fixture)).toEqual({
			documents: 2,
			reservations: 2,
			revisionTombstones: 1,
			usage: 1,
			memberUsage: 1,
			serviceGrants: 1,
		});

		const uninstalled = await fixture.asUser.mutation(api.plugins.uninstall_version, {
			membershipId: fixture.membershipId,
			installationId: fixture.installationId,
		});
		if (uninstalled._nay) {
			throw new Error(uninstalled._nay.message);
		}
		// Uninstall deletes the installation doc in its own transaction and schedules the drain with the
		// scope it captured. This runs that whole rescheduling chain to its end.
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		expect(await read_all_store_tables(t, fixture)).toEqual({
			documents: 0,
			reservations: 0,
			revisionTombstones: 0,
			usage: 0,
			memberUsage: 0,
			serviceGrants: 0,
		});
	});

	test("deletes at most one batch per pass and keeps going until nothing is left", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const principal = service_principal(fixture);
		for (let index = 0; index < 5; index += 1) {
			await t.mutation(internal.plugins_data.write_document, {
				principal,
				collection: "meetings",
				key: `meeting-${index}`,
				value: { n: index },
			});
		}

		// Five documents, one usage doc, and no other rows: one pass for the documents, one for the
		// usage doc, and one that finds nothing left.
		const passes = await drain_until_done(t, fixture);
		expect(passes).toBe(3);
		expect(await read_all_store_tables(t, fixture)).toEqual({
			documents: 0,
			reservations: 0,
			revisionTombstones: 0,
			usage: 0,
			memberUsage: 0,
			serviceGrants: 0,
		});
	});

	test("never deletes more than one batch in a single pass", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);

		// One pass is one transaction, so it has to stay bounded however much the plugin stored. A full
		// store holds far more documents than a transaction may read, so a pass that took them all would
		// fail on exactly the installations that most need draining.
		await t.run(async (ctx) => {
			const now = Date.now();
			for (let index = 0; index < 150; index += 1) {
				await ctx.db.insert("plugins_data", {
					organizationId: fixture.organizationId,
					workspaceId: fixture.workspaceId,
					installationId: fixture.installationId,
					pluginName: "council",
					collection: "meetings",
					key: `meeting-${index}`,
					value: { n: index },
					byteSize: 9,
					revision: 1,
					writeMode: "normal",
					ownership: "shared",
					createdBy: fixture.userId,
					updatedBy: fixture.userId,
					updatedAt: now,
				});
			}
		});

		const firstPass = await t.mutation(internal.plugins_data.drain_uninstalled_installation, {
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			installationId: fixture.installationId,
			_test_disableReschedule: true,
		});
		expect(firstPass).toEqual({ done: false, deletedCount: 100 });
		expect(await read_documents(t, fixture)).toHaveLength(50);

		// The rest still goes, one bounded pass at a time.
		expect(await drain_until_done(t, fixture)).toBe(2);
		expect(await read_all_store_tables(t, fixture)).toEqual({
			documents: 0,
			reservations: 0,
			revisionTombstones: 0,
			usage: 0,
			memberUsage: 0,
			serviceGrants: 0,
		});
	});

	test("drains only the named installation and leaves the other one in the same workspace alone", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const other = await t.run(async (ctx) => {
			const installationId = await ctx.db.insert("plugins_workspace_installations", {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				pluginVersionId: fixture.pluginVersionId,
				pluginName: "council-two",
				status: "enabled",
				configurationYaml: null,
				acceptedCapabilities: ["plugin.data.read", "plugin.data.write", "plugin.service.connect"],
				capabilitiesAcceptedAt: Date.now(),
				acceptedOutboundOrigins: [],
				acceptedUiOutboundOrigins: [],
				outboundOriginsAcceptedAt: Date.now(),
				installedBy: fixture.userId,
				updatedBy: fixture.userId,
				updatedAt: Date.now(),
			});
			return { ...fixture, installationId } as const;
		});
		await seed_full_store(t, fixture);
		await seed_full_store(t, other);
		expect(await read_all_store_tables(t, fixture)).toEqual({
			documents: 2,
			reservations: 2,
			revisionTombstones: 1,
			usage: 1,
			memberUsage: 1,
			serviceGrants: 1,
		});
		expect(await read_all_store_tables(t, other)).toEqual({
			documents: 2,
			reservations: 2,
			revisionTombstones: 1,
			usage: 1,
			memberUsage: 1,
			serviceGrants: 1,
		});

		await drain_until_done(t, fixture);

		expect(await read_all_store_tables(t, fixture)).toEqual({
			documents: 0,
			reservations: 0,
			revisionTombstones: 0,
			usage: 0,
			memberUsage: 0,
			serviceGrants: 0,
		});
		expect(await read_all_store_tables(t, other)).toEqual({
			documents: 2,
			reservations: 2,
			revisionTombstones: 1,
			usage: 1,
			memberUsage: 1,
			serviceGrants: 1,
		});
	});
});

describe("cleanup_expired_plugin_data", () => {
	test("releases a reservation its producer never released and gives the bytes back", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const principal = service_principal(fixture);
		const expiresAt = Date.now() + 60_000;

		await t.mutation(internal.plugins_data.reserve_document, {
			principal,
			collection: "meetings",
			key: "meeting-1",
			maximumBytes: 1000,
			idempotencyKey: "reserve-1",
			expiresAt,
		});
		expect(await read_usage(t, fixture)).toMatchObject({ reservedBytes: 1000, reservedDocuments: 1 });

		// The producer crashed; nothing releases this reservation but the cron.
		await t.run(async (ctx) => {
			const reservation = await ctx.db
				.query("plugins_data_reservations")
				.withIndex("by_installation_state_collection_key", (q) => q.eq("installationId", fixture.installationId))
				.first();
			await ctx.db.patch("plugins_data_reservations", reservation!._id, { expiresAt: Date.now() - 1 });
		});

		const released = await t.mutation(internal.plugins_data.cleanup_expired_plugin_data, {
			_test_disableReschedule: true,
		});
		expect(released).toEqual({ done: false, releasedCount: 1, deletedCount: 0 });

		expect(await read_usage(t, fixture)).toMatchObject({
			reservedBytes: 0,
			reservedDocuments: 0,
			// The row stays as the answer to a replayed release, and holds a slot until its horizon.
			tombstoneDocuments: 1,
			// The reservation was the only thing keeping this name alive, so the name goes too. A cron
			// release that kept it would let sixteen crashed producers exhaust the collection budget on
			// an installation that stores nothing, and no later call could take the name back.
			collectionNames: [],
		});
		const reservations = await read_reservations(t, fixture);
		expect(reservations[0]).toMatchObject({ state: "released", remainingBytes: 0 });

		// A second pass finds nothing to release, because the row is no longer live.
		expect(
			await t.mutation(internal.plugins_data.cleanup_expired_plugin_data, { _test_disableReschedule: true }),
		).toEqual({ done: true, releasedCount: 0, deletedCount: 0 });
	});

	test("deletes retry records, tombstones, and grants past their horizon and returns their slots", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const principal = service_principal(fixture);

		await t.mutation(internal.plugins_data.reserve_document, {
			principal,
			collection: "meetings",
			key: "released",
			maximumBytes: 1000,
			idempotencyKey: "reserve-1",
			expiresAt: Date.now() + 60_000,
		});
		await t.mutation(internal.plugins_data.release_reservation, {
			principal,
			collection: "meetings",
			key: "released",
			idempotencyKey: "reserve-1",
		});
		await t.mutation(internal.plugins_data.write_versioned_document, {
			principal,
			collection: "meetings",
			key: "gone",
			revision: 1,
			value: { n: 1 },
		});
		await t.mutation(internal.plugins_data.delete_versioned_document, {
			principal,
			collection: "meetings",
			key: "gone",
			revision: 2,
		});
		await mint_service_grant(t, fixture);
		expect(await read_usage(t, fixture)).toMatchObject({ tombstoneDocuments: 2 });

		// Move every horizon into the past, as if a day had gone by.
		await t.run(async (ctx) => {
			const past = Date.now() - 1;
			for (const reservation of await ctx.db.query("plugins_data_reservations").collect()) {
				await ctx.db.patch("plugins_data_reservations", reservation._id, { retryHorizonExpiresAt: past });
			}
			for (const tombstone of await ctx.db.query("plugins_data_revision_tombstones").collect()) {
				await ctx.db.patch("plugins_data_revision_tombstones", tombstone._id, { expiresAt: past });
			}
			for (const grant of await ctx.db.query("plugin_service_grants").collect()) {
				await ctx.db.patch("plugin_service_grants", grant._id, { expiresAt: past });
			}
		});

		expect(
			await t.mutation(internal.plugins_data.cleanup_expired_plugin_data, { _test_disableReschedule: true }),
		).toEqual({ done: false, releasedCount: 0, deletedCount: 1 });
		expect(await read_usage(t, fixture)).toMatchObject({ tombstoneDocuments: 1 });

		expect(
			await t.mutation(internal.plugins_data.cleanup_expired_plugin_data, { _test_disableReschedule: true }),
		).toEqual({ done: false, releasedCount: 0, deletedCount: 1 });
		// Both slots are back, so the store can hold new documents again.
		expect(await read_usage(t, fixture)).toMatchObject({ tombstoneDocuments: 0 });

		expect(
			await t.mutation(internal.plugins_data.cleanup_expired_plugin_data, { _test_disableReschedule: true }),
		).toEqual({ done: false, releasedCount: 0, deletedCount: 1 });

		expect(await read_all_store_tables(t, fixture)).toEqual({
			documents: 0,
			reservations: 0,
			revisionTombstones: 0,
			usage: 1,
			memberUsage: 0,
			serviceGrants: 0,
		});
	});

	test("expiring a converted-release retry does not return the revision tombstone's slot", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const principal = service_principal(fixture);

		await t.mutation(internal.plugins_data.reserve_document, {
			principal,
			collection: "meetings",
			key: "stored",
			maximumBytes: 1000,
			idempotencyKey: "reserve-stored",
			expiresAt: Date.now() + 60_000,
		});
		await t.mutation(internal.plugins_data.write_versioned_document, {
			principal,
			collection: "meetings",
			key: "stored",
			revision: 1,
			value: { n: 1 },
		});
		await t.mutation(internal.plugins_data.delete_versioned_document, {
			principal,
			collection: "meetings",
			key: "stored",
			revision: 2,
		});
		await t.mutation(internal.plugins_data.reserve_document, {
			principal,
			collection: "meetings",
			key: "never-stored",
			maximumBytes: 1000,
			idempotencyKey: "reserve-never",
			expiresAt: Date.now() + 60_000,
		});
		await t.mutation(internal.plugins_data.release_reservation, {
			principal,
			collection: "meetings",
			key: "never-stored",
			idempotencyKey: "reserve-never",
		});
		expect(await read_usage(t, fixture)).toMatchObject({ tombstoneDocuments: 2 });

		await t.run(async (ctx) => {
			const past = Date.now() - 1;
			for (const reservation of await ctx.db.query("plugins_data_reservations").collect()) {
				await ctx.db.patch("plugins_data_reservations", reservation._id, { retryHorizonExpiresAt: past });
			}
		});

		expect(
			await t.mutation(internal.plugins_data.cleanup_expired_plugin_data, { _test_disableReschedule: true }),
		).toEqual({ done: false, releasedCount: 0, deletedCount: 2 });
		// The never-stored retry returns its slot. The converted-release retry must not, because
		// the revision tombstone still fences that key.
		expect(await read_usage(t, fixture)).toMatchObject({ tombstoneDocuments: 1 });
		expect(await t.run(async (ctx) => (await ctx.db.query("plugins_data_revision_tombstones").collect()).length)).toBe(
			1,
		);
	});

	test("returns an old never-stored retry slot after a fresh reservation writes the key", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const principal = service_principal(fixture);

		await t.mutation(internal.plugins_data.reserve_document, {
			principal,
			collection: "meetings",
			key: "meeting-1",
			maximumBytes: 1000,
			idempotencyKey: "reserve-old",
			expiresAt: Date.now() + 60_000,
		});
		await t.mutation(internal.plugins_data.release_reservation, {
			principal,
			collection: "meetings",
			key: "meeting-1",
			idempotencyKey: "reserve-old",
		});
		await t.mutation(internal.plugins_data.reserve_document, {
			principal,
			collection: "meetings",
			key: "meeting-1",
			maximumBytes: 1000,
			idempotencyKey: "reserve-new",
			expiresAt: Date.now() + 60_000,
		});
		await t.mutation(internal.plugins_data.write_versioned_document, {
			principal,
			collection: "meetings",
			key: "meeting-1",
			revision: 1,
			value: value_of_bytes(600),
		});
		expect(await read_usage(t, fixture)).toMatchObject({
			usedDocuments: 1,
			reservedDocuments: 0,
			tombstoneDocuments: 1,
		});

		await t.run(async (ctx) => {
			const old = await ctx.db
				.query("plugins_data_reservations")
				.withIndex("by_installation_principal_idempotencyKey", (q) =>
					q
						.eq("installationId", fixture.installationId)
						.eq("ownerPrincipalKey", principal.principalKey)
						.eq("idempotencyKey", "reserve-old"),
				)
				.first();
			await ctx.db.patch("plugins_data_reservations", old!._id, { retryHorizonExpiresAt: Date.now() - 1 });
		});

		expect(
			await t.mutation(internal.plugins_data.cleanup_expired_plugin_data, { _test_disableReschedule: true }),
		).toEqual({ done: false, releasedCount: 0, deletedCount: 1 });
		expect(await read_usage(t, fixture)).toMatchObject({
			usedDocuments: 1,
			reservedDocuments: 0,
			tombstoneDocuments: 0,
		});
	});

	test("keeps a live reservation and a grant that have not expired", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);

		await t.mutation(internal.plugins_data.reserve_document, {
			principal: service_principal(fixture),
			collection: "meetings",
			key: "meeting-1",
			maximumBytes: 1000,
			idempotencyKey: "reserve-1",
			expiresAt: Date.now() + 60_000,
		});
		await mint_service_grant(t, fixture);

		expect(
			await t.mutation(internal.plugins_data.cleanup_expired_plugin_data, { _test_disableReschedule: true }),
		).toEqual({ done: true, releasedCount: 0, deletedCount: 0 });
		expect(await read_usage(t, fixture)).toMatchObject({ reservedBytes: 1000, reservedDocuments: 1 });
		expect(await read_all_store_tables(t, fixture)).toMatchObject({ reservations: 1, serviceGrants: 1 });
	});
});

describe("plugins_data_db_count_installation_docs", () => {
	async function count(t: ReturnType<typeof test_convex>, fixture: Awaited<ReturnType<typeof seed_installation>>) {
		return await t.run(
			async (ctx) =>
				await plugins_data_db_count_installation_docs(ctx, {
					organizationId: fixture.organizationId,
					workspaceId: fixture.workspaceId,
					installationId: fixture.installationId,
				}),
		);
	}

	test("reads at most one bounded page of grants and says the real number is higher", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);

		// More grants than the preview counts. How many an installation holds is decided by an outside
		// service, and this query is the required first step of registry deletion, so reading every
		// grant would make deletion impossible on exactly the installation that most needs it.
		await t.run(async (ctx) => {
			const now = Date.now();
			for (let index = 0; index < 150; index += 1) {
				await ctx.db.insert("plugin_service_grants", {
					organizationId: fixture.organizationId,
					workspaceId: fixture.workspaceId,
					installationId: fixture.installationId,
					pluginVersionId: fixture.pluginVersionId,
					pluginName: "council",
					actorUserId: fixture.userId,
					tokenHash: `hash-${index}`,
					scopes: ["plugin_data:read"],
					principalKey: `plugin_service:${fixture.installationId}`,
					phase: "interactive",
					destinationPathPrefix: null,
					expiresAt: now + 60_000,
					updatedAt: now,
				});
			}
		});

		// The count stops at the bound and the flag says there are more, so the preview reads as
		// "100+" instead of claiming the installation holds exactly one hundred grants.
		expect(await count(t, fixture)).toMatchObject({ serviceGrants: 100, serviceGrantsTruncated: true });
	});

	test("an installation under the bound is counted exactly", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		await mint_service_grant(t, fixture);
		await mint_service_grant(t, fixture);

		expect(await count(t, fixture)).toMatchObject({ serviceGrants: 2, serviceGrantsTruncated: false });
	});
});

describe("user_manage_scope", () => {
	test("scope membership grows and shrinks, and deleting the scope leaves no grants", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t, { clerkUserId: "scope-door-owner" });
		// Neither caller is the organization owner. The owner passes every permission check before any
		// grant is read, so an owner-only run would report a working scope over no grants at all.
		const alice = await join_member_with_role(t, fixture, { clerkUserId: "scope-alice", role: "member" });
		const bob = await join_member_with_role(t, fixture, { clerkUserId: "scope-bob", role: "member" });

		const created = await alice.asPage.mutation(api.plugins_data.user_manage_scope, {
			action: { kind: "create", scopeId: "dm-1", collections: ["messages"], keyPrefix: "dm/dm-1/" },
		});
		expect(created._nay).toBeUndefined();

		const resourceId = `${fixture.installationId}:dm-1`;
		const reads = async () =>
			await t.run(async (ctx) => {
				const organization = await ctx.db.get("organizations", fixture.organizationId);
				const scope = {
					organizationId: fixture.organizationId,
					workspaceId: fixture.workspaceId,
					defaultWorkspaceId: organization!.defaultWorkspaceId!,
					organizationOwnerUserId: organization!.ownerUserId,
					resource: { kind: "plugin_scope", id: resourceId },
					permission: "content.read",
				} as const;
				return {
					alice: await access_control_db_has_permission(ctx, { ...scope, userId: alice.userId }),
					bob: await access_control_db_has_permission(ctx, { ...scope, userId: bob.userId }),
				};
			});

		// The creator keeps the scope they just made, and nobody else is in it yet.
		expect(await reads()).toEqual({ alice: true, bob: false });

		const added = await alice.asPage.mutation(api.plugins_data.user_manage_scope, {
			action: { kind: "set_principal", scopeId: "dm-1", userId: bob.userId, level: "member" },
		});
		expect(added._nay).toBeUndefined();
		expect(await reads()).toEqual({ alice: true, bob: true });

		// Bob holds `member`, which carries no `content.permissions.manage`, so he cannot change who
		// else is in the scope.
		const bobAddsHimselfBack = await bob.asPage.mutation(api.plugins_data.user_manage_scope, {
			action: { kind: "set_principal", scopeId: "dm-1", userId: bob.userId, level: "manage" },
		});
		expect(bobAddsHimselfBack._nay?.message).toBe("Permission denied");

		const removed = await alice.asPage.mutation(api.plugins_data.user_manage_scope, {
			action: { kind: "remove_principal", scopeId: "dm-1", userId: bob.userId },
		});
		expect(removed._nay).toBeUndefined();
		// The shrink path. Without it scope membership would be append-only: Alice could add Bob and
		// would have no door to take it back.
		expect(await reads()).toEqual({ alice: true, bob: false });

		const beforeDelete = await t.run(async (ctx) =>
			(await ctx.db.query("access_control_permission_grants").collect()).filter(
				(grant) => grant.resourceId === resourceId,
			),
		);
		expect(beforeDelete.length).toBeGreaterThan(0);
		// Every grant this mutation writes names a user. A role principal would hand the scope to
		// everybody holding that role, and it would make the role undeletable — see the role test in
		// `access_control.test.ts`.
		expect(new Set(beforeDelete.map((grant) => grant.principalKind))).toEqual(new Set(["user"]));

		const deleted = await alice.asPage.mutation(api.plugins_data.user_manage_scope, {
			action: { kind: "delete", scopeId: "dm-1" },
		});
		expect(deleted._nay).toBeUndefined();

		const after = await t.run(async (ctx) => ({
			grants: (await ctx.db.query("access_control_permission_grants").collect()).filter(
				(grant) => grant.resourceId === resourceId,
			),
			scopes: await ctx.db.query("plugins_data_scopes").collect(),
		}));
		// A scope id is minted by the plugin and stored only on the scope document. If the delete left
		// its grants behind, nothing could ever find them again and they would count against their
		// holders' cap forever.
		expect(after.grants).toEqual([]);
		expect(after.scopes).toEqual([]);
		expect(await reads()).toEqual({ alice: false, bob: false });
	});

	test("refuses a principal past the per-scope cap and past the per-member cap", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t, { clerkUserId: "scope-cap-owner" });
		const alice = await join_member_with_role(t, fixture, { clerkUserId: "cap-alice", role: "member" });
		const bob = await join_member_with_role(t, fixture, { clerkUserId: "cap-bob", role: "member" });

		const created = await alice.asPage.mutation(api.plugins_data.user_manage_scope, {
			action: { kind: "create", scopeId: "cap-1", collections: ["messages"], keyPrefix: "dm/cap-1/" },
		});
		expect(created._nay).toBeUndefined();
		const resourceId = `${fixture.installationId}:cap-1`;

		// Fill the member's own budget with scopes that are not this one. The grants are what the cap
		// counts, so they are written straight in rather than through fifty more mutations.
		await t.run(async (ctx) => {
			const now = Date.now();
			for (let index = 0; index < 50; index += 1) {
				await ctx.db.insert("access_control_permission_grants", {
					organizationId: fixture.organizationId,
					workspaceId: fixture.workspaceId,
					resourceKind: "plugin_scope",
					resourceId: `other-installation:scope-${index}`,
					principalKind: "user",
					userId: bob.userId,
					permission: "content.read",
					createdAt: now,
					updatedAt: now,
				});
			}
		});

		const tooManyForBob = await alice.asPage.mutation(api.plugins_data.user_manage_scope, {
			action: { kind: "set_principal", scopeId: "cap-1", userId: bob.userId, level: "member" },
		});
		expect(tooManyForBob._nay?.message).toContain("50 private scopes");

		// Now fill the scope itself. Fifty other members already hold it, so Bob cannot be the
		// fifty-first even after his own budget is freed.
		await t.run(async (ctx) => {
			const now = Date.now();
			for (const grant of await ctx.db
				.query("access_control_permission_grants")
				.withIndex("by_user_organization_workspace_resource_permission", (q) =>
					q
						.eq("userId", bob.userId)
						.eq("organizationId", fixture.organizationId)
						.eq("workspaceId", fixture.workspaceId)
						.eq("resourceKind", "plugin_scope"),
				)
				.collect()) {
				await ctx.db.delete("access_control_permission_grants", grant._id);
			}

			for (let index = 0; index < 50; index += 1) {
				const filler = await ctx.db.insert("users", { clerkUserId: `cap-filler-${index}` });
				await ctx.db.insert("organizations_workspaces_users", {
					organizationId: fixture.organizationId,
					workspaceId: fixture.workspaceId,
					userId: filler,
					active: true,
					updatedAt: now,
				});
				await ctx.db.insert("access_control_permission_grants", {
					organizationId: fixture.organizationId,
					workspaceId: fixture.workspaceId,
					resourceKind: "plugin_scope",
					resourceId,
					principalKind: "user",
					userId: filler,
					permission: "content.read",
					createdAt: now,
					updatedAt: now,
				});
			}
		});

		const scopeFull = await alice.asPage.mutation(api.plugins_data.user_manage_scope, {
			action: { kind: "set_principal", scopeId: "cap-1", userId: bob.userId, level: "member" },
		});
		expect(scopeFull._nay?.message).toContain("at most 50 people");
	});

	test("a write inside a scoped key range is refused without a grant, and stamps the scope with one", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t, { clerkUserId: "scope-write-owner" });
		const alice = await join_member_with_role(t, fixture, { clerkUserId: "write-alice", role: "member" });
		const bob = await join_member_with_role(t, fixture, { clerkUserId: "write-bob", role: "member" });

		const created = await alice.asPage.mutation(api.plugins_data.user_manage_scope, {
			action: { kind: "create", scopeId: "dm-2", collections: ["messages"], keyPrefix: "dm/dm-2/" },
		});
		expect(created._nay).toBeUndefined();

		// Bob holds workspace `content.write`, which is what got him through the door at all. Inside a
		// scope that counts for nothing.
		const refused = await bob.asPage.mutation(api.plugins_data.user_put_document, {
			collection: "messages",
			key: "dm/dm-2/m1",
			value: { text: "let me in" },
		});
		expect(refused._nay?.message).toBe("Permission denied");

		const written = await alice.asPage.mutation(api.plugins_data.user_put_document, {
			collection: "messages",
			key: "dm/dm-2/m1",
			value: { text: "hello" },
		});
		expect(written._nay).toBeUndefined();

		// A key outside every scope is still public, and Bob writes there like before.
		const publicWrite = await bob.asPage.mutation(api.plugins_data.user_put_document, {
			collection: "messages",
			key: "pub/m1",
			value: { text: "hello everyone" },
		});
		expect(publicWrite._nay).toBeUndefined();

		const stored = await t.run(async (ctx) =>
			(await ctx.db.query("plugins_data").collect()).map((doc) => ({ key: doc.key, scopeId: doc.scopeId })),
		);
		// The writer never says which scope a document is in. The server resolves it from the key, so a
		// public document cannot be smuggled into a private range or the other way round.
		expect(stored.sort((left, right) => (left.key < right.key ? -1 : 1))).toEqual([
			{ key: "dm/dm-2/m1", scopeId: "dm-2" },
			{ key: "pub/m1", scopeId: undefined },
		]);
	});

	test("refuses a scope that overlaps another, or one over a range that already holds documents", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t, { clerkUserId: "scope-guard-owner" });
		const alice = await join_member_with_role(t, fixture, { clerkUserId: "guard-alice", role: "member" });

		const created = await alice.asPage.mutation(api.plugins_data.user_manage_scope, {
			action: { kind: "create", scopeId: "dm-3", collections: ["messages"], keyPrefix: "dm/dm-3/" },
		});
		expect(created._nay).toBeUndefined();

		// Inside the existing one. Overlapping scopes would break the single indexed read that resolves
		// a key's scope, because a key could then match two prefixes.
		const inside = await alice.asPage.mutation(api.plugins_data.user_manage_scope, {
			action: { kind: "create", scopeId: "dm-4", collections: ["messages"], keyPrefix: "dm/dm-3/x" },
		});
		expect(inside._nay?.message).toBe("Another scope already covers part of this key range");

		// Around the existing one.
		const around = await alice.asPage.mutation(api.plugins_data.user_manage_scope, {
			action: { kind: "create", scopeId: "dm-5", collections: ["messages"], keyPrefix: "dm/" },
		});
		expect(around._nay?.message).toBe("Another scope already covers part of this key range");

		const publicWrite = await alice.asPage.mutation(api.plugins_data.user_put_document, {
			collection: "messages",
			key: "town/m1",
			value: { text: "already public" },
		});
		expect(publicWrite._nay).toBeUndefined();

		// A scope over documents that are already there would leave them unstamped, so the whole
		// workspace would keep reading them inside a range that now calls itself private. It is also
		// what stops a deleted scope's range being claimed again while its old documents are still
		// there.
		const overOccupied = await alice.asPage.mutation(api.plugins_data.user_manage_scope, {
			action: { kind: "create", scopeId: "dm-6", collections: ["messages"], keyPrefix: "town/" },
		});
		expect(overOccupied._nay?.message).toBe("This key range already holds documents");
	});

	test("every read door hides a scope the caller is not in, including a read with no key range", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t, { clerkUserId: "scope-read-owner" });
		const alice = await join_member_with_role(t, fixture, { clerkUserId: "read-alice", role: "member" });
		const bob = await join_member_with_role(t, fixture, { clerkUserId: "read-bob", role: "member" });

		const created = await alice.asPage.mutation(api.plugins_data.user_manage_scope, {
			action: { kind: "create", scopeId: "dm-7", collections: ["messages"], keyPrefix: "dm/dm-7/" },
		});
		expect(created._nay).toBeUndefined();

		for (const [key, text] of [
			["dm/dm-7/m1", "private"],
			["town/m1", "public"],
		]) {
			const written = await alice.asPage.mutation(api.plugins_data.user_put_document, {
				collection: "messages",
				key,
				value: { text },
			});
			expect(written._nay).toBeUndefined();
		}

		const keysOf = (result: { docs: { key: string }[] } | null) => result?.docs.map((doc) => doc.key) ?? null;

		// This is the call the whole feature exists to answer: no key range at all, from a member with
		// workspace `content.read`. It must not reach the private document.
		expect(
			keysOf(await bob.asPage.query(api.plugins_data.watch_documents, { collection: "messages", limit: 100 })),
		).toEqual(["town/m1"]);
		expect(
			keysOf(await bob.asPage.query(api.plugins_data.watch_recent, { collection: "messages", limit: 100 })),
		).toEqual(["town/m1"]);

		// Naming the scope does not help either, through a key range or through the recent read.
		expect(
			await bob.asPage.query(api.plugins_data.watch_documents, {
				collection: "messages",
				keyPrefix: "dm/dm-7/",
				limit: 100,
			}),
		).toBeNull();
		expect(
			await bob.asPage.query(api.plugins_data.watch_recent, { collection: "messages", scopeId: "dm-7", limit: 100 }),
		).toBeNull();

		// Alice is in the scope, so both doors answer for her.
		expect(
			keysOf(
				await alice.asPage.query(api.plugins_data.watch_documents, {
					collection: "messages",
					keyPrefix: "dm/dm-7/",
					limit: 100,
				}),
			),
		).toEqual(["dm/dm-7/m1"]);
		expect(
			keysOf(
				await alice.asPage.query(api.plugins_data.watch_recent, {
					collection: "messages",
					scopeId: "dm-7",
					limit: 100,
				}),
			),
		).toEqual(["dm/dm-7/m1"]);

		// The service doors act for a person too, so they answer the same way. A private document reads
		// as absent rather than denied, so the refusal says nothing about what is there.
		const asBob = { ...store_principal(fixture, { actorUserId: bob.userId }) };
		const readPrivate = await t.query(internal.plugins_data.read_document, {
			principal: asBob,
			collection: "messages",
			key: "dm/dm-7/m1",
		});
		expect(readPrivate._yay).toBeNull();

		const listed = await t.query(internal.plugins_data.list_documents, {
			principal: asBob,
			collection: "messages",
			paginationOpts: { numItems: 100, cursor: null },
		});
		expect(listed._yay?.page.map((doc) => doc.key)).toEqual(["town/m1"]);

		const listedScope = await t.query(internal.plugins_data.list_documents, {
			principal: asBob,
			collection: "messages",
			keyPrefix: "dm/dm-7/",
			paginationOpts: { numItems: 100, cursor: null },
		});
		expect(listedScope._yay).toEqual({ page: [], isDone: true, continueCursor: "" });
	});

	test("one scope covers its key range in every collection it names, and counts once", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t, { clerkUserId: "scope-multi-owner" });
		const alice = await join_member_with_role(t, fixture, { clerkUserId: "multi-alice", role: "member" });
		const bob = await join_member_with_role(t, fixture, { clerkUserId: "multi-bob", role: "member" });

		// A private area is never one collection. A private channel keeps its name, its messages and
		// its reactions in three of them, all under the channel's key, so a scope covering one would
		// leave the other two readable by the whole workspace.
		const collections = ["channels", "messages", "reactions"];
		const created = await alice.asPage.mutation(api.plugins_data.user_manage_scope, {
			action: { kind: "create", scopeId: "dm-8", collections, keyPrefix: "dm/dm-8/" },
		});
		expect(created._nay).toBeUndefined();

		for (const collection of collections) {
			for (const [key, text] of [
				["dm/dm-8/a", "private"],
				["town/a", "public"],
			]) {
				const written = await alice.asPage.mutation(api.plugins_data.user_put_document, {
					collection,
					key,
					value: { text },
				});
				expect(written._nay).toBeUndefined();
			}
		}

		const keysOf = (result: { docs: { key: string }[] } | null) => result?.docs.map((doc) => doc.key) ?? null;
		for (const collection of collections) {
			expect(keysOf(await bob.asPage.query(api.plugins_data.watch_documents, { collection, limit: 100 }))).toEqual([
				"town/a",
			]);
			expect(
				keysOf(
					await alice.asPage.query(api.plugins_data.watch_documents, {
						collection,
						keyPrefix: "dm/dm-8/",
						limit: 100,
					}),
				),
			).toEqual(["dm/dm-8/a"]);
		}

		const state = await t.run(async (ctx) => ({
			rows: await ctx.db.query("plugins_data_scopes").collect(),
			resources: [
				...new Set(
					(await ctx.db.query("access_control_permission_grants").collect())
						.filter((grant) => grant.resourceKind === "plugin_scope")
						.map((grant) => grant.resourceId),
				),
			],
		}));
		expect(state.rows.map((row) => row.collection).sort()).toEqual([...collections].sort());
		// One row per collection, but one resource id, so the member's cap sees one private channel
		// and not three. Otherwise a plugin spreading a channel over four collections would cost its
		// members four of the fifty scopes they may hold.
		expect(state.resources).toEqual([`${fixture.installationId}:dm-8`]);

		// Delete takes every row with it. A row left behind would keep its own collection's range
		// private with no grant able to reach it.
		const deleted = await alice.asPage.mutation(api.plugins_data.user_manage_scope, {
			action: { kind: "delete", scopeId: "dm-8" },
		});
		expect(deleted._nay).toBeUndefined();
		expect(await t.run(async (ctx) => await ctx.db.query("plugins_data_scopes").collect())).toEqual([]);
	});
});

describe("scoped writes outside the frame", () => {
	test("an API key and a backend run are refused inside a scope their actor is not in", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t, { clerkUserId: "scope-http-owner" });
		const alice = await join_member_with_role(t, fixture, { clerkUserId: "http-alice", role: "member" });
		const bob = await join_member_with_role(t, fixture, { clerkUserId: "http-bob", role: "member" });

		const created = await alice.asPage.mutation(api.plugins_data.user_manage_scope, {
			action: { kind: "create", scopeId: "dm-10", collections: ["messages"], keyPrefix: "dm/dm-10/" },
		});
		expect(created._nay).toBeUndefined();

		// Bob holds workspace `content.write` and no grant on the scope. He cannot read the private
		// channel, and this is the other half: he must not be able to put a message in it either.
		const asBob = store_principal(fixture, { kind: "user_api_key", actorUserId: bob.userId });
		const written = await t.mutation(internal.plugins_data.write_document, {
			principal: asBob,
			collection: "messages",
			key: "dm/dm-10/m1",
			value: { text: "injected" },
		});
		expect(written._nay?.message).toBe("Permission denied");

		const batched = await t.mutation(internal.plugins_data.write_documents_batch, {
			principal: asBob,
			documents: [
				{ collection: "messages", key: "town/m1", value: { text: "public" } },
				{ collection: "messages", key: "dm/dm-10/m2", value: { text: "injected" } },
			],
		});
		// The whole batch is refused, not only the scoped item: a Convex mutation that returns a
		// refusal after inserting would keep the inserts it already made.
		expect(batched._nay?.message).toBe("Permission denied");
		expect(await t.run(async (ctx) => await ctx.db.query("plugins_data").collect())).toEqual([]);

		const deleted = await t.mutation(internal.plugins_data.delete_document, {
			principal: store_principal(fixture, { kind: "plugin_run", actorUserId: bob.userId }),
			collection: "messages",
			key: "dm/dm-10/m1",
		});
		expect(deleted._nay?.message).toBe("Permission denied");

		// Alice is in the scope, so the same door writes for her, and the document is stamped.
		const allowed = await t.mutation(internal.plugins_data.write_document, {
			principal: store_principal(fixture, { kind: "user_api_key", actorUserId: alice.userId }),
			collection: "messages",
			key: "dm/dm-10/m1",
			value: { text: "hello" },
		});
		expect(allowed._nay).toBeUndefined();
		expect(await t.run(async (ctx) => (await ctx.db.query("plugins_data").collect()).map((doc) => doc.scopeId))).toEqual(
			["dm-10"],
		);
	});
});

describe("watch_scope_principals", () => {
	test("the people in a scope read it, and it does not exist for anybody else", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t, { clerkUserId: "scope-list-owner" });
		const alice = await join_member_with_role(t, fixture, { clerkUserId: "list-alice", role: "member" });
		const bob = await join_member_with_role(t, fixture, { clerkUserId: "list-bob", role: "member" });
		// An admin, to show that a workspace role reaches nothing inside a scope it was never named in.
		const carol = await join_member_with_role(t, fixture, { clerkUserId: "list-carol", role: "admin" });

		const created = await alice.asPage.mutation(api.plugins_data.user_manage_scope, {
			action: { kind: "create", scopeId: "dm-9", collections: ["messages"], keyPrefix: "dm/dm-9/" },
		});
		expect(created._nay).toBeUndefined();
		const added = await alice.asPage.mutation(api.plugins_data.user_manage_scope, {
			action: { kind: "set_principal", scopeId: "dm-9", userId: bob.userId, level: "member" },
		});
		expect(added._nay).toBeUndefined();

		const principalsFor = async (member: { asPage: { query: typeof t.query } }) => {
			const result = await member.asPage.query(api.plugins_data.watch_scope_principals, { scopeId: "dm-9" });
			return result === null ? null : result.map((entry) => `${entry.userId}:${entry.level}`).sort();
		};

		// The creator keeps `manage`, and the person they added holds `member`. Without this read the
		// plugin could build a share list and never show or change it again.
		expect(await principalsFor(alice)).toEqual([`${alice.userId}:manage`, `${bob.userId}:member`].sort());
		expect(await principalsFor(bob)).toEqual([`${alice.userId}:manage`, `${bob.userId}:member`].sort());

		// Carol is an admin of this workspace and was never named in the scope. Null is the same answer
		// a scope that was never created gives, so the refusal tells her nothing about what exists.
		expect(await principalsFor(carol)).toBeNull();

		const removed = await alice.asPage.mutation(api.plugins_data.user_manage_scope, {
			action: { kind: "remove_principal", scopeId: "dm-9", userId: bob.userId },
		});
		expect(removed._nay).toBeUndefined();
		expect(await principalsFor(bob)).toBeNull();
	});
});

describe("watch_my_scopes", () => {
	test("a member finds the scopes they are in, and nobody finds one they were never added to", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t, { clerkUserId: "my-scopes-owner" });
		const alice = await join_member_with_role(t, fixture, { clerkUserId: "mine-alice", role: "member" });
		const bob = await join_member_with_role(t, fixture, { clerkUserId: "mine-bob", role: "member" });

		const created = await alice.asPage.mutation(api.plugins_data.user_manage_scope, {
			action: {
				kind: "create",
				scopeId: "p/room-1",
				collections: ["messages", "channels"],
				keyPrefix: "p/room-1/",
			},
		});
		expect(created._nay).toBeUndefined();

		// Without this read the scope id is lost the moment the dialog closes: a rangeless read answers
		// only the public part of a collection, so the creator's own private channel disappears.
		expect(await alice.asPage.query(api.plugins_data.watch_my_scopes, {})).toEqual([
			{ scopeId: "p/room-1", keyPrefix: "p/room-1/", collections: ["channels", "messages"], level: "manage" },
		]);

		// One scope, however many collections it covers, is one entry.
		expect(await bob.asPage.query(api.plugins_data.watch_my_scopes, {})).toEqual([]);

		const added = await alice.asPage.mutation(api.plugins_data.user_manage_scope, {
			action: { kind: "set_principal", scopeId: "p/room-1", userId: bob.userId, level: "member" },
		});
		expect(added._nay).toBeUndefined();
		expect(await bob.asPage.query(api.plugins_data.watch_my_scopes, {})).toEqual([
			{ scopeId: "p/room-1", keyPrefix: "p/room-1/", collections: ["channels", "messages"], level: "member" },
		]);

		// Taking somebody out takes the scope out of their list, which is what makes the channel
		// disappear from an open page instead of only from the next one they load.
		const removed = await alice.asPage.mutation(api.plugins_data.user_manage_scope, {
			action: { kind: "remove_principal", scopeId: "p/room-1", userId: bob.userId },
		});
		expect(removed._nay).toBeUndefined();
		expect(await bob.asPage.query(api.plugins_data.watch_my_scopes, {})).toEqual([]);

		// The organization owner reads every scope, and still lists only what they were added to. The
		// product copy promises a private channel is not in the owner's own list.
		expect(await fixture.asPage.query(api.plugins_data.watch_my_scopes, {})).toEqual([]);
	});
});
