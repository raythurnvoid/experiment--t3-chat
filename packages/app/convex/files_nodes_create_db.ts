// Shared database helpers for file creation and content publication.
// Keep editor, chunker, and upload handlers out of this module.

import { Result } from "common/errors-as-values-utils.ts";
import { path_extract_segments_from, path_join } from "../server/server-utils.ts";
import { files_ROOT_ID } from "../server/files.ts";
import { files_metadata_apply_set_and_remove, type files_metadata_Entry } from "../shared/files-metadata.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";
import { users_SYSTEM_AUTHOR } from "../shared/users.ts";
import { files_saved_placement_db_get_node, files_saved_placement_db_get_slot } from "../server/files-saved-placement.ts";
import { files_move_reservations_db_check } from "../server/files-move-reservations.ts";
import { files_updated_by_db_sync_node } from "./files_updated_by.ts";
import { access_control_db_can_act_on_file_node } from "./access_control.ts";
import { files_content_type_index_fields, files_derive_tree_path_for_file_node, files_lowercase_extension, files_check_name_and_path_length, files_check_new_folder_count } from "../shared/files.ts";
import { files_metadata_db_write_entries } from "./files_metadata.ts";
import { type files_nodes_WriteContext, files_nodes_db_require_writable, files_nodes_db_resolve_parent_new_child_policy } from "../server/files-write-policy.ts";
import {
	files_write_policy_db_has_write_context_permission as db_has_write_context_permission,
	files_nodes_db_require_copiable_write_policy,
	files_nodes_db_require_write_policy_management,
} from "./files_write_policy_db.ts";
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

export function files_path_depth(path: string) {
	return path === "/" ? 0 : path_extract_segments_from(path).length;
}
/** -1 in any file_stats count means the content cannot be processed (non-markdown / binary). */
const files_STATS_UNPROCESSABLE = -1;
/**
 * Create or update the `file_stats` doc for a file node and, on first creation, link it back via
 * `files_nodes.statsId`. Subsequent updates patch only the stats doc — NOT the file node — so
 * re-materializing content does not invalidate the file-tree / path-resolution queries that read
 * the file node. Returns the stats doc id.
 */
export async function files_nodes_db_upsert_file_stats(
	ctx: MutationCtx,
	args: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		nodeId: Id<"files_nodes">;
		lineCount: number;
		wordCount: number;
		charCount: number;
	},
) {
	const existing = await ctx.db
		.query("file_stats")
		.withIndex("by_organization_workspace_fileNode", (q) =>
			q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("fileNodeId", args.nodeId),
		)
		.first();
	if (existing) {
		await ctx.db.patch("file_stats", existing._id, {
			lineCount: args.lineCount,
			wordCount: args.wordCount,
			charCount: args.charCount,
		});
		return existing._id;
	}
	const statsId = await ctx.db.insert("file_stats", {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		fileNodeId: args.nodeId,
		lineCount: args.lineCount,
		wordCount: args.wordCount,
		charCount: args.charCount,
	});
	await ctx.db.patch("files_nodes", args.nodeId, { statsId });
	return statsId;
}
function node_insert_fields(args: {
	userId: Doc<"files_nodes">["createdBy"];
	organizationId: Doc<"files_nodes">["organizationId"];
	workspaceId: Doc<"files_nodes">["workspaceId"];
	parentId: Doc<"files_nodes">["parentId"];
	name: string;
	path: string;
	kind: Doc<"files_nodes">["kind"];
	contentType?: Doc<"files_nodes">["contentType"];
	assetId?: Id<"files_r2_assets">;
	contentByteSize?: number;
	archiveOperationId?: Doc<"files_nodes">["archiveOperationId"];
	restrictedScopeNodeId: Doc<"files_nodes">["restrictedScopeNodeId"];
	extendedScopeNodeId: Id<"files_nodes"> | null;
	publicScopeNodeId: Doc<"files_nodes">["publicScopeNodeId"];
	writePolicy?: Doc<"files_nodes">["writePolicy"];
	newChildWritePolicy?: Doc<"files_nodes">["newChildWritePolicy"];
	now: number;
}) {
	return {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		parentId: args.parentId,
		kind: args.kind,
		name: args.name,
		sortName: files_sort_text_key(args.name),
		path: args.path,
		treePath: files_derive_tree_path_for_file_node(args.path, args.kind),
		pathDepth: files_path_depth(args.path),
		lowercaseExtension: files_lowercase_extension(args.path, args.kind),
		contentType: args.contentType ?? null,
		...files_content_type_index_fields(args.contentType ?? null),
		assetId: args.assetId ?? null,
		contentByteSize: args.contentByteSize ?? null,
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
		restrictedScopeNodeId: args.restrictedScopeNodeId,
		// A new node inherits its parent's scope, so it is never its own restricted root.
		isRestrictedScopeRoot: false,
		extendedScopeNodeId: args.extendedScopeNodeId,
		publicScopeNodeId: args.publicScopeNodeId,
		writePolicy: args.writePolicy ?? null,
		newChildWritePolicy: args.newChildWritePolicy ?? null,
		archiveOperationId: args.archiveOperationId ?? null,
		createdBy: args.userId,
		updatedBy: args.userId,
		updatedAt: args.now,
	};
}
async function db_insert_node(
	ctx: MutationCtx,
	args: {
		userId: Doc<"files_nodes">["createdBy"];
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		parentId: Doc<"files_nodes">["parentId"];
		name: Doc<"files_nodes">["name"];
		path: Doc<"files_nodes">["path"];
		kind: Doc<"files_nodes">["kind"];
		contentType?: Doc<"files_nodes">["contentType"];
		assetId?: Id<"files_r2_assets">;
		archiveOperationId?: Doc<"files_nodes">["archiveOperationId"];
		/**
		 * Set when the caller inserts the file's content docs right after this insert, in the same
		 * mutation, via `files_nodes_db_insert_file_content_docs` (files_nodes_content.ts). Skips
		 * the initial UNPROCESSABLE stats write so those callers do not double-write stats.
		 */
		expectsTextContent?: true;
		/**
		 * Omitted means copy the immediate parent's new-child default. An explicit value,
		 * including null, is an override the caller already checked for management rights.
		 * Copy operations pass the verified source settings through here instead.
		 */
		writePolicy?: Doc<"files_nodes">["writePolicy"];
		/**
		 * Omitted on a new folder means copy the parent default too. Files always store null.
		 */
		newChildWritePolicy?: Doc<"files_nodes">["newChildWritePolicy"];
		/**
		 * The raw parent doc, when the caller just read or inserted it. It saves the two parent reads.
		 */
		parent?: Doc<"files_nodes">;
		now: number;
	},
) {
	// A new node sits inside its parent, so it starts with the parent's restricted scope. Without
	// this, a file created inside a restricted folder would be open to the whole workspace, which is
	// the one thing the person who restricted that folder asked us not to do.
	const parent =
		args.parent ?? (args.parentId === files_ROOT_ID ? null : await ctx.db.get("files_nodes", args.parentId));
	const restrictedScopeNodeId = parent?.restrictedScopeNodeId ?? null;
	// A new node is never a restricted or extended root, so it gets no `parentScopeNodeId`, `scopeOpId`
	// or `parentExtendedScopeNodeId`. It gets the people added to the items above it.
	const extendedScopeNodeId = parent?.extendedScopeNodeId ?? null;
	// "Anyone on the web" comes from the parent only, never from a copy source or the request.
	const publicScopeNodeId = parent?.publicScopeNodeId;

	// Copying the default is an ordinary creation step. It needs no policy-management right.
	const parentDefault = args.parent
		? args.parent.newChildWritePolicy
		: await files_nodes_db_resolve_parent_new_child_policy(ctx, {
				parentId: args.parentId,
			});

	// Upload assets are inserted with their declared size, and the R2 upload event corrects it later.
	const asset = args.assetId ? await ctx.db.get("files_r2_assets", args.assetId) : null;

	const nodeId = await ctx.db.insert(
		"files_nodes",
		node_insert_fields({
			...args,
			contentByteSize: asset?.size,
			restrictedScopeNodeId,
			extendedScopeNodeId,
			publicScopeNodeId,
			writePolicy: args.writePolicy !== undefined ? args.writePolicy : parentDefault,
			newChildWritePolicy:
				args.kind === "folder"
					? args.newChildWritePolicy !== undefined
						? args.newChildWritePolicy
						: parentDefault
					: null,
		}),
	);
	// No media validation advance: a new node has a new ID, so no checked proof names it. It starts in
	// its parent's scope and is never a restricted root. Move reservations block creation inside a moving folder.
	await files_updated_by_db_sync_node(ctx, { nodeId });

	if (args.kind === "folder") {
		return Result({ _yay: nodeId });
	}

	// Content callers insert the file's content docs (and real stats) right after this returns,
	// still inside the same mutation. Keep the assetId invariant here: every file with text
	// content links a content or version-snapshot asset.
	if (args.expectsTextContent) {
		if (!args.assetId) {
			const errorMessage = "fileNode.assetId is not set";
			const errorData = {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				nodeId,
			};
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}
		return Result({ _yay: nodeId });
	}

	// A file with no processable text content (e.g. a raw upload) still gets a stats doc, flagged
	// unprocessable with -1. A later materialization overwrites it with real counts if text appears.
	await files_nodes_db_upsert_file_stats(ctx, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		nodeId,
		lineCount: files_STATS_UNPROCESSABLE,
		wordCount: files_STATS_UNPROCESSABLE,
		charCount: files_STATS_UNPROCESSABLE,
	});
	return Result({ _yay: nodeId });
}
/**
 * Refuse a create while a Move holds its parent or its first missing name. Batch doors call this in
 * their validation pass, so the item is refused before earlier items are written.
 */
export async function files_nodes_db_check_create_busy(
	ctx: MutationCtx,
	args: Pick<Doc<"files_nodes">, "organizationId" | "workspaceId"> & {
		parentNode: Doc<"files_nodes"> | null;
		name: string;
	},
) {
	const organizationId = ctx.db.normalizeId("organizations", args.organizationId);
	const workspaceId = ctx.db.normalizeId("organizations_workspaces", args.workspaceId);
	if (!organizationId || !workspaceId) return Result({ _yay: null });
	const parentId = args.parentNode?._id ?? files_ROOT_ID;
	return await files_move_reservations_db_check(ctx.db, {
		parent: parentId === files_ROOT_ID ? { kind: "root" } : { kind: "saved", id: parentId },
		slot: { organizationId, workspaceId, parentId, name: args.name },
	});
}
/**
 * Create a node from a path, creating each missing parent folder segment before
 * creating the final file/folder segment.
 *
 * Trust callers to pass a valid, normalized path for the requested leaf kind.
 */
export async function files_nodes_db_create_node_recursively_at_path(
	ctx: MutationCtx,
	args: {
		userId: Doc<"files_nodes">["createdBy"];
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		parentId: Doc<"files_nodes">["parentId"];
		path: string;
		kind: Doc<"files_nodes">["kind"];
		contentType?: Doc<"files_nodes">["contentType"];
		assetId?: Id<"files_r2_assets">;
		archiveOperationId?: Doc<"files_nodes">["archiveOperationId"];
		/** Forwarded to `db_insert_node` for the leaf only; see the arg doc there. */
		expectsTextContent?: true;
		/**
		 * Metadata for the leaf file or folder only. Import names must not spread to ancestors.
		 */
		metadata?: files_metadata_Entry[];
		/**
		 * Initial metadata on each new node. Reused nodes keep their existing maps.
		 */
		createdNodesMetadata?: files_metadata_Entry[];
		now: number;
		/**
		 * Trusted delegated facts; ordinary callers use their explicit human author.
		 */
		writeContext?: files_nodes_WriteContext;
		/**
		 * Initial local policy on the leaf. It requires manage permission before any insert,
		 * unless `trustPolicySource` marks it as verified source settings from a copy.
		 */
		writePolicy?: Doc<"files_nodes">["writePolicy"];
		/**
		 * Initial default on a new leaf folder. Same manage rule as `writePolicy`, unless
		 * `trustPolicySource` marks it as verified source settings from a copy.
		 */
		newChildWritePolicy?: Doc<"files_nodes">["newChildWritePolicy"];
		/**
		 * Set only by server copy paths that read both settings from the source doc itself.
		 * It skips the manage check but keeps the destination writer check. Never set this
		 * from client input.
		 */
		trustPolicySource?: true;
		/**
		 * Set only when a replace copies `writePolicy` from the file it replaces. It keeps the manage
		 * check but skips the writer check. Those writers were checked when the rule was set, and a
		 * writer who left since then must not stop the others from replacing the file.
		 */
		keepsReplacedPolicy?: true;
		/**
		 * Set only when the caller just archived the file at this same path to replace it. The new file
		 * keeps that name and path, so an old name over the length limit stays usable.
		 */
		replacesArchivedFile?: true;
		/**
		 * Set only by a copy run that produced `parentId` itself. The create may proceed while
		 * the parent's current policy still equals this value, even when the value is a lock.
		 * Never set this from client input.
		 */
		expectedParentWritePolicy?: Doc<"files_nodes">["writePolicy"];
		/**
		 * Folders by path that earlier creates of this request already found or made. Pass one new map
		 * per request with the same writer on every call: a hit skips the folder's lookup and access
		 * checks, so one request walks each folder once. This helper fills it.
		 */
		folders?: Map<string, Doc<"files_nodes">>;
	},
) {
	let parentNode =
		args.parentId === files_ROOT_ID ? null : await files_saved_placement_db_get_node(ctx.db, args.parentId);
	// Only an active folder takes children. An archived parent is hidden, so a live child created
	// there would be hidden too until a restore.
	if (
		args.parentId !== files_ROOT_ID &&
		(!parentNode ||
			parentNode.organizationId !== args.organizationId ||
			parentNode.workspaceId !== args.workspaceId ||
			parentNode.kind !== "folder" ||
			parentNode.archiveOperationId !== null)
	) {
		return Result({ _nay: { message: "Not found" } });
	}

	const segments = path_extract_segments_from(args.path);
	let parentPath = parentNode?.path ?? "/";
	let firstMissing = 0;
	const writeContext: files_nodes_WriteContext | null =
		args.userId === users_SYSTEM_AUTHOR
			? null
			: (args.writeContext ?? {
					subject: { kind: "user", userId: args.userId, plugin: null },
					writer: { kind: "user", userId: args.userId },
					actorUserId: args.userId,
					resourceScope: { kind: "workspace" },
					policyReach: "ancestors",
				});

	// The last existing folder walked into. Once the walk goes one folder deeper, it is above where the
	// item lands.
	let above: Doc<"files_nodes"> | null = null;
	// Resolve every existing segment before creating anything. A later refusal must leave no folders.
	for (const [i, name] of segments.entries()) {
		const known = i < segments.length - 1 ? args.folders?.get(path_join(parentPath, name)) : undefined;
		if (known) {
			parentNode = known;
			parentPath = known.path;
			above = known;
			continue;
		}
		const existing = await files_saved_placement_db_get_slot(ctx.db, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			parentId: parentNode?._id ?? files_ROOT_ID,
			name,
		});
		firstMissing = i;
		if (!existing) {
			break;
		}

		const isLeaf = i === segments.length - 1;
		if (existing.kind !== "folder" || isLeaf) {
			if (
				writeContext &&
				!(await db_has_write_context_permission(ctx, {
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					writeContext,
					node: existing,
					permission: "content.write",
				}))
			) {
				return Result({ _nay: { message: "Permission denied" } });
			}
			if (isLeaf && args.archiveOperationId != null) {
				break;
			}
			return Result({
				_nay: { message: isLeaf && args.kind === "file" ? "This file already exists." : "This folder already exists." },
			});
		}

		// A folder above where the item lands needs write for the actor or for the full subject. Where it
		// lands, the full subject decides (the checks below), so a plugin root or an account grant on a
		// nested folder still works.
		if (
			writeContext &&
			above &&
			!(await access_control_db_can_act_on_file_node(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				subject: { kind: "user", userId: writeContext.actorUserId, plugin: null },
				fileNode: above,
				permission: "content.write",
			})) &&
			!(await access_control_db_can_act_on_file_node(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				subject: writeContext.subject,
				fileNode: above,
				permission: "content.write",
			}))
		) {
			return Result({ _nay: { message: "Permission denied" } });
		}
		parentNode = existing;
		parentPath = existing.path;
		above = existing;
		args.folders?.set(existing.path, existing);
	}

	const missingNames = segments.slice(firstMissing);
	const intendedPath = missingNames.reduce((path, name) => path_join(path, name), parentPath);
	const newFolders = files_check_new_folder_count(missingNames.length - (args.kind === "file" ? 1 : 0));
	if (newFolders._nay) return newFolders;
	// Check only the names this create adds: an older folder on the way may keep a longer name.
	if (!args.replacesArchivedFile) {
		const tooLong = files_check_name_and_path_length({ names: missingNames, path: intendedPath });
		if (tooLong._nay) return tooLong;
	}
	if (writeContext) {
		const target = { kind: "create" as const, parentNode, path: intendedPath };
		if (
			!(await db_has_write_context_permission(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				writeContext,
				node: parentNode,
				permission: "content.write",
			}))
		) {
			return Result({ _nay: { message: "Permission denied" } });
		}

		const writable = await files_nodes_db_require_writable(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			writeContext,
			target,
		});
		// A copy run may create inside the parent it produced while that parent's current
		// policy still equals the value the run wrote. Any other refusal stands.
		if (
			writable._nay &&
			(writable._nay.name !== "read_only" ||
				args.expectedParentWritePolicy == null ||
				JSON.stringify(parentNode?.writePolicy ?? null) !== JSON.stringify(args.expectedParentWritePolicy))
		) {
			return writable;
		}

		if (args.writePolicy !== undefined || args.newChildWritePolicy !== undefined) {
			if (args.trustPolicySource) {
				for (const policy of [args.writePolicy, args.newChildWritePolicy]) {
					if (policy === undefined) {
						continue;
					}
					const copiable = await files_nodes_db_require_copiable_write_policy(ctx, {
						organizationId: args.organizationId,
						workspaceId: args.workspaceId,
						writePolicy: policy,
					});
					if (copiable._nay) {
						return copiable;
					}
				}
			} else {
				// Check every explicit override. A default-only create must not skip
				// the writer check by falling back to writePolicy: null.
				for (const policy of [args.writePolicy, args.newChildWritePolicy]) {
					if (policy === undefined) {
						continue;
					}
					const managed = await files_nodes_db_require_write_policy_management(ctx, {
						organizationId: args.organizationId,
						workspaceId: args.workspaceId,
						writeContext,
						target,
						// A null rule checks only the manage permission.
						writePolicy: args.keepsReplacedPolicy ? null : policy,
					});
					if (managed._nay) {
						return managed;
					}
				}
			}
		}
	}

	if (missingNames[0] !== undefined) {
		const busy = await files_nodes_db_check_create_busy(ctx, { ...args, parentNode, name: missingNames[0] });
		if (busy._nay) return busy;
	}

	let currentParent = parentNode?._id ?? files_ROOT_ID;
	let createdParent: Doc<"files_nodes"> | undefined;
	let path = parentPath;
	for (const [i, name] of missingNames.entries()) {
		const isLeaf = i === missingNames.length - 1;
		path = path_join(path, name);
		const nodeIdResult = await db_insert_node(ctx, {
			userId: args.userId,
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			parentId: currentParent,
			name,
			path,
			kind: isLeaf ? args.kind : "folder",
			contentType: isLeaf ? args.contentType : undefined,
			assetId: isLeaf ? args.assetId : undefined,
			archiveOperationId: isLeaf ? args.archiveOperationId : undefined,
			expectsTextContent: isLeaf ? args.expectsTextContent : undefined,
			writePolicy: isLeaf ? args.writePolicy : undefined,
			newChildWritePolicy: isLeaf ? args.newChildWritePolicy : undefined,
			parent: createdParent,
			now: args.now,
		});
		if (nodeIdResult._nay) {
			return nodeIdResult;
		}
		// One read here replaces the two parent reads of the next insert.
		if (!isLeaf) {
			createdParent = (await ctx.db.get("files_nodes", nodeIdResult._yay))!;
			args.folders?.set(path, createdParent);
		}

		const metadata =
			isLeaf && args.metadata
				? files_metadata_apply_set_and_remove(args.createdNodesMetadata ?? [], { set: args.metadata, remove: [] })
				: args.createdNodesMetadata;
		if (metadata) {
			const createdNode = await ctx.db.get("files_nodes", nodeIdResult._yay);
			if (!createdNode) {
				const errorMessage = "created node is missing right after insert";
				const errorData = { nodeId: nodeIdResult._yay };
				console.error(errorMessage, errorData);
				throw should_never_happen(errorMessage, errorData);
			}
			await files_metadata_db_write_entries(ctx, { fileNode: createdNode, entries: metadata });
		}

		if (isLeaf) {
			return Result({ _yay: nodeIdResult._yay });
		}
		currentParent = nodeIdResult._yay;
	}

	const errorMessage = "nodeId not resolved after node path creation";
	const errorData = {};
	console.error(errorMessage, errorData);
	throw should_never_happen(errorMessage, errorData);
}
