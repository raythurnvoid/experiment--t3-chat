import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { R2 } from "@convex-dev/r2";
import { api, components, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server.js";
import { test_convex, test_mocks_cancel_pending_home_file_seeds, test_mocks_fill_db_with } from "./setup.test.ts";
import {
	organizations_db_create,
	organizations_db_create_workspace,
	organizations_db_ensure_default_organization_and_workspace_for_user,
} from "./organizations.ts";
import { access_control_db_ensure_role_assignment, access_control_db_has_permission } from "./access_control.ts";
import { Result } from "common/errors-as-values-utils.ts";
import { quotas_db_ensure, quotas_db_get } from "./quotas.ts";
import { organizations_DESCRIPTION_MAX_LENGTH, organizations_NAME_MAX_LENGTH } from "../shared/organizations.ts";
import { files_get_utf8_byte_size } from "../server/files.ts";

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

beforeEach(() => {
	vi.spyOn(R2.prototype, "deleteObject").mockResolvedValue(undefined);
});

afterEach(() => {
	vi.useRealTimers();
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

async function organizations_test_seed_default_organization(
	ctx: MutationCtx,
	args: { userId: Id<"users">; now?: number },
) {
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

async function organizations_test_read_user_extra_organization_quota_doc(
	ctx: MutationCtx,
	args: { userId: Id<"users"> },
) {
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
	return await ctx.db
		.query("notifications")
		.withIndex("by_user", (q) => q.eq("userId", args.userId))
		.collect();
}

async function organizations_test_seed_api_credential(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
		tag: string;
		revokedAt?: number | null;
	},
) {
	const keyId = `pk_${args.tag.padStart(32, "0")}`;
	const now = Date.now();
	const revokedAt = args.revokedAt ?? null;
	const credentialId = await ctx.db.insert("api_credentials", {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		userId: args.userId,
		name: `API key ${args.tag}`,
		keyId,
		obfuscatedValue: `${keyId}.****0000`,
		secretHash: `hash-${args.tag}`,
		scopes: ["files:list", "files:read"],
		createdAt: now,
		revokedAt,
		lastUsedAt: null,
	});
	if (revokedAt === null) {
		const quota = await quotas_db_get(ctx, {
			quotaName: "active_api_credentials",
			userId: args.userId,
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
		});
		await ctx.db.patch("quotas", quota._id, {
			usedCount: quota.usedCount + 1,
			updatedAt: now,
		});
	}
	return credentialId;
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
		fileNodeId: nodeId,
		threadId: null,
		parentId: null,
		isArchived: false,
		createdBy: args.userId,
		content: `${args.tag} chat`,
	});
}

async function organizations_test_seed_live_plugin_authority(
	ctx: MutationCtx,
	args: {
		userId: Id<"users">;
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		tag: string;
	},
) {
	const now = Date.now();
	const pluginVersionId = await ctx.db.insert("plugins_versions", {
		name: "chitchat",
		displayName: "Chitchat",
		version: "0.1.0",
		description: "Deletion authority fixture",
		reviewStatus: "passed",
		reviewId: null,
		isLatest: true,
		artifactHash: `sha256:${args.tag.padEnd(64, "a").slice(0, 64)}`,
		sourceRepositoryUrl: "https://github.com/bonobo/deletion-authority-fixture",
		sourceOwner: "bonobo",
		sourceRepo: "deletion-authority-fixture",
		sourceCommitSha: args.tag.padEnd(40, "0").slice(0, 40),
		manifestR2Key: `plugins/deletion-authority/${args.tag}/manifest.json`,
		backendEntrypointFile: null,
		configuration: null,
		events: [],
		pages: [],
		fileViews: [],
		capabilities: [],
		outboundOrigins: [],
		uiOutboundOrigins: [],
		files: [],
		sourceStatus: "ready",
		sourceLastError: null,
		createdBy: args.userId,
		updatedAt: now,
	});
	const installationId = await ctx.db.insert("plugins_workspace_installations", {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		pluginVersionId,
		pluginName: "chitchat",
		status: "enabled",
		configurationYaml: null,
		acceptedCapabilities: [],
		capabilitiesAcceptedAt: now,
		acceptedOutboundOrigins: [],
		acceptedUiOutboundOrigins: [],
		outboundOriginsAcceptedAt: now,
		installedBy: args.userId,
		updatedBy: args.userId,
		updatedAt: now,
	});
	const runId = await ctx.db.insert("plugins_event_runs", {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		actorUserId: args.userId,
		installationId,
		pluginVersionId,
		event: "users.account.deleted",
		eventId: `plugin:deletion-authority:${args.tag}`,
		status: "running",
		acceptedCapabilities: [],
		expiresAt: now + 30 * 60 * 1000,
		apiTokenHash: args.tag.padEnd(64, "b").slice(0, 64),
		apiTokenExpiresAt: now + 30 * 60 * 1000,
		apiCallCount: 0,
		outputWriteCount: 0,
		errorMessage: null,
		updatedAt: now,
	});

	return { installationId, runId };
}

describe("create_organization", () => {
	test("refuses an anonymous caller", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) => ctx.db.insert("users", { clerkUserId: null }));
		await organizations_test_bootstrap_user(t, { userId });

		// Anyone can make an anonymous account with one request that needs no login. Owning an
		// organization is what unlocks the invite, and an invite puts an active membership and a
		// notification into a real user's account with no step where they accept.
		const asAnonymous = t.withIdentity({
			issuer: process.env.VITE_CONVEX_HTTP_URL!,
			subject: userId,
			name: "Anonymous Organizations Test",
		});

		const result = await asAnonymous.mutation(api.organizations.create_organization, {
			description: "",
			name: "anon-owned-org",
		});

		// The handler answers every auth failure with this same word. The sentence the user reads is
		// written by the dialog, in `main-app-header-organization-controls-modal.tsx`.
		expect(result._nay?.message).toBe("Unauthenticated");
		const organizations = await t.run((ctx) => ctx.db.query("organizations").collect());
		expect(organizations.some((organization) => organization.name === "anon-owned-org")).toBe(false);
	});

	test("refuses a signed-in caller whose account is already deleted", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) => ctx.db.insert("users", { clerkUserId: "clerk-user-tombstoned" }));
		await organizations_test_bootstrap_user(t, { userId });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "organizations-test-user@test.local",
		});

		// First check that the same caller succeeds *before* we mark the account as deleted. The handler
		// answers "Unauthenticated" from two places: this deleted-account check, and the "no identity"
		// check above it. Without this first call, a broken test setup whose identity never worked would
		// give the same message, and the test would pass for the wrong reason.
		const beforeDeletion = await asUser.mutation(api.organizations.create_organization, {
			description: "",
			name: "live-owner-org",
		});
		expect(beforeDeletion._nay).toBeUndefined();

		// When the Clerk cleanup fails, the Clerk session stays alive after the local deletion. So a
		// user doc marked as deleted can still arrive here with a valid identity.
		await t.run((ctx) => ctx.db.patch("users", userId, { deletedAt: Date.now() }));

		const result = await asUser.mutation(api.organizations.create_organization, {
			description: "",
			name: "deleted-owner-org",
		});

		expect(result._nay?.message).toBe("Unauthenticated");
		const organizations = await t.run((ctx) => ctx.db.query("organizations").collect());
		expect(organizations.some((organization) => organization.name === "deleted-owner-org")).toBe(false);
	});

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

		const { organization, workspace, roleAssignments, permissionGrants, userQuota, organizationQuota } = result._yay
			? await t.run(async (ctx) => {
					const [organization, workspace, roleAssignments, permissionGrants, userQuota, organizationQuota] =
						await Promise.all([
							ctx.db.get("organizations", result._yay!.organizationId),
							ctx.db.get("organizations_workspaces", result._yay!.defaultWorkspaceId),
							ctx.db
								.query("access_control_role_assignments")
								.withIndex("by_organization_workspace_user", (q) =>
									q
										.eq("organizationId", result._yay!.organizationId)
										.eq("workspaceId", result._yay!.defaultWorkspaceId),
								)
								.collect(),
							ctx.db
								.query("access_control_permission_grants")
								.withIndex("by_organization_workspace_resource_user_permission", (q) =>
									q.eq("organizationId", result._yay!.organizationId),
								)
								.collect(),
							organizations_test_read_user_extra_organization_quota_doc(ctx, { userId }),
							organizations_test_read_organization_extra_workspace_quota_doc(ctx, {
								organizationId: result._yay!.organizationId,
							}),
						]);

					return {
						organization,
						workspace,
						roleAssignments,
						permissionGrants,
						userQuota,
						organizationQuota,
					};
				})
			: {
					organization: null,
					workspace: null,
					roleAssignments: [],
					permissionGrants: [],
					userQuota: null,
					organizationQuota: null,
				};

		expect(organization?.name).toBe("acme-labs");
		expect(organization?.billingMode).toBe("user");
		expect(organization?.ownerUserId).toBe(userId);
		// The permissions of the system roles live in code, so creating an organization writes no role
		// assignment for the owner and no grant docs at all.
		expect(roleAssignments).toHaveLength(0);
		expect(permissionGrants).toHaveLength(0);
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
				userQuotas: userQuotas.filter((doc) => doc.userId === userId && doc.quotaName === "extra_organizations"),
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
				? await organizations_test_read_organization_extra_workspace_quota_doc(ctx, {
						organizationId: user.defaultOrganizationId,
					})
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
			const organization = user?.defaultOrganizationId
				? await ctx.db.get("organizations", user.defaultOrganizationId)
				: null;
			const workspace = user?.defaultWorkspaceId
				? await ctx.db.get("organizations_workspaces", user.defaultWorkspaceId)
				: null;
			const memberships = await ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_user_organization_workspace_active", (q) => q.eq("userId", userId))
				.collect();

			return {
				defaultPersonalMemberships: memberships.filter(
					(membership) =>
						membership.organizationId === user?.defaultOrganizationId &&
						membership.workspaceId === user?.defaultWorkspaceId,
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
					const [membership, roleAssignment, workspaceGrants, organizationQuota] = await Promise.all([
						ctx.db
							.query("organizations_workspaces_users")
							.withIndex("by_workspace_user_active", (q) =>
								q.eq("workspaceId", result._yay!.workspaceId).eq("userId", userId),
							)
							.first(),
						ctx.db
							.query("access_control_role_assignments")
							.withIndex("by_organization_workspace_user", (q) =>
								q
									.eq("organizationId", wsResult._yay!.organizationId)
									.eq("workspaceId", result._yay!.workspaceId)
									.eq("userId", userId),
							)
							.first(),
						ctx.db
							.query("access_control_permission_grants")
							.withIndex("by_organization_workspace_resource_user_permission", (q) =>
								q.eq("organizationId", wsResult._yay!.organizationId).eq("workspaceId", result._yay!.workspaceId),
							)
							.collect(),
						organizations_test_read_organization_extra_workspace_quota_doc(ctx, {
							organizationId: wsResult._yay!.organizationId,
						}),
					]);

					return {
						membership,
						roleAssignment,
						workspaceGrants,
						organizationQuota,
					};
				})
			: null;
		expect(membership?.membership).toBeTruthy();
		// No role assignment inside the new workspace. The creator's organization role already
		// works here, and always writing `member` would let someone whose role has only
		// `workspace.create` write files in the workspace they just made.
		expect(membership?.roleAssignment).toBeNull();
		expect(membership?.workspaceGrants).toHaveLength(0);
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
			const [memberships, notifications, roleAssignments, homeQuota, selectedQuota] = await Promise.all([
				ctx.db
					.query("organizations_workspaces_users")
					.withIndex("by_active_user_organization_workspace", (q) =>
						q.eq("active", true).eq("userId", invitedUserId).eq("organizationId", created._yay!.organizationId),
					)
					.collect(),
				ctx.db
					.query("notifications")
					.withIndex("by_user_archivedAt", (q) => q.eq("userId", invitedUserId).eq("archivedAt", 0))
					.collect(),
				ctx.db
					.query("access_control_role_assignments")
					.withIndex("by_organization_user_workspace", (q) =>
						q.eq("organizationId", created._yay!.organizationId).eq("userId", invitedUserId),
					)
					.collect(),
				quotas_db_get(ctx, {
					quotaName: "active_api_credentials",
					userId: invitedUserId,
					organizationId: created._yay!.organizationId,
					workspaceId: created._yay!.defaultWorkspaceId,
				}),
				quotas_db_get(ctx, {
					quotaName: "active_api_credentials",
					userId: invitedUserId,
					organizationId: created._yay!.organizationId,
					workspaceId: selectedWorkspace._yay!.workspaceId,
				}),
			]);

			return { memberships, notifications, roleAssignments, homeQuota, selectedQuota };
		});

		expect(afterInvite.memberships.map((membership) => membership.workspaceId).sort()).toEqual(
			[created._yay!.defaultWorkspaceId, selectedWorkspace._yay!.workspaceId].sort(),
		);
		// One role assignment, on the default workspace. That is the organization role, and it
		// already works in every workspace where the invited user is an active member.
		expect(afterInvite.roleAssignments.map((assignment) => assignment.workspaceId)).toEqual([
			created._yay!.defaultWorkspaceId,
		]);
		expect([afterInvite.homeQuota, afterInvite.selectedQuota]).toMatchObject([
			{ quotaName: "active_api_credentials", usedCount: 0 },
			{ quotaName: "active_api_credentials", usedCount: 0 },
		]);
		expect(afterInvite.notifications).toHaveLength(1);
		expect(afterInvite.notifications[0]?.archivedAt).toBe(0);
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
					.withIndex("by_organization_user_workspace", (q) =>
						q.eq("organizationId", created._yay!.organizationId).eq("userId", invitedUserId),
					)
					.collect(),
				ctx.db
					.query("notifications")
					.withIndex("by_organization_user_archivedAt", (q) =>
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
					.withIndex("by_organization_user_archivedAt", (q) =>
						q.eq("organizationId", created._yay!.organizationId).eq("userId", invitedUserId).eq("archivedAt", 0),
					)
					.first(),
			]);

			return { membership, notification };
		});

		expect(afterInvite.membership).not.toBeNull();
		expect(afterInvite.notification?.actorUserId).toBe(adminId);
	});

	test("inviting the owner to a workspace leaves them without an assignment", async () => {
		const t = test_convex();
		const [ownerId, adminId] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", { clerkUserId: "clerk-user-owner-invite-owner" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-owner-invite-admin" }),
			]),
		);
		await organizations_test_bootstrap_users(t, { userIds: [ownerId, adminId] });

		const created = await t.run((ctx) =>
			organizations_db_create(ctx, {
				userId: ownerId,
				description: "",
				name: "owner-invite-team",
				now: Date.now(),
			}),
		);
		expect(created._yay).toBeTruthy();

		// A workspace created by the admin, which the owner is not a member of.
		// `organizations_db_create` makes only the creator a member, so the owner stays outside.
		const sideWorkspaceId = await t.run(async (ctx) => {
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

			const workspace = await organizations_db_create_workspace(ctx, {
				userId: adminId,
				organizationId: created._yay!.organizationId,
				name: "owner-invite-side",
				description: "",
				now,
			});
			if (workspace._nay) {
				throw new Error(workspace._nay.message);
			}
			return workspace._yay.workspaceId;
		});

		const admin = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: adminId,
			name: "Admin",
			email: "owner-invite-admin@test.local",
		});

		const result = await admin.mutation(api.organizations.invite_user_to_organization_workspace, {
			organizationId: created._yay!.organizationId,
			workspaceId: sideWorkspaceId,
			userIdToAdd: ownerId,
		});
		expect(result._nay).toBeUndefined();

		// The owner has no role assignment anywhere, whatever the invite did with memberships.
		const assignments = await t.run((ctx) =>
			ctx.db
				.query("access_control_role_assignments")
				.withIndex("by_organization_user_workspace", (q) =>
					q.eq("organizationId", created._yay!.organizationId).eq("userId", ownerId),
				)
				.collect(),
		);
		expect(assignments).toHaveLength(0);
	});

	test("rejects an invite that would activate a role stronger than the inviter's", async () => {
		const t = test_convex();
		const [ownerId, managerId, invitedUserId] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", { clerkUserId: "clerk-user-invite-activation-owner" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-invite-activation-manager" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-invite-activation-invitee" }),
			]),
		);
		await organizations_test_bootstrap_users(t, { userIds: [ownerId, managerId, invitedUserId] });

		const created = await t.run((ctx) =>
			organizations_db_create(ctx, {
				userId: ownerId,
				description: "",
				name: "invite-activate",
				now: Date.now(),
			}),
		);
		expect(created._yay).toBeTruthy();

		const { sideWorkspaceId, managerRoleId } = await t.run(async (ctx) => {
			const now = Date.now();

			// This role covers everything the invited `member` role gets, so the invite below cannot be
			// refused because of the role it hands out. Any refusal must come from what the invited
			// user already has.
			const managerRoleId = await ctx.db.insert("access_control_roles", {
				organizationId: created._yay!.organizationId,
				name: "People ops",
				normalizedName: "people ops",
				description: "",
				permissions: [
					"organization.members.manage",
					"workspace.create",
					"workspace.update",
					"content.read",
					"content.write",
				],
				createdBy: ownerId,
				createdAt: now,
				updatedAt: now,
			});

			// The invited user's organization role can manage plugins. The inviter's role cannot.
			const operatorRoleId = await ctx.db.insert("access_control_roles", {
				organizationId: created._yay!.organizationId,
				name: "Plugin operator",
				normalizedName: "plugin operator",
				description: "",
				permissions: ["content.read", "workspace.plugins.manage"],
				createdBy: ownerId,
				createdAt: now,
				updatedAt: now,
			});

			for (const [userId, role] of [
				[managerId, managerRoleId],
				[invitedUserId, operatorRoleId],
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

			const workspace = await organizations_db_create_workspace(ctx, {
				userId: managerId,
				organizationId: created._yay!.organizationId,
				name: "invite-act-side",
				description: "",
				now,
			});
			if (workspace._nay) {
				throw new Error(workspace._nay.message);
			}
			await test_mocks_cancel_pending_home_file_seeds(ctx);
			return { sideWorkspaceId: workspace._yay.workspaceId, managerRoleId };
		});

		const manager = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: managerId,
			name: "Manager",
			email: "invite-activation-manager@test.local",
		});

		// A workspace-scoped permission works only where its holder is a member. So the membership this
		// invite would write is exactly what turns "Manage plugins" on for the invited user in the side
		// workspace — a power the inviter cannot give with `set_user_role`.
		const blocked = await manager.mutation(api.organizations.invite_user_to_organization_workspace, {
			organizationId: created._yay!.organizationId,
			workspaceId: sideWorkspaceId,
			userIdToAdd: invitedUserId,
		});
		expect(blocked._nay?.message).toBe('You cannot invite this member, because their role grants "Manage plugins"');

		const noMembership = await t.run((ctx) =>
			ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_active_user_organization_workspace", (q) =>
					q
						.eq("active", true)
						.eq("userId", invitedUserId)
						.eq("organizationId", created._yay!.organizationId)
						.eq("workspaceId", sideWorkspaceId),
				)
				.first(),
		);
		expect(noMembership).toBeNull();

		// Give the inviter the same permission, then send the same invite again. It now succeeds, which
		// proves the refusal came from this rule and not from something else.
		await t.run(async (ctx) => {
			const role = await ctx.db.get("access_control_roles", managerRoleId);
			await ctx.db.patch("access_control_roles", managerRoleId, {
				permissions: [...role!.permissions, "workspace.plugins.manage"],
			});
			await ctx.runMutation(components.rate_limiter.lib.resetRateLimit, {
				name: "organizations_write",
				key: managerId,
			});
		});

		const allowed = await manager.mutation(api.organizations.invite_user_to_organization_workspace, {
			organizationId: created._yay!.organizationId,
			workspaceId: sideWorkspaceId,
			userIdToAdd: invitedUserId,
		});
		expect(allowed._nay).toBeUndefined();
	});

	test("lets a member manager invite the owner into a side workspace", async () => {
		const t = test_convex();
		const [ownerId, managerId] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", { clerkUserId: "clerk-user-invite-owner-owner" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-invite-owner-manager" }),
			]),
		);
		await organizations_test_bootstrap_users(t, { userIds: [ownerId, managerId] });

		const created = await t.run((ctx) =>
			organizations_db_create(ctx, {
				userId: ownerId,
				description: "",
				name: "invite-owner",
				now: Date.now(),
			}),
		);
		expect(created._yay).toBeTruthy();

		const sideWorkspaceId = await t.run(async (ctx) => {
			const now = Date.now();
			const managerRoleId = await ctx.db.insert("access_control_roles", {
				organizationId: created._yay!.organizationId,
				name: "People ops",
				normalizedName: "people ops",
				description: "",
				permissions: [
					"organization.members.manage",
					"workspace.create",
					"workspace.update",
					"content.read",
					"content.write",
				],
				createdBy: ownerId,
				createdAt: now,
				updatedAt: now,
			});
			await ctx.db.insert("organizations_workspaces_users", {
				organizationId: created._yay!.organizationId,
				workspaceId: created._yay!.defaultWorkspaceId,
				userId: managerId,
				active: true,
				updatedAt: now,
			});
			await access_control_db_ensure_role_assignment(ctx, {
				organizationId: created._yay!.organizationId,
				workspaceId: created._yay!.defaultWorkspaceId,
				userId: managerId,
				role: managerRoleId,
				now,
			});

			const workspace = await organizations_db_create_workspace(ctx, {
				userId: managerId,
				organizationId: created._yay!.organizationId,
				name: "invite-own-side",
				description: "",
				now,
			});
			if (workspace._nay) {
				throw new Error(workspace._nay.message);
			}
			await test_mocks_cancel_pending_home_file_seeds(ctx);
			return workspace._yay.workspaceId;
		});

		const manager = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: managerId,
			name: "Manager",
			email: "invite-owner-manager@test.local",
		});

		// The permission check answers `"all"` for the owner, which is more than this inviter has. If we
		// compared the two sets, we would refuse every invite of the owner into a workspace they are not
		// already in. There is nothing to protect here: the owner passes every check by being the owner,
		// with or without a membership. This test locks in that we skip the comparison for an owner.
		const invited = await manager.mutation(api.organizations.invite_user_to_organization_workspace, {
			organizationId: created._yay!.organizationId,
			workspaceId: sideWorkspaceId,
			userIdToAdd: ownerId,
		});
		expect(invited._nay).toBeUndefined();

		const membership = await t.run((ctx) =>
			ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_active_user_organization_workspace", (q) =>
					q
						.eq("active", true)
						.eq("userId", ownerId)
						.eq("organizationId", created._yay!.organizationId)
						.eq("workspaceId", sideWorkspaceId),
				)
				.first(),
		);
		expect(membership).not.toBeNull();
	});

	test("rejects an invite from a role that cannot hand out what member grants", async () => {
		const t = test_convex();
		const [ownerId, managerId, invitedUserId] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", { clerkUserId: "clerk-user-invite-ceiling-owner" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-invite-ceiling-manager" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-invite-ceiling-invitee" }),
			]),
		);
		await organizations_test_bootstrap_users(t, { userIds: [ownerId, managerId, invitedUserId] });

		const created = await t.run((ctx) =>
			organizations_db_create(ctx, {
				userId: ownerId,
				description: "",
				name: "invite-ceiling-team",
				now: Date.now(),
			}),
		);
		expect(created._yay).toBeTruthy();

		// This role can manage members and nothing else. Every invite writes the `member` role, which
		// gives more than this role has, so the invite must be refused. Otherwise its holder could
		// invite an account of their own and give it the read and write access they do not have.
		await t.run(async (ctx) => {
			const now = Date.now();
			const roleId = await ctx.db.insert("access_control_roles", {
				organizationId: created._yay!.organizationId,
				name: "People ops",
				normalizedName: "people ops",
				description: "",
				permissions: ["organization.members.manage"],
				createdBy: ownerId,
				createdAt: now,
				updatedAt: now,
			});
			await ctx.db.insert("organizations_workspaces_users", {
				organizationId: created._yay!.organizationId,
				workspaceId: created._yay!.defaultWorkspaceId,
				userId: managerId,
				active: true,
				updatedAt: now,
			});
			await access_control_db_ensure_role_assignment(ctx, {
				organizationId: created._yay!.organizationId,
				workspaceId: created._yay!.defaultWorkspaceId,
				userId: managerId,
				role: roleId,
				now,
			});
		});

		const manager = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: managerId,
			name: "Manager",
			email: "invite-ceiling-manager@test.local",
		});

		const result = await manager.mutation(api.organizations.invite_user_to_organization_workspace, {
			organizationId: created._yay!.organizationId,
			workspaceId: created._yay!.defaultWorkspaceId,
			userIdToAdd: invitedUserId,
		});
		expect(result._nay?.message).toBe(
			'You cannot invite someone as Member, because that role grants "Create workspace"',
		);

		const membership = await t.run((ctx) =>
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
		);
		expect(membership).toBeNull();
	});

	test("lets a limited manager send invites that hand out no role", async () => {
		const t = test_convex();
		const [ownerId, managerId, existingMemberId, assignedUserId] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", { clerkUserId: "clerk-user-invite-noop-owner" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-invite-noop-manager" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-invite-noop-existing" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-invite-noop-assigned" }),
			]),
		);
		await organizations_test_bootstrap_users(t, { userIds: [ownerId, managerId, existingMemberId, assignedUserId] });

		const created = await t.run((ctx) =>
			organizations_db_create(ctx, {
				userId: ownerId,
				description: "",
				name: "invite-noop-team",
				now: Date.now(),
			}),
		);
		expect(created._yay).toBeTruthy();

		// The caller's role can manage members and nothing else, so it could never hand out what
		// `member` grants. Both invites below write no role at all, so they must not be refused for it.
		const sideWorkspaceId = await t.run(async (ctx) => {
			const now = Date.now();
			const managerRoleId = await ctx.db.insert("access_control_roles", {
				organizationId: created._yay!.organizationId,
				name: "People ops",
				normalizedName: "people ops",
				description: "",
				permissions: ["organization.members.manage"],
				createdBy: ownerId,
				createdAt: now,
				updatedAt: now,
			});

			// The invited user's existing organization role carries no workspace-scoped permission, so
			// the invite raises nothing the other invite ceilings would weigh.
			const assignedRoleId = await ctx.db.insert("access_control_roles", {
				organizationId: created._yay!.organizationId,
				name: "People ops junior",
				normalizedName: "people ops junior",
				description: "",
				permissions: ["organization.members.manage"],
				createdBy: ownerId,
				createdAt: now,
				updatedAt: now,
			});

			for (const [userId, role] of [
				[managerId, managerRoleId],
				[existingMemberId, null],
				[assignedUserId, assignedRoleId],
			] as const) {
				await ctx.db.insert("organizations_workspaces_users", {
					organizationId: created._yay!.organizationId,
					workspaceId: created._yay!.defaultWorkspaceId,
					userId,
					active: true,
					updatedAt: now,
				});
				if (role) {
					await access_control_db_ensure_role_assignment(ctx, {
						organizationId: created._yay!.organizationId,
						workspaceId: created._yay!.defaultWorkspaceId,
						userId,
						role,
						now,
					});
				}
			}

			const workspace = await organizations_db_create_workspace(ctx, {
				userId: ownerId,
				organizationId: created._yay!.organizationId,
				name: "invite-noop-side",
				description: "",
				now,
			});
			if (workspace._nay) {
				throw new Error(workspace._nay.message);
			}
			await test_mocks_cancel_pending_home_file_seeds(ctx);
			return { sideWorkspaceId: workspace._yay.workspaceId, assignedRoleId };
		});

		const manager = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: managerId,
			name: "Manager",
			email: "invite-noop-manager@test.local",
		});

		// Already in the requested workspace: the handler answers yes and writes nothing, so there is
		// no role to weigh against the caller.
		const repeatInvite = await manager.mutation(api.organizations.invite_user_to_organization_workspace, {
			organizationId: created._yay!.organizationId,
			workspaceId: created._yay!.defaultWorkspaceId,
			userIdToAdd: existingMemberId,
		});
		expect(repeatInvite._nay).toBeUndefined();

		const existingMemberAssignment = await t.run((ctx) =>
			ctx.db
				.query("access_control_role_assignments")
				.withIndex("by_organization_workspace_user", (q) =>
					q
						.eq("organizationId", created._yay!.organizationId)
						.eq("workspaceId", created._yay!.defaultWorkspaceId)
						.eq("userId", existingMemberId),
				)
				.first(),
		);
		expect(existingMemberAssignment).toBeNull();

		await t.run(async (ctx) => {
			await ctx.runMutation(components.rate_limiter.lib.resetRateLimit, {
				name: "organizations_write",
				key: managerId,
			});
		});

		// Already holding a role: this invite keeps it, so `member` is never handed out and the caller
		// does not need to hold what `member` grants.
		const sideInvite = await manager.mutation(api.organizations.invite_user_to_organization_workspace, {
			organizationId: created._yay!.organizationId,
			workspaceId: sideWorkspaceId.sideWorkspaceId,
			userIdToAdd: assignedUserId,
		});
		expect(sideInvite._nay).toBeUndefined();

		const afterSideInvite = await t.run(async (ctx) => {
			const [membership, assignment] = await Promise.all([
				ctx.db
					.query("organizations_workspaces_users")
					.withIndex("by_active_user_organization_workspace", (q) =>
						q
							.eq("active", true)
							.eq("userId", assignedUserId)
							.eq("organizationId", created._yay!.organizationId)
							.eq("workspaceId", sideWorkspaceId.sideWorkspaceId),
					)
					.first(),
				ctx.db
					.query("access_control_role_assignments")
					.withIndex("by_organization_workspace_user", (q) =>
						q
							.eq("organizationId", created._yay!.organizationId)
							.eq("workspaceId", created._yay!.defaultWorkspaceId)
							.eq("userId", assignedUserId),
					)
					.first(),
			]);
			return { membership, assignment };
		});
		expect(afterSideInvite.membership).not.toBeNull();
		expect(afterSideInvite.assignment?.role).toBe(sideWorkspaceId.assignedRoleId);
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

	test("does not reveal whether an email is registered to a caller outside the organization", async () => {
		const t = test_convex();
		const [ownerId, outsiderId, registeredUserId] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", { clerkUserId: "clerk-user-invite-oracle-owner" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-invite-oracle-outsider" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-invite-oracle-registered" }),
			]),
		);
		await organizations_test_bootstrap_users(t, { userIds: [ownerId, outsiderId, registeredUserId] });

		const created = await t.run((ctx) =>
			organizations_db_create(ctx, {
				userId: ownerId,
				description: "",
				name: "invite-oracle-team",
				default: false,
				now: Date.now(),
			}),
		);
		expect(created._yay).toBeTruthy();

		await t.run((ctx) =>
			ctx.db.insert("users_anagraphics", {
				userId: registeredUserId,
				displayName: "Registered User",
				email: "invite-oracle-registered@test.local",
				updatedAt: Date.now(),
			}),
		);

		const outsider = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: outsiderId,
			name: "Outsider",
			email: "invite-oracle-outsider@test.local",
		});

		// The error must be the same whether the address has an account or not. Anyone can create an
		// identity, so a different answer for a known address would let anyone test email addresses.
		const registered = await outsider.mutation(api.organizations.invite_user_to_organization_workspace, {
			organizationId: created._yay!.organizationId,
			workspaceId: created._yay!.defaultWorkspaceId,
			email: "invite-oracle-registered@test.local",
		});
		const unknown = await outsider.mutation(api.organizations.invite_user_to_organization_workspace, {
			organizationId: created._yay!.organizationId,
			workspaceId: created._yay!.defaultWorkspaceId,
			email: "invite-oracle-nobody@test.local",
		});

		expect(registered._nay?.message).toBe("Not found");
		expect(unknown._nay?.message).toBe(registered._nay?.message);
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

	test("revokes only the removed member's credentials and drains service grants in bounded passes", async () => {
		const t = test_convex();
		const [ownerId, memberId, otherMemberId] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", { clerkUserId: "clerk-user-revoke-keys-owner" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-revoke-keys-member" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-revoke-keys-other-member" }),
			]),
		);
		await organizations_test_bootstrap_users(t, { userIds: [ownerId, memberId, otherMemberId] });

		const owner = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: ownerId,
			name: "Owner",
			email: "revoke-keys-owner@test.local",
		});
		const organization = await t.run((ctx) =>
			organizations_db_create(ctx, {
				userId: ownerId,
				description: "",
				name: "revoke-keys-team",
				now: Date.now(),
			}),
		);
		expect(organization._yay).toBeTruthy();
		const workspace = await t.run((ctx) =>
			organizations_db_create_workspace(ctx, {
				userId: ownerId,
				description: "",
				organizationId: organization._yay!.organizationId,
				name: "revoke-keys-project",
				now: Date.now(),
			}),
		);
		expect(workspace._yay).toBeTruthy();
		const otherOrganization = await t.run((ctx) =>
			organizations_db_create(ctx, {
				userId: ownerId,
				description: "",
				name: "kept-keys-team",
				now: Date.now(),
			}),
		);
		expect(otherOrganization._yay).toBeTruthy();

		const alreadyRevokedAt = 123;
		const seededAccess = await t.run(async (ctx) => {
			const now = Date.now();
			await Promise.all([
				ctx.db.insert("organizations_workspaces_users", {
					organizationId: organization._yay!.organizationId,
					workspaceId: organization._yay!.defaultWorkspaceId,
					userId: memberId,
					active: true,
				}),
				ctx.db.insert("organizations_workspaces_users", {
					organizationId: organization._yay!.organizationId,
					workspaceId: workspace._yay!.workspaceId,
					userId: memberId,
					active: true,
				}),
				ctx.db.insert("organizations_workspaces_users", {
					organizationId: organization._yay!.organizationId,
					workspaceId: organization._yay!.defaultWorkspaceId,
					userId: otherMemberId,
					active: true,
				}),
				ctx.db.insert("organizations_workspaces_users", {
					organizationId: otherOrganization._yay!.organizationId,
					workspaceId: otherOrganization._yay!.defaultWorkspaceId,
					userId: memberId,
					active: true,
				}),
				quotas_db_ensure(ctx, {
					quotaName: "active_api_credentials",
					userId: memberId,
					organizationId: organization._yay!.organizationId,
					workspaceId: organization._yay!.defaultWorkspaceId,
					now,
				}),
				quotas_db_ensure(ctx, {
					quotaName: "active_api_credentials",
					userId: memberId,
					organizationId: organization._yay!.organizationId,
					workspaceId: workspace._yay!.workspaceId,
					now,
				}),
				quotas_db_ensure(ctx, {
					quotaName: "active_api_credentials",
					userId: otherMemberId,
					organizationId: organization._yay!.organizationId,
					workspaceId: organization._yay!.defaultWorkspaceId,
					now,
				}),
				quotas_db_ensure(ctx, {
					quotaName: "active_api_credentials",
					userId: memberId,
					organizationId: otherOrganization._yay!.organizationId,
					workspaceId: otherOrganization._yay!.defaultWorkspaceId,
					now,
				}),
			]);

			const [memberHome, memberProject, memberAlreadyRevoked, otherMember, otherOrganizationCredential] =
				await Promise.all([
					organizations_test_seed_api_credential(ctx, {
						organizationId: organization._yay!.organizationId,
						workspaceId: organization._yay!.defaultWorkspaceId,
						userId: memberId,
						tag: "1",
					}),
					organizations_test_seed_api_credential(ctx, {
						organizationId: organization._yay!.organizationId,
						workspaceId: workspace._yay!.workspaceId,
						userId: memberId,
						tag: "2",
					}),
					organizations_test_seed_api_credential(ctx, {
						organizationId: organization._yay!.organizationId,
						workspaceId: organization._yay!.defaultWorkspaceId,
						userId: memberId,
						tag: "3",
						revokedAt: alreadyRevokedAt,
					}),
					organizations_test_seed_api_credential(ctx, {
						organizationId: organization._yay!.organizationId,
						workspaceId: organization._yay!.defaultWorkspaceId,
						userId: otherMemberId,
						tag: "4",
					}),
					organizations_test_seed_api_credential(ctx, {
						organizationId: otherOrganization._yay!.organizationId,
						workspaceId: otherOrganization._yay!.defaultWorkspaceId,
						userId: memberId,
						tag: "5",
					}),
				]);

			const pluginVersionId = await ctx.db.insert("plugins_versions", {
				name: "removal-test",
				displayName: "Removal test",
				version: "0.1.0",
				description: "Membership-removal token fixture",
				reviewStatus: "passed",
				reviewId: null,
				isLatest: true,
				artifactHash: `sha256:${"a".repeat(64)}`,
				sourceRepositoryUrl: "https://github.com/bonobo/removal-test-plugin",
				sourceOwner: "bonobo",
				sourceRepo: "removal-test-plugin",
				sourceCommitSha: "1234567890abcdef1234567890abcdef12345678",
				manifestR2Key: "plugins/removal-test/manifest.json",
				backendEntrypointFile: null,
				configuration: null,
				events: [],
				pages: [],
				fileViews: [],
				capabilities: [],
				outboundOrigins: [],
				uiOutboundOrigins: [],
				files: [],
				sourceStatus: "ready",
				sourceLastError: null,
				createdBy: ownerId,
				updatedAt: now,
			});
			const [removedInstallationId, projectInstallationId, keptInstallationId] = await Promise.all([
				ctx.db.insert("plugins_workspace_installations", {
					organizationId: organization._yay!.organizationId,
					workspaceId: organization._yay!.defaultWorkspaceId,
					pluginVersionId,
					pluginName: "removal-test",
					status: "enabled",
					configurationYaml: null,
					acceptedCapabilities: [],
					capabilitiesAcceptedAt: now,
					acceptedOutboundOrigins: [],
					acceptedUiOutboundOrigins: [],
					outboundOriginsAcceptedAt: now,
					installedBy: ownerId,
					updatedBy: ownerId,
					updatedAt: now,
				}),
				ctx.db.insert("plugins_workspace_installations", {
					organizationId: organization._yay!.organizationId,
					workspaceId: workspace._yay!.workspaceId,
					pluginVersionId,
					pluginName: "removal-test",
					status: "enabled",
					configurationYaml: null,
					acceptedCapabilities: [],
					capabilitiesAcceptedAt: now,
					acceptedOutboundOrigins: [],
					acceptedUiOutboundOrigins: [],
					outboundOriginsAcceptedAt: now,
					installedBy: ownerId,
					updatedBy: ownerId,
					updatedAt: now,
				}),
				ctx.db.insert("plugins_workspace_installations", {
					organizationId: otherOrganization._yay!.organizationId,
					workspaceId: otherOrganization._yay!.defaultWorkspaceId,
					pluginVersionId,
					pluginName: "removal-test",
					status: "enabled",
					configurationYaml: null,
					acceptedCapabilities: [],
					capabilitiesAcceptedAt: now,
					acceptedOutboundOrigins: [],
					acceptedUiOutboundOrigins: [],
					outboundOriginsAcceptedAt: now,
					installedBy: ownerId,
					updatedBy: ownerId,
					updatedAt: now,
				}),
			]);
			const [removedGrantId, keptGrantId, removedSessionId, keptSessionId, removedServiceGrantId, keptServiceGrantId] =
				await Promise.all([
					ctx.db.insert("public_api_grants", {
						organizationId: organization._yay!.organizationId,
						workspaceId: workspace._yay!.workspaceId,
						userId: memberId,
						threadId: null,
						principalKey: "removal-test-target",
						tokenHash: "1".repeat(64),
						scopes: ["files:list"],
						pathPrefix: null,
						createdAt: now,
						expiresAt: now + 10 * 60 * 1000,
					}),
					ctx.db.insert("public_api_grants", {
						organizationId: otherOrganization._yay!.organizationId,
						workspaceId: otherOrganization._yay!.defaultWorkspaceId,
						userId: memberId,
						threadId: null,
						principalKey: "removal-test-control",
						tokenHash: "2".repeat(64),
						scopes: ["files:list"],
						pathPrefix: null,
						createdAt: now,
						expiresAt: now + 10 * 60 * 1000,
					}),
					ctx.db.insert("plugins_ui_sessions", {
						organizationId: organization._yay!.organizationId,
						workspaceId: organization._yay!.defaultWorkspaceId,
						installationId: removedInstallationId,
						pluginVersionId,
						userId: memberId,
						tokenHash: "3".repeat(64),
						createdAt: now,
						expiresAt: now + 10 * 60 * 1000,
					}),
					ctx.db.insert("plugins_ui_sessions", {
						organizationId: otherOrganization._yay!.organizationId,
						workspaceId: otherOrganization._yay!.defaultWorkspaceId,
						installationId: keptInstallationId,
						pluginVersionId,
						userId: memberId,
						tokenHash: "4".repeat(64),
						createdAt: now,
						expiresAt: now + 10 * 60 * 1000,
					}),
					ctx.db.insert("plugin_service_grants", {
						organizationId: organization._yay!.organizationId,
						workspaceId: organization._yay!.defaultWorkspaceId,
						installationId: removedInstallationId,
						pluginVersionId,
						pluginName: "media",
						actorUserId: memberId,
						tokenHash: "5".repeat(64),
						scopes: ["plugin_data:read"],
						principalKey: "removal-test-service-target",
						phase: "interactive",
						destinationPathPrefix: null,
						expiresAt: now + 24 * 60 * 60 * 1000,
						updatedAt: now,
					}),
					ctx.db.insert("plugin_service_grants", {
						organizationId: otherOrganization._yay!.organizationId,
						workspaceId: otherOrganization._yay!.defaultWorkspaceId,
						installationId: keptInstallationId,
						pluginVersionId,
						pluginName: "media",
						actorUserId: memberId,
						tokenHash: "6".repeat(64),
						scopes: ["plugin_data:read"],
						principalKey: "removal-test-service-control",
						phase: "interactive",
						destinationPathPrefix: null,
						expiresAt: now + 24 * 60 * 60 * 1000,
						updatedAt: now,
					}),
				]);
			for (let index = 0; index < 100; index += 1) {
				const inProjectWorkspace = index % 2 === 0;
				await ctx.db.insert("plugin_service_grants", {
					organizationId: organization._yay!.organizationId,
					workspaceId: inProjectWorkspace ? workspace._yay!.workspaceId : organization._yay!.defaultWorkspaceId,
					installationId: inProjectWorkspace ? projectInstallationId : removedInstallationId,
					pluginVersionId,
					pluginName: "media",
					actorUserId: memberId,
					tokenHash: (index + 10).toString(16).padStart(64, "0"),
					scopes: ["plugin_data:read"],
					principalKey: `removal-test-service-batch-${index}`,
					phase: "interactive",
					destinationPathPrefix: null,
					expiresAt: now + 24 * 60 * 60 * 1000,
					updatedAt: now,
				});
			}

			const [
				removedHomeMemberUsageId,
				removedProjectMemberUsageId,
				keptOtherOrganizationMemberUsageId,
				keptOtherMemberUsageId,
			] = await Promise.all([
				ctx.db.insert("plugins_data_member_usage", {
					organizationId: organization._yay!.organizationId,
					workspaceId: organization._yay!.defaultWorkspaceId,
					installationId: removedInstallationId,
					userId: memberId,
					usedBytes: 40,
					usedDocuments: 2,
					machineBytes: 0,
					collectionNames: ["messages"],
				}),
				ctx.db.insert("plugins_data_member_usage", {
					organizationId: organization._yay!.organizationId,
					workspaceId: workspace._yay!.workspaceId,
					installationId: projectInstallationId,
					userId: memberId,
					usedBytes: 24,
					usedDocuments: 1,
					machineBytes: 0,
					collectionNames: ["messages"],
				}),
				ctx.db.insert("plugins_data_member_usage", {
					organizationId: otherOrganization._yay!.organizationId,
					workspaceId: otherOrganization._yay!.defaultWorkspaceId,
					installationId: keptInstallationId,
					userId: memberId,
					usedBytes: 24,
					usedDocuments: 1,
					machineBytes: 0,
					collectionNames: ["messages"],
				}),
				ctx.db.insert("plugins_data_member_usage", {
					organizationId: organization._yay!.organizationId,
					workspaceId: organization._yay!.defaultWorkspaceId,
					installationId: removedInstallationId,
					userId: otherMemberId,
					usedBytes: 24,
					usedDocuments: 1,
					machineBytes: 0,
					collectionNames: ["messages"],
				}),
			]);

			return {
				memberHome,
				memberProject,
				memberAlreadyRevoked,
				otherMember,
				otherOrganizationCredential,
				removedGrantId,
				keptGrantId,
				removedSessionId,
				keptSessionId,
				removedServiceGrantId,
				keptServiceGrantId,
				removedHomeMemberUsageId,
				removedProjectMemberUsageId,
				keptOtherOrganizationMemberUsageId,
				keptOtherMemberUsageId,
			};
		});

		const removeResult = await owner.mutation(api.organizations.remove_user_from_organization, {
			organizationId: organization._yay!.organizationId,
			userIdToRemove: memberId,
		});
		expect(removeResult._yay).toBeNull();
		const retryRemoveResult = await owner.mutation(api.organizations.remove_user_from_organization, {
			organizationId: organization._yay!.organizationId,
			userIdToRemove: memberId,
		});
		expect(retryRemoveResult._yay).toBeNull();

		const afterRemove = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.get("api_credentials", seededAccess.memberHome),
				ctx.db.get("api_credentials", seededAccess.memberProject),
				ctx.db.get("api_credentials", seededAccess.memberAlreadyRevoked),
				ctx.db.get("api_credentials", seededAccess.otherMember),
				ctx.db.get("api_credentials", seededAccess.otherOrganizationCredential),
				ctx.db.get("public_api_grants", seededAccess.removedGrantId),
				ctx.db.get("public_api_grants", seededAccess.keptGrantId),
				ctx.db.get("plugins_ui_sessions", seededAccess.removedSessionId),
				ctx.db.get("plugins_ui_sessions", seededAccess.keptSessionId),
				ctx.db.get("plugin_service_grants", seededAccess.removedServiceGrantId),
				ctx.db.get("plugin_service_grants", seededAccess.keptServiceGrantId),
			]),
		);
		expect(afterRemove[0]?.revokedAt).toEqual(expect.any(Number));
		expect(afterRemove[1]?.revokedAt).toBe(afterRemove[0]?.revokedAt);
		expect(afterRemove[2]?.revokedAt).toBe(alreadyRevokedAt);
		expect(afterRemove[3]?.revokedAt).toBeNull();
		expect(afterRemove[4]?.revokedAt).toBeNull();
		expect(afterRemove[5]).toBeNull();
		expect(afterRemove[6]?._id).toBe(seededAccess.keptGrantId);
		expect(afterRemove[7]).toBeNull();
		expect(afterRemove[8]?._id).toBe(seededAccess.keptSessionId);
		expect(afterRemove[10]?._id).toBe(seededAccess.keptServiceGrantId);

		const readServiceGrantDrainState = () =>
			t.run(async (ctx) => {
				const [memberships, homeGrants, projectGrants, jobs] = await Promise.all([
					ctx.db
						.query("organizations_workspaces_users")
						.withIndex("by_user_organization_workspace_active", (q) =>
							q.eq("userId", memberId).eq("organizationId", organization._yay!.organizationId),
						)
						.collect(),
					ctx.db
						.query("plugin_service_grants")
						.withIndex("by_organization_workspace_actorUser", (q) =>
							q
								.eq("organizationId", organization._yay!.organizationId)
								.eq("workspaceId", organization._yay!.defaultWorkspaceId)
								.eq("actorUserId", memberId),
						)
						.collect(),
					ctx.db
						.query("plugin_service_grants")
						.withIndex("by_organization_workspace_actorUser", (q) =>
							q
								.eq("organizationId", organization._yay!.organizationId)
								.eq("workspaceId", workspace._yay!.workspaceId)
								.eq("actorUserId", memberId),
						)
						.collect(),
					ctx.db.system.query("_scheduled_functions").collect(),
				]);
				const continuationJobs = jobs.filter(
					(job) => job.state.kind === "pending" && job.name.includes("continue_remove_user_from_organization"),
				);
				await Promise.all(continuationJobs.map((job) => ctx.scheduler.cancel(job._id)));
				return {
					memberships,
					serviceGrantCount: homeGrants.length + projectGrants.length,
					continuationCount: continuationJobs.length,
				};
			});

		const afterFirstBatch = await readServiceGrantDrainState();
		expect(afterFirstBatch.serviceGrantCount).toBe(1);
		expect(afterFirstBatch.continuationCount).toBe(2);
		expect(afterFirstBatch.memberships).toHaveLength(2);
		expect(
			afterFirstBatch.memberships.every(
				(membership) => membership.active === false && membership.pendingOrganizationRemoval === true,
			),
		).toBe(true);

		await t.run((ctx) =>
			ctx.runMutation(internal.organizations.continue_remove_user_from_organization, {
				organizationId: organization._yay!.organizationId,
				userId: memberId,
			}),
		);
		const afterSecondBatch = await readServiceGrantDrainState();
		expect(afterSecondBatch.serviceGrantCount).toBe(0);
		expect(afterSecondBatch.continuationCount).toBe(1);
		expect(afterSecondBatch.memberships).toHaveLength(2);
		expect(
			afterSecondBatch.memberships.every(
				(membership) => membership.active === false && membership.pendingOrganizationRemoval === true,
			),
		).toBe(true);

		await t.run((ctx) =>
			ctx.runMutation(internal.organizations.continue_remove_user_from_organization, {
				organizationId: organization._yay!.organizationId,
				userId: memberId,
			}),
		);
		const afterZeroPass = await readServiceGrantDrainState();
		expect(afterZeroPass.serviceGrantCount).toBe(0);
		expect(afterZeroPass.continuationCount).toBe(0);
		expect(afterZeroPass.memberships).toHaveLength(0);
		expect(await t.run((ctx) => ctx.db.get("plugin_service_grants", seededAccess.removedServiceGrantId))).toBeNull();

		// A plugin storage share names the member, so it must not outlive their membership. The member
		// was charged in both of this organization's workspaces, and removal takes every membership, so
		// a prune that covered only the workspace the caller named would leave the second row behind.
		const memberUsageAfterRemove = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.get("plugins_data_member_usage", seededAccess.removedHomeMemberUsageId),
				ctx.db.get("plugins_data_member_usage", seededAccess.removedProjectMemberUsageId),
				ctx.db.get("plugins_data_member_usage", seededAccess.keptOtherOrganizationMemberUsageId),
				ctx.db.get("plugins_data_member_usage", seededAccess.keptOtherMemberUsageId),
			]),
		);
		expect(memberUsageAfterRemove[0]).toBeNull();
		expect(memberUsageAfterRemove[1]).toBeNull();
		expect(memberUsageAfterRemove[2]?._id).toBe(seededAccess.keptOtherOrganizationMemberUsageId);
		expect(memberUsageAfterRemove[3]?._id).toBe(seededAccess.keptOtherMemberUsageId);
		const quotaDocsAfterRemove = await t.run((ctx) =>
			ctx.db
				.query("quotas")
				.withIndex("by_user_quotaName", (q) => q.eq("userId", memberId).eq("quotaName", "active_api_credentials"))
				.collect(),
		);
		expect(
			quotaDocsAfterRemove.filter((quotaDoc) => quotaDoc.organizationId === organization._yay!.organizationId),
		).toHaveLength(0);
		expect(
			quotaDocsAfterRemove.some((quotaDoc) => quotaDoc.organizationId === otherOrganization._yay!.organizationId),
		).toBe(true);

		await t.mutation(components.rate_limiter.lib.resetRateLimit, {
			name: "organizations_write",
			key: ownerId,
		});
		const reinviteResult = await owner.mutation(api.organizations.invite_user_to_organization_workspace, {
			organizationId: organization._yay!.organizationId,
			workspaceId: organization._yay!.defaultWorkspaceId,
			userIdToAdd: memberId,
		});
		expect(reinviteResult._yay).toBeNull();

		const afterReinvite = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.get("api_credentials", seededAccess.memberHome),
				ctx.db.get("api_credentials", seededAccess.memberProject),
				ctx.db.get("public_api_grants", seededAccess.removedGrantId),
				ctx.db.get("plugins_ui_sessions", seededAccess.removedSessionId),
				ctx.db.get("plugin_service_grants", seededAccess.removedServiceGrantId),
			]),
		);
		expect(afterReinvite[0]?.revokedAt).toBe(afterRemove[0]?.revokedAt);
		expect(afterReinvite[1]?.revokedAt).toBe(afterRemove[1]?.revokedAt);
		expect(afterReinvite[2]).toBeNull();
		expect(afterReinvite[3]).toBeNull();
		expect(afterReinvite[4]).toBeNull();
		const quotaDocsAfterReinvite = await t.run((ctx) =>
			ctx.db
				.query("quotas")
				.withIndex("by_user_quotaName", (q) => q.eq("userId", memberId).eq("quotaName", "active_api_credentials"))
				.collect(),
		);
		expect(quotaDocsAfterReinvite).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					organizationId: organization._yay!.organizationId,
					workspaceId: organization._yay!.defaultWorkspaceId,
					usedCount: 0,
				}),
				expect.objectContaining({
					organizationId: otherOrganization._yay!.organizationId,
					workspaceId: otherOrganization._yay!.defaultWorkspaceId,
				}),
			]),
		);
	});

	test("lets a member leave and resume their own bounded removal", async () => {
		const t = test_convex();
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		const [ownerId, memberId] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", { clerkUserId: "clerk-user-leave-owner" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-leave-member" }),
			]),
		);
		await organizations_test_bootstrap_users(t, { userIds: [ownerId, memberId] });
		await t.run(async (ctx) => await test_mocks_cancel_pending_home_file_seeds(ctx));

		const member = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: memberId,
			name: "Member",
			email: "leave-member@test.local",
		});
		const owner = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: ownerId,
			name: "Owner",
			email: "leave-owner@test.local",
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

		const seeded = await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert("organizations_workspaces_users", {
				organizationId: created._yay!.organizationId,
				workspaceId: created._yay!.defaultWorkspaceId,
				userId: memberId,
				active: true,
			});
			await quotas_db_ensure(ctx, {
				quotaName: "active_api_credentials",
				userId: memberId,
				organizationId: created._yay!.organizationId,
				workspaceId: created._yay!.defaultWorkspaceId,
				now,
			});
			await access_control_db_ensure_role_assignment(ctx, {
				organizationId: created._yay!.organizationId,
				workspaceId: created._yay!.defaultWorkspaceId,
				userId: memberId,
				role: "member",
				now,
			});

			const apiCredentialId = await organizations_test_seed_api_credential(ctx, {
				organizationId: created._yay!.organizationId,
				workspaceId: created._yay!.defaultWorkspaceId,
				userId: memberId,
				tag: "6",
			});

			const pluginVersionId = await ctx.db.insert("plugins_versions", {
				name: "organization-scope-cleanup",
				displayName: "Organization scope cleanup",
				version: "0.1.0",
				description: "Scope cleanup fixture",
				reviewStatus: "passed",
				reviewId: null,
				isLatest: true,
				artifactHash: `sha256:${"a".repeat(64)}`,
				sourceRepositoryUrl: "https://github.com/bonobo/organization-scope-cleanup",
				sourceOwner: "bonobo",
				sourceRepo: "organization-scope-cleanup",
				sourceCommitSha: "1234567890abcdef1234567890abcdef12345678",
				manifestR2Key: "plugins/organization-scope-cleanup/manifest.json",
				backendEntrypointFile: null,
				configuration: null,
				events: [],
				pages: [],
				fileViews: [],
				capabilities: [],
				outboundOrigins: [],
				uiOutboundOrigins: [],
				files: [],
				sourceStatus: "ready",
				sourceLastError: null,
				createdBy: ownerId,
				updatedAt: now,
			});
			const installationId = await ctx.db.insert("plugins_workspace_installations", {
				organizationId: created._yay!.organizationId,
				workspaceId: created._yay!.defaultWorkspaceId,
				pluginVersionId,
				pluginName: "organization-scope-cleanup",
				status: "enabled",
				configurationYaml: null,
				acceptedCapabilities: [],
				capabilitiesAcceptedAt: now,
				acceptedOutboundOrigins: [],
				acceptedUiOutboundOrigins: [],
				outboundOriginsAcceptedAt: now,
				installedBy: ownerId,
				updatedBy: ownerId,
				updatedAt: now,
			});
			for (const scopeId of ["sole", "shared"]) {
				await ctx.db.insert("plugins_data_scopes", {
					organizationId: created._yay!.organizationId,
					workspaceId: created._yay!.defaultWorkspaceId,
					installationId,
					scopeId,
					collection: "messages",
					keyPrefix: `${scopeId}/`,
					createdByUserId: memberId,
					createdAt: now,
					updatedAt: now,
				});
				await ctx.db.insert("access_control_permission_grants", {
					organizationId: created._yay!.organizationId,
					workspaceId: created._yay!.defaultWorkspaceId,
					resourceKind: "plugin_scope",
					resourceId: `${installationId}:${scopeId}`,
					principalKind: "user",
					userId: memberId,
					permission: "content.read",
					createdAt: now,
					updatedAt: now,
				});
			}
			await ctx.db.insert("access_control_permission_grants", {
				organizationId: created._yay!.organizationId,
				workspaceId: created._yay!.defaultWorkspaceId,
				resourceKind: "plugin_scope",
				resourceId: `${installationId}:shared`,
				principalKind: "user",
				userId: ownerId,
				permission: "content.read",
				createdAt: now,
				updatedAt: now,
			});
			for (let index = 0; index < 100; index += 1) {
				await ctx.db.insert("access_control_permission_grants", {
					organizationId: created._yay!.organizationId,
					workspaceId: created._yay!.defaultWorkspaceId,
					resourceKind: "file",
					resourceId: `departing-file-${String(index).padStart(3, "0")}`,
					principalKind: "user",
					userId: memberId,
					permission: "content.read",
					createdAt: now,
					updatedAt: now,
				});
			}

			return { apiCredentialId, installationId, membershipRevision: now };
		});
		await t.run(async (ctx) => await test_mocks_cancel_pending_home_file_seeds(ctx));

		const leaveResult = await member.mutation(api.organizations.remove_user_from_organization, {
			organizationId: created._yay!.organizationId,
			userIdToRemove: memberId,
		});
		expect(leaveResult._yay).toBeNull();

		const afterLeave = await t.run(async (ctx) => {
			const [memberships, inactiveMemberships, roleAssignments, directGrants, apiCredential] = await Promise.all([
				ctx.db
					.query("organizations_workspaces_users")
					.withIndex("by_active_user_organization_workspace", (q) =>
						q.eq("active", true).eq("userId", memberId).eq("organizationId", created._yay!.organizationId),
					)
					.collect(),
				ctx.db
					.query("organizations_workspaces_users")
					.withIndex("by_active_user_organization_workspace", (q) =>
						q.eq("active", false).eq("userId", memberId).eq("organizationId", created._yay!.organizationId),
					)
					.collect(),
				ctx.db
					.query("access_control_role_assignments")
					.withIndex("by_organization_user_workspace", (q) =>
						q.eq("organizationId", created._yay!.organizationId).eq("userId", memberId),
					)
					.collect(),
				ctx.db
					.query("access_control_permission_grants")
					.withIndex("by_organization_user_workspace_resource_permission", (q) =>
						q.eq("organizationId", created._yay!.organizationId).eq("userId", memberId),
					)
					.collect(),
				ctx.db.get("api_credentials", seeded.apiCredentialId),
			]);
			return { memberships, inactiveMemberships, roleAssignments, directGrants, apiCredential };
		});
		expect(afterLeave.memberships).toHaveLength(0);
		expect(afterLeave.inactiveMemberships).toHaveLength(1);
		expect(afterLeave.inactiveMemberships[0]?.pendingOrganizationRemoval).toBe(true);
		expect(afterLeave.roleAssignments).toHaveLength(0);
		expect(afterLeave.directGrants).toHaveLength(2);
		expect(afterLeave.apiCredential?.revokedAt).toEqual(expect.any(Number));

		// Lose the first one-shot continuation. A repeated self-leave must restart it from the durable marker.
		const cancelledJobs = await t.run(async (ctx) => {
			const jobs = await ctx.db.system.query("_scheduled_functions").collect();
			const pendingJobs = jobs.filter((job) => job.state.kind === "pending");
			await Promise.all(pendingJobs.map((job) => ctx.scheduler.cancel(job._id)));
			return pendingJobs.length;
		});
		expect(cancelledJobs).toBeGreaterThan(0);

		const retryLeave = await member.mutation(api.organizations.remove_user_from_organization, {
			organizationId: created._yay!.organizationId,
			userIdToRemove: memberId,
		});
		expect(retryLeave._yay).toBeNull();
		const countPendingRemovalJobs = () =>
			t.run(async (ctx) => {
				const jobs = await ctx.db.system.query("_scheduled_functions").collect();
				return jobs.filter(
					(job) => job.state.kind === "pending" && job.name.includes("continue_remove_user_from_organization"),
				).length;
			});
		expect(await countPendingRemovalJobs()).toBe(1);

		const rateLimitedRetry = await member.mutation(api.organizations.remove_user_from_organization, {
			organizationId: created._yay!.organizationId,
			userIdToRemove: memberId,
		});
		expect(rateLimitedRetry).toEqual({ _nay: { message: "Rate limit exceeded" } });
		expect(await countPendingRemovalJobs()).toBe(1);

		const reinviteWhileDraining = await owner.mutation(api.organizations.invite_user_to_organization_workspace, {
			organizationId: created._yay!.organizationId,
			workspaceId: created._yay!.defaultWorkspaceId,
			userIdToAdd: memberId,
		});
		expect(reinviteWhileDraining).toEqual({ _nay: { message: "Member removal is still running" } });

		// Drive the cleanup through the real producer's scheduled call. The sole scope is released;
		// the shared scope stays and promotes its remaining active member to manager.
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		const scopeState = await t.run(async (ctx) => ({
			memberships: await ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_user_organization_workspace_active", (q) =>
					q.eq("userId", memberId).eq("organizationId", created._yay!.organizationId),
				)
				.collect(),
			scopes: (await ctx.db.query("plugins_data_scopes").collect())
				.map((doc) => ({ scopeId: doc.scopeId, membershipRevision: doc.updatedAt }))
				.sort((left, right) => left.scopeId.localeCompare(right.scopeId)),
			fences: (await ctx.db.query("plugins_data_released_scope_ranges").collect()).map((doc) => doc.scopeId),
			grants: (await ctx.db.query("access_control_permission_grants").collect())
				.filter((grant) => grant.resourceId.startsWith(`${seeded.installationId}:`))
				.map((grant) => ({ resourceId: grant.resourceId, userId: grant.userId, permission: grant.permission }))
				.sort((left, right) => left.permission.localeCompare(right.permission)),
		}));
		expect(scopeState.memberships).toHaveLength(0);
		expect(scopeState.scopes).toEqual([{ scopeId: "shared", membershipRevision: seeded.membershipRevision + 1 }]);
		expect(scopeState.fences).toEqual(["sole", "sole"]);
		expect(scopeState.grants).toEqual(
			["content.permissions.manage", "content.read", "content.write"].map((permission) => ({
				resourceId: `${seeded.installationId}:shared`,
				userId: ownerId,
				permission,
			})),
		);

		const reinviteAfterDrain = await owner.mutation(api.organizations.invite_user_to_organization_workspace, {
			organizationId: created._yay!.organizationId,
			workspaceId: created._yay!.defaultWorkspaceId,
			userIdToAdd: memberId,
		});
		expect(reinviteAfterDrain._yay).toBeNull();
		const restoredMembership = await t.run((ctx) =>
			ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_active_user_organization_workspace", (q) =>
					q
						.eq("active", true)
						.eq("userId", memberId)
						.eq("organizationId", created._yay!.organizationId)
						.eq("workspaceId", created._yay!.defaultWorkspaceId),
				)
				.first(),
		);
		expect(restoredMembership?.pendingOrganizationRemoval).not.toBe(true);
	});
});

describe("access_control.transfer_organization_ownership", () => {
	test("refuses a finalized recipient before reading their missing quota", async () => {
		const t = test_convex();
		const [ownerId, deletedUserId] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", { clerkUserId: "clerk-transfer-invalid-owner" }),
				ctx.db.insert("users", {
					clerkUserId: null,
					deletedAt: Date.now(),
				}),
			]),
		);
		await organizations_test_bootstrap_user(t, { userId: ownerId });
		const owner = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: ownerId,
			name: "Owner",
			email: "transfer-invalid-owner@test.local",
		});
		const created = await owner.mutation(api.organizations.create_organization, {
			description: "",
			name: "transfer-invalid",
		});
		expect(created._yay).toBeTruthy();

		const result = await owner.mutation(api.access_control.transfer_organization_ownership, {
			organizationId: created._yay!.organizationId,
			newOwnerUserId: deletedUserId,
		});

		expect(result._nay?.message).toBe("New owner must be an active organization member");
	});

	test("moves ownership to the organization doc and updates extra-organization quota usage", async () => {
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
			const now = Date.now();
			await Promise.all([
				ctx.db.insert("organizations_workspaces_users", {
					organizationId: created._yay!.organizationId,
					workspaceId: created._yay!.defaultWorkspaceId,
					userId: newOwnerId,
					active: true,
					updatedAt: now,
				}),
				// Invited organization members already have a member role before transfer.
				ctx.db.insert("access_control_role_assignments", {
					organizationId: created._yay!.organizationId,
					workspaceId: created._yay!.defaultWorkspaceId,
					userId: newOwnerId,
					role: "member",
					createdAt: now,
					updatedAt: now,
				}),
			]);

			// A second role, this time a workspace role. It does nothing while this user
			// owns the organization, so the transfer has to delete it too. Otherwise it would start
			// working again if ownership later moved to somebody else.
			const secondWorkspace = await organizations_db_create_workspace(ctx, {
				userId: ownerId,
				organizationId: created._yay!.organizationId,
				name: "transfer-side",
				description: "",
				now,
			});
			if (secondWorkspace._nay) {
				throw new Error(secondWorkspace._nay.message);
			}
			await test_mocks_cancel_pending_home_file_seeds(ctx);

			await ctx.db.insert("organizations_workspaces_users", {
				organizationId: created._yay!.organizationId,
				workspaceId: secondWorkspace._yay.workspaceId,
				userId: newOwnerId,
				active: true,
				updatedAt: now,
			});
			await ctx.db.insert("access_control_role_assignments", {
				organizationId: created._yay!.organizationId,
				workspaceId: secondWorkspace._yay.workspaceId,
				userId: newOwnerId,
				role: "admin",
				createdAt: now,
				updatedAt: now,
			});
		});

		const transferResult = await owner.mutation(api.access_control.transfer_organization_ownership, {
			organizationId: created._yay!.organizationId,
			newOwnerUserId: newOwnerId,
		});
		expect(transferResult._yay).toBeNull();

		const afterTransfer = await t.run(async (ctx) => {
			const [organization, newOwnerRoles, oldOwnerMemberRole, oldOwnerQuota, newOwnerQuota, oldOwnerHomeMembership] =
				await Promise.all([
					ctx.db.get("organizations", created._yay!.organizationId),
					// Read the assignments in every workspace, not only the default one.
					ctx.db
						.query("access_control_role_assignments")
						.withIndex("by_organization_user_workspace", (q) =>
							q.eq("organizationId", created._yay!.organizationId).eq("userId", newOwnerId),
						)
						.collect(),
					ctx.db
						.query("access_control_role_assignments")
						.withIndex("by_organization_workspace_user", (q) =>
							q
								.eq("organizationId", created._yay!.organizationId)
								.eq("workspaceId", created._yay!.defaultWorkspaceId)
								.eq("userId", ownerId),
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

			return {
				organization,
				newOwnerRoles,
				oldOwnerMemberRole,
				oldOwnerQuota,
				newOwnerQuota,
				oldOwnerHomeMembership,
			};
		});

		expect(afterTransfer.organization?.ownerUserId).toBe(newOwnerId);
		// The new owner's role assignment is deleted, and the old owner is set to `member`.
		expect(afterTransfer.newOwnerRoles).toHaveLength(0);
		expect(afterTransfer.oldOwnerMemberRole?.role).toBe("member");
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
				resource: { kind: "organization", id: String(created._yay!.organizationId) },
				permission: "organization.members.manage",
				userId: memberId,
			});
			const adminOrganizationAccess = await access_control_db_has_permission(ctx, {
				organizationId: created._yay!.organizationId,
				workspaceId: created._yay!.defaultWorkspaceId,
				defaultWorkspaceId: created._yay!.defaultWorkspaceId,
				organizationOwnerUserId: ownerId,
				resource: { kind: "organization", id: String(created._yay!.organizationId) },
				permission: "organization.members.manage",
				userId: adminId,
			});
			const memberWorkspaceAccess = await access_control_db_has_permission(ctx, {
				organizationId: created._yay!.organizationId,
				workspaceId: workspace._yay!.workspaceId,
				defaultWorkspaceId: created._yay!.defaultWorkspaceId,
				organizationOwnerUserId: ownerId,
				resource: { kind: "workspace", id: String(workspace._yay!.workspaceId) },
				permission: "workspace.members.manage",
				userId: memberId,
			});
			const adminWorkspaceAccess = await access_control_db_has_permission(ctx, {
				organizationId: created._yay!.organizationId,
				workspaceId: workspace._yay!.workspaceId,
				defaultWorkspaceId: created._yay!.defaultWorkspaceId,
				organizationOwnerUserId: ownerId,
				resource: { kind: "workspace", id: String(workspace._yay!.workspaceId) },
				permission: "workspace.members.manage",
				userId: adminId,
			});

			return {
				memberOrganizationAccess,
				adminOrganizationAccess,
				memberWorkspaceAccess,
				adminWorkspaceAccess,
			};
		});

		expect(result.memberOrganizationAccess).toBe(false);
		expect(result.adminOrganizationAccess).toBe(true);
		expect(result.memberWorkspaceAccess).toBe(false);
		expect(result.adminWorkspaceAccess).toBe(true);
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

	test("prefers the workspace role and otherwise shows the organization role", async () => {
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

		expect(ownerRole).toEqual({ kind: "owner" });
		expect(localWorkspaceRole).toEqual({ kind: "system", role: "member" });
		expect(siblingWorkspaceRoleBeforeDefaultRole).toBeNull();
		// Where the user has a role inside the workspace, that role is shown...
		expect(localWorkspaceRoleAfterDefaultRole).toEqual({ kind: "system", role: "member" });
		// ...and everywhere else the organization role is shown, which matches the real access.
		expect(siblingWorkspaceRoleAfterDefaultRole).toEqual({ kind: "system", role: "admin" });
		expect(defaultWorkspaceRoleAfterDefaultRole).toEqual({ kind: "system", role: "admin" });
	});

	test("keeps workspace role assignments local and default-workspace assignments organization-wide", async () => {
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
				resource: { kind: "workspace", id: String(workspaceAId) },
				permission: "workspace.update",
				userId: scopedUserId,
			});
			const workspaceBAccessBeforeOrganizationRole = await access_control_db_has_permission(ctx, {
				organizationId: organization.organizationId,
				workspaceId: workspaceBId,
				defaultWorkspaceId: organization.defaultWorkspaceId,
				organizationOwnerUserId: ownerId,
				resource: { kind: "workspace", id: String(workspaceBId) },
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

			// For organization-scoped permissions, the organization role works in every workspace.
			const workspaceBOrganizationScopedAccess = await access_control_db_has_permission(ctx, {
				organizationId: organization.organizationId,
				workspaceId: workspaceBId,
				defaultWorkspaceId: organization.defaultWorkspaceId,
				organizationOwnerUserId: ownerId,
				resource: { kind: "workspace", id: String(workspaceBId) },
				permission: "workspace.create",
				userId: scopedUserId,
			});
			// Its workspace-scoped half needs membership in that workspace.
			const workspaceBAccessWithoutMembership = await access_control_db_has_permission(ctx, {
				organizationId: organization.organizationId,
				workspaceId: workspaceBId,
				defaultWorkspaceId: organization.defaultWorkspaceId,
				organizationOwnerUserId: ownerId,
				resource: { kind: "workspace", id: String(workspaceBId) },
				permission: "workspace.update",
				userId: scopedUserId,
			});

			await ctx.db.insert("organizations_workspaces_users", {
				organizationId: organization.organizationId,
				workspaceId: workspaceBId,
				userId: scopedUserId,
				active: true,
				updatedAt: now,
			});

			const workspaceBAccessAfterOrganizationRole = await access_control_db_has_permission(ctx, {
				organizationId: organization.organizationId,
				workspaceId: workspaceBId,
				defaultWorkspaceId: organization.defaultWorkspaceId,
				organizationOwnerUserId: ownerId,
				resource: { kind: "workspace", id: String(workspaceBId) },
				permission: "workspace.update",
				userId: scopedUserId,
			});

			return {
				workspaceALocalAccess,
				workspaceBAccessBeforeOrganizationRole,
				workspaceBOrganizationScopedAccess,
				workspaceBAccessWithoutMembership,
				workspaceBAccessAfterOrganizationRole,
			};
		});

		expect(result.workspaceALocalAccess).toBe(true);
		expect(result.workspaceBAccessBeforeOrganizationRole).toBe(false);
		expect(result.workspaceBOrganizationScopedAccess).toBe(true);
		expect(result.workspaceBAccessWithoutMembership).toBe(false);
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

			// File sharing does not write these grants yet, so the test inserts the docs straight into the
			// table. `resourceId` is the restricted scope node, never the file that was opened.
			await Promise.all([
				ctx.db.insert("access_control_permission_grants", {
					organizationId: organization.organizationId,
					workspaceId: organization.defaultWorkspaceId,
					resourceKind: "file",
					resourceId: String(nodeId),
					principalKind: "user",
					userId: grantedUserId,
					permission: "content.write",
					createdAt: now,
					updatedAt: now,
				}),
				ctx.db.insert("access_control_permission_grants", {
					organizationId: organization.organizationId,
					workspaceId: organization.defaultWorkspaceId,
					resourceKind: "file",
					resourceId: String(nodeId),
					principalKind: "public",
					permission: "content.read",
					createdAt: now,
					updatedAt: now,
				}),
			]);

			const directUserAccess = await access_control_db_has_permission(ctx, {
				organizationId: organization.organizationId,
				workspaceId: organization.defaultWorkspaceId,
				defaultWorkspaceId: organization.defaultWorkspaceId,
				organizationOwnerUserId: ownerId,
				resource: { kind: "file", id: String(nodeId), restrictedScopeNodeId: null },
				permission: "content.write",
				userId: grantedUserId,
			});
			const otherUserAccess = await access_control_db_has_permission(ctx, {
				organizationId: organization.organizationId,
				workspaceId: organization.defaultWorkspaceId,
				defaultWorkspaceId: organization.defaultWorkspaceId,
				organizationOwnerUserId: ownerId,
				resource: { kind: "file", id: String(nodeId), restrictedScopeNodeId: null },
				permission: "content.write",
				userId: otherUserId,
			});
			const publicReadAccess = await access_control_db_has_permission(ctx, {
				organizationId: organization.organizationId,
				workspaceId: organization.defaultWorkspaceId,
				defaultWorkspaceId: organization.defaultWorkspaceId,
				organizationOwnerUserId: ownerId,
				resource: { kind: "file", id: String(nodeId), restrictedScopeNodeId: null },
				permission: "content.read",
				allowPublic: true,
			});
			const publicWriteAccess = await access_control_db_has_permission(ctx, {
				organizationId: organization.organizationId,
				workspaceId: organization.defaultWorkspaceId,
				defaultWorkspaceId: organization.defaultWorkspaceId,
				organizationOwnerUserId: ownerId,
				resource: { kind: "file", id: String(nodeId), restrictedScopeNodeId: null },
				permission: "content.write",
				allowPublic: true,
			});
			const otherPagePublicAccess = await access_control_db_has_permission(ctx, {
				organizationId: organization.organizationId,
				workspaceId: organization.defaultWorkspaceId,
				defaultWorkspaceId: organization.defaultWorkspaceId,
				organizationOwnerUserId: ownerId,
				resource: { kind: "file", id: String(otherNodeId), restrictedScopeNodeId: null },
				permission: "content.read",
				allowPublic: true,
			});
			const publicAccessWithoutPublicFlag = await access_control_db_has_permission(ctx, {
				organizationId: organization.organizationId,
				workspaceId: organization.defaultWorkspaceId,
				defaultWorkspaceId: organization.defaultWorkspaceId,
				organizationOwnerUserId: ownerId,
				resource: { kind: "file", id: String(nodeId), restrictedScopeNodeId: null },
				permission: "content.read",
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

	test("requires organization.update from a non-owner", async () => {
		const t = test_convex();
		const [ownerId, memberId] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", { clerkUserId: "clerk-edit-org-permission-owner" }),
				ctx.db.insert("users", { clerkUserId: "clerk-edit-org-permission-member" }),
			]),
		);
		await organizations_test_bootstrap_users(t, { userIds: [ownerId, memberId] });
		const owner = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: ownerId,
			name: "Owner",
			email: "edit-org-permission-owner@test.local",
		});
		const member = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: memberId,
			name: "Member",
			email: "edit-org-permission-member@test.local",
		});
		const created = await owner.mutation(api.organizations.create_organization, {
			description: "",
			name: "edit-org-permission",
		});
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

		const denied = await member.mutation(api.organizations.edit_organization, {
			organizationId: created._yay!.organizationId,
			defaultWorkspaceId: created._yay!.defaultWorkspaceId,
			name: "edit-org-denied",
			description: "",
		});
		expect(denied._nay?.message).toBe("Permission denied");

		const role = await owner.mutation(api.access_control.create_role, {
			organizationId: created._yay!.organizationId,
			name: "Organization editor",
			description: "",
			permissions: ["organization.update"],
		});
		expect(role._nay).toBeUndefined();
		await t.run(async (ctx) => {
			const assignment = await ctx.db
				.query("access_control_role_assignments")
				.withIndex("by_organization_workspace_user", (q) =>
					q
						.eq("organizationId", created._yay!.organizationId)
						.eq("workspaceId", created._yay!.defaultWorkspaceId)
						.eq("userId", memberId),
				)
				.first();
			await ctx.db.patch("access_control_role_assignments", assignment!._id, { role: role._yay!.roleId });
			await ctx.runMutation(components.rate_limiter.lib.resetRateLimit, {
				name: "organizations_write",
				key: memberId,
			});
		});

		const allowed = await member.mutation(api.organizations.edit_organization, {
			organizationId: created._yay!.organizationId,
			defaultWorkspaceId: created._yay!.defaultWorkspaceId,
			name: "edit-org-allowed",
			description: "",
		});
		expect(allowed._yay?.name).toBe("edit-org-allowed");
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
			await ctx.db.patch("organizations_workspaces", homeId, { default: false });
			await ctx.db.patch("organizations", organizationId, { defaultWorkspaceId: zebraId });
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

	test("accepts either workspace.update or organization.update from a non-owner", async () => {
		const t = test_convex();
		const [ownerId, memberId] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", { clerkUserId: "clerk-edit-workspace-permission-owner" }),
				ctx.db.insert("users", { clerkUserId: "clerk-edit-workspace-permission-member" }),
			]),
		);
		await organizations_test_bootstrap_users(t, { userIds: [ownerId, memberId] });
		const owner = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: ownerId,
			name: "Owner",
			email: "edit-workspace-permission-owner@test.local",
		});
		const member = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: memberId,
			name: "Member",
			email: "edit-workspace-permission-member@test.local",
		});
		const created = await owner.mutation(api.organizations.create_organization, {
			description: "",
			name: "edit-workspace-perm",
		});
		expect(created._yay).toBeTruthy();
		const workspace = await t.run((ctx) =>
			organizations_db_create_workspace(ctx, {
				userId: ownerId,
				organizationId: created._yay!.organizationId,
				name: "edit-target",
				description: "",
				now: Date.now(),
			}),
		);
		expect(workspace._yay).toBeTruthy();

		const workspaceRole = await owner.mutation(api.access_control.create_role, {
			organizationId: created._yay!.organizationId,
			name: "Workspace editor",
			description: "",
			permissions: ["workspace.update"],
		});
		const organizationRole = await owner.mutation(api.access_control.create_role, {
			organizationId: created._yay!.organizationId,
			name: "Organization editor",
			description: "",
			permissions: ["organization.update"],
		});
		const readerRole = await owner.mutation(api.access_control.create_role, {
			organizationId: created._yay!.organizationId,
			name: "Reader only",
			description: "",
			permissions: ["content.read"],
		});
		expect(workspaceRole._nay).toBeUndefined();
		expect(organizationRole._nay).toBeUndefined();
		expect(readerRole._nay).toBeUndefined();

		const assignmentId = await t.run(async (ctx) => {
			const now = Date.now();
			await Promise.all([
				ctx.db.insert("organizations_workspaces_users", {
					organizationId: created._yay!.organizationId,
					workspaceId: created._yay!.defaultWorkspaceId,
					userId: memberId,
					active: true,
					updatedAt: now,
				}),
				ctx.db.insert("organizations_workspaces_users", {
					organizationId: created._yay!.organizationId,
					workspaceId: workspace._yay!.workspaceId,
					userId: memberId,
					active: true,
					updatedAt: now,
				}),
			]);
			return await ctx.db.insert("access_control_role_assignments", {
				organizationId: created._yay!.organizationId,
				workspaceId: created._yay!.defaultWorkspaceId,
				userId: memberId,
				role: workspaceRole._yay!.roleId,
				createdAt: now,
				updatedAt: now,
			});
		});

		const workspaceAllowed = await member.mutation(api.organizations.edit_workspace, {
			organizationId: created._yay!.organizationId,
			defaultWorkspaceId: created._yay!.defaultWorkspaceId,
			workspaceId: workspace._yay!.workspaceId,
			name: "workspace-arm",
			description: "",
		});
		expect(workspaceAllowed._yay?.name).toBe("workspace-arm");

		await t.run(async (ctx) => {
			await ctx.db.patch("access_control_role_assignments", assignmentId, { role: organizationRole._yay!.roleId });
			await ctx.runMutation(components.rate_limiter.lib.resetRateLimit, {
				name: "organizations_write",
				key: memberId,
			});
		});
		const organizationAllowed = await member.mutation(api.organizations.edit_workspace, {
			organizationId: created._yay!.organizationId,
			defaultWorkspaceId: created._yay!.defaultWorkspaceId,
			workspaceId: workspace._yay!.workspaceId,
			name: "organization-arm",
			description: "",
		});
		expect(organizationAllowed._yay?.name).toBe("organization-arm");

		await t.run(async (ctx) => {
			await ctx.db.patch("access_control_role_assignments", assignmentId, { role: readerRole._yay!.roleId });
			await ctx.runMutation(components.rate_limiter.lib.resetRateLimit, {
				name: "organizations_write",
				key: memberId,
			});
		});
		const denied = await member.mutation(api.organizations.edit_workspace, {
			organizationId: created._yay!.organizationId,
			defaultWorkspaceId: created._yay!.defaultWorkspaceId,
			workspaceId: workspace._yay!.workspaceId,
			name: "neither-arm",
			description: "",
		});
		expect(denied._nay?.message).toBe("Permission denied");
	});

	test("the organization owner can rename a workspace they never joined", async () => {
		const t = test_convex();
		const [ownerId, memberId] = await t.run(async (ctx) => [
			await ctx.db.insert("users", { clerkUserId: "clerk-owner-rename-unjoined-ws" }),
			await ctx.db.insert("users", { clerkUserId: "clerk-member-rename-unjoined-ws" }),
		]);
		await organizations_test_bootstrap_users(t, { userIds: [ownerId, memberId] });
		const asOwner = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: ownerId,
			name: "Owner",
			email: "organizations-test-owner@test.local",
		});

		const organization = await t.run((ctx) =>
			organizations_db_create(ctx, {
				userId: ownerId,
				description: "",
				name: "owner-unjoined-ws",
				now: Date.now(),
			}),
		);
		if (organization._nay) {
			throw new Error(organization._nay.message);
		}

		// The member joins the default workspace and makes their own workspace there. Creating one writes
		// a membership for the creator only, so the owner never becomes a member of it.
		const extra = await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert("organizations_workspaces_users", {
				organizationId: organization._yay!.organizationId,
				workspaceId: organization._yay!.defaultWorkspaceId,
				userId: memberId,
				active: true,
				updatedAt: now,
			});
			await access_control_db_ensure_role_assignment(ctx, {
				organizationId: organization._yay!.organizationId,
				workspaceId: organization._yay!.defaultWorkspaceId,
				userId: memberId,
				role: "member",
				now,
			});
			return await organizations_db_create_workspace(ctx, {
				userId: memberId,
				description: "",
				organizationId: organization._yay!.organizationId,
				name: "member-made",
				now,
			});
		});
		if (extra._nay) {
			throw new Error(extra._nay.message);
		}

		// `delete_workspace` already lets the owner through without a membership. Renaming has to agree,
		// or the owner can throw the workspace away but cannot fix its name.
		const renamed = await asOwner.mutation(api.organizations.edit_workspace, {
			organizationId: organization._yay!.organizationId,
			defaultWorkspaceId: organization._yay!.defaultWorkspaceId,
			workspaceId: extra._yay!.workspaceId,
			name: "owner-renamed",
			description: "",
		});
		expect(renamed._yay?.name).toBe("owner-renamed");
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
	test("rejects deleting the primary workspace when workspace.default is true", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-delete-primary-ws",
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
				name: "delete-primary-ws",
				now: Date.now(),
			}),
		);
		if (wsResult._nay) {
			throw new Error(wsResult._nay.message);
		}
		expect(wsResult._yay).toBeTruthy();

		const result = await asUser.mutation(api.organizations.delete_workspace, {
			workspaceId: wsResult._yay!.defaultWorkspaceId,
		});

		expect(result._nay?.message).toBe("Cannot delete the default workspace");
	});

	test("rejects deleting the primary workspace when only defaultWorkspaceId matches", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-delete-primary-ws-id",
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
				name: "delete-primary-ws-id",
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

		// Move the pointer to zebra and clear the flag on home. The guard must follow the
		// organization doc, not the `default` flag on the workspace doc.
		await t.run(async (ctx) => {
			await ctx.db.patch("organizations_workspaces", homeId, { default: false });
			await ctx.db.patch("organizations", organizationId, { defaultWorkspaceId: zebraId });
		});

		const blocked = await asUser.mutation(api.organizations.delete_workspace, {
			workspaceId: zebraId,
		});
		expect(blocked._nay?.message).toBe("Cannot delete the default workspace");

		const ok = await asUser.mutation(api.organizations.delete_workspace, {
			workspaceId: homeId,
		});
		expect(ok._yay).toBeNull();
	});

	test("revokes a live plugin run when workspace deletion removes its workspace", async () => {
		const t = test_convex();
		const userId = await t.run((ctx) =>
			ctx.db.insert("users", { clerkUserId: "clerk-user-delete-live-plugin-workspace" }),
		);
		await organizations_test_bootstrap_user(t, { userId });
		const owner = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Owner",
			email: "delete-live-plugin-workspace@test.local",
		});
		const organization = await owner.mutation(api.organizations.create_organization, {
			name: "plugin-ws-delete",
			description: "",
		});
		expect(organization._yay).toBeTruthy();
		const workspace = await owner.mutation(api.organizations.create_workspace, {
			organizationId: organization._yay!.organizationId,
			name: "plugin-workspace",
			description: "",
		});
		expect(workspace._yay).toBeTruthy();

		const fixture = await t.run((ctx) =>
			organizations_test_seed_live_plugin_authority(ctx, {
				userId,
				organizationId: organization._yay!.organizationId,
				workspaceId: workspace._yay!.workspaceId,
				tag: "workspace-delete",
			}),
		);
		await t.mutation(components.rate_limiter.lib.resetRateLimit, {
			name: "organizations_write",
			key: userId,
		});
		const deleted = await owner.mutation(api.organizations.delete_workspace, {
			workspaceId: workspace._yay!.workspaceId,
		});
		expect(deleted._yay).toBeNull();

		const consumed = await t.mutation(internal.plugins_runtime.consume_run_api_call, {
			runId: fixture.runId,
			kind: "api_request",
			route: "/api/v1/plugin-data/read",
		});
		expect(consumed).toEqual({ _nay: { message: "Unauthenticated" } });
		expect(await t.run((ctx) => ctx.db.query("plugins_event_run_calls").collect())).toHaveLength(0);
	});

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
				archivedAt: 0,
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
			await quotas_db_ensure(ctx, {
				quotaName: "plugin_service_storage_bytes",
				organizationId: created._yay!.organizationId,
				workspaceId: extraWorkspace._yay!.workspaceId,
				now: Date.now(),
			});
			await quotas_db_ensure(ctx, {
				quotaName: "public_api_upload_bytes",
				organizationId: created._yay!.organizationId,
				workspaceId: extraWorkspace._yay!.workspaceId,
				now: Date.now(),
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
				workspaceQuotaDocs,
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
				organizations_test_read_organization_extra_workspace_quota_doc(ctx, {
					organizationId: created._yay!.organizationId,
				}),
				ctx.db
					.query("quotas")
					.withIndex("by_workspace_quotaName", (q) => q.eq("workspaceId", extraWorkspace._yay!.workspaceId))
					.collect(),
				ctx.db
					.query("access_control_role_assignments")
					.withIndex("by_organization_workspace_user", (q) =>
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
					(row) =>
						row.organizationId === created._yay!.organizationId && row.workspaceId === extraWorkspace._yay!.workspaceId,
				),
				user,
				organizationQuota,
				workspaceQuotaDocs,
				roleAssignments,
				permissionGrants,
				files: files.filter(
					(row) =>
						row.organizationId === created._yay!.organizationId && row.workspaceId === extraWorkspace._yay!.workspaceId,
				),
				assets: assets.filter(
					(row) =>
						row.organizationId === created._yay!.organizationId && row.workspaceId === extraWorkspace._yay!.workspaceId,
				),
				aiThreads: aiThreads.filter(
					(row) =>
						row.organizationId === created._yay!.organizationId && row.workspaceId === extraWorkspace._yay!.workspaceId,
				),
				aiMessages: aiMessages.filter(
					(row) =>
						row.organizationId === created._yay!.organizationId && row.workspaceId === extraWorkspace._yay!.workspaceId,
				),
				chatMessages: chatMessages.filter(
					(row) =>
						row.organizationId === created._yay!.organizationId && row.workspaceId === extraWorkspace._yay!.workspaceId,
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
		// The service budget stays through retention so a late R2 event can still settle its target.
		expect(after_delete.workspaceQuotaDocs.map((doc) => doc.quotaName)).toEqual([
			"plugin_service_storage_bytes",
			"public_api_upload_bytes",
		]);
		expect(after_delete.roleAssignments).toHaveLength(0);
		expect(after_delete.permissionGrants).toHaveLength(0);
		expect(after_delete.user?.defaultOrganizationId).toBe(personalDefaultIds.organizationId);
		expect(after_delete.user?.defaultWorkspaceId).toBe(personalDefaultIds.defaultWorkspaceId);

		await organizations_test_process_workspace_deletion_request_until_done(t, {
			requestId: after_delete.requests[0]!._id,
		});

		const { purgeRequestsAfter, workspaceQuotaDocsAfter } = await t.run(async (ctx) => ({
			purgeRequestsAfter: (await ctx.db.query("data_deletion_requests").collect()).filter(
				(row) =>
					row.organizationId === created._yay!.organizationId && row.workspaceId === extraWorkspace._yay!.workspaceId,
			),
			workspaceQuotaDocsAfter: await ctx.db
				.query("quotas")
				.withIndex("by_workspace_quotaName", (q) => q.eq("workspaceId", extraWorkspace._yay!.workspaceId))
				.collect(),
		}));
		expect(purgeRequestsAfter).toHaveLength(0);
		expect(workspaceQuotaDocsAfter).toHaveLength(0);
	});

	test("requires workspace.delete from a non-owner", async () => {
		const t = test_convex();
		const [ownerId, memberId] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", { clerkUserId: "clerk-user-delete-ws-member" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-delete-ws-member-target" }),
			]),
		);
		await organizations_test_bootstrap_users(t, { userIds: [ownerId, memberId] });
		const owner = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: ownerId,
			name: "Owner",
			email: "delete-ws-member-owner@test.local",
		});
		const member = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: memberId,
			name: "Member",
			email: "delete-ws-member@test.local",
		});

		const created = await owner.mutation(api.organizations.create_organization, {
			description: "",
			name: "delete-ws-roles",
		});
		expect(created._yay).toBeTruthy();
		const organization = created._yay!;

		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert("organizations_workspaces_users", {
				organizationId: organization.organizationId,
				workspaceId: organization.defaultWorkspaceId,
				userId: memberId,
				active: true,
				updatedAt: now,
			});
			await access_control_db_ensure_role_assignment(ctx, {
				organizationId: organization.organizationId,
				workspaceId: organization.defaultWorkspaceId,
				userId: memberId,
				role: "member",
				now,
			});
		});

		const workspace = await member.mutation(api.organizations.create_workspace, {
			organizationId: organization.organizationId,
			name: "member-space",
			description: "",
		});
		expect(workspace._nay).toBeUndefined();

		await t.run((ctx) =>
			ctx.runMutation(components.rate_limiter.lib.resetRateLimit, { name: "organizations_write", key: memberId }),
		);

		// `member` has `workspace.create` but not `workspace.delete`, so creating a workspace does not
		// give the right to delete it.
		const denied = await member.mutation(api.organizations.delete_workspace, {
			workspaceId: workspace._yay!.workspaceId,
		});
		expect(denied._nay?.message).toBe("Permission denied");

		const role = await owner.mutation(api.access_control.create_role, {
			organizationId: organization.organizationId,
			name: "Workspace remover",
			description: "",
			permissions: ["workspace.delete"],
		});
		expect(role._nay).toBeUndefined();
		await t.run(async (ctx) => {
			const assignment = await ctx.db
				.query("access_control_role_assignments")
				.withIndex("by_organization_workspace_user", (q) =>
					q
						.eq("organizationId", organization.organizationId)
						.eq("workspaceId", organization.defaultWorkspaceId)
						.eq("userId", memberId),
				)
				.first();
			await ctx.db.patch("access_control_role_assignments", assignment!._id, { role: role._yay!.roleId });
			await ctx.runMutation(components.rate_limiter.lib.resetRateLimit, {
				name: "organizations_write",
				key: memberId,
			});
		});

		const allowed = await member.mutation(api.organizations.delete_workspace, {
			workspaceId: workspace._yay!.workspaceId,
		});
		expect(allowed._nay).toBeUndefined();
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
			// A membership alone gives no permission. Without this role the test would use a user with no
			// permissions at all, instead of the member its name promises.
			await access_control_db_ensure_role_assignment(ctx, {
				organizationId: created._yay!.organizationId,
				workspaceId: created._yay!.defaultWorkspaceId,
				userId: memberId,
				role: "member",
				now: Date.now(),
			});
		});

		const result = await member.mutation(api.organizations.delete_organization, {
			organizationId: created._yay!.organizationId,
		});
		expect(result._nay?.message).toBe("Permission denied");

		const organizationAfter = await t.run((ctx) => ctx.db.get("organizations", created._yay!.organizationId));
		expect(organizationAfter).not.toBeNull();
	});

	test("fences a scheduled plugin projection during organization retention", async () => {
		const t = test_convex();
		const ownerId = await t.run((ctx) =>
			ctx.db.insert("users", { clerkUserId: "clerk-user-delete-scheduled-plugin-organization" }),
		);
		await organizations_test_bootstrap_user(t, { userId: ownerId });
		const owner = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: ownerId,
			name: "Owner",
			email: "delete-scheduled-plugin-organization@test.local",
		});
		const organization = await owner.mutation(api.organizations.create_organization, {
			name: "plugin-org-delete",
			description: "",
		});
		expect(organization._yay).toBeTruthy();
		const fixture = await t.run((ctx) =>
			organizations_test_seed_live_plugin_authority(ctx, {
				userId: ownerId,
				organizationId: organization._yay!.organizationId,
				workspaceId: organization._yay!.defaultWorkspaceId,
				tag: "organization-delete",
			}),
		);
		await t.mutation(internal.plugins_projections.schedule_sync, {
			installationId: fixture.installationId,
		});
		const projectionState = await t.run((ctx) =>
			ctx.db
				.query("plugins_data_projection_states")
				.withIndex("by_installation", (q) => q.eq("installationId", fixture.installationId))
				.unique(),
		);
		expect(projectionState).not.toBeNull();

		const deleted = await owner.mutation(api.organizations.delete_organization, {
			organizationId: organization._yay!.organizationId,
		});
		expect(deleted._yay).toBeNull();
		expect(
			await t.run((ctx) => ctx.db.get("organizations_workspaces", organization._yay!.defaultWorkspaceId)),
		).toMatchObject({ pluginDataPurgeStartedAt: expect.any(Number) });

		const projected = await t.mutation(internal.plugins_projections.ensure_projection_root, {
			installationId: fixture.installationId,
			syncGeneration: projectionState!.syncGeneration,
		});
		expect(projected).toEqual({ _nay: { message: "Not found" } });
		const projectedFiles = await t.run(async (ctx) =>
			(await ctx.db.query("files_nodes").collect()).filter(
				(node) =>
					node.organizationId === organization._yay!.organizationId &&
					node.workspaceId === organization._yay!.defaultWorkspaceId &&
					node.projectionPluginName === "chitchat",
			),
		);
		expect(projectedFiles).toHaveLength(0);
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
				archivedAt: 0,
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
					.withIndex("by_organization_workspace_user", (q) => q.eq("organizationId", created._yay!.organizationId))
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
					.withIndex("by_organization_user_archivedAt", (q) => q.eq("organizationId", created._yay!.organizationId))
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
					(row) =>
						row.organizationId === created._yay!.organizationId &&
						row.workspaceId === victimWorkspace._yay!.workspaceId,
				),
				controlPages: files.filter(
					(row) =>
						row.organizationId === created._yay!.organizationId && row.workspaceId === created._yay!.defaultWorkspaceId,
				),
				victimPages: files.filter(
					(row) =>
						row.organizationId === created._yay!.organizationId &&
						row.workspaceId === victimWorkspace._yay!.workspaceId,
				),
				controlAssets: assets.filter(
					(row) =>
						row.organizationId === created._yay!.organizationId && row.workspaceId === created._yay!.defaultWorkspaceId,
				),
				victimAssets: assets.filter(
					(row) =>
						row.organizationId === created._yay!.organizationId &&
						row.workspaceId === victimWorkspace._yay!.workspaceId,
				),
				controlAiThreads: aiThreads.filter(
					(row) =>
						row.organizationId === created._yay!.organizationId && row.workspaceId === created._yay!.defaultWorkspaceId,
				),
				victimAiThreads: aiThreads.filter(
					(row) =>
						row.organizationId === created._yay!.organizationId &&
						row.workspaceId === victimWorkspace._yay!.workspaceId,
				),
				controlAiMessages: aiMessages.filter(
					(row) =>
						row.organizationId === created._yay!.organizationId && row.workspaceId === created._yay!.defaultWorkspaceId,
				),
				victimAiMessages: aiMessages.filter(
					(row) =>
						row.organizationId === created._yay!.organizationId &&
						row.workspaceId === victimWorkspace._yay!.workspaceId,
				),
				controlChatMessages: chatMessages.filter(
					(row) =>
						row.organizationId === created._yay!.organizationId && row.workspaceId === created._yay!.defaultWorkspaceId,
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

	test("denies an admin but allows a custom role that holds the billing permission", async () => {
		const t = test_convex();
		const [ownerId, adminId] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", { clerkUserId: "clerk-user-set-billing-role-owner" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-set-billing-role-admin" }),
			]),
		);
		await organizations_test_bootstrap_users(t, { userIds: [ownerId, adminId] });
		const owner = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: ownerId,
			name: "Owner",
			email: "billing-role-owner@test.local",
		});
		const admin = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: adminId,
			name: "Admin",
			email: "billing-role-admin@test.local",
		});
		const created = await owner.mutation(api.organizations.create_organization, {
			description: "",
			name: "billing-mode-role",
		});
		expect(created._yay).toBeTruthy();
		const organization = created._yay!;

		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert("organizations_workspaces_users", {
				organizationId: organization.organizationId,
				workspaceId: organization.defaultWorkspaceId,
				userId: adminId,
				active: true,
				updatedAt: now,
			});
			await access_control_db_ensure_role_assignment(ctx, {
				organizationId: organization.organizationId,
				workspaceId: organization.defaultWorkspaceId,
				userId: adminId,
				role: "admin",
				now,
			});
		});

		// The `admin` role does not include billing, on purpose.
		const asAdmin = await admin.mutation(api.organizations.set_organization_billing_mode, {
			organizationId: organization.organizationId,
			billingMode: "organization_owner",
		});
		expect(asAdmin._nay?.message).toBe("Permission denied");

		const role = await owner.mutation(api.access_control.create_role, {
			organizationId: organization.organizationId,
			name: "Treasurer",
			description: "",
			permissions: ["organization.billing.manage"],
		});
		expect(role._nay).toBeUndefined();

		await t.run(async (ctx) => {
			const assignment = await ctx.db
				.query("access_control_role_assignments")
				.withIndex("by_organization_workspace_user", (q) =>
					q
						.eq("organizationId", organization.organizationId)
						.eq("workspaceId", organization.defaultWorkspaceId)
						.eq("userId", adminId),
				)
				.first();
			await ctx.db.patch("access_control_role_assignments", assignment!._id, { role: role._yay!.roleId });
			await ctx.runMutation(components.rate_limiter.lib.resetRateLimit, {
				name: "organizations_write",
				key: adminId,
			});
		});

		const asTreasurer = await admin.mutation(api.organizations.set_organization_billing_mode, {
			organizationId: organization.organizationId,
			billingMode: "organization_owner",
		});
		expect(asTreasurer._nay).toBeUndefined();
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
