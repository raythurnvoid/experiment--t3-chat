// Leaf saved-view reads. These helpers choose a placement; callers still check current access.

import type { Doc, Id } from "../convex/_generated/dataModel.js";
import type { QueryCtx } from "../convex/_generated/server.js";
import { should_never_happen } from "../shared/shared-utils.ts";

export type files_saved_placement_FixedView = {
	cohortId: Id<"files_move_cohorts">;
	view: "before" | "after";
};

async function get_cohort(
	db: QueryCtx["db"],
	cohortId: Id<"files_move_cohorts">,
	fixedView?: files_saved_placement_FixedView,
) {
	if (fixedView && fixedView.cohortId !== cohortId)
		throw should_never_happen("Saved placement belongs to another cohort", { cohortId, fixedView });
	const cohort = await db.get("files_move_cohorts", cohortId);
	if (!cohort) throw should_never_happen("Saved placement cohort is missing", { cohortId });
	return { cohort, view: fixedView?.view ?? cohort.visibleView };
}

/**
 * Read the workspace's one current saved view. A read never creates a slot.
 */
export async function files_saved_placement_db_get_view(
	db: QueryCtx["db"],
	args: Pick<Doc<"files_nodes">, "organizationId" | "workspaceId">,
) {
	const organizationId = db.normalizeId("organizations", args.organizationId);
	const workspaceId = db.normalizeId("organizations_workspaces", args.workspaceId);
	if (!organizationId || !workspaceId) return {
		cohortId: null, view: null, generation: 0, searchGeneration: 0, migrationDirection: null,
	};
	const slot = await db
		.query("files_move_workspace_slots")
		.withIndex("by_workspace", (q) => q.eq("organizationId", organizationId).eq("workspaceId", workspaceId))
		.unique();
	if (!slot?.cohortId)
		return {
			cohortId: null,
			view: null,
			generation: slot?.generation ?? 0,
			searchGeneration: slot?.searchGeneration ?? 0,
			migrationDirection: null,
		};
	const { cohort } = await get_cohort(db, slot.cohortId);
	if (
		cohort.organizationId !== args.organizationId ||
		cohort.workspaceId !== args.workspaceId ||
		cohort.slotGeneration !== slot.generation
	)
		throw should_never_happen("Workspace saved-view slot does not match its cohort", {
			slotId: slot._id,
			cohortId: cohort._id,
		});
	return {
		cohortId: cohort._id,
		view: cohort.visibleView,
		generation: slot.generation,
		searchGeneration: slot.searchGeneration,
		migrationDirection: cohort.phase === "published" || cohort.phase === "finishing" ||
			cohort.phase === "aborting" || cohort.phase === "complete" ? "to_normal" as const : "to_cohort" as const,
	};
}

export type files_saved_placement_View = Awaited<ReturnType<typeof files_saved_placement_db_get_view>>;

/**
 * A saved file's side docs use its selected view. Unreserved files use normal docs.
 */
export async function files_saved_placement_db_get_node_view(
	db: QueryCtx["db"],
	nodeId: Id<"files_nodes">,
	fixedView?: files_saved_placement_FixedView,
) {
	const node = await db.get("files_nodes", nodeId);
	if (!node?.moveCohortId) return undefined;
	const { cohort, view } = await get_cohort(db, node.moveCohortId, fixedView);
	return { cohortId: cohort._id, view };
}

function apply_place(node: Doc<"files_nodes">, place: Doc<"files_saved_places">): Doc<"files_nodes"> {
	// Explicit optional fields also clear ancestors that only exist in the other view.
	return {
		...node,
		parentId: place.parentId,
		kind: place.kind,
		name: place.name,
		sortName: place.sortName,
		path: place.path,
		treePath: place.treePath,
		pathDepth: place.pathDepth,
		lowercaseExtension: place.lowercaseExtension,
		archiveOperationId: place.archiveOperationId,
		restrictedScopeNodeId: place.restrictedScopeNodeId,
		isRestrictedScopeRoot: place.isRestrictedScopeRoot,
		updatedAt: place.updatedAt,
		updatedBy: place.updatedBy,
		ancestor1: place.ancestor1,
		ancestor2: place.ancestor2,
		ancestor3: place.ancestor3,
		ancestor4: place.ancestor4,
		ancestor5: place.ancestor5,
		ancestor6: place.ancestor6,
		ancestor7: place.ancestor7,
		ancestor8: place.ancestor8,
		ancestor9: place.ancestor9,
		ancestor10: place.ancestor10,
		ancestor11: place.ancestor11,
		ancestor12: place.ancestor12,
		contentType: place.contentType,
		assetId: place.assetId,
		contentByteSize: place.contentByteSize,
		textKind: place.textKind,
		collaborationEnabled: place.collaborationEnabled,
		yjsSnapshotId: place.yjsSnapshotId,
		yjsLastSequenceId: place.yjsLastSequenceId,
		statsId: place.statsId,
		contentTooLargeByteSize: place.contentTooLargeByteSize,
		contentShapeMismatchAt: place.contentShapeMismatchAt,
		contentYjsStateTooLargeByteSize: place.contentYjsStateTooLargeByteSize,
		contentFrontmatterTooLargeFieldCount: place.contentFrontmatterTooLargeFieldCount,
		contentFrontmatterTooLargeIndexDocumentCount: place.contentFrontmatterTooLargeIndexDocumentCount,
		publishedFromPrivateNodeId: place.publishedFromPrivateNodeId,
	};
}

/**
 * Keep the saved identity and creation time while choosing its before or after header.
 */
export async function files_saved_placement_db_get_node(
	db: QueryCtx["db"],
	nodeId: Id<"files_nodes">,
	fixedView?: files_saved_placement_FixedView,
): Promise<Doc<"files_nodes"> | null> {
	const node = await db.get("files_nodes", nodeId);
	if (!node?.moveCohortId) return node;
	const { cohort, view } = await get_cohort(db, node.moveCohortId, fixedView);
	if (cohort.organizationId !== node.organizationId || cohort.workspaceId !== node.workspaceId)
		throw should_never_happen("Saved placement has another workspace", { nodeId, cohortId: cohort._id });
	const place = await db
		.query("files_saved_places")
		.withIndex("by_cohort_view_node", (q) => q.eq("cohortId", cohort._id).eq("view", view).eq("nodeId", nodeId))
		.unique();
	if (!place) {
		const record = await db
			.query("files_move_cohort_nodes")
			.withIndex("by_cohort_node", (q) => q.eq("cohortId", cohort._id).eq("nodeId", nodeId))
			.unique();
		if (view === "before" && (record?.role === "allocated" || record?.role === "derived") && record.beforePlaceId === null) return null;
		throw should_never_happen("Saved placement candidate is missing", { nodeId, cohortId: cohort._id, view });
	}
	if (
		place.organizationId !== node.organizationId ||
		place.workspaceId !== node.workspaceId ||
		place.nodeCreationTime !== node._creationTime
	)
		throw should_never_happen("Saved placement candidate does not match its node", { nodeId, placeId: place._id });
	return apply_place(node, place);
}

/**
 * A claimed empty slot stays empty. It never falls through to the physical node index.
 */
export async function files_saved_placement_db_get_slot(
	db: QueryCtx["db"],
	args: Pick<Doc<"files_nodes">, "organizationId" | "workspaceId" | "parentId" | "name">,
	fixedView?: files_saved_placement_FixedView,
	currentView?: files_saved_placement_View,
): Promise<Doc<"files_nodes"> | null> {
	const organizationId = db.normalizeId("organizations", args.organizationId);
	const workspaceId = db.normalizeId("organizations_workspaces", args.workspaceId);
	const current = fixedView ? null : currentView ?? (
		organizationId && workspaceId ? await files_saved_placement_db_get_view(db, { organizationId, workspaceId }) : null);
	const selected =
		fixedView ?? (current?.cohortId && current.view ? { cohortId: current.cohortId, view: current.view } : undefined);
	if (organizationId && workspaceId && selected) {
		const claim = await db
			.query("files_move_slot_claims")
			.withIndex("by_workspace_slot", (q) =>
				q
					.eq("organizationId", organizationId)
					.eq("workspaceId", workspaceId)
					.eq("parentId", args.parentId)
					.eq("name", args.name),
			)
			.unique();
		if (claim) {
			if (claim.cohortId !== selected.cohortId)
				throw should_never_happen("Saved slot belongs to another cohort", { claimId: claim._id, selected });
			const nodeId = selected.view === "before" ? claim.beforeNodeId : claim.afterNodeId;
			if (!nodeId) return null;
			const node = await files_saved_placement_db_get_node(db, nodeId, selected);
			if (
				!node ||
				node.organizationId !== args.organizationId ||
				node.workspaceId !== args.workspaceId ||
				node.parentId !== args.parentId ||
				node.name !== args.name ||
				node.archiveOperationId !== null
			)
				throw should_never_happen("Saved slot owner does not match its claim", { claimId: claim._id, nodeId });
			return node;
		}
	}
	const node = await db
		.query("files_nodes")
		.withIndex("by_organization_workspace_parent_name_archiveOperation", (q) =>
			q
				.eq("organizationId", args.organizationId)
				.eq("workspaceId", args.workspaceId).eq("moveCohortId", undefined)
				.eq("parentId", args.parentId)
				.eq("name", args.name)
				.eq("archiveOperationId", null),
		)
		.unique();
	if (node?.moveCohortId) throw should_never_happen("Reserved saved slot has no claim", { nodeId: node._id });
	return node;
}

/**
 * The caller uses this only for a canonical path in a fixed active workspace view.
 */
export async function files_saved_placement_db_get_path(
	db: QueryCtx["db"],
	args: Pick<Doc<"files_nodes">, "organizationId" | "workspaceId" | "path">,
	fixedView: files_saved_placement_FixedView,
) {
	if (args.path === "/") return null;
	const names = args.path.slice(1).split("/");
	let parentId: Doc<"files_nodes">["parentId"] = "root";
	let node: Doc<"files_nodes"> | null = null;
	for (let index = 0; index < names.length; index++) {
		node = await files_saved_placement_db_get_slot(db, { ...args, parentId, name: names[index]! }, fixedView);
		if (!node || (index < names.length - 1 && node.kind !== "folder")) return null;
		parentId = node._id;
	}
	return node;
}

/**
 * A partially accepted proposal gets a whole after header, not a patch over old intent.
 */
export async function files_saved_placement_db_get_proposal(
	db: QueryCtx["db"],
	pendingUpdateId: Id<"files_pending_updates">,
	fixedView?: files_saved_placement_FixedView,
): Promise<Doc<"files_pending_updates"> | null> {
	const proposal = await db.get("files_pending_updates", pendingUpdateId);
	if (!proposal?.moveCohortId) return proposal;
	const { cohort, view } = await get_cohort(db, proposal.moveCohortId, fixedView);
	const item = await db
		.query("files_move_cohort_items")
		.withIndex("by_cohort_proposal", (q) => q.eq("cohortId", cohort._id).eq("pendingUpdateId", pendingUpdateId))
		.unique();
	if (
		!item ||
		cohort.organizationId !== proposal.organizationId ||
		cohort.workspaceId !== proposal.workspaceId ||
		cohort.userId !== proposal.userId ||
		item.target.kind !== proposal.target.kind ||
		item.target.id !== proposal.target.id
	)
		throw should_never_happen("Saved proposal reservation does not match its input", {
			pendingUpdateId,
			cohortId: cohort._id,
		});
	if (view === "before") return proposal;
	if (!item.afterProposal) return null;
	const after = item.afterProposal;
	const savedOutput = proposal.target.kind === "private" && after.target.kind === "saved"
		? await db.get("files_move_cohort_nodes", item.nodeRecordId)
		: null;
	const sameTarget = after.target.kind === proposal.target.kind && after.target.id === proposal.target.id;
	const publishedTarget = savedOutput?.cohortId === cohort._id && savedOutput.role === "allocated"
		&& savedOutput.itemId === item._id && savedOutput.nodeId === after.target.id;
	if (
		after.organizationId !== proposal.organizationId ||
		after.workspaceId !== proposal.workspaceId ||
		after.userId !== proposal.userId ||
		(!sameTarget && !publishedTarget)
	)
		throw should_never_happen("Saved after proposal changes its owner or target", {
			pendingUpdateId,
			itemId: item._id,
		});
	return { ...after, _id: proposal._id, _creationTime: proposal._creationTime, moveCohortId: proposal.moveCohortId };
}

async function select_receipt(
	db: QueryCtx["db"],
	receipt: Doc<"files_pending_node_publish_receipts"> | null,
	args: { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces">; userId: Id<"users"> },
	fixedView?: files_saved_placement_FixedView,
) {
	if (
		!receipt ||
		receipt.organizationId !== args.organizationId ||
		receipt.workspaceId !== args.workspaceId ||
		receipt.userId !== args.userId
	)
		return null;
	if (receipt.moveView) {
		const { cohort, view } = await get_cohort(db, receipt.moveView.cohortId, fixedView);
		if (
			cohort.organizationId !== args.organizationId ||
			cohort.workspaceId !== args.workspaceId ||
			receipt.moveView.view !== view
		)
			return null;
	}
	const node = await db.get("files_pending_nodes", receipt.privateNodeId);
	if (
		!node ||
		node.organizationId !== args.organizationId ||
		node.workspaceId !== args.workspaceId ||
		node.userId !== args.userId ||
		node.state === "discarded"
	)
		return null;
	const generation = node.state === "published" ? receipt.creationGeneration + 1 : receipt.creationGeneration;
	if (generation !== node.creationGeneration || receipt.structuralRevision !== node.structuralRevision) return null;
	return receipt;
}

/**
 * Receipts are owner-scoped links. They grant no saved-node access.
 */
export async function files_saved_placement_db_get_publish_receipt(
	db: QueryCtx["db"],
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
		privateNodeId: Id<"files_pending_nodes">;
	},
	fixedView?: files_saved_placement_FixedView,
	currentView?: files_saved_placement_View,
) {
	const current = fixedView ? null : currentView ?? await files_saved_placement_db_get_view(db, args);
	const selected = fixedView ?? (current?.cohortId && current.view ? { cohortId: current.cohortId, view: current.view } : undefined);
	const normal = await db
		.query("files_pending_node_publish_receipts")
		.withIndex("by_privateNode", (q) => q.eq("privateNodeId", args.privateNodeId).eq("moveView.cohortId", undefined).eq("moveView.view", undefined))
		.unique();
	const receipt = normal ?? (selected ? await db
		.query("files_pending_node_publish_receipts")
		.withIndex("by_privateNode", (q) => q.eq("privateNodeId", args.privateNodeId).eq("moveView.cohortId", selected.cohortId).eq("moveView.view", selected.view))
		.unique() : null);
	return await select_receipt(db, receipt, args, fixedView);
}

export async function files_saved_placement_db_get_publish_receipt_by_saved_node(
	db: QueryCtx["db"],
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
		savedNodeId: Id<"files_nodes">;
	},
	fixedView?: files_saved_placement_FixedView,
	currentView?: files_saved_placement_View,
) {
	const current = fixedView ? null : currentView ?? await files_saved_placement_db_get_view(db, args);
	const selected = fixedView ?? (current?.cohortId && current.view ? { cohortId: current.cohortId, view: current.view } : undefined);
	const normal = await db
		.query("files_pending_node_publish_receipts")
		.withIndex("by_savedNode", (q) => q.eq("savedNodeId", args.savedNodeId).eq("moveView.cohortId", undefined).eq("moveView.view", undefined))
		.unique();
	const receipt = normal ?? (selected ? await db
		.query("files_pending_node_publish_receipts")
		.withIndex("by_savedNode", (q) => q.eq("savedNodeId", args.savedNodeId).eq("moveView.cohortId", selected.cohortId).eq("moveView.view", selected.view))
		.unique() : null);
	return await select_receipt(db, receipt, args, fixedView);
}

/**
 * Follow a private link through the selected receipt, then through its permanent saved origin.
 */
export async function files_saved_placement_db_resolve_read_target(
	db: QueryCtx["db"],
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		target: Doc<"files_pending_updates">["target"];
	},
	fixedView?: files_saved_placement_FixedView,
) {
	if (args.target.kind === "saved") return args.target;
	const privateNodeId = args.target.id;
	const privateNode = await db.get("files_pending_nodes", privateNodeId);
	// Published private links may be embedded in a file another member can read.
	const receipt = privateNode && privateNode.organizationId === args.organizationId && privateNode.workspaceId === args.workspaceId
		? await files_saved_placement_db_get_publish_receipt(db, { ...args, userId: privateNode.userId, privateNodeId }, fixedView)
		: null;
	const source = receipt
		? await files_saved_placement_db_get_node(db, receipt.savedNodeId, fixedView)
		: await db
				.query("files_nodes")
				.withIndex("by_organization_workspace_publishedFromPrivateNode", (q) =>
					q
						.eq("organizationId", args.organizationId)
						.eq("workspaceId", args.workspaceId)
						.eq("publishedFromPrivateNodeId", privateNodeId),
				)
				.unique();
	const saved = source && (await files_saved_placement_db_get_node(db, source._id, fixedView));
	if (saved) return saved.archiveOperationId === null ? { kind: "saved" as const, id: saved._id } : null;
	return args.target;
}

/**
 * Read the selected sequence head without loading the growing Yjs update log.
 */
export async function files_saved_placement_db_get_sequence(
	db: QueryCtx["db"],
	node: Doc<"files_nodes">,
	fixedView?: files_saved_placement_FixedView,
) {
	if (!node.yjsLastSequenceId) return null;
	const sequence = await db.get("files_yjs_docs_last_sequences", node.yjsLastSequenceId);
	if (
		!sequence ||
		sequence.organizationId !== node.organizationId ||
		sequence.workspaceId !== node.workspaceId ||
		sequence.fileNodeId !== node._id
	)
		throw should_never_happen("Saved sequence does not match its node", {
			nodeId: node._id,
			sequenceId: node.yjsLastSequenceId,
		});
	if (!node.moveCohortId) return sequence;
	const { cohort, view } = await get_cohort(db, node.moveCohortId, fixedView);
	if (view === "before") return sequence;
	const content = await db
		.query("files_move_cohort_content")
		.withIndex("by_cohort_node", (q) => q.eq("cohortId", cohort._id).eq("nodeId", node._id))
		.unique();
	if (!content) return sequence;
	if (!content.sealed || !content.afterSequence || content.afterSequence.lastSequenceId !== sequence._id)
		throw should_never_happen("Saved content sequence is not sealed", { contentId: content._id, nodeId: node._id });
	const { lastSequenceId: _lastSequenceId, ...after } = content.afterSequence;
	return { ...sequence, ...after };
}
