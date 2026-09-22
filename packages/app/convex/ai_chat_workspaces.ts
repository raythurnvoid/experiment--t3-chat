import { Result } from "common/errors-as-values-utils.ts";
import { v, type Infer } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel.js";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import { access_control_db_authorize_membership } from "./access_control.ts";
import { ai_chat_files_db_get_invocation_membership } from "./ai_chat_files.ts";
import { organizations_db_get_membership } from "./organizations.ts";
import { organizations_membership_lifetimes_db_ensure } from "./organizations_membership_lifetimes.ts";
import { ai_chat_workspaces_source_validator } from "./schema.ts";
import { v_result } from "../server/convex-utils.ts";

const workspace_validator = v.object({
	organizationId: v.id("organizations"),
	workspaceId: v.id("organizations_workspaces"),
	organizationName: v.string(),
	workspaceName: v.string(),
	membershipId: v.id("organizations_workspaces_users"),
});

async function read_workspace(ctx: QueryCtx | MutationCtx, membership: Doc<"organizations_workspaces_users">) {
	const allowed = await access_control_db_authorize_membership(ctx, {
		userAuth: { id: membership.userId },
		membership,
		permission: "content.read",
	});
	if (allowed._nay) return allowed;
	const workspace = await ctx.db.get("organizations_workspaces", membership.workspaceId);
	if (!workspace || workspace.pluginDataPurgeStartedAt !== undefined)
		return Result({ _nay: { message: "Workspace unavailable" } });
	return Result({
		_yay: {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			organizationName: allowed._yay.organization.name,
			workspaceName: workspace.name,
			membershipId: membership._id,
		},
	});
}

async function read_personal_membership(ctx: QueryCtx | MutationCtx, user: Doc<"users">) {
	if (!user.defaultOrganizationId || !user.defaultWorkspaceId) return null;
	return await ctx.db
		.query("organizations_workspaces_users")
		.withIndex("by_active_user_organization_workspace", (q) =>
			q
				.eq("active", true)
				.eq("userId", user._id)
				.eq("organizationId", user.defaultOrganizationId!)
				.eq("workspaceId", user.defaultWorkspaceId!),
		)
		.first();
}

/**
 * Capture the chat's membership lifetime before any long-running work starts.
 */
export const capture = internalMutation({
	args: { userId: v.id("users"), membershipId: v.id("organizations_workspaces_users") },
	returns: v_result({
		_yay: v.object({
			membershipLifetime: v.number(),
			current: workspace_validator,
			personal: workspace_validator,
		}),
	}),
	handler: async (ctx, args) => {
		const membership = await organizations_db_get_membership(ctx, args);
		if (!membership) return Result({ _nay: { message: "Unauthorized" } });
		const current = await read_workspace(ctx, membership);
		if (current._nay) return current;
		const user = (await ctx.db.get("users", args.userId))!;
		const personalMembership = await read_personal_membership(ctx, user);
		if (!personalMembership) return Result({ _nay: { message: "Personal workspace unavailable" } });
		const personal =
			personalMembership._id === membership._id ? current : await read_workspace(ctx, personalMembership);
		if (personal._nay) return personal;
		const membershipLifetime = await organizations_membership_lifetimes_db_ensure(ctx, membership);
		return Result({ _yay: { membershipLifetime, current: current._yay, personal: personal._yay } });
	},
});

/**
 * File doors still check their exact node and write policy after this workspace check.
 */
export async function ai_chat_workspaces_db_resolve(
	ctx: QueryCtx | MutationCtx,
	args: { source: Infer<typeof ai_chat_workspaces_source_validator>; workspace: "current" | "personal" },
) {
	const membership = await ai_chat_files_db_get_invocation_membership(ctx, args.source);
	if (!membership) return Result({ _nay: { message: "Chat is no longer available" } });
	const thread = (await ctx.db.get("ai_chat_threads", args.source.threadId))!;
	if (thread.archived) return Result({ _nay: { message: "Chat is no longer available" } });
	if (args.workspace === "current") return await read_workspace(ctx, membership);
	const user = (await ctx.db.get("users", args.source.userId))!;
	const personalMembership = await read_personal_membership(ctx, user);
	if (!personalMembership) return Result({ _nay: { message: "Personal workspace unavailable" } });
	return await read_workspace(ctx, personalMembership);
}

export const resolve = internalQuery({
	args: {
		source: ai_chat_workspaces_source_validator,
		workspace: v.union(v.literal("current"), v.literal("personal")),
	},
	returns: v_result({ _yay: workspace_validator }),
	handler: ai_chat_workspaces_db_resolve,
});

/**
 * Check the original chat and file destination inside the read or write transaction.
 */
export async function ai_chat_workspaces_db_authorize_file_scope(
	ctx: QueryCtx | MutationCtx,
	args: {
		agentSource: Infer<typeof ai_chat_workspaces_source_validator>;
		organizationId: string;
		workspaceId: string;
		userId: Id<"users">;
	},
) {
	const resolved = await ai_chat_workspaces_db_resolve(ctx, {
		source: args.agentSource,
		workspace: args.workspaceId === args.agentSource.workspaceId ? "current" : "personal",
	});
	if (resolved._nay) return resolved;
	if (
		args.userId !== args.agentSource.userId ||
		args.organizationId !== resolved._yay.organizationId ||
		args.workspaceId !== resolved._yay.workspaceId
	)
		return Result({ _nay: { message: "File workspace is not available to this chat" } });
	return Result({ _yay: null });
}
