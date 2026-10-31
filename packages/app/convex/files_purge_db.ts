// Delete permanently: the per-node steps of a purge run (`files_archive_runs` kind "purge"). A node is
// drained in small steps, one family of docs at a time, and its doc goes last, only when nothing is
// left under it. The run owns the walk; this module owns what one node holds.
import { Workpool } from "@convex-dev/workpool";
import { components, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { channels_db_purge_channel_batch } from "./channels.ts";
import { files_media_validation_db_advance_version } from "./files_media_validation.ts";
import { cancel_file_content_materialization, files_nodes_db_handoff_yjs_cleanup_task } from "./files_nodes.ts";
import { files_pending_nodes_db_discard } from "./files_pending_nodes.ts";
import { files_pending_updates_db_discard_saved } from "./files_pending_updates.ts";
import { files_share_links_db_delete_for_node } from "./files_share_links_db.ts";
import { files_updated_by_db_delete_for_node } from "./files_updated_by.ts";
import { plugins_db_sync_sandbox_root } from "./plugins_service_accounts.ts";
import { quotas_db_ensure } from "./quotas.ts";
import { r2_create_asset_key, r2_enqueue_object_deletion_job, r2_PUT_MAY_ARRIVE_MARGIN_MS } from "./r2_assets.ts";
import { files_content_retention_db_uses_asset } from "../server/files-content-retention.ts";
import {
	files_move_reservations_db_check_node_write,
	files_move_reservations_db_note_source,
} from "../server/files-move-reservations.ts";

/**
 * How many docs of one family one drain call deletes.
 */
const DRAIN_BATCH_SIZE = 64;

/**
 * Yjs updates and snapshots can be large, so one call deletes fewer of them.
 */
const DRAIN_LARGE_BATCH_SIZE = 8;

/**
 * Workspace purges and this module both cancel upload conversion before an asset doc goes.
 */
const files_upload_conversion_workpool = new Workpool(components.files_upload_conversion_workpool, {
	maxParallelism: 1,
	retryActionsByDefault: true,
	defaultRetryBehavior: {
		initialBackoffMs: 60 * 1000,
		base: 1.2,
		maxAttempts: Number.POSITIVE_INFINITY,
	} as const,
});

/**
 * Delete one asset for good: stop its upload conversion, queue the delete of its R2 file, and give
 * back the bytes it added to `stored_file_bytes`. Call it in the transaction that deletes the last
 * doc that points at the asset. The asset doc goes in the same transaction, so its bytes can never
 * come back twice.
 *
 * An asset that live content, a Move or another node still uses is kept. Its owner deletes it later.
 */
export async function files_purge_db_delete_asset(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		assetId: Id<"files_r2_assets">;
	},
) {
	const { organizationId, workspaceId } = args;
	const asset = await ctx.db.get("files_r2_assets", args.assetId);
	if (!asset || asset.organizationId !== organizationId || asset.workspaceId !== workspaceId) return;

	const [usedByContent, claim, node] = await Promise.all([
		files_content_retention_db_uses_asset(ctx.db, asset._id),
		ctx.db
			.query("files_move_asset_claims")
			.withIndex("by_asset", (q) => q.eq("assetId", asset._id))
			.first(),
		ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_asset", (q) =>
				q.eq("organizationId", organizationId).eq("workspaceId", workspaceId).eq("assetId", asset._id),
			)
			.first(),
	]);
	if (usedByContent || claim || node) return;

	if (asset.processingWorkId) {
		await files_upload_conversion_workpool.cancel(ctx, asset.processingWorkId);
	}
	const now = Date.now();
	await r2_enqueue_object_deletion_job(ctx, {
		organizationId,
		workspaceId,
		r2Key: asset.r2Key ?? r2_create_asset_key({ organizationId, workspaceId, assetId: asset._id }),
		reason: "permanent_delete",
		// A signed URL can create the object again after an early delete.
		putMayArriveUntil:
			asset.kind === "upload" || asset.uploadUrlExpiresAt !== undefined || asset.unfinalizedExpiresAt !== undefined
				? (asset.uploadUrlExpiresAt ?? asset.unfinalizedExpiresAt ?? now) + r2_PUT_MAY_ARRIVE_MARGIN_MS
				: undefined,
	});

	if (asset.storedFileBytes) {
		const quotaId = await quotas_db_ensure(ctx, { quotaName: "stored_file_bytes", organizationId, workspaceId, now });
		const quota = (await ctx.db.get("quotas", quotaId))!;
		await ctx.db.patch("quotas", quotaId, {
			usedCount: Math.max(0, quota.usedCount - asset.storedFileBytes),
			updatedAt: now,
		});
	}
	await ctx.db.delete("files_r2_assets", asset._id);
}

/**
 * Do one small step of deleting one archived node for good. Call it again until it answers
 * `deleted`, `busy` or `not_empty`. Each call deletes one batch of one family of docs, so a file
 * with a long history finishes over several calls.
 *
 * - `more`: something was deleted. Call again.
 * - `busy`: other work still uses the node. Nothing more was deleted. Try again later.
 * - `not_empty`: the folder still has a child. The run keeps the folder.
 * - `deleted`: the node doc and everything in it are gone.
 *
 * The first call that passes the busy checks sets `purgeRunId`. From then on no write can land on
 * the node (`files_nodes_db_require_writable`), so the families below can only shrink.
 */
export async function files_purge_db_drain_node_batch(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		node: Doc<"files_nodes">;
		runId: Id<"files_archive_runs">;
	},
) {
	const { organizationId, workspaceId, node, runId } = args;
	const nodeId = node._id;

	// Busy: a Move, a transfer, an API save or a plugin upload is still working on the node. These
	// end on their own, so the run tries the node again later.
	const [moveWrite, hold, savingRequest, pendingStorageTarget] = await Promise.all([
		files_move_reservations_db_check_node_write(ctx.db, {
			target: { kind: "saved", id: nodeId },
			pendingUpdate: null,
			membership: true,
		}),
		ctx.db
			.query("files_pending_holds")
			.withIndex("by_target_role", (q) => q.eq("target.kind", "saved").eq("target.id", nodeId))
			.first(),
		// A file has few save requests: only API saves make them, and each one expires.
		ctx.db
			.query("files_content_save_requests")
			.withIndex("by_fileNode", (q) => q.eq("fileNodeId", nodeId))
			.filter((q) => q.or(q.eq(q.field("progress.state"), "preparing"), q.eq(q.field("progress.state"), "ready")))
			.first(),
		// A plugin upload makes one target per node it writes.
		ctx.db
			.query("plugin_service_storage_targets")
			.withIndex("by_node", (q) => q.eq("nodeId", nodeId))
			.filter((q) => q.eq(q.field("state"), "pending"))
			.first(),
	]);
	if (node.moveCohortId || moveWrite._nay || hold || savingRequest || pendingStorageTarget) {
		return { kind: "busy" as const };
	}

	if (!node.purgeRunId) {
		await ctx.db.patch("files_nodes", nodeId, { purgeRunId: runId });
	}

	// Drafts on the node, of every user. Discard releases their replacement files and Yjs states.
	// Temporary, capture and retired Yjs states stay with their owners, which expire or clean them
	// up on their own, like after `files_nodes_db_hard_delete_node`.
	const pendingUpdate = await ctx.db
		.query("files_pending_updates")
		.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", nodeId))
		.first();
	if (pendingUpdate) {
		const discarded = await files_pending_updates_db_discard_saved(ctx, pendingUpdate);
		return { kind: discarded._nay ? ("busy" as const) : ("more" as const) };
	}

	// New files and folders that someone drafted inside the folder. Discard one leaf at a time, like
	// draft expiry does, so the children of a drafted folder go first.
	if (node.kind === "folder") {
		let draft = await ctx.db
			.query("files_pending_nodes")
			.withIndex("by_org_ws_parent_state_name", (q) =>
				q
					.eq("organizationId", organizationId)
					.eq("workspaceId", workspaceId)
					.eq("parent.kind", "saved")
					.eq("parent.id", nodeId)
					.eq("state", "active"),
			)
			.first();
		// The path length limit bounds the depth.
		while (draft?.kind === "folder") {
			const parent: Doc<"files_pending_nodes"> = draft;
			const child = await ctx.db
				.query("files_pending_nodes")
				.withIndex("by_organization_workspace_user_parent_state_name", (q) =>
					q
						.eq("organizationId", organizationId)
						.eq("workspaceId", workspaceId)
						.eq("userId", parent.userId)
						.eq("parent.kind", "private")
						.eq("parent.id", parent._id)
						.eq("state", "active"),
				)
				.first();
			if (!child) break;
			draft = child;
		}
		if (draft) {
			const leaf = draft;
			const proposal = await ctx.db
				.query("files_pending_updates")
				.withIndex("by_target", (q) => q.eq("target.kind", "private").eq("target.id", leaf._id))
				.first();
			if (!proposal) return { kind: "busy" as const };
			const discarded = await files_pending_nodes_db_discard(ctx, {
				organizationId,
				workspaceId,
				userId: leaf.userId,
				privateNodeId: leaf._id,
				pendingUpdateId: proposal._id,
				expectedRevision: proposal.revision,
				reason: "expired",
			});
			return { kind: discarded._nay ? ("busy" as const) : ("more" as const) };
		}
	}

	const lastSequences = await ctx.db
		.query("files_pending_updates_last_sequence_saved")
		.withIndex("by_organization_workspace_fileNode_user", (q) =>
			q.eq("organizationId", organizationId).eq("workspaceId", workspaceId).eq("fileNodeId", nodeId),
		)
		.take(DRAIN_BATCH_SIZE);
	for (const doc of lastSequences) await ctx.db.delete("files_pending_updates_last_sequence_saved", doc._id);
	if (lastSequences.length > 0) return { kind: "more" as const };

	// A full metadata map is large, so delete it alone.
	const metadataMap = await ctx.db
		.query("files_metadata_maps")
		.withIndex("by_owner", (q) => q.eq("owner.kind", "saved").eq("owner.id", nodeId))
		.first();
	if (metadataMap) {
		files_move_reservations_db_note_source(ctx.db, {
			table: "files_metadata_maps",
			id: metadataMap._id,
			old: { organizationId, workspaceId, owner: metadataMap.owner },
		});
		await ctx.db.delete("files_metadata_maps", metadataMap._id);
		return { kind: "more" as const };
	}

	// Saved rows use the node index. Draft rows of the node use the target index.
	const [metadataDocs, metadataTargetDocs, plainTextChunks, plainTextTargetChunks, textChunks, textTargetChunks] =
		await Promise.all([
			ctx.db
				.query("files_metadata_docs")
				.withIndex("by_organization_workspace_fileNode_fieldPath", (q) =>
					q.eq("organizationId", organizationId).eq("workspaceId", workspaceId).eq("fileNodeId", nodeId),
				)
				.take(DRAIN_BATCH_SIZE),
			ctx.db
				.query("files_metadata_docs")
				.withIndex("by_organization_workspace_target_fieldPath", (q) =>
					q
						.eq("organizationId", organizationId)
						.eq("workspaceId", workspaceId)
						.eq("target.kind", "saved")
						.eq("target.id", nodeId),
				)
				.take(DRAIN_BATCH_SIZE),
			ctx.db
				.query("files_plain_text_chunks")
				.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
					q.eq("organizationId", organizationId).eq("workspaceId", workspaceId).eq("fileNodeId", nodeId),
				)
				.take(DRAIN_BATCH_SIZE),
			ctx.db
				.query("files_plain_text_chunks")
				.withIndex("by_organization_workspace_target_chunkIndex", (q) =>
					q
						.eq("organizationId", organizationId)
						.eq("workspaceId", workspaceId)
						.eq("target.kind", "saved")
						.eq("target.id", nodeId),
				)
				.take(DRAIN_BATCH_SIZE),
			ctx.db
				.query("files_text_chunks")
				.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
					q.eq("organizationId", organizationId).eq("workspaceId", workspaceId).eq("fileNodeId", nodeId),
				)
				.take(DRAIN_BATCH_SIZE),
			ctx.db
				.query("files_text_chunks")
				.withIndex("by_organization_workspace_target_chunkIndex", (q) =>
					q
						.eq("organizationId", organizationId)
						.eq("workspaceId", workspaceId)
						.eq("target.kind", "saved")
						.eq("target.id", nodeId),
				)
				.take(DRAIN_BATCH_SIZE),
		]);
	// One doc can be in both ranges of its table, so delete each id once.
	const metadataDocIds = new Set([...metadataDocs, ...metadataTargetDocs].map((doc) => doc._id));
	const plainTextChunkIds = new Set([...plainTextChunks, ...plainTextTargetChunks].map((doc) => doc._id));
	const textChunkIds = new Set([...textChunks, ...textTargetChunks].map((doc) => doc._id));
	for (const id of metadataDocIds) await ctx.db.delete("files_metadata_docs", id);
	for (const id of plainTextChunkIds) await ctx.db.delete("files_plain_text_chunks", id);
	for (const id of textChunkIds) await ctx.db.delete("files_text_chunks", id);
	if (metadataDocIds.size + plainTextChunkIds.size + textChunkIds.size > 0) return { kind: "more" as const };

	const yjsUpdates = await ctx.db
		.query("files_yjs_updates")
		.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
			q.eq("organizationId", organizationId).eq("workspaceId", workspaceId).eq("fileNodeId", nodeId),
		)
		.take(DRAIN_LARGE_BATCH_SIZE);
	for (const doc of yjsUpdates) await ctx.db.delete("files_yjs_updates", doc._id);
	if (yjsUpdates.length > 0) return { kind: "more" as const };

	// The file's heads still use some snapshot assets, so `files_purge_db_delete_asset` keeps them
	// here. The last call below deletes them after it retires the heads.
	const [yjsSnapshots, versionSnapshots, yjsCleanupTasks] = await Promise.all([
		ctx.db
			.query("files_yjs_snapshots")
			.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
				q.eq("organizationId", organizationId).eq("workspaceId", workspaceId).eq("fileNodeId", nodeId),
			)
			.take(DRAIN_LARGE_BATCH_SIZE),
		ctx.db
			.query("files_snapshots")
			.withIndex("by_organization_workspace_fileNode_archivedAt", (q) =>
				q.eq("organizationId", organizationId).eq("workspaceId", workspaceId).eq("fileNodeId", nodeId),
			)
			.take(DRAIN_LARGE_BATCH_SIZE),
		ctx.db
			.query("files_yjs_cleanup_tasks")
			.withIndex("by_organization_workspace_fileNode_historyPending", (q) =>
				q.eq("organizationId", organizationId).eq("workspaceId", workspaceId).eq("fileNodeId", nodeId),
			)
			.take(DRAIN_LARGE_BATCH_SIZE),
	]);
	for (const doc of yjsSnapshots) {
		await ctx.db.delete("files_yjs_snapshots", doc._id);
		await files_purge_db_delete_asset(ctx, { organizationId, workspaceId, assetId: doc.assetId });
	}
	for (const doc of versionSnapshots) {
		await ctx.db.delete("files_snapshots", doc._id);
		await files_purge_db_delete_asset(ctx, { organizationId, workspaceId, assetId: doc.assetId });
	}
	// The handoff gives the late-upload deadline to the R2 delete job before the asset doc goes.
	for (const task of yjsCleanupTasks) {
		await files_nodes_db_handoff_yjs_cleanup_task(ctx, task);
		await files_purge_db_delete_asset(ctx, { organizationId, workspaceId, assetId: task.supersededYjsAssetId });
	}
	if (yjsSnapshots.length + versionSnapshots.length + yjsCleanupTasks.length > 0) return { kind: "more" as const };

	const [yjsLastSequences, fileStats, folderSorts, shareGrants, saveRequests] = await Promise.all([
		ctx.db
			.query("files_yjs_docs_last_sequences")
			.withIndex("by_organization_workspace_fileNode", (q) =>
				q.eq("organizationId", organizationId).eq("workspaceId", workspaceId).eq("fileNodeId", nodeId),
			)
			.take(DRAIN_BATCH_SIZE),
		ctx.db
			.query("file_stats")
			.withIndex("by_organization_workspace_fileNode", (q) =>
				q.eq("organizationId", organizationId).eq("workspaceId", workspaceId).eq("fileNodeId", nodeId),
			)
			.take(DRAIN_BATCH_SIZE),
		ctx.db
			.query("files_folder_sorts")
			.withIndex("by_organization_workspace_folder", (q) =>
				q.eq("organizationId", organizationId).eq("workspaceId", workspaceId).eq("folderId", nodeId),
			)
			.take(DRAIN_BATCH_SIZE),
		ctx.db
			.query("access_control_permission_grants")
			.withIndex("by_organization_workspace_resource_user_permission", (q) =>
				q
					.eq("organizationId", organizationId)
					.eq("workspaceId", workspaceId)
					.eq("resourceKind", "file")
					.eq("resourceId", String(nodeId)),
			)
			.take(DRAIN_BATCH_SIZE),
		// The busy check above found no preparing or ready request, so these have all finished.
		ctx.db
			.query("files_content_save_requests")
			.withIndex("by_fileNode", (q) => q.eq("fileNodeId", nodeId))
			.take(DRAIN_BATCH_SIZE),
	]);
	await Promise.all([
		...yjsLastSequences.map((doc) => ctx.db.delete("files_yjs_docs_last_sequences", doc._id)),
		...fileStats.map((doc) => ctx.db.delete("file_stats", doc._id)),
		...folderSorts.map((doc) => ctx.db.delete("files_folder_sorts", doc._id)),
		...shareGrants.map((doc) => ctx.db.delete("access_control_permission_grants", doc._id)),
		...saveRequests.map((doc) => ctx.db.delete("files_content_save_requests", doc._id)),
	]);
	// A deleted account grant frees its plugin folder slot.
	for (const grant of shareGrants) {
		if (grant.principalKind !== "service_account" || !grant.serviceAccountId) continue;
		await plugins_db_sync_sandbox_root(ctx, {
			organizationId,
			workspaceId,
			serviceAccountId: grant.serviceAccountId,
			resource: { kind: "file", nodeId },
			level: null,
		});
	}
	if (yjsLastSequences.length + fileStats.length + folderSorts.length + shareGrants.length + saveRequests.length > 0) {
		return { kind: "more" as const };
	}

	// The file's comment channel, with its messages, threads and uploads.
	const channel = await ctx.db
		.query("channels")
		.withIndex("by_organization_workspace_fileNode", (q) =>
			q.eq("organizationId", organizationId).eq("workspaceId", workspaceId).eq("fileNodeId", nodeId),
		)
		.first();
	if (channel) {
		await channels_db_purge_channel_batch(ctx, { channel, batchSize: DRAIN_BATCH_SIZE });
		return { kind: "more" as const };
	}

	// Drafts that move live files into the folder are not deleted. Saving one answers "Not found"
	// once the folder is gone.
	if (node.kind === "folder") {
		const child = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_parent_name", (q) =>
				q
					.eq("organizationId", organizationId)
					.eq("workspaceId", workspaceId)
					.eq("moveCohortId", undefined)
					.eq("parentId", nodeId),
			)
			.first();
		if (child) return { kind: "not_empty" as const };
	}

	// An index run still reads the file's heads, which the last call below retires. Runs are short.
	const indexState = await ctx.db
		.query("files_index_states")
		.withIndex("by_fileNode", (q) => q.eq("fileNodeId", nodeId))
		.unique();
	if (indexState?.activeRunId) return { kind: "busy" as const };

	// Last call: the small one-per-node docs, then the node.
	await files_share_links_db_delete_for_node(ctx, { organizationId, workspaceId, nodeId });
	await files_updated_by_db_delete_for_node(ctx, { nodeId });
	await cancel_file_content_materialization(ctx, { nodeId });
	const [accessBinding, externalBinding, heads] = await Promise.all([
		ctx.db
			.query("plugins_file_access_bindings")
			.withIndex("by_node", (q) => q.eq("nodeId", nodeId))
			.first(),
		ctx.db
			.query("plugins_external_file_bindings")
			.withIndex("by_node", (q) => q.eq("nodeId", nodeId))
			.first(),
		// A file has only a few heads: old ones retire soon after each save, and discard deletes them.
		ctx.db
			.query("files_saved_content_heads")
			.withIndex("by_fileNode", (q) => q.eq("fileNodeId", nodeId))
			.collect(),
	]);
	if (accessBinding) await ctx.db.delete("plugins_file_access_bindings", accessBinding._id);
	if (externalBinding) await ctx.db.delete("plugins_external_file_bindings", externalBinding._id);

	// Deleting the node also deletes its current head (`server/files-content-heads.ts`).
	await ctx.db.delete("files_nodes", nodeId);
	// An old head can still hold an earlier version's assets, and the current head's live Yjs log can
	// belong to an old head. Once the node is gone, nothing retires them. So retire them here, like
	// `files_content_saves.retire`, and their discard deletes them. Their assets can then go below.
	for (const head of heads) {
		if (head._id === node.contentHeadId) continue;
		if (!head.retired) await ctx.db.patch("files_saved_content_heads", head._id, { retired: true, ready: false });
		await ctx.scheduler.runAfter(0, internal.files_content_saves.discard, { headId: head._id });
	}
	const assetIds = new Set([node.assetId, ...heads.flatMap((head) => [head.assetId, head.snapshotAssetId])]);
	for (const assetId of assetIds) {
		if (assetId) await files_purge_db_delete_asset(ctx, { organizationId, workspaceId, assetId });
	}
	// A pinned media check must not publish a link to the deleted node.
	await files_media_validation_db_advance_version(ctx, { organizationId, workspaceId });

	return { kind: "deleted" as const };
}
