// Shared database bodies. Keep editor and action work on their current owners.

import { Result } from "common/errors-as-values-utils.ts";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import { organizations_db_get_membership } from "./organizations_memberships_db.ts";
import { organizations_membership_lifetimes_db_get } from "./organizations_membership_lifetimes.ts";
import { access_control_db_authorize_membership } from "./access_control.ts";
import { files_media_validation_db_versions_match } from "./files_media_validation.ts";
import { files_transfer_media_db_get_ready_media } from "./files_transfer_media.ts";
import { files_transfer_source_versions_equal } from "./files_transfer.ts";
import {
	files_saved_placement_db_get_node,
	files_saved_placement_db_resolve_read_target,
} from "../server/files-saved-placement.ts";
import { files_media_parse_src } from "../shared/files-media.ts";

export const files_move_media_PAGE_SIZE = 8;

export type files_move_media_Result<T> =
	| { _yay: T; _nay?: undefined }
	| { _nay: { name?: string; message: string }; _yay?: undefined };

export function files_move_media_changed() {
	return Result({
		_nay: { name: "needs_review", message: "A linked media file changed. Review this document again." },
	});
}

export async function files_move_media_db_current(
	ctx: QueryCtx | MutationCtx,
	args: {
		cohortId: Id<"files_move_cohorts">;
		contentId: Id<"files_move_cohort_content">;
		fence?: number;
		attemptFence?: number;
		proofEpoch?: number;
		runGeneration?: number | null;
	},
) {
	const cohort = await ctx.db.get("files_move_cohorts", args.cohortId);
	const content = await ctx.db.get("files_move_cohort_content", args.contentId);
	if (args.runGeneration !== undefined && (cohort?.runJob?.generation ?? null) !== args.runGeneration)
		return Result({ _nay: { name: "stopped", message: "This Move step is no longer current." } });
	if (
		!cohort ||
		!content ||
		content.cohortId !== cohort._id ||
		!content.sealed ||
		(cohort.phase !== "staging" &&
			cohort.phase !== "validating" &&
			!(args.proofEpoch !== undefined && cohort.phase === "ready")) ||
		cohort.visibleView !== "before" ||
		(args.fence !== undefined && cohort.fence !== args.fence) ||
		(args.attemptFence !== undefined && cohort.attemptFence !== args.attemptFence) ||
		(args.proofEpoch !== undefined && cohort.proofEpoch !== args.proofEpoch) ||
		content.proofEpoch !== cohort.proofEpoch ||
		cohort.deadlineAt <= Date.now()
	)
		return files_move_media_changed();
	const item = await ctx.db.get("files_move_cohort_items", content.itemId);
	const proposal = await ctx.db.get("files_pending_updates", content.pendingUpdateId);
	if (
		!item ||
		item.cohortId !== cohort._id ||
		item.contentId !== content._id ||
		!proposal ||
		proposal.userId !== cohort.userId ||
		proposal.organizationId !== cohort.organizationId ||
		proposal.workspaceId !== cohort.workspaceId ||
		proposal.moveCohortId !== cohort._id ||
		proposal.revision !== content.reviewedRevision ||
		item.reviewedRevision !== content.reviewedRevision ||
		item.selectedContentStateId !== content.selectedContentStateId
	)
		return files_move_media_changed();
	const [membership, lifetime, user, workspace] = await Promise.all([
		organizations_db_get_membership(ctx, { userId: cohort.userId, membershipId: cohort.membershipId }),
		organizations_membership_lifetimes_db_get(ctx, cohort),
		ctx.db.get("users", cohort.userId),
		ctx.db.get("organizations_workspaces", cohort.workspaceId),
	]);
	if (
		!membership ||
		!lifetime?.active ||
		lifetime.membershipId !== cohort.membershipId ||
		lifetime.lifetime !== cohort.membershipLifetime ||
		!user ||
		user.deletedAt !== undefined ||
		!workspace ||
		workspace.organizationId !== cohort.organizationId ||
		workspace.pluginDataPurgeStartedAt !== undefined
	)
		return Result({ _nay: { name: "permission_denied", message: "This review is no longer available." } });
	const run =
		cohort.origin.kind === "review" ? await ctx.db.get("files_pending_update_runs", cohort.origin.runId) : null;
	if (cohort.origin.kind === "review") {
		const unit = await ctx.db.get("files_pending_update_run_units", cohort.origin.unitId);
		if (
			!run ||
			run.step !== "running" ||
			run.fence !== cohort.fence ||
			run.planEpoch !== cohort.origin.planEpoch ||
			!unit ||
			unit.runId !== run._id ||
			unit.cohortId !== cohort._id ||
			unit.status !== "preparing" ||
			unit.attemptFence !== cohort.attemptFence
		)
			return files_move_media_changed();
	}
	const pins = cohort.clockPins;
	// Keep this check even with no media: the same pins catch write policy and access changes while staging.
	if (
		!(await files_media_validation_db_versions_match(ctx, {
			versions: [pins.organization, pins.workspace],
			pendingVersions: pins.review ? [pins.review] : [],
		}))
	)
		return files_move_media_changed();
	const set = content.preparedMediaSet
		? await ctx.db.get("files_media_dependency_sets", content.preparedMediaSet.setId)
		: null;
	if (
		content.preparedMediaSet &&
		(!set ||
			set.generation !== content.preparedMediaSet.generation ||
			set.owner.kind !== "cohort_content" ||
			set.owner.contentId !== content._id ||
			set.userId !== cohort.userId ||
			set.organizationId !== cohort.organizationId ||
			set.workspaceId !== cohort.workspaceId)
	)
		return files_move_media_changed();
	return Result({ _yay: { cohort, content, item, proposal, membership, set, run } });
}

export async function files_move_media_db_selected(
	ctx: QueryCtx | MutationCtx,
	runId: Id<"files_pending_update_runs">,
	original: Doc<"files_pending_update_run_items">["target"],
	target: Doc<"files_pending_update_run_items">["target"] | null,
) {
	let selected = await ctx.db
		.query("files_pending_update_run_items")
		.withIndex("by_run_target", (q) =>
			q.eq("runId", runId).eq("target.kind", original.kind).eq("target.id", original.id),
		)
		.unique();
	// A published private link may target a selected saved replacement.
	if (!selected && original.kind === "private" && target?.kind === "saved")
		selected = await ctx.db
			.query("files_pending_update_run_items")
			.withIndex("by_run_target", (q) => q.eq("runId", runId).eq("target.kind", target.kind).eq("target.id", target.id))
			.unique();
	return selected;
}

export async function files_move_media_db_ref(
	ctx: QueryCtx | MutationCtx,
	data: NonNullable<Awaited<ReturnType<typeof files_move_media_db_current>>["_yay"]>,
	src: string,
) {
	const { cohort, membership } = data;
	const parsed = files_media_parse_src(src);
	const savedId = parsed.kind === "file" ? ctx.db.normalizeId("files_nodes", parsed.fileNodeId) : null;
	const privateId = parsed.kind === "private" ? ctx.db.normalizeId("files_pending_nodes", parsed.privateNodeId) : null;
	const original = savedId
		? { kind: "saved" as const, id: savedId }
		: privateId
			? { kind: "private" as const, id: privateId }
			: null;
	if (!original) return files_move_media_changed();
	const fixedView = { cohortId: cohort._id, view: "after" as const };
	const target = await files_saved_placement_db_resolve_read_target(ctx.db, { ...cohort, target: original }, fixedView);
	if (target?.kind !== "saved") return files_move_media_changed();
	if (cohort.origin.kind === "review") {
		const selected = await files_move_media_db_selected(ctx, cohort.origin.runId, original, target);
		if (selected?.unitId && selected.unitId !== cohort.origin.unitId) {
			const unit = await ctx.db.get("files_pending_update_run_units", selected.unitId);
			if (unit?.status !== "completed") return files_move_media_changed();
		}
	}
	const node = await files_saved_placement_db_get_node(ctx.db, target.id, fixedView);
	if (
		!node ||
		node.organizationId !== cohort.organizationId ||
		node.workspaceId !== cohort.workspaceId ||
		node.archiveOperationId !== null
	)
		return files_move_media_changed();
	const authorized = await access_control_db_authorize_membership(ctx, {
		membership,
		userAuth: { id: cohort.userId },
		permission: "content.read",
		fileNode: node,
	});
	if (authorized._nay) return authorized;
	const ready = await files_transfer_media_db_get_ready_media({
		ctx,
		membership,
		entry: { kind: "saved", node, pendingUpdate: null, path: node.path },
	});
	if (!ready) return files_move_media_changed();
	const record = await ctx.db
		.query("files_move_cohort_nodes")
		.withIndex("by_cohort_node", (q) => q.eq("cohortId", cohort._id).eq("nodeId", node._id))
		.unique();
	const selectedMedia = record?.itemId ? await ctx.db.get("files_move_cohort_items", record.itemId) : null;
	if (selectedMedia?.contentId) {
		const candidate = await ctx.db.get("files_move_cohort_content", selectedMedia.contentId);
		const pending = selectedMedia.pendingUpdateId
			? await ctx.db.get("files_pending_updates", selectedMedia.pendingUpdateId)
			: null;
		if (
			!candidate?.sealed ||
			candidate.proofEpoch !== cohort.proofEpoch ||
			candidate.afterAssetId !== ready.assetId ||
			!pending ||
			pending.revision !== selectedMedia.reviewedRevision ||
			pending.moveCohortId !== cohort._id
		)
			return files_move_media_changed();
		const originalAsset =
			pending.pendingReplacement?.assetId ??
			(pending.createIntent?.kind === "stored" ? pending.createIntent.assetId : null);
		const needsHold =
			originalAsset === ready.assetId ||
			candidate.prepared?.kind === "replacement" ||
			candidate.prepared?.kind === "private";
		if (needsHold) {
			const hold = await ctx.db
				.query("files_private_storage_reservations")
				.withIndex("by_resource", (q) => q.eq("resource.kind", "asset").eq("resource.id", ready.assetId))
				.unique();
			const asset = await ctx.db.get("files_r2_assets", ready.assetId);
			if (
				!hold ||
				!asset ||
				hold.settlement.kind !== "held" ||
				hold.resource.kind !== "asset" ||
				hold.organizationId !== cohort.organizationId ||
				hold.workspaceId !== cohort.workspaceId ||
				hold.userId !== cohort.userId ||
				hold.byteCount !== asset.size ||
				hold.resource.r2Key !== asset.r2Key ||
				(hold.cohortContentId !== candidate._id &&
					!(hold.cohortContentId === undefined && originalAsset === ready.assetId))
			)
				return files_move_media_changed();
		}
	}
	return Result({ _yay: { src, target, assetId: ready.assetId, version: ready.version } });
}

export async function files_move_media_db_validate_next(
	ctx: MutationCtx,
	args: {
		cohortId: Id<"files_move_cohorts">;
		contentId: Id<"files_move_cohort_content">;
		proofEpoch: number;
		cursor: string | null;
	},
): Promise<files_move_media_Result<{ done: boolean; cursor: string; paged: boolean }>> {
	const checked = await files_move_media_db_current(ctx, args);
	if (checked._nay) return checked;
	const { content, set, cohort } = checked._yay;
	if (!set?.sealed || set.count !== set.expectedCount) return files_move_media_changed();
	const previous = content.mediaProof;
	if (
		previous &&
		(previous.proofEpoch !== cohort.proofEpoch ||
			previous.reviewedRevision !== content.reviewedRevision ||
			previous.selectedContentStateId !== content.selectedContentStateId ||
			previous.textDigest !== (content.acceptedTextDigest ?? "") ||
			previous.dependencySet?.setId !== set._id ||
			previous.dependencySet.generation !== set.generation)
	)
		return files_move_media_changed();
	if (previous?.sealed) return Result({ _yay: { done: true, cursor: args.cursor ?? "", paged: false } });
	const range = () => ctx.db.query("files_media_dependencies").withIndex("by_set_order", (q) => q.eq("setId", set._id));
	// An empty set reads no page, so the caller may still check its next work in this step.
	const page =
		args.cursor === null && !(await range().first())
			? null
			: await range().paginate({ cursor: args.cursor, numItems: files_move_media_PAGE_SIZE });
	const isDone = page?.isDone ?? true;
	let validatedCount = previous?.validatedCount ?? 0;
	for (const row of page?.page ?? []) {
		if (row.order !== validatedCount) return files_move_media_changed();
		const current = await files_move_media_db_ref(ctx, checked._yay, row.sourceSrc);
		if (current._nay) return current;
		if (
			current._yay.target.kind !== row.dependency.target.kind ||
			current._yay.target.id !== row.dependency.target.id ||
			current._yay.assetId !== row.dependency.assetId ||
			!files_transfer_source_versions_equal(current._yay.version, row.dependency.version)
		)
			return files_move_media_changed();
		validatedCount++;
	}
	if (isDone && validatedCount !== set.expectedCount) return files_move_media_changed();
	await ctx.db.patch("files_move_cohort_content", content._id, {
		mediaProof: {
			proofEpoch: cohort.proofEpoch,
			reviewedRevision: content.reviewedRevision,
			selectedContentStateId: content.selectedContentStateId,
			textDigest: content.acceptedTextDigest ?? "",
			dependencySet: { setId: set._id, generation: set.generation },
			expectedCount: set.expectedCount,
			validatedCount,
			sealed: isDone,
		},
	});
	return Result({ _yay: { done: isDone, cursor: page?.continueCursor ?? "", paged: page !== null } });
}
