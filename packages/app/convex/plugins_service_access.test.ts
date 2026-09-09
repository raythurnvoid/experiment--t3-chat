import { describe, expect, test, vi } from "vitest";
import { importSPKI, jwtVerify } from "jose";

import { api, components, internal } from "./_generated/api.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import { crypto_random_hex, crypto_sha256_hex } from "../server/crypto-utils.ts";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";
import type { plugins_Capability } from "../shared/plugins.ts";

const SERVICE_SECRET = "TASK_BOARD_TEST_SERVICE_SECRET";
const CAPABILITIES: plugins_Capability[] = ["plugin.service.connect", "workspace.members.read"];

async function seed_installation(
	t: ReturnType<typeof test_convex>,
	organizationName = "test-board",
	pluginName = "task-board",
	secret = SERVICE_SECRET,
) {
	return await t.run(async (ctx) => {
		const membership = await test_mocks_fill_db_with.membership(ctx, { organizationName });
		const now = Date.now();
		const pluginVersionId = await ctx.db.insert("plugins_versions", {
			name: pluginName,
			displayName: "Task Board",
			version: "1.0.0",
			description: "Workspace tasks",
			reviewStatus: "passed",
			reviewId: null,
			isLatest: true,
			artifactHash: `sha256:${"a".repeat(64)}`,
			sourceRepositoryUrl: `https://github.com/bonobo/${pluginName}`,
			sourceOwner: "bonobo",
			sourceRepo: pluginName,
			sourceCommitSha: "1234567890abcdef1234567890abcdef12345678",
			manifestR2Key: `plugins/${pluginName}/manifest.json`,
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
			pluginName,
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
				.withIndex("by_pluginName", (q) => q.eq("pluginName", pluginName))
				.first())
		) {
			await ctx.db.insert("plugins_service_registrations", {
				pluginName,
				exchangeSecretHash: await crypto_sha256_hex(secret),
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
		return {
			...membership,
			pluginVersionId,
			serviceAccountId,
			installationId,
			sessionId,
			token,
			tokenHash,
			pluginName,
			secret,
		};
	});
}

async function lease(
	t: ReturnType<typeof test_convex>,
	fixture: Awaited<ReturnType<typeof seed_installation>>,
	requestedExpiresAt = Date.now() + 30_000,
) {
	return await t.mutation(internal.plugins_service_access.create_lease_facts, {
		tokenHash: fixture.tokenHash,
		serviceSecretHash: await crypto_sha256_hex(fixture.secret),
		exchangeId: crypto.randomUUID(),
		requestedExpiresAt,
	});
}

async function events(t: ReturnType<typeof test_convex>, installationId: string, afterRevision = 0, limit = 100) {
	return await t.mutation(internal.plugins_service_access.get_events, {
		installationId,
		afterRevision,
		limit,
		serviceSecretHash: await crypto_sha256_hex(SERVICE_SECRET),
	});
}

describe("create_lease_facts", () => {
	test("starts the ledger only after a valid exchange and preserves its revision on later exchanges", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		expect((await lease(t, { ...fixture, secret: "wrong-proof" }))._nay?.message).toBe("Unauthorized");
		expect(await t.run((ctx) => ctx.db.query("access_control_change_state").collect())).toEqual([]);
		expect(await t.run((ctx) => ctx.db.query("plugins_service_connections").collect())).toEqual([]);
		expect((await lease(t, fixture))._yay).toMatchObject({ membershipLifetime: 1, requiredRevision: 0 });
		const facts = await t.run(async (ctx) => ({
			state: await ctx.db.query("access_control_change_state").first(),
			lifetimes: await ctx.db.query("organizations_membership_lifetimes").collect(),
			connections: await ctx.db.query("plugins_service_connections").collect(),
		}));
		expect(facts.state).toMatchObject({ revision: 0, oldestRevision: 1 });
		expect(facts.lifetimes).toHaveLength(1);
		expect(facts.connections).toHaveLength(1);
		await t.run((ctx) => ctx.db.patch("users", fixture.userId, { clerkUserId: "new-deployment-owner" }));
		await t.mutation(internal.users.resolve_user, {
			clerkUserId: "new-deployment-owner",
			displayName: "Updated owner",
			email: "owner@tests.local",
		});
		expect((await lease(t, fixture))._yay?.requiredRevision).toBe(1);
		expect((await events(t, fixture.installationId))._yay?.events).toEqual([
			{ revision: 1, event: { kind: "refresh", reason: "members" } },
		]);
		expect(await t.run((ctx) => ctx.db.query("access_control_change_state").collect())).toHaveLength(1);
	});

	test("binds each ordinary plugin to its own registration secret and audience", async () => {
		const t = test_convex();
		const first = await seed_installation(t);
		const second = await seed_installation(t, "notes", "report-notes", "NOTES_SERVICE_SECRET");
		expect((await lease(t, first))._yay?.audience).toBe("bonobo-plugin:task-board");
		expect((await lease(t, second))._yay?.audience).toBe("bonobo-plugin:report-notes");
		expect((await lease(t, { ...second, secret: first.secret }))._nay?.message).toBe("Unauthorized");
		expect((await lease(t, { ...first, secret: second.secret }))._nay?.message).toBe("Unauthorized");
		const denied = await t.mutation(internal.plugins_service_access.get_snapshot, {
			installationId: second.installationId,
			serviceSecretHash: await crypto_sha256_hex(first.secret),
			cursor: null,
			startRevision: null,
		});
		expect(denied._nay?.message).toBe("Unauthorized");
		expect((await events(t, second.installationId))._nay?.message).toBe("Unauthorized");
	});

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
		const badSecret = await t.mutation(internal.plugins_service_access.create_lease_facts, {
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

describe("/api/v1/plugins/identity/exchange", () => {
	test("refuses caller-selected identity and audience fields and limits failed proofs", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const response = await t.fetch("/api/v1/plugins/identity/exchange", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${fixture.token}`,
				"X-Bonobo-Service-Authorization": `Bearer ${SERVICE_SECRET}`,
			},
			body: JSON.stringify({
				exchangeId: "forged",
				requestedExpiresAt: Date.now() + 20_000,
				audience: "another-app",
				hostUserId: fixture.userId,
			}),
		});
		expect(response.status).toBe(400);
		for (let attempt = 0; attempt < 11; attempt++) {
			const denied = await t.fetch("/api/v1/plugins/identity/exchange", { method: "POST" });
			expect(denied.status).toBe(attempt < 10 ? 401 : 429);
		}
	});

	test("signs the dedicated issuer, audience and custom exchangeId", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		const exchangeId = crypto.randomUUID();
		const requestedExpiresAt = Date.now() + 20_000;
		const response = await t.fetch("/api/v1/plugins/identity/exchange", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${fixture.token}`,
				"X-Bonobo-Service-Authorization": `Bearer ${SERVICE_SECRET}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ exchangeId, requestedExpiresAt }),
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		const body = await response.json();
		const verified = await jwtVerify(
			body.jwt,
			await importSPKI(process.env.ANONYMOUS_USERS_JWT_PUBLIC_KEY_PEM!, "ES256"),
			{
				issuer: `${process.env.VITE_CONVEX_HTTP_URL}/plugins-services`,
				audience: "bonobo-plugin:task-board",
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
		await expect(
			jwtVerify(body.jwt, await importSPKI(process.env.ANONYMOUS_USERS_JWT_PUBLIC_KEY_PEM!, "ES256"), {
				issuer: `${process.env.VITE_CONVEX_HTTP_URL}/plugins-services`,
				audience: "bonobo-plugin:report-notes",
				algorithms: ["ES256"],
			}),
		).rejects.toThrow();
	});
});

describe("set_plugin_service_registration", () => {
	test("accepts empty scopes for member-only identity without granting file access", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		await t.run((ctx) =>
			ctx.db.insert("plugins_publisher_repositories", {
				ownerUserId: fixture.userId,
				repositoryUrl: `https://github.com/bonobo/${fixture.pluginName}`,
				owner: "bonobo",
				repo: fixture.pluginName,
			}),
		);
		const publisher = t.withIdentity({ issuer: "https://clerk.test", external_id: fixture.userId });
		const registered = await publisher.mutation(api.plugins.set_plugin_service_registration, {
			pluginName: fixture.pluginName,
			scopes: [],
		});
		expect(registered._nay).toBeUndefined();
		expect((await lease(t, { ...fixture, secret: registered._yay!.exchangeSecret }))._yay?.canRead).toBe(true);
		expect(
			(await publisher.query(api.plugins.get_plugin_service_registration, { pluginName: fixture.pluginName }))!.scopes,
		).toEqual([]);
		const grant = await t.fetch("/api/v1/plugins/service-grants/exchange", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${fixture.token}`,
				"X-Bonobo-Service-Authorization": `Bearer ${registered._yay!.exchangeSecret}`,
			},
			body: "{}",
		});
		expect(grant.status).toBe(400);
		expect(await grant.json()).toEqual({ message: "At least one scope is required" });
		expect(await t.run((ctx) => ctx.db.query("plugin_service_grants").collect())).toEqual([]);
	});
});

describe("get_snapshot", () => {
	test("limits an authenticated page before creating member lifetime facts", async () => {
		const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
		try {
			const t = test_convex();
			const fixture = await seed_installation(t);
			await lease(t, fixture);
			const userId = await t.run(async (ctx) => {
				const userId = await ctx.db.insert("users", { clerkUserId: "not-yet-paged" });
				await ctx.db.insert("organizations_workspaces_users", {
					organizationId: fixture.organizationId,
					workspaceId: fixture.workspaceId,
					userId,
					active: true,
				});
				return userId;
			});
			const request = (secret: string) =>
				t.fetch("/api/v1/plugins/members/list", {
					method: "POST",
					headers: { "X-Bonobo-Service-Authorization": `Bearer ${secret}` },
					body: JSON.stringify({ installationId: fixture.installationId, cursor: null, startRevision: null }),
				});
			expect((await request("wrong-proof")).status).toBe(401);
			expect(
				await t.run((ctx) =>
					rate_limiter_limit_by_key(ctx, {
						name: "public_api_principal",
						key: `plugin-members:${fixture.installationId}`,
						count: 20,
					}),
				),
			).toBeNull();
			expect((await request(fixture.secret)).status).toBe(429);
			expect(
				await t.run((ctx) =>
					ctx.db
						.query("organizations_membership_lifetimes")
						.withIndex("by_workspace_user", (q) => q.eq("workspaceId", fixture.workspaceId).eq("userId", userId))
						.first(),
				),
			).toBeNull();
		} finally {
			clock.mockRestore();
		}
	});

	test("requires a fresh page exchange after a version change or registration replacement", async () => {
		const t = test_convex();
		const fixture = await seed_installation(t);
		await lease(t, fixture);
		const snapshot = async () =>
			t.mutation(internal.plugins_service_access.get_snapshot, {
				installationId: fixture.installationId,
				serviceSecretHash: await crypto_sha256_hex(fixture.secret),
				cursor: null,
				startRevision: null,
			});
		const nextVersionId = await t.run(async (ctx) => {
			const version = await ctx.db.get("plugins_versions", fixture.pluginVersionId);
			const { _id, _creationTime, ...fields } = version!;
			const id = await ctx.db.insert("plugins_versions", { ...fields, version: "1.0.1" });
			await ctx.db.patch("plugins_workspace_installations", fixture.installationId, { pluginVersionId: id });
			return id;
		});
		expect((await snapshot())._nay?.message).toBe("Installation is unavailable");
		expect((await lease(t, fixture))._nay?.message).toBe("Unauthorized");
		await t.run((ctx) => ctx.db.patch("plugins_ui_sessions", fixture.sessionId, { pluginVersionId: nextVersionId }));
		expect((await lease(t, fixture))._yay?.hostPluginVersionId).toBe(nextVersionId);
		expect((await snapshot())._yay?.members).toHaveLength(1);
		await t.run(async (ctx) => {
			const registration = await ctx.db.query("plugins_service_registrations").first();
			const { _id, _creationTime, ...fields } = registration!;
			await ctx.db.delete("plugins_service_registrations", _id);
			await ctx.db.insert("plugins_service_registrations", fields);
		});
		expect((await snapshot())._nay?.message).toBe("Unauthorized");
		expect((await lease(t, fixture))._nay).toBeUndefined();
		expect((await snapshot())._yay?.members).toHaveLength(1);
	});

	test("pages existing workspace members even when they have never opened the plugin", async () => {
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
		const first = await t.mutation(internal.plugins_service_access.get_snapshot, {
			...args,
			cursor: null,
			startRevision: null,
		});
		expect(first._yay!.members).toHaveLength(50);
		expect(first._yay!.continueCursor).not.toBeNull();
		const second = await t.mutation(internal.plugins_service_access.get_snapshot, {
			...args,
			cursor: first._yay!.continueCursor,
			startRevision: first._yay!.startRevision,
		});
		expect(second._yay!.members).toHaveLength(4);
		expect(second._yay!.continueCursor).toBeNull();
		expect(first._yay!.members.every((member) => member.membershipLifetime === 1)).toBe(true);
		const invalidContinuation = await t.mutation(internal.plugins_service_access.get_snapshot, {
			...args,
			cursor: first._yay!.continueCursor,
			startRevision: null,
		});
		expect(invalidContinuation._nay?.message).toBe("Snapshot required");
	});
});

describe("get_events", () => {
	test("charges one page token only after checking the service proof", async () => {
		const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
		try {
			const t = test_convex();
			const fixture = await seed_installation(t);
			await lease(t, fixture);
			const request = (secret: string) =>
				t.fetch("/api/v1/plugins/access/changes", {
					method: "POST",
					headers: { "X-Bonobo-Service-Authorization": `Bearer ${secret}` },
					body: JSON.stringify({ installationId: fixture.installationId, afterRevision: 0, limit: 100 }),
				});
			expect((await request("wrong-proof")).status).toBe(401);
			for (let index = 0; index < 20; index++) expect((await request(fixture.secret)).status).toBe(200);
			expect((await events(t, fixture.installationId))._nay?.message).toBe("Rate limit exceeded");
			expect((await request(fixture.secret)).status).toBe(429);
		} finally {
			clock.mockRestore();
		}
	});

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
		const snapshot = await t.mutation(internal.plugins_service_access.get_snapshot, {
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
		const snapshot = await t.fetch("/api/v1/plugins/members/list", {
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
		expect(
			await t.run((ctx) =>
				ctx.db
					.query("organizations_membership_lifetimes")
					.withIndex("by_workspace_user", (q) => q.eq("workspaceId", fixture.workspaceId).eq("userId", userId))
					.first(),
			),
		).toMatchObject({ active: true, lifetime: 2 });
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
		const snapshot = await t.fetch("/api/v1/plugins/members/list", {
			method: "POST",
			headers: { "X-Bonobo-Service-Authorization": `Bearer ${SERVICE_SECRET}`, "Content-Type": "application/json" },
			body: JSON.stringify({ installationId: fixture.installationId, cursor: null, startRevision: null }),
		});
		expect(snapshot.status).toBe(409);
		expect((await snapshot.json()).code).toBe("unavailable");
		expect((await lease(t, fixture))._nay?.message).toBe("Unauthorized");
	});
});
