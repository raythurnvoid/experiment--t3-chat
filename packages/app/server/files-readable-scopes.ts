// Readable scopes: which rows a file list may read. Rows are split by their stored
// `restrictedScopeNodeId`: one partition for open content (null), and one per restricted folder. A
// list reads only the partitions the caller may read, so a hidden row is never read and the cost of a
// list grows only with what it returns.
//
// The readable restricted folders come from the caller's share rows (`server/files-share-rows.ts`) on
// `by_org_ws_principal_archive_treePath`, in path order. Nested folders use the nearest scope only: a
// readable folder inside a hidden one is its own partition. A service account also reads single open
// nodes through its own grants, and its share rows give those nodes too.
//
// Only the transitional partitions have a cap (`TRANSITIONAL_MAX_SCOPE_OPS`). Past it the plan hides
// more, never less, and says so with `truncated`, so a reader that needs a whole folder can stop.

import type { Doc, Id } from "../convex/_generated/dataModel.js";
import type { QueryCtx } from "../convex/_generated/server.js";
import {
	access_control_db_filter_readable_file_nodes,
	access_control_db_has_permission,
	access_control_db_resolve_live_restricted_scope,
	access_control_db_resolve_role_refs,
} from "../convex/access_control.ts";
import { files_db_resolve_scope } from "../convex/files_scopes.ts";
import { should_never_happen } from "../shared/shared-utils.ts";
import { files_saved_placement_db_get_node, type files_saved_placement_FixedView } from "./files-saved-placement.ts";
import { files_share_rows_NODE_FIELDS, files_share_rows_principal_key } from "./files-share-rows.ts";
import { path_tree_prefix_upper_bound } from "./server-utils.ts";

/**
 * Scope ops read for transitional partitions. Past this many, the children under the dead scopes of
 * the other ops stay hidden until their job rewrites them: closed, never open, and `truncated`.
 */
const TRANSITIONAL_MAX_SCOPE_OPS = 500;

type Reader = Extract<Awaited<ReturnType<typeof files_readable_scopes_db_reader>>, { mode: "scoped" }>;

/**
 * How one caller lists files.
 *
 * - `flat`: one stream on the scope-less indexes. With `filter: false` every row is readable: the
 *   owner without a service account reads everything, and plugin volumes and GLOBAL reserved
 *   workspaces have no restricted folders. With `filter: true` the per-row filter must check every
 *   row: a member acting through a service account has no partitioned read yet.
 * - `scoped`: one partition per readable scope. `principalKeys` are the share row streams to read: the
 *   member and their roles, or the service account when the owner acts through it (the owner reads
 *   everything, so the account decides alone). `openReadable` says whether open content is readable.
 */
export async function files_readable_scopes_db_reader(
	ctx: QueryCtx,
	args: {
		organizationId: Doc<"files_nodes">["organizationId"];
		workspaceId: Doc<"files_nodes">["workspaceId"];
		userId: Id<"users">;
		serviceAccountId?: Id<"access_control_service_accounts">;
	},
) {
	const scope = files_db_resolve_scope(ctx, args.workspaceId);
	const organizationId = ctx.db.normalizeId("organizations", args.organizationId);
	if (scope.kind !== "workspace" || !organizationId) return { mode: "flat" as const, filter: false };
	const organization = await ctx.db.get("organizations", organizationId);
	if (!organization?.defaultWorkspaceId)
		throw should_never_happen("The workspace has no organization", { organizationId });
	const isOwner = args.userId === organization.ownerUserId;
	if (isOwner && !args.serviceAccountId) return { mode: "flat" as const, filter: false };
	// Known gap until the user decides: the account's and the member's folders have no bounded
	// intersection read, so this caller pays the per-row filter.
	if (!isOwner && args.serviceAccountId) return { mode: "flat" as const, filter: true };

	const ids = {
		organizationId,
		workspaceId: scope.workspaceId,
		userId: args.userId,
		serviceAccountId: args.serviceAccountId,
	};
	const permissionArgs = {
		organizationId,
		workspaceId: scope.workspaceId,
		defaultWorkspaceId: organization.defaultWorkspaceId,
		organizationOwnerUserId: organization.ownerUserId,
		resource: { kind: "workspace" as const, id: scope.workspaceId },
		permission: "content.read" as const,
	};
	if (args.serviceAccountId) {
		const account = await ctx.db.get("access_control_service_accounts", args.serviceAccountId);
		// A revoked account keeps its grants and rows, but reads nothing.
		const live = account?.revokedAt === null && account.workspaceId === scope.workspaceId;
		return {
			mode: "scoped" as const,
			...ids,
			principalKeys: live ? [files_share_rows_principal_key("service_account", args.serviceAccountId)] : [],
			openReadable:
				live &&
				(await access_control_db_has_permission(ctx, { ...permissionArgs, serviceAccountId: args.serviceAccountId })),
		};
	}

	const roleRefs = await access_control_db_resolve_role_refs(ctx, {
		organizationId,
		workspaceId: scope.workspaceId,
		defaultWorkspaceId: organization.defaultWorkspaceId,
		userId: args.userId,
	});
	return {
		mode: "scoped" as const,
		...ids,
		principalKeys: [
			files_share_rows_principal_key("user", args.userId),
			...roleRefs.map((role) => files_share_rows_principal_key("role", role)),
		],
		openReadable: await access_control_db_has_permission(ctx, { ...permissionArgs, userId: args.userId }),
	};
}

/**
 * Whether the rows that store `storedScopeNodeId` are readable. A dead pointer follows its live scope.
 * Without one the rows are open content, even when an account holds an exact grant on the dead node:
 * that grant reads the node only.
 */
async function db_can_read_partition(ctx: QueryCtx, reader: Reader, storedScopeNodeId: Id<"files_nodes">) {
	const scopeNodeId = await access_control_db_resolve_live_restricted_scope(ctx, {
		organizationId: reader.organizationId,
		workspaceId: reader.workspaceId,
		restrictedScopeNodeId: storedScopeNodeId,
	});
	if (!scopeNodeId) return reader.openReadable;
	const readable = await access_control_db_filter_readable_file_nodes(ctx, {
		organizationId: reader.organizationId,
		workspaceId: reader.workspaceId,
		userId: reader.userId,
		serviceAccountId: reader.serviceAccountId,
		hasWorkspaceRead: reader.openReadable,
		nodes: [{ _id: scopeNodeId, restrictedScopeNodeId: scopeNodeId }],
	});
	return readable.length > 0;
}

/**
 * The active nodes of some share rows that the reader may read now: `scope` items (restricted
 * folders) and `node` items (open nodes a service account reads by its own grant).
 *
 * A row is a copy, so each one is checked again, like `db_get_share_tree_rows` in
 * `convex/files_nodes.ts`. The rows were all written for the reader's own grants, so only stale rows
 * drop: a grant whose access ended, like a plugin grant after a re-invite (at most a member's plugin
 * bindings). A copy out of step with its node is a bug: it is logged and dropped.
 */
async function db_get_readable_items(ctx: QueryCtx, reader: Reader, rows: Doc<"files_share_rows">[]) {
	const nodes: Doc<"files_nodes">[] = [];
	for (const row of rows) {
		const node = await files_saved_placement_db_get_node(ctx.db, row.nodeId, row.moveView);
		if (!node || node.organizationId !== reader.organizationId || node.workspaceId !== reader.workspaceId) continue;
		if (
			row.nodeCreationTime !== node._creationTime ||
			files_share_rows_NODE_FIELDS.some((field) => row[field] !== (node[field] ?? null))
		) {
			console.error("files_share_rows copy is mismatched", { shareRowId: row._id, nodeId: node._id });
			continue;
		}
		nodes.push(node);
	}
	const readable = await access_control_db_filter_readable_file_nodes(ctx, {
		organizationId: reader.organizationId,
		workspaceId: reader.workspaceId,
		userId: reader.userId,
		serviceAccountId: reader.serviceAccountId,
		hasWorkspaceRead: reader.openReadable,
		nodes,
	});
	const items: Array<{ kind: "scope" | "node"; node: Doc<"files_nodes"> }> = [];
	for (const node of readable) {
		if (node.restrictedScopeNodeId === node._id) items.push({ kind: "scope", node });
		else if (node.restrictedScopeNodeId === null && reader.serviceAccountId) items.push({ kind: "node", node });
	}
	return items;
}

/**
 * The partitions a list under `folder` (null is the workspace root) must have open at `at`, its last
 * key's `treePath` (null at the start). Each names a stored `restrictedScopeNodeId` (null is open
 * content) and the `treePath` where its rows start in this list. Only readable partitions are given:
 *
 * - open content, when the reader may read it;
 * - the folder's own stored scope;
 * - every readable restricted folder under the folder that holds `at`. A list that goes on inside
 *   such a folder needs it open, and `files_readable_scopes_db_enumerate_by_path` starts after `at`.
 *   This is one point read per folder level and principal;
 * - transitional partitions: the dead scopes of the unrestrict jobs still running over this folder.
 *   Their children keep the dead pointer until the job writes them, and readability follows the live
 *   scope (`access_control_db_resolve_live_restricted_scope`), so the children stay listed meanwhile.
 *
 * `truncated` is true when the workspace has more than `TRANSITIONAL_MAX_SCOPE_OPS` scope ops: the
 * children under the other ops' dead scopes are missing. A list may show the page, but a reader that
 * must see the whole folder, like `cp -r`, must stop instead of copying part of it.
 *
 * `tag` picks the Move view (`files_saved_stream_db_create`), undefined outside a Move.
 */
export async function files_readable_scopes_db_plan(
	ctx: QueryCtx,
	args: {
		reader: Reader;
		tag: files_saved_placement_FixedView | undefined;
		folder: Pick<Doc<"files_nodes">, "treePath" | "restrictedScopeNodeId"> | null;
		at: string | null;
	},
) {
	const { reader, tag } = args;
	const folderTreePath = args.folder?.treePath ?? "/";
	const partitions: Array<{ scopeNodeId: Id<"files_nodes"> | null; treePath: string }> = [];
	const add = (scopeNodeId: Id<"files_nodes"> | null, treePath: string) => {
		if (!partitions.some((partition) => partition.scopeNodeId === scopeNodeId)) partitions.push({ scopeNodeId, treePath });
	};

	if (reader.openReadable) add(null, folderTreePath);
	const ambient = args.folder?.restrictedScopeNodeId ?? null;
	if (ambient && (await db_can_read_partition(ctx, reader, ambient))) add(ambient, folderTreePath);

	// The folder levels below the folder that hold `at`, and `at` itself when it is a folder.
	const at = args.at?.startsWith(folderTreePath) ? args.at : "";
	const rows: Doc<"files_share_rows">[] = [];
	for (let index = folderTreePath.length; index < at.length; index++) {
		if (at[index] !== "/") continue;
		const treePath = at.slice(0, index + 1);
		for (const principalKey of reader.principalKeys) {
			const row = await ctx.db
				.query("files_share_rows")
				.withIndex("by_org_ws_principal_archive_treePath", (q) =>
					q
						.eq("organizationId", reader.organizationId)
						.eq("workspaceId", reader.workspaceId)
						.eq("principalKey", principalKey)
						.eq("moveView.cohortId", tag?.cohortId)
						.eq("moveView.view", tag?.view)
						.eq("archiveOperationId", null)
						.eq("treePath", treePath),
				)
				.first();
			if (row) rows.push(row);
		}
	}
	for (const item of await db_get_readable_items(ctx, reader, rows))
		if (item.kind === "scope") add(item.node._id, item.node.treePath);

	// Every new op reads the ops of its workspace too (`files_subtree_ops_db_find_blocker`). A restrict
	// job's root is live and is its own partition. Only an unrestricted root is a dead scope.
	const ops = await ctx.db
		.query("files_subtree_ops")
		.withIndex("by_organization_workspace_kind", (q) =>
			q.eq("organizationId", reader.organizationId).eq("workspaceId", reader.workspaceId).eq("kind", "scope"),
		)
		.take(TRANSITIONAL_MAX_SCOPE_OPS + 1);
	const truncated = ops.length > TRANSITIONAL_MAX_SCOPE_OPS;
	for (const op of ops.slice(0, TRANSITIONAL_MAX_SCOPE_OPS)) {
		// Skip an op away from the folder before reading its roots. A stale path only hides more.
		if (!op.treePaths.some((path) => path.startsWith(folderTreePath) || folderTreePath.startsWith(path))) continue;
		for (const rootNodeId of op.rootNodeIds) {
			const root = await files_saved_placement_db_get_node(ctx.db, rootNodeId, tag);
			if (!root || root.restrictedScopeNodeId === root._id) continue;
			const under = root.treePath.startsWith(folderTreePath);
			if (!under && !folderTreePath.startsWith(root.treePath)) continue;
			if (await db_can_read_partition(ctx, reader, root._id)) add(root._id, under ? root.treePath : folderTreePath);
		}
	}

	return { partitions, truncated };
}

/**
 * One page of the readable items under a folder after `afterTreePath` (null at the start), in
 * `treePath` order, from the share rows of one principal (`reader.principalKeys[principalIndex]`).
 * `folderTreePath` "/" walks the whole workspace: that is the plan's `enumerate_all`, so it has no
 * function of its own.
 *
 * Each principal is its own `.paginate()` stream, and the caller merges them by `treePath` and drops
 * a node it already has, like the folder table merges its share streams. Every row read is a row of
 * the reader's own grants, so a page reads no hidden folder. A dropped stale row still moves
 * `continueTreePath`, so the next call goes on after it.
 */
export async function files_readable_scopes_db_enumerate_by_path(
	ctx: QueryCtx,
	args: {
		reader: Reader;
		tag: files_saved_placement_FixedView | undefined;
		principalIndex: number;
		folderTreePath: string;
		afterTreePath: string | null;
		numItems: number;
	},
) {
	const { reader, tag } = args;
	const principalKey = reader.principalKeys[args.principalIndex];
	if (!principalKey) return { items: [], continueTreePath: null, isDone: true };
	const page = await ctx.db
		.query("files_share_rows")
		.withIndex("by_org_ws_principal_archive_treePath", (q) =>
			q
				.eq("organizationId", reader.organizationId)
				.eq("workspaceId", reader.workspaceId)
				.eq("principalKey", principalKey)
				.eq("moveView.cohortId", tag?.cohortId)
				.eq("moveView.view", tag?.view)
				.eq("archiveOperationId", null)
				.gt("treePath", args.afterTreePath ?? args.folderTreePath)
				.lt("treePath", path_tree_prefix_upper_bound(args.folderTreePath)),
		)
		.paginate({ cursor: null, numItems: args.numItems });
	return {
		items: await db_get_readable_items(ctx, reader, page.page),
		continueTreePath: page.page.at(-1)?.treePath ?? null,
		isDone: page.isDone,
	};
}
