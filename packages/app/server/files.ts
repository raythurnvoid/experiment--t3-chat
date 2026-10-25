/**
 * Server-side file helpers for files.
 *
 * This module runs in the Convex runtime and must NOT import from:
 * - src/ (client code)
 * - vendor/ UI libraries (novel, liveblocks, React)
 *
 * Only imports from packages that work server-side.
 */

import { internal } from "../convex/_generated/api.js";
import type { WithoutSystemFields } from "convex/server";
import type { Doc, Id } from "../convex/_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../convex/_generated/server";
import {
	files_check_new_folder_count,
	files_check_request_folder_count,
	files_pending_update_has_asset_content,
	files_pending_update_has_yjs_content,
	files_MAX_YJS_WIRE_BYTES,
	files_ROOT_ID,
} from "../shared/files.ts";
import { path_extract_segments_from } from "../shared/paths.ts";
import { organizations_is_global_organization_id } from "../shared/organizations.ts";
import { Result } from "common/errors-as-values-utils.ts";
import { should_never_happen } from "./server-utils.ts";
import {
	files_private_storage_db_reserve,
	files_private_storage_db_release_deleted_resource,
} from "../convex/files_private_storage.ts";
import { files_db_resolve_scope } from "../convex/files_scopes.ts";
import { access_control_db_can_act_on_file_node, type access_control_Subject } from "../convex/access_control.ts";
import {
	files_saved_placement_db_get_node,
	files_saved_placement_db_get_path,
	files_saved_placement_db_get_sequence,
	files_saved_placement_db_get_view,
} from "./files-saved-placement.ts";
import { files_saved_content_db_yjs_updates } from "./files-saved-content.ts";
import { files_saved_content_apply_header, files_saved_content_db_get_head } from "./files-saved-content-head.ts";

export * from "../shared/files.ts";

export async function files_db_cancel_scheduled_function_if_present(
	ctx: MutationCtx,
	scheduledFunctionId: Id<"_scheduled_functions">,
) {
	await ctx.scheduler.cancel(scheduledFunctionId).catch((error) => {
		if (error instanceof Error && error.message.includes("non-existent document")) {
			return;
		}

		throw error;
	});
}

export async function files_db_get_yjs_content_and_sequence(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		nodeId: Id<"files_nodes">;
	},
) {
	const fileNode = await files_saved_placement_db_get_node(ctx.db, args.nodeId);
	if (!fileNode || fileNode.organizationId !== args.organizationId || fileNode.workspaceId !== args.workspaceId) {
		return null;
	}

	if (!fileNode.yjsSnapshotId) {
		const errorMessage = "fileNode.yjsSnapshotId is not set";
		const errorData = {
			nodeId: args.nodeId,
			yjsSnapshotId: fileNode.yjsSnapshotId,
		};
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}

	if (!fileNode.yjsLastSequenceId) {
		const errorMessage = "fileNode.yjsLastSequenceId is not set";
		const errorData = {
			nodeId: args.nodeId,
			yjsLastSequenceId: fileNode.yjsLastSequenceId,
		};
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}

	const [yjsSnapshotDoc, yjsLastSequenceDoc] = await Promise.all([
		ctx.db.get("files_yjs_snapshots", fileNode.yjsSnapshotId),
		files_saved_placement_db_get_sequence(ctx.db, fileNode),
	]);

	if (
		!yjsSnapshotDoc ||
		yjsSnapshotDoc.organizationId !== args.organizationId ||
		yjsSnapshotDoc.workspaceId !== args.workspaceId
	) {
		const errorMessage = "fileNode.yjsSnapshotId points to a missing or mismatched files_yjs_snapshots doc";
		const errorData = {
			nodeId: args.nodeId,
			yjsSnapshotId: fileNode.yjsSnapshotId,
			yjsSnapshotDoc,
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
		};
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}

	if (
		!yjsLastSequenceDoc ||
		yjsLastSequenceDoc.organizationId !== args.organizationId ||
		yjsLastSequenceDoc.workspaceId !== args.workspaceId
	) {
		const errorMessage =
			"fileNode.yjsLastSequenceId points to a missing or mismatched files_yjs_docs_last_sequences doc";
		const errorData = {
			nodeId: args.nodeId,
			yjsLastSequenceId: fileNode.yjsLastSequenceId,
			yjsLastSequenceDoc,
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
		};
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}

	// The update log is bounded by the per-file write gate.
	const yjsUpdatesDocs: Doc<"files_yjs_updates">[] = [];
	for await (const update of files_saved_content_db_yjs_updates(ctx.db, { ...args, throughSequence: yjsLastSequenceDoc.lastSequence }))
		yjsUpdatesDocs.push(update);
	const incrementalYjsUpdatesDocs = yjsUpdatesDocs.filter((u) => u.sequence > yjsSnapshotDoc.sequence).reverse();
	return {
		file: fileNode,
		yjsSnapshotDoc,
		yjsLastSequenceDoc,
		yjsUpdatesDocs,
		incrementalYjsUpdatesDocs,
		yjsSequence: yjsLastSequenceDoc.lastSequence,
	};
}
export async function files_db_get_pending_update(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
		target: Doc<"files_pending_updates">["target"];
		pendingUpdateId?: Id<"files_pending_updates">;
	},
) {
	const pendingUpdateById = args.pendingUpdateId
		? await ctx.db.get("files_pending_updates", args.pendingUpdateId)
		: null;
	const pendingUpdate =
		pendingUpdateById &&
		pendingUpdateById.organizationId === args.organizationId &&
		pendingUpdateById.workspaceId === args.workspaceId &&
		pendingUpdateById.userId === args.userId &&
		pendingUpdateById.target.kind === args.target.kind &&
		pendingUpdateById.target.id === args.target.id
			? pendingUpdateById
			: await ctx.db
					.query("files_pending_updates")
					.withIndex("by_organization_workspace_user_target", (q) =>
						q
							.eq("organizationId", args.organizationId)
							.eq("workspaceId", args.workspaceId)
							.eq("userId", args.userId)
							.eq("target.kind", args.target.kind)
							.eq("target.id", args.target.id),
					)
					.first();

	return pendingUpdate;
}

/**
 * Every proposal write invalidates an older paged review of this owner's draft set.
 */
export async function files_db_advance_pending_review_version(
	ctx: MutationCtx,
	args: { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces">; userId: Id<"users"> },
) {
	const version = await ctx.db
		.query("files_pending_review_versions")
		.withIndex("by_organization_workspace_user", (q) =>
			q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("userId", args.userId),
		)
		.first();
	if (version) {
		await ctx.db.patch("files_pending_review_versions", version._id, { revision: version.revision + 1 });
	} else {
		await ctx.db.insert("files_pending_review_versions", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			revision: 1,
		});
	}
}

/**
 * A draft may expire this long after its last edit, if its owner is also inactive this long.
 */
export const files_DRAFT_IDLE_EXPIRY_MS = 4 * 60 * 60 * 1000;

/**
 * Make sure the owner's expiry check runs no later than `checkAt`.
 * Most calls write nothing, because the check is already due earlier.
 */
async function files_db_ensure_pending_update_expiry_check(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
		checkAt: number;
	},
) {
	const check = await ctx.db
		.query("files_pending_update_expiry_checks")
		.withIndex("by_organization_workspace_user", (q) =>
			q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("userId", args.userId),
		)
		.unique();
	if (check && check.nextCheckAt <= args.checkAt) return;

	const scheduledFunctionId = await ctx.scheduler.runAt(
		args.checkAt,
		internal.files_pending_updates.expire_file_pending_updates,
		{ organizationId: args.organizationId, workspaceId: args.workspaceId, userId: args.userId },
	);
	if (check) {
		await ctx.db.patch("files_pending_update_expiry_checks", check._id, {
			nextCheckAt: args.checkAt,
			scheduledFunctionId,
		});
		await files_db_cancel_scheduled_function_if_present(ctx, check.scheduledFunctionId);
	} else {
		await ctx.db.insert("files_pending_update_expiry_checks", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			nextCheckAt: args.checkAt,
			scheduledFunctionId,
		});
	}
}

export async function files_db_insert_pending_update(
	ctx: MutationCtx,
	value: Omit<WithoutSystemFields<Doc<"files_pending_updates">>, "expiresAt">,
) {
	await files_db_advance_pending_review_version(ctx, value);
	const expiresAt = value.updatedAt + files_DRAFT_IDLE_EXPIRY_MS;
	const pendingUpdateId = await ctx.db.insert("files_pending_updates", { ...value, expiresAt });
	await files_db_ensure_pending_update_expiry_check(ctx, { ...value, checkAt: expiresAt });
	return pendingUpdateId;
}

export async function files_db_patch_pending_update(args: {
	ctx: MutationCtx;
	pendingUpdateId: Id<"files_pending_updates">;
	value: Partial<Omit<WithoutSystemFields<Doc<"files_pending_updates">>, "expiresAt">>;
}) {
	const { ctx, pendingUpdateId, value } = args;

	const proposal = await ctx.db.get("files_pending_updates", pendingUpdateId);
	if (!proposal) throw should_never_happen("Pending update disappeared before its write", { pendingUpdateId });
	await files_db_advance_pending_review_version(ctx, proposal);
	// Every edit writes `updatedAt` and so restarts the idle time. The expiry only moves later, so
	// the owner's expiry check already runs early enough and needs no change.
	await ctx.db.patch(
		"files_pending_updates",
		pendingUpdateId,
		value.updatedAt === undefined
			? value
			: {
					...value,
					expiresAt: Math.max(proposal.expiresAt, value.updatedAt + files_DRAFT_IDLE_EXPIRY_MS),
				},
	);
}

export async function files_db_delete_pending_update(args: {
	ctx: MutationCtx;
	pendingUpdateId: Id<"files_pending_updates">;
	options?: { reviewAlreadyFenced: true };
}) {
	const { ctx, pendingUpdateId, options } = args;

	const proposal = await ctx.db.get("files_pending_updates", pendingUpdateId);
	if (!proposal) return;
	// Paged cleanup follows the root's logical Discard, which already changed this clock.
	if (!options?.reviewAlreadyFenced) await files_db_advance_pending_review_version(ctx, proposal);
	await ctx.db.delete("files_pending_updates", pendingUpdateId);
}

/**
 * Look up a saved path. Owner paths are resolved by the bounded reader in files_visible.
 */
export async function files_db_get_visible_node_by_path(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		path: string;
	},
): Promise<Doc<"files_nodes"> | null> {
	if (args.path === "/") {
		return null;
	}

	const { organizationId, workspaceId } = args;
	const scope = files_db_resolve_scope(ctx, workspaceId);
	if (!organizations_is_global_organization_id(organizationId) && scope.kind === "workspace") {
		const view = await files_saved_placement_db_get_view(ctx.db, { organizationId, workspaceId: scope.workspaceId });
		if (view.cohortId !== null && view.view !== null) {
			return await files_saved_placement_db_get_path(ctx.db, args, { cohortId: view.cohortId, view: view.view });
		}
	}
	// While a move op rewrites stored paths, an item inside the moved folder can still carry its old
	// `path`. Then find the item by name from the root, like the tree does. Without a move op, one
	// index read is enough. Global and mount scopes never have ops.
	const moveOp =
		organizations_is_global_organization_id(organizationId) || scope.kind !== "workspace"
			? null
			: await ctx.db
					.query("files_subtree_ops")
					.withIndex("by_organization_workspace_kind", (q) =>
						q.eq("organizationId", organizationId).eq("workspaceId", scope.workspaceId).eq("kind", "move"),
					)
					.first();
	if (moveOp) {
		let parentId: Doc<"files_nodes">["parentId"] = files_ROOT_ID;
		let node: Doc<"files_nodes"> | null = null;
		for (const name of args.path.split("/").filter(Boolean)) {
			node = await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_parent_name_archiveOperation", (q) =>
					q
						.eq("organizationId", organizationId)
						.eq("workspaceId", workspaceId).eq("moveCohortId", undefined)
						.eq("parentId", parentId)
						.eq("name", name)
						.eq("archiveOperationId", null),
				)
				.first();
			if (!node) return null;
			parentId = node._id;
		}
		return node ? files_saved_content_apply_header(node, await files_saved_content_db_get_head(ctx.db, node)) : null;
	}

	const node = await ctx.db
		.query("files_nodes")
		.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
			q
				.eq("organizationId", organizationId)
				.eq("workspaceId", workspaceId).eq("moveCohortId", undefined)
				.eq("path", args.path)
				.eq("archiveOperationId", null),
		)
		.first();
	return node ? files_saved_content_apply_header(node, await files_saved_content_db_get_head(ctx.db, node)) : null;
}

/**
 * Path lookups for one request. A Move pins its selected view and uses exact path indexes.
 * A move op still walks names while it rewrites stored paths.
 */
export async function files_db_create_path_lookups(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
	},
) {
	const { organizationId, workspaceId } = args;
	const scope = files_db_resolve_scope(ctx, workspaceId);
	// Global and mount scopes never have a Move or a move op.
	const workspace =
		!organizations_is_global_organization_id(organizationId) && scope.kind === "workspace"
			? { organizationId, workspaceId: scope.workspaceId }
			: null;
	const view = workspace ? await files_saved_placement_db_get_view(ctx.db, workspace) : null;
	const fixedView = view?.cohortId && view.view ? { cohortId: view.cohortId, view: view.view } : undefined;
	// While a move op rewrites stored paths, an item inside the moved folder can still carry its old `path`.
	const moveOp =
		workspace && !fixedView
			? await ctx.db
					.query("files_subtree_ops")
					.withIndex("by_organization_workspace_kind", (q) =>
						q
							.eq("organizationId", workspace.organizationId)
							.eq("workspaceId", workspace.workspaceId)
							.eq("kind", "move"),
					)
					.first()
			: null;
	const nodes = new Map<string, Doc<"files_nodes"> | null>();
	// The folders the request names: each found parent and each new folder.
	const named = new Set<string>();

	// Walk the first `count` names from the root and keep each prefix. A missing name or a file ends the
	// walk, so the last node found is the deepest one that exists.
	async function walk_names(names: string[], count: number) {
		let found: { node: Doc<"files_nodes"> | null; depth: number } = { node: null, depth: 0 };
		let path = "";
		for (let index = 0; index < count; index++) {
			const name = names[index]!;
			const parentId = found.node?._id ?? files_ROOT_ID;
			path += `/${name}`;
			let node = nodes.get(path);
			if (node === undefined) {
				node = await ctx.db
					.query("files_nodes")
					.withIndex("by_organization_workspace_parent_name_archiveOperation", (q) =>
						q
							.eq("organizationId", organizationId)
							.eq("workspaceId", workspaceId)
							.eq("moveCohortId", undefined)
							.eq("parentId", parentId)
							.eq("name", name)
							.eq("archiveOperationId", null),
					)
					.first();
				if (node) node = files_saved_content_apply_header(node, await files_saved_content_db_get_head(ctx.db, node));
				nodes.set(path, node);
			}
			if (!node) break;
			found = { node, depth: index + 1 };
			if (node.kind !== "folder") break;
		}
		return found;
	}

	/**
	 * Look up one path.
	 */
	async function get(path: string) {
		if (path === "/") return null;
		if (moveOp) {
			const names = path.slice(1).split("/");
			const found = await walk_names(names, names.length);
			return found.depth === names.length ? found.node : null;
		}
		let node = nodes.get(path);
		if (node === undefined) {
			node = fixedView
				? await files_saved_placement_db_get_path(ctx.db, { organizationId, workspaceId, path }, fixedView)
				: await ctx.db
						.query("files_nodes")
						.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
							q
								.eq("organizationId", organizationId)
								.eq("workspaceId", workspaceId)
								.eq("moveCohortId", undefined)
								.eq("path", path)
								.eq("archiveOperationId", null),
						)
						.first();
			if (node && !fixedView)
				node = files_saved_content_apply_header(node, await files_saved_content_db_get_head(ctx.db, node));
			nodes.set(path, node);
		}
		return node;
	}

	/**
	 * Find the deepest node that exists on a new file path, and its depth. It keeps looking past the
	 * new-folder cap on purpose: the caller checks access on this node before any answer that depends on
	 * what exists below it. Without a Move it looks up the parent first and walks up through the missing
	 * folders, so a file in an existing deep folder costs one read.
	 */
	async function find_existing_parent(path: string) {
		const segments = path_extract_segments_from(path);
		if (moveOp) return await walk_names(segments, segments.length - 1);
		if (fixedView) {
			const parentDepth = segments.length - 1;
			if (parentDepth < 1) return { node: null, depth: 0 };
			const prefix = (depth: number) => `/${segments.slice(0, depth).join("/")}`;
			const direct = await get(prefix(parentDepth));
			if (direct) return { node: direct, depth: parentDepth };
			// Move waits for path repairs, so existing prefixes are contiguous in its selected view.
			let lower = 0;
			let upper = parentDepth;
			let node: Doc<"files_nodes"> | null = null;
			while (upper - lower > 1) {
				const middle = Math.floor((lower + upper) / 2);
				const found = await get(prefix(middle));
				if (found) {
					lower = middle;
					node = found;
				} else upper = middle;
			}
			return { node, depth: lower };
		}
		for (let depth = segments.length - 1; depth >= 1; depth--) {
			const node = await get(`/${segments.slice(0, depth).join("/")}`);
			if (node) return { node, depth };
		}
		return { node: null, depth: 0 };
	}

	/**
	 * Call after the access check on the found parent. Refuse a path that adds too many new folders, then
	 * count the found parent and the new folders toward the request cap.
	 */
	function check_folder_counts(path: string, parentDepth: number) {
		const segments = path_extract_segments_from(path);
		const newFolders = files_check_new_folder_count(segments.length - 1 - parentDepth);
		if (newFolders._nay) return newFolders;
		for (let depth = Math.max(parentDepth, 1); depth < segments.length; depth++) {
			named.add(`/${segments.slice(0, depth).join("/")}`);
		}
		return files_check_request_folder_count(named.size);
	}

	return { get, find_existing_parent, check_folder_counts };
}

/**
 * Say whether a saved path is found, locked or missing for the subject, like a file system does.
 *
 * - `locked`: the item exists and the subject cannot open it, or the path is below a folder they
 *   cannot open, whether the name exists there or not. `node` is set only when the parent folder is
 *   readable, because then the item already shows there as a locked row.
 * - `missing`: nothing is there, and the nearest folder that exists is readable. A file in the middle
 *   of the path is missing too.
 *
 * The normal lookups answer `null` for both. Callers ask this only after a `null`, to choose between
 * "Permission denied" and "not found", so a caller that does not ask still fails closed.
 */
export async function files_db_get_path_access(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		subject: access_control_Subject;
		path: string;
	},
): Promise<
	| { status: "found"; node: Doc<"files_nodes"> }
	| { status: "locked"; node: Doc<"files_nodes"> | null }
	| { status: "missing" }
> {
	// `null` is the workspace root.
	const can_read = (fileNode: Doc<"files_nodes"> | null) =>
		access_control_db_can_act_on_file_node(ctx, { ...args, fileNode, permission: "content.read" });
	// The workspace root has no node. It is locked for a caller who cannot open it (a guest).
	if (args.path === "/") return (await can_read(null)) ? { status: "missing" } : { status: "locked", node: null };
	const lookups = await files_db_create_path_lookups(ctx, args);
	// Use the path, not `parentId`: during a Move the stored parent can be the old one.
	const can_read_parent_of = async (path: string) => {
		const parentPath = path.slice(0, path.lastIndexOf("/"));
		if (parentPath === "") return await can_read(null);
		const parent = await lookups.get(parentPath);
		return parent !== null && (await can_read(parent));
	};
	const node = await lookups.get(args.path);
	if (node) {
		if (await can_read(node)) return { status: "found", node };
		return { status: "locked", node: (await can_read_parent_of(args.path)) ? node : null };
	}
	const { node: nearest, depth } = await lookups.find_existing_parent(args.path);
	// Missing only when the folder that would hold the name is readable. Otherwise the answer would
	// tell which names exist inside a folder the subject cannot open.
	const canSeeInside = !nearest
		? await can_read(null)
		: nearest.kind === "folder"
			? await can_read(nearest)
			: // A file in the middle of the path: decide by the folder it is in.
				(await can_read(nearest)) ||
				(await can_read_parent_of(`/${path_extract_segments_from(args.path).slice(0, depth).join("/")}`));
	return canSeeInside ? { status: "missing" } : { status: "locked", node: null };
}

/**
 * Return branches built from a saved Yjs sequence, or null for any other base.
 */
export function files_pending_update_yjs_content_of(pendingUpdate: Pick<Doc<"files_pending_updates">, "content">) {
	if (!files_pending_update_has_yjs_content(pendingUpdate)) {
		return null;
	}

	return pendingUpdate.content;
}

/**
 * Return branches built from a saved content asset, or null for any other base.
 */
export function files_pending_update_asset_content_of(pendingUpdate: Pick<Doc<"files_pending_updates">, "content">) {
	if (!files_pending_update_has_asset_content(pendingUpdate)) {
		return null;
	}

	return pendingUpdate.content;
}

/**
 * Digest for a paged pending-state family. Not cryptographic: it only has to detect a torn or
 * mixed page family when a state is reassembled. Two FNV-1a 32-bit passes with different seeds,
 * joined as hex.
 */
export function files_pending_update_yjs_state_digest(bytes: Uint8Array) {
	let hashA = 0x811c9dc5;
	let hashB = 0x1000193;
	for (const byte of bytes) {
		hashA = Math.imul(hashA ^ byte, 0x01000193) >>> 0;
		hashB = Math.imul(hashB ^ byte, 0x01000193) >>> 0;
	}
	return `${hashA.toString(16).padStart(8, "0")}${hashB.toString(16).padStart(8, "0")}`;
}

/**
 * Insert one sealed paged Yjs state family (metadata doc plus its pages) owned by a pending
 * update doc. The whole family commits in the caller's mutation, so it is sealed on insert.
 */
export async function files_db_insert_pending_update_yjs_state(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
		target: Doc<"files_pending_update_yjs_states">["target"];
		update: ArrayBuffer;
		/**
		 * Absent for a state built for a file with collaboration off, which has no lineage.
		 */
		lineageGeneration?: number;
	} & (
		| { pendingUpdateId: Id<"files_pending_updates">; role: "base" | "staged" | "unstaged" }
		| { transferItemId: Id<"files_transfer_items"> }
	),
) {
	// A Yjs state encode is never empty (the empty document encodes as 2 bytes), so every state
	// has at least one non-empty page.
	const bytes = new Uint8Array(args.update);
	const pageCount = Math.ceil(bytes.byteLength / files_MAX_YJS_WIRE_BYTES);

	const stateId = await ctx.db.insert("files_pending_update_yjs_states", {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		userId: args.userId,
		target: args.target,
		owner:
			"transferItemId" in args
				? { kind: "transfer_capture", itemId: args.transferItemId }
				: {
						kind: "active",
						pendingUpdateId: args.pendingUpdateId,
						role: args.role,
					},
		lineageGeneration: args.lineageGeneration,
		sealed: true,
		pageCount,
		totalBytes: bytes.byteLength,
		digest: files_pending_update_yjs_state_digest(bytes),
	});
	const reserved = await files_private_storage_db_reserve(ctx, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		userId: args.userId,
		resource: { kind: "state", id: stateId },
		byteCount: bytes.byteLength,
	});
	if (reserved._nay) {
		await ctx.db.delete("files_pending_update_yjs_states", stateId);
		return reserved;
	}

	for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
		const pageStart = pageIndex * files_MAX_YJS_WIRE_BYTES;
		await ctx.db.insert("files_pending_update_yjs_state_pages", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			stateId,
			pageIndex,
			bytes: bytes.slice(pageStart, pageStart + files_MAX_YJS_WIRE_BYTES).buffer as ArrayBuffer,
		});
	}

	return Result({ _yay: stateId });
}

/**
 * Reassemble one paged state's bytes from its pages inside a query/mutation transaction.
 * Verify contiguous page indexes and the stored totals/digest so a torn or mixed family is
 * refused instead of silently reconstructed wrong. Bounded by the sealed-state cap the seal
 * enforced (one state is at most 4 MiB), so only load one or two states per transaction.
 */
export async function files_db_load_pending_update_yjs_state_bytes(
	ctx: QueryCtx | MutationCtx,
	args: { stateDoc: Doc<"files_pending_update_yjs_states"> },
) {
	const pages = await ctx.db
		.query("files_pending_update_yjs_state_pages")
		.withIndex("by_state_pageIndex", (q) => q.eq("stateId", args.stateDoc._id))
		.collect();

	if (pages.length !== args.stateDoc.pageCount) {
		return Result({
			_nay: { name: "nay" as const, message: "Pending state pages are incomplete" },
		});
	}

	const bytes = new Uint8Array(args.stateDoc.totalBytes);
	let offset = 0;
	for (const [index, page] of pages.entries()) {
		if (page.pageIndex !== index || offset + page.bytes.byteLength > bytes.byteLength) {
			return Result({
				_nay: { name: "nay" as const, message: "Pending state pages are incomplete" },
			});
		}
		bytes.set(new Uint8Array(page.bytes), offset);
		offset += page.bytes.byteLength;
	}

	if (offset !== args.stateDoc.totalBytes || files_pending_update_yjs_state_digest(bytes) !== args.stateDoc.digest) {
		return Result({
			_nay: { name: "nay" as const, message: "Pending state pages are incomplete" },
		});
	}

	return Result({ _yay: bytes });
}

/**
 * Move every active paged state family a pending update doc owns to a durable cleanup task
 * instead of deleting the pages inline. A family can hold 12 MiB of pages, and deleted docs
 * count against the mutation's write budget, so the final commits only re-own metadata here
 * and a bounded scheduled continuation (the pending-state sweeper) drains the pages later.
 */
export async function files_db_retire_pending_update_yjs_states(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		pendingUpdateId: Id<"files_pending_updates">;
	},
) {
	const stateDocs = await ctx.db
		.query("files_pending_update_yjs_states")
		.withIndex("by_owner_pendingUpdate", (q) => q.eq("owner.pendingUpdateId", args.pendingUpdateId))
		.collect();
	if (stateDocs.length === 0) {
		return;
	}

	const cleanupTaskId = await ctx.db.insert("files_pending_update_state_cleanup_tasks", {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		createdAt: Date.now(),
	});
	await Promise.all(
		stateDocs.map((stateDoc) =>
			ctx.db.patch("files_pending_update_yjs_states", stateDoc._id, {
				owner: { kind: "retired", cleanupTaskId },
			}),
		),
	);
	await ctx.scheduler.runAfter(0, internal.files_pending_updates.cleanup_expired_pending_state_rows, {});
}

/**
 * Retire an operation batch family right away after a handled refusal. Physically deleting the
 * family here could blow the mutation's write budget (an input plus output set can hold 24 MiB
 * of pages), so expire the batch and its temporary states instead and run the bounded sweeper
 * now. TTL cleanup stays the crash/abandon fallback; this is the immediate path.
 */
export async function files_db_expire_pending_update_operation_batch(
	ctx: MutationCtx,
	args: { operationBatchId: Id<"files_pending_update_operation_batches"> },
) {
	const batch = await ctx.db.get("files_pending_update_operation_batches", args.operationBatchId);
	if (!batch || batch.cohortContentId) {
		return;
	}

	const [textInputs, batchStates] = await Promise.all([
		ctx.db
			.query("files_pending_update_text_inputs")
			.withIndex("by_operationBatch", (q) => q.eq("operationBatchId", batch._id))
			.collect(),
		ctx.db
			.query("files_pending_update_yjs_states")
			.withIndex("by_owner_operationBatch", (q) => q.eq("owner.operationBatchId", batch._id))
			.collect(),
	]);
	await Promise.all([
		ctx.db.patch("files_pending_update_operation_batches", batch._id, { expiresAt: 0 }),
		...textInputs.map((textInput) => ctx.db.patch("files_pending_update_text_inputs", textInput._id, { expiresAt: 0 })),
		...batchStates.map((stateDoc) =>
			stateDoc.owner.kind === "temporary"
				? ctx.db.patch("files_pending_update_yjs_states", stateDoc._id, {
						owner: { ...stateDoc.owner, expiresAt: 0 },
					})
				: null,
		),
	]);
	await ctx.scheduler.runAfter(0, internal.files_pending_updates.cleanup_expired_pending_state_rows, {});
}

/**
 * Delete every active paged state family a pending update doc owns (metadata docs plus pages).
 * Runs beside every write that clears or deletes the doc's content proposal.
 */
export async function files_db_delete_pending_update_yjs_states(
	ctx: MutationCtx,
	args: {
		pendingUpdateId: Id<"files_pending_updates">;
	},
) {
	const stateDocs = await ctx.db
		.query("files_pending_update_yjs_states")
		.withIndex("by_owner_pendingUpdate", (q) => q.eq("owner.pendingUpdateId", args.pendingUpdateId))
		.collect();

	for (const stateDoc of stateDocs) {
		const pages = await ctx.db
			.query("files_pending_update_yjs_state_pages")
			.withIndex("by_state_pageIndex", (q) => q.eq("stateId", stateDoc._id))
			.collect();
		await Promise.all(pages.map((page) => ctx.db.delete("files_pending_update_yjs_state_pages", page._id)));
		await ctx.db.delete("files_pending_update_yjs_states", stateDoc._id);
		await files_private_storage_db_release_deleted_resource(ctx, { kind: "state", id: stateDoc._id });
	}
}

/**
 * Load and consume one staged trusted Yjs update (pending Accept, public fill, snapshot
 * restore). The stage is deleted in the consuming transaction, so a commit that later refuses
 * still burns it — a refused commit must be rebuilt and restaged, never replayed.
 */
export async function files_db_consume_trusted_yjs_update_stage(
	ctx: MutationCtx,
	args: {
		stageId: Id<"files_yjs_trusted_update_stages">;
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
		nodeId: Id<"files_nodes">;
		kind: Doc<"files_yjs_trusted_update_stages">["kind"];
	},
) {
	const stage = await ctx.db.get("files_yjs_trusted_update_stages", args.stageId);
	if (
		!stage ||
		stage.organizationId !== args.organizationId ||
		stage.workspaceId !== args.workspaceId ||
		stage.userId !== args.userId ||
		stage.fileNodeId !== args.nodeId ||
		stage.kind !== args.kind ||
		stage.cohortContentId !== undefined ||
		(stage.expiresAt !== undefined && stage.expiresAt <= Date.now())
	) {
		return Result({ _nay: { name: "nay" as const, message: "Not found" } });
	}

	await ctx.db.delete("files_yjs_trusted_update_stages", stage._id);
	// A `public_fill` stage holds no bytes, so there is nothing to release.
	if (stage.kind !== "public_fill") {
		await files_private_storage_db_release_deleted_resource(ctx, { kind: "trusted_stage", id: stage._id });
	}
	return Result({ _yay: stage.update });
}
