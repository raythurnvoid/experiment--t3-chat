import type { Id } from "../convex/_generated/dataModel.js";
import type { QueryCtx } from "../convex/_generated/server.js";

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
