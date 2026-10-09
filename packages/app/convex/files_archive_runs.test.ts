import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { activities_is_active } from "./activities_db.ts";
import { test_convex, test_mocks, test_mocks_fill_db_with } from "./setup.test.ts";
import { files_archive_runs_db_delete_run_batch } from "./files_archive_runs.ts";
import { files_subtree_ops_db_delete, files_subtree_ops_db_insert } from "./files_subtree_ops.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";

// Scheduled steps never run on their own under fake timers. Each test drives the op's steps itself.
beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

async function fixture() {
	const t = test_convex({ transactionLimits: true });
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	return { t, db, asOwner };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/**
 * A workspace member who is not the owner. The owner passes every permission check.
 */
async function add_member(f: Fixture) {
	const member = await f.t.run(async (ctx) => {
		const userId = await ctx.db.insert("users", { clerkUserId: "archive-other-member" });
		const membershipId = await ctx.db.insert("organizations_workspaces_users", {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			userId,
			active: true,
			pendingOrganizationRemoval: false,
			updatedAt: Date.now(),
		});
		await ctx.db.insert("access_control_role_assignments", {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			userId,
			role: "member",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
		return { userId, membershipId };
	});
	return { ...member, asUser: f.t.withIdentity({ issuer: "https://clerk.test", external_id: member.userId }) };
}

/**
 * Insert `/<name>` with `folderCount` folders of `filesPerFolder` files. Each file has one text chunk
 * and one metadata doc, so a test can check that the side docs follow their node.
 */
async function seed_tree(f: Fixture, args: { name: string; folderCount: number; filesPerFolder: number }) {
	return await f.t.run(async (ctx) => {
		const insert_node = (fields: {
			parentId: Doc<"files_nodes">["parentId"];
			name: string;
			kind: "file" | "folder";
			path: string;
		}) =>
			ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				createdBy: f.db.userId,
				updatedBy: f.db.userId,
				parentId: fields.parentId,
				name: fields.name,
				sortName: files_sort_text_key(fields.name),
				kind: fields.kind,
				path: fields.path,
				treePath: fields.kind === "folder" ? `${fields.path}/` : fields.path,
				pathDepth: fields.path.split("/").length - 1,
			});

		const topPath = `/${args.name}`;
		const topId = await insert_node({ parentId: "root", name: args.name, kind: "folder", path: topPath });
		const folderIds = [];
		const fileIds = [];
		for (let folderIndex = 0; folderIndex < args.folderCount; folderIndex++) {
			const folderPath = `${topPath}/d${folderIndex}`;
			const folderId = await insert_node({
				parentId: topId,
				name: `d${folderIndex}`,
				kind: "folder",
				path: folderPath,
			});
			folderIds.push(folderId);
			for (let fileIndex = 0; fileIndex < args.filesPerFolder; fileIndex++) {
				const name = `f${String(fileIndex).padStart(3, "0")}.md`;
				const path = `${folderPath}/${name}`;
				const fileNodeId = await insert_node({ parentId: folderId, name, kind: "file", path });
				fileIds.push(fileNodeId);
				const textChunkId = await ctx.db.insert("files_text_chunks", {
					organizationId: f.db.organizationId,
					workspaceId: f.db.workspaceId,
					fileNodeId,
					sourceKind: "committed",
					yjsSequence: 1,
					chunkIndex: 0,
					textChunk: name,
					startIndex: 0,
					endIndex: name.length,
					lineStart: 1,
					lineEnd: 1,
					chunkFlags: 0,
				});
				await ctx.db.insert("files_plain_text_chunks", {
					organizationId: f.db.organizationId,
					workspaceId: f.db.workspaceId,
					fileNodeId,
					sourceKind: "committed",
					yjsSequence: 1,
					textChunkId,
					chunkIndex: 0,
					path,
					plainTextChunk: name,
					textChunk: name,
					startIndex: 0,
					endIndex: name.length,
					lineStart: 1,
					lineEnd: 1,
					chunkFlags: 0,
					hasChunkAbove: false,
					hasChunkBelow: false,
				});
				await ctx.db.insert("files_metadata_docs", {
					organizationId: f.db.organizationId,
					workspaceId: f.db.workspaceId,
					fileNodeId,
					sourceKind: "committed",
					yjsSequence: 1,
					path,
					treePath: path,
					fieldPath: "frontmatter.tag",
					docKind: "field",
				});
			}
		}
		return { topId, folderIds, fileIds };
	});
}

/**
 * Insert the folder `/<name>` with `count` archived files that all have the path `/<name>/same.md`.
 * A page of 50 ends inside that group, so a check walk must read the other `count - 50` in one more
 * read. Each file gets its own operation id unless `archiveOperationId` is given.
 */
async function seed_same_path(f: Fixture, args: { name: string; count: number; archiveOperationId: string | null }) {
	return await f.t.run(async (ctx) => {
		const fields = {
			...test_mocks.files.base(),
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			createdBy: f.db.userId,
			updatedBy: f.db.userId,
		};
		const topId = await ctx.db.insert("files_nodes", {
			...fields,
			parentId: "root",
			name: args.name,
			sortName: files_sort_text_key(args.name),
			kind: "folder",
			path: `/${args.name}`,
			treePath: `/${args.name}/`,
			pathDepth: 1,
		});
		const fileIds = [];
		for (let index = 0; index < args.count; index++) {
			fileIds.push(
				await ctx.db.insert("files_nodes", {
					...fields,
					parentId: topId,
					name: "same.md",
					sortName: files_sort_text_key("same.md"),
					kind: "file",
					path: `/${args.name}/same.md`,
					treePath: `/${args.name}/same.md`,
					pathDepth: 2,
					archiveOperationId: args.archiveOperationId ?? crypto.randomUUID(),
				}),
			);
		}
		return { topId, fileIds };
	});
}

async function read_state(f: Fixture) {
	return await f.t.run(async (ctx) => ({
		nodes: await ctx.db.query("files_nodes").collect(),
		chunks: await ctx.db.query("files_plain_text_chunks").collect(),
		metadataDocs: await ctx.db.query("files_metadata_docs").collect(),
	}));
}

/**
 * The rules the job must keep after every step: each side doc says the same as its node, no active
 * node sits inside an archived folder, and no two active nodes share a folder and a name. An archive
 * stamps a folder before its children, so while an archive op runs, its folders may still hold active
 * children.
 */
async function expect_consistent(f: Fixture) {
	const state = await read_state(f);
	const runningArchiveOperationIds = new Set(
		await f.t.run(async (ctx) => {
			const operationIds = [];
			for (const op of await ctx.db.query("files_subtree_ops").collect()) {
				if (op.kind === "archive") {
					operationIds.push((await ctx.db.get("files_archive_runs", op.archiveRunId))!.archiveOperationId);
				}
			}
			return operationIds;
		}),
	);
	const nodeById = new Map(state.nodes.map((node) => [node._id, node]));

	// Proposal side docs follow their proposal, not the saved node.
	const committedSideDocs = [...state.chunks, ...state.metadataDocs].filter(
		(sideDoc) => sideDoc.sourceKind === "committed",
	);
	const sideDocMismatches = committedSideDocs.flatMap((sideDoc) => {
		const node = nodeById.get(sideDoc.fileNodeId)!;
		const archiveOperationId = sideDoc.archiveOperationId ?? null;
		return archiveOperationId === node.archiveOperationId && sideDoc.path === node.path
			? []
			: [{ path: node.path, sideDocPath: sideDoc.path, node: node.archiveOperationId, sideDoc: archiveOperationId }];
	});
	expect(sideDocMismatches).toEqual([]);

	const activeInsideArchived = state.nodes.filter((node) => {
		const parentOperationId = node.parentId === "root" ? null : nodeById.get(node.parentId)!.archiveOperationId;
		return (
			node.archiveOperationId === null &&
			parentOperationId !== null &&
			!runningArchiveOperationIds.has(parentOperationId)
		);
	});
	expect(activeInsideArchived.map((node) => node.path)).toEqual([]);

	// Two active items never share a folder and a name.
	const activeNames = new Set<string>();
	const sameName = [];
	for (const node of state.nodes) {
		if (node.archiveOperationId !== null) continue;
		const key = `${node.parentId}/${node.name}`;
		if (activeNames.has(key)) sameName.push(node.path);
		activeNames.add(key);
	}
	expect(sameName).toEqual([]);

	return state;
}

async function read_activity(f: Fixture, activityId: Id<"activities">) {
	const activity = await f.t.run((ctx) => ctx.db.get("activities", activityId));
	if (activity?.source.kind !== "files_archive_run") throw new Error("Missing archive activity");
	return { ...activity, source: activity.source };
}

/**
 * Run the step the scheduler would run next. A queued op whose blocker ended starts first, like the
 * scheduled `promote`.
 */
async function step(f: Fixture, runId: Id<"files_archive_runs">) {
	const op = await f.t.run((ctx) =>
		ctx.db
			.query("files_subtree_ops")
			.withIndex("by_archiveRun", (q) => q.eq("archiveRunId", runId))
			.unique(),
	);
	if (op?.status === "queued" && op.blockedByOpId === null) {
		await f.t.mutation(internal.files_subtree_ops.promote, { opId: op._id });
	}
	if (op) {
		const walk = await f.t.run((ctx) =>
			ctx.db
				.query("files_subtree_op_walks")
				.withIndex("by_op", (q) => q.eq("opId", op._id))
				.unique(),
		);
		await f.t.mutation(internal.files_subtree_ops.advance, { opId: op._id, step: walk!.step });
	}
	return await f.t.run((ctx) => ctx.db.get("files_archive_runs", runId));
}

/**
 * Run the job to its end and check both rules after every step. Returns the step count.
 */
async function run_to_end(f: Fixture, job: { runId: Id<"files_archive_runs">; activityId: Id<"activities"> }) {
	await expect_consistent(f);
	for (let count = 1; count <= 100; count++) {
		await step(f, job.runId);
		await expect_consistent(f);
		const activity = await read_activity(f, job.activityId);
		if (!activities_is_active(activity.status) || activity.status === "awaiting_input") {
			return { steps: count, activity };
		}
	}
	throw new Error("The archive job did not finish");
}

async function archive(f: Fixture, nodeIds: Array<Id<"files_nodes">>) {
	return await f.asOwner.mutation(api.files_nodes.archive_nodes, { membershipId: f.db.membershipId, nodeIds });
}

async function restore(f: Fixture, nodeIds: Array<Id<"files_nodes">>) {
	return await f.asOwner.mutation(api.files_nodes.unarchive_nodes, { membershipId: f.db.membershipId, nodeIds });
}

async function lock(args: { f: Fixture; nodeId: Id<"files_nodes">; locked: boolean }) {
	const { f, locked, nodeId } = args;

	expect(
		await f.asOwner.mutation(api.files_nodes.set_node_write_policy, {
			membershipId: f.db.membershipId,
			nodeId,
			writePolicy: locked ? { mode: "read_only" } : null,
		}),
	).toEqual({ _yay: null });
}

async function folder(f: Fixture, path: string) {
	const created = await f.t.mutation(internal.files_nodes.create_folder_node_by_path, {
		organizationId: f.db.organizationId,
		workspaceId: f.db.workspaceId,
		userId: f.db.userId,
		path,
	});
	if (created._nay) throw new Error(created._nay.message);
	return created._yay.nodeId;
}

async function read_node(f: Fixture, nodeId: Id<"files_nodes">) {
	return (await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId)))!;
}

/**
 * Make an archived node read-only. The lock API works on active nodes, so copy the policy from one.
 */
async function lock_archived(f: Fixture, nodeId: Id<"files_nodes">) {
	const lockedFolder = await folder(f, `/locked-${nodeId}`);
	await lock({ f, nodeId: lockedFolder, locked: true });
	const writePolicy = (await read_node(f, lockedFolder)).writePolicy;
	await f.t.run((ctx) => ctx.db.patch("files_nodes", nodeId, { writePolicy }));
}

/**
 * Copy the file's metadata doc `count` more times. With 2,000 extra docs the file has more side docs
 * than a move may write in one mutation.
 */
async function add_metadata_docs(args: { f: Fixture; fileNodeId: Id<"files_nodes">; count: number }) {
	const { f, fileNodeId, count } = args;

	await f.t.run(async (ctx) => {
		const metadata = (await ctx.db
			.query("files_metadata_docs")
			.withIndex("by_organization_workspace_fileNode_fieldPath", (q) =>
				q.eq("organizationId", f.db.organizationId).eq("workspaceId", f.db.workspaceId).eq("fileNodeId", fileNodeId),
			)
			.first())!;
		const { _id, _creationTime, ...fields } = metadata;
		for (let index = 0; index < count; index++) {
			await ctx.db.insert("files_metadata_docs", { ...fields, fieldPath: `frontmatter.tag${index}` });
		}
	});
}

/**
 * Put 1,200 deleted folders and 1,200 empty folders at the front of the job's queue, before the rows
 * the job queued itself. The empty folders get `archiveOperationId`. Clearing all of them needs more
 * reads than one mutation may do.
 */
async function queue_empty_folders_first(args: {
	f: Fixture;
	runId: Id<"files_archive_runs">;
	archiveOperationId: string | null;
}) {
	const { f, runId, archiveOperationId } = args;

	const opId = await f.t.run(
		async (ctx) =>
			(await ctx.db
				.query("files_subtree_ops")
				.withIndex("by_archiveRun", (q) => q.eq("archiveRunId", runId))
				.unique())!._id,
	);
	for (const isDeleted of [true, false]) {
		await f.t.run(async (ctx) => {
			for (let index = 0; index < 1200; index++) {
				const name = `${isDeleted ? "deleted" : "empty"}-${index}`;
				const nodeId = await ctx.db.insert("files_nodes", {
					...test_mocks.files.base(),
					organizationId: f.db.organizationId,
					workspaceId: f.db.workspaceId,
					createdBy: f.db.userId,
					updatedBy: f.db.userId,
					parentId: "root",
					name,
					sortName: files_sort_text_key(name),
					path: `/${name}`,
					treePath: `/${name}/`,
					pathDepth: 1,
					archiveOperationId,
				});
				if (isDeleted) await ctx.db.delete("files_nodes", nodeId);
				await ctx.db.insert("files_subtree_op_nodes", {
					opId,
					// Take these rows before the job's own rows, which get small numbers.
					sequence: 1_000_000 + (isDeleted ? 0 : 1200) + index,
					nodeId,
					nodeDone: true,
					cursor: null,
					pending: [],
				});
			}
		});
	}
	return opId;
}

async function count_queue(f: Fixture, opId: Id<"files_subtree_ops">) {
	return await f.t.run(
		async (ctx) =>
			(
				await ctx.db
					.query("files_subtree_op_nodes")
					.withIndex("by_op_sequence", (q) => q.eq("opId", opId))
					.collect()
			).length,
	);
}

/**
 * Archive a big tree to the end as one operation.
 */
async function archive_to_end(f: Fixture, topId: Id<"files_nodes">) {
	const archived = await archive(f, [topId]);
	if (archived._nay || !archived._yay) throw new Error("Expected an archive job");
	const ended = await run_to_end(f, archived._yay);
	expect(ended.activity.status).toBe("succeeded");
}

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

describe("unarchive_nodes", () => {
	test("a restore waits for a job on its second root", async () => {
		const f = await fixture();
		const first = await seed_tree(f, { name: "a", folderCount: 1, filesPerFolder: 1 });
		const second = await seed_tree(f, { name: "b", folderCount: 1, filesPerFolder: 1 });
		expect(await archive(f, [first.fileIds[0]!, second.fileIds[0]!])).toEqual({ _yay: null });
		const blockerId = await f.t.run((ctx) =>
			files_subtree_ops_db_insert(ctx, {
				op: {
					kind: "scope",
					organizationId: f.db.organizationId,
					workspaceId: f.db.workspaceId,
					userId: f.db.userId,
					status: "running",
					blockedByOpId: null,
					rootNodeIds: [second.topId],
					treePaths: ["/b/"],
				},
				now: Date.now(),
			}),
		);

		const restored = await restore(f, [first.fileIds[0]!]);
		expect(restored._nay).toBeUndefined();
		expect(restored._yay).not.toBeNull();
		const op = await f.t.run((ctx) =>
			ctx.db
				.query("files_subtree_ops")
				.withIndex("by_archiveRun", (q) => q.eq("archiveRunId", restored._yay!.runId))
				.unique(),
		);
		expect(op).toMatchObject({ kind: "restore", status: "queued", blockedByOpId: blockerId });
		expect((await read_activity(f, restored._yay!.activityId)).feedVisible).toBe(false);
		expect((await read_node(f, first.fileIds[0]!)).archiveOperationId).not.toBeNull();
		expect((await read_node(f, second.fileIds[0]!)).archiveOperationId).not.toBeNull();

		await f.t.run((ctx) => files_subtree_ops_db_delete(ctx, { opId: blockerId, now: Date.now() }));
		const ended = await run_to_end(f, restored._yay!);
		expect(ended.activity.status).toBe("succeeded");
		expect((await read_node(f, first.fileIds[0]!)).archiveOperationId).toBeNull();
		expect((await read_node(f, second.fileIds[0]!)).archiveOperationId).toBeNull();
	});

	test("discovery still finds a root renamed before its cursor", async () => {
		const f = await fixture();
		const archived = await seed_same_path(f, { name: "cursor", count: 51, archiveOperationId: crypto.randomUUID() });
		const restored = await restore(f, [archived.fileIds[0]!]);
		expect(restored._nay).toBeUndefined();
		expect((await f.t.run((ctx) => ctx.db.get("files_archive_runs", restored._yay!.runId)))?.phase).toBe("discover");
		expect(
			await f.asOwner.mutation(api.files_nodes.rename_node, {
				membershipId: f.db.membershipId,
				nodeId: archived.fileIds.at(-1)!,
				path: "a.md",
			}),
		).toEqual({ _yay: null });
		expect((await read_node(f, archived.fileIds.at(-1)!)).treePath).toBe("/cursor/a.md");
		const blockerId = await f.t.run((ctx) =>
			files_subtree_ops_db_insert(ctx, {
				op: {
					kind: "scope",
					organizationId: f.db.organizationId,
					workspaceId: f.db.workspaceId,
					userId: f.db.userId,
					status: "running",
					blockedByOpId: null,
					rootNodeIds: [archived.fileIds.at(-1)!],
					treePaths: ["/cursor/a.md"],
				},
				now: Date.now(),
			}),
		);

		await step(f, restored._yay!.runId);
		const op = await f.t.run((ctx) =>
			ctx.db
				.query("files_subtree_ops")
				.withIndex("by_archiveRun", (q) => q.eq("archiveRunId", restored._yay!.runId))
				.unique(),
		);
		expect(op?.treePaths).toContain("/cursor/a.md");
		expect(op).toMatchObject({ status: "queued", blockedByOpId: blockerId });
	});

	test("a queued restore checks a root renamed while it waited", async () => {
		const f = await fixture();
		const archived = await seed_same_path(f, { name: "queued", count: 51, archiveOperationId: crypto.randomUUID() });
		const blocker = (treePath: string) =>
			f.t.run((ctx) =>
				files_subtree_ops_db_insert(ctx, {
					op: {
						kind: "scope",
						organizationId: f.db.organizationId,
						workspaceId: f.db.workspaceId,
						userId: f.db.userId,
						status: "running",
						blockedByOpId: null,
						rootNodeIds: [archived.fileIds[0]!],
						treePaths: [treePath],
					},
					now: Date.now(),
				}),
			);
		const restored = await restore(f, [archived.fileIds[0]!]);
		expect(restored._nay).toBeUndefined();
		expect((await f.t.run((ctx) => ctx.db.get("files_archive_runs", restored._yay!.runId)))?.phase).toBe("discover");
		const firstBlockerId = await blocker("/queued/same.md");
		await step(f, restored._yay!.runId);
		const opId = await f.t.run(
			async (ctx) =>
				(await ctx.db
					.query("files_subtree_ops")
					.withIndex("by_archiveRun", (q) => q.eq("archiveRunId", restored._yay!.runId))
					.unique())!._id,
		);
		expect(await f.t.run((ctx) => ctx.db.get("files_subtree_ops", opId))).toMatchObject({
			status: "queued",
			blockedByOpId: firstBlockerId,
		});
		expect(
			await f.asOwner.mutation(api.files_nodes.rename_node, {
				membershipId: f.db.membershipId,
				nodeId: archived.fileIds[1]!,
				path: "a.md",
			}),
		).toEqual({ _yay: null });
		expect((await f.t.run((ctx) => ctx.db.get("files_subtree_ops", opId)))?.treePaths).not.toContain("/queued/a.md");
		const secondBlockerId = await blocker("/queued/a.md");
		await f.t.run((ctx) => files_subtree_ops_db_delete(ctx, { opId: firstBlockerId, now: Date.now() }));
		expect((await f.t.run((ctx) => ctx.db.get("files_subtree_ops", opId)))?.blockedByOpId).toBeNull();
		await f.t.mutation(internal.files_subtree_ops.promote, { opId });
		for (let count = 0; count < 3; count++) {
			const op = await f.t.run((ctx) => ctx.db.get("files_subtree_ops", opId));
			if (op?.status !== "running") break;
			await step(f, restored._yay!.runId);
		}

		const op = await f.t.run((ctx) => ctx.db.get("files_subtree_ops", opId));
		expect(op).toMatchObject({ status: "queued", blockedByOpId: secondBlockerId });
		expect(op?.treePaths).toContain("/queued/a.md");
		expect((await read_node(f, archived.fileIds[0]!)).archiveOperationId).not.toBeNull();
	});

	// It takes about 10 s alone and more than 30 s while the full suite runs.
	test("a big restore runs as a job, and no node is ever active inside an archived folder", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "back", folderCount: 6, filesPerFolder: 100 });
		await archive_to_end(f, tree.topId);

		const restored = await restore(f, [tree.fileIds[250]!]);
		expect(restored._nay).toBeUndefined();
		const ended = await run_to_end(f, restored._yay!);

		expect(ended.activity).toMatchObject({ status: "succeeded", title: "Restore files" });
		expect(ended.activity.progress).toMatchObject({ total: 607, completed: 607 });
		const state = await read_state(f);
		expect(state.nodes.every((node) => node.archiveOperationId === null)).toBe(true);
		expect((await read_node(f, tree.fileIds[0]!)).path).toBe("/back/d0/f000.md");
	}, 60_000);

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

	test("a folder moved during the restore takes its contents with it", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "moving", folderCount: 4, filesPerFolder: 100 });
		await archive_to_end(f, tree.topId);
		const target = await folder(f, "/target");

		const restored = await restore(f, [tree.topId]);
		const job = restored._yay!;
		for (let count = 0; count < 30 && (await read_node(f, tree.topId)).archiveOperationId !== null; count++) {
			await step(f, job.runId);
		}
		expect((await read_node(f, tree.topId)).archiveOperationId).toBeNull();
		expect(
			await f.asOwner.mutation(api.files_nodes.move_nodes, {
				membershipId: f.db.membershipId,
				itemIds: [tree.topId],
				targetParentId: target,
			}),
		).toEqual({ _yay: null });

		const ended = await run_to_end(f, job);
		expect(ended.activity.status).toBe("succeeded");
		expect((await read_node(f, tree.fileIds.at(-1)!)).path).toBe("/target/moving/d3/f099.md");
	});

	test("refuses to restore an operation that a job is still restoring", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "twice", folderCount: 4, filesPerFolder: 100 });
		await archive_to_end(f, tree.topId);

		const restored = await restore(f, [tree.topId]);
		expect(restored._yay).not.toBeNull();
		const again = await restore(f, [tree.fileIds.at(-1)!]);
		expect(again._nay?.name).toBe("busy");
	});

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

	test("restoring several big operations runs one job at a time, and a queued job has no card and no Stop", async () => {
		const f = await fixture();
		const trees = [];
		for (const name of ["q1", "q2", "q3"]) {
			const tree = await seed_tree(f, { name, folderCount: 2, filesPerFolder: 100 });
			await archive_to_end(f, tree.topId);
			trees.push(tree);
		}
		const read_restore_jobs = async () =>
			(await f.t.run((ctx) => ctx.db.query("activities").collect())).flatMap((activity) =>
				activity.source.kind === "files_archive_run" && activity.source.archiveKind === "restore"
					? [{ runId: activity.source.id, activityId: activity._id, status: activity.status }]
					: [],
			);
		const read_statuses = async () => (await read_restore_jobs()).map((job) => job.status);

		const restored = await restore(
			f,
			trees.map((tree) => tree.topId),
		);
		expect(restored._nay).toBeUndefined();
		expect(await read_statuses()).toEqual(["running", "queued", "queued"]);
		const [first, second, third] = await read_restore_jobs();
		expect((await read_activity(f, third!.activityId)).feedVisible).toBe(false);

		const stop = await f.asOwner.mutation(api.activities.request_stop, {
			membershipId: f.db.membershipId,
			activityId: third!.activityId,
		});
		expect(stop._nay).toBeDefined();
		expect(await read_statuses()).toEqual(["running", "queued", "queued"]);

		expect((await run_to_end(f, first!)).activity.status).toBe("succeeded");
		expect((await run_to_end(f, second!)).activity).toMatchObject({ status: "succeeded", feedVisible: true });
		expect((await run_to_end(f, third!)).activity.status).toBe("succeeded");

		const state = await expect_consistent(f);
		expect(state.nodes.filter((node) => node.archiveOperationId !== null)).toEqual([]);
	});

	test("the end of a job starts the next job of its own request, not of another request", async () => {
		const f = await fixture();
		const trees = [];
		for (const name of ["a1", "a2", "b1", "b2"]) {
			const tree = await seed_tree(f, { name, folderCount: 2, filesPerFolder: 100 });
			await archive_to_end(f, tree.topId);
			trees.push(tree);
		}
		const read_restore_jobs = async () =>
			(await f.t.run((ctx) => ctx.db.query("activities").collect())).flatMap((activity) =>
				activity.source.kind === "files_archive_run" && activity.source.archiveKind === "restore"
					? [{ runId: activity.source.id, activityId: activity._id, status: activity.status }]
					: [],
			);
		const read_statuses = async () => (await read_restore_jobs()).map((job) => job.status);

		expect((await restore(f, [trees[0]!.topId, trees[1]!.topId]))._nay).toBeUndefined();
		expect((await restore(f, [trees[2]!.topId, trees[3]!.topId]))._nay).toBeUndefined();
		expect(await read_statuses()).toEqual(["running", "queued", "running", "queued"]);
		const [a1, a2, b1, b2] = await read_restore_jobs();

		const read_blocker = async (runId: Id<"files_archive_runs">) =>
			(await f.t.run((ctx) =>
				ctx.db
					.query("files_subtree_ops")
					.withIndex("by_archiveRun", (q) => q.eq("archiveRunId", runId))
					.unique(),
			))!.blockedByOpId;

		// The older queued job belongs to the first request. Starting it here would run it next to the
		// first request's running job.
		expect((await run_to_end(f, b1!)).activity.status).toBe("succeeded");
		expect(await read_blocker(b2!.runId)).toBeNull();
		expect(await read_blocker(a2!.runId)).not.toBeNull();

		expect((await run_to_end(f, a1!)).activity.status).toBe("succeeded");
		expect(await read_blocker(a2!.runId)).toBeNull();
		expect((await run_to_end(f, a2!)).activity.status).toBe("succeeded");
		expect((await run_to_end(f, b2!)).activity.status).toBe("succeeded");

		const state = await expect_consistent(f);
		expect(state.nodes.filter((node) => node.archiveOperationId !== null)).toEqual([]);
	}, 60_000);

	test("a queued restore never times out, and Stop on the clash wait ends the whole request", async () => {
		const f = await fixture();
		const clash = await seed_same_path(f, { name: "ahead", count: 200, archiveOperationId: crypto.randomUUID() });
		const tree = await seed_tree(f, { name: "behind", folderCount: 2, filesPerFolder: 100 });
		await archive_to_end(f, tree.topId);

		const restored = await restore(f, [clash.fileIds[0]!, tree.topId]);
		expect(restored._nay).toBeUndefined();
		const [ahead, queued] = (await f.t.run((ctx) => ctx.db.query("activities").collect())).flatMap((activity) =>
			activity.source.kind === "files_archive_run" && activity.source.archiveKind === "restore"
				? [{ runId: activity.source.id, activityId: activity._id, status: activity.status }]
				: [],
		);
		expect(queued!.status).toBe("queued");
		expect((await run_to_end(f, ahead!)).activity.status).toBe("awaiting_input");

		// The queued job reaches its deadline while the job ahead still waits for the choice.
		const now = Date.now();
		await f.t.run((ctx) => ctx.db.patch("activities", queued!.activityId, { deadlineAt: now - 1 }));
		await f.t.mutation(internal.activities.recover_expired, { _test_now: now, _test_disableReschedule: true });
		const waiting = await read_activity(f, queued!.activityId);
		expect(waiting.status).toBe("queued");
		expect(waiting.deadlineAt).toBe(now + 24 * 60 * 60 * 1000);

		expect(
			await f.asOwner.mutation(api.activities.request_stop, {
				membershipId: f.db.membershipId,
				activityId: ahead!.activityId,
			}),
		).toEqual({ _yay: null });
		expect((await read_activity(f, ahead!.activityId)).status).toBe("canceled");
		expect((await read_activity(f, queued!.activityId)).status).toBe("canceled");
		expect(await f.t.run((ctx) => ctx.db.query("files_subtree_ops").collect())).toEqual([]);
		expect((await read_node(f, tree.topId)).archiveOperationId).not.toBeNull();
	});

	test("an item whose old folder is still archived lands at the workspace root", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "orphan", folderCount: 1, filesPerFolder: 2 });
		expect(await archive(f, [tree.folderIds[0]!])).toEqual({ _yay: null });
		expect(await archive(f, [tree.topId])).toEqual({ _yay: null });

		expect(await restore(f, [tree.fileIds[0]!])).toEqual({ _yay: null });

		expect(await read_node(f, tree.folderIds[0]!)).toMatchObject({ parentId: "root", path: "/d0" });
		expect(await read_node(f, tree.fileIds[0]!)).toMatchObject({ archiveOperationId: null, path: "/d0/f000.md" });
		expect((await read_node(f, tree.topId)).archiveOperationId).not.toBeNull();
		await expect_consistent(f);
	});

	test("restoring both operations at once puts the inner one back inside its folder", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "both", folderCount: 1, filesPerFolder: 2 });
		expect(await archive(f, [tree.folderIds[0]!])).toEqual({ _yay: null });
		expect(await archive(f, [tree.topId])).toEqual({ _yay: null });

		expect(await restore(f, [tree.fileIds[0]!, tree.topId])).toEqual({ _yay: null });

		expect(await read_node(f, tree.folderIds[0]!)).toMatchObject({ parentId: tree.topId, path: "/both/d0" });
		const state = await expect_consistent(f);
		expect(state.nodes.every((node) => node.archiveOperationId === null)).toBe(true);
	});

	test("restoring several operations starts with the top one, even when a deep item is named", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "order", folderCount: 2, filesPerFolder: 1 });
		expect(await archive(f, [tree.folderIds[0]!])).toEqual({ _yay: null });
		expect(await archive(f, [tree.topId])).toEqual({ _yay: null });

		// `/order/d0/` sorts before the named `/order/d1/f000.md`, but `/order` holds `d0`.
		expect(await restore(f, [tree.folderIds[0]!, tree.fileIds[1]!])).toEqual({ _yay: null });

		expect(await read_node(f, tree.folderIds[0]!)).toMatchObject({ parentId: tree.topId, path: "/order/d0" });
		await expect_consistent(f);
	});

	test("a folder that lands somewhere new takes the items archived on their own inside it", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "nested", folderCount: 1, filesPerFolder: 2 });
		expect(await archive(f, [tree.fileIds[0]!])).toEqual({ _yay: null });
		const fileOperationId = (await read_node(f, tree.fileIds[0]!)).archiveOperationId;
		expect(await archive(f, [tree.folderIds[0]!])).toEqual({ _yay: null });
		expect(await archive(f, [tree.topId])).toEqual({ _yay: null });

		// `/nested` stays archived, so `d0` lands at the workspace root.
		expect(await restore(f, [tree.folderIds[0]!])).toEqual({ _yay: null });

		expect(await read_node(f, tree.folderIds[0]!)).toMatchObject({ archiveOperationId: null, path: "/d0" });
		expect(await read_node(f, tree.fileIds[0]!)).toMatchObject({
			archiveOperationId: fileOperationId,
			path: "/d0/f000.md",
			treePath: "/d0/f000.md",
		});
		await expect_consistent(f);
	});

	test("a folder lands even when an item archived on its own inside has many side docs", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "heavy", folderCount: 1, filesPerFolder: 1 });
		expect(await archive(f, [tree.fileIds[0]!])).toEqual({ _yay: null });
		await add_metadata_docs({ f, fileNodeId: tree.fileIds[0]!, count: 2000 });
		expect(await archive(f, [tree.folderIds[0]!])).toEqual({ _yay: null });
		expect(await archive(f, [tree.topId])).toEqual({ _yay: null });

		const restored = await restore(f, [tree.folderIds[0]!]);
		expect(restored._nay).toBeUndefined();
		if (restored._yay) await run_to_end(f, restored._yay);

		expect((await read_node(f, tree.folderIds[0]!)).archiveOperationId).toBeNull();
		expect((await read_node(f, tree.fileIds[0]!)).path).toBe("/d0/f000.md");
		await expect_consistent(f);
	});

	test("a step that only clears empty and deleted folders from the queue stops near the limits", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "drain", folderCount: 6, filesPerFolder: 100 });
		await archive_to_end(f, tree.topId);
		const job = (await restore(f, [tree.topId]))._yay!;
		let run = (await f.t.run((ctx) => ctx.db.get("files_archive_runs", job.runId)))!;
		while (run.phase !== "apply") run = (await step(f, job.runId))!;
		const opId = await queue_empty_folders_first({ f, runId: job.runId, archiveOperationId: null });

		await expect(step(f, job.runId)).resolves.toMatchObject({ active: true });
		expect(await count_queue(f, opId)).toBeGreaterThan(0);

		expect((await run_to_end(f, job)).activity.status).toBe("succeeded");
		expect((await read_state(f)).nodes.filter((node) => node.archiveOperationId !== null)).toEqual([]);
	}, 120_000);

	test("a restore of many top items keeps a small queue, and its op holds at most 64 paths", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "tops", folderCount: 200, filesPerFolder: 1 });
		const archived = await archive(f, tree.fileIds);
		if (archived._yay) await run_to_end(f, archived._yay);
		const treePaths = tree.fileIds.map((_, index) => `/tops/d${index}/f000.md`);

		const job = (await restore(f, [tree.fileIds[0]!]))._yay!;
		for (let count = 0; count < 100; count++) {
			const { op, queued } = await f.t.run(async (ctx) => {
				const op = await ctx.db
					.query("files_subtree_ops")
					.withIndex("by_archiveRun", (q) => q.eq("archiveRunId", job.runId))
					.unique();
				const rows = (await ctx.db.query("files_subtree_op_nodes").collect()).filter((row) => row.opId === op?._id);
				return { op, queued: rows.length };
			});
			if (!op) break;
			// The op keeps a few folder paths that hold every top item, not one path per item.
			expect(op.treePaths.length).toBeLessThanOrEqual(64);
			if ((await f.t.run((ctx) => ctx.db.get("files_archive_runs", job.runId)))!.phase !== "discover") {
				const holds = (outer: string, inner: string) =>
					outer === inner || (outer.endsWith("/") && inner.startsWith(outer));
				expect(treePaths.filter((treePath) => !op.treePaths.some((busy) => holds(busy, treePath)))).toEqual([]);
			}
			expect(queued).toBeLessThanOrEqual(50);
			await step(f, job.runId);
		}

		expect((await read_activity(f, job.activityId)).status).toBe("succeeded");
		expect((await read_state(f)).nodes.filter((node) => node.archiveOperationId !== null)).toEqual([]);
	}, 120_000);

	test("a restore pull queues one page of top items", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "tops", folderCount: 200, filesPerFolder: 1 });
		const archived = await archive(f, tree.fileIds);
		if (archived._yay) await run_to_end(f, archived._yay);
		// The first top item a pull queues runs first. A clash on it pauses the step before any item lands,
		// so the queue then holds exactly what one pull queued.
		const occupants = await seed_tree(f, { name: "occupants", folderCount: 1, filesPerFolder: 1 });
		expect(
			await f.asOwner.mutation(api.files_nodes.move_nodes, {
				membershipId: f.db.membershipId,
				itemIds: [occupants.fileIds[0]!],
				targetParentId: tree.folderIds[0]!,
			}),
		).toEqual({ _yay: null });

		const job = (await restore(f, [tree.fileIds[0]!]))._yay!;
		expect((await run_to_end(f, job)).activity.status).toBe("awaiting_input");

		const { run, opId } = await f.t.run(async (ctx) => ({
			run: (await ctx.db.get("files_archive_runs", job.runId))!,
			opId: (await ctx.db
				.query("files_subtree_ops")
				.withIndex("by_archiveRun", (q) => q.eq("archiveRunId", job.runId))
				.unique())!._id,
		}));
		expect(run.conflict?.nodeId).toBe(tree.fileIds[0]);
		expect(await count_queue(f, opId)).toBe(50);
	}, 120_000);

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

	describe("read-only folders", () => {
		test("refuses when the folder it comes back into is read-only, and works after unlock", async () => {
			const f = await fixture();
			const tree = await seed_tree(f, { name: "ro-active", folderCount: 1, filesPerFolder: 2 });
			expect(await archive(f, [tree.fileIds[0]!])).toEqual({ _yay: null });
			await lock({ f, nodeId: tree.folderIds[0]!, locked: true });

			const refused = await restore(f, [tree.fileIds[0]!]);
			expect(refused._nay?.name).toBe("read_only");
			expect((await read_node(f, tree.fileIds[0]!)).archiveOperationId).not.toBeNull();

			await lock({ f, nodeId: tree.folderIds[0]!, locked: false });
			expect(await restore(f, [tree.fileIds[0]!])).toEqual({ _yay: null });
			expect((await read_node(f, tree.fileIds[0]!)).archiveOperationId).toBeNull();
		});

		test("refuses when the archived folder it leaves is read-only", async () => {
			const f = await fixture();
			const tree = await seed_tree(f, { name: "ro-archived", folderCount: 1, filesPerFolder: 2 });
			expect(await archive(f, [tree.fileIds[0]!])).toEqual({ _yay: null });
			expect(await archive(f, [tree.folderIds[0]!])).toEqual({ _yay: null });
			await lock({ f, nodeId: tree.folderIds[0]!, locked: true });

			const refused = await restore(f, [tree.fileIds[0]!]);
			expect(refused._nay?.name).toBe("read_only");
			expect((await read_node(f, tree.fileIds[0]!)).archiveOperationId).not.toBeNull();

			await lock({ f, nodeId: tree.folderIds[0]!, locked: false });
			expect(await restore(f, [tree.fileIds[0]!])).toEqual({ _yay: null });
			expect(await read_node(f, tree.fileIds[0]!)).toMatchObject({ archiveOperationId: null, path: "/f000.md" });
		});

		test("stops when a folder it restored is locked before the items inside come back", async () => {
			const f = await fixture();
			const tree = await seed_tree(f, { name: "ro-inside", folderCount: 2, filesPerFolder: 100 });
			await archive_to_end(f, tree.topId);
			const job = (await restore(f, [tree.topId]))._yay!;
			for (let count = 0; (await read_node(f, tree.folderIds[1]!)).archiveOperationId !== null; count++) {
				if (count === 20) throw new Error("The folder did not come back");
				await step(f, job.runId);
			}
			expect((await read_node(f, tree.fileIds[100]!)).archiveOperationId).not.toBeNull();

			await lock({ f, nodeId: tree.folderIds[1]!, locked: true });

			expect((await run_to_end(f, job)).activity.status).toBe("failed");
			expect((await read_node(f, tree.fileIds[100]!)).archiveOperationId).not.toBeNull();
		}, 120_000);
	});

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
				await f.asOwner.mutation(api.files_nodes.move_nodes, {
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
		 * its files. Then move new files with the names in `names` into d1. The restore waits on the first
		 * clash inside d1.
		 */
		async function seed_clash_inside(f: Fixture, names: string[]) {
			const tree = await seed_tree(f, { name: "inside", folderCount: 2, filesPerFolder: 100 });
			await archive_to_end(f, tree.topId);
			const job = (await restore(f, [tree.topId]))._yay!;
			await step_until_restored({ f, runId: job.runId, nodeId: tree.folderIds[1]! });
			expect((await read_node(f, tree.fileIds[100]!)).archiveOperationId).not.toBeNull();

			const occupants = await seed_tree(f, { name: "occupants", folderCount: 1, filesPerFolder: 100 });
			const occupantIds = names.map((name) => occupants.fileIds[Number(name.slice(1, 4))]!);
			expect(
				await f.asOwner.mutation(api.files_nodes.move_nodes, {
					membershipId: f.db.membershipId,
					itemIds: occupantIds,
					targetParentId: tree.folderIds[1]!,
				}),
			).toEqual({ _yay: null });
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
				await f.asOwner.mutation(api.files_nodes.move_nodes, {
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
			expect(
				await f.asOwner.mutation(api.files_nodes.move_nodes, {
					membershipId: f.db.membershipId,
					itemIds: occupants.fileIds,
					targetParentId: tree.folderIds[0]!,
				}),
			).toEqual({ _yay: null });
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

		test("Apply to remaining answers a later clash in the middle of a page, and each file comes back once", async () => {
			const f = await fixture();
			const { tree, job } = await seed_clash_inside(f, ["f050.md", "f080.md"]);

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
			expect(ended.activity.progress).toMatchObject({ total: 203, completed: 203, skipped: 0 });
			expect((await read_node(f, tree.fileIds[180]!)).name).toBe("f080-2.md");
			const nodes = (await read_state(f)).nodes;
			expect(nodes.filter((node) => node.path.startsWith("/inside/")).length).toBe(204);
			expect(nodes.every((node) => node.archiveOperationId === null)).toBe(true);
		});

		test("a folder clash after folders this step restored queues each folder once", async () => {
			const f = await fixture();
			const tree = await seed_tree(f, { name: "many", folderCount: 200, filesPerFolder: 0 });
			await archive_to_end(f, tree.topId);
			const job = (await restore(f, [tree.topId]))._yay!;
			// A step restores 75 folders, so `d50` comes back in a later step, in the middle of a page.
			await step_until_restored({ f, runId: job.runId, nodeId: tree.topId });
			expect((await read_node(f, tree.folderIds[50]!)).archiveOperationId).not.toBeNull();
			const occupant = await folder(f, "/many/d50");

			expect((await run_to_end(f, job)).activity.status).toBe("awaiting_input");
			const queued = await f.t.run(async (ctx) => {
				const op = await ctx.db
					.query("files_subtree_ops")
					.withIndex("by_archiveRun", (q) => q.eq("archiveRunId", job.runId))
					.unique();
				return (
					await ctx.db
						.query("files_subtree_op_nodes")
						.withIndex("by_op_sequence", (q) => q.eq("opId", op!._id))
						.collect()
				).map((row) => row.nodeId);
			});
			expect(new Set(queued).size).toBe(queued.length);

			expect(await resolve({ f, runId: job.runId, choice: "keep_both" })).toEqual({ _yay: null });
			const ended = await run_to_end(f, job);
			expect(ended.activity.status).toBe("succeeded");
			expect(ended.activity.progress).toMatchObject({ total: 201, completed: 201, skipped: 0 });
			expect((await read_node(f, tree.folderIds[50]!)).path).toBe("/many/d50-2");
			expect((await read_node(f, occupant)).path).toBe("/many/d50");
		});

		test("the step after a choice lands the item before it walks the folders its page restored", async () => {
			const f = await fixture();
			const tree = await seed_tree(f, { name: "many", folderCount: 200, filesPerFolder: 1 });
			await archive_to_end(f, tree.topId);
			const job = (await restore(f, [tree.topId]))._yay!;
			await step_until_restored({ f, runId: job.runId, nodeId: tree.topId });
			await folder(f, "/many/d50");
			expect((await run_to_end(f, job)).activity.status).toBe("awaiting_input");
			expect((await read_run(f, job.runId)).conflict?.nodeId).toBe(tree.folderIds[50]);

			// A folder the paused step restored waits in the queue with its file. Put an item with that name there.
			const queuedId = await f.t.run(async (ctx) => {
				const op = await ctx.db
					.query("files_subtree_ops")
					.withIndex("by_archiveRun", (q) => q.eq("archiveRunId", job.runId))
					.unique();
				const rows = await ctx.db
					.query("files_subtree_op_nodes")
					.withIndex("by_op_sequence", (q) => q.eq("opId", op!._id))
					.collect();
				return rows.find((row) => row.nodeId !== tree.topId)!.nodeId;
			});
			const queuedFileId = tree.fileIds[tree.folderIds.indexOf(queuedId)]!;
			expect((await read_node(f, queuedFileId)).archiveOperationId).not.toBeNull();
			const occupants = await seed_tree(f, { name: "occupants", folderCount: 1, filesPerFolder: 1 });
			expect(
				await f.asOwner.mutation(api.files_nodes.move_nodes, {
					membershipId: f.db.membershipId,
					itemIds: occupants.fileIds,
					targetParentId: queuedId,
				}),
			).toEqual({ _yay: null });

			// A choice counts only until the next clash. So `d50` must come back before that clash asks.
			expect(await resolve({ f, runId: job.runId, choice: "keep_both" })).toEqual({ _yay: null });
			expect((await run_to_end(f, job)).activity.status).toBe("awaiting_input");
			expect(await read_node(f, tree.folderIds[50]!)).toMatchObject({ archiveOperationId: null, path: "/many/d50-2" });
			expect((await read_run(f, job.runId)).conflict?.nodeId).toBe(queuedFileId);

			expect(await resolve({ f, runId: job.runId, choice: "keep_both" })).toEqual({ _yay: null });
			const ended = await run_to_end(f, job);
			expect(ended.activity.status).toBe("succeeded");
			expect(ended.activity.progress).toMatchObject({ total: 401, completed: 401, skipped: 0 });
		});

		test("archived items with one name inside a restored folder ask when the second comes back", async () => {
			const f = await fixture();
			const operationId = crypto.randomUUID();
			const same = await seed_same_path(f, { name: "same", count: 3, archiveOperationId: operationId });
			await f.t.run((ctx) => ctx.db.patch("files_nodes", same.topId, { archiveOperationId: operationId }));

			const restored = await restore(f, [same.topId]);
			await expect_consistent(f);
			const job = restored._yay!;
			expect((await read_activity(f, job.activityId)).status).toBe("awaiting_input");
			expect(
				await resolve({
					f,
					runId: job.runId,
					choice: "keep_both",
					applyToRemaining: { file: "keep_both", folder: null },
				}),
			).toEqual({ _yay: null });
			expect((await run_to_end(f, job)).activity.status).toBe("succeeded");

			const names = await Promise.all(same.fileIds.map(async (fileId) => (await read_node(f, fileId)).name));
			expect(names.toSorted()).toEqual(["same-2.md", "same-3.md", "same.md"]);
		});

		test("refuses a choice for a clash that changed", async () => {
			const f = await fixture();
			const { job } = await seed_clash(f);
			const run = await read_run(f, job.runId);

			const refused = await f.asOwner.mutation(api.files_archive_runs.resolve_conflicts, {
				membershipId: f.db.membershipId,
				runId: job.runId,
				revision: run.revision - 1,
				choice: "skip",
				applyToRemaining: { file: null, folder: null },
			});
			expect(refused._nay?.message).toBe("The conflicts changed. Review them again.");
		});

		test("Replace asks again when the folder in the way gets an archived read-only item", async () => {
			const f = await fixture();
			const tree = await seed_tree(f, { name: "hidden", folderCount: 1, filesPerFolder: 1 });
			expect(await archive(f, [tree.folderIds[0]!])).toEqual({ _yay: null });
			const occupant = await folder(f, "/hidden/d0");
			const inside = await folder(f, "/hidden/d0/kept");
			expect(await archive(f, [inside])).toEqual({ _yay: null });

			const restored = await restore(f, [tree.folderIds[0]!]);
			const job = restored._yay!;
			expect(await resolve({ f, runId: job.runId, choice: "replace" })).toEqual({ _yay: null });
			// The lock comes after the choice.
			await lock_archived(f, inside);
			await step(f, job.runId);

			// Replace would hide the read-only item inside an archived folder.
			expect((await read_activity(f, job.activityId)).status).toBe("awaiting_input");
			const shown = await f.asOwner.query(api.files_archive_runs.get, {
				membershipId: f.db.membershipId,
				runId: job.runId,
			});
			expect(shown?.conflict?.canReplace).toBe(false);
			expect((await read_node(f, occupant)).archiveOperationId).toBeNull();
			expect((await read_node(f, tree.folderIds[0]!)).archiveOperationId).not.toBeNull();
		});

		test("a node kept archived with its skipped folder must still be writable", async () => {
			const f = await fixture();
			const tree = await seed_tree(f, { name: "tag", folderCount: 1, filesPerFolder: 2 });
			expect(await archive(f, [tree.folderIds[0]!])).toEqual({ _yay: null });
			const operationId = (await read_node(f, tree.fileIds[0]!)).archiveOperationId;
			await folder(f, "/tag/d0");
			const restored = await restore(f, [tree.folderIds[0]!]);
			const job = restored._yay!;
			// The check before the pause already passed. The lock comes while the job waits.
			await lock_archived(f, tree.fileIds[0]!);

			expect(await resolve({ f, runId: job.runId, choice: "skip" })).toEqual({ _yay: null });
			await step(f, job.runId);

			expect((await read_activity(f, job.activityId)).status).toBe("failed");
			expect((await read_node(f, tree.fileIds[0]!)).archiveOperationId).toBe(operationId);
			await expect_consistent(f);
		});

		test("Replace of a folder that still has items is refused", async () => {
			const f = await fixture();
			const tree = await seed_tree(f, { name: "folders", folderCount: 1, filesPerFolder: 1 });
			expect(await archive(f, [tree.folderIds[0]!])).toEqual({ _yay: null });
			await folder(f, "/folders/d0/kept");

			const restored = await restore(f, [tree.folderIds[0]!]);
			const job = restored._yay!;
			const run = await read_run(f, job.runId);
			const shown = await f.asOwner.query(api.files_archive_runs.get, {
				membershipId: f.db.membershipId,
				runId: job.runId,
			});
			expect(shown?.conflict?.canReplace).toBe(false);
			expect((await resolve({ f, runId: job.runId, choice: "replace" }))._nay?.message).toBe(
				"Replace needs the same kind, an empty folder, and write access to the item in the way and everything inside it.",
			);

			expect((await read_activity(f, job.activityId)).status).toBe("awaiting_input");
			expect((await read_run(f, job.runId)).revision).toBe(run.revision);
		});

		test("Replace is not offered when the folder in the way holds more than 500 items", async () => {
			const f = await fixture();
			const tree = await seed_tree(f, { name: "wide", folderCount: 1, filesPerFolder: 1 });
			expect(await archive(f, [tree.topId])).toEqual({ _yay: null });
			// A new `/wide` with 501 archived items inside and no active child.
			const occupantTree = await seed_tree(f, { name: "wide", folderCount: 1, filesPerFolder: 500 });
			await archive_to_end(f, occupantTree.folderIds[0]!);

			const restored = await restore(f, [tree.topId]);
			const shown = await f.asOwner.query(api.files_archive_runs.get, {
				membershipId: f.db.membershipId,
				runId: restored._yay!.runId,
			});

			expect(shown?.conflict?.canReplace).toBe(false);
		});

		test("a refused restore keeps the item a Replace would archive", async () => {
			const f = await fixture();
			const tree = await seed_tree(f, { name: "keep", folderCount: 1, filesPerFolder: 1 });
			expect(await archive(f, [tree.folderIds[0]!])).toEqual({ _yay: null });
			const occupant = await folder(f, "/keep/d0");

			const restored = await restore(f, [tree.folderIds[0]!]);
			const job = restored._yay!;
			expect(await resolve({ f, runId: job.runId, choice: "replace" })).toEqual({ _yay: null });
			// The lock comes after the choice, so the restore of `d0` is refused when the step runs.
			await lock_archived(f, tree.folderIds[0]!);
			await step(f, job.runId);

			expect((await read_activity(f, job.activityId)).status).toBe("failed");
			expect((await read_node(f, occupant)).archiveOperationId).toBeNull();
			expect((await read_node(f, tree.folderIds[0]!)).archiveOperationId).not.toBeNull();
			await expect_consistent(f);
		});

		test("Replace of a folder that gets items after the choice asks again", async () => {
			const f = await fixture();
			const tree = await seed_tree(f, { name: "folders", folderCount: 1, filesPerFolder: 1 });
			expect(await archive(f, [tree.folderIds[0]!])).toEqual({ _yay: null });
			await folder(f, "/folders/d0");

			const restored = await restore(f, [tree.folderIds[0]!]);
			const job = restored._yay!;
			const run = await read_run(f, job.runId);
			expect(await resolve({ f, runId: job.runId, choice: "replace" })).toEqual({ _yay: null });
			await folder(f, "/folders/d0/kept");
			await step(f, job.runId);

			expect((await read_activity(f, job.activityId)).status).toBe("awaiting_input");
			expect((await read_run(f, job.runId)).revision).toBe(run.revision + 1);
			expect((await read_node(f, tree.folderIds[0]!)).archiveOperationId).not.toBeNull();
		});
	});
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
