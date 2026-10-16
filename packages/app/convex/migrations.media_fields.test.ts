import migrations_test from "@convex-dev/migrations/test";
import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, components, internal } from "./_generated/api.js";
import type { QueryCtx } from "./_generated/server.js";
import { test_convex, test_finish_pending_update_run, test_mocks_fill_db_with } from "./setup.test.ts";
import { files_media_dependencies_db_create } from "./files_media_dependencies.ts";
import { files_metadata_maps_db_write } from "../server/files-metadata-maps.ts";

const migrations = [
	{
		kind: "review",
		table: "files_pending_update_run_items",
		definition: internal.migrations.remove_review_media_fields,
		runner: internal.migrations.run_remove_review_media_fields,
	},
	{
		kind: "move",
		table: "files_move_cohort_items",
		definition: internal.migrations.remove_move_media_fields,
		runner: internal.migrations.run_remove_move_media_fields,
	},
] as const;

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

async function fixture() {
	const t = test_convex({ transactionLimits: true });
	t.registerComponent("migrations", migrations_test.schema, migrations_test.modules);
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId };
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const created = await t.mutation(internal.files_nodes.create_private_node_by_path, {
		...scope,
		kind: "folder",
		path: "/old-media-fields",
	});
	if (created._nay || !created._yay.pendingUpdateId || created._yay.target.kind !== "private")
		throw new Error("Expected the native folder proposal");
	const proposalId = created._yay.pendingUpdateId;
	const privateNodeId = created._yay.target.id;
	const proposal = (await t.run((ctx) => ctx.db.get("files_pending_updates", proposalId)))!;
	const started = await asUser.mutation(api.files_pending_update_runs.start, {
		membershipId: db.membershipId,
		requestId: "old-media-fields",
		kind: "accept",
		expectedItemCount: 1,
		items: [{ pendingUpdateId: proposalId, reviewedRevision: proposal.revision, selectedContentStateId: null }],
	});
	if (started._nay) throw new Error(started._nay.message);
	expect(
		await asUser.mutation(api.files_pending_update_runs.seal, {
			membershipId: db.membershipId,
			runId: started._yay.runId,
		}),
	).toEqual({ _yay: null });
	await test_finish_pending_update_run(asUser, started._yay.runId);
	// Review finishes before its separate hold-release job runs.
	await t.mutation(internal.files_pending_holds.release_producer, {
		producer: { kind: "files_pending_update_run", id: started._yay.runId },
	});
	const docs = await t.run(async (ctx) => {
		const review = (await ctx.db
			.query("files_pending_update_run_items")
			.withIndex("by_run_order", (q) => q.eq("runId", started._yay.runId))
			.unique())!;
		const unit = (await ctx.db.get("files_pending_update_run_units", review.unitId!))!;
		const cohort = (await ctx.db.get("files_move_cohorts", unit.cohortId!))!;
		const move = (await ctx.db
			.query("files_move_cohort_items")
			.withIndex("by_cohort_order", (q) => q.eq("cohortId", cohort._id))
			.unique())!;
		const receipt = (await ctx.db
			.query("files_pending_node_publish_receipts")
			.withIndex("by_privateNode", (q) => q.eq("privateNodeId", privateNodeId))
			.unique())!;
		expect((await ctx.db.get("files_pending_update_runs", review.runId))?.step).toBe("finished");
		expect(unit).toMatchObject({ status: "completed", workId: null, attemptDeadlineAt: null, dependentsSettled: true });
		expect(cohort).toMatchObject({ phase: "complete", workId: null });
		expect(cohort.runJob).toBeUndefined();
		expect(
			await ctx.db
				.query("files_pending_holds")
				.withIndex("by_pendingUpdate", (q) => q.eq("pendingUpdateId", proposalId))
				.collect(),
			"the normal producer release leaves no exact-proposal hold",
		).toEqual([]);
		// These null properties are valid stored values from the prior schema.
		await ctx.db.patch("files_pending_update_run_items", review._id, { mediaDependencySet: null });
		await ctx.db.patch("files_move_cohort_items", move._id, { mediaDependencySet: null });
		await files_metadata_maps_db_write(ctx.db, {
			...scope,
			owner: { kind: "saved", id: receipt.savedNodeId },
			entries: [{ key: "keep", value: "saved metadata" }],
		});
		const set = await files_media_dependencies_db_create(ctx, {
			...scope,
			owner: { kind: "cleanup" },
			expectedCount: 0,
		});
		if (set._nay) throw new Error(set._nay.message);
		return { review, move, unit, cohort, setId: set._yay };
	});
	return { t, db, scope, proposal, proposalId, ...docs };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Migration = (typeof migrations)[number];

async function read_item(f: Fixture, migration: Migration) {
	return await f.t.run(async (ctx) =>
		migration.kind === "review"
			? await ctx.db.get("files_pending_update_run_items", f.review._id)
			: await ctx.db.get("files_move_cohort_items", f.move._id),
	);
}

async function migrate(f: Fixture, migration: Migration) {
	return await f.t.mutation(migration.definition, {
		cursor: null,
		batchSize: 1,
		dryRun: false,
		oneBatchOnly: true,
	});
}

async function controls(ctx: QueryCtx) {
	return {
		files: await ctx.db.query("files_nodes").collect(),
		metadata: await ctx.db.query("files_metadata_docs").collect(),
		maps: await ctx.db.query("files_metadata_maps").collect(),
		sets: await ctx.db.query("files_media_dependency_sets").collect(),
		mappings: await ctx.db.query("files_media_dependencies").collect(),
		content: await ctx.db.query("files_move_cohort_content").collect(),
		yjs: await ctx.db.query("files_pending_update_yjs_states").collect(),
		assets: await ctx.db.query("files_r2_assets").collect(),
		overlayJobs: await ctx.db.query("files_pending_overlay_jobs").collect(),
		access: await ctx.db.query("files_access_versions").collect(),
		holds: await ctx.db.query("files_pending_holds").collect(),
		cohorts: await ctx.db.query("files_move_cohorts").collect(),
		runs: await ctx.db.query("files_pending_update_runs").collect(),
		units: await ctx.db.query("files_pending_update_run_units").collect(),
	};
}

async function expect_blocked(f: Fixture, migration: Migration, scopeStatus: string) {
	const before = await read_item(f, migration);
	const untouched = await f.t.run(controls);
	const error: unknown = await migrate(f, migration).catch((error: unknown) => error);
	expect(await read_item(f, migration), `${scopeStatus} keeps the full item`).toEqual(before);
	expect(await f.t.run(controls), "a refused registered mutation leaves every control unchanged").toEqual(untouched);
	expect(error).toBeInstanceOf(ConvexError);
	if (!(error instanceof ConvexError)) throw new Error("Expected the blocked cleanup error");
	expect(error.data).toEqual({
		message: "Old media cleanup is blocked.",
		data: { id: before!._id, scopeStatus },
	});
}

describe.each(migrations)("old $kind media fields", (migration) => {
	test("keeps every other value through the registered mutation and safe replay", async () => {
		const f = await fixture();
		const enumerated = (await read_item(f, migration))!;
		// A later edit must survive even when enumeration saw the older doc.
		await f.t.run((ctx) =>
			migration.kind === "review"
				? ctx.db.patch("files_pending_update_run_items", f.review._id, { expectedDestinationParentPath: "/new-parent" })
				: ctx.db.patch("files_move_cohort_items", f.move._id, { reviewedRevision: (f.move.reviewedRevision ?? 0) + 1 }),
		);
		const fresh = (await read_item(f, migration))!;
		expect(fresh).not.toEqual(enumerated);
		const { mediaDependencySet: _old, ...expected } = fresh;
		const untouched = await f.t.run(controls);
		expect(untouched.maps).not.toHaveLength(0);
		expect(untouched.sets.map((set) => set._id)).toContain(f.setId);
		const result = await migrate(f, migration);
		expect(result.processed).toBe(1);
		expect(await read_item(f, migration), "strip keeps the fresh full doc minus its old null property").toEqual(
			expected,
		);
		expect(await f.t.run(controls), "metadata, current sets and wrapper controls stay equal").toEqual(untouched);
		await migrate(f, migration);
		expect(await read_item(f, migration), "replay keeps the same full doc").toEqual(expected);
		expect(await f.t.run(controls)).toEqual(untouched);
	});

	test.each([
		"protected names",
		"invalid tenant",
		"wrong tenant parent",
		"missing owner",
		"wrong header owner",
		"non-null proof",
		"old nested ID",
	])("refuses $kind: %s without changing the item", async (scenario) => {
		const f = await fixture();
		await f.t.run(async (ctx) => {
			if (scenario === "protected names") {
				await ctx.db.patch("organizations", f.scope.organizationId, { name: "PeRsOnAl" });
				await ctx.db.patch("organizations_workspaces", f.scope.workspaceId, { name: "SyBiLl" });
			} else if (scenario === "invalid tenant") {
				await ctx.db.delete("organizations_workspaces", f.scope.workspaceId);
			} else if (scenario === "wrong tenant parent") {
				const foreign = await test_mocks_fill_db_with.membership(ctx, { organizationName: "other" });
				await ctx.db.patch("organizations_workspaces", f.scope.workspaceId, { organizationId: foreign.organizationId });
			} else if (scenario === "missing owner") {
				if (migration.kind === "review") await ctx.db.delete("files_pending_update_runs", f.review.runId);
				else await ctx.db.delete("files_move_cohorts", f.move.cohortId);
			} else if (scenario === "non-null proof") {
				const proof = { setId: f.setId, generation: 0 };
				if (migration.kind === "review")
					await ctx.db.patch("files_pending_update_run_items", f.review._id, { mediaDependencySet: proof });
				else await ctx.db.patch("files_move_cohort_items", f.move._id, { mediaDependencySet: proof });
			} else {
				const foreign = await test_mocks_fill_db_with.membership(ctx, { organizationName: "other" });
				if (migration.kind === "review") {
					const header = f.review.reviewHeader!;
					await ctx.db.patch("files_pending_update_run_items", f.review._id, {
						reviewHeader: {
							...header,
							...(scenario === "old nested ID" ? { mediaDependencySetId: f.setId } : { userId: foreign.userId }),
						},
					});
				} else {
					const { _id, _creationTime, ...header } = f.proposal;
					await ctx.db.patch("files_move_cohort_items", f.move._id, {
						afterProposal: {
							...header,
							...(scenario === "old nested ID" ? { mediaDependencySetId: f.setId } : { userId: foreign.userId }),
						},
					});
				}
			}
		});
		const expected =
			scenario === "protected names"
				? "protected"
				: scenario === "invalid tenant" || scenario === "wrong tenant parent"
					? "invalid_tenant"
					: scenario === "non-null proof" || scenario === "old nested ID"
						? "changed"
						: "unresolved";
		await expect_blocked(f, migration, expected);
	});

	test("refuses an exact-proposal hold even after the owner has finished", async () => {
		const f = await fixture();
		await f.t.run((ctx) =>
			ctx.db.insert("files_pending_holds", {
				...f.scope,
				pendingUpdateId: f.proposalId,
				target: f.proposal.target,
				privateGeneration: null,
				producer: { kind: "files_pending_update_run", id: f.review.runId },
				role: "review",
			}),
		);
		await expect_blocked(f, migration, "held");
	});

	test.each(["finishing", "work", "run job"])("refuses a linked cohort with %s", async (scenario) => {
		const f = await fixture();
		await f.t.run(async (ctx) => {
			if (scenario === "finishing") await ctx.db.patch("files_move_cohorts", f.cohort._id, { phase: "finishing" });
			else if (scenario === "work")
				await ctx.db.patch("files_move_cohorts", f.cohort._id, { workId: "old-media-work" as never });
			else
				await ctx.db.patch("files_move_cohorts", f.cohort._id, {
					runJob: {
						id: await ctx.scheduler.runAfter(60 * 60 * 1000, internal.files_pending_update_runs.advance, {
							runId: f.review.runId,
						}),
						step: f.cohort.step,
						generation: 1,
					},
				});
		});
		await expect_blocked(f, migration, "held");
	});

	test("preview rolls back its real strip and does not schedule work", async () => {
		const f = await fixture();
		const before = await read_item(f, migration);
		const untouched = await f.t.run(controls);
		const read_scheduled = async (ctx: QueryCtx) => await ctx.db.system.query("_scheduled_functions").collect();
		const { runInComponent } = f.t as unknown as {
			runInComponent: (path: string, handler: typeof read_scheduled) => ReturnType<typeof read_scheduled>;
		};
		const rootScheduled = await f.t.run(read_scheduled);
		const componentScheduled = await runInComponent("migrations", read_scheduled);
		const status = await f.t.query(components.migrations.lib.getStatus, {});
		const debug = vi.spyOn(console, "debug");
		const error: unknown = await f.t
			.mutation(internal.migrations.preview_old_media_fields, {
				table: migration.table,
				cursor: null,
			})
			.catch((error: unknown) => error);
		// Keep this assertion before the error check for the rollback failure proof.
		expect(await read_item(f, migration), "preview keeps the stored old null property").toEqual(before);
		expect(await f.t.run(controls)).toEqual(untouched);
		expect(await f.t.run(read_scheduled)).toEqual(rootScheduled);
		expect(await runInComponent("migrations", read_scheduled)).toEqual(componentScheduled);
		expect(await f.t.query(components.migrations.lib.getStatus, {})).toEqual(status);
		expect(error).toBeInstanceOf(ConvexError);
		if (!(error instanceof ConvexError)) throw new Error("Expected the rollback preview error");
		expect(error.data).toMatchObject({
			message: "Old media field preview rolled back.",
			data: { processed: 1, continueCursor: expect.any(String), isDone: expect.any(Boolean) },
		});
		expect(debug, "preview never logs full docs with the package dry-run mode").not.toHaveBeenCalled();
	});
});

test.each(["unfinished run", "queued unit", "unit work", "unit deadline", "unsettled dependents", "missing unit"])(
	"old review media cleanup refuses %s",
	async (scenario) => {
		const f = await fixture();
		await f.t.run(async (ctx) => {
			if (scenario === "unfinished run")
				await ctx.db.patch("files_pending_update_runs", f.review.runId, { step: "running" });
			else if (scenario === "missing unit") await ctx.db.delete("files_pending_update_run_units", f.unit._id);
			else
				await ctx.db.patch("files_pending_update_run_units", f.unit._id, {
					...(scenario === "queued unit" ? { status: "queued" as const } : {}),
					...(scenario === "unit work" ? { workId: "old-media-work" as never } : {}),
					...(scenario === "unit deadline" ? { attemptDeadlineAt: Date.now() + 1000 } : {}),
					...(scenario === "unsettled dependents" ? { dependentsSettled: false } : {}),
				});
		});
		await expect_blocked(f, migrations[0], scenario === "missing unit" ? "unresolved" : "held");
	},
);

test("a settled historical refusal does not keep a Review item held forever", async () => {
	const f = await fixture();
	await f.t.run((ctx) =>
		ctx.db.patch("files_pending_update_run_units", f.unit._id, {
			status: "blocked",
			errorCode: "needs_review",
			errorMessage: "Review the latest version.",
		}),
	);
	const before = (await read_item(f, migrations[0]))!;
	const { mediaDependencySet: _old, ...expected } = before;
	await migrate(f, migrations[0]);
	expect(await read_item(f, migrations[0]), "finished settled units stay eligible").toEqual(expected);
});

test("the two named old-media runners finish empty tables", async () => {
	const t = test_convex({ transactionLimits: true });
	t.registerComponent("migrations", migrations_test.schema, migrations_test.modules);
	for (const migration of migrations) {
		const result = await t.mutation(migration.runner, { cursor: null });
		const name = getFunctionName(migration.definition);
		expect(result).toMatchObject({ Name: name, processed: 0 });
		expect(await t.query(components.migrations.lib.getStatus, { names: [name] })).toMatchObject([
			{ name, isDone: true, processed: 0 },
		]);
	}
});
