import { Result } from "common/errors-as-values-utils.ts";
import type { WithoutSystemFields } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { internalAction, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import { internalMutation } from "./functions.ts";
import {
	files_nodes_db_get_content_version,
	files_nodes_db_require_user_writable,
	files_nodes_db_resume_file_content_materialization,
} from "./files_nodes.ts";
import { files_subtree_ops_db_recover } from "./files_subtree_ops.ts";
import { files_move_reservations_db_take_waiters } from "../server/files-move-reservations.ts";
import {
	files_pending_overlay_db_set_cohort_staging,
	files_pending_overlay_db_set_cohort_allocation,
	files_pending_overlay_db_set_cohort_materialization,
	files_pending_overlay_db_wake_job,
} from "../server/files-pending-overlay.ts";
import { files_move_reservations_db_check } from "../server/files-move-reservations.ts";
import {
	files_saved_placement_db_get_node,
	files_saved_placement_db_get_slot,
	files_saved_placement_db_get_publish_receipt,
} from "../server/files-saved-placement.ts";
import { access_control_db_authorize_membership } from "./access_control.ts";
import {
	activities_db_get_by_source_id,
	activities_db_require_by_source_id,
	activities_is_active,
} from "./activities_db.ts";
import { organizations_db_get_membership } from "./organizations.ts";
import { organizations_membership_lifetimes_db_get } from "./organizations_membership_lifetimes.ts";
import { files_pending_nodes_db_can_save_to_copied_parent } from "./files_pending_nodes.ts";
import { billing_pick_billed_user_id } from "./billing_db.ts";
import {
	files_media_validation_db_capture_versions,
	files_media_validation_db_versions_match,
	files_media_validation_db_advance_version,
} from "./files_media_validation.ts";
import {
	files_ancestor_fields,
	files_ancestor_ids,
	files_derive_tree_path_for_file_node,
	files_lowercase_extension,
} from "../shared/files.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";
import { path_join, path_extract_segments_from } from "../server/server-utils.ts";
import { files_transfer_source_versions_equal } from "./files_transfer.ts";
import { files_updated_by_db_sync_node } from "./files_updated_by.ts";
import { files_share_rows_db_sync_node } from "../server/files-share-rows.ts";
import {
	files_move_content_db_create,
	files_move_content_db_stage,
	files_move_content_action_prepare,
	files_move_content_db_finish,
	files_move_content_db_abort,
	files_move_content_db_publish_accounting,
	files_move_content_db_release_claims,
} from "./files_move_content.ts";
import { files_move_media_action_prepare_refs, files_move_media_db_validate_next } from "./files_move_media.ts";
import {
	files_move_owner_work_db_collect_node,
	files_move_owner_work_db_collect_closure,
	files_move_owner_work_db_stage,
	files_move_owner_work_db_finish,
	files_move_owner_work_db_abort,
} from "./files_move_owner_work.ts";
import { billing_db_check_credits, billing_db_debit_anonymous_snapshot } from "./billing_db.ts";
import {
	files_pending_update_runs_db_record_cohort_publication,
	files_pending_update_runs_db_resume_parked,
} from "./files_pending_update_runs.ts";
import { files_transfer_db_record_cohort_publication } from "./files_transfer.ts";
import {
	files_db_delete_pending_update,
	files_db_advance_pending_review_version,
	files_db_retire_pending_update_yjs_states,
} from "../server/files.ts";
import { files_pending_update_db_delete_chunks } from "./files_pending_updates.ts";
import { should_never_happen } from "../shared/shared-utils.ts";

const WAKE_PAGE_SIZE = 8;
const RUN_TIMEOUT_MS = 30 * 60 * 1000;

function placement_header(node: Doc<"files_nodes">) {
	const {
		_id: _id,
		_creationTime: _creationTime,
		organizationId: _organizationId,
		workspaceId: _workspaceId,
		createdBy: _createdBy,
		writePolicy: _writePolicy,
		newChildWritePolicy: _newChildWritePolicy,
		moveCohortId: _moveCohortId,
		...header
	} = node;
	return header;
}

function placement_header_from_place(place: Doc<"files_saved_places">) {
	const {
		_id: _id,
		_creationTime: _time,
		cohortId: _cohort,
		view: _view,
		nodeId: _node,
		nodeCreationTime: _creation,
		organizationId: _org,
		workspaceId: _workspace,
		contentId: _content,
		...header
	} = place;
	return header;
}

async function db_get_membership(
	ctx: QueryCtx | MutationCtx,
	args: Pick<
		Doc<"files_move_cohorts">,
		"organizationId" | "workspaceId" | "userId" | "membershipId" | "membershipLifetime"
	>,
) {
	const [user, workspace, organization, lifetime, membership] = await Promise.all([
		ctx.db.get("users", args.userId),
		ctx.db.get("organizations_workspaces", args.workspaceId),
		ctx.db.get("organizations", args.organizationId),
		organizations_membership_lifetimes_db_get(ctx, args),
		organizations_db_get_membership(ctx, { userId: args.userId, membershipId: args.membershipId }),
	]);
	if (
		!user ||
		user.deletedAt !== undefined ||
		!workspace ||
		!organization ||
		workspace.organizationId !== args.organizationId ||
		workspace.pluginDataPurgeStartedAt !== undefined ||
		!membership ||
		!lifetime?.active ||
		lifetime.membershipId !== args.membershipId ||
		lifetime.lifetime !== args.membershipLifetime
	)
		return Result({ _nay: { name: "permission_denied", message: "This Move is no longer available." } });
	return Result({ _yay: { membership, organization } });
}

async function db_begin(
	ctx: MutationCtx,
	args: Pick<
		WithoutSystemFields<Doc<"files_move_cohorts">>,
		| "organizationId"
		| "workspaceId"
		| "userId"
		| "membershipId"
		| "membershipLifetime"
		| "origin"
		| "fence"
		| "attemptFence"
		| "itemCount"
	>,
) {
	const authorized = await db_get_membership(ctx, args);
	if (authorized._nay) return authorized;
	const slot = await ctx.db
		.query("files_move_workspace_slots")
		.withIndex("by_workspace", (q) => q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId))
		.unique();
	if (slot?.cohortId) {
		const current = await ctx.db.get("files_move_cohorts", slot.cohortId);
		if (
			current &&
			current.origin.kind === args.origin.kind &&
			current.origin.runId === args.origin.runId &&
			(current.origin.kind === "review" && args.origin.kind === "review"
				? current.origin.unitId === args.origin.unitId && current.origin.planEpoch === args.origin.planEpoch
				: current.origin.kind === "transfer" &&
					args.origin.kind === "transfer" &&
					current.origin.itemId === args.origin.itemId) &&
			current.fence === args.fence &&
			current.attemptFence === args.attemptFence
		)
			return Result({ _yay: current._id });
		return Result({ _nay: { name: "move_busy", message: "Another Move is finishing. This Move will wait." } });
	}
	const pins = await files_media_validation_db_capture_versions(ctx, { userId: args.userId, scopes: [args] });
	const now = Date.now();
	const generation = (slot?.generation ?? 0) + 1;
	const cohortId = await ctx.db.insert("files_move_cohorts", {
		...args,
		slotGeneration: generation,
		workId: null,
		deadlineAt: now + RUN_TIMEOUT_MS,
		reviewDeadlineAt: now + RUN_TIMEOUT_MS,
		phase: "staging",
		visibleView: "before",
		step: 0,
		workPhase: "items",
		operationTime: now,
		publishedAt: null,
		stagedItemCount: 0,
		validatedItemCount: 0,
		pendingWorkCount: 0,
		affectedNodeCount: 0,
		materializedNodeCount: 0,
		proofEpoch: 1,
		// The first two pins are the access clocks. A Move skips the content clock, so new files elsewhere do not stop it.
		clockPins: {
			organization: pins.versions[0] as Doc<"files_move_cohorts">["clockPins"]["organization"],
			workspace: pins.versions[1] as Doc<"files_move_cohorts">["clockPins"]["workspace"],
			review: pins.pendingVersions[0]!,
		},
		billedUserId: billing_pick_billed_user_id({ userId: args.userId, organization: authorized._yay.organization }),
		contentCostCents: 0,
		storedByteDelta: 0,
		storedFileCount: 0,
		billingApplied: false,
		privateByteDelta: 0,
		privateNodeDelta: 0,
		privateAccountingApplied: false,
		planningCursor: null,
		stagingCursor: null,
		validationCursor: null,
		cleanupCursor: null,
		errorCode: null,
		errorMessage: null,
		conflictItemId: null,
	});
	const fields = { cohortId, generation, searchGeneration: (slot?.searchGeneration ?? 0) + 1 };
	if (slot) await ctx.db.patch("files_move_workspace_slots", slot._id, fields);
	else
		await ctx.db.insert("files_move_workspace_slots", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			...fields,
		});
	return Result({ _yay: cohortId });
}

/**
 * A sealed review unit is the manifest. No call loads the whole selection.
 */
export async function files_move_cohorts_db_begin_review_unit(
	ctx: MutationCtx,
	args: {
		runId: Id<"files_pending_update_runs">;
		unitId: Id<"files_pending_update_run_units">;
		planEpoch: number;
		fence: number;
		attemptFence: number;
	},
) {
	const run = await ctx.db.get("files_pending_update_runs", args.runId);
	const unit = await ctx.db.get("files_pending_update_run_units", args.unitId);
	if (
		!run ||
		run.kind !== "accept" ||
		run.step !== "running" ||
		run.fence !== args.fence ||
		run.planEpoch !== args.planEpoch ||
		!unit ||
		unit.runId !== run._id ||
		unit.kind !== "cohort" ||
		unit.planEpoch !== args.planEpoch ||
		unit.status !== "preparing" ||
		unit.attemptFence !== args.attemptFence
	)
		return Result({ _nay: { name: "stopped", message: "This review attempt is no longer running." } });
	const activity = await activities_db_require_by_source_id(ctx, run._id);
	if (
		!activities_is_active(activity.status) ||
		activity.deadlineAt <= Date.now() ||
		!activity.membershipId ||
		typeof activity.membershipLifetime !== "number"
	)
		return Result({ _nay: { name: "stopped", message: "This review attempt has stopped." } });
	if (!run.graphPlanId) throw should_never_happen("Review unit has no sealed graph", args);
	const plan = await ctx.db.get("files_pending_update_plans", run.graphPlanId);
	if (!plan || plan.phase !== "ready" || plan.epoch !== args.planEpoch || plan.runId !== run._id)
		throw should_never_happen("Review unit graph is not ready", args);
	const started = await db_begin(ctx, {
		organizationId: run.organizationId,
		workspaceId: run.workspaceId,
		userId: run.userId,
		membershipId: activity.membershipId,
		membershipLifetime: activity.membershipLifetime,
		origin: { kind: "review", runId: run._id, unitId: unit._id, planEpoch: args.planEpoch },
		fence: args.fence,
		attemptFence: args.attemptFence,
		itemCount: unit.itemCount,
	});
	if (started._yay) await ctx.db.patch("files_pending_update_run_units", unit._id, { cohortId: started._yay });
	return started;
}

async function db_reserve_source(
	ctx: MutationCtx,
	cohort: Doc<"files_move_cohorts">,
	source: Doc<"files_move_source_reservations">["source"],
	mode: Doc<"files_move_source_reservations">["mode"],
) {
	const existing = await ctx.db
		.query("files_move_source_reservations")
		.withIndex("by_source", (q) => q.eq("source.kind", source.kind).eq("source.id", source.id))
		.unique();
	if (existing) {
		if (existing.cohortId !== cohort._id)
			return Result({ _nay: { name: "move_busy", message: "This input is being moved." } });
		if (mode === "subtree" && existing.mode !== "subtree")
			await ctx.db.patch("files_move_source_reservations", existing._id, { mode });
		return Result({ _yay: existing._id });
	}
	return Result({
		_yay: await ctx.db.insert("files_move_source_reservations", {
			cohortId: cohort._id,
			source,
			mode,
			userId: source.kind === "private" || source.kind === "proposal" ? cohort.userId : null,
			generation: cohort.proofEpoch,
		}),
	});
}

async function db_claim_slot(
	ctx: MutationCtx,
	cohort: Doc<"files_move_cohorts">,
	args: { parentId: Doc<"files_nodes">["parentId"]; name: string; afterNodeId?: Id<"files_nodes"> },
) {
	const existing = await ctx.db
		.query("files_move_slot_claims")
		.withIndex("by_workspace_slot", (q) =>
			q
				.eq("organizationId", cohort.organizationId)
				.eq("workspaceId", cohort.workspaceId)
				.eq("parentId", args.parentId)
				.eq("name", args.name),
		)
		.unique();
	if (existing) {
		if (existing.cohortId !== cohort._id)
			return Result({ _nay: { name: "move_busy", message: "This destination is being moved." } });
		if (args.afterNodeId && existing.afterNodeId && existing.afterNodeId !== args.afterNodeId)
			return Result({ _nay: { name: "needs_review", message: "Two selected items have the same destination." } });
		if (args.afterNodeId) await ctx.db.patch("files_move_slot_claims", existing._id, { afterNodeId: args.afterNodeId });
		return Result({ _yay: existing._id });
	}
	const before = await files_saved_placement_db_get_slot(
		ctx.db,
		{ ...cohort, ...args },
		{ cohortId: cohort._id, view: "before" },
	);
	return Result({
		_yay: await ctx.db.insert("files_move_slot_claims", {
			cohortId: cohort._id,
			organizationId: cohort.organizationId,
			workspaceId: cohort.workspaceId,
			parentId: args.parentId,
			name: args.name,
			beforeNodeId: before?._id ?? null,
			afterNodeId: args.afterNodeId ?? null,
		}),
	});
}

async function db_authorize_node(
	ctx: QueryCtx | MutationCtx,
	cohort: Doc<"files_move_cohorts">,
	membership: Doc<"organizations_workspaces_users">,
	node: Doc<"files_nodes"> | null,
	privateSource?: Doc<"files_pending_nodes">,
) {
	if (node && (node.organizationId !== cohort.organizationId || node.workspaceId !== cohort.workspaceId))
		return Result({ _nay: { name: "permission_denied", message: "Permission denied" } });
	const authorized = await access_control_db_authorize_membership(ctx, {
		userAuth: { id: cohort.userId },
		membership,
		permission: "content.write",
		fileNode: node ?? undefined,
	});
	if (authorized._nay) return authorized;
	if (node) {
		const writable = await files_nodes_db_require_user_writable(ctx, { node, userId: cohort.userId });
		if (
			writable._nay &&
			privateSource &&
			(await files_pending_nodes_db_can_save_to_copied_parent(ctx, {
				membership,
				node: privateSource,
				savedParent: node,
				cohort: { cohortId: cohort._id, fence: cohort.fence, attemptFence: cohort.attemptFence },
			}))
		)
			return Result({ _yay: null });
		return writable;
	}
	return Result({ _yay: null });
}

async function db_reserve_saved(
	ctx: MutationCtx,
	cohort: Doc<"files_move_cohorts">,
	args: {
		node: Doc<"files_nodes">;
		role: Doc<"files_move_cohort_nodes">["role"];
		itemId?: Id<"files_move_cohort_items">;
	},
) {
	const { node } = args;
	const existing = await ctx.db
		.query("files_move_cohort_nodes")
		.withIndex("by_cohort_node", (q) => q.eq("cohortId", cohort._id).eq("nodeId", node._id))
		.unique();
	if (existing) {
		if (
			args.itemId &&
			(existing.itemId === null ||
				existing.role === "anchor" ||
				(args.role === "replacement" && existing.role === "descendant"))
		)
			await ctx.db.patch("files_move_cohort_nodes", existing._id, {
				itemId: args.itemId,
				role: args.role,
				status: "planned",
			});
		return Result({ _yay: existing._id });
	}
	const busy = await files_move_reservations_db_check(ctx.db, { source: { kind: "saved", id: node._id } });
	if (busy._nay) return busy;
	const source = await db_reserve_source(
		ctx,
		cohort,
		{ kind: "saved", id: node._id },
		node.kind === "folder" && args.role !== "anchor" ? "subtree" : "placement",
	);
	if (source._nay) return source;
	const claim = node.archiveOperationId === null ? await db_claim_slot(ctx, cohort, node) : Result({ _yay: null });
	if (claim._nay) return claim;
	const place = {
		cohortId: cohort._id,
		nodeId: node._id,
		nodeCreationTime: node._creationTime,
		organizationId: cohort.organizationId,
		workspaceId: cohort.workspaceId,
		...placement_header(node),
		contentId: null,
	};
	const beforePlaceId = await ctx.db.insert("files_saved_places", { ...place, view: "before" });
	const afterPlaceId = await ctx.db.insert("files_saved_places", { ...place, view: "after" });
	const latest = (await ctx.db.get("files_move_cohorts", cohort._id))!;
	const nodeRecordId = await ctx.db.insert("files_move_cohort_nodes", {
		cohortId: cohort._id,
		nodeId: node._id,
		order: latest.affectedNodeCount,
		role: args.role,
		itemId: args.itemId ?? null,
		beforePlaceId,
		afterPlaceId,
		sourceContentVersion: await files_nodes_db_get_content_version(ctx, node),
		status: "planned",
		validatedEpoch: null,
		sourceReservationId: source._yay,
	});
	await ctx.db.patch("files_nodes", node._id, { moveCohortId: cohort._id });
	await ctx.db.patch("files_move_cohorts", cohort._id, { affectedNodeCount: latest.affectedNodeCount + 1 });
	return Result({ _yay: nodeRecordId });
}

export async function files_move_cohorts_db_schedule(
	ctx: MutationCtx,
	args: { cohortId: Id<"files_move_cohorts">; delayMs?: number },
) {
	const cohort = await ctx.db.get("files_move_cohorts", args.cohortId);
	if (cohort && cohort.phase !== "complete")
		await ctx.scheduler.runAfter(args.delayMs ?? 0, internal.files_move_cohorts.run, {
			cohortId: cohort._id,
			step: cohort.step,
		});
}

export async function files_move_cohorts_db_request_stop(
	ctx: MutationCtx,
	args: { cohortId: Id<"files_move_cohorts"> },
) {
	const cohort = await ctx.db.get("files_move_cohorts", args.cohortId);
	if (!cohort || cohort.phase === "complete") return;
	if (cohort.publishedAt === null && cohort.phase !== "aborting")
		await ctx.db.patch("files_move_cohorts", cohort._id, {
			phase: "aborting",
			workPhase: "abort_content",
			step: cohort.step + 1,
			cleanupCursor: null,
			errorCode: "stopped",
			errorMessage: "This Move stopped before it was saved.",
		});
	await files_move_cohorts_db_schedule(ctx, args);
}

/**
 * Keep the parent job until its published headers or aborted candidates are repaired.
 */
export async function files_move_cohorts_db_stop_origin(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		origin:
			| { kind: "review"; runId: Id<"files_pending_update_runs"> }
			| { kind: "transfer"; runId: Id<"files_transfer_runs"> };
	},
) {
	const slot = await ctx.db
		.query("files_move_workspace_slots")
		.withIndex("by_workspace", (q) => q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId))
		.unique();
	const cohort = slot?.cohortId ? await ctx.db.get("files_move_cohorts", slot.cohortId) : null;
	if (
		!cohort ||
		cohort.phase === "complete" ||
		cohort.origin.kind !== args.origin.kind ||
		cohort.origin.runId !== args.origin.runId
	)
		return true;
	await files_move_cohorts_db_request_stop(ctx, { cohortId: cohort._id });
	return false;
}

export async function files_move_cohorts_db_begin_transfer_item(
	ctx: MutationCtx,
	args: { runId: Id<"files_transfer_runs">; itemId: Id<"files_transfer_items">; fence: number; attemptFence: number },
) {
	const run = await ctx.db.get("files_transfer_runs", args.runId);
	const item = await ctx.db.get("files_transfer_items", args.itemId);
	if (
		!run ||
		run.kind !== "move" ||
		run.publication !== "saved" ||
		run.revision !== args.fence ||
		!item ||
		item.runId !== run._id ||
		item.attempt !== args.attemptFence ||
		item.state !== "pending"
	)
		return Result({ _nay: { name: "stopped", message: "This Move attempt is no longer running." } });
	const activity = await activities_db_require_by_source_id(ctx, run._id);
	if (!activities_is_active(activity.status) || activity.deadlineAt <= Date.now())
		return Result({ _nay: { name: "stopped", message: "This Move has stopped." } });
	return await db_begin(ctx, {
		organizationId: run.organizationId,
		workspaceId: run.workspaceId,
		userId: run.userId,
		membershipId: run.sourceScope.membershipId,
		membershipLifetime: run.sourceScope.membershipLifetime,
		origin: { kind: "transfer", runId: run._id, itemId: item._id },
		fence: args.fence,
		attemptFence: args.attemptFence,
		itemCount: 1,
	});
}

async function db_parent_id(
	ctx: MutationCtx,
	cohort: Doc<"files_move_cohorts">,
	parent: Doc<"files_pending_nodes">["parent"],
) {
	if (parent.kind === "root") return Result({ _yay: "root" as const });
	if (parent.kind === "saved") return Result({ _yay: parent.id });
	const selected = await ctx.db
		.query("files_move_cohort_items")
		.withIndex("by_cohort_target", (q) =>
			q.eq("cohortId", cohort._id).eq("target.kind", "private").eq("target.id", parent.id),
		)
		.unique();
	if (selected) {
		const record = await ctx.db.get("files_move_cohort_nodes", selected.nodeRecordId);
		if (!record) throw should_never_happen("Private Move output has no record", { itemId: selected._id });
		return Result({ _yay: record.nodeId });
	}
	const receipt = await files_saved_placement_db_get_publish_receipt(ctx.db, { ...cohort, privateNodeId: parent.id });
	if (!receipt)
		return Result({ _nay: { name: "needs_review", message: "Save the destination folder with this Move." } });
	return Result({ _yay: receipt.savedNodeId });
}

async function db_allocate_private(
	ctx: MutationCtx,
	cohort: Doc<"files_move_cohorts">,
	node: Doc<"files_pending_nodes">,
	proposal: Doc<"files_pending_updates">,
) {
	if (node.userId !== cohort.userId || node.state !== "active" || !proposal.createIntent)
		return Result({ _nay: { name: "needs_review", message: "This draft changed. Review it again." } });
	const held = await db_reserve_source(
		ctx,
		cohort,
		{ kind: "private", id: node._id },
		node.kind === "folder" ? "subtree" : "placement",
	);
	if (held._nay) return held;
	const opted = await files_pending_overlay_db_set_cohort_allocation(ctx, {
		cohortId: cohort._id,
		fence: cohort.fence,
		attemptFence: cohort.attemptFence,
		privateNodeId: node._id,
	});
	if (opted._nay) return opted;
	// This output is after-only. Its final parent is resolved after every selected draft has an ID.
	const path = path_join("/", node.name);
	const intent = proposal.createIntent;
	const fields = {
		organizationId: cohort.organizationId,
		workspaceId: cohort.workspaceId,
		parentId: "root" as const,
		kind: node.kind,
		name: node.name,
		sortName: files_sort_text_key(node.name),
		path,
		treePath: files_derive_tree_path_for_file_node(path, node.kind),
		pathDepth: 1,
		lowercaseExtension: files_lowercase_extension(path, node.kind),
		contentType: intent.kind === "folder" ? null : intent.contentType,
		assetId: intent.kind === "stored" ? intent.assetId : null,
		contentByteSize: intent.kind === "stored" ? intent.size : null,
		textKind: intent.kind === "text" ? intent.textKind : null,
		collaborationEnabled: intent.kind === "text" ? intent.collaborationEnabled : null,
		yjsSnapshotId: null,
		yjsLastSequenceId: null,
		statsId: null,
		contentTooLargeByteSize: null,
		contentShapeMismatchAt: null,
		contentYjsStateTooLargeByteSize: null,
		contentFrontmatterTooLargeFieldCount: null,
		contentFrontmatterTooLargeIndexDocumentCount: null,
		restrictedScopeNodeId: null,
		isRestrictedScopeRoot: false,
		archiveOperationId: null,
		writePolicy: proposal.copiedFrom?.sourceWritePolicy ?? null,
		newChildWritePolicy: proposal.copiedFrom?.sourceNewChildWritePolicy ?? null,
		createdBy: cohort.userId,
		updatedBy: cohort.userId,
		updatedAt: cohort.operationTime,
		publishedFromPrivateNodeId: node._id,
		moveCohortId: cohort._id,
	};
	const nodeId = await ctx.db.insert("files_nodes", fields);
	const saved = (await ctx.db.get("files_nodes", nodeId))!;
	const afterPlaceId = await ctx.db.insert("files_saved_places", {
		cohortId: cohort._id,
		view: "after",
		nodeId,
		nodeCreationTime: saved._creationTime,
		organizationId: cohort.organizationId,
		workspaceId: cohort.workspaceId,
		...placement_header(saved),
		contentId: null,
	});
	const latest = (await ctx.db.get("files_move_cohorts", cohort._id))!;
	const nodeRecordId = await ctx.db.insert("files_move_cohort_nodes", {
		cohortId: cohort._id,
		nodeId,
		order: latest.affectedNodeCount,
		role: "allocated",
		itemId: null,
		beforePlaceId: null,
		afterPlaceId,
		sourceContentVersion: null,
		status: "planned",
		validatedEpoch: null,
		sourceReservationId: held._yay,
	});
	await db_reserve_source(ctx, cohort, { kind: "saved", id: nodeId }, node.kind === "folder" ? "subtree" : "placement");
	await ctx.db.patch("files_move_cohorts", cohort._id, { affectedNodeCount: latest.affectedNodeCount + 1 });
	await ctx.db.insert("files_pending_node_publish_receipts", {
		organizationId: cohort.organizationId,
		workspaceId: cohort.workspaceId,
		userId: cohort.userId,
		privateNodeId: node._id,
		creationGeneration: node.creationGeneration,
		structuralRevision: node.structuralRevision,
		proposalRevision: proposal.revision,
		savedNodeId: nodeId,
		createdAt: cohort.operationTime,
		moveView: { cohortId: cohort._id, view: "after" },
		copiedWritePolicy: node.kind === "folder" ? proposal.copiedFrom?.sourceWritePolicy : undefined,
	});
	return Result({ _yay: nodeRecordId });
}

async function db_items(
	ctx: MutationCtx,
	cohort: Doc<"files_move_cohorts">,
	membership: Doc<"organizations_workspaces_users">,
) {
	const order = cohort.stagedItemCount;
	let target: Doc<"files_move_cohort_items">["target"];
	let origin: Doc<"files_move_cohort_items">["origin"];
	let proposal: Doc<"files_pending_updates"> | null = null;
	let input: Doc<"files_pending_update_run_items"> | null = null;
	if (cohort.origin.kind === "review") {
		input = await ctx.db
			.query("files_pending_update_run_items")
			.withIndex("by_unit_order", (q) => q.eq("unitId", cohort.origin.kind === "review" ? cohort.origin.unitId : null))
			.order("asc")
			.paginate({ cursor: cohort.planningCursor, numItems: 1 })
			.then((page) => {
				return { item: page.page[0] ?? null, cursor: page.continueCursor };
			})
			.then(async (page) => {
				await ctx.db.patch("files_move_cohorts", cohort._id, { planningCursor: page.cursor });
				return page.item;
			});
		if (!input) return Result({ _yay: { done: true } });
		proposal = await ctx.db.get("files_pending_updates", input.pendingUpdateId);
		if (!proposal || proposal.revision !== input.reviewedRevision || proposal.userId !== cohort.userId)
			return Result({ _nay: { name: "needs_review", message: "A reviewed change was revised. Review it again." } });
		target = proposal.target;
		origin = { kind: "review", itemId: input._id };
	} else {
		if (order !== 0) return Result({ _yay: { done: true } });
		const transfer = await ctx.db.get("files_transfer_items", cohort.origin.itemId);
		if (!transfer) throw should_never_happen("Move origin item is missing", { cohortId: cohort._id });
		target = transfer.source;
		origin = { kind: "transfer", itemId: transfer._id };
	}
	const transferRun =
		cohort.origin.kind === "transfer" ? await ctx.db.get("files_transfer_runs", cohort.origin.runId) : null;
	const held = proposal
		? await db_reserve_source(ctx, cohort, { kind: "proposal", id: proposal._id }, "proposal")
		: Result({ _yay: null });
	if (held._nay) return held;
	let reserved;
	if (target.kind === "saved") {
		const node = await files_saved_placement_db_get_node(ctx.db, target.id, { cohortId: cohort._id, view: "before" });
		if (
			!node ||
			node.archiveOperationId !== (transferRun?.rename?.source.archiveOperationId ?? null) ||
			(input?.reviewSource && input.reviewSource.path !== node.path)
		)
			return Result({ _nay: { name: "needs_review", message: "A reviewed source moved. Review it again." } });
		if (origin.kind === "transfer") {
			const transfer = (await ctx.db.get("files_transfer_items", origin.itemId))!;
			if (
				node.path !== transfer.sourcePath ||
				node.name !== transfer.sourceName ||
				node.parentId !== (transfer.sourceParent.kind === "root" ? "root" : transfer.sourceParent.id)
			)
				return Result({ _nay: { name: "source_changed", message: "The source changed. Review this Move again." } });
		}
		const authorized = await db_authorize_node(ctx, cohort, membership, node);
		if (authorized._nay) return authorized;
		reserved = await db_reserve_saved(ctx, cohort, { node, role: "selected" });
	} else {
		const node = await ctx.db.get("files_pending_nodes", target.id);
		if (
			!node ||
			!proposal ||
			node.creationGeneration !== input?.reviewSource?.privateVersion?.creationGeneration ||
			node.structuralRevision !== input?.reviewSource?.privateVersion?.structuralRevision
		)
			return Result({ _nay: { name: "needs_review", message: "A reviewed draft changed. Review it again." } });
		reserved = await db_allocate_private(ctx, cohort, node, proposal);
	}
	if (reserved._nay) return reserved;
	// Accepting a delete ignores the content changes and removes the draft with its pending index docs.
	const afterProposal =
		!proposal?.pendingArchive && (proposal?.content || proposal?.pendingReplacement)
			? (() => {
					const { _id: _id, _creationTime: _time, moveCohortId: _marker, ...header } = proposal;
					return { ...header, pendingMove: undefined, pendingArchive: undefined, revision: proposal.revision + 1 };
				})()
			: null;
	const itemId = await ctx.db.insert("files_move_cohort_items", {
		cohortId: cohort._id,
		order,
		origin,
		target,
		pendingUpdateId: proposal?._id ?? null,
		reviewedRevision: proposal?.revision ?? null,
		selectedContentStateId: input?.selectedContentStateId ?? null,
		privateVersion: input?.reviewSource?.privateVersion ?? null,
		mediaDependencySet: input?.mediaDependencySet ?? null,
		nodeRecordId: reserved._yay,
		afterProposal,
		contentId: null,
		replacementItemId: null,
		status: "planned",
		validatedEpoch: null,
		billingState: "none",
	});
	await ctx.db.patch("files_move_cohort_nodes", reserved._yay, {
		itemId,
		role: target.kind === "private" ? "allocated" : "selected",
	});
	if (proposal) await ctx.db.patch("files_pending_updates", proposal._id, { moveCohortId: cohort._id });
	await ctx.db.patch("files_move_cohorts", cohort._id, { stagedItemCount: order + 1 });
	return Result({ _yay: { done: false } });
}

async function db_rename_parents(
	ctx: MutationCtx,
	cohort: Doc<"files_move_cohorts">,
	membership: Doc<"organizations_workspaces_users">,
) {
	if (cohort.origin.kind !== "transfer") return Result({ _yay: { done: true } });
	const run = (await ctx.db.get("files_transfer_runs", cohort.origin.runId))!;
	if (!run.rename) return Result({ _yay: { done: true } });
	const names = path_extract_segments_from(run.rename.inputPath);
	if (!cohort.planningCursor) {
		await ctx.db.patch("files_move_cohorts", cohort._id, {
			planningCursor: JSON.stringify({
				segmentIndex: 0,
				parentId: run.rename.source.parentId,
				parentPath: run.rename.parentPath,
				parentArchiveOperationId: run.rename.parentArchiveOperationId,
			}),
		});
		return Result({ _yay: { done: false } });
	}
	const cursor = JSON.parse(cohort.planningCursor) as {
		segmentIndex: number;
		parentId: Doc<"files_nodes">["parentId"];
		parentPath: string;
		parentArchiveOperationId: string | null;
	};
	const parent =
		cursor.parentId === "root"
			? null
			: await files_saved_placement_db_get_node(ctx.db, cursor.parentId, { cohortId: cohort._id, view: "after" });
	if (
		(parent?.path ?? "/") !== cursor.parentPath ||
		(parent?.archiveOperationId ?? null) !== cursor.parentArchiveOperationId
	)
		return Result({
			_nay: { name: "destination_changed", message: "The destination changed. Review this Rename again." },
		});
	if (cursor.segmentIndex >= names.length - 1) {
		await ctx.db.patch("files_transfer_runs", run._id, {
			targetParent: cursor.parentId === "root" ? { kind: "root" } : { kind: "saved", id: cursor.parentId },
			targetPath: cursor.parentPath,
		});
		return Result({ _yay: { done: true } });
	}
	const access = await db_authorize_node(ctx, cohort, membership, parent);
	if (access._nay) return access;
	const name = names[cursor.segmentIndex]!;
	if (cursor.parentId === run.rename.source.parentId && name === run.rename.source.name)
		return Result({ _nay: { name: "destination_changed", message: "A folder cannot move into itself." } });
	let folder =
		cursor.parentArchiveOperationId === null
			? await files_saved_placement_db_get_slot(
					ctx.db,
					{ ...cohort, parentId: cursor.parentId, name },
					{ cohortId: cohort._id, view: "after" },
				)
			: await ctx.db
					.query("files_nodes")
					.withIndex("by_organization_workspace_parent_name_archiveOperation", (q) =>
						q
							.eq("organizationId", cohort.organizationId)
							.eq("workspaceId", cohort.workspaceId)
							.eq("moveCohortId", undefined)
							.eq("parentId", cursor.parentId)
							.eq("name", name)
							.eq("archiveOperationId", cursor.parentArchiveOperationId),
					)
					.unique();
	if (folder) {
		const selected = await ctx.db
			.query("files_move_cohort_items")
			.withIndex("by_cohort_target", (q) =>
				q.eq("cohortId", cohort._id).eq("target.kind", "saved").eq("target.id", folder!._id),
			)
			.unique();
		if (selected || folder.kind !== "folder")
			return Result({ _nay: { name: "destination_changed", message: "This folder already exists." } });
		const allowed = await db_authorize_node(ctx, cohort, membership, folder);
		if (allowed._nay) return allowed;
		const reserved = await db_reserve_saved(ctx, cohort, { node: folder, role: "anchor" });
		if (reserved._nay) return reserved;
	} else {
		const claimed =
			cursor.parentArchiveOperationId === null
				? await db_claim_slot(ctx, cohort, { parentId: cursor.parentId, name })
				: Result({ _yay: null });
		if (claimed._nay) return claimed;
		const path = path_join(cursor.parentPath, name);
		const nodeId = await ctx.db.insert("files_nodes", {
			organizationId: cohort.organizationId,
			workspaceId: cohort.workspaceId,
			kind: "folder",
			parentId: cursor.parentId,
			name,
			sortName: files_sort_text_key(name),
			path,
			treePath: files_derive_tree_path_for_file_node(path, "folder"),
			pathDepth: path_extract_segments_from(path).length,
			lowercaseExtension: null,
			contentType: null,
			assetId: null,
			contentByteSize: null,
			textKind: null,
			collaborationEnabled: null,
			yjsSnapshotId: null,
			yjsLastSequenceId: null,
			statsId: null,
			contentTooLargeByteSize: null,
			contentShapeMismatchAt: null,
			contentYjsStateTooLargeByteSize: null,
			contentFrontmatterTooLargeFieldCount: null,
			contentFrontmatterTooLargeIndexDocumentCount: null,
			restrictedScopeNodeId: parent?.restrictedScopeNodeId ?? null,
			isRestrictedScopeRoot: false,
			archiveOperationId: cursor.parentArchiveOperationId,
			writePolicy: parent?.newChildWritePolicy ?? null,
			newChildWritePolicy: parent?.newChildWritePolicy ?? null,
			createdBy: cohort.userId,
			updatedBy: cohort.userId,
			updatedAt: cohort.operationTime,
			moveCohortId: cohort._id,
			...files_ancestor_fields(parent ? [...files_ancestor_ids(parent), parent._id] : []),
		});
		folder = (await ctx.db.get("files_nodes", nodeId))!;
		const held = await db_reserve_source(ctx, cohort, { kind: "saved", id: nodeId }, "subtree");
		if (held._nay) throw should_never_happen("New Rename folder could not be reserved", { nodeId });
		const afterPlaceId = await ctx.db.insert("files_saved_places", {
			cohortId: cohort._id,
			view: "after",
			nodeId,
			nodeCreationTime: folder._creationTime,
			organizationId: cohort.organizationId,
			workspaceId: cohort.workspaceId,
			...placement_header(folder),
			contentId: null,
		});
		const latest = (await ctx.db.get("files_move_cohorts", cohort._id))!;
		await ctx.db.insert("files_move_cohort_nodes", {
			cohortId: cohort._id,
			nodeId,
			order: latest.affectedNodeCount,
			role: "derived",
			itemId: null,
			beforePlaceId: null,
			afterPlaceId,
			sourceContentVersion: null,
			status: "reserved",
			validatedEpoch: null,
			sourceReservationId: held._yay,
		});
		await ctx.db.patch("files_move_cohorts", cohort._id, { affectedNodeCount: latest.affectedNodeCount + 1 });
		if (claimed._yay) await ctx.db.patch("files_move_slot_claims", claimed._yay, { afterNodeId: nodeId });
	}
	await ctx.db.patch("files_move_cohorts", cohort._id, {
		planningCursor: JSON.stringify({
			segmentIndex: cursor.segmentIndex + 1,
			parentId: folder._id,
			parentPath: folder.path,
			parentArchiveOperationId: folder.archiveOperationId,
		}),
	});
	return Result({ _yay: { done: false } });
}

async function db_add_subtree(
	ctx: MutationCtx,
	cohort: Doc<"files_move_cohorts">,
	record: Doc<"files_move_cohort_nodes">,
) {
	const node = await ctx.db.get("files_nodes", record.nodeId);
	if (node?.kind !== "folder" || record.role === "anchor" || record.role === "allocated" || record.role === "derived")
		return;
	// Replacement must also check children already collected by a selected parent.
	const key = `${record.role === "replacement" ? "replacement" : "saved"}-children:${record.nodeId}`;
	const existing = await ctx.db
		.query("files_move_work_ranges")
		.withIndex("by_cohort_key", (q) => q.eq("cohortId", cohort._id).eq("key", key))
		.unique();
	if (existing) return;
	await ctx.db.insert("files_move_work_ranges", {
		cohortId: cohort._id,
		key,
		nodeRecordId: record._id,
		ownerWorkId: null,
		order: record.order,
		kind: "saved_subtree",
		range: { kind: "node", nodeId: node._id },
		phase: "collect",
		status: "queued",
		cursor: JSON.stringify({ source: "before", cursor: null }),
		generation: cohort.proofEpoch,
		attemptFence: cohort.attemptFence,
		workId: null,
		nextAttemptAt: Date.now(),
		processedCount: 0,
	});
	const latest = (await ctx.db.get("files_move_cohorts", cohort._id))!;
	await ctx.db.patch("files_move_cohorts", cohort._id, { pendingWorkCount: latest.pendingWorkCount + 1 });
}

async function db_descendants(
	ctx: MutationCtx,
	cohort: Doc<"files_move_cohorts">,
	membership: Doc<"organizations_workspaces_users">,
) {
	// Add one selected tree at a time, then walk its physical children by exact parent ID.
	if (cohort.planningCursor !== "trees") {
		const page = await ctx.db
			.query("files_move_cohort_nodes")
			.withIndex("by_cohort_order", (q) => q.eq("cohortId", cohort._id))
			.paginate({ cursor: cohort.planningCursor, numItems: 1 });
		for (const record of page.page) await db_add_subtree(ctx, cohort, record);
		await ctx.db.patch("files_move_cohorts", cohort._id, {
			planningCursor: page.isDone ? "trees" : page.continueCursor,
		});
		return Result({ _yay: { done: false } });
	}
	let range = await ctx.db
		.query("files_move_work_ranges")
		.withIndex("by_cohort_phase_status_order", (q) =>
			q.eq("cohortId", cohort._id).eq("phase", "collect").eq("status", "running"),
		)
		.first();
	range ??= await ctx.db
		.query("files_move_work_ranges")
		.withIndex("by_cohort_phase_status_order", (q) =>
			q.eq("cohortId", cohort._id).eq("phase", "collect").eq("status", "queued"),
		)
		.first();
	if (!range) return Result({ _yay: { done: true } });
	if (range.kind !== "saved_subtree" || range.range.kind !== "node" || !range.nodeRecordId)
		throw should_never_happen("Unexpected saved tree work", { rangeId: range._id });
	const rootRecord = (await ctx.db.get("files_move_cohort_nodes", range.nodeRecordId))!;
	if (rootRecord.itemId) {
		const selected = (await ctx.db.get("files_move_cohort_items", rootRecord.itemId))!;
		const selectedRecord = (await ctx.db.get("files_move_cohort_nodes", selected.nodeRecordId))!;
		const selectedNode = await files_saved_placement_db_get_node(ctx.db, selectedRecord.nodeId, {
			cohortId: cohort._id,
			view: "before",
		});
		const authorized = await db_authorize_node(ctx, cohort, membership, selectedNode);
		if (authorized._nay) return authorized;
	}
	const cursor = JSON.parse(range.cursor!) as { source: "before" | "normal"; cursor: string | null };
	const parentId = range.range.nodeId;
	const page =
		cursor.source === "before"
			? await ctx.db
					.query("files_saved_places")
					.withIndex("by_view_parent_name", (q) =>
						q.eq("cohortId", cohort._id).eq("view", "before").eq("parentId", parentId),
					)
					.paginate({ cursor: cursor.cursor, numItems: 1 })
			: await ctx.db
					.query("files_nodes")
					.withIndex("by_organization_workspace_parent_name_archiveOperation", (q) =>
						q
							.eq("organizationId", cohort.organizationId)
							.eq("workspaceId", cohort.workspaceId)
							.eq("moveCohortId", undefined)
							.eq("parentId", parentId),
					)
					.paginate({ cursor: cursor.cursor, numItems: 1 });
	for (const entry of page.page) {
		const nodeId = "nodeId" in entry ? entry.nodeId : entry._id;
		const child = (await files_saved_placement_db_get_node(ctx.db, nodeId, {
			cohortId: cohort._id,
			view: "before",
		}))!;
		const reserved = await db_reserve_saved(ctx, cohort, {
			node: child,
			role: rootRecord.role === "replacement" ? "replacement" : "descendant",
			itemId: rootRecord.itemId ?? undefined,
		});
		if (reserved._nay) return reserved;
		await db_add_subtree(ctx, cohort, (await ctx.db.get("files_move_cohort_nodes", reserved._yay))!);
	}
	const done = cursor.source === "normal" && page.isDone;
	await ctx.db.patch("files_move_work_ranges", range._id, {
		cursor: JSON.stringify(
			cursor.source === "before" && page.isDone
				? { source: "normal", cursor: null }
				: { source: cursor.source, cursor: page.continueCursor },
		),
		status: done ? "complete" : "running",
	});
	if (done) {
		const latest = (await ctx.db.get("files_move_cohorts", cohort._id))!;
		await ctx.db.patch("files_move_cohorts", cohort._id, { pendingWorkCount: latest.pendingWorkCount - 1 });
	}
	return Result({ _yay: { done: false } });
}

async function db_headers(
	ctx: MutationCtx,
	cohort: Doc<"files_move_cohorts">,
	membership: Doc<"organizations_workspaces_users">,
) {
	const record = cohort.planningCursor
		? await ctx.db.get("files_move_cohort_nodes", cohort.planningCursor as Id<"files_move_cohort_nodes">)
		: await ctx.db
				.query("files_move_cohort_nodes")
				.withIndex("by_cohort_status_order", (q) => q.eq("cohortId", cohort._id).eq("status", "planned"))
				.first();
	if (!record) return Result({ _yay: { done: true } });
	if (!record.afterPlaceId) throw should_never_happen("Move candidate has no header", { recordId: record._id });
	const old = record.beforePlaceId ? (await ctx.db.get("files_saved_places", record.beforePlaceId))! : null;
	const item = record.itemId ? await ctx.db.get("files_move_cohort_items", record.itemId) : null;
	const selected = record.role === "selected" || record.role === "allocated";
	const proposal =
		selected && item?.pendingUpdateId ? await ctx.db.get("files_pending_updates", item.pendingUpdateId) : null;
	const physical = (await ctx.db.get("files_nodes", record.nodeId))!;
	let parentId = old?.parentId ?? "root";
	let name = old?.name ?? physical.name;
	let archiveOperationId = old?.archiveOperationId ?? null;
	// Keep an older archive separate from the active folder being replaced.
	if ((record.role === "replacement" && archiveOperationId === null) || proposal?.pendingArchive)
		archiveOperationId = cohort._id;
	if (selected && item) {
		let parent: Doc<"files_pending_nodes">["parent"];
		if (item.origin.kind === "transfer" && cohort.origin.kind === "transfer") {
			const run = (await ctx.db.get("files_transfer_runs", cohort.origin.runId))!;
			const input = (await ctx.db.get("files_transfer_items", item.origin.itemId))!;
			parent = run.targetParent;
			name = input.targetName;
		} else if (proposal?.pendingMove) {
			parent = proposal.pendingMove.destParent;
			name = proposal.pendingMove.destName;
		} else if (item.target.kind === "private") {
			const node = (await ctx.db.get("files_pending_nodes", item.target.id))!;
			parent = node.parent;
			name = node.name;
		} else parent = parentId === "root" ? { kind: "root" } : { kind: "saved", id: parentId };
		const resolved = await db_parent_id(ctx, cohort, parent);
		if (resolved._nay) return resolved;
		parentId = resolved._yay;
	}
	let parent: Doc<"files_nodes"> | null = null;
	if (parentId !== "root") {
		if (parentId === record.nodeId)
			return Result({ _nay: { name: "needs_review", message: "A folder cannot move into itself." } });
		let parentRecord = await ctx.db
			.query("files_move_cohort_nodes")
			.withIndex("by_cohort_node", (q) => q.eq("cohortId", cohort._id).eq("nodeId", parentId))
			.unique();
		if (!parentRecord) {
			const sourceParent = await files_saved_placement_db_get_node(ctx.db, parentId, {
				cohortId: cohort._id,
				view: "before",
			});
			const rename =
				cohort.origin.kind === "transfer"
					? (await ctx.db.get("files_transfer_runs", cohort.origin.runId))?.rename
					: undefined;
			const archivedRenameParent =
				rename &&
				parentId === rename.source.parentId &&
				sourceParent?.path === rename.parentPath &&
				sourceParent.archiveOperationId === rename.parentArchiveOperationId;
			if (
				!sourceParent ||
				sourceParent.kind !== "folder" ||
				(sourceParent.archiveOperationId !== null && !archivedRenameParent)
			)
				return Result({ _nay: { name: "needs_review", message: "The destination folder changed. Review it again." } });
			const reserved = await db_reserve_saved(ctx, cohort, { node: sourceParent, role: "anchor" });
			if (reserved._nay) return reserved;
			parentRecord = (await ctx.db.get("files_move_cohort_nodes", reserved._yay))!;
		}
		if (parentRecord.status === "planned") {
			await ctx.db.patch("files_move_cohorts", cohort._id, { planningCursor: parentRecord._id });
			return Result({ _yay: { done: false } });
		}
		parent = await files_saved_placement_db_get_node(ctx.db, parentId, { cohortId: cohort._id, view: "after" });
		if (!parent) throw should_never_happen("Sealed Move parent has no header", { parentId });
	}
	if (selected && item?.origin.kind === "transfer" && cohort.origin.kind === "transfer") {
		const run = (await ctx.db.get("files_transfer_runs", cohort.origin.runId))!;
		if ((parent?.path ?? "/") !== run.targetPath)
			return Result({
				_nay: { name: "destination_changed", message: "The destination changed. Review this Move again." },
			});
	}
	if (selected && item?.origin.kind === "review") {
		const reviewed = (await ctx.db.get("files_pending_update_run_items", item.origin.itemId))!;
		if (reviewed.expectedDestinationParentPath !== null) {
			const beforeParent =
				parentId === "root"
					? null
					: await files_saved_placement_db_get_node(ctx.db, parentId, { cohortId: cohort._id, view: "before" });
			// Selected private parents have no saved BEFORE header. Their versions are pinned with each item.
			if (
				(parentId === "root" || beforeParent) &&
				(beforeParent?.path ?? "/") !== reviewed.expectedDestinationParentPath
			)
				return Result({ _nay: { name: "needs_review", message: "A reviewed destination moved. Review it again." } });
		}
	}
	const path = path_join(parent?.path ?? "/", name);
	const scope = physical.isRestrictedScopeRoot ? physical._id : (parent?.restrictedScopeNodeId ?? null);
	if (selected) {
		const run = cohort.origin.kind === "transfer" ? await ctx.db.get("files_transfer_runs", cohort.origin.runId) : null;
		if (!run?.rename || old?.parentId !== parentId) {
			const privateSource =
				item?.target.kind === "private" ? (await ctx.db.get("files_pending_nodes", item.target.id))! : undefined;
			const access = await db_authorize_node(ctx, cohort, membership, parent, privateSource);
			if (access._nay) return access;
		}
		if (old && old.parentId !== "root") {
			const sourceParent = await files_saved_placement_db_get_node(ctx.db, old.parentId, {
				cohortId: cohort._id,
				view: "before",
			});
			if (sourceParent) {
				const writable = await files_nodes_db_require_user_writable(ctx, { node: sourceParent, userId: cohort.userId });
				if (writable._nay) return writable;
			}
		}
		if (
			old?.restrictedScopeNodeId &&
			old.restrictedScopeNodeId !== record.nodeId &&
			old.restrictedScopeNodeId !== scope
		) {
			const authorized = await access_control_db_authorize_membership(ctx, {
				membership,
				userAuth: { id: cohort.userId },
				permission: "content.permissions.manage",
				fileNode: { ...physical, ...placement_header_from_place(old) },
			});
			if (authorized._nay)
				return Result({
					_nay: {
						name: "permission_denied",
						message: "You need Can manage on the shared folder to move this out of it.",
					},
				});
		}
	}
	let nestedReparented = false;
	if (record.role === "descendant" && physical.isRestrictedScopeRoot && item) {
		const rootRecord = (await ctx.db.get("files_move_cohort_nodes", item.nodeRecordId))!;
		const rootBefore = rootRecord.beforePlaceId
			? await ctx.db.get("files_saved_places", rootRecord.beforePlaceId)
			: null;
		const rootAfter = rootRecord.afterPlaceId ? await ctx.db.get("files_saved_places", rootRecord.afterPlaceId) : null;
		nestedReparented = rootBefore?.parentId !== rootAfter?.parentId;
	}
	if (record.role === "replacement" || nestedReparented) {
		const authorized = await db_authorize_node(ctx, cohort, membership, {
			...physical,
			...placement_header_from_place(old!),
		});
		if (authorized._nay) return authorized;
	}
	const afterArchive = archiveOperationId ?? parent?.archiveOperationId ?? null;
	if (selected && afterArchive === null) {
		const occupant = await files_saved_placement_db_get_slot(
			ctx.db,
			{ ...cohort, parentId, name },
			{ cohortId: cohort._id, view: "before" },
		);
		if (occupant && occupant._id !== record.nodeId) {
			const occupantRecord = await ctx.db
				.query("files_move_cohort_nodes")
				.withIndex("by_cohort_node", (q) => q.eq("cohortId", cohort._id).eq("nodeId", occupant._id))
				.unique();
			if (!occupantRecord || occupantRecord.role === "anchor" || occupantRecord.role === "descendant") {
				let replacement = proposal?.pendingMove?.replacesTarget;
				let version = proposal?.pendingMove?.replacesContentVersion ?? null;
				if (item?.origin.kind === "transfer") {
					const input = (await ctx.db.get("files_transfer_items", item.origin.itemId))!;
					replacement = input.conflictTarget ?? undefined;
					version = input.conflictVersion?.kind === "pending" ? null : input.conflictVersion;
				}
				if (
					replacement?.kind !== "saved" ||
					replacement.id !== occupant._id ||
					!files_transfer_source_versions_equal(await files_nodes_db_get_content_version(ctx, occupant), version)
				)
					return Result({
						_nay: { name: "destination_changed", message: "The destination is occupied. Review this Move again." },
					});
				const access = await db_authorize_node(ctx, cohort, membership, occupant);
				if (access._nay) return access;
				if (occupant.kind === "folder") {
					const child = await ctx.db
						.query("files_nodes")
						.withIndex("by_organization_workspace_parent_archiveOperation_name", (q) =>
							q
								.eq("organizationId", cohort.organizationId)
								.eq("workspaceId", cohort.workspaceId)
								.eq("moveCohortId", undefined)
								.eq("parentId", occupant._id)
								.eq("archiveOperationId", null),
						)
						.first();
					const stagedChild = await ctx.db
						.query("files_saved_places")
						.withIndex("by_view_parent_archive_name", (q) =>
							q
								.eq("cohortId", cohort._id)
								.eq("view", "before")
								.eq("parentId", occupant._id)
								.eq("archiveOperationId", null),
						)
						.first();
					if (child || stagedChild)
						return Result({ _nay: { name: "needs_review", message: "Cannot replace a non-empty folder." } });
				}
				const reserved = await db_reserve_saved(ctx, cohort, {
					node: occupant,
					role: "replacement",
					itemId: item?._id,
				});
				if (reserved._nay) return reserved;
				await db_add_subtree(ctx, cohort, (await ctx.db.get("files_move_cohort_nodes", reserved._yay))!);
				// An inherited child may already own its final slot. Replacement vacates it.
				const slot = await ctx.db
					.query("files_move_slot_claims")
					.withIndex("by_workspace_slot", (q) =>
						q
							.eq("organizationId", cohort.organizationId)
							.eq("workspaceId", cohort.workspaceId)
							.eq("parentId", parentId)
							.eq("name", name),
					)
					.unique();
				if (slot?.afterNodeId === occupant._id)
					await ctx.db.patch("files_move_slot_claims", slot._id, { afterNodeId: null });
			}
		}
	}
	const claim =
		afterArchive === null
			? await db_claim_slot(ctx, cohort, { parentId, name, afterNodeId: record.nodeId })
			: Result({ _yay: null });
	if (claim._nay) return claim;
	await ctx.db.patch("files_saved_places", record.afterPlaceId, {
		parentId,
		name,
		sortName: files_sort_text_key(name),
		path,
		treePath: files_derive_tree_path_for_file_node(path, physical.kind),
		pathDepth: path_extract_segments_from(path).length,
		lowercaseExtension: files_lowercase_extension(path, physical.kind),
		restrictedScopeNodeId: scope,
		isRestrictedScopeRoot: scope === physical._id,
		archiveOperationId: afterArchive,
		...files_ancestor_fields(parent ? [...files_ancestor_ids(parent), parent._id] : []),
		...(selected || (old && old.archiveOperationId !== afterArchive)
			? { updatedAt: cohort.operationTime, updatedBy: cohort.userId }
			: {}),
	});
	if (
		item?.target.kind === "private" &&
		physical.kind === "folder" &&
		proposal?.copiedFrom?.sourceWritePolicy !== undefined
	) {
		const privateNodeId = item.target.id;
		const receipt = await ctx.db
			.query("files_pending_node_publish_receipts")
			.withIndex("by_privateNode", (q) =>
				q.eq("privateNodeId", privateNodeId).eq("moveView.cohortId", cohort._id).eq("moveView.view", "after"),
			)
			.unique();
		if (!receipt) throw should_never_happen("Copied folder candidate has no receipt", { itemId: item._id });
		await ctx.db.patch("files_pending_node_publish_receipts", receipt._id, { copiedPath: path });
	}
	await ctx.db.patch("files_move_cohort_nodes", record._id, { status: "reserved" });
	await ctx.db.patch("files_move_cohorts", cohort._id, { planningCursor: null });
	return Result({ _yay: { done: false } });
}

async function db_authorize_record(
	ctx: MutationCtx,
	cohort: Doc<"files_move_cohorts">,
	membership: Doc<"organizations_workspaces_users">,
	record: Doc<"files_move_cohort_nodes">,
) {
	if (record.role === "anchor") return Result({ _yay: null });
	if (record.role === "derived") {
		const after = (await ctx.db.get("files_saved_places", record.afterPlaceId!))!;
		const parent =
			after.parentId === "root"
				? null
				: await files_saved_placement_db_get_node(ctx.db, after.parentId, { cohortId: cohort._id, view: "after" });
		return await db_authorize_node(ctx, cohort, membership, parent);
	}
	let sourceId = record.nodeId;
	if (record.role === "descendant" && record.itemId) {
		const item = (await ctx.db.get("files_move_cohort_items", record.itemId))!;
		const root = (await ctx.db.get("files_move_cohort_nodes", item.nodeRecordId))!;
		sourceId = root.nodeId;
	}
	const node = await files_saved_placement_db_get_node(ctx.db, sourceId, { cohortId: cohort._id, view: "before" });
	if (record.role === "allocated") {
		const item = record.itemId ? await ctx.db.get("files_move_cohort_items", record.itemId) : null;
		const privateNode =
			item?.target.kind === "private" ? await ctx.db.get("files_pending_nodes", item.target.id) : null;
		if (
			!privateNode ||
			privateNode.userId !== cohort.userId ||
			privateNode.state !== "active" ||
			privateNode.creationGeneration !== item?.privateVersion?.creationGeneration ||
			privateNode.structuralRevision !== item.privateVersion.structuralRevision
		)
			return Result({ _nay: { name: "needs_review", message: "This draft changed. Review it again." } });
		const after = await files_saved_placement_db_get_node(ctx.db, record.nodeId, {
			cohortId: cohort._id,
			view: "after",
		});
		const parent =
			after?.parentId && after.parentId !== "root"
				? await files_saved_placement_db_get_node(ctx.db, after.parentId, { cohortId: cohort._id, view: "after" })
				: null;
		return await db_authorize_node(ctx, cohort, membership, parent, privateNode);
	}
	if (!node) return Result({ _nay: { name: "needs_review", message: "A moved file is no longer available." } });
	return await db_authorize_node(ctx, cohort, membership, node);
}

async function db_sides(
	ctx: MutationCtx,
	cohort: Doc<"files_move_cohorts">,
	membership: Doc<"organizations_workspaces_users">,
) {
	const cursor = cohort.stagingCursor
		? (JSON.parse(cohort.stagingCursor) as { order: number; part: number; page: string | null })
		: { order: -1, part: 0, page: null };
	const record = await ctx.db
		.query("files_move_cohort_nodes")
		.withIndex("by_cohort_order", (q) => q.eq("cohortId", cohort._id).gt("order", cursor.order))
		.first();
	if (!record) return Result({ _yay: { done: true } });
	const access = await db_authorize_record(ctx, cohort, membership, record);
	if (access._nay) return access;
	const after = await files_saved_placement_db_get_node(ctx.db, record.nodeId, { cohortId: cohort._id, view: "after" });
	if (!after) throw should_never_happen("Move side work has no candidate", { recordId: record._id });
	const item = record.itemId ? await ctx.db.get("files_move_cohort_items", record.itemId) : null;
	const ownsContent = item?.nodeRecordId === record._id && item.contentId !== null;
	const beforeTag = { cohortId: cohort._id, view: "before" as const };
	const afterTag = { cohortId: cohort._id, view: "after" as const };
	if (cursor.part === 0 || cursor.part === 1) {
		if (!ownsContent && record.beforePlaceId) {
			if (cursor.part === 0) {
				const page = await ctx.db
					.query("files_metadata_docs")
					.withIndex("by_organization_workspace_source_fileNode_fieldPath", (q) =>
						q
							.eq("organizationId", cohort.organizationId)
							.eq("workspaceId", cohort.workspaceId)
							.eq("sourceKind", "committed")
							.eq("fileNodeId", record.nodeId)
							.eq("moveView.cohortId", undefined)
							.eq("moveView.view", undefined),
					)
					.paginate({ cursor: null, numItems: 8, maximumBytesRead: 1024 * 1024 });
				for (const row of page.page) {
					const { _id, _creationTime: _time, ...fields } = row;
					await ctx.db.patch("files_metadata_docs", _id, { moveView: beforeTag });
					await ctx.db.insert("files_metadata_docs", {
						...fields,
						moveView: afterTag,
						path: after.path,
						treePath: after.treePath,
						archiveOperationId: after.archiveOperationId ?? undefined,
						...(row.docKind === "field"
							? {
									parentId: after.parentId,
									nodeKind: after.kind,
									isRestrictedScopeRoot: after.isRestrictedScopeRoot,
									name: after.name,
									sortName: after.sortName,
								}
							: {}),
					});
				}
				// Tagged docs leave this range. A long field key makes its native cursor too large to store.
				cursor.page = null;
				if (page.isDone) cursor.part++;
			} else {
				const page = await ctx.db
					.query("files_plain_text_chunks")
					.withIndex("by_organization_workspace_source_fileNode_yjsSequence_chunkIndex", (q) =>
						q
							.eq("organizationId", cohort.organizationId)
							.eq("workspaceId", cohort.workspaceId)
							.eq("sourceKind", "committed")
							.eq("fileNodeId", record.nodeId)
							.eq("moveView.cohortId", undefined)
							.eq("moveView.view", undefined),
					)
					.paginate({ cursor: cursor.page, numItems: 8 });
				for (const row of page.page) {
					const { _id, _creationTime: _time, ...fields } = row;
					await ctx.db.patch("files_plain_text_chunks", _id, { moveView: beforeTag });
					await ctx.db.insert("files_plain_text_chunks", {
						...fields,
						moveView: afterTag,
						path: after.path,
						archiveOperationId: after.archiveOperationId ?? undefined,
					});
				}
				cursor.page = page.isDone ? null : page.continueCursor;
				if (page.isDone) cursor.part++;
			}
		} else cursor.part++;
	} else if (cursor.part === 2) {
		await files_updated_by_db_sync_node(ctx, { nodeId: record.nodeId });
		await files_share_rows_db_sync_node(ctx.db, {
			...cohort,
			nodeId: record.nodeId,
			node: (await ctx.db.get("files_nodes", record.nodeId))!,
		});
		cursor.part++;
	} else {
		const before = record.beforePlaceId ? await ctx.db.get("files_saved_places", record.beforePlaceId) : null;
		let reparented = before?.parentId !== after.parentId;
		if (record.role === "descendant" && item) {
			const root = (await ctx.db.get("files_move_cohort_nodes", item.nodeRecordId))!;
			const rootBefore = root.beforePlaceId ? await ctx.db.get("files_saved_places", root.beforePlaceId) : null;
			const rootAfter = root.afterPlaceId ? await ctx.db.get("files_saved_places", root.afterPlaceId) : null;
			reparented ||= rootBefore?.parentId !== rootAfter?.parentId;
		}
		if (
			before &&
			(reparented || before.restrictedScopeNodeId !== after.restrictedScopeNodeId || after.archiveOperationId !== null)
		) {
			const link = await ctx.db
				.query("files_share_links")
				.withIndex("by_organization_workspace_node", (q) =>
					q
						.eq("organizationId", cohort.organizationId)
						.eq("workspaceId", cohort.workspaceId)
						.eq("nodeId", record.nodeId),
				)
				.unique();
			if (link) await ctx.db.patch("files_share_links", link._id, { moveView: beforeTag });
		}
		await ctx.db.patch("files_move_cohort_nodes", record._id, { status: "staged" });
		cursor.order = record.order;
		cursor.part = 0;
		cursor.page = null;
	}
	await ctx.db.patch("files_move_cohorts", cohort._id, { stagingCursor: JSON.stringify(cursor) });
	return Result({ _yay: { done: false } });
}

async function db_cleanup_sides(ctx: MutationCtx, cohort: Doc<"files_move_cohorts">) {
	const chosen = cohort.publishedAt === null ? "before" : "after";
	// Each old/new family has a native cohort range. Removing the first page makes restart exact.
	for (const table of [
		"files_metadata_docs",
		"files_text_chunks",
		"files_plain_text_chunks",
		"files_yjs_updates",
		"files_updated_by_docs",
		"files_share_rows",
		"files_share_links",
	] as const) {
		for (const view of ["before", "after"] as const) {
			const first = await ctx.db
				.query(table)
				.withIndex("by_move_view", (q) => q.eq("moveView.cohortId", cohort._id).eq("moveView.view", view))
				.first();
			if (!first) continue;
			// Select the family first. A mutation may paginate only one range.
			const page = await ctx.db
				.query(table)
				.withIndex("by_move_view", (q) => q.eq("moveView.cohortId", cohort._id).eq("moveView.view", view))
				.paginate({ cursor: null, numItems: table === "files_yjs_updates" ? 1 : 8, maximumBytesRead: 1024 * 1024 });
			for (const row of page.page) {
				if (view === chosen) await ctx.db.patch(table, row._id, { moveView: undefined });
				else await ctx.db.delete(table, row._id);
			}
			return false;
		}
	}
	return true;
}

async function db_record_unselected_proposal(
	ctx: MutationCtx,
	cohort: Doc<"files_move_cohorts">,
	pendingUpdateId: Id<"files_pending_updates">,
) {
	if (cohort.origin.kind !== "review") return;
	const run = (await ctx.db.get("files_pending_update_runs", cohort.origin.runId))!;
	await ctx.db.patch("files_pending_update_runs", run._id, {
		needsReviewIds: [...new Set([...run.needsReviewIds, pendingUpdateId])].slice(0, 20),
	});
}

async function db_validate(
	ctx: MutationCtx,
	cohort: Doc<"files_move_cohorts">,
	membership: Doc<"organizations_workspaces_users">,
) {
	const item = await ctx.db
		.query("files_move_cohort_items")
		.withIndex("by_cohort_status_order", (q) => q.eq("cohortId", cohort._id).eq("status", "staged"))
		.first();
	if (item) {
		if (item.pendingUpdateId) {
			const proposal = await ctx.db.get("files_pending_updates", item.pendingUpdateId);
			if (!proposal || proposal.revision !== item.reviewedRevision || proposal.moveCohortId !== cohort._id)
				return Result({ _nay: { name: "needs_review", message: "A reviewed change was revised. Review it again." } });
		}
		const record = (await ctx.db.get("files_move_cohort_nodes", item.nodeRecordId))!;
		const access = await db_authorize_record(ctx, cohort, membership, record);
		if (access._nay) return access;
		if (item.contentId) {
			const content = await ctx.db.get("files_move_cohort_content", item.contentId);
			if (!content?.sealed || content.proofEpoch !== cohort.proofEpoch)
				return Result({ _nay: { name: "needs_review", message: "A saved content candidate is not ready." } });
			const media = await files_move_media_db_validate_next(ctx, {
				cohortId: cohort._id,
				contentId: content._id,
				proofEpoch: cohort.proofEpoch,
				cursor: cohort.validationCursor,
			});
			if (media._nay) return media;
			if (!media._yay.done) {
				await ctx.db.patch("files_move_cohorts", cohort._id, { validationCursor: media._yay.cursor });
				return Result({ _yay: { done: false } });
			}
		}
		await ctx.db.patch("files_move_cohort_items", item._id, { status: "validated", validatedEpoch: cohort.proofEpoch });
		await ctx.db.patch("files_move_cohorts", cohort._id, {
			validatedItemCount: cohort.validatedItemCount + 1,
			validationCursor: null,
		});
		return Result({ _yay: { done: false } });
	}
	const record = await ctx.db
		.query("files_move_cohort_nodes")
		.withIndex("by_cohort_status_order", (q) => q.eq("cohortId", cohort._id).eq("status", "staged"))
		.first();
	if (record) {
		const access = await db_authorize_record(ctx, cohort, membership, record);
		if (access._nay) return access;
		if (record.beforePlaceId && record.role !== "anchor") {
			const before = await files_saved_placement_db_get_node(ctx.db, record.nodeId, {
				cohortId: cohort._id,
				view: "before",
			});
			if (
				!before ||
				!files_transfer_source_versions_equal(
					await files_nodes_db_get_content_version(ctx, before),
					record.sourceContentVersion,
				)
			)
				return Result({ _nay: { name: "needs_review", message: "A moved file changed. Review it again." } });
		}
		await ctx.db.patch("files_move_cohort_nodes", record._id, {
			status: "validated",
			validatedEpoch: cohort.proofEpoch,
		});
		return Result({ _yay: { done: false } });
	}
	const owner = await ctx.db
		.query("files_move_owner_work")
		.withIndex("by_cohort_status_order", (q) => q.eq("cohortId", cohort._id).eq("status", "staged"))
		.first();
	if (owner) {
		const proposal = owner.pendingUpdateId ? await ctx.db.get("files_pending_updates", owner.pendingUpdateId) : null;
		if (owner.pendingUpdateId && (!proposal || proposal.revision !== owner.reviewedRevision))
			return Result({ _nay: { name: "needs_review", message: "An affected draft changed. Review this Move again." } });
		if (owner.target.kind === "private") {
			const node = await ctx.db.get("files_pending_nodes", owner.target.id);
			if (
				!node ||
				node.state !== "active" ||
				node.creationGeneration !== owner.privateVersion?.creationGeneration ||
				node.structuralRevision !== owner.privateVersion?.structuralRevision
			)
				return Result({ _nay: { name: "needs_review", message: "An affected draft moved. Review this Move again." } });
			if (owner.userId === cohort.userId && owner.pendingUpdateId) {
				const selected = await ctx.db
					.query("files_move_cohort_items")
					.withIndex("by_cohort_proposal", (q) =>
						q.eq("cohortId", cohort._id).eq("pendingUpdateId", owner.pendingUpdateId),
					)
					.unique();
				const receipt =
					node.parent.kind === "private"
						? await files_saved_placement_db_get_publish_receipt(
								ctx.db,
								{ ...cohort, privateNodeId: node.parent.id },
								{ cohortId: cohort._id, view: "after" },
							)
						: null;
				const parentId = node.parent.kind === "saved" ? node.parent.id : receipt?.savedNodeId;
				const parent = parentId
					? await files_saved_placement_db_get_node(ctx.db, parentId, { cohortId: cohort._id, view: "after" })
					: null;
				if (!selected && parent?.archiveOperationId === cohort._id) {
					await db_record_unselected_proposal(ctx, cohort, owner.pendingUpdateId);
					return Result({
						_nay: { name: "needs_review", message: "This folder has other pending changes. Review them first." },
					});
				}
			}
		}
		if (owner.userId === cohort.userId && owner.pendingUpdateId && owner.nodeRecordId) {
			const nodeRecord = (await ctx.db.get("files_move_cohort_nodes", owner.nodeRecordId))!;
			const after = nodeRecord.afterPlaceId ? await ctx.db.get("files_saved_places", nodeRecord.afterPlaceId) : null;
			const selected = await ctx.db
				.query("files_move_cohort_items")
				.withIndex("by_cohort_proposal", (q) =>
					q.eq("cohortId", cohort._id).eq("pendingUpdateId", owner.pendingUpdateId),
				)
				.unique();
			if (after?.archiveOperationId === cohort._id && !selected && nodeRecord.role !== "replacement") {
				await db_record_unselected_proposal(ctx, cohort, owner.pendingUpdateId);
				return Result({
					_nay: { name: "needs_review", message: "This folder has other pending changes. Review them first." },
				});
			}
		}
		await ctx.db.patch("files_move_owner_work", owner._id, { status: "validated", validatedEpoch: cohort.proofEpoch });
		return Result({ _yay: { done: false } });
	}
	return Result({ _yay: { done: true } });
}

async function db_publish(ctx: MutationCtx, cohort: Doc<"files_move_cohorts">, organization: Doc<"organizations">) {
	if (cohort.validatedItemCount !== cohort.itemCount || cohort.pendingWorkCount !== 0)
		throw should_never_happen("Move has unfinished work at publication", { cohortId: cohort._id });
	if (billing_pick_billed_user_id({ userId: cohort.userId, organization }) !== cohort.billedUserId)
		return Result({ _nay: { name: "needs_review", message: "Billing changed. Review these changes again." } });
	if (cohort.contentCostCents > 0) {
		const credits = await billing_db_check_credits(ctx, {
			userId: cohort.billedUserId,
			minimumRequiredCents: cohort.contentCostCents,
		});
		if (!credits.hasCredits) return Result({ _nay: { name: "insufficient_funds", message: "Insufficient funds" } });
	}
	const payer = await ctx.db.get("users", cohort.billedUserId);
	if (!payer) return Result({ _nay: { name: "permission_denied", message: "This payer is no longer available." } });
	const accounting = await files_move_content_db_publish_accounting(ctx, {
		cohortId: cohort._id,
		fence: cohort.fence,
		attemptFence: cohort.attemptFence,
	});
	if (accounting._nay) return accounting;
	if (!payer.clerkUserId && cohort.contentCostCents > 0)
		await billing_db_debit_anonymous_snapshot(ctx, { userId: payer._id, amount: cohort.contentCostCents });
	await ctx.db.patch("files_move_cohorts", cohort._id, {
		phase: "published",
		visibleView: "after",
		publishedAt: Date.now(),
		billingApplied: true,
	});
	const slot = await ctx.db
		.query("files_move_workspace_slots")
		.withIndex("by_workspace", (q) =>
			q.eq("organizationId", cohort.organizationId).eq("workspaceId", cohort.workspaceId),
		)
		.unique();
	if (slot?.cohortId !== cohort._id || slot.generation !== cohort.slotGeneration)
		throw should_never_happen("Move lost its workspace slot", { cohortId: cohort._id });
	await ctx.db.patch("files_move_workspace_slots", slot._id, { searchGeneration: slot.searchGeneration + 1 });
	await files_media_validation_db_advance_version(ctx, cohort);
	if (cohort.origin.kind === "review")
		await files_pending_update_runs_db_record_cohort_publication(ctx, { cohortId: cohort._id });
	else await files_transfer_db_record_cohort_publication(ctx, { cohortId: cohort._id });
	return Result({ _yay: { done: true } });
}

async function db_cleanup_nodes(ctx: MutationCtx, cohort: Doc<"files_move_cohorts">) {
	const record = await ctx.db
		.query("files_move_cohort_nodes")
		.withIndex("by_cohort_order", (q) =>
			cohort.cleanupCursor === null
				? q.eq("cohortId", cohort._id)
				: q.eq("cohortId", cohort._id).gt("order", Number(cohort.cleanupCursor)),
		)
		.first();
	if (!record) return true;
	const finish = cohort.publishedAt !== null;
	const placeId = finish ? record.afterPlaceId : record.beforePlaceId;
	const place = placeId ? await ctx.db.get("files_saved_places", placeId) : null;
	if (place)
		await ctx.db.patch("files_nodes", record.nodeId, {
			...placement_header_from_place(place),
			moveCohortId: undefined,
		});
	else await ctx.db.delete("files_nodes", record.nodeId);
	// A share change while the node was held wrote tagged rows only. Rebuild the rows from the final node.
	await files_share_rows_db_sync_node(ctx.db, {
		...cohort,
		nodeId: record.nodeId,
		node: await ctx.db.get("files_nodes", record.nodeId),
	});
	const item = record.itemId ? await ctx.db.get("files_move_cohort_items", record.itemId) : null;
	if (item && item.nodeRecordId === record._id) {
		if (item.pendingUpdateId) {
			const proposal = await ctx.db.get("files_pending_updates", item.pendingUpdateId);
			if (proposal) {
				if (!finish) await ctx.db.patch("files_pending_updates", proposal._id, { moveCohortId: undefined });
				else if (item.afterProposal) {
					await files_db_advance_pending_review_version(ctx, proposal);
					await ctx.db.replace("files_pending_updates", proposal._id, item.afterProposal);
					if (cohort.origin.kind === "review" && item.target.kind === "private") {
						const runId = cohort.origin.runId;
						const hold = await ctx.db
							.query("files_pending_holds")
							.withIndex("by_producer_pendingUpdate_role", (q) =>
								q
									.eq("producer.kind", "files_pending_update_run")
									.eq("producer.id", runId)
									.eq("pendingUpdateId", proposal._id)
									.eq("role", "review"),
							)
							.unique();
						// Keep the remainder held after its private draft becomes a saved file.
						if (hold)
							await ctx.db.patch("files_pending_holds", hold._id, {
								target: item.afterProposal.target,
								privateGeneration: null,
							});
					}
				} else {
					// An accepted delete skips the content step. Drop the text it ignored, with its untagged index docs.
					if (proposal.pendingArchive && proposal.content) {
						await files_db_retire_pending_update_yjs_states(ctx, {
							organizationId: proposal.organizationId,
							workspaceId: proposal.workspaceId,
							pendingUpdateId: proposal._id,
						});
						await files_pending_update_db_delete_chunks(ctx, { pendingUpdateId: proposal._id });
					}
					await files_db_delete_pending_update({ ctx, pendingUpdateId: proposal._id });
				}
			}
		}
		if (item.target.kind === "private") {
			const privateNode = await ctx.db.get("files_pending_nodes", item.target.id);
			const receipt = await ctx.db
				.query("files_pending_node_publish_receipts")
				.withIndex("by_privateNode", (q) =>
					q
						.eq("privateNodeId", item.target.kind === "private" ? item.target.id : ("" as Id<"files_pending_nodes">))
						.eq("moveView.cohortId", cohort._id)
						.eq("moveView.view", "after"),
				)
				.unique();
			if (finish) {
				if (!privateNode || !receipt)
					throw should_never_happen("Published draft lost its receipt", { itemId: item._id });
				await ctx.db.patch("files_pending_nodes", privateNode._id, {
					state: "published",
					creationGeneration: privateNode.creationGeneration + 1,
					closedAt: cohort.operationTime,
				});
				await ctx.db.patch("files_pending_node_publish_receipts", receipt._id, { moveView: undefined });
			} else if (receipt) await ctx.db.delete("files_pending_node_publish_receipts", receipt._id);
		}
		await ctx.db.patch("files_move_cohort_items", item._id, { status: "materialized" });
	}
	for (const id of [record.beforePlaceId, record.afterPlaceId]) if (id) await ctx.db.delete("files_saved_places", id);
	await ctx.db.patch("files_move_cohort_nodes", record._id, { status: "materialized" });
	await ctx.db.patch("files_move_cohorts", cohort._id, {
		cleanupCursor: String(record.order),
		materializedNodeCount: cohort.materializedNodeCount + 1,
	});
	const slot = await ctx.db
		.query("files_move_workspace_slots")
		.withIndex("by_workspace", (q) =>
			q.eq("organizationId", cohort.organizationId).eq("workspaceId", cohort.workspaceId),
		)
		.unique();
	if (slot?.cohortId === cohort._id)
		await ctx.db.patch("files_move_workspace_slots", slot._id, { searchGeneration: slot.searchGeneration + 1 });
	return false;
}

async function db_release(ctx: MutationCtx, cohort: Doc<"files_move_cohorts">) {
	const released = await files_move_content_db_release_claims(ctx, {
		cohortId: cohort._id,
		fence: cohort.fence,
		attemptFence: cohort.attemptFence,
	});
	if (released._nay) throw should_never_happen("Move could not release content claims", released._nay);
	if (!released._yay.done) return false;
	for (const table of ["files_move_source_reservations", "files_move_slot_claims"] as const) {
		const rows = await ctx.db
			.query(table)
			.withIndex("by_cohort", (q) => q.eq("cohortId", cohort._id))
			.take(8);
		if (!rows.length) continue;
		for (const row of rows) {
			if (table === "files_move_source_reservations" && "source" in row && row.source.kind === "proposal") {
				const proposal = await ctx.db.get("files_pending_updates", row.source.id);
				if (proposal?.moveCohortId === cohort._id)
					await ctx.db.patch("files_pending_updates", proposal._id, { moveCohortId: undefined });
			}
			await ctx.db.delete(table, row._id);
		}
		return false;
	}
	const slot = await ctx.db
		.query("files_move_workspace_slots")
		.withIndex("by_workspace", (q) =>
			q.eq("organizationId", cohort.organizationId).eq("workspaceId", cohort.workspaceId),
		)
		.unique();
	if (slot?.cohortId === cohort._id)
		await ctx.db.patch("files_move_workspace_slots", slot._id, {
			cohortId: null,
			searchGeneration: slot.searchGeneration + 1,
		});
	await ctx.db.patch("files_move_cohorts", cohort._id, { phase: "complete", workPhase: "complete", workId: null });
	await ctx.scheduler.runAfter(0, internal.files_move_cohorts.wake_waiters, { cohortId: cohort._id });
	await ctx.scheduler.runAfter(0, internal.files_move_cohorts.wake_owner_jobs, { cohortId: cohort._id });
	if (cohort.origin.kind === "review")
		await ctx.scheduler.runAfter(0, internal.files_pending_update_runs.settle_cohort, { cohortId: cohort._id });
	else await ctx.scheduler.runAfter(0, internal.files_transfer.settle_cohort, { cohortId: cohort._id });
	return true;
}

async function db_save_step(
	ctx: MutationCtx,
	cohort: Doc<"files_move_cohorts">,
	patch: Partial<WithoutSystemFields<Doc<"files_move_cohorts">>> = {},
	delayMs = 0,
) {
	const now = Date.now();
	await ctx.db.patch("files_move_cohorts", cohort._id, {
		step: cohort.step + 1,
		deadlineAt: now + RUN_TIMEOUT_MS,
		...patch,
	});
	// Repair after publication or an abort can take many steps too. Keep the Activity alive while it runs,
	// but do not revive one that already passed its deadline, and never move an agent's fixed deadline.
	const activity = await activities_db_require_by_source_id(ctx, cohort.origin.runId);
	const transfer =
		cohort.origin.kind === "transfer" ? await ctx.db.get("files_transfer_runs", cohort.origin.runId) : null;
	if (activities_is_active(activity.status) && activity.deadlineAt > now && !transfer?.fixedDeadline)
		await ctx.db.patch("activities", activity._id, { updatedAt: now, deadlineAt: now + RUN_TIMEOUT_MS });
	if (cohort.publishedAt === null && cohort.phase !== "aborting") {
		if (cohort.origin.kind === "review") {
			const unit = await ctx.db.get("files_pending_update_run_units", cohort.origin.unitId);
			if (unit?.cohortId === cohort._id && unit.status === "preparing")
				await ctx.db.patch("files_pending_update_run_units", unit._id, { attemptDeadlineAt: now + RUN_TIMEOUT_MS });
		}
	}
	await files_move_cohorts_db_schedule(ctx, { cohortId: cohort._id, delayMs });
}

async function db_abort(
	ctx: MutationCtx,
	cohort: Doc<"files_move_cohorts">,
	error: { name?: string; message: string },
) {
	if (cohort.publishedAt !== null) throw should_never_happen("A published Move cannot abort", { cohortId: cohort._id });
	await db_save_step(ctx, cohort, {
		phase: "aborting",
		workPhase: "abort_content",
		cleanupCursor: null,
		errorCode: error.name ?? "needs_review",
		errorMessage: error.message,
	});
}

async function db_parent_running(ctx: MutationCtx, cohort: Doc<"files_move_cohorts">) {
	const activity = await activities_db_require_by_source_id(ctx, cohort.origin.runId);
	if (!activities_is_active(activity.status) || activity.deadlineAt <= Date.now()) return false;
	if (cohort.origin.kind === "review") {
		const run = await ctx.db.get("files_pending_update_runs", cohort.origin.runId);
		const unit = await ctx.db.get("files_pending_update_run_units", cohort.origin.unitId);
		return (
			run?.step === "running" &&
			run.fence === cohort.fence &&
			run.planEpoch === cohort.origin.planEpoch &&
			unit?.status === "preparing" &&
			unit.attemptFence === cohort.attemptFence &&
			unit.cohortId === cohort._id
		);
	}
	const run = await ctx.db.get("files_transfer_runs", cohort.origin.runId);
	const item = await ctx.db.get("files_transfer_items", cohort.origin.itemId);
	return run?.revision === cohort.fence && item?.state === "pending" && item.attempt === cohort.attemptFence;
}

/**
 * One step changes bounded docs. A stale scheduled delivery changes nothing.
 */
export const advance = internalMutation({
	args: { cohortId: v.id("files_move_cohorts"), step: v.number() },
	returns: v.union(
		v.null(),
		v.object({
			contentId: v.id("files_move_cohort_content"),
			fence: v.number(),
			attemptFence: v.number(),
			kind: v.union(v.literal("prepare"), v.literal("media")),
		}),
	),
	handler: async (ctx, args) => {
		const cohort = await ctx.db.get("files_move_cohorts", args.cohortId);
		if (!cohort || cohort.phase === "complete" || cohort.step !== args.step) return null;
		const call = { cohortId: cohort._id, fence: cohort.fence, attemptFence: cohort.attemptFence };
		const repairing = cohort.publishedAt !== null || cohort.phase === "aborting";
		let membership: Doc<"organizations_workspaces_users"> | null = null;
		let organization: Doc<"organizations"> | null = null;
		if (!repairing) {
			const authorized = await db_get_membership(ctx, cohort);
			if (authorized._nay || !(await db_parent_running(ctx, cohort))) {
				await db_abort(
					ctx,
					cohort,
					authorized._nay ?? { name: "stopped", message: "This Move stopped before it was saved." },
				);
				return null;
			}
			({ membership, organization } = authorized._yay);
			const pins = cohort.clockPins;
			if (
				!(await files_media_validation_db_versions_match(ctx, {
					versions: [pins.organization, pins.workspace],
					pendingVersions: pins.review ? [pins.review] : [],
				}))
			) {
				await db_abort(ctx, cohort, {
					name: "needs_review",
					message: "Files or access changed. Review this Move again.",
				});
				return null;
			}
		}
		const entered = repairing
			? await files_pending_overlay_db_set_cohort_materialization(ctx, {
					...call,
					mode: cohort.publishedAt === null ? "abort" : "finish",
				})
			: await files_pending_overlay_db_set_cohort_staging(ctx, call);
		if (entered._nay) return null;
		let result:
			| { _yay: { done: boolean }; _nay?: undefined }
			| { _nay: { name?: string; message: string }; _yay?: undefined } = Result({ _yay: { done: false } });
		let next: Doc<"files_move_cohorts">["workPhase"] | null = null;
		if (cohort.workPhase === "items") {
			result = await db_items(ctx, cohort, membership!);
			next = "rename_parents";
		} else if (cohort.workPhase === "rename_parents") {
			result = await db_rename_parents(ctx, cohort, membership!);
			next = "descendants";
		} else if (cohort.workPhase === "descendants") {
			result = await db_descendants(ctx, cohort, membership!);
			next = "headers";
		} else if (cohort.workPhase === "headers") {
			result = await db_headers(ctx, cohort, membership!);
			next = "owners_collect";
			if (result._yay?.done) {
				const subtree = await ctx.db
					.query("files_move_work_ranges")
					.withIndex("by_cohort_phase_status_order", (q) =>
						q.eq("cohortId", cohort._id).eq("phase", "collect").eq("status", "queued"),
					)
					.first();
				if (subtree) next = "descendants";
			}
		} else if (cohort.workPhase === "owners_collect") {
			const cursor = cohort.stagingCursor
				? (JSON.parse(cohort.stagingCursor) as { order: number; page: string | null })
				: { order: -1, page: null };
			const record = await ctx.db
				.query("files_move_cohort_nodes")
				.withIndex("by_cohort_order", (q) => q.eq("cohortId", cohort._id).gt("order", cursor.order))
				.first();
			if (!record) result = Result({ _yay: { done: true } });
			else {
				const access = await db_authorize_record(ctx, cohort, membership!, record);
				if (access._nay) {
					await db_abort(ctx, cohort, access._nay);
					return null;
				}
				const collected = await files_move_owner_work_db_collect_node(ctx, {
					...call,
					nodeRecordId: record._id,
					cursor: cursor.page,
				});
				if (collected._nay) {
					await db_abort(ctx, cohort, collected._nay);
					return null;
				}
				await ctx.db.patch("files_move_cohorts", cohort._id, {
					stagingCursor: JSON.stringify({
						order: collected._yay.done ? record.order : cursor.order,
						page: collected._yay.done ? null : collected._yay.cursor,
					}),
				});
			}
			next = "owners_closure";
		} else if (cohort.workPhase === "owners_closure") {
			result = await files_move_owner_work_db_collect_closure(ctx, call);
			next = "content";
		} else if (cohort.workPhase === "content") {
			const item = await ctx.db
				.query("files_move_cohort_items")
				.withIndex("by_cohort_status_order", (q) => q.eq("cohortId", cohort._id).eq("status", "planned"))
				.first();
			if (!item) result = Result({ _yay: { done: true } });
			else {
				const record = (await ctx.db.get("files_move_cohort_nodes", item.nodeRecordId))!;
				const access = await db_authorize_record(ctx, cohort, membership!, record);
				if (access._nay) {
					await db_abort(ctx, cohort, access._nay);
					return null;
				}
				const proposal = item.pendingUpdateId ? await ctx.db.get("files_pending_updates", item.pendingUpdateId) : null;
				if (
					proposal &&
					!proposal.pendingArchive &&
					(proposal.content || proposal.pendingReplacement || item.target.kind === "private")
				) {
					const created = await files_move_content_db_create(ctx, { ...call, itemId: item._id, nodeId: record.nodeId });
					if (created._nay) {
						await db_abort(ctx, cohort, created._nay);
						return null;
					}
					const content = (await ctx.db.get("files_move_cohort_content", created._yay))!;
					if (!content.prepared)
						return {
							contentId: content._id,
							fence: cohort.fence,
							attemptFence: cohort.attemptFence,
							kind: "prepare" as const,
						};
					if (!content.sealed) {
						const staged = await files_move_content_db_stage(ctx, { ...call, contentId: content._id });
						if (staged._nay) {
							await db_abort(ctx, cohort, staged._nay);
							return null;
						}
						await db_save_step(ctx, cohort);
						return null;
					}
				}
				await ctx.db.patch("files_move_cohort_items", item._id, { status: "staged" });
			}
			next = "media";
		} else if (cohort.workPhase === "media") {
			// Linked media may be later in the group. Stage every content candidate first.
			const content = await ctx.db
				.query("files_move_cohort_content")
				.withIndex("by_cohort_node", (q) =>
					cohort.stagingCursor === null
						? q.eq("cohortId", cohort._id)
						: q.eq("cohortId", cohort._id).gt("nodeId", cohort.stagingCursor as Id<"files_nodes">),
				)
				.first();
			if (!content) result = Result({ _yay: { done: true } });
			else {
				const item = (await ctx.db.get("files_move_cohort_items", content.itemId))!;
				const record = (await ctx.db.get("files_move_cohort_nodes", item.nodeRecordId))!;
				const access = await db_authorize_record(ctx, cohort, membership!, record);
				if (access._nay) {
					await db_abort(ctx, cohort, access._nay);
					return null;
				}
				const mediaSet = content.preparedMediaSet
					? await ctx.db.get("files_media_dependency_sets", content.preparedMediaSet.setId)
					: null;
				if (!mediaSet?.sealed)
					return {
						contentId: content._id,
						fence: cohort.fence,
						attemptFence: cohort.attemptFence,
						kind: "media" as const,
					};
				await ctx.db.patch("files_move_cohorts", cohort._id, { stagingCursor: content.nodeId });
			}
			next = "sides";
		} else if (cohort.workPhase === "sides") {
			result = await db_sides(ctx, cohort, membership!);
			next = "owners_stage";
		} else if (cohort.workPhase === "owners_stage") {
			result = await files_move_owner_work_db_stage(ctx, call);
			next = "validate";
		} else if (cohort.workPhase === "validate") {
			result = await db_validate(ctx, cohort, membership!);
			next = "publish";
		} else if (cohort.workPhase === "publish") {
			result = await db_publish(ctx, cohort, organization!);
			next = "finish_content";
		} else if (cohort.workPhase === "finish_content" || cohort.workPhase === "abort_content") {
			const content = await ctx.db
				.query("files_move_cohort_content")
				.withIndex("by_cohort_node", (q) =>
					cohort.cleanupCursor === null
						? q.eq("cohortId", cohort._id)
						: q.eq("cohortId", cohort._id).gt("nodeId", cohort.cleanupCursor as Id<"files_nodes">),
				)
				.first();
			if (!content) result = Result({ _yay: { done: true } });
			else {
				const cleaned = await (
					cohort.publishedAt === null ? files_move_content_db_abort : files_move_content_db_finish
				)(ctx, { ...call, contentId: content._id });
				if (cleaned._nay) throw should_never_happen("Move content cleanup failed", cleaned._nay);
				if (cleaned._yay.done) await ctx.db.patch("files_move_cohorts", cohort._id, { cleanupCursor: content.nodeId });
			}
			next = cohort.publishedAt === null ? "abort_owners" : "finish_owners";
		} else if (cohort.workPhase === "finish_owners" || cohort.workPhase === "abort_owners") {
			result = await (cohort.publishedAt === null ? files_move_owner_work_db_abort : files_move_owner_work_db_finish)(
				ctx,
				call,
			);
			next = cohort.publishedAt === null ? "abort_sides" : "finish_sides";
		} else if (cohort.workPhase === "finish_sides" || cohort.workPhase === "abort_sides") {
			result = Result({ _yay: { done: await db_cleanup_sides(ctx, cohort) } });
			next = cohort.publishedAt === null ? "abort_nodes" : "finish_nodes";
		} else if (cohort.workPhase === "finish_nodes" || cohort.workPhase === "abort_nodes") {
			result = Result({ _yay: { done: await db_cleanup_nodes(ctx, cohort) } });
			next = "release";
		} else if (cohort.workPhase === "release") {
			if (await db_release(ctx, cohort)) return null;
		} else throw should_never_happen("Unexpected Move step", { cohortId: cohort._id, workPhase: cohort.workPhase });
		if (result._nay) {
			await db_abort(ctx, cohort, result._nay);
			return null;
		}
		await db_save_step(
			ctx,
			cohort,
			result._yay.done && next
				? {
						workPhase: next,
						planningCursor: null,
						stagingCursor: null,
						validationCursor: null,
						cleanupCursor: null,
						...(next === "validate"
							? { phase: "validating" as const }
							: next === "publish"
								? { phase: "ready" as const }
								: {}),
					}
				: {},
		);
		return null;
	},
});

export const resume = internalMutation({
	args: {
		cohortId: v.id("files_move_cohorts"),
		step: v.number(),
		error: v.union(v.object({ name: v.optional(v.string()), message: v.string() }), v.null()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const cohort = await ctx.db.get("files_move_cohorts", args.cohortId);
		if (!cohort || cohort.phase === "complete" || cohort.step !== args.step) return null;
		// A duplicate run of this step took over the content preparation. That run moves the Move on.
		if (args.error?.name === "stopped") return null;
		if (args.error && cohort.publishedAt === null && cohort.phase !== "aborting")
			await db_abort(ctx, cohort, args.error);
		else await db_save_step(ctx, cohort, {}, args.error ? 30_000 : 0);
		return null;
	},
});

export const run = internalAction({
	args: { cohortId: v.id("files_move_cohorts"), step: v.number() },
	returns: v.null(),
	handler: async (ctx, args) => {
		try {
			const pending = await ctx.runMutation(internal.files_move_cohorts.advance, args);
			if (!pending) return null;
			const result = await (
				pending.kind === "prepare" ? files_move_content_action_prepare : files_move_media_action_prepare_refs
			)(ctx, {
				cohortId: args.cohortId,
				contentId: pending.contentId,
				fence: pending.fence,
				attemptFence: pending.attemptFence,
			});
			await ctx.runMutation(internal.files_move_cohorts.resume, {
				...args,
				error: result._nay ? { name: result._nay.name, message: result._nay.message } : null,
			});
		} catch (error) {
			console.error("Move step failed", { cohortId: args.cohortId, step: args.step, error });
			await ctx.runMutation(internal.files_move_cohorts.resume, {
				...args,
				error: { name: "move_step_failed", message: "This Move step failed. Review it again." },
			});
		}
		return null;
	},
});

export const recover = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const now = Date.now();
		for (const phase of ["planning", "staging", "validating", "ready", "published", "aborting", "finishing"] as const) {
			const rows = await ctx.db
				.query("files_move_cohorts")
				.withIndex("by_deadline", (q) => q.eq("phase", phase).lte("deadlineAt", now))
				.take(8);
			for (const cohort of rows) {
				if (cohort.publishedAt === null && cohort.phase !== "aborting")
					await db_abort(ctx, cohort, { name: "timeout", message: "This Move stopped before it was saved." });
				else await db_save_step(ctx, cohort);
			}
		}
		const completed = await ctx.db
			.query("files_move_cohorts")
			.withIndex("by_deadline", (q) => q.eq("phase", "complete").lte("deadlineAt", now))
			.take(8);
		for (const cohort of completed)
			await ctx.scheduler.runAfter(0, internal.files_move_cohorts.cleanup, { cohortId: cohort._id });
		return null;
	},
});

/**
 * Parent history can go first. Keep delayed storage receipts until their final release.
 */
export const cleanup = internalMutation({
	args: { cohortId: v.id("files_move_cohorts") },
	returns: v.null(),
	handler: async (ctx, args) => {
		const cohort = await ctx.db.get("files_move_cohorts", args.cohortId);
		if (!cohort || cohort.phase !== "complete") return null;
		const parent =
			cohort.origin.kind === "review"
				? await ctx.db.get("files_pending_update_runs", cohort.origin.runId)
				: await ctx.db.get("files_transfer_runs", cohort.origin.runId);
		if (parent) {
			await ctx.db.patch("files_move_cohorts", cohort._id, { deadlineAt: Date.now() + 24 * 60 * 60 * 1000 });
			return null;
		}
		const waiter = await ctx.db
			.query("files_move_waiters")
			.withIndex("by_cohort", (q) => q.eq("cohortId", cohort._id))
			.first();
		const ownerJob = await ctx.db
			.query("files_pending_overlay_jobs")
			.withIndex("by_blockedCohort", (q) => q.eq("blockedByCohortId", cohort._id))
			.first();
		if (waiter || ownerJob) {
			await ctx.scheduler.runAfter(0, internal.files_move_cohorts.wake_waiters, args);
			await ctx.scheduler.runAfter(0, internal.files_move_cohorts.wake_owner_jobs, args);
			await ctx.db.patch("files_move_cohorts", cohort._id, { deadlineAt: Date.now() + 5 * 60 * 1000 });
			return null;
		}
		const content = await ctx.db
			.query("files_move_cohort_content")
			.withIndex("by_cohort_node", (q) => q.eq("cohortId", cohort._id))
			.first();
		if (content) {
			if (content.storageResourceCount > 0) {
				await ctx.db.patch("files_move_cohorts", cohort._id, { deadlineAt: Date.now() + 5 * 60 * 1000 });
				return null;
			}
			await ctx.db.delete("files_move_cohort_content", content._id);
		} else {
			let removed = false;
			for (const table of [
				"files_move_cohort_items",
				"files_move_cohort_nodes",
				"files_move_owner_work",
				"files_move_work_ranges",
			] as const) {
				const rows = await ctx.db
					.query(table)
					.withIndex("by_cohort_order", (q) => q.eq("cohortId", cohort._id))
					.take(8);
				if (!rows.length) continue;
				for (const row of rows) await ctx.db.delete(table, row._id);
				removed = true;
				break;
			}
			if (!removed) {
				const keys = await ctx.db
					.query("files_move_owner_list_keys")
					.withIndex("by_cohort", (q) => q.eq("cohortId", cohort._id))
					.take(8);
				for (const key of keys) await ctx.db.delete("files_move_owner_list_keys", key._id);
				removed = keys.length > 0;
			}
			if (!removed) {
				const workspace = await ctx.db.get("organizations_workspaces", cohort.workspaceId);
				if (!workspace) {
					const slot = await ctx.db
						.query("files_move_workspace_slots")
						.withIndex("by_workspace", (q) =>
							q.eq("organizationId", cohort.organizationId).eq("workspaceId", cohort.workspaceId),
						)
						.unique();
					if (slot?.cohortId === null) await ctx.db.delete("files_move_workspace_slots", slot._id);
				}
				await ctx.db.delete("files_move_cohorts", cohort._id);
				return null;
			}
		}
		await ctx.scheduler.runAfter(0, internal.files_move_cohorts.cleanup, args);
		return null;
	},
});

async function db_can_wake(ctx: MutationCtx, cohortId: Id<"files_move_cohorts">) {
	const cohort = await ctx.db.get("files_move_cohorts", cohortId);
	if (!cohort || cohort.phase !== "complete") return false;
	const source = await ctx.db
		.query("files_move_source_reservations")
		.withIndex("by_cohort", (q) => q.eq("cohortId", cohortId))
		.first();
	const slot = await ctx.db
		.query("files_move_slot_claims")
		.withIndex("by_cohort", (q) => q.eq("cohortId", cohortId))
		.first();
	return !source && !slot;
}

/**
 * Accepted workers resume only after this group's physical writes and reservations are settled.
 */
export const wake_waiters = internalMutation({
	args: { cohortId: v.id("files_move_cohorts") },
	returns: v.null(),
	handler: async (ctx, args) => {
		if (!(await db_can_wake(ctx, args.cohortId))) return null;
		const page = await files_move_reservations_db_take_waiters(ctx, {
			cohortId: args.cohortId,
			numItems: WAKE_PAGE_SIZE,
		});
		for (const waiter of page.page) {
			const worker = waiter.worker;
			switch (worker.kind) {
				case "content":
					await files_nodes_db_resume_file_content_materialization(ctx, { jobId: worker.id, userId: worker.userId });
					break;
				case "content_cleanup":
					await ctx.scheduler.runAfter(0, internal.files_nodes_content.cleanup_file_materialization_covered_rows, {
						organizationId: worker.organizationId,
						workspaceId: worker.workspaceId,
						nodeId: worker.nodeId,
						expectedYjsLastSequenceId: worker.id,
						throughSequence: worker.throughSequence,
					});
					break;
				case "yjs_task":
					await ctx.scheduler.runAfter(0, internal.files_nodes_content.cleanup_file_yjs_task, { taskId: worker.id });
					break;
				case "yjs_covered":
					await ctx.scheduler.runAfter(0, internal.files_nodes_content.cleanup_file_yjs_covered_rows, {
						organizationId: worker.organizationId,
						workspaceId: worker.workspaceId,
						nodeId: worker.nodeId,
						supersededYjsAssetId: worker.id,
						throughSequence: worker.throughSequence,
						expectedActiveYjsLastSequenceId: worker.expectedActiveYjsLastSequenceId,
						putMayArriveUntil: worker.putMayArriveUntil,
					});
					break;
				case "subtree":
					await files_subtree_ops_db_recover(ctx, { opId: worker.id });
					break;
				case "write_policy": {
					// Only the Activity sweep moved this run's deadline while it waited. Move it before the run resumes.
					const activity = await activities_db_get_by_source_id(ctx, worker.id);
					if (activity && activities_is_active(activity.status)) {
						const now = Date.now();
						await ctx.db.patch("activities", activity._id, { updatedAt: now, deadlineAt: now + RUN_TIMEOUT_MS });
					}
					await ctx.scheduler.runAfter(0, internal.files_write_policy_runs.advance, { runId: worker.id });
					break;
				}
				case "review":
					await files_pending_update_runs_db_resume_parked(ctx, { runId: worker.id, fence: worker.fence });
					break;
				case "pending_hold_release":
					await ctx.scheduler.runAfter(0, internal.files_pending_holds.release_producer, { producer: worker.producer });
					break;
				case "upload":
					if (worker.resume.kind === "event") {
						const { kind: _kind, ...event } = worker.resume;
						await ctx.scheduler.runAfter(0, internal.r2.process_uploaded_asset_event, { assetId: worker.id, ...event });
					} else {
						const asset = await ctx.db.get("files_r2_assets", worker.id);
						if (asset)
							await ctx.scheduler.runAfter(0, internal.r2.finalize_uploaded_text_file, {
								organizationId: asset.organizationId,
								workspaceId: asset.workspaceId,
								assetId: asset._id,
								eventId: worker.resume.eventId,
							});
					}
					break;
			}
			// Scheduling and removal commit together. A lost reply cannot enqueue this waiter twice.
			await ctx.db.delete("files_move_waiters", waiter._id);
		}
		if (!page.isDone) await ctx.scheduler.runAfter(0, internal.files_move_cohorts.wake_waiters, args);
		return null;
	},
});

export const wake_owner_jobs = internalMutation({
	args: { cohortId: v.id("files_move_cohorts") },
	returns: v.null(),
	handler: async (ctx, args) => {
		if (!(await db_can_wake(ctx, args.cohortId))) return null;
		const page = await ctx.db
			.query("files_pending_overlay_jobs")
			.withIndex("by_blockedCohort", (q) => q.eq("blockedByCohortId", args.cohortId))
			.paginate({ cursor: null, numItems: WAKE_PAGE_SIZE });
		for (const job of page.page)
			await files_pending_overlay_db_wake_job(ctx, { cohortId: args.cohortId, jobId: job._id });
		if (!page.isDone) await ctx.scheduler.runAfter(0, internal.files_move_cohorts.wake_owner_jobs, args);
		return null;
	},
});
