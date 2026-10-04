// Shared database helpers for file creation and content publication.
// Keep editor, chunker, and upload handlers out of this module.

import { Result } from "common/errors-as-values-utils.ts";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { path_extract_segments_from } from "../shared/paths.ts";
import { path_join } from "../server/server-utils.ts";
import { files_ROOT_ID } from "../shared/files.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";
import { should_never_happen } from "../shared/shared-utils.ts";
import { access_control_db_authorize_membership, access_control_db_authorize_node } from "./access_control.ts";
import { files_media_validation_db_advance_version } from "./files_media_validation.ts";
import { files_updated_by_db_sync_node } from "./files_updated_by.ts";
import { r2_create_asset_key, r2_enqueue_object_deletion_job, r2_PUT_MAY_ARRIVE_MARGIN_MS } from "./r2_client.ts";

async function db_has_write_permission(
	ctx: MutationCtx,
	args: { membership: Doc<"organizations_workspaces_users">; node: Doc<"files_nodes"> | null },
) {
	const membership = await ctx.db
		.query("organizations_workspaces_users")
		.withIndex("by_active_user_organization_workspace", (q) =>
			q
				.eq("active", true)
				.eq("userId", args.membership.userId)
				.eq("organizationId", args.membership.organizationId)
				.eq("workspaceId", args.membership.workspaceId),
		)
		.first();
	if (!membership || membership.pendingOrganizationRemoval) {
		return false;
	}
	const authorized = await access_control_db_authorize_membership(ctx, {
		userAuth: { id: membership.userId },
		membership,
		fileNode: args.node ?? undefined,
		permission: "content.write",
	});
	return !authorized._nay;
}

/**
 * Create a node for the temporary file and folder paths after checking the full existing path.
 * The caller inserts a file's content and publishes its assets in the same mutation.
 */
export async function files_nodes_create_db_create_node(
	ctx: MutationCtx,
	args: {
		membership: Doc<"organizations_workspaces_users">;
		parentId: Id<"files_nodes"> | typeof files_ROOT_ID;
		path: string;
		kind: "file" | "folder";
		assetId?: Id<"files_r2_assets">;
	},
) {
	const { membership } = args;
	const userAuth = { id: membership.userId };
	const authorized =
		args.parentId === files_ROOT_ID
			? await access_control_db_authorize_membership(ctx, { userAuth, membership, permission: "content.write" })
			: await access_control_db_authorize_node(ctx, {
					userAuth,
					membership,
					nodeId: args.parentId,
					permission: "content.write",
				});
	if (authorized._nay) {
		return args.kind === "file" ? Result({ _nay: { message: "Permission denied" } }) : authorized;
	}

	let parentNode = args.parentId === files_ROOT_ID ? null : await ctx.db.get("files_nodes", args.parentId);
	if (
		args.parentId !== files_ROOT_ID &&
		(!parentNode ||
			parentNode.organizationId !== membership.organizationId ||
			parentNode.workspaceId !== membership.workspaceId ||
			parentNode.kind !== "folder" ||
			parentNode.archiveOperationId !== null)
	) {
		return Result({ _nay: { message: "Not found" } });
	}

	const segments = path_extract_segments_from(args.path);
	let parentPath = parentNode?.path ?? "/";
	let firstMissing = 0;
	let conflict: { name?: string; message: string } | null = null;
	// Check the full existing prefix before inserting any folder or exposing a conflict.
	for (const [index, name] of segments.entries()) {
		const existing = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_parent_name_archiveOperation", (q) =>
				q
					.eq("organizationId", membership.organizationId)
					.eq("workspaceId", membership.workspaceId)
					.eq("parentId", parentNode?._id ?? files_ROOT_ID)
					.eq("name", name)
					.eq("archiveOperationId", null),
			)
			.first();
		firstMissing = index;
		if (!existing) break;
		const segmentAuthorized = await access_control_db_authorize_node(ctx, {
			userAuth,
			membership,
			nodeId: existing._id,
			permission: "content.write",
		});
		if (segmentAuthorized._nay) {
			return Result({ _nay: { message: "Permission denied" } });
		}
		const isLeaf = index === segments.length - 1;
		if (existing.kind !== "folder" || isLeaf) {
			if (!(await db_has_write_permission(ctx, { membership, node: existing }))) {
				return Result({ _nay: { message: "Permission denied" } });
			}
			conflict =
				isLeaf && args.kind === "file"
					? { name: "nay", message: "This file already exists." }
					: { message: "This folder already exists." };
			if (args.kind === "folder") return Result({ _nay: conflict });
			break;
		}
		parentNode = existing;
		parentPath = existing.path;
	}

	if (!(await db_has_write_permission(ctx, { membership, node: parentNode }))) {
		return Result({ _nay: { message: "Permission denied" } });
	}
	const policy = parentNode?.writePolicy ?? null;
	if (
		policy !== null &&
		(policy.mode === "read_only" ||
			!policy.writers.some((writer) => writer.kind === "user" && writer.userId === userAuth.id))
	) {
		return Result({ _nay: { name: "read_only", message: "This item is read-only." } });
	}
	// File creation checks the parent lock before reporting a name taken during upload.
	if (conflict) return Result({ _nay: conflict });

	const missingNames = segments.slice(firstMissing);
	let parentId: Id<"files_nodes"> | "root" = parentNode?._id ?? files_ROOT_ID;
	let path = parentPath;
	const now = Date.now();
	for (const [index, name] of missingNames.entries()) {
		path = path_join(path, name);
		const kind = index === missingNames.length - 1 ? args.kind : "folder";
		const parent = parentId === files_ROOT_ID ? null : await ctx.db.get("files_nodes", parentId);
		const parentDefault = parent?.newChildWritePolicy ?? null;
		const assetId = kind === "file" ? args.assetId : undefined;
		const asset = assetId ? await ctx.db.get("files_r2_assets", assetId) : null;
		const dotIndex = name.lastIndexOf(".");
		const nodeId = await ctx.db.insert("files_nodes", {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			parentId,
			kind,
			name,
			sortName: files_sort_text_key(name),
			path,
			treePath: kind === "folder" && path !== "/" ? `${path}/` : path,
			pathDepth: path === "/" ? 0 : path_extract_segments_from(path).length,
			lowercaseExtension:
				kind === "file" && dotIndex > 0 && dotIndex < name.length - 1 ? name.slice(dotIndex + 1).toLowerCase() : null,
			contentType: kind === "file" ? "text/markdown;charset=utf-8" : null,
			assetId: assetId ?? null,
			contentByteSize: asset?.size ?? null,
			textKind: null,
			collaborationEnabled: null,
			yjsSnapshotId: null,
			yjsLastSequenceId: null,
			statsId: null,
			contentTooLargeByteSize: null,
			contentShapeMismatchAt: null,
			contentYjsStateTooLargeByteSize: null,
			contentFrontmatterTooLargeFieldCount: null,
			contentFrontmatterTooLargeIndexDocumentCount: null,
			restrictedScopeNodeId: parent?.restrictedScopeNodeId ?? null,
			isRestrictedScopeRoot: false,
			writePolicy: parentDefault,
			newChildWritePolicy: kind === "folder" ? parentDefault : null,
			archiveOperationId: null,
			createdBy: userAuth.id,
			updatedBy: userAuth.id,
			updatedAt: now,
		});
		await files_media_validation_db_advance_version(ctx, membership);
		await files_updated_by_db_sync_node(ctx, { nodeId });
		if (index === missingNames.length - 1) {
			return Result({ _yay: { nodeId } });
		}
		parentId = nodeId;
	}

	const errorMessage = "nodeId not resolved after node path creation";
	const errorData = {};
	console.error(errorMessage, errorData);
	throw should_never_happen(errorMessage, errorData);
}

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
					hasChunkAbove: start + index > 0,
					hasChunkBelow: start + index < args.chunks.length - 1,
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
