import { v } from "convex/values";
import { doc } from "convex-helpers/validators";
import { internalMutation, mutation, query } from "./_generated/server.js";
import app_convex_schema from "./schema.ts";
import { server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";
import { convex_error, v_result } from "../server/convex-utils.ts";
import { Result } from "common/errors-as-values-utils.ts";

// Make Convex reuse the loaded module between calls, so warm calls skip the module load cost.
// Does NOT work for http actions (see http.ts). No mutable module-level state allowed here.
export const experimental_reuseContext = true;

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

		// Return the newest notifications first; archived ones (archivedAt > 0) are skipped by the index.
		return await ctx.db
			.query("notifications")
			.withIndex("by_user_archivedAt", (q) => q.eq("userId", userAuth.id).eq("archivedAt", 0))
			.order("desc")
			.take(NOTIFICATIONS_MAX_PER_USER);
	},
});

export const archive_notification = mutation({
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

		if (notification.archivedAt === 0) {
			const now = Date.now();
			await ctx.db.patch("notifications", notification._id, {
				archivedAt: now,
				updatedAt: now,
			});
		}

		return Result({ _yay: null });
	},
});

export const archive_all_notifications = mutation({
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

		const active = await ctx.db
			.query("notifications")
			.withIndex("by_user_archivedAt", (q) => q.eq("userId", userAuth.id).eq("archivedAt", 0))
			.collect();
		const now = Date.now();

		await Promise.all(
			active.map((notification) =>
				ctx.db.patch("notifications", notification._id, {
					archivedAt: now,
					updatedAt: now,
				}),
			),
		);

		return Result({ _yay: { count: active.length } });
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

		// Keep notification storage bounded so the public list query can remain a
		// simple capped lookup instead of a paginated UI-specific flow.
		const deletedCounts = await Promise.all(
			users.map(async (user) => {
				// Convex orders equal-index rows by `_creationTime`, so descending keeps the newest rows first.
				const notifications = await ctx.db
					.query("notifications")
					.withIndex("by_user", (q) => q.eq("userId", user._id))
					.order("desc")
					.collect();
				const notificationsToDelete = notifications.slice(NOTIFICATIONS_MAX_PER_USER);

				await Promise.all(
					notificationsToDelete.map((notification) => ctx.db.delete("notifications", notification._id)),
				);

				return notificationsToDelete.length;
			}),
		);

		return {
			deletedCount: deletedCounts.reduce((sum, count) => sum + count, 0),
			userCount: users.length,
		};
	},
});
