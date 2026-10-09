import { Result } from "common/errors-as-values-utils.ts";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import {
	files_pending_overlay_db_create_reader,
	files_pending_overlay_db_stage_owner,
	files_pending_overlay_db_stage_owner_fields,
	files_pending_overlay_db_stage_owner_lists,
} from "../server/files-pending-overlay.ts";
import { files_saved_placement_db_get_node } from "../server/files-saved-placement.ts";
import { files_move_reservations_db_enter } from "../server/files-move-reservations.ts";
import { path_tree_prefix_upper_bound } from "../server/server-utils.ts";
import type { files_PendingParent, files_PendingTarget } from "../shared/files.ts";
import { should_never_happen } from "../shared/shared-utils.ts";

const PAGE_SIZE = 8;
type Args = { cohortId: Id<"files_move_cohorts">; fence: number; attemptFence: number };
type Range = Doc<"files_move_work_ranges">;
type Cohort = Doc<"files_move_cohorts">;

async function db_get_cohort(ctx: MutationCtx, args: Args, workPhase: Cohort["workPhase"]) {
	const cohort = await ctx.db.get("files_move_cohorts", args.cohortId);
	if (
		!cohort ||
		cohort.fence !== args.fence ||
		cohort.attemptFence !== args.attemptFence ||
		cohort.workPhase !== workPhase ||
		(workPhase.startsWith("owners_") && cohort.phase !== "staging") ||
		(workPhase === "finish_owners" && cohort.phase !== "published" && cohort.phase !== "finishing") ||
		(workPhase === "abort_owners" && (cohort.phase !== "aborting" || cohort.visibleView !== "before"))
	)
		return Result({ _nay: { name: "stopped", message: "This Move owner step is no longer current." } });
	return Result({ _yay: cohort });
}

async function db_add_range(
	ctx: MutationCtx,
	cohortId: Id<"files_move_cohorts">,
	args: Pick<Range, "key" | "kind" | "range" | "phase"> & Partial<Pick<Range, "nodeRecordId" | "ownerWorkId">>,
) {
	const old = await ctx.db
		.query("files_move_work_ranges")
		.withIndex("by_cohort_key", (q) => q.eq("cohortId", cohortId).eq("key", args.key))
		.unique();
	if (old) return old;
	const cohort = await ctx.db.get("files_move_cohorts", cohortId);
	if (!cohort) throw should_never_happen("Owner work has no cohort", { cohortId });
	const last = await ctx.db
		.query("files_move_work_ranges")
		.withIndex("by_cohort_order", (q) => q.eq("cohortId", cohortId))
		.order("desc")
		.first();
	const fields = {
		cohortId,
		...args,
		nodeRecordId: args.nodeRecordId ?? null,
		ownerWorkId: args.ownerWorkId ?? null,
		order: (last?.order ?? -1) + 1,
		status: "queued" as const,
		cursor: null,
		generation: 1,
		attemptFence: cohort.attemptFence,
		workId: null,
		nextAttemptAt: Date.now(),
		processedCount: 0,
	};
	const id = await ctx.db.insert("files_move_work_ranges", fields);
	await ctx.db.patch("files_move_cohorts", cohortId, { pendingWorkCount: cohort.pendingWorkCount + 1 });
	return (await ctx.db.get("files_move_work_ranges", id))!;
}

async function db_complete_range(ctx: MutationCtx, range: Range) {
	const cohort = await ctx.db.get("files_move_cohorts", range.cohortId);
	if (!cohort || cohort.pendingWorkCount <= 0)
		throw should_never_happen("Owner work count is missing", { rangeId: range._id });
	await ctx.db.patch("files_move_work_ranges", range._id, { status: "complete" });
	await ctx.db.patch("files_move_cohorts", cohort._id, { pendingWorkCount: cohort.pendingWorkCount - 1 });
}

async function db_next_range(ctx: MutationCtx, cohortId: Id<"files_move_cohorts">, phase: Range["phase"]) {
	for (const status of ["running", "queued"] as const) {
		const range = await ctx.db
			.query("files_move_work_ranges")
			.withIndex("by_cohort_phase_status_order", (q) =>
				q.eq("cohortId", cohortId).eq("phase", phase).eq("status", status),
			)
			.first();
		if (range) return range;
	}
	return null;
}

async function db_reserve(
	ctx: MutationCtx,
	cohort: Cohort,
	source: Doc<"files_move_source_reservations">["source"],
	mode: Doc<"files_move_source_reservations">["mode"],
	userId: Id<"users"> | null,
) {
	const old = await ctx.db
		.query("files_move_source_reservations")
		.withIndex("by_source", (q) => q.eq("source.kind", source.kind).eq("source.id", source.id))
		.unique();
	if (old && old.cohortId !== cohort._id)
		return Result({ _nay: { name: "move_busy", message: "A pending input is being moved." } });
	if (!old)
		await ctx.db.insert("files_move_source_reservations", {
			cohortId: cohort._id,
			source,
			mode,
			userId,
			generation: 1,
		});
	else if (mode === "subtree" && old.mode === "placement")
		await ctx.db.patch("files_move_source_reservations", old._id, { mode });
	return Result({ _yay: null });
}

async function db_add_owner(ctx: MutationCtx, cohort: Cohort, userId: Id<"users">, target: files_PendingTarget) {
	const old = await ctx.db
		.query("files_move_owner_work")
		.withIndex("by_cohort_owner_target", (q) =>
			q.eq("cohortId", cohort._id).eq("userId", userId).eq("target.kind", target.kind).eq("target.id", target.id),
		)
		.unique();
	if (old) return Result({ _yay: old._id });
	const proposal = await ctx.db
		.query("files_pending_updates")
		.withIndex("by_user_target", (q) =>
			q.eq("userId", userId).eq("target.kind", target.kind).eq("target.id", target.id),
		)
		.unique();
	const node =
		target.kind === "saved"
			? await ctx.db.get("files_nodes", target.id)
			: await ctx.db.get("files_pending_nodes", target.id);
	if (
		!node ||
		node.organizationId !== cohort.organizationId ||
		node.workspaceId !== cohort.workspaceId ||
		(proposal && (proposal.organizationId !== cohort.organizationId || proposal.workspaceId !== cohort.workspaceId))
	)
		return Result({ _nay: { name: "move_changed", message: "A pending input is no longer available." } });
	const privateNode = target.kind === "private" ? (node as Doc<"files_pending_nodes">) : null;
	if (privateNode && privateNode.userId !== userId)
		return Result({ _nay: { name: "move_changed", message: "A private input changed owner." } });
	const reserved = await db_reserve(
		ctx,
		cohort,
		target,
		node.kind === "folder" ? "subtree" : "placement",
		target.kind === "private" ? userId : null,
	);
	if (reserved._nay) return reserved;
	if (proposal) {
		const held = await db_reserve(ctx, cohort, { kind: "proposal", id: proposal._id }, "proposal", userId);
		if (held._nay) return held;
	}
	const record =
		target.kind === "saved"
			? await ctx.db
					.query("files_move_cohort_nodes")
					.withIndex("by_cohort_node", (q) => q.eq("cohortId", cohort._id).eq("nodeId", target.id))
					.unique()
			: null;
	const last = await ctx.db
		.query("files_move_owner_work")
		.withIndex("by_cohort_order", (q) => q.eq("cohortId", cohort._id))
		.order("desc")
		.first();
	const id = await ctx.db.insert("files_move_owner_work", {
		cohortId: cohort._id,
		userId,
		target,
		order: (last?.order ?? -1) + 1,
		pendingUpdateId: proposal?._id ?? null,
		reviewedRevision: proposal?.revision ?? null,
		privateVersion: privateNode
			? { creationGeneration: privateNode.creationGeneration, structuralRevision: privateNode.structuralRevision }
			: null,
		nodeRecordId: record?._id ?? null,
		beforeHideId: null,
		afterHideId: null,
		beforePlaceId: null,
		afterPlaceId: null,
		status: "queued",
		dependencyCursor: null,
		fieldCursor: null,
		generation: 1,
		validatedEpoch: null,
	});
	await db_add_range(ctx, cohort._id, {
		key: `owner-stage:${id}`,
		kind: "places",
		range: { kind: "owner", userId, target },
		phase: "stage",
		ownerWorkId: id,
	});
	return Result({ _yay: id });
}

async function db_add_parent(
	ctx: MutationCtx,
	cohortId: Id<"files_move_cohorts">,
	userId: Id<"users">,
	parent: Exclude<files_PendingParent, { kind: "root" }>,
) {
	await db_add_range(ctx, cohortId, {
		key: `owner-parent:${userId}:${parent.kind}:${parent.id}`,
		kind: "pending_children",
		range: { kind: "parent", userId, parent },
		phase: "collect",
	});
}

/**
 * Collection ends before staging changes any normal owner range. Root pins access and headers.
 */
export async function files_move_owner_work_db_collect_node(
	ctx: MutationCtx,
	args: Args & { nodeRecordId: Id<"files_move_cohort_nodes">; cursor: string | null },
) {
	const checked = await db_get_cohort(ctx, args, "owners_collect");
	if (checked._nay) return checked;
	const cohort = checked._yay;
	const record = await ctx.db.get("files_move_cohort_nodes", args.nodeRecordId);
	if (record?.cohortId !== cohort._id)
		return Result({ _nay: { name: "stopped", message: "This saved input changed." } });
	// Remaining anchors keep their placement. Changed sources still discover affected owners.
	if (record.role === "anchor") return Result({ _yay: { cursor: null, done: true } });
	const range = await db_add_range(ctx, cohort._id, {
		key: `source-owners:${record._id}`,
		kind: "source_owners",
		range: { kind: "node", nodeId: record.nodeId },
		phase: "collect",
		nodeRecordId: record._id,
	});
	if (range.status === "complete") return Result({ _yay: { cursor: range.cursor, done: true } });
	if (range.cursor !== args.cursor)
		return Result({ _nay: { name: "stopped", message: "This owner page already changed." } });
	const cursor = args.cursor
		? (JSON.parse(args.cursor) as { phase: number; page: string | null })
		: { phase: 0, page: null };
	const before = record.beforePlaceId ? await ctx.db.get("files_saved_places", record.beforePlaceId) : null;
	const after = record.afterPlaceId ? await ctx.db.get("files_saved_places", record.afterPlaceId) : null;
	let isDone = true;
	let continueCursor: string | null = null;
	if (cursor.phase === 0) {
		const page = await ctx.db
			.query("files_pending_updates")
			.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", record.nodeId))
			.paginate({ cursor: cursor.page, numItems: PAGE_SIZE });
		for (const row of page.page) {
			const added = await db_add_owner(ctx, cohort, row.userId, row.target);
			if (added._nay) return added;
		}
		({ isDone, continueCursor } = page);
	} else if (cursor.phase === 1) {
		const page = await ctx.db
			.query("files_pending_hides")
			.withIndex("by_savedNode_user", (q) => q.eq("savedNodeId", record.nodeId))
			.paginate({ cursor: cursor.page, numItems: PAGE_SIZE });
		for (const row of page.page) {
			const added = await db_add_owner(ctx, cohort, row.userId, { kind: "saved", id: record.nodeId });
			if (added._nay) return added;
		}
		({ isDone, continueCursor } = page);
	} else if (cursor.phase === 2) {
		const page = await ctx.db
			.query("files_pending_places")
			.withIndex("by_target_user", (q) => q.eq("target.kind", "saved").eq("target.id", record.nodeId))
			.paginate({ cursor: cursor.page, numItems: PAGE_SIZE });
		for (const row of page.page) {
			const added = await db_add_owner(ctx, cohort, row.userId, row.target);
			if (added._nay) return added;
		}
		({ isDone, continueCursor } = page);
	} else if (cursor.phase === 3 || cursor.phase === 4) {
		const place = cursor.phase === 3 ? before : after;
		if (place) {
			const page = await ctx.db
				.query("files_pending_places")
				.withIndex("by_org_ws_parent_name", (q) =>
					q
						.eq("organizationId", cohort.organizationId)
						.eq("workspaceId", cohort.workspaceId)
						.eq("moveView.cohortId", undefined)
						.eq("moveView.view", undefined)
						.eq("parent.kind", place.parentId === "root" ? "root" : "saved")
						.eq("parent.id", place.parentId === "root" ? undefined : place.parentId)
						.eq("name", place.name),
				)
				.paginate({ cursor: cursor.page, numItems: PAGE_SIZE });
			for (const row of page.page) {
				const claimant = await db_add_owner(ctx, cohort, row.userId, row.target);
				if (claimant._nay) return claimant;
				const hidden = await db_add_owner(ctx, cohort, row.userId, { kind: "saved", id: record.nodeId });
				if (hidden._nay) return hidden;
			}
			({ isDone, continueCursor } = page);
		}
	} else if (cursor.phase === 5 && (before ?? after)?.kind === "folder") {
		const page = await ctx.db
			.query("files_pending_nodes")
			.withIndex("by_org_ws_parent_state_name", (q) =>
				q
					.eq("organizationId", cohort.organizationId)
					.eq("workspaceId", cohort.workspaceId)
					.eq("parent.kind", "saved")
					.eq("parent.id", record.nodeId)
					.eq("state", "active"),
			)
			.paginate({ cursor: cursor.page, numItems: PAGE_SIZE });
		for (const row of page.page) {
			const added = await db_add_owner(ctx, cohort, row.userId, { kind: "private", id: row._id });
			if (added._nay) return added;
		}
		({ isDone, continueCursor } = page);
	} else if (cursor.phase === 6 && (before ?? after)?.kind === "folder") {
		const page = await ctx.db
			.query("files_pending_updates")
			.withIndex("by_pendingMove_destParent", (q) =>
				q.eq("pendingMove.destParent.kind", "saved").eq("pendingMove.destParent.id", record.nodeId),
			)
			.paginate({ cursor: cursor.page, numItems: PAGE_SIZE });
		for (const row of page.page) {
			const added = await db_add_owner(ctx, cohort, row.userId, row.target);
			if (added._nay) return added;
		}
		({ isDone, continueCursor } = page);
	} else if (cursor.phase === 7 || cursor.phase === 8) {
		const page = await ctx.db
			.query("files_pending_node_publish_receipts")
			.withIndex("by_savedNode", (q) =>
				q
					.eq("savedNodeId", record.nodeId)
					.eq("moveView.cohortId", cursor.phase === 7 ? undefined : cohort._id)
					.eq("moveView.view", cursor.phase === 7 ? undefined : "after"),
			)
			.paginate({ cursor: cursor.page, numItems: PAGE_SIZE });
		for (const row of page.page) {
			const held = await db_reserve(ctx, cohort, { kind: "receipt", id: row._id }, "receipt", row.userId);
			if (held._nay) return held;
			const heldParent = await db_reserve(
				ctx,
				cohort,
				{ kind: "private", id: row.privateNodeId },
				"subtree",
				row.userId,
			);
			if (heldParent._nay) return heldParent;
			await db_add_parent(ctx, cohort._id, row.userId, { kind: "private", id: row.privateNodeId });
		}
		({ isDone, continueCursor } = page);
	}
	cursor.page = isDone ? null : continueCursor;
	if (isDone) cursor.phase++;
	const next = JSON.stringify(cursor);
	await ctx.db.patch("files_move_work_ranges", range._id, { cursor: next, status: "running" });
	if (cursor.phase === 9) await db_complete_range(ctx, range);
	return Result({ _yay: { cursor: next, done: cursor.phase === 9 } });
}

export async function files_move_owner_work_db_collect_closure(ctx: MutationCtx, args: Args) {
	const checked = await db_get_cohort(ctx, args, "owners_closure");
	if (checked._nay) return checked;
	const cohort = checked._yay;
	const work = await ctx.db
		.query("files_move_owner_work")
		.withIndex("by_cohort_status_order", (q) => q.eq("cohortId", cohort._id).eq("status", "queued"))
		.first();
	if (work) {
		const node =
			work.target.kind === "saved"
				? await files_saved_placement_db_get_node(ctx.db, work.target.id, { cohortId: cohort._id, view: "before" })
				: await ctx.db.get("files_pending_nodes", work.target.id);
		if (node?.kind === "folder") {
			await db_add_parent(ctx, cohort._id, work.userId, work.target);
			const place = await ctx.db
				.query("files_pending_places")
				.withIndex("by_target_user", (q) =>
					q
						.eq("target.kind", work.target.kind)
						.eq("target.id", work.target.id)
						.eq("userId", work.userId)
						.eq("moveView.cohortId", undefined)
						.eq("moveView.view", undefined),
				)
				.unique();
			const reader = files_pending_overlay_db_create_reader(ctx.db, {
				organizationId: cohort.organizationId,
				workspaceId: cohort.workspaceId,
				userId: work.userId,
				fixedView: { cohortId: cohort._id, view: "before" },
			});
			const own = await reader.resolve(work.target);
			for (const prefix of new Set([
				place?.ownerTreePath,
				place?.childTreePath,
				own?.entry.path && `${own.entry.path.replace(/\/$/, "")}/`,
			])) {
				if (!prefix?.endsWith("/")) continue;
				await db_add_range(ctx, cohort._id, {
					key: `owner-prefix:${work.userId}:${prefix}`,
					kind: "owner_prefix",
					range: { kind: "prefix", userId: work.userId, prefix },
					phase: "collect",
				});
			}
		}
		await ctx.db.patch("files_move_owner_work", work._id, { status: "planned" });
		return Result({ _yay: { done: false } });
	}
	const range = await db_next_range(ctx, cohort._id, "collect");
	if (!range) return Result({ _yay: { done: true } });
	const cursor = range.cursor
		? (JSON.parse(range.cursor) as { phase: number; page: string | null })
		: { phase: 0, page: null };
	let isDone: boolean;
	let continueCursor: string | null;
	if (range.range.kind === "parent") {
		const { parent, userId } = range.range;
		if (cursor.phase === 0) {
			const page = await ctx.db
				.query("files_pending_nodes")
				.withIndex("by_organization_workspace_user_parent_state_name", (q) =>
					q
						.eq("organizationId", cohort.organizationId)
						.eq("workspaceId", cohort.workspaceId)
						.eq("userId", userId)
						.eq("parent.kind", parent.kind)
						.eq("parent.id", parent.kind === "root" ? undefined : parent.id)
						.eq("state", "active"),
				)
				.paginate({ cursor: cursor.page, numItems: PAGE_SIZE });
			for (const row of page.page) {
				const added = await db_add_owner(ctx, cohort, row.userId, { kind: "private", id: row._id });
				if (added._nay) return added;
			}
			({ isDone, continueCursor } = page);
		} else {
			const page = await ctx.db
				.query("files_pending_updates")
				.withIndex("by_org_ws_user_pendingMove_destParent_destName", (q) =>
					q
						.eq("organizationId", cohort.organizationId)
						.eq("workspaceId", cohort.workspaceId)
						.eq("userId", userId)
						.eq("pendingMove.destParent.kind", parent.kind)
						.eq("pendingMove.destParent.id", parent.kind === "root" ? undefined : parent.id),
				)
				.paginate({ cursor: cursor.page, numItems: PAGE_SIZE });
			for (const row of page.page) {
				const added = await db_add_owner(ctx, cohort, row.userId, row.target);
				if (added._nay) return added;
			}
			({ isDone, continueCursor } = page);
		}
		cursor.page = isDone ? null : continueCursor;
		if (isDone) cursor.phase++;
		if (cursor.phase === 2) await db_complete_range(ctx, range);
	} else if (range.range.kind === "prefix") {
		const { userId, prefix } = range.range;
		const page = await ctx.db
			.query("files_pending_places")
			.withIndex("by_org_ws_user_ownerTreePath", (q) =>
				q
					.eq("organizationId", cohort.organizationId)
					.eq("workspaceId", cohort.workspaceId)
					.eq("userId", userId)
					.eq("moveView.cohortId", undefined)
					.eq("moveView.view", undefined)
					.gt("ownerTreePath", prefix)
					.lt("ownerTreePath", path_tree_prefix_upper_bound(prefix)),
			)
			.paginate({ cursor: cursor.page, numItems: PAGE_SIZE });
		for (const row of page.page) {
			const added = await db_add_owner(ctx, cohort, row.userId, row.target);
			if (added._nay) return added;
		}
		cursor.page = page.continueCursor;
		if (page.isDone) await db_complete_range(ctx, range);
	} else throw should_never_happen("Unexpected owner closure range", { rangeId: range._id });
	await ctx.db.patch("files_move_work_ranges", range._id, { cursor: JSON.stringify(cursor) });
	return Result({ _yay: { done: false } });
}

async function db_stage_pending_scope(
	ctx: MutationCtx,
	cohort: Cohort,
	args: Args & {
		ownerWorkId: Id<"files_move_owner_work">;
		phase: "pending_plain" | "pending_metadata";
		cursor: string | null;
	},
) {
	const work = await ctx.db.get("files_move_owner_work", args.ownerWorkId);
	if (work?.cohortId !== cohort._id)
		return Result({ _nay: { name: "stopped", message: "This pending scope changed." } });
	if (!work.pendingUpdateId) return Result({ _yay: { cursor: null, done: true } });
	const proposal = await ctx.db.get("files_pending_updates", work.pendingUpdateId);
	if (
		!proposal ||
		proposal.organizationId !== cohort.organizationId ||
		proposal.workspaceId !== cohort.workspaceId ||
		proposal.userId !== work.userId ||
		proposal.revision !== work.reviewedRevision ||
		proposal.target.kind !== work.target.kind ||
		proposal.target.id !== work.target.id
	)
		return Result({ _nay: { name: "move_changed", message: "Pending changes were revised." } });
	const item = await ctx.db
		.query("files_move_cohort_items")
		.withIndex("by_cohort_proposal", (q) => q.eq("cohortId", cohort._id).eq("pendingUpdateId", proposal._id))
		.unique();
	// The selected content producer already seals these families, including a partial remainder.
	if (item?.contentId) return Result({ _yay: { cursor: null, done: true } });
	const after = { cohortId: cohort._id, view: "after" as const };
	const saved =
		work.target.kind === "saved" ? await files_saved_placement_db_get_node(ctx.db, work.target.id, after) : null;
	const resolved =
		work.target.kind === "private"
			? await files_pending_overlay_db_create_reader(ctx.db, {
					organizationId: cohort.organizationId,
					workspaceId: cohort.workspaceId,
					userId: work.userId,
					fixedView: after,
				}).resolve(work.target)
			: null;
	// Hidden targets keep captured scope; owner readers still decide visibility.
	const path = saved?.path ?? resolved?.entry.path;
	const archiveOperationId = saved?.archiveOperationId ?? undefined;
	const entered = await files_move_reservations_db_enter(ctx, { ...args, mode: "stage" });
	if (entered._nay) return entered;
	const before = { cohortId: cohort._id, view: "before" as const };
	const page =
		args.phase === "pending_plain"
			? await ctx.db
					.query("files_plain_text_chunks")
					.withIndex("by_pendingUpdate_chunkIndex", (q) =>
						q.eq("pendingUpdateId", proposal._id).eq("moveView.cohortId", undefined).eq("moveView.view", undefined),
					)
					.paginate({ cursor: args.cursor, numItems: PAGE_SIZE })
			: await ctx.db
					.query("files_metadata_docs")
					.withIndex("by_pendingUpdate_fieldPath", (q) =>
						q.eq("pendingUpdateId", proposal._id).eq("moveView.cohortId", undefined).eq("moveView.view", undefined),
					)
					.paginate({ cursor: null, numItems: PAGE_SIZE, maximumBytesRead: 1024 * 1024 });
	for (const row of page.page) {
		if (row.sourceKind !== "pending" || row.userId !== work.userId || row.proposalRevision !== proposal.revision)
			return Result({ _nay: { name: "move_changed", message: "Pending content changed." } });
		if ("fieldPath" in row) {
			const { _id: _id, _creationTime: _time, ...fields } = row;
			await ctx.db.patch("files_metadata_docs", row._id, { moveView: before });
			if (!item || item.afterProposal)
				await ctx.db.insert("files_metadata_docs", {
					...fields,
					moveView: after,
					path: path ?? row.path,
					treePath: saved?.treePath ?? path ?? row.treePath,
					archiveOperationId,
				});
		} else {
			const { _id: _id, _creationTime: _time, ...fields } = row;
			await ctx.db.patch("files_plain_text_chunks", row._id, { moveView: before });
			if (!item || item.afterProposal)
				await ctx.db.insert("files_plain_text_chunks", {
					...fields,
					moveView: after,
					path: path ?? row.path,
					archiveOperationId,
				});
		}
	}
	// Tagged metadata leaves this range. Its cursor can contain a field key too large to store.
	return Result({
		_yay: { cursor: page.isDone || args.phase === "pending_metadata" ? null : page.continueCursor, done: page.isDone },
	});
}

/**
 * Root seals selected content first. Owner scope is sealed here before fields and publication.
 */
export async function files_move_owner_work_db_stage(ctx: MutationCtx, args: Args) {
	const checked = await db_get_cohort(ctx, args, "owners_stage");
	if (checked._nay) return checked;
	const range = await db_next_range(ctx, args.cohortId, "stage");
	if (!range) return Result({ _yay: { done: true } });
	if (!range.ownerWorkId) throw should_never_happen("Owner stage range has no owner", { rangeId: range._id });
	const cursor = range.cursor
		? (JSON.parse(range.cursor) as {
				phase: "headers" | "pending_plain" | "pending_metadata" | "lists" | "fields";
				page: string | null;
			})
		: { phase: "headers" as const, page: null };
	if (cursor.phase === "headers") {
		const staged = await files_pending_overlay_db_stage_owner(ctx, { ...args, ownerWorkId: range.ownerWorkId });
		if (staged._nay) return staged;
		cursor.phase = "pending_plain";
	} else if (cursor.phase === "pending_plain" || cursor.phase === "pending_metadata") {
		const staged = await db_stage_pending_scope(ctx, checked._yay, {
			...args,
			ownerWorkId: range.ownerWorkId,
			phase: cursor.phase,
			cursor: cursor.page,
		});
		if (staged._nay) return staged;
		cursor.page = staged._yay.cursor;
		if (staged._yay.done) cursor.phase = cursor.phase === "pending_plain" ? "pending_metadata" : "lists";
	} else {
		const pageArgs = { ...args, ownerWorkId: range.ownerWorkId, cursor: cursor.page };
		const staged =
			cursor.phase === "lists"
				? await files_pending_overlay_db_stage_owner_lists(ctx, pageArgs)
				: await files_pending_overlay_db_stage_owner_fields(ctx, pageArgs);
		if (staged._nay) return staged;
		cursor.page = staged._yay.cursor;
		if (staged._yay.done) {
			if (cursor.phase === "fields") await db_complete_range(ctx, range);
			else {
				cursor.phase = "fields";
				cursor.page = null;
			}
		}
	}
	await ctx.db.patch("files_move_work_ranges", range._id, { cursor: JSON.stringify(cursor) });
	return Result({ _yay: { done: false } });
}

async function db_cleanup(ctx: MutationCtx, args: Args, mode: "finish" | "abort") {
	const checked = await db_get_cohort(ctx, args, mode === "finish" ? "finish_owners" : "abort_owners");
	if (checked._nay) return checked;
	const cohort = checked._yay;
	const range = await db_add_range(ctx, cohort._id, {
		key: `owner-${mode}`,
		kind: "finish",
		range: { kind: "cohort" },
		phase: mode,
	});
	if (range.status === "complete") return Result({ _yay: { done: true } });
	const cursor = range.cursor
		? (JSON.parse(range.cursor) as { phase: number; view: "before" | "after"; page: string | null })
		: { phase: 0, view: "before" as const, page: null };
	const keep = mode === "finish" ? "after" : "before";
	if (cursor.phase < 5) {
		// Remove old field joins before removing their places. Promotion keeps native IDs and time.
		const table = (
			[
				"files_pending_place_fields",
				"files_pending_list_rows",
				"files_pending_hides",
				"files_pending_places",
				"files_pending_review_facts",
			] as const
		)[cursor.phase]!;
		if (table === "files_pending_review_facts") {
			const page = await ctx.db
				.query(table)
				.withIndex("by_cohort_view", (q) => q.eq("cohortId", cohort._id).eq("view", cursor.view))
				.paginate({ cursor: null, numItems: PAGE_SIZE });
			for (const row of page.page) {
				if (cursor.view === keep) await ctx.db.patch(table, row._id, { cohortId: null, view: "normal" });
				else await ctx.db.delete(table, row._id);
			}
			if (!page.isDone) return Result({ _yay: { done: false } });
		} else {
			const page = await ctx.db
				.query(table)
				.withIndex("by_move_view", (q) => q.eq("moveView.cohortId", cohort._id).eq("moveView.view", cursor.view))
				.paginate({ cursor: null, numItems: PAGE_SIZE, maximumBytesRead: 1024 * 1024 });
			for (const row of page.page) {
				if (cursor.view === keep) await ctx.db.patch(table, row._id, { moveView: undefined });
				else await ctx.db.delete(table, row._id);
			}
			if (table === "files_pending_places" && page.page.length) {
				const slot = await ctx.db
					.query("files_move_workspace_slots")
					.withIndex("by_workspace", (q) =>
						q.eq("organizationId", cohort.organizationId).eq("workspaceId", cohort.workspaceId),
					)
					.unique();
				if (slot?.cohortId !== cohort._id) throw should_never_happen("Owner cleanup lost its workspace slot", args);
				await ctx.db.patch("files_move_workspace_slots", slot._id, { searchGeneration: slot.searchGeneration + 1 });
			}
			if (!page.isDone) return Result({ _yay: { done: false } });
		}
		if (cursor.view === "before") cursor.view = "after";
		else {
			cursor.phase++;
			cursor.view = "before";
		}
	} else if (cursor.phase === 5) {
		const page = await ctx.db
			.query("files_move_owner_list_keys")
			.withIndex("by_cohort", (q) => q.eq("cohortId", cohort._id))
			.paginate({ cursor: null, numItems: PAGE_SIZE });
		for (const claim of page.page) {
			const chosen = mode === "finish" ? claim.afterKeyId : claim.beforeKeyId;
			const removed = mode === "finish" ? claim.beforeKeyId : claim.afterKeyId;
			if (removed) await ctx.db.delete("files_pending_list_keys", removed);
			if (chosen) await ctx.db.patch("files_pending_list_keys", chosen, { moveView: undefined });
			// A later unrelated draft write can now refresh this normal key.
			await ctx.db.delete("files_move_owner_list_keys", claim._id);
		}
		if (page.isDone) cursor.phase++;
	} else if (cursor.phase === 6) {
		const pending =
			mode === "abort"
				? ((await db_next_range(ctx, cohort._id, "collect")) ?? (await db_next_range(ctx, cohort._id, "stage")))
				: null;
		if (pending) await db_complete_range(ctx, pending);
		else cursor.phase++;
	} else {
		const page = await ctx.db
			.query("files_move_owner_work")
			.withIndex("by_cohort_order", (q) => q.eq("cohortId", cohort._id))
			.paginate({ cursor: cursor.page, numItems: PAGE_SIZE });
		for (const work of page.page) await ctx.db.patch("files_move_owner_work", work._id, { status: "materialized" });
		cursor.page = page.continueCursor;
		if (page.isDone) await db_complete_range(ctx, range);
	}
	await ctx.db.patch("files_move_work_ranges", range._id, { cursor: JSON.stringify(cursor) });
	return Result({ _yay: { done: false } });
}

export async function files_move_owner_work_db_finish(ctx: MutationCtx, args: Args) {
	return await db_cleanup(ctx, args, "finish");
}

export async function files_move_owner_work_db_abort(ctx: MutationCtx, args: Args) {
	return await db_cleanup(ctx, args, "abort");
}
