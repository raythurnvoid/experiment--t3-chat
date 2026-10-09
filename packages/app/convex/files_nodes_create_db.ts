// Shared database helpers for file creation and content publication.
// Keep editor, chunker, and upload handlers out of this module.

import { Result } from "common/errors-as-values-utils.ts";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { should_never_happen } from "../shared/shared-utils.ts";
import { r2_create_asset_key, r2_enqueue_object_deletion_job, r2_PUT_MAY_ARRIVE_MARGIN_MS } from "./r2_client.ts";

/**
 * Insert a paired set of committed `files_text_chunks` + `files_plain_text_chunks` for one file node.
 * Editable Markdown materialization passes a real `yjsSequence`; read-only text materialization omits it.
 * Caller supplies the already-computed chunk array and the denormalized `path`/`archiveOperationId` for the
 * plain-text docs. Does not touch `file_stats` or `files_metadata_docs` — callers own those.
 */
export async function files_nodes_db_insert_committed_text_chunks(
	ctx: MutationCtx,
	args: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		nodeId: Id<"files_nodes">;
		path: string;
		archiveOperationId?: string;
		yjsSequence?: number;
		moveView?: Doc<"files_text_chunks">["moveView"];
		chunkCount?: number;
		chunks: ReadonlyArray<{
			chunkIndex: number;
			textChunk: string;
			plainTextChunk: string;
			startIndex: number;
			endIndex: number;
			lineStart: number;
			lineEnd: number;
			chunkFlags: number;
		}>;
	},
) {
	// Large plain text can have more chunks than Convex allows in one I/O batch.
	for (let start = 0; start < args.chunks.length; start += 100) {
		const chunks = args.chunks.slice(start, start + 100);
		const textChunkIds = await Promise.all(
			chunks.map(async (chunk) => {
				const shared = {
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					fileNodeId: args.nodeId,
					sourceKind: "committed" as const,
					moveView: args.moveView,
					...(args.yjsSequence === undefined ? {} : { yjsSequence: args.yjsSequence }),
					chunkIndex: chunk.chunkIndex,
					startIndex: chunk.startIndex,
					endIndex: chunk.endIndex,
					lineStart: chunk.lineStart,
					lineEnd: chunk.lineEnd,
					chunkFlags: chunk.chunkFlags,
				};
				return await ctx.db.insert("files_text_chunks", { ...shared, textChunk: chunk.textChunk });
			}),
		);

		await Promise.all(
			chunks.map((chunk, index) =>
				ctx.db.insert("files_plain_text_chunks", {
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					fileNodeId: args.nodeId,
					sourceKind: "committed",
					moveView: args.moveView,
					...(args.yjsSequence === undefined ? {} : { yjsSequence: args.yjsSequence }),
					textChunkId: textChunkIds[index]!,
					chunkIndex: chunk.chunkIndex,
					path: args.path,
					archiveOperationId: args.archiveOperationId ?? undefined,
					plainTextChunk: chunk.plainTextChunk,
					textChunk: chunk.textChunk,
					startIndex: chunk.startIndex,
					endIndex: chunk.endIndex,
					lineStart: chunk.lineStart,
					lineEnd: chunk.lineEnd,
					chunkFlags: chunk.chunkFlags,
					hasChunkAbove: chunk.chunkIndex > 0,
					hasChunkBelow: chunk.chunkIndex < (args.chunkCount ?? args.chunks.length) - 1,
				}),
			),
		);
	}
}

/**
 * Create a deletion job for each unpublished R2 asset. Then delete the asset docs.
 * Do both in the transaction that refuses the write, so a crash cannot lose the cleanup work.
 * The action already finished each R2 upload to its known key, even when `r2Key` is not set.
 * Do not touch an asset that is missing or already published. Save preparation keeps its
 * late-upload deadline on the job.
 */
export async function files_nodes_db_hand_unpublished_assets_to_deletion_ledger(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		assetIds: ReadonlyArray<Id<"files_r2_assets">>;
		reason: "failed_create" | "read_only_create" | "read_only_snapshot_restore" | "read_only_yjs_repair";
	},
) {
	for (const assetId of args.assetIds) {
		const asset = await ctx.db.get("files_r2_assets", assetId);
		if (!asset || asset.r2Key !== undefined) {
			continue;
		}
		const claim = await ctx.db
			.query("files_move_asset_claims")
			.withIndex("by_asset", (q) => q.eq("assetId", assetId))
			.first();
		if (claim) continue;

		// Add the job before deleting the doc. Both changes save together.
		// The deletion job now owns this R2 file.
		await r2_enqueue_object_deletion_job(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			r2Key: r2_create_asset_key({
				organizationId: asset.organizationId,
				workspaceId: asset.workspaceId,
				assetId: asset._id,
			}),
			reason: args.reason,
			...(asset.uploadUrlExpiresAt !== undefined
				? { putMayArriveUntil: asset.uploadUrlExpiresAt + r2_PUT_MAY_ARRIVE_MARGIN_MS }
				: {}),
		});
		await ctx.db.delete("files_r2_assets", asset._id);
	}
}

/**
 * Publish an editable text file and its first version snapshot.
 * `node.assetId` points to the first version snapshot. Editable files have no current-content asset.
 * Set `r2Key` and size on both assets, then add the snapshot doc.
 * Call this inside the final publish mutation. Reserved scopes cannot call it.
 */
export async function files_nodes_db_finalize_editable_text_node_creation(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		nodeId: Id<"files_nodes">;
		userId: Id<"users">;
		/**
		 * Absent for a non-collaborative file. That file has no Yjs document, so there is no
		 * snapshot object to publish and no asset to point at one.
		 */
		yjsSnapshot?: { assetId: Id<"files_r2_assets">; size: number };
		versionSnapshotAssetId: Id<"files_r2_assets">;
		versionSnapshotSize: number;
	},
) {
	const now = Date.now();
	const yjsSnapshot = args.yjsSnapshot;
	// The node and its content docs were inserted earlier in this same mutation, so the read
	// sees them. The snapshot doc copies the type, shape, and mode the node was created with.
	const fileNode = await ctx.db.get("files_nodes", args.nodeId);
	if (!fileNode) {
		throw should_never_happen("Editable text node creation finalized for a missing node", { nodeId: args.nodeId });
	}

	await Promise.all([
		yjsSnapshot
			? ctx.db.patch("files_r2_assets", yjsSnapshot.assetId, {
					r2Key: r2_create_asset_key({
						organizationId: args.organizationId,
						workspaceId: args.workspaceId,
						assetId: yjsSnapshot.assetId,
					}),
					size: yjsSnapshot.size,
					unfinalizedExpiresAt: undefined,
					updatedAt: now,
				})
			: Promise.resolve(null),
		ctx.db.patch("files_r2_assets", args.versionSnapshotAssetId, {
			r2Key: r2_create_asset_key({
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				assetId: args.versionSnapshotAssetId,
			}),
			size: args.versionSnapshotSize,
			unfinalizedExpiresAt: undefined,
			updatedAt: now,
		}),
		ctx.db.insert("files_snapshots", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			fileNodeId: args.nodeId,
			assetId: args.versionSnapshotAssetId,
			createdBy: args.userId,
			archivedAt: -1,
			...files_nodes_snapshot_fields(fileNode),
		}),
	]);

	return Result({ _yay: null });
}

/**
 * Compute `wc` counts for a full text in one pass: lineCount = newline count (`wc -l`), wordCount =
 * whitespace-delimited words (`wc -w`), charCount = Unicode code points (`wc -m`, not UTF-16 units,
 * so emoji/astral chars count as one). Used both at materialization (to store exact counts on the
 * node) and on the windowed fallback (lower-bound counts for unmaterialized content), so the two
 * paths share identical semantics. Allocation-free except the word split.
 */
export function files_compute_wc_counts(text: string) {
	let lineCount = 0;
	let charCount = 0;
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code === 10) lineCount++; // "\n"
		// Skip the trailing half of a surrogate pair so the pair counts as one code point.
		if (code < 0xdc00 || code > 0xdfff) charCount++;
	}
	const trimmed = text.trim();
	const wordCount = trimmed.length === 0 ? 0 : trimmed.split(/\s+/u).length;
	return { lineCount, wordCount, charCount };
}

export function files_nodes_snapshot_fields(fileNode: Doc<"files_nodes">) {
	if (fileNode.contentType === null) {
		const errorMessage = "A file snapshot requires a content type";
		const errorData = { nodeId: fileNode._id };
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}

	return {
		contentType: fileNode.contentType,
		yjsRootKind: fileNode.textKind,
		collaborationEnabled: fileNode.collaborationEnabled === true,
	};
}
