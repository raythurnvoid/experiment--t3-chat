import { Migrations } from "@convex-dev/migrations";
import { v } from "convex/values";
import { components, internal } from "./_generated/api.js";
import { internalAction, internalQuery } from "./_generated/server.js";
import { internalMutation } from "./functions.ts";
import app_convex_schema from "./schema.ts";
import { files_sort_value_key } from "../shared/files-sort.ts";

// The schema lets a migration read through an index with `customRange`.
const app_migrations = new Migrations(components.migrations, {
	internalMutation,
	schema: app_convex_schema,
});

/**
 * Run from packages/app: `vp env exec pnpm exec convex run migrations:run_<migration_name>`.
 */
export const run = app_migrations.runner();

// Temporary: remove after the audit below finds 0 rows in both tables.
// Before the typed sort keys, every field doc stored a text key, also for a number or a boolean.
// `sortDisplayValue` still has the value with its type, so the new key needs no file read.
export const fix_files_metadata_docs_typed_sort_value = app_migrations.define({
	table: "files_metadata_docs",
	migrateOne: async (ctx, doc) => {
		if (!("sortDisplayValue" in doc) || typeof doc.sortValue !== "string") return;
		if (typeof doc.sortDisplayValue !== "number" && typeof doc.sortDisplayValue !== "boolean") return;
		await ctx.db.patch("files_metadata_docs", doc._id, {
			sortValue: files_sort_value_key(doc.sortDisplayValue),
		});
	},
});

export const run_fix_files_metadata_docs_typed_sort_value = app_migrations.runner(
	internal.migrations.fix_files_metadata_docs_typed_sort_value,
);

/**
 * Temporary audit for the migration above: one page of a table, and how many of its rows still
 * have a text key for a number or a boolean. `files_index_candidates` holds field docs that an
 * index run staged before the deploy and installs later.
 */
export const audit_typed_sort_value = internalQuery({
	args: {
		table: v.union(v.literal("files_metadata_docs"), v.literal("files_index_candidates")),
		cursor: v.union(v.string(), v.null()),
	},
	handler: async (ctx, args) => {
		const page = await ctx.db.query(args.table).paginate({ cursor: args.cursor, numItems: 4000 });
		let stale = 0;
		for (const row of page.page) {
			const fields = "value" in row ? row.value : row;
			if (
				"sortDisplayValue" in fields &&
				typeof fields.sortValue === "string" &&
				(typeof fields.sortDisplayValue === "number" || typeof fields.sortDisplayValue === "boolean")
			) {
				stale += 1;
			}
		}

		return { rows: page.page.length, stale, cursor: page.continueCursor, isDone: page.isDone };
	},
});

/**
 * Temporary: run the audit above over a whole table in one call and return the totals. One CLI call
 * per page took about 2 s, too slow for 1.8M rows.
 */
export const audit_typed_sort_value_all = internalAction({
	args: { table: v.union(v.literal("files_metadata_docs"), v.literal("files_index_candidates")) },
	handler: async (ctx, args): Promise<{ rows: number; stale: number; pages: number }> => {
		let cursor: string | null = null;
		let rows = 0;
		let stale = 0;
		let pages = 0;
		for (;;) {
			const page = (await ctx.runQuery(internal.migrations.audit_typed_sort_value, {
				table: args.table,
				cursor,
			})) as { rows: number; stale: number; cursor: string; isDone: boolean };
			rows += page.rows;
			stale += page.stale;
			pages += 1;
			if (page.isDone) break;
			cursor = page.cursor;
		}

		return { rows, stale, pages };
	},
});
