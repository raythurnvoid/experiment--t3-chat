// Producer bytes enter normal Files through one receipt per output item. Stored bytes upload
// between prepare and finalize. Text uses the existing private initial batch and sealed states.
// Completed receipts only deduplicate retries; the file owns its own lifetime after commit.

import { Result } from "common/errors-as-values-utils.ts";
import { v, type Infer } from "convex/values";
import { doc } from "convex-helpers/validators";
import type { Doc, Id } from "./_generated/dataModel.js";
import { internal } from "./_generated/api.js";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import { convex_error, v_result } from "../server/convex-utils.ts";
import { files_db_expire_pending_update_operation_batch, files_db_get_pending_update } from "../server/files.ts";
import { files_editable_text_shape_of, files_normalize_content_type } from "../shared/files.ts";
import { should_never_happen } from "../shared/shared-utils.ts";
import { billing_db_check_paid_plan, billing_pick_billed_user_id } from "./billing_db.ts";
import { organizations_db_get_membership } from "./organizations.ts";
import { files_nodes_db_create_private_node_by_path, files_nodes_db_plan_private_node_by_path } from "./files_nodes.ts";
import { files_pending_nodes_db_discard, files_pending_nodes_db_resolve_read_target } from "./files_pending_nodes.ts";
import { files_pending_updates_db_commit_private_file } from "./files_pending_updates.ts";
import { files_private_storage_db_reserve } from "./files_private_storage.ts";
import { files_visible_db_create_reader } from "./files_visible.ts";
import app_convex_schema, {
	files_pending_target_validator,
	files_pending_updates_state_family_validator,
} from "./schema.ts";
import { r2, r2_create_asset_key, r2_enqueue_object_deletion_job, r2_PUT_MAY_ARRIVE_MARGIN_MS } from "./r2_client.ts";

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const PREPARING_TTL_MS = 30 * 60 * 1000;
const RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;
const CLEANUP_BATCH_SIZE = 8;

export const files_ingestion_scope_validator = v.object({
	membershipId: v.id("organizations_workspaces_users"),
	userId: v.id("users"),
	organizationId: v.id("organizations"),
	workspaceId: v.id("organizations_workspaces"),
});

const files_ingestion_content_validator = doc(app_convex_schema, "files_ingestion_receipts").fields.content;

export const files_ingestion_file_validator = v.object({
	target: files_pending_target_validator,
	path: v.string(),
	size: v.number(),
	contentType: v.string(),
});

export const files_ingestion_prepare_args_validator = v.object({
	...files_ingestion_scope_validator.fields,
	requestId: v.string(),
	attemptId: v.string(),
	path: v.string(),
	contentType: v.string(),
	size: v.number(),
	digest: v.string(),
	content: files_ingestion_content_validator,
	threadId: v.optional(v.id("ai_chat_threads")),
});

export const files_ingestion_prepare_result_validator = v.union(
	v.object({ kind: v.literal("completed"), file: files_ingestion_file_validator }),
	v.object({
		kind: v.literal("stored"),
		receiptId: v.id("files_ingestion_receipts"),
		assetId: v.id("files_r2_assets"),
		r2Key: v.string(),
	}),
	v.object({
		kind: v.literal("text"),
		receiptId: v.id("files_ingestion_receipts"),
		target: files_pending_target_validator,
		pendingUpdateId: v.id("files_pending_updates"),
		operationBatchId: v.id("files_pending_update_operation_batches"),
		expectedRevision: v.number(),
		textKind: v.union(v.literal("plain_text"), v.literal("rich_text")),
	}),
);

export const files_ingestion_finalize_args_validator = v.object({
	...files_ingestion_scope_validator.fields,
	receiptId: v.id("files_ingestion_receipts"),
	attemptId: v.string(),
	text: v.optional(v.object({ family: files_pending_updates_state_family_validator, unstagedText: v.string() })),
});

async function authorize_scope(ctx: QueryCtx | MutationCtx, args: Infer<typeof files_ingestion_scope_validator>) {
	const user = await ctx.db.get("users", args.userId);
	if (!user || user.deletedAt !== undefined) return Result({ _nay: { message: "Unauthenticated" } });
	const membership = await organizations_db_get_membership(ctx, args);
	if (!membership || membership.organizationId !== args.organizationId || membership.workspaceId !== args.workspaceId)
		return Result({ _nay: { message: "Unauthorized" } });
	const workspace = await ctx.db.get("organizations_workspaces", args.workspaceId);
	if (
		!workspace ||
		workspace.organizationId !== args.organizationId ||
		workspace.pluginDataPurgeStartedAt !== undefined
	)
		return Result({ _nay: { message: "Unauthorized" } });
	return Result({ _yay: membership });
}

async function authorize_write(ctx: MutationCtx, args: Infer<typeof files_ingestion_scope_validator>) {
	const authorized = await authorize_scope(ctx, args);
	if (authorized._nay) return authorized;
	const organization = await ctx.db.get("organizations", args.organizationId);
	if (!organization) return Result({ _nay: { message: "Unauthorized" } });
	const billedUserId = billing_pick_billed_user_id({ userId: args.userId, organization });
	if (!(await billing_db_check_paid_plan(ctx, { userId: billedUserId })).hasPaidPlan)
		return Result({ _nay: { message: "This workspace's plan does not include file uploads" } });
	return authorized;
}

async function read_completed_file(ctx: QueryCtx | MutationCtx, receipt: Doc<"files_ingestion_receipts">) {
	if (receipt.state.kind !== "completed") return Result({ _nay: { message: "File unavailable" } });
	const target = await files_pending_nodes_db_resolve_read_target(ctx, { ...receipt, target: receipt.state.target });
	if (!target) return Result({ _nay: { message: "File unavailable" } });
	const reader = await files_visible_db_create_reader(ctx, { ...receipt, readLimit: 2048 });
	const resolved = await reader.resolve(target);
	if (!resolved || !(await reader.canRead(resolved.accessNode)))
		return Result({ _nay: { message: "File unavailable" } });

	const { entry } = resolved;
	const pending = entry.pendingUpdate;
	if (entry.node.kind !== "file" || pending?.preparation) return Result({ _nay: { message: "File unavailable" } });
	const contentType =
		pending?.pendingReplacement?.contentType ??
		(pending?.createIntent?.kind === "text" || pending?.createIntent?.kind === "stored"
			? pending.createIntent.contentType
			: null) ??
		(entry.kind === "saved" ? entry.node.contentType : null);
	if (!contentType) return Result({ _nay: { message: "File unavailable" } });
	let size = pending?.pendingReplacement?.size ?? (pending?.content || pending?.createIntent ? pending.size : null);
	if (size === null) {
		const asset =
			entry.kind === "saved" && entry.node.assetId ? await ctx.db.get("files_r2_assets", entry.node.assetId) : null;
		if (!asset) return Result({ _nay: { message: "File unavailable" } });
		size = asset.size;
	}

	return Result({ _yay: { target, path: entry.path, size, contentType } });
}

/**
 * Retire only the receipt's unfinished resources. A newer draft or a reused parent survives.
 *
 * Physical cleanup and quota settlement stay with the existing durable cleanup jobs.
 */
async function retire_preparation(ctx: MutationCtx, receipt: Doc<"files_ingestion_receipts">) {
	if (receipt.state.kind !== "preparing") return;
	const prepared = receipt.state.prepared;
	if (prepared.kind === "stored") {
		await r2_enqueue_object_deletion_job(ctx, {
			organizationId: receipt.organizationId,
			workspaceId: receipt.workspaceId,
			r2Key: prepared.r2Key,
			reason: "failed_create",
			putMayArriveUntil: prepared.putMayArriveUntil,
		});
		if (await ctx.db.get("files_r2_assets", prepared.assetId)) await ctx.db.delete("files_r2_assets", prepared.assetId);
		return;
	}

	await files_db_expire_pending_update_operation_batch(ctx, { operationBatchId: prepared.operationBatchId });
	for (const original of prepared.createdNodes.toReversed()) {
		const node = await ctx.db.get("files_pending_nodes", original.privateNodeId);
		const proposal = await ctx.db.get("files_pending_updates", original.pendingUpdateId);
		if (
			!node ||
			node.state !== "active" ||
			node.creationGeneration !== original.creationGeneration ||
			node.structuralRevision !== original.structuralRevision ||
			!proposal ||
			proposal.revision !== original.revision
		)
			continue;

		// A new edit batch may have taken over without committing its next proposal yet.
		const otherBatch = await ctx.db
			.query("files_pending_update_operation_batches")
			.withIndex("by_organization_workspace_user_target", (q) =>
				q
					.eq("organizationId", receipt.organizationId)
					.eq("workspaceId", receipt.workspaceId)
					.eq("userId", receipt.userId)
					.eq("target.kind", "private")
					.eq("target.id", node._id),
			)
			.filter((q) => q.and(q.neq(q.field("_id"), prepared.operationBatchId), q.gt(q.field("expiresAt"), Date.now())))
			.first();
		if (otherBatch) continue;
		const child = await ctx.db
			.query("files_pending_nodes")
			.withIndex("by_organization_workspace_user_parent_state_name", (q) =>
				q
					.eq("organizationId", receipt.organizationId)
					.eq("workspaceId", receipt.workspaceId)
					.eq("userId", receipt.userId)
					.eq("parent.kind", "private")
					.eq("parent.id", node._id)
					.eq("state", "active"),
			)
			.first();
		if (child) continue;
		const discarded = await files_pending_nodes_db_discard(ctx, {
			...receipt,
			privateNodeId: node._id,
			pendingUpdateId: proposal._id,
			expectedRevision: original.revision,
		});
		// `needs_review` means this folder is no longer safe to remove on its own. Another draft may
		// have moved into it, a child draft may need review, or it may hold too many drafts for one
		// Discard. Leave it alone in those cases. Its own idle expiry deletes it later.
		if (discarded._nay && discarded._nay.name !== "needs_review") throw convex_error(discarded._nay);
	}
}

export async function files_ingestion_db_delete_receipt(ctx: MutationCtx, receipt: Doc<"files_ingestion_receipts">) {
	await retire_preparation(ctx, receipt);
	await ctx.db.delete("files_ingestion_receipts", receipt._id);
}

function prepared_result(receipt: Doc<"files_ingestion_receipts">) {
	if (receipt.state.kind !== "preparing")
		throw should_never_happen("Ingestion receipt is not preparing", { receiptId: receipt._id });
	const prepared = receipt.state.prepared;
	if (prepared.kind === "stored")
		return { kind: "stored" as const, receiptId: receipt._id, assetId: prepared.assetId, r2Key: prepared.r2Key };
	if (receipt.content.kind !== "text")
		throw should_never_happen("Text ingestion receipt has no text shape", { receiptId: receipt._id });
	return {
		kind: "text" as const,
		receiptId: receipt._id,
		target: { kind: "private" as const, id: prepared.privateNodeId },
		pendingUpdateId: prepared.pendingUpdateId,
		operationBatchId: prepared.operationBatchId,
		expectedRevision: prepared.expectedRevision,
		textKind: receipt.content.textKind,
	};
}

/**
 * Start one file: check the request, reserve its R2 asset or create its private text draft, and
 * record a receipt for it.
 *
 * `requestId` makes a retry safe. The same request and attempt get the same prepared resources
 * back, and another attempt is refused instead of taking them over.
 *
 * `beforeCreate` is the caller's own gate, such as the chat's Agent-mode check. It runs after the
 * checks above and before the first write, and it never runs for a request that already completed.
 */
export async function files_ingestion_db_prepare_file(
	ctx: MutationCtx,
	args: Infer<typeof files_ingestion_scope_validator> & {
		requestId: string;
		attemptId: string;
		path: string;
		contentType: string;
		size: number;
		digest: string;
		content: Infer<typeof files_ingestion_content_validator>;
		threadId?: Id<"ai_chat_threads">;
	},
	beforeCreate?: () => Promise<{ _nay?: { message: string } }>,
) {
	if (
		!args.requestId ||
		args.requestId.length > 128 ||
		!args.attemptId ||
		args.attemptId.length > 128 ||
		!Number.isSafeInteger(args.size) ||
		args.size < 0 ||
		args.size > MAX_FILE_BYTES ||
		!/^[a-f0-9]{64}$/.test(args.digest) ||
		args.contentType.length > 255 ||
		files_normalize_content_type(args.contentType) !== args.contentType
	)
		return Result({ _nay: { message: "Invalid file request" } });

	if (
		args.content.kind === "text" &&
		files_editable_text_shape_of(args.contentType)?.rootKind !== args.content.textKind
	)
		return Result({ _nay: { message: "Invalid text content type" } });

	const authorized = await authorize_scope(ctx, args);
	if (authorized._nay) return authorized;

	const existing = await ctx.db
		.query("files_ingestion_receipts")
		.withIndex("by_organization_workspace_user_request", (q) =>
			q
				.eq("organizationId", args.organizationId)
				.eq("workspaceId", args.workspaceId)
				.eq("userId", args.userId)
				.eq("requestId", args.requestId),
		)
		.first();
	if (existing) {
		if (
			existing.path !== args.path ||
			existing.contentType !== args.contentType ||
			existing.size !== args.size ||
			existing.digest !== args.digest ||
			existing.content.kind !== args.content.kind ||
			(existing.content.kind === "text" &&
				args.content.kind === "text" &&
				existing.content.textKind !== args.content.textKind)
		)
			return Result({ _nay: { message: "This file request already describes different content" } });
		if (existing.expiresAt <= Date.now()) return Result({ _nay: { message: "This file request has expired" } });
		if (existing.state.kind === "aborted") return Result({ _nay: { message: "This file request was aborted" } });
		if (existing.state.kind === "completed") {
			const current = await read_completed_file(ctx, existing);
			return current._nay ? current : Result({ _yay: { kind: "completed" as const, file: current._yay } });
		}
		if (existing.state.attemptId !== args.attemptId)
			return Result({ _nay: { name: "in_progress", message: "This file request is already in progress" } });
		return Result({ _yay: prepared_result(existing) });
	}

	const writable = await authorize_write(ctx, args);
	if (writable._nay) return writable;

	if (beforeCreate) {
		const checked = await beforeCreate();
		if (checked._nay) return Result({ _nay: checked._nay });
	}

	const planned = await files_nodes_db_plan_private_node_by_path(ctx, { ...args, kind: "file", uniqueName: true });
	if (planned._nay) return planned;

	const now = Date.now();
	let prepared: Extract<Doc<"files_ingestion_receipts">["state"], { kind: "preparing" }>["prepared"];
	if (args.content.kind === "stored") {
		// The action gets 25 minutes to PUT the bytes. Adding the five-minute margin lands exactly on
		// the `unfinalizedExpiresAt` below, so the R2 cleanup never deletes an object while a PUT
		// that started inside the window can still arrive.
		const putMayArriveUntil = now + 25 * 60 * 1000 + r2_PUT_MAY_ARRIVE_MARGIN_MS;
		const assetId = await ctx.db.insert("files_r2_assets", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			createdBy: args.userId,
			kind: "content",
			r2Bucket: r2.config.bucket,
			size: args.size,
			unfinalizedExpiresAt: now + PREPARING_TTL_MS,
			putMayArriveUntil,
			updatedAt: now,
		});
		const r2Key = r2_create_asset_key({ ...args, assetId });
		const held = await files_private_storage_db_reserve(ctx, {
			...args,
			resource: { kind: "asset", id: assetId, r2Key },
			byteCount: args.size,
		});
		if (held._nay) throw convex_error(held._nay);
		prepared = { kind: "stored", assetId, r2Key, putMayArriveUntil };
	} else {
		const created = await files_nodes_db_create_private_node_by_path(ctx, {
			...args,
			kind: "file",
			content: { ...args.content, contentType: args.contentType },
		});
		if (created._nay) throw convex_error(created._nay);
		if (created._yay.target.kind !== "private" || !created._yay.pendingUpdateId || !created._yay.operationBatchId)
			throw should_never_happen("Text ingestion did not create an initial batch", { requestId: args.requestId });
		const createdNodes = [];
		for (const privateNodeId of created._yay.createdNodeIds) {
			const node = await ctx.db.get("files_pending_nodes", privateNodeId);
			const proposal = await files_db_get_pending_update(ctx, {
				...args,
				target: { kind: "private", id: privateNodeId },
			});
			if (!node || !proposal) throw should_never_happen("Created private node has no proposal", { privateNodeId });
			createdNodes.push({
				privateNodeId,
				pendingUpdateId: proposal._id,
				revision: proposal.revision,
				creationGeneration: node.creationGeneration,
				structuralRevision: node.structuralRevision,
			});
		}
		prepared = {
			kind: "text",
			privateNodeId: created._yay.target.id,
			pendingUpdateId: created._yay.pendingUpdateId,
			operationBatchId: created._yay.operationBatchId,
			expectedRevision: 1,
			createdNodes,
		};
	}

	const receiptId = await ctx.db.insert("files_ingestion_receipts", {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		userId: args.userId,
		requestId: args.requestId,
		path: args.path,
		contentType: args.contentType,
		size: args.size,
		digest: args.digest,
		content: args.content,
		...(args.threadId ? { threadId: args.threadId } : {}),
		state: { kind: "preparing", attemptId: args.attemptId, prepared },
		createdAt: now,
		expiresAt: now + PREPARING_TTL_MS,
	});
	const receipt = await ctx.db.get("files_ingestion_receipts", receiptId);
	if (!receipt) throw should_never_happen("Created ingestion receipt is missing", { receiptId });
	return Result({ _yay: prepared_result(receipt) });
}

export const prepare_file = internalMutation({
	args: files_ingestion_prepare_args_validator,
	returns: v_result({ _yay: files_ingestion_prepare_result_validator }),
	handler: files_ingestion_db_prepare_file,
});

export const get_text_preparation = internalQuery({
	args: {
		...files_ingestion_scope_validator.fields,
		receiptId: v.id("files_ingestion_receipts"),
		attemptId: v.string(),
	},
	returns: v_result({ _yay: v.object({ operationBatchId: v.id("files_pending_update_operation_batches") }) }),
	handler: async (ctx, args) => {
		const authorized = await authorize_scope(ctx, args);
		if (authorized._nay) return authorized;
		const receipt = await ctx.db.get("files_ingestion_receipts", args.receiptId);
		if (
			!receipt ||
			receipt.organizationId !== args.organizationId ||
			receipt.workspaceId !== args.workspaceId ||
			receipt.userId !== args.userId ||
			receipt.expiresAt <= Date.now() ||
			receipt.state.kind !== "preparing" ||
			receipt.state.attemptId !== args.attemptId ||
			receipt.state.prepared.kind !== "text"
		)
			return Result({ _nay: { message: "File preparation unavailable" } });
		const batch = await ctx.db.get("files_pending_update_operation_batches", receipt.state.prepared.operationBatchId);
		if (!batch || batch.expiresAt <= Date.now()) return Result({ _nay: { message: "File preparation unavailable" } });
		return Result({ _yay: { operationBatchId: batch._id } });
	},
});

/**
 * Finish one file: attach its uploaded bytes or commit its staged text, and complete the receipt
 * in the same transaction.
 *
 * A lost reply cannot create a second file. The second call finds the completed receipt and reads
 * back the file the first call created.
 *
 * `beforeCreate` is the caller's own gate, the same one `files_ingestion_db_prepare_file` takes.
 */
export async function files_ingestion_db_finalize_file(
	ctx: MutationCtx,
	args: Infer<typeof files_ingestion_scope_validator> & {
		receiptId: Id<"files_ingestion_receipts">;
		attemptId: string;
		text?: { family: Infer<typeof files_pending_updates_state_family_validator>; unstagedText: string };
	},
	beforeCreate?: () => Promise<{ _nay?: { message: string } }>,
) {
	const authorized = await authorize_scope(ctx, args);
	if (authorized._nay) return authorized;

	const receipt = await ctx.db.get("files_ingestion_receipts", args.receiptId);
	if (
		!receipt ||
		receipt.organizationId !== args.organizationId ||
		receipt.workspaceId !== args.workspaceId ||
		receipt.userId !== args.userId
	)
		return Result({ _nay: { message: "File unavailable" } });

	if (receipt.expiresAt <= Date.now()) return Result({ _nay: { message: "This file request has expired" } });
	if (receipt.state.kind === "completed") return read_completed_file(ctx, receipt);
	if (receipt.state.kind === "aborted") return Result({ _nay: { message: "This file request was aborted" } });
	if (receipt.state.attemptId !== args.attemptId)
		return Result({ _nay: { message: "This file request belongs to another attempt" } });

	const writable = await authorize_write(ctx, args);
	if (writable._nay) return writable;

	if (beforeCreate) {
		const checked = await beforeCreate();
		if (checked._nay) return Result({ _nay: checked._nay });
	}

	const prepared = receipt.state.prepared;
	let target: Infer<typeof files_pending_target_validator>;
	if (prepared.kind === "stored") {
		const asset = await ctx.db.get("files_r2_assets", prepared.assetId);
		const hold = await ctx.db
			.query("files_private_storage_reservations")
			.withIndex("by_resource", (q) => q.eq("resource.kind", "asset").eq("resource.id", prepared.assetId))
			.first();
		if (
			!asset ||
			asset.organizationId !== receipt.organizationId ||
			asset.workspaceId !== receipt.workspaceId ||
			asset.createdBy !== receipt.userId ||
			asset.kind !== "content" ||
			asset.size !== receipt.size ||
			asset.uploadRetiredAt !== undefined ||
			!asset.unfinalizedExpiresAt ||
			asset.unfinalizedExpiresAt <= Date.now() ||
			!hold ||
			hold.settlement.kind !== "held" ||
			hold.userId !== receipt.userId ||
			hold.organizationId !== receipt.organizationId ||
			hold.workspaceId !== receipt.workspaceId ||
			hold.byteCount !== receipt.size ||
			hold.resource.kind !== "asset" ||
			hold.resource.r2Key !== prepared.r2Key
		)
			return Result({ _nay: { message: "File preparation unavailable" } });
		const created = await files_nodes_db_create_private_node_by_path(ctx, {
			...receipt,
			kind: "file",
			content: { kind: "stored", assetId: prepared.assetId, size: receipt.size, contentType: receipt.contentType },
		});
		if (created._nay) return created;
		target = created._yay.target;
		await ctx.db.patch("files_r2_assets", prepared.assetId, {
			r2Key: prepared.r2Key,
			unfinalizedExpiresAt: undefined,
			updatedAt: Date.now(),
		});
	} else {
		if (!args.text || args.text.family.operationBatchId !== prepared.operationBatchId)
			return Result({ _nay: { message: "Text preparation unavailable" } });
		const committed = await files_pending_updates_db_commit_private_file(ctx, {
			membershipId: args.membershipId,
			privateNodeId: prepared.privateNodeId,
			pendingUpdateId: prepared.pendingUpdateId,
			expectedRevision: prepared.expectedRevision,
			family: args.text.family,
			unstagedText: args.text.unstagedText,
			threadId: receipt.threadId,
		});
		if (committed._nay) return committed;
		target = { kind: "private", id: prepared.privateNodeId };
	}

	await ctx.db.patch("files_ingestion_receipts", receipt._id, {
		state: { kind: "completed", target },
		expiresAt: Date.now() + RECEIPT_TTL_MS,
	});

	const completed = { ...receipt, state: { kind: "completed" as const, target } };
	const current = await read_completed_file(ctx, completed);
	if (current._nay) throw convex_error(current._nay);
	return current;
}

export const finalize_file = internalMutation({
	args: files_ingestion_finalize_args_validator,
	returns: v_result({ _yay: files_ingestion_file_validator }),
	handler: files_ingestion_db_finalize_file,
});

export const abort_file = internalMutation({
	args: {
		userId: v.id("users"),
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		receiptId: v.id("files_ingestion_receipts"),
		attemptId: v.string(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const receipt = await ctx.db.get("files_ingestion_receipts", args.receiptId);
		if (
			!receipt ||
			receipt.organizationId !== args.organizationId ||
			receipt.workspaceId !== args.workspaceId ||
			receipt.userId !== args.userId ||
			receipt.state.kind !== "preparing" ||
			receipt.state.attemptId !== args.attemptId
		)
			return null;
		await retire_preparation(ctx, receipt);
		await ctx.db.patch("files_ingestion_receipts", receipt._id, {
			state: { kind: "aborted" },
			expiresAt: Date.now() + RECEIPT_TTL_MS,
		});
		return null;
	},
});

export const cleanup_expired_receipts = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const expired = await ctx.db
			.query("files_ingestion_receipts")
			.withIndex("by_expiresAt", (q) => q.lte("expiresAt", Date.now()))
			.take(CLEANUP_BATCH_SIZE);
		for (const receipt of expired) {
			if (receipt.state.kind === "preparing") {
				await retire_preparation(ctx, receipt);
				await ctx.db.patch("files_ingestion_receipts", receipt._id, {
					state: { kind: "aborted" },
					expiresAt: Date.now() + RECEIPT_TTL_MS,
				});
			} else {
				await ctx.db.delete("files_ingestion_receipts", receipt._id);
			}
		}
		if (expired.length === CLEANUP_BATCH_SIZE)
			await ctx.scheduler.runAfter(0, internal.files_ingestion.cleanup_expired_receipts, {});
		return null;
	},
});
