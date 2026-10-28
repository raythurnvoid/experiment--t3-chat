import { Migrations } from "@convex-dev/migrations";
import { components, internal } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel.js";
import { ConvexError, v } from "convex/values";
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

// Temporary phase A. Preserve all remaining docs and keep old fields authoritative.
function copied_read_only(copiedFrom: Doc<"files_pending_updates">["copiedFrom"]) {
	if (!copiedFrom || copiedFrom.sourceWritePolicy === undefined) return copiedFrom;
	const sourceReadOnly = copiedFrom.sourceWritePolicy !== null;
	if (copiedFrom.sourceReadOnly !== undefined && copiedFrom.sourceReadOnly !== sourceReadOnly)
		throw new Error("The captured Read-only value does not match the old rule");
	return copiedFrom.sourceReadOnly === undefined ? { ...copiedFrom, sourceReadOnly } : copiedFrom;
}

function no_force(force: boolean | undefined) {
	if (force === true) throw new Error("An old operation cannot gain force during migration");
	return force === undefined ? { force: false } : {};
}

export const backfill_read_only_nodes = app_migrations.define({
	table: "files_nodes",
	batchSize: 25,
	migrateOne: (_ctx, node) => {
		const readOnly = node.writePolicy !== null;
		if (node.readOnly !== undefined || node.readOnlyDecisionId !== undefined) {
			if (
				node.readOnly !== readOnly ||
				(readOnly
					? typeof node.readOnlyDecisionId !== "string" || node.readOnlyDecisionId.length === 0
					: node.readOnlyDecisionId !== null)
			)
				throw new Error("The Read-only decision does not match the old rule");
			return;
		}
		return { readOnly, readOnlyDecisionId: readOnly ? crypto.randomUUID() : null };
	},
});

export const backfill_read_only_pending = app_migrations.define({
	table: "files_pending_updates",
	batchSize: 25,
	migrateOne: (_ctx, proposal) => {
		const copiedFrom = copied_read_only(proposal.copiedFrom);
		if (copiedFrom !== proposal.copiedFrom) return { copiedFrom };
	},
});

export const backfill_read_only_cohort_items = app_migrations.define({
	table: "files_move_cohort_items",
	batchSize: 25,
	migrateOne: (_ctx, item) => {
		if (!item.afterProposal) return;
		const copiedFrom = copied_read_only(item.afterProposal.copiedFrom);
		if (copiedFrom !== item.afterProposal.copiedFrom)
			return { afterProposal: { ...item.afterProposal, copiedFrom } };
	},
});

export const backfill_read_only_review_items = app_migrations.define({
	table: "files_pending_update_run_items",
	batchSize: 25,
	migrateOne: (_ctx, item) => {
		if (!item.reviewHeader) return;
		const copiedFrom = copied_read_only(item.reviewHeader.copiedFrom);
		if (copiedFrom !== item.reviewHeader.copiedFrom)
			return { reviewHeader: { ...item.reviewHeader, copiedFrom } };
	},
});

export const backfill_read_only_transfers = app_migrations.define({
	table: "files_transfer_runs",
	batchSize: 25,
	migrateOne: (_ctx, run) => no_force(run.force),
});

export const backfill_read_only_bulk_runs = app_migrations.define({
	table: "files_write_policy_runs",
	batchSize: 25,
	migrateOne: (_ctx, run) => {
		const targetReadOnly = run.writePolicy !== null;
		if (run.targetReadOnly !== undefined && run.targetReadOnly !== targetReadOnly)
			throw new Error("The bulk Read-only value does not match the old rule");
		if (run.targetReadOnly === undefined) return { targetReadOnly };
	},
});

export const backfill_read_only_archives = app_migrations.define({
	table: "files_archive_runs",
	batchSize: 25,
	migrateOne: (_ctx, run) => no_force(run.force),
});

export const backfill_read_only_restore_items = app_migrations.define({
	table: "files_archive_run_items",
	batchSize: 25,
	migrateOne: (_ctx, item) => {
		if (item.kind === undefined) return { kind: "restore" as const };
	},
});

export const backfill_read_only_write_stages = app_migrations.define({
	table: "public_api_file_write_stages",
	batchSize: 25,
	migrateOne: (_ctx, stage) => {
		const force = no_force(stage.force);
		const externalFileWrite = stage.externalFileWrite
			? { ...stage.externalFileWrite, ...no_force(stage.externalFileWrite.force) }
			: undefined;
		if (
			stage.requestReadOnly !== undefined &&
			externalFileWrite !== undefined &&
			stage.requestReadOnly !== externalFileWrite.requestReadOnly
		)
			throw new Error("The staged Read-only intent does not match its receipt");
		// An old plain stage did not record this intent. Its action must finish before B.
		return {
			...force,
			...(externalFileWrite ? { externalFileWrite } : {}),
			...(stage.requestReadOnly === undefined && externalFileWrite
				? { requestReadOnly: externalFileWrite.requestReadOnly }
				: {}),
		};
	},
});

export const backfill_read_only_service_targets = app_migrations.define({
	table: "plugin_service_storage_targets",
	batchSize: 25,
	migrateOne: (_ctx, target) => no_force(target.force),
});

const read_only_migrations = {
	nodes: internal.migrations.backfill_read_only_nodes,
	pending: internal.migrations.backfill_read_only_pending,
	cohort_items: internal.migrations.backfill_read_only_cohort_items,
	review_items: internal.migrations.backfill_read_only_review_items,
	transfers: internal.migrations.backfill_read_only_transfers,
	bulk_runs: internal.migrations.backfill_read_only_bulk_runs,
	archives: internal.migrations.backfill_read_only_archives,
	restore_items: internal.migrations.backfill_read_only_restore_items,
	write_stages: internal.migrations.backfill_read_only_write_stages,
	service_targets: internal.migrations.backfill_read_only_service_targets,
};

export const run_backfill_read_only = app_migrations.runner(Object.values(read_only_migrations));

// Component dryRun logs whole docs. Roll back one real batch and expose only counts instead.
export const preview_read_only = internalMutation({
	args: {
		migration: v.union(
			v.literal("nodes"), v.literal("pending"), v.literal("cohort_items"), v.literal("review_items"),
			v.literal("transfers"), v.literal("bulk_runs"), v.literal("archives"), v.literal("restore_items"),
			v.literal("write_stages"), v.literal("service_targets"),
		),
		cursor: v.union(v.string(), v.null()),
		batchSize: v.number(),
	},
	returns: v.null(),
	handler: async (ctx, args): Promise<null> => {
		const result = await ctx.runMutation(read_only_migrations[args.migration], {
			oneBatchOnly: true,
			dryRun: false,
			cursor: args.cursor,
			batchSize: args.batchSize,
		});
		const metrics = await ctx.meta.getTransactionMetrics();
		throw new ConvexError({ kind: "READ_ONLY_PREVIEW", result, metrics });
	},
});
