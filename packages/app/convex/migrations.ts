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

export const strip_files_pending_hides_time_fields = app_migrations.define({
	table: "files_pending_hides",
	migrateOne: async (ctx, hide) => {
		if (hide.updatedAt === undefined && hide.nodeCreationTime === undefined) return;
		await ctx.db.patch("files_pending_hides", hide._id, { updatedAt: undefined, nodeCreationTime: undefined });
	},
});

export const run_strip_files_pending_hides_time_fields = app_migrations.runner(
	internal.migrations.strip_files_pending_hides_time_fields,
);
