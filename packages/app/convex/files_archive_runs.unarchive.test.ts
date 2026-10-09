import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { test_finish_transfer_run, test_move_nodes, test_mocks } from "./setup.test.ts";
import { files_subtree_ops_db_delete, files_subtree_ops_db_insert } from "./files_subtree_ops.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";
import {
	fixture,
	type Fixture,
	add_member,
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
	lock_archived,
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

	test("restores many files with the same name in different folders", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "repeated", folderCount: 551, filesPerFolder: 1 });
		await archive_to_end(f, tree.topId);

		const restored = await restore(f, [tree.topId]);
		expect(restored._nay).toBeUndefined();
		const ended = await run_to_end(f, restored._yay!);
		expect(ended.activity.status).toBe("succeeded");
		expect((await read_state(f)).nodes.every((node) => node.archiveOperationId === null)).toBe(true);
	}, 120_000);

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
		const tree = await seed_tree(f, { name: "twice", folderCount: 4, filesPerFolder: 100 });
		await archive_to_end(f, tree.topId);

		const restored = await restore(f, [tree.topId]);
		expect(restored._yay).not.toBeNull();
		const again = await restore(f, [tree.fileIds.at(-1)!]);
		expect(again._nay?.name).toBe("busy");
	});

	test("the check reads up to 500 more items of the operation with the path where a page ends", async () => {
		const f = await fixture();
		const fits = await seed_same_path(f, { name: "fits", count: 550, archiveOperationId: crypto.randomUUID() });
		const tooMany = await seed_same_path(f, { name: "too-many", count: 551, archiveOperationId: crypto.randomUUID() });

		// The files share one name, so after the first one the job waits for a clash choice. The check
		// has passed by then.
		const restored = await restore(f, [fits.fileIds[0]!]);
		expect(restored._nay).toBeUndefined();
		const ended = await run_to_end(f, restored._yay!);
		expect(ended.activity.status).toBe("awaiting_input");

		const refused = await restore(f, [tooMany.fileIds[0]!]);
		expect(refused._nay).toBeUndefined();
		const failed = await run_to_end(f, refused._yay!);
		expect(failed.activity).toMatchObject({
			status: "failed",
			errorMessage: "Too many archived items share one path.",
		});
		expect((await read_node(f, tooMany.fileIds[0]!)).archiveOperationId).not.toBeNull();
	});

	test("restoring several big operations runs one job at a time, and a queued job has no card and no Stop", async () => {
		const f = await fixture();
		const trees = [];
		for (const name of ["q1", "q2", "q3"]) {
			const tree = await seed_tree(f, { name, folderCount: 2, filesPerFolder: 100 });
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
			const tree = await seed_tree(f, { name, folderCount: 2, filesPerFolder: 100 });
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
		const f = await fixture();
		const tree = await seed_tree(f, { name: "drain", folderCount: 6, filesPerFolder: 100 });
		await archive_to_end(f, tree.topId);
		const job = (await restore(f, [tree.topId]))._yay!;
		let run = (await f.t.run((ctx) => ctx.db.get("files_archive_runs", job.runId)))!;
		while (run.phase !== "apply") run = (await step(f, job.runId))!;
		const opId = await queue_empty_folders_first({ f, runId: job.runId, archiveOperationId: null });

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

	test("a step that already read a page of its discovery leaves a group with one name and time to the next step", async () => {
		const f = await fixture();
		// The operation has 62 items, so discovery needs a second page in the first scheduled step.
		const tree = await seed_tree(f, { name: "tie", folderCount: 1, filesPerFolder: 60 });
		const folderPath = "/tie/d0";
		// Somebody replaced `old.md` 120 times, and each old one kept its own archive. All of them got one
		// creation time: see "reads every child of a group that shares a name and a creation time" in
		// `files_subtree_ops.test.ts`.
		const now = Date.now();
		vi.setSystemTime(8.64e15);
		await f.t.run(async (ctx) => {
			for (let index = 0; index < 120; index++) {
				await ctx.db.insert("files_nodes", {
					...test_mocks.files.base(),
					organizationId: f.db.organizationId,
					workspaceId: f.db.workspaceId,
					createdBy: f.db.userId,
					updatedBy: f.db.userId,
					parentId: tree.folderIds[0]!,
					name: "old.md",
					sortName: files_sort_text_key("old.md"),
					kind: "file",
					path: `${folderPath}/old.md`,
					treePath: `${folderPath}/old.md`,
					pathDepth: 3,
					archiveOperationId: `replace-${index}`,
				});
			}
		});
		vi.setSystemTime(now);
		expect(
			new Set((await read_state(f)).nodes.filter((node) => node.name === "old.md").map((node) => node._creationTime)),
		).toEqual(new Set([8.64e15]));

		const archived = await archive(f, [tree.topId]);
		if (archived._yay) await run_to_end(f, archived._yay);
		const job = (await restore(f, [tree.topId]))._yay!;
		expect((await run_to_end(f, job)).activity.status).toBe("succeeded");

		const nodes = (await read_state(f)).nodes;
		expect(nodes.filter((node) => node.name !== "old.md" && node.archiveOperationId !== null)).toEqual([]);
		expect(nodes.filter((node) => node.name === "old.md" && !node.archiveOperationId?.startsWith("replace-"))).toEqual(
			[],
		);
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

	describe("name clashes", () => {
		/**
		 * Archive two files in `/clash/d0`, move two new files with the same names into that folder, and
		 * start restoring the first file. The restore waits on the first clash.
		 */
		async function seed_clash(f: Fixture) {
			const tree = await seed_tree(f, { name: "clash", folderCount: 1, filesPerFolder: 2 });
			expect(await archive(f, [tree.fileIds[0]!, tree.fileIds[1]!])).toEqual({ _yay: null });
			const occupants = await seed_tree(f, { name: "occupants", folderCount: 1, filesPerFolder: 2 });
			// Move the new files next to the archived ones, so both names are taken.
			expect(
				await test_move_nodes(f.t, f.asOwner, {
					membershipId: f.db.membershipId,
					itemIds: occupants.fileIds,
					targetParentId: tree.folderIds[0]!,
				}),
			).toEqual({ _yay: null });
			const restored = await restore(f, [tree.fileIds[0]!]);
			expect(restored._nay).toBeUndefined();
			return { tree, occupants, job: restored._yay! };
		}

		async function read_run(f: Fixture, runId: Id<"files_archive_runs">) {
			return (await f.t.run((ctx) => ctx.db.get("files_archive_runs", runId)))!;
		}

		async function resolve(args: {
			f: Fixture;
			runId: Id<"files_archive_runs">;
			choice: "keep_both" | "skip" | "replace";
			applyToRemaining?: { file: null | "keep_both" | "skip" | "replace"; folder: null | "keep_both" | "skip" };
		}) {
			const {
				f,
				runId,
				applyToRemaining = {
					file: null,
					folder: null,
				},
				choice,
			} = args;

			const run = await read_run(f, runId);
			return await f.asOwner.mutation(api.files_archive_runs.resolve_conflicts, {
				membershipId: f.db.membershipId,
				runId,
				revision: run.revision,
				choice,
				applyToRemaining,
			});
		}

		/**
		 * Run steps until `nodeId` is back.
		 */
		async function step_until_restored(args: {
			f: Fixture;
			runId: Id<"files_archive_runs">;
			nodeId: Id<"files_nodes">;
		}) {
			const { f, runId, nodeId } = args;

			for (let count = 0; (await read_node(f, nodeId)).archiveOperationId !== null; count++) {
				if (count === 20) throw new Error("The node did not come back");
				await step(f, runId);
			}
		}

		/**
		 * Archive `/inside` with two folders of 100 files and restore it until `/inside/d1` is back, before
		 * its files. Then move new files with the names in `names` into d1. The restore waits on the first
		 * clash inside d1.
		 */
		async function seed_clash_inside(f: Fixture, names: string[]) {
			const tree = await seed_tree(f, { name: "inside", folderCount: 2, filesPerFolder: 100 });
			await archive_to_end(f, tree.topId);
			const job = (await restore(f, [tree.topId]))._yay!;
			await step_until_restored({ f, runId: job.runId, nodeId: tree.folderIds[1]! });
			expect((await read_node(f, tree.fileIds[100]!)).archiveOperationId).not.toBeNull();

			const occupants = await seed_tree(f, { name: "occupants", folderCount: 1, filesPerFolder: 100 });
			const occupantIds = names.map((name) => occupants.fileIds[Number(name.slice(1, 4))]!);
			expect(
				await test_move_nodes(f.t, f.asOwner, {
					membershipId: f.db.membershipId,
					itemIds: occupantIds,
					targetParentId: tree.folderIds[1]!,
				}),
			).toEqual({ _yay: null });
			expect((await run_to_end(f, job)).activity.status).toBe("awaiting_input");
			return { tree, occupantIds, job };
		}

		test("waits for a choice and changes nothing until then", async () => {
			const f = await fixture();
			const { tree, occupants, job } = await seed_clash(f);

			expect((await read_activity(f, job.activityId)).status).toBe("awaiting_input");
			expect((await read_run(f, job.runId)).conflict).toEqual({
				nodeId: tree.fileIds[0],
				occupantId: occupants.fileIds[0],
			});
			expect((await read_node(f, tree.fileIds[0]!)).archiveOperationId).not.toBeNull();
			// A step scheduled before the pause does nothing.
			await step(f, job.runId);
			const activity = await read_activity(f, job.activityId);
			expect(activity.status).toBe("awaiting_input");
			// A paused job waits as long as a paused paste.
			expect(activity.deadlineAt - activity.updatedAt).toBe(24 * 60 * 60 * 1000);
		});

		test("hides the clash names once the person can no longer read the items", async () => {
			const f = await fixture();
			const member = await add_member(f);
			const tree = await seed_tree(f, { name: "secret", folderCount: 1, filesPerFolder: 1 });
			expect(await archive(f, [tree.fileIds[0]!])).toEqual({ _yay: null });
			const occupants = await seed_tree(f, { name: "occupants", folderCount: 1, filesPerFolder: 1 });
			expect(
				await test_move_nodes(f.t, f.asOwner, {
					membershipId: f.db.membershipId,
					itemIds: occupants.fileIds,
					targetParentId: tree.folderIds[0]!,
				}),
			).toEqual({ _yay: null });
			const restored = await member.asUser.mutation(api.files_nodes.unarchive_nodes, {
				membershipId: member.membershipId,
				nodeIds: [tree.fileIds[0]!],
			});
			const job = restored._yay!;

			expect(
				(
					await f.asOwner.mutation(api.files_sharing.restrict_node, {
						membershipId: f.db.membershipId,
						nodeId: tree.folderIds[0]!,
					})
				)._nay,
			).toBeUndefined();

			const view = await member.asUser.query(api.files_archive_runs.get, {
				membershipId: member.membershipId,
				runId: job.runId,
			});
			expect(view?.conflict).toMatchObject({ name: null, path: null, occupantPath: null });
			expect(JSON.stringify(view)).not.toContain("f000");
		});

		test("Keep both restores the item under a new name", async () => {
			const f = await fixture();
			const { tree, job } = await seed_clash(f);

			expect(await resolve({ f, runId: job.runId, choice: "keep_both" })).toEqual({ _yay: null });
			expect((await read_activity(f, job.activityId)).status).toBe("running");
			const ended = await run_to_end(f, job);

			expect(ended.activity.status).toBe("awaiting_input");
			expect(await read_node(f, tree.fileIds[0]!)).toMatchObject({
				archiveOperationId: null,
				name: "f000-2.md",
				path: "/clash/d0/f000-2.md",
			});
		});

		test("Apply to remaining answers the next clash too", async () => {
			const f = await fixture();
			const { tree, job } = await seed_clash(f);

			expect(
				await resolve({
					f,
					runId: job.runId,
					choice: "keep_both",
					applyToRemaining: { file: "keep_both", folder: null },
				}),
			).toEqual({ _yay: null });
			const ended = await run_to_end(f, job);

			expect(ended.activity.status).toBe("succeeded");
			expect((await read_node(f, tree.fileIds[1]!)).name).toBe("f001-2.md");
		});

		test("Skip leaves the item archived", async () => {
			const f = await fixture();
			const { tree, job } = await seed_clash(f);

			expect(
				await resolve({ f, runId: job.runId, choice: "skip", applyToRemaining: { file: "skip", folder: null } }),
			).toEqual({ _yay: null });
			const ended = await run_to_end(f, job);

			expect(ended.activity.status).toBe("succeeded");
			expect(ended.activity.progress).toMatchObject({ completed: 0, skipped: 2 });
			const skipped = await read_node(f, tree.fileIds[0]!);
			expect(skipped.archiveOperationId).toBe((await read_run(f, job.runId)).skipOperationId);
		});

		test("a pull that finds only the top items it queued before in the step fails instead of repeating", async () => {
			const f = await fixture();
			const { job } = await seed_clash(f);
			// No real flow does this. A Skip that keeps the operation id leaves both files in the operation,
			// so every pull finds the same top items again.
			await f.t.run(async (ctx) => {
				const run = (await ctx.db.get("files_archive_runs", job.runId))!;
				await ctx.db.patch("files_archive_runs", job.runId, { skipOperationId: run.archiveOperationId });
			});
			expect(
				await resolve({ f, runId: job.runId, choice: "skip", applyToRemaining: { file: "skip", folder: null } }),
			).toEqual({ _yay: null });

			await expect(step(f, job.runId)).rejects.toThrow("Restore pull found no new top item");
		});

		test("Replace archives the item in the way and never deletes it", async () => {
			const f = await fixture();
			const { tree, occupants, job } = await seed_clash(f);

			expect(
				await resolve({ f, runId: job.runId, choice: "replace", applyToRemaining: { file: "replace", folder: null } }),
			).toEqual({ _yay: null });
			const ended = await run_to_end(f, job);

			expect(ended.activity.status).toBe("succeeded");
			expect(await read_node(f, tree.fileIds[0]!)).toMatchObject({
				archiveOperationId: null,
				path: "/clash/d0/f000.md",
			});
			const replaced = await read_node(f, occupants.fileIds[0]!);
			expect(replaced.archiveOperationId).not.toBeNull();
			expect(replaced.archiveOperationId).not.toBe((await read_node(f, occupants.fileIds[1]!)).archiveOperationId);
		});

		test("Replace counts the item it archives in the step budget", async () => {
			const f = await fixture();
			const tree = await seed_tree(f, { name: "budget", folderCount: 1, filesPerFolder: 100 });
			const archived = await archive(f, tree.fileIds);
			expect(archived._nay).toBeUndefined();
			if (archived._yay) await run_to_end(f, archived._yay);
			const occupants = await seed_tree(f, { name: "occupants", folderCount: 1, filesPerFolder: 100 });
			expect(
				await test_move_nodes(f.t, f.asOwner, {
					membershipId: f.db.membershipId,
					itemIds: occupants.fileIds,
					targetParentId: tree.folderIds[0]!,
				}),
			).toEqual({ _yay: null });
			const restored = await restore(f, [tree.fileIds[0]!]);
			const job = restored._yay!;

			expect((await run_to_end(f, job)).activity.status).toBe("awaiting_input");
			expect(
				await resolve({ f, runId: job.runId, choice: "replace", applyToRemaining: { file: "replace", folder: null } }),
			).toEqual({ _yay: null });
			await step(f, job.runId);

			// A step may change 75 nodes. Each Replace changes two: the restored file and the one in the way.
			expect((await read_activity(f, job.activityId)).progress!.completed).toBe(38);
			const ended = await run_to_end(f, job);
			expect(ended.activity.status).toBe("succeeded");
			expect(ended.activity.progress).toMatchObject({ completed: 100 });
		});

		test("a file made in a restored folder before its own file comes back asks, and Keep both keeps both", async () => {
			const f = await fixture();
			const { tree, occupantIds, job } = await seed_clash_inside(f, ["f050.md"]);

			expect((await read_run(f, job.runId)).conflict).toEqual({
				nodeId: tree.fileIds[150],
				occupantId: occupantIds[0],
			});
			expect(
				(await f.asOwner.query(api.files_archive_runs.get, { membershipId: f.db.membershipId, runId: job.runId }))
					?.conflict,
			).toMatchObject({ kind: "file", name: "f050.md", occupantPath: "/inside/d1/f050.md", canReplace: true });

			expect(await resolve({ f, runId: job.runId, choice: "keep_both" })).toEqual({ _yay: null });
			const ended = await run_to_end(f, job);
			expect(ended.activity.status).toBe("succeeded");
			expect(ended.activity.progress).toMatchObject({ total: 203, completed: 203, skipped: 0 });
			expect(await read_node(f, tree.fileIds[150]!)).toMatchObject({
				archiveOperationId: null,
				path: "/inside/d1/f050-2.md",
			});
			expect(await read_node(f, occupantIds[0]!)).toMatchObject({
				archiveOperationId: null,
				path: "/inside/d1/f050.md",
			});
		});

		test("Skip and Replace work for items inside a restored folder", async () => {
			const f = await fixture();
			const { tree, occupantIds, job } = await seed_clash_inside(f, ["f050.md", "f080.md"]);

			expect(await resolve({ f, runId: job.runId, choice: "skip" })).toEqual({ _yay: null });
			expect((await run_to_end(f, job)).activity.status).toBe("awaiting_input");
			expect((await read_run(f, job.runId)).conflict).toEqual({
				nodeId: tree.fileIds[180],
				occupantId: occupantIds[1],
			});
			expect(await resolve({ f, runId: job.runId, choice: "replace" })).toEqual({ _yay: null });
			const ended = await run_to_end(f, job);

			expect(ended.activity.status).toBe("succeeded");
			expect(ended.activity.progress).toMatchObject({ total: 203, completed: 202, skipped: 1 });
			expect((await read_node(f, tree.fileIds[150]!)).archiveOperationId).toBe(
				(await read_run(f, job.runId)).skipOperationId,
			);
			expect((await read_node(f, occupantIds[0]!)).archiveOperationId).toBeNull();
			expect(await read_node(f, tree.fileIds[180]!)).toMatchObject({
				archiveOperationId: null,
				path: "/inside/d1/f080.md",
			});
			expect((await read_node(f, occupantIds[1]!)).archiveOperationId).not.toBeNull();
		});

		test("Apply to remaining answers a later clash in the middle of a page, and each file comes back once", async () => {
			const f = await fixture();
			const { tree, job } = await seed_clash_inside(f, ["f050.md", "f080.md"]);

			expect(
				await resolve({
					f,
					runId: job.runId,
					choice: "keep_both",
					applyToRemaining: { file: "keep_both", folder: null },
				}),
			).toEqual({ _yay: null });
			const ended = await run_to_end(f, job);

			expect(ended.activity.status).toBe("succeeded");
			expect(ended.activity.progress).toMatchObject({ total: 203, completed: 203, skipped: 0 });
			expect((await read_node(f, tree.fileIds[180]!)).name).toBe("f080-2.md");
			const nodes = (await read_state(f)).nodes;
			expect(nodes.filter((node) => node.path.startsWith("/inside/")).length).toBe(204);
			expect(nodes.every((node) => node.archiveOperationId === null)).toBe(true);
		});

		test("a folder clash after folders this step restored queues each folder once", async () => {
			const f = await fixture();
			const tree = await seed_tree(f, { name: "many", folderCount: 200, filesPerFolder: 0 });
			await archive_to_end(f, tree.topId);
			const job = (await restore(f, [tree.topId]))._yay!;
			// A step restores 75 folders, so `d50` comes back in a later step, in the middle of a page.
			await step_until_restored({ f, runId: job.runId, nodeId: tree.topId });
			expect((await read_node(f, tree.folderIds[50]!)).archiveOperationId).not.toBeNull();
			const occupant = await folder(f, "/many/d50");

			expect((await run_to_end(f, job)).activity.status).toBe("awaiting_input");
			const queued = await f.t.run(async (ctx) => {
				const op = await ctx.db
					.query("files_subtree_ops")
					.withIndex("by_archiveRun", (q) => q.eq("archiveRunId", job.runId))
					.unique();
				return (
					await ctx.db
						.query("files_subtree_op_nodes")
						.withIndex("by_op_sequence", (q) => q.eq("opId", op!._id))
						.collect()
				).map((row) => row.nodeId);
			});
			expect(new Set(queued).size).toBe(queued.length);

			expect(await resolve({ f, runId: job.runId, choice: "keep_both" })).toEqual({ _yay: null });
			const ended = await run_to_end(f, job);
			expect(ended.activity.status).toBe("succeeded");
			expect(ended.activity.progress).toMatchObject({ total: 201, completed: 201, skipped: 0 });
			expect((await read_node(f, tree.folderIds[50]!)).path).toBe("/many/d50-2");
			expect((await read_node(f, occupant)).path).toBe("/many/d50");
		});

		test("the step after a choice lands the item before it walks the folders its page restored", async () => {
			const f = await fixture();
			const tree = await seed_tree(f, { name: "many", folderCount: 200, filesPerFolder: 1 });
			await archive_to_end(f, tree.topId);
			const job = (await restore(f, [tree.topId]))._yay!;
			await step_until_restored({ f, runId: job.runId, nodeId: tree.topId });
			await folder(f, "/many/d50");
			expect((await run_to_end(f, job)).activity.status).toBe("awaiting_input");
			expect((await read_run(f, job.runId)).conflict?.nodeId).toBe(tree.folderIds[50]);

			// A folder the paused step restored waits in the queue with its file. Put an item with that name there.
			const queuedId = await f.t.run(async (ctx) => {
				const op = await ctx.db
					.query("files_subtree_ops")
					.withIndex("by_archiveRun", (q) => q.eq("archiveRunId", job.runId))
					.unique();
				const rows = await ctx.db
					.query("files_subtree_op_nodes")
					.withIndex("by_op_sequence", (q) => q.eq("opId", op!._id))
					.collect();
				return rows.find((row) => row.nodeId !== tree.topId)!.nodeId;
			});
			const queuedFileId = tree.fileIds[tree.folderIds.indexOf(queuedId)]!;
			expect((await read_node(f, queuedFileId)).archiveOperationId).not.toBeNull();
			const occupants = await seed_tree(f, { name: "occupants", folderCount: 1, filesPerFolder: 1 });
			expect(
				await test_move_nodes(f.t, f.asOwner, {
					membershipId: f.db.membershipId,
					itemIds: occupants.fileIds,
					targetParentId: queuedId,
				}),
			).toEqual({ _yay: null });

			// A choice counts only until the next clash. So `d50` must come back before that clash asks.
			expect(await resolve({ f, runId: job.runId, choice: "keep_both" })).toEqual({ _yay: null });
			expect((await run_to_end(f, job)).activity.status).toBe("awaiting_input");
			expect(await read_node(f, tree.folderIds[50]!)).toMatchObject({ archiveOperationId: null, path: "/many/d50-2" });
			expect((await read_run(f, job.runId)).conflict?.nodeId).toBe(queuedFileId);

			expect(await resolve({ f, runId: job.runId, choice: "keep_both" })).toEqual({ _yay: null });
			const ended = await run_to_end(f, job);
			expect(ended.activity.status).toBe("succeeded");
			expect(ended.activity.progress).toMatchObject({ total: 401, completed: 401, skipped: 0 });
		});

		test("archived items with one name inside a restored folder ask when the second comes back", async () => {
			const f = await fixture();
			const operationId = crypto.randomUUID();
			const same = await seed_same_path(f, { name: "same", count: 3, archiveOperationId: operationId });
			await f.t.run((ctx) => ctx.db.patch("files_nodes", same.topId, { archiveOperationId: operationId }));

			const restored = await restore(f, [same.topId]);
			await expect_consistent(f);
			const job = restored._yay!;
			expect((await read_activity(f, job.activityId)).status).toBe("awaiting_input");
			expect(
				await resolve({
					f,
					runId: job.runId,
					choice: "keep_both",
					applyToRemaining: { file: "keep_both", folder: null },
				}),
			).toEqual({ _yay: null });
			expect((await run_to_end(f, job)).activity.status).toBe("succeeded");

			const names = await Promise.all(same.fileIds.map(async (fileId) => (await read_node(f, fileId)).name));
			expect(names.toSorted()).toEqual(["same-2.md", "same-3.md", "same.md"]);
		});

		test("refuses a choice for a clash that changed", async () => {
			const f = await fixture();
			const { job } = await seed_clash(f);
			const run = await read_run(f, job.runId);

			const refused = await f.asOwner.mutation(api.files_archive_runs.resolve_conflicts, {
				membershipId: f.db.membershipId,
				runId: job.runId,
				revision: run.revision - 1,
				choice: "skip",
				applyToRemaining: { file: null, folder: null },
			});
			expect(refused._nay?.message).toBe("The conflicts changed. Review them again.");
		});

		test("Replace asks again when the folder in the way gets an archived read-only item", async () => {
			const f = await fixture();
			const tree = await seed_tree(f, { name: "hidden", folderCount: 1, filesPerFolder: 1 });
			expect(await archive(f, [tree.folderIds[0]!])).toEqual({ _yay: null });
			const occupant = await folder(f, "/hidden/d0");
			const inside = await folder(f, "/hidden/d0/kept");
			expect(await archive(f, [inside])).toEqual({ _yay: null });

			const restored = await restore(f, [tree.folderIds[0]!]);
			const job = restored._yay!;
			expect(await resolve({ f, runId: job.runId, choice: "replace" })).toEqual({ _yay: null });
			// The lock comes after the choice.
			await lock_archived(f, inside);
			await step(f, job.runId);

			// Replace would hide the read-only item inside an archived folder.
			expect((await read_activity(f, job.activityId)).status).toBe("awaiting_input");
			const shown = await f.asOwner.query(api.files_archive_runs.get, {
				membershipId: f.db.membershipId,
				runId: job.runId,
			});
			expect(shown?.conflict?.canReplace).toBe(false);
			expect((await read_node(f, occupant)).archiveOperationId).toBeNull();
			expect((await read_node(f, tree.folderIds[0]!)).archiveOperationId).not.toBeNull();
		});

		test("a node kept archived with its skipped folder must still be writable", async () => {
			const f = await fixture();
			const tree = await seed_tree(f, { name: "tag", folderCount: 1, filesPerFolder: 2 });
			expect(await archive(f, [tree.folderIds[0]!])).toEqual({ _yay: null });
			const operationId = (await read_node(f, tree.fileIds[0]!)).archiveOperationId;
			await folder(f, "/tag/d0");
			const restored = await restore(f, [tree.folderIds[0]!]);
			const job = restored._yay!;
			// The check before the pause already passed. The lock comes while the job waits.
			await lock_archived(f, tree.fileIds[0]!);

			expect(await resolve({ f, runId: job.runId, choice: "skip" })).toEqual({ _yay: null });
			await step(f, job.runId);

			expect((await read_activity(f, job.activityId)).status).toBe("failed");
			expect((await read_node(f, tree.fileIds[0]!)).archiveOperationId).toBe(operationId);
			await expect_consistent(f);
		});

		test("Replace of a folder that still has items is refused", async () => {
			const f = await fixture();
			const tree = await seed_tree(f, { name: "folders", folderCount: 1, filesPerFolder: 1 });
			expect(await archive(f, [tree.folderIds[0]!])).toEqual({ _yay: null });
			await folder(f, "/folders/d0/kept");

			const restored = await restore(f, [tree.folderIds[0]!]);
			const job = restored._yay!;
			const run = await read_run(f, job.runId);
			const shown = await f.asOwner.query(api.files_archive_runs.get, {
				membershipId: f.db.membershipId,
				runId: job.runId,
			});
			expect(shown?.conflict?.canReplace).toBe(false);
			expect((await resolve({ f, runId: job.runId, choice: "replace" }))._nay?.message).toBe(
				"Replace needs the same kind, an empty folder, and write access to the item in the way and everything inside it.",
			);

			expect((await read_activity(f, job.activityId)).status).toBe("awaiting_input");
			expect((await read_run(f, job.runId)).revision).toBe(run.revision);
		});

		test("Replace is not offered when the folder in the way holds more than 500 items", async () => {
			const f = await fixture();
			const tree = await seed_tree(f, { name: "wide", folderCount: 1, filesPerFolder: 1 });
			expect(await archive(f, [tree.topId])).toEqual({ _yay: null });
			// A new `/wide` with 501 archived items inside and no active child.
			const occupantTree = await seed_tree(f, { name: "wide", folderCount: 1, filesPerFolder: 500 });
			await archive_to_end(f, occupantTree.folderIds[0]!);

			const restored = await restore(f, [tree.topId]);
			const shown = await f.asOwner.query(api.files_archive_runs.get, {
				membershipId: f.db.membershipId,
				runId: restored._yay!.runId,
			});

			expect(shown?.conflict?.canReplace).toBe(false);
		});

		test("a refused restore keeps the item a Replace would archive", async () => {
			const f = await fixture();
			const tree = await seed_tree(f, { name: "keep", folderCount: 1, filesPerFolder: 1 });
			expect(await archive(f, [tree.folderIds[0]!])).toEqual({ _yay: null });
			const occupant = await folder(f, "/keep/d0");

			const restored = await restore(f, [tree.folderIds[0]!]);
			const job = restored._yay!;
			expect(await resolve({ f, runId: job.runId, choice: "replace" })).toEqual({ _yay: null });
			// The lock comes after the choice, so the restore of `d0` is refused when the step runs.
			await lock_archived(f, tree.folderIds[0]!);
			await step(f, job.runId);

			expect((await read_activity(f, job.activityId)).status).toBe("failed");
			expect((await read_node(f, occupant)).archiveOperationId).toBeNull();
			expect((await read_node(f, tree.folderIds[0]!)).archiveOperationId).not.toBeNull();
			await expect_consistent(f);
		});

		test("Replace of a folder that gets items after the choice asks again", async () => {
			const f = await fixture();
			const tree = await seed_tree(f, { name: "folders", folderCount: 1, filesPerFolder: 1 });
			expect(await archive(f, [tree.folderIds[0]!])).toEqual({ _yay: null });
			await folder(f, "/folders/d0");

			const restored = await restore(f, [tree.folderIds[0]!]);
			const job = restored._yay!;
			const run = await read_run(f, job.runId);
			expect(await resolve({ f, runId: job.runId, choice: "replace" })).toEqual({ _yay: null });
			await folder(f, "/folders/d0/kept");
			await step(f, job.runId);

			expect((await read_activity(f, job.activityId)).status).toBe("awaiting_input");
			expect((await read_run(f, job.runId)).revision).toBe(run.revision + 1);
			expect((await read_node(f, tree.folderIds[0]!)).archiveOperationId).not.toBeNull();
		});
	});
});
