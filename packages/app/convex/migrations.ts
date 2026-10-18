import { Migrations, type MigrationResult } from "@convex-dev/migrations";
import { paginationResultValidator } from "convex/server";
import { v } from "convex/values";
import { components, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import { internalMutation } from "./functions.ts";
import app_convex_schema from "./schema.ts";
import { files_pending_review_facts_db_get_state } from "../server/files-pending-review-facts.ts";
import { convex_error } from "../server/convex-utils.ts";

// The schema lets a migration read through an index with `customRange`.
const app_migrations = new Migrations(components.migrations, {
	internalMutation,
	schema: app_convex_schema,
});

const REVIEW_FACT_JOBS_MAX = 64;
const ORPHAN_REVIEW_STATES = [
	{
		_id: "z17ke9ya993ekp2vc5s1528kmd8g141t",
		_creationTime: 1791612076351.4219,
		organizationId: "gs7m5gfm1gezfhs4b3de6znvb18fhh8v",
		workspaceId: "h57mgp9gk3fxdhphs0qjdkgnf58fgkkn",
	},
	{
		_id: "z17q40b09vb6ry4ht10aqmbx598g0dzm",
		_creationTime: 1791612076789.6199,
		organizationId: "gs7wasxhet2yqagkrna24mxwnx8fk5y9",
		workspaceId: "h57jj07mkk70amktr8tepqz1gs8fj84t",
	},
] as const;

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

// The user approved only these two unused zero-count docs on 2026-10-18.
export const delete_orphaned_review_fact_states = internalMutation({
	args: {},
	returns: v.number(),
	handler: async (ctx) => {
		const ids: Id<"files_pending_review_fact_state">[] = [];
		for (const expected of ORPHAN_REVIEW_STATES) {
			const id = ctx.db.normalizeId("files_pending_review_fact_state", expected._id);
			if (!id) throw convex_error({ message: "Invalid approved counter ID." });
			const state = await ctx.db.get("files_pending_review_fact_state", id);
			if (!state) continue;
			if (
				state._creationTime !== expected._creationTime ||
				state.organizationId !== expected.organizationId ||
				state.workspaceId !== expected.workspaceId ||
				state.pendingJobCount !== 0 ||
				state.structureRevision !== 1 ||
				state.structurePinnedUntil !== undefined
			)
				throw convex_error({ message: "Counter record changed. No records were deleted." });
			if ((await db_scope_status(ctx.db, state)) !== "invalid_tenant")
				throw convex_error({ message: "Counter scope changed. No records were deleted." });
			const [organization, workspace, job, organizationPurge, workspacePurge] = await Promise.all([
				ctx.db.get("organizations", state.organizationId),
				ctx.db.get("organizations_workspaces", state.workspaceId),
				ctx.db
					.query("files_pending_overlay_jobs")
					.withIndex("by_org_ws", (q) =>
						q.eq("organizationId", state.organizationId).eq("workspaceId", state.workspaceId),
					)
					.first(),
				ctx.db
					.query("data_deletion_requests")
					.withIndex("by_organization_scope", (q) =>
						q.eq("organizationId", state.organizationId).eq("scope", "organization"),
					)
					.first(),
				ctx.db
					.query("data_deletion_requests")
					.withIndex("by_organization_workspace_scope", (q) =>
						q.eq("organizationId", state.organizationId).eq("workspaceId", state.workspaceId).eq("scope", "workspace"),
					)
					.first(),
			]);
			if (organization || workspace || job || organizationPurge || workspacePurge)
				throw convex_error({ message: "Counter scope changed. No records were deleted." });
			ids.push(id);
		}
		// Check both docs before deleting either one.
		for (const id of ids) await ctx.db.delete("files_pending_review_fact_state", id);
		return ids.length;
	},
});

/**
 * Run from packages/app: `vp env exec pnpm exec convex run migrations:run_<migration_name>`.
 */
export const run = app_migrations.runner();

if (process.env.NODE_ENV === "test" && import.meta.vitest) {
	const { test, expect, vi } = import.meta.vitest;
	// The wrapped mutation keeps Convex's handler at runtime.
	const delete_orphans = delete_orphaned_review_fact_states as unknown as {
		_handler: (ctx: MutationCtx, args: Record<string, never>) => Promise<number>;
	};

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

	function orphan_fixture() {
		const docs = new Map<string, Record<string, unknown>>(
			ORPHAN_REVIEW_STATES.map((state) => [state._id, { ...state, pendingJobCount: 0, structureRevision: 1 }]),
		);
		const blocked = { table: "", index: "", organizationId: "" };
		const db = {
			normalizeId: vi.fn((_table: string, id: string) => id),
			get: vi.fn(async (_table: string, id: string) => docs.get(id) ?? null),
			query: vi.fn((table: string) => ({
				withIndex: (
					index: string,
					callback: (range: { eq: (field: string, value: unknown) => unknown }) => unknown,
				) => {
					const filters: Record<string, unknown> = {};
					const range = {
						eq(field: string, value: unknown) {
							filters[field] = value;
							return this;
						},
					};
					callback(range);
					return {
						first: async () =>
							blocked.table === table && blocked.index === index && blocked.organizationId === filters.organizationId
								? { _id: "pending-work" }
								: null,
					};
				},
			})),
			delete: vi.fn(async (_table: string, id: string) => {
				docs.delete(id);
			}),
		};
		return { docs, blocked, db, ctx: { db } as unknown as MutationCtx };
	}

	test("orphan counter delete changes only the approved IDs and is safe to repeat", async () => {
		const f = orphan_fixture();
		f.docs.set("other-state", { pendingJobCount: 0 });
		expect(await delete_orphans._handler(f.ctx, {})).toBe(2);
		expect(f.db.delete.mock.calls).toEqual([
			["files_pending_review_fact_state", "z17ke9ya993ekp2vc5s1528kmd8g141t"],
			["files_pending_review_fact_state", "z17q40b09vb6ry4ht10aqmbx598g0dzm"],
		]);
		expect(f.docs.get("other-state")).toEqual({ pendingJobCount: 0 });
		expect(await delete_orphans._handler(f.ctx, {})).toBe(0);
		expect(f.db.delete).toHaveBeenCalledTimes(2);
	});

	test.each([
		["pendingJobCount", 1],
		["structureRevision", 2],
		["structurePinnedUntil", 0],
		["_creationTime", 0],
		["organizationId", "gs7k8abvmsa6nxm8dwrah5nc318bmejm"],
		["workspaceId", "h57j1rmpsvs2b3hsyftq4pm9v18bmer4"],
	] as const)("orphan counter delete keeps both docs when the second %s changed", async (field, value) => {
		const f = orphan_fixture();
		const state = f.docs.get(ORPHAN_REVIEW_STATES[1]._id);
		if (!state) throw new Error("Missing second counter fixture");
		state[field] = value;
		const before = structuredClone(f.docs);
		const error = await delete_orphans._handler(f.ctx, {}).catch((error: unknown) => error);
		expect(f.db.delete, "a changed second counter keeps both approved docs").not.toHaveBeenCalled();
		expect(f.docs).toEqual(before);
		expect(error).toMatchObject({ data: { message: "Counter record changed. No records were deleted." } });
	});

	test.each(["organizations", "organizations_workspaces"])(
		"orphan counter delete keeps both docs if the second %s exists",
		async (table) => {
			const f = orphan_fixture();
			const state = ORPHAN_REVIEW_STATES[1];
			const id = table === "organizations" ? state.organizationId : state.workspaceId;
			f.docs.set(id, { _id: id });
			const error = await delete_orphans._handler(f.ctx, {}).catch((error: unknown) => error);
			expect(f.db.delete, "an existing second tenant keeps both approved docs").not.toHaveBeenCalled();
			expect(error).toMatchObject({ data: { message: "Counter scope changed. No records were deleted." } });
		},
	);

	test.each([
		["files_pending_overlay_jobs", "by_org_ws"],
		["data_deletion_requests", "by_organization_scope"],
		["data_deletion_requests", "by_organization_workspace_scope"],
	])("orphan counter delete keeps both docs for second-scope work in %s/%s", async (table, index) => {
		const f = orphan_fixture();
		Object.assign(f.blocked, { table, index, organizationId: ORPHAN_REVIEW_STATES[1].organizationId });
		const before = structuredClone(f.docs);
		const error = await delete_orphans._handler(f.ctx, {}).catch((error: unknown) => error);
		expect(f.db.delete, "second-scope work keeps both approved docs").not.toHaveBeenCalled();
		expect(f.docs).toEqual(before);
		expect(error).toMatchObject({ data: { message: "Counter scope changed. No records were deleted." } });
	});
}
