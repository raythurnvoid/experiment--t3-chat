import { R2 } from "@convex-dev/r2";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { plugins_mcp_custom_secret_additional_data } from "./plugins_mcp.ts";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import { crypto_decrypt_secret_value } from "../server/crypto-utils.ts";
import { mcp_fixtures_create } from "../server/mcp-fixtures/mcp-fixtures.ts";
import { mcp_oauth_fixtures_create } from "../server/mcp-fixtures/mcp-oauth-fixtures.ts";

let fixtures: ReturnType<typeof mcp_fixtures_create>;
let oauthFixtures: ReturnType<typeof mcp_oauth_fixtures_create>;

beforeEach(() => {
	fixtures = mcp_fixtures_create();
	oauthFixtures = mcp_oauth_fixtures_create();
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	// Only the fake MCP servers answer. Any other outside request would be a bug in the test.
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const request = new Request(input, init);
			// A fake sign-in server and two MCP servers that need its tokens.
			if (new URL(request.url).hostname.endsWith(".oauth.test")) {
				return await oauthFixtures.fetch(request);
			}
			if (!new URL(request.url).hostname.endsWith(".fixtures.test")) {
				return new Response(null, { status: 404 });
			}
			return await fixtures.fetch(request);
		}),
	);
});

afterEach(async () => {
	await fixtures.close();
	await oauthFixtures.close();
	vi.unstubAllEnvs();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

type TestConvex = ReturnType<typeof test_convex>;
type Member = Awaited<ReturnType<typeof add_member>>;

const FIXTURE_URL = "https://modern-basic.fixtures.test/mcp";

function user_identity(userId: Id<"users">) {
	return { issuer: "https://clerk.test", external_id: userId };
}

/**
 * The owner's custom organization. It allows every MCP server unless `integrationPolicy` is null.
 */
async function setup(args?: { integrationPolicy?: null }) {
	const t = test_convex();
	const owner = await t.run((ctx) =>
		test_mocks_fill_db_with.membership(ctx, { workspaceName: "home", integrationPolicy: args?.integrationPolicy }),
	);
	return { t, owner, asOwner: t.withIdentity(user_identity(owner.userId)) };
}

/**
 * Invite a new user into the owner's workspace with the given role.
 */
async function add_member(args: {
	t: TestConvex;
	owner: Awaited<ReturnType<typeof setup>>["owner"];
	role?: "member" | "viewer";
}) {
	const { t, owner, role = "member" } = args;

	const user = await t.run((ctx) =>
		test_mocks_fill_db_with.membership(ctx, { organizationName: "personal", workspaceName: "home" }),
	);
	const asOwner = t.withIdentity(user_identity(owner.userId));
	const invited = await asOwner.mutation(api.organizations.invite_user_to_organization_workspace, {
		organizationId: owner.organizationId,
		workspaceId: owner.workspaceId,
		userIdToAdd: user.userId,
	});
	if (invited._nay) throw new Error(invited._nay.message);
	if (role === "viewer") {
		const changed = await asOwner.mutation(api.access_control.set_user_role, {
			organizationId: owner.organizationId,
			workspaceId: owner.workspaceId,
			userId: user.userId,
			role: "viewer",
		});
		if (changed._nay) throw new Error(changed._nay.message);
	}

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
		personalMembershipId: user.membershipId,
		asUser: t.withIdentity(user_identity(user.userId)),
	};
}

/**
 * Paste one server entry named `name` and save it with the given values.
 */
async function save(
	member: Pick<Member, "asUser" | "membershipId">,
	args: {
		name?: string;
		url?: string;
		headers?: Record<string, string>;
		customServerId?: Id<"mcp_custom_servers">;
		secretValues?: Array<{ name: string; value: string }>;
		keptSecretNames?: string[];
		notSecretHeaders?: string[];
	},
) {
	const name = args.name ?? "fixture";
	return await member.asUser.action(api.mcp_custom_servers.save, {
		membershipId: member.membershipId,
		customServerId: args.customServerId ?? null,
		text: JSON.stringify({ mcpServers: { [name]: { url: args.url ?? FIXTURE_URL, headers: args.headers ?? {} } } }),
		draftKey: name,
		fill: {
			name,
			urlFields: [],
			notSecretHeaders: args.notSecretHeaders ?? [],
			secretValues: args.secretValues ?? [],
			keptSecretNames: args.keptSecretNames ?? [],
		},
	});
}

function saved_id(result: Awaited<ReturnType<typeof save>>) {
	if (result._nay) throw new Error(result._nay.message);
	return result._yay.customServerId;
}

/**
 * Write one server the way `save` does after its probe, with no fetch and no rate limit.
 */
async function write_server(args: {
	t: TestConvex;
	member: Pick<Member, "userId" | "membershipId">;
	name: string;
	customServerId?: Id<"mcp_custom_servers">;
	expectedDestinationFingerprint?: string;
	keptSecretNames?: string[];
}) {
	const { t, member } = args;

	return await t.mutation(internal.mcp_custom_servers.write_server, {
		userId: member.userId,
		membershipId: member.membershipId,
		customServerId: args.customServerId ?? null,
		expectedDestinationFingerprint: args.expectedDestinationFingerprint ?? null,
		server: { name: args.name, url: FIXTURE_URL, headers: [] },
		secretValues: [],
		keptSecretNames: args.keptSecretNames ?? [],
		lastTest: null,
		oauthPin: null,
	});
}

async function server_docs(t: TestConvex) {
	return await t.run(async (ctx) => ({
		servers: await ctx.db.query("mcp_custom_servers").collect(),
		secrets: await ctx.db.query("mcp_custom_server_secrets").collect(),
	}));
}

describe("save", () => {
	test("stores header values only encrypted and never returns them", async () => {
		const { t, owner } = await setup();
		const member = await add_member({ t, owner });
		const literal = "LITERAL_SECRET_VALUE_1";
		const typed = "TYPED_SECRET_VALUE_2";

		const saved = await save(member, {
			headers: { Authorization: `Bearer ${literal}`, "X-Api-Key": "${API_KEY}" },
			secretValues: [{ name: "API_KEY", value: typed }],
		});

		expect(saved).toEqual({
			_yay: { customServerId: expect.any(String), outcome: "ok", message: null, toolCount: 2, authorizationHost: null },
		});
		expect(fixtures.wire.at(-1)?.headers.get("authorization")).toBe(`Bearer ${literal}`);
		expect(fixtures.wire.at(-1)?.headers.get("x-api-key")).toBe(typed);

		// Read the bytes too, so a plain value stored as a buffer would still show up.
		const stored = JSON.stringify(await server_docs(t), (_key, value: unknown) =>
			value instanceof ArrayBuffer ? new TextDecoder().decode(value) : value,
		);
		expect(stored).not.toContain(literal);
		expect(stored).not.toContain(typed);

		const listed = await member.asUser.query(api.mcp_custom_servers.list, { membershipId: member.membershipId });
		expect(listed.servers[0]?.headers).toEqual([
			{
				name: "Authorization",
				parts: [
					{ kind: "text", text: "Bearer " },
					{ kind: "secret", secretName: "FIXTURE_AUTHORIZATION", set: true, updatedAt: expect.any(Number) },
				],
			},
			{
				name: "X-Api-Key",
				parts: [{ kind: "secret", secretName: "API_KEY", set: true, updatedAt: expect.any(Number) }],
			},
		]);
		expect(JSON.stringify(listed)).not.toMatch(/ciphertext|nonce|LITERAL_SECRET|TYPED_SECRET/u);
	});

	test("decrypts a secret only with its own server id", async () => {
		const { t, owner } = await setup();
		const member = await add_member({ t, owner });
		const customServerId = saved_id(
			await save(member, { headers: { "X-Api-Key": "${API_KEY}" }, secretValues: [{ name: "API_KEY", value: "v-1" }] }),
		);
		const otherServerId = await t.run((ctx) => test_mocks_fill_db_with.mcp_custom_server(ctx, member));
		const [secret] = (await server_docs(t)).secrets;

		const decrypt = (serverId: Id<"mcp_custom_servers">) =>
			crypto_decrypt_secret_value({
				secret: secret!.value,
				additionalData: plugins_mcp_custom_secret_additional_data({
					customServerId: serverId,
					userId: member.userId,
					name: "API_KEY",
				}),
				keyName: "MCP_SECRETS_ENCRYPTION_KEY",
			});

		expect(await decrypt(customServerId)).toBe("v-1");
		await expect(decrypt(otherServerId)).rejects.toThrow();
	});

	test("refuses a viewer", async () => {
		const { t, owner } = await setup();
		const viewer = await add_member({ t, owner, role: "viewer" });

		expect(await save(viewer, {})).toEqual({ _nay: { message: "You cannot use MCP servers in this workspace." } });
		expect(await viewer.asUser.query(api.mcp_custom_servers.list, { membershipId: viewer.membershipId })).toEqual({
			canUse: false,
			servers: [],
		});
		expect(fixtures.wire).toEqual([]);
	});

	test("refuses the 11th server", async () => {
		const { t, owner } = await setup();
		const member = await add_member({ t, owner });
		for (let index = 0; index < 10; index++) {
			await t.run((ctx) => test_mocks_fill_db_with.mcp_custom_server(ctx, member));
		}

		expect(await save(member, {})).toEqual({
			_nay: { message: "You can add at most 10 MCP servers in a workspace." },
		});
		expect((await server_docs(t)).servers).toHaveLength(10);
	});

	test("an edit keeps an untouched secret and deletes a removed one", async () => {
		const { t, owner } = await setup();
		const member = await add_member({ t, owner });
		const customServerId = saved_id(
			await save(member, {
				headers: { "X-Api-Key": "${API_KEY}", "X-Team": "${TEAM}" },
				secretValues: [
					{ name: "API_KEY", value: "key-1" },
					{ name: "TEAM", value: "team-1" },
				],
			}),
		);
		const before = (await server_docs(t)).secrets.find((secret) => secret.name === "API_KEY")!;

		const edited = await save(member, {
			customServerId,
			headers: { "X-Api-Key": "${secret:API_KEY}" },
			keptSecretNames: ["API_KEY"],
		});

		expect(edited).toMatchObject({ _yay: { customServerId, outcome: "ok" } });
		expect((await server_docs(t)).secrets).toEqual([before]);
		expect(fixtures.wire.at(-1)?.headers.get("x-api-key")).toBe("key-1");
	});

	test("a URL change deletes the sign-in and the running sign-ins of the server", async () => {
		const { t, owner } = await setup();
		const member = await add_member({ t, owner });
		const customServerId = saved_id(await save(member, {}));
		const target = { kind: "custom" as const, customServerId };
		await t.run(async (ctx) => {
			await test_mocks_fill_db_with.mcp_oauth_grant(ctx, { ...member, target });
			await test_mocks_fill_db_with.mcp_oauth_pending(ctx, { ...member, target });
		});

		const unchanged = await save(member, { customServerId });
		expect(unchanged).toMatchObject({ _yay: { customServerId } });
		expect(await t.run((ctx) => ctx.db.query("plugins_mcp_oauth_grants").collect())).toHaveLength(1);

		const moved = await save(member, { customServerId, url: "https://modern-basic.fixtures.test/other" });

		expect(moved).toMatchObject({ _yay: { customServerId } });
		expect(
			await t.run(async (ctx) => ({
				grants: await ctx.db.query("plugins_mcp_oauth_grants").collect(),
				pending: await ctx.db.query("plugins_mcp_oauth_pending").collect(),
				revocations: await ctx.db.query("plugins_mcp_oauth_revocations").collect(),
			})),
		).toMatchObject({
			grants: [],
			pending: [],
			revocations: [{ revocationEndpoint: "https://auth.example.com/revoke" }],
		});
	});

	test("a new origin needs the saved secrets typed again", async () => {
		const { t, owner } = await setup();
		const member = await add_member({ t, owner });
		const customServerId = saved_id(
			await save(member, {
				headers: { "X-Api-Key": "${API_KEY}" },
				secretValues: [{ name: "API_KEY", value: "key-1" }],
			}),
		);
		const wireBefore = fixtures.wire.length;
		const kept = { customServerId, headers: { "X-Api-Key": "${secret:API_KEY}" }, keptSecretNames: ["API_KEY"] };

		expect(await save(member, { ...kept, url: "https://other.fixtures.test/mcp" })).toEqual({
			_nay: { message: "The server address changed. Type the secret values again." },
		});
		expect(fixtures.wire).toHaveLength(wireBefore);
		expect((await server_docs(t)).servers[0]?.url).toBe(FIXTURE_URL);

		// A new path on the same origin keeps the secrets, and typed values may go anywhere.
		expect(await save(member, { ...kept, url: "https://modern-basic.fixtures.test/other" })).toMatchObject({
			_yay: { customServerId, outcome: "ok" },
		});
		expect(fixtures.wire.at(-1)?.headers.get("x-api-key")).toBe("key-1");
		expect(
			await save(member, {
				customServerId,
				url: "https://other.fixtures.test/mcp",
				headers: { "X-Api-Key": "${API_KEY}" },
				secretValues: [{ name: "API_KEY", value: "key-2" }],
			}),
		).toMatchObject({ _yay: { customServerId } });
	});

	test("a saved secret Press cannot read works again once it is typed", async () => {
		const { t, owner } = await setup();
		const member = await add_member({ t, owner });
		const headers = { "X-Api-Key": "${API_KEY}" };
		const customServerId = saved_id(
			await save(member, { headers, secretValues: [{ name: "API_KEY", value: "key-1" }] }),
		);
		saved_id(await save(member, { name: "other", headers, secretValues: [{ name: "API_KEY", value: "key-2" }] }));
		// Give this server the other server's encrypted value. It was encrypted for another server id,
		// so it no longer decrypts, like after a key change.
		await t.run(async (ctx) => {
			const secrets = await ctx.db.query("mcp_custom_server_secrets").collect();
			const own = secrets.find((secret) => secret.customServerId === customServerId)!;
			const other = secrets.find((secret) => secret.customServerId !== customServerId)!;
			await ctx.db.patch("mcp_custom_server_secrets", own._id, { value: other.value });
		});
		const cannotRead = { _nay: { message: "Press could not read the saved secrets. Type them again." } };

		expect(
			await member.asUser.action(api.mcp_custom_servers.test_connection, {
				membershipId: member.membershipId,
				customServerId,
			}),
		).toEqual(cannotRead);
		expect(
			await save(member, {
				customServerId,
				headers: { "X-Api-Key": "${secret:API_KEY}" },
				keptSecretNames: ["API_KEY"],
			}),
		).toEqual(cannotRead);

		expect(
			await save(member, { customServerId, headers, secretValues: [{ name: "API_KEY", value: "key-3" }] }),
		).toMatchObject({ _yay: { customServerId, outcome: "ok" } });
		expect(fixtures.wire.at(-1)?.headers.get("x-api-key")).toBe("key-3");
	});

	test("the final write checks the member and the server again", async () => {
		const { t, owner, asOwner } = await setup();
		const member = await add_member({ t, owner });
		const customServerId = saved_id(
			await save(member, {
				headers: { "X-Api-Key": "${API_KEY}" },
				secretValues: [{ name: "API_KEY", value: "key-1" }],
			}),
		);
		const before = await server_docs(t);
		const { destinationFingerprint } = before.servers[0]!;
		const record_test = (expectedDestinationFingerprint: string) =>
			t.mutation(internal.mcp_custom_servers.record_test, {
				userId: member.userId,
				membershipId: member.membershipId,
				customServerId,
				expectedDestinationFingerprint,
				lastTest: { at: Date.now(), outcome: "ok", toolCount: 1 },
				oauthPin: null,
			});
		const changed = { _nay: { message: "The server changed; try again." } };

		// Another save moved the server, or deleted a secret this save keeps.
		expect(
			await write_server({ t, member, name: "moved", customServerId, expectedDestinationFingerprint: "stale" }),
		).toEqual(changed);
		expect(
			await write_server({
				t,
				member,
				name: "gone",
				customServerId,
				expectedDestinationFingerprint: destinationFingerprint,
				keptSecretNames: ["GONE"],
			}),
		).toEqual(changed);
		expect(await record_test("stale")).toEqual(changed);

		// The member lost the permission while the probe ran.
		await asOwner.mutation(api.access_control.set_user_role, {
			organizationId: owner.organizationId,
			workspaceId: owner.workspaceId,
			userId: member.userId,
			role: "viewer",
		});
		const cannotUse = { _nay: { message: "You cannot use MCP servers in this workspace." } };
		expect(await write_server({ t, member, name: "new" })).toEqual(cannotUse);
		expect(await record_test(destinationFingerprint)).toEqual(cannotUse);

		expect(await server_docs(t)).toEqual(before);
	});

	test("the 11th save in a burst gets the rate limit, not the server cap", async () => {
		const { t, owner } = await setup();
		const member = await add_member({ t, owner });
		vi.useFakeTimers({ toFake: ["Date"] });
		const customServerId = saved_id(await save(member, {}));

		for (let index = 0; index < 9; index++) {
			expect(await save(member, { customServerId })).toMatchObject({ _yay: { customServerId } });
		}

		expect(await save(member, { customServerId })).toEqual({ _nay: { message: "Rate limit exceeded" } });
	});
});

describe("sign-in pin", () => {
	const OAUTH_URL = "https://mcp-a.oauth.test/mcp";

	test("save pins the sign-in server of a server that asks for sign-in", async () => {
		const { t, owner } = await setup();
		const member = await add_member({ t, owner });

		const saved = await save(member, { url: OAUTH_URL });

		expect(saved._yay).toMatchObject({ outcome: "auth_required", authorizationHost: "as.oauth.test" });
		const listed = await member.asUser.query(api.mcp_custom_servers.list, { membershipId: member.membershipId });
		expect(listed.servers[0]?.auth).toEqual({ kind: "oauth", authorizationHost: "as.oauth.test" });
		const stored = await t.run((ctx) => ctx.db.get("mcp_custom_servers", saved_id(saved)));
		expect(stored?.auth).toEqual({
			kind: "oauth",
			issuer: oauthFixtures.issuer(),
			resource: OAUTH_URL,
			authorizationHost: "as.oauth.test",
		});
	});

	test("save refuses a sign-in server that sends no `iss` unless it is trusted", async () => {
		const { t, owner } = await setup();
		const member = await add_member({ t, owner });
		oauthFixtures.switches.issSupported = false;

		const refused = await save(member, { url: OAUTH_URL });

		expect(refused._nay?.message).toContain("does not confirm which server answered");
		expect(await t.run((ctx) => ctx.db.query("mcp_custom_servers").collect())).toEqual([]);

		vi.stubEnv("MCP_TRUSTED_ISSUERS", oauthFixtures.issuer());
		const saved = await save(member, { url: OAUTH_URL });
		const stored = await t.run((ctx) => ctx.db.get("mcp_custom_servers", saved_id(saved)));
		expect(stored?.auth.kind).toBe("oauth");
	});

	test("save refuses a server whose sign-in settings name several sign-in servers", async () => {
		const { t, owner } = await setup();
		const member = await add_member({ t, owner });
		oauthFixtures.switches.prmAuthorizationServers = [oauthFixtures.issuer(), "https://other.oauth.test"];

		const refused = await save(member, { url: OAUTH_URL });

		expect(refused._nay?.message).toBe("This server names more than one sign-in server. Press cannot choose one.");
		expect(await t.run((ctx) => ctx.db.query("mcp_custom_servers").collect())).toEqual([]);
	});

	test("an edit of the same URL keeps the pin when the tool list works without a token", async () => {
		const { t, owner } = await setup();
		const member = await add_member({ t, owner });
		const customServerId = saved_id(await save(member, { url: OAUTH_URL }));
		const before = await t.run((ctx) => ctx.db.get("mcp_custom_servers", customServerId));

		oauthFixtures.switches.serverTokenOnlyForCall = true;
		const edited = await save(member, { name: "renamed", url: OAUTH_URL, customServerId });

		expect(edited._yay?.outcome).toBe("ok");
		const after = await t.run((ctx) => ctx.db.get("mcp_custom_servers", customServerId));
		expect(after?.auth).toEqual(before?.auth);
		expect(after?.destinationFingerprint).toBe(before?.destinationFingerprint);
	});

	test("test_connection pins a server saved with no sign-in that now asks for one", async () => {
		const { t, owner } = await setup();
		const member = await add_member({ t, owner });
		oauthFixtures.switches.serverTokenOnlyForCall = true;
		const customServerId = saved_id(await save(member, { url: OAUTH_URL }));
		const before = await t.run((ctx) => ctx.db.get("mcp_custom_servers", customServerId));
		expect(before?.auth).toEqual({ kind: "none" });

		oauthFixtures.switches.serverTokenOnlyForCall = false;
		const tested = await member.asUser.action(api.mcp_custom_servers.test_connection, {
			membershipId: member.membershipId,
			customServerId,
		});

		expect(tested._yay).toMatchObject({ outcome: "auth_required", authorizationHost: "as.oauth.test" });
		const after = await t.run((ctx) => ctx.db.get("mcp_custom_servers", customServerId));
		expect(after?.auth.kind).toBe("oauth");
		expect(after?.destinationFingerprint).not.toBe(before?.destinationFingerprint);
	});
});

describe("tool prefixes", () => {
	test("slugs the name, numbers clashes, and keeps the prefix on a rename", async () => {
		const { t, owner } = await setup();
		const member = await add_member({ t, owner });

		const ids = [];
		for (let index = 0; index < 10; index++) {
			const written = await write_server({ t, member, name: "Framelink MCP for Figma" });
			if (written._nay) throw new Error(written._nay.message);
			ids.push(written._yay.customServerId);
		}

		const prefixes = (await server_docs(t)).servers.map((server) => server.toolPrefix);
		expect(prefixes.slice(0, 2)).toEqual(["my-framelink-mcp-for", "my-framelink-mcp-2"]);
		expect(new Set(prefixes).size).toBe(10);
		for (const prefix of prefixes) {
			expect(prefix).toMatch(/^[a-z][a-z0-9-]{0,19}$/u);
		}

		const first = (await server_docs(t)).servers[0]!;
		const renamed = await write_server({
			t,
			member,
			name: "Figma",
			customServerId: ids[0],
			expectedDestinationFingerprint: first.destinationFingerprint,
		});
		expect(renamed).toEqual({ _yay: { customServerId: ids[0] } });
		expect((await server_docs(t)).servers[0]).toMatchObject({ name: "Figma", toolPrefix: "my-framelink-mcp-for" });
	});
});

describe("ownership", () => {
	test("another member sees none of the servers and gets Not found from every door", async () => {
		const { t, owner } = await setup();
		const member = await add_member({ t, owner });
		const other = await add_member({ t, owner });
		const customServerId = saved_id(await save(member, {}));

		expect(await other.asUser.query(api.mcp_custom_servers.list, { membershipId: other.membershipId })).toEqual({
			canUse: true,
			servers: [],
		});
		const notFound = { _nay: { message: "Not found" } };
		expect(
			await other.asUser.action(api.mcp_custom_servers.test_connection, {
				membershipId: other.membershipId,
				customServerId,
			}),
		).toEqual(notFound);
		expect(await save(other, { customServerId })).toEqual(notFound);
		expect(
			await other.asUser.mutation(api.mcp_custom_servers.set_enabled, {
				membershipId: other.membershipId,
				customServerId,
				enabled: false,
			}),
		).toEqual(notFound);
		expect(
			await other.asUser.mutation(api.mcp_custom_servers.remove, { membershipId: other.membershipId, customServerId }),
		).toEqual(notFound);
		expect((await server_docs(t)).servers).toMatchObject([{ _id: customServerId, enabled: true }]);
	});

	test("the same user gets Not found for a server of another workspace", async () => {
		const { t, owner } = await setup();
		const member = await add_member({ t, owner });
		const customServerId = saved_id(await save({ ...member, membershipId: member.personalMembershipId }, {}));
		const wireBefore = fixtures.wire.length;

		const notFound = { _nay: { message: "Not found" } };
		expect(
			await member.asUser.action(api.mcp_custom_servers.test_connection, {
				membershipId: member.membershipId,
				customServerId,
			}),
		).toEqual(notFound);
		expect(await save(member, { customServerId })).toEqual(notFound);
		expect(
			await member.asUser.mutation(api.mcp_custom_servers.set_enabled, {
				membershipId: member.membershipId,
				customServerId,
				enabled: false,
			}),
		).toEqual(notFound);
		expect(
			await member.asUser.mutation(api.mcp_custom_servers.remove, {
				membershipId: member.membershipId,
				customServerId,
			}),
		).toEqual(notFound);
		expect(fixtures.wire).toHaveLength(wireBefore);
		expect((await server_docs(t)).servers).toMatchObject([{ _id: customServerId, enabled: true }]);
	});
});

describe("test_connection", () => {
	test("records the outcome and clears a pause", async () => {
		const { t, owner } = await setup();
		const member = await add_member({ t, owner });
		const customServerId = saved_id(await save(member, {}));
		await t.run((ctx) =>
			ctx.db.patch("mcp_custom_servers", customServerId, { failures: 3, unhealthyUntil: Date.now() + 60_000 }),
		);

		const tested = await member.asUser.action(api.mcp_custom_servers.test_connection, {
			membershipId: member.membershipId,
			customServerId,
		});

		expect(tested).toEqual({
			_yay: { outcome: "ok", message: null, toolCount: 2, authorizationHost: null, toolNames: ["echo", "picture"] },
		});
		expect((await server_docs(t)).servers[0]).toMatchObject({
			failures: 0,
			unhealthyUntil: null,
			lastTest: { outcome: "ok", toolCount: 2 },
		});
	});
});

describe("set_enabled", () => {
	test("a member who lost the permission can turn a server off but not on", async () => {
		const { t, owner, asOwner } = await setup();
		const member = await add_member({ t, owner });
		const customServerId = saved_id(await save(member, {}));
		await asOwner.mutation(api.access_control.set_user_role, {
			organizationId: owner.organizationId,
			workspaceId: owner.workspaceId,
			userId: member.userId,
			role: "viewer",
		});
		const set_enabled = (enabled: boolean) =>
			member.asUser.mutation(api.mcp_custom_servers.set_enabled, {
				membershipId: member.membershipId,
				customServerId,
				enabled,
			});

		expect(await set_enabled(false)).toEqual({ _yay: null });
		expect(await set_enabled(true)).toEqual({ _nay: { message: "You cannot use MCP servers in this workspace." } });
		expect((await server_docs(t)).servers[0]?.enabled).toBe(false);
	});

	test("uses the write bucket", async () => {
		const { t, owner } = await setup();
		const member = await add_member({ t, owner });
		const customServerId = await t.run((ctx) => test_mocks_fill_db_with.mcp_custom_server(ctx, member));
		vi.useFakeTimers({ toFake: ["Date"] });

		for (let index = 0; index < 10; index++) {
			expect(
				await member.asUser.mutation(api.mcp_custom_servers.set_enabled, {
					membershipId: member.membershipId,
					customServerId,
					enabled: index % 2 === 0,
				}),
			).toEqual({ _yay: null });
		}

		expect(
			await member.asUser.mutation(api.mcp_custom_servers.set_enabled, {
				membershipId: member.membershipId,
				customServerId,
				enabled: false,
			}),
		).toEqual({ _nay: { message: "Rate limit exceeded" } });
	});
});

describe("remove", () => {
	test("deletes the server, its secrets, and its sign-ins, then drains its calls", async () => {
		const { t, owner } = await setup();
		const member = await add_member({ t, owner });
		const customServerId = await t.run((ctx) =>
			test_mocks_fill_db_with.mcp_custom_server(ctx, { ...member, secretNames: ["API_KEY"] }),
		);
		const target = { kind: "custom" as const, customServerId };
		const thread = await member.asUser.mutation(api.ai_chat.thread_create, {
			membershipId: member.membershipId,
			clientGeneratedId: "remove-thread",
			lastMessageAt: Date.now(),
		});
		if (thread._nay) throw new Error(thread._nay.message);
		await t.run(async (ctx) => {
			await test_mocks_fill_db_with.mcp_oauth_grant(ctx, { ...member, target });
			await test_mocks_fill_db_with.mcp_oauth_pending(ctx, { ...member, target });
			for (let index = 0; index < 150; index++) {
				await test_mocks_fill_db_with.mcp_call(ctx, { ...member, threadId: thread._yay.threadId, target });
			}
		});
		vi.useFakeTimers();

		expect(
			await member.asUser.mutation(api.mcp_custom_servers.remove, {
				membershipId: member.membershipId,
				customServerId,
			}),
		).toEqual({ _yay: null });

		const remaining = () =>
			t.run(async (ctx) => ({
				servers: (await ctx.db.query("mcp_custom_servers").collect()).length,
				secrets: (await ctx.db.query("mcp_custom_server_secrets").collect()).length,
				grants: (await ctx.db.query("plugins_mcp_oauth_grants").collect()).length,
				pending: (await ctx.db.query("plugins_mcp_oauth_pending").collect()).length,
				revocations: (await ctx.db.query("plugins_mcp_oauth_revocations").collect()).length,
				calls: (await ctx.db.query("plugins_mcp_calls").collect()).length,
			}));
		expect(await remaining()).toEqual({ servers: 0, secrets: 0, grants: 0, pending: 0, revocations: 1, calls: 150 });

		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect((await remaining()).calls).toBe(0);
	});
});

describe("list", () => {
	test("follows the organization allowlist and the destination", async () => {
		const { t, owner } = await setup({ integrationPolicy: null });
		const member = await add_member({ t, owner });
		const policy_of_first = async () =>
			(await member.asUser.query(api.mcp_custom_servers.list, { membershipId: member.membershipId })).servers[0]
				?.policy;
		const set_policy = (mcpServers: { mode: "allowlist" | "allow_all"; fingerprints: string[] }) =>
			t.run(async (ctx) => {
				const existing = await ctx.db
					.query("organizations_integration_policies")
					.withIndex("by_organization", (q) => q.eq("organizationId", owner.organizationId))
					.first();
				if (existing) await ctx.db.delete("organizations_integration_policies", existing._id);
				await ctx.db.insert("organizations_integration_policies", {
					organizationId: owner.organizationId,
					plugins: { mode: "allowlist", allowlist: [] },
					mcpServers: {
						mode: mcpServers.mode,
						allowlist: mcpServers.fingerprints.map((destinationFingerprint) => ({
							destinationFingerprint,
							url: FIXTURE_URL,
							authKind: "none" as const,
							oauthIssuer: null,
							addedBy: owner.userId,
							addedAt: Date.now(),
						})),
					},
					updatedBy: owner.userId,
					updatedAt: Date.now(),
				});
			});

		const customServerId = saved_id(await save(member, {}));
		expect(await policy_of_first()).toBe("blocked");

		const fingerprint = (await server_docs(t)).servers[0]!.destinationFingerprint;
		await set_policy({ mode: "allowlist", fingerprints: [fingerprint] });
		expect(await policy_of_first()).toBe("allowed");

		await save(member, { customServerId, url: "https://modern-basic.fixtures.test/other" });
		expect(await policy_of_first()).toBe("blocked");

		await set_policy({ mode: "allow_all", fingerprints: [] });
		expect(await policy_of_first()).toBe("allowed");
	});

	test("the personal organization allows every server", async () => {
		const { t, owner } = await setup({ integrationPolicy: null });
		const member = await add_member({ t, owner });
		const personal = { ...member, membershipId: member.personalMembershipId };

		saved_id(await save(personal, {}));

		expect(
			(await member.asUser.query(api.mcp_custom_servers.list, { membershipId: member.personalMembershipId })).servers,
		).toMatchObject([{ policy: "allowed" }]);
	});
});
