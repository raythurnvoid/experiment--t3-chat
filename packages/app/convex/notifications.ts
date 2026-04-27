import { v } from "convex/values";
import { doc } from "convex-helpers/validators";
import { internalMutation, mutation, query } from "./_generated/server.js";
import app_convex_schema from "./schema.ts";
import { server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";
import { convex_error, v_result } from "../server/convex-utils.ts";
import { Result } from "../shared/errors-as-values-utils.ts";

/**
 * A user can only have up to 500 notifications, older will be deleted.
 */
const NOTIFICATIONS_MAX_PER_USER = 500;

export const list_current_notifications = query({
	args: {},
	returns: v.array(doc(app_convex_schema, "notifications")),
	handler: async (ctx) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			throw convex_error({ message: "Unauthenticated" });
		}

		// Keep this query as simple domain rows. The UI composes workspace, project,
		// and actor data through reusable queries that can share cache entries.
		return await ctx.db
			.query("notifications")
			.withIndex("by_user_createdAt", (q) => q.eq("userId", userAuth.id))
			.order("desc")
			.take(NOTIFICATIONS_MAX_PER_USER);
	},
});

export const mark_notification_read = mutation({
	args: {
		notificationId: v.id("notifications"),
	},
	returns: v_result({
		_yay: v.null(),
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const notification = await ctx.db.get("notifications", args.notificationId);
		if (!notification || notification.userId !== userAuth.id) {
			return Result({ _nay: { message: "Notification not found" } });
		}

		if (!notification.read) {
			await ctx.db.patch("notifications", notification._id, {
				read: true,
				updatedAt: Date.now(),
			});
		}

		return Result({ _yay: null });
	},
});

export const mark_all_notifications_read = mutation({
	args: {},
	returns: v_result({
		_yay: v.object({
			count: v.number(),
		}),
	}),
	handler: async (ctx) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const unread = await ctx.db
			.query("notifications")
			.withIndex("by_user_read_createdAt", (q) => q.eq("userId", userAuth.id).eq("read", false))
			.collect();
		const now = Date.now();

		await Promise.all(
			unread.map((notification) =>
				ctx.db.patch("notifications", notification._id, {
					read: true,
					updatedAt: now,
				}),
			),
		);

		return Result({ _yay: { count: unread.length } });
	},
});

export const cleanup_extra_notifications = internalMutation({
	args: {},
	returns: v.object({
		deletedCount: v.number(),
		userCount: v.number(),
	}),
	handler: async (ctx) => {
		const users = await ctx.db.query("users").collect();
		let deletedCount = 0;

		// Keep notification storage bounded so the public list query can remain a
		// simple capped lookup instead of a paginated UI-specific flow.
		for (const user of users) {
			const notifications = await ctx.db
				.query("notifications")
				.withIndex("by_user_createdAt", (q) => q.eq("userId", user._id))
				.order("desc")
				.collect();
			const notificationsToDelete = notifications.slice(NOTIFICATIONS_MAX_PER_USER);
			deletedCount += notificationsToDelete.length;

			await Promise.all(
				notificationsToDelete.map((notification) => ctx.db.delete("notifications", notification._id)),
			);
		}

		return { deletedCount, userCount: users.length };
	},
});
