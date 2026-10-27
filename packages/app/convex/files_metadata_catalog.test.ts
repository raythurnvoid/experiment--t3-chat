import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, components, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import { files_metadata_db_insert_committed } from "./files_metadata_db.ts";
import { insert_tree_node, seed_grant_only_member } from "./files_nodes.setup.test.ts";
import {
	test_compact_metadata_catalog,
	test_convex,
	test_finish_archive_jobs,
	test_finish_file_index,
	test_finish_saved_scope_jobs,
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
 * Another member of the workspace. The `member` role reads the whole workspace except restricted
 * folders; with no role they read only what is shared with them.
 */
async function seed_member(t: T, db: Awaited<ReturnType<typeof seed>>["db"], name: string, role: "member" | null) {
	const member = await seed_grant_only_member({ t, db, suffix: name });
	if (role)
		await t.run((ctx) =>
			access_control_db_ensure_role_assignment(ctx, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: member.userId,
				role,
				now: Date.now(),
			}),
		);
	return member;
}

/**
 * Run the scope ops, the saved scope jobs and the compactor, so every area row is current.
 */
async function settle_catalog(t: T) {
	await t.finishAllScheduledFunctions(vi.runAllTimers);
	await test_finish_saved_scope_jobs(t);
	await test_compact_metadata_catalog(t);
}

/**
 * A committed metadata doc of `nodeId`, as the savers write it: every doc carries the open area, and
 * field docs carry the parent and the restricted flag of an open node.
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
		restrictedScopeNodeId: null,
	};
	if (!fields.valueKind)
		return { ...base, docKind: "field" as const, parentId: fields.parentId ?? ("root" as const), isRestrictedScopeRoot: false };
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
			{
				family: "area_key",
				fieldPath: "metadata.Status",
				parentId: "root",
				count: 2,
				kindCounts: { ...NO_KINDS, string: 2, number: 1 },
			},
			{ family: "area_value", fieldPath: "metadata.Status", parentId: "root", stringValue: "open", count: 2 },
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

	test("a restricted root's field doc, or one without the flag, counts in parent_restricted", async () => {
		const { t, scope } = await seed();
		const [a, b, c] = [await create_folder(t, scope, "/a"), await create_folder(t, scope, "/b"), await create_folder(t, scope, "/c")];
		const [openId] = await insert_docs(t, [metadata_doc(scope, a, { fieldPath: "metadata.status" })]);
		await test_run_with_flush(t, async (ctx) => {
			await ctx.db.insert("files_metadata_docs", {
				...metadata_doc(scope, b, { fieldPath: "metadata.status" }),
				isRestrictedScopeRoot: true,
			});
			await ctx.db.insert("files_metadata_docs", {
				...metadata_doc(scope, c, { fieldPath: "metadata.status" }),
				isRestrictedScopeRoot: undefined,
			});
		});
		await test_compact_metadata_catalog(t);
		expect(await list_rows(t)).toEqual([
			{ family: "area_key", fieldPath: "metadata.status", parentId: "root", count: 3, kindCounts: NO_KINDS },
			{ family: "key", fieldPath: "metadata.status", count: 3, kindCounts: NO_KINDS },
			{ family: "parent", fieldPath: "metadata.status", parentId: "root", count: 1 },
			{ family: "parent_restricted", fieldPath: "metadata.status", parentId: "root", count: 2 },
		]);

		// A new transaction: the wrapper does not know the doc, and a patch of the flag alone still moves it.
		await test_run_with_flush(t, async (ctx) => {
			await ctx.db.patch("files_metadata_docs", openId!, { isRestrictedScopeRoot: true });
		});
		await test_compact_metadata_catalog(t);
		expect((await list_rows(t)).filter((row) => row.family.startsWith("parent"))).toEqual([
			{ family: "parent_restricted", fieldPath: "metadata.status", parentId: "root", count: 3 },
		]);
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
		expect((await list_rows(t)).map((row) => row.fieldPath.length)).toEqual([160, 160, 160]);
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
		expect(await list_rows(t)).toHaveLength(5);
	});

	test("two writes of one doc in one Promise.all count the doc once", async () => {
		const { t, scope } = await seed();
		const a = await create_folder(t, scope, "/a");
		const b = await create_folder(t, scope, "/b");
		const [fieldId] = await insert_docs(t, [metadata_doc(scope, a, { fieldPath: "metadata.status" })]);
		await test_compact_metadata_catalog(t);
		const errors = vi.spyOn(console, "error");
		// Both writes read the old doc before either ends. The archive must build on the new parent.
		await test_run_with_flush(t, async (ctx) => {
			await Promise.all([
				ctx.db.patch("files_metadata_docs", fieldId!, { parentId: b }),
				ctx.db.patch("files_metadata_docs", fieldId!, { archiveOperationId: "archive-op" }),
			]);
		});
		await test_compact_metadata_catalog(t);
		expect(await list_rows(t)).toEqual([]);
		expect(errors.mock.calls.filter(([message]) => message === "files_metadata_catalog drift")).toEqual([]);
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
			["area_key", 1],
			["parent", 1],
			["key", 1],
			["area_key", 1],
			["parent", 1],
		]);
		expect(await t.run(async (ctx) => await ctx.db.query("files_metadata_catalog_compactors").collect())).toHaveLength(1);
		await test_compact_metadata_catalog(t);
		expect((await list_rows(t)).map((row) => row.count)).toEqual([2, 2, 2]);
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
		expect((await list_rows(t)).map((row) => row.fieldPath)).toEqual([
			"metadata.first",
			"metadata.first",
			"metadata.first",
		]);
		expect((await list_deltas(t)).map((delta) => delta.fieldPath)).toEqual([
			"metadata.second",
			"metadata.second",
			"metadata.second",
		]);
		// The saver did not touch the marker, and the run kept it for the young delta.
		expect(await t.run(async (ctx) => await ctx.db.get("files_metadata_catalog_compactors", marker!._id))).toEqual(
			marker,
		);
		const scheduled = await t.run(async (ctx) =>
			(await ctx.db.system.query("_scheduled_functions").collect()).filter(
				(job) => job.name.includes("compact_metadata_catalog") && job.state.kind === "pending",
			),
		);
		// The saver's run and the next run, both for the same marker. The next run waits just past the
		// young delta's cutoff.
		expect(scheduled.map((job) => job.args)).toEqual([[{ markerId: marker!._id }], [{ markerId: marker!._id }]]);
		const young = (await list_deltas(t))[0]!;
		expect(Math.max(...scheduled.map((job) => job.scheduledTime)) - young._creationTime).toBeCloseTo(5001, 0);
		// The scheduler runs the chain to its end: every delta applied, and the marker gone.
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(await list_rows(t)).toHaveLength(6);
		expect(await t.run(async (ctx) => await ctx.db.query("files_metadata_catalog_compactors").collect())).toEqual([]);
	});

	test("a run that applied the last delta keeps the marker for one more run", async () => {
		const { t, scope } = await seed();
		const a = await create_folder(t, scope, "/a");
		await insert_docs(t, [metadata_doc(scope, a, { fieldPath: "metadata.first" })]);
		const marker = await t.run(async (ctx) => await ctx.db.query("files_metadata_catalog_compactors").unique());
		vi.setSystemTime(Date.now() + 5001);
		await t.mutation(internal.files_pending_overlay.compact_metadata_catalog, { markerId: marker!._id });
		expect(await list_deltas(t)).toEqual([]);
		// A walk step that is still running read this marker. Deleting it now would make that step run again.
		expect(await t.run(async (ctx) => await ctx.db.get("files_metadata_catalog_compactors", marker!._id))).toEqual(
			marker,
		);
		// The next run has nothing to apply, so it ends the chain.
		vi.setSystemTime(Date.now() + 5001);
		await t.mutation(internal.files_pending_overlay.compact_metadata_catalog, { markerId: marker!._id });
		expect(await t.run(async (ctx) => await ctx.db.query("files_metadata_catalog_compactors").collect())).toEqual([]);
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
		expect(await list_deltas(t)).toHaveLength(6);
		await test_compact_metadata_catalog(t);
		expect((await list_rows(t)).map((row) => row.count)).toEqual([2, 2, 2]);
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

describe("catalog doors", () => {
	const paginationOpts = { numItems: 50, cursor: null };

	test("a prefix matches by a lowercase copy made one character at a time, also past 160 units", async () => {
		const { t, db, asOwner, scope } = await seed();
		const a = await create_folder(t, scope, "/a");
		// 160 characters; its lowercase copy has 311 UTF-16 units.
		const dotted = `metadata.${"İ".repeat(151)}`;
		await insert_docs(t, [
			metadata_doc(scope, a, { fieldPath: "metadata.ΑΣΑ" }),
			metadata_doc(scope, a, { fieldPath: dotted }),
			metadata_doc(scope, a, { fieldPath: dotted, valueKind: "boolean" }),
		]);
		await test_compact_metadata_catalog(t);
		const keys = async (prefix: string) =>
			(await asOwner.query(api.files_metadata.list_search_fields, { membershipId: db.membershipId, prefix, paginationOpts })).page.map(
				(key) => key.fieldPath,
			);
		// A whole-text lowercase ends `ΑΣ` with a final sigma, which `metadata.ασα` does not start with.
		expect(await keys("metadata.ΑΣ")).toEqual(["metadata.ΑΣΑ"]);
		expect(
			(
				await asOwner.query(api.files_metadata.list_folder_fields, {
					membershipId: db.membershipId,
					parentId: "root",
					restricted: false,
					prefix: "metadata.ΑΣ",
					paginationOpts,
				})
			).page,
		).toEqual(["metadata.ΑΣΑ"]);
		expect(await keys(dotted)).toEqual([dotted]);
		expect(await asOwner.query(api.files_metadata.get_search_field, { membershipId: db.membershipId, fieldPath: dotted })).toEqual({ valueKinds: ["boolean"] });
	});

	test("the exact key's kinds come after more than a page of case variants", async () => {
		const { t, db, asOwner, scope } = await seed();
		const a = await create_folder(t, scope, "/a");
		// 60 variants of `status` with capitals sort before the all-lowercase key.
		const variants = Array.from({ length: 63 }, (_, mask) =>
			[..."status"].map((char, index) => (((mask + 1) >> index) & 1 ? char.toUpperCase() : char)).join(""),
		).slice(0, 60);
		await insert_docs(t, [
			...variants.flatMap((name) => [
				metadata_doc(scope, a, { fieldPath: `metadata.${name}` }),
				metadata_doc(scope, a, { fieldPath: `metadata.${name}`, valueKind: "string", stringValue: "x" }),
			]),
			metadata_doc(scope, a, { fieldPath: "metadata.status" }),
			metadata_doc(scope, a, { fieldPath: "metadata.status", valueKind: "boolean" }),
		]);
		await test_compact_metadata_catalog(t);
		expect(
			await asOwner.query(api.files_metadata.get_search_field, { membershipId: db.membershipId, fieldPath: "metadata.status" }),
		).toEqual({ valueKinds: ["boolean"] });
	});

	type Who = { as: ReturnType<T["withIdentity"]>; membershipId: Id<"organizations_workspaces_users"> };
	const values = async (who: Who, fieldPath: string, folderPath?: string) =>
		(
			await who.as.query(api.files_metadata.list_search_values, {
				membershipId: who.membershipId,
				folderPath,
				fieldPath,
				prefix: "",
				paginationOpts,
			})
		).page;
	const keys = async (who: Who, prefix: string, folderPath?: string) =>
		(
			await who.as.query(api.files_metadata.list_search_fields, {
				membershipId: who.membershipId,
				folderPath,
				prefix,
				paginationOpts,
			})
		).page.map((key) => key.fieldPath);
	const field = async (who: Who, fieldPath: string, folderPath?: string) =>
		await who.as.query(api.files_metadata.get_search_field, { membershipId: who.membershipId, folderPath, fieldPath });

	async function set_metadata(
		t: T,
		owner: Who & { userId: Id<"users"> },
		nodeId: Id<"files_nodes">,
		metadataYaml: string,
	) {
		await t.mutation(components.rate_limiter.lib.resetRateLimit, { name: "files_tree_write", key: owner.userId });
		expect(
			await owner.as.mutation(api.files_metadata.set_entries, {
				membershipId: owner.membershipId,
				fileNodeId: nodeId,
				metadataYaml,
			}),
		).toEqual({ _yay: null });
		await test_finish_file_index(t, nodeId);
	}

	async function share(t: T, owner: Who & { userId: Id<"users"> }, nodeId: Id<"files_nodes">, userId: Id<"users">) {
		await t.mutation(components.rate_limiter.lib.resetRateLimit, { name: "files_sharing_write", key: owner.userId });
		const granted = await owner.as.mutation(api.files_sharing.set_node_share_grant, {
			membershipId: owner.membershipId,
			nodeId,
			principal: { kind: "user", userId },
			level: "read",
		});
		expect(granted._nay).toBeUndefined();
	}

	test("a member gets no key or value of a restricted file they cannot open", async () => {
		const { t, db, asOwner, scope } = await seed();
		const ana = { as: asOwner, membershipId: db.membershipId, userId: db.userId };
		const hr = await create_folder(t, scope, "/HR");
		const review = await create_folder(t, scope, "/HR/review");
		await set_metadata(t, ana, review, "pip_status: active\n");
		expect(
			(await asOwner.mutation(api.files_sharing.restrict_node, { membershipId: db.membershipId, nodeId: hr }))._nay,
		).toBeUndefined();
		const mia = await seed_member(t, db, "mia", "member");
		await settle_catalog(t);

		const miaWho = { as: mia.asMember, membershipId: mia.membershipId };
		expect(await values(miaWho, "metadata.pip_status"), "the open area has no value of /HR").not.toContain("active");
		expect(await keys(miaWho, "metadata.pip")).toEqual([]);
		expect(await field(miaWho, "metadata.pip_status")).toBeNull();
		// Mia cannot open /HR, so its area answers like a refusal.
		expect(await values(miaWho, "metadata.pip_status", "/HR")).toEqual([]);
		// The owner reads the whole workspace, with or without a folder.
		expect(await values(ana, "metadata.pip_status")).toEqual(["active"]);
		expect(await values(ana, "metadata.pip_status", "/HR")).toEqual(["active"]);
		expect(await keys(ana, "metadata.pip")).toEqual(["metadata.pip_status"]);
		expect(await field(ana, "metadata.pip_status")).toEqual({ valueKinds: ["string"] });
	});

	test("inside a restricted folder a member gets that area's values", async () => {
		const { t, db, asOwner, scope } = await seed();
		const ana = { as: asOwner, membershipId: db.membershipId, userId: db.userId };
		await create_folder(t, scope, "/Clients");
		const acme = await create_folder(t, scope, "/Clients/Acme");
		const plan = await create_folder(t, scope, "/Clients/Acme/plan");
		const open = await create_folder(t, scope, "/Clients/open");
		await set_metadata(t, ana, plan, "status: Done\n");
		await set_metadata(t, ana, open, "status: Open\n");
		expect(
			(await asOwner.mutation(api.files_sharing.restrict_node, { membershipId: db.membershipId, nodeId: acme }))._nay,
		).toBeUndefined();
		const bob = await seed_member(t, db, "bob", "member");
		await share(t, ana, acme, bob.userId);
		await settle_catalog(t);

		const bobWho = { as: bob.asMember, membershipId: bob.membershipId };
		expect(await values(bobWho, "metadata.status", "/Clients/Acme")).toEqual(["Done"]);
		expect(await values(bobWho, "metadata.status", "/Clients/Acme/plan")).toEqual(["Done"]);
		expect(await keys(bobWho, "metadata.", "/Clients/Acme")).toEqual(["metadata.status"]);
		expect(await field(bobWho, "metadata.status", "/Clients/Acme")).toEqual({ valueKinds: ["string"] });
		// `/Clients` is in the open area: only its open child's value.
		expect(await values(bobWho, "metadata.status", "/Clients")).toEqual(["Open"]);
		expect(await values(bobWho, "metadata.status")).toEqual(["Open"]);
		// A path that is not a folder answers like a refusal.
		expect(await values(bobWho, "metadata.status", "/Clients/missing")).toEqual([]);
	});

	test("a member who cannot open the area root gets nothing there", async () => {
		const { t, db, asOwner, scope } = await seed();
		const ana = { as: asOwner, membershipId: db.membershipId, userId: db.userId };
		const design = await create_folder(t, scope, "/Design");
		await set_metadata(t, ana, design, "tone: calm\n");
		const vault = await create_folder(t, scope, "/Vault");
		const inside = await create_folder(t, scope, "/Vault/inside");
		await set_metadata(t, ana, inside, "tone: secret\n");
		expect(
			(await asOwner.mutation(api.files_sharing.restrict_node, { membershipId: db.membershipId, nodeId: vault }))._nay,
		).toBeUndefined();
		// Gus has no workspace read. Add people gives him `/Design` and `/Vault/inside`, not their areas.
		const gus = await seed_member(t, db, "gus", null);
		await share(t, ana, design, gus.userId);
		await share(t, ana, inside, gus.userId);
		await settle_catalog(t);

		const gusWho = { as: gus.asMember, membershipId: gus.membershipId };
		expect(await values(gusWho, "metadata.tone", "/Design")).toEqual([]);
		expect(await values(gusWho, "metadata.tone", "/Vault/inside")).toEqual([]);
		expect(await keys(gusWho, "metadata.", "/Vault/inside")).toEqual([]);
		expect(await field(gusWho, "metadata.tone", "/Vault/inside")).toBeNull();
		expect(await values(gusWho, "metadata.tone")).toEqual([]);
	});

	test("a member who opens a restricted folder gets nothing in a nested restricted folder they have no grant on", async () => {
		const { t, db, asOwner, scope } = await seed();
		const ana = { as: asOwner, membershipId: db.membershipId, userId: db.userId };
		const outer = await create_folder(t, scope, "/R");
		const plan = await create_folder(t, scope, "/R/plan");
		const nested = await create_folder(t, scope, "/R/N");
		const inner = await create_folder(t, scope, "/R/N/inner");
		await set_metadata(t, ana, plan, "tone: outer\n");
		await set_metadata(t, ana, inner, "tone: inner\n");
		for (const nodeId of [outer, nested])
			expect(
				(await asOwner.mutation(api.files_sharing.restrict_node, { membershipId: db.membershipId, nodeId }))._nay,
			).toBeUndefined();
		const bob = await seed_member(t, db, "bob", "member");
		await share(t, ana, outer, bob.userId);
		await settle_catalog(t);

		const bobWho = { as: bob.asMember, membershipId: bob.membershipId };
		expect(await values(bobWho, "metadata.tone", "/R")).toEqual(["outer"]);
		expect(await values(bobWho, "metadata.tone", "/R/N")).toEqual([]);
		expect(await values(bobWho, "metadata.tone", "/R/N/inner")).toEqual([]);
		expect(await values(ana, "metadata.tone", "/R/N")).toEqual(["inner", "outer"]);
	});

	test("an archived folder path gets nothing", async () => {
		const { t, db, asOwner, scope } = await seed();
		const ana = { as: asOwner, membershipId: db.membershipId, userId: db.userId };
		const open = await create_folder(t, scope, "/open");
		const old = await create_folder(t, scope, "/old");
		await set_metadata(t, ana, open, "tone: calm\n");
		const mia = await seed_member(t, db, "mia", "member");
		await settle_catalog(t);
		const miaWho = { as: mia.asMember, membershipId: mia.membershipId };
		expect(await values(miaWho, "metadata.tone", "/old")).toEqual(["calm"]);

		await t.mutation(components.rate_limiter.lib.resetRateLimit, { name: "files_tree_write", key: db.userId });
		const archived = await asOwner.mutation(api.files_nodes.archive_nodes, {
			membershipId: db.membershipId,
			nodeIds: [old],
		});
		expect(archived._nay).toBeUndefined();
		await settle_catalog(t);
		expect(await values(miaWho, "metadata.tone", "/old")).toEqual([]);
		expect(await keys(miaWho, "metadata.", "/old")).toEqual([]);
		expect(await field(miaWho, "metadata.tone", "/old")).toBeNull();
	});

	test("a grant change writes no catalog delta", async () => {
		const { t, db, asOwner, scope } = await seed();
		const ana = { as: asOwner, membershipId: db.membershipId, userId: db.userId };
		await create_folder(t, scope, "/Clients");
		const acme = await create_folder(t, scope, "/Clients/Acme");
		await set_metadata(t, ana, acme, "status: Done\n");
		expect(
			(await asOwner.mutation(api.files_sharing.restrict_node, { membershipId: db.membershipId, nodeId: acme }))._nay,
		).toBeUndefined();
		const bob = await seed_member(t, db, "bob", "member");
		await settle_catalog(t);
		expect(await list_deltas(t)).toEqual([]);

		await share(t, ana, acme, bob.userId);
		expect(await list_deltas(t)).toEqual([]);
		await t.mutation(components.rate_limiter.lib.resetRateLimit, { name: "files_sharing_write", key: db.userId });
		const removed = await asOwner.mutation(api.files_sharing.remove_node_share_grant, {
			membershipId: db.membershipId,
			nodeId: acme,
			principal: { kind: "user", userId: bob.userId },
		});
		expect(removed._nay).toBeUndefined();
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(await list_deltas(t)).toEqual([]);
	});
});

describe("catalog rebuild and check", () => {
	/**
	 * Saved docs over two folders. File `a` has more docs than a seed page, with its key's field doc
	 * after its value docs, so its key spans two seed pages.
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
		expect(expected.filter((row) => !row.family.endsWith("value"))).toEqual([
			{
				family: "area_key",
				fieldPath: "metadata.status",
				parentId: "root",
				count: 2,
				kindCounts: { string: 2, number: 1, boolean: 1, maybe_date: 0 },
			},
			{
				family: "area_key",
				fieldPath: "metadata.tags",
				parentId: "root",
				count: 1,
				kindCounts: { ...NO_KINDS, string: 130 },
			},
			{ family: "key", fieldPath: "metadata.status", count: 2, kindCounts: { string: 2, number: 1, boolean: 1, maybe_date: 0 } },
			{ family: "key", fieldPath: "metadata.tags", count: 1, kindCounts: { ...NO_KINDS, string: 130 } },
			{ family: "parent", fieldPath: "metadata.status", parentId: a, count: 1 },
			{ family: "parent", fieldPath: "metadata.status", parentId: "root", count: 1 },
			{ family: "parent", fieldPath: "metadata.tags", parentId: "root", count: 1 },
		]);
		// More rows than one clear job deletes.
		expect(expected).toHaveLength(269);

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
		// Three clear jobs, then two seed pages. A seeding marker stays while no delta waits. The last page
		// sets it to draining, and the run after it applied deltas, so the marker stays for one more run.
		expect(jobs).toBe(5);
		expect(phases).toEqual(["clearing", "clearing", "seeding", "seeding", "draining"]);
		expect(await list_rows(t)).toEqual(expected);
		expect(errors.mock.calls.filter(([message]) => message === "files_metadata_catalog drift")).toEqual([]);

		await rebuild(t, scope, "catalog");
		expect(await list_rows(t)).toEqual(expected);
	});

	test("a rebuild counts a file whose docs span pages ended by bytes", async () => {
		const { t, scope } = await seed();
		const a = await create_folder(t, scope, "/a");
		// Four 400 KB values: a 1 MiB page read ends after the second value, far below 100 docs.
		await insert_docs(t, [
			metadata_doc(scope, a, { fieldPath: "metadata.big" }),
			...Array.from({ length: 4 }, (_, index) =>
				metadata_doc(scope, a, { fieldPath: "metadata.big", valueKind: "string", stringValue: `${index}${"x".repeat(400_000)}` }),
			),
		]);
		await test_compact_metadata_catalog(t);
		const expected = await list_rows(t);
		expect(expected).toEqual([
			{
				family: "area_key",
				fieldPath: "metadata.big",
				parentId: "root",
				count: 1,
				kindCounts: { ...NO_KINDS, string: 4 },
			},
			{ family: "key", fieldPath: "metadata.big", count: 1, kindCounts: { ...NO_KINDS, string: 4 } },
			{ family: "parent", fieldPath: "metadata.big", parentId: "root", count: 1 },
		]);
		// One clear job, then two seed pages.
		expect(await rebuild(t, scope, "catalog")).toBe(3);
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

	test("a restrict and an unrestrict move a child's keys between parent and parent_restricted, and the check stays clean", async () => {
		const { t, db, asOwner, scope } = await seed();
		const src = await create_folder(t, scope, "/src");
		const a = await create_folder(t, scope, "/src/a");
		await t.mutation(components.rate_limiter.lib.resetRateLimit, { name: "files_tree_write", key: db.userId });
		expect(
			await asOwner.mutation(api.files_metadata.set_entries, { membershipId: db.membershipId, fileNodeId: a, metadataYaml: "status: open\n" }),
		).toEqual({ _yay: null });
		const parentRows = async () => {
			await test_finish_file_index(t, a);
			await test_compact_metadata_catalog(t);
			return (await list_rows(t)).filter((row) => row.family.startsWith("parent")).map((row) => `${row.family}:${row.parentId}:${row.count}`);
		};
		expect(await parentRows()).toEqual([`parent:${src}:1`]);

		expect((await asOwner.mutation(api.files_sharing.restrict_node, { membershipId: db.membershipId, nodeId: a }))._nay).toBeUndefined();
		expect(await parentRows()).toEqual([`parent_restricted:${src}:1`]);
		await rebuild(t, scope, "check");
		expect(await check(t, scope)).toEqual([]);
		await rebuild(t, scope, "clear_check");

		expect((await asOwner.mutation(api.files_sharing.unrestrict_node, { membershipId: db.membershipId, nodeId: a }))._nay).toBeUndefined();
		expect(await parentRows()).toEqual([`parent:${src}:1`]);
		await rebuild(t, scope, "check");
		expect(await check(t, scope)).toEqual([]);
	});

	test("restrict moves a subtree's values out of the open area after the scope jobs, and unrestrict brings them back", async () => {
		const { t, db, asOwner, scope } = await seed();
		const team = await create_folder(t, scope, "/Team");
		const plan = await create_folder(t, scope, "/Team/plan");
		await t.mutation(components.rate_limiter.lib.resetRateLimit, { name: "files_tree_write", key: db.userId });
		expect(
			await asOwner.mutation(api.files_metadata.set_entries, {
				membershipId: db.membershipId,
				fileNodeId: plan,
				metadataYaml: "level: secret\n",
			}),
		).toEqual({ _yay: null });
		// Each area's string values, after the scope op, the saved scope jobs and the compactor.
		const areaValues = async () => {
			await t.finishAllScheduledFunctions(vi.runAllTimers);
			await test_finish_saved_scope_jobs(t);
			await test_compact_metadata_catalog(t);
			return (await list_rows(t))
				.filter((row) => row.family === "area_value")
				.map((row) => `${row.parentId}:${row.stringValue}`);
		};
		expect(await areaValues()).toEqual(["root:secret"]);
		// Mia reads the whole workspace except restricted folders. She asks at the root.
		const mia = await seed_member(t, db, "mia", "member");
		const miaValues = async () =>
			(
				await mia.asMember.query(api.files_metadata.list_search_values, {
					membershipId: mia.membershipId,
					fieldPath: "metadata.level",
					prefix: "",
					paginationOpts: { numItems: 50, cursor: null },
				})
			).page;
		expect(await miaValues()).toEqual(["secret"]);

		expect(
			(await asOwner.mutation(api.files_sharing.restrict_node, { membershipId: db.membershipId, nodeId: team }))._nay,
		).toBeUndefined();
		const restricted = await areaValues();
		expect(await miaValues()).not.toContain("secret");
		expect(restricted, "the open area no longer has the value").not.toContain("root:secret");
		expect(restricted, "the restricted area has it").toEqual([`${team}:secret`]);
		await rebuild(t, scope, "check");
		expect(await check(t, scope)).toEqual([]);
		await rebuild(t, scope, "clear_check");

		await t.mutation(components.rate_limiter.lib.resetRateLimit, { name: "files_tree_write", key: db.userId });
		expect(
			(await asOwner.mutation(api.files_sharing.unrestrict_node, { membershipId: db.membershipId, nodeId: team }))._nay,
		).toBeUndefined();
		expect(await areaValues()).toEqual(["root:secret"]);
		expect(await miaValues()).toEqual(["secret"]);
		await rebuild(t, scope, "check");
		expect(await check(t, scope)).toEqual([]);
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
				await expect(start_rebuild(t, scope, "catalog")).rejects.toThrow("Files are being indexed or moved");
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

	async function yield_move_admission() {
		const overlay = await import("../server/files-pending-overlay.ts");
		const canJoin = overlay.files_pending_overlay_db_can_join_step;
		const admission = { yielded: false };
		// Yield once during setup. Later steps use the real guard and worker.
		const pause = vi.spyOn(overlay, "files_pending_overlay_db_can_join_step").mockImplementation(async (ctx, limitFactor) => {
			const allowed = await canJoin(ctx, limitFactor);
			if (limitFactor !== 4) return allowed;
			admission.yielded = true;
			pause.mockRestore();
			return false;
		});
		return admission;
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
		await test_finish_file_index(t, nodeId);
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

	/**
	 * What the browser shows the owner: each suggestion door read on the normal stream and on the
	 * visible Move view's stream, with the restricted twin of `list_folder_fields`, joined like
	 * `useFilesMetadataCatalogPages` joins them. Call after a compaction.
	 */
	async function door_rows(
		asOwner: ReturnType<T["withIdentity"]>,
		membershipId: Id<"organizations_workspaces_users">,
		parentIds: Id<"files_nodes">[],
	) {
		const view = await asOwner.query(api.files_tree.get_workspace_move_view, { membershipId });
		if (!view) throw new Error("no move view");
		const streams = [
			{ kind: "normal" as const, generation: view.generation },
			...(view.cohortId && view.view
				? [{ kind: "cohort" as const, cohortId: view.cohortId, view: view.view, generation: view.generation }]
				: []),
		];
		const paginationOpts = { numItems: 50, cursor: null };
		const rows = new Set<string>();
		for (const savedStream of streams) {
			const keys = await asOwner.query(api.files_metadata.list_search_fields, { membershipId, savedStream, prefix: "metadata.", paginationOpts });
			for (const key of keys.page) rows.add(`key:${key.fieldPath}:${key.valueKinds.join()}`);
			const values = await asOwner.query(api.files_metadata.list_search_values, { membershipId, savedStream, fieldPath: "metadata.status", prefix: "", paginationOpts });
			for (const value of values.page) rows.add(`value:${value}`);
			for (const parentId of parentIds)
				for (const restricted of [false, true]) {
					const fields = await asOwner.query(api.files_metadata.list_folder_fields, { membershipId, savedStream, parentId, restricted, prefix: "", paginationOpts });
					for (const fieldPath of fields.page) rows.add(`${restricted ? "parent_restricted" : "parent"}:${parentId}:${fieldPath}`);
				}
		}
		const field = await asOwner.query(api.files_metadata.get_search_field, { membershipId, fieldPath: "metadata.status" });
		rows.add(`field:${field?.valueKinds.join()}`);
		return [...rows].sort();
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
			"area_key:root:metadata.status:=2",
			"area_value:root:metadata.status:open=2",
			"key::metadata.status:=2",
			`parent:${src}:metadata.status:=2`,
			"value::metadata.status:open=2",
		]);
		const after = [
			"area_key:root:metadata.status:=2",
			"area_value:root:metadata.status:open=2",
			"key::metadata.status:=2",
			`parent:${dst}:metadata.status:=1`,
			`parent:${src}:metadata.status:=1`,
			"value::metadata.status:open=2",
		].sort();
		// The doors through both streams: a key, its kinds and its value never vanish while the Move runs.
		const doorsBefore = await door_rows(asOwner, db.membershipId, [src, dst]);
		expect(doorsBefore).toEqual(
			["field:string", "key:metadata.status:string", `parent:${src}:metadata.status`, "value:open"].sort(),
		);
		const doorsAfter = [...doorsBefore, `parent:${dst}:metadata.status`].sort();

		const seen = new Set<string>();
		let checkedBefore = false;
		const admission = await yield_move_admission();
		await reset_tree_write_limit(t, db.userId);
		const moved = await test_move_nodes(t, asOwner, {
			membershipId: db.membershipId,
			itemIds: [a],
			targetParentId: dst,
			onStep: async () => {
				if (admission.yielded && !checkedBefore) {
					const cohort = await t.run(async (ctx) => await ctx.db.query("files_move_cohorts").first());
					expect(cohort, "catalog checks start before publication").toMatchObject({ publishedAt: null, visibleView: "before" });
					checkedBefore = true;
				}
				const rows = await visible_rows(t, scope);
				seen.add(JSON.stringify(rows));
				expect([JSON.stringify(before), JSON.stringify(after)]).toContain(JSON.stringify(rows));
				const doors = await door_rows(asOwner, db.membershipId, [src, dst]);
				expect([JSON.stringify(doorsBefore), JSON.stringify(doorsAfter)]).toContain(JSON.stringify(doors));
			},
		});
		expect(moved._nay).toBeUndefined();
		expect(admission.yielded, "setup yields the initial Move join").toBe(true);
		expect(checkedBefore).toBe(true);
		expect(await visible_rows(t, scope)).toEqual(after);
		expect(await door_rows(asOwner, db.membershipId, [src, dst])).toEqual(doorsAfter);
		// No tagged row is left behind.
		expect((await t.run(async (ctx) => await ctx.db.query("files_metadata_catalog").collect())).filter((row) => row.moveView)).toEqual([]);
		expect(seen.size).toBe(2);
	});

	test("a Move of the only file with the key keeps it in the doors through the view stream, and an after-only key waits for publication", async () => {
		const { t, db, asOwner, scope } = await seed();
		const src = await create_folder(t, scope, "/src");
		const a = await create_folder(t, scope, "/src/a");
		const dst = await create_folder(t, scope, "/dst");
		const other = await create_folder(t, scope, "/other");
		await set_status(t, db, a);
		await visible_rows(t, scope);
		const common = ["field:string", "key:metadata.status:string", "value:open"];
		const doorsBefore = [...common, `parent:${src}:metadata.status`].sort();
		const doorsAfter = [...common, `parent:${dst}:metadata.status`, "key:metadata.draft:"].sort();
		expect(await door_rows(asOwner, db.membershipId, [src, dst])).toEqual(doorsBefore);

		// Count the steps where the key has only Move-tagged rows, so only the view stream shows it.
		let viewOnlySteps = 0;
		// A key only the after view has, like an Accept that adds one. A file under the Move refuses
		// writes, so it sits on another file. It shows from publication on; cleanup then untags it.
		let draftAdded = false;
		let published = false;
		const admission = await yield_move_admission();
		await reset_tree_write_limit(t, db.userId);
		const moved = await test_move_nodes(t, asOwner, {
			membershipId: db.membershipId,
			itemIds: [a],
			targetParentId: dst,
			onStep: async () => {
				const view = await asOwner.query(api.files_tree.get_workspace_move_view, { membershipId: db.membershipId });
				if (view?.cohortId && view.view === "before" && !draftAdded) {
					expect(admission.yielded, "setup yields the initial Move join").toBe(true);
					const cohort = await t.run(async (ctx) => await ctx.db.get("files_move_cohorts", view.cohortId!));
					expect(cohort, "the after-only key is staged before publication").toMatchObject({ publishedAt: null, visibleView: "before" });
					await test_run_with_flush(t, async (ctx) => {
						await ctx.db.insert("files_metadata_docs", {
							...metadata_doc(scope, other, { fieldPath: "metadata.draft" }),
							moveView: { cohortId: view.cohortId!, view: "after" },
						});
					});
					draftAdded = true;
				}
				published ||= view?.view === "after";
				await visible_rows(t, scope);
				const keyRows = await t.run(async (ctx) =>
					(await ctx.db.query("files_metadata_catalog").collect()).filter((row) => row.family === "key" && row.fieldPath === "metadata.status"),
				);
				if (keyRows.length > 0 && keyRows.every((row) => row.moveView)) viewOnlySteps++;
				expect(await door_rows(asOwner, db.membershipId, [src, dst])).toEqual(published ? doorsAfter : doorsBefore);
			},
		});
		expect(moved._nay).toBeUndefined();
		expect(draftAdded && published).toBe(true);
		expect(viewOnlySteps).toBeGreaterThan(0);
		await visible_rows(t, scope);
		expect(await door_rows(asOwner, db.membershipId, [src, dst])).toEqual(doorsAfter);
	});

	test("a Move of a restricted folder moves its parent_restricted rows, and the owner sees its key at every step", async () => {
		const { t, db, asOwner, scope } = await seed();
		const src = await create_folder(t, scope, "/src");
		const a = await create_folder(t, scope, "/src/a");
		const dst = await create_folder(t, scope, "/dst");
		await set_status(t, db, a);
		expect((await asOwner.mutation(api.files_sharing.restrict_node, { membershipId: db.membershipId, nodeId: a }))._nay).toBeUndefined();
		// The area rows stay: the folder is its own area.
		const rows = (parentId: Id<"files_nodes">) => [
			`area_key:${a}:metadata.status:=1`,
			`area_value:${a}:metadata.status:open=1`,
			"key::metadata.status:=1",
			`parent_restricted:${parentId}:metadata.status:=1`,
			"value::metadata.status:open=1",
		];
		expect(await visible_rows(t, scope)).toEqual(rows(src));
		const doors = (parentId: Id<"files_nodes">) =>
			["field:string", "key:metadata.status:string", `parent_restricted:${parentId}:metadata.status`, "value:open"].sort();
		expect(await door_rows(asOwner, db.membershipId, [src, dst])).toEqual(doors(src));

		await reset_tree_write_limit(t, db.userId);
		const moved = await test_move_nodes(t, asOwner, {
			membershipId: db.membershipId,
			itemIds: [a],
			targetParentId: dst,
			onStep: async () => {
				await visible_rows(t, scope);
				expect([JSON.stringify(doors(src)), JSON.stringify(doors(dst))]).toContain(
					JSON.stringify(await door_rows(asOwner, db.membershipId, [src, dst])),
				);
			},
		});
		expect(moved._nay).toBeUndefined();
		expect(await visible_rows(t, scope)).toEqual(rows(dst));
		expect(await door_rows(asOwner, db.membershipId, [src, dst])).toEqual(doors(dst));
	});

	test("a Move into a restricted folder moves the values to that area in the after view and keeps them for the owner at every step", async () => {
		const { t, db, asOwner, scope } = await seed();
		const src = await create_folder(t, scope, "/src");
		const a = await create_folder(t, scope, "/src/a");
		const dst = await create_folder(t, scope, "/dst");
		await set_status(t, db, a);
		expect(
			(await asOwner.mutation(api.files_sharing.restrict_node, { membershipId: db.membershipId, nodeId: dst }))._nay,
		).toBeUndefined();
		const rows = (area: Id<"files_nodes"> | "root", parentId: Id<"files_nodes">) =>
			[
				`area_key:${area}:metadata.status:=1`,
				`area_value:${area}:metadata.status:open=1`,
				"key::metadata.status:=1",
				`parent:${parentId}:metadata.status:=1`,
				"value::metadata.status:open=1",
			].sort();
		expect(await visible_rows(t, scope)).toEqual(rows("root", src));
		const doors = (parentId: Id<"files_nodes">) =>
			["field:string", "key:metadata.status:string", `parent:${parentId}:metadata.status`, "value:open"].sort();
		expect(await door_rows(asOwner, db.membershipId, [src, dst])).toEqual(doors(src));

		await reset_tree_write_limit(t, db.userId);
		const moved = await test_move_nodes(t, asOwner, {
			membershipId: db.membershipId,
			itemIds: [a],
			targetParentId: dst,
			onStep: async () => {
				const visible = await visible_rows(t, scope);
				expect([JSON.stringify(rows("root", src)), JSON.stringify(rows(dst, dst))]).toContain(JSON.stringify(visible));
				expect([JSON.stringify(doors(src)), JSON.stringify(doors(dst))]).toContain(
					JSON.stringify(await door_rows(asOwner, db.membershipId, [src, dst])),
				);
			},
		});
		expect(moved._nay).toBeUndefined();
		expect(await visible_rows(t, scope)).toEqual(rows(dst, dst));
		expect(await door_rows(asOwner, db.membershipId, [src, dst])).toEqual(doors(dst));
	});

	test("a folder copy counts the copied folder metadata under its new parent", async () => {
		const { t, db, asOwner, scope } = await seed();
		const src = await create_folder(t, scope, "/src");
		const a = await create_folder(t, scope, "/src/a");
		const dst = await create_folder(t, scope, "/dst");
		await set_status(t, db, a);
		await reset_tree_write_limit(t, db.userId);
		const started = await asOwner.mutation(api.files_transfer.accept_input, {
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
		const indexes = await t.run((ctx) => ctx.db.query("files_index_states").collect());
		for (const index of indexes) await test_finish_file_index(t, index.fileNodeId);
		expect(await visible_rows(t, scope)).toEqual(
			[
				"area_key:root:metadata.status:=2",
				"area_value:root:metadata.status:open=2",
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
		const admission = await yield_move_admission();
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
				expect(admission.yielded, "setup yields the initial Move join").toBe(true);
				const cohort = await t.run(async (ctx) => {
					const cohortId = ctx.db.normalizeId("files_move_cohorts", tagged[0]!.moveView!.cohortId)!;
					return await ctx.db.get("files_move_cohorts", cohortId);
				});
				expect(cohort, "Stop runs after staging and before publication").toMatchObject({ publishedAt: null, visibleView: "before" });
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

	test("restoring a file out of an archived folder moves its parent row", async () => {
		const { t, db, asOwner, scope } = await seed();
		const folder = await create_folder(t, scope, "/a");
		const file = await create_folder(t, scope, "/a/f");
		await set_status(t, db, file);
		for (const nodeId of [file, folder]) {
			await reset_tree_write_limit(t, db.userId);
			expect((await asOwner.mutation(api.files_nodes.archive_nodes, { membershipId: db.membershipId, nodeIds: [String(nodeId)] }))._nay).toBeUndefined();
		}
		await test_finish_saved_scope_jobs(t);
		await test_compact_metadata_catalog(t);
		expect(await list_rows(t)).toEqual([]);

		await reset_tree_write_limit(t, db.userId);
		expect((await asOwner.mutation(api.files_nodes.unarchive_nodes, { membershipId: db.membershipId, nodeIds: [String(file)] }))._nay).toBeUndefined();
		const restored = await t.run(async (ctx) => await ctx.db.get("files_nodes", file));
		expect(restored?.parentId).not.toBe(folder);
		await test_finish_saved_scope_jobs(t);
		await test_compact_metadata_catalog(t);
		expect((await list_rows(t)).filter((row) => row.family === "parent")).toEqual([
			{ family: "parent", fieldPath: "metadata.status", parentId: restored!.parentId, count: 1 },
		]);
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
			await test_finish_file_index(t, nodeId);
		}
		await test_compact_metadata_catalog(t);
		expect(await list_rows(t)).toEqual([
			{
				family: "area_key",
				fieldPath: "metadata.status",
				parentId: "root",
				count: 6,
				kindCounts: { ...NO_KINDS, string: 6 },
			},
			{ family: "area_value", fieldPath: "metadata.status", parentId: "root", stringValue: "open", count: 6 },
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
		await test_finish_archive_jobs(t);
		await test_finish_saved_scope_jobs(t);
		const keyDeltas = (await list_deltas(t)).filter((delta) => delta.family === "key");
		expect(keyDeltas.reduce((sum, delta) => sum + delta.count, 0)).toBe(-5);
		await test_compact_metadata_catalog(t);
		expect(await list_rows(t)).toEqual([
			{
				family: "area_key",
				fieldPath: "metadata.status",
				parentId: "root",
				count: 1,
				kindCounts: { ...NO_KINDS, string: 1 },
			},
			{ family: "area_value", fieldPath: "metadata.status", parentId: "root", stringValue: "open", count: 1 },
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
		await test_finish_saved_scope_jobs(t);
		await test_compact_metadata_catalog(t);
		expect((await list_rows(t)).map((row) => row.count)).toEqual([6, 6, 6, 5, 1, 6]);
	});
});

describe("compactor drift", () => {
	test("a Move that splits a key over two pages logs no drift", async () => {
		const { t, db, asOwner, scope } = await seed();
		const errors = vi.spyOn(console, "error");
		const a = await create_folder(t, scope, "/a");
		const dst = await create_folder(t, scope, "/dst");
		// The date has three docs. The next 30 keys have two each, so d's field is doc 64.
		// Its value falls on the next Move page.
		await t.mutation(components.rate_limiter.lib.resetRateLimit, { name: "files_tree_write", key: db.userId });
		const written = await asOwner.mutation(api.files_metadata.set_entries, {
			membershipId: db.membershipId,
			fileNodeId: a,
			metadataYaml: [
				'a: "2026-01-01"',
				"b: x",
				"c: y",
				...Array.from({ length: 28 }, (_, index) => `c${String(index).padStart(2, "0")}: value`),
				"d: z",
				"",
			].join("\n"),
		});
		expect(written).toEqual({ _yay: null });
		await test_finish_file_index(t, a);
		await test_compact_metadata_catalog(t);
		const before = await list_rows(t);

		let splitSteps = 0;
		await t.mutation(components.rate_limiter.lib.resetRateLimit, { name: "files_tree_write", key: db.userId });
		const moved = await test_move_nodes(t, asOwner, {
			membershipId: db.membershipId,
			itemIds: [a],
			targetParentId: dst,
			onStep: async () => {
				// Run the compactor between every two steps, then put the clock back for the Move leases.
				const now = Date.now();
				await test_compact_metadata_catalog(t);
				vi.setSystemTime(now);
				const rows = await list_rows(t);
				if (rows.some((row) => row.family === "key" && row.count === 0)) splitSteps++;
			},
		});
		expect(moved._nay).toBeUndefined();
		expect(errors.mock.calls.filter(([message]) => message === "files_metadata_catalog drift")).toEqual([]);
		// The compactor did see a key row with value docs but no field doc.
		expect(splitSteps).toBeGreaterThan(0);
		await test_compact_metadata_catalog(t);
		expect(await list_rows(t)).toEqual(before.map((row) => (row.family === "parent" ? { ...row, parentId: dst } : row)));
	});

	test("a key whose value doc is saved first keeps its kinds, and a remove with no add still logs", async () => {
		const { t, scope } = await seed();
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const a = await create_folder(t, scope, "/a");
		// Two transactions with a compactor run between them, the value doc first.
		await insert_docs(t, [metadata_doc(scope, a, { fieldPath: "metadata.status", valueKind: "string", stringValue: "open" })]);
		await test_compact_metadata_catalog(t);
		await insert_docs(t, [metadata_doc(scope, a, { fieldPath: "metadata.status" })]);
		await test_compact_metadata_catalog(t);
		expect(errors.mock.calls.filter(([message]) => message === "files_metadata_catalog drift")).toEqual([]);
		expect(await list_rows(t)).toEqual([
			{
				family: "area_key",
				fieldPath: "metadata.status",
				parentId: "root",
				count: 1,
				kindCounts: { ...NO_KINDS, string: 1 },
			},
			{ family: "area_value", fieldPath: "metadata.status", parentId: "root", stringValue: "open", count: 1 },
			{ family: "key", fieldPath: "metadata.status", count: 1, kindCounts: { ...NO_KINDS, string: 1 } },
			{ family: "parent", fieldPath: "metadata.status", parentId: "root", count: 1 },
			{ family: "value", fieldPath: "metadata.status", stringValue: "open", count: 1 },
		]);

		// A value doc written past the overlay has no add, so removing it is real drift.
		await t.run(async (ctx) => {
			await ctx.db.insert("files_metadata_docs", metadata_doc(scope, a, { fieldPath: "metadata.status", valueKind: "string", stringValue: "open" }));
		});
		await test_run_with_flush(t, async (ctx) => {
			for (const doc of await ctx.db.query("files_metadata_docs").collect())
				if (doc.docKind === "value") await ctx.db.delete("files_metadata_docs", doc._id);
		});
		await test_compact_metadata_catalog(t);
		expect(errors.mock.calls.filter(([message]) => message === "files_metadata_catalog drift")).toEqual([
			["files_metadata_catalog drift", expect.objectContaining({ fieldPath: "metadata.status", driftRows: 4 })],
		]);
		expect(await list_rows(t)).toEqual([
			{ family: "area_key", fieldPath: "metadata.status", parentId: "root", count: 1, kindCounts: NO_KINDS },
			{ family: "key", fieldPath: "metadata.status", count: 1, kindCounts: NO_KINDS },
			{ family: "parent", fieldPath: "metadata.status", parentId: "root", count: 1 },
		]);
	});
});
