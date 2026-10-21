// Exact write reservations. Callers still prove current access before asking whether a file is busy.

import { Result } from "common/errors-as-values-utils.ts";
import { ConvexError, v } from "convex/values";
import type { WithoutSystemFields } from "convex/server";
import { validate } from "convex-helpers/validators";
import type { Doc, Id, TableNames } from "../convex/_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "../convex/_generated/server.js";
import type { files_PendingParent } from "../shared/files.ts";
import { path_extract_segments_from } from "../shared/paths.ts";
import { files_saved_placement_db_get_node } from "./files-saved-placement.ts";

type Source = Doc<"files_move_source_reservations">["source"];
type Check = {
	source?: Source;
	parent?: files_PendingParent;
	slot?: Pick<Doc<"files_move_slot_claims">, "organizationId" | "workspaceId" | "parentId" | "name">;
	wholeWorkspace?: Pick<Doc<"files_move_workspace_slots">, "organizationId" | "workspaceId">;
};
type Capability = {
	cohortId: Id<"files_move_cohorts">;
	fence: number;
	attemptFence: number;
	mode: "stage" | "finish" | "abort";
};
const STATE = Symbol("files_move_reservations");
type Scope = Pick<Doc<"files_nodes">, "organizationId" | "workspaceId">;
type State = {
	raw: QueryCtx["db"];
	capability: Capability | null;
	securityNodes: Set<Id<"files_nodes">>;
	knownScopes: Map<string, Scope>;
	nodes: Map<string, Promise<Doc<"files_nodes"> | Doc<"files_pending_nodes"> | null>>;
	sourceReads: Map<string, Promise<Doc<"files_move_source_reservations"> | null>>;
	slots: Map<string, Promise<Id<"files_move_cohorts"> | null>>;
	holders: Map<string, Promise<Id<"files_move_cohorts"> | null>>;
};
type GuardedDb = MutationCtx["db"] & { [STATE]?: State };
type Fields = Record<string, unknown>;
const BUSY = { name: "move_busy", message: "This item is being moved. Try again when the Move ends." };

/**
 * Read one source reservation. A mutation reuses it until reservations change.
 */
export async function files_move_reservations_db_get_source(db: QueryCtx["db"], source: Source) {
	const reads = (db as GuardedDb)[STATE]?.sourceReads;
	const key = `${source.kind}:${source.id}`;
	let read = reads?.get(key);
	if (!read) {
		read = db
			.query("files_move_source_reservations")
			.withIndex("by_source", (q) => q.eq("source.kind", source.kind).eq("source.id", source.id))
			.unique();
		reads?.set(key, read);
	}
	return await read;
}

// Preflight and raw guards share node reads. Every node write clears its cached value.
async function get_node(db: QueryCtx["db"], source: Extract<Source, { kind: "saved" | "private" }>) {
	const state = (db as GuardedDb)[STATE];
	const nodes = state?.nodes;
	const key = `${source.kind}:${source.id}`;
	let read = nodes?.get(key);
	if (!read) {
		const reader = state?.raw ?? db;
		read =
			source.kind === "saved" ? reader.get("files_nodes", source.id) : reader.get("files_pending_nodes", source.id);
		nodes?.set(key, read);
	}
	return await read;
}

async function get_parent(db: QueryCtx["db"], source: Extract<Source, { kind: "private" }>) {
	const node = (await get_node(db, source)) as Doc<"files_pending_nodes"> | null;
	return node && node.parent.kind !== "root" ? node.parent : null;
}

async function get_slot_cohort(db: QueryCtx["db"], scope: Scope) {
	const organizationId = db.normalizeId("organizations", scope.organizationId);
	const workspaceId = db.normalizeId("organizations_workspaces", scope.workspaceId);
	// Only a workspace has a Move slot. A volume or global scope never holds a Move.
	if (!organizationId || !workspaceId) return null;
	const state = (db as GuardedDb)[STATE];
	const key = `${organizationId}:${workspaceId}`;
	let cohortId = state?.slots.get(key);
	if (!cohortId) {
		cohortId = db
			.query("files_move_workspace_slots")
			.withIndex("by_workspace", (q) => q.eq("organizationId", organizationId).eq("workspaceId", workspaceId))
			.unique()
			.then((slot) => slot?.cohortId ?? null);
		state?.slots.set(key, cohortId);
	}
	return await cohortId;
}

// Private folders keep their subtree hold. Stop at saved folders: their holds cover direct children only.
function get_subtree_holder(
	db: QueryCtx["db"],
	node: Extract<Source, { kind: "saved" | "private" }>,
	holders = (db as GuardedDb)[STATE]?.holders,
): Promise<Id<"files_move_cohorts"> | null> {
	if (node.kind === "saved") return Promise.resolve(null);
	const key = `${node.kind}:${node.id}`;
	let holder = holders?.get(key);
	if (!holder) {
		holder = (async () => {
			const reservation = await files_move_reservations_db_get_source(db, node);
			if (reservation?.mode === "subtree") return reservation.cohortId;
			const parent = await get_parent(db, node);
			return parent ? await get_subtree_holder(db, parent, holders) : null;
		})();
		holders?.set(key, holder);
	}
	return holder;
}

/**
 * Check the exact source, an explicit parent, and one destination slot.
 */
export async function files_move_reservations_db_find_blocker(db: QueryCtx["db"], args: Check) {
	let parent = args.parent?.kind === "root" ? null : (args.parent ?? null);
	const node = parent ?? (args.source?.kind === "saved" || args.source?.kind === "private" ? args.source : null);
	const scope = args.wholeWorkspace ?? args.slot ?? (node ? await get_node(db, node) : null);
	if (scope) {
		// A Move holds its workspace slot while any of its reservations or slot claims exist.
		// So a free slot means nothing here is busy, and no parent walk is needed.
		const cohortId = await get_slot_cohort(db, scope);
		if (!cohortId) return null;
		if (args.wholeWorkspace) return cohortId;
	}
	if (args.source) {
		const reservation = await files_move_reservations_db_get_source(db, args.source);
		if (reservation) return reservation.cohortId;
	}
	if (parent?.kind === "saved") {
		const reservation = await files_move_reservations_db_get_source(db, parent);
		if (reservation?.mode === "children") return reservation.cohortId;
	}
	if (!parent && args.source?.kind === "private") parent = await get_parent(db, args.source);
	if (parent) {
		const holder = await get_subtree_holder(db, parent);
		if (holder) return holder;
	}
	if (args.slot) {
		const claim = await db
			.query("files_move_slot_claims")
			.withIndex("by_workspace_slot", (q) =>
				q
					.eq("organizationId", args.slot!.organizationId)
					.eq("workspaceId", args.slot!.workspaceId)
					.eq("parentId", args.slot!.parentId)
					.eq("name", args.slot!.name),
			)
			.unique();
		if (claim) return claim.cohortId;
	}
	return null;
}

/**
 * Call after authorization. A busy reply reveals no cohort or owner.
 */
export async function files_move_reservations_db_check(db: QueryCtx["db"], args: Check) {
	const blocker = await files_move_reservations_db_find_blocker(db, args);
	if (!blocker) return Result({ _yay: null });
	const state = (db as GuardedDb)[STATE];
	if (state?.capability?.cohortId === blocker) return Result({ _yay: null });
	if (
		args.source?.kind === "saved" &&
		!args.parent &&
		!args.slot &&
		!args.wholeWorkspace &&
		state?.securityNodes.has(args.source.id)
	)
		return Result({ _yay: null });
	return Result({ _nay: BUSY });
}

function parent_check(db: QueryCtx["db"], scope: Scope, parent: files_PendingParent, name: string): Check {
	const organizationId = db.normalizeId("organizations", scope.organizationId);
	const workspaceId = db.normalizeId("organizations_workspaces", scope.workspaceId);
	return {
		parent,
		...(parent.kind !== "private" && organizationId && workspaceId
			? {
					slot: {
						organizationId,
						workspaceId,
						parentId: parent.kind === "root" ? "root" : parent.id,
						name,
					},
				}
			: {}),
	};
}

async function pending_membership_checks(
	db: QueryCtx["db"],
	target: Doc<"files_pending_updates">["target"],
	pendingMoves: Array<Doc<"files_pending_updates">["pendingMove"]>,
	scope?: Scope,
) {
	const node = await get_node(db, target);
	const checks: Check[] = [];
	if (node) {
		const parent: files_PendingParent =
			"parentId" in node
				? node.parentId === "root"
					? { kind: "root" }
					: { kind: "saved", id: node.parentId }
				: node.parent;
		checks.push(parent_check(db, node, parent, node.name));
	}
	const targetScope = scope ?? node;
	if (targetScope) {
		for (const move of pendingMoves) {
			if (move) checks.push(parent_check(db, targetScope, move.destParent, move.destName));
		}
	}
	return checks;
}

/**
 * Check the exact node and its optional proposal before a write. Membership changes also check
 * the old and new parents. Removing the owner's draft needs no new access to its old destination.
 */
export async function files_move_reservations_db_check_node_write(
	db: QueryCtx["db"],
	args: {
		target: Doc<"files_pending_updates">["target"];
		pendingUpdate: Doc<"files_pending_updates"> | null;
		membership: boolean;
		pendingMove?: Doc<"files_pending_updates">["pendingMove"];
	},
) {
	const scope = args.pendingUpdate ?? (await get_node(db, args.target));
	// A free workspace slot means none of these nodes or claims can be held.
	if (scope && !(await get_slot_cohort(db, scope))) return Result({ _yay: null });
	const checks: Check[] = [{ source: args.target }];
	if (args.pendingUpdate) checks.push({ source: { kind: "proposal", id: args.pendingUpdate._id } });
	if (args.membership)
		checks.push(
			...(await pending_membership_checks(
				db,
				args.target,
				[args.pendingUpdate?.pendingMove, args.pendingMove],
				args.pendingUpdate ?? undefined,
			)),
		);
	for (const check of checks) {
		const result = await files_move_reservations_db_check(db, check);
		if (result._nay) return result;
	}
	return Result({ _yay: null });
}

/**
 * Keep accepted work. The wake mutation schedules it before deleting this doc.
 */
export async function files_move_reservations_db_pause_worker(
	ctx: MutationCtx,
	args: { worker: Doc<"files_move_waiters">["worker"]; check: Check },
) {
	const cohortId = await files_move_reservations_db_find_blocker(ctx.db, args.check);
	const stored = await ctx.db
		.query("files_move_waiters")
		.withIndex("by_worker", (q) => q.eq("worker.kind", args.worker.kind).eq("worker.id", args.worker.id))
		.unique();
	if (!cohortId) {
		if (stored) await ctx.db.delete("files_move_waiters", stored._id);
		return false;
	}
	if (stored) {
		const worker =
			stored.worker.kind === "content_cleanup" && args.worker.kind === "content_cleanup"
				? { ...args.worker, throughSequence: Math.max(stored.worker.throughSequence, args.worker.throughSequence) }
				: args.worker;
		if (stored.cohortId !== cohortId || JSON.stringify(stored.worker) !== JSON.stringify(worker))
			await ctx.db.patch("files_move_waiters", stored._id, { cohortId, worker });
	} else await ctx.db.insert("files_move_waiters", { cohortId, worker: args.worker, createdAt: Date.now() });
	return true;
}

/**
 * Wake and delete this page together. The next mutation starts at the first doc again.
 */
export async function files_move_reservations_db_take_waiters(
	ctx: MutationCtx,
	args: { cohortId: Id<"files_move_cohorts">; numItems: number },
) {
	return await ctx.db
		.query("files_move_waiters")
		.withIndex("by_cohort", (q) => q.eq("cohortId", args.cohortId))
		.paginate({ cursor: null, numItems: args.numItems });
}

/**
 * Allow internal staging or cleanup for this mutation only.
 */
export async function files_move_reservations_db_enter(ctx: MutationCtx, args: Capability) {
	const cohort = await ctx.db.get("files_move_cohorts", args.cohortId);
	const phases =
		args.mode === "stage"
			? ["staging", "validating", "ready"]
			: args.mode === "abort"
				? ["aborting"]
				: ["published", "finishing"];
	if (
		!cohort ||
		cohort.fence !== args.fence ||
		cohort.attemptFence !== args.attemptFence ||
		(args.mode === "abort" && cohort.visibleView !== "before") ||
		!phases.includes(cohort.phase)
	)
		return Result({ _nay: { name: "stopped", message: "This Move step is no longer current." } });
	const state = (ctx.db as GuardedDb)[STATE];
	if (!state) throw new Error("Move writes need the mutation wrapper.");
	state.capability = args;
	return Result({ _yay: null });
}

/**
 * Keep access changes live. First prove permission to change this node's rule.
 */
export function files_move_reservations_db_enter_security(ctx: MutationCtx, args: { nodeId: Id<"files_nodes"> }) {
	const state = (ctx.db as GuardedDb)[STATE];
	if (!state) throw new Error("Security writes need the mutation wrapper.");
	state.securityNodes.add(args.nodeId);
}

/**
 * Reuse a known scope while its fields stay unchanged. Active workspace guards still apply.
 */
export function files_move_reservations_db_note_source(
	db: MutationCtx["db"],
	args: { table: TableNames; id: string; old: Scope & { owner?: Doc<"files_metadata_maps">["owner"] } },
) {
	(db as GuardedDb)[STATE]?.knownScopes.set(`${args.table}:${args.id}`, args.old);
}

const SIDE_TABLES = new Set([
	"files_metadata_docs",
	"files_metadata_maps",
	"files_text_chunks",
	"files_plain_text_chunks",
	"files_yjs_snapshots",
	"files_yjs_updates",
	"files_yjs_docs_last_sequences",
	"files_yjs_trusted_update_stages",
	"files_snapshots",
	"file_stats",
	"files_pending_updates_last_sequence_saved",
	"files_pending_update_yjs_states",
	"files_pending_update_yjs_state_pages",
	"files_pending_update_operation_batches",
	"files_pending_update_text_inputs",
]);
const SOURCE_TABLES = new Set([
	"files_nodes",
	"files_pending_nodes",
	"files_pending_updates",
	"files_pending_node_publish_receipts",
]);

function source_of(table: string, id: string | null, value: Fields): Source | null {
	if (table === "files_metadata_maps") {
		const owner = value.owner as Doc<"files_metadata_maps">["owner"];
		if (owner.kind === "saved") return { kind: "saved", id: owner.id };
		if (owner.kind === "pending") return { kind: "proposal", id: owner.id };
		return null;
	}
	if (id && table === "files_nodes") return { kind: "saved", id: id as Id<"files_nodes"> };
	if (id && table === "files_pending_nodes") return { kind: "private", id: id as Id<"files_pending_nodes"> };
	if (id && table === "files_pending_updates") return { kind: "proposal", id: id as Id<"files_pending_updates"> };
	if (id && table === "files_pending_node_publish_receipts")
		return { kind: "receipt", id: id as Id<"files_pending_node_publish_receipts"> };
	if (typeof value.fileNodeId === "string") return { kind: "saved", id: value.fileNodeId as Id<"files_nodes"> };
	if (typeof value.pendingUpdateId === "string")
		return { kind: "proposal", id: value.pendingUpdateId as Id<"files_pending_updates"> };
	return null;
}

/**
 * Allow Rename to allocate only its next missing parent folder.
 */
export async function files_move_reservations_db_is_rename_allocation(
	db: QueryCtx["db"],
	args: { cohortId: Id<"files_move_cohorts">; node: WithoutSystemFields<Doc<"files_nodes">> },
) {
	const { node } = args;
	const cohort = await db.get("files_move_cohorts", args.cohortId);
	if (
		!cohort ||
		cohort.origin.kind !== "transfer" ||
		cohort.phase !== "staging" ||
		cohort.workPhase !== "rename_parents" ||
		cohort.visibleView !== "before" ||
		cohort.publishedAt !== null ||
		cohort.deadlineAt <= Date.now() ||
		!cohort.planningCursor
	)
		return false;
	const run = await db.get("files_transfer_runs", cohort.origin.runId);
	const item = await db.get("files_transfer_items", cohort.origin.itemId);
	if (
		!run ||
		run.origin.kind !== "rename" ||
		!run.rename ||
		run.kind !== "move" ||
		run.publication !== "saved" ||
		run.revision !== cohort.fence ||
		run.organizationId !== cohort.organizationId ||
		run.workspaceId !== cohort.workspaceId ||
		run.userId !== cohort.userId ||
		!item ||
		item.runId !== run._id ||
		item.state !== "pending" ||
		item.attempt !== cohort.attemptFence
	)
		return false;
	let cursor: unknown;
	try {
		cursor = JSON.parse(cohort.planningCursor);
	} catch {
		return false;
	}
	if (
		!validate(
			v.object({
				segmentIndex: v.number(),
				parentId: v.string(),
				parentPath: v.string(),
				parentArchiveOperationId: v.union(v.string(), v.null()),
			}),
			cursor,
		) ||
		!Number.isInteger(cursor.segmentIndex) ||
		cursor.segmentIndex < 0
	)
		return false;
	const segments = path_extract_segments_from(run.rename.inputPath);
	if (cursor.segmentIndex >= segments.length - 1) return false;
	const parentId = cursor.parentId === "root" ? "root" : db.normalizeId("files_nodes", cursor.parentId);
	if (!parentId) return false;
	const parent =
		parentId === "root"
			? null
			: await files_saved_placement_db_get_node(db, parentId, { cohortId: cohort._id, view: "after" });
	if (
		parentId !== "root" &&
		(!parent ||
			parent.kind !== "folder" ||
			parent.organizationId !== cohort.organizationId ||
			parent.workspaceId !== cohort.workspaceId)
	)
		return false;
	if (
		(parent?.path ?? "/") !== cursor.parentPath ||
		(parent?.archiveOperationId ?? null) !== cursor.parentArchiveOperationId
	)
		return false;
	const name = segments[cursor.segmentIndex]!;
	const path = cursor.parentPath === "/" ? `/${name}` : `${cursor.parentPath}/${name}`;
	return (
		node.moveCohortId === cohort._id &&
		node.publishedFromPrivateNodeId === undefined &&
		node.organizationId === cohort.organizationId &&
		node.workspaceId === cohort.workspaceId &&
		node.kind === "folder" &&
		node.parentId === parentId &&
		node.name === name &&
		node.path === path &&
		node.treePath === `${path}/` &&
		node.pathDepth === path_extract_segments_from(path).length &&
		node.archiveOperationId === cursor.parentArchiveOperationId &&
		node.restrictedScopeNodeId === (parent?.restrictedScopeNodeId ?? null) &&
		!node.isRestrictedScopeRoot &&
		JSON.stringify(node.writePolicy) === JSON.stringify(parent?.newChildWritePolicy ?? null) &&
		JSON.stringify(node.newChildWritePolicy) === JSON.stringify(parent?.newChildWritePolicy ?? null) &&
		node.createdBy === cohort.userId &&
		node.updatedBy === cohort.userId &&
		[
			node.assetId,
			node.contentType,
			node.contentByteSize,
			node.textKind,
			node.collaborationEnabled,
			node.yjsSnapshotId,
			node.yjsLastSequenceId,
			node.statsId,
		].every((value) => value === null)
	);
}

/**
 * Check every physical source write, including overlay flushes.
 */
export function files_move_reservations_db_wrap(ctx: MutationCtx) {
	const raw = ctx.db;
	const state: State = {
		raw,
		capability: null,
		securityNodes: new Set(),
		knownScopes: new Map(),
		nodes: new Map(),
		sourceReads: new Map(),
		slots: new Map(),
		holders: new Map(),
	};
	const reservationTables = new Set([
		"files_move_workspace_slots",
		"files_move_source_reservations",
		"files_move_slot_claims",
	]);
	async function scope_is_active(value: Scope) {
		// The slot read is shared with the busy checks below.
		return (await get_slot_cohort(db, value)) !== null;
	}
	// One walk per check in this transaction: a bulk side write repeats the same file's check per doc.
	// A reservation write or a parent change can change an answer, so it clears them all.
	// The map keeps the walk in flight too, so writes in a Promise.all share one walk. A write that
	// clears the map during a walk keeps later checks from reusing it.
	const blockers = new Map<string, Promise<Id<"files_move_cohorts"> | null>>();
	function forget_blockers() {
		blockers.clear();
		// A new map, so a walk still in flight fills only the old one.
		state.holders = new Map();
	}
	function forget_reads() {
		state.nodes.clear();
		state.knownScopes.clear();
		state.slots.clear();
		state.sourceReads.clear();
		forget_blockers();
	}
	function find_blocker(check: Check) {
		const key = JSON.stringify(check);
		let blocker = blockers.get(key);
		if (!blocker) {
			blocker = files_move_reservations_db_find_blocker(db, check);
			blockers.set(key, blocker);
		}
		return blocker;
	}
	async function guard(
		table: string,
		id: string | null,
		old: Fields | null,
		next: Fields | null,
		patch: Fields | null,
	) {
		const value = next ?? old;
		if (!value) return;
		const scopes = old && next ? [old, next] : [value];
		if (!(await Promise.all(scopes.map((scope) => scope_is_active(scope as Scope)))).some(Boolean)) return;
		const checks: Check[] = [];
		// Only membership changes can move a child behind a folder page's cursor.
		const membershipFields =
			table === "files_nodes"
				? [
						"organizationId",
						"workspaceId",
						"parentId",
						"kind",
						"name",
						"path",
						"treePath",
						"pathDepth",
						"archiveOperationId",
						"publishedFromPrivateNodeId",
					]
				: table === "files_pending_nodes"
					? ["organizationId", "workspaceId", "userId", "parent", "kind", "name", "state", "creationGeneration"]
					: table === "files_pending_updates"
						? ["organizationId", "workspaceId", "userId", "target", "pendingMove", "pendingArchive"]
						: [];
		const membershipChanged =
			!old || !next || membershipFields.some((field) => JSON.stringify(old[field]) !== JSON.stringify(next[field]));
		for (const doc of old && next ? [old, next] : [value]) {
			const source = source_of(table, id, doc);
			if (source) checks.push({ source });
			if (
				table === "files_pending_updates" ||
				table === "files_pending_update_yjs_states" ||
				table === "files_pending_update_operation_batches" ||
				table === "files_pending_update_text_inputs"
			) {
				if (doc.target) checks.push({ source: doc.target as Doc<"files_pending_updates">["target"] });
			}
			if (table === "files_pending_updates" && membershipChanged) {
				const pendingUpdate = doc as Doc<"files_pending_updates">;
				checks.push(
					...(await pending_membership_checks(db, pendingUpdate.target, [pendingUpdate.pendingMove], pendingUpdate)),
				);
			}
			if (table === "files_pending_update_yjs_state_pages") {
				const family = await raw.get(
					"files_pending_update_yjs_states",
					doc.stateId as Id<"files_pending_update_yjs_states">,
				);
				if (family) checks.push({ source: family.target });
			}
			if (table === "files_pending_node_publish_receipts") {
				checks.push({ source: { kind: "private", id: doc.privateNodeId as Id<"files_pending_nodes"> } });
				checks.push({ source: { kind: "saved", id: doc.savedNodeId as Id<"files_nodes"> } });
			}
			if (table === "files_nodes") {
				if (!id && !old && typeof doc.publishedFromPrivateNodeId === "string")
					checks.push({ source: { kind: "private", id: doc.publishedFromPrivateNodeId as Id<"files_pending_nodes"> } });
				const organizationId = raw.normalizeId("organizations", doc.organizationId as string);
				const workspaceId = raw.normalizeId("organizations_workspaces", doc.workspaceId as string);
				if (organizationId && workspaceId && membershipChanged)
					checks.push({
						...(!id && !old && typeof doc.moveCohortId === "string"
							? { wholeWorkspace: { organizationId, workspaceId } }
							: {}),
						parent:
							doc.parentId === "root" ? { kind: "root" } : { kind: "saved", id: doc.parentId as Id<"files_nodes"> },
						slot: {
							organizationId,
							workspaceId,
							parentId: doc.parentId as Doc<"files_nodes">["parentId"],
							name: doc.name as string,
						},
					});
			} else if (table === "files_pending_nodes" && doc.parent && membershipChanged)
				checks.push(parent_check(db, doc as Scope, doc.parent as files_PendingParent, doc.name as string));
		}
		for (const check of checks) {
			const blocker = await find_blocker(check);
			if (!blocker) continue;
			const nodeId = table === "files_nodes" ? id : value.fileNodeId;
			if (patch && state.securityNodes.has(nodeId as Id<"files_nodes">)) {
				const fields =
					table === "files_nodes"
						? [
								"writePolicy",
								"newChildWritePolicy",
								"restrictedScopeNodeId",
								"isRestrictedScopeRoot",
								"parentScopeNodeId",
								"scopeOpId",
								"extendedScopeNodeId",
								"parentExtendedScopeNodeId",
								"publicScopeNodeId",
							]
						: table === "files_metadata_docs"
							? ["isRestrictedScopeRoot", "restrictedScopeNodeId"]
							: [];
				if (Object.keys(patch).every((field) => fields.includes(field))) continue;
			}
			const capability = state.capability;
			if (capability?.cohortId === blocker) {
				if (capability.mode === "finish" || capability.mode === "abort") continue;
				if (
					[
						"files_pending_update_operation_batches",
						"files_pending_update_text_inputs",
						"files_pending_update_yjs_states",
						"files_pending_update_yjs_state_pages",
						"files_yjs_trusted_update_stages",
					].includes(table)
				) {
					let owned = true;
					for (let doc of old && next ? [old, next] : [value]) {
						if (table === "files_pending_update_yjs_state_pages") {
							const family = await raw.get(
								"files_pending_update_yjs_states",
								doc.stateId as Id<"files_pending_update_yjs_states">,
							);
							if (!family) {
								owned = false;
								break;
							}
							doc = family;
						}
						const owner = doc.owner as
							| { kind?: string; cohortId?: string; contentId?: string; operationBatchId?: string }
							| undefined;
						const contentId: unknown =
							table === "files_pending_update_operation_batches" ||
							table === "files_pending_update_text_inputs" ||
							table === "files_yjs_trusted_update_stages"
								? doc.cohortContentId
								: owner?.kind === "cohort" && owner.cohortId === blocker
									? owner.contentId
									: null;
						if (typeof contentId !== "string") {
							owned = false;
							break;
						}
						const content: Doc<"files_move_cohort_content"> | null = await raw.get(
							"files_move_cohort_content",
							contentId as Id<"files_move_cohort_content">,
						);
						const item = content && (await raw.get("files_move_cohort_items", content.itemId));
						const trustedStage = table === "files_yjs_trusted_update_stages";
						const target = (trustedStage ? { kind: "saved", id: doc.fileNodeId } : doc.target) as
							| { kind?: string; id?: string }
							| undefined;
						const batch =
							trustedStage && content?.operationBatchId
								? await raw.get("files_pending_update_operation_batches", content.operationBatchId)
								: null;
						if (
							!content ||
							content.cohortId !== blocker ||
							!item ||
							item.cohortId !== blocker ||
							target?.kind !== item.target.kind ||
							target?.id !== item.target.id ||
							(trustedStage
								? !batch ||
									batch.cohortContentId !== content._id ||
									batch.expectedPendingUpdateId !== content.pendingUpdateId ||
									batch.target.kind !== item.target.kind ||
									batch.target.id !== item.target.id ||
									doc.kind !== "pending_accept" ||
									doc.organizationId !== batch.organizationId ||
									doc.workspaceId !== batch.workspaceId ||
									doc.userId !== batch.userId ||
									(id !== null && (batch.publication?.kind !== "update" || batch.publication.trustedStageId !== id))
								: table === "files_pending_update_operation_batches"
									? doc.expectedPendingUpdateId !== content.pendingUpdateId ||
										(id !== null && id !== content.operationBatchId)
									: (doc.operationBatchId ?? owner?.operationBatchId) !== content.operationBatchId)
						) {
							owned = false;
							break;
						}
					}
					if (owned) continue;
				}
				if (
					!id &&
					!old &&
					table === "files_nodes" &&
					next?.moveCohortId === blocker &&
					(await files_move_reservations_db_is_rename_allocation(raw, {
						cohortId: blocker,
						node: next as WithoutSystemFields<Doc<"files_nodes">>,
					}))
				)
					continue;
				if (
					!id &&
					!old &&
					table === "files_nodes" &&
					next?.moveCohortId === blocker &&
					typeof next.publishedFromPrivateNodeId === "string"
				) {
					const reservation = await files_move_reservations_db_get_source(db, {
						kind: "private",
						id: next.publishedFromPrivateNodeId as Id<"files_pending_nodes">,
					});
					if (reservation?.cohortId === blocker) continue;
				}
				const tag = next?.moveView as Doc<"files_share_rows">["moveView"];
				if (tag?.cohortId === blocker) continue;
				if (patch && SOURCE_TABLES.has(table) && Object.keys(patch).every((field) => field === "moveCohortId"))
					continue;
			}
			throw new ConvexError(BUSY);
		}
	}
	const db = new Proxy(raw, {
		get(target, property) {
			if (property === "get")
				return async (...args: unknown[]) => {
					const id = args[args.length - 1] as string;
					const table = args.length === 2 ? args[0] : null;
					if (table === "files_nodes" || (table === null && target.normalizeId("files_nodes", id)))
						return await get_node(db, { kind: "saved", id: id as Id<"files_nodes"> });
					if (table === "files_pending_nodes" || (table === null && target.normalizeId("files_pending_nodes", id)))
						return await get_node(db, { kind: "private", id: id as Id<"files_pending_nodes"> });
					return await Reflect.apply(Reflect.get(target, "get"), target, args);
				};
			if (property === STATE) return state;
			if (property === "insert")
				return async (table: TableNames, value: Fields) => {
					if (reservationTables.has(table)) {
						state.slots.clear();
						state.sourceReads.clear();
						forget_blockers();
						try {
							return await target.insert(table, value as never);
						} finally {
							// A read started during this write must not stay cached after it.
							state.slots.clear();
							state.sourceReads.clear();
							forget_blockers();
						}
					}
					if (SOURCE_TABLES.has(table) || SIDE_TABLES.has(table)) await guard(table, null, null, value, null);
					return await target.insert(table, value as never);
				};
			if (property === "patch" || property === "replace" || property === "delete")
				return async (...args: unknown[]) => {
					const tableFirst = args.length === (property === "delete" ? 2 : 3);
					const table = tableFirst
						? (args[0] as TableNames)
						: ([...SOURCE_TABLES, ...SIDE_TABLES].find((name) =>
								target.normalizeId(name as TableNames, args[0] as string),
							) as TableNames | undefined);
					if (table && reservationTables.has(table)) {
						state.slots.clear();
						state.sourceReads.clear();
						forget_blockers();
						try {
							return await Reflect.apply(Reflect.get(target, property), target, args);
						} finally {
							state.slots.clear();
							state.sourceReads.clear();
							forget_blockers();
						}
					}
					const value = property === "delete" ? null : (args[tableFirst ? 2 : 1] as Fields);
					// A node parent change can change a blocker walk.
					const changesBlockers =
						(table === "files_nodes" || table === "files_pending_nodes") &&
						(property !== "patch" || "parentId" in value! || "parent" in value!);
					if (changesBlockers) forget_blockers();
					const source = table === "files_nodes" ? "saved" : table === "files_pending_nodes" ? "private" : null;
					const nodeKey = source ? `${source}:${args[tableFirst ? 1 : 0]}` : null;
					const write = async () => {
						if (nodeKey) state.nodes.delete(nodeKey);
						try {
							return await Reflect.apply(Reflect.get(target, property), target, args);
						} finally {
							if (nodeKey) state.nodes.delete(nodeKey);
							if (changesBlockers) forget_blockers();
						}
					};
					if (table && (SOURCE_TABLES.has(table) || SIDE_TABLES.has(table))) {
						const id = args[tableFirst ? 1 : 0] as Id<TableNames>;
						const key = `${table}:${id}`;
						const known = state.knownScopes.get(key);
						const keepsScope =
							property === "patch" && value && !("organizationId" in value) && !("workspaceId" in value);
						if (!keepsScope) state.knownScopes.delete(key);
						const nextScope = property === "replace" ? (value as Scope) : ({ ...known, ...value } as Scope);
						if (
							known &&
							!(await scope_is_active(known)) &&
							(property === "delete" || !(await scope_is_active(nextScope)))
						)
							return await write();
						// A metadata delete's guard reads only the owner fields, and the overlay notes them all.
						const old = (
							property === "delete" &&
							known &&
							((table === "files_metadata_docs" && "fileNodeId" in known && "pendingUpdateId" in known) ||
								(table === "files_metadata_maps" && "owner" in known))
								? known
								: table === "files_nodes"
									? await get_node(db, { kind: "saved", id: id as Id<"files_nodes"> })
									: table === "files_pending_nodes"
										? await get_node(db, { kind: "private", id: id as Id<"files_pending_nodes"> })
										: await target.get(table, id as Id<typeof table>)
						) as Fields | null;
						const next = property === "patch" ? { ...old, ...value } : value;
						await guard(table, id, old, next, property === "patch" ? value : null);
					}
					return await write();
				};
			const value = Reflect.get(target, property) as unknown;
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const runMutation: MutationCtx["runMutation"] = async (mutation, ...args) => {
		// A child mutation has its own wrapper and can change nodes or holds read by this one.
		forget_reads();
		try {
			return await ctx.runMutation(mutation, ...args);
		} finally {
			forget_reads();
		}
	};
	return { db, runMutation };
}
