import { describe, expect, test } from "vitest";
import { importSPKI, jwtVerify } from "jose";

import { api, components, internal } from "./_generated/api.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import { crypto_random_hex, crypto_sha256_hex } from "../server/crypto-utils.ts";
import type { plugins_Capability } from "../shared/plugins.ts";

const SERVICE_SECRET = "CHITCHAT_TEST_SERVICE_SECRET";
const CAPABILITIES: plugins_Capability[] = ["plugin.service.connect", "workspace.members.read"];

async function seed_installation(t: ReturnType<typeof test_convex>, organizationName = "test-chat") {
	return await t.run(async (ctx) => {
		const membership = await test_mocks_fill_db_with.membership(ctx, { organizationName });
		const now = Date.now();
		const pluginVersionId = await ctx.db.insert("plugins_versions", {
			name: "chitchat",
			displayName: "Chitchat",
			version: "1.0.0",
			description: "Workspace chat",
			reviewStatus: "passed",
			reviewId: null,
			isLatest: true,
			artifactHash: `sha256:${"a".repeat(64)}`,
			sourceRepositoryUrl: "https://github.com/bonobo/chitchat",
			sourceOwner: "bonobo",
			sourceRepo: "chitchat",
			sourceCommitSha: "1234567890abcdef1234567890abcdef12345678",
			manifestR2Key: "plugins/chitchat/manifest.json",
			backendEntrypointFile: null,
			configuration: null,
			events: [],
			capabilities: CAPABILITIES,
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
		const serviceAccountId = await test_mocks_fill_db_with.plugin_service_account(ctx, {
			...membership,
			pluginVersionId,
		});
		const installationId = await ctx.db.insert("plugins_workspace_installations", {
			serviceAccountId,
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			pluginVersionId,
			pluginName: "chitchat",
			status: "enabled",
			configurationYaml: null,
			acceptedCapabilities: CAPABILITIES,
			capabilitiesAcceptedAt: now,
			acceptedOutboundOrigins: [],
			acceptedUiOutboundOrigins: [],
			outboundOriginsAcceptedAt: now,
			installedBy: membership.userId,
			updatedBy: membership.userId,
			updatedAt: now,
		});
		if (
			!(await ctx.db
				.query("plugins_service_registrations")
				.withIndex("by_pluginName", (q) => q.eq("pluginName", "chitchat"))
				.first())
		) {
			await ctx.db.insert("plugins_service_registrations", {
				pluginName: "chitchat",
				exchangeSecretHash: await crypto_sha256_hex(SERVICE_SECRET),
				scopes: [],
				createdBy: membership.userId,
				updatedAt: now,
			});
		}
		const token = `plu_${crypto_random_hex(32)}`;
		const tokenHash = await crypto_sha256_hex(token);
		const sessionId = await ctx.db.insert("plugins_ui_sessions", {
			serviceAccountId,
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			installationId,
			pluginVersionId,
			userId: membership.userId,
			tokenHash,
			createdAt: now,
			expiresAt: now + 60_000,
		});
		return { ...membership, pluginVersionId, serviceAccountId, installationId, sessionId, token, tokenHash };
	});
}

async function lease(
	t: ReturnType<typeof test_convex>,
	fixture: Awaited<ReturnType<typeof seed_installation>>,
	requestedExpiresAt = Date.now() + 30_000,
) {
	return await t.mutation(internal.plugins_chitchat.create_lease_facts, {
		tokenHash: fixture.tokenHash,
		serviceSecretHash: await crypto_sha256_hex(SERVICE_SECRET),
		exchangeId: crypto.randomUUID(),
		requestedExpiresAt,
	});
}

async function events(t: ReturnType<typeof test_convex>, installationId: string, afterRevision = 0, limit = 100) {
	return await t.query(internal.plugins_chitchat.get_events, {
		installationId,
		afterRevision,
		limit,
		serviceSecretHash: await crypto_sha256_hex(SERVICE_SECRET),
	});
}

describe("create_lease_facts", () => {
	test("caps the absolute deadline and uses current Press identity without plugin-data scopes", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const requestedExpiresAt = Date.now() + 8_000;
		const result = await lease(t, fixture, requestedExpiresAt);
		expect(result._yay).toMatchObject({
			hostSessionId: fixture.sessionId,
			hostUserId: fixture.userId,
			hostMembershipId: fixture.membershipId,
			canRead: true,
			canWrite: true,
			isOwner: true,
			membershipLifetime: 1,
			requiredRevision: 0,
			expiresAt: requestedExpiresAt,
		});
		const capped = await lease(t, fixture, Date.now() + 120_000);
		expect(capped._yay!.expiresAt - capped._yay!.validatedAt).toBe(30_000);
		expect((await lease(t, fixture, Date.now() - 1))._nay?.message).toBe("Lease has expired");
	});

	test("checks service proof, membership, consent, version and account each time", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const badSecret = await t.mutation(internal.plugins_chitchat.create_lease_facts, {
			tokenHash: fixture.tokenHash,
			serviceSecretHash: "wrong",
			exchangeId: crypto.randomUUID(),
			requestedExpiresAt: Date.now() + 30_000,
		});
		expect(badSecret._nay?.message).toBe("Unauthorized");
		await t.run((ctx) => ctx.db.patch("organizations_workspaces_users", fixture.membershipId, { active: false }));
		expect((await lease(t, fixture))._nay?.message).toBe("Unauthorized");
		await t.run((ctx) => ctx.db.patch("organizations_workspaces_users", fixture.membershipId, { active: true }));
		await t.run((ctx) =>
			ctx.db.patch("plugins_workspace_installations", fixture.installationId, {
				acceptedCapabilities: ["plugin.service.connect"],
			}),
		);
		expect((await lease(t, fixture))._nay?.message).toBe("Unauthorized");
		await t.run((ctx) =>
			ctx.db.patch("plugins_workspace_installations", fixture.installationId, { acceptedCapabilities: CAPABILITIES }),
		);
		await t.run((ctx) =>
			ctx.db.patch("access_control_service_accounts", fixture.serviceAccountId, { revokedAt: Date.now() }),
		);
		expect((await lease(t, fixture))._nay?.message).toBe("Unauthorized");
	});
});

describe("/api/internal/plugins/chitchat/lease", () => {
	test("signs the dedicated issuer, audience and custom exchangeId", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const exchangeId = crypto.randomUUID();
		const requestedExpiresAt = Date.now() + 20_000;
		const response = await t.fetch("/api/internal/plugins/chitchat/lease", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${fixture.token}`,
				"X-Bonobo-Service-Authorization": `Bearer ${SERVICE_SECRET}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ exchangeId, requestedExpiresAt }),
		});
		expect(response.status).toBe(200);
		const body = await response.json();
		const verified = await jwtVerify(
			body.jwt,
			await importSPKI(process.env.ANONYMOUS_USERS_JWT_PUBLIC_KEY_PEM!, "ES256"),
			{
				issuer: `${process.env.VITE_CONVEX_HTTP_URL}/plugins/chitchat`,
				audience: "chitchat",
				algorithms: ["ES256"],
			},
		);
		expect(verified.payload).toMatchObject({
			exchangeId,
			jti: exchangeId,
			sub: fixture.sessionId,
			expiresAt: requestedExpiresAt,
			hostUserId: fixture.userId,
		});
		expect(verified.payload.exp).toBe(Math.floor(requestedExpiresAt / 1000));
	});
});

describe("get_snapshot", () => {
	test("pages existing workspace members even when they have never opened Chitchat", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		await lease(t, fixture);
		await t.run(async (ctx) => {
			for (let index = 0; index < 53; index++) {
				const userId = await ctx.db.insert("users", { clerkUserId: `member-${index}` });
				await ctx.db.insert("organizations_workspaces_users", {
					organizationId: fixture.organizationId,
					workspaceId: fixture.workspaceId,
					userId,
					active: true,
				});
			}
		});
		const args = {
			installationId: String(fixture.installationId),
			serviceSecretHash: await crypto_sha256_hex(SERVICE_SECRET),
		};
		const first = await t.mutation(internal.plugins_chitchat.get_snapshot, {
			...args,
			cursor: null,
			startRevision: null,
		});
		expect(first._yay!.members).toHaveLength(50);
		expect(first._yay!.continueCursor).not.toBeNull();
		const second = await t.mutation(internal.plugins_chitchat.get_snapshot, {
			...args,
			cursor: first._yay!.continueCursor,
			startRevision: first._yay!.startRevision,
		});
		expect(second._yay!.members).toHaveLength(4);
		expect(second._yay!.continueCursor).toBeNull();
		expect(first._yay!.members.every((member) => member.membershipLifetime === 1)).toBe(true);
		const invalidContinuation = await t.mutation(internal.plugins_chitchat.get_snapshot, {
			...args,
			cursor: first._yay!.continueCursor,
			startRevision: null,
		});
		expect(invalidContinuation._nay?.message).toBe("Snapshot required");
	});
});

describe("get_events", () => {
	test("publishes account-deletion tenant revocation before delayed content purge", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		await lease(t, fixture);
		await t.mutation(internal.data_deletion.init_user_deletion, { userId: fixture.userId });
		const result = await events(t, fixture.installationId);
		expect(
			result._yay!.events.some(({ event }) => event.kind === "revoked" && event.reason === "organization_deleted"),
		).toBe(true);
		expect((await lease(t, fixture))._nay?.message).toBe("Unauthorized");
	});

	test("publishes role downgrades with the source write and snapshots current permissions", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		await lease(t, fixture);
		const owner = t.withIdentity({ issuer: "https://clerk.test", external_id: fixture.userId });
		const userId = await t.run((ctx) => ctx.db.insert("users", { clerkUserId: "viewer" }));
		await owner.mutation(api.organizations.invite_user_to_organization_workspace, {
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			userIdToAdd: userId,
		});
		const organization = await t.run((ctx) => ctx.db.get("organizations", fixture.organizationId));
		expect(
			(
				await owner.mutation(api.access_control.set_user_role, {
					organizationId: fixture.organizationId,
					workspaceId: organization!.defaultWorkspaceId!,
					userId,
					role: "viewer",
				})
			)._yay,
		).toBeNull();
		expect((await events(t, fixture.installationId))._yay!.events.at(-1)!.event).toEqual({
			kind: "refresh",
			reason: "permissions",
		});
		const snapshot = await t.mutation(internal.plugins_chitchat.get_snapshot, {
			installationId: String(fixture.installationId),
			serviceSecretHash: await crypto_sha256_hex(SERVICE_SECRET),
			cursor: null,
			startRevision: null,
		});
		expect(snapshot._yay!.members.find((member) => member.hostUserId === String(userId))).toMatchObject({
			active: true,
			canRead: true,
			canWrite: false,
			isOwner: false,
		});
	});

	test("publishes a profile refresh only when the display name changes", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		await t.run((ctx) => ctx.db.patch("users", fixture.userId, { clerkUserId: "profile-owner" }));
		await lease(t, fixture);
		const args = { clerkUserId: "profile-owner", displayName: "Updated name", email: "profile@tests.local" };
		expect((await t.mutation(internal.users.resolve_user, args))._yay!.userId).toBe(fixture.userId);
		expect((await events(t, fixture.installationId))._yay!.events).toEqual([
			{ revision: 1, event: { kind: "refresh", reason: "members" } },
		]);
		await t.mutation(internal.users.resolve_user, args);
		expect((await events(t, fixture.installationId))._yay!.currentRevision).toBe(1);
		expect((await lease(t, fixture))._yay!.displayName).toBe("Updated name");
	});

	test("keeps uninstall terminal events readable after the installation is removed", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		await lease(t, fixture);
		const owner = t.withIdentity({ issuer: "https://clerk.test", external_id: fixture.userId });
		expect(
			(
				await owner.mutation(api.plugins.uninstall_version, {
					membershipId: fixture.membershipId,
					installationId: fixture.installationId,
				})
			)._yay,
		).toBeNull();
		expect((await events(t, fixture.installationId))._yay!.events.at(-1)!.event).toEqual({
			kind: "revoked",
			reason: "uninstalled",
		});
		const snapshot = await t.fetch("/api/internal/plugins/chitchat/snapshot", {
			method: "POST",
			headers: { "X-Bonobo-Service-Authorization": `Bearer ${SERVICE_SECRET}`, "Content-Type": "application/json" },
			body: JSON.stringify({ installationId: fixture.installationId, cursor: null, startRevision: null }),
		});
		expect(snapshot.status).toBe(410);
		expect((await snapshot.json()).code).toBe("revoked");
		expect((await lease(t, fixture))._nay?.message).toBe("Unauthorized");
	});

	test("records removal before re-invite and never reuses its private membership lifetime", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		await lease(t, fixture);
		const owner = t.withIdentity({ issuer: "https://clerk.test", external_id: fixture.userId });
		const userId = await t.run((ctx) => ctx.db.insert("users", { clerkUserId: "invitee" }));
		const invite = () =>
			owner.mutation(api.organizations.invite_user_to_organization_workspace, {
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				userIdToAdd: userId,
			});
		expect((await invite())._yay).toBeNull();
		expect(
			(
				await owner.mutation(api.organizations.remove_user_from_organization, {
					organizationId: fixture.organizationId,
					userIdToRemove: userId,
				})
			)._yay,
		).toBeNull();
		await t.mutation(components.rate_limiter.lib.resetRateLimit, { name: "organizations_write", key: fixture.userId });
		expect((await invite())._yay).toBeNull();
		const result = await events(t, fixture.installationId);
		const memberEvents = result._yay!.events.flatMap(({ event }) =>
			event.kind === "member" && event.member.hostUserId === String(userId) ? [event.member] : [],
		);
		expect(memberEvents.map((member) => [member.active, member.membershipLifetime])).toEqual([
			[true, 1],
			[false, 2],
			[true, 2],
		]);
		expect(result._yay!.events.map((event) => event.revision)).toEqual(
			Array.from({ length: result._yay!.events.length }, (_, index) => index + 1),
		);
	});

	test("keeps global cursor order while redacting unrelated installations", async () => {
		const t = test_convex();
		const first = await seed_installation(t, "first-chat");
		const second = await seed_installation(t, "second-chat");
		await lease(t, first);
		await lease(t, second);
		const owner = t.withIdentity({ issuer: "https://clerk.test", external_id: first.userId });
		expect(
			(
				await owner.mutation(api.plugins_ui.revoke_ui_session, {
					membershipId: first.membershipId,
					sessionId: first.sessionId,
				})
			)._yay,
		).toEqual({});
		expect((await events(t, first.installationId))._yay!.events).toEqual([
			{ revision: 1, event: { kind: "session_revoked", hostSessionId: String(first.sessionId) } },
		]);
		expect((await events(t, second.installationId))._yay!.events).toEqual([{ revision: 1, event: { kind: "noop" } }]);
		expect((await lease(t, first))._nay?.message).toBe("Unauthorized");
	});

	test("keeps control events available after service-account revocation", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		await lease(t, fixture);
		const owner = t.withIdentity({ issuer: "https://clerk.test", external_id: fixture.userId });
		const userId = await t.run((ctx) => ctx.db.insert("users", { clerkUserId: "invitee" }));
		await owner.mutation(api.organizations.invite_user_to_organization_workspace, {
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			userIdToAdd: userId,
		});
		expect(
			(
				await owner.mutation(api.access_control.revoke_service_account, {
					membershipId: fixture.membershipId,
					serviceAccountId: fixture.serviceAccountId,
				})
			)._yay,
		).toBeNull();
		const result = await events(t, fixture.installationId);
		expect(result._yay!.events.some(({ event }) => event.kind === "member")).toBe(false);
		expect(result._yay!.events.at(-1)!.event).toEqual({ kind: "refresh", reason: "account" });
		const snapshot = await t.fetch("/api/internal/plugins/chitchat/snapshot", {
			method: "POST",
			headers: { "X-Bonobo-Service-Authorization": `Bearer ${SERVICE_SECRET}`, "Content-Type": "application/json" },
			body: JSON.stringify({ installationId: fixture.installationId, cursor: null, startRevision: null }),
		});
		expect(snapshot.status).toBe(409);
		expect((await snapshot.json()).code).toBe("unavailable");
		expect((await lease(t, fixture))._nay?.message).toBe("Unauthorized");
	});
});
