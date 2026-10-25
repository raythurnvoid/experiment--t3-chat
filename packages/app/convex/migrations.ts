import { Migrations } from "@convex-dev/migrations";
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
