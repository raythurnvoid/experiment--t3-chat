import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import { workspaces_db_create } from "../server/workspaces.ts";

describe("create_workspace", () => {
	test("accepts valid lowercase dash names", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-1",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
		});

		const result = await asUser.mutation(api.workspaces.create_workspace, {
			name: "acme-labs",
		});

		expect(result._yay).toBeTruthy();

		const workspace = result._yay ? await t.run((ctx) => ctx.db.get("workspaces", result._yay.workspaceId)) : null;
		const project = result._yay ? await t.run((ctx) => ctx.db.get("workspaces_projects", result._yay.defaultProjectId)) : null;

		expect(workspace?.name).toBe("acme-labs");
		expect(project?.name).toBe("home");
	});

	test("rejects invalid names", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-2",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
		});

		const invalidNames = ["Acme", "acme labs", "acme_1", "acme--labs", "-acme", "acme-", ""];

		for (const name of invalidNames) {
			const result = await asUser.mutation(api.workspaces.create_workspace, {
				name,
			});

			expect(result._nay?.message).toBeTruthy();
		}
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

		const firstUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userIds[0],
			name: "First User",
		});
		const secondUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userIds[1],
			name: "Second User",
		});

		const firstResult = await firstUser.mutation(api.workspaces.create_workspace, {
			name: "acme",
		});
		expect(firstResult._yay).toBeTruthy();

		const secondResult = await secondUser.mutation(api.workspaces.create_workspace, {
			name: "acme",
		});
		expect(secondResult._nay?.message).toBe("Workspace name already exists");
	});

	test("allows duplicate default personal workspaces across users", async () => {
		const t = test_convex();
		const results = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.insert("users", {
					clerkUserId: "clerk-user-4",
				}).then((userId) => workspaces_db_create(ctx, { userId, name: "personal", now: Date.now(), default: true })),
				ctx.db.insert("users", {
					clerkUserId: "clerk-user-5",
				}).then((userId) => workspaces_db_create(ctx, { userId, name: "personal", now: Date.now(), default: true })),
			]),
		);

		expect(results[0]._yay).toBeTruthy();
		expect(results[1]._yay).toBeTruthy();
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
		});

		const result = await asOtherUser.query(api.workspaces.get_membership_by_workspace_project_name, {
			workspaceName: "personal",
			projectName: "home",
		});

		expect(db.membershipId).toBeTruthy();
		expect(result).toBeNull();
	});

	test("prefers the signed-in user's default workspace when personal/home collides", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) => {
			const now = Date.now();
			const userId = await ctx.db.insert("users", {
				clerkUserId: "clerk-user-6",
			});
			const otherUserId = await ctx.db.insert("users", {
				clerkUserId: "clerk-user-7",
			});

			const workspaceId = await ctx.db.insert("workspaces", {
				name: "personal",
				default: true,
				updatedAt: now,
			});
			const projectId = await ctx.db.insert("workspaces_projects", {
				workspaceId,
				name: "home",
				default: true,
				updatedAt: now,
			});
			await ctx.db.patch("workspaces", workspaceId, {
				defaultProjectId: projectId,
			});
			const membershipId = await ctx.db.insert("workspaces_projects_users", {
				workspaceId,
				projectId,
				userId,
			});
			await ctx.db.patch("users", userId, {
				defaultWorkspaceId: workspaceId,
				defaultProjectId: projectId,
			});

			const workspaceId2 = await ctx.db.insert("workspaces", {
				name: "personal",
				default: true,
				updatedAt: now,
			});
			const projectId2 = await ctx.db.insert("workspaces_projects", {
				workspaceId: workspaceId2,
				name: "home",
				default: true,
				updatedAt: now,
			});
			await ctx.db.patch("workspaces", workspaceId2, {
				defaultProjectId: projectId2,
			});
			await ctx.db.insert("workspaces_projects_users", {
				workspaceId: workspaceId2,
				projectId: projectId2,
				userId: otherUserId,
			});
			await ctx.db.insert("workspaces_projects_users", {
				workspaceId: workspaceId2,
				projectId: projectId2,
				userId,
			});

			return { membershipId, projectId, userId, workspaceId };
		});
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const result = await asUser.query(api.workspaces.get_membership_by_workspace_project_name, {
			workspaceName: "personal",
			projectName: "home",
		});

		expect(result?._id).toBe(seeded.membershipId);
		expect(result?.projectId).toBe(seeded.projectId);
		expect(result?.workspaceId).toBe(seeded.workspaceId);
	});
});

describe("migrate_workspace_and_project_names_to_url_safe", () => {
	test("slugifies and dedupes names", async () => {
		const t = test_convex();
		const ids = await t.run(async (ctx) => {
			const now = Date.now();
			const [userId, workspaceId1, workspaceId2] = await Promise.all([
				ctx.db.insert("users", {
					clerkUserId: "clerk-user-6",
				}),
				ctx.db.insert("workspaces", {
					name: "Personal",
					default: false,
					updatedAt: now,
				}),
				ctx.db.insert("workspaces", {
					name: "personal",
					default: false,
					updatedAt: now,
				}),
			]);

			const [projectId1, projectId2, projectId3] = await Promise.all([
				ctx.db.insert("workspaces_projects", {
					workspaceId: workspaceId1,
					name: "Home",
					default: true,
					updatedAt: now,
				}),
				ctx.db.insert("workspaces_projects", {
					workspaceId: workspaceId1,
					name: "home",
					default: false,
					updatedAt: now,
				}),
				ctx.db.insert("workspaces_projects", {
					workspaceId: workspaceId2,
					name: "Home",
					default: true,
					updatedAt: now,
				}),
			]);

			await Promise.all([
				ctx.db.patch("workspaces", workspaceId1, {
					defaultProjectId: projectId1,
				}),
				ctx.db.patch("workspaces", workspaceId2, {
					defaultProjectId: projectId3,
				}),
				ctx.db.insert("workspaces_projects_users", {
					workspaceId: workspaceId1,
					projectId: projectId1,
					userId,
				}),
				ctx.db.insert("workspaces_projects_users", {
					workspaceId: workspaceId2,
					projectId: projectId3,
					userId,
				}),
			]);

			return { projectId1, projectId2, projectId3, workspaceId1, workspaceId2 };
		});

		const result = await t.run(async (ctx) =>
			ctx.runMutation(internal.migrations.migrate_workspace_and_project_names_to_url_safe, {}),
		);
		expect(result).toStrictEqual({
			scannedProjects: 3,
			scannedWorkspaces: 2,
			patchedProjects: 3,
			patchedWorkspaces: 2,
		});

		const [workspace1, workspace2, project1, project2, project3] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db.get("workspaces", ids.workspaceId1),
				ctx.db.get("workspaces", ids.workspaceId2),
				ctx.db.get("workspaces_projects", ids.projectId1),
				ctx.db.get("workspaces_projects", ids.projectId2),
				ctx.db.get("workspaces_projects", ids.projectId3),
			]),
		);

		expect(workspace1?.name).toBe("personal");
		expect(workspace2?.name).toBe("personal-2");
		expect(project1?.name).toBe("home");
		expect(project2?.name).toBe("home-2");
		expect(project3?.name).toBe("home");
	});

	test("preserves duplicate default personal workspaces", async () => {
		const t = test_convex();
		const ids = await t.run(async (ctx) => {
			const now = Date.now();
			const [workspaceId1, workspaceId2] = await Promise.all([
				ctx.db.insert("workspaces", {
					name: "Personal",
					default: true,
					updatedAt: now,
				}),
				ctx.db.insert("workspaces", {
					name: "personal",
					default: true,
					updatedAt: now,
				}),
			]);

			return { workspaceId1, workspaceId2 };
		});

		const result = await t.run(async (ctx) =>
			ctx.runMutation(internal.migrations.migrate_workspace_and_project_names_to_url_safe, {}),
		);
		expect(result.patchedWorkspaces).toBe(1);

		const [workspace1, workspace2] = await t.run(async (ctx) =>
			Promise.all([ctx.db.get("workspaces", ids.workspaceId1), ctx.db.get("workspaces", ids.workspaceId2)]),
		);

		expect(workspace1?.name).toBe("personal");
		expect(workspace2?.name).toBe("personal");
	});
});
