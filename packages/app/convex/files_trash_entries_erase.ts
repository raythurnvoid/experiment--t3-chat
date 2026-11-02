// One-off runner: erase the Trash items deleted before Trash entries existed. They have no entry, so
// no Trash list shows them. Each step reads the next old items of one workspace and starts one Delete
// permanently job as the workspace owner. Remove this module after the audit.
//
// Run from packages/app, right after the deploy and before anyone deletes or restores again:
// `vp env exec pnpm exec convex run files_trash_entries_erase:run '{"cutoff":"<cutoff>","workspaceId":null,"after":null}'`
// The cutoff is "t" and the deploy time in ms, padded to 15 digits (`files_archive_operation_id_cutoff`
// in `shared/files.ts`). Make it with
// `vp env exec node -e "console.log('t' + String(Date.parse('<deploy time ISO>')).padStart(15, '0'))"`.
// The last step logs "Erase of old Trash items is done". Then check each workspace with
// `vp env exec pnpm exec convex run files_trash_entries_erase:audit '{"cutoff":"<cutoff>","workspaceId":"<id>","after":null}'`
// and pass the returned `after` until it is null.
//
// Only the new code writes entries, so a workspace without any entry holds only old Trash items. The
// runner erases a workspace only while it has no entry. It skips a workspace that has one, because an
// item a Move or a restore put in Trash after the deploy can sit inside an old folder, and can have
// an old delete id. It also skips a workspace whose owner has no membership, or whose job did not
// start. Each skip logs a warning, so read the logs before the audit.

import { v, type Infer } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internal } from "./_generated/api.js";
import { internalQuery, type QueryCtx } from "./_generated/server.js";
import { internalMutation } from "./functions.ts";
import { files_archive_runs_db_start_purge } from "./files_archive_runs.ts";
import { files_saved_placement_db_get_view } from "../server/files-saved-placement.ts";
import { files_index_range_apply, files_index_range_phases } from "../server/files-index-range.ts";
import { files_ROOT_ID } from "../shared/files.ts";

const BATCH_SIZE = 50;
const AUDIT_PAGE_SIZE = 100;

const after_validator = v.union(
	v.object({
		archiveOperationId: v.string(),
		treePath: v.string(),
		creationTime: v.number(),
		nodeId: v.id("files_nodes"),
	}),
	v.null(),
);

function after_of(node: Doc<"files_nodes">) {
	return {
		archiveOperationId: node.archiveOperationId!,
		treePath: node.treePath,
		creationTime: node._creationTime,
		nodeId: node._id,
	};
}

/**
 * The next old items in Trash after `after`, by delete id and path. Items a job kept stay behind the
 * cursor, so no step reads them again.
 */
async function db_read_old_nodes(
	ctx: QueryCtx,
	args: {
		workspace: Doc<"organizations_workspaces">;
		cutoff: string;
		after: Infer<typeof after_validator>;
		limit: number;
	},
) {
	const phases = files_index_range_phases({
		fields: ["archiveOperationId", "treePath", "_creationTime", "_id"],
		order: "asc",
		// An active doc has a null `archiveOperationId`, so this range holds the archived docs only.
		start: args.after
			? [args.after.archiveOperationId, args.after.treePath, args.after.creationTime, args.after.nodeId]
			: [null],
		startInclusive: false,
		end: [args.cutoff],
		endInclusive: false,
	});
	const nodes: Doc<"files_nodes">[] = [];
	for (const bounds of phases) {
		if (nodes.length >= args.limit) break;
		nodes.push(
			...(await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_archiveOperation_treePath", (q) =>
					files_index_range_apply(
						q
							.eq("organizationId", args.workspace.organizationId)
							.eq("workspaceId", args.workspace._id)
							.eq("moveCohortId", undefined),
						bounds,
					),
				)
				.take(args.limit - nodes.length)),
		);
	}
	return nodes;
}

async function db_has_entries(ctx: QueryCtx, workspace: Doc<"organizations_workspaces">) {
	const entry = await ctx.db
		.query("files_trash_entries")
		.withIndex("by_org_ws_area_order_path", (q) =>
			q.eq("organizationId", workspace.organizationId).eq("workspaceId", workspace._id),
		)
		.first();
	return entry !== null;
}

export const run = internalMutation({
	args: {
		cutoff: v.string(),
		workspaceId: v.union(v.id("organizations_workspaces"), v.null()),
		/**
		 * The last item the step before read. Null starts the workspace from the first old item.
		 */
		after: after_validator,
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const next_workspace = async () => {
			const workspaceId = args.workspaceId;
			const next = await ctx.db
				.query("organizations_workspaces")
				.withIndex("by_id", (q) => (workspaceId ? q.gt("_id", workspaceId) : q))
				.first();
			if (!next) {
				console.info("Erase of old Trash items is done");
				return;
			}
			await ctx.scheduler.runAfter(0, internal.files_trash_entries_erase.run, {
				cutoff: args.cutoff,
				workspaceId: next._id,
				after: null,
			});
		};

		if (args.workspaceId === null) {
			await next_workspace();
			return null;
		}

		const workspace = await ctx.db.get("organizations_workspaces", args.workspaceId);
		// A workspace can be deleted between two steps.
		if (!workspace) {
			await next_workspace();
			return null;
		}
		const scope = { organizationId: workspace.organizationId, workspaceId: workspace._id };

		// Wait for every job of the workspace, including the Delete permanently job of the last step.
		const op = await ctx.db
			.query("files_subtree_ops")
			.withIndex("by_organization_workspace_kind", (q) =>
				q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId),
			)
			.first();
		if (op || (await files_saved_placement_db_get_view(ctx.db, scope)).cohortId !== null) {
			await ctx.scheduler.runAfter(5_000, internal.files_trash_entries_erase.run, args);
			return null;
		}

		// Check this on every step. Someone may have used Trash since the last step.
		if (await db_has_entries(ctx, workspace)) {
			console.warn("The workspace has Trash entries. Skip it and check it by hand", scope);
			await next_workspace();
			return null;
		}

		const nodes = await db_read_old_nodes(ctx, {
			workspace,
			cutoff: args.cutoff,
			after: args.after,
			limit: BATCH_SIZE,
		});
		if (nodes.length === 0) {
			await next_workspace();
			return null;
		}
		const after = after_of(nodes.at(-1)!);

		// Delete permanently of an item deletes everything inside it, from any delete. So start it only for
		// items whose folder is not in Trash. The others go with their folder's job, or stay with it.
		const roots: Doc<"files_nodes">[] = [];
		for (const node of nodes) {
			const parent = node.parentId === files_ROOT_ID ? null : await ctx.db.get("files_nodes", node.parentId);
			if (parent === null || parent.archiveOperationId === null) roots.push(node);
		}
		if (roots.length === 0) {
			await ctx.scheduler.runAfter(0, internal.files_trash_entries_erase.run, { ...args, after });
			return null;
		}

		const organization = (await ctx.db.get("organizations", scope.organizationId))!;
		const membership = await ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_active_user_organization_workspace", (q) =>
				q
					.eq("active", true)
					.eq("userId", organization.ownerUserId)
					.eq("organizationId", scope.organizationId)
					.eq("workspaceId", scope.workspaceId),
			)
			.first();
		if (!membership) {
			console.warn("The owner has no membership. Skip this workspace", scope);
			await next_workspace();
			return null;
		}
		const started = await files_archive_runs_db_start_purge(ctx, {
			userAuth: { id: organization.ownerUserId },
			membership,
			nodes: roots,
			emptyArchive: null,
		});
		if (started._nay) {
			console.warn("Delete permanently did not start. Skip this workspace", { ...scope, error: started._nay });
			await next_workspace();
			return null;
		}

		await ctx.scheduler.runAfter(5_000, internal.files_trash_entries_erase.run, { ...args, after });
		return null;
	},
});

/**
 * After the run: the old items still in Trash in one workspace, one page per call.
 *
 * Most are items a Delete permanently job kept, for example read-only ones, and their folders. But
 * when the runner skipped the workspace, every old item it had not erased yet is still here. The
 * runner logs a warning for each workspace it skips. `hasEntries` is true when the workspace has
 * Trash entries now.
 */
export const audit = internalQuery({
	args: { cutoff: v.string(), workspaceId: v.id("organizations_workspaces"), after: after_validator },
	returns: v.object({
		hasEntries: v.boolean(),
		items: v.array(v.object({ nodeId: v.id("files_nodes"), path: v.string(), readOnly: v.boolean() })),
		after: after_validator,
	}),
	handler: async (ctx, args) => {
		const workspace = (await ctx.db.get("organizations_workspaces", args.workspaceId))!;
		const nodes = await db_read_old_nodes(ctx, {
			workspace,
			cutoff: args.cutoff,
			after: args.after,
			limit: AUDIT_PAGE_SIZE,
		});
		return {
			hasEntries: await db_has_entries(ctx, workspace),
			items: nodes.map((node) => ({ nodeId: node._id, path: node.path, readOnly: node.readOnly })),
			after: nodes.length < AUDIT_PAGE_SIZE ? null : after_of(nodes.at(-1)!),
		};
	},
});
