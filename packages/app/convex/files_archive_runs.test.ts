// The archive_nodes tests from a lock set after the check on, and the history cleanup tests, are in
// files_archive_runs.archive_steps.test.ts, so the two files can run at the same time.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import {
	fixture,
	seed_tree,
	read_state,
	expect_consistent,
	step,
	run_to_end,
	archive,
	restore,
	folder,
	read_node,
	lock_writer,
	add_member,
} from "./files_archive_runs.setup.test.ts";

// A check step reads at most 100 nodes here instead of 500, so small trees cross it. The mock puts this
// file in the isolated "Convex" project.
vi.mock("../server/files-archive-runs.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../server/files-archive-runs.ts")>()),
	files_archive_runs_CHECK_STEP_MAX_NODES: 100,
}));

// Scheduled steps never run on their own under fake timers. Each test drives the op's steps itself.
beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("archive_nodes", () => {
	test("a small archive finishes inside the request and writes no job", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "small", folderCount: 2, filesPerFolder: 3 });

		expect(await archive(f, [tree.topId])).toEqual({ _yay: null });

		const state = await expect_consistent(f);
		expect(new Set(state.nodes.map((node) => node.archiveOperationId)).size).toBe(1);
		expect(state.nodes.every((node) => node.archiveOperationId !== null)).toBe(true);
		expect(await f.t.run((ctx) => ctx.db.query("files_archive_runs").collect())).toEqual([]);
		expect(await f.t.run((ctx) => ctx.db.query("activities").collect())).toEqual([]);
		expect(await f.t.run((ctx) => ctx.db.query("files_subtree_ops").collect())).toEqual([]);
		expect(await f.t.run((ctx) => ctx.db.query("files_subtree_op_walks").collect())).toEqual([]);
		expect(await f.t.run((ctx) => ctx.db.query("files_subtree_op_nodes").collect())).toEqual([]);
	});

	test("a big archive runs as a job, and after every step the side docs match and no active node is inside a finished archive", async () => {
		const f = await fixture();
		// 247 items: more than one check step of 100, and more than 3 steps of 30 stamps.
		const tree = await seed_tree(f, { name: "big", folderCount: 6, filesPerFolder: 40 });

		const archived = await archive(f, [tree.topId]);
		expect(archived._nay).toBeUndefined();
		const ended = await run_to_end(f, archived._yay!);

		expect(ended.activity).toMatchObject({ status: "succeeded", title: "Archive files" });
		expect(ended.activity.progress).toMatchObject({ total: 247, completed: 247 });
		expect(ended.steps).toBeGreaterThan(3);
		const state = await read_state(f);
		const operationIds = new Set(state.nodes.map((node) => node.archiveOperationId));
		expect(operationIds.size).toBe(1);
		expect(operationIds.has(null)).toBe(false);
		expect(await f.t.run((ctx) => ctx.db.get("files_archive_runs", archived._yay!.runId))).toMatchObject({
			active: false,
		});
		expect(await f.t.run((ctx) => ctx.db.query("files_subtree_ops").collect())).toEqual([]);
	});

	test("a folder with no lock and no restricted folder inside leaves the tree in the request", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "first", folderCount: 6, filesPerFolder: 20 });

		const archived = await archive(f, [tree.topId]);
		const job = archived._yay!;
		// The indexes prove that the check of 127 nodes would pass, so the request stamps the folder. The
		// job stamps the files later.
		expect(job.waitingNodeIds).toEqual([]);
		expect((await read_node(f, tree.topId)).archiveOperationId).not.toBeNull();
		expect((await read_node(f, tree.fileIds.at(-1)!)).archiveOperationId).toBeNull();
		await expect_consistent(f);

		const ended = await run_to_end(f, job);
		expect(ended.activity.progress).toMatchObject({ total: 127, completed: 127, skipped: 0, blocked: 0 });
	});

	test("a folder the indexes cannot clear stays in the tree until the check passes", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "slow", folderCount: 6, filesPerFolder: 20 });
		await lock_writer({ f, nodeId: tree.fileIds.at(-1)!, userId: f.db.userId });

		const archived = await archive(f, [tree.topId]);
		const job = archived._yay!;
		// The check of 127 nodes does not fit in the 100 reads of the request, so nothing is stamped yet.
		expect(job.waitingNodeIds).toEqual([tree.topId]);
		expect(job.isChecking).toBe(true);
		expect((await read_node(f, tree.topId)).archiveOperationId).toBeNull();

		const ended = await run_to_end(f, job);
		expect(ended.activity.status).toBe("succeeded");
		expect((await read_node(f, tree.fileIds.at(-1)!)).archiveOperationId).not.toBeNull();
	});

	test("a folder created inside during the check is archived with the rest", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "grow", folderCount: 6, filesPerFolder: 20 });
		await lock_writer({ f, nodeId: tree.fileIds.at(-1)!, userId: f.db.userId });

		const archived = await archive(f, [tree.topId]);
		const job = archived._yay!;
		// The writer list makes the job check first, so `d0` is still active here.
		expect((await read_node(f, tree.folderIds[0]!)).archiveOperationId).toBeNull();
		const created = await folder(f, "/grow/d0/new");

		const ended = await run_to_end(f, job);
		expect(ended.activity.status).toBe("succeeded");
		expect((await read_node(f, created)).archiveOperationId).toBe((await read_node(f, tree.topId)).archiveOperationId);
	});

	test("has no Stop, and an item archived on its own keeps its operation through Archive and Restore", async () => {
		const f = await fixture();
		// 153 items. One file is archived first, so 152 active items are left: more than the request and
		// one step stamp (2 * 75), so the job still runs at the Stop.
		const tree = await seed_tree(f, { name: "stop", folderCount: 1, filesPerFolder: 151 });
		// Archived before the job, with its own operation. It must stay archived after the Restore.
		expect(await archive(f, [tree.fileIds[0]!])).toEqual({ _yay: null });
		const olderOperationId = (await read_node(f, tree.fileIds[0]!)).archiveOperationId;

		const archived = await archive(f, [tree.topId]);
		const job = archived._yay!;
		await step(f, job.runId);
		const stop = await f.asOwner.mutation(api.activities.request_stop, {
			membershipId: f.db.membershipId,
			activityId: job.activityId,
		});
		expect(stop._nay?.message).toBe("This activity cannot be stopped");

		const ended = await run_to_end(f, job);
		expect(ended.activity.status).toBe("succeeded");
		expect((await read_node(f, tree.fileIds[0]!)).archiveOperationId).toBe(olderOperationId);

		const restored = await restore(f, [tree.topId]);
		expect(restored._nay).toBeUndefined();
		if (restored._yay) await run_to_end(f, restored._yay);

		const after = await expect_consistent(f);
		expect(after.nodes.filter((node) => node.archiveOperationId !== null).map((node) => node._id)).toEqual([
			tree.fileIds[0],
		]);
		expect((await read_node(f, tree.fileIds[0]!)).archiveOperationId).toBe(olderOperationId);
	}, 120_000);

	test("deleting the user does not wait for the stamps, and they still end with no active item inside the archived folder", async () => {
		const f = await fixture();
		const member = await add_member(f);
		// 152 items: more than the request and one step stamp (2 * 75), so the job still runs at the deletion.
		const tree = await seed_tree(f, { name: "deleted", folderCount: 1, filesPerFolder: 150 });
		const archived = await member.asUser.mutation(api.files_nodes.archive_nodes, {
			membershipId: member.membershipId,
			nodeIds: [tree.topId],
		});
		const job = archived._yay!;

		// A later job still in its check. The writer list makes it check first.
		const later = await seed_tree(f, { name: "later", folderCount: 1, filesPerFolder: 150 });
		await lock_writer({ f, nodeId: later.fileIds[0]!, userId: member.userId });
		const laterJob = (
			await member.asUser.mutation(api.files_nodes.archive_nodes, {
				membershipId: member.membershipId,
				nodeIds: [later.topId],
			})
		)._yay!;
		expect((await f.t.run((ctx) => ctx.db.get("files_archive_runs", laterJob.runId)))?.phase).toBe("check");

		let done = false;
		for (let pass = 0; pass < 100 && !done; pass++) {
			done = await f.t.mutation(internal.data_deletion.finalize_user_deletion_data, {
				userId: member.userId,
				_test_batchSize: 1,
			});
		}
		expect(done).toBe(true);
		const deleted = await f.t.run(async (ctx) => ({
			run: await ctx.db.get("files_archive_runs", job.runId),
			laterRun: await ctx.db.get("files_archive_runs", laterJob.runId),
			membership: await ctx.db.get("organizations_workspaces_users", member.membershipId),
		}));
		expect(deleted.run).toMatchObject({ active: true, phase: "apply" });
		expect(deleted.membership).toBeNull();
		// The drain looks past the stamping job, so it stops and deletes the later job too.
		expect(deleted.laterRun).toBeNull();

		// The stamps do not need the user, even once its row is gone.
		await f.t.run((ctx) => ctx.db.delete("users", member.userId));
		expect((await run_to_end(f, job)).activity.status).toBe("succeeded");
		const after = await expect_consistent(f);
		const archivedTree = after.nodes.filter((node) => node.path.startsWith("/deleted"));
		expect(archivedTree).toHaveLength(152);
		expect(archivedTree.every((node) => node.archiveOperationId !== null)).toBe(true);
	}, 120_000);
});
