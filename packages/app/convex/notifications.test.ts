import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { test_convex } from "./setup.test.ts";

type NotificationsTestTarget = {
	userId: Id<"users">;
	otherUserId: Id<"users">;
	workspaceId: Id<"workspaces">;
	projectId: Id<"workspaces_projects">;
};

async function notifications_test_seed_target(ctx: MutationCtx) {
	const [userId, otherUserId] = await Promise.all([
		ctx.db.insert("users", { clerkUserId: "clerk-user-notifications" }),
		ctx.db.insert("users", { clerkUserId: "clerk-user-notifications-other" }),
	]);
	const now = Date.now();
	const workspaceId = await ctx.db.insert("workspaces", {
		name: "notifications-workspace",
		description: "",
		default: false,
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

	return { userId, otherUserId, workspaceId, projectId };
}

async function notifications_test_insert(
	ctx: MutationCtx,
	args: NotificationsTestTarget & {
		createdAt: number;
		read?: boolean;
		userId: Id<"users">;
	},
) {
	return await ctx.db.insert("notifications", {
		userId: args.userId,
		kind: "workspace_project_invite",
		read: args.read ?? false,
		actorUserId: args.otherUserId,
		workspaceId: args.workspaceId,
		projectId: args.projectId,
		createdAt: args.createdAt,
		updatedAt: args.createdAt,
	});
}

function notifications_test_identity(userId: Id<"users">) {
	return {
		issuer: "https://clerk.test",
		external_id: userId,
		name: "Notifications User",
		email: "notifications-user@test.local",
	};
}

describe("list_current_notifications", () => {
	test("lists only the current user's notifications in descending createdAt order", async () => {
		const t = test_convex();
		const target = await t.run(notifications_test_seed_target);
		const [olderNotificationId, newerNotificationId] = await t.run(async (ctx) =>
			Promise.all([
				notifications_test_insert(ctx, { ...target, userId: target.userId, createdAt: 100 }),
				notifications_test_insert(ctx, { ...target, userId: target.userId, createdAt: 200 }),
				notifications_test_insert(ctx, { ...target, userId: target.otherUserId, createdAt: 300 }),
			]),
		);
		const asUser = t.withIdentity(notifications_test_identity(target.userId));

		const notifications = await asUser.query(api.notifications.list_current_notifications, {});

		expect(notifications.map((notification) => notification._id)).toEqual([newerNotificationId, olderNotificationId]);
	});

	test("excludes notifications when the target project was deleted", async () => {
		const t = test_convex();
		const target = await t.run(notifications_test_seed_target);
		await t.run(async (ctx) => {
			await notifications_test_insert(ctx, { ...target, userId: target.userId, createdAt: 100 });
			await ctx.db.delete(target.projectId);
		});
		const asUser = t.withIdentity(notifications_test_identity(target.userId));

		const notifications = await asUser.query(api.notifications.list_current_notifications, {});

		expect(notifications).toHaveLength(0);
	});

	test("excludes notifications when the target workspace was deleted", async () => {
		const t = test_convex();
		const target = await t.run(notifications_test_seed_target);
		await t.run(async (ctx) => {
			await notifications_test_insert(ctx, { ...target, userId: target.userId, createdAt: 100 });
			await ctx.db.delete(target.workspaceId);
		});
		const asUser = t.withIdentity(notifications_test_identity(target.userId));

		const notifications = await asUser.query(api.notifications.list_current_notifications, {});

		expect(notifications).toHaveLength(0);
	});

	test("excludes notifications when the user no longer has target project membership", async () => {
		const t = test_convex();
		const target = await t.run(notifications_test_seed_target);
		await t.run(async (ctx) => {
			await notifications_test_insert(ctx, { ...target, userId: target.userId, createdAt: 100 });
			const memberships = await ctx.db
				.query("workspaces_projects_users")
				.withIndex("by_active_user_workspace_project", (q) =>
					q
						.eq("active", true)
						.eq("userId", target.userId)
						.eq("workspaceId", target.workspaceId)
						.eq("projectId", target.projectId),
				)
				.collect();
			await Promise.all(memberships.map((membership) => ctx.db.delete(membership._id)));
		});
		const asUser = t.withIdentity(notifications_test_identity(target.userId));

		const notifications = await asUser.query(api.notifications.list_current_notifications, {});

		expect(notifications).toHaveLength(0);
	});
});

describe("mark_notification_read", () => {
	test("marks one notification read only for the owner", async () => {
		const t = test_convex();
		const target = await t.run(notifications_test_seed_target);
		const [ownNotificationId, otherNotificationId] = await t.run(async (ctx) =>
			Promise.all([
				notifications_test_insert(ctx, { ...target, userId: target.userId, createdAt: 100 }),
				notifications_test_insert(ctx, { ...target, userId: target.otherUserId, createdAt: 200 }),
			]),
		);
		const asUser = t.withIdentity(notifications_test_identity(target.userId));

		const ownResult = await asUser.mutation(api.notifications.mark_notification_read, {
			notificationId: ownNotificationId,
		});
		const otherResult = await asUser.mutation(api.notifications.mark_notification_read, {
			notificationId: otherNotificationId,
		});

		expect(ownResult._yay).toBeNull();
		expect(otherResult._nay?.message).toBe("Notification not found");
		const rows = await t.run((ctx) =>
			Promise.all([
				ctx.db.get("notifications", ownNotificationId),
				ctx.db.get("notifications", otherNotificationId),
			]),
		);
		expect(rows[0]?.read).toBe(true);
		expect(rows[1]?.read).toBe(false);
	});
});

describe("mark_all_notifications_read", () => {
	test("marks all unread current-user notifications read", async () => {
		const t = test_convex();
		const target = await t.run(notifications_test_seed_target);
		await t.run(async (ctx) =>
			Promise.all([
				notifications_test_insert(ctx, { ...target, userId: target.userId, createdAt: 100 }),
				notifications_test_insert(ctx, { ...target, userId: target.userId, createdAt: 200 }),
				notifications_test_insert(ctx, { ...target, userId: target.userId, createdAt: 300, read: true }),
				notifications_test_insert(ctx, { ...target, userId: target.otherUserId, createdAt: 400 }),
			]),
		);
		const asUser = t.withIdentity(notifications_test_identity(target.userId));

		const result = await asUser.mutation(api.notifications.mark_all_notifications_read, {});

		expect(result._yay?.count).toBe(2);
		const rows = await t.run(async (ctx) => {
			const [userNotifications, otherNotifications] = await Promise.all([
				ctx.db
					.query("notifications")
					.withIndex("by_user_createdAt", (q) => q.eq("userId", target.userId))
					.collect(),
				ctx.db
					.query("notifications")
					.withIndex("by_user_createdAt", (q) => q.eq("userId", target.otherUserId))
					.collect(),
			]);

			return { userNotifications, otherNotifications };
		});
		expect(rows.userNotifications.every((notification) => notification.read)).toBe(true);
		expect(rows.otherNotifications[0]?.read).toBe(false);
	});
});

describe("cleanup_extra_notifications", () => {
	test("deletes only rows beyond the per-user cap", async () => {
		const t = test_convex();
		const target = await t.run(notifications_test_seed_target);
		await t.run(async (ctx) => {
			await Promise.all([
				...Array.from({ length: 502 }, (_, createdAt) =>
					notifications_test_insert(ctx, { ...target, userId: target.userId, createdAt }),
				),
				notifications_test_insert(ctx, { ...target, userId: target.otherUserId, createdAt: 0 }),
			]);
		});

		const result = await t.mutation(internal.notifications.cleanup_extra_notifications, {});

		expect(result.deletedCount).toBe(2);
		const rows = await t.run(async (ctx) => {
			const [userNotifications, otherNotifications] = await Promise.all([
				ctx.db
					.query("notifications")
					.withIndex("by_user_createdAt", (q) => q.eq("userId", target.userId))
					.collect(),
				ctx.db
					.query("notifications")
					.withIndex("by_user_createdAt", (q) => q.eq("userId", target.otherUserId))
					.collect(),
			]);

			return { userNotifications, otherNotifications };
		});
		expect(rows.userNotifications).toHaveLength(500);
		expect(rows.userNotifications[0]?.createdAt).toBe(2);
		expect(rows.otherNotifications).toHaveLength(1);
	});
});
