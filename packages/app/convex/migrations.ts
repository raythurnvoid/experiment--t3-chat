import { Migrations } from "@convex-dev/migrations";
import { ConvexError, v } from "convex/values";
import { components, internal } from "./_generated/api.js";
import { internalMutation } from "./functions.ts";
import app_convex_schema from "./schema.ts";
import { files_content_heads_db_backfill } from "../server/files-content-heads.ts";
import {
	files_move_content_consumed_resources,
	files_move_content_retained_state_ids,
} from "./files_move_content_db.ts";
import { should_never_happen } from "../shared/shared-utils.ts";

const CONTENT_HEAD_BATCH_SIZE = 20;

// The schema lets a migration read through an index with `customRange`.
const app_migrations = new Migrations(components.migrations, {
	internalMutation,
	schema: app_convex_schema,
});

export const backfill_content_head_nodes = app_migrations.define({
	table: "files_nodes",
	batchSize: CONTENT_HEAD_BATCH_SIZE,
	migrateOne: async (ctx, doc) => {
		await files_content_heads_db_backfill(ctx, "files_nodes", doc._id);
	},
});

export const backfill_content_head_review = app_migrations.define({
	table: "files_move_cohort_content",
	batchSize: CONTENT_HEAD_BATCH_SIZE,
	migrateOne: async (ctx, doc) => {
		await files_content_heads_db_backfill(ctx, "files_move_cohort_content", doc._id);
		if (doc.consumedResources !== undefined || !doc.sealed) return;
		if (doc.phaseCursor === "finish:done" || doc.phaseCursor === "abort:done") {
			await ctx.db.patch("files_move_cohort_content", doc._id, { consumedResources: [] });
			return;
		}
		const [proposal, item] = await Promise.all([
			ctx.db.get("files_pending_updates", doc.pendingUpdateId),
			ctx.db.get("files_move_cohort_items", doc.itemId),
		]);
		if (!proposal || proposal.revision !== doc.reviewedRevision || !item)
			throw should_never_happen("Content migration lost the reviewed proposal", { contentId: doc._id });
		await ctx.db.patch("files_move_cohort_content", doc._id, {
			consumedResources: files_move_content_consumed_resources(
				proposal,
				files_move_content_retained_state_ids(item.afterProposal),
			),
		});
	},
});

export const backfill_content_head_places = app_migrations.define({
	table: "files_saved_places",
	batchSize: CONTENT_HEAD_BATCH_SIZE,
	migrateOne: async (ctx, doc) => {
		await files_content_heads_db_backfill(ctx, "files_saved_places", doc._id);
	},
});

export const backfill_content_head_text = app_migrations.define({
	table: "files_text_chunks",
	batchSize: CONTENT_HEAD_BATCH_SIZE,
	migrateOne: async (ctx, doc) => {
		await files_content_heads_db_backfill(ctx, "files_text_chunks", doc._id);
	},
});

export const backfill_content_head_search = app_migrations.define({
	table: "files_plain_text_chunks",
	batchSize: CONTENT_HEAD_BATCH_SIZE,
	migrateOne: async (ctx, doc) => {
		await files_content_heads_db_backfill(ctx, "files_plain_text_chunks", doc._id);
	},
});

export const backfill_content_head_updates = app_migrations.define({
	table: "files_yjs_updates",
	// One update can hold a full wire-size Yjs payload.
	batchSize: 1,
	migrateOne: async (ctx, doc) => {
		await files_content_heads_db_backfill(ctx, "files_yjs_updates", doc._id);
	},
});

export const backfill_content_head_metadata = app_migrations.define({
	table: "files_metadata_docs",
	batchSize: CONTENT_HEAD_BATCH_SIZE,
	migrateOne: async (ctx, doc) => {
		await files_content_heads_db_backfill(ctx, "files_metadata_docs", doc._id);
	},
});

// The component's dryRun logs private docs. Roll back with only counts, cost, and the next cursor.
export const preview_content_heads = internalMutation({
	args: {
		migration: v.union(
			v.literal("nodes"),
			v.literal("review"),
			v.literal("places"),
			v.literal("text"),
			v.literal("search"),
			v.literal("updates"),
			v.literal("metadata"),
		),
		cursor: v.union(v.string(), v.null()),
		batchSize: v.number(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const migrations = {
			nodes: internal.migrations.backfill_content_head_nodes,
			review: internal.migrations.backfill_content_head_review,
			places: internal.migrations.backfill_content_head_places,
			text: internal.migrations.backfill_content_head_text,
			search: internal.migrations.backfill_content_head_search,
			updates: internal.migrations.backfill_content_head_updates,
			metadata: internal.migrations.backfill_content_head_metadata,
		};
		const result: { processed: number; isDone: boolean; continueCursor: string } | undefined = await ctx.runMutation(
			migrations[args.migration],
			{ oneBatchOnly: true, dryRun: false, cursor: args.cursor, batchSize: args.batchSize },
		);
		if (!result) throw should_never_happen("Content preview returned no batch result");
		const metrics = await ctx.meta.getTransactionMetrics();
		throw new ConvexError({
			processed: result.processed,
			isDone: result.isDone,
			continueCursor: result.continueCursor,
			metrics: {
				bytesRead: { used: metrics.bytesRead.used, remaining: metrics.bytesRead.remaining },
				bytesWritten: { used: metrics.bytesWritten.used, remaining: metrics.bytesWritten.remaining },
				documentsRead: { used: metrics.documentsRead.used, remaining: metrics.documentsRead.remaining },
				documentsWritten: { used: metrics.documentsWritten.used, remaining: metrics.documentsWritten.remaining },
				databaseQueries: { used: metrics.databaseQueries.used, remaining: metrics.databaseQueries.remaining },
			},
		});
	},
});

/**
 * Run from packages/app: `vp env exec pnpm exec convex run migrations:run_<migration_name>`.
 */
export const run = app_migrations.runner();

export const run_backfill_content_heads = app_migrations.runner([
	internal.migrations.backfill_content_head_nodes,
	internal.migrations.backfill_content_head_review,
	internal.migrations.backfill_content_head_places,
	internal.migrations.backfill_content_head_text,
	internal.migrations.backfill_content_head_search,
	internal.migrations.backfill_content_head_updates,
	internal.migrations.backfill_content_head_metadata,
]);
