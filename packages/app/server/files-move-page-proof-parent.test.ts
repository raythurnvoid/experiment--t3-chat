import { v } from "convex/values";
import { getFunctionName, type FunctionReference, type FunctionReturnType, type TransactionMetrics } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api.js";
import type { Doc, Id, TableNames } from "../convex/_generated/dataModel.js";
import type { MutationCtx } from "../convex/_generated/server.js";
import { internalMutation } from "../convex/functions.ts";
import { advance, files_move_cohorts_db_advance } from "../convex/files_move_cohorts.ts";
import { metadata, proof_owner_fields } from "../convex/files_move_pages.ts";
import { budget_recorder, transaction_cost } from "../convex/files_pending_overlay_limits.setup.test.ts";
import { test_convex, test_mocks_fill_db_with, test_progress_guard, test_spy_handler } from "../convex/setup.test.ts";
import * as overlay from "./files-pending-overlay.ts";
import * as catalog from "./files-metadata-catalog.ts";
import { files_move_page_proof_enable, files_move_page_proof_ledger } from "./files-move-page-proof.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

type T = ReturnType<typeof test_convex>;
type Cohort = Doc<"files_move_cohorts">;
type Entry = ReturnType<typeof files_move_page_proof_ledger>[number];
type ProofRecord = {
	event: string;
	seq: number;
	ordinal: number;
	step: number;
	entryStep: number;
	token: string;
	cohortId: string;
	purpose: string;
	rowIds: string[];
	beforeIds: string[];
	afterIds: string[];
	beforeDone: boolean;
	afterDone: boolean;
	counters: TransactionMetrics;
	units: { purpose: string; rowIds: string[]; writeStart: number; writeEnd: number }[];
	writes: Entry[];
};

const begin = overlay.files_pending_overlay_db_page_proof_begin;

function records(log: { mock: { calls: unknown[][] } }): ProofRecord[] {
	return log.mock.calls.flatMap(([line]) => {
		if (typeof line !== "string") return [];
		const prefix = ["MOVE_PAGE_PROOF_20261015 ", "MOVE_PAGE_STATE_20261015 "].find((value) => line.startsWith(value));
		return prefix ? [JSON.parse(line.slice(prefix.length)) as ProofRecord] : [];
	});
}

function qa_cohort(cohort: Cohort): Cohort {
	return {
		...cohort,
		organizationId: "gs7pjc3hzy2m10e1hj3vk0kzad8cm7tb" as Id<"organizations">,
		workspaceId: "h57vccrf1r4j9q6ky0etf6v0gx8cm2kw" as Id<"organizations_workspaces">,
		userId: "m577heygr826f2wgk6r30mk1vd8928q2" as Id<"users">,
		membershipId: "h97xwdwwy689rs2hj7cxnwbq0s8cma56" as Id<"organizations_workspaces_users">,
	};
}

/**
 * Only the diagnostic guard sees fixed hosted IDs. The real engine keeps the local stored docs.
 */
async function begin_qa(ctx: MutationCtx, cohort: Cohort) {
	const guarded = {
		...ctx,
		db: new Proxy(ctx.db, {
			get(target, property) {
				if (property === "get") return async (...args: unknown[]) => {
					const doc: unknown = await Reflect.apply(Reflect.get(target, property), target, args);
					if (args[0] === "files_transfer_items" && cohort.origin.kind === "transfer" && args[1] === cohort.origin.itemId && doc) {
						const item = doc as Doc<"files_transfer_items">;
						return { ...item, source: { kind: "saved", id: "v97er5hkawd92x0g1xjgnb5yg18fq5hj" } };
					}
					return doc;
				};
				const value = Reflect.get(target, property) as unknown;
				return typeof value === "function" ? value.bind(target) : value;
			},
		}),
		meta: {
			...ctx.meta,
			getRequestMetadata: async () => ({
				requestId: "local-page-proof",
				scheduledFunctionId: null,
				ip: "private-test-ip",
				userAgent: "private-test-agent",
				authToken: "private-test-token",
			}),
		},
	};
	await begin(guarded, qa_cohort(cohort));
}

async function run_wrapped(t: T, fn: (ctx: MutationCtx) => Promise<void>) {
	const mutation = internalMutation({
		args: {},
		returns: v.null(),
		handler: async (ctx) => {
			await fn(ctx);
			return null;
		},
	});
	const registered = mutation as unknown as { _handler: (ctx: MutationCtx, args: unknown) => Promise<null> };
	return await t.run((ctx) => registered._handler(ctx, {}));
}

async function fixture(pending = false) {
	const t = test_convex({ transactionLimits: true });
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const ids: Id<"files_nodes">[] = [];
	for (const path of ["/source", "/source/first", "/source/second", "/target"]) {
		const created = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId, parentId: "root", path,
		});
		if (created._nay) throw new Error(created._nay.message);
		ids.push(created._yay.nodeId);
	}
	for (const fileNodeId of ids.slice(1, 3)) expect(await asUser.mutation(api.files_metadata.set_entries, {
		membershipId: db.membershipId, fileNodeId, metadataYaml: "status: open",
	})).toEqual({ _yay: null });
	if (pending) expect(await t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
		organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId,
		target: { kind: "saved", id: ids[1]! }, destParent: { kind: "saved", id: ids[0]! }, destName: "first-draft",
	})).toMatchObject({ _yay: expect.anything() });
	const canJoin = overlay.files_pending_overlay_db_can_join_step;
	const pause = vi.spyOn(overlay, "files_pending_overlay_db_can_join_step").mockImplementation(async (ctx, factor) => {
		const allowed = await canJoin(ctx, factor);
		if (factor !== 4) return allowed;
		pause.mockRestore();
		return false;
	});
	try {
		const accepted = await asUser.mutation(api.files_transfer.accept_input, {
			membershipId: db.membershipId, requestId: "parent-proof", kind: "move",
			sourceIds: [ids[0]!], expectedSourceCount: 1, targetParentId: ids[3]!,
		});
		if (accepted._nay) throw new Error(accepted._nay.message);
		const cohort = await t.run((ctx) => ctx.db.query("files_move_cohorts")
			.withIndex("by_origin_run", (q) => q.eq("origin.kind", "transfer").eq("origin.runId", accepted._yay.runId)).unique());
		if (!cohort || cohort.publishedAt !== null) throw new Error("Expected the admitted unpublished Move");
		return { t, db, asUser, ids, cohortId: cohort._id };
	} finally {
		pause.mockRestore();
	}
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function current(f: Fixture) {
	const cohort = await f.t.run((ctx) => ctx.db.get("files_move_cohorts", f.cohortId));
	if (!cohort) throw new Error("Expected the real Move cohort");
	return cohort;
}

async function advance_to(f: Fixture, phase: Cohort["workPhase"]) {
	const progress = test_progress_guard();
	while (true) {
		const cohort = await current(f);
		if (cohort.workPhase === phase) return cohort;
		if (cohort.publishedAt !== null) throw new Error(`Move published before ${phase}`);
		progress([cohort.step, cohort.workPhase], "parent proof setup");
		await f.t.action(internal.files_move_run.run, {
			cohortId: cohort._id, step: cohort.step, runGeneration: cohort.runJob?.generation ?? null, mode: "step",
		});
	}
}

function use_qa_guard(f: Fixture, staleDrain = false) {
	vi.spyOn(overlay, "files_pending_overlay_db_page_proof_begin").mockImplementation(async (ctx, cohort) => {
		if (cohort._id === f.cohortId) {
			await begin_qa(ctx, cohort);
			if (staleDrain) overlay.files_pending_overlay_db_page_proof_rollback(ctx, cohort._id, true);
		} else await begin(ctx, cohort);
	});
}

async function step(f: Fixture) {
	const cohort = await current(f);
	return await f.t.mutation(internal.files_move_cohorts.advance, {
		cohortId: cohort._id, step: cohort.step, runGeneration: cohort.runJob?.generation ?? null, join: false,
	});
}

async function read_entries(t: T, entries: readonly Entry[]): Promise<{ id: string; doc: unknown }[]> {
	const unique = new Map(entries.map((entry) => [entry.id, entry]));
	return await t.run(async (ctx) => Promise.all([...unique.values()].map(async (entry) => ({
		id: entry.id,
		doc: ["runAfter", "runAt", "cancel"].includes(entry.operation)
			? await ctx.db.system.get("_scheduled_functions", entry.id as Id<"_scheduled_functions">)
			: await ctx.db.get(entry.id as Id<TableNames>),
	}))));
}

function record_metrics(metrics: TransactionMetrics) {
	budget_recorder().record("page proof parent", {
		bytesRead: metrics.bytesRead.used,
		bytesWritten: metrics.bytesWritten.used,
		databaseQueries: metrics.databaseQueries.used,
		documentsRead: metrics.documentsRead.used,
		documentsWritten: metrics.documentsWritten.used,
		functionsScheduled: metrics.functionsScheduled.used,
		scheduledFunctionArgsBytes: metrics.scheduledFunctionArgsBytes.used,
	});
}

describe("Move parent page proof hooks", () => {
	test("only the exact QA guard starts page proof", async () => {
		const f = await fixture();
		const cohort = await current(f);
		const log = vi.spyOn(console, "info").mockImplementation(() => {});
		for (const key of ["organizationId", "workspaceId", "userId", "membershipId"] as const) {
			await run_wrapped(f.t, async (ctx) => {
				const request = vi.spyOn(ctx.meta, "getRequestMetadata");
				const metrics = vi.spyOn(ctx.meta, "getTransactionMetrics");
				const denied = { ...qa_cohort(cohort), [key]: cohort[key] };
				await begin(ctx, denied);
				expect(await overlay.files_pending_overlay_db_page_proof_before(ctx, cohort, "metadata")).toBeUndefined();
				expect(request).not.toHaveBeenCalled();
				expect(metrics).not.toHaveBeenCalled();
			});
		}
		await run_wrapped(f.t, async (ctx) => {
			const request = vi.spyOn(ctx.meta, "getRequestMetadata");
			// The real local source is outside the hosted allowlist.
			await begin(ctx, qa_cohort(cohort));
			expect(await overlay.files_pending_overlay_db_page_proof_before(ctx, cohort, "metadata")).toBeUndefined();
			expect(request).not.toHaveBeenCalled();
		});
		expect(records(log)).toEqual([]);
	});

	test("page receipts use the current step and one parent sequence", async () => {
		const f = await fixture();
		const cohort = await current(f);
		const log = vi.spyOn(console, "info").mockImplementation(() => {});
		await run_wrapped(f.t, async (ctx) => {
			await begin_qa(ctx, cohort);
			const pageArgs = { organizationId: f.db.organizationId, workspaceId: f.db.workspaceId, nodeId: f.ids[1]!, cursor: null };
			const first = await overlay.files_pending_overlay_db_page_proof_before(ctx, cohort, "metadata");
			expect(first).toMatchObject({ ordinal: 0, entryStep: cohort.step, step: cohort.step });
			const page = await ctx.runQuery(internal.files_move_pages.metadata, { ...pageArgs, proof: first });
			await overlay.files_pending_overlay_db_page_proof_after(ctx, page);
			overlay.files_pending_overlay_db_page_proof_body(ctx);
			await overlay.files_pending_overlay_db_can_join_step(ctx);
			await begin_qa(ctx, cohort);
			await files_move_cohorts_db_advance(ctx, {
				cohortId: cohort._id, step: cohort.step, runGeneration: cohort.runJob?.generation ?? null, join: false,
			});
			const fresh = (await ctx.db.get("files_move_cohorts", cohort._id))!;
			expect(fresh.step).toBeGreaterThan(cohort.step);
			const second = await overlay.files_pending_overlay_db_page_proof_before(ctx, fresh, "metadata");
			expect(second).toMatchObject({ ordinal: 1, entryStep: cohort.step, step: fresh.step, phase: fresh.workPhase });
			const next = await ctx.runQuery(internal.files_move_pages.metadata, { ...pageArgs, proof: second });
			await overlay.files_pending_overlay_db_page_proof_after(ctx, next);
			overlay.files_pending_overlay_db_page_proof_body(ctx);
			await overlay.files_pending_overlay_db_can_join_step(ctx);
			expect(await overlay.files_pending_overlay_db_page_proof_before(ctx, fresh, "metadata")).toBeUndefined();
			const third = await ctx.runQuery(internal.files_move_pages.metadata, pageArgs);
			await overlay.files_pending_overlay_db_page_proof_after(ctx, third);
			overlay.files_pending_overlay_db_page_proof_body(ctx);
			await overlay.files_pending_overlay_db_can_join_step(ctx);
		});
		const proof = records(log).filter((row) => ["parent_before", "child_entry", "child_exit", "parent_after", "parent_final"].includes(row.event));
		expect(proof.map((row) => row.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
		expect(new Set(proof.map((row) => row.token))).toEqual(new Set([`local-page-proof:${cohort._id}:${cohort.step}`]));
		expect(log.mock.calls.flat().join(" ")).not.toMatch(/private-test-(ip|agent|token)/);
		record_metrics(proof.at(-1)!.counters);
	});

	test("the parent proof includes the real access-clock flush", async () => {
		const f = await fixture();
		const cohort = await current(f);
		const before = await f.t.run((ctx) => ctx.db.query("files_access_versions")
			.withIndex("by_organization_workspace", (q) => q.eq("organizationId", f.db.organizationId)
				.eq("workspaceId", f.db.workspaceId)).unique());
		const log = vi.spyOn(console, "info").mockImplementation(() => {});
		const captured: { ctx: MutationCtx; metrics: TransactionMetrics }[] = [];
		await run_wrapped(f.t, async (ctx) => {
			await begin_qa(ctx, cohort);
			files_move_page_proof_enable(ctx);
			// A workspace grant changes the access clock without adding file overlay work.
			await ctx.db.insert("access_control_permission_grants", {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				resourceKind: "workspace",
				resourceId: f.db.workspaceId,
				principalKind: "user",
				userId: f.db.userId,
				permission: "content.read",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			captured.push({ ctx, metrics: await ctx.meta.getTransactionMetrics() });
		});
		const after = await f.t.run((ctx) => ctx.db.query("files_access_versions")
			.withIndex("by_organization_workspace", (q) => q.eq("organizationId", f.db.organizationId)
				.eq("workspaceId", f.db.workspaceId)).unique());
		if (!after) throw new Error("Expected the stored workspace access clock");
		expect(after.revision).toBe((before?.revision ?? 0) + 1);
		if (before) expect(after._id).toBe(before._id);
		expect(captured).toHaveLength(1);
		const parent = captured[0]!;
		expect(files_move_page_proof_ledger(parent.ctx), "The write-ID ledger includes the actual access-clock write")
			.toContainEqual({ operation: before ? "patch" : "insert", id: after._id });
		const final = records(log).filter((record) => record.event === "parent_final" && record.cohortId === cohort._id);
		expect(final).toHaveLength(1);
		expect(final[0]!.counters.documentsWritten.used, "Final proof counters include the access-clock write")
			.toBe(parent.metrics.documentsWritten.used + 1);
		expect(final[0]!.counters.bytesWritten.used).toBeGreaterThan(parent.metrics.bytesWritten.used);
		record_metrics(final[0]!.counters);
	});

	test("the child sees the real new work range after the existing flush", async () => {
		const f = await fixture();
		const cohort = await current(f);
		const log = vi.spyOn(console, "info").mockImplementation(() => {});
		const events: string[] = [];
		const flush = catalog.files_metadata_catalog_db_insert_deltas;
		vi.spyOn(catalog, "files_metadata_catalog_db_insert_deltas").mockImplementation(async (...args) => {
			await flush(...args);
			events.push("flush");
		});
		await run_wrapped(f.t, async (ctx) => {
			await begin_qa(ctx, cohort);
			await files_move_cohorts_db_advance(ctx, {
				cohortId: cohort._id, step: cohort.step, runGeneration: cohort.runJob?.generation ?? null, join: false,
			});
			overlay.files_pending_overlay_db_page_proof_queue_drain(ctx, async () => {
				expect(events).toEqual(["flush"]);
				const page = await ctx.runQuery(internal.files_move_pages.metadata, {
					organizationId: f.db.organizationId, workspaceId: f.db.workspaceId, nodeId: f.ids[1]!, cursor: null,
				});
				expect(page.page.length).toBeGreaterThan(0);
				events.push("drain");
			});
		});
		const range = records(log).find((row) => row.event === "new_work_range");
		expect(range, "The child sees the real new work range after flush").toBeDefined();
		expect(range?.rowIds).toHaveLength(1);
		const stored = await f.t.run((ctx) => ctx.db.get("files_move_work_ranges", range!.rowIds[0] as Id<"files_move_work_ranges">));
		expect(stored).toMatchObject({ cohortId: cohort._id, key: `saved-children:${f.ids[0]}` });
		expect(events).toEqual(["flush", "drain"]);
	});

	test("rollback throws only after two real write units and their existing flushes", async () => {
		const f = await fixture();
		const cohort = await advance_to(f, "sides");
		const known = await f.t.run(async (ctx): Promise<{ id: Id<TableNames>; doc: unknown }[]> => {
			const docs: { id: Id<TableNames>; doc: unknown }[] = [];
			for (const id of f.ids) {
				docs.push({ id, doc: await ctx.db.get("files_nodes", id) });
				const map = await ctx.db.query("files_metadata_maps")
					.withIndex("by_owner", (q) => q.eq("owner.kind", "saved").eq("owner.id", id)).unique();
				if (map) docs.push({ id: map._id, doc: map });
				const metadata = await ctx.db.query("files_metadata_docs")
					.withIndex("by_organization_workspace_source_fileNode", (q) => q.eq("organizationId", f.db.organizationId)
						.eq("workspaceId", f.db.workspaceId).eq("sourceKind", "committed").eq("fileNodeId", id)).collect();
				for (const doc of metadata) docs.push({ id: doc._id, doc });
			}
			return docs;
		});
		const log = vi.spyOn(console, "info").mockImplementation(() => {});
		let catalogIds: string[] = [];
		const flush = catalog.files_metadata_catalog_db_insert_deltas;
		vi.spyOn(catalog, "files_metadata_catalog_db_insert_deltas").mockImplementation(async (ctx, changes) => {
			const start = files_move_page_proof_ledger(ctx).length;
			await flush(ctx, changes);
			catalogIds.push(...files_move_page_proof_ledger(ctx).slice(start)
				.filter((entry) => entry.operation === "insert").map((entry) => entry.id));
		});
		const invoke = () => run_wrapped(f.t, async (ctx) => {
			await begin_qa(ctx, cohort);
			overlay.files_pending_overlay_db_page_proof_rollback(ctx, cohort._id, false);
			await files_move_cohorts_db_advance(ctx, {
				cohortId: cohort._id, step: cohort.step, runGeneration: cohort.runJob?.generation ?? null, join: true,
			});
			throw new Error("The real parent did not finish two write units");
		});
		await expect(invoke()).rejects.toThrow("MOVE_PAGE_PROOF_ROLLBACK_AFTER_TWO_UNITS");
		expect(await current(f), "discovery keeps the prior committed cohort").toEqual(cohort);
		for (const entry of known)
			expect(await f.t.run((ctx) => ctx.db.get(entry.id)), "Discovery keeps saved headers, maps and metadata").toEqual(entry.doc);
		const discovered = records(log).filter((record) => record.event === "rollback").at(-1)!;
		const newIds = new Set(discovered.writes.filter((entry) => ["insert", "runAfter", "runAt"].includes(entry.operation)).map((entry) => entry.id));
		const prior = discovered.writes.filter((entry) => !newIds.has(entry.id));
		const baseline = new Map((await read_entries(f.t, prior)).map((entry) => [entry.id, entry.doc]));
		catalogIds = [];
		await expect(invoke()).rejects.toThrow("MOVE_PAGE_PROOF_ROLLBACK_AFTER_TWO_UNITS");
		const proof = records(log).filter((record) => record.event === "rollback").at(-1)!;
		expect(proof.units).toHaveLength(2);
		expect(proof.units.every((unit) => unit.rowIds.length > 0 && unit.writeEnd > unit.writeStart)).toBe(true);
		expect(catalogIds.length).toBeGreaterThan(0);
		for (const unit of proof.units) expect(proof.writes.slice(unit.writeStart, unit.writeEnd)
			.some((entry) => catalogIds.includes(entry.id)), "Each unit includes its real catalog flush writes").toBe(true);
		const inserted = proof.writes.filter((entry) => ["insert", "runAfter", "runAt"].includes(entry.operation));
		const insertedIds = new Set(inserted.map((entry) => entry.id));
		const changed = proof.writes.filter((entry) => !insertedIds.has(entry.id));
		expect(new Set(changed.map((entry) => entry.id)), "Every prior rollback ID was audited").toEqual(new Set(baseline.keys()));
		for (const entry of await read_entries(f.t, inserted))
			expect(entry.doc, "Every inserted rollback ID is absent").toBeNull();
		for (const entry of await read_entries(f.t, changed))
			expect(entry.doc, "Every prior rollback document is unchanged").toEqual(baseline.get(entry.id));
		expect(await current(f)).toEqual(cohort);
		record_metrics(proof.counters);
	});

	test("the child sees exact AFTER owner fields after the real flush", async () => {
		const f = await fixture(true);
		use_qa_guard(f);
		type Fields = FunctionReturnType<typeof internal.files_move_pages.proof_owner_fields>;
		type StoredField = Omit<Doc<"files_pending_place_fields">, "_creationTime">;
		const seen: Fields[] = [];
		const inserted: StoredField[] = [];
		const events: string[] = [];
		const log = vi.spyOn(console, "info").mockImplementation(() => {});
		const flush = catalog.files_metadata_catalog_db_insert_deltas;
		vi.spyOn(catalog, "files_metadata_catalog_db_insert_deltas").mockImplementation(async (...args) => {
			await flush(...args);
			events.push("flush");
		});
		test_spy_handler(proof_owner_fields, async (handler, ctx, args) => {
			expect(events.at(-1), "Owner fields are read after the existing flush").toBe("flush");
			const result = await handler(ctx, args);
			seen.push(result as unknown as Fields);
			events.push("owner_fields");
			return result;
		});
		const costs = budget_recorder();
		test_spy_handler(advance, async (handler, ctx, args) => {
			const before = await ctx.meta.getTransactionMetrics();
			const insert = vi.spyOn(ctx.db, "insert");
			try {
				const result = await handler(ctx, args);
				for (const [index, call] of insert.mock.calls.entries()) {
					if (call[0] !== "files_pending_place_fields") continue;
					const fields = call[1] as Omit<StoredField, "_id">;
					if (fields.moveView?.cohortId !== f.cohortId || fields.moveView.view !== "after") continue;
					const recorded = insert.mock.results[index]!;
					expect(recorded.type).toBe("return");
					inserted.push({ ...fields, _id: await recorded.value as Id<"files_pending_place_fields"> });
				}
				costs.record("owner fields", transaction_cost(before, await ctx.meta.getTransactionMetrics()));
				return result;
			} finally {
				insert.mockRestore();
			}
		});
		const progress = test_progress_guard();
		while (!seen.length) {
			const cohort = await current(f);
			if (cohort.publishedAt !== null) throw new Error("Expected owner fields before publication");
			progress([cohort.step, cohort.workPhase], "real AFTER owner fields");
			await step(f);
		}
		const actual = seen.flat();
		expect(actual.length).toBeGreaterThan(0);
		expect(new Set(actual.map((doc) => doc?._id)), "Every inserted AFTER field reaches the child read")
			.toEqual(new Set(inserted.map((doc) => doc._id)));
		for (const doc of actual) {
			expect(doc).not.toBeNull();
			const { _creationTime: _time, ...fields } = doc!;
			const expected = inserted.find((value) => value._id === doc!._id)!;
			expect(fields, "The child returns the exact full AFTER owner fields")
				.toEqual(Object.fromEntries(Object.entries(expected).filter(([, value]) => value !== undefined)));
		}
		expect(actual).toContainEqual(expect.objectContaining({
			target: { kind: "saved", id: f.ids[1]! }, fieldPath: "metadata.status", stringValue: "open",
			ownerTreePath: "/target/source/first-draft/", moveView: { cohortId: f.cohortId, view: "after" },
		}));
		expect(records(log).filter((record) => record.event === "owner_fields_after_flush").flatMap((record) => record.rowIds))
			.toEqual(actual.map((doc) => doc!._id));
	});

	test("an empty or unwritten page cannot count as a rollback unit", async () => {
		const f = await fixture();
		const cohort = await current(f);
		const log = vi.spyOn(console, "info").mockImplementation(() => {});
		await expect(run_wrapped(f.t, async (ctx) => {
			await begin_qa(ctx, cohort);
			overlay.files_pending_overlay_db_page_proof_rollback(ctx, cohort._id, false);
			const args = { organizationId: f.db.organizationId, workspaceId: f.db.workspaceId, cursor: null };
			await overlay.files_pending_overlay_db_page_proof_before(ctx, cohort, "metadata");
			const empty = await ctx.runQuery(internal.files_move_pages.metadata, { ...args, nodeId: f.ids[3]! });
			expect(empty.page).toEqual([]);
			await overlay.files_pending_overlay_db_page_proof_after(ctx, empty);
			overlay.files_pending_overlay_db_page_proof_body(ctx);
			await overlay.files_pending_overlay_db_can_join_step(ctx);
			await overlay.files_pending_overlay_db_page_proof_before(ctx, cohort, "metadata");
			const page = await ctx.runQuery(internal.files_move_pages.metadata, { ...args, nodeId: f.ids[1]! });
			expect(page.page.length).toBeGreaterThan(0);
			await overlay.files_pending_overlay_db_page_proof_after(ctx, page);
			// An inner reserve check cannot close a body that has not returned yet.
			await overlay.files_pending_overlay_db_can_join_step(ctx);
			overlay.files_pending_overlay_db_page_proof_body(ctx);
			await overlay.files_pending_overlay_db_can_join_step(ctx);
		})).rejects.toThrow("MOVE_PAGE_PROOF_SETUP_PAGE_WITHOUT_WRITES");
		expect(records(log).filter((record) => record.event === "rollback")).toEqual([]);
		expect(await current(f)).toEqual(cohort);
	});

	test.each([false, true])("drain repeats real identical args after flush; stale=%s", async (stale) => {
		const f = await fixture();
		await advance_to(f, "sides");
		use_qa_guard(f, stale);
		const events: string[] = [];
		const log = vi.spyOn(console, "info").mockImplementation((line: unknown) => {
			if (typeof line === "string" && line.startsWith("MOVE_PAGE_STATE_20261015 "))
				events.push((JSON.parse(line.slice("MOVE_PAGE_STATE_20261015 ".length)) as ProofRecord).event);
		});
		const flush = catalog.files_metadata_catalog_db_insert_deltas;
		vi.spyOn(catalog, "files_metadata_catalog_db_insert_deltas").mockImplementation(async (...args) => {
			await flush(...args);
			events.push("flush");
		});
		const queryArgs: unknown[] = [];
		test_spy_handler(metadata, async (handler, ctx, args) => {
			queryArgs.push(args);
			return await handler(ctx, args);
		});
		let staleCalls = 0;
		const costs = budget_recorder();
		test_spy_handler(advance, async (handler, ctx, args) => {
			const before = await ctx.meta.getTransactionMetrics();
			const runQuery = new Proxy(ctx.runQuery, {
				apply(target, receiver, callArgs: unknown[]) {
					if (getFunctionName(callArgs[0] as FunctionReference<"query">) === getFunctionName(internal.files_move_pages.metadata)
						&& (callArgs[2] as { useStaleSnapshot?: boolean } | undefined)?.useStaleSnapshot) staleCalls++;
					return Reflect.apply(target, receiver, callArgs);
				},
			});
			const result = await handler({ ...ctx, runQuery }, args);
			costs.record("drain", transaction_cost(before, await ctx.meta.getTransactionMetrics()));
			return result;
		});
		const progress = test_progress_guard();
		let failed = false;
		while (!records(log).some((record) => record.event === "drain")) {
			const cohort = await current(f);
			if (cohort.workPhase !== "sides") throw new Error("Expected a metadata drain before leaving side work");
			progress(cohort.step, "real metadata drain");
			events.length = 0;
			queryArgs.length = 0;
			try {
				await step(f);
			} catch (error) {
				if (!stale) throw error;
				expect((error as Error).message).toContain("The next drain page excludes rows tagged or deleted by the parent");
				failed = true;
				break;
			}
		}
		if (stale) {
			expect(failed).toBe(true);
			expect(staleCalls, "The repeated native read used the stale snapshot").toBe(1);
		} else {
			const drain = records(log).find((record) => record.event === "drain")!;
			expect(drain.beforeIds.length).toBeGreaterThan(0);
			expect(drain.beforeDone).toBe(true);
			expect(drain.afterIds).toEqual([]);
			expect(drain.afterDone).toBe(true);
			expect(events).toEqual(["flush", "drain"]);
			expect(staleCalls).toBe(0);
		}
		expect(queryArgs).toHaveLength(3);
		expect(queryArgs[1], "The two drain probes keep identical full args").toEqual(queryArgs[2]);
		expect(queryArgs[1]).not.toHaveProperty("proof");
	});
});
