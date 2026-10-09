// Fixtures shared by the files_archive_runs test files.
import { expect } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { activities_is_active } from "./activities_db.ts";
import { test_convex, test_mocks, test_mocks_fill_db_with } from "./setup.test.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";

export async function fixture() {
	const t = test_convex({ transactionLimits: true });
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	return { t, db, asOwner };
}

export type Fixture = Awaited<ReturnType<typeof fixture>>;

/**
 * A workspace member who is not the owner. The owner passes every permission check.
 */
export async function add_member(f: Fixture) {
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
export async function seed_tree(f: Fixture, args: { name: string; folderCount: number; filesPerFolder: number }) {
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
export async function seed_same_path(
	f: Fixture,
	args: { name: string; count: number; archiveOperationId: string | null },
) {
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

export async function read_state(f: Fixture) {
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
export async function expect_consistent(f: Fixture) {
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

export async function read_activity(f: Fixture, activityId: Id<"activities">) {
	const activity = await f.t.run((ctx) => ctx.db.get("activities", activityId));
	if (activity?.source.kind !== "files_archive_run") throw new Error("Missing archive activity");
	return { ...activity, source: activity.source };
}

/**
 * Run the step the scheduler would run next. A queued op whose blocker ended starts first, like the
 * scheduled `promote`.
 */
export async function step(f: Fixture, runId: Id<"files_archive_runs">) {
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
export async function run_to_end(f: Fixture, job: { runId: Id<"files_archive_runs">; activityId: Id<"activities"> }) {
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

export async function archive(f: Fixture, nodeIds: Array<Id<"files_nodes">>) {
	return await f.asOwner.mutation(api.files_nodes.archive_nodes, { membershipId: f.db.membershipId, nodeIds });
}

export async function restore(f: Fixture, nodeIds: Array<Id<"files_nodes">>) {
	return await f.asOwner.mutation(api.files_nodes.unarchive_nodes, { membershipId: f.db.membershipId, nodeIds });
}

export async function lock(args: { f: Fixture; nodeId: Id<"files_nodes">; locked: boolean }) {
	const { f, locked, nodeId } = args;

	expect(
		await f.asOwner.mutation(api.files_nodes.set_node_write_policy, {
			membershipId: f.db.membershipId,
			nodeId,
			writePolicy: locked ? { mode: "read_only" } : null,
		}),
	).toEqual({ _yay: null });
}

export async function folder(f: Fixture, path: string) {
	const created = await f.t.mutation(internal.files_nodes.create_folder_node_by_path, {
		organizationId: f.db.organizationId,
		workspaceId: f.db.workspaceId,
		userId: f.db.userId,
		path,
	});
	if (created._nay) throw new Error(created._nay.message);
	return created._yay.nodeId;
}

export async function read_node(f: Fixture, nodeId: Id<"files_nodes">) {
	return (await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId)))!;
}

/**
 * Make an archived node read-only. The lock API works on active nodes, so copy the policy from one.
 */
export async function lock_archived(f: Fixture, nodeId: Id<"files_nodes">) {
	const lockedFolder = await folder(f, `/locked-${nodeId}`);
	await lock({ f, nodeId: lockedFolder, locked: true });
	const writePolicy = (await read_node(f, lockedFolder)).writePolicy;
	await f.t.run((ctx) => ctx.db.patch("files_nodes", nodeId, { writePolicy }));
}

/**
 * Copy the file's metadata doc `count` more times. With 2,000 extra docs the file has more side docs
 * than a move may write in one mutation.
 */
export async function add_metadata_docs(args: { f: Fixture; fileNodeId: Id<"files_nodes">; count: number }) {
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
export async function queue_empty_folders_first(args: {
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

export async function count_queue(f: Fixture, opId: Id<"files_subtree_ops">) {
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
export async function archive_to_end(f: Fixture, topId: Id<"files_nodes">) {
	const archived = await archive(f, [topId]);
	if (archived._nay || !archived._yay) throw new Error("Expected an archive job");
	const ended = await run_to_end(f, archived._yay);
	expect(ended.activity.status).toBe("succeeded");
}
