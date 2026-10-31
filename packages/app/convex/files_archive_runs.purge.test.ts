import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { activities_db_require_by_source_id, activities_is_active } from "./activities_db.ts";
import {
	fixture,
	add_member,
	seed_tree,
	archive,
	archive_to_end,
	restore,
	lock_archived,
	read_activity,
	run_to_end,
	step,
	type Fixture,
} from "./files_archive_runs.setup.test.ts";
import { files_subtree_ops_db_delete, files_subtree_ops_db_insert } from "./files_subtree_ops_db.ts";
import { test_mocks } from "./setup.test.ts";
import { files_archive_operation_id_new } from "../shared/files.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function purge(
	f: Fixture,
	nodeIds: Array<Id<"files_nodes">>,
	as: { asUser: Fixture["asOwner"]; membershipId: Id<"organizations_workspaces_users"> } = {
		asUser: f.asOwner,
		membershipId: f.db.membershipId,
	},
) {
	const result = await as.asUser.mutation(api.files_nodes.purge_nodes, { membershipId: as.membershipId, nodeIds });
	if (result._nay) throw new Error(result._nay.message);
	return result._yay;
}

async function purge_job(f: Fixture, runId: Id<"files_archive_runs"> | null) {
	if (!runId) throw new Error("Expected a purge job");
	const activity = await f.t.run((ctx) => activities_db_require_by_source_id(ctx, runId));
	return { runId, activityId: activity._id };
}

async function step_to_end(f: Fixture, job: { runId: Id<"files_archive_runs">; activityId: Id<"activities"> }) {
	for (let count = 0; count < 200; count++) {
		const activity = await read_activity(f, job.activityId);
		if (!activities_is_active(activity.status)) return activity;
		await step(f, job.runId);
	}
	throw new Error("The purge job did not finish");
}

/**
 * Give the file more Yjs updates than one request deletes, so deleting it takes more than one step.
 */
async function add_yjs_updates(f: Fixture, fileNodeId: Id<"files_nodes">, count: number) {
	await f.t.run(async (ctx) => {
		for (let sequence = 1; sequence <= count; sequence++) {
			await ctx.db.insert("files_yjs_updates", {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				fileNodeId,
				sequence,
				update: new ArrayBuffer(8),
				origin: { type: "USER_EDIT", sessionId: "purge-test" },
				createdBy: f.db.userId,
				createdAt: Date.now(),
			});
		}
	});
}

async function list_workspace_paths(f: Fixture) {
	const nodes = await f.t.run((ctx) => ctx.db.query("files_nodes").collect());
	return nodes.map((node) => node.path).toSorted();
}

describe("files_nodes.purge_nodes", () => {
	test("deletes every page of a folder and keeps a read-only file with its folders", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "big", folderCount: 2, filesPerFolder: 55 });
		const lockedId = tree.fileIds[3]!;
		await archive_to_end(f, tree.topId);
		// Archived items can share a name. Two of them sit in the first folder under their own operations.
		await f.t.run(async (ctx) => {
			for (const index of [0, 1]) {
				await ctx.db.insert("files_nodes", {
					...test_mocks.files.base(),
					organizationId: f.db.organizationId,
					workspaceId: f.db.workspaceId,
					createdBy: f.db.userId,
					updatedBy: f.db.userId,
					parentId: tree.folderIds[0]!,
					name: "same.md",
					sortName: files_sort_text_key("same.md"),
					kind: "file",
					path: "/big/d0/same.md",
					treePath: "/big/d0/same.md",
					pathDepth: 3,
					archiveOperationId: files_archive_operation_id_new(Date.now() - 1000 * (index + 1)),
				});
			}
		});
		await lock_archived(f, lockedId);

		const started = await purge(f, [tree.topId]);
		expect(started).toMatchObject({ itemCount: 1, deletedCount: 0 });
		const job = await purge_job(f, started.runId);
		const ended = await step_to_end(f, job);

		expect(ended.status).toBe("partial");
		expect(await list_workspace_paths(f), "only the read-only file and its folders stay").toEqual([
			"/big",
			"/big/d0",
			"/big/d0/f003.md",
		]);
		const outcomes = await f.asOwner.query(api.files_archive_runs.list_outcomes, {
			membershipId: f.db.membershipId,
			runId: job.runId,
			paginationOpts: { numItems: 10, cursor: null },
		});
		expect(outcomes.page.map(({ kind, path, message }) => ({ kind, path, message }))).toEqual([
			{
				kind: "refused",
				path: "/big/d0/f003.md",
				message: "This item is read-only. Turn off Read-only, then try again.",
			},
			{
				kind: "retained_folder",
				path: "/big/d0",
				message: "This folder still holds items that could not be deleted.",
			},
			{ kind: "retained_folder", path: "/big", message: "This folder still holds items that could not be deleted." },
		]);
	});

	test("keeps a restricted folder that the person cannot manage", async () => {
		const f = await fixture();
		const member = await add_member(f);
		const tree = await seed_tree(f, { name: "shared", folderCount: 2, filesPerFolder: 1 });
		const [deniedId, allowedId] = tree.folderIds as [Id<"files_nodes">, Id<"files_nodes">];
		// The member can manage `/shared`, but can only edit its restricted folder `/shared/d0`.
		await f.t.run(async (ctx) => {
			const nodes = await ctx.db.query("files_nodes").collect();
			for (const node of nodes) {
				const isDenied = node._id === deniedId || node.parentId === deniedId;
				await ctx.db.patch("files_nodes", node._id, {
					restrictedScopeNodeId: isDenied ? deniedId : tree.topId,
					isRestrictedScopeRoot: node._id === deniedId || node._id === tree.topId,
					parentScopeNodeId: node._id === tree.topId ? null : node._id === deniedId ? tree.topId : undefined,
				});
			}
			for (const [resourceId, permissions] of [
				[tree.topId, ["content.read", "content.write", "content.permissions.manage"]],
				[deniedId, ["content.read", "content.write"]],
			] as const) {
				for (const permission of permissions) {
					await ctx.db.insert("access_control_permission_grants", {
						organizationId: f.db.organizationId,
						workspaceId: f.db.workspaceId,
						resourceKind: "file",
						resourceId,
						principalKind: "user",
						userId: member.userId,
						permission,
						createdAt: Date.now(),
						updatedAt: Date.now(),
					});
				}
			}
		});
		await archive_to_end(f, tree.topId);

		const started = await purge(f, [tree.topId], member);
		const ended = await step_to_end(f, await purge_job(f, started.runId));

		expect(ended.status).toBe("partial");
		expect(await list_workspace_paths(f)).toEqual(["/shared", "/shared/d0", "/shared/d0/f000.md"]);
		expect(await f.t.run((ctx) => ctx.db.get("files_nodes", allowedId))).toBeNull();
	});

	test("Stop finishes the file it is deleting, then keeps the rest", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "stop", folderCount: 1, filesPerFolder: 2 });
		const [bigId, smallId] = tree.fileIds as [Id<"files_nodes">, Id<"files_nodes">];
		await add_yjs_updates(f, bigId, 300);
		await archive_to_end(f, tree.topId);
		// A job that ended long ago left its id on the file. The new job takes the file over.
		await f.t.run(async (ctx) => {
			const endedRun = (await ctx.db.query("files_archive_runs").first())!;
			await ctx.db.patch("files_nodes", bigId, { purgeRunId: endedRun._id });
		});

		const job = await purge_job(f, (await purge(f, [bigId, smallId])).runId);
		expect((await f.t.run((ctx) => ctx.db.get("files_nodes", bigId)))?.purgeRunId, "the request started the file").toBe(
			job.runId,
		);
		expect(
			await f.asOwner.mutation(api.activities.request_stop, {
				membershipId: f.db.membershipId,
				activityId: job.activityId,
			}),
		).toEqual({ _yay: null });
		expect((await read_activity(f, job.activityId)).status).toBe("stopping");
		const ended = await step_to_end(f, job);

		expect(ended.status).toBe("canceled");
		expect(await f.t.run((ctx) => ctx.db.get("files_nodes", bigId)), "the started file is gone").toBeNull();
		const left = await f.t.run(async (ctx) => ({
			updates: (await ctx.db.query("files_yjs_updates").collect()).length,
			small: await ctx.db.get("files_nodes", smallId),
		}));
		expect(left.updates).toBe(0);
		expect(left.small?.archiveOperationId, "the file the job did not reach stays archived").not.toBeNull();
		expect(left.small?.purgeRunId).toBeUndefined();
	});

	test("waits as a queued job while an op on its paths runs, then goes on", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "wait", folderCount: 1, filesPerFolder: 1 });
		const fileId = tree.fileIds[0]!;
		await add_yjs_updates(f, fileId, 300);
		await archive_to_end(f, tree.topId);
		const job = await purge_job(f, (await purge(f, [tree.topId])).runId);

		const scopeOpId = await f.t.run((ctx) =>
			files_subtree_ops_db_insert(ctx, {
				op: {
					organizationId: f.db.organizationId,
					workspaceId: f.db.workspaceId,
					userId: f.db.userId,
					kind: "scope",
					status: "running",
					rootNodeIds: [],
					treePaths: ["/wait/"],
					blockedByOpId: null,
				},
				now: Date.now(),
			}),
		);
		await step(f, job.runId);
		expect((await read_activity(f, job.activityId)).status, "the job waits without new steps").toBe("queued");

		await f.t.run((ctx) => files_subtree_ops_db_delete(ctx, { opId: scopeOpId, now: Date.now() }));
		expect((await step_to_end(f, job)).status).toBe("succeeded");
		expect(await f.t.run((ctx) => ctx.db.get("files_nodes", tree.topId))).toBeNull();
	});

	test("a file that turns busy after its first write waits instead of staying locked", async () => {
		const f = await fixture();
		// A file with nothing to delete but its node. Its first call sets `purgeRunId`, then finds an
		// index run that still reads it.
		const { fileId, stateId } = await f.t.run(async (ctx) => {
			const fileId = await ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				createdBy: f.db.userId,
				updatedBy: f.db.userId,
				parentId: "root",
				name: "bare.md",
				sortName: files_sort_text_key("bare.md"),
				kind: "file",
				path: "/bare.md",
				treePath: "/bare.md",
				pathDepth: 1,
				archiveOperationId: files_archive_operation_id_new(Date.now() - 1000),
			});
			const placement = {
				parentId: "root" as const,
				kind: "file" as const,
				name: "bare.md",
				sortName: files_sort_text_key("bare.md"),
				path: "/bare.md",
				treePath: "/bare.md",
				archiveOperationId: null,
				restrictedScopeNodeId: null,
				isRestrictedScopeRoot: false,
			};
			const indexRunId = await ctx.db.insert("files_index_runs", {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				fileNodeId: fileId,
				indexRevision: 1,
				contentRevision: 1,
				contentHeadId: null,
				previousHeadId: null,
				chunkCount: 0,
				textKind: "rich_text",
				placement,
				phase: "build_text",
				cursor: null,
				nextPosition: 0,
				step: 0,
				generation: 0,
				nextAttemptAt: 0,
				scheduledId: null,
				slotGeneration: null,
				published: false,
				aborting: false,
				error: null,
			});
			const stateId = await ctx.db.insert("files_index_states", {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				fileNodeId: fileId,
				contentRevision: 1,
				requestedRevision: 1,
				requestedHeadId: null,
				publishedRevision: 0,
				publishedHeadId: null,
				activeRunId: indexRunId,
				needsRun: false,
				nextAttemptAt: 0,
				movePublication: null,
			});
			return { fileId, stateId };
		});

		const job = await purge_job(f, (await purge(f, [fileId])).runId);
		expect((await read_activity(f, job.activityId)).status, "the job waits for the index run").toBe("running");
		await f.t.run((ctx) => ctx.db.patch("files_index_states", stateId, { activeRunId: null }));
		expect((await step_to_end(f, job)).status).toBe("succeeded");
		expect(await f.t.run((ctx) => ctx.db.get("files_nodes", fileId))).toBeNull();
	});

	test("Empty archive deletes only what was archived before it started, in its own area", async () => {
		const f = await fixture();
		const insert_archived = (fields: { name: string; archiveOperationId: string }) =>
			f.t.run((ctx) =>
				ctx.db.insert("files_nodes", {
					...test_mocks.files.base(),
					organizationId: f.db.organizationId,
					workspaceId: f.db.workspaceId,
					createdBy: f.db.userId,
					updatedBy: f.db.userId,
					parentId: "root",
					name: fields.name,
					sortName: files_sort_text_key(fields.name),
					kind: "file",
					path: `/${fields.name}`,
					treePath: `/${fields.name}`,
					pathDepth: 1,
					archiveOperationId: fields.archiveOperationId,
				}),
			);
		// More top items than one page, each under its own older operation.
		for (let index = 0; index < 55; index++) {
			await insert_archived({
				name: `old-${String(index).padStart(2, "0")}.md`,
				archiveOperationId: files_archive_operation_id_new(Date.now() - 10_000 - index),
			});
		}
		await insert_archived({ name: "legacy.md", archiveOperationId: crypto.randomUUID() });
		await insert_archived({ name: "unknown.md", archiveOperationId: "no-time" });
		// A restricted folder is another area, so its archive stays.
		await f.t.run(async (ctx) => {
			const restrictedId = await ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				createdBy: f.db.userId,
				updatedBy: f.db.userId,
				parentId: "root",
				name: "private",
				sortName: files_sort_text_key("private"),
				kind: "folder",
				path: "/private",
				treePath: "/private/",
				pathDepth: 1,
				isRestrictedScopeRoot: true,
				parentScopeNodeId: null,
			});
			await ctx.db.patch("files_nodes", restrictedId, { restrictedScopeNodeId: restrictedId });
			await ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				createdBy: f.db.userId,
				updatedBy: f.db.userId,
				parentId: restrictedId,
				name: "inner.md",
				sortName: files_sort_text_key("inner.md"),
				kind: "file",
				path: "/private/inner.md",
				treePath: "/private/inner.md",
				pathDepth: 2,
				restrictedScopeNodeId: restrictedId,
				archiveOperationId: files_archive_operation_id_new(Date.now() - 10_000),
			});
		});
		// An archive job that still stamps the items inside its folder.
		const tree = await seed_tree(f, { name: "stamping", folderCount: 1, filesPerFolder: 60 });
		const stamping = await archive(f, [tree.topId]);
		expect(stamping._yay?.isDone).toBe(false);
		vi.setSystemTime(Date.now() + 1000);

		const emptied = await f.asOwner.mutation(api.files_nodes.empty_archive, {
			membershipId: f.db.membershipId,
			area: null,
		});
		if (emptied._nay) throw new Error(emptied._nay.message);
		expect(
			await f.asOwner.mutation(api.files_nodes.empty_archive, { membershipId: f.db.membershipId, area: null }),
			"one Empty archive at a time",
		).toMatchObject({ _nay: { name: "busy" } });
		// The archive job ends after Empty archive started, so its items still stay.
		await run_to_end(f, stamping._yay!);
		const ended = await step_to_end(f, await purge_job(f, emptied._yay.runId));

		expect(ended.status).toBe("succeeded");
		const paths = await list_workspace_paths(f);
		expect(paths.filter((path) => !path.startsWith("/stamping"))).toEqual([
			"/private",
			"/private/inner.md",
			"/unknown.md",
		]);
		expect(paths, "the archive that was still running keeps its items").toContain("/stamping");
		const run = await f.t.run((ctx) => ctx.db.get("files_archive_runs", emptied._yay.runId!));
		expect(run?.emptyArchive).toMatchObject({ foundCount: 56, deletedCount: 56, keptCount: 0 });
	});

	test("a restore of the same archive waits until the purge ends", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "race", folderCount: 1, filesPerFolder: 2 });
		const [purgedId, restoredId] = tree.fileIds as [Id<"files_nodes">, Id<"files_nodes">];
		await add_yjs_updates(f, purgedId, 300);
		const archived = await archive(f, [purgedId, restoredId]);
		expect(archived).toEqual({ _yay: null });

		const purgeJob = await purge_job(f, (await purge(f, [purgedId])).runId);
		// Restore brings back the whole archive operation, so it reaches the file being deleted.
		const restored = await restore(f, [restoredId]);
		if (restored._nay || !restored._yay) throw new Error("Expected a restore job");
		expect((await read_activity(f, restored._yay.activityId)).status).toBe("queued");

		expect((await step_to_end(f, purgeJob)).status).toBe("succeeded");
		expect((await step_to_end(f, restored._yay)).status).toBe("succeeded");
		const nodes = await f.t.run(async (ctx) => ({
			purged: await ctx.db.get("files_nodes", purgedId),
			restored: await ctx.db.get("files_nodes", restoredId),
		}));
		expect(nodes.purged).toBeNull();
		expect(nodes.restored?.archiveOperationId).toBeNull();
	});
});
