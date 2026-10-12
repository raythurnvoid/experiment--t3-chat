import { Migrations } from "@convex-dev/migrations";
import { v } from "convex/values";
import { components, internal } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { internalMutation } from "./functions.ts";
import app_convex_schema from "./schema.ts";
import { convex_error } from "../server/convex-utils.ts";

// The schema lets a migration read through an index with `customRange`.
const app_migrations = new Migrations(components.migrations, {
	internalMutation,
	schema: app_convex_schema,
});

async function db_check_move_slot(ctx: MutationCtx, slot: Doc<"files_move_workspace_slots">) {
	if (slot.cohortId !== null) {
		throw convex_error({ message: "Stop or finish the Move before migrating its slot." });
	}
	// Protect these scopes even if their names change.
	if (
		slot.organizationId === "gs7k8abvmsa6nxm8dwrah5nc318bmejm" ||
		slot.workspaceId === "h57j1rmpsvs2b3hsyftq4pm9v18bmer4" ||
		slot.workspaceId === "h57svystn7skx8wym6me4v0mhh8bm1kq"
	) {
		throw convex_error({ message: "This Move slot belongs to a protected scope." });
	}
	const [organization, workspace] = await Promise.all([
		ctx.db.get("organizations", slot.organizationId),
		ctx.db.get("organizations_workspaces", slot.workspaceId),
	]);
	if (!organization || !workspace || workspace.organizationId !== slot.organizationId) {
		throw convex_error({ message: "The Move slot has invalid tenant metadata." });
	}
	if (organization.name.toLowerCase() === "personal" && workspace.name.toLowerCase() === "sybill") {
		throw convex_error({ message: "This Move slot belongs to a protected scope." });
	}
}

export const backfill_move_search_generations = app_migrations.define({
	table: "files_move_workspace_slots",
	customRange: (query) => query.withIndex("by_workspace"),
	batchSize: 64,
	migrateOne: async (ctx, slot) => {
		if (slot.searchGeneration === undefined) return;
		await db_check_move_slot(ctx, slot);
		const counter = await ctx.db
			.query("files_move_search_generations")
			.withIndex("by_workspace", (q) => q.eq("organizationId", slot.organizationId).eq("workspaceId", slot.workspaceId))
			.unique();
		if (!counter) {
			await ctx.db.insert("files_move_search_generations", {
				organizationId: slot.organizationId,
				workspaceId: slot.workspaceId,
				searchGeneration: slot.searchGeneration,
			});
		}
	},
});

export const run_backfill_move_search_generations = app_migrations.runner(
	internal.migrations.backfill_move_search_generations,
);

// Audit the copied counters before running this separate strip step.
export const strip_move_slot_search_generation = app_migrations.define({
	table: "files_move_workspace_slots",
	customRange: (query) => query.withIndex("by_workspace"),
	batchSize: 64,
	migrateOne: async (ctx, slot) => {
		if (slot.searchGeneration === undefined) return;
		await db_check_move_slot(ctx, slot);
		const counter = await ctx.db
			.query("files_move_search_generations")
			.withIndex("by_workspace", (q) => q.eq("organizationId", slot.organizationId).eq("workspaceId", slot.workspaceId))
			.unique();
		if (!counter) {
			throw convex_error({ message: "Copy the Move search counter before removing the old field." });
		}
		await ctx.db.patch("files_move_workspace_slots", slot._id, { searchGeneration: undefined });
	},
});

export const run_strip_move_slot_search_generation = app_migrations.runner(
	internal.migrations.strip_move_slot_search_generation,
);

export const preview_move_slot_cutover = internalMutation({
	args: { step: v.union(v.literal("copy"), v.literal("strip")) },
	returns: v.null(),
	handler: async (ctx, args) => {
		await ctx.runMutation(
			args.step === "copy"
				? internal.migrations.backfill_move_search_generations
				: internal.migrations.strip_move_slot_search_generation,
			{ cursor: null, batchSize: 64, dryRun: false, oneBatchOnly: true },
		);
		// The outer transaction rolls back the batch, including cross-table writes.
		throw convex_error({ message: `Move slot ${args.step} preview rolled back.` });
	},
});

/**
 * Run from packages/app: `vp env exec pnpm exec convex run migrations:run_<migration_name>`.
 */
export const run = app_migrations.runner();
