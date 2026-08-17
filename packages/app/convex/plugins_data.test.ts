import { afterEach, describe, expect, test, vi } from "vitest";
import { compareValues } from "convex/values";

import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel";
import { organizations_db_create_workspace } from "./organizations.ts";
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
 */
async function seed_installation(
	t: ReturnType<typeof test_convex>,
	args: {
		acceptedCapabilities?: plugins_Capability[];
		userId?: Id<"users">;
		organizationName?: string;
	} = {},
) {
	return await t.run(async (ctx) => {
		const now = Date.now();
		const membership = await test_mocks_fill_db_with.membership(ctx, {
			userId: args.userId,
			organizationName: args.organizationName,
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

		// A `processing` grant is meant to outlive the actor's permissions one day, so accepted work is
		// not stranded half-written. That only becomes safe once the grant is sealed to one exact
		// target, and the sealing fields belong to the Council work that mints such a grant. Until then
		// both phases die with the membership.
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

	return {
		...member,
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
		// Pin the exact field set: the bridge, the SDK, and plugin pages all consume this shape.
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
		const appended = await fixture.asUser.mutation(api.plugins_data.user_append_document, {
			membershipId: fixture.membershipId,
			pluginName: "council",
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

		// A service grant is judged with its actor's live membership like every other principal. The
		// processing phase is meant to outlive that one day, but only once it is sealed to one exact
		// target, and the sealing fields belong to the Council work that mints such a grant.
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
	return { ...fixture, asUser } as const;
}

describe("user_append_document", () => {
	test("stores an owned document under a newest-first server key", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t);

		const limiterNow = Date.now();
		const dateNow = vi.spyOn(Date, "now").mockReturnValue(limiterNow);
		try {
			const appended = await fixture.asUser.mutation(api.plugins_data.user_append_document, {
				membershipId: fixture.membershipId,
				pluginName: "council",
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
			const first = await fixture.asUser.mutation(api.plugins_data.user_append_document, {
				membershipId: fixture.membershipId,
				pluginName: "council",
				collection: "messages",
				value: { n: 1 },
				clientRequestId: "order-1",
			});
			dateNow.mockReturnValue(baseNow + 5_000);
			const second = await fixture.asUser.mutation(api.plugins_data.user_append_document, {
				membershipId: fixture.membershipId,
				pluginName: "council",
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
			await fixture.asUser.mutation(api.plugins_data.user_append_document, {
				membershipId: fixture.membershipId,
				pluginName: "council",
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

		const atLimit = await fixture.asUser.mutation(api.plugins_data.user_append_document, {
			membershipId: fixture.membershipId,
			pluginName: "council",
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

		const overLimit = await fixture.asUser.mutation(api.plugins_data.user_append_document, {
			membershipId: fixture.membershipId,
			pluginName: "council",
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
			await fixture.asUser.mutation(api.plugins_data.user_append_document, {
				membershipId: fixture.membershipId,
				pluginName: "council",
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

		// An anonymous member authenticates with the app's own JWT issuer; the subject is the user id.
		const asAnonymous = t.withIdentity({ issuer: process.env.VITE_CONVEX_HTTP_URL!, subject: anonymous.userId });
		const appended = await asAnonymous.mutation(api.plugins_data.user_append_document, {
			membershipId: anonymous.membershipId,
			pluginName: "council",
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
				const appended = await fixture.asUser.mutation(api.plugins_data.user_append_document, {
					membershipId: fixture.membershipId,
					pluginName: "council",
					collection: "messages",
					value: { n: index },
					clientRequestId: `burst-${index}`,
				});
				expect(appended._nay).toBeUndefined();
			}
			const refused = await fixture.asUser.mutation(api.plugins_data.user_append_document, {
				membershipId: fixture.membershipId,
				pluginName: "council",
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
				const appended = await fixture.asUser.mutation(api.plugins_data.user_append_document, {
					membershipId: fixture.membershipId,
					pluginName: "council",
					collection: "messages",
					value: { n: index },
					clientRequestId: `burst-${index}`,
				});
				expect(appended._nay).toBeUndefined();
			}

			// A retry after a lost response replays the same request. The first call already
			// committed and charged the bucket, so the replay must answer the stored key instead
			// of a rate refusal, or a delivered message would report as failed.
			const replayed = await fixture.asUser.mutation(api.plugins_data.user_append_document, {
				membershipId: fixture.membershipId,
				pluginName: "council",
				collection: "messages",
				value: { n: 0 },
				clientRequestId: "burst-0",
			});
			expect(replayed._nay).toBeUndefined();
			const documents = await read_documents(t, fixture);
			expect(replayed._yay?.key).toBe(documents.find((doc) => doc.userWriteRequestId === "burst-0")?.key);

			// A fresh append still refuses: the replay above answered without refilling anything.
			const refused = await fixture.asUser.mutation(api.plugins_data.user_append_document, {
				membershipId: fixture.membershipId,
				pluginName: "council",
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

	test("rejects an expectedRevision argument: an append has no revision to expect", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t);

		// The field is absent from the validator on purpose, so a caller cannot even ask.
		await expect(
			fixture.asUser.mutation(api.plugins_data.user_append_document, {
				membershipId: fixture.membershipId,
				pluginName: "council",
				collection: "messages",
				value: { n: 1 },
				clientRequestId: "cas-append",
				...({ expectedRevision: 0 } as object),
			}),
		).rejects.toThrow(/expectedRevision/);
	});
});

describe("user_put_document", () => {
	test("creates shared docs any member can change, and guards owned docs by creator", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t);
		const member = await join_member_with_role(t, fixture, { clerkUserId: "door-second-member", role: "member" });

		const appended = await fixture.asUser.mutation(api.plugins_data.user_append_document, {
			membershipId: fixture.membershipId,
			pluginName: "council",
			collection: "messages",
			value: { text: "original" },
			clientRequestId: "put-1",
		});
		if (appended._nay) {
			throw new Error(appended._nay.message);
		}
		const ownedKey = appended._yay.key;

		// Another member may not edit the owned doc, not even through the door.
		const refused = await member.asUser.mutation(api.plugins_data.user_put_document, {
			membershipId: member.membershipId,
			pluginName: "council",
			collection: "messages",
			key: ownedKey,
			value: { text: "hijacked" },
		});
		expect(refused._nay?.message).toBe("This document belongs to another writer");

		// The creator edits their own doc, and it stays owned.
		const edited = await fixture.asUser.mutation(api.plugins_data.user_put_document, {
			membershipId: fixture.membershipId,
			pluginName: "council",
			collection: "messages",
			key: ownedKey,
			value: { text: "edited" },
		});
		if (edited._nay) {
			throw new Error(edited._nay.message);
		}
		expect(edited._yay.revision).toBe(2);

		// A put on an absent key creates a shared doc, and any member with content.write may update it.
		const created = await member.asUser.mutation(api.plugins_data.user_put_document, {
			membershipId: member.membershipId,
			pluginName: "council",
			collection: "channels",
			key: "general",
			value: { name: "general" },
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		const renamed = await fixture.asUser.mutation(api.plugins_data.user_put_document, {
			membershipId: fixture.membershipId,
			pluginName: "council",
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

		const put = await fixture.asUser.mutation(api.plugins_data.user_put_document, {
			membershipId: fixture.membershipId,
			pluginName: "council",
			collection: "messages",
			key: "outbox",
			value: { n: 2 },
		});
		expect(put._nay?.message).toBe("This document is written by a service and cannot be changed here");
		const removed = await fixture.asUser.mutation(api.plugins_data.user_remove_document, {
			membershipId: fixture.membershipId,
			pluginName: "council",
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
			await fixture.asUser.mutation(api.plugins_data.user_put_document, {
				membershipId: fixture.membershipId,
				pluginName: "council",
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
		const removed = await fixture.asUser.mutation(api.plugins_data.user_remove_document, {
			membershipId: fixture.membershipId,
			pluginName: "council",
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
		const appended = await fixture.asUser.mutation(api.plugins_data.user_append_document, {
			membershipId: fixture.membershipId,
			pluginName: "council",
			collection: "messages",
			value: { text: "mine" },
			clientRequestId: "cas-owned",
		});
		if (appended._nay) {
			throw new Error(appended._nay.message);
		}
		const hijack = await member.asUser.mutation(api.plugins_data.user_put_document, {
			membershipId: member.membershipId,
			pluginName: "council",
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

		const absent = await fixture.asUser.mutation(api.plugins_data.user_remove_document, {
			membershipId: fixture.membershipId,
			pluginName: "council",
			collection: "messages",
			key: "never-stored",
		});
		expect(absent).toEqual({ _yay: { deleted: false } });

		const appended = await fixture.asUser.mutation(api.plugins_data.user_append_document, {
			membershipId: fixture.membershipId,
			pluginName: "council",
			collection: "messages",
			value: { text: "mine" },
			clientRequestId: "rm-1",
		});
		if (appended._nay) {
			throw new Error(appended._nay.message);
		}

		const refused = await member.asUser.mutation(api.plugins_data.user_remove_document, {
			membershipId: member.membershipId,
			pluginName: "council",
			collection: "messages",
			key: appended._yay.key,
		});
		expect(refused._nay?.message).toBe("This document belongs to another writer");
		expect(await read_documents(t, fixture)).toHaveLength(1);

		// A shared doc is removable by any member with content.write, not only its creator.
		const shared = await member.asUser.mutation(api.plugins_data.user_put_document, {
			membershipId: member.membershipId,
			pluginName: "council",
			collection: "messages",
			key: "shared-note",
			value: { n: 1 },
		});
		if (shared._nay) {
			throw new Error(shared._nay.message);
		}
		const sharedRemoved = await fixture.asUser.mutation(api.plugins_data.user_remove_document, {
			membershipId: fixture.membershipId,
			pluginName: "council",
			collection: "messages",
			key: "shared-note",
		});
		expect(sharedRemoved).toEqual({ _yay: { deleted: true } });

		const ownRemoved = await fixture.asUser.mutation(api.plugins_data.user_remove_document, {
			membershipId: fixture.membershipId,
			pluginName: "council",
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
			await fixture.asUser.mutation(api.plugins_data.user_remove_document, {
				membershipId: fixture.membershipId,
				pluginName: "council",
				collection: "channels",
				key: args.key,
				...(args.expectedRevision === undefined ? {} : { expectedRevision: args.expectedRevision }),
			});

		const created = await fixture.asUser.mutation(api.plugins_data.user_put_document, {
			membershipId: fixture.membershipId,
			pluginName: "council",
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
		const appended = await fixture.asUser.mutation(api.plugins_data.user_append_document, {
			membershipId: fixture.membershipId,
			pluginName: "council",
			collection: "messages",
			value: { text: "mine" },
			clientRequestId: "cas-remove-owned",
		});
		if (appended._nay) {
			throw new Error(appended._nay.message);
		}
		const hijack = await member.asUser.mutation(api.plugins_data.user_remove_document, {
			membershipId: member.membershipId,
			pluginName: "council",
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

		const aVote = await fixture.asUser.mutation(api.plugins_data.user_put_owned_document, {
			membershipId: fixture.membershipId,
			pluginName: "council",
			collection: "reactions",
			key: "vote",
			value: { choice: "yes" },
		});
		const bVote = await member.asUser.mutation(api.plugins_data.user_put_owned_document, {
			membershipId: member.membershipId,
			pluginName: "council",
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
		const forged = await member.asUser.mutation(api.plugins_data.user_remove_document, {
			membershipId: member.membershipId,
			pluginName: "council",
			collection: "reactions",
			key: aVote._yay.key,
		});
		expect(forged._nay?.message).toBe("This document belongs to another writer");

		// A ":" smuggled into the caller key stays caller text: it lands under the caller's own suffix.
		const smuggled = await member.asUser.mutation(api.plugins_data.user_put_owned_document, {
			membershipId: member.membershipId,
			pluginName: "council",
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
		const removed = await member.asUser.mutation(api.plugins_data.user_remove_owned_document, {
			membershipId: member.membershipId,
			pluginName: "council",
			collection: "reactions",
			key: "vote",
		});
		expect(removed).toEqual({ _yay: { deleted: true } });
		const after = await read_documents(t, fixture);
		expect(after.map((doc) => doc.key).sort()).toEqual([`vote:${fixture.userId}`, `vote:${fixture.userId}:${member.userId}`]);

		const removedAgain = await member.asUser.mutation(api.plugins_data.user_remove_owned_document, {
			membershipId: member.membershipId,
			pluginName: "council",
			collection: "reactions",
			key: "vote",
		});
		expect(removedAgain).toEqual({ _yay: { deleted: false } });
	});

	test("refuses a squatted composed key and a key that outgrows the budget", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t);

		// A shared doc created at exactly the composed key squats it; putOwned must refuse, not adopt.
		const squat = await fixture.asUser.mutation(api.plugins_data.user_put_document, {
			membershipId: fixture.membershipId,
			pluginName: "council",
			collection: "reactions",
			key: `poll:${fixture.userId}`,
			value: { n: 1 },
		});
		if (squat._nay) {
			throw new Error(squat._nay.message);
		}
		const refused = await fixture.asUser.mutation(api.plugins_data.user_put_owned_document, {
			membershipId: fixture.membershipId,
			pluginName: "council",
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
		const fits = await fixture.asUser.mutation(api.plugins_data.user_put_owned_document, {
			membershipId: fixture.membershipId,
			pluginName: "council",
			collection: "reactions",
			key: "k".repeat(127 - idLength),
			value: { n: 3 },
		});
		if (fits._nay) {
			throw new Error(fits._nay.message);
		}
		expect(fits._yay.key.length).toBe(128);
		const overflow = await fixture.asUser.mutation(api.plugins_data.user_put_owned_document, {
			membershipId: fixture.membershipId,
			pluginName: "council",
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
			await fixture.asUser.mutation(api.plugins_data.user_put_owned_document, {
				membershipId: fixture.membershipId,
				pluginName: "council",
				collection: "reactions",
				key: "msg-1",
				value: args.value,
				...(args.expectedRevision === undefined ? {} : { expectedRevision: args.expectedRevision }),
			});
		const removeOwned = async (args: { expectedRevision?: number }) =>
			await fixture.asUser.mutation(api.plugins_data.user_remove_owned_document, {
				membershipId: fixture.membershipId,
				pluginName: "council",
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
});

describe("db_authorize_user_write", () => {
	test("refuses a forged membership, a stranger, and an unauthenticated caller", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t);
		const member = await join_member_with_role(t, fixture, { clerkUserId: "door-forger", role: "member" });

		// A member naming somebody else's membership doc is refused before anything is derived from it.
		const forged = await member.asUser.mutation(api.plugins_data.user_append_document, {
			membershipId: fixture.membershipId,
			pluginName: "council",
			collection: "messages",
			value: { text: "forged" },
			clientRequestId: "forged-1",
		});
		expect(forged._nay?.message).toBe("Unauthorized");

		const stranger = await seed_user_write_door(t, { organizationName: "stranger-org", clerkUserId: "door-stranger" });
		const crossTenant = await stranger.asUser.mutation(api.plugins_data.user_append_document, {
			membershipId: fixture.membershipId,
			pluginName: "council",
			collection: "messages",
			value: { text: "cross-tenant" },
			clientRequestId: "forged-2",
		});
		expect(crossTenant._nay?.message).toBe("Unauthorized");

		const unauthenticated = await t.mutation(api.plugins_data.user_append_document, {
			membershipId: fixture.membershipId,
			pluginName: "council",
			collection: "messages",
			value: { text: "nobody" },
			clientRequestId: "forged-3",
		});
		expect(unauthenticated._nay?.message).toBe("Unauthenticated");

		expect(await read_documents(t, fixture)).toHaveLength(0);
	});

	test("closes the door on every revocation flavor and on a read-only role", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t);
		const append = async (clientRequestId: string) =>
			await fixture.asUser.mutation(api.plugins_data.user_append_document, {
				membershipId: fixture.membershipId,
				pluginName: "council",
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
		expect((await append("disabled"))._nay?.message).toBe("Not found");
		await t.run(async (ctx) => {
			await ctx.db.patch("plugins_workspace_installations", fixture.installationId, { status: "enabled" });
		});

		// 3) An upgrade stops declaring the capability, even though the workspace once accepted it.
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

		// 4) A viewer may read the workspace but not write it.
		const viewer = await join_member_with_role(t, fixture, { clerkUserId: "door-viewer", role: "viewer" });
		const viewerAppend = await viewer.asUser.mutation(api.plugins_data.user_append_document, {
			membershipId: viewer.membershipId,
			pluginName: "council",
			collection: "messages",
			value: { text: "viewer" },
			clientRequestId: "viewer-1",
		});
		expect(viewerAppend._nay?.message).toBe("Permission denied");

		// 5) The membership itself is removed.
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
	test("throws with no auth identity and answers null for a forged membership", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t);

		await expect(
			t.query(api.plugins_data.watch_documents, {
				membershipId: fixture.membershipId,
				pluginName: "council",
				collection: "messages",
				limit: 10,
			}),
		).rejects.toThrow(/Unauthenticated/);

		// A member naming somebody else's membership doc is refused before anything is derived from it.
		const member = await join_member_with_role(t, fixture, { clerkUserId: "watch-forger", role: "member" });
		const forged = await member.asUser.query(api.plugins_data.watch_documents, {
			membershipId: fixture.membershipId,
			pluginName: "council",
			collection: "messages",
			limit: 10,
		});
		expect(forged).toBeNull();

		const stranger = await seed_user_write_door(t, {
			organizationName: "watch-stranger-org",
			clerkUserId: "watch-stranger",
		});
		const crossTenant = await stranger.asUser.query(api.plugins_data.watch_documents, {
			membershipId: fixture.membershipId,
			pluginName: "council",
			collection: "messages",
			limit: 10,
		});
		expect(crossTenant).toBeNull();
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
				const appended = await fixture.asUser.mutation(api.plugins_data.user_append_document, {
					membershipId: fixture.membershipId,
					pluginName: "council",
					collection: "messages",
					value: { n: index },
					clientRequestId: `watch-order-${index}`,
				});
				if (appended._nay) {
					throw new Error(appended._nay.message);
				}
				keys.push(appended._yay.key);
			}

			const watched = await fixture.asUser.query(api.plugins_data.watch_documents, {
				membershipId: fixture.membershipId,
				pluginName: "council",
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
			const appended = await fixture.asUser.mutation(api.plugins_data.user_append_document, {
				membershipId: fixture.membershipId,
				pluginName: "council",
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

		const watched = await fixture.asUser.query(api.plugins_data.watch_documents, {
			membershipId: fixture.membershipId,
			pluginName: "council",
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
			await fixture.asUser.query(api.plugins_data.watch_documents, {
				membershipId: fixture.membershipId,
				pluginName: "council",
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
			await fixture.asUser.query(api.plugins_data.watch_documents, {
				membershipId: fixture.membershipId,
				pluginName: "council",
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
			await fixture.asUser.query(api.plugins_data.watch_documents, {
				membershipId: fixture.membershipId,
				pluginName: "council",
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

		const watched = await fixture.asUser.query(api.plugins_data.watch_documents, {
			membershipId: fixture.membershipId,
			pluginName: "council",
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
			await fixture.asUser.query(api.plugins_data.watch_documents, {
				membershipId: fixture.membershipId,
				pluginName: "council",
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

		// 4) The membership itself is removed.
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
			await viewer.asUser.query(api.plugins_data.watch_documents, {
				membershipId: viewer.membershipId,
				pluginName: "council",
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
			await fixture.asUser.query(api.plugins_data.watch_documents, {
				membershipId: fixture.membershipId,
				pluginName: "council",
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

		const resolved = await fixture.asUser.query(api.plugins_data.resolve_member_display, {
			membershipId: fixture.membershipId,
			pluginName: "council",
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
				membershipId: fixture.membershipId,
				pluginName: "council",
				userIds: [fixture.userId],
			}),
		).rejects.toThrow(/Unauthenticated/);

		const resolve = async (userIds: Id<"users">[]) =>
			await fixture.asUser.query(api.plugins_data.resolve_member_display, {
				membershipId: fixture.membershipId,
				pluginName: "council",
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

describe("storage-layer ownership", () => {
	test("refuses changing another member's owned doc through every interactive writer", async () => {
		const t = test_convex();
		const fixture = await seed_user_write_door(t);
		const other = await join_member_with_role(t, fixture, { clerkUserId: "owned-doc-outsider", role: "member" });

		const appended = await fixture.asUser.mutation(api.plugins_data.user_append_document, {
			membershipId: fixture.membershipId,
			pluginName: "council",
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

/**
 * Fill every one of the five installation-owned tables: a stored document, a live reservation, a
 * released reservation, a revision tombstone, a service grant, and the accounting doc they share.
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

/** Read the five installation-owned tables at once, so a deletion test can assert every one is empty. */
async function read_all_store_tables(
	t: ReturnType<typeof test_convex>,
	fixture: Awaited<ReturnType<typeof seed_installation>>,
) {
	return await t.run(async (ctx) => {
		const [documents, reservations, tombstones, usage, grants] = await Promise.all([
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

	test("uninstalling a plugin leaves all five of its tables empty", async () => {
		const t = test_convex();
		// The drain runs on the scheduler and reschedules itself, so the test needs fake timers to
		// walk that chain to its end.
		vi.useFakeTimers();
		const fixture = await seed_installation_with_key_owner(t, "clerk-uninstall-drain");
		await seed_full_store(t, fixture);
		expect(await read_all_store_tables(t, fixture)).toEqual({
			documents: 1,
			reservations: 2,
			revisionTombstones: 1,
			usage: 1,
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
			documents: 1,
			reservations: 2,
			revisionTombstones: 1,
			usage: 1,
			serviceGrants: 1,
		});
		expect(await read_all_store_tables(t, other)).toEqual({
			documents: 1,
			reservations: 2,
			revisionTombstones: 1,
			usage: 1,
			serviceGrants: 1,
		});

		await drain_until_done(t, fixture);

		expect(await read_all_store_tables(t, fixture)).toEqual({
			documents: 0,
			reservations: 0,
			revisionTombstones: 0,
			usage: 0,
			serviceGrants: 0,
		});
		expect(await read_all_store_tables(t, other)).toEqual({
			documents: 1,
			reservations: 2,
			revisionTombstones: 1,
			usage: 1,
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
