import { Migrations } from "@convex-dev/migrations";
import { v } from "convex/values";
import { components, internal } from "./_generated/api.js";
import { internalQuery } from "./_generated/server.js";
import { internalMutation } from "./functions.ts";
import app_convex_schema from "./schema.ts";
import { files_content_type_index_fields } from "../shared/files.ts";

// The schema lets a migration read through an index with `customRange`.
const app_migrations = new Migrations(components.migrations, {
	internalMutation,
	schema: app_convex_schema,
});

/**
 * Fill `contentTypeEssence` and `contentTypeFamily` of every saved node, in every workspace, from its
 * `contentType`. A doc that already matches is not written, so a rerun writes nothing.
 *
 * Temporary: remove the two backfills, the audit and their test after the audit passes.
 */
export const backfill_files_nodes_content_type_fields = app_migrations.define({
	table: "files_nodes",
	migrateOne: (_ctx, node) => {
		const fields = files_content_type_index_fields(node.contentType);
		if (node.contentTypeEssence === fields.contentTypeEssence && node.contentTypeFamily === fields.contentTypeFamily)
			return;
		return fields;
	},
});

/**
 * The same for the saved places of running Moves. A Move copies node fields into its places, so run
 * this after the node backfill.
 */
export const backfill_files_saved_places_content_type_fields = app_migrations.define({
	table: "files_saved_places",
	migrateOne: (_ctx, place) => {
		const fields = files_content_type_index_fields(place.contentType);
		if (place.contentTypeEssence === fields.contentTypeEssence && place.contentTypeFamily === fields.contentTypeFamily)
			return;
		return fields;
	},
});

/**
 * Docs per page of `audit_files_content_type_fields_page`. The byte cap ends a page early when docs are big.
 */
const CONTENT_TYPE_AUDIT_PAGE_SIZE = 1000;
const CONTENT_TYPE_AUDIT_PAGE_BYTES = 4 * 1024 * 1024;

/**
 * Return the ids of one page of saved nodes or saved places whose `contentTypeEssence` or
 * `contentTypeFamily` is missing or differs from `files_content_type_index_fields(contentType)`.
 * Call again with `continueCursor` until `isDone`. Every page must return no id.
 *
 * `unparsedCount` counts files whose stored `contentType` does not parse. They get null fields, so no
 * type filter lists them. It need not be 0; it shows how many old files the filter misses.
 */
export const audit_files_content_type_fields_page = internalQuery({
	args: {
		table: v.union(v.literal("files_nodes"), v.literal("files_saved_places")),
		cursor: v.union(v.string(), v.null()),
	},
	returns: v.object({
		checkedCount: v.number(),
		wrongIds: v.array(v.string()),
		unparsedCount: v.number(),
		continueCursor: v.string(),
		isDone: v.boolean(),
	}),
	handler: async (ctx, args) => {
		const options = {
			cursor: args.cursor,
			numItems: CONTENT_TYPE_AUDIT_PAGE_SIZE,
			maximumBytesRead: CONTENT_TYPE_AUDIT_PAGE_BYTES,
		};
		const page =
			args.table === "files_nodes"
				? await ctx.db.query("files_nodes").paginate(options)
				: await ctx.db.query("files_saved_places").paginate(options);
		const wrongIds: string[] = [];
		let unparsedCount = 0;
		for (const doc of page.page) {
			const fields = files_content_type_index_fields(doc.contentType);
			if (doc.contentTypeEssence !== fields.contentTypeEssence || doc.contentTypeFamily !== fields.contentTypeFamily)
				wrongIds.push(doc._id);
			if (doc.contentType !== null && fields.contentTypeEssence === null) unparsedCount += 1;
		}
		return {
			checkedCount: page.page.length,
			wrongIds,
			unparsedCount,
			continueCursor: page.continueCursor,
			isDone: page.isDone,
		};
	},
});

/** Run migrations from the CLI: `pnpx convex run migrations:run_<migration_name>` (cwd: packages/app). */
export const run = app_migrations.runner();
export const run_backfill_files_nodes_content_type_fields = app_migrations.runner(
	internal.migrations.backfill_files_nodes_content_type_fields,
);
export const run_backfill_files_saved_places_content_type_fields = app_migrations.runner(
	internal.migrations.backfill_files_saved_places_content_type_fields,
);
