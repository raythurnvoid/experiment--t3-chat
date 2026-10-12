import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { runToCompletion } from "@convex-dev/migrations";
import migrations_test from "@convex-dev/migrations/test";
import { components, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

type Scope = { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces"> };

async function fixture() {
	const t = test_convex({ transactionLimits: true });
	t.registerComponent("migrations", migrations_test.schema, migrations_test.modules);
	const scope = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx, { plan: null, integrationPolicy: null }));
	return { t, scope };
}

async function seed_state(ctx: MutationCtx, scope: Scope, pendingJobCount: number) {
	return await ctx.db.insert("files_pending_review_fact_state", {
		organizationId: scope.organizationId,
		workspaceId: scope.workspaceId,
		structureRevision: 2,
		pendingJobCount,
	});
}

/**
 * Insert a job doc like `db_schedule_job` does. Its run is far in the future, so it never starts.
 */
async function seed_job(
	ctx: MutationCtx,
	scope: Scope,
	key: string,
	job:
		| { kind: "parent"; parent: { kind: "root" } }
		| { kind: "place_fields"; placeIds: [] }
		| {
				kind: "targets";
				userId: Id<"users">;
				items: Extract<Doc<"files_pending_overlay_jobs">, { kind: "targets" }>["items"];
		  },
) {
	const nextAttemptAt = Date.now() + 60 * 60 * 1000;
	await ctx.db.insert("files_pending_overlay_jobs", {
		organizationId: scope.organizationId,
		workspaceId: scope.workspaceId,
		...job,
		key,
		cursor: null,
		nextAttemptAt,
		scheduledFunctionId: await ctx.scheduler.runAfter(60 * 60 * 1000, internal.files_pending_overlay.run_job, {
			kind: job.kind,
			key,
			nextAttemptAt,
		}),
		attempts: 0,
		reviewFactsPending: job.kind !== "place_fields",
	});
}

const repair = internal.migrations.repair_review_fact_job_counts;

test("review fact job count repair counts only review jobs and leaves a correct workspace alone", async () => {
	const { t, scope } = await fixture();
	const other = await t.run((ctx) =>
		test_mocks_fill_db_with.membership(ctx, {
			organizationName: "other-organization",
			workspaceName: "other-workspace",
			plan: null,
			integrationPolicy: null,
		}),
	);
	const stuckId = await t.run(async (ctx) => {
		await seed_job(ctx, scope, "parent-root", { kind: "parent", parent: { kind: "root" } });
		// A place fields job never counts.
		await seed_job(ctx, scope, "place-fields", { kind: "place_fields", placeIds: [] });
		return await seed_state(ctx, scope, 3);
	});
	const correctId = await t.run(async (ctx) => {
		await seed_job(ctx, other, "other-parent-root", { kind: "parent", parent: { kind: "root" } });
		return await seed_state(ctx, other, 1);
	});
	const correct = await t.run((ctx) => ctx.db.get("files_pending_review_fact_state", correctId));
	const info = vi.spyOn(console, "info");

	const status = await t.action((ctx) => runToCompletion(ctx, components.migrations, repair));

	expect(status.isDone).toBe(true);
	expect(
		(await t.run((ctx) => ctx.db.get("files_pending_review_fact_state", stuckId)))?.pendingJobCount,
		"the stuck count drops to the one counted job",
	).toBe(1);
	expect(await t.run((ctx) => ctx.db.get("files_pending_review_fact_state", correctId))).toEqual(correct);
	expect(info, "only the stuck workspace is patched and logged").toHaveBeenCalledExactlyOnceWith(
		"Repaired a review fact job count",
		{ id: stuckId, workspaceId: scope.workspaceId, old: 3, next: 1 },
	);
	expect(
		await t.query(internal.migrations.audit_review_fact_job_count, {
			organizationId: scope.organizationId,
			workspaceId: scope.workspaceId,
		}),
		"the audit reads the same counts",
	).toEqual({ pendingJobCount: 1, countedJobs: 1 });
});

test("review fact job count repair skips a workspace past the job cap within the read limit", async () => {
	const { t, scope } = await fixture();
	// 65 full `targets` docs: the cap is 64, and each doc is about 125 KiB. The fake ids have the real
	// length of 32 characters. With transaction limits on, this also proves that the capped read stays
	// under the 16 MiB read limit.
	const items = Array.from({ length: 1000 }, () => ({
		target: { kind: "private" as const, id: `${"1".repeat(13)}files_pending_nodes` as Id<"files_pending_nodes"> },
		pendingUpdateId: `${"1".repeat(11)}files_pending_updates` as Id<"files_pending_updates">,
		fieldsChanged: true,
	}));
	const stateId = await t.run(async (ctx) => {
		for (let index = 0; index < 65; index++)
			await seed_job(ctx, scope, `targets-${index}`, { kind: "targets", userId: scope.userId, items });
		return await seed_state(ctx, scope, 5);
	});
	const warn = vi.spyOn(console, "warn");

	const status = await t.action((ctx) => runToCompletion(ctx, components.migrations, repair));

	expect(status.isDone).toBe(true);
	expect(
		(await t.run((ctx) => ctx.db.get("files_pending_review_fact_state", stateId)))?.pendingJobCount,
		"a busy workspace keeps its count until a later run",
	).toBe(5);
	expect(warn).toHaveBeenCalledWith("Skipped a busy workspace in the review fact job count repair", {
		id: stateId,
		workspaceId: scope.workspaceId,
	});
});
