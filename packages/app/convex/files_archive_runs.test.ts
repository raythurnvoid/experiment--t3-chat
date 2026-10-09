import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { activities_is_active } from "./activities_db.ts";
import { test_mocks_fill_db_with } from "./setup.test.ts";
import { files_archive_runs_db_delete_run_batch } from "./files_archive_runs.ts";
import {
	fixture,
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
	lock,
	folder,
	read_node,
	lock_archived,
	queue_empty_folders_first,
	count_queue,
} from "./files_archive_runs.setup.test.ts";

// Scheduled steps never run on their own under fake timers. Each test drives the op's steps itself.
beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
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
		const tree = await seed_tree(f, { name: "big", folderCount: 6, filesPerFolder: 100 });

		const archived = await archive(f, [tree.topId]);
		expect(archived._nay).toBeUndefined();
		const ended = await run_to_end(f, archived._yay!);

		expect(ended.activity).toMatchObject({ status: "succeeded", title: "Archive files" });
		expect(ended.activity.progress).toMatchObject({ total: 607, completed: 607 });
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

	test("the named folder leaves the tree in the first step that writes, before its children", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "first", folderCount: 6, filesPerFolder: 100 });

		const archived = await archive(f, [tree.topId]);
		const job = archived._yay!;
		// The check reads 500 nodes inside the request, so nothing is stamped yet.
		expect((await read_node(f, tree.topId)).archiveOperationId).toBeNull();
		await step(f, job.runId);

		expect((await read_node(f, tree.topId)).archiveOperationId).not.toBeNull();
		expect((await read_node(f, tree.fileIds.at(-1)!)).archiveOperationId).toBeNull();
		await expect_consistent(f);
	});

	test("a folder created inside during the check is archived with the rest", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "grow", folderCount: 6, filesPerFolder: 100 });

		const archived = await archive(f, [tree.topId]);
		const job = archived._yay!;
		// The check runs in steps first, so `d0` is still active here.
		expect((await read_node(f, tree.folderIds[0]!)).archiveOperationId).toBeNull();
		const created = await folder(f, "/grow/d0/new");

		const ended = await run_to_end(f, job);
		expect(ended.activity.status).toBe("succeeded");
		expect((await read_node(f, created)).archiveOperationId).toBe((await read_node(f, tree.topId)).archiveOperationId);
	});

	test("has no Stop, and an item archived on its own keeps its operation through Archive and Restore", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "stop", folderCount: 6, filesPerFolder: 100 });
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

	test("a lock set after the check does not stop the archive", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "lock", folderCount: 4, filesPerFolder: 100 });

		// The check of 405 nodes fits in the request, and the stamps begin there too.
		const archived = await archive(f, [tree.topId]);
		const job = archived._yay!;
		expect((await read_node(f, tree.fileIds.at(-1)!)).archiveOperationId).toBeNull();
		await lock({ f, nodeId: tree.fileIds.at(-1)!, locked: true });

		const ended = await run_to_end(f, job);
		expect(ended.activity.status).toBe("succeeded");
		expect((await read_node(f, tree.fileIds.at(-1)!)).archiveOperationId).not.toBeNull();
	});

	test("a read-only file found by the check refuses before anything is archived", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "checked", folderCount: 6, filesPerFolder: 100 });
		// The check reads 500 nodes inside the request, and the walk reaches this file last.
		await lock({ f, nodeId: tree.fileIds.at(-1)!, locked: true });

		const small = await seed_tree(f, { name: "checked-small", folderCount: 1, filesPerFolder: 2 });
		await lock({ f, nodeId: small.fileIds[1]!, locked: true });
		const refused = await archive(f, [small.topId]);
		expect(refused._nay?.name).toBe("read_only");
		expect(await f.t.run((ctx) => ctx.db.query("files_archive_runs").collect())).toEqual([]);
		expect(await f.t.run((ctx) => ctx.db.query("files_subtree_ops").collect())).toEqual([]);

		// The big tree is too big to check inside the request, so the job checks it in steps. The refusal
		// then ends the job without "partway", because nothing changed.
		const archived = await archive(f, [tree.topId]);
		const ended = await run_to_end(f, archived._yay!);
		expect(ended.activity.status).toBe("failed");
		expect(ended.activity.errorMessage).not.toMatch(/partway/);
		// The refused folder counts once, and the counts add up to the total.
		expect(ended.activity.progress).toMatchObject({ total: 1, completed: 0, skipped: 0, blocked: 1 });
		const state = await read_state(f);
		expect(state.nodes.every((node) => node.archiveOperationId === null)).toBe(true);
	});

	test("a named item the check refuses is not archived with everything inside, and the other named items are archived", async () => {
		const f = await fixture();
		const kept = await seed_tree(f, { name: "kept", folderCount: 1, filesPerFolder: 2 });
		const refused = await seed_tree(f, { name: "refused", folderCount: 1, filesPerFolder: 2 });
		await lock({ f, nodeId: refused.fileIds[1]!, locked: true });

		// The file inside the refused folder is named too. It stays active with its folder.
		const archived = await archive(f, [kept.topId, refused.topId, refused.fileIds[0]!]);
		expect(archived).toEqual({
			_yay: {
				runId: expect.any(String),
				activityId: expect.any(String),
				isDone: true,
				notArchivedNodeIds: [refused.topId, refused.fileIds[0]],
			},
		});
		const job = archived._yay!;

		const state = await expect_consistent(f);
		const archivedPaths = state.nodes.filter((node) => node.archiveOperationId !== null).map((node) => node.path);
		expect(archivedPaths.toSorted()).toEqual(["/kept", "/kept/d0", "/kept/d0/f000.md", "/kept/d0/f001.md"]);
		const activity = await read_activity(f, job.activityId);
		expect(activity.status).toBe("partial");
		// The refused folder counts once, as blocked. Nothing inside it counts.
		expect(activity.progress).toMatchObject({ discovered: 5, total: 5, completed: 4, skipped: 0, blocked: 1 });

		const run = await f.asOwner.query(api.files_archive_runs.get, {
			membershipId: f.db.membershipId,
			runId: job.runId,
		});
		expect(run?.notArchived).toEqual([
			{ nodeId: refused.topId, name: "refused", message: "An item inside it is read-only." },
		]);
		// The job dialog lists the named items that were archived. The file inside the refused folder is not one.
		expect(run?.archived).toEqual([{ nodeId: kept.topId, name: "kept" }]);
	});

	test("a refusal found in a later check step counts the refused item once", async () => {
		const f = await fixture();
		const before = await seed_tree(f, { name: "before", folderCount: 1, filesPerFolder: 2 });
		const big = await seed_tree(f, { name: "big-refused", folderCount: 6, filesPerFolder: 100 });
		const after = await seed_tree(f, { name: "after", folderCount: 1, filesPerFolder: 1 });
		// The check reads 500 nodes in each step, and the walk reaches this file last.
		await lock({ f, nodeId: big.fileIds.at(-1)!, locked: true });

		// The request checks 500 nodes and does not reach the read-only file yet.
		const archived = await archive(f, [before.topId, big.topId, after.topId]);
		expect(archived._yay).toMatchObject({ isDone: false, notArchivedNodeIds: [] });
		const ended = await run_to_end(f, archived._yay!);

		expect(ended.activity.status).toBe("partial");
		expect(ended.activity.progress).toMatchObject({ discovered: 8, total: 8, completed: 7, blocked: 1 });
		const state = await read_state(f);
		const archivedIds = new Set(state.nodes.filter((node) => node.archiveOperationId !== null).map((node) => node._id));
		expect([big.topId, ...big.folderIds, ...big.fileIds].some((nodeId) => archivedIds.has(nodeId))).toBe(false);
		expect(archivedIds.has(before.topId) && archivedIds.has(after.topId)).toBe(true);
	});

	test("refuses the request when the check refuses every named item", async () => {
		const f = await fixture();
		const first = await seed_tree(f, { name: "first-refused", folderCount: 1, filesPerFolder: 1 });
		const second = await seed_tree(f, { name: "second-refused", folderCount: 1, filesPerFolder: 1 });
		await lock({ f, nodeId: first.topId, locked: true });
		await lock({ f, nodeId: second.fileIds[0]!, locked: true });

		const refused = await archive(f, [first.topId, second.topId]);
		expect(refused._nay?.message).toBe(
			"None of these items can be archived. You cannot change them or items inside them.",
		);
		expect(await f.t.run((ctx) => ctx.db.query("files_archive_runs").collect())).toEqual([]);
		expect(await f.t.run((ctx) => ctx.db.query("files_subtree_ops").collect())).toEqual([]);
	});

	test("a named item somebody else archives during the check is skipped, and the refused one is listed", async () => {
		const f = await fixture();
		const big = await seed_tree(f, { name: "big-alone", folderCount: 6, filesPerFolder: 100 });
		const small = await seed_tree(f, { name: "small-archived", folderCount: 1, filesPerFolder: 1 });
		await lock({ f, nodeId: big.fileIds.at(-1)!, locked: true });

		const archived = await archive(f, [big.topId, small.topId]);
		// Somebody archives the small tree on their own before the check reaches it.
		expect(await archive(f, [small.topId])).toEqual({ _yay: null });
		const smallOperationId = (await read_node(f, small.topId)).archiveOperationId;
		const ended = await run_to_end(f, archived._yay!);

		// Like `rm` with one refused file, the job fails. The card counts and the dialog list say why.
		expect(ended.activity).toMatchObject({ status: "failed", errorMessage: null });
		expect(ended.activity.progress).toMatchObject({ total: 2, completed: 0, skipped: 1, blocked: 1 });
		expect((await read_node(f, big.topId)).archiveOperationId).toBeNull();
		expect((await read_node(f, small.topId)).archiveOperationId).toBe(smallOperationId);
		const run = await f.asOwner.query(api.files_archive_runs.get, {
			membershipId: f.db.membershipId,
			runId: archived._yay!.runId,
		});
		expect(run?.notArchived).toEqual([
			{ nodeId: big.topId, name: "big-alone", message: "An item inside it is read-only." },
		]);
	});

	test("a named item that is gone when the check reaches it is listed as not found", async () => {
		const f = await fixture();
		const big = await seed_tree(f, { name: "big-first", folderCount: 6, filesPerFolder: 100 });
		// An empty folder, so deleting it leaves no child without a parent.
		const small = await seed_tree(f, { name: "small-deleted", folderCount: 0, filesPerFolder: 0 });

		const archived = await archive(f, [big.topId, small.topId]);
		expect(archived._yay).toMatchObject({ isDone: false, notArchivedNodeIds: [] });
		// A volume or an upload retry can hard-delete a node while the job still checks.
		await f.t.run((ctx) => ctx.db.delete("files_nodes", small.topId));
		const ended = await run_to_end(f, archived._yay!);

		expect(ended.activity).toMatchObject({ status: "partial", errorMessage: null });
		expect(ended.activity.progress).toMatchObject({ total: 608, completed: 607, skipped: 0, blocked: 1 });
		const run = await f.asOwner.query(api.files_archive_runs.get, {
			membershipId: f.db.membershipId,
			runId: archived._yay!.runId,
		});
		expect(run?.notArchived).toEqual([{ nodeId: small.topId, name: null, message: "Not found" }]);
	});

	test("the job archives nothing when the person is removed during the check", async () => {
		const f = await fixture();
		const member = await f.t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, { organizationName: "member-home", workspaceName: "home" }),
		);
		expect(
			await f.asOwner.mutation(api.organizations.invite_user_to_organization_workspace, {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				userIdToAdd: member.userId,
			}),
		).toEqual({ _yay: null });
		const membershipId = (await f.t.run((ctx) =>
			ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_workspace_user_active", (q) => q.eq("workspaceId", f.db.workspaceId).eq("userId", member.userId))
				.unique(),
		))!._id;
		// 499 reads for the first tree (1 + 6 folders + 6 * 82 files). The locked second folder is read 500,
		// so the request stops right after it refuses it, with its row still in the queue.
		const first = await seed_tree(f, { name: "first-passed", folderCount: 6, filesPerFolder: 82 });
		const refused = await seed_tree(f, { name: "second-refused", folderCount: 0, filesPerFolder: 0 });
		await lock({ f, nodeId: refused.topId, locked: true });

		const archived = await f.t
			.withIdentity({ issuer: "https://clerk.test", external_id: member.userId })
			.mutation(api.files_nodes.archive_nodes, { membershipId, nodeIds: [first.topId, refused.topId] });
		expect(archived._yay).toMatchObject({ isDone: false, notArchivedNodeIds: [refused.topId] });
		expect((await f.t.run((ctx) => ctx.db.get("files_archive_runs", archived._yay!.runId)))?.phase).toBe("check");
		expect(
			await f.asOwner.mutation(api.organizations.remove_user_from_organization, {
				organizationId: f.db.organizationId,
				userIdToRemove: member.userId,
			}),
		).toEqual({ _yay: null });
		const ended = await run_to_end(f, archived._yay!);

		// The next step only drops the refused folder's row, with no write check, and then would archive the
		// first tree. The membership check stops it first.
		expect(ended.activity).toMatchObject({ status: "failed", errorMessage: "You can no longer change these files." });
		expect((await read_node(f, first.topId)).archiveOperationId).toBeNull();
	});

	test("items somebody else deletes before the apply reaches them count as skipped", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "shrink", folderCount: 6, filesPerFolder: 100 });
		// An empty folder, so deleting it leaves no child without a parent.
		const emptyId = await folder(f, "/shrink/d5/empty");

		const archived = await archive(f, [tree.topId]);
		await step(f, archived._yay!.runId);
		// The first step finished the check and stamped only the start of the tree.
		expect((await read_node(f, emptyId)).archiveOperationId).toBeNull();
		await f.t.run((ctx) => ctx.db.delete("files_nodes", emptyId));
		const ended = await run_to_end(f, archived._yay!);

		expect(ended.activity.status).toBe("succeeded");
		expect(ended.activity.progress).toMatchObject({ total: 608, completed: 607, skipped: 1, blocked: 0 });
	});

	test("a missing or foreign named id is listed as not found, and the other named items are archived", async () => {
		const f = await fixture();
		const kept = await seed_tree(f, { name: "kept-found", folderCount: 1, filesPerFolder: 1 });
		const { missingId, foreignId } = await f.t.run(async (ctx) => {
			const {
				_id: _keptId,
				_creationTime: _keptCreationTime,
				...fields
			} = (await ctx.db.get("files_nodes", kept.topId))!;
			// A valid id whose node is gone.
			const missingId = await ctx.db.insert("files_nodes", { ...fields, name: "missing" });
			await ctx.db.delete("files_nodes", missingId);
			// A node of another organization. The owner passes every check in their own workspace, so a
			// name read without the workspace check would show it.
			const foreign = await test_mocks_fill_db_with.membership(ctx, { organizationName: "other-organization" });
			const foreignId = await ctx.db.insert("files_nodes", {
				...fields,
				organizationId: foreign.organizationId,
				workspaceId: foreign.workspaceId,
				name: "foreign",
			});
			return { missingId, foreignId };
		});

		const archived = await archive(f, [missingId, foreignId, kept.topId]);
		expect(archived._yay).toMatchObject({ isDone: true, notArchivedNodeIds: [missingId, foreignId] });
		expect((await read_node(f, kept.topId)).archiveOperationId).not.toBeNull();
		expect((await read_node(f, foreignId)).archiveOperationId).toBeNull();
		const activity = await read_activity(f, archived._yay!.activityId);
		expect(activity).toMatchObject({ status: "partial", errorMessage: null });
		expect(activity.progress).toMatchObject({ total: 5, completed: 3, blocked: 2 });
		const run = await f.asOwner.query(api.files_archive_runs.get, {
			membershipId: f.db.membershipId,
			runId: archived._yay!.runId,
		});
		expect(run?.notArchived).toEqual([
			{ nodeId: missingId, name: null, message: "Not found" },
			{ nodeId: foreignId, name: null, message: "Not found" },
		]);

		// With nothing else left to archive, a missing id refuses the request, like `rm` of one missing file.
		expect((await archive(f, [missingId, kept.topId]))._nay?.message).toBe("Not found");
	});

	test("a named item a member cannot read gets the same answer as a missing id", async () => {
		const f = await fixture();
		const member = await add_member(f);
		const kept = await seed_tree(f, { name: "member-kept", folderCount: 1, filesPerFolder: 1 });
		const hidden = await seed_tree(f, { name: "member-hidden", folderCount: 1, filesPerFolder: 1 });
		expect(
			(
				await f.asOwner.mutation(api.files_sharing.restrict_node, {
					membershipId: f.db.membershipId,
					nodeId: hidden.topId,
				})
			)._nay,
		).toBeUndefined();

		const archived = await member.asUser.mutation(api.files_nodes.archive_nodes, {
			membershipId: member.membershipId,
			nodeIds: [hidden.topId, kept.topId],
		});
		expect(archived._yay).toMatchObject({ isDone: true, notArchivedNodeIds: [hidden.topId] });
		expect((await read_node(f, hidden.topId)).archiveOperationId).toBeNull();
		const activity = await read_activity(f, archived._yay!.activityId);
		expect(activity).toMatchObject({ status: "partial", errorMessage: null });
		expect(activity.progress).toMatchObject({ total: 4, completed: 3, blocked: 1 });
		const run = await member.asUser.query(api.files_archive_runs.get, {
			membershipId: member.membershipId,
			runId: archived._yay!.runId,
		});
		expect(run?.notArchived).toEqual([{ nodeId: hidden.topId, name: null, message: "Not found" }]);
	});

	test("a page never splits archived items that share a name", async () => {
		const f = await fixture();
		const same = await seed_same_path(f, { name: "same", count: 551, archiveOperationId: null });

		const archived = await archive(f, [same.topId]);
		expect(archived._nay).toBeUndefined();
		if (archived._yay) {
			expect((await run_to_end(f, archived._yay)).activity.status).toBe("succeeded");
		}

		expect((await read_node(f, same.topId)).archiveOperationId).not.toBeNull();
		const operationIds = new Set((await read_state(f)).nodes.map((node) => node.archiveOperationId));
		// Each file keeps its own operation, and the folder has one more.
		expect(operationIds.size).toBe(552);
	});

	test("a second archive of a child commits now, and the job keeps the child's operation", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "busy", folderCount: 6, filesPerFolder: 100 });

		const archived = await archive(f, [tree.topId]);
		expect(archived._yay).not.toBeNull();

		const childArchive = await archive(f, [tree.folderIds[0]!]);
		expect(childArchive._nay).toBeUndefined();
		if (childArchive._yay) await run_to_end(f, childArchive._yay);
		const childOperationId = (await read_node(f, tree.folderIds[0]!)).archiveOperationId;
		expect(childOperationId).not.toBeNull();

		const ended = await run_to_end(f, archived._yay!);
		expect(ended.activity.status).toBe("succeeded");
		expect((await read_node(f, tree.folderIds[0]!)).archiveOperationId).toBe(childOperationId);
		expect((await read_node(f, tree.fileIds[0]!)).archiveOperationId).toBe(childOperationId);
		expect((await read_node(f, tree.topId)).archiveOperationId).not.toBe(childOperationId);
	});

	test("stamps every named item before it walks inside one, and walks the first one's folder first", async () => {
		const f = await fixture();
		const first = await seed_tree(f, { name: "first", folderCount: 100, filesPerFolder: 5 });
		const second = await seed_tree(f, { name: "second", folderCount: 6, filesPerFolder: 100 });
		const insideFirst = new Set<Id<"files_nodes">>([...first.folderIds, ...first.fileIds]);
		const insideSecond = new Set<Id<"files_nodes">>([...second.folderIds, ...second.fileIds]);

		const job = (await archive(f, [first.topId, second.topId]))._yay!;
		for (let count = 0; count < 100; count++) {
			const stamped = new Set(
				(await read_state(f)).nodes.filter((node) => node.archiveOperationId !== null).map((node) => node._id),
			);
			// Both named items leave the tree before the walk stamps anything inside either of them.
			if ([...insideFirst].some((nodeId) => stamped.has(nodeId))) {
				expect(stamped.has(second.topId)).toBe(true);
			}
			// The walk ends inside the first named item before it goes inside the second.
			if ([...insideSecond].some((nodeId) => stamped.has(nodeId))) {
				expect([...insideFirst].filter((nodeId) => !stamped.has(nodeId))).toEqual([]);
			}

			const activity = await read_activity(f, job.activityId);
			if (!activities_is_active(activity.status)) break;
			await step(f, job.runId);
		}
		expect((await read_activity(f, job.activityId)).status).toBe("succeeded");
	}, 120_000);

	test("a step that only clears empty and deleted folders from the queue stops near the limits", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "drain", folderCount: 6, filesPerFolder: 100 });
		const job = (await archive(f, [tree.topId]))._yay!;
		let run = (await f.t.run((ctx) => ctx.db.get("files_archive_runs", job.runId)))!;
		while (run.phase !== "apply") run = (await step(f, job.runId))!;
		const opId = await queue_empty_folders_first({ f, runId: job.runId, archiveOperationId: run.archiveOperationId });

		await expect(step(f, job.runId)).resolves.toMatchObject({ active: true });
		expect(await count_queue(f, opId)).toBeGreaterThan(0);

		expect((await run_to_end(f, job)).activity.status).toBe("succeeded");
		expect((await read_state(f)).nodes.filter((node) => node.archiveOperationId === null)).toEqual([]);
	}, 120_000);
});

describe("apply_file_pending_archive", () => {
	test("a big agent delete runs as a job and removes each proposal when its node is archived", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "agent", folderCount: 4, filesPerFolder: 100 });
		const proposal = await f.t.mutation(internal.files_pending_updates.upsert_file_pending_archive_in_db, {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			userId: f.db.userId,
			target: { kind: "saved", id: tree.topId },
		});
		expect(proposal._nay).toBeUndefined();
		const pendingUpdate = (await f.t.run((ctx) => ctx.db.query("files_pending_updates").first()))!;

		const applied = await f.asOwner.mutation(api.files_pending_updates.apply_file_pending_archive, {
			membershipId: f.db.membershipId,
			target: { kind: "saved", id: tree.topId },
			pendingUpdateId: pendingUpdate._id,
			reviewedRevision: pendingUpdate.revision,
		});
		expect(applied).toEqual({ _yay: null });

		const run = (await f.t.run((ctx) => ctx.db.query("files_archive_runs").first()))!;
		expect(run.pendingUpdateCleanup).toEqual({ reviewedPendingUpdateIds: null });
		// The check fits in the request, so the folder is stamped first and its proposal is gone already.
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", pendingUpdate._id))).toBeNull();
		expect((await read_node(f, tree.topId)).archiveOperationId).not.toBeNull();

		const activity = (await f.t.run((ctx) => ctx.db.query("activities").first()))!;
		const ended = await run_to_end(f, { runId: run._id, activityId: activity._id });
		expect(ended.activity.status).toBe("succeeded");
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", pendingUpdate._id))).toBeNull();
		expect((await read_node(f, tree.topId)).archiveOperationId).not.toBeNull();
	});

	test("a Discard during the check ends the job before anything is archived", async () => {
		const f = await fixture();
		// Bigger than one check step, so the job is still checking when the Discard comes.
		const tree = await seed_tree(f, { name: "discard", folderCount: 6, filesPerFolder: 100 });
		expect(
			(
				await f.t.mutation(internal.files_pending_updates.upsert_file_pending_archive_in_db, {
					organizationId: f.db.organizationId,
					workspaceId: f.db.workspaceId,
					userId: f.db.userId,
					target: { kind: "saved", id: tree.topId },
				})
			)._nay,
		).toBeUndefined();
		const pendingUpdate = (await f.t.run((ctx) => ctx.db.query("files_pending_updates").first()))!;
		const applyArgs = {
			membershipId: f.db.membershipId,
			target: { kind: "saved" as const, id: tree.topId },
			pendingUpdateId: pendingUpdate._id,
			reviewedRevision: pendingUpdate.revision,
		};
		expect(await f.asOwner.mutation(api.files_pending_updates.apply_file_pending_archive, applyArgs)).toEqual({
			_yay: null,
		});
		expect(await f.asOwner.mutation(api.files_pending_updates.discard_file_pending_update, applyArgs)).toEqual({
			_yay: null,
		});

		const run = (await f.t.run((ctx) => ctx.db.query("files_archive_runs").first()))!;
		const activity = (await f.t.run((ctx) => ctx.db.query("activities").first()))!;
		const ended = await run_to_end(f, { runId: run._id, activityId: activity._id });
		expect(ended.activity).toMatchObject({
			status: "failed",
			errorMessage: "The delete was discarded.",
		});
		expect((await read_node(f, tree.topId)).archiveOperationId).toBeNull();
	});

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
		expect(ended.activity).toMatchObject({ status: "failed", errorMessage: "An item inside it is read-only." });
		expect((await read_node(f, tree.topId)).archiveOperationId).toBeNull();
	});
});

describe("files_archive_runs_db_delete_run_batch", () => {
	test("history cleanup deletes the run with its Activity", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "history", folderCount: 4, filesPerFolder: 100 });
		const archived = await archive(f, [tree.topId]);
		const job = archived._yay!;
		await run_to_end(f, job);

		await f.t.run((ctx) => files_archive_runs_db_delete_run_batch(ctx, { runId: job.runId }));

		expect(await f.t.run((ctx) => ctx.db.get("files_archive_runs", job.runId))).toBeNull();
		expect(await f.t.run((ctx) => ctx.db.get("activities", job.activityId))).toBeNull();
		await expect_consistent(f);
	});
});
