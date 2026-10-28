import { Migrations } from "@convex-dev/migrations";
import { ConvexError, v } from "convex/values";
import type { Doc } from "./_generated/dataModel.js";
import { components, internal } from "./_generated/api.js";
import { internalMutation } from "./functions.ts";
import app_convex_schema from "./schema.ts";

// The schema lets a migration read through an index with `customRange`.
const app_migrations = new Migrations(components.migrations, {
	internalMutation,
	schema: app_convex_schema,
});

function strip_copy_policy(copiedFrom: NonNullable<Doc<"files_pending_updates">["copiedFrom"]>) {
	if (copiedFrom.sourceWritePolicy === undefined && copiedFrom.sourceNewChildWritePolicy === undefined) return;
	const {
		sourceWritePolicy: _sourceWritePolicy,
		sourceNewChildWritePolicy: _sourceNewChildWritePolicy,
		...next
	} = copiedFrom;
	return next;
}

// Run only after old actions and old-format work have drained. These patches keep current fields intact.
export const strip_read_only_nodes = app_migrations.define({
	table: "files_nodes",
	migrateOne: async (ctx, node) => {
		if (node.writePolicy === undefined && node.newChildWritePolicy === undefined) return;
		await ctx.db.patch("files_nodes", node._id, { writePolicy: undefined, newChildWritePolicy: undefined });
	},
});

export const strip_read_only_move_items = app_migrations.define({
	table: "files_move_cohort_items",
	migrateOne: async (ctx, item) => {
		if (!item.afterProposal?.copiedFrom) return;
		const copiedFrom = strip_copy_policy(item.afterProposal.copiedFrom);
		if (copiedFrom) {
			await ctx.db.patch("files_move_cohort_items", item._id, { afterProposal: { ...item.afterProposal, copiedFrom } });
		}
	},
});

export const strip_read_only_review_items = app_migrations.define({
	table: "files_pending_update_run_items",
	migrateOne: async (ctx, item) => {
		if (!item.reviewHeader?.copiedFrom) return;
		const copiedFrom = strip_copy_policy(item.reviewHeader.copiedFrom);
		if (copiedFrom) {
			await ctx.db.patch("files_pending_update_run_items", item._id, { reviewHeader: { ...item.reviewHeader, copiedFrom } });
		}
	},
});

export const strip_read_only_proposals = app_migrations.define({
	table: "files_pending_updates",
	migrateOne: async (ctx, proposal) => {
		if (!proposal.copiedFrom) return;
		const copiedFrom = strip_copy_policy(proposal.copiedFrom);
		if (copiedFrom) await ctx.db.patch("files_pending_updates", proposal._id, { copiedFrom });
	},
});

export const strip_read_only_publish_receipts = app_migrations.define({
	table: "files_pending_node_publish_receipts",
	migrateOne: async (ctx, receipt) => {
		if (receipt.copiedWritePolicy === undefined) return;
		await ctx.db.patch("files_pending_node_publish_receipts", receipt._id, { copiedWritePolicy: undefined });
	},
});

export const strip_read_only_transfer_items = app_migrations.define({
	table: "files_transfer_items",
	migrateOne: async (ctx, item) => {
		if (item.outputWritePolicy === undefined) return;
		await ctx.db.patch("files_transfer_items", item._id, { outputWritePolicy: undefined });
	},
});

export const strip_read_only_bulk_runs = app_migrations.define({
	table: "files_write_policy_runs",
	migrateOne: async (ctx, run) => {
		if (run.writePolicy === undefined) return;
		await ctx.db.patch("files_write_policy_runs", run._id, { writePolicy: undefined });
	},
});

const read_only_strips = {
	nodes: internal.migrations.strip_read_only_nodes,
	move_items: internal.migrations.strip_read_only_move_items,
	review_items: internal.migrations.strip_read_only_review_items,
	proposals: internal.migrations.strip_read_only_proposals,
	publish_receipts: internal.migrations.strip_read_only_publish_receipts,
	transfer_items: internal.migrations.strip_read_only_transfer_items,
	bulk_runs: internal.migrations.strip_read_only_bulk_runs,
};

export const run_strip_read_only = app_migrations.runner(Object.values(read_only_strips));

// Roll back a real batch without the component dry-run's before/after doc logs.
export const preview_read_only_strip = internalMutation({
	args: {
		migration: v.union(
			v.literal("nodes"), v.literal("move_items"), v.literal("review_items"), v.literal("proposals"),
			v.literal("publish_receipts"), v.literal("transfer_items"), v.literal("bulk_runs"),
		),
		cursor: v.union(v.string(), v.null()),
		batchSize: v.number(),
	},
	returns: v.null(),
	handler: async (ctx, args): Promise<null> => {
		const result = await ctx.runMutation(read_only_strips[args.migration], {
			oneBatchOnly: true, dryRun: false, cursor: args.cursor, batchSize: args.batchSize,
		});
		const metrics = await ctx.meta.getTransactionMetrics();
		throw new ConvexError({ kind: "READ_ONLY_STRIP_PREVIEW", result, metrics });
	},
});

/**
 * Run from packages/app: `vp env exec pnpm exec convex run migrations:run_<migration_name>`.
 */
export const run = app_migrations.runner();
