import { mutation, query, internalMutation } from "./_generated/server";
import { components, internal } from "./_generated/api";
import { v } from "convex/values";
import { Presence } from "@convex-dev/presence";
import { server_convex_get_user_fallback_to_anonymous } from "../server/server-utils";
import { app_presence_GLOBAL_ROOM_ID } from "../shared/shared-presence-constants";

export const presence = new Presence(components.presence);

export const heartbeat = mutation({
	args: { roomId: v.string(), userId: v.string(), sessionId: v.string(), interval: v.number() },
	handler: async (ctx, args) => {
		const effective = await server_convex_get_user_fallback_to_anonymous(ctx);

		// Cancel any scheduled pending-edits cleanup for this user on heartbeat
		const scheduled = await ctx.db
			.query("ai_chat_pending_edits_cleanup_tasks")
			.withIndex("by_user_id", (q) => q.eq("user_id", effective.id))
			.collect();
		for (const task of scheduled) {
			await ctx.scheduler.cancel(task.scheduled_function_id);
			await ctx.db.delete(task._id);
		}

		return await presence.heartbeat(ctx, app_presence_GLOBAL_ROOM_ID, effective.id, args.sessionId, args.interval);
	},
});

export const list = query({
	args: { roomToken: v.string() },
	handler: async (ctx, args) => {
		return await presence.list(ctx, args.roomToken);
	},
});

export const disconnect = mutation({
	args: { sessionToken: v.string() },
	handler: async (ctx, args) => {
		// Let presence handle the disconnect first
		const result = await presence.disconnect(ctx, args.sessionToken);

		// Schedule pending edits cleanup in 10s for the current user
		const effective = await server_convex_get_user_fallback_to_anonymous(ctx);
		const userId = effective.id;
		const existing = await ctx.db
			.query("ai_chat_pending_edits_cleanup_tasks")
			.withIndex("by_user_id", (q) => q.eq("user_id", userId))
			.collect();
		for (const task of existing) {
			await ctx.scheduler.cancel(task.scheduled_function_id);
			await ctx.db.delete(task._id);
		}

		console.log("disconnect", userId);

		const scheduledId = await ctx.scheduler.runAfter(10_000, internal.presence.remove_pending_edits_if_offline, {
			userId,
		});

		await ctx.db.insert("ai_chat_pending_edits_cleanup_tasks", {
			user_id: userId,
			scheduled_function_id: scheduledId,
			created_at: Date.now(),
		});

		return result;
	},
});

export const remove_pending_edits_if_offline = internalMutation({
	args: { userId: v.string() },
	handler: async (ctx, { userId }) => {
		// Query presence: list rooms for this user, onlineOnly=true
		const rooms = await presence.listUser(ctx, userId, true);
		const isOnline = rooms.length > 0;

		// Clear any scheduled record(s) for this user
		const records = await ctx.db
			.query("ai_chat_pending_edits_cleanup_tasks")
			.withIndex("by_user_id", (q) => q.eq("user_id", userId))
			.collect();
		for (const rec of records) {
			await ctx.db.delete(rec._id);
		}

		console.log("remove_pending_edits_if_offline", { userId, isOnline });

		if (isOnline) return;

		// Remove pending edits for this user
		const pending = await ctx.db
			.query("ai_chat_pending_edits")
			.withIndex("by_user_thread_page", (q) => q.eq("user_id", userId))
			.collect();
		for (const doc of pending) {
			await ctx.db.delete(doc._id);
		}
	},
});
