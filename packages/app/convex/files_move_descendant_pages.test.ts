import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { run_to_end as finish_archive } from "./files_archive_runs.setup.test.ts";
import { advance } from "./files_move_cohorts.ts";
import { budget_recorder, transaction_cost } from "./files_pending_overlay_limits.setup.test.ts";
import {
	test_convex,
	test_finish_transfer_run,
	test_LIMITS_AT_75_PERCENT,
	test_mocks_fill_db_with,
	test_spy_handler,
} from "./setup.test.ts";
import { files_ancestor_ids } from "../shared/files.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

function track_pages<T extends object>(
	query: T,
	table: string,
	pages: { count: number; children: Id<"files_nodes">[][]; bytes: number[] },
	childIds: Set<Id<"files_nodes">>,
): T {
	return new Proxy(query, {
		get(target, key) {
			const member: unknown = Reflect.get(target, key);
			if (typeof member !== "function") return member;
			return (...args: unknown[]) => {
				const result: unknown = Reflect.apply(member, target, args);
				if (key === "paginate") {
					pages.count++;
					return Promise.resolve(result).then((value) => {
						if (table === "files_nodes") {
							const page = value as { page: Doc<"files_nodes">[] };
							const ids = page.page.map((doc) => doc._id).filter((id) => childIds.has(id));
							if (ids.length) {
								pages.children.push(ids);
								pages.bytes.push(new TextEncoder().encode(JSON.stringify(page.page)).byteLength);
							}
						}
						return value;
					});
				}
				return ["withIndex", "order", "filter", "fullTableScan"].includes(String(key)) &&
					result &&
					typeof result === "object"
					? track_pages(result, table, pages, childIds)
					: result;
			};
		},
	});
}

test.each([
	{ title: "reserves fifty physical children in two native pages", count: 50, unicode: false },
	{
		title: "reserves archived Unicode children through byte-bounded pages with sixteen draft owners",
		count: 78,
		unicode: true,
	},
])(
	"$title",
	async (scenario) => {
		const t = test_convex({ transactionLimits: test_LIMITS_AT_75_PERCENT });
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const folder = async (parentId: Id<"files_nodes"> | "root", path: string) => {
			const created = await asUser.mutation(api.files_nodes.create_folder_node, {
				membershipId: db.membershipId,
				parentId,
				path,
			});
			if (created._nay) throw new Error(created._nay.message);
			return created._yay.nodeId;
		};
		const sourcePath = scenario.unicode
			? `/${"甲".repeat(255)}/${"乙".repeat(255)}/${"丙".repeat(251)}/src`
			: `/${"a".repeat(255)}/${"b".repeat(255)}/${"c".repeat(251)}/src`;
		const sourceId = await folder("root", sourcePath);
		const targetId = await folder("root", "/target");
		const children: { id: Id<"files_nodes">; name: string }[] = [];
		for (let index = 0; index < scenario.count; index++) {
			if (index % 10 === 0) vi.setSystemTime(Date.now() + 60_000);
			const name = `${String(index).padStart(3, "0")}${(scenario.unicode ? "文" : "x").repeat(252)}`;
			children.push({ id: await folder(sourceId, name), name });
		}
		const drafts: { id: Id<"files_pending_updates">; userId: Id<"users"> }[] = [];
		let draftParentId: Id<"files_nodes"> | null = null;
		let archiveOperationId: string | null = null;
		if (scenario.unicode) {
			vi.setSystemTime(Date.now() + 60_000);
			const archived = await asUser.mutation(api.files_nodes.archive_nodes, {
				membershipId: db.membershipId,
				nodeIds: children.map((child) => child.id),
			});
			if (archived._nay) throw new Error(archived._nay.message);
			if (!archived._yay) throw new Error("Expected the public Archive job");
			expect((await finish_archive({ t, db, asOwner: asUser }, archived._yay)).activity.status).toBe("succeeded");
			archiveOperationId = (await t.run((ctx) => ctx.db.get("files_nodes", children[0]!.id)))!.archiveOperationId;
			expect(archiveOperationId).not.toBeNull();
			draftParentId = await folder("root", "/drafts");
			for (let index = 0; index < 16; index++) {
				vi.setSystemTime(Date.now() + 10_000);
				const userId = await t.run((ctx) => ctx.db.insert("users", { clerkUserId: `descendant-owner-${index}` }));
				expect(
					await asUser.mutation(api.organizations.invite_user_to_organization_workspace, {
						organizationId: db.organizationId,
						workspaceId: db.workspaceId,
						userIdToAdd: userId,
					}),
				).toEqual({ _yay: null });
				const moved = await t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					userId,
					target: { kind: "saved", id: sourceId },
					destParent: { kind: "saved", id: draftParentId },
					destName: "src",
				});
				if (moved._nay) throw new Error(moved._nay.message);
				const draft = await t.run((ctx) =>
					ctx.db
						.query("files_pending_updates")
						.withIndex("by_user_target", (q) =>
							q.eq("userId", userId).eq("target.kind", "saved").eq("target.id", sourceId),
						)
						.unique(),
				);
				if (!draft) throw new Error("Expected an owner's pending Move");
				drafts.push({ id: draft._id, userId });
			}
		}
		const childIds = new Set(children.map((child) => child.id));
		const pages: Id<"files_nodes">[][] = [];
		const held: Id<"files_nodes">[][] = [];
		const sourceHeld: boolean[] = [];
		const pageCounts: number[] = [];
		const pageBytes: number[] = [];
		const costs: { phase: string; cost: ReturnType<typeof transaction_cost> }[] = [];
		const { peaks, record, check } = budget_recorder();
		test_spy_handler(advance, async (handler, ctx, args) => {
			const { cohortId } = args as { cohortId: Id<"files_move_cohorts"> };
			const cohort = await ctx.db.get("files_move_cohorts", cohortId);
			const before = await ctx.meta.getTransactionMetrics();
			const transactionPages = { count: 0, children: [] as Id<"files_nodes">[][], bytes: [] as number[] };
			const trackedDb = new Proxy(ctx.db, {
				get(target, key) {
					const member: unknown = Reflect.get(target, key);
					if (typeof member !== "function") return member;
					if (key === "query")
						return (...queryArgs: unknown[]) =>
							track_pages(Reflect.apply(member, target, queryArgs), String(queryArgs[0]), transactionPages, childIds);
					return member.bind(target);
				},
			});
			const result = await handler({ ...ctx, db: trackedDb }, args);
			const cost = transaction_cost(before, await ctx.meta.getTransactionMetrics());
			costs.push({ phase: `cohort/${cohort?.workPhase}`, cost });
			pageCounts.push(transactionPages.count);
			pageBytes.push(...transactionPages.bytes);
			for (const ids of transactionPages.children) {
				pages.push(ids);
				const docs = await Promise.all(ids.map((id) => ctx.db.get("files_nodes", id)));
				held.push(docs.flatMap((doc) => (doc?.moveCohortId === cohortId ? [doc._id] : [])));
				sourceHeld.push((await ctx.db.get("files_nodes", sourceId))?.moveCohortId === cohortId);
			}
			return result;
		});
		const started = await asUser.mutation(api.files_transfer.start, {
			membershipId: db.membershipId,
			requestId: "descendant-pages",
			kind: "move",
			expectedSourceCount: 1,
			sourceIds: [sourceId],
			targetParentId: targetId,
		});
		if (started._nay) throw new Error(started._nay.message);
		expect(
			await asUser.mutation(api.files_transfer.seal, { membershipId: db.membershipId, runId: started._yay.runId }),
		).toEqual({ _yay: null });
		await test_finish_transfer_run(asUser, started._yay.runId);
		expect(
			(await asUser.query(api.files_transfer.get, { membershipId: db.membershipId, runId: started._yay.runId }))
				?.activity.status,
		).toBe("succeeded");
		const source = await t.run((ctx) => ctx.db.get("files_nodes", sourceId));
		expect(source).toMatchObject({ parentId: targetId, path: "/target/src" });
		expect(source?.moveCohortId).toBeUndefined();
		expect(files_ancestor_ids(source!)).toEqual([targetId]);
		for (const child of children) {
			const doc = await t.run((ctx) => ctx.db.get("files_nodes", child.id));
			expect(doc?.parentId).toBe(sourceId);
			expect(doc?.path).toBe(`/target/src/${child.name}`);
			expect(doc?.moveCohortId).toBeUndefined();
			expect(files_ancestor_ids(doc!)).toEqual([targetId, sourceId]);
			expect(doc?.archiveOperationId).toBe(archiveOperationId);
		}
		for (const draft of drafts)
			expect(await t.run((ctx) => ctx.db.get("files_pending_updates", draft.id))).toMatchObject({
				userId: draft.userId,
				target: { kind: "saved", id: sourceId },
				pendingMove: { destParent: { kind: "saved", id: draftParentId }, destName: "src" },
			});
		expect(pages.flat().sort(), "every physical child is collected once").toEqual([...childIds].sort());
		expect(held, "each native page reserves every returned child before it yields").toEqual(pages);
		expect(sourceHeld.every(Boolean), "the source stays held through child collection").toBe(true);
		expect(
			pageCounts.every((count) => count <= 1),
			"each transaction reads at most one native page",
		).toBe(true);
		// Check outside the worker, so it cannot turn an assertion into a retry.
		for (const entry of costs) record(entry.phase, entry.cost);
		check("descendant page batches");
		console.info(
			"descendant page batches",
			JSON.stringify({
				children: children.length,
				draftOwners: drafts.length,
				pages: pages.map((page) => page.length),
				encodedPageBytes: pageBytes,
				phases: Object.fromEntries(peaks),
			}),
		);
		if (scenario.unicode) {
			expect(
				pages.some((page) => page.length > 1),
				"a byte-bounded child page still reserves several children",
			).toBe(true);
			expect(pages.length, "large Unicode headers use more native byte pages").toBeGreaterThan(
				Math.ceil(children.length / 32),
			);
			expect(
				pages.slice(0, -1).some((page) => page.length < 32),
				"the byte bound ends a non-final native page",
			).toBe(true);
		} else {
			expect(pages, "fifty physical children use two nonempty native child pages").toHaveLength(2);
			expect(pages.map((page) => page.length)).toEqual([32, 18]);
		}
	},
	120_000,
);
