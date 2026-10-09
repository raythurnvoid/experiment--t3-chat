// Jobs of the pending overlay (`server/files-pending-overlay.ts`): the work a flush cannot do in
// the writer's transaction. Each job has one task doc per (kind, key) in
// `files_pending_overlay_jobs`. A job reads its cursor from the doc, recomputes a page of targets
// with the same code as the flush, and schedules its next run until it deletes its doc. A recover
// cron starts late docs again, so a job that throws is retried and logged, never lost.
//
// `check_user` and `repair_user` walk one user's proposals and derived docs, so orphan docs are
// found too. QA runs `check_user` after each phase, and `repair_user` fixes what it reports.
// `check_share_rows` does the same check for one workspace's share rows, and `check_ancestors`
// for the saved nodes' `ancestor1..12`.

import { compareValues, v } from "convex/values";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import { internalMutation } from "./functions.ts";
import { files_subtree_ops_db_is_near_limits } from "./files_subtree_ops.ts";
import {
	files_pending_overlay_db_child_ancestors,
	files_pending_overlay_db_compute_target,
	files_pending_overlay_db_create_reader,
	files_pending_overlay_db_delete_job,
	files_pending_overlay_db_flush,
	files_pending_overlay_db_mark_target,
	files_pending_overlay_db_set_own_job,
	files_pending_overlay_db_sync_list_key,
	files_pending_overlay_db_target_cohort,
} from "../server/files-pending-overlay.ts";
import {
	files_saved_placement_db_get_slot,
	files_saved_placement_db_get_view,
} from "../server/files-saved-placement.ts";
import {
	files_share_rows_db_compute_for_grant,
	files_share_rows_db_compute_all_for_grant,
} from "../server/files-share-rows.ts";
import { path_tree_prefix_upper_bound } from "../server/server-utils.ts";
import { files_ancestor_ids, type files_PendingTarget } from "../shared/files.ts";
import { should_never_happen } from "../shared/shared-utils.ts";

// Make Convex reuse the loaded module between calls, so warm calls skip the module load cost.
// Does NOT work for http actions (see http.ts). No mutable module-level state allowed here.
export const experimental_reuseContext = true;

/**
 * Docs per job page.
 */
const JOB_PAGE_SIZE = 100;

/**
 * Four full-size docs leave room for their second reads and the current saved node.
 */
const SCOPE_PAGE_SIZE = 4;

/**
 * A job stops before the next doc when fewer ranges are left. A recompute with a deep reader can
 * read about 1,500 ranges (256 levels and a few reads each).
 */
const JOB_MIN_RANGES_LEFT = 2048;

/**
 * A task still in the past after this long means its job failed. The recover cron starts it again.
 */
const RECOVERY_MS = 15 * 60 * 1000;

/**
 * How many late tasks one recover run starts again before it continues in a new transaction.
 */
const RECOVERY_BATCH_SIZE = 32;

/**
 * Past this many recover tries the cron logs an error and waits an hour between tries.
 */
const RECOVERY_MAX_ATTEMPTS = 5;

const RECOVERY_SLOW_MS = 60 * 60 * 1000;

/**
 * Docs per page of the user walk of `check_user` and `repair_user`. Checking or repairing one place
 * reads its field docs and its metadata, up to 512 each, so a page stays small.
 */
const WALK_PAGE_SIZE = 4;

const WALK_PHASES = ["proposals", "hides", "places", "list_rows", "list_keys", "place_fields", "jobs"] as const;

/**
 * Docs per page of `check_share_rows`. Checking one doc reads about 3 docs.
 */
const SHARE_CHECK_PAGE_SIZE = 100;

const SHARE_CHECK_PHASES = ["grants", "share_rows"] as const;

/**
 * Nodes per page of `check_ancestors`. Checking one node reads its parent: 2,000 small docs per page,
 * so a walk over every node of a deployment takes few calls.
 */
const ANCESTOR_CHECK_PAGE_SIZE = 1000;

const job_kind_validator = v.union(
	v.literal("saved_node"),
	v.literal("parent"),
	v.literal("owner_path"),
	v.literal("place_fields"),
	v.literal("targets"),
);

type Scope = {
	organizationId: Id<"organizations">;
	workspaceId: Id<"organizations_workspaces">;
	userId: Id<"users">;
};

type PagedJob = Exclude<Doc<"files_pending_overlay_jobs">, { kind: "place_fields" | "targets" }>;

/**
 * Where a paged job goes on: the stream it walks, the Convex cursor of the next page, and the docs
 * of the last page it did not reach. `rerun` asks for one more pass after this one. `lastPath` is
 * the last place an owner path job marked, and `range` the spot of the saved node job's last page.
 */
type JobCursor = {
	phase: number;
	page: string | null;
	isDone: boolean;
	pending: string[];
	rerun?: boolean;
	lastPath?: string | null;
	range?: string;
};

/**
 * The doc streams a job walks, one after another, with the table of their docs.
 */
function job_phases(job: PagedJob) {
	switch (job.kind) {
		// Proposals, hides, places and claims, then pending content docs whose scope follows the node.
		case "saved_node":
			return [
				"files_pending_updates",
				"files_pending_hides",
				"files_pending_places",
				"files_pending_places",
				"files_plain_text_chunks",
				"files_metadata_docs",
			] as const;
		case "parent":
			return ["files_pending_places", "files_pending_updates", "files_pending_nodes"] as const;
		// The places under the old path, then every pathless place of the user.
		case "owner_path":
			return ["files_pending_places", "files_pending_places"] as const;
	}
}

async function db_job_page(ctx: MutationCtx, job: PagedJob, cursor: JobCursor) {
	const paginationOpts = { cursor: cursor.page, numItems: JOB_PAGE_SIZE };
	const places = ctx.db.query("files_pending_places");
	if (job.kind === "saved_node") {
		const savedNodeId = job.savedNodeId;
		if (cursor.phase === 4)
			return await ctx.db
				.query("files_plain_text_chunks")
				.withIndex("by_organization_workspace_target_chunkIndex", (q) =>
					q
						.eq("organizationId", job.organizationId)
						.eq("workspaceId", job.workspaceId)
						.eq("target.kind", "saved")
						.eq("target.id", savedNodeId)
						.eq("moveView.cohortId", undefined)
						.eq("moveView.view", undefined),
				)
				.paginate({ cursor: cursor.page, numItems: SCOPE_PAGE_SIZE });
		if (cursor.phase === 5)
			return await ctx.db
				.query("files_metadata_docs")
				.withIndex("by_organization_workspace_target_fieldPath", (q) =>
					q
						.eq("organizationId", job.organizationId)
						.eq("workspaceId", job.workspaceId)
						.eq("target.kind", "saved")
						.eq("target.id", savedNodeId)
						.eq("moveView.cohortId", undefined)
						.eq("moveView.view", undefined),
				)
				.paginate({ cursor: cursor.page, numItems: SCOPE_PAGE_SIZE });
		if (cursor.phase === 0)
			return await ctx.db
				.query("files_pending_updates")
				.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", savedNodeId))
				.paginate(paginationOpts);
		if (cursor.phase === 1)
			return await ctx.db
				.query("files_pending_hides")
				.withIndex("by_savedNode_user", (q) => q.eq("savedNodeId", savedNodeId))
				.paginate(paginationOpts);
		if (cursor.phase === 2)
			return await places
				.withIndex("by_target_user", (q) => q.eq("target.kind", "saved").eq("target.id", savedNodeId))
				.paginate(paginationOpts);
		const node = await ctx.db.get("files_nodes", savedNodeId);
		if (!node || node.archiveOperationId !== null) return { page: [], continueCursor: "", isDone: true };
		// A Convex cursor works only on its own range, so when the node moved since the last page,
		// start its new spot from the first doc.
		const range = `${node.parentId}:${node.name}`;
		if (cursor.range !== range) {
			cursor.range = range;
			cursor.page = null;
		}
		return await places
			.withIndex("by_org_ws_parent_name", (q) =>
				q
					.eq("organizationId", job.organizationId)
					.eq("workspaceId", job.workspaceId)
					.eq("moveView.cohortId", undefined)
					.eq("moveView.view", undefined)
					.eq("parent.kind", node.parentId === "root" ? "root" : "saved")
					.eq("parent.id", node.parentId === "root" ? undefined : node.parentId)
					.eq("name", node.name),
			)
			.paginate({ cursor: cursor.page, numItems: JOB_PAGE_SIZE });
	}
	if (job.kind === "parent") {
		const parent = job.parent;
		if (cursor.phase === 1)
			return await ctx.db
				.query("files_pending_updates")
				.withIndex("by_pendingMove_destParent", (q) =>
					q
						.eq("pendingMove.destParent.kind", parent.kind)
						.eq("pendingMove.destParent.id", parent.kind === "root" ? undefined : parent.id),
				)
				.paginate(paginationOpts);
		if (cursor.phase === 2)
			return await ctx.db
				.query("files_pending_nodes")
				.withIndex("by_org_ws_parent_state_name", (q) =>
					q
						.eq("organizationId", job.organizationId)
						.eq("workspaceId", job.workspaceId)
						.eq("parent.kind", parent.kind)
						.eq("parent.id", parent.kind === "root" ? undefined : parent.id)
						.eq("state", "active"),
				)
				.paginate(paginationOpts);
		return await places
			.withIndex("by_org_ws_parent_name", (q) =>
				q
					.eq("organizationId", job.organizationId)
					.eq("workspaceId", job.workspaceId)
					.eq("moveView.cohortId", undefined)
					.eq("moveView.view", undefined)
					.eq("parent.kind", parent.kind)
					.eq("parent.id", parent.kind === "root" ? undefined : parent.id),
			)
			.paginate(paginationOpts);
	}
	const scope = { organizationId: job.organizationId, workspaceId: job.workspaceId, userId: job.userId };
	if (cursor.phase === 0)
		return await places
			.withIndex("by_org_ws_user_ownerTreePath", (q) =>
				q
					.eq("organizationId", scope.organizationId)
					.eq("workspaceId", scope.workspaceId)
					.eq("userId", scope.userId)
					.eq("moveView.cohortId", undefined)
					.eq("moveView.view", undefined)
					.gt("ownerTreePath", job.prefix)
					.lt("ownerTreePath", path_tree_prefix_upper_bound(job.prefix)),
			)
			.paginate(paginationOpts);
	return await places
		.withIndex("by_org_ws_user_isPathless", (q) =>
			q
				.eq("organizationId", scope.organizationId)
				.eq("workspaceId", scope.workspaceId)
				.eq("userId", scope.userId)
				.eq("moveView.cohortId", undefined)
				.eq("moveView.view", undefined)
				.eq("isPathless", true),
		)
		.paginate(paginationOpts);
}

/**
 * Mark one target for the flush, or repair one pending content doc's saved scope.
 */
async function job_mark_doc(
	ctx: MutationCtx,
	job: PagedJob,
	doc:
		| Doc<"files_pending_updates">
		| Doc<"files_pending_hides">
		| Doc<"files_pending_places">
		| Doc<"files_pending_nodes">
		| Doc<"files_plain_text_chunks">
		| Doc<"files_metadata_docs">,
) {
	if (doc.organizationId !== job.organizationId || doc.workspaceId !== job.workspaceId) return;
	if ("sourceKind" in doc) {
		if (job.kind !== "saved_node") return;
		const node = await ctx.db.get("files_nodes", job.savedNodeId);
		if (!node) return;
		const archiveOperationId = node.archiveOperationId ?? undefined;
		// Scope is not part of either source index, so these patches keep the page cursor valid.
		if ("plainTextChunk" in doc) {
			if (doc.path !== node.path || doc.archiveOperationId !== archiveOperationId)
				await ctx.db.patch("files_plain_text_chunks", doc._id, { path: node.path, archiveOperationId });
		} else if (
			doc.path !== node.path ||
			doc.treePath !== node.treePath ||
			doc.archiveOperationId !== archiveOperationId
		)
			await ctx.db.patch("files_metadata_docs", doc._id, {
				path: node.path,
				treePath: node.treePath,
				archiveOperationId,
			});
		return;
	}
	files_pending_overlay_db_mark_target(ctx, {
		organizationId: doc.organizationId,
		workspaceId: doc.workspaceId,
		userId: doc.userId,
		target:
			job.kind === "saved_node"
				? { kind: "saved", id: job.savedNodeId }
				: "savedNodeId" in doc
					? { kind: "saved", id: doc.savedNodeId }
					: "state" in doc
						? { kind: "private", id: doc._id }
						: doc.target,
		pendingUpdateId: "revision" in doc ? doc._id : undefined,
	});
}

/**
 * Stop before the next doc when the transaction is near a limit. The near-limit check flushes the
 * docs marked so far first.
 */
async function db_job_should_stop(ctx: MutationCtx) {
	if (await files_subtree_ops_db_is_near_limits(ctx)) return true;
	return (await ctx.meta.getTransactionMetrics()).databaseQueries.remaining < JOB_MIN_RANGES_LEFT;
}

async function db_pending_metadata_docs(db: QueryCtx["db"], pendingUpdateId: Id<"files_pending_updates">) {
	const pendingUpdate = await db.get("files_pending_updates", pendingUpdateId);
	if (!pendingUpdate) return [];
	const docs = await db
		.query("files_metadata_docs")
		.withIndex("by_pendingUpdate_fieldPath", (q) =>
			q.eq("pendingUpdateId", pendingUpdateId).eq("moveView.cohortId", undefined).eq("moveView.view", undefined),
		)
		.collect();
	return docs.filter((doc) => doc.sourceKind === "pending" && doc.proposalRevision === pendingUpdate.revision);
}

/**
 * The metadata values the owner sees for a place: a private draft's pending docs of the proposal's
 * current revision, or a moved saved node's committed docs.
 */
async function db_place_field_values(db: QueryCtx["db"], place: Doc<"files_pending_places">) {
	const docs =
		place.target.kind === "private"
			? await db_pending_metadata_docs(db, place.pendingUpdateId)
			: await db
					.query("files_metadata_docs")
					.withIndex("by_organization_workspace_source_fileNode_fieldPath", (q) =>
						q
							.eq("organizationId", place.organizationId)
							.eq("workspaceId", place.workspaceId)
							.eq("sourceKind", "committed")
							.eq("fileNodeId", place.target.id as Id<"files_nodes">)
							.eq("moveView.cohortId", undefined)
							.eq("moveView.view", undefined),
					)
					.collect();
	return docs.map((doc) => ({
		docKind: doc.docKind,
		fieldPath: doc.fieldPath,
		valueKind: doc.valueKind,
		stringValue: doc.stringValue,
		numberValue: doc.numberValue,
		booleanValue: doc.booleanValue,
	}));
}

function field_value_key(
	value: Pick<
		Doc<"files_pending_place_fields">,
		"docKind" | "fieldPath" | "valueKind" | "stringValue" | "numberValue" | "booleanValue"
	>,
) {
	return JSON.stringify([
		value.docKind,
		value.fieldPath,
		value.valueKind ?? null,
		value.stringValue ?? null,
		value.numberValue ?? null,
		value.booleanValue ?? null,
	]);
}

/**
 * Whether a field doc copies its place as it is now, not its version number.
 */
function field_copies_place(field: Doc<"files_pending_place_fields">, place: Doc<"files_pending_places">) {
	return (
		field.parent.kind === place.parent.kind &&
		(field.parent.kind === "root" || field.parent.id === (place.parent as { id: string }).id) &&
		field.ownerTreePath === place.ownerTreePath &&
		field.isVisible === place.isVisible &&
		field.accessNodeId === place.accessNodeId
	);
}

/**
 * Make one place's field docs match its metadata, or delete them when the place is gone. One place
 * has at most 512 fields, so this fits one run.
 */
async function db_sync_place_fields(ctx: MutationCtx, placeId: Id<"files_pending_places">) {
	const place = await ctx.db.get("files_pending_places", placeId);
	const fields = await ctx.db
		.query("files_pending_place_fields")
		.withIndex("by_place", (q) =>
			q.eq("placeId", placeId).eq("moveView.cohortId", undefined).eq("moveView.view", undefined),
		)
		.collect();
	const values = place ? await db_place_field_values(ctx.db, place) : [];

	const stored = new Map<string, Doc<"files_pending_place_fields">[]>();
	for (const field of fields) {
		const key = field_value_key(field);
		stored.set(key, [...(stored.get(key) ?? []), field]);
	}
	for (const value of values) {
		const field = stored.get(field_value_key(value))?.pop();
		const copies = {
			parent: place!.parent,
			ownerTreePath: place!.ownerTreePath,
			isVisible: place!.isVisible,
			accessNodeId: place!.accessNodeId,
			fieldsVersion: place!.fieldsVersion,
		};
		if (!field)
			await ctx.db.insert("files_pending_place_fields", {
				organizationId: place!.organizationId,
				workspaceId: place!.workspaceId,
				userId: place!.userId,
				target: place!.target,
				placeId,
				...value,
				...copies,
			});
		else if (!field_copies_place(field, place!) || field.fieldsVersion !== place!.fieldsVersion)
			await ctx.db.patch("files_pending_place_fields", field._id, copies);
	}
	for (const extra of stored.values())
		for (const field of extra) await ctx.db.delete("files_pending_place_fields", field._id);
}

/**
 * Point the job's doc at a new run of the same job. A running job must not cancel its own
 * scheduled function: Convex would then also cancel the run it schedules next.
 */
async function db_continue_job(
	ctx: MutationCtx,
	job: Doc<"files_pending_overlay_jobs">,
	patch: {
		cursor: string | null;
		placeIds?: Id<"files_pending_places">[];
		items?: Extract<Doc<"files_pending_overlay_jobs">, { kind: "targets" }>["items"];
	},
) {
	const now = Date.now();
	const scheduledFunctionId = await ctx.scheduler.runAt(now, internal.files_pending_overlay.run_job, {
		kind: job.kind,
		key: job.key,
		nextAttemptAt: now,
	});
	await ctx.db.patch("files_pending_overlay_jobs", job._id, { ...patch, nextAttemptAt: now, scheduledFunctionId });
}

/**
 * One run of an overlay job: recompute docs until the transaction is near a limit, then schedule
 * the next run. The last run deletes the task doc.
 */
export const run_job = internalMutation({
	args: {
		kind: job_kind_validator,
		key: v.string(),
		/**
		 * The job's `nextAttemptAt` when this run was scheduled.
		 */
		nextAttemptAt: v.number(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const job = await ctx.db
			.query("files_pending_overlay_jobs")
			.withIndex("by_kind_key", (q) => q.eq("kind", args.kind).eq("key", args.key))
			.unique();
		// A purge deleted the task, or a newer run now owns it. A write that schedules a new run can
		// conflict with this one while it runs; Convex then runs this one again on the new doc, and the
		// check stops it, so only the new run goes on. Two schedules in the same millisecond look the
		// same; then both runs go on, which is safe because all writes are diffed.
		if (
			!job ||
			job.blockedByCohortId ||
			job.nextAttemptAt > Date.now() ||
			args.nextAttemptAt !== job.nextAttemptAt
		)
			return null;
		if (!(await ctx.db.get("organizations_workspaces", job.workspaceId))) {
			await files_pending_overlay_db_delete_job(ctx, job);
			return null;
		}
		const own = files_pending_overlay_db_set_own_job(ctx, job);
		const currentView = await files_saved_placement_db_get_view(ctx.db, job);
		const target_cohort = async (target: files_PendingTarget) =>
			await files_pending_overlay_db_target_cohort(ctx.db, {
				organizationId: job.organizationId,
				workspaceId: job.workspaceId,
				target,
				currentView,
			});
		const park = async (
			cohortId: Id<"files_move_cohorts">,
			patch: {
				cursor?: string | null;
				placeIds?: Id<"files_pending_places">[];
				items?: Extract<Doc<"files_pending_overlay_jobs">, { kind: "targets" }>["items"];
			} = {},
		) => {
			await ctx.db.patch("files_pending_overlay_jobs", job._id, { ...patch, blockedByCohortId: cohortId });
		};
		if (job.kind === "saved_node" || (job.kind === "parent" && job.parent.kind !== "root")) {
			const target: files_PendingTarget =
				job.kind === "saved_node" ? { kind: "saved", id: job.savedNodeId } : (job.parent as files_PendingTarget);
			const cohortId = await target_cohort(target);
			if (cohortId) {
				await park(cohortId);
				return null;
			}
		}

		if (job.kind === "place_fields") {
			let done = 0;
			for (const placeId of job.placeIds) {
				if (done > 0 && (await db_job_should_stop(ctx))) break;
				const place = await ctx.db.get("files_pending_places", placeId);
				const cohortId = place && (await target_cohort(place.target));
				if (cohortId) {
					await park(cohortId, { placeIds: job.placeIds.slice(done) });
					return null;
				}
				await db_sync_place_fields(ctx, placeId);
				done++;
			}
			if (done === job.placeIds.length) await files_pending_overlay_db_delete_job(ctx, job);
			else await db_continue_job(ctx, job, { cursor: null, placeIds: job.placeIds.slice(done) });
			return null;
		}

		// A write to the drafts of many users sent these recomputes here. The flush does them.
		if (job.kind === "targets") {
			let done = 0;
			for (const item of job.items) {
				if (done > 0 && (await db_job_should_stop(ctx))) break;
				const cohortId = await target_cohort(item.target);
				if (cohortId) {
					await park(cohortId, { items: job.items.slice(done) });
					return null;
				}
				files_pending_overlay_db_mark_target(ctx, {
					organizationId: job.organizationId,
					workspaceId: job.workspaceId,
					userId: job.userId,
					target: item.target,
					pendingUpdateId: item.pendingUpdateId ?? undefined,
					fieldsChanged: item.fieldsChanged,
				});
				done++;
			}
			if (done === job.items.length) await files_pending_overlay_db_delete_job(ctx, job);
			else await db_continue_job(ctx, job, { cursor: null, items: job.items.slice(done) });
			return null;
		}

		const phases = job_phases(job);
		const cursor: JobCursor = job.cursor
			? (JSON.parse(job.cursor) as JobCursor)
			: { phase: 0, page: null, isDone: false, pending: [] };
		own.phase = cursor.phase;
		own.lastPath = cursor.lastPath ?? null;
		const next_phase = () => {
			cursor.phase++;
			cursor.page = null;
			cursor.isDone = false;
			cursor.lastPath = null;
			own.phase = cursor.phase;
			own.lastPath = null;
		};
		let marked = 0;
		let blockedByCohortId: Id<"files_move_cohorts"> | null = null;
		const mark_docs = async (ids: string[]) => {
			const left = [...ids];
			while (left.length > 0) {
				if (marked > 0 && (await db_job_should_stop(ctx))) break;
				const doc = await ctx.db.get(phases[cursor.phase]!, left[0] as Id<(typeof phases)[number]>);
				if (doc) {
					const target =
						job.kind === "saved_node"
							? { kind: "saved" as const, id: job.savedNodeId }
							: "savedNodeId" in doc
								? { kind: "saved" as const, id: doc.savedNodeId }
								: "state" in doc
									? { kind: "private" as const, id: doc._id }
									: "target" in doc
										? doc.target
										: "fileNodeId" in doc
											? { kind: "saved" as const, id: doc.fileNodeId }
											: null;
					if (!target) throw should_never_happen("Overlay job doc has no target", { jobId: job._id, docId: doc._id });
					blockedByCohortId = await target_cohort(target);
					if (blockedByCohortId) break;
					await job_mark_doc(ctx, job, doc);
					// The flush asks this job for no walk under its prefix after this place. A doc read from an
					// older page may have moved back since, so the path only grows: a smaller one would drop
					// walks of places the page cursor already passed.
					if (job.kind === "owner_path" && cursor.phase === 0) {
						const path = (doc as Doc<"files_pending_places">).ownerTreePath;
						if (own.lastPath === null || compareValues(path, own.lastPath) > 0) own.lastPath = cursor.lastPath = path;
					}
				}
				left.shift();
				marked++;
			}
			return left;
		};

		// First the docs the last run read but did not reach, then one new page.
		cursor.pending = await mark_docs(cursor.pending);
		if (cursor.pending.length === 0 && cursor.isDone) next_phase();
		if (
			cursor.pending.length === 0 &&
			blockedByCohortId === null &&
			cursor.phase < phases.length &&
			// Start a scope page with a fresh byte budget, after any earlier recomputes.
			!(job.kind === "saved_node" && cursor.phase >= 4 && marked > 0) &&
			!(marked > 0 && (await db_job_should_stop(ctx)))
		) {
			const page = await db_job_page(ctx, job, cursor);
			cursor.pending = await mark_docs(page.page.map((doc) => doc._id));
			cursor.page = page.continueCursor;
			cursor.isDone = page.isDone;
			if (cursor.pending.length === 0 && cursor.isDone) next_phase();
		}

		// Flush the last marks now, so a rerun they ask for is in the cursor.
		await files_pending_overlay_db_flush(ctx);
		cursor.rerun ||= own.rerun;
		if (blockedByCohortId) await park(blockedByCohortId, { cursor: JSON.stringify(cursor) });
		else if (cursor.phase < phases.length) await db_continue_job(ctx, job, { cursor: JSON.stringify(cursor) });
		// Asked again during the pass: one fresh pass now.
		else if (cursor.rerun) await db_continue_job(ctx, job, { cursor: null });
		else await files_pending_overlay_db_delete_job(ctx, job);
		return null;
	},
});

/**
 * 15-minute cron. A task still in the past long after its time means its job failed or never ran.
 * Cancel that job and start a new one now; past 5 tries, log an error and try once an hour.
 */
export const recover_jobs = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const now = Date.now();
		const jobs = await ctx.db
			.query("files_pending_overlay_jobs")
			.withIndex("by_blockedCohort", (q) => q.eq("blockedByCohortId", undefined).lt("nextAttemptAt", now - RECOVERY_MS))
			.take(RECOVERY_BATCH_SIZE);
		for (const job of jobs) {
			const attempts = job.attempts + 1;
			if (attempts > RECOVERY_MAX_ATTEMPTS) {
				const errorMessage = "Pending overlay job keeps failing";
				const errorData = { jobId: job._id, kind: job.kind, key: job.key, attempts };
				console.error(errorMessage, errorData);
			}
			const runAt = attempts > RECOVERY_MAX_ATTEMPTS ? now + RECOVERY_SLOW_MS : now;
			// Cancel only a function that has not started. A running one conflicts with this write, so
			// Convex runs it again on the new doc, where `run_job` sees the new `nextAttemptAt` and stops.
			if ((await ctx.db.system.get("_scheduled_functions", job.scheduledFunctionId))?.state.kind === "pending")
				await ctx.scheduler.cancel(job.scheduledFunctionId);
			const scheduledFunctionId = await ctx.scheduler.runAt(runAt, internal.files_pending_overlay.run_job, {
				kind: job.kind,
				key: job.key,
				nextAttemptAt: runAt,
			});
			await ctx.db.patch("files_pending_overlay_jobs", job._id, {
				attempts,
				nextAttemptAt: runAt,
				scheduledFunctionId,
			});
		}
		if (jobs.length === RECOVERY_BATCH_SIZE)
			await ctx.scheduler.runAfter(0, internal.files_pending_overlay.recover_jobs, {});
		return null;
	},
});

// #region check and repair

/**
 * One page of the walk over a user's proposals and derived docs. The cursor names the stream and
 * the Convex cursor inside it; null when the walk is done.
 */
async function db_walk_user_page(db: QueryCtx["db"], scope: Scope, cursor: string | null) {
	const position = cursor ? (JSON.parse(cursor) as { phase: number; page: string | null }) : { phase: 0, page: null };
	const phase = WALK_PHASES[position.phase]!;
	const paginationOpts = { cursor: position.page, numItems: WALK_PAGE_SIZE };
	// Every walked index but the last two starts with the owner fields.
	const owner = (q: any) =>
		q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId).eq("userId", scope.userId);

	const result =
		phase === "proposals"
			? await db
					.query("files_pending_updates")
					.withIndex("by_organization_workspace_user_target", (q) => owner(q))
					.paginate(paginationOpts)
			: phase === "hides"
				? await db
						.query("files_pending_hides")
						.withIndex("by_org_ws_user_treePath", (q) =>
							owner(q).eq("moveView.cohortId", undefined).eq("moveView.view", undefined),
						)
						.paginate(paginationOpts)
				: phase === "places"
					? await db
							.query("files_pending_places")
							.withIndex("by_org_ws_user_ownerTreePath", (q) =>
								owner(q).eq("moveView.cohortId", undefined).eq("moveView.view", undefined),
							)
							.paginate(paginationOpts)
					: phase === "list_rows"
						? await db
								.query("files_pending_list_rows")
								.withIndex("by_org_ws_user_listKey_updatedAt", (q) =>
									owner(q).eq("moveView.cohortId", undefined).eq("moveView.view", undefined),
								)
								.paginate(paginationOpts)
						: phase === "list_keys"
							? await db
									.query("files_pending_list_keys")
									.withIndex("by_org_ws_user_listKey", (q) =>
										owner(q).eq("moveView.cohortId", undefined).eq("moveView.view", undefined),
									)
									.paginate(paginationOpts)
							: phase === "place_fields"
								? await db
										.query("files_pending_place_fields")
										.withIndex("by_user", (q) =>
											q.eq("userId", scope.userId).eq("moveView.cohortId", undefined).eq("moveView.view", undefined),
										)
										.paginate(paginationOpts)
								: await db
										.query("files_pending_overlay_jobs")
										.withIndex("by_user", (q) => q.eq("userId", scope.userId))
										.paginate(paginationOpts);

	const next = result.isDone ? { phase: position.phase + 1, page: null } : { ...position, page: result.continueCursor };
	return {
		phase,
		docs: result.page,
		cursor: next.phase < WALK_PHASES.length ? JSON.stringify(next) : null,
	};
}

/**
 * The saved node a place's position may claim: the active saved node with its parent and name.
 */
async function db_saved_node_at(db: QueryCtx["db"], place: Doc<"files_pending_places">) {
	if (place.parent.kind === "private") return null;
	const parentId = place.parent.kind === "root" ? "root" : place.parent.id;
	return await files_saved_placement_db_get_slot(db, { ...place, parentId });
}

/**
 * The same value in a fixed key order, so two docs compare as text.
 */
function stable_json(value: unknown) {
	return JSON.stringify(value, (_key, item: unknown) =>
		item && typeof item === "object" && !Array.isArray(item)
			? Object.fromEntries(
					Object.entries(item)
						.filter(([field, fieldValue]) => fieldValue !== undefined && field !== "_id" && field !== "_creationTime")
						.sort(([a], [b]) => (a < b ? -1 : 1)),
				)
			: item,
	);
}

/**
 * Compare one target's stored derived docs with what they should be.
 */
async function db_check_target(
	db: QueryCtx["db"],
	reader: ReturnType<typeof files_pending_overlay_db_create_reader>,
	scope: Scope,
	target: files_PendingTarget,
) {
	const differences: string[] = [];
	const name = `${target.kind}:${target.id}`;
	const pendingUpdate = await db
		.query("files_pending_updates")
		.withIndex("by_user_target", (q) =>
			q.eq("userId", scope.userId).eq("target.kind", target.kind).eq("target.id", target.id),
		)
		.unique();
	const desired = await files_pending_overlay_db_compute_target(db, reader, { ...scope, target, pendingUpdate });

	if (target.kind === "saved") {
		const hide = await db
			.query("files_pending_hides")
			.withIndex("by_savedNode_user", (q) =>
				q
					.eq("savedNodeId", target.id)
					.eq("userId", scope.userId)
					.eq("moveView.cohortId", undefined)
					.eq("moveView.view", undefined),
			)
			.unique();
		if (stable_json(hide) !== stable_json(desired.hide))
			differences.push(`hide of ${name}: stored ${stable_json(hide)}, expected ${stable_json(desired.hide)}`);
	}

	const place = await db
		.query("files_pending_places")
		.withIndex("by_target_user", (q) =>
			q
				.eq("target.kind", target.kind)
				.eq("target.id", target.id)
				.eq("userId", scope.userId)
				.eq("moveView.cohortId", undefined)
				.eq("moveView.view", undefined),
		)
		.unique();
	const storedPlace = place && { ...place, fieldsVersion: undefined };
	if (stable_json(storedPlace) !== stable_json(desired.place))
		differences.push(`place of ${name}: stored ${stable_json(storedPlace)}, expected ${stable_json(desired.place)}`);

	if (pendingUpdate) {
		const rows = await db
			.query("files_pending_list_rows")
			.withIndex("by_pendingUpdate", (q) =>
				q.eq("pendingUpdateId", pendingUpdate._id).eq("moveView.cohortId", undefined).eq("moveView.view", undefined),
			)
			.collect();
		const stored = rows.map((row) => `${row.listKey}@${row.updatedAt}`).sort();
		const expected = desired.listKeys.map((listKey) => `${listKey}@${pendingUpdate.updatedAt}`).sort();
		if (stored.join() !== expected.join())
			differences.push(`list docs of ${name}: stored [${stored.join()}], expected [${expected.join()}]`);
	}

	if (place) {
		const fields = await db
			.query("files_pending_place_fields")
			.withIndex("by_place", (q) =>
				q.eq("placeId", place._id).eq("moveView.cohortId", undefined).eq("moveView.view", undefined),
			)
			.collect();
		const stored = fields.map(field_value_key).sort();
		const expected = (await db_place_field_values(db, place)).map(field_value_key).sort();
		if (stored.join() !== expected.join() || fields.some((field) => !field_copies_place(field, place)))
			differences.push(`fields of ${name}: stored ${fields.length}, expected ${expected.length} matching the place`);
	}
	return differences;
}

/**
 * Compare one page of a user's derived docs with what the flush would write, and return the
 * differences. Call again with the returned cursor until it is null. An active workspace Move
 * returns moveInProgress instead; restart the audit after the Move ends.
 */
export const check_user = internalQuery({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		cursor: v.union(v.string(), v.null()),
	},
	returns: v.object({
		differences: v.array(v.string()),
		cursor: v.union(v.string(), v.null()),
		moveInProgress: v.boolean(),
	}),
	handler: async (ctx, args) => {
		const scope = { organizationId: args.organizationId, workspaceId: args.workspaceId, userId: args.userId };
		const slot = await ctx.db
			.query("files_move_workspace_slots")
			.withIndex("by_workspace", (q) =>
				q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId),
			)
			.unique();
		// Cohort staging has its own exact work proofs. Audit normal docs after cleanup ends.
		if (slot?.cohortId) return { differences: [], cursor: null, moveInProgress: true };
		const reader = files_pending_overlay_db_create_reader(ctx.db, scope);
		const { phase, docs, cursor } = await db_walk_user_page(ctx.db, scope, args.cursor);
		const differences: string[] = [];

		for (const doc of docs) {
			if (phase === "proposals") {
				const proposal = doc as Doc<"files_pending_updates">;
				differences.push(...(await db_check_target(ctx.db, reader, scope, proposal.target)));
			} else if (phase === "hides") {
				const hide = doc as Doc<"files_pending_hides">;
				differences.push(...(await db_check_target(ctx.db, reader, scope, { kind: "saved", id: hide.savedNodeId })));
			} else if (phase === "places") {
				const place = doc as Doc<"files_pending_places">;
				differences.push(...(await db_check_target(ctx.db, reader, scope, place.target)));
				// A place may claim the saved node at its position, with or without a proposal on it.
				const claimed = await db_saved_node_at(ctx.db, place);
				if (claimed)
					differences.push(...(await db_check_target(ctx.db, reader, scope, { kind: "saved", id: claimed._id })));
			} else if (phase === "list_rows") {
				const row = doc as Doc<"files_pending_list_rows">;
				const proposal = await ctx.db.get("files_pending_updates", row.pendingUpdateId);
				if (proposal?.userId !== scope.userId) differences.push(`list doc ${row._id} has no proposal`);
				const keyDoc = await ctx.db
					.query("files_pending_list_keys")
					.withIndex("by_org_ws_user_listKey", (q) =>
						q
							.eq("organizationId", scope.organizationId)
							.eq("workspaceId", scope.workspaceId)
							.eq("userId", scope.userId)
							.eq("moveView.cohortId", undefined)
							.eq("moveView.view", undefined)
							.eq("listKey", row.listKey),
					)
					.unique();
				if (!keyDoc || keyDoc.lastUpdatedAt < row.updatedAt)
					differences.push(`list key ${row.listKey} is missing or older than list doc ${row._id}`);
			} else if (phase === "list_keys") {
				const keyDoc = doc as Doc<"files_pending_list_keys">;
				const newest = await ctx.db
					.query("files_pending_list_rows")
					.withIndex("by_org_ws_user_listKey_updatedAt", (q) =>
						q
							.eq("organizationId", scope.organizationId)
							.eq("workspaceId", scope.workspaceId)
							.eq("userId", scope.userId)
							.eq("moveView.cohortId", undefined)
							.eq("moveView.view", undefined)
							.eq("listKey", keyDoc.listKey),
					)
					.order("desc")
					.first();
				if (newest?.updatedAt !== keyDoc.lastUpdatedAt)
					differences.push(`list key ${keyDoc.listKey}: stored ${keyDoc.lastUpdatedAt}, expected ${newest?.updatedAt}`);
			} else if (phase === "place_fields") {
				const field = doc as Doc<"files_pending_place_fields">;
				if (field.organizationId !== scope.organizationId || field.workspaceId !== scope.workspaceId) continue;
				const place = await ctx.db.get("files_pending_places", field.placeId);
				if (!place || !field_copies_place(field, place))
					differences.push(`field doc ${field._id} does not match its place ${field.placeId}`);
			} else {
				const job = doc as Doc<"files_pending_overlay_jobs">;
				if (job.workspaceId === scope.workspaceId && job.attempts > RECOVERY_MAX_ATTEMPTS)
					differences.push(`job ${job.kind} ${job.key} failed ${job.attempts} times`);
			}
		}
		return { differences, cursor, moveInProgress: false };
	},
});

/**
 * Recompute every derived doc of one user, one walk page per run, and delete orphan docs. Runs
 * itself again until the walk is done.
 */
export const repair_user = internalMutation({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		cursor: v.union(v.string(), v.null()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const scope = { organizationId: args.organizationId, workspaceId: args.workspaceId, userId: args.userId };
		const { phase, docs, cursor } = await db_walk_user_page(ctx.db, scope, args.cursor);

		for (const doc of docs) {
			if (phase === "proposals") {
				const proposal = doc as Doc<"files_pending_updates">;
				files_pending_overlay_db_mark_target(ctx, { ...scope, target: proposal.target, pendingUpdateId: proposal._id });
			} else if (phase === "hides") {
				const hide = doc as Doc<"files_pending_hides">;
				files_pending_overlay_db_mark_target(ctx, { ...scope, target: { kind: "saved", id: hide.savedNodeId } });
			} else if (phase === "places") {
				const place = doc as Doc<"files_pending_places">;
				files_pending_overlay_db_mark_target(ctx, {
					...scope,
					target: place.target,
					pendingUpdateId: place.pendingUpdateId,
				});
				// Sync each place's fields once here; the fields phase below deletes only orphans.
				await db_sync_place_fields(ctx, place._id);
				const claimed = await db_saved_node_at(ctx.db, place);
				if (claimed)
					files_pending_overlay_db_mark_target(ctx, { ...scope, target: { kind: "saved", id: claimed._id } });
			} else if (phase === "list_rows" || phase === "list_keys") {
				const row = doc as Doc<"files_pending_list_rows"> | Doc<"files_pending_list_keys">;
				if ("pendingUpdateId" in row) {
					const proposal = await ctx.db.get("files_pending_updates", row.pendingUpdateId);
					if (proposal?.userId === scope.userId)
						files_pending_overlay_db_mark_target(ctx, {
							...scope,
							target: proposal.target,
							pendingUpdateId: row.pendingUpdateId,
						});
					else await ctx.db.delete("files_pending_list_rows", row._id);
				}
				await files_pending_overlay_db_sync_list_key(ctx.db, { ...scope, listKey: row.listKey });
			} else if (phase === "place_fields") {
				const field = doc as Doc<"files_pending_place_fields">;
				if (
					field.organizationId === scope.organizationId &&
					field.workspaceId === scope.workspaceId &&
					!(await ctx.db.get("files_pending_places", field.placeId))
				)
					await ctx.db.delete("files_pending_place_fields", field._id);
			}
		}

		if (cursor) await ctx.scheduler.runAfter(0, internal.files_pending_overlay.repair_user, { ...args, cursor });
		return null;
	},
});

/**
 * Compare one page of a workspace's share rows with what the flush would write, and return the
 * differences. It walks the workspace's file grants first (a missing or wrong row), then its share
 * rows (a row with no share behind it). Call again with the returned cursor until it is null.
 */
export const check_share_rows = internalQuery({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		cursor: v.union(v.string(), v.null()),
	},
	returns: v.object({ differences: v.array(v.string()), cursor: v.union(v.string(), v.null()) }),
	handler: async (ctx, args) => {
		const position = args.cursor
			? (JSON.parse(args.cursor) as { phase: number; page: string | null })
			: { phase: 0, page: null };
		const phase = SHARE_CHECK_PHASES[position.phase]!;
		const paginationOpts = { cursor: position.page, numItems: SHARE_CHECK_PAGE_SIZE };
		const differences: string[] = [];

		let result: { isDone: boolean; continueCursor: string };
		if (phase === "grants") {
			const grants = await ctx.db
				.query("access_control_permission_grants")
				.withIndex("by_resource_permission", (q) =>
					q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("resourceKind", "file"),
				)
				.paginate(paginationOpts);
			for (const grant of grants.page) {
				const desired = await files_share_rows_db_compute_all_for_grant(ctx.db, grant);
				const rows = await ctx.db
					.query("files_share_rows")
					.withIndex("by_grant", (q) => q.eq("grantId", grant._id))
					.collect();
				const stored = rows.map(stable_json).sort().join();
				const expected = desired.map(stable_json).sort().join();
				if (stored !== expected)
					differences.push(`share rows of grant ${grant._id}: stored [${stored}], expected [${expected}]`);
			}
			result = grants;
		} else {
			const rows = await ctx.db
				.query("files_share_rows")
				.withIndex("by_org_ws_principal_archive_sortName_name", (q) =>
					q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId),
				)
				.paginate(paginationOpts);
			for (const row of rows.page) {
				const grant = await ctx.db.get("access_control_permission_grants", row.grantId);
				const desired = await files_share_rows_db_compute_for_grant(ctx.db, grant, row.moveView);
				if (stable_json(row) !== stable_json(desired))
					differences.push(`share row ${row._id}: stored ${stable_json(row)}, expected ${stable_json(desired)}`);
			}
			result = rows;
		}

		const next = result.isDone
			? { phase: position.phase + 1, page: null }
			: { ...position, page: result.continueCursor };
		return { differences, cursor: next.phase < SHARE_CHECK_PHASES.length ? JSON.stringify(next) : null };
	},
});

/**
 * Compare one page of saved nodes' `ancestor1..12` with their parent's, in every workspace, and
 * return the nodes that differ. A node is right when it copies its parent's ancestors plus the
 * parent, so a walk with no difference proves every chain. Call again with the returned cursor until
 * it is null.
 */
export const check_ancestors = internalQuery({
	args: { cursor: v.union(v.string(), v.null()) },
	returns: v.object({ differences: v.array(v.string()), cursor: v.union(v.string(), v.null()) }),
	handler: async (ctx, args) => {
		const nodes = await ctx.db
			.query("files_nodes")
			.paginate({ cursor: args.cursor, numItems: ANCESTOR_CHECK_PAGE_SIZE });
		const differences: string[] = [];
		for (const node of nodes.page) {
			const stored = files_ancestor_ids(node);
			const expected = await files_pending_overlay_db_child_ancestors(ctx.db, node.parentId);
			// A node whose parent is gone has no expected chain.
			if (expected && stored.join() !== expected.join())
				differences.push(`ancestors of ${node._id}: stored [${stored.join()}], expected [${expected.join()}]`);
		}
		return { differences, cursor: nodes.isDone ? null : nodes.continueCursor };
	},
});

// #endregion check and repair
