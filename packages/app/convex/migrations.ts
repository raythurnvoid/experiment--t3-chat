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
import { files_ROOT_ID } from "../server/files.ts";
import { access_control_db_set_service_account_grant } from "./access_control.ts";
import { files_nodes_db_set_extended_scope } from "./files_nodes.ts";
import { files_subtree_ops_db_start_rebuild, files_subtree_ops_STEP_MAX_NODES } from "./files_subtree_ops.ts";

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

// One-time backfill and grant move for "Add people". Remove these temporary tools and tests after
// both runs and a complete audit.
export const backfill_files_nodes_extended_scope = app_migrations.define({
	table: "files_nodes",
	// A node doc is small and this reads nothing else.
	batchSize: 100,
	migrateOne: async (_ctx, node) => {
		if (node.extendedScopeNodeId !== undefined) return;
		// No item had added people before, so every item starts with an empty chain.
		return { extendedScopeNodeId: null };
	},
});

export const run_backfill_files_nodes_extended_scope = app_migrations.runner(
	internal.migrations.backfill_files_nodes_extended_scope,
);

/**
 * Every file grant must sit on a restricted or an extended root:
 * - on a root: keep it;
 * - on an item inside a restricted folder: it gave nothing, so delete it;
 * - on an open item: make the item an extended root, so the grant now reaches the items inside.
 * An extended root holds view and edit only, so a manage grant there is lowered to edit.
 * The old exact-grant check still answers during the run, so nobody loses view or edit.
 */
export const migrate_file_grants_to_scope_roots = app_migrations.define({
	table: "access_control_permission_grants",
	// One grant per batch: making a folder an extended root runs the first step of its scope job.
	batchSize: 1,
	migrateOne: async (ctx, grant) => {
		if (grant.resourceKind !== "file" || grant.principalKind === "public") return;
		const node = await ctx.db.get("files_nodes", grant.resourceId as Id<"files_nodes">);
		if (!node || node.organizationId !== grant.organizationId || node.workspaceId !== grant.workspaceId) {
			console.warn("Skipped a file grant without its node", { id: grant._id, resourceId: grant.resourceId });
			return;
		}
		if (node.restrictedScopeNodeId === node._id) return;
		// GLOBAL and plugin volume trees, or a tenant being removed. Leave them for the audit.
		const scopeStatus = await db_scope_status(ctx.db, grant);
		if (scopeStatus === "invalid_tenant") {
			console.warn("Skipped a file grant without a valid tenant", { id: grant._id });
			return;
		}
		// While a restrict or unrestrict job runs, the stored scope is old. The root flag changes at
		// once, so find the real scope from the parents. A later run picks up a skipped grant.
		let liveScopeNodeId: Id<"files_nodes"> | null = null;
		for (let parentId = node.parentId; parentId !== files_ROOT_ID;) {
			const parent = await ctx.db.get("files_nodes", parentId);
			if (!parent) break;
			if (parent.isRestrictedScopeRoot) {
				liveScopeNodeId = parent._id;
				break;
			}
			parentId = parent.parentId;
		}
		if (liveScopeNodeId !== node.restrictedScopeNodeId) {
			console.warn("Skipped a file grant while its scope changes", { id: grant._id, nodeId: node._id });
			return;
		}
		const isExtendedRoot = node.parentExtendedScopeNodeId !== undefined;
		const isDormant = node.restrictedScopeNodeId !== null && !isExtendedRoot;
		if (!isDormant && isExtendedRoot && grant.permission !== "content.permissions.manage") return;
		// Deleting or lowering a grant in the protected workspace needs the user's yes first.
		if (scopeStatus !== "allowed" && (isDormant || grant.permission === "content.permissions.manage")) {
			console.warn("Skipped a protected file grant change", { id: grant._id, isDormant, scopeStatus });
			return;
		}

		const account = grant.serviceAccountId
			? await ctx.db.get("access_control_service_accounts", grant.serviceAccountId)
			: null;
		const set_account_level = async (level: "write" | null) => {
			const result = await access_control_db_set_service_account_grant(ctx, {
				organizationId: grant.organizationId,
				workspaceId: grant.workspaceId,
				serviceAccountId: grant.serviceAccountId!,
				resource: { kind: "file", nodeId: node._id },
				level,
			});
			if (result._nay) throw convex_error(result._nay);
		};

		if (isDormant) {
			console.info("Deleting a file grant inside a restricted folder", { id: grant._id, nodeId: node._id });
			// The account writer deletes all of the account's docs here and keeps its plugin roots right.
			if (grant.principalKind === "service_account") await set_account_level(null);
			else await ctx.db.delete("access_control_permission_grants", grant._id);
			return;
		}

		if (!isExtendedRoot) {
			console.info("Making an item with a file grant an extended root", { id: grant._id, nodeId: node._id });
			await files_nodes_db_set_extended_scope(ctx, { nodeId: node._id, extended: true });
			const organization = (await ctx.db.get("organizations", grant.organizationId))!;
			await files_subtree_ops_db_start_rebuild(ctx, {
				kind: "scope",
				organizationId: grant.organizationId,
				workspaceId: grant.workspaceId,
				userId: organization.ownerUserId,
				membership: null,
				roots: [{ node, oldTreePath: node.treePath }],
				budget: { nodes: files_subtree_ops_STEP_MAX_NODES, hasPaginated: false },
				now: Date.now(),
			});
		}
		if (grant.permission === "content.permissions.manage") {
			console.info("Lowering a manage grant on an extended root to edit", { id: grant._id, nodeId: node._id });
			// A revoked account cannot get a new level, so its grant goes.
			if (grant.principalKind === "service_account")
				await set_account_level(account?.revokedAt === null ? "write" : null);
			else await ctx.db.delete("access_control_permission_grants", grant._id);
		}
	},
});

export const run_migrate_file_grants_to_scope_roots = app_migrations.runner(
	internal.migrations.migrate_file_grants_to_scope_roots,
);

export const preview_migrate_file_grants_to_scope_roots = internalMutation({
	args: { cursor: v.union(v.string(), v.null()), batchSize: v.number() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const result: MigrationResult = await ctx.runMutation(internal.migrations.migrate_file_grants_to_scope_roots, {
			cursor: args.cursor,
			batchSize: args.batchSize,
			dryRun: false,
			oneBatchOnly: true,
		});
		// Throw to roll back the nested writes.
		throw convex_error({
			message: "File grant move preview rolled back.",
			data: { processed: result.processed, continueCursor: result.continueCursor, isDone: result.isDone },
		});
	},
});

/** Before the runs: no live Move and no scope op anywhere. Both tables are small. */
export const audit_files_extended_scope_precheck = internalQuery({
	args: {},
	returns: v.object({
		liveMoveWorkspaceIds: v.array(v.id("organizations_workspaces")),
		scopeOpIds: v.array(v.id("files_subtree_ops")),
	}),
	handler: async (ctx) => {
		const [slots, ops] = await Promise.all([
			ctx.db.query("files_move_workspace_slots").take(1_000),
			ctx.db.query("files_subtree_ops").take(1_000),
		]);
		return {
			liveMoveWorkspaceIds: slots.filter((slot) => slot.cohortId !== null).map((slot) => slot.workspaceId),
			scopeOpIds: ops.filter((op) => op.kind === "scope").map((op) => op._id),
		};
	},
});

const extended_scope_audit_problem_validator = v.object({
	id: v.string(),
	problem: v.union(
		v.literal("missing_field"),
		v.literal("wrong_chain"),
		v.literal("wrong_parent_chain"),
		v.literal("grant_not_on_root"),
		v.literal("dormant_grant"),
		v.literal("manage_on_extended_root"),
	),
	scopeStatus: v.union(v.literal("allowed"), v.literal("protected"), v.literal("invalid_tenant")),
	// Grant problems only. A manage grant is lowered, and a dormant grant is deleted.
	permission: v.optional(v.string()),
});

/**
 * Every node has the field, and its chain matches its parent: a restricted root has null, an
 * extended root points at itself and stores its parent's chain, any other node has its parent's
 * chain. A page lists only problems, so an empty page can still continue.
 */
export const audit_files_nodes_extended_scope = internalQuery({
	args: { cursor: v.union(v.string(), v.null()) },
	returns: paginationResultValidator(extended_scope_audit_problem_validator),
	handler: async (ctx, args) => {
		const page = await ctx.db
			.query("files_nodes")
			.withIndex("by_creation_time")
			.paginate({ cursor: args.cursor, numItems: 200 });
		const checked = await Promise.all(
			page.page.map(async (node) => {
				const problem = async () => {
					if (node.moveCohortId) return null;
					if (node.extendedScopeNodeId === undefined) return "missing_field" as const;
					const parent = node.parentId === "root" ? null : await ctx.db.get("files_nodes", node.parentId);
					const parentChain = parent?.extendedScopeNodeId ?? null;
					const isExtendedRoot = node.parentExtendedScopeNodeId !== undefined;
					const expected = node.restrictedScopeNodeId === node._id ? null : isExtendedRoot ? node._id : parentChain;
					if (node.extendedScopeNodeId !== expected) return "wrong_chain" as const;
					if (isExtendedRoot && node.parentExtendedScopeNodeId !== parentChain) return "wrong_parent_chain" as const;
					return null;
				};
				const found = await problem();
				if (!found) return null;
				// GLOBAL and plugin volume trees have no organization or workspace doc.
				const organizationId = ctx.db.normalizeId("organizations", node.organizationId);
				const workspaceId = ctx.db.normalizeId("organizations_workspaces", node.workspaceId);
				const scopeStatus =
					organizationId && workspaceId
						? await db_scope_status(ctx.db, { organizationId, workspaceId })
						: ("invalid_tenant" as const);
				return { id: node._id, problem: found, scopeStatus };
			}),
		);
		return { ...page, page: checked.filter((problem) => problem !== null) };
	},
});

/** Every file grant sits on a restricted or an extended root, and no extended root holds manage. */
export const audit_file_grants_on_scope_roots = internalQuery({
	args: { cursor: v.union(v.string(), v.null()) },
	returns: paginationResultValidator(extended_scope_audit_problem_validator),
	handler: async (ctx, args) => {
		const page = await ctx.db
			.query("access_control_permission_grants")
			.withIndex("by_creation_time")
			.paginate({ cursor: args.cursor, numItems: 200 });
		const checked = await Promise.all(
			page.page.map(async (grant) => {
				if (grant.resourceKind !== "file" || grant.principalKind === "public") return null;
				const node = await ctx.db.get("files_nodes", grant.resourceId as Id<"files_nodes">);
				if (!node || node.restrictedScopeNodeId === node._id) return null;
				const problem =
					node.parentExtendedScopeNodeId !== undefined
						? grant.permission === "content.permissions.manage"
							? ("manage_on_extended_root" as const)
							: null
						: node.restrictedScopeNodeId !== null
							? ("dormant_grant" as const)
							: ("grant_not_on_root" as const);
				return problem
					? { id: grant._id, problem, scopeStatus: await db_scope_status(ctx.db, grant), permission: grant.permission }
					: null;
			}),
		);
		return { ...page, page: checked.filter((problem) => problem !== null) };
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
