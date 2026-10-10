import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { test_rename_node, test_move_nodes, test_create_saved_text_file, test_mocks } from "./setup.test.ts";
import { files_subtree_ops_STEP_MAX_NODES } from "./files_subtree_ops.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";
import {
	mock_share_storage,
	fixture,
	reset_rate_limits,
	seed_big_folder,
	read_links,
	link_on,
	view_of,
} from "./files_share_links.setup.test.ts";

beforeEach(mock_share_storage);

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("public Move share links", () => {
	test("a rename in the same folder keeps the link, and a move to another folder ends it", async () => {
		const f = await fixture();
		const link = await link_on(f, f.nodeId);
		const rename = async (path: string) => {
			await reset_rate_limits(f.t, [f.db.userId]);
			return await test_rename_node(f.t, f.asOwner, {
				membershipId: f.db.membershipId,
				nodeId: f.nodeId,
				path,
			});
		};

		expect(await rename("/renamed.md")).toMatchObject({
			_yay: { runId: expect.any(String), activityId: expect.any(String) },
		});
		expect(await read_links(f.t, f.nodeId)).toEqual([link]);

		// A refused move changes nothing.
		await test_create_saved_text_file(f.t, { membershipId: f.db.membershipId, path: "/taken.md" });
		expect((await rename("/taken.md"))._nay).toBeDefined();
		expect(await read_links(f.t, f.nodeId)).toEqual([link]);

		await f.asOwner.mutation(api.files_nodes.create_folder_node, {
			membershipId: f.db.membershipId,
			parentId: "root",
			path: "dest",
		});
		expect(await rename("/dest/renamed.md")).toMatchObject({
			_yay: { runId: expect.any(String), activityId: expect.any(String) },
		});
		expect(await read_links(f.t, f.nodeId)).toEqual([]);
	});

	test("a move into a folder the move creates ends the link", async () => {
		const f = await fixture();
		await link_on(f, f.nodeId);

		// The new folder has no id while the move is planned, so the plan uses its parent key.
		expect(
			await test_rename_node(f.t, f.asOwner, {
				membershipId: f.db.membershipId,
				nodeId: f.nodeId,
				path: "/new-folder/doc.md",
			}),
		).toMatchObject({ _yay: { runId: expect.any(String), activityId: expect.any(String) } });
		expect((await f.t.run((ctx) => ctx.db.get("files_nodes", f.nodeId)))?.path).toBe("/new-folder/doc.md");
		expect(await read_links(f.t, f.nodeId)).toEqual([]);
	});

	test("moving a folder ends the links below it", async () => {
		const f = await fixture();
		const nodeId = await test_create_saved_text_file(f.t, { membershipId: f.db.membershipId, path: "/a/b/x.md" });
		const node = await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId));
		const innerFolder = await f.t.run((ctx) => ctx.db.get("files_nodes", node!.parentId as Id<"files_nodes">));
		await link_on(f, nodeId);
		const outside = await link_on(f, f.nodeId);
		const dest = await f.asOwner.mutation(api.files_nodes.create_folder_node, {
			membershipId: f.db.membershipId,
			parentId: "root",
			path: "dest",
		});

		expect(
			await test_move_nodes(f.t, f.asOwner, {
				membershipId: f.db.membershipId,
				itemIds: [innerFolder!.parentId as Id<"files_nodes">],
				targetParentId: dest._yay!.nodeId,
			}),
		).toEqual({ _yay: null });
		expect(await read_links(f.t, nodeId)).toEqual([]);
		expect(await read_links(f.t, f.nodeId)).toEqual([outside]);
	});

	test("renaming a folder in the same parent keeps the links below it, also after its job gives them the new path", async () => {
		const f = await fixture();
		const { nodeId, folderId } = await seed_big_folder(f, files_subtree_ops_STEP_MAX_NODES + 1);
		const link = await link_on(f, nodeId);

		await reset_rate_limits(f.t, [f.db.userId]);
		expect(
			await test_rename_node(f.t, f.asOwner, {
				membershipId: f.db.membershipId,
				nodeId: folderId,
				path: "/renamed",
			}),
		).toMatchObject({ _yay: { runId: expect.any(String), activityId: expect.any(String) } });
		// Completion includes path repair. A new path alone keeps the link.
		expect((await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId)))?.path).toBe("/renamed/zz.md");
		expect(await read_links(f.t, nodeId)).toEqual([link]);
		expect(await view_of(f, link.token)).not.toBeNull();
	}, 120_000);

	test("a move to the same folder with the same name keeps the link", async () => {
		const f = await fixture();
		const link = await link_on(f, f.nodeId);

		await reset_rate_limits(f.t, [f.db.userId]);
		expect(
			await test_move_nodes(f.t, f.asOwner, {
				membershipId: f.db.membershipId,
				itemIds: [f.nodeId],
				targetParentId: "root",
			}),
		).toEqual({ _yay: null });
		expect((await f.t.run((ctx) => ctx.db.get("files_nodes", f.nodeId)))?.path).toBe("/doc.md");
		expect(await read_links(f.t, f.nodeId)).toEqual([link]);
	});

	test("a folder moved into another folder keeps its old links dead after that folder is restricted and opened again", async () => {
		const f = await fixture();
		const { nodeId, folderId } = await seed_big_folder(f, files_subtree_ops_STEP_MAX_NODES + 1);
		const link = await link_on(f, nodeId);
		const dest = await f.asOwner.mutation(api.files_nodes.create_folder_node, {
			membershipId: f.db.membershipId,
			parentId: "root",
			path: "dest",
		});
		const destId = dest._yay!.nodeId;
		// Fill the new parent with folders that sort before `big`. Then the first step of each scope job
		// does not reach `big`, and both jobs reach it only after the folder is open again.
		await f.t.run(async (ctx) => {
			for (let index = 0; index <= files_subtree_ops_STEP_MAX_NODES; index++) {
				const name = `a${String(index).padStart(3, "0")}`;
				await ctx.db.insert("files_nodes", {
					...test_mocks.files.base(),
					organizationId: f.db.organizationId,
					workspaceId: f.db.workspaceId,
					createdBy: f.db.userId,
					updatedBy: f.db.userId,
					parentId: destId,
					name,
					sortName: files_sort_text_key(name),
					path: `/dest/${name}`,
					treePath: `/dest/${name}/`,
					pathDepth: 2,
				});
			}
		});

		await reset_rate_limits(f.t, [f.db.userId]);
		expect(
			await test_move_nodes(f.t, f.asOwner, {
				membershipId: f.db.membershipId,
				itemIds: [folderId],
				targetParentId: destId,
			}),
		).toEqual({ _yay: null });
		expect(await read_links(f.t, nodeId)).toEqual([]);

		// The link doc named only `big` as an ancestor, not `dest`. So only the move hook can end it.
		for (const door of [api.files_sharing.restrict_node, api.files_sharing.unrestrict_node]) {
			await reset_rate_limits(f.t, [f.db.userId]);
			expect(
				(await f.asOwner.mutation(door, { membershipId: f.db.membershipId, nodeId: destId }))._nay,
			).toBeUndefined();
		}
		// Move repair has finished before the later scope jobs run.
		expect((await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId)))?.path).toBe("/dest/big/zz.md");

		await f.t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId))).toMatchObject({
			path: "/dest/big/zz.md",
			restrictedScopeNodeId: null,
		});
		expect(await read_links(f.t, nodeId)).toEqual([]);
		expect(await view_of(f, link.token)).toBeNull();

		// Control: a new link on the same file shows, so the old token is dead only because its doc is gone.
		const fresh = await link_on(f, nodeId);
		expect(await view_of(f, fresh.token)).not.toBeNull();
	}, 120_000);

	test("a move that replaces a file ends the replaced file's link", async () => {
		const f = await fixture();
		await link_on(f, f.nodeId);
		const sourceId = await test_create_saved_text_file(f.t, { membershipId: f.db.membershipId, path: "/src/doc.md" });

		const moved = await test_move_nodes(f.t, f.asOwner, {
			membershipId: f.db.membershipId,
			itemIds: [sourceId],
			targetParentId: "root",
			replaceNodeId: f.nodeId,
		});
		expect(moved._nay).toBeUndefined();
		expect((await f.t.run((ctx) => ctx.db.get("files_nodes", f.nodeId)))?.archiveOperationId).not.toBeNull();
		expect(await read_links(f.t, f.nodeId)).toEqual([]);
	});
});

describe("archive_nodes", () => {
	test("an archive job ends the links below its folder only after its check ends", async () => {
		const f = await fixture();
		// One check step reads at most 500 nodes, so this check needs more than one step.
		const { nodeId, folderId } = await seed_big_folder(f, 600);
		await link_on(f, nodeId);
		const outside = await link_on(f, f.nodeId);

		const started = await f.asOwner.mutation(api.files_nodes.archive_nodes, {
			membershipId: f.db.membershipId,
			nodeIds: [folderId],
		});
		const run = await f.t.run((ctx) => ctx.db.get("files_archive_runs", started._yay!.runId));
		expect(run?.phase).toBe("check");
		expect(await read_links(f.t, nodeId)).toHaveLength(1);

		await f.t.finishAllScheduledFunctions(vi.runAllTimers);
		expect((await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId)))?.archiveOperationId).not.toBeNull();
		expect(await read_links(f.t, nodeId)).toEqual([]);
		expect(await read_links(f.t, f.nodeId)).toEqual([outside]);
	});

	test("the step that ends the check ends the links before it stamps the files inside", async () => {
		const f = await fixture();
		// One check step reads at most 500 nodes, and one apply step stamps at most 75. The file sorts last.
		const { nodeId, folderId } = await seed_big_folder(f, 600);
		const link = await link_on(f, nodeId);
		const outside = await link_on(f, f.nodeId);

		const started = await f.asOwner.mutation(api.files_nodes.archive_nodes, {
			membershipId: f.db.membershipId,
			nodeIds: [folderId],
		});
		const runId = started._yay!.runId;
		const read_run = () => f.t.run((ctx) => ctx.db.get("files_archive_runs", runId));
		expect((await read_run())?.phase).toBe("check");

		// Run the steps the scheduler would run, one at a time, until the check ends.
		for (let count = 0; (await read_run())?.phase === "check"; count++) {
			expect(count).toBeLessThan(10);
			expect(await read_links(f.t, nodeId)).toEqual([link]);
			const { opId, step } = await f.t.run(async (ctx) => {
				const op = await ctx.db
					.query("files_subtree_ops")
					.withIndex("by_archiveRun", (q) => q.eq("archiveRunId", runId))
					.unique();
				const walk = await ctx.db
					.query("files_subtree_op_walks")
					.withIndex("by_op", (q) => q.eq("opId", op!._id))
					.unique();
				return { opId: op!._id, step: walk!.step };
			});
			await f.t.mutation(internal.files_subtree_ops.advance, { opId, step });
		}
		expect((await read_run())?.phase).toBe("apply");

		// The apply stamps the named folder first. It has not stamped the file yet, but the link is already gone.
		expect((await f.t.run((ctx) => ctx.db.get("files_nodes", folderId)))?.archiveOperationId).not.toBeNull();
		expect((await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId)))?.archiveOperationId).toBeNull();
		expect(await read_links(f.t, nodeId)).toEqual([]);
		expect(await read_links(f.t, f.nodeId)).toEqual([outside]);
		expect(await view_of(f, link.token)).toBeNull();

		await reset_rate_limits(f.t, [f.db.userId]);
		const refused = await f.asOwner.mutation(api.files_sharing.set_node_share_link, {
			membershipId: f.db.membershipId,
			nodeId,
			enabled: true,
		});
		expect(refused._nay?.message).toBe("This file is archived");
		expect(await read_links(f.t, nodeId)).toEqual([]);
	});

	test("a named item that the check refuses keeps its link", async () => {
		const f = await fixture();
		const otherId = await test_create_saved_text_file(f.t, { membershipId: f.db.membershipId, path: "/other.md" });
		await link_on(f, f.nodeId);
		const kept = await link_on(f, otherId);
		expect(
			await f.asOwner.mutation(api.files_nodes.set_node_write_policy, {
				membershipId: f.db.membershipId,
				nodeId: otherId,
				writePolicy: { mode: "read_only" },
			}),
		).toEqual({ _yay: null });

		const started = await f.asOwner.mutation(api.files_nodes.archive_nodes, {
			membershipId: f.db.membershipId,
			nodeIds: [f.nodeId, otherId],
		});
		expect(started._yay?.notArchivedNodeIds).toEqual([otherId]);
		expect(await read_links(f.t, f.nodeId)).toEqual([]);
		expect(await read_links(f.t, otherId)).toEqual([kept]);
	});
});

describe("unarchive_nodes", () => {
	test("restore Replace ends the replaced file's link, and restoring that file does not bring it back", async () => {
		const f = await fixture();
		const restore = async (nodeId: Id<"files_nodes">) => {
			await reset_rate_limits(f.t, [f.db.userId]);
			const started = await f.asOwner.mutation(api.files_nodes.unarchive_nodes, {
				membershipId: f.db.membershipId,
				nodeIds: [nodeId],
			});
			return started._yay!;
		};
		const resolve = async (runId: Id<"files_archive_runs">, choice: "replace" | "keep_both") => {
			await reset_rate_limits(f.t, [f.db.userId]);
			const run = await f.t.run((ctx) => ctx.db.get("files_archive_runs", runId));
			expect(
				await f.asOwner.mutation(api.files_archive_runs.resolve_conflicts, {
					membershipId: f.db.membershipId,
					runId,
					revision: run!.revision,
					choice,
					applyToRemaining: { file: null, folder: null },
				}),
			).toEqual({ _yay: null });
			await f.t.finishAllScheduledFunctions(vi.runAllTimers);
		};

		const archived = await f.asOwner.mutation(api.files_nodes.archive_nodes, {
			membershipId: f.db.membershipId,
			nodeIds: [f.nodeId],
		});
		expect(archived._nay).toBeUndefined();
		const occupantId = await test_create_saved_text_file(f.t, { membershipId: f.db.membershipId, path: "/doc.md" });
		await link_on(f, occupantId);

		await resolve((await restore(f.nodeId)).runId, "replace");
		expect((await f.t.run((ctx) => ctx.db.get("files_nodes", occupantId)))?.archiveOperationId).not.toBeNull();
		expect(await read_links(f.t, occupantId)).toEqual([]);

		await resolve((await restore(occupantId)).runId, "keep_both");
		expect((await f.t.run((ctx) => ctx.db.get("files_nodes", occupantId)))?.archiveOperationId).toBeNull();
		expect(await read_links(f.t, occupantId)).toEqual([]);
	});
});
