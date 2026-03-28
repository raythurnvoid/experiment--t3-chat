import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import { workspaces_db_create } from "../server/workspaces.ts";

describe("create_workspace", () => {
	test("accepts names with digits after the first character", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-digits-ws",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
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
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
		});

		const result = await asUser.mutation(api.workspaces.create_workspace, {
			description: "",
			name: "acme-labs",
		});

		expect(result._yay).toBeTruthy();
		expect(result._yay?.name).toBe("acme-labs");
		expect(result._yay?.defaultProjectName).toBe("home");

		const workspace = result._yay ? await t.run((ctx) => ctx.db.get("workspaces", result._yay.workspaceId)) : null;
		const project = result._yay
			? await t.run((ctx) => ctx.db.get("workspaces_projects", result._yay.defaultProjectId))
			: null;

		expect(workspace?.name).toBe("acme-labs");
		expect(project?.name).toBe("home");
	});

	test("rejects names that are still invalid after autofix", async () => {
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
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
		});

		const result = await asUser.mutation(api.workspaces.create_workspace, {
			description: "",
			name: "  !!ab!!  ",
		});

		expect(result._nay?.message).toBe("Name must be at least 3 characters");
	});

	test("autofixes messy workspace names before create", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-autofix-ws",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
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
					.then((userId) =>
						workspaces_db_create(ctx, { userId, name: "personal", description: "", now: Date.now(), default: true }),
					),
				ctx.db
					.insert("users", {
						clerkUserId: "clerk-user-5",
					})
					.then((userId) =>
						workspaces_db_create(ctx, { userId, name: "personal", description: "", now: Date.now(), default: true }),
					),
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
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
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
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
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
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
		});

		const result = await asUser.mutation(api.workspaces.create_workspace, {
			description: "x".repeat(501),
			name: "long-desc-ws",
		});
		expect(result._nay?.message).toBe("Description is too long");
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
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
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
			? await t.run(async (ctx) =>
					ctx.db
						.query("workspaces_projects_users")
						.withIndex("by_projectId_userId", (q) => q.eq("projectId", result._yay!.projectId).eq("userId", userId))
						.first(),
				)
			: null;
		expect(membership).toBeTruthy();
	});

	test("stores trimmed project description", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-proj-desc",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
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
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
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
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
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
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
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

		const owner = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userIds[0],
			name: "Owner",
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
		});

		const result = await stranger.mutation(api.workspaces.create_project, {
			description: "",
			workspaceId: wsResult._yay!.workspaceId,
			name: "intruder",
		});
		expect(result._nay?.message).toBe("Workspace not found");
	});
});

describe("rename_workspace", () => {
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
		});

		const created = await t.run(async (ctx) =>
			workspaces_db_create(ctx, {
				userId,
				name: "personal",
				description: "",
				now: Date.now(),
				default: true,
			}),
		);
		expect(created._yay).toBeTruthy();

		const result = await asUser.mutation(api.workspaces.rename_workspace, {
			workspaceId: created._yay!.workspaceId,
			defaultProjectId: created._yay!.defaultProjectId,
			name: "renamed-personal",
		});

		expect(result._nay?.message).toBe("Cannot rename the default workspace");
	});

	test("allows renaming a non-default workspace", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-rename-nond-ws",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
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

		const result = await asUser.mutation(api.workspaces.rename_workspace, {
			workspaceId: created._yay!.workspaceId,
			defaultProjectId: created._yay!.defaultProjectId,
			name: "extra-renamed",
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
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
		});

		const created = await asUser.mutation(api.workspaces.create_workspace, {
			description: "Product org",
			name: "rename-keep-desc-ws",
		});
		expect(created._yay).toBeTruthy();

		const wsId = created._yay!.workspaceId;
		const before = await t.run((ctx) => ctx.db.get("workspaces", wsId));
		expect(before?.description).toBe("Product org");

		const renamed = await asUser.mutation(api.workspaces.rename_workspace, {
			workspaceId: wsId,
			defaultProjectId: created._yay!.defaultProjectId,
			name: "rename-keep-desc-ws-next",
		});
		expect(renamed._yay?.name).toBe("rename-keep-desc-ws-next");

		const after = await t.run((ctx) => ctx.db.get("workspaces", wsId));
		expect(after?.description).toBe("Product org");
	});

	test("returns Not found when defaultProjectId is not the workspace primary", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-rename-ws-wrong-default-proj",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
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

		const result = await asUser.mutation(api.workspaces.rename_workspace, {
			workspaceId: created._yay!.workspaceId,
			defaultProjectId: extra._yay!.projectId,
			name: "renamed-ws",
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
		});

		const result = await stranger.mutation(api.workspaces.rename_workspace, {
			workspaceId: created._yay!.workspaceId,
			defaultProjectId: created._yay!.defaultProjectId,
			name: "hijacked",
		});

		expect(result._nay?.message).toBe("Not found");
	});
});

describe("rename_project", () => {
	test("rejects renaming the primary project when project.default is true", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-rename-primary-proj",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
		});

		const wsResult = await asUser.mutation(api.workspaces.create_workspace, {
			description: "",
			name: "rename-proj-ws",
		});
		expect(wsResult._yay).toBeTruthy();

		const result = await asUser.mutation(api.workspaces.rename_project, {
			workspaceId: wsResult._yay!.workspaceId,
			defaultProjectId: wsResult._yay!.defaultProjectId,
			projectId: wsResult._yay!.defaultProjectId,
			name: "new-home",
		});

		expect(result._nay?.message).toBe("Cannot rename the default project");
	});

	test("rejects renaming the primary project when only defaultProjectId matches", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-rename-primary-proj-id",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
		});

		const wsResult = await asUser.mutation(api.workspaces.create_workspace, {
			description: "",
			name: "rename-proj-ws-id-only",
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

		const blocked = await asUser.mutation(api.workspaces.rename_project, {
			workspaceId,
			defaultProjectId: zebraId,
			projectId: zebraId,
			name: "blocked-zebra",
		});
		expect(blocked._nay?.message).toBe("Cannot rename the default project");

		const ok = await asUser.mutation(api.workspaces.rename_project, {
			workspaceId,
			defaultProjectId: zebraId,
			projectId: homeId,
			name: "former-home",
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
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
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

		const result = await asUser.mutation(api.workspaces.rename_project, {
			workspaceId: wsResult._yay!.workspaceId,
			defaultProjectId: wsResult._yay!.defaultProjectId,
			projectId: extra._yay!.projectId,
			name: "sidecar-renamed",
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
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
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

		const renamed = await asUser.mutation(api.workspaces.rename_project, {
			workspaceId: wsResult._yay!.workspaceId,
			defaultProjectId: wsResult._yay!.defaultProjectId,
			projectId,
			name: "side-note-v2",
		});
		expect(renamed._yay?.name).toBe("side-note-v2");

		const after = await t.run((ctx) => ctx.db.get("workspaces_projects", projectId));
		expect(after?.description).toBe("Scratch space");
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
				description: "",
				default: true,
				updatedAt: now,
			});
			const projectId = await ctx.db.insert("workspaces_projects", {
				workspaceId,
				name: "home",
				description: "",
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
				description: "",
				default: true,
				updatedAt: now,
			});
			const projectId2 = await ctx.db.insert("workspaces_projects", {
				workspaceId: workspaceId2,
				name: "home",
				description: "",
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
					description: "",
					default: false,
					updatedAt: now,
				}),
				ctx.db.insert("workspaces", {
					name: "personal",
					description: "",
					default: false,
					updatedAt: now,
				}),
			]);

			const [projectId1, projectId2, projectId3] = await Promise.all([
				ctx.db.insert("workspaces_projects", {
					workspaceId: workspaceId1,
					name: "Home",
					description: "",
					default: true,
					updatedAt: now,
				}),
				ctx.db.insert("workspaces_projects", {
					workspaceId: workspaceId1,
					name: "home",
					description: "",
					default: false,
					updatedAt: now,
				}),
				ctx.db.insert("workspaces_projects", {
					workspaceId: workspaceId2,
					name: "Home",
					description: "",
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
					description: "",
					default: true,
					updatedAt: now,
				}),
				ctx.db.insert("workspaces", {
					name: "personal",
					description: "",
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

describe("list", () => {
	test("orders non-default workspaces alphabetically by name", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-list-sort-1",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
		});

		const wsZ = await asUser.mutation(api.workspaces.create_workspace, {
			description: "",
			name: "zebra-team",
		});
		expect(wsZ._yay).toBeTruthy();

		const wsA = await asUser.mutation(api.workspaces.create_workspace, {
			description: "",
			name: "acme-team",
		});
		expect(wsA._yay).toBeTruthy();

		const list = await asUser.query(api.workspaces.list, {});
		const names = list.workspaces.map((w) => w.name);

		expect(names).toEqual(["acme-team", "zebra-team"]);
	});

	test("places default workspace before other workspaces", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-list-sort-2",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
		});

		const seedResult = await t.run(async (ctx) =>
			workspaces_db_create(ctx, {
				userId,
				name: "personal",
				description: "",
				now: Date.now(),
				default: true,
			}),
		);
		expect(seedResult._yay).toBeTruthy();

		await asUser.mutation(api.workspaces.create_workspace, { description: "", name: "mango-extra" });
		await asUser.mutation(api.workspaces.create_workspace, { description: "", name: "alpha-extra" });

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
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
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
		});
		const member = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userIds[1],
			name: "Member",
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
			});
		});

		const list = await member.query(api.workspaces.list, {});
		const [workspace] = list.workspaces;
		const projects = list.workspaceIdsProjectsDict[created._yay!.workspaceId];

		expect(workspace?._id).toBe(created._yay!.workspaceId);
		expect(workspace?.defaultProjectId).toBe(created._yay!.defaultProjectId);
		expect(projects.map((project) => project._id)).toEqual([extra._yay!.projectId]);
	});
});

describe("backfill_workspace_and_project_descriptions", () => {
	test("is a no-op when every row already has description", async () => {
		const t = test_convex();
		const userId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: "clerk-user-backfill-desc",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: userId,
			name: "Test User",
		});

		await asUser.mutation(api.workspaces.create_workspace, {
			description: "x",
			name: "backfill-seed-ws",
		});

		const first = await t.run(async (ctx) =>
			ctx.runMutation(internal.migrations.backfill_workspace_and_project_descriptions, {}),
		);
		expect(first.patchedWorkspaces).toBe(0);
		expect(first.patchedProjects).toBe(0);

		const second = await t.run(async (ctx) =>
			ctx.runMutation(internal.migrations.backfill_workspace_and_project_descriptions, {}),
		);
		expect(second.patchedWorkspaces).toBe(0);
		expect(second.patchedProjects).toBe(0);
	});
});
