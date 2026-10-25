// Temporary ownership bridge. Existing content readers stay authoritative until the backfill audit.
// Keep this module a leaf: every mutation loads it through functions.ts.

import type { WithoutSystemFields } from "convex/server";
import type { Doc, Id, TableNames } from "../convex/_generated/dataModel.js";
import type { MutationCtx } from "../convex/_generated/server.js";
import { files_metadata_FRONTMATTER_FIELD_PREFIX } from "../shared/files-metadata.ts";
import { should_never_happen } from "../shared/shared-utils.ts";

const BRIDGE = Symbol("files_content_heads");
const CONTENT_TABLES = new Set<TableNames>([
	"files_text_chunks",
	"files_plain_text_chunks",
	"files_yjs_updates",
	"files_metadata_docs",
]);
const WATCHED_TABLES = new Set<TableNames>([
	...CONTENT_TABLES,
	"files_nodes",
	"files_saved_places",
	"files_move_cohort_content",
	"files_yjs_snapshots",
	"files_yjs_docs_last_sequences",
	"file_stats",
]);
const HEADER_FIELDS = [
	"contentType",
	"assetId",
	"pendingContentVersion",
	"contentByteSize",
	"textKind",
	"collaborationEnabled",
	"yjsSnapshotId",
	"yjsLastSequenceId",
	"statsId",
	"contentTooLargeByteSize",
	"contentShapeMismatchAt",
	"contentYjsStateTooLargeByteSize",
	"contentFrontmatterTooLargeFieldCount",
	"contentFrontmatterTooLargeIndexDocumentCount",
	"updatedAt",
	"updatedBy",
] as const;

type Head = Doc<"files_saved_content_heads">;
type Fields = Record<string, unknown>;
type Bridge = {
	db: MutationCtx["db"];
	backfill: (table: TableNames, id: Id<TableNames>, repair?: boolean) => Promise<void>;
	flush: () => Promise<void>;
};
type ContentDoc = {
	_id?: string;
	fileNodeId?: Id<"files_nodes">;
	sourceKind?: string;
	fieldPath?: string;
	moveView?: { cohortId: Id<"files_move_cohorts">; view: "before" | "after" };
	contentHeadId?: Id<"files_saved_content_heads">;
};

function has_content(table: TableNames, doc: ContentDoc) {
	return (
		doc.fileNodeId &&
		doc.sourceKind !== "pending" &&
		(table !== "files_metadata_docs" || doc.fieldPath?.startsWith(files_metadata_FRONTMATTER_FIELD_PREFIX))
	);
}

function header(node: Doc<"files_nodes"> | Doc<"files_saved_places">) {
	return {
		contentType: node.contentType,
		assetId: node.assetId,
		pendingContentVersion: node.pendingContentVersion,
		contentByteSize: node.contentByteSize,
		textKind: node.textKind,
		collaborationEnabled: node.collaborationEnabled,
		yjsSnapshotId: node.yjsSnapshotId,
		yjsLastSequenceId: node.yjsLastSequenceId,
		statsId: node.statsId,
		contentTooLargeByteSize: node.contentTooLargeByteSize,
		contentShapeMismatchAt: node.contentShapeMismatchAt,
		contentYjsStateTooLargeByteSize: node.contentYjsStateTooLargeByteSize,
		contentFrontmatterTooLargeFieldCount: node.contentFrontmatterTooLargeFieldCount,
		contentFrontmatterTooLargeIndexDocumentCount: node.contentFrontmatterTooLargeIndexDocumentCount,
		updatedAt: node.updatedAt,
		updatedBy: node.updatedBy,
	};
}

/**
 * Backfill only the doc that still exists in this transaction. Cleanup may have removed or retagged it.
 */
export async function files_content_heads_db_backfill(ctx: MutationCtx, table: TableNames, id: Id<TableNames>) {
	const bridge = Reflect.get(ctx.db, BRIDGE) as Bridge | undefined;
	if (!bridge) throw should_never_happen("Content backfill needs the mutation wrapper", { table, id });
	await bridge.backfill(table, id, true);
}

/**
 * Include copied head writes before a worker checks its transaction budget.
 */
export async function files_content_heads_db_flush(ctx: MutationCtx) {
	const bridge = Reflect.get(ctx.db, BRIDGE) as Bridge | undefined;
	await bridge?.flush();
}

export function files_content_heads_db_wrap(ctx: MutationCtx): Bridge {
	const raw = ctx.db;
	const dirty = new Set<Id<"files_nodes">>();
	const nodes = new Map<Id<"files_nodes">, Promise<Id<"files_saved_content_heads"> | null>>();
	const contents = new Map<
		Id<"files_move_cohort_content">,
		Promise<{
			before: Id<"files_saved_content_heads">;
			after: Id<"files_saved_content_heads">;
		} | null>
	>();

	async function values(node: Doc<"files_nodes"> | Doc<"files_saved_places">, sequence?: Head["sequence"]) {
		const [snapshot, physicalSequence] = await Promise.all([
			node.yjsSnapshotId ? raw.get("files_yjs_snapshots", node.yjsSnapshotId) : null,
			sequence === undefined && node.yjsLastSequenceId
				? raw.get("files_yjs_docs_last_sequences", node.yjsLastSequenceId)
				: null,
		]);
		return {
			...header(node),
			snapshotAssetId: snapshot?.assetId ?? null,
			sequence:
				sequence ??
				(physicalSequence
					? {
							lastSequence: physicalSequence.lastSequence,
							lineageGeneration: physicalSequence.lineageGeneration,
							unmaterializedUpdateCount: physicalSequence.unmaterializedUpdateCount,
							unmaterializedUpdateBytes: physicalSequence.unmaterializedUpdateBytes,
						}
					: null),
		};
	}

	function ensure_node(nodeId: Id<"files_nodes">) {
		let pending = nodes.get(nodeId);
		if (!pending) {
			pending = (async () => {
				const node = await raw.get("files_nodes", nodeId);
				if (!node || node.kind !== "file") return null;
				if (node.contentHeadId) return node.contentHeadId;
				const id = await raw.insert("files_saved_content_heads", {
					organizationId: node.organizationId,
					workspaceId: node.workspaceId,
					fileNodeId: node._id,
					...(await values(node)),
					ready: true,
					retired: false,
				});
				await raw.patch("files_nodes", nodeId, { contentHeadId: id });
				return id;
			})();
			nodes.set(nodeId, pending);
		}
		return pending;
	}

	function ensure_content(contentId: Id<"files_move_cohort_content">) {
		let pending = contents.get(contentId);
		if (!pending) {
			pending = (async () => {
				const content = await raw.get("files_move_cohort_content", contentId);
				if (!content) return null;
				const node = await raw.get("files_nodes", content.nodeId);
				if (!node) return null;
				// Completed history cannot borrow today's content owner.
				if (
					(content.phaseCursor === "finish:done" || content.phaseCursor === "abort:done") &&
					node.moveCohortId !== content.cohortId
				)
					return null;
				const before = content.beforeHeadId ?? (await ensure_node(content.nodeId));
				if (!before) return null;
				// Review copies committed docs even when its accepted text is unchanged.
				// Each copy needs its own owner; public Yjs IDs stay the same.
				const prepared = content.prepared !== null;
				let after = content.afterHeadId ?? before;
				// Late migration keeps only the accepted head once content cleanup is complete.
				if (
					prepared &&
					after === before &&
					content.phaseCursor !== "finish:done" &&
					content.phaseCursor !== "abort:done"
				) {
					after = await raw.insert("files_saved_content_heads", {
						organizationId: node.organizationId,
						workspaceId: node.workspaceId,
						fileNodeId: node._id,
						...(await values(node)),
						ready: false,
						retired: false,
					});
				}
				await raw.patch("files_move_cohort_content", contentId, { beforeHeadId: before, afterHeadId: after });
				dirty.add(content.nodeId);
				return { before, after };
			})();
			contents.set(contentId, pending);
		}
		return pending;
	}

	async function owner(doc: ContentDoc) {
		const nodeId = doc.fileNodeId!;
		const node = await raw.get("files_nodes", nodeId);
		if (!node || node.kind !== "file") return null;
		const cohortId = doc.moveView?.cohortId ?? node.moveCohortId;
		if (cohortId) {
			const content = await raw
				.query("files_move_cohort_content")
				.withIndex("by_cohort_node", (q) => q.eq("cohortId", cohortId).eq("nodeId", nodeId))
				.unique();
			if (content) {
				const heads = await ensure_content(content._id);
				if (heads) {
					const cohort = await raw.get("files_move_cohorts", cohortId);
					const view = doc.moveView?.view ?? cohort?.visibleView;
					return view === "after" ? heads.after : heads.before;
				}
			}
		}
		return await ensure_node(nodeId);
	}

	async function tag(table: TableNames, id: Id<TableNames>, doc: ContentDoc, assign = false) {
		if (!has_content(table, doc) || (!assign && doc.contentHeadId)) return;
		const contentHeadId = await owner(doc);
		if (contentHeadId && contentHeadId !== doc.contentHeadId) await raw.patch(table, id, { contentHeadId } as never);
	}

	async function sync_place(place: Doc<"files_saved_places">) {
		if (place.kind !== "file") return;
		const contentHeadId = await owner({
			fileNodeId: place.nodeId,
			moveView: { cohortId: place.cohortId, view: place.view },
		});
		if (contentHeadId && place.contentHeadId !== contentHeadId)
			await raw.patch("files_saved_places", place._id, { contentHeadId });
	}

	async function complete_content(content: Doc<"files_move_cohort_content">) {
		const node = await raw.get("files_nodes", content.nodeId);
		if (!node || node.moveCohortId !== content.cohortId) return;
		const heads = await ensure_content(content._id);
		if (!heads) return;
		const kept = content.phaseCursor === "finish:done" ? heads.after : heads.before;
		await raw.patch("files_nodes", node._id, { contentHeadId: kept });
		nodes.set(node._id, Promise.resolve(kept));
		dirty.add(node._id);
		const retired = kept === heads.after ? heads.before : heads.after;
		if (retired !== kept) await raw.patch("files_saved_content_heads", retired, { ready: false, retired: true });
	}

	async function backfill(table: TableNames, id: Id<TableNames>, repair = false) {
		if (!WATCHED_TABLES.has(table)) return;
		const doc = await raw.get(table, id);
		if (!doc) return;
		if (table === "files_nodes") {
			const node = doc as Doc<"files_nodes">;
			await ensure_node(node._id);
			dirty.add(node._id);
		} else if (table === "files_saved_places") await sync_place(doc as Doc<"files_saved_places">);
		else if (table === "files_move_cohort_content") {
			const content = doc as Doc<"files_move_cohort_content">;
			await ensure_content(content._id);
			if (content.phaseCursor === "finish:done" || content.phaseCursor === "abort:done")
				await complete_content(content);
		} else if (CONTENT_TABLES.has(table)) {
			// Old bridge writes shared an owner for unchanged Review copies.
			// Only migration rechecks those tags; normal promotion keeps its owner.
			await tag(table, id, doc as ContentDoc, repair);
		}
		else dirty.add((doc as ContentDoc).fileNodeId!);
	}

	const db = new Proxy(raw, {
		get(target, property) {
			if (property === BRIDGE) return bridge;
			if (property === "insert")
				return async (table: TableNames, value: Fields) => {
					const id = await target.insert(table, value as never);
					if (CONTENT_TABLES.has(table)) await tag(table, id, value as ContentDoc, true);
					else await backfill(table, id);
					return id;
				};
			if (property === "patch" || property === "replace" || property === "delete")
				return async (...args: unknown[]) => {
					const write = Reflect.get(target, property) as (...args: unknown[]) => Promise<void>;
					const tableFirst = args.length === (property === "delete" ? 2 : 3);
					if (!tableFirst) {
						for (const table of WATCHED_TABLES)
							if (raw.normalizeId(table, String(args[0])))
								throw should_never_happen("Content writes must name their table", { table, id: args[0] });
						return await Reflect.apply(write, target, args);
					}
					const table = args[0] as TableNames;
					const id = args[1] as Id<TableNames>;
					const patch = property === "delete" ? null : (args[2] as Fields);
					if (
						!WATCHED_TABLES.has(table) ||
						(property === "patch" && Object.keys(patch!).every((key) => key === "contentHeadId"))
					)
						return await Reflect.apply(write, target, args);
					// Deleted content needs no new ownership tag.
					if (CONTENT_TABLES.has(table) && property === "delete") return await Reflect.apply(write, target, args);
					if (
						table === "files_nodes" &&
						property === "patch" &&
						!HEADER_FIELDS.some((key) => key in patch!) &&
						!("moveCohortId" in patch!)
					)
						return await Reflect.apply(write, target, args);
					const old = await raw.get(table, id);
					if (old && CONTENT_TABLES.has(table)) {
						// Assign from the old side before promotion clears its Move tag.
						await tag(table, id, old as ContentDoc);
						if (property === "replace") {
							const tagged = (await raw.get(table, id)) as ContentDoc;
							if (tagged.contentHeadId) args[2] = { ...patch, contentHeadId: tagged.contentHeadId };
						}
					}
					if (old && table === "files_move_cohort_content" && property === "delete") {
						const content = old as Doc<"files_move_cohort_content">;
						const node = await raw.get("files_nodes", content.nodeId);
						// History cleanup only removes its old owners. It never selects current content.
						for (const headId of new Set([content.beforeHeadId, content.afterHeadId]))
							if (headId && headId !== node?.contentHeadId) await raw.delete("files_saved_content_heads", headId);
					}
					await Reflect.apply(write, target, args);
					if (table === "files_move_cohort_content") contents.delete(id as Id<"files_move_cohort_content">);
					if (property === "delete") {
						if (table === "files_nodes") {
							// Old and candidate heads belong to the existing paged cohort cleanup.
							const node = old as Doc<"files_nodes"> | null;
							if (node?.contentHeadId) await raw.delete("files_saved_content_heads", node.contentHeadId);
							nodes.delete(id as Id<"files_nodes">);
						} else if (old && "fileNodeId" in old) dirty.add(old.fileNodeId as Id<"files_nodes">);
						return;
					}
					await backfill(table, id);
				};
			const value: unknown = Reflect.get(target, property);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});

	async function sync_head(id: Id<"files_saved_content_heads">, next: Partial<WithoutSystemFields<Head>>) {
		const old = await raw.get("files_saved_content_heads", id);
		if (!old) throw should_never_happen("Content owner is missing", { headId: id });
		if (Object.entries(next).some(([key, value]) => JSON.stringify(old[key as keyof Head]) !== JSON.stringify(value)))
			await raw.patch("files_saved_content_heads", id, next);
	}

	const bridge = {
		db,
		backfill,
		async flush() {
			for (const nodeId of dirty) {
				const node = await raw.get("files_nodes", nodeId);
				if (!node || node.kind !== "file") continue;
				const currentId = await ensure_node(nodeId);
				if (!currentId) continue;
				await sync_head(currentId, { ...(await values(node)), ready: true, retired: false });
				if (!node.moveCohortId) continue;
				const content = await raw
					.query("files_move_cohort_content")
					.withIndex("by_cohort_node", (q) => q.eq("cohortId", node.moveCohortId!).eq("nodeId", nodeId))
					.unique();
				if (!content) continue;
				const heads = await ensure_content(content._id);
				if (!heads) continue;
				const places = await Promise.all(
					(["before", "after"] as const).map((view) =>
						raw
							.query("files_saved_places")
							.withIndex("by_cohort_view_node", (q) =>
								q.eq("cohortId", node.moveCohortId!).eq("view", view).eq("nodeId", nodeId),
							)
							.unique(),
					),
				);
				for (const place of places) if (place) await sync_place(place);
				const after = places[1];
				if (heads.after !== heads.before && content.phaseCursor !== "abort:done" && after) {
					const { lastSequenceId: _id, ...sequence } = content.afterSequence ?? { lastSequenceId: null };
					await sync_head(heads.after, {
						...(await values(after, content.afterSequence ? (sequence as NonNullable<Head["sequence"]>) : null)),
						ready: content.sealed,
						retired: false,
					});
					const cohort = (await raw.get("files_move_cohorts", node.moveCohortId))!;
					if (cohort.visibleView === "after") await sync_head(heads.before, { ready: false, retired: true });
				}
			}
			dirty.clear();
		},
	};
	return bridge;
}
