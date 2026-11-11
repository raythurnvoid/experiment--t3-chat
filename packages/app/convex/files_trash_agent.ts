// The agent's `trash` command (`server/bash-trash-command.ts`). Each function checks that the chat still
// reaches the workspace, then reads as the chat's user, with the same rows and access checks as the app's
// Trash view. Guests have no Trash view, so each function refuses them with a message, not an empty page.

import { internalQuery, type QueryCtx } from "./_generated/server.js";
import { internalMutation } from "./functions.ts";
import type { Doc, Id } from "./_generated/dataModel.js";
import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { compareValues, v, type Infer } from "convex/values";
import { Result } from "common/errors-as-values-utils.ts";
import { convex_error, v_result } from "../server/convex-utils.ts";
import { files_db_get_path_access, files_db_get_pending_update } from "../server/files.ts";
import {
	files_saved_placement_db_get_node,
	files_saved_placement_db_get_view,
} from "../server/files-saved-placement.ts";
import { files_saved_stream_db_create } from "../server/files-saved-stream.ts";
import { files_visible_resolve_db_create } from "../server/files-visible-resolve.ts";
import { files_move_reservations_db_check_node_write } from "../server/files-move-reservations.ts";
import { doc } from "convex-helpers/validators";
import app_convex_schema, { ai_chat_workspaces_source_validator } from "./schema.ts";
import { ai_chat_workspaces_db_authorize_file_scope } from "./ai_chat_workspaces.ts";
import { organizations_db_get_membership } from "./organizations_memberships_db.ts";
import { activities_db_get_by_source_id } from "./activities_db.ts";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";
import {
	files_nodes_db_get_tree_reader_for_user,
	files_tree_db_get_list_rows,
	type files_tree_db_Reader,
} from "./files_tree_db.ts";
import { files_tree_db_list_trash_entries } from "./files_tree.ts";
import { files_pending_update_db_settle_archive_row } from "./files_pending_updates.ts";

/**
 * The page size of every list here, like the app's Trash view (`TRASH_ENTRIES_PAGE_MAX_ITEMS`).
 */
const PAGE_MAX_ITEMS = 50;

const GUEST_MESSAGE =
	"Permission denied. Guests have no Trash view. A workspace member can do this, or ask for workspace access.";

const agent_args = {
	userId: v.id("users"),
	membershipId: v.id("organizations_workspaces_users"),
	agentSource: ai_chat_workspaces_source_validator,
};

const kind_validator = doc(app_convex_schema, "files_nodes").fields.kind;

/**
 * One row of a saved Trash list. A locked row has no id and no name of who deleted it, like the Trash
 * view. `job` names a running job of the row's delete. Its Activity id is set only for the user's own job.
 */
const item_validator = v.union(
	v.object({
		locked: v.literal(false),
		nodeId: v.id("files_nodes"),
		kind: kind_validator,
		path: v.string(),
		archiveOperationId: v.union(v.string(), v.null()),
		changedBy: v.string(),
		job: v.union(
			v.null(),
			v.object({
				kind: app_convex_schema.tables.files_archive_runs.validator.fields.kind,
				activityId: v.union(v.id("activities"), v.null()),
			}),
		),
	}),
	v.object({
		locked: v.literal(true),
		kind: kind_validator,
		path: v.string(),
		archiveOperationId: v.union(v.string(), v.null()),
	}),
);

/**
 * One of the user's own draft deletes (`rm`). `path` is the saved path: `get_pending_delete_path` gives
 * the path of the agent's view. `at` is when the agent asked for it. `inTrash` is true when a saved
 * delete (a Save of this draft, or another user's delete) already moved the item to Trash.
 */
const pending_item_validator = v.union(
	v.object({
		locked: v.literal(false),
		nodeId: v.id("files_nodes"),
		pendingUpdateId: v.id("files_pending_updates"),
		kind: kind_validator,
		path: v.string(),
		at: v.number(),
		inTrash: v.boolean(),
	}),
	v.object({
		locked: v.literal(true),
		pendingUpdateId: v.id("files_pending_updates"),
		kind: kind_validator,
		path: v.string(),
		at: v.number(),
		inTrash: v.boolean(),
	}),
);

async function db_get_reader(
	ctx: QueryCtx,
	args: {
		userId: Id<"users">;
		membershipId: Id<"organizations_workspaces_users">;
		agentSource: Infer<typeof ai_chat_workspaces_source_validator>;
	},
) {
	const membership = await organizations_db_get_membership(ctx, args);
	if (!membership) return Result({ _nay: { message: "Not found" } });
	const source = await ai_chat_workspaces_db_authorize_file_scope(ctx, {
		...membership,
		agentSource: args.agentSource,
	});
	if (source._nay) return source;

	const reader = await files_nodes_db_get_tree_reader_for_user(ctx, {
		userAuth: { id: args.userId },
		membershipId: args.membershipId,
	});
	if (!reader) return Result({ _nay: { message: "Not found" } });
	if (!reader.hasWorkspaceRead) return Result({ _nay: { name: "guest", message: GUEST_MESSAGE } });
	return Result({ _yay: reader });
}

/**
 * Check that `area` is a Trash area the reader can open: the open part of the workspace (null) or an
 * active restricted folder. A folder inside an area names the area it lists in, or null when the reader
 * cannot open that area.
 */
async function db_check_area(ctx: QueryCtx, args: { reader: files_tree_db_Reader; area: Id<"files_nodes"> | null }) {
	const { reader, area } = args;
	if (area === null) return Result({ _yay: null });

	const node = await files_saved_placement_db_get_node(ctx.db, area);
	if (
		!node ||
		node.organizationId !== reader.membership.organizationId ||
		node.workspaceId !== reader.membership.workspaceId ||
		node.archiveOperationId !== null
	)
		return Result({ _nay: { message: "No such file or directory" } });
	if (!(await reader.checker.can(node, "content.read"))) return Result({ _nay: { message: "Permission denied" } });
	if (node.kind !== "folder") return Result({ _nay: { name: "not_a_folder", message: "Not a directory" } });
	if (node.restrictedScopeNodeId === node._id) return Result({ _yay: null });

	const outer = node.restrictedScopeNodeId
		? await files_saved_placement_db_get_node(ctx.db, node.restrictedScopeNodeId)
		: null;
	const areaPath =
		node.restrictedScopeNodeId === null
			? "/"
			: outer && (await reader.checker.can(outer, "content.read"))
				? outer.path
				: null;
	return Result({ _nay: { name: "not_an_area", message: "Not a Trash area", data: { areaPath } } });
}

/**
 * Build the agent rows of a saved Trash list. Names and running jobs are read once per page.
 */
async function db_get_items(
	ctx: QueryCtx,
	args: {
		reader: files_tree_db_Reader;
		rows: Awaited<ReturnType<typeof files_tree_db_get_list_rows>>;
		withJobs: boolean;
	},
) {
	const { reader } = args;
	const get_name = async (userId: Id<"users">) => {
		if (userId === reader.userAuth.id) return "you";
		const user = await ctx.db.get("users", userId);
		if (!user || user.deletedAt != null) return "Deleted user";
		const profile = user.anagraphic ? await ctx.db.get("users_anagraphics", user.anagraphic) : null;
		return profile?.displayName ?? "User";
	};
	const get_job = async (archiveOperationId: string) => {
		const run = await ctx.db
			.query("files_archive_runs")
			.withIndex("by_organization_workspace_archiveOperation_active", (q) =>
				q
					.eq("organizationId", reader.membership.organizationId)
					.eq("workspaceId", reader.membership.workspaceId)
					.eq("archiveOperationId", archiveOperationId)
					.eq("active", true),
			)
			.first();
		if (!run) return null;
		// `jobs --activity` reads only the user's own Activities.
		const activity = run.userId === reader.userAuth.id ? await activities_db_get_by_source_id(ctx, run._id) : null;
		return { kind: run.kind, activityId: activity?._id ?? null };
	};
	const names = new Map<Id<"users">, ReturnType<typeof get_name>>();
	const jobs = new Map<string, ReturnType<typeof get_job>>();

	return await Promise.all(
		args.rows.map(async (row) => {
			if (row.locked)
				return { locked: true as const, kind: row.kind, path: row.path, archiveOperationId: row.archiveOperationId };

			let name = names.get(row.updatedBy);
			if (!name) names.set(row.updatedBy, (name = get_name(row.updatedBy)));
			let job = null;
			if (args.withJobs && row.archiveOperationId !== null) {
				let read = jobs.get(row.archiveOperationId);
				if (!read) jobs.set(row.archiveOperationId, (read = get_job(row.archiveOperationId)));
				job = await read;
			}
			return {
				locked: false as const,
				nodeId: row._id,
				kind: row.kind,
				path: row.path,
				archiveOperationId: row.archiveOperationId,
				changedBy: await name,
				job,
			};
		}),
	);
}

/**
 * `trash ls`: the saved Trash entries of one area, in the app's order. The same page as the Trash view
 * (`files_tree_db_list_trash_entries`), so a page can be short or need a split.
 */
export const list_entries = internalQuery({
	args: {
		...agent_args,
		area: v.union(v.null(), v.id("files_nodes")),
		paginationOpts: paginationOptsValidator,
	},
	returns: v_result({
		_yay: paginationResultValidator(item_validator),
		_nay: { data: v.object({ areaPath: v.union(v.string(), v.null()) }) },
	}),
	handler: async (ctx, args) => {
		const reader = await db_get_reader(ctx, args);
		if (reader._nay) return reader;
		const area = await db_check_area(ctx, { reader: reader._yay, area: args.area });
		if (area._nay) return area;

		const result = await files_tree_db_list_trash_entries(ctx, {
			reader: reader._yay,
			area: args.area,
			paginationOpts: { ...args.paginationOpts, numItems: Math.min(args.paginationOpts.numItems, PAGE_MAX_ITEMS) },
		});
		return Result({
			_yay: { ...result, page: await db_get_items(ctx, { reader: reader._yay, rows: result.page, withJobs: true }) },
		});
	},
});

/**
 * `trash ls`: the user's own draft deletes (`rm`) of one area, newest first. They are not in Trash
 * until the user saves them. A draft whose item a saved delete already moved to Trash stays, with
 * `inTrash` set. `pendingArchive.area` is the area the item lists in once saved.
 */
export const list_pending_deletes = internalQuery({
	args: {
		...agent_args,
		area: v.union(v.null(), v.id("files_nodes")),
		paginationOpts: paginationOptsValidator,
	},
	returns: v_result({
		_yay: paginationResultValidator(pending_item_validator),
		_nay: { data: v.object({ areaPath: v.union(v.string(), v.null()) }) },
	}),
	handler: async (ctx, args) => {
		const reader = await db_get_reader(ctx, args);
		if (reader._nay) return reader;
		const area = await db_check_area(ctx, { reader: reader._yay, area: args.area });
		if (area._nay) return area;
		const { membership, checker } = reader._yay;

		const result = await ctx.db
			.query("files_pending_updates")
			.withIndex("by_org_ws_user_pendingArchive_area_at", (q) =>
				q
					.eq("organizationId", membership.organizationId)
					.eq("workspaceId", membership.workspaceId)
					.eq("userId", args.userId)
					.eq("pendingArchive.area", args.area),
			)
			.order("desc")
			.paginate({ ...args.paginationOpts, numItems: Math.min(args.paginationOpts.numItems, PAGE_MAX_ITEMS) });

		const items = [];
		for (const pendingUpdate of result.page) {
			const node =
				pendingUpdate.target.kind === "saved"
					? await files_saved_placement_db_get_node(ctx.db, pendingUpdate.target.id)
					: null;
			if (!node || !pendingUpdate.pendingArchive) continue;

			const row = { pendingUpdateId: pendingUpdate._id, kind: node.kind, path: node.path };
			const at = pendingUpdate.pendingArchive.at;
			// Keep a draft whose item a saved delete moved to Trash, like the "In Trash" row of the Pending
			// tab. Dropping it would make each later page read it again.
			const inTrash = node.archiveOperationId !== null;
			// Access can be taken away after the delete was asked for. Keep the row, locked.
			items.push(
				(await checker.can(node, "content.read"))
					? { locked: false as const, nodeId: node._id, ...row, at, inTrash }
					: { locked: true as const, ...row, at, inTrash },
			);
		}
		return Result({ _yay: { ...result, page: items } });
	},
});

/**
 * `trash ls`: the path of one draft delete in the agent's view, or null when the view has no place for
 * it (a draft move cycle). It differs from the saved path after a draft move of a folder, and
 * `trash restore PATH` looks the item up in that view.
 *
 * The path walk can cost about 1,300 reads for an item 255 folders deep. A page of such rows would not
 * fit in one query, so each row gets its own query, like the Pending tab (`get_file_pending_target`).
 */
export const get_pending_delete_path = internalQuery({
	args: { ...agent_args, pendingUpdateId: v.id("files_pending_updates") },
	returns: v_result({ _yay: v.union(v.string(), v.null()) }),
	handler: async (ctx, args) => {
		const reader = await db_get_reader(ctx, args);
		if (reader._nay) return reader;
		const { membership } = reader._yay;

		const pendingUpdate = await ctx.db.get("files_pending_updates", args.pendingUpdateId);
		if (
			!pendingUpdate?.pendingArchive ||
			pendingUpdate.userId !== args.userId ||
			pendingUpdate.organizationId !== membership.organizationId ||
			pendingUpdate.workspaceId !== membership.workspaceId ||
			pendingUpdate.target.kind !== "saved"
		)
			return Result({ _nay: { name: "not_found", message: "No pending delete" } });

		const resolver = files_visible_resolve_db_create(ctx.db, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: args.userId,
			includeHidden: true,
			readLimit: 2048,
		});
		const resolved = await resolver.resolve(pendingUpdate.target);
		if (resolver.exhausted) throw convex_error({ message: "File path lookup exceeded its read limit." });
		return Result({ _yay: resolved?.entry.path ?? null });
	},
});

/**
 * `trash ls --in ID`: the items inside a folder in Trash that came with the same delete, folders first,
 * then files, each by name. This is what a restore of the folder brings back.
 *
 * Each page reads at most `numItems` docs from each saved source (the normal one, and the Move view
 * while a Move runs) after `afterKey`, so a page costs the same for any folder size. Locked rows stay.
 */
export const list_children = internalQuery({
	args: {
		...agent_args,
		nodeId: v.string(),
		archiveOperationId: v.string(),
		afterKey: v.union(v.null(), v.object({ kind: kind_validator, name: v.string() })),
		numItems: v.number(),
	},
	returns: v_result({
		_yay: v.object({
			page: v.array(item_validator),
			nextKey: v.union(v.null(), v.object({ kind: kind_validator, name: v.string() })),
		}),
	}),
	handler: async (ctx, args) => {
		const reader = await db_get_reader(ctx, args);
		if (reader._nay) return reader;
		const { membership, checker } = reader._yay;

		// Check in this order, so a locked item never tells whether it changed or what kind it is.
		const nodeId = ctx.db.normalizeId("files_nodes", args.nodeId);
		const folder = nodeId ? await files_saved_placement_db_get_node(ctx.db, nodeId) : null;
		if (!folder || folder.organizationId !== membership.organizationId || folder.workspaceId !== membership.workspaceId)
			return Result({ _nay: { name: "not_found", message: "No Trash item" } });
		if (!(await checker.can(folder, "content.read"))) return Result({ _nay: { message: "Permission denied" } });
		if (folder.kind !== "folder") return Result({ _nay: { name: "not_a_folder", message: "Not a directory" } });
		if (folder.archiveOperationId !== args.archiveOperationId)
			return Result({ _nay: { name: "changed", message: "This Trash item changed" } });

		const view = await files_saved_placement_db_get_view(ctx.db, membership);
		const streams = [
			await files_saved_stream_db_create(ctx.db, membership, { kind: "normal", generation: view.generation }),
			...(view.cohortId !== null && view.view !== null
				? [
						await files_saved_stream_db_create(ctx.db, membership, {
							kind: "cohort",
							cohortId: view.cohortId,
							view: view.view,
							generation: view.generation,
						}),
					]
				: []),
		];
		const numItems = Math.max(1, Math.min(args.numItems, PAGE_MAX_ITEMS));
		const nodes: Doc<"files_nodes">[] = [];
		for (const kind of ["folder", "file"] as const) {
			if (args.afterKey?.kind === "file" && kind === "folder") continue;
			const afterName = args.afterKey?.kind === kind ? args.afterKey.name : null;
			const limit = numItems - nodes.length;
			const batches = await Promise.all(
				streams.map(async (stream) =>
					stream.read_nodes(
						await stream.queries
							.by_parent_archive_kind_name((q) => {
								const children = q
									.eq("parentId", folder._id)
									.eq("archiveOperationId", args.archiveOperationId)
									.eq("kind", kind);
								return afterName === null ? children : children.gt("name", afterName);
							})
							.take(limit),
					),
				),
			);
			// A node can show in both sources while a Move stages or cleans up.
			const byId = new Map(batches.flat().map((node) => [node._id, node]));
			// Sort like the index, so the next page starts right after the last name.
			const merged = [...byId.values()].sort((a, b) => compareValues(a.name, b.name)).slice(0, limit);
			nodes.push(...merged);
			if (nodes.length === numItems) break;
		}

		const rows = await files_tree_db_get_list_rows(ctx, {
			userAuth: reader._yay.userAuth,
			membership,
			checker,
			folder,
			fileNodes: nodes,
		});
		const last = nodes.at(-1);
		return Result({
			_yay: {
				page: await db_get_items(ctx, { reader: reader._yay, rows, withJobs: false }),
				nextKey: nodes.length === numItems && last ? { kind: last.kind, name: last.name } : null,
			},
		});
	},
});

/**
 * `trash restore`: undo the user's own draft delete (`rm`) of one item. Like Discard of the delete in
 * the Pending tab, it leaves no Pending row: a doc with only the delete goes away.
 *
 * Pass `path` (the path the agent removed) or `nodeId`.
 */
export const restore_pending_delete = internalMutation({
	args: {
		...agent_args,
		item: v.union(v.object({ path: v.string() }), v.object({ nodeId: v.string() })),
	},
	returns: v_result({ _yay: v.object({ path: v.string(), kind: kind_validator }) }),
	handler: async (ctx, args) => {
		const reader = await db_get_reader(ctx, args);
		if (reader._nay) return reader;
		const { membership, checker } = reader._yay;

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "files_tree_write", key: args.userId });
		if (rateLimit) return Result({ _nay: { message: rateLimit.message } });

		const scope = {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: args.userId,
		};
		// The agent's view hides its own deletes, so find the item with hidden entries too.
		const hiddenResolver = files_visible_resolve_db_create(ctx.db, { ...scope, includeHidden: true });
		let nodeId: Id<"files_nodes"> | null;
		if ("path" in args.item) {
			// Inside a locked folder every path answers Permission denied, whether it exists or not, like `cat`.
			const access = await files_db_get_path_access(ctx, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				subject: { kind: "user", userId: args.userId, plugin: null },
				path: args.item.path,
			});
			if (access.status === "locked") return Result({ _nay: { message: "Permission denied" } });
			const found = await hiddenResolver.findPath(args.item.path);
			// A draft move can put a locked item at a path the check above does not know. Answer for it
			// like for a missing item, like `cat` does, so the answer does not tell that it exists.
			if (!found || (found.accessNode && !(await checker.can(found.accessNode, "content.read"))))
				return Result({ _nay: { name: "not_found", message: "No such file or directory" } });
			if (!found.hidden) return Result({ _nay: { name: "not_deleted", message: "Not in Trash" } });
			nodeId = found.entry.kind === "saved" ? found.entry.node._id : null;
		} else nodeId = ctx.db.normalizeId("files_nodes", args.item.nodeId);
		const node = nodeId ? await ctx.db.get("files_nodes", nodeId) : null;
		if (!node || node.organizationId !== membership.organizationId || node.workspaceId !== membership.workspaceId)
			return Result({ _nay: { name: "not_found", message: "No Trash item" } });
		if (!(await checker.can(node, "content.read"))) return Result({ _nay: { message: "Permission denied" } });

		// A saved delete moved the item to Trash already, or a Save is moving it there now.
		if (node.archiveOperationId !== null) return Result({ _nay: { name: "in_trash", message: "In Trash" } });

		// The item comes back where the agent's view had it before `rm`. Check its folder before its own
		// delete: after `rm -r folder`, a file inside it has no delete of its own, and the agent must
		// restore the folder.
		const target = { kind: "saved" as const, id: node._id };
		const resolved = await hiddenResolver.resolve(target);
		const parent = await hiddenResolver.resolveParent(
			node.parentId === "root" ? { kind: "root" } : { kind: "saved", id: node.parentId },
		);
		if (!resolved || !parent || parent.hidden)
			return Result({ _nay: { name: "parent_hidden", message: "Its folder is deleted too" } });
		const pendingUpdate = await files_db_get_pending_update(ctx, { ...scope, target });
		if (!pendingUpdate?.pendingArchive)
			return Result({ _nay: { name: "no_pending_delete", message: "No pending delete" } });

		// Refuse when another item took its path since.
		const occupant = await files_visible_resolve_db_create(ctx.db, scope).findPath(resolved.entry.path);
		if (occupant) return Result({ _nay: { name: "exists", message: "File exists" } });

		const writable = await files_move_reservations_db_check_node_write(ctx.db, {
			target,
			pendingUpdate,
			membership: true,
		});
		if (writable._nay) return writable;

		await files_pending_update_db_settle_archive_row(ctx, { pendingUpdate });
		return Result({ _yay: { path: resolved.entry.path, kind: node.kind } });
	},
});
