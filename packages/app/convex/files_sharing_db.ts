// The database writes behind sharing: a node's own restricted root, its "Add people" root, and its public
// flag. The sharing doors in files_sharing.ts and files_share_links.ts, the public API, the plugin doors
// and the subtree jobs call these.
//
// Keep the imports of this module small. On a cold call Convex loads every file that this module imports,
// even the unused ones. The sharing doors import this module, so it must not import files_nodes.ts,
// files_share_links.ts or files_subtree_ops.ts.

import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { files_metadata_db_patch_file_scope } from "./files_metadata_db.ts";
import { files_share_links_db_delete_for_node, files_share_links_db_delete_for_scope } from "./files_share_links_db.ts";
import { files_subtree_ops_busy_tree_paths } from "./files_subtree_ops_db.ts";
import { files_updated_by_db_sync_node } from "./files_updated_by.ts";
import { Result } from "common/errors-as-values-utils.ts";
import {
	files_move_reservations_db_enter_security,
	files_move_reservations_db_find_blocker,
} from "../server/files-move-reservations.ts";
import { files_saved_placement_db_get_node } from "../server/files-saved-placement.ts";
import { files_share_links_db_check_live_node } from "../server/files-share-links.ts";
import { files_ROOT_ID } from "../shared/files.ts";

/**
 * Set a node's own `restrictedScopeNodeId` when a restrict or unrestrict makes it its own restricted
 * root or stops it being one. Start a scope op with `files_subtree_ops_db_start_rebuild` after this
 * for the descendants.
 *
 * Access changes on the node now. Metadata copies its flag and area in small steps, including
 * archived docs. During Move, both access headers change now and the winning view is refreshed
 * after cleanup. Catalog suggestions keep their normal delay.
 *
 * A scope change also deletes the node's own public link and every link whose stored scope is this
 * node, now. The scope op reaches the items inside later, but they keep this node as their scope id
 * until then, so no other step would delete those links.
 */
export async function files_nodes_db_set_restricted_scope(args: {
	ctx: MutationCtx;
	organizationId: Doc<"files_nodes">["organizationId"];
	workspaceId: Doc<"files_nodes">["workspaceId"];
	nodeId: Id<"files_nodes">;
	restrictedScopeNodeId: Id<"files_nodes"> | null;
}) {
	const { ctx } = args;

	const node = await files_saved_placement_db_get_node(ctx.db, args.nodeId);
	if (node?.restrictedScopeNodeId !== args.restrictedScopeNodeId) {
		const { organizationId, workspaceId, nodeId } = args;
		await files_share_links_db_delete_for_node(ctx, { organizationId, workspaceId, nodeId });
		await files_share_links_db_delete_for_scope(ctx, { organizationId, workspaceId, scopeNodeId: nodeId });
	}

	const isRestrictedScopeRoot = args.restrictedScopeNodeId === args.nodeId;
	// A restricted root is a boundary of its parent's area. A folder that stops being one stays a
	// boundary until its scope op ends, so a recursive read still finds the items the op has not
	// reached. A file has no op, so it stops being one at once.
	const boundary = (parentScopeNodeId: Id<"files_nodes"> | null) =>
		isRestrictedScopeRoot ? { parentScopeNodeId } : node?.kind === "file" ? { parentScopeNodeId: undefined } : {};
	// A restricted root starts with no added people from above, and it is never an extended root. An
	// item that stops being restricted takes the added people of its parent.
	const extended = (parentExtendedScopeNodeId: Id<"files_nodes"> | null) =>
		isRestrictedScopeRoot
			? { extendedScopeNodeId: null, parentExtendedScopeNodeId: undefined }
			: { extendedScopeNodeId: parentExtendedScopeNodeId };
	// A public file stays public only while its restricted area stays the same.
	const publicFlag = (target: Pick<Doc<"files_nodes">, "isPublic" | "restrictedScopeNodeId">) => ({
		isPublic: target.restrictedScopeNodeId === args.restrictedScopeNodeId ? target.isPublic : undefined,
	});
	if (
		node &&
		(node.moveCohortId ||
			(await files_move_reservations_db_find_blocker(ctx.db, { source: { kind: "saved", id: node._id } })))
	)
		files_move_reservations_db_enter_security(ctx, { nodeId: node._id });
	if (node?.moveCohortId) {
		// Each placement inherits from its own parent. The access rule changes in both views now.
		for (const view of ["before", "after"] as const) {
			const fixedView = { cohortId: node.moveCohortId, view };
			const place = await ctx.db
				.query("files_saved_places")
				.withIndex("by_cohort_view_node", (q) =>
					q.eq("cohortId", fixedView.cohortId).eq("view", view).eq("nodeId", node._id),
				)
				.unique();
			if (!place) continue;
			let parentScopeNodeId: Id<"files_nodes"> | null = null;
			let parentExtendedScopeNodeId: Id<"files_nodes"> | null = null;
			let parentId = place.parentId;
			while (!parentScopeNodeId && parentId !== files_ROOT_ID) {
				const parent = await files_saved_placement_db_get_node(ctx.db, parentId, fixedView);
				if (!parent) break;
				if (parent._id === place.parentId) {
					parentExtendedScopeNodeId = parent.extendedScopeNodeId;
				}
				if (parent.isRestrictedScopeRoot) parentScopeNodeId = parent._id;
				parentId = parent.parentId;
			}
			const restrictedScopeNodeId = isRestrictedScopeRoot ? node._id : parentScopeNodeId;
			await ctx.db.patch("files_saved_places", place._id, {
				restrictedScopeNodeId,
				isRestrictedScopeRoot,
				...boundary(parentScopeNodeId),
				...extended(parentExtendedScopeNodeId),
				...publicFlag(place),
			});
			await files_metadata_db_patch_file_scope(ctx, {
				...args,
				isRestrictedScopeRoot,
				restrictedScopeNodeId,
				fixedView,
			});
		}
	}
	const physical = await ctx.db.get("files_nodes", args.nodeId);
	const physicalParent =
		physical && physical.parentId !== files_ROOT_ID ? await ctx.db.get("files_nodes", physical.parentId) : null;
	await ctx.db.patch("files_nodes", args.nodeId, {
		restrictedScopeNodeId: args.restrictedScopeNodeId,
		isRestrictedScopeRoot,
		...boundary(physicalParent?.restrictedScopeNodeId ?? null),
		...extended(physicalParent?.extendedScopeNodeId ?? null),
		...(physical ? publicFlag(physical) : {}),
	});
	await files_metadata_db_patch_file_scope(ctx, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		nodeId: args.nodeId,
		isRestrictedScopeRoot,
		restrictedScopeNodeId: args.restrictedScopeNodeId,
	});
	await files_updated_by_db_sync_node(ctx, { nodeId: args.nodeId });
}

/**
 * Make an open item an extended root ("Add people": its own grants add people to it) or stop it
 * being one. Start a scope op with `files_subtree_ops_db_start_rebuild` after this for the items
 * inside a folder. The caller checks that the item is not a restricted root.
 *
 * It does not touch metadata docs or public links: an extended item stays in the open area, and
 * links depend only on the restricted scope.
 */
export async function files_nodes_db_set_extended_scope(
	ctx: MutationCtx,
	args: { nodeId: Id<"files_nodes">; extended: boolean },
) {
	const node = await files_saved_placement_db_get_node(ctx.db, args.nodeId);
	if (!node) return;
	// An extended root starts a new link in its parent's chain. An item that stops being one takes
	// its parent's chain.
	const fields = (parent: Doc<"files_nodes"> | null) =>
		args.extended
			? { extendedScopeNodeId: node._id, parentExtendedScopeNodeId: parent?.extendedScopeNodeId ?? null }
			: { extendedScopeNodeId: parent?.extendedScopeNodeId ?? null, parentExtendedScopeNodeId: undefined };
	if (
		node.moveCohortId ||
		(await files_move_reservations_db_find_blocker(ctx.db, { source: { kind: "saved", id: node._id } }))
	)
		files_move_reservations_db_enter_security(ctx, { nodeId: node._id });
	if (node.moveCohortId) {
		// Each placement takes the chain of its own parent in that view.
		for (const view of ["before", "after"] as const) {
			const fixedView = { cohortId: node.moveCohortId, view };
			const place = await ctx.db
				.query("files_saved_places")
				.withIndex("by_cohort_view_node", (q) =>
					q.eq("cohortId", fixedView.cohortId).eq("view", view).eq("nodeId", node._id),
				)
				.unique();
			if (!place) continue;
			const parent =
				place.parentId === files_ROOT_ID
					? null
					: await files_saved_placement_db_get_node(ctx.db, place.parentId, fixedView);
			await ctx.db.patch("files_saved_places", place._id, fields(parent));
		}
	}
	const physical = await ctx.db.get("files_nodes", args.nodeId);
	const physicalParent =
		physical && physical.parentId !== files_ROOT_ID ? await ctx.db.get("files_nodes", physical.parentId) : null;
	await ctx.db.patch("files_nodes", args.nodeId, fields(physicalParent));
}

/**
 * Write the public flag of one node, also in both Move views when a Move holds it. It runs no checks:
 * the caller checks who may do it, and that the node is a file. `files_sharing_db_set_node_public` below
 * runs the checks first.
 *
 * Off works while a Move holds the file: both Move views change now, so the Move end does not write
 * the old value back.
 */
export async function files_nodes_db_set_public(
	ctx: MutationCtx,
	args: { nodeId: Id<"files_nodes">; public: boolean },
) {
	const node = await files_saved_placement_db_get_node(ctx.db, args.nodeId);
	if (!node) return;
	const fields = { isPublic: args.public ? (true as const) : undefined };
	if (
		node.moveCohortId ||
		(await files_move_reservations_db_find_blocker(ctx.db, { source: { kind: "saved", id: node._id } }))
	)
		files_move_reservations_db_enter_security(ctx, { nodeId: node._id });
	if (node.moveCohortId) {
		for (const view of ["before", "after"] as const) {
			const fixedView = { cohortId: node.moveCohortId, view };
			const place = await ctx.db
				.query("files_saved_places")
				.withIndex("by_cohort_view_node", (q) =>
					q.eq("cohortId", fixedView.cohortId).eq("view", view).eq("nodeId", node._id),
				)
				.unique();
			if (!place) continue;
			await ctx.db.patch("files_saved_places", place._id, fields);
		}
	}
	await ctx.db.patch("files_nodes", args.nodeId, fields);
}

/**
 * Turn the public flag of one file on or off. Public link pages then show the file when it is an image
 * or video inside the linked file. It never opens a file by id. Folders have no flag.
 *
 * The caller already checked "edit" on the file, and "view" for On. The app, the public API and the
 * link door share this. Off only removes access, so it skips the On checks and works while a Move holds
 * the file.
 */
export async function files_sharing_db_set_node_public(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		node: Doc<"files_nodes">;
		enabled: boolean;
	},
) {
	const { node } = args;
	if (node.kind !== "file") {
		return Result({
			_nay: {
				name: "not_a_file",
				message: "Only files can be public. Make the files inside this folder public instead.",
			},
		});
	}
	// Turning it on or off twice writes nothing.
	if (Boolean(node.isPublic) === args.enabled) {
		return Result({ _yay: { public: args.enabled } });
	}
	if (args.enabled) {
		// The Move decides the area the file lands in, and a file keeps its flag only in its own area.
		if (
			node.moveCohortId ||
			(await files_move_reservations_db_find_blocker(ctx.db, { source: { kind: "saved", id: node._id } }))
		) {
			return Result({
				_nay: { name: "move_busy", message: "This item is being moved. Try again when the Move ends." },
			});
		}
		// A job on a folder above, such as a restrict that has not reached the file yet, may still move it
		// into another area. That would turn the flag off again, so wait for it.
		for await (const op of ctx.db
			.query("files_subtree_ops")
			.withIndex("by_organization_workspace_kind", (q) =>
				q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId),
			)) {
			if (
				files_subtree_ops_busy_tree_paths(op).some(
					(busyPath) => busyPath === node.treePath || (busyPath.endsWith("/") && node.treePath.startsWith(busyPath)),
				)
			) {
				return Result({
					_nay: { name: "not_ready", message: "Wait until the access change of this item or a folder above finishes" },
				});
			}
		}
		const live = await files_share_links_db_check_live_node(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			node,
		});
		if (live._nay) {
			return live;
		}
	}

	await files_nodes_db_set_public(ctx, { nodeId: node._id, public: args.enabled });
	return Result({ _yay: { public: args.enabled } });
}
