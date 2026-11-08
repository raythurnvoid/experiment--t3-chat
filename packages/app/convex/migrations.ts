import { Migrations } from "@convex-dev/migrations";
import { v } from "convex/values";
import { components, internal } from "./_generated/api.js";
import { internalMutation } from "./functions.ts";
import app_convex_schema from "./schema.ts";
import { files_ROOT_ID } from "../shared/files.ts";

// The schema lets a migration read through an index with `customRange`.
const app_migrations = new Migrations(components.migrations, {
	internalMutation,
	schema: app_convex_schema,
});

/**
 * Run from packages/app: `vp env exec pnpm exec convex run migrations:run_<migration_name>`.
 */
export const run = app_migrations.runner();

// Remove this one-time backfill, its runner and its preview after the audit.
export const backfill_files_nodes_archive_top_node_id = app_migrations.define({
	table: "files_nodes",
	batchSize: 500,
	migrateOne: async (ctx, node) => {
		if (node.archiveOperationId === null || node.archiveTopNodeId !== undefined) return;
		// Go up while the folder is in Trash with the same delete. A folder that has its top already gives it.
		let top = node;
		while (top.parentId !== files_ROOT_ID) {
			const parent = await ctx.db.get("files_nodes", top.parentId);
			if (parent?.archiveOperationId !== node.archiveOperationId) break;
			if (parent.archiveTopNodeId !== undefined) {
				await ctx.db.patch("files_nodes", node._id, { archiveTopNodeId: parent.archiveTopNodeId });
				return;
			}
			top = parent;
		}
		await ctx.db.patch("files_nodes", node._id, { archiveTopNodeId: top._id });
	},
});

export const run_backfill_files_nodes_archive_top_node_id = app_migrations.runner(
	internal.migrations.backfill_files_nodes_archive_top_node_id,
);

// The component's dry run prints full documents. Roll back here with counts only.
export const preview_backfill_files_nodes_archive_top_node_id = internalMutation({
	args: { cursor: v.union(v.string(), v.null()) },
	returns: v.null(),
	handler: async (ctx, args) => {
		const result = await ctx.runMutation(internal.migrations.backfill_files_nodes_archive_top_node_id, {
			oneBatchOnly: true,
			dryRun: false,
			cursor: args.cursor,
			batchSize: 500,
		});
		throw new Error(JSON.stringify({ preview: true, ...result }));
	},
});
