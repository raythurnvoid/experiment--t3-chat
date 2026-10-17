// Current local write rules, shared by file writers and saved tree reads.

import type { Doc, Id } from "../convex/_generated/dataModel.js";
import type { QueryCtx, MutationCtx } from "../convex/_generated/server.js";
import type { access_control_Subject } from "../convex/access_control.ts";
import { files_ROOT_ID } from "../shared/files.ts";
import { Result } from "common/errors-as-values-utils.ts";

export type files_nodes_WriteContext = {
	/** Who the write's access checks act as. */
	subject: access_control_Subject;
	/** Only matches named writers of a write policy. Access checks use `subject`. */
	writer: Extract<NonNullable<Doc<"files_nodes">["writePolicy"]>, { mode: "writer" }>["writers"][number];
	actorUserId: Id<"users">;
	resourceScope:
		| { kind: "workspace" }
		| { kind: "subtree"; nodeId: Id<"files_nodes"> }
		| { kind: "node"; nodeId: Id<"files_nodes"> }
		| { kind: "create"; parentNodeId: Id<"files_nodes"> | "root"; path: string };
	policyReach: "none" | "direct" | "ancestors";
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
 * Check whether a writer rule lists this writer. A read-only rule lists nobody.
 */
export function files_nodes_writer_matches_policy(args: {
	policy: NonNullable<Doc<"files_nodes">["writePolicy"]>;
	writer: files_nodes_WriteContext["writer"];
}) {
	const writer = args.writer;
	return args.policy.mode === "writer"
		? args.policy.writers.some((policyWriter) =>
				policyWriter.kind === "user"
					? writer.kind === "user" && policyWriter.userId === writer.userId
					: writer.kind === "service_account" && policyWriter.serviceAccountId === writer.serviceAccountId,
			)
		: false;
}

export async function files_write_policy_db_get_blocking_policy(
	ctx: QueryCtx | MutationCtx,
	args: { target: files_write_policy_WriteTarget; writeContext: files_nodes_WriteContext },
) {
	// Each node's protection is local. A parent rule never blocks a child on its own; only a real
	// entry change checks the destination folder, and only the named node checks itself.
	if (args.target.kind === "node") {
		const policy = args.target.node.writePolicy;
		if (policy === null) {
			return null;
		}
		if (policy.mode === "read_only") {
			return args.target.node;
		}
		return files_nodes_writer_matches_policy({ policy, writer: args.writeContext.writer }) ? null : args.target.node;
	}

	// A create checks the destination folder's own rule. A matching writer rule still refuses a
	// direct-only service: the parent rule is not the new child's own rule.
	const parent = args.target.parentNode;
	if (!parent) {
		return null;
	}
	const policy = parent.writePolicy;
	if (policy === null) {
		return null;
	}
	if (policy.mode === "read_only") {
		return parent;
	}
	return files_nodes_writer_matches_policy({ policy, writer: args.writeContext.writer }) &&
		args.writeContext.policyReach === "ancestors"
		? null
		: parent;
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

	if (await files_write_policy_db_get_blocking_policy(ctx, args)) {
		return Result({ _nay: { name: "read_only", message: "This item is read-only." } });
	}

	return Result({ _yay: null });
}

/**
 * Get the starting protection for a brand-new child of `parentId`.
 * The default is copied once. Later changes to the folder do not touch existing children.
 */
export async function files_nodes_db_resolve_parent_new_child_policy(
	ctx: QueryCtx | MutationCtx,
	args: {
		parentId: Doc<"files_nodes">["parentId"];
	},
) {
	if (args.parentId === files_ROOT_ID) {
		return null;
	}

	const parent = await ctx.db.get("files_nodes", args.parentId);
	return parent?.newChildWritePolicy ?? null;
}

/**
 * Allow a copy run into the parent it produced while the parent's current policy still equals
 * the value the run wrote there. A null or changed stored value keeps the live refusal.
 */
export async function files_nodes_db_require_user_writable_or_matching_policy(
	ctx: QueryCtx | MutationCtx,
	args: {
		node: Doc<"files_nodes">;
		userId: Id<"users">;
		runWrittenWritePolicy?: Doc<"files_nodes">["writePolicy"];
	},
) {
	const writable = await files_nodes_db_require_user_writable(ctx, {
		node: args.node,
		userId: args.userId,
	});
	if (!writable._nay) {
		return writable;
	}

	if (
		writable._nay.name !== "read_only" ||
		args.runWrittenWritePolicy == null ||
		JSON.stringify(args.node.writePolicy) !== JSON.stringify(args.runWrittenWritePolicy)
	) {
		return writable;
	}

	return Result({ _yay: null });
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
		writeContext: {
			subject: { kind: "user", userId: args.userId, plugin: null },
			writer: { kind: "user", userId: args.userId },
			actorUserId: args.userId,
			resourceScope: { kind: "workspace" },
			policyReach: "ancestors",
		},
	});
}
