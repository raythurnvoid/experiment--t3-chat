import { Workpool } from "@convex-dev/workpool";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { test_rename_node, test_run_with_flush } from "./setup.test.ts";
import { insert_tree_node, seed_folder_table } from "./files_nodes.setup.test.ts";
import { run_to_end } from "./files_archive_runs.setup.test.ts";
import { files_archive_operation_id_new } from "../shared/files.ts";

beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("work_file_test_billing_event" as never);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

async function seed_archive() {
	const f = await seed_folder_table();
	const owner = { organizationId: f.db.organizationId, workspaceId: f.db.workspaceId, userId: f.db.userId };
	const savedStream = { kind: "normal" as const, generation: 0 };
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
	test("lists each top item once, newest operation first, without reading archived children", async () => {
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

	test("lists both top folders after a rename in Trash gives them the same path", async () => {
		const f = await seed_archive();
		const big = (await f.t.run((ctx) => ctx.db.get("files_nodes", f.ids.big)))!;
		const other = await test_run_with_flush(f.t, (ctx) =>
			insert_tree_node({
				ctx,
				owner: f.owner,
				parentId: "root",
				path: "/other",
				kind: "folder",
				archiveOperationId: big.archiveOperationId!,
			}),
		);
		expect(
			(await f.read(f.asOwner, f.db.membershipId, null, { numItems: 10, cursor: null })).page.map((row) => row._id),
		).toContain(other);

		const renamed = await test_rename_node(f.t, f.asOwner, {
			membershipId: f.db.membershipId,
			nodeId: other,
			path: "big",
		});
		expect(renamed._nay).toBeUndefined();
		expect(await f.t.run((ctx) => ctx.db.get("files_nodes", other))).toMatchObject({
			path: "/big",
			archiveOperationId: big.archiveOperationId,
		});

		const view = (await f.asOwner.query(api.files_tree.get_workspace_move_view, { membershipId: f.db.membershipId }))!;
		const read = (cursor: string | null) =>
			f.asOwner.query(api.files_tree.list_archived_tops, {
				membershipId: f.db.membershipId,
				savedStream: { kind: "normal", generation: view.generation },
				area: null,
				paginationOpts: { numItems: 2, cursor },
			});
		const first = await read(null);
		expect(
			first.page.map((row) => row._id),
			"both deleted folders appear once, before the next top item",
		).toEqual([f.ids.big, other]);
		const second = await read(first.continueCursor);
		expect(second.page.map((row) => row._id)).toEqual([f.ids.locked, f.ids.inActive]);
	});

	test("pages equal-path files and a top folder inside another top folder's path range", async () => {
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
		expect(listed, "overlapping paths and equal paths keep every distinct top item").toEqual([
			f.ids.big,
			ids.nested,
			f.ids.locked,
			...ids.files,
			f.ids.inActive,
			f.ids.old,
			f.ids.legacy,
		]);
	});

	test("pauses through child repair pages and restarts a pass after another parent change", async () => {
		const f = await seed_archive();
		const operation = files_archive_operation_id_new(5000);
		const otherOperation = files_archive_operation_id_new(6000);
		const tree = await test_run_with_flush(f.t, async (ctx) => {
			const parent = await insert_tree_node({
				ctx,
				owner: f.owner,
				parentId: "root",
				path: "/repair",
				kind: "folder",
				archiveOperationId: operation,
			});
			const children = [];
			for (let index = 0; index < 130; index++) {
				children.push(
					await insert_tree_node({
						ctx,
						owner: f.owner,
						parentId: parent,
						path: `/repair/f${String(index).padStart(3, "0")}.md`,
						kind: "file",
						archiveOperationId: operation,
					}),
				);
			}
			return { parent, children };
		});
		const ready = () => f.asOwner.query(api.files_tree.get_archived_tops_ready, { membershipId: f.db.membershipId });
		expect(await ready()).toBe(true);
		await test_run_with_flush(f.t, (ctx) =>
			ctx.db.patch("files_nodes", tree.parent, { archiveOperationId: otherOperation }),
		);
		const job = (await f.t.run((ctx) => ctx.db.query("files_trash_top_jobs").first()))!;
		expect(await ready(), "a parent change pauses Trash before a child pass starts").toBe(false);
		expect(
			await f.read(f.asOwner, f.db.membershipId, null, { numItems: 50, cursor: null }),
			"the query itself hides the unfinished index",
		).toMatchObject({ page: [], isDone: true });

		await f.t.mutation(internal.files_trash_tops.advance, { jobId: job._id, step: job.step });
		const firstPass = (await f.t.run((ctx) => ctx.db.get("files_trash_top_jobs", job._id)))!;
		await f.t.mutation(internal.files_trash_tops.advance, { jobId: job._id, step: job.step });
		expect(
			(await f.t.run((ctx) => ctx.db.get("files_trash_top_jobs", job._id)))?.cursor,
			"a repeated callback must not advance another page",
		).toBe(firstPass.cursor);
		expect((await f.t.run((ctx) => ctx.db.get("files_trash_top_jobs", job._id)))?.cursor).not.toBeNull();
		const repaired = await f.t.run(async (ctx) =>
			Promise.all(tree.children.map((id) => ctx.db.get("files_nodes", id))),
		);
		expect(repaired.filter((node) => node?.archiveTopScopeNodeId === null)).toHaveLength(64);
		expect(await ready(), "one page must not publish a partial Trash list").toBe(false);

		await test_run_with_flush(f.t, (ctx) =>
			ctx.db.patch("files_nodes", tree.parent, { archiveOperationId: operation }),
		);
		expect(await f.t.run((ctx) => ctx.db.get("files_trash_top_jobs", job._id))).toMatchObject({ cursor: null });
		await f.t.mutation(internal.files_trash_tops.advance, { jobId: job._id, step: firstPass.step });
		expect(
			(await f.t.run((ctx) => ctx.db.get("files_trash_top_jobs", job._id)))?.cursor,
			"an old callback must not advance a restarted pass",
		).toBeNull();
		for (let index = 0; index < 3; index++) {
			const current = (await f.t.run((ctx) => ctx.db.get("files_trash_top_jobs", job._id)))!;
			await f.t.mutation(internal.files_trash_tops.advance, { jobId: job._id, step: current.step });
		}
		expect(await ready()).toBe(true);
		const settled = await f.t.run(async (ctx) => Promise.all(tree.children.map((id) => ctx.db.get("files_nodes", id))));
		expect(
			settled.every((node) => node?.archiveTopScopeNodeId === undefined),
			"the restarted pass fixes earlier children too",
		).toBe(true);
		expect((await f.read(f.asOwner, f.db.membershipId, null, { numItems: 50, cursor: null })).page[0]?._id).toBe(
			tree.parent,
		);

		await test_run_with_flush(f.t, (ctx) => ctx.db.patch("files_nodes", tree.parent, { archiveOperationId: null }));
		const restoreJob = (await f.t.run((ctx) => ctx.db.query("files_trash_top_jobs").first()))!;
		for (let index = 0; index < 3; index++) {
			const current = (await f.t.run((ctx) => ctx.db.get("files_trash_top_jobs", restoreJob._id)))!;
			await f.t.mutation(internal.files_trash_tops.advance, { jobId: restoreJob._id, step: current.step });
		}
		expect(await ready()).toBe(true);
		const first = await f.read(f.asOwner, f.db.membershipId, null, { numItems: 50, cursor: null });
		expect(
			first.page.map((row) => row._id),
			"the first full page includes children whose parent became active",
		).toEqual(tree.children.slice(0, 50));
		expect(first.isDone).toBe(false);
		const second = await f.read(f.asOwner, f.db.membershipId, null, { numItems: 50, cursor: first.continueCursor });
		expect(second.page.map((row) => row._id)).toEqual(tree.children.slice(50, 100));
	});

	test("recovery schedules every due batch without waiting for another cron tick", async () => {
		const f = await seed_archive();
		await f.t.run(async (ctx) => {
			for (let index = 0; index < 51; index++) {
				await ctx.db.insert("files_trash_top_jobs", {
					organizationId: f.db.organizationId,
					workspaceId: f.db.workspaceId,
					parentId: f.ids.big,
					archiveOperationId: files_archive_operation_id_new(10_000 + index),
					cursor: null,
					step: 0,
					updatedAt: Date.now() - 60_001,
				});
			}
		});
		await f.t.mutation(internal.files_trash_tops.recover, {});
		const jobs = await f.t.run((ctx) => ctx.db.query("files_trash_top_jobs").collect());
		expect(jobs.filter((job) => job.updatedAt === Date.now())).toHaveLength(50);
		const continuations = await f.t.run(async (ctx) =>
			(await ctx.db.system.query("_scheduled_functions").collect()).filter(
				(job) => job.name === "files_trash_tops:recover",
			),
		);
		expect(continuations, "recovery schedules the next due batch").toHaveLength(1);
		await f.t.mutation(internal.files_trash_tops.recover, {});
		expect(
			(await f.t.run((ctx) => ctx.db.query("files_trash_top_jobs").collect())).every(
				(job) => job.updatedAt === Date.now(),
			),
		).toBe(true);
	});

	test("Restore Skip keeps both equal-path top folders and hides their same-delete children", async () => {
		const f = await seed_archive();
		const big = (await f.t.run((ctx) => ctx.db.get("files_nodes", f.ids.big)))!;
		const other = await test_run_with_flush(f.t, (ctx) =>
			insert_tree_node({
				ctx,
				owner: f.owner,
				parentId: "root",
				path: "/big",
				kind: "folder",
				archiveOperationId: big.archiveOperationId!,
			}),
		);
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
		for (let index = 0; index < 5; index++) {
			const repair = await f.t.run((ctx) => ctx.db.query("files_trash_top_jobs").first());
			if (!repair) break;
			await f.t.mutation(internal.files_trash_tops.advance, { jobId: repair._id, step: repair.step });
		}
		expect(await f.asOwner.query(api.files_tree.get_archived_tops_ready, { membershipId: f.db.membershipId })).toBe(
			true,
		);
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

	test("moves an archived top between areas when its active parent is restricted and opened again", async () => {
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
