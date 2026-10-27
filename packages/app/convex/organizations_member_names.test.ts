import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
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

describe("search_workspace_members", () => {
	/**
	 * The caller "Ada" plus `others` members named "Other N" and three named "Grace …", all in the
	 * caller's workspace, and one "Grace Gone" who left it.
	 */
	async function search_fixture(args: { others: number }) {
		const { t, db } = await fixture();
		await t.run(async (ctx) => {
			const add_member = async (displayName: string, active: boolean) => {
				const userId = await ctx.db.insert("users", { clerkUserId: null });
				const anagraphic = await ctx.db.insert("users_anagraphics", {
					userId,
					displayName,
					avatarUrl: `https://img.test/${encodeURIComponent(displayName)}`,
					email: `${userId}@example.com`,
					updatedAt: Date.now(),
				});
				await ctx.db.patch("users", userId, { anagraphic });
				await ctx.db.insert("organizations_workspaces_users", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					userId,
					active,
					pendingOrganizationRemoval: false,
					updatedAt: Date.now(),
					displayName,
					sortDisplayName: files_sort_text_key(displayName),
				});
			};
			for (let index = 0; index < args.others; index += 1) {
				await add_member(`Other ${index}`, true);
			}
			await add_member("Grace Hopper", true);
			await add_member("Grace Kelly", true);
			await add_member("Grace Jones", true);
			await add_member("Grace Gone", false);
		});
		const asCaller = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const search = (text: string, numItems: number, cursor: string | null = null) =>
			asCaller.query(api.organizations_member_names.search_workspace_members, {
				membershipId: db.membershipId,
				text,
				paginationOpts: { numItems, cursor },
			});
		return { t, db, search };
	}

	test("fills each page with matches when many members do not match", async () => {
		const { search } = await search_fixture({ others: 60 });

		const first = await search("grace", 2);
		const second = await search("grace", 2, first.continueCursor);

		expect(first.page).toHaveLength(2);
		expect([...first.page, ...second.page].map((member) => member.displayName).sort()).toEqual([
			"Grace Hopper",
			"Grace Jones",
			"Grace Kelly",
		]);
		expect(first.page[0]?.avatarUrl).toMatch(/^https:\/\/img\.test\//);
	});

	test("lists active members by name when the text is empty", async () => {
		const { search } = await search_fixture({ others: 2 });

		const page = await search("  ", 10);

		expect(page.page.map((member) => member.displayName)).toEqual([
			"Ada",
			"Grace Hopper",
			"Grace Jones",
			"Grace Kelly",
			"Other 0",
			"Other 1",
		]);
	});

	test("returns nothing for a membership that is not the caller's", async () => {
		const { t, db } = await search_fixture({ others: 0 });
		const strangerId = await t.run((ctx) => ctx.db.insert("users", { clerkUserId: null }));

		const page = await t
			.withIdentity({ issuer: "https://clerk.test", external_id: strangerId })
			.query(api.organizations_member_names.search_workspace_members, {
				membershipId: db.membershipId,
				text: "grace",
				paginationOpts: { numItems: 10, cursor: null },
			});

		expect(page.page).toEqual([]);
	});
});

describe("organizations_member_names_db_fields", () => {
	test("a new anonymous user's membership has their name", async () => {
		const t = test_convex();
		// A new anonymous user starts on the Free plan, so the synced Free product must exist.
		await t.run(async (ctx) => {
			const seedUser = await ctx.db.insert("users", { clerkUserId: null });
			await test_mocks_fill_db_with.plan(ctx, { userId: seedUser, plan: "Free" });
		});

		const { userId } = await t.mutation(internal.users.create_anonymous_user, {});
		const names = await t.run(async (ctx) => {
			const user = await ctx.db.get("users", userId);
			const anagraphic = user?.anagraphic ? await ctx.db.get("users_anagraphics", user.anagraphic) : null;
			const memberships = await ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_user_organization_workspace_active", (q) => q.eq("userId", userId))
				.collect();
			return { anagraphic: anagraphic?.displayName, memberships: memberships.map((m) => m.displayName) };
		});

		expect(names.anagraphic).toBeTruthy();
		expect(names.memberships).toEqual([names.anagraphic]);
	});
});

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
