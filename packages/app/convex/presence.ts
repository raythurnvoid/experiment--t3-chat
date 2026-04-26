import { mutation, query } from "./_generated/server.js";
import { components } from "./_generated/api.js";
import { v } from "convex/values";
import { Presence } from "@convex-dev/presence";
import { convex_error } from "../server/convex-utils.ts";
import { pages_db_reschedule_pending_edit_cleanup_for_user } from "../server/pages.ts";
import { server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.js";
import app_convex_schema from "./schema.ts";
import { doc } from "convex-helpers/validators";
import type { Doc, Id } from "./_generated/dataModel.js";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";

export const presence = new Presence(components.presence);

function presence_rate_limit_error(rateLimit: { message: string; retryAfterMs: number }) {
	return convex_error({
		message: rateLimit.message,
		data: {
			retryAfterMs: rateLimit.retryAfterMs,
		},
	});
}

export const heartbeat = mutation({
	args: { roomId: v.string(), userId: v.string(), sessionId: v.string(), interval: v.number() },
	returns: v.object({
		roomToken: v.string(),
		sessionToken: v.string(),
		isNewSession: v.boolean(),
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			throw convex_error({
				message: "Presence heartbeat requires an authenticated user",
				data: {
					roomId: args.roomId,
					sessionId: args.sessionId,
				},
			});
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "presence_heartbeat", key: userAuth.id });
		if (rateLimit) {
			throw presence_rate_limit_error(rateLimit);
		}

		const result = await presence.heartbeat(ctx, args.roomId, userAuth.id, args.sessionId, args.interval);

		if (result.isNewSession) {
			const memberships = await ctx.db
				.query("workspaces_projects_users")
				.withIndex("by_active_user_workspace_project", (q) => q.eq("active", true).eq("userId", userAuth.id))
				.collect();

			await Promise.all([
				ctx.runMutation(components.presence.public.setSessionData, {
					sessionToken: result.sessionToken,
					data: {
						color: "#" + Math.floor(Math.random() * 16777215).toString(16),
					},
				}),
				// Use reconnecting as a signal to restore any disconnect-driven short cleanup
				// window back to the normal long-lived pending-edit TTL for the user's scopes.
				...memberships.map((membership) =>
					pages_db_reschedule_pending_edit_cleanup_for_user(ctx, {
						workspaceId: membership.workspaceId,
						projectId: membership.projectId,
						userId: userAuth.id,
					}),
				),
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
				// Skip rows whose user no longer resolves (unknown id, soft-deleted, or
				// missing anagraphic). Presence is disposable operational state, so stale
				// rows are ignored silently instead of being cleaned up proactively.
				const userId = ctx.db.normalizeId("users", user.userId);
				if (!userId) return null;

				const userDoc = await ctx.db.get("users", userId);
				if (!userDoc || userDoc.deletedAt != null || !userDoc.anagraphic) return null;

				const anagraphic = await ctx.db.get("users_anagraphics", userDoc.anagraphic);
				if (!anagraphic) return null;

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
		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "presence_write", key: args.sessionToken });
		if (rateLimit) {
			throw presence_rate_limit_error(rateLimit);
		}

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
		const rateLimit = await rate_limiter_limit_by_key(ctx, {
			name: "presence_write",
			key: `${args.roomToken}:${args.sessionId}`,
		});
		if (rateLimit) {
			throw presence_rate_limit_error(rateLimit);
		}

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
				// Skip rows whose user no longer resolves (unknown id, soft-deleted, or
				// missing anagraphic). Presence is disposable operational state, so stale
				// rows are ignored silently instead of being cleaned up proactively.
				const userId = ctx.db.normalizeId("users", user.userId);
				if (!userId) return null;

				const userDoc = await ctx.db.get("users", userId);
				if (!userDoc || userDoc.deletedAt != null || !userDoc.anagraphic) return null;

				const anagraphic = await ctx.db.get("users_anagraphics", userDoc.anagraphic);
				if (!anagraphic) return null;

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
		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "presence_write", key: args.sessionToken });
		if (rateLimit) {
			throw presence_rate_limit_error(rateLimit);
		}

		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			await presence.disconnect(ctx, args.sessionToken);
			return null;
		}
		await presence.disconnect(ctx, args.sessionToken);
		const onlineRooms = await presence.listUser(ctx, userAuth.id, true, 1);

		// Keep the long-lived fallback TTL in `ai_chat` because presence is optional, but
		// only shorten cleanup when the user is now fully offline across presence sessions.
		if (onlineRooms.length > 0) {
			return null;
		}

		const memberships = await ctx.db
			.query("workspaces_projects_users")
			.withIndex("by_active_user_workspace_project", (q) => q.eq("active", true).eq("userId", userAuth.id))
			.collect();

		await Promise.all(
			memberships.map(async (membership) => {
				await pages_db_reschedule_pending_edit_cleanup_for_user(ctx, {
					workspaceId: membership.workspaceId,
					projectId: membership.projectId,
					userId: userAuth.id,
					delayMs: 30_000,
				});
			}),
		);

		return null;
	},
});
