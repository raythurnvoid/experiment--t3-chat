import { describe, expect, test } from "vitest";

import { api, components, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";

async function fixture() {
	const t = test_convex();
	const owner = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx, { organizationName: "mount-team" }));
	const member = await t.run((ctx) =>
		test_mocks_fill_db_with.membership(ctx, { organizationName: "personal", workspaceName: "home" }),
	);
	const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: owner.userId });
	const asMember = t.withIdentity({ issuer: "https://clerk.test", external_id: member.userId });
	expect(
		await asOwner.mutation(api.organizations.invite_user_to_organization_workspace, {
			organizationId: owner.organizationId,
			workspaceId: owner.workspaceId,
			userIdToAdd: member.userId,
		}),
	).toEqual({ _yay: null });
	const membership = await t.run((ctx) =>
		ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_workspace_user_active", (q) =>
				q.eq("workspaceId", owner.workspaceId).eq("userId", member.userId).eq("active", true),
			)
			.unique(),
	);
	if (!membership) throw new Error("Expected invited member");
	return { t, owner, member, membership, asOwner, asMember };
}

async function version(args: {
	t: ReturnType<typeof test_convex>;
	userId: Id<"users">;
	name?: string;
	version?: string;
	mounts?: NonNullable<Doc<"plugins_versions">["mounts"]>;
	defaultYaml?: string;
	events?: Doc<"plugins_versions">["events"];
	capabilities?: Doc<"plugins_versions">["capabilities"];
}) {
	const { t, userId } = args;

	const name = args.name ?? "mount-test";
	return await t.run((ctx) =>
		ctx.db.insert("plugins_versions", {
			name,
			displayName: "Mount test",
			version: args.version ?? "0.1.0",
			description: "External data for tests",
			reviewStatus: "passed",
			reviewId: null,
			isLatest: true,
			artifactHash: `sha256:${"a".repeat(64)}`,
			sourceRepositoryUrl: `https://github.com/example/${name}`,
			sourceOwner: "example",
			sourceRepo: name,
			sourceCommitSha: "a".repeat(40),
			manifestR2Key: `plugins/${name}/manifest.json`,
			backendEntrypointFile: null,
			configuration: { description: "Mount name", defaultYaml: args.defaultYaml ?? "mount:\n  name: records\n" },
			mounts: args.mounts ?? [{ id: "sources", description: "External records", configurationPath: ["mount", "name"] }],
			events: args.events ?? [],
			capabilities: args.capabilities ?? ["workspace.volumes.write"],
			pages: [],
			fileViews: [],
			outboundOrigins: [],
			uiOutboundOrigins: [],
			mcpServers: [],
			mcpServersFingerprint: "mount-test-mcp",
			skills: [],
			files: [],
			sourceStatus: "ready",
			sourceLastError: null,
			createdBy: userId,
			updatedAt: Date.now(),
		}),
	);
}

function install_args(membershipId: Id<"organizations_workspaces_users">, pluginVersionId: Id<"plugins_versions">) {
	return {
		membershipId,
		pluginVersionId,
		acceptedCapabilities: ["workspace.volumes.write" as const],
		acceptedOutboundOrigins: [],
		acceptedUiOutboundOrigins: [],
		acceptedMcpServersFingerprint: "mount-test-mcp",
		acceptedSkillNames: [],
	};
}

async function reset_plugin_limit(t: ReturnType<typeof test_convex>, userId: Id<"users">) {
	// Setup tests need more than the two writes allowed at once.
	await t.run((ctx) =>
		ctx.runMutation(components.rate_limiter.lib.resetRateLimit, { name: "plugins_manage", key: userId }),
	);
}

async function scheduled_fixture() {
	const f = await fixture();
	const capabilities = [
		"plugin.schedule.run",
		"workspace.volumes.write",
		"workspace.files.read",
		"plugin.data.read",
		"plugin.data.write",
		"plugin.secrets.read",
		"outbound.fetch",
	] as const;
	const pluginVersionId = await version({
		t: f.t,
		userId: f.owner.userId,
		capabilities: [...capabilities],
		defaultYaml: "mount:\n  name: records\nschedule:\n  everyMinutes: 1440\n",
		events: [
			{
				type: "schedule.interval.elapsed",
				contentTypes: [],
				filters: [],
				schedule: { configurationPath: ["schedule", "everyMinutes"] },
			},
		],
	});
	const args = { ...install_args(f.owner.membershipId, pluginVersionId), acceptedCapabilities: [...capabilities] };
	return { ...f, args, pluginVersionId };
}

async function remove_workspace_read(f: Awaited<ReturnType<typeof fixture>>) {
	const role = await f.asOwner.mutation(api.access_control.create_role, {
		organizationId: f.owner.organizationId,
		name: "Limited member",
		description: "",
		permissions: ["workspace.mcp.use"],
	});
	if (role._nay) throw new Error(role._nay.message);
	const organization = await f.t.run((ctx) => ctx.db.get("organizations", f.owner.organizationId));
	if (!organization?.defaultWorkspaceId) throw new Error("Expected organization home workspace");
	expect(
		await f.asOwner.mutation(api.access_control.set_user_role, {
			organizationId: f.owner.organizationId,
			workspaceId: organization.defaultWorkspaceId,
			userId: f.member.userId,
			role: role._yay.roleId,
		}),
	).toEqual({ _yay: null });
	if (organization.defaultWorkspaceId !== f.owner.workspaceId) {
		await f.t.run((ctx) =>
			ctx.runMutation(components.rate_limiter.lib.resetRateLimit, { name: "roles_write", key: f.owner.userId }),
		);
		expect(
			await f.asOwner.mutation(api.access_control.set_user_role, {
				organizationId: f.owner.organizationId,
				workspaceId: f.owner.workspaceId,
				userId: f.member.userId,
				role: null,
			}),
		).toEqual({ _yay: null });
	}
}

describe("install_version scheduled consent", () => {
	test("requires explicit Me consent before any setup writes", async () => {
		const f = await scheduled_fixture();
		expect((await f.asOwner.mutation(api.plugins.install_version, f.args))._nay?.message).toContain("Grant permission");
		await reset_plugin_limit(f.t, f.owner.userId);
		expect(
			(
				await f.asOwner.mutation(api.plugins.install_version, {
					...f.args,
					scheduledRun: { kind: "me", scopes: ["files:read"] },
				})
			)._nay?.message,
		).toContain("proof");
		const setup = await f.t.run(async (ctx) => ({
			installations: await ctx.db.query("plugins_workspace_installations").collect(),
			accounts: await ctx.db.query("access_control_service_accounts").collect(),
			bindings: await ctx.db.query("plugins_service_account_bindings").collect(),
			grants: await ctx.db.query("access_control_permission_grants").collect(),
			mounts: await ctx.db.query("plugins_mounts").collect(),
			handlers: await ctx.db.query("plugins_workspace_event_handlers").collect(),
		}));
		for (const docs of Object.values(setup)) expect(docs, "refused consent must leave setup empty").toEqual([]);
	});

	test("saves the self-grant, user pin and due handler together", async () => {
		const f = await scheduled_fixture();
		const installed = await f.asOwner.mutation(api.plugins.install_version, {
			...f.args,
			scheduledRun: { kind: "me", scopes: ["volumes:write", "plugin_data:read", "plugin_data:write"] },
		});
		if (installed._nay) throw new Error(installed._nay.message);
		const installationId = installed._yay.installationId;
		const saved = await f.t.run(async (ctx) => {
			const installation = await ctx.db.get("plugins_workspace_installations", installationId);
			if (!installation?.scheduledRunGrantId) throw new Error("Expected saved assignment");
			return {
				installation,
				grant: await ctx.db.get("access_control_permission_grants", installation.scheduledRunGrantId),
				handler: await ctx.db
					.query("plugins_workspace_event_handlers")
					.withIndex("by_installation", (q) => q.eq("installationId", installationId))
					.first(),
			};
		});
		expect(saved.installation.scheduledRunUserId).toBe(f.owner.userId);
		expect(saved.grant).toMatchObject({
			permission: "plugin.run_as",
			principalKind: "user",
			userId: f.owner.userId,
			resourceId: installationId,
			runAs: { membershipId: f.owner.membershipId, membershipLifetime: 1 },
		});
		expect(saved.handler?.nextRunAt).toBeGreaterThanOrEqual(Date.now() - 10_000);
		expect(
			await f.asOwner.query(api.plugins_access.get_my_run_as_grant, {
				membershipId: f.owner.membershipId,
				installationId,
			}),
		).toMatchObject({
			isAssigned: true,
			grant: { valid: true, scopes: ["volumes:write", "plugin_data:read", "plugin_data:write"] },
		});
	});
});

describe("grant_run_as_me", () => {
	test("lets a member grant KV access and refuses management scopes without changing their grant", async () => {
		const f = await scheduled_fixture();
		const installed = await f.asOwner.mutation(api.plugins.install_version, {
			...f.args,
			scheduledRun: { kind: "me", scopes: [] },
		});
		if (installed._nay) throw new Error(installed._nay.message);
		const args = { membershipId: f.membership._id, installationId: installed._yay.installationId };
		const granted = await f.asMember.mutation(api.plugins_access.grant_run_as_me, {
			...args,
			scopes: ["plugin_data:read", "plugin_data:write"],
		});
		if (granted._nay) throw new Error(granted._nay.message);
		await reset_plugin_limit(f.t, f.member.userId);
		expect(
			(await f.asMember.mutation(api.plugins_access.grant_run_as_me, { ...args, scopes: ["volumes:write"] }))._nay
				?.message,
			"a member must not grant management they lack",
		).toBe("Permission denied");
		expect(await f.asMember.query(api.plugins_access.get_my_run_as_grant, args)).toMatchObject({
			grant: { grantId: granted._yay.grantId, scopes: ["plugin_data:read", "plugin_data:write"] },
		});
		expect(await f.asMember.query(api.plugins_access.get_installation_access, args)).toBeNull();
		const catalog = await f.asMember.query(api.plugins.list_published_plugins, { membershipId: f.membership._id });
		expect(catalog.find((plugin) => plugin.name === "mount-test")).toMatchObject({
			installationId: installed._yay.installationId,
			canManage: false,
			configuration: {
				description: "Mount name",
				defaultYaml: "mount:\n  name: records\nschedule:\n  everyMinutes: 1440\n",
			},
		});
	});

	test("refuses duplicate scopes and KV write without read", async () => {
		const f = await scheduled_fixture();
		const installed = await f.asOwner.mutation(api.plugins.install_version, {
			...f.args,
			scheduledRun: { kind: "me", scopes: [] },
		});
		if (installed._nay) throw new Error(installed._nay.message);
		const args = { membershipId: f.membership._id, installationId: installed._yay.installationId };
		expect(
			(
				await f.asMember.mutation(api.plugins_access.grant_run_as_me, {
					...args,
					scopes: ["plugin_data:read", "plugin_data:read"],
				})
			)._nay?.message,
		).toContain("once");
		await reset_plugin_limit(f.t, f.member.userId);
		expect(
			(await f.asMember.mutation(api.plugins_access.grant_run_as_me, { ...args, scopes: ["plugin_data:write"] }))._nay
				?.message,
		).toContain("also needs");
		expect((await f.asMember.query(api.plugins_access.get_my_run_as_grant, args))?.grant).toBeNull();
	});

	test("uses a readable saved folder without requiring workspace read access", async () => {
		const f = await scheduled_fixture();
		const installed = await f.asOwner.mutation(api.plugins.install_version, {
			...f.args,
			scheduledRun: { kind: "me", scopes: [] },
		});
		if (installed._nay) throw new Error(installed._nay.message);
		await remove_workspace_read(f);
		const folder = await f.asOwner.mutation(api.files_nodes.create_folder_node, {
			membershipId: f.owner.membershipId,
			parentId: "root",
			path: "shared",
		});
		if (folder._nay) throw new Error(folder._nay.message);
		expect(
			await f.asOwner.mutation(api.files_sharing.restrict_node, {
				membershipId: f.owner.membershipId,
				nodeId: folder._yay.nodeId,
			}),
		).toEqual({ _yay: null });
		expect(
			await f.asOwner.mutation(api.files_sharing.set_node_share_grant, {
				membershipId: f.owner.membershipId,
				nodeId: folder._yay.nodeId,
				principal: { kind: "user", userId: f.member.userId },
				level: "read",
			}),
		).toEqual({ _yay: null });
		const args = {
			membershipId: f.membership._id,
			installationId: installed._yay.installationId,
			scopes: ["files:read", "files:list"] as const,
		};
		expect(
			(
				await f.asMember.mutation(api.plugins_access.grant_run_as_me, {
					...args,
					scopes: [...args.scopes],
					filesReadProof: { kind: "workspace" },
				})
			)._nay?.message,
		).toBe("Permission denied");
		await reset_plugin_limit(f.t, f.member.userId);
		expect(
			(
				await f.asMember.mutation(api.plugins_access.grant_run_as_me, {
					...args,
					scopes: [...args.scopes],
					filesReadProof: { kind: "file", nodeId: folder._yay.nodeId },
				})
			)._nay,
			"a saved readable folder must prove Files consent",
		).toBeUndefined();
	});

	test("refuses foreign and archived proof without replacing consent", async () => {
		const f = await scheduled_fixture();
		const installed = await f.asOwner.mutation(api.plugins.install_version, {
			...f.args,
			scheduledRun: { kind: "me", scopes: [] },
		});
		if (installed._nay) throw new Error(installed._nay.message);
		const foreign = await f.asMember.mutation(api.files_nodes.create_folder_node, {
			membershipId: f.member.membershipId,
			parentId: "root",
			path: "private",
		});
		const saved = await f.asOwner.mutation(api.files_nodes.create_folder_node, {
			membershipId: f.owner.membershipId,
			parentId: "root",
			path: "archived",
		});
		if (foreign._nay || saved._nay) throw new Error("Expected saved folders");
		expect(
			(
				await f.asOwner.mutation(api.files_nodes.archive_nodes, {
					membershipId: f.owner.membershipId,
					nodeIds: [saved._yay.nodeId],
				})
			)._nay,
		).toBeUndefined();
		const args = { membershipId: f.membership._id, installationId: installed._yay.installationId };
		const granted = await f.asMember.mutation(api.plugins_access.grant_run_as_me, {
			...args,
			scopes: ["plugin_data:read"],
		});
		if (granted._nay) throw new Error(granted._nay.message);
		for (const nodeId of [foreign._yay.nodeId, saved._yay.nodeId]) {
			await reset_plugin_limit(f.t, f.member.userId);
			expect(
				(
					await f.asMember.mutation(api.plugins_access.grant_run_as_me, {
						...args,
						scopes: ["files:read"],
						filesReadProof: { kind: "file", nodeId },
					})
				)._nay,
				"proof must be a live node in this workspace",
			).toBeDefined();
			expect((await f.asMember.query(api.plugins_access.get_my_run_as_grant, args))?.grant?.grantId).toBe(
				granted._yay.grantId,
			);
		}
	});

	test("requires the human's own membership", async () => {
		const f = await scheduled_fixture();
		const installed = await f.asOwner.mutation(api.plugins.install_version, {
			...f.args,
			scheduledRun: { kind: "me", scopes: [] },
		});
		if (installed._nay) throw new Error(installed._nay.message);
		const args = { membershipId: f.owner.membershipId, installationId: installed._yay.installationId };
		expect((await f.asMember.mutation(api.plugins_access.grant_run_as_me, { ...args, scopes: [] }))._nay?.message).toBe(
			"Unauthorized",
		);
		expect((await f.asMember.mutation(api.plugins_access.revoke_run_as_me, args))._nay?.message).toBe("Unauthorized");
		expect((await f.asOwner.query(api.plugins_access.get_my_run_as_grant, args))?.grant?.valid).toBe(true);
	});
});

describe("get_installation_mounts", () => {
	test("shows usage to exact managers and hides revisions without workspace read", async () => {
		const f = await fixture();
		const pluginVersionId = await version({ t: f.t, userId: f.owner.userId });
		const installed = await f.asOwner.mutation(
			api.plugins.install_version,
			install_args(f.owner.membershipId, pluginVersionId),
		);
		if (installed._nay) throw new Error(installed._nay.message);
		const installationId = installed._yay.installationId;
		await f.t.run(async (ctx) => {
			const volumeId = await ctx.db.insert("plugins_volumes", {
				organizationId: f.owner.organizationId,
				workspaceId: f.owner.workspaceId,
				installationId,
				mountId: "sources",
				volumeKey: "records",
				publishedGenerationId: null,
				createdAt: Date.now(),
				deleteRequestedAt: null,
				drainScheduledUntil: null,
			});
			const publishedGenerationId = await ctx.db.insert("plugins_volume_generations", {
				organizationId: f.owner.organizationId,
				workspaceId: f.owner.workspaceId,
				installationId,
				volumeId,
				status: "published",
				revision: "private-revision",
				fileCount: 2,
				bytes: 10,
				createdAt: Date.now(),
				lastWriteAt: Date.now(),
				publishedAt: Date.now(),
				expiresAt: null,
				drainScheduledUntil: null,
			});
			await ctx.db.patch("plugins_volumes", volumeId, { publishedGenerationId });
			await ctx.db.insert("plugins_volume_generations", {
				organizationId: f.owner.organizationId,
				workspaceId: f.owner.workspaceId,
				installationId,
				volumeId,
				status: "staging",
				revision: "private-staging-revision",
				fileCount: 1,
				bytes: 12,
				createdAt: Date.now(),
				lastWriteAt: Date.now(),
				publishedAt: null,
				expiresAt: Date.now() + 60_000,
				drainScheduledUntil: null,
			});
			await ctx.db.insert("plugins_volume_usage", {
				organizationId: f.owner.organizationId,
				workspaceId: f.owner.workspaceId,
				installationId,
				fileCount: 3,
				bytes: 22,
			});
		});
		const ownerArgs = { membershipId: f.owner.membershipId, installationId };
		const memberArgs = { membershipId: f.membership._id, installationId };
		expect(await f.asMember.query(api.plugins.get_installation_mounts, memberArgs)).toBeNull();
		expect(await f.asOwner.query(api.plugins.get_installation_mounts, ownerArgs)).toMatchObject({
			mounts: [{ mountId: "sources", name: "records" }],
			usage: { fileCount: 3, bytes: 22, dailyFilesLeft: 10_000 },
			volumes: [{ published: { revision: "private-revision" }, staging: { revision: "private-staging-revision" } }],
		});
		await remove_workspace_read(f);
		await reset_plugin_limit(f.t, f.owner.userId);
		expect(
			await f.asOwner.mutation(api.plugins_access.update_installation_access, {
				...ownerArgs,
				mode: "selected",
				principals: [{ kind: "user", userId: f.member.userId }],
			}),
		).toEqual({ _yay: null });
		expect(
			await f.asMember.query(api.plugins.get_installation_mounts, memberArgs),
			"management alone must not expose copy revisions",
		).toMatchObject({
			usage: { fileCount: 3, bytes: 22 },
			volumes: [
				{
					volumeKey: "records",
					published: { revision: null, fileCount: 2, bytes: 10 },
					staging: { revision: null, fileCount: 1, bytes: 12 },
				},
			],
		});
	});
});

describe("set_scheduled_run_user", () => {
	test("selects only a direct self-grant and lets its user revoke after losing management", async () => {
		const f = await scheduled_fixture();
		const installed = await f.asOwner.mutation(api.plugins.install_version, {
			...f.args,
			scheduledRun: { kind: "me", scopes: [] },
		});
		if (installed._nay) throw new Error(installed._nay.message);
		const installationId = installed._yay.installationId;
		const own = await f.asOwner.query(api.plugins_access.get_my_run_as_grant, {
			membershipId: f.owner.membershipId,
			installationId,
		});
		if (!own?.grant) throw new Error("Expected owner self-grant");
		await reset_plugin_limit(f.t, f.owner.userId);
		expect(
			(
				await f.asOwner.mutation(api.plugins_access.set_scheduled_run_user, {
					membershipId: f.owner.membershipId,
					installationId,
					userId: f.member.userId,
					grantId: own.grant.grantId,
				})
			)._nay?.message,
		).toContain("grant access again");
		const granted = await f.asMember.mutation(api.plugins_access.grant_run_as_me, {
			membershipId: f.membership._id,
			installationId,
			scopes: ["plugin_data:read"],
		});
		if (granted._nay) throw new Error(granted._nay.message);
		await reset_plugin_limit(f.t, f.owner.userId);
		expect(
			await f.asOwner.mutation(api.plugins_access.set_scheduled_run_user, {
				membershipId: f.owner.membershipId,
				installationId,
				userId: f.member.userId,
				grantId: granted._yay.grantId,
			}),
		).toEqual({ _yay: null });
		const eligible = await f.asOwner.query(api.plugins_access.list_eligible_run_users, {
			membershipId: f.owner.membershipId,
			installationId,
			paginationOpts: { numItems: 100, cursor: null },
		});
		expect(eligible.page.map((user) => user.userId)).toEqual(expect.arrayContaining([f.member.userId, f.owner.userId]));
		expect(
			await f.asMember.mutation(api.plugins_access.revoke_run_as_me, {
				membershipId: f.membership._id,
				installationId,
			}),
		).toEqual({ _yay: null });
		expect(
			(await f.t.run((ctx) => ctx.db.get("plugins_workspace_installations", installationId)))?.scheduledRunGrantId,
		).toBeUndefined();
		expect(
			(
				await f.asMember.query(api.plugins_access.get_my_run_as_grant, {
					membershipId: f.membership._id,
					installationId,
				})
			)?.grant,
		).toBeNull();
	});
});

describe("update_workspace_install_access", () => {
	test("starts owner-only and lets a selected member set up a new empty account", async () => {
		const { t, owner, member, membership, asOwner, asMember } = await fixture();
		const pluginVersionId = await version({ t, userId: owner.userId });
		expect(
			await asOwner.query(api.plugins_access.get_workspace_install_access, { membershipId: owner.membershipId }),
		).toMatchObject({ canInstall: true, canManageSettings: true, mode: "owner", principals: [] });
		expect(
			await asMember.query(api.plugins_access.get_workspace_install_access, { membershipId: membership._id }),
		).toMatchObject({ canInstall: false, canManageSettings: false, mode: null, principals: [] });
		expect(
			(await asMember.mutation(api.plugins.install_version, install_args(membership._id, pluginVersionId)))._nay
				?.message,
		).toBe("Permission denied");
		expect(
			await asOwner.mutation(api.plugins_access.update_workspace_install_access, {
				membershipId: owner.membershipId,
				mode: "selected",
				principals: [{ kind: "user", userId: member.userId }],
			}),
		).toEqual({ _yay: null });
		const installed = await asMember.mutation(
			api.plugins.install_version,
			install_args(membership._id, pluginVersionId),
		);
		if (installed._nay) throw new Error(installed._nay.message);
		const saved = await t.run(async (ctx) => ({
			installation: await ctx.db.get("plugins_workspace_installations", installed._yay.installationId),
			accounts: await ctx.db
				.query("access_control_service_accounts")
				.withIndex("by_organization_workspace", (q) =>
					q.eq("organizationId", owner.organizationId).eq("workspaceId", owner.workspaceId),
				)
				.collect(),
			grants: await ctx.db.query("access_control_permission_grants").collect(),
		}));
		expect(saved.installation?.managementAccess).toBe("selected");
		expect(saved.accounts).toHaveLength(1);
		expect(saved.grants.some((grant) => grant.principalKind === "service_account")).toBe(false);
		expect(
			await asMember.query(api.plugins_access.get_installation_access, {
				membershipId: membership._id,
				installationId: installed._yay.installationId,
			}),
		).toMatchObject({ mode: "selected", principals: [{ kind: "user", userId: member.userId }] });
	});

	test("offers setup only for plugins that are not installed", async () => {
		const { t, owner, member, membership, asOwner, asMember } = await fixture();
		const installedVersion = await version({ t, userId: owner.userId });
		await version({ t, userId: owner.userId, name: "new-mount" });
		expect(
			await asOwner.mutation(api.plugins_access.update_workspace_install_access, {
				membershipId: owner.membershipId,
				mode: "selected",
				principals: [{ kind: "user", userId: member.userId }],
			}),
		).toEqual({ _yay: null });
		expect(
			(await asOwner.mutation(api.plugins.install_version, install_args(owner.membershipId, installedVersion)))._nay,
		).toBeUndefined();
		const catalog = await asMember.query(api.plugins.list_published_plugins, { membershipId: membership._id });
		expect(catalog.find((plugin) => plugin.name === "mount-test")).toMatchObject({
			canInstall: false,
			canManage: false,
		});
		expect(catalog.find((plugin) => plugin.name === "new-mount")).toMatchObject({
			canInstall: true,
			canManage: false,
		});
		expect(await asMember.query(api.plugins.list_installations, { membershipId: membership._id })).toEqual([]);
	});

	test("only the owner changes setup access and rejects duplicate lists before writes", async () => {
		const { t, owner, member, membership, asOwner, asMember } = await fixture();
		expect(
			(
				await asMember.mutation(api.plugins_access.update_workspace_install_access, {
					membershipId: membership._id,
					mode: "workspace",
					principals: [],
				})
			)._nay?.message,
		).toContain("Only the organization owner");
		expect(
			(
				await asOwner.mutation(api.plugins_access.update_workspace_install_access, {
					membershipId: owner.membershipId,
					mode: "selected",
					principals: [
						{ kind: "user", userId: member.userId },
						{ kind: "user", userId: member.userId },
					],
				})
			)._nay?.message,
		).toBe("Choose each person or role once");
		expect((await t.run((ctx) => ctx.db.get("organizations_workspaces", owner.workspaceId)))?.pluginInstallAccess).toBe(
			"owner",
		);
		expect(await t.run((ctx) => ctx.db.query("access_control_permission_grants").collect())).toHaveLength(0);
	});

	test("Everybody permits members and a selected role follows its workspace assignment", async () => {
		const { owner, member, membership, asOwner, asMember } = await fixture();
		expect(
			await asOwner.mutation(api.plugins_access.update_workspace_install_access, {
				membershipId: owner.membershipId,
				mode: "workspace",
				principals: [],
			}),
		).toEqual({ _yay: null });
		expect(
			await asMember.query(api.plugins_access.get_workspace_install_access, { membershipId: membership._id }),
		).toMatchObject({ canInstall: true });
		expect(
			await asOwner.mutation(api.plugins_access.update_workspace_install_access, {
				membershipId: owner.membershipId,
				mode: "selected",
				principals: [{ kind: "role", role: "viewer" }],
			}),
		).toEqual({ _yay: null });
		expect(
			await asMember.query(api.plugins_access.get_workspace_install_access, { membershipId: membership._id }),
		).toMatchObject({ canInstall: false });
		expect(
			await asOwner.mutation(api.access_control.set_user_role, {
				organizationId: owner.organizationId,
				workspaceId: owner.workspaceId,
				userId: member.userId,
				role: "viewer",
			}),
		).toEqual({ _yay: null });
		expect(
			await asMember.query(api.plugins_access.get_workspace_install_access, { membershipId: membership._id }),
		).toMatchObject({ canInstall: true });
	});
});

describe("update_installation_access", () => {
	test("keeps configuration, secrets, health, history and MCP status on the exact installation", async () => {
		const { t, owner, member, membership, asOwner, asMember } = await fixture();
		const firstVersion = await version({ t, userId: owner.userId });
		const otherVersion = await version({
			t,
			userId: owner.userId,
			name: "other-mount",
			defaultYaml: "mount:\n  name: other\n",
		});
		const first = await asOwner.mutation(api.plugins.install_version, install_args(owner.membershipId, firstVersion));
		const other = await asOwner.mutation(api.plugins.install_version, install_args(owner.membershipId, otherVersion));
		if (first._nay || other._nay) throw new Error("Expected installations");
		await reset_plugin_limit(t, owner.userId);
		expect(
			await asOwner.mutation(api.plugins_access.update_installation_access, {
				membershipId: owner.membershipId,
				installationId: first._yay.installationId,
				mode: "selected",
				principals: [{ kind: "user", userId: member.userId }],
			}),
		).toEqual({ _yay: null });
		expect(
			(await asMember.query(api.plugins.list_installations, { membershipId: membership._id })).map(
				(row) => row.installation._id,
			),
		).toEqual([first._yay.installationId]);
		const hidden = { membershipId: membership._id, installationId: other._yay.installationId };
		expect(await asMember.query(api.plugins_access.get_installation_access, hidden)).toBeNull();
		expect(
			(
				await asMember.mutation(api.plugins.update_installation_configuration, {
					...hidden,
					configurationYaml: "mount:\n  name: changed\n",
				})
			)._nay?.message,
		).toBe("Permission denied");
		expect(await asMember.query(api.plugins.list_installation_secrets, hidden)).toEqual([]);
		expect(await asMember.query(api.plugins.list_recent_runs, hidden)).toEqual([]);
		expect(await asMember.query(api.plugins.get_installation_storage_usage, hidden)).toBeNull();
		expect(
			await asMember.query(api.plugins.get_installation_health, {
				membershipId: membership._id,
				pluginName: "other-mount",
			}),
		).toBeNull();
		expect(await asMember.query(api.plugins_mcp.get_installation_mcp_status, hidden)).toEqual([]);
		const catalog = await asMember.query(api.plugins.list_published_plugins, { membershipId: membership._id });
		expect(catalog.find((row) => row.name === "mount-test")).toMatchObject({ canInstall: false, canManage: true });
		expect(catalog.find((row) => row.name === "other-mount")).toMatchObject({ canInstall: false, canManage: false });
		expect(
			await asMember.mutation(api.plugins.update_installation_configuration, {
				membershipId: membership._id,
				installationId: first._yay.installationId,
				configurationYaml: "mount:\n  name: changed\n",
			}),
		).toEqual({ _yay: null });
	});

	test("owner-only clears management grants and keeps a member's own consent", async () => {
		const { t, owner, member, membership, asOwner, asMember } = await fixture();
		const pluginVersionId = await version({ t, userId: owner.userId });
		const installed = await asOwner.mutation(
			api.plugins.install_version,
			install_args(owner.membershipId, pluginVersionId),
		);
		if (installed._nay) throw new Error(installed._nay.message);
		const installationId = installed._yay.installationId;
		expect(
			await asOwner.mutation(api.plugins_access.update_installation_access, {
				membershipId: owner.membershipId,
				installationId,
				mode: "selected",
				principals: [{ kind: "user", userId: member.userId }],
			}),
		).toEqual({ _yay: null });
		const consentId = await t.run((ctx) =>
			ctx.db.insert("access_control_permission_grants", {
				organizationId: owner.organizationId,
				workspaceId: owner.workspaceId,
				resourceKind: "plugin_installation",
				resourceId: installationId,
				principalKind: "user",
				userId: member.userId,
				permission: "plugin.run_as",
				runAs: { membershipId: membership._id, membershipLifetime: membership._creationTime, scopes: [] },
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}),
		);
		await reset_plugin_limit(t, owner.userId);
		expect(
			await asOwner.mutation(api.plugins_access.update_installation_access, {
				membershipId: owner.membershipId,
				installationId,
				mode: "owner",
				principals: [],
			}),
		).toEqual({ _yay: null });
		expect(
			await asMember.query(api.plugins_access.get_installation_access, {
				membershipId: membership._id,
				installationId,
			}),
		).toBeNull();
		expect(
			await asOwner.query(api.plugins_access.get_installation_access, {
				membershipId: owner.membershipId,
				installationId,
			}),
		).toMatchObject({ mode: "owner", principals: [] });
		expect(await t.run((ctx) => ctx.db.get("access_control_permission_grants", consentId))).not.toBeNull();
	});

	test("rejects unknown and oversized lists before changing access", async () => {
		const { t, owner, member, asOwner } = await fixture();
		const pluginVersionId = await version({ t, userId: owner.userId });
		const installed = await asOwner.mutation(
			api.plugins.install_version,
			install_args(owner.membershipId, pluginVersionId),
		);
		if (installed._nay) throw new Error(installed._nay.message);
		const setup = {
			membershipId: owner.membershipId,
			installationId: installed._yay.installationId,
			mode: "selected" as const,
		};
		expect(
			(
				await asOwner.mutation(api.plugins_access.update_installation_access, {
					...setup,
					principals: Array.from({ length: 51 }, () => ({ kind: "user" as const, userId: member.userId })),
				})
			)._nay?.message,
		).toBe("Choose at most 50 people and roles");
		const outsider = await t.run((ctx) => ctx.db.insert("users", { clerkUserId: null }));
		await reset_plugin_limit(t, owner.userId);
		expect(
			(
				await asOwner.mutation(api.plugins_access.update_installation_access, {
					...setup,
					principals: [
						{ kind: "user", userId: member.userId },
						{ kind: "user", userId: outsider },
					],
				})
			)._nay?.message,
		).toBe("This person is not a member of this workspace");
		expect(
			await asOwner.query(api.plugins_access.get_installation_access, {
				membershipId: owner.membershipId,
				installationId: installed._yay.installationId,
			}),
		).toMatchObject({
			mode: "selected",
			principals: [],
		});
	});
});

describe("installation mount claims", () => {
	test("claims configured names and renames them without moving files", async () => {
		const { t, owner, asOwner } = await fixture();
		const pluginVersionId = await version({ t, userId: owner.userId });
		const installed = await asOwner.mutation(api.plugins.install_version, {
			...install_args(owner.membershipId, pluginVersionId),
			configurationYaml: "mount:\n  name: chosen\n",
		});
		if (installed._nay) throw new Error(installed._nay.message);
		const mount = await t.run((ctx) => ctx.db.query("plugins_mounts").unique());
		expect(mount).toMatchObject({ name: "chosen", mountId: "sources", installationId: installed._yay.installationId });
		expect(
			await asOwner.mutation(api.plugins.update_installation_configuration, {
				membershipId: owner.membershipId,
				installationId: installed._yay.installationId,
				configurationYaml: "mount:\n  name: renamed\n",
			}),
		).toEqual({ _yay: null });
		expect(await t.run((ctx) => ctx.db.query("plugins_mounts").unique())).toMatchObject({
			_id: mount?._id,
			name: "renamed",
		});
	});

	test("refuses a second claim before writing an account or installation", async () => {
		const { t, owner, asOwner } = await fixture();
		const firstVersion = await version({ t, userId: owner.userId });
		const otherVersion = await version({ t, userId: owner.userId, name: "other-mount" });
		expect(
			(await asOwner.mutation(api.plugins.install_version, install_args(owner.membershipId, firstVersion)))._nay,
		).toBeUndefined();
		expect(
			(await asOwner.mutation(api.plugins.install_version, install_args(owner.membershipId, otherVersion)))._nay
				?.message,
		).toBe('Mount name "records" is already used by the "mount-test" plugin in this workspace');
		expect(await t.run((ctx) => ctx.db.query("plugins_workspace_installations").collect())).toHaveLength(1);
		expect(await t.run((ctx) => ctx.db.query("access_control_service_accounts").collect())).toHaveLength(1);
	});

	test("allows the same mount name in another workspace", async () => {
		const { t, owner, asOwner } = await fixture();
		const pluginVersionId = await version({ t, userId: owner.userId });
		expect(
			(await asOwner.mutation(api.plugins.install_version, install_args(owner.membershipId, pluginVersionId)))._nay,
		).toBeUndefined();
		const otherOwner = await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, { organizationName: "other-team" }),
		);
		const asOtherOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: otherOwner.userId });
		expect(
			(await asOtherOwner.mutation(api.plugins.install_version, install_args(otherOwner.membershipId, pluginVersionId)))
				._nay,
		).toBeUndefined();
		expect(await t.run((ctx) => ctx.db.query("plugins_mounts").collect())).toHaveLength(2);
	});

	test("keeps unsynced legacy names reserved and rejects a conflicting save", async () => {
		const { t, owner, asOwner } = await fixture();
		await t.run((ctx) =>
			ctx.db.insert("github_mounts", {
				name: "legacy",
				owner: "example",
				repo: "legacy",
				ref: "main",
				defaultBranch: null,
				lastCommitSha: null,
				lastTreeSha: null,
				lastSyncedAt: null,
				status: "idle",
				startedAt: null,
				producerFinishedAt: null,
				finishedAt: null,
				lastError: null,
			}),
		);
		const pluginVersionId = await version({ t, userId: owner.userId });
		expect(
			(
				await asOwner.mutation(api.plugins.install_version, {
					...install_args(owner.membershipId, pluginVersionId),
					configurationYaml: "mount:\n  name: legacy\n",
				})
			)._nay?.message,
		).toBe('Mount name "legacy" is already used by a GitHub mount');
		const installed = await asOwner.mutation(
			api.plugins.install_version,
			install_args(owner.membershipId, pluginVersionId),
		);
		if (installed._nay) throw new Error(installed._nay.message);
		await reset_plugin_limit(t, owner.userId);
		expect(
			(
				await asOwner.mutation(api.plugins.update_installation_configuration, {
					membershipId: owner.membershipId,
					installationId: installed._yay.installationId,
					configurationYaml: "mount:\n  name: legacy\n",
				})
			)._nay?.message,
		).toBe('Mount name "legacy" is already used by a GitHub mount');
		expect((await t.run((ctx) => ctx.db.query("plugins_mounts").unique()))?.name).toBe("records");
		expect(
			(await t.run((ctx) => ctx.db.get("plugins_workspace_installations", installed._yay.installationId)))
				?.configurationYaml,
		).toBe("mount:\n  name: records\n");
	});

	test.each(["sources", "constructor"])("upgrades use exact rights and drop mount %s", async (mountId) => {
		const { t, owner, member, membership, asOwner, asMember } = await fixture();
		const firstVersion = await version({
			t,
			userId: owner.userId,
			mounts: [{ id: mountId, description: "External records", configurationPath: ["mount", "name"] }],
		});
		const installed = await asOwner.mutation(
			api.plugins.install_version,
			install_args(owner.membershipId, firstVersion),
		);
		if (installed._nay) throw new Error(installed._nay.message);
		const volumeId = await t.run((ctx) =>
			ctx.db.insert("plugins_volumes", {
				organizationId: owner.organizationId,
				workspaceId: owner.workspaceId,
				installationId: installed._yay.installationId,
				mountId,
				volumeKey: "records",
				publishedGenerationId: null,
				createdAt: Date.now(),
				deleteRequestedAt: null,
				drainScheduledUntil: null,
			}),
		);
		expect(
			await asOwner.mutation(api.plugins_access.update_installation_access, {
				membershipId: owner.membershipId,
				installationId: installed._yay.installationId,
				mode: "selected",
				principals: [{ kind: "user", userId: member.userId }],
			}),
		).toEqual({ _yay: null });
		const nextVersion = await version({
			t,
			userId: owner.userId,
			version: "0.2.0",
			mounts: [{ id: "records", description: "New records", configurationPath: ["new", "name"] }],
			defaultYaml: "new:\n  name: new-records\n",
		});
		expect(
			(await asMember.mutation(api.plugins.install_version, install_args(membership._id, nextVersion)))._nay?.message,
		).toBe('Plugin configuration "new.name" must be a valid mount name');
		expect(
			await asMember.mutation(api.plugins.install_version, {
				...install_args(membership._id, nextVersion),
				configurationYaml: "new:\n  name: new-records\n",
			}),
		).toEqual(installed);
		expect(await t.run((ctx) => ctx.db.query("plugins_mounts").collect())).toMatchObject([
			{ mountId: "records", name: "new-records" },
		]);
		expect((await t.run((ctx) => ctx.db.get("plugins_volumes", volumeId)))?.deleteRequestedAt).toEqual(
			expect.any(Number),
		);
	});
});

describe("list_bash_volume_mounts", () => {
	test("lists published copies in path order and follows live claims and installation status", async () => {
		const { t, owner, member, asOwner, asMember } = await fixture();
		const pluginVersionId = await version({
			t,
			userId: owner.userId,
			mounts: [
				{ id: "sources", description: "Sources", configurationPath: ["mount", "name"] },
				{ id: "archive", description: "Archive", configurationPath: ["archive", "name"] },
			],
			defaultYaml: "mount:\n  name: z-records\narchive:\n  name: a-records\n",
		});
		const installed = await asOwner.mutation(
			api.plugins.install_version,
			install_args(owner.membershipId, pluginVersionId),
		);
		const foreign = await asMember.mutation(
			api.plugins.install_version,
			install_args(member.membershipId, pluginVersionId),
		);
		if (installed._nay || foreign._nay) throw new Error("Expected installations");
		const copies = await t.run(async (ctx) => {
			const result = [];
			for (const copy of [
				{ mountId: "sources", volumeKey: "a_1", state: "published" },
				{ mountId: "sources", volumeKey: "a-1", state: "published" },
				{ mountId: "archive", volumeKey: "b", state: "published" },
				{ mountId: "sources", volumeKey: "pending", state: "staging" },
				{ mountId: "sources", volumeKey: "deleting", state: "deleting" },
				{ mountId: "dropped", volumeKey: "old", state: "published" },
				{ mountId: "sources", volumeKey: "foreign", state: "foreign" },
			]) {
				const tenant = copy.state === "foreign" ? member : owner;
				const installationId = copy.state === "foreign" ? foreign._yay.installationId : installed._yay.installationId;
				const volumeId = await ctx.db.insert("plugins_volumes", {
					organizationId: tenant.organizationId,
					workspaceId: tenant.workspaceId,
					installationId,
					mountId: copy.mountId,
					volumeKey: copy.volumeKey,
					publishedGenerationId: null,
					createdAt: Date.now(),
					deleteRequestedAt: copy.state === "deleting" ? Date.now() : null,
					drainScheduledUntil: null,
				});
				const publishedGenerationId = await ctx.db.insert("plugins_volume_generations", {
					organizationId: tenant.organizationId,
					workspaceId: tenant.workspaceId,
					installationId,
					volumeId,
					status: copy.state === "staging" ? "staging" : "published",
					revision: "revision-1",
					fileCount: 0,
					bytes: 0,
					createdAt: Date.now(),
					lastWriteAt: Date.now(),
					publishedAt: copy.state === "staging" ? null : Date.now(),
					expiresAt: copy.state === "staging" ? Date.now() + 26 * 60 * 60 * 1000 : null,
					drainScheduledUntil: null,
				});
				if (copy.state !== "staging") await ctx.db.patch("plugins_volumes", volumeId, { publishedGenerationId });
				result.push({ mountId: copy.mountId, volumeKey: copy.volumeKey, volumeId, publishedGenerationId });
			}
			return result;
		});
		const scope = { organizationId: owner.organizationId, workspaceId: owner.workspaceId };
		const listed = await t.query(internal.plugins.list_bash_volume_mounts, scope);
		expect(
			listed.map((copy) => `${copy.mountName}/${copy.volumeKey}`),
			"only published live claims are listed",
		).toEqual(["a-records/b", "z-records/a-1", "z-records/a_1"]);
		expect(listed.map((copy) => copy.volumeId)).toEqual([
			copies[2]!.volumeId,
			copies[1]!.volumeId,
			copies[0]!.volumeId,
		]);
		expect(
			await t.query(internal.plugins.list_bash_volume_mounts, {
				organizationId: member.organizationId,
				workspaceId: member.workspaceId,
			}),
		).toEqual([
			{
				mountName: "z-records",
				volumeKey: "foreign",
				volumeId: copies[6]!.volumeId,
				publishedGenerationId: copies[6]!.publishedGenerationId,
			},
		]);
		expect(
			await asOwner.mutation(api.plugins.update_installation_configuration, {
				membershipId: owner.membershipId,
				installationId: installed._yay.installationId,
				configurationYaml: "mount:\n  name: renamed\narchive:\n  name: a-records\n",
			}),
		).toEqual({ _yay: null });
		expect((await t.query(internal.plugins.list_bash_volume_mounts, scope)).map((copy) => copy.mountName)).toEqual([
			"a-records",
			"renamed",
			"renamed",
		]);
		await t.run((ctx) =>
			ctx.db.patch("plugins_workspace_installations", installed._yay.installationId, { status: "disabled" }),
		);
		expect(await t.query(internal.plugins.list_bash_volume_mounts, scope), "disabled copies are hidden").toEqual([]);
	});
});
