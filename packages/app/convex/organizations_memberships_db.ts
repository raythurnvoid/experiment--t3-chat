// Exact membership reads, without tenant writers or bootstrap work.

import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import type { Id } from "./_generated/dataModel.js";

/**
 * Get a membership doc by id and verify it belongs to the given user.
 */
export async function organizations_db_get_membership(
	ctx: QueryCtx | MutationCtx,
	args: { userId: Id<"users">; membershipId: Id<"organizations_workspaces_users"> },
) {
	const membership = await ctx.db.get("organizations_workspaces_users", args.membershipId);
	if (!membership || membership.userId !== args.userId || membership.active === false) {
		return null;
	}
	return membership;
}
