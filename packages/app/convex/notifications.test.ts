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
	await ctx.db.patch("workspaces", workspaceId, { defaultProjectId: projectId });
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
		read?: boolean;
		userId: Id<"users">;
		updatedAt?: number;
	},
) {
	return await ctx.db.insert("notifications", {
		userId: args.userId,
		kind: "workspace_project_invite",
		read: args.read ?? false,
		actorUserId: args.otherUserId,
		workspaceId: args.workspaceId,
		projectId: args.projectId,
		updatedAt: args.updatedAt ?? Date.now(),
	});
}

async function notifications_test_collect_for_user(ctx: MutationCtx, args: { userId: Id<"users"> }) {
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

function notifications_test_identity(userId: Id<"users">) {
	return {
		issuer: "https://clerk.test",
		external_id: userId,
		name: "Notifications User",
		email: "notifications-user@test.local",
	};
}

describe("list_current_notifications", () => {
	test("lists only the current user's notifications in descending creation order", async () => {
		const t = test_convex();
		const target = await t.run(notifications_test_seed_target);
		const olderNotificationId = await t.run((ctx) =>
			notifications_test_insert(ctx, { ...target, userId: target.userId }),
		);
		const newerNotificationId = await t.run((ctx) =>
			notifications_test_insert(ctx, { ...target, userId: target.userId }),
		);
		await t.run((ctx) => notifications_test_insert(ctx, { ...target, userId: target.otherUserId }));
		const asUser = t.withIdentity(notifications_test_identity(target.userId));

		const notifications = await asUser.query(api.notifications.list_current_notifications, {});

		expect(notifications.map((notification) => notification._id)).toEqual([newerNotificationId, olderNotificationId]);
	});

	test("caps newest current-user notification rows without checking memberships", async () => {
		const t = test_convex();
		const target = await t.run(notifications_test_seed_target);
		const oldestNotificationId = await t.run((ctx) =>
			notifications_test_insert(ctx, { ...target, userId: target.userId }),
		);
		await t.run(async (ctx) => {
			const now = Date.now();
			const workspaceWithoutMembershipId = await ctx.db.insert("workspaces", {
				name: "notifications-workspace-without-membership",
				description: "",
				default: false,
				billingMode: "user",
				ownerUserId: target.otherUserId,
				updatedAt: now,
			});
			const projectWithoutMembershipId = await ctx.db.insert("workspaces_projects", {
				workspaceId: workspaceWithoutMembershipId,
				name: "home",
				description: "",
				default: true,
				updatedAt: now,
			});

			for (let index = 0; index < 502; index++) {
				await notifications_test_insert(ctx, {
					...target,
					workspaceId: workspaceWithoutMembershipId,
					projectId: projectWithoutMembershipId,
					userId: target.userId,
				});
			}
		});
		const asUser = t.withIdentity(notifications_test_identity(target.userId));

		const notifications = await asUser.query(api.notifications.list_current_notifications, {});

		expect(notifications).toHaveLength(500);
		expect(notifications.some((notification) => notification._id === oldestNotificationId)).toBe(false);
	});

	test("keeps notifications visible when the invited project is gone but the workspace remains accessible", async () => {
		const t = test_convex();
		const target = await t.run(notifications_test_seed_target);
		const notificationId = await t.run(async (ctx) => {
			const extraProjectId = await ctx.db.insert("workspaces_projects", {
				workspaceId: target.workspaceId,
				name: "roadmap",
				description: "",
				default: false,
				updatedAt: Date.now(),
			});
			const notificationId = await notifications_test_insert(ctx, {
				...target,
				projectId: extraProjectId,
				userId: target.userId,
			});
			await ctx.db.delete(extraProjectId);

			return notificationId;
		});
		const asUser = t.withIdentity(notifications_test_identity(target.userId));

		const notifications = await asUser.query(api.notifications.list_current_notifications, {});

		expect(notifications.map((notification) => notification._id)).toEqual([notificationId]);
	});

	test("lists notification rows even when the user no longer has workspace membership", async () => {
		const t = test_convex();
		const target = await t.run(notifications_test_seed_target);
		const notificationId = await t.run(async (ctx) => {
			const notificationId = await notifications_test_insert(ctx, { ...target, userId: target.userId });
			const memberships = await ctx.db
				.query("workspaces_projects_users")
				.withIndex("by_active_user_workspace_project", (q) =>
					q.eq("active", true).eq("userId", target.userId).eq("workspaceId", target.workspaceId),
				)
				.collect();
			await Promise.all(memberships.map((membership) => ctx.db.delete(membership._id)));

			return notificationId;
		});
		const asUser = t.withIdentity(notifications_test_identity(target.userId));

		const notifications = await asUser.query(api.notifications.list_current_notifications, {});

		expect(notifications.map((notification) => notification._id)).toEqual([notificationId]);
	});
});

describe("mark_notification_read", () => {
	test("marks one notification read only for the owner", async () => {
		const t = test_convex();
		const target = await t.run(notifications_test_seed_target);
		const [ownNotificationId, otherNotificationId] = await t.run(async (ctx) =>
			Promise.all([
				notifications_test_insert(ctx, { ...target, userId: target.userId }),
				notifications_test_insert(ctx, { ...target, userId: target.otherUserId }),
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
				notifications_test_insert(ctx, { ...target, userId: target.userId }),
				notifications_test_insert(ctx, { ...target, userId: target.userId }),
				notifications_test_insert(ctx, { ...target, userId: target.userId, read: true }),
				notifications_test_insert(ctx, { ...target, userId: target.otherUserId }),
			]),
		);
		const asUser = t.withIdentity(notifications_test_identity(target.userId));

		const result = await asUser.mutation(api.notifications.mark_all_notifications_read, {});

		expect(result._yay?.count).toBe(2);
		const rows = await t.run(async (ctx) => {
			const [userNotifications, otherNotifications] = await Promise.all([
				notifications_test_collect_for_user(ctx, { userId: target.userId }),
				notifications_test_collect_for_user(ctx, { userId: target.otherUserId }),
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
		const deletedNotificationIds = await t.run(async (ctx) => {
			const userNotificationIds: Array<Id<"notifications">> = [];
			for (let index = 0; index < 502; index++) {
				userNotificationIds.push(await notifications_test_insert(ctx, { ...target, userId: target.userId }));
			}
			await notifications_test_insert(ctx, { ...target, userId: target.otherUserId });

			return userNotificationIds.slice(0, 2);
		});

		const result = await t.mutation(internal.notifications.cleanup_extra_notifications, {});

		expect(result.deletedCount).toBe(2);
		const rows = await t.run(async (ctx) => {
			const [userNotifications, otherNotifications, deletedNotifications] = await Promise.all([
				notifications_test_collect_for_user(ctx, { userId: target.userId }),
				notifications_test_collect_for_user(ctx, { userId: target.otherUserId }),
				Promise.all(deletedNotificationIds.map((notificationId) => ctx.db.get("notifications", notificationId))),
			]);

			return { userNotifications, otherNotifications, deletedNotifications };
		});
		expect(rows.userNotifications).toHaveLength(500);
		expect(rows.deletedNotifications).toEqual([null, null]);
		expect(rows.otherNotifications).toHaveLength(1);
	});
});
