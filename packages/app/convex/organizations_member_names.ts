// Member names (`organizations_workspaces_users.displayName`): the copy of each user's name that the
// Share dialog searches, and the drain that follows a user's name changes.

import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { internalMutation } from "./functions.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";

const DRAIN_USER_NAME_BATCH_SIZE = 100;

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
