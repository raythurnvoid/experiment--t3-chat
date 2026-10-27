import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";

beforeEach(() => {
	// Scheduled job steps run only when a test finishes them.
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

/**
 * A Clerk user named "Ada" with three memberships: the personal workspace, and two workspaces of one
 * organization.
 */
async function fixture() {
	const t = test_convex();
	const db = await t.run(async (ctx) => {
		const userId = await ctx.db.insert("users", { clerkUserId: "clerk-member-names" });
		const anagraphic = await ctx.db.insert("users_anagraphics", {
			userId,
			displayName: "Ada",
			email: "ada@example.com",
			updatedAt: Date.now(),
		});
		await ctx.db.patch("users", userId, { anagraphic });
		return await test_mocks_fill_db_with.membership(ctx, { userId, workspaceName: "second" });
	});

	const read_names = (userId: Id<"users">) =>
		t.run(async (ctx) =>
			(
				await ctx.db
					.query("organizations_workspaces_users")
					.withIndex("by_user_organization_workspace_active", (q) => q.eq("userId", userId))
					.collect()
			).map((membership) => ({ displayName: membership.displayName, sortDisplayName: membership.sortDisplayName })),
		);

	return { t, db, read_names };
}

describe("drain_user_name", () => {
	test("a name change reaches every membership of the user", async () => {
		const { t, db, read_names } = await fixture();
		expect(await read_names(db.userId)).toEqual(
			Array.from({ length: 3 }, () => ({ displayName: "Ada", sortDisplayName: files_sort_text_key("Ada") })),
		);

		const result = await t.mutation(internal.users.resolve_user, {
			clerkUserId: "clerk-member-names",
			email: "ada@example.com",
			displayName: "Ada Lovelace",
		});
		if (result._nay) throw new Error(result._nay.message);
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		expect(await read_names(db.userId)).toEqual(
			Array.from({ length: 3 }, () => ({
				displayName: "Ada Lovelace",
				sortDisplayName: files_sort_text_key("Ada Lovelace"),
			})),
		);
	});

	test("goes on page by page until the last membership", async () => {
		const { t, db, read_names } = await fixture();
		await t.run(async (ctx) => {
			const user = await ctx.db.get("users", db.userId);
			if (!user?.anagraphic) throw new Error("Missing anagraphic");
			await ctx.db.patch("users_anagraphics", user.anagraphic, { displayName: "Grace" });
		});

		await t.mutation(internal.organizations_member_names.drain_user_name, {
			userId: db.userId,
			cursor: null,
			_test_batchSize: 1,
		});
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		expect((await read_names(db.userId)).map((names) => names.displayName)).toEqual(["Grace", "Grace", "Grace"]);
	});
});
