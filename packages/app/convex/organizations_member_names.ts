// Member names (`organizations_workspaces_users.displayName`): the copy of each user's name that the
// Share dialog searches, the search itself, and the drain that follows a user's name changes.

import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { query, type MutationCtx } from "./_generated/server.js";
import { internalMutation } from "./functions.ts";
import { organizations_db_get_membership } from "./organizations_memberships_db.ts";
import { convex_error } from "../server/convex-utils.ts";
import { server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";

const DRAIN_USER_NAME_BATCH_SIZE = 100;
const SEARCH_MAX_PAGE_SIZE = 50;

/**
 * The name fields of a membership for this user, read from the user's current profile. Spread them
 * into every new membership.
 */
export async function organizations_member_names_db_fields(ctx: MutationCtx, userId: Id<"users">) {
	const user = await ctx.db.get("users", userId);
	const anagraphic = user?.anagraphic ? await ctx.db.get("users_anagraphics", user.anagraphic) : null;
	// A profile written later starts the drain below, which fills in the real name.
	const displayName = anagraphic?.displayName ?? "";
	return { displayName, sortDisplayName: files_sort_text_key(displayName) };
}

/**
 * One page of the active members of the caller's workspace. Empty text lists them by name. Other text
 * matches whole words and word starts of the name, best match first. Each page costs the same in a
 * workspace of any size, because one index serves it.
 */
export const search_workspace_members = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		text: v.string(),
		paginationOpts: paginationOptsValidator,
	},
	returns: paginationResultValidator(
		v.object({
			userId: v.id("users"),
			displayName: v.string(),
			avatarUrl: v.union(v.string(), v.null()),
		}),
	),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			throw convex_error({ message: "Unauthenticated" });
		}

		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return { page: [], continueCursor: "", isDone: true };
		}

		const text = args.text.trim();
		const members = text
			? ctx.db
					.query("organizations_workspaces_users")
					.withSearchIndex("search_displayName", (q) =>
						q
							.search("displayName", text)
							.eq("active", true)
							.eq("organizationId", membership.organizationId)
							.eq("workspaceId", membership.workspaceId),
					)
			: ctx.db
					.query("organizations_workspaces_users")
					.withIndex("by_active_organization_workspace_sortDisplayName", (q) =>
						q.eq("active", true).eq("organizationId", membership.organizationId).eq("workspaceId", membership.workspaceId),
					);
		const page = await members.paginate({
			...args.paginationOpts,
			numItems: Math.min(SEARCH_MAX_PAGE_SIZE, args.paginationOpts.numItems),
		});

		return {
			...page,
			page: await Promise.all(
				page.page.map(async (member) => {
					const user = await ctx.db.get("users", member.userId);
					const anagraphic = user?.anagraphic ? await ctx.db.get("users_anagraphics", user.anagraphic) : null;
					return { userId: member.userId, displayName: member.displayName, avatarUrl: anagraphic?.avatarUrl ?? null };
				}),
			),
		};
	},
});

/**
 * Name drain. Copy a user's current name into each of their memberships, one page per run. Each run
 * reads the name again, so a rename during the drain still ends with the newest name.
 */
export const drain_user_name = internalMutation({
	args: {
		userId: v.id("users"),
		cursor: v.union(v.string(), v.null()),
		_test_batchSize: v.optional(v.number()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const fields = await organizations_member_names_db_fields(ctx, args.userId);

		// One user's memberships, inactive ones too, so a membership that comes back has the right name.
		const page = await ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_user_organization_workspace_active", (q) => q.eq("userId", args.userId))
			.paginate({ numItems: args._test_batchSize ?? DRAIN_USER_NAME_BATCH_SIZE, cursor: args.cursor });
		await Promise.all(
			page.page
				.filter((membership) => membership.displayName !== fields.displayName)
				.map((membership) => ctx.db.patch("organizations_workspaces_users", membership._id, fields)),
		);

		if (!page.isDone) {
			await ctx.scheduler.runAfter(0, internal.organizations_member_names.drain_user_name, {
				userId: args.userId,
				cursor: page.continueCursor,
				_test_batchSize: args._test_batchSize,
			});
		}
		return null;
	},
});
