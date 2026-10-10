import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, components, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { files_metadata_db_insert_committed } from "./files_metadata.ts";
import { insert_tree_node } from "./files_nodes.setup.test.ts";
import {
	test_compact_metadata_catalog,
	test_convex,
	test_finish_transfer_run,
	test_mocks_fill_db_with,
	test_move_nodes,
	test_run_with_flush,
} from "./setup.test.ts";
import { files_metadata_catalog_value_is_short } from "../server/files-metadata-catalog.ts";
import { files_pending_overlay_db_flush } from "../server/files-pending-overlay.ts";
import {
	organizations_GLOBAL_GITHUB_WORKSPACE_ID,
	organizations_GLOBAL_ORGANIZATION_ID,
} from "../shared/organizations.ts";

beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("catalog-test-work" as never);
	vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined as never);
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

type T = ReturnType<typeof test_convex>;
type Scope = { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces">; userId: Id<"users"> };

async function seed() {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId, name: "Catalog Owner" });
	const scope: Scope = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId };
	return { t, db, asOwner, scope };
}

async function create_folder(t: T, scope: Scope, path: string) {
	const created = await t.mutation(internal.files_nodes.create_folder_node_by_path, { ...scope, path });
	if (created._nay) throw new Error(created._nay.message);
	return created._yay.nodeId;
}

/**
 * A committed metadata doc of `nodeId`, as the savers write it: field docs carry the parent.
 */
function metadata_doc(
	scope: Pick<Doc<"files_metadata_docs">, "organizationId" | "workspaceId">,
	nodeId: Id<"files_nodes">,
	fields: {
		fieldPath: string;
		valueKind?: "string" | "number" | "boolean" | "maybe_date";
		stringValue?: string;
		parentId?: Id<"files_nodes">;
	},
) {
	const base = {
		organizationId: scope.organizationId,
		workspaceId: scope.workspaceId,
		sourceKind: "committed" as const,
		fileNodeId: nodeId,
		path: "/node",
		treePath: "/node",
		fieldPath: fields.fieldPath,
	};
	if (!fields.valueKind) return { ...base, docKind: "field" as const, parentId: fields.parentId ?? ("root" as const) };
	return {
		...base,
		docKind: "value" as const,
		valueKind: fields.valueKind,
		...(fields.valueKind === "string" ? { stringValue: fields.stringValue ?? "" } : {}),
		...(fields.valueKind === "number" ? { numberValue: 1 } : {}),
		...(fields.valueKind === "boolean" ? { booleanValue: true } : {}),
	};
}

async function insert_docs(t: T, docs: ReturnType<typeof metadata_doc>[]) {
	return await test_run_with_flush(t, async (ctx) => {
		const ids = [];
		for (const doc of docs) ids.push(await ctx.db.insert("files_metadata_docs", doc));
		return ids;
	});
}

async function list_deltas(t: T) {
	return await t.run(async (ctx) => await ctx.db.query("files_metadata_catalog_deltas").collect());
}

/**
 * Catalog rows without ids and tenant fields, sorted, so a test compares them as plain data.
 */
async function list_rows(t: T) {
	const rows = await t.run(async (ctx) => await ctx.db.query("files_metadata_catalog").collect());
	const sortKey = (row: (typeof rows)[number]) =>
		JSON.stringify([row.family, row.parentId ?? "", row.fieldPath, row.stringValue ?? ""]);
	return rows
		.sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1))
		.map(({ _id, _creationTime, organizationId, workspaceId, fieldPathLower, ...row }) => row);
}

const NO_KINDS = { string: 0, number: 0, boolean: 0, maybe_date: 0 };

describe("value byte rule", () => {
	test("counts UTF-8 bytes plus one byte per U+0000", () => {
		expect(files_metadata_catalog_value_is_short("a".repeat(1024))).toBe(true);
		expect(files_metadata_catalog_value_is_short("a".repeat(1025))).toBe(false);
		// Three bytes each: 341 make 1,023 bytes.
		expect(files_metadata_catalog_value_is_short("文".repeat(341))).toBe(true);
		expect(files_metadata_catalog_value_is_short("文".repeat(342))).toBe(false);
		// Two encoded bytes each.
		expect(files_metadata_catalog_value_is_short("\0".repeat(512))).toBe(true);
		expect(files_metadata_catalog_value_is_short("\0".repeat(513))).toBe(false);
	});
});

describe("catalog hook and compactor", () => {
	test("counts keys, kinds, values and parents, and deletes a row at zero", async () => {
		const { t, scope } = await seed();
		const a = await create_folder(t, scope, "/a");
		const b = await create_folder(t, scope, "/b");
		const [, , aNumber] = await insert_docs(t, [
			metadata_doc(scope, a, { fieldPath: "metadata.Status" }),
			metadata_doc(scope, a, { fieldPath: "metadata.Status", valueKind: "string", stringValue: "open" }),
			metadata_doc(scope, a, { fieldPath: "metadata.Status", valueKind: "number" }),
		]);
		await insert_docs(t, [
			metadata_doc(scope, b, { fieldPath: "metadata.Status" }),
			metadata_doc(scope, b, { fieldPath: "metadata.Status", valueKind: "string", stringValue: "open" }),
		]);
		await test_compact_metadata_catalog(t);
		expect(await list_rows(t)).toEqual([
			{ family: "key", fieldPath: "metadata.Status", count: 2, kindCounts: { ...NO_KINDS, string: 2, number: 1 } },
			{ family: "parent", fieldPath: "metadata.Status", parentId: "root", count: 2 },
			{ family: "value", fieldPath: "metadata.Status", stringValue: "open", count: 2 },
		]);
		const lower = await t.run(async (ctx) => (await ctx.db.query("files_metadata_catalog").first())?.fieldPathLower);
		expect(lower).toBe("metadata.status");

		// A kind change is a key change even when the count stays.
		await test_run_with_flush(t, async (ctx) => {
			await ctx.db.delete("files_metadata_docs", aNumber!);
		});
		await test_compact_metadata_catalog(t);
		expect((await list_rows(t))[0]).toMatchObject({ count: 2, kindCounts: { ...NO_KINDS, string: 2 } });

		await test_run_with_flush(t, async (ctx) => {
			for (const doc of await ctx.db.query("files_metadata_docs").collect())
				await ctx.db.delete("files_metadata_docs", doc._id);
		});
		await test_compact_metadata_catalog(t);
		expect(await list_rows(t)).toEqual([]);
		expect(await t.run(async (ctx) => await ctx.db.query("files_metadata_catalog_compactors").collect())).toEqual([]);
	});

	test("a write that keeps every contribution inserts no delta", async () => {
		const { t, scope } = await seed();
		const a = await create_folder(t, scope, "/a");
		const [fieldId] = await insert_docs(t, [metadata_doc(scope, a, { fieldPath: "metadata.status" })]);
		await test_compact_metadata_catalog(t);
		await test_run_with_flush(t, async (ctx) => {
			await ctx.db.patch("files_metadata_docs", fieldId!, { treePath: "/renamed", path: "/renamed" });
			// The same field path again: the old and new contributions cancel out.
			await ctx.db.patch("files_metadata_docs", fieldId!, { fieldPath: "metadata.status" });
		});
		expect(await list_deltas(t)).toEqual([]);
	});

	test("only saved, active, searchable docs of real workspaces count", async () => {
		const { t, db, scope } = await seed();
		const a = await create_folder(t, scope, "/a");
		const pendingUpdateId = await t.run(async (ctx) => (await ctx.db.query("files_pending_updates").first())?._id);
		await test_run_with_flush(t, async (ctx) => {
			await ctx.db.insert("files_metadata_docs", {
				...metadata_doc(scope, a, { fieldPath: "metadata.archived" }),
				archiveOperationId: "archive-op",
			});
			// 161 characters, and a path outside the search grammar.
			await ctx.db.insert("files_metadata_docs", metadata_doc(scope, a, { fieldPath: `metadata.${"k".repeat(152)}` }));
			await ctx.db.insert("files_metadata_docs", metadata_doc(scope, a, { fieldPath: "metadata.a.b" }));
			await ctx.db.insert("files_metadata_docs", {
				...metadata_doc(
					{ organizationId: organizations_GLOBAL_ORGANIZATION_ID, workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID },
					a,
					{ fieldPath: "metadata.global" },
				),
			});
			if (pendingUpdateId)
				await ctx.db.insert("files_metadata_docs", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					sourceKind: "pending",
					target: { kind: "saved", id: a },
					userId: db.userId,
					pendingUpdateId,
					proposalRevision: 1,
					path: "/a",
					treePath: "/a",
					fieldPath: "metadata.draft",
					docKind: "field",
				});
		});
		expect(await list_deltas(t)).toEqual([]);

		await insert_docs(t, [metadata_doc(scope, a, { fieldPath: `metadata.${"k".repeat(151)}` })]);
		await test_compact_metadata_catalog(t);
		expect((await list_rows(t)).map((row) => row.fieldPath.length)).toEqual([160, 160]);
	});

	test("long string values count in the string kind but get no value row", async () => {
		const { t, scope } = await seed();
		const a = await create_folder(t, scope, "/a");
		const values = ["a".repeat(1024), "a".repeat(1025), "文".repeat(341), "文".repeat(342), "\0".repeat(512), "\0".repeat(513)];
		await insert_docs(t, [
			metadata_doc(scope, a, { fieldPath: "metadata.long" }),
			...values.map((stringValue) => metadata_doc(scope, a, { fieldPath: "metadata.long", valueKind: "string", stringValue })),
		]);
		await test_compact_metadata_catalog(t);
		const rows = await list_rows(t);
		expect(rows.find((row) => row.family === "key")?.kindCounts).toEqual({ ...NO_KINDS, string: 6 });
		expect(
			rows
				.filter((row) => row.family === "value")
				.map((row) => row.stringValue)
				.sort(),
		).toEqual([values[4], values[0], values[2]].sort());
	});

	test("an uncached archive patch reads its old doc and moves the counts", async () => {
		const { t, scope } = await seed();
		const a = await create_folder(t, scope, "/a");
		const ids = await insert_docs(t, [
			metadata_doc(scope, a, { fieldPath: "metadata.status" }),
			metadata_doc(scope, a, { fieldPath: "metadata.status", valueKind: "string", stringValue: "open" }),
		]);
		await test_compact_metadata_catalog(t);
		// A new transaction: the wrapper knows neither doc.
		await test_run_with_flush(t, async (ctx) => {
			for (const id of ids) await ctx.db.patch("files_metadata_docs", id, { archiveOperationId: "archive-op" });
		});
		await test_compact_metadata_catalog(t);
		expect(await list_rows(t)).toEqual([]);
		await test_run_with_flush(t, async (ctx) => {
			for (const id of ids) await ctx.db.patch("files_metadata_docs", id, { archiveOperationId: undefined });
		});
		await test_compact_metadata_catalog(t);
		expect(await list_rows(t)).toHaveLength(3);
	});

	test("every flush inserts its own changes once", async () => {
		const { t, scope } = await seed();
		const a = await create_folder(t, scope, "/a");
		await test_run_with_flush(t, async (ctx) => {
			await ctx.db.insert("files_metadata_docs", metadata_doc(scope, a, { fieldPath: "metadata.status" }));
			await files_pending_overlay_db_flush(ctx);
			await files_pending_overlay_db_flush(ctx);
			await ctx.db.insert("files_metadata_docs", metadata_doc(scope, a, { fieldPath: "metadata.status" }));
		});
		expect((await list_deltas(t)).map((delta) => [delta.family, delta.count])).toEqual([
			["key", 1],
			["parent", 1],
			["key", 1],
			["parent", 1],
		]);
		expect(await t.run(async (ctx) => await ctx.db.query("files_metadata_catalog_compactors").collect())).toHaveLength(1);
		await test_compact_metadata_catalog(t);
		expect((await list_rows(t)).map((row) => row.count)).toEqual([2, 2]);
	});

	test("the compactor takes old deltas only and keeps running while deltas remain", async () => {
		const { t, scope } = await seed();
		const a = await create_folder(t, scope, "/a");
		await insert_docs(t, [metadata_doc(scope, a, { fieldPath: "metadata.first" })]);
		const marker = await t.run(async (ctx) => await ctx.db.query("files_metadata_catalog_compactors").unique());
		vi.setSystemTime(Date.now() + 5001);
		// A young delta, inserted after the old ones.
		await insert_docs(t, [metadata_doc(scope, a, { fieldPath: "metadata.second" })]);
		await t.mutation(internal.files_pending_overlay.compact_metadata_catalog, { markerId: marker!._id });
		expect((await list_rows(t)).map((row) => row.fieldPath)).toEqual(["metadata.first", "metadata.first"]);
		expect((await list_deltas(t)).map((delta) => delta.fieldPath)).toEqual(["metadata.second", "metadata.second"]);
		// The saver did not touch the marker, and the run kept it for the young delta.
		expect(await t.run(async (ctx) => await ctx.db.get("files_metadata_catalog_compactors", marker!._id))).toEqual(
			marker,
		);
		const scheduled = await t.run(async (ctx) =>
			(await ctx.db.system.query("_scheduled_functions").collect()).filter(
				(job) => job.name.includes("compact_metadata_catalog") && job.state.kind === "pending",
			),
		);
		expect(scheduled.length).toBeGreaterThanOrEqual(2);
		await test_compact_metadata_catalog(t);
		expect(await list_rows(t)).toHaveLength(4);
	});

	test("drift clamps to zero and logs one line without values", async () => {
		const { t, scope } = await seed();
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		await t.run(async (ctx) => {
			await ctx.db.insert("files_metadata_catalog_deltas", {
				organizationId: scope.organizationId,
				workspaceId: scope.workspaceId,
				family: "value",
				fieldPathLower: "metadata.secret",
				fieldPath: "metadata.secret",
				stringValue: "top secret value",
				count: -1,
			});
			await ctx.db.insert("files_metadata_catalog_deltas", {
				organizationId: scope.organizationId,
				workspaceId: scope.workspaceId,
				family: "key",
				fieldPathLower: "metadata.secret",
				fieldPath: "metadata.secret",
				count: 1,
				kindCounts: { ...NO_KINDS, string: -2 },
			});
			await ctx.db.insert("files_metadata_catalog_compactors", {
				organizationId: scope.organizationId,
				workspaceId: scope.workspaceId,
				phase: "draining",
			});
		});
		await test_compact_metadata_catalog(t);
		expect(await list_rows(t)).toEqual([
			{ family: "key", fieldPath: "metadata.secret", count: 1, kindCounts: NO_KINDS },
		]);
		const drift = errors.mock.calls.filter(([message]) => message === "files_metadata_catalog drift");
		expect(drift).toEqual([
			[
				"files_metadata_catalog drift",
				{ workspaceId: scope.workspaceId, family: "value", fieldPath: "metadata.secret", parentId: undefined, driftRows: 2 },
			],
		]);
		expect(JSON.stringify(errors.mock.calls)).not.toContain("top secret value");
	});

	test("a run of a deleted marker does nothing, also after a new marker exists", async () => {
		const { t, scope } = await seed();
		const a = await create_folder(t, scope, "/a");
		await insert_docs(t, [metadata_doc(scope, a, { fieldPath: "metadata.status" })]);
		const old = await t.run(async (ctx) => await ctx.db.query("files_metadata_catalog_compactors").unique());
		await t.run(async (ctx) => await ctx.db.delete("files_metadata_catalog_compactors", old!._id));
		await insert_docs(t, [metadata_doc(scope, a, { fieldPath: "metadata.status" })]);
		vi.setSystemTime(Date.now() + 5001);
		await t.mutation(internal.files_pending_overlay.compact_metadata_catalog, { markerId: old!._id });
		expect(await list_rows(t)).toEqual([]);
		expect(await list_deltas(t)).toHaveLength(4);
		await test_compact_metadata_catalog(t);
		expect((await list_rows(t)).map((row) => row.count)).toEqual([2, 2]);
	});

	test("the recover cron restarts a marker whose oldest delta waited too long", async () => {
		const { t, scope } = await seed();
		const a = await create_folder(t, scope, "/a");
		await insert_docs(t, [metadata_doc(scope, a, { fieldPath: "metadata.status" })]);
		const pending = async () =>
			await t.run(async (ctx) =>
				(await ctx.db.system.query("_scheduled_functions").collect()).filter(
					(job) => job.name.includes("compact_metadata_catalog") && job.state.kind === "pending",
				).length,
			);
		// Lose the saver's run, like a chain that threw.
		await t.run(async (ctx) => {
			for (const job of await ctx.db.system.query("_scheduled_functions").collect())
				if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
		});
		await t.mutation(internal.files_pending_overlay.recover_metadata_catalog, { cursor: null });
		expect(await pending()).toBe(0);
		vi.setSystemTime(Date.now() + 10 * 60 * 1000 + 1);
		await t.mutation(internal.files_pending_overlay.recover_metadata_catalog, { cursor: null });
		expect(await pending()).toBe(1);
	});
});

describe("catalog rebuild and check", () => {
	/**
	 * Saved docs over two folders. File `a` has more docs than a seed page, with its key's field doc
	 * after its value docs, so its key row must wait for the file's last page.
	 */
	async function seed_catalog(t: T, scope: Scope) {
		const a = await create_folder(t, scope, "/a");
		const b = await create_folder(t, scope, "/b");
		await insert_docs(t, [
			...Array.from({ length: 130 }, (_, index) =>
				metadata_doc(scope, a, { fieldPath: "metadata.tags", valueKind: "string", stringValue: `tag ${index}` }),
			),
			metadata_doc(scope, a, { fieldPath: "metadata.tags" }),
			metadata_doc(scope, a, { fieldPath: "metadata.status" }),
			metadata_doc(scope, a, { fieldPath: "metadata.status", valueKind: "number" }),
			metadata_doc(scope, b, { fieldPath: "metadata.status", parentId: a }),
			metadata_doc(scope, b, { fieldPath: "metadata.status", valueKind: "string", stringValue: "open" }),
			metadata_doc(scope, b, { fieldPath: "metadata.status", valueKind: "boolean" }),
			metadata_doc(scope, b, { fieldPath: "metadata.status", valueKind: "string", stringValue: "x".repeat(1025) }),
		]);
		await test_run_with_flush(t, async (ctx) => {
			await ctx.db.insert("files_metadata_docs", {
				...metadata_doc(scope, b, { fieldPath: "metadata.archived" }),
				archiveOperationId: "archive-op",
			});
		});
		await test_compact_metadata_catalog(t);
		return { a, b };
	}

	async function compact_once(t: T) {
		vi.setSystemTime(Date.now() + 5001);
		for (const marker of await t.run(async (ctx) => await ctx.db.query("files_metadata_catalog_compactors").collect()))
			await t.mutation(internal.files_pending_overlay.compact_metadata_catalog, { markerId: marker._id });
	}

	async function start_rebuild(t: T, scope: Scope, mode: "catalog" | "check" | "clear_check") {
		return await t.mutation(internal.files_pending_overlay.rebuild_metadata_catalog, {
			organizationId: scope.organizationId,
			workspaceId: scope.workspaceId,
			mode,
		});
	}

	/**
	 * Run the scheduled rebuild jobs one by one, with one compactor run after each, so seed pages and
	 * compaction take turns. Then drain. The scheduled runs never fire on their own in these tests.
	 */
	async function run_rebuild_jobs(t: T, between = async () => await compact_once(t)) {
		const done = new Set<string>();
		for (;;) {
			const job = await t.run(async (ctx) =>
				(await ctx.db.system.query("_scheduled_functions").collect()).find(
					(job) => job.name.includes("rebuild_metadata_catalog_step") && !done.has(job._id),
				),
			);
			if (!job) break;
			done.add(job._id);
			await t.mutation(internal.files_pending_overlay.rebuild_metadata_catalog_step, job.args[0]);
			await between();
		}
		await test_compact_metadata_catalog(t);
		return done.size;
	}

	async function rebuild(t: T, scope: Scope, mode: "catalog" | "check" | "clear_check") {
		await start_rebuild(t, scope, mode);
		return await run_rebuild_jobs(t);
	}

	async function check(t: T, scope: Scope) {
		const differences: string[] = [];
		let cursor: string | null = null;
		do {
			const page: { differences: string[]; cursor: string | null } = await t.query(
				internal.files_pending_overlay.check_metadata_catalog,
				{ organizationId: scope.organizationId, workspaceId: scope.workspaceId, cursor },
			);
			differences.push(...page.differences);
			cursor = page.cursor;
		} while (cursor);
		return differences;
	}

	test("a rebuild counts the same rows as the savers, also when a file spans seed pages", async () => {
		const { t, scope } = await seed();
		const { a } = await seed_catalog(t, scope);
		const expected = await list_rows(t);
		expect(expected.filter((row) => row.family !== "value")).toEqual([
			{ family: "key", fieldPath: "metadata.status", count: 2, kindCounts: { string: 2, number: 1, boolean: 1, maybe_date: 0 } },
			{ family: "key", fieldPath: "metadata.tags", count: 1, kindCounts: { ...NO_KINDS, string: 130 } },
			{ family: "parent", fieldPath: "metadata.status", parentId: a, count: 1 },
			{ family: "parent", fieldPath: "metadata.status", parentId: "root", count: 1 },
			{ family: "parent", fieldPath: "metadata.tags", parentId: "root", count: 1 },
		]);
		// More rows than one clear job deletes.
		expect(expected).toHaveLength(136);

		// Drift: a wrong count, a lost row and an extra row.
		await t.run(async (ctx) => {
			const [first, second] = await ctx.db.query("files_metadata_catalog").collect();
			await ctx.db.patch("files_metadata_catalog", first!._id, { count: 9 });
			await ctx.db.delete("files_metadata_catalog", second!._id);
			const { _id, _creationTime, ...row } = second!;
			await ctx.db.insert("files_metadata_catalog", { ...row, fieldPath: "metadata.extra" });
		});
		const errors = vi.spyOn(console, "error");
		await start_rebuild(t, scope, "catalog");
		const phases: string[] = [];
		const jobs = await run_rebuild_jobs(t, async () => {
			await compact_once(t);
			const marker = await t.run(async (ctx) => await ctx.db.query("files_metadata_catalog_compactors").first());
			phases.push(marker?.phase ?? "none");
		});
		// Two clear jobs, then two seed pages. A seeding marker stays while no delta waits.
		expect(jobs).toBe(4);
		expect(phases).toEqual(["clearing", "seeding", "seeding", "none"]);
		expect(await list_rows(t)).toEqual(expected);
		expect(errors.mock.calls.filter(([message]) => message === "files_metadata_catalog drift")).toEqual([]);

		await rebuild(t, scope, "catalog");
		expect(await list_rows(t)).toEqual(expected);
	});

	test("the check finds no difference in a right catalog, and clear_check deletes the shadow rows", async () => {
		const { t, scope } = await seed();
		await seed_catalog(t, scope);
		const rows = await list_rows(t);
		await rebuild(t, scope, "check");
		expect((await list_rows(t)).filter((row) => row.family.startsWith("check_"))).toHaveLength(rows.length);
		expect(await check(t, scope)).toEqual([]);
		// A second check rebuild replaces the shadow rows and gives the same result.
		await rebuild(t, scope, "check");
		expect(await check(t, scope)).toEqual([]);
		await rebuild(t, scope, "clear_check");
		expect(await list_rows(t)).toEqual(rows);
	});

	test("the check finds wrong counts, lost rows and extra rows, and names no value", async () => {
		const { t, scope } = await seed();
		const { a } = await seed_catalog(t, scope);
		await rebuild(t, scope, "check");
		const find = async (family: string, fieldPath: string, parentId?: string) =>
			(await t.run(async (ctx) => await ctx.db.query("files_metadata_catalog").collect())).find(
				(row) => row.family === family && row.fieldPath === fieldPath && (parentId === undefined || row.parentId === parentId),
			)!;

		const key = await find("key", "metadata.status");
		for (const kind of ["string", "number", "boolean", "maybe_date"] as const) {
			await t.run(async (ctx) => {
				await ctx.db.patch("files_metadata_catalog", key._id, { kindCounts: { ...key.kindCounts!, [kind]: key.kindCounts![kind] + 1 } });
			});
			expect(await check(t, scope)).toEqual([expect.stringContaining(`key row ${key._id} of metadata.status: count 2`)]);
		}
		await t.run(async (ctx) => await ctx.db.patch("files_metadata_catalog", key._id, { kindCounts: key.kindCounts }));

		// A wrong positive count of one folder.
		const parent = await find("parent", "metadata.status", a);
		await t.run(async (ctx) => await ctx.db.patch("files_metadata_catalog", parent._id, { count: 2 }));
		expect(await check(t, scope)).toEqual([`parent row ${parent._id} of metadata.status in ${a}: count 2 null, expected 1 null`]);
		await t.run(async (ctx) => await ctx.db.patch("files_metadata_catalog", parent._id, { count: 1 }));

		const open = await find("value", "metadata.status");
		await t.run(async (ctx) => {
			await ctx.db.delete("files_metadata_catalog", open._id);
			await ctx.db.insert("files_metadata_catalog", {
				organizationId: scope.organizationId,
				workspaceId: scope.workspaceId,
				family: "value",
				fieldPathLower: "metadata.status",
				fieldPath: "metadata.status",
				stringValue: "top secret value",
				count: 1,
			});
		});
		const differences = await check(t, scope);
		expect(differences).toEqual([
			expect.stringMatching(/^extra row: value row .* of metadata\.status has no saved doc$/),
			expect.stringMatching(/^missing row: check_value row .* of metadata\.status has no value row$/),
		]);
		expect(JSON.stringify(differences)).not.toContain("top secret value");
		expect(JSON.stringify(differences)).not.toContain("open");
	});

	test("the check and a check rebuild refuse a workspace with deltas or a Move", async () => {
		const { t, db, asOwner, scope } = await seed();
		const { a } = await seed_catalog(t, scope);
		const dst = await create_folder(t, scope, "/dst");
		await insert_docs(t, [metadata_doc(scope, a, { fieldPath: "metadata.late" })]);
		const unsettled = ["the catalog is not settled: a Move, a compactor or a delta is still running"];
		expect(await check(t, scope)).toEqual(unsettled);
		await expect(start_rebuild(t, scope, "check")).rejects.toThrow("The catalog still has deltas");
		await test_compact_metadata_catalog(t);

		const move: { cohortId?: Id<"files_move_cohorts"> } = {};
		await t.mutation(components.rate_limiter.lib.resetRateLimit, { name: "files_tree_write", key: db.userId });
		const moved = await test_move_nodes(t, asOwner, {
			membershipId: db.membershipId,
			itemIds: [a],
			targetParentId: dst,
			onStep: async () => {
				const slot = await t.run(async (ctx) => await ctx.db.query("files_move_workspace_slots").first());
				if (!slot?.cohortId || move.cohortId) return;
				move.cohortId = slot.cohortId;
				await expect(start_rebuild(t, scope, "catalog")).rejects.toThrow("A Move runs in this workspace");
				expect(await check(t, scope)).toEqual(unsettled);
			},
		});
		expect(moved._nay).toBeUndefined();
		expect(move.cohortId).toBeDefined();

		// A row of a Move view outlives its Move only by a bug.
		await test_compact_metadata_catalog(t);
		await t.run(async (ctx) => {
			await ctx.db.insert("files_metadata_catalog", {
				moveView: { cohortId: move.cohortId!, view: "after" },
				organizationId: scope.organizationId,
				workspaceId: scope.workspaceId,
				family: "key",
				fieldPathLower: "metadata.status",
				fieldPath: "metadata.status",
				count: 1,
				kindCounts: NO_KINDS,
			});
		});
		await rebuild(t, scope, "check");
		expect(await check(t, scope)).toContainEqual(expect.stringMatching(/^key row .* of metadata\.status belongs to an ended Move$/));
	});

	test("a new rebuild stops the jobs of the old one", async () => {
		const { t, scope } = await seed();
		await seed_catalog(t, scope);
		const expected = await list_rows(t);
		const old = await start_rebuild(t, scope, "catalog");
		const [oldJob] = await t.run(async (ctx) =>
			(await ctx.db.system.query("_scheduled_functions").collect()).filter((job) => job.name.includes("rebuild_metadata_catalog_step")),
		);
		await start_rebuild(t, scope, "catalog");
		const before = await list_rows(t);
		await t.mutation(internal.files_pending_overlay.rebuild_metadata_catalog_step, oldJob!.args[0]);
		await t.mutation(internal.files_pending_overlay.compact_metadata_catalog, { markerId: old });
		expect(await list_rows(t)).toEqual(before);
		expect(await t.run(async (ctx) => await ctx.db.get("files_metadata_catalog_compactors", old))).toBeNull();
		await run_rebuild_jobs(t);
		expect(await list_rows(t)).toEqual(expected);
	});
});

describe("catalog lifecycle", () => {
	async function reset_tree_write_limit(t: T, userId: Id<"users">) {
		await t.mutation(components.rate_limiter.lib.resetRateLimit, { name: "files_tree_write", key: userId });
	}

	async function set_status(t: T, db: { userId: Id<"users">; membershipId: Id<"organizations_workspaces_users"> }, nodeId: Id<"files_nodes">) {
		const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		await reset_tree_write_limit(t, db.userId);
		const written = await asOwner.mutation(api.files_metadata.set_entries, {
			membershipId: db.membershipId,
			fileNodeId: nodeId,
			metadataYaml: "status: open\n",
		});
		expect(written).toEqual({ _yay: null });
	}

	/**
	 * The rows a reader sees: normal rows plus the rows of the workspace's visible Move view, like the
	 * saved list merges its streams (`server/files-saved-list.ts`). Compacts first, then puts the
	 * clock back, so Move leases see no time pass.
	 */
	async function visible_rows(t: T, scope: Scope) {
		const now = Date.now();
		await test_compact_metadata_catalog(t);
		vi.setSystemTime(now);
		return await t.run(async (ctx) => {
			const slot = await ctx.db
				.query("files_move_workspace_slots")
				.withIndex("by_workspace", (q) => q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId))
				.unique();
			const cohort = slot?.cohortId ? await ctx.db.get("files_move_cohorts", slot.cohortId) : null;
			const counts = new Map<string, number>();
			for (const row of await ctx.db.query("files_metadata_catalog").collect()) {
				if (row.moveView && (row.moveView.cohortId !== cohort?._id || row.moveView.view !== cohort.visibleView)) continue;
				const key = `${row.family}:${row.parentId ?? ""}:${row.fieldPath}:${row.stringValue ?? ""}`;
				counts.set(key, (counts.get(key) ?? 0) + row.count);
			}
			return [...counts].map(([key, count]) => `${key}=${count}`).sort();
		});
	}

	test("a Move keeps every key visible at every step and moves the parent rows", async () => {
		const { t, db, asOwner, scope } = await seed();
		const src = await create_folder(t, scope, "/src");
		const a = await create_folder(t, scope, "/src/a");
		const b = await create_folder(t, scope, "/src/b");
		const dst = await create_folder(t, scope, "/dst");
		for (const nodeId of [a, b]) await set_status(t, db, nodeId);
		const before = await visible_rows(t, scope);
		expect(before).toEqual([
			"key::metadata.status:=2",
			`parent:${src}:metadata.status:=2`,
			"value::metadata.status:open=2",
		]);
		const after = ["key::metadata.status:=2", `parent:${dst}:metadata.status:=1`, `parent:${src}:metadata.status:=1`, "value::metadata.status:open=2"].sort();

		const seen = new Set<string>();
		await reset_tree_write_limit(t, db.userId);
		const moved = await test_move_nodes(t, asOwner, {
			membershipId: db.membershipId,
			itemIds: [a],
			targetParentId: dst,
			onStep: async () => {
				const rows = await visible_rows(t, scope);
				seen.add(JSON.stringify(rows));
				expect([JSON.stringify(before), JSON.stringify(after)]).toContain(JSON.stringify(rows));
			},
		});
		expect(moved._nay).toBeUndefined();
		expect(await visible_rows(t, scope)).toEqual(after);
		// No tagged row is left behind.
		expect((await t.run(async (ctx) => await ctx.db.query("files_metadata_catalog").collect())).filter((row) => row.moveView)).toEqual([]);
		expect(seen.size).toBe(2);
	});

	test("a folder copy counts the copied folder metadata under its new parent", async () => {
		const { t, db, asOwner, scope } = await seed();
		const src = await create_folder(t, scope, "/src");
		const a = await create_folder(t, scope, "/src/a");
		const dst = await create_folder(t, scope, "/dst");
		await set_status(t, db, a);
		await reset_tree_write_limit(t, db.userId);
		const started = await asOwner.mutation(api.files_transfer.start, {
			membershipId: db.membershipId,
			requestId: crypto.randomUUID(),
			kind: "copy",
			expectedSourceCount: 1,
			sourceIds: [a],
			targetParentId: dst,
		});
		if (started._nay) throw new Error(started._nay.message);
		expect(await asOwner.mutation(api.files_transfer.seal, { membershipId: db.membershipId, runId: started._yay.runId })).toEqual({
			_yay: null,
		});
		await test_finish_transfer_run(asOwner, started._yay.runId);
		expect(await visible_rows(t, scope)).toEqual(
			[
				"key::metadata.status:=2",
				`parent:${dst}:metadata.status:=1`,
				`parent:${src}:metadata.status:=1`,
				"value::metadata.status:open=2",
			].sort(),
		);
	});

	test("a Move stopped after staging leaves the catalog as it was", async () => {
		const { t, db, asOwner, scope } = await seed();
		const errors = vi.spyOn(console, "error");
		await create_folder(t, scope, "/src");
		const a = await create_folder(t, scope, "/src/a");
		const dst = await create_folder(t, scope, "/dst");
		await set_status(t, db, a);
		const before = await visible_rows(t, scope);

		let stopped = false;
		await reset_tree_write_limit(t, db.userId);
		const moved = await test_move_nodes(t, asOwner, {
			membershipId: db.membershipId,
			itemIds: [a],
			targetParentId: dst,
			onStep: async () => {
				expect(await visible_rows(t, scope)).toEqual(before);
				if (stopped) return;
				const tagged = await t.run(async (ctx) =>
					(await ctx.db.query("files_metadata_catalog").collect()).filter((row) => row.moveView?.view === "after"),
				);
				if (tagged.length === 0) return;
				const run = await t.run(async (ctx) => await ctx.db.query("files_transfer_runs").first());
				expect(await asOwner.mutation(api.files_transfer.stop, { membershipId: db.membershipId, runId: run!._id })).toEqual({
					_yay: null,
				});
				stopped = true;
			},
		});
		expect(stopped).toBe(true);
		expect(moved._nay).toBeDefined();
		expect(await visible_rows(t, scope)).toEqual(before);
		expect((await t.run(async (ctx) => await ctx.db.query("files_metadata_catalog").collect())).filter((row) => row.moveView)).toEqual([]);
		expect(errors.mock.calls.filter(([message]) => message === "files_metadata_catalog drift")).toEqual([]);
	});

	test("a frontmatter save counts its keys, and the same save again inserts no delta", async () => {
		const { t, scope } = await seed();
		const markdown = [
			"---",
			"Status: open",
			"reported: 2026-09-04",
			"tags:",
			"  - teams",
			"  - macos",
			"source:",
			"  channel: qa",
			"---",
			"Body",
		].join("\n");
		const nodeId = await test_run_with_flush(t, async (ctx) => {
			const nodeId = await insert_tree_node({ ctx, owner: scope, parentId: "root", path: "/task.md", kind: "file" });
			await files_metadata_db_insert_committed(ctx, { ...scope, nodeId, markdownContent: markdown });
			return nodeId;
		});
		await test_compact_metadata_catalog(t);
		const rows = await list_rows(t);
		expect(rows.filter((row) => row.family === "key")).toEqual([
			{ family: "key", fieldPath: "frontmatter.Status", count: 1, kindCounts: { ...NO_KINDS, string: 1 } },
			{ family: "key", fieldPath: "frontmatter.reported", count: 1, kindCounts: { ...NO_KINDS, string: 1, maybe_date: 1 } },
			{ family: "key", fieldPath: "frontmatter.source", count: 1, kindCounts: NO_KINDS },
			{ family: "key", fieldPath: "frontmatter.source.channel", count: 1, kindCounts: { ...NO_KINDS, string: 1 } },
			{ family: "key", fieldPath: "frontmatter.tags", count: 1, kindCounts: { ...NO_KINDS, string: 2 } },
		]);
		expect(rows.filter((row) => row.family === "value").map((row) => `${row.fieldPath}=${row.stringValue}`)).toEqual([
			"frontmatter.Status=open",
			"frontmatter.reported=2026-09-04",
			"frontmatter.source.channel=qa",
			"frontmatter.tags=macos",
			"frontmatter.tags=teams",
		]);
		expect(rows.filter((row) => row.family === "parent").map((row) => row.parentId)).toEqual(Array(5).fill("root"));

		// A content save deletes and writes the frontmatter docs again.
		await test_run_with_flush(t, async (ctx) => {
			for (const doc of await ctx.db
				.query("files_metadata_docs")
				.withIndex("by_organization_workspace_source_fileNode", (q) =>
					q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId).eq("sourceKind", "committed").eq("fileNodeId", nodeId),
				)
				.collect())
				await ctx.db.delete("files_metadata_docs", doc._id);
			await files_metadata_db_insert_committed(ctx, { ...scope, nodeId, markdownContent: markdown });
		});
		expect(await list_deltas(t)).toEqual([]);
	});

	test("archiving a folder walks its children once: five of six shared keys go", async () => {
		const { t, db, asOwner, scope } = await seed();
		const errors = vi.spyOn(console, "error");
		const shared = await create_folder(t, scope, "/shared");
		const children = [];
		for (const name of ["a", "b", "c", "d", "e"]) children.push(await create_folder(t, scope, `/shared/${name}`));
		const outside = await create_folder(t, scope, "/outside");
		for (const nodeId of [...children, outside]) {
			await reset_tree_write_limit(t, db.userId);
			const written = await asOwner.mutation(api.files_metadata.set_entries, {
				membershipId: db.membershipId,
				fileNodeId: nodeId,
				metadataYaml: "status: open\n",
			});
			expect(written).toEqual({ _yay: null });
		}
		await test_compact_metadata_catalog(t);
		expect(await list_rows(t)).toEqual([
			{ family: "key", fieldPath: "metadata.status", count: 6, kindCounts: { ...NO_KINDS, string: 6 } },
			{ family: "parent", fieldPath: "metadata.status", parentId: shared, count: 5 },
			{ family: "parent", fieldPath: "metadata.status", parentId: "root", count: 1 },
			{ family: "value", fieldPath: "metadata.status", stringValue: "open", count: 6 },
		]);

		await reset_tree_write_limit(t, db.userId);
		const archived = await asOwner.mutation(api.files_nodes.archive_nodes, {
			membershipId: db.membershipId,
			nodeIds: [String(shared)],
		});
		expect(archived._nay).toBeUndefined();
		const keyDeltas = (await list_deltas(t)).filter((delta) => delta.family === "key");
		expect(keyDeltas.reduce((sum, delta) => sum + delta.count, 0)).toBe(-5);
		await test_compact_metadata_catalog(t);
		expect(await list_rows(t)).toEqual([
			{ family: "key", fieldPath: "metadata.status", count: 1, kindCounts: { ...NO_KINDS, string: 1 } },
			{ family: "parent", fieldPath: "metadata.status", parentId: "root", count: 1 },
			{ family: "value", fieldPath: "metadata.status", stringValue: "open", count: 1 },
		]);
		expect(errors.mock.calls.filter(([message]) => message === "files_metadata_catalog drift")).toEqual([]);

		await reset_tree_write_limit(t, db.userId);
		const restored = await asOwner.mutation(api.files_nodes.unarchive_nodes, {
			membershipId: db.membershipId,
			nodeIds: [String(shared)],
		});
		expect(restored._nay).toBeUndefined();
		await test_compact_metadata_catalog(t);
		expect((await list_rows(t)).map((row) => row.count)).toEqual([6, 5, 1, 6]);
	});
});
