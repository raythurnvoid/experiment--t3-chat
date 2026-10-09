import { compareValues, type Value } from "convex/values";
import type { Doc, Id } from "../convex/_generated/dataModel.js";
import type { QueryCtx } from "../convex/_generated/server.js";
import { should_never_happen } from "../shared/shared-utils.ts";
import {
	files_saved_placement_db_get_node_view,
	type files_saved_placement_FixedView,
} from "./files-saved-placement.ts";

type Scope = Pick<Doc<"files_nodes">, "organizationId" | "workspaceId">;
type Source =
	| { nodeId: Id<"files_nodes">; pendingUpdateId?: never }
	| { pendingUpdateId: Id<"files_pending_updates">; nodeId?: never };

export async function files_saved_content_db_get_tags(
	db: QueryCtx["db"],
	args: Source & { fixedView?: files_saved_placement_FixedView },
) {
	let tag: files_saved_placement_FixedView | undefined;
	if (args.nodeId !== undefined) tag = await files_saved_placement_db_get_node_view(db, args.nodeId, args.fixedView);
	else {
		const proposal = await db.get("files_pending_updates", args.pendingUpdateId);
		// Unselected proposals keep their header while their scope docs move.
		const reservation =
			proposal && !proposal.moveCohortId
				? await db
						.query("files_move_source_reservations")
						.withIndex("by_source", (q) => q.eq("source.kind", "proposal").eq("source.id", proposal._id))
						.unique()
				: null;
		const cohortId = proposal?.moveCohortId ?? reservation?.cohortId;
		if (proposal && cohortId) {
			const cohort = await db.get("files_move_cohorts", cohortId);
			if (
				!cohort ||
				cohort.organizationId !== proposal.organizationId ||
				cohort.workspaceId !== proposal.workspaceId ||
				(args.fixedView && args.fixedView.cohortId !== cohort._id)
			)
				throw should_never_happen("Pending content cohort is missing or changed", {
					pendingUpdateId: args.pendingUpdateId,
				});
			tag = { cohortId: cohort._id, view: args.fixedView?.view ?? cohort.visibleView };
		}
	}
	return tag ? [undefined, tag] : [undefined];
}

function compare_keys(left: Array<Value | undefined>, right: Array<Value | undefined>) {
	for (let index = 0; index < left.length; index++) {
		const compared = compareValues(left[index], right[index]);
		if (compared !== 0) return compared;
	}
	return 0;
}

/**
 * Before reads merge original normal/before docs. After reads merge promoted normal/after docs.
 * The switch must wait for every original doc to leave normal and every after doc to seal.
 * Both ranges belong to one file or proposal. Selected docs win a duplicate stable key.
 */
async function* merge<T>(
	sources: AsyncIterable<T>[],
	key: (doc: T) => Array<Value | undefined>,
	order: "asc" | "desc",
) {
	const iterators = sources.map((source) => source[Symbol.asyncIterator]());
	const heads = await Promise.all(iterators.map((iterator) => iterator.next()));
	try {
		while (heads.some((head) => !head.done)) {
			let winner = -1;
			for (let index = 0; index < heads.length; index++) {
				const head = heads[index]!;
				if (head.done) continue;
				if (winner < 0 || compare_keys(key(head.value), key(heads[winner]!.value!)) * (order === "asc" ? 1 : -1) <= 0)
					winner = index;
			}
			const doc = heads[winner]!.value!;
			const duplicateIndexes = heads.flatMap((head, index) =>
				!head.done && compare_keys(key(head.value), key(doc)) === 0 ? [index] : [],
			);
			yield doc;
			await Promise.all(
				duplicateIndexes.map(async (index) => {
					heads[index] = await iterators[index]!.next();
				}),
			);
		}
	} finally {
		await Promise.all(
			iterators.map(async (iterator) => {
				await iterator.return?.();
			}),
		);
	}
}

/**
 * Collect one write-bounded file or proposal. Workspace lists must use native pagination.
 */
export async function files_saved_content_collect<T>(source: AsyncIterable<T>) {
	const docs: T[] = [];
	for await (const doc of source) docs.push(doc);
	return docs;
}

export async function* files_saved_content_db_text_chunks(
	db: QueryCtx["db"],
	args: Scope &
		Source & {
			fixedView?: files_saved_placement_FixedView;
			order?: "asc" | "desc";
			startLine?: number;
			startIndex?: number;
			yjsSequence?: number;
			proposalRevision?: number;
		},
): AsyncGenerator<Doc<"files_text_chunks">> {
	const order = args.order ?? "asc";
	const tags = await files_saved_content_db_get_tags(db, args);
	const sources = tags.map((tag) => {
		const chunks = args.pendingUpdateId
			? args.startLine !== undefined
				? db
						.query("files_text_chunks")
						.withIndex("by_pendingUpdate_lineEnd_chunkIndex", (q) =>
							q
								.eq("pendingUpdateId", args.pendingUpdateId)
								.eq("moveView.cohortId", tag?.cohortId)
								.eq("moveView.view", tag?.view)
								.gte("lineEnd", args.startLine!),
						)
				: args.startIndex !== undefined
					? db
							.query("files_text_chunks")
							.withIndex("by_pendingUpdate_endIndex_chunkIndex", (q) =>
								q
									.eq("pendingUpdateId", args.pendingUpdateId)
									.eq("moveView.cohortId", tag?.cohortId)
									.eq("moveView.view", tag?.view)
									.gte("endIndex", args.startIndex!),
							)
					: db
							.query("files_text_chunks")
							.withIndex("by_pendingUpdate_chunkIndex", (q) =>
								q
									.eq("pendingUpdateId", args.pendingUpdateId)
									.eq("moveView.cohortId", tag?.cohortId)
									.eq("moveView.view", tag?.view),
							)
			: args.startLine !== undefined
				? db
						.query("files_text_chunks")
						.withIndex("by_organization_workspace_source_fileNode_lineEnd_chunk", (q) =>
							q
								.eq("organizationId", args.organizationId)
								.eq("workspaceId", args.workspaceId)
								.eq("sourceKind", "committed")
								.eq("fileNodeId", args.nodeId)
								.eq("moveView.cohortId", tag?.cohortId)
								.eq("moveView.view", tag?.view)
								.gte("lineEnd", args.startLine!),
						)
				: args.startIndex !== undefined
					? db
							.query("files_text_chunks")
							.withIndex("by_organization_workspace_source_fileNode_endIndex_chunk", (q) =>
								q
									.eq("organizationId", args.organizationId)
									.eq("workspaceId", args.workspaceId)
									.eq("sourceKind", "committed")
									.eq("fileNodeId", args.nodeId)
									.eq("moveView.cohortId", tag?.cohortId)
									.eq("moveView.view", tag?.view)
									.gte("endIndex", args.startIndex!),
							)
					: db.query("files_text_chunks").withIndex("by_organization_workspace_source_fileNode_yjsSeq_chunk", (q) => {
							const source = q
								.eq("organizationId", args.organizationId)
								.eq("workspaceId", args.workspaceId)
								.eq("sourceKind", "committed")
								.eq("fileNodeId", args.nodeId)
								.eq("moveView.cohortId", tag?.cohortId)
								.eq("moveView.view", tag?.view);
							return args.yjsSequence === undefined ? source : source.eq("yjsSequence", args.yjsSequence);
						});
		// One proposal's text is bounded on write. Keep its existing revision check.
		return (
			args.proposalRevision === undefined
				? chunks
				: chunks.filter((q) => q.eq(q.field("proposalRevision"), args.proposalRevision))
		).order(order);
	});
	yield* merge(
		sources,
		(doc) =>
			args.startLine !== undefined
				? [doc.lineEnd, doc.chunkIndex]
				: args.startIndex !== undefined
					? [doc.endIndex, doc.chunkIndex]
					: doc.sourceKind === "pending"
						? [doc.chunkIndex]
						: [doc.yjsSequence, doc.chunkIndex],
		order,
	);
}

export async function* files_saved_content_db_plain_text_chunks(
	db: QueryCtx["db"],
	args: Scope & Source & { fixedView?: files_saved_placement_FixedView },
): AsyncGenerator<Doc<"files_plain_text_chunks">> {
	const tags = await files_saved_content_db_get_tags(db, args);
	const sources = tags.map((tag) =>
		args.pendingUpdateId
			? db
					.query("files_plain_text_chunks")
					.withIndex("by_pendingUpdate_chunkIndex", (q) =>
						q
							.eq("pendingUpdateId", args.pendingUpdateId)
							.eq("moveView.cohortId", tag?.cohortId)
							.eq("moveView.view", tag?.view),
					)
			: db
					.query("files_plain_text_chunks")
					.withIndex("by_organization_workspace_source_fileNode_yjsSequence_chunkIndex", (q) =>
						q
							.eq("organizationId", args.organizationId)
							.eq("workspaceId", args.workspaceId)
							.eq("sourceKind", "committed")
							.eq("fileNodeId", args.nodeId)
							.eq("moveView.cohortId", tag?.cohortId)
							.eq("moveView.view", tag?.view),
					),
	);
	yield* merge(
		sources,
		(doc) => (doc.sourceKind === "pending" ? [doc.chunkIndex] : [doc.yjsSequence, doc.chunkIndex]),
		"asc",
	);
}

export async function* files_saved_content_db_yjs_updates(
	db: QueryCtx["db"],
	args: Scope & {
		nodeId: Id<"files_nodes">;
		fixedView?: files_saved_placement_FixedView;
		order?: "asc" | "desc";
		afterSequence?: number;
		throughSequence?: number;
	},
): AsyncGenerator<Doc<"files_yjs_updates">> {
	const organizationId = db.normalizeId("organizations", args.organizationId);
	const workspaceId = db.normalizeId("organizations_workspaces", args.workspaceId);
	if (!organizationId || !workspaceId) return;
	const order = args.order ?? "asc";
	const tags = await files_saved_content_db_get_tags(db, args);
	const sources = tags.map((tag) =>
		db
			.query("files_yjs_updates")
			.withIndex("by_organization_workspace_fileNode_sequence", (q) => {
				const source = q
					.eq("organizationId", organizationId)
					.eq("workspaceId", workspaceId)
					.eq("fileNodeId", args.nodeId)
					.eq("moveView.cohortId", tag?.cohortId)
					.eq("moveView.view", tag?.view);
				const after = args.afterSequence === undefined ? source : source.gt("sequence", args.afterSequence);
				return args.throughSequence === undefined ? after : after.lte("sequence", args.throughSequence);
			})
			.order(order),
	);
	yield* merge(sources, (doc) => [doc.sequence], order);
}
