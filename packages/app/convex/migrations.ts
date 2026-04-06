import { Migrations } from "@convex-dev/migrations";
import { components } from "./_generated/api.js";
import type { DataModel } from "./_generated/dataModel.js";
import { internalMutation } from "./_generated/server.js";

const app_migrations = new Migrations<DataModel>(components.migrations, {
	internalMutation,
});

/** Run migrations from the CLI: `pnpm exec convex run migrations:run -- ...` (cwd: packages/app). */
export const run = app_migrations.runner();
