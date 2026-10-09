import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { test_mocks } from "./setup.test.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";
import {
	fixture,
	seed_tree,
	seed_same_path,
	read_state,
	run_to_end,
	archive,
	restore,
	read_node,
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
});
