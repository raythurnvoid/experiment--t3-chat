import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import { organizations_db_create_workspace } from "./organizations.ts";
import {
	organizations_membership_lifetimes_db_ensure,
	organizations_membership_lifetimes_db_record,
} from "./organizations_membership_lifetimes.ts";
import {
	files_media_validation_db_capture_versions,
	files_media_validation_db_versions_match,
} from "./files_media_validation.ts";
import { data_deletion_db_request } from "./data_deletion_requests.ts";
import { crypto_sha256_hex } from "../server/crypto-utils.ts";
import type { plugins_Capability } from "../shared/plugins.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

async function fixture() {
	const t = test_convex({ transactionLimits: true });
	const owner = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx, { workspaceName: "home" }));
	const member = await t.run((ctx) =>
		test_mocks_fill_db_with.membership(ctx, { organizationName: "personal", workspaceName: "home" }),
	);
	const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: owner.userId });
	const sibling = await t.run((ctx) =>
		organizations_db_create_workspace(ctx, {
			userId: owner.userId,
			organizationId: owner.organizationId,
			name: "sibling",
			description: "",
			now: Date.now(),
		}),
	);
	if (sibling._nay) throw new Error(sibling._nay.message);
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
			.withIndex("by_workspace_user_active", (q) => q.eq("workspaceId", owner.workspaceId).eq("userId", member.userId))
			.unique(),
	);
	if (!membership) throw new Error("Missing invited membership");
	const scopes = [owner, { organizationId: owner.organizationId, workspaceId: sibling._yay.workspaceId }, member];
	await t.run((ctx) => files_media_validation_db_capture_versions(ctx, { userId: owner.userId, scopes }));
	expect(await t.run((ctx) => ctx.db.query("access_control_change_state").collect())).toEqual([]);
	return { t, owner, member, membership, asOwner, siblingId: sibling._yay.workspaceId };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function read_clocks(f: Fixture) {
	return await f.t.run(async (ctx) => ({
		versions: await ctx.db.query("files_media_validation_versions").collect(),
		pending: await ctx.db.query("files_pending_review_versions").collect(),
	}));
}

async function expect_clocks(
	f: Fixture,
	before: Awaited<ReturnType<typeof read_clocks>>,
	changed: Array<Id<"organizations_workspaces"> | null>,
) {
	const after = await read_clocks(f);
	for (const previous of before.versions) {
		const current = after.versions.find((doc) => doc._id === previous._id);
		expect(current).toBeDefined();
		if (
			changed.includes(previous.workspaceId) &&
			(previous.workspaceId !== null || previous.organizationId === f.owner.organizationId)
		) {
			expect(current!.revision).toBeGreaterThan(previous.revision);
		} else {
			expect(current).toEqual(previous);
		}
	}
	expect(after.pending).toEqual(before.pending);
}

async function create_role(f: Fixture) {
	const result = await f.asOwner.mutation(api.access_control.create_role, {
		organizationId: f.owner.organizationId,
		name: "Reviewer",
		description: "",
		permissions: ["content.read", "content.write"],
	});
	if (result._nay) throw new Error(result._nay.message);
	return result._yay.roleId;
}

async function create_folder(f: Fixture, name = "shared") {
	const result = await f.asOwner.mutation(api.files_nodes.create_folder_node, {
		membershipId: f.owner.membershipId,
		parentId: "root",
		path: name,
	});
	if (result._nay) throw new Error(result._nay.message);
	return result._yay.nodeId;
}

describe("media access clocks", () => {
	test.each(["permissions", "name", "same permissions"] as const)("custom role edit: %s", async (change) => {
		const f = await fixture();
		const roleId = await create_role(f);
		expect(
			await f.asOwner.mutation(api.access_control.set_user_role, {
				organizationId: f.owner.organizationId,
				workspaceId: f.owner.workspaceId,
				userId: f.member.userId,
				role: roleId,
			}),
		).toEqual({ _yay: null });
		const before = await read_clocks(f);
		expect(
			await f.asOwner.mutation(api.access_control.update_role, {
				roleId,
				...(change === "name"
					? { name: "Renamed" }
					: {
							permissions:
								change === "permissions"
									? ["content.read" as const]
									: ["content.write" as const, "content.read" as const],
						}),
			}),
		).toEqual({ _yay: null });
		const role = await f.t.run((ctx) => ctx.db.get("access_control_roles", roleId));
		if (change === "permissions") expect(role?.permissions).toEqual(["content.read"]);
		if (change === "name") expect(role?.name).toBe("Renamed");
		await expect_clocks(f, before, change === "permissions" ? [null] : []);
	});

	test("role creation does not change access, but deletion advances the organization clock", async () => {
		const f = await fixture();
		const before = await read_clocks(f);
		const roleId = await create_role(f);
		await expect_clocks(f, before, []);
		expect(await f.asOwner.mutation(api.access_control.delete_role, { roleId })).toEqual({ _yay: null });
		expect(await f.t.run((ctx) => ctx.db.get("access_control_roles", roleId))).toBeNull();
		await expect_clocks(f, before, [null]);
	});

	test("deleting an inactive holder's custom role changes the fallback and the organization clock", async () => {
		const f = await fixture();
		const roleId = await create_role(f);
		expect(
			await f.asOwner.mutation(api.access_control.set_user_role, {
				organizationId: f.owner.organizationId,
				workspaceId: f.owner.workspaceId,
				userId: f.member.userId,
				role: roleId,
			}),
		).toEqual({ _yay: null });
		await f.t.mutation(internal.data_deletion.init_user_deletion, { userId: f.member.userId });
		const before = await read_clocks(f);
		expect(await f.asOwner.mutation(api.access_control.delete_role, { roleId })).toEqual({ _yay: null });
		expect(await f.t.run((ctx) => ctx.db.query("access_control_role_assignments").collect())).toEqual([
			expect.objectContaining({ userId: f.member.userId, role: "viewer" }),
		]);
		await expect_clocks(f, before, [null]);
	});

	test.each(["change", "same", "refused"] as const)("organization assignment: %s", async (change) => {
		const f = await fixture();
		const before = await read_clocks(f);
		const result = await f.asOwner.mutation(api.access_control.set_user_role, {
			organizationId: f.owner.organizationId,
			workspaceId: f.owner.workspaceId,
			userId: change === "refused" ? f.owner.userId : f.member.userId,
			role: change === "same" ? "member" : "viewer",
		});
		if (change === "refused") expect(result._nay).toBeDefined();
		else {
			expect(result).toEqual({ _yay: null });
			expect(
				await f.t.run((ctx) =>
					ctx.db
						.query("access_control_role_assignments")
						.withIndex("by_organization_workspace_user", (q) =>
							q
								.eq("organizationId", f.owner.organizationId)
								.eq("workspaceId", f.owner.workspaceId)
								.eq("userId", f.member.userId),
						)
						.unique(),
				),
			).toMatchObject({ role: change === "same" ? "member" : "viewer" });
		}
		await expect_clocks(f, before, change === "change" ? [null] : []);
	});

	test.each(["create", "remove", "absent"] as const)(
		"workspace assignment uses the organization clock: %s",
		async (change) => {
			const f = await fixture();
			expect(
				await f.asOwner.mutation(api.organizations.invite_user_to_organization_workspace, {
					organizationId: f.owner.organizationId,
					workspaceId: f.siblingId,
					userIdToAdd: f.member.userId,
				}),
			).toEqual({ _yay: null });
			const args = { organizationId: f.owner.organizationId, workspaceId: f.siblingId, userId: f.member.userId };
			if (change === "remove")
				expect(await f.asOwner.mutation(api.access_control.set_user_role, { ...args, role: "admin" })).toEqual({
					_yay: null,
				});
			const before = await read_clocks(f);
			expect(
				await f.asOwner.mutation(api.access_control.set_user_role, {
					...args,
					role: change === "create" ? "admin" : null,
				}),
			).toEqual({ _yay: null });
			const assignment = await f.t.run((ctx) =>
				ctx.db
					.query("access_control_role_assignments")
					.withIndex("by_organization_workspace_user", (q) =>
						q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("userId", args.userId),
					)
					.unique(),
			);
			if (change === "create") expect(assignment?.role).toBe("admin");
			else expect(assignment).toBeNull();
			await expect_clocks(f, before, change === "absent" ? [] : [null]);
		},
	);

	test("assignment ensure advances the organization clock only on insertion", async () => {
		const f = await fixture();
		expect(
			await f.asOwner.mutation(api.organizations.invite_user_to_organization_workspace, {
				organizationId: f.owner.organizationId,
				workspaceId: f.siblingId,
				userIdToAdd: f.member.userId,
			}),
		).toEqual({ _yay: null });
		const before = await read_clocks(f);
		const args = {
			organizationId: f.owner.organizationId,
			workspaceId: f.siblingId,
			userId: f.member.userId,
			role: "admin" as const,
			now: Date.now(),
		};
		const id = await f.t.run((ctx) => access_control_db_ensure_role_assignment(ctx, args));
		expect(await f.t.run((ctx) => ctx.db.get("access_control_role_assignments", id))).toMatchObject({ role: "admin" });
		await expect_clocks(f, before, [null]);
		const repeated = await read_clocks(f);
		expect(await f.t.run((ctx) => access_control_db_ensure_role_assignment(ctx, args))).toBe(id);
		await expect_clocks(f, repeated, []);
	});

	test("explicit ownership handoff advances the organization clock without a feed", async () => {
		const f = await fixture();
		const before = await read_clocks(f);
		expect(
			await f.asOwner.mutation(api.access_control.transfer_organization_ownership, {
				organizationId: f.owner.organizationId,
				newOwnerUserId: f.member.userId,
			}),
		).toEqual({ _yay: null });
		expect(await f.t.run((ctx) => ctx.db.get("organizations", f.owner.organizationId))).toMatchObject({
			ownerUserId: f.member.userId,
		});
		await expect_clocks(f, before, [null]);
	});
});

describe("media sharing clocks", () => {
	test("manual sharing clears retained reader lifetime tags and advances the workspace clock", async () => {
		const f = await fixture();
		// Use the real external writer door to create a lifetime-bound reader grant.
		const secretHash = await crypto_sha256_hex("media-clock-test-secret");
		const { serviceAccountId, installationId } = await f.t.run(async (ctx) => {
			const capabilities: plugins_Capability[] = [
				"plugin.service.connect",
				"workspace.files.write",
				"workspace.files.own-write",
				"workspace.files.own-access",
			];
			const pluginVersionId = await ctx.db.insert("plugins_versions", {
				name: "clock-notes",
				displayName: "Clock notes",
				version: "1.0.0",
				description: "Notes",
				reviewStatus: "passed",
				reviewId: null,
				isLatest: true,
				artifactHash: `sha256:${"a".repeat(64)}`,
				sourceRepositoryUrl: "https://github.com/bonobo/clock-notes",
				sourceOwner: "bonobo",
				sourceRepo: "clock-notes",
				sourceCommitSha: "1234567890abcdef1234567890abcdef12345678",
				manifestR2Key: "plugins/clock-notes/manifest.json",
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
				createdBy: f.owner.userId,
				updatedAt: Date.now(),
			});
			const serviceAccountId = await test_mocks_fill_db_with.plugin_service_account(ctx, {
				...f.owner,
				pluginVersionId,
			});
			const installationId = await ctx.db.insert("plugins_workspace_installations", {
				organizationId: f.owner.organizationId,
				workspaceId: f.owner.workspaceId,
				serviceAccountId,
				pluginVersionId,
				pluginName: "clock-notes",
				status: "enabled",
				configurationYaml: null,
				acceptedCapabilities: capabilities,
				capabilitiesAcceptedAt: Date.now(),
				acceptedOutboundOrigins: [],
				acceptedUiOutboundOrigins: [],
				outboundOriginsAcceptedAt: Date.now(),
				installedBy: f.owner.userId,
				updatedBy: f.owner.userId,
				updatedAt: Date.now(),
			});
			await ctx.db.insert("plugins_service_registrations", {
				pluginName: "clock-notes",
				exchangeSecretHash: secretHash,
				scopes: ["files:write"],
				createdBy: f.owner.userId,
				updatedAt: Date.now(),
			});
			return { serviceAccountId, installationId };
		});
		expect(
			await f.asOwner.mutation(api.access_control.set_service_account_grant, {
				membershipId: f.owner.membershipId,
				serviceAccountId,
				resource: { kind: "workspace" },
				level: "manage",
			}),
		).toEqual({ _yay: null });
		const minted = await f.t.mutation(internal.public_api.create_plugin_service_grant, {
			organizationId: f.owner.organizationId,
			workspaceId: f.owner.workspaceId,
			installationId,
			actorUserId: f.owner.userId,
			requestedScopes: ["files:write"],
			destinationPathPrefix: "/clock-notes",
			phase: "processing",
			now: Date.now(),
		});
		if (minted._nay) throw new Error(minted._nay.message);
		const writer = await f.t.mutation(internal.plugins_external_files.ensure_writer, {
			grantId: minted._yay.grantId,
			tokenHash: await crypto_sha256_hex(minted._yay.token),
			serviceSecretHash: secretHash,
			path: "/clock-notes",
			resourceKey: "notes",
			rootNodeId: null,
			readOnly: false,
			readers: [{ userId: f.member.userId, membershipLifetime: 1 }],
		});
		if (writer._nay) throw new Error(writer._nay.message);
		const nodeId = writer._yay.folderNodeId;
		const args = {
			membershipId: f.owner.membershipId,
			nodeId,
			principal: { kind: "user" as const, userId: f.member.userId },
		};
		const readGrant = await f.t.run((ctx) =>
			ctx.db
				.query("access_control_permission_grants")
				.withIndex("by_organization_workspace_resource_user_permission", (q) =>
					q
						.eq("organizationId", f.owner.organizationId)
						.eq("workspaceId", f.owner.workspaceId)
						.eq("resourceKind", "file")
						.eq("resourceId", String(nodeId)),
				)
				.collect()
				.then((grants) => grants.find((grant) => grant.userId === f.member.userId)),
		);
		expect(readGrant?.externalPluginMembershipLifetime).toBe(1);
		const before = await read_clocks(f);
		expect(await f.asOwner.mutation(api.files_sharing.set_node_share_grant, { ...args, level: "read" })).toEqual({
			_yay: null,
		});
		await expect_clocks(f, before, []);
		expect(await f.t.run((ctx) => ctx.db.get("access_control_permission_grants", readGrant!._id))).toEqual(readGrant);
		vi.setSystemTime(Date.now() + 60_000);
		expect(await f.asOwner.mutation(api.files_sharing.set_node_share_grant, { ...args, level: "write" })).toEqual({
			_yay: null,
		});
		expect(await f.t.run((ctx) => ctx.db.get("access_control_permission_grants", readGrant!._id))).toMatchObject({
			permission: "content.read",
			userId: f.member.userId,
		});
		expect(
			(await f.t.run((ctx) => ctx.db.get("access_control_permission_grants", readGrant!._id)))
				?.externalPluginMembershipLifetime,
		).toBeUndefined();
		expect(
			await f.t.run((ctx) =>
				ctx.db
					.query("plugins_external_file_bindings")
					.withIndex("by_node", (q) => q.eq("nodeId", nodeId))
					.unique(),
			),
		).toMatchObject({ detachedAt: Date.now() });
		await expect_clocks(f, before, [f.owner.workspaceId]);
	});

	test("service-only sharing changes and revocation leave media clocks unchanged", async () => {
		const f = await fixture();
		const nodeId = await create_folder(f);
		const created = await f.asOwner.mutation(api.access_control.create_service_account, {
			membershipId: f.owner.membershipId,
			name: "Writer",
		});
		if (created._nay) throw new Error(created._nay.message);
		const serviceAccountId = created._yay.serviceAccountId;
		const args = {
			membershipId: f.owner.membershipId,
			nodeId,
			principal: { kind: "service_account" as const, serviceAccountId },
		};
		const before = await read_clocks(f);
		expect(await f.asOwner.mutation(api.files_sharing.set_node_share_grant, { ...args, level: "read" })).toEqual({
			_yay: null,
		});
		expect(await f.t.run((ctx) => ctx.db.query("access_control_permission_grants").collect())).toHaveLength(1);
		await expect_clocks(f, before, []);
		expect(await f.asOwner.mutation(api.files_sharing.remove_node_share_grant, args)).toEqual({ _yay: null });
		expect(await f.t.run((ctx) => ctx.db.query("access_control_permission_grants").collect())).toEqual([]);
		await expect_clocks(f, before, []);
		expect(
			await f.asOwner.mutation(api.access_control.revoke_service_account, {
				membershipId: f.owner.membershipId,
				serviceAccountId,
			}),
		).toEqual({ _yay: null });
		expect(await f.t.run((ctx) => ctx.db.get("access_control_service_accounts", serviceAccountId))).toMatchObject({
			revokedAt: Date.now(),
		});
		await expect_clocks(f, before, []);
	});

	test("denied sharing leaves all clocks and grants unchanged", async () => {
		const f = await fixture();
		const nodeId = await create_folder(f);
		expect(
			await f.asOwner.mutation(api.files_sharing.restrict_node, { membershipId: f.owner.membershipId, nodeId }),
		).toEqual({ _yay: null });
		const before = await read_clocks(f);
		const result = await f.t
			.withIdentity({ issuer: "https://clerk.test", external_id: f.member.userId })
			.mutation(api.files_sharing.set_node_share_grant, {
				membershipId: f.membership._id,
				nodeId,
				principal: { kind: "user", userId: f.member.userId },
				level: "read",
			});
		expect(result._nay).toBeDefined();
		expect(await f.t.run((ctx) => ctx.db.query("access_control_permission_grants").collect())).toEqual([]);
		await expect_clocks(f, before, []);
	});
	test.each([false, true])(
		"root restriction and release advance the workspace clock (children: %s)",
		async (children) => {
			const f = await fixture();
			const nodeId = await create_folder(f, children ? "shared/child" : "shared");
			const node = await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId));
			const rootId = children ? (node!.parentId as Id<"files_nodes">) : nodeId;
			const args = { membershipId: f.owner.membershipId, nodeId: rootId };
			const before = await read_clocks(f);
			expect(await f.asOwner.mutation(api.files_sharing.restrict_node, args)).toEqual({ _yay: null });
			expect(await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId))).toMatchObject({
				restrictedScopeNodeId: rootId,
			});
			await expect_clocks(f, before, [f.owner.workspaceId]);
			const restricted = await read_clocks(f);
			expect(await f.asOwner.mutation(api.files_sharing.restrict_node, args)).toEqual({ _yay: null });
			await expect_clocks(f, restricted, []);
			expect(await f.asOwner.mutation(api.files_sharing.unrestrict_node, args)).toEqual({ _yay: null });
			expect((await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId)))?.restrictedScopeNodeId ?? null).toBeNull();
			await expect_clocks(f, restricted, [f.owner.workspaceId]);
		},
	);

	test.each(["user", "role"] as const)(
		"changed %s grants advance the workspace clock; replay does not",
		async (kind) => {
			const f = await fixture();
			const nodeId = await create_folder(f);
			expect(
				await f.asOwner.mutation(api.files_sharing.restrict_node, { membershipId: f.owner.membershipId, nodeId }),
			).toEqual({ _yay: null });
			const principal = kind === "user" ? { kind, userId: f.member.userId } : { kind, role: "member" as const };
			const args = { membershipId: f.owner.membershipId, nodeId, principal };
			const before = await read_clocks(f);
			expect(await f.asOwner.mutation(api.files_sharing.set_node_share_grant, { ...args, level: "read" })).toEqual({
				_yay: null,
			});
			expect(await f.t.run((ctx) => ctx.db.query("access_control_permission_grants").collect())).toEqual([
				expect.objectContaining({ resourceId: String(nodeId), permission: "content.read", principalKind: kind }),
			]);
			await expect_clocks(f, before, [f.owner.workspaceId]);
			const granted = await read_clocks(f);
			expect(await f.asOwner.mutation(api.files_sharing.set_node_share_grant, { ...args, level: "read" })).toEqual({
				_yay: null,
			});
			await expect_clocks(f, granted, []);
			expect(await f.asOwner.mutation(api.files_sharing.remove_node_share_grant, args)).toEqual({ _yay: null });
			expect(await f.t.run((ctx) => ctx.db.query("access_control_permission_grants").collect())).toEqual([]);
			await expect_clocks(f, granted, [f.owner.workspaceId]);
		},
	);
});

describe("media tenancy clocks", () => {
	test("account tombstone and restoration advance each membership workspace clock without a feed", async () => {
		const f = await fixture();
		await f.t.run(async (ctx) => {
			const anagraphic = await ctx.db.insert("users_anagraphics", {
				userId: f.member.userId,
				displayName: "Member",
				email: "media-clock@test.local",
				updatedAt: Date.now(),
			});
			await ctx.db.patch("users", f.member.userId, { clerkUserId: "media-clock-member", anagraphic });
		});
		const before = await read_clocks(f);
		await f.t.mutation(internal.data_deletion.init_user_deletion, { userId: f.member.userId });
		expect(await f.t.run((ctx) => ctx.db.get("organizations_workspaces_users", f.membership._id))).toMatchObject({
			active: false,
		});
		await expect_clocks(f, before, [f.owner.workspaceId, f.member.workspaceId]);
		const deleted = await read_clocks(f);
		const restored = await f.t.mutation(internal.users.resolve_user, {
			clerkUserId: "media-clock-returning-member",
			email: "media-clock@test.local",
			displayName: "Member",
		});
		if (restored._nay) throw new Error(restored._nay.message);
		expect(restored._yay.userId).toBe(f.member.userId);
		expect(await f.t.run((ctx) => ctx.db.get("organizations_workspaces_users", f.membership._id))).toMatchObject({
			active: true,
		});
		await expect_clocks(f, deleted, [f.owner.workspaceId, f.member.workspaceId]);
	});

	test("owned organization teardown advances the organization and workspace clocks only on the first call", async () => {
		const f = await fixture();
		const before = await read_clocks(f);
		await f.t.mutation(internal.data_deletion.init_user_deletion, { userId: f.owner.userId });
		expect(await f.t.run((ctx) => ctx.db.get("organizations_workspaces_users", f.membership._id))).toBeNull();
		for (const workspaceId of [f.owner.workspaceId, f.siblingId]) {
			expect(await f.t.run((ctx) => ctx.db.get("organizations_workspaces", workspaceId))).toHaveProperty(
				"pluginDataPurgeStartedAt",
			);
		}
		await expect_clocks(f, before, [null, f.owner.workspaceId, f.siblingId]);
		const deleted = await read_clocks(f);
		await f.t.mutation(internal.data_deletion.init_user_deletion, { userId: f.owner.userId });
		await expect_clocks(f, deleted, []);
	});

	test("data reset replaces the workspace clock when it clears the purge fence", async () => {
		const f = await fixture();
		let cleared = false;
		for (let pass = 0; pass < 50; pass++) {
			const workspace = await f.t.run((ctx) => ctx.db.get("organizations_workspaces", f.member.workspaceId));
			const before = await read_clocks(f);
			const result = await f.t.mutation(internal.data_deletion.hard_delete_user_data, {
				userId: f.member.userId,
				_test_batchSize: 1,
			});
			const after = await f.t.run((ctx) => ctx.db.get("organizations_workspaces", f.member.workspaceId));
			if (workspace?.pluginDataPurgeStartedAt !== undefined && after?.pluginDataPurgeStartedAt === undefined) {
				expect(after?._id).toBe(f.member.workspaceId);
				const afterClocks = await read_clocks(f);
				const newW = afterClocks.versions.find((doc) => doc.workspaceId === f.member.workspaceId);
				expect(newW?.revision).toBeGreaterThan(0);
				const oldW = before.versions.find((doc) => doc.workspaceId === f.member.workspaceId);
				if (oldW) expect(newW?._id).not.toBe(oldW._id);
				await expect_clocks(
					f,
					{ ...before, versions: before.versions.filter((doc) => doc.workspaceId !== f.member.workspaceId) },
					[],
				);
				cleared = true;
			}
			if (result.done) break;
		}
		expect(cleared).toBe(true);
	});

	test("personal reset role drain advances its organization clock", async () => {
		const f = await fixture();
		const created = await f.t
			.withIdentity({ issuer: "https://clerk.test", external_id: f.member.userId })
			.mutation(api.access_control.create_role, {
				organizationId: f.member.organizationId,
				name: "Private reviewer",
				description: "",
				permissions: ["content.read"],
			});
		if (created._nay) throw new Error(created._nay.message);
		let checked = false;
		for (let pass = 0; pass < 60; pass++) {
			const before = (await read_clocks(f)).versions.find(
				(doc) => doc.organizationId === f.member.organizationId && doc.workspaceId === null,
			)!;
			await f.t.mutation(internal.data_deletion.hard_delete_user_data, {
				userId: f.member.userId,
				_test_batchSize: 1,
			});
			if (!(await f.t.run((ctx) => ctx.db.get("access_control_roles", created._yay.roleId)))) {
				expect(await f.t.run((ctx) => ctx.db.get("organizations", f.member.organizationId))).not.toBeNull();
				const after = await f.t.run((ctx) => ctx.db.get("files_media_validation_versions", before._id));
				expect(after?.revision).toBeGreaterThan(before.revision);
				checked = true;
				break;
			}
		}
		expect(checked).toBe(true);
	});

	test("reset fence clear creates the workspace clock even after the prior workspace clock was purged", async () => {
		const f = await fixture();
		let checked = false;
		for (let pass = 0; pass < 60; pass++) {
			const before = await f.t.run((ctx) => ctx.db.get("organizations_workspaces", f.member.workspaceId));
			await f.t.mutation(internal.data_deletion.hard_delete_user_data, {
				userId: f.member.userId,
				_test_batchSize: 1,
			});
			const after = await f.t.run((ctx) => ctx.db.get("organizations_workspaces", f.member.workspaceId));
			if (before?.pluginDataPurgeStartedAt !== undefined && after?.pluginDataPurgeStartedAt === undefined) {
				expect(after?._id).toBe(f.member.workspaceId);
				const clock = (await read_clocks(f)).versions.find((doc) => doc.workspaceId === f.member.workspaceId);
				expect(clock?.revision).toBeGreaterThan(0);
				checked = true;
				break;
			}
		}
		expect(checked).toBe(true);
	});

	test("bounded account grant cleanup advances the file workspace clock", async () => {
		const f = await fixture();
		const nodeId = await create_folder(f);
		expect(
			await f.asOwner.mutation(api.files_sharing.restrict_node, { membershipId: f.owner.membershipId, nodeId }),
		).toEqual({ _yay: null });
		expect(
			await f.asOwner.mutation(api.files_sharing.set_node_share_grant, {
				membershipId: f.owner.membershipId,
				nodeId,
				principal: { kind: "user", userId: f.member.userId },
				level: "read",
			}),
		).toEqual({ _yay: null });
		await f.t.mutation(internal.data_deletion.init_user_deletion, { userId: f.member.userId });
		let removed = false;
		for (let pass = 0; pass < 20; pass++) {
			const before = await read_clocks(f);
			await f.t.mutation(internal.data_deletion.prepare_user_for_hard_deletion, {
				userId: f.member.userId,
				_test_batchSize: 1,
			});
			if ((await f.t.run((ctx) => ctx.db.query("access_control_permission_grants").collect())).length === 0) {
				await expect_clocks(f, before, [f.owner.workspaceId]);
				removed = true;
				break;
			}
		}
		expect(removed).toBe(true);
	});

	test("bounded account role cleanup advances the organization clock", async () => {
		const f = await fixture();
		await f.t.mutation(internal.data_deletion.prepare_user_for_hard_deletion, { userId: f.member.userId });
		let removed = false;
		for (let pass = 0; pass < 30; pass++) {
			const before = await read_clocks(f);
			await f.t.mutation(internal.data_deletion.finalize_user_deletion_data, {
				userId: f.member.userId,
				_test_batchSize: 1,
				_test_disableReschedule: true,
			});
			if ((await f.t.run((ctx) => ctx.db.query("access_control_role_assignments").collect())).length === 0) {
				await expect_clocks(f, before, [null]);
				removed = true;
				break;
			}
		}
		expect(removed).toBe(true);
	});

	test("bounded organization purge invalidates the organization clock for assignment, role, and organization deletion", async () => {
		const f = await fixture();
		const roleId = await create_role(f);
		const requestId = await f.t.run((ctx) =>
			data_deletion_db_request(ctx, {
				userId: f.owner.userId,
				organizationId: f.owner.organizationId,
				scope: "organization",
				eligibleAt: 0,
			}),
		);
		const removed = new Set<string>();
		for (let pass = 0; pass < 80; pass++) {
			const before = await read_clocks(f);
			const old = await f.t.run(async (ctx) => ({
				assignments: await ctx.db.query("access_control_role_assignments").collect(),
				role: await ctx.db.get("access_control_roles", roleId),
				organization: await ctx.db.get("organizations", f.owner.organizationId),
			}));
			await f.t.mutation(internal.data_deletion.process_organization_deletion_request, {
				requestId,
				_test_batchSize: 1,
			});
			const current = await f.t.run(async (ctx) => ({
				assignments: await ctx.db.query("access_control_role_assignments").collect(),
				role: await ctx.db.get("access_control_roles", roleId),
				organization: await ctx.db.get("organizations", f.owner.organizationId),
			}));
			const changes = [
				...(old.assignments.length > current.assignments.length ? ["assignment"] : []),
				...(old.role && !current.role ? ["role"] : []),
				...(old.organization && !current.organization ? ["organization"] : []),
			];
			const oldO = before.versions.find(
				(doc) => doc.organizationId === f.owner.organizationId && doc.workspaceId === null,
			)!;
			const newO = await f.t.run((ctx) => ctx.db.get("files_media_validation_versions", oldO._id));
			if (changes.length) {
				if (changes.includes("organization")) expect(newO).toBeNull();
				else expect(newO?.revision).toBeGreaterThan(oldO.revision);
				for (const change of changes) removed.add(change);
			} else expect(newO).toEqual(oldO);
			if (!current.organization) break;
		}
		expect([...removed].sort()).toEqual(["assignment", "organization", "role"]);
	});

	test("final organization deletion invalidates a pin by removing its organization clock identity", async () => {
		const f = await fixture();
		const requestId = await f.t.run((ctx) =>
			data_deletion_db_request(ctx, {
				userId: f.owner.userId,
				organizationId: f.owner.organizationId,
				scope: "organization",
				eligibleAt: 0,
			}),
		);
		let checked = false;
		for (let pass = 0; pass < 100; pass++) {
			const before = (await read_clocks(f)).versions.find(
				(doc) => doc.organizationId === f.owner.organizationId && doc.workspaceId === null,
			)!;
			const pins = { versions: [{ id: before._id, revision: before.revision }], pendingVersions: [] };
			expect(await f.t.run((ctx) => files_media_validation_db_versions_match(ctx, pins))).toBe(true);
			await f.t.mutation(internal.data_deletion.process_organization_deletion_request, {
				requestId,
				_test_batchSize: 1,
			});
			if (!(await f.t.run((ctx) => ctx.db.get("organizations", f.owner.organizationId)))) {
				expect(await f.t.run((ctx) => files_media_validation_db_versions_match(ctx, pins))).toBe(false);
				expect(await f.t.run((ctx) => ctx.db.get("files_media_validation_versions", before._id))).toBeNull();
				checked = true;
				break;
			}
		}
		expect(checked).toBe(true);
	});

	test("membership ensure changes the workspace clock only when its marker changes", async () => {
		const f = await fixture();
		const ownerMembership = await f.t.run((ctx) => ctx.db.get("organizations_workspaces_users", f.owner.membershipId));
		if (!ownerMembership) throw new Error("Missing owner membership");
		const before = await read_clocks(f);
		expect(await f.t.run((ctx) => organizations_membership_lifetimes_db_ensure(ctx, ownerMembership))).toBe(1);
		expect(
			await f.t.run((ctx) =>
				ctx.db
					.query("organizations_membership_lifetimes")
					.withIndex("by_workspace_user", (q) => q.eq("workspaceId", f.owner.workspaceId).eq("userId", f.owner.userId))
					.unique(),
			),
		).toMatchObject({ active: true, lifetime: 1 });
		await expect_clocks(f, before, [f.owner.workspaceId]);
		const ensured = await read_clocks(f);
		await f.t.run((ctx) => organizations_membership_lifetimes_db_ensure(ctx, ownerMembership));
		await expect_clocks(f, ensured, []);
	});

	test("membership removal and reinvite change the workspace clock and preserve old lifetime refusal", async () => {
		const f = await fixture();
		const before = await read_clocks(f);
		expect(
			await f.asOwner.mutation(api.organizations.remove_user_from_organization, {
				organizationId: f.owner.organizationId,
				userIdToRemove: f.member.userId,
			}),
		).toEqual({ _yay: null });
		expect(await f.t.run((ctx) => ctx.db.get("organizations_workspaces_users", f.membership._id))).toBeNull();
		await expect_clocks(f, before, [null, f.owner.workspaceId]);
		const removed = await read_clocks(f);
		vi.setSystemTime(Date.now() + 60_000);
		expect(
			await f.asOwner.mutation(api.organizations.invite_user_to_organization_workspace, {
				organizationId: f.owner.organizationId,
				workspaceId: f.owner.workspaceId,
				userIdToAdd: f.member.userId,
			}),
		).toEqual({ _yay: null });
		expect(
			await f.t.run((ctx) =>
				ctx.db
					.query("organizations_membership_lifetimes")
					.withIndex("by_workspace_user", (q) => q.eq("workspaceId", f.owner.workspaceId).eq("userId", f.member.userId))
					.unique(),
			),
		).toMatchObject({ active: true, lifetime: 2 });
		await expect_clocks(f, removed, [null, f.owner.workspaceId]);
	});

	test("member grant continuation advances the organization clock after roles and membership are already revoked", async () => {
		const f = await fixture();
		// Each manage grant adds three docs, so 35 folders need a second 100-doc removal pass.
		for (let index = 0; index < 35; index++) {
			vi.setSystemTime(Date.now() + 60_000);
			const nodeId = await create_folder(f, `private-${index}`);
			expect(
				await f.asOwner.mutation(api.files_sharing.restrict_node, { membershipId: f.owner.membershipId, nodeId }),
			).toEqual({ _yay: null });
			expect(
				await f.asOwner.mutation(api.files_sharing.set_node_share_grant, {
					membershipId: f.owner.membershipId,
					nodeId,
					principal: { kind: "user", userId: f.member.userId },
					level: "manage",
				}),
			).toEqual({ _yay: null });
		}
		expect(
			await f.asOwner.mutation(api.organizations.remove_user_from_organization, {
				organizationId: f.owner.organizationId,
				userIdToRemove: f.member.userId,
			}),
		).toEqual({ _yay: null });
		expect(await f.t.run((ctx) => ctx.db.get("organizations_workspaces_users", f.membership._id))).toMatchObject({
			active: false,
			pendingOrganizationRemoval: true,
		});
		expect(await f.t.run((ctx) => ctx.db.query("access_control_role_assignments").collect())).toEqual([]);
		expect(await f.t.run((ctx) => ctx.db.query("access_control_permission_grants").collect())).toHaveLength(5);
		const before = await read_clocks(f);
		await f.t.mutation(internal.organizations.continue_remove_user_from_organization, {
			organizationId: f.owner.organizationId,
			userId: f.member.userId,
		});
		expect(await f.t.run((ctx) => ctx.db.query("access_control_permission_grants").collect())).toEqual([]);
		await expect_clocks(f, before, [null]);
	});

	test("repeated inactive lifetime recording keeps the workspace clock unchanged", async () => {
		const f = await fixture();
		expect(
			await f.asOwner.mutation(api.organizations.remove_user_from_organization, {
				organizationId: f.owner.organizationId,
				userIdToRemove: f.member.userId,
			}),
		).toEqual({ _yay: null });
		const before = await read_clocks(f);
		await f.t.run((ctx) =>
			organizations_membership_lifetimes_db_record(ctx, [{ membership: f.membership, active: false }]),
		);
		await expect_clocks(f, before, []);
	});

	test.each([false, true])(
		"workspace deletion advances the workspace clock and only advances the organization clock if it deletes assignments (%s)",
		async (assigned) => {
			const f = await fixture();
			if (assigned) {
				expect(
					await f.asOwner.mutation(api.organizations.invite_user_to_organization_workspace, {
						organizationId: f.owner.organizationId,
						workspaceId: f.siblingId,
						userIdToAdd: f.member.userId,
					}),
				).toEqual({ _yay: null });
				expect(
					await f.asOwner.mutation(api.access_control.set_user_role, {
						organizationId: f.owner.organizationId,
						workspaceId: f.siblingId,
						userId: f.member.userId,
						role: "admin",
					}),
				).toEqual({ _yay: null });
				vi.setSystemTime(Date.now() + 60_000);
			}
			const before = await read_clocks(f);
			expect(await f.asOwner.mutation(api.organizations.delete_workspace, { workspaceId: f.siblingId })).toEqual({
				_yay: null,
			});
			expect(await f.t.run((ctx) => ctx.db.get("organizations_workspaces", f.siblingId))).toBeNull();
			expect(await f.t.run((ctx) => ctx.db.query("access_control_role_assignments").collect())).toEqual([
				expect.objectContaining({ workspaceId: f.owner.workspaceId, userId: f.member.userId, role: "member" }),
			]);
			await expect_clocks(f, before, assigned ? [null, f.siblingId] : [f.siblingId]);
		},
	);

	test("organization deletion advances the organization clock and fences each workspace clock", async () => {
		const f = await fixture();
		const before = await read_clocks(f);
		expect(
			await f.asOwner.mutation(api.organizations.delete_organization, { organizationId: f.owner.organizationId }),
		).toEqual({ _yay: null });
		for (const workspaceId of [f.owner.workspaceId, f.siblingId])
			expect(await f.t.run((ctx) => ctx.db.get("organizations_workspaces", workspaceId))).toHaveProperty(
				"pluginDataPurgeStartedAt",
			);
		await expect_clocks(f, before, [null, f.owner.workspaceId, f.siblingId]);
	});

	test("purge entry advances the workspace clock once while data drains", async () => {
		const f = await fixture();
		// Keep both passes in file cleanup, before pending-review clocks are removed.
		await create_folder(f, "shared/child");
		const requestId = await f.t.run((ctx) =>
			data_deletion_db_request(ctx, {
				userId: f.owner.userId,
				organizationId: f.owner.organizationId,
				workspaceId: f.owner.workspaceId,
				scope: "workspace",
				eligibleAt: 0,
			}),
		);
		const before = await read_clocks(f);
		await f.t.mutation(internal.data_deletion.process_workspace_deletion_request, { requestId, _test_batchSize: 1 });
		expect(await f.t.run((ctx) => ctx.db.get("organizations_workspaces", f.owner.workspaceId))).toHaveProperty(
			"pluginDataPurgeStartedAt",
		);
		await expect_clocks(f, before, [f.owner.workspaceId]);
		const fenced = await read_clocks(f);
		await f.t.mutation(internal.data_deletion.process_workspace_deletion_request, { requestId, _test_batchSize: 1 });
		await expect_clocks(f, fenced, []);
	});

	test("final workspace purge removes its workspace clock identity", async () => {
		const f = await fixture();
		const oldW = (await read_clocks(f)).versions.find((doc) => doc.workspaceId === f.owner.workspaceId)!;
		const requestId = await f.t.run((ctx) =>
			data_deletion_db_request(ctx, {
				userId: f.owner.userId,
				organizationId: f.owner.organizationId,
				workspaceId: f.owner.workspaceId,
				scope: "workspace",
				eligibleAt: 0,
			}),
		);
		let done = false;
		for (let pass = 0; pass < 80; pass++) {
			const result = await f.t.mutation(internal.data_deletion.process_workspace_deletion_request, {
				requestId,
				_test_batchSize: 1,
			});
			if (result.done) {
				done = true;
				break;
			}
		}
		expect(done).toBe(true);
		expect(await f.t.run((ctx) => ctx.db.get("data_deletion_requests", requestId))).toBeNull();
		expect(await f.t.run((ctx) => ctx.db.get("files_media_validation_versions", oldW._id))).toBeNull();
	});

	test("automatic owner handoff advances the organization clock", async () => {
		const f = await fixture();
		await f.t.mutation(internal.data_deletion.prepare_user_for_hard_deletion, { userId: f.owner.userId });
		const before = await read_clocks(f);
		for (let pass = 0; pass < 30; pass++) {
			await f.t.mutation(internal.data_deletion.finalize_user_deletion_data, {
				userId: f.owner.userId,
				_test_disableReschedule: true,
			});
			const organization = await f.t.run((ctx) => ctx.db.get("organizations", f.owner.organizationId));
			if (organization?.ownerUserId === f.member.userId) break;
		}
		expect(await f.t.run((ctx) => ctx.db.get("organizations", f.owner.organizationId))).toMatchObject({
			ownerUserId: f.member.userId,
			billingMode: "user",
		});
		await expect_clocks(f, before, [null]);
	});
});
