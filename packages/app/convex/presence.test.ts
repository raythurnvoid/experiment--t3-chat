import { describe, expect, test } from "vitest";
import { api, components } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { app_presence_GLOBAL_ROOM_ID } from "../shared/shared-presence-constants.ts";
import { test_convex } from "./setup.test.ts";

async function presence_test_bootstrap_user(ctx: MutationCtx, args: { clerkUserId: string; displayName: string }) {
	const now = Date.now();
	const userId = await ctx.db.insert("users", {
		clerkUserId: args.clerkUserId,
	});

	const anagraphicId = await ctx.db.insert("users_anagraphics", {
		userId,
		displayName: args.displayName,
		// We set a real email on purpose. With an empty email, a bug that returned the whole user doc
		// would still pass every check below — and returning only `displayName` and `avatarUrl` is
		// exactly what presence does to avoid that.
		email: `${args.clerkUserId}@test.local`,
		updatedAt: now,
	});
	await ctx.db.patch("users", userId, { anagraphic: anagraphicId });

	return { userId, anagraphicId } as const;
}

async function presence_test_seed_heartbeat(
	ctx: MutationCtx,
	args: { roomId: string; userId: Id<"users">; sessionId: string },
) {
	return await ctx.runMutation(components.presence.public.heartbeat, {
		roomId: args.roomId,
		userId: args.userId,
		sessionId: args.sessionId,
		interval: 10_000,
	});
}

describe("presence", () => {
	test("silently drops rows pointing at soft-deleted users", async () => {
		const t = test_convex();
		const roomId = "presence-test-room";

		const { liveUser, deletedUser } = await t.run(async (ctx) => {
			const liveUser = await presence_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-presence-live",
				displayName: "Live User",
			});
			const deletedUser = await presence_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-presence-deleted",
				displayName: "Deleted User",
			});

			await Promise.all([
				presence_test_seed_heartbeat(ctx, {
					roomId,
					userId: liveUser.userId,
					sessionId: "presence-test-live-session",
				}),
				presence_test_seed_heartbeat(ctx, {
					roomId,
					userId: deletedUser.userId,
					sessionId: "presence-test-deleted-session",
				}),
			]);

			await ctx.db.patch("users", deletedUser.userId, { deletedAt: Date.now() });

			return { liveUser, deletedUser };
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: liveUser.userId,
			email: "presence-live@test.local",
		});

		const listed = await asUser.query(api.presence.listRoom, { roomId, limit: 104 });
		const listedUserIds = listed.users.map((user) => user.userId);

		expect(listedUserIds).toContain(liveUser.userId);
		expect(listedUserIds).not.toContain(deletedUser.userId);
		expect(listed.usersAnagraphics[deletedUser.userId]).toBeUndefined();
		// Only the two display fields. `toEqual` fails on any extra key, so if presence ever returned
		// the whole user doc again — which contains `email` — this test breaks.
		expect(listed.usersAnagraphics[liveUser.userId]).toEqual({ displayName: "Live User" });
	});

	test("refuses a room user list to an unauthenticated caller, by room id and by room token alike", async () => {
		const t = test_convex();
		const roomId = app_presence_GLOBAL_ROOM_ID;

		const roomToken = await t.run(async (ctx) => {
			const user = await presence_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-presence-roster",
				displayName: "Roster User",
			});
			const heartbeat = await presence_test_seed_heartbeat(ctx, {
				roomId,
				userId: user.userId,
				sessionId: "presence-test-roster",
			});
			return heartbeat.roomToken;
		});

		// `app_presence_GLOBAL_ROOM_ID` is one fixed room that every logged-in user joins. So an open
		// member list here listed every user of the whole deployment. And a `users` id is all that
		// `users.get_anagraphic` needs to turn each of them into a name.
		await expect(t.query(api.presence.listRoom, { roomId, limit: 104 })).rejects.toThrow("Unauthenticated");

		// The two handlers that take a token reach the same member list. Checking only the handler that
		// takes a `roomId` would protect nothing: `heartbeat` gives this token to anyone for any room
		// id, and the presence library creates one token per room and never changes it. So holding a
		// token says nothing about who you are.
		await expect(t.query(api.presence.list, { roomToken })).rejects.toThrow("Unauthenticated");
		await expect(t.query(api.presence.listSessions, { roomToken })).rejects.toThrow("Unauthenticated");
		await expect(t.query(api.presence.getSessionsData, { roomToken })).rejects.toThrow("Unauthenticated");
	});

	test("refuses presence writes to an unauthenticated caller holding a session token", async () => {
		const t = test_convex();
		const roomId = app_presence_GLOBAL_ROOM_ID;
		const sessionId = "presence-test-writes";

		const heartbeat = await t.run(async (ctx) => {
			const user = await presence_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-presence-writes",
				displayName: "Writes User",
			});
			return await presence_test_seed_heartbeat(ctx, { roomId, userId: user.userId, sessionId });
		});

		// The writes use the same rule as the reads. Otherwise a stolen session token would let anyone
		// change another user's presence data or push their session offline.
		await expect(
			t.mutation(api.presence.setSessionData, { sessionToken: heartbeat.sessionToken, data: { cursor: 1 } }),
		).rejects.toThrow("Unauthenticated");
		await expect(
			t.mutation(api.presence.removeSessionData, { roomToken: heartbeat.roomToken, sessionId }),
		).rejects.toThrow("Unauthenticated");
		await expect(t.mutation(api.presence.disconnect, { sessionToken: heartbeat.sessionToken })).rejects.toThrow(
			"Unauthenticated",
		);
	});

	test("refuses the global room to a signed-in caller, and still answers for other rooms", async () => {
		const t = test_convex();
		const tenantRoomId = "presence-test-tenant-room";

		const userId = await t.run(async (ctx) => {
			const user = await presence_test_bootstrap_user(ctx, {
				clerkUserId: "clerk-presence-global",
				displayName: "Global User",
			});
			await Promise.all([
				presence_test_seed_heartbeat(ctx, {
					roomId: app_presence_GLOBAL_ROOM_ID,
					userId: user.userId,
					sessionId: "presence-test-global-session",
				}),
				presence_test_seed_heartbeat(ctx, {
					roomId: tenantRoomId,
					userId: user.userId,
					sessionId: "presence-test-tenant-session",
				}),
			]);
			return user.userId;
		});

		const asUser = t.withIdentity({ issuer: process.env.VITE_CONVEX_HTTP_URL!, subject: userId });

		// Being logged in does not mean you belong to any organization. Every logged-in user joins the
		// global room, and anyone can make an anonymous account with one request that needs no login.
		// So answering here gave the full user list of the deployment to anyone at all. This test
		// covers one of two doors: `heartbeat` still gives this room's token to any caller, and `list`
		// still answers when it gets that token. That door is still open. A passing test here
		// does not mean the member list is protected.
		await expect(asUser.query(api.presence.listRoom, { roomId: app_presence_GLOBAL_ROOM_ID })).rejects.toThrow(
			"Unauthorized",
		);

		// Other rooms still answer. The refusal above is only about the one room that holds every user
		// of the deployment, not about the handler itself. Checking that other rooms belong to the
		// caller's organization is not done yet.
		const tenantRoom = await asUser.query(api.presence.listRoom, { roomId: tenantRoomId });
		expect(tenantRoom.users.map((user) => user.userId)).toEqual([userId]);
	});
});
