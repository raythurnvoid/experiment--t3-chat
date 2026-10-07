// The pending overlay: derived docs that copy what each user's drafts change, so agent reads and
// draft views can page them with indexes. Only the flush below, its jobs
// (`convex/files_pending_overlay.ts`) and data deletion write them.
//
// Saved rows only: UI lists never show drafts. Drafts show in the Pending tab, the draft folder
// view and to the agent (files-explorer-tree skill, "Saved-only lists").
//
// Every mutation captures its writes to the source tables with `files_pending_overlay_db_wrap`
// and flushes once at the end (`convex/functions.ts`). The flush recomputes derived docs from the
// source tables and the owner's reader. Derived docs only tell it what to recompute, never facts.
// The same flush keeps the share rows true (`server/files-share-rows.ts`).
//
// Leaf module: import only `convex/_generated`, `shared/`, `common/` and other leaf modules (see
// `server/files-visible-resolve.ts`).

import { compareValues, type Infer, type Value } from "convex/values";
import { Result } from "common/errors-as-values-utils.ts";
import { z } from "zod";
import type { TransactionMetrics, WithoutSystemFields } from "convex/server";
import { internal } from "../convex/_generated/api.js";
import type { Doc, Id, TableNames } from "../convex/_generated/dataModel.js";
import type { ActionCtx, MutationCtx, QueryCtx } from "../convex/_generated/server.js";
import type { files_visible_stream_Result } from "../convex/files_visible.ts";
import type { ai_chat_workspaces_source_validator } from "../convex/schema.ts";
import {
	files_derive_tree_path_for_file_node,
	files_lowercase_extension,
	type files_PendingParent,
	type files_PendingTarget,
} from "../shared/files.ts";
import { should_never_happen } from "../shared/shared-utils.ts";
import { convex_error } from "./convex-utils.ts";
import {
	files_share_rows_db_sync_grant,
	files_share_rows_db_sync_node,
	files_share_rows_node_changed,
	files_share_rows_NODE_FIELDS,
} from "./files-share-rows.ts";
import { files_visible_resolve_db_create } from "./files-visible-resolve.ts";
import { path_tree_prefix_upper_bound } from "./server-utils.ts";

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
 * Tables only the overlay writes. The accept unit counts their writes without its old doc read.
 */
export const files_pending_overlay_DERIVED_TABLES = new Set<string>([
	"files_pending_hides",
	"files_pending_places",
	"files_pending_place_fields",
	"files_pending_list_rows",
	"files_pending_list_keys",
	"files_pending_overlay_jobs",
	"files_share_rows",
]);

/**
 * The fields the flush reads from a source doc it saw before. The caches keep only these.
 */
const SOURCE_FIELDS: Record<string, string[]> = {
	files_nodes: ["organizationId", "workspaceId", "treePath", "restrictedScopeNodeId", ...files_share_rows_NODE_FIELDS],
	// Only a file grant's write marks its share row, so the kind is all the flush needs.
	access_control_permission_grants: ["resourceKind"],
	files_pending_updates: ["organizationId", "workspaceId", "userId", "target"],
	files_pending_nodes: ["organizationId", "workspaceId", "userId", "parent", "name", "state"],
	files_pending_node_publish_receipts: ["organizationId", "workspaceId", "userId", "privateNodeId", "savedNodeId"],
	files_metadata_docs: [
		"organizationId",
		"workspaceId",
		"sourceKind",
		"fileNodeId",
		"target",
		"userId",
		"pendingUpdateId",
	],
};

/**
 * Metadata fields that place fields copy. A patch of other fields marks nothing.
 */
const METADATA_VALUE_FIELDS = ["docKind", "fieldPath", "valueKind", "stringValue", "numberValue", "booleanValue"];

/**
 * Proposal fields the overlay reads: the reader reads `pendingMove` and `pendingArchive`; places
 * copy `updatedAt` of a private draft; list docs read `updatedAt`, `threadIds` and `createIntent`.
 * A patch of other fields, such as content or `revision`, marks nothing. The place fields job reads
 * `revision` itself, after a metadata write marks the place.
 */
const PROPOSAL_FIELDS = ["pendingMove", "pendingArchive", "updatedAt", "threadIds", "createIntent"];

/**
 * A saved node write refreshes every user's hide and place of that node in the same transaction
 * (exact windows), so their number must stay small. A user's own write may add a hide or place of a
 * saved node only while other users hold fewer than this many of them.
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
 * Ids per list job doc (place fields, targets), far below Convex's 8,192 array items.
 */
const JOB_LIST_ITEMS = 1000;

/**
 * Reads a job keeps for one target besides its reader: the proposal, hide, place and list docs. A
 * job starts a target only with 2,048 ranges left, so its reader still gets more than a fresh
 * reader needs for one target (256 levels, about 6 reads each).
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
	| { kind: "place_fields"; placeIds: Id<"files_pending_places">[] }
	| { kind: "targets"; userId: Id<"users">; items: TargetsJobItem[] };

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

type State = {
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
	 * False in the accept unit: an Accept's size must not depend on the owner's other drafts.
	 */
	inlineOwnerPaths: boolean;
	/**
	 * The user who accepts in the accept unit. Their marks stay inline when other users' drafts change too.
	 */
	actingUserId: Id<"users"> | null;
	/**
	 * The job this mutation runs. A job never schedules its own doc again.
	 */
	ownJob: OwnJob | null;
};

const STATE = Symbol("files_pending_overlay");

type WrappedCtx = { [STATE]?: State };

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
async function db_sync_doc<T extends "files_pending_hides" | "files_pending_list_keys">(
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

function new_state(): State {
	return {
		lastKnown: new Map(),
		savedOld: new Map(),
		oldReads: new Map(),
		targets: new Map(),
		deferred: new Map(),
		readers: new Map(),
		unknownProposalIds: new Set(),
		unknownMetadataIds: new Set(),
		committedMetadataNodeIds: new Set(),
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
	state: State,
	args: Scope & {
		target: files_PendingTarget;
		pendingUpdateId?: Id<"files_pending_updates">;
		fieldsChanged?: boolean;
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
	mark.inline ||= args.inline;
	mark.ownWrite ||= args.ownWrite === true;
}

/**
 * Send one target's recompute to its owner's targets job instead of this transaction.
 */
function defer_target(
	state: State,
	mark: Pick<TargetMark, keyof Scope | "target" | "pendingUpdateIds" | "fieldsChanged">,
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
		group.items.push({ target: mark.target, pendingUpdateId, fieldsChanged: mark.fieldsChanged });
	state.deferred.set(key, group);
}

/**
 * Send this mutation's owner path work to jobs only (the accept unit).
 */
export function files_pending_overlay_db_skip_inline_owner_paths(ctx: MutationCtx) {
	const state = (ctx as WrappedCtx)[STATE];
	if (state) state.inlineOwnerPaths = false;
}

/**
 * Name the user who accepts in this mutation, so their own derived docs stay exact at once
 * while other users' changes go to jobs.
 */
export function files_pending_overlay_db_set_acting_user(ctx: MutationCtx, userId: Id<"users">) {
	const state = (ctx as WrappedCtx)[STATE];
	if (state) state.actingUserId = userId;
}

/**
 * Tell the flushes of this mutation which job it runs, so they never schedule that job again. The
 * job keeps the returned progress up to date.
 */
export function files_pending_overlay_db_set_own_job(ctx: MutationCtx, job: Doc<"files_pending_overlay_jobs">) {
	const own: OwnJob = { doc: job, phase: 0, lastPath: null, rerun: false };
	const state = (ctx as WrappedCtx)[STATE];
	if (state) state.ownJob = own;
	return own;
}

/**
 * Mark one target of one user dirty, so the next flush recomputes its derived docs. Jobs and the
 * repair use it; source writes mark targets by themselves.
 */
export function files_pending_overlay_db_mark_target(
	ctx: MutationCtx,
	args: Scope & { target: files_PendingTarget; pendingUpdateId?: Id<"files_pending_updates">; fieldsChanged?: boolean },
) {
	const state = (ctx as WrappedCtx)[STATE];
	if (!state) throw should_never_happen("Overlay mark outside the mutation wrapper", { target: args.target });
	mark_target(state, { ...args, inline: false });
}

/**
 * Record what a proposal, private node, receipt or metadata write changes. `old` is the doc before
 * the write (null for an insert) and `next` the doc after (null for a delete).
 */
function mark_source_write(
	state: State,
	table: string,
	id: string,
	old: SourceFields | null,
	next: SourceFields | null,
) {
	const doc = next ?? old;
	if (!doc) return;
	const scope = { organizationId: doc.organizationId, workspaceId: doc.workspaceId, userId: doc.userId };

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

function wrap_query<T extends object>(state: State, table: string, source: T): T {
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

	const read_old = async (table: string, id: string) => {
		const known = state.lastKnown.get(id);
		if (known) return known;
		// A second write of the same id in `Promise.all` waits for this read, like `savedOld`.
		let read = state.oldReads.get(id);
		if (!read) {
			read = raw.get(table as TableNames, id as Id<TableNames>).then((doc) => {
				state.oldReads.delete(id);
				return doc && pick_source_fields(table, doc as SourceFields);
			});
			state.oldReads.set(id, read);
		}
		return await read;
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
					if (!SOURCE_TABLES.has(table)) return await Reflect.apply(write, target, args);

					if (table === "files_nodes") {
						const ancestorFields = Object.keys(value ?? {}).filter((field) => /^ancestor\d+$/.test(field));
						if (property === "patch" && ancestorFields.length > 0) {
							if (ancestorFields.length !== Object.keys(value!).length)
								throw should_never_happen("A files_nodes patch mixes ancestor fields with other fields", { id });
							// Ancestor copies change no derived doc.
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
					const fields = table === "files_metadata_docs" ? METADATA_VALUE_FIELDS : PROPOSAL_FIELDS;
					const valueChanged =
						property !== "patch" ||
						(table !== "files_metadata_docs" && table !== "files_pending_updates") ||
						fields.some((field) => field in value!);
					if (property === "patch" && !state.lastKnown.has(id) && table !== "files_pending_nodes") {
						await Reflect.apply(write, target, args);
						if (table === "files_pending_updates" && valueChanged)
							state.unknownProposalIds.add(id as Id<"files_pending_updates">);
						if (table === "files_metadata_docs" && valueChanged)
							state.unknownMetadataIds.add(id as Id<"files_metadata_docs">);
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

	return { db, [STATE]: state };
}

// #endregion capture

// #region recompute

/**
 * One user's reader for the flush. `includeHidden` gives paths of hidden targets too, so a place
 * keeps its destination while the owner does not see it.
 */
export function files_pending_overlay_db_create_reader(db: QueryCtx["db"], scope: Scope) {
	return files_visible_resolve_db_create(db, { ...scope, readLimit: TRANSACTION_RANGES, includeHidden: true });
}

/**
 * A published private parent becomes its saved folder (receipt), like the reader resolves it.
 */
async function db_place_parent(
	db: QueryCtx["db"],
	scope: Scope,
	parent: files_PendingParent,
): Promise<files_PendingParent> {
	if (parent.kind !== "private") return parent;
	const node = await db.get("files_pending_nodes", parent.id);
	if (node?.state !== "published") return parent;
	const receipt = await db
		.query("files_pending_node_publish_receipts")
		.withIndex("by_privateNode", (q) => q.eq("privateNodeId", parent.id))
		.unique();
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

type DesiredPlace = Omit<WithoutSystemFields<Doc<"files_pending_places">>, "fieldsVersion">;

/**
 * What the derived docs of one user's target should be, from source tables and the reader only.
 * The flush writes it; `check_user` compares it with the stored docs.
 */
export async function files_pending_overlay_db_compute_target(
	db: QueryCtx["db"],
	reader: Reader,
	args: Scope & { target: files_PendingTarget; pendingUpdate: Doc<"files_pending_updates"> | null },
) {
	const { target, pendingUpdate } = args;
	const scope = { organizationId: args.organizationId, workspaceId: args.workspaceId, userId: args.userId };
	let hide: WithoutSystemFields<Doc<"files_pending_hides">> | null = null;
	let place: DesiredPlace | null = null;
	let savedNode: Doc<"files_nodes"> | null = null;

	if (target.kind === "saved") {
		const node = await db.get("files_nodes", target.id);
		// A hard deleted target has no derived docs, and needs no reader.
		if (!node || node.organizationId !== args.organizationId || node.workspaceId !== args.workspaceId)
			return { hide, place, listKeys: [], savedNode };
		savedNode = node;

		const own = await reader.resolve(target);
		const destination = pendingUpdate?.pendingMove
			? await reader.resolveParent(pendingUpdate.pendingMove.destParent)
			: null;
		const cycle = reader.isCycleMember(target);
		const moved = destination?.hidden === false && !cycle;
		if (
			node.archiveOperationId === null &&
			(pendingUpdate?.pendingArchive !== undefined || moved || (await reader.isClaimed(node)))
		)
			hide = {
				...scope,
				savedNodeId: node._id,
				parentId: node.parentId,
				kind: node.kind,
				name: node.name,
				updatedAt: node.updatedAt,
				lowercaseExtension: node.lowercaseExtension,
				nodeCreationTime: node._creationTime,
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
				parent: await db_place_parent(db, scope, destParent),
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
			};
		}
	} else {
		const node = await db.get("files_pending_nodes", target.id);
		if (
			pendingUpdate &&
			node?.state === "active" &&
			node.userId === args.userId &&
			node.organizationId === args.organizationId &&
			node.workspaceId === args.workspaceId
		) {
			const parent = await reader.resolveParent(node.parent);
			const own = await reader.resolve(target);
			place = {
				...scope,
				target,
				pendingUpdateId: pendingUpdate._id,
				parent: await db_place_parent(db, scope, node.parent),
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
			};
		}
	}

	if (reader.exhausted) throw should_never_happen("Overlay reader ran out of reads", { ...scope, target });

	const listed =
		pendingUpdate !== null && (await files_pending_overlay_db_pending_update_is_listed({ ctx: { db }, pendingUpdate }));
	const listKeys: Array<Doc<"files_pending_list_rows">["listKey"]> = !listed
		? []
		: pendingUpdate.threadIds?.length
			? ["all", ...pendingUpdate.threadIds]
			: ["all", "own"];

	return { hide, place, listKeys, savedNode };
}

type Flush = {
	ctx: MutationCtx;
	state: State;
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
 * than the cap of them, because every saved write of the node refreshes all of them inline. Jobs and
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
	const claimed = await flush.ctx.db
		.query("files_nodes")
		.withIndex("by_organization_workspace_parent_archiveOperation_name", (q) =>
			q
				.eq("organizationId", mark.organizationId)
				.eq("workspaceId", mark.workspaceId)
				.eq("parentId", parentId)
				.eq("archiveOperationId", null)
				.eq("name", place.name),
		)
		.first();
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
 * Recompute one user's hide, place and list docs of one target, and record what follows: claims,
 * folder changes and place fields.
 */
async function db_recompute_target(flush: Flush, mark: TargetMark) {
	const { ctx, state } = flush;
	const { target, userId } = mark;
	const scope = { organizationId: mark.organizationId, workspaceId: mark.workspaceId, userId };
	const reader = flush_reader(flush, scope);
	// A job reuses its readers across targets. Give each the ranges left, so it runs out before
	// Convex does. Running out on one target then means a broken target (`should_never_happen`).
	if (state.ownJob) {
		const ranges = (await ctx.meta.getTransactionMetrics()).databaseQueries;
		reader.setReadLimit(reader.readCount + ranges.remaining - JOB_READER_MARGIN);
	}

	const pendingUpdate = await ctx.db
		.query("files_pending_updates")
		.withIndex("by_user_target", (q) =>
			q.eq("userId", userId).eq("target.kind", target.kind).eq("target.id", target.id),
		)
		.unique();
	const desired = await files_pending_overlay_db_compute_target(ctx.db, reader, {
		...scope,
		target,
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
					.withIndex("by_savedNode_user", (q) => q.eq("savedNodeId", target.id).eq("userId", userId))
					.unique()
			: null;
	const place = await ctx.db
		.query("files_pending_places")
		.withIndex("by_target_user", (q) =>
			q.eq("target.kind", target.kind).eq("target.id", target.id).eq("userId", userId),
		)
		.unique();
	const next = desired.place;
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
		place.accessNodeId !== next.accessNodeId;
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

	// List docs: the current proposal's, and those of proposal ids this target had before.
	const pendingUpdateIds = new Set(mark.pendingUpdateIds);
	if (place) pendingUpdateIds.add(place.pendingUpdateId);
	if (pendingUpdate) pendingUpdateIds.add(pendingUpdate._id);
	for (const pendingUpdateId of pendingUpdateIds) {
		const rows = await ctx.db
			.query("files_pending_list_rows")
			.withIndex("by_pendingUpdate", (q) => q.eq("pendingUpdateId", pendingUpdateId))
			.collect();
		const wanted = pendingUpdateId === pendingUpdate?._id ? new Set<string>(desired.listKeys) : new Set<string>();
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
	if (isFolder && (((place !== null || next !== null) && factsChanged) || hideChanged)) {
		const prefixes = new Set<string>();
		if (place) {
			prefixes.add(place.ownerTreePath);
			if (place.childTreePath) prefixes.add(place.childTreePath);
		}
		// A saved folder with no place before: its children build on its saved place.
		else if (desired.savedNode) {
			const node = desired.savedNode;
			const parent = await reader.resolveParent(
				node.parentId === "root" ? { kind: "root" } : { kind: "saved", id: node.parentId },
			);
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
	const newest = await db
		.query("files_pending_list_rows")
		.withIndex("by_org_ws_user_listKey_updatedAt", (q) =>
			q
				.eq("organizationId", scope.organizationId)
				.eq("workspaceId", scope.workspaceId)
				.eq("userId", scope.userId)
				.eq("listKey", listKey),
		)
		.order("desc")
		.first();
	const keyDoc = await db
		.query("files_pending_list_keys")
		.withIndex("by_org_ws_user_listKey", (q) =>
			q
				.eq("organizationId", scope.organizationId)
				.eq("workspaceId", scope.workspaceId)
				.eq("userId", scope.userId)
				.eq("listKey", listKey),
		)
		.unique();
	await db_sync_doc(
		db,
		"files_pending_list_keys",
		keyDoc,
		newest && { ...scope, listKey, lastUpdatedAt: newest.updatedAt },
	);
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
		// Convex runs it again on the new doc; a second run is safe because all writes are diffed.
		if ((await ctx.db.system.get("_scheduled_functions", job.scheduledFunctionId))?.state.kind === "pending")
			await ctx.scheduler.cancel(job.scheduledFunctionId);
	const scheduledFunctionId = await ctx.scheduler.runAfter(0, internal.files_pending_overlay.run_job, {
		kind: input.kind,
		key,
	});
	if (!job) {
		await ctx.db.insert("files_pending_overlay_jobs", {
			...scope,
			...input,
			key,
			cursor: null,
			nextAttemptAt: now,
			scheduledFunctionId,
			attempts: 0,
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
 * The saved node inline part: no reader, so its cost does not grow with the number of users.
 * Hide copies must match the saved node in this transaction (the window bound).
 */
async function db_flush_saved_node(flush: Flush, nodeId: Id<"files_nodes">, old: SourceFields | null) {
	const { ctx } = flush;
	const node = await ctx.db.get("files_nodes", nodeId);
	const doc = node ?? old;
	if (!doc) return;
	// Global and plugin volume workspaces have no drafts.
	const organizationId = ctx.db.normalizeId("organizations", doc.organizationId);
	const workspaceId = ctx.db.normalizeId("organizations_workspaces", doc.workspaceId);
	if (!organizationId || !workspaceId) return;
	const scope = { organizationId, workspaceId };

	const hides = await ctx.db
		.query("files_pending_hides")
		.withIndex("by_savedNode_user", (q) => q.eq("savedNodeId", nodeId))
		.collect();
	const places = await ctx.db
		.query("files_pending_places")
		.withIndex("by_target_user", (q) => q.eq("target.kind", "saved").eq("target.id", nodeId))
		.collect();

	const active = node?.archiveOperationId === null;
	for (const { _id, _creationTime, ...hide } of hides) {
		if (!active) {
			await ctx.db.delete("files_pending_hides", _id);
			continue;
		}
		await db_sync_doc(
			ctx.db,
			"files_pending_hides",
			{ _id, _creationTime, ...hide },
			{
				...hide,
				parentId: node.parentId,
				kind: node.kind,
				name: node.name,
				updatedAt: node.updatedAt,
				lowercaseExtension: node.lowercaseExtension,
				nodeCreationTime: node._creationTime,
				treePath: node.treePath,
			},
		);
	}
	// The saved node job deletes the places of a hard deleted node, with their claim and folder effects.
	if (node)
		for (const place of places) {
			const patch = changed_fields(place, { kind: node.kind, updatedAt: node.updatedAt });
			if (Object.keys(patch).length > 0) await ctx.db.patch("files_pending_places", place._id, patch);
		}

	// Only a node that is or was a restricted scope root has share rows. An ancestor's move, rename or
	// archive changes no copied field: an archive or restore writes the node itself too.
	if (files_share_rows_node_changed(nodeId, old, node))
		await files_share_rows_db_sync_node(ctx.db, { ...scope, nodeId, node });

	const changed =
		!old ||
		!node ||
		old.parentId !== node.parentId ||
		old.name !== node.name ||
		(old.archiveOperationId === null) !== active ||
		(node.kind === "folder" && old.treePath !== node.treePath);
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
							.eq("parent.kind", node.parentId === "root" ? "root" : "saved")
							.eq("parent.id", node.parentId === "root" ? undefined : node.parentId)
							.eq("name", node.name),
					)
					.first();
	if (hides.length > 0 || places.length > 0 || proposal || claimant)
		await db_schedule_job(flush, scope, { kind: "saved_node", savedNodeId: nodeId });

	if (doc.kind === "folder") {
		const child = await ctx.db
			.query("files_pending_places")
			.withIndex("by_org_ws_parent_name", (q) =>
				q
					.eq("organizationId", organizationId)
					.eq("workspaceId", workspaceId)
					.eq("parent.kind", "saved")
					.eq("parent.id", nodeId),
			)
			.first();
		if (child) await db_schedule_job(flush, scope, { kind: "parent", parent: { kind: "saved", id: nodeId } });
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
	for (const pathless of [false, true]) {
		const left = INLINE_OWNER_PATH_PLACES - state.inlineStep.places;
		const places = pathless
			? await ctx.db
					.query("files_pending_places")
					.withIndex("by_org_ws_user_isPathless", (q) =>
						q
							.eq("organizationId", scope.organizationId)
							.eq("workspaceId", scope.workspaceId)
							.eq("userId", scope.userId)
							.eq("isPathless", true),
					)
					.take(left + 1)
			: await ctx.db
					.query("files_pending_places")
					.withIndex("by_org_ws_user_ownerTreePath", (q) =>
						q
							.eq("organizationId", scope.organizationId)
							.eq("workspaceId", scope.workspaceId)
							.eq("userId", scope.userId)
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
						.eq("isPathless", true),
				)
				.first());
		if (!pathless) continue;

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
 * Runs at the end of every wrapped mutation, before near-limit checks, and in the accept unit.
 *
 * It never calls `.paginate()` (one per function, and jobs page) and never the near-limit check.
 */
export async function files_pending_overlay_db_flush(ctx: MutationCtx) {
	const state = (ctx as WrappedCtx)[STATE];
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

		for (const [nodeId, old] of savedOld) await db_flush_saved_node(flush, nodeId, await old);

		// Fields of a moved saved node follow its committed metadata.
		for (const nodeId of committedMetadataNodeIds) {
			const places = await ctx.db
				.query("files_pending_places")
				.withIndex("by_target_user", (q) => q.eq("target.kind", "saved").eq("target.id", nodeId))
				.collect();
			for (const place of places) {
				await ctx.db.patch("files_pending_places", place._id, { fieldsVersion: place.fieldsVersion + 1 });
				state.placeFieldIds.set(place._id, place);
			}
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

const list_cursor_schema = z.object({
	scope: z.string(),
	root: z.string(),
	streams: z
		.array(
			z.object({
				kind: z.enum(["saved", "places", "moved_in", "nested"]),
				movedIn: z.object({ savedNodeId: z.string(), ownerTreePath: z.string() }).nullable(),
				numItems: z.number().int().positive(),
				position: z.object({
					rangeStart: z.string().nullable(),
					cursor: z.string().nullable(),
					lastKey: z.array(z.any()).nullable(),
				}),
			}),
		)
		.max(256),
});

/**
 * One page of an agent listing: the children of a folder, the subtree under it (path order), or the
 * whole workspace by update time (`ls -t` with no path).
 *
 * Merges the saved stream, the user's place stream and, in a subtree, one saved stream per folder the
 * user moved in by a draft. A row shows only when every open stream has read past its key; ties go by
 * stream order. Used by `ls`, `find`, `tree`, the skills catalog and transfer discovery, so it takes
 * any ctx that can run a query.
 *
 * Nested queries share the caller's transaction. When the caller is a query or a mutation, the merge
 * starts no stream call past the read budget and returns a short page with a cursor instead.
 */
export async function files_pending_overlay_list(
	ctx: Pick<ActionCtx, "runQuery"> & { meta?: ActionCtx["meta"] | QueryCtx["meta"] },
	args: {
		agentSource?: Infer<typeof ai_chat_workspaces_source_validator>;
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		visibilityUserId: Id<"users">;
		serviceAccountId?: Id<"access_control_service_accounts">;
		overlayUserId?: Id<"users">;
		requireComplete?: boolean;
		folderPath: string;
		mode: "children" | "subtree" | "recent";
		/**
		 * Children only. Recent listings are always by update time.
		 */
		orderBy?: "name" | "updatedAt";
		order: "asc" | "desc";
		kind?: "file" | "folder";
		lowercaseExtension?: string;
		numItems: number;
		cursor: string | null;
	},
) {
	const { order } = args;
	const overlay = args.overlayUserId === args.visibilityUserId && args.serviceAccountId === undefined;
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
		serviceAccountId: args.serviceAccountId,
		overlayUserId: args.overlayUserId,
		requireComplete: args.requireComplete,
		folderPath: args.folderPath,
	};
	const filter = {
		...(args.kind === undefined ? {} : { kind: args.kind }),
		...(args.lowercaseExtension === undefined ? {} : { lowercaseExtension: args.lowercaseExtension }),
	};
	const scope = JSON.stringify([
		args.organizationId,
		args.workspaceId,
		args.visibilityUserId,
		args.serviceAccountId,
		args.overlayUserId,
		args.folderPath,
		args.mode,
		args.orderBy,
		order,
		args.kind,
		args.lowercaseExtension,
		args.requireComplete,
	]);
	const pageSize = Math.max(1, Math.floor(args.numItems));

	type CursorStream = z.infer<typeof list_cursor_schema>["streams"][number];
	type Row = NonNullable<files_visible_stream_Result["_yay"]>["rows"][number];
	type Stream = CursorStream & {
		/**
		 * False once nothing is left after `buffer`.
		 */
		open: boolean;
		buffer: Row[];
		frontier: Value[] | null;
		after: { position: CursorStream["position"]; done: boolean };
	};

	const start = { rangeStart: null, cursor: null, lastKey: null };
	let root: string | null = null;
	let cursorStreams: CursorStream[];
	if (args.cursor === null) {
		cursorStreams = [
			{ kind: "saved", movedIn: null, numItems: pageSize, position: start },
			...(overlay ? [{ kind: "places" as const, movedIn: null, numItems: pageSize, position: start }] : []),
			// A filter that leaves folders out does not meet moved-in folders in the place stream.
			...(overlay && args.mode === "subtree" && (args.kind === "file" || args.lowercaseExtension !== undefined)
				? [{ kind: "moved_in" as const, movedIn: null, numItems: pageSize, position: start }]
				: []),
		];
	} else {
		let raw: unknown;
		try {
			raw = JSON.parse(args.cursor);
		} catch {
			return Result({ _nay: { message: "Invalid listing cursor" } });
		}
		const parsed = list_cursor_schema.safeParse(raw);
		if (!parsed.success || parsed.data.scope !== scope)
			return Result({ _nay: { message: "Listing changed. Start again." } });
		root = parsed.data.root;
		cursorStreams = parsed.data.streams;
	}
	const streams: Stream[] = cursorStreams.map((stream) => ({
		...stream,
		open: true,
		buffer: [],
		frontier: null,
		after: { position: stream.position, done: false },
	}));

	const run = (stream: Stream) => {
		const common = { ...streamArgs, numItems: stream.numItems, position: stream.position };
		const orderBy = args.orderBy ?? "name";
		const query =
			args.mode === "recent"
				? stream.kind === "saved"
					? ctx.runQuery(internal.files_visible.internal_list_recent_saved, { ...common, order })
					: ctx.runQuery(internal.files_visible.internal_list_recent_places, { ...common, order })
				: args.mode === "children"
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
								orderBy,
								order,
							})
					: stream.kind === "places"
						? ctx.runQuery(internal.files_visible.internal_list_subtree_places, { ...common, ...filter })
						: stream.kind === "moved_in"
							? ctx.runQuery(internal.files_visible.internal_list_subtree_moved_in_folders, common)
							: ctx.runQuery(internal.files_visible.internal_list_subtree_saved, {
									...common,
									...filter,
									order,
									...(stream.movedIn
										? {
												movedIn: {
													savedNodeId: stream.movedIn.savedNodeId as Id<"files_nodes">,
													ownerTreePath: stream.movedIn.ownerTreePath,
												},
											}
										: {}),
								});
		return query as Promise<files_visible_stream_Result>;
	};

	const sign = order === "asc" ? 1 : -1;
	const compare = (a: Value[], b: Value[]) => sign * compareValues(a, b);

	const items: NonNullable<Row["item"]>[] = [];
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

		if (blocking.length > 0) {
			if (rounds === LIST_MAX_ROUNDS) break;
			rounds++;
			// One stream at a time: transfer discovery calls this from a mutation, and Convex does not
			// promise that nested `runQuery` calls may run in parallel there.
			for (const stream of blocking) {
				// Only after the cursor moved, so every page makes progress: buffered rows of one stream
				// do not move it while another stream still blocks them. Actions have no transaction metrics.
				if (progressed && ctx.meta && "getTransactionMetrics" in ctx.meta) {
					overBudget = files_pending_overlay_list_over_budget(await ctx.meta.getTransactionMetrics());
					if (overBudget) break;
				}
				const result = await run(stream);
				if (result._nay) return result;
				const rootKey = JSON.stringify(result._yay.root);
				if (root !== null && rootKey !== root) return Result({ _nay: { message: "Listing changed. Start again." } });
				root = rootKey;

				const { rows, decided } = result._yay;
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
			streams.push({
				kind: "nested",
				movedIn: row.movedIn,
				numItems: pageSize,
				position: start,
				open: true,
				buffer: [],
				frontier: null,
				after: { position: start, done: false },
			});
		}
		// Two calls read different snapshots, so a moved row can come from two streams.
		if (row.item && !seen.has(row.item.target.id)) {
			seen.add(row.item.target.id);
			items.push(row.item);
		}
	}

	const left = streams.filter((stream) => stream.open);
	return Result({
		_yay: {
			items,
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
							})),
						} satisfies z.infer<typeof list_cursor_schema>),
			isDone: left.length === 0,
		},
	});
}

// #endregion reads
