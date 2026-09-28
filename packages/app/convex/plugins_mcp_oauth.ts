import { v } from "convex/values";
import { Result } from "common/errors-as-values-utils.ts";

import { mutation } from "./_generated/server.js";
import { organizations_db_get_membership } from "./organizations.ts";
import { plugins_mcp_db_revoke_grant } from "./plugins_mcp.ts";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";
import { plugins_mcp_target_validator } from "./schema.ts";
import { v_result } from "../server/convex-utils.ts";
import { server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";

/**
 * Delete the caller's own sign-in for one MCP server in this workspace.
 *
 * Removing access needs no permission, so a member who lost `workspace.mcp.use` can still
 * disconnect. An admin cannot disconnect another member's sign-in here.
 */
export const disconnect = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		target: plugins_mcp_target_validator,
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "mcp_member_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return Result({ _nay: { message: "Not found" } });
		}

		const { target } = args;
		const grant =
			target.kind === "plugin"
				? await ctx.db
						.query("plugins_mcp_oauth_grants")
						.withIndex("by_targetInstallation_targetServerId_user", (q) =>
							q
								.eq("target.installationId", target.installationId)
								.eq("target.serverId", target.serverId)
								.eq("userId", userAuth.id),
						)
						.first()
				: await ctx.db
						.query("plugins_mcp_oauth_grants")
						.withIndex("by_targetCustomServer_user", (q) =>
							q.eq("target.customServerId", target.customServerId).eq("userId", userAuth.id),
						)
						.first();
		if (!grant || grant.organizationId !== membership.organizationId || grant.workspaceId !== membership.workspaceId) {
			return Result({ _nay: { message: "Not found" } });
		}

		// TODO(mcp-oauth): schedule `revoke_one` for the revocation doc this writes (step 8).
		await plugins_mcp_db_revoke_grant(ctx, grant);
		return Result({ _yay: null });
	},
});
