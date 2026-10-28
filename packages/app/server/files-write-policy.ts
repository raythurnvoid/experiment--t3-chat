// Current local write rules, shared by file writers and saved tree reads.

import type { Doc, Id } from "../convex/_generated/dataModel.js";
import type { QueryCtx, MutationCtx } from "../convex/_generated/server.js";
import type { access_control_Subject } from "../convex/access_control.ts";
import { files_ROOT_ID } from "../shared/files.ts";
import { Result } from "common/errors-as-values-utils.ts";

export type files_nodes_WriteContext = {
	/** Who the write's access checks act as. */
	subject: access_control_Subject;
	actorUserId: Id<"users">;
	resourceScope:
		| { kind: "workspace" }
		| { kind: "subtree"; nodeId: Id<"files_nodes"> }
		| { kind: "node"; nodeId: Id<"files_nodes"> }
		| { kind: "create"; parentNodeId: Id<"files_nodes"> | "root"; path: string };
	/**
	 * Set only after the machine door checks its current Read-only grant.
	 */
	force: boolean;
};

export type files_write_policy_WriteTarget =
	| { kind: "node"; node: Doc<"files_nodes"> }
	| { kind: "create"; parentNode: Doc<"files_nodes"> | null; path: string };

export async function files_write_policy_db_is_within_scope(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		writeContext: files_nodes_WriteContext;
		target: files_write_policy_WriteTarget;
	},
) {
	const scope = args.writeContext.resourceScope;
	let node = args.target.kind === "node" ? args.target.node : args.target.parentNode;
	if (node && (node.organizationId !== args.organizationId || node.workspaceId !== args.workspaceId)) {
		return false;
	}

	if (scope.kind === "workspace") {
		return true;
	}
	if (scope.kind === "create") {
		return (
			args.target.kind === "create" &&
			scope.parentNodeId === (node?._id ?? files_ROOT_ID) &&
			scope.path === args.target.path
		);
	}
	if (scope.kind === "node") {
		return args.target.kind === "node" && node?._id === scope.nodeId;
	}

	while (node) {
		if (node._id === scope.nodeId) {
			return true;
		}
		node = node.parentId === files_ROOT_ID ? null : await ctx.db.get("files_nodes", node.parentId);
	}

	return false;
}

/**
 * Apply the current policy after actor, account, and credential permission checks.
 */
export async function files_nodes_db_require_writable(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		writeContext: files_nodes_WriteContext;
		target: files_write_policy_WriteTarget;
	},
) {
	if (!(await files_write_policy_db_is_within_scope(ctx, args))) {
		return Result({ _nay: { message: "Permission denied" } });
	}

	const node = args.target.kind === "node" ? args.target.node : args.target.parentNode;
	if (node?.readOnly && !args.writeContext.force) {
		return Result({ _nay: { name: "read_only", message: "This item is read-only." } });
	}

	return Result({ _yay: null });
}

/**
 * Complete original copied children only while their saved parent's decision ID still matches.
 * Clearing and setting Read-only again breaks the receipt.
 */
export async function files_nodes_db_require_writable_or_matching_decision(
	ctx: QueryCtx | MutationCtx,
	args: {
		node: Doc<"files_nodes">;
		writeContext: files_nodes_WriteContext;
		runWrittenReadOnlyDecisionId?: string;
	},
) {
	const writable = await files_nodes_db_require_writable(ctx, {
		organizationId: args.node.organizationId,
		workspaceId: args.node.workspaceId,
		writeContext: args.writeContext,
		target: { kind: "node", node: args.node },
	});
	if (!writable._nay) {
		return writable;
	}

	if (
		writable._nay.name !== "read_only" ||
		!args.runWrittenReadOnlyDecisionId ||
		args.node.readOnlyDecisionId !== args.runWrittenReadOnlyDecisionId
	) {
		return writable;
	}

	return Result({ _yay: null });
}

/**
 * The write context of a person acting in the app, in the agent, or with a personal API key.
 */
export function files_nodes_user_write_context(userId: Id<"users">): files_nodes_WriteContext {
	return {
		subject: { kind: "user", userId, plugin: null },
		actorUserId: userId,
		resourceScope: { kind: "workspace" },
		force: false,
	};
}

/**
 * Ordinary app and agent writes always use their current human actor.
 */
export async function files_nodes_db_require_user_writable(
	ctx: QueryCtx | MutationCtx,
	args: { node: Doc<"files_nodes">; userId: Id<"users"> },
) {
	return await files_nodes_db_require_writable(ctx, {
		organizationId: args.node.organizationId,
		workspaceId: args.node.workspaceId,
		target: { kind: "node", node: args.node },
		writeContext: files_nodes_user_write_context(args.userId),
	});
}
