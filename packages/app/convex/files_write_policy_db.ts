// Shared database bodies. Keep editor and action work on their current owners.

import type { QueryCtx, MutationCtx } from "./_generated/server.js";
import type { Doc, Id } from "./_generated/dataModel";
import { files_ROOT_ID } from "../server/files.ts";
import { Result } from "common/errors-as-values-utils.ts";
import { organizations_db_get_membership } from "./organizations_memberships_db.ts";
import { access_control_db_authorize_node, access_control_db_can_act_on_file_node } from "./access_control.ts";
import type { access_control_Permission } from "../shared/access-control.ts";
import {
	type files_nodes_WriteContext,
	type files_write_policy_WriteTarget,
	files_write_policy_db_is_within_scope,
} from "../server/files-write-policy.ts";

/**
 * The restricted scope a new or moved child inherits from where it sits: the nearest restricted
 * folder at or above `parentId`, or `null` when that chain has none.
 *
 * The parent already carries the answer, because every node stores its nearest restricted ancestor.
 * So this is one read and never a walk up the tree.
 */
export async function files_nodes_db_resolve_parent_restricted_scope(
	ctx: QueryCtx | MutationCtx,
	args: {
		parentId: Doc<"files_nodes">["parentId"];
	},
) {
	if (args.parentId === files_ROOT_ID) {
		return null;
	}

	const parent = await ctx.db.get("files_nodes", args.parentId);
	return parent?.restrictedScopeNodeId ?? null;
}

/**
 * Load the membership and node. Check Can edit, even while Read-only blocks content.
 *
 * Check the node so a grant on a restricted node can allow this action.
 * Policy management must work while content is blocked.
 */
export async function files_nodes_db_authorize_read_only_management(
	ctx: MutationCtx,
	args: {
		userAuth: { id: Id<"users"> };
		membershipId: Id<"organizations_workspaces_users">;
		nodeId: Id<"files_nodes">;
	},
) {
	const membership = await organizations_db_get_membership(ctx, {
		userId: args.userAuth.id,
		membershipId: args.membershipId,
	});
	if (!membership) {
		return Result({ _nay: { message: "Unauthorized" } });
	}

	const authorized = await access_control_db_authorize_node(ctx, {
		userAuth: args.userAuth,
		membership,
		nodeId: args.nodeId,
		permission: "content.write",
	});
	if (authorized._nay) {
		return authorized;
	}

	return Result({ _yay: { membership, node: authorized._yay.fileNode } });
}

export async function files_write_policy_db_has_write_context_permission(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		writeContext: files_nodes_WriteContext;
		node: Doc<"files_nodes"> | null;
		permission: access_control_Permission;
		/**
		 * The person's membership that this transaction already checked, for example at the start of a
		 * job step. Pass it so each node check skips reading the user and the membership again.
		 */
		membership?: Doc<"organizations_workspaces_users">;
	},
) {
	const organizationId = ctx.db.normalizeId("organizations", String(args.organizationId));
	const workspaceId = ctx.db.normalizeId("organizations_workspaces", String(args.workspaceId));
	if (!organizationId || !workspaceId) {
		return false;
	}

	const subject = args.writeContext.subject;
	if (subject.kind === "user" && args.membership) {
		const membership = args.membership;
		if (
			membership.userId !== subject.userId ||
			membership.organizationId !== organizationId ||
			membership.workspaceId !== workspaceId ||
			!membership.active ||
			membership.pendingOrganizationRemoval
		) {
			return false;
		}
	} else if (subject.kind === "user") {
		// The person must still exist and be a member here. An account's liveness is part of its own check.
		const user = await ctx.db.get("users", subject.userId);
		if (!user || user.deletedAt != null) {
			return false;
		}
		const membership = await ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_active_user_organization_workspace", (q) =>
				q
					.eq("active", true)
					.eq("userId", subject.userId)
					.eq("organizationId", organizationId)
					.eq("workspaceId", workspaceId),
			)
			.first();
		if (!membership || membership.pendingOrganizationRemoval) {
			return false;
		}
	}

	return await access_control_db_can_act_on_file_node(ctx, {
		organizationId,
		workspaceId,
		subject,
		// Leave out the "Add people" pointer, so the checker reads it where a saved Move shows the node.
		// The node doc keeps its old place until the Move's cleanup step runs.
		fileNode: args.node && {
			_id: args.node._id,
			restrictedScopeNodeId: args.node.restrictedScopeNodeId ?? null,
			treePath: args.node.treePath,
		},
		permission: args.permission,
	});
}

/**
 * Keep the first captured source flag when a copy request retries.
 */
export function files_nodes_db_copied_from_read_only_fields(args: {
	prev?: Pick<NonNullable<Doc<"files_pending_updates">["copiedFrom"]>, "sourceReadOnly"> | null;
	sourceReadOnly?: boolean;
}) {
	return args.prev?.sourceReadOnly !== undefined
		? { sourceReadOnly: args.prev.sourceReadOnly }
		: args.sourceReadOnly === undefined
			? {}
			: { sourceReadOnly: args.sourceReadOnly };
}

/**
 * Validate all management before a create or a larger operation starts writing.
 */
export async function files_nodes_db_require_read_only_management(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		writeContext: files_nodes_WriteContext;
		target: files_write_policy_WriteTarget;
	},
) {
	const node = args.target.kind === "node" ? args.target.node : args.target.parentNode;
	if (
		!(await files_write_policy_db_is_within_scope(ctx, args)) ||
		!(await files_write_policy_db_has_write_context_permission(ctx, {
			...args,
			node,
			permission: "content.write",
		}))
	) {
		return Result({ _nay: { message: "Permission denied" } });
	}

	return Result({ _yay: null });
}
