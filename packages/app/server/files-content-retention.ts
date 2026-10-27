import type { Id } from "../convex/_generated/dataModel.js";
import type { QueryCtx } from "../convex/_generated/server.js";

export async function files_content_retention_db_index_uses_head(db: QueryCtx["db"], headId: Id<"files_saved_content_heads">) {
	const references = await Promise.all([
		db.query("files_index_states").withIndex("by_requestedHead", (q) => q.eq("requestedHeadId", headId)).first(),
		db.query("files_index_states").withIndex("by_publishedHead", (q) => q.eq("publishedHeadId", headId)).first(),
		db.query("files_index_runs").withIndex("by_contentHead", (q) => q.eq("contentHeadId", headId)).first(),
		db.query("files_index_runs").withIndex("by_previousHead", (q) => q.eq("previousHeadId", headId)).first(),
	]);
	return references.some((reference) => reference !== null);
}

/**
 * Preparing and current content both keep their assets until their owner retires.
 */
export async function files_content_retention_db_uses_asset(db: QueryCtx["db"], assetId: Id<"files_r2_assets">) {
	const [content, snapshot] = await Promise.all([
		db.query("files_saved_content_heads")
			.withIndex("by_asset_retired", (q) => q.eq("assetId", assetId).eq("retired", false))
			.first(),
		db.query("files_saved_content_heads")
			.withIndex("by_snapshotAsset_retired", (q) => q.eq("snapshotAssetId", assetId).eq("retired", false))
			.first(),
	]);
	return content !== null || snapshot !== null;
}
