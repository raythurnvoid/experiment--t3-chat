import { Migrations } from "@convex-dev/migrations";
import { v } from "convex/values";
import { components, internal } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel.js";
import { internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import { internalMutation } from "./functions.ts";
import app_convex_schema from "./schema.ts";
import { convex_error } from "../server/convex-utils.ts";
import { files_pending_review_facts_db_get_state } from "../server/files-pending-review-facts.ts";

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

const REVIEW_FACT_JOBS_MAX = 64;

/**
 * Count a workspace's overlay jobs that `pendingJobCount` counts (`reviewFactsPending`). Return null
 * when the workspace has more than `REVIEW_FACT_JOBS_MAX` jobs of any kind.
 */
async function db_count_review_fact_jobs(
	db: QueryCtx["db"],
	scope: Pick<Doc<"files_pending_review_fact_state">, "organizationId" | "workspaceId">,
) {
	// No user waits on this read: the repair runs in the background, and the audit is an operator
	// check. So a capped scan of one index range is fine. A full list job doc (1,000 `targets` items)
	// is about 125 KiB, so 65 docs read about 8 MiB, half of the 16 MiB read limit. Jobs end in
	// seconds, so a quiet workspace has few. A workspace past the cap is busy, not stuck: run again later.
	const jobs = await db
		.query("files_pending_overlay_jobs")
		.withIndex("by_org_ws", (q) => q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId))
		.take(REVIEW_FACT_JOBS_MAX + 1);
	if (jobs.length > REVIEW_FACT_JOBS_MAX) return null;
	return jobs.filter((job) => job.reviewFactsPending).length;
}

// One-time repair. Before commit 07816ba1, data deletion deleted overlay jobs without lowering
// `pendingJobCount`. Such a count stays above 0 forever, and every review plan in the workspace
// waits for it. Remove this migration, its runner, the audit and the test after the repair ran.
export const repair_review_fact_job_counts = app_migrations.define({
	table: "files_pending_review_fact_state",
	// One workspace per batch, so each mutation reads at most one capped job range.
	batchSize: 1,
	migrateOne: async (ctx, state) => {
		const next = await db_count_review_fact_jobs(ctx.db, state);
		if (next === null) {
			console.warn("Skipped a busy workspace in the review fact job count repair", {
				id: state._id,
				workspaceId: state.workspaceId,
			});
			return;
		}
		if (next === state.pendingJobCount) return;

		console.info("Repaired a review fact job count", {
			id: state._id,
			workspaceId: state.workspaceId,
			old: state.pendingJobCount,
			next,
		});
		await ctx.db.patch("files_pending_review_fact_state", state._id, { pendingJobCount: next });
	},
});

export const run_repair_review_fact_job_counts = app_migrations.runner(
	internal.migrations.repair_review_fact_job_counts,
);

/**
 * Read-only check of one workspace: the stored count and the real counted jobs. `countedJobs` is
 * null when the workspace is past the job cap.
 */
export const audit_review_fact_job_count = internalQuery({
	args: { organizationId: v.id("organizations"), workspaceId: v.id("organizations_workspaces") },
	returns: v.union(v.object({ pendingJobCount: v.number(), countedJobs: v.union(v.number(), v.null()) }), v.null()),
	handler: async (ctx, args) => {
		const state = await files_pending_review_facts_db_get_state(ctx.db, args);
		if (!state) return null;
		return { pendingJobCount: state.pendingJobCount, countedJobs: await db_count_review_fact_jobs(ctx.db, args) };
	},
});

/**
 * Run from packages/app: `vp env exec pnpm exec convex run migrations:run_<migration_name>`.
 */
export const run = app_migrations.runner();
