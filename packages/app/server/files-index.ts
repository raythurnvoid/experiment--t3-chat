// Saved source requests and the shared Move/index publication queue.

import { internal } from "../convex/_generated/api.js";
import type { Doc, Id } from "../convex/_generated/dataModel.js";
import type { MutationCtx } from "../convex/_generated/server.js";
import { should_never_happen } from "../shared/shared-utils.ts";
import { files_saved_content_db_get_head } from "./files-saved-content-head.ts";

type Scope = Pick<Doc<"files_index_states">, "organizationId" | "workspaceId">;
export const files_index_RECOVER_MS = 2 * 60 * 1000;

/**
 * Record work with the source commit. This does not read the workspace publication slot.
 */
export async function files_index_db_request(
	ctx: MutationCtx,
	args: {
		nodeId: Id<"files_nodes">;
		contentChanged?: boolean;
		previousPublishedHeadId?: Id<"files_saved_content_heads"> | null;
	},
) {
	const node = await ctx.db.get("files_nodes", args.nodeId);
	if (!node) throw should_never_happen("Index request has no saved node", args);
	const organizationId = ctx.db.normalizeId("organizations", node.organizationId);
	const workspaceId = ctx.db.normalizeId("organizations_workspaces", node.workspaceId);
	if (!organizationId || !workspaceId) throw should_never_happen("Index requests require a workspace", args);
	const head = node.kind === "file" ? await files_saved_content_db_get_head(ctx.db, node) : null;
	const state = await ctx.db
		.query("files_index_states")
		.withIndex("by_fileNode", (q) => q.eq("fileNodeId", node._id))
		.unique();
	const contentRevision = (state?.contentRevision ?? 0) + (args.contentChanged === false ? 0 : 1);
	const indexRevision = (state?.requestedRevision ?? 0) + 1;
	const changes = {
		contentRevision, requestedRevision: indexRevision, requestedHeadId: head?._id ?? null,
		needsRun: !state?.activeRunId && !state?.movePublication, nextAttemptAt: Date.now() + files_index_RECOVER_MS,
	};
	if (state) await ctx.db.patch("files_index_states", state._id, changes);
	else
		await ctx.db.insert("files_index_states", {
			organizationId,
			workspaceId,
			fileNodeId: node._id,
			...changes,
			// Source replacement passes its previous owner. Metadata-only work keeps the current one.
			publishedRevision: 0,
			publishedHeadId: args.previousPublishedHeadId === undefined ? (head?._id ?? null) : args.previousPublishedHeadId,
			activeRunId: null,
			movePublication: null,
		});
	if (!state?.activeRunId) await ctx.scheduler.runAfter(0, internal.files_index.start, { nodeId: node._id });
	return { contentRevision, indexRevision };
}

/**
 * Reserve the accepted index's number before the Move flips. Later Saves get later numbers.
 */
export async function files_index_db_prepare_move(
	ctx: MutationCtx,
	args: Scope & {
		nodeId: Id<"files_nodes">;
		cohortId: Id<"files_move_cohorts">;
		headId: Id<"files_saved_content_heads"> | null;
		contentChanged: boolean;
	},
) {
	const state = await ctx.db
		.query("files_index_states")
		.withIndex("by_fileNode", (q) => q.eq("fileNodeId", args.nodeId))
		.unique();
	if (state?.movePublication?.cohortId === args.cohortId) return;
	if (state?.movePublication) throw should_never_happen("Saved indexes have two Move owners", args);
	const head = await files_saved_content_db_get_head(ctx.db, args.nodeId);
	const contentRevision = (state?.contentRevision ?? 0) + (args.contentChanged ? 1 : 0);
	const indexRevision = (state?.requestedRevision ?? 0) + 1;
	const changes = {
		contentRevision,
		requestedRevision: indexRevision,
		needsRun: false,
		nextAttemptAt: Date.now() + files_index_RECOVER_MS,
		movePublication: { cohortId: args.cohortId, indexRevision, contentRevision, headId: args.headId },
	};
	if (state) await ctx.db.patch("files_index_states", state._id, changes);
	else
		await ctx.db.insert("files_index_states", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			fileNodeId: args.nodeId,
			...changes,
			requestedHeadId: head?._id ?? null,
			publishedRevision: 0,
			publishedHeadId: head?._id ?? null,
			activeRunId: null,
		});
}

/**
 * The slot still belongs to Move here. Promote its pointer before the next publisher can enter.
 */
export async function files_index_db_finish_move(
	ctx: MutationCtx,
	args: { nodeId: Id<"files_nodes">; cohortId: Id<"files_move_cohorts">; published: boolean },
) {
	const state = await ctx.db
		.query("files_index_states")
		.withIndex("by_fileNode", (q) => q.eq("fileNodeId", args.nodeId))
		.unique();
	const side = state?.movePublication;
	if (!state || side?.cohortId !== args.cohortId) return;
	const head = await files_saved_content_db_get_head(ctx.db, args.nodeId);
	const needsRun = !state.activeRunId && (!args.published || state.requestedRevision > side.indexRevision);
	await ctx.db.patch("files_index_states", state._id, {
		movePublication: null,
		needsRun, nextAttemptAt: Date.now() + files_index_RECOVER_MS,
		...(state.requestedRevision === side.indexRevision ? { requestedHeadId: head?._id ?? null } : {}),
		...(args.published ? { publishedRevision: side.indexRevision, publishedHeadId: side.headId } : {}),
	});
	if (args.published)
		for (const headId of new Set([state.publishedHeadId, state.requestedHeadId]))
			if (headId && headId !== side.headId)
				await ctx.scheduler.runAfter(0, internal.files_content_saves.retire, { headId });
	if (needsRun)
		await ctx.scheduler.runAfter(0, internal.files_index.start, { nodeId: args.nodeId });
}

function ticket_key(owner: Doc<"files_index_tickets">["owner"]) {
	if (owner.kind === "index") return `index:${owner.runId}`;
	if (owner.kind === "transfer") return `transfer:${owner.runId}:${owner.itemId}:${owner.fence}:${owner.attemptFence}`;
	return `review:${owner.runId}:${owner.unitId}:${owner.planEpoch}:${owner.fence}:${owner.attemptFence}`;
}

/**
 * Creation order is the ready order. Retries keep the same ticket and place in the queue.
 */
export async function files_index_db_ticket(
	ctx: MutationCtx,
	args: Scope & { owner: Doc<"files_index_tickets">["owner"] },
) {
	const key = ticket_key(args.owner);
	const existing = await ctx.db
		.query("files_index_tickets")
		.withIndex("by_organization_workspace_key", (q) =>
			q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("key", key),
		)
		.unique();
	const ticketId = existing?._id ?? (await ctx.db.insert("files_index_tickets", { ...args, key }));
	const first = await ctx.db
		.query("files_index_tickets")
		.withIndex("by_organization_workspace", (q) =>
			q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId),
		)
		.first();
	return { ticketId, first: first?._id === ticketId };
}

export async function files_index_db_release_ticket(
	ctx: MutationCtx,
	args: Scope & { owner: Doc<"files_index_tickets">["owner"] },
) {
	const key = ticket_key(args.owner);
	const ticket = await ctx.db
		.query("files_index_tickets")
		.withIndex("by_organization_workspace_key", (q) =>
			q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("key", key),
		)
		.unique();
	if (ticket) await ctx.db.delete("files_index_tickets", ticket._id);
	await ctx.scheduler.runAfter(0, internal.files_index.wake, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
	});
}
