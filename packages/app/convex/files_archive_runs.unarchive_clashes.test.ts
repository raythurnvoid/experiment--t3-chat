// The name clash tests from a later clash in the middle of a page on are in
// files_archive_runs.unarchive_replace.test.ts, so the two files can run at the same time.
import { R2 } from "@convex-dev/r2";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { test_move_nodes, test_rename_node } from "./setup.test.ts";
import {
	fixture,
	type Fixture,
	add_member,
	seed_tree,
	expect_consistent,
	read_activity,
	step,
	run_to_end,
	archive,
	restore,
	read_node,
	archive_to_end,
} from "./files_archive_runs.setup.test.ts";

// Scheduled steps never run on their own under fake timers. Each test drives the op's steps itself.
beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (key = "") => ({
		key,
		url: "https://r2.test/upload",
	}));
});

afterEach(() => {
	vi.restoreAllMocks();
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
		 * its files. Then create new files with the names in `names` in d1. The restore waits on the first
		 * clash inside d1.
		 */
		async function seed_clash_inside(f: Fixture, names: string[]) {
			const tree = await seed_tree(f, { name: "inside", folderCount: 2, filesPerFolder: 100 });
			await archive_to_end(f, tree.topId);
			const job = (await restore(f, [tree.topId]))._yay!;
			await step_until_restored({ f, runId: job.runId, nodeId: tree.folderIds[1]! });
			expect((await read_node(f, tree.fileIds[100]!)).archiveOperationId).not.toBeNull();

			const occupantIds: Id<"files_nodes">[] = [];
			// Move waits for Restore. Create can still write into the folder already back.
			for (const filename of names) {
				const created = await f.asOwner.mutation(api.files_nodes.create_upload_node, {
					membershipId: f.db.membershipId,
					parentId: tree.folderIds[1]!,
					filename,
					contentType: "text/markdown",
					size: 0,
					onConflict: "fail",
				});
				if (created._nay) throw new Error(created._nay.message);
				occupantIds.push(created._yay.nodeId);
			}
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

		test.each([
			{ label: "long", sourceName: `${"n".repeat(252)}.md`, restoredName: `${"n".repeat(250)}-2.md` },
			{
				label: "early-dot",
				sourceName: `x.${"n".repeat(250)}.md`,
				restoredName: `x.${"n".repeat(248)}-2.md`,
			},
			{
				label: "early-dot at counter 10",
				sourceName: `x.${"n".repeat(248)}.md`,
				restoredName: `x.${"n".repeat(247)}-10.md`,
				takenNames: Array.from({ length: 8 }, (_entry, index) => `x-${index + 2}.${"n".repeat(248)}.md`),
			},
			{ label: "compound extension", sourceName: "backup.tar.gz", restoredName: "backup-2.tar.gz" },
		])("Keep both restores a $label name inside the limit", async (nameCase) => {
			const { label, sourceName, restoredName } = nameCase;
			const f = await fixture();
			const tree = await seed_tree(f, { name: "long", folderCount: 1, filesPerFolder: 2 });
			// The second file takes the name while the first one is archived.
			const rename = (nodeId: Id<"files_nodes">) =>
				test_rename_node(f.t, f.asOwner, { membershipId: f.db.membershipId, nodeId, path: sourceName });
			expect((await rename(tree.fileIds[0]!))._nay).toBeUndefined();
			expect(await archive(f, [tree.fileIds[0]!])).toEqual({ _yay: null });
			expect((await rename(tree.fileIds[1]!))._nay).toBeUndefined();
			for (const filename of nameCase.takenNames ?? []) {
				expect(
					(
						await f.asOwner.mutation(api.files_nodes.create_upload_node, {
							membershipId: f.db.membershipId,
							parentId: tree.folderIds[0]!,
							filename,
							contentType: "text/markdown",
							size: 0,
							onConflict: "fail",
						})
					)._nay,
				).toBeUndefined();
			}
			const job = (await restore(f, [tree.fileIds[0]!]))._yay!;

			expect(await resolve({ f, runId: job.runId, choice: "keep_both" })).toEqual({ _yay: null });
			await run_to_end(f, job);
			expect(
				await read_node(f, tree.fileIds[0]!),
				`Keep both restores the ${label} file under a valid name`,
			).toMatchObject({
				archiveOperationId: null,
				name: restoredName,
				path: `/long/d0/${restoredName}`,
			});
			expect(await read_node(f, tree.fileIds[1]!)).toMatchObject({
				archiveOperationId: null,
				name: sourceName,
				path: `/long/d0/${sourceName}`,
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
			// Put the new files next to the archived ones, so every name is taken. Write them in place:
			// a Move runs one job per file, and 100 of them take minutes.
			await f.t.run(async (ctx) => {
				const chunks = await ctx.db.query("files_plain_text_chunks").collect();
				const metadataDocs = await ctx.db.query("files_metadata_docs").collect();
				for (const nodeId of occupants.fileIds) {
					const node = (await ctx.db.get("files_nodes", nodeId))!;
					const path = `/budget/d0/${node.name}`;
					await ctx.db.patch("files_nodes", nodeId, { parentId: tree.folderIds[0]!, path, treePath: path });
					for (const chunk of chunks.filter((chunk) => chunk.sourceKind === "committed" && chunk.fileNodeId === nodeId))
						await ctx.db.patch("files_plain_text_chunks", chunk._id, { path });
					for (const doc of metadataDocs.filter((doc) => doc.sourceKind === "committed" && doc.fileNodeId === nodeId))
						await ctx.db.patch("files_metadata_docs", doc._id, { path, treePath: path });
				}
			});
			await expect_consistent(f);
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
	});
});
