import { R2 } from "@convex-dev/r2";
import type { FunctionArgs } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { organizations_integration_policy_db_allows_mcp_server } from "./organizations_integration_policy.ts";
import { organizations_db_create_workspace } from "./organizations.ts";
import { plugins_mcp_destination_fingerprint } from "./plugins_mcp.ts";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import type { plugins_Capability } from "../shared/plugins.ts";

// Every write here spends a token from a small rate limit bucket. Fake timers let a test refill the
// buckets and run scheduled batches without waiting.
beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (customKey?: string) => ({
		key: customKey ?? "test-upload-key",
		url: "https://r2.test/upload",
	}));
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(null, { status: 200 })),
	);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

type TestConvex = ReturnType<typeof test_convex>;

function refill_rate_limits() {
	vi.advanceTimersByTime(60_000);
}

function user_identity(userId: Id<"users">) {
	return { issuer: "https://clerk.test", external_id: userId };
}

const tracker_server: Doc<"plugins_versions">["mcpServers"][number] = {
	id: "tracker",
	title: "Tracker",
	transport: "http",
	url: "https://mcp.example.com/mcp",
	headers: [],
	auth: { kind: "oauth", issuer: "https://auth.example.com", resource: null, scopes: ["read"] },
	tools: null,
};

/**
 * Register a page plugin version with no backend, owned by `userId`.
 */
async function register_version(args: {
	t: TestConvex;
	userId: Id<"users">;
	version: string;
	name?: string;
	sourceRepositoryUrl?: string;
	capabilities?: plugins_Capability[];
	mcpServers?: Doc<"plugins_versions">["mcpServers"];
}) {
	const { t, userId } = args;

	const name = args.name ?? "gallery";
	const sourceRepositoryUrl = args.sourceRepositoryUrl ?? `https://github.com/bonobo/${name}-plugin`;
	const repositoryId = await t.run(async (ctx) => {
		const existing = await ctx.db
			.query("plugins_publisher_repositories")
			.withIndex("by_ownerUser_repositoryUrl", (q) =>
				q.eq("ownerUserId", userId).eq("repositoryUrl", sourceRepositoryUrl),
			)
			.first();
		return (
			existing?._id ??
			(await ctx.db.insert("plugins_publisher_repositories", {
				ownerUserId: userId,
				repositoryUrl: sourceRepositoryUrl,
				owner: "bonobo",
				repo: `${name}-plugin`,
			}))
		);
	});
	const registered = await t.action(internal.plugins.register_plugin_version, {
		repositoryId,
		name,
		displayName: "Gallery",
		version: args.version,
		description: "Workspace media gallery",
		reviewStatus: "passed",
		reviewId: null,
		artifactHash: `sha256:${args.version.replaceAll(".", "0").padEnd(64, "c").slice(0, 64)}`,
		sourceRepositoryUrl,
		sourceOwner: "bonobo",
		sourceRepo: `${name}-plugin`,
		sourceCommitSha: "1234567890abcdef1234567890abcdef12345678",
		manifestR2Key: `plugins/${name}/${args.version}/manifest.json`,
		backendEntrypointFile: null,
		configuration: null,
		mounts: [],
		secrets: [],
		events: [],
		pages: [
			{
				id: "gallery",
				title: "Gallery",
				entry: "dist/frontend/index.html",
				navItem: { label: "Gallery", icon: "images" },
			},
		],
		fileViews: [],
		capabilities: args.capabilities ?? ["workspace.files.read"],
		outboundOrigins: [],
		uiOutboundOrigins: [],
		mcpServers: args.mcpServers ?? [],
		mcpServersFingerprint: args.mcpServers?.length ? "sha256:tracker" : "mcp-servers-hash",
		skills: [],
		files: [
			{
				path: "dist/frontend/index.html",
				sha256: `sha256:${"a".repeat(64)}`,
				bytes: 128,
				contentType: "text/html",
				r2Key: `plugins/${name}/${args.version}/dist/frontend/index.html`,
			},
		],
		createdBy: userId,
		endpoints: [],
		userWritableCollections: null,
		sourceFiles: [{ path: "dist/frontend/index.html", rawText: "<!doctype html><title>Gallery</title>" }],
	});
	if (registered._nay) {
		throw new Error(registered._nay.message);
	}
	return registered._yay.pluginVersionId;
}

async function install(args: {
	t: TestConvex;
	membership: { userId: Id<"users">; membershipId: Id<"organizations_workspaces_users"> };
	pluginVersionId: Id<"plugins_versions">;
}) {
	const { t, membership, pluginVersionId } = args;

	refill_rate_limits();
	const version = (await t.run((ctx) => ctx.db.get("plugins_versions", pluginVersionId)))!;
	return await t.withIdentity(user_identity(membership.userId)).mutation(api.plugins.install_version, {
		membershipId: membership.membershipId,
		pluginVersionId,
		acceptedCapabilities: version.capabilities,
		acceptedOutboundOrigins: [],
		acceptedUiOutboundOrigins: [],
		acceptedMcpServersFingerprint: version.mcpServersFingerprint,
		acceptedSkillNames: [],
		serviceAccountGrants: [{ resource: { kind: "workspace" }, level: "read" }],
	});
}

async function update_policy(
	args: FunctionArgs<typeof api.organizations_integration_policy.update_policy> & {
		t: TestConvex;
		userId: Id<"users">;
	},
) {
	const { t, userId, ...previousArgs } = args;

	refill_rate_limits();
	return await t
		.withIdentity(user_identity(userId))
		.mutation(api.organizations_integration_policy.update_policy, previousArgs);
}

async function installation_status(t: TestConvex, installationId: Id<"plugins_workspace_installations">) {
	return (await t.run((ctx) => ctx.db.get("plugins_workspace_installations", installationId)))?.status;
}

/**
 * A custom organization with no policy doc, owned by a user whose membership is in the home workspace.
 */
async function custom_organization(t: TestConvex) {
	return await t.run((ctx) =>
		test_mocks_fill_db_with.membership(ctx, { workspaceName: "home", integrationPolicy: null }),
	);
}

describe("personal organization", () => {
	test("allows any plugin and server and refuses update_policy", async () => {
		const t = test_convex();
		const personal = await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, { organizationName: "personal", workspaceName: "home" }),
		);
		const pluginVersionId = await register_version({ t, userId: personal.userId, version: "0.1.0" });

		expect(await install({ t, membership: personal, pluginVersionId })).toMatchObject({ _yay: expect.anything() });
		const customServer = await t.run((ctx) => test_mocks_fill_db_with.mcp_custom_server(ctx, personal));
		expect(
			await t.run((ctx) =>
				organizations_integration_policy_db_allows_mcp_server(ctx, {
					organizationId: personal.organizationId,
					target: { kind: "custom", customServerId: customServer },
				}),
			),
		).toBe(true);
		expect(
			await update_policy({
				t,
				userId: personal.userId,
				organizationId: personal.organizationId,
				change: { kind: "set_plugins_mode", mode: "allowlist" },
			}),
		).toEqual({ _nay: { message: "The personal organization allows every plugin and MCP server" } });
	});
});

describe("install_version", () => {
	test("a custom organization with no policy doc refuses every plugin and server", async () => {
		const t = test_convex();
		const owner = await custom_organization(t);
		const pluginVersionId = await register_version({ t, userId: owner.userId, version: "0.1.0" });

		expect(await install({ t, membership: owner, pluginVersionId })).toEqual({
			_nay: { message: "Your organization does not allow this plugin" },
		});
		const customServer = await t.run((ctx) => test_mocks_fill_db_with.mcp_custom_server(ctx, owner));
		expect(
			await t.run((ctx) =>
				organizations_integration_policy_db_allows_mcp_server(ctx, {
					organizationId: owner.organizationId,
					target: { kind: "custom", customServerId: customServer },
				}),
			),
		).toBe(false);
	});

	test("installs an upgrade inside the allowed ceiling and refuses a wider one", async () => {
		const t = test_convex();
		const owner = await custom_organization(t);
		const first = await register_version({
			t,
			userId: owner.userId,
			version: "0.1.0",
			capabilities: ["workspace.files.read", "workspace.files.write"],
		});
		expect(
			await update_policy({
				t,
				userId: owner.userId,
				organizationId: owner.organizationId,
				change: { kind: "allow_plugin", pluginVersionId: first },
			}),
		).toEqual({ _yay: null });

		const inside = await register_version({
			t,
			userId: owner.userId,
			version: "0.2.0",
			capabilities: ["workspace.files.read"],
		});
		expect(await install({ t, membership: owner, pluginVersionId: inside })).toMatchObject({ _yay: expect.anything() });

		const wider = await register_version({
			t,
			userId: owner.userId,
			version: "0.3.0",
			capabilities: ["workspace.files.read", "outbound.fetch"],
		});
		expect(await install({ t, membership: owner, pluginVersionId: wider })).toEqual({
			_nay: { message: "This version needs approval from your organization owner" },
		});
	});

	test("an upgrade that moves an MCP server needs approval", async () => {
		const t = test_convex();
		const owner = await custom_organization(t);
		const first = await register_version({
			t,
			userId: owner.userId,
			version: "0.1.0",
			capabilities: ["agent.mcp.connect"],
			mcpServers: [tracker_server],
		});
		await update_policy({
			t,
			userId: owner.userId,
			organizationId: owner.organizationId,
			change: { kind: "allow_plugin", pluginVersionId: first },
		});

		const moved = await register_version({
			t,
			userId: owner.userId,
			version: "0.2.0",
			capabilities: ["agent.mcp.connect"],
			mcpServers: [{ ...tracker_server, url: "https://other.example.com/mcp" }],
		});
		expect(await install({ t, membership: owner, pluginVersionId: moved })).toEqual({
			_nay: { message: "This version needs approval from your organization owner" },
		});
	});

	test("a version of the same name from another repository is not allowed", async () => {
		const t = test_convex();
		const owner = await custom_organization(t);
		const first = await register_version({ t, userId: owner.userId, version: "0.1.0" });
		await update_policy({
			t,
			userId: owner.userId,
			organizationId: owner.organizationId,
			change: { kind: "allow_plugin", pluginVersionId: first },
		});

		// Publish binds a name to its first source, so only a registry delete lets another source take
		// it. Patch the source to stand for that case.
		const other = await register_version({ t, userId: owner.userId, version: "0.2.0" });
		await t.run((ctx) =>
			ctx.db.patch("plugins_versions", other, { sourceRepositoryUrl: "https://github.com/someone/gallery-plugin" }),
		);
		expect(await install({ t, membership: owner, pluginVersionId: other })).toEqual({
			_nay: { message: "Your organization does not allow this plugin" },
		});
	});
});

describe("update_policy", () => {
	test("removing a plugin disables its installations and its page refuses", async () => {
		const t = test_convex();
		const owner = await custom_organization(t);
		const pluginVersionId = await register_version({ t, userId: owner.userId, version: "0.1.0" });
		await update_policy({
			t,
			userId: owner.userId,
			organizationId: owner.organizationId,
			change: { kind: "allow_plugin", pluginVersionId },
		});
		const installed = await install({ t, membership: owner, pluginVersionId });
		if (installed._nay) throw new Error(installed._nay.message);

		expect(
			await update_policy({
				t,
				userId: owner.userId,
				organizationId: owner.organizationId,
				change: { kind: "remove_plugin", pluginName: "gallery" },
			}),
		).toEqual({ _yay: null });

		expect(await installation_status(t, installed._yay.installationId)).toBe("disabled");
		expect(
			await t.withIdentity(user_identity(owner.userId)).action(api.plugins_ui.mint_page_session, {
				membershipId: owner.membershipId,
				pluginName: "gallery",
			}),
		).toMatchObject({ _nay: { message: "Not found" } });
	});

	test("the disable pass continues in batches", async () => {
		const t = test_convex();
		const owner = await custom_organization(t);
		const pluginVersionId = await register_version({ t, userId: owner.userId, version: "0.1.0" });
		await update_policy({
			t,
			userId: owner.userId,
			organizationId: owner.organizationId,
			change: { kind: "allow_plugin", pluginVersionId },
		});
		const second = await t.run(async (ctx) => {
			const workspace = await organizations_db_create_workspace(ctx, {
				userId: owner.userId,
				organizationId: owner.organizationId,
				name: "second",
				description: "",
				now: Date.now(),
			});
			if (workspace._nay) throw new Error(workspace._nay.message);
			const membership = await ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_workspace_user_active", (q) =>
					q.eq("workspaceId", workspace._yay.workspaceId).eq("userId", owner.userId),
				)
				.first();
			return { userId: owner.userId, membershipId: membership!._id };
		});
		const memberships = [owner, second];
		const installationIds = [];
		for (const membership of memberships) {
			const installed = await install({ t, membership, pluginVersionId });
			if (installed._nay) throw new Error(installed._nay.message);
			installationIds.push(installed._yay.installationId);
		}

		await t.run((ctx) =>
			ctx.db
				.query("organizations_integration_policies")
				.withIndex("by_organization", (q) => q.eq("organizationId", owner.organizationId))
				.first()
				.then((policy) =>
					ctx.db.patch("organizations_integration_policies", policy!._id, {
						plugins: { mode: "allowlist", allowlist: [] },
					}),
				),
		);
		await t.mutation(internal.organizations_integration_policy.disable_blocked_installations, {
			organizationId: owner.organizationId,
			cursor: null,
			_test_batchSize: 1,
		});
		await t.finishAllScheduledFunctions(() => vi.runAllTimers());

		for (const installationId of installationIds) {
			expect(await installation_status(t, installationId)).toBe("disabled");
		}
	});

	test("the disable pass starts over when the cursor's workspace was deleted", async () => {
		const t = test_convex();
		const owner = await custom_organization(t);
		const pluginVersionId = await register_version({ t, userId: owner.userId, version: "0.1.0", name: "alpha" });
		await update_policy({
			t,
			userId: owner.userId,
			organizationId: owner.organizationId,
			change: { kind: "allow_plugin", pluginVersionId },
		});
		const installed = await install({ t, membership: owner, pluginVersionId });
		if (installed._nay) throw new Error(installed._nay.message);

		// A batch stopped in a workspace that was deleted before the next batch ran.
		const deletedWorkspaceId = await t.run(async (ctx) => {
			const workspace = await organizations_db_create_workspace(ctx, {
				userId: owner.userId,
				organizationId: owner.organizationId,
				name: "second",
				description: "",
				now: Date.now(),
			});
			if (workspace._nay) throw new Error(workspace._nay.message);
			await ctx.db.delete("organizations_workspaces", workspace._yay.workspaceId);
			return workspace._yay.workspaceId;
		});
		await t.run((ctx) =>
			ctx.db
				.query("organizations_integration_policies")
				.withIndex("by_organization", (q) => q.eq("organizationId", owner.organizationId))
				.first()
				.then((policy) =>
					ctx.db.patch("organizations_integration_policies", policy!._id, {
						plugins: { mode: "allowlist", allowlist: [] },
					}),
				),
		);

		await t.mutation(internal.organizations_integration_policy.disable_blocked_installations, {
			organizationId: owner.organizationId,
			cursor: { workspaceId: deletedWorkspaceId, pluginName: "beta" },
		});

		expect(await installation_status(t, installed._yay.installationId)).toBe("disabled");
	});

	test("an admin is refused, a custom role with the permission succeeds, a non-member is refused", async () => {
		const t = test_convex();
		const owner = await custom_organization(t);
		const member = await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, { organizationName: "personal", workspaceName: "home" }),
		);
		const outsider = await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, { organizationName: "personal", workspaceName: "home" }),
		);
		const asOwner = t.withIdentity(user_identity(owner.userId));
		refill_rate_limits();
		expect(
			await asOwner.mutation(api.organizations.invite_user_to_organization_workspace, {
				organizationId: owner.organizationId,
				workspaceId: owner.workspaceId,
				userIdToAdd: member.userId,
			}),
		).toEqual({ _yay: null });
		const change = { kind: "set_mcp_servers_mode", mode: "allow_all" } as const;

		refill_rate_limits();
		await asOwner.mutation(api.access_control.set_user_role, {
			organizationId: owner.organizationId,
			workspaceId: owner.workspaceId,
			userId: member.userId,
			role: "admin",
		});
		expect(await update_policy({ t, userId: member.userId, organizationId: owner.organizationId, change })).toEqual({
			_nay: { message: "Permission denied" },
		});

		refill_rate_limits();
		const role = await asOwner.mutation(api.access_control.create_role, {
			organizationId: owner.organizationId,
			name: "Integrations manager",
			description: "",
			permissions: ["organization.integrations_policy.manage"],
		});
		if (role._nay) throw new Error(role._nay.message);
		refill_rate_limits();
		await asOwner.mutation(api.access_control.set_user_role, {
			organizationId: owner.organizationId,
			workspaceId: owner.workspaceId,
			userId: member.userId,
			role: role._yay.roleId,
		});
		expect(await update_policy({ t, userId: member.userId, organizationId: owner.organizationId, change })).toEqual({
			_yay: null,
		});

		expect(await update_policy({ t, userId: outsider.userId, organizationId: owner.organizationId, change })).toEqual({
			_nay: { message: "Permission denied" },
		});
	});

	test("refuses the 51st entry", async () => {
		const t = test_convex();
		const owner = await custom_organization(t);
		const pluginVersionId = await register_version({ t, userId: owner.userId, version: "0.1.0" });
		await update_policy({
			t,
			userId: owner.userId,
			organizationId: owner.organizationId,
			change: { kind: "set_plugins_mode", mode: "allowlist" },
		});
		await t.run(async (ctx) => {
			const policy = await ctx.db
				.query("organizations_integration_policies")
				.withIndex("by_organization", (q) => q.eq("organizationId", owner.organizationId))
				.first();
			await ctx.db.patch("organizations_integration_policies", policy!._id, {
				plugins: {
					mode: "allowlist",
					allowlist: Array.from({ length: 50 }, (_, index) => ({
						pluginName: `plugin-${index}`,
						publisherUserId: owner.userId,
						sourceRepositoryUrl: `https://github.com/bonobo/plugin-${index}`,
						capabilities: [],
						outboundOrigins: [],
						uiOutboundOrigins: [],
						mcpServers: [],
						addedBy: owner.userId,
						addedAt: Date.now(),
						updatedAt: Date.now(),
					})),
				},
			});
		});

		expect(
			await update_policy({
				t,
				userId: owner.userId,
				organizationId: owner.organizationId,
				change: { kind: "allow_plugin", pluginVersionId },
			}),
		).toEqual({ _nay: { message: "This list is full (50). Remove an entry or use Allow all." } });
	});
});

describe("organizations_integration_policy_db_allows_mcp_server", () => {
	test("a matching custom server entry passes and a changed destination fails", async () => {
		const t = test_convex();
		const owner = await custom_organization(t);
		const customServerId = await t.run((ctx) => test_mocks_fill_db_with.mcp_custom_server(ctx, owner));
		const customServer = (await t.run((ctx) => ctx.db.get("mcp_custom_servers", customServerId)))!;
		expect(
			await update_policy({
				t,
				userId: owner.userId,
				organizationId: owner.organizationId,
				change: { kind: "allow_mcp_server", destinationFingerprint: customServer.destinationFingerprint },
			}),
		).toEqual({ _yay: null });
		const allows = () =>
			t.run((ctx) =>
				organizations_integration_policy_db_allows_mcp_server(ctx, {
					organizationId: owner.organizationId,
					target: { kind: "custom", customServerId },
				}),
			);

		expect(await allows()).toBe(true);
		await t.run((ctx) =>
			ctx.db.patch("mcp_custom_servers", customServerId, { destinationFingerprint: "sha256:moved" }),
		);
		expect(await allows()).toBe(false);
	});

	test("a plugin server passes with its plugin entry and fails after its destination changes", async () => {
		const t = test_convex();
		const owner = await custom_organization(t);
		const pluginVersionId = await register_version({
			t,
			userId: owner.userId,
			version: "0.1.0",
			capabilities: ["agent.mcp.connect"],
			mcpServers: [tracker_server],
		});
		await update_policy({
			t,
			userId: owner.userId,
			organizationId: owner.organizationId,
			change: { kind: "allow_plugin", pluginVersionId },
		});
		const installed = await install({ t, membership: owner, pluginVersionId });
		if (installed._nay) throw new Error(installed._nay.message);
		const allows = () =>
			t.run((ctx) =>
				organizations_integration_policy_db_allows_mcp_server(ctx, {
					organizationId: owner.organizationId,
					target: { kind: "plugin", installationId: installed._yay.installationId, serverId: "tracker" },
				}),
			);

		expect(await allows()).toBe(true);
		await t.run(async (ctx) => {
			const server = await ctx.db
				.query("plugins_mcp_servers")
				.withIndex("by_organization_workspace_installation", (q) =>
					q
						.eq("organizationId", owner.organizationId)
						.eq("workspaceId", owner.workspaceId)
						.eq("installationId", installed._yay.installationId),
				)
				.first();
			await ctx.db.patch("plugins_mcp_servers", server!._id, {
				destinationFingerprint: await plugins_mcp_destination_fingerprint({
					...tracker_server,
					url: "https://other.example.com/mcp",
				}),
			});
		});
		expect(await allows()).toBe(false);
	});
});

describe("get_policy", () => {
	test("a plain member gets only the modes and plugin names, a manager gets the whole doc", async () => {
		const t = test_convex();
		const owner = await custom_organization(t);
		const member = await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, { organizationName: "personal", workspaceName: "home" }),
		);
		refill_rate_limits();
		await t
			.withIdentity(user_identity(owner.userId))
			.mutation(api.organizations.invite_user_to_organization_workspace, {
				organizationId: owner.organizationId,
				workspaceId: owner.workspaceId,
				userIdToAdd: member.userId,
			});
		const customServerId = await t.run((ctx) => test_mocks_fill_db_with.mcp_custom_server(ctx, owner));
		const fingerprint = (await t.run((ctx) => ctx.db.get("mcp_custom_servers", customServerId)))!
			.destinationFingerprint;
		expect(
			await update_policy({
				t,
				userId: owner.userId,
				organizationId: owner.organizationId,
				change: { kind: "allow_mcp_server", destinationFingerprint: fingerprint },
			}),
		).toEqual({ _yay: null });

		const asMember = await t
			.withIdentity(user_identity(member.userId))
			.query(api.organizations_integration_policy.get_policy, { organizationId: owner.organizationId });
		const asOwner = await t
			.withIdentity(user_identity(owner.userId))
			.query(api.organizations_integration_policy.get_policy, { organizationId: owner.organizationId });

		expect(asMember).toEqual({
			view: "member",
			plugins: { mode: "allowlist", allowlist: [] },
			mcpServers: { mode: "allowlist" },
		});
		expect(asOwner).toMatchObject({
			view: "manager",
			policy: {
				mcpServers: { allowlist: [{ destinationFingerprint: fingerprint, url: "https://mcp.example.com/mcp" }] },
			},
		});
	});
});

describe("list_custom_server_candidates", () => {
	test("gives a manager the URL and member count over pages, and a plain member nothing", async () => {
		const t = test_convex();
		const owner = await custom_organization(t);
		const member = await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, { organizationName: "personal", workspaceName: "home" }),
		);
		refill_rate_limits();
		await t
			.withIdentity(user_identity(owner.userId))
			.mutation(api.organizations.invite_user_to_organization_workspace, {
				organizationId: owner.organizationId,
				workspaceId: owner.workspaceId,
				userIdToAdd: member.userId,
			});
		// 120 docs of server A, split between two members, then 30 docs of server B. Page one holds 100
		// docs of A, so A spans both pages.
		await t.run(async (ctx) => {
			for (let index = 0; index < 150; index++) {
				const customServerId = await test_mocks_fill_db_with.mcp_custom_server(ctx, {
					...owner,
					userId: index % 2 === 0 ? owner.userId : member.userId,
				});
				await ctx.db.patch("mcp_custom_servers", customServerId, {
					destinationFingerprint: index < 120 ? "sha256:a" : "sha256:b",
					url: index < 120 ? "https://a.example.com/mcp" : "https://b.example.com/mcp",
				});
			}
		});
		const list = (userId: Id<"users">, cursor: string | null) =>
			t.withIdentity(user_identity(userId)).query(api.organizations_integration_policy.list_custom_server_candidates, {
				organizationId: owner.organizationId,
				paginationOpts: { numItems: 100, cursor },
			});

		expect(await list(member.userId, null)).toEqual({ page: [], continueCursor: "", isDone: true });

		const first = await list(owner.userId, null);
		const second = await list(owner.userId, first.continueCursor);

		const candidate = { authKind: "none", oauthIssuer: null, allowed: false };
		expect(first).toMatchObject({
			isDone: false,
			page: [{ ...candidate, destinationFingerprint: "sha256:a", url: "https://a.example.com/mcp", memberCount: 2 }],
		});
		expect(second).toMatchObject({
			isDone: true,
			page: [
				{ ...candidate, destinationFingerprint: "sha256:a", memberCount: 2 },
				{ ...candidate, destinationFingerprint: "sha256:b", url: "https://b.example.com/mcp", memberCount: 2 },
			],
		});
		expect(Object.keys(first.page[0]!).sort()).toEqual([
			"allowed",
			"authKind",
			"destinationFingerprint",
			"memberCount",
			"oauthIssuer",
			"url",
		]);
	});
});
