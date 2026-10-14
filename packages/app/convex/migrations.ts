import { Migrations, type MigrationResult } from "@convex-dev/migrations";
import { createFunctionHandle, paginationResultValidator } from "convex/server";
import { v } from "convex/values";
import { components, internal } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel.js";
import { internalAction, internalQuery, type QueryCtx } from "./_generated/server.js";
import { internalMutation } from "./functions.ts";
import app_convex_schema from "./schema.ts";
import { files_pending_review_facts_db_get_state } from "../server/files-pending-review-facts.ts";
import { crypto_sha256_hex } from "../server/crypto-utils.ts";
import { files_metadata_maps_db_read } from "../server/files-metadata-maps.ts";
import { files_metadata_db_write_entries } from "./files_metadata.ts";
import { convex_error } from "../server/convex-utils.ts";
import {
	files_metadata_METADATA_FIELD_PREFIX,
	files_metadata_validate_entries,
	files_metadata_validate_remove_keys,
} from "../shared/files-metadata.ts";
import {
	metadata_migration_audit_saved,
	metadata_migration_entries_from_docs,
	metadata_migration_audit_pending,
	metadata_migration_audit_capture,
	metadata_migration_audit_review,
	metadata_migration_audit_cohort,
	metadata_migration_backfill_saved,
	metadata_migration_backfill_pending,
	metadata_migration_backfill_capture,
} from "../server/files-metadata-migration.ts";

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

/**
 * Run from packages/app: `vp env exec pnpm exec convex run migrations:run_<migration_name>`.
 */
export const run = app_migrations.runner();

export const backfill_metadata_saved = app_migrations.define({
	table: "files_nodes",
	batchSize: 1,
	migrateOne: metadata_migration_backfill_saved,
});
export const backfill_metadata_pending = app_migrations.define({
	table: "files_pending_updates",
	batchSize: 1,
	migrateOne: metadata_migration_backfill_pending,
});
export const backfill_metadata_captures = app_migrations.define({
	table: "files_transfer_items",
	batchSize: 1,
	migrateOne: metadata_migration_backfill_capture,
});

export const run_metadata_backfill = app_migrations.runner([
	internal.migrations.backfill_metadata_pending,
	internal.migrations.backfill_metadata_captures,
	internal.migrations.backfill_metadata_saved,
]);

// Each operator page visits one complete source doc. Follow every cursor to isDone.
export const audit_metadata_sources = internalQuery({
	args: {
		table: v.union(
			v.literal("files_nodes"),
			v.literal("files_pending_updates"),
			v.literal("files_transfer_items"),
			v.literal("files_pending_update_run_items"),
			v.literal("files_move_cohort_items"),
		),
		cursor: v.union(v.string(), v.null()),
	},
	returns: v.object({ isDone: v.boolean(), continueCursor: v.string(), checked: v.number() }),
	handler: async (ctx, args) => {
		const page = await ctx.db.query(args.table).paginate({ cursor: args.cursor, numItems: 1 });
		for (const value of page.page) {
			switch (args.table) {
				case "files_nodes":
					await metadata_migration_audit_saved(ctx, value as Doc<"files_nodes">);
					break;
				case "files_pending_updates":
					await metadata_migration_audit_pending(ctx, value as Doc<"files_pending_updates">);
					break;
				case "files_transfer_items":
					await metadata_migration_audit_capture(ctx, value as Doc<"files_transfer_items">);
					break;
				case "files_pending_update_run_items":
					await metadata_migration_audit_review(ctx, value as Doc<"files_pending_update_run_items">);
					break;
				case "files_move_cohort_items":
					await metadata_migration_audit_cohort(ctx, value as Doc<"files_move_cohort_items">);
					break;
			}
		}
		return { isDone: page.isDone, continueCursor: page.continueCursor, checked: page.page.length };
	},
});

export const audit_metadata_map_owners = internalQuery({
	args: { cursor: v.union(v.string(), v.null()) },
	returns: v.object({ isDone: v.boolean(), continueCursor: v.string(), checked: v.number() }),
	handler: async (ctx, args) => {
		const page = await ctx.db.query("files_metadata_maps").paginate({ cursor: args.cursor, numItems: 1 });
		for (const map of page.page) {
			const value =
				map.owner.kind === "saved"
					? await ctx.db.get("files_nodes", map.owner.id)
					: map.owner.kind === "pending"
						? await ctx.db.get("files_pending_updates", map.owner.id)
						: await ctx.db.get("files_transfer_items", map.owner.id);
			if (
				!value ||
				!("organizationId" in value) ||
				value.organizationId !== map.organizationId ||
				!("workspaceId" in value) ||
				value.workspaceId !== map.workspaceId ||
				!map.entries.length ||
				!Number.isInteger(map.revision) ||
				map.revision < 1
			)
				throw convex_error({ message: `Metadata map has no exact owner: ${map._id}` });
			if (map.owner.kind === "pending") {
				const proposal = value as Doc<"files_pending_updates">;
				if (proposal.target.kind !== "private" || !proposal.createIntent)
					throw convex_error({ message: `Metadata map has no private source: ${map._id}` });
			}
			if (map.owner.kind === "capture") {
				const item = value as Doc<"files_transfer_items">;
				const run = await ctx.db.get("files_transfer_runs", item.runId);
				if (!item.capture || !run || run.organizationId !== item.organizationId || run.workspaceId !== item.workspaceId)
					throw convex_error({ message: `Metadata map has no exact capture: ${map._id}` });
			}
			const checked = files_metadata_validate_entries(map.entries);
			if (checked._nay || JSON.stringify(checked._yay.entries) !== JSON.stringify(map.entries))
				throw convex_error({ message: `Metadata map has invalid entries: ${map._id}` });
			// unique() makes duplicate owners fail this page instead of hiding one copy.
			await ctx.db
				.query("files_metadata_maps")
				.withIndex("by_owner", (q) => q.eq("owner.kind", map.owner.kind).eq("owner.id", map.owner.id))
				.unique();
		}
		return { isDone: page.isDone, continueCursor: page.continueCursor, checked: page.page.length };
	},
});
function metadata_call_has_old_header(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const fields = value as Record<string, unknown>;
	for (const key of ["createIntent", "capture"]) {
		const header = fields[key];
		if (header && typeof header === "object" && "metadata" in header) return true;
	}
	return Object.values(fields).some(metadata_call_has_old_header);
}

export const audit_metadata_pending_calls = internalQuery({
	args: { cursor: v.union(v.string(), v.null()) },
	returns: v.object({
		isDone: v.boolean(),
		continueCursor: v.string(),
		checked: v.number(),
		pending: v.number(),
		inProgress: v.number(),
		oldHeaderCalls: v.number(),
	}),
	handler: async (ctx, args) => {
		const page = await ctx.db.system.query("_scheduled_functions").paginate({ cursor: args.cursor, numItems: 1 });
		let pending = 0;
		let inProgress = 0;
		let oldHeaderCalls = 0;
		for (const call of page.page) {
			const module = call.name.split(":")[0]!;
			if (!/^(?:files_|github_mounts|plugins_|public_api|ai_chat|data_deletion)/u.test(module)) continue;
			if (call.state.kind === "pending") pending++;
			else if (call.state.kind === "inProgress") inProgress++;
			if (
				(call.state.kind === "pending" || call.state.kind === "inProgress") &&
				metadata_call_has_old_header(call.args)
			)
				oldHeaderCalls++;
		}
		return {
			isDone: page.isDone,
			continueCursor: page.continueCursor,
			checked: page.page.length,
			pending,
			inProgress,
			oldHeaderCalls,
		};
	},
});

// One CLI call can check several pages. Each query keeps its own transaction limit.
export const audit_metadata_pages = internalAction({
	args: {
		audit: v.union(
			v.literal("audit_metadata_sources"),
			v.literal("audit_metadata_map_owners"),
			v.literal("audit_metadata_pending_calls"),
		),
		table: v.optional(
			v.union(
				v.literal("files_nodes"),
				v.literal("files_pending_updates"),
				v.literal("files_transfer_items"),
				v.literal("files_pending_update_run_items"),
				v.literal("files_move_cohort_items"),
			),
		),
		cursor: v.union(v.string(), v.null()),
		pageCount: v.number(),
	},
	returns: v.object({
		isDone: v.boolean(),
		continueCursor: v.string(),
		checked: v.number(),
		normal: v.number(),
		selected: v.number(),
		hidden: v.number(),
		pending: v.number(),
		inProgress: v.number(),
		oldHeaderCalls: v.number(),
	}),
	handler: async (
		ctx,
		args,
	): Promise<{
		isDone: boolean;
		continueCursor: string;
		checked: number;
		normal: number;
		selected: number;
		hidden: number;
		pending: number;
		inProgress: number;
		oldHeaderCalls: number;
	}> => {
		if (!Number.isInteger(args.pageCount) || args.pageCount < 1)
			throw convex_error({ message: "pageCount must be a positive whole number" });
		const result = {
			isDone: false,
			continueCursor: "",
			checked: 0,
			normal: 0,
			selected: 0,
			hidden: 0,
			pending: 0,
			inProgress: 0,
			oldHeaderCalls: 0,
		};
		let cursor = args.cursor;
		for (let index = 0; index < args.pageCount; index++) {
			let page: {
				isDone: boolean;
				continueCursor: string;
				checked: number;
				normal?: number;
				selected?: number;
				hidden?: number;
				pending?: number;
				inProgress?: number;
				oldHeaderCalls?: number;
			};
			if (args.audit === "audit_metadata_sources") {
				if (!args.table) throw convex_error({ message: "Choose a source table" });
				page = await ctx.runQuery(internal.migrations.audit_metadata_sources, { table: args.table, cursor });
			} else if (args.audit === "audit_metadata_map_owners") {
				page = await ctx.runQuery(internal.migrations.audit_metadata_map_owners, { cursor });
			} else {
				page = await ctx.runQuery(internal.migrations.audit_metadata_pending_calls, { cursor });
			}
			result.checked += page.checked;
			result.normal += page.normal ?? 0;
			result.selected += page.selected ?? 0;
			result.hidden += page.hidden ?? 0;
			result.pending += page.pending ?? 0;
			result.inProgress += page.inProgress ?? 0;
			result.oldHeaderCalls += page.oldHeaderCalls ?? 0;
			result.isDone = page.isDone;
			result.continueCursor = page.continueCursor;
			if (page.isDone) break;
			cursor = page.continueCursor;
		}
		return result;
	},
});

export const preview_metadata_backfill = internalMutation({
	args: {
		migration: v.union(v.literal("saved"), v.literal("pending"), v.literal("capture")),
		cursor: v.union(v.string(), v.null()),
		batchSize: v.optional(v.number()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		if (args.batchSize !== undefined && (!Number.isInteger(args.batchSize) || args.batchSize < 1))
			throw convex_error({ message: "batchSize must be a positive whole number" });
		const ref =
			args.migration === "saved"
				? internal.migrations.backfill_metadata_saved
				: args.migration === "pending"
					? internal.migrations.backfill_metadata_pending
					: internal.migrations.backfill_metadata_captures;
		const name =
			args.migration === "saved"
				? "migrations:backfill_metadata_saved"
				: args.migration === "pending"
					? "migrations:backfill_metadata_pending"
					: "migrations:backfill_metadata_captures";
		const result: { processed: number; isDone: boolean; cursor?: string | null } = await ctx.runMutation(
			components.migrations.lib.migrate,
			{
				name,
				fnHandle: await createFunctionHandle(ref),
				cursor: args.cursor,
				oneBatchOnly: true,
				dryRun: false,
				batchSize: args.batchSize ?? 1,
			},
		);
		throw convex_error({ message: "Metadata migration preview rolled back", data: result });
	},
});

// Fixed protection for the user's kept demo tenant.
export function metadata_cleanup_require_unprotected_scope(organizationId: string, workspaceId: string) {
	if (organizationId === "gs7k8abvmsa6nxm8dwrah5nc318bmejm" || workspaceId === "h57j1rmpsvs2b3hsyftq4pm9v18bmer4")
		throw convex_error({ message: "Sybill metadata is protected" });
}

// Temporary operator cleanup. Remove with the other migration exports in strict C.
export const cleanup_invalid_metadata_keys = internalMutation({
	args: {
		nodeId: v.id("files_nodes"),
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		expectedEntriesHash: v.string(),
	},
	returns: v.object({ removedKeys: v.number(), beforeHash: v.string(), afterHash: v.string() }),
	handler: async (ctx, args) => {
		metadata_cleanup_require_unprotected_scope(args.organizationId, args.workspaceId);
		const node = await ctx.db.get("files_nodes", args.nodeId);
		if (!node || node.organizationId !== args.organizationId || node.workspaceId !== args.workspaceId)
			throw convex_error({ message: "The metadata cleanup scope changed" });
		if (node.moveCohortId) throw convex_error({ message: "The metadata source has a Move cohort" });
		if (await files_metadata_maps_db_read(ctx.db, { kind: "saved", id: node._id }))
			throw convex_error({ message: "The metadata source already has a full map" });
		const docs = await ctx.db
			.query("files_metadata_docs")
			.withIndex("by_organization_workspace_source_fileNode_fieldPath", (q) =>
				q
					.eq("organizationId", node.organizationId)
					.eq("workspaceId", node.workspaceId)
					.eq("sourceKind", "committed")
					.eq("fileNodeId", node._id)
					.eq("moveView.cohortId", undefined)
					.eq("moveView.view", undefined)
					.gte("fieldPath", files_metadata_METADATA_FIELD_PREFIX)
					.lt("fieldPath", "metadata/"),
			)
			.collect();
		const entries = metadata_migration_entries_from_docs(docs);
		const beforeHash = await crypto_sha256_hex(JSON.stringify(entries));
		if (beforeHash !== args.expectedEntriesHash) throw convex_error({ message: "The metadata source changed" });
		const kept = entries.filter((entry) => !files_metadata_validate_remove_keys([entry.key])._nay);
		const removedKeys = entries.length - kept.length;
		if (!removedKeys) throw convex_error({ message: "The metadata source has no invalid key" });
		if (files_metadata_validate_entries(kept)._nay) throw convex_error({ message: "The kept metadata is not valid" });
		// Rebuild this one map so its value order and entry indexes agree.
		await files_metadata_db_write_entries(ctx, { fileNode: node, entries: kept });
		return { removedKeys, beforeHash, afterHash: await crypto_sha256_hex(JSON.stringify(kept)) };
	},
});

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
