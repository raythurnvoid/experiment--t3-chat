// The pending overlay: derived docs that copy what each user's drafts change, so agent reads and
// draft views can page them with indexes. Only the flush below, its jobs
// (`convex/files_pending_overlay.ts`) and data deletion write them.
//
// The UI lists and the search box are saved-only. Only the agent's bash tools, the Pending tab and
// the draft folder view read the user's drafts (files-explorer-tree skill, "Saved-only lists").
//
// Every mutation captures its writes to the source tables with `files_pending_overlay_db_wrap`
// and flushes once at the end (`convex/functions.ts`). The flush recomputes derived docs from the
// source tables and the owner's reader. Derived docs only tell it what to recompute, never facts.
// The same flush also keeps two other copies in sync: the share docs in `files_share_rows`
// (`server/files-share-rows.ts`) and the `ancestor1..12` fields of saved `files_nodes`. And it
// inserts the metadata catalog's deltas (`server/files-metadata-catalog.ts`).
//
// Leaf module: import only `convex/_generated`, `shared/`, `common/` and other leaf modules (see
// `server/files-visible-resolve.ts`).

import { compareValues, ConvexError, v, type Infer, type Value } from "convex/values";
import { validate } from "convex-helpers/validators";
import { Result } from "common/errors-as-values-utils.ts";
import type { PaginationResult, TransactionMetrics, WithoutSystemFields } from "convex/server";
import { internal } from "../convex/_generated/api.js";
import type { Doc, Id, TableNames } from "../convex/_generated/dataModel.js";
import type { ActionCtx, MutationCtx, QueryCtx } from "../convex/_generated/server.js";
import type {
	files_visible_list_Result,
	files_visible_search_name_Result,
	files_visible_stream_Result,
} from "../convex/files_visible.ts";
import type { ai_chat_workspaces_source_validator, files_metadata_search_plan_validator } from "../convex/schema.ts";
import {
	files_ANCESTOR_FIELD_COUNT,
	files_ancestor_fields,
	files_ancestor_ids,
	files_derive_tree_path_for_file_node,
	files_is_ancestor_field,
	files_lowercase_extension,
	files_pending_update_index_revision,
	files_TEXT_SEARCH_MAX_RESULTS,
	type files_PendingParent,
	type files_PendingTarget,
	type files_SavedStream,
	type files_IndexStream,
} from "../shared/files.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";
import { should_never_happen } from "../shared/shared-utils.ts";
import { convex_error } from "./convex-utils.ts";
import {
	files_share_rows_db_node_changed,
	files_share_rows_db_sync_grant,
	files_share_rows_db_sync_node,
	files_share_rows_NODE_FIELDS,
} from "./files-share-rows.ts";
import { files_visible_resolve_db_create, type files_visible_resolve_Facts } from "./files-visible-resolve.ts";
import { files_pending_types_compute } from "./files-pending-types.ts";
import { files_metadata_maps_db_delete } from "./files-metadata-maps.ts";
import { files_content_heads_db_flush } from "./files-content-heads.ts";
import {
	files_metadata_catalog_add_write,
	files_metadata_catalog_db_insert_deltas,
	files_metadata_catalog_SOURCE_FIELDS,
	type files_metadata_catalog_Changes,
} from "./files-metadata-catalog.ts";
import {
	files_saved_placement_db_bump_search_generation,
	files_saved_placement_db_get_node,
	files_saved_placement_db_get_proposal,
	files_saved_placement_db_get_publish_receipt,
	files_saved_placement_db_get_view,
	files_saved_placement_db_get_slot,
	type files_saved_placement_FixedView,
	type files_saved_placement_View,
} from "./files-saved-placement.ts";
import { files_saved_index_db_is_publishing } from "./files-saved-index.ts";
import {
	files_pending_review_facts_db_change_state,
	files_pending_review_facts_db_pin_structure,
	files_pending_review_facts_db_sync,
} from "./files-pending-review-facts.ts";
import { path_tree_prefix_upper_bound, server_path_normalize } from "./server-utils.ts";
import type { access_control_Subject } from "../convex/access_control.ts";
import { access_control_subject_reads_drafts } from "../shared/access-control.ts";
import {
	files_move_reservations_db_enter,
	files_move_reservations_db_find_blocker,
	files_move_reservations_db_get_source,
	files_move_reservations_db_note_source,
	files_move_reservations_db_is_rename_allocation,
} from "./files-move-reservations.ts";
import {
	files_tree_walk_cursor_validator,
	files_tree_walk_MAX_CALLS,
	files_tree_walk_page,
	type files_tree_walk_stack_validator,
} from "./files-tree-walk.ts";

/**
 * Tables the flush recomputes from. A write to one of them marks derived docs dirty. A grant write
 * marks something only for a file grant, which has a share row.
 */
const SOURCE_TABLES = new Set<string>([
	"files_nodes",
	"files_pending_updates",
	"files_pending_nodes",
	"files_pending_node_publish_receipts",
	"files_metadata_docs",
	"access_control_permission_grants",
]);

/**
 * Derived tables. The Discard unit counts their writes without its old doc read.
 */
export const files_pending_overlay_DERIVED_TABLES = new Set<string>([
	"files_pending_hides",
	"files_pending_places",
	"files_pending_type_entries",
	"files_pending_overlay_resolve_work",
	"files_pending_place_fields",
	"files_pending_list_rows",
	"files_pending_list_keys",
	"files_pending_overlay_jobs",
	"files_share_rows",
	"files_metadata_catalog",
	"files_metadata_catalog_deltas",
	"files_metadata_catalog_compactors",
]);

/**
 * The fields the flush reads from a source doc it saw before. The caches keep only these.
 */
const SOURCE_FIELDS: Record<string, string[]> = {
	files_nodes: [
		"organizationId",
		"workspaceId",
		"treePath",
		"restrictedScopeNodeId",
		// Share rows read both: an extended root has rows, and a Move-held node has rows in both views.
		"extendedScopeNodeId",
		"moveCohortId",
		"contentType",
		"contentTypeEssence",
		"contentTypeFamily",
		...files_share_rows_NODE_FIELDS,
	],
	// Only a file grant's write marks its share row, so the kind is all the flush needs.
	access_control_permission_grants: ["resourceKind"],
	files_pending_updates: ["organizationId", "workspaceId", "userId", "target"],
	files_pending_nodes: ["organizationId", "workspaceId", "userId", "parent", "name", "state"],
	files_pending_node_publish_receipts: [
		"organizationId",
		"workspaceId",
		"userId",
		"privateNodeId",
		"savedNodeId",
		"moveView",
	],
	files_metadata_docs: [
		"organizationId",
		"workspaceId",
		"sourceKind",
		"fileNodeId",
		"target",
		"userId",
		"pendingUpdateId",
		"moveView",
		// The metadata catalog's fields.
		"archiveOperationId",
		"parentId",
		"isRestrictedScopeRoot",
		"restrictedScopeNodeId",
		"docKind",
		"fieldPath",
		"valueKind",
		"stringValue",
	],
};

/**
 * Metadata fields that place fields copy. A patch of other fields marks nothing.
 */
const METADATA_VALUE_FIELDS = ["docKind", "fieldPath", "valueKind", "stringValue", "numberValue", "booleanValue"];

/**
 * Proposal fields the overlay reads: the reader reads `pendingMove` and `pendingArchive`; places
 * copy `updatedAt` of a private draft; list docs read `updatedAt`, `threadIds` and `createIntent`.
 * The review facts also pin `revision`, including proposals with content only.
 */
const PROPOSAL_FIELDS = [
	"pendingMove",
	"pendingArchive",
	"pendingReplacement",
	"updatedAt",
	"threadIds",
	"createIntent",
	"revision",
];

/**
 * A saved node's move, rename or archive refreshes every user's hide and place of that node in the
 * same transaction (exact windows), so their number must stay small. A user's own write may add a
 * hide or place of a saved node only while other users hold fewer than this many of them.
 */
const MAX_OTHER_USERS_DOCS_PER_SAVED_NODE = 32;

const MAX_FLUSH_ROUNDS = 10;

/**
 * Convex's range limit per transaction.
 */
const TRANSACTION_RANGES = 4096;

/**
 * The inline owner path step recomputes at most this many places per transaction.
 */
const INLINE_OWNER_PATH_PLACES = 50;

/**
 * The inline owner path step also stops after it used this many ranges.
 */
const INLINE_OWNER_PATH_RANGES = 1000;

/**
 * A saved node with at most this many saved metadata docs and at most this many text chunks gets its
 * scope copied in the same mutation, without a saved scope job. A metadata key has a field doc and a
 * value doc, and a text chunk holds at most 1,200 characters (`MAX_CHUNK_SIZE` in
 * `server/files-plain-text-chunking.ts`). So this covers about 8 keys and text files up to about
 * 19,000 characters.
 */
const INLINE_SAVED_SCOPE_DOCS = 16;

/**
 * Ids per list job doc (place fields, targets), far below Convex's 8,192 array items.
 */
const JOB_LIST_ITEMS = 1000;

/**
 * Reads kept for the proposal, derived docs and continuation writes after a resolver slice.
 * A deep target resumes in a later counted job instead of becoming a missing result.
 */
const JOB_READER_MARGIN = 256;

/**
 * The read rounds of one agent listing call. Each round reads every stream that blocks the merge. A
 * call that runs out of rounds returns a short page with a cursor.
 */
const LIST_MAX_ROUNDS = 8;

/**
 * A stream page that kept less than half its rows doubles, up to the listing's page size plus this
 * many rows.
 */
const LIST_PAGE_GROWTH = 1_000;

/**
 * The largest stream page: the largest Bash page (200 rows, `bash_clamp_listing_page_limit`) plus the
 * growth.
 */
export const files_pending_overlay_LIST_STREAM_MAX_PAGE = 200 + LIST_PAGE_GROWTH;

/**
 * The read budget of agent listings in one transaction. A stream call stops deciding rows past it,
 * and the merge starts no more stream calls past it once its cursor moved. The room left under the
 * Convex limits (4,096 ranges, 32,000 documents, 16 MiB) covers the stream calls that run over
 * before that: each one's page, fixed reads and one row. Usually that is one call.
 */
const LIST_BUDGET = { ranges: 3_000, documents: 24_000, bytes: 12 * 1024 * 1024 };

type SourceFields = Record<string, any>;

type Scope = {
	organizationId: Id<"organizations">;
	workspaceId: Id<"organizations_workspaces">;
	userId: Id<"users">;
};

type TargetMark = Scope & {
	target: files_PendingTarget;
	/**
	 * Proposal ids written for this target, so list docs of a deleted proposal go too.
	 */
	pendingUpdateIds: Set<Id<"files_pending_updates">>;
	/**
	 * A metadata doc of the target changed.
	 */
	fieldsChanged: boolean;
	/**
	 * A folder hide changed before its path was ready. Its children still need a path refresh.
	 */
	ownerPathPending?: boolean;
	/**
	 * The owner's own draft write: its folder changes may run the inline owner path step.
	 */
	inline: boolean;
	/**
	 * The owner's draft write itself caused this mark, directly or by a claim, so the cap may refuse
	 * it. The owner path step and jobs only follow earlier changes and never refuse.
	 */
	ownWrite: boolean;
	/**
	 * Where a written private node was before. Its claim there may end even when it has no place
	 * left to compare (its proposal went first).
	 */
	oldPositions?: Array<Pick<Doc<"files_pending_places">, "parent" | "name">>;
};

type OwnerPathRequest = Scope & { prefix: string; inline: boolean };

type TargetsJobItem = Extract<Doc<"files_pending_overlay_jobs">, { kind: "targets" }>["items"][number];

type JobInput =
	| { kind: "saved_node"; savedNodeId: Id<"files_nodes"> }
	| { kind: "parent"; parent: files_PendingParent }
	| { kind: "owner_path"; userId: Id<"users">; prefix: string }
	| { kind: "repair_user"; userId: Id<"users"> }
	| { kind: "place_fields"; placeIds: Id<"files_pending_places">[] }
	| { kind: "targets"; userId: Id<"users">; items: TargetsJobItem[] };

/**
 * A saved-place pass keeps its creation-time bound and page while later writes ask for another pass.
 */
export type files_pending_overlay_SavedPlacesCursor = {
	page: string | null;
	through: number;
	isDone?: boolean;
	place?: {
		id: Id<"files_pending_places">;
		phase: "clear" | "build" | "cleanup";
		page: string | null;
		refreshId: string;
		fieldsVersion: number;
		metadataRevision: number;
	};
	rerun?: boolean;
	rerunFieldsChanged?: boolean;
};

type Reader = ReturnType<typeof files_visible_resolve_db_create>;

/**
 * The job this mutation runs, and how far its pass got. The job updates it as it marks docs.
 */
type OwnJob = {
	doc: Doc<"files_pending_overlay_jobs">;
	/**
	 * The stream the job walks now.
	 */
	phase: number;
	/**
	 * Owner path job: the `ownerTreePath` of the last place it marked in the prefix stream.
	 */
	lastPath: string | null;
	/**
	 * A flush asked for this same job again: it walks once more when this pass ends.
	 */
	rerun: boolean;
};

/**
 * What one wrapped mutation records for its flush: the source fields it saw and what to recompute.
 */
type FlushMarks = {
	resolverPaginationUsed: boolean;
	materializingCohortId: Id<"files_move_cohorts"> | null;
	stagingCohortId: Id<"files_move_cohorts"> | null;
	allocatingPrivateSource:
		| (Omit<Scope, "userId"> & {
				cohortId: Id<"files_move_cohorts">;
				privateNodeId: Id<"files_pending_nodes">;
		  })
		| null;
	factScopes: Map<string, Omit<Scope, "userId">>;
	factScopesChanged: Set<string>;
	/**
	 * The last known source fields of each source doc, for the whole mutation.
	 */
	lastKnown: Map<string, SourceFields>;
	/**
	 * Saved nodes at the start of the round: null for a node inserted in the round.
	 */
	savedOld: Map<Id<"files_nodes">, Promise<SourceFields | null>>;
	/**
	 * Old doc reads in flight, so a second write of the same id in `Promise.all` waits for the first.
	 */
	oldReads: Map<string, Promise<SourceFields | null>>;
	targets: Map<string, TargetMark>;
	/**
	 * Targets whose recompute goes to their owner's targets job, by owner.
	 */
	deferred: Map<string, Scope & { items: TargetsJobItem[] }>;
	/**
	 * One reader per user. A job keeps them across its flushes; other mutations start each flush fresh.
	 */
	readers: Map<string, Reader>;
	/**
	 * Written proposals and metadata docs with no known owner. The flush reads them.
	 */
	unknownProposalIds: Set<Id<"files_pending_updates">>;
	unknownMetadataIds: Set<Id<"files_metadata_docs">>;
	/**
	 * Saved nodes whose committed metadata changed.
	 */
	committedMetadataNodeIds: Set<Id<"files_nodes">>;
	/**
	 * Metadata catalog row changes of the writes since the last flush. Every flush inserts them as
	 * deltas and clears them (`server/files-metadata-catalog.ts`).
	 */
	catalogChanges: files_metadata_catalog_Changes;
	/**
	 * Written file grants. The flush syncs their share rows.
	 */
	grantIds: Set<Id<"access_control_permission_grants">>;
	ownerPathRequests: OwnerPathRequest[];
	/**
	 * Places whose fields the place fields job syncs, with their workspace.
	 */
	placeFieldIds: Map<Id<"files_pending_places">, Omit<Scope, "userId">>;
	/**
	 * Jobs scheduled in this transaction, by kind and key.
	 */
	scheduledJobs: Set<string>;
	/**
	 * Owner path prefixes the inline step walked in this flush, by user.
	 */
	walkedPrefixes: Set<string>;
	inlineStep: { places: number; ranges: number };
	/**
	 * False in the Discard unit: its size must not depend on the owner's other drafts.
	 */
	inlineOwnerPaths: boolean;
	/**
	 * The review user. Their marks stay inline when other users' drafts change too.
	 */
	actingUserId: Id<"users"> | null;
	/**
	 * The job this mutation runs. A job never schedules its own doc again.
	 */
	ownJob: OwnJob | null;
};

const FLUSH_MARKS = Symbol("files_pending_overlay");

type WrappedCtx = { [FLUSH_MARKS]?: FlushMarks };

function pick_source_fields(table: string, doc: SourceFields) {
	const fields: SourceFields = {};
	for (const field of SOURCE_FIELDS[table]!) fields[field] = doc[field];
	return fields;
}

function target_key(userId: Id<"users">, target: files_PendingTarget) {
	return `${userId}:${target.kind}:${target.id}`;
}

function scope_key(scope: Scope) {
	return `${scope.organizationId}:${scope.workspaceId}:${scope.userId}`;
}

function job_key(scope: Omit<Scope, "userId">, input: JobInput) {
	switch (input.kind) {
		case "saved_node":
			return input.savedNodeId;
		case "parent":
			return `${scope.organizationId}:${scope.workspaceId}:${input.parent.kind}:${input.parent.kind === "root" ? "root" : input.parent.id}`;
		case "owner_path":
			return `${scope_key({ ...scope, userId: input.userId })}:${input.prefix}`;
		case "place_fields":
			// Later flushes that start with the same id merge into this doc.
			return input.placeIds[0]!;
		case "targets":
		case "repair_user":
			return scope_key({ ...scope, userId: input.userId });
	}
}

/**
 * The id list of a list job (place fields, targets), or null for a paged job.
 */
function job_list(job: JobInput | Doc<"files_pending_overlay_jobs">) {
	return job.kind === "place_fields" ? job.placeIds : job.kind === "targets" ? job.items : null;
}

function same_value(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	const aKeys = Object.keys(a).filter((key) => (a as SourceFields)[key] !== undefined);
	const bKeys = Object.keys(b).filter((key) => (b as SourceFields)[key] !== undefined);
	return (
		aKeys.length === bKeys.length &&
		aKeys.every((key) => same_value((a as SourceFields)[key], (b as SourceFields)[key]))
	);
}

/**
 * The fields of `desired` that differ from `doc`.
 */
function changed_fields(doc: SourceFields, desired: SourceFields) {
	const patch: SourceFields = {};
	for (const [field, value] of Object.entries(desired)) if (!same_value(doc[field], value)) patch[field] = value;
	return patch;
}

/**
 * Write a derived doc only when it differs.
 */
async function db_sync_doc<T extends "files_pending_hides" | "files_pending_list_keys" | "files_pending_type_entries">(
	db: MutationCtx["db"],
	table: T,
	doc: Doc<T> | null,
	desired: WithoutSystemFields<Doc<T>> | null,
) {
	if (!desired) {
		if (doc) await db.delete(table, doc._id);
		return;
	}
	if (!doc) {
		await db.insert(table, desired);
		return;
	}
	const patch = changed_fields(doc, desired);
	if (Object.keys(patch).length > 0) await db.patch(table, doc._id, patch as Partial<Doc<T>>);
}

// #region capture

function new_state(): FlushMarks {
	return {
		materializingCohortId: null,
		resolverPaginationUsed: false,
		stagingCohortId: null,
		allocatingPrivateSource: null,
		factScopes: new Map(),
		factScopesChanged: new Set(),
		lastKnown: new Map(),
		savedOld: new Map(),
		oldReads: new Map(),
		targets: new Map(),
		deferred: new Map(),
		readers: new Map(),
		unknownProposalIds: new Set(),
		unknownMetadataIds: new Set(),
		committedMetadataNodeIds: new Set(),
		catalogChanges: new Map(),
		grantIds: new Set(),
		ownerPathRequests: [],
		placeFieldIds: new Map(),
		scheduledJobs: new Set(),
		walkedPrefixes: new Set(),
		inlineStep: { places: 0, ranges: 0 },
		inlineOwnerPaths: true,
		actingUserId: null,
		ownJob: null,
	};
}

function mark_target(
	state: FlushMarks,
	args: Scope & {
		target: files_PendingTarget;
		pendingUpdateId?: Id<"files_pending_updates">;
		fieldsChanged?: boolean;
		ownerPathPending?: boolean;
		inline: boolean;
		ownWrite?: boolean;
		oldPosition?: Pick<Doc<"files_pending_places">, "parent" | "name">;
	},
) {
	const key = target_key(args.userId, args.target);
	let mark = state.targets.get(key);
	if (!mark) {
		mark = {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			target: args.target,
			pendingUpdateIds: new Set(),
			fieldsChanged: false,
			inline: false,
			ownWrite: false,
		};
		state.targets.set(key, mark);
	}
	if (args.pendingUpdateId) mark.pendingUpdateIds.add(args.pendingUpdateId);
	if (args.oldPosition) (mark.oldPositions ??= []).push(args.oldPosition);
	mark.fieldsChanged ||= args.fieldsChanged === true;
	mark.ownerPathPending ||= args.ownerPathPending;
	mark.inline ||= args.inline;
	mark.ownWrite ||= args.ownWrite === true;
}

/**
 * Send one target's recompute to its owner's targets job instead of this transaction.
 */
function defer_target(
	state: FlushMarks,
	mark: Pick<TargetMark, keyof Scope | "target" | "pendingUpdateIds" | "fieldsChanged" | "ownerPathPending">,
) {
	const key = scope_key(mark);
	const group = state.deferred.get(key) ?? {
		organizationId: mark.organizationId,
		workspaceId: mark.workspaceId,
		userId: mark.userId,
		items: [],
	};
	const pendingUpdateIds = mark.pendingUpdateIds.size > 0 ? [...mark.pendingUpdateIds] : [null];
	for (const pendingUpdateId of pendingUpdateIds)
		group.items.push({
			target: mark.target,
			pendingUpdateId,
			fieldsChanged: mark.fieldsChanged,
			ownerPathPending: mark.ownerPathPending,
		});
	state.deferred.set(key, group);
}

/**
 * Send this mutation's owner path work to jobs only (the Discard unit).
 */
export function files_pending_overlay_db_skip_inline_owner_paths(ctx: MutationCtx) {
	const state = (ctx as WrappedCtx)[FLUSH_MARKS];
	if (state) state.inlineOwnerPaths = false;
}

/**
 * Name the review user in this mutation, so their own derived docs stay exact at once
 * while other users' changes go to jobs.
 */
export function files_pending_overlay_db_set_acting_user(ctx: MutationCtx, userId: Id<"users">) {
	const state = (ctx as WrappedCtx)[FLUSH_MARKS];
	if (state) state.actingUserId = userId;
}

/**
 * The finalizer staged every owner doc before it writes reserved source headers.
 */
export async function files_pending_overlay_db_set_cohort_materialization(
	ctx: MutationCtx,
	args: { cohortId: Id<"files_move_cohorts">; fence: number; attemptFence: number; mode: "finish" | "abort" },
) {
	const entered = await files_move_reservations_db_enter(ctx, args);
	if (entered._nay) return entered;
	const state = (ctx as WrappedCtx)[FLUSH_MARKS];
	if (!state) throw should_never_happen("Cohort materialization needs a wrapped mutation", args);
	state.materializingCohortId = args.cohortId;
	return Result({ _yay: null });
}

/**
 * A reserved source marker does not change any normal overlay header.
 */
export async function files_pending_overlay_db_set_cohort_staging(
	ctx: MutationCtx,
	args: { cohortId: Id<"files_move_cohorts">; fence: number; attemptFence: number },
) {
	const entered = await files_move_reservations_db_enter(ctx, { ...args, mode: "stage" });
	if (entered._nay) return entered;
	const state = (ctx as WrappedCtx)[FLUSH_MARKS];
	if (!state) throw should_never_happen("Cohort staging needs a wrapped mutation", args);
	state.stagingCohortId = args.cohortId;
	return Result({ _yay: null });
}

/**
 * One reserved private output stays outside normal saved serving until publication.
 */
export async function files_pending_overlay_db_set_cohort_allocation(
	ctx: MutationCtx,
	args: {
		cohortId: Id<"files_move_cohorts">;
		fence: number;
		attemptFence: number;
		privateNodeId: Id<"files_pending_nodes">;
	},
) {
	const entered = await files_move_reservations_db_enter(ctx, { ...args, mode: "stage" });
	if (entered._nay) return entered;
	const cohort = await ctx.db.get("files_move_cohorts", args.cohortId);
	const node = await ctx.db.get("files_pending_nodes", args.privateNodeId);
	const reservation = await ctx.db
		.query("files_move_source_reservations")
		.withIndex("by_source", (q) => q.eq("source.kind", "private").eq("source.id", args.privateNodeId))
		.unique();
	if (
		!cohort ||
		cohort.phase !== "staging" ||
		node?.state !== "active" ||
		node.organizationId !== cohort.organizationId ||
		node.workspaceId !== cohort.workspaceId ||
		reservation?.cohortId !== cohort._id
	)
		return Result({ _nay: { name: "stopped", message: "This private output is no longer reserved." } });
	const state = (ctx as WrappedCtx)[FLUSH_MARKS];
	if (!state) throw should_never_happen("Cohort allocation needs a wrapped mutation", args);
	state.allocatingPrivateSource = {
		cohortId: args.cohortId,
		privateNodeId: args.privateNodeId,
		organizationId: cohort.organizationId,
		workspaceId: cohort.workspaceId,
	};
	return Result({ _yay: null });
}

/**
 * Tell the flushes of this mutation which job it runs, so they never schedule that job again. The
 * job keeps the returned progress up to date.
 */
export function files_pending_overlay_db_set_own_job(ctx: MutationCtx, job: Doc<"files_pending_overlay_jobs">) {
	const own: OwnJob = { doc: job, phase: 0, lastPath: null, rerun: false };
	const state = (ctx as WrappedCtx)[FLUSH_MARKS];
	if (state) state.ownJob = own;
	return own;
}

/**
 * Mark one target of one user dirty, so the next flush recomputes its derived docs. Jobs and the
 * repair use it; source writes mark targets by themselves.
 */
export function files_pending_overlay_db_mark_target(
	ctx: MutationCtx,
	args: Scope & {
		target: files_PendingTarget;
		pendingUpdateId?: Id<"files_pending_updates">;
		fieldsChanged?: boolean;
		ownerPathPending?: boolean;
	},
) {
	const state = (ctx as WrappedCtx)[FLUSH_MARKS];
	if (!state) throw should_never_happen("Overlay mark outside the mutation wrapper", { target: args.target });
	mark_target(state, { ...args, inline: false });
}

/**
 * Record what a proposal, private node, receipt or metadata write changes. `old` is the doc before
 * the write (null for an insert) and `next` the doc after (null for a delete).
 */
function mark_source_write(
	state: FlushMarks,
	table: string,
	id: string,
	old: SourceFields | null,
	next: SourceFields | null,
) {
	const doc = next ?? old;
	if (!doc) return;
	const scope = { organizationId: doc.organizationId, workspaceId: doc.workspaceId, userId: doc.userId };
	if (table !== "files_metadata_docs")
		state.factScopes.set(`${scope.organizationId}:${scope.workspaceId}`, {
			organizationId: scope.organizationId,
			workspaceId: scope.workspaceId,
		});

	if (table === "files_pending_updates") {
		mark_target(state, {
			...scope,
			target: doc.target,
			pendingUpdateId: id as Id<"files_pending_updates">,
			inline: true,
			ownWrite: true,
		});
		return;
	}

	if (table === "files_pending_nodes") {
		const moved =
			old && (!next || old.state !== next.state || old.name !== next.name || !same_value(old.parent, next.parent));
		mark_target(state, {
			...scope,
			target: { kind: "private", id: id as Id<"files_pending_nodes"> },
			inline: true,
			ownWrite: true,
			oldPosition: moved ? { parent: old.parent, name: old.name } : undefined,
		});
		// A private folder is listed only while it has no active child, so its parent folder's
		// proposal changes when a child opens, closes or moves.
		if (!old || !next || old.state !== next.state || !same_value(old.parent, next.parent))
			for (const parent of [old?.parent, next?.parent] as Array<files_PendingParent | undefined>)
				if (parent?.kind === "private") mark_target(state, { ...scope, target: parent, inline: true });
		return;
	}

	if (table === "files_pending_node_publish_receipts") {
		if (old) return;
		// The folder rule then moves its children's places: they all sit under its old owner path.
		mark_target(state, { ...scope, target: { kind: "private", id: doc.privateNodeId }, inline: true });
		return;
	}

	// `files_metadata_docs`
	if (doc.sourceKind === "pending")
		mark_target(state, {
			...scope,
			target: doc.target,
			pendingUpdateId: doc.pendingUpdateId,
			fieldsChanged: true,
			inline: true,
			ownWrite: true,
		});
	else state.committedMetadataNodeIds.add(doc.fileNodeId);
}

function wrap_query<T extends object>(state: FlushMarks, table: string, source: T): T {
	return new Proxy(source, {
		get(target, property) {
			const method = Reflect.get(target, property) as unknown;
			if (typeof method !== "function") return method;
			const remember = (doc: SourceFields | null) => {
				if (doc) state.lastKnown.set(doc._id, pick_source_fields(table, doc));
			};

			if (property === Symbol.asyncIterator)
				return async function* () {
					for await (const doc of target as AsyncIterable<SourceFields>) {
						remember(doc);
						yield doc;
					}
				};
			if (property === "collect" || property === "take")
				return async (...args: unknown[]) => {
					const docs = (await Reflect.apply(method, target, args)) as SourceFields[];
					for (const doc of docs) remember(doc);
					return docs;
				};
			if (property === "first" || property === "unique")
				return async () => {
					const doc = (await Reflect.apply(method, target, [])) as SourceFields | null;
					remember(doc);
					return doc;
				};
			if (property === "paginate")
				return async (...args: unknown[]) => {
					const result = (await Reflect.apply(method, target, args)) as { page: SourceFields[] };
					for (const doc of result.page) remember(doc);
					return result;
				};
			return (...args: unknown[]) => wrap_query(state, table, Reflect.apply(method, target, args) as object);
		},
	});
}

/**
 * Wrap `ctx.db` so every write to a source table marks what the flush must recompute. Writes to
 * other tables pass through untouched. Use the result as the mutation's ctx fields.
 */
export function files_pending_overlay_db_wrap(ctx: MutationCtx) {
	const state = new_state();
	const raw = ctx.db;
	const is_materializing = async (table: string, id: string, value: SourceFields | null) => {
		if (!state.materializingCohortId) return false;
		const source: Doc<"files_move_source_reservations">["source"] | null =
			table === "files_nodes"
				? { kind: "saved", id: id as Id<"files_nodes"> }
				: table === "files_pending_nodes"
					? { kind: "private", id: id as Id<"files_pending_nodes"> }
					: table === "files_pending_updates"
						? { kind: "proposal", id: id as Id<"files_pending_updates"> }
						: table === "files_pending_node_publish_receipts"
							? { kind: "receipt", id: id as Id<"files_pending_node_publish_receipts"> }
							: value?.fileNodeId
								? { kind: "saved" as const, id: value.fileNodeId }
								: value?.pendingUpdateId
									? { kind: "proposal" as const, id: value.pendingUpdateId }
									: null;
		if (!source) return false;
		const reservation = await files_move_reservations_db_get_source(raw, source);
		return reservation?.cohortId === state.materializingCohortId;
	};

	const read_old = async (table: string, id: string) => {
		const known = state.lastKnown.get(id);
		if (known) {
			if (known.organizationId && known.workspaceId)
				files_move_reservations_db_note_source(raw, {
					table: table as TableNames,
					id,
					old: known as Pick<Doc<"files_nodes">, "organizationId" | "workspaceId">,
				});
			return known;
		}
		// A second write of the same id in `Promise.all` waits for this read, like `savedOld`.
		let read = state.oldReads.get(id);
		if (!read) {
			read = raw.get(table as TableNames, id as Id<TableNames>).then((doc) => {
				state.oldReads.delete(id);
				return doc && pick_source_fields(table, doc as SourceFields);
			});
			state.oldReads.set(id, read);
		}
		const old = await read;
		if (old?.organizationId && old.workspaceId)
			files_move_reservations_db_note_source(raw, {
				table: table as TableNames,
				id,
				old: old as Pick<Doc<"files_nodes">, "organizationId" | "workspaceId">,
			});
		return old;
	};

	// An id-only write gives no table name, so it cannot be captured.
	const refuse_id_only = (id: unknown) => {
		for (const table of SOURCE_TABLES)
			if (raw.normalizeId(table as TableNames, id as string))
				throw should_never_happen("Write to a source table without a table name", { table, id });
	};

	const db = new Proxy(raw, {
		get(target, property) {
			if (property === "get")
				return async (...args: unknown[]) => {
					const doc = (
						args.length === 2
							? await target.get(args[0] as TableNames, args[1] as Id<TableNames>)
							: await target.get(args[0] as Id<TableNames>)
					) as SourceFields | null;
					if (args.length === 2 && SOURCE_TABLES.has(args[0] as string) && doc)
						state.lastKnown.set(doc._id, pick_source_fields(args[0] as string, doc));
					return doc;
				};

			if (property === "query")
				return (table: TableNames) => {
					const query = target.query(table);
					return SOURCE_TABLES.has(table) ? wrap_query(state, table, query) : query;
				};

			if (property === "insert")
				return async (table: TableNames, value: SourceFields) => {
					const id = await target.insert(table, value as never);
					// The catalog counts tagged Move docs too, in their own view.
					if (table === "files_metadata_docs") {
						const next = pick_source_fields(table, value);
						state.lastKnown.set(id, next);
						files_metadata_catalog_add_write(state.catalogChanges, null, next);
					}
					// Tagged source docs belong to preparation, not the live normal overlay.
					if (value.moveView) return id;
					if (
						table === "files_nodes" &&
						state.stagingCohortId &&
						state.stagingCohortId === value.moveCohortId &&
						(await files_move_reservations_db_is_rename_allocation(raw, {
							cohortId: state.stagingCohortId,
							node: value as WithoutSystemFields<Doc<"files_nodes">>,
						}))
					)
						return id;
					if (
						table === "files_nodes" &&
						state.allocatingPrivateSource &&
						state.allocatingPrivateSource.cohortId === value.moveCohortId &&
						state.allocatingPrivateSource.privateNodeId === value.publishedFromPrivateNodeId &&
						state.allocatingPrivateSource.organizationId === value.organizationId &&
						state.allocatingPrivateSource.workspaceId === value.workspaceId
					) {
						state.allocatingPrivateSource = null;
						return id;
					}
					if (SOURCE_TABLES.has(table)) {
						const next = pick_source_fields(table, value);
						state.lastKnown.set(id, next);
						if (table === "files_nodes") {
							if (!state.savedOld.has(id as Id<"files_nodes">))
								state.savedOld.set(id as Id<"files_nodes">, Promise.resolve(null));
						} else if (table === "access_control_permission_grants") {
							if (next.resourceKind === "file") state.grantIds.add(id as Id<"access_control_permission_grants">);
						} else mark_source_write(state, table, id, null, next);
					}
					return id;
				};

			if (property === "patch" || property === "replace" || property === "delete")
				return async (...args: unknown[]) => {
					const write = Reflect.get(target, property) as (...args: unknown[]) => Promise<void>;
					// `delete(table, id)` and `patch(table, id, value)` name the table first.
					const tableFirst = args.length === (property === "delete" ? 2 : 3);
					if (!tableFirst) {
						refuse_id_only(args[0]);
						return await Reflect.apply(write, target, args);
					}
					const table = args[0] as string;
					const id = args[1] as string;
					const value = (property === "delete" ? null : args[2]) as SourceFields | null;
					if (property === "delete") {
						const owner =
							table === "files_nodes"
								? { kind: "saved" as const, id: id as Id<"files_nodes"> }
								: table === "files_pending_updates"
									? { kind: "pending" as const, id: id as Id<"files_pending_updates"> }
									: table === "files_transfer_items"
										? { kind: "capture" as const, id: id as Id<"files_transfer_items"> }
										: null;
						if (owner) await files_metadata_maps_db_delete(raw, owner);
					}
					const knownScope = state.lastKnown.get(id);
					if (knownScope?.organizationId && knownScope.workspaceId)
						files_move_reservations_db_note_source(raw, {
							table: table as TableNames,
							id,
							old: knownScope as Pick<Doc<"files_nodes">, "organizationId" | "workspaceId">,
						});
					if (!SOURCE_TABLES.has(table)) return await Reflect.apply(write, target, args);

					// The catalog counts every metadata doc write, also the tagged Move and materializing
					// writes that change no normal overlay doc, so metadata docs take this branch first.
					if (table === "files_metadata_docs") {
						const valueChanged = property !== "patch" || METADATA_VALUE_FIELDS.some((field) => field in value!);
						const overlay =
							!value?.moveView &&
							!(
								state.materializingCohortId && (await is_materializing(table, id, value ?? (await read_old(table, id))))
							);
						// A patch of no catalog field needs no old doc. The flush reads the doc for its owner.
						if (
							property === "patch" &&
							!state.lastKnown.has(id) &&
							!files_metadata_catalog_SOURCE_FIELDS.some((field) => field in value!)
						) {
							await Reflect.apply(write, target, args);
							if (overlay && valueChanged) state.unknownMetadataIds.add(id as Id<"files_metadata_docs">);
							return;
						}
						const old = await read_old(table, id);
						await Reflect.apply(write, target, args);
						// A same-id write in `Promise.all` may have ended first: build on its doc.
						const known = state.lastKnown.get(id) ?? old;
						const next =
							property === "delete"
								? null
								: pick_source_fields(table, property === "replace" ? value! : { ...known, ...value });
						if (next) state.lastKnown.set(id, next);
						else state.lastKnown.delete(id);
						files_metadata_catalog_add_write(state.catalogChanges, known, next);
						if (overlay && valueChanged) mark_source_write(state, table, id, old, next);
						return;
					}

					if (value?.moveView) return await Reflect.apply(write, target, args);
					if (
						property === "patch" &&
						state.stagingCohortId &&
						value?.moveCohortId === state.stagingCohortId &&
						Object.keys(value).length === 1 &&
						(table === "files_nodes" || table === "files_pending_updates")
					) {
						const reservation = await raw
							.query("files_move_source_reservations")
							.withIndex("by_source", (q) =>
								q
									.eq("source.kind", table === "files_nodes" ? "saved" : "proposal")
									.eq("source.id", id as Id<"files_nodes"> | Id<"files_pending_updates">),
							)
							.unique();
						if (reservation?.cohortId === state.stagingCohortId) return await Reflect.apply(write, target, args);
					}
					if (
						state.materializingCohortId &&
						(await is_materializing(table, id, value ?? (await read_old(table, id))))
					) {
						await Reflect.apply(write, target, args);
						return;
					}

					if (table === "files_nodes") {
						const ancestorFields = Object.keys(value ?? {}).filter(files_is_ancestor_field);
						if (property === "patch" && ancestorFields.length > 0) {
							if (ancestorFields.length !== Object.keys(value!).length)
								throw should_never_happen("A files_nodes patch mixes ancestor fields with other fields", { id });
							// Ancestor copies change no derived doc. The caches keep no ancestor field, so they
							// stay true too.
							return await Reflect.apply(write, target, args);
						}
						const nodeId = id as Id<"files_nodes">;
						// A second write of the same id waits for the first one's old doc read.
						if (!state.savedOld.has(nodeId)) state.savedOld.set(nodeId, read_old(table, id));
						const old = await state.savedOld.get(nodeId)!;
						await Reflect.apply(write, target, args);
						const known = state.lastKnown.get(id) ?? old;
						if (property === "delete") state.lastKnown.delete(id);
						else if (property === "replace") state.lastKnown.set(id, pick_source_fields(table, value!));
						else if (known) state.lastKnown.set(id, pick_source_fields(table, { ...known, ...value }));
						return;
					}

					// Most grant writers query the grant first, so its kind is known and a grant that is not
					// a file grant costs no read here.
					if (table === "access_control_permission_grants") {
						const old = await read_old(table, id);
						await Reflect.apply(write, target, args);
						const known = state.lastKnown.get(id) ?? old;
						const next =
							property === "delete"
								? null
								: pick_source_fields(table, property === "replace" ? value! : { ...known, ...value });
						if (next) state.lastKnown.set(id, next);
						else state.lastKnown.delete(id);
						if (old?.resourceKind === "file" || next?.resourceKind === "file")
							state.grantIds.add(id as Id<"access_control_permission_grants">);
						return;
					}

					// A proposal patch keeps its owner and target, and the doc is still there at flush time.
					// So it needs no old doc. A private node patch does: its old parent and state matter.
					const valueChanged =
						property !== "patch" ||
						table !== "files_pending_updates" ||
						PROPOSAL_FIELDS.some((field) => field in value!);
					if (property === "patch" && !state.lastKnown.has(id) && table !== "files_pending_nodes") {
						await Reflect.apply(write, target, args);
						if (table === "files_pending_updates" && valueChanged)
							state.unknownProposalIds.add(id as Id<"files_pending_updates">);
						return;
					}
					const old = await read_old(table, id);
					await Reflect.apply(write, target, args);
					// A same-id write in `Promise.all` may have ended first: build on its doc.
					const known = state.lastKnown.get(id) ?? old;
					const next =
						property === "delete"
							? null
							: pick_source_fields(table, property === "replace" ? value! : { ...known, ...value });
					if (next) state.lastKnown.set(id, next);
					else state.lastKnown.delete(id);
					if (valueChanged) mark_source_write(state, table, id, old, next);
				};

			const value = Reflect.get(target, property) as unknown;
			return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
		},
	});

	return { db, [FLUSH_MARKS]: state };
}

// #endregion capture

// #region recompute

/**
 * One user's reader for the flush. `includeHidden` gives paths of hidden targets too, so a place
 * keeps its destination while the owner does not see it.
 * Fixed After is used only by owner staging, after all saved headers are sealed.
 */
export function files_pending_overlay_db_create_reader(
	db: QueryCtx["db"],
	scope: Scope & { fixedView?: files_saved_placement_FixedView },
) {
	return files_visible_resolve_db_create(db, {
		...scope,
		readLimit: TRANSACTION_RANGES,
		includeHidden: true,
		stagedPrivateParents: scope.fixedView?.view === "after",
	});
}

/**
 * Save only unfinished target work. A source change clears old work before starting again.
 */
export async function files_pending_overlay_db_resolve_facts(
	ctx: MutationCtx,
	args: Scope & {
		target: files_PendingTarget;
		fixedView?: files_saved_placement_FixedView;
		allowPagination: boolean;
		reader?: Reader;
	},
): Promise<{ facts: files_visible_resolve_Facts | null; parentPage: boolean }> {
	const scope = { organizationId: args.organizationId, workspaceId: args.workspaceId, userId: args.userId };
	const by_key = (key: string) =>
		ctx.db
			.query("files_pending_overlay_resolve_work")
			.withIndex("by_target_user_key", (q) =>
				q
					.eq("target.kind", args.target.kind)
					.eq("target.id", args.target.id)
					.eq("userId", args.userId)
					.eq("moveView.cohortId", args.fixedView?.cohortId)
					.eq("moveView.view", args.fixedView?.view)
					.eq("key", key),
			);
	let stateDoc = await by_key("state").unique();
	let saved = stateDoc ? (JSON.parse(stateDoc.value) as { fence: string; facts?: files_visible_resolve_Facts }) : null;
	// The wrapper updates these source fields after every write in this mutation.
	const privateNode =
		args.target.kind === "private"
			? ((ctx as WrappedCtx)[FLUSH_MARKS]?.lastKnown.get(args.target.id) ??
				(await ctx.db.get("files_pending_nodes", args.target.id)))
			: null;
	// Closed private nodes have no place or type entry. Their old paths need no resolver.
	const closed =
		args.target.kind === "private" &&
		(!privateNode ||
			privateNode.state !== "active" ||
			privateNode.userId !== args.userId ||
			privateNode.organizationId !== args.organizationId ||
			privateNode.workspaceId !== args.workspaceId);
	const emptyFacts: files_visible_resolve_Facts = {
		own: null,
		parent: null,
		savedParent: null,
		claimed: false,
		cycle: false,
	};
	if (!saved && closed) return { facts: emptyFacts, parentPage: false };
	if (!saved && args.reader && !args.reader.exhausted) {
		const facts = await args.reader.resolveFacts(args.target, async () => {
			// Keep room to save unfinished work and its counted follow-up job.
			const metrics = await ctx.meta.getTransactionMetrics();
			return Object.values(metrics).every((metric) => metric.used * 4 < (metric.used + metric.remaining) * 3);
		});
		if (facts && !args.reader.exhausted) return { facts, parentPage: false };
	}
	const state = await files_pending_review_facts_db_pin_structure(ctx.db, scope);
	const view = await files_saved_placement_db_get_view(ctx.db, scope);
	const fence = JSON.stringify([state.structureRevision, args.fixedView ?? view]);
	const write_state = async (facts?: files_visible_resolve_Facts) => {
		const value = JSON.stringify({ fence, facts });
		if (stateDoc) await ctx.db.patch("files_pending_overlay_resolve_work", stateDoc._id, { value });
		else {
			const id = await ctx.db.insert("files_pending_overlay_resolve_work", {
				...scope,
				target: args.target,
				moveView: args.fixedView,
				key: "state",
				value,
			});
			stateDoc = (await ctx.db.get("files_pending_overlay_resolve_work", id))!;
		}
	};
	const clear = async () => {
		const docs = await ctx.db
			.query("files_pending_overlay_resolve_work")
			.withIndex("by_target_user_key", (q) =>
				q
					.eq("target.kind", args.target.kind)
					.eq("target.id", args.target.id)
					.eq("userId", args.userId)
					.eq("moveView.cohortId", args.fixedView?.cohortId)
					.eq("moveView.view", args.fixedView?.view)
					.gte("key", "m:")
					.lt("key", "m;"),
			)
			.take(64);
		for (const doc of docs) await ctx.db.delete("files_pending_overlay_resolve_work", doc._id);
		return docs.length < 64;
	};
	if (saved && (closed || saved.fence !== fence || saved.facts)) {
		if (!(await clear())) return { facts: null, parentPage: false };
		await ctx.db.delete("files_pending_overlay_resolve_work", stateDoc!._id);
		stateDoc = null;
		if (closed) return { facts: emptyFacts, parentPage: false };
		if (saved.fence === fence && saved.facts) return { facts: saved.facts, parentPage: false };
		saved = null;
	}
	const docs = new Map<string, Doc<"files_pending_overlay_resolve_work"> | null>();
	const writes = new Map<string, string | null>();
	const read = async (key: string) => {
		if (docs.has(key)) return docs.get(key)!;
		const doc = saved ? await by_key(`m:${key}`).unique() : null;
		docs.set(key, doc);
		return doc;
	};
	const reader = files_visible_resolve_db_create(ctx.db, {
		...scope,
		fixedView: args.fixedView,
		includeHidden: true,
		stagedPrivateParents: args.fixedView?.view === "after",
		readLimit: 128,
		resume: {
			fence,
			store: {
				get: async (key) => (writes.has(key) ? writes.get(key)! : ((await read(key))?.value ?? null)),
				set: async (key, value) => {
					writes.set(key, value);
				},
				delete: async (key) => {
					writes.set(key, null);
				},
			},
		},
	});
	const remaining = (await ctx.meta.getTransactionMetrics()).databaseQueries.remaining;
	const marks = (ctx as WrappedCtx)[FLUSH_MARKS];
	const allowPagination = args.allowPagination && !marks?.resolverPaginationUsed;
	const result = await reader.resume(
		{ kind: "facts", target: args.target },
		{
			stepLimit: Math.min(saved ? 32 : 256, Math.max(0, remaining - JOB_READER_MARGIN)),
			allowPagination,
		},
	);
	if (result.status === "invalidated") throw should_never_happen("Overlay resolver fence differs from its state", args);
	const parentPage = result.paginated;
	if (parentPage && marks) marks.resolverPaginationUsed = true;
	if (result.status !== "unfinished") {
		if (!saved) return { facts: result.value, parentPage };
		await write_state(result.value);
		if (!(await clear())) return { facts: null, parentPage };
		await ctx.db.delete("files_pending_overlay_resolve_work", stateDoc!._id);
		return { facts: result.value, parentPage };
	}
	for (const [key, value] of writes) {
		const doc = await read(key);
		if (value === null) {
			if (doc) await ctx.db.delete("files_pending_overlay_resolve_work", doc._id);
		} else if (doc) await ctx.db.patch("files_pending_overlay_resolve_work", doc._id, { value });
		else
			await ctx.db.insert("files_pending_overlay_resolve_work", {
				...scope,
				target: args.target,
				moveView: args.fixedView,
				key: `m:${key}`,
				value,
			});
	}
	await write_state();
	return { facts: null, parentPage };
}

/**
 * A published private parent becomes its saved folder (receipt), like the reader resolves it.
 */
async function db_place_parent(
	db: QueryCtx["db"],
	scope: Scope,
	parent: files_PendingParent,
	fixedView?: files_saved_placement_FixedView,
	currentView?: files_saved_placement_View,
): Promise<files_PendingParent> {
	if (parent.kind !== "private") return parent;
	const receipt = await files_saved_placement_db_get_publish_receipt(
		db,
		{ ...scope, privateNodeId: parent.id },
		fixedView,
		currentView,
	);
	// Only the owner's own receipt in this workspace, like the reader.
	return receipt?.userId === scope.userId &&
		receipt.organizationId === scope.organizationId &&
		receipt.workspaceId === scope.workspaceId
		? { kind: "saved", id: receipt.savedNodeId }
		: parent;
}

/**
 * Decide whether the Pending list draws this proposal as its own row. The flush writes the list rows
 * from this check, and the list query and every pending count read those rows.
 */
export async function files_pending_overlay_db_pending_update_is_listed(args: {
	ctx: Pick<QueryCtx, "db">;
	pendingUpdate: Doc<"files_pending_updates">;
}) {
	const { ctx, pendingUpdate } = args;

	if (pendingUpdate.target.kind === "saved") return true;
	const privateNodeId = pendingUpdate.target.id;

	// A discarded or saved private draft waits for cleanup. It is no longer a change.
	if ((await ctx.db.get("files_pending_nodes", privateNodeId))?.state !== "active") return false;
	if (pendingUpdate.createIntent?.kind !== "folder") return true;

	// A folder draft that holds an active draft is not a change of its own, like Git: saving the
	// draft inside creates the folder too. The folder shows again when its last draft is gone.
	const child = await ctx.db
		.query("files_pending_nodes")
		.withIndex("by_organization_workspace_user_parent_state_name", (q) =>
			q
				.eq("organizationId", pendingUpdate.organizationId)
				.eq("workspaceId", pendingUpdate.workspaceId)
				.eq("userId", pendingUpdate.userId)
				.eq("parent.kind", "private")
				.eq("parent.id", privateNodeId)
				.eq("state", "active"),
		)
		.first();
	return child === null;
}

type DesiredPlace = Omit<WithoutSystemFields<Doc<"files_pending_places">>, "fieldsVersion" | "fieldsRefreshId">;

/**
 * What the derived docs of one user's target should be, from source tables and the reader only.
 * The flush writes it; `check_user` compares it with the stored docs.
 */
export async function files_pending_overlay_db_compute_target(
	db: QueryCtx["db"],
	reader: Reader,
	args: Scope & {
		target: files_PendingTarget;
		pendingUpdate: Doc<"files_pending_updates"> | null;
		facts?: files_visible_resolve_Facts;
	},
) {
	const { target, pendingUpdate } = args;
	const scope = { organizationId: args.organizationId, workspaceId: args.workspaceId, userId: args.userId };
	let hide: WithoutSystemFields<Doc<"files_pending_hides">> | null = null;
	let place: DesiredPlace | null = null;
	let typeEntry: WithoutSystemFields<Doc<"files_pending_type_entries">> | null = null;
	let savedNode: Doc<"files_nodes"> | null = null;

	if (target.kind === "saved") {
		const node = await files_saved_placement_db_get_node(db, target.id, reader.fixedView);
		// A hard deleted target has no derived docs, and needs no reader.
		if (!node || node.organizationId !== args.organizationId || node.workspaceId !== args.workspaceId)
			return { hide, place, typeEntry, listKeys: [], savedNode };
		savedNode = node;

		const own = args.facts
			? args.facts.own
			: pendingUpdate?.pendingMove || pendingUpdate?.pendingReplacement
				? await reader.resolve(target)
				: null;
		const destination = args.facts
			? args.facts.parent
			: pendingUpdate?.pendingMove
				? await reader.resolveParent(pendingUpdate.pendingMove.destParent)
				: null;
		const cycle = args.facts ? args.facts.cycle : reader.isCycleMember(target);
		const moved = destination?.hidden === false && !cycle;
		if (
			node.archiveOperationId === null &&
			(pendingUpdate?.pendingArchive !== undefined ||
				moved ||
				(args.facts ? args.facts.claimed : await reader.isClaimed(node)))
		)
			hide = {
				...scope,
				savedNodeId: node._id,
				parentId: node.parentId,
				kind: node.kind,
				name: node.name,
				lowercaseExtension: node.lowercaseExtension,
				treePath: node.treePath,
			};

		if (pendingUpdate?.pendingMove) {
			const { destParent, destName } = pendingUpdate.pendingMove;
			// A move cycle or a missing destination has no path. The saved path is a placeholder.
			const pathless = !destination || cycle;
			place = {
				...scope,
				target,
				pendingUpdateId: pendingUpdate._id,
				parent: await db_place_parent(db, scope, destParent, reader.fixedView, await reader.getView()),
				name: destName,
				lowercaseExtension: files_lowercase_extension(destName, node.kind),
				kind: node.kind,
				updatedAt: node.updatedAt,
				isPathless: pathless,
				ownerTreePath: pathless
					? node.treePath
					: files_derive_tree_path_for_file_node(`${destination.path}/${destName}`, node.kind),
				childTreePath:
					node.kind === "folder"
						? own
							? files_derive_tree_path_for_file_node(own.entry.path, "folder")
							: node.treePath
						: null,
				isVisible: !pathless && own !== null && !own.hidden && !destination.hidden,
				accessNodeId: node._id,
				// The destination, then the moves its own path goes through.
				destinationAccessNodeIds: destination
					? [...(destination.accessNode ? [destination.accessNode._id] : []), ...destination.destinationAccessNodeIds]
					: [],
			};
		}
		if (pendingUpdate)
			typeEntry = files_pending_types_compute({
				pendingUpdate,
				node,
				parent: place?.parent ?? (node.parentId === "root" ? { kind: "root" } : { kind: "saved", id: node.parentId }),
				fallbackTreePath: place?.ownerTreePath ?? node.treePath,
				resolved: own,
			});
	} else {
		const node = await db.get("files_pending_nodes", target.id);
		if (
			!pendingUpdate ||
			node?.state !== "active" ||
			node.userId !== args.userId ||
			node.organizationId !== args.organizationId ||
			node.workspaceId !== args.workspaceId
		)
			return { hide, place, typeEntry, listKeys: [], savedNode };
		const parent = args.facts ? args.facts.parent : await reader.resolveParent(node.parent);
		const own = args.facts ? args.facts.own : await reader.resolve(target);
		place = {
			...scope,
			target,
			pendingUpdateId: pendingUpdate._id,
			parent: await db_place_parent(db, scope, node.parent, reader.fixedView, await reader.getView()),
			name: node.name,
			lowercaseExtension: files_lowercase_extension(node.name, node.kind),
			kind: node.kind,
			updatedAt: pendingUpdate.updatedAt,
			isPathless: parent === null,
			ownerTreePath: parent ? files_derive_tree_path_for_file_node(`${parent.path}/${node.name}`, node.kind) : "",
			childTreePath:
				node.kind === "folder" && own ? files_derive_tree_path_for_file_node(own.entry.path, "folder") : null,
			isVisible: parent !== null && own !== null && !own.hidden,
			accessNodeId: parent?.accessNode?._id ?? null,
			// A private node inside a moved saved folder goes through that move.
			destinationAccessNodeIds: parent?.destinationAccessNodeIds ?? [],
		};
		typeEntry = files_pending_types_compute({
			pendingUpdate,
			node,
			parent: place.parent,
			fallbackTreePath: place.ownerTreePath,
			resolved: own,
		});
	}

	if (!args.facts && reader.exhausted)
		throw should_never_happen("Overlay reader ran out of reads", { ...scope, target });

	const listed =
		pendingUpdate !== null && (await files_pending_overlay_db_pending_update_is_listed({ ctx: { db }, pendingUpdate }));
	const listKeys: Array<Doc<"files_pending_list_rows">["listKey"]> = !listed
		? []
		: pendingUpdate.threadIds?.length
			? ["all", ...pendingUpdate.threadIds]
			: ["all", "own"];

	return { hide, place, typeEntry, listKeys, savedNode };
}

async function db_stage_owner(
	ctx: MutationCtx,
	args: {
		cohortId: Id<"files_move_cohorts">;
		fence: number;
		attemptFence: number;
		ownerWorkId: Id<"files_move_owner_work">;
	},
) {
	const cohort = await ctx.db.get("files_move_cohorts", args.cohortId);
	const work = await ctx.db.get("files_move_owner_work", args.ownerWorkId);
	if (
		!cohort ||
		cohort.fence !== args.fence ||
		cohort.attemptFence !== args.attemptFence ||
		cohort.phase !== "staging" ||
		work?.cohortId !== cohort._id
	)
		return Result({ _nay: { name: "stopped", message: "This Move is no longer staging." } });
	return Result({ _yay: { cohort, work } });
}

/**
 * One owner's saved headers. Fields and list docs use their own paged work.
 */
export async function files_pending_overlay_db_stage_owner(
	ctx: MutationCtx,
	args: {
		cohortId: Id<"files_move_cohorts">;
		fence: number;
		attemptFence: number;
		ownerWorkId: Id<"files_move_owner_work">;
	},
) {
	const checked = await db_stage_owner(ctx, args);
	if (checked._nay) return checked;
	const { cohort, work } = checked._yay;
	if (work.status === "staged" || work.status === "validated" || work.status === "materialized")
		return Result({ _yay: { ...work, parentPage: false } });
	const scope = { organizationId: cohort.organizationId, workspaceId: cohort.workspaceId, userId: work.userId };
	const source = await ctx.db
		.query("files_pending_updates")
		.withIndex("by_user_target", (q) =>
			q.eq("userId", work.userId).eq("target.kind", work.target.kind).eq("target.id", work.target.id),
		)
		.unique();
	if ((source?._id ?? null) !== work.pendingUpdateId || (source?.revision ?? null) !== work.reviewedRevision)
		return Result({ _nay: { name: "move_changed", message: "Pending changes were revised." } });
	const beforeHide =
		work.target.kind === "saved"
			? await ctx.db
					.query("files_pending_hides")
					.withIndex("by_savedNode_user", (q) =>
						q
							.eq("savedNodeId", work.target.id as Id<"files_nodes">)
							.eq("userId", work.userId)
							.eq("moveView.cohortId", undefined)
							.eq("moveView.view", undefined),
					)
					.unique()
			: null;
	const beforePlace = await ctx.db
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
	const before = { cohortId: cohort._id, view: "before" as const };
	const after = { cohortId: cohort._id, view: "after" as const };
	const pendingUpdate = source ? await files_saved_placement_db_get_proposal(ctx.db, source._id, after) : null;
	const { facts, parentPage } = await files_pending_overlay_db_resolve_facts(ctx, {
		...scope,
		target: pendingUpdate?.target ?? work.target,
		fixedView: after,
		allowPagination: true,
	});
	if (!facts) return Result({ _yay: { ...work, unfinished: true, parentPage } });
	const beforeType = await ctx.db
		.query("files_pending_type_entries")
		.withIndex("by_target_user", (q) =>
			q
				.eq("target.kind", work.target.kind)
				.eq("target.id", work.target.id)
				.eq("userId", work.userId)
				.eq("moveView.cohortId", undefined)
				.eq("moveView.view", undefined),
		)
		.unique();
	if (beforeHide) await ctx.db.patch("files_pending_hides", beforeHide._id, { moveView: before });
	if (beforePlace) await ctx.db.patch("files_pending_places", beforePlace._id, { moveView: before });
	if (beforeType) await ctx.db.patch("files_pending_type_entries", beforeType._id, { moveView: before });
	const reader = files_pending_overlay_db_create_reader(ctx.db, { ...scope, fixedView: after });
	const desired = await files_pending_overlay_db_compute_target(ctx.db, reader, {
		...scope,
		// A partial private Save leaves a proposal on the new saved identity.
		target: pendingUpdate?.target ?? work.target,
		pendingUpdate,
		facts,
	});
	const afterHideId = desired.hide
		? await ctx.db.insert("files_pending_hides", { ...desired.hide, moveView: after })
		: null;
	const afterPlaceId = desired.place
		? await ctx.db.insert("files_pending_places", {
				...desired.place,
				fieldsVersion: (beforePlace?.fieldsVersion ?? 0) + 1,
				moveView: after,
			})
		: null;
	if (desired.typeEntry) await ctx.db.insert("files_pending_type_entries", { ...desired.typeEntry, moveView: after });
	if (source) {
		const fact = await ctx.db
			.query("files_pending_review_facts")
			.withIndex("by_proposal_view", (q) =>
				q.eq("pendingUpdateId", source._id).eq("cohortId", null).eq("view", "normal"),
			)
			.unique();
		if (fact) await ctx.db.patch("files_pending_review_facts", fact._id, { cohortId: cohort._id, view: "before" });
		await files_pending_review_facts_db_sync(ctx.db, { pendingUpdateId: source._id, fixedView: after });
	}
	const fields = {
		beforeHideId: beforeHide?._id ?? null,
		afterHideId,
		beforePlaceId: beforePlace?._id ?? null,
		afterPlaceId,
		status: "staged" as const,
	};
	await ctx.db.patch("files_move_owner_work", work._id, fields);
	if (beforePlace || afterPlaceId || beforeType || desired.typeEntry) {
		const slot = await ctx.db
			.query("files_move_workspace_slots")
			.withIndex("by_workspace", (q) =>
				q.eq("organizationId", cohort.organizationId).eq("workspaceId", cohort.workspaceId),
			)
			.unique();
		if (slot?.cohortId !== cohort._id) throw should_never_happen("Staged owner has no workspace slot", args);
		await files_saved_placement_db_bump_search_generation(ctx, cohort);
	}
	return Result({ _yay: { ...work, ...fields, parentPage } });
}

type Flush = {
	ctx: MutationCtx;
	state: FlushMarks;
	/**
	 * List keys whose list docs changed in this round.
	 */
	listKeys: Map<string, Scope & { listKey: Doc<"files_pending_list_keys">["listKey"] }>;
};

function flush_reader(flush: Flush, scope: Scope) {
	const key = scope_key(scope);
	let reader = flush.state.readers.get(key);
	if (!reader) {
		reader = files_pending_overlay_db_create_reader(flush.ctx.db, scope);
		flush.state.readers.set(key, reader);
	}
	return reader;
}

/**
 * A user's own write may add a hide or place of a saved node only while other users hold fewer
 * than the cap of them, because a saved write of the node refreshes them inline. Jobs and
 * side effects never refuse, so the count can pass the cap: a job adds a claim hide when the node
 * moves onto a name other users' drafts already hold, at most one per user with a draft at that
 * name. Once past the cap, every new draft write on the node is refused, so it grows slowly.
 */
async function db_refuse_crowded_saved_node(db: QueryCtx["db"], node: Doc<"files_nodes">, userId: Id<"users">) {
	// One hide and one place per user, so each list shows the cap of other users' docs.
	const hides = await db
		.query("files_pending_hides")
		.withIndex("by_savedNode_user", (q) => q.eq("savedNodeId", node._id))
		.take(MAX_OTHER_USERS_DOCS_PER_SAVED_NODE + 1);
	const places = await db
		.query("files_pending_places")
		.withIndex("by_target_user", (q) => q.eq("target.kind", "saved").eq("target.id", node._id))
		.take(MAX_OTHER_USERS_DOCS_PER_SAVED_NODE + 1);
	const others = [...hides, ...places].filter((doc) => doc.userId !== userId).length;
	if (others >= MAX_OTHER_USERS_DOCS_PER_SAVED_NODE)
		throw convex_error({ message: `Too many people have pending changes on ${node.name}. Try again later.` });
}

/**
 * Mark the owner's hide of the active saved node at this position: a place there may claim it.
 * `defer` sends that recompute to the owner's targets job.
 */
async function db_mark_claim_at(
	flush: Flush,
	mark: TargetMark,
	place: Pick<Doc<"files_pending_places">, "parent" | "name">,
	defer: boolean,
) {
	if (place.parent.kind === "private") return;
	const parentId = place.parent.kind === "root" ? "root" : place.parent.id;
	const claimed = await files_saved_placement_db_get_slot(
		flush.ctx.db,
		{ ...mark, parentId, name: place.name },
		undefined,
		await flush_reader(flush, mark).getView(),
	);
	if (!claimed || (mark.target.kind === "saved" && claimed._id === mark.target.id)) return;
	const claim = {
		organizationId: mark.organizationId,
		workspaceId: mark.workspaceId,
		userId: mark.userId,
		target: { kind: "saved", id: claimed._id } as const,
	};
	if (defer) defer_target(flush.state, { ...claim, pendingUpdateIds: new Set(), fieldsChanged: false });
	else mark_target(flush.state, { ...claim, inline: mark.inline, ownWrite: mark.ownWrite });
}

/**
 * A private node that closed or moved after its proposal went has no place to compare, so check
 * the claim at its old spot.
 */
async function db_mark_old_claims(flush: Flush, mark: TargetMark, defer: boolean) {
	for (const position of mark.oldPositions ?? [])
		await db_mark_claim_at(
			flush,
			mark,
			{ parent: await db_place_parent(flush.ctx.db, mark, position.parent), name: position.name },
			defer,
		);
}

/**
 * List summaries do not depend on the path resolver finishing.
 */
async function db_sync_target_lists(
	flush: Flush,
	mark: TargetMark,
	args: {
		pendingUpdate: Doc<"files_pending_updates"> | null;
		savedNode: Doc<"files_nodes"> | null;
		oldPendingUpdateId?: Id<"files_pending_updates">;
		syncFacts?: boolean;
		listKeys?: Doc<"files_pending_list_rows">["listKey"][];
	},
) {
	const { ctx } = flush;
	const { pendingUpdate, savedNode, oldPendingUpdateId } = args;
	const { userId, organizationId, workspaceId } = mark;
	const scope = { userId, organizationId, workspaceId };
	const listed =
		args.listKeys === undefined &&
		pendingUpdate &&
		(await files_pending_overlay_db_pending_update_is_listed({ ctx, pendingUpdate }));
	const listKeys: Doc<"files_pending_list_rows">["listKey"][] =
		args.listKeys ??
		(!listed ? [] : pendingUpdate.threadIds?.length ? ["all", ...pendingUpdate.threadIds] : ["all", "own"]);
	const pendingUpdateIds = new Set(mark.pendingUpdateIds);
	if (oldPendingUpdateId) pendingUpdateIds.add(oldPendingUpdateId);
	if (pendingUpdate) pendingUpdateIds.add(pendingUpdate._id);
	for (const pendingUpdateId of pendingUpdateIds) {
		if (args.syncFacts !== false)
			await files_pending_review_facts_db_sync(ctx.db, {
				pendingUpdateId,
				source: { proposal: pendingUpdateId === pendingUpdate?._id ? pendingUpdate : null, savedNode },
			});
		const rows = await ctx.db
			.query("files_pending_list_rows")
			.withIndex("by_pendingUpdate", (q) =>
				q.eq("pendingUpdateId", pendingUpdateId).eq("moveView.cohortId", undefined).eq("moveView.view", undefined),
			)
			.collect();
		const wanted = pendingUpdateId === pendingUpdate?._id ? new Set<string>(listKeys) : new Set<string>();
		for (const row of rows) {
			if (!wanted.delete(row.listKey)) await ctx.db.delete("files_pending_list_rows", row._id);
			else if (row.updatedAt !== pendingUpdate!.updatedAt)
				await ctx.db.patch("files_pending_list_rows", row._id, { updatedAt: pendingUpdate!.updatedAt });
			else continue;
			flush.listKeys.set(`${userId}:${row.listKey}`, { ...scope, listKey: row.listKey });
		}
		for (const listKey of wanted as Set<Doc<"files_pending_list_rows">["listKey"]>) {
			await ctx.db.insert("files_pending_list_rows", {
				...scope,
				listKey,
				pendingUpdateId,
				updatedAt: pendingUpdate!.updatedAt,
			});
			flush.listKeys.set(`${userId}:${listKey}`, { ...scope, listKey });
		}
	}
}

/**
 * Recompute one user's hide, place and list docs of one target, and record what follows: claims,
 * folder changes and place fields.
 */
async function db_recompute_target(flush: Flush, mark: TargetMark) {
	const { ctx, state } = flush;
	const { target, userId } = mark;
	const scope = { organizationId: mark.organizationId, workspaceId: mark.workspaceId, userId };
	const reader = flush_reader(flush, scope);
	// Reserved targets keep their before docs until the cohort finishes.
	if (await files_pending_overlay_db_target_cohort(ctx.db, { ...scope, target, currentView: await reader.getView() })) {
		defer_target(state, mark);
		return;
	}
	// Keep the shared inline memo, with room to save unfinished target work.
	const ranges = (await ctx.meta.getTransactionMetrics()).databaseQueries;
	reader.setReadLimit(reader.readCount + Math.max(0, ranges.remaining - 2 * JOB_READER_MARGIN));

	const pendingUpdate = await ctx.db
		.query("files_pending_updates")
		.withIndex("by_user_target", (q) =>
			q.eq("userId", userId).eq("target.kind", target.kind).eq("target.id", target.id),
		)
		.unique();
	const source = target.kind === "private" ? state.lastKnown.get(target.id) : null;
	// A source write already closed this draft. Any old frames have their own counted job.
	const closedSource = !state.ownJob && source?.state !== undefined && source.state !== "active";
	let claimFacts: files_visible_resolve_Facts | null = null;
	// A claim needs no path walk. Use the same small step as the durable fallback, in memory.
	if (
		target.kind === "saved" &&
		!pendingUpdate?.pendingMove &&
		!pendingUpdate?.pendingReplacement &&
		!state.ownJob &&
		!mark.ownerPathPending
	) {
		const remaining = (await ctx.meta.getTransactionMetrics()).databaseQueries.remaining;
		const claimReader = files_visible_resolve_db_create(ctx.db, { ...scope, includeHidden: true, readLimit: 128 });
		claimFacts = await claimReader.resolveFacts(
			target,
			async () =>
				Object.entries(await ctx.meta.getTransactionMetrics()).every(([key, metric]) =>
					key === "databaseQueries"
						? metric.remaining > JOB_READER_MARGIN
						: metric.used * 4 < (metric.used + metric.remaining) * 3,
				),
			{ claimOnly: true, stepLimit: Math.min(256, Math.max(0, remaining - JOB_READER_MARGIN)) },
		);
	}
	const facts = closedSource
		? undefined
		: (claimFacts ??
			(await files_pending_overlay_db_resolve_facts(ctx, {
				...scope,
				target,
				allowPagination: state.ownJob?.doc.kind === "targets",
				reader,
			})).facts);
	if (facts === null) {
		defer_target(state, mark);
		// Old frames may take more pages, but closed drafts must disappear from listings now.
		if (target.kind !== "private" || state.lastKnown.get(target.id)?.state === "active") {
			await db_mark_old_claims(flush, mark, true);
			await db_sync_target_lists(flush, mark, {
				pendingUpdate,
				savedNode: target.kind === "saved" ? await files_saved_placement_db_get_node(ctx.db, target.id) : null,
				syncFacts: false,
			});
			return;
		}
	}
	const desired = closedSource
		? { hide: null, place: null, typeEntry: null, listKeys: [], savedNode: null }
		: await files_pending_overlay_db_compute_target(ctx.db, reader, {
				...scope,
				target,
				facts: facts ?? undefined,
				pendingUpdate:
					pendingUpdate?.organizationId === mark.organizationId && pendingUpdate.workspaceId === mark.workspaceId
						? pendingUpdate
						: null,
			});
	// A hard deleted saved target needs no reader. Its claim and folder effects go to jobs, so
	// a hard delete of a node with many drafts stays small.
	const hardDeleted = target.kind === "saved" && desired.savedNode === null;

	const hide =
		target.kind === "saved"
			? await ctx.db
					.query("files_pending_hides")
					.withIndex("by_savedNode_user", (q) =>
						q
							.eq("savedNodeId", target.id)
							.eq("userId", userId)
							.eq("moveView.cohortId", undefined)
							.eq("moveView.view", undefined),
					)
					.unique()
			: null;
	const place = await ctx.db
		.query("files_pending_places")
		.withIndex("by_target_user", (q) =>
			q
				.eq("target.kind", target.kind)
				.eq("target.id", target.id)
				.eq("userId", userId)
				.eq("moveView.cohortId", undefined)
				.eq("moveView.view", undefined),
		)
		.unique();
	const next = desired.place;
	const typeEntry = await ctx.db
		.query("files_pending_type_entries")
		.withIndex("by_target_user", (q) =>
			q
				.eq("target.kind", target.kind)
				.eq("target.id", target.id)
				.eq("userId", userId)
				.eq("moveView.cohortId", undefined)
				.eq("moveView.view", undefined),
		)
		.unique();
	await db_sync_doc(ctx.db, "files_pending_type_entries", typeEntry, desired.typeEntry);
	// Only the owner's own draft write refuses, also when its claim adds the hide. The owner path
	// step (a broken move cycle, a folder move) never does, and neither does the user who accepts or
	// discards in a review unit, so discard, Accept and data deletion cannot fail here.
	if (
		mark.ownWrite &&
		mark.userId !== state.actingUserId &&
		desired.savedNode &&
		((!hide && desired.hide) || (!place && next))
	)
		await db_refuse_crowded_saved_node(ctx.db, desired.savedNode, userId);

	let hideChanged = false;
	if (target.kind === "saved") {
		hideChanged = (hide === null) !== (desired.hide === null);
		await db_sync_doc(ctx.db, "files_pending_hides", hide, desired.hide);
	}

	const factsChanged =
		!place ||
		!next ||
		!same_value(place.parent, next.parent) ||
		place.ownerTreePath !== next.ownerTreePath ||
		place.childTreePath !== next.childTreePath ||
		place.isVisible !== next.isVisible ||
		place.accessNodeId !== next.accessNodeId ||
		!same_value(place.destinationAccessNodeIds, next.destinationAccessNodeIds);
	if (place && !next) {
		await ctx.db.delete("files_pending_places", place._id);
		state.placeFieldIds.set(place._id, scope);
	} else if (next) {
		// Bump the version only when the fields job must run for this place.
		const bump = factsChanged || mark.fieldsChanged;
		const fieldsVersion = (place?.fieldsVersion ?? 0) + (bump ? 1 : 0);
		if (!place) state.placeFieldIds.set(await ctx.db.insert("files_pending_places", { ...next, fieldsVersion }), scope);
		else {
			const patch = changed_fields(place, { ...next, fieldsVersion });
			if (Object.keys(patch).length > 0) await ctx.db.patch("files_pending_places", place._id, patch);
			if (bump) state.placeFieldIds.set(place._id, scope);
		}
	}

	await db_sync_target_lists(flush, mark, {
		pendingUpdate,
		savedNode: desired.savedNode,
		oldPendingUpdateId: place?.pendingUpdateId,
		listKeys: desired.listKeys,
	});

	// A place that appears, goes, moves or changes visibility can start or end a claim.
	if (
		!place ||
		!next ||
		!same_value(place.parent, next.parent) ||
		place.name !== next.name ||
		place.isVisible !== next.isVisible
	)
		for (const position of [place, next]) if (position) await db_mark_claim_at(flush, mark, position, hardDeleted);
	await db_mark_old_claims(flush, mark, hardDeleted);

	// One rule for folder changes: the places under the folder's old paths follow it.
	const isFolder = (place ?? next)?.kind === "folder" || desired.savedNode?.kind === "folder";
	if (isFolder && (((place !== null || next !== null) && factsChanged) || hideChanged || mark.ownerPathPending)) {
		const prefixes = new Set<string>();
		if (place) {
			prefixes.add(place.ownerTreePath);
			if (place.childTreePath) prefixes.add(place.childTreePath);
		}
		// A saved folder with no place before: its children build on its saved path.
		else if (desired.savedNode) {
			const node = desired.savedNode;
			const fullFacts = claimFacts
				? (await files_pending_overlay_db_resolve_facts(ctx, {
						...scope,
						target,
						allowPagination: false,
						reader,
					})).facts
				: facts;
			if (fullFacts === null) defer_target(state, { ...mark, ownerPathPending: true });
			const parent = fullFacts?.savedParent;
			if (parent) prefixes.add(files_derive_tree_path_for_file_node(`${parent.path}/${node.name}`, "folder"));
		}
		for (const prefix of prefixes)
			if (prefix.endsWith("/")) state.ownerPathRequests.push({ ...scope, prefix, inline: mark.inline && !hardDeleted });
	}
}

/**
 * Keep one key doc per (user, list key) while the user has list docs with that key, with the
 * newest list doc's time.
 */
export async function files_pending_overlay_db_sync_list_key(
	db: MutationCtx["db"],
	args: Scope & { listKey: Doc<"files_pending_list_keys">["listKey"] },
) {
	const { listKey, ...scope } = args;
	const view = await files_saved_placement_db_get_view(db, scope);
	const claim = view.cohortId
		? await db
				.query("files_move_owner_list_keys")
				.withIndex("by_cohort_owner_key", (q) =>
					q.eq("cohortId", view.cohortId!).eq("userId", scope.userId).eq("listKey", listKey),
				)
				.unique()
		: null;
	const newestNormal = await db
		.query("files_pending_list_rows")
		.withIndex("by_org_ws_user_listKey_updatedAt", (q) =>
			q
				.eq("organizationId", scope.organizationId)
				.eq("workspaceId", scope.workspaceId)
				.eq("userId", scope.userId)
				.eq("moveView.cohortId", undefined)
				.eq("moveView.view", undefined)
				.eq("listKey", listKey),
		)
		.order("desc")
		.first();
	const tags = claim
		? [
				{ cohortId: claim.cohortId, view: "before" as const },
				{ cohortId: claim.cohortId, view: "after" as const },
			]
		: [undefined];
	for (const tag of tags) {
		const newestTagged = tag
			? await db
					.query("files_pending_list_rows")
					.withIndex("by_org_ws_user_listKey_updatedAt", (q) =>
						q
							.eq("organizationId", scope.organizationId)
							.eq("workspaceId", scope.workspaceId)
							.eq("userId", scope.userId)
							.eq("moveView.cohortId", tag.cohortId)
							.eq("moveView.view", tag.view)
							.eq("listKey", listKey),
					)
					.order("desc")
					.first()
			: null;
		const newest =
			newestTagged && (!newestNormal || newestTagged.updatedAt > newestNormal.updatedAt) ? newestTagged : newestNormal;
		const keyDoc = await db
			.query("files_pending_list_keys")
			.withIndex("by_org_ws_user_listKey", (q) =>
				q
					.eq("organizationId", scope.organizationId)
					.eq("workspaceId", scope.workspaceId)
					.eq("userId", scope.userId)
					.eq("moveView.cohortId", tag?.cohortId)
					.eq("moveView.view", tag?.view)
					.eq("listKey", listKey),
			)
			.unique();
		const desired = newest && { ...scope, listKey, lastUpdatedAt: newest.updatedAt, ...(tag ? { moveView: tag } : {}) };
		await db_sync_doc(db, "files_pending_list_keys", keyDoc, desired);
		if (claim && tag) {
			const current = desired
				? await db
						.query("files_pending_list_keys")
						.withIndex("by_org_ws_user_listKey", (q) =>
							q
								.eq("organizationId", scope.organizationId)
								.eq("workspaceId", scope.workspaceId)
								.eq("userId", scope.userId)
								.eq("moveView.cohortId", tag.cohortId)
								.eq("moveView.view", tag.view)
								.eq("listKey", listKey),
						)
						.unique()
				: null;
			await db.patch(
				"files_move_owner_list_keys",
				claim._id,
				tag.view === "before" ? { beforeKeyId: current?._id ?? null } : { afterKeyId: current?._id ?? null },
			);
		}
	}
}

async function db_stage_list_key(
	db: MutationCtx["db"],
	args: Scope & {
		cohortId: Id<"files_move_cohorts">;
		listKey: Doc<"files_pending_list_keys">["listKey"];
	},
) {
	const claim = await db
		.query("files_move_owner_list_keys")
		.withIndex("by_cohort_owner_key", (q) =>
			q.eq("cohortId", args.cohortId).eq("userId", args.userId).eq("listKey", args.listKey),
		)
		.unique();
	if (claim) return;
	const key = await db
		.query("files_pending_list_keys")
		.withIndex("by_org_ws_user_listKey", (q) =>
			q
				.eq("organizationId", args.organizationId)
				.eq("workspaceId", args.workspaceId)
				.eq("userId", args.userId)
				.eq("moveView.cohortId", undefined)
				.eq("moveView.view", undefined)
				.eq("listKey", args.listKey),
		)
		.unique();
	if (key)
		await db.patch("files_pending_list_keys", key._id, { moveView: { cohortId: args.cohortId, view: "before" } });
	await db.insert("files_move_owner_list_keys", {
		cohortId: args.cohortId,
		userId: args.userId,
		listKey: args.listKey,
		beforeKeyId: key?._id ?? null,
		afterKeyId: null,
	});
}

export async function files_pending_overlay_db_stage_owner_lists(
	ctx: MutationCtx,
	args: {
		cohortId: Id<"files_move_cohorts">;
		fence: number;
		attemptFence: number;
		ownerWorkId: Id<"files_move_owner_work">;
		cursor: string | null;
	},
) {
	const checked = await db_stage_owner(ctx, args);
	if (checked._nay) return checked;
	const { cohort, work } = checked._yay;
	if (work.status !== "staged" && work.status !== "validated")
		return Result({ _nay: { name: "stopped", message: "This Move owner is not staged." } });
	if (work.dependencyCursor !== args.cursor)
		return Result({ _nay: { name: "stopped", message: "This Move page already changed." } });
	const scope = { organizationId: cohort.organizationId, workspaceId: cohort.workspaceId, userId: work.userId };
	const cursor = args.cursor
		? (JSON.parse(args.cursor) as { phase: "before" | "after" | "done"; page: string | null; offset: number })
		: { phase: "before" as const, page: null, offset: 0 };
	const proposal = work.pendingUpdateId
		? await files_saved_placement_db_get_proposal(ctx.db, work.pendingUpdateId, { cohortId: cohort._id, view: "after" })
		: null;
	let paged = false;
	if (cursor.phase === "before" && work.pendingUpdateId) {
		const query = () =>
			ctx.db
				.query("files_pending_list_rows")
				.withIndex("by_pendingUpdate", (q) =>
					q
						.eq("pendingUpdateId", work.pendingUpdateId!)
						.eq("moveView.cohortId", undefined)
						.eq("moveView.view", undefined),
				);
		// List rows have only small fields. Probe the whole range before changing any row.
		const small = cursor.page === null ? await query().take(9) : null;
		const page: Omit<PaginationResult<Doc<"files_pending_list_rows">>, "continueCursor"> & { continueCursor: string | null } =
			small && small.length <= 8
				? { page: small, isDone: true, continueCursor: null }
				: await ctx.runQuery(internal.files_move_pages.owner_list_rows, {
						pendingUpdateId: work.pendingUpdateId,
						cursor: cursor.page,
					});
		paged = !small || small.length > 8;
		for (const row of page.page) {
			await db_stage_list_key(ctx.db, { ...scope, cohortId: cohort._id, listKey: row.listKey });
			await ctx.db.patch("files_pending_list_rows", row._id, { moveView: { cohortId: cohort._id, view: "before" } });
			await files_pending_overlay_db_sync_list_key(ctx.db, { ...scope, listKey: row.listKey });
		}
		cursor.phase = page.isDone ? "after" : "before";
		cursor.page = page.isDone ? null : page.continueCursor;
	} else if (cursor.phase !== "done") {
		const keys: Doc<"files_pending_list_rows">["listKey"][] =
			!proposal || !(await files_pending_overlay_db_pending_update_is_listed({ ctx, pendingUpdate: proposal }))
				? []
				: proposal.threadIds?.length
					? ["all", ...proposal.threadIds]
					: ["all", "own"];
		for (const listKey of keys.slice(cursor.offset, cursor.offset + 100)) {
			await db_stage_list_key(ctx.db, { ...scope, cohortId: cohort._id, listKey });
			await ctx.db.insert("files_pending_list_rows", {
				...scope,
				listKey,
				pendingUpdateId: proposal!._id,
				updatedAt: proposal!.updatedAt,
				moveView: { cohortId: cohort._id, view: "after" },
			});
			await files_pending_overlay_db_sync_list_key(ctx.db, { ...scope, listKey });
		}
		cursor.offset += Math.min(100, Math.max(0, keys.length - cursor.offset));
		cursor.phase = cursor.offset === keys.length ? "done" : "after";
	}
	const next = JSON.stringify(cursor);
	await ctx.db.patch("files_move_owner_work", work._id, { dependencyCursor: next });
	return Result({ _yay: { cursor: next, done: cursor.phase === "done", paged, parentPage: false } });
}

/**
 * Keep the after place ID fixed while its field docs are built in pages. Start only after every
 * original metadata doc is tagged before and the after metadata is sealed.
 */
export async function files_pending_overlay_db_stage_owner_fields(
	ctx: MutationCtx,
	args: {
		cohortId: Id<"files_move_cohorts">;
		fence: number;
		attemptFence: number;
		ownerWorkId: Id<"files_move_owner_work">;
		cursor: string | null;
	},
): Promise<
	Result<
		| { _yay: { cursor: string; done: boolean; paged: boolean; parentPage: false } }
		| { _nay: { name: "stopped"; message: string } }
	>
> {
	const checked = await db_stage_owner(ctx, args);
	if (checked._nay) return checked;
	const { cohort, work } = checked._yay;
	if ((work.status !== "staged" && work.status !== "validated") || work.fieldCursor !== args.cursor)
		return Result({ _nay: { name: "stopped", message: "This Move field page already changed." } });
	const cursor = args.cursor
		? (JSON.parse(args.cursor) as { phase: "before" | "normal" | "after" | "done"; page: string | null })
		: { phase: "before" as const, page: null };
	const before = { cohortId: cohort._id, view: "before" as const };
	const after = { cohortId: cohort._id, view: "after" as const };
	let paged = false;
	if (cursor.phase === "before") {
		if (work.beforePlaceId) {
			const query = () =>
				ctx.db
					.query("files_pending_place_fields")
					.withIndex("by_place", (q) =>
						q.eq("placeId", work.beforePlaceId!).eq("moveView.cohortId", undefined).eq("moveView.view", undefined),
					);
			const page: PaginationResult<Doc<"files_pending_place_fields">> | null =
				cursor.page === null && !(await query().first())
					? null
					: await ctx.runQuery(internal.files_move_pages.owner_old_fields, {
							placeId: work.beforePlaceId,
							cursor: cursor.page,
						});
			paged = page !== null;
			for (const field of page?.page ?? [])
				await ctx.db.patch("files_pending_place_fields", field._id, { moveView: before });
			cursor.page = page && !page.isDone ? page.continueCursor : null;
			if (!page || page.isDone) cursor.phase = "normal";
		} else cursor.phase = "normal";
	} else if (cursor.phase !== "done") {
		const place = work.afterPlaceId ? await ctx.db.get("files_pending_places", work.afterPlaceId) : null;
		const proposal = work.pendingUpdateId
			? await files_saved_placement_db_get_proposal(ctx.db, work.pendingUpdateId, after)
			: null;
		if (!place || (place.target.kind === "private" && !proposal)) cursor.phase = "done";
		else {
			const tag = cursor.phase === "after" ? after : undefined;
			const source = () =>
				place.target.kind === "private"
					? ctx.db
							.query("files_metadata_docs")
							.withIndex("by_pendingUpdate", (q) =>
								q
									.eq("pendingUpdateId", place.pendingUpdateId)
									.eq("moveView.cohortId", tag?.cohortId)
									.eq("moveView.view", tag?.view),
							)
					: ctx.db.query("files_metadata_docs").withIndex("by_organization_workspace_source_fileNode", (q) =>
							q
								.eq("organizationId", place.organizationId)
								.eq("workspaceId", place.workspaceId)
								.eq("sourceKind", "committed")
								.eq("fileNodeId", place.target.id as Id<"files_nodes">)
								.eq("moveView.cohortId", tag?.cohortId)
								.eq("moveView.view", tag?.view),
						);
			// Source docs stay in place. These identity-only indexes keep the stored cursor short.
			const page: PaginationResult<Doc<"files_metadata_docs">> | null =
				cursor.page === null && !(await source().first())
					? null
					: await ctx.runQuery(internal.files_move_pages.owner_source_metadata, {
							source:
								place.target.kind === "private"
									? { kind: "pending", pendingUpdateId: place.pendingUpdateId! }
									: {
											kind: "saved",
											organizationId: place.organizationId,
											workspaceId: place.workspaceId,
											nodeId: place.target.id,
										},
							cohortId: tag?.cohortId ?? null,
							cursor: cursor.page,
						});
			paged = page !== null;
			for (const doc of page?.page ?? []) {
				if (
					doc.sourceKind === "pending" &&
					doc.proposalRevision !== (proposal && files_pending_update_index_revision(proposal))
				)
					continue;
				await ctx.db.insert("files_pending_place_fields", {
					organizationId: place.organizationId,
					workspaceId: place.workspaceId,
					userId: place.userId,
					target: place.target,
					placeId: place._id,
					moveView: after,
					docKind: doc.docKind,
					fieldPath: doc.fieldPath,
					valueKind: doc.valueKind,
					stringValue: doc.stringValue,
					numberValue: doc.numberValue,
					booleanValue: doc.booleanValue,
					parent: place.parent,
					ownerTreePath: place.ownerTreePath,
					isVisible: place.isVisible,
					accessNodeId: place.accessNodeId,
					fieldsVersion: place.fieldsVersion,
				});
			}
			cursor.page = page && !page.isDone ? page.continueCursor : null;
			if (!page || page.isDone) cursor.phase = cursor.phase === "normal" ? "after" : "done";
		}
	}
	const next = JSON.stringify(cursor);
	await ctx.db.patch("files_move_owner_work", work._id, { fieldCursor: next });
	return Result({ _yay: { cursor: next, done: cursor.phase === "done", paged, parentPage: false } });
}

// #endregion recompute

// #region jobs

/**
 * Start a job for this input. A job with the same kind and key that has not started its pass
 * starts again from its first doc; one in the middle of a pass walks once more when the pass ends.
 * A list job merges the new ids into its doc. Each paged (kind, key) is scheduled once per
 * transaction.
 */
async function db_schedule_job(flush: Flush, scope: Omit<Scope, "userId">, input: JobInput) {
	const { ctx, state } = flush;
	const own = state.ownJob;
	const list = job_list(input);
	const base = job_key(scope, input);
	if (!list) {
		if (own?.doc.kind === input.kind && own.doc.key === base) {
			own.rerun = true;
			return;
		}
		if (state.scheduledJobs.has(`${input.kind}:${base}`)) return;
		state.scheduledJobs.add(`${input.kind}:${base}`);
	}

	// A list doc holds at most JOB_LIST_ITEMS ids. When it is full, or it is the running job's own
	// doc (that job rewrites its list when it ends), use the next key.
	let key = base;
	let job: Doc<"files_pending_overlay_jobs"> | null = null;
	for (let suffix = 1; ; suffix++) {
		if (!(own?.doc.kind === input.kind && own.doc.key === key)) {
			job = await ctx.db
				.query("files_pending_overlay_jobs")
				.withIndex("by_kind_key", (q) => q.eq("kind", input.kind).eq("key", key))
				.unique();
			if (!list || !job || job_list(job)!.length + list.length <= JOB_LIST_ITEMS) break;
		}
		key = `${base}:${suffix}`;
	}

	// Restarting in the middle of a pass would walk the first docs again, and steady writes could
	// keep it from ever ending. Its next run is already scheduled.
	if (job?.cursor) {
		const cursor = JSON.parse(job.cursor) as { rerun?: boolean };
		if (!cursor.rerun)
			await ctx.db.patch("files_pending_overlay_jobs", job._id, { cursor: JSON.stringify({ ...cursor, rerun: true }) });
		return;
	}

	const now = Date.now();
	if (job)
		// Cancel only a function that has not started. A running one conflicts with this write, so
		// Convex runs it again on the new doc, where `run_job` sees the new `nextAttemptAt` and stops.
		if ((await ctx.db.system.get("_scheduled_functions", job.scheduledFunctionId))?.state.kind === "pending")
			await ctx.scheduler.cancel(job.scheduledFunctionId);
	const scheduledFunctionId = await ctx.scheduler.runAfter(0, internal.files_pending_overlay.run_job, {
		kind: input.kind,
		key,
		nextAttemptAt: now,
	});
	if (!job) {
		const reviewFactsPending = input.kind !== "place_fields";
		if (reviewFactsPending) await files_pending_review_facts_db_change_state(ctx.db, scope, { jobs: 1 });
		await ctx.db.insert("files_pending_overlay_jobs", {
			...scope,
			...input,
			key,
			cursor: null,
			nextAttemptAt: now,
			scheduledFunctionId,
			attempts: 0,
			reviewFactsPending,
		});
		return;
	}
	await ctx.db.patch("files_pending_overlay_jobs", job._id, {
		cursor: null,
		nextAttemptAt: now,
		scheduledFunctionId,
		...(job.kind === "place_fields" && input.kind === "place_fields"
			? { placeIds: [...new Set([...job.placeIds, ...input.placeIds])] }
			: {}),
		...(job.kind === "targets" && input.kind === "targets" ? { items: [...job.items, ...input.items] } : {}),
	});
}

/**
 * A repair stays counted until every page and its follow-up work are recorded.
 */
export async function files_pending_overlay_db_schedule_repair(ctx: MutationCtx, scope: Scope) {
	const state = (ctx as WrappedCtx)[FLUSH_MARKS];
	if (!state) throw should_never_happen("Overlay repair outside the mutation wrapper", scope);
	await files_pending_review_facts_db_change_state(ctx.db, scope, { structural: true });
	await db_schedule_job({ ctx, state, listKeys: new Map() }, scope, { kind: "repair_user", userId: scope.userId });
}

/**
 * Make a saved node's chunks and metadata docs follow its new path, archive state or area, in a
 * job. A job that has not started reads the node when it runs. One in the middle of a pass walks
 * once more when the pass ends, so steady writes cannot keep it from ending. One whose run failed
 * starts again. Callers must not schedule the same node twice in parallel: both calls would insert
 * a job doc.
 *
 * `metadataOnly`: only the area changed. Text chunks have no area, so the job skips them. A later
 * call without it makes the job walk the chunks too.
 */
export async function files_pending_overlay_db_schedule_saved_scope(
	ctx: MutationCtx,
	node: Pick<Doc<"files_nodes">, "_id" | "organizationId" | "workspaceId">,
	args: { metadataOnly?: boolean } = {},
) {
	const job = await ctx.db
		.query("files_pending_overlay_jobs")
		.withIndex("by_kind_key", (q) => q.eq("kind", "saved_scope").eq("key", node._id))
		.unique();
	if (job) {
		const cursor = job.cursor
			? (JSON.parse(job.cursor) as { phase: number; page: string | null; rerun?: boolean; metadataOnly?: boolean })
			: null;
		// A job at its first page reads the node when it runs, so it needs no extra pass.
		const started = cursor !== null && (cursor.phase !== 0 || cursor.page !== null);
		const widen = !args.metadataOnly && cursor?.metadataOnly === true;
		if (!started) {
			if (widen) await ctx.db.patch("files_pending_overlay_jobs", job._id, { cursor: null });
		} else if (!cursor.rerun || widen)
			await ctx.db.patch("files_pending_overlay_jobs", job._id, {
				cursor: JSON.stringify({ ...cursor, rerun: true, metadataOnly: !widen && cursor.metadataOnly }),
			});
		// A failed or lost run leaves the job idle until `recover_jobs`, so start it again now. A Move
		// wakes a parked job, and a pending run reads this write when it runs.
		const run = await ctx.db.system.get("_scheduled_functions", job.scheduledFunctionId);
		if (job.blockedByCohortId || run?.state.kind === "pending" || run?.state.kind === "inProgress") return;
	}
	const now = Date.now();
	const scheduledFunctionId = await ctx.scheduler.runAfter(0, internal.files_pending_overlay.run_job, {
		kind: "saved_scope",
		key: node._id,
		nextAttemptAt: now,
	});
	if (job) {
		await ctx.db.patch("files_pending_overlay_jobs", job._id, { nextAttemptAt: now, scheduledFunctionId });
		return;
	}
	await ctx.db.insert("files_pending_overlay_jobs", {
		organizationId: node.organizationId,
		workspaceId: node.workspaceId,
		kind: "saved_scope",
		savedNodeId: node._id,
		key: node._id,
		cursor: args.metadataOnly ? JSON.stringify({ phase: 0, page: null, metadataOnly: true }) : null,
		nextAttemptAt: now,
		scheduledFunctionId,
		attempts: 0,
	});
}

/**
 * Refresh private copies without making the saved writer visit every owner. Keep an active pass's
 * cursor; a later write asks for one more pass. Callers schedule the same node sequentially.
 */
export async function files_pending_overlay_db_schedule_saved_places(
	ctx: MutationCtx,
	node: Pick<Doc<"files_nodes">, "_id" | "organizationId" | "workspaceId">,
	args: { fieldsChanged?: boolean } = {},
) {
	// Global and plugin volume workspaces have no drafts.
	const organizationId = ctx.db.normalizeId("organizations", node.organizationId);
	const workspaceId = ctx.db.normalizeId("organizations_workspaces", node.workspaceId);
	if (!organizationId || !workspaceId) return;
	const job = (await ctx.db
		.query("files_pending_overlay_jobs")
		.withIndex("by_kind_key", (q) => q.eq("kind", "saved_places").eq("key", node._id))
		.unique()) as Extract<Doc<"files_pending_overlay_jobs">, { kind: "saved_places" }> | null;
	if (job) {
		if (args.fieldsChanged)
			await ctx.db.patch("files_pending_overlay_jobs", job._id, { metadataRevision: job.metadataRevision + 1 });
		if (job.cursor) {
			const cursor = JSON.parse(job.cursor) as files_pending_overlay_SavedPlacesCursor;
			await ctx.db.patch("files_pending_overlay_jobs", job._id, {
				cursor: JSON.stringify({
					...cursor,
					rerun: true,
					rerunFieldsChanged: cursor.rerunFieldsChanged || args.fieldsChanged === true,
				}),
			});
		} else if (args.fieldsChanged && !job.fieldsChanged)
			await ctx.db.patch("files_pending_overlay_jobs", job._id, { fieldsChanged: true });
		const run = await ctx.db.system.get("_scheduled_functions", job.scheduledFunctionId);
		if (job.blockedByCohortId || run?.state.kind === "pending" || run?.state.kind === "inProgress") return;
	} else {
		const place = await ctx.db
			.query("files_pending_places")
			.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", node._id))
			.first();
		if (!place) return;
	}
	const now = Date.now();
	const scheduledFunctionId = await ctx.scheduler.runAfter(0, internal.files_pending_overlay.run_job, {
		kind: "saved_places",
		key: node._id,
		nextAttemptAt: now,
	});
	if (job) {
		await ctx.db.patch("files_pending_overlay_jobs", job._id, { nextAttemptAt: now, scheduledFunctionId });
		return;
	}
	await ctx.db.insert("files_pending_overlay_jobs", {
		organizationId,
		workspaceId,
		kind: "saved_places",
		savedNodeId: node._id,
		fieldsChanged: args.fieldsChanged === true,
		metadataRevision: 0,
		key: node._id,
		cursor: null,
		nextAttemptAt: now,
		scheduledFunctionId,
		attempts: 0,
	});
}

/**
 * Make a saved node's chunks and metadata docs follow its new path, archive state or area. A node with
 * few of them is patched in this mutation. A bigger one gets a saved scope job, so one big file costs
 * this mutation little.
 *
 * Archive, Restore and the scope op (Restrict, Unrestrict) call this for every item of a step. A job
 * per item would add up to 2 scheduler runs per item before the next step can start, so small items
 * skip the job.
 *
 * `metadataOnly`: only the area changed, like in `files_pending_overlay_db_schedule_saved_scope`.
 * Text chunks have no area, so they are not read.
 */
export async function files_pending_overlay_db_follow_saved_scope(
	ctx: MutationCtx,
	node: Pick<Doc<"files_nodes">, "_id" | "organizationId" | "workspaceId">,
	args: { metadataOnly?: boolean } = {},
) {
	// A job of this node may be in the middle of a pass. Let it walk once more, so it cannot write
	// the old scope after this mutation.
	if (await files_pending_overlay_db_has_saved_scope_job(ctx, node._id) ||
		await files_saved_index_db_is_publishing(ctx.db, node._id)) {
		await files_pending_overlay_db_schedule_saved_scope(ctx, node, args);
		return;
	}

	// The caller has just written the node, so read its new fields.
	const savedNode = (await ctx.db.get("files_nodes", node._id))!;
	const metadataDocs = await ctx.db
		.query("files_metadata_docs")
		.withIndex("by_organization_workspace_source_fileNode", (q) =>
			q
				.eq("organizationId", savedNode.organizationId)
				.eq("workspaceId", savedNode.workspaceId)
				.eq("sourceKind", "committed")
				.eq("fileNodeId", savedNode._id)
				.eq("moveView.cohortId", undefined)
				.eq("moveView.view", undefined),
		)
		.take(INLINE_SAVED_SCOPE_DOCS + 1);
	// Only files have text chunks.
	const chunks =
		metadataDocs.length > INLINE_SAVED_SCOPE_DOCS || savedNode.kind !== "file" || args.metadataOnly
			? []
			: await ctx.db
					.query("files_plain_text_chunks")
					.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
						q
							.eq("organizationId", savedNode.organizationId)
							.eq("workspaceId", savedNode.workspaceId)
							.eq("fileNodeId", savedNode._id)
							.eq("moveView.cohortId", undefined)
							.eq("moveView.view", undefined),
					)
					.take(INLINE_SAVED_SCOPE_DOCS + 1);
	if (metadataDocs.length > INLINE_SAVED_SCOPE_DOCS || chunks.length > INLINE_SAVED_SCOPE_DOCS) {
		await files_pending_overlay_db_schedule_saved_scope(ctx, node, args);
		return;
	}

	await files_pending_overlay_db_copy_saved_scope(ctx, { node: savedNode, metadataDocs, chunks });
}

/**
 * Copy a saved node's scope onto the given saved docs of that node. Metadata docs get the path,
 * archive state and area. Plain text chunks get the path and archive state. Only docs that differ are
 * patched.
 */
export async function files_pending_overlay_db_copy_saved_scope(
	ctx: MutationCtx,
	args: {
		node: Doc<"files_nodes">;
		metadataDocs: Doc<"files_metadata_docs">[];
		chunks: Doc<"files_plain_text_chunks">[];
	},
) {
	const { node } = args;
	const archiveOperationId = node.archiveOperationId ?? undefined;

	// The overlay wrapper noted the metadata docs when the caller's query returned them.
	for (const doc of args.metadataDocs) {
		const scope: Partial<Doc<"files_metadata_docs">> = {
			path: node.path,
			treePath: node.treePath,
			archiveOperationId,
			restrictedScopeNodeId: node.restrictedScopeNodeId,
			// Field docs also copy the folder table sort fields, built like
			// `files_metadata_committed_field_sort_fields`.
			...(doc.docKind === "field"
				? {
						parentId: node.parentId,
						isRestrictedScopeRoot: node.restrictedScopeNodeId === node._id,
						name: node.name,
						sortName: files_sort_text_key(node.name),
					}
				: {}),
		};
		const patch = Object.fromEntries(
			Object.entries(scope).filter(([field, value]) => doc[field as keyof typeof doc] !== value),
		);
		if (Object.keys(patch).length > 0) await ctx.db.patch("files_metadata_docs", doc._id, patch);
	}

	for (const chunk of args.chunks) {
		if (chunk.path === node.path && chunk.archiveOperationId === archiveOperationId) continue;
		// The caller read the chunk, so the Move guard needs no second read before the patch.
		files_move_reservations_db_note_source(ctx.db, { table: "files_plain_text_chunks", id: chunk._id, old: chunk });
		await ctx.db.patch("files_plain_text_chunks", chunk._id, { path: node.path, archiveOperationId });
	}
}

/**
 * Whether a saved node's chunks and metadata docs may still lag its scope. Readers use it to skip a
 * doc in transit, and still throw on a mismatch with no job.
 */
export async function files_pending_overlay_db_has_saved_scope_job(ctx: QueryCtx, nodeId: Id<"files_nodes">) {
	const job = await ctx.db
		.query("files_pending_overlay_jobs")
		.withIndex("by_kind_key", (q) => q.eq("kind", "saved_scope").eq("key", nodeId))
		.unique();
	return job !== null;
}

export async function files_pending_overlay_db_delete_job(ctx: MutationCtx, job: Doc<"files_pending_overlay_jobs">) {
	// A saved scope job never counts. Its kind check only narrows the workspace type.
	if (job.reviewFactsPending && job.kind !== "saved_scope")
		await files_pending_review_facts_db_change_state(ctx.db, job, { jobs: -1 });
	await ctx.db.delete("files_pending_overlay_jobs", job._id);
}

/**
 * Parent depth is bounded on write. A subtree reservation also protects unstaged children.
 */
export async function files_pending_overlay_db_target_cohort(
	db: QueryCtx["db"],
	args: Pick<Doc<"files_nodes">, "organizationId" | "workspaceId"> & {
		target: files_PendingTarget;
		currentView?: files_saved_placement_View;
	},
) {
	const view = args.currentView ?? (await files_saved_placement_db_get_view(db, args));
	if (!view.cohortId) return null;
	const cohortId = await files_move_reservations_db_find_blocker(db, { source: args.target });
	return cohortId === view.cohortId ? cohortId : null;
}

export async function files_pending_overlay_db_wake_job(
	ctx: MutationCtx,
	args: {
		cohortId: Id<"files_move_cohorts">;
		jobId: Id<"files_pending_overlay_jobs">;
	},
) {
	const job = await ctx.db.get("files_pending_overlay_jobs", args.jobId);
	if (job?.blockedByCohortId !== args.cohortId) return;
	const now = Date.now();
	const scheduledFunctionId = await ctx.scheduler.runAfter(0, internal.files_pending_overlay.run_job, {
		kind: job.kind,
		key: job.key,
		nextAttemptAt: now,
	});
	await ctx.db.patch("files_pending_overlay_jobs", job._id, {
		blockedByCohortId: undefined,
		nextAttemptAt: now,
		scheduledFunctionId,
	});
}

/**
 * The ancestor ids a child of `parentId` stores: the parent's ancestors plus the parent, top-level
 * folder first, at most 12. `known` holds ancestors already computed in this round; any other parent
 * is read, and its stored ancestors are right because parents are written first. Null when the
 * parent is gone.
 */
export async function files_pending_overlay_db_child_ancestors(
	db: QueryCtx["db"],
	parentId: Doc<"files_nodes">["parentId"],
	known?: Map<Id<"files_nodes">, Id<"files_nodes">[]>,
) {
	if (parentId === "root") return [];
	let parentAncestors = known?.get(parentId);
	if (!parentAncestors) {
		const parent = await db.get("files_nodes", parentId);
		if (!parent) return null;
		parentAncestors = files_ancestor_ids(parent);
		known?.set(parentId, parentAncestors);
	}
	// A node deeper than 12 folders keeps the top 12.
	return [...parentAncestors, parentId].slice(0, files_ANCESTOR_FIELD_COUNT);
}

/**
 * Write `ancestor1..12` of the saved nodes of this round that were inserted or whose parent or
 * `treePath` changed. Parents go first (shorter `treePath`), so a child copies its parent's new
 * ancestors. The patch writes ancestor fields only, so the wrapper marks nothing.
 */
async function db_flush_ancestors(
	flush: Flush,
	nodes: Array<{ node: Doc<"files_nodes"> | null; old: SourceFields | null }>,
) {
	const { ctx } = flush;
	const known = new Map<Id<"files_nodes">, Id<"files_nodes">[]>();
	const moved = nodes
		.flatMap(({ node, old }) =>
			node && (!old || old.parentId !== node.parentId || old.treePath !== node.treePath) ? [node] : [],
		)
		.sort((a, b) => a.treePath.length - b.treePath.length);
	for (const node of moved) {
		const ancestors = await files_pending_overlay_db_child_ancestors(ctx.db, node.parentId, known);
		// The parent was hard deleted in this transaction: the node goes with it.
		if (!ancestors) continue;
		known.set(node._id, ancestors);
		const patch = changed_fields(node, files_ancestor_fields(ancestors));
		if (Object.keys(patch).length > 0) await ctx.db.patch("files_nodes", node._id, patch);
	}
}

/**
 * Structural copies stay exact for the saved page's index window. Content-only writes queue the
 * copied dates instead, so Save and version Restore do not visit every owner's hide or place.
 */
async function db_flush_saved_node(
	flush: Flush,
	nodeId: Id<"files_nodes">,
	old: SourceFields | null,
	node: Doc<"files_nodes"> | null,
) {
	const { ctx } = flush;
	const doc = node ?? old;
	if (!doc) return;
	// Global and plugin volume workspaces have no drafts.
	const organizationId = ctx.db.normalizeId("organizations", doc.organizationId);
	const workspaceId = ctx.db.normalizeId("organizations_workspaces", doc.workspaceId);
	if (!organizationId || !workspaceId) return;
	const scope = { organizationId, workspaceId };

	const active = node?.archiveOperationId === null;
	// A claim job can give one node many hides, so read them only when a copied field changed.
	const hideFieldsChanged =
		!old ||
		!node ||
		old.parentId !== node.parentId ||
		old.kind !== node.kind ||
		old.name !== node.name ||
		old.lowercaseExtension !== node.lowercaseExtension ||
		old.treePath !== node.treePath ||
		(old.archiveOperationId === null) !== active;
	const hides = hideFieldsChanged
		? await ctx.db
				.query("files_pending_hides")
				.withIndex("by_savedNode_user", (q) => q.eq("savedNodeId", nodeId))
				.collect()
		: [];
	const places = hideFieldsChanged
		? await ctx.db
				.query("files_pending_places")
				.withIndex("by_target_user", (q) => q.eq("target.kind", "saved").eq("target.id", nodeId))
				.collect()
		: [];
	if (!hideFieldsChanged && node && old.updatedAt !== node.updatedAt)
		await files_pending_overlay_db_schedule_saved_places(ctx, node);

	// During a Move the physical node keeps its old place until cleanup. A hide or place tagged with a
	// Move view copies the node as that view shows it, so security writes keep the after copies right.
	const view_node = async (moveView: files_saved_placement_FixedView | undefined) =>
		moveView ? await files_saved_placement_db_get_node(ctx.db, nodeId, moveView) : node;

	for (const { _id, _creationTime, ...hide } of hides) {
		if (!active) {
			await ctx.db.delete("files_pending_hides", _id);
			continue;
		}
		const viewNode = (await view_node(hide.moveView)) ?? node;
		await db_sync_doc(
			ctx.db,
			"files_pending_hides",
			{ _id, _creationTime, ...hide },
			{
				...hide,
				parentId: viewNode.parentId,
				kind: viewNode.kind,
				name: viewNode.name,
				lowercaseExtension: viewNode.lowercaseExtension,
				treePath: viewNode.treePath,
			},
		);
	}
	// The saved node job deletes the places of a hard deleted node, with their claim and folder effects.
	if (node)
		for (const place of places) {
			const viewNode = (await view_node(place.moveView)) ?? node;
			const patch = changed_fields(place, { kind: viewNode.kind, updatedAt: viewNode.updatedAt });
			if (Object.keys(patch).length > 0) await ctx.db.patch("files_pending_places", place._id, patch);
		}

	// An ancestor's move or rename changes the copied `treePath`, and its Move cohort syncs each node it
	// writes. An archive or restore writes the node itself too.
	if (await files_share_rows_db_node_changed(ctx.db, nodeId, old, node))
		await files_share_rows_db_sync_node(ctx.db, { ...scope, nodeId, node });

	const changed =
		!old ||
		!node ||
		old.parentId !== node.parentId ||
		old.name !== node.name ||
		(old.archiveOperationId === null) !== active ||
		old.treePath !== node.treePath;
	if (!changed) return;

	const proposal =
		hides.length > 0 || places.length > 0
			? null
			: await ctx.db
					.query("files_pending_updates")
					.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", nodeId))
					.first();
	const claimant =
		hides.length > 0 || places.length > 0 || proposal || !node
			? null
			: await ctx.db
					.query("files_pending_places")
					.withIndex("by_org_ws_parent_name", (q) =>
						q
							.eq("organizationId", organizationId)
							.eq("workspaceId", workspaceId)
							.eq("moveView.cohortId", undefined)
							.eq("moveView.view", undefined)
							.eq("parent.kind", node.parentId === "root" ? "root" : "saved")
							.eq("parent.id", node.parentId === "root" ? undefined : node.parentId)
							.eq("name", node.name),
					)
					.first();
	// Check the pending content sources too, even when no overlay doc needs a recompute.
	const pendingChunk =
		hides.length > 0 || places.length > 0 || proposal || claimant
			? null
			: await ctx.db
					.query("files_plain_text_chunks")
					.withIndex("by_organization_workspace_target_chunkIndex", (q) =>
						q
							.eq("organizationId", organizationId)
							.eq("workspaceId", workspaceId)
							.eq("target.kind", "saved")
							.eq("target.id", nodeId)
							.eq("moveView.cohortId", undefined)
							.eq("moveView.view", undefined),
					)
					.first();
	const pendingMetadata =
		hides.length > 0 || places.length > 0 || proposal || claimant || pendingChunk
			? null
			: await ctx.db
					.query("files_metadata_docs")
					.withIndex("by_organization_workspace_target_fieldPath", (q) =>
						q
							.eq("organizationId", organizationId)
							.eq("workspaceId", workspaceId)
							.eq("target.kind", "saved")
							.eq("target.id", nodeId)
							.eq("moveView.cohortId", undefined)
							.eq("moveView.view", undefined),
					)
					.first();
	if (hides.length > 0 || places.length > 0 || proposal || claimant || pendingChunk || pendingMetadata)
		await db_schedule_job(flush, scope, { kind: "saved_node", savedNodeId: nodeId });

	if (doc.kind === "folder") {
		const child = await ctx.db
			.query("files_pending_places")
			.withIndex("by_org_ws_parent_name", (q) =>
				q
					.eq("organizationId", organizationId)
					.eq("workspaceId", workspaceId)
					.eq("moveView.cohortId", undefined)
					.eq("moveView.view", undefined)
					.eq("parent.kind", "saved")
					.eq("parent.id", nodeId),
			)
			.first();
		const incoming = child
			? null
			: await ctx.db
					.query("files_pending_updates")
					.withIndex("by_pendingMove_destParent", (q) =>
						q.eq("pendingMove.destParent.kind", "saved").eq("pendingMove.destParent.id", nodeId),
					)
					.first();
		const privateChild =
			child || incoming
				? null
				: await ctx.db
						.query("files_pending_nodes")
						.withIndex("by_org_ws_parent_state_name", (q) =>
							q
								.eq("organizationId", organizationId)
								.eq("workspaceId", workspaceId)
								.eq("parent.kind", "saved")
								.eq("parent.id", nodeId)
								.eq("state", "active"),
						)
						.first();
		const typedChild =
			child || incoming || privateChild
				? null
				: await ctx.db
						.query("files_pending_type_entries")
						.withIndex("by_org_ws_parent_name", (q) =>
							q
								.eq("organizationId", organizationId)
								.eq("workspaceId", workspaceId)
								.eq("moveView.cohortId", undefined)
								.eq("moveView.view", undefined)
								.eq("parent.kind", "saved")
								.eq("parent.id", nodeId),
						)
						.first();
		if (child || incoming || privateChild || typedChild)
			await db_schedule_job(flush, scope, { kind: "parent", parent: { kind: "saved", id: nodeId } });
	}
}

/**
 * Run an owner path request inline, for the owner's own folder change. Returns false when
 * places are left for the job.
 */
async function db_inline_owner_path(flush: Flush, request: OwnerPathRequest) {
	const { ctx, state } = flush;
	let used = (await ctx.meta.getTransactionMetrics()).databaseQueries.used;
	// Add the ranges used since the last look to the step, and say whether it must stop.
	const spent = async () => {
		const now = (await ctx.meta.getTransactionMetrics()).databaseQueries.used;
		state.inlineStep.ranges += now - used;
		used = now;
		return used >= TRANSACTION_RANGES / 2 || state.inlineStep.ranges > INLINE_OWNER_PATH_RANGES;
	};
	if (await spent()) return false;

	const scope = { organizationId: request.organizationId, workspaceId: request.workspaceId, userId: request.userId };
	const upper = path_tree_prefix_upper_bound(request.prefix);
	for (const table of ["files_pending_places", "files_pending_type_entries"] as const) {
		for (const pathless of [false, true]) {
			const left = INLINE_OWNER_PATH_PLACES - state.inlineStep.places;
			const places = pathless
				? await ctx.db
						.query(table)
						.withIndex("by_org_ws_user_isPathless", (q) =>
							q
								.eq("organizationId", scope.organizationId)
								.eq("workspaceId", scope.workspaceId)
								.eq("userId", scope.userId)
								.eq("moveView.cohortId", undefined)
								.eq("moveView.view", undefined)
								.eq("isPathless", true),
						)
						.take(left + 1)
				: await ctx.db
						.query(table)
						.withIndex("by_org_ws_user_ownerTreePath", (q) =>
							q
								.eq("organizationId", scope.organizationId)
								.eq("workspaceId", scope.workspaceId)
								.eq("userId", scope.userId)
								.eq("moveView.cohortId", undefined)
								.eq("moveView.view", undefined)
								.gt("ownerTreePath", request.prefix)
								.lt("ownerTreePath", upper),
						)
						.take(left + 1);
			for (const place of places.slice(0, left)) {
				if (await spent()) return false;
				await db_recompute_target(flush, {
					...scope,
					target: place.target,
					pendingUpdateIds: new Set(),
					fieldsChanged: false,
					// Still the owner's own change: a folder found here may move the places under its other path.
					inline: true,
					ownWrite: false,
				});
				state.inlineStep.places++;
			}
			if (places.length > left) return false;
		}
	}
	// Every place is done. Count the last ranges for the next request of this transaction.
	await spent();
	return true;
}

async function db_flush_owner_paths(flush: Flush, requests: OwnerPathRequest[]) {
	const { ctx, state } = flush;
	const own = state.ownJob;
	const covers = (request: OwnerPathRequest, other: Scope & { prefix: string }) =>
		scope_key(other) === scope_key(request) && request.prefix.startsWith(other.prefix);
	// The running owner path job reaches the places under its prefix that come after the last place
	// it marked. A request whose places may be behind that place needs its own walk.
	const ahead = (request: OwnerPathRequest) =>
		own?.doc.kind === "owner_path" &&
		covers(request, own.doc) &&
		own.phase === 0 &&
		(own.lastPath === null || compareValues(own.lastPath, request.prefix) <= 0);

	// Drop a prefix under another prefix of the same user: that walk covers it.
	const kept = requests.filter(
		(request, index) =>
			!requests.some(
				(other, otherIndex) => covers(request, other) && (other.prefix !== request.prefix || otherIndex < index),
			) &&
			!ahead(request) &&
			![...state.walkedPrefixes].some((walked) => `${scope_key(request)}:${request.prefix}`.startsWith(walked)),
	);
	// The kept walk covers the dropped ones: when one was the owner's own change, walk it inline.
	for (const request of kept) request.inline ||= requests.some((other) => other.inline && covers(other, request));
	for (const request of kept) {
		const scope = { organizationId: request.organizationId, workspaceId: request.workspaceId, userId: request.userId };
		const under = await ctx.db
			.query("files_pending_places")
			.withIndex("by_org_ws_user_ownerTreePath", (q) =>
				q
					.eq("organizationId", scope.organizationId)
					.eq("workspaceId", scope.workspaceId)
					.eq("userId", scope.userId)
					.eq("moveView.cohortId", undefined)
					.eq("moveView.view", undefined)
					.gt("ownerTreePath", request.prefix)
					.lt("ownerTreePath", path_tree_prefix_upper_bound(request.prefix)),
			)
			.first();
		// Pathless places have no prefix, so every owner path walk also recomputes them.
		const pathless =
			under ??
			(await ctx.db
				.query("files_pending_places")
				.withIndex("by_org_ws_user_isPathless", (q) =>
					q
						.eq("organizationId", scope.organizationId)
						.eq("workspaceId", scope.workspaceId)
						.eq("userId", scope.userId)
						.eq("moveView.cohortId", undefined)
						.eq("moveView.view", undefined)
						.eq("isPathless", true),
				)
				.first());
		const typedUnder = pathless
			? null
			: await ctx.db
					.query("files_pending_type_entries")
					.withIndex("by_org_ws_user_ownerTreePath", (q) =>
						q
							.eq("organizationId", scope.organizationId)
							.eq("workspaceId", scope.workspaceId)
							.eq("userId", scope.userId)
							.eq("moveView.cohortId", undefined)
							.eq("moveView.view", undefined)
							.gt("ownerTreePath", request.prefix)
							.lt("ownerTreePath", path_tree_prefix_upper_bound(request.prefix)),
					)
					.first();
		const typedPathless =
			pathless || typedUnder
				? null
				: await ctx.db
						.query("files_pending_type_entries")
						.withIndex("by_org_ws_user_isPathless", (q) =>
							q
								.eq("organizationId", scope.organizationId)
								.eq("workspaceId", scope.workspaceId)
								.eq("userId", scope.userId)
								.eq("moveView.cohortId", undefined)
								.eq("moveView.view", undefined)
								.eq("isPathless", true),
						)
						.first();
		if (!pathless && !typedUnder && !typedPathless) continue;

		if (request.inline && state.inlineOwnerPaths && (await db_inline_owner_path(flush, request))) {
			state.walkedPrefixes.add(`${scope_key(request)}:${request.prefix}`);
			continue;
		}
		await db_schedule_job(flush, scope, { kind: "owner_path", userId: request.userId, prefix: request.prefix });
	}
}

// #endregion jobs

// #region flush

/**
 * Recompute every derived doc the captured writes changed, in rounds, until nothing is dirty.
 * Runs at the end of every wrapped mutation, before near-limit checks, and in the Discard unit.
 *
 * It never calls `.paginate()` (one per function, and jobs page) and never the near-limit check.
 */
export async function files_pending_overlay_db_flush(ctx: MutationCtx) {
	const state = (ctx as WrappedCtx)[FLUSH_MARKS];
	if (!state) return;
	// A job writes derived docs only, so its readers stay true across its flushes. Other
	// mutations write source docs between flushes, so their readers and walks start again.
	if (!state.ownJob) state.readers.clear();
	state.walkedPrefixes.clear();
	const flush: Flush = { ctx, state, listKeys: new Map() };

	for (let round = 0; ; round++) {
		const savedOld = state.savedOld;
		const targets = state.targets;
		const unknownProposalIds = state.unknownProposalIds;
		const unknownMetadataIds = state.unknownMetadataIds;
		const committedMetadataNodeIds = state.committedMetadataNodeIds;
		const grantIds = state.grantIds;
		if (
			savedOld.size +
				targets.size +
				unknownProposalIds.size +
				unknownMetadataIds.size +
				committedMetadataNodeIds.size +
				grantIds.size ===
			0
		)
			break;
		if (round >= MAX_FLUSH_ROUNDS) throw should_never_happen("Overlay flush did not settle", { round });
		state.savedOld = new Map();
		state.targets = new Map();
		state.unknownProposalIds = new Set();
		state.unknownMetadataIds = new Set();
		state.committedMetadataNodeIds = new Set();
		state.grantIds = new Set();

		for (const grantId of grantIds) await files_share_rows_db_sync_grant(ctx.db, grantId);

		// Owners of written docs the wrapper did not know.
		for (const id of unknownProposalIds) {
			const doc = await ctx.db.get("files_pending_updates", id);
			if (doc) mark_source_write(state, "files_pending_updates", id, null, doc);
		}
		for (const id of unknownMetadataIds) {
			const doc = await ctx.db.get("files_metadata_docs", id);
			if (doc) mark_source_write(state, "files_metadata_docs", id, null, doc);
		}
		for (const [key, mark] of state.targets) {
			targets.set(key, mark);
			state.targets.delete(key);
		}
		for (const id of state.committedMetadataNodeIds) committedMetadataNodeIds.add(id);
		state.committedMetadataNodeIds.clear();

		const savedNodes = [];
		for (const [nodeId, old] of savedOld)
			savedNodes.push({ nodeId, old: await old, node: await ctx.db.get("files_nodes", nodeId) });
		for (const { node, old } of savedNodes) {
			const doc = node ?? old;
			const organizationId = doc && ctx.db.normalizeId("organizations", doc.organizationId);
			const workspaceId = doc && ctx.db.normalizeId("organizations_workspaces", doc.workspaceId);
			if (
				organizationId &&
				workspaceId &&
				(!old ||
					!node ||
					old.treePath !== node.treePath ||
					old.parentId !== node.parentId ||
					old.name !== node.name ||
					old.contentType !== node.contentType ||
					old.contentTypeEssence !== node.contentTypeEssence ||
					old.contentTypeFamily !== node.contentTypeFamily ||
					old.archiveOperationId !== node.archiveOperationId)
			)
				state.factScopes.set(`${organizationId}:${workspaceId}`, { organizationId, workspaceId });
		}
		for (const [key, scope] of state.factScopes) {
			if (!state.factScopesChanged.has(key)) {
				await files_pending_review_facts_db_change_state(ctx.db, scope, { structural: true });
				state.factScopesChanged.add(key);
			}
		}
		await db_flush_ancestors(flush, savedNodes);
		for (const { nodeId, old, node } of savedNodes) await db_flush_saved_node(flush, nodeId, old, node);

		// Fields of a moved saved node follow its committed metadata.
		for (const nodeId of committedMetadataNodeIds) {
			const node = await ctx.db.get("files_nodes", nodeId);
			if (node) await files_pending_overlay_db_schedule_saved_places(ctx, node, { fieldsChanged: true });
		}

		// A write to the drafts of more than one user (another user's write, a cron, a purge) sends
		// each user's recompute to a job, so its cost does not grow with the number of users. One
		// user's own write, and the accepting user's part of an Accept, stay exact at once. Marks
		// of jobs and repairs run here.
		const owners = new Set<string>();
		for (const mark of targets.values()) if (mark.inline) owners.add(mark.userId);
		for (const mark of targets.values())
			if (owners.size > 1 && mark.inline && mark.userId !== state.actingUserId) {
				defer_target(state, mark);
				// The job does not get the old spot of a closed private node.
				await db_mark_old_claims(flush, mark, true);
			} else await db_recompute_target(flush, mark);

		for (const listKey of flush.listKeys.values()) await files_pending_overlay_db_sync_list_key(ctx.db, listKey);
		flush.listKeys.clear();

		// Guards run after the round's writes. The inline step adds requests for the folders it moves,
		// so run until none is left; INLINE_OWNER_PATH_PLACES bounds the inline work.
		while (state.ownerPathRequests.length > 0) {
			const requests = state.ownerPathRequests;
			state.ownerPathRequests = [];
			await db_flush_owner_paths(flush, requests);
		}
	}

	// After the rounds, so a metadata-only write that marks nothing still inserts its deltas.
	await files_metadata_catalog_db_insert_deltas(ctx, state.catalogChanges);

	// Every place fields sync goes to the job, one job doc per workspace and JOB_LIST_ITEMS places.
	const byWorkspace = new Map<string, { scope: Omit<Scope, "userId">; placeIds: Id<"files_pending_places">[] }>();
	for (const [placeId, scope] of state.placeFieldIds) {
		const key = `${scope.organizationId}:${scope.workspaceId}`;
		const group = byWorkspace.get(key) ?? { scope, placeIds: [] };
		group.placeIds.push(placeId);
		byWorkspace.set(key, group);
	}
	state.placeFieldIds.clear();
	for (const { scope, placeIds } of byWorkspace.values())
		for (let index = 0; index < placeIds.length; index += JOB_LIST_ITEMS)
			await db_schedule_job(
				flush,
				{ organizationId: scope.organizationId, workspaceId: scope.workspaceId },
				{ kind: "place_fields", placeIds: placeIds.slice(index, index + JOB_LIST_ITEMS) },
			);

	const deferred = [...state.deferred.values()];
	state.deferred.clear();
	for (const { items, ...scope } of deferred)
		for (let index = 0; index < items.length; index += JOB_LIST_ITEMS)
			await db_schedule_job(
				flush,
				{ organizationId: scope.organizationId, workspaceId: scope.workspaceId },
				{ kind: "targets", userId: scope.userId, items: items.slice(index, index + JOB_LIST_ITEMS) },
			);
	await files_content_heads_db_flush(ctx);
}

// #endregion flush

// #region reads

/**
 * One index range of an exact window: equal fields, then one bounded field.
 */
type WindowRange = {
	eq: Array<[field: string, value: Value]>;
	lower: { field: string; value: Value; inclusive: boolean } | null;
	upper: { field: string; value: Value; inclusive: boolean } | null;
};

/**
 * The index ranges that hold exactly the keys from `first` to `last` (both included), for key
 * `fields` after the equality prefix. Convex ranges bound one field only, so a multi-field key is
 * split: at most `2k - 1` ranges for `k` fields. For `desc` pages `first` is the larger key.
 */
export function files_pending_overlay_window_ranges(args: {
	fields: string[];
	first: Value[];
	last: Value[];
	order: "asc" | "desc";
}) {
	const { fields } = args;
	const [low, high] = args.order === "asc" ? [args.first, args.last] : [args.last, args.first];

	// Keys from `low` on, under `eq`.
	const from = (eq: WindowRange["eq"], index: number): WindowRange[] => {
		const field = fields[index]!;
		const value = low[index]!;
		if (index === fields.length - 1) return [{ eq, lower: { field, value, inclusive: true }, upper: null }];
		return [
			{ eq, lower: { field, value, inclusive: false }, upper: null },
			...from([...eq, [field, value]], index + 1),
		];
	};
	// Keys up to `high`, under `eq`.
	const to = (eq: WindowRange["eq"], index: number): WindowRange[] => {
		const field = fields[index]!;
		const value = high[index]!;
		if (index === fields.length - 1) return [{ eq, lower: null, upper: { field, value, inclusive: true } }];
		return [...to([...eq, [field, value]], index + 1), { eq, lower: null, upper: { field, value, inclusive: false } }];
	};
	const split = (eq: WindowRange["eq"], index: number): WindowRange[] => {
		if (index === fields.length) return [{ eq, lower: null, upper: null }];
		const field = fields[index]!;
		const a = low[index]!;
		const b = high[index]!;
		if (compareValues(a, b) === 0) return split([...eq, [field, a]], index + 1);
		if (index === fields.length - 1)
			return [{ eq, lower: { field, value: a, inclusive: true }, upper: { field, value: b, inclusive: true } }];
		return [
			...from([...eq, [field, a]], index + 1),
			{ eq, lower: { field, value: a, inclusive: false }, upper: { field, value: b, inclusive: false } },
			...to([...eq, [field, b]], index + 1),
		];
	};
	return split([], 0);
}

/**
 * Whether a transaction used the read budget of agent listings.
 */
export function files_pending_overlay_list_over_budget(metrics: TransactionMetrics) {
	return (
		metrics.databaseQueries.used > LIST_BUDGET.ranges ||
		metrics.documentsRead.used > LIST_BUDGET.documents ||
		metrics.bytesRead.used > LIST_BUDGET.bytes
	);
}

/**
 * Whether a Move step may join one more small sub-step of the same unit. It flushes first, so the next
 * sub-step reads fresh derived docs and the metrics count the derived writes. Join only while each
 * used metric is below 1/16 of its limit. Initial cohort work uses 1/4; parent pages still yield.
 * The next unit and final flush need their measured reserve.
 */
export async function files_pending_overlay_db_can_join_step(ctx: MutationCtx, limitFactor: 4 | 16 = 16) {
	await files_pending_overlay_db_flush(ctx);
	const metrics = await ctx.meta.getTransactionMetrics();
	return Object.values(metrics).every((metric) => metric.used * limitFactor < metric.used + metric.remaining);
}

// The cursors below use Convex validators, not zod. This module is on the file open path, and
// loading zod there made each file open slower. See "External data validation" in AGENTS.md.
const saved_source_validator = v.union(
	v.object({ kind: v.literal("normal"), generation: v.number() }),
	v.object({
		kind: v.literal("cohort"),
		cohortId: v.string(),
		view: v.union(v.literal("before"), v.literal("after")),
		generation: v.number(),
	}),
);

const moved_in_validator = v.union(v.object({ savedNodeId: v.string(), ownerTreePath: v.string() }), v.null());

const list_cursor_validator = v.object({
	scope: v.string(),
	root: v.string(),
	/** At most 256 streams, each with a positive integer `numItems`. The parse checks it by hand. */
	streams: v.array(
		v.object({
			kind: v.union(
				v.literal("saved"),
				v.literal("places"),
				v.literal("moved_in"),
				v.literal("nested"),
				v.literal("pending"),
			),
			movedIn: moved_in_validator,
			numItems: v.number(),
			position: v.object({
				rangeStart: v.union(v.string(), v.null()),
				cursor: v.union(v.string(), v.null()),
				lastKey: v.union(v.array(v.any()), v.null()),
			}),
			savedStream: saved_source_validator,
			indexStream: v.optional(saved_source_validator),
			seek: v.optional(v.union(v.object({ key: v.array(v.any()), inclusive: v.boolean() }), v.null())),
			parentAlias: v.optional(
				v.union(
					v.object({ kind: v.literal("root") }),
					v.object({ kind: v.union(v.literal("saved"), v.literal("private")), id: v.string() }),
					v.null(),
				),
			),
		}),
	),
});

/**
 * The `movedIn` arg of a nested stream's query. Other streams pass none.
 */
function moved_in_args(movedIn: { savedNodeId: string; ownerTreePath: string } | null) {
	return movedIn
		? { movedIn: { savedNodeId: movedIn.savedNodeId as Id<"files_nodes">, ownerTreePath: movedIn.ownerTreePath } }
		: {};
}

/**
 * One page of an agent listing: the children of a folder, the subtree under it (path order), or the
 * metadata rows one `meta search` plan matches under it.
 *
 * Merges the saved stream, the user's place stream and, in a subtree, one saved stream per folder the
 * user moved in by a draft. A row shows only when every open stream has read past its key; ties go by
 * stream order. In a subtree and in a metadata `exists` or `eq` listing each saved stream is a walk
 * (`server/files-tree-walk.ts`) over every saved source: it does not enter locked folders, and a
 * subtree returns their paths in `denied`. A subtree with an `updated` window (`find -mmin`) reads
 * an area newest first when the folder holds it whole or the window has a start (`-N`); when the start
 * frame reads that way, it opens no moved-in streams.
 * Used by `ls`, `find`, `tree`, `meta search`, the skills catalog and transfer
 * discovery, so it takes any ctx that can run a query.
 *
 * Nested queries share the caller's transaction. When the caller is a query or a mutation, the merge
 * starts no stream call past the read budget and returns a short page with a cursor instead.
 * Do not call it from a query: the backend allows one paginated read per query, nested queries
 * included, and the merge runs several. Call it from an action or a mutation. Mutations have no such
 * limit.
 */
export async function files_pending_overlay_list(
	ctx: Pick<ActionCtx, "runQuery"> & { meta?: ActionCtx["meta"] | QueryCtx["meta"] },
	args: {
		agentSource?: Infer<typeof ai_chat_workspaces_source_validator>;
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		visibilityUserId: Id<"users">;
		subject: access_control_Subject;
		overlayUserId?: Id<"users">;
		requireComplete?: boolean;
		folderPath: string;
		mode: "children" | "subtree" | "metadata";
		/**
		 * Children only.
		 */
		orderBy?: "name" | "updatedAt";
		/**
		 * Metadata only.
		 */
		plan?: Infer<typeof files_metadata_search_plan_validator>;
		order: "asc" | "desc";
		kind?: "file" | "folder";
		lowercaseExtension?: string;
		/**
		 * Subtree only, for `find -mmin` / `-mtime`: keep rows whose `updatedAt` is in this window (both
		 * ends included, null is no bound). With `from`, each area is read by update time, newest first.
		 * With only `to`, so is each area the folder holds whole; the rest reads in path order.
		 */
		updated?: { from: number | null; to: number | null };
		/**
		 * For the UI search box: a walk of a root the caller cannot open finds what it can read, instead of
		 * "Permission denied".
		 */
		searchLockedRoot?: boolean;
		numItems: number;
		cursor: string | null;
	},
): Promise<files_visible_list_Result> {
	const { order } = args;
	const overlay = args.overlayUserId === args.visibilityUserId && access_control_subject_reads_drafts(args.subject);
	// A descending subtree would meet a moved-in folder after its own rows, so only saved-only reads
	// may use it (mount listings).
	if (args.mode === "subtree" && order === "desc" && overlay)
		throw should_never_happen("Agent subtree listings with drafts read in path order only", {
			folderPath: args.folderPath,
		});

	const streamArgs = {
		agentSource: args.agentSource,
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		visibilityUserId: args.visibilityUserId,
		subject: args.subject,
		overlayUserId: args.overlayUserId,
		requireComplete: args.requireComplete,
		folderPath: args.folderPath,
	};
	const filter = {
		...(args.kind === undefined ? {} : { kind: args.kind }),
		...(args.lowercaseExtension === undefined ? {} : { lowercaseExtension: args.lowercaseExtension }),
	};
	const view: files_saved_placement_View | null = await ctx.runQuery(
		internal.files_visible.internal_get_move_view,
		streamArgs,
	);
	if (!view) return Result({ _yay: { items: [], continueCursor: null, isDone: true } });
	const savedSources: files_SavedStream[] = [
		{ kind: "normal", generation: view.generation },
		...(view.cohortId && view.view
			? [{ kind: "cohort" as const, cohortId: view.cohortId, view: view.view, generation: view.generation }]
			: []),
	];
	// Read the source docs first. A move between these reads can duplicate a doc,
	// but cannot make both reads miss it. Later reads of the first source break this, so the round
	// loop limits them.
	if (view.migrationDirection === "to_normal") savedSources.reverse();
	const indexView = args.mode === "metadata"
		? await ctx.runQuery(internal.files_visible.internal_get_index_view, streamArgs)
		: null;
	if (args.mode === "metadata" && !indexView)
		return Result({ _yay: { items: [], continueCursor: null, isDone: true } });
	const indexSources: files_IndexStream[] = indexView
		? [
				{ kind: "normal", generation: indexView.generation },
				...(indexView.cohortId && indexView.view
					? [{ kind: "cohort" as const, cohortId: indexView.cohortId, view: indexView.view, generation: indexView.generation }]
					: []),
			]
		: savedSources;
	if (indexView?.migrationDirection === "to_normal") indexSources.reverse();
	const scope = JSON.stringify([
		args.organizationId,
		args.workspaceId,
		args.visibilityUserId,
		args.subject,
		args.overlayUserId,
		args.folderPath,
		args.mode,
		args.orderBy,
		order,
		args.kind,
		args.lowercaseExtension,
		args.requireComplete,
		args.plan,
		args.updated,
		[view.cohortId, view.view, view.generation, view.migrationDirection],
		indexView && [indexView.cohortId, indexView.view, indexView.generation, indexView.migrationDirection],
	]);
	const pageSize = Math.max(1, Math.floor(args.numItems));
	const plan = args.plan;
	if (args.mode === "metadata" && !plan)
		throw should_never_happen("Metadata listings need a plan", { folderPath: args.folderPath });
	const walk =
		(args.mode === "subtree" && order === "asc") ||
		(args.mode === "metadata" && (plan?.op === "exists" || plan?.op === "eq"));
	const updated = args.mode === "subtree" && args.updated ? { updated: args.updated } : {};
	// `find -mmin` / `-mtime` read an area by update time (`files_tree_walk_time_key`): always with a
	// window start (`-N`). With only `+N` the time index would read every old row of the area, so it
	// serves only an area the folder holds whole: one inside the folder, or the folder's own area when
	// the folder is its top. Other frames walk in path order and drop the newer rows.
	const timeWindow = walk && args.mode === "subtree" && args.updated ? args.updated : null;
	const by_time = (areaTop: boolean) => timeWindow !== null && (timeWindow.from !== null || areaTop);
	// The Move view's places name every node of the cohort, so the frames read in that view.
	const viewStream = savedSources.find((source) => source.kind === "cohort") ?? savedSources[0]!;
	const open_walk = (movedIn: ReturnType<typeof moved_in_args>) =>
		ctx.runQuery(internal.files_visible.internal_get_walk_start, {
			...streamArgs,
			...movedIn,
			savedStream: viewStream,
			searchLockedRoot: args.searchLockedRoot,
		});
	// With only `+N` the place streams follow the start frame's order, so read the start first.
	const startOpened = timeWindow?.from === null ? await open_walk({}) : null;
	if (startOpened?._nay) return startOpened;
	const startByTime = by_time(startOpened?._yay.areaTop ?? false);

	type CursorStream = Infer<typeof list_cursor_validator>["streams"][number];
	type StreamResult = files_visible_stream_Result | { _nay: { message: string; name?: string }; _yay?: undefined };
	type Row = NonNullable<files_visible_stream_Result["_yay"]>["rows"][number] & {
		/**
		 * Walk rows only: a locked folder the walk did not enter.
		 */
		denied?: string;
	};
	type Stream = CursorStream & {
		/**
		 * False once nothing is left after `buffer`.
		 */
		open: boolean;
		buffer: Row[];
		frontier: Value[] | null;
		after: { position: CursorStream["position"]; done: boolean };
		/**
		 * True once a call of this page returned rows, a frontier, or the end.
		 */
		hasRead: boolean;
		/**
		 * A walk stream in this page: its start, and the frames above its cursor's top frame, so the
		 * next merge round reads neither again.
		 */
		walk?: {
			root: NonNullable<files_visible_stream_Result["_yay"]>["root"];
			start: { scopeNodeId: Id<"files_nodes"> | null; treePath: string } | null;
			/** Whether the start frame reads by update time (`by_time`). */
			startByTime: boolean;
			frames: { cursor: string; frames: NonNullable<Infer<typeof files_tree_walk_stack_validator>> } | null;
		};
	};

	const start = { rangeStart: null, cursor: null, lastKey: null };
	const parentAliases =
		overlay && args.mode === "children"
			? await ctx.runQuery(internal.files_visible.internal_get_list_parent_aliases, {
					...streamArgs,
					savedStream: savedSources[0]!,
				})
			: [null];
	let root: string | null = null;
	let cursorStreams: CursorStream[];
	if (args.cursor === null) {
		cursorStreams = savedSources.flatMap((savedStream, index) => [
			// A walk reads every saved source itself.
			...(args.mode === "metadata" || (walk && index > 0)
				? []
				: [{ kind: "saved" as const, movedIn: null, numItems: pageSize, position: start, savedStream }]),
			...(overlay
				? parentAliases.map((parentAlias) => ({
						kind: "places" as const,
						movedIn: null,
						numItems: pageSize,
						position: start,
						savedStream,
						parentAlias,
					}))
				: []),
			// A filter that leaves folders out does not meet moved-in folders in the place stream. Metadata
			// `exists` and `eq` read the folder's range, so they need them too; with no folder, and for
			// `prefix` and `range`, the saved stream reads the whole workspace and meets their rows.
			...(overlay &&
			((args.mode === "subtree" && !startByTime && (args.kind === "file" || args.lowercaseExtension !== undefined)) ||
				(args.mode === "metadata" &&
					(plan?.op === "exists" || plan?.op === "eq") &&
					server_path_normalize(args.folderPath) !== "/"))
				? [{ kind: "moved_in" as const, movedIn: null, numItems: pageSize, position: start, savedStream }]
				: []),
			// The frontmatter of the user's text drafts of saved files.
		]);
		if (args.mode === "metadata") {
	// Metadata docs can move between index views while tree and draft docs stay in place.
			cursorStreams.unshift(...(walk ? indexSources.slice(0, 1) : indexSources).map((indexStream) => ({
				kind: "saved" as const,
				movedIn: null,
				numItems: pageSize,
				position: start,
				savedStream: viewStream,
				indexStream,
			})));
		}
		if (overlay && args.mode === "metadata")
			cursorStreams.push({
				kind: "pending",
				movedIn: null,
				numItems: pageSize,
				position: start,
				savedStream: { kind: "normal", generation: view.generation },
			});
	} else {
		let raw: unknown;
		try {
			raw = JSON.parse(args.cursor);
		} catch {
			return Result({
				_nay: { message: "cursor is invalid; rerun the original command to get a fresh Next page cursor." },
			});
		}
		if (
			!validate(list_cursor_validator, raw) ||
			raw.scope !== scope ||
			raw.streams.length > 256 ||
			!raw.streams.every((stream) => Number.isInteger(stream.numItems) && stream.numItems > 0)
		)
			return Result({
				_nay: {
					message: "cursor does not match this listing; rerun the original command to get a fresh Next page cursor.",
				},
			});
		root = raw.root;
		cursorStreams = raw.streams;
	}
	const is_walk = (stream: Pick<CursorStream, "kind">) => walk && (stream.kind === "saved" || stream.kind === "nested");
	const is_migrating = (stream: CursorStream) =>
		stream.kind !== "pending" && (stream.indexStream ? indexView?.cohortId : view.cohortId) != null;
	const streams: Stream[] = cursorStreams.map((stream) => ({
		...stream,
		position: is_migrating(stream) && !is_walk(stream) ? start : stream.position,
		open: true,
		buffer: [],
		frontier: null,
		after: { position: stream.position, done: false },
		hasRead: false,
	}));

	// A walk stream: the saved rows under the folder, one restricted area at a time, over every saved
	// source. Its position holds the walk cursor. Every walk stream of the page shares one budget of
	// stream calls, since the merge below can run a walk once per round.
	let walkCalls = 0;
	const run_walk = async (stream: Stream): Promise<StreamResult> => {
		const movedIn = moved_in_args(stream.movedIn);
		let cursor = null;
		if (stream.position.cursor !== null) {
			const parsed: unknown = JSON.parse(stream.position.cursor);
			if (!validate(files_tree_walk_cursor_validator, parsed))
				return Result({
					_nay: { message: "cursor is invalid; rerun the original command to get a fresh Next page cursor." },
				});
			cursor = parsed;
		}
		if (!stream.walk) {
			const opened = stream.movedIn === null && startOpened ? startOpened : await open_walk(movedIn);
			if (opened._nay) return opened;
			stream.walk = {
				root: opened._yay.root,
				start: opened._yay.start,
				startByTime: by_time(opened._yay.areaTop),
				frames: null,
			};
		}
		const walk = stream.walk;
		const { root: walkRoot, start: walkStart } = walk;
		if (walkStart === null || walkRoot === null)
			return Result({
				_yay: { root: walkRoot, rows: [], frontier: null, position: start, done: true, decided: 0, overBudget: false },
			});

		// A failed stream call ends the walk with its answer.
		let failed: StreamResult | null = null;
		const stopped = new Error("The walk stopped on a failed stream call");
		const yay_of = <T extends { _nay?: unknown; _yay?: unknown }>(result: T) => {
			if (result._nay) {
				failed = result as unknown as typeof failed;
				throw stopped;
			}
			return result._yay as NonNullable<T["_yay"]>;
		};
		const common = { ...streamArgs, ...movedIn, position: start };
		try {
			const walked = await files_tree_walk_page<Row>({
				// A metadata search inside a folder lists the folder too; `ls -R`, `find` and `tree` leave it out.
				start: { ...walkStart, kind: "folder", withRoot: args.mode === "metadata" },
				cursor,
				numItems: stream.numItems,
				maxCalls: files_tree_walk_MAX_CALLS - walkCalls,
				rows: (args.mode === "metadata" ? indexSources : savedSources).map((source) => async (frame, numItems) => {
					const yay = yay_of(
						args.mode === "metadata"
							? await ctx.runQuery(internal.files_visible.internal_search_metadata_saved, {
									...common,
									plan: plan!,
									numItems,
									savedStream: viewStream,
									indexStream: source,
									frame,
								})
							: timeWindow && (walk.startByTime || frame.treePath !== walkStart.treePath)
								? await ctx.runQuery(internal.files_visible.internal_list_subtree_recent_saved, {
										...streamArgs,
										position: start,
										...filter,
										numItems,
										savedStream: source as files_SavedStream,
										frame,
										updated: timeWindow,
									})
								: await ctx.runQuery(internal.files_visible.internal_list_subtree_saved, {
										...common,
										...filter,
										...updated,
										order,
										numItems,
										savedStream: source as files_SavedStream,
										frame,
									}),
					);
					return {
						items: yay.rows.map((row) => ({ key: row.position.lastKey!, value: row as Row })),
						frontier: yay.frontier,
						phaseCount: ("phaseCount" in yay ? yay.phaseCount : undefined) ?? 1,
						isDone: yay.done,
					};
				}),
				boundaries: savedSources.map((savedStream) => async (frame, numItems) => {
					const yay = yay_of(
						await ctx.runQuery(internal.files_visible.internal_list_subtree_boundaries, {
							...common,
							...filter,
							...updated,
							numItems,
							savedStream,
							frame,
							withRows: args.mode === "subtree",
						}),
					);
					return {
						...yay,
						items: yay.boundaries.map(({ key, ...boundary }) => ({ key, value: boundary })),
					};
				}),
				// Read once per page. Its own query keeps its reads apart from the start's folder lookup.
				resolve_stack: async (top) =>
					walk.frames?.cursor === stream.position.cursor
						? walk.frames.frames
						: await ctx.runQuery(internal.files_visible.internal_resolve_walk_stack, {
								...streamArgs,
								savedStream: viewStream,
								start: walkStart,
								top,
							}),
			});
			walkCalls += walked.calls;
			walk.frames = walked.cursor && { cursor: JSON.stringify(walked.cursor), frames: walked.frames };
			const rows: Row[] = walked.entries.map((entry) => {
				const position = { rangeStart: null, cursor: JSON.stringify(entry.cursor), lastKey: null };
				// A locked folder that does not match the filter only prints its "Permission denied" line.
				const row: Row = entry.row ?? { key: [`${entry.denied}/`, entry.key[2], entry.key[3]], item: null, position };
				return { ...row, position, ...(entry.denied === null ? {} : { denied: entry.denied }) };
			});
			return Result({
				_yay: {
					root: walkRoot,
					rows,
					frontier: rows.at(-1)?.key ?? null,
					position: walked.cursor ? { rangeStart: null, cursor: JSON.stringify(walked.cursor), lastKey: null } : start,
					done: walked.cursor === null,
					decided: rows.length,
					overBudget: false,
				},
			});
		} catch (error) {
			if (error === stopped && failed) return failed;
			// A frame above the cursor changed, or the start did.
			if (error instanceof ConvexError && error.data?.paginationError === "InvalidCursor")
				return Result({
					_nay: { message: "the folder changed since the last page; rerun the original command without --cursor." },
				});
			throw error;
		}
	};

	const run = (stream: Stream): Promise<StreamResult> => {
		if (is_walk(stream)) return run_walk(stream);
		const common = {
			...streamArgs,
			numItems: stream.numItems,
			position: stream.position,
			savedStream: stream.savedStream as files_SavedStream,
			...(is_migrating(stream) ? { seek: stream.seek ?? { key: [], inclusive: true } } : {}),
		};
		const orderBy = args.orderBy ?? "name";
		const movedIn = moved_in_args(stream.movedIn);
		if (args.mode === "metadata") {
			const metadataArgs = { ...common, plan: plan! };
			return (
				stream.kind === "places"
					? ctx.runQuery(internal.files_visible.internal_search_metadata_places, metadataArgs)
					: stream.kind === "pending"
						? ctx.runQuery(internal.files_visible.internal_search_metadata_pending, metadataArgs)
						: stream.kind === "moved_in"
							? ctx.runQuery(internal.files_visible.internal_list_subtree_moved_in_folders, {
									...common,
									outsideOnly: true,
								})
							: ctx.runQuery(internal.files_visible.internal_search_metadata_saved, {
									...metadataArgs,
									...movedIn,
									indexStream: stream.indexStream as files_IndexStream,
								})
			) as Promise<files_visible_stream_Result>;
		}
		const query =
			args.mode === "children"
				? stream.kind === "saved"
					? ctx.runQuery(internal.files_visible.internal_list_children_saved, {
							...common,
							...filter,
							orderBy,
							order,
						})
					: ctx.runQuery(internal.files_visible.internal_list_children_places, {
							...common,
							...filter,
							...(stream.parentAlias ? { parentAlias: stream.parentAlias as files_PendingParent } : {}),
							orderBy,
							order,
						})
				: stream.kind === "places"
					? timeWindow && startByTime
						? ctx.runQuery(internal.files_visible.internal_list_subtree_recent_places, {
								...common,
								...filter,
								updated: timeWindow,
							})
						: ctx.runQuery(internal.files_visible.internal_list_subtree_places, { ...common, ...filter, ...updated })
					: stream.kind === "moved_in"
						? ctx.runQuery(internal.files_visible.internal_list_subtree_moved_in_folders, common)
						: ctx.runQuery(internal.files_visible.internal_list_subtree_saved, {
								...common,
								...filter,
								...updated,
								order,
								...movedIn,
							});
		return query as Promise<files_visible_stream_Result>;
	};

	const sign = order === "asc" ? 1 : -1;
	const compare = (a: Value[], b: Value[]) => sign * compareValues(a, b);

	// A metadata row also says which value it matched.
	const items: Array<NonNullable<Row["item"]> & { match?: Row["match"] }> = [];
	const denied: string[] = [];
	const seen = new Set<string>();
	let rounds = 0;
	let progressed = false;
	let overBudget = false;
	while (items.length < pageSize && !overBudget) {
		// The next row: the smallest buffered key, ties by stream order.
		let next: { stream: Stream; rank: number } | null = null;
		for (const [rank, stream] of streams.entries()) {
			const head = stream.buffer[0];
			if (head && (!next || compare(head.key, next.stream.buffer[0]!.key) < 0)) next = { stream, rank };
		}
		// A stream with nothing buffered blocks the next row until it has read past that row's key.
		const blocking = streams.filter((stream, rank) => {
			if (!stream.open || stream.buffer.length > 0) return false;
			if (!next || stream.frontier === null) return true;
			const comparison = compare(stream.frontier, next.stream.buffer[0]!.key);
			return comparison < 0 || (comparison === 0 && rank < next.rank);
		});

		// While a Move runs, docs leave the first source of a pair for the second one. If the first
		// source read again after the second one read the same keys, a doc that moved in between would
		// be in neither read. So the first source reads rows once per page, and the page ends when it
		// needs more. The next page seeks both sources again from a key no later than its frontier. Calls
		// that only cross an empty seek phase read no rows, so they do not count.
		const runnable = blocking.filter((stream) =>
			(!is_migrating(stream) || is_walk(stream) || !stream.hasRead ||
				(stream.indexStream ?? stream.savedStream).kind !== (stream.indexStream ? indexSources : savedSources)[0]!.kind) &&
			(!is_walk(stream) || walkCalls < files_tree_walk_MAX_CALLS),
		);
		if (blocking.length > 0) {
			if (runnable.length === 0 || rounds === LIST_MAX_ROUNDS) break;
			rounds++;
			// One stream at a time: transfer discovery calls this from a mutation, and Convex does not
			// promise that nested `runQuery` calls may run in parallel there.
			for (const stream of runnable) {
				// Only after the cursor moved, so every page makes progress: buffered rows of one stream
				// do not move it while another stream still blocks them. Actions have no transaction metrics.
				if (progressed && ctx.meta && "getTransactionMetrics" in ctx.meta) {
					overBudget = files_pending_overlay_list_over_budget(await ctx.meta.getTransactionMetrics());
					if (overBudget) break;
				}
				const result = await run(stream);
				if (result._nay) return result;
				const rootKey = JSON.stringify(result._yay.root);
				if (root !== null && rootKey !== root)
					return Result({
						_nay: { message: "the folder changed since the last page; rerun the original command without --cursor." },
					});
				root = rootKey;

				const { rows, decided } = result._yay;
				stream.hasRead ||= rows.length > 0 || result._yay.frontier !== null || result._yay.done;
				stream.buffer = [...rows];
				stream.frontier = result._yay.frontier;
				stream.after = { position: result._yay.position, done: result._yay.done };
				if (rows.length === 0) {
					stream.position = result._yay.position;
					stream.open = !result._yay.done;
					progressed = true;
				}
				// Double the page after a call that kept less than half its rows. A call that stopped on the
				// read budget keeps its page, because a bigger page would stop again.
				if (!result._yay.overBudget)
					stream.numItems =
						rows.length * 2 < decided ? Math.min(stream.numItems * 2, pageSize + LIST_PAGE_GROWTH) : pageSize;
			}
			continue;
		}
		if (!next) break;

		const { stream } = next;
		const row = stream.buffer.shift()!;
		progressed = true;
		if (stream.buffer.length > 0) stream.position = row.position;
		else {
			stream.position = stream.after.position;
			stream.open = !stream.after.done;
		}
		if (row.movedIn && !streams.some((other) => other.movedIn?.savedNodeId === row.movedIn!.savedNodeId)) {
			const sources = args.mode === "metadata" ? indexSources : savedSources;
			for (const source of walk ? sources.slice(0, 1) : sources)
				streams.push({
					kind: "nested",
					movedIn: row.movedIn,
					numItems: pageSize,
					position: start,
					savedStream: args.mode === "metadata" ? viewStream : source as files_SavedStream,
					...(args.mode === "metadata" ? { indexStream: source } : {}),
					open: true,
					buffer: [],
					frontier: null,
					after: { position: start, done: false },
					hasRead: false,
				});
		}
		if (row.denied !== undefined && args.mode === "subtree") denied.push(row.denied);
		// Two calls read different snapshots, so a moved row can come from two streams.
		if (row.item && !seen.has(row.item.target.id)) {
			seen.add(row.item.target.id);
			items.push(row.match ? { ...row.item, match: row.match } : row.item);
		}
	}

	const pairKey = (stream: Stream) => JSON.stringify([stream.kind, stream.movedIn, stream.parentAlias]);
	// The pair shares a full-key frontier. Keep an empty source beside its open partner: docs can
	// move into that source during staging or cleanup before the next page.
	const left = streams.filter((stream) => is_migrating(stream)
		? streams.some((other) => pairKey(other) === pairKey(stream) && other.open)
		: stream.open,
	);
	if (view.cohortId || indexView?.cohortId) {
		for (const stream of left) {
			if (!is_migrating(stream) || is_walk(stream)) continue;
			let seek: { key: Value[]; inclusive: boolean } | null = null;
			let undecided = false;
			for (const other of left) {
				if (pairKey(other) !== pairKey(stream) || !other.open) continue;
				const head = other.buffer[0];
				const candidate = head
					? { key: head.key, inclusive: true }
					: other.frontier
						? { key: other.frontier, inclusive: false }
						: null;
				if (!candidate) {
					undecided = true;
					break;
				}
				const compared = seek ? compare(candidate.key, seek.key) : -1;
				if (compared < 0 || (compared === 0 && candidate.inclusive)) seek = candidate;
			}
			if (!undecided && seek) stream.seek = seek;
		}
	}
	const finalView = await ctx.runQuery(internal.files_visible.internal_get_move_view, streamArgs);
	const finalIndexView = indexView
		? await ctx.runQuery(internal.files_visible.internal_get_index_view, streamArgs)
		: null;
	if (
		!finalView ||
		finalView.cohortId !== view.cohortId ||
		finalView.view !== view.view ||
		finalView.generation !== view.generation ||
		finalView.migrationDirection !== view.migrationDirection ||
		finalIndexView?.cohortId !== indexView?.cohortId ||
		finalIndexView?.view !== indexView?.view ||
		finalIndexView?.generation !== indexView?.generation ||
		finalIndexView?.migrationDirection !== indexView?.migrationDirection
	)
		return Result({ _nay: { message: "Listing changed. Start again." } });
	return Result({
		_yay: {
			items,
			...(denied.length > 0 ? { denied } : {}),
			continueCursor:
				left.length === 0
					? null
					: JSON.stringify({
							scope,
							root: root ?? "null",
							streams: left.map((stream) => ({
								kind: stream.kind,
								movedIn: stream.movedIn,
								numItems: stream.numItems,
								position: stream.position,
								savedStream: stream.savedStream,
								indexStream: stream.indexStream,
								seek: stream.seek,
								parentAlias: stream.parentAlias,
							})),
						} satisfies Infer<typeof list_cursor_validator>),
			isDone: left.length === 0,
		},
	});
}

/**
 * The query calls of one `find -name` page. A call that runs out returns a short page with a cursor.
 */
const SEARCH_NAME_MAX_CALLS = 40;

/**
 * The moved-in folder searches one `find -name` page opens. The rest wait in the cursor.
 */
const SEARCH_NAME_MAX_NESTED = 20;

const search_name_cursor_validator = v.object({
	scope: v.string(),
	/** At most 64 streams, each with a whole `read` of 0 or more. The parse checks it by hand. */
	streams: v.array(
		v.object({
			kind: v.union(v.literal("saved"), v.literal("moved_in"), v.literal("nested"), v.literal("places")),
			movedIn: moved_in_validator,
			/**
			 * The search cursor, or for `moved_in` the JSON of its key-skip position.
			 */
			cursor: v.union(v.string(), v.null()),
			/**
			 * The search rows read so far, to tell when the search hit 1,024.
			 */
			read: v.number(),
			savedStream: saved_source_validator,
		}),
	),
});

/**
 * One page of `find -name`: name word search on the saved rows, then with a folder one search per
 * saved folder the user moved into it by a draft (at most 20 per page), then the user's places.
 * The streams run one after the other, since search results have no order to merge by.
 *
 * Returns the gap notes the page found: a moved-in folder too deep to search, or a search that hit
 * the 1,024 rows Convex returns at most.
 */
export async function files_pending_overlay_search_name(
	ctx: Pick<ActionCtx, "runQuery">,
	args: {
		agentSource?: Infer<typeof ai_chat_workspaces_source_validator>;
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		visibilityUserId: Id<"users">;
		subject: access_control_Subject;
		overlayUserId?: Id<"users">;
		folderPath: string;
		query: string;
		kind?: "file" | "folder";
		numItems: number;
		cursor: string | null;
	},
) {
	const overlay = args.overlayUserId === args.visibilityUserId && access_control_subject_reads_drafts(args.subject);
	const streamArgs = {
		agentSource: args.agentSource,
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		visibilityUserId: args.visibilityUserId,
		subject: args.subject,
		overlayUserId: args.overlayUserId,
		folderPath: args.folderPath,
	};
	const view = await ctx.runQuery(internal.files_visible.internal_get_move_view, streamArgs);
	if (!view) return Result({ _yay: { items: [], continueCursor: null, isDone: true, notes: [] } });
	const savedSources: files_SavedStream[] = [
		{ kind: "normal", generation: view.generation },
		...(view.cohortId && view.view
			? [{ kind: "cohort" as const, cohortId: view.cohortId, view: view.view, generation: view.generation }]
			: []),
	];
	const scope = JSON.stringify([
		args.organizationId,
		args.workspaceId,
		args.visibilityUserId,
		args.subject,
		args.overlayUserId,
		args.folderPath,
		args.query,
		args.kind,
		view,
	]);
	const pageSize = Math.max(1, Math.floor(args.numItems));

	type CursorStream = Infer<typeof search_name_cursor_validator>["streams"][number];
	let streams: CursorStream[];
	if (args.cursor === null) {
		streams = savedSources.flatMap((savedStream) => [
			{ kind: "saved" as const, movedIn: null, cursor: null, read: 0, savedStream },
			// Without a folder the saved search already finds rows under moved folders.
			...(overlay && server_path_normalize(args.folderPath) !== "/"
				? [{ kind: "moved_in" as const, movedIn: null, cursor: null, read: 0, savedStream }]
				: []),
			...(overlay ? [{ kind: "places" as const, movedIn: null, cursor: null, read: 0, savedStream }] : []),
		]);
	} else {
		let raw: unknown;
		try {
			raw = JSON.parse(args.cursor);
		} catch {
			return Result({
				_nay: { message: "cursor is invalid; rerun the original command to get a fresh Next page cursor." },
			});
		}
		if (
			!validate(search_name_cursor_validator, raw) ||
			raw.scope !== scope ||
			raw.streams.length > 64 ||
			!raw.streams.every((stream) => Number.isInteger(stream.read) && stream.read >= 0)
		)
			return Result({
				_nay: {
					message: "cursor does not match this search; rerun the original command to get a fresh Next page cursor.",
				},
			});
		streams = raw.streams;
	}

	const items: NonNullable<files_visible_search_name_Result["_yay"]>["items"] = [];
	const seen = new Set<string>();
	const notes = new Set<string>();
	let calls = 0;
	let nested = 0;
	// The page size of the current stream. It halves when a page runs out of reads.
	let numItems = Math.min(100, pageSize);
	while (items.length < pageSize && streams.length > 0 && calls < SEARCH_NAME_MAX_CALLS) {
		const stream = streams[0]!;
		calls++;

		if (stream.kind === "moved_in") {
			if (nested === SEARCH_NAME_MAX_NESTED) break;
			const result = (await ctx.runQuery(internal.files_visible.internal_list_subtree_moved_in_folders, {
				...streamArgs,
				savedStream: stream.savedStream as files_SavedStream,
				searchGeneration: view.searchGeneration,
				outsideOnly: true,
				numItems: SEARCH_NAME_MAX_NESTED - nested,
				position:
					stream.cursor === null ? { rangeStart: null, cursor: null, lastKey: null } : JSON.parse(stream.cursor),
			})) as files_visible_stream_Result;
			if (result._nay) return result;
			if (result._yay.done) streams.shift();
			else stream.cursor = JSON.stringify(result._yay.position);
			// Each moved-in folder opens its search before the rest of the folders.
			const opened: CursorStream[] = result._yay.rows.flatMap((row) =>
				row.movedIn
					? savedSources.map((savedStream) => ({
							kind: "nested" as const,
							movedIn: row.movedIn!,
							cursor: null,
							read: 0,
							savedStream,
						}))
					: [],
			);
			nested += opened.length;
			streams.unshift(...opened);
			continue;
		}

		const requested = Math.min(numItems, pageSize - items.length);
		const searchArgs = {
			...streamArgs,
			savedStream: stream.savedStream as files_SavedStream,
			searchGeneration: view.searchGeneration,
			query: args.query,
			...(args.kind === undefined ? {} : { kind: args.kind }),
			numItems: requested,
			cursor: stream.cursor,
		};
		const result = (
			stream.kind === "places"
				? await ctx.runQuery(internal.files_visible.internal_search_name_places, searchArgs)
				: await ctx.runQuery(internal.files_visible.internal_search_name_saved, {
						...searchArgs,
						...moved_in_args(stream.movedIn),
					})
		) as files_visible_search_name_Result;
		if (result._nay) return result;
		if (result._yay.retrySmaller) {
			if (requested === 1)
				throw should_never_happen("One name search row needs more reads than a query has", { query: args.query });
			numItems = Math.floor(requested / 2);
			continue;
		}

		stream.cursor = result._yay.continueCursor;
		stream.read += result._yay.scanned;
		if (result._yay.tooDeep) notes.add("Some moved folders are too deep to search inside. Use find <folder> -type f.");
		// Two calls read different snapshots, so a moved row can come from two searches.
		for (const item of result._yay.items) {
			if (seen.has(item.target.id)) continue;
			seen.add(item.target.id);
			items.push(item);
		}
		if (result._yay.isDone) {
			streams.shift();
			numItems = Math.min(100, pageSize);
			if (stream.read >= files_TEXT_SEARCH_MAX_RESULTS)
				notes.add(
					stream.kind === "places"
						? "Only your top 1,024 matching pending proposals were searched. Add more words to narrow the search."
						: "Only the top 1,024 matches were searched. Add more words to narrow the search.",
				);
		}
	}

	const finalView = await ctx.runQuery(internal.files_visible.internal_get_move_view, streamArgs);
	if (JSON.stringify(finalView) !== JSON.stringify(view))
		return Result({ _nay: { message: "Search changed. Start again." } });
	return Result({
		_yay: {
			items,
			continueCursor:
				streams.length === 0
					? null
					: JSON.stringify({ scope, streams } satisfies Infer<typeof search_name_cursor_validator>),
			isDone: streams.length === 0,
			notes: [...notes],
		},
	});
}

// #endregion reads
