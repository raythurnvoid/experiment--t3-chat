import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import {
	workspaces_db_create,
	workspaces_db_create_project,
	workspaces_db_ensure_default_workspace_and_project_for_user,
} from "./workspaces.ts";
import {
	access_control_db_ensure_public_permission_grant,
	access_control_db_ensure_role_assignment,
	access_control_db_ensure_role_permission_grant,
	access_control_db_ensure_user_permission_grant,
	access_control_db_has_permission,
} from "./access_control.ts";
import { Result } from "../shared/errors-as-values-utils.ts";
import { quotas_db_ensure } from "./quotas.ts";
import { workspaces_DESCRIPTION_MAX_LENGTH, workspaces_NAME_MAX_LENGTH } from "../shared/workspaces.ts";

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

async function workspaces_test_seed_default_workspace(ctx: MutationCtx, args: { userId: Id<"users">; now?: number }) {
	await workspaces_db_ensure_default_workspace_and_project_for_user(ctx, {
		userId: args.userId,
		now: args.now ?? Date.now(),
	});

	const user = await ctx.db.get("users", args.userId);
	if (!user?.defaultWorkspaceId || !user.defaultProjectId) {
		throw new Error("Failed to seed default workspace");
	}

	const workspace = await ctx.db.get("workspaces", user.defaultWorkspaceId);
	if (!workspace) {
		throw new Error("Failed to load seeded default workspace");
	}

	return Result({
		_yay: {
			workspaceId: user.defaultWorkspaceId,
			defaultProjectId: user.defaultProjectId,
			name: workspace.name,
			defaultProjectName: "home",
		},
	});
}

async function workspaces_test_bootstrap_user(t: ReturnType<typeof test_convex>, args: { userId: Id<"users"> }) {
	await t.run(async (ctx) => {
		const now = Date.now();
		await quotas_db_ensure(ctx, {
			quotaName: "extra_workspaces",
			userId: args.userId,
			now,
		});

		await workspaces_db_ensure_default_workspace_and_project_for_user(ctx, {
			userId: args.userId,
			now,
		});
	});
}

async function workspaces_test_bootstrap_users(
	t: ReturnType<typeof test_convex>,
	args: { userIds: readonly Id<"users">[] },
) {
	await Promise.all(args.userIds.map((userId) => workspaces_test_bootstrap_user(t, { userId })));
}

async function workspaces_test_read_user_extra_workspace_quota_doc(ctx: MutationCtx, args: { userId: Id<"users"> }) {
	return await ctx.db
		.query("quotas")
		.withIndex("by_user_quotaName", (q) => q.eq("userId", args.userId).eq("quotaName", "extra_workspaces"))
		.first();
}

async function workspaces_test_read_workspace_extra_project_quota_doc(
	ctx: MutationCtx,
	args: { workspaceId: Id<"workspaces"> },
) {
	return await ctx.db
		.query("quotas")
		.withIndex("by_workspace_quotaName", (q) =>
			q.eq("workspaceId", args.workspaceId).eq("quotaName", "extra_projects"),
		)
		.first();
}

async function workspaces_test_collect_notifications_for_user(ctx: MutationCtx, args: { userId: Id<"users"> }) {
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

async function workspaces_test_seed_project_scoped_rows(
	ctx: MutationCtx,
	args: {
		userId: Id<"users">;
		workspaceId: string;
		projectId: string;
		tag: string;
	},
) {
	const nodeId = await ctx.db.insert("files_nodes", {
		workspaceId: args.workspaceId,
		projectId: args.projectId,
		path: `/${args.tag}-page`,
		name: `${args.tag}-page`,
		kind: "file",
		version: 0,
		parentId: "root",
		createdBy: args.userId,
		updatedBy: args.userId,
		updatedAt: Date.now(),
	});
	const markdownContentId = await ctx.db.insert("files_markdown_content", {
		workspaceId: args.workspaceId,
		projectId: args.projectId,
		nodeId: nodeId,
		content: `# ${args.tag}`,
		isArchived: false,
		yjsSequence: 0,
		updatedAt: Date.now(),
		updatedBy: args.userId,
	});
	const yjsLastSequenceId = await ctx.db.insert("files_yjs_docs_last_sequences", {
		workspaceId: args.workspaceId,
		projectId: args.projectId,
		nodeId: nodeId,
		lastSequence: 0,
	});
	await ctx.db.patch("files_nodes", nodeId, {
		markdownContentId,
		yjsLastSequenceId,
	});

	const aiThreadId = await ctx.db.insert("ai_chat_threads", {
		workspaceId: args.workspaceId,
		projectId: args.projectId,
		clientGeneratedId: `${args.tag}-thread`,
		title: `${args.tag} thread`,
		archived: false,
		runtime: "aisdk_5",
		createdBy: args.userId,
		updatedBy: args.userId,
		updatedAt: Date.now(),
		lastMessageAt: Date.now(),
	});
	await ctx.db.insert("ai_chat_threads_messages_aisdk_5", {
		workspaceId: args.workspaceId,
		projectId: args.projectId,
		parentId: null,
		threadId: aiThreadId,
		clientGeneratedMessageId: `${args.tag}-message`,
		content: {},
		createdBy: args.userId,
		updatedAt: Date.now(),
	});

	await ctx.db.insert("chat_messages", {
		workspaceId: args.workspaceId,
		projectId: args.projectId,
		threadId: null,
		parentId: null,
		isArchived: false,
		createdBy: args.userId,
		content: `${args.tag} chat`,
	});
}

describe("create_workspace", () => {
	test("accepts names with digits after the first character", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-digits-ws",
			}),
		);
		await workspaces_test_bootstrap_user(t, { userId });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "workspaces-test-user@test.local",
		});

		const result = await asUser.mutation(api.workspaces.create_workspace, {
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
		await workspaces_test_bootstrap_user(t, { userId });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "workspaces-test-user@test.local",
		});

		const result = await asUser.mutation(api.workspaces.create_workspace, {
			description: "",
			name: "acme-labs",
		});

		expect(result._yay).toBeTruthy();
		expect(result._yay?.name).toBe("acme-labs");
		expect(result._yay?.defaultProjectName).toBe("home");

		const { workspace, project, ownerRole, permissionGrants, userQuota, workspaceQuota } = result._yay
			? await t.run(async (ctx) => {
					const [workspace, project, ownerRole, permissionGrants, userQuota, workspaceQuota] = await Promise.all([
						ctx.db.get("workspaces", result._yay!.workspaceId),
						ctx.db.get("workspaces_projects", result._yay!.defaultProjectId),
						ctx.db
							.query("access_control_role_assignments")
							.withIndex("by_workspace_project_role_user", (q) =>
								q
									.eq("workspaceId", result._yay!.workspaceId)
									.eq("projectId", result._yay!.defaultProjectId)
									.eq("role", "owner"),
							)
							.first(),
						ctx.db
							.query("access_control_permission_grants")
							.withIndex("by_workspace_project_resource_user_permission", (q) =>
								q.eq("workspaceId", result._yay!.workspaceId),
							)
							.collect(),
						workspaces_test_read_user_extra_workspace_quota_doc(ctx, { userId }),
						workspaces_test_read_workspace_extra_project_quota_doc(ctx, { workspaceId: result._yay!.workspaceId }),
					]);

					return {
						workspace,
						project,
						ownerRole,
						permissionGrants,
						userQuota,
						workspaceQuota,
					};
				})
			: {
					workspace: null,
					project: null,
					ownerRole: null,
					permissionGrants: [],
					userQuota: null,
					workspaceQuota: null,
				};

		expect(workspace?.name).toBe("acme-labs");
		expect(workspace?.billingMode).toBe("user");
		expect(workspace?.ownerUserId).toBe(userId);
		expect(ownerRole?.userId).toBe(userId);
		expect(permissionGrants.some((grant) => grant.role === "member" && grant.permission === "project.create")).toBe(
			true,
		);
		expect(
			permissionGrants.some((grant) => grant.role === "admin" && grant.permission === "workspace.members.manage"),
		).toBe(true);
		expect(
			permissionGrants.some((grant) => grant.role === "member" && grant.permission === "workspace.members.manage"),
		).toBe(false);
		expect(
			permissionGrants.some((grant) => grant.role === "admin" && grant.permission === "workspace.roles.manage"),
		).toBe(true);
		expect(project?.name).toBe("home");
		expect(userQuota?.usedCount).toBe(1);
		expect(userQuota?.maxCount).toBe(2);
		expect(workspaceQuota?.usedCount).toBe(0);
		expect(workspaceQuota?.maxCount).toBe(1);
	});

	test("rejects names that are still invalid after autofix", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-2",
			}),
		);
		await workspaces_test_bootstrap_user(t, { userId });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "workspaces-test-user@test.local",
		});

		const invalidNames = ["", "!!!", "---", "   ", "\t\t", "ab", "a", "12"];

		for (const name of invalidNames) {
			const result = await asUser.mutation(api.workspaces.create_workspace, {
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
		await workspaces_test_bootstrap_user(t, { userId });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "workspaces-test-user@test.local",
		});

		const result = await asUser.mutation(api.workspaces.create_workspace, {
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
		await workspaces_test_bootstrap_user(t, { userId });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "workspaces-test-user@test.local",
		});

		const result = await asUser.mutation(api.workspaces.create_workspace, {
			description: "",
			name: "a".repeat(workspaces_NAME_MAX_LENGTH + 1),
		});

		expect(result._nay?.message).toBe("Name must be at most 20 characters");
	});

	test("autofixes messy workspace names before create", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-autofix-ws",
			}),
		);
		await workspaces_test_bootstrap_user(t, { userId });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "workspaces-test-user@test.local",
		});

		const result = await asUser.mutation(api.workspaces.create_workspace, {
			description: "",
			name: "  Acme Labs!!  ",
		});

		expect(result._yay?.name).toBe("acme-labs");
	});

	test("rejects duplicate global workspace names", async () => {
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
		await workspaces_test_bootstrap_users(t, { userIds });

		const firstUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userIds[0],
			name: "First User",
			email: "workspaces-test-user@test.local",
		});
		const secondUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userIds[1],
			name: "Second User",
			email: "workspaces-test-user@test.local",
		});

		const firstResult = await firstUser.mutation(api.workspaces.create_workspace, {
			description: "",
			name: "acme",
		});
		expect(firstResult._yay).toBeTruthy();

		const secondResult = await secondUser.mutation(api.workspaces.create_workspace, {
			description: "",
			name: "acme",
		});
		expect(secondResult._nay?.message).toBe("Workspace name already exists");
	});

	test("allows duplicate default personal workspaces across users", async () => {
		const t = test_convex();
		const results = await t.run(async (ctx) =>
			Promise.all([
				ctx.db
					.insert("users", {
						clerkUserId: "clerk-user-4",
					})
					.then((userId) => workspaces_test_seed_default_workspace(ctx, { userId })),
				ctx.db
					.insert("users", {
						clerkUserId: "clerk-user-5",
					})
					.then((userId) => workspaces_test_seed_default_workspace(ctx, { userId })),
			]),
		);

		expect(results[0]._yay).toBeTruthy();
		expect(results[1]._yay).toBeTruthy();
	});

	test("stores empty description as empty string on workspace and default project", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-ws-desc-empty",
			}),
		);
		await workspaces_test_bootstrap_user(t, { userId });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "workspaces-test-user@test.local",
		});

		const result = await asUser.mutation(api.workspaces.create_workspace, {
			description: "",
			name: "with-empty-desc",
		});
		expect(result._yay).toBeTruthy();

		const workspace = await t.run((ctx) => ctx.db.get("workspaces", result._yay!.workspaceId));
		const project = await t.run((ctx) => ctx.db.get("workspaces_projects", result._yay!.defaultProjectId));
		expect(workspace?.description).toBe("");
		expect(project?.description).toBe("");
	});

	test("trims workspace description", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-ws-desc-trim",
			}),
		);
		await workspaces_test_bootstrap_user(t, { userId });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "workspaces-test-user@test.local",
		});

		const result = await asUser.mutation(api.workspaces.create_workspace, {
			description: "  north star  ",
			name: "trim-desc-ws",
		});
		expect(result._yay).toBeTruthy();

		const workspace = await t.run((ctx) => ctx.db.get("workspaces", result._yay!.workspaceId));
		expect(workspace?.description).toBe("north star");
	});

	test("rejects description longer than max length", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-ws-desc-long",
			}),
		);
		await workspaces_test_bootstrap_user(t, { userId });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "workspaces-test-user@test.local",
		});

		const result = await asUser.mutation(api.workspaces.create_workspace, {
			description: "x".repeat(workspaces_DESCRIPTION_MAX_LENGTH + 1),
			name: "long-desc-ws",
		});
		expect(result._nay?.message).toBe("Description is too long");
	});

	test("rejects creating a third owned non-default workspace", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-third-extra-workspace",
			}),
		);
		await workspaces_test_bootstrap_user(t, { userId });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "workspaces-test-user@test.local",
		});

		const first = await t.run((ctx) =>
			workspaces_db_create(ctx, {
				userId,
				description: "",
				name: "first-extra-ws",
				now: Date.now(),
				default: false,
			}),
		);
		expect(first._yay).toBeTruthy();

		const second = await t.run((ctx) =>
			workspaces_db_create(ctx, {
				userId,
				description: "",
				name: "second-extra-ws",
				now: Date.now(),
				default: false,
			}),
		);
		expect(second._yay).toBeTruthy();

		const third = await asUser.mutation(api.workspaces.create_workspace, {
			description: "",
			name: "third-extra-ws",
		});
		expect(third._nay?.message).toBe("Workspace quota reached");
	});

	test("does not count shared non-default workspaces against the owner's extra-workspace quota", async () => {
		const t = test_convex();
		const [ownerId, memberId] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", { clerkUserId: "clerk-user-owned-extra-owner" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-owned-extra-member" }),
			]),
		);
		await workspaces_test_bootstrap_users(t, { userIds: [ownerId, memberId] });
		const owner = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: ownerId,
			name: "Owner",
			email: "workspaces-test-user@test.local",
		});
		const member = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: memberId,
			name: "Member",
			email: "workspaces-test-user@test.local",
		});

		const sharedWorkspace = await owner.mutation(api.workspaces.create_workspace, {
			description: "",
			name: "shared-extra-ws",
		});
		expect(sharedWorkspace._yay).toBeTruthy();

		const shareResult = await owner.mutation(api.workspaces.invite_user_to_workspace_project, {
			workspaceId: sharedWorkspace._yay!.workspaceId,
			projectId: sharedWorkspace._yay!.defaultProjectId,
			userIdToAdd: memberId,
		});
		expect(shareResult._yay).toBeNull();

		const ownWorkspace = await member.mutation(api.workspaces.create_workspace, {
			description: "",
			name: "member-owned-ws",
		});
		expect(ownWorkspace._yay?.name).toBe("member-owned-ws");
	});

	test("keeps exactly one user quota doc while creating extra workspaces", async () => {
		const t = test_convex();
		const userId = await t.run((ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-quota-seed-workspace",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "workspaces-test-user@test.local",
		});
		await workspaces_test_bootstrap_user(t, { userId });

		const before = await t.run(async (ctx) =>
			(await ctx.db.query("quotas").collect()).filter(
				(doc) => doc.userId === userId && doc.quotaName === "extra_workspaces",
			),
		);
		expect(before).toHaveLength(1);
		expect(before[0]?.usedCount).toBe(0);

		const created = await t.run((ctx) =>
			workspaces_db_create(ctx, {
				userId,
				description: "",
				name: "lazy-seed-extra-ws",
				now: Date.now(),
				default: false,
			}),
		);
		expect(created._yay).toBeTruthy();

		const secondCreated = await t.run((ctx) =>
			workspaces_db_create(ctx, {
				userId,
				description: "",
				name: "lazy-seed-extra-ws-2",
				now: Date.now(),
				default: false,
			}),
		);
		expect(secondCreated._yay).toBeTruthy();

		const blocked = await asUser.mutation(api.workspaces.create_workspace, {
			description: "",
			name: "lazy-seed-extra-ws-3",
		});
		expect(blocked._nay?.message).toBe("Workspace quota reached");

		const after = await t.run(async (ctx) => {
			const [userQuotas, workspaceQuotas] = await Promise.all([
				ctx.db.query("quotas").collect(),
				ctx.db.query("quotas").collect(),
			]);

			return {
				userQuotas: userQuotas.filter(
					(doc) => doc.userId === userId && doc.quotaName === "extra_workspaces",
				),
				workspaceQuotas: workspaceQuotas.filter(
					(doc) => doc.workspaceId === created._yay!.workspaceId && doc.quotaName === "extra_projects",
				),
			};
		});

		expect(after.userQuotas).toHaveLength(1);
		expect(after.userQuotas[0]?.usedCount).toBe(2);
		expect(after.userQuotas[0]?.maxCount).toBe(2);
		expect(after.workspaceQuotas).toHaveLength(1);
		expect(after.workspaceQuotas[0]?.usedCount).toBe(0);
	});
});

describe("workspaces_db_ensure_default_workspace_and_project_for_user", () => {
	test("ensures default-workspace bootstrap creates workspace quotas when user quotas exist", async () => {
		const t = test_convex();
		const userId = await t.run((ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-ensure-default-quotas",
			}),
		);

		await t.run(async (ctx) => {
			const now = Date.now();
			await quotas_db_ensure(ctx, {
				quotaName: "extra_workspaces",
				userId,
				now,
			});
			await workspaces_db_ensure_default_workspace_and_project_for_user(ctx, {
				userId,
				now,
			});
		});

		const rows = await t.run(async (ctx) => {
			const user = await ctx.db.get("users", userId);
			const workspaceQuota = user?.defaultWorkspaceId
				? await workspaces_test_read_workspace_extra_project_quota_doc(ctx, { workspaceId: user.defaultWorkspaceId })
				: null;
			const userQuota = await workspaces_test_read_user_extra_workspace_quota_doc(ctx, { userId });

			return {
				user,
				userQuota,
				workspaceQuota,
			};
		});

		expect(rows.userQuota?.usedCount).toBe(0);
		expect(rows.userQuota?.maxCount).toBe(2);
		expect(rows.workspaceQuota?.usedCount).toBe(0);
		expect(rows.workspaceQuota?.maxCount).toBe(1);
	});

	test("creates exactly one personal/home default during anonymous user bootstrap", async () => {
		const t = test_convex();

		const userId = await t.run((ctx) =>
			ctx.db.insert("users", {
				clerkUserId: null,
			}),
		);
		await workspaces_test_bootstrap_user(t, { userId });
		const after = await t.run(async (ctx) => {
			const user = await ctx.db.get("users", userId);
			const workspace = user?.defaultWorkspaceId ? await ctx.db.get("workspaces", user.defaultWorkspaceId) : null;
			const project = user?.defaultProjectId ? await ctx.db.get("workspaces_projects", user.defaultProjectId) : null;
			const memberships = await ctx.db
				.query("workspaces_projects_users")
				.withIndex("by_user_workspace_project_active", (q) => q.eq("userId", userId))
				.collect();

			return {
				defaultPersonalMemberships: memberships.filter(
					(membership) =>
						membership.workspaceId === user?.defaultWorkspaceId && membership.projectId === user?.defaultProjectId,
				),
				project,
				workspace,
			};
		});

		expect(after.workspace?.default).toBe(true);
		expect(after.workspace?.name).toBe("personal");
		expect(after.project?.default).toBe(true);
		expect(after.project?.name).toBe("home");
		expect(after.project?.workspaceId).toBe(after.workspace?._id);
		expect(after.workspace?.defaultProjectId).toBe(after.project?._id);
		expect(after.defaultPersonalMemberships).toHaveLength(1);
	});

	test("does not create a second personal/home default when the user already has one", async () => {
		const t = test_convex();
		const userId = await t.run((ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-ensure-default-reuse",
			}),
		);

		const seeded = await t.run((ctx) => workspaces_test_seed_default_workspace(ctx, { userId }));
		expect(seeded._yay).toBeTruthy();

		await t.run(async (ctx) => {
			await workspaces_db_ensure_default_workspace_and_project_for_user(ctx, {
				userId,
				now: Date.now(),
			});
		});

		const after = await t.run(async (ctx) => {
			const user = await ctx.db.get("users", userId);
			const memberships = await ctx.db
				.query("workspaces_projects_users")
				.withIndex("by_user_workspace_project_active", (q) => q.eq("userId", userId))
				.collect();

			const defaultWorkspaces = (
				await Promise.all(
					memberships.map(async (membership) => {
						const workspace = await ctx.db.get("workspaces", membership.workspaceId);
						const project = await ctx.db.get("workspaces_projects", membership.projectId);

						if (
							workspace?.default &&
							workspace.name === "personal" &&
							project?.default &&
							project.name === "home" &&
							project.workspaceId === workspace._id
						) {
							return { project, workspace };
						}

						return null;
					}),
				)
			).filter((row) => row !== null);

			return {
				defaultWorkspaces,
				user,
			};
		});

		expect(after.defaultWorkspaces).toHaveLength(1);
		expect(after.user?.defaultWorkspaceId).toBe(seeded._yay!.workspaceId);
		expect(after.user?.defaultProjectId).toBe(seeded._yay!.defaultProjectId);
	});
});

describe("create_project", () => {
	test("creates a project for a member workspace", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-create-proj",
			}),
		);
		await workspaces_test_bootstrap_user(t, { userId });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "workspaces-test-user@test.local",
		});

		const wsResult = await asUser.mutation(api.workspaces.create_workspace, {
			description: "",
			name: "proj-workspace",
		});
		expect(wsResult._yay).toBeTruthy();

		const result = await asUser.mutation(api.workspaces.create_project, {
			description: "",
			workspaceId: wsResult._yay!.workspaceId,
			name: "docs",
		});

		expect(result._yay?.name).toBe("docs");

		const membership = result._yay
			? await t.run(async (ctx) => {
					const [membership, roleAssignment, projectGrant, workspaceQuota] = await Promise.all([
						ctx.db
							.query("workspaces_projects_users")
							.withIndex("by_project_user_active", (q) =>
								q.eq("projectId", result._yay!.projectId).eq("userId", userId),
							)
							.first(),
						ctx.db
							.query("access_control_role_assignments")
							.withIndex("by_workspace_project_user_role", (q) =>
								q
									.eq("workspaceId", wsResult._yay!.workspaceId)
									.eq("projectId", result._yay!.projectId)
									.eq("userId", userId)
									.eq("role", "member"),
							)
							.first(),
						ctx.db
							.query("access_control_permission_grants")
							.withIndex("by_workspace_project_resource_role_permission", (q) =>
								q
									.eq("workspaceId", wsResult._yay!.workspaceId)
									.eq("projectId", result._yay!.projectId)
									.eq("resourceKind", "project")
									.eq("resourceId", String(result._yay!.projectId))
									.eq("principalKind", "role")
									.eq("role", "member")
									.eq("permission", "project.update"),
							)
							.first(),
						workspaces_test_read_workspace_extra_project_quota_doc(ctx, { workspaceId: wsResult._yay!.workspaceId }),
					]);

					return {
						membership,
						roleAssignment,
						projectGrant,
						workspaceQuota,
					};
				})
			: null;
		expect(membership?.membership).toBeTruthy();
		expect(membership?.roleAssignment).toBeTruthy();
		expect(membership?.projectGrant).toBeTruthy();
		expect(membership?.workspaceQuota?.usedCount).toBe(1);
	});

	test("stores trimmed project description", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-proj-desc",
			}),
		);
		await workspaces_test_bootstrap_user(t, { userId });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "workspaces-test-user@test.local",
		});

		const wsResult = await asUser.mutation(api.workspaces.create_workspace, {
			description: "",
			name: "proj-desc-ws",
		});
		expect(wsResult._yay).toBeTruthy();

		const result = await asUser.mutation(api.workspaces.create_project, {
			description: "  sprints  ",
			workspaceId: wsResult._yay!.workspaceId,
			name: "board",
		});
		expect(result._yay).toBeTruthy();

		const project = await t.run((ctx) => ctx.db.get("workspaces_projects", result._yay!.projectId));
		expect(project?.description).toBe("sprints");
	});

	test("rejects duplicate project names in the same workspace", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-create-proj-dup",
			}),
		);
		await workspaces_test_bootstrap_user(t, { userId });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "workspaces-test-user@test.local",
		});

		const wsResult = await t.run((ctx) =>
			workspaces_db_create(ctx, {
				userId,
				description: "",
				name: "dup-proj-ws",
				now: Date.now(),
			}),
		);
		if (wsResult._nay) {
			throw new Error(wsResult._nay.message);
		}
		expect(wsResult._yay).toBeTruthy();

		const first = await asUser.mutation(api.workspaces.create_project, {
			description: "",
			workspaceId: wsResult._yay!.workspaceId,
			name: "alpha",
		});
		expect(first._yay).toBeTruthy();

		const second = await asUser.mutation(api.workspaces.create_project, {
			description: "",
			workspaceId: wsResult._yay!.workspaceId,
			name: "alpha",
		});
		expect(second._nay?.message).toBe("Project name already exists");
	});

	test("autofixes messy project names before create", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-autofix-proj",
			}),
		);
		await workspaces_test_bootstrap_user(t, { userId });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "workspaces-test-user@test.local",
		});

		const wsResult = await asUser.mutation(api.workspaces.create_workspace, {
			description: "",
			name: "autofix-proj-ws",
		});
		expect(wsResult._yay).toBeTruthy();

		const result = await asUser.mutation(api.workspaces.create_project, {
			description: "",
			workspaceId: wsResult._yay!.workspaceId,
			name: "  My Docs!!  ",
		});

		expect(result._yay?.name).toBe("my-docs");
	});

	test("accepts project names with digits after the first character", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-digits-proj",
			}),
		);
		await workspaces_test_bootstrap_user(t, { userId });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "workspaces-test-user@test.local",
		});

		const wsResult = await asUser.mutation(api.workspaces.create_workspace, {
			description: "",
			name: "digits-proj-ws",
		});
		expect(wsResult._yay).toBeTruthy();

		const result = await asUser.mutation(api.workspaces.create_project, {
			description: "",
			workspaceId: wsResult._yay!.workspaceId,
			name: "sprint-2",
		});

		expect(result._yay?.name).toBe("sprint-2");
	});

	test("rejects when the user is not in the workspace", async () => {
		const t = test_convex();
		const userIds = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", { clerkUserId: "clerk-user-proj-a" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-proj-b" }),
			]),
		);
		await workspaces_test_bootstrap_users(t, { userIds });

		const owner = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userIds[0],
			name: "Owner",
			email: "workspaces-test-user@test.local",
		});

		const wsResult = await owner.mutation(api.workspaces.create_workspace, {
			description: "",
			name: "private-ws",
		});
		expect(wsResult._yay).toBeTruthy();

		const stranger = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userIds[1],
			name: "Stranger",
			email: "workspaces-test-user@test.local",
		});

		const result = await stranger.mutation(api.workspaces.create_project, {
			description: "",
			workspaceId: wsResult._yay!.workspaceId,
			name: "intruder",
		});
		expect(result._nay?.message).toBe("Workspace not found");
	});

	test("allows creating a non-default project in the default workspace", async () => {
		const t = test_convex();
		const userId = await t.run((ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-default-proj-create-block",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "workspaces-test-user@test.local",
		});

		const created = await t.run((ctx) => workspaces_test_seed_default_workspace(ctx, { userId }));
		expect(created._yay).toBeTruthy();

		const result = await asUser.mutation(api.workspaces.create_project, {
			description: "",
			workspaceId: created._yay!.workspaceId,
			name: "docs",
		});

		expect(result._yay).toBeTruthy();
		expect(result._yay?.name).toBe("docs");
	});

	test("rejects creating a second non-default project in the same workspace", async () => {
		const t = test_convex();
		const userId = await t.run((ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-second-extra-project",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "workspaces-test-user@test.local",
		});

		const created = await t.run((ctx) => workspaces_test_seed_default_workspace(ctx, { userId }));
		expect(created._yay).toBeTruthy();

		const first = await asUser.mutation(api.workspaces.create_project, {
			description: "",
			workspaceId: created._yay!.workspaceId,
			name: "docs",
		});
		expect(first._yay).toBeTruthy();

		const second = await asUser.mutation(api.workspaces.create_project, {
			description: "",
			workspaceId: created._yay!.workspaceId,
			name: "board",
		});
		expect(second._nay?.message).toBe("Project quota reached");
	});

	test("does not let a shared member bypass the extra-project quota", async () => {
		const t = test_convex();
		const [ownerId, memberId] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", { clerkUserId: "clerk-user-project-quota-owner" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-project-quota-member" }),
			]),
		);
		await workspaces_test_bootstrap_users(t, { userIds: [ownerId, memberId] });
		const owner = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: ownerId,
			name: "Owner",
			email: "workspaces-test-user@test.local",
		});
		const member = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: memberId,
			name: "Member",
			email: "workspaces-test-user@test.local",
		});

		const sharedWorkspace = await t.run((ctx) =>
			workspaces_db_create(ctx, {
				userId: ownerId,
				description: "",
				name: "shared-proj-quota",
				now: Date.now(),
			}),
		);
		if (sharedWorkspace._nay) {
			throw new Error(sharedWorkspace._nay.message);
		}
		expect(sharedWorkspace._yay).toBeTruthy();

		const extraProject = await t.run((ctx) =>
			workspaces_db_create_project(ctx, {
				userId: ownerId,
				description: "",
				workspaceId: sharedWorkspace._yay!.workspaceId,
				name: "docs",
				now: Date.now(),
			}),
		);
		if (extraProject._nay) {
			throw new Error(extraProject._nay.message);
		}
		expect(extraProject._yay).toBeTruthy();

		const shareResult = await owner.mutation(api.workspaces.invite_user_to_workspace_project, {
			workspaceId: sharedWorkspace._yay!.workspaceId,
			projectId: sharedWorkspace._yay!.defaultProjectId,
			userIdToAdd: memberId,
		});
		expect(shareResult._yay).toBeNull();

		const result = await member.mutation(api.workspaces.create_project, {
			description: "",
			workspaceId: sharedWorkspace._yay!.workspaceId,
			name: "board",
		});
		expect(result._nay?.message).toBe("Project quota reached");
	});

	test("keeps exactly one workspace quota doc while creating the extra project", async () => {
		const t = test_convex();
		const userId = await t.run((ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-quota-seed-project",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "workspaces-test-user@test.local",
		});
		await workspaces_test_bootstrap_user(t, { userId });

		const workspaceResult = await t.run((ctx) =>
			workspaces_db_create(ctx, {
				userId,
				description: "",
				name: "lazy-seed-proj-ws",
				now: Date.now(),
			}),
		);
		if (workspaceResult._nay) {
			throw new Error(workspaceResult._nay.message);
		}
		expect(workspaceResult._yay).toBeTruthy();

		const before = await t.run(async (ctx) =>
			(await ctx.db.query("quotas").collect()).filter(
				(doc) => doc.workspaceId === workspaceResult._yay!.workspaceId && doc.quotaName === "extra_projects",
			),
		);
		expect(before).toHaveLength(1);
		expect(before[0]?.usedCount).toBe(0);

		const created = await asUser.mutation(api.workspaces.create_project, {
			description: "",
			workspaceId: workspaceResult._yay!.workspaceId,
			name: "lazy-seeded-project",
		});
		expect(created._yay).toBeTruthy();

		const blocked = await asUser.mutation(api.workspaces.create_project, {
			description: "",
			workspaceId: workspaceResult._yay!.workspaceId,
			name: "seeded-two",
		});
		expect(blocked._nay?.message).toBe("Project quota reached");

		const after = await t.run(async (ctx) =>
			(await ctx.db.query("quotas").collect()).filter(
				(doc) => doc.workspaceId === workspaceResult._yay!.workspaceId && doc.quotaName === "extra_projects",
			),
		);
		expect(after).toHaveLength(1);
		expect(after[0]?._id).toBe(before[0]?._id);
		expect(after[0]?.usedCount).toBe(1);
		expect(after[0]?.maxCount).toBe(1);
	});
});

describe("invite_user_to_workspace_project with userIdToAdd", () => {
	test("rejects adding another user to the default workspace", async () => {
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
			email: "workspaces-test-user@test.local",
		});

		const created = await t.run((ctx) => workspaces_test_seed_default_workspace(ctx, { userId: ownerId }));
		expect(created._yay).toBeTruthy();

		const result = await owner.mutation(api.workspaces.invite_user_to_workspace_project, {
			workspaceId: created._yay!.workspaceId,
			projectId: created._yay!.defaultProjectId,
			userIdToAdd: memberId,
		});

		expect(result._nay?.message).toBe("Cannot add user to default workspace");
	});
});

describe("invite_user_to_workspace_project", () => {
	test("rejects invites to the default workspace", async () => {
		const t = test_convex();
		const [ownerId, invitedUserId] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", { clerkUserId: "clerk-user-default-invite-owner" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-default-invite-invitee" }),
			]),
		);
		await workspaces_test_bootstrap_users(t, { userIds: [ownerId, invitedUserId] });
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
		if (!ownerUser?.defaultWorkspaceId || !ownerUser.defaultProjectId) {
			throw new Error("Expected owner default workspace");
		}

		const owner = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: ownerId,
			name: "Owner",
			email: "default-invite-owner@test.local",
		});

		const result = await owner.mutation(api.workspaces.invite_user_to_workspace_project, {
			workspaceId: ownerUser.defaultWorkspaceId,
			projectId: ownerUser.defaultProjectId,
			email: "default-invitee@test.local",
		});

		expect(result._nay?.message).toBe("Cannot add user to default workspace");
	});

	test("adds home and selected project memberships, creates a notification, and supports removal", async () => {
		const t = test_convex();
		const [ownerId, invitedUserId] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", { clerkUserId: "clerk-user-invite-owner" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-invite-invitee" }),
			]),
		);
		await workspaces_test_bootstrap_users(t, { userIds: [ownerId, invitedUserId] });
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
			workspaces_db_create(ctx, {
				userId: ownerId,
				description: "",
				name: "invite-team",
				now: Date.now(),
			}),
		);
		expect(created._yay).toBeTruthy();
		const selectedProject = await t.run((ctx) =>
			workspaces_db_create_project(ctx, {
				userId: ownerId,
				description: "",
				workspaceId: created._yay!.workspaceId,
				name: "roadmap",
				now: Date.now(),
			}),
		);
		expect(selectedProject._yay).toBeTruthy();

		const inviteResult = await owner.mutation(api.workspaces.invite_user_to_workspace_project, {
			workspaceId: created._yay!.workspaceId,
			projectId: selectedProject._yay!.projectId,
			email: "Invited-User@Test.Local",
		});
		expect(inviteResult._yay).toBeNull();

		const afterInvite = await t.run(async (ctx) => {
			const [memberships, notifications, roleAssignments] = await Promise.all([
				ctx.db
					.query("workspaces_projects_users")
					.withIndex("by_active_user_workspace_project", (q) =>
						q.eq("active", true).eq("userId", invitedUserId).eq("workspaceId", created._yay!.workspaceId),
					)
					.collect(),
				ctx.db
					.query("notifications")
					.withIndex("by_user_read", (q) => q.eq("userId", invitedUserId).eq("read", false))
					.collect(),
				ctx.db
					.query("access_control_role_assignments")
					.withIndex("by_workspace_user_project_role", (q) =>
						q.eq("workspaceId", created._yay!.workspaceId).eq("userId", invitedUserId),
					)
					.collect(),
			]);

			return { memberships, notifications, roleAssignments };
		});

		expect(afterInvite.memberships.map((membership) => membership.projectId).sort()).toEqual(
			[created._yay!.defaultProjectId, selectedProject._yay!.projectId].sort(),
		);
		expect(afterInvite.roleAssignments.map((assignment) => assignment.projectId).sort()).toEqual(
			[created._yay!.defaultProjectId, selectedProject._yay!.projectId].sort(),
		);
		expect(afterInvite.notifications).toHaveLength(1);
		expect(afterInvite.notifications[0]?.read).toBe(false);
		expect(afterInvite.notifications[0]?.workspaceId).toBe(created._yay!.workspaceId);
		expect(afterInvite.notifications[0]?.projectId).toBe(selectedProject._yay!.projectId);

		const homeProjectUserIds = await owner.query(api.workspaces.list_workspace_project_users, {
			workspaceId: created._yay!.workspaceId,
			projectId: created._yay!.defaultProjectId,
		});
		expect(homeProjectUserIds?.toSorted()).toEqual([ownerId, invitedUserId].toSorted());

		const selectedProjectUserIds = await owner.query(api.workspaces.list_workspace_project_users, {
			workspaceId: created._yay!.workspaceId,
			projectId: selectedProject._yay!.projectId,
		});
		expect(selectedProjectUserIds?.toSorted()).toEqual([ownerId, invitedUserId].toSorted());

		const removeResult = await owner.mutation(api.workspaces.remove_user_from_workspace, {
			workspaceId: created._yay!.workspaceId,
			userIdToRemove: invitedUserId,
		});
		expect(removeResult._yay).toBeNull();

		const afterRemove = await t.run(async (ctx) => {
			const [membershipsAfterRemove, roleAssignmentsAfterRemove, notificationsAfterRemove] = await Promise.all([
				ctx.db
					.query("workspaces_projects_users")
					.withIndex("by_active_user_workspace_project", (q) =>
						q.eq("active", true).eq("userId", invitedUserId).eq("workspaceId", created._yay!.workspaceId),
					)
					.collect(),
				ctx.db
					.query("access_control_role_assignments")
					.withIndex("by_workspace_user_project_role", (q) =>
						q.eq("workspaceId", created._yay!.workspaceId).eq("userId", invitedUserId),
					)
					.collect(),
				ctx.db
					.query("notifications")
					.withIndex("by_workspace_user_read", (q) =>
						q.eq("workspaceId", created._yay!.workspaceId).eq("userId", invitedUserId),
					)
					.collect(),
			]);
			return { membershipsAfterRemove, roleAssignmentsAfterRemove, notificationsAfterRemove };
		});
		expect(afterRemove.membershipsAfterRemove).toHaveLength(0);
		expect(afterRemove.roleAssignmentsAfterRemove).toHaveLength(0);
		expect(afterRemove.notificationsAfterRemove).toHaveLength(0);
	});

	test("allows a workspace admin to invite users", async () => {
		const t = test_convex();
		const [ownerId, adminId, invitedUserId] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", { clerkUserId: "clerk-user-admin-invite-owner" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-admin-invite-admin" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-admin-invite-invitee" }),
			]),
		);
		await workspaces_test_bootstrap_users(t, { userIds: [ownerId, adminId, invitedUserId] });

		const created = await t.run((ctx) =>
			workspaces_db_create(ctx, {
				userId: ownerId,
				description: "",
				name: "admin-invite-team",
				now: Date.now(),
			}),
		);
		expect(created._yay).toBeTruthy();

		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert("workspaces_projects_users", {
				workspaceId: created._yay!.workspaceId,
				projectId: created._yay!.defaultProjectId,
				userId: adminId,
				active: true,
				updatedAt: now,
			});
			await access_control_db_ensure_role_assignment(ctx, {
				workspaceId: created._yay!.workspaceId,
				projectId: created._yay!.defaultProjectId,
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

		const result = await admin.mutation(api.workspaces.invite_user_to_workspace_project, {
			workspaceId: created._yay!.workspaceId,
			projectId: created._yay!.defaultProjectId,
			userIdToAdd: invitedUserId,
		});
		expect(result._yay).toBeNull();

		const afterInvite = await t.run(async (ctx) => {
			const [membership, notification] = await Promise.all([
				ctx.db
					.query("workspaces_projects_users")
					.withIndex("by_active_user_workspace_project", (q) =>
						q
							.eq("active", true)
							.eq("userId", invitedUserId)
							.eq("workspaceId", created._yay!.workspaceId)
							.eq("projectId", created._yay!.defaultProjectId),
					)
					.first(),
				ctx.db
					.query("notifications")
					.withIndex("by_workspace_user_read", (q) =>
						q
							.eq("workspaceId", created._yay!.workspaceId)
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

	test("rejects invites from regular workspace members", async () => {
		const t = test_convex();
		const [ownerId, memberId, invitedUserId] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", { clerkUserId: "clerk-user-member-invite-owner" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-member-invite-member" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-member-invite-invitee" }),
			]),
		);
		await workspaces_test_bootstrap_users(t, { userIds: [ownerId, memberId, invitedUserId] });

		const created = await t.run((ctx) =>
			workspaces_db_create(ctx, {
				userId: ownerId,
				description: "",
				name: "member-invite-team",
				now: Date.now(),
			}),
		);
		expect(created._yay).toBeTruthy();

		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert("workspaces_projects_users", {
				workspaceId: created._yay!.workspaceId,
				projectId: created._yay!.defaultProjectId,
				userId: memberId,
				active: true,
				updatedAt: now,
			});
			await access_control_db_ensure_role_assignment(ctx, {
				workspaceId: created._yay!.workspaceId,
				projectId: created._yay!.defaultProjectId,
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

		const result = await member.mutation(api.workspaces.invite_user_to_workspace_project, {
			workspaceId: created._yay!.workspaceId,
			projectId: created._yay!.defaultProjectId,
			userIdToAdd: invitedUserId,
		});
		expect(result._nay?.message).toBe("Permission denied");

		const afterInvite = await t.run(async (ctx) => {
			const [membership, notifications] = await Promise.all([
				ctx.db
					.query("workspaces_projects_users")
					.withIndex("by_active_user_workspace_project", (q) =>
						q.eq("active", true).eq("userId", invitedUserId).eq("workspaceId", created._yay!.workspaceId),
					)
					.collect(),
				workspaces_test_collect_notifications_for_user(ctx, { userId: invitedUserId }),
			]);

			return { membership, notifications };
		});

		expect(afterInvite.membership).toHaveLength(0);
		expect(afterInvite.notifications).toHaveLength(0);
	});
});

describe("remove_user_from_workspace", () => {
	test("rejects removing another user by a member", async () => {
		const t = test_convex();
		const [ownerId, memberId, otherMemberId] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", { clerkUserId: "clerk-user-remove-other-owner" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-remove-other-member" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-remove-other-target" }),
			]),
		);
		await workspaces_test_bootstrap_users(t, { userIds: [ownerId, memberId, otherMemberId] });

		const member = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: memberId,
			name: "Member",
			email: "remove-other-member@test.local",
		});
		const created = await t.run((ctx) =>
			workspaces_db_create(ctx, {
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
					await ctx.db.insert("workspaces_projects_users", {
						workspaceId: created._yay!.workspaceId,
						projectId: created._yay!.defaultProjectId,
						userId,
						active: true,
					});
					await access_control_db_ensure_role_assignment(ctx, {
						workspaceId: created._yay!.workspaceId,
						projectId: created._yay!.defaultProjectId,
						userId,
						role: "member",
						now,
					});
				}),
			);
		});

		const result = await member.mutation(api.workspaces.remove_user_from_workspace, {
			workspaceId: created._yay!.workspaceId,
			userIdToRemove: otherMemberId,
		});
		expect(result._nay?.message).toBe("Permission denied");

		const otherMemberMemberships = await t.run((ctx) =>
			ctx.db
				.query("workspaces_projects_users")
				.withIndex("by_active_user_workspace_project", (q) =>
					q.eq("active", true).eq("userId", otherMemberId).eq("workspaceId", created._yay!.workspaceId),
				)
				.collect(),
		);
		expect(otherMemberMemberships).toHaveLength(1);
	});

	test("allows a member to leave the workspace", async () => {
		const t = test_convex();
		const [ownerId, memberId] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", { clerkUserId: "clerk-user-leave-owner" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-leave-member" }),
			]),
		);
		await workspaces_test_bootstrap_users(t, { userIds: [ownerId, memberId] });

		const member = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: memberId,
			name: "Member",
			email: "leave-member@test.local",
		});
		const created = await t.run((ctx) =>
			workspaces_db_create(ctx, {
				userId: ownerId,
				description: "",
				name: "leave-team",
				now: Date.now(),
			}),
		);
		expect(created._yay).toBeTruthy();

		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert("workspaces_projects_users", {
				workspaceId: created._yay!.workspaceId,
				projectId: created._yay!.defaultProjectId,
				userId: memberId,
				active: true,
			});
			await access_control_db_ensure_role_assignment(ctx, {
				workspaceId: created._yay!.workspaceId,
				projectId: created._yay!.defaultProjectId,
				userId: memberId,
				role: "member",
				now,
			});
		});

		const leaveResult = await member.mutation(api.workspaces.remove_user_from_workspace, {
			workspaceId: created._yay!.workspaceId,
			userIdToRemove: memberId,
		});
		expect(leaveResult._yay).toBeNull();

		const afterLeave = await t.run(async (ctx) => {
			const [memberships, roleAssignments] = await Promise.all([
				ctx.db
					.query("workspaces_projects_users")
					.withIndex("by_active_user_workspace_project", (q) =>
						q.eq("active", true).eq("userId", memberId).eq("workspaceId", created._yay!.workspaceId),
					)
					.collect(),
				ctx.db
					.query("access_control_role_assignments")
					.withIndex("by_workspace_user_project_role", (q) =>
						q.eq("workspaceId", created._yay!.workspaceId).eq("userId", memberId),
					)
					.collect(),
			]);
			return { memberships, roleAssignments };
		});
		expect(afterLeave.memberships).toHaveLength(0);
		expect(afterLeave.roleAssignments).toHaveLength(0);
	});
});

describe("access_control.transfer_workspace_ownership", () => {
	test("moves the owner role and updates extra-workspace quota usage", async () => {
		const t = test_convex();
		const [ownerId, newOwnerId] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", { clerkUserId: "clerk-user-transfer-owner" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-transfer-new-owner" }),
			]),
		);
		await workspaces_test_bootstrap_users(t, { userIds: [ownerId, newOwnerId] });

		const owner = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: ownerId,
			name: "Owner",
			email: "transfer-owner@test.local",
		});
		const created = await owner.mutation(api.workspaces.create_workspace, {
			description: "",
			name: "transfer-team",
		});
		expect(created._yay).toBeTruthy();

		await t.run(async (ctx) => {
			await ctx.db.insert("workspaces_projects_users", {
				workspaceId: created._yay!.workspaceId,
				projectId: created._yay!.defaultProjectId,
				userId: newOwnerId,
				active: true,
			});
		});

		const transferResult = await owner.mutation(api.access_control.transfer_workspace_ownership, {
			workspaceId: created._yay!.workspaceId,
			newOwnerUserId: newOwnerId,
		});
		expect(transferResult._yay).toBeNull();

		const afterTransfer = await t.run(async (ctx) => {
			const [workspace, ownerRoles, oldOwnerMemberRole, oldOwnerQuota, newOwnerQuota, oldOwnerHomeMembership] =
				await Promise.all([
					ctx.db.get("workspaces", created._yay!.workspaceId),
					ctx.db
						.query("access_control_role_assignments")
						.withIndex("by_workspace_project_role_user", (q) =>
							q
								.eq("workspaceId", created._yay!.workspaceId)
								.eq("projectId", created._yay!.defaultProjectId)
								.eq("role", "owner"),
						)
						.collect(),
					ctx.db
						.query("access_control_role_assignments")
						.withIndex("by_workspace_project_user_role", (q) =>
							q
								.eq("workspaceId", created._yay!.workspaceId)
								.eq("projectId", created._yay!.defaultProjectId)
								.eq("userId", ownerId)
								.eq("role", "member"),
						)
						.first(),
					workspaces_test_read_user_extra_workspace_quota_doc(ctx, { userId: ownerId }),
					workspaces_test_read_user_extra_workspace_quota_doc(ctx, { userId: newOwnerId }),
					ctx.db
						.query("workspaces_projects_users")
						.withIndex("by_active_user_workspace_project", (q) =>
							q
								.eq("active", true)
								.eq("userId", ownerId)
								.eq("workspaceId", created._yay!.workspaceId)
								.eq("projectId", created._yay!.defaultProjectId),
						)
						.first(),
				]);

			return { workspace, ownerRoles, oldOwnerMemberRole, oldOwnerQuota, newOwnerQuota, oldOwnerHomeMembership };
		});

		expect(afterTransfer.workspace?.ownerUserId).toBe(newOwnerId);
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
		await workspaces_test_bootstrap_users(t, { userIds: [ownerId, adminId, memberId] });

		const created = await t.run((ctx) =>
			workspaces_db_create(ctx, {
				userId: ownerId,
				name: "member-mgmt-access",
				description: "",
				now: Date.now(),
			}),
		);
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		const project = await t.run((ctx) =>
			workspaces_db_create_project(ctx, {
				userId: ownerId,
				workspaceId: created._yay!.workspaceId,
				name: "project-access",
				description: "",
				now: Date.now(),
			}),
		);
		if (project._nay) {
			throw new Error(project._nay.message);
		}

		const result = await t.run(async (ctx) => {
			const now = Date.now();
			for (const projectId of [created._yay!.defaultProjectId, project._yay!.projectId]) {
				await access_control_db_ensure_role_assignment(ctx, {
					workspaceId: created._yay!.workspaceId,
					projectId,
					userId: adminId,
					role: "admin",
					now,
				});
				await access_control_db_ensure_role_assignment(ctx, {
					workspaceId: created._yay!.workspaceId,
					projectId,
					userId: memberId,
					role: "member",
					now,
				});
			}

			const memberWorkspaceAccess = await access_control_db_has_permission(ctx, {
				workspaceId: created._yay!.workspaceId,
				projectId: created._yay!.defaultProjectId,
				defaultProjectId: created._yay!.defaultProjectId,
				workspaceOwnerUserId: ownerId,
				resourceKind: "workspace",
				resourceId: String(created._yay!.workspaceId),
				permission: "workspace.members.manage",
				userId: memberId,
			});
			const adminWorkspaceAccess = await access_control_db_has_permission(ctx, {
				workspaceId: created._yay!.workspaceId,
				projectId: created._yay!.defaultProjectId,
				defaultProjectId: created._yay!.defaultProjectId,
				workspaceOwnerUserId: ownerId,
				resourceKind: "workspace",
				resourceId: String(created._yay!.workspaceId),
				permission: "workspace.members.manage",
				userId: adminId,
			});
			const memberProjectAccess = await access_control_db_has_permission(ctx, {
				workspaceId: created._yay!.workspaceId,
				projectId: project._yay!.projectId,
				defaultProjectId: created._yay!.defaultProjectId,
				workspaceOwnerUserId: ownerId,
				resourceKind: "project",
				resourceId: String(project._yay!.projectId),
				permission: "project.members.manage",
				userId: memberId,
			});
			const adminProjectAccess = await access_control_db_has_permission(ctx, {
				workspaceId: created._yay!.workspaceId,
				projectId: project._yay!.projectId,
				defaultProjectId: created._yay!.defaultProjectId,
				workspaceOwnerUserId: ownerId,
				resourceKind: "project",
				resourceId: String(project._yay!.projectId),
				permission: "project.members.manage",
				userId: adminId,
			});

			return { memberWorkspaceAccess, adminWorkspaceAccess, memberProjectAccess, adminProjectAccess };
		});

		expect(result.memberWorkspaceAccess).toBe(false);
		expect(result.adminWorkspaceAccess).toBe(true);
		expect(result.memberProjectAccess).toBe(false);
		expect(result.adminProjectAccess).toBe(true);
	});

	test("returns current workspace permission for owners and admins but not regular members", async () => {
		const t = test_convex();
		const [ownerId, adminId, memberId] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", { clerkUserId: "clerk-user-current-permission-owner" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-current-permission-admin" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-current-permission-member" }),
			]),
		);
		await workspaces_test_bootstrap_users(t, { userIds: [ownerId, adminId, memberId] });

		const created = await t.run((ctx) =>
			workspaces_db_create(ctx, {
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
				await ctx.db.insert("workspaces_projects_users", {
					workspaceId: created._yay!.workspaceId,
					projectId: created._yay!.defaultProjectId,
					userId,
					active: true,
					updatedAt: now,
				});
				await access_control_db_ensure_role_assignment(ctx, {
					workspaceId: created._yay!.workspaceId,
					projectId: created._yay!.defaultProjectId,
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
			owner.query(api.access_control.get_current_user_workspace_permission, {
				workspaceId: created._yay.workspaceId,
				permission: "workspace.members.manage",
			}),
			admin.query(api.access_control.get_current_user_workspace_permission, {
				workspaceId: created._yay.workspaceId,
				permission: "workspace.members.manage",
			}),
			member.query(api.access_control.get_current_user_workspace_permission, {
				workspaceId: created._yay.workspaceId,
				permission: "workspace.members.manage",
			}),
		]);

		expect(ownerPermission).toBe(true);
		expect(adminPermission).toBe(true);
		expect(memberPermission).toBe(false);
	});

	test("returns the current user's exact role for one workspace/project scope", async () => {
		const t = test_convex();
		const [ownerId, scopedUserId] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", { clerkUserId: "clerk-user-access-role-owner" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-access-role-scoped" }),
			]),
		);
		await workspaces_test_bootstrap_users(t, { userIds: [ownerId, scopedUserId] });

		const created = await t.run((ctx) =>
			workspaces_db_create(ctx, {
				userId: ownerId,
				name: "access-role",
				description: "",
				now: Date.now(),
			}),
		);
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		const workspace = created._yay;

		const [projectAId, projectBId] = await t.run(async (ctx) => {
			const now = Date.now();
			const [projectAId, projectBId] = await Promise.all([
				ctx.db.insert("workspaces_projects", {
					workspaceId: workspace.workspaceId,
					name: "role-a",
					description: "",
					default: false,
					updatedAt: now,
				}),
				ctx.db.insert("workspaces_projects", {
					workspaceId: workspace.workspaceId,
					name: "role-b",
					description: "",
					default: false,
					updatedAt: now,
				}),
			]);

			await access_control_db_ensure_role_assignment(ctx, {
				workspaceId: workspace.workspaceId,
				projectId: projectAId,
				userId: scopedUserId,
				role: "member",
				now,
			});

			return [projectAId, projectBId] as const;
		});

		const owner = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: ownerId,
			name: "Owner",
			email: "workspaces-test-user@test.local",
		});
		const scopedUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: scopedUserId,
			name: "Scoped User",
			email: "workspaces-test-user@test.local",
		});

		const ownerRole = await owner.query(api.access_control.get_current_user_role, {
			workspaceId: workspace.workspaceId,
			projectId: workspace.defaultProjectId,
		});
		const localProjectRole = await scopedUser.query(api.access_control.get_current_user_role, {
			workspaceId: workspace.workspaceId,
			projectId: projectAId,
		});
		const siblingProjectRoleBeforeDefaultRole = await scopedUser.query(api.access_control.get_current_user_role, {
			workspaceId: workspace.workspaceId,
			projectId: projectBId,
		});

		await t.run((ctx) =>
			access_control_db_ensure_role_assignment(ctx, {
				workspaceId: workspace.workspaceId,
				projectId: workspace.defaultProjectId,
				userId: scopedUserId,
				role: "admin",
				now: Date.now(),
			}),
		);

		const localProjectRoleAfterDefaultRole = await scopedUser.query(api.access_control.get_current_user_role, {
			workspaceId: workspace.workspaceId,
			projectId: projectAId,
		});
		const siblingProjectRoleAfterDefaultRole = await scopedUser.query(api.access_control.get_current_user_role, {
			workspaceId: workspace.workspaceId,
			projectId: projectBId,
		});
		const defaultProjectRoleAfterDefaultRole = await scopedUser.query(api.access_control.get_current_user_role, {
			workspaceId: workspace.workspaceId,
			projectId: workspace.defaultProjectId,
		});

		expect(ownerRole).toBe("owner");
		expect(localProjectRole).toBe("member");
		expect(siblingProjectRoleBeforeDefaultRole).toBeNull();
		expect(localProjectRoleAfterDefaultRole).toBe("member");
		expect(siblingProjectRoleAfterDefaultRole).toBeNull();
		expect(defaultProjectRoleAfterDefaultRole).toBe("admin");
	});

	test("keeps extra-project role assignments local and default-project assignments workspace-wide", async () => {
		const t = test_convex();
		const [ownerId, scopedUserId] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", { clerkUserId: "clerk-user-access-owner" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-access-scoped" }),
			]),
		);
		await workspaces_test_bootstrap_users(t, { userIds: [ownerId, scopedUserId] });

		const created = await t.run((ctx) =>
			workspaces_db_create(ctx, {
				userId: ownerId,
				name: "access-scope",
				description: "",
				now: Date.now(),
			}),
		);
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		const workspace = created._yay;

		const result = await t.run(async (ctx) => {
			const now = Date.now();
			const [projectAId, projectBId] = await Promise.all([
				ctx.db.insert("workspaces_projects", {
					workspaceId: workspace.workspaceId,
					name: "access-a",
					description: "",
					default: false,
					updatedAt: now,
				}),
				ctx.db.insert("workspaces_projects", {
					workspaceId: workspace.workspaceId,
					name: "access-b",
					description: "",
					default: false,
					updatedAt: now,
				}),
			]);

			for (const projectId of [projectAId, projectBId]) {
				await access_control_db_ensure_role_permission_grant(ctx, {
					workspaceId: workspace.workspaceId,
					projectId,
					resourceKind: "project",
					resourceId: String(projectId),
					role: "member",
					permission: "project.update",
					now,
				});
			}

			await access_control_db_ensure_role_assignment(ctx, {
				workspaceId: workspace.workspaceId,
				projectId: projectAId,
				userId: scopedUserId,
				role: "member",
				now,
			});

			const projectALocalAccess = await access_control_db_has_permission(ctx, {
				workspaceId: workspace.workspaceId,
				projectId: projectAId,
				defaultProjectId: workspace.defaultProjectId,
				workspaceOwnerUserId: ownerId,
				resourceKind: "project",
				resourceId: String(projectAId),
				permission: "project.update",
				userId: scopedUserId,
			});
			const projectBAccessBeforeWorkspaceRole = await access_control_db_has_permission(ctx, {
				workspaceId: workspace.workspaceId,
				projectId: projectBId,
				defaultProjectId: workspace.defaultProjectId,
				workspaceOwnerUserId: ownerId,
				resourceKind: "project",
				resourceId: String(projectBId),
				permission: "project.update",
				userId: scopedUserId,
			});

			await access_control_db_ensure_role_assignment(ctx, {
				workspaceId: workspace.workspaceId,
				projectId: workspace.defaultProjectId,
				userId: scopedUserId,
				role: "member",
				now,
			});

			const projectBAccessAfterWorkspaceRole = await access_control_db_has_permission(ctx, {
				workspaceId: workspace.workspaceId,
				projectId: projectBId,
				defaultProjectId: workspace.defaultProjectId,
				workspaceOwnerUserId: ownerId,
				resourceKind: "project",
				resourceId: String(projectBId),
				permission: "project.update",
				userId: scopedUserId,
			});

			return {
				projectALocalAccess,
				projectBAccessBeforeWorkspaceRole,
				projectBAccessAfterWorkspaceRole,
			};
		});

		expect(result.projectALocalAccess).toBe(true);
		expect(result.projectBAccessBeforeWorkspaceRole).toBe(false);
		expect(result.projectBAccessAfterWorkspaceRole).toBe(true);
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
		await workspaces_test_bootstrap_users(t, { userIds: [ownerId, grantedUserId, otherUserId] });

		const created = await t.run((ctx) =>
			workspaces_db_create(ctx, {
				userId: ownerId,
				name: "access-grants",
				description: "",
				now: Date.now(),
			}),
		);
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		const workspace = created._yay;

		const result = await t.run(async (ctx) => {
			const now = Date.now();
			const [nodeId, otherNodeId] = await Promise.all([
				ctx.db.insert("files_nodes", {
					workspaceId: String(workspace.workspaceId),
					projectId: String(workspace.defaultProjectId),
					path: "/access-user-grant",
					name: "access-user-grant",
					kind: "file",
					version: 0,
					parentId: "root",
					createdBy: ownerId,
					updatedBy: ownerId,
					updatedAt: now,
				}),
				ctx.db.insert("files_nodes", {
					workspaceId: String(workspace.workspaceId),
					projectId: String(workspace.defaultProjectId),
					path: "/access-public-other",
					name: "access-public-other",
					kind: "file",
					version: 0,
					parentId: "root",
					createdBy: ownerId,
					updatedBy: ownerId,
					updatedAt: now,
				}),
			]);

			await Promise.all([
				access_control_db_ensure_user_permission_grant(ctx, {
					workspaceId: workspace.workspaceId,
					projectId: workspace.defaultProjectId,
					resourceKind: "file",
					resourceId: String(nodeId),
					userId: grantedUserId,
					permission: "asset.write",
					now,
				}),
				access_control_db_ensure_public_permission_grant(ctx, {
					workspaceId: workspace.workspaceId,
					projectId: workspace.defaultProjectId,
					resourceKind: "file",
					resourceId: String(nodeId),
					permission: "asset.read",
					now,
				}),
			]);

			const directUserAccess = await access_control_db_has_permission(ctx, {
				workspaceId: workspace.workspaceId,
				projectId: workspace.defaultProjectId,
				defaultProjectId: workspace.defaultProjectId,
				workspaceOwnerUserId: ownerId,
				resourceKind: "file",
				resourceId: String(nodeId),
				permission: "asset.write",
				userId: grantedUserId,
			});
			const otherUserAccess = await access_control_db_has_permission(ctx, {
				workspaceId: workspace.workspaceId,
				projectId: workspace.defaultProjectId,
				defaultProjectId: workspace.defaultProjectId,
				workspaceOwnerUserId: ownerId,
				resourceKind: "file",
				resourceId: String(nodeId),
				permission: "asset.write",
				userId: otherUserId,
			});
			const publicReadAccess = await access_control_db_has_permission(ctx, {
				workspaceId: workspace.workspaceId,
				projectId: workspace.defaultProjectId,
				defaultProjectId: workspace.defaultProjectId,
				workspaceOwnerUserId: ownerId,
				resourceKind: "file",
				resourceId: String(nodeId),
				permission: "asset.read",
				allowPublic: true,
			});
			const publicWriteAccess = await access_control_db_has_permission(ctx, {
				workspaceId: workspace.workspaceId,
				projectId: workspace.defaultProjectId,
				defaultProjectId: workspace.defaultProjectId,
				workspaceOwnerUserId: ownerId,
				resourceKind: "file",
				resourceId: String(nodeId),
				permission: "asset.write",
				allowPublic: true,
			});
			const otherPagePublicAccess = await access_control_db_has_permission(ctx, {
				workspaceId: workspace.workspaceId,
				projectId: workspace.defaultProjectId,
				defaultProjectId: workspace.defaultProjectId,
				workspaceOwnerUserId: ownerId,
				resourceKind: "file",
				resourceId: String(otherNodeId),
				permission: "asset.read",
				allowPublic: true,
			});
			const publicAccessWithoutPublicFlag = await access_control_db_has_permission(ctx, {
				workspaceId: workspace.workspaceId,
				projectId: workspace.defaultProjectId,
				defaultProjectId: workspace.defaultProjectId,
				workspaceOwnerUserId: ownerId,
				resourceKind: "file",
				resourceId: String(nodeId),
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

describe("edit_workspace", () => {
	test("rejects renaming the default workspace", async () => {
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
			email: "workspaces-test-user@test.local",
		});

		const created = await t.run((ctx) => workspaces_test_seed_default_workspace(ctx, { userId }));
		expect(created._yay).toBeTruthy();

		const result = await asUser.mutation(api.workspaces.edit_workspace, {
			workspaceId: created._yay!.workspaceId,
			defaultProjectId: created._yay!.defaultProjectId,
			name: "renamed-personal",
			description: "",
		});

		expect(result._nay?.message).toBe("Cannot edit the default workspace");
	});

	test("allows renaming a non-default workspace", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-rename-nond-ws",
			}),
		);
		await workspaces_test_bootstrap_user(t, { userId });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "workspaces-test-user@test.local",
		});

		const created = await t.run(async (ctx) =>
			workspaces_db_create(ctx, {
				userId,
				name: "extra-ws-rename",
				description: "",
				now: Date.now(),
				default: false,
			}),
		);
		expect(created._yay).toBeTruthy();

		const result = await asUser.mutation(api.workspaces.edit_workspace, {
			workspaceId: created._yay!.workspaceId,
			defaultProjectId: created._yay!.defaultProjectId,
			name: "extra-renamed",
			description: "",
		});

		expect(result._yay?.name).toBe("extra-renamed");
	});

	test("leaves description unchanged when renaming workspace", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-rename-keeps-desc",
			}),
		);
		await workspaces_test_bootstrap_user(t, { userId });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "workspaces-test-user@test.local",
		});

		const created = await asUser.mutation(api.workspaces.create_workspace, {
			description: "Product org",
			name: "rename-keep-desc-ws",
		});
		expect(created._yay).toBeTruthy();

		const wsId = created._yay!.workspaceId;
		const before = await t.run((ctx) => ctx.db.get("workspaces", wsId));
		expect(before?.description).toBe("Product org");

		const renamed = await asUser.mutation(api.workspaces.edit_workspace, {
			workspaceId: wsId,
			defaultProjectId: created._yay!.defaultProjectId,
			name: "rename-keep-desc-2",
			description: "Product org",
		});
		expect(renamed._yay?.name).toBe("rename-keep-desc-2");

		const after = await t.run((ctx) => ctx.db.get("workspaces", wsId));
		expect(after?.description).toBe("Product org");
	});

	test("updates workspace description when editing workspace", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-edit-workspace-desc",
			}),
		);
		await workspaces_test_bootstrap_user(t, { userId });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "workspaces-test-user@test.local",
		});

		const created = await asUser.mutation(api.workspaces.create_workspace, {
			description: "Planning",
			name: "edit-workspace",
		});
		expect(created._yay).toBeTruthy();

		const edited = await asUser.mutation(api.workspaces.edit_workspace, {
			workspaceId: created._yay!.workspaceId,
			defaultProjectId: created._yay!.defaultProjectId,
			name: "edit-workspace-next",
			description: "Planning and delivery",
		});
		expect(edited._yay?.name).toBe("edit-workspace-next");

		const after = await t.run((ctx) => ctx.db.get("workspaces", created._yay!.workspaceId));
		expect(after?.description).toBe("Planning and delivery");
	});

	test("rejects workspace edit when description is longer than max length", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-edit-workspace-desc-long",
			}),
		);
		await workspaces_test_bootstrap_user(t, { userId });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "workspaces-test-user@test.local",
		});

		const created = await asUser.mutation(api.workspaces.create_workspace, {
			description: "",
			name: "edit-ws-desc-long",
		});
		expect(created._yay).toBeTruthy();

		const result = await asUser.mutation(api.workspaces.edit_workspace, {
			workspaceId: created._yay!.workspaceId,
			defaultProjectId: created._yay!.defaultProjectId,
			name: "edit-ws-desc-next",
			description: "x".repeat(workspaces_DESCRIPTION_MAX_LENGTH + 1),
		});
		expect(result._nay?.message).toBe("Description is too long");
	});

	test("rejects workspace edit when name is longer than max length", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-edit-workspace-name-long",
			}),
		);
		await workspaces_test_bootstrap_user(t, { userId });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "workspaces-test-user@test.local",
		});

		const created = await asUser.mutation(api.workspaces.create_workspace, {
			description: "",
			name: "edit-ws-name-long",
		});
		expect(created._yay).toBeTruthy();

		const result = await asUser.mutation(api.workspaces.edit_workspace, {
			workspaceId: created._yay!.workspaceId,
			defaultProjectId: created._yay!.defaultProjectId,
			name: "a".repeat(workspaces_NAME_MAX_LENGTH + 1),
			description: "",
		});
		expect(result._nay?.message).toBe("Name must be at most 20 characters");
	});

	test("returns Not found when defaultProjectId is not the workspace primary", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-rename-ws-wrong-default-proj",
			}),
		);
		await workspaces_test_bootstrap_user(t, { userId });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "workspaces-test-user@test.local",
		});

		const created = await t.run(async (ctx) =>
			workspaces_db_create(ctx, {
				userId,
				name: "ws-wrong-default-arg",
				description: "",
				now: Date.now(),
				default: false,
			}),
		);
		expect(created._yay).toBeTruthy();

		const extra = await asUser.mutation(api.workspaces.create_project, {
			description: "",
			workspaceId: created._yay!.workspaceId,
			name: "side-project",
		});
		expect(extra._yay).toBeTruthy();

		const result = await asUser.mutation(api.workspaces.edit_workspace, {
			workspaceId: created._yay!.workspaceId,
			defaultProjectId: extra._yay!.projectId,
			name: "renamed-ws",
			description: "",
		});

		expect(result._nay?.message).toBe("Not found");
	});

	test("returns Not found when the user has no membership on the workspace", async () => {
		const t = test_convex();
		const userIds = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", { clerkUserId: "clerk-rename-ws-owner" }),
				ctx.db.insert("users", { clerkUserId: "clerk-rename-ws-stranger" }),
			]),
		);
		await workspaces_test_bootstrap_user(t, { userId: userIds[0] });

		const created = await t.run(async (ctx) =>
			workspaces_db_create(ctx, {
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
			email: "workspaces-test-user@test.local",
		});

		const result = await stranger.mutation(api.workspaces.edit_workspace, {
			workspaceId: created._yay!.workspaceId,
			defaultProjectId: created._yay!.defaultProjectId,
			name: "hijacked",
			description: "",
		});

		expect(result._nay?.message).toBe("Not found");
	});
});

describe("edit_project", () => {
	test("rejects renaming the primary project when project.default is true", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-rename-primary-proj",
			}),
		);
		await workspaces_test_bootstrap_user(t, { userId });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "workspaces-test-user@test.local",
		});

		const wsResult = await t.run((ctx) =>
			workspaces_db_create(ctx, {
				userId,
				description: "",
				name: "rename-proj-ws",
				now: Date.now(),
			}),
		);
		if (wsResult._nay) {
			throw new Error(wsResult._nay.message);
		}
		expect(wsResult._yay).toBeTruthy();

		const result = await asUser.mutation(api.workspaces.edit_project, {
			workspaceId: wsResult._yay!.workspaceId,
			defaultProjectId: wsResult._yay!.defaultProjectId,
			projectId: wsResult._yay!.defaultProjectId,
			name: "new-home",
			description: "",
		});

		expect(result._nay?.message).toBe("Cannot edit the default project");
	});

	test("rejects renaming the primary project when only defaultProjectId matches", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-rename-primary-proj-id",
			}),
		);
		await workspaces_test_bootstrap_user(t, { userId });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "workspaces-test-user@test.local",
		});

		const wsResult = await t.run((ctx) =>
			workspaces_db_create(ctx, {
				userId,
				description: "",
				name: "rename-proj-ws-id",
				now: Date.now(),
			}),
		);
		if (wsResult._nay) {
			throw new Error(wsResult._nay.message);
		}
		expect(wsResult._yay).toBeTruthy();
		const workspaceId = wsResult._yay!.workspaceId;
		const homeId = wsResult._yay!.defaultProjectId;

		const extra = await t.run((ctx) =>
			workspaces_db_create_project(ctx, {
				userId,
				description: "",
				workspaceId,
				name: "zebra-docs",
				now: Date.now(),
			}),
		);
		if (extra._nay) {
			throw new Error(extra._nay.message);
		}
		expect(extra._yay).toBeTruthy();
		const zebraId = extra._yay!.projectId;

		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.patch("workspaces_projects", homeId, { default: false });
			await ctx.db.patch("workspaces", workspaceId, { defaultProjectId: zebraId });
			await access_control_db_ensure_role_assignment(ctx, {
				workspaceId,
				projectId: zebraId,
				userId,
				role: "owner",
				now,
			});
		});

		const blocked = await asUser.mutation(api.workspaces.edit_project, {
			workspaceId,
			defaultProjectId: zebraId,
			projectId: zebraId,
			name: "blocked-zebra",
			description: "",
		});
		expect(blocked._nay?.message).toBe("Cannot edit the default project");

		const ok = await asUser.mutation(api.workspaces.edit_project, {
			workspaceId,
			defaultProjectId: zebraId,
			projectId: homeId,
			name: "former-home",
			description: "",
		});
		expect(ok._yay?.name).toBe("former-home");
	});

	test("allows renaming a non-primary project", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-rename-secondary-proj",
			}),
		);
		await workspaces_test_bootstrap_user(t, { userId });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "workspaces-test-user@test.local",
		});

		const wsResult = await t.run((ctx) =>
			workspaces_db_create(ctx, {
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
			workspaces_db_create_project(ctx, {
				userId,
				description: "",
				workspaceId: wsResult._yay!.workspaceId,
				name: "sidecar",
				now: Date.now(),
			}),
		);
		if (extra._nay) {
			throw new Error(extra._nay.message);
		}
		expect(extra._yay).toBeTruthy();

		const result = await asUser.mutation(api.workspaces.edit_project, {
			workspaceId: wsResult._yay!.workspaceId,
			defaultProjectId: wsResult._yay!.defaultProjectId,
			projectId: extra._yay!.projectId,
			name: "sidecar-renamed",
			description: "",
		});

		expect(result._yay?.name).toBe("sidecar-renamed");
	});

	test("leaves description unchanged when renaming project", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-rename-proj-keeps-desc",
			}),
		);
		await workspaces_test_bootstrap_user(t, { userId });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "workspaces-test-user@test.local",
		});

		const wsResult = await t.run((ctx) =>
			workspaces_db_create(ctx, {
				userId,
				description: "",
				name: "rename-proj-desc-ws",
				now: Date.now(),
			}),
		);
		if (wsResult._nay) {
			throw new Error(wsResult._nay.message);
		}
		expect(wsResult._yay).toBeTruthy();

		const extra = await t.run((ctx) =>
			workspaces_db_create_project(ctx, {
				userId,
				description: "Scratch space",
				workspaceId: wsResult._yay!.workspaceId,
				name: "side-note",
				now: Date.now(),
			}),
		);
		if (extra._nay) {
			throw new Error(extra._nay.message);
		}
		expect(extra._yay).toBeTruthy();

		const projectId = extra._yay!.projectId;
		const before = await t.run((ctx) => ctx.db.get("workspaces_projects", projectId));
		expect(before?.description).toBe("Scratch space");

		const renamed = await asUser.mutation(api.workspaces.edit_project, {
			workspaceId: wsResult._yay!.workspaceId,
			defaultProjectId: wsResult._yay!.defaultProjectId,
			projectId,
			name: "side-note-v2",
			description: "Scratch space",
		});
		expect(renamed._yay?.name).toBe("side-note-v2");

		const after = await t.run((ctx) => ctx.db.get("workspaces_projects", projectId));
		expect(after?.description).toBe("Scratch space");
	});

	test("updates project description when editing project", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-edit-project-desc",
			}),
		);
		await workspaces_test_bootstrap_user(t, { userId });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "workspaces-test-user@test.local",
		});

		const wsResult = await t.run((ctx) =>
			workspaces_db_create(ctx, {
				userId,
				description: "",
				name: "edit-proj-desc-ws",
				now: Date.now(),
			}),
		);
		if (wsResult._nay) {
			throw new Error(wsResult._nay.message);
		}
		expect(wsResult._yay).toBeTruthy();

		const extra = await t.run((ctx) =>
			workspaces_db_create_project(ctx, {
				userId,
				description: "Scratch space",
				workspaceId: wsResult._yay!.workspaceId,
				name: "edit-proj-desc",
				now: Date.now(),
			}),
		);
		if (extra._nay) {
			throw new Error(extra._nay.message);
		}
		expect(extra._yay).toBeTruthy();

		const edited = await asUser.mutation(api.workspaces.edit_project, {
			workspaceId: wsResult._yay!.workspaceId,
			defaultProjectId: wsResult._yay!.defaultProjectId,
			projectId: extra._yay!.projectId,
			name: "edit-proj-next",
			description: "Docs and notes",
		});
		expect(edited._yay?.name).toBe("edit-proj-next");

		const after = await t.run((ctx) => ctx.db.get("workspaces_projects", extra._yay!.projectId));
		expect(after?.description).toBe("Docs and notes");
	});
});

describe("delete_project", () => {
	test("queues tenant-scoped purge work and keeps the user's personal/home default", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-delete-project",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "workspaces-test-user@test.local",
		});
		await workspaces_test_bootstrap_user(t, { userId });

		const personalDefaultIds = await t.run(async (ctx) => {
			const user = await ctx.db.get("users", userId);
			if (!user?.defaultWorkspaceId || !user.defaultProjectId) {
				throw new Error("Expected default workspace pointers after bootstrap");
			}

			return {
				workspaceId: user.defaultWorkspaceId,
				defaultProjectId: user.defaultProjectId,
			};
		});

		const created = await t.run(async (ctx) =>
			workspaces_db_create(ctx, {
				userId,
				name: "delete-project-ws",
				description: "",
				now: Date.now(),
				default: false,
			}),
		);
		expect(created._yay).toBeTruthy();

		const extraProject = await asUser.mutation(api.workspaces.create_project, {
			description: "",
			workspaceId: created._yay!.workspaceId,
			name: "scratch",
		});
		expect(extraProject._yay).toBeTruthy();

		await t.run(async (ctx) => {
			await ctx.db.insert("notifications", {
				userId,
				kind: "workspace_project_invite",
				read: false,
				actorUserId: userId,
				workspaceId: created._yay!.workspaceId,
				projectId: extraProject._yay!.projectId,
				updatedAt: Date.now(),
			});
			await workspaces_test_seed_project_scoped_rows(ctx, {
				userId,
				workspaceId: String(created._yay!.workspaceId),
				projectId: String(extraProject._yay!.projectId),
				tag: "delete-project",
			});
		});

		const result = await asUser.mutation(api.workspaces.delete_project, {
			projectId: extraProject._yay!.projectId,
		});
		expect(result._yay).toBeNull();

		const after_delete = await t.run(async (ctx) => {
			const [
				project,
				requests,
				user,
				workspaceQuota,
				roleAssignments,
				permissionGrants,
				files,
				markdownContent,
				aiThreads,
				aiMessages,
				chatMessages,
				notifications,
			] = await Promise.all([
				ctx.db.get("workspaces_projects", extraProject._yay!.projectId),
				ctx.db.query("data_deletion_requests").collect(),
				ctx.db.get("users", userId),
				workspaces_test_read_workspace_extra_project_quota_doc(ctx, { workspaceId: created._yay!.workspaceId }),
				ctx.db
					.query("access_control_role_assignments")
					.withIndex("by_workspace_project_user_role", (q) =>
						q.eq("workspaceId", created._yay!.workspaceId).eq("projectId", extraProject._yay!.projectId),
					)
					.collect(),
				ctx.db
					.query("access_control_permission_grants")
					.withIndex("by_workspace_project_resource_user_permission", (q) =>
						q.eq("workspaceId", created._yay!.workspaceId).eq("projectId", extraProject._yay!.projectId),
					)
					.collect(),
				ctx.db.query("files_nodes").collect(),
				ctx.db.query("files_markdown_content").collect(),
				ctx.db.query("ai_chat_threads").collect(),
				ctx.db.query("ai_chat_threads_messages_aisdk_5").collect(),
				ctx.db.query("chat_messages").collect(),
				ctx.db
					.query("notifications")
					.withIndex("by_workspace_project_user", (q) =>
						q.eq("workspaceId", created._yay!.workspaceId).eq("projectId", extraProject._yay!.projectId),
					)
					.collect(),
			]);

			return {
				project,
				requests: requests.filter(
					(row) => row.workspaceId === created._yay!.workspaceId && row.projectId === extraProject._yay!.projectId,
				),
				user,
				workspaceQuota,
				roleAssignments,
				permissionGrants,
				files: files.filter(
					(row) =>
						row.workspaceId === String(created._yay!.workspaceId) &&
						row.projectId === String(extraProject._yay!.projectId),
				),
				markdownContent: markdownContent.filter(
					(row) =>
						row.workspaceId === String(created._yay!.workspaceId) &&
						row.projectId === String(extraProject._yay!.projectId),
				),
				aiThreads: aiThreads.filter(
					(row) =>
						row.workspaceId === String(created._yay!.workspaceId) &&
						row.projectId === String(extraProject._yay!.projectId),
				),
				aiMessages: aiMessages.filter(
					(row) =>
						row.workspaceId === String(created._yay!.workspaceId) &&
						row.projectId === String(extraProject._yay!.projectId),
				),
				chatMessages: chatMessages.filter(
					(row) =>
						row.workspaceId === String(created._yay!.workspaceId) &&
						row.projectId === String(extraProject._yay!.projectId),
				),
				notifications,
			};
		});

		expect(after_delete.project).toBeNull();
		expect(after_delete.notifications).toHaveLength(0);
		expect(after_delete.requests).toHaveLength(1);
		expect(after_delete.requests[0]?.scope).toBe("project");
		expect(after_delete.files).toHaveLength(1);
		expect(after_delete.markdownContent).toHaveLength(1);
		expect(after_delete.aiThreads).toHaveLength(1);
		expect(after_delete.aiMessages).toHaveLength(1);
		expect(after_delete.chatMessages).toHaveLength(1);
		expect(after_delete.workspaceQuota?.usedCount).toBe(0);
		expect(after_delete.roleAssignments).toHaveLength(0);
		expect(after_delete.permissionGrants).toHaveLength(0);
		expect(after_delete.user?.defaultWorkspaceId).toBe(personalDefaultIds.workspaceId);
		expect(after_delete.user?.defaultProjectId).toBe(personalDefaultIds.defaultProjectId);

		await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.process_project_deletion_request, {
				requestId: after_delete.requests[0]!._id,
				_test_now: after_delete.requests[0]!._creationTime + 7 * 24 * 60 * 60 * 1000 + 1,
			}),
		);

		const purgeRequestsAfter = await t.run(async (ctx) =>
			(await ctx.db.query("data_deletion_requests").collect()).filter(
				(row) => row.workspaceId === created._yay!.workspaceId && row.projectId === extraProject._yay!.projectId,
			),
		);
		expect(purgeRequestsAfter).toHaveLength(0);
	});
});

describe("delete_workspace", () => {
	test("rejects deletion by an active member who is not the workspace owner", async () => {
		const t = test_convex();
		const [ownerId, memberId] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", { clerkUserId: "clerk-user-delete-owner-only-owner" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-delete-owner-only-member" }),
			]),
		);
		await workspaces_test_bootstrap_users(t, { userIds: [ownerId, memberId] });
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

		const created = await owner.mutation(api.workspaces.create_workspace, {
			description: "",
			name: "owner-only-delete",
		});
		expect(created._yay).toBeTruthy();

		await t.run(async (ctx) => {
			await ctx.db.insert("workspaces_projects_users", {
				workspaceId: created._yay!.workspaceId,
				projectId: created._yay!.defaultProjectId,
				userId: memberId,
				active: true,
			});
		});

		const result = await member.mutation(api.workspaces.delete_workspace, {
			workspaceId: created._yay!.workspaceId,
		});
		expect(result._nay?.message).toBe("Permission denied");

		const workspaceAfter = await t.run((ctx) => ctx.db.get("workspaces", created._yay!.workspaceId));
		expect(workspaceAfter).not.toBeNull();
	});

	test("queues workspace-scope purge, drops memberships immediately, keeps structure until cron, then purge removes content and structure", async () => {
		const t = test_convex();
		const [ownerId, memberId] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", { clerkUserId: "clerk-user-delete-workspace-owner" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-delete-workspace-member" }),
			]),
		);
		await workspaces_test_bootstrap_user(t, { userId: ownerId });
		const owner = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: ownerId,
			name: "Owner",
			email: "workspaces-test-user@test.local",
		});
		const memberDefault = await t.run((ctx) => workspaces_test_seed_default_workspace(ctx, { userId: memberId }));
		expect(memberDefault._yay).toBeTruthy();

		const created = await t.run(async (ctx) =>
			workspaces_db_create(ctx, {
				userId: ownerId,
				name: "delete-workspace-ws",
				description: "",
				now: Date.now(),
				default: false,
			}),
		);
		expect(created._yay).toBeTruthy();

		const extraProject = await owner.mutation(api.workspaces.create_project, {
			description: "",
			workspaceId: created._yay!.workspaceId,
			name: "ops",
		});
		expect(extraProject._yay).toBeTruthy();

		await t.run(async (ctx) => {
			await ctx.db.insert("notifications", {
				userId: memberId,
				kind: "workspace_project_invite",
				read: false,
				actorUserId: ownerId,
				workspaceId: created._yay!.workspaceId,
				projectId: extraProject._yay!.projectId,
				updatedAt: Date.now(),
			});
			await ctx.db.insert("workspaces_projects_users", {
				workspaceId: created._yay!.workspaceId,
				projectId: extraProject._yay!.projectId,
				userId: memberId,
				active: true,
			});

			await workspaces_test_seed_project_scoped_rows(ctx, {
				userId: ownerId,
				workspaceId: String(created._yay!.workspaceId),
				projectId: String(created._yay!.defaultProjectId),
				tag: "delete-workspace-home",
			});
			await workspaces_test_seed_project_scoped_rows(ctx, {
				userId: ownerId,
				workspaceId: String(created._yay!.workspaceId),
				projectId: String(extraProject._yay!.projectId),
				tag: "delete-workspace-extra",
			});
		});

		const quotasBeforeDelete = await t.run(async (ctx) =>
			ctx.db
				.query("quotas")
				.withIndex("by_workspace_quotaName", (q) => q.eq("workspaceId", created._yay!.workspaceId))
				.collect(),
		);

		const result = await owner.mutation(api.workspaces.delete_workspace, {
			workspaceId: created._yay!.workspaceId,
		});
		expect(result._yay).toBeNull();

		const after_delete = await t.run(async (ctx) => {
			const [
				workspace,
				defaultProject,
				secondaryProject,
				member,
				ownerQuota,
				workspaceQuotas,
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
				ctx.db.get("workspaces", created._yay!.workspaceId),
				ctx.db.get("workspaces_projects", created._yay!.defaultProjectId),
				ctx.db.get("workspaces_projects", extraProject._yay!.projectId),
				ctx.db.get("users", memberId),
				workspaces_test_read_user_extra_workspace_quota_doc(ctx, { userId: ownerId }),
				ctx.db
					.query("quotas")
					.withIndex("by_workspace_quotaName", (q) => q.eq("workspaceId", created._yay!.workspaceId))
					.collect(),
				ctx.db.query("workspaces_projects_users").collect(),
				ctx.db
					.query("access_control_role_assignments")
					.withIndex("by_workspace_project_user_role", (q) => q.eq("workspaceId", created._yay!.workspaceId))
					.collect(),
				ctx.db
					.query("access_control_permission_grants")
					.withIndex("by_workspace_project_resource_user_permission", (q) =>
						q.eq("workspaceId", created._yay!.workspaceId),
					)
					.collect(),
				ctx.db.query("data_deletion_requests").collect(),
				ctx.db.query("files_nodes").collect(),
				ctx.db.query("ai_chat_threads").collect(),
				ctx.db.query("ai_chat_threads_messages_aisdk_5").collect(),
				ctx.db.query("chat_messages").collect(),
				ctx.db
					.query("notifications")
					.withIndex("by_workspace_user_read", (q) => q.eq("workspaceId", created._yay!.workspaceId))
					.collect(),
			]);

			return {
				workspace,
				defaultProject,
				secondaryProject,
				member,
				ownerQuota,
				workspaceQuotas,
				memberships: memberships.filter((row) => row.workspaceId === created._yay!.workspaceId),
				roleAssignments,
				permissionGrants,
				requests: requests.filter((row) => row.workspaceId === created._yay!.workspaceId),
				files: files.filter((row) => row.workspaceId === String(created._yay!.workspaceId)),
				aiThreads: aiThreads.filter((row) => row.workspaceId === String(created._yay!.workspaceId)),
				aiMessages: aiMessages.filter((row) => row.workspaceId === String(created._yay!.workspaceId)),
				chatMessages: chatMessages.filter((row) => row.workspaceId === String(created._yay!.workspaceId)),
				notifications,
			};
		});

		expect(after_delete.workspace).not.toBeNull();
		expect(after_delete.defaultProject).not.toBeNull();
		expect(after_delete.secondaryProject).not.toBeNull();
		expect(after_delete.memberships).toHaveLength(0);
		expect(after_delete.roleAssignments).toHaveLength(0);
		expect(after_delete.permissionGrants).toHaveLength(0);
		expect(after_delete.notifications).toHaveLength(0);
		expect(after_delete.requests).toHaveLength(1);
		expect(after_delete.requests[0]?.scope).toBe("workspace");
		expect(after_delete.files).toHaveLength(2);
		expect(after_delete.aiThreads).toHaveLength(2);
		expect(after_delete.aiMessages).toHaveLength(2);
		expect(after_delete.chatMessages).toHaveLength(2);
		expect(after_delete.ownerQuota?.usedCount).toBe(0);
		expect(after_delete.workspaceQuotas.map((row) => row._id).sort()).toEqual(
			quotasBeforeDelete.map((row) => row._id).sort(),
		);
		expect(after_delete.member?.defaultWorkspaceId).toBe(memberDefault._yay!.workspaceId);
		expect(after_delete.member?.defaultProjectId).toBe(memberDefault._yay!.defaultProjectId);

		const newestRequestCreationTime = Math.max(...after_delete.requests.map((row) => row._creationTime));
		await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.process_workspace_deletion_request, {
				requestId: after_delete.requests[0]!._id,
				_test_now: newestRequestCreationTime + 7 * 24 * 60 * 60 * 1000 + 1,
			}),
		);

		const purgeRequestsAfter = await t.run(async (ctx) =>
			(await ctx.db.query("data_deletion_requests").collect()).filter(
				(row) => row.workspaceId === created._yay!.workspaceId,
			),
		);
		expect(purgeRequestsAfter).toHaveLength(0);

		const after_purge = await t.run(async (ctx) => {
			const [workspace, defaultProject, secondaryProject, workspaceQuotas, files] = await Promise.all([
				ctx.db.get("workspaces", created._yay!.workspaceId),
				ctx.db.get("workspaces_projects", created._yay!.defaultProjectId),
				ctx.db.get("workspaces_projects", extraProject._yay!.projectId),
				ctx.db
					.query("quotas")
					.withIndex("by_workspace_quotaName", (q) => q.eq("workspaceId", created._yay!.workspaceId))
					.collect(),
				ctx.db.query("files_nodes").collect(),
			]);
			return {
				workspace,
				defaultProject,
				secondaryProject,
				workspaceQuotas,
				files: files.filter((row) => row.workspaceId === String(created._yay!.workspaceId)),
			};
		});
		expect(after_purge.workspace).toBeNull();
		expect(after_purge.defaultProject).toBeNull();
		expect(after_purge.secondaryProject).toBeNull();
		expect(after_purge.workspaceQuotas).toHaveLength(0);
		expect(after_purge.files).toHaveLength(0);
	});

	test("queues a workspace-scope purge even when the workspace already has a queued project-scope purge", async () => {
		const t = test_convex();
		const ownerId = await t.run(async (ctx) =>
			ctx.db.insert("users", { clerkUserId: "clerk-user-delete-workspace-after-project-delete" }),
		);
		await workspaces_test_bootstrap_user(t, { userId: ownerId });
		const owner = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: ownerId,
			name: "Owner",
			email: "workspaces-test-user@test.local",
		});

		const created = await t.run(async (ctx) =>
			workspaces_db_create(ctx, {
				userId: ownerId,
				name: "queued",
				description: "",
				now: Date.now(),
				default: false,
			}),
		);
		expect(created._yay).toBeTruthy();

		const extraProject = await t.run((ctx) =>
			workspaces_db_create_project(ctx, {
				userId: ownerId,
				description: "",
				workspaceId: created._yay!.workspaceId,
				name: "scratch",
				now: Date.now(),
			}),
		);
		if (extraProject._nay) {
			throw new Error(extraProject._nay.message);
		}
		expect(extraProject._yay).toBeTruthy();

		const deleteProjectResult = await owner.mutation(api.workspaces.delete_project, {
			projectId: extraProject._yay!.projectId,
		});
		expect(deleteProjectResult._yay).toBeNull();

		const deleteWorkspaceResult = await owner.mutation(api.workspaces.delete_workspace, {
			workspaceId: created._yay!.workspaceId,
		});
		expect(deleteWorkspaceResult._yay).toBeNull();

		const requestsAfterDeleteWorkspace = await t.run(async (ctx) =>
			(await ctx.db.query("data_deletion_requests").collect()).filter(
				(row) => row.workspaceId === created._yay!.workspaceId,
			),
		);

		expect(
			requestsAfterDeleteWorkspace.filter(
				(row) => row.scope === "project" && row.projectId === extraProject._yay!.projectId,
			),
		).toHaveLength(1);
		expect(
			requestsAfterDeleteWorkspace.filter((row) => row.scope === "workspace" && row.projectId === undefined),
		).toHaveLength(1);
	});
});

describe("process_project_deletion_request", () => {
	test("purges only the requested workspace/project scope and keeps sibling project rows", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-purge-data-deletion-requests",
			}),
		);
		await workspaces_test_bootstrap_user(t, { userId });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "workspaces-test-user@test.local",
		});

		const created = await t.run(async (ctx) =>
			workspaces_db_create(ctx, {
				userId,
				name: "purge-requests-ws",
				description: "",
				now: Date.now(),
				default: false,
			}),
		);
		expect(created._yay).toBeTruthy();

		const victimProject = await asUser.mutation(api.workspaces.create_project, {
			description: "",
			workspaceId: created._yay!.workspaceId,
			name: "scratch",
		});
		expect(victimProject._yay).toBeTruthy();

		const purgeRequest = await t.run(async (ctx) => {
			await workspaces_test_seed_project_scoped_rows(ctx, {
				userId,
				workspaceId: String(created._yay!.workspaceId),
				projectId: String(created._yay!.defaultProjectId),
				tag: "purge-control",
			});
			await workspaces_test_seed_project_scoped_rows(ctx, {
				userId,
				workspaceId: String(created._yay!.workspaceId),
				projectId: String(victimProject._yay!.projectId),
				tag: "purge-victim",
			});

			const purgeRequestId = await ctx.db.insert("data_deletion_requests", {
				userId,
				workspaceId: created._yay!.workspaceId,
				projectId: victimProject._yay!.projectId,
				scope: "project",
			});
			const purgeRequest = await ctx.db.get("data_deletion_requests", purgeRequestId);
			if (!purgeRequest) {
				throw new Error("Failed to load purge request");
			}

			return purgeRequest;
		});

		await t.run((ctx) =>
			ctx.runMutation(internal.data_deletion.process_project_deletion_request, {
				requestId: purgeRequest._id,
				_test_now: purgeRequest._creationTime + RETENTION_MS + 1,
			}),
		);

		const afterPurge = await t.run(async (ctx) => {
			const [requests, files, markdownContent, aiThreads, aiMessages, chatMessages] = await Promise.all([
				ctx.db.query("data_deletion_requests").collect(),
				ctx.db.query("files_nodes").collect(),
				ctx.db.query("files_markdown_content").collect(),
				ctx.db.query("ai_chat_threads").collect(),
				ctx.db.query("ai_chat_threads_messages_aisdk_5").collect(),
				ctx.db.query("chat_messages").collect(),
			]);

			return {
				victimRequests: requests.filter(
					(row) => row.workspaceId === created._yay!.workspaceId && row.projectId === victimProject._yay!.projectId,
				),
				controlPages: files.filter(
					(row) =>
						row.workspaceId === String(created._yay!.workspaceId) &&
						row.projectId === String(created._yay!.defaultProjectId),
				),
				victimPages: files.filter(
					(row) =>
						row.workspaceId === String(created._yay!.workspaceId) &&
						row.projectId === String(victimProject._yay!.projectId),
				),
				controlMarkdownContent: markdownContent.filter(
					(row) =>
						row.workspaceId === String(created._yay!.workspaceId) &&
						row.projectId === String(created._yay!.defaultProjectId),
				),
				victimMarkdownContent: markdownContent.filter(
					(row) =>
						row.workspaceId === String(created._yay!.workspaceId) &&
						row.projectId === String(victimProject._yay!.projectId),
				),
				controlAiThreads: aiThreads.filter(
					(row) =>
						row.workspaceId === String(created._yay!.workspaceId) &&
						row.projectId === String(created._yay!.defaultProjectId),
				),
				victimAiThreads: aiThreads.filter(
					(row) =>
						row.workspaceId === String(created._yay!.workspaceId) &&
						row.projectId === String(victimProject._yay!.projectId),
				),
				controlAiMessages: aiMessages.filter(
					(row) =>
						row.workspaceId === String(created._yay!.workspaceId) &&
						row.projectId === String(created._yay!.defaultProjectId),
				),
				victimAiMessages: aiMessages.filter(
					(row) =>
						row.workspaceId === String(created._yay!.workspaceId) &&
						row.projectId === String(victimProject._yay!.projectId),
				),
				controlChatMessages: chatMessages.filter(
					(row) =>
						row.workspaceId === String(created._yay!.workspaceId) &&
						row.projectId === String(created._yay!.defaultProjectId),
				),
				victimChatMessages: chatMessages.filter(
					(row) =>
						row.workspaceId === String(created._yay!.workspaceId) &&
						row.projectId === String(victimProject._yay!.projectId),
				),
			};
		});

		expect(afterPurge.victimRequests).toHaveLength(0);
		expect(afterPurge.victimPages).toHaveLength(0);
		expect(afterPurge.victimMarkdownContent).toHaveLength(0);
		expect(afterPurge.victimAiThreads).toHaveLength(0);
		expect(afterPurge.victimAiMessages).toHaveLength(0);
		expect(afterPurge.victimChatMessages).toHaveLength(0);
		expect(afterPurge.controlPages).toHaveLength(1);
		expect(afterPurge.controlMarkdownContent).toHaveLength(1);
		expect(afterPurge.controlAiThreads).toHaveLength(1);
		expect(afterPurge.controlAiMessages).toHaveLength(1);
		expect(afterPurge.controlChatMessages).toHaveLength(1);
	});
});

describe("get_membership_by_workspace_project_name", () => {
	test("resolves membership for an accessible tenant", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) =>
			test_mocks_fill_db_with.membership(ctx, {
				workspaceName: "personal",
				projectName: "home",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
			email: "workspaces-test-user@test.local",
		});
		const membership = await t.run(async (ctx) => ctx.db.get("workspaces_projects_users", db.membershipId));

		const result = await asUser.query(api.workspaces.get_membership_by_workspace_project_name, {
			workspaceName: "personal",
			projectName: "home",
		});

		expect(result).toStrictEqual(membership);
	});

	test("returns null for an inaccessible tenant", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) =>
			test_mocks_fill_db_with.membership(ctx, {
				workspaceName: "personal",
				projectName: "home",
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
			email: "workspaces-test-user@test.local",
		});

		const result = await asOtherUser.query(api.workspaces.get_membership_by_workspace_project_name, {
			workspaceName: "personal",
			projectName: "home",
		});

		expect(db.membershipId).toBeTruthy();
		expect(result).toBeNull();
	});
});

describe("set_workspace_billing_mode", () => {
	test("lets the workspace owner update a created workspace billing mode", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-set-billing-owner",
			}),
		);
		await workspaces_test_bootstrap_user(t, { userId });
		const asOwner = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Billing Owner",
			email: "billing-owner@test.local",
		});
		const created = await asOwner.mutation(api.workspaces.create_workspace, {
			description: "",
			name: "billing-mode-owner",
		});
		expect(created._yay).toBeTruthy();

		const result = await asOwner.mutation(api.workspaces.set_workspace_billing_mode, {
			workspaceId: created._yay!.workspaceId,
			billingMode: "workspace_owner",
		});

		expect(result._yay).toBeNull();
		const workspace = await t.run((ctx) => ctx.db.get("workspaces", created._yay!.workspaceId));
		expect(workspace?.billingMode).toBe("workspace_owner");
	});

	test("rejects billing mode changes for personal workspaces", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-set-billing-personal",
			}),
		);
		await workspaces_test_bootstrap_user(t, { userId });
		const user = await t.run((ctx) => ctx.db.get("users", userId));
		if (!user?.defaultWorkspaceId) {
			throw new Error("Expected default workspace");
		}
		const asOwner = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Personal Billing Owner",
			email: "billing-personal@test.local",
		});

		const result = await asOwner.mutation(api.workspaces.set_workspace_billing_mode, {
			workspaceId: user.defaultWorkspaceId,
			billingMode: "workspace_owner",
		});

		expect(result).toEqual({
			_nay: {
				message: "Cannot manage billing for the default workspace",
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
		await workspaces_test_bootstrap_users(t, { userIds: [ownerId, memberId] });
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
		const created = await owner.mutation(api.workspaces.create_workspace, {
			description: "",
			name: "billing-mode-denied",
		});
		expect(created._yay).toBeTruthy();
		await t.run(async (ctx) => {
			await ctx.db.insert("workspaces_projects_users", {
				workspaceId: created._yay!.workspaceId,
				projectId: created._yay!.defaultProjectId,
				userId: memberId,
				active: true,
				updatedAt: Date.now(),
			});
			await access_control_db_ensure_role_assignment(ctx, {
				workspaceId: created._yay!.workspaceId,
				projectId: created._yay!.defaultProjectId,
				userId: memberId,
				role: "member",
				now: Date.now(),
			});
		});

		const result = await member.mutation(api.workspaces.set_workspace_billing_mode, {
			workspaceId: created._yay!.workspaceId,
			billingMode: "workspace_owner",
		});

		expect(result).toEqual({
			_nay: {
				message: "Permission denied",
			},
		});
	});
});

describe("list", () => {
	test("orders non-default workspaces alphabetically by name", async () => {
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
		await workspaces_test_bootstrap_users(t, { userIds });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userIds[0],
			name: "Test User",
			email: "workspaces-test-user@test.local",
		});
		const owner = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userIds[1],
			name: "Owner",
			email: "workspaces-test-user@test.local",
		});

		const wsZ = await asUser.mutation(api.workspaces.create_workspace, {
			description: "",
			name: "zebra-team",
		});
		expect(wsZ._yay).toBeTruthy();

		const wsA = await owner.mutation(api.workspaces.create_workspace, {
			description: "",
			name: "acme-team",
		});
		expect(wsA._yay).toBeTruthy();

		const shareResult = await owner.mutation(api.workspaces.invite_user_to_workspace_project, {
			workspaceId: wsA._yay!.workspaceId,
			projectId: wsA._yay!.defaultProjectId,
			userIdToAdd: userIds[0],
		});
		expect(shareResult._yay).toBeNull();

		const list = await asUser.query(api.workspaces.list, {});
		const names = list.workspaces.map((w) => w.name);

		expect(names).toEqual(["personal", "acme-team", "zebra-team"]);
	});

	test("places default workspace before other workspaces", async () => {
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
		await workspaces_test_bootstrap_user(t, { userId: userIds[1] });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userIds[0],
			name: "Test User",
			email: "workspaces-test-user@test.local",
		});
		const owner = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userIds[1],
			name: "Owner",
			email: "workspaces-test-user@test.local",
		});

		await workspaces_test_bootstrap_user(t, { userId: userIds[0] });

		const ownedWorkspace = await asUser.mutation(api.workspaces.create_workspace, {
			description: "",
			name: "mango-extra",
		});
		expect(ownedWorkspace._yay).toBeTruthy();
		const sharedWorkspace = await owner.mutation(api.workspaces.create_workspace, {
			description: "",
			name: "alpha-extra",
		});
		expect(sharedWorkspace._yay).toBeTruthy();
		const shareResult = await owner.mutation(api.workspaces.invite_user_to_workspace_project, {
			workspaceId: sharedWorkspace._yay!.workspaceId,
			projectId: sharedWorkspace._yay!.defaultProjectId,
			userIdToAdd: userIds[0],
		});
		expect(shareResult._yay).toBeNull();

		const list = await asUser.query(api.workspaces.list, {});
		const names = list.workspaces.map((w) => w.name);

		expect(names[0]).toBe("personal");
		expect(names.slice(1)).toEqual(["alpha-extra", "mango-extra"]);
	});

	test("orders projects with workspace primary first then alphabetically", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-list-sort-3",
			}),
		);
		await workspaces_test_bootstrap_user(t, { userId });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "workspaces-test-user@test.local",
		});

		const ws = await asUser.mutation(api.workspaces.create_workspace, {
			description: "",
			name: "proj-sort-ws",
		});
		expect(ws._yay).toBeTruthy();
		const workspaceId = ws._yay!.workspaceId;

		await asUser.mutation(api.workspaces.create_project, {
			description: "",
			workspaceId,
			name: "zebra-project",
		});

		const list = await asUser.query(api.workspaces.list, {});
		const projects = list.workspaceIdsProjectsDict[workspaceId];
		const projectNames = projects.map((p) => p.name);

		expect(projectNames[0]).toBe("home");
		expect(projectNames[1]).toBe("zebra-project");
	});

	test("keeps workspace.defaultProjectId when the user only sees non-primary project memberships", async () => {
		const t = test_convex();
		const userIds = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", { clerkUserId: "clerk-user-list-hidden-primary-owner" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-list-hidden-primary-member" }),
			]),
		);
		await workspaces_test_bootstrap_users(t, { userIds });

		const created = await t.run(async (ctx) =>
			workspaces_db_create(ctx, {
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
			email: "workspaces-test-user@test.local",
		});
		const member = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userIds[1],
			name: "Member",
			email: "workspaces-test-user@test.local",
		});

		const extra = await owner.mutation(api.workspaces.create_project, {
			description: "",
			workspaceId: created._yay!.workspaceId,
			name: "shared-project",
		});
		expect(extra._yay).toBeTruthy();

		await t.run(async (ctx) => {
			await ctx.db.insert("workspaces_projects_users", {
				workspaceId: created._yay!.workspaceId,
				projectId: extra._yay!.projectId,
				userId: userIds[1],
				active: true,
			});
		});

		const list = await member.query(api.workspaces.list, {});
		const workspace = list.workspaces.find((row) => row._id === created._yay!.workspaceId);
		const projects = list.workspaceIdsProjectsDict[created._yay!.workspaceId];

		expect(workspace?._id).toBe(created._yay!.workspaceId);
		expect(workspace?.defaultProjectId).toBe(created._yay!.defaultProjectId);
		expect(projects.map((project) => project._id)).toEqual([extra._yay!.projectId]);
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
			email: "workspaces-test-user@test.local",
		});

		const quotaDoc = await asDeletedUser.query(api.quotas.get, {
			quotaName: "extra_workspaces",
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
			email: "workspaces-test-user@test.local",
		});

		const quotaDoc = await asDeletedUser.query(api.quotas.get, {
			quotaName: "extra_workspaces",
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
				quotaName: "extra_workspaces",
				userId: id,
				now,
			});
			return id;
		});
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Live User",
			email: "workspaces-test-user@test.local",
		});

		const quotaDoc = await asUser.query(api.quotas.get, {
			quotaName: "extra_workspaces",
			userId,
		});

		expect(quotaDoc).toMatchObject({
			quotaName: "extra_workspaces",
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
			email: "workspaces-test-user@test.local",
		});

		await expect(
			asUser.query(api.quotas.get, {
				quotaName: "extra_workspaces",
				userId,
			}),
		).rejects.toThrow("Missing quota doc");
	});

	test("still throws when an accessible workspace is missing the required quota doc", async () => {
		const t = test_convex();
		const workspace = await t.run(async (ctx) => {
			const userId = await ctx.db.insert("users", { clerkUserId: "clerk-user-workspace-quota-missing-doc" });
			const now = Date.now();
			const workspaceId = await ctx.db.insert("workspaces", {
				name: "workspace-quota-missing-doc",
				description: "",
				default: false,
				billingMode: "user",
				ownerUserId: userId,
				updatedAt: now,
			});
			const projectId = await ctx.db.insert("workspaces_projects", {
				workspaceId,
				name: "home",
				description: "",
				default: true,
				updatedAt: now,
			});
			await ctx.db.insert("workspaces_projects_users", {
				workspaceId,
				projectId,
				userId,
				active: true,
				updatedAt: now,
			});

			return { userId, workspaceId };
		});
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: workspace.userId,
			name: "Live User",
			email: "workspaces-test-user@test.local",
		});

		await expect(
			asUser.query(api.quotas.get, {
				quotaName: "extra_projects",
				workspaceId: workspace.workspaceId,
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
		await workspaces_test_bootstrap_users(t, { userIds: [ownerId, memberId] });
		const member = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: memberId,
			name: "Member",
			email: "workspaces-test-user@test.local",
		});

		const quotaDoc = await member.query(api.quotas.get, {
			quotaName: "extra_workspaces",
			userId: ownerId,
		});

		expect(quotaDoc).toBeNull();
	});

	test("returns quota doc for owned non-default workspaces", async () => {
		const t = test_convex();
		const [ownerId, memberId] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", { clerkUserId: "clerk-user-list-quota-owner" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-list-quota-member" }),
			]),
		);
		await workspaces_test_bootstrap_users(t, { userIds: [ownerId, memberId] });
		const member = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: memberId,
			name: "Member",
			email: "workspaces-test-user@test.local",
		});

		const sharedWorkspace = await t.run(async (ctx) => {
			const created = await workspaces_db_create(ctx, {
				userId: ownerId,
				description: "",
				name: "quota-shared",
				now: Date.now(),
				default: false,
			});
			if (created._nay) {
				throw new Error(created._nay.message);
			}

			await ctx.db.insert("workspaces_projects_users", {
				workspaceId: created._yay.workspaceId,
				projectId: created._yay.defaultProjectId,
				userId: memberId,
				active: true,
				updatedAt: Date.now(),
			});

			return created._yay;
		});
		expect(sharedWorkspace).toBeTruthy();

		const beforeOwnedWorkspace = await member.query(api.quotas.get, {
			quotaName: "extra_workspaces",
			userId: memberId,
		});
		expect(beforeOwnedWorkspace).toMatchObject({
			quotaName: "extra_workspaces",
			userId: memberId,
			usedCount: 0,
			maxCount: 2,
		});

		const ownedWorkspace = await t.run((ctx) =>
			workspaces_db_create(ctx, {
				userId: memberId,
				description: "",
				name: "quota-owned",
				now: Date.now(),
				default: false,
			}),
		);
		expect(ownedWorkspace._yay).toBeTruthy();
		if (ownedWorkspace._nay) {
			throw new Error(ownedWorkspace._nay.message);
		}

		const afterOwnedWorkspace = await member.query(api.quotas.get, {
			quotaName: "extra_workspaces",
			userId: memberId,
		});
		expect(afterOwnedWorkspace).toMatchObject({
			quotaName: "extra_workspaces",
			userId: memberId,
			usedCount: 1,
			maxCount: 2,
		});
	});

	test("returns null for an inaccessible workspace quota scope", async () => {
		const t = test_convex();
		const [ownerId, memberId] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", { clerkUserId: "clerk-user-quota-private-owner" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-quota-private-member" }),
			]),
		);
		await workspaces_test_bootstrap_users(t, { userIds: [ownerId, memberId] });
		const member = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: memberId,
			name: "Member",
			email: "workspaces-test-user@test.local",
		});

		const workspaceResult = await t.run((ctx) =>
			workspaces_db_create(ctx, {
				userId: ownerId,
				description: "",
				name: "quota-private",
				now: Date.now(),
				default: false,
			}),
		);
		expect(workspaceResult._yay).toBeTruthy();
		if (workspaceResult._nay) {
			throw new Error(workspaceResult._nay.message);
		}

		const quotaDoc = await member.query(api.quotas.get, {
			quotaName: "extra_projects",
			workspaceId: workspaceResult._yay!.workspaceId,
		});

		expect(quotaDoc).toBeNull();
	});

	test("returns quota doc for a workspace the user can access through a non-primary project membership", async () => {
		const t = test_convex();
		const userIds = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", { clerkUserId: "clerk-user-workspace-quota-owner" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-workspace-quota-member" }),
			]),
		);
		await workspaces_test_bootstrap_users(t, { userIds });

		const owner = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userIds[0],
			name: "Owner",
			email: "workspaces-test-user@test.local",
		});
		const member = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userIds[1],
			name: "Member",
			email: "workspaces-test-user@test.local",
		});

		const created = await t.run(async (ctx) =>
			workspaces_db_create(ctx, {
				userId: userIds[0],
				name: "workspace-quota-ws",
				description: "",
				now: Date.now(),
				default: false,
			}),
		);
		expect(created._yay).toBeTruthy();

		const extra = await owner.mutation(api.workspaces.create_project, {
			description: "",
			workspaceId: created._yay!.workspaceId,
			name: "workspace-quota-proj",
		});
		expect(extra._yay).toBeTruthy();

		await t.run(async (ctx) => {
			await ctx.db.insert("workspaces_projects_users", {
				workspaceId: created._yay!.workspaceId,
				projectId: extra._yay!.projectId,
				userId: userIds[1],
				active: true,
			});
		});

		const quotaDoc = await member.query(api.quotas.get, {
			quotaName: "extra_projects",
			workspaceId: created._yay!.workspaceId,
		});
		expect(quotaDoc).toMatchObject({
			quotaName: "extra_projects",
			workspaceId: created._yay!.workspaceId,
			usedCount: 1,
			maxCount: 1,
		});
	});
});
