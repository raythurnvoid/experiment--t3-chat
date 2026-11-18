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

export const strip_files_slot_generations = app_migrations.define({
	table: "files_move_workspace_slots",
	batchSize: 8,
	migrateOne: async (ctx, slot) => {
		if (slot.generation !== undefined || ("placementGeneration" in slot && slot.placementGeneration !== undefined))
			await ctx.db.patch("files_move_workspace_slots", slot._id, {
				generation: undefined,
				placementGeneration: undefined,
			});
	},
});

export const strip_move_slot_generation = app_migrations.define({
	table: "files_move_cohorts",
	batchSize: 8,
	migrateOne: async (ctx, cohort) => {
		if (cohort.slotGeneration !== undefined)
			await ctx.db.patch("files_move_cohorts", cohort._id, { slotGeneration: undefined });
	},
});

export const backfill_index_admitted = app_migrations.define({
	table: "files_index_runs",
	batchSize: 8,
	migrateOne: async (ctx, run) => {
		if (run.admitted === undefined || run.slotGeneration !== undefined)
			await ctx.db.patch("files_index_runs", run._id, {
				admitted: run.admitted ?? run.slotGeneration != null,
				slotGeneration: undefined,
			});
	},
});

export const strip_archive_ending_generation = app_migrations.define({
	table: "files_archive_runs",
	batchSize: 8,
	migrateOne: async (ctx, run) => {
		if (run.ending?.generation === undefined) return;
		const { generation: _generation, ...ending } = run.ending;
		await ctx.db.patch("files_archive_runs", run._id, { ending });
	},
});

export const run_files_slot_cleanup = app_migrations.runner([
	internal.migrations.backfill_index_admitted,
	internal.migrations.strip_move_slot_generation,
	internal.migrations.strip_archive_ending_generation,
	internal.migrations.strip_files_slot_generations,
]);
