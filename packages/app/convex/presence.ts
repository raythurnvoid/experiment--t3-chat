import { mutation, query, internalMutation } from "./_generated/server.js";
import { components, internal } from "./_generated/api.js";
import { v } from "convex/values";
import { Presence } from "@convex-dev/presence";
import { server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.js";
import { ai_chat_HARDCODED_ORG_ID, ai_chat_HARDCODED_PROJECT_ID, should_never_happen } from "../shared/shared-utils.ts";
import app_convex_schema from "./schema.ts";
import { doc } from "convex-helpers/validators";
import type { Doc, Id } from "./_generated/dataModel.js";

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

		// If the user reconnects before cleanup runs (for example after a quick refresh),
		// cancel the scheduled pending-edits cleanup so they do not lose unsaved work.
		const scheduled = await ctx.db
			.query("ai_chat_pending_edits_cleanup_tasks")
			.withIndex("by_userId", (q) => q.eq("userId", user.id))
			.collect();
		for (const task of scheduled) {
			await ctx.scheduler.cancel(task.scheduledFunctionId);
			await ctx.db.delete("ai_chat_pending_edits_cleanup_tasks", task._id);
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
			]);
		}

		return result;
	},
});

export const list = query({
	args: { roomToken: v.string() },
	returns: v.object({
		users: v.array(
			v.object({
				userId: v.id("users"),
				online: v.boolean(),
				lastDisconnected: v.number(),
				anagraphic: doc(app_convex_schema, "users_anagraphics"),
			}),
		),
		usersAnagraphics: v.record(v.string(), doc(app_convex_schema, "users_anagraphics")),
	}),
	handler: async (ctx, args) => {
		const list = await presence.list(ctx, args.roomToken);
		const users: Array<{
			userId: Id<"users">;
			online: boolean;
			lastDisconnected: number;
			anagraphic: Doc<"users_anagraphics">;
		}> = [];
		const usersAnagraphics: Record<string, Doc<"users_anagraphics">> = {};

		const usersWithAnagraphics = await Promise.all(
			list.map(async (user) => {
				const userId = ctx.db.normalizeId("users", user.userId);
				if (!userId) {
					should_never_happen("[presence.list] invalid userId", { userId: user.userId });
					return null;
				}

				const userDoc = await ctx.db.get("users", userId);
				if (!userDoc || !userDoc.anagraphic) {
					console.error(should_never_happen("[presence.list] missing user or anagraphic id", { userId }));
					return null;
				}

				const anagraphic = await ctx.db.get("users_anagraphics", userDoc.anagraphic);

				if (!anagraphic) {
					console.error(should_never_happen("[presence.list] missing anagraphic", { userId }));
					return null;
				}

				return {
					userId,
					online: user.online,
					lastDisconnected: user.lastDisconnected,
					anagraphic,
				};
			}),
		);

		for (const user of usersWithAnagraphics) {
			if (!user) continue;
			users.push(user);
			usersAnagraphics[user.userId] = user.anagraphic;
		}

		return {
			users,
			usersAnagraphics,
		};
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

export const getSessionsData = query({
	args: { roomToken: v.string() },
	returns: v.record(v.string(), v.any()),
	handler: async (ctx, args) => {
		return await presence.getSessionsData(ctx, args.roomToken);
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
	returns: v.object({
		users: v.array(
			v.object({
				userId: v.string(),
				online: v.boolean(),
				lastDisconnected: v.number(),
				anagraphic: doc(app_convex_schema, "users_anagraphics"),
			}),
		),
		usersAnagraphics: v.record(v.string(), doc(app_convex_schema, "users_anagraphics")),
	}),
	handler: async (ctx, args) => {
		const list = await presence.listRoom(ctx, args.roomId, args.onlineOnly ?? false, args.limit ?? 104);
		const users: Array<{
			userId: string;
			online: boolean;
			lastDisconnected: number;
			anagraphic: Doc<"users_anagraphics">;
		}> = [];
		const usersAnagraphics: Record<string, Doc<"users_anagraphics">> = {};

		const usersWithAnagraphics = await Promise.all(
			list.map(async (user) => {
				const userId = ctx.db.normalizeId("users", user.userId);
				if (!userId) {
					console.error(should_never_happen("[presence.listRoom] invalid userId", { userId: user.userId }));
					return null;
				}

				const userDoc = await ctx.db.get("users", userId);
				if (!userDoc || !userDoc.anagraphic) {
					should_never_happen("[presence.listRoom] missing user or anagraphic id", { userId });
					return null;
				}

				const anagraphic = await ctx.db.get("users_anagraphics", userDoc.anagraphic);
				if (!anagraphic) {
					should_never_happen("[presence.listRoom] missing anagraphic", { userId });
					return null;
				}

				return {
					userId: user.userId,
					online: user.online,
					lastDisconnected: user.lastDisconnected,
					anagraphic,
				};
			}),
		);

		for (const user of usersWithAnagraphics) {
			if (!user) continue;
			users.push(user);
			usersAnagraphics[user.userId] = user.anagraphic;
		}

		return {
			users,
			usersAnagraphics,
		};
	},
});

export const disconnect = mutation({
	args: { sessionToken: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		// Let presence handle the disconnect first
		const result = await presence.disconnect(ctx, args.sessionToken);

		// Delete pending edits when a user disconnects so stale pending overlays do not linger forever.
		// Keep a grace window so quick reconnects (for example page refresh) can cancel this cleanup.
		const effective = await server_convex_get_user_fallback_to_anonymous(ctx);
		const userId = effective.id;
		const existing = await ctx.db
			.query("ai_chat_pending_edits_cleanup_tasks")
			.withIndex("by_userId", (q) => q.eq("userId", userId))
			.collect();
		for (const task of existing) {
			await ctx.scheduler.cancel(task.scheduledFunctionId);
			await ctx.db.delete("ai_chat_pending_edits_cleanup_tasks", task._id);
		}

		console.info("disconnect", userId);

		const scheduledId = await ctx.scheduler.runAfter(30_000, internal.presence.remove_pending_edits_if_offline, {
			userId,
		});

		await ctx.db.insert("ai_chat_pending_edits_cleanup_tasks", {
			userId: userId,
			scheduledFunctionId: scheduledId,
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
			.withIndex("by_userId", (q) => q.eq("userId", userId))
			.collect();
		for (const rec of records) {
			await ctx.db.delete("ai_chat_pending_edits_cleanup_tasks", rec._id);
		}

		console.info("remove_pending_edits_if_offline", { userId, isOnline });

		if (isOnline) return;

		// User remained offline after the grace window, so clear pending edits.
		const pending = await ctx.db
			.query("ai_chat_pending_edits")
			.withIndex("by_workspace_project_user_page", (q) =>
				q
					.eq("workspaceId", ai_chat_HARDCODED_ORG_ID)
					.eq("projectId", ai_chat_HARDCODED_PROJECT_ID)
					.eq("userId", userId),
			)
			.collect();
		for (const doc of pending) {
			await ctx.db.delete("ai_chat_pending_edits", doc._id);
		}
	},
});
