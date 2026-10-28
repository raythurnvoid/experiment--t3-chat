// Private source preparation and durable receipts for editor Saves.

import { Result } from "common/errors-as-values-utils.ts";
import { getConvexSize, v } from "convex/values";
import { doc } from "convex-helpers/validators";
import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import { internalMutation } from "./functions.ts";
import schema from "./schema.ts";
import { v_result } from "../server/convex-utils.ts";
import { files_content_heads_db_for_head } from "../server/files-content-heads.ts";
import { files_content_retention_db_index_uses_head } from "../server/files-content-retention.ts";
import { files_saved_placement_db_get_node } from "../server/files-saved-placement.ts";
import { files_saved_content_db_get_head } from "../server/files-saved-content-head.ts";
import { files_nodes_db_require_user_writable } from "../server/files-write-policy.ts";
import { files_index_db_request } from "../server/files-index.ts";
import { files_move_reservations_db_enter_save } from "../server/files-move-reservations.ts";
import { files_get_utf8_byte_size, files_node_has_editable_text_content } from "../server/files.ts";
import { composite_id, should_never_happen } from "../shared/shared-utils.ts";
import { files_SAVE_SOURCE_PAGE_BYTES, files_SAVE_SOURCE_PAGE_CHUNKS } from "../shared/files.ts";
import { billing_event } from "../server/billing.ts";
import { access_control_db_authorize_node } from "./access_control.ts";
import { billing_db_check_credits, billing_ingest_events, billing_pick_billed_user_id } from "./billing_db.ts";
import { files_updated_by_db_sync_node } from "./files_updated_by.ts";
import { files_nodes_snapshot_fields } from "./files_nodes_create_db.ts";
import {
	r2_BUCKET_FILES,
	r2_UNFINALIZED_ASSET_TTL_MS,
	r2_create_asset_key,
	r2_enqueue_object_deletion_job,
} from "./r2_assets.ts";

async function writable_file(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
		nodeId: Id<"files_nodes">;
	},
) {
	const user = await ctx.db.get("users", args.userId);
	if (!user) return Result({ _nay: { message: "Unauthenticated" } });
	const membership = await ctx.db
		.query("organizations_workspaces_users")
		.withIndex("by_user_organization_workspace_active", (q) =>
			q
				.eq("userId", args.userId)
				.eq("organizationId", args.organizationId)
				.eq("workspaceId", args.workspaceId)
				.eq("active", true),
		)
		.first();
	if (!membership) return Result({ _nay: { message: "Unauthorized" } });
	const authorized = await access_control_db_authorize_node(ctx, {
		userAuth: { id: args.userId },
		membership,
		nodeId: args.nodeId,
		permission: "content.write",
	});
	if (authorized._nay) return authorized;
	const node = await files_saved_placement_db_get_node(ctx.db, args.nodeId);
	if (
		!node ||
		node.organizationId !== args.organizationId ||
		node.workspaceId !== args.workspaceId ||
		node.collaborationEnabled !== false ||
		!files_node_has_editable_text_content(node)
	)
		return Result({ _nay: { message: "Not found" } });
	const writable = await files_nodes_db_require_user_writable(ctx, { node, userId: args.userId });
	if (writable._nay) return writable;
	const organization = await ctx.db.get("organizations", args.organizationId);
	if (!organization) throw should_never_happen("Save organization is missing", args);
	const billedUser = await ctx.db.get("users", billing_pick_billed_user_id({ userId: args.userId, organization }));
	if (!billedUser) throw should_never_happen("Save billed user is missing", args);
	const credits = await billing_db_check_credits(ctx, { userId: billedUser._id, minimumRequiredCents: 1 });
	if (!credits.hasCredits) return Result({ _nay: { message: "Insufficient funds" } });
	return Result({ _yay: { node, billedUser } });
}

export const begin = internalMutation({
	args: {
		organizationId: doc(schema, "files_content_save_requests").fields.organizationId,
		workspaceId: doc(schema, "files_content_save_requests").fields.workspaceId,
		userId: doc(schema, "files_content_save_requests").fields.userId,
		nodeId: doc(schema, "files_content_save_requests").fields.fileNodeId,
		requestId: doc(schema, "files_content_save_requests").fields.requestId,
		requestHash: doc(schema, "files_content_save_requests").fields.requestHash,
		textByteSize: doc(schema, "files_content_save_requests").fields.textByteSize,
	},
	returns: v_result({
		_yay: v.object({
			request: doc(schema, "files_content_save_requests"),
			head: v.union(doc(schema, "files_saved_content_heads"), v.null()),
		}),
	}),
	handler: async (ctx, args) => {
		if (!(await ctx.db.get("users", args.userId))) return Result({ _nay: { message: "Unauthenticated" } });
		if (args.requestId.length === 0 || args.requestId.length > 128)
			return Result({ _nay: { message: "Invalid Save request ID" } });
		const request = await ctx.db
			.query("files_content_save_requests")
			.withIndex("by_user_workspace_request", (q) =>
				q.eq("userId", args.userId).eq("workspaceId", args.workspaceId).eq("requestId", args.requestId),
			)
			.unique();
		if (request) {
			if (
				request.organizationId !== args.organizationId ||
				request.fileNodeId !== args.nodeId ||
				request.requestHash !== args.requestHash ||
				request.textByteSize !== args.textByteSize
			)
				return Result({ _nay: { message: "Save request ID was already used for different content" } });
			if (request.progress.state === "expired")
				return Result({ _nay: { name: "save_expired", message: "This Save expired. Save the file again." } });
			if (request.expiresAt !== null && request.expiresAt <= Date.now())
				return Result({ _nay: { name: "save_expired", message: "This Save expired. Save the file again." } });
			if (request.progress.state === "preparing")
				await ctx.db.patch("files_r2_assets", request.progress.assetId, {
					putMayArriveUntil: Date.now() + r2_UNFINALIZED_ASSET_TTL_MS,
				});
			// A lost reply must never turn an old Save into a new write.
			return Result({
				_yay: {
					request,
					head:
						request.progress.state === "committed"
							? null
							: await ctx.db.get("files_saved_content_heads", request.progress.headId),
				},
			});
		}
		const authorized = await writable_file(ctx, args);
		if (authorized._nay) return authorized;
		const head = await files_saved_content_db_get_head(ctx.db, authorized._yay.node);
		if (!head) throw should_never_happen("Save content owner is missing", { nodeId: args.nodeId });
		const now = Date.now();
		const expiresAt = now + r2_UNFINALIZED_ASSET_TTL_MS;
		const assetId = await ctx.db.insert("files_r2_assets", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			kind: "content_snapshot",
			r2Bucket: r2_BUCKET_FILES,
			size: args.textByteSize,
			createdBy: args.userId,
			unfinalizedExpiresAt: expiresAt,
			putMayArriveUntil: expiresAt,
			updatedAt: now,
		});
		const { _id: _headId, _creationTime: _headCreatedAt, ...fields } = head;
		const headId = await ctx.db.insert("files_saved_content_heads", {
			...fields,
			assetId,
			contentByteSize: args.textByteSize,
			statsId: null,
			ready: false,
			retired: false,
			yjsContentHeadId: null,
			contentTooLargeByteSize: null,
			contentShapeMismatchAt: null,
			contentYjsStateTooLargeByteSize: null,
			contentFrontmatterTooLargeFieldCount: null,
			contentFrontmatterTooLargeIndexDocumentCount: null,
			updatedAt: now,
			updatedBy: args.userId,
		});
		const saveId = await ctx.db.insert("files_content_save_requests", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			fileNodeId: args.nodeId,
			requestId: args.requestId,
			requestHash: args.requestHash,
			textByteSize: args.textByteSize,
			progress: {
				state: "preparing",
				generation: 1,
				headId,
				assetId,
				nextChunkIndex: 0,
				nextStartIndex: 0,
				stagedByteSize: 0,
			},
			expiresAt,
		});
		await ctx.scheduler.runAt(expiresAt, internal.files_content_saves.expire, { saveId });
		return Result({
			_yay: {
				request: (await ctx.db.get("files_content_save_requests", saveId))!,
				head: (await ctx.db.get("files_saved_content_heads", headId))!,
			},
		});
	},
});

export const stage_page = internalMutation({
	args: {
		saveId: v.id("files_content_save_requests"),
		generation: v.number(),
		firstChunkIndex: v.number(),
		chunks: v.array(
			v.object({
				chunkIndex: v.number(),
				textChunk: v.string(),
				startIndex: v.number(),
				endIndex: v.number(),
				lineStart: v.number(),
				lineEnd: v.number(),
				chunkFlags: v.number(),
			}),
		),
	},
	returns: v_result({ _yay: v.number() }),
	handler: async (ctx, args) => {
		const request = await ctx.db.get("files_content_save_requests", args.saveId);
		if (!request || request.progress.state === "expired") return Result({ _nay: { message: "Save expired" } });
		if (request.progress.state === "ready" || request.progress.state === "committed") return Result({ _yay: -1 });
		const progress = request.progress;
		if (progress.generation !== args.generation) return Result({ _nay: { message: "Save attempt changed" } });
		if (args.firstChunkIndex < progress.nextChunkIndex) return Result({ _yay: progress.nextChunkIndex });
		if (
			args.firstChunkIndex !== progress.nextChunkIndex ||
			args.chunks.length === 0 ||
			args.chunks.length > files_SAVE_SOURCE_PAGE_CHUNKS ||
			getConvexSize(args) > files_SAVE_SOURCE_PAGE_BYTES
		)
			return Result({ _nay: { message: "Invalid Save page" } });
		let nextStartIndex = progress.nextStartIndex;
		let stagedByteSize = progress.stagedByteSize;
		for (const [index, chunk] of args.chunks.entries()) {
			if (
				chunk.chunkIndex !== progress.nextChunkIndex + index ||
				chunk.startIndex !== nextStartIndex ||
				chunk.endIndex !== chunk.startIndex + chunk.textChunk.length ||
				chunk.textChunk.length === 0
			)
				return Result({ _nay: { message: "Save chunks are not complete" } });
			nextStartIndex = chunk.endIndex;
			stagedByteSize += files_get_utf8_byte_size(chunk.textChunk);
		}
		if (stagedByteSize > request.textByteSize) return Result({ _nay: { message: "Save bytes do not match" } });
		const head = await ctx.db.get("files_saved_content_heads", progress.headId);
		if (!head || head.ready || head.retired)
			throw should_never_happen("Save candidate is not writable", { saveId: args.saveId });
		const db = files_content_heads_db_for_head(ctx, head);
		await Promise.all(
			args.chunks.map((chunk) =>
				db.insert("files_text_chunks", {
					organizationId: request.organizationId,
					workspaceId: request.workspaceId,
					fileNodeId: request.fileNodeId,
					sourceKind: "committed",
					...chunk,
				}),
			),
		);
		const nextChunkIndex = progress.nextChunkIndex + args.chunks.length;
		await ctx.db.patch("files_content_save_requests", request._id, {
			progress: { ...progress, nextChunkIndex, nextStartIndex, stagedByteSize },
		});
		return Result({ _yay: nextChunkIndex });
	},
});

export const seal = internalMutation({
	args: {
		saveId: v.id("files_content_save_requests"),
		generation: v.number(),
		chunkCount: v.number(),
		textLength: v.number(),
		charCount: v.number(),
		lineCount: v.number(),
		wordCount: v.number(),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const request = await ctx.db.get("files_content_save_requests", args.saveId);
		if (!request || request.progress.state === "expired") return Result({ _nay: { message: "Save expired" } });
		if (request.progress.state === "ready" || request.progress.state === "committed") return Result({ _yay: null });
		const progress = request.progress;
		if (progress.generation !== args.generation) return Result({ _nay: { message: "Save attempt changed" } });
		if (
			progress.nextChunkIndex !== args.chunkCount ||
			progress.nextStartIndex !== args.textLength ||
			progress.stagedByteSize !== request.textByteSize
		)
			return Result({ _nay: { message: "Save chunks are not complete" } });
		const head = await ctx.db.get("files_saved_content_heads", progress.headId);
		if (!head || head.retired) throw should_never_happen("Save candidate is missing", { saveId: args.saveId });
		const statsId = await files_content_heads_db_for_head(ctx, head).insert("file_stats", {
			organizationId: request.organizationId,
			workspaceId: request.workspaceId,
			fileNodeId: request.fileNodeId,
			charCount: args.charCount,
			lineCount: args.lineCount,
			wordCount: args.wordCount,
		});
		await ctx.db.patch("files_saved_content_heads", head._id, { statsId, ready: true });
		await ctx.db.patch("files_content_save_requests", request._id, {
			progress: {
				state: "ready",
				generation: progress.generation,
				headId: progress.headId,
				assetId: progress.assetId,
			},
		});
		return Result({ _yay: null });
	},
});

export const publish = internalMutation({
	args: { saveId: v.id("files_content_save_requests"), generation: v.number() },
	returns: v_result({
		_yay: v.object({
			requestId: doc(schema, "files_content_save_requests").fields.requestId,
			contentRevision: doc(schema, "files_index_states").fields.contentRevision,
		}),
	}),
	handler: async (ctx, args) => {
		const request = await ctx.db.get("files_content_save_requests", args.saveId);
		if (!request || request.progress.state === "expired") return Result({ _nay: { message: "Save expired" } });
		if (request.progress.state === "committed")
			return Result({
				_yay: {
					requestId: request.requestId,
					contentRevision: request.progress.contentRevision,
				},
			});
		if (request.progress.state !== "ready" || request.progress.generation !== args.generation)
			return Result({ _nay: { message: "Save is not ready" } });
		const authorized = await writable_file(ctx, { ...request, nodeId: request.fileNodeId });
		if (authorized._nay) return authorized;
		const { node, billedUser } = authorized._yay;
		const previousHead = await files_saved_content_db_get_head(ctx.db, node);
		const head = await ctx.db.get("files_saved_content_heads", request.progress.headId);
		if (!head || !head.ready || head.retired)
			throw should_never_happen("Save candidate is missing", { saveId: args.saveId });
		if (head.textKind !== node.textKind || head.contentType !== node.contentType)
			return Result({ _nay: { message: "The file type changed. Open the file again before saving." } });
		const reservation = await files_move_reservations_db_enter_save(ctx, { nodeId: node._id, headId: head._id });
		if (reservation._nay) return reservation;
		const now = Date.now();
		const assetId = request.progress.assetId;
		await ctx.db.patch("files_nodes", node._id, {
			contentHeadId: head._id,
			assetId,
			statsId: head.statsId,
			contentByteSize: request.textByteSize,
			pendingContentVersion: node.pendingContentVersion,
			contentTooLargeByteSize: null,
			contentShapeMismatchAt: null,
			contentYjsStateTooLargeByteSize: null,
			contentFrontmatterTooLargeFieldCount: null,
			contentFrontmatterTooLargeIndexDocumentCount: null,
			updatedBy: request.userId,
			updatedAt: now,
		});
		await ctx.db.patch("files_r2_assets", assetId, {
			r2Key: r2_create_asset_key({ organizationId: request.organizationId, workspaceId: request.workspaceId, assetId }),
			unfinalizedExpiresAt: undefined,
			updatedAt: now,
		});
		await ctx.db.insert("files_snapshots", {
			organizationId: request.organizationId,
			workspaceId: request.workspaceId,
			fileNodeId: node._id,
			assetId,
			createdBy: request.userId,
			archivedAt: -1,
			...files_nodes_snapshot_fields(node),
		});
		await files_updated_by_db_sync_node(ctx, { nodeId: node._id });
		const { contentRevision } = await files_index_db_request(ctx, {
			nodeId: node._id,
			previousPublishedHeadId: previousHead?._id,
		});
		await billing_ingest_events(ctx, {
			billedUserEvents: [
				{
					billedUser,
					event: billing_event({
						name: "file_save",
						externalCustomerId: billedUser._id,
						externalMemberId: request.userId,
						externalId: composite_id(
							"billing",
							"file_save",
							billedUser._id,
							request.userId,
							request.organizationId,
							request.workspaceId,
							node._id,
							assetId,
						),
						metadata: {
							amount: 1,
							actorUserId: request.userId,
							billedUserId: billedUser._id,
							organizationId: request.organizationId,
							workspaceId: request.workspaceId,
							nodeId: node._id,
							version: assetId,
						},
					}),
				},
			],
		});
		await ctx.db.patch("files_content_save_requests", request._id, {
			progress: { state: "committed", contentRevision, committedAt: now },
			expiresAt: null,
		});
		if (previousHead)
			await ctx.scheduler.runAfter(0, internal.files_content_saves.retire, { headId: previousHead._id });
		return Result({ _yay: { requestId: request.requestId, contentRevision } });
	},
});

export const expire = internalMutation({
	args: { saveId: v.id("files_content_save_requests") },
	returns: v.null(),
	handler: async (ctx, args) => {
		const request = await ctx.db.get("files_content_save_requests", args.saveId);
		if (
			!request ||
			request.expiresAt === null ||
			request.expiresAt > Date.now() ||
			request.progress.state === "committed" ||
			request.progress.state === "expired"
		)
			return;
		const headId = request.progress.headId;
		await ctx.db.patch("files_content_save_requests", request._id, {
			progress: { state: "expired", expiredAt: Date.now() },
			expiresAt: null,
		});
		await ctx.db.patch("files_saved_content_heads", headId, { retired: true, ready: false });
		await ctx.scheduler.runAfter(0, internal.files_content_saves.discard, { headId });
	},
});

export const retire = internalMutation({
	args: { headId: v.id("files_saved_content_heads") },
	returns: v.null(),
	handler: async (ctx, args) => {
		const head = await ctx.db.get("files_saved_content_heads", args.headId);
		if (!head) return;
		const node = await ctx.db.get("files_nodes", head.fileNodeId);
		if (node?.contentHeadId === head._id || (await files_content_retention_db_index_uses_head(ctx.db, head._id)))
			return;
		const request = await ctx.db
			.query("files_content_save_requests")
			.withIndex("by_progress_head", (q) => q.eq("progress.headId", head._id))
			.first();
		if (request) return;
		if (node?.moveCohortId) {
			const content = await ctx.db
				.query("files_move_cohort_content")
				.withIndex("by_cohort_node", (q) => q.eq("cohortId", node.moveCohortId!).eq("nodeId", node._id))
				.unique();
			if (content?.beforeHeadId === head._id || content?.afterHeadId === head._id) return;
		}
		if (!head.retired) await ctx.db.patch("files_saved_content_heads", head._id, { retired: true, ready: false });
		await ctx.scheduler.runAfter(0, internal.files_content_saves.discard, { headId: head._id });
	},
});

export const discard = internalMutation({
	args: { headId: v.id("files_saved_content_heads") },
	returns: v.null(),
	handler: async (ctx, args) => {
		const head = await ctx.db.get("files_saved_content_heads", args.headId);
		if (!head || !head.retired) return;
		const chunks = await ctx.db
			.query("files_text_chunks")
			.withIndex("by_contentHead_yjsSeq_chunk", (q) => q.eq("contentHeadId", head._id))
			.take(100);
		await Promise.all(chunks.map((chunk) => ctx.db.delete("files_text_chunks", chunk._id)));
		if (chunks.length > 0) {
			await ctx.scheduler.runAfter(0, internal.files_content_saves.discard, args);
			return;
		}
		if (head.statsId) {
			const users = await ctx.db
				.query("files_saved_content_heads")
				.withIndex("by_stats", (q) => q.eq("statsId", head.statsId))
				.take(2);
			// Move may have removed the losing head's stats before history retires its owner.
			if (users.every((candidate) => candidate._id === head._id) && await ctx.db.get("file_stats", head.statsId))
				await ctx.db.delete("file_stats", head.statsId);
		}
		const logUsers = await ctx.db
			.query("files_saved_content_heads")
			.withIndex("by_yjsContentHead", (q) => q.eq("yjsContentHeadId", head._id))
			.take(2);
		if (logUsers.some((candidate) => candidate._id !== head._id))
			await ctx.db.patch("files_saved_content_heads", head._id, { statsId: null });
		else {
			await ctx.db.delete("files_saved_content_heads", head._id);
			// The last source using an old live log releases its small retained owner too.
			if (head.yjsContentHeadId && head.yjsContentHeadId !== head._id)
				await ctx.scheduler.runAfter(0, internal.files_content_saves.discard, { headId: head.yjsContentHeadId });
		}
		const asset = head.assetId ? await ctx.db.get("files_r2_assets", head.assetId) : null;
		if (asset && asset.r2Key === undefined) {
			const organizationId = ctx.db.normalizeId("organizations", head.organizationId);
			const workspaceId = ctx.db.normalizeId("organizations_workspaces", head.workspaceId);
			if (!organizationId || !workspaceId) throw should_never_happen("Save has no workspace", { headId: head._id });
			await r2_enqueue_object_deletion_job(ctx, {
				organizationId,
				workspaceId,
				r2Key: r2_create_asset_key({ organizationId, workspaceId, assetId: asset._id }),
				reason: "failed_create",
				putMayArriveUntil: asset.putMayArriveUntil,
			});
			await ctx.db.delete("files_r2_assets", asset._id);
		}
	},
});
