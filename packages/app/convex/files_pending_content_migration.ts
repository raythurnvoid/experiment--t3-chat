// One-time bridge. Remove this module after the stored-data audit and strict push.
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import { files_YJS_DOC_KEYS } from "../shared/files.ts";
import { should_never_happen } from "../shared/shared-utils.ts";
import { Result } from "common/errors-as-values-utils.ts";
import { internal } from "./_generated/api.js";
import type { files_pending_updates_CohortContentContext } from "./files_pending_updates.ts";
import { activities_db_get_by_source_id, activities_is_active } from "./activities_db.ts";
import { files_move_reservations_db_add_migration_facts } from "../server/files-move-reservations.ts";
import { files_db_load_pending_update_yjs_state_bytes } from "../server/files.ts";
import { files_yjs_doc_create_from_array_buffer_update } from "../shared/files-yjs.ts";

type Header = Pick<
	Doc<"files_pending_updates">,
	"content" | "contentNeedsRebase" | "contentRebaseRootKind" | "createIntent"
>;
type Saved = Pick<Doc<"files_nodes">, "assetId" | "pendingContentVersion" | "textKind" | "collaborationEnabled">;

/**
 * Stored bytes or a retained snapshot prove an old root. Current metadata alone does not.
 */
export async function files_pending_content_migration_db_family(
	ctx: QueryCtx | MutationCtx,
	header: Header & Pick<Doc<"files_pending_updates">, "organizationId" | "workspaceId" | "userId" | "target">,
	node: Saved | null,
	baseVersion?: number,
	historicalRoot?: Saved["textKind"],
) {
	const content = header.content;
	if (!content) return undefined;
	let rootKind =
		content.rootKind ??
		header.contentRebaseRootKind ??
		(header.createIntent?.kind === "text" ? header.createIntent.textKind : undefined);
	if (!rootKind && content.base.kind === "asset" && header.target.kind === "saved") {
		const assetId = content.base.assetId;
		const snapshot = await ctx.db
			.query("files_snapshots")
			.withIndex("by_asset", (q) => q.eq("assetId", assetId))
			.first();
		if (
			snapshot?.fileNodeId === header.target.id &&
			snapshot.organizationId === header.organizationId &&
			snapshot.workspaceId === header.workspaceId
		)
			rootKind = snapshot.yjsRootKind ?? undefined;
	}
	if (!rootKind) {
		for (const stateId of [content.unstagedStateId, content.stagedStateId, content.baseStateId]) {
			const state = await ctx.db.get("files_pending_update_yjs_states", stateId);
			if (
				!state?.sealed ||
				state.organizationId !== header.organizationId ||
				state.workspaceId !== header.workspaceId ||
				state.userId !== header.userId
			)
				continue;
			const bytes = await files_db_load_pending_update_yjs_state_bytes(ctx, { stateDoc: state });
			if (bytes._nay) throw should_never_happen("Draft migration could not read its state", { stateId });
			const doc = files_yjs_doc_create_from_array_buffer_update(bytes._yay.buffer as ArrayBuffer);
			try {
				const plain = doc.share.has(files_YJS_DOC_KEYS.plainText);
				const rich = doc.share.has(files_YJS_DOC_KEYS.richText);
				if (plain && rich) throw should_never_happen("Draft migration found two roots", { stateId });
				if (plain || rich) {
					const found = plain ? "plain_text" : "rich_text";
					if (rootKind && rootKind !== found)
						throw should_never_happen("Draft migration found different branch roots", { stateId });
					rootKind = found;
				}
			} finally {
				doc.destroy();
			}
		}
	}
	// Finished review headers can outlive their branch docs. Their saved-version proof keeps the old shape.
	rootKind ??= historicalRoot ?? undefined;
	if (!rootKind) throw should_never_happen("Draft root needs a migration decision", { target: header.target });
	const provedAsset =
		content.base.kind === "asset" && content.base.assetId === node?.assetId && rootKind === node.textKind;
	return {
		...content,
		rootKind,
		base:
			content.base.kind === "new"
				? content.base
				: {
						...content.base,
						pendingContentVersion:
							content.base.pendingContentVersion ??
							baseVersion ??
							(header.contentNeedsRebase ? 0 : provedAsset ? 1 : 0),
					},
	};
}

/**
 * Missing pre-bridge versions mean the first version, never today's version.
 */
export function files_pending_content_migration_versions<T>(value: T, version = 1): T {
	if (Array.isArray(value)) return value.map((part) => files_pending_content_migration_versions(part, version)) as T;
	if (value === null || typeof value !== "object" || value instanceof ArrayBuffer) return value;
	const next: Record<string, unknown> = {};
	for (const [key, part] of Object.entries(value)) next[key] = files_pending_content_migration_versions(part, version);
	if (next.kind === "yjs" && "lastSequenceId" in next && next.pendingContentVersion === undefined)
		next.pendingContentVersion = version;
	if (
		(next.kind === "saved_yjs" || next.kind === "saved_asset" || next.kind === "replacement") &&
		"pendingUpdateId" in next &&
		next.expectedPendingContentVersion === undefined
	)
		next.expectedPendingContentVersion = version;
	return next as T;
}

/**
 * One family per step. The target hold keeps its old shape fixed between pages.
 */
export async function files_pending_content_migration_db_cohort_page(
	ctx: MutationCtx,
	cohort: Doc<"files_move_cohorts">,
) {
	const cursor = cohort.pendingContentMigration?.cursor
		? (JSON.parse(cohort.pendingContentMigration.cursor) as { order: number; page: string | null; part: number })
		: { order: -1, page: null, part: 0 };
	const record = await ctx.db
		.query("files_move_cohort_nodes")
		.withIndex("by_cohort_order", (q) => q.eq("cohortId", cohort._id).gt("order", cursor.order))
		.first();
	if (!record) {
		await ctx.db.patch("files_move_cohorts", cohort._id, {
			pendingContentVersionReady: true,
			pendingContentMigration: undefined,
		});
		return true;
	}
	const node = await ctx.db.get("files_nodes", record.nodeId);
	const before = record.beforePlaceId ? await ctx.db.get("files_saved_places", record.beforePlaceId) : null;
	const after = record.afterPlaceId ? await ctx.db.get("files_saved_places", record.afterPlaceId) : null;
	const content = await ctx.db
		.query("files_move_cohort_content")
		.withIndex("by_cohort_node", (q) => q.eq("cohortId", cohort._id).eq("nodeId", record.nodeId))
		.unique();
	const item = record.itemId ? await ctx.db.get("files_move_cohort_items", record.itemId) : null;
	const held = await ctx.db
		.query("files_move_source_reservations")
		.withIndex("by_source", (q) => q.eq("source.kind", "saved").eq("source.id", record.nodeId))
		.unique();
	const targetHeld = held?.cohortId === cohort._id;
	const sourceProof = record.sourceContentVersion ?? content?.beforeContentVersion;
	const beforeShape: Saved | null =
		before ??
		(sourceProof
			? {
					assetId: sourceProof.kind === "asset" ? sourceProof.assetId : null,
					textKind: sourceProof.textKind,
					collaborationEnabled: sourceProof.collaborationEnabled,
					pendingContentVersion: sourceProof.kind === "yjs" ? (sourceProof.pendingContentVersion ?? 1) : 1,
				}
			: null);
	const sourceVersion =
		before?.pendingContentVersion ?? (sourceProof?.kind === "yjs" ? sourceProof.pendingContentVersion : undefined) ?? 1;
	const replacement = content?.prepared?.kind === "replacement";
	// Published old candidates are already the first visible version. Repair must not invent a reset.
	const afterVersion =
		after?.pendingContentVersion ?? sourceVersion + (replacement && cohort.publishedAt === null ? 1 : 0);
	if (before?.pendingContentVersion === undefined && before)
		await ctx.db.patch("files_saved_places", before._id, { pendingContentVersion: sourceVersion });
	if (after?.pendingContentVersion === undefined && after)
		await ctx.db.patch("files_saved_places", after._id, { pendingContentVersion: afterVersion });
	if (targetHeld && node?.pendingContentVersion === undefined && node)
		await files_move_reservations_db_add_migration_facts(ctx, {
			cohortId: cohort._id,
			table: "files_nodes",
			id: node._id,
			patch: { pendingContentVersion: sourceVersion },
		});
	await ctx.db.patch("files_move_cohort_nodes", record._id, {
		sourceContentVersion: files_pending_content_migration_versions(record.sourceContentVersion, sourceVersion),
	});
	if (content) {
		await ctx.db.patch("files_move_cohort_content", content._id, {
			prepared: files_pending_content_migration_versions(content.prepared, sourceVersion),
			beforeContentVersion: files_pending_content_migration_versions(content.beforeContentVersion, sourceVersion),
			afterContentVersion: files_pending_content_migration_versions(content.afterContentVersion, afterVersion),
		});
		if (content.operationBatchId) {
			const batch = await ctx.db.get("files_pending_update_operation_batches", content.operationBatchId);
			if (batch && batch.expectedPendingContentVersion === undefined)
				await files_move_reservations_db_add_migration_facts(ctx, {
					cohortId: cohort._id,
					table: "files_pending_update_operation_batches",
					id: batch._id,
					patch: { expectedPendingContentVersion: batch.target.kind === "saved" ? sourceVersion : null },
				});
		}
	}
	let afterProposal = item?.afterProposal;
	if (cursor.part === 0 && item && afterProposal) {
		const afterShape =
			after ??
			(content?.afterContentVersion
				? {
						assetId:
							content.afterContentVersion.kind === "asset" ? content.afterContentVersion.assetId : content.afterAssetId,
						textKind: content.afterContentVersion.textKind,
						collaborationEnabled: content.afterContentVersion.collaborationEnabled,
						pendingContentVersion: afterVersion,
					}
				: null);
		afterProposal = {
			...files_pending_content_migration_versions(afterProposal),
			content: await files_pending_content_migration_db_family(
				ctx,
				afterProposal,
				afterShape,
				afterVersion,
				afterShape?.textKind,
			),
		};
		await ctx.db.patch("files_move_cohort_items", item._id, { afterProposal });
	}
	if (cursor.part === 1 && item?.origin.kind === "review") {
		const review = await ctx.db.get("files_pending_update_run_items", item.origin.itemId);
		if (review?.reviewHeader)
			await ctx.db.patch("files_pending_update_run_items", review._id, {
				reviewHeader: {
					...files_pending_content_migration_versions(review.reviewHeader),
					content: await files_pending_content_migration_db_family(
						ctx,
						review.reviewHeader,
						beforeShape,
						undefined,
						sourceProof?.textKind,
					),
				},
			});
	}
	if (cursor.part < 2) {
		await ctx.db.patch("files_move_cohorts", cohort._id, {
			pendingContentMigration: {
				updatedAt: Date.now(),
				cursor: JSON.stringify({ ...cursor, part: cursor.part + 1 }),
			},
		});
		return false;
	}
	// Released targets may already have new drafts or another shape. Only retained history is ours now.
	if (!targetHeld) {
		await ctx.db.patch("files_move_cohorts", cohort._id, {
			pendingContentMigration: {
				updatedAt: Date.now(),
				cursor: JSON.stringify({ order: record.order, page: null, part: 0 }),
			},
		});
		return false;
	}
	const page = await ctx.db
		.query("files_pending_updates")
		.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", record.nodeId))
		.paginate({ cursor: cursor.page, numItems: 1 });
	for (const row of page.page) {
		const adopted =
			row.content &&
			afterProposal?.content &&
			row.content.baseStateId === afterProposal.content.baseStateId &&
			row.content.stagedStateId === afterProposal.content.stagedStateId &&
			row.content.unstagedStateId === afterProposal.content.unstagedStateId;
		const source = adopted ? after : beforeShape;
		const family = await files_pending_content_migration_db_family(
			ctx,
			row,
			source,
			adopted ? afterVersion : undefined,
		);
		await files_move_reservations_db_add_migration_facts(ctx, {
			cohortId: cohort._id,
			table: "files_pending_updates",
			id: row._id,
			patch: {
				pendingMove: files_pending_content_migration_versions(row.pendingMove),
				pendingReplacement: files_pending_content_migration_versions(row.pendingReplacement),
				content: family,
			},
		});
		if (
			cohort.publishedAt === null &&
			cohort.phase !== "aborting" &&
			row._id === item?.pendingUpdateId &&
			family?.base.kind !== "new" &&
			family?.base.pendingContentVersion === 0 &&
			content?.prepared &&
			content.prepared.kind !== "private"
		)
			return "needs_review" as const;
	}
	await ctx.db.patch("files_move_cohorts", cohort._id, {
		pendingContentMigration: {
			updatedAt: Date.now(),
			cursor: JSON.stringify({
				order: page.isDone ? record.order : cursor.order,
				page: page.isDone ? null : page.continueCursor,
				part: page.isDone ? 0 : 2,
			}),
		},
	});
	return false;
}

/**
 * Migration time does not use a job's remaining time. Stop and access checks still run.
 */
export async function files_pending_content_migration_db_extend_deadline(
	ctx: MutationCtx,
	args: { _id: Id<"files_move_cohorts"> },
) {
	const cohort = await ctx.db.get("files_move_cohorts", args._id);
	if (!cohort?.pendingContentMigration || cohort.phase === "complete") return;
	const now = Date.now();
	const elapsed = Math.max(0, now - cohort.pendingContentMigration.updatedAt);
	if (!elapsed) return;
	await ctx.db.patch("files_move_cohorts", cohort._id, {
		deadlineAt: cohort.deadlineAt + elapsed,
		reviewDeadlineAt: cohort.reviewDeadlineAt + elapsed,
		pendingContentMigration: { ...cohort.pendingContentMigration, updatedAt: now },
	});
	const activity = await activities_db_get_by_source_id(ctx, cohort.origin.runId);
	if (activity && activities_is_active(activity.status))
		await ctx.db.patch("activities", activity._id, { deadlineAt: activity.deadlineAt + elapsed, updatedAt: now });
	if (cohort.origin.kind === "review") {
		const unit = await ctx.db.get("files_pending_update_run_units", cohort.origin.unitId);
		if (unit?.attemptDeadlineAt !== null && unit?.attemptDeadlineAt !== undefined)
			await ctx.db.patch("files_pending_update_run_units", unit._id, {
				attemptDeadlineAt: unit.attemptDeadlineAt + elapsed,
			});
	}
}

export async function files_pending_content_migration_db_extend_review_deadline(
	ctx: MutationCtx,
	runId: Id<"files_pending_update_runs">,
) {
	const unit = await ctx.db
		.query("files_pending_update_run_units")
		.withIndex("by_run_status_deleteLast_order", (q) => q.eq("runId", runId).eq("status", "preparing"))
		.first();
	if (unit?.cohortId) await files_pending_content_migration_db_extend_deadline(ctx, { _id: unit.cohortId });
}

/**
 * Only files with old rootless families wait for the bounded backfill.
 */
export async function files_pending_content_migration_db_require_ready(
	ctx: QueryCtx | MutationCtx,
	node: Pick<Doc<"files_nodes">, "_id">,
) {
	const old = await ctx.db
		.query("files_pending_updates")
		.withIndex("by_target_root_base", (q) =>
			q
				.eq("target.kind", "saved")
				.eq("target.id", node._id)
				.eq("content.rootKind", undefined)
				.gt("content.base.kind", undefined),
		)
		.first();
	if (old)
		return Result({
			_nay: { name: "migration_pending", message: "Files update is preparing these drafts. Try again." },
		});
	return Result({ _yay: null });
}

/**
 * Old actions may refuse. Their later callback must not fail the replacement job.
 */
export async function files_pending_content_migration_db_refuse_old_input(
	ctx: MutationCtx,
	cohortContent?: files_pending_updates_CohortContentContext,
) {
	if (cohortContent) {
		const content = await ctx.db.get("files_move_cohort_content", cohortContent.contentId);
		const cohort = await ctx.db.get("files_move_cohorts", cohortContent.cohortId);
		if (
			content &&
			cohort &&
			cohort.phase !== "complete" &&
			cohort.fence === cohortContent.fence &&
			cohort.attemptFence === cohortContent.attemptFence &&
			content.cohortId === cohort._id &&
			content.preparationFence === cohortContent.preparationFence
		) {
			await ctx.db.patch("files_move_cohort_content", content._id, { preparationFence: content.preparationFence + 1 });
			const generation = (cohort.runJob?.generation ?? 0) + 1;
			const id = await ctx.scheduler.runAfter(0, internal.files_move_run.run, {
				cohortId: cohort._id,
				step: cohort.step,
				runGeneration: generation,
				mode: "chain",
			});
			await ctx.db.patch("files_move_cohorts", cohort._id, {
				runJob: { id, step: cohort.step, generation },
				pendingContentMigration: cohort.pendingContentMigration ?? { cursor: null, updatedAt: Date.now() },
			});
		}
	}
	return Result({ _nay: { name: "stopped", message: "Files updated. Refresh the app, then try again." } });
}
