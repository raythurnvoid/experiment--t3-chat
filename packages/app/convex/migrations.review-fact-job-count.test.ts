import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { runToCompletion } from "@convex-dev/migrations";
import migrations_test from "@convex-dev/migrations/test";
import type { FunctionReturnType } from "convex/server";
import { ConvexError } from "convex/values";
import { components, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
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
		"Updating a review fact job count",
		{ id: stuckId, workspaceId: scope.workspaceId, old: 3, next: 1 },
	);
	expect(
		await t.query(internal.migrations.audit_review_fact_job_count, {
			organizationId: scope.organizationId,
			workspaceId: scope.workspaceId,
		}),
		"the audit reads the same counts",
	).toEqual({ pendingJobCount: 1, countedJobs: 1, scopeStatus: "allowed" });
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
		"a scope past the cap keeps its unresolved count",
	).toBe(5);
	expect(warn).toHaveBeenCalledWith("Skipped a workspace past the review fact job cap", {
		id: stateId,
		workspaceId: scope.workspaceId,
	});
	expect(
		await t.query(internal.migrations.audit_review_fact_job_count, {
			organizationId: scope.organizationId,
			workspaceId: scope.workspaceId,
		}),
	).toEqual({
		pendingJobCount: 5,
		countedJobs: null,
		scopeStatus: "allowed",
	});
});

test.each([
	{ organizationName: "personal", workspaceName: "sybill", protectedScope: true },
	{ organizationName: "personal", workspaceName: "other", protectedScope: false },
	{ organizationName: "other", workspaceName: "sybill", protectedScope: false },
])("review fact repair checks the full protected name pair: $organizationName/$workspaceName", async (names) => {
	const { t } = await fixture();
	const scope = await t.run((ctx) =>
		test_mocks_fill_db_with.membership(ctx, {
			organizationName: "named-protection",
			workspaceName: names.workspaceName,
			plan: null,
			integrationPolicy: null,
		}),
	);
	const stateId = await t.run(async (ctx) => {
		// `personal` is reserved by user bootstrap. Set the legacy fixture's name directly.
		await ctx.db.patch("organizations", scope.organizationId, { name: names.organizationName });
		await seed_job(ctx, scope, "named-parent", { kind: "parent", parent: { kind: "root" } });
		return await seed_state(ctx, scope, 3);
	});
	const before = await t.run((ctx) => ctx.db.get("files_pending_review_fact_state", stateId));
	await t.mutation(repair, { cursor: null, batchSize: 1, dryRun: false, oneBatchOnly: true });
	const after = await t.run((ctx) => ctx.db.get("files_pending_review_fact_state", stateId));
	expect(after, "protected named state stays unchanged").toEqual(
		names.protectedScope ? before : { ...before, pendingJobCount: 1 },
	);
	expect(
		await t.query(internal.migrations.audit_review_fact_job_count, {
			organizationId: scope.organizationId,
			workspaceId: scope.workspaceId,
		}),
	).toEqual({
		pendingJobCount: names.protectedScope ? 3 : 1,
		countedJobs: names.protectedScope ? null : 1,
		scopeStatus: names.protectedScope ? "protected" : "allowed",
	});
	if (names.protectedScope) {
		await t.run(async (ctx) => {
			await ctx.db.patch("organizations", scope.organizationId, { name: "PeRsOnAl" });
			await ctx.db.patch("organizations_workspaces", scope.workspaceId, { name: "SyBiLl" });
		});
		await t.mutation(repair, { cursor: null, batchSize: 1, dryRun: false, oneBatchOnly: true });
		expect(await t.run((ctx) => ctx.db.get("files_pending_review_fact_state", stateId))).toEqual(before);
	}
});

test.each(["missing_organization", "missing_workspace", "foreign_workspace"] as const)(
	"review fact repair leaves an invalid tenant unresolved: %s",
	async (kind) => {
		const { t, scope } = await fixture();
		const other = await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, {
				organizationName: "foreign",
				plan: null,
				integrationPolicy: null,
			}),
		);
		const stateId = await t.run(async (ctx) => {
			await seed_job(ctx, scope, "invalid-parent", { kind: "parent", parent: { kind: "root" } });
			return await seed_state(ctx, scope, 3);
		});
		const before = await t.run((ctx) => ctx.db.get("files_pending_review_fact_state", stateId));
		await t.run(async (ctx) => {
			if (kind === "missing_organization") await ctx.db.delete("organizations", scope.organizationId);
			if (kind === "missing_workspace") await ctx.db.delete("organizations_workspaces", scope.workspaceId);
			if (kind === "foreign_workspace")
				await ctx.db.patch("organizations_workspaces", scope.workspaceId, { organizationId: other.organizationId });
		});
		await t.mutation(repair, { cursor: null, batchSize: 1, dryRun: false, oneBatchOnly: true });
		expect(
			await t.run((ctx) => ctx.db.get("files_pending_review_fact_state", stateId)),
			"invalid tenant state stays unchanged",
		).toEqual(before);
		expect(
			await t.query(internal.migrations.audit_review_fact_job_count, {
				organizationId: scope.organizationId,
				workspaceId: scope.workspaceId,
			}),
		).toEqual({ pendingJobCount: 3, countedJobs: null, scopeStatus: "invalid_tenant" });
	},
);

test("review fact audit includes zero counts beyond the first native page", async () => {
	const { t, scope } = await fixture();
	const other = await t.run((ctx) =>
		test_mocks_fill_db_with.membership(ctx, {
			organizationName: "later-zero",
			plan: null,
			integrationPolicy: null,
		}),
	);
	const firstId = await t.run((ctx) => seed_state(ctx, scope, 0));
	const zeroId = await t.run(async (ctx) => {
		await seed_job(ctx, other, "zero-parent", { kind: "parent", parent: { kind: "root" } });
		return await seed_state(ctx, other, 0);
	});
	const states = [];
	let cursor: string | null = null;
	let pages = 0;
	while (true) {
		const page: FunctionReturnType<typeof internal.migrations.audit_review_fact_state_page> = await t.query(
			internal.migrations.audit_review_fact_state_page,
			{ cursor },
		);
		states.push(...page.page);
		pages++;
		if (page.isDone) break;
		expect(pages, "native pages reach their final page").toBeLessThan(5);
		cursor = page.continueCursor;
	}
	expect(
		states.map((state) => state.stateId),
		"every state appears once, including the later zero",
	).toEqual([firstId, zeroId]);
	expect(pages).toBeGreaterThan(1);
	expect(states[1]).toEqual({
		stateId: zeroId,
		organizationId: other.organizationId,
		workspaceId: other.workspaceId,
		pendingJobCount: 0,
		scopeStatus: "allowed",
	});
	expect(
		await t.query(internal.migrations.audit_review_fact_job_count, {
			organizationId: other.organizationId,
			workspaceId: other.workspaceId,
		}),
	).toEqual({ pendingJobCount: 0, countedJobs: 1, scopeStatus: "allowed" });
	expect(
		await t.query(internal.migrations.audit_review_fact_job_count, {
			organizationId: scope.organizationId,
			workspaceId: scope.workspaceId,
		}),
	).toEqual({ pendingJobCount: 0, countedJobs: 0, scopeStatus: "allowed" });
});

test("review fact audit leaves a state removed after enumeration unresolved", async () => {
	const { t, scope } = await fixture();
	const stateId = await t.run((ctx) => seed_state(ctx, scope, 0));
	const page = await t.query(internal.migrations.audit_review_fact_state_page, { cursor: null });
	expect(page.page.map((state) => state.stateId)).toEqual([stateId]);
	await t.run((ctx) => ctx.db.delete("files_pending_review_fact_state", stateId));
	expect(
		await t.query(internal.migrations.audit_review_fact_job_count, {
			organizationId: scope.organizationId,
			workspaceId: scope.workspaceId,
		}),
		"a missing state is not a zero count or a match",
	).toBeNull();
});

test("review fact audit stays unresolved above the cap even when every job is uncounted", async () => {
	const { t, scope } = await fixture();
	const stateId = await t.run(async (ctx) => {
		for (let index = 0; index < 65; index++)
			await seed_job(ctx, scope, `uncounted-${index}`, { kind: "place_fields", placeIds: [] });
		return await seed_state(ctx, scope, 3);
	});
	const before = await t.run((ctx) => ctx.db.get("files_pending_review_fact_state", stateId));
	const status = await t.action((ctx) => runToCompletion(ctx, components.migrations, repair));
	expect(status.isDone).toBe(true);
	expect(await t.run((ctx) => ctx.db.get("files_pending_review_fact_state", stateId))).toEqual(before);
	expect(
		await t.query(internal.migrations.audit_review_fact_job_count, {
			organizationId: scope.organizationId,
			workspaceId: scope.workspaceId,
		}),
		"past-cap is unresolved even after the migration visits every state",
	).toEqual({
		pendingJobCount: 3,
		countedJobs: null,
		scopeStatus: "allowed",
	});
});

test("review fact preview rolls back real patches and pages without scheduling a worker", async () => {
	const { t, scope } = await fixture();
	const other = await t.run((ctx) =>
		test_mocks_fill_db_with.membership(ctx, {
			organizationName: "second-preview",
			plan: null,
			integrationPolicy: null,
		}),
	);
	const firstId = await t.run(async (ctx) => {
		await seed_job(ctx, scope, "preview-parent", { kind: "parent", parent: { kind: "root" } });
		return await seed_state(ctx, scope, 3);
	});
	const secondId = await t.run((ctx) => seed_state(ctx, other, 3));
	const before = await t.run(async (ctx) => ({
		first: await ctx.db.get("files_pending_review_fact_state", firstId),
		second: await ctx.db.get("files_pending_review_fact_state", secondId),
		jobs: await ctx.db.query("files_pending_overlay_jobs").collect(),
	}));
	const read_scheduled = async (ctx: QueryCtx) => await ctx.db.system.query("_scheduled_functions").collect();
	// The test fork exposes this method at runtime, as in setup-teardown.test.ts.
	const { runInComponent } = t as unknown as {
		runInComponent: (path: string, handler: typeof read_scheduled) => ReturnType<typeof read_scheduled>;
	};
	const rootScheduled = await t.run(read_scheduled);
	const componentScheduled = await runInComponent("migrations", read_scheduled);
	const componentStatus = await t.query(components.migrations.lib.getStatus, {});
	const info = vi.spyOn(console, "info");
	const debug = vi.spyOn(console, "debug");
	let cursor: string | null = null;

	for (let index = 0; index < 3; index++) {
		const error: unknown = await t.mutation(internal.migrations.preview_review_fact_job_counts, { cursor }).then(
			() => null,
			(error: unknown) => error,
		);
		// This must fail first when the outer rollback throw is removed.
		expect(
			await t.run((ctx) => ctx.db.get("files_pending_review_fact_state", firstId)),
			"preview keeps the first stored count",
		).toEqual(before.first);
		expect(await t.run((ctx) => ctx.db.get("files_pending_review_fact_state", secondId))).toEqual(before.second);
		expect(await t.run((ctx) => ctx.db.query("files_pending_overlay_jobs").collect())).toEqual(before.jobs);
		expect(await t.run(read_scheduled)).toEqual(rootScheduled);
		expect(await runInComponent("migrations", read_scheduled)).toEqual(componentScheduled);
		expect(await t.query(components.migrations.lib.getStatus, {})).toEqual(componentStatus);
		expect(error).toBeInstanceOf(ConvexError);
		if (!(error instanceof ConvexError)) throw new Error("Preview did not return a ConvexError");
		expect(error.data, "preview exposes only its fixed message and batch fields").toEqual({
			message: "Review fact job count preview rolled back.",
			data: { processed: index < 2 ? 1 : 0, continueCursor: expect.any(String), isDone: index === 2 },
		});
		const result: { continueCursor: string; isDone: boolean } = error.data.data;
		if (result.isDone) break;
		cursor = result.continueCursor;
	}
	expect(info).toHaveBeenCalledTimes(2);
	expect(info).toHaveBeenNthCalledWith(1, "Updating a review fact job count", {
		id: firstId,
		workspaceId: scope.workspaceId,
		old: 3,
		next: 1,
	});
	expect(info).toHaveBeenNthCalledWith(2, "Updating a review fact job count", {
		id: secondId,
		workspaceId: other.workspaceId,
		old: 3,
		next: 0,
	});
	expect(debug, "preview never uses the package's full-doc dry-run logs").not.toHaveBeenCalled();
});
