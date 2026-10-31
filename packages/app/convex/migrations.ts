import { Migrations } from "@convex-dev/migrations";
import { files_saved_placement_db_get_node } from "../server/files-saved-placement.ts";
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

/**
 * TODO(migration): one-time. Delete after the run and its audit, when the field becomes required.
 * Copy the flag from the node the row copies (its Move view while a Move holds it).
 */
export const backfill_files_share_rows_isRestrictedScopeRoot = app_migrations.define({
	table: "files_share_rows",
	migrateOne: async (ctx, row) => {
		if (row.isRestrictedScopeRoot !== undefined) return;
		const node = await files_saved_placement_db_get_node(ctx.db, row.nodeId, row.moveView);
		// A row always has its node: the overlay flush deletes the rows with the node.
		await ctx.db.patch("files_share_rows", row._id, { isRestrictedScopeRoot: node!.isRestrictedScopeRoot });
	},
});

export const run_backfill_files_share_rows_isRestrictedScopeRoot = app_migrations.runner(
	internal.migrations.backfill_files_share_rows_isRestrictedScopeRoot,
);
