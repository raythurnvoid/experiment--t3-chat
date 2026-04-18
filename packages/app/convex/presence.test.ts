import { describe, expect, test } from "vitest";
import { api, components } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { test_convex } from "./setup.test.ts";

async function presence_test_bootstrap_user(ctx: MutationCtx, args: { clerkUserId: string; displayName: string }) {
	const now = Date.now();
	const userId = await ctx.db.insert("users", {
		clerkUserId: args.clerkUserId,
	});

	const anagraphicId = await ctx.db.insert("users_anagraphics", {
		userId,
		displayName: args.displayName,
		email: "",
		updatedAt: now,
	});
	await ctx.db.patch("users", userId, { anagraphic: anagraphicId });

	return { userId, anagraphicId } as const;
}

async function presence_test_seed_heartbeat(
	ctx: MutationCtx,
	args: { roomId: string; userId: Id<"users">; sessionId: string },
) {
	await ctx.runMutation(components.presence.public.heartbeat, {
		roomId: args.roomId,
		userId: args.userId,
		sessionId: args.sessionId,
		interval: 10_000,
	});
}

describe("listRoom", () => {
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

			await ctx.db.patch(deletedUser.userId, { deletedAt: Date.now() });

			return { liveUser, deletedUser };
		});

		const listed = await t.query(api.presence.listRoom, { roomId, limit: 104 });
		const listedUserIds = listed.users.map((user) => user.userId);

		expect(listedUserIds).toContain(liveUser.userId);
		expect(listedUserIds).not.toContain(deletedUser.userId);
		expect(listed.usersAnagraphics[liveUser.userId]).toBeDefined();
		expect(listed.usersAnagraphics[deletedUser.userId]).toBeUndefined();
	});
});
