import { Migrations } from "@convex-dev/migrations";
import { components, internal } from "./_generated/api.js";
import { internalMutation } from "./functions.ts";
import app_convex_schema from "./schema.ts";

// The schema lets a migration read through an index with `customRange`.
const app_migrations = new Migrations(components.migrations, {
	internalMutation,
	schema: app_convex_schema,
});

/**
 * Run from packages/app: `vp env exec pnpm exec convex run migrations:run_<migration_name>`.
 */
export const run = app_migrations.runner();

// TODO(migration): one-time. Nothing reads the top item of each delete any more, so its data goes.
// Run `run_remove_archive_top_node_id` after the push. Check that no `files_nodes` or
// `files_saved_places` doc holds the field. Then delete this region, both optional
// `archiveTopNodeId` schema fields, and the `_archiveTopNodeId` line in `files_tree_db.ts`.

export const remove_files_nodes_archive_top_node_id = app_migrations.define({
	table: "files_nodes",
	batchSize: 500,
	migrateOne: async (ctx, node) => {
		if (node.archiveTopNodeId === undefined) return;
		await ctx.db.patch("files_nodes", node._id, { archiveTopNodeId: undefined });
	},
});

/**
 * Run from the repository root: `vp env exec pnpm --dir packages/app exec convex run "migrations:run_remove_archive_top_node_id"`.
 */
export const run_remove_archive_top_node_id = app_migrations.runner(
	internal.migrations.remove_files_nodes_archive_top_node_id,
);
