import { Migrations } from "@convex-dev/migrations";
import { components } from "./_generated/api.js";
import { internalMutation } from "./functions.ts";
import app_convex_schema from "./schema.ts";

// The schema lets a migration read through an index with `customRange`.
const app_migrations = new Migrations(components.migrations, {
	internalMutation,
	schema: app_convex_schema,
});

/** Run migrations from the CLI: `pnpx convex run migrations:run_<migration_name>` (cwd: packages/app). */
export const run = app_migrations.runner();
