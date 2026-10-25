// Shared database bodies. Keep editor and action work on their current owners.

import { Result } from "common/errors-as-values-utils.ts";
import type { WithoutSystemFields } from "convex/server";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import { organizations_db_get_membership } from "./organizations_memberships_db.ts";
import { organizations_membership_lifetimes_db_get } from "./organizations_membership_lifetimes.ts";
import { access_control_db_authorize_node, access_control_db_authorize_membership } from "./access_control.ts";
import { files_nodes_db_get_content_version } from "./files_nodes_db.ts";
import { files_nodes_db_require_user_writable } from "../server/files-write-policy.ts";
import { files_pending_nodes_db_get_ancestry } from "./files_pending_nodes_db.ts";
import { files_pending_updates_db_get_cohort_content } from "./files_pending_updates_db.ts";
import type { files_pending_updates_CohortContentContext } from "./files_pending_updates.ts";
import { files_transfer_source_versions_equal } from "./files_transfer.ts";
import { files_media_dependencies_db_retire } from "./files_media_dependencies.ts";
import { billing_db_check_paid_plan, billing_db_emit_file_save, billing_db_emit_file_upload } from "./billing_db.ts";
import { quotas_db_ensure } from "./quotas.ts";
import {
	files_private_storage_db_release,
	files_private_storage_db_release_deleted_resource,
	files_private_storage_db_set_cohort_owner,
} from "./files_private_storage.ts";
import { r2_enqueue_object_deletion_job, r2_PUT_MAY_ARRIVE_MARGIN_MS } from "./r2_assets.ts";
import { files_saved_placement_db_get_node } from "../server/files-saved-placement.ts";
import { files_move_reservations_db_enter } from "../server/files-move-reservations.ts";
import {
	files_pending_overlay_db_can_join_step,
	files_pending_overlay_db_set_cohort_materialization,
} from "../server/files-pending-overlay.ts";
import { files_content_type_index_fields } from "../shared/files.ts";
import { should_never_happen } from "../shared/shared-utils.ts";
import { quotas } from "../shared/quotas.ts";

export const files_move_content_PAGE_SIZE = 8;

/**
 * One stage or cleanup call runs at most this many pages. Transaction metrics do not count run time, so
 * this count bounds a stage step. Cleanup reports no native page, so root may call it again in the same
 * transaction while `files_pending_overlay_db_can_join_step` allows. There the metrics bound the
 * transaction, and this count bounds only one call.
 */
export const files_move_content_STEP_MAX_PAGES = 32;

export type files_move_content_Context = Omit<files_pending_updates_CohortContentContext, "preparationFence">;

export async function files_move_content_db_current(ctx: MutationCtx, args: files_move_content_Context) {
	const content = await ctx.db.get("files_move_cohort_content", args.contentId);
	if (!content) return Result({ _nay: { message: "Not found" } });
	const current = await files_pending_updates_db_get_cohort_content(ctx, {
		...args,
		preparationFence: content.preparationFence,
	});
	if (current._nay) return current;
	const entered = await files_move_reservations_db_enter(ctx, { ...args, mode: "stage" });
	return entered._nay ? entered : current;
}

export function files_move_content_phase_cursor(value: string | null) {
	if (!value) return { part: 0, cursor: null as string | null };
	const separator = value.indexOf("|");
	return { part: Number(value.slice(0, separator)), cursor: value.slice(separator + 1) || null };
}

/**
 * Create one candidate after root has reserved the reviewed item and its final saved header.
 */
export async function files_move_content_db_create(
	ctx: MutationCtx,
	args: { cohortId: Id<"files_move_cohorts">; itemId: Id<"files_move_cohort_items">; nodeId: Id<"files_nodes"> },
) {
	const cohort = await ctx.db.get("files_move_cohorts", args.cohortId);
	const item = await ctx.db.get("files_move_cohort_items", args.itemId);
	if (
		!cohort ||
		cohort.phase !== "staging" ||
		cohort.visibleView !== "before" ||
		!item ||
		item.cohortId !== cohort._id ||
		!item.pendingUpdateId ||
		item.reviewedRevision === null
	)
		return Result({ _nay: { message: "This Move step is no longer current." } });
	const membership = await organizations_db_get_membership(ctx, {
		membershipId: cohort.membershipId,
		userId: cohort.userId,
	});
	const lifetime = await organizations_membership_lifetimes_db_get(ctx, cohort);
	if (
		!membership ||
		!lifetime?.active ||
		lifetime.membershipId !== membership._id ||
		lifetime.lifetime !== cohort.membershipLifetime
	)
		return Result({ _nay: { message: "Unauthorized" } });
	const proposal = await ctx.db.get("files_pending_updates", item.pendingUpdateId);
	const record = await ctx.db.get("files_move_cohort_nodes", item.nodeRecordId);
	if (
		!proposal ||
		proposal.organizationId !== cohort.organizationId ||
		proposal.workspaceId !== cohort.workspaceId ||
		proposal.userId !== cohort.userId ||
		proposal.revision !== item.reviewedRevision ||
		proposal.target.kind !== item.target.kind ||
		proposal.target.id !== item.target.id ||
		!record ||
		record.cohortId !== cohort._id ||
		record.nodeId !== args.nodeId
	)
		return Result({ _nay: { name: "target_changed", message: "The proposal changed after it was reviewed." } });
	let before: Doc<"files_nodes"> | null = null;
	if (item.target.kind === "saved") {
		const access = await access_control_db_authorize_node(ctx, {
			membership,
			userAuth: { id: cohort.userId },
			nodeId: item.target.id,
			permission: "content.write",
		});
		if (access._nay) return access;
		before = access._yay.fileNode;
		const writable = await files_nodes_db_require_user_writable(ctx, { node: before, userId: cohort.userId });
		if (writable._nay) return writable;
		if (
			!files_transfer_source_versions_equal(
				await files_nodes_db_get_content_version(ctx, before),
				record.sourceContentVersion,
			)
		)
			return Result({ _nay: { name: "target_changed", message: "The file changed after it was reviewed." } });
	} else {
		const ancestry = await files_pending_nodes_db_get_ancestry(ctx, { ...cohort, privateNodeId: item.target.id });
		if (ancestry._nay) return ancestry;
		const parent = ancestry._yay.savedParent;
		const access = await access_control_db_authorize_membership(ctx, {
			membership,
			userAuth: { id: cohort.userId },
			permission: "content.write",
			fileNode: parent ?? undefined,
		});
		if (access._nay) return access;
		if (
			!item.privateVersion ||
			ancestry._yay.node.creationGeneration !== item.privateVersion.creationGeneration ||
			ancestry._yay.node.structuralRevision !== item.privateVersion.structuralRevision
		)
			return Result({ _nay: { name: "target_changed", message: "This draft changed. Review it again." } });
	}
	if (item.contentId) return Result({ _yay: item.contentId });
	const entered = await files_move_reservations_db_enter(ctx, {
		cohortId: cohort._id,
		fence: cohort.fence,
		attemptFence: cohort.attemptFence,
		mode: "stage",
	});
	if (entered._nay) return entered;
	const contentId = await ctx.db.insert("files_move_cohort_content", {
		cohortId: cohort._id,
		itemId: item._id,
		nodeId: args.nodeId,
		pendingUpdateId: proposal._id,
		reviewedRevision: proposal.revision,
		selectedContentStateId: item.selectedContentStateId,
		prepared: null,
		operationBatchId: null,
		phase: "preparing",
		phaseCursor: null,
		nextChunkIndex: 0,
		acceptedTextInputId: null,
		unstagedTextInputId: null,
		acceptedTextDigest: null,
		sourceSnapshotSequence: null,
		afterYjsSnapshotAssetId: null,
		preparationFence: 0,
		storageBytes: 0,
		storageResourceCount: 0,
		privateByteDelta: 0,
		privateNodeDelta: 0,
		privateAccountingAdded: false,
		storedByteDelta: 0,
		storedUpload: false,
		previousVersion: null,
		acceptedVersion: null,
		previousVersionSnapshotId: null,
		acceptedVersionSnapshotId: null,
		beforeContentVersion: record.sourceContentVersion,
		afterContentVersion: null,
		afterSnapshotId: null,
		afterStatsId: null,
		afterAssetId: null,
		trustedStageId: null,
		nextSequence: null,
		partialFamily: null,
		sealed: false,
		proofEpoch: cohort.proofEpoch,
		costCents: 0,
		afterSequence: null,
		mediaProof: null,
		preparedMediaSet: null,
	});
	await ctx.db.patch("files_move_cohort_items", item._id, { contentId });
	const snapshot = before?.yjsSnapshotId ? await ctx.db.get("files_yjs_snapshots", before.yjsSnapshotId) : null;
	const storedAssetId = proposal.createIntent?.kind === "stored" ? proposal.createIntent.assetId : null;
	for (const assetId of [before?.assetId, snapshot?.assetId, proposal.pendingReplacement?.assetId, storedAssetId]) {
		if (!assetId) continue;
		const claim = await ctx.db
			.query("files_move_asset_claims")
			.withIndex("by_asset", (q) => q.eq("assetId", assetId))
			.first();
		if (claim && claim.cohortId !== cohort._id)
			throw should_never_happen("Reserved Move asset has another owner", { assetId });
		if (!claim) await ctx.db.insert("files_move_asset_claims", { cohortId: cohort._id, assetId });
	}
	return Result({ _yay: contentId });
}

export function files_move_content_changes_saved_content(prepared: NonNullable<Doc<"files_move_cohort_content">["prepared"]>) {
	return prepared.kind === "saved_yjs"
		? !!prepared.trustedStageId
		: prepared.kind === "saved_asset"
			? !!prepared.publish
			: true;
}

export function files_move_content_retained_state_ids(proposal: WithoutSystemFields<Doc<"files_pending_updates">> | null) {
	return new Set(
		proposal?.content
			? [proposal.content.baseStateId, proposal.content.stagedStateId, proposal.content.unstagedStateId]
			: [],
	);
}

export function files_move_content_consumed_resources(
	proposal: Doc<"files_pending_updates">,
	retained: Set<Id<"files_pending_update_yjs_states">>,
) {
	const resources: NonNullable<Doc<"files_move_cohort_content">["consumedResources"]> = [];
	if (proposal.content)
		for (const id of [proposal.content.baseStateId, proposal.content.stagedStateId, proposal.content.unstagedStateId]) {
			if (!retained.has(id)) resources.push({ kind: "state", id });
		}
	// One proposal owns at most three states, one replacement, and one private create.
	for (const id of new Set([
		proposal.pendingReplacement?.assetId,
		proposal.createIntent?.kind === "stored" ? proposal.createIntent.assetId : undefined,
	])) {
		if (id) resources.push({ kind: "asset", id, r2Key: "" });
	}
	if (proposal.target.kind === "private") resources.push({ kind: "node", id: proposal.target.id });
	return resources;
}

export async function files_move_content_db_reservation(
	ctx: MutationCtx,
	resource: Pick<Doc<"files_private_storage_reservations">["resource"], "kind" | "id">,
) {
	return await ctx.db
		.query("files_private_storage_reservations")
		.withIndex("by_resource", (q) => q.eq("resource.kind", resource.kind).eq("resource.id", resource.id))
		.unique();
}

async function db_remove_asset(
	ctx: MutationCtx,
	content: Doc<"files_move_cohort_content">,
	assetId: Id<"files_r2_assets">,
) {
	const reservation = await files_move_content_db_reservation(ctx, { kind: "asset", id: assetId });
	if (
		!reservation ||
		reservation.settlement.kind !== "held" ||
		reservation.cohortContentId !== content._id ||
		reservation.resource.kind !== "asset"
	)
		return;
	const asset = await ctx.db.get("files_r2_assets", assetId);
	await r2_enqueue_object_deletion_job(ctx, {
		...reservation,
		r2Key: reservation.resource.r2Key,
		reason: "failed_create",
		putMayArriveUntil: (asset?.uploadUrlExpiresAt ?? Date.now()) + r2_PUT_MAY_ARRIVE_MARGIN_MS,
	});
	const claim = await ctx.db
		.query("files_move_asset_claims")
		.withIndex("by_asset", (q) => q.eq("assetId", assetId))
		.first();
	if (claim?.cohortId === content.cohortId) await ctx.db.delete("files_move_asset_claims", claim._id);
	if (asset) await ctx.db.delete("files_r2_assets", assetId);
}

/**
 * Root calls this in the view-switch mutation. No candidate loop runs at publication.
 */
export async function files_move_content_db_publish_accounting(ctx: MutationCtx, args: Omit<files_move_content_Context, "contentId">) {
	const cohort = await ctx.db.get("files_move_cohorts", args.cohortId);
	if (!cohort || cohort.fence !== args.fence || cohort.attemptFence !== args.attemptFence)
		return Result({ _nay: { message: "This Move step is no longer current." } });
	if (cohort.privateAccountingApplied) return Result({ _yay: null });
	if (cohort.visibleView !== "before" || cohort.phase !== "ready")
		return Result({ _nay: { message: "This Move is not ready to publish." } });
	const now = Date.now();
	const balances: { quota: Doc<"quotas">; delta: number }[] = [];
	if (cohort.storedFileCount > 0) {
		if (!(await billing_db_check_paid_plan(ctx, { userId: cohort.billedUserId })).hasPaidPlan)
			return Result({
				_nay: { name: "plan_required", message: "File uploads need a paid plan" },
			});
		const id = await quotas_db_ensure(ctx, {
			quotaName: "stored_file_bytes",
			organizationId: cohort.organizationId,
			workspaceId: cohort.workspaceId,
			now,
		});
		const quota = (await ctx.db.get("quotas", id))!;
		if (quota.usedCount + cohort.storedByteDelta > quota.maxCount)
			return Result({ _nay: { name: "storage_full", message: quotas.stored_file_bytes.disabledReason } });
		balances.push({ quota, delta: cohort.storedByteDelta });
	}
	for (const quotaName of [
		"files_private_user_bytes",
		"files_private_workspace_bytes",
		"files_private_nodes",
	] as const) {
		const id = await quotas_db_ensure(ctx, {
			organizationId: cohort.organizationId,
			workspaceId: cohort.workspaceId,
			...(quotaName === "files_private_workspace_bytes" ? { quotaName } : { quotaName, userId: cohort.userId }),
			now,
		});
		const quota = (await ctx.db.get("quotas", id))!;
		const delta = quotaName === "files_private_nodes" ? cohort.privateNodeDelta : cohort.privateByteDelta;
		if (quota.usedCount + delta < 0)
			throw should_never_happen("Invalid Move private balance", { cohortId: cohort._id, quotaName });
		// Save stays allowed at the private byte caps. A partial Save can grow private bytes, but only by
		// copying text its draft already holds into the remainder. New draft bytes still need quota.
		// A Move only removes private nodes today. Any node growth must still fit the node cap.
		if (quotaName === "files_private_nodes" && delta > 0 && quota.usedCount + delta > quota.maxCount)
			return Result({ _nay: { name: "storage_full", message: quotas[quotaName].disabledReason } });
		balances.push({ quota, delta });
	}
	for (const { quota, delta } of balances)
		await ctx.db.patch("quotas", quota._id, { usedCount: quota.usedCount + delta, updatedAt: now });
	await ctx.db.patch("files_move_cohorts", cohort._id, { privateAccountingApplied: true });
	return Result({ _yay: null });
}

/**
 * One page of one side part. True when the part is empty.
 */
async function db_cleanup_part_page(
	ctx: MutationCtx,
	args: {
		content: Doc<"files_move_cohort_content">;
		mode: "finish" | "abort";
		part: number;
		scope: { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces"> };
	},
) {
	const { content, mode, part, scope } = args;
	const kind = Math.floor(part / 2);
	const view = part % 2 === 0 ? "before" : "after";
	const remove = mode === "finish" ? view === "before" : view === "after";
	const table =
		kind === 0 || kind === 4
			? "files_text_chunks"
			: kind === 1 || kind === 5
				? "files_plain_text_chunks"
				: kind === 2
					? "files_yjs_updates"
					: "files_metadata_docs";
	const query =
		kind === 0 || kind === 1
			? ctx.db
					.query(table as "files_text_chunks" | "files_plain_text_chunks")
					.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
						q
							.eq("organizationId", scope.organizationId)
							.eq("workspaceId", scope.workspaceId)
							.eq("fileNodeId", content.nodeId)
							.eq("moveView.cohortId", content.cohortId)
							.eq("moveView.view", view),
					)
			: kind === 2
				? ctx.db
						.query("files_yjs_updates")
						.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
							q
								.eq("organizationId", scope.organizationId)
								.eq("workspaceId", scope.workspaceId)
								.eq("fileNodeId", content.nodeId)
								.eq("moveView.cohortId", content.cohortId)
								.eq("moveView.view", view),
						)
				: kind === 3
					? ctx.db
							.query("files_metadata_docs")
							.withIndex("by_organization_workspace_source_fileNode_fieldPath", (q) =>
								q
									.eq("organizationId", scope.organizationId)
									.eq("workspaceId", scope.workspaceId)
									.eq("sourceKind", "committed")
									.eq("fileNodeId", content.nodeId)
									.eq("moveView.cohortId", content.cohortId)
									.eq("moveView.view", view),
							)
					: kind === 4 || kind === 5
						? ctx.db
								.query(table as "files_text_chunks" | "files_plain_text_chunks")
								.withIndex("by_pendingUpdate_chunkIndex", (q) =>
									q
										.eq("pendingUpdateId", content.pendingUpdateId)
										.eq("moveView.cohortId", content.cohortId)
										.eq("moveView.view", view),
								)
						: ctx.db
								.query("files_metadata_docs")
								.withIndex("by_pendingUpdate_fieldPath", (q) =>
									q
										.eq("pendingUpdateId", content.pendingUpdateId)
										.eq("moveView.cohortId", content.cohortId)
										.eq("moveView.view", view),
								);
	// Clearing or deleting each tag drains the range without storing a large metadata cursor.
	// `take` lets one step run many pages, because Convex allows one `.paginate()` per function
	// call. Chunks and metadata docs are small, and a Yjs update goes alone.
	const numItems = kind === 2 ? 1 : files_move_content_PAGE_SIZE;
	const rows = await query.take(numItems);
	for (const row of rows) {
		if (remove) await ctx.db.delete(table, row._id);
		else await ctx.db.patch(table, row._id, { moveView: undefined });
	}
	return rows.length < numItems;
}

/**
 * Move owned side pages back to normal, or remove the side that lost the switch, while the step may
 * join more work. It reads no `.paginate()` page, so it never reports one.
 */
async function db_cleanup_page(ctx: MutationCtx, content: Doc<"files_move_cohort_content">, mode: "finish" | "abort") {
	const marker = `${mode}:`;
	const progress = content.phaseCursor?.startsWith(marker) ? content.phaseCursor.slice(marker.length) : null;
	if (progress === "done") return { done: true, paged: false };
	let { part } = files_move_content_phase_cursor(progress);
	const cohort = (await ctx.db.get("files_move_cohorts", content.cohortId))!;
	const scope = { organizationId: cohort.organizationId, workspaceId: cohort.workspaceId };
	for (let pages = 1; part < 14; pages++) {
		if (await db_cleanup_part_page(ctx, { content, mode, part, scope })) part++;
		if (pages >= files_move_content_STEP_MAX_PAGES || !(await files_pending_overlay_db_can_join_step(ctx))) {
			await ctx.db.patch("files_move_cohort_content", content._id, { phaseCursor: `${marker}${part}|` });
			return { done: false, paged: false };
		}
	}
	return { done: true, paged: false };
}

async function db_retire_states(
	ctx: MutationCtx,
	content: Doc<"files_move_cohort_content">,
	states: Doc<"files_pending_update_yjs_states">[],
) {
	if (!states.length) return;
	const cohort = (await ctx.db.get("files_move_cohorts", content.cohortId))!;
	const cleanupTaskId = await ctx.db.insert("files_pending_update_state_cleanup_tasks", {
		organizationId: cohort.organizationId,
		workspaceId: cohort.workspaceId,
		createdAt: Date.now(),
	});
	for (const state of states)
		await ctx.db.patch("files_pending_update_yjs_states", state._id, { owner: { kind: "retired", cleanupTaskId } });
	await ctx.scheduler.runAfter(0, internal.files_pending_updates.cleanup_expired_pending_state_rows, {});
}

async function db_finish_resources(
	ctx: MutationCtx,
	content: Doc<"files_move_cohort_content">,
	mode: "finish" | "abort",
) {
	const item = (await ctx.db.get("files_move_cohort_items", content.itemId))!;
	const retained =
		mode === "finish" ? files_move_content_retained_state_ids(item.afterProposal) : new Set<Id<"files_pending_update_yjs_states">>();
	if (mode === "finish") {
		const proposal = await ctx.db.get("files_pending_updates", content.pendingUpdateId);
		if (!proposal || proposal.revision !== content.reviewedRevision)
			throw should_never_happen("Move settled its proposal before content", { contentId: content._id });
		for (const resource of files_move_content_consumed_resources(proposal, retained)) {
			const reservation = await files_move_content_db_reservation(ctx, resource);
			if (!reservation || reservation.settlement.kind !== "held") continue;
			const transferred = await files_private_storage_db_set_cohort_owner(ctx, {
				reservationId: reservation._id,
				cohortContentId: content._id,
			});
			if (transferred._nay)
				throw should_never_happen("Published Move could not settle its hold", { reservationId: reservation._id });
			if (resource.kind === "node")
				await files_private_storage_db_release(ctx, {
					reservationId: reservation._id,
					settlement: { kind: "saved", settledAt: Date.now(), savedNodeId: content.nodeId },
				});
			else if (resource.kind === "asset") {
				if (resource.id === content.afterAssetId || resource.id === content.afterYjsSnapshotAssetId) {
					await ctx.db.patch("files_r2_assets", resource.id, {
						unfinalizedExpiresAt: undefined,
						uploadUrlExpiresAt: undefined,
					});
					await files_private_storage_db_release(ctx, {
						reservationId: reservation._id,
						settlement: { kind: "saved", settledAt: Date.now(), savedNodeId: content.nodeId },
					});
				} else await db_remove_asset(ctx, content, resource.id);
			}
		}
		// An active proposal has exactly one three-state family.
		const original = await ctx.db
			.query("files_pending_update_yjs_states")
			.withIndex("by_owner_pendingUpdate", (q) => q.eq("owner.pendingUpdateId", content.pendingUpdateId))
			.collect();
		await db_retire_states(
			ctx,
			content,
			original.filter((state) => !retained.has(state._id)),
		);
	}
	const batch = content.operationBatchId
		? await ctx.db.get("files_pending_update_operation_batches", content.operationBatchId)
		: null;
	if (batch) {
		// One preparation batch has at most six states and two text inputs.
		const states = await ctx.db
			.query("files_pending_update_yjs_states")
			.withIndex("by_owner_operationBatch", (q) => q.eq("owner.operationBatchId", batch._id))
			.collect();
		for (const state of states) {
			if (!retained.has(state._id)) continue;
			const reservation = await files_move_content_db_reservation(ctx, { kind: "state", id: state._id });
			if (!reservation) throw should_never_happen("Move lost a partial hold", { stateId: state._id });
			const transferred = await files_private_storage_db_set_cohort_owner(ctx, {
				reservationId: reservation._id,
				cohortContentId: null,
			});
			if (transferred._nay)
				throw should_never_happen("Published Move could not settle partial content", { stateId: state._id });
			if (state.owner.kind !== "cohort")
				throw should_never_happen("Move partial state changed owner", { stateId: state._id });
			await ctx.db.patch("files_pending_update_yjs_states", state._id, {
				target: { kind: "saved", id: content.nodeId },
				owner: { kind: "active", pendingUpdateId: content.pendingUpdateId, role: state.owner.role },
				lineageGeneration: content.afterSequence?.lineageGeneration,
			});
		}
		await db_retire_states(
			ctx,
			content,
			states.filter((state) => !retained.has(state._id)),
		);
		const inputs = await ctx.db
			.query("files_pending_update_text_inputs")
			.withIndex("by_operationBatch", (q) => q.eq("operationBatchId", batch._id))
			.collect();
		for (const input of inputs) {
			await ctx.db.delete("files_pending_update_text_inputs", input._id);
			await files_private_storage_db_release_deleted_resource(ctx, { kind: "text_input", id: input._id });
		}
		if (content.trustedStageId && (await ctx.db.get("files_yjs_trusted_update_stages", content.trustedStageId))) {
			await ctx.db.delete("files_yjs_trusted_update_stages", content.trustedStageId);
			await files_private_storage_db_release_deleted_resource(ctx, {
				kind: "trusted_stage",
				id: content.trustedStageId,
			});
		}
		if (batch.publication?.kind === "assets")
			for (const id of [
				batch.publication.contentAssetId,
				batch.publication.yjsSnapshotAssetId,
				batch.publication.backupAssetId,
			]) {
				if (!id) continue;
				const reservation = await files_move_content_db_reservation(ctx, { kind: "asset", id });
				if (!reservation || reservation.settlement.kind !== "held" || reservation.cohortContentId !== content._id)
					continue;
				if (mode === "finish") {
					await ctx.db.patch("files_r2_assets", id, { unfinalizedExpiresAt: undefined, uploadUrlExpiresAt: undefined });
					await files_private_storage_db_release(ctx, {
						reservationId: reservation._id,
						settlement: { kind: "saved", settledAt: Date.now(), savedNodeId: content.nodeId },
					});
				} else await db_remove_asset(ctx, content, id);
			}
		await ctx.db.delete("files_pending_update_operation_batches", batch._id);
	}
	if (content.preparedMediaSet) {
		await files_media_dependencies_db_retire(ctx, {
			...content.preparedMediaSet,
			owner: { kind: "cohort_content", contentId: content._id },
		});
		await ctx.db.patch("files_move_cohort_content", content._id, { preparedMediaSet: null });
	}
}

/**
 * Physical repair runs after publication. Its quota receipt was applied with the view switch.
 */
export async function files_move_content_db_finish(ctx: MutationCtx, args: files_move_content_Context) {
	const content = await ctx.db.get("files_move_cohort_content", args.contentId);
	const cohort = await ctx.db.get("files_move_cohorts", args.cohortId);
	if (!content || content.cohortId !== args.cohortId || !cohort) return Result({ _nay: { message: "Not found" } });
	const entered = await files_pending_overlay_db_set_cohort_materialization(ctx, { ...args, mode: "finish" });
	if (entered._nay) return entered;
	if (!cohort.privateAccountingApplied || !content.sealed)
		throw should_never_happen("Move content finished before publication", args);
	if (content.phaseCursor === "finish:done") return Result({ _yay: { done: true, paged: false } });
	const cleaned = await db_cleanup_page(ctx, content, "finish");
	if (!cleaned.done) return Result({ _yay: cleaned });
	const node = await ctx.db.get("files_nodes", content.nodeId);
	const place = await files_saved_placement_db_get_node(ctx.db, content.nodeId, {
		cohortId: cohort._id,
		view: "after",
	});
	if (!node || !place) throw should_never_happen("Move lost its accepted content header", args);
	if (content.afterSequence) {
		const { lastSequenceId, ...sequence } = content.afterSequence;
		await ctx.db.patch("files_yjs_docs_last_sequences", lastSequenceId, { ...sequence, moveView: undefined });
	}
	if (content.afterSnapshotId)
		await ctx.db.patch("files_yjs_snapshots", content.afterSnapshotId, { moveView: undefined });
	if (content.afterStatsId) await ctx.db.patch("file_stats", content.afterStatsId, { moveView: undefined });
	if (node.yjsLastSequenceId && node.yjsLastSequenceId !== content.afterSequence?.lastSequenceId)
		await ctx.db.delete("files_yjs_docs_last_sequences", node.yjsLastSequenceId);
	if (node.yjsSnapshotId && node.yjsSnapshotId !== content.afterSnapshotId)
		await ctx.db.delete("files_yjs_snapshots", node.yjsSnapshotId);
	if (node.statsId && node.statsId !== content.afterStatsId) await ctx.db.delete("file_stats", node.statsId);
	await ctx.db.patch("files_nodes", node._id, {
		assetId: place.assetId,
		contentType: place.contentType,
		...files_content_type_index_fields(place.contentType),
		textKind: place.textKind,
		collaborationEnabled: place.collaborationEnabled,
		pendingContentVersion: place.pendingContentVersion,
		contentByteSize: place.contentByteSize,
		yjsSnapshotId: content.afterSnapshotId,
		yjsLastSequenceId: content.afterSequence?.lastSequenceId ?? null,
		statsId: content.afterStatsId,
		contentTooLargeByteSize: place.contentTooLargeByteSize,
		contentShapeMismatchAt: place.contentShapeMismatchAt,
		contentYjsStateTooLargeByteSize: place.contentYjsStateTooLargeByteSize,
		contentFrontmatterTooLargeFieldCount: place.contentFrontmatterTooLargeFieldCount,
		contentFrontmatterTooLargeIndexDocumentCount: place.contentFrontmatterTooLargeIndexDocumentCount,
	});
	for (const role of ["previousVersion", "acceptedVersion"] as const) {
		const version = content[role];
		const receipt = role === "previousVersion" ? "previousVersionSnapshotId" : "acceptedVersionSnapshotId";
		if (!version || content[receipt]) continue;
		const existing =
			role === "previousVersion"
				? await ctx.db
						.query("files_snapshots")
						.withIndex("by_asset", (q) => q.eq("assetId", version.assetId))
						.first()
				: null;
		const id =
			existing?._id ??
			(await ctx.db.insert("files_snapshots", {
				organizationId: cohort.organizationId,
				workspaceId: cohort.workspaceId,
				fileNodeId: content.nodeId,
				assetId: version.assetId,
				contentType: version.contentType,
				yjsRootKind: version.yjsRootKind,
				collaborationEnabled: version.collaborationEnabled,
				createdBy: cohort.userId,
				archivedAt: -1,
			}));
		await ctx.db.patch("files_move_cohort_content", content._id, { [receipt]: id });
	}
	const item = (await ctx.db.get("files_move_cohort_items", content.itemId))!;
	if (content.costCents > 0 && item.billingState !== "sent" && item.billingState !== "payer_missing") {
		const billedUser = await ctx.db.get("users", cohort.billedUserId);
		// A payer doc deleted after publication cannot be billed. Repair must still finish, or the Move keeps the slot.
		if (!billedUser)
			console.error("Published Move lost its payer. Skipping its billing event.", {
				cohortId: cohort._id,
				itemId: item._id,
			});
		// Anonymous usage was debited at the switch. Signed-in usage goes to the normal billing queue.
		else if (billedUser.clerkUserId) {
			if (content.storedUpload)
				await billing_db_emit_file_upload(ctx, {
					billedUser,
					actorUserId: cohort.userId,
					organizationId: cohort.organizationId,
					workspaceId: cohort.workspaceId,
					nodeId: content.nodeId,
					assetId: content.afterAssetId!,
					chargeKey: content.afterAssetId!,
					amount: content.costCents,
					bytes: content.storedByteDelta,
				});
			else
				await billing_db_emit_file_save(ctx, {
					billedUser,
					actorUserId: cohort.userId,
					organizationId: cohort.organizationId,
					workspaceId: cohort.workspaceId,
					nodeId: content.nodeId,
					version: content.afterSequence
						? `${content.afterSequence.lastSequenceId}:${content.afterSequence.lastSequence}`
						: content.afterAssetId!,
				});
		}
		await ctx.db.patch("files_move_cohort_items", item._id, { billingState: billedUser ? "sent" : "payer_missing" });
	}
	await db_finish_resources(ctx, content, "finish");
	await ctx.db.patch("files_move_cohort_content", content._id, { phaseCursor: "finish:done" });
	return Result({ _yay: { done: true, paged: cleaned.paged } });
}

/**
 * Stop restores the old side and retires output without changing private quota or history.
 */
export async function files_move_content_db_abort(ctx: MutationCtx, args: files_move_content_Context) {
	const content = await ctx.db.get("files_move_cohort_content", args.contentId);
	if (!content || content.cohortId !== args.cohortId) return Result({ _nay: { message: "Not found" } });
	const entered = await files_pending_overlay_db_set_cohort_materialization(ctx, { ...args, mode: "abort" });
	if (entered._nay) return entered;
	if (content.phaseCursor === "abort:done") return Result({ _yay: { done: true, paged: false } });
	const cleaned = await db_cleanup_page(ctx, content, "abort");
	if (!cleaned.done) return Result({ _yay: cleaned });
	if (!content.prepared || files_move_content_changes_saved_content(content.prepared)) {
		if (content.afterSnapshotId) await ctx.db.delete("files_yjs_snapshots", content.afterSnapshotId);
		if (content.afterStatsId) await ctx.db.delete("file_stats", content.afterStatsId);
	}
	if (
		content.afterSequence &&
		content.afterSequence.lastSequenceId !==
			(content.beforeContentVersion?.kind === "yjs" ? content.beforeContentVersion.lastSequenceId : null)
	)
		await ctx.db.delete("files_yjs_docs_last_sequences", content.afterSequence.lastSequenceId);
	await db_finish_resources(ctx, content, "abort");
	await ctx.db.patch("files_move_cohort_content", content._id, { phaseCursor: "abort:done" });
	return Result({ _yay: { done: true, paged: cleaned.paged } });
}

/**
 * Root calls only after every content, placement, and owner side has finished cleanup.
 */
export async function files_move_content_db_release_claims(
	ctx: MutationCtx,
	args: Omit<files_move_content_Context, "contentId"> & { limit: number },
) {
	const cohort = await ctx.db.get("files_move_cohorts", args.cohortId);
	if (!cohort) return Result({ _nay: { message: "Not found" } });
	const entered = await files_move_reservations_db_enter(ctx, {
		...args,
		mode: cohort.visibleView === "after" ? "finish" : "abort",
	});
	if (entered._nay) return entered;
	const claims = await ctx.db
		.query("files_move_asset_claims")
		.withIndex("by_cohort", (q) => q.eq("cohortId", cohort._id))
		.take(args.limit);
	for (const claim of claims) await ctx.db.delete("files_move_asset_claims", claim._id);
	return Result({ _yay: { count: claims.length } });
}
