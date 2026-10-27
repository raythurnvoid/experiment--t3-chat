import { v } from "convex/values";
import { internalMutation } from "./functions.ts";
import { files_archive_repair_scope } from "./files_archive_repair_scope.ts";
import { convex_error } from "../server/convex-utils.ts";
import { crypto_sha256_hex } from "../server/crypto-utils.ts";
import { files_pending_overlay_db_copy_saved_scope } from "../server/files-pending-overlay.ts";

async function hash(doc: unknown) {
	return await crypto_sha256_hex(JSON.stringify(doc, (_key, value: unknown) => {
		if (typeof value === "bigint" || (typeof value === "number" && !Number.isFinite(value)) || value instanceof ArrayBuffer)
			throw convex_error({ message: "Archive repair document cannot be hashed safely" });
		if (value !== null && typeof value === "object" && !Array.isArray(value))
			return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
		return value;
	}));
}

// Temporary operator repair. Every refusal throws so a failed after-check rolls back the write.
export const repair_one = internalMutation({
	args: { index: v.number() },
	returns: v.null(),
	handler: async (ctx, { index }) => {
		if (process.env.CONVEX_CLOUD_URL !== "https://grand-finch-267.convex.cloud")
			throw convex_error({ message: "Archive repair deployment mismatch" });
		if (!Number.isInteger(index) || index < 0 || index >= files_archive_repair_scope.length)
			throw convex_error({ message: "Archive repair index is not approved" });
		const expected = files_archive_repair_scope[index]!;
		const node = await ctx.db.get("files_nodes", expected.nodeId);
		const text = await ctx.db.get("files_text_chunks", expected.textId);
		const search = await ctx.db.get("files_plain_text_chunks", expected.searchId);
		if (
			!node || !text || !search || node.kind !== "file" ||
			node.organizationId !== expected.organizationId || node.workspaceId !== expected.workspaceId ||
			text.organizationId !== expected.organizationId || text.workspaceId !== expected.workspaceId ||
			search.organizationId !== expected.organizationId || search.workspaceId !== expected.workspaceId ||
			text.sourceKind !== "committed" || search.sourceKind !== "committed" ||
			text.fileNodeId !== node._id || search.fileNodeId !== node._id || search.textChunkId !== text._id ||
			node.archiveOperationId !== expected.archiveOperationId || search.archiveOperationId !== undefined ||
			search.path !== node.path || !node.contentHeadId ||
			text.contentHeadId !== node.contentHeadId || search.contentHeadId !== node.contentHeadId ||
			node.moveCohortId || text.moveView || search.moveView
		) throw convex_error({ message: "Archive repair document guard failed" });

		const slot = await ctx.db.query("files_move_workspace_slots")
			.withIndex("by_workspace", (q) => q.eq("organizationId", expected.organizationId).eq("workspaceId", expected.workspaceId))
			.unique();
		const state = await ctx.db.query("files_index_states")
			.withIndex("by_fileNode", (q) => q.eq("fileNodeId", node._id)).unique();
		const job = await ctx.db.query("files_pending_overlay_jobs")
			.withIndex("by_kind_key", (q) => q.eq("kind", "saved_scope").eq("key", node._id)).unique();
		if (slot?.cohortId || (slot && "indexRunId" in slot) || state || job)
			throw convex_error({ message: "Archive repair is blocked by active work" });

		if (
			await hash(node) !== expected.nodeHash || await hash(text) !== expected.textHash ||
			await hash(search) !== expected.searchHash ||
			await hash({ ...search, archiveOperationId: expected.archiveOperationId }) !== expected.afterSearchHash
		) throw convex_error({ message: "Archive repair baseline changed" });

		// The helper also copies path. The guard above requires that path to stay equal.
		await files_pending_overlay_db_copy_saved_scope(ctx, { node, metadataDocs: [], chunks: [search] });
		if (
			await hash(await ctx.db.get("files_nodes", node._id)) !== expected.nodeHash ||
			await hash(await ctx.db.get("files_text_chunks", text._id)) !== expected.textHash ||
			await hash(await ctx.db.get("files_plain_text_chunks", search._id)) !== expected.afterSearchHash
		) throw convex_error({ message: "Archive repair changed an unapproved field" });
		return null;
	},
});
