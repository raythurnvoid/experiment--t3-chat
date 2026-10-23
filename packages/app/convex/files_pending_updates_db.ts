// Shared database bodies. Keep editor and action work on their current owners.

import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import type { Id } from "./_generated/dataModel.js";
import { internal } from "./_generated/api.js";
import { files_nodes_db_get_content_version } from "./files_nodes_db.ts";
import { files_nodes_db_require_user_writable } from "../server/files-write-policy.ts";
import { files_pending_target_db_get_private } from "./files_pending_target.ts";
import { files_transfer_source_versions_equal } from "./files_transfer.ts";
import { should_never_happen } from "../shared/shared-utils.ts";
import { Result } from "common/errors-as-values-utils.ts";
import { organizations_db_get_membership } from "./organizations_memberships_db.ts";
import { organizations_membership_lifetimes_db_get } from "./organizations_membership_lifetimes.ts";
import { files_move_reservations_db_note_source } from "../server/files-move-reservations.ts";
import { access_control_db_authorize_node } from "./access_control.ts";
import { files_pending_update_index_revision } from "../shared/files.ts";
import { r2_PUT_MAY_ARRIVE_MARGIN_MS, r2_create_asset_key, r2_enqueue_object_deletion_job } from "./r2_assets.ts";
import { files_metadata_db_delete_pending } from "./files_metadata.ts";
import type { files_pending_updates_CohortContentContext } from "./files_pending_updates.ts";

/**
 * How many docs of each chunk table a caller deletes inline. A small draft is gone at once. A big
 * draft has about 3,000 of each, and deleting them all in one mutation passes the Convex limits.
 */
const INLINE_CHUNK_DELETE_LIMIT = 128;

/**
 * Delete the proposal's pending chunk and metadata docs. Every caller also deletes the proposal or
 * moves its revision on, so readers skip any chunk left here. A background drain deletes those.
 */
export async function files_pending_update_db_delete_chunks(
	ctx: MutationCtx,
	args: { pendingUpdateId: Id<"files_pending_updates"> },
) {
	const [textChunks, plainTextChunks] = await Promise.all([
		ctx.db
			.query("files_text_chunks")
			.withIndex("by_pendingUpdate_chunkIndex", (q) =>
				q.eq("pendingUpdateId", args.pendingUpdateId).eq("moveView.cohortId", undefined).eq("moveView.view", undefined),
			)
			.take(INLINE_CHUNK_DELETE_LIMIT + 1),
		ctx.db
			.query("files_plain_text_chunks")
			.withIndex("by_pendingUpdate_chunkIndex", (q) =>
				q.eq("pendingUpdateId", args.pendingUpdateId).eq("moveView.cohortId", undefined).eq("moveView.view", undefined),
			)
			.take(INLINE_CHUNK_DELETE_LIMIT + 1),
	]);
	// The Move guard would read each doc again before its delete.
	for (const [table, docs] of [
		["files_text_chunks", textChunks],
		["files_plain_text_chunks", plainTextChunks],
	] as const)
		for (const doc of docs) files_move_reservations_db_note_source(ctx.db, { table, id: doc._id, old: doc });
	await Promise.all([
		...plainTextChunks
			.slice(0, INLINE_CHUNK_DELETE_LIMIT)
			.map((chunk) => ctx.db.delete("files_plain_text_chunks", chunk._id)),
		...textChunks.slice(0, INLINE_CHUNK_DELETE_LIMIT).map((chunk) => ctx.db.delete("files_text_chunks", chunk._id)),
		// Metadata docs are bounded by the per-file metadata caps, so they all go here.
		files_metadata_db_delete_pending(ctx, args),
		...(textChunks.length > INLINE_CHUNK_DELETE_LIMIT || plainTextChunks.length > INLINE_CHUNK_DELETE_LIMIT
			? [ctx.scheduler.runAfter(0, internal.files_pending_updates.drain_pending_update_docs, args)]
			: []),
	]);
}

/**
 * Keep unchanged text indexes tied to the new proposal revision. A full draft has thousands of
 * docs, so patching them all can pass the Convex limits. Point the new revision at the docs'
 * revision on the proposal instead. Call it in the mutation that bumps the revision by 1.
 */
export async function files_pending_update_db_update_index_revision(
	ctx: MutationCtx,
	args: { pendingUpdateId: Id<"files_pending_updates">; proposalRevision: number },
) {
	const pendingUpdate = await ctx.db.get("files_pending_updates", args.pendingUpdateId);
	if (!pendingUpdate) throw should_never_happen("Pending update is missing", args);
	// Some callers bump the revision first, so read the docs' revision from the one before.
	const docs = files_pending_update_index_revision({
		revision: args.proposalRevision - 1,
		indexRevision: pendingUpdate.indexRevision,
	});
	const indexRevision = { docs, proposal: args.proposalRevision };
	await ctx.db.patch("files_pending_updates", pendingUpdate._id, { indexRevision });
	return indexRevision;
}

/**
 * Every content page proves current authority. The reservation grants no access.
 */
export async function files_pending_updates_db_get_cohort_content(
	ctx: QueryCtx | MutationCtx,
	args: files_pending_updates_CohortContentContext,
) {
	const cohort = await ctx.db.get("files_move_cohorts", args.cohortId);
	const content = await ctx.db.get("files_move_cohort_content", args.contentId);
	if (
		!cohort ||
		!content ||
		content.cohortId !== cohort._id ||
		cohort.fence !== args.fence ||
		cohort.attemptFence !== args.attemptFence ||
		content.preparationFence !== args.preparationFence ||
		cohort.phase !== "staging" ||
		cohort.visibleView !== "before"
	)
		return Result({ _nay: { name: "stopped", message: "This Move step is no longer current." } });
	const membership = await organizations_db_get_membership(ctx, {
		membershipId: cohort.membershipId,
		userId: cohort.userId,
	});
	const lifetime = await organizations_membership_lifetimes_db_get(ctx, cohort);
	if (
		!membership ||
		membership.organizationId !== cohort.organizationId ||
		membership.workspaceId !== cohort.workspaceId ||
		!lifetime?.active ||
		lifetime.membershipId !== membership._id ||
		lifetime.lifetime !== cohort.membershipLifetime
	)
		return Result({ _nay: { message: "Unauthorized" } });
	const item = await ctx.db.get("files_move_cohort_items", content.itemId);
	const proposal = await ctx.db.get("files_pending_updates", content.pendingUpdateId);
	if (
		!item ||
		item.cohortId !== cohort._id ||
		item.contentId !== content._id ||
		!proposal ||
		proposal.organizationId !== cohort.organizationId ||
		proposal.workspaceId !== cohort.workspaceId ||
		proposal.userId !== cohort.userId ||
		proposal.revision !== content.reviewedRevision ||
		item.pendingUpdateId !== proposal._id ||
		item.reviewedRevision !== proposal.revision ||
		item.target.kind !== proposal.target.kind ||
		item.target.id !== proposal.target.id ||
		item.selectedContentStateId !== content.selectedContentStateId
	)
		return Result({ _nay: { name: "target_changed", message: "The proposal changed after it was reviewed." } });
	if (proposal.target.kind === "saved") {
		const access = await access_control_db_authorize_node(ctx, {
			membership,
			userAuth: { id: cohort.userId },
			nodeId: proposal.target.id,
			permission: "content.write",
		});
		if (access._nay) return access;
		const writable = await files_nodes_db_require_user_writable(ctx, {
			node: access._yay.fileNode,
			userId: cohort.userId,
		});
		if (writable._nay) return writable;
		if (
			!files_transfer_source_versions_equal(
				await files_nodes_db_get_content_version(ctx, access._yay.fileNode),
				content.beforeContentVersion,
			)
		)
			return Result({ _nay: { name: "target_changed", message: "The file changed after it was reviewed." } });
	} else {
		const data = await files_pending_target_db_get_private(ctx, {
			membership,
			privateNodeId: proposal.target.id,
			pendingUpdateId: proposal._id,
		});
		if (data._nay) return data;
		if (
			!data._yay.canAcceptWithParents ||
			data._yay.readiness !== "ready" ||
			!item.privateVersion ||
			data._yay.node.creationGeneration !== item.privateVersion.creationGeneration ||
			data._yay.node.structuralRevision !== item.privateVersion.structuralRevision
		)
			return Result({ _nay: { name: "target_changed", message: "This draft changed. Review it again." } });
	}
	return Result({ _yay: { cohort, content, item, proposal, membership } });
}

/**
 * Hand a staged replacement asset to the deletion ledger and delete its doc.
 *
 * The staged object sits under its final key, so the unfinalized-asset sweeper never touches it.
 * Only this release removes it. Discard, expiry, a write that supersedes the copy, a refused
 * commit, and account deletion all call it.
 */
export async function files_pending_update_db_release_replacement_asset(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		assetId: Id<"files_r2_assets">;
	},
) {
	const asset = await ctx.db.get("files_r2_assets", args.assetId);
	if (!asset || asset.organizationId !== args.organizationId || asset.workspaceId !== args.workspaceId) {
		return;
	}

	// Add the job before deleting the doc. Both save together, so a crash cannot lose the cleanup.
	await r2_enqueue_object_deletion_job(ctx, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		r2Key:
			asset.r2Key ??
			r2_create_asset_key({
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				assetId: asset._id,
			}),
		reason: "discarded_replacement",
		...(asset.putMayArriveUntil !== undefined
			? { putMayArriveUntil: asset.putMayArriveUntil }
			: (asset.uploadUrlExpiresAt ?? asset.unfinalizedExpiresAt) !== undefined
				? { putMayArriveUntil: (asset.uploadUrlExpiresAt ?? asset.unfinalizedExpiresAt)! + r2_PUT_MAY_ARRIVE_MARGIN_MS }
				: {}),
	});
	await ctx.db.delete("files_r2_assets", asset._id);
}
