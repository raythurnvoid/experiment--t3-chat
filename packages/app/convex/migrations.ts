import { Migrations } from "@convex-dev/migrations";
import { components, internal } from "./_generated/api.js";
import { internalMutation } from "./functions.ts";
import { organizations_member_names_db_fields } from "./organizations_member_names.ts";
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

export const backfill_member_display_name = app_migrations.define({
	table: "organizations_workspaces_users",
	migrateOne: async (ctx, membership) => {
		if (membership.displayName !== undefined) return;
		await ctx.db.patch(
			"organizations_workspaces_users",
			membership._id,
			await organizations_member_names_db_fields(ctx, membership.userId),
		);
	},
});

export const run_backfill_member_display_name = app_migrations.runner(
	internal.migrations.backfill_member_display_name,
);
