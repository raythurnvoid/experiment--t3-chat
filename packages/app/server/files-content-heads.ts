// Saved content ownership for file writes and Review publication.
// Keep this module a leaf: every mutation loads it through functions.ts.

import type { WithoutSystemFields } from "convex/server";
import { internal } from "../convex/_generated/api.js";
import type { Doc, Id, TableNames } from "../convex/_generated/dataModel.js";
import type { MutationCtx } from "../convex/_generated/server.js";
import { files_metadata_FRONTMATTER_FIELD_PREFIX } from "../shared/files-metadata.ts";
import { should_never_happen } from "../shared/shared-utils.ts";
import { files_saved_content_db_get_head, files_saved_content_yjs_owner } from "./files-saved-content-head.ts";
import { files_content_retention_db_index_uses_head } from "./files-content-retention.ts";

const WRITES = Symbol("files_content_heads");
const OWNER_TABLES = new Set<TableNames>([
	"files_nodes",
	"files_move_cohort_content",
	"files_move_cohorts",
	"files_saved_content_heads",
]);
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
type ContentWrites = {
	db: MutationCtx["db"];
	runMutation: MutationCtx["runMutation"];
	pin: (head: Head) => void;
	stageInsert: (value: Fields, head: Head) => void;
	isStagedInsert: (value: Fields) => boolean;
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
 * Include copied head writes before a worker checks its transaction budget.
 */
export async function files_content_heads_db_flush(ctx: MutationCtx) {
	const writes = Reflect.get(ctx.db, WRITES) as ContentWrites | undefined;
	await writes?.flush();
}

export function files_content_heads_db_is_staged_insert(db: MutationCtx["db"], table: TableNames, value: Fields) {
	if (table !== "files_text_chunks" && table !== "file_stats") return false;
	const writes = Reflect.get(db, WRITES) as ContentWrites | undefined;
	return writes?.isStagedInsert(value) === true;
}

// The caller checks its Save or index run before writing this private candidate.
export function files_content_heads_db_for_head(ctx: MutationCtx, head: Head): MutationCtx["db"] {
	const writes = Reflect.get(ctx.db, WRITES) as ContentWrites | undefined;
	if (!writes) throw should_never_happen("Content writer is missing");
	writes.pin(head);
	return new Proxy(ctx.db, {
		get(target, property) {
			if (property === "insert") return async (table: TableNames, value: Fields) => {
				if (!CONTENT_TABLES.has(table) && table !== "file_stats") return await target.insert(table, value as never);
				if (head.retired || value.fileNodeId !== head.fileNodeId ||
					value.organizationId !== head.organizationId || value.workspaceId !== head.workspaceId)
					throw should_never_happen("Content candidate does not match its owner", { table, headId: head._id });
				// Keep catalog counts, access checks and reservations on the normal write path.
				const next = {
					...value, ...(CONTENT_TABLES.has(table) && has_content(table, value as ContentDoc) ? { contentHeadId: head._id } : {}),
				};
				writes.stageInsert(next, head);
				return await target.insert(table, next as never);
			};
			const value: unknown = Reflect.get(target, property);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

export function files_content_heads_db_wrap(ctx: MutationCtx): ContentWrites {
	const raw = ctx.db;
	const pinned = new Map<Id<"files_saved_content_heads">, Head>();
	const stagedInserts = new WeakSet<Fields>();
	const dirty = new Set<Id<"files_nodes">>();
	const nodes = new Map<Id<"files_nodes">, Promise<Id<"files_saved_content_heads"> | null>>();
	const owners = new Map<string, Promise<Id<"files_saved_content_heads"> | null>>();
	const contents = new Map<
		Id<"files_move_cohort_content">,
		Promise<{
			before: Id<"files_saved_content_heads">;
			after: Id<"files_saved_content_heads">;
		} | null>
	>();

	function forget_reads() {
		nodes.clear();
		owners.clear();
		contents.clear();
	}

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
				if (!node.contentHeadId) throw should_never_happen("Saved file has no content head", { nodeId });
				return node.contentHeadId;
			})();
			nodes.set(nodeId, pending);
		}
		return pending;
	}

	function ensure_content(contentId: Id<"files_move_cohort_content">, inserted = false) {
		let pending = contents.get(contentId);
		if (!pending) {
			pending = (async () => {
				const content = await raw.get("files_move_cohort_content", contentId);
				if (!content) return null;
				const node = await raw.get("files_nodes", content.nodeId);
				if (!node || node.kind !== "file") return null;
				const completed = content.phaseCursor === "finish:done" || content.phaseCursor === "abort:done";
				// Completed history cannot borrow today's content owner.
				if (
					completed &&
					(node.moveCohortId !== content.cohortId || !content.beforeHeadId || !content.afterHeadId)
				)
					return null;
				if (!inserted && (!content.beforeHeadId || !content.afterHeadId))
					throw should_never_happen("Review content has no owners", { contentId });
				const before = inserted ? await ensure_node(content.nodeId) : content.beforeHeadId!;
				if (!before) return null;
				// Review copies committed docs even when its accepted text is unchanged.
				// Each copy needs its own owner; its public Yjs identity can stay the same.
				const prepared = content.prepared !== null;
				let after = inserted ? before : content.afterHeadId!;
				if (prepared && after === before && !completed) {
					const place = await raw.query("files_saved_places")
						.withIndex("by_cohort_view_node", (q) =>
							q.eq("cohortId", content.cohortId).eq("view", "after").eq("nodeId", node._id),
						)
						.unique();
					const { lastSequenceId: _id, ...sequence } = content.afterSequence ?? { lastSequenceId: null };
					after = await raw.insert("files_saved_content_heads", {
						organizationId: node.organizationId,
						workspaceId: node.workspaceId,
						fileNodeId: node._id,
						yjsContentHeadId: null,
						...(await values(place ?? node, content.afterSequence ? (sequence as NonNullable<Head["sequence"]>) : null)),
						ready: content.sealed,
						retired: false,
					});
					if ((place ?? node).yjsLastSequenceId)
						await raw.patch("files_saved_content_heads", after, { yjsContentHeadId: after });
				}
				if (content.beforeHeadId !== before || content.afterHeadId !== after)
					await raw.patch("files_move_cohort_content", contentId, { beforeHeadId: before, afterHeadId: after });
				dirty.add(content.nodeId);
				return { before, after };
			})();
			contents.set(contentId, pending);
		}
		return pending;
	}

	function owner(doc: ContentDoc) {
		const nodeId = doc.fileNodeId!;
		const cohortId = doc.moveView?.cohortId;
		// Reuse one owner for a file's chunks and frontmatter until its selection changes.
		const key = cohortId ? `${nodeId}:${cohortId}:${doc.moveView!.view}` : nodeId;
		let pending = owners.get(key);
		if (!pending) {
			pending = (async () => {
				const node = await raw.get("files_nodes", nodeId);
				if (!node || node.kind !== "file") return null;
				const currentId = await ensure_node(nodeId);
				// Staged docs name their side. Ordinary writes follow today's selected content.
				if (cohortId) {
					const content = await raw
						.query("files_move_cohort_content")
						.withIndex("by_cohort_node", (q) => q.eq("cohortId", cohortId).eq("nodeId", nodeId))
						.unique();
					if (content) {
						const heads = await ensure_content(content._id);
						return heads ? (doc.moveView?.view === "after" ? heads.after : heads.before) : null;
					}
				}
				if (!currentId) return null;
				return (await files_saved_content_db_get_head(raw, { ...node, contentHeadId: currentId }))!._id;
			})();
			owners.set(key, pending);
		}
		return pending;
	}

	async function tag(table: TableNames, id: Id<TableNames>, doc: ContentDoc, inserted = false) {
		if (!has_content(table, doc)) return;
		if (!inserted) {
			if (!doc.contentHeadId) throw should_never_happen("Saved content doc has no owner", { table, id });
			return doc.contentHeadId;
		}
		if (doc.contentHeadId && pinned.get(doc.contentHeadId)?.fileNodeId === doc.fileNodeId) return doc.contentHeadId;
		let contentHeadId = await owner(doc);
		if (contentHeadId && table === "files_yjs_updates") {
			const head = await raw.get("files_saved_content_heads", contentHeadId);
			const logOwner = head ? files_saved_content_yjs_owner(head) : null;
			if (!logOwner) throw should_never_happen("Yjs content owner is missing", { contentHeadId });
			contentHeadId = logOwner;
		}
		if (contentHeadId) await raw.patch(table, id, { contentHeadId } as never);
		return contentHeadId;
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
		// A later write may already own the file. Cleanup must not select old content again.
		if (node.contentHeadId === heads.before) {
			await raw.patch("files_nodes", node._id, { contentHeadId: kept });
			nodes.set(node._id, Promise.resolve(kept));
			owners.clear();
		}
		dirty.add(node._id);
		const retired = kept === heads.after ? heads.before : heads.after;
		const currentId = node.contentHeadId === heads.before ? kept : node.contentHeadId;
		if (retired !== kept && retired !== currentId && !await files_content_retention_db_index_uses_head(raw, retired))
			await raw.patch("files_saved_content_heads", retired, { ready: false, retired: true });
	}

	async function sync_write(table: TableNames, id: Id<TableNames>, patch: Fields) {
		if (table !== "files_nodes" && table !== "files_yjs_snapshots" && table !== "files_yjs_docs_last_sequences") return;
		if (table === "files_nodes" && !HEADER_FIELDS.some((key) => key in patch)) return;
		if (table === "files_yjs_snapshots" && !("assetId" in patch)) return;
		if (
			table === "files_yjs_docs_last_sequences" &&
			!["lastSequence", "lineageGeneration", "unmaterializedUpdateCount", "unmaterializedUpdateBytes"].some((key) => key in patch)
		) return;
		const doc = await raw.get(table, id as Id<typeof table>);
		if (!doc) return;
		const nodeId = table === "files_nodes" ? (id as Id<"files_nodes">) : (doc as ContentDoc).fileNodeId!;
		const headId =
			table === "files_nodes" && typeof patch.contentHeadId === "string"
				? (patch.contentHeadId as Id<"files_saved_content_heads">)
				: await owner({ fileNodeId: nodeId });
		if (!headId) return;
		const head = await raw.get("files_saved_content_heads", headId);
		if (!head) throw should_never_happen("Content owner is missing", { headId });
		const next: Partial<WithoutSystemFields<Head>> = {};
		if (table === "files_nodes") {
			for (const key of HEADER_FIELDS) if (key in patch) Object.assign(next, { [key]: patch[key] });
			if ("yjsSnapshotId" in patch && patch.yjsSnapshotId !== head.yjsSnapshotId) {
				const snapshot = patch.yjsSnapshotId
					? await raw.get("files_yjs_snapshots", patch.yjsSnapshotId as Id<"files_yjs_snapshots">)
					: null;
				next.snapshotAssetId = snapshot?.assetId ?? null;
			}
			if ("yjsLastSequenceId" in patch && patch.yjsLastSequenceId !== head.yjsLastSequenceId) {
				next.yjsContentHeadId = patch.yjsLastSequenceId ? head._id : null;
				const sequence = patch.yjsLastSequenceId
					? await raw.get("files_yjs_docs_last_sequences", patch.yjsLastSequenceId as Id<"files_yjs_docs_last_sequences">)
					: null;
				next.sequence = sequence
					? {
							lastSequence: sequence.lastSequence,
							lineageGeneration: sequence.lineageGeneration,
							unmaterializedUpdateCount: sequence.unmaterializedUpdateCount,
							unmaterializedUpdateBytes: sequence.unmaterializedUpdateBytes,
						}
					: null;
			}
		} else if (table === "files_yjs_snapshots" && head.yjsSnapshotId === id && "assetId" in patch) {
			next.snapshotAssetId = (doc as Doc<"files_yjs_snapshots">).assetId;
		} else if (table === "files_yjs_docs_last_sequences" && head.yjsLastSequenceId === id && head.sequence) {
			const sequence = { ...head.sequence };
			for (const key of Object.keys(sequence) as Array<keyof typeof sequence>)
				if (key in patch) sequence[key] = (doc as Doc<"files_yjs_docs_last_sequences">)[key];
			next.sequence = sequence;
		}
		if (Object.keys(next).length > 0) await sync_head(head, next);
	}

	async function sync_doc(table: TableNames, id: Id<TableNames>, inserted = false) {
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
			await ensure_content(content._id, inserted);
			if (content.phaseCursor === "finish:done" || content.phaseCursor === "abort:done")
				await complete_content(content);
		} else if (CONTENT_TABLES.has(table)) await tag(table, id, doc as ContentDoc);
		else dirty.add((doc as ContentDoc).fileNodeId!);
	}

	const db = new Proxy(raw, {
		get(target, property) {
			if (property === WRITES) return writes;
			if (property === "insert")
				return async (table: TableNames, value: Fields) => {
					const changesOwner = OWNER_TABLES.has(table);
					if (changesOwner) forget_reads();
					let id: Id<TableNames>;
					try {
						id = await target.insert(table, value as never);
					} finally {
						if (changesOwner) forget_reads();
					}
					if (table === "files_nodes" && value.kind === "file") {
						const node = (await raw.get("files_nodes", id as Id<"files_nodes">))!;
						const headId = await raw.insert("files_saved_content_heads", {
							organizationId: node.organizationId,
							workspaceId: node.workspaceId,
							fileNodeId: node._id,
							yjsContentHeadId: null,
							...(await values(node)),
							ready: true,
							retired: false,
						});
						if (node.yjsLastSequenceId)
							await raw.patch("files_saved_content_heads", headId, { yjsContentHeadId: headId });
						await raw.patch("files_nodes", node._id, { contentHeadId: headId });
						nodes.set(node._id, Promise.resolve(headId));
					}
					if (CONTENT_TABLES.has(table)) await tag(table, id, value as ContentDoc, true);
					else await sync_doc(table, id, true);
					return id;
				};
			if (property === "patch" || property === "replace" || property === "delete")
				return async (...args: unknown[]) => {
					const method = Reflect.get(target, property) as (...args: unknown[]) => Promise<void>;
					const tableFirst = args.length === (property === "delete" ? 2 : 3);
					if (!tableFirst) {
						for (const table of [...WATCHED_TABLES, ...OWNER_TABLES])
							if (raw.normalizeId(table, String(args[0])))
								throw should_never_happen("Content writes must name their table", { table, id: args[0] });
						return await Reflect.apply(method, target, args);
					}
					const table = args[0] as TableNames;
					const id = args[1] as Id<TableNames>;
					const patch = property === "delete" ? null : (args[2] as Fields);
					const changesOwner = OWNER_TABLES.has(table);
					const write = async () => {
						if (changesOwner) forget_reads();
						try {
							return await Reflect.apply(method, target, args);
						} finally {
							// Drop lookups started while this write was still in flight.
							if (changesOwner) forget_reads();
						}
					};
					if (
						!WATCHED_TABLES.has(table) ||
						(property === "patch" && Object.keys(patch!).every((key) => key === "contentHeadId"))
					)
						return await write();
					// Deleted content needs no new ownership tag.
					if (CONTENT_TABLES.has(table) && property === "delete") return await write();
					if (
						table === "files_nodes" &&
						property === "patch" &&
						!HEADER_FIELDS.some((key) => key in patch!) &&
						!("moveCohortId" in patch!)
					)
						return await write();
					const old = await raw.get(table, id);
					if (old && CONTENT_TABLES.has(table)) {
						// Promotion keeps the same owner when it clears the Move tag.
						const contentHeadId = await tag(table, id, old as ContentDoc);
						if (property === "replace" && contentHeadId) args[2] = { ...patch, contentHeadId };
					}
					if (old && table === "files_move_cohort_content" && property === "delete") {
						const content = old as Doc<"files_move_cohort_content">;
						const node = await raw.get("files_nodes", content.nodeId);
						// Old exact text can retire, but a later source may still use its live Yjs log.
						for (const headId of new Set([content.beforeHeadId, content.afterHeadId]))
							if (headId && headId !== node?.contentHeadId)
								await ctx.scheduler.runAfter(0, internal.files_content_saves.retire, { headId });
					}
					await write();
					// Location and text edits keep the owner assigned above. Do not read each chunk twice.
					if (
						CONTENT_TABLES.has(table) && property === "patch" &&
						!["fileNodeId", "sourceKind", "fieldPath"].some((key) => key in patch!)
					) return;
					if (property === "delete") {
						if (table === "files_nodes") {
							// Old and candidate heads belong to the existing paged cohort cleanup.
							const node = old as Doc<"files_nodes"> | null;
							if (node?.contentHeadId && await raw.get("files_saved_content_heads", node.contentHeadId))
								await raw.delete("files_saved_content_heads", node.contentHeadId);
							if (node && await raw.query("files_index_states").withIndex("by_fileNode", (q) => q.eq("fileNodeId", node._id)).first())
								await ctx.scheduler.runAfter(0, internal.files_index.start, { nodeId: node._id });
						} else if (old && "fileNodeId" in old) dirty.add(old.fileNodeId as Id<"files_nodes">);
						return;
					}
					await sync_doc(table, id);
					if (patch) await sync_write(table, id, patch);
				};
			const value: unknown = Reflect.get(target, property);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});

	async function sync_head(old: Head, next: Partial<WithoutSystemFields<Head>>) {
		if ("yjsLastSequenceId" in next && !old.yjsContentHeadId)
			next.yjsContentHeadId = next.yjsLastSequenceId ? old._id : null;
		if (Object.entries(next).some(([key, value]) => JSON.stringify(old[key as keyof Head]) !== JSON.stringify(value)))
			await raw.patch("files_saved_content_heads", old._id, next);
	}

	const runMutation: MutationCtx["runMutation"] = async (mutation, ...args) => {
		// A child has its own wrapper and can change any saved content selection.
		forget_reads();
		try {
			return await ctx.runMutation(mutation, ...args);
		} finally {
			forget_reads();
		}
	};
	const writes = {
		db,
		runMutation,
		pin(head: Head) { pinned.set(head._id, head); },
		stageInsert(value: Fields, head: Head) { if (!head.ready && !head.retired) stagedInserts.add(value); },
		isStagedInsert(value: Fields) { return stagedInserts.has(value); },
		async flush() {
			for (const nodeId of dirty) {
				const node = await raw.get("files_nodes", nodeId);
				if (!node || node.kind !== "file") continue;
				const currentId = await ensure_node(nodeId);
				if (!currentId) continue;
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
				const cohort = (await raw.get("files_move_cohorts", node.moveCohortId))!;
				const candidate = heads.after !== heads.before ? await raw.get("files_saved_content_heads", heads.after) : null;
				// A published head owns later edits. Its copied place must never overwrite them.
				if (
					candidate &&
					cohort.publishedAt === null &&
					content.phaseCursor !== "abort:done" &&
					after
				) {
					const { lastSequenceId: _id, ...sequence } = content.afterSequence ?? { lastSequenceId: null };
					await sync_head(candidate, {
						...(await values(after, content.afterSequence ? (sequence as NonNullable<Head["sequence"]>) : null)),
						ready: content.sealed,
						retired: false,
					});
				}
			}
			dirty.clear();
		},
	};
	return writes;
}
