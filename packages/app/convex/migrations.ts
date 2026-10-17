import { Migrations, type MigrationResult } from "@convex-dev/migrations";
import { paginationResultValidator } from "convex/server";
import { v } from "convex/values";
import { components, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { internalQuery, type QueryCtx } from "./_generated/server.js";
import { internalMutation } from "./functions.ts";
import app_convex_schema from "./schema.ts";
import { files_pending_review_facts_db_get_state } from "../server/files-pending-review-facts.ts";
import { convex_error } from "../server/convex-utils.ts";
import {
	plugins_db_sandbox_root_target,
	plugins_db_schedule_sandbox_rebuild,
	plugins_sandbox_root_key,
	plugins_SANDBOX_LEVEL_BY_PERMISSION,
} from "./plugins_service_accounts.ts";
import { access_control_file_share_level_from_permissions } from "../shared/access-control.ts";

// The schema lets a migration read through an index with `customRange`.
const app_migrations = new Migrations(components.migrations, {
	internalMutation,
	schema: app_convex_schema,
});

const REVIEW_FACT_JOBS_MAX = 64;

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

// Every installation gets its sandbox roots from a background rebuild job. Remove these
// temporary tools and tests after the audit passes and `sandbox` is required.
export const backfill_plugins_sandbox_roots = app_migrations.define({
	table: "plugins_workspace_installations",
	// Each one schedules its own job, which reads the account grants page by page.
	batchSize: 50,
	migrateOne: async (ctx, installation) => {
		if (installation.sandbox) return;
		console.info("Starting a sandbox root rebuild", { id: installation._id, workspaceId: installation.workspaceId });
		await plugins_db_schedule_sandbox_rebuild(ctx, { installationId: installation._id });
	},
});

export const run_backfill_plugins_sandbox_roots = app_migrations.runner(
	internal.migrations.backfill_plugins_sandbox_roots,
);

export const preview_plugins_sandbox_roots = internalMutation({
	args: { cursor: v.union(v.string(), v.null()) },
	returns: v.null(),
	handler: async (ctx, args) => {
		const result: MigrationResult = await ctx.runMutation(internal.migrations.backfill_plugins_sandbox_roots, {
			cursor: args.cursor,
			batchSize: 50,
			dryRun: false,
			oneBatchOnly: true,
		});
		// Throw to roll back the patches and the scheduled jobs.
		throw convex_error({
			message: "Sandbox roots preview rolled back.",
			data: { processed: result.processed, continueCursor: result.continueCursor, isDone: result.isDone },
		});
	},
});

const sandbox_audit_scope_status_validator = v.union(
	v.literal("allowed"),
	v.literal("protected"),
	v.literal("invalid_tenant"),
);

/**
 * Pass 1 of the sandbox roots audit: one installation per page. Each root must still be a root of a
 * live account grant with the same level. At most 20 roots, so one page has a small fixed cost.
 */
export const audit_plugins_sandbox_roots_page = internalQuery({
	args: { cursor: v.union(v.string(), v.null()) },
	returns: paginationResultValidator(
		v.object({
			installationId: v.id("plugins_workspace_installations"),
			workspaceId: v.id("organizations_workspaces"),
			scopeStatus: sandbox_audit_scope_status_validator,
			state: v.union(v.literal("missing"), v.literal("running"), v.literal("too_many_folders"), v.literal("ready")),
			rootCount: v.number(),
			wrongRoots: v.array(v.string()),
		}),
	),
	handler: async (ctx, args) => {
		const page = await ctx.db
			.query("plugins_workspace_installations")
			.withIndex("by_creation_time")
			.paginate({ cursor: args.cursor, numItems: 1 });
		return {
			...page,
			page: await Promise.all(
				page.page.map(async (installation) => {
					const sandbox = installation.sandbox;
					const wrongRoots: string[] = [];
					for (const root of sandbox?.rebuild === null ? sandbox.roots : []) {
						const resource =
							root.target.kind === "open"
								? ({ kind: "workspace", id: installation.workspaceId } as const)
								: ({ kind: "file", id: root.target.nodeId } as const);
						const grants = await ctx.db
							.query("access_control_permission_grants")
							.withIndex("by_organization_workspace_resource_serviceAccount_permission", (q) =>
								q
									.eq("organizationId", installation.organizationId)
									.eq("workspaceId", installation.workspaceId)
									.eq("resourceKind", resource.kind)
									.eq("resourceId", resource.id)
									.eq("principalKind", "service_account")
									.eq("serviceAccountId", installation.serviceAccountId),
							)
							.take(3);
						const level = access_control_file_share_level_from_permissions(
							new Set(grants.map((grant) => grant.permission)),
						);
						const target = await plugins_db_sandbox_root_target(ctx, {
							organizationId: installation.organizationId,
							workspaceId: installation.workspaceId,
							resource:
								root.target.kind === "open" ? { kind: "workspace" } : { kind: "file", nodeId: root.target.nodeId },
						});
						if (level !== root.level || !target) wrongRoots.push(plugins_sandbox_root_key(root.target));
					}
					return {
						installationId: installation._id,
						workspaceId: installation.workspaceId,
						scopeStatus: await db_scope_status(ctx.db, installation),
						state: !sandbox ? ("missing" as const) : (sandbox.rebuild?.status ?? ("ready" as const)),
						rootCount: sandbox?.roots.length ?? 0,
						wrongRoots,
					};
				}),
			),
		};
	},
});

/**
 * Pass 2 of the sandbox roots audit: every account grant that gives a root must have that root, at
 * least at that permission's level, in each ready installation of the account. Operator check, no
 * user waits on it, so it pages the whole grants table.
 */
export const audit_plugins_sandbox_grants_page = internalQuery({
	args: { cursor: v.union(v.string(), v.null()) },
	returns: paginationResultValidator(
		v.object({
			grantId: v.id("access_control_permission_grants"),
			workspaceId: v.id("organizations_workspaces"),
			missingIn: v.array(v.id("plugins_workspace_installations")),
		}),
	),
	handler: async (ctx, args) => {
		const page = await ctx.db
			.query("access_control_permission_grants")
			.withIndex("by_creation_time")
			.paginate({ cursor: args.cursor, numItems: 50 });
		const rows = [];
		for (const grant of page.page) {
			const level = plugins_SANDBOX_LEVEL_BY_PERMISSION[grant.permission];
			if (
				grant.principalKind !== "service_account" ||
				!grant.serviceAccountId ||
				!level ||
				(grant.resourceKind !== "workspace" && grant.resourceKind !== "file")
			)
				continue;
			const target = await plugins_db_sandbox_root_target(ctx, {
				organizationId: grant.organizationId,
				workspaceId: grant.workspaceId,
				resource:
					grant.resourceKind === "workspace"
						? { kind: "workspace" }
						: { kind: "file", nodeId: grant.resourceId as Id<"files_nodes"> },
			});
			if (!target) continue;
			const serviceAccountId = grant.serviceAccountId;
			const installations = await ctx.db
				.query("plugins_workspace_installations")
				.withIndex("by_serviceAccount", (q) => q.eq("serviceAccountId", serviceAccountId))
				.collect();
			const rank = { read: 0, write: 1, manage: 2 };
			const missingIn = installations
				.filter(
					(installation) =>
						installation.sandbox?.rebuild === null &&
						!installation.sandbox.roots.some(
							(root) =>
								plugins_sandbox_root_key(root.target) === plugins_sandbox_root_key(target) &&
								rank[root.level] >= rank[level],
						),
				)
				.map((installation) => installation._id);
			rows.push({ grantId: grant._id, workspaceId: grant.workspaceId, missingIn });
		}
		return { ...page, page: rows };
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
