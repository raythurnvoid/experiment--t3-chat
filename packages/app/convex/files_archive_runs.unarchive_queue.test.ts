// The later unarchive_nodes tests, from job order to read-only folders, split from
// files_archive_runs.unarchive.test.ts so the two files can run at the same time.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { test_move_nodes } from "./setup.test.ts";
import {
	fixture,
	seed_tree,
	seed_same_path,
	read_state,
	expect_consistent,
	read_activity,
	step,
	run_to_end,
	archive,
	restore,
	lock,
	read_node,
	add_metadata_docs,
	queue_empty_folders_first,
	count_queue,
	archive_to_end,
} from "./files_archive_runs.setup.test.ts";

// Scheduled steps never run on their own under fake timers. Each test drives the op's steps itself.
beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("unarchive_nodes", () => {
	test("the end of a job starts the next job of its own request, not of another request", async () => {
		const f = await fixture();
		const trees = [];
		for (const name of ["a1", "a2", "b1", "b2"]) {
			// 76 items: more than one step of 75, so each archive and restore is a job.
			const tree = await seed_tree(f, { name, folderCount: 1, filesPerFolder: 74 });
			await archive_to_end(f, tree.topId);
			trees.push(tree);
		}
		const read_restore_jobs = async () =>
			(await f.t.run((ctx) => ctx.db.query("activities").collect())).flatMap((activity) =>
				activity.source.kind === "files_archive_run" && activity.source.archiveKind === "restore"
					? [{ runId: activity.source.id, activityId: activity._id, status: activity.status }]
					: [],
			);
		const read_statuses = async () => (await read_restore_jobs()).map((job) => job.status);

		expect((await restore(f, [trees[0]!.topId, trees[1]!.topId]))._nay).toBeUndefined();
		expect((await restore(f, [trees[2]!.topId, trees[3]!.topId]))._nay).toBeUndefined();
		expect(await read_statuses()).toEqual(["running", "queued", "running", "queued"]);
		const [a1, a2, b1, b2] = await read_restore_jobs();

		const read_blocker = async (runId: Id<"files_archive_runs">) =>
			(await f.t.run((ctx) =>
				ctx.db
					.query("files_subtree_ops")
					.withIndex("by_archiveRun", (q) => q.eq("archiveRunId", runId))
					.unique(),
			))!.blockedByOpId;

		// The older queued job belongs to the first request. Starting it here would run it next to the
		// first request's running job.
		expect((await run_to_end(f, b1!)).activity.status).toBe("succeeded");
		expect(await read_blocker(b2!.runId)).toBeNull();
		expect(await read_blocker(a2!.runId)).not.toBeNull();

		expect((await run_to_end(f, a1!)).activity.status).toBe("succeeded");
		expect(await read_blocker(a2!.runId)).toBeNull();
		expect((await run_to_end(f, a2!)).activity.status).toBe("succeeded");
		expect((await run_to_end(f, b2!)).activity.status).toBe("succeeded");

		const state = await expect_consistent(f);
		expect(state.nodes.filter((node) => node.archiveOperationId !== null)).toEqual([]);
	}, 60_000);

	test("a queued restore never times out, and Stop on the clash wait ends the whole request", async () => {
		const f = await fixture();
		const clash = await seed_same_path(f, { name: "ahead", count: 200, archiveOperationId: crypto.randomUUID() });
		const tree = await seed_tree(f, { name: "behind", folderCount: 2, filesPerFolder: 100 });
		await archive_to_end(f, tree.topId);

		const restored = await restore(f, [clash.fileIds[0]!, tree.topId]);
		expect(restored._nay).toBeUndefined();
		const [ahead, queued] = (await f.t.run((ctx) => ctx.db.query("activities").collect())).flatMap((activity) =>
			activity.source.kind === "files_archive_run" && activity.source.archiveKind === "restore"
				? [{ runId: activity.source.id, activityId: activity._id, status: activity.status }]
				: [],
		);
		expect(queued!.status).toBe("queued");
		expect((await run_to_end(f, ahead!)).activity.status).toBe("awaiting_input");

		// The queued job reaches its deadline while the job ahead still waits for the choice.
		const now = Date.now();
		await f.t.run((ctx) => ctx.db.patch("activities", queued!.activityId, { deadlineAt: now - 1 }));
		await f.t.mutation(internal.activities.recover_expired, { _test_now: now, _test_disableReschedule: true });
		const waiting = await read_activity(f, queued!.activityId);
		expect(waiting.status).toBe("queued");
		expect(waiting.deadlineAt).toBe(now + 24 * 60 * 60 * 1000);

		expect(
			await f.asOwner.mutation(api.activities.request_stop, {
				membershipId: f.db.membershipId,
				activityId: ahead!.activityId,
			}),
		).toEqual({ _yay: null });
		expect((await read_activity(f, ahead!.activityId)).status).toBe("canceled");
		expect((await read_activity(f, queued!.activityId)).status).toBe("canceled");
		expect(await f.t.run((ctx) => ctx.db.query("files_subtree_ops").collect())).toEqual([]);
		expect((await read_node(f, tree.topId)).archiveOperationId).not.toBeNull();
	});

	test("an item whose old folder is still archived lands at the workspace root", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "orphan", folderCount: 1, filesPerFolder: 2 });
		expect(await archive(f, [tree.folderIds[0]!])).toEqual({ _yay: null });
		expect(await archive(f, [tree.topId])).toEqual({ _yay: null });

		expect(await restore(f, [tree.fileIds[0]!])).toEqual({ _yay: null });

		expect(await read_node(f, tree.folderIds[0]!)).toMatchObject({ parentId: "root", path: "/d0" });
		expect(await read_node(f, tree.fileIds[0]!)).toMatchObject({ archiveOperationId: null, path: "/d0/f000.md" });
		expect((await read_node(f, tree.topId)).archiveOperationId).not.toBeNull();
		await expect_consistent(f);
	});

	test("restoring both operations at once puts the inner one back inside its folder", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "both", folderCount: 1, filesPerFolder: 2 });
		expect(await archive(f, [tree.folderIds[0]!])).toEqual({ _yay: null });
		expect(await archive(f, [tree.topId])).toEqual({ _yay: null });

		expect(await restore(f, [tree.fileIds[0]!, tree.topId])).toEqual({ _yay: null });

		expect(await read_node(f, tree.folderIds[0]!)).toMatchObject({ parentId: tree.topId, path: "/both/d0" });
		const state = await expect_consistent(f);
		expect(state.nodes.every((node) => node.archiveOperationId === null)).toBe(true);
	});

	test("restoring several operations starts with the top one, even when a deep item is named", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "order", folderCount: 2, filesPerFolder: 1 });
		expect(await archive(f, [tree.folderIds[0]!])).toEqual({ _yay: null });
		expect(await archive(f, [tree.topId])).toEqual({ _yay: null });

		// `/order/d0/` sorts before the named `/order/d1/f000.md`, but `/order` holds `d0`.
		expect(await restore(f, [tree.folderIds[0]!, tree.fileIds[1]!])).toEqual({ _yay: null });

		expect(await read_node(f, tree.folderIds[0]!)).toMatchObject({ parentId: tree.topId, path: "/order/d0" });
		await expect_consistent(f);
	});

	test("a folder that lands somewhere new takes the items archived on their own inside it", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "nested", folderCount: 1, filesPerFolder: 2 });
		expect(await archive(f, [tree.fileIds[0]!])).toEqual({ _yay: null });
		const fileOperationId = (await read_node(f, tree.fileIds[0]!)).archiveOperationId;
		expect(await archive(f, [tree.folderIds[0]!])).toEqual({ _yay: null });
		expect(await archive(f, [tree.topId])).toEqual({ _yay: null });

		// `/nested` stays archived, so `d0` lands at the workspace root.
		expect(await restore(f, [tree.folderIds[0]!])).toEqual({ _yay: null });

		expect(await read_node(f, tree.folderIds[0]!)).toMatchObject({ archiveOperationId: null, path: "/d0" });
		expect(await read_node(f, tree.fileIds[0]!)).toMatchObject({
			archiveOperationId: fileOperationId,
			path: "/d0/f000.md",
			treePath: "/d0/f000.md",
		});
		await expect_consistent(f);
	});

	test("a folder lands even when an item archived on its own inside has many side docs", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "heavy", folderCount: 1, filesPerFolder: 1 });
		expect(await archive(f, [tree.fileIds[0]!])).toEqual({ _yay: null });
		await add_metadata_docs({ f, fileNodeId: tree.fileIds[0]!, count: 2000 });
		expect(await archive(f, [tree.folderIds[0]!])).toEqual({ _yay: null });
		expect(await archive(f, [tree.topId])).toEqual({ _yay: null });

		const restored = await restore(f, [tree.folderIds[0]!]);
		expect(restored._nay).toBeUndefined();
		if (restored._yay) await run_to_end(f, restored._yay);

		expect((await read_node(f, tree.folderIds[0]!)).archiveOperationId).toBeNull();
		expect((await read_node(f, tree.fileIds[0]!)).path).toBe("/d0/f000.md");
		await expect_consistent(f);
	});

	test("a step that only clears empty and deleted folders from the queue stops near the limits", async () => {
		// With a limit of 1,000 queries, clearing 200 + 200 folders needs more than one step. 70 + 70 fit in one.
		const f = await fixture({ transactionLimits: { databaseQueries: 1000 } });
		// 76 items: more than one step of 75, so the archive and the restore are jobs.
		const tree = await seed_tree(f, { name: "drain", folderCount: 1, filesPerFolder: 74 });
		await archive_to_end(f, tree.topId);
		const job = (await restore(f, [tree.topId]))._yay!;
		let run = (await f.t.run((ctx) => ctx.db.get("files_archive_runs", job.runId)))!;
		while (run.phase !== "apply") run = (await step(f, job.runId))!;
		const opId = await queue_empty_folders_first({
			f,
			runId: job.runId,
			archiveOperationId: null,
			count: 200,
		});

		await expect(step(f, job.runId)).resolves.toMatchObject({ active: true });
		expect(await count_queue(f, opId)).toBeGreaterThan(0);

		expect((await run_to_end(f, job)).activity.status).toBe("succeeded");
		expect((await read_state(f)).nodes.filter((node) => node.archiveOperationId !== null)).toEqual([]);
	}, 120_000);

	test("a restore of many top items keeps a small queue, and its op holds at most 64 paths", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "tops", folderCount: 200, filesPerFolder: 1 });
		const archived = await archive(f, tree.fileIds);
		if (archived._yay) await run_to_end(f, archived._yay);
		const treePaths = tree.fileIds.map((_, index) => `/tops/d${index}/f000.md`);

		const job = (await restore(f, [tree.fileIds[0]!]))._yay!;
		for (let count = 0; count < 100; count++) {
			const { op, queued } = await f.t.run(async (ctx) => {
				const op = await ctx.db
					.query("files_subtree_ops")
					.withIndex("by_archiveRun", (q) => q.eq("archiveRunId", job.runId))
					.unique();
				const rows = (await ctx.db.query("files_subtree_op_nodes").collect()).filter((row) => row.opId === op?._id);
				return { op, queued: rows.length };
			});
			if (!op) break;
			// The op keeps a few folder paths that hold every top item, not one path per item.
			expect(op.treePaths.length).toBeLessThanOrEqual(64);
			if ((await f.t.run((ctx) => ctx.db.get("files_archive_runs", job.runId)))!.phase !== "discover") {
				const holds = (outer: string, inner: string) =>
					outer === inner || (outer.endsWith("/") && inner.startsWith(outer));
				expect(treePaths.filter((treePath) => !op.treePaths.some((busy) => holds(busy, treePath)))).toEqual([]);
			}
			expect(queued).toBeLessThanOrEqual(50);
			await step(f, job.runId);
		}

		expect((await read_activity(f, job.activityId)).status).toBe("succeeded");
		expect((await read_state(f)).nodes.filter((node) => node.archiveOperationId !== null)).toEqual([]);
	}, 120_000);

	test("a restore pull queues one page of top items", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "tops", folderCount: 200, filesPerFolder: 1 });
		const archived = await archive(f, tree.fileIds);
		if (archived._yay) await run_to_end(f, archived._yay);
		// The first top item a pull queues runs first. A clash on it pauses the step before any item lands,
		// so the queue then holds exactly what one pull queued.
		const occupants = await seed_tree(f, { name: "occupants", folderCount: 1, filesPerFolder: 1 });
		expect(
			await test_move_nodes(f.t, f.asOwner, {
				membershipId: f.db.membershipId,
				itemIds: [occupants.fileIds[0]!],
				targetParentId: tree.folderIds[0]!,
			}),
		).toEqual({ _yay: null });

		const job = (await restore(f, [tree.fileIds[0]!]))._yay!;
		expect((await run_to_end(f, job)).activity.status).toBe("awaiting_input");

		const { run, opId } = await f.t.run(async (ctx) => ({
			run: (await ctx.db.get("files_archive_runs", job.runId))!,
			opId: (await ctx.db
				.query("files_subtree_ops")
				.withIndex("by_archiveRun", (q) => q.eq("archiveRunId", job.runId))
				.unique())!._id,
		}));
		expect(run.conflict?.nodeId).toBe(tree.fileIds[0]);
		expect(await count_queue(f, opId)).toBe(50);
	}, 120_000);

	describe("read-only folders", () => {
		test("refuses when the folder it comes back into is read-only, and works after unlock", async () => {
			const f = await fixture();
			const tree = await seed_tree(f, { name: "ro-active", folderCount: 1, filesPerFolder: 2 });
			expect(await archive(f, [tree.fileIds[0]!])).toEqual({ _yay: null });
			await lock({ f, nodeId: tree.folderIds[0]!, locked: true });

			const refused = await restore(f, [tree.fileIds[0]!]);
			expect(refused._nay?.name).toBe("read_only");
			expect((await read_node(f, tree.fileIds[0]!)).archiveOperationId).not.toBeNull();

			await lock({ f, nodeId: tree.folderIds[0]!, locked: false });
			expect(await restore(f, [tree.fileIds[0]!])).toEqual({ _yay: null });
			expect((await read_node(f, tree.fileIds[0]!)).archiveOperationId).toBeNull();
		});

		test("refuses when the archived folder it leaves is read-only", async () => {
			const f = await fixture();
			const tree = await seed_tree(f, { name: "ro-archived", folderCount: 1, filesPerFolder: 2 });
			expect(await archive(f, [tree.fileIds[0]!])).toEqual({ _yay: null });
			expect(await archive(f, [tree.folderIds[0]!])).toEqual({ _yay: null });
			await lock({ f, nodeId: tree.folderIds[0]!, locked: true });

			const refused = await restore(f, [tree.fileIds[0]!]);
			expect(refused._nay?.name).toBe("read_only");
			expect((await read_node(f, tree.fileIds[0]!)).archiveOperationId).not.toBeNull();

			await lock({ f, nodeId: tree.folderIds[0]!, locked: false });
			expect(await restore(f, [tree.fileIds[0]!])).toEqual({ _yay: null });
			expect(await read_node(f, tree.fileIds[0]!)).toMatchObject({ archiveOperationId: null, path: "/f000.md" });
		});

		test("stops when a folder it restored is locked before the items inside come back", async () => {
			const f = await fixture();
			const tree = await seed_tree(f, { name: "ro-inside", folderCount: 2, filesPerFolder: 100 });
			await archive_to_end(f, tree.topId);
			const job = (await restore(f, [tree.topId]))._yay!;
			for (let count = 0; (await read_node(f, tree.folderIds[1]!)).archiveOperationId !== null; count++) {
				if (count === 20) throw new Error("The folder did not come back");
				await step(f, job.runId);
			}
			expect((await read_node(f, tree.fileIds[100]!)).archiveOperationId).not.toBeNull();

			await lock({ f, nodeId: tree.folderIds[1]!, locked: true });

			expect((await run_to_end(f, job)).activity.status).toBe("failed");
			expect((await read_node(f, tree.fileIds[100]!)).archiveOperationId).not.toBeNull();
		}, 120_000);
	});
});
