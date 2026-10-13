// Use the public Move intake and its scheduled workers. Measure only Move, after fixture setup.
// Metadata byte budget tests are in files_move_scale.metadata.test.ts.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { files_ROOT_ID } from "../server/files.ts";
import { r2_create_asset_key } from "./r2_client.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";
import {
	create_fixture,
	create_folder,
	expect_moved_markers,
	finish_move,
	measure_move,
	mock_move_scale_storage,
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
	// The Move view reads at most 200 moved roots (`MAX_SELECTED_NODES` in files_transfer.ts). 201 roots
	// go past it and use 3 input pages of `files_TRANSFER_SELECTION_PAGE_SIZE`.
	test("moves 201 selected files and keeps every metadata value", async () => {
		const fixture = await create_fixture();
		const { t, db, asUser } = fixture;
		const target = await create_folder(fixture, "target");
		const total = 201;
		const sourceIds: Id<"files_nodes">[] = [];
		for (let offset = 0; offset < total; offset += 50) {
			const length = Math.min(50, total - offset);
			vi.setSystemTime(Date.now() + 60_000);
			const uploaded = await asUser.mutation(api.files_nodes.create_upload_nodes, {
				membershipId: db.membershipId,
				parentId: files_ROOT_ID,
				onConflict: "skip",
				items: Array.from({ length }, (_, index) => ({
					relativePath: `file-${(offset + index).toString().padStart(4, "0")}.bin`,
					size: 1,
					contentType: "application/octet-stream",
				})),
			});
			if (uploaded._nay) throw new Error(uploaded._nay.message);
			expect(uploaded._yay.created).toHaveLength(length);
			expect(uploaded._yay.skipped).toHaveLength(0);
			for (const item of uploaded._yay.created) {
				expect(await fetch(item.url, { method: "PUT", body: "x" })).toHaveProperty("status", 200);
				expect(
					await t.mutation(internal.r2.process_uploaded_asset_event, {
						assetId: item.assetId,
						r2Key: r2_create_asset_key({ ...db, assetId: item.assetId }),
						size: 1,
						eventId: `move-scale-${item.assetId}`,
					}),
				).toEqual({ _yay: null });
				sourceIds.push(item.nodeId);
			}
		}
		expect(new Set(sourceIds).size, "all selected files are distinct").toBe(total);
		await write_markers(fixture, sourceIds);
		await t.finishAllScheduledFunctions(vi.runAllTimers, 10_000);
		const peaks = measure_move();
		const run = await start_move(fixture, sourceIds, target._id);
		await finish_move(fixture, run, total);
		const view = await asUser.query(api.files_transfer.get, { membershipId: db.membershipId, runId: run.runId });
		expect(view?.movedNodeIds.length, "the selection is bigger than the view's moved roots").toBeLessThan(total);
		await expect_moved_markers(fixture, sourceIds, (node) => `/target/${node.name}`);
		console.info("Move scale selected files", JSON.stringify(Object.fromEntries(peaks)));
	}, 7_200_000);

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
