import { Migrations, type MigrationResult } from "@convex-dev/migrations";
import { paginationResultValidator } from "convex/server";
import { v } from "convex/values";
import { components, internal } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel.js";
import { internalQuery, type QueryCtx } from "./_generated/server.js";
import { internalMutation } from "./functions.ts";
import app_convex_schema from "./schema.ts";
import { files_pending_review_facts_db_get_state } from "../server/files-pending-review-facts.ts";
import { files_pending_overlay_db_mark_target } from "../server/files-pending-overlay.ts";
import { convex_error } from "../server/convex-utils.ts";

// The schema lets a migration read through an index with `customRange`.
const app_migrations = new Migrations(components.migrations, {
	internalMutation,
	schema: app_convex_schema,
});

const REVIEW_FACT_JOBS_MAX = 64;

// One-time derived index backfill. Keep the new command closed until the audit passes.
export const backfill_pending_types = app_migrations.define({
	table: "files_pending_updates",
	batchSize: 1,
	migrateOne: async (ctx, proposal) => {
		files_pending_overlay_db_mark_target(ctx, {
			organizationId: proposal.organizationId,
			workspaceId: proposal.workspaceId,
			userId: proposal.userId,
			target: proposal.target,
			pendingUpdateId: proposal._id,
		});
	},
});

export const run_backfill_pending_types = app_migrations.runner(internal.migrations.backfill_pending_types);

export const preview_pending_types = internalMutation({
	args: { cursor: v.union(v.string(), v.null()) },
	returns: v.null(),
	handler: async (ctx, args) => {
		const result: MigrationResult = await ctx.runMutation(internal.migrations.backfill_pending_types, {
			cursor: args.cursor,
			batchSize: 1,
			dryRun: false,
			oneBatchOnly: true,
		});
		throw convex_error({
			message: "Pending type preview rolled back.",
			data: { processed: result.processed, continueCursor: result.continueCursor, isDone: result.isDone },
		});
	},
});

// The operator keeps an owner manifest outside the database and audits each owner with check_user.
export const audit_pending_type_source_page = internalQuery({
	args: { cursor: v.union(v.string(), v.null()) },
	returns: paginationResultValidator(
		v.object({
			organizationId: v.id("organizations"),
			workspaceId: v.id("organizations_workspaces"),
			userId: v.id("users"),
		}),
	),
	handler: async (ctx, args) => {
		const page = await ctx.db
			.query("files_pending_updates")
			.withIndex("by_organization_workspace_user_target")
			.paginate({ cursor: args.cursor, numItems: 16, maximumBytesRead: 512 * 1024 });
		return {
			...page,
			page: page.page.map(({ organizationId, workspaceId, userId }) => ({ organizationId, workspaceId, userId })),
		};
	},
});

async function db_scope_status(
	db: QueryCtx["db"],
	scope: Pick<Doc<"files_pending_review_fact_state">, "organizationId" | "workspaceId">,
) {
	// Keep these scopes protected after a rename or tenant deletion.
	if (
		scope.organizationId === "gs7k8abvmsa6nxm8dwrah5nc318bmejm" ||
		scope.workspaceId === "h57j1rmpsvs2b3hsyftq4pm9v18bmer4" ||
		scope.workspaceId === "h57svystn7skx8wym6me4v0mhh8bm1kq"
	)
		return "protected" as const;

	const [organization, workspace] = await Promise.all([
		db.get("organizations", scope.organizationId),
		db.get("organizations_workspaces", scope.workspaceId),
	]);
	// Delayed purge can leave a state after its workspace was deleted.
	if (!organization || !workspace || workspace.organizationId !== scope.organizationId)
		return "invalid_tenant" as const;
	if (organization.name.toLowerCase() === "personal" && workspace.name.toLowerCase() === "sybill")
		return "protected" as const;
	return "allowed" as const;
}

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
	// is about 125 KiB, so 65 docs read about 8 MiB, half of the 16 MiB read limit. A scope past
	// the cap stays unresolved; finishing migration pages does not prove its count is correct.
	const jobs = await db
		.query("files_pending_overlay_jobs")
		.withIndex("by_org_ws", (q) => q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId))
		.take(REVIEW_FACT_JOBS_MAX + 1);
	if (jobs.length > REVIEW_FACT_JOBS_MAX) return null;
	return jobs.filter((job) => job.reviewFactsPending).length;
}

// One-time repair. Before commit 07816ba1, data deletion deleted overlay jobs without lowering
// `pendingJobCount`. Such a count stays above 0 forever, and every review plan in the workspace
// waits for it. Remove these temporary tools and tests only after repair and a complete audit.
export const repair_review_fact_job_counts = app_migrations.define({
	table: "files_pending_review_fact_state",
	// One workspace per batch, so each mutation reads at most one capped job range.
	batchSize: 1,
	migrateOne: async (ctx, state) => {
		const scopeStatus = await db_scope_status(ctx.db, state);
		if (scopeStatus !== "allowed") {
			console.warn("Skipped an excluded workspace in the review fact job count repair", {
				id: state._id,
				workspaceId: state.workspaceId,
				scopeStatus,
			});
			return;
		}
		const next = await db_count_review_fact_jobs(ctx.db, state);
		if (next === null) {
			console.warn("Skipped a workspace past the review fact job cap", {
				id: state._id,
				workspaceId: state.workspaceId,
			});
			return;
		}
		if (next === state.pendingJobCount) return;

		// This attempt log stays visible even when the preview rolls its patch back.
		console.info("Updating a review fact job count", {
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

export const preview_review_fact_job_counts = internalMutation({
	args: { cursor: v.union(v.string(), v.null()) },
	returns: v.null(),
	handler: async (ctx, args) => {
		// Call the definition directly. A runner can schedule more batches and log full dry-run docs.
		const result: MigrationResult = await ctx.runMutation(internal.migrations.repair_review_fact_job_counts, {
			cursor: args.cursor,
			batchSize: 1,
			dryRun: false,
			oneBatchOnly: true,
		});
		// Throw from this mutation to roll back the nested patch. Only expose batch counts and a cursor.
		throw convex_error({
			message: "Review fact job count preview rolled back.",
			data: { processed: result.processed, continueCursor: result.continueCursor, isDone: result.isDone },
		});
	},
});

/**
 * Enumerate every state, including zero counts. Check each allowed scope with the exact audit.
 * Keep this native cursor separate from preview and repair cursors.
 */
export const audit_review_fact_state_page = internalQuery({
	args: { cursor: v.union(v.string(), v.null()) },
	returns: paginationResultValidator(
		v.object({
			stateId: v.id("files_pending_review_fact_state"),
			organizationId: v.id("organizations"),
			workspaceId: v.id("organizations_workspaces"),
			pendingJobCount: v.number(),
			scopeStatus: v.union(v.literal("allowed"), v.literal("protected"), v.literal("invalid_tenant")),
		}),
	),
	handler: async (ctx, args) => {
		// One state bounds its tenant gets. Job ranges belong in separate exact audits.
		const page = await ctx.db
			.query("files_pending_review_fact_state")
			.withIndex("by_creation_time")
			.paginate({ cursor: args.cursor, numItems: 1 });
		return {
			...page,
			page: await Promise.all(
				page.page.map(async (state) => ({
					stateId: state._id,
					organizationId: state.organizationId,
					workspaceId: state.workspaceId,
					pendingJobCount: state.pendingJobCount,
					scopeStatus: await db_scope_status(ctx.db, state),
				})),
			),
		};
	},
});

/**
 * Read-only check of one workspace: the stored count and the real counted jobs. `countedJobs` is
 * null for excluded scopes or when an allowed workspace is past the job cap. Neither is a match.
 */
export const audit_review_fact_job_count = internalQuery({
	args: { organizationId: v.id("organizations"), workspaceId: v.id("organizations_workspaces") },
	returns: v.union(
		v.object({
			pendingJobCount: v.number(),
			countedJobs: v.union(v.number(), v.null()),
			scopeStatus: v.union(v.literal("allowed"), v.literal("protected"), v.literal("invalid_tenant")),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const state = await files_pending_review_facts_db_get_state(ctx.db, args);
		if (!state) return null;
		const scopeStatus = await db_scope_status(ctx.db, state);
		return {
			pendingJobCount: state.pendingJobCount,
			countedJobs: scopeStatus === "allowed" ? await db_count_review_fact_jobs(ctx.db, args) : null,
			scopeStatus,
		};
	},
});

/**
 * Run from packages/app: `vp env exec pnpm exec convex run migrations:run_<migration_name>`.
 */
export const run = app_migrations.runner();

if (process.env.NODE_ENV === "test" && import.meta.vitest) {
	const { test, expect, vi } = import.meta.vitest;

	// The local DB uses other ID formats. Test these historical IDs before any tenant lookup.
	test.each([
		{ organizationId: "gs7k8abvmsa6nxm8dwrah5nc318bmejm", workspaceId: "renamed-workspace" },
		{ organizationId: "renamed-organization", workspaceId: "h57j1rmpsvs2b3hsyftq4pm9v18bmer4" },
		{ organizationId: "missing-organization", workspaceId: "h57svystn7skx8wym6me4v0mhh8bm1kq" },
	])("review fact repair protects fixed IDs before tenant lookups: $workspaceId", async (scope) => {
		const get = vi.fn();
		const db = { get } as unknown as QueryCtx["db"];
		expect(await db_scope_status(db, scope as Parameters<typeof db_scope_status>[1])).toBe("protected");
		expect(get).not.toHaveBeenCalled();
	});
}
