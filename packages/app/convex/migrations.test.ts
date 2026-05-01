import { describe, expect, test } from "vitest";
import { runToCompletion } from "@convex-dev/migrations";
import component from "@convex-dev/migrations/test";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { convexTest } from "convex-test";
import { components, internal } from "./_generated/api.js";

const migrations_test_modules = import.meta.glob("./**/*.ts");

const migrations_test_schema = defineSchema({
	users: defineTable({
		clerkUserId: v.union(v.string(), v.null()),
	}).index("by_clerkUser", ["clerkUserId"]),
	workspaces: defineTable({
		name: v.string(),
		description: v.string(),
		default: v.boolean(),
		defaultProjectId: v.optional(v.id("workspaces_projects")),
		updatedAt: v.number(),
	}),
	workspaces_projects: defineTable({
		workspaceId: v.id("workspaces"),
		name: v.string(),
		description: v.string(),
		default: v.boolean(),
		updatedAt: v.number(),
	}),
	notifications: defineTable({
		userId: v.id("users"),
		kind: v.literal("workspace_project_invite"),
		read: v.boolean(),
		actorUserId: v.id("users"),
		workspaceId: v.id("workspaces"),
		projectId: v.id("workspaces_projects"),
		createdAt: v.optional(v.number()),
		updatedAt: v.number(),
	})
		.index("by_user_read", ["userId", "read"])
		.index("by_workspace_user_read", ["workspaceId", "userId", "read"])
		.index("by_workspace_project_user", ["workspaceId", "projectId", "userId"]),
});

describe("remove_notifications_created_at", () => {
	test("removes legacy createdAt from notification rows", async () => {
		const t = convexTest(migrations_test_schema, migrations_test_modules);
		component.register(t);
		const legacy = await t.run(async (ctx) => {
			const [userId, actorUserId] = await Promise.all([
				ctx.db.insert("users", { clerkUserId: "clerk-user-legacy-notification-created-at" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-legacy-notification-created-at-actor" }),
			]);
			const workspaceId = await ctx.db.insert("workspaces", {
				name: "legacy-notification-created-at-workspace",
				description: "",
				default: false,
				updatedAt: 100,
			});
			const projectId = await ctx.db.insert("workspaces_projects", {
				workspaceId,
				name: "home",
				description: "",
				default: true,
				updatedAt: 100,
			});
			const notificationId = await ctx.db.insert("notifications", {
				userId,
				kind: "workspace_project_invite",
				read: false,
				actorUserId,
				workspaceId,
				projectId,
				createdAt: 100,
				updatedAt: 100,
			});

			return { notificationId, userId, actorUserId, workspaceId, projectId };
		});

		const notification = await t.run(async (ctx) => {
			await runToCompletion(ctx, components.migrations, internal.migrations.remove_notifications_created_at);

			return await ctx.db.get("notifications", legacy.notificationId);
		});

		expect(notification).toMatchObject({
			userId: legacy.userId,
			kind: "workspace_project_invite",
			read: false,
			actorUserId: legacy.actorUserId,
			workspaceId: legacy.workspaceId,
			projectId: legacy.projectId,
			updatedAt: 100,
		});
		expect(notification).not.toHaveProperty("createdAt");
	});
});
