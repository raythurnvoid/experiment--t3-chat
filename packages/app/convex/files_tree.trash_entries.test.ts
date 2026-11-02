import { Workpool } from "@convex-dev/workpool";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { test_run_with_flush } from "./setup.test.ts";
import { insert_tree_node, seed_folder_table } from "./files_nodes.setup.test.ts";
import { run_to_end } from "./files_archive_runs.setup.test.ts";
import { files_trash_entries_db_insert } from "../server/files-trash-entries.ts";
import { files_archive_operation_id_new } from "../shared/files.ts";

beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("work_file_test_billing_event" as never);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

/**
 * Give Trash entries to seeded items, like the step that moves an item to Trash on its own does.
 */
async function insert_entries(ctx: MutationCtx, nodeIds: Array<Id<"files_nodes">>) {
	for (const nodeId of nodeIds) await files_trash_entries_db_insert(ctx, (await ctx.db.get("files_nodes", nodeId))!);
}

async function seed_archive() {
	const f = await seed_folder_table();
	const owner = { organizationId: f.db.organizationId, workspaceId: f.db.workspaceId, userId: f.db.userId };
	const opNew = files_archive_operation_id_new(3000);
	const opOld = files_archive_operation_id_new(2000);
	// Moved to Trash before archive operation ids started with the time.
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
		await insert_entries(ctx, [big, locked, inActive, old, legacy]);
		return { big, locked, inActive, old, legacy };
	});

	const read = (
		as: typeof f.asOwner,
		membershipId: Id<"organizations_workspaces_users">,
		area: Id<"files_nodes"> | null,
		paginationOpts: { numItems: number; cursor: string | null; endCursor?: string },
	) => as.query(api.files_tree.list_trash_entries, { membershipId, area, paginationOpts });

	return { ...f, owner, ids, read };
}

describe("list_trash_entries", () => {
	test("lists each entry once, newest operation first, without reading archived children", async () => {
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
			await ctx.runQuery(api.files_tree.list_trash_entries, {
				membershipId: f.db.membershipId,
				area: null,
				paginationOpts: { numItems: 2, cursor: null },
			});
			return (await ctx.meta.getTransactionMetrics()).databaseQueries.used - before.databaseQueries.used;
		});
		expect(ranges, "the 60 archived items inside /big cost no read each").toBeLessThan(40);

		// A restricted folder lists in its parent area, not in its own.
		expect((await f.read(f.asOwner, f.db.membershipId, f.ids.locked, { numItems: 10, cursor: null })).page).toEqual([]);
	});

	test("pages equal-path files and an entry folder inside another entry folder's path range", async () => {
		const f = await seed_archive();
		const big = (await f.t.run((ctx) => ctx.db.get("files_nodes", f.ids.big)))!;
		const inActive = (await f.t.run((ctx) => ctx.db.get("files_nodes", f.ids.inActive)))!;
		const ids = await test_run_with_flush(f.t, async (ctx) => {
			const nested = await insert_tree_node({
				ctx,
				owner: f.owner,
				parentId: inActive.parentId,
				path: "/big/nested",
				kind: "folder",
				archiveOperationId: big.archiveOperationId!,
			});
			const files = [];
			for (let index = 0; index < 3; index++) {
				files.push(
					await insert_tree_node({
						ctx,
						owner: f.owner,
						parentId: "root",
						path: "/same.md",
						kind: "file",
						archiveOperationId: big.archiveOperationId!,
					}),
				);
			}
			await insert_entries(ctx, [nested, ...files]);
			return { nested, files };
		});
		const listed: Array<Id<"files_nodes">> = [];
		let cursor: string | null = null;
		for (let index = 0; index < 12; index++) {
			const page: Awaited<ReturnType<typeof f.read>> = await f.read(f.asOwner, f.db.membershipId, null, {
				numItems: 1,
				cursor,
			});
			listed.push(...page.page.map((row) => row._id));
			if (page.isDone) break;
			cursor = page.continueCursor;
		}
		expect(listed, "overlapping paths and equal paths keep every distinct entry").toEqual([
			f.ids.big,
			ids.nested,
			f.ids.locked,
			...ids.files,
			f.ids.inActive,
			f.ids.old,
			f.ids.legacy,
		]);
	});

	test("Restore Skip keeps both equal-path folders as entries and hides their same-delete children", async () => {
		const f = await seed_archive();
		const big = (await f.t.run((ctx) => ctx.db.get("files_nodes", f.ids.big)))!;
		const other = await test_run_with_flush(f.t, async (ctx) => {
			const nodeId = await insert_tree_node({
				ctx,
				owner: f.owner,
				parentId: "root",
				path: "/big",
				kind: "folder",
				archiveOperationId: big.archiveOperationId!,
			});
			await insert_entries(ctx, [nodeId]);
			return nodeId;
		});
		const started = await f.asOwner.mutation(api.files_nodes.unarchive_nodes, {
			membershipId: f.db.membershipId,
			nodeIds: [f.ids.big],
		});
		expect(started._nay).toBeUndefined();
		const job = started._yay!;
		expect((await run_to_end(f, job)).activity.status).toBe("awaiting_input");
		const run = (await f.t.run((ctx) => ctx.db.get("files_archive_runs", job.runId)))!;
		expect(
			await f.asOwner.mutation(api.files_archive_runs.resolve_conflicts, {
				membershipId: f.db.membershipId,
				runId: job.runId,
				revision: run.revision,
				choice: "skip",
				applyToRemaining: { file: "skip", folder: "skip" },
			}),
		).toEqual({ _yay: null });
		expect((await run_to_end(f, job)).activity.status).toBe("succeeded");
		const page = await f.read(f.asOwner, f.db.membershipId, null, { numItems: 50, cursor: null });
		expect(
			page.page.slice(0, 2).map((row) => row._id),
			"Skip leaves both equal-path folders reachable",
		).toEqual([f.ids.big, other]);
		expect(
			page.page.filter((row) => row.parentId === f.ids.big),
			"children of the same delete stay inside their folder",
		).toEqual([]);
	});

	test("moves an entry between areas when its active parent is restricted and opened again", async () => {
		const f = await seed_archive();
		const child = (await f.t.run((ctx) => ctx.db.get("files_nodes", f.ids.inActive)))!;
		const parentId = child.parentId as Id<"files_nodes">;
		const args = { membershipId: f.db.membershipId, nodeId: parentId };
		expect(await f.asOwner.mutation(api.files_sharing.restrict_node, args)).toEqual({ _yay: null });
		expect(
			(await f.read(f.asOwner, f.db.membershipId, null, { numItems: 10, cursor: null })).page.map((row) => row._id),
		).not.toContain(child._id);
		expect(
			(await f.read(f.asOwner, f.db.membershipId, parentId, { numItems: 10, cursor: null })).page.map((row) => row._id),
		).toEqual([child._id]);
		expect(await f.asOwner.mutation(api.files_sharing.unrestrict_node, args)).toEqual({ _yay: null });
		expect(
			(await f.read(f.asOwner, f.db.membershipId, null, { numItems: 10, cursor: null })).page.map((row) => row._id),
		).toContain(child._id);
	});

	test("an entry goes away when its item is restored or deleted for good", async () => {
		const f = await seed_archive();
		// One file comes back inside the request.
		expect(
			await f.asOwner.mutation(api.files_nodes.unarchive_nodes, {
				membershipId: f.db.membershipId,
				nodeIds: [f.ids.old],
			}),
		).toEqual({ _yay: null });
		await test_run_with_flush(f.t, (ctx) => ctx.db.delete("files_nodes", f.ids.legacy));

		const entryNodeIds = await f.t.run(async (ctx) =>
			(await ctx.db.query("files_trash_entries").collect()).map((entry) => entry.nodeId),
		);
		expect(entryNodeIds.toSorted()).toEqual([f.ids.big, f.ids.locked, f.ids.inActive].toSorted());
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

		const newer = await test_run_with_flush(f.t, async (ctx) => {
			const nodeId = await insert_tree_node({
				ctx,
				owner: f.owner,
				parentId: "root",
				path: "/new.md",
				kind: "file",
				archiveOperationId: files_archive_operation_id_new(4000),
			});
			await insert_entries(ctx, [nodeId]);
			return nodeId;
		});

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
			const insert = async (path: string, archiveOperationId?: string, kind: "folder" | "file" = "folder") => {
				const nodeId = await insert_tree_node({
					ctx,
					owner,
					parentId: "root",
					path,
					kind,
					scope: "self",
					archiveOperationId,
				});
				await ctx.db.patch("files_nodes", nodeId, { parentScopeNodeId: null });
				return nodeId;
			};
			return {
				team: await insert("/b-team"),
				mine: await insert("/a-mine"),
				// A restricted file holds no other items, so it is no area.
				file: await insert("/a-file.md", undefined, "file"),
				hidden: await insert("/c-hidden"),
				archived: await insert("/d-archived", files_archive_operation_id_new(1000)),
				pluginLive: await insert("/e-plugin-live"),
				// More than one page, and they sort before the live lifetime in the share row index.
				pluginOld: await Promise.all(
					Array.from({ length: 11 }, (_, index) => insert(`/f-plugin-old-${String(index).padStart(2, "0")}`)),
				),
			};
		});
		const member = await f.add_member("clerk_area_member", "member");
		await f.grant_read({ userId: member.userId }, [ids.mine, ids.file, ids.archived]);
		await f.grant_read({ role: "member" }, [ids.team]);
		// A plugin grant counts only for the membership lifetime it was made in.
		await f.t.run((ctx) =>
			ctx.db.insert("organizations_membership_lifetimes", {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				userId: member.userId,
				membershipId: member.membershipId,
				lifetime: 2,
				active: true,
			}),
		);
		await f.grant_read({ userId: member.userId, externalPluginMembershipLifetime: 2 }, [ids.pluginLive]);
		await f.grant_read({ userId: member.userId, externalPluginMembershipLifetime: 1 }, ids.pluginOld);

		const read = async (as: typeof f.asOwner, membershipId: Id<"organizations_workspaces_users">) => {
			const rows = new Map<Id<"files_nodes">, string>();
			for (const principalIndex of [0, 1, 2, 3, 4] as const) {
				const page = await as.query(api.files_tree.list_archive_areas, {
					membershipId,
					savedStream: { kind: "normal", generation: 0 },
					principalIndex,
					paginationOpts: { numItems: 50, cursor: null },
				});
				for (const row of page.page) rows.set(row._id, row.treePath);
			}
			return [...rows].sort((a, b) => (a[1] < b[1] ? -1 : 1)).map(([nodeId]) => nodeId);
		};
		expect(await read(f.asOwner, f.db.membershipId), "the owner opens every folder").toEqual([
			ids.mine,
			ids.team,
			ids.hidden,
			ids.pluginLive,
			...ids.pluginOld,
		]);
		expect(
			await read(member.as, member.membershipId),
			"a member gets their own, their role's, and their live plugin shares",
		).toEqual([ids.mine, ids.team, ids.pluginLive]);
		const pluginPage = await member.as.query(api.files_tree.list_archive_areas, {
			membershipId: member.membershipId,
			savedStream: { kind: "normal", generation: 0 },
			principalIndex: 4,
			paginationOpts: { numItems: 10, cursor: null },
		});
		expect(
			pluginPage.page.map((row) => row._id),
			"the first page reads no grant of an old lifetime",
		).toEqual([ids.pluginLive]);
	});
});
