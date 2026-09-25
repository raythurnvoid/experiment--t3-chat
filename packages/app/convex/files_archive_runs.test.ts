import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { activities_is_active } from "./activities_db.ts";
import { test_convex, test_mocks, test_mocks_fill_db_with } from "./setup.test.ts";
import { files_archive_runs_db_delete_run_batch } from "./files_archive_runs.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";

// Scheduled steps never run on their own under fake timers. Each test drives `advance` itself.
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
 * The two rules the job must keep after every step: each side doc says the same as its node, and no
 * active node sits inside an archived folder.
 */
async function expect_consistent(f: Fixture) {
	const state = await read_state(f);
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

	const activeInsideArchived = state.nodes.filter(
		(node) =>
			node.archiveOperationId === null &&
			node.parentId !== "root" &&
			nodeById.get(node.parentId)?.archiveOperationId !== null,
	);
	expect(activeInsideArchived.map((node) => node.path)).toEqual([]);

	return state;
}

async function read_activity(f: Fixture, activityId: Id<"activities">) {
	const activity = await f.t.run((ctx) => ctx.db.get("activities", activityId));
	if (activity?.source.kind !== "files_archive_run") throw new Error("Missing archive activity");
	return { ...activity, source: activity.source };
}

async function step(f: Fixture, runId: Id<"files_archive_runs">) {
	await f.t.mutation(internal.files_archive_runs.advance, { runId });
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

async function lock(f: Fixture, nodeId: Id<"files_nodes">, locked: boolean) {
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
	await lock(f, lockedFolder, true);
	const writePolicy = (await read_node(f, lockedFolder)).writePolicy;
	await f.t.run((ctx) => ctx.db.patch("files_nodes", nodeId, { writePolicy }));
}

/**
 * Copy the file's metadata doc `count` more times. With 2,000 extra docs the file has more side docs
 * than a move may write in one mutation.
 */
async function add_metadata_docs(f: Fixture, fileNodeId: Id<"files_nodes">, count: number) {
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
	});

	test("a big archive runs as a job, and after every step the side docs match and no active node is inside an archived folder", async () => {
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
	});

	test("a folder created inside during the job is archived with the rest", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "grow", folderCount: 4, filesPerFolder: 100 });

		const archived = await archive(f, [tree.topId]);
		const job = archived._yay!;
		await step(f, job.runId);
		// The walk goes from the end of the tree, so `d0` is still active here.
		expect((await read_node(f, tree.folderIds[0]!)).archiveOperationId).toBeNull();
		const created = await folder(f, "/grow/d0/new");

		const ended = await run_to_end(f, job);
		expect(ended.activity.status).toBe("succeeded");
		expect((await read_node(f, created)).archiveOperationId).toBe((await read_node(f, tree.topId)).archiveOperationId);
	});

	test("Stop keeps the archived part under one operation and Restore brings back exactly that part", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "stop", folderCount: 6, filesPerFolder: 100 });
		// Archived before the job, with its own operation. It must stay archived after the Restore.
		expect(await archive(f, [tree.fileIds[0]!])).toEqual({ _yay: null });
		const olderOperationId = (await read_node(f, tree.fileIds[0]!)).archiveOperationId;

		const archived = await archive(f, [tree.topId]);
		const job = archived._yay!;
		await step(f, job.runId);
		await step(f, job.runId);
		expect(
			await f.asOwner.mutation(api.activities.request_stop, {
				membershipId: f.db.membershipId,
				activityId: job.activityId,
			}),
		).toEqual({ _yay: null });
		await step(f, job.runId);

		const stopped = await expect_consistent(f);
		expect((await read_activity(f, job.activityId)).status).toBe("canceled");
		const jobOperationId = stopped.nodes.find(
			(node) => node.archiveOperationId !== null && node.archiveOperationId !== olderOperationId,
		)!.archiveOperationId!;
		const archivedByJob = stopped.nodes.filter((node) => node.archiveOperationId === jobOperationId);
		expect(archivedByJob.length).toBe((await read_activity(f, job.activityId)).progress!.completed);
		expect((await read_node(f, tree.topId)).archiveOperationId).toBeNull();

		const restored = await restore(f, [archivedByJob[0]!._id]);
		expect(restored._nay).toBeUndefined();
		if (restored._yay) await run_to_end(f, restored._yay);

		const after = await expect_consistent(f);
		expect(after.nodes.filter((node) => node.archiveOperationId !== null).map((node) => node._id)).toEqual([
			tree.fileIds[0],
		]);
		expect((await read_node(f, tree.fileIds[0]!)).archiveOperationId).toBe(olderOperationId);
	});

	test("a lock set during the job stops it partway, and Restore still brings back the archived part", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "lock", folderCount: 4, filesPerFolder: 100 });

		const archived = await archive(f, [tree.topId]);
		const job = archived._yay!;
		await step(f, job.runId);
		expect((await read_node(f, tree.folderIds[0]!)).archiveOperationId).toBeNull();
		await lock(f, tree.fileIds[0]!, true);

		const ended = await run_to_end(f, job);
		expect(ended.activity.status).toBe("failed");
		expect(ended.activity.errorMessage).toMatch(/^Stopped partway: /);
		expect((await read_node(f, tree.fileIds[0]!)).archiveOperationId).toBeNull();

		await lock(f, tree.fileIds[0]!, false);
		const restored = await restore(f, [tree.fileIds.at(-1)!]);
		expect(restored._nay).toBeUndefined();
		if (restored._yay) await run_to_end(f, restored._yay);
		const after = await expect_consistent(f);
		expect(after.nodes.every((node) => node.archiveOperationId === null)).toBe(true);
	});

	test("a read-only file found by the check refuses before anything is archived", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "checked", folderCount: 6, filesPerFolder: 100 });
		// The check reads 500 nodes inside the request, and this file comes after them in tree order. The
		// walk that archives from the end would reach it after all of `d5`, so without the check the job
		// would stop partway.
		await lock(f, tree.fileIds[499]!, true);

		const small = await seed_tree(f, { name: "checked-small", folderCount: 1, filesPerFolder: 2 });
		await lock(f, small.fileIds[1]!, true);
		const refused = await archive(f, [small.topId]);
		expect(refused._nay?.name).toBe("read_only");
		expect(await f.t.run((ctx) => ctx.db.query("files_archive_runs").collect())).toEqual([]);

		// The big tree is too big to check inside the request, so the job checks it in steps. The refusal
		// then ends the job without "partway", because nothing changed.
		const archived = await archive(f, [tree.topId]);
		const ended = await run_to_end(f, archived._yay!);
		expect(ended.activity.status).toBe("failed");
		expect(ended.activity.errorMessage).not.toMatch(/partway/);
		const state = await read_state(f);
		expect(state.nodes.every((node) => node.archiveOperationId === null)).toBe(true);
	});

	test("the check reads up to 500 more archived items with the path where a page ends", async () => {
		const f = await fixture();
		const fits = await seed_same_path(f, { name: "fits", count: 550, archiveOperationId: null });
		const tooMany = await seed_same_path(f, { name: "too-many", count: 551, archiveOperationId: null });

		const archived = await archive(f, [fits.topId]);
		expect(archived._nay).toBeUndefined();
		const ended = await run_to_end(f, archived._yay!);
		expect(ended.activity.status).toBe("succeeded");
		expect((await read_node(f, fits.topId)).archiveOperationId).not.toBeNull();

		const refused = await archive(f, [tooMany.topId]);
		expect(refused._nay?.message).toBe("Too many archived items share one path.");
		expect((await read_node(f, tooMany.topId)).archiveOperationId).toBeNull();
	});

	test("refuses to archive an item inside a folder that a job is archiving", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "busy", folderCount: 4, filesPerFolder: 100 });
		const other = await folder(f, "/other");

		const archived = await archive(f, [tree.topId]);
		expect(archived._yay).not.toBeNull();

		const inside = await archive(f, [tree.folderIds[0]!]);
		expect(inside._nay?.name).toBe("busy");
		expect(await archive(f, [other])).toEqual({ _yay: null });
	});
});

describe("unarchive_nodes", () => {
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

	test("a folder moved during the restore takes its contents with it", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "moving", folderCount: 4, filesPerFolder: 100 });
		await archive_to_end(f, tree.topId);
		const target = await folder(f, "/target");

		const restored = await restore(f, [tree.topId]);
		const job = restored._yay!;
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
		expect(refused._nay?.message).toBe("Too many archived items share one path.");
		expect((await read_node(f, tooMany.fileIds[0]!)).archiveOperationId).not.toBeNull();
	});

	test("restoring several big operations runs one job at a time, and the end of one starts the next", async () => {
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

		// A Stop on a queued job ends it and starts nothing, because the first job still runs.
		expect(
			await f.asOwner.mutation(api.activities.request_stop, {
				membershipId: f.db.membershipId,
				activityId: third!.activityId,
			}),
		).toEqual({ _yay: null });
		expect(await read_statuses()).toEqual(["running", "queued", "canceled"]);

		expect((await run_to_end(f, first!)).activity.status).toBe("succeeded");
		expect(await read_statuses()).toEqual(["succeeded", "running", "canceled"]);
		expect((await run_to_end(f, second!)).activity.status).toBe("succeeded");

		const state = await expect_consistent(f);
		const archivedPaths = state.nodes.filter((node) => node.archiveOperationId !== null).map((node) => node.path);
		expect(archivedPaths.length).toBe(203);
		expect(archivedPaths.every((path) => path.startsWith("/q3"))).toBe(true);
	});

	test("a queued restore gets more time while the restore ahead of it waits for a clash choice", async () => {
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

		// Let the queued job reach its deadline while the job ahead still waits for the choice.
		const now = Date.now();
		await f.t.run((ctx) => ctx.db.patch("activities", queued!.activityId, { deadlineAt: now - 1 }));
		await f.t.mutation(internal.activities.recover_expired, { _test_now: now, _test_disableReschedule: true });
		const waiting = await read_activity(f, queued!.activityId);
		expect(waiting.status).toBe("queued");
		expect(waiting.deadlineAt).toBe(now + 24 * 60 * 60 * 1000);

		// With no restore ahead of it any more, the deadline ends it.
		await f.t.run((ctx) => ctx.db.patch("activities", ahead!.activityId, { status: "canceled" }));
		await f.t.run((ctx) => ctx.db.patch("activities", queued!.activityId, { deadlineAt: now - 1 }));
		await f.t.mutation(internal.activities.recover_expired, { _test_now: now, _test_disableReschedule: true });
		expect((await read_activity(f, queued!.activityId)).status).toBe("timed_out");
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

	test("a folder is not restored when the items that would move with it have too many side docs", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "heavy", folderCount: 1, filesPerFolder: 1 });
		expect(await archive(f, [tree.fileIds[0]!])).toEqual({ _yay: null });
		await add_metadata_docs(f, tree.fileIds[0]!, 2000);
		expect(await archive(f, [tree.folderIds[0]!])).toEqual({ _yay: null });
		expect(await archive(f, [tree.topId])).toEqual({ _yay: null });

		const refused = await restore(f, [tree.folderIds[0]!]);

		expect(refused._nay?.name).toBe("move_too_large");
		expect((await read_node(f, tree.folderIds[0]!)).archiveOperationId).not.toBeNull();
		expect((await read_node(f, tree.fileIds[0]!)).path).toBe("/heavy/d0/f000.md");
		await expect_consistent(f);
	});

	describe("read-only folders", () => {
		test("refuses when the folder it comes back into is read-only, and works after unlock", async () => {
			const f = await fixture();
			const tree = await seed_tree(f, { name: "ro-active", folderCount: 1, filesPerFolder: 2 });
			expect(await archive(f, [tree.fileIds[0]!])).toEqual({ _yay: null });
			await lock(f, tree.folderIds[0]!, true);

			const refused = await restore(f, [tree.fileIds[0]!]);
			expect(refused._nay?.name).toBe("read_only");
			expect((await read_node(f, tree.fileIds[0]!)).archiveOperationId).not.toBeNull();

			await lock(f, tree.folderIds[0]!, false);
			expect(await restore(f, [tree.fileIds[0]!])).toEqual({ _yay: null });
			expect((await read_node(f, tree.fileIds[0]!)).archiveOperationId).toBeNull();
		});

		test("refuses when the archived folder it leaves is read-only", async () => {
			const f = await fixture();
			const tree = await seed_tree(f, { name: "ro-archived", folderCount: 1, filesPerFolder: 2 });
			expect(await archive(f, [tree.fileIds[0]!])).toEqual({ _yay: null });
			expect(await archive(f, [tree.folderIds[0]!])).toEqual({ _yay: null });
			await lock(f, tree.folderIds[0]!, true);

			const refused = await restore(f, [tree.fileIds[0]!]);
			expect(refused._nay?.name).toBe("read_only");
			expect((await read_node(f, tree.fileIds[0]!)).archiveOperationId).not.toBeNull();

			await lock(f, tree.folderIds[0]!, false);
			expect(await restore(f, [tree.fileIds[0]!])).toEqual({ _yay: null });
			expect(await read_node(f, tree.fileIds[0]!)).toMatchObject({ archiveOperationId: null, path: "/f000.md" });
		});
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

		async function resolve(
			f: Fixture,
			runId: Id<"files_archive_runs">,
			choice: "keep_both" | "skip" | "replace",
			applyToRemaining: { file: null | "keep_both" | "skip" | "replace"; folder: null | "keep_both" | "skip" } = {
				file: null,
				folder: null,
			},
		) {
			const run = await read_run(f, runId);
			return await f.asOwner.mutation(api.files_archive_runs.resolve_conflicts, {
				membershipId: f.db.membershipId,
				runId,
				revision: run.revision,
				choice,
				applyToRemaining,
			});
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

			expect(await resolve(f, job.runId, "keep_both")).toEqual({ _yay: null });
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

			expect(await resolve(f, job.runId, "keep_both", { file: "keep_both", folder: null })).toEqual({ _yay: null });
			const ended = await run_to_end(f, job);

			expect(ended.activity.status).toBe("succeeded");
			expect((await read_node(f, tree.fileIds[1]!)).name).toBe("f001-2.md");
		});

		test("Skip leaves the item archived", async () => {
			const f = await fixture();
			const { tree, job } = await seed_clash(f);

			expect(await resolve(f, job.runId, "skip", { file: "skip", folder: null })).toEqual({ _yay: null });
			const ended = await run_to_end(f, job);

			expect(ended.activity.status).toBe("succeeded");
			expect(ended.activity.progress).toMatchObject({ completed: 0, skipped: 2 });
			const skipped = await read_node(f, tree.fileIds[0]!);
			expect(skipped.archiveOperationId).toBe((await read_run(f, job.runId)).skipOperationId);
		});

		test("Replace archives the item in the way and never deletes it", async () => {
			const f = await fixture();
			const { tree, occupants, job } = await seed_clash(f);

			expect(await resolve(f, job.runId, "replace", { file: "replace", folder: null })).toEqual({ _yay: null });
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
			expect(await archive(f, tree.fileIds)).toEqual({ _yay: null });
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

			expect(await resolve(f, job.runId, "replace", { file: "replace", folder: null })).toEqual({ _yay: null });
			await step(f, job.runId);

			// A step may change 150 nodes. Each Replace changes two: the restored file and the one in the way.
			expect((await read_activity(f, job.activityId)).progress!.completed).toBe(75);
			const ended = await run_to_end(f, job);
			expect(ended.activity.status).toBe("succeeded");
			expect(ended.activity.progress).toMatchObject({ completed: 100 });
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
			expect(await resolve(f, job.runId, "replace")).toEqual({ _yay: null });
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

			expect(await resolve(f, job.runId, "skip")).toEqual({ _yay: null });
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
			expect((await resolve(f, job.runId, "replace"))._nay?.message).toBe(
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
			const tree = await seed_tree(f, { name: "heavy", folderCount: 1, filesPerFolder: 1 });
			expect(await archive(f, [tree.fileIds[0]!])).toEqual({ _yay: null });
			await add_metadata_docs(f, tree.fileIds[0]!, 2000);
			expect(await archive(f, [tree.folderIds[0]!])).toEqual({ _yay: null });
			expect(await archive(f, [tree.topId])).toEqual({ _yay: null });
			const occupant = await folder(f, "/d0");

			// `/heavy` stays archived, so `d0` lands at the root, where `/d0` is in the way.
			const restored = await restore(f, [tree.folderIds[0]!]);
			const job = restored._yay!;
			expect(await resolve(f, job.runId, "replace")).toEqual({ _yay: null });
			await step(f, job.runId);

			// `d0` cannot move the side docs of its archived file, so it stays archived and `/d0` stays.
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
			expect(await resolve(f, job.runId, "replace")).toEqual({ _yay: null });
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
		// The folder is archived last, so its proposal stays until the last step.
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", pendingUpdate._id))).not.toBeNull();

		const activity = (await f.t.run((ctx) => ctx.db.query("activities").first()))!;
		const ended = await run_to_end(f, { runId: run._id, activityId: activity._id });
		expect(ended.activity.status).toBe("succeeded");
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", pendingUpdate._id))).toBeNull();
		expect((await read_node(f, tree.topId)).archiveOperationId).not.toBeNull();
	});

	test("a Discard during the job stops it", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "discard", folderCount: 4, filesPerFolder: 100 });
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
			errorMessage: "Stopped partway: The delete was discarded.",
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
		expect(ended.activity).toMatchObject({ status: "failed", errorMessage: "This item is read-only." });
		expect((await read_node(f, tree.topId)).archiveOperationId).toBeNull();
	});
});

describe("files_archive_runs_db_delete_run_batch", () => {
	test("history cleanup deletes the run with its Activity", async () => {
		const f = await fixture();
		const tree = await seed_tree(f, { name: "history", folderCount: 4, filesPerFolder: 100 });
		const archived = await archive(f, [tree.topId]);
		const job = archived._yay!;

		await f.t.run((ctx) => files_archive_runs_db_delete_run_batch(ctx, { runId: job.runId }));

		expect(await f.t.run((ctx) => ctx.db.get("files_archive_runs", job.runId))).toBeNull();
		expect(await f.t.run((ctx) => ctx.db.get("activities", job.activityId))).toBeNull();
		// A step that was already scheduled writes nothing.
		await step(f, job.runId);
		await expect_consistent(f);
	});
});
