import { mutation, query, internalMutation } from "./_generated/server.js";
import { components, internal } from "./_generated/api.js";
import { v } from "convex/values";
import { Presence } from "@convex-dev/presence";
import { server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.js";

export const presence = new Presence(components.presence);

export const heartbeat = mutation({
	args: { roomId: v.string(), userId: v.string(), sessionId: v.string(), interval: v.number() },
	returns: v.object({
		roomToken: v.string(),
		sessionToken: v.string(),
		isNewSession: v.boolean(),
	}),
	handler: async (ctx, args) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);

		// Cancel any scheduled pending-edits cleanup for this user on heartbeat
		const scheduled = await ctx.db
			.query("ai_chat_pending_edits_cleanup_tasks")
			.withIndex("by_user_id", (q) => q.eq("user_id", user.id))
			.collect();
		for (const task of scheduled) {
			await ctx.scheduler.cancel(task.scheduled_function_id);
			await ctx.db.delete(task._id);
		}

		const result = await presence.heartbeat(ctx, args.roomId, user.id, args.sessionId, args.interval);

		if (result.isNewSession) {
			await Promise.all([
				ctx.runMutation(components.presence.public.setSessionData, {
					sessionToken: result.sessionToken,
					data: {
						color: "#" + Math.floor(Math.random() * 16777215).toString(16),
					},
				}),
				ctx.runMutation(components.presence.public.setUserData, {
					userId: user.id,
					roomToken: result.roomToken,
					data: {
						name: user.name,
						image: user.avatar,
					},
				}),
			]);
		}

		return result;
	},
});

export const list = query({
	args: { roomToken: v.string() },
	returns: v.array(
		v.object({
			userId: v.string(),
			online: v.boolean(),
			lastDisconnected: v.number(),
		}),
	),
	handler: async (ctx, args) => {
		const list = await presence.list(ctx, args.roomToken);

		return list.map((user) => ({
			userId: user.userId,
			online: user.online,
			lastDisconnected: user.lastDisconnected,
		}));
	},
});

export const listSessions = query({
	args: { roomToken: v.string(), limit: v.optional(v.number()) },
	returns: v.array(
		v.object({
			sessionId: v.string(),
			userId: v.string(),
		}),
	),
	handler: async (ctx, args) => {
		return await presence.listSessions(ctx, args.roomToken, args.limit ?? 104);
	},
});

export const getUserData = query({
	args: { roomToken: v.string() },
	returns: v.record(v.string(), v.any()),
	handler: async (ctx, args) => {
		return await presence.getUserData(ctx, args.roomToken);
	},
});

export const getSessionsData = query({
	args: { roomToken: v.string() },
	returns: v.record(v.string(), v.any()),
	handler: async (ctx, args) => {
		return await presence.getSessionsData(ctx, args.roomToken);
	},
});

export const setUserData = mutation({
	args: { roomToken: v.string(), userId: v.string(), data: v.any() },
	returns: v.null(),
	handler: async (ctx, args) => {
		return await presence.setUserData(ctx, args.roomToken, args.userId, args.data);
	},
});

export const setSessionData = mutation({
	args: { sessionToken: v.string(), data: v.any() },
	returns: v.null(),
	handler: async (ctx, args) => {
		return await ctx.runMutation(components.presence.public.setSessionData, {
			sessionToken: args.sessionToken,
			data: args.data,
		});
	},
});

export const removeUserData = mutation({
	args: { roomToken: v.string(), userId: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		return await presence.removeUserData(ctx, args.roomToken, args.userId);
	},
});

export const removeSessionData = mutation({
	args: { roomToken: v.string(), sessionId: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		return await presence.removeSessionData(ctx, args.roomToken, args.sessionId);
	},
});

export const listRoom = query({
	args: {
		roomId: v.string(),
		onlineOnly: v.optional(v.boolean()),
		limit: v.optional(v.number()),
	},
	returns: v.array(
		v.object({
			userId: v.string(),
			online: v.boolean(),
			lastDisconnected: v.number(),
		}),
	),
	handler: async (ctx, args) => {
		return await presence.listRoom(ctx, args.roomId, args.onlineOnly ?? false, args.limit ?? 104);
	},
});

export const disconnect = mutation({
	args: { sessionToken: v.string() },
	returns: v.null(),
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

		console.info("disconnect", userId);

		const scheduledId = await ctx.scheduler.runAfter(10_000, internal.presence.remove_pending_edits_if_offline, {
			userId,
		});

		await ctx.db.insert("ai_chat_pending_edits_cleanup_tasks", {
			user_id: userId,
			scheduled_function_id: scheduledId,
		});

		return result;
	},
});

export const remove_pending_edits_if_offline = internalMutation({
	args: { userId: v.string() },
	returns: v.null(),
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

		console.info("remove_pending_edits_if_offline", { userId, isOnline });

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
