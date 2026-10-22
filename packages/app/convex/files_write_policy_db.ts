// Shared database bodies. Keep editor and action work on their current owners.

import type { QueryCtx, MutationCtx } from "./_generated/server.js";
import type { Doc, Id } from "./_generated/dataModel";
import { files_ROOT_ID } from "../server/files.ts";
import { Result } from "common/errors-as-values-utils.ts";
import { organizations_db_get_membership } from "./organizations_memberships_db.ts";
import { access_control_db_authorize_node, access_control_db_can_act_on_file_node } from "./access_control.ts";
import type { access_control_Permission } from "../shared/access-control.ts";
import { files_WRITE_POLICY_INVALID_WRITERS_MESSAGE } from "../shared/files.ts";
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
	ctx: MutationCtx,
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
 * Load the membership and node. Check `content.permissions.manage` on the node.
 *
 * Check the node so a grant on a restricted node can allow this action.
 * Policy management must work while content is blocked.
 */
export async function files_nodes_db_authorize_write_policy_management(
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
		permission: "content.permissions.manage",
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

export async function files_write_policy_db_get_visible_policy_writer(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		writer: files_nodes_WriteContext["writer"];
	},
) {
	const writer = args.writer;
	if (writer.kind === "service_account") {
		const account = await ctx.db.get("access_control_service_accounts", writer.serviceAccountId);
		return account &&
			account.organizationId === args.organizationId &&
			account.workspaceId === args.workspaceId &&
			account.revokedAt === null
			? { ...writer, name: account.name }
			: null;
	}

	const organizationId = ctx.db.normalizeId("organizations", String(args.organizationId));
	const workspaceId = ctx.db.normalizeId("organizations_workspaces", String(args.workspaceId));
	if (!organizationId || !workspaceId) {
		return null;
	}

	const [user, membership] = await Promise.all([
		ctx.db.get("users", writer.userId),
		ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_active_user_organization_workspace", (q) =>
				q
					.eq("active", true)
					.eq("userId", writer.userId)
					.eq("organizationId", organizationId)
					.eq("workspaceId", workspaceId),
			)
			.first(),
	]);
	if (!user || user.deletedAt != null || !membership || membership.pendingOrganizationRemoval) {
		return null;
	}

	const anagraphic = user.anagraphic ? await ctx.db.get("users_anagraphics", user.anagraphic) : null;
	return { ...writer, name: anagraphic?.displayName ?? "User" };
}

/**
 * Check that a copied protection rule still names only writers who can edit the destination.
 * Copies keep access grants separate, so every writer in the rule must be an active destination
 * member or account. Refuse clearly instead of silently clearing the rule.
 */
export async function files_nodes_db_require_copiable_write_policy(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		writePolicy: Doc<"files_nodes">["writePolicy"];
	},
) {
	if (args.writePolicy?.mode === "writer") {
		const visibleWriters = await Promise.all(
			args.writePolicy.writers.map((writer) =>
				files_write_policy_db_get_visible_policy_writer(ctx, {
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					writer,
				}),
			),
		);
		if (visibleWriters.includes(null)) {
			return Result({
				_nay: {
					message:
						"The copied protection names a writer who cannot edit this destination. Change the source rule or pick a writer with access first.",
				},
			});
		}
	}

	return Result({ _yay: null });
}

/**
 * Merge freshly read source protection into a copy's `copiedFrom` record.
 * The first write wins: a retry reuses its target and never applies later source rules
 * over what the first attempt captured.
 */
export function files_nodes_db_copied_from_policy_fields(args: {
	prev?: Pick<
		NonNullable<Doc<"files_pending_updates">["copiedFrom"]>,
		"sourceWritePolicy" | "sourceNewChildWritePolicy"
	> | null;
	sourceWritePolicy?: Doc<"files_nodes">["writePolicy"];
	sourceNewChildWritePolicy?: Doc<"files_nodes">["newChildWritePolicy"];
}) {
	if (args.prev?.sourceWritePolicy !== undefined) {
		return {
			sourceWritePolicy: args.prev.sourceWritePolicy,
			...(args.prev.sourceNewChildWritePolicy === undefined
				? {}
				: { sourceNewChildWritePolicy: args.prev.sourceNewChildWritePolicy }),
		};
	}

	return {
		...(args.sourceWritePolicy === undefined ? {} : { sourceWritePolicy: args.sourceWritePolicy }),
		...(args.sourceNewChildWritePolicy === undefined
			? {}
			: { sourceNewChildWritePolicy: args.sourceNewChildWritePolicy }),
	};
}

/**
 * Validate all management before a create or a larger operation starts writing.
 */
export async function files_nodes_db_require_write_policy_management(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		writeContext: files_nodes_WriteContext;
		target: files_write_policy_WriteTarget;
		writePolicy: Doc<"files_nodes">["writePolicy"];
	},
) {
	const node = args.target.kind === "node" ? args.target.node : args.target.parentNode;
	if (
		!(await files_write_policy_db_is_within_scope(ctx, args)) ||
		!(await files_write_policy_db_has_write_context_permission(ctx, {
			...args,
			node,
			permission: "content.permissions.manage",
		}))
	) {
		return Result({ _nay: { message: "Permission denied" } });
	}

	if (args.writePolicy?.mode === "writer") {
		const writers = args.writePolicy.writers;
		const writerIds = new Set(
			writers.map((writer) => (writer.kind === "user" ? writer.userId : writer.serviceAccountId)),
		);
		// There is no max count. Every writer must be an active member or account (checked below),
		// so the workspace size already limits the list.
		if (writers.length === 0 || writerIds.size !== writers.length) {
			return Result({ _nay: { message: files_WRITE_POLICY_INVALID_WRITERS_MESSAGE } });
		}

		// Every listed writer must be an active member or account now. The management state hides a
		// stored writer who left, so a manager who saves the rule again has to drop or replace them.
		const visibleWriters = await Promise.all(
			writers.map((writer) => files_write_policy_db_get_visible_policy_writer(ctx, { ...args, writer })),
		);
		if (visibleWriters.includes(null)) {
			return Result({ _nay: { message: "Writer is not available" } });
		}
	}

	// Check only the target. A folder's rule limits rename and move-out of its direct children, restricted
	// ones too, the same way write access on a Linux or macOS folder does. Children keep their own rules.
	return Result({ _yay: null });
}
