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

/**
 * Temporary: erase the old `pendingUpdateCleanup` field. No archive job removes proposals any more.
 */
export const erase_files_archive_runs_pending_update_cleanup = app_migrations.define({
	table: "files_archive_runs",
	migrateOne: (_ctx, run) => {
		if (run.pendingUpdateCleanup === undefined) return;
		return { pendingUpdateCleanup: undefined };
	},
});

export const run_erase_files_archive_runs_pending_update_cleanup = app_migrations.runner(
	internal.migrations.erase_files_archive_runs_pending_update_cleanup,
);
