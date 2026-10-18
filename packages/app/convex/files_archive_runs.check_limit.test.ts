// Archive tests at the real check step limit of 500 nodes. The other archive test files lower it to 100
// with `vi.mock`. The full-size tests are the ones of files_archive_runs.unarchive_same_name.test.ts at
// the real size, and they run only with test:files:full-size.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import {
	fixture,
	seed_tree,
	seed_same_path,
	read_state,
	run_to_end,
	archive,
	restore,
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
	test(
		"restores many files with the same name in different folders",
		{ tags: ["full-size"], timeout: 300_000 },
		async () => {
			const f = await fixture();
			const tree = await seed_tree(f, { name: "repeated", folderCount: 551, filesPerFolder: 1 });
			await archive_to_end(f, tree.topId);

			const restored = await restore(f, [tree.topId]);
			expect(restored._nay).toBeUndefined();
			const ended = await run_to_end(f, restored._yay!);
			expect(ended.activity.status).toBe("succeeded");
			expect((await read_state(f)).nodes.every((node) => node.archiveOperationId === null)).toBe(true);
		},
	);

	test(
		"the check reads up to 500 more items of the operation with the path where a page ends",
		{ tags: ["full-size"], timeout: 300_000 },
		async () => {
			const f = await fixture();
			const fits = await seed_same_path(f, { name: "fits", count: 550, archiveOperationId: crypto.randomUUID() });
			const tooMany = await seed_same_path(f, {
				name: "too-many",
				count: 551,
				archiveOperationId: crypto.randomUUID(),
			});

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
		},
	);
});

describe("apply_file_pending_archive", () => {
	test("a folder too big to check still gets the proposal, and the job refuses a read-only item inside", async () => {
		const f = await fixture();
		// 2,005 items inside, more than the proposal checks in one mutation.
		const tree = await seed_tree(f, { name: "huge", folderCount: 5, filesPerFolder: 400 });
		expect(await archive(f, [tree.fileIds.at(-1)!])).toEqual({ _yay: null });
		await lock_archived(f, tree.fileIds.at(-1)!);

		const proposed = await f.t.mutation(internal.files_pending_updates.upsert_file_pending_archive_in_db, {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			userId: f.db.userId,
			target: { kind: "saved", id: tree.topId },
		});
		expect(proposed._nay).toBeUndefined();

		const pendingUpdate = (await f.t.run((ctx) => ctx.db.query("files_pending_updates").first()))!;
		expect(
			await f.asOwner.mutation(api.files_pending_updates.apply_file_pending_archive, {
				membershipId: f.db.membershipId,
				target: { kind: "saved", id: tree.topId },
				pendingUpdateId: pendingUpdate._id,
				reviewedRevision: pendingUpdate.revision,
			}),
		).toEqual({ _yay: null });
		const run = (await f.t.run((ctx) => ctx.db.query("files_archive_runs").first()))!;
		const activity = (await f.t.run((ctx) => ctx.db.query("activities").first()))!;
		const ended = await run_to_end(f, { runId: run._id, activityId: activity._id });
		// An agent's delete names one item, so the refusal that leaves out one named item fails the delete.
		expect(ended.activity).toMatchObject({
			status: "failed",
			errorMessage: '"/huge/d4/f399.md" is read-only. Unlock it, then try again.',
		});
		expect((await read_node(f, tree.topId)).archiveOperationId).toBeNull();
	});
});
