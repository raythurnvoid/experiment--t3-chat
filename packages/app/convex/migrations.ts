import { Migrations } from "@convex-dev/migrations";
import { v } from "convex/values";
import { components } from "./_generated/api.js";
import { internalMutation } from "./functions.ts";
import app_convex_schema from "./schema.ts";
import { v_result } from "../server/convex-utils.ts";
import { Result } from "common/errors-as-values-utils.ts";

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
 * Switch one audited installation after its live runs finish. This is not a table backfill.
 */
export const switch_plugin_file_access = internalMutation({
	args: { installationId: v.id("plugins_workspace_installations") },
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const installation = await ctx.db.get("plugins_workspace_installations", args.installationId);
		if (!installation) return Result({ _nay: { message: "Not found" } });
		if (installation.fileAccessModel === "personal") return Result({ _yay: null });
		// A queued old run must keep its original writes until it ends.
		for (const status of ["queued", "running", "awaiting_input", "stopping"] as const) {
			const active = await ctx.db
				.query("activities")
				.withIndex("by_source_installation_status", (q) =>
					q.eq("source.installationId", installation._id).eq("status", status),
				)
				.first();
			if (active) {
				return Result({ _nay: { message: "Wait for this plugin's current runs to finish, then try again." } });
			}
		}
		await ctx.db.patch("plugins_workspace_installations", installation._id, { fileAccessModel: "personal" });
		return Result({ _yay: null });
	},
});
