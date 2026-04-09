import { describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.js";
import type { MutationCtx } from "./_generated/server.js";
import { test_convex } from "./setup.test.ts";
import { workspaces_db_ensure_default_workspace_and_project_for_user } from "../server/workspaces.ts";
import { user_limits } from "../shared/limits.ts";

async function users_test_bootstrap_user(
	ctx: MutationCtx,
	args: { clerkUserId: string; displayName: string; avatarUrl?: string },
) {
	const now = Date.now();
	const userId = await ctx.db.insert("users", {
		clerkUserId: args.clerkUserId,
	});

	await Promise.all([
		ctx.db.insert("limits_per_user", {
			userId,
			limitName: user_limits.EXTRA_WORKSPACES.name,
			usedCount: 0,
			maxCount: user_limits.EXTRA_WORKSPACES.maxCount,
			createdAt: now,
			updatedAt: now,
		}),
		ctx.db
			.insert("users_anagraphics", {
				userId,
				displayName: args.displayName,
				avatarUrl: args.avatarUrl,
				updatedAt: now,
			})
			.then((anagraphicId) =>
				ctx.db.patch("users", userId, {
					anagraphic: anagraphicId,
				}),
			),
	]);

	await workspaces_db_ensure_default_workspace_and_project_for_user(ctx, {
		userId,
		now,
	});

	const user = await ctx.db.get("users", userId);
	if (!user?.anagraphic || !user.defaultWorkspaceId || !user.defaultProjectId) {
		throw new Error("Expected bootstrapped user");
	}

	return {
		userId,
		anagraphicId: user.anagraphic,
		defaultWorkspaceId: user.defaultWorkspaceId,
		defaultProjectId: user.defaultProjectId,
	} as const;
}

async function users_test_bootstrap_anonymous_user(ctx: MutationCtx, args: { displayName: string }) {
	const now = Date.now();
	const userId = await ctx.db.insert("users", {
		clerkUserId: null,
	});

	await Promise.all([
		ctx.db.insert("limits_per_user", {
			userId,
			limitName: user_limits.EXTRA_WORKSPACES.name,
			usedCount: 0,
			maxCount: user_limits.EXTRA_WORKSPACES.maxCount,
			createdAt: now,
			updatedAt: now,
		}),
		ctx.db
			.insert("users_anagraphics", {
				userId,
				displayName: args.displayName,
				updatedAt: now,
			})
			.then((anagraphicId) =>
				ctx.db.patch("users", userId, {
					anagraphic: anagraphicId,
				}),
			),
	]);

	await workspaces_db_ensure_default_workspace_and_project_for_user(ctx, {
		userId,
		now,
	});

	const user = await ctx.db.get("users", userId);
	if (!user?.anagraphic || !user.defaultWorkspaceId || !user.defaultProjectId) {
		throw new Error("Expected bootstrapped anonymous user");
	}

	return {
		userId,
		anagraphicId: user.anagraphic,
		defaultWorkspaceId: user.defaultWorkspaceId,
		defaultProjectId: user.defaultProjectId,
	} as const;
}

describe("delete_current_user_account", () => {
	test("returns Unauthorized when no authenticated identity is present", async () => {
		const t = test_convex();

		const result = await t.action(api.users.delete_current_user_account, {});

		expect(result._yay).toBeUndefined();
		expect(result._nay?.message).toBe("Unauthorized");
	});

	test("returns Unauthorized when Clerk external_id is not set yet", async () => {
		const t = test_convex();
		const asSignedInWithoutExternalId = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "clerk-user-without-external-id",
			name: "Delete Unresolved Clerk User",
		});

		const result = await asSignedInWithoutExternalId.action(api.users.delete_current_user_account, {});

		expect(result._yay).toBeUndefined();
		expect(result._nay?.message).toBe("Unauthorized");
	});

	test("deletes the Clerk user and processes the local tombstone flow", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			users_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-account-delete",
				displayName: "Delete Action User",
			}),
		);

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "clerk-user-account-delete",
			external_id: seeded.userId,
			name: "Delete Action User",
		});

		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(null, {
				status: 200,
			}),
		);

		try {
			const result = await asUser.action(api.users.delete_current_user_account, {});

			const after = await t.run(async (ctx) => {
				const [user, request, purgeRequests, memberships, workspace, project] = await Promise.all([
					ctx.db.get("users", seeded.userId),
					ctx.db
						.query("data_deletion_requests")
						.withIndex("by_userId", (q) => q.eq("userId", seeded.userId))
						.first(),
					ctx.db
						.query("data_deletion_requests")
						.collect()
						.then((rows) => rows.filter((r) => r.scope !== "user")),
					ctx.db
						.query("workspaces_projects_users")
						.withIndex("by_user_workspace_project_active", (q) => q.eq("userId", seeded.userId))
						.collect(),
					ctx.db.get("workspaces", seeded.defaultWorkspaceId),
					ctx.db.get("workspaces_projects", seeded.defaultProjectId),
				]);

				return {
					user,
					request,
					purgeRequests,
					memberships,
					workspace,
					project,
				};
			});

			expect(result._nay).toBeUndefined();
			expect(after.user?.deletedAt).toBeTypeOf("number");
			expect(after.user?.clerkUserId).toBeNull();
			expect(after.request).not.toBeNull();
			expect(after.workspace).not.toBeNull();
			expect(after.project).not.toBeNull();
			expect(after.purgeRequests).toHaveLength(0);
			expect(after.memberships.length).toBeGreaterThan(0);
			expect(after.memberships.every((m) => m.active === false)).toBe(true);
			expect(fetchSpy).toHaveBeenCalledWith(
				"https://api.clerk.com/v1/users/clerk-user-account-delete",
				expect.objectContaining({
					method: "DELETE",
				}),
			);
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("treats a Clerk 404 delete response as success and still processes the local tombstone flow", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			users_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-account-delete-404",
				displayName: "Delete Missing Clerk User",
			}),
		);

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "clerk-user-account-delete-404",
			external_id: seeded.userId,
			name: "Delete Missing Clerk User",
		});

		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(null, {
				status: 404,
				statusText: "Not Found",
			}),
		);

		try {
			const result = await asUser.action(api.users.delete_current_user_account, {});

			const after = await t.run(async (ctx) => {
				const [user, request, purgeRequests, memberships, workspace, project] = await Promise.all([
					ctx.db.get("users", seeded.userId),
					ctx.db
						.query("data_deletion_requests")
						.withIndex("by_userId", (q) => q.eq("userId", seeded.userId))
						.first(),
					ctx.db
						.query("data_deletion_requests")
						.collect()
						.then((rows) => rows.filter((r) => r.scope !== "user")),
					ctx.db
						.query("workspaces_projects_users")
						.withIndex("by_user_workspace_project_active", (q) => q.eq("userId", seeded.userId))
						.collect(),
					ctx.db.get("workspaces", seeded.defaultWorkspaceId),
					ctx.db.get("workspaces_projects", seeded.defaultProjectId),
				]);

				return {
					user,
					request,
					purgeRequests,
					memberships,
					workspace,
					project,
				};
			});

			expect(result._nay).toBeUndefined();
			expect(after.user?.deletedAt).toBeTypeOf("number");
			expect(after.user?.clerkUserId).toBeNull();
			expect(after.request).not.toBeNull();
			expect(after.workspace).not.toBeNull();
			expect(after.project).not.toBeNull();
			expect(after.purgeRequests).toHaveLength(0);
			expect(after.memberships.length).toBeGreaterThan(0);
			expect(after.memberships.every((m) => m.active === false)).toBe(true);
			expect(fetchSpy).toHaveBeenCalledWith(
				"https://api.clerk.com/v1/users/clerk-user-account-delete-404",
				expect.objectContaining({
					method: "DELETE",
				}),
			);
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("keeps the local tombstone when Clerk cleanup fails", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			users_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-user-account-delete-failure",
				displayName: "Delete Clerk Failure User",
			}),
		);

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "clerk-user-account-delete-failure",
			external_id: seeded.userId,
			name: "Delete Clerk Failure User",
		});

		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ message: "boom" }), {
				status: 500,
				headers: {
					"Content-Type": "application/json",
				},
			}),
		);

		try {
			const result = await asUser.action(api.users.delete_current_user_account, {});

			const after = await t.run(async (ctx) => {
				const [user, request, purgeRequests, memberships, workspace, project] = await Promise.all([
					ctx.db.get("users", seeded.userId),
					ctx.db
						.query("data_deletion_requests")
						.withIndex("by_userId", (q) => q.eq("userId", seeded.userId))
						.first(),
					ctx.db
						.query("data_deletion_requests")
						.collect()
						.then((rows) => rows.filter((r) => r.scope !== "user")),
					ctx.db
						.query("workspaces_projects_users")
						.withIndex("by_user_workspace_project_active", (q) => q.eq("userId", seeded.userId))
						.collect(),
					ctx.db.get("workspaces", seeded.defaultWorkspaceId),
					ctx.db.get("workspaces_projects", seeded.defaultProjectId),
				]);

				return {
					user,
					request,
					purgeRequests,
					memberships,
					workspace,
					project,
				};
			});

			expect(result._nay).toBeUndefined();
			expect(after.user?.deletedAt).toBeTypeOf("number");
			expect(after.user?.clerkUserId).toBe("clerk-user-account-delete-failure");
			expect(after.request).not.toBeNull();
			expect(after.workspace).not.toBeNull();
			expect(after.project).not.toBeNull();
			expect(after.purgeRequests).toHaveLength(0);
			expect(after.memberships.length).toBeGreaterThan(0);
			expect(after.memberships.every((m) => m.active === false)).toBe(true);
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("runs local tombstone flow for anonymous JWT and does not call Clerk delete", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			users_test_bootstrap_anonymous_user(ctx, {
				displayName: "Anonymous Delete User",
			}),
		);

		const asAnonymous = t.withIdentity({
			issuer: process.env.VITE_CONVEX_HTTP_URL!,
			subject: seeded.userId,
			name: "Anonymous Delete User",
		});

		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(null, {
				status: 200,
			}),
		);

		try {
			const result = await asAnonymous.action(api.users.delete_current_user_account, {});

			const after = await t.run(async (ctx) => {
				const [user, request, purgeRequests, memberships, workspace, project] = await Promise.all([
					ctx.db.get("users", seeded.userId),
					ctx.db
						.query("data_deletion_requests")
						.withIndex("by_userId", (q) => q.eq("userId", seeded.userId))
						.first(),
					ctx.db
						.query("data_deletion_requests")
						.collect()
						.then((rows) => rows.filter((r) => r.scope !== "user")),
					ctx.db
						.query("workspaces_projects_users")
						.withIndex("by_user_workspace_project_active", (q) => q.eq("userId", seeded.userId))
						.collect(),
					ctx.db.get("workspaces", seeded.defaultWorkspaceId),
					ctx.db.get("workspaces_projects", seeded.defaultProjectId),
				]);

				return {
					user,
					request,
					purgeRequests,
					memberships,
					workspace,
					project,
				};
			});

			expect(result._nay).toBeUndefined();
			expect(after.user?.deletedAt).toBeTypeOf("number");
			expect(after.user?.clerkUserId).toBeNull();
			expect(after.request).not.toBeNull();
			expect(after.workspace).not.toBeNull();
			expect(after.project).not.toBeNull();
			expect(after.purgeRequests).toHaveLength(0);
			expect(after.memberships.length).toBeGreaterThan(0);
			expect(after.memberships.every((m) => m.active === false)).toBe(true);
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			fetchSpy.mockRestore();
		}
	});
});
