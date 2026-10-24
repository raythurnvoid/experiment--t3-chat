import { Migrations } from "@convex-dev/migrations";
import { components, internal } from "./_generated/api.js";
import { internalMutation } from "./functions.ts";
import { internalQuery, type MutationCtx } from "./_generated/server.js";
import type { Doc } from "./_generated/dataModel.js";
import { v } from "convex/values";
import { convex_error } from "../server/convex-utils.ts";
import { files_move_reservations_db_find_blocker } from "../server/files-move-reservations.ts";
import app_convex_schema from "./schema.ts";
import {
	files_pending_content_migration_db_family,
	files_pending_content_migration_versions,
} from "./files_pending_content_migration.ts";

// The schema lets a migration read through an index with `customRange`.
const app_migrations = new Migrations(components.migrations, {
	internalMutation,
	schema: app_convex_schema,
});

/**
 * Run from packages/app: `vp env exec pnpm exec convex run migrations:run_<migration_name>`.
 */
export const run = app_migrations.runner();

async function db_held(ctx: MutationCtx, target: Doc<"files_pending_updates">["target"]) {
	return await files_move_reservations_db_find_blocker(ctx.db, { source: target });
}

export const backfill_pending_content_cohorts = app_migrations.define({
	table: "files_move_cohorts",
	batchSize: 1,
	migrateOne: async (ctx, cohort) => {
		if (cohort.phase === "complete" || cohort.pendingContentVersionReady) return;
		const generation = (cohort.runJob?.generation ?? 0) + 1;
		const id = await ctx.scheduler.runAfter(0, internal.files_move_run.run, {
			cohortId: cohort._id,
			step: cohort.step,
			runGeneration: generation,
			mode: "chain",
		});
		await ctx.db.patch("files_move_cohorts", cohort._id, {
			runJob: { id, step: cohort.step, generation },
			pendingContentMigration: cohort.pendingContentMigration ?? { cursor: null, updatedAt: Date.now() },
		});
	},
});

export const backfill_pending_content_nodes = app_migrations.define({
	table: "files_nodes",
	batchSize: 1,
	migrateOne: async (ctx, row) => {
		if (row.pendingContentVersion !== undefined || (await db_held(ctx, { kind: "saved", id: row._id }))) return;
		await ctx.db.patch("files_nodes", row._id, { pendingContentVersion: 1 });
	},
});
export const backfill_pending_content_places = app_migrations.define({
	table: "files_saved_places",
	batchSize: 1,
	migrateOne: async (ctx, row) => {
		if (row.pendingContentVersion !== undefined) return;
		const cohort = await ctx.db.get("files_move_cohorts", row.cohortId);
		if (cohort && cohort.phase !== "complete") return;
		await ctx.db.patch("files_saved_places", row._id, { pendingContentVersion: 1 });
	},
});
export const backfill_pending_content_families = app_migrations.define({
	table: "files_pending_updates",
	batchSize: 1,
	migrateOne: async (ctx, row) => {
		if (
			row.moveCohortId ||
			(await db_held(ctx, row.target)) ||
			(await files_move_reservations_db_find_blocker(ctx.db, { source: { kind: "proposal", id: row._id } }))
		)
			return;
		const node = row.target.kind === "saved" ? await ctx.db.get("files_nodes", row.target.id) : null;
		await ctx.db.patch("files_pending_updates", row._id, {
			content: await files_pending_content_migration_db_family(ctx, row, node),
			pendingMove: files_pending_content_migration_versions(row.pendingMove),
			pendingReplacement: files_pending_content_migration_versions(row.pendingReplacement),
		});
	},
});
export const backfill_pending_content_batches = app_migrations.define({
	table: "files_pending_update_operation_batches",
	batchSize: 1,
	migrateOne: async (ctx, row) => {
		if (row.expectedPendingContentVersion !== undefined || (await db_held(ctx, row.target))) return;
		await ctx.db.patch("files_pending_update_operation_batches", row._id, {
			expectedPendingContentVersion: row.target.kind === "saved" ? 1 : null,
		});
	},
});
export const backfill_pending_content_markers = app_migrations.define({
	table: "files_pending_updates_last_sequence_saved",
	batchSize: 1,
	migrateOne: async (ctx, row) => {
		if (row.pendingContentVersion !== undefined || (await db_held(ctx, { kind: "saved", id: row.fileNodeId }))) return;
		await ctx.db.patch("files_pending_updates_last_sequence_saved", row._id, { pendingContentVersion: 1 });
	},
});

export const backfill_pending_content_cohort_nodes = app_migrations.define({
	table: "files_move_cohort_nodes",
	batchSize: 1,
	migrateOne: async (ctx, row) => {
		const cohort = await ctx.db.get("files_move_cohorts", row.cohortId);
		if (cohort && cohort.phase !== "complete") return;
		await ctx.db.patch("files_move_cohort_nodes", row._id, {
			sourceContentVersion: files_pending_content_migration_versions(row.sourceContentVersion),
		});
	},
});
export const backfill_pending_content_cohort_items = app_migrations.define({
	table: "files_move_cohort_items",
	batchSize: 1,
	migrateOne: async (ctx, row) => {
		const cohort = await ctx.db.get("files_move_cohorts", row.cohortId);
		if ((cohort && cohort.phase !== "complete") || !row.afterProposal) return;
		const content = row.contentId ? await ctx.db.get("files_move_cohort_content", row.contentId) : null;
		const root = content?.afterContentVersion?.textKind;
		const version =
			content?.afterContentVersion?.kind === "yjs" ? (content.afterContentVersion.pendingContentVersion ?? 1) : 1;
		await ctx.db.patch("files_move_cohort_items", row._id, {
			afterProposal: {
				...files_pending_content_migration_versions(row.afterProposal),
				content: await files_pending_content_migration_db_family(ctx, row.afterProposal, null, version, root),
			},
		});
	},
});
export const backfill_pending_content_cohort_content = app_migrations.define({
	table: "files_move_cohort_content",
	batchSize: 1,
	migrateOne: async (ctx, row) => {
		const cohort = await ctx.db.get("files_move_cohorts", row.cohortId);
		if (cohort && cohort.phase !== "complete") return;
		await ctx.db.patch("files_move_cohort_content", row._id, {
			prepared: files_pending_content_migration_versions(row.prepared),
			beforeContentVersion: files_pending_content_migration_versions(row.beforeContentVersion),
			afterContentVersion: files_pending_content_migration_versions(row.afterContentVersion),
		});
	},
});
export const backfill_pending_content_review_items = app_migrations.define({
	table: "files_pending_update_run_items",
	batchSize: 1,
	migrateOne: async (ctx, row) => {
		const unit = row.unitId ? await ctx.db.get("files_pending_update_run_units", row.unitId) : null;
		const cohort = unit?.cohortId ? await ctx.db.get("files_move_cohorts", unit.cohortId) : null;
		if (cohort && cohort.phase !== "complete") return;
		const item = cohort
			? await ctx.db
					.query("files_move_cohort_items")
					.withIndex("by_cohort_proposal", (q) =>
						q.eq("cohortId", cohort._id).eq("pendingUpdateId", row.pendingUpdateId),
					)
					.first()
			: null;
		const record = item ? await ctx.db.get("files_move_cohort_nodes", item.nodeRecordId) : null;
		await ctx.db.patch("files_pending_update_run_items", row._id, {
			prepared: files_pending_content_migration_versions(row.prepared),
			reviewHeader: row.reviewHeader
				? {
						...files_pending_content_migration_versions(row.reviewHeader),
						content: await files_pending_content_migration_db_family(
							ctx,
							row.reviewHeader,
							null,
							undefined,
							record?.sourceContentVersion?.textKind,
						),
					}
				: null,
		});
	},
});
export const backfill_pending_content_transfer_items = app_migrations.define({
	table: "files_transfer_items",
	batchSize: 1,
	migrateOne: async (ctx, row) => {
		await ctx.db.patch("files_transfer_items", row._id, {
			conflictVersion: files_pending_content_migration_versions(row.conflictVersion),
			capture: files_pending_content_migration_versions(row.capture),
		});
	},
});
export const backfill_pending_content_media_dependencies = app_migrations.define({
	table: "files_media_dependencies",
	batchSize: 1,
	migrateOne: async (ctx, row) => {
		await ctx.db.patch("files_media_dependencies", row._id, {
			dependency: files_pending_content_migration_versions(row.dependency),
		});
	},
});
export const strip_pending_content_legacy_flags = app_migrations.define({
	table: "files_pending_updates",
	batchSize: 1,
	migrateOne: async (ctx, row) => {
		if (
			row.moveCohortId ||
			(await db_held(ctx, row.target)) ||
			(await files_move_reservations_db_find_blocker(ctx.db, { source: { kind: "proposal", id: row._id } }))
		)
			return;
		await ctx.db.patch("files_pending_updates", row._id, {
			contentNeedsRebase: undefined,
			contentRebaseRootKind: undefined,
		});
	},
});
export const strip_pending_content_cohort_flags = app_migrations.define({
	table: "files_move_cohort_items",
	batchSize: 1,
	migrateOne: async (ctx, row) => {
		if (!row.afterProposal) return;
		const { contentNeedsRebase: _marked, contentRebaseRootKind: _root, ...afterProposal } = row.afterProposal;
		await ctx.db.patch("files_move_cohort_items", row._id, { afterProposal });
	},
});
export const strip_pending_content_review_flags = app_migrations.define({
	table: "files_pending_update_run_items",
	batchSize: 1,
	migrateOne: async (ctx, row) => {
		if (!row.reviewHeader) return;
		const { contentNeedsRebase: _marked, contentRebaseRootKind: _root, ...reviewHeader } = row.reviewHeader;
		await ctx.db.patch("files_pending_update_run_items", row._id, { reviewHeader });
	},
});
export const strip_pending_content_cohort_fields = app_migrations.define({
	table: "files_move_cohorts",
	batchSize: 1,
	migrateOne: async (ctx, row) => {
		await ctx.db.patch("files_move_cohorts", row._id, {
			pendingContentVersionReady: undefined,
			pendingContentMigration: undefined,
		});
	},
});

export const run_backfill_pending_content_cohorts = app_migrations.runner(
	internal.migrations.backfill_pending_content_cohorts,
);
export const run_backfill_pending_content_nodes = app_migrations.runner(
	internal.migrations.backfill_pending_content_nodes,
);
export const run_backfill_pending_content_places = app_migrations.runner(
	internal.migrations.backfill_pending_content_places,
);
export const run_backfill_pending_content_families = app_migrations.runner(
	internal.migrations.backfill_pending_content_families,
);
export const run_backfill_pending_content_batches = app_migrations.runner(
	internal.migrations.backfill_pending_content_batches,
);
export const run_backfill_pending_content_markers = app_migrations.runner(
	internal.migrations.backfill_pending_content_markers,
);
export const run_backfill_pending_content_cohort_nodes = app_migrations.runner(
	internal.migrations.backfill_pending_content_cohort_nodes,
);
export const run_backfill_pending_content_cohort_items = app_migrations.runner(
	internal.migrations.backfill_pending_content_cohort_items,
);
export const run_backfill_pending_content_cohort_content = app_migrations.runner(
	internal.migrations.backfill_pending_content_cohort_content,
);
export const run_backfill_pending_content_review_items = app_migrations.runner(
	internal.migrations.backfill_pending_content_review_items,
);
export const run_backfill_pending_content_transfer_items = app_migrations.runner(
	internal.migrations.backfill_pending_content_transfer_items,
);
export const run_backfill_pending_content_media_dependencies = app_migrations.runner(
	internal.migrations.backfill_pending_content_media_dependencies,
);
export const run_strip_pending_content_legacy_flags = app_migrations.runner(
	internal.migrations.strip_pending_content_legacy_flags,
);
export const run_strip_pending_content_cohort_flags = app_migrations.runner(
	internal.migrations.strip_pending_content_cohort_flags,
);
export const run_strip_pending_content_review_flags = app_migrations.runner(
	internal.migrations.strip_pending_content_review_flags,
);
export const run_strip_pending_content_cohort_fields = app_migrations.runner(
	internal.migrations.strip_pending_content_cohort_fields,
);

const migration_name = v.union(
	...(
		[
			"backfill_pending_content_cohorts",
			"backfill_pending_content_nodes",
			"backfill_pending_content_places",
			"backfill_pending_content_families",
			"backfill_pending_content_batches",
			"backfill_pending_content_markers",
			"backfill_pending_content_cohort_nodes",
			"backfill_pending_content_cohort_items",
			"backfill_pending_content_cohort_content",
			"backfill_pending_content_review_items",
			"backfill_pending_content_transfer_items",
			"backfill_pending_content_media_dependencies",
			"strip_pending_content_legacy_flags",
			"strip_pending_content_cohort_flags",
			"strip_pending_content_review_flags",
			"strip_pending_content_cohort_fields",
		] as const
	).map((name) => v.literal(name)),
);

/**
 * The throw rolls back one batch, including component calls and scheduled work.
 */
export const preview_pending_content = internalMutation({
	args: { migration: migration_name, cursor: v.union(v.string(), v.null()) },
	returns: v.null(),
	handler: async (ctx, args): Promise<null> => {
		const result = await ctx.runMutation(internal.migrations[args.migration], {
			cursor: args.cursor,
			batchSize: 1,
			oneBatchOnly: true,
			dryRun: false,
		});
		throw convex_error({
			message: JSON.stringify({
				preview: true,
				processed: result.processed,
				isDone: result.isDone,
				continueCursor: result.continueCursor,
			}),
		});
	},
});

const audit_table = v.union(
	...(
		[
			"files_nodes",
			"files_saved_places",
			"files_pending_updates",
			"files_pending_update_operation_batches",
			"files_pending_updates_last_sequence_saved",
			"files_move_cohorts",
			"files_move_cohort_nodes",
			"files_move_cohort_items",
			"files_move_cohort_content",
			"files_pending_update_run_items",
			"files_transfer_items",
			"files_media_dependencies",
		] as const
	).map((table) => v.literal(table)),
);

function missing_facts(value: unknown): number {
	if (!value || typeof value !== "object" || value instanceof ArrayBuffer) return 0;
	if (Array.isArray(value)) return value.reduce((count, part) => count + missing_facts(part), 0);
	const row = value as Record<string, unknown>;
	let count = 0;
	if (row.kind === "yjs" && "lastSequenceId" in row && row.pendingContentVersion === undefined) count++;
	if (
		["saved_yjs", "saved_asset", "replacement"].includes(String(row.kind)) &&
		"pendingUpdateId" in row &&
		row.expectedPendingContentVersion === undefined
	)
		count++;
	if (
		"baseStateId" in row &&
		"base" in row &&
		(row.rootKind === undefined ||
			((row.base as { kind?: string; pendingContentVersion?: number })?.kind !== "new" &&
				(row.base as { pendingContentVersion?: number })?.pendingContentVersion === undefined))
	)
		count++;
	return count + Object.values(row).reduce<number>((sum, part) => sum + missing_facts(part), 0);
}

function legacy_flags(value: unknown): number {
	if (!value || typeof value !== "object" || value instanceof ArrayBuffer) return 0;
	if (Array.isArray(value)) return value.reduce((count, part) => count + legacy_flags(part), 0);
	const row = value as Record<string, unknown>;
	return (
		Number(row.contentNeedsRebase !== undefined || row.contentRebaseRootKind !== undefined) +
		Object.values(row).reduce<number>((sum, part) => sum + legacy_flags(part), 0)
	);
}

/**
 * Complete every native page. Only counts leave this private-data audit.
 */
export const audit_pending_content = internalQuery({
	args: { table: audit_table, cursor: v.union(v.string(), v.null()) },
	returns: v.object({
		processed: v.number(),
		missing: v.number(),
		staleFamilies: v.number(),
		unprovedFamilies: v.number(),
		legacyFlags: v.number(),
		bridgeFields: v.number(),
		unreadyCohorts: v.number(),
		isDone: v.boolean(),
		continueCursor: v.string(),
	}),
	handler: async (ctx, args) => {
		const page = await ctx.db
			.query(args.table)
			.paginate({ cursor: args.cursor, numItems: 32, maximumBytesRead: 4 * 1024 * 1024 });
		let missing = 0;
		let staleFamilies = 0;
		let unprovedFamilies = 0;
		let legacyFlags = 0;
		let bridgeFields = 0;
		let unreadyCohorts = 0;
		for (const doc of page.page) {
			const row = doc as unknown as Record<string, unknown>;
			missing += missing_facts(row);
			if (
				(args.table === "files_nodes" ||
					args.table === "files_saved_places" ||
					args.table === "files_pending_updates_last_sequence_saved") &&
				row.pendingContentVersion === undefined
			)
				missing++;
			if (args.table === "files_pending_update_operation_batches" && row.expectedPendingContentVersion === undefined)
				missing++;
			if (
				args.table === "files_move_cohorts" &&
				(row.pendingContentVersionReady !== undefined || row.pendingContentMigration !== undefined)
			)
				bridgeFields++;
			if (
				args.table === "files_move_cohorts" &&
				row.phase !== "complete" &&
				(row.pendingContentVersionReady !== true || row.pendingContentMigration !== undefined)
			)
				unreadyCohorts++;
			const content = row.content as { base?: { pendingContentVersion?: number } } | undefined;
			if (content?.base?.pendingContentVersion === 0) {
				staleFamilies++;
				if (row.contentNeedsRebase !== true) unprovedFamilies++;
			}
			legacyFlags += legacy_flags(row);
		}
		return {
			processed: page.page.length,
			missing,
			staleFamilies,
			unprovedFamilies,
			legacyFlags,
			bridgeFields,
			unreadyCohorts,
			isDone: page.isDone,
			continueCursor: page.continueCursor,
		};
	},
});
