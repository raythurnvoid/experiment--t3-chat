// Exact write reservations. Callers still prove current access before asking whether a file is busy.

import { Result } from "common/errors-as-values-utils.ts";
import { ConvexError } from "convex/values";
import type { WithoutSystemFields } from "convex/server";
import { z } from "zod";
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
type State = { capability: Capability | null; securityNodes: Set<Id<"files_nodes">>; knownScopes: Map<string, Scope> };
type GuardedDb = MutationCtx["db"] & { [STATE]?: State };
type Fields = Record<string, unknown>;
const BUSY = { name: "move_busy", message: "This item is being moved. Try again when the Move ends." };

async function get_reservation(db: QueryCtx["db"], source: Source) {
	return await db
		.query("files_move_source_reservations")
		.withIndex("by_source", (q) => q.eq("source.kind", source.kind).eq("source.id", source.id))
		.unique();
}

async function get_parent(db: QueryCtx["db"], source: Extract<Source, { kind: "saved" | "private" }>) {
	if (source.kind === "saved") {
		const node = await db.get("files_nodes", source.id);
		return node && node.parentId !== "root" ? { kind: "saved" as const, id: node.parentId } : null;
	}
	const node = await db.get("files_pending_nodes", source.id);
	return node && node.parent.kind !== "root" ? node.parent : null;
}

/**
 * Check one source, its ancestors, and one destination slot.
 */
export async function files_move_reservations_db_find_blocker(db: QueryCtx["db"], args: Check) {
	if (args.wholeWorkspace) {
		const scope = args.wholeWorkspace;
		const slot = await db
			.query("files_move_workspace_slots")
			.withIndex("by_workspace", (q) =>
				q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId),
			)
			.unique();
		if (slot?.cohortId) return slot.cohortId;
	}
	if (args.source) {
		const reservation = await get_reservation(db, args.source);
		if (reservation) return reservation.cohortId;
	}
	let parent = args.parent?.kind === "root" ? null : (args.parent ?? null);
	if (!parent && (args.source?.kind === "saved" || args.source?.kind === "private"))
		parent = await get_parent(db, args.source);
	// This walk follows only this item's parent IDs.
	while (parent) {
		const reservation = await get_reservation(db, parent);
		if (reservation?.mode === "subtree") return reservation.cohortId;
		parent = await get_parent(db, parent);
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
 * Reuse a known scope for the next exact write. Active workspace guards still apply.
 */
export function files_move_reservations_db_note_source(
	db: MutationCtx["db"],
	args: { table: TableNames; id: string; old: Scope },
) {
	(db as GuardedDb)[STATE]?.knownScopes.set(`${args.table}:${args.id}`, args.old);
}

const SIDE_TABLES = new Set([
	"files_metadata_docs",
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
	let parsed: unknown;
	try {
		parsed = JSON.parse(cohort.planningCursor);
	} catch {
		return false;
	}
	const checked = z
		.object({
			segmentIndex: z.number().int().min(0),
			parentId: z.string(),
			parentPath: z.string(),
			parentArchiveOperationId: z.string().nullable(),
		})
		.safeParse(parsed);
	if (!checked.success) return false;
	const cursor = checked.data;
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
	const state: State = { capability: null, securityNodes: new Set(), knownScopes: new Map() };
	const activeScopes = new Map<string, boolean>();
	const reservationTables = new Set([
		"files_move_workspace_slots",
		"files_move_source_reservations",
		"files_move_slot_claims",
	]);
	async function scope_is_active(value: Scope) {
		const organizationId = raw.normalizeId("organizations", value.organizationId);
		const workspaceId = raw.normalizeId("organizations_workspaces", value.workspaceId);
		if (!organizationId || !workspaceId) return false;
		const key = `${organizationId}:${workspaceId}`;
		let active = activeScopes.get(key);
		if (active === undefined) {
			const slot = await raw
				.query("files_move_workspace_slots")
				.withIndex("by_workspace", (q) => q.eq("organizationId", organizationId).eq("workspaceId", workspaceId))
				.unique();
			active = slot?.cohortId != null;
			activeScopes.set(key, active);
		}
		return active;
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
				if (organizationId && workspaceId)
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
			} else if (table === "files_pending_nodes" && doc.parent)
				checks.push({ parent: doc.parent as files_PendingParent });
		}
		for (const check of checks) {
			const blocker = await files_move_reservations_db_find_blocker(raw, check);
			if (!blocker) continue;
			const nodeId = table === "files_nodes" ? id : value.fileNodeId;
			if (patch && state.securityNodes.has(nodeId as Id<"files_nodes">)) {
				const fields =
					table === "files_nodes"
						? ["writePolicy", "newChildWritePolicy", "restrictedScopeNodeId", "isRestrictedScopeRoot"]
						: table === "files_metadata_docs"
							? ["isRestrictedScopeRoot"]
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
					const reservation = await get_reservation(raw, {
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
			if (property === STATE) return state;
			if (property === "insert")
				return async (table: TableNames, value: Fields) => {
					if (reservationTables.has(table)) activeScopes.clear();
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
					if (table && reservationTables.has(table)) activeScopes.clear();
					if (table && (SOURCE_TABLES.has(table) || SIDE_TABLES.has(table))) {
						const id = args[tableFirst ? 1 : 0] as Id<TableNames>;
						const value = property === "delete" ? null : (args[tableFirst ? 2 : 1] as Fields);
						const key = `${table}:${id}`;
						const known = state.knownScopes.get(key);
						state.knownScopes.delete(key);
						const nextScope = property === "replace" ? (value as Scope) : ({ ...known, ...value } as Scope);
						if (
							known &&
							!(await scope_is_active(known)) &&
							(property === "delete" || !(await scope_is_active(nextScope)))
						)
							return await Reflect.apply(Reflect.get(target, property), target, args);
						const old = (await target.get(table, id)) as Fields | null;
						const next = property === "patch" ? { ...old, ...value } : value;
						await guard(table, id, old, next, property === "patch" ? value : null);
					}
					return await Reflect.apply(Reflect.get(target, property), target, args);
				};
			const value = Reflect.get(target, property) as unknown;
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return { db };
}
