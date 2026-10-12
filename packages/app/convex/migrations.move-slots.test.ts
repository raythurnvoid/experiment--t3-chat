import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { defineSchema } from "convex/server";
import { runToCompletion } from "@convex-dev/migrations";
import migrations_test from "@convex-dev/migrations/test";
import { components, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { backfill_move_search_generations, strip_move_slot_search_generation } from "./migrations.ts";
import app_convex_schema from "./schema.ts";
import { test_convex, test_mocks_fill_db_with, test_spy_handler } from "./setup.test.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

const backfill = internal.migrations.backfill_move_search_generations;
const strip = internal.migrations.strip_move_slot_search_generation;
const steps = [
	["copy", backfill],
	["strip", strip],
] as const;
const batch_args = { cursor: null, batchSize: 64, dryRun: false, oneBatchOnly: true };

async function fixture(searchGeneration = 262) {
	const t = test_convex({ transactionLimits: true });
	t.registerComponent("migrations", migrations_test.schema, migrations_test.modules);
	const scope = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx, { plan: null, integrationPolicy: null }));
	const slotId = await t.run((ctx) =>
		ctx.db.insert("files_move_workspace_slots", {
			organizationId: scope.organizationId,
			workspaceId: scope.workspaceId,
			cohortId: null,
			generation: 4,
			searchGeneration,
		}),
	);
	const original = await t.run((ctx) => ctx.db.get("files_move_workspace_slots", slotId));
	return { t, scope, slotId, original };
}

async function read_counter({ t, scope }: Awaited<ReturnType<typeof fixture>>) {
	return await t.run((ctx) =>
		ctx.db
			.query("files_move_search_generations")
			.withIndex("by_workspace", (q) =>
				q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId),
			)
			.unique(),
	);
}

test.each([0, 262])("Move counter migration copies %i exactly and can run twice", async (number) => {
	const db = await fixture(number);
	await db.t.mutation(backfill, batch_args);
	const copied = await read_counter(db);
	expect(copied?.searchGeneration, "the old counter is copied exactly").toBe(number);
	expect(await db.t.run((ctx) => ctx.db.get("files_move_workspace_slots", db.slotId))).toEqual(db.original);
	await db.t.mutation(backfill, batch_args);
	expect(await read_counter(db), "a rerun keeps the same counter row").toEqual(copied);
});

test.each([7, 300])("Move counter migration keeps an existing destination counter at %i", async (number) => {
	const db = await fixture();
	await db.t.run((ctx) =>
		ctx.db.insert("files_move_search_generations", {
			organizationId: db.scope.organizationId,
			workspaceId: db.scope.workspaceId,
			searchGeneration: number,
		}),
	);
	const originalCounter = await read_counter(db);
	await db.t.mutation(backfill, batch_args);
	expect(await read_counter(db), "an existing counter is never replaced by the old number").toEqual(originalCounter);
	expect(await db.t.run((ctx) => ctx.db.get("files_move_workspace_slots", db.slotId))).toEqual(db.original);
});

test("Move slot stripping needs a copied counter and removes only the old field", async () => {
	const db = await fixture();
	await expect(db.t.mutation(strip, batch_args)).rejects.toThrow("Copy the Move search counter");
	expect(await db.t.run((ctx) => ctx.db.get("files_move_workspace_slots", db.slotId))).toEqual(db.original);
	await db.t.mutation(backfill, batch_args);
	const counter = await read_counter(db);
	await db.t.mutation(strip, batch_args);
	const { searchGeneration: _oldCounter, ...expected } = db.original!;
	expect(
		await db.t.run((ctx) => ctx.db.get("files_move_workspace_slots", db.slotId)),
		"stripping keeps the slot ID, generation and every other field",
	).toEqual(expected);
	expect(await read_counter(db)).toEqual(counter);
	await db.t.mutation(strip, batch_args);
	expect(await db.t.run((ctx) => ctx.db.get("files_move_workspace_slots", db.slotId))).toEqual(expected);
});

test("Move counter migration follows every indexed page and records completion", async () => {
	const db = await fixture();
	const otherScope = await db.t.run((ctx) =>
		test_mocks_fill_db_with.membership(ctx, {
			organizationName: "other-organization",
			workspaceName: "other-workspace",
			plan: null,
			integrationPolicy: null,
		}),
	);
	const otherSlotId = await db.t.run((ctx) =>
		ctx.db.insert("files_move_workspace_slots", {
			organizationId: otherScope.organizationId,
			workspaceId: otherScope.workspaceId,
			cohortId: null,
			generation: 9,
			searchGeneration: 46,
		}),
	);
	for (const migration of [backfill, strip]) {
		const status = await db.t.action((ctx) => runToCompletion(ctx, components.migrations, migration, { batchSize: 1 }));
		expect(status.isDone, "the component records the last page as complete").toBe(true);
		expect(status.processed, "the runner handles every slot across pages").toBe(2);
	}
	expect((await read_counter(db))?.searchGeneration).toBe(262);
	expect((await read_counter({ ...db, scope: otherScope }))?.searchGeneration).toBe(46);
	for (const slotId of [db.slotId, otherSlotId]) {
		expect(await db.t.run((ctx) => ctx.db.get("files_move_workspace_slots", slotId))).not.toHaveProperty(
			"searchGeneration",
		);
	}
});

test.each(steps)("Move slot migration refuses a busy slot during %s", async (_step, migration) => {
	const db = await fixture();
	await db.t.mutation(backfill, batch_args);
	const counter = await read_counter(db);
	await db.t.run((ctx) =>
		ctx.db.patch("files_move_workspace_slots", db.slotId, {
			cohortId: "999999files_move_cohorts" as Id<"files_move_cohorts">,
			visibleView: "before",
			migrationDirection: "to_cohort",
		}),
	);
	const busy = await db.t.run((ctx) => ctx.db.get("files_move_workspace_slots", db.slotId));
	await expect(db.t.mutation(migration, batch_args)).rejects.toThrow("Stop or finish the Move");
	expect(await db.t.run((ctx) => ctx.db.get("files_move_workspace_slots", db.slotId))).toEqual(busy);
	expect(await read_counter(db)).toEqual(counter);
});

test.each(steps)("Move slot migration checks fresh protected names during %s", async (_step, migration) => {
	const db = await fixture();
	await db.t.mutation(backfill, batch_args);
	const counter = await read_counter(db);
	await db.t.run(async (ctx) => {
		await ctx.db.patch("organizations", db.scope.organizationId, { name: "Personal" });
		await ctx.db.patch("organizations_workspaces", db.scope.workspaceId, { name: "Sybill" });
	});
	await expect(db.t.mutation(migration, batch_args)).rejects.toThrow("protected scope");
	expect(await db.t.run((ctx) => ctx.db.get("files_move_workspace_slots", db.slotId))).toEqual(db.original);
	expect(await read_counter(db)).toEqual(counter);
});

test.each(steps)("Move slot migration checks fresh tenant ownership during %s", async (_step, migration) => {
	const db = await fixture();
	await db.t.mutation(backfill, batch_args);
	const counter = await read_counter(db);
	await db.t.run((ctx) =>
		ctx.db.patch("organizations_workspaces", db.scope.workspaceId, {
			organizationId: "999999organizations" as Id<"organizations">,
		}),
	);
	await expect(db.t.mutation(migration, batch_args)).rejects.toThrow("invalid tenant metadata");
	expect(await db.t.run((ctx) => ctx.db.get("files_move_workspace_slots", db.slotId))).toEqual(db.original);
	expect(await read_counter(db)).toEqual(counter);
});

test("Move slot migration allows other personal workspaces", async () => {
	const db = await fixture();
	await db.t.run(async (ctx) => {
		await ctx.db.patch("organizations", db.scope.organizationId, { name: "personal" });
		await ctx.db.patch("organizations_workspaces", db.scope.workspaceId, { name: "home" });
	});
	await db.t.mutation(backfill, batch_args);
	await db.t.mutation(strip, batch_args);
	expect((await read_counter(db))?.searchGeneration).toBe(262);
	expect(await db.t.run((ctx) => ctx.db.get("files_move_workspace_slots", db.slotId))).not.toHaveProperty(
		"searchGeneration",
	);
});

test.each(["organizations", "organizations_workspaces"] as const)(
	"Move counter migration refuses missing %s metadata",
	async (table) => {
		const db = await fixture();
		await db.t.run(async (ctx) => {
			if (table === "organizations") await ctx.db.delete("organizations", db.scope.organizationId);
			else await ctx.db.delete("organizations_workspaces", db.scope.workspaceId);
		});
		await expect(db.t.mutation(backfill, batch_args)).rejects.toThrow("invalid tenant metadata");
		expect(await read_counter(db)).toBeNull();
		expect(await db.t.run((ctx) => ctx.db.get("files_move_workspace_slots", db.slotId))).toEqual(db.original);
	},
);

const protected_scopes = [
	{
		name: "Sybill demo organization",
		organizationId: "gs7k8abvmsa6nxm8dwrah5nc318bmejm",
		workspaceId: "999999organizations_workspaces",
	},
	{
		name: "Sybill catalog workspace",
		organizationId: "999999organizations",
		workspaceId: "h57j1rmpsvs2b3hsyftq4pm9v18bmer4",
	},
	{
		name: "Sybill default workspace",
		organizationId: "999999organizations",
		workspaceId: "h57svystn7skx8wym6me4v0mhh8bm1kq",
	},
];

test.each(protected_scopes)("Move migration operator scope guard refuses $name", async (scope) => {
	// convex-test validates its fake ID format. This one guard test needs real deployment IDs.
	const t = convexTest({
		schema: defineSchema(app_convex_schema.tables, { schemaValidation: false }),
		modules: {
			"./_generated/server.ts": async () => ({}),
			"./migrations.ts": () => import("./migrations.ts"),
		},
		transactionLimits: true,
	});
	const slotId = await t.run((ctx) =>
		ctx.db.insert("files_move_workspace_slots", {
			organizationId: scope.organizationId as Id<"organizations">,
			workspaceId: scope.workspaceId as Id<"organizations_workspaces">,
			cohortId: null,
			generation: 4,
			searchGeneration: 262,
		}),
	);
	for (const registered of [backfill_move_search_generations, strip_move_slot_search_generation]) {
		test_spy_handler(registered, async (handler, ctx, args) => {
			const get = vi.spyOn(ctx.db, "get");
			const insert = vi.spyOn(ctx.db, "insert");
			const patch = vi.spyOn(ctx.db, "patch");
			try {
				return await handler(ctx, args);
			} finally {
				expect(get, "protected IDs are rejected before any metadata or file read").not.toHaveBeenCalled();
				expect(insert, "protected IDs are rejected before any insert").not.toHaveBeenCalled();
				expect(patch, "protected IDs are rejected before any patch").not.toHaveBeenCalled();
				get.mockRestore();
				insert.mockRestore();
				patch.mockRestore();
			}
		});
	}
	for (const migration of [backfill, strip]) {
		await expect(t.mutation(migration, batch_args)).rejects.toThrow("protected scope");
	}
	expect(await t.run((ctx) => ctx.db.get("files_move_workspace_slots", slotId))).toHaveProperty(
		"searchGeneration",
		262,
	);
	expect(
		await t.run((ctx) => ctx.db.query("files_move_search_generations").withIndex("by_workspace").first()),
	).toBeNull();
});

test.each(steps)("Move slot %s preview rolls back without printing documents", async (step) => {
	const db = await fixture();
	if (step === "strip") await db.t.mutation(backfill, batch_args);
	const originalCounter = await read_counter(db);
	const debug = vi.spyOn(console, "debug");
	test_spy_handler(
		step === "copy" ? backfill_move_search_generations : strip_move_slot_search_generation,
		async (handler, ctx, args) => {
			const result = await handler(ctx, args);
			if (step === "copy") {
				const counter = await ctx.db
					.query("files_move_search_generations")
					.withIndex("by_workspace", (q) =>
						q.eq("organizationId", db.scope.organizationId).eq("workspaceId", db.scope.workspaceId),
					)
					.unique();
				expect(counter?.searchGeneration, "the preview really inserts the destination before rollback").toBe(262);
			} else {
				expect(
					await ctx.db.get("files_move_workspace_slots", db.slotId),
					"the preview really strips before rollback",
				).not.toHaveProperty("searchGeneration");
			}
			return result;
		},
	);
	try {
		await expect(db.t.mutation(internal.migrations.preview_move_slot_cutover, { step })).rejects.toThrow(
			`Move slot ${step} preview rolled back.`,
		);
		expect(await read_counter(db), "the outer transaction rolls back the cross-table writes").toEqual(originalCounter);
		expect(await db.t.run((ctx) => ctx.db.get("files_move_workspace_slots", db.slotId))).toEqual(db.original);
		expect(debug, "the preview does not print source or destination documents").not.toHaveBeenCalled();
	} finally {
		debug.mockRestore();
	}
});
