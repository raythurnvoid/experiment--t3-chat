// The archive_nodes tests from a lock set after the check on, and the history cleanup tests, split from
// files_archive_runs.test.ts so the two files can run at the same time.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { activities_is_active } from "./activities_db.ts";
import { test_mocks_fill_db_with } from "./setup.test.ts";
import { files_archive_runs_db_check_fast, files_archive_runs_db_delete_run_batch } from "./files_archive_runs.ts";
import { files_subtree_ops_db_find_blocker } from "./files_subtree_ops_db.ts";
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
	lock,
	lock_archived,
	lock_writer,
	folder,
	read_node,
	queue_empty_folders_first,
	count_queue,
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
	test("a lock set after the check does not stop the archive", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "lock", folderCount: 1, filesPerFolder: 74 });

		// The indexes clear the folder, so the request stamps without a check. It stops after 10 stamps.
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
		const tree = await seed_tree(f, { name: "checked", folderCount: 6, filesPerFolder: 20 });
		// The check reads 100 nodes inside the request, and the walk reaches this file last.
		await lock({ f, nodeId: tree.fileIds.at(-1)!, locked: true });

		const small = await seed_tree(f, { name: "checked-small", folderCount: 1, filesPerFolder: 2 });
		await lock({ f, nodeId: small.fileIds[1]!, locked: true });
		const refused = await archive(f, [small.topId]);
		expect(refused._nay?.name).toBe("read_only");
		expect(await f.t.run((ctx) => ctx.db.query("files_archive_runs").collect())).toEqual([]);
		expect(await f.t.run((ctx) => ctx.db.query("files_subtree_ops").collect())).toEqual([]);

		// One index read finds an active read-only file, so even a tree too big to check inside the
		// request is refused there, and the refusal names the file.
		expect(await archive(f, [tree.topId])).toEqual({
			_nay: { name: "read_only", message: '"/checked/d5/f019.md" is read-only. Unlock it, then try again.' },
		});
		expect(await f.t.run((ctx) => ctx.db.query("files_archive_runs").collect())).toEqual([]);

		// An archived read-only file needs the check, because the index cannot tell whether it is inside this
		// folder or in an old archived folder with the same path. So the job checks the tree in steps. The
		// refusal then ends the job without "partway", because nothing changed.
		await lock({ f, nodeId: tree.fileIds.at(-1)!, locked: false });
		expect(await archive(f, [tree.fileIds.at(-1)!])).toEqual({ _yay: null });
		await lock_archived(f, tree.fileIds.at(-1)!);
		const archived = await archive(f, [tree.topId]);
		const ended = await run_to_end(f, archived._yay!);
		expect(ended.activity.status).toBe("failed");
		expect(ended.activity.errorMessage).not.toMatch(/partway/);
		// The refused folder counts once, and the counts add up to the total.
		expect(ended.activity.progress).toMatchObject({ total: 1, completed: 0, skipped: 0, blocked: 1 });
		const state = await read_state(f);
		expect(state.nodes.filter((node) => node.archiveOperationId !== null).map((node) => node.path)).toEqual([
			"/checked/d5/f019.md",
		]);
	});

	test("a writer list inside that does not list the person stops the archive after the check", async () => {
		const f = await fixture();
		const member = await add_member(f);
		const tree = await seed_tree(f, { name: "listed", folderCount: 6, filesPerFolder: 20 });
		await lock_writer({ f, nodeId: tree.fileIds.at(-1)!, userId: member.userId });

		// The index cannot tell who the list names, so the folder stays in the tree while the job checks it.
		const archived = await archive(f, [tree.topId]);
		expect(archived._yay?.waitingNodeIds).toEqual([tree.topId]);
		const ended = await run_to_end(f, archived._yay!);

		expect(ended.activity).toMatchObject({
			status: "failed",
			errorMessage: '"/listed/d5/f019.md" is read-only. Unlock it, then try again.',
		});
		expect((await read_state(f)).nodes.every((node) => node.archiveOperationId === null)).toBe(true);
	});

	test("a running scope job makes the archive check first", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "scoped", folderCount: 6, filesPerFolder: 20 });
		// The scope job rewrites the items inside page by page, so their indexes are not right yet.
		expect(
			(
				await f.asOwner.mutation(api.files_sharing.restrict_node, {
					membershipId: f.db.membershipId,
					nodeId: tree.topId,
				})
			)._nay,
		).toBeUndefined();
		expect((await f.t.run((ctx) => ctx.db.query("files_subtree_ops").unique()))?.status).toBe("running");

		const archived = await archive(f, [tree.topId]);
		expect(archived._yay?.waitingNodeIds).toEqual([tree.topId]);
		expect((await read_node(f, tree.topId)).archiveOperationId).toBeNull();
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
				// The reason names the locked file, so the toast can say what to unlock.
				refusedItems: [
					{ nodeId: refused.topId, message: '"/refused/d0/f001.md" is read-only. Unlock it, then try again.' },
				],
				waitingNodeIds: [],
				isChecking: false,
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
			{
				nodeId: refused.topId,
				path: "/refused",
				message: '"/refused/d0/f001.md" is read-only. Unlock it, then try again.',
			},
		]);
		// The job dialog lists the named items that were archived. The file inside the refused folder is not one.
		expect(run?.archived).toEqual([{ nodeId: kept.topId, path: "/kept" }]);
	});

	test("a refusal found in a later check step counts the refused item once", async () => {
		const f = await fixture();
		const before = await seed_tree(f, { name: "before", folderCount: 1, filesPerFolder: 2 });
		const big = await seed_tree(f, { name: "big-refused", folderCount: 6, filesPerFolder: 20 });
		const after = await seed_tree(f, { name: "after", folderCount: 1, filesPerFolder: 1 });
		// The check reads 100 nodes in each step, and the walk reaches this file last. It is archived, so
		// only the check can refuse it.
		expect(await archive(f, [big.fileIds.at(-1)!])).toEqual({ _yay: null });
		await lock_archived(f, big.fileIds.at(-1)!);

		// The request checks 100 nodes and does not reach the read-only file yet.
		const archived = await archive(f, [before.topId, big.topId, after.topId]);
		expect(archived._yay).toMatchObject({ isDone: false, notArchivedNodeIds: [] });
		const ended = await run_to_end(f, archived._yay!);

		expect(ended.activity.status).toBe("partial");
		expect(ended.activity.progress).toMatchObject({ discovered: 8, total: 8, completed: 7, blocked: 1 });
		const state = await read_state(f);
		const archivedIds = new Set(state.nodes.filter((node) => node.archiveOperationId !== null).map((node) => node._id));
		expect([big.topId, ...big.folderIds, ...big.fileIds.slice(0, -1)].some((nodeId) => archivedIds.has(nodeId))).toBe(
			false,
		);
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
		const big = await seed_tree(f, { name: "big-alone", folderCount: 6, filesPerFolder: 20 });
		const small = await seed_tree(f, { name: "small-archived", folderCount: 1, filesPerFolder: 1 });
		// Archived, so only the check can refuse it.
		expect(await archive(f, [big.fileIds.at(-1)!])).toEqual({ _yay: null });
		await lock_archived(f, big.fileIds.at(-1)!);

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
			{
				nodeId: big.topId,
				path: "/big-alone",
				message: '"/big-alone/d5/f019.md" is read-only. Unlock it, then try again.',
			},
		]);
	});

	test("a named item that is gone when the check reaches it is listed as not found", async () => {
		const f = await fixture();
		const big = await seed_tree(f, { name: "big-first", folderCount: 6, filesPerFolder: 20 });
		// The writer list makes the job check first.
		await lock_writer({ f, nodeId: big.fileIds.at(-1)!, userId: f.db.userId });
		// An empty folder, so deleting it leaves no child without a parent.
		const small = await seed_tree(f, { name: "small-deleted", folderCount: 0, filesPerFolder: 0 });

		const archived = await archive(f, [big.topId, small.topId]);
		expect(archived._yay).toMatchObject({ isDone: false, notArchivedNodeIds: [] });
		// A volume or an upload retry can hard-delete a node while the job still checks.
		await f.t.run((ctx) => ctx.db.delete("files_nodes", small.topId));
		const ended = await run_to_end(f, archived._yay!);

		expect(ended.activity).toMatchObject({ status: "partial", errorMessage: null });
		expect(ended.activity.progress).toMatchObject({ total: 128, completed: 127, skipped: 0, blocked: 1 });
		const run = await f.asOwner.query(api.files_archive_runs.get, {
			membershipId: f.db.membershipId,
			runId: archived._yay!.runId,
		});
		expect(run?.notArchived).toEqual([{ nodeId: small.topId, path: null, message: "Not found" }]);
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
		// 99 reads for the first tree (1 + 2 folders + 2 * 48 files). The second folder is read 100, and its
		// archived read-only folder 101, so the request stops right after it refuses the second folder, with
		// its row still in the queue. Only the check can refuse an archived lock, so the whole archive runs it.
		const first = await seed_tree(f, { name: "first-passed", folderCount: 2, filesPerFolder: 48 });
		const refused = await seed_tree(f, { name: "second-refused", folderCount: 1, filesPerFolder: 0 });
		expect(await archive(f, [refused.folderIds[0]!])).toEqual({ _yay: null });
		await lock_archived(f, refused.folderIds[0]!);

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
		const tree = await seed_tree(f, { name: "shrink", folderCount: 3, filesPerFolder: 100 });
		// An empty folder, so deleting it leaves no child without a parent.
		const emptyId = await folder(f, "/shrink/d2/empty");
		// The writer list makes the job check first, so the check counts the empty folder.
		await lock_writer({ f, nodeId: tree.fileIds[0]!, userId: f.db.userId });

		const job = (await archive(f, [tree.topId]))._yay!;
		let run = (await f.t.run((ctx) => ctx.db.get("files_archive_runs", job.runId)))!;
		while (run.phase !== "apply") run = (await step(f, job.runId))!;
		// The check runs in steps of 100 first. The step that ends it stamped 30 nodes. The walk reaches `d2`
		// after 204, so the empty folder is still active.
		expect((await read_node(f, emptyId)).archiveOperationId).toBeNull();
		await f.t.run((ctx) => ctx.db.delete("files_nodes", emptyId));
		const ended = await run_to_end(f, job);

		expect(ended.activity.status).toBe("succeeded");
		expect(ended.activity.progress).toMatchObject({ total: 305, completed: 304, skipped: 1, blocked: 0 });
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
			{ nodeId: missingId, path: null, message: "Not found" },
			{ nodeId: foreignId, path: null, message: "Not found" },
		]);

		// With nothing else left to archive, a missing id refuses the request, like `rm` of one missing file.
		expect((await archive(f, [missingId, kept.topId]))._nay?.message).toBe("Not found");
	});

	test("a named item a member cannot open is listed as Permission denied", async () => {
		const f = await fixture();
		const member = await add_member(f);
		const kept = await seed_tree(f, { name: "member-kept", folderCount: 1, filesPerFolder: 1 });
		const locked = await seed_tree(f, { name: "member-locked", folderCount: 1, filesPerFolder: 1 });
		expect(
			(
				await f.asOwner.mutation(api.files_sharing.restrict_node, {
					membershipId: f.db.membershipId,
					nodeId: locked.topId,
				})
			)._nay,
		).toBeUndefined();

		const archived = await member.asUser.mutation(api.files_nodes.archive_nodes, {
			membershipId: member.membershipId,
			nodeIds: [locked.topId, kept.topId],
		});
		expect(archived._yay).toMatchObject({ isDone: true, notArchivedNodeIds: [locked.topId] });
		expect((await read_node(f, locked.topId)).archiveOperationId).toBeNull();
		const activity = await read_activity(f, archived._yay!.activityId);
		expect(activity).toMatchObject({ status: "partial", errorMessage: null });
		expect(activity.progress).toMatchObject({ total: 4, completed: 3, blocked: 1 });
		const run = await member.asUser.query(api.files_archive_runs.get, {
			membershipId: member.membershipId,
			runId: archived._yay!.runId,
		});
		expect(run?.notArchived).toEqual([{ nodeId: locked.topId, path: null, message: "Permission denied" }]);
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
		const tree = await seed_tree(f, { name: "busy", folderCount: 6, filesPerFolder: 20 });
		// The writer list makes the job check first, so the child is still active for the second archive.
		await lock_writer({ f, nodeId: tree.fileIds.at(-1)!, userId: f.db.userId });

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
		// The first tree has 201 items in 100 folders, so its check and its walk take several steps. The
		// second only needs items inside it.
		const first = await seed_tree(f, { name: "first", folderCount: 100, filesPerFolder: 1 });
		const second = await seed_tree(f, { name: "second", folderCount: 1, filesPerFolder: 5 });
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

	test("an archive of many named items marks at most 64 busy paths, and they still cover every item", async () => {
		const f = await fixture();
		// 80 named folders, more than the 10 stamps of the request, so the archive is still a job after it.
		const tree = await seed_tree(f, { name: "many", folderCount: 80, filesPerFolder: 0 });
		expect((await archive(f, tree.folderIds))._nay).toBeUndefined();

		const op = (await f.t.run((ctx) => ctx.db.query("files_subtree_ops").unique()))!;
		expect(op.treePaths.length, "the op keeps at most 64 paths, like a restore").toBeLessThanOrEqual(64);
		const blockers = await f.t.run(async (ctx) =>
			Promise.all(
				["/many/d0/", "/many/d79/x.md"].map(async (treePath) =>
					files_subtree_ops_db_find_blocker(ctx, {
						organizationId: f.db.organizationId,
						workspaceId: f.db.workspaceId,
						treePaths: [treePath],
						waiter: null,
					}),
				),
			),
		);
		expect(blockers.map((blocker) => blocker?._id)).toEqual([op._id, op._id]);
	});

	test("a step that only clears empty and deleted folders from the queue stops near the limits", async () => {
		// With a limit of 1,000 queries, clearing 200 + 200 folders needs more than one step. 70 + 70 fit in one.
		const f = await fixture({ transactionLimits: { databaseQueries: 1000 } });
		// 76 items, more than the 10 stamps of the request, so the archive is still a job after it.
		const tree = await seed_tree(f, { name: "drain", folderCount: 1, filesPerFolder: 74 });
		const job = (await archive(f, [tree.topId]))._yay!;
		let run = (await f.t.run((ctx) => ctx.db.get("files_archive_runs", job.runId)))!;
		while (run.phase !== "apply") run = (await step(f, job.runId))!;
		const opId = await queue_empty_folders_first({
			f,
			runId: job.runId,
			archiveOperationId: run.archiveOperationId,
			count: 200,
		});

		await expect(step(f, job.runId)).resolves.toMatchObject({ active: true });
		expect(await count_queue(f, opId)).toBeGreaterThan(0);

		expect((await run_to_end(f, job)).activity.status).toBe("succeeded");
		expect((await read_state(f)).nodes.filter((node) => node.archiveOperationId === null)).toEqual([]);
	}, 120_000);
});

describe("files_archive_runs_db_check_fast", () => {
	test("the fast check reads a few rows for a big folder, and locked items next to it do not count", async () => {
		const f = await fixture();
		const member = await add_member(f);
		const tree = await seed_tree(f, { name: "a", folderCount: 3, filesPerFolder: 100 });
		// The closest paths on both sides of `/a/`: "-" sorts before "/", and the range ends at "/a0".
		const neighbors = [
			await seed_tree(f, { name: "a-x", folderCount: 1, filesPerFolder: 150 }),
			await seed_tree(f, { name: "a0", folderCount: 1, filesPerFolder: 150 }),
		];
		await f.t.run(async (ctx) => {
			for (const neighbor of neighbors) {
				for (const nodeId of [neighbor.topId, ...neighbor.folderIds, ...neighbor.fileIds])
					await ctx.db.patch("files_nodes", nodeId, { writePolicy: { mode: "read_only" } });
			}
		});

		const checked = await f.t.run(async (ctx) => {
			const membership = (await ctx.db.get("organizations_workspaces_users", member.membershipId))!;
			const node = (await ctx.db.get("files_nodes", tree.topId))!;
			const before = await ctx.meta.getTransactionMetrics();
			const result = await files_archive_runs_db_check_fast(ctx, {
				userAuth: { id: member.userId },
				membership,
				nodes: [node],
			});
			const after = await ctx.meta.getTransactionMetrics();
			return {
				isFast: result.isFast,
				refusalCount: result.refusals.size,
				reads: after.documentsRead.used - before.documentsRead.used,
			};
		});

		expect(checked.isFast).toBe(true);
		expect(checked.refusalCount).toBe(0);
		expect(checked.reads).toBeLessThan(10);
	});
});

describe("files_archive_runs_db_delete_run_batch", () => {
	test("history cleanup deletes the run with its Activity", async () => {
		const f = await fixture();
		// 76 items, more than the 10 stamps of the request, so the archive runs as a job.
		const tree = await seed_tree(f, { name: "history", folderCount: 1, filesPerFolder: 74 });
		const archived = await archive(f, [tree.topId]);
		const job = archived._yay!;
		await run_to_end(f, job);

		await f.t.run((ctx) => files_archive_runs_db_delete_run_batch(ctx, { runId: job.runId }));

		expect(await f.t.run((ctx) => ctx.db.get("files_archive_runs", job.runId))).toBeNull();
		expect(await f.t.run((ctx) => ctx.db.get("activities", job.activityId))).toBeNull();
		await expect_consistent(f);
	});
});
