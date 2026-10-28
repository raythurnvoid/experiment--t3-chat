import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { access_control_db_can_act_on_file_node } from "./access_control.ts";
import { files_nodes_db_archive_node } from "./files_nodes.ts";
import { files_media_validation_db_advance_version } from "./files_media_validation.ts";
import { organizations_membership_lifetimes_db_get } from "./organizations_membership_lifetimes.ts";
import { files_nodes_db_require_writable, type files_nodes_WriteContext } from "../server/files-write-policy.ts";
import { files_saved_placement_db_get_node } from "../server/files-saved-placement.ts";
import { files_move_reservations_db_check_node_write } from "../server/files-move-reservations.ts";
import { files_ROOT_ID } from "../shared/files.ts";
import { crypto_sha256_hex } from "../server/crypto-utils.ts";
import { Result } from "common/errors-as-values-utils.ts";

export const public_api_file_archives_result_validator = v.object({
	requestId: v.string(),
	archivedNodes: v.number(),
	complete: v.boolean(),
	refused: v.array(v.object({ path: v.union(v.string(), v.null()), message: v.string() })),
});

type Receipt = Doc<"plugins_file_archive_receipts">;

/**
 * Identity checks happen at the door. A receipt never grants another write.
 */
export async function public_api_file_archives_db_prepare(
	ctx: QueryCtx,
	args: Pick<
		Receipt,
		| "organizationId"
		| "workspaceId"
		| "installationId"
		| "principalKey"
		| "actorUserId"
		| "operation"
		| "path"
		| "force"
		| "requestId"
	> & { previousRequestId?: string },
) {
	if (
		!args.requestId ||
		args.requestId.length > 128 ||
		(args.previousRequestId !== undefined && (!args.previousRequestId || args.previousRequestId.length > 128))
	) {
		return Result({ _nay: { message: "Request IDs must have 1 to 128 characters" } });
	}
	const lifetime = await organizations_membership_lifetimes_db_get(ctx, {
		workspaceId: args.workspaceId,
		userId: args.actorUserId,
	});
	const membershipLifetime = lifetime?.lifetime ?? null;
	const inputHash = await crypto_sha256_hex(
		JSON.stringify([args.operation, args.path, args.force, args.previousRequestId ?? null]),
	);
	const find = (requestId: string) =>
		ctx.db
			.query("plugins_file_archive_receipts")
			.withIndex("by_principal_request", (q) => q.eq("principalKey", args.principalKey).eq("requestId", requestId))
			.unique();
	const sameAuthority = (receipt: Receipt) =>
		receipt.organizationId === args.organizationId &&
		receipt.workspaceId === args.workspaceId &&
		receipt.installationId === args.installationId &&
		receipt.actorUserId === args.actorUserId &&
		receipt.membershipLifetime === membershipLifetime;
	const receipt = await find(args.requestId);
	if (receipt && (!sameAuthority(receipt) || receipt.inputHash !== inputHash)) {
		return Result({ _nay: { name: "conflict", message: "This request ID was already used for another archive" } });
	}
	const previous = args.previousRequestId === undefined ? null : await find(args.previousRequestId);
	if (
		args.previousRequestId !== undefined &&
		(!previous ||
			!sameAuthority(previous) ||
			previous.complete ||
			previous.operation !== args.operation ||
			previous.path !== args.path)
	) {
		return Result({ _nay: { name: "conflict", message: "The earlier archive does not match this request" } });
	}
	return Result({ _yay: { receipt, previous, inputHash, membershipLifetime } });
}

export async function public_api_file_archives_db_result(
	ctx: QueryCtx,
	args: { receipt: Receipt; writeContext: files_nodes_WriteContext },
) {
	const refused = [];
	for (const item of args.receipt.refused) {
		const node = await files_saved_placement_db_get_node(ctx.db, item.nodeId);
		const readable =
			node &&
			node.organizationId === args.receipt.organizationId &&
			node.workspaceId === args.receipt.workspaceId &&
			(node.path === args.receipt.path || node.path.startsWith(`${args.receipt.path}/`)) &&
			(await access_control_db_can_act_on_file_node(ctx, {
				organizationId: args.receipt.organizationId,
				workspaceId: args.receipt.workspaceId,
				subject: args.writeContext.subject,
				fileNode: node,
				permission: "content.read",
			}));
		refused.push({
			path: readable ? node.path : null,
			message:
				!readable || item.reason === "permission"
					? "Permission denied"
					: item.reason === "read_only"
						? "This item is read-only."
						: item.reason === "not_empty"
							? "This folder still holds items that could not be archived."
							: "This item changed. Try again.",
		});
	}
	return {
		requestId: args.receipt.requestId,
		archivedNodes: args.receipt.archivedNodes,
		complete: args.receipt.complete,
		refused,
	};
}

/**
 * Check the item and the direct list that removing it changes.
 */
export async function public_api_file_archives_db_check_node(
	ctx: MutationCtx,
	args: { node: Doc<"files_nodes">; writeContext: files_nodes_WriteContext },
) {
	const parent =
		args.node.parentId === files_ROOT_ID ? null : await files_saved_placement_db_get_node(ctx.db, args.node.parentId);
	if (args.node.parentId !== files_ROOT_ID && (!parent || parent.archiveOperationId !== null)) {
		return Result({ _nay: { name: "conflict", message: "The parent folder changed" } });
	}
	for (const node of [args.node, parent]) {
		if (
			!(await access_control_db_can_act_on_file_node(ctx, {
				organizationId: args.node.organizationId,
				workspaceId: args.node.workspaceId,
				subject: args.writeContext.subject,
				fileNode: node,
				permission: "content.write",
			}))
		)
			return Result({ _nay: { message: "Permission denied" } });
		if (!node) continue;
		const writable = await files_nodes_db_require_writable(ctx, {
			organizationId: node.organizationId,
			workspaceId: node.workspaceId,
			writeContext: { ...args.writeContext, resourceScope: { kind: "node", nodeId: node._id } },
			target: { kind: "node", node },
		});
		if (writable._nay) return writable;
		const busy = await files_move_reservations_db_check_node_write(ctx.db, {
			target: { kind: "saved", id: node._id },
			pendingUpdate: null,
			membership: true,
		});
		if (busy._nay) return busy;
	}
	return Result({ _yay: null });
}

/**
 * Preflight within the existing bound, then archive allowed branches in child-first order.
 */
export async function public_api_file_archives_db_archive(
	ctx: MutationCtx,
	args: {
		root: Doc<"files_nodes">;
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		writeContext: files_nodes_WriteContext;
		maxNodes: number;
		accept: (node: Doc<"files_nodes">) => Promise<{ name?: string; message: string } | null>;
	},
) {
	const scope = { organizationId: args.organizationId, workspaceId: args.workspaceId };
	for (const kind of ["move", "scope", "restore"] as const) {
		const repair = await ctx.db
			.query("files_subtree_ops")
			.withIndex("by_organization_workspace_kind_status", (q) =>
				q
					.eq("organizationId", scope.organizationId)
					.eq("workspaceId", scope.workspaceId)
					.eq("kind", kind)
					.eq("status", "running"),
			)
			.first();
		if (repair)
			return Result({ _nay: { name: "conflict", message: "A file change is still running. Try again shortly." } });
	}
	const children = (nodeId: Id<"files_nodes">) =>
		ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_parent_archiveOperation_name", (q) =>
				q
					.eq("organizationId", scope.organizationId)
					.eq("workspaceId", scope.workspaceId)
					.eq("moveCohortId", undefined)
					.eq("parentId", nodeId)
					.eq("archiveOperationId", null),
			);
	const pending = [args.root];
	const allowed: Doc<"files_nodes">[] = [];
	const refused: Receipt["refused"] = [];
	let visited = 0;
	while (pending.length) {
		const node = pending.pop()!;
		if (++visited > args.maxNodes)
			return Result({ _nay: { message: `An archive can visit at most ${args.maxNodes} files and folders` } });
		if (node.archiveOperationId !== null) continue;
		const checked = await public_api_file_archives_db_check_node(ctx, { node, writeContext: args.writeContext });
		const failure = checked._nay ?? (await args.accept(node));
		if (failure) {
			if (!args.writeContext.force) return Result({ _nay: failure });
			refused.push({
				nodeId: node._id,
				reason: failure.name === "read_only" ? "read_only" : failure.name === "conflict" ? "changed" : "permission",
			});
			continue;
		}
		allowed.push(node);
		if (node.kind === "folder") {
			const rows = await children(node._id).take(args.maxNodes - visited - pending.length + 1);
			if (rows.length + visited + pending.length > args.maxNodes)
				return Result({ _nay: { message: `An archive can visit at most ${args.maxNodes} files and folders` } });
			pending.push(...rows);
		}
	}
	const archiveOperationId = crypto.randomUUID();
	const archivedNodeIds: Id<"files_nodes">[] = [];
	for (const node of allowed.reverse()) {
		if (node.kind === "folder" && (await children(node._id).first())) {
			refused.push({ nodeId: node._id, reason: "not_empty" });
			continue;
		}
		await files_nodes_db_archive_node(ctx, {
			node,
			archiveOperationId,
			updatedBy: args.writeContext.actorUserId,
			now: Date.now(),
			savedScope: "job",
		});
		archivedNodeIds.push(node._id);
	}
	if (archivedNodeIds.length) await files_media_validation_db_advance_version(ctx, scope);
	return Result({
		_yay: { archivedNodes: archivedNodeIds.length, complete: refused.length === 0, refused, archivedNodeIds },
	});
}
