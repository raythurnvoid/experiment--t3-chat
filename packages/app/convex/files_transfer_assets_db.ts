// Shared database bodies. Keep editor and action work on their current owners.

import type { MutationCtx } from "./_generated/server.js";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api.js";
import { r2_create_asset_key, r2_enqueue_object_deletion_job } from "./r2_client.ts";
import { files_media_dependencies_db_retire } from "./files_media_dependencies.ts";

export async function files_nodes_content_db_discard_transfer_file_attempt(
	ctx: MutationCtx,
	args: {
		itemId: Id<"files_transfer_items">;
		attempt: number;
		workId?: NonNullable<Doc<"files_transfer_items">["workId"]>;
	},
) {
	const item = await ctx.db.get("files_transfer_items", args.itemId);
	if (
		!item ||
		item.attempt !== args.attempt ||
		(args.workId !== undefined && item.workId !== args.workId) ||
		item.stagedAssetIds.length === 0
	)
		return;

	for (const assetId of item.stagedAssetIds) {
		const asset = await ctx.db.get("files_r2_assets", assetId);
		if (!asset) continue;
		await r2_enqueue_object_deletion_job(ctx, {
			organizationId: asset.organizationId as Id<"organizations">,
			workspaceId: asset.workspaceId as Id<"organizations_workspaces">,
			r2Key: r2_create_asset_key({ organizationId: asset.organizationId, workspaceId: asset.workspaceId, assetId }),
			reason: "failed_create",
			putMayArriveUntil: asset.putMayArriveUntil,
		});
		await ctx.db.delete("files_r2_assets", assetId);
	}

	await ctx.db.patch("files_transfer_items", item._id, { stagedAssetIds: [] });
}

export async function files_transfer_assets_db_retire_states(ctx: MutationCtx, item: Doc<"files_transfer_items">) {
	// Capture preparation can also own the new proposal's three states.
	const states = await ctx.db
		.query("files_pending_update_yjs_states")
		.withIndex("by_owner_transferItem", (q) => q.eq("owner.itemId", item._id))
		.take(4);
	if (states.length === 0) return;
	// Source captures and prepared destination states can belong to different workspaces.
	const cleanupTasks = new Map<Id<"organizations_workspaces">, Id<"files_pending_update_state_cleanup_tasks">>();
	for (const state of states) {
		let cleanupTaskId = cleanupTasks.get(state.workspaceId);
		if (!cleanupTaskId) {
			cleanupTaskId = await ctx.db.insert("files_pending_update_state_cleanup_tasks", {
				organizationId: state.organizationId,
				workspaceId: state.workspaceId,
				createdAt: Date.now(),
			});
			cleanupTasks.set(state.workspaceId, cleanupTaskId);
		}
		await ctx.db.patch("files_pending_update_yjs_states", state._id, { owner: { kind: "retired", cleanupTaskId } });
	}
	await ctx.scheduler.runAfter(0, internal.files_pending_updates.cleanup_expired_pending_state_rows, {});
}

export async function files_nodes_content_db_discard_transfer_file_capture(
	ctx: MutationCtx,
	args: { itemId: Id<"files_transfer_items"> },
) {
	const item = await ctx.db.get("files_transfer_items", args.itemId);
	if (!item?.capture) return;
	await files_transfer_assets_db_retire_states(ctx, item);

	const { mediaSourceSet: _mediaSourceSet, ...capture } = item.capture;
	if (capture.mediaDependencySetId) {
		const set = await ctx.db.get("files_media_dependency_sets", capture.mediaDependencySetId);
		if (set)
			await files_media_dependencies_db_retire(ctx, {
				setId: set._id,
				generation: set.generation,
				owner: { kind: "capture", itemId: item._id },
			});
	}
	const artifact = capture.artifact;
	for (const assetId of artifact
		? [artifact.contentAssetId, ...(artifact.yjsSnapshotAssetId ? [artifact.yjsSnapshotAssetId] : [])]
		: []) {
		const asset = await ctx.db.get("files_r2_assets", assetId);
		if (!asset) continue;
		// A sealed capture has an R2 key, but no saved file owns it yet.
		await r2_enqueue_object_deletion_job(ctx, {
			organizationId: asset.organizationId as Id<"organizations">,
			workspaceId: asset.workspaceId as Id<"organizations_workspaces">,
			r2Key: asset.r2Key!,
			reason: "failed_create",
			putMayArriveUntil: asset.putMayArriveUntil,
		});
		await ctx.db.delete("files_r2_assets", assetId);
	}
	await ctx.db.patch("files_transfer_items", item._id, {
		capture: { ...capture, mediaDependencySetId: undefined, sourceStateId: null, artifact: null },
	});
}
