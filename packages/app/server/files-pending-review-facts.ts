import type { Doc, Id } from "../convex/_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "../convex/_generated/server.js";
import { files_derive_tree_path_for_file_node, type files_PendingParent } from "../shared/files.ts";
import { should_never_happen } from "../shared/shared-utils.ts";
import {
	files_saved_placement_db_get_node,
	files_saved_placement_db_get_proposal,
	files_saved_placement_db_get_publish_receipt,
	type files_saved_placement_FixedView,
} from "./files-saved-placement.ts";

type Scope = Pick<Doc<"files_pending_updates">, "organizationId" | "workspaceId" | "userId">;

export async function files_pending_review_facts_db_get_state(
	db: QueryCtx["db"],
	scope: Pick<Scope, "organizationId" | "workspaceId">,
) {
	return await db
		.query("files_pending_review_fact_state")
		.withIndex("by_workspace", (q) => q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId))
		.unique();
}

export async function files_pending_review_facts_db_change_state(
	db: MutationCtx["db"],
	scope: Pick<Scope, "organizationId" | "workspaceId">,
	change: { structural?: boolean; jobs?: number },
) {
	const state = await files_pending_review_facts_db_get_state(db, scope);
	const pendingJobCount = (state?.pendingJobCount ?? 0) + (change.jobs ?? 0);
	if (pendingJobCount < 0) throw should_never_happen("Review facts job count is negative", { ...scope, change });
	const fields = {
		structureRevision: (state?.structureRevision ?? 0) + (change.structural ? 1 : 0),
		pendingJobCount,
	};
	if (state) await db.patch("files_pending_review_fact_state", state._id, fields);
	else await db.insert("files_pending_review_fact_state", { ...scope, ...fields });
	return fields;
}

/**
 * Source context uses private ancestry and saved placement, never another pending move.
 */
async function parent_path(
	db: QueryCtx["db"],
	scope: Scope,
	parent: files_PendingParent,
	fixedView?: files_saved_placement_FixedView,
): Promise<string | null> {
	const names: string[] = [];
	while (parent.kind === "private") {
		const node = await db.get("files_pending_nodes", parent.id);
		if (
			!node ||
			node.userId !== scope.userId ||
			node.organizationId !== scope.organizationId ||
			node.workspaceId !== scope.workspaceId ||
			node.state === "discarded"
		)
			return null;
		const receipt = await files_saved_placement_db_get_publish_receipt(
			db,
			{ ...scope, privateNodeId: node._id },
			fixedView,
		);
		if (receipt) {
			parent = { kind: "saved", id: receipt.savedNodeId };
			break;
		}
		if (node.state !== "active") return null;
		names.push(node.name);
		parent = node.parent;
	}
	let path = "";
	if (parent.kind === "saved") {
		const node = await files_saved_placement_db_get_node(db, parent.id, fixedView);
		if (
			!node ||
			node.organizationId !== scope.organizationId ||
			node.workspaceId !== scope.workspaceId ||
			node.kind !== "folder" ||
			node.archiveOperationId !== null
		)
			return null;
		path = node.path;
	}
	return [path, ...names.toReversed()].join("/") || "/";
}

/**
 * Sync one exact proposal, including content-only and unresolved proposals.
 */
export async function files_pending_review_facts_db_sync(
	db: MutationCtx["db"],
	args: {
		pendingUpdateId: Id<"files_pending_updates">;
		fixedView?: files_saved_placement_FixedView;
		source?: {
			proposal: Doc<"files_pending_updates"> | null;
			savedNode: Doc<"files_nodes"> | null;
			structureRevision: number;
		};
	},
) {
	const cohortId = args.fixedView?.cohortId ?? null;
	const view = args.fixedView?.view ?? "normal";
	const stored = await db
		.query("files_pending_review_facts")
		.withIndex("by_proposal_view", (q) =>
			q.eq("pendingUpdateId", args.pendingUpdateId).eq("cohortId", cohortId).eq("view", view),
		)
		.unique();
	const proposal = args.source
		? args.source.proposal
		: await files_saved_placement_db_get_proposal(db, args.pendingUpdateId, args.fixedView);
	if (!proposal) {
		if (stored) await db.delete("files_pending_review_facts", stored._id);
		return;
	}
	const scope = { organizationId: proposal.organizationId, workspaceId: proposal.workspaceId, userId: proposal.userId };
	let sourcePath: string | null = null;
	let destinationPath: string | null = null;
	let kind: "folder" | "file" | null = null;
	if (proposal.target.kind === "saved") {
		const node = args.source
			? args.source.savedNode
			: await files_saved_placement_db_get_node(db, proposal.target.id, args.fixedView);
		if (
			node &&
			node.organizationId === scope.organizationId &&
			node.workspaceId === scope.workspaceId &&
			node.archiveOperationId === null
		) {
			sourcePath = node.path;
			kind = node.kind;
		}
	} else {
		const node = await db.get("files_pending_nodes", proposal.target.id);
		if (
			node &&
			node.userId === scope.userId &&
			node.organizationId === scope.organizationId &&
			node.workspaceId === scope.workspaceId &&
			node.state === "active"
		) {
			const path = await parent_path(db, scope, node.parent, args.fixedView);
			if (path !== null) sourcePath = `${path === "/" ? "" : path}/${node.name}`;
			destinationPath = sourcePath;
			kind = node.kind;
		}
	}
	if (proposal.pendingMove) {
		const path = await parent_path(db, scope, proposal.pendingMove.destParent, args.fixedView);
		destinationPath = path === null ? null : `${path === "/" ? "" : path}/${proposal.pendingMove.destName}`;
	}
	const structureRevision =
		args.source?.structureRevision ??
		(await files_pending_review_facts_db_get_state(db, scope))?.structureRevision ??
		0;
	const fields: Omit<Doc<"files_pending_review_facts">, "_id" | "_creationTime"> = {
		...scope,
		pendingUpdateId: proposal._id,
		proposalRevision: proposal.revision,
		target: proposal.target,
		cohortId,
		view,
		sourcePath,
		sourceTreePath: sourcePath !== null && kind ? files_derive_tree_path_for_file_node(sourcePath, kind) : null,
		destinationPath,
		destinationTreePath:
			destinationPath !== null && kind ? files_derive_tree_path_for_file_node(destinationPath, kind) : null,
		structuralKind: proposal.pendingArchive
			? ("archive" as const)
			: proposal.pendingMove
				? ("move" as const)
				: ("none" as const),
		sourcePlacementRevision: structureRevision,
	};
	if (stored) await db.replace("files_pending_review_facts", stored._id, fields);
	else await db.insert("files_pending_review_facts", fields);
}
