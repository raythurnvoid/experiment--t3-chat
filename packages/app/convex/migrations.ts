import { Migrations } from "@convex-dev/migrations";
import { components, internal } from "./_generated/api.js";
import { internalMutation } from "./functions.ts";
import app_convex_schema from "./schema.ts";
import { files_share_rows_db_sync_grant } from "../server/files-share-rows.ts";

// The schema lets a migration read through an index with `customRange`.
const app_migrations = new Migrations(components.migrations, {
	internalMutation,
	schema: app_convex_schema,
});

/**
 * Sync the share rows of every file `content.read` grant, in every workspace, the way the overlay
 * flush does: a row written before `treePath` existed gets it, and a service account grant gets its
 * row. A grant whose rows already match writes nothing, so a rerun writes nothing. Audit each
 * workspace with `files_pending_overlay:check_share_rows`.
 *
 * Temporary: after the audit finds no difference, remove this backfill, its runner and its test, and
 * make `files_share_rows.treePath` required.
 */
export const backfill_files_share_rows_tree_path = app_migrations.define({
	table: "access_control_permission_grants",
	// A grant reads its node, a Move's two places and its rows, and writes up to two rows.
	batchSize: 50,
	migrateOne: async (ctx, grant) => {
		if (grant.resourceKind !== "file" || grant.permission !== "content.read") return;
		await files_share_rows_db_sync_grant(ctx.db, grant._id);
	},
});

/** Run migrations from the CLI: `pnpx convex run migrations:run_<migration_name>` (cwd: packages/app). */
export const run = app_migrations.runner();
export const run_backfill_files_share_rows_tree_path = app_migrations.runner(
	internal.migrations.backfill_files_share_rows_tree_path,
);
