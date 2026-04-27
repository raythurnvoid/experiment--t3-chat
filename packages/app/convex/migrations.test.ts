import { describe, expect, test } from "vitest";
import { runToCompletion } from "@convex-dev/migrations";
import component from "@convex-dev/migrations/test";
import { components, internal } from "./_generated/api.js";
import { test_convex } from "./setup.test.ts";

describe("move_user_notifications_to_notifications", () => {
	test("moves legacy rows to notifications and deletes the legacy rows", async () => {
		const t = test_convex();
		component.register(t);
		const legacy = await t.run(async (ctx) => {
			const [userId, actorUserId] = await Promise.all([
				ctx.db.insert("users", { clerkUserId: "clerk-user-legacy-notifications" }),
				ctx.db.insert("users", { clerkUserId: "clerk-user-legacy-notifications-actor" }),
			]);
			const workspaceId = await ctx.db.insert("workspaces", {
				name: "legacy-notifications-workspace",
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
			const notificationId = await ctx.db.insert("user_notifications", {
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

		const rows = await t.run(async (ctx) => {
			await runToCompletion(ctx, components.migrations, internal.migrations.move_user_notifications_to_notifications);

			const [legacyNotifications, notifications] = await Promise.all([
				ctx.db.query("user_notifications").collect(),
				ctx.db
					.query("notifications")
					.withIndex("by_user_createdAt", (q) => q.eq("userId", legacy.userId))
					.collect(),
			]);

			return { legacyNotifications, notifications };
		});

		expect(rows.legacyNotifications).toHaveLength(0);
		expect(rows.notifications).toMatchObject([
			{
				userId: legacy.userId,
				kind: "workspace_project_invite",
				read: false,
				actorUserId: legacy.actorUserId,
				workspaceId: legacy.workspaceId,
				projectId: legacy.projectId,
				createdAt: 100,
				updatedAt: 100,
			},
		]);
		expect(rows.notifications[0]?._id).not.toBe(legacy.notificationId);
	});
});
