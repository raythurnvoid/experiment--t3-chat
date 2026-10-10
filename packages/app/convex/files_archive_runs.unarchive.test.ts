import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { test_finish_transfer_run, test_move_nodes } from "./setup.test.ts";
import { files_subtree_ops_db_delete, files_subtree_ops_db_insert } from "./files_subtree_ops.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";
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
	folder,
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
	test("a restore waits for a job on its second root", async () => {
		const f = await fixture();
		const first = await seed_tree(f, { name: "a", folderCount: 1, filesPerFolder: 1 });
		const second = await seed_tree(f, { name: "b", folderCount: 1, filesPerFolder: 1 });
		expect(await archive(f, [first.fileIds[0]!, second.fileIds[0]!])).toEqual({ _yay: null });
		const blockerId = await f.t.run((ctx) =>
			files_subtree_ops_db_insert(ctx, {
				op: {
					kind: "scope",
					organizationId: f.db.organizationId,
					workspaceId: f.db.workspaceId,
					userId: f.db.userId,
					status: "running",
					blockedByOpId: null,
					rootNodeIds: [second.topId],
					treePaths: ["/b/"],
				},
				now: Date.now(),
			}),
		);

		const restored = await restore(f, [first.fileIds[0]!]);
		expect(restored._nay).toBeUndefined();
		expect(restored._yay).not.toBeNull();
		const op = await f.t.run((ctx) =>
			ctx.db
				.query("files_subtree_ops")
				.withIndex("by_archiveRun", (q) => q.eq("archiveRunId", restored._yay!.runId))
				.unique(),
		);
		expect(op).toMatchObject({ kind: "restore", status: "queued", blockedByOpId: blockerId });
		expect((await read_activity(f, restored._yay!.activityId)).feedVisible).toBe(false);
		expect((await read_node(f, first.fileIds[0]!)).archiveOperationId).not.toBeNull();
		expect((await read_node(f, second.fileIds[0]!)).archiveOperationId).not.toBeNull();

		await f.t.run((ctx) => files_subtree_ops_db_delete(ctx, { opId: blockerId, now: Date.now() }));
		const ended = await run_to_end(f, restored._yay!);
		expect(ended.activity.status).toBe("succeeded");
		expect((await read_node(f, first.fileIds[0]!)).archiveOperationId).toBeNull();
		expect((await read_node(f, second.fileIds[0]!)).archiveOperationId).toBeNull();
	});

	test("discovery finds a stored-path change before its cursor", async () => {
		const f = await fixture();
		const archived = await seed_same_path(f, { name: "cursor", count: 51, archiveOperationId: crypto.randomUUID() });
		const restored = await restore(f, [archived.fileIds[0]!]);
		expect(restored._nay).toBeUndefined();
		expect((await f.t.run((ctx) => ctx.db.get("files_archive_runs", restored._yay!.runId)))?.phase).toBe("discover");
		// Cursor seam only. Public Rename waits for Restore.
		await f.t.run((ctx) =>
			ctx.db.patch("files_nodes", archived.fileIds.at(-1)!, {
				name: "a.md",
				sortName: files_sort_text_key("a.md"),
				path: "/cursor/a.md",
				treePath: "/cursor/a.md",
			}),
		);
		expect((await read_node(f, archived.fileIds.at(-1)!)).treePath).toBe("/cursor/a.md");
		const blockerId = await f.t.run((ctx) =>
			files_subtree_ops_db_insert(ctx, {
				op: {
					kind: "scope",
					organizationId: f.db.organizationId,
					workspaceId: f.db.workspaceId,
					userId: f.db.userId,
					status: "running",
					blockedByOpId: null,
					rootNodeIds: [archived.fileIds.at(-1)!],
					treePaths: ["/cursor/a.md"],
				},
				now: Date.now(),
			}),
		);

		await step(f, restored._yay!.runId);
		const op = await f.t.run((ctx) =>
			ctx.db
				.query("files_subtree_ops")
				.withIndex("by_archiveRun", (q) => q.eq("archiveRunId", restored._yay!.runId))
				.unique(),
		);
		expect(op?.treePaths).toContain("/cursor/a.md");
		expect(op).toMatchObject({ status: "queued", blockedByOpId: blockerId });
	});

	test("a queued restore checks a stored-path change while it waited", async () => {
		const f = await fixture();
		const archived = await seed_same_path(f, { name: "queued", count: 51, archiveOperationId: crypto.randomUUID() });
		const blocker = (treePath: string) =>
			f.t.run((ctx) =>
				files_subtree_ops_db_insert(ctx, {
					op: {
						kind: "scope",
						organizationId: f.db.organizationId,
						workspaceId: f.db.workspaceId,
						userId: f.db.userId,
						status: "running",
						blockedByOpId: null,
						rootNodeIds: [archived.fileIds[0]!],
						treePaths: [treePath],
					},
					now: Date.now(),
				}),
			);
		const restored = await restore(f, [archived.fileIds[0]!]);
		expect(restored._nay).toBeUndefined();
		expect((await f.t.run((ctx) => ctx.db.get("files_archive_runs", restored._yay!.runId)))?.phase).toBe("discover");
		const firstBlockerId = await blocker("/queued/same.md");
		await step(f, restored._yay!.runId);
		const opId = await f.t.run(
			async (ctx) =>
				(await ctx.db
					.query("files_subtree_ops")
					.withIndex("by_archiveRun", (q) => q.eq("archiveRunId", restored._yay!.runId))
					.unique())!._id,
		);
		expect(await f.t.run((ctx) => ctx.db.get("files_subtree_ops", opId))).toMatchObject({
			status: "queued",
			blockedByOpId: firstBlockerId,
		});
		// Cursor seam only. Public Rename waits for the scope blocker.
		await f.t.run((ctx) =>
			ctx.db.patch("files_nodes", archived.fileIds[1]!, {
				name: "a.md",
				sortName: files_sort_text_key("a.md"),
				path: "/queued/a.md",
				treePath: "/queued/a.md",
			}),
		);
		expect((await f.t.run((ctx) => ctx.db.get("files_subtree_ops", opId)))?.treePaths).not.toContain("/queued/a.md");
		const secondBlockerId = await blocker("/queued/a.md");
		await f.t.run((ctx) => files_subtree_ops_db_delete(ctx, { opId: firstBlockerId, now: Date.now() }));
		expect((await f.t.run((ctx) => ctx.db.get("files_subtree_ops", opId)))?.blockedByOpId).toBeNull();
		await f.t.mutation(internal.files_subtree_ops.promote, { opId });
		for (let count = 0; count < 3; count++) {
			const op = await f.t.run((ctx) => ctx.db.get("files_subtree_ops", opId));
			if (op?.status !== "running") break;
			await step(f, restored._yay!.runId);
		}

		const op = await f.t.run((ctx) => ctx.db.get("files_subtree_ops", opId));
		expect(op).toMatchObject({ status: "queued", blockedByOpId: secondBlockerId });
		expect(op?.treePaths).toContain("/queued/a.md");
		expect((await read_node(f, archived.fileIds[0]!)).archiveOperationId).not.toBeNull();
	});

	// It takes about 10 s alone and more than 30 s while the full suite runs.
	test("a big restore runs as a job, and no node is ever active inside an archived folder", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "back", folderCount: 6, filesPerFolder: 100 });
		await archive_to_end(f, tree.topId);

		const restored = await restore(f, [tree.fileIds[250]!]);
		expect(restored._nay).toBeUndefined();
		const ended = await run_to_end(f, restored._yay!);

		expect(ended.activity).toMatchObject({ status: "succeeded", title: "Restore files" });
		expect(ended.activity.progress).toMatchObject({ total: 607, completed: 607 });
		const state = await read_state(f);
		expect(state.nodes.every((node) => node.archiveOperationId === null)).toBe(true);
		expect((await read_node(f, tree.fileIds[0]!)).path).toBe("/back/d0/f000.md");
	}, 60_000);

	test("a public Move waits for Restore and then moves every child", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "moving", folderCount: 2, filesPerFolder: 40 });
		await archive_to_end(f, tree.topId);
		const target = await folder(f, "/target");

		const restored = await restore(f, [tree.topId]);
		const job = restored._yay!;
		for (let count = 0; count < 30 && (await read_node(f, tree.topId)).archiveOperationId !== null; count++) {
			await step(f, job.runId);
		}
		expect((await read_node(f, tree.topId)).archiveOperationId).toBeNull();
		const moved = await f.asOwner.mutation(api.files_transfer.start, {
			membershipId: f.db.membershipId,
			requestId: crypto.randomUUID(),
			kind: "move",
			sourceIds: [tree.topId],
			expectedSourceCount: 1,
			targetParentId: target,
		});
		expect(moved._nay).toBeUndefined();
		expect(
			await f.asOwner.mutation(api.files_transfer.seal, {
				membershipId: f.db.membershipId,
				runId: moved._yay!.runId,
			}),
		).toEqual({ _yay: null });
		for (let count = 0; count < 3; count++) {
			await f.t.mutation(internal.files_transfer.advance, { runId: moved._yay!.runId });
		}
		expect((await read_node(f, tree.topId)).path, "Move keeps the old name while Restore runs").toBe("/moving");
		expect((await f.t.run((ctx) => ctx.db.get("activities", moved._yay!.activityId)))?.progress?.completed).toBe(0);

		const ended = await run_to_end(f, job);
		expect(ended.activity.status).toBe("succeeded");
		await test_finish_transfer_run(f.asOwner, moved._yay!.runId);
		expect((await f.t.run((ctx) => ctx.db.get("activities", moved._yay!.activityId)))?.status).toBe("succeeded");
		expect((await read_node(f, tree.fileIds.at(-1)!)).path).toBe("/target/moving/d1/f039.md");
	}, 120_000);

	test("public Rename waits for Restore and checks the accepted source again", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "rename-wait", folderCount: 2, filesPerFolder: 40 });
		await archive_to_end(f, tree.topId);
		const restored = await restore(f, [tree.topId]);
		expect(restored._nay).toBeUndefined();
		const renamed = await f.asOwner.mutation(api.files_nodes.rename_node, {
			membershipId: f.db.membershipId,
			requestId: crypto.randomUUID(),
			nodeId: tree.fileIds[0]!,
			path: "a.md",
		});
		expect(renamed._nay).toBeUndefined();
		expect(renamed._yay).not.toBeNull();
		for (let count = 0; count < 3; count++) {
			await f.t.mutation(internal.files_transfer.advance, { runId: renamed._yay!.runId });
		}
		expect((await read_node(f, tree.fileIds[0]!)).path, "Rename keeps the old name while Restore runs")
			.toBe("/rename-wait/d0/f000.md");
		expect((await f.t.run((ctx) => ctx.db.get("activities", renamed._yay!.activityId)))?.progress?.completed).toBe(0);
		expect((await run_to_end(f, restored._yay!)).activity.status).toBe("succeeded");
		await test_finish_transfer_run(f.asOwner, renamed._yay!.runId);
		expect((await f.t.run((ctx) => ctx.db.get("activities", renamed._yay!.activityId)))?.status).toBe("awaiting_input");
		expect((await read_node(f, tree.fileIds[0]!)).path).toBe("/rename-wait/d0/f000.md");
	});

	test("refuses to restore an operation that a job is still restoring", async () => {
		const f = await fixture();
		// 76 items: more than one step of 75, so the archive and the restore are jobs.
		const tree = await seed_tree(f, { name: "twice", folderCount: 1, filesPerFolder: 74 });
		await archive_to_end(f, tree.topId);

		const restored = await restore(f, [tree.topId]);
		expect(restored._yay).not.toBeNull();
		const again = await restore(f, [tree.fileIds.at(-1)!]);
		expect(again._nay?.name).toBe("busy");
	});

	test("restoring several big operations runs one job at a time, and a queued job has no card and no Stop", async () => {
		const f = await fixture();
		const trees = [];
		for (const name of ["q1", "q2", "q3"]) {
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

		const restored = await restore(
			f,
			trees.map((tree) => tree.topId),
		);
		expect(restored._nay).toBeUndefined();
		expect(await read_statuses()).toEqual(["running", "queued", "queued"]);
		const [first, second, third] = await read_restore_jobs();
		expect((await read_activity(f, third!.activityId)).feedVisible).toBe(false);

		const stop = await f.asOwner.mutation(api.activities.request_stop, {
			membershipId: f.db.membershipId,
			activityId: third!.activityId,
		});
		expect(stop._nay).toBeDefined();
		expect(await read_statuses()).toEqual(["running", "queued", "queued"]);

		expect((await run_to_end(f, first!)).activity.status).toBe("succeeded");
		expect((await run_to_end(f, second!)).activity).toMatchObject({ status: "succeeded", feedVisible: true });
		expect((await run_to_end(f, third!)).activity.status).toBe("succeeded");

		const state = await expect_consistent(f);
		expect(state.nodes.filter((node) => node.archiveOperationId !== null)).toEqual([]);
	});

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
