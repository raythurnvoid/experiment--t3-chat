// Archive tests at the real check step limit of 500 nodes. The other archive test files lower it to 100
// with `vi.mock`. The full-size tests are the ones of files_archive_runs.unarchive_same_name.test.ts at
// the real size, and they run only with test:files:full-size.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	fixture,
	seed_tree,
	seed_same_path,
	read_state,
	run_to_end,
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
		"the check reads tied descendant paths across the full-size page limit",
		{ tags: ["full-size"], timeout: 300_000 },
		async () => {
			const f = await fixture();
			const archiveOperationId = crypto.randomUUID();
			const tree = await seed_same_path(f, {
				name: "ties",
				count: 551,
				archiveOperationId,
			});
			await f.t.run((ctx) => ctx.db.patch("files_nodes", tree.topId, { archiveOperationId }));

			// The files share one name, so after the first one the job waits for a clash choice. The check
			// has passed by then.
			const restored = await restore(f, [tree.topId]);
			expect(restored._nay).toBeUndefined();
			const ended = await run_to_end(f, restored._yay!);
			expect(ended.activity.progress, "all full-size tied descendants are checked").toMatchObject({
				total: 552,
				completed: 2,
			});
			expect(ended.activity.status).toBe("awaiting_input");
			expect((await read_node(f, tree.fileIds[1]!)).archiveOperationId).toBe(archiveOperationId);
		},
	);
});
