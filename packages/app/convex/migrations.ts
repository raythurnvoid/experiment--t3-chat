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

// Temporary: remove after the audit. Screen info parts sent before Messages screen info have no
// `channel` key, and the strict part schema now requires it.
export const backfill_ai_chat_ui_context_channel = app_migrations.define({
	table: "ai_chat_threads_messages_aisdk_5",
	migrateOne: async (ctx, message) => {
		const parts: unknown = message.content.parts;
		if (!Array.isArray(parts)) return;
		let changed = false;
		const nextParts = parts.map((part: unknown) => {
			if (typeof part !== "object" || part === null || !("type" in part) || part.type !== "data-ui-context")
				return part;
			if (!("data" in part) || typeof part.data !== "object" || part.data === null || "channel" in part.data)
				return part;
			changed = true;
			return { ...part, data: { ...part.data, channel: null } };
		});
		if (changed)
			await ctx.db.patch("ai_chat_threads_messages_aisdk_5", message._id, {
				content: { ...message.content, parts: nextParts },
			});
	},
});

export const run_backfill_ai_chat_ui_context_channel = app_migrations.runner(
	internal.migrations.backfill_ai_chat_ui_context_channel,
);
