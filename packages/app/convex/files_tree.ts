// Saved Files tree and table queries. Keep editor handlers out of this module.

import { query, type QueryCtx } from "./_generated/server.js";
import type { Doc, Id } from "./_generated/dataModel";
import { paginationOptsValidator, paginationResultValidator, type PaginationResult } from "convex/server";
import { server_convex_get_user_fallback_to_anonymous, string_prefix_upper_bound } from "../server/server-utils.ts";
import { compareValues, v, type Infer } from "convex/values";
import { files_ROOT_ID } from "../shared/files.ts";
import {
	files_sort_is_valid,
	files_sort_text_key,
	type files_sort_Key,
	type files_sort_RowKey,
} from "../shared/files-sort.ts";
import {
	files_table_filter_is_valid,
	files_table_filter_order_field,
	files_table_filter_takes_name_prefix,
	files_table_metadata_field,
} from "../shared/files-table.ts";
import { should_never_happen } from "../shared/shared-utils.ts";
import app_convex_schema, {
	files_sort_row_key_validator,
	files_sort_validator,
	files_table_filter_validator,
	files_saved_stream_validator,
} from "./schema.ts";
import { files_saved_placement_db_get_node } from "../server/files-saved-placement.ts";
import { files_saved_stream_db_create } from "../server/files-saved-stream.ts";
import {
	files_saved_placement_db_get_search_generation,
	files_saved_placement_db_get_view,
} from "../server/files-saved-placement.ts";
import { doc } from "convex-helpers/validators";
import { convex_error } from "../server/convex-utils.ts";
import {
	access_control_db_authorize_file_write,
	access_control_db_authorize_membership,
	access_control_db_filter_readable_file_nodes,
	access_control_db_resolve_role_refs,
} from "./access_control.ts";
import { organizations_db_get_membership } from "./organizations_memberships_db.ts";
import { organizations_membership_lifetimes_db_get } from "./organizations_membership_lifetimes.ts";
import { files_share_rows_NODE_FIELDS, files_share_rows_principal_key } from "../server/files-share-rows.ts";
import { files_pending_overlay_db_has_saved_scope_job } from "../server/files-pending-overlay.ts";
import {
	files_node_public_doc_fields,
	files_tree_db_get_public_node_fields,
	files_nodes_db_get_tree_reader,
	files_tree_db_get_readable_node,
	files_tree_db_get_list_rows,
	files_tree_db_get_rows,
	files_tree_locked_row_fields,
	files_tree_db_page_needs_split,
	files_tree_db_page_split_required,
	type files_tree_db_FileChecker,
} from "./files_tree_db.ts";
import { files_nodes_db_require_user_writable } from "../server/files-write-policy.ts";

// Reuse the loaded module between calls. Keep request state inside each query.
export const experimental_reuseContext = true;

const TREE_CHILDREN_MAX_ITEMS = 200;

// The index ranges one call may read. Each split guard below is this budget divided by its worst row.
const TREE_PAGE_MAX_RANGES = 3000;

// The page cap and the split guard of "Shared with you". Each share row is its own scope, so each one
// reads its node and checks its access. The worst row is shared with the member's second role and
// also has an old plugin grant to the member, so the check also reads that grant and the live
// membership lifetime, and its write check reads the node again for added people: 17 index ranges
// (measured in the cost test under `list_tree_children_shared`), floor(3,000 / 17) = 176.
const TREE_SHARE_PAGE_MAX_ITEMS = 176;

// The page cap and the split guard of the custom-field filter share pages: the worst share row as
// above, and one read of its node's field doc: 18 index ranges (the same cost test),
// floor(3,000 / 18) = 166.
const TREE_SHARE_FILTER_PAGE_MAX_ITEMS = 166;

// The split guard of an owner's restricted rows in the tree and the folder table. An open row needs
// no read: the open children of a folder share one access scope, and the rows check each scope once.
// An owner restricted row is its own scope, so it checks access: 2 reads (the user and the
// organization; the owner reads no grant), floor(3,000 / 2) = 1,500, and the guard is 1,000.
const TREE_RESTRICTED_SPLIT_GUARD = 1000;

// The page cap and the split guard of the restricted rows of every other reader. Each row is its own
// scope, so it checks access. The worst row is one the member opens through their second role and
// that also has an old plugin grant to them; a row they can open also checks write access. A locked
// row checks only read access. 16 index ranges (measured in the cost test in
// `files_nodes.tree_locked_rows.test.ts`), floor(3,000 / 16) = 187.
const TREE_RESTRICTED_MEMBER_SPLIT_GUARD = 187;

// The split guard of the open rows in the tree and the folder table. Most open rows share the
// folder's access and read nothing. A row the scope job has not reached gets the full check: the
// worst one is its own "Add people" root that still points at an old root, read through added people
// above and a second role. It reads its node and its own read and write grants: 7 index ranges
// (measured in `files_nodes.tree_locked_rows.test.ts`). A metadata row also reads its node: 8,
// floor(3,000 / 8) = 375.
const TREE_OPEN_SPLIT_GUARD = 375;

// The split guard of the folder table's metadata sort for an owner's restricted rows. The row reads
// its node, and it is its own scope, so it also checks access: 2 reads (the user and the
// organization; the owner reads no grant). That is 3 reads, floor(3,000 / 3) = 1,000, and the guard
// is 700.
const TREE_METADATA_RESTRICTED_SPLIT_GUARD = 700;

const TREE_ANCESTORS_MAX_DEPTH = 64;

/**
 * A split guard shrunk by what this call already read. The folder check before a page can walk a
 * long "Add people" chain (at most about 2,500 ranges at 500 levels), so less is left for the rows.
 * At least 1, so a page always moves on.
 */
async function db_shrink_split_guard(ctx: QueryCtx, guard: number) {
	// A row that reads nothing needs no guard.
	if (guard === Infinity) return guard;
	const { used } = (await ctx.meta.getTransactionMetrics()).databaseQueries;
	return Math.max(1, Math.floor((guard * Math.max(0, TREE_PAGE_MAX_RANGES - used)) / TREE_PAGE_MAX_RANGES));
}

/**
 * The split guard of an open stream. Its rows share the folder's "Add people" chain for their write
 * check, so check the folder's write access first: the rows reuse the answer, and the shrink then
 * counts that chain walk too. `folder` is null at the root.
 */
async function db_open_split_guard(
	ctx: QueryCtx,
	args: { checker: files_tree_db_FileChecker; folder: Doc<"files_nodes"> | null; guard: number },
) {
	await args.checker.can(args.folder, "content.write");
	return await db_shrink_split_guard(ctx, args.guard);
}

// The open row of the tree lists. These four fields cannot contain reserved `GLOBAL` or `SYSTEM`
// values in the visible tree.
const tree_open_row_fields = {
	...files_node_public_doc_fields,
	organizationId: v.id("organizations"),
	workspaceId: v.id("organizations_workspaces"),
	createdBy: v.id("users"),
	updatedBy: v.id("users"),
	locked: v.literal(false),
};

export const get_workspace_move_view = query({
	args: { membershipId: v.id("organizations_workspaces_users") },
	returns: v.union(
		v.null(),
		v.object({
			cohortId: v.union(v.id("files_move_cohorts"), v.null()),
			view: v.union(v.literal("before"), v.literal("after"), v.null()),
			generation: v.number(),
			searchGeneration: v.number(),
		}),
	),
	handler: async (ctx, args) => {
		const reader = await files_nodes_db_get_tree_reader(ctx, args);
		if (!reader) return null;
		const { cohortId, view, generation } = await files_saved_placement_db_get_view(ctx.db, reader.membership);
		// Search hooks use this too. Tree pagers ignore it, so a search change does not restart them.
		const searchGeneration = await files_saved_placement_db_get_search_generation(ctx.db, reader.membership);
		return { cohortId, view, generation, searchGeneration };
	},
});

/**
 * Whether the caller may write a file here. `nodeId` is the node that decides, the same one
 * `access_control_db_authorize_file_write` takes.
 *
 * An action cannot read the database, so every action that writes a file asks this first. Without
 * it those actions would still be asking the workspace, and would refuse the one person a grant was
 * meant for.
 */
export const get_current_user_file_write_permission = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		nodeId: v.union(v.id("files_nodes"), v.literal(files_ROOT_ID)),
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return false;
		}

		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return false;
		}

		const authorized = await access_control_db_authorize_file_write(ctx, { userAuth, membership, nodeId: args.nodeId });
		if (authorized._nay) {
			return false;
		}
		if (args.nodeId === files_ROOT_ID) {
			return true;
		}
		const node = await ctx.db.get("files_nodes", args.nodeId);
		return node !== null && !(await files_nodes_db_require_user_writable(ctx, { node, userId: userAuth.id }))._nay;
	},
});

export const get_file_node_for_membership = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		fileNodeId: v.string(),
	},
	returns: v.union(v.object(files_node_public_doc_fields), v.null()),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			throw convex_error({ message: "Unauthenticated" });
		}
		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return null;
		}

		const fileNodeId = ctx.db.normalizeId("files_nodes", args.fileNodeId);
		if (!fileNodeId) {
			return null;
		}

		const fileNode = await files_saved_placement_db_get_node(ctx.db, fileNodeId);
		if (!fileNode) {
			return null;
		}

		// The permission is checked against the node, not the workspace, so a file inside a restricted
		// folder is refused here even for somebody the workspace lets read everything else.
		const authorized = await access_control_db_authorize_membership(ctx, {
			userAuth,
			membership,
			permission: "content.read",
			fileNode,
		});
		if (authorized._nay) {
			return null;
		}

		// Return the lock source only when this member can read it.
		// Keep the ids and paths of folders the member cannot open private.
		const canWriteContent = await access_control_db_authorize_membership(ctx, {
			userAuth,
			membership,
			permission: "content.write",
			fileNode,
		});
		const writable = await files_nodes_db_require_user_writable(ctx, { node: fileNode, userId: userAuth.id });
		return files_tree_db_get_public_node_fields(
			fileNode,
			canWriteContent._nay ? "permission" : writable._nay ? "read_only" : null,
		);
	},
});

/**
 * Whether a node the caller could not open is locked or gone, so the node view can show the access
 * screen instead of going Home. Ask it only after `get_file_node_for_membership` answered `null`. It
 * answers no name: the node can be below a folder the caller cannot open.
 */
export const get_file_node_access_for_membership = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		fileNodeId: v.string(),
	},
	returns: v.union(v.literal("found"), v.literal("locked"), v.literal("missing")),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			throw convex_error({ message: "Unauthenticated" });
		}
		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		const fileNodeId = ctx.db.normalizeId("files_nodes", args.fileNodeId);
		const fileNode = membership && fileNodeId ? await files_saved_placement_db_get_node(ctx.db, fileNodeId) : null;
		// A node of another workspace is missing here, so an id from elsewhere tells nothing.
		if (
			!membership ||
			!fileNode ||
			fileNode.organizationId !== membership.organizationId ||
			fileNode.workspaceId !== membership.workspaceId
		) {
			return "missing";
		}
		const authorized = await access_control_db_authorize_membership(ctx, {
			userAuth,
			membership,
			permission: "content.read",
			fileNode,
		});
		return authorized._nay ? "locked" : "found";
	},
});

/**
 * The README of one folder: its active file child whose name, in lowercase, is `readme.md`.
 *
 * Names sort by raw bytes, so no single index range finds every letter case. Scan the 8 case
 * variants of the prefix `rea` instead, in byte order. Then the first readable match is the same
 * README that a byte-ordered listing shows first.
 */
export const get_folder_readme = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		folderId: doc(app_convex_schema, "files_nodes").fields.parentId,
	},
	returns: v.union(
		v.null(),
		v.object({
			...files_node_public_doc_fields,
			// These four fields cannot contain reserved `GLOBAL` or `SYSTEM` values in the visible tree.
			organizationId: v.id("organizations"),
			workspaceId: v.id("organizations_workspaces"),
			createdBy: v.id("users"),
			updatedBy: v.id("users"),
		}),
	),
	handler: async (ctx, args) => {
		const reader = await files_nodes_db_get_tree_reader(ctx, { membershipId: args.membershipId });
		if (!reader) {
			return null;
		}
		const { userAuth, membership } = reader;

		// Use the same folder gate as `list_tree_children`: a folder the caller cannot open has no README.
		if (
			args.folderId !== files_ROOT_ID &&
			!(await files_tree_db_get_readable_node(ctx, { reader, nodeId: args.folderId }))
		) {
			return null;
		}

		const prefixes = ["REA", "REa", "ReA", "Rea", "rEA", "rEa", "reA", "rea"];
		const candidateLists = await Promise.all(
			prefixes.map((prefix) =>
				ctx.db
					.query("files_nodes")
					.withIndex("by_organization_workspace_parent_archiveOperation_kind_name", (q) => {
						const range = q
							.eq("organizationId", membership.organizationId)
							.eq("workspaceId", membership.workspaceId)
							.eq("moveCohortId", undefined)
							.eq("parentId", args.folderId)
							.eq("archiveOperationId", null)
							.eq("kind", "file")
							.gte("name", prefix);
						const upperBound = string_prefix_upper_bound(prefix);
						return upperBound === null ? range : range.lt("name", upperBound);
					})
					.take(50),
			),
		);

		// A Move takes its files out of the normal docs until it ends. Read the same ranges on the places
		// of the view that readers see now, so a README that the Move holds stays visible.
		const view = await files_saved_placement_db_get_view(ctx.db, membership);
		const selected = view.cohortId && view.view ? { cohortId: view.cohortId, view: view.view } : null;
		const placeLists = selected
			? await Promise.all(
					prefixes.map(async (prefix) => {
						const places = await ctx.db
							.query("files_saved_places")
							.withIndex("by_view_parent_archive_kind_name", (q) => {
								const range = q
									.eq("cohortId", selected.cohortId)
									.eq("view", selected.view)
									.eq("parentId", args.folderId)
									.eq("archiveOperationId", null)
									.eq("kind", "file")
									.gte("name", prefix);
								const upperBound = string_prefix_upper_bound(prefix);
								return upperBound === null ? range : range.lt("name", upperBound);
							})
							.take(50);
						const nodes = await Promise.all(
							places.map((place) => files_saved_placement_db_get_node(ctx.db, place.nodeId, selected)),
						);
						return nodes.filter((node) => node !== null);
					}),
				)
			: [];

		// Both sources give README names in plain ASCII, so a string sort keeps the byte order.
		const candidates = [...candidateLists.flat(), ...placeLists.flat()]
			.filter((fileNode) => fileNode.name.toLowerCase() === "readme.md")
			.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		const readmes = await access_control_db_filter_readable_file_nodes(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			subject: { kind: "user", userId: userAuth.id, plugin: null },
			nodes: candidates,
		});
		if (readmes.length === 0) {
			return null;
		}

		const [readme] = await files_tree_db_get_rows(ctx, { userAuth, membership, fileNodes: [readmes[0]] });
		return readme;
	},
});

/**
 * Whether the caller has a draft that adds, moves or removes items in this saved folder. The folder
 * table shows saved rows only, so it uses this to point to the Pending tab. A draft that only
 * changes content makes no place and no hide, so it gives no hint.
 */
export const has_drafts_in_folder = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		folderId: doc(app_convex_schema, "files_nodes").fields.parentId,
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const reader = await files_nodes_db_get_tree_reader(ctx, { membershipId: args.membershipId });
		if (!reader) {
			return false;
		}
		const { userAuth, membership } = reader;

		// Use the same folder gate as `list_tree_children`: a folder the caller cannot open shows no hint.
		if (
			args.folderId !== files_ROOT_ID &&
			!(await files_tree_db_get_readable_node(ctx, { reader, nodeId: args.folderId }))
		) {
			return false;
		}

		// A draft that adds or moves an item here has a visible place in this folder.
		const view = await files_saved_placement_db_get_view(ctx.db, membership);
		const selected = view.cohortId && view.view ? { cohortId: view.cohortId, view: view.view } : undefined;
		const views = selected ? [undefined, selected] : [undefined];
		const places = await Promise.all(
			views.map((moveView) =>
				ctx.db
					.query("files_pending_places")
					.withIndex("by_org_ws_user_visible_parent_name", (q) => {
						const visible = q
							.eq("organizationId", membership.organizationId)
							.eq("workspaceId", membership.workspaceId)
							.eq("userId", userAuth.id)
							.eq("moveView.cohortId", moveView?.cohortId)
							.eq("moveView.view", moveView?.view)
							.eq("isVisible", true);
						return args.folderId === files_ROOT_ID
							? visible.eq("parent.kind", "root")
							: visible.eq("parent.kind", "saved").eq("parent.id", args.folderId);
					})
					.first(),
			),
		);
		if (places.some((place) => place !== null)) {
			return true;
		}

		// A draft that moves, renames or deletes a saved item here has a hide in this folder.
		const hides = await Promise.all(
			views.map((moveView) =>
				ctx.db
					.query("files_pending_hides")
					.withIndex("by_org_ws_user_parent_name", (q) =>
						q
							.eq("organizationId", membership.organizationId)
							.eq("workspaceId", membership.workspaceId)
							.eq("userId", userAuth.id)
							.eq("moveView.cohortId", moveView?.cohortId)
							.eq("moveView.view", moveView?.view)
							.eq("parentId", args.folderId),
					)
					.first(),
			),
		);
		return hides.some((hide) => hide !== null);
	},
});

/**
 * Fail loudly when a stream row is not what its index range promised. The open streams check no
 * row's access, so a row of another workspace, or a row whose copied scope fields are out of step
 * with the node, must never show.
 */
function check_tree_stream_row(
	node: Doc<"files_nodes">,
	args: {
		membership: Doc<"organizations_workspaces_users">;
		parentId: Doc<"files_nodes">["parentId"];
		archived: boolean;
		restricted: boolean;
	},
) {
	if (
		node.organizationId !== args.membership.organizationId ||
		node.workspaceId !== args.membership.workspaceId ||
		node.parentId !== args.parentId ||
		(node.archiveOperationId !== null) !== args.archived ||
		node.isRestrictedScopeRoot !== args.restricted ||
		(node.restrictedScopeNodeId === node._id) !== args.restricted
	) {
		const errorMessage = "files_nodes tree stream row scope is mismatched";
		const errorData = { nodeId: node._id, parentId: args.parentId };
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}
}

/**
 * Check the sort, filter, name prefix and segment of one folder table stream, and say how to read
 * it. Returns null when the stream has no rows: an invalid sort, or a `missing` segment that this
 * order does not have. Throws on an invalid filter or page limit.
 */
function get_table_read_args(args: {
	kind: Doc<"files_nodes">["kind"];
	sort: Infer<typeof files_sort_validator>;
	filter: Infer<typeof files_table_filter_validator> | null;
	namePrefix: string | null;
	segment: "value" | "missing";
	paginationOpts: { numItems: number };
}) {
	if (!files_sort_is_valid(args.sort)) {
		return null;
	}
	const sort = args.sort[0]!;
	const filter = args.filter;
	if (
		!Number.isInteger(args.paginationOpts.numItems) ||
		args.paginationOpts.numItems < 1 ||
		(filter !== null &&
			(!files_table_filter_is_valid(filter) || sort.field !== files_table_filter_order_field(filter))) ||
		(args.namePrefix !== null &&
			(filter === null ||
				!files_table_filter_takes_name_prefix(filter) ||
				!files_table_filter_is_valid({ kind: "name", field: "name", op: "starts_with", value: args.namePrefix })))
	)
		throw convex_error({ message: "Invalid table filter or page limit." });

	// Only an extension or size sort with no filter keeps the rows with no value in a `missing`
	// segment. Folders have no size, so the size sort reads them by name in the `value` segment. A
	// metadata sort hides the rows with no value.
	if (
		args.segment === "missing" &&
		(filter !== null ||
			(sort.field !== "extension" && sort.field !== "size") ||
			(sort.field === "size" && args.kind === "folder"))
	) {
		return null;
	}

	// `name starts with` is one range on the stored name key. The upper bound is null only for an
	// empty key (a prefix of only accent marks), and that prefix matches every name.
	const namePrefixText = filter?.kind === "name" ? filter.value : args.namePrefix;
	const namePrefixStart = namePrefixText === null ? null : files_sort_text_key(namePrefixText);
	const namePrefix =
		namePrefixStart === null ? null : { start: namePrefixStart, end: string_prefix_upper_bound(namePrefixStart) };

	return { sort, filter, namePrefix, metadataField: files_table_metadata_field({ sort, filter }) };
}

/**
 * The `principalKey`s of the share rows a member reads, by `principalIndex`: 0 is the member, 1 and
 * 2 are their workspace role and organization role (`access_control_db_resolve_role_refs`). A role
 * they do not have has no key.
 */
async function db_get_share_principal_keys(
	ctx: QueryCtx,
	reader: {
		userAuth: { id: Id<"users"> };
		membership: Doc<"organizations_workspaces_users">;
		defaultWorkspaceId: Id<"organizations_workspaces">;
	},
) {
	const roleRefs = await access_control_db_resolve_role_refs(ctx, {
		organizationId: reader.membership.organizationId,
		workspaceId: reader.membership.workspaceId,
		defaultWorkspaceId: reader.defaultWorkspaceId,
		userId: reader.userAuth.id,
	});
	return [
		files_share_rows_principal_key("user", reader.userAuth.id),
		...roleRefs.map((role) => files_share_rows_principal_key("role", role)),
	];
}

/**
 * The tree rows of one page of share rows. A share row is a copy, so each row keeps a full access
 * check: its node must be a restricted root of the reader's workspace (or an extended root, with
 * `extendedRoots`) and readable by the reader.
 * Its copied fields must match the node, so the node is still where the index range read it: under
 * the read's folder, and active or archived, as the read asks. A row of a plugin grant must also
 * carry the member's live membership lifetime: after a re-invite the old grant reads nothing, even
 * while another grant keeps the node readable. Rows that fail are dropped, so a page can be short.
 */
async function db_get_share_tree_rows(
	ctx: QueryCtx,
	args: {
		reader: {
			userAuth: { id: Id<"users"> };
			membership: Doc<"organizations_workspaces_users">;
			hasWorkspaceRead: boolean;
			checker: files_tree_db_FileChecker;
		};
		shareRows: Doc<"files_share_rows">[];
		/** Also keep rows of items with added people. The folder streams list only restricted children. */
		extendedRoots: boolean;
	},
) {
	const { userAuth, membership } = args.reader;
	const liveLifetime = args.shareRows.some((shareRow) => shareRow.externalPluginMembershipLifetime !== null)
		? await organizations_membership_lifetimes_db_get(ctx, { workspaceId: membership.workspaceId, userId: userAuth.id })
		: null;

	const pairs = (
		await Promise.all(
			args.shareRows.map(async (shareRow) => ({
				shareRow,
				node: await files_saved_placement_db_get_node(ctx.db, shareRow.nodeId, shareRow.moveView),
			})),
		)
	).filter((pair): pair is { shareRow: Doc<"files_share_rows">; node: Doc<"files_nodes"> } => {
		const { shareRow, node } = pair;
		if (node === null) {
			return false;
		}
		// The overlay flush keeps the copy in step with the node. A copy out of step is a bug, and its
		// row would show in the wrong folder, segment or order.
		if (
			shareRow.nodeCreationTime !== node._creationTime ||
			files_share_rows_NODE_FIELDS.some((field) => shareRow[field] !== (node[field] ?? null))
		) {
			console.error("files_share_rows copy is mismatched", { shareRowId: shareRow._id, nodeId: node._id });
			return false;
		}
		return (
			node.organizationId === membership.organizationId &&
			node.workspaceId === membership.workspaceId &&
			(node.restrictedScopeNodeId === node._id || (args.extendedRoots && node.extendedScopeNodeId === node._id)) &&
			(shareRow.externalPluginMembershipLifetime === null ||
				(liveLifetime?.active === true && liveLifetime.lifetime === shareRow.externalPluginMembershipLifetime))
		);
	});
	const kept: typeof pairs = [];
	for (const pair of pairs) {
		if (await args.reader.checker.can(pair.node, "content.read")) {
			kept.push(pair);
		}
	}
	const treeRows = await files_tree_db_get_rows(ctx, {
		userAuth,
		membership,
		checker: args.reader.checker,
		fileNodes: kept.map((pair) => pair.node),
	});
	return kept.map((pair, index) => ({ shareRow: pair.shareRow, treeRow: treeRows[index]! }));
}

/**
 * One page of the children of one folder, of one kind. The Files tree loads each open folder with it.
 *
 * Saved rows only: UI lists never show drafts. Drafts show in the Pending tab and to the agent
 * (files-explorer-tree skill, "Saved-only lists").
 *
 * Like the folder table, each kind has an open stream and a restricted twin. The open stream reads
 * the children that are not their own restricted root. When the caller may read the folder, every
 * such child is readable. Every reader gets the twin; rows they cannot open come back locked. So no
 * row is dropped after paging, and pages are full. The client merges the streams. Active rows come
 * in the folder table's name order `(sortName, name)`, archived rows in `(archiveOperationId,
 * sortName, name)` order.
 */
export const list_tree_children = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		savedStream: v.optional(files_saved_stream_validator),
		parentId: doc(app_convex_schema, "files_nodes").fields.parentId,
		kind: doc(app_convex_schema, "files_nodes").fields.kind,
		archived: v.boolean(),
		/**
		 * Read the children that are their own restricted root.
		 */
		restricted: v.boolean(),
		paginationOpts: paginationOptsValidator,
	},
	returns: paginationResultValidator(v.union(v.object(tree_open_row_fields), v.object(files_tree_locked_row_fields))),
	handler: async (ctx, args) => {
		// Every refusal gives this one answer: the caller cannot open this folder. The path door tells a
		// locked folder from a missing one.
		const refused = { page: [], isDone: true, continueCursor: "" };

		const reader = await files_nodes_db_get_tree_reader(ctx, { membershipId: args.membershipId });
		if (!reader) {
			return refused;
		}
		const { userAuth, membership } = reader;

		// A grant-only member reads no open node, and they get their root rows from
		// `list_tree_shared_roots` instead.
		let folder: Doc<"files_nodes"> | null = null;
		if (args.parentId === files_ROOT_ID) {
			if (!reader.hasWorkspaceRead) {
				return refused;
			}
		} else {
			folder = await files_tree_db_get_readable_node(ctx, { reader, nodeId: args.parentId });
			if (!folder) {
				return refused;
			}
		}

		// Selected rows also read their saved node, cohort and place before checking access.
		const guard = Math.min(
			args.savedStream?.kind === "cohort" ? 500 : Infinity,
			!args.restricted
				? await db_open_split_guard(ctx, { checker: reader.checker, folder, guard: TREE_OPEN_SPLIT_GUARD })
				: await db_shrink_split_guard(
						ctx,
						reader.isOwner ? TREE_RESTRICTED_SPLIT_GUARD : TREE_RESTRICTED_MEMBER_SPLIT_GUARD,
					),
		);
		const paginationOpts = {
			...args.paginationOpts,
			numItems: Math.min(args.paginationOpts.numItems, TREE_CHILDREN_MAX_ITEMS, guard),
		};
		const saved = await files_saved_stream_db_create(ctx.db, membership, args.savedStream);
		const rawResult = args.archived
			? await saved.queries
					.by_parent_kind_restricted_archive_sort_name((q) =>
						q
							.eq("parentId", args.parentId)
							.eq("kind", args.kind)
							.eq("isRestrictedScopeRoot", args.restricted)
							.gt("archiveOperationId", null),
					)
					.paginate(paginationOpts)
			: await saved.queries
					.by_parent_archive_restricted_kind_sort_name((q) =>
						q
							.eq("parentId", args.parentId)
							.eq("archiveOperationId", null)
							.eq("isRestrictedScopeRoot", args.restricted)
							.eq("kind", args.kind),
					)
					.paginate(paginationOpts);
		if (files_tree_db_page_needs_split(rawResult, guard)) {
			return files_tree_db_page_split_required(rawResult);
		}
		const result = { ...rawResult, page: await saved.read_nodes(rawResult.page) };
		for (const node of result.page) {
			check_tree_stream_row(node, {
				membership,
				parentId: args.parentId,
				archived: args.archived,
				restricted: args.restricted,
			});
		}

		const page = await files_tree_db_get_list_rows(ctx, {
			userAuth,
			membership,
			checker: reader.checker,
			folder,
			fileNodes: result.page,
		});
		// A page can be empty after a split. Only isDone ends the folder.
		return { ...result, page };
	},
});

/**
 * One page of one stream of one folder's children, for the folder table.
 *
 * A stream is one kind, one segment, and either the open or the restricted children. It reads one
 * index range with one `.paginate()`. The filter picks the index, and the index fixes the order, so
 * `sort` must be the filter's order (`files_table_filter_order_field`). The browser merges the
 * streams by `sortKey` with `files_sort_compare`. Folders come first.
 *
 * The open stream reads the children that are not their own restricted root. When the caller may
 * read the folder, every such child is readable. Every reader gets the restricted stream; rows they
 * cannot open come back locked. So no row is dropped for access after paging, and pages are full.
 *
 * A custom field (metadata or frontmatter) is never read for a row the caller cannot open, and never
 * changes what they see. So only the owner reads the restricted stream by value. For other readers,
 * a custom-field sort gives the restricted stream by name, after every value row (its `sortKey` has
 * no value part), and a custom-field filter gives no restricted stream: the restricted children they
 * can open come from `list_tree_children_shared`.
 */
export const list_tree_children_sorted = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		savedStream: v.optional(files_saved_stream_validator),
		parentId: doc(app_convex_schema, "files_nodes").fields.parentId,
		kind: doc(app_convex_schema, "files_nodes").fields.kind,
		/**
		 * One clause: the filter's order when a filter is on, else the saved sort.
		 */
		sort: files_sort_validator,
		filter: v.union(files_table_filter_validator, v.null()),
		/**
		 * `name starts with`, next to an "is" filter only. A `name starts with` alone is the filter.
		 */
		namePrefix: v.union(v.string(), v.null()),
		/**
		 * Read the children that are their own restricted root.
		 */
		restricted: v.boolean(),
		/**
		 * The rows with no value. Only an extension or size sort with no filter has them.
		 */
		segment: v.union(v.literal("value"), v.literal("missing")),
		paginationOpts: paginationOptsValidator,
	},
	returns: paginationResultValidator(
		v.union(
			v.object({
				...tree_open_row_fields,
				/**
				 * The row's index key in the table order. Compare it with `files_sort_compare`.
				 */
				sortKey: files_sort_row_key_validator,
			}),
			// Built only from the fields a locked row shows.
			v.object({ ...files_tree_locked_row_fields, sortKey: files_sort_row_key_validator }),
		),
	),
	handler: async (
		ctx,
		args,
	): Promise<
		PaginationResult<Awaited<ReturnType<typeof files_tree_db_get_list_rows>>[number] & { sortKey: files_sort_RowKey }>
	> => {
		// Saved rows only: UI lists never show drafts. Drafts show in the Pending tab and to the agent
		// (files-explorer-tree skill, "Saved-only lists").

		// Every refusal gives this one answer, like `list_tree_children`.
		const refused = { page: [], isDone: true, continueCursor: "" };

		const reader = await files_nodes_db_get_tree_reader(ctx, { membershipId: args.membershipId });
		if (!reader) {
			return refused;
		}
		const { userAuth, membership } = reader;

		// A grant-only member reads no open node. "Shared with you" gives them their shared roots.
		let folder: Doc<"files_nodes"> | null = null;
		if (args.parentId === files_ROOT_ID) {
			if (!reader.hasWorkspaceRead) {
				return refused;
			}
		} else {
			folder = await files_tree_db_get_readable_node(ctx, { reader, nodeId: args.parentId });
			if (!folder) {
				return refused;
			}
		}

		const table = get_table_read_args(args);
		if (!table) {
			return refused;
		}
		const { sort, filter, namePrefix, metadataField } = table;

		// Only the owner reads the restricted metadata twin: its values decide the order, and other
		// readers may not see them. Other readers get the restricted children of a custom-field filter
		// from `list_tree_children_shared`, and those of a custom-field sort by name, below.
		const ownerOrOpen = !args.restricted || reader.isOwner;
		if (metadataField !== null && !ownerOrOpen && filter !== null) {
			return refused;
		}

		const direction = sort.direction;
		const saved = await files_saved_stream_db_create(ctx.db, membership, args.savedStream);

		const table_page = async (
			result: PaginationResult<unknown>,
			rows: Array<{ node: Doc<"files_nodes">; sortKey: files_sort_Key | null }>,
		) => {
			for (const { node } of rows) {
				check_tree_stream_row(node, {
					membership,
					parentId: args.parentId,
					archived: false,
					restricted: args.restricted,
				});
			}
			const listRows = await files_tree_db_get_list_rows(ctx, {
				userAuth,
				membership,
				checker: reader.checker,
				folder,
				fileNodes: rows.map((row) => row.node),
			});
			return {
				...result,
				page: listRows.map((listRow, index) => {
					const row = rows[index]!;
					// Name, size, dates and extension are fields a locked row shows, so its key may use them.
					const sortKey: files_sort_RowKey = { parts: [row.sortKey], nameKey: [row.node.sortName, row.node.name] };
					return { ...listRow, sortKey };
				}),
			};
		};

		// A metadata or frontmatter key: its committed field docs carry the node's sort fields.
		if (metadataField !== null && ownerOrOpen) {
			const guard = args.restricted
				? await db_shrink_split_guard(ctx, saved.tag ? 500 : TREE_METADATA_RESTRICTED_SPLIT_GUARD)
				: await db_open_split_guard(ctx, { checker: reader.checker, folder, guard: TREE_OPEN_SPLIT_GUARD });
			const result = await ctx.db
				.query("files_metadata_docs")
				.withIndex("by_org_ws_source_archive_docKind_field_parent_restricted_sort", (q) => {
					const fieldDocs = q
						.eq("organizationId", membership.organizationId)
						.eq("workspaceId", membership.workspaceId)
						.eq("sourceKind", "committed")
						.eq("moveView.cohortId", saved.tag?.cohortId)
						.eq("moveView.view", saved.tag?.view)
						.eq("archiveOperationId", undefined)
						.eq("docKind", "field")
						.eq("fieldPath", metadataField)
						.eq("parentId", args.parentId)
						.eq("isRestrictedScopeRoot", args.restricted)
						.eq("nodeKind", args.kind);
					// "is" reads one value. Its rows are in name order, so the name prefix is one more range.
					if (filter?.kind === "text" && filter.op === "is") {
						const value = fieldDocs.eq("sortValue", files_sort_text_key(filter.value));
						if (!namePrefix) return value;
						const fromName = value.gte("sortName", namePrefix.start);
						return namePrefix.end === null ? fromName : fromName.lt("sortName", namePrefix.end);
					}
					if (filter?.kind === "text" && filter.op === "starts_with") {
						const start = files_sort_text_key(filter.value);
						const end = string_prefix_upper_bound(start);
						const fromValue = fieldDocs.gte("sortValue", start);
						return end === null ? fromValue : fromValue.lt("sortValue", end);
					}
					// Leave out docs with no value, such as a frontmatter map.
					return fieldDocs.gte("sortValue", "");
				})
				.order(direction)
				.paginate({
					...args.paginationOpts,
					numItems: Math.min(args.paginationOpts.numItems, TREE_CHILDREN_MAX_ITEMS, guard),
					maximumBytesRead: 4 * 1024 * 1024,
				});

			if (files_tree_db_page_needs_split(result, guard)) {
				return files_tree_db_page_split_required(result);
			}

			const rows = await Promise.all(
				result.page.map(async (fieldDoc) => {
					const node =
						fieldDoc.sourceKind === "committed"
							? await files_saved_placement_db_get_node(ctx.db, fieldDoc.fileNodeId, saved.tag)
							: null;
					if (!node || fieldDoc.sourceKind !== "committed") {
						const errorMessage = "fieldDoc.fileNodeId points to a missing files_nodes doc";
						const errorData = { fieldDocId: fieldDoc._id };
						console.error(errorMessage, errorData);
						throw should_never_happen(errorMessage, errorData);
					}
					// Archive, restrict and Move change the node first, and a background job copies the new
					// scope onto its field docs later. Until then the row belongs to another stream, so leave
					// it out, and the page can come back short. A node of another workspace is still a bug.
					if (
						node.organizationId === membership.organizationId &&
						node.workspaceId === membership.workspaceId &&
						(node.archiveOperationId !== null ||
							node.parentId !== args.parentId ||
							node.isRestrictedScopeRoot !== args.restricted)
					) {
						return null;
					}
					// Archive, then Restore with Keep both, can rename the node in the same folder before the
					// saved scope job copies the new name. Leave the row out while that job is pending.
					if (
						(fieldDoc.sortName !== node.sortName || fieldDoc.name !== node.name) &&
						fieldDoc.nodeKind === node.kind &&
						(await files_pending_overlay_db_has_saved_scope_job(ctx, node._id))
					) {
						return null;
					}
					// The field doc copies the node's name and kind. A stale copy would put the row in the
					// wrong place or the wrong stream, so it must fail loudly.
					if (fieldDoc.sortName !== node.sortName || fieldDoc.name !== node.name || fieldDoc.nodeKind !== node.kind) {
						const errorMessage = "fieldDoc sort fields are mismatched";
						const errorData = { fieldDocId: fieldDoc._id, nodeId: node._id };
						console.error(errorMessage, errorData);
						throw should_never_happen(errorMessage, errorData);
					}

					return {
						node,
						sortKey:
							sort.field === "name"
								? [node.sortName, node.name]
								: [fieldDoc.sortValue ?? null, node.sortName, node.name],
					};
				}),
			);
			const page = await table_page(
				result,
				rows.filter((row) => row !== null),
			);
			// An open row the scope job has not reached yet can come back locked. Its place in this order
			// comes from its value, so leave it out until the job ends; the page can be short then.
			return { ...page, page: page.page.filter((row) => !row.locked) };
		}

		// Selected rows also read their saved node, cohort and place before checking access.
		const guard = Math.min(
			args.savedStream?.kind === "cohort" ? 500 : Infinity,
			!args.restricted
				? await db_open_split_guard(ctx, { checker: reader.checker, folder, guard: TREE_OPEN_SPLIT_GUARD })
				: await db_shrink_split_guard(
						ctx,
						reader.isOwner ? TREE_RESTRICTED_SPLIT_GUARD : TREE_RESTRICTED_MEMBER_SPLIT_GUARD,
					),
		);
		const paginationOpts = {
			...args.paginationOpts,
			numItems: Math.min(args.paginationOpts.numItems, TREE_CHILDREN_MAX_ITEMS, guard),
		};

		const by_name = (node: Doc<"files_nodes">): files_sort_Key => [node.sortName, node.name];
		const stream = await (async (/* iife */): Promise<{
			result: PaginationResult<Doc<"files_nodes"> | Doc<"files_saved_places">>;
			sortKey: (node: Doc<"files_nodes">) => files_sort_Key | null;
		}> => {
			// Convex appends `_creationTime` to every index, so this index is in creation order.
			if (filter === null ? sort.field === "created" : filter.kind === "date" && filter.field === "created") {
				const day = filter?.kind === "date" ? filter : null;
				return {
					result: await saved.queries
						.by_parent_archive_restricted_kind_created({
							parentId: args.parentId,
							archiveOperationId: null,
							isRestrictedScopeRoot: args.restricted,
							kind: args.kind,
							day,
						})
						.order(direction)
						.paginate(paginationOpts),
					sortKey: (node) => [node._creationTime],
				};
			}

			if (filter === null ? sort.field === "updated" : filter.kind === "date") {
				const day = filter?.kind === "date" ? filter : null;
				return {
					result: await saved.queries
						.by_parent_archive_restricted_kind_updated((q) => {
							const children = q
								.eq("parentId", args.parentId)
								.eq("archiveOperationId", null)
								.eq("isRestrictedScopeRoot", args.restricted)
								.eq("kind", args.kind);
							return day === null
								? children
								: day.op === "before"
									? children.lt("updatedAt", day.start)
									: day.op === "after"
										? children.gte("updatedAt", day.end)
										: children.gte("updatedAt", day.start).lt("updatedAt", day.end);
						})
						.order(direction)
						.paginate(paginationOpts),
					sortKey: (node) => [node.updatedAt, node.sortName, node.name],
				};
			}

			// An "is" or "missing" filter reads one value. Its rows are in name order, so the name prefix
			// is one more range.
			if (filter?.kind === "extension") {
				const extension = filter.op === "is" ? filter.value.toLowerCase() : null;
				return {
					result: await saved.queries
						.by_parent_archive_restricted_kind_ext((q) => {
							const value = q
								.eq("parentId", args.parentId)
								.eq("archiveOperationId", null)
								.eq("isRestrictedScopeRoot", args.restricted)
								.eq("kind", args.kind)
								.eq("lowercaseExtension", extension);
							if (!namePrefix) return value;
							const fromName = value.gte("sortName", namePrefix.start);
							return namePrefix.end === null ? fromName : fromName.lt("sortName", namePrefix.end);
						})
						.order(direction)
						.paginate(paginationOpts),
					sortKey: by_name,
				};
			}

			if (filter?.kind === "size" && (filter.op === "is" || filter.op === "missing")) {
				const size = filter.op === "is" ? filter.value : null;
				return {
					result: await saved.queries
						.by_parent_archive_restricted_kind_size((q) => {
							const value = q
								.eq("parentId", args.parentId)
								.eq("archiveOperationId", null)
								.eq("isRestrictedScopeRoot", args.restricted)
								.eq("kind", args.kind)
								.eq("contentByteSize", size);
							if (!namePrefix) return value;
							const fromName = value.gte("sortName", namePrefix.start);
							return namePrefix.end === null ? fromName : fromName.lt("sortName", namePrefix.end);
						})
						.order(direction)
						.paginate(paginationOpts),
					sortKey: by_name,
				};
			}

			// A size range orders by size. `at_most` leaves out the rows with no size.
			if (filter?.kind === "size") {
				const bound = filter.value;
				return {
					result: await saved.queries
						.by_parent_archive_restricted_kind_size((q) => {
							const children = q
								.eq("parentId", args.parentId)
								.eq("archiveOperationId", null)
								.eq("isRestrictedScopeRoot", args.restricted)
								.eq("kind", args.kind);
							return filter.op === "at_least"
								? children.gte("contentByteSize", bound)
								: children.gt("contentByteSize", null).lte("contentByteSize", bound);
						})
						.order(direction)
						.paginate(paginationOpts),
					sortKey: (node) => [node.contentByteSize, node.sortName, node.name],
				};
			}

			// Null means no extension or no known size. With no filter, those rows are the `missing`
			// segment, by name.
			const missing = args.segment === "missing";
			if (filter === null && sort.field === "extension") {
				return {
					result: await saved.queries
						.by_parent_archive_restricted_kind_ext((q) => {
							const children = q
								.eq("parentId", args.parentId)
								.eq("archiveOperationId", null)
								.eq("isRestrictedScopeRoot", args.restricted)
								.eq("kind", args.kind);
							return missing ? children.eq("lowercaseExtension", null) : children.gt("lowercaseExtension", null);
						})
						.order(missing ? "asc" : direction)
						.paginate(paginationOpts),
					sortKey: (node) => (missing ? null : [node.lowercaseExtension, node.sortName, node.name]),
				};
			}

			if (filter === null && sort.field === "size" && args.kind === "file") {
				return {
					result: await saved.queries
						.by_parent_archive_restricted_kind_size((q) => {
							const children = q
								.eq("parentId", args.parentId)
								.eq("archiveOperationId", null)
								.eq("isRestrictedScopeRoot", args.restricted)
								.eq("kind", args.kind);
							return missing ? children.eq("contentByteSize", null) : children.gt("contentByteSize", null);
						})
						.order(missing ? "asc" : direction)
						.paginate(paginationOpts),
					sortKey: (node) => (missing ? null : [node.contentByteSize, node.sortName, node.name]),
				};
			}

			// The name order: no filter with a name sort, a `name starts with` filter, folders in a size
			// sort (they have no size, so their key is null), and the restricted rows of a custom-field sort
			// for a reader who is not the owner (no value in their key, so they come after every value row).
			return {
				result: await saved.queries
					.by_parent_archive_restricted_kind_sort_name((q) => {
						const children = q
							.eq("parentId", args.parentId)
							.eq("archiveOperationId", null)
							.eq("isRestrictedScopeRoot", args.restricted)
							.eq("kind", args.kind);
						if (!namePrefix) return children;
						const fromName = children.gte("sortName", namePrefix.start);
						return namePrefix.end === null ? fromName : fromName.lt("sortName", namePrefix.end);
					})
					.order(sort.field === "name" ? direction : "asc")
					.paginate(paginationOpts),
				sortKey: (node) => (sort.field === "name" ? by_name(node) : null),
			};
		})();

		if (files_tree_db_page_needs_split(stream.result, guard)) {
			return files_tree_db_page_split_required(stream.result);
		}

		return await table_page(
			stream.result,
			(await saved.read_nodes(stream.result.page)).map((node) => ({ node, sortKey: stream.sortKey(node) })),
		);
	},
});

/**
 * One page of one share stream of one folder's children, for a custom-field (metadata or
 * frontmatter) filter of the folder table: the restricted children shared with a member that match.
 * Every other sort and filter reads the restricted twin of `list_tree_children_sorted`.
 *
 * A locked child's custom field is never read, so the filter never shows it, and its value never
 * changes the rows, the page size or the cursor. So a member reads their share rows instead of the
 * twin: they list only children the member can open (checked again per row), and a row is kept
 * when its own field doc matches. An "is" filter is in name order, so its rows merge with the open
 * rows by name. A "starts with" or "present" filter is in value order, so these rows have no value
 * in their key and come after the value rows, by name. The owner reads the restricted metadata twin
 * of `list_tree_children_sorted`, so the owner gets an empty page.
 *
 * A share row is one copy per share (one grant to a user or a role), not one per member who can
 * read the node. A share to a role stays one row however many members hold the role, and a role
 * change writes nothing. So a member reads up to 3 streams per kind, by `principalIndex`
 * (`db_get_share_principal_keys`), and the client drops a node it already has.
 */
export const list_tree_children_shared = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		savedStream: v.optional(files_saved_stream_validator),
		parentId: doc(app_convex_schema, "files_nodes").fields.parentId,
		kind: doc(app_convex_schema, "files_nodes").fields.kind,
		/**
		 * 0 reads the member's own shares, 1 and 2 the shares of their roles.
		 */
		principalIndex: v.union(v.literal(0), v.literal(1), v.literal(2)),
		sort: files_sort_validator,
		filter: v.union(files_table_filter_validator, v.null()),
		namePrefix: v.union(v.string(), v.null()),
		segment: v.union(v.literal("value"), v.literal("missing")),
		paginationOpts: paginationOptsValidator,
	},
	returns: paginationResultValidator(
		v.object({
			...tree_open_row_fields,
			/**
			 * The row's index key in the table order. Compare it with `files_sort_compare`.
			 */
			sortKey: files_sort_row_key_validator,
		}),
	),
	handler: async (
		ctx,
		args,
	): Promise<
		PaginationResult<
			Awaited<ReturnType<typeof files_tree_db_get_rows>>[number] & { locked: false; sortKey: files_sort_RowKey }
		>
	> => {
		// Saved rows only: UI lists never show drafts. Drafts show in the Pending tab and to the agent
		// (files-explorer-tree skill, "Saved-only lists").

		// Every refusal gives this one answer, like `list_tree_children`.
		const refused = { page: [], isDone: true, continueCursor: "" };

		const reader = await files_nodes_db_get_tree_reader(ctx, { membershipId: args.membershipId });
		if (!reader) {
			return refused;
		}
		const { membership } = reader;

		// Do the refusals that need no folder read first, so they cost nothing.
		const table = get_table_read_args(args);
		if (!table || reader.isOwner || table.metadataField === null || table.filter?.kind !== "text") {
			return refused;
		}
		const { sort, filter, namePrefix, metadataField } = table;

		// The server builds the key from the caller only, never from the client.
		const principalKey = (await db_get_share_principal_keys(ctx, reader))[args.principalIndex];
		if (!principalKey) {
			return refused;
		}

		// At the root a grant-only member still gets the shares there, because the open streams give
		// them nothing.
		if (
			args.parentId !== files_ROOT_ID &&
			!(await files_tree_db_get_readable_node(ctx, { reader, nodeId: args.parentId }))
		) {
			return refused;
		}

		// Each share row reads its node, checks its access and reads its field doc.
		const guard = await db_shrink_split_guard(ctx, TREE_SHARE_FILTER_PAGE_MAX_ITEMS);
		const { tag } = await files_saved_stream_db_create(ctx.db, membership, args.savedStream);
		const result = await ctx.db
			.query("files_share_rows")
			.withIndex("by_org_ws_principal_parent_kind_archive_sortName_name", (q) => {
				const children = q
					.eq("organizationId", membership.organizationId)
					.eq("workspaceId", membership.workspaceId)
					.eq("principalKey", principalKey)
					.eq("moveView.cohortId", tag?.cohortId)
					.eq("moveView.view", tag?.view)
					.eq("parentId", args.parentId)
					.eq("kind", args.kind)
					.eq("archiveOperationId", null);
				if (!namePrefix) return children;
				const fromName = children.gte("sortName", namePrefix.start);
				return namePrefix.end === null ? fromName : fromName.lt("sortName", namePrefix.end);
			})
			// "is" reads one value, so its order is the name order. The value orders put these rows last, by name.
			.order(sort.field === "name" ? sort.direction : "asc")
			.paginate({ ...args.paginationOpts, numItems: Math.min(args.paginationOpts.numItems, guard) });

		if (files_tree_db_page_needs_split(result, guard)) {
			return files_tree_db_page_split_required(result);
		}

		const rows = await db_get_share_tree_rows(ctx, { reader, shareRows: result.page, extendedRoots: false });
		// Reads only restricted children the caller can open; role streams are capped by
		// MAX_FILE_SHARES_PER_ROLE. Approved exception: a row that does not match is left out after
		// this read, so a page can be short.
		const fieldDocs = await Promise.all(
			rows.map(({ shareRow }) =>
				ctx.db
					.query("files_metadata_docs")
					.withIndex("by_organization_workspace_source_fileNode_fieldPath", (q) =>
						q
							.eq("organizationId", membership.organizationId)
							.eq("workspaceId", membership.workspaceId)
							.eq("sourceKind", "committed")
							.eq("fileNodeId", shareRow.nodeId)
							.eq("moveView.cohortId", tag?.cohortId)
							.eq("moveView.view", tag?.view)
							.eq("fieldPath", metadataField),
					)
					// The range is one node's docs of one key: its field doc, which carries the sort value and is
					// written first, then one value doc per array item, capped on write (`shared/files-metadata.ts`).
					.filter((q) => q.eq(q.field("docKind"), "field"))
					.first(),
			),
		);
		const start = filter.op === "present" ? null : files_sort_text_key(filter.value);
		const end = filter.op === "starts_with" ? string_prefix_upper_bound(start!) : null;
		const matches = (sortValue: string | undefined) =>
			sortValue !== undefined &&
			(filter.op === "present" ||
				(filter.op === "is"
					? sortValue === start
					: compareValues(sortValue, start!) >= 0 && (end === null || compareValues(sortValue, end) < 0)));
		return {
			...result,
			page: rows.flatMap(({ shareRow, treeRow }, index) => {
				const fieldDoc = fieldDocs[index];
				if (fieldDoc?.sourceKind !== "committed" || !matches(fieldDoc.sortValue)) return [];
				// The key comes from the share row, the index key of this page, so the merge sees what the
				// index sorted.
				const sortKey: files_sort_RowKey = {
					parts: [sort.field === "name" ? [shareRow.sortName, shareRow.name] : null],
					nameKey: [shareRow.sortName, shareRow.name],
				};
				return [{ ...treeRow, locked: false as const, sortKey }];
			}),
		};
	},
});

/**
 * A node and the readable folders above it, for deep links, reveal, and the breadcrumb.
 *
 * `ancestors` go from the top readable folder down to the node's parent. The walk stops at the
 * first folder the caller cannot read, because the tree cannot show a row under a folder it cannot
 * show. So the node's rows hang from the root. Every row still carries its `path` and `parentId`,
 * like `list_tree_children` rows, so the names of the locked folders above it are not secret.
 */
export const get_tree_ancestors = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		/**
		 * Keep raw IDs so invalid input returns null instead of an argument error.
		 */
		nodeId: v.string(),
	},
	returns: v.union(
		v.null(),
		v.object({
			node: v.object({
				...files_node_public_doc_fields,
				// These four fields cannot contain reserved `GLOBAL` or `SYSTEM` values in the visible tree.
				organizationId: v.id("organizations"),
				workspaceId: v.id("organizations_workspaces"),
				createdBy: v.id("users"),
				updatedBy: v.id("users"),
			}),
			ancestors: v.array(
				v.object({
					...files_node_public_doc_fields,
					// These four fields cannot contain reserved `GLOBAL` or `SYSTEM` values in the visible tree.
					organizationId: v.id("organizations"),
					workspaceId: v.id("organizations_workspaces"),
					createdBy: v.id("users"),
					updatedBy: v.id("users"),
				}),
			),
		}),
	),
	handler: async (ctx, args) => {
		const reader = await files_nodes_db_get_tree_reader(ctx, { membershipId: args.membershipId });
		if (!reader) {
			return null;
		}

		const nodeId = ctx.db.normalizeId("files_nodes", args.nodeId);
		if (!nodeId) {
			return null;
		}

		// Archived nodes are allowed. The caller decides how to show them.
		const fileNode = await files_tree_db_get_readable_node(ctx, { reader, nodeId });
		if (!fileNode) {
			return null;
		}

		const ancestors: Doc<"files_nodes">[] = [];
		let parentId = fileNode.parentId;
		while (parentId !== files_ROOT_ID && ancestors.length < TREE_ANCESTORS_MAX_DEPTH) {
			const parent = await files_tree_db_get_readable_node(ctx, { reader, nodeId: parentId });
			if (!parent) {
				break;
			}

			ancestors.unshift(parent);
			parentId = parent.parentId;
		}

		const [node, ...ancestorRows] = await files_tree_db_get_rows(ctx, {
			userAuth: reader.userAuth,
			membership: reader.membership,
			fileNodes: [fileNode, ...ancestors],
		});
		return { node, ancestors: ancestorRows };
	},
});

/**
 * The "Shared with you" group of the Files tree: every share of the caller, one page of one
 * principal (see `list_tree_children_shared`). The client merges the 3 principal streams and drops
 * a node it already has. A share is always readable, so no row is locked.
 *
 * Saved rows only. A share inside a folder the member can open shows here and in its folder. The
 * owner reads everything, so the owner gets nothing. Active rows come in `(sortName, name)` order,
 * archived rows in `(archiveOperationId, sortName, name)` order.
 */
export const list_tree_shared_roots = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		savedStream: v.optional(files_saved_stream_validator),
		archived: v.boolean(),
		/**
		 * 0 reads the member's own shares, 1 and 2 the shares of their roles.
		 */
		principalIndex: v.union(v.literal(0), v.literal(1), v.literal(2)),
		paginationOpts: paginationOptsValidator,
	},
	returns: paginationResultValidator(v.object(tree_open_row_fields)),
	handler: async (ctx, args) => {
		const refused = { page: [], isDone: true, continueCursor: "" };

		const reader = await files_nodes_db_get_tree_reader(ctx, { membershipId: args.membershipId });
		if (!reader || reader.isOwner) {
			return refused;
		}
		const principalKey = (await db_get_share_principal_keys(ctx, reader))[args.principalIndex];
		if (!principalKey) {
			return refused;
		}
		const { tag } = await files_saved_stream_db_create(ctx.db, reader.membership, args.savedStream);

		const result = await ctx.db
			.query("files_share_rows")
			.withIndex("by_org_ws_principal_archive_sortName_name", (q) => {
				const shares = q
					.eq("organizationId", reader.membership.organizationId)
					.eq("workspaceId", reader.membership.workspaceId)
					.eq("principalKey", principalKey)
					.eq("moveView.cohortId", tag?.cohortId)
					.eq("moveView.view", tag?.view);
				return args.archived ? shares.gt("archiveOperationId", null) : shares.eq("archiveOperationId", null);
			})
			.paginate({
				...args.paginationOpts,
				numItems: Math.min(args.paginationOpts.numItems, TREE_SHARE_PAGE_MAX_ITEMS),
			});

		// Each share row reads its node and checks its access (`TREE_SHARE_PAGE_MAX_ITEMS`).
		if (files_tree_db_page_needs_split(result, TREE_SHARE_PAGE_MAX_ITEMS)) {
			return files_tree_db_page_split_required(result);
		}

		const rows = await db_get_share_tree_rows(ctx, { reader, shareRows: result.page, extendedRoots: true });
		return { ...result, page: rows.map((row) => ({ ...row.treeRow, locked: false as const })) };
	},
});
