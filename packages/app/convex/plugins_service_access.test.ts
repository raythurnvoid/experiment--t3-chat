import { describe, expect, test, vi } from "vitest";
import { importSPKI, jwtVerify } from "jose";

import { api, components, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { access_control_changes_db_record } from "./access_control_changes.ts";
import { plugins_service_events_db_sync_receiver } from "./plugins_service_events.ts";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import { crypto_random_hex, crypto_sha256_hex } from "../server/crypto-utils.ts";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";
import type { plugins_Capability } from "../shared/plugins.ts";

const SERVICE_SECRET = "TASK_BOARD_TEST_SERVICE_SECRET";
const CAPABILITIES: plugins_Capability[] = ["plugin.service.connect", "workspace.members.read"];

async function seed_installation(args: {
	t: ReturnType<typeof test_convex>;
	organizationName?: string;
	pluginName?: string;
	secret?: string;
	userId?: Id<"users">;
}) {
	const { t, organizationName = "test-board", pluginName = "task-board", secret = SERVICE_SECRET, userId } = args;

	return await t.run(async (ctx) => {
		const membership = await test_mocks_fill_db_with.membership(ctx, { organizationName, userId });
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
			mounts: [],
			events: [],
			capabilities: CAPABILITIES,
			pages: [],
			fileViews: [],
			outboundOrigins: [],
			uiOutboundOrigins: [],
			mcpServers: [],
			mcpServersFingerprint: "mcp-servers-hash",
			skills: [],
			files: [],
			sourceStatus: "ready",
			sourceLastError: null,
			createdBy: membership.userId,
			updatedAt: now,
			secrets: [],
			endpoints: [],
			userWritableCollections: null,
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
			managementAccess: "selected",
			configurationYaml: null,
			acceptedCapabilities: CAPABILITIES,
			capabilitiesAcceptedAt: now,
			acceptedOutboundOrigins: [],
			acceptedUiOutboundOrigins: [],
			acceptedMcpServersFingerprint: "mcp-servers-hash",
			acceptedSkillNames: [],
			outboundOriginsAcceptedAt: now,
			sandbox: { roots: [], rebuild: null },
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

async function lease(args: {
	t: ReturnType<typeof test_convex>;
	fixture: Awaited<ReturnType<typeof seed_installation>>;
	requestedExpiresAt?: number;
}) {
	const { t, fixture, requestedExpiresAt = Date.now() + 30_000 } = args;

	return await t.mutation(internal.plugins_service_access.create_lease_facts, {
		tokenHash: fixture.tokenHash,
		serviceSecretHash: await crypto_sha256_hex(fixture.secret),
		exchangeId: crypto.randomUUID(),
		requestedExpiresAt,
	});
}

async function events(args: {
	t: ReturnType<typeof test_convex>;
	installationId: string;
	afterRevision?: number;
	limit?: number;
}) {
	const { t, afterRevision = 0, limit = 100, installationId } = args;

	return await t.mutation(internal.plugins_service_access.get_events, {
		installationId,
		afterRevision,
		limit,
		serviceSecretHash: await crypto_sha256_hex(SERVICE_SECRET),
	});
}

const REFRESH = { kind: "refresh", reason: "installation" } as const;

async function record(
	t: ReturnType<typeof test_convex>,
	changes: Array<Pick<Doc<"access_control_changes">, "scope" | "event">>,
) {
	await t.run((ctx) => access_control_changes_db_record(ctx, changes));
}

/**
 * Read every page of one installation's feed, like a plugin service does.
 */
async function all_events(args: {
	t: ReturnType<typeof test_convex>;
	installationId: string;
	afterRevision: number;
	limit: number;
}) {
	const { t, installationId, limit } = args;
	const pages = [];
	let afterRevision = args.afterRevision;
	for (;;) {
		const page = (await events({ t, installationId, afterRevision, limit }))._yay!;
		pages.push(page);
		afterRevision = page.continueRevision;
		if (page.isDone) return pages;
	}
}

describe("create_lease_facts", () => {
	test("starts the ledger only after a valid exchange and preserves its revision on later exchanges", async () => {
		const t = test_convex();
		const fixture = await seed_installation({ t });
		expect((await lease({ t, fixture: { ...fixture, secret: "wrong-proof" } }))._nay?.message).toBe("Unauthorized");
		expect(await t.run((ctx) => ctx.db.query("access_control_change_state").collect())).toEqual([]);
		expect(await t.run((ctx) => ctx.db.query("plugins_service_connections").collect())).toEqual([]);
		expect((await lease({ t, fixture }))._yay).toMatchObject({ membershipLifetime: 1, requiredRevision: 0 });
		const facts = await t.run(async (ctx) => ({
			state: await ctx.db.query("access_control_change_state").first(),
			retention: await ctx.db.query("access_control_change_retention").first(),
			lifetimes: await ctx.db.query("organizations_membership_lifetimes").collect(),
			connections: await ctx.db.query("plugins_service_connections").collect(),
		}));
		expect(facts.state).toMatchObject({ revision: 0 });
		expect(facts.retention).toMatchObject({ oldestRevision: 1, scopeHeadsFromRevision: 0 });
		expect(facts.lifetimes).toHaveLength(1);
		expect(facts.connections).toHaveLength(1);
		await record(t, [{ scope: { kind: "installation", installationId: fixture.installationId }, event: REFRESH }]);
		expect((await lease({ t, fixture }))._yay?.requiredRevision).toBe(1);
		expect((await events({ t, installationId: fixture.installationId }))._yay?.events).toEqual([
			{ revision: 1, event: REFRESH },
		]);
		expect(await t.run((ctx) => ctx.db.query("access_control_change_state").collect())).toHaveLength(1);
	});

	test("binds each ordinary plugin to its own registration secret and audience", async () => {
		const t = test_convex();
		const first = await seed_installation({ t });
		const second = await seed_installation({
			t,
			organizationName: "notes",
			pluginName: "report-notes",
			secret: "NOTES_SERVICE_SECRET",
		});
		expect((await lease({ t, fixture: first }))._yay?.audience).toBe("bonobo-plugin:task-board");
		expect((await lease({ t, fixture: second }))._yay?.audience).toBe("bonobo-plugin:report-notes");
		expect((await lease({ t, fixture: { ...second, secret: first.secret } }))._nay?.message).toBe("Unauthorized");
		expect((await lease({ t, fixture: { ...first, secret: second.secret } }))._nay?.message).toBe("Unauthorized");
		const denied = await t.mutation(internal.plugins_service_access.get_snapshot, {
			installationId: second.installationId,
			serviceSecretHash: await crypto_sha256_hex(first.secret),
			cursor: null,
			startRevision: null,
		});
		expect(denied._nay?.message).toBe("Unauthorized");
		expect((await events({ t, installationId: second.installationId }))._nay?.message).toBe("Unauthorized");
	});

	test("caps the absolute deadline and uses current Bonobo Senate identity without plugin-data scopes", async () => {
		const t = test_convex();
		const fixture = await seed_installation({ t });
		const requestedExpiresAt = Date.now() + 8_000;
		const result = await lease({ t, fixture, requestedExpiresAt });
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
		const capped = await lease({ t, fixture, requestedExpiresAt: Date.now() + 120_000 });
		expect(capped._yay!.expiresAt - capped._yay!.validatedAt).toBe(30_000);
		expect((await lease({ t, fixture, requestedExpiresAt: Date.now() - 1 }))._nay?.message).toBe("Lease has expired");
	});

	test("checks service proof, membership, consent, version and account each time", async () => {
		const t = test_convex();
		const fixture = await seed_installation({ t });
		const badSecret = await t.mutation(internal.plugins_service_access.create_lease_facts, {
			tokenHash: fixture.tokenHash,
			serviceSecretHash: "wrong",
			exchangeId: crypto.randomUUID(),
			requestedExpiresAt: Date.now() + 30_000,
		});
		expect(badSecret._nay?.message).toBe("Unauthorized");
		await t.run((ctx) => ctx.db.patch("organizations_workspaces_users", fixture.membershipId, { active: false }));
		expect((await lease({ t, fixture }))._nay?.message).toBe("Unauthorized");
		await t.run((ctx) => ctx.db.patch("organizations_workspaces_users", fixture.membershipId, { active: true }));
		await t.run((ctx) =>
			ctx.db.patch("plugins_workspace_installations", fixture.installationId, {
				acceptedCapabilities: ["plugin.service.connect"],
			}),
		);
		expect((await lease({ t, fixture }))._nay?.message).toBe("Unauthorized");
		await t.run((ctx) =>
			ctx.db.patch("plugins_workspace_installations", fixture.installationId, { acceptedCapabilities: CAPABILITIES }),
		);
		await t.run((ctx) =>
			ctx.db.patch("access_control_service_accounts", fixture.serviceAccountId, { revokedAt: Date.now() }),
		);
		expect((await lease({ t, fixture }))._nay?.message).toBe("Unauthorized");
	});
});

describe("/api/v1/plugins/identity/exchange", () => {
	test("refuses caller-selected identity and audience fields and limits failed proofs", async () => {
		const t = test_convex();
		const fixture = await seed_installation({ t });
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
		const fixture = await seed_installation({ t });
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
		const fixture = await seed_installation({ t });
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
		expect((await lease({ t, fixture: { ...fixture, secret: registered._yay!.exchangeSecret } }))._yay?.canRead).toBe(
			true,
		);
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
			const fixture = await seed_installation({ t });
			await lease({ t, fixture });
			const userId = await t.run(async (ctx) => {
				const userId = await ctx.db.insert("users", { clerkUserId: "not-yet-paged" });
				await ctx.db.insert("organizations_workspaces_users", {
					organizationId: fixture.organizationId,
					workspaceId: fixture.workspaceId,
					userId,
					active: true,
					pendingOrganizationRemoval: false,
					updatedAt: Date.now(),
					displayName: "",
					sortDisplayName: "",
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
			for (let index = 0; index < 20; index++) {
				expect(
					await t.run((ctx) =>
						rate_limiter_limit_by_key(ctx, {
							name: "public_api_principal",
							key: `plugin-members:${fixture.installationId}`,
						}),
					),
				).toBeNull();
			}
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
		const fixture = await seed_installation({ t });
		await lease({ t, fixture });
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
		expect((await lease({ t, fixture }))._nay?.message).toBe("Unauthorized");
		await t.run((ctx) => ctx.db.patch("plugins_ui_sessions", fixture.sessionId, { pluginVersionId: nextVersionId }));
		expect((await lease({ t, fixture }))._yay?.hostPluginVersionId).toBe(nextVersionId);
		expect((await snapshot())._yay?.members).toHaveLength(1);
		await t.run(async (ctx) => {
			const registration = await ctx.db.query("plugins_service_registrations").first();
			const { _id, _creationTime, ...fields } = registration!;
			await ctx.db.delete("plugins_service_registrations", _id);
			await ctx.db.insert("plugins_service_registrations", fields);
		});
		expect((await snapshot())._nay?.message).toBe("Unauthorized");
		expect((await lease({ t, fixture }))._nay).toBeUndefined();
		expect((await snapshot())._yay?.members).toHaveLength(1);
	});

	test("pages existing workspace members even when they have never opened the plugin", async () => {
		const t = test_convex();
		const fixture = await seed_installation({ t });
		await lease({ t, fixture });
		await t.run(async (ctx) => {
			for (let index = 0; index < 53; index++) {
				const userId = await ctx.db.insert("users", { clerkUserId: `member-${index}` });
				await ctx.db.insert("organizations_workspaces_users", {
					organizationId: fixture.organizationId,
					workspaceId: fixture.workspaceId,
					userId,
					active: true,
					pendingOrganizationRemoval: false,
					updatedAt: Date.now(),
					displayName: "",
					sortDisplayName: "",
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
			const fixture = await seed_installation({ t });
			await lease({ t, fixture });
			const request = (secret: string) =>
				t.fetch("/api/v1/plugins/access/changes", {
					method: "POST",
					headers: { "X-Bonobo-Service-Authorization": `Bearer ${secret}` },
					body: JSON.stringify({ installationId: fixture.installationId, afterRevision: 0, limit: 100 }),
				});
			expect((await request("wrong-proof")).status).toBe(401);
			for (let index = 0; index < 20; index++) expect((await request(fixture.secret)).status).toBe(200);
			expect((await events({ t, installationId: fixture.installationId }))._nay?.message).toBe("Rate limit exceeded");
			expect((await request(fixture.secret)).status).toBe(429);
		} finally {
			clock.mockRestore();
		}
	});

	test("publishes account-deletion tenant revocation before delayed content purge", async () => {
		const t = test_convex();
		const fixture = await seed_installation({ t });
		await lease({ t, fixture });
		await t.mutation(internal.data_deletion.init_user_deletion, { userId: fixture.userId });
		const result = await events({ t, installationId: fixture.installationId });
		expect(
			result._yay!.events.some(({ event }) => event.kind === "revoked" && event.reason === "organization_deleted"),
		).toBe(true);
		expect((await lease({ t, fixture }))._nay?.message).toBe("Unauthorized");
	});

	test("publishes role downgrades with the source write and snapshots current permissions", async () => {
		const t = test_convex();
		const fixture = await seed_installation({ t });
		await lease({ t, fixture });
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
		expect((await events({ t, installationId: fixture.installationId }))._yay!.events.at(-1)!.event).toEqual({
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

	test("publishes fresh member facts in each workspace only when the display name changes", async () => {
		vi.useFakeTimers();
		try {
			const t = test_convex();
			const fixture = await seed_installation({ t });
			const other = await seed_installation({ t, organizationName: "second-board", userId: fixture.userId });
			await t.run((ctx) => ctx.db.patch("users", fixture.userId, { clerkUserId: "profile-owner" }));
			await lease({ t, fixture });
			await lease({ t, fixture: other });
			const args = { clerkUserId: "profile-owner", displayName: "Updated name", email: "profile@tests.local" };
			expect((await t.mutation(internal.users.resolve_user, args))._yay!.userId).toBe(fixture.userId);
			await t.finishAllScheduledFunctions(vi.runAllTimers);

			for (const installation of [fixture, other]) {
				const result = (await events({ t, installationId: installation.installationId }))._yay!;
				expect(result.events.map(({ event }) => event)).toEqual([
					{
						kind: "member",
						member: expect.objectContaining({ hostUserId: String(fixture.userId), displayName: "Updated name" }),
					},
				]);
				expect(result.isDone).toBe(true);
			}

			await t.mutation(internal.users.resolve_user, args);
			await t.finishAllScheduledFunctions(vi.runAllTimers);
			expect((await events({ t, installationId: fixture.installationId }))._yay!.currentRevision).toBe(2);
			expect((await lease({ t, fixture }))._yay!.displayName).toBe("Updated name");
		} finally {
			vi.useRealTimers();
		}
	});

	test("keeps uninstall terminal events readable after the installation is removed", async () => {
		const t = test_convex();
		const fixture = await seed_installation({ t });
		await lease({ t, fixture });
		const owner = t.withIdentity({ issuer: "https://clerk.test", external_id: fixture.userId });
		expect(
			(
				await owner.mutation(api.plugins.uninstall_version, {
					membershipId: fixture.membershipId,
					installationId: fixture.installationId,
				})
			)._yay,
		).toBeNull();
		expect((await events({ t, installationId: fixture.installationId }))._yay!.events.at(-1)!.event).toEqual({
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
		expect((await lease({ t, fixture }))._nay?.message).toBe("Unauthorized");
	});

	test.each([true, false])("keeps membership lifetimes across re-invite with external feed %s", async (hasFeed) => {
		const t = test_convex();
		const fixture = await seed_installation({ t });
		if (hasFeed) await lease({ t, fixture });
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
		if (hasFeed) {
			const result = await events({ t, installationId: fixture.installationId });
			const memberEvents = result._yay!.events.flatMap(({ event }) =>
				event.kind === "member" && event.member.hostUserId === String(userId) ? [event.member] : [],
			);
			expect(memberEvents.map((member) => [member.active, member.membershipLifetime])).toEqual([
				[true, 1],
				[false, 2],
				[true, 2],
			]);
		} else {
			expect(await t.run((ctx) => ctx.db.query("access_control_change_state").collect())).toEqual([]);
			expect(await t.run((ctx) => ctx.db.query("access_control_changes").collect())).toEqual([]);
		}
		expect(
			await t.run((ctx) =>
				ctx.db
					.query("organizations_membership_lifetimes")
					.withIndex("by_workspace_user", (q) => q.eq("workspaceId", fixture.workspaceId).eq("userId", userId))
					.first(),
			),
		).toMatchObject({ active: true, lifetime: 2 });
	});

	test("returns no event of another tenant and still reaches the head", async () => {
		const t = test_convex();
		const first = await seed_installation({ t, organizationName: "first-chat" });
		const second = await seed_installation({ t, organizationName: "second-chat" });
		await lease({ t, fixture: first });
		await lease({ t, fixture: second });
		const owner = t.withIdentity({ issuer: "https://clerk.test", external_id: first.userId });
		expect(
			(
				await owner.mutation(api.plugins_ui.revoke_ui_session, {
					membershipId: first.membershipId,
					sessionId: first.sessionId,
				})
			)._yay,
		).toEqual({});
		expect((await events({ t, installationId: first.installationId }))._yay!.events).toEqual([
			{ revision: 1, event: { kind: "session_revoked", hostSessionId: String(first.sessionId) } },
		]);
		expect((await events({ t, installationId: second.installationId }))._yay).toEqual({
			events: [],
			currentRevision: 1,
			continueRevision: 1,
			isDone: true,
		});
		expect((await lease({ t, fixture: first }))._nay?.message).toBe("Unauthorized");
	});

	test("keeps control events available after service-account revocation", async () => {
		const t = test_convex();
		const fixture = await seed_installation({ t });
		await lease({ t, fixture });
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
		const result = await events({ t, installationId: fixture.installationId });
		expect(result._yay!.events.some(({ event }) => event.kind === "member")).toBe(false);
		expect(result._yay!.events.at(-1)!.event).toEqual({ kind: "refresh", reason: "account" });
		const snapshot = await t.fetch("/api/v1/plugins/members/list", {
			method: "POST",
			headers: { "X-Bonobo-Service-Authorization": `Bearer ${SERVICE_SECRET}`, "Content-Type": "application/json" },
			body: JSON.stringify({ installationId: fixture.installationId, cursor: null, startRevision: null }),
		});
		expect(snapshot.status).toBe(409);
		expect((await snapshot.json()).code).toBe("unavailable");
		expect((await lease({ t, fixture }))._nay?.message).toBe("Unauthorized");
	});

	test("reads only the installation's own scopes between many events of other tenants", async () => {
		const t = test_convex();
		const fixture = await seed_installation({ t });
		const other = await seed_installation({
			t,
			organizationName: "notes",
			pluginName: "report-notes",
			secret: "NOTES",
		});
		await lease({ t, fixture });
		const otherScopes = [
			{ kind: "installation", installationId: other.installationId },
			{ kind: "workspace", organizationId: other.organizationId, workspaceId: other.workspaceId },
			{ kind: "organization", organizationId: other.organizationId },
			{ kind: "plugin", pluginName: other.pluginName },
		] as const;
		const ownScopes = [
			{ kind: "workspace", organizationId: fixture.organizationId, workspaceId: fixture.workspaceId },
			{ kind: "organization", organizationId: fixture.organizationId },
			{ kind: "plugin", pluginName: fixture.pluginName },
		] as const;
		const changes: Array<Pick<Doc<"access_control_changes">, "scope" | "event">> = [];
		for (let index = 0; index < 150; index++) {
			changes.push({ scope: otherScopes[index % otherScopes.length]!, event: REFRESH });
			if (index % 50 === 25) changes.push({ scope: ownScopes[changes.length % ownScopes.length]!, event: REFRESH });
		}
		await record(t, changes);
		const ownRevisions = changes.flatMap((change, index) =>
			ownScopes.some((scope) => scope === change.scope) ? [index + 1] : [],
		);

		expect((await events({ t, installationId: fixture.installationId }))._yay).toEqual({
			events: ownRevisions.map((revision) => ({ revision, event: REFRESH })),
			currentRevision: 153,
			continueRevision: 153,
			isDone: true,
		});
	});

	test("pages interleaved scopes without losing an event at the cut", async () => {
		const t = test_convex();
		const fixture = await seed_installation({ t });
		await lease({ t, fixture });
		const changes: Array<Pick<Doc<"access_control_changes">, "scope" | "event">> = [];
		for (let index = 0; index < 120; index++) {
			changes.push({
				scope: { kind: "workspace", organizationId: fixture.organizationId, workspaceId: fixture.workspaceId },
				event: REFRESH,
			});
			changes.push({ scope: { kind: "installation", installationId: fixture.installationId }, event: REFRESH });
		}
		// One full range alone also fills a page. The page must still stop at that range's last doc.
		for (let index = 0; index < 230; index++) {
			changes.push({
				scope: { kind: "workspace", organizationId: fixture.organizationId, workspaceId: fixture.workspaceId },
				event: REFRESH,
			});
		}
		await record(t, changes);

		const pages = await all_events({ t, installationId: fixture.installationId, afterRevision: 0, limit: 100 });
		expect(pages.length).toBeGreaterThan(2);
		expect(pages.flatMap((page) => page.events.map((event) => event.revision))).toEqual(
			Array.from({ length: 470 }, (_, index) => index + 1),
		);
	});

	test("answers snapshot required only when retention deleted a change of this installation", async () => {
		const t = test_convex();
		const fixture = await seed_installation({ t });
		const other = await seed_installation({
			t,
			organizationName: "notes",
			pluginName: "report-notes",
			secret: "NOTES",
		});
		await lease({ t, fixture });
		await record(t, [{ scope: { kind: "installation", installationId: fixture.installationId }, event: REFRESH }]);
		await record(
			t,
			Array.from({ length: 200 }, () => ({
				scope: { kind: "installation" as const, installationId: other.installationId },
				event: REFRESH,
			})),
		);
		const set_dispatched = (dispatchedRevision: number) =>
			t.run(async (ctx) => {
				const dispatcher = await ctx.db.query("plugins_service_event_dispatcher").first();
				if (dispatcher) await ctx.db.patch("plugins_service_event_dispatcher", dispatcher._id, { dispatchedRevision });
				else await ctx.db.insert("plugins_service_event_dispatcher", { key: "main", jobId: null, dispatchedRevision });
			});
		const clean = async () => {
			const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31 * 24 * 60 * 60 * 1000);
			try {
				await t.mutation(internal.access_control_changes.delete_old_changes, { _test_disableReschedule: true });
			} finally {
				clock.mockRestore();
			}
			return await t.run(
				async (ctx) => (await ctx.db.query("access_control_change_retention").first())!.oldestRevision,
			);
		};

		// Keep the docs the notice dispatcher has not passed yet.
		await set_dispatched(150);
		expect(await clean()).toBe(151);
		await set_dispatched(201);
		expect(await clean()).toBe(202);

		// A cursor after this installation's last change lost nothing, so it skips to the head.
		expect((await events({ t, installationId: fixture.installationId, afterRevision: 1 }))._yay).toEqual({
			events: [],
			currentRevision: 201,
			continueRevision: 201,
			isDone: true,
		});
		const response = await t.fetch("/api/v1/plugins/access/changes", {
			method: "POST",
			headers: { "X-Bonobo-Service-Authorization": `Bearer ${SERVICE_SECRET}` },
			body: JSON.stringify({ installationId: fixture.installationId, afterRevision: 0, limit: 100 }),
		});
		expect(response.status).toBe(410);
		expect((await response.json()).code).toBe("snapshot_required");
	});

	test("creates a missing retention doc at the head, so an old cursor takes one new snapshot", async () => {
		const t = test_convex();
		const fixture = await seed_installation({ t });
		await lease({ t, fixture });
		await record(t, [
			{ scope: { kind: "installation", installationId: fixture.installationId }, event: REFRESH },
			{ scope: { kind: "installation", installationId: fixture.installationId }, event: REFRESH },
		]);
		await t.run(async (ctx) => {
			const retention = await ctx.db.query("access_control_change_retention").first();
			await ctx.db.delete("access_control_change_retention", retention!._id);
		});

		expect((await events({ t, installationId: fixture.installationId, afterRevision: 0 }))._nay?.message).toBe(
			"Snapshot required",
		);
		const snapshot = await t.mutation(internal.plugins_service_access.get_snapshot, {
			installationId: fixture.installationId,
			serviceSecretHash: await crypto_sha256_hex(SERVICE_SECRET),
			cursor: null,
			startRevision: null,
		});
		expect(snapshot._yay?.startRevision).toBe(2);
		expect((await events({ t, installationId: fixture.installationId, afterRevision: 2 }))._yay?.isDone).toBe(true);
	});
});

// The `plugins_service_events.ts` tests stay in this file on purpose. They reuse `seed_installation`,
// `lease`, `events`, and `record` above, and moving them would copy that setup.

const EVENTS_URL = "https://board.example.com/bonobo/events";
const NOTES_EVENTS_URL = "https://notes.example.com/events";
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Give the fixture's installation a notice receiver, like installing a version with `serviceEventsUrl`.
 */
async function seed_receiver(args: {
	t: ReturnType<typeof test_convex>;
	fixture: Awaited<ReturnType<typeof seed_installation>>;
	url?: string;
}) {
	const { t, fixture, url = EVENTS_URL } = args;

	await t.run((ctx) =>
		plugins_service_events_db_sync_receiver(ctx, {
			installationId: fixture.installationId,
			organizationId: fixture.organizationId,
			workspaceId: fixture.workspaceId,
			pluginName: fixture.pluginName,
			serviceAccountId: fixture.serviceAccountId,
			serviceEventsUrl: url,
		}),
	);
	return (await receiver_of(t, fixture.installationId))!;
}

async function receiver_of(t: ReturnType<typeof test_convex>, installationId: Id<"plugins_workspace_installations">) {
	return await t.run((ctx) =>
		ctx.db
			.query("plugins_service_event_receivers")
			.withIndex("by_installation", (q) => q.eq("installationId", installationId))
			.unique(),
	);
}

/**
 * Run the scheduled work one timer at a time, and let each job end before the clock moves again.
 *
 * `finishAllScheduledFunctions` keeps moving the fake clock while an action waits. Then the watchdog
 * fires while the notice action still runs, which a real deployment never does.
 */
async function drain_deliveries(t: ReturnType<typeof test_convex>) {
	const has_due_pending_job = () =>
		t.run(async (ctx) =>
			(await ctx.db.system.query("_scheduled_functions").collect()).some(
				(job) => job.state.kind === "pending" && job.scheduledTime <= Date.now(),
			),
		);

	for (let step = 0; step < 200 && vi.getTimerCount() > 0; step++) {
		vi.advanceTimersToNextTimer();
		// A fired job marks itself in progress only after a few awaits.
		while (await has_due_pending_job()) {
			vi.advanceTimersByTime(0);
			await new Promise<void>((resolve) => {
				const channel = new MessageChannel();
				channel.port2.onmessage = () => resolve();
				channel.port1.postMessage(null);
			});
		}
		await t.finishInProgressScheduledFunctions();
	}
}

/**
 * Stub `fetch` like a plugin server that answers every notice with 204.
 */
function stub_events_server() {
	const posts: Array<{ url: string; headers: Headers; body: string }> = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			posts.push({ url: String(input), headers: new Headers(init?.headers), body: String(init?.body) });
			return new Response(null, { status: 204 });
		}),
	);
	return posts;
}

/**
 * Sign the way a plugin server checks a Standard Webhooks signature: the HMAC-SHA256 of
 * `id.timestamp.body`, keyed with the base64-decoded part of the `whsec_` key.
 */
async function standard_webhooks_signature(key: string, id: string, timestamp: string, body: string) {
	const hmacKey = await crypto.subtle.importKey(
		"raw",
		Uint8Array.from(atob(key.slice("whsec_".length)), (char) => char.charCodeAt(0)),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign("HMAC", hmacKey, new TextEncoder().encode(`${id}.${timestamp}.${body}`));
	return `v1,${btoa(String.fromCharCode(...new Uint8Array(signature)))}`;
}

describe("dispatch", () => {
	test("ends when the head has no feed doc of its own", async () => {
		vi.useFakeTimers();
		try {
			const t = test_convex();
			const fixture = await seed_installation({ t });
			await lease({ t, fixture });

			// Revisions 2 to 5 have no doc, like a head put back by hand after a feed reset.
			await record(t, [{ scope: { kind: "installation", installationId: fixture.installationId }, event: REFRESH }]);
			await t.run(async (ctx) => {
				const state = await ctx.db.query("access_control_change_state").first();
				await ctx.db.patch("access_control_change_state", state!._id, { revision: 5 });
			});
			await drain_deliveries(t);

			expect(await t.run((ctx) => ctx.db.query("plugins_service_event_dispatcher").first())).toMatchObject({
				jobId: null,
				dispatchedRevision: 5,
			});
		} finally {
			vi.useRealTimers();
		}
	});

	test("sends each receiver few notices for its newest change, past more changes of others than one run reads", async () => {
		vi.useFakeTimers();
		const posts = stub_events_server();
		try {
			const t = test_convex();
			const fixture = await seed_installation({ t });
			const other = await seed_installation({
				t,
				organizationName: "notes",
				pluginName: "report-notes",
				secret: "NOTES",
			});
			await lease({ t, fixture });
			await seed_receiver({ t, fixture });
			await seed_receiver({ t, fixture: other, url: NOTES_EVENTS_URL });

			// 120 changes of the other tenant sit between the two changes of the first one. One dispatch run
			// reads 50 feed docs.
			await record(t, [{ scope: { kind: "installation", installationId: fixture.installationId }, event: REFRESH }]);
			await record(
				t,
				Array.from({ length: 120 }, () => ({
					scope: { kind: "workspace" as const, organizationId: other.organizationId, workspaceId: other.workspaceId },
					event: REFRESH,
				})),
			);
			await record(t, [{ scope: { kind: "organization", organizationId: fixture.organizationId }, event: REFRESH }]);
			await drain_deliveries(t);

			const revisions = (url: string) =>
				posts.filter((post) => post.url === url).map((post) => JSON.parse(post.body).data.revision as number);
			expect(revisions(EVENTS_URL).at(-1)).toBe(122);
			expect(revisions(EVENTS_URL).length).toBeLessThanOrEqual(2);
			expect(revisions(NOTES_EVENTS_URL).at(-1)).toBe(121);
			expect(revisions(NOTES_EVENTS_URL).length).toBeLessThanOrEqual(3);
			expect(await receiver_of(t, fixture.installationId)).toMatchObject({
				pendingRevision: 122,
				deliveredRevision: 122,
			});
			expect(await receiver_of(t, other.installationId)).toMatchObject({
				pendingRevision: 121,
				deliveredRevision: 121,
			});
		} finally {
			vi.unstubAllGlobals();
			vi.useRealTimers();
		}
	});

	test("ends a paused receiver at once when its installation is removed", async () => {
		vi.useFakeTimers();
		const posts = stub_events_server();
		try {
			const t = test_convex();
			const fixture = await seed_installation({ t });
			await lease({ t, fixture });
			const receiverId = (await seed_receiver({ t, fixture }))._id;
			await t.run((ctx) =>
				ctx.db.patch("plugins_service_event_receivers", receiverId, {
					pausedAt: Date.now(),
					failingSince: Date.now() - THREE_DAYS_MS,
				}),
			);

			await record(t, [
				{
					scope: { kind: "installation", installationId: fixture.installationId },
					event: { kind: "revoked", reason: "uninstalled" },
				},
			]);
			await drain_deliveries(t);
			expect(await receiver_of(t, fixture.installationId)).toBeNull();
			expect(posts).toEqual([]);
		} finally {
			vi.unstubAllGlobals();
			vi.useRealTimers();
		}
	});

	test("skips workspace notices while disabled and still sends the final notice", async () => {
		vi.useFakeTimers();
		const posts = stub_events_server();
		try {
			const t = test_convex();
			const fixture = await seed_installation({ t });
			await lease({ t, fixture });
			await seed_receiver({ t, fixture });
			const owner = t.withIdentity({ issuer: "https://clerk.test", external_id: fixture.userId });
			const workspaceScope = {
				kind: "workspace",
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
			} as const;

			// The disable writes revision 1. The workspace change after it gets no notice.
			expect(
				(
					await owner.mutation(api.plugins.disable_installation, {
						membershipId: fixture.membershipId,
						installationId: fixture.installationId,
					})
				)._yay,
			).toBeNull();
			await record(t, [{ scope: workspaceScope, event: REFRESH }]);
			await drain_deliveries(t);
			const revisions = () => posts.map((post) => JSON.parse(post.body).data.revision as number);
			expect(revisions()).toEqual([1]);

			// The final notice still reaches the disabled installation, and then the receiver ends.
			await record(t, [
				{
					scope: { kind: "installation", installationId: fixture.installationId },
					event: { kind: "revoked", reason: "uninstalled" },
				},
			]);
			await drain_deliveries(t);
			expect(revisions()).toEqual([1, 3]);
			expect(await receiver_of(t, fixture.installationId)).toBeNull();
		} finally {
			vi.unstubAllGlobals();
			vi.useRealTimers();
		}
	});
});

describe("deliver", () => {
	test("signs the notice with the Standard Webhooks scheme and the key the key route returns", async () => {
		// Check the test's own verifier against the Standard Webhooks spec example first.
		expect(
			await standard_webhooks_signature(
				"whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
				"msg_p5jXN8AQM9LWM0D4loKWxJek",
				"1614265330",
				'{"test": 2432232314}',
			),
		).toBe("v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");

		vi.useFakeTimers();
		const posts = stub_events_server();
		try {
			const t = test_convex();
			const fixture = await seed_installation({ t });
			await lease({ t, fixture });
			await seed_receiver({ t, fixture });
			await record(t, [{ scope: { kind: "installation", installationId: fixture.installationId }, event: REFRESH }]);
			await drain_deliveries(t);

			const response = await t.fetch("/api/v1/plugins/service-events/key", {
				method: "POST",
				headers: { "X-Bonobo-Service-Authorization": `Bearer ${SERVICE_SECRET}` },
				body: JSON.stringify({ pluginName: fixture.pluginName }),
			});
			expect(response.status).toBe(200);
			expect(response.headers.get("Cache-Control")).toBe("no-store");
			const { key } = (await response.json()) as { key: string };

			expect(posts).toHaveLength(1);
			const { headers, body } = posts[0]!;
			expect(headers.get("webhook-id")).toBe(`${fixture.installationId}:1`);
			expect(JSON.parse(body)).toEqual({
				type: "workspace.access.changed",
				timestamp: new Date(Number(headers.get("webhook-timestamp")) * 1000).toISOString(),
				data: { installationId: fixture.installationId, revision: 1 },
			});
			expect(headers.get("webhook-signature")).toBe(
				await standard_webhooks_signature(key, headers.get("webhook-id")!, headers.get("webhook-timestamp")!, body),
			);

			const denied = await t.fetch("/api/v1/plugins/service-events/key", {
				method: "POST",
				headers: { "X-Bonobo-Service-Authorization": "Bearer wrong-secret" },
				body: JSON.stringify({ pluginName: fixture.pluginName }),
			});
			expect(denied.status).toBe(401);
		} finally {
			vi.unstubAllGlobals();
			vi.useRealTimers();
		}
	});

	test("sends nothing to a host the fetch guard refuses", async () => {
		vi.useFakeTimers();
		vi.stubEnv("MCP_DENIED_HOSTS", new URL(EVENTS_URL).hostname);
		const posts = stub_events_server();
		try {
			const t = test_convex();
			const fixture = await seed_installation({ t });
			await lease({ t, fixture });
			await seed_receiver({ t, fixture });
			await record(t, [{ scope: { kind: "installation", installationId: fixture.installationId }, event: REFRESH }]);
			await drain_deliveries(t);

			expect(posts).toHaveLength(0);
			expect(await receiver_of(t, fixture.installationId)).toMatchObject({ lastStatus: 0, deliveredRevision: 0 });
		} finally {
			vi.unstubAllEnvs();
			vi.unstubAllGlobals();
			vi.useRealTimers();
		}
	});
});

describe("get_signing_key", () => {
	test("wakes no paused receiver", async () => {
		// Check the receiver right after the call. Running the timers would retry, fail, and pause it again.
		vi.useFakeTimers();
		try {
			const t = test_convex();
			const fixture = await seed_installation({ t });
			await lease({ t, fixture });
			const receiverId = (await seed_receiver({ t, fixture }))._id;
			await t.run((ctx) =>
				ctx.db.patch("plugins_service_event_receivers", receiverId, {
					pendingRevision: 1,
					pausedAt: Date.now(),
					failingSince: Date.now() - THREE_DAYS_MS,
				}),
			);
			const paused = await receiver_of(t, fixture.installationId);

			const response = await t.fetch("/api/v1/plugins/service-events/key", {
				method: "POST",
				headers: { "X-Bonobo-Service-Authorization": `Bearer ${SERVICE_SECRET}` },
				body: JSON.stringify({ pluginName: fixture.pluginName }),
			});
			expect(response.status).toBe(200);
			expect(await receiver_of(t, fixture.installationId)).toEqual(paused);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("record_delivery", () => {
	// These tests call the delivery steps by hand. Fake timers keep the scheduled steps from running.
	test("ignores the late answer of a try the watchdog already replaced", async () => {
		vi.useFakeTimers();
		try {
			const t = test_convex();
			const fixture = await seed_installation({ t });
			await lease({ t, fixture });
			const receiverId = (await seed_receiver({ t, fixture }))._id;
			await t.run((ctx) => ctx.db.patch("plugins_service_event_receivers", receiverId, { pendingRevision: 1 }));

			// The second call is the watchdog of a try that never answered.
			await t.mutation(internal.plugins_service_events.start_delivery, { receiverId });
			const deadClaim = (await receiver_of(t, fixture.installationId))!.claim!;
			await t.mutation(internal.plugins_service_events.start_delivery, { receiverId });
			const retry = (await receiver_of(t, fixture.installationId))!;
			expect(retry).toMatchObject({ attempt: 1, failingSince: expect.any(Number), deliveredRevision: 0 });
			expect(retry.claim).not.toBe(deadClaim);

			const answer = { receiverId, revision: 1, status: 204, retryAfterSeconds: null };
			await t.mutation(internal.plugins_service_events.record_delivery, { ...answer, claim: deadClaim });
			expect(await receiver_of(t, fixture.installationId)).toMatchObject({ claim: retry.claim, deliveredRevision: 0 });

			await t.mutation(internal.plugins_service_events.record_delivery, { ...answer, claim: retry.claim! });
			expect(await receiver_of(t, fixture.installationId)).toMatchObject({
				claim: null,
				attempt: 0,
				failingSince: null,
				deliveredRevision: 1,
			});
		} finally {
			vi.useRealTimers();
		}
	});

	test("backs off, and waits as Retry-After asks", async () => {
		vi.useFakeTimers();
		try {
			const t = test_convex();
			const fixture = await seed_installation({ t });
			await lease({ t, fixture });
			const receiverId = (await seed_receiver({ t, fixture }))._id;
			await t.run((ctx) => ctx.db.patch("plugins_service_event_receivers", receiverId, { pendingRevision: 1 }));
			const answer = async (status: number, retryAfterSeconds: number | null) => {
				await t.mutation(internal.plugins_service_events.start_delivery, { receiverId });
				const claim = (await receiver_of(t, fixture.installationId))!.claim!;
				await t.mutation(internal.plugins_service_events.record_delivery, {
					receiverId,
					claim,
					revision: 1,
					status,
					retryAfterSeconds,
				});
				const receiver = (await receiver_of(t, fixture.installationId))!;
				const job = await t.run((ctx) => ctx.db.system.get("_scheduled_functions", receiver.wakeJobId!));
				return { attempt: receiver.attempt, delaySeconds: (job!.scheduledTime - Date.now()) / 1000 };
			};

			expect(await answer(500, null)).toEqual({ attempt: 1, delaySeconds: 5 });
			expect(await answer(500, null)).toEqual({ attempt: 2, delaySeconds: 30 });
			// A service that is catching up asks for its own wait, at most 1 hour. It made progress, so the
			// next failure starts the delays again.
			expect(await answer(503, 99_999)).toEqual({ attempt: 0, delaySeconds: 3600 });
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("plugins_service_events_db_wake_installation", () => {
	test("a pull wakes a receiver that paused after 3 days of failures", async () => {
		vi.useFakeTimers();
		try {
			const t = test_convex();
			const fixture = await seed_installation({ t });
			await lease({ t, fixture });
			const receiverId = (await seed_receiver({ t, fixture }))._id;
			await t.run((ctx) =>
				ctx.db.patch("plugins_service_event_receivers", receiverId, {
					pendingRevision: 1,
					failingSince: Date.now() - THREE_DAYS_MS,
				}),
			);

			// The next try after 3 days of failures pauses the receiver instead of sending.
			await t.mutation(internal.plugins_service_events.start_delivery, { receiverId });
			expect(await receiver_of(t, fixture.installationId)).toMatchObject({
				pausedAt: expect.any(Number),
				claim: null,
				wakeJobId: null,
			});

			// A pull shows the server is back, so the waiting notice goes out at once.
			expect((await events({ t, installationId: fixture.installationId }))._yay).toBeDefined();
			const woken = (await receiver_of(t, fixture.installationId))!;
			expect(woken).toMatchObject({ pausedAt: null, failingSince: null, attempt: 0 });
			expect(await t.run((ctx) => ctx.db.system.get("_scheduled_functions", woken.wakeJobId!))).toMatchObject({
				scheduledTime: Date.now(),
				state: { kind: "pending" },
			});
		} finally {
			vi.useRealTimers();
		}
	});

	test("a pull during a try keeps the failure state", async () => {
		vi.useFakeTimers();
		try {
			const t = test_convex();
			const fixture = await seed_installation({ t });
			await lease({ t, fixture });
			const receiverId = (await seed_receiver({ t, fixture }))._id;
			await t.run((ctx) => ctx.db.patch("plugins_service_event_receivers", receiverId, { pendingRevision: 1 }));
			await t.mutation(internal.plugins_service_events.start_delivery, { receiverId });
			await t.run((ctx) =>
				ctx.db.patch("plugins_service_event_receivers", receiverId, {
					attempt: 2,
					failingSince: Date.now() - 60_000,
				}),
			);
			const inFlight = await receiver_of(t, fixture.installationId);

			// The plugin server pulls inside the delivery, before it answers.
			expect((await events({ t, installationId: fixture.installationId }))._yay).toBeDefined();
			expect(await receiver_of(t, fixture.installationId)).toEqual(inFlight);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("plugins_service_events_db_sync_receiver", () => {
	test("a new URL wakes a paused receiver at once", async () => {
		vi.useFakeTimers();
		try {
			const t = test_convex();
			const fixture = await seed_installation({ t });
			await lease({ t, fixture });
			const receiverId = (await seed_receiver({ t, fixture }))._id;
			await t.run((ctx) =>
				ctx.db.patch("plugins_service_event_receivers", receiverId, {
					pendingRevision: 1,
					pausedAt: Date.now(),
					failingSince: Date.now() - THREE_DAYS_MS,
					attempt: 9,
				}),
			);

			const moved = await seed_receiver({ t, fixture, url: NOTES_EVENTS_URL });
			expect(moved).toMatchObject({ url: NOTES_EVENTS_URL, pausedAt: null, failingSince: null, attempt: 0 });
			expect(await t.run((ctx) => ctx.db.system.get("_scheduled_functions", moved.wakeJobId!))).toMatchObject({
				scheduledTime: Date.now(),
				state: { kind: "pending" },
			});
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("start_delivery", () => {
	test("ends a revoked receiver after its last notice, or after 3 days of failures", async () => {
		vi.useFakeTimers();
		const posts = stub_events_server();
		try {
			const t = test_convex();
			const fixture = await seed_installation({ t });
			const other = await seed_installation({
				t,
				organizationName: "notes",
				pluginName: "report-notes",
				secret: "NOTES",
			});
			await lease({ t, fixture });
			await seed_receiver({ t, fixture });
			const revoked = { kind: "revoked", reason: "uninstalled" } as const;
			await record(t, [{ scope: { kind: "installation", installationId: fixture.installationId }, event: revoked }]);
			await drain_deliveries(t);
			expect(posts.map((post) => JSON.parse(post.body).data.revision)).toEqual([1]);
			expect(await receiver_of(t, fixture.installationId)).toBeNull();

			// A server that never answers still ends its revoked receiver after 3 days.
			const receiverId = (await seed_receiver({ t, fixture: other, url: NOTES_EVENTS_URL }))._id;
			await t.run((ctx) =>
				ctx.db.patch("plugins_service_event_receivers", receiverId, { failingSince: Date.now() - THREE_DAYS_MS }),
			);
			await record(t, [{ scope: { kind: "installation", installationId: other.installationId }, event: revoked }]);
			await drain_deliveries(t);
			expect(await receiver_of(t, other.installationId)).toBeNull();
			expect(posts).toHaveLength(1);
		} finally {
			vi.unstubAllGlobals();
			vi.useRealTimers();
		}
	});
});
