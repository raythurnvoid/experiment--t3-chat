// Use the public Move intake and its scheduled workers. Measure only Move, after fixture setup.
// Metadata byte budget tests are in files_move_scale.metadata.test.ts.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Id } from "./_generated/dataModel.js";
import { files_sort_text_key } from "../shared/files-sort.ts";
import {
	create_fixture,
	create_folder,
	expect_moved_markers,
	finish_move,
	measure_move,
	mock_move_scale_storage,
	move_selected_files,
	start_move,
	write_markers,
} from "./files_move_scale.setup.test.ts";

beforeEach(mock_move_scale_storage);

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("public Move scale", () => {
	// The Move view reads at most 200 moved roots (`files_transfer_status_MAX_SELECTED_NODES`). 201 roots
	// go past it and use 3 input pages of `files_TRANSFER_SELECTION_PAGE_SIZE`. It runs only with
	// test:files:full-size. files_move_scale.selection.test.ts lowers both limits and crosses them with 21 roots.
	test(
		"moves 201 selected files and keeps every metadata value",
		{ tags: ["full-size"], timeout: 7_200_000 },
		async () => {
			await move_selected_files(201);
		},
	);

	for (const { count, tags } of [
		// 33 descendants cross the 32-child native page even when exact cleanup work joins.
		{ count: 33, tags: [] },
		// 2001 was just past the old 2000-doc Move cap, which is gone. Run it with test:files:full-size.
		{ count: 2001, tags: ["full-size"] },
	])
		test(
			`moves one folder with ${count} descendants and keeps every metadata value`,
			{ tags, timeout: 7_200_000 },
			async () => {
				const fixture = await create_fixture();
				const { t } = fixture;
				const target = await create_folder(fixture, "target");
				const source = await create_folder(fixture, "source");
				const seed = await create_folder(fixture, "child-0000", source._id);
				const descendants = [seed._id];
				const { _id: _seedId, _creationTime: _seedTime, ...fields } = seed;
				// Bulk setup copies a real folder doc. Move still enters through the public door.
				for (let offset = 1; offset < count; offset += 100) {
					const ids = await t.run(async (ctx) => {
						const ids: Id<"files_nodes">[] = [];
						for (let index = offset; index < Math.min(offset + 100, count); index++) {
							const name = `child-${index.toString().padStart(4, "0")}`;
							const path = `/source/${name}`;
							ids.push(
								await ctx.db.insert("files_nodes", {
									...fields,
									name,
									sortName: files_sort_text_key(name),
									path,
									treePath: `${path}/`,
								}),
							);
						}
						return ids;
					});
					descendants.push(...ids);
				}
				expect(new Set(descendants).size, "every descendant is distinct").toBe(count);
				await write_markers(fixture, [source._id, ...descendants]);
				await t.finishAllScheduledFunctions(vi.runAllTimers, 10_000);
				const peaks = measure_move();
				await finish_move(fixture, await start_move(fixture, [source._id], target._id), 1);
				await expect_moved_markers(fixture, [source._id, ...descendants], (node) =>
					node._id === source._id ? "/target/source" : `/target/source/${node.name}`,
				);
				expect(
					peaks.get("cohort/descendants")?.calls,
					"the folder needs several descendant transactions",
				).toBeGreaterThan(1);
				console.info("Move scale descendants", JSON.stringify(Object.fromEntries(peaks)));
			},
		);
});
