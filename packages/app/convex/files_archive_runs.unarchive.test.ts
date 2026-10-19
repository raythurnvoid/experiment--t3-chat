// The later unarchive_nodes tests, from job order to read-only folders, are in
// files_archive_runs.unarchive_queue.test.ts, so the two files can run at the same time.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import { test_finish_transfer_run } from "./setup.test.ts";
import { files_subtree_ops_db_delete, files_subtree_ops_db_insert } from "./files_subtree_ops_db.ts";
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
	folder,
	read_node,
	archive_to_end,
} from "./files_archive_runs.setup.test.ts";

// A check step reads at most 100 nodes here instead of 500, and a request at most 50 instead of 100, so
// small trees cross them. The mock puts this file in the isolated "Convex" project.
vi.mock("../server/files-archive-runs.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../server/files-archive-runs.ts")>()),
	files_archive_runs_CHECK_STEP_MAX_NODES: 100,
	files_archive_runs_REQUEST_MAX_CHECK_NODES: 50,
}));

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

	test("a big restore runs as a job, and no node is ever active inside an archived folder", async () => {
		const f = await fixture();
		// 127 items: more than one check step of 100 and one apply step of 30.
		const tree = await seed_tree(f, { name: "back", folderCount: 6, filesPerFolder: 20 });
		await archive_to_end(f, tree.topId);

		const restored = await restore(f, [tree.fileIds[50]!]);
		expect(restored._nay).toBeUndefined();
		const ended = await run_to_end(f, restored._yay!);

		expect(ended.activity).toMatchObject({ status: "succeeded", title: "Restore files" });
		expect(ended.activity.progress).toMatchObject({ total: 127, completed: 127 });
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
		const moved = await f.asOwner.mutation(api.files_transfer.accept_input, {
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
		// 76 items: more than the 10 stamps of the request, so the archive and the restore are jobs.
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
			// 76 items: more than the 10 stamps of the request, so each archive and restore is a job.
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
});
