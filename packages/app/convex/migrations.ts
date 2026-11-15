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

// Temporary: remove after the backfill audit, when `listed` becomes required.
// Same rule as `channels_messages_db_is_visible`, without the per-reader anchor check.
export const backfill_channels_messages_listed = app_migrations.define({
	table: "channels_messages",
	migrateOne: async (ctx, message) => {
		if (message.listed !== undefined) return;
		const thread =
			message.threadRootId === null
				? await ctx.db
						.query("channels_threads")
						.withIndex("by_rootMessage", (q) => q.eq("rootMessageId", message._id))
						.unique()
				: null;
		await ctx.db.patch("channels_messages", message._id, {
			listed: message.deletedAt === null || (thread?.replyCount ?? 0) > 0,
		});
	},
});

export const run_backfill_channels_messages_listed = app_migrations.runner(
	internal.migrations.backfill_channels_messages_listed,
);
