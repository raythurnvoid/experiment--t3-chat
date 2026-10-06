// Final transaction for the temporary New file action's fixed Welcome document.
// General text, mount, and import creation still use files_nodes_content.ts.

import { v } from "convex/values";
import { Result } from "common/errors-as-values-utils.ts";
import { internalMutation } from "./functions.ts";
import { v_result } from "../server/convex-utils.ts";
import { files_INITIAL_CONTENT, files_ROOT_ID } from "../shared/files.ts";
import { should_never_happen } from "../shared/shared-utils.ts";
import {
	files_nodes_create_db_create_node,
	files_nodes_db_hand_unpublished_assets_to_deletion_ledger,
	files_nodes_db_insert_committed_text_chunks,
	files_nodes_db_finalize_editable_text_node_creation,
	files_compute_wc_counts,
} from "./files_nodes_create_db.ts";

export const experimental_reuseContext = true;

export const finalize_text_node_creation = internalMutation({
	args: {
		userId: v.id("users"),
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		parentId: v.union(v.id("files_nodes"), v.literal(files_ROOT_ID)),
		path: v.string(),
		yjsSnapshotAssetId: v.id("files_r2_assets"),
		versionSnapshotAssetId: v.id("files_r2_assets"),
		plainTextContent: v.string(),
	},
	returns: v_result({ _yay: v.object({ nodeId: v.id("files_nodes") }) }),
	handler: async (ctx, args) => {
		const assetIds = [args.yjsSnapshotAssetId, args.versionSnapshotAssetId];
		const refuse = async (nay: { name?: string; message: string }) => {
			await files_nodes_db_hand_unpublished_assets_to_deletion_ledger(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				assetIds,
				reason: "read_only_create",
			});
			return Result({ _nay: nay });
		};

		const membership = await ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_active_user_organization_workspace", (q) =>
				q
					.eq("active", true)
					.eq("userId", args.userId)
					.eq("organizationId", args.organizationId)
					.eq("workspaceId", args.workspaceId),
			)
			.first();
		if (!membership || membership.pendingOrganizationRemoval) {
			return await refuse({ message: "Permission denied" });
		}

		// The shared walk rechecks parent and prefix access, conflicts, and the local writer rule.
		const created = await files_nodes_create_db_create_node(ctx, {
			membership,
			parentId: args.parentId,
			path: args.path,
			kind: "file",
			assetId: args.versionSnapshotAssetId,
		});
		if (created._nay) {
			return await refuse(created._nay);
		}

		const nodeId = created._yay.nodeId;
		const node = await ctx.db.get("files_nodes", nodeId);
		if (!node) {
			const errorMessage = "created file node is missing right after insert";
			const errorData = { nodeId };
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}

		const now = Date.now();
		const [yjsSnapshotId, yjsLastSequenceId, statsId] = await Promise.all([
			ctx.db.insert("files_yjs_snapshots", {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				fileNodeId: nodeId,
				sequence: 0,
				assetId: args.yjsSnapshotAssetId,
				createdBy: args.userId,
				updatedBy: args.userId,
				updatedAt: now,
			}),
			ctx.db.insert("files_yjs_docs_last_sequences", {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				fileNodeId: nodeId,
				lastSequence: 0,
				unmaterializedUpdateCount: 0,
				unmaterializedUpdateBytes: 0,
				lineageGeneration: 0,
			}),
			ctx.db.insert("file_stats", {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				fileNodeId: nodeId,
				...files_compute_wc_counts(files_INITIAL_CONTENT),
			}),
		]);
		// Welcome is one short Markdown section with no frontmatter. Its parity test guards this contract.
		await files_nodes_db_insert_committed_text_chunks(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId,
			path: node.path,
			yjsSequence: 0,
			chunks: [
				{
					chunkIndex: 0,
					textChunk: files_INITIAL_CONTENT,
					plainTextChunk: args.plainTextContent,
					startIndex: 0,
					endIndex: files_INITIAL_CONTENT.length,
					lineStart: 1,
					lineEnd: files_INITIAL_CONTENT.split("\n").length,
					chunkFlags: 0,
				},
			],
		});
		await ctx.db.patch("files_nodes", nodeId, {
			yjsSnapshotId,
			yjsLastSequenceId,
			statsId,
			textKind: "rich_text",
			collaborationEnabled: true,
		});

		const [yjsAsset, versionAsset] = await Promise.all([
			ctx.db.get("files_r2_assets", args.yjsSnapshotAssetId),
			ctx.db.get("files_r2_assets", args.versionSnapshotAssetId),
		]);
		if (!yjsAsset || !versionAsset) {
			const errorMessage = "Editable file creation asset id points to a missing files_r2_assets doc";
			const errorData = {
				nodeId,
				yjsSnapshotAssetId: args.yjsSnapshotAssetId,
				versionSnapshotAssetId: args.versionSnapshotAssetId,
			};
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}
		// Every insert, asset publication, and first version saves together. Later failures must throw.
		await files_nodes_db_finalize_editable_text_node_creation(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId,
			userId: args.userId,
			yjsSnapshot: { assetId: args.yjsSnapshotAssetId, size: yjsAsset.size },
			versionSnapshotAssetId: args.versionSnapshotAssetId,
			versionSnapshotSize: versionAsset.size,
		});
		return created;
	},
});
