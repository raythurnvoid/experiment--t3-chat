// Updater sort docs (`files_updated_by_docs`): the DB helpers that keep them in step with their file
// node, and the name drain that follows a user's name changes.
//
// File lifecycle modules call these helpers. So this module must not import `files_nodes.ts`, or
// the imports would form a cycle.

import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { internalMutation, type MutationCtx } from "./_generated/server.js";
import { files_db_resolve_scope } from "./files_scopes.ts";
import { organizations_is_global_organization_id } from "../shared/organizations.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";
import { files_table_updated_by_text } from "../shared/files-table.ts";
import { should_never_happen } from "../shared/shared-utils.ts";
import { users_SYSTEM_AUTHOR } from "../shared/users.ts";

const DRAIN_USER_NAME_BATCH_SIZE = 100;

/**
 * Sort key of a user's current name. A missing user or profile sorts as "Unknown", like the cell.
 */
async function db_read_sort_user_name(ctx: MutationCtx, userId: Id<"users">) {
	const user = await ctx.db.get("users", userId);
	const anagraphic = user?.anagraphic ? await ctx.db.get("users_anagraphics", user.anagraphic) : null;
	return files_sort_text_key(files_table_updated_by_text(anagraphic?.displayName ?? null));
}

/**
 * Make the updater sort doc of one file node match the node. Call it after every write that can
 * change the node's updater, parent, name, kind, archive state or restricted root. It reads the
 * node itself, so it always copies the node as it is after that write.
 *
 * A new doc or a new updater reads the updater's current name. Otherwise the doc keeps its key, and a
 * name change reaches it through the name drain, so the key can lag behind the name a cell shows.
 */
export async function files_updated_by_db_sync_node(ctx: MutationCtx, args: { nodeId: Id<"files_nodes"> }) {
	const [node, existing] = await Promise.all([
		ctx.db.get("files_nodes", args.nodeId),
		ctx.db
			.query("files_updated_by_docs")
			.withIndex("by_fileNode", (q) => q.eq("fileNodeId", args.nodeId))
			.first(),
	]);

	// A deleted node keeps no doc. SYSTEM writes only the GLOBAL and plugin volume trees, which the
	// folder table never lists.
	if (!node || node.updatedBy === users_SYSTEM_AUTHOR) {
		if (existing) {
			await ctx.db.delete("files_updated_by_docs", existing._id);
		}
		return;
	}

	const { organizationId } = node;
	const scope = files_db_resolve_scope(ctx, node.workspaceId);
	if (organizations_is_global_organization_id(organizationId) || scope.kind !== "workspace") {
		const errorMessage = "A real user updated a file node outside a workspace";
		const errorData = { nodeId: node._id, organizationId, workspaceId: node.workspaceId };
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}

	const fields = {
		organizationId,
		workspaceId: scope.workspaceId,
		fileNodeId: node._id,
		userId: node.updatedBy,
		archiveOperationId: node.archiveOperationId ?? undefined,
		parentId: node.parentId,
		nodeKind: node.kind,
		isRestrictedScopeRoot: node.restrictedScopeNodeId === node._id,
		name: node.name,
		sortName: files_sort_text_key(node.name),
		// The name drain owns name changes, so the same updater keeps its key. This saves two reads per
		// node in big moves and archives, which run close to Convex's per-transaction read limit.
		sortUserName:
			existing?.userId === node.updatedBy
				? existing.sortUserName
				: await db_read_sort_user_name(ctx, node.updatedBy),
	};

	if (!existing) {
		await ctx.db.insert("files_updated_by_docs", fields);
		return;
	}
	if (Object.entries(fields).every(([key, value]) => existing[key as keyof typeof fields] === value)) {
		return;
	}
	// `patch` removes `archiveOperationId` when it is undefined, so a restored node's doc is active again.
	await ctx.db.patch("files_updated_by_docs", existing._id, fields);
}

/**
 * Delete the updater sort doc of one file node, if it has one.
 */
export async function files_updated_by_db_delete_for_node(ctx: MutationCtx, args: { nodeId: Id<"files_nodes"> }) {
	const doc = await ctx.db
		.query("files_updated_by_docs")
		.withIndex("by_fileNode", (q) => q.eq("fileNodeId", args.nodeId))
		.first();
	if (doc) {
		await ctx.db.delete("files_updated_by_docs", doc._id);
	}
}

/**
 * Name drain. Copy a user's current name into the sort key of every doc they updated, one batch per
 * run. It keeps no cursor: each run reads the name again and takes only the docs whose key differs,
 * so a rename during the drain and a rerun of a finished drain are both safe.
 */
export const drain_user_name = internalMutation({
	args: {
		userId: v.id("users"),
		_test_batchSize: v.optional(v.number()),
		_test_disableReschedule: v.optional(v.boolean()),
	},
	returns: v.object({ patchedCount: v.number() }),
	handler: async (ctx, args) => {
		const batchSize = Math.max(
			1,
			Math.min(args._test_batchSize ?? DRAIN_USER_NAME_BATCH_SIZE, DRAIN_USER_NAME_BATCH_SIZE),
		);
		const sortUserName = await db_read_sort_user_name(ctx, args.userId);

		// Stale keys sit below or above the current key in `by_user_sort`. Patched docs leave both ranges.
		const below = await ctx.db
			.query("files_updated_by_docs")
			.withIndex("by_user_sort", (q) => q.eq("userId", args.userId).lt("sortUserName", sortUserName))
			.take(batchSize);
		const above =
			below.length < batchSize
				? await ctx.db
						.query("files_updated_by_docs")
						.withIndex("by_user_sort", (q) => q.eq("userId", args.userId).gt("sortUserName", sortUserName))
						.take(batchSize - below.length)
				: [];
		const staleDocs = [...below, ...above];
		await Promise.all(staleDocs.map((doc) => ctx.db.patch("files_updated_by_docs", doc._id, { sortUserName })));

		if (staleDocs.length > 0 && !args._test_disableReschedule) {
			await ctx.scheduler.runAfter(0, internal.files_updated_by.drain_user_name, {
				userId: args.userId,
				_test_batchSize: args._test_batchSize,
			});
		}
		return { patchedCount: staleDocs.length };
	},
});
