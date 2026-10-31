import { Workpool } from "@convex-dev/workpool";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { test_run_with_flush } from "./setup.test.ts";
import { insert_tree_node, seed_folder_table } from "./files_nodes.setup.test.ts";
import { files_archive_operation_id_new } from "../shared/files.ts";

beforeEach(() => {
	vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("work_file_test_billing_event" as never);
});

afterEach(() => {
	vi.restoreAllMocks();
});

async function seed_archive() {
	const f = await seed_folder_table();
	const owner = { organizationId: f.db.organizationId, workspaceId: f.db.workspaceId, userId: f.db.userId };
	const savedStream = { kind: "normal" as const, generation: 0 };
	const opNew = files_archive_operation_id_new(3000);
	const opOld = files_archive_operation_id_new(2000);
	// Archived before archive operation ids started with the time.
	const opLegacy = crypto.randomUUID();

	const ids = await test_run_with_flush(f.t, async (ctx) => {
		const insert = (args: Omit<Parameters<typeof insert_tree_node>[0], "ctx" | "owner">) =>
			insert_tree_node({ ctx, owner, ...args });
		// An active folder at the same path as an archived one. Only its archived file lists.
		const active = await insert({ parentId: "root", path: "/big", kind: "folder" });
		const inActive = await insert({ parentId: active, path: "/big/inner.md", kind: "file", archiveOperationId: opOld });
		const big = await insert({ parentId: "root", path: "/big", kind: "folder", archiveOperationId: opNew });
		// More items than a page, archived with their folder.
		for (let index = 0; index < 60; index++) {
			await insert({ parentId: big, path: `/big/f${index}.md`, kind: "file", archiveOperationId: opNew });
		}
		const locked = await insert({
			parentId: "root",
			path: "/locked",
			kind: "folder",
			scope: "self",
			archiveOperationId: opNew,
		});
		await ctx.db.patch("files_nodes", locked, { parentScopeNodeId: null });
		const old = await insert({ parentId: "root", path: "/old.md", kind: "file", archiveOperationId: opOld });
		const legacy = await insert({ parentId: "root", path: "/legacy.md", kind: "file", archiveOperationId: opLegacy });
		return { big, locked, inActive, old, legacy };
	});

	const read = (
		as: typeof f.asOwner,
		membershipId: Id<"organizations_workspaces_users">,
		area: Id<"files_nodes"> | null,
		paginationOpts: { numItems: number; cursor: string | null; endCursor?: string },
	) => as.query(api.files_tree.list_archived_tops, { membershipId, savedStream, area, paginationOpts });

	return { ...f, owner, ids, read };
}

describe("list_archived_tops", () => {
	test("lists each top item once, newest operation first, and jumps over archived folders", async () => {
		const f = await seed_archive();

		const pages = [];
		let cursor: string | null = null;
		for (let index = 0; index < 10; index++) {
			const result: Awaited<ReturnType<typeof f.read>> = await f.read(f.asOwner, f.db.membershipId, null, {
				numItems: 2,
				cursor,
			});
			pages.push(result.page.map((row) => row._id));
			if (result.isDone) break;
			cursor = result.continueCursor;
		}
		expect(pages, "newest operation first, then by path, and the old id last").toEqual([
			[f.ids.big, f.ids.locked],
			[f.ids.inActive, f.ids.old],
			[f.ids.legacy],
		]);

		const ranges = await f.asOwner.run(async (ctx) => {
			const before = await ctx.meta.getTransactionMetrics();
			await ctx.runQuery(api.files_tree.list_archived_tops, {
				membershipId: f.db.membershipId,
				savedStream: { kind: "normal", generation: 0 },
				area: null,
				paginationOpts: { numItems: 2, cursor: null },
			});
			return (await ctx.meta.getTransactionMetrics()).databaseQueries.used - before.databaseQueries.used;
		});
		expect(ranges, "the 60 archived items inside /big cost no read each").toBeLessThan(40);

		// A restricted folder lists in its parent area, not in its own.
		expect((await f.read(f.asOwner, f.db.membershipId, f.ids.locked, { numItems: 10, cursor: null })).page).toEqual([]);
	});

	test("a member sees a restricted folder they cannot open as a locked row, and a guest sees nothing", async () => {
		const f = await seed_archive();
		const member = await f.add_member("clerk_archived_member", "member");
		const guest = await f.add_member("clerk_archived_guest", null);

		const page = await f.read(member.as, member.membershipId, null, { numItems: 10, cursor: null });
		expect(page.page.map((row) => [row._id, row.locked])).toEqual([
			[f.ids.big, false],
			[f.ids.locked, true],
			[f.ids.inActive, false],
			[f.ids.old, false],
			[f.ids.legacy, false],
		]);
		expect(await f.read(guest.as, guest.membershipId, null, { numItems: 10, cursor: null })).toMatchObject({
			page: [],
			isDone: true,
		});
	});

	test("a page with an end cursor keeps its end when a newer item is archived", async () => {
		const f = await seed_archive();
		const first = await f.read(f.asOwner, f.db.membershipId, null, { numItems: 2, cursor: null });

		const newer = await test_run_with_flush(f.t, (ctx) =>
			insert_tree_node({
				ctx,
				owner: f.owner,
				parentId: "root",
				path: "/new.md",
				kind: "file",
				archiveOperationId: files_archive_operation_id_new(4000),
			}),
		);

		const again = await f.read(f.asOwner, f.db.membershipId, null, {
			numItems: 2,
			cursor: null,
			endCursor: first.continueCursor,
		});
		expect(
			again.page.map((row) => row._id),
			"the page grows instead of pushing a row to the next page",
		).toEqual([newer, f.ids.big, f.ids.locked]);
		expect(again.continueCursor).toBe(first.continueCursor);
		const second = await f.read(f.asOwner, f.db.membershipId, null, { numItems: 2, cursor: first.continueCursor });
		expect(second.page.map((row) => row._id)).toEqual([f.ids.inActive, f.ids.old]);
	});
});

describe("list_archive_areas", () => {
	test("lists the active restricted folders each reader can open, by path", async () => {
		const f = await seed_folder_table();
		const owner = { organizationId: f.db.organizationId, workspaceId: f.db.workspaceId, userId: f.db.userId };
		const ids = await test_run_with_flush(f.t, async (ctx) => {
			const insert = async (path: string, archiveOperationId?: string) => {
				const nodeId = await insert_tree_node({
					ctx,
					owner,
					parentId: "root",
					path,
					kind: "folder",
					scope: "self",
					archiveOperationId,
				});
				await ctx.db.patch("files_nodes", nodeId, { parentScopeNodeId: null });
				return nodeId;
			};
			return {
				team: await insert("/b-team"),
				mine: await insert("/a-mine"),
				hidden: await insert("/c-hidden"),
				archived: await insert("/d-archived", files_archive_operation_id_new(1000)),
			};
		});
		const member = await f.add_member("clerk_area_member", "member");
		await f.grant_read({ userId: member.userId }, [ids.mine, ids.archived]);
		await f.grant_read({ role: "member" }, [ids.team]);

		const read = async (as: typeof f.asOwner, membershipId: Id<"organizations_workspaces_users">) => {
			const rows = new Map<Id<"files_nodes">, string>();
			for (const principalIndex of [0, 1, 2, 3] as const) {
				const page = await as.query(api.files_tree.list_archive_areas, {
					membershipId,
					savedStream: { kind: "normal", generation: 0 },
					principalIndex,
					paginationOpts: { numItems: 10, cursor: null },
				});
				for (const row of page.page) rows.set(row._id, row.treePath);
			}
			return [...rows].sort((a, b) => (a[1] < b[1] ? -1 : 1)).map(([nodeId]) => nodeId);
		};
		expect(await read(f.asOwner, f.db.membershipId), "the owner opens every folder").toEqual([
			ids.mine,
			ids.team,
			ids.hidden,
		]);
		expect(await read(member.as, member.membershipId), "a member gets their own and their role's shares").toEqual([
			ids.mine,
			ids.team,
		]);
	});
});
