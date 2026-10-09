import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { test_move_nodes } from "./setup.test.ts";
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
	folder,
	read_node,
	lock_archived,
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
