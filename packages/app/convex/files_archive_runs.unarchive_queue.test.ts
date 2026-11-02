// The later unarchive_nodes tests, from job order to read-only folders, split from
// files_archive_runs.unarchive.test.ts so the two files can run at the same time.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import {
	test_finish_saved_scope_jobs,
	test_folder_chain_path,
	test_move_nodes,
	test_rename_node,
} from "./setup.test.ts";
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
	folder,
	find_node,
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
			// 76 items: each archive is a job because the folder has items, and each restore is a job
			// because 76 is more than its 10 stamps.
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

		const restored = await restore(f, [...clash.fileIds, tree.topId]);
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
		// The stopped job first gives Trash entries to the items it did not restore.
		expect((await read_activity(f, ahead!.activityId)).status).toBe("stopping");
		expect((await run_to_end(f, ahead!)).activity.status).toBe("canceled");
		expect((await read_activity(f, queued!.activityId)).status).toBe("canceled");
		expect(await f.t.run((ctx) => ctx.db.query("files_subtree_ops").collect())).toEqual([]);
		expect((await read_node(f, tree.topId)).archiveOperationId).not.toBeNull();
	});

	test("an item whose old folder is still archived comes back in a new folder at its Trash path", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "orphan", folderCount: 1, filesPerFolder: 2 });
		await archive_to_end(f, tree.folderIds[0]!);
		expect(await archive(f, [tree.topId])).toEqual({ _yay: null });

		expect(await restore(f, [tree.folderIds[0]!])).toEqual({ _yay: null });

		const restored = await read_node(f, tree.folderIds[0]!);
		expect(restored).toMatchObject({ path: "/orphan/d0" });
		// Like `mkdir -p`: a new live `/orphan`. The old one stays in Trash.
		expect(restored.parentId).not.toBe(tree.topId);
		expect(await read_node(f, restored.parentId as Id<"files_nodes">)).toMatchObject({
			archiveOperationId: null,
			path: "/orphan",
		});
		expect(await read_node(f, tree.fileIds[0]!)).toMatchObject({
			archiveOperationId: null,
			path: "/orphan/d0/f000.md",
		});
		expect((await read_node(f, tree.topId)).archiveOperationId).not.toBeNull();
		await expect_consistent(f);
	});

	describe("Trash path", () => {
		test("an item whose active folder was renamed comes back at its Trash path, in a new folder", async () => {
			const f = await fixture();
			const tree = await seed_tree(f, { name: "work", folderCount: 1, filesPerFolder: 2 });
			expect(await archive(f, [tree.fileIds[0]!])).toEqual({ _yay: null });
			expect(
				(
					await test_rename_node(f.t, f.asOwner, {
						membershipId: f.db.membershipId,
						nodeId: tree.topId,
						path: "projects",
					})
				)._nay,
			).toBeUndefined();

			expect(await restore(f, [tree.fileIds[0]!])).toEqual({ _yay: null });

			expect(await read_node(f, tree.fileIds[0]!)).toMatchObject({
				archiveOperationId: null,
				path: "/work/d0/f000.md",
			});
			expect(await read_node(f, tree.topId), "the renamed folder keeps its name").toMatchObject({ path: "/projects" });
			expect(await read_node(f, tree.fileIds[1]!)).toMatchObject({ path: "/projects/d0/f001.md" });
			await expect_consistent(f);
		});

		test("a file where a folder of the Trash path should be refuses the restore and makes no folder", async () => {
			const f = await fixture();
			const tree = await seed_tree(f, { name: "blocked", folderCount: 1, filesPerFolder: 1 });
			await archive_to_end(f, tree.folderIds[0]!);
			// Put an active file named `d0` where the folder was.
			const other = await seed_tree(f, { name: "other", folderCount: 1, filesPerFolder: 1 });
			expect(
				(
					await test_rename_node(f.t, f.asOwner, {
						membershipId: f.db.membershipId,
						nodeId: other.fileIds[0]!,
						path: "d0",
					})
				)._nay,
			).toBeUndefined();
			expect(
				await test_move_nodes(f.t, f.asOwner, {
					membershipId: f.db.membershipId,
					itemIds: [other.fileIds[0]!],
					targetParentId: tree.topId,
				}),
			).toEqual({ _yay: null });
			const nodesBefore = (await read_state(f)).nodes;

			expect(await restore(f, [tree.fileIds[0]!])).toEqual({
				_nay: {
					name: "file_in_the_way",
					message:
						'"/blocked/d0" is a file, so "f000.md" cannot come back to its folder. Rename or move that file, then restore again.',
				},
			});
			expect((await read_state(f)).nodes).toEqual(nodesBefore);
		});

		test("a read-only active folder where the Trash path needs a new folder refuses the job before anything moves", async () => {
			const f = await fixture();
			const good = await seed_tree(f, { name: "good", folderCount: 1, filesPerFolder: 0 });
			// An item that is its own restricted folder skips the Move checks, so only the create check
			// sees the read-only folder.
			const itemId = await folder(f, "/ro-path/mid/item");
			expect(
				(await f.asOwner.mutation(api.files_sharing.restrict_node, { membershipId: f.db.membershipId, nodeId: itemId }))
					._nay,
			).toBeUndefined();
			await test_finish_saved_scope_jobs(f.t);
			// One Trash operation, so one restore job checks both items.
			expect(await archive(f, [good.folderIds[0]!, itemId])).toEqual({ _yay: null });
			const midId = (await find_node(f, "/ro-path/mid"))._id;
			expect(await archive(f, [midId])).toEqual({ _yay: null });
			await lock({ f, nodeId: (await find_node(f, "/ro-path"))._id, locked: true });
			const nodesBefore = (await read_state(f)).nodes;

			const refused = await restore(f, [good.folderIds[0]!, itemId]);
			expect(refused._nay?.name).toBe("read_only");
			expect((await read_state(f)).nodes, "the good item stays in Trash too").toEqual(nodesBefore);
		});

		test("a Trash path with more missing folders than one create may make comes back over several steps", async () => {
			const f = await fixture();
			// 40 folders below `/deep`: more than the `files_NEW_FOLDER_DEPTH_MAX` one create may make. The
			// fixture makes them in two creates for the same reason.
			const chain = test_folder_chain_path("deep", 41);
			await folder(f, test_folder_chain_path("deep", 21));
			const itemId = await folder(f, `${chain}/item`);
			const topId = (await find_node(f, "/deep"))._id;
			expect(await archive(f, [itemId])).toEqual({ _yay: null });
			await archive_to_end(f, topId);

			const job = (await restore(f, [itemId]))._yay;
			expect(job, "the restore needs a job with more than one step").not.toBeNull();
			expect((await run_to_end(f, job!)).activity.status).toBe("succeeded");

			expect(await read_node(f, itemId)).toMatchObject({ archiveOperationId: null, path: `${chain}/item` });
			expect((await read_node(f, topId)).archiveOperationId, "the old /deep stays in Trash").not.toBeNull();
			await expect_consistent(f);
		});
	});

	test("restoring both operations at once puts the inner one back inside its folder", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "both", folderCount: 1, filesPerFolder: 2 });
		await archive_to_end(f, tree.folderIds[0]!);
		expect(await archive(f, [tree.topId])).toEqual({ _yay: null });

		expect(await restore(f, [tree.folderIds[0]!, tree.topId])).toEqual({ _yay: null });

		expect(await read_node(f, tree.folderIds[0]!)).toMatchObject({ parentId: tree.topId, path: "/both/d0" });
		const state = await expect_consistent(f);
		expect(state.nodes.every((node) => node.archiveOperationId === null)).toBe(true);
	});

	test("restoring several operations starts with the selected parent", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "order", folderCount: 2, filesPerFolder: 1 });
		await archive_to_end(f, tree.folderIds[0]!);
		await archive_to_end(f, tree.topId);

		// Name the inner folder first. Its selected parent must still come back first.
		expect(await restore(f, [tree.folderIds[0]!, tree.fileIds[1]!, tree.topId])).toEqual({ _yay: null });

		expect(await read_node(f, tree.folderIds[0]!)).toMatchObject({ parentId: tree.topId, path: "/order/d0" });
		await expect_consistent(f);
	});

	test("a folder that lands somewhere new takes the items archived on their own inside it", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "nested", folderCount: 1, filesPerFolder: 2 });
		expect(await archive(f, [tree.fileIds[0]!])).toEqual({ _yay: null });
		const fileOperationId = (await read_node(f, tree.fileIds[0]!)).archiveOperationId;
		await archive_to_end(f, tree.folderIds[0]!);
		expect(await archive(f, [tree.topId])).toEqual({ _yay: null });

		// `/nested` stays archived, so `d0` lands in a new `/nested`.
		expect(await restore(f, [tree.folderIds[0]!])).toEqual({ _yay: null });

		expect(await read_node(f, tree.folderIds[0]!)).toMatchObject({ archiveOperationId: null, path: "/nested/d0" });
		expect(await read_node(f, tree.fileIds[0]!)).toMatchObject({
			archiveOperationId: fileOperationId,
			path: "/nested/d0/f000.md",
			treePath: "/nested/d0/f000.md",
		});
		const state = await expect_consistent(f);
		// A small item copies its new path onto its side docs in the step, with no saved scope job. So the
		// check above compared its side docs too.
		expect(state.savedScopeJobs.map((job) => job.key)).not.toContain(tree.fileIds[0]);
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
		expect((await read_node(f, tree.fileIds[0]!)).path).toBe("/heavy/d0/f000.md");
		await expect_consistent(f);
	});

	test("a step that only clears empty and deleted folders from the queue stops near the limits", async () => {
		// With a limit of 1,000 queries, clearing 200 + 200 folders needs more than one step. 70 + 70 fit in one.
		const f = await fixture({ transactionLimits: { databaseQueries: 1000 } });
		// 76 items: the archive is a job because the folder has items, and the restore is a job because 76
		// is more than its 10 stamps.
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

		const job = (await restore(f, tree.fileIds))._yay!;
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

	test("a conflicting selected file keeps unrelated top items out of its queue", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "tops", folderCount: 200, filesPerFolder: 1 });
		const archived = await archive(f, tree.fileIds);
		if (archived._yay) await run_to_end(f, archived._yay);
		// A clash pauses the step before the selected file lands.
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
		expect(await count_queue(f, opId)).toBe(1);
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

		test("an archived read-only parent does not block leaving Trash", async () => {
			const f = await fixture();
			const tree = await seed_tree(f, { name: "ro-archived", folderCount: 1, filesPerFolder: 2 });
			expect(await archive(f, [tree.fileIds[0]!])).toEqual({ _yay: null });
			await archive_to_end(f, tree.folderIds[0]!);
			await lock({ f, nodeId: tree.folderIds[0]!, locked: true });

			expect(await restore(f, [tree.fileIds[0]!])).toEqual({ _yay: null });
			// The file comes back in a new `/ro-archived/d0`. The old folder stays in Trash with its flag.
			expect(await read_node(f, tree.fileIds[0]!)).toMatchObject({
				archiveOperationId: null,
				path: "/ro-archived/d0/f000.md",
			});
			expect(await read_node(f, tree.folderIds[0]!)).toMatchObject({ readOnly: true });
			expect((await read_node(f, tree.folderIds[0]!)).archiveOperationId).not.toBeNull();
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
