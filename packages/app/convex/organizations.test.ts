import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { R2 } from "@convex-dev/r2";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import {
	organizations_db_create,
	organizations_db_create_workspace,
	organizations_db_ensure_default_organization_and_workspace_for_user,
} from "./organizations.ts";
import {
	access_control_db_ensure_public_permission_grant,
	access_control_db_ensure_role_assignment,
	access_control_db_ensure_role_permission_grant,
	access_control_db_ensure_user_permission_grant,
	access_control_db_has_permission,
} from "./access_control.ts";
import { Result } from "common/errors-as-values-utils.ts";
import { quotas_db_ensure } from "./quotas.ts";
import { organizations_DESCRIPTION_MAX_LENGTH, organizations_NAME_MAX_LENGTH } from "../shared/organizations.ts";
import { files_get_utf8_byte_size } from "../server/files.ts";

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

beforeEach(() => {
	vi.spyOn(R2.prototype, "deleteObject").mockResolvedValue(undefined);
});

afterEach(() => {
	vi.restoreAllMocks();
});

async function organizations_test_process_workspace_deletion_request_until_done(
	t: ReturnType<typeof test_convex>,
	args: { requestId: Id<"data_deletion_requests"> },
) {
	for (let i = 0; i < 100; i += 1) {
		const result = await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.process_workspace_deletion_request, {
				requestId: args.requestId,
			}),
		);
		if (result.done) {
			return;
		}
	}

	throw new Error("Workspace deletion request did not finish");
}

async function organizations_test_process_organization_deletion_request_until_done(
	t: ReturnType<typeof test_convex>,
	args: { requestId: Id<"data_deletion_requests"> },
) {
	for (let i = 0; i < 200; i += 1) {
		const result = await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.process_organization_deletion_request, {
				requestId: args.requestId,
			}),
		);
		if (result.done) {
			return;
		}
	}

	throw new Error("Organization deletion request did not finish");
}

async function organizations_test_seed_default_organization(ctx: MutationCtx, args: { userId: Id<"users">; now?: number }) {
	await organizations_db_ensure_default_organization_and_workspace_for_user(ctx, {
		userId: args.userId,
		now: args.now ?? Date.now(),
	});

	const user = await ctx.db.get("users", args.userId);
	if (!user?.defaultOrganizationId || !user.defaultWorkspaceId) {
		throw new Error("Failed to seed default organization");
	}

	const organization = await ctx.db.get("organizations", user.defaultOrganizationId);
	if (!organization) {
		throw new Error("Failed to load seeded default organization");
	}

	return Result({
		_yay: {
			organizationId: user.defaultOrganizationId,
			defaultWorkspaceId: user.defaultWorkspaceId,
			name: organization.name,
			defaultWorkspaceName: "home",
		},
	});
}

async function organizations_test_bootstrap_user(t: ReturnType<typeof test_convex>, args: { userId: Id<"users"> }) {
	await t.run(async (ctx) => {
		const now = Date.now();
		await quotas_db_ensure(ctx, {
			quotaName: "extra_organizations",
			userId: args.userId,
			now,
		});

		await organizations_db_ensure_default_organization_and_workspace_for_user(ctx, {
			userId: args.userId,
			now,
		});
	});
}

async function organizations_test_bootstrap_users(
	t: ReturnType<typeof test_convex>,
	args: { userIds: readonly Id<"users">[] },
) {
	await Promise.all(args.userIds.map((userId) => organizations_test_bootstrap_user(t, { userId })));
}

async function organizations_test_read_user_extra_organization_quota_doc(ctx: MutationCtx, args: { userId: Id<"users"> }) {
	return await ctx.db
		.query("quotas")
		.withIndex("by_user_quotaName", (q) => q.eq("userId", args.userId).eq("quotaName", "extra_organizations"))
		.first();
}

async function organizations_test_read_organization_extra_workspace_quota_doc(
	ctx: MutationCtx,
	args: { organizationId: Id<"organizations"> },
) {
	return await ctx.db
		.query("quotas")
		.withIndex("by_organization_quotaName", (q) =>
			q.eq("organizationId", args.organizationId).eq("quotaName", "extra_workspaces"),
		)
		.first();
}

async function organizations_test_collect_notifications_for_user(ctx: MutationCtx, args: { userId: Id<"users"> }) {
	return (
		await Promise.all([
			ctx.db
				.query("notifications")
				.withIndex("by_user_read", (q) => q.eq("userId", args.userId).eq("read", false))
				.collect(),
			ctx.db
				.query("notifications")
				.withIndex("by_user_read", (q) => q.eq("userId", args.userId).eq("read", true))
				.collect(),
		])
	).flat();
}

async function organizations_test_seed_workspace_scoped_rows(
	ctx: MutationCtx,
	args: {
		userId: Id<"users">;
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		tag: string;
	},
) {
	const nodeId = await ctx.db.insert("files_nodes", {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		path: `/${args.tag}-page`,
		treePath: `/${args.tag}-page`,
		pathDepth: 1,
		name: `${args.tag}-page`,
		kind: "file",
		lowercaseExtension: null,
		parentId: "root",
		createdBy: args.userId,
		updatedBy: args.userId,
		updatedAt: Date.now(),
	});
	const assetId = await ctx.db.insert("files_r2_assets", {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		kind: "content",
		r2Bucket: "test-bucket",
		r2Key: `content/organizations/${args.organizationId}/workspaces/${args.workspaceId}/assets/${args.tag}`,
		size: files_get_utf8_byte_size(`# ${args.tag}`),
		createdBy: args.userId,
		updatedAt: Date.now(),
	});
	await ctx.db.patch("files_nodes", nodeId, {
		assetId,
		contentType: "text/markdown;charset=utf-8",
	});

	const aiThreadId = await ctx.db.insert("ai_chat_threads", {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		clientGeneratedId: `${args.tag}-thread`,
		title: `${args.tag} thread`,
		archived: false,
		runtime: "aisdk_5",
		stateId: null,
		createdBy: args.userId,
		updatedBy: args.userId,
		updatedAt: Date.now(),
		lastMessageAt: Date.now(),
	});
	const aiThreadStateId = await ctx.db.insert("ai_chat_threads_state", {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		threadId: aiThreadId,
		bashCwd: "~",
		updatedBy: args.userId,
		updatedAt: Date.now(),
	});
	await ctx.db.patch("ai_chat_threads", aiThreadId, {
		stateId: aiThreadStateId,
	});
	await ctx.db.insert("ai_chat_threads_messages_aisdk_5", {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		parentId: null,
		threadId: aiThreadId,
		clientGeneratedMessageId: `${args.tag}-message`,
		content: {},
		createdBy: args.userId,
		updatedAt: Date.now(),
	});

	await ctx.db.insert("chat_messages", {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		threadId: null,
		parentId: null,
		isArchived: false,
		createdBy: args.userId,
		content: `${args.tag} chat`,
	});
}

describe("create_organization", () => {
	test("accepts names with digits after the first character", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-digits-ws",
			}),
		);
		await organizations_test_bootstrap_user(t, { userId });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "organizations-test-user@test.local",
		});

		const result = await asUser.mutation(api.organizations.create_organization, {
			description: "",
			name: "team-2-east",
		});

		expect(result._yay?.name).toBe("team-2-east");
	});

	test("accepts valid lowercase dash names", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-1",
			}),
		);
		await organizations_test_bootstrap_user(t, { userId });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "organizations-test-user@test.local",
		});

		const result = await asUser.mutation(api.organizations.create_organization, {
			description: "",
			name: "acme-labs",
		});

		expect(result._yay).toBeTruthy();
		expect(result._yay?.name).toBe("acme-labs");
		expect(result._yay?.defaultWorkspaceName).toBe("home");

		const { organization, workspace, ownerRole, permissionGrants, userQuota, organizationQuota } = result._yay
			? await t.run(async (ctx) => {
					const [organization, workspace, ownerRole, permissionGrants, userQuota, organizationQuota] = await Promise.all([
						ctx.db.get("organizations", result._yay!.organizationId),
						ctx.db.get("organizations_workspaces", result._yay!.defaultWorkspaceId),
						ctx.db
							.query("access_control_role_assignments")
							.withIndex("by_organization_workspace_role_user", (q) =>
								q
									.eq("organizationId", result._yay!.organizationId)
									.eq("workspaceId", result._yay!.defaultWorkspaceId)
									.eq("role", "owner"),
							)
							.first(),
						ctx.db
							.query("access_control_permission_grants")
							.withIndex("by_organization_workspace_resource_user_permission", (q) =>
								q.eq("organizationId", result._yay!.organizationId),
							)
							.collect(),
						organizations_test_read_user_extra_organization_quota_doc(ctx, { userId }),
						organizations_test_read_organization_extra_workspace_quota_doc(ctx, { organizationId: result._yay!.organizationId }),
					]);

					return {
						organization,
						workspace,
						ownerRole,
						permissionGrants,
						userQuota,
						organizationQuota,
					};
				})
			: {
					organization: null,
					workspace: null,
					ownerRole: null,
					permissionGrants: [],
					userQuota: null,
					organizationQuota: null,
				};

		expect(organization?.name).toBe("acme-labs");
		expect(organization?.billingMode).toBe("user");
		expect(organization?.ownerUserId).toBe(userId);
		expect(ownerRole?.userId).toBe(userId);
		expect(permissionGrants.some((grant) => grant.role === "member" && grant.permission === "workspace.create")).toBe(
			true,
		);
		expect(
			permissionGrants.some((grant) => grant.role === "admin" && grant.permission === "organization.members.manage"),
		).toBe(true);
		expect(
			permissionGrants.some((grant) => grant.role === "member" && grant.permission === "organization.members.manage"),
		).toBe(false);
		expect(
			permissionGrants.some((grant) => grant.role === "admin" && grant.permission === "organization.roles.manage"),
		).toBe(true);
		expect(workspace?.name).toBe("home");
		expect(userQuota?.usedCount).toBe(1);
		expect(userQuota?.maxCount).toBe(2);
		expect(organizationQuota?.usedCount).toBe(0);
		expect(organizationQuota?.maxCount).toBe(5);
	});

	test("rejects names that are still invalid after autofix", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-2",
			}),
		);
		await organizations_test_bootstrap_user(t, { userId });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "organizations-test-user@test.local",
		});

		const invalidNames = ["", "!!!", "---", "   ", "\t\t", "ab", "a", "12"];

		for (const name of invalidNames) {
			const result = await asUser.mutation(api.organizations.create_organization, {
				description: "",
				name,
			});

			expect(result._nay?.message).toBeTruthy();
		}
	});

	test("rejects names shorter than 3 characters after autofix", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-short-name",
			}),
		);
		await organizations_test_bootstrap_user(t, { userId });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "organizations-test-user@test.local",
		});

		const result = await asUser.mutation(api.organizations.create_organization, {
			description: "",
			name: "  !!ab!!  ",
		});

		expect(result._nay?.message).toBe("Name must be at least 3 characters");
	});

	test("rejects names longer than max length", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-long-name-ws",
			}),
		);
		await organizations_test_bootstrap_user(t, { userId });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "organizations-test-user@test.local",
		});

		const result = await asUser.mutation(api.organizations.create_organization, {
			description: "",
			name: "a".repeat(organizations_NAME_MAX_LENGTH + 1),
		});

		expect(result._nay?.message).toBe("Name must be at most 20 characters");
	});

	test("autofixes messy organization names before create", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-autofix-ws",
			}),
		);
		await organizations_test_bootstrap_user(t, { userId });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "organizations-test-user@test.local",
		});

		const result = await asUser.mutation(api.organizations.create_organization, {
			description: "",
			name: "  Acme Labs!!  ",
		});

		expect(result._yay?.name).toBe("acme-labs");
	});

	test("rejects duplicate global organization names", async () => {
		const t = test_convex();
		const userIds = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", {
					clerkUserId: "clerk-user-3",
				}),
				ctx.db.insert("users", {
					clerkUserId: "clerk-user-4",
				}),
			]),
		);
		await organizations_test_bootstrap_users(t, { userIds });

		const firstUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userIds[0],
			name: "First User",
			email: "organizations-test-user@test.local",
		});
		const secondUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userIds[1],
			name: "Second User",
			email: "organizations-test-user@test.local",
		});

		const firstResult = await firstUser.mutation(api.organizations.create_organization, {
			description: "",
			name: "acme",
		});
		expect(firstResult._yay).toBeTruthy();

		const secondResult = await secondUser.mutation(api.organizations.create_organization, {
			description: "",
			name: "acme",
		});
		expect(secondResult._nay?.message).toBe("Organization name already exists");
	});

	test("allows duplicate default personal organizations across users", async () => {
		const t = test_convex();
		const results = await t.run(async (ctx) =>
			Promise.all([
				ctx.db
					.insert("users", {
						clerkUserId: "clerk-user-4",
					})
					.then((userId) => organizations_test_seed_default_organization(ctx, { userId })),
				ctx.db
					.insert("users", {
						clerkUserId: "clerk-user-5",
					})
					.then((userId) => organizations_test_seed_default_organization(ctx, { userId })),
			]),
		);

		expect(results[0]._yay).toBeTruthy();
		expect(results[1]._yay).toBeTruthy();
	});

	test("stores empty description as empty string on organization and default workspace", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-ws-desc-empty",
			}),
		);
		await organizations_test_bootstrap_user(t, { userId });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "organizations-test-user@test.local",
		});

		const result = await asUser.mutation(api.organizations.create_organization, {
			description: "",
			name: "with-empty-desc",
		});
		expect(result._yay).toBeTruthy();

		const organization = await t.run((ctx) => ctx.db.get("organizations", result._yay!.organizationId));
		const workspace = await t.run((ctx) => ctx.db.get("organizations_workspaces", result._yay!.defaultWorkspaceId));
		expect(organization?.description).toBe("");
		expect(workspace?.description).toBe("");
	});

	test("trims organization description", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-ws-desc-trim",
			}),
		);
		await organizations_test_bootstrap_user(t, { userId });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "organizations-test-user@test.local",
		});

		const result = await asUser.mutation(api.organizations.create_organization, {
			description: "  north star  ",
			name: "trim-desc-ws",
		});
		expect(result._yay).toBeTruthy();

		const organization = await t.run((ctx) => ctx.db.get("organizations", result._yay!.organizationId));
		expect(organization?.description).toBe("north star");
	});

	test("rejects description longer than max length", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-ws-desc-long",
			}),
		);
		await organizations_test_bootstrap_user(t, { userId });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "organizations-test-user@test.local",
		});

		const result = await asUser.mutation(api.organizations.create_organization, {
			description: "x".repeat(organizations_DESCRIPTION_MAX_LENGTH + 1),
			name: "long-desc-ws",
		});
		expect(result._nay?.message).toBe("Description is too long");
	});

	test("rejects creating a third owned non-default organization", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-third-extra-organization",
			}),
		);
		await organizations_test_bootstrap_user(t, { userId });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "organizations-test-user@test.local",
		});

		const first = await t.run((ctx) =>
			organizations_db_create(ctx, {
				userId,
				description: "",
				name: "first-extra-ws",
				now: Date.now(),
				default: false,
			}),
		);
		expect(first._yay).toBeTruthy();

		const second = await t.run((ctx) =>
			organizations_db_create(ctx, {
				userId,
				description: "",
				name: "second-extra-ws",
				now: Date.now(),
				default: false,
			}),
		);
		expect(second._yay).toBeTruthy();

		const third = await asUser.mutation(api.organizations.create_organization, {
			description: "",
			name: "third-extra-ws",
		});
		expect(third._nay?.message).toBe("Organization quota reached");
	});

	test("does not count shared non-default organizations against the owner's extra-organization quota", async () => {
		const t = test_convex();
		const [ownerId, memberId] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", { clerkUserId: "clerk-user-owned-extra-owner" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-owned-extra-member" }),
			]),
		);
		await organizations_test_bootstrap_users(t, { userIds: [ownerId, memberId] });
		const owner = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: ownerId,
			name: "Owner",
			email: "organizations-test-user@test.local",
		});
		const member = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: memberId,
			name: "Member",
			email: "organizations-test-user@test.local",
		});

		const sharedOrganization = await owner.mutation(api.organizations.create_organization, {
			description: "",
			name: "shared-extra-ws",
		});
		expect(sharedOrganization._yay).toBeTruthy();

		const shareResult = await owner.mutation(api.organizations.invite_user_to_organization_workspace, {
			organizationId: sharedOrganization._yay!.organizationId,
			workspaceId: sharedOrganization._yay!.defaultWorkspaceId,
			userIdToAdd: memberId,
		});
		expect(shareResult._yay).toBeNull();

		const ownOrganization = await member.mutation(api.organizations.create_organization, {
			description: "",
			name: "member-owned-ws",
		});
		expect(ownOrganization._yay?.name).toBe("member-owned-ws");
	});

	test("keeps exactly one user quota doc while creating extra organizations", async () => {
		const t = test_convex();
		const userId = await t.run((ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-quota-seed-organization",
			}),
		);
		await organizations_test_bootstrap_user(t, { userId });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "organizations-test-user@test.local",
		});

		const before = await t.run(async (ctx) =>
			(await ctx.db.query("quotas").collect()).filter(
				(doc) => doc.userId === userId && doc.quotaName === "extra_organizations",
			),
		);
		expect(before).toHaveLength(1);
		expect(before[0]?.usedCount).toBe(0);

		const created = await t.run((ctx) =>
			organizations_db_create(ctx, {
				userId,
				description: "",
				name: "lazy-seed-extra-ws",
				now: Date.now(),
				default: false,
			}),
		);
		expect(created._yay).toBeTruthy();

		const secondCreated = await t.run((ctx) =>
			organizations_db_create(ctx, {
				userId,
				description: "",
				name: "lazy-seed-extra-ws-2",
				now: Date.now(),
				default: false,
			}),
		);
		expect(secondCreated._yay).toBeTruthy();

		const blocked = await asUser.mutation(api.organizations.create_organization, {
			description: "",
			name: "lazy-seed-extra-ws-3",
		});
		expect(blocked._nay?.message).toBe("Organization quota reached");

		const after = await t.run(async (ctx) => {
			const [userQuotas, organizationQuotas] = await Promise.all([
				ctx.db.query("quotas").collect(),
				ctx.db.query("quotas").collect(),
			]);

			return {
				userQuotas: userQuotas.filter(
					(doc) => doc.userId === userId && doc.quotaName === "extra_organizations",
				),
				organizationQuotas: organizationQuotas.filter(
					(doc) => doc.organizationId === created._yay!.organizationId && doc.quotaName === "extra_workspaces",
				),
			};
		});

		expect(after.userQuotas).toHaveLength(1);
		expect(after.userQuotas[0]?.usedCount).toBe(2);
		expect(after.userQuotas[0]?.maxCount).toBe(2);
		expect(after.organizationQuotas).toHaveLength(1);
		expect(after.organizationQuotas[0]?.usedCount).toBe(0);
	});
});

describe("organizations_db_ensure_default_organization_and_workspace_for_user", () => {
	test("ensures default-organization bootstrap creates organization quotas when user quotas exist", async () => {
		const t = test_convex();
		const userId = await t.run((ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-ensure-default-quotas",
			}),
		);

		await t.run(async (ctx) => {
			const now = Date.now();
			await quotas_db_ensure(ctx, {
				quotaName: "extra_organizations",
				userId,
				now,
			});
			await organizations_db_ensure_default_organization_and_workspace_for_user(ctx, {
				userId,
				now,
			});
		});

		const rows = await t.run(async (ctx) => {
			const user = await ctx.db.get("users", userId);
			const organizationQuota = user?.defaultOrganizationId
				? await organizations_test_read_organization_extra_workspace_quota_doc(ctx, { organizationId: user.defaultOrganizationId })
				: null;
			const userQuota = await organizations_test_read_user_extra_organization_quota_doc(ctx, { userId });

			return {
				user,
				userQuota,
				organizationQuota,
			};
		});

		expect(rows.userQuota?.usedCount).toBe(0);
		expect(rows.userQuota?.maxCount).toBe(2);
		expect(rows.organizationQuota?.usedCount).toBe(0);
		expect(rows.organizationQuota?.maxCount).toBe(5);
	});

	test("creates exactly one personal/home default during anonymous user bootstrap", async () => {
		const t = test_convex();

		const userId = await t.run((ctx) =>
			ctx.db.insert("users", {
				clerkUserId: null,
			}),
		);
		await organizations_test_bootstrap_user(t, { userId });
		const after = await t.run(async (ctx) => {
			const user = await ctx.db.get("users", userId);
			const organization = user?.defaultOrganizationId ? await ctx.db.get("organizations", user.defaultOrganizationId) : null;
			const workspace = user?.defaultWorkspaceId ? await ctx.db.get("organizations_workspaces", user.defaultWorkspaceId) : null;
			const memberships = await ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_user_organization_workspace_active", (q) => q.eq("userId", userId))
				.collect();

			return {
				defaultPersonalMemberships: memberships.filter(
					(membership) =>
						membership.organizationId === user?.defaultOrganizationId && membership.workspaceId === user?.defaultWorkspaceId,
				),
				workspace,
				organization,
			};
		});

		expect(after.organization?.default).toBe(true);
		expect(after.organization?.name).toBe("personal");
		expect(after.workspace?.default).toBe(true);
		expect(after.workspace?.name).toBe("home");
		expect(after.workspace?.organizationId).toBe(after.organization?._id);
		expect(after.organization?.defaultWorkspaceId).toBe(after.workspace?._id);
		expect(after.defaultPersonalMemberships).toHaveLength(1);
	});

	test("does not create a second personal/home default when the user already has one", async () => {
		const t = test_convex();
		const userId = await t.run((ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-ensure-default-reuse",
			}),
		);

		const seeded = await t.run((ctx) => organizations_test_seed_default_organization(ctx, { userId }));
		expect(seeded._yay).toBeTruthy();

		await t.run(async (ctx) => {
			await organizations_db_ensure_default_organization_and_workspace_for_user(ctx, {
				userId,
				now: Date.now(),
			});
		});

		const after = await t.run(async (ctx) => {
			const user = await ctx.db.get("users", userId);
			const memberships = await ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_user_organization_workspace_active", (q) => q.eq("userId", userId))
				.collect();

			const defaultOrganizations = (
				await Promise.all(
					memberships.map(async (membership) => {
						const organization = await ctx.db.get("organizations", membership.organizationId);
						const workspace = await ctx.db.get("organizations_workspaces", membership.workspaceId);

						if (
							organization?.default &&
							organization.name === "personal" &&
							workspace?.default &&
							workspace.name === "home" &&
							workspace.organizationId === organization._id
						) {
							return { workspace, organization };
						}

						return null;
					}),
				)
			).filter((row) => row !== null);

			return {
				defaultOrganizations,
				user,
			};
		});

		expect(after.defaultOrganizations).toHaveLength(1);
		expect(after.user?.defaultOrganizationId).toBe(seeded._yay!.organizationId);
		expect(after.user?.defaultWorkspaceId).toBe(seeded._yay!.defaultWorkspaceId);
	});
});

describe("create_workspace", () => {
	test("creates a workspace for a member organization", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-create-ws",
			}),
		);
		await organizations_test_bootstrap_user(t, { userId });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "organizations-test-user@test.local",
		});

		const wsResult = await asUser.mutation(api.organizations.create_organization, {
			description: "",
			name: "ws-org",
		});
		expect(wsResult._yay).toBeTruthy();

		const result = await asUser.mutation(api.organizations.create_workspace, {
			description: "",
			organizationId: wsResult._yay!.organizationId,
			name: "docs",
		});

		expect(result._yay?.name).toBe("docs");

		const membership = result._yay
			? await t.run(async (ctx) => {
					const [membership, roleAssignment, workspaceGrant, organizationQuota] = await Promise.all([
						ctx.db
							.query("organizations_workspaces_users")
							.withIndex("by_workspace_user_active", (q) =>
								q.eq("workspaceId", result._yay!.workspaceId).eq("userId", userId),
							)
							.first(),
						ctx.db
							.query("access_control_role_assignments")
							.withIndex("by_organization_workspace_user_role", (q) =>
								q
									.eq("organizationId", wsResult._yay!.organizationId)
									.eq("workspaceId", result._yay!.workspaceId)
									.eq("userId", userId)
									.eq("role", "member"),
							)
							.first(),
						ctx.db
							.query("access_control_permission_grants")
							.withIndex("by_organization_workspace_resource_role_permission", (q) =>
								q
									.eq("organizationId", wsResult._yay!.organizationId)
									.eq("workspaceId", result._yay!.workspaceId)
									.eq("resourceKind", "workspace")
									.eq("resourceId", result._yay!.workspaceId)
									.eq("principalKind", "role")
									.eq("role", "member")
									.eq("permission", "workspace.update"),
							)
							.first(),
						organizations_test_read_organization_extra_workspace_quota_doc(ctx, { organizationId: wsResult._yay!.organizationId }),
					]);

					return {
						membership,
						roleAssignment,
						workspaceGrant,
						organizationQuota,
					};
				})
			: null;
		expect(membership?.membership).toBeTruthy();
		expect(membership?.roleAssignment).toBeTruthy();
		expect(membership?.workspaceGrant).toBeTruthy();
		expect(membership?.organizationQuota?.usedCount).toBe(1);
	});

	test("stores trimmed workspace description", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-ws-desc",
			}),
		);
		await organizations_test_bootstrap_user(t, { userId });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "organizations-test-user@test.local",
		});

		const wsResult = await asUser.mutation(api.organizations.create_organization, {
			description: "",
			name: "ws-desc-ws",
		});
		expect(wsResult._yay).toBeTruthy();

		const result = await asUser.mutation(api.organizations.create_workspace, {
			description: "  sprints  ",
			organizationId: wsResult._yay!.organizationId,
			name: "board",
		});
		expect(result._yay).toBeTruthy();

		const workspace = await t.run((ctx) => ctx.db.get("organizations_workspaces", result._yay!.workspaceId));
		expect(workspace?.description).toBe("sprints");
	});

	test("rejects duplicate workspace names in the same organization", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-create-ws-dup",
			}),
		);
		await organizations_test_bootstrap_user(t, { userId });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "organizations-test-user@test.local",
		});

		const wsResult = await t.run((ctx) =>
			organizations_db_create(ctx, {
				userId,
				description: "",
				name: "dup-ws-ws",
				now: Date.now(),
			}),
		);
		if (wsResult._nay) {
			throw new Error(wsResult._nay.message);
		}
		expect(wsResult._yay).toBeTruthy();

		const first = await asUser.mutation(api.organizations.create_workspace, {
			description: "",
			organizationId: wsResult._yay!.organizationId,
			name: "alpha",
		});
		expect(first._yay).toBeTruthy();

		const second = await asUser.mutation(api.organizations.create_workspace, {
			description: "",
			organizationId: wsResult._yay!.organizationId,
			name: "alpha",
		});
		expect(second._nay?.message).toBe("Workspace name already exists");
	});

	test("autofixes messy workspace names before create", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-autofix-ws",
			}),
		);
		await organizations_test_bootstrap_user(t, { userId });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "organizations-test-user@test.local",
		});

		const wsResult = await asUser.mutation(api.organizations.create_organization, {
			description: "",
			name: "autofix-ws-ws",
		});
		expect(wsResult._yay).toBeTruthy();

		const result = await asUser.mutation(api.organizations.create_workspace, {
			description: "",
			organizationId: wsResult._yay!.organizationId,
			name: "  My Docs!!  ",
		});

		expect(result._yay?.name).toBe("my-docs");
	});

	test("accepts workspace names with digits after the first character", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-digits-ws",
			}),
		);
		await organizations_test_bootstrap_user(t, { userId });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "organizations-test-user@test.local",
		});

		const wsResult = await asUser.mutation(api.organizations.create_organization, {
			description: "",
			name: "digits-ws-ws",
		});
		expect(wsResult._yay).toBeTruthy();

		const result = await asUser.mutation(api.organizations.create_workspace, {
			description: "",
			organizationId: wsResult._yay!.organizationId,
			name: "sprint-2",
		});

		expect(result._yay?.name).toBe("sprint-2");
	});

	test("rejects when the user is not in the organization", async () => {
		const t = test_convex();
		const userIds = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", { clerkUserId: "clerk-user-ws-a" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-ws-b" }),
			]),
		);
		await organizations_test_bootstrap_users(t, { userIds });

		const owner = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userIds[0],
			name: "Owner",
			email: "organizations-test-user@test.local",
		});

		const wsResult = await owner.mutation(api.organizations.create_organization, {
			description: "",
			name: "private-ws",
		});
		expect(wsResult._yay).toBeTruthy();

		const stranger = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userIds[1],
			name: "Stranger",
			email: "organizations-test-user@test.local",
		});

		const result = await stranger.mutation(api.organizations.create_workspace, {
			description: "",
			organizationId: wsResult._yay!.organizationId,
			name: "intruder",
		});
		expect(result._nay?.message).toBe("Not found");
	});

	test("allows creating a non-default workspace in the default organization", async () => {
		const t = test_convex();
		const userId = await t.run((ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-default-ws-create-block",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "organizations-test-user@test.local",
		});

		const created = await t.run((ctx) => organizations_test_seed_default_organization(ctx, { userId }));
		expect(created._yay).toBeTruthy();

		const result = await asUser.mutation(api.organizations.create_workspace, {
			description: "",
			organizationId: created._yay!.organizationId,
			name: "docs",
		});

		expect(result._yay).toBeTruthy();
		expect(result._yay?.name).toBe("docs");
	});

	test("rejects creating a sixth non-default workspace in the same organization", async () => {
		const t = test_convex();
		const userId = await t.run((ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-second-extra-ws",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "organizations-test-user@test.local",
		});

		const created = await t.run((ctx) => organizations_test_seed_default_organization(ctx, { userId }));
		expect(created._yay).toBeTruthy();

		for (const name of ["docs", "board", "roadmap", "tasks", "notes"]) {
			const result = await t.run((ctx) =>
				organizations_db_create_workspace(ctx, {
					userId,
					description: "",
					organizationId: created._yay!.organizationId,
					name,
					now: Date.now(),
				}),
			);
			if (result._nay) {
				throw new Error("Failed to seed sixth-ws quota test", {
					cause: result._nay,
				});
			}
			expect(result._yay?.name).toBe(name);
		}

		const sixth = await asUser.mutation(api.organizations.create_workspace, {
			description: "",
			organizationId: created._yay!.organizationId,
			name: "archive",
		});
		expect(sixth._nay?.message).toBe("Workspace quota reached");
	});

	test("does not let a shared member bypass the extra-ws quota", async () => {
		const t = test_convex();
		const [ownerId, memberId] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", { clerkUserId: "clerk-user-ws-quota-owner" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-ws-quota-member" }),
			]),
		);
		await organizations_test_bootstrap_users(t, { userIds: [ownerId, memberId] });
		const owner = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: ownerId,
			name: "Owner",
			email: "organizations-test-user@test.local",
		});
		const member = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: memberId,
			name: "Member",
			email: "organizations-test-user@test.local",
		});

		const sharedOrganization = await t.run((ctx) =>
			organizations_db_create(ctx, {
				userId: ownerId,
				description: "",
				name: "shared-ws-q",
				now: Date.now(),
			}),
		);
		if (sharedOrganization._nay) {
			throw new Error(sharedOrganization._nay.message);
		}
		expect(sharedOrganization._yay).toBeTruthy();

		for (const name of ["docs", "board", "roadmap", "tasks", "notes"]) {
			const extraWorkspace = await t.run((ctx) =>
				organizations_db_create_workspace(ctx, {
					userId: ownerId,
					description: "",
					organizationId: sharedOrganization._yay!.organizationId,
					name,
					now: Date.now(),
				}),
			);
			if (extraWorkspace._nay) {
				throw new Error("Failed to seed shared workspace quota test", {
					cause: extraWorkspace._nay,
				});
			}
			expect(extraWorkspace._yay?.name).toBe(name);
		}

		const shareResult = await owner.mutation(api.organizations.invite_user_to_organization_workspace, {
			organizationId: sharedOrganization._yay!.organizationId,
			workspaceId: sharedOrganization._yay!.defaultWorkspaceId,
			userIdToAdd: memberId,
		});
		expect(shareResult._yay).toBeNull();

		const result = await member.mutation(api.organizations.create_workspace, {
			description: "",
			organizationId: sharedOrganization._yay!.organizationId,
			name: "archive",
		});
		expect(result._nay?.message).toBe("Workspace quota reached");
	});

	test("keeps exactly one organization quota doc while creating extra workspaces", async () => {
		const t = test_convex();
		const userId = await t.run((ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-quota-seed-ws",
			}),
		);
		await organizations_test_bootstrap_user(t, { userId });

		const organizationResult = await t.run((ctx) =>
			organizations_db_create(ctx, {
				userId,
				description: "",
				name: "lazy-seed-ws",
				now: Date.now(),
			}),
		);
		if (organizationResult._nay) {
			throw new Error(organizationResult._nay.message);
		}
		expect(organizationResult._yay).toBeTruthy();

		const before = await t.run(async (ctx) =>
			(await ctx.db.query("quotas").collect()).filter(
				(doc) => doc.organizationId === organizationResult._yay!.organizationId && doc.quotaName === "extra_workspaces",
			),
		);
		expect(before).toHaveLength(1);
		expect(before[0]?.usedCount).toBe(0);

		for (const name of ["lazy-seeded-ws", "seeded-two", "seeded-three", "seeded-four", "seeded-five"]) {
			const created = await t.run((ctx) =>
				organizations_db_create_workspace(ctx, {
					userId,
					description: "",
					organizationId: organizationResult._yay!.organizationId,
					name,
					now: Date.now(),
				}),
			);
			if (created._nay) {
				throw new Error("Failed to seed organization quota doc test", {
					cause: created._nay,
				});
			}
			expect(created._yay?.name).toBe(name);
		}

		const blocked = await t.run((ctx) =>
			organizations_db_create_workspace(ctx, {
				userId,
				description: "",
				organizationId: organizationResult._yay!.organizationId,
				name: "seeded-six",
				now: Date.now(),
			}),
		);
		expect(blocked._nay?.message).toBe("Workspace quota reached");

		const after = await t.run(async (ctx) =>
			(await ctx.db.query("quotas").collect()).filter(
				(doc) => doc.organizationId === organizationResult._yay!.organizationId && doc.quotaName === "extra_workspaces",
			),
		);
		expect(after).toHaveLength(1);
		expect(after[0]?._id).toBe(before[0]?._id);
		expect(after[0]?.usedCount).toBe(5);
		expect(after[0]?.maxCount).toBe(5);
	});
});

describe("invite_user_to_organization_workspace with userIdToAdd", () => {
	test("rejects adding another user to the default organization", async () => {
		const t = test_convex();
		const [ownerId, memberId] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", { clerkUserId: "clerk-user-default-share-owner" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-default-share-member" }),
			]),
		);
		const owner = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: ownerId,
			name: "Owner",
			email: "organizations-test-user@test.local",
		});

		const created = await t.run((ctx) => organizations_test_seed_default_organization(ctx, { userId: ownerId }));
		expect(created._yay).toBeTruthy();

		const result = await owner.mutation(api.organizations.invite_user_to_organization_workspace, {
			organizationId: created._yay!.organizationId,
			workspaceId: created._yay!.defaultWorkspaceId,
			userIdToAdd: memberId,
		});

		expect(result._nay?.message).toBe("Cannot add user to default organization");
	});
});

describe("invite_user_to_organization_workspace", () => {
	test("rejects invites to the default organization", async () => {
		const t = test_convex();
		const [ownerId, invitedUserId] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", { clerkUserId: "clerk-user-default-invite-owner" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-default-invite-invitee" }),
			]),
		);
		await organizations_test_bootstrap_users(t, { userIds: [ownerId, invitedUserId] });
		await t.run(async (ctx) => {
			const now = Date.now();
			const anagraphicId = await ctx.db.insert("users_anagraphics", {
				userId: invitedUserId,
				displayName: "Default Invitee",
				email: "default-invitee@test.local",
				updatedAt: now,
			});
			await ctx.db.patch("users", invitedUserId, { anagraphic: anagraphicId });
		});
		const ownerUser = await t.run((ctx) => ctx.db.get("users", ownerId));
		if (!ownerUser?.defaultOrganizationId || !ownerUser.defaultWorkspaceId) {
			throw new Error("Expected owner default organization");
		}

		const owner = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: ownerId,
			name: "Owner",
			email: "default-invite-owner@test.local",
		});

		const result = await owner.mutation(api.organizations.invite_user_to_organization_workspace, {
			organizationId: ownerUser.defaultOrganizationId,
			workspaceId: ownerUser.defaultWorkspaceId,
			email: "default-invitee@test.local",
		});

		expect(result._nay?.message).toBe("Cannot add user to default organization");
	});

	test("adds home and selected workspace memberships, creates a notification, and supports removal", async () => {
		const t = test_convex();
		const [ownerId, invitedUserId] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", { clerkUserId: "clerk-user-invite-owner" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-invite-invitee" }),
			]),
		);
		await organizations_test_bootstrap_users(t, { userIds: [ownerId, invitedUserId] });
		await t.run(async (ctx) => {
			const now = Date.now();
			const anagraphicId = await ctx.db.insert("users_anagraphics", {
				userId: invitedUserId,
				displayName: "Invited User",
				email: "invited-user@test.local",
				updatedAt: now,
			});
			await ctx.db.patch("users", invitedUserId, { anagraphic: anagraphicId });
		});

		const owner = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: ownerId,
			name: "Owner",
			email: "invite-owner@test.local",
		});
		const created = await t.run((ctx) =>
			organizations_db_create(ctx, {
				userId: ownerId,
				description: "",
				name: "invite-team",
				now: Date.now(),
			}),
		);
		expect(created._yay).toBeTruthy();
		const selectedWorkspace = await t.run((ctx) =>
			organizations_db_create_workspace(ctx, {
				userId: ownerId,
				description: "",
				organizationId: created._yay!.organizationId,
				name: "roadmap",
				now: Date.now(),
			}),
		);
		expect(selectedWorkspace._yay).toBeTruthy();

		const inviteResult = await owner.mutation(api.organizations.invite_user_to_organization_workspace, {
			organizationId: created._yay!.organizationId,
			workspaceId: selectedWorkspace._yay!.workspaceId,
			email: "Invited-User@Test.Local",
		});
		expect(inviteResult._yay).toBeNull();

		const afterInvite = await t.run(async (ctx) => {
			const [memberships, notifications, roleAssignments] = await Promise.all([
				ctx.db
					.query("organizations_workspaces_users")
					.withIndex("by_active_user_organization_workspace", (q) =>
						q.eq("active", true).eq("userId", invitedUserId).eq("organizationId", created._yay!.organizationId),
					)
					.collect(),
				ctx.db
					.query("notifications")
					.withIndex("by_user_read", (q) => q.eq("userId", invitedUserId).eq("read", false))
					.collect(),
				ctx.db
					.query("access_control_role_assignments")
					.withIndex("by_organization_user_workspace_role", (q) =>
						q.eq("organizationId", created._yay!.organizationId).eq("userId", invitedUserId),
					)
					.collect(),
			]);

			return { memberships, notifications, roleAssignments };
		});

		expect(afterInvite.memberships.map((membership) => membership.workspaceId).sort()).toEqual(
			[created._yay!.defaultWorkspaceId, selectedWorkspace._yay!.workspaceId].sort(),
		);
		expect(afterInvite.roleAssignments.map((assignment) => assignment.workspaceId).sort()).toEqual(
			[created._yay!.defaultWorkspaceId, selectedWorkspace._yay!.workspaceId].sort(),
		);
		expect(afterInvite.notifications).toHaveLength(1);
		expect(afterInvite.notifications[0]?.read).toBe(false);
		expect(afterInvite.notifications[0]?.organizationId).toBe(created._yay!.organizationId);
		expect(afterInvite.notifications[0]?.workspaceId).toBe(selectedWorkspace._yay!.workspaceId);

		const homeWorkspaceUserIds = await owner.query(api.organizations.list_organization_workspace_users, {
			organizationId: created._yay!.organizationId,
			workspaceId: created._yay!.defaultWorkspaceId,
		});
		expect(homeWorkspaceUserIds?.toSorted()).toEqual([ownerId, invitedUserId].toSorted());

		const selectedWorkspaceUserIds = await owner.query(api.organizations.list_organization_workspace_users, {
			organizationId: created._yay!.organizationId,
			workspaceId: selectedWorkspace._yay!.workspaceId,
		});
		expect(selectedWorkspaceUserIds?.toSorted()).toEqual([ownerId, invitedUserId].toSorted());

		const removeResult = await owner.mutation(api.organizations.remove_user_from_organization, {
			organizationId: created._yay!.organizationId,
			userIdToRemove: invitedUserId,
		});
		expect(removeResult._yay).toBeNull();

		const afterRemove = await t.run(async (ctx) => {
			const [membershipsAfterRemove, roleAssignmentsAfterRemove, notificationsAfterRemove] = await Promise.all([
				ctx.db
					.query("organizations_workspaces_users")
					.withIndex("by_active_user_organization_workspace", (q) =>
						q.eq("active", true).eq("userId", invitedUserId).eq("organizationId", created._yay!.organizationId),
					)
					.collect(),
				ctx.db
					.query("access_control_role_assignments")
					.withIndex("by_organization_user_workspace_role", (q) =>
						q.eq("organizationId", created._yay!.organizationId).eq("userId", invitedUserId),
					)
					.collect(),
				ctx.db
					.query("notifications")
					.withIndex("by_organization_user_read", (q) =>
						q.eq("organizationId", created._yay!.organizationId).eq("userId", invitedUserId),
					)
					.collect(),
			]);
			return { membershipsAfterRemove, roleAssignmentsAfterRemove, notificationsAfterRemove };
		});
		expect(afterRemove.membershipsAfterRemove).toHaveLength(0);
		expect(afterRemove.roleAssignmentsAfterRemove).toHaveLength(0);
		expect(afterRemove.notificationsAfterRemove).toHaveLength(0);
	});

	test("allows an organization admin to invite users", async () => {
		const t = test_convex();
		const [ownerId, adminId, invitedUserId] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", { clerkUserId: "clerk-user-admin-invite-owner" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-admin-invite-admin" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-admin-invite-invitee" }),
			]),
		);
		await organizations_test_bootstrap_users(t, { userIds: [ownerId, adminId, invitedUserId] });

		const created = await t.run((ctx) =>
			organizations_db_create(ctx, {
				userId: ownerId,
				description: "",
				name: "admin-invite-team",
				now: Date.now(),
			}),
		);
		expect(created._yay).toBeTruthy();

		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert("organizations_workspaces_users", {
				organizationId: created._yay!.organizationId,
				workspaceId: created._yay!.defaultWorkspaceId,
				userId: adminId,
				active: true,
				updatedAt: now,
			});
			await access_control_db_ensure_role_assignment(ctx, {
				organizationId: created._yay!.organizationId,
				workspaceId: created._yay!.defaultWorkspaceId,
				userId: adminId,
				role: "admin",
				now,
			});
		});

		const admin = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: adminId,
			name: "Admin",
			email: "admin-invite-admin@test.local",
		});

		const result = await admin.mutation(api.organizations.invite_user_to_organization_workspace, {
			organizationId: created._yay!.organizationId,
			workspaceId: created._yay!.defaultWorkspaceId,
			userIdToAdd: invitedUserId,
		});
		expect(result._yay).toBeNull();

		const afterInvite = await t.run(async (ctx) => {
			const [membership, notification] = await Promise.all([
				ctx.db
					.query("organizations_workspaces_users")
					.withIndex("by_active_user_organization_workspace", (q) =>
						q
							.eq("active", true)
							.eq("userId", invitedUserId)
							.eq("organizationId", created._yay!.organizationId)
							.eq("workspaceId", created._yay!.defaultWorkspaceId),
					)
					.first(),
				ctx.db
					.query("notifications")
					.withIndex("by_organization_user_read", (q) =>
						q
							.eq("organizationId", created._yay!.organizationId)
							.eq("userId", invitedUserId)
							.eq("read", false),
					)
					.first(),
			]);

			return { membership, notification };
		});

		expect(afterInvite.membership).not.toBeNull();
		expect(afterInvite.notification?.actorUserId).toBe(adminId);
	});

	test("rejects invites from regular organization members", async () => {
		const t = test_convex();
		const [ownerId, memberId, invitedUserId] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", { clerkUserId: "clerk-user-member-invite-owner" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-member-invite-member" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-member-invite-invitee" }),
			]),
		);
		await organizations_test_bootstrap_users(t, { userIds: [ownerId, memberId, invitedUserId] });

		const created = await t.run((ctx) =>
			organizations_db_create(ctx, {
				userId: ownerId,
				description: "",
				name: "member-invite-team",
				now: Date.now(),
			}),
		);
		expect(created._yay).toBeTruthy();

		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert("organizations_workspaces_users", {
				organizationId: created._yay!.organizationId,
				workspaceId: created._yay!.defaultWorkspaceId,
				userId: memberId,
				active: true,
				updatedAt: now,
			});
			await access_control_db_ensure_role_assignment(ctx, {
				organizationId: created._yay!.organizationId,
				workspaceId: created._yay!.defaultWorkspaceId,
				userId: memberId,
				role: "member",
				now,
			});
		});

		const member = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: memberId,
			name: "Member",
			email: "member-invite-member@test.local",
		});

		const result = await member.mutation(api.organizations.invite_user_to_organization_workspace, {
			organizationId: created._yay!.organizationId,
			workspaceId: created._yay!.defaultWorkspaceId,
			userIdToAdd: invitedUserId,
		});
		expect(result._nay?.message).toBe("Permission denied");

		const afterInvite = await t.run(async (ctx) => {
			const [membership, notifications] = await Promise.all([
				ctx.db
					.query("organizations_workspaces_users")
					.withIndex("by_active_user_organization_workspace", (q) =>
						q.eq("active", true).eq("userId", invitedUserId).eq("organizationId", created._yay!.organizationId),
					)
					.collect(),
				organizations_test_collect_notifications_for_user(ctx, { userId: invitedUserId }),
			]);

			return { membership, notifications };
		});

		expect(afterInvite.membership).toHaveLength(0);
		expect(afterInvite.notifications).toHaveLength(0);
	});
});

describe("remove_user_from_organization", () => {
	test("rejects removing another user by a member", async () => {
		const t = test_convex();
		const [ownerId, memberId, otherMemberId] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", { clerkUserId: "clerk-user-remove-other-owner" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-remove-other-member" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-remove-other-target" }),
			]),
		);
		await organizations_test_bootstrap_users(t, { userIds: [ownerId, memberId, otherMemberId] });

		const member = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: memberId,
			name: "Member",
			email: "remove-other-member@test.local",
		});
		const created = await t.run((ctx) =>
			organizations_db_create(ctx, {
				userId: ownerId,
				description: "",
				name: "remove-other-team",
				now: Date.now(),
			}),
		);
		expect(created._yay).toBeTruthy();

		await t.run(async (ctx) => {
			const now = Date.now();
			await Promise.all(
				[memberId, otherMemberId].map(async (userId) => {
					await ctx.db.insert("organizations_workspaces_users", {
						organizationId: created._yay!.organizationId,
						workspaceId: created._yay!.defaultWorkspaceId,
						userId,
						active: true,
					});
					await access_control_db_ensure_role_assignment(ctx, {
						organizationId: created._yay!.organizationId,
						workspaceId: created._yay!.defaultWorkspaceId,
						userId,
						role: "member",
						now,
					});
				}),
			);
		});

		const result = await member.mutation(api.organizations.remove_user_from_organization, {
			organizationId: created._yay!.organizationId,
			userIdToRemove: otherMemberId,
		});
		expect(result._nay?.message).toBe("Permission denied");

		const otherMemberMemberships = await t.run((ctx) =>
			ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_active_user_organization_workspace", (q) =>
					q.eq("active", true).eq("userId", otherMemberId).eq("organizationId", created._yay!.organizationId),
				)
				.collect(),
		);
		expect(otherMemberMemberships).toHaveLength(1);
	});

	test("allows a member to leave the organization", async () => {
		const t = test_convex();
		const [ownerId, memberId] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", { clerkUserId: "clerk-user-leave-owner" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-leave-member" }),
			]),
		);
		await organizations_test_bootstrap_users(t, { userIds: [ownerId, memberId] });

		const member = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: memberId,
			name: "Member",
			email: "leave-member@test.local",
		});
		const created = await t.run((ctx) =>
			organizations_db_create(ctx, {
				userId: ownerId,
				description: "",
				name: "leave-team",
				now: Date.now(),
			}),
		);
		expect(created._yay).toBeTruthy();

		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert("organizations_workspaces_users", {
				organizationId: created._yay!.organizationId,
				workspaceId: created._yay!.defaultWorkspaceId,
				userId: memberId,
				active: true,
			});
			await access_control_db_ensure_role_assignment(ctx, {
				organizationId: created._yay!.organizationId,
				workspaceId: created._yay!.defaultWorkspaceId,
				userId: memberId,
				role: "member",
				now,
			});
		});

		const leaveResult = await member.mutation(api.organizations.remove_user_from_organization, {
			organizationId: created._yay!.organizationId,
			userIdToRemove: memberId,
		});
		expect(leaveResult._yay).toBeNull();

		const afterLeave = await t.run(async (ctx) => {
			const [memberships, roleAssignments] = await Promise.all([
				ctx.db
					.query("organizations_workspaces_users")
					.withIndex("by_active_user_organization_workspace", (q) =>
						q.eq("active", true).eq("userId", memberId).eq("organizationId", created._yay!.organizationId),
					)
					.collect(),
				ctx.db
					.query("access_control_role_assignments")
					.withIndex("by_organization_user_workspace_role", (q) =>
						q.eq("organizationId", created._yay!.organizationId).eq("userId", memberId),
					)
					.collect(),
			]);
			return { memberships, roleAssignments };
		});
		expect(afterLeave.memberships).toHaveLength(0);
		expect(afterLeave.roleAssignments).toHaveLength(0);
	});
});

describe("access_control.transfer_organization_ownership", () => {
	test("moves the owner role and updates extra-organization quota usage", async () => {
		const t = test_convex();
		const [ownerId, newOwnerId] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", { clerkUserId: "clerk-user-transfer-owner" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-transfer-new-owner" }),
			]),
		);
		await organizations_test_bootstrap_users(t, { userIds: [ownerId, newOwnerId] });

		const owner = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: ownerId,
			name: "Owner",
			email: "transfer-owner@test.local",
		});
		const created = await owner.mutation(api.organizations.create_organization, {
			description: "",
			name: "transfer-team",
		});
		expect(created._yay).toBeTruthy();

		await t.run(async (ctx) => {
			await ctx.db.insert("organizations_workspaces_users", {
				organizationId: created._yay!.organizationId,
				workspaceId: created._yay!.defaultWorkspaceId,
				userId: newOwnerId,
				active: true,
			});
		});

		const transferResult = await owner.mutation(api.access_control.transfer_organization_ownership, {
			organizationId: created._yay!.organizationId,
			newOwnerUserId: newOwnerId,
		});
		expect(transferResult._yay).toBeNull();

		const afterTransfer = await t.run(async (ctx) => {
			const [organization, ownerRoles, oldOwnerMemberRole, oldOwnerQuota, newOwnerQuota, oldOwnerHomeMembership] =
				await Promise.all([
					ctx.db.get("organizations", created._yay!.organizationId),
					ctx.db
						.query("access_control_role_assignments")
						.withIndex("by_organization_workspace_role_user", (q) =>
							q
								.eq("organizationId", created._yay!.organizationId)
								.eq("workspaceId", created._yay!.defaultWorkspaceId)
								.eq("role", "owner"),
						)
						.collect(),
					ctx.db
						.query("access_control_role_assignments")
						.withIndex("by_organization_workspace_user_role", (q) =>
							q
								.eq("organizationId", created._yay!.organizationId)
								.eq("workspaceId", created._yay!.defaultWorkspaceId)
								.eq("userId", ownerId)
								.eq("role", "member"),
						)
						.first(),
					organizations_test_read_user_extra_organization_quota_doc(ctx, { userId: ownerId }),
					organizations_test_read_user_extra_organization_quota_doc(ctx, { userId: newOwnerId }),
					ctx.db
						.query("organizations_workspaces_users")
						.withIndex("by_active_user_organization_workspace", (q) =>
							q
								.eq("active", true)
								.eq("userId", ownerId)
								.eq("organizationId", created._yay!.organizationId)
								.eq("workspaceId", created._yay!.defaultWorkspaceId),
						)
						.first(),
				]);

			return { organization, ownerRoles, oldOwnerMemberRole, oldOwnerQuota, newOwnerQuota, oldOwnerHomeMembership };
		});

		expect(afterTransfer.organization?.ownerUserId).toBe(newOwnerId);
		expect(afterTransfer.ownerRoles).toHaveLength(1);
		expect(afterTransfer.ownerRoles[0]?.userId).toBe(newOwnerId);
		expect(afterTransfer.oldOwnerMemberRole?.userId).toBe(ownerId);
		expect(afterTransfer.oldOwnerQuota?.usedCount).toBe(0);
		expect(afterTransfer.newOwnerQuota?.usedCount).toBe(1);
		expect(afterTransfer.oldOwnerHomeMembership).not.toBeNull();
	});
});

describe("access_control", () => {
	test("does not grant member-management permissions to regular members", async () => {
		const t = test_convex();
		const [ownerId, adminId, memberId] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", { clerkUserId: "clerk-user-member-management-owner" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-member-management-admin" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-member-management-member" }),
			]),
		);
		await organizations_test_bootstrap_users(t, { userIds: [ownerId, adminId, memberId] });

		const created = await t.run((ctx) =>
			organizations_db_create(ctx, {
				userId: ownerId,
				name: "member-mgmt-access",
				description: "",
				now: Date.now(),
			}),
		);
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		const workspace = await t.run((ctx) =>
			organizations_db_create_workspace(ctx, {
				userId: ownerId,
				organizationId: created._yay!.organizationId,
				name: "ws-access",
				description: "",
				now: Date.now(),
			}),
		);
		if (workspace._nay) {
			throw new Error(workspace._nay.message);
		}

		const result = await t.run(async (ctx) => {
			const now = Date.now();
			for (const workspaceId of [created._yay!.defaultWorkspaceId, workspace._yay!.workspaceId]) {
				await access_control_db_ensure_role_assignment(ctx, {
					organizationId: created._yay!.organizationId,
					workspaceId,
					userId: adminId,
					role: "admin",
					now,
				});
				await access_control_db_ensure_role_assignment(ctx, {
					organizationId: created._yay!.organizationId,
					workspaceId,
					userId: memberId,
					role: "member",
					now,
				});
			}

			const memberOrganizationAccess = await access_control_db_has_permission(ctx, {
				organizationId: created._yay!.organizationId,
				workspaceId: created._yay!.defaultWorkspaceId,
				defaultWorkspaceId: created._yay!.defaultWorkspaceId,
				organizationOwnerUserId: ownerId,
				resourceKind: "organization",
				resourceId: created._yay!.organizationId,
				permission: "organization.members.manage",
				userId: memberId,
			});
			const adminOrganizationAccess = await access_control_db_has_permission(ctx, {
				organizationId: created._yay!.organizationId,
				workspaceId: created._yay!.defaultWorkspaceId,
				defaultWorkspaceId: created._yay!.defaultWorkspaceId,
				organizationOwnerUserId: ownerId,
				resourceKind: "organization",
				resourceId: created._yay!.organizationId,
				permission: "organization.members.manage",
				userId: adminId,
			});
			const memberWorkspaceAccess = await access_control_db_has_permission(ctx, {
				organizationId: created._yay!.organizationId,
				workspaceId: workspace._yay!.workspaceId,
				defaultWorkspaceId: created._yay!.defaultWorkspaceId,
				organizationOwnerUserId: ownerId,
				resourceKind: "workspace",
				resourceId: workspace._yay!.workspaceId,
				permission: "workspace.members.manage",
				userId: memberId,
			});
			const adminWorkspaceAccess = await access_control_db_has_permission(ctx, {
				organizationId: created._yay!.organizationId,
				workspaceId: workspace._yay!.workspaceId,
				defaultWorkspaceId: created._yay!.defaultWorkspaceId,
				organizationOwnerUserId: ownerId,
				resourceKind: "workspace",
				resourceId: workspace._yay!.workspaceId,
				permission: "workspace.members.manage",
				userId: adminId,
			});
			const memberApiCredentialAccess = await access_control_db_has_permission(ctx, {
				organizationId: created._yay!.organizationId,
				workspaceId: workspace._yay!.workspaceId,
				defaultWorkspaceId: created._yay!.defaultWorkspaceId,
				organizationOwnerUserId: ownerId,
				resourceKind: "workspace",
				resourceId: workspace._yay!.workspaceId,
				permission: "api.credentials.manage",
				userId: memberId,
			});
			const adminApiCredentialAccess = await access_control_db_has_permission(ctx, {
				organizationId: created._yay!.organizationId,
				workspaceId: workspace._yay!.workspaceId,
				defaultWorkspaceId: created._yay!.defaultWorkspaceId,
				organizationOwnerUserId: ownerId,
				resourceKind: "workspace",
				resourceId: workspace._yay!.workspaceId,
				permission: "api.credentials.manage",
				userId: adminId,
			});

			return {
				memberOrganizationAccess,
				adminOrganizationAccess,
				memberWorkspaceAccess,
				adminWorkspaceAccess,
				memberApiCredentialAccess,
				adminApiCredentialAccess,
			};
		});

		expect(result.memberOrganizationAccess).toBe(false);
		expect(result.adminOrganizationAccess).toBe(true);
		expect(result.memberWorkspaceAccess).toBe(false);
		expect(result.adminWorkspaceAccess).toBe(true);
		expect(result.memberApiCredentialAccess).toBe(false);
		expect(result.adminApiCredentialAccess).toBe(true);
	});

	test("returns current organization permission for owners and admins but not regular members", async () => {
		const t = test_convex();
		const [ownerId, adminId, memberId] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", { clerkUserId: "clerk-user-current-permission-owner" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-current-permission-admin" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-current-permission-member" }),
			]),
		);
		await organizations_test_bootstrap_users(t, { userIds: [ownerId, adminId, memberId] });

		const created = await t.run((ctx) =>
			organizations_db_create(ctx, {
				userId: ownerId,
				name: "current-permission",
				description: "",
				now: Date.now(),
			}),
		);
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		await t.run(async (ctx) => {
			const now = Date.now();
			for (const [userId, role] of [
				[adminId, "admin"],
				[memberId, "member"],
			] as const) {
				await ctx.db.insert("organizations_workspaces_users", {
					organizationId: created._yay!.organizationId,
					workspaceId: created._yay!.defaultWorkspaceId,
					userId,
					active: true,
					updatedAt: now,
				});
				await access_control_db_ensure_role_assignment(ctx, {
					organizationId: created._yay!.organizationId,
					workspaceId: created._yay!.defaultWorkspaceId,
					userId,
					role,
					now,
				});
			}
		});

		const owner = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: ownerId,
			name: "Owner",
			email: "current-permission-owner@test.local",
		});
		const admin = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: adminId,
			name: "Admin",
			email: "current-permission-admin@test.local",
		});
		const member = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: memberId,
			name: "Member",
			email: "current-permission-member@test.local",
		});

		const [ownerPermission, adminPermission, memberPermission] = await Promise.all([
			owner.query(api.access_control.get_current_user_organization_permission, {
				organizationId: created._yay.organizationId,
				permission: "organization.members.manage",
			}),
			admin.query(api.access_control.get_current_user_organization_permission, {
				organizationId: created._yay.organizationId,
				permission: "organization.members.manage",
			}),
			member.query(api.access_control.get_current_user_organization_permission, {
				organizationId: created._yay.organizationId,
				permission: "organization.members.manage",
			}),
		]);

		expect(ownerPermission).toBe(true);
		expect(adminPermission).toBe(true);
		expect(memberPermission).toBe(false);
	});

	test("returns the current user's exact role for one organization/workspace scope", async () => {
		const t = test_convex();
		const [ownerId, scopedUserId] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", { clerkUserId: "clerk-user-access-role-owner" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-access-role-scoped" }),
			]),
		);
		await organizations_test_bootstrap_users(t, { userIds: [ownerId, scopedUserId] });

		const created = await t.run((ctx) =>
			organizations_db_create(ctx, {
				userId: ownerId,
				name: "access-role",
				description: "",
				now: Date.now(),
			}),
		);
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		const organization = created._yay;

		const [workspaceAId, workspaceBId] = await t.run(async (ctx) => {
			const now = Date.now();
			const [workspaceAId, workspaceBId] = await Promise.all([
				ctx.db.insert("organizations_workspaces", {
					organizationId: organization.organizationId,
					name: "role-a",
					description: "",
					default: false,
					updatedAt: now,
				}),
				ctx.db.insert("organizations_workspaces", {
					organizationId: organization.organizationId,
					name: "role-b",
					description: "",
					default: false,
					updatedAt: now,
				}),
			]);

			await access_control_db_ensure_role_assignment(ctx, {
				organizationId: organization.organizationId,
				workspaceId: workspaceAId,
				userId: scopedUserId,
				role: "member",
				now,
			});

			return [workspaceAId, workspaceBId] as const;
		});

		const owner = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: ownerId,
			name: "Owner",
			email: "organizations-test-user@test.local",
		});
		const scopedUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: scopedUserId,
			name: "Scoped User",
			email: "organizations-test-user@test.local",
		});

		const ownerRole = await owner.query(api.access_control.get_current_user_role, {
			organizationId: organization.organizationId,
			workspaceId: organization.defaultWorkspaceId,
		});
		const localWorkspaceRole = await scopedUser.query(api.access_control.get_current_user_role, {
			organizationId: organization.organizationId,
			workspaceId: workspaceAId,
		});
		const siblingWorkspaceRoleBeforeDefaultRole = await scopedUser.query(api.access_control.get_current_user_role, {
			organizationId: organization.organizationId,
			workspaceId: workspaceBId,
		});

		await t.run((ctx) =>
			access_control_db_ensure_role_assignment(ctx, {
				organizationId: organization.organizationId,
				workspaceId: organization.defaultWorkspaceId,
				userId: scopedUserId,
				role: "admin",
				now: Date.now(),
			}),
		);

		const localWorkspaceRoleAfterDefaultRole = await scopedUser.query(api.access_control.get_current_user_role, {
			organizationId: organization.organizationId,
			workspaceId: workspaceAId,
		});
		const siblingWorkspaceRoleAfterDefaultRole = await scopedUser.query(api.access_control.get_current_user_role, {
			organizationId: organization.organizationId,
			workspaceId: workspaceBId,
		});
		const defaultWorkspaceRoleAfterDefaultRole = await scopedUser.query(api.access_control.get_current_user_role, {
			organizationId: organization.organizationId,
			workspaceId: organization.defaultWorkspaceId,
		});

		expect(ownerRole).toBe("owner");
		expect(localWorkspaceRole).toBe("member");
		expect(siblingWorkspaceRoleBeforeDefaultRole).toBeNull();
		expect(localWorkspaceRoleAfterDefaultRole).toBe("member");
		expect(siblingWorkspaceRoleAfterDefaultRole).toBeNull();
		expect(defaultWorkspaceRoleAfterDefaultRole).toBe("admin");
	});

	test("keeps extra-ws role assignments local and default-ws assignments organization-wide", async () => {
		const t = test_convex();
		const [ownerId, scopedUserId] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", { clerkUserId: "clerk-user-access-owner" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-access-scoped" }),
			]),
		);
		await organizations_test_bootstrap_users(t, { userIds: [ownerId, scopedUserId] });

		const created = await t.run((ctx) =>
			organizations_db_create(ctx, {
				userId: ownerId,
				name: "access-scope",
				description: "",
				now: Date.now(),
			}),
		);
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		const organization = created._yay;

		const result = await t.run(async (ctx) => {
			const now = Date.now();
			const [workspaceAId, workspaceBId] = await Promise.all([
				ctx.db.insert("organizations_workspaces", {
					organizationId: organization.organizationId,
					name: "access-a",
					description: "",
					default: false,
					updatedAt: now,
				}),
				ctx.db.insert("organizations_workspaces", {
					organizationId: organization.organizationId,
					name: "access-b",
					description: "",
					default: false,
					updatedAt: now,
				}),
			]);

			for (const workspaceId of [workspaceAId, workspaceBId]) {
				await access_control_db_ensure_role_permission_grant(ctx, {
					organizationId: organization.organizationId,
					workspaceId,
					resourceKind: "workspace",
					resourceId: workspaceId,
					role: "member",
					permission: "workspace.update",
					now,
				});
			}

			await access_control_db_ensure_role_assignment(ctx, {
				organizationId: organization.organizationId,
				workspaceId: workspaceAId,
				userId: scopedUserId,
				role: "member",
				now,
			});

			const workspaceALocalAccess = await access_control_db_has_permission(ctx, {
				organizationId: organization.organizationId,
				workspaceId: workspaceAId,
				defaultWorkspaceId: organization.defaultWorkspaceId,
				organizationOwnerUserId: ownerId,
				resourceKind: "workspace",
				resourceId: workspaceAId,
				permission: "workspace.update",
				userId: scopedUserId,
			});
			const workspaceBAccessBeforeOrganizationRole = await access_control_db_has_permission(ctx, {
				organizationId: organization.organizationId,
				workspaceId: workspaceBId,
				defaultWorkspaceId: organization.defaultWorkspaceId,
				organizationOwnerUserId: ownerId,
				resourceKind: "workspace",
				resourceId: workspaceBId,
				permission: "workspace.update",
				userId: scopedUserId,
			});

			await access_control_db_ensure_role_assignment(ctx, {
				organizationId: organization.organizationId,
				workspaceId: organization.defaultWorkspaceId,
				userId: scopedUserId,
				role: "member",
				now,
			});

			const workspaceBAccessAfterOrganizationRole = await access_control_db_has_permission(ctx, {
				organizationId: organization.organizationId,
				workspaceId: workspaceBId,
				defaultWorkspaceId: organization.defaultWorkspaceId,
				organizationOwnerUserId: ownerId,
				resourceKind: "workspace",
				resourceId: workspaceBId,
				permission: "workspace.update",
				userId: scopedUserId,
			});

			return {
				workspaceALocalAccess,
				workspaceBAccessBeforeOrganizationRole,
				workspaceBAccessAfterOrganizationRole,
			};
		});

		expect(result.workspaceALocalAccess).toBe(true);
		expect(result.workspaceBAccessBeforeOrganizationRole).toBe(false);
		expect(result.workspaceBAccessAfterOrganizationRole).toBe(true);
	});

	test("allows direct user grants and keeps public grants resource-and-permission specific", async () => {
		const t = test_convex();
		const [ownerId, grantedUserId, otherUserId] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", { clerkUserId: "clerk-user-access-grant-owner" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-access-granted" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-access-other" }),
			]),
		);
		await organizations_test_bootstrap_users(t, { userIds: [ownerId, grantedUserId, otherUserId] });

		const created = await t.run((ctx) =>
			organizations_db_create(ctx, {
				userId: ownerId,
				name: "access-grants",
				description: "",
				now: Date.now(),
			}),
		);
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		const organization = created._yay;

		const result = await t.run(async (ctx) => {
			const now = Date.now();
			const [nodeId, otherNodeId] = await Promise.all([
				ctx.db.insert("files_nodes", {
					organizationId: organization.organizationId,
					workspaceId: organization.defaultWorkspaceId,
					path: "/access-user-grant",
					treePath: "/access-user-grant",
					pathDepth: 1,
					name: "access-user-grant",
					kind: "file",
					lowercaseExtension: null,
					parentId: "root",
					createdBy: ownerId,
					updatedBy: ownerId,
					updatedAt: now,
				}),
				ctx.db.insert("files_nodes", {
					organizationId: organization.organizationId,
					workspaceId: organization.defaultWorkspaceId,
					path: "/access-public-other",
					treePath: "/access-public-other",
					pathDepth: 1,
					name: "access-public-other",
					kind: "file",
					lowercaseExtension: null,
					parentId: "root",
					createdBy: ownerId,
					updatedBy: ownerId,
					updatedAt: now,
				}),
			]);

			await Promise.all([
				access_control_db_ensure_user_permission_grant(ctx, {
					organizationId: organization.organizationId,
					workspaceId: organization.defaultWorkspaceId,
					resourceKind: "file",
					resourceId: nodeId,
					userId: grantedUserId,
					permission: "asset.write",
					now,
				}),
				access_control_db_ensure_public_permission_grant(ctx, {
					organizationId: organization.organizationId,
					workspaceId: organization.defaultWorkspaceId,
					resourceKind: "file",
					resourceId: nodeId,
					permission: "asset.read",
					now,
				}),
			]);

			const directUserAccess = await access_control_db_has_permission(ctx, {
				organizationId: organization.organizationId,
				workspaceId: organization.defaultWorkspaceId,
				defaultWorkspaceId: organization.defaultWorkspaceId,
				organizationOwnerUserId: ownerId,
				resourceKind: "file",
				resourceId: nodeId,
				permission: "asset.write",
				userId: grantedUserId,
			});
			const otherUserAccess = await access_control_db_has_permission(ctx, {
				organizationId: organization.organizationId,
				workspaceId: organization.defaultWorkspaceId,
				defaultWorkspaceId: organization.defaultWorkspaceId,
				organizationOwnerUserId: ownerId,
				resourceKind: "file",
				resourceId: nodeId,
				permission: "asset.write",
				userId: otherUserId,
			});
			const publicReadAccess = await access_control_db_has_permission(ctx, {
				organizationId: organization.organizationId,
				workspaceId: organization.defaultWorkspaceId,
				defaultWorkspaceId: organization.defaultWorkspaceId,
				organizationOwnerUserId: ownerId,
				resourceKind: "file",
				resourceId: nodeId,
				permission: "asset.read",
				allowPublic: true,
			});
			const publicWriteAccess = await access_control_db_has_permission(ctx, {
				organizationId: organization.organizationId,
				workspaceId: organization.defaultWorkspaceId,
				defaultWorkspaceId: organization.defaultWorkspaceId,
				organizationOwnerUserId: ownerId,
				resourceKind: "file",
				resourceId: nodeId,
				permission: "asset.write",
				allowPublic: true,
			});
			const otherPagePublicAccess = await access_control_db_has_permission(ctx, {
				organizationId: organization.organizationId,
				workspaceId: organization.defaultWorkspaceId,
				defaultWorkspaceId: organization.defaultWorkspaceId,
				organizationOwnerUserId: ownerId,
				resourceKind: "file",
				resourceId: otherNodeId,
				permission: "asset.read",
				allowPublic: true,
			});
			const publicAccessWithoutPublicFlag = await access_control_db_has_permission(ctx, {
				organizationId: organization.organizationId,
				workspaceId: organization.defaultWorkspaceId,
				defaultWorkspaceId: organization.defaultWorkspaceId,
				organizationOwnerUserId: ownerId,
				resourceKind: "file",
				resourceId: nodeId,
				permission: "asset.read",
			});

			return {
				directUserAccess,
				otherUserAccess,
				publicReadAccess,
				publicWriteAccess,
				otherPagePublicAccess,
				publicAccessWithoutPublicFlag,
			};
		});

		expect(result.directUserAccess).toBe(true);
		expect(result.otherUserAccess).toBe(false);
		expect(result.publicReadAccess).toBe(true);
		expect(result.publicWriteAccess).toBe(false);
		expect(result.otherPagePublicAccess).toBe(false);
		expect(result.publicAccessWithoutPublicFlag).toBe(false);
	});
});

describe("edit_organization", () => {
	test("rejects renaming the default organization", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-rename-default-ws",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "organizations-test-user@test.local",
		});

		const created = await t.run((ctx) => organizations_test_seed_default_organization(ctx, { userId }));
		expect(created._yay).toBeTruthy();

		const result = await asUser.mutation(api.organizations.edit_organization, {
			organizationId: created._yay!.organizationId,
			defaultWorkspaceId: created._yay!.defaultWorkspaceId,
			name: "renamed-personal",
			description: "",
		});

		expect(result._nay?.message).toBe("Cannot edit the default organization");
	});

	test("allows renaming a non-default organization", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-rename-nond-ws",
			}),
		);
		await organizations_test_bootstrap_user(t, { userId });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "organizations-test-user@test.local",
		});

		const created = await t.run(async (ctx) =>
			organizations_db_create(ctx, {
				userId,
				name: "extra-ws-rename",
				description: "",
				now: Date.now(),
				default: false,
			}),
		);
		expect(created._yay).toBeTruthy();

		const result = await asUser.mutation(api.organizations.edit_organization, {
			organizationId: created._yay!.organizationId,
			defaultWorkspaceId: created._yay!.defaultWorkspaceId,
			name: "extra-renamed",
			description: "",
		});

		expect(result._yay?.name).toBe("extra-renamed");
	});

	test("leaves description unchanged when renaming organization", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-rename-keeps-desc",
			}),
		);
		await organizations_test_bootstrap_user(t, { userId });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "organizations-test-user@test.local",
		});

		const created = await asUser.mutation(api.organizations.create_organization, {
			description: "Product org",
			name: "rename-keep-desc-ws",
		});
		expect(created._yay).toBeTruthy();

		const wsId = created._yay!.organizationId;
		const before = await t.run((ctx) => ctx.db.get("organizations", wsId));
		expect(before?.description).toBe("Product org");

		const renamed = await asUser.mutation(api.organizations.edit_organization, {
			organizationId: wsId,
			defaultWorkspaceId: created._yay!.defaultWorkspaceId,
			name: "rename-keep-desc-2",
			description: "Product org",
		});
		expect(renamed._yay?.name).toBe("rename-keep-desc-2");

		const after = await t.run((ctx) => ctx.db.get("organizations", wsId));
		expect(after?.description).toBe("Product org");
	});

	test("updates organization description when editing organization", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-edit-organization-desc",
			}),
		);
		await organizations_test_bootstrap_user(t, { userId });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "organizations-test-user@test.local",
		});

		const created = await asUser.mutation(api.organizations.create_organization, {
			description: "Planning",
			name: "edit-organization",
		});
		expect(created._yay).toBeTruthy();

		const edited = await asUser.mutation(api.organizations.edit_organization, {
			organizationId: created._yay!.organizationId,
			defaultWorkspaceId: created._yay!.defaultWorkspaceId,
			name: "edit-org-next",
			description: "Planning and delivery",
		});
		expect(edited._yay?.name).toBe("edit-org-next");

		const after = await t.run((ctx) => ctx.db.get("organizations", created._yay!.organizationId));
		expect(after?.description).toBe("Planning and delivery");
	});

	test("rejects organization edit when description is longer than max length", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-edit-organization-desc-long",
			}),
		);
		await organizations_test_bootstrap_user(t, { userId });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "organizations-test-user@test.local",
		});

		const created = await asUser.mutation(api.organizations.create_organization, {
			description: "",
			name: "edit-ws-desc-long",
		});
		expect(created._yay).toBeTruthy();

		const result = await asUser.mutation(api.organizations.edit_organization, {
			organizationId: created._yay!.organizationId,
			defaultWorkspaceId: created._yay!.defaultWorkspaceId,
			name: "edit-ws-desc-next",
			description: "x".repeat(organizations_DESCRIPTION_MAX_LENGTH + 1),
		});
		expect(result._nay?.message).toBe("Description is too long");
	});

	test("rejects organization edit when name is longer than max length", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-edit-organization-name-long",
			}),
		);
		await organizations_test_bootstrap_user(t, { userId });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "organizations-test-user@test.local",
		});

		const created = await asUser.mutation(api.organizations.create_organization, {
			description: "",
			name: "edit-ws-name-long",
		});
		expect(created._yay).toBeTruthy();

		const result = await asUser.mutation(api.organizations.edit_organization, {
			organizationId: created._yay!.organizationId,
			defaultWorkspaceId: created._yay!.defaultWorkspaceId,
			name: "a".repeat(organizations_NAME_MAX_LENGTH + 1),
			description: "",
		});
		expect(result._nay?.message).toBe("Name must be at most 20 characters");
	});

	test("returns Not found when defaultWorkspaceId is not the organization primary", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-rename-ws-wrong-default-ws",
			}),
		);
		await organizations_test_bootstrap_user(t, { userId });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "organizations-test-user@test.local",
		});

		const created = await t.run(async (ctx) =>
			organizations_db_create(ctx, {
				userId,
				name: "ws-wrong-default-arg",
				description: "",
				now: Date.now(),
				default: false,
			}),
		);
		expect(created._yay).toBeTruthy();

		const extra = await asUser.mutation(api.organizations.create_workspace, {
			description: "",
			organizationId: created._yay!.organizationId,
			name: "side-ws",
		});
		expect(extra._yay).toBeTruthy();

		const result = await asUser.mutation(api.organizations.edit_organization, {
			organizationId: created._yay!.organizationId,
			defaultWorkspaceId: extra._yay!.workspaceId,
			name: "renamed-ws",
			description: "",
		});

		expect(result._nay?.message).toBe("Not found");
	});

	test("returns Not found when the user has no membership on the organization", async () => {
		const t = test_convex();
		const userIds = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", { clerkUserId: "clerk-rename-ws-owner" }),
				ctx.db.insert("users", { clerkUserId: "clerk-rename-ws-stranger" }),
			]),
		);
		await organizations_test_bootstrap_user(t, { userId: userIds[0] });

		const created = await t.run(async (ctx) =>
			organizations_db_create(ctx, {
				userId: userIds[0],
				name: "private-rename-ws",
				description: "",
				now: Date.now(),
				default: false,
			}),
		);
		expect(created._yay).toBeTruthy();

		const stranger = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userIds[1],
			name: "Stranger",
			email: "organizations-test-user@test.local",
		});

		const result = await stranger.mutation(api.organizations.edit_organization, {
			organizationId: created._yay!.organizationId,
			defaultWorkspaceId: created._yay!.defaultWorkspaceId,
			name: "hijacked",
			description: "",
		});

		expect(result._nay?.message).toBe("Not found");
	});
});

describe("edit_workspace", () => {
	test("rejects renaming the primary workspace when workspace.default is true", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-rename-primary-ws",
			}),
		);
		await organizations_test_bootstrap_user(t, { userId });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "organizations-test-user@test.local",
		});

		const wsResult = await t.run((ctx) =>
			organizations_db_create(ctx, {
				userId,
				description: "",
				name: "rename-ws-ws",
				now: Date.now(),
			}),
		);
		if (wsResult._nay) {
			throw new Error(wsResult._nay.message);
		}
		expect(wsResult._yay).toBeTruthy();

		const result = await asUser.mutation(api.organizations.edit_workspace, {
			organizationId: wsResult._yay!.organizationId,
			defaultWorkspaceId: wsResult._yay!.defaultWorkspaceId,
			workspaceId: wsResult._yay!.defaultWorkspaceId,
			name: "new-home",
			description: "",
		});

		expect(result._nay?.message).toBe("Cannot edit the default workspace");
	});

	test("rejects renaming the primary workspace when only defaultWorkspaceId matches", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-rename-primary-ws-id",
			}),
		);
		await organizations_test_bootstrap_user(t, { userId });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "organizations-test-user@test.local",
		});

		const wsResult = await t.run((ctx) =>
			organizations_db_create(ctx, {
				userId,
				description: "",
				name: "rename-ws-ws-id",
				now: Date.now(),
			}),
		);
		if (wsResult._nay) {
			throw new Error(wsResult._nay.message);
		}
		expect(wsResult._yay).toBeTruthy();
		const organizationId = wsResult._yay!.organizationId;
		const homeId = wsResult._yay!.defaultWorkspaceId;

		const extra = await t.run((ctx) =>
			organizations_db_create_workspace(ctx, {
				userId,
				description: "",
				organizationId,
				name: "zebra-docs",
				now: Date.now(),
			}),
		);
		if (extra._nay) {
			throw new Error(extra._nay.message);
		}
		expect(extra._yay).toBeTruthy();
		const zebraId = extra._yay!.workspaceId;

		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.patch("organizations_workspaces", homeId, { default: false });
			await ctx.db.patch("organizations", organizationId, { defaultWorkspaceId: zebraId });
			await access_control_db_ensure_role_assignment(ctx, {
				organizationId,
				workspaceId: zebraId,
				userId,
				role: "owner",
				now,
			});
		});

		const blocked = await asUser.mutation(api.organizations.edit_workspace, {
			organizationId,
			defaultWorkspaceId: zebraId,
			workspaceId: zebraId,
			name: "blocked-zebra",
			description: "",
		});
		expect(blocked._nay?.message).toBe("Cannot edit the default workspace");

		const ok = await asUser.mutation(api.organizations.edit_workspace, {
			organizationId,
			defaultWorkspaceId: zebraId,
			workspaceId: homeId,
			name: "former-home",
			description: "",
		});
		expect(ok._yay?.name).toBe("former-home");
	});

	test("allows renaming a non-primary workspace", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-rename-secondary-ws",
			}),
		);
		await organizations_test_bootstrap_user(t, { userId });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "organizations-test-user@test.local",
		});

		const wsResult = await t.run((ctx) =>
			organizations_db_create(ctx, {
				userId,
				description: "",
				name: "rename-secondary-ws",
				now: Date.now(),
			}),
		);
		if (wsResult._nay) {
			throw new Error(wsResult._nay.message);
		}
		expect(wsResult._yay).toBeTruthy();

		const extra = await t.run((ctx) =>
			organizations_db_create_workspace(ctx, {
				userId,
				description: "",
				organizationId: wsResult._yay!.organizationId,
				name: "sidecar",
				now: Date.now(),
			}),
		);
		if (extra._nay) {
			throw new Error(extra._nay.message);
		}
		expect(extra._yay).toBeTruthy();

		const result = await asUser.mutation(api.organizations.edit_workspace, {
			organizationId: wsResult._yay!.organizationId,
			defaultWorkspaceId: wsResult._yay!.defaultWorkspaceId,
			workspaceId: extra._yay!.workspaceId,
			name: "sidecar-renamed",
			description: "",
		});

		expect(result._yay?.name).toBe("sidecar-renamed");
	});

	test("leaves description unchanged when renaming workspace", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-rename-ws-keeps-desc",
			}),
		);
		await organizations_test_bootstrap_user(t, { userId });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "organizations-test-user@test.local",
		});

		const wsResult = await t.run((ctx) =>
			organizations_db_create(ctx, {
				userId,
				description: "",
				name: "rename-ws-desc",
				now: Date.now(),
			}),
		);
		if (wsResult._nay) {
			throw new Error(wsResult._nay.message);
		}
		expect(wsResult._yay).toBeTruthy();

		const extra = await t.run((ctx) =>
			organizations_db_create_workspace(ctx, {
				userId,
				description: "Scratch space",
				organizationId: wsResult._yay!.organizationId,
				name: "side-note",
				now: Date.now(),
			}),
		);
		if (extra._nay) {
			throw new Error(extra._nay.message);
		}
		expect(extra._yay).toBeTruthy();

		const workspaceId = extra._yay!.workspaceId;
		const before = await t.run((ctx) => ctx.db.get("organizations_workspaces", workspaceId));
		expect(before?.description).toBe("Scratch space");

		const renamed = await asUser.mutation(api.organizations.edit_workspace, {
			organizationId: wsResult._yay!.organizationId,
			defaultWorkspaceId: wsResult._yay!.defaultWorkspaceId,
			workspaceId,
			name: "side-note-v2",
			description: "Scratch space",
		});
		expect(renamed._yay?.name).toBe("side-note-v2");

		const after = await t.run((ctx) => ctx.db.get("organizations_workspaces", workspaceId));
		expect(after?.description).toBe("Scratch space");
	});

	test("updates workspace description when editing workspace", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-edit-ws-desc",
			}),
		);
		await organizations_test_bootstrap_user(t, { userId });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "organizations-test-user@test.local",
		});

		const wsResult = await t.run((ctx) =>
			organizations_db_create(ctx, {
				userId,
				description: "",
				name: "edit-ws-desc-ws",
				now: Date.now(),
			}),
		);
		if (wsResult._nay) {
			throw new Error(wsResult._nay.message);
		}
		expect(wsResult._yay).toBeTruthy();

		const extra = await t.run((ctx) =>
			organizations_db_create_workspace(ctx, {
				userId,
				description: "Scratch space",
				organizationId: wsResult._yay!.organizationId,
				name: "edit-ws-desc",
				now: Date.now(),
			}),
		);
		if (extra._nay) {
			throw new Error(extra._nay.message);
		}
		expect(extra._yay).toBeTruthy();

		const edited = await asUser.mutation(api.organizations.edit_workspace, {
			organizationId: wsResult._yay!.organizationId,
			defaultWorkspaceId: wsResult._yay!.defaultWorkspaceId,
			workspaceId: extra._yay!.workspaceId,
			name: "edit-ws-next",
			description: "Docs and notes",
		});
		expect(edited._yay?.name).toBe("edit-ws-next");

		const after = await t.run((ctx) => ctx.db.get("organizations_workspaces", extra._yay!.workspaceId));
		expect(after?.description).toBe("Docs and notes");
	});
});

describe("delete_workspace", () => {
	test("queues tenant-scoped purge work and keeps the user's personal/home default", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-delete-ws",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "organizations-test-user@test.local",
		});
		await organizations_test_bootstrap_user(t, { userId });

		const personalDefaultIds = await t.run(async (ctx) => {
			const user = await ctx.db.get("users", userId);
			if (!user?.defaultOrganizationId || !user.defaultWorkspaceId) {
				throw new Error("Expected default organization pointers after bootstrap");
			}

			return {
				organizationId: user.defaultOrganizationId,
				defaultWorkspaceId: user.defaultWorkspaceId,
			};
		});

		const created = await t.run(async (ctx) =>
			organizations_db_create(ctx, {
				userId,
				name: "delete-ws-ws",
				description: "",
				now: Date.now(),
				default: false,
			}),
		);
		expect(created._yay).toBeTruthy();

		const extraWorkspace = await asUser.mutation(api.organizations.create_workspace, {
			description: "",
			organizationId: created._yay!.organizationId,
			name: "scratch",
		});
		expect(extraWorkspace._yay).toBeTruthy();

		await t.run(async (ctx) => {
			await ctx.db.insert("notifications", {
				userId,
				kind: "organization_workspace_invite",
				read: false,
				actorUserId: userId,
				organizationId: created._yay!.organizationId,
				workspaceId: extraWorkspace._yay!.workspaceId,
				updatedAt: Date.now(),
			});
			await organizations_test_seed_workspace_scoped_rows(ctx, {
				userId,
				organizationId: created._yay!.organizationId,
				workspaceId: extraWorkspace._yay!.workspaceId,
				tag: "delete-ws",
			});
		});

		const result = await asUser.mutation(api.organizations.delete_workspace, {
			workspaceId: extraWorkspace._yay!.workspaceId,
		});
		expect(result._yay).toBeNull();

		const after_delete = await t.run(async (ctx) => {
			const [
				workspace,
				requests,
				user,
				organizationQuota,
				roleAssignments,
				permissionGrants,
				files,
				assets,
				aiThreads,
				aiMessages,
				chatMessages,
				notifications,
			] = await Promise.all([
				ctx.db.get("organizations_workspaces", extraWorkspace._yay!.workspaceId),
				ctx.db.query("data_deletion_requests").collect(),
				ctx.db.get("users", userId),
				organizations_test_read_organization_extra_workspace_quota_doc(ctx, { organizationId: created._yay!.organizationId }),
				ctx.db
					.query("access_control_role_assignments")
					.withIndex("by_organization_workspace_user_role", (q) =>
						q.eq("organizationId", created._yay!.organizationId).eq("workspaceId", extraWorkspace._yay!.workspaceId),
					)
					.collect(),
				ctx.db
					.query("access_control_permission_grants")
					.withIndex("by_organization_workspace_resource_user_permission", (q) =>
						q.eq("organizationId", created._yay!.organizationId).eq("workspaceId", extraWorkspace._yay!.workspaceId),
					)
					.collect(),
				ctx.db.query("files_nodes").collect(),
				ctx.db.query("files_r2_assets").collect(),
				ctx.db.query("ai_chat_threads").collect(),
				ctx.db.query("ai_chat_threads_messages_aisdk_5").collect(),
				ctx.db.query("chat_messages").collect(),
				ctx.db
					.query("notifications")
					.withIndex("by_organization_workspace_user", (q) =>
						q.eq("organizationId", created._yay!.organizationId).eq("workspaceId", extraWorkspace._yay!.workspaceId),
					)
					.collect(),
			]);

			return {
				workspace,
				requests: requests.filter(
					(row) => row.organizationId === created._yay!.organizationId && row.workspaceId === extraWorkspace._yay!.workspaceId,
				),
				user,
				organizationQuota,
				roleAssignments,
				permissionGrants,
				files: files.filter(
					(row) =>
						row.organizationId === created._yay!.organizationId &&
						row.workspaceId === extraWorkspace._yay!.workspaceId,
				),
				assets: assets.filter(
					(row) =>
						row.organizationId === created._yay!.organizationId &&
						row.workspaceId === extraWorkspace._yay!.workspaceId,
				),
				aiThreads: aiThreads.filter(
					(row) =>
						row.organizationId === created._yay!.organizationId &&
						row.workspaceId === extraWorkspace._yay!.workspaceId,
				),
				aiMessages: aiMessages.filter(
					(row) =>
						row.organizationId === created._yay!.organizationId &&
						row.workspaceId === extraWorkspace._yay!.workspaceId,
				),
				chatMessages: chatMessages.filter(
					(row) =>
						row.organizationId === created._yay!.organizationId &&
						row.workspaceId === extraWorkspace._yay!.workspaceId,
				),
				notifications,
			};
		});

		expect(after_delete.workspace).toBeNull();
		expect(after_delete.notifications).toHaveLength(0);
		expect(after_delete.requests).toHaveLength(1);
		expect(after_delete.requests[0]?.scope).toBe("workspace");
		expect(after_delete.files).toHaveLength(1);
		expect(after_delete.assets).toHaveLength(1);
		expect(after_delete.aiThreads).toHaveLength(1);
		expect(after_delete.aiMessages).toHaveLength(1);
		expect(after_delete.chatMessages).toHaveLength(1);
		expect(after_delete.organizationQuota?.usedCount).toBe(0);
		expect(after_delete.roleAssignments).toHaveLength(0);
		expect(after_delete.permissionGrants).toHaveLength(0);
		expect(after_delete.user?.defaultOrganizationId).toBe(personalDefaultIds.organizationId);
		expect(after_delete.user?.defaultWorkspaceId).toBe(personalDefaultIds.defaultWorkspaceId);

		await organizations_test_process_workspace_deletion_request_until_done(t, {
			requestId: after_delete.requests[0]!._id,
		});

		const purgeRequestsAfter = await t.run(async (ctx) =>
			(await ctx.db.query("data_deletion_requests").collect()).filter(
				(row) => row.organizationId === created._yay!.organizationId && row.workspaceId === extraWorkspace._yay!.workspaceId,
			),
		);
		expect(purgeRequestsAfter).toHaveLength(0);
	});
});

describe("delete_organization", () => {
	test("rejects deletion by an active member who is not the organization owner", async () => {
		const t = test_convex();
		const [ownerId, memberId] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", { clerkUserId: "clerk-user-delete-owner-only-owner" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-delete-owner-only-member" }),
			]),
		);
		await organizations_test_bootstrap_users(t, { userIds: [ownerId, memberId] });
		const owner = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: ownerId,
			name: "Owner",
			email: "delete-owner-only-owner@test.local",
		});
		const member = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: memberId,
			name: "Member",
			email: "delete-owner-only-member@test.local",
		});

		const created = await owner.mutation(api.organizations.create_organization, {
			description: "",
			name: "owner-only-delete",
		});
		expect(created._yay).toBeTruthy();

		await t.run(async (ctx) => {
			await ctx.db.insert("organizations_workspaces_users", {
				organizationId: created._yay!.organizationId,
				workspaceId: created._yay!.defaultWorkspaceId,
				userId: memberId,
				active: true,
			});
		});

		const result = await member.mutation(api.organizations.delete_organization, {
			organizationId: created._yay!.organizationId,
		});
		expect(result._nay?.message).toBe("Permission denied");

		const organizationAfter = await t.run((ctx) => ctx.db.get("organizations", created._yay!.organizationId));
		expect(organizationAfter).not.toBeNull();
	});

	test("queues organization-scope purge, drops memberships immediately, keeps structure until cron, then purge removes content and structure", async () => {
		const t = test_convex();
		const [ownerId, memberId] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", { clerkUserId: "clerk-user-delete-organization-owner" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-delete-organization-member" }),
			]),
		);
		await organizations_test_bootstrap_user(t, { userId: ownerId });
		const owner = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: ownerId,
			name: "Owner",
			email: "organizations-test-user@test.local",
		});
		const memberDefault = await t.run((ctx) => organizations_test_seed_default_organization(ctx, { userId: memberId }));
		expect(memberDefault._yay).toBeTruthy();

		const created = await t.run(async (ctx) =>
			organizations_db_create(ctx, {
				userId: ownerId,
				name: "delete-org-ws",
				description: "",
				now: Date.now(),
				default: false,
			}),
		);
		expect(created._yay).toBeTruthy();

		const extraWorkspace = await owner.mutation(api.organizations.create_workspace, {
			description: "",
			organizationId: created._yay!.organizationId,
			name: "ops",
		});
		expect(extraWorkspace._yay).toBeTruthy();

		await t.run(async (ctx) => {
			await ctx.db.insert("notifications", {
				userId: memberId,
				kind: "organization_workspace_invite",
				read: false,
				actorUserId: ownerId,
				organizationId: created._yay!.organizationId,
				workspaceId: extraWorkspace._yay!.workspaceId,
				updatedAt: Date.now(),
			});
			await ctx.db.insert("organizations_workspaces_users", {
				organizationId: created._yay!.organizationId,
				workspaceId: extraWorkspace._yay!.workspaceId,
				userId: memberId,
				active: true,
			});

			await organizations_test_seed_workspace_scoped_rows(ctx, {
				userId: ownerId,
				organizationId: created._yay!.organizationId,
				workspaceId: created._yay!.defaultWorkspaceId,
				tag: "delete-organization-home",
			});
			await organizations_test_seed_workspace_scoped_rows(ctx, {
				userId: ownerId,
				organizationId: created._yay!.organizationId,
				workspaceId: extraWorkspace._yay!.workspaceId,
				tag: "delete-organization-extra",
			});
		});

		const quotasBeforeDelete = await t.run(async (ctx) =>
			ctx.db
				.query("quotas")
				.withIndex("by_organization_quotaName", (q) => q.eq("organizationId", created._yay!.organizationId))
				.collect(),
		);

		const result = await owner.mutation(api.organizations.delete_organization, {
			organizationId: created._yay!.organizationId,
		});
		expect(result._yay).toBeNull();

		const after_delete = await t.run(async (ctx) => {
			const [
				organization,
				defaultWorkspace,
				secondaryWorkspace,
				member,
				ownerQuota,
				organizationQuotas,
				memberships,
				roleAssignments,
				permissionGrants,
				requests,
				files,
				aiThreads,
				aiMessages,
				chatMessages,
				notifications,
			] = await Promise.all([
				ctx.db.get("organizations", created._yay!.organizationId),
				ctx.db.get("organizations_workspaces", created._yay!.defaultWorkspaceId),
				ctx.db.get("organizations_workspaces", extraWorkspace._yay!.workspaceId),
				ctx.db.get("users", memberId),
				organizations_test_read_user_extra_organization_quota_doc(ctx, { userId: ownerId }),
				ctx.db
					.query("quotas")
					.withIndex("by_organization_quotaName", (q) => q.eq("organizationId", created._yay!.organizationId))
					.collect(),
				ctx.db.query("organizations_workspaces_users").collect(),
				ctx.db
					.query("access_control_role_assignments")
					.withIndex("by_organization_workspace_user_role", (q) => q.eq("organizationId", created._yay!.organizationId))
					.collect(),
				ctx.db
					.query("access_control_permission_grants")
					.withIndex("by_organization_workspace_resource_user_permission", (q) =>
						q.eq("organizationId", created._yay!.organizationId),
					)
					.collect(),
				ctx.db.query("data_deletion_requests").collect(),
				ctx.db.query("files_nodes").collect(),
				ctx.db.query("ai_chat_threads").collect(),
				ctx.db.query("ai_chat_threads_messages_aisdk_5").collect(),
				ctx.db.query("chat_messages").collect(),
				ctx.db
					.query("notifications")
					.withIndex("by_organization_user_read", (q) => q.eq("organizationId", created._yay!.organizationId))
					.collect(),
			]);

			return {
				organization,
				defaultWorkspace,
				secondaryWorkspace,
				member,
				ownerQuota,
				organizationQuotas,
				memberships: memberships.filter((row) => row.organizationId === created._yay!.organizationId),
				roleAssignments,
				permissionGrants,
				requests: requests.filter((row) => row.organizationId === created._yay!.organizationId),
				files: files.filter((row) => row.organizationId === created._yay!.organizationId),
				aiThreads: aiThreads.filter((row) => row.organizationId === created._yay!.organizationId),
				aiMessages: aiMessages.filter((row) => row.organizationId === created._yay!.organizationId),
				chatMessages: chatMessages.filter((row) => row.organizationId === created._yay!.organizationId),
				notifications,
			};
		});

		expect(after_delete.organization).not.toBeNull();
		expect(after_delete.defaultWorkspace).not.toBeNull();
		expect(after_delete.secondaryWorkspace).not.toBeNull();
		expect(after_delete.memberships).toHaveLength(0);
		expect(after_delete.roleAssignments).toHaveLength(0);
		expect(after_delete.permissionGrants).toHaveLength(0);
		expect(after_delete.notifications).toHaveLength(0);
		expect(after_delete.requests).toHaveLength(1);
		expect(after_delete.requests[0]?.scope).toBe("organization");
		expect(after_delete.files).toHaveLength(2);
		expect(after_delete.aiThreads).toHaveLength(2);
		expect(after_delete.aiMessages).toHaveLength(2);
		expect(after_delete.chatMessages).toHaveLength(2);
		expect(after_delete.ownerQuota?.usedCount).toBe(0);
		expect(after_delete.organizationQuotas.map((row) => row._id).sort()).toEqual(
			quotasBeforeDelete.map((row) => row._id).sort(),
		);
		expect(after_delete.member?.defaultOrganizationId).toBe(memberDefault._yay!.organizationId);
		expect(after_delete.member?.defaultWorkspaceId).toBe(memberDefault._yay!.defaultWorkspaceId);

		await organizations_test_process_organization_deletion_request_until_done(t, {
			requestId: after_delete.requests[0]!._id,
		});

		const purgeRequestsAfter = await t.run(async (ctx) =>
			(await ctx.db.query("data_deletion_requests").collect()).filter(
				(row) => row.organizationId === created._yay!.organizationId,
			),
		);
		expect(purgeRequestsAfter).toHaveLength(0);

		const after_purge = await t.run(async (ctx) => {
			const [organization, defaultWorkspace, secondaryWorkspace, organizationQuotas, files] = await Promise.all([
				ctx.db.get("organizations", created._yay!.organizationId),
				ctx.db.get("organizations_workspaces", created._yay!.defaultWorkspaceId),
				ctx.db.get("organizations_workspaces", extraWorkspace._yay!.workspaceId),
				ctx.db
					.query("quotas")
					.withIndex("by_organization_quotaName", (q) => q.eq("organizationId", created._yay!.organizationId))
					.collect(),
				ctx.db.query("files_nodes").collect(),
			]);
			return {
				organization,
				defaultWorkspace,
				secondaryWorkspace,
				organizationQuotas,
				files: files.filter((row) => row.organizationId === created._yay!.organizationId),
			};
		});
		expect(after_purge.organization).toBeNull();
		expect(after_purge.defaultWorkspace).toBeNull();
		expect(after_purge.secondaryWorkspace).toBeNull();
		expect(after_purge.organizationQuotas).toHaveLength(0);
		expect(after_purge.files).toHaveLength(0);
	});

	test("queues an organization-scope purge even when the organization already has a queued ws-scope purge", async () => {
		const t = test_convex();
		const ownerId = await t.run(async (ctx) =>
			ctx.db.insert("users", { clerkUserId: "clerk-user-delete-organization-after-ws-delete" }),
		);
		await organizations_test_bootstrap_user(t, { userId: ownerId });
		const owner = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: ownerId,
			name: "Owner",
			email: "organizations-test-user@test.local",
		});

		const created = await t.run(async (ctx) =>
			organizations_db_create(ctx, {
				userId: ownerId,
				name: "queued",
				description: "",
				now: Date.now(),
				default: false,
			}),
		);
		expect(created._yay).toBeTruthy();

		const extraWorkspace = await t.run((ctx) =>
			organizations_db_create_workspace(ctx, {
				userId: ownerId,
				description: "",
				organizationId: created._yay!.organizationId,
				name: "scratch",
				now: Date.now(),
			}),
		);
		if (extraWorkspace._nay) {
			throw new Error(extraWorkspace._nay.message);
		}
		expect(extraWorkspace._yay).toBeTruthy();

		const deleteWorkspaceResult = await owner.mutation(api.organizations.delete_workspace, {
			workspaceId: extraWorkspace._yay!.workspaceId,
		});
		expect(deleteWorkspaceResult._yay).toBeNull();

		const deleteOrganizationResult = await owner.mutation(api.organizations.delete_organization, {
			organizationId: created._yay!.organizationId,
		});
		expect(deleteOrganizationResult._yay).toBeNull();

		const requestsAfterDeleteOrganization = await t.run(async (ctx) =>
			(await ctx.db.query("data_deletion_requests").collect()).filter(
				(row) => row.organizationId === created._yay!.organizationId,
			),
		);

		expect(
			requestsAfterDeleteOrganization.filter(
				(row) => row.scope === "workspace" && row.workspaceId === extraWorkspace._yay!.workspaceId,
			),
		).toHaveLength(1);
		expect(
			requestsAfterDeleteOrganization.filter((row) => row.scope === "organization" && row.workspaceId === undefined),
		).toHaveLength(1);
	});
});

describe("process_workspace_deletion_request", () => {
	test("purges only the requested organization/workspace scope and keeps sibling workspace rows", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-purge-data-deletion-requests",
			}),
		);
		await organizations_test_bootstrap_user(t, { userId });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "organizations-test-user@test.local",
		});

		const created = await t.run(async (ctx) =>
			organizations_db_create(ctx, {
				userId,
				name: "purge-requests-ws",
				description: "",
				now: Date.now(),
				default: false,
			}),
		);
		expect(created._yay).toBeTruthy();

		const victimWorkspace = await asUser.mutation(api.organizations.create_workspace, {
			description: "",
			organizationId: created._yay!.organizationId,
			name: "scratch",
		});
		expect(victimWorkspace._yay).toBeTruthy();

		const purgeRequest = await t.run(async (ctx) => {
			await organizations_test_seed_workspace_scoped_rows(ctx, {
				userId,
				organizationId: created._yay!.organizationId,
				workspaceId: created._yay!.defaultWorkspaceId,
				tag: "purge-control",
			});
			await organizations_test_seed_workspace_scoped_rows(ctx, {
				userId,
				organizationId: created._yay!.organizationId,
				workspaceId: victimWorkspace._yay!.workspaceId,
				tag: "purge-victim",
			});

			const purgeRequestId = await ctx.db.insert("data_deletion_requests", {
				userId,
				organizationId: created._yay!.organizationId,
				workspaceId: victimWorkspace._yay!.workspaceId,
				scope: "workspace",
				eligibleAt: Date.now() + RETENTION_MS,
			});
			const purgeRequest = await ctx.db.get("data_deletion_requests", purgeRequestId);
			if (!purgeRequest) {
				throw new Error("Failed to load purge request");
			}

			return purgeRequest;
		});

		await organizations_test_process_workspace_deletion_request_until_done(t, {
			requestId: purgeRequest._id,
		});

		const afterPurge = await t.run(async (ctx) => {
			const [requests, files, assets, aiThreads, aiMessages, chatMessages] = await Promise.all([
				ctx.db.query("data_deletion_requests").collect(),
				ctx.db.query("files_nodes").collect(),
				ctx.db.query("files_r2_assets").collect(),
				ctx.db.query("ai_chat_threads").collect(),
				ctx.db.query("ai_chat_threads_messages_aisdk_5").collect(),
				ctx.db.query("chat_messages").collect(),
			]);

			return {
				victimRequests: requests.filter(
					(row) => row.organizationId === created._yay!.organizationId && row.workspaceId === victimWorkspace._yay!.workspaceId,
				),
				controlPages: files.filter(
					(row) =>
						row.organizationId === created._yay!.organizationId &&
						row.workspaceId === created._yay!.defaultWorkspaceId,
				),
				victimPages: files.filter(
					(row) =>
						row.organizationId === created._yay!.organizationId &&
						row.workspaceId === victimWorkspace._yay!.workspaceId,
				),
				controlAssets: assets.filter(
					(row) =>
						row.organizationId === created._yay!.organizationId &&
						row.workspaceId === created._yay!.defaultWorkspaceId,
				),
				victimAssets: assets.filter(
					(row) =>
						row.organizationId === created._yay!.organizationId &&
						row.workspaceId === victimWorkspace._yay!.workspaceId,
				),
				controlAiThreads: aiThreads.filter(
					(row) =>
						row.organizationId === created._yay!.organizationId &&
						row.workspaceId === created._yay!.defaultWorkspaceId,
				),
				victimAiThreads: aiThreads.filter(
					(row) =>
						row.organizationId === created._yay!.organizationId &&
						row.workspaceId === victimWorkspace._yay!.workspaceId,
				),
				controlAiMessages: aiMessages.filter(
					(row) =>
						row.organizationId === created._yay!.organizationId &&
						row.workspaceId === created._yay!.defaultWorkspaceId,
				),
				victimAiMessages: aiMessages.filter(
					(row) =>
						row.organizationId === created._yay!.organizationId &&
						row.workspaceId === victimWorkspace._yay!.workspaceId,
				),
				controlChatMessages: chatMessages.filter(
					(row) =>
						row.organizationId === created._yay!.organizationId &&
						row.workspaceId === created._yay!.defaultWorkspaceId,
				),
				victimChatMessages: chatMessages.filter(
					(row) =>
						row.organizationId === created._yay!.organizationId &&
						row.workspaceId === victimWorkspace._yay!.workspaceId,
				),
			};
		});

		expect(afterPurge.victimRequests).toHaveLength(0);
		expect(afterPurge.victimPages).toHaveLength(0);
		expect(afterPurge.victimAssets).toHaveLength(0);
		expect(afterPurge.victimAiThreads).toHaveLength(0);
		expect(afterPurge.victimAiMessages).toHaveLength(0);
		expect(afterPurge.victimChatMessages).toHaveLength(0);
		expect(afterPurge.controlPages).toHaveLength(1);
		expect(afterPurge.controlAssets).toHaveLength(1);
		expect(afterPurge.controlAiThreads).toHaveLength(1);
		expect(afterPurge.controlAiMessages).toHaveLength(1);
		expect(afterPurge.controlChatMessages).toHaveLength(1);
	});
});

describe("get_membership_by_organization_workspace_name", () => {
	test("resolves membership for an accessible tenant", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) =>
			test_mocks_fill_db_with.membership(ctx, {
				organizationName: "personal",
				workspaceName: "home",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
			email: "organizations-test-user@test.local",
		});
		const membership = await t.run(async (ctx) => ctx.db.get("organizations_workspaces_users", db.membershipId));

		const result = await asUser.query(api.organizations.get_membership_by_organization_workspace_name, {
			organizationName: "personal",
			workspaceName: "home",
		});

		expect(result).toStrictEqual(membership);
	});

	test("returns null for an inaccessible tenant", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) =>
			test_mocks_fill_db_with.membership(ctx, {
				organizationName: "personal",
				workspaceName: "home",
			}),
		);
		const otherUserId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-5",
			}),
		);
		const asOtherUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: otherUserId,
			name: "Other User",
			email: "organizations-test-user@test.local",
		});

		const result = await asOtherUser.query(api.organizations.get_membership_by_organization_workspace_name, {
			organizationName: "personal",
			workspaceName: "home",
		});

		expect(db.membershipId).toBeTruthy();
		expect(result).toBeNull();
	});
});

describe("set_organization_billing_mode", () => {
	test("lets the organization owner update a created organization billing mode", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-set-billing-owner",
			}),
		);
		await organizations_test_bootstrap_user(t, { userId });
		const asOwner = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Billing Owner",
			email: "billing-owner@test.local",
		});
		const created = await asOwner.mutation(api.organizations.create_organization, {
			description: "",
			name: "billing-mode-owner",
		});
		expect(created._yay).toBeTruthy();

		const result = await asOwner.mutation(api.organizations.set_organization_billing_mode, {
			organizationId: created._yay!.organizationId,
			billingMode: "organization_owner",
		});

		expect(result._yay).toBeNull();
		const organization = await t.run((ctx) => ctx.db.get("organizations", created._yay!.organizationId));
		expect(organization?.billingMode).toBe("organization_owner");
	});

	test("rejects billing mode changes for personal organizations", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-set-billing-personal",
			}),
		);
		await organizations_test_bootstrap_user(t, { userId });
		const user = await t.run((ctx) => ctx.db.get("users", userId));
		if (!user?.defaultOrganizationId) {
			throw new Error("Expected default organization");
		}
		const asOwner = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Personal Billing Owner",
			email: "billing-personal@test.local",
		});

		const result = await asOwner.mutation(api.organizations.set_organization_billing_mode, {
			organizationId: user.defaultOrganizationId,
			billingMode: "organization_owner",
		});

		expect(result).toEqual({
			_nay: {
				message: "Cannot manage billing for the default organization",
			},
		});
	});

	test("rejects billing mode changes from non-owner members", async () => {
		const t = test_convex();
		const [ownerId, memberId] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", { clerkUserId: "clerk-user-set-billing-owner-denied" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-set-billing-member-denied" }),
			]),
		);
		await organizations_test_bootstrap_users(t, { userIds: [ownerId, memberId] });
		const owner = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: ownerId,
			name: "Owner",
			email: "billing-denied-owner@test.local",
		});
		const member = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: memberId,
			name: "Member",
			email: "billing-denied-member@test.local",
		});
		const created = await owner.mutation(api.organizations.create_organization, {
			description: "",
			name: "billing-mode-denied",
		});
		expect(created._yay).toBeTruthy();
		await t.run(async (ctx) => {
			await ctx.db.insert("organizations_workspaces_users", {
				organizationId: created._yay!.organizationId,
				workspaceId: created._yay!.defaultWorkspaceId,
				userId: memberId,
				active: true,
				updatedAt: Date.now(),
			});
			await access_control_db_ensure_role_assignment(ctx, {
				organizationId: created._yay!.organizationId,
				workspaceId: created._yay!.defaultWorkspaceId,
				userId: memberId,
				role: "member",
				now: Date.now(),
			});
		});

		const result = await member.mutation(api.organizations.set_organization_billing_mode, {
			organizationId: created._yay!.organizationId,
			billingMode: "organization_owner",
		});

		expect(result).toEqual({
			_nay: {
				message: "Permission denied",
			},
		});
	});
});

describe("list", () => {
	test("orders non-default organizations alphabetically by name", async () => {
		const t = test_convex();
		const userIds = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", {
					clerkUserId: "clerk-user-list-sort-1-viewer",
				}),
				ctx.db.insert("users", {
					clerkUserId: "clerk-user-list-sort-1-owner",
				}),
			]),
		);
		await organizations_test_bootstrap_users(t, { userIds });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userIds[0],
			name: "Test User",
			email: "organizations-test-user@test.local",
		});
		const owner = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userIds[1],
			name: "Owner",
			email: "organizations-test-user@test.local",
		});

		const wsZ = await asUser.mutation(api.organizations.create_organization, {
			description: "",
			name: "zebra-team",
		});
		expect(wsZ._yay).toBeTruthy();

		const wsA = await owner.mutation(api.organizations.create_organization, {
			description: "",
			name: "acme-team",
		});
		expect(wsA._yay).toBeTruthy();

		const shareResult = await owner.mutation(api.organizations.invite_user_to_organization_workspace, {
			organizationId: wsA._yay!.organizationId,
			workspaceId: wsA._yay!.defaultWorkspaceId,
			userIdToAdd: userIds[0],
		});
		expect(shareResult._yay).toBeNull();

		const list = await asUser.query(api.organizations.list, {});
		const names = list.organizations.map((w) => w.name);

		expect(names).toEqual(["personal", "acme-team", "zebra-team"]);
	});

	test("places default organization before other organizations", async () => {
		const t = test_convex();
		const userIds = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", {
					clerkUserId: "clerk-user-list-sort-2-viewer",
				}),
				ctx.db.insert("users", {
					clerkUserId: "clerk-user-list-sort-2-owner",
				}),
			]),
		);
		await organizations_test_bootstrap_user(t, { userId: userIds[1] });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userIds[0],
			name: "Test User",
			email: "organizations-test-user@test.local",
		});
		const owner = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userIds[1],
			name: "Owner",
			email: "organizations-test-user@test.local",
		});

		await organizations_test_bootstrap_user(t, { userId: userIds[0] });

		const ownedOrganization = await asUser.mutation(api.organizations.create_organization, {
			description: "",
			name: "mango-extra",
		});
		expect(ownedOrganization._yay).toBeTruthy();
		const sharedOrganization = await owner.mutation(api.organizations.create_organization, {
			description: "",
			name: "alpha-extra",
		});
		expect(sharedOrganization._yay).toBeTruthy();
		const shareResult = await owner.mutation(api.organizations.invite_user_to_organization_workspace, {
			organizationId: sharedOrganization._yay!.organizationId,
			workspaceId: sharedOrganization._yay!.defaultWorkspaceId,
			userIdToAdd: userIds[0],
		});
		expect(shareResult._yay).toBeNull();

		const list = await asUser.query(api.organizations.list, {});
		const names = list.organizations.map((w) => w.name);

		expect(names[0]).toBe("personal");
		expect(names.slice(1)).toEqual(["alpha-extra", "mango-extra"]);
	});

	test("orders workspaces with organization primary first then alphabetically", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-list-sort-3",
			}),
		);
		await organizations_test_bootstrap_user(t, { userId });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "organizations-test-user@test.local",
		});

		const ws = await asUser.mutation(api.organizations.create_organization, {
			description: "",
			name: "ws-sort-ws",
		});
		expect(ws._yay).toBeTruthy();
		const organizationId = ws._yay!.organizationId;

		await asUser.mutation(api.organizations.create_workspace, {
			description: "",
			organizationId,
			name: "zebra-ws",
		});

		const list = await asUser.query(api.organizations.list, {});
		const workspaces = list.organizationIdsWorkspacesDict[organizationId];
		const workspaceNames = workspaces.map((p) => p.name);

		expect(workspaceNames[0]).toBe("home");
		expect(workspaceNames[1]).toBe("zebra-ws");
	});

	test("keeps organization.defaultWorkspaceId when the user only sees non-primary workspace memberships", async () => {
		const t = test_convex();
		const userIds = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", { clerkUserId: "clerk-user-list-hidden-primary-owner" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-list-hidden-primary-member" }),
			]),
		);
		await organizations_test_bootstrap_users(t, { userIds });

		const created = await t.run(async (ctx) =>
			organizations_db_create(ctx, {
				userId: userIds[0],
				name: "hidden-primary-ws",
				description: "",
				now: Date.now(),
				default: false,
			}),
		);
		expect(created._yay).toBeTruthy();

		const owner = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userIds[0],
			name: "Owner",
			email: "organizations-test-user@test.local",
		});
		const member = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userIds[1],
			name: "Member",
			email: "organizations-test-user@test.local",
		});

		const extra = await owner.mutation(api.organizations.create_workspace, {
			description: "",
			organizationId: created._yay!.organizationId,
			name: "shared-ws",
		});
		expect(extra._yay).toBeTruthy();

		await t.run(async (ctx) => {
			await ctx.db.insert("organizations_workspaces_users", {
				organizationId: created._yay!.organizationId,
				workspaceId: extra._yay!.workspaceId,
				userId: userIds[1],
				active: true,
			});
		});

		const list = await member.query(api.organizations.list, {});
		const organization = list.organizations.find((row) => row._id === created._yay!.organizationId);
		const workspaces = list.organizationIdsWorkspacesDict[created._yay!.organizationId];

		expect(organization?._id).toBe(created._yay!.organizationId);
		expect(organization?.defaultWorkspaceId).toBe(created._yay!.defaultWorkspaceId);
		expect(workspaces.map((workspace) => workspace._id)).toEqual([extra._yay!.workspaceId]);
	});
});

describe("quotas.get", () => {
	test("returns null for stale identities after the user doc is purged", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) => {
			const id = await ctx.db.insert("users", { clerkUserId: "clerk-user-quota-purged" });
			await ctx.db.delete("users", id);
			return id;
		});
		const asDeletedUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Deleted User",
			email: "organizations-test-user@test.local",
		});

		const quotaDoc = await asDeletedUser.query(api.quotas.get, {
			quotaName: "extra_organizations",
			userId,
		});

		expect(quotaDoc).toBeNull();
	});

	test("returns null for stale identities after the user is tombstoned", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) => {
			return await ctx.db.insert("users", {
				clerkUserId: null,
				deletedAt: 123_456,
			});
		});
		const asDeletedUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Deleted User",
			email: "organizations-test-user@test.local",
		});

		const quotaDoc = await asDeletedUser.query(api.quotas.get, {
			quotaName: "extra_organizations",
			userId,
		});

		expect(quotaDoc).toBeNull();
	});

	test("returns current user's quota doc for the user scope", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) => {
			const now = Date.now();
			const id = await ctx.db.insert("users", { clerkUserId: "clerk-user-quota-current" });
			await quotas_db_ensure(ctx, {
				quotaName: "extra_organizations",
				userId: id,
				now,
			});
			return id;
		});
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Live User",
			email: "organizations-test-user@test.local",
		});

		const quotaDoc = await asUser.query(api.quotas.get, {
			quotaName: "extra_organizations",
			userId,
		});

		expect(quotaDoc).toMatchObject({
			quotaName: "extra_organizations",
			userId,
			usedCount: 0,
			maxCount: 2,
		});
	});

	test("still throws when a live user is missing the required quota doc", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) => {
			return await ctx.db.insert("users", { clerkUserId: "clerk-user-quota-missing-doc" });
		});
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Live User",
			email: "organizations-test-user@test.local",
		});

		await expect(
			asUser.query(api.quotas.get, {
				quotaName: "extra_organizations",
				userId,
			}),
		).rejects.toThrow("Missing quota doc");
	});

	test("still throws when an accessible organization is missing the required quota doc", async () => {
		const t = test_convex();
		const organization = await t.run(async (ctx) => {
			const userId = await ctx.db.insert("users", { clerkUserId: "clerk-user-organization-quota-missing-doc" });
			const now = Date.now();
			const organizationId = await ctx.db.insert("organizations", {
				name: "organization-quota-missing-doc",
				description: "",
				default: false,
				billingMode: "user",
				ownerUserId: userId,
				updatedAt: now,
			});
			const workspaceId = await ctx.db.insert("organizations_workspaces", {
				organizationId,
				name: "home",
				description: "",
				default: true,
				updatedAt: now,
			});
			await ctx.db.insert("organizations_workspaces_users", {
				organizationId,
				workspaceId,
				userId,
				active: true,
				updatedAt: now,
			});

			return { userId, organizationId };
		});
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: organization.userId,
			name: "Live User",
			email: "organizations-test-user@test.local",
		});

		await expect(
			asUser.query(api.quotas.get, {
				quotaName: "extra_workspaces",
				organizationId: organization.organizationId,
			}),
		).rejects.toThrow("Missing quota doc");
	});

	test("returns null for another user's quota scope", async () => {
		const t = test_convex();
		const [ownerId, memberId] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", { clerkUserId: "clerk-user-quota-other-owner" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-quota-other-member" }),
			]),
		);
		await organizations_test_bootstrap_users(t, { userIds: [ownerId, memberId] });
		const member = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: memberId,
			name: "Member",
			email: "organizations-test-user@test.local",
		});

		const quotaDoc = await member.query(api.quotas.get, {
			quotaName: "extra_organizations",
			userId: ownerId,
		});

		expect(quotaDoc).toBeNull();
	});

	test("returns quota doc for owned non-default organizations", async () => {
		const t = test_convex();
		const [ownerId, memberId] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", { clerkUserId: "clerk-user-list-quota-owner" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-list-quota-member" }),
			]),
		);
		await organizations_test_bootstrap_users(t, { userIds: [ownerId, memberId] });
		const member = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: memberId,
			name: "Member",
			email: "organizations-test-user@test.local",
		});

		const sharedOrganization = await t.run(async (ctx) => {
			const created = await organizations_db_create(ctx, {
				userId: ownerId,
				description: "",
				name: "quota-shared",
				now: Date.now(),
				default: false,
			});
			if (created._nay) {
				throw new Error(created._nay.message);
			}

			await ctx.db.insert("organizations_workspaces_users", {
				organizationId: created._yay.organizationId,
				workspaceId: created._yay.defaultWorkspaceId,
				userId: memberId,
				active: true,
				updatedAt: Date.now(),
			});

			return created._yay;
		});
		expect(sharedOrganization).toBeTruthy();

		const beforeOwnedOrganization = await member.query(api.quotas.get, {
			quotaName: "extra_organizations",
			userId: memberId,
		});
		expect(beforeOwnedOrganization).toMatchObject({
			quotaName: "extra_organizations",
			userId: memberId,
			usedCount: 0,
			maxCount: 2,
		});

		const ownedOrganization = await t.run((ctx) =>
			organizations_db_create(ctx, {
				userId: memberId,
				description: "",
				name: "quota-owned",
				now: Date.now(),
				default: false,
			}),
		);
		expect(ownedOrganization._yay).toBeTruthy();
		if (ownedOrganization._nay) {
			throw new Error(ownedOrganization._nay.message);
		}

		const afterOwnedOrganization = await member.query(api.quotas.get, {
			quotaName: "extra_organizations",
			userId: memberId,
		});
		expect(afterOwnedOrganization).toMatchObject({
			quotaName: "extra_organizations",
			userId: memberId,
			usedCount: 1,
			maxCount: 2,
		});
	});

	test("returns null for an inaccessible organization quota scope", async () => {
		const t = test_convex();
		const [ownerId, memberId] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", { clerkUserId: "clerk-user-quota-private-owner" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-quota-private-member" }),
			]),
		);
		await organizations_test_bootstrap_users(t, { userIds: [ownerId, memberId] });
		const member = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: memberId,
			name: "Member",
			email: "organizations-test-user@test.local",
		});

		const organizationResult = await t.run((ctx) =>
			organizations_db_create(ctx, {
				userId: ownerId,
				description: "",
				name: "quota-private",
				now: Date.now(),
				default: false,
			}),
		);
		expect(organizationResult._yay).toBeTruthy();
		if (organizationResult._nay) {
			throw new Error(organizationResult._nay.message);
		}

		const quotaDoc = await member.query(api.quotas.get, {
			quotaName: "extra_workspaces",
			organizationId: organizationResult._yay!.organizationId,
		});

		expect(quotaDoc).toBeNull();
	});

	test("returns quota doc for an organization the user can access through a non-primary workspace membership", async () => {
		const t = test_convex();
		const userIds = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", { clerkUserId: "clerk-user-organization-quota-owner" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-organization-quota-member" }),
			]),
		);
		await organizations_test_bootstrap_users(t, { userIds });

		const owner = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userIds[0],
			name: "Owner",
			email: "organizations-test-user@test.local",
		});
		const member = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userIds[1],
			name: "Member",
			email: "organizations-test-user@test.local",
		});

		const created = await t.run(async (ctx) =>
			organizations_db_create(ctx, {
				userId: userIds[0],
				name: "org-quota-ws",
				description: "",
				now: Date.now(),
				default: false,
			}),
		);
		expect(created._yay).toBeTruthy();

		const extra = await owner.mutation(api.organizations.create_workspace, {
			description: "",
			organizationId: created._yay!.organizationId,
			name: "org-quota-ws",
		});
		expect(extra._yay).toBeTruthy();

		await t.run(async (ctx) => {
			await ctx.db.insert("organizations_workspaces_users", {
				organizationId: created._yay!.organizationId,
				workspaceId: extra._yay!.workspaceId,
				userId: userIds[1],
				active: true,
			});
		});

		const quotaDoc = await member.query(api.quotas.get, {
			quotaName: "extra_workspaces",
			organizationId: created._yay!.organizationId,
		});
		expect(quotaDoc).toMatchObject({
			quotaName: "extra_workspaces",
			organizationId: created._yay!.organizationId,
			usedCount: 1,
			maxCount: 5,
		});
	});
});
