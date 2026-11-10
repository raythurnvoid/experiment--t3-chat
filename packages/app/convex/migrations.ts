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

// TODO(migration): one-time. Nothing reads or writes the frontmatter marker pair any more, so its
// data goes. Run `run_remove_frontmatter_markers` after the push. Check that no `files_nodes`,
// `files_saved_content_heads` or `files_saved_places` doc holds `contentFrontmatterTooLargeFieldCount`
// or `contentFrontmatterTooLargeIndexDocumentCount`. Then delete this region, the optional schema
// fields, and the `_contentFrontmatterTooLarge*` lines in `files_tree_db.ts` and `files_move_cohorts.ts`.

export const remove_files_nodes_frontmatter_markers = app_migrations.define({
	table: "files_nodes",
	batchSize: 500,
	migrateOne: async (ctx, node) => {
		if (
			node.contentFrontmatterTooLargeFieldCount === undefined &&
			node.contentFrontmatterTooLargeIndexDocumentCount === undefined
		)
			return;
		await ctx.db.patch("files_nodes", node._id, {
			contentFrontmatterTooLargeFieldCount: undefined,
			contentFrontmatterTooLargeIndexDocumentCount: undefined,
		});
	},
});

export const remove_files_saved_content_heads_frontmatter_markers = app_migrations.define({
	table: "files_saved_content_heads",
	batchSize: 500,
	migrateOne: async (ctx, head) => {
		if (
			head.contentFrontmatterTooLargeFieldCount === undefined &&
			head.contentFrontmatterTooLargeIndexDocumentCount === undefined
		)
			return;
		await ctx.db.patch("files_saved_content_heads", head._id, {
			contentFrontmatterTooLargeFieldCount: undefined,
			contentFrontmatterTooLargeIndexDocumentCount: undefined,
		});
	},
});

export const remove_files_saved_places_frontmatter_markers = app_migrations.define({
	table: "files_saved_places",
	batchSize: 500,
	migrateOne: async (ctx, place) => {
		if (
			place.contentFrontmatterTooLargeFieldCount === undefined &&
			place.contentFrontmatterTooLargeIndexDocumentCount === undefined
		)
			return;
		await ctx.db.patch("files_saved_places", place._id, {
			contentFrontmatterTooLargeFieldCount: undefined,
			contentFrontmatterTooLargeIndexDocumentCount: undefined,
		});
	},
});

/**
 * Run the three migrations above one after the other.
 *
 * Run from the repository root: `vp env exec pnpm --dir packages/app exec convex run "migrations:run_remove_frontmatter_markers"`.
 */
export const run_remove_frontmatter_markers = app_migrations.runner([
	internal.migrations.remove_files_nodes_frontmatter_markers,
	internal.migrations.remove_files_saved_content_heads_frontmatter_markers,
	internal.migrations.remove_files_saved_places_frontmatter_markers,
]);
