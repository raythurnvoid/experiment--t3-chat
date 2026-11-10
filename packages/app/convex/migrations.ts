import { Migrations } from "@convex-dev/migrations";
import { v } from "convex/values";
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

// TODO(migration): one-time. Trash items are frozen, so a Rename never starts in Trash, and no subtree
// op has the "move" kind any more. Run `run_remove_trash_freeze_leftovers` after the push. Check that no
// `files_transfer_runs` doc holds `rename.source.archiveOperationId` or `rename.parentArchiveOperationId`,
// and no `activities` doc holds `source.opKind`. Then remove this code and the optional schema fields.

export const remove_files_transfer_runs_rename_archive_fields = app_migrations.define({
	table: "files_transfer_runs",
	batchSize: 10,
	migrateOne: async (ctx, run) => {
		if (!run.rename) return;
		const { parentArchiveOperationId, ...rename } = run.rename;
		const { archiveOperationId, ...source } = rename.source;
		if (parentArchiveOperationId === undefined && archiveOperationId === undefined) return;
		await ctx.db.patch("files_transfer_runs", run._id, { rename: { ...rename, source } });
	},
});

export const remove_activities_subtree_op_kind = app_migrations.define({
	table: "activities",
	batchSize: 10,
	migrateOne: async (ctx, activity) => {
		if (activity.source.kind !== "files_subtree_op" || activity.source.opKind === undefined) return;
		const { opKind: _opKind, ...source } = activity.source;
		await ctx.db.patch("activities", activity._id, { source });
	},
});

/**
 * Preview one batch without logging private docs. The throw rolls back the nested writes.
 * Remove with these one-time migrations after the audit.
 */
export const preview_remove_trash_freeze_leftovers = internalMutation({
	args: {
		migration: v.union(v.literal("rename"), v.literal("activities")),
		cursor: v.union(v.string(), v.null()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const result: { continueCursor: string; isDone: boolean; processed: number } = await ctx.runMutation(
			args.migration === "rename"
				? internal.migrations.remove_files_transfer_runs_rename_archive_fields
				: internal.migrations.remove_activities_subtree_op_kind,
			{ cursor: args.cursor, batchSize: 10, oneBatchOnly: true, dryRun: false },
		);
		const metrics = await ctx.meta.getTransactionMetrics();
		const cost = Object.fromEntries(
			(
				[
					"bytesRead",
					"bytesWritten",
					"documentsRead",
					"documentsWritten",
					"databaseQueries",
					"functionsScheduled",
				] as const
			).map((name) => [name, { used: metrics[name].used, remaining: metrics[name].remaining }]),
		);
		throw new Error(JSON.stringify({ preview: "trash_freeze", ...result, cost }));
	},
});

/**
 * Run the two migrations above one after the other.
 *
 * Run from the repository root: `vp env exec pnpm --dir packages/app exec convex run "migrations:run_remove_trash_freeze_leftovers"`.
 */
export const run_remove_trash_freeze_leftovers = app_migrations.runner([
	internal.migrations.remove_files_transfer_runs_rename_archive_fields,
	internal.migrations.remove_activities_subtree_op_kind,
]);
