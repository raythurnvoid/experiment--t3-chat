import { Migrations } from "@convex-dev/migrations";
import { components, internal } from "./_generated/api.js";
import { internalQuery } from "./_generated/server.js";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { internalMutation } from "./functions.ts";
import app_convex_schema from "./schema.ts";
import { files_saved_content_db_get_head } from "../server/files-saved-content-head.ts";

// The schema lets a migration read through an index with `customRange`.
const app_migrations = new Migrations(components.migrations, {
	internalMutation,
	schema: app_convex_schema,
});

/**
 * Run from packages/app: `vp env exec pnpm exec convex run migrations:run_<migration_name>`.
 */
export const run = app_migrations.runner();

export const backfill_saved_content_yjs_owner = app_migrations.define({
	table: "files_saved_content_heads",
	migrateOne: async (ctx, head) => {
		if (head.yjsContentHeadId !== undefined) return;
		await ctx.db.patch("files_saved_content_heads", head._id, {
			yjsContentHeadId: head.yjsLastSequenceId ? head._id : null,
		});
	},
});

export const run_backfill_saved_content_yjs_owner = app_migrations.runner(
	internal.migrations.backfill_saved_content_yjs_owner,
);

export const backfill_yjs_cleanup_owner = app_migrations.define({
	table: "files_yjs_cleanup_tasks",
	migrateOne: async (ctx, task) => {
		if (task.logOwnerId !== undefined) return;
		const head = await files_saved_content_db_get_head(ctx.db, task.fileNodeId);
		await ctx.db.patch("files_yjs_cleanup_tasks", task._id, {
			logOwnerId: head ? (head.yjsContentHeadId ?? head._id) : null,
			...(head ? {} : { historyPending: false }),
		});
	},
});

export const run_backfill_yjs_cleanup_owner = app_migrations.runner(internal.migrations.backfill_yjs_cleanup_owner);

export const backfill_yjs_waiter_owner = app_migrations.define({
	table: "files_move_waiters",
	migrateOne: async (ctx, waiter) => {
		const worker = waiter.worker;
		if ((worker.kind !== "content_cleanup" && worker.kind !== "yjs_covered") || worker.logOwnerId !== undefined) return;
		const head = await files_saved_content_db_get_head(ctx.db, worker.nodeId);
		if (!head) {
			// Keep the waiter until its normal wake can settle the missing file.
			await ctx.scheduler.runAfter(0, internal.files_move_cohorts.wake_waiters, { cohortId: waiter.cohortId });
			return;
		}
		await ctx.db.patch("files_move_waiters", waiter._id, {
			worker: { ...worker, logOwnerId: head.yjsContentHeadId ?? head._id },
		});
	},
});

export const run_backfill_yjs_waiter_owner = app_migrations.runner(internal.migrations.backfill_yjs_waiter_owner);

export const audit_yjs_cleanup_owners = internalQuery({
	args: { table: v.union(v.literal("tasks"), v.literal("waiters")), paginationOpts: paginationOptsValidator },
	returns: v.object({
		continueCursor: v.string(),
		isDone: v.boolean(),
		checked: v.number(),
		missing: v.array(v.string()),
	}),
	handler: async (ctx, args) => {
		if (args.table === "tasks") {
			const page = await ctx.db.query("files_yjs_cleanup_tasks").paginate(args.paginationOpts);
			return {
				continueCursor: page.continueCursor,
				isDone: page.isDone,
				checked: page.page.length,
				missing: page.page.filter((task) => task.logOwnerId === undefined).map((task) => task._id),
			};
		}
		const page = await ctx.db.query("files_move_waiters").paginate(args.paginationOpts);
		return {
			continueCursor: page.continueCursor,
			isDone: page.isDone,
			checked: page.page.length,
			missing: page.page
				.filter(
					(waiter) =>
						(waiter.worker.kind === "content_cleanup" || waiter.worker.kind === "yjs_covered") &&
						waiter.worker.logOwnerId === undefined,
				)
				.map((waiter) => waiter._id),
		};
	},
});

export const audit_saved_content_yjs_owners = internalQuery({
	args: { paginationOpts: paginationOptsValidator },
	returns: v.object({
		continueCursor: v.string(),
		isDone: v.boolean(),
		checked: v.number(),
		missing: v.array(v.id("files_saved_content_heads")),
		invalid: v.array(v.id("files_saved_content_heads")),
	}),
	handler: async (ctx, args) => {
		const page = await ctx.db.query("files_saved_content_heads").paginate(args.paginationOpts);
		const missing = [];
		const invalid = [];
		for (const head of page.page) {
			if (head.yjsContentHeadId === undefined) missing.push(head._id);
			else if (!head.retired && head.yjsLastSequenceId) {
				const owner = head.yjsContentHeadId
					? await ctx.db.get("files_saved_content_heads", head.yjsContentHeadId)
					: null;
				if (
					!owner ||
					owner.fileNodeId !== head.fileNodeId ||
					owner.organizationId !== head.organizationId ||
					owner.workspaceId !== head.workspaceId
				)
					invalid.push(head._id);
			}
		}
		return { continueCursor: page.continueCursor, isDone: page.isDone, checked: page.page.length, missing, invalid };
	},
});
