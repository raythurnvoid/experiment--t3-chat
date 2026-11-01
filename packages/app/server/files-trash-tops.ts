// Derived Trash tops. Keep this leaf module safe for every mutation's write flush.
import { internal } from "../convex/_generated/api.js";
import type { Doc, Id } from "../convex/_generated/dataModel.js";
import type { MutationCtx } from "../convex/_generated/server.js";
import { files_saved_placement_db_get_node } from "./files-saved-placement.ts";

const PAGE_SIZE = 64;
const MOVE_RETRY_MS = 1000;
const RECOVERY_DELAY_MS = 60_000;
const RECOVERY_BATCH_SIZE = 50;

type Placement = Pick<
	Doc<"files_nodes">,
	"archiveOperationId" | "parentId" | "restrictedScopeNodeId" | "isRestrictedScopeRoot" | "parentScopeNodeId"
>;

/**
 * Derive top membership and area from one saved view's current parent.
 */
export function files_trash_tops_fields(node: Placement, parent: Pick<Placement, "archiveOperationId"> | null) {
	const top = node.archiveOperationId !== null && node.archiveOperationId !== parent?.archiveOperationId;
	return {
		archiveTopScopeNodeId: top
			? node.isRestrictedScopeRoot
				? (node.parentScopeNodeId ?? null)
				: node.restrictedScopeNodeId
			: undefined,
		// Delete ids have a fixed time/UUID form. Reverse ASCII keeps newest first and paths A to Z.
		archiveTopOrder: top
			? Array.from(node.archiveOperationId!, (char) => String.fromCharCode(127 - char.charCodeAt(0))).join("")
			: undefined,
	};
}

/**
 * Refresh a normal node. Its parent may still be in Move's selected saved view during cleanup.
 */
export async function files_trash_tops_db_sync(ctx: MutationCtx, node: Doc<"files_nodes">) {
	if (node.moveCohortId) return;
	if (
		node.archiveOperationId === null &&
		node.archiveTopScopeNodeId === undefined &&
		node.archiveTopOrder === undefined
	)
		return;
	const parent = node.parentId === "root" ? null : await files_saved_placement_db_get_node(ctx.db, node.parentId);
	const fields = files_trash_tops_fields(node, parent);
	if (node.archiveTopScopeNodeId !== fields.archiveTopScopeNodeId || node.archiveTopOrder !== fields.archiveTopOrder)
		await ctx.db.patch("files_nodes", node._id, fields);
}

/**
 * Queue only the child deletes a parent change can affect. Trash waits until these jobs finish.
 */
export async function files_trash_tops_db_parent_changed(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		nodeId: Id<"files_nodes">;
		oldArchive: string | null | undefined;
		archiveOperationId: string | null | undefined;
	},
) {
	const { organizationId, workspaceId, nodeId, oldArchive, archiveOperationId: newArchive } = args;
	// A new node cannot already have children. Its new children derive their own markers.
	if (oldArchive === undefined || oldArchive === newArchive) return;
	for (const archiveOperationId of new Set([oldArchive, newArchive])) {
		if (!archiveOperationId) continue;
		const job = await ctx.db
			.query("files_trash_top_jobs")
			.withIndex("by_parent_archiveOperation", (q) =>
				q.eq("parentId", nodeId).eq("archiveOperationId", archiveOperationId),
			)
			.unique();
		if (job) {
			// A later parent change must revisit children that the worker already passed.
			const step = job.step + 1;
			await ctx.db.patch("files_trash_top_jobs", job._id, { cursor: null, step, updatedAt: Date.now() });
			await ctx.scheduler.runAfter(0, internal.files_trash_tops.advance, { jobId: job._id, step });
			continue;
		}
		const child = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_parent_archiveOperation_name", (q) =>
				q
					.eq("organizationId", organizationId)
					.eq("workspaceId", workspaceId)
					.eq("moveCohortId", undefined)
					.eq("parentId", nodeId)
					.eq("archiveOperationId", archiveOperationId),
			)
			.first();
		if (!child) continue;
		const jobId = await ctx.db.insert("files_trash_top_jobs", {
			organizationId,
			workspaceId,
			parentId: nodeId,
			archiveOperationId,
			cursor: null,
			step: 0,
			updatedAt: Date.now(),
		});
		await ctx.scheduler.runAfter(0, internal.files_trash_tops.advance, { jobId, step: 0 });
	}
}

/**
 * Repair one child page. The step guard stops old or repeated scheduled calls.
 */
export async function files_trash_tops_db_advance(
	ctx: MutationCtx,
	args: { jobId: Id<"files_trash_top_jobs">; step: number },
) {
	const { jobId } = args;
	const job = await ctx.db.get("files_trash_top_jobs", jobId);
	if (!job || job.step !== args.step) return;
	const step = job.step + 1;
	// Move owns held nodes and both saved views. Wait until its physical cleanup ends.
	const slot = await ctx.db
		.query("files_move_workspace_slots")
		.withIndex("by_workspace", (q) => q.eq("organizationId", job.organizationId).eq("workspaceId", job.workspaceId))
		.unique();
	if (slot?.cohortId) {
		await ctx.db.patch("files_trash_top_jobs", jobId, { step, updatedAt: Date.now() });
		await ctx.scheduler.runAfter(MOVE_RETRY_MS, internal.files_trash_tops.advance, { jobId, step });
		return;
	}
	const page = await ctx.db
		.query("files_nodes")
		.withIndex("by_organization_workspace_parent_archiveOperation_name", (q) =>
			q
				.eq("organizationId", job.organizationId)
				.eq("workspaceId", job.workspaceId)
				.eq("moveCohortId", undefined)
				.eq("parentId", job.parentId)
				.eq("archiveOperationId", job.archiveOperationId),
		)
		.paginate({ cursor: job.cursor, numItems: PAGE_SIZE });
	for (const node of page.page) await files_trash_tops_db_sync(ctx, node);
	if (page.isDone) await ctx.db.delete("files_trash_top_jobs", jobId);
	else {
		await ctx.db.patch("files_trash_top_jobs", jobId, { cursor: page.continueCursor, step, updatedAt: Date.now() });
		await ctx.scheduler.runAfter(0, internal.files_trash_tops.advance, { jobId, step });
	}
}

/**
 * Restart stopped repairs and drain every due batch without waiting for another cron tick.
 */
export async function files_trash_tops_db_recover(ctx: MutationCtx) {
	const now = Date.now();
	const jobs = await ctx.db
		.query("files_trash_top_jobs")
		.withIndex("by_updatedAt", (q) => q.lt("updatedAt", now - RECOVERY_DELAY_MS))
		.take(RECOVERY_BATCH_SIZE);
	for (const job of jobs) {
		await ctx.db.patch("files_trash_top_jobs", job._id, { updatedAt: now });
		await ctx.scheduler.runAfter(0, internal.files_trash_tops.advance, { jobId: job._id, step: job.step });
	}
	if (jobs.length === RECOVERY_BATCH_SIZE) await ctx.scheduler.runAfter(0, internal.files_trash_tops.recover, {});
}
