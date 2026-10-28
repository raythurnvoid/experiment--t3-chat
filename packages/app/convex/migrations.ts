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

// Temporary: remove after the backfill is audited and channelKind is required.
export const backfill_channels_members_channelKind = app_migrations.define({
	table: "channels_members",
	migrateOne: async (ctx, member) => {
		if (member.channelKind !== undefined) return;
		const channel = await ctx.db.get("channels", member.channelId);
		if (!channel) throw new Error(`Channel ${member.channelId} is missing for member ${member._id}`);
		await ctx.db.patch("channels_members", member._id, { channelKind: channel.kind });
	},
});

export const run_backfill_channels_members_channelKind = app_migrations.runner(
	internal.migrations.backfill_channels_members_channelKind,
);
