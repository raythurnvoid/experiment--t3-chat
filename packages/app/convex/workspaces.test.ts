import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import {
	workspaces_db_create,
	workspaces_db_ensure_default_workspace_and_project_for_user,
} from "../server/workspaces.ts";
import { Result } from "../shared/errors-as-values-utils.ts";
import { user_limits, workspace_limits } from "../shared/limits.ts";
import { workspaces_description_max_length, workspaces_name_max_length } from "../shared/workspaces.ts";

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
		const userLimit = await ctx.db
			.query("limits_per_user")
			.withIndex("by_user_limitName", (q) =>
				q.eq("userId", args.userId).eq("limitName", user_limits.EXTRA_WORKSPACES.name),
			)
			.first();
		if (!userLimit) {
			await ctx.db.insert("limits_per_user", {
				userId: args.userId,
				limitName: user_limits.EXTRA_WORKSPACES.name,
				usedCount: 0,
				maxCount: user_limits.EXTRA_WORKSPACES.maxCount,
				createdAt: now,
				updatedAt: now,
			});
		}

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

async function workspaces_test_seed_project_scoped_rows(
	ctx: MutationCtx,
	args: {
		userId: Id<"users">;
		workspaceId: string;
		projectId: string;
		tag: string;
	},
) {
	const pageId = await ctx.db.insert("pages", {
		workspaceId: args.workspaceId,
		projectId: args.projectId,
		path: `/${args.tag}-page`,
		name: `${args.tag}-page`,
		version: 0,
		parentId: "root",
		createdBy: args.userId,
		updatedBy: args.userId,
		updatedAt: Date.now(),
	});
	const markdownContentId = await ctx.db.insert("pages_markdown_content", {
		workspace_id: args.workspaceId,
		project_id: args.projectId,
		page_id: pageId,
		content: `# ${args.tag}`,
		is_archived: false,
		yjs_sequence: 0,
		updated_at: Date.now(),
		updated_by: args.userId,
	});
	const yjsLastSequenceId = await ctx.db.insert("pages_yjs_docs_last_sequences", {
		workspace_id: args.workspaceId,
		project_id: args.projectId,
		page_id: pageId,
		last_sequence: 0,
	});
	await ctx.db.patch("pages", pageId, {
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

		const { workspace, project, userLimit, workspaceLimit } = result._yay
			? await t.run(async (ctx) => {
					const [workspace, project, userLimit, workspaceLimit] = await Promise.all([
						ctx.db.get("workspaces", result._yay!.workspaceId),
						ctx.db.get("workspaces_projects", result._yay!.defaultProjectId),
						ctx.db
							.query("limits_per_user")
							.withIndex("by_user_limitName", (q) => q.eq("userId", userId).eq("limitName", "extra_workspaces"))
							.first(),
						ctx.db
							.query("limits_per_workspace")
							.withIndex("by_workspace_limitName", (q) =>
								q.eq("workspaceId", result._yay!.workspaceId).eq("limitName", "extra_projects"),
							)
							.first(),
					]);

					return {
						workspace,
						project,
						userLimit,
						workspaceLimit,
					};
				})
			: { workspace: null, project: null, userLimit: null, workspaceLimit: null };

		expect(workspace?.name).toBe("acme-labs");
		expect(workspace?.ownerUserId).toBe(userId);
		expect(project?.name).toBe("home");
		expect(userLimit?.usedCount).toBe(1);
		expect(userLimit?.maxCount).toBe(1);
		expect(workspaceLimit?.usedCount).toBe(0);
		expect(workspaceLimit?.maxCount).toBe(1);
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
			name: "a".repeat(workspaces_name_max_length + 1),
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
			description: "x".repeat(workspaces_description_max_length + 1),
			name: "long-desc-ws",
		});
		expect(result._nay?.message).toBe("Description is too long");
	});

	test("rejects creating a second owned non-default workspace", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-second-extra-workspace",
			}),
		);
		await workspaces_test_bootstrap_user(t, { userId });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "workspaces-test-user@test.local",
		});

		const first = await asUser.mutation(api.workspaces.create_workspace, {
			description: "",
			name: "first-extra-ws",
		});
		expect(first._yay).toBeTruthy();

		const second = await asUser.mutation(api.workspaces.create_workspace, {
			description: "",
			name: "second-extra-ws",
		});
		expect(second._nay?.message).toBe("You can only create 1 extra workspace in addition to your personal workspace");
	});

	test("does not count shared non-default workspaces against the owner's extra-workspace limit", async () => {
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

		const shareResult = await owner.mutation(api.workspaces.add_user_to_workspace_project, {
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

	test("keeps exactly one user limit doc while creating the extra workspace", async () => {
		const t = test_convex();
		const userId = await t.run((ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-limit-seed-workspace",
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
			(await ctx.db.query("limits_per_user").collect()).filter(
				(row) => row.userId === userId && row.limitName === user_limits.EXTRA_WORKSPACES.name,
			),
		);
		expect(before).toHaveLength(1);
		expect(before[0]?.usedCount).toBe(0);

		const created = await asUser.mutation(api.workspaces.create_workspace, {
			description: "",
			name: "lazy-seed-extra-ws",
		});
		expect(created._yay).toBeTruthy();

		const blocked = await asUser.mutation(api.workspaces.create_workspace, {
			description: "",
			name: "lazy-seed-extra-ws-2",
		});
		expect(blocked._nay?.message).toBe("You can only create 1 extra workspace in addition to your personal workspace");

		const after = await t.run(async (ctx) => {
			const [userLimits, workspaceLimits] = await Promise.all([
				ctx.db.query("limits_per_user").collect(),
				ctx.db.query("limits_per_workspace").collect(),
			]);

			return {
				userLimits: userLimits.filter(
					(row) => row.userId === userId && row.limitName === user_limits.EXTRA_WORKSPACES.name,
				),
				workspaceLimits: workspaceLimits.filter(
					(row) =>
						row.workspaceId === created._yay!.workspaceId && row.limitName === workspace_limits.EXTRA_PROJECTS.name,
				),
			};
		});

		expect(after.userLimits).toHaveLength(1);
		expect(after.userLimits[0]?.usedCount).toBe(1);
		expect(after.userLimits[0]?.maxCount).toBe(1);
		expect(after.workspaceLimits).toHaveLength(1);
		expect(after.workspaceLimits[0]?.usedCount).toBe(0);
	});
});

describe("workspaces_db_ensure_default_workspace_and_project_for_user", () => {
	test("ensures default-workspace bootstrap creates workspace limits when user limits exist", async () => {
		const t = test_convex();
		const userId = await t.run((ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-ensure-default-limits",
			}),
		);

		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert("limits_per_user", {
				userId,
				limitName: user_limits.EXTRA_WORKSPACES.name,
				usedCount: 0,
				maxCount: user_limits.EXTRA_WORKSPACES.maxCount,
				createdAt: now,
				updatedAt: now,
			});
			await workspaces_db_ensure_default_workspace_and_project_for_user(ctx, {
				userId,
				now,
			});
		});

		const rows = await t.run(async (ctx) => {
			const user = await ctx.db.get("users", userId);
			const workspaceLimit = user?.defaultWorkspaceId
				? await ctx.db
						.query("limits_per_workspace")
						.withIndex("by_workspace_limitName", (q) =>
							q.eq("workspaceId", user.defaultWorkspaceId!).eq("limitName", "extra_projects"),
						)
						.first()
				: null;
			const userLimit = await ctx.db
				.query("limits_per_user")
				.withIndex("by_user_limitName", (q) => q.eq("userId", userId).eq("limitName", "extra_workspaces"))
				.first();

			return {
				user,
				userLimit,
				workspaceLimit,
			};
		});

		expect(rows.userLimit?.usedCount).toBe(0);
		expect(rows.userLimit?.maxCount).toBe(1);
		expect(rows.workspaceLimit?.usedCount).toBe(0);
		expect(rows.workspaceLimit?.maxCount).toBe(1);
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
					const [membership, workspaceLimit] = await Promise.all([
						ctx.db
							.query("workspaces_projects_users")
							.withIndex("by_project_user_active", (q) =>
								q.eq("projectId", result._yay!.projectId).eq("userId", userId),
							)
							.first(),
						ctx.db
							.query("limits_per_workspace")
							.withIndex("by_workspace_limitName", (q) =>
								q.eq("workspaceId", wsResult._yay!.workspaceId).eq("limitName", "extra_projects"),
							)
							.first(),
					]);

					return {
						membership,
						workspaceLimit,
					};
				})
			: null;
		expect(membership?.membership).toBeTruthy();
		expect(membership?.workspaceLimit?.usedCount).toBe(1);
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

		const wsResult = await asUser.mutation(api.workspaces.create_workspace, {
			description: "",
			name: "dup-proj-ws",
		});
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
		expect(second._nay?.message).toBe(
			"This workspace already has its extra project. Each workspace can contain only 2 projects total, including home",
		);
	});

	test("does not let a shared member bypass the extra-project limit", async () => {
		const t = test_convex();
		const [ownerId, memberId] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", { clerkUserId: "clerk-user-project-limit-owner" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-project-limit-member" }),
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
			name: "shared-project-limit",
		});
		expect(sharedWorkspace._yay).toBeTruthy();

		const extraProject = await owner.mutation(api.workspaces.create_project, {
			description: "",
			workspaceId: sharedWorkspace._yay!.workspaceId,
			name: "docs",
		});
		expect(extraProject._yay).toBeTruthy();

		const shareResult = await owner.mutation(api.workspaces.add_user_to_workspace_project, {
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
		expect(result._nay?.message).toBe(
			"This workspace already has its extra project. Each workspace can contain only 2 projects total, including home",
		);
	});

	test("keeps exactly one workspace limit doc while creating the extra project", async () => {
		const t = test_convex();
		const userId = await t.run((ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-limit-seed-project",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
			email: "workspaces-test-user@test.local",
		});
		await workspaces_test_bootstrap_user(t, { userId });

		const workspaceResult = await asUser.mutation(api.workspaces.create_workspace, {
			description: "",
			name: "lazy-seed-proj-ws",
		});
		expect(workspaceResult._yay).toBeTruthy();

		const before = await t.run(async (ctx) =>
			(await ctx.db.query("limits_per_workspace").collect()).filter(
				(row) =>
					row.workspaceId === workspaceResult._yay!.workspaceId &&
					row.limitName === workspace_limits.EXTRA_PROJECTS.name,
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
		expect(blocked._nay?.message).toBe(
			"This workspace already has its extra project. Each workspace can contain only 2 projects total, including home",
		);

		const after = await t.run(async (ctx) =>
			(await ctx.db.query("limits_per_workspace").collect()).filter(
				(row) =>
					row.workspaceId === workspaceResult._yay!.workspaceId &&
					row.limitName === workspace_limits.EXTRA_PROJECTS.name,
			),
		);
		expect(after).toHaveLength(1);
		expect(after[0]?._id).toBe(before[0]?._id);
		expect(after[0]?.usedCount).toBe(1);
		expect(after[0]?.maxCount).toBe(1);
	});
});

describe("add_user_to_workspace_project", () => {
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

		const result = await owner.mutation(api.workspaces.add_user_to_workspace_project, {
			workspaceId: created._yay!.workspaceId,
			projectId: created._yay!.defaultProjectId,
			userIdToAdd: memberId,
		});

		expect(result._nay?.message).toBe("Cannot add user to default workspace");
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
			description: "x".repeat(workspaces_description_max_length + 1),
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
			name: "a".repeat(workspaces_name_max_length + 1),
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

		const wsResult = await asUser.mutation(api.workspaces.create_workspace, {
			description: "",
			name: "rename-proj-ws",
		});
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

		const wsResult = await asUser.mutation(api.workspaces.create_workspace, {
			description: "",
			name: "rename-proj-ws-id",
		});
		expect(wsResult._yay).toBeTruthy();
		const workspaceId = wsResult._yay!.workspaceId;
		const homeId = wsResult._yay!.defaultProjectId;

		const extra = await asUser.mutation(api.workspaces.create_project, {
			description: "",
			workspaceId,
			name: "zebra-docs",
		});
		expect(extra._yay).toBeTruthy();
		const zebraId = extra._yay!.projectId;

		await t.run(async (ctx) => {
			await ctx.db.patch("workspaces_projects", homeId, { default: false });
			await ctx.db.patch("workspaces", workspaceId, { defaultProjectId: zebraId });
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

		const wsResult = await asUser.mutation(api.workspaces.create_workspace, {
			description: "",
			name: "rename-secondary-ws",
		});
		expect(wsResult._yay).toBeTruthy();

		const extra = await asUser.mutation(api.workspaces.create_project, {
			description: "",
			workspaceId: wsResult._yay!.workspaceId,
			name: "sidecar",
		});
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

		const wsResult = await asUser.mutation(api.workspaces.create_workspace, {
			description: "",
			name: "rename-proj-desc-ws",
		});
		expect(wsResult._yay).toBeTruthy();

		const extra = await asUser.mutation(api.workspaces.create_project, {
			description: "Scratch space",
			workspaceId: wsResult._yay!.workspaceId,
			name: "side-note",
		});
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

		const wsResult = await asUser.mutation(api.workspaces.create_workspace, {
			description: "",
			name: "edit-proj-desc-ws",
		});
		expect(wsResult._yay).toBeTruthy();

		const extra = await asUser.mutation(api.workspaces.create_project, {
			description: "Scratch space",
			workspaceId: wsResult._yay!.workspaceId,
			name: "edit-proj-desc",
		});
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
			const [project, requests, user, workspaceLimit, pages, markdownContent, aiThreads, aiMessages, chatMessages] =
				await Promise.all([
					ctx.db.get("workspaces_projects", extraProject._yay!.projectId),
					ctx.db.query("data_deletion_requests").collect(),
					ctx.db.get("users", userId),
					ctx.db
						.query("limits_per_workspace")
						.withIndex("by_workspace_limitName", (q) =>
							q.eq("workspaceId", created._yay!.workspaceId).eq("limitName", "extra_projects"),
						)
						.first(),
					ctx.db.query("pages").collect(),
					ctx.db.query("pages_markdown_content").collect(),
					ctx.db.query("ai_chat_threads").collect(),
					ctx.db.query("ai_chat_threads_messages_aisdk_5").collect(),
					ctx.db.query("chat_messages").collect(),
				]);

			return {
				project,
				requests: requests.filter(
					(row) => row.workspaceId === created._yay!.workspaceId && row.projectId === extraProject._yay!.projectId,
				),
				user,
				workspaceLimit,
				pages: pages.filter(
					(row) =>
						row.workspaceId === String(created._yay!.workspaceId) &&
						row.projectId === String(extraProject._yay!.projectId),
				),
				markdownContent: markdownContent.filter(
					(row) =>
						row.workspace_id === String(created._yay!.workspaceId) &&
						row.project_id === String(extraProject._yay!.projectId),
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
			};
		});

		expect(after_delete.project).toBeNull();
		expect(after_delete.requests).toHaveLength(1);
		expect(after_delete.requests[0]?.scope).toBe("project");
		expect(after_delete.pages).toHaveLength(1);
		expect(after_delete.markdownContent).toHaveLength(1);
		expect(after_delete.aiThreads).toHaveLength(1);
		expect(after_delete.aiMessages).toHaveLength(1);
		expect(after_delete.chatMessages).toHaveLength(1);
		expect(after_delete.workspaceLimit?.usedCount).toBe(0);
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

		const limitsBeforeDelete = await t.run(async (ctx) =>
			ctx.db
				.query("limits_per_workspace")
				.withIndex("by_workspace_limitName", (q) => q.eq("workspaceId", created._yay!.workspaceId))
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
				ownerLimit,
				workspaceLimits,
				memberships,
				requests,
				pages,
				aiThreads,
				aiMessages,
				chatMessages,
			] = await Promise.all([
				ctx.db.get("workspaces", created._yay!.workspaceId),
				ctx.db.get("workspaces_projects", created._yay!.defaultProjectId),
				ctx.db.get("workspaces_projects", extraProject._yay!.projectId),
				ctx.db.get("users", memberId),
				ctx.db
					.query("limits_per_user")
					.withIndex("by_user_limitName", (q) => q.eq("userId", ownerId).eq("limitName", "extra_workspaces"))
					.first(),
				ctx.db
					.query("limits_per_workspace")
					.withIndex("by_workspace_limitName", (q) => q.eq("workspaceId", created._yay!.workspaceId))
					.collect(),
				ctx.db.query("workspaces_projects_users").collect(),
				ctx.db.query("data_deletion_requests").collect(),
				ctx.db.query("pages").collect(),
				ctx.db.query("ai_chat_threads").collect(),
				ctx.db.query("ai_chat_threads_messages_aisdk_5").collect(),
				ctx.db.query("chat_messages").collect(),
			]);

			return {
				workspace,
				defaultProject,
				secondaryProject,
				member,
				ownerLimit,
				workspaceLimits,
				memberships: memberships.filter((row) => row.workspaceId === created._yay!.workspaceId),
				requests: requests.filter((row) => row.workspaceId === created._yay!.workspaceId),
				pages: pages.filter((row) => row.workspaceId === String(created._yay!.workspaceId)),
				aiThreads: aiThreads.filter((row) => row.workspaceId === String(created._yay!.workspaceId)),
				aiMessages: aiMessages.filter((row) => row.workspaceId === String(created._yay!.workspaceId)),
				chatMessages: chatMessages.filter((row) => row.workspaceId === String(created._yay!.workspaceId)),
			};
		});

		expect(after_delete.workspace).not.toBeNull();
		expect(after_delete.defaultProject).not.toBeNull();
		expect(after_delete.secondaryProject).not.toBeNull();
		expect(after_delete.memberships).toHaveLength(0);
		expect(after_delete.requests).toHaveLength(1);
		expect(after_delete.requests[0]?.scope).toBe("workspace");
		expect(after_delete.pages).toHaveLength(2);
		expect(after_delete.aiThreads).toHaveLength(2);
		expect(after_delete.aiMessages).toHaveLength(2);
		expect(after_delete.chatMessages).toHaveLength(2);
		expect(after_delete.ownerLimit?.usedCount).toBe(0);
		expect(after_delete.workspaceLimits.map((row) => row._id).sort()).toEqual(
			limitsBeforeDelete.map((row) => row._id).sort(),
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
			const [workspace, defaultProject, secondaryProject, workspaceLimits, pages] = await Promise.all([
				ctx.db.get("workspaces", created._yay!.workspaceId),
				ctx.db.get("workspaces_projects", created._yay!.defaultProjectId),
				ctx.db.get("workspaces_projects", extraProject._yay!.projectId),
				ctx.db
					.query("limits_per_workspace")
					.withIndex("by_workspace_limitName", (q) => q.eq("workspaceId", created._yay!.workspaceId))
					.collect(),
				ctx.db.query("pages").collect(),
			]);
			return {
				workspace,
				defaultProject,
				secondaryProject,
				workspaceLimits,
				pages: pages.filter((row) => row.workspaceId === String(created._yay!.workspaceId)),
			};
		});
		expect(after_purge.workspace).toBeNull();
		expect(after_purge.defaultProject).toBeNull();
		expect(after_purge.secondaryProject).toBeNull();
		expect(after_purge.workspaceLimits).toHaveLength(0);
		expect(after_purge.pages).toHaveLength(0);
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

		const extraProject = await owner.mutation(api.workspaces.create_project, {
			description: "",
			workspaceId: created._yay!.workspaceId,
			name: "scratch",
		});
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
			const [requests, pages, markdownContent, aiThreads, aiMessages, chatMessages] = await Promise.all([
				ctx.db.query("data_deletion_requests").collect(),
				ctx.db.query("pages").collect(),
				ctx.db.query("pages_markdown_content").collect(),
				ctx.db.query("ai_chat_threads").collect(),
				ctx.db.query("ai_chat_threads_messages_aisdk_5").collect(),
				ctx.db.query("chat_messages").collect(),
			]);

			return {
				victimRequests: requests.filter(
					(row) => row.workspaceId === created._yay!.workspaceId && row.projectId === victimProject._yay!.projectId,
				),
				controlPages: pages.filter(
					(row) =>
						row.workspaceId === String(created._yay!.workspaceId) &&
						row.projectId === String(created._yay!.defaultProjectId),
				),
				victimPages: pages.filter(
					(row) =>
						row.workspaceId === String(created._yay!.workspaceId) &&
						row.projectId === String(victimProject._yay!.projectId),
				),
				controlMarkdownContent: markdownContent.filter(
					(row) =>
						row.workspace_id === String(created._yay!.workspaceId) &&
						row.project_id === String(created._yay!.defaultProjectId),
				),
				victimMarkdownContent: markdownContent.filter(
					(row) =>
						row.workspace_id === String(created._yay!.workspaceId) &&
						row.project_id === String(victimProject._yay!.projectId),
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

		const shareResult = await owner.mutation(api.workspaces.add_user_to_workspace_project, {
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
		const shareResult = await owner.mutation(api.workspaces.add_user_to_workspace_project, {
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

describe("get_user_limit", () => {
	test("returns null for stale identities after the user row is purged", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) => {
			const id = await ctx.db.insert("users", { clerkUserId: "clerk-user-limit-purged" });
			await ctx.db.delete(id);
			return id;
		});
		const asDeletedUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Deleted User",
			email: "workspaces-test-user@test.local",
		});

		const capability = await asDeletedUser.query(api.limits.get_user_limit, {
			userId,
			limitName: "extra_workspaces",
		});

		expect(capability).toBeNull();
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

		const capability = await asDeletedUser.query(api.limits.get_user_limit, {
			userId,
			limitName: "extra_workspaces",
		});

		expect(capability).toBeNull();
	});

	test("still throws when a live user is missing the required limit doc", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) => {
			return await ctx.db.insert("users", { clerkUserId: "clerk-user-limit-missing-doc" });
		});
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Live User",
			email: "workspaces-test-user@test.local",
		});

		await expect(
			asUser.query(api.limits.get_user_limit, {
				userId,
				limitName: "extra_workspaces",
			}),
		).rejects.toThrow("Missing user limit doc");
	});

	test("counts only owned non-default workspaces for workspace-create capability", async () => {
		const t = test_convex();
		const [ownerId, memberId] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", { clerkUserId: "clerk-user-list-cap-owner" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-list-cap-member" }),
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
			name: "workspace-cap-shared",
		});
		expect(sharedWorkspace._yay).toBeTruthy();

		const shareResult = await owner.mutation(api.workspaces.add_user_to_workspace_project, {
			workspaceId: sharedWorkspace._yay!.workspaceId,
			projectId: sharedWorkspace._yay!.defaultProjectId,
			userIdToAdd: memberId,
		});
		expect(shareResult._yay).toBeNull();

		const beforeOwnedWorkspace = await member.query(api.limits.get_user_limit, {
			userId: memberId,
			limitName: "extra_workspaces",
		});
		expect(beforeOwnedWorkspace).toEqual({
			limitName: "extra_workspaces",
			allowed: true,
			usedCount: 0,
			maxCount: 1,
			remainingCount: 1,
			disabledReason: null,
		});

		const ownedWorkspace = await member.mutation(api.workspaces.create_workspace, {
			description: "",
			name: "workspace-cap-owned",
		});
		expect(ownedWorkspace._yay).toBeTruthy();

		const afterOwnedWorkspace = await member.query(api.limits.get_user_limit, {
			userId: memberId,
			limitName: "extra_workspaces",
		});
		expect(afterOwnedWorkspace).toEqual({
			limitName: "extra_workspaces",
			allowed: false,
			usedCount: 1,
			maxCount: 1,
			remainingCount: 0,
			disabledReason: "You can only create 1 extra workspace in addition to your personal workspace",
		});
	});
});

describe("get_workspace_limit", () => {
	test("returns capability for a workspace the user can access through a non-primary project membership", async () => {
		const t = test_convex();
		const userIds = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", { clerkUserId: "clerk-user-workspace-limit-owner" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-workspace-limit-member" }),
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
				name: "workspace-limit-ws",
				description: "",
				now: Date.now(),
				default: false,
			}),
		);
		expect(created._yay).toBeTruthy();

		const extra = await owner.mutation(api.workspaces.create_project, {
			description: "",
			workspaceId: created._yay!.workspaceId,
			name: "workspace-limit-proj",
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

		const capability = await member.query(api.limits.get_workspace_limit, {
			workspaceId: created._yay!.workspaceId,
			limitName: "extra_projects",
		});
		expect(capability).toEqual({
			limitName: "extra_projects",
			allowed: false,
			usedCount: 1,
			maxCount: 1,
			remainingCount: 0,
			disabledReason:
				"This workspace already has its extra project. Each workspace can contain only 2 projects total, including home",
		});
	});
});
