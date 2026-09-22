import { Result } from "common/errors-as-values-utils.ts";
import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { internalMutation, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import { should_never_happen } from "../shared/shared-utils.ts";
import {
	files_private_storage_db_release,
	files_private_storage_db_release_deleted_resource,
	files_private_storage_db_reserve,
} from "./files_private_storage.ts";
import {
	files_db_expire_pending_update_operation_batch,
	files_db_insert_pending_update,
	files_db_advance_pending_review_version,
	files_db_schedule_pending_update_cleanup,
} from "../server/files.ts";
import { files_transfer_db_fence_private_target } from "./files_transfer.ts";
import { access_control_db_authorize_membership } from "./access_control.ts";

// Leave room for content, permission, and review reads in the same transaction.
const MAX_PRIVATE_ANCESTORS = 256;
const MAX_DISCARD_NODES = 256;
const DRAFT_IDLE_EXPIRY_MS = 4 * 60 * 60 * 1000;
const PUBLISH_RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Resolve read links only. The caller still checks current Files access.
 *
 * Save turns a private draft into a saved node. Follow an old draft link to that saved node, so a
 * link written before Save keeps working after it.
 */
export async function files_pending_nodes_db_resolve_read_target(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		target: Doc<"files_pending_updates">["target"];
	},
) {
	if (args.target.kind === "saved") return args.target;

	// The saved node keeps this link after the short-lived publish receipt is removed.
	const privateNodeId = args.target.id;
	const saved = await ctx.db
		.query("files_nodes")
		.withIndex("by_organization_workspace_publishedFromPrivateNode", (q) =>
			q
				.eq("organizationId", args.organizationId)
				.eq("workspaceId", args.workspaceId)
				.eq("publishedFromPrivateNodeId", privateNodeId),
		)
		.first();

	if (!saved) return args.target;

	// An archived saved file is gone, so answer null instead of the old draft link.
	return saved.archiveOperationId === null ? { kind: "saved" as const, id: saved._id } : null;
}

/**
 * Resolve identity only. The caller checks the saved parent's current access and policy.
 */
export async function files_pending_nodes_db_resolve_saved_parent(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
		parent: Doc<"files_pending_nodes">["parent"];
	},
) {
	if (args.parent.kind === "root") return Result({ _yay: { parentId: "root" as const } });
	if (args.parent.kind === "saved") return Result({ _yay: { parentId: args.parent.id } });
	const node = await ctx.db.get("files_pending_nodes", args.parent.id);
	if (
		!node ||
		node.organizationId !== args.organizationId ||
		node.workspaceId !== args.workspaceId ||
		node.userId !== args.userId ||
		node.kind !== "folder"
	) {
		return Result({ _nay: { name: "not_found", message: "Not found" } });
	}
	if (node.state === "active") {
		return Result({ _nay: { name: "needs_review", message: "Save the parent folder before this move" } });
	}
	if (node.state === "discarded") {
		return Result({ _nay: { name: "target_changed", message: "The destination draft was discarded" } });
	}
	const receipt = await ctx.db
		.query("files_pending_node_publish_receipts")
		.withIndex("by_privateNode", (q) => q.eq("privateNodeId", node._id))
		.unique();
	if (!receipt) throw should_never_happen("Published private node has no receipt", { privateNodeId: node._id });
	return Result({ _yay: { parentId: receipt.savedNodeId } });
}

/**
 * Save-only exception for a copied parent's unchanged lock. It grants no editing access.
 */
export async function files_pending_nodes_db_can_save_to_copied_parent(
	ctx: QueryCtx | MutationCtx,
	args: {
		membership: Doc<"organizations_workspaces_users">;
		node: Doc<"files_pending_nodes">;
		savedParent: Doc<"files_nodes">;
	},
) {
	const { membership, node, savedParent } = args;
	if (
		!membership.active ||
		node.state !== "active" ||
		node.parent.kind !== "private" ||
		node.userId !== membership.userId ||
		node.organizationId !== membership.organizationId ||
		node.workspaceId !== membership.workspaceId ||
		savedParent.organizationId !== node.organizationId ||
		savedParent.workspaceId !== node.workspaceId ||
		savedParent.kind !== "folder" ||
		savedParent.archiveOperationId !== null
	)
		return false;
	const parent = await ctx.db.get("files_pending_nodes", node.parent.id);
	if (
		!parent ||
		parent.state !== "published" ||
		parent.kind !== "folder" ||
		parent.userId !== node.userId ||
		parent.organizationId !== node.organizationId ||
		parent.workspaceId !== node.workspaceId ||
		parent.name !== savedParent.name ||
		savedParent.publishedFromPrivateNodeId !== parent._id
	)
		return false;
	const receipt = await ctx.db
		.query("files_pending_node_publish_receipts")
		.withIndex("by_privateNode", (q) => q.eq("privateNodeId", parent._id))
		.unique();
	if (
		!receipt ||
		receipt.userId !== node.userId ||
		receipt.organizationId !== node.organizationId ||
		receipt.workspaceId !== node.workspaceId ||
		receipt.savedNodeId !== savedParent._id ||
		receipt.creationGeneration + 1 !== parent.creationGeneration ||
		receipt.structuralRevision !== parent.structuralRevision ||
		receipt.copiedWritePolicy == null ||
		receipt.copiedPath !== savedParent.path ||
		JSON.stringify(receipt.copiedWritePolicy) !== JSON.stringify(savedParent.writePolicy)
	)
		return false;
	const originalParent = await files_pending_nodes_db_resolve_saved_parent(ctx, {
		...node,
		parent: parent.parent,
	});
	if (originalParent._nay || originalParent._yay.parentId !== savedParent.parentId) return false;
	return !(
		await access_control_db_authorize_membership(ctx, {
			userAuth: { id: node.userId },
			membership,
			fileNode: savedParent,
			permission: "content.write",
		})
	)._nay;
}

/**
 * Resolve an owner's active private chain to its saved parent or the workspace root.
 * A published parent is followed through its receipt. A discarded parent hides its descendants.
 * Callers still check membership and the saved parent's current access and write policy.
 */
export async function files_pending_nodes_db_get_ancestry(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
		privateNodeId: Id<"files_pending_nodes">;
		// Owner recovery reads only. Normal path and write callers must leave this unset.
		allowArchivedParent?: true;
	},
) {
	const ancestors: Doc<"files_pending_nodes">[] = [];
	let privateNodeId = args.privateNodeId;
	let savedParentId: Id<"files_nodes"> | null = null;
	while (true) {
		const node = await ctx.db.get("files_pending_nodes", privateNodeId);
		if (
			!node ||
			node.organizationId !== args.organizationId ||
			node.workspaceId !== args.workspaceId ||
			node.userId !== args.userId
		) {
			return Result({ _nay: { name: "not_found", message: "Not found" } });
		}
		if (node.state === "discarded" || (ancestors.length === 0 && node.state === "published")) {
			return Result({ _nay: { name: "target_changed", message: "This draft is no longer active" } });
		}
		if (node.state === "published") {
			const receipt = await ctx.db
				.query("files_pending_node_publish_receipts")
				.withIndex("by_privateNode", (q) => q.eq("privateNodeId", node._id))
				.first();
			if (!receipt) {
				throw should_never_happen("Published private node has no receipt", { privateNodeId: node._id });
			}
			savedParentId = receipt.savedNodeId;
			break;
		}
		ancestors.push(node);
		if (node.parent.kind === "root") break;
		if (node.parent.kind === "saved") {
			savedParentId = node.parent.id;
			break;
		}
		if (ancestors.length === MAX_PRIVATE_ANCESTORS) {
			return Result({ _nay: { name: "too_large", message: "This draft has too many parent folders" } });
		}
		privateNodeId = node.parent.id;
	}

	const savedParent = savedParentId === null ? null : await ctx.db.get("files_nodes", savedParentId);
	if (
		savedParentId !== null &&
		(!savedParent ||
			savedParent.organizationId !== args.organizationId ||
			savedParent.workspaceId !== args.workspaceId ||
			savedParent.kind !== "folder" ||
			(savedParent.archiveOperationId !== null && !args.allowArchivedParent))
	) {
		return Result({ _nay: { name: "target_changed", message: "This draft's destination is no longer available" } });
	}

	return Result({ _yay: { node: ancestors[0]!, ancestors: ancestors.slice(1), savedParent } });
}

/**
 * Reserve a private identity and its one proposal. The caller checks the current draft path,
 * name, destination access, and policy, then seals content and schedules proposal expiry.
 */
export async function files_pending_nodes_db_create(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
		parent: Doc<"files_pending_nodes">["parent"];
		name: string;
		kind: Doc<"files_pending_nodes">["kind"];
		threadId?: Id<"ai_chat_threads">;
		preparation?: Doc<"files_pending_updates">["preparation"];
	},
) {
	if (args.parent.kind === "private") {
		const ancestry = await files_pending_nodes_db_get_ancestry(ctx, { ...args, privateNodeId: args.parent.id });
		if (ancestry._nay) return ancestry;
		if (ancestry._yay.node.kind !== "folder") {
			return Result({ _nay: { name: "not_directory", message: "The destination is not a folder" } });
		}
		if (ancestry._yay.ancestors.length + 1 >= MAX_PRIVATE_ANCESTORS) {
			return Result({ _nay: { name: "too_large", message: "This draft has too many parent folders" } });
		}
	}
	const occupant = await ctx.db
		.query("files_pending_nodes")
		.withIndex("by_organization_workspace_user_parent_state_name", (q) =>
			q
				.eq("organizationId", args.organizationId)
				.eq("workspaceId", args.workspaceId)
				.eq("userId", args.userId)
				.eq("parent.kind", args.parent.kind)
				.eq("parent.id", args.parent.kind === "root" ? undefined : args.parent.id)
				.eq("state", "active")
				.eq("name", args.name),
		)
		.first();
	if (occupant) {
		return Result({ _nay: { name: "target_changed", message: "A draft already exists at this path" } });
	}

	const privateNodeId = await ctx.db.insert("files_pending_nodes", {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		userId: args.userId,
		kind: args.kind,
		name: args.name,
		parent: args.parent,
		structuralRevision: 1,
		creationGeneration: 1,
		state: "active",
		closedAt: null,
	});
	const reservation = await files_private_storage_db_reserve(ctx, {
		...args,
		resource: { kind: "node", id: privateNodeId },
		byteCount: 0,
	});
	if (reservation._nay) {
		await ctx.db.delete("files_pending_nodes", privateNodeId);
		return reservation;
	}
	const updatedAt = Date.now();
	const pendingUpdateId = await files_db_insert_pending_update(ctx, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		userId: args.userId,
		target: { kind: "private", id: privateNodeId },
		revision: 1,
		...(args.threadId ? { threadIds: [args.threadId] } : {}),
		...(args.preparation ? { preparation: args.preparation } : {}),
		size: 0,
		updatedAt,
	});
	return Result({ _yay: { privateNodeId, pendingUpdateId, updatedAt } });
}

/**
 * Record identity publication in the same transaction as the saved node and residual proposal.
 * The caller passes docs read and checked in that transaction, after the full review preflight.
 */
export async function files_pending_nodes_db_publish(
	ctx: MutationCtx,
	args: {
		node: Doc<"files_pending_nodes">;
		pendingUpdate: Doc<"files_pending_updates">;
		savedNodeId: Id<"files_nodes">;
	},
) {
	const { node, pendingUpdate } = args;
	if (
		node.state !== "active" ||
		pendingUpdate.target.kind !== "private" ||
		pendingUpdate.target.id !== node._id ||
		pendingUpdate.organizationId !== node.organizationId ||
		pendingUpdate.workspaceId !== node.workspaceId ||
		pendingUpdate.userId !== node.userId ||
		!pendingUpdate.createIntent
	) {
		throw should_never_happen("Invalid private node publication", { privateNodeId: node._id });
	}
	const reservation = await ctx.db
		.query("files_private_storage_reservations")
		.withIndex("by_resource", (q) => q.eq("resource.kind", "node").eq("resource.id", node._id))
		.first();
	if (!reservation || reservation.settlement.kind !== "held") {
		throw should_never_happen("Private node has no storage reservation", { privateNodeId: node._id });
	}

	const now = Date.now();
	const copiedWritePolicy = node.kind === "folder" ? pendingUpdate.copiedFrom?.sourceWritePolicy : undefined;
	let copiedPath: string | undefined;
	if (copiedWritePolicy !== undefined) {
		const saved = await ctx.db.get("files_nodes", args.savedNodeId);
		if (!saved || JSON.stringify(saved.writePolicy) !== JSON.stringify(copiedWritePolicy))
			throw should_never_happen("Copied folder policy changed during publication", { privateNodeId: node._id });
		copiedPath = saved.path;
	}
	// The receipt below is deleted after a week. Store the same link on the saved node, so an old
	// private link still resolves after that.
	await ctx.db.patch("files_nodes", args.savedNodeId, { publishedFromPrivateNodeId: node._id });
	await ctx.db.insert("files_pending_node_publish_receipts", {
		organizationId: node.organizationId,
		workspaceId: node.workspaceId,
		userId: node.userId,
		privateNodeId: node._id,
		creationGeneration: node.creationGeneration,
		structuralRevision: node.structuralRevision,
		proposalRevision: pendingUpdate.revision,
		savedNodeId: args.savedNodeId,
		copiedWritePolicy,
		copiedPath,
		createdAt: now,
	});
	await ctx.db.patch("files_pending_nodes", node._id, {
		state: "published",
		creationGeneration: node.creationGeneration + 1,
		closedAt: now,
	});
	await files_private_storage_db_release(ctx, {
		reservationId: reservation._id,
		settlement: { kind: "saved", savedNodeId: args.savedNodeId, settledAt: now },
	});
}

/**
 * Close a reviewed root before paged Discard cleanup. Descendant reads check this same fence.
 * Keep its storage hold and tombstone until referring work and physical cleanup have settled.
 */
export async function files_pending_nodes_db_fence_discard(
	ctx: MutationCtx,
	node: Doc<"files_pending_nodes">,
	reason: "discard" | "expired" = "discard",
	options?: { ancestorAlreadyFenced: true },
) {
	if (node.state !== "active") return;
	if (!options?.ancestorAlreadyFenced) await files_db_advance_pending_review_version(ctx, node);
	await ctx.db.patch("files_pending_nodes", node._id, {
		state: "discarded",
		creationGeneration: node.creationGeneration + 1,
		closedAt: Date.now(),
	});
	await files_transfer_db_fence_private_target(ctx, { privateNodeId: node._id, reason });
}

/**
 * Check the complete small Discard unit before closing any private generation.
 */
export async function files_pending_nodes_db_discard(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
		privateNodeId: Id<"files_pending_nodes">;
		pendingUpdateId: Id<"files_pending_updates">;
		expectedRevision: number;
		reason?: "expired";
		reviewedProposals?: { pendingUpdateId: Id<"files_pending_updates">; revision: number }[];
	},
) {
	const root = await ctx.db.get("files_pending_nodes", args.privateNodeId);
	if (
		!root ||
		root.organizationId !== args.organizationId ||
		root.workspaceId !== args.workspaceId ||
		root.userId !== args.userId
	) {
		return Result({ _nay: { name: "not_found", message: "Not found" } });
	}
	if (root.state === "discarded") return Result({ _yay: null });
	if (root.state === "published") {
		return Result({ _nay: { name: "target_changed", message: "This draft has already been saved" } });
	}

	const rootProposal = await ctx.db.get("files_pending_updates", args.pendingUpdateId);
	if (
		!rootProposal ||
		rootProposal.userId !== args.userId ||
		rootProposal.target.kind !== "private" ||
		rootProposal.target.id !== root._id ||
		rootProposal.revision !== args.expectedRevision
	) {
		return Result({ _nay: { name: "target_changed", message: "This draft changed. Review it again" } });
	}

	const reviewed = new Map(args.reviewedProposals?.map((proposal) => [proposal.pendingUpdateId, proposal.revision]));
	reviewed.set(rootProposal._id, args.expectedRevision);
	const nodes = [root];
	const now = Date.now();
	let keepUntil = 0;

	for (const node of nodes) {
		const proposal = await ctx.db
			.query("files_pending_updates")
			.withIndex("by_organization_workspace_user_target", (q) =>
				q
					.eq("organizationId", args.organizationId)
					.eq("workspaceId", args.workspaceId)
					.eq("userId", args.userId)
					.eq("target.kind", "private")
					.eq("target.id", node._id),
			)
			.unique();
		if (!proposal) throw should_never_happen("Active private node has no proposal", { privateNodeId: node._id });

		if (args.reason === "expired") {
			keepUntil = Math.max(keepUntil, proposal.updatedAt + DRAFT_IDLE_EXPIRY_MS);
		} else if (reviewed.has(proposal._id)) {
			if (reviewed.get(proposal._id) !== proposal.revision) {
				return Result({ _nay: { name: "target_changed", message: "A child draft changed. Review it again" } });
			}
		} else if (
			(proposal.createIntent && (proposal.createIntent.kind !== "text" || proposal.content)) ||
			proposal.threadIds?.some((threadId) => !rootProposal.threadIds?.includes(threadId))
		) {
			return Result({
				_nay: { name: "needs_review", message: "Review the child drafts before discarding this folder" },
			});
		}

		const dependent = await ctx.db
			.query("files_pending_updates")
			.withIndex("by_pendingMove_destParent", (q) =>
				q.eq("pendingMove.destParent.kind", "private").eq("pendingMove.destParent.id", node._id),
			)
			.first();
		if (dependent) {
			if (args.reason !== "expired") {
				return Result({
					_nay: { name: "needs_review", message: "Review the moves into this folder before discarding it" },
				});
			}
			await files_db_schedule_pending_update_cleanup(ctx, {
				pendingUpdateId: rootProposal._id,
				expectedUpdatedAt: rootProposal.updatedAt,
				expiresAt: keepUntil,
				delayMs: 60_000,
			});
			return Result({ _yay: null });
		}
		const children = await ctx.db
			.query("files_pending_nodes")
			.withIndex("by_organization_workspace_user_parent_state_name", (q) =>
				q
					.eq("organizationId", args.organizationId)
					.eq("workspaceId", args.workspaceId)
					.eq("userId", args.userId)
					.eq("parent.kind", "private")
					.eq("parent.id", node._id)
					.eq("state", "active"),
			)
			.take(args.reason === "expired" ? 1 : MAX_DISCARD_NODES - nodes.length + 1);
		if (args.reason === "expired" && children.length > 0) {
			// Children expire through their own callbacks. One live child protects every ancestor.
			await files_db_schedule_pending_update_cleanup(ctx, {
				pendingUpdateId: rootProposal._id,
				expectedUpdatedAt: rootProposal.updatedAt,
				expiresAt: keepUntil,
				delayMs: 60_000,
			});
			return Result({ _yay: null });
		}
		if (nodes.length + children.length > MAX_DISCARD_NODES) {
			return Result({ _nay: { name: "needs_review", message: "Use bulk Discard to review this larger folder" } });
		}
		nodes.push(...children);
	}
	if (args.reason === "expired" && keepUntil > now) {
		await files_db_schedule_pending_update_cleanup(ctx, {
			pendingUpdateId: rootProposal._id,
			expectedUpdatedAt: rootProposal.updatedAt,
			expiresAt: keepUntil,
		});
		return Result({ _yay: null });
	}

	for (const node of nodes) {
		await files_pending_nodes_db_fence_discard(ctx, node, args.reason ?? "discard");
		const cleanupTaskId = await ctx.db.insert("files_pending_node_cleanup_tasks", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			privateNodeId: node._id,
			nextAttemptAt: now,
		});
		await ctx.scheduler.runAfter(0, internal.files_pending_nodes.cleanup_discarded_node, { cleanupTaskId });
	}
	return Result({ _yay: null });
}

/**
 * Remove one proposal, then wait for its owned payloads and children to finish cleanup.
 */
export const cleanup_discarded_node = internalMutation({
	args: { cleanupTaskId: v.id("files_pending_node_cleanup_tasks") },
	returns: v.null(),
	handler: async (ctx, args) => {
		const task = await ctx.db.get("files_pending_node_cleanup_tasks", args.cleanupTaskId);
		if (!task) return null;

		const node = await ctx.db.get("files_pending_nodes", task.privateNodeId);
		if (!node) {
			await ctx.db.delete("files_pending_node_cleanup_tasks", task._id);
			return null;
		}
		if (node.state !== "discarded") {
			throw should_never_happen("Private cleanup target is not discarded", { privateNodeId: node._id });
		}

		// The approved root fence already hid these children. Closing them is physical cleanup.
		const activeChildren = await ctx.db
			.query("files_pending_nodes")
			.withIndex("by_organization_workspace_user_parent_state_name", (q) =>
				q
					.eq("organizationId", node.organizationId)
					.eq("workspaceId", node.workspaceId)
					.eq("userId", node.userId)
					.eq("parent.kind", "private")
					.eq("parent.id", node._id)
					.eq("state", "active"),
			)
			.take(16);

		for (const child of activeChildren) {
			await files_pending_nodes_db_fence_discard(ctx, child, "discard", { ancestorAlreadyFenced: true });
			const cleanupTaskId = await ctx.db.insert("files_pending_node_cleanup_tasks", {
				organizationId: child.organizationId,
				workspaceId: child.workspaceId,
				userId: child.userId,
				privateNodeId: child._id,
				nextAttemptAt: Date.now(),
			});
			await ctx.scheduler.runAfter(0, internal.files_pending_nodes.cleanup_discarded_node, { cleanupTaskId });
		}

		await ctx.runMutation(internal.files_pending_updates.remove_fenced_private_pending_update, {
			privateNodeId: node._id,
		});

		const batches = await ctx.db
			.query("files_pending_update_operation_batches")
			.withIndex("by_organization_workspace_user_target", (q) =>
				q
					.eq("organizationId", node.organizationId)
					.eq("workspaceId", node.workspaceId)
					.eq("userId", node.userId)
					.eq("target.kind", "private")
					.eq("target.id", node._id),
			)
			.take(1);
		if (batches[0] && batches[0].expiresAt !== 0) {
			await files_db_expire_pending_update_operation_batch(ctx, { operationBatchId: batches[0]._id });
		}

		const state = await ctx.db
			.query("files_pending_update_yjs_states")
			.withIndex("by_organization_workspace_target", (q) =>
				q
					.eq("organizationId", node.organizationId)
					.eq("workspaceId", node.workspaceId)
					.eq("target.kind", "private")
					.eq("target.id", node._id),
			)
			// A sealed transfer capture owns its bytes even after the source draft is gone.
			.filter((q) => q.neq(q.field("owner.kind"), "transfer_capture"))
			.first();
		const transferItem = await ctx.db
			.query("files_transfer_items")
			.withIndex("by_preparation_privateNode", (q) => q.eq("preparation.privateNodeId", node._id))
			.first();
		const child = await ctx.db
			.query("files_pending_nodes")
			.withIndex("by_organization_workspace_user_parent_state_name", (q) =>
				q
					.eq("organizationId", node.organizationId)
					.eq("workspaceId", node.workspaceId)
					.eq("userId", node.userId)
					.eq("parent.kind", "private")
					.eq("parent.id", node._id)
					.eq("state", "discarded"),
			)
			.first();

		if (activeChildren.length > 0 || batches.length > 0 || state || child || transferItem?.workId) {
			await ctx.db.patch("files_pending_node_cleanup_tasks", task._id, { nextAttemptAt: Date.now() + 60_000 });
			await ctx.scheduler.runAfter(60_000, internal.files_pending_nodes.cleanup_discarded_node, args);
			return null;
		}

		await ctx.db.delete("files_pending_nodes", node._id);
		await files_private_storage_db_release_deleted_resource(ctx, { kind: "node", id: node._id });
		await ctx.db.delete("files_pending_node_cleanup_tasks", task._id);
		return null;
	},
});

export const recover_discarded_node_cleanup = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const tasks = await ctx.db
			.query("files_pending_node_cleanup_tasks")
			.withIndex("by_nextAttemptAt", (q) => q.lte("nextAttemptAt", Date.now()))
			.take(32);
		for (const task of tasks) {
			await ctx.db.patch("files_pending_node_cleanup_tasks", task._id, { nextAttemptAt: Date.now() + 60_000 });
			await ctx.scheduler.runAfter(0, internal.files_pending_nodes.cleanup_discarded_node, { cleanupTaskId: task._id });
		}
		if (tasks.length === 32)
			await ctx.scheduler.runAfter(0, internal.files_pending_nodes.recover_discarded_node_cleanup, {});
		return null;
	},
});

/**
 * Keep identity links while durable work still names the old private target.
 */
export const cleanup_published_nodes = internalMutation({
	args: { cursor: v.optional(paginationOptsValidator.fields.cursor) },
	returns: v.null(),
	handler: async (ctx, args) => {
		const page = await ctx.db
			.query("files_pending_nodes")
			.withIndex("by_state_closedAt", (q) =>
				q.eq("state", "published").lte("closedAt", Date.now() - PUBLISH_RECEIPT_RETENTION_MS),
			)
			.paginate({ cursor: args.cursor ?? null, numItems: 32 });

		for (const node of page.page) {
			const references = await Promise.all([
				ctx.db
					.query("files_pending_nodes")
					.withIndex("by_organization_workspace_user_parent_state_name", (q) =>
						q
							.eq("organizationId", node.organizationId)
							.eq("workspaceId", node.workspaceId)
							.eq("userId", node.userId)
							.eq("parent.kind", "private")
							.eq("parent.id", node._id),
					)
					.first(),
				ctx.db
					.query("files_pending_updates")
					.withIndex("by_target", (q) => q.eq("target.kind", "private").eq("target.id", node._id))
					.first(),
				ctx.db
					.query("files_pending_updates")
					.withIndex("by_pendingMove_destParent", (q) =>
						q.eq("pendingMove.destParent.kind", "private").eq("pendingMove.destParent.id", node._id),
					)
					.first(),
				ctx.db
					.query("files_pending_updates")
					.withIndex("by_copiedFrom_target", (q) =>
						q.eq("copiedFrom.target.kind", "private").eq("copiedFrom.target.id", node._id),
					)
					.first(),
				// Retired sets still need the alias until their dependencies are drained.
				ctx.db
					.query("files_media_dependencies")
					.withIndex("by_target", (q) => q.eq("dependency.target.kind", "private").eq("dependency.target.id", node._id))
					.first(),
				ctx.db
					.query("files_pending_update_operation_batches")
					.withIndex("by_organization_workspace_user_target", (q) =>
						q
							.eq("organizationId", node.organizationId)
							.eq("workspaceId", node.workspaceId)
							.eq("userId", node.userId)
							.eq("target.kind", "private")
							.eq("target.id", node._id),
					)
					.first(),
				ctx.db
					.query("files_pending_update_yjs_states")
					.withIndex("by_organization_workspace_target", (q) =>
						q
							.eq("organizationId", node.organizationId)
							.eq("workspaceId", node.workspaceId)
							.eq("target.kind", "private")
							.eq("target.id", node._id),
					)
					.first(),
				ctx.db
					.query("files_pending_update_run_items")
					.withIndex("by_target", (q) => q.eq("target.kind", "private").eq("target.id", node._id))
					.first(),
				ctx.db
					.query("files_transfer_items")
					.withIndex("by_source", (q) => q.eq("source.kind", "private").eq("source.id", node._id))
					.first(),
				ctx.db
					.query("files_transfer_items")
					.withIndex("by_sourceParent", (q) => q.eq("sourceParent.kind", "private").eq("sourceParent.id", node._id))
					.first(),
				ctx.db
					.query("files_transfer_items")
					.withIndex("by_outputTarget", (q) => q.eq("outputTarget.kind", "private").eq("outputTarget.id", node._id))
					.first(),
				ctx.db
					.query("files_transfer_items")
					.withIndex("by_preparation_privateNode", (q) => q.eq("preparation.privateNodeId", node._id))
					.first(),
				ctx.db
					.query("files_transfer_runs")
					.withIndex("by_targetParent", (q) => q.eq("targetParent.kind", "private").eq("targetParent.id", node._id))
					.first(),
				ctx.db
					.query("files_transfer_runs")
					.withIndex("by_preparedParent", (q) =>
						q.eq("preparedParent.kind", "private").eq("preparedParent.id", node._id),
					)
					.first(),
				// Several shells can share one folder; any live shell keeps the node.
				ctx.db
					.query("ai_chat_bash_shells")
					.withIndex("by_cwdTarget", (q) => q.eq("cwdTarget.kind", "private").eq("cwdTarget.id", node._id))
					.first(),
			]);
			if (references.some((reference) => reference !== null)) continue;

			const receipt = await ctx.db
				.query("files_pending_node_publish_receipts")
				.withIndex("by_privateNode", (q) => q.eq("privateNodeId", node._id))
				.unique();
			if (!receipt) throw should_never_happen("Published private node has no receipt", { privateNodeId: node._id });

			await ctx.db.delete("files_pending_node_publish_receipts", receipt._id);
			await ctx.db.delete("files_pending_nodes", node._id);
		}

		if (!page.isDone)
			await ctx.scheduler.runAfter(0, internal.files_pending_nodes.cleanup_published_nodes, {
				cursor: page.continueCursor,
			});

		return null;
	},
});
