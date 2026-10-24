import { Migrations } from "@convex-dev/migrations";
import { components, internal } from "./_generated/api.js";
import { internalMutation } from "./functions.ts";
import { internalQuery } from "./_generated/server.js";
import { v } from "convex/values";
import { convex_error } from "../server/convex-utils.ts";
import { files_move_reservations_db_find_blocker } from "../server/files-move-reservations.ts";
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

export const strip_pending_content_legacy_flags = app_migrations.define({
	table: "files_pending_updates",
	batchSize: 1,
	migrateOne: async (ctx, row) => {
		if (
			row.moveCohortId ||
			(await files_move_reservations_db_find_blocker(ctx.db, { source: row.target })) ||
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
 * Strict runtime owns new work. This audit checks only facts and keys that still need stripping.
 */
export const audit_pending_content = internalQuery({
	args: { table: audit_table, cursor: v.union(v.string(), v.null()) },
	returns: v.object({
		processed: v.number(),
		missing: v.number(),
		staleFamilies: v.number(),
		legacyFlags: v.number(),
		bridgeFields: v.number(),
		isDone: v.boolean(),
		continueCursor: v.string(),
	}),
	handler: async (ctx, args) => {
		const page = await ctx.db
			.query(args.table)
			.paginate({ cursor: args.cursor, numItems: 32, maximumBytesRead: 4 * 1024 * 1024 });
		let missing = 0;
		let staleFamilies = 0;
		let legacyFlags = 0;
		let bridgeFields = 0;
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
			const content = row.content as { base?: { pendingContentVersion?: number } } | undefined;
			if (content?.base?.pendingContentVersion === 0) staleFamilies++;
			legacyFlags += legacy_flags(row);
		}
		return {
			processed: page.page.length,
			missing,
			staleFamilies,
			legacyFlags,
			bridgeFields,
			isDone: page.isDone,
			continueCursor: page.continueCursor,
		};
	},
});
